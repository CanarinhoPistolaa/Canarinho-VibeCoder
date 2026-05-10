/**
 * Regression tests for: Step stuck at status='running' after pi SIGKILL
 *
 * Validates:
 * 1. recoverOrphanedStepsForAgent resets a running step to pending,
 *    bumps retry_count, and emits step.timeout events
 * 2. When retry_count exceeds max_retries, the step is marked failed
 *    and step.failed/run.failed events are emitted
 * 3. Stale-claim sweeper (staleThresholdMs param) only recovers steps
 *    whose updated_at is older than the threshold
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverOrphanedStepsForAgent, claimStep, resolveStepContext } from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";

// ── Environment isolation ──────────────────────────────────────────────
// Production modules imported at file scope (getDb, recoverOrphanedStepsForAgent,
// claimStep) call emitEvent() and logger.info/warn which write to
// ~/.tamandua/ by default. Without isolation, test runs pollute the real
// events/all.jsonl and tamandua.log with realistic-looking events.
// TAMANDUA_STATE_DIR controls events/log paths; TAMANDUA_DB_PATH controls
// the DB path. Both must be set because the DB-path resolver is independent
// of the events/log resolver.

const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
const _savedDbPath = process.env.TAMANDUA_DB_PATH;
const _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-orphaned-test-"));
process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");

// Restore original env vars and clean up temp dir when the process exits.
// Node test runner processes exit after all tests complete, so an exit
// handler is the safest way to clean up file-wide setup that has no
// corresponding file-wide teardown hook.
process.on("exit", () => {
  if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
  if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = _savedDbPath;
  try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const TEST_AGENT_1 = "test_sigkill-recovery-agent-1";
const TEST_AGENT_2 = "test_sigkill-recovery-agent-2";
const TEST_AGENT_3 = "test_sigkill-recovery-agent-3";

function ts(): string {
  return new Date().toISOString();
}

describe("recoverOrphanedStepsForAgent", () => {
  let testRunId: string;
  let singleStepId: string;
  let exhaustedStepId: string;
  let freshStepId: string;
  let testRun2Id: string;  // for exhausted test (separate run so failure doesn't affect others)

  before(() => {
    const db = getDb();
    testRunId = crypto.randomUUID();
    testRun2Id = crypto.randomUUID();
    singleStepId = crypto.randomUUID();
    exhaustedStepId = crypto.randomUUID();
    freshStepId = crypto.randomUUID();
    const now = ts();

    // ── Run for single-step recovery test ──
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'test task', 'running', '{}', ?, ?)"
    ).run(testRunId, now, now);

    // Single step: running, retry_count=0, max_retries=2 — should be recovered
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'test-step', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(singleStepId, testRunId, TEST_AGENT_1, now, now);

    // Fresh step: running, but updated_at = now — should NOT be claimed by stale sweeper
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'fresh-step', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(freshStepId, testRunId, TEST_AGENT_2, now, now);

    // ── Run for exhausted retries test ──
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'test exhausted', 'running', '{}', ?, ?)"
    ).run(testRun2Id, now, now);

    // Exhausted step: running, retry_count=2, max_retries=2 — should be marked failed
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'exhausted-step', ?, 0, '', '', 'running', 2, 2, 'single', ?, ?)`
    ).run(exhaustedStepId, testRun2Id, TEST_AGENT_3, now, now);
  });

  after(() => {
    const db = getDb();
    db.prepare("DELETE FROM steps WHERE id IN (?, ?, ?)").run(singleStepId, freshStepId, exhaustedStepId);
    db.prepare("DELETE FROM runs WHERE id IN (?, ?)").run(testRunId, testRun2Id);
  });

  // ── AC 1: SIGKILL recovery — reset to pending, bump retry_count ──
  it("resets a running step to pending and bumps retry_count after SIGKILL", () => {
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_1, testRunId);

    assert.equal(result.recovered, 1, "should recover 1 step");
    assert.equal(result.failed, 0, "should not fail any steps");
    assert.equal(result.skipped, 0, "should not skip any steps");

    const db = getDb();
    const step = db.prepare(
      "SELECT status, retry_count FROM steps WHERE id = ?"
    ).get(singleStepId) as { status: string; retry_count: number };

    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.retry_count, 1, "retry_count should be bumped to 1");

    // Verify that run status is still 'running' (not prematurely failed)
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(testRunId) as { status: string };
    assert.equal(run.status, "running");
  });

  // ── AC 2: Exhausted retries → mark failed ────────────────────────
  it("marks step as failed when retry_count exceeds max_retries", () => {
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_3, testRun2Id);

    assert.equal(result.failed, 1, "should fail 1 step");
    assert.equal(result.recovered, 0, "should not recover any steps");

    const db = getDb();

    // Step should be failed
    const step = db.prepare(
      "SELECT status, retry_count, output FROM steps WHERE id = ?"
    ).get(exhaustedStepId) as { status: string; retry_count: number; output: string };

    assert.equal(step.status, "failed", "step should be marked failed");
    assert.equal(step.retry_count, 3, "retry_count should be bumped to 3");
    assert.ok(step.output.includes("retries exhausted"), "output should mention retries exhausted");

    // Run should also be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(testRun2Id) as { status: string };
    assert.equal(run.status, "failed", "run should be marked failed when retries exhausted");
  });

  // ── AC 3: Stale-claim sweeper — only recovers old-enough steps ────
  it("stale-threshold: recovers old running step, ignores fresh one", () => {
    // Reset the previously-recovered step back to running so the sweeper
    // test has a real target
    const db = getDb();
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    db.prepare(
      "UPDATE steps SET status = 'running', retry_count = 1, updated_at = ? WHERE id = ?"
    ).run(oldTs, singleStepId);

    // Stale threshold: 5 minutes (300,000 ms). The old step (10 min ago) should
    // be recovered, but the fresh step (updated just now) should not.
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_1, testRunId, 5 * 60 * 1000);

    assert.equal(result.recovered, 1, "should recover the stale step");

    // Verify the stale step was reset again
    const step = db.prepare(
      "SELECT status, retry_count FROM steps WHERE id = ?"
    ).get(singleStepId) as { status: string; retry_count: number };
    assert.equal(step.status, "pending");
    assert.equal(step.retry_count, 2, "retry_count should be bumped again");

    // Verify the fresh step was NOT touched
    const freshResult = recoverOrphanedStepsForAgent(TEST_AGENT_2, testRunId, 5 * 60 * 1000);
    assert.equal(freshResult.recovered, 0, "fresh step should NOT be recovered");
    assert.equal(freshResult.failed, 0);
    assert.equal(freshResult.skipped, 0);
  });

  // ── AC 4: No-op for agents with no running steps ─────────────────
  it("returns zero counts for agent with no running steps", () => {
    const result = recoverOrphanedStepsForAgent("nonexistent-agent-xyz", crypto.randomUUID());
    assert.equal(result.recovered, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 0);
  });

  // ── AC 5: Calling without staleThreshold recovers ALL running steps
  it("recovers all running steps when staleThreshold is omitted (post-exit path)", () => {
    const db = getDb();

    // NOTE: freshStepId (from before()) is also running for this agent.
    // The stale-threshold test (AC 3) proved that freshStepId is NOT touched
    // by a stale-threshold query. But without the threshold, it WILL be
    // recovered. Reset freshStepId back to running (retry_count was already
    // bumped to 1 in the stale-threshold test) so we can verify it gets
    // recovered again.
    db.prepare(
      "UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?"
    ).run(freshStepId);

    // Also create a second fresh running step so the count is unambiguous
    const tmpStepId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'tmp-step', ?, 0, '', '', 'running', 0, 2, 'single', datetime('now'), datetime('now'))`
    ).run(tmpStepId, testRunId, TEST_AGENT_2);

    try {
      // Without staleThreshold, ALL running steps for this (agent, run) tuple
      // are recovered regardless of how recently they were updated.
      const result = recoverOrphanedStepsForAgent(TEST_AGENT_2, testRunId);
      assert.equal(result.recovered, 2, "should recover both running steps");
      assert.equal(result.failed, 0);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(tmpStepId);
    }
  });

  // ── AC 6: SIGKILL timeout records timeout_retry in run context ─
  // When recoverOrphanedStepsForAgent is called with a timeoutRetryReason,
  // the run's context must carry `timeout_retry` so the retry prompt includes
  // a signal that the agent's previous attempt was interrupted.
  it("records timeout_retry in run context when timeoutRetryReason is provided", () => {
    const db = getDb();
    const agent = "test_timeout-context-recorder";

    // Create a fresh run + running step
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();
    const contextBefore = JSON.stringify({ repo: "/tmp/test", branch: "fix/bug-123", build_cmd: "npm run build", test_cmd: "npm test" });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'fix bug 123', 'running', ?, ?, ?)"
    ).run(runId, contextBefore, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'fix', ?, 0,
         'BROKEN: {{timeout_retry}}', '',
         'running', 0, 2, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Execute recovery with a timeout reason
      const timeoutReason = "pi timed out after 1800000ms";
      const result = recoverOrphanedStepsForAgent(agent, runId, undefined, timeoutReason);

      assert.equal(result.recovered, 1, "should recover 1 step");
      assert.equal(result.failed, 0);

      // The run's context should now contain timeout_retry
      const runAfter = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(runAfter.context);
      assert.equal(ctx.timeout_retry, timeoutReason,
        "run context must carry timeout_retry after timeout recovery");

      // The step should be back to pending with retry_count bumped
      const step = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };
      assert.equal(step.status, "pending");
      assert.equal(step.retry_count, 1);

      // ── Sub-test: claimStep sees timeout_retry in the resolved input ──
      const claim = claimStep(agent, runId);
      assert.ok(claim.found, "step should be claimable after recovery");
      assert.ok(claim.resolvedInput?.includes(timeoutReason),
        `resolved input should include timeout reason, got: ${claim.resolvedInput?.slice(0, 300)}`);

      // After claim, timeout_retry should be cleared from run context
      const runAfterClaim = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctxAfterClaim = JSON.parse(runAfterClaim.context);
      assert.equal(ctxAfterClaim.timeout_retry, "",
        "timeout_retry should be cleared from run context after claim");

      // Reset step back to running so after() can clean it up
      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(stepUuid);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // ── AC 7: No stale timeout_retry leakage between different retries ──
  it("does NOT set timeout_retry when timeoutRetryReason is omitted (non-timeout exit)", () => {
    const db = getDb();
    const agent = "test_no-context-pollution";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();
    const contextBefore = JSON.stringify({ repo: "/tmp/test" });

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'task', 'running', ?, ?, ?)"
    ).run(runId, contextBefore, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'fix', ?, 0, '', '', 'running', 0, 2, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Recovery WITHOUT a timeout reason (simulates non-timeout exit, e.g. SIGTERM)
      const result = recoverOrphanedStepsForAgent(agent, runId);
      assert.equal(result.recovered, 1, "should recover the step");

      // Context should NOT contain timeout_retry
      const runAfter = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
      const ctx = JSON.parse(runAfter.context);
      assert.ok(!("timeout_retry" in ctx),
        "run context must NOT contain timeout_retry when no reason was provided");

      db.prepare("UPDATE steps SET status = 'running' WHERE id = ?").run(stepUuid);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// Regression: other_output (clean pi exit without STATUS line)
// ══════════════════════════════════════════════════════════════════════

import { classifyPollingRoundOutcome } from "../dist/installer/agent-scheduler.js";

describe("other_output recovery (clean pi exit without STATUS)", () => {
  // ── AC 1: other_output triggers recovery of running step ───────
  it("resets running step to pending when other_output occurs (recoverOrphanedStepsForAgent)", () => {
    const db = getDb();
    const agent = "test_other-output-recovery";
    const runId = crypto.randomUUID();
    const stepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'verify work', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'verify-step', ?, 0, '', '', 'running', 0, 3, 'single', ?, ?)`
    ).run(stepUuid, runId, agent, now, now);

    try {
      // Simulate the other_output handler: call recoverOrphanedStepsForAgent
      // without staleThreshold or timeoutRetryReason (clean exit, not a timeout)
      const result = recoverOrphanedStepsForAgent(agent, runId);

      assert.equal(result.recovered, 1, "should recover 1 running step");
      assert.equal(result.failed, 0, "should not fail any steps");

      const step = db.prepare(
        "SELECT status, retry_count FROM steps WHERE id = ?"
      ).get(stepUuid) as { status: string; retry_count: number };

      assert.equal(step.status, "pending", "step should be reset to pending");
      assert.equal(step.retry_count, 1, "retry_count should be bumped to 1");

      // Run should still be running (not prematurely failed)
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "running");
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(stepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });

  // ── AC 2: heartbeat output is NOT classified as other_output ───
  it("classifyPollingRoundOutcome: heartbeat output is NOT other_output", () => {
    // The fix must NOT modify heartbeat handling — HEARTBEAT_OK must
    // remain a no-op. Verify that the classification function returns
    // "heartbeat", not "other_output".
    assert.equal(
      classifyPollingRoundOutcome("HEARTBEAT_OK"),
      "heartbeat",
      "HEARTBEAT_OK must be classified as heartbeat, not other_output",
    );

    // Also verify with whitespace
    assert.equal(
      classifyPollingRoundOutcome("  HEARTBEAT_OK  "),
      "heartbeat",
      "whitespace-padded HEARTBEAT_OK must still be heartbeat",
    );

    // STATUS: done is NOT other_output
    assert.equal(
      classifyPollingRoundOutcome("STATUS: done\nCHANGES: foo"),
      "work_done",
      "STATUS: done must be classified as work_done, not other_output",
    );

    // STATUS: fail is NOT other_output
    assert.equal(
      classifyPollingRoundOutcome("STATUS: fail\nREASON: timeout"),
      "work_failed",
      "STATUS: fail must be classified as work_failed, not other_output",
    );
  });

  // ── AC 3: Clean exit output without STATUS is other_output ─────
  it("classifyPollingRoundOutcome: clean exit output without STATUS is other_output", () => {
    // This is the exact scenario from the bug report: pi produced a lot
    // of text but never emitted STATUS: done/fail/retry.
    const verifierOutput = "Code checks are comprehensive. Now for visual verification since this has frontend changes. Let me spin up the dev server and inspect.";

    assert.equal(
      classifyPollingRoundOutcome(verifierOutput),
      "other_output",
      "output without STATUS line or HEARTBEAT_OK must be classified as other_output",
    );

    // Empty output is NOT other_output
    assert.equal(
      classifyPollingRoundOutcome(""),
      "empty_output",
      "empty output must be classified as empty_output, not other_output",
    );
  });

  // ── AC 4: other_output with no running step is a no-op ─────────
  it("recoverOrphanedStepsForAgent is a no-op when no running steps exist", () => {
    const result = recoverOrphanedStepsForAgent("agent_with_no_claims_xyz", crypto.randomUUID());

    assert.equal(result.recovered, 0, "should recover 0 steps");
    assert.equal(result.failed, 0, "should fail 0 steps");
    assert.equal(result.skipped, 0, "should skip 0 steps");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Regression: STORIES_JSON parse-wedge bug
// (autoCompleteStepIfRunning swallowed completeStep throws and left the
//  step in 'running' forever — wedging the run until the 45-min sweeper.)
// ══════════════════════════════════════════════════════════════════════

import { autoCompleteStepIfRunning, type PollingRoundMetadata } from "../dist/installer/agent-scheduler.js";

describe("autoCompleteStepIfRunning recovers wedged step on completeStep throw", () => {
  it("STORIES_JSON parse error recovers the running plan step instead of wedging", async () => {
    const db = getDb();
    const agent = "test_stories-json-wedge-recovery";
    const runId = crypto.randomUUID();
    const planStepUuid = crypto.randomUUID();
    const loopStepUuid = crypto.randomUUID();
    const now = ts();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'test-wf', 'verify wedge fix', 'running', '{}', ?, ?)"
    ).run(runId, now, now);

    // Plan step in 'running' — this is the wedged step the auto-complete
    // handler will try (and fail) to mark done because STORIES_JSON parse throws.
    // The input_template embeds {{retry_feedback}} so the test can verify
    // the recovery message reaches the retried planner via resolvedInput.
    const inputTemplate = "Plan task.\nRETRY FEEDBACK:\n{{retry_feedback}}";
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, created_at, updated_at)
       VALUES (?, ?, 'plan', ?, 0, ?, 'STATUS: done', 'running', 0, 2, 'single', ?, ?)`
    ).run(planStepUuid, runId, agent, inputTemplate, now, now);

    // Downstream loop step over stories — completeStep on the plan step
    // calls parseAndInsertStories, which throws on the malformed JSON.
    db.prepare(
      `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
        status, retry_count, max_retries, type, loop_config, created_at, updated_at)
       VALUES (?, ?, 'implement', 'developer', 1, '', 'STATUS: done', 'pending', 0, 2, 'loop',
               '{"over":"stories","completion":"all_done","fresh_session":true}', ?, ?)`
    ).run(loopStepUuid, runId, now, now);

    // Realistic planner output: valid STORIES_JSON array followed by
    // trailing prose — the exact shape that wedged run 24cb9c10.
    const assistantOutput = [
      "STATUS: done",
      "REPO: /home/igorhvr/idm/tamandua",
      "BRANCH: feature/test-wedge",
      'STORIES_JSON: [{"id":"US-001","title":"Test","description":"Test story","acceptanceCriteria":["Tests pass","Typecheck passes"]}]',
      "",
      "Plan summary: this is the trailing prose that breaks the parser.",
    ].join("\n");

    const metadata: PollingRoundMetadata = {
      assistantOutput,
      tokenUsage: 12345,
      runId,
      stepId: planStepUuid,
      jsonMetadataDetected: true,
    };

    const context: Record<string, unknown> = {
      jobId: "test-job",
      runId,
      agentId: agent,
      role: "analysis",
      timeoutSeconds: 1800,
      workdir: "/tmp",
      model: "default",
    };

    try {
      // Must not throw — the swallowed-error path exists by design,
      // but the recovery branch must run before returning.
      await autoCompleteStepIfRunning(context, metadata);

      const step = db.prepare(
        "SELECT status, retry_count, output FROM steps WHERE id = ?"
      ).get(planStepUuid) as { status: string; retry_count: number; output: string | null };

      assert.equal(step.status, "pending", "wedged plan step must be reset to pending");
      assert.equal(step.retry_count, 1, "retry_count must be bumped so on_fail policy fires");
      assert.ok(step.output, "step.output must be populated so retry_feedback surfaces the failure");
      assert.match(
        step.output ?? "",
        /STORIES_JSON|could not be auto-completed/i,
        "step.output should describe the parse failure",
      );

      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "running", "run should remain running so retry can proceed");

      // The retried planner must see the failure detail as RETRY FEEDBACK.
      // claimStep populates context.retry_feedback from step.output when
      // retry_count > 0, then resolves it into the input template — verify
      // the contract end-to-end by claiming and inspecting resolvedInput.
      const claim = claimStep(agent, runId);
      assert.ok(claim.found, "step must be re-claimable after recovery");
      assert.ok(claim.resolvedInput, "resolved input must be present");
      assert.match(
        claim.resolvedInput ?? "",
        /RETRY FEEDBACK:[\s\S]*(STORIES_JSON|could not be auto-completed)/i,
        "next planner attempt must see the parse failure under RETRY FEEDBACK",
      );
    } finally {
      db.prepare("DELETE FROM steps WHERE id IN (?, ?)").run(planStepUuid, loopStepUuid);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
  });
});
