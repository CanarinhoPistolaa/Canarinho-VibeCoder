import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";

const workflowsDir = resolveBundledWorkflowsDir();
const workflowIds = readdirSync(workflowsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

function wfDir(id: string): string {
  return resolve(workflowsDir, id);
}

describe("workflow parsing", () => {
  it("finds at least 4 bundled workflows", () => {
    assert.ok(workflowIds.length >= 4);
    assert.ok(workflowIds.includes("feature-dev"));
    assert.ok(workflowIds.includes("feature-dev-merge"));
    assert.ok(workflowIds.includes("security-audit"));
    assert.ok(workflowIds.includes("security-audit-github-pr"));
    assert.ok(workflowIds.includes("bug-fix-github-pr"));
    assert.ok(workflowIds.includes("bug-fix-merge"));
    assert.ok(workflowIds.includes("security-audit-merge"));
  });

  for (const id of workflowIds) {
    it(`parses ${id} workflow YAML without errors`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.id, id);
      assert.ok(spec.agents.length > 0);
      assert.ok(spec.steps.length > 0);
    });

    it(`${id} has valid polling config`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      if (spec.polling) {
        assert.ok(typeof spec.polling === "object");
      }
    });

    it(`${id} agents have valid roles if specified`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const validRoles = new Set(["analysis", "coding", "verification", "testing", "pr", "scanning"]);
      for (const agent of spec.agents) {
        if (agent.role) assert.ok(validRoles.has(agent.role), `${agent.id}: "${agent.role}" is valid`);
      }
    });

    it(`${id} agent workspace files exist`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
          const resolved = resolve(wfDir(id), relativePath);
          assert.ok(existsSync(resolved),
            `${id}/${agent.id}: ${relativePath} should exist (for ${fileName})`);
        }
      }
    });
  }
});

describe("model field preservation", () => {
  it("agent model field flows through YAML parsing", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev"));
    const withModel = spec.agents.filter((a) => a.model);
    for (const agent of withModel) {
      assert.ok(typeof agent.model === "string");
      assert.ok(agent.model.length > 0);
    }
  });

  it("polling model is present when configured", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev"));
    if (spec.polling?.model) {
      assert.ok(typeof spec.polling.model === "string");
    }
  });
});

describe("workflow structure", () => {
  it("shared agent personas exist", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const sharedDir = resolve(repoRoot, "agents", "shared");
    for (const persona of ["setup", "verifier", "pr"]) {
      const d = join(sharedDir, persona);
      assert.ok(existsSync(d), `shared/${persona}/`);
      for (const f of ["AGENTS.md", "SOUL.md", "IDENTITY.md"]) {
        assert.ok(existsSync(join(d, f)), `shared/${persona}/${f}`);
      }
    }
  });

  it("tamandua-agents skill exists with required frontmatter", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const skillPath = resolve(repoRoot, "skills", "tamandua-agents", "SKILL.md");
    assert.ok(existsSync(skillPath));

    const content = readFileSync(skillPath, "utf-8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, "missing YAML frontmatter");

    const fm = frontmatter![1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descriptionMatch = fm.match(/^description:\s*(.+)$/m);

    assert.ok(nameMatch, "frontmatter must include name");
    assert.ok(descriptionMatch, "frontmatter must include description");
    assert.equal(nameMatch![1].trim(), "tamandua-agents");
    assert.match(nameMatch![1].trim(), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("tamandua-agents skill documents step lifecycle and stepId usage", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const skillPath = resolve(repoRoot, "skills", "tamandua-agents", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");

    assert.match(content, /## Instructions/);
    assert.match(content, /## Examples/);
    assert.match(content, /tamandua workflow list/);
    assert.match(content, /tamandua workflow run <workflow-id>/);
    assert.match(content, /tamandua workflow status <run-id-or-query>/);
    assert.match(content, /tamandua step peek <agent-id>/);
    assert.match(content, /tamandua step claim <agent-id>/);
    assert.match(content, /tamandua step complete <stepId>/);
    assert.match(content, /tamandua step fail <stepId>/);
    assert.match(content, /SAVE `stepId` immediately/i);
    assert.match(content, /Never call `step complete` or `step fail` with an agent ID/i);
  });

  it("bundled workflow agents declare tamandua-agents skill", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        const skills = agent.workspace.skills ?? [];
        assert.ok(
          skills.includes("tamandua-agents"),
          `${id}/${agent.id}: workspace.skills must include tamandua-agents`,
        );
      }
    }
  });

  it("agent-browser skills are preserved where already declared", async () => {
    const expectations = [
      { workflowId: "feature-dev", agentId: "verifier" },
      { workflowId: "feature-dev-merge", agentId: "verifier" },
      { workflowId: "feature-dev-github-pr", agentId: "verifier" },
      { workflowId: "feature-dev-github-pr", agentId: "reviewer" },
    ];

    for (const { workflowId, agentId } of expectations) {
      const spec = await loadWorkflowSpec(wfDir(workflowId));
      const agent = spec.agents.find((entry) => entry.id === agentId);
      assert.ok(agent, `${workflowId}: expected agent ${agentId}`);

      const skills = agent!.workspace.skills ?? [];
      assert.ok(
        skills.includes("agent-browser"),
        `${workflowId}/${agentId}: workspace.skills must preserve agent-browser`,
      );
      assert.ok(
        skills.includes("tamandua-agents"),
        `${workflowId}/${agentId}: workspace.skills must include tamandua-agents`,
      );
    }
  });

  it("all steps reference valid agents", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      const agentIds = new Set(spec.agents.map((a) => a.id));
      for (const step of spec.steps) {
        assert.ok(agentIds.has(step.agent),
          `${id}: step "${step.id}" references unknown agent "${step.agent}"`);
      }
    }
  });

  it("workflow IDs match directory names", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.id, id);
    }
  });

  it("feature-dev-merge preserves implement loop wiring and ends with squash-merge finalization", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge"));

    const stepIds = spec.steps.map((step) => step.id);
    assert.deepEqual(stepIds, ["plan", "setup", "implement", "verify", "test", "finalize_merge"]);
    assert.equal(stepIds[stepIds.length - 1], "finalize_merge");

    const implementStep = spec.steps.find((step) => step.id === "implement");
    assert.ok(implementStep, "feature-dev-merge should define implement step");
    assert.equal(implementStep!.type, "loop");
    assert.equal(implementStep!.loop?.over, "stories");
    assert.equal(implementStep!.loop?.verify_each, true);
    assert.equal(implementStep!.loop?.verify_step, "verify");

    const finalStep = spec.steps.find((step) => step.id === "finalize_merge");
    assert.ok(finalStep, "feature-dev-merge should define finalize_merge step");
    assert.equal(finalStep!.agent, "merger");
    assert.match(finalStep!.input, /RUN_ID:\s*\{\{run_id\}\}/);
    assert.match(finalStep!.input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);
    assert.match(finalStep!.input, /PROGRESS LOG:\s*\{\{progress\}\}/);
    assert.match(finalStep!.input, /Execute these git commands explicitly \(in order\):/);
    assert.match(finalStep!.input, /git checkout \{\{original_branch\}\}/);
    assert.match(finalStep!.input, /git merge --squash \{\{branch\}\}/);
    assert.match(finalStep!.input, /Build a descriptive commit message/);
    assert.match(finalStep!.input, /git commit -F <tempfile>/);
    assert.doesNotMatch(finalStep!.input, /git commit -m/);
    assert.match(finalStep!.input, /MERGE_COMMIT:/);
    assert.match(finalStep!.input, /MERGED_INTO:/);
  });

  it("feature-dev-merge setup prompt captures ORIGINAL_BRANCH before checkout", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge"));
    const setupStep = spec.steps.find((step) => step.id === "setup");

    assert.ok(setupStep, "feature-dev-merge should define setup step");
    assert.match(setupStep!.input, /Capture the current branch before switching: ORIGINAL_BRANCH=\$\(git branch --show-current\)/);
    assert.match(setupStep!.input, /Create the feature branch \(git checkout -b \{\{branch\}\}\)/);
    assert.match(setupStep!.input, /ORIGINAL_BRANCH: <branch name captured before checkout>/);
  });

  it("feature-dev-merge defines workflow-local merger persona files", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge"));
    const merger = spec.agents.find((agent) => agent.id === "merger");

    assert.ok(merger, "feature-dev-merge should define merger agent");
    assert.equal(merger!.role, "pr");
    assert.equal(merger!.workspace.files["AGENTS.md"], "agents/merger/AGENTS.md");
    assert.equal(merger!.workspace.files["SOUL.md"], "agents/merger/SOUL.md");
    assert.equal(merger!.workspace.files["IDENTITY.md"], "agents/merger/IDENTITY.md");
  });

  it("merger AGENTS.md contains commit message generation instructions", () => {
    const mergerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/merger/AGENTS.md");
    const content = readFileSync(mergerAgentsMdPath, "utf-8");

    assert.match(content, /## Commit Message Generation/);
    assert.match(content, /Build a descriptive commit message/);
    assert.match(content, /git commit -F/);
    assert.match(content, /conventional commit format/);
    assert.match(content, /imperative mood/);
    assert.match(content, /Under 72 characters/);
    assert.doesNotMatch(content, /git commit -m/);
    assert.match(content, /Write the full message to a temp file/);
    assert.match(content, /### Gathering Information/);
  });

  it("README documents feature-dev-merge usage and pipeline", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const readmePath = resolve(repoRoot, "README.md");
    const readme = readFileSync(readmePath, "utf-8");

    assert.match(readme, /### feature-dev-merge `6 agents`/);
    assert.match(readme, /story-by-story rigor/i);
    assert.match(readme, /squashed merge commit/i);
    assert.match(readme, /ORIGINAL_BRANCH/);
    assert.match(readme, /plan → setup → implement → verify → test → finalize_merge/);
  });
});
