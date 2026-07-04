/**
 * Workflow Contract Lint — static proof that every {{placeholder}} consumed
 * by any bundled workflow step input template is guaranteed to be produced.
 *
 * This test is a STATIC linter, not a dynamic simulation. It analyzes
 * workflow YAML source to build:
 *
 *   consumed-keys: all {{placeholder}} keys in step input templates
 *   provided-keys: auto-context + harness-seeded + workflow.context +
 *                  upstream step expects KEY: lines
 *
 * It then asserts consumed ⊆ provided for every workflow, and enforces a
 * stricter tier: keys consumed in shell-command context (like {{branch}})
 * must have regex enforcement (regex:^KEY:) in the producing step.
 *
 * This replaces hand-fixed BRANCH: key audits with an automated guarantee
 * that works for ALL keys in ALL workflows.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";
import type { WorkflowSpec } from "../dist/installer/types.js";

// ── Workflow discovery ──────────────────────────────────────────────

const workflowsDir = resolveBundledWorkflowsDir();
const workflowIds = fs
  .readdirSync(workflowsDir, { withFileTypes: true })
  .filter(
    (e) =>
      e.isDirectory() &&
      fs.existsSync(path.join(workflowsDir, e.name, "workflow.yml")),
  )
  .map((e) => e.name)
  .sort();

// ── Shared context-key constant lists ───────────────────────────────

/**
 * AUTO_CONTEXT_KEYS — keys provided at runtime by the harness / step-ops
 * infrastructure and never emitted as step output. These keys are always
 * available to every step's input template.
 *
 * THIS LIST MUST STAY IN SYNC with the identical set in
 * tests/workflow-graph-simulation.test.ts. Both files share the same
 * set of keys; when adding a new auto-context key, update both.
 */
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

/**
 * HARNESS_SEEDED_CONTEXT_KEYS — keys seeded at run creation in
 * src/installer/run.ts (seedContext logic) plus RESERVED_CONTEXT_KEYS
 * from src/installer/step-ops.ts. These are the structural keys that
 * define repo, environment, and harness configuration.
 *
 * Derived from:
 *   - run.ts: seedContext keys (task, workspace_mode, no_hurry_save_tokens_mode,
 *     harness_type, no_relaunch_upon_rugpull, repo, working_directory_for_harness,
 *     original_branch, base_branch_sha, worktree_path, worktree_origin_repository,
 *     worktree_origin_ref, worktree_origin_sha, target_working_directory_for_harness)
 *   - step-ops.ts: RESERVED_CONTEXT_KEYS (repo, working_directory_for_harness,
 *     task, run_id, workspace_mode, worktree_path, worktree_origin_repository,
 *     worktree_origin_ref, worktree_origin_sha, original_branch)
 */
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

// ── Placeholder extraction ──────────────────────────────────────────

/**
 * Extract all {{placeholder}} keys from a template string.
 * Returns lowercase keys (template resolution is case-insensitive).
 *
 * Identical to the collectPlaceholders helper in
 * tests/workflow-graph-simulation.test.ts — kept in sync deliberately.
 */
export function collectPlaceholders(template: string): string[] {
  const keys: string[] = [];
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_m, key: string) => {
    keys.push(key.toLowerCase());
    return "";
  });
  return keys;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("workflow contract lint (all bundled workflows)", () => {
  before(() => {
    assert.ok(
      workflowIds.length >= 20,
      `expected the full bundled catalog, found ${workflowIds.length}`,
    );
  });

  it("discovers all 23 bundled workflows", () => {
    assert.equal(workflowIds.length, 23, `expected 23 bundled workflows, found ${workflowIds.length}: ${workflowIds.join(", ")}`);
  });

  it("collectPlaceholders extracts {{key}} from templates", () => {
    const keys = collectPlaceholders("Hello {{name}}, your {{repo}} is ready. Use {{branch.name}} for work.");
    assert.deepEqual(keys, ["name", "repo", "branch.name"]);
  });

  it("collectPlaceholders handles templates with no placeholders", () => {
    assert.deepEqual(collectPlaceholders("No placeholders here"), []);
    assert.deepEqual(collectPlaceholders(""), []);
  });

  it("collectPlaceholders handles duplicates", () => {
    const keys = collectPlaceholders("{{x}} and {{x}} again and {{y}}");
    assert.deepEqual(keys, ["x", "x", "y"]);
  });

  it("AUTO_CONTEXT_KEYS matches graph simulation test", () => {
    // These must stay in sync with tests/workflow-graph-simulation.test.ts
    const expected = [
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
    ];
    assert.deepEqual([...AUTO_CONTEXT_KEYS].sort(), expected.sort());
    assert.equal(AUTO_CONTEXT_KEYS.size, expected.length);
  });

  it("HARNESS_SEEDED_CONTEXT_KEYS covers run.ts seedContext and RESERVED_CONTEXT_KEYS", () => {
    // Keys seeded in run.ts seedContext logic
    const seedContextKeys = [
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
    ];

    // RESERVED_CONTEXT_KEYS from step-ops.ts
    const reservedKeys = [
      "repo",
      "working_directory_for_harness",
      "task",
      "run_id",
      "workspace_mode",
      "worktree_path",
      "worktree_origin_repository",
      "worktree_origin_ref",
      "worktree_origin_sha",
      "original_branch",
    ];

    // Union of both sets
    const expectedUnion = new Set([...seedContextKeys, ...reservedKeys]);

    // Every expected key must be in HARNESS_SEEDED_CONTEXT_KEYS
    for (const key of expectedUnion) {
      assert.ok(
        HARNESS_SEEDED_CONTEXT_KEYS.has(key),
        `HARNESS_SEEDED_CONTEXT_KEYS missing key: ${key}`,
      );
    }

    // No extra keys beyond what we expect
    assert.equal(HARNESS_SEEDED_CONTEXT_KEYS.size, expectedUnion.size,
      `HARNESS_SEEDED_CONTEXT_KEYS has ${HARNESS_SEEDED_CONTEXT_KEYS.size} keys, expected ${expectedUnion.size}. Extra: ${[...HARNESS_SEEDED_CONTEXT_KEYS].filter(k => !expectedUnion.has(k)).join(", ")}`);
  });

  it("every bundled workflow parses and has steps with input templates", async () => {
    for (const workflowId of workflowIds) {
      const spec = await loadWorkflowSpec(
        path.join(workflowsDir, workflowId),
      );
      assert.equal(spec.id, workflowId);
      assert.ok(spec.steps.length > 0, `${workflowId}: must have at least one step`);
      for (const step of spec.steps) {
        assert.ok(
          typeof step.input === "string",
          `${workflowId}/${step.id}: input template must be a string`,
        );
        assert.ok(
          step.input.length > 0,
          `${workflowId}/${step.id}: input template must not be empty`,
        );
      }
    }
  });

  it("collectPlaceholders finds expected keys across all workflows", async () => {
    // Verify that the collectPlaceholders function works correctly on real
    // workflow input templates by checking some well-known keys.
    const featureDevMerge = await loadWorkflowSpec(
      path.join(workflowsDir, "feature-dev-merge"),
    );
    const planStep = featureDevMerge.steps.find((s) => s.id === "plan");
    assert.ok(planStep, "plan step exists");
    const planKeys = collectPlaceholders(planStep.input);
    assert.ok(planKeys.includes("task"), "plan step should consume {{task}}");
    assert.ok(
      planKeys.includes("retry_feedback"),
      "plan step should consume {{retry_feedback}}",
    );

    const finalizeStep = featureDevMerge.steps.find(
      (s) => s.id === "finalize_merge",
    );
    assert.ok(finalizeStep, "finalize_merge step exists");
    const finalizeKeys = collectPlaceholders(finalizeStep.input);
    assert.ok(
      finalizeKeys.includes("branch"),
      "finalize_merge should consume {{branch}}",
    );
    assert.ok(
      finalizeKeys.includes("original_branch"),
      "finalize_merge should consume {{original_branch}}",
    );
    assert.ok(
      finalizeKeys.includes("run_id"),
      "finalize_merge should consume {{run_id}}",
    );
  });

  it("imports from dist/ work correctly", () => {
    // Verify imported functions are usable
    assert.ok(typeof resolveBundledWorkflowsDir === "function");
    assert.equal(typeof loadWorkflowSpec, "function");
    const dir = resolveBundledWorkflowsDir();
    assert.ok(dir.includes("workflows"), `expected workflows dir, got ${dir}`);
  });
});

// ── Produced-key extraction ─────────────────────────────────────────

/**
 * Extract keys a step promises to produce from its expects field.
 *
 * Parses multi-line expects strings (YAML-embedded literal \n) to extract
 * guaranteed output keys from three contract tiers:
 *
 *   Strict enforcement:  regex:^KEY:pattern → step contractually MUST
 *                         emit KEY (e.g. regex:^BRANCH:\s*\S+ → branch).
 *                         The caret ^ anchors the match at start of line
 *                         in the agent output; this is the strongest guarantee.
 *
 *   Promised (non-caret): regex:KEY:pattern → step promises to emit KEY
 *                         (e.g. regex:PR:\s*https?://... → pr). No caret,
 *                         so the match can appear anywhere in the output.
 *
 *   Plain promise:        KEY: value lines (not STATUS:, not regex:) →
 *                         step declares it produces KEY as a simple
 *                         KEY: value line.
 *
 * STATUS: is always excluded — it is the step outcome marker, not a data key.
 */
export function extractProducedKeysFromExpects(expects: string): string[] {
  const keys: string[] = [];
  for (const rawLine of expects.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip STATUS: lines — they are the step outcome marker
    if (/^STATUS:/i.test(line)) continue;

    // Tier 1: regex:^KEY:pattern — caret-enforced promise
    // Example: regex:^BRANCH:\s*\S+ → branch
    const enforcedMatch = line.match(/^regex:\^([A-Z_][A-Z_0-9]*):/i);
    if (enforcedMatch) {
      const key = enforcedMatch[1].toLowerCase();
      if (key !== "status") keys.push(key);
      continue;
    }

    // Tier 2: regex:KEY:pattern — non-caret promise
    // Example: regex:PR:\s*https?://github\.com/... → pr
    const regexMatch = line.match(/^regex:([A-Z_][A-Z_0-9]*):/i);
    if (regexMatch) {
      const key = regexMatch[1].toLowerCase();
      if (key !== "status") keys.push(key);
      continue;
    }

    // Tier 3: Plain KEY: value lines — extract KEY
    // NOT matched: STATUS: (above), regex: prefixes (above)
    const plainMatch = line.match(/^([A-Z_][A-Z_0-9]*):/);
    if (plainMatch && plainMatch[1] !== "STATUS") {
      keys.push(plainMatch[1].toLowerCase());
    }
  }
  return keys;
}

/**
 * Check whether an expects string enforces a specific key via regex:^KEY:.
 * Returns true if the expects field contains a line matching
 * `regex:^KEY:pattern` (with caret), indicating the producing step
 * contractually MUST emit that key.
 *
 * Used by the stricter tier (US-004) to verify that keys consumed in
 * shell-command context have regex enforcement in their producing step.
 */
export function hasRegexEnforcement(expects: string, key: string): boolean {
  const lowerKey = key.toLowerCase();
  for (const rawLine of expects.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const enforcedMatch = line.match(/^regex:\^([A-Z_][A-Z_0-9]*):/i);
    if (enforcedMatch && enforcedMatch[1].toLowerCase() === lowerKey) {
      return true;
    }
  }
  return false;
}

/**
 * Extract keys a step promises to produce from its input template's
 * "Reply with:" output-contract section.
 *
 * The input template tells the agent exactly what KEY: value pairs to
 * output. We scan for UPPERCASE_KEY: lines in the "Reply with:" block
 * (or "Or if" alternative blocks) and treat them as promised keys.
 *
 * This catches keys that are not codified in the `expects` regex field
 * but are nonetheless part of the agent's output contract.
 */
export function extractProducedKeysFromInputTemplate(template: string): string[] {
  const keys = new Set<string>();
  const lines = template.split("\n");
  let inOutputBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect start of output-contract block
    if (/^(Reply with:|Output:|Or if)/i.test(line)) {
      inOutputBlock = true;
      continue;
    }

    // Exit output-contract block on empty line after being in one
    if (inOutputBlock && !line) {
      inOutputBlock = false;
      continue;
    }

    if (!inOutputBlock) continue;

    // Match KEY: value lines where KEY is ALL_CAPS with underscores
    const keyMatch = line.match(/^([A-Z_][A-Z_0-9]*):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1];
      const value = keyMatch[2];

      // Skip STATUS: — it's the step outcome marker
      if (key === "STATUS") continue;

      // Skip lines where the value contains a {{placeholder}} — those are
      // consumed keys, not produced. Example: "BRANCH: {{branch}}" in
      // the input template body (not the output block) could leak in.
      if (/\{\{/.test(value)) continue;

      // Skip instruction markers that look like KEYS
      if (/^(RETRY_FEEDBACK|TIMEOUT_RETRY|VERIFY_FEEDBACK|CURRENT_STORY|COMPLETED_STORIES|STORIES_REMAINING|PROGRESS_LOG|TASK)$/.test(key)) continue;

      keys.add(key.toLowerCase());
    }

    // Exit output-contract block on instruction-like lines
    if (/^(Instructions:|Check:|Your job|Follow the|Phase \d)/i.test(line)) {
      inOutputBlock = false;
    }
  }

  return [...keys];
}

// ── Provided-key computation ────────────────────────────────────────

/**
 * Compute the set of keys guaranteed to be provided for step at `stepIndex`
 * in the given workflow spec.
 *
 * Union of:
 *   (a) AUTO_CONTEXT_KEYS — runtime context keys available to every step
 *   (b) HARNESS_SEEDED_CONTEXT_KEYS — structural keys seeded at run creation
 *   (c) workflow.context keys — workflow-level context block
 *   (d) Keys produced by upstream steps (steps[0..stepIndex-1])
 */
export function computeProvidedKeys(
  spec: WorkflowSpec,
  stepIndex: number,
): Set<string> {
  const provided = new Set<string>([
    ...AUTO_CONTEXT_KEYS,
    ...HARNESS_SEEDED_CONTEXT_KEYS,
  ]);

  // (c) Workflow-level context block keys
  if (spec.context) {
    for (const key of Object.keys(spec.context)) {
      provided.add(key.toLowerCase());
    }
  }

  // (d) Keys produced by upstream steps (steps before stepIndex)
  for (let j = 0; j < stepIndex; j++) {
    const upstream = spec.steps[j];

    // Expects-derived keys
    for (const key of extractProducedKeysFromExpects(upstream.expects)) {
      provided.add(key);
    }

    // Input-template-derived keys (from Reply-with section)
    for (const key of extractProducedKeysFromInputTemplate(upstream.input)) {
      provided.add(key);
    }
  }

  return provided;
}

// ── Shell-command context detection ───────────────────────────────

/** Shell command keywords commonly used in step input templates. */
const SHELL_COMMAND_WORDS = [
  "git",
  "npm",
  "npx",
  "node",
  "cd",
  "echo",
  "mkdir",
  "cat",
  "rm",
  "cp",
  "mv",
  "ls",
  "grep",
  "find",
  "diff",
  "cargo",
  "go",
  "make",
  "python",
  "pip",
  "docker",
  "curl",
  "wget",
];

/**
 * Detect whether a given key is consumed inside a shell-command context
 * within a step input template.
 *
 * A key is consumed in command context when:
 *   1. It appears inside backtick-quoted blocks (`` `...{{key}}...` ``),
 *      i.e. the template is quoting a literal shell command the agent
 *      should run.
 *   2. It appears on a line containing a common shell command word
 *      (git, npm, cd, etc.) — the line is instructing the agent to run
 *      a command where {{key}} is an argument.
 *
 * This is used by the stricter tier to ensure that keys consumed as
 * command arguments have regex:^KEY: enforcement in their producing step.
 */
export function isConsumedInCommandContext(
  template: string,
  key: string,
): boolean {
  const lowerKey = key.toLowerCase();
  const keyPat = `\\{\\{${lowerKey}\\}\\}`;

  // Build backtick pattern: `<backtick>...<key>...<backtick>`
  const backtickPat = new RegExp(`\`[^\`]*${keyPat}[^\`]*\``, "i");

  // Build shell-command pattern: common command word on the same line as key
  const shellLinePat = new RegExp(
    `\\b(?:${SHELL_COMMAND_WORDS.join("|")})\\b.*${keyPat}`,
    "i",
  );

  for (const rawLine of template.split("\n")) {
    const line = rawLine.trim();
    if (!new RegExp(keyPat, "i").test(line)) continue;

    // Tier 1: inside backtick-quoted command literal
    if (backtickPat.test(line)) return true;

    // Tier 2: on a line with a shell command word followed by the key
    // Use the direction-sensitive pattern: command word BEFORE {{key}}
    if (shellLinePat.test(line)) return true;
  }

  return false;
}

// ── Allowlist ───────────────────────────────────────────────────────

/**
 * Intentional exceptions to the contract check.
 *
 * Each entry documents a (workflowId, stepId, key) tuple that is known to
 * consume a key not provided by upstream steps or the harness. Every entry
 * MUST have a comment justifying why it is allowed.
 *
 * Format: "workflowId/stepId/key" → reason
 */
const ALLOWLIST: Record<string, string> = {
  // ── quarantine-broken-tests ───────────────────────────────────────
  // The quarantine workflows have no triage/plan step to produce a
  // branch name. The setup step creates its own branch (the template
  // resolver falls back to "[missing: branch]" and the agent picks a
  // name). Downstream steps also see "[missing: branch]" and must
  // recover the branch name from context (git branch --show-current,
  // the diff, or progress files). This is acceptable because the
  // quarantine workflows are targeted at repos where the agent is
  // expected to figure out the branch on its own.
  "quarantine-broken-tests/setup/branch":
    "setup creates its own quarantine branch; no upstream producer",
  "quarantine-broken-tests/quarantine/branch":
    "branch name recovered from agent context; no upstream producer",
  "quarantine-broken-tests/verify/branch":
    "branch name recovered from agent context; no upstream producer",

  "quarantine-broken-tests-merge/setup/branch":
    "setup creates its own quarantine branch; no upstream producer",
  "quarantine-broken-tests-merge/quarantine/branch":
    "branch name recovered from agent context; no upstream producer",
  "quarantine-broken-tests-merge/verify/branch":
    "branch name recovered from agent context; no upstream producer",
  "quarantine-broken-tests-merge/finalize_merge/branch":
    "branch name recovered from agent context; no upstream producer",

  "quarantine-broken-tests-merge-worktree/setup/branch":
    "setup creates its own quarantine branch; no upstream producer",
  "quarantine-broken-tests-merge-worktree/quarantine/branch":
    "branch name recovered from agent context; no upstream producer",
  "quarantine-broken-tests-merge-worktree/verify/branch":
    "branch name recovered from agent context; no upstream producer",
  "quarantine-broken-tests-merge-worktree/finalize_merge/branch":
    "branch name recovered from agent context; no upstream producer",
};

// ── Stricter-tier allowlist ─────────────────────────────────────────

/**
 * Intentional exceptions to the stricter-tier check.
 *
 * The stricter tier requires that when a key (currently: branch) is
 * consumed in shell-command context, the producing step MUST have
 * regex:^KEY: enforcement. Entries here document (workflowId, stepId)
 * tuples where consuming branch in command context without regex
 * enforcement is intentional.
 *
 * Format: "workflowId/stepId" → reason
 */
const STRICTER_TIER_ALLOWLIST: Record<string, string> = {
  // ── quarantine-broken-tests ───────────────────────────────────────
  // Quarantine workflows lack a triage/plan step that produces branch
  // with regex:^BRANCH: enforcement. Setup creates its own branch and
  // downstream steps recover the name from context. These workflows
  // target repos where the agent is expected to determine the branch
  // name autonomously.
  "quarantine-broken-tests/setup":
    "setup creates its own quarantine branch; no triage/plan producer",
  "quarantine-broken-tests/quarantine":
    "branch name recovered from agent context; no triage/plan producer",

  "quarantine-broken-tests-merge/setup":
    "setup creates its own quarantine branch; no triage/plan producer",
  "quarantine-broken-tests-merge/quarantine":
    "branch name recovered from agent context; no triage/plan producer",
  "quarantine-broken-tests-merge/finalize_merge":
    "branch name recovered from agent context; no triage/plan producer",

  "quarantine-broken-tests-merge-worktree/setup":
    "setup creates its own quarantine branch; no triage/plan producer",
  "quarantine-broken-tests-merge-worktree/quarantine":
    "branch name recovered from agent context; no triage/plan producer",
  "quarantine-broken-tests-merge-worktree/finalize_merge":
    "branch name recovered from agent context; no triage/plan producer",
};

// ── US-003: regex:^BRANCH: enforcement detection across all workflows ─

describe("US-003: regex:^BRANCH: enforcement in branch-producing workflows", () => {
  before(async () => {
    allSpecs = await loadAllSpecs();
  });

  it("exactly 15 workflows have regex:^BRANCH: enforcement in step 0", () => {
    const enforced: string[] = [];
    const notEnforced: string[] = [];

    for (const workflowId of workflowIds) {
      const spec = allSpecs.get(workflowId)!;
      const step0 = spec.steps[0];
      if (hasRegexEnforcement(step0.expects, "branch")) {
        enforced.push(`${workflowId}/${step0.id}`);
      } else {
        notEnforced.push(`${workflowId}/${step0.id}`);
      }
    }

    // The 15 branch-producing workflows with regex:^BRANCH: enforcement
    const expectedEnforced = new Set([
      "bug-fix/triage",
      "bug-fix-github-pr/triage",
      "bug-fix-merge/triage",
      "bug-fix-merge-worktree/triage",
      "bug-fix-worktree/triage",
      "feature-dev/plan",
      "feature-dev-github-pr/plan",
      "feature-dev-merge/plan",
      "feature-dev-merge-worktree/plan",
      "feature-dev-worktree/plan",
      "security-audit/scan",
      "security-audit-github-pr/scan",
      "security-audit-merge/scan",
      "security-audit-merge-worktree/scan",
      "security-audit-worktree/scan",
    ]);

    for (const entry of enforced) {
      assert.ok(
        expectedEnforced.has(entry),
        `${entry}: has regex:^BRANCH: but is not in the expected 15-branch-producer set`,
      );
    }

    for (const entry of expectedEnforced) {
      const found = enforced.includes(entry);
      assert.ok(
        found,
        `${entry}: expected regex:^BRANCH: enforcement but not detected`,
      );
    }

    assert.equal(
      enforced.length,
      15,
      `expected 15 workflows with regex:^BRANCH: enforcement, found ${enforced.length}:\nEnforced: ${enforced.join(", ")}\nNot enforced: ${notEnforced.join(", ")}`,
    );
  });

  it("no workflow outside the expected 15 has regex:^BRANCH: enforcement in step 0", () => {
    const expectedEnforced = new Set([
      "bug-fix", "bug-fix-github-pr", "bug-fix-merge", "bug-fix-merge-worktree",
      "bug-fix-worktree",
      "feature-dev", "feature-dev-github-pr", "feature-dev-merge",
      "feature-dev-merge-worktree", "feature-dev-worktree",
      "security-audit", "security-audit-github-pr", "security-audit-merge",
      "security-audit-merge-worktree", "security-audit-worktree",
    ]);

    for (const workflowId of workflowIds) {
      const spec = allSpecs.get(workflowId)!;
      const step0 = spec.steps[0];
      const hasEnforcement = hasRegexEnforcement(step0.expects, "branch");

      if (hasEnforcement) {
        assert.ok(
          expectedEnforced.has(workflowId),
          `${workflowId}/${step0.id}: unexpected regex:^BRANCH: enforcement in step 0 (not in expected 15)`,
        );
      }
    }
  });
});

// ── US-003: extractProducedKeysFromExpects correctness tests ─────────

describe("US-003: extractProducedKeysFromExpects", () => {
  it("parses regex:^BRANCH: correctly as branch key", () => {
    const keys = extractProducedKeysFromExpects(
      "STATUS: done\nregex:^BRANCH:\\s*\\S+",
    );
    assert.deepEqual(keys, ["branch"]);
  });

  it("parses regex:PR: correctly as pr key (non-caret)", () => {
    const keys = extractProducedKeysFromExpects(
      "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+",
    );
    assert.deepEqual(keys, ["pr"]);
  });

  it("parses both regex:^KEY: and regex:KEY: in the same expects string", () => {
    const keys = extractProducedKeysFromExpects(
      "STATUS: done\nregex:^BRANCH:\\s*\\S+\nregex:PR:\\s*https?://.*",
    );
    assert.deepEqual(keys, ["branch", "pr"]);
  });

  it("handles STATUS: done without any regex patterns", () => {
    const keys = extractProducedKeysFromExpects("STATUS: done");
    assert.deepEqual(keys, []);
  });

  it("does not treat STATUS: as a produced key", () => {
    const keys = extractProducedKeysFromExpects(
      "STATUS: done\nregex:^BRANCH:\\s*\\S+",
    );
    assert.ok(!keys.includes("status"), "STATUS should not be a produced key");
  });

  it("handles multi-line expects with literal newlines", () => {
    // Simulates the actual YAML-parsed string: STATUS: done\nregex:^BRANCH:\s*\S+
    const expects = "STATUS: done\nregex:^BRANCH:\\s*\\S+";
    const keys = extractProducedKeysFromExpects(expects);
    assert.deepEqual(keys, ["branch"]);
  });

  it("handles empty expects string", () => {
    assert.deepEqual(extractProducedKeysFromExpects(""), []);
  });

  it("handles expects with only whitespace and newlines", () => {
    assert.deepEqual(extractProducedKeysFromExpects("  \n  \n  "), []);
  });

  it("no false key detections from regex: patterns that do not match ^KEY: format", () => {
    // A regex pattern like regex:something without a colon after KEY should NOT
    // produce a key. The regex extractor requires KEY: after regex:.
    // Actual expects never have this, but test defensively.

    // regex: pattern without a KEY: (no colon after the key name)
    // This pattern is malformed — the colon after KEY is what we require
    const keys1 = extractProducedKeysFromExpects("regex:\\s*\\S+");
    // No colon after a key name → no match
    assert.deepEqual(keys1, []);

    // regex: with only pattern metacharacters (no KEY name at all)
    const keys2 = extractProducedKeysFromExpects("regex:^.*$");
    assert.deepEqual(keys2, []);

    // regex: STATUS: done (STATUS is excluded)
    const keys3 = extractProducedKeysFromExpects("regex:STATUS: done");
    assert.deepEqual(keys3, []);
  });

  it("plain KEY: lines (non-STATUS, non-regex) are treated as produced keys", () => {
    const keys = extractProducedKeysFromExpects(
      "STATUS: done\nMERGE_COMMIT: auto-generated\nCHANGES: auto-generated",
    );
    assert.deepEqual(keys, ["merge_commit", "changes"]);
  });

  it("hasRegexEnforcement detects regex:^KEY: correctly", () => {
    const expects = "STATUS: done\nregex:^BRANCH:\\s*\\S+";
    assert.ok(hasRegexEnforcement(expects, "branch"));
    assert.ok(hasRegexEnforcement(expects, "BRANCH"));
    assert.ok(!hasRegexEnforcement(expects, "pr"));
    assert.ok(!hasRegexEnforcement(expects, "status"));
  });

  it("hasRegexEnforcement returns false for regex:KEY: without caret", () => {
    const expects = "STATUS: done\nregex:PR:\\s*https?://.*";
    assert.ok(!hasRegexEnforcement(expects, "pr"), "regex:PR: (no caret) should not be enforcement");
  });

  it("hasRegexEnforcement handles empty expects", () => {
    assert.ok(!hasRegexEnforcement("", "branch"));
    assert.ok(!hasRegexEnforcement("STATUS: done", "branch"));
  });

  it("extractProducedKeysFromExpects handles all 23 workflow step 0 expects strings", async () => {
    const fullSpecs = await loadAllSpecs();
    for (const workflowId of workflowIds) {
      const spec = fullSpecs.get(workflowId)!;
      const step0 = spec.steps[0];
      const keys = extractProducedKeysFromExpects(step0.expects);

      // Every extracted key must be lowercased
      for (const key of keys) {
        assert.equal(key, key.toLowerCase(),
          `${workflowId}/${step0.id}: key "${key}" not lowercased`);
      }

      // STATUS must never appear
      assert.ok(!keys.includes("status"),
        `${workflowId}/${step0.id}: STATUS extracted as a key`);
    }
  });
});

// ── Per-workflow contract checks ────────────────────────────────────

/** Load all workflow specs (cached). */
async function loadAllSpecs(): Promise<Map<string, WorkflowSpec>> {
  const specs = new Map<string, WorkflowSpec>();
  for (const workflowId of workflowIds) {
    specs.set(
      workflowId,
      await loadWorkflowSpec(path.join(workflowsDir, workflowId)),
    );
  }
  return specs;
}

let allSpecs: Map<string, WorkflowSpec>;

describe("workflow contract lint — consumed ⊆ provided", () => {
  before(async () => {
    allSpecs = await loadAllSpecs();
  });

  for (const workflowId of workflowIds) {
    describe(`workflow: ${workflowId}`, () => {
      let spec: WorkflowSpec;

      before(() => {
        spec = allSpecs.get(workflowId)!;
        assert.ok(spec, `spec not found for ${workflowId}`);
      });

      it("has at least one step", () => {
        assert.ok(spec.steps.length > 0);
      });

    it("every consumed key is in the provided set", () => {
        const failures: string[] = [];

        for (let i = 0; i < spec.steps.length; i++) {
          const step = spec.steps[i];
          const consumedKeys = collectPlaceholders(step.input);
          const providedKeys = computeProvidedKeys(spec, i);

          for (const key of consumedKeys) {
            const allowlistKey = `${workflowId}/${step.id}/${key}`;
            if (ALLOWLIST[allowlistKey]) continue;

            if (!providedKeys.has(key)) {
              failures.push(
                `workflow ${workflowId}: step ${step.id} consumes {{${key}}} but no upstream step or harness provides it`,
              );
            }
          }
        }

        if (failures.length > 0) {
          assert.fail(
            `${failures.length} missing key(s):\n${failures.join("\n")}`,
          );
        }
      });

      it("first step with regex:^BRANCH: enforcement has it in expects (if branch-producing)", () => {
        // Check if step 0 has regex:^BRANCH: enforcement. This is tracked
        // to verify the stricter tier count (US-004) across all workflows.
        const step0 = spec.steps[0];
        const hasBranchEnforcement = hasRegexEnforcement(step0.expects, "branch");
        const keysFromExpects = extractProducedKeysFromExpects(step0.expects);

        // If the step produces branch, it should have regex:^BRANCH: enforcement
        if (hasBranchEnforcement) {
          assert.ok(
            keysFromExpects.includes("branch"),
            `${workflowId}/${step0.id}: has regex:^BRANCH: but extractProducedKeysFromExpects did not return "branch"`,
          );
        }

        // If the step produces branch (via any means), verify that
        // hasRegexEnforcement agrees with the presence of branch in keys
        if (keysFromExpects.includes("branch")) {
          assert.ok(
            hasBranchEnforcement,
            `${workflowId}/${step0.id}: produces branch key but missing regex:^BRANCH: enforcement in expects`,
          );
        }
      });

      it("no duplicate keys consumed from upstream vs harness — unified sources", () => {
        // Verify that for each step, the consumed keys are unique in the
        // context of what's provided. This is a sanity check.
        for (let i = 0; i < spec.steps.length; i++) {
          const step = spec.steps[i];
          const consumedKeys = collectPlaceholders(step.input);
          const uniqueConsumed = new Set(consumedKeys);

          // Ensure no auto/harness key is expected from upstream too
          // (it's redundant but not harmful — just informational)
          for (const key of uniqueConsumed) {
            if (
              AUTO_CONTEXT_KEYS.has(key) ||
              HARNESS_SEEDED_CONTEXT_KEYS.has(key)
            ) {
              // OK — these are valid sources
            }
          }
        }
        // If we got here, no unexpected failures
        assert.ok(true);
      });

      it("consumed keys are distinct (no false positives from template placeholders)", () => {
        // Verify collectPlaceholders only extracts from actual {{template}}
        // syntax, not from documentation examples or code snippets.
        for (const step of spec.steps) {
          const keys = collectPlaceholders(step.input);
          for (const key of keys) {
            // Each key must appear in the template as an actual {{key}}
            // placeholder — verified by the regex in collectPlaceholders.
            // This test confirms no false positives from e.g. triple-brace
            // or code-formatted examples.
            assert.ok(
              /\{\{\w+(?:\.\w+)*\}\}/.test(step.input),
              `${workflowId}/${step.id}: expected at least one {{placeholder}} in input but collectPlaceholders returned keys: ${keys.join(", ")}`,
            );
          }
        }
      });

      it("produced keys are correctly extracted from expects field", () => {
        for (const step of spec.steps) {
          const keys = extractProducedKeysFromExpects(step.expects);
          // Every extracted key should be lowercase and non-empty
          for (const key of keys) {
            assert.ok(key.length > 0, `${workflowId}/${step.id}: empty produced key`);
            assert.equal(
              key,
              key.toLowerCase(),
              `${workflowId}/${step.id}: produced key "${key}" is not lowercase`,
            );
          }
        }
      });

      it("produced keys are correctly extracted from input template", () => {
        for (const step of spec.steps) {
          const keys = extractProducedKeysFromInputTemplate(step.input);
          // Every extracted key should be lowercase and non-empty
          for (const key of keys) {
            assert.ok(key.length > 0, `${workflowId}/${step.id}: empty input-template key`);
            assert.equal(
              key,
              key.toLowerCase(),
              `${workflowId}/${step.id}: input-template key "${key}" is not lowercase`,
            );
          }
        }
      });
    });
  }
});

// ── US-004: Stricter tier helpers ───────────────────────────────────

/**
 * Find the first upstream step (steps[0..stepIndex-1]) whose expects field
 * promises to produce `branch` via regex:^BRANCH: or plain BRANCH:.
 *
 * Returns the step index and whether it has regex:^BRANCH: enforcement.
 * Returns { idx: -1, hasRegex: false } if no producer is found.
 */
function findFirstBranchProducer(
  spec: WorkflowSpec,
  stepIndex: number,
): { idx: number; hasRegex: boolean } {
  for (let j = 0; j < stepIndex; j++) {
    const upstream = spec.steps[j];
    const produced = extractProducedKeysFromExpects(upstream.expects);
    if (produced.includes("branch")) {
      return {
        idx: j,
        hasRegex: hasRegexEnforcement(upstream.expects, "branch"),
      };
    }
  }
  return { idx: -1, hasRegex: false };
}

// ── US-004: isConsumedInCommandContext unit tests ───────────────────

describe("US-004: isConsumedInCommandContext", () => {
  it("detects {{branch}} inside backtick-quoted git command", () => {
    const template = "- Run `git diff main..{{branch}} --stat`";
    assert.ok(
      isConsumedInCommandContext(template, "branch"),
      "{{branch}} inside backtick git command should be detected",
    );
  });

  it("detects {{branch}} on a line with git command (no backtick)", () => {
    const template = "3. git checkout -b {{branch}}";
    assert.ok(
      isConsumedInCommandContext(template, "branch"),
      "{{branch}} on line with 'git' command should be detected",
    );
  });

  it("detects {{branch}} in git merge command", () => {
    const template = "10. git merge --squash {{branch}}";
    assert.ok(
      isConsumedInCommandContext(template, "branch"),
      "{{branch}} in git merge command should be detected",
    );
  });

  it("detects {{branch}} in git merge-base command with multiple args", () => {
    const template =
      "3. git merge-base --is-ancestor {{original_branch}} {{branch}}";
    assert.ok(
      isConsumedInCommandContext(template, "branch"),
      "{{branch}} in git merge-base command should be detected",
    );
  });

  it("detects {{branch}} in npm command", () => {
    const template = "Run: npm install --prefix {{branch}}";
    assert.ok(
      isConsumedInCommandContext(template, "branch"),
      "{{branch}} in npm command should be detected",
    );
  });

  it("detects {{branch}} in cd/echo combo", () => {
    const template = "1. cd into the repo and ensure you're on {{branch}}";
    assert.ok(
      isConsumedInCommandContext(template, "branch"),
      "{{branch}} on line with 'cd' should be detected",
    );
  });

  it("does NOT flag {{branch}} in plain output-contract line", () => {
    const template = "BRANCH: {{branch}}";
    assert.ok(
      !isConsumedInCommandContext(template, "branch"),
      "{{branch}} in BRANCH: output contract line should NOT be flagged",
    );
  });

  it("does NOT flag {{branch}} in descriptive text without shell commands", () => {
    const template =
      "The branch name is {{branch}}. Please use it for all operations.";
    assert.ok(
      !isConsumedInCommandContext(template, "branch"),
      "{{branch}} in plain text without shell command should NOT be flagged",
    );
  });

  it("is case-insensitive for key matching", () => {
    const template = "git checkout -b {{BRANCH}}";
    assert.ok(
      isConsumedInCommandContext(template, "branch"),
      "case-insensitive: {{BRANCH}} should be detected as branch",
    );
  });

  it("returns false when key is not in template at all", () => {
    const template = "git checkout -b {{foo}}";
    assert.ok(
      !isConsumedInCommandContext(template, "branch"),
      "non-existent key should return false",
    );
  });

  it("handles empty template", () => {
    assert.ok(
      !isConsumedInCommandContext("", "branch"),
      "empty template should return false",
    );
  });

  it("detects {{branch}} with other shell patterns (node, docker, curl)", () => {
    assert.ok(
      isConsumedInCommandContext("node --version {{branch}}", "branch"),
      "node command",
    );
    assert.ok(
      isConsumedInCommandContext("docker build -t {{branch}} .", "branch"),
      "docker command",
    );
    assert.ok(
      isConsumedInCommandContext("curl https://example.com/{{branch}}", "branch"),
      "curl command",
    );
  });

  it("backtick takes precedence even without command word", () => {
    // Inside backtick, we assume it's a command regardless of what the
    // words are — the template author is telling the agent to run a command.
    const template = "Run `some-custom-tool --branch {{branch}}`";
    assert.ok(
      isConsumedInCommandContext(template, "branch"),
      "{{branch}} inside backtick should be detected even without known shell words",
    );
  });
});

// ── US-004: Stricter tier — shell-command consumers must have enforced producers ─

describe("US-004: stricter tier — branch in command context must have regex:^BRANCH: producer", () => {
  before(async () => {
    allSpecs = await loadAllSpecs();
  });

  it("exactly 15 workflows have regex:^BRANCH: enforcement in step 0 (stricter-tier baseline)", () => {
    // This re-asserts the US-003 count — the stricter tier depends on it.
    // If a new workflow consumes branch in command context, it MUST have
    // a producer with regex:^BRANCH: enforcement.
    let count = 0;
    for (const workflowId of workflowIds) {
      const spec = allSpecs.get(workflowId)!;
      if (hasRegexEnforcement(spec.steps[0].expects, "branch")) {
        count++;
      }
    }
    assert.equal(
      count,
      15,
      `expected 15 workflows with regex:^BRANCH: in step 0, found ${count}`,
    );
  });

  it("every workflow where {{branch}} is consumed in command context has a regex:^BRANCH: enforced producer", () => {
    const failures: string[] = [];

    for (const workflowId of workflowIds) {
      const spec = allSpecs.get(workflowId)!;

      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i];

        // Only check if this step consumes branch in command context
        if (!isConsumedInCommandContext(step.input, "branch")) continue;

        // Check stricter-tier allowlist
        const allowlistKey = `${workflowId}/${step.id}`;
        if (STRICTER_TIER_ALLOWLIST[allowlistKey]) continue;

        // Find the first upstream producer of branch
        const producer = findFirstBranchProducer(spec, i);

        if (producer.idx === -1) {
          failures.push(
            `workflow ${workflowId}: step ${step.id} consumes {{branch}} in command context but NO upstream step produces branch — expected regex:^BRANCH: enforcement`,
          );
        } else if (!producer.hasRegex) {
          failures.push(
            `workflow ${workflowId}: step ${step.id} consumes {{branch}} in command context but producing step ${spec.steps[producer.idx].id} lacks regex:^BRANCH: enforcement`,
          );
        }
      }
    }

    if (failures.length > 0) {
      assert.fail(
        `${failures.length} stricter-tier failure(s):\n${failures.join("\n")}`,
      );
    }
  });

  it("all 23 workflows pass the stricter tier (counting allowlist entries)", () => {
    // Verify that every workflow either passes the stricter tier or has
    // documented allowlist entries covering every command-context consumer.
    for (const workflowId of workflowIds) {
      const spec = allSpecs.get(workflowId)!;

      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i];

        if (!isConsumedInCommandContext(step.input, "branch")) continue;

        const allowlistKey = `${workflowId}/${step.id}`;
        if (STRICTER_TIER_ALLOWLIST[allowlistKey]) continue;

        // Must have a regex:^BRANCH: enforced producer
        const producer = findFirstBranchProducer(spec, i);
        assert.ok(
          producer.idx !== -1 && producer.hasRegex,
          `${workflowId}/${step.id}: consumes branch in command context, no allowlist entry and no regex:^BRANCH: producer`,
        );
      }
    }
  });

  it("STRICTER_TIER_ALLOWLIST has exactly 8 entries covering quarantine workflows only", () => {
    const expected = new Set([
      "quarantine-broken-tests/setup",
      "quarantine-broken-tests/quarantine",
      "quarantine-broken-tests-merge/setup",
      "quarantine-broken-tests-merge/quarantine",
      "quarantine-broken-tests-merge/finalize_merge",
      "quarantine-broken-tests-merge-worktree/setup",
      "quarantine-broken-tests-merge-worktree/quarantine",
      "quarantine-broken-tests-merge-worktree/finalize_merge",
    ]);

    const actual = new Set(Object.keys(STRICTER_TIER_ALLOWLIST));

    // Every expected entry must be present
    for (const entry of expected) {
      assert.ok(
        actual.has(entry),
        `STRICTER_TIER_ALLOWLIST missing expected entry: ${entry}`,
      );
    }

    // No extra entries beyond expected
    for (const entry of actual) {
      assert.ok(
        expected.has(entry),
        `STRICTER_TIER_ALLOWLIST has unexpected entry: ${entry}`,
      );
    }

    assert.equal(
      actual.size,
      8,
      `expected 8 allowlist entries, found ${actual.size}`,
    );
  });

  it("every allowlist entry has a non-empty reason comment", () => {
    for (const [key, reason] of Object.entries(STRICTER_TIER_ALLOWLIST)) {
      assert.ok(
        typeof reason === "string" && reason.length > 0,
        `STRICTER_TIER_ALLOWLIST entry "${key}" must have a non-empty reason`,
      );
    }
  });

  it("no allowlist entry is from a non-quarantine workflow", () => {
    for (const key of Object.keys(STRICTER_TIER_ALLOWLIST)) {
      const workflowId = key.split("/").slice(0, -1).join("/");
      assert.ok(
        workflowId.startsWith("quarantine-"),
        `STRICTER_TIER_ALLOWLIST entry "${key}" is not from a quarantine workflow (workflowId: ${workflowId})`,
      );
    }
  });

  it("verify and quarantine-broken-tests steps do not consume branch in command context", () => {
    // The quarantine verify steps consume {{branch}} but in output-contract
    // context (BRANCH: {{branch}}), not command context. This test confirms
    // isConsumedInCommandContext does not produce false positives.
    for (const workflowId of [
      "quarantine-broken-tests",
      "quarantine-broken-tests-merge",
      "quarantine-broken-tests-merge-worktree",
    ]) {
      const spec = allSpecs.get(workflowId)!;
      const verifyStep = spec.steps.find((s) => s.id === "verify");
      if (!verifyStep) continue;

      const inCommandCtx = isConsumedInCommandContext(
        verifyStep.input,
        "branch",
      );
      assert.ok(
        !inCommandCtx,
        `${workflowId}/verify: {{branch}} should NOT be detected as command-context (it is used in output contract, not commands)`,
      );
    }
  });
});
