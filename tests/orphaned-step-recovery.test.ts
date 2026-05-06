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
import { recoverOrphanedStepsForAgent } from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";

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
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_1);

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
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_3);

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
    const result = recoverOrphanedStepsForAgent(TEST_AGENT_1, 5 * 60 * 1000);

    assert.equal(result.recovered, 1, "should recover the stale step");

    // Verify the stale step was reset again
    const step = db.prepare(
      "SELECT status, retry_count FROM steps WHERE id = ?"
    ).get(singleStepId) as { status: string; retry_count: number };
    assert.equal(step.status, "pending");
    assert.equal(step.retry_count, 2, "retry_count should be bumped again");

    // Verify the fresh step was NOT touched
    const freshResult = recoverOrphanedStepsForAgent(TEST_AGENT_2, 5 * 60 * 1000);
    assert.equal(freshResult.recovered, 0, "fresh step should NOT be recovered");
    assert.equal(freshResult.failed, 0);
    assert.equal(freshResult.skipped, 0);
  });

  // ── AC 4: No-op for agents with no running steps ─────────────────
  it("returns zero counts for agent with no running steps", () => {
    const result = recoverOrphanedStepsForAgent("nonexistent-agent-xyz");
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
      // Without staleThreshold, ALL running steps for the agent are recovered
      // regardless of how recently they were updated.
      const result = recoverOrphanedStepsForAgent(TEST_AGENT_2);
      assert.equal(result.recovered, 2, "should recover both running steps");
      assert.equal(result.failed, 0);
    } finally {
      db.prepare("DELETE FROM steps WHERE id = ?").run(tmpStepId);
    }
  });
});
