import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";
import { resolve, join } from "node:path";

const wfDir = resolve(resolveBundledWorkflowsDir(), "bug-fix-merge");

describe("bug-fix-merge workflow", () => {

  it("parses bug-fix-merge workflow YAML without errors", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    assert.equal(spec.id, "bug-fix-merge");
    assert.ok(spec.agents.length > 0);
    assert.ok(spec.steps.length > 0);
  });

  it("has correct step order: triage, investigate, setup, fix, verify, finalize_merge", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const stepIds = spec.steps.map((s) => s.id);
    assert.deepEqual(stepIds, [
      "triage",
      "investigate",
      "setup",
      "fix",
      "verify",
      "finalize_merge",
    ]);
  });

  it("has a finalize_merge step with the merger agent", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "finalize_merge step must exist");
    assert.equal(finalStep!.agent, "merger");
  });

  it("finalize_merge step does NOT mention gh pr create or git push", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.doesNotMatch(finalStep!.input, /gh pr create/);
    assert.doesNotMatch(finalStep!.input, /git push/);
  });

  it("finalize_merge step contains squash merge instructions", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.match(finalStep!.input, /git checkout \{\{original_branch\}\}/);
    assert.match(finalStep!.input, /git merge --squash \{\{branch\}\}/);
    assert.match(finalStep!.input, /git commit -F <tempfile>/);
    assert.match(finalStep!.input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);
    assert.match(finalStep!.input, /MERGE_COMMIT:/);
    assert.match(finalStep!.input, /MERGED_INTO:/);
  });

  it("setup step input contains ORIGINAL_BRANCH", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const setupStep = spec.steps.find((s) => s.id === "setup");
    assert.ok(setupStep, "setup step must exist");
    assert.match(
      setupStep!.input,
      /ORIGINAL_BRANCH/,
      "setup.input must contain ORIGINAL_BRANCH",
    );
    assert.match(
      setupStep!.input,
      /Capture the current branch before switching: ORIGINAL_BRANCH=\$\(git branch --show-current\)/,
    );
  });

  it("defines a merger agent with role pr", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const merger = spec.agents.find((a) => a.id === "merger");
    assert.ok(merger, "merger agent must exist");
    assert.equal(merger!.role, "pr");
  });

  it("merger agent has workflow-local persona files", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const merger = spec.agents.find((a) => a.id === "merger");
    assert.ok(merger);
    assert.equal(merger!.workspace.files["AGENTS.md"], "agents/merger/AGENTS.md");
    assert.equal(merger!.workspace.files["SOUL.md"], "agents/merger/SOUL.md");
    assert.equal(merger!.workspace.files["IDENTITY.md"], "agents/merger/IDENTITY.md");
  });

  it("setup and verifier agents reference shared personas", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const setupAgent = spec.agents.find((a) => a.id === "setup");
    const verifierAgent = spec.agents.find((a) => a.id === "verifier");
    assert.ok(setupAgent);
    assert.ok(verifierAgent);

    assert.equal(
      setupAgent!.workspace.files["AGENTS.md"],
      "../../agents/shared/setup/AGENTS.md",
    );
    assert.equal(
      verifierAgent!.workspace.files["AGENTS.md"],
      "../../agents/shared/verifier/AGENTS.md",
    );
  });

  it("all workflow agents declare tamandua-agents skill", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    for (const agent of spec.agents) {
      const skills = agent.workspace.skills ?? [];
      assert.ok(
        skills.includes("tamandua-agents"),
        `${agent.id}: workspace.skills must include tamandua-agents`,
      );
    }
  });

  it("all steps reference valid agents", async () => {
    const spec = await loadWorkflowSpec(wfDir);
    const agentIds = new Set(spec.agents.map((a) => a.id));
    for (const step of spec.steps) {
      assert.ok(
        agentIds.has(step.agent),
        `step "${step.id}" references unknown agent "${step.agent}"`,
      );
    }
  });

  // US-002: Verify merger persona files
  describe("merger persona", () => {
    const mergerAgentsMd = readFileSync(resolve(wfDir, "agents", "merger", "AGENTS.md"), "utf-8");
    const mergerSoulMd = readFileSync(resolve(wfDir, "agents", "merger", "SOUL.md"), "utf-8");
    const mergerIdentityMd = readFileSync(resolve(wfDir, "agents", "merger", "IDENTITY.md"), "utf-8");

    it("AGENTS.md exists with bug-fix-github-pr commit-message guidance", () => {
      assert.ok(existsSync(resolve(wfDir, "agents", "merger", "AGENTS.md")));
      assert.match(mergerAgentsMd, /fix:/);
      assert.match(mergerAgentsMd, /bug/gi);
      assert.match(mergerAgentsMd, /root cause/gi);
      assert.match(mergerAgentsMd, /fix/gi);
    });

    it("SOUL.md exists and matches feature-dev-merge source", () => {
      const sourceSoul = readFileSync(
        resolve(resolveBundledWorkflowsDir(), "feature-dev-merge", "agents", "merger", "SOUL.md"),
        "utf-8",
      );
      assert.equal(mergerSoulMd, sourceSoul);
    });

    it("IDENTITY.md exists with appropriate merger identity", () => {
      assert.ok(existsSync(resolve(wfDir, "agents", "merger", "IDENTITY.md")));
      assert.match(mergerIdentityMd, /Name:\s*Merger/);
      assert.match(mergerIdentityMd, /Role:.*[Ss]quash/);
    });

    it("AGENTS.md contains conventional commit format guidance and git commit -F instructions", () => {
      assert.match(mergerAgentsMd, /conventional commit format/);
      assert.match(mergerAgentsMd, /git commit -F/);
    });

    it("AGENTS.md does NOT contain gh pr create or git push", () => {
      assert.doesNotMatch(mergerAgentsMd, /gh pr create/);
      assert.doesNotMatch(mergerAgentsMd, /git push/);
    });

    it("AGENTS.md does NOT contain feat: as preferred commit prefix", () => {
      // The only mention of "feat:" should be in a prohibition, not as preferred
      assert.doesNotMatch(mergerAgentsMd, /Use conventional commit format with `feat:`/);
      assert.match(mergerAgentsMd, /Do NOT use `feat:` prefix/);
      assert.match(mergerAgentsMd, /Always use `fix:`/);
    });
  });

  // US-001: Verify triager, investigator, and fixer persona files match bug-fix source
  describe("triager, investigator, fixer personas match bug-fix source", () => {
    const agentIds = ["triager", "investigator", "fixer"];
    const personaFiles = ["AGENTS.md", "SOUL.md", "IDENTITY.md"];
    const bugFixDir = resolve(resolveBundledWorkflowsDir(), "bug-fix-github-pr");

    for (const agentId of agentIds) {
      for (const file of personaFiles) {
        it(`${agentId}/${file} exists in bug-fix-merge and matches bug-fix source`, () => {
          const sourcePath = resolve(bugFixDir, "agents", agentId, file);
          const targetPath = resolve(wfDir, "agents", agentId, file);

          assert.ok(existsSync(sourcePath), `source must exist: ${sourcePath}`);
          assert.ok(existsSync(targetPath), `target must exist: ${targetPath}`);

          const sourceContent = readFileSync(sourcePath, "utf-8");
          const targetContent = readFileSync(targetPath, "utf-8");

          assert.equal(
            targetContent,
            sourceContent,
            `${agentId}/${file} must match bug-fix-github-pr source exactly`,
          );
        });
      }
    }
  });
});
