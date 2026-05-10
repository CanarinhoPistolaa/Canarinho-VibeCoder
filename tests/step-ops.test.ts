import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOutputKeyValues, resolveTemplate, buildStoryPlanSection, mergeStoryPlanIntoProgress, validateExpects } from "../dist/installer/step-ops.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

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
