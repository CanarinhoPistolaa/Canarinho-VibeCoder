/**
 * Pure-function tests for agent-scheduler.ts.
 *
 * Tests import from dist/ (not src/) matching the project convention.
 * No real pi/hermes invocations, no DB, no daemon — all pure functions.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  extractTokenUsage,
  parseWorkRoundMetadata,
  classifyWorkRoundOutcome,
  tryMarkJobInFlight,
  buildDispatchRoundContext,
  findHermesBinary,
  DISPATCH_INTERVAL_MS,
  HARNESS_TEARDOWN_GRACE_MS,
} from "../../dist/installer/agent-scheduler.js";
import type { CronJobInfo } from "../../dist/installer/agent-scheduler.js";

// ── extractTokenUsage ──────────────────────────────────────────────

describe("extractTokenUsage", () => {
  it("returns null for null input", () => {
    assert.strictEqual(extractTokenUsage(null), null);
  });

  it("returns null for undefined input", () => {
    assert.strictEqual(extractTokenUsage(undefined), null);
  });

  it("returns null for primitive input", () => {
    assert.strictEqual(extractTokenUsage(42), null);
    assert.strictEqual(extractTokenUsage("hello"), null);
    assert.strictEqual(extractTokenUsage(true), null);
  });

  it("returns null for array input", () => {
    assert.strictEqual(extractTokenUsage([1, 2, 3]), null);
  });

  it("returns null for empty object", () => {
    assert.strictEqual(extractTokenUsage({}), null);
  });

  it("extracts direct totalTokens", () => {
    assert.strictEqual(extractTokenUsage({ totalTokens: 100 }), 100);
  });

  it("extracts direct total_tokens (snake_case)", () => {
    assert.strictEqual(extractTokenUsage({ total_tokens: 200 }), 200);
  });

  it("extracts direct total", () => {
    assert.strictEqual(extractTokenUsage({ total: 300 }), 300);
  });

  it("prefers direct total over parts", () => {
    assert.strictEqual(
      extractTokenUsage({ total: 500, input: 10, output: 20 }),
      500,
    );
  });

  it("sums input + output parts", () => {
    assert.strictEqual(
      extractTokenUsage({ input: 100, output: 50 }),
      150,
    );
  });

  it("sums inputTokens + outputTokens (camelCase)", () => {
    assert.strictEqual(
      extractTokenUsage({ inputTokens: 30, outputTokens: 70 }),
      100,
    );
  });

  it("sums input_tokens + output_tokens (snake_case)", () => {
    assert.strictEqual(
      extractTokenUsage({ input_tokens: 40, output_tokens: 60 }),
      100,
    );
  });

  it("sums prompt_tokens + completion_tokens", () => {
    assert.strictEqual(
      extractTokenUsage({ prompt_tokens: 25, completion_tokens: 75 }),
      100,
    );
  });

  it("includes cache_read tokens", () => {
    assert.strictEqual(
      extractTokenUsage({ input: 10, output: 20, cache_read: 5 }),
      35,
    );
  });

  it("includes cache_write tokens", () => {
    assert.strictEqual(
      extractTokenUsage({ input: 10, output: 20, cache_write: 15 }),
      45,
    );
  });

  it("includes all cache tokens together", () => {
    // cache_read matches before cache_read_tokens (firstNumeric returns first match)
    assert.strictEqual(
      extractTokenUsage({ input: 10, output: 20, cache_read: 5, cache_write: 15 }),
      50,
    );
  });

  it("returns null when all parts are null/missing", () => {
    assert.strictEqual(extractTokenUsage({ foo: "bar" }), null);
  });

  it("handles partial parts (some null)", () => {
    assert.strictEqual(
      extractTokenUsage({ input: 100 }),
      100,
    );
  });

  it("normalizes negative values to 0", () => {
    assert.strictEqual(extractTokenUsage({ total: -50 }), 0);
  });

  it("returns null for non-finite numbers", () => {
    assert.strictEqual(extractTokenUsage({ total: Infinity }), null);
    assert.strictEqual(extractTokenUsage({ total: NaN }), null);
  });

  it("rounds float values", () => {
    assert.strictEqual(extractTokenUsage({ total: 100.4 }), 100);
    assert.strictEqual(extractTokenUsage({ total: 100.5 }), 101);
    assert.strictEqual(extractTokenUsage({ input: 10.3, output: 20.4 }), 31);
  });

  it("parses string numeric values", () => {
    assert.strictEqual(extractTokenUsage({ total: "150" }), 150);
    assert.strictEqual(extractTokenUsage({ input: "10", output: "20" }), 30);
  });

  it("returns null for non-numeric string values", () => {
    assert.strictEqual(extractTokenUsage({ total: "abc" }), null);
  });

  it("handles empty string values", () => {
    assert.strictEqual(extractTokenUsage({ total: "" }), null);
  });
});

// ── classifyWorkRoundOutcome ───────────────────────────────────────

describe("classifyWorkRoundOutcome", () => {
  it("returns empty_output for empty string", () => {
    assert.strictEqual(classifyWorkRoundOutcome(""), "empty_output");
  });

  it("returns no_work for NO_WORK_AVAILABLE", () => {
    assert.strictEqual(classifyWorkRoundOutcome("NO_WORK_AVAILABLE"), "no_work");
  });

  it("returns no_work for output containing NO_WORK_AVAILABLE", () => {
    assert.strictEqual(
      classifyWorkRoundOutcome("Some prefix\nNO_WORK_AVAILABLE\nSuffix"),
      "no_work",
    );
  });

  it("returns work_done for STATUS: done", () => {
    assert.strictEqual(classifyWorkRoundOutcome("STATUS: done"), "work_done");
  });

  it("returns work_done for STATUS:done (no space)", () => {
    assert.strictEqual(classifyWorkRoundOutcome("STATUS:done"), "work_done");
  });

  it("returns work_failed for STATUS: fail", () => {
    assert.strictEqual(classifyWorkRoundOutcome("STATUS: fail"), "work_failed");
  });

  it("returns work_failed for STATUS: failed", () => {
    assert.strictEqual(classifyWorkRoundOutcome("STATUS: failed"), "work_failed");
  });

  it("returns work_failed for STATUS: error", () => {
    assert.strictEqual(classifyWorkRoundOutcome("STATUS: error"), "work_failed");
  });

  it("returns work_failed for STATUS: FAIL (case insensitive)", () => {
    assert.strictEqual(classifyWorkRoundOutcome("STATUS: FAIL"), "work_failed");
  });

  it("returns other_output for unrecognized output", () => {
    assert.strictEqual(classifyWorkRoundOutcome("Just some text"), "other_output");
  });

  it("returns other_output for partial STATUS match", () => {
    assert.strictEqual(classifyWorkRoundOutcome("STATUS: pending"), "other_output");
  });
});

// ── parseWorkRoundMetadata ─────────────────────────────────────────

describe("parseWorkRoundMetadata", () => {
  it("returns defaults for empty string", () => {
    const meta = parseWorkRoundMetadata("");
    assert.strictEqual(meta.assistantOutput, "");
    assert.strictEqual(meta.tokenUsage, null);
    assert.strictEqual(meta.runId, null);
    assert.strictEqual(meta.stepId, null);
    assert.strictEqual(meta.jsonMetadataDetected, false);
  });

  it("returns defaults for whitespace-only string", () => {
    const meta = parseWorkRoundMetadata("   \n  \t  ");
    assert.strictEqual(meta.assistantOutput, "");
    assert.strictEqual(meta.tokenUsage, null);
    assert.strictEqual(meta.jsonMetadataDetected, false);
  });

  it("returns non-JSON text as assistantOutput with jsonMetadataDetected=false", () => {
    const meta = parseWorkRoundMetadata("Hello world");
    assert.strictEqual(meta.assistantOutput, "Hello world");
    assert.strictEqual(meta.tokenUsage, null);
    assert.strictEqual(meta.jsonMetadataDetected, false);
  });

  it("extracts run_id from non-JSON text", () => {
    const uuid = "12345678-1234-5678-9abc-def012345678";
    const meta = parseWorkRoundMetadata(`run_id: "${uuid}"`);
    assert.strictEqual(meta.runId, uuid);
  });

  it("extracts step_id from non-JSON text", () => {
    const uuid = "87654321-4321-1234-aabb-ccdd11223344";
    const meta = parseWorkRoundMetadata(`step_id="${uuid}"`);
    assert.strictEqual(meta.stepId, uuid);
  });

  it("parses JSON message_end event with assistant text", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Task completed successfully",
        usage: { total: 42 },
      },
    });
    const meta = parseWorkRoundMetadata(output);
    assert.strictEqual(meta.assistantOutput, "Task completed successfully");
    assert.strictEqual(meta.tokenUsage, 42);
    assert.strictEqual(meta.jsonMetadataDetected, true);
  });

  it("parses JSON message_end with string content", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: "Simple text response",
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    });
    const meta = parseWorkRoundMetadata(output);
    assert.strictEqual(meta.assistantOutput, "Simple text response");
    assert.strictEqual(meta.tokenUsage, 30);
  });

  it("parses JSON message_end with array content", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ],
        usage: { total: 5 },
      },
    });
    const meta = parseWorkRoundMetadata(output);
    assert.strictEqual(meta.assistantOutput, "First part\nSecond part");
    assert.strictEqual(meta.tokenUsage, 5);
  });

  it("ignores non-assistant message_end events", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "user",
        content: "User message",
        usage: { total: 99 },
      },
    });
    const meta = parseWorkRoundMetadata(output);
    assert.strictEqual(meta.tokenUsage, null);
  });

  it("collects text fragments from tool_execution events", () => {
    const uuid = "11111111-2222-3333-9bbb-555566667777";
    const output = JSON.stringify({
      type: "tool_execution_result",
      output: `run_id: "${uuid}"`,
    });
    const meta = parseWorkRoundMetadata(output);
    assert.strictEqual(meta.runId, uuid);
    assert.strictEqual(meta.jsonMetadataDetected, true);
  });

  it("handles multiple JSON lines", () => {
    const line1 = JSON.stringify({ type: "tool_execution_start", tool: "bash" });
    const line2 = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: "Done", usage: { total: 7 } },
    });
    const meta = parseWorkRoundMetadata(`${line1}\n${line2}`);
    assert.strictEqual(meta.assistantOutput, "Done");
    assert.strictEqual(meta.tokenUsage, 7);
    assert.strictEqual(meta.jsonMetadataDetected, true);
  });

  it("ignores malformed JSON lines", () => {
    const meta = parseWorkRoundMetadata('{invalid json}\nNot JSON at all');
    assert.strictEqual(meta.jsonMetadataDetected, false);
  });

  it("handles mixed JSON and non-JSON lines", () => {
    const jsonLine = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: "Result", usage: { total: 3 } },
    });
    const meta = parseWorkRoundMetadata(`Some text\n${jsonLine}\nMore text`);
    assert.strictEqual(meta.assistantOutput, "Result");
    assert.strictEqual(meta.tokenUsage, 3);
    assert.strictEqual(meta.jsonMetadataDetected, true);
  });

  it("falls back to full output when no assistant text found", () => {
    const output = JSON.stringify({ type: "other_event", data: "test" });
    const meta = parseWorkRoundMetadata(output);
    assert.ok(meta.assistantOutput.length > 0);
    assert.strictEqual(meta.jsonMetadataDetected, true);
  });

  it("handles message_end without usage", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: "No usage info" },
    });
    const meta = parseWorkRoundMetadata(output);
    assert.strictEqual(meta.assistantOutput, "No usage info");
    assert.strictEqual(meta.tokenUsage, null);
  });

  it("handles message_end with null usage", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: "Null usage", usage: null },
    });
    const meta = parseWorkRoundMetadata(output);
    assert.strictEqual(meta.tokenUsage, null);
  });
});

// ── tryMarkJobInFlight ─────────────────────────────────────────────

describe("tryMarkJobInFlight", () => {
  it("returns true for first call with a job id", () => {
    const jobId = `test-job-${Date.now()}-${Math.random()}`;
    assert.strictEqual(tryMarkJobInFlight(jobId), true);
  });

  it("returns false for second call with same job id", () => {
    const jobId = `test-job-dup-${Date.now()}-${Math.random()}`;
    assert.strictEqual(tryMarkJobInFlight(jobId), true);
    assert.strictEqual(tryMarkJobInFlight(jobId), false);
  });

  it("returns true for different job ids", () => {
    const job1 = `test-job-a-${Date.now()}-${Math.random()}`;
    const job2 = `test-job-b-${Date.now()}-${Math.random()}`;
    assert.strictEqual(tryMarkJobInFlight(job1), true);
    assert.strictEqual(tryMarkJobInFlight(job2), true);
  });

  it("handles empty string job id", () => {
    // Empty string is still a valid key — first call succeeds
    // (may already be in-flight from other tests, so just verify it returns boolean)
    const result = tryMarkJobInFlight("");
    assert.ok(typeof result === "boolean");
  });
});

// ── buildDispatchRoundContext ──────────────────────────────────────

describe("buildDispatchRoundContext", () => {
  function makeJob(overrides: Partial<CronJobInfo> = {}): CronJobInfo {
    return {
      id: "canarinho-wf-1-run-1-agent-1",
      workflowId: "wf-1",
      runId: "run-1",
      agentId: "agent-1",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("builds context with all fields populated", () => {
    const job = makeJob({ model: "gpt-4", harnessType: "pi" });
    const agent = { id: "worker", role: "worker", workspace: { baseDir: "/tmp" } } as any;
    const ctx = buildDispatchRoundContext(job, agent, 120, "/work/dir");
    assert.strictEqual(ctx.jobId, job.id);
    assert.strictEqual(ctx.runId, "run-1");
    assert.strictEqual(ctx.workflowId, "wf-1");
    assert.strictEqual(ctx.agentId, "agent-1");
    assert.strictEqual(ctx.role, "worker");
    assert.strictEqual(ctx.timeoutSeconds, 120);
    assert.strictEqual(ctx.workdir, "/work/dir");
    assert.strictEqual(ctx.workingDirectoryForHarness, "/work/dir");
    assert.strictEqual(ctx.model, "gpt-4");
    assert.strictEqual(ctx.harnessType, "pi");
  });

  it("infers role when agent.role is undefined", () => {
    const job = makeJob();
    const agent = { id: "planner", workspace: { baseDir: "/tmp" } } as any;
    const ctx = buildDispatchRoundContext(job, agent, 60, undefined);
    assert.ok(typeof ctx.role === "string");
    assert.ok(ctx.role.length > 0);
  });

  it("uses workModel when model is undefined", () => {
    const job = makeJob({ workModel: "claude-3" });
    const agent = { id: "worker", role: "worker", workspace: { baseDir: "/tmp" } } as any;
    const ctx = buildDispatchRoundContext(job, agent, 30, "/work");
    assert.strictEqual(ctx.model, "claude-3");
  });

  it("uses job.model when both agent.model and workModel are undefined", () => {
    const job = makeJob({ model: "job-model" });
    const agent = { id: "worker", role: "worker", workspace: { baseDir: "/tmp" } } as any;
    const ctx = buildDispatchRoundContext(job, agent, 30, "/work");
    assert.strictEqual(ctx.model, "job-model");
  });

  it("defaults harnessType to pi when undefined", () => {
    const job = makeJob();
    const agent = { id: "worker", role: "worker", workspace: { baseDir: "/tmp" } } as any;
    const ctx = buildDispatchRoundContext(job, agent, 30, "/work");
    assert.strictEqual(ctx.harnessType, "pi");
  });

  it("handles undefined workingDirectoryForHarness", () => {
    const job = makeJob();
    const agent = { id: "worker", role: "worker", workspace: { baseDir: "/tmp" } } as any;
    const ctx = buildDispatchRoundContext(job, agent, 30, undefined);
    assert.strictEqual(ctx.workdir, undefined);
    assert.strictEqual(ctx.workingDirectoryForHarness, undefined);
  });

  it("prefers agent.model over job.model and workModel", () => {
    const job = makeJob({ model: "job-model", workModel: "work-model" });
    const agent = { id: "worker", role: "worker", model: "agent-model", workspace: { baseDir: "/tmp" } } as any;
    const ctx = buildDispatchRoundContext(job, agent, 30, "/work");
    assert.strictEqual(ctx.model, "agent-model");
  });
});

// ── findHermesBinary ───────────────────────────────────────────────

describe("findHermesBinary", () => {
  const savedPath = process.env.PATH;
  const savedHermes = process.env.canarinho_HERMES_BINARY;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-test-"));
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    process.env.canarinho_HERMES_BINARY = savedHermes;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns canarinho_HERMES_BINARY when set and executable", () => {
    const fakeBin = path.join(tmpDir, "hermes");
    fs.writeFileSync(fakeBin, "#!/bin/bash\necho hermes\n");
    fs.chmodSync(fakeBin, 0o755);
    process.env.canarinho_HERMES_BINARY = fakeBin;
    assert.strictEqual(findHermesBinary(), fakeBin);
  });

  it("throws when canarinho_HERMES_BINARY is set but not executable", () => {
    const fakeBin = path.join(tmpDir, "hermes");
    fs.writeFileSync(fakeBin, "#!/bin/bash\necho hermes\n");
    fs.chmodSync(fakeBin, 0o644); // not executable
    process.env.canarinho_HERMES_BINARY = fakeBin;
    assert.throws(
      () => findHermesBinary(),
      /canarinho_HERMES_BINARY set but not executable/,
    );
  });

  it("finds hermes on PATH when env not set", () => {
    const fakeBin = path.join(tmpDir, "hermes");
    fs.writeFileSync(fakeBin, "#!/bin/bash\necho hermes\n");
    fs.chmodSync(fakeBin, 0o755);
    process.env.canarinho_HERMES_BINARY = "";
    process.env.PATH = tmpDir;
    assert.strictEqual(findHermesBinary(), fakeBin);
  });

  it("throws when hermes not found anywhere", () => {
    process.env.canarinho_HERMES_BINARY = "";
    process.env.PATH = "/usr/bin:/bin";
    assert.throws(
      () => findHermesBinary(),
      /hermes binary not found in PATH/,
    );
  });
});

// ── Exported constants ─────────────────────────────────────────────

describe("exported constants", () => {
  it("DISPATCH_INTERVAL_MS is 15000", () => {
    assert.strictEqual(DISPATCH_INTERVAL_MS, 15_000);
  });

  it("HARNESS_TEARDOWN_GRACE_MS is 10000", () => {
    assert.strictEqual(HARNESS_TEARDOWN_GRACE_MS, 10_000);
  });
});
