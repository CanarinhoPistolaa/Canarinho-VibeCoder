/**
 * MOTOR-MECHANISM: pins the CURRENT model-driven polling motor.
 *
 * This test asserts implementation details of the polling motor (model-run
 * peek/claim rounds, polling prompts, heartbeat system-token attribution).
 * It is EXPECTED to churn or be replaced when the deterministic motor lands.
 * During the motor rewrite: a failure here is expected noise; a failure in a
 * contract test is a real regression. See tests/MOTOR-CONTRACT.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWorkPrompt, buildPollingPrompt, buildAgentPrompt } from "../dist/installer/agent-scheduler.js";

const RUN_ID = "7aeb4da9-1111-4222-8333-abcdefabcdef";

describe("buildWorkPrompt", () => {
  it("contains step complete instructions", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("step complete"));
  });

  it("contains step fail instructions", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("step fail"));
  });

  it("does NOT contain step claim command", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes("step claim"));
  });

  it("includes the critical warning about reporting", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("CRITICAL"));
  });

  it("does not include HEARTBEAT_OK or NO_WORK", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes("HEARTBEAT_OK"));
    assert.ok(!prompt.includes("NO_WORK"));
  });

  it("works with different workflow/agent ids without errors", () => {
    const p1 = buildWorkPrompt("security-audit-github-pr", "scanner", RUN_ID);
    const p2 = buildWorkPrompt("bug-fix-github-pr", "fixer", RUN_ID);
    assert.ok(p1.includes("step complete"));
    assert.ok(p2.includes("step complete"));
    assert.ok(!p1.includes("step claim"));
    assert.ok(!p2.includes("step claim"));
  });

  it("instructs agent to save and use stepId for step complete", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("stepId"), "should mention stepId");
    assert.ok(prompt.includes("SAVED"), "should instruct to save stepId");
  });
});

describe("buildAgentPrompt", () => {
  it("contains step complete and step fail instructions", () => {
    const prompt = buildAgentPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("step complete"));
    assert.ok(prompt.includes("step fail"));
  });

  it("includes critical warning", () => {
    const prompt = buildAgentPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("CRITICAL"));
  });

  it("includes stuck forever warning", () => {
    const prompt = buildAgentPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("stuck forever"));
  });

  it("contains HEARTBEAT_OK instruction", () => {
    const prompt = buildAgentPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("HEARTBEAT_OK"));
  });

  it("contains step claim instruction", () => {
    const prompt = buildAgentPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(prompt.includes("step claim"));
  });

  it("instructs agent to capture stepId from claim JSON and use it for complete", () => {
    const prompt = buildAgentPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(prompt.includes("stepId"), "should mention stepId");
    assert.ok(prompt.includes("SAVE"), "should instruct to save stepId");
    assert.ok(prompt.includes('"input"'), "should mention input field in JSON");
  });
});

describe("buildPollingPrompt", () => {
  it("contains the step peek and step claim commands with correct agent id", () => {
    const prompt = buildPollingPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(prompt.includes(`step peek "feature-dev_developer" --run-id "${RUN_ID}"`));
    assert.ok(prompt.includes(`step claim "feature-dev_developer" --run-id "${RUN_ID}"`));
  });

  it("instructs to reply HEARTBEAT_OK on NO_WORK", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("HEARTBEAT_OK"));
    assert.ok(prompt.includes("NO_WORK"));
  });

  it("instructs to proceed on HAS_WORK", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("HAS_WORK"));
  });

  it("works with different workflow/agent ids", () => {
    const prompt = buildPollingPrompt("bug-fix-github-pr", "bug-fix-github-pr_fixer", RUN_ID);
    assert.ok(prompt.includes(`step peek "bug-fix-github-pr_fixer" --run-id "${RUN_ID}"`));
    assert.ok(prompt.includes(`step claim "bug-fix-github-pr_fixer" --run-id "${RUN_ID}"`));
  });

  it("includes step complete and step fail instructions", () => {
    const prompt = buildPollingPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("step complete"));
    assert.ok(prompt.includes("step fail"));
  });

  it("includes the agent id in poll commands", () => {
    const prompt = buildPollingPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(prompt.includes('feature-dev_developer"'));
  });

  it("includes PHASE 1 and PHASE 2 sections", () => {
    const prompt = buildPollingPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(prompt.includes("PHASE 1"));
    assert.ok(prompt.includes("PHASE 2"));
  });

  it("does not instruct polling agents to pass --model", () => {
    const prompt = buildPollingPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(!prompt.includes("--model"));
  });

  it("instructs to save stepId from claim JSON for step complete", () => {
    const prompt = buildPollingPrompt("feature-dev", "feature-dev_developer", RUN_ID);
    assert.ok(prompt.includes("stepId"), "should mention stepId in claim description");
    assert.ok(prompt.includes("SAVE"), "should instruct to save stepId");
  });
});
