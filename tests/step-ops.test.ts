import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseOutputKeyValues, parseExpectedKeys, findProducerForMissingKey, resolveTemplate, buildStoryPlanSection, mergeStoryPlanIntoProgress, validateExpects, completeStep, resolveStepContext, failStep, claimStep, getWorkflowId, advancePipeline, recoverOrphanedStepsForAgent } from "../dist/installer/step-ops.js";
import { getRunEvents } from "../dist/installer/events.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

describe("parseOutputKeyValues", () => {
  it("parses simple KEY: value pairs", () => {
    const result = parseOutputKeyValues("STATUS: done\nCHANGES: fixed bug\nTESTS: ran suite");
    assert.equal(result.status, "done");
    assert.equal(result.changes, "fixed bug");
    assert.equal(result.tests, "ran suite");
  });

  it("last value wins for duplicate keys", () => {
    const result = parseOutputKeyValues("STATUS: first\nSTATUS: second\nSTATUS: final");
    assert.equal(result.status, "final");
  });

  it("handles multi-line values", () => {
    const result = parseOutputKeyValues(
      "STATUS: done\nCHANGES: fixed bug\n  - item 1\n  - item 2\nTESTS: all pass"
    );
    assert.equal(result.changes, "fixed bug\n  - item 1\n  - item 2");
  });

  it("skips STORIES_JSON keys", () => {
    const result = parseOutputKeyValues("STORIES_JSON: [{...}]\nSTATUS: done");
    assert.equal(result.status, "done");
    assert.ok(!result.stories_json);
  });

  it("returns empty object for empty input", () => {
    const result = parseOutputKeyValues("");
    assert.deepEqual(result, {});
  });

  it("handles KEY with empty value", () => {
    const result = parseOutputKeyValues("STATUS:\nCHANGES: something");
    assert.equal(result.status, "");
    assert.equal(result.changes, "something");
  });
});

describe("parseExpectedKeys", () => {
  it("extracts BRANCH, REPO, ORIGINAL_BRANCH from setup step input template", () => {
    const template = `Prepare the development environment.

      TASK:
      {{task}}

      REPO: {{repo}}
      BRANCH: {{branch}}

      Reply with:
      STATUS: done
      BUILD_CMD: <build command>
      TEST_CMD: <test command>
      ORIGINAL_BRANCH: main region
      BRANCH: <new branch>
      REPO: /path/to/repo
      CI_NOTES: <notes>
      BASELINE: <baseline>`;
    const keys = parseExpectedKeys(template);
    assert.deepEqual(keys.sort(), ["baseline", "branch", "build_cmd", "ci_notes", "original_branch", "repo", "status", "test_cmd"].sort());
  });

  it("returns empty array when no 'Reply with:' section exists", () => {
    const template = "Just a plain template with {{key}} and no Reply-with block.";
    const keys = parseExpectedKeys(template);
    assert.deepEqual(keys, []);
  });

  it("handles multi-line values after KEY: lines (does not capture them as keys)", () => {
    const template = `Do the work.

      Reply with:
      STATUS: done
      CHANGES: fixed bug
        - item 1
        - item 2
      TESTS: all pass`;
    const keys = parseExpectedKeys(template);
    assert.deepEqual(keys.sort(), ["changes", "status", "tests"].sort());
  });

  it("stops at blank line after Reply-with block", () => {
    const template = `Task here.

      Reply with:
      STATUS: done
      BRANCH: my-branch

      Instructions:
      Some more text after the blank line.
      MORE_KEYS: should not be captured`;
    const keys = parseExpectedKeys(template);
    assert.deepEqual(keys.sort(), ["branch", "status"].sort());
  });

  it("handles 'Reply with :' with extra spaces", () => {
    const template = `Task.

      Reply with :
      STATUS: done
      REPO: /x`;
    const keys = parseExpectedKeys(template);
    assert.ok(keys.includes("status"));
    assert.ok(keys.includes("repo"));
  });

  it("handles 'Reply-with:' variant", () => {
    const template = `Task.

      Reply-with:
      STATUS: done
      BRANCH: x`;
    const keys = parseExpectedKeys(template);
    assert.ok(keys.includes("status"));
    assert.ok(keys.includes("branch"));
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseExpectedKeys(""), []);
  });

  it("returns empty array when Reply-with section has no keys", () => {
    const template = `Task.

      Reply with:
      (explain what you did here)`;
    const keys = parseExpectedKeys(template);
    assert.deepEqual(keys, []);
  });
});

describe("resolveTemplate", () => {
  it("replaces {{key}} with context values", () => {
    const result = resolveTemplate("Hello {{name}}", { name: "world" });
    assert.equal(result, "Hello world");
  });

  it("replaces multiple placeholders", () => {
    const result = resolveTemplate("{{greeting}} {{name}} from {{place}}", {
      greeting: "Hi",
      name: "Igor",
      place: "Brazil",
    });
    assert.equal(result, "Hi Igor from Brazil");
  });

  it("uses case-insensitive lookup", () => {
    const result = resolveTemplate("{{task}} and {{TASK}}", { task: "fix bug" });
    assert.equal(result, "fix bug and fix bug");
  });

  it("shows [missing: key] for unresolved keys", () => {
    const result = resolveTemplate("Hello {{missing}}", {});
    assert.equal(result, "Hello [missing: missing]");
  });

  it("passes through text without placeholders", () => {
    const result = resolveTemplate("plain text", {});
    assert.equal(result, "plain text");
  });
});

describe("buildStoryPlanSection", () => {
  it("builds a Story Plan section from stories", () => {
    const stories = [
      {
        storyId: "US-001",
        title: "Add login",
        description: "Implement user login flow",
        acceptanceCriteria: ["User can log in", "Invalid creds show error"],
      },
      {
        storyId: "US-002",
        title: "Add dashboard",
        description: "Create user dashboard",
        acceptanceCriteria: ["Shows user stats", "Responsive design"],
      },
    ];

    const result = buildStoryPlanSection(stories);

    assert.ok(result.includes("## Story Plan"));
    assert.ok(result.includes("### US-001: Add login"));
    assert.ok(result.includes("**Description:** Implement user login flow"));
    assert.ok(result.includes("**Acceptance Criteria:**"));
    assert.ok(result.includes("- User can log in"));
    assert.ok(result.includes("- Invalid creds show error"));
    assert.ok(result.includes("### US-002: Add dashboard"));
    assert.ok(result.includes("**Description:** Create user dashboard"));
    assert.ok(result.includes("- Shows user stats"));
    assert.ok(result.includes("- Responsive design"));
  });

  it("returns just the heading for empty array", () => {
    const result = buildStoryPlanSection([]);
    assert.equal(result, "## Story Plan\n\n");
  });

  it("handles stories with single acceptance criterion", () => {
    const stories = [
      {
        storyId: "US-001",
        title: "Fix bug",
        description: "Fix the crash",
        acceptanceCriteria: ["App does not crash"],
      },
    ];

    const result = buildStoryPlanSection(stories);
    assert.ok(result.includes("- App does not crash"));
    assert.ok(!result.includes("\n\n\n")); // No double blank lines from missing ACs
  });
});

describe("mergeStoryPlanIntoProgress", () => {
  const storySection = "## Story Plan\n\n### US-001: Do thing\n\n**Description:** A thing to do\n\n**Acceptance Criteria:**\n- It works\n";

  it("creates new progress file with Story Plan when content is empty", () => {
    const result = mergeStoryPlanIntoProgress("", storySection);
    assert.ok(result.startsWith("# Progress Log"));
    assert.ok(result.includes(storySection));
  });

  it("inserts Story Plan after header when content has no Story Plan", () => {
    const existing = "# Progress Log\n\n## Codebase Patterns\n- Uses SQLite\n";
    const result = mergeStoryPlanIntoProgress(existing, storySection);
    assert.ok(result.startsWith("# Progress Log\n\n"));
    assert.ok(result.includes(storySection.trim()));
    assert.ok(result.includes("## Codebase Patterns"));
    assert.ok(result.includes("- Uses SQLite"));
    // Story Plan should come before Codebase Patterns
    const storyIdx = result.indexOf("## Story Plan");
    const patternsIdx = result.indexOf("## Codebase Patterns");
    assert.ok(storyIdx < patternsIdx, "Story Plan should appear before Codebase Patterns");
  });

  it("replaces existing Story Plan section while preserving other content", () => {
    const oldStorySection = "## Story Plan\n\n### OLD-001: Old story\n\n**Description:** Outdated\n\n**Acceptance Criteria:**\n- Old AC\n";
    const existing = "# Progress Log\n\n## Codebase Patterns\n- Pattern A\n\n" + oldStorySection + "\n## Other Section\n- Note\n";
    const result = mergeStoryPlanIntoProgress(existing, storySection);

    // Should keep Codebase Patterns
    assert.ok(result.includes("## Codebase Patterns"));
    assert.ok(result.includes("- Pattern A"));
    // Should keep Other Section
    assert.ok(result.includes("## Other Section"));
    assert.ok(result.includes("- Note"));
    // Should have new Story Plan
    assert.ok(result.includes("### US-001: Do thing"));
    // Should NOT have old Story Plan
    assert.ok(!result.includes("### OLD-001: Old story"));
    assert.ok(!result.includes("Old AC"));
  });

  it("replaces Story Plan when it is the only content", () => {
    const oldStorySection = "## Story Plan\n\n### OLD-001: Old story\n\n**Description:** Outdated\n\n**Acceptance Criteria:**\n- Old AC\n";
    const result = mergeStoryPlanIntoProgress("# Progress Log\n\n" + oldStorySection, storySection);
    assert.ok(result.includes("### US-001: Do thing"));
    assert.ok(!result.includes("### OLD-001: Old story"));
  });

  it("inserts Story Plan at top when content has no heading", () => {
    const existing = "Just some notes\nno heading here\n";
    const result = mergeStoryPlanIntoProgress(existing, storySection);
    assert.ok(result.includes(storySection.trim()));
    assert.ok(result.includes("Just some notes"));
  });
});

describe("validateExpects", () => {
  it("returns null for empty expects", () => {
    assert.equal(validateExpects("any output", ""), null);
    assert.equal(validateExpects("any output", "  \n "), null);
  });

  it("passes when literal substring is present", () => {
    const result = validateExpects("STATUS: done\nPR: https://github.com/org/repo/pull/42", "STATUS: done");
    assert.equal(result, null);
  });

  it("fails when literal substring is missing", () => {
    const result = validateExpects("STATUS: fail\nError: something", "STATUS: done");
    assert.ok(result !== null);
    assert.ok(result!.includes("Output missing expects string"));
  });

  it("passes when regex matches output", () => {
    const result = validateExpects(
      "STATUS: done\nPR: https://github.com/org/repo/pull/42",
      "regex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+"
    );
    assert.equal(result, null);
  });

  it("rejects pull/new/<branch> placeholder URL", () => {
    const fakeOutput = "STATUS: done\nPR: https://github.com/org/repo/pull/new/bugfix-branch";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(fakeOutput, expects);
    assert.ok(result !== null);
    assert.ok(result!.includes("does not match expects regex"));
  });

  it("rejects pull/compare/<branch> URLs", () => {
    const fakeOutput = "STATUS: done\nPR: https://github.com/org/repo/pull/compare/main...feature";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(fakeOutput, expects);
    assert.ok(result !== null);
  });

  it("passes with valid HTTPS PR URL with number suffix", () => {
    const output = "STATUS: done\nPR: https://github.com/igorhvr/tamandua/pull/999";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(output, expects);
    assert.equal(result, null);
  });

  it("validates multi-line expects — all lines must pass", () => {
    const output = "STATUS: done\nPR: https://github.com/org/repo/pull/1";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(output, expects);
    assert.equal(result, null);
  });

  it("fails on multi-line expects when literal line is missing", () => {
    const output = "STATUS: retry\nPR: https://github.com/org/repo/pull/1";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(output, expects);
    assert.ok(result !== null);
    assert.ok(result!.includes("missing expects string"));
  });

  it("returns error for invalid regex pattern", () => {
    const result = validateExpects("any output", "regex:[invalid\\");
    assert.ok(result !== null);
    assert.ok(result!.includes("Invalid expects regex pattern"));
  });

  it("passes with http (non-https) PR URL", () => {
    const output = "STATUS: done\nPR: http://github.com/org/repo/pull/42";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(output, expects);
    assert.equal(result, null);
  });

  it("treats blank lines in expects as ignored", () => {
    const result = validateExpects(
      "STATUS: done",
      "STATUS: done\n\n"
    );
    assert.equal(result, null);
  });
});

describe("PR agent persona regression", () => {
  const personaPath = path.join(repoRoot, "agents", "shared", "pr", "AGENTS.md");

  it("contains step fail guidance for gh pr create failure", () => {
    const content = fs.readFileSync(personaPath, "utf-8");
    assert.ok(content.includes("step fail"), "Persona must mention step fail");
    assert.ok(
      content.includes("gh pr create failed") || content.includes("gh pr create fails"),
      "Persona must handle gh pr create failure"
    );
    assert.ok(content.includes("Failure Handling"), "Persona must have a Failure Handling section");
    assert.ok(
      content.includes("pull/new/"),
      "Persona must explicitly forbid pull/new/ fallback URLs"
    );
    assert.ok(
      content.includes("Do not fall back") || content.includes("Do NOT fall back") || content.includes("Do NOT report a \\`pull/new/\\`"),
      "Persona must explicitly forbid falling back to manual URL"
    );
  });
});

describe("Workflow YAML PR step expects validation", () => {
  const bugFixPath = path.join(repoRoot, "workflows", "bug-fix-github-pr", "workflow.yml");
  const featureDevPath = path.join(repoRoot, "workflows", "feature-dev-github-pr", "workflow.yml");

  function extractPrStepExpects(yamlPath: string): string | null {
    const content = fs.readFileSync(yamlPath, "utf-8");
    const spec = parseYaml(content);
    const prStep = spec.steps?.find((s: any) => s.id === "pr");
    return prStep?.expects ?? null;
  }

  it("bug-fix-github-pr pr step expects rejects pull/new/<branch> URL", () => {
    const expects = extractPrStepExpects(bugFixPath);
    assert.ok(expects, "pr step must have an expects field");

    const fakeOutput = "STATUS: done\nPR: https://github.com/org/repo/pull/new/bugfix-branch";
    const result = validateExpects(fakeOutput, expects);
    assert.ok(result !== null, "pull/new/<branch> URL should be rejected: " + expects);
  });

  it("bug-fix-github-pr pr step expects accepts valid pull/NNN URL", () => {
    const expects = extractPrStepExpects(bugFixPath);
    assert.ok(expects, "pr step must have an expects field");

    const validOutput = "STATUS: done\nPR: https://github.com/igorhvr/tamandua/pull/42";
    const result = validateExpects(validOutput, expects);
    assert.equal(result, null, "Valid pull/NNN URL should be accepted: " + expects);
  });

  it("feature-dev-github-pr pr step expects rejects pull/new/<branch> URL", () => {
    const expects = extractPrStepExpects(featureDevPath);
    assert.ok(expects, "pr step must have an expects field");

    const fakeOutput = "STATUS: done\nPR: https://github.com/org/repo/pull/new/feature-x";
    const result = validateExpects(fakeOutput, expects);
    assert.ok(result !== null, "pull/new/<branch> URL should be rejected: " + expects);
  });

  it("feature-dev-github-pr pr step expects accepts valid pull/NNN URL", () => {
    const expects = extractPrStepExpects(featureDevPath);
    assert.ok(expects, "pr step must have an expects field");

    const validOutput = "STATUS: done\nPR: https://github.com/igorhvr/tamandua/pull/42";
    const result = validateExpects(validOutput, expects);
    assert.equal(result, null, "Valid pull/NNN URL should be accepted: " + expects);
  });
});

describe("Reserved context key protection", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-reserved-keys-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("completeStep does not overwrite reserved keys (repo, working_directory_for_harness, task, run_id)", async () => {
    // Import getDb lazily so TAMANDUA_DB_PATH is already set
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    // Seed run with repo = /tmp/harness-a
    const seededContext = JSON.stringify({
      task: "fix bug",
      repo: "/tmp/harness-a",
      working_directory_for_harness: "/tmp/harness-a",
      run_id: runId,
    });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'test-wf_planner', 0, '{{task}}', '', 'running', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    // Planner step output includes REPO: /tmp/harness-b (exploit attempt)
    const maliciousOutput = "STATUS: done\nREPO: /tmp/harness-b\nWORKING_DIRECTORY_FOR_HARNESS: /tmp/harness-b\nTASK: evil task\nRUN_ID: fake-run-id\nBRANCH: bugfix/x";

    completeStep(stepId, maliciousOutput);

    // Verify run context was NOT overwritten for reserved keys
    const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const context = JSON.parse(run.context);

    assert.equal(context.repo, "/tmp/harness-a", "repo must not be overwritten by step output");
    assert.equal(context.working_directory_for_harness, "/tmp/harness-a", "working_directory_for_harness must not be overwritten");
    assert.equal(context.task, "fix bug", "task must not be overwritten by step output");
    assert.equal(context.run_id, runId, "run_id must not be overwritten by step output");

    // Non-reserved keys like BRANCH should still be merged
    assert.equal(context.branch, "bugfix/x", "non-reserved keys like branch should still be merged");
  });

  it("resolveStepContext does not overwrite reserved keys from previous step outputs", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    // Seed run with repo = /tmp/harness-a
    const seededContext = JSON.stringify({
      task: "fix bug",
      repo: "/tmp/harness-a",
      working_directory_for_harness: "/tmp/harness-a",
      run_id: runId,
    });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Planner step (index 0) — done, with malicious REPO output
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'test-wf_planner', 0, '{{task}}', '', 'done', ?, 0, 4, 'single', ?, ?)"
    ).run(planStepId, runId, "STATUS: done\nREPO: /tmp/harness-b\nWORKING_DIRECTORY_FOR_HARNESS: /tmp/harness-b\nBRANCH: bugfix/x", now, now);

    // Fixer step (index 1) — being claimed
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 1, 'Fix {{repo}} on {{branch}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(fixStepId, runId, now, now);

    // Resolve context for the fixer step (step index 1)
    const context = resolveStepContext(runId, 1);

    // Reserved keys must NOT be overwritten by previous step outputs
    assert.equal(context.repo, "/tmp/harness-a", "resolveStepContext: repo must not be overwritten by previous step output");
    assert.equal(context.working_directory_for_harness, "/tmp/harness-a", "resolveStepContext: working_directory_for_harness must not be overwritten");
    assert.equal(context.task, "fix bug", "resolveStepContext: task must not be overwritten");
    assert.equal(context.run_id, runId, "resolveStepContext: run_id must not be overwritten");

    // Non-reserved keys should still flow through from previous steps
    assert.equal(context.branch, "bugfix/x", "resolveStepContext: non-reserved keys like branch should come through");
  });
});

describe("completeStep STORIES_JSON guard — only blocks when loop-step is immediately next", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-stories-guard-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("allows scan step to complete without STORIES_JSON when a later intermediate step produces stories (security-audit shape)", async () => {
    // Simulate: scan(idx 0, single) -> prioritize(idx 1, single) -> setup(idx 2, single) -> fix(idx 3, loop over stories)
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const scanStepId = crypto.randomUUID();
    const prioritizeStepId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "audit security" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'security-audit', 'audit security', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // scan step (index 0, single) — the step we are completing
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'scan', 'sec-audit_scanner', 0, 'Scan codebase', '', 'running', 0, 4, 'single', ?, ?)"
    ).run(scanStepId, runId, now, now);

    // prioritize step (index 1, single)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'prioritize', 'sec-audit_prioritizer', 1, 'Prioritize', '', 'waiting', 0, 4, 'single', ?, ?)"
    ).run(prioritizeStepId, runId, now, now);

    // setup step (index 2, single)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'sec-audit_setup', 2, 'Setup', '', 'waiting', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, now, now);

    // fix step (index 3, loop over stories)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'sec-audit_fixer', 3, 'Fix', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(fixStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete scan with STATUS: done and no STORIES_JSON — should succeed (not retry)
    const result = completeStep(scanStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: sec-audit-2025-01-01\nVULNERABILITY_COUNT: 11\nFINDINGS: detailed findings here");

    assert.notEqual(result.status, "retrying", "scan should not be retried when loop step is not immediately next");
    assert.notEqual(result.status, "failed", "scan should not be failed when loop step is not immediately next");

    // scan should be marked done
    const scanStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(scanStepId) as { status: string };
    assert.equal(scanStep.status, "done", "scan should be marked done");

    // prioritize should be advanced to pending
    const prioritizeStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(prioritizeStepId) as { status: string };
    assert.equal(prioritizeStep.status, "pending", "prioritize should be advanced to pending");
  });

  it("retries planner step without STORIES_JSON when loop-step is immediately next", async () => {
    // Simulate: plan(idx 0, single) -> fix(idx 1, loop over stories)
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix-merge', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // plan step (index 0, single) — the step we are completing
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'bfm_planner', 0, 'Plan fix', '', 'running', 0, 3, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    // fix step (index 1, loop over stories) — immediately next
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'bfm_fixer', 1, 'Fix', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(fixStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete plan with STATUS: done but no STORIES_JSON — should be retried because fix(loop) is immediately next
    const result = completeStep(planStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: bugfix/x\nCHANGES: analyzed");

    assert.equal(result.status, "retrying", "plan should be retried when immediately-following step is loop-over-stories and no stories exist");

    // plan should be back to pending (not done, not failed)
    const planStep = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(planStepId) as { status: string; retry_count: number };
    assert.equal(planStep.status, "pending", "plan should be reset to pending for retry");
    assert.equal(planStep.retry_count, 1, "retry_count should be incremented to 1");

    // fix should still be waiting (not advanced)
    const fixStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(fixStepId) as { status: string };
    assert.equal(fixStep.status, "waiting", "fix step should still be waiting");
  });

  it("fails planner step when max_retries exhausted for missing STORIES_JSON", async () => {
    // Simulate: plan(idx 0, single) -> fix(idx 1, loop over stories)
    // plan already at max_retries-1, one more failure should exhaust
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix-merge', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // plan step (index 0, single) — already at retry_count=2, max_retries=2
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'bfm_planner', 0, 'Plan fix', '', 'running', 2, 2, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    // fix step (index 1, loop over stories) — immediately next
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'bfm_fixer', 1, 'Fix', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(fixStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete plan without STORIES_JSON — should fail because retries exhausted
    const result = completeStep(planStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: bugfix/x");

    assert.equal(result.status, "failed", "plan should fail when retries exhausted for missing STORIES_JSON");

    // plan should be marked failed
    const planStep = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(planStepId) as { status: string; retry_count: number };
    assert.equal(planStep.status, "failed", "plan should be failed");
    assert.equal(planStep.retry_count, 3, "retry_count should be incremented to 3");

    // run should also be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });
});

describe("completeStep STORIES_JSON guard — story-producer blamed across intermediate steps", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-stories-guard-intermediate-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("blames planner (not setup) when planner omits STORIES_JSON and there is an intermediate step before the loop", async () => {
    // Simulates e49c370d failure mode: plan(idx 0) -> setup(idx 1) -> implement(idx 2, loop-over-stories)
    // Planner is the story producer (input mentions STORIES_JSON).
    // When planner completes without STORIES_JSON, the guard should blame planner,
    // NOT setup — even though setup sits between planner and the loop step.
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const implementStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature X" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature X', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // plan step (index 0, single) — input_template mentions STORIES_JSON
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'fdm_planner', 0, 'Plan {{task}}\
Reply with:\
STORIES_JSON: [...]', 'STATUS: done', 'running', 0, 4, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    // setup step (index 1, single) — input_template does NOT mention STORIES_JSON
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 1, 'Setup {{task}}\
RETRY FEEDBACK: {{retry_feedback}}\
Instructions:', 'STATUS: done', 'waiting', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, now, now);

    // implement step (index 2, loop over stories) — two steps away from planner
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 2, 'Implement story', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(implementStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete plan with STATUS: done but NO STORIES_JSON
    const result = completeStep(planStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: feature/x\nCHANGES: planned");

    // Planner should be blamed (retried) — NOT setup
    assert.equal(result.status, "retrying", "planner should be retried when it omits STORIES_JSON, even with intermediate setup step");
    assert.ok(result.detail, "retry response should include detail field");
    assert.ok(result.detail!.includes("STORIES_JSON"), `detail should mention STORIES_JSON, got: ${result.detail}`);

    // Planner should be reset to pending
    const planStep = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(planStepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(planStep.status, "pending", "planner should be reset to pending for retry");
    assert.equal(planStep.retry_count, 1, "planner retry_count should be incremented");
    assert.ok(planStep.output?.includes("STORIES_JSON"), "planner output should contain retry feedback about STORIES_JSON");

    // Setup should remain waiting — NOT reset to pending
    const setupStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(setupStepId) as { status: string };
    assert.equal(setupStep.status, "waiting", "setup should remain waiting (not blamed)");

    // Implement should also stay waiting
    const implementStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(implementStepId) as { status: string };
    assert.equal(implementStep.status, "waiting", "implement should remain waiting");
  });

  it("does not blame planner across intermediate steps when stories already exist", async () => {
    // After planner produces STORIES_JSON, completing planner should succeed
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const implementStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature X" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'feature-dev-merge', 'implement feature X', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // plan step (index 0) — already retried once
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'fdm_planner', 0, 'Plan {{task}}\
Reply with:\
STORIES_JSON: [...]', 'STATUS: done', 'running', 1, 4, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 1, 'Setup', 'STATUS: done', 'waiting', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 2, 'Implement', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(implementStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // This time the planner output INCLUDES valid STORIES_JSON
    const outputWithStories = 'STATUS: done\nREPO: /tmp/repo\nBRANCH: feature/x\nSTORIES_JSON: [{"id":"US-001","title":"Add feature","description":"Add the feature","acceptanceCriteria":["Feature works","Typecheck passes"]}]';
    const result = completeStep(planStepId, outputWithStories);

    // Should succeed (not retry) — stories now exist
    assert.notEqual(result.status, "retrying", "planner should succeed when STORIES_JSON is present");
    assert.notEqual(result.status, "failed", "planner should not fail");

    // Planner should be marked done
    const planStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(planStepId) as { status: string };
    assert.equal(planStep.status, "done", "planner should be done");

    // Setup should be advanced to pending
    const setupStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(setupStepId) as { status: string };
    assert.equal(setupStep.status, "pending", "setup should advance to pending");
  });
});

describe("failStep retry feedback persistence", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-failstep-retry-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("failStep non-final retry writes error to steps.output", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Single step with retry_count=0, max_retries=3, currently running
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix {{task}}', '', 'running', 0, 3, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const errorMsg = "Build failed: type errors in src/foo.ts";

    const result = await failStep(stepId, errorMsg);

    assert.equal(result.status, "retrying", "should return retrying status");

    // Verify step.output now contains the error message
    const step = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.retry_count, 1, "retry_count should be incremented to 1");
    assert.equal(step.output, errorMsg, "step.output should contain the error message");

    // Verify run is still running (not failed)
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "run should still be running after non-final retry");
  });

  it("failStep final retry (exhausted) writes error to output and marks step failed", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Single step already at retry_count=2 with max_retries=2 — next failure exhausts
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix {{task}}', '', 'running', 2, 2, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const errorMsg = "Persistent build failure: cannot resolve imports";

    const result = await failStep(stepId, errorMsg);

    assert.equal(result.status, "failed", "should return failed status when retries exhausted");

    // Verify step is failed with error in output
    const step = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(step.status, "failed", "step should be marked failed");
    assert.equal(step.retry_count, 3, "retry_count should be incremented to 3");
    assert.equal(step.output, errorMsg, "step.output should contain the error message even on final failure");

    // Verify run is failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be marked failed when retries exhausted");
  });

  it("claimStep surfaces retry_feedback from persisted output when retry_count > 0", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 3, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Step that has been retried once, with output containing prior failure reason
    const priorError = "Timeout: step took too long to complete";
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, output, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix {{task}}\\n\\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 1, 3, ?, 'single', ?, ?)"
    ).run(stepId, runId, priorError, now, now);

    const result = claimStep("bf_fixer", runId);

    assert.ok(result.found, "claimStep should find the pending retry step");
    assert.equal(result!.stepId, stepId, "should claim the fix step by its row id");

    // The resolved input should contain the retry_feedback
    assert.ok(result!.resolvedInput!.includes(priorError), `resolved input should contain the retry_feedback text "${priorError}", got: ${result!.resolvedInput}`);
    assert.ok(result!.resolvedInput!.includes("RETRY FEEDBACK:"), "resolved input should contain the RETRY FEEDBACK section label");
  });

  it("claimStep sets retry_feedback to empty string when retry_count is 0", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 4, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // First attempt step (retry_count=0), output is null
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix {{task}}\\n\\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 3, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = claimStep("bf_fixer", runId);

    assert.ok(result.found, "claimStep should find the first-attempt step");
    assert.equal(result!.stepId, stepId, "should claim the fix step by its row id");

    // The resolved input should have retry_feedback as empty (not "[missing: retry_feedback]")
    assert.ok(!result!.resolvedInput!.includes("[missing: retry_feedback]"), "retry_feedback should not be missing-key");
    assert.ok(!result!.resolvedInput!.includes("Timeout"), "retry_feedback should be empty on first attempt");
  });
});

describe("setup-specific retry_feedback rendering", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-setup-retry-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("claimStep resolves setup input with retry_feedback when retry_count > 0", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature X", repo: "/tmp/repo", branch: "feature/x" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature X', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Setup step that has been retried once, with output containing prior failure reason
    const priorError = "Setup rejected: STORIES_JSON guard — planner produced no stories";
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, output, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, 'Prepare env for {{task}}\
\
RETRY FEEDBACK: {{retry_feedback}}\
\
Instructions:', 'STATUS: done', 'pending', 1, 4, ?, 'single', ?, ?)"
    ).run(setupStepId, runId, priorError, now, now);

    const result = claimStep("fdm_setup", runId);

    assert.ok(result.found, "claimStep should find the pending retry setup step");
    assert.equal(result!.stepId, setupStepId, "should claim the setup step by its row id");

    // The resolved input should contain the retry_feedback text
    assert.ok(result!.resolvedInput!.includes(priorError), `resolved setup input should contain the retry_feedback text "${priorError}", got: ${result!.resolvedInput}`);
    assert.ok(result!.resolvedInput!.includes("RETRY FEEDBACK:"), "resolved setup input should contain the RETRY FEEDBACK section label");
  });

  it("claimStep resolves setup input with empty retry_feedback when retry_count is 0", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature X", repo: "/tmp/repo", branch: "feature/x" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'feature-dev-merge', 'implement feature X', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // First-attempt setup step (retry_count=0, output is null)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, 'Prepare env for {{task}}\
\
RETRY FEEDBACK: {{retry_feedback}}\
\
Instructions:', 'STATUS: done', 'pending', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, now, now);

    const result = claimStep("fdm_setup", runId);

    assert.ok(result.found, "claimStep should find the first-attempt setup step");
    assert.equal(result!.stepId, setupStepId, "should claim the setup step by its row id");

    // The resolved input should have retry_feedback as empty (not "[missing: retry_feedback]")
    assert.ok(!result!.resolvedInput!.includes("[missing: retry_feedback]"), "retry_feedback should not be missing-key on first attempt");
    assert.ok(!result!.resolvedInput!.includes("STORIES_JSON guard"), "retry_feedback should be empty on first attempt");
  });
});

describe("completeStep retry response includes detail field", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-completestep-detail-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("expects validation retry response includes detail with the validation error", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Step with expects='STATUS: done' — output will fail validation
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'test-wf_planner', 0, '{{task}}', 'STATUS: done', 'running', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = completeStep(stepId, "missing status line");

    assert.equal(result.status, "retrying", "should retry when expects validation fails");
    assert.ok(result.detail, "retry response should include detail field");
    assert.ok(result.detail!.includes("STATUS: done"), `detail should mention the missing expects key, got: ${result.detail}`);

    // Verify the detail was also written to step.output
    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(stepId) as { output: string };
    assert.equal(step.output, result.detail, "step.output should match the detail field");
  });

  it("STORIES_JSON guard retry response includes detail with the guard reason", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix-merge', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Plan step (index 0, single) — the step being completed
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'bfm_planner', 0, 'Plan fix', '', 'running', 0, 3, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    // Fix step (index 1, loop over stories) — immediately next step
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'bfm_fixer', 1, 'Fix', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(fixStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete plan without STORIES_JSON — should trigger guard retry
    const result = completeStep(planStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: bugfix/x\nCHANGES: analyzed");

    assert.equal(result.status, "retrying", "should retry when STORIES_JSON guard fires");
    assert.ok(result.detail, "retry response should include detail field");
    assert.ok(result.detail!.includes("STORIES_JSON"), `detail should mention STORIES_JSON, got: ${result.detail}`);
    assert.ok(result.detail!.includes("fix"), `detail should mention the downstream step id, got: ${result.detail}`);

    // Verify the detail was also written to step.output
    const planStep = db.prepare("SELECT output FROM steps WHERE id = ?").get(planStepId) as { output: string };
    assert.equal(planStep.output, result.detail, "step.output should match the detail field");
  });

  it("success path does not include detail field", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Simple single step with no next loop step — success path
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'scan', 'test-wf_scanner', 0, 'Scan codebase', '', 'running', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = completeStep(stepId, "STATUS: done\nREPO: /tmp/repo\nCHANGES: scanned");

    assert.notEqual(result.status, "retrying", "success path should not retry");
    assert.notEqual(result.status, "failed", "success path should not fail");
    assert.equal(result.detail, undefined, "success path should not include detail field");
  });
});

describe("findProducerForMissingKey", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-find-producer-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  function setupTemplate(keys: string[]): string {
    const keyLines = keys.map((k) => `      ${k.toUpperCase()}: <value>`).join("\n");
    return `Task description.\n\n      Reply with:\n${keyLines}`;
  }

  it("returns the most recent upstream DONE step whose input template declares the missing key", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo", branch: "feature/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Setup step (index 0) declares BRANCH and REPO in Reply-with
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 1, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, setupTemplate(["STATUS", "BRANCH", "REPO", "ORIGINAL_BRANCH"]), now, now);

    // Plan step (index 1) also declares BRANCH (but setup is more recent)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'test-wf_planner', 1, ?, '', 'done', 0, 3, 'single', ?, ?)"
    ).run(planStepId, runId, setupTemplate(["STATUS", "BRANCH"]), now, now);

    // Looking for producer of 'branch' from the perspective of a step at index 2
    const result = findProducerForMissingKey(runId, 2, "branch");

    assert.ok(result !== null, "should find a producer for branch");
    assert.equal(result!.stepId, planStepId, "should return the plan step (index 1), which is the most recent DONE upstream step declaring branch");
    assert.equal(result!.stepIndex, 1);
    assert.equal(result!.retryCount, 0);
    assert.equal(result!.maxRetries, 3);
  });

  it("returns null when no upstream step declares the missing key", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo", branch: "feature/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Setup step declares only BRANCH and REPO
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, setupTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // none of the upstream steps declare 'nonexistent_key'
    const result = findProducerForMissingKey(runId, 1, "nonexistent_key");
    assert.equal(result, null, "should return null when no upstream step declares the key");
  });

  it("skips non-done upstream steps", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const runningStepId = crypto.randomUUID();
    const doneStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo", branch: "feature/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // A running step (index 0) that declares DEPLOY_TARGET — should be skipped
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'deploy-check', 'test-wf_deployer', 0, ?, '', 'running', 0, 4, 'single', ?, ?)"
    ).run(runningStepId, runId, setupTemplate(["STATUS", "DEPLOY_TARGET"]), now, now);

    // A done step (index 1) that also declares DEPLOY_TARGET — should be found
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 1, ?, '', 'done', 0, 4, 'single', ?, ?)"
    ).run(doneStepId, runId, setupTemplate(["STATUS", "DEPLOY_TARGET"]), now, now);

    const result = findProducerForMissingKey(runId, 2, "deploy_target");
    assert.ok(result !== null, "should skip the running step and find the done step");
    assert.equal(result!.stepId, doneStepId, "should return the done step, not the running one");
    assert.equal(result!.stepIndex, 1);
  });

  it("returns the step with correct retry counts", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Setup step at retry_count=2, max_retries=4
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 2, 4, 'single', ?, ?)"
    ).run(stepId, runId, setupTemplate(["STATUS", "BRANCH"]), now, now);

    const result = findProducerForMissingKey(runId, 1, "branch");
    assert.ok(result !== null);
    assert.equal(result!.retryCount, 2, "retryCount should be 2");
    assert.equal(result!.maxRetries, 4, "maxRetries should be 4");
  });

  it("returns null when there are no upstream steps at all", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo", branch: "feature/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // No steps inserted — there are no upstream steps at all
    const result = findProducerForMissingKey(runId, 0, "branch");
    assert.equal(result, null, "should return null when no upstream steps exist");
  });

  it("returns null when upstream done steps exist but none declare the key", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Setup declares only STATUS and REPO
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, setupTemplate(["STATUS", "REPO"]), now, now);

    // Plan declares only STATUS and CHANGES
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'test-wf_planner', 1, ?, '', 'done', 0, 4, 'single', ?, ?)"
    ).run(planStepId, runId, setupTemplate(["STATUS", "CHANGES"]), now, now);

    // No one declares 'branch'
    const result = findProducerForMissingKey(runId, 2, "branch");
    assert.equal(result, null, "should return null when upstream done steps exist but none declare the key");
  });

  it("is case-insensitive for the missing key lookup", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Setup declares ORIGINAL_BRANCH (which parseExpectedKeys lowercases to 'original_branch')
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, setupTemplate(["STATUS", "ORIGINAL_BRANCH"]), now, now);

    // Look up with uppercase — should still match (lowercased comparison)
    const result = findProducerForMissingKey(runId, 1, "ORIGINAL_BRANCH");
    assert.ok(result !== null, "should find producer even when search key is uppercase");
    assert.equal(result!.stepId, stepId);
  });

  it("returns the most recent upstream DONE step when multiple upstream steps declare the same key", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const step0Id = crypto.randomUUID();
    const step1Id = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo", branch: "feature/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Step at index 0 declares BRANCH
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 0, 4, 'single', ?, ?)"
    ).run(step0Id, runId, setupTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Step at index 1 also declares BRANCH (and is more recent)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'scan', 'test-wf_scanner', 1, ?, '', 'done', 1, 4, 'single', ?, ?)"
    ).run(step1Id, runId, setupTemplate(["STATUS", "BRANCH", "FINDINGS"]), now, now);

    // Looking from step at index 2 — should return the most recent (index 1)
    const result = findProducerForMissingKey(runId, 2, "branch");
    assert.ok(result !== null);
    assert.equal(result!.stepId, step1Id, "should return the step at index 1 (most recent)");
    assert.equal(result!.stepIndex, 1);
    assert.equal(result!.retryCount, 1);
  });
});

describe("claimStep missing-template-key blocking (US-003)", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-missingkey-block-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  function replyTemplate(keys: string[]): string {
    const keyLines = keys.map((k) => `      ${k.toUpperCase()}: <value>`).join("\n");
    return `Task description.\n\n      Reply with:\n${keyLines}`;
  }

  it("claimStep returns { found: false } when missing keys are detected — producer re-pend path", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const consumerStepId = crypto.randomUUID();
    const now = ts();

    // NOTE: repo is in seeded context but branch is NOT — so {{branch}} will be missing
    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): a DONE step whose Reply-with declares BRANCH and REPO
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo\nBRANCH: feature/x', 0, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO", "ORIGINAL_BRANCH"]), now, now);

    // Consumer (index 1): a PENDING step that needs {{branch}} and {{repo}}
    // The consumer needs {{branch}} but the producer's output only has REPO and BRANCH...
    // Actually, the producer's output IS "BRANCH: feature/x" which resolveStepContext will parse.
    // BUT the test needs to simulate that the producer's output is MISSING the key.
    // So producer output should NOT contain BRANCH: so {{branch}} is missing in context.
    db.prepare(
      "UPDATE steps SET output = ? WHERE id = ?"
    ).run("STATUS: done\nREPO: /tmp/repo", producerStepId);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 1, 'Fix {{task}} on branch {{branch}} in repo {{repo}}\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(consumerStepId, runId, now, now);

    // Claim the consumer step — should block because {{branch}} is missing
    const result = claimStep("test-wf_fixer", runId);

    assert.equal(result.found, false, "claimStep should return found: false when missing keys block dispatch");

    // Producer should be re-pended (status = 'pending')
    const producer = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(producerStepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(producer.status, "pending", "producer step should be re-pended");
    assert.equal(producer.retry_count, 1, "producer retry_count should be incremented");
    assert.ok(producer.output?.includes("Missing key"), `producer output should contain retry_feedback about missing keys, got: ${producer.output}`);
    assert.ok(producer.output?.includes("branch"), `producer output should name the missing key "branch", got: ${producer.output}`);

    // Consumer should be returned to pending (unclaimed)
    const consumer = db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerStepId) as { status: string };
    assert.equal(consumer.status, "pending", "consumer step should be reset to pending");

    // Run should still be running
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "run should still be running after producer re-pend");
  });

  it("claimStep fails run when no producer can be identified for a missing key", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Single step (index 0) with a template referencing {{nonexistent_key}}
    // No upstream DONE steps exist, so no producer can be found
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'scan', 'test-wf_scanner', 0, 'Scan with key {{nonexistent_key}}\
RETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = claimStep("test-wf_scanner", runId);

    assert.equal(result.found, false, "claimStep should return found: false when no producer and missing keys");

    // Step should be failed
    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as { status: string; output: string | null };
    assert.equal(step.status, "failed", "step should be marked failed");
    assert.ok(step.output?.includes("nonexistent_key"), `step output should name the missing key, got: ${step.output}`);
    assert.ok(step.output?.includes("no upstream DONE step"), `step output should explain no upstream DONE step, got: ${step.output}`);

    // Run should be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed when no producer found");
  });

  it("claimStep fails run when producer has exhausted retries", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const consumerStepId = crypto.randomUUID();
    const now = ts();

    // NOTE: branch is NOT in seeded context — so {{branch}} will be missing
    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE, but already at retry_count = max_retries (exhausted)
    // Its output is missing BRANCH so {{branch}} won't resolve
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo', 4, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Consumer (index 1): needs {{branch}}
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 1, 'Fix {{task}} on {{branch}}\
RETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(consumerStepId, runId, now, now);

    const result = claimStep("test-wf_fixer", runId);

    assert.equal(result.found, false, "claimStep should return found: false when producer retries exhausted");

    // Consumer should be failed
    const consumer = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(consumerStepId) as { status: string; output: string | null };
    assert.equal(consumer.status, "failed", "consumer step should be marked failed");
    assert.ok(consumer.output?.includes("producer retries are exhausted"), `consumer output should mention exhausted retries, got: ${consumer.output}`);
    assert.ok(consumer.output?.includes("branch"), `consumer output should name the missing key, got: ${consumer.output}`);

    // Run should be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed when producer retries exhausted");
  });

  it("claimStep works normally when no template keys are missing", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "bugfix/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Step with template that fully resolves from seeded context
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 0, 'Fix {{task}} in {{repo}} on branch {{branch}}\
RETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = claimStep("test-wf_fixer", runId);

    assert.equal(result.found, true, "claimStep should find step when no keys are missing");
    assert.ok(result.resolvedInput, "resolvedInput should be present");
    assert.ok(result.resolvedInput!.includes("fix bug"), `resolvedInput should include task, got: ${result.resolvedInput}`);
    assert.ok(result.resolvedInput!.includes("/tmp/repo"), `resolvedInput should include repo, got: ${result.resolvedInput}`);
    assert.ok(result.resolvedInput!.includes("bugfix/x"), `resolvedInput should include branch, got: ${result.resolvedInput}`);
    assert.ok(!result.resolvedInput!.includes("[missing:"), `resolvedInput should NOT contain [missing: key], got: ${result.resolvedInput}`);
  });

  it("special keys (retry_feedback, verify_feedback, timeout_retry) are never treated as missing", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    // Seeded context has NO retry_feedback, verify_feedback, timeout_retry
    // They should not be flagged as missing because claimStep populates them as ""
    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "bugfix/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Step template references all three special keys
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 0, 'Fix {{task}}\
RETRY FEEDBACK: {{retry_feedback}}\
VERIFY FEEDBACK: {{verify_feedback}}\
TIMEOUT RETRY: {{timeout_retry}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = claimStep("test-wf_fixer", runId);

    assert.equal(result.found, true, "claimStep should succeed — special keys are not treated as missing");
    assert.ok(result.resolvedInput!.includes("RETRY FEEDBACK:"), `resolvedInput should include retry_feedback section, got: ${result.resolvedInput}`);
    assert.ok(result.resolvedInput!.includes("VERIFY FEEDBACK:"), `resolvedInput should include verify_feedback section, got: ${result.resolvedInput}`);
    assert.ok(result.resolvedInput!.includes("TIMEOUT RETRY:"), `resolvedInput should include timeout_retry section, got: ${result.resolvedInput}`);
    assert.ok(!result.resolvedInput!.includes("[missing: retry_feedback]"), "retry_feedback should NOT appear as [missing:]");
    assert.ok(!result.resolvedInput!.includes("[missing: verify_feedback]"), "verify_feedback should NOT appear as [missing:]");
    assert.ok(!result.resolvedInput!.includes("[missing: timeout_retry]"), "timeout_retry should NOT appear as [missing:]");
  });

  it("re-pend path emits step.repended event", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const consumerStepId = crypto.randomUUID();
    const now = ts();

    // NOTE: branch is NOT in seeded context — so {{branch}} will be missing
    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE, Reply-with declares BRANCH, but output is missing BRANCH
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo', 0, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Consumer (index 1): needs {{branch}}
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 1, 'Fix {{task}} on {{branch}}\
RETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(consumerStepId, runId, now, now);

    claimStep("test-wf_fixer", runId);

    // Verify a step.repended event was emitted
    const events = getRunEvents(runId);
    const rependEvent = events.find((e: any) => e.event === "step.repended");
    assert.ok(rependEvent, "step.repended event should be emitted for producer re-pend");
    assert.ok(rependEvent.detail?.includes("branch"), `repend event should mention the missing key, got: ${rependEvent?.detail}`);
  });

  it("fail-fast path emits step.failed and run.failed events", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Step with unresolvable key, no upstream producer
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'scan', 'test-wf_scanner', 0, 'Scan with key {{unresolvable}}\
RETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    claimStep("test-wf_scanner", runId);

    // Verify step.failed and run.failed events were emitted
    const events = getRunEvents(runId);
    const stepFailedEvent = events.find((e: any) => e.event === "step.failed");
    const runFailedEvent = events.find((e: any) => e.event === "run.failed");
    assert.ok(stepFailedEvent, "step.failed event should be emitted on fail-fast");
    assert.ok(runFailedEvent, "run.failed event should be emitted on fail-fast");
    assert.ok(stepFailedEvent.detail?.includes("unresolvable"), `step.failed event should name the missing key, got: ${stepFailedEvent?.detail}`);
    assert.ok(stepFailedEvent.detail?.includes("no upstream DONE step"), `step.failed event should explain cause, got: ${stepFailedEvent?.detail}`);
  });

  it("boundedness: producer re-pend that itself has missing keys does not create infinite loop", async () => {
    // Simulate: setup -> fix chain where fix needs {{branch}} from setup.
    // Setup's output is missing BRANCH, so fix triggers re-pend of setup.
    // When setup is re-pended with retry_count=1, the next claim attempt for
    // fix should find setup was re-pended (retries incremented), and if fix
    // is claimed again without setup having produced the key, eventually
    // setup exhausts retries and the run fails — no infinite ping-pong.
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Setup (index 0): DONE but retry_count already at 3 (max_retries=4)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo', 3, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Fix (index 1): pending, needs {{branch}}
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 1, 'Fix {{task}} on {{branch}}\
RETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(fixStepId, runId, now, now);

    // First claim attempt — setup has retry_count=3 < max_retries=4, so it can be re-pended
    const result1 = claimStep("test-wf_fixer", runId);
    assert.equal(result1.found, false, "first claim should block");

    // Setup should now be re-pended with retry_count=4
    const setupAfter = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(setupStepId) as { status: string; retry_count: number };
    assert.equal(setupAfter.status, "pending", "setup should be re-pended on first block");
    assert.equal(setupAfter.retry_count, 4, "setup retry_count should be 4 after re-pend");

    // Simulate setup completing again (but still without BRANCH output)
    // Mark setup as DONE again, retry_count stays at 4
    db.prepare(
      "UPDATE steps SET status = 'done', output = 'STATUS: done\nREPO: /tmp/repo', updated_at = datetime('now') WHERE id = ?"
    ).run(setupStepId);

    // Second claim attempt for fix — setup retry_count=4 >= max_retries=4, should fail-fast
    const result2 = claimStep("test-wf_fixer", runId);
    assert.equal(result2.found, false, "second claim should also block (exhausted)");

    // Run should be failed now (producer exhausted)
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should fail when producer retries exhausted — no infinite ping-pong");

    // Consumer should be failed
    const consumer = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(fixStepId) as { status: string; output: string | null };
    assert.equal(consumer.status, "failed", "consumer should be failed when producer exhausted");
    assert.ok(consumer.output?.includes("producer retries are exhausted"), `consumer output should mention exhausted, got: ${consumer.output}`);
  });

  it("multiple missing keys from a single producer re-pend the producer once", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const consumerStepId = crypto.randomUUID();
    const now = ts();

    // NOTE: neither branch nor repo in seeded context — both will be missing from producer output
    const seededContext = JSON.stringify({ task: "implement feature" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE, Reply-with declares STATUS, BRANCH, REPO
    // Output is missing BRANCH and REPO — so both {{branch}} and {{repo}} will be missing
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 'STATUS: done', 0, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Consumer (index 1): needs both {{branch}} and {{repo}}
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 1, 'Fix {{task}} in {{repo}} on {{branch}}\
RETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(consumerStepId, runId, now, now);

    const result = claimStep("test-wf_fixer", runId);

    assert.equal(result.found, false, "claimStep should block");

    // Producer should be re-pended exactly once (retry_count incremented by 1)
    const producer = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(producerStepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(producer.status, "pending", "producer should be re-pended once");
    assert.equal(producer.retry_count, 1, "producer retry_count should be 1 (only incremented once)");
    assert.ok(producer.output?.includes("branch"), `retry_feedback should name branch, got: ${producer.output}`);
    assert.ok(producer.output?.includes("repo"), `retry_feedback should name repo, got: ${producer.output}`);
  });

  it("mixed resolvable and unresolvable keys: unresolvable key fails the run", async () => {
    // If some missing keys have producers and others don't, the unresolvable
    // keys should take precedence and fail the run immediately.
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const consumerStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE, declares BRANCH (so branch has a producer)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'test-wf_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo', 0, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH"]), now, now);

    // Consumer (index 1): needs {{branch}} (has producer) and {{unresolvable}} (no producer)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 1, 'Fix {{task}} on {{branch}} with {{unresolvable}}\
RETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(consumerStepId, runId, now, now);

    const result = claimStep("test-wf_fixer", runId);

    assert.equal(result.found, false, "claimStep should block");

    // Unresolvable key should cause fail-fast — not re-pend
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should fail when any key is unresolvable");

    // Consumer should be failed with message mentioning unresolvable
    const consumer = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(consumerStepId) as { status: string; output: string | null };
    assert.equal(consumer.status, "failed", "consumer should be failed");
    assert.ok(consumer.output?.includes("unresolvable"), `should mention unresolvable key, got: ${consumer.output}`);
    assert.ok(consumer.output?.includes("no upstream DONE step"), `should mention no upstream step, got: ${consumer.output}`);

    // Producer should NOT be re-pended (fail-fast takes priority)
    const producer = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(producerStepId) as { status: string; retry_count: number };
    assert.equal(producer.status, "done", "producer should stay done — fail-fast prevents re-pend");
    assert.equal(producer.retry_count, 0, "producer retry_count should not change");
  });
});

describe("claimStep missing-template-key blocking — loop claim path (US-004)", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-missingkey-loop-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  function replyTemplate(keys: string[]): string {
    const keyLines = keys.map((k) => `      ${k.toUpperCase()}: <value>`).join("\n");
    return `Task description.\n\n      Reply with:\n${keyLines}`;
  }

  async function seedStories(runId: string): Promise<void> {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const now = ts();
    const storyId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'Add feature', 'Implement the feature', ?, 'pending', 0, 4, ?, ?)"
    ).run(storyId, runId, JSON.stringify(["Feature works", "Typecheck passes"]), now, now);
  }

  it("loop path: producer re-pend when loop step template has a missing key", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    // branch is NOT in seeded context — {{branch}} will be missing
    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE step whose Reply-with declares BRANCH but output is missing BRANCH
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo', 0, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO", "ORIGINAL_BRANCH"]), now, now);

    // Loop step (index 1): needs {{branch}} (missing) and {{repo}} (present)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 1, 'Implement {{task}} on {{branch}}\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'loop', ?, ?, ?)"
    ).run(loopStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    await seedStories(runId);

    const result = claimStep("fdm_developer", runId);

    assert.equal(result.found, false, "loop claim should return found: false when missing keys block dispatch");

    // Producer should be re-pended
    const producer = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(producerStepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(producer.status, "pending", "producer step should be re-pended");
    assert.equal(producer.retry_count, 1, "producer retry_count should be incremented");
    assert.ok(producer.output?.includes("branch"), `producer retry_feedback should name missing key "branch", got: ${producer.output}`);

    // Loop step should be reset to pending
    const loopStep = db.prepare("SELECT status, current_story_id FROM steps WHERE id = ?").get(loopStepId) as { status: string; current_story_id: string | null };
    assert.equal(loopStep.status, "pending", "loop step should be reset to pending");
    assert.equal(loopStep.current_story_id, null, "current_story_id should be cleared");

    // Story should be unclaimed (back to pending)
    const stories = db.prepare("SELECT status FROM stories WHERE run_id = ?").all(runId) as { status: string }[];
    assert.equal(stories.length, 1);
    assert.equal(stories[0].status, "pending", "story should be unclaimed back to pending");

    // Run should still be running
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "run should still be running after producer re-pend");

    // step.repended event should be emitted
    const events = getRunEvents(runId);
    const rependEvent = events.find((e: any) => e.event === "step.repended");
    assert.ok(rependEvent, "step.repended event should be emitted for loop path producer re-pend");
    assert.ok(rependEvent.detail?.includes("branch"), `repend event should mention missing key, got: ${rependEvent?.detail}`);
  });

  it("loop path: fail-fast when no producer can be identified for a missing key", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Loop step (index 0): template has {{nonexistent_key}} — no upstream steps at all
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 0, 'Fix with key {{nonexistent_key}}\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'loop', ?, ?, ?)"
    ).run(loopStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    await seedStories(runId);

    const result = claimStep("test-wf_fixer", runId);

    assert.equal(result.found, false, "loop claim should return found: false when no producer");

    // Step should be failed
    const step = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(loopStepId) as { status: string; output: string | null };
    assert.equal(step.status, "failed", "loop step should be failed when no producer found");
    assert.ok(step.output?.includes("nonexistent_key"), `step output should name the missing key, got: ${step.output}`);
    assert.ok(step.output?.includes("no upstream DONE step"), `step output should explain cause, got: ${step.output}`);

    // Run should be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed when no producer found in loop path");

    // Events should be emitted
    const events = getRunEvents(runId);
    const stepFailedEvent = events.find((e: any) => e.event === "step.failed");
    const runFailedEvent = events.find((e: any) => e.event === "run.failed");
    assert.ok(stepFailedEvent, "step.failed event should be emitted");
    assert.ok(runFailedEvent, "run.failed event should be emitted");
  });

  it("loop path: fail-fast when producer has exhausted retries", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE, declares BRANCH, output missing BRANCH, already at retry_count = max_retries
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo', 4, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Loop step (index 1): needs {{branch}}
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 1, 'Implement {{task}} on {{branch}}\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'loop', ?, ?, ?)"
    ).run(loopStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    await seedStories(runId);

    const result = claimStep("fdm_developer", runId);

    assert.equal(result.found, false, "loop claim should return found: false when producer exhausted");

    // Loop step should be failed
    const consumer = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(loopStepId) as { status: string; output: string | null };
    assert.equal(consumer.status, "failed", "loop step should be failed when producer exhausted");
    assert.ok(consumer.output?.includes("producer retries are exhausted"), `output should mention exhausted, got: ${consumer.output}`);
    assert.ok(consumer.output?.includes("branch"), `output should name missing key, got: ${consumer.output}`);

    // Run should be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed when producer exhausted");
  });

  it("loop path: claimStep works normally when all template keys are present and stories exist", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo", branch: "feature/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Loop step (index 0): all keys are in seeded context
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 0, 'Implement {{task}} in {{repo}} on {{branch}}\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'loop', ?, ?, ?)"
    ).run(loopStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    await seedStories(runId);

    const result = claimStep("fdm_developer", runId);

    assert.equal(result.found, true, "loop claim should succeed when all keys are present");
    assert.ok(result.resolvedInput, "resolvedInput should be present");
    assert.ok(result.resolvedInput!.includes("implement feature"), `resolvedInput should include task, got: ${result.resolvedInput}`);
    assert.ok(result.resolvedInput!.includes("/tmp/repo"), `resolvedInput should include repo, got: ${result.resolvedInput}`);
    assert.ok(result.resolvedInput!.includes("feature/x"), `resolvedInput should include branch, got: ${result.resolvedInput}`);
    assert.ok(!result.resolvedInput!.includes("[missing:"), `resolvedInput should NOT contain [missing: key], got: ${result.resolvedInput}`);
    // Loop step claim also returns the resolvedInput — template keys resolved correctly
    assert.equal(result.runId, runId, "returned runId should match");
  });

  it("loop path: story context keys (current_story, current_story_id, etc.) are never treated as missing", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    // Seeded context has NO current_story, current_story_id, current_story_title, completed_stories, stories_remaining, progress, verify_feedback, timeout_retry
    // These are all populated by claimStep before findMissingTemplateKeys
    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo", branch: "feature/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Loop step template references ALL story context keys that claimStep populates
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 0, 'Story: {{current_story}}\nID: {{current_story_id}}\nTitle: {{current_story_title}}\nCompleted: {{completed_stories}}\nRemaining: {{stories_remaining}}\nRETRY FEEDBACK: {{retry_feedback}}\nVERIFY FEEDBACK: {{verify_feedback}}\nTIMEOUT RETRY: {{timeout_retry}}', '', 'pending', 0, 4, 'loop', ?, ?, ?)"
    ).run(loopStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    await seedStories(runId);

    const result = claimStep("fdm_developer", runId);

    assert.equal(result.found, true, "loop claim should succeed — story context keys are not treated as missing");
    assert.ok(!result.resolvedInput!.includes("[missing: current_story]"), "current_story should not be missing-key");
    assert.ok(!result.resolvedInput!.includes("[missing: current_story_id]"), "current_story_id should not be missing-key");
    assert.ok(!result.resolvedInput!.includes("[missing: current_story_title]"), "current_story_title should not be missing-key");
    assert.ok(!result.resolvedInput!.includes("[missing: completed_stories]"), "completed_stories should not be missing-key");
    assert.ok(!result.resolvedInput!.includes("[missing: stories_remaining]"), "stories_remaining should not be missing-key");
    assert.ok(!result.resolvedInput!.includes("[missing: retry_feedback]"), "retry_feedback should not be missing-key");
    assert.ok(!result.resolvedInput!.includes("[missing: verify_feedback]"), "verify_feedback should not be missing-key");
    assert.ok(!result.resolvedInput!.includes("[missing: timeout_retry]"), "timeout_retry should not be missing-key");
    assert.ok(result.resolvedInput!.includes("US-001"), "resolved input should contain story content");
  });

  it("loop path: boundedness — re-pend loop eventually exhausts producer retries, no infinite ping-pong", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE, declares BRANCH, output missing BRANCH, retry_count=3, max_retries=4
    // Only ONE re-pend remaining before exhaustion
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo', 3, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Loop step (index 1): needs {{branch}}
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 1, 'Implement {{task}} on {{branch}}\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'loop', ?, ?, ?)"
    ).run(loopStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    await seedStories(runId);

    // First claim attempt — producer has retries left (3 < 4), so it gets re-pended
    const result1 = claimStep("fdm_developer", runId);
    assert.equal(result1.found, false, "first loop claim should block");

    // Producer re-pended with retry_count=4
    const setupAfter = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(producerStepId) as { status: string; retry_count: number };
    assert.equal(setupAfter.status, "pending", "producer should be re-pended on first block");
    assert.equal(setupAfter.retry_count, 4, "producer retry_count should be 4 after re-pend");
    const runAfter1 = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(runAfter1.status, "running", "run should still be running after first claim");

    // Simulate setup completing again (still without BRANCH output)
    db.prepare(
      "UPDATE steps SET status = 'done', output = 'STATUS: done\nREPO: /tmp/repo', updated_at = datetime('now') WHERE id = ?"
    ).run(producerStepId);

    // Reset loop step back to pending for second attempt
    db.prepare(
      "UPDATE steps SET status = 'pending', current_story_id = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(loopStepId);

    // Re-seed a new story (the previous one was consumed)
    await seedStories(runId);

    // Second claim attempt — producer now at retry_count=4 >= max_retries=4, should fail-fast
    const result2 = claimStep("fdm_developer", runId);
    assert.equal(result2.found, false, "second loop claim should also block (exhausted)");

    // Run should be failed — no infinite ping-pong
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should fail when producer retries exhausted — no infinite ping-pong");

    // Loop step should be failed
    const consumer = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(loopStepId) as { status: string; output: string | null };
    assert.equal(consumer.status, "failed", "loop step should be failed when producer exhausted");
    assert.ok(consumer.output?.includes("producer retries are exhausted"), `output should mention exhausted, got: ${consumer.output}`);
  });

  it("loop path: multiple missing keys from a single producer only re-pend the producer once", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    // Neither branch nor repo in seeded context
    const seededContext = JSON.stringify({ task: "implement feature" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE, declares BRANCH and REPO, but output missing both
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, ?, '', 'done', 'STATUS: done', 0, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Loop step (index 1): needs both {{branch}} and {{repo}}
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 1, 'Implement {{task}} in {{repo}} on {{branch}}\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'loop', ?, ?, ?)"
    ).run(loopStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    await seedStories(runId);

    const result = claimStep("fdm_developer", runId);

    assert.equal(result.found, false, "loop claim should block");

    // Producer should be re-pended exactly once
    const producer = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(producerStepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(producer.status, "pending", "producer should be re-pended once");
    assert.equal(producer.retry_count, 1, "producer retry_count should be 1 (only incremented once)");
    assert.ok(producer.output?.includes("branch"), `retry_feedback should name branch, got: ${producer.output}`);
    assert.ok(producer.output?.includes("repo"), `retry_feedback should name repo, got: ${producer.output}`);
  });

describe("RETR: rerouteStep and failStep exhaustion reroute", () => {
  let _savedStateDir: string | undefined;
  let _savedDbPath: string | undefined;
  let _testIsolationDir: string;
  let workflowsDir: string;

  // Simple two-step workflow: produce(upstream) -> consume(downstream)
  // consume declares on_fail.retry_step: produce
  const retryWorkflowYaml = `
id: test-reroute
agents:
  - id: producer
    workspace:
      baseDir: .
      files: {}
  - id: consumer
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: producer
    input: "Produce output"
    expects: "STATUS: done"
    max_retries: 3
  - id: consume
    agent: consumer
    input: "Consume {{output}}"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: produce
`;

  // Same workflow but consume targets a downstream step (spec error)
  const downstreamTargetYaml = `
id: test-reroute-downstream
agents:
  - id: prod1
    workspace:
      baseDir: .
      files: {}
  - id: prod2
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: prod1
    input: "Produce"
    expects: "STATUS: done"
    max_retries: 3
  - id: waiting
    agent: prod2
    input: "Wait"
    expects: "STATUS: done"
    max_retries: 3
    on_fail:
      retry_step: later
  - id: later
    agent: prod2
    input: "Later"
    expects: "STATUS: done"
    max_retries: 3
`;

  // Same workflow but consume targets an unknown step (spec error)
  const unknownTargetYaml = `
id: test-reroute-unknown
agents:
  - id: a1
    workspace:
      baseDir: .
      files: {}
steps:
  - id: step1
    agent: a1
    input: "Step 1"
    expects: "STATUS: done"
    max_retries: 3
    on_fail:
      retry_step: nonexistent
`;

  // Workflow for escalation testing: no retry_step, escalate_to to pager
  const escalationWorkflowYaml = `
id: test-reroute-escalate
agents:
  - id: prod
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: prod
    input: "Produce output"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      escalate_to: agent:main:main
`;

  // Workflow with explicit max_reroutes: 3 (custom budget)
  const maxReroutes3Yaml = `
id: test-reroute-max3
agents:
  - id: producer
    workspace:
      baseDir: .
      files: {}
  - id: consumer
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: producer
    input: "Produce output"
    expects: "STATUS: done"
    max_retries: 3
  - id: consume
    agent: consumer
    input: "Consume {{output}}"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: produce
      max_reroutes: 3
`;

  before(async () => {
    // Save outer env vars at hook runtime, not at module load time.
    // This matters when nested inside an outer describe that sets isolation.
    _savedStateDir = process.env.TAMANDUA_STATE_DIR;
    _savedDbPath = process.env.TAMANDUA_DB_PATH;
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-retr-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");

    // Create workflow dirs with the test workflows
    workflowsDir = path.join(_testIsolationDir, "workflows");
    const retryDir = path.join(workflowsDir, "test-reroute");
    const downstreamDir = path.join(workflowsDir, "test-reroute-downstream");
    const unknownDir = path.join(workflowsDir, "test-reroute-unknown");
    const max3Dir = path.join(workflowsDir, "test-reroute-max3");
    fs.mkdirSync(retryDir, { recursive: true });
    fs.mkdirSync(downstreamDir, { recursive: true });
    fs.mkdirSync(unknownDir, { recursive: true });
    const escalateDir = path.join(workflowsDir, "test-reroute-escalate");
    fs.mkdirSync(max3Dir, { recursive: true });
    fs.mkdirSync(escalateDir, { recursive: true });
    fs.writeFileSync(path.join(retryDir, "workflow.yml"), retryWorkflowYaml);
    fs.writeFileSync(path.join(downstreamDir, "workflow.yml"), downstreamTargetYaml);
    fs.writeFileSync(path.join(unknownDir, "workflow.yml"), unknownTargetYaml);
    fs.writeFileSync(path.join(max3Dir, "workflow.yml"), maxReroutes3Yaml);
    fs.writeFileSync(path.join(escalateDir, "workflow.yml"), escalationWorkflowYaml);
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  function insertRunAndSteps(
    db: ReturnType<typeof getTestDb>,
    workflowId: string,
    stepsData: Array<{
      step_id: string;
      agent_id: string;
      step_index: number;
      status: string;
      retry_count: number;
      max_retries: number;
      input_template: string;
      expects: string;
      type?: string;
      output?: string;
    }>,
  ): { runId: string; stepRows: Array<{ rowId: string; step_id: string }> } {
    const runId = crypto.randomUUID();
    const now = ts();
    const seededContext = JSON.stringify({ task: "test task", repo: "/tmp/repo", branch: "test-branch" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, ?, 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, workflowId, seededContext, now, now);

    const stepRows: Array<{ rowId: string; step_id: string }> = [];
    for (const sd of stepsData) {
      const rowId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, output, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        rowId, runId, sd.step_id, sd.agent_id, sd.step_index, sd.input_template,
        sd.expects, sd.status, sd.retry_count, sd.max_retries,
        sd.type ?? "single", sd.output ?? null, now, now,
      );
      stepRows.push({ rowId, step_id: sd.step_id });
    }

    return { runId, stepRows };
  }

  // Dynamic import helper
  async function getTestDb() {
    return (await import("../dist/db.js")).getDb();
  }

  it("reroute on failStep exhaustion: valid upstream retry_step triggers reroute instead of run failure", async () => {
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce output\nReply with:\nSTATUS: done", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: some-value" },
      // Consumer at retry_count = max_retries, so next failStep triggers exhaustion
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume {{output}}", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
    const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

    const result = await failStep(consumerRowId, "Consumer failed: invalid output format");

    assert.equal(result.status, "rerouted", "failStep should return rerouted status");

    // Run should still be running
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "run should still be running after reroute");

    // Producer should be re-pended (status=pending)
    const producer = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(producerRowId) as { status: string; retry_count: number; output: string | null };
    assert.equal(producer.status, "pending", "producer should be re-pended to pending");
    assert.equal(producer.retry_count, 0, "producer retry_count should be UNCHANGED (0)");
    assert.ok(producer.output?.includes("Reroute from"), `producer output should contain reroute feedback, got: ${producer.output}`);
    assert.ok(producer.output?.includes("consume"), `producer output should name the consumer step, got: ${producer.output}`);
    assert.ok(producer.output?.includes("invalid output format"), `producer output should include failure reason, got: ${producer.output}`);

    // Consumer should be reset to waiting with retry_count=0
    const consumer = db.prepare("SELECT status, retry_count, reroute_count, output FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number; reroute_count: number | null; output: string | null };
    assert.equal(consumer.status, "waiting", "consumer should be reset to waiting");
    assert.equal(consumer.retry_count, 0, "consumer retry_count should be reset to 0");
    assert.equal(consumer.reroute_count, 1, "consumer reroute_count should be incremented to 1");
    assert.equal(consumer.output, null, "consumer output should be cleared");
  });

  it("producer receives retry_feedback accessible via claimStep", async () => {
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce output\nRETRY FEEDBACK: {{retry_feedback}}\nReply with:\nSTATUS: done", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: some-value" },
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume {{output}}", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
    const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

    const failResult = await failStep(consumerRowId, "Consumer failed: bad output");
    assert.equal(failResult.status, "rerouted");

    // Producer is now pending — claimStep should surface retry_feedback
    const claimResult = claimStep("producer", runId);
    assert.ok(claimResult.found, "claimStep should find the pending producer");
    assert.equal(claimResult.stepId, producerRowId);
    assert.ok(claimResult.resolvedInput!.includes("Reroute from"), `resolved input should contain reroute feedback, got: ${claimResult.resolvedInput}`);
    assert.ok(claimResult.resolvedInput!.includes("consume"), `resolved input should name consumer, got: ${claimResult.resolvedInput}`);
  });

  it("reroute preserves intermediate done steps between producer and consumer", async () => {
    // Use a 3-step workflow: produce (idx 0) -> middle (idx 1) -> consume (idx 2)
    // consume retry_step -> produce; middle is done and should stay done
    const threeStepYaml = `
id: test-reroute-three
agents:
  - id: a1
    workspace:
      baseDir: .
      files: {}
  - id: a2
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: a1
    input: "Produce"
    expects: "STATUS: done"
    max_retries: 3
  - id: middle
    agent: a2
    input: "Middle"
    expects: "STATUS: done"
    max_retries: 3
  - id: consume
    agent: a2
    input: "Consume"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: produce
`;
    const threeDir = path.join(workflowsDir, "test-reroute-three");
    fs.mkdirSync(threeDir, { recursive: true });
    fs.writeFileSync(path.join(threeDir, "workflow.yml"), threeStepYaml);

    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-three", [
      { step_id: "produce", agent_id: "a1", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: val" },
      { step_id: "middle", agent_id: "a2", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Middle", expects: "STATUS: done", output: "STATUS: done\nMIDDLE: ok" },
      { step_id: "consume", agent_id: "a2", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
    const middleRowId = stepRows.find(s => s.step_id === "middle")!.rowId;

    const result = await failStep(consumerRowId, "Consumer failed");
    assert.equal(result.status, "rerouted");

    // Middle step must be untouched (still done)
    const middle = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(middleRowId) as { status: string; retry_count: number };
    assert.equal(middle.status, "done", "intermediate done step should stay done");
    assert.equal(middle.retry_count, 0, "intermediate step retry_count should not change");
  });

  it("advancePipeline re-pends consumer after producer completes (via pipeline advancement)", async () => {
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce output\nReply with:\nSTATUS: done", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: val" },
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume {{output}}", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
    const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

    // 1. Trigger reroute
    const failResult = await failStep(consumerRowId, "Consumer failed");
    assert.equal(failResult.status, "rerouted");

    // 2. Consumer is now waiting; producer is pending
    const consumerAfter = db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string };
    assert.equal(consumerAfter.status, "waiting");

    const producerAfter = db.prepare("SELECT status FROM steps WHERE id = ?").get(producerRowId) as { status: string };
    assert.equal(producerAfter.status, "pending");

    // 3. Complete the producer step
    db.prepare(
      "UPDATE steps SET status = 'done', output = 'STATUS: done\nNEW: value', updated_at = datetime('now') WHERE id = ?"
    ).run(producerRowId);

    // 4. Call advancePipeline — it should make consumer pending since producer is done
    const advanceResult = advancePipeline(runId);
    assert.equal(advanceResult.advanced, true, "advancePipeline should advance to consumer");

    const consumerAfterAdvance = db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string };
    assert.equal(consumerAfterAdvance.status, "pending", "consumer should be pending after pipeline advance");
  });

  it("downstream retry_step target is rejected (invalid_target) and run fails", async () => {
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-downstream", [
      { step_id: "produce", agent_id: "prod1", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
      // waiting step targets 'later' which has step_index 2 > 1 — downstream!
      { step_id: "waiting", agent_id: "prod2", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Wait", expects: "STATUS: done" },
      { step_id: "later", agent_id: "prod2", step_index: 2, status: "waiting", retry_count: 0, max_retries: 3, input_template: "Later", expects: "STATUS: done" },
    ]);

    const waitingRowId = stepRows.find(s => s.step_id === "waiting")!.rowId;

    const result = await failStep(waitingRowId, "Waiting step failed");

    assert.equal(result.status, "failed", "should fail the run on invalid retry_step target");

    // Run should be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");

    // Error message should mention invalid target
    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(waitingRowId) as { output: string | null };
    assert.ok(step.output?.includes("not a valid upstream step"), `error should mention invalid upstream step, got: ${step.output}`);
  });

  it("unknown retry_step target is rejected (invalid_target) and run fails", async () => {
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-unknown", [
      { step_id: "step1", agent_id: "a1", step_index: 0, status: "running", retry_count: 2, max_retries: 2, input_template: "Step 1", expects: "STATUS: done" },
    ]);

    const step1RowId = stepRows.find(s => s.step_id === "step1")!.rowId;

    const result = await failStep(step1RowId, "Step 1 failed");

    assert.equal(result.status, "failed", "should fail the run on unknown retry_step target");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");

    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(step1RowId) as { output: string | null };
    assert.ok(step.output?.includes("not a valid upstream step"), `error should mention invalid upstream step, got: ${step.output}`);
  });

  it("no reroute when on_fail.retry_step is not declared — normal run failure", async () => {
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      // Use produce step which does NOT have retry_step declared (consume does)
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "running", retry_count: 3, max_retries: 3, input_template: "Produce", expects: "STATUS: done" },
    ]);

    const produceRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

    const result = await failStep(produceRowId, "Produce failed");

    assert.equal(result.status, "failed", "should fail normally when no retry_step declared");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });

  it("step.rerouted event is emitted on reroute", async () => {
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

    const result = await failStep(consumerRowId, "Consumer failure reason here");
    assert.equal(result.status, "rerouted");

    // Check events
    const events = getRunEvents(runId);
    const reroutedEvents = events.filter(e => e.event === "step.rerouted");
    assert.equal(reroutedEvents.length, 1, "should have exactly one step.rerouted event");

    const rerouted = reroutedEvents[0];
    assert.equal(rerouted.stepId, "consume", "event stepId should be the consumer");
    assert.ok(rerouted.detail?.includes("produce"), `event detail should name target produce, got: ${rerouted.detail}`);
    assert.ok(rerouted.detail?.includes("1/2"), `event detail should include reroute count, got: ${rerouted.detail}`);
    assert.ok(rerouted.detail?.includes("Consumer failure reason here"), `event detail should include failure reason, got: ${rerouted.detail}`);

    // No run.failed event should exist
    const failedEvents = events.filter(e => e.event === "run.failed");
    assert.equal(failedEvents.length, 0, "should have no run.failed event after reroute");
  });

  it("reroute boundedness: reroute_count=2 with max_reroutes=2 exhausts and falls through to run failure", async () => {
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
      // Consumer at retry exhaustion with 2 prior reroutes (budget=2, so exhausted)
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

    // Manually set reroute_count=2 — budget is 2, so next attempt should be blocked
    db.prepare("UPDATE steps SET reroute_count = 2 WHERE id = ?").run(consumerRowId);

    const result = await failStep(consumerRowId, "Consumer failed again");

    // Budget exhausted — should fail the run
    assert.equal(result.status, "failed", "should fail when reroute budget exhausted");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed after budget exhaustion");

    // Prove ping-pong terminates after bounded reroutes
    const consumer = db.prepare("SELECT reroute_count, status FROM steps WHERE id = ?").get(consumerRowId) as { reroute_count: number; status: string };
    assert.equal(consumer.reroute_count, 2, "reroute_count should remain 2 — no increment on budget exhaustion");
    assert.equal(consumer.status, "failed", "step should be failed");
  });

  it("ping-pong boundedness: full reroute loop terminates after max_reroutes iterations (max_reroutes=3)", async () => {
    // This test simulates a ping-pong scenario:
    // producer succeeds → consumer fails → reroute to producer → repeat
    // After max_reroutes=3 reroutes, the 4th failure exhausts the budget → run fails.
    // Producer retry_count is verified unchanged across all reroutes.
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-max3", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
      // Consumer at retry exhaustion (retry_count=2, max_retries=2)
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
    const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

    // Track producer retry_count at start
    const producerStart = db.prepare("SELECT retry_count FROM steps WHERE id = ?").get(producerRowId) as { retry_count: number };
    assert.equal(producerStart.retry_count, 0, "producer starts with retry_count=0");

    // Iteration 1: reroute (reroute_count becomes 1)
    let result = await failStep(consumerRowId, "Consumer failure #1");
    assert.equal(result.status, "rerouted", "iteration 1: should reroute");
    let reroutes = (db.prepare("SELECT reroute_count FROM steps WHERE id = ?").get(consumerRowId) as { reroute_count: number }).reroute_count;
    assert.equal(reroutes, 1, "iteration 1: reroute_count=1");
    // Producer retry_count unchanged
    let prodRetry = (db.prepare("SELECT retry_count FROM steps WHERE id = ?").get(producerRowId) as { retry_count: number }).retry_count;
    assert.equal(prodRetry, 0, "iteration 1: producer retry_count unchanged");

    // Simulate producer re-done + pipeline advance + consumer claimed → running again
    db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done\nFIX: v2', updated_at = datetime('now') WHERE id = ?").run(producerRowId);
    advancePipeline(runId);
    db.prepare("UPDATE steps SET status = 'running', retry_count = 2, updated_at = datetime('now') WHERE id = ?").run(consumerRowId);

    // Iteration 2: reroute (reroute_count becomes 2)
    result = await failStep(consumerRowId, "Consumer failure #2");
    assert.equal(result.status, "rerouted", "iteration 2: should reroute");
    reroutes = (db.prepare("SELECT reroute_count FROM steps WHERE id = ?").get(consumerRowId) as { reroute_count: number }).reroute_count;
    assert.equal(reroutes, 2, "iteration 2: reroute_count=2");
    prodRetry = (db.prepare("SELECT retry_count FROM steps WHERE id = ?").get(producerRowId) as { retry_count: number }).retry_count;
    assert.equal(prodRetry, 0, "iteration 2: producer retry_count unchanged");

    // Reset again for iteration 3
    db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done\nFIX: v3', updated_at = datetime('now') WHERE id = ?").run(producerRowId);
    advancePipeline(runId);
    db.prepare("UPDATE steps SET status = 'running', retry_count = 2, updated_at = datetime('now') WHERE id = ?").run(consumerRowId);

    // Iteration 3: reroute (reroute_count becomes 3 — still within budget of 3)
    result = await failStep(consumerRowId, "Consumer failure #3");
    assert.equal(result.status, "rerouted", "iteration 3: should reroute (reroute_count=3, budget=3)");
    reroutes = (db.prepare("SELECT reroute_count FROM steps WHERE id = ?").get(consumerRowId) as { reroute_count: number }).reroute_count;
    assert.equal(reroutes, 3, "iteration 3: reroute_count=3");
    prodRetry = (db.prepare("SELECT retry_count FROM steps WHERE id = ?").get(producerRowId) as { retry_count: number }).retry_count;
    assert.equal(prodRetry, 0, "iteration 3: producer retry_count still unchanged");

    // Reset for iteration 4
    db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done\nFIX: v4', updated_at = datetime('now') WHERE id = ?").run(producerRowId);
    advancePipeline(runId);
    db.prepare("UPDATE steps SET status = 'running', retry_count = 2, updated_at = datetime('now') WHERE id = ?").run(consumerRowId);

    // Iteration 4: budget exhausted (reroute_count=3 >= max_reroutes=3) → run fails
    result = await failStep(consumerRowId, "Consumer failure #4");
    assert.equal(result.status, "failed", "iteration 4: should fail (budget exhausted)");

    // Verify run is failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed after reroute budget exhaustion");

    // Verify consumer step is failed, reroute_count still 3
    const consumer = db.prepare("SELECT reroute_count, status, retry_count FROM steps WHERE id = ?").get(consumerRowId) as { reroute_count: number; status: string; retry_count: number };
    assert.equal(consumer.reroute_count, 3, "reroute_count should remain 3 — no increment on budget exhaustion");
    assert.equal(consumer.status, "failed", "consumer should be failed");

    // Producer retry_count still 0 after all reroutes
    prodRetry = (db.prepare("SELECT retry_count FROM steps WHERE id = ?").get(producerRowId) as { retry_count: number }).retry_count;
    assert.equal(prodRetry, 0, "producer retry_count unchanged across all reroutes (reroute budget is separate)");

    // Run terminal event should exist
    const events = getRunEvents(runId);
    const runFailedEvents = events.filter(e => e.event === "run.failed");
    assert.ok(runFailedEvents.length > 0, "should have run.failed event after budget exhaustion");

    // step.rerouted events should have been emitted for all 3 reroutes
    const reroutedEvents = events.filter(e => e.event === "step.rerouted");
    assert.equal(reroutedEvents.length, 3, "should have 3 step.rerouted events");
  });

  // ── US-005: event emission tests ──

  it("step.reroute_budget_exhausted event is emitted when reroute budget is exhausted", async () => {
    // When a step exhausts its retries AND reroute budget is already at max,
    // step.reroute_budget_exhausted should be emitted before the run fails.
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
      // Consumer at retry exhaustion with reroute_count already at budget (2/2)
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

    // Manually set reroute_count=2 — budget (default 2) is exhausted
    db.prepare("UPDATE steps SET reroute_count = 2 WHERE id = ?").run(consumerRowId);

    const result = await failStep(consumerRowId, "Consumer failed after all reroutes");
    assert.equal(result.status, "failed", "should fail when reroute budget exhausted");

    // Check events
    const events = getRunEvents(runId);
    const budgetExhaustedEvents = events.filter(e => e.event === "step.reroute_budget_exhausted");
    assert.equal(budgetExhaustedEvents.length, 1, "should have exactly one step.reroute_budget_exhausted event");

    const exhausted = budgetExhaustedEvents[0];
    assert.equal(exhausted.stepId, "consume", "event stepId should be the consumer");
    assert.ok(exhausted.detail?.includes("Reroute budget exhausted"), `event detail should mention budget exhausted, got: ${exhausted.detail}`);
    assert.ok(exhausted.detail?.includes("2/2"), `event detail should include reroute count/budget, got: ${exhausted.detail}`);
    assert.ok(exhausted.detail?.includes("produce"), `event detail should name target step, got: ${exhausted.detail}`);

    // step.retries exhausted event should also fire
    const failedEvents = events.filter(e => e.event === "step.failed");
    assert.equal(failedEvents.length, 1, "should have step.failed event");

    // run.failed event should fire
    const runFailedEvents = events.filter(e => e.event === "run.failed");
    assert.equal(runFailedEvents.length, 1, "should have run.failed event after budget exhaustion");
  });

  it("step.escalation event is emitted when escalate_to is configured", async () => {
    // When a step exhausts its retries AND escalate_to is configured,
    // a step.escalation event should be emitted (log-only behavior preserved).
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-escalate", [
      // Step at retry exhaustion (retry_count=2, max_retries=2), no retry_step so no reroute
      { step_id: "produce", agent_id: "prod", step_index: 0, status: "running", retry_count: 2, max_retries: 2, input_template: "Produce output", expects: "STATUS: done" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

    const result = await failStep(consumerRowId, "Step exhausted retries");
    assert.equal(result.status, "failed", "should fail when retries exhausted and no retry_step");

    // Check events
    const events = getRunEvents(runId);
    const escalationEvents = events.filter(e => e.event === "step.escalation");
    assert.equal(escalationEvents.length, 1, "should have exactly one step.escalation event");

    const escalation = escalationEvents[0];
    assert.equal(escalation.stepId, "produce", "event stepId should be the failing step");
    assert.equal(escalation.runId, runId, "event should have correct runId");
    assert.ok(escalation.detail?.includes("Escalation target"), `event detail should mention escalation target, got: ${escalation.detail}`);
    assert.ok(escalation.detail?.includes("agent:main:main"), `event detail should include target, got: ${escalation.detail}`);
    assert.ok(escalation.detail?.includes("Step exhausted retries"), `event detail should include reason, got: ${escalation.detail}`);

    // step.failed and run.failed events should still fire
    const failedEvents = events.filter(e => e.event === "step.failed");
    assert.equal(failedEvents.length, 1, "step.failed should still be emitted");
    const runFailedEvents = events.filter(e => e.event === "run.failed");
    assert.equal(runFailedEvents.length, 1, "run.failed should still be emitted");
  });

  it("resolveMissingKeys is unchanged — pre-execution path still works", async () => {
    // This test proves resolveMissingKeys is unaffected by the RETR implementation.
    // It blocks based on missing template keys (pre-execution), not post-execution failure.
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const consumerStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "test" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix', 'test', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer declares BRANCH
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'triage', 'bf_triage', 0, ?, '', 'done', 'STATUS: done\nBRANCH: some-branch', 0, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH", "REPO"]), now, now);

    // Consumer needs {{branch}}
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 1, 'Fix in {{branch}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(consumerStepId, runId, now, now);

    // claimStep should resolve normally since {{branch}} is available
    const result = claimStep("bf_fixer", runId);
    assert.ok(result.found, "claimStep should find the step");

    // reset for second test
    db.prepare("UPDATE steps SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(consumerStepId);

    // Now remove {{branch}} from context and producer output — should trigger resolveMissingKeys block
    db.prepare("UPDATE steps SET output = 'STATUS: done' WHERE id = ?").run(producerStepId);
    const result2 = claimStep("bf_fixer", runId);
    assert.equal(result2.found, false, "claimStep should block when branch key is missing with no producer");

    // The resolveMissingKeys pre-execution path is still intact — run may fail or producer re-pends
    // depending on whether a producer declares the missing key. This verifies the path is not broken.
  });

  it("loop step story-level retry is unaffected by RETR — verify_each machinery untouched", async () => {
    // Loop steps with current_story_id use per-story retry, not step-level retry.
    // RETR must not interfere with this path.
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo", branch: "feature/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Loop step with current_story_id (mid-iteration)
    const storyId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'S1', 'Test', 'desc', '[]', 'running', 0, 3, ?, ?)"
    ).run(storyId, runId, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, current_story_id, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix', '', 'running', 0, 4, 'loop', ?, ?, ?, ?)"
    ).run(loopStepId, runId, storyId, JSON.stringify({ over: "stories" }), now, now);

    // failStep on loop step — should use per-story retry, NOT step-level retry or reroute
    const result = await failStep(loopStepId, "Story failed");

    // Story-level retry should kick in (retry if below max_retries)
    const story = db.prepare("SELECT status, retry_count FROM stories WHERE id = ?").get(storyId) as { status: string; retry_count: number };
    assert.equal(story.status, "pending", "story should be re-pended (not failed)");
    assert.equal(story.retry_count, 1, "story retry_count should be 1");

    // Loop step should be pending
    const loop = db.prepare("SELECT status, current_story_id FROM steps WHERE id = ?").get(loopStepId) as { status: string; current_story_id: string | null };
    assert.equal(loop.status, "pending");
    assert.equal(loop.current_story_id, null, "current_story_id should be cleared");

    // Run should still be running
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "run should still be running");
  });

  // ── US-003: completeStep expects-validation exhaustion reroute ──

  it("completeStep expects-validation exhaustion triggers reroute to retry_step", async () => {
    // When expects validation fails AND step retries are exhausted,
    // on_fail.retry_step should trigger a reroute to the upstream producer
    // instead of killing the run.
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce output", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: some-value" },
      // Consumer at retry_count = max_retries, so next expects failure triggers exhaustion
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume {{output}}", expects: "STATUS: done", type: "single" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
    const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

    // completeStep with invalid output → expects validation fails → retries exhausted
    const result = completeStep(consumerRowId, "missing status line");

    assert.equal(result.status, "rerouted", "completeStep should return rerouted status, got: " + JSON.stringify(result));

    // Run should still be running
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "run should still be running after expects-validation reroute");

    // Producer should be re-pended
    const producer = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(producerRowId) as { status: string; retry_count: number; output: string | null };
    assert.equal(producer.status, "pending", "producer should be re-pended to pending");
    assert.equal(producer.retry_count, 0, "producer retry_count should be unchanged");
    assert.ok(producer.output?.includes("Reroute from"), `producer output should contain reroute feedback, got: ${producer.output}`);
    assert.ok(producer.output?.includes("consume"), `producer output should name consumer, got: ${producer.output}`);

    // Consumer should be reset to waiting with retry_count=0
    const consumer = db.prepare("SELECT status, retry_count, reroute_count, output FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number; reroute_count: number | null; output: string | null };
    assert.equal(consumer.status, "waiting", "consumer should be reset to waiting");
    assert.equal(consumer.retry_count, 0, "consumer retry_count should be 0");
    assert.equal(consumer.reroute_count, 1, "consumer reroute_count should be 1");
    assert.equal(consumer.output, null, "consumer output should be cleared");

    // step.rerouted event should be emitted
    const events = getRunEvents(runId);
    const rerouteEvents = events.filter(e => e.event === "step.rerouted");
    assert.ok(rerouteEvents.length >= 1, `Expected at least 1 step.rerouted event, got ${rerouteEvents.length}`);
    const re = rerouteEvents[0];
    assert.equal(re.runId, runId);
    assert.equal(re.stepId, "consume");
    assert.ok((re as any).detail.includes("produce"), `event detail should mention target step, got: ${(re as any).detail}`);
  });

  it("completeStep expects-validation exhaustion falls through to run failure when budget exhausted", async () => {
    // When expects validation fails AND step retries are exhausted AND
    // reroute budget is already exhausted, the run should fail normally.
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce output", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: some-value" },
      // Consumer at retry_count = max_retries, reroute_count already at budget (2)
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume {{output}}", expects: "STATUS: done", type: "single" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

    // Manually set reroute_count to 2 (budget exhausted)
    db.prepare("UPDATE steps SET reroute_count = 2 WHERE id = ?").run(consumerRowId);

    const result = completeStep(consumerRowId, "missing status line");

    assert.equal(result.status, "failed", "completeStep should return failed when reroute budget exhausted, got: " + JSON.stringify(result));

    // Run should be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed when reroute budget exhausted");

    // Consumer should be failed
    const consumer = db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string };
    assert.equal(consumer.status, "failed", "consumer should be failed");
  });

  // ── US-003: orphan-recovery exhaustion reroute ──

  it("orphan-recovery exhaustion triggers reroute to retry_step", async () => {
    // When orphan recovery finds a step with exhausted retries AND
    // on_fail.retry_step is declared, it should reroute instead of failing.
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce output", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: some-value" },
      // Consumer agent: retry_count == max_retries, running (orphaned)
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume {{output}}", expects: "STATUS: done", type: "single" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
    const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

    // Simulate orphan recovery: consumer agent's running step has exhausted retries
    const result = recoverOrphanedStepsForAgent("consumer", runId);

    // The step should NOT be counted as failed — it was rerouted
    assert.equal(result.failed, 0, `no steps should be failed (rerouted instead), got failed=${result.failed}`);
    assert.equal(result.recovered, 1, `one step should be recovered (rerouted), got recovered=${result.recovered}`);

    // Run should still be running
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "run should still be running after orphan-recovery reroute");

    // Producer should be re-pended
    const producer = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(producerRowId) as { status: string; retry_count: number; output: string | null };
    assert.equal(producer.status, "pending", "producer should be re-pended to pending");
    assert.equal(producer.retry_count, 0, "producer retry_count should be unchanged");
    assert.ok(producer.output?.includes("Reroute from"), `producer output should contain reroute feedback, got: ${producer.output}`);

    // Consumer should be reset to waiting with retry_count=0
    const consumer = db.prepare("SELECT status, retry_count, reroute_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number; reroute_count: number | null };
    assert.equal(consumer.status, "waiting", "consumer should be reset to waiting");
    assert.equal(consumer.retry_count, 0, "consumer retry_count should be 0");
    assert.equal(consumer.reroute_count, 1, "consumer reroute_count should be 1");
  });

  it("orphan-recovery exhaustion falls through to run failure when budget exhausted", async () => {
    // When orphan recovery finds a step with exhausted retries AND
    // reroute budget is already exhausted, the run should fail.
    const db = await getTestDb();
    const { runId, stepRows } = insertRunAndSteps(db, "test-reroute", [
      { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce output", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: some-value" },
      { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume {{output}}", expects: "STATUS: done", type: "single" },
    ]);

    const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

    // Manually set reroute_count to 2 (budget exhausted)
    db.prepare("UPDATE steps SET reroute_count = 2 WHERE id = ?").run(consumerRowId);

    const result = recoverOrphanedStepsForAgent("consumer", runId);

    assert.equal(result.failed, 1, `one step should be failed due to budget exhaustion, got failed=${result.failed}`);
    assert.equal(result.recovered, 0, `no steps should be recovered, got recovered=${result.recovered}`);

    // Run should be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed when orphan reroute budget exhausted");
  });

  it("orphan-recovery reroute only fires for single steps, not loop story-level exhaustion", async () => {
    // Loop steps with current_story_id use per-story retry, not step-level retry.
    // Orphan recovery must NOT trigger RETR for story-level exhaustion.
    const db = await getTestDb();
    const runId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "bugfix/x" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Story with exhausted retries (story retry_count == max_retries)
    const storyId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 0, 'S1', 'Test', 'desc', '[]', 'running', 3, 3, ?, ?)"
    ).run(storyId, runId, now, now);

    // Loop step mid-iteration (current_story_id set, running)
    const loopStepId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, current_story_id, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix', '', 'running', 0, 4, 'loop', ?, ?, ?, ?)"
    ).run(loopStepId, runId, storyId, JSON.stringify({ over: "stories" }), now, now);

    // Orphan recovery for the fixer agent — story retries exhausted
    const result = recoverOrphanedStepsForAgent("bf_fixer", runId);

    // Story-level exhaustion does NOT trigger RETR — run fails
    assert.equal(result.failed, 1, `story-level exhaustion should fail the step, got failed=${result.failed}`);
    assert.equal(result.recovered, 0, `story-level exhaustion should not recover, got recovered=${result.recovered}`);

    // Run should be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed on story-level exhaustion");
  });
});

  it("loop path: mixed resolvable and unresolvable keys — unresolvable takes priority, fails fast", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const producerStepId = crypto.randomUUID();
    const loopStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature", repo: "/tmp/repo" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Producer (index 0): DONE, declares BRANCH (so branch has a producer) but output missing BRANCH
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, ?, '', 'done', 'STATUS: done\nREPO: /tmp/repo', 0, 4, 'single', ?, ?)"
    ).run(producerStepId, runId, replyTemplate(["STATUS", "BRANCH"]), now, now);

    // Loop step (index 1): needs {{branch}} (has producer) and {{unresolvable}} (no producer)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 1, 'Implement {{task}} on {{branch}} with {{unresolvable}}\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 4, 'loop', ?, ?, ?)"
    ).run(loopStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    await seedStories(runId);

    const result = claimStep("fdm_developer", runId);

    assert.equal(result.found, false, "loop claim should block");

    // Unresolvable key should cause fail-fast — not re-pend
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should fail when any key is unresolvable");

    // Loop step should be failed with message mentioning unresolvable
    const consumer = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(loopStepId) as { status: string; output: string | null };
    assert.equal(consumer.status, "failed", "loop step should be failed");
    assert.ok(consumer.output?.includes("unresolvable"), `should mention unresolvable key, got: ${consumer.output}`);
    assert.ok(consumer.output?.includes("no upstream DONE step"), `should explain no upstream step, got: ${consumer.output}`);

    // Producer should NOT be re-pended (fail-fast takes priority)
    const producer = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(producerStepId) as { status: string; retry_count: number };
    assert.equal(producer.status, "done", "producer should stay done — fail-fast prevents re-pend");
    assert.equal(producer.retry_count, 0, "producer retry_count should not change");
  });
});

describe("getRunProgressPath canonical path resolution", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-progress-path-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
    // Write agents.json so getAgentWorkspacePath can resolve workspace paths
    const agentsConfig = [
      { id: "test-wf_dev", workspace: path.join(_testIsolationDir, "workspaces", "workflows", "test-wf") }
    ];
    fs.mkdirSync(_testIsolationDir, { recursive: true });
    fs.writeFileSync(path.join(_testIsolationDir, "agents.json"), JSON.stringify(agentsConfig), "utf-8");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("getRunProgressPath returns canonical path under runs/<runId>/progress.txt", async () => {
    const { getRunProgressPath } = await import("../dist/installer/step-ops.js");
    const runId = crypto.randomUUID();
    const progressPath = getRunProgressPath(runId);
    assert.ok(progressPath.endsWith(`runs/${runId}/progress.txt`), `expected path ending with runs/${runId}/progress.txt, got: ${progressPath}`);
    assert.ok(progressPath.startsWith(_testIsolationDir), `expected path under test isolation dir, got: ${progressPath}`);
  });

  it("readProgressFile reads from canonical path with fallback to workspace-scoped", async () => {
    const { getRunProgressPath, readProgressFile } = await import("../dist/installer/step-ops.js");
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const agentId = "test-wf_dev";
    const now = new Date().toISOString();

    const seededContext = JSON.stringify({ task: "test task" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'loop', ?, 0, '{{task}}', '', 'done', 0, 4, 'loop', ?, ?, ?)"
    ).run(crypto.randomUUID(), runId, agentId, JSON.stringify({ over: "stories" }), now, now);

    const workspaceDir = path.join(_testIsolationDir, "workspaces", "workflows", "test-wf");
    const workspaceScopedPath = path.join(workspaceDir, `progress-${runId}.txt`);
    fs.mkdirSync(path.dirname(workspaceScopedPath), { recursive: true });
    fs.writeFileSync(workspaceScopedPath, "workspace-scoped content", "utf-8");

    const legacyPath = path.join(workspaceDir, "progress.txt");
    fs.writeFileSync(legacyPath, "legacy content", "utf-8");

    const canonicalPath = getRunProgressPath(runId);
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, "canonical content", "utf-8");

    const content = readProgressFile(runId);
    assert.equal(content, "canonical content", "should read from canonical path when it exists");

    fs.unlinkSync(canonicalPath);
    fs.unlinkSync(workspaceScopedPath);
    fs.unlinkSync(legacyPath);
  });

  it("readProgressFile falls back to workspace-scoped path when canonical missing", async () => {
    const { readProgressFile } = await import("../dist/installer/step-ops.js");
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const agentId = "test-wf_dev";
    const now = new Date().toISOString();

    const seededContext = JSON.stringify({ task: "test task" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'test-wf', 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'loop', ?, 0, '{{task}}', '', 'done', 0, 4, 'loop', ?, ?, ?)"
    ).run(crypto.randomUUID(), runId, agentId, JSON.stringify({ over: "stories" }), now, now);

    const workspaceDir = path.join(_testIsolationDir, "workspaces", "workflows", "test-wf");
    const scopedPath = path.join(workspaceDir, `progress-${runId}.txt`);
    fs.mkdirSync(path.dirname(scopedPath), { recursive: true });
    fs.writeFileSync(scopedPath, "fallback content", "utf-8");

    const content = readProgressFile(runId);
    assert.equal(content, "fallback content", "should fall back to workspace-scoped path");

    fs.unlinkSync(scopedPath);
  });

  it("readProgressFile falls back to legacy progress.txt when neither canonical nor scoped exist", async () => {
    const { readProgressFile } = await import("../dist/installer/step-ops.js");
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const agentId = "test-wf_dev";
    const now = new Date().toISOString();

    const seededContext = JSON.stringify({ task: "test task" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 3, 'test-wf', 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'loop', ?, 0, '{{task}}', '', 'done', 0, 4, 'loop', ?, ?, ?)"
    ).run(crypto.randomUUID(), runId, agentId, JSON.stringify({ over: "stories" }), now, now);

    const workspaceDir = path.join(_testIsolationDir, "workspaces", "workflows", "test-wf");
    const legacyPath = path.join(workspaceDir, "progress.txt");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, "legacy fallback", "utf-8");

    const content = readProgressFile(runId);
    assert.equal(content, "legacy fallback", "should fall back to legacy progress.txt");

    fs.unlinkSync(legacyPath);
  });

  it("resolveStepContext injects progress_file alongside progress for loop steps", async () => {
    const { getRunProgressPath, resolveStepContext } = await import("../dist/installer/step-ops.js");
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const agentId = "test-wf_dev";
    const now = new Date().toISOString();

    const seededContext = JSON.stringify({ task: "test task" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 4, 'test-wf', 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'loop', ?, 0, '{{task}}', '', 'done', 0, 4, 'loop', ?, ?, ?)"
    ).run(crypto.randomUUID(), runId, agentId, JSON.stringify({ over: "stories" }), now, now);

    db.prepare(
      "INSERT INTO stories (id, run_id, story_id, title, description, acceptance_criteria, status, story_index, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'US-001', 'Test', 'Test desc', '[]', 'pending', 0, 0, 4, ?, ?)"
    ).run(crypto.randomUUID(), runId, now, now);

    const canonicalPath = getRunProgressPath(runId);
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, "# Progress Log\n\n## Codebase Patterns\n- Test", "utf-8");

    const loopConfig = { over: "stories" as const, storiesPerStep: 1 };
    const story = {
      id: crypto.randomUUID(),
      runId,
      storyIndex: 0,
      storyId: "US-001",
      title: "Test",
      description: "Test desc",
      acceptanceCriteria: [],
      status: "pending" as const,
      retryCount: 0,
      maxRetries: 4,
    };

    const context = resolveStepContext(runId, 1, loopConfig, story);

    assert.ok("progress_file" in context, "context should contain progress_file key");
    assert.equal(context["progress_file"], canonicalPath, "progress_file should be the canonical path");
    assert.ok("progress" in context, "context should still contain progress key");
    assert.equal(context["progress"], "# Progress Log\n\n## Codebase Patterns\n- Test", "progress should contain file contents");

    fs.unlinkSync(canonicalPath);
  });

  it("writeStoryPlanToProgress writes to canonical path", async () => {
    const { getRunProgressPath, writeStoryPlanToProgress } = await import("../dist/installer/step-ops.js");
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const agentId = "test-wf_dev";
    const now = new Date().toISOString();

    const seededContext = JSON.stringify({ task: "test task" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 5, 'test-wf', 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'loop', ?, 0, '{{task}}', '', 'running', 0, 4, 'loop', ?, ?, ?)"
    ).run(crypto.randomUUID(), runId, agentId, JSON.stringify({ over: "stories" }), now, now);

    db.prepare(
      "INSERT INTO stories (id, run_id, story_id, title, description, acceptance_criteria, status, story_index, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'US-001', 'Test story', 'Test', '[]', 'pending', 0, 0, 4, ?, ?)"
    ).run(crypto.randomUUID(), runId, now, now);

    writeStoryPlanToProgress(runId);

    const canonicalPath = getRunProgressPath(runId);
    assert.ok(fs.existsSync(canonicalPath), "canonical progress file should be created");
    const content = fs.readFileSync(canonicalPath, "utf-8");
    assert.ok(content.includes("## Story Plan"), "should contain Story Plan section");
    assert.ok(content.includes("US-001"), "should contain the story");

    fs.unlinkSync(canonicalPath);
  });

  it("archiveRunProgress archives from canonical path to archive subdirectory", async () => {
    const { getRunProgressPath, archiveRunProgress } = await import("../dist/installer/step-ops.js");
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const agentId = "test-wf_dev";
    const now = new Date().toISOString();

    const seededContext = JSON.stringify({ task: "test task" });
    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 6, 'test-wf', 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'loop', ?, 0, '{{task}}', '', 'done', 0, 4, 'loop', ?, ?, ?)"
    ).run(crypto.randomUUID(), runId, agentId, JSON.stringify({ over: "stories" }), now, now);

    const canonicalPath = getRunProgressPath(runId);
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, "progress content to archive", "utf-8");

    archiveRunProgress(runId);

    assert.ok(!fs.existsSync(canonicalPath), "canonical progress file should be removed after archive");

    const archivePath = path.join(path.dirname(canonicalPath), "archive", "progress.txt");
    assert.ok(fs.existsSync(archivePath), "archive copy should exist");
    const archivedContent = fs.readFileSync(archivePath, "utf-8");
    assert.equal(archivedContent, "progress content to archive", "archived content should match");

    fs.rmSync(path.dirname(canonicalPath), { recursive: true, force: true });
  });
});
