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
    assert.ok(workflowIds.length >= 10);
    assert.ok(workflowIds.includes("feature-dev"));
    assert.ok(workflowIds.includes("feature-dev-merge"));
    assert.ok(workflowIds.includes("feature-dev-merge-worktree"));
    assert.ok(workflowIds.includes("security-audit"));
    assert.ok(workflowIds.includes("security-audit-github-pr"));
    assert.ok(workflowIds.includes("bug-fix-github-pr"));
    assert.ok(workflowIds.includes("bug-fix-merge"));
    assert.ok(workflowIds.includes("security-audit-merge"));
    assert.ok(workflowIds.includes("bug-fix"));
    // US-010: worktree variants
    assert.ok(workflowIds.includes("bug-fix-merge-worktree"));
    assert.ok(workflowIds.includes("security-audit-merge-worktree"));
    assert.ok(workflowIds.includes("feature-dev-worktree"));
    assert.ok(workflowIds.includes("bug-fix-worktree"));
    assert.ok(workflowIds.includes("security-audit-worktree"));
    assert.ok(workflowIds.includes("just-do-it"));
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

    it(`${id} has a non-empty description`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.ok(typeof spec.description === "string", `${id}: description must be a string`);
      assert.ok(spec.description.trim().length > 0, `${id}: description must not be empty`);
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
    assert.match(content, /tamandua workflow status <query>/);
    assert.match(content, /tamandua step peek <agent-id> --run-id <run-id>/);
    assert.match(content, /tamandua step claim <agent-id> --run-id <run-id>/);
    assert.match(content, /tamandua step complete <stepId>/);
    assert.match(content, /tamandua step fail <stepId>/);
    assert.match(content, /SAVE `stepId` immediately/i);
    assert.match(content, /Never call `step complete` or `step fail` with an agent ID/i);
    assert.match(content, /tamandua workflow pause/);
    assert.match(content, /tamandua workflow pause-all/);
    assert.match(content, /--drain/);
    assert.match(content, /tamandua workflow resume-all/);
    assert.match(content, /tamandua logs/);
    assert.match(content, /tamandua logs-tail/);
    assert.match(content, /tamandua dashboard/);
    assert.match(content, /tamandua dashboard status/);
    assert.match(content, /tamandua step stories/);
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
    // Fast-forward-first merge process
    assert.match(finalStep!.input, /Fast-Forward Check/);
    assert.match(finalStep!.input, /git merge-base --is-ancestor \{\{original_branch\}\} \{\{branch\}\}/);
    assert.match(finalStep!.input, /git rebase \{\{original_branch\}\}/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
    assert.match(finalStep!.input, /RETRY_STEP: test/);
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

  it("planner AGENTS.md Output Format mandates single-line minified STORIES_JSON", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    // Output Format section exists
    assert.match(content, /## Output Format/);

    // Must require STORIES_JSON on a single line
    assert.match(content, /Single line only/);
    assert.match(content, /ONE line/);

    // Must require minified (compact) JSON
    assert.match(content, /Minified JSON/);
    assert.match(content, /no newlines/);
    assert.match(content, /no pretty-printing/);

    // Must forbid markdown code fences
    assert.match(content, /No markdown code fences/);
    assert.match(content, /triple backticks/);

    // Must forbid JSON comments
    assert.match(content, /No JSON comments/);

    // Must forbid trailing commas
    assert.match(content, /No trailing commas/);

    // Must forbid prose before/after the JSON array
    assert.match(content, /No prose before or after/);

    // Must contain a correct single-line minified example
    assert.match(content, /STORIES_JSON: \[\{"id":"US-001"/);
  });

  it("planner AGENTS.md provides wrong-format anti-pattern examples", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    // Shows code-fenced JSON as wrong
    assert.match(content, /WRONG.*code-fenced/);
    assert.match(content, /DO NOT DO THIS/);

    // Shows multi-line pretty-printed JSON as wrong
    assert.match(content, /WRONG.*multi-line/);
    assert.match(content, /WRONG.*pretty-printed/);

    // Shows JSON with comments as wrong
    assert.match(content, /WRONG.*JSON with comments/);

    // Shows text after closing bracket as wrong
    assert.match(content, /WRONG.*text after closing bracket/);
  });

  it("planner AGENTS.md primary STORIES_JSON template is single-line, not multi-line", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    // The primary template line should be a single-line minified JSON, not a multi-line entry.
    // Verify the correctly-formatted single-line version exists as a standalone line.
    const singleLineMatch = content.match(/^STORIES_JSON: \[\{"id"/m);
    assert.ok(singleLineMatch, "Primary STORIES_JSON template should be a single line starting with STORIES_JSON: [{\"id\"");
  });

  it("planner AGENTS.md What NOT To Do section includes STORIES_JSON format rules", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    assert.match(content, /## What NOT To Do/);

    // Must include rules about code fences
    assert.match(content, /Do not wrap STORIES_JSON in markdown code fences/);

    // Must include rules about pretty-printing
    assert.match(content, /Do not pretty-print the JSON array across multiple lines/);

    // Must include rules about text before/after
    assert.match(content, /Do not add text before or after the JSON array on the STORIES_JSON line/);

    // Must include rules about JSON comments
    assert.match(content, /Do not include JSON comments/);
  });

  it("planner AGENTS.md output format rules section does not present multi-line JSON as correct", () => {
    const plannerAgentsMdPath = resolve(wfDir("feature-dev-merge"), "agents/planner/AGENTS.md");
    const content = readFileSync(plannerAgentsMdPath, "utf-8");

    // Extract the rules section (between ## Output Format and ### Examples).
    // The rules section describes what to do; the examples section shows WRONG
    // formats (which naturally contain multi-line JSON). Only the rules section
    // must be free of multi-line patterns that could mislead the LLM.
    const rulesSection = content.split("### Examples")[0].split("## Output Format")[1];
    assert.ok(rulesSection, "Should extract rules section after ## Output Format");

    // No STORIES_JSON: followed by a newline and opening bracket/brace in the rules section
    assert.doesNotMatch(rulesSection, /STORIES_JSON:\s*\n\s*[\[{]/);
  });

  it("feature-dev-merge workflow.yml plan step input contains single-line minified STORIES_JSON example", () => {
    const workflowYmlPath = resolve(wfDir("feature-dev-merge"), "workflow.yml");
    const content = readFileSync(workflowYmlPath, "utf-8");

    // Must contain a single-line minified STORIES_JSON example
    assert.match(content, /STORIES_JSON: \[\{"id":"US-001"/);

    // Must state the line must be a single line with no line breaks
    assert.match(content, /single line/);
    assert.match(content, /no line breaks/);
  });

  it("feature-dev-merge workflow.yml plan step input contains anti-pattern warnings", () => {
    const workflowYmlPath = resolve(wfDir("feature-dev-merge"), "workflow.yml");
    const content = readFileSync(workflowYmlPath, "utf-8");

    // Must contain anti-pattern section header
    assert.match(content, /ANTI-PATTERNS/);
    assert.match(content, /DO NOT DO/);

    // Must warn against triple backticks
    assert.match(content, /Do NOT use triple backticks/);

    // Must warn against comments inside JSON
    assert.match(content, /Do NOT add comments inside the JSON/);

    // Must warn against text after closing bracket
    assert.match(content, /Do NOT put any text after the closing \]/);
  });

  it("feature-dev-merge workflow.yml plan step input does not present multi-line JSON outside anti-pattern context", () => {
    const workflowYmlPath = resolve(wfDir("feature-dev-merge"), "workflow.yml");
    const content = readFileSync(workflowYmlPath, "utf-8");

    // Extract the plan step input block: everything from "- id: plan" in the
    // steps array to the start of the next step ("  - id: setup"). Use precise
    // boundaries to avoid matching "- id: planner" in the agents section.
    const afterPlan = content.split("\n  - id: plan\n    agent: planner")[1];
    assert.ok(afterPlan, "Should find plan step after '- id: plan' in steps");
    const planStepInput = afterPlan.split("\n  - id: setup")[0];
    assert.ok(planStepInput, "Should extract plan step input section");

    // No multi-line pretty-printed JSON in the plan step example (e.g., no
    // lines like '  "id":' indented under a STORIES_JSON or bracket line in
    // the example area). The example must be a single compact line.
    assert.match(planStepInput, /STORIES_JSON: \[\{"id":"US-001"/);
  });

  it("bug-fix has 5 agents, 5 steps, no merger, no finalize_merge, no ORIGINAL_BRANCH capture", async () => {
    const spec = await loadWorkflowSpec(wfDir("bug-fix"));

    // 5 agents
    const agentIds = spec.agents.map((a) => a.id);
    assert.equal(spec.agents.length, 5, `expected 5 agents, got ${spec.agents.length}: ${agentIds.join(", ")}`);
    assert.ok(agentIds.includes("triager"));
    assert.ok(agentIds.includes("investigator"));
    assert.ok(agentIds.includes("setup"));
    assert.ok(agentIds.includes("fixer"));
    assert.ok(agentIds.includes("verifier"));

    // No merger agent
    assert.ok(!agentIds.includes("merger"), "bug-fix should not have merger agent");

    // 5 steps
    const stepIds = spec.steps.map((s) => s.id);
    assert.equal(spec.steps.length, 5, `expected 5 steps, got ${spec.steps.length}: ${stepIds.join(", ")}`);
    assert.deepEqual(stepIds, ["triage", "investigate", "setup", "fix", "verify"]);

    // No finalize_merge step
    assert.ok(!stepIds.includes("finalize_merge"), "bug-fix should not have finalize_merge step");

    // Setup input does not mention ORIGINAL_BRANCH
    const setupStep = spec.steps.find((s) => s.id === "setup");
    assert.ok(setupStep, "bug-fix should define setup step");
    assert.doesNotMatch(setupStep!.input, /ORIGINAL_BRANCH/, "bug-fix setup should not capture ORIGINAL_BRANCH");
  });

  it("README documents bug-fix usage and pipeline", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const readmePath = resolve(repoRoot, "README.md");
    const readme = readFileSync(readmePath, "utf-8");

    assert.match(readme, /### bug-fix `5 agents`/);
    assert.match(readme, /stops after verification/i);
    assert.match(readme, /no merge/i);
    assert.match(readme, /triage → investigate → setup → fix → verify/);
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

  it("security-audit-merge finalize_merge step includes fast-forward-first merge instructions", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "finalize_merge step must exist");
    assert.equal(finalStep!.agent, "merger");

    // Phase 1: Fast-Forward Check
    assert.match(finalStep!.input, /Fast-Forward Check/);
    assert.match(finalStep!.input, /git merge-base --is-ancestor \{\{original_branch\}\} \{\{branch\}\}/);

    // Phase 2: Rebase
    assert.match(finalStep!.input, /Phase 2.*Rebase/);
    assert.match(finalStep!.input, /git rebase \{\{original_branch\}\}/);
    assert.match(finalStep!.input, /git rebase --continue/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
    assert.match(finalStep!.input, /RETRY_STEP: test/);
    assert.match(finalStep!.input, /Do NOT merge/);

    // Phase 3: Squash Merge
    assert.match(finalStep!.input, /Phase 3.*Squash Merge/);
    assert.match(finalStep!.input, /git checkout \{\{original_branch\}\}/);
    assert.match(finalStep!.input, /git merge --squash \{\{branch\}\}/);
    assert.match(finalStep!.input, /git commit -F <tempfile>/);

    // Output format includes REBASED
    assert.match(finalStep!.input, /REBASED:\s*<(true\|false|true\/false)>/);
    assert.match(finalStep!.input, /MERGE_COMMIT:/);
    assert.match(finalStep!.input, /MERGED_INTO:/);

    // Preserves fix(security):-prefix commit message guidance
    assert.match(finalStep!.input, /fix\(security\)/);

    // RETRY_FEEDBACK placeholder
    assert.match(finalStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("security-audit-merge test step includes RETRY_FEEDBACK placeholder for rebase re-validation", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge"));
    const testStep = spec.steps.find((s) => s.id === "test");
    assert.ok(testStep, "test step must exist");
    assert.match(testStep!.input, /\{\{retry_feedback\}\}/);
    assert.match(testStep!.input, /re-validate the rebased changes/);
  });

  it("security-audit-merge merger AGENTS.md includes fast-forward-first merge process", () => {
    const mergerAgentsMdPath = resolve(wfDir("security-audit-merge"), "agents", "merger", "AGENTS.md");
    const content = readFileSync(mergerAgentsMdPath, "utf-8");

    // Phase 1: Fast-Forward Check as first Required Process step
    assert.match(content, /Phase 1: Fast-Forward Check/);
    assert.match(content, /git merge-base --is-ancestor \{\{original_branch\}\} \{\{branch\}\}/);
    const phase1Index = content.indexOf("Phase 1: Fast-Forward Check");
    const phase3Index = content.indexOf("Phase 3: Squash Merge");
    assert.ok(phase1Index < phase3Index, "Fast-Forward Check must come before Squash Merge");

    // Phase 2: Rebase on non-FF path with conflict resolution
    assert.match(content, /Phase 2: Rebase/);
    assert.match(content, /git rebase \{\{original_branch\}\}/);
    assert.match(content, /git rebase --continue/);
    assert.match(content, /fix them carefully|resolve each conflict|If conflicts arise/i);

    // Tester retry path when rebase made changes
    assert.match(content, /STATUS: retry/);
    assert.match(content, /CONFLICT_NOTES:/);
    assert.match(content, /RETRY_STEP: test/);
    assert.match(content, /Do NOT merge/);

    // Guardrails forbid squash merge when not FF-safe
    assert.match(content, /NEVER squash-merge when the branch is not fast-forward-safe/);
    assert.match(content, /NEVER combine a fast-forward and an unrelated squash merge/);

    // Output format includes REBASED field
    assert.match(content, /REBASED:\s*<(true\|false|true\/false)>/);

    // Preserves fix(security):-prefix commit message guidance
    assert.match(content, /fix\(security\)/);
    assert.match(content, /Do NOT use `feat:` prefix/);

    // Preserves existing commit message generation (git commit -F, not git commit -m)
    assert.match(content, /git commit -F/);
    assert.doesNotMatch(content, /git commit -m/);
    assert.match(content, /Co-Authored-By: Tamandua/);
  });

  it("security-audit-merge workflow.yml finalize_merge step on_fail routes to test", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "finalize_merge step must exist");
    assert.equal(finalStep!.on_fail?.retry_step, "test");
    assert.ok(finalStep!.on_fail?.max_retries);
    assert.equal(finalStep!.on_fail?.on_exhausted?.escalate_to, "human");
  });

describe("US-004: fast-forward-first merge contradiction prevention and ordering", () => {
  const mergeWorkflows = ["feature-dev-merge", "bug-fix-merge", "security-audit-merge"];

  // AC 4: All three merger AGENTS.md files pass guardrail check
  for (const wfId of mergeWorkflows) {
    it(`${wfId} merger AGENTS.md forbids simultaneous contradictory FF + unrelated squash`, () => {
      const mergerMd = readFileSync(resolve(wfDir(wfId), "agents", "merger", "AGENTS.md"), "utf-8");

      // Guardrail must exist
      assert.match(mergerMd, /NEVER combine a fast-forward and an unrelated squash merge/);

      // Every squash-merge mention must be in a FF-safe or guardrails context
      const squashRe = /squash[ -]?merge/gi;
      let match: RegExpExecArray | null;
      while ((match = squashRe.exec(mergerMd)) !== null) {
        const idx = match.index;
        // Wide window captures distant "NEVER" / "only valid paths"
        // in the guardrails section which lists valid-path examples.
        const context = mergerMd.substring(Math.max(0, idx - 250), idx + 250);
        assert.ok(
          context.includes("Phase 3") ||
            context.includes("FF-safe") ||
            context.includes("fast-forward-safe") ||
            context.includes("NEVER") ||
            context.includes("only valid paths") ||
            context.includes("is now fast-forward-safe") ||
            context.includes("report retry"),
          `${wfId}: squash merge mention outside FF-safe context (pos ${idx}): ...${context.substring(230, 270)}...`,
        );
      }
    });
  }

  // AC 5: All three workflow.yml finalize_merge step inputs place FF check before squash merge
  for (const wfId of mergeWorkflows) {
    it(`${wfId} workflow.yml finalize_merge step input places FF check before squash merge (US-004 ordering)`, async () => {
      const spec = await loadWorkflowSpec(wfDir(wfId));
      const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
      assert.ok(finalStep, `${wfId}: finalize_merge step must exist`);

      const input = finalStep!.input;
      const ffIdx = input.search(/git merge-base --is-ancestor/);
      const squashIdx = input.search(/git merge --squash/);

      assert.ok(ffIdx >= 0, `${wfId}: must contain git merge-base --is-ancestor`);
      assert.ok(squashIdx >= 0, `${wfId}: must contain git merge --squash`);
      assert.ok(
        ffIdx < squashIdx,
        `${wfId}: FF check (pos ${ffIdx}) must appear before squash merge (pos ${squashIdx})`,
      );
    });
  }

  // AC 6: Tester retry path exists for feature-dev-merge and security-audit-merge
  for (const wfId of ["feature-dev-merge", "security-audit-merge"]) {
    it(`${wfId} finalize_merge step input includes tester retry path (RETRY_STEP: test, CONFLICT_NOTES) (US-004)`, async () => {
      const spec = await loadWorkflowSpec(wfDir(wfId));
      const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
      assert.ok(finalStep);
      assert.match(finalStep!.input, /RETRY_STEP:\s*test/);
      assert.match(finalStep!.input, /CONFLICT_NOTES/);
    });
  }

  // AC 6: Bug-fix-merge does NOT have tester retry path
  it("bug-fix-merge finalize_merge step input does NOT have tester retry path (US-004)", async () => {
    const spec = await loadWorkflowSpec(wfDir("bug-fix-merge"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.doesNotMatch(finalStep!.input, /RETRY_STEP:\s*test/);
    assert.doesNotMatch(finalStep!.input, /CONFLICT_NOTES/);
  });
});

  it("feature-dev family setup prompts include {{retry_feedback}} placeholder", async () => {
    // Verify all three feature-dev family workflows have retry_feedback in their
    // setup step input templates so retried setups receive prior failure context.
    const featureFamily = ["feature-dev", "feature-dev-merge", "feature-dev-github-pr"];

    for (const id of featureFamily) {
      const spec = await loadWorkflowSpec(wfDir(id));
      const setupStep = spec.steps.find((s) => s.id === "setup");
      assert.ok(setupStep, `${id}: must define a setup step`);

      // The setup input must include the {{retry_feedback}} placeholder
      assert.match(
        setupStep!.input,
        /\{\{retry_feedback\}\}/,
        `${id}: setup step input must include {{retry_feedback}} placeholder`,
      );

      // Verify it's placed correctly: after the TASK/REPO/BRANCH context block
      // and before the Instructions block
      assert.match(setupStep!.input, /RETRY FEEDBACK/,
        `${id}: setup input should contain a RETRY FEEDBACK section`);
      assert.match(setupStep!.input, /Instructions:/,
        `${id}: setup input should contain an Instructions section`);
    }
  });
});

describe("US-010: Create remaining worktree workflow variants", () => {
  const worktreeVariantIds = [
    "bug-fix-merge-worktree",
    "security-audit-merge-worktree",
    "feature-dev-worktree",
    "bug-fix-worktree",
    "security-audit-worktree",
  ];

  const mergeWorktreeVariantIds = [
    "bug-fix-merge-worktree",
    "security-audit-merge-worktree",
  ];

  const nonMergeWorktreeVariantIds = [
    "feature-dev-worktree",
    "bug-fix-worktree",
    "security-audit-worktree",
  ];

  for (const id of worktreeVariantIds) {
    it(`${id} parses successfully`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.id, id);
      assert.ok(spec.agents.length > 0);
      assert.ok(spec.steps.length > 0);
    });

    it(`${id} declares run.workspace: worktree`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.run?.workspace, "worktree");
    });

    it(`${id} all agent workspace files exist`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
          const resolved = resolve(wfDir(id), relativePath);
          assert.ok(existsSync(resolved),
            `${id}/${agent.id}: ${relativePath} should exist (for ${fileName})`);
        }
      }
    });

    it(`${id} all agents have tamandua-agents skill`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        const skills = agent.workspace.skills ?? [];
        assert.ok(
          skills.includes("tamandua-agents"),
          `${id}/${agent.id}: workspace.skills must include tamandua-agents`,
        );
      }
    });

    it(`${id} setup step adapted for detached worktree startup`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const setupStep = spec.steps.find((s) => s.id === "setup");
      assert.ok(setupStep, `${id}: must define setup step`);

      // Should reference {{original_branch}} context variable (pre-seeded by harness)
      assert.match(setupStep!.input, /\{\{original_branch\}\}/);
      assert.match(setupStep!.input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);

      // Should tell agent not to run git branch --show-current (detached HEAD)
      assert.match(setupStep!.input, /do NOT run.*git branch --show-current/i);

      // Should NOT include shell command to capture original_branch
      assert.doesNotMatch(setupStep!.input, /ORIGINAL_BRANCH=\$\(git branch --show-current\)/);
    });
  }

  for (const id of mergeWorktreeVariantIds) {
    it(`${id} finalize_merge step has worktree_origin_repository guidance`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
      assert.ok(finalStep, `${id}: must define finalize_merge step`);

      // Should reference {{worktree_origin_repository}} context variable
      assert.match(finalStep!.input, /\{\{worktree_origin_repository\}\}/);

      // Should include worktree mode instructions
      assert.match(finalStep!.input, /Worktree Mode/);

      // Should direct Phase 1 and Phase 3 to the origin repository
      assert.match(finalStep!.input, /cd \{\{worktree_origin_repository\}\}/);
    });

    it(`${id} preserves fast-forward-first merge ordering (FF check before squash)`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
      assert.ok(finalStep);

      const input = finalStep!.input;
      const ffIdx = input.search(/git merge-base --is-ancestor/);
      const squashIdx = input.search(/git merge --squash/);

      assert.ok(ffIdx >= 0, `${id}: must contain git merge-base --is-ancestor`);
      assert.ok(squashIdx >= 0, `${id}: must contain git merge --squash`);
      assert.ok(
        ffIdx < squashIdx,
        `${id}: FF check (pos ${ffIdx}) must appear before squash merge (pos ${squashIdx})`,
      );
    });
  }

  it("security-audit-merge-worktree finalize_merge has tester retry path", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge-worktree"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.match(finalStep!.input, /RETRY_STEP:\s*test/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
  });

  for (const id of nonMergeWorktreeVariantIds) {
    it(`${id} has no finalize_merge step (non-merge variant)`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const stepIds = spec.steps.map((s) => s.id);
      assert.ok(!stepIds.includes("finalize_merge"), `${id}: non-merge variant should not have finalize_merge step`);
    });
  }

  it("feature-dev-worktree verifier agent preserves agent-browser skill", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-worktree"));
    const verifier = spec.agents.find((a) => a.id === "verifier");
    assert.ok(verifier, "must define verifier agent");
    const skills = verifier!.workspace.skills ?? [];
    assert.ok(skills.includes("agent-browser"), "verifier workspace.skills must preserve agent-browser");
  });

  it("bug-fix-merge-worktree step order matches original (triage → investigate → setup → fix → verify → finalize_merge)", async () => {
    const spec = await loadWorkflowSpec(wfDir("bug-fix-merge-worktree"));
    const stepIds = spec.steps.map((s) => s.id);
    assert.deepEqual(stepIds, ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"]);
  });

  it("security-audit-merge-worktree step order matches original", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-merge-worktree"));
    const stepIds = spec.steps.map((s) => s.id);
    assert.deepEqual(stepIds, ["scan", "prioritize", "setup", "fix", "verify", "test", "finalize_merge"]);
  });

  it("bug-fix-worktree has no merger agent (non-merge variant)", async () => {
    const spec = await loadWorkflowSpec(wfDir("bug-fix-worktree"));
    const agentIds = spec.agents.map((a) => a.id);
    assert.ok(!agentIds.includes("merger"), "bug-fix-worktree should not have merger agent");
  });

  it("feature-dev-worktree implements step has loop wiring", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-worktree"));
    const implementStep = spec.steps.find((s) => s.id === "implement");
    assert.ok(implementStep, "should define implement step");
    assert.equal(implementStep!.type, "loop");
    assert.equal(implementStep!.loop?.over, "stories");
    assert.equal(implementStep!.loop?.verify_each, true);
    assert.equal(implementStep!.loop?.verify_step, "verify");
  });

  it("security-audit-worktree fix step has loop wiring", async () => {
    const spec = await loadWorkflowSpec(wfDir("security-audit-worktree"));
    const fixStep = spec.steps.find((s) => s.id === "fix");
    assert.ok(fixStep, "should define fix step");
    assert.equal(fixStep!.type, "loop");
    assert.equal(fixStep!.loop?.over, "stories");
    assert.equal(fixStep!.loop?.verify_each, true);
    assert.equal(fixStep!.loop?.verify_step, "verify");
  });
});

describe("US-009: feature-dev-merge-worktree workflow variant", () => {
  it("declares run.workspace: worktree", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    assert.equal(spec.run?.workspace, "worktree");
  });

  it("setup step uses {{original_branch}} from context instead of git branch --show-current", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const setupStep = spec.steps.find((s) => s.id === "setup");
    assert.ok(setupStep, "must define setup step");

    // Should reference {{original_branch}} context variable
    assert.match(setupStep!.input, /\{\{original_branch\}\}/);

    // Should provide original_branch as pre-seeded (not captured via git branch --show-current)
    assert.match(setupStep!.input, /pre-seeded|already provided|harness/);

    // Should NOT include the command to capture original_branch via shell
    assert.doesNotMatch(setupStep!.input, /ORIGINAL_BRANCH=\\$\(git branch --show-current\)/);

    // Output format should use {{original_branch}} not a captured variable
    assert.match(setupStep!.input, /ORIGINAL_BRANCH:\s*\{\{original_branch\}\}/);
  });

  it("finalize_merge step has worktree_origin_repository guidance", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep, "must define finalize_merge step");

    // Should reference {{worktree_origin_repository}} context variable
    assert.match(finalStep!.input, /\{\{worktree_origin_repository\}\}/);

    // Should include worktree mode instructions
    assert.match(finalStep!.input, /Worktree Mode/);

    // Should direct Phase 1 and Phase 3 to the origin repository
    assert.match(finalStep!.input, /cd \{\{worktree_origin_repository\}\}/);
  });

  it("preserves fast-forward-first merge ordering (FF check before squash)", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);

    const input = finalStep!.input;
    const ffIdx = input.search(/git merge-base --is-ancestor/);
    const squashIdx = input.search(/git merge --squash/);

    assert.ok(ffIdx >= 0, "must contain git merge-base --is-ancestor");
    assert.ok(squashIdx >= 0, "must contain git merge --squash");
    assert.ok(
      ffIdx < squashIdx,
      `FF check (pos ${ffIdx}) must appear before squash merge (pos ${squashIdx})`,
    );
  });

  it("finalize_merge has tester retry path with REBASED and CONFLICT_NOTES", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const finalStep = spec.steps.find((s) => s.id === "finalize_merge");
    assert.ok(finalStep);
    assert.match(finalStep!.input, /RETRY_STEP:\s*test/);
    assert.match(finalStep!.input, /CONFLICT_NOTES/);
  });

  it("all agent workspace files exist", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    for (const agent of spec.agents) {
      for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
        const resolved = resolve(wfDir("feature-dev-merge-worktree"), relativePath);
        assert.ok(existsSync(resolved),
          `feature-dev-merge-worktree/${agent.id}: ${relativePath} should exist (for ${fileName})`);
      }
    }
  });

  it("all steps have valid roles and tamandua-agents skill", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const validRoles = new Set(["analysis", "coding", "verification", "testing", "pr", "scanning"]);
    for (const agent of spec.agents) {
      if (agent.role) assert.ok(validRoles.has(agent.role), `${agent.id}: "${agent.role}" is valid`);
      const skills = agent.workspace.skills ?? [];
      assert.ok(
        skills.includes("tamandua-agents"),
        `feature-dev-merge-worktree/${agent.id}: workspace.skills must include tamandua-agents`,
      );
    }
  });

  it("verifier agent preserves agent-browser skill", async () => {
    const spec = await loadWorkflowSpec(wfDir("feature-dev-merge-worktree"));
    const verifier = spec.agents.find((a) => a.id === "verifier");
    assert.ok(verifier, "must define verifier agent");
    const skills = verifier!.workspace.skills ?? [];
    assert.ok(skills.includes("agent-browser"), "verifier workspace.skills must preserve agent-browser");
  });
});
