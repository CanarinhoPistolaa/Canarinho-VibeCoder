/**
 * The work prompt is the ONLY agent prompt under the deterministic dispatch
 * motor: the scheduler peeks in-process and spawns a harness with this
 * prompt only when a pending step exists (claim -> execute -> report).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWorkPrompt } from "../dist/installer/agent-scheduler.js";

const RUN_ID = "7aeb4da9-1111-4222-8333-abcdefabcdef";

describe("buildWorkPrompt (deterministic-dispatch work prompt)", () => {
  it("contains the run-scoped step claim command with correct agent id", () => {
    const prompt = buildWorkPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(prompt.includes(`step claim "feature-dev_developer" --run-id "${RUN_ID}"`));
  });

  it("contains step complete and step fail instructions", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("step complete"));
    assert.ok(prompt.includes("step fail"));
  });

  it("does NOT contain a peek phase — the scheduler peeked in-process", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes("step peek"));
    assert.ok(!prompt.includes("HEARTBEAT_OK"));
  });

  it("instructs to reply NO_WORK_AVAILABLE when the claim raced another worker", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("NO_WORK_AVAILABLE"));
  });

  it("includes the header line the scripted runtime parses", () => {
    const prompt = buildWorkPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(
      /workflow "feature-dev", agent "feature-dev_developer", run "7aeb4da9/.test(prompt),
      "header must stay matchable by the scripted-agent runtime",
    );
  });

  it("invokes the CLI launcher directly — never via a node prefix", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes('node "'), "the CLI is a shell script; node <cli> throws a SyntaxError");
  });

  it("injects provisioned persona instructions when provided", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID, "### SOUL.md\n\nBe thorough.");
    assert.ok(prompt.includes("PROVISIONED AGENT PERSONA"));
    assert.ok(prompt.includes("Be thorough."));
  });

  it("omits the persona block when no instructions are provided", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes("PROVISIONED AGENT PERSONA"));
  });

  it("always instructs to report — the ALWAYS rule", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("ALWAYS report results"));
  });

  it("works with different workflow/agent ids without errors", () => {
    const p1 = buildWorkPrompt("security-audit-github-pr", "scanner", RUN_ID);
    const p2 = buildWorkPrompt("bug-fix-github-pr", "fixer", RUN_ID);
    assert.ok(p1.includes("step complete"));
    assert.ok(p2.includes("step complete"));
    assert.ok(p1.includes(`step claim "scanner" --run-id "${RUN_ID}"`));
    assert.ok(p2.includes(`step claim "fixer" --run-id "${RUN_ID}"`));
  });

  it("instructs agent to save and use stepId for step complete", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("stepId"), "should mention stepId");
    assert.ok(prompt.includes("SAVE"), "should instruct to save stepId");
  });

  it("REPORT defers to the task's Reply-with format; generic shape is fallback-only (MPRT)", () => {
    const prompt = buildWorkPrompt("bug-fix-merge-worktree", "verifier", RUN_ID);
    // The success path must point at the task's own reply format...
    assert.ok(prompt.includes('EXACTLY the reply format from the task\'s "Reply with:" section'));
    assert.ok(prompt.includes("omitting one forces a retry"));
    // ...and the generic STATUS/CHANGES/TESTS example only as explicit fallback.
    const fallbackIdx = prompt.indexOf('Only if the task has NO "Reply with:" section');
    const genericIdx = prompt.indexOf("CHANGES: <what you did>");
    assert.ok(fallbackIdx !== -1 && genericIdx !== -1 && genericIdx > fallbackIdx,
      "generic CHANGES/TESTS example must appear only under the no-Reply-format fallback");
  });
});
