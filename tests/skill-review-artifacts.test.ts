import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const skillPath = resolve(repoRoot, "skills/canarinho-agents/SKILL.md");
const skill = readFileSync(skillPath, "utf-8");

describe("US-003: Verify skill file consistency with AGENTS.md", () => {
  // AC 1: Skill includes guidance to review docs, MCP, CLI, dashboard, README
  it("includes guidance to review docs, MCP, CLI, dashboard, and README", () => {
    assert.match(skill, /docs\/creating-workflows\.md/);
    assert.match(skill, /src\/server\/mcp-server\.ts/);
    assert.match(skill, /src\/cli\/cli\.ts/);
    assert.match(skill, /src\/server\/index\.html/);
    assert.match(skill, /README\.md/);
    assert.match(
      skill,
      /review.*whether.*artifacts.*need.*updating/i,
      "skill should instruct to review whether artifacts need updating",
    );
  });

  // AC 2: Skill still covers all existing step lifecycle guidance
  it("preserves existing step lifecycle guidance", () => {
    assert.match(skill, /### 3\) Follow the step lifecycle exactly/);
    assert.match(skill, /canarinho step peek/);
    assert.match(skill, /canarinho step claim/);
    assert.match(skill, /canarinho step complete/);
    assert.match(skill, /canarinho step fail/);
    assert.match(skill, /SAVE.*stepId.*immediately/i);
  });

  // AC 2: Skill still covers all existing CLI command guidance
  it("preserves existing CLI command guidance", () => {
    assert.match(skill, /### 1\) Confirm CLI access/);
    assert.match(skill, /### 2\) Know the workflow-level commands/);
    assert.match(skill, /canarinho workflow list/);
    assert.match(skill, /canarinho workflow run/);
    assert.match(skill, /canarinho workflow status/);
    assert.match(skill, /canarinho workflow pause/);
    assert.match(skill, /canarinho workflow resume/);
  });

  // AC 2: Completion contract still present
  it("preserves completion contract guidance", () => {
    assert.match(skill, /### 4\) Completion contract/);
    assert.match(skill, /STATUS: done/);
    assert.match(skill, /CHANGES:/);
    assert.match(skill, /TESTS:/);
  });

  // AC 3: No regressions in frontmatter formatting
  it("preserves YAML frontmatter", () => {
    assert.match(skill, /^---$/m);
    const frontmatterMatch = skill.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatterMatch, "YAML frontmatter must be present");
    const frontmatter = frontmatterMatch[1];
    assert.match(frontmatter, /name:\s+canarinho-agents/);
    assert.match(frontmatter, /description:/);
  });

  // AC 1 part 2: Cascade triggers documented
  it("documents cascade triggers for artifact review", () => {
    assert.match(skill, /[Ss]tep lifecycle/);
    assert.match(skill, /CLI command/);
    assert.match(skill, /[Aa]gent provisioning/);
    assert.match(skill, /[Oo]utput format contract/);
  });

  // Verify the skill references updating bundled workflow persona files
  it("mentions verifying bundled workflow persona AGENTS.md on skill changes", () => {
    assert.match(
      skill,
      /bundled workflow persona.*AGENTS\.md/i,
      "skill should mention verifying bundled workflow persona AGENTS.md files",
    );
  });

  // Verify section 5 is placed after 2.3 and before Examples
  it("places review-artifacts section between dashboard and examples", () => {
    const dashboardIdx = skill.indexOf("### 2.3) Dashboard lifecycle");
    const reviewIdx = skill.indexOf("### 5) Review artifacts on changes");
    const examplesIdx = skill.indexOf("## Examples");

    assert.ok(dashboardIdx >= 0, "Dashboard section must exist");
    assert.ok(reviewIdx >= 0, "Review section must exist");
    assert.ok(examplesIdx >= 0, "Examples section must exist");
    assert.ok(
      dashboardIdx < reviewIdx && reviewIdx < examplesIdx,
      "Review section must appear after dashboard and before examples",
    );
  });
});
