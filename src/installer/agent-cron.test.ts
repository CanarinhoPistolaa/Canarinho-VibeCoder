/**
 * MOTOR-MECHANISM: pins the CURRENT model-driven polling motor.
 *
 * This test asserts implementation details of the polling motor (model-run
 * peek/claim rounds, polling prompts, heartbeat system-token attribution).
 * It is EXPECTED to churn or be replaced when the deterministic motor lands.
 * During the motor rewrite: a failure here is expected noise; a failure in a
 * contract test is a real regression. See tests/MOTOR-CONTRACT.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWorkPrompt, buildPollingPrompt, buildAgentPrompt } from "../../dist/installer/agent-cron.js";

describe("agent-cron re-exports", () => {
  it("exports buildWorkPrompt as a function", () => {
    assert.equal(typeof buildWorkPrompt, "function");
  });

  it("exports buildPollingPrompt as a function", () => {
    assert.equal(typeof buildPollingPrompt, "function");
  });

  it("exports buildAgentPrompt as a function", () => {
    assert.equal(typeof buildAgentPrompt, "function");
  });
});
