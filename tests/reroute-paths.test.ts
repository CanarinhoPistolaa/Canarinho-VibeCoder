// tests/reroute-paths.test.ts
// Comprehensive unit tests for RETR (Retry Routing) across all exhaustion paths.
// Covers edge cases not covered by the main step-ops test suite:
//   - rugpull path intact after budget exhaustion
//   - retry_feedback truncation at 200-char boundary
//   - claim ownership fields cleared on consumer reset
//   - invalid target rejection in completeStep and orphan-recovery paths

//   - first-step self-reference (no upstream) is rejected

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  failStep,
  completeStep,
  claimStep,
  advancePipeline,
  recoverOrphanedStepsForAgent,
} from "../dist/installer/step-ops.js";
import { getRunEvents } from "../dist/installer/events.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ══════════════════════════════════════════════════════════════════════
// Workflow YAML fixtures
// ══════════════════════════════════════════════════════════════════════

// Standard two-step workflow: produce (idx 0) → consume (idx 1)
// consume declares on_fail.retry_step: produce
const rerouteWorkflowYaml = `
id: test-reroute-paths
agents:
  - id: producer
    workspace:
      baseDir: .
      files: {}
  - id: consumer
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: producer
    input: "Produce output"
    expects: "STATUS: done"
    max_retries: 3
  - id: consume
    agent: consumer
    input: "Consume {{output}}"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: produce
`;

// Three-step workflow with intermediate step: a (0) → b (1) → c (2).
// c declares retry_step: a — reroute must skip over b.
const threeStepsYaml = `
id: test-reroute-three
agents:
  - id: a1
    workspace:
      baseDir: .
      files: {}
  - id: a2
    workspace:
      baseDir: .
      files: {}
steps:
  - id: produce
    agent: a1
    input: "Produce"
    expects: "STATUS: done"
    max_retries: 3
  - id: middle
    agent: a2
    input: "Middle"
    expects: "STATUS: done"
    max_retries: 3
  - id: consume
    agent: a2
    input: "Consume"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: produce
`;

// Consumer target is downstream (step_index higher than consumer) — invalid
const downstreamTargetYaml = `
id: test-reroute-downstream
agents:
  - id: a1
    workspace:
      baseDir: .
      files: {}
steps:
  - id: step_a
    agent: a1
    input: "A"
    expects: "STATUS: done"
    max_retries: 3
  - id: step_b
    agent: a1
    input: "B"
    expects: "STATUS: done"
    max_retries: 3
    on_fail:
      retry_step: step_c
  - id: step_c
    agent: a1
    input: "C"
    expects: "STATUS: done"
    max_retries: 3
`;

// First step (idx 0) targets itself — no upstream step exists, invalid
const firstStepSelfRefYaml = `
id: test-reroute-first-step
agents:
  - id: a1
    workspace:
      baseDir: .
      files: {}
steps:
  - id: step1
    agent: a1
    input: "Step 1"
    expects: "STATUS: done"
    max_retries: 2
    on_fail:
      retry_step: step1
`;

// ══════════════════════════════════════════════════════════════════════
// Test suite
// ══════════════════════════════════════════════════════════════════════

describe("RETR: Comprehensive Reroute Paths", () => {
  let _savedStateDir: string | undefined;
  let _savedDbPath: string | undefined;
  let _isolationDir: string;
  let _workflowsDir: string;

  before(() => {
    _savedStateDir = process.env.TAMANDUA_STATE_DIR;
    _savedDbPath = process.env.TAMANDUA_DB_PATH;
    _isolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-reroute-paths-"));
    process.env.TAMANDUA_STATE_DIR = _isolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_isolationDir, "tamandua.db");

    // Create workflow dirs
    _workflowsDir = path.join(_isolationDir, "workflows");
    const workflows = {
      "test-reroute-paths": rerouteWorkflowYaml,
      "test-reroute-three": threeStepsYaml,
      "test-reroute-downstream": downstreamTargetYaml,
      "test-reroute-first-step": firstStepSelfRefYaml,
    };
    for (const [id, yml] of Object.entries(workflows)) {
      const dir = path.join(_workflowsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "workflow.yml"), yml);
    }
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_isolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  async function getTestDb() {
    return (await import("../dist/db.js")).getDb();
  }

  /**
   * Insert a run with its steps. Returns runId and per-step { rowId, step_id }.
   */
  function insertRunAndSteps(
    db: ReturnType<typeof import("../dist/db.js").getDb>,
    workflowId: string,
    stepsData: Array<{
      step_id: string;
      agent_id: string;
      step_index: number;
      status: string;
      retry_count: number;
      max_retries: number;
      input_template: string;
      expects: string;
      type?: string;
      output?: string;
      claim_job_id?: string | null;
      claim_pid?: number | null;
      claim_pgid?: number | null;
    }>,
  ): { runId: string; stepRows: Array<{ rowId: string; step_id: string }> } {
    const runId = crypto.randomUUID();
    const now = ts();
    const seededContext = JSON.stringify({ task: "test task", repo: "/tmp/repo", branch: "test-branch" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, ?, 'test task', 'running', ?, 0, ?, ?)"
    ).run(runId, workflowId, seededContext, now, now);

    const stepRows: Array<{ rowId: string; step_id: string }> = [];
    for (const sd of stepsData) {
      const rowId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
         status, retry_count, max_retries, type, output, claim_job_id, claim_pid, claim_pgid,
         created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rowId, runId, sd.step_id, sd.agent_id, sd.step_index, sd.input_template,
        sd.expects, sd.status, sd.retry_count, sd.max_retries,
        sd.type ?? "single", sd.output ?? null,
        sd.claim_job_id ?? null, sd.claim_pid ?? null, sd.claim_pgid ?? null,
        now, now,
      );
      stepRows.push({ rowId, step_id: sd.step_id });
    }

    return { runId, stepRows };
  }

  // ────────────────────────────────────────────────────────────────
  // Gap 1: retry_feedback truncation at 200-char boundary
  // ────────────────────────────────────────────────────────────────

  describe("retry_feedback truncation", () => {
    it("truncates error messages longer than 200 chars in producer feedback", async () => {
      const db = await getTestDb();
      // Build an error string longer than 200 chars
      const longPrefix = "A".repeat(190);
      const longError = `${longPrefix} and then some extra text that makes it way over 200 characters total`;

      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = await failStep(consumerRowId, longError);
      assert.equal(result.status, "rerouted");

      // Producer output must contain truncated feedback (≤ 200 chars from error + metadata)
      const producer = db.prepare("SELECT output FROM steps WHERE id = ?").get(producerRowId) as { output: string | null };
      assert.ok(producer.output, "producer must have output");
      // The full feedback includes metadata like 'Reroute from "consume" (reroute 1/2). Consumer failure: '
      // The error part should be truncated with "..."
      assert.ok(producer.output!.includes("..."), `expect truncation ellipsis, got: ${producer.output!.slice(0, 100)}`);
      // The original long error should NOT appear in full
      assert.ok(!producer.output!.includes(longError), "full long error must NOT appear in feedback");
      // The truncation should preserve at least 197 chars of the original error
      assert.ok(producer.output!.includes(longPrefix), `truncated output should contain the first 190 chars prefix, got: ${producer.output!.slice(0, 300)}`);
    });

    it("does NOT truncate error messages under 200 chars", async () => {
      const db = await getTestDb();
      const shortError = "Consumer failed: invalid output format";

      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = await failStep(consumerRowId, shortError);
      assert.equal(result.status, "rerouted");

      const producer = db.prepare("SELECT output FROM steps WHERE id = ?").get(producerRowId) as { output: string | null };
      assert.ok(producer.output, "producer must have output");
      // Short error should appear in full (no truncation)
      assert.ok(producer.output!.includes(shortError), `short error should appear in full, got: ${producer.output}`);
      // ... is part of the full Reroute messaging, not the error
      // The error itself should be intact
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 2: claim ownership fields cleared on consumer reset
  // ────────────────────────────────────────────────────────────────

  describe("claim ownership reset on consumer", () => {
    it("clears claim_job_id, claim_pid, and claim_pgid when consumer is reset to waiting", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        // Consumer claimed by a worker (has claim ownership), at retry exhaustion
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done", claim_job_id: "job-123", claim_pid: 9999, claim_pgid: 9998 },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      // Verify claim ownership is set before reroute
      const before = db.prepare("SELECT claim_job_id, claim_pid, claim_pgid FROM steps WHERE id = ?").get(consumerRowId) as { claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null };
      assert.equal(before.claim_job_id, "job-123");
      assert.equal(before.claim_pid, 9999);
      assert.equal(before.claim_pgid, 9998);

      const result = await failStep(consumerRowId, "Consumer crash");
      assert.equal(result.status, "rerouted");

      // After reroute, claim ownership must be cleared
      const after = db.prepare("SELECT status, retry_count, claim_job_id, claim_pid, claim_pgid FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number; claim_job_id: string | null; claim_pid: number | null; claim_pgid: number | null };
      assert.equal(after.status, "waiting");
      assert.equal(after.retry_count, 0);
      assert.equal(after.claim_job_id, null, "claim_job_id must be null after reset");
      assert.equal(after.claim_pid, null, "claim_pid must be null after reset");
      assert.equal(after.claim_pgid, null, "claim_pgid must be null after reset");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 4: invalid retry_step in completeStep expects-validation path
  // ────────────────────────────────────────────────────────────────

  describe("completeStep expects-validation invalid target", () => {
    it("rejects downstream retry_step target in completeStep expectations path", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-downstream", [
        { step_id: "step_a", agent_id: "a1", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "A", expects: "STATUS: done", output: "STATUS: done" },
        // step_b targets step_c (idx 2) which is downstream from step_b (idx 1) — invalid
        { step_id: "step_b", agent_id: "a1", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "B", expects: "STATUS: done", type: "single" },
        { step_id: "step_c", agent_id: "a1", step_index: 2, status: "waiting", retry_count: 0, max_retries: 3, input_template: "C", expects: "STATUS: done" },
      ]);

      const stepBRowId = stepRows.find(s => s.step_id === "step_b")!.rowId;

      // completeStep with invalid output → expects validation fails → retries exhausted → reroute → invalid target
      const result = completeStep(stepBRowId, "bad output without STATUS line");
      assert.equal(result.status, "failed", "should fail on invalid retry_step target, got: " + JSON.stringify(result));

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed");

      // Step must be failed (the invalid_target error is logged, not written to output)
      const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepBRowId) as { status: string };
      assert.equal(step.status, "failed", "step must be failed");

      // No reroute events (invalid target rejected the reroute)
      const events = getRunEvents(runId);
      const rerouteEvents = events.filter(e => e.event === "step.rerouted");
      assert.equal(rerouteEvents.length, 0, "no reroute events for invalid target");

      // run.failed event fires
      const runFailedEvents = events.filter(e => e.event === "run.failed");
      assert.equal(runFailedEvents.length, 1, "run.failed must fire");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 5: invalid retry_step in orphan-recovery path
  // ────────────────────────────────────────────────────────────────

  describe("orphan-recovery invalid target", () => {
    it("rejects downstream retry_step target in orphan-recovery path", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-downstream", [
        { step_id: "step_a", agent_id: "a1", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "A", expects: "STATUS: done", output: "STATUS: done" },
        // step_b targets step_c which is downstream — invalid
        { step_id: "step_b", agent_id: "a1", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "B", expects: "STATUS: done", type: "single" },
        { step_id: "step_c", agent_id: "a1", step_index: 2, status: "waiting", retry_count: 0, max_retries: 3, input_template: "C", expects: "STATUS: done" },
      ]);

      // Orphan recovery for agent "a1": step_b is running with exhausted retries.
      // retry_step points to downstream step_c → invalid → should fail (not recover).
      const result = recoverOrphanedStepsForAgent("a1", runId);

      assert.equal(result.failed, 1, `step should be failed on invalid target, got failed=${result.failed}`);
      assert.equal(result.recovered, 0, `no steps should be recovered, got recovered=${result.recovered}`);

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed");

      // Step must be failed (invalid_target error is logged, output is the generic orphan failure message)
      const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepRows[1].rowId) as { status: string };
      assert.equal(step.status, "failed", "step must be failed");

      // No reroute events (invalid target rejected the reroute)
      const events = getRunEvents(runId);
      const rerouteEvents = events.filter(e => e.event === "step.rerouted");
      assert.equal(rerouteEvents.length, 0, "no reroute events for invalid target");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 6: first-step self-reference (no upstream) is rejected
  // ────────────────────────────────────────────────────────────────

  describe("first-step self-reference", () => {
    it("rejects retry_step pointing to itself (first step, no upstream)", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-first-step", [
        // step1 is the only step (idx 0) and targets itself — invalid
        { step_id: "step1", agent_id: "a1", step_index: 0, status: "running", retry_count: 2, max_retries: 2, input_template: "Step 1", expects: "STATUS: done" },
      ]);

      const stepRowId = stepRows.find(s => s.step_id === "step1")!.rowId;

      const result = await failStep(stepRowId, "Self-referencing step failed");
      assert.equal(result.status, "failed", "should fail on self-reference (no upstream)");

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 7: rugpull path intact after budget exhaustion
  // ────────────────────────────────────────────────────────────────

  describe("rugpull path intact after budget exhaustion", () => {
    it("runs the full failure path (step.failed, run.failed, step.reroute_budget_exhausted) after budget exhaustion", async () => {
      // This test proves that after reroute budget exhaustion, the normal failure
      // path runs correctly — including step.failed/run.failed events
      // and the rugpull setImmediate block (which we verify
      // indirectly by checking the run's terminal state and events).
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      // Set reroute_count to budget (2) — budget exhausted
      db.prepare("UPDATE steps SET reroute_count = 2 WHERE id = ?").run(consumerRowId);

      const result = await failStep(consumerRowId, "Final consumer failure after all reroutes");
      assert.equal(result.status, "failed", "should fail when reroute budget exhausted");

      // Run must be failed
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed");

      // Consumer must be failed
      const consumer = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number };
      assert.equal(consumer.status, "failed", "consumer step should be failed");
      assert.equal(consumer.retry_count, 3, "consumer retry_count should be incremented (2+1=3)");

      // Events: step.failed, run.failed, step.reroute_budget_exhausted
      const events = getRunEvents(runId);

      const failedEvents = events.filter(e => e.event === "step.failed");
      assert.equal(failedEvents.length, 1, "step.failed event must be emitted");

      const runFailedEvents = events.filter(e => e.event === "run.failed");
      assert.equal(runFailedEvents.length, 1, "run.failed event must be emitted");

      // No step.escalation events (escalation concept removed)
      const escalationEvents = events.filter(e => e.event === "step.escalation");
      assert.equal(escalationEvents.length, 0, "step.escalation must NOT be emitted");

      const budgetEvents = events.filter(e => e.event === "step.reroute_budget_exhausted");
      assert.equal(budgetEvents.length, 1, "step.reroute_budget_exhausted must be emitted");

      // No step.rerouted events (budget was already exhausted)
      const rerouteEvents = events.filter(e => e.event === "step.rerouted");
      assert.equal(rerouteEvents.length, 0, "no reroute events when budget exhausted");
    });

    it("rugpull setImmediate path is reachable after budget exhaustion (run terminal state is correct)", async () => {
      // The rugpull detection runs in a fire-and-forget setImmediate.
      // We can't directly test it without a real git repo, but we CAN verify
      // that the terminal state after budget exhaustion is correct:
      // - run is failed
      // - cron teardown is scheduled (verified by run status)
      // - step output contains the error
      //
      // This confirms the failure path (which includes the rugpull block)
      // is correctly reached and does not throw.

      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      // Budget exhausted for this test
      db.prepare("UPDATE steps SET reroute_count = 2 WHERE id = ?").run(consumerRowId);

      const result = await failStep(consumerRowId, "Terminal failure");
      assert.equal(result.status, "failed");

      // Run terminal state
      const run = db.prepare("SELECT status, updated_at FROM runs WHERE id = ?").get(runId) as { status: string; updated_at: string };
      assert.equal(run.status, "failed");
      assert.ok(run.updated_at, "run should have updated_at set");

      // Step terminal state
      const step = db.prepare("SELECT status, output, retry_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; output: string | null; retry_count: number };
      assert.equal(step.status, "failed");
      assert.equal(step.retry_count, 3, "retry_count should be final exhausted value (2+1)");
      assert.ok(step.output?.includes("Terminal failure"), `step output should contain error, got: ${step.output}`);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 8: completeStep with no retry_step (just max_retries exhaustion)
  // ────────────────────────────────────────────────────────────────

  describe("completeStep expects fallback to normal failure", () => {
    it("falls through to normal run failure when no retry_step declared and expects validation fails at max_retries", async () => {
      // Use produce step (idx 0) which has no on_fail declared
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "running", retry_count: 3, max_retries: 3, input_template: "Produce", expects: "STATUS: done", type: "single" },
      ]);

      const stepRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = completeStep(stepRowId, "no STATUS marker here");
      // produce has no on_fail block → no retry_step → normal failure
      assert.equal(result.status, "failed", "should fail normally when no retry_step, got: " + JSON.stringify(result));

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "failed", "run should be failed");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 9: consumer output cleared and reset to null on reroute
  // ────────────────────────────────────────────────────────────────

  describe("consumer output cleared on reroute", () => {
    it("clears consumer output to null when resetting to waiting", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done" },
        // Consumer has a previous error output from earlier retries
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done", output: "Previous error output from earlier retry" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;

      const result = await failStep(consumerRowId, "New consumer failure");
      assert.equal(result.status, "rerouted");

      // Consumer output must be null (cleared)
      const consumer = db.prepare("SELECT output FROM steps WHERE id = ?").get(consumerRowId) as { output: string | null };
      assert.equal(consumer.output, null, "consumer output must be null after reset");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 10: intermediate done steps untouched (3-step workflow)
  // ────────────────────────────────────────────────────────────────

  describe("3-step reroute preserves intermediate steps", () => {
    it("leaves done intermediate step untouched when rerouting over it", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-three", [
        { step_id: "produce", agent_id: "a1", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done\nDATA: initial" },
        { step_id: "middle", agent_id: "a2", step_index: 1, status: "done", retry_count: 0, max_retries: 3, input_template: "Middle", expects: "STATUS: done", output: "STATUS: done\nMIDDLE: processed" },
        { step_id: "consume", agent_id: "a2", step_index: 2, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const middleRowId = stepRows.find(s => s.step_id === "middle")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      const result = await failStep(consumerRowId, "Consumer invalid");
      assert.equal(result.status, "rerouted");

      // Middle step untouched
      const middle = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(middleRowId) as { status: string; retry_count: number; output: string | null };
      assert.equal(middle.status, "done", "intermediate done step stays done");
      assert.equal(middle.retry_count, 0, "intermediate retry_count unchanged");
      assert.equal(middle.output, "STATUS: done\nMIDDLE: processed", "intermediate output preserved");

      // Producer re-pended
      const producer = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(producerRowId) as { status: string; retry_count: number };
      assert.equal(producer.status, "pending", "producer re-pended");
      assert.equal(producer.retry_count, 0, "producer retry_count unchanged");

      // Consumer reset
      const consumer = db.prepare("SELECT status, retry_count, reroute_count FROM steps WHERE id = ?").get(consumerRowId) as { status: string; retry_count: number; reroute_count: number };
      assert.equal(consumer.status, "waiting", "consumer reset to waiting");
      assert.equal(consumer.retry_count, 0, "consumer retry_count reset");
      assert.equal(consumer.reroute_count, 1, "consumer reroute_count incremented");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Gap 11: advancePipeline re-pends consumer after producer re-done
  // ────────────────────────────────────────────────────────────────

  describe("advancePipeline after reroute", () => {
    it("advances consumer from waiting to pending after rerouted producer completes", async () => {
      const db = await getTestDb();
      const { runId, stepRows } = insertRunAndSteps(db, "test-reroute-paths", [
        { step_id: "produce", agent_id: "producer", step_index: 0, status: "done", retry_count: 0, max_retries: 3, input_template: "Produce", expects: "STATUS: done", output: "STATUS: done\nOUTPUT: val" },
        { step_id: "consume", agent_id: "consumer", step_index: 1, status: "running", retry_count: 2, max_retries: 2, input_template: "Consume", expects: "STATUS: done" },
      ]);

      const consumerRowId = stepRows.find(s => s.step_id === "consume")!.rowId;
      const producerRowId = stepRows.find(s => s.step_id === "produce")!.rowId;

      // Trigger reroute
      const failResult = await failStep(consumerRowId, "Consumer failure");
      assert.equal(failResult.status, "rerouted");

      // Consumer waiting, producer pending
      assert.equal((db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string }).status, "waiting");
      assert.equal((db.prepare("SELECT status FROM steps WHERE id = ?").get(producerRowId) as { status: string }).status, "pending");

      // Producer re-completes
      db.prepare("UPDATE steps SET status = 'done', output = 'STATUS: done\nOUTPUT: new-value', updated_at = datetime('now') WHERE id = ?").run(producerRowId);

      // advancePipeline should make consumer pending
      const advResult = advancePipeline(runId);
      assert.equal(advResult.advanced, true, "advancePipeline should advance consumer to pending");

      const consumerAfter = db.prepare("SELECT status FROM steps WHERE id = ?").get(consumerRowId) as { status: string };
      assert.equal(consumerAfter.status, "pending", "consumer should now be pending");
    });
  });
});
