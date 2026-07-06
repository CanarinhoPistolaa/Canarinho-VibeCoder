/**
 * Tests for src/installer/workflow-contract.ts — the single source of truth
 * for workflow contract key enforcement rules (US-001).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseExpectedKeys,
  parseEnforcedKeys,
  checkExpectsAcceptsVariant,
  AUTO_CONTEXT_KEYS,
  CALLER_PROVIDED,
} from "../dist/installer/workflow-contract.js";

describe("parseExpectedKeys", () => {
  it("extracts keys from Reply with: block", () => {
    const template = [
      "Some preamble text.",
      "Reply with:",
      "BRANCH: {{branch}}",
      "PR: {{pr}}",
      "COMMITS: {{commits}}",
    ].join("\n");
    const keys = parseExpectedKeys(template);
    assert.deepEqual(keys, ["branch", "pr", "commits"]);
  });

  it("handles Reply-with: variant", () => {
    const template = ["Reply-with:", "CHANGES: things"].join("\n");
    assert.deepEqual(parseExpectedKeys(template), ["changes"]);
  });

  it("handles Reply with : variant with spaces", () => {
    const template = ["Reply with :", "TESTS: tests"].join("\n");
    assert.deepEqual(parseExpectedKeys(template), ["tests"]);
  });

  it("stops at blank line after Reply-with block", () => {
    const template = [
      "Reply with:",
      "CHANGES: things",
      "TESTS: tests",
      "",
      "Instructions:",
      "Do something else.",
    ].join("\n");
    const keys = parseExpectedKeys(template);
    assert.deepEqual(keys, ["changes", "tests"]);
  });

  it("returns empty array when no Reply-with section", () => {
    assert.deepEqual(parseExpectedKeys("No reply block here"), []);
    assert.deepEqual(parseExpectedKeys(""), []);
  });

  it("lowercases all keys", () => {
    const template = ["Reply with:", "CHANGES: things", "TESTS: tests"].join("\n");
    for (const key of parseExpectedKeys(template)) {
      assert.equal(key, key.toLowerCase());
    }
  });

  // US-008: MRGV — parseExpectedKeys extracts TESTED_TREE from tester templates
  it("extracts TESTED_TREE from tester Reply-with block", () => {
    const template = [
      "Reply with:",
      "STATUS: done",
      "RESULTS: What you tested and the outcomes",
      "TESTED_TREE: $(git rev-parse HEAD^{tree})",
    ].join("\n");
    const keys = parseExpectedKeys(template);
    assert.ok(keys.includes("tested_tree"),
      `parseExpectedKeys must include "tested_tree", got: ${keys.join(", ")}`);
    assert.ok(keys.includes("status"), "STATUS must be extracted from Reply-with");
    assert.ok(keys.includes("results"), "RESULTS must be extracted from Reply-with");
  });

  // US-008: MRGV — parseExpectedKeys handles merger Reply-with blocks with REBASED and MERGED_TREE
  it("extracts rebased and merged_tree from merger Reply-with blocks", () => {
    const template = [
      "Reply with:",
      "STATUS: done",
      "REBASED: <true|false>",
      "MERGE_COMMIT: <short commit hash>",
      "MERGED_INTO: {{original_branch}}",
      "MERGED_TREE: $(git rev-parse HEAD^{tree})",
    ].join("\n");
    const keys = parseExpectedKeys(template);
    assert.ok(keys.includes("rebased"),
      `parseExpectedKeys must include "rebased", got: ${keys.join(", ")}`);
    assert.ok(keys.includes("merged_tree"),
      `parseExpectedKeys must include "merged_tree", got: ${keys.join(", ")}`);
    assert.ok(keys.includes("merge_commit"),
      `parseExpectedKeys must include "merge_commit", got: ${keys.join(", ")}`);
    assert.ok(keys.includes("merged_into"),
      `parseExpectedKeys must include "merged_into", got: ${keys.join(", ")}`);
  });

  it("is re-exported from step-ops.ts for backward compat", async () => {
    // Dynamic import to avoid hoisting issues in test environment
    const { parseExpectedKeys: fromStepOps } = await import(
      "../dist/installer/step-ops.js"
    );
    assert.equal(typeof fromStepOps, "function");
    const keys = fromStepOps("Reply with:\nKEY: value");
    assert.deepEqual(keys, ["key"]);
  });
});

describe("parseEnforcedKeys", () => {
  it("extracts keys from regex:^KEY: enforcement (caret-anchored)", () => {
    const expects = "STATUS: done\nregex:^BRANCH:\\s*\\S+";
    assert.deepEqual(parseEnforcedKeys(expects), ["branch"]);
  });

  it("extracts keys from regex:KEY: (non-caret)", () => {
    const expects = "STATUS: done\nregex:PR:\\s*https?://.*";
    assert.deepEqual(parseEnforcedKeys(expects), ["pr"]);
  });

  it("extracts both caret and non-caret regex keys", () => {
    const expects = "STATUS: done\nregex:^BRANCH:\\s*\\S+\nregex:PR:\\s*https?://.*";
    assert.deepEqual(parseEnforcedKeys(expects).sort(), ["branch", "pr"].sort());
  });

  it("extracts plain KEY: value lines (not STATUS:)", () => {
    const expects = "STATUS: done\nCHANGES: auto-generated\nTESTS: auto-generated";
    assert.deepEqual(parseEnforcedKeys(expects).sort(), ["changes", "tests"].sort());
  });

  it("excludes STATUS: from results", () => {
    assert.deepEqual(parseEnforcedKeys("STATUS: done"), []);
    assert.deepEqual(parseEnforcedKeys("STATUS: failed"), []);
  });

  it("handles empty expects", () => {
    assert.deepEqual(parseEnforcedKeys(""), []);
  });

  it("handles whitespace-only expects", () => {
    assert.deepEqual(parseEnforcedKeys("  \n  \n  "), []);
  });

  it("lowercases all keys", () => {
    const expects = "STATUS: done\nregex:^SEVERITY:\\s*(critical|high|medium|low)\nregex:CHANGES:\\s*\\S+";
    for (const key of parseEnforcedKeys(expects)) {
      assert.equal(key, key.toLowerCase());
    }
  });

  it("handles compound regex patterns (value-shape-aware)", () => {
    // regex:^SEVERITY:\s*(critical|high|medium|low) should extract "severity"
    const expects = "STATUS: done\nregex:^SEVERITY:\\s*(critical|high|medium|low)";
    assert.deepEqual(parseEnforcedKeys(expects), ["severity"]);
  });

  it("handles numeric regex patterns", () => {
    const expects = "STATUS: done\nregex:^VULNERABILITY_COUNT:\\s*\\d+";
    assert.deepEqual(parseEnforcedKeys(expects), ["vulnerability_count"]);
  });

  it("does not match regex: patterns without KEY: colon", () => {
    // Malformed: regex:\s*\S+ — no KEY name
    assert.deepEqual(parseEnforcedKeys("regex:\\s*\\S+"), []);
    // Malformed: regex:^.*$ — no KEY name
    assert.deepEqual(parseEnforcedKeys("regex:^.*$"), []);
  });

  it("does not match 'regex:STATUS: done' (STATUS excluded)", () => {
    assert.deepEqual(parseEnforcedKeys("regex:STATUS: done"), []);
  });

  it("comprehensive multi-line expects", () => {
    const expects = [
      "STATUS: done",
      "BRANCH: sim-branch",
      "regex:^PR:\\s*https?://github\\.com/.*",
      "regex:^SEVERITY:\\s*(critical|high|medium|low)",
      "regex:AFFECTED_AREA:\\s*\\S+",
      "COMMITS: abc123",
    ].join("\n");
    const keys = parseEnforcedKeys(expects).sort();
    assert.deepEqual(
      keys,
      ["affected_area", "branch", "commits", "pr", "severity"].sort(),
    );
  });

  it("deduplicates keys appearing in multiple tiers", () => {
    const expects = "STATUS: done\nBRANCH: sim\nregex:^BRANCH:\\s*\\S+";
    // branch appears both as plain KEY and regex enforcement — it's OK to include twice
    // (consumers deduplicate anyway) but the extraction should capture both forms
    const keys = parseEnforcedKeys(expects);
    assert.ok(keys.includes("branch"));
  });

  // US-008: MRGV — parseEnforcedKeys with merger multi-line regex expects
  it("extracts rebased from merger dual-shape expects (regex alternation)", () => {
    const expects = "regex:^STATUS:\\s*(done|retry)\\s*$\nregex:^REBASED:\\s*(true|false)\\s*$";
    const keys = parseEnforcedKeys(expects);
    assert.deepEqual(keys, ["rebased"], "merger expects must extract only 'rebased' (STATUS excluded)");
  });

  // US-008: MRGV — parseEnforcedKeys with TESTED_TREE regex
  it("extracts tested_tree from TESTED_TREE regex enforcement", () => {
    const expects = "STATUS: done\nregex:^TESTED_TREE:\\s*\\S+";
    const keys = parseEnforcedKeys(expects);
    assert.ok(keys.includes("tested_tree"), `must extract 'tested_tree', got: ${keys.join(", ")}`);
    assert.equal(
      keys.includes("status"),
      false,
      "STATUS must not be extracted as a data key",
    );
  });

  // US-008: MRGV — parseEnforcedKeys with compound expects (both rebased and tested_tree patterns)
  it("extracts both rebased and tested_tree from compound expects", () => {
    const expects = [
      "regex:^STATUS:\\s*(done|retry)\\s*$",
      "regex:^REBASED:\\s*(true|false)\\s*$",
      "regex:^MERGED_TREE:\\s*\\S+",
    ].join("\n");
    const keys = parseEnforcedKeys(expects).sort();
    assert.deepEqual(keys, ["merged_tree", "rebased"].sort(),
      "must extract both 'rebased' and 'merged_tree' (STATUS excluded)");
  });

  // US-008: MRGV — checkExpectsAcceptsVariant with merger regex alternation
  it("checkExpectsAcceptsVariant: merger multi-line expects accepts both done and retry", () => {
    const expects = "regex:^STATUS:\\s*(done|retry)\\s*$\nregex:^REBASED:\\s*(true|false)\\s*$";

    assert.equal(checkExpectsAcceptsVariant(expects, "done"), true,
      "merger expects must accept STATUS: done");
    assert.equal(checkExpectsAcceptsVariant(expects, "retry"), true,
      "merger expects must accept STATUS: retry (rebase loopback)");
    assert.equal(checkExpectsAcceptsVariant(expects, "failed"), false,
      "merger expects must reject STATUS: failed (not a valid merger outcome)");
  });
});

describe("AUTO_CONTEXT_KEYS", () => {
  it("has the expected 14 keys", () => {
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
    assert.equal(AUTO_CONTEXT_KEYS.size, 14);
  });

  it("is a readonly Set<string>", () => {
    assert.ok(AUTO_CONTEXT_KEYS instanceof Set);
    assert.ok(AUTO_CONTEXT_KEYS.has("run_id"));
    assert.ok(AUTO_CONTEXT_KEYS.has("task"));
  });

  it("contains all runtime-context keys", () => {
    // Structural/infrastructure keys that must be present
    assert.ok(AUTO_CONTEXT_KEYS.has("run_id"), "missing run_id");
    assert.ok(AUTO_CONTEXT_KEYS.has("task"), "missing task");
    assert.ok(AUTO_CONTEXT_KEYS.has("retry_feedback"), "missing retry_feedback");
    assert.ok(AUTO_CONTEXT_KEYS.has("verify_feedback"), "missing verify_feedback");
    assert.ok(AUTO_CONTEXT_KEYS.has("progress"), "missing progress");
    assert.ok(AUTO_CONTEXT_KEYS.has("progress_file"), "missing progress_file");
    assert.ok(AUTO_CONTEXT_KEYS.has("current_story"), "missing current_story");
    assert.ok(AUTO_CONTEXT_KEYS.has("completed_stories"), "missing completed_stories");
    assert.ok(AUTO_CONTEXT_KEYS.has("stories_remaining"), "missing stories_remaining");
    assert.ok(AUTO_CONTEXT_KEYS.has("has_frontend_changes"), "missing has_frontend_changes");
    assert.ok(AUTO_CONTEXT_KEYS.has("has_pr"), "missing has_pr");
    assert.ok(AUTO_CONTEXT_KEYS.has("timeout_retry"), "missing timeout_retry");
  });
});

describe("CALLER_PROVIDED", () => {
  it("has entries for quarantine workflows with branch", () => {
    assert.deepEqual(
      CALLER_PROVIDED["quarantine-broken-tests"],
      ["branch"],
      "quarantine-broken-tests should provide branch",
    );
    assert.deepEqual(
      CALLER_PROVIDED["quarantine-broken-tests-merge"],
      ["branch"],
      "quarantine-broken-tests-merge should provide branch",
    );
    assert.deepEqual(
      CALLER_PROVIDED["quarantine-broken-tests-merge-worktree"],
      ["branch"],
      "quarantine-broken-tests-merge-worktree should provide branch",
    );
  });

  it("has entry for just-do-it with target_working_directory_for_harness", () => {
    assert.deepEqual(
      CALLER_PROVIDED["just-do-it"],
      ["target_working_directory_for_harness"],
      "just-do-it should provide target_working_directory_for_harness",
    );
  });

  it("has exactly 4 entries", () => {
    assert.equal(Object.keys(CALLER_PROVIDED).length, 4);
  });

  it("all values are non-empty string arrays", () => {
    for (const [key, values] of Object.entries(CALLER_PROVIDED)) {
      assert.ok(Array.isArray(values), `${key}: values must be an array`);
      assert.ok(values.length > 0, `${key}: values array must not be empty`);
      for (const v of values) {
        assert.equal(typeof v, "string", `${key}: each value must be a string`);
        assert.ok(v.length > 0, `${key}: each value must be non-empty`);
      }
    }
  });
});
