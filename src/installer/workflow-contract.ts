/**
 * Workflow Contract — single source of truth for key enforcement rules.
 *
 * Imported by:
 *   - step-ops.ts (MISS: resolveMissingKeys → findProducerForMissingKey)
 *   - tests/workflow-contract-lint.test.ts (linter)
 *   - tests/workflow-graph-simulation.test.ts (graph sim)
 *
 * History: the linter and MISS (missing-template-key blocking) previously
 * disagreed on what keys a step promises to produce, causing the "verified"
 * incident — finalize_merge consumed {{verified}}, verify's Reply-with
 * block *mentioned* VERIFIED: (so the linter was happy), but no enforcement
 * was present (so the agent sometimes omitted it and two runs died on
 * producer-retry exhaustion).  This module makes enforcement the single
 * tier that both MISS and the linter agree on.
 */

// ══════════════════════════════════════════════════════════════════════
// AUTO_CONTEXT_KEYS — keys provided at runtime by the harness/step-ops
// infrastructure and never emitted as step output.  These keys are always
// available to every step's input template.
// ══════════════════════════════════════════════════════════════════════

export const AUTO_CONTEXT_KEYS = new Set([
  "run_id",
  "task",
  "retry_feedback",
  "verify_feedback",
  "timeout_retry",
  "has_frontend_changes",
  "has_pr",
  "current_story",
  "current_story_id",
  "current_story_title",
  "completed_stories",
  "stories_remaining",
  "progress",
  "progress_file",
]);

// ══════════════════════════════════════════════════════════════════════
// HARNESS_SEEDED_CONTEXT_KEYS — keys seeded at run creation in run.ts
// (seedContext logic) plus RESERVED_CONTEXT_KEYS from step-ops.ts.
// These are the structural keys that define repo, environment, and
// harness configuration.  Every step can assume these are available.
// ══════════════════════════════════════════════════════════════════════

export const HARNESS_SEEDED_CONTEXT_KEYS = new Set([
  "task",
  "workspace_mode",
  "no_hurry_save_tokens_mode",
  "harness_type",
  "no_relaunch_upon_rugpull",
  "repo",
  "working_directory_for_harness",
  "original_branch",
  "base_branch_sha",
  "worktree_path",
  "worktree_origin_repository",
  "worktree_origin_ref",
  "worktree_origin_sha",
  "target_working_directory_for_harness",
  "run_id",
]);

// ══════════════════════════════════════════════════════════════════════
// CALLER_PROVIDED — keys supplied by the caller at run launch (not by
// any step).  These workflows receive a key at invocation time that no
// step is expected to produce.  Each entry documents why the key is
// provided externally.
// ══════════════════════════════════════════════════════════════════════

export const CALLER_PROVIDED: Record<string, string[]> = {
  // quarantine-broken-tests: the caller supplies the base branch name to
  // quarantine; the workflow has no triage/plan step that produces a
  // branch name — setup reads {{branch}} from launch context.
  "quarantine-broken-tests": ["branch"],

  // quarantine-broken-tests-merge: same as quarantine-broken-tests —
  // caller supplies branch; workflow lacks a branch-producing step.
  "quarantine-broken-tests-merge": ["branch"],

  // quarantine-broken-tests-merge-worktree: same as above.
  "quarantine-broken-tests-merge-worktree": ["branch"],

  // just-do-it: the caller supplies target_working_directory_for_harness
  // so the agent knows which repo to work in; no step produces this key.
  "just-do-it": ["target_working_directory_for_harness"],
};

// ══════════════════════════════════════════════════════════════════════
// parseExpectedKeys — extract the set of uppercase KEY names that a
// step's input template instructs it to produce in the Reply-with block.
// ══════════════════════════════════════════════════════════════════════

/**
 * Parse the `Reply with:` section of a step's input template to extract
 * the set of uppercase KEY names that the step is expected to produce in
 * its output.  Only lines matching `KEY: <value>` (uppercase identifier,
 * colon, optional value) within that section are captured; continuation /
 * multi-line values and other prose are skipped.
 *
 * Returns an array of lowercased key names.  Returns an empty array when
 * no `Reply with:` (or `Reply with :` / `Reply-with:`) section is found.
 */
export function parseExpectedKeys(inputTemplate: string): string[] {
  const keys = new Set<string>();

  // Locate the Reply-with header.  Accept the most common spelling but
  // tolerate minor whitespace/hyphen variants seen in real templates.
  const headerMatch = inputTemplate.match(/^[\t ]*Reply[- ]with\s*:\s*$/im);
  if (!headerMatch || headerMatch.index === undefined) return [];

  // Take everything after the header line (skip the newline that follows).
  const afterHeader = inputTemplate.slice(headerMatch.index + headerMatch[0].length);

  // Walk line by line; stop at a blank line (end of the block).
  // The first element after split on the trailing newline is empty — skip it.
  const lines = afterHeader.split("\n");
  let started = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // Skip leading empty lines before the first key.
    if (!started && line.trim() === "") continue;
    started = true;
    // Blank line → block ended.
    if (line.trim() === "") break;

    // Match KEY: <value> patterns (uppercase letters + underscores),
    // allowing leading whitespace (indentation from the YAML template).
    const keyMatch = line.match(/^[\t ]*([A-Z_]+):\s*(.*)$/);
    if (keyMatch) {
      keys.add(keyMatch[1].toLowerCase());
      continue;
    }
  }

  return Array.from(keys);
}

// ══════════════════════════════════════════════════════════════════════
// parseEnforcedKeys — extract keys that a step output contract ENFORCES.
// This is the enforcement tier: only keys that are pinned by a literal
// KEY: line (not STATUS:) or by a regex:^KEY: / regex:KEY: pattern count
// as "enforced".  A mere mention in the Reply-with block is NOT enforcement
// (the agent may omit it, and MISS won't re-pend the producer based on
// parseExpectedKeys alone — it needs the expects field to carry the key).
// ══════════════════════════════════════════════════════════════════════

/**
 * Parse a step's `expects` string to extract every key whose output is
 * **enforced** — meaning the step contractually guarantees it will produce
 * that key in its output.
 *
 * Enforcement tiers (strongest first):
 *   1. `regex:^KEY:<pattern>`  — caret-anchored enforcement.  The key MUST
 *      appear at start of a line in the agent's output.
 *   2. `regex:KEY:<pattern>`   — non-caret enforcement.  The key MUST appear
 *      somewhere in the agent's output (any line position).
 *   3. `KEY: <value>`          — plain promise.  A literal KEY: value line
 *      in the expects string (excludes STATUS: — that is the step-outcome
 *      marker, not a data key).
 *
 * Returns an array of lowercased key names.  Returns an empty array for
 * empty / STATUS:-only expects strings.
 */
export function parseEnforcedKeys(expects: string): string[] {
  const keys: string[] = [];
  for (const rawLine of expects.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip STATUS: lines — they are the step outcome marker, not a data key.
    if (/^STATUS:/i.test(line)) continue;

    // Tier 1: regex:^KEY:pattern — caret-enforced promise
    const enforcedMatch = line.match(/^regex:\^([A-Z_][A-Z_0-9]*):/i);
    if (enforcedMatch) {
      const key = enforcedMatch[1].toLowerCase();
      if (key !== "status") keys.push(key);
      continue;
    }

    // Tier 2: regex:KEY:pattern — non-caret promise
    const regexMatch = line.match(/^regex:([A-Z_][A-Z_0-9]*):/i);
    if (regexMatch) {
      const key = regexMatch[1].toLowerCase();
      if (key !== "status") keys.push(key);
      continue;
    }

    // Tier 3: Plain KEY: value lines
    const plainMatch = line.match(/^([A-Z_][A-Z_0-9]*):/);
    if (plainMatch && plainMatch[1] !== "STATUS") {
      keys.push(plainMatch[1].toLowerCase());
    }
  }
  return keys;
}
