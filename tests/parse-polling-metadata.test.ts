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

import {
  parsePollingRoundMetadata,
  extractTokenUsage,
} from "../dist/installer/agent-scheduler.js";

// ---------------------------------------------------------------------------
// Canned message_end line matching the real pi --mode json output shape,
// with the token values specified in the story:
//   input=121, output=25, cacheRead=4096, cacheWrite=0, totalTokens=4242
// The shape (including the cost object and content structure) was verified
// against real pi output from:
//   echo "" | pi --print --mode json --no-session "say hi"
// ---------------------------------------------------------------------------
const CANNED_MESSAGE_END = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Hi!" },
    ],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    usage: {
      input: 121,
      output: 25,
      cacheRead: 4096,
      cacheWrite: 0,
      totalTokens: 4242,
      cost: {
        input: 0.000052635,
        output: 0.00002175,
        cacheRead: 0.000014848,
        cacheWrite: 0,
        total: 0.000089233,
      },
    },
    stopReason: "stop",
    timestamp: 1777829458436,
    responseId: "df63b1e4-f982-4f9f-85a6-6e0f12d609fa",
  },
});

describe("parsePollingRoundMetadata", () => {
  // -----------------------------------------------------------------------
  // AC 3: Token extraction returns 4242 for the canned line
  // -----------------------------------------------------------------------
  it("extracts tokenUsage=4242 from a real-shaped message_end line", () => {
    const meta = parsePollingRoundMetadata(CANNED_MESSAGE_END);
    assert.equal(meta.tokenUsage, 4242);
    assert.equal(meta.jsonMetadataDetected, true);
    assert.equal(meta.assistantOutput, "Hi!");
  });

  // -----------------------------------------------------------------------
  // AC 4 variant: null for heartbeat output (HEARTBEAT_OK + NO_WORK)
  // -----------------------------------------------------------------------
  it("returns null tokenUsage for HEARTBEAT_OK output", () => {
    const meta = parsePollingRoundMetadata("HEARTBEAT_OK\nNO_WORK");
    assert.equal(meta.tokenUsage, null);
    assert.equal(meta.jsonMetadataDetected, false);
    assert.notEqual(meta.assistantOutput.length, 0);
  });

  it("returns null tokenUsage for empty output", () => {
    const meta = parsePollingRoundMetadata("");
    assert.equal(meta.tokenUsage, null);
    assert.equal(meta.jsonMetadataDetected, false);
    assert.equal(meta.assistantOutput, "");
  });

  it("returns null tokenUsage for plain text without JSON events", () => {
    const meta = parsePollingRoundMetadata("Some agent output\nSTATUS: done");
    assert.equal(meta.tokenUsage, null);
    assert.equal(meta.jsonMetadataDetected, false);
  });

  // -----------------------------------------------------------------------
  // AC 5: cost object present — extractTokenUsage still finds totalTokens
  // -----------------------------------------------------------------------
  it("extractTokenUsage finds totalTokens even with cost object present", () => {
    const usageObj = {
      input: 121,
      output: 25,
      cacheRead: 4096,
      cacheWrite: 0,
      totalTokens: 4242,
      cost: {
        input: 0.000052635,
        output: 0.00002175,
        cacheRead: 0.000014848,
        cacheWrite: 0,
        total: 0.000089233,
      },
    };

    const result = extractTokenUsage(usageObj);
    assert.equal(result, 4242);
  });

  it("extractTokenUsage returns null for null input", () => {
    assert.equal(extractTokenUsage(null), null);
  });

  it("extractTokenUsage returns null for undefined input", () => {
    assert.equal(extractTokenUsage(undefined), null);
  });

  it("extractTokenUsage returns null for an empty object", () => {
    assert.equal(extractTokenUsage({}), null);
  });

  // -----------------------------------------------------------------------
  // AC 6: multi-event output (message_end + non-JSON text) still extracts
  //       the right value
  // -----------------------------------------------------------------------
  it("extracts tokenUsage when message_end is mixed with non-JSON lines", () => {
    const mixed = [
      "some preamble text",
      CANNED_MESSAGE_END,
      "trailing plain text",
    ].join("\n");

    const meta = parsePollingRoundMetadata(mixed);
    assert.equal(meta.tokenUsage, 4242);
    assert.equal(meta.jsonMetadataDetected, true);
    assert.equal(meta.assistantOutput, "Hi!");
  });

  it("extracts tokenUsage when multiple JSON events include non-message_end types", () => {
    const turnStart = JSON.stringify({ type: "turn_start" });
    const toolEnd = JSON.stringify({
      type: "tool_execution_end",
      toolName: "bash",
      result: { content: [{ type: "text", text: "some result" }] },
    });

    const mixed = [turnStart, CANNED_MESSAGE_END, toolEnd].join("\n");

    const meta = parsePollingRoundMetadata(mixed);
    assert.equal(meta.tokenUsage, 4242);
    assert.equal(meta.jsonMetadataDetected, true);
  });

  it("uses the last assistant message_end tokenUsage when multiple are present", () => {
    const first = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        usage: { input: 10, output: 5, totalTokens: 15 },
      },
    });

    const second = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        usage: { input: 80, output: 20, totalTokens: 100 },
      },
    });

    const meta = parsePollingRoundMetadata(`${first}\n${second}`);
    assert.equal(meta.tokenUsage, 100);
    assert.equal(meta.assistantOutput, "second");
  });

  it("ignores user message_end events (only counts assistant)", () => {
    const userEvent = JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        usage: { totalTokens: 999 },
      },
    });

    const meta = parsePollingRoundMetadata(
      `${userEvent}\n${CANNED_MESSAGE_END}`,
    );

    assert.equal(meta.tokenUsage, 4242);
  });

  it("returns null tokenUsage for message_end without usage object", () => {
    const noUsage = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "no usage here" }],
      },
    });

    const meta = parsePollingRoundMetadata(noUsage);
    assert.equal(meta.tokenUsage, null);
    assert.equal(meta.assistantOutput, "no usage here");
  });
});
