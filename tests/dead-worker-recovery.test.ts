/**
 * Dead-worker recovery (MOTOR-CONTRACT.md C18).
 *
 * When a daemon dies with work rounds in flight (crash, reboot, SIGKILL,
 * or an agent stopping the daemon that schedules it), the interrupted
 * steps sit at status='running' under a dead claim_pid. The reconciler's
 * dead-worker sweep (recoverStepsWithDeadWorkers) requeues them promptly
 * instead of waiting out the 1.5×timeout age-based sweep.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { recoverStepsWithDeadWorkers } from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";

let tempHome: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dead-worker-"));
  const stateDir = path.join(tempHome, ".tamandua");
  fs.mkdirSync(stateDir, { recursive: true });
  saved = {
    HOME: process.env.HOME,
    TAMANDUA_STATE_DIR: process.env.TAMANDUA_STATE_DIR,
    TAMANDUA_DB_PATH: process.env.TAMANDUA_DB_PATH,
    TAMANDUA_CONTROL_PORT: process.env.TAMANDUA_CONTROL_PORT,
  };
  process.env.HOME = tempHome;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");
  process.env.TAMANDUA_CONTROL_PORT = "1"; // dead control plane — nudges no-op
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: spawn a no-op process and let it exit. */
function deadPid(): number {
  const r = spawnSync("true");
  return r.pid ?? 999999;
}

function seedRunWithRunningStep(opts: {
  claimPid: number | null;
  claimPgid?: number | null;
  claimJobId?: string | null;
  runStatus?: string;
  maxRetries?: number;
  retryCount?: number;
}): { runId: string; stepId: string } {
  const db = getDb();
  const runId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', ?, '{}', 0, ?, ?)",
  ).run(runId, opts.runStatus ?? "running", now, now);
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status,
       retry_count, max_retries, claim_pid, claim_pgid, claim_job_id, created_at, updated_at)
     VALUES (?, ?, 'work', 'wf-dead_dev', 0, 'work', '', 'running', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stepId, runId,
    opts.retryCount ?? 0, opts.maxRetries ?? 3,
    opts.claimPid, opts.claimPgid ?? null, opts.claimJobId ?? "tamandua-wf-dead-job",
    now, now,
  );
  return { runId, stepId };
}

function stepStatus(stepId: string): { status: string; retry_count: number } {
  return getDb().prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepId) as {
    status: string;
    retry_count: number;
  };
}

describe("recoverStepsWithDeadWorkers (C18)", () => {
  it("requeues a running step whose worker pid is dead", () => {
    const { runId, stepId } = seedRunWithRunningStep({ claimPid: deadPid() });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 1);
    assert.deepEqual(result.runIds, [runId]);
    const step = stepStatus(stepId);
    assert.equal(step.status, "pending", "step should be requeued for retry");
    assert.equal(step.retry_count, 1, "a retry slot is consumed, mirroring orphan recovery");
  });

  it("leaves steps with a live worker alone", () => {
    const { stepId } = seedRunWithRunningStep({ claimPid: process.pid });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 0);
    assert.equal(stepStatus(stepId).status, "running");
  });

  it("leaves steps without claim ownership to the age-based sweep", () => {
    const { stepId } = seedRunWithRunningStep({ claimPid: null });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 0);
    assert.equal(stepStatus(stepId).status, "running", "no claim_pid → liveness unknown → untouched");
  });

  it("ignores steps of non-running runs", () => {
    const { stepId } = seedRunWithRunningStep({ claimPid: deadPid(), runStatus: "paused" });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 0);
    assert.equal(stepStatus(stepId).status, "running");
  });

  it("exhausts retries and fails the run when the dead worker burned the last retry", () => {
    const { runId, stepId } = seedRunWithRunningStep({
      claimPid: deadPid(),
      retryCount: 3,
      maxRetries: 3,
    });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.failed, 1);
    assert.equal(stepStatus(stepId).status, "failed");
    const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");
  });

  it("recovers multiple dead-worker steps across runs in one sweep", () => {
    const a = seedRunWithRunningStep({ claimPid: deadPid() });
    const b = seedRunWithRunningStep({ claimPid: deadPid() });
    const alive = seedRunWithRunningStep({ claimPid: process.pid });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 2);
    assert.equal(new Set(result.runIds).size, 2);
    assert.equal(stepStatus(a.stepId).status, "pending");
    assert.equal(stepStatus(b.stepId).status, "pending");
    assert.equal(stepStatus(alive.stepId).status, "running");
  });

  it("leaves the step alone when the harness process GROUP survived the daemon (survivor guard)", async () => {
    // Ungraceful daemon death does not kill detached harness children: the
    // agent may still be working. Spawn a detached process (its own group
    // leader) to stand in for the surviving harness group.
    const { spawn } = await import("node:child_process");
    const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      const { stepId } = seedRunWithRunningStep({
        claimPid: deadPid(),
        claimPgid: survivor.pid!,
      });

      const result = recoverStepsWithDeadWorkers();

      assert.equal(result.recovered, 0, "must not requeue while the harness group is alive");
      assert.equal(result.skipped, 1, "the survivor case is reported as skipped");
      assert.equal(stepStatus(stepId).status, "running", "two agents in one workdir is worse than waiting");
    } finally {
      try { process.kill(-survivor.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  });

  it("requeues when both the daemon and the harness group are dead", async () => {
    const { spawnSync } = await import("node:child_process");
    // A pgid guaranteed dead: a short-lived detached leader that already exited.
    const r = spawnSync("true");
    const deadGroup = r.pid ?? 999998;

    const { stepId } = seedRunWithRunningStep({
      claimPid: deadPid(),
      claimPgid: deadGroup,
    });

    const result = recoverStepsWithDeadWorkers();

    assert.equal(result.recovered, 1);
    assert.equal(stepStatus(stepId).status, "pending");
  });

  it("getOwnProcessGroupId returns this process's group (matches ps)", async () => {
    const { getOwnProcessGroupId } = await import("../dist/installer/step-ops.js");
    const { spawnSync } = await import("node:child_process");
    const own = getOwnProcessGroupId();
    assert.ok(own && own > 0, "should self-detect a positive pgid on Linux");
    const psOut = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf-8" });
    assert.equal(own, Number(psOut.stdout.trim()), "must agree with ps");
  });
});

// ══════════════════════════════════════════════════════════════════════
// US-004 WLST Recovery — story-level abandoned_count vs retry_count
// ══════════════════════════════════════════════════════════════════════

/**
 * Seed a run + story + loop step for abandonment recovery testing.
 * The story starts at status='running' with the given abandoned_count and
 * retry_count. The loop step has current_story_id set and status='running'.
 * Returns { runId, storyId, storyRowId, stepRowId }.
 */
function seedStoryRun(opts: {
  agentId?: string;
  abandonedCount?: number;
  retryCount?: number;
  maxRetries?: number;
  backdateSeconds?: number;
} = {}): { runId: string; storyId: string; storyRowId: string; stepRowId: string } {
  const db = getDb();
  const runId = crypto.randomUUID();
  const storyRowId = crypto.randomUUID();
  const stepRowId = crypto.randomUUID();
  const ago = new Date(Date.now() - (opts.backdateSeconds ?? 0) * 1000).toISOString();
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
  ).run(runId, ago, ago);

  db.prepare(
    `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria,
       status, retry_count, max_retries, abandoned_count, created_at, updated_at)
     VALUES (?, ?, 0, 'S1', 'Test', 'desc', '[]', 'running', ?, ?, ?, ?, ?)`,
  ).run(storyRowId, runId, opts.retryCount ?? 0, opts.maxRetries ?? 4, opts.abandonedCount ?? 0, ago, ago);

  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects,
       status, retry_count, max_retries, type, current_story_id, loop_config, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 0, 'Implement', '', 'running', 0, 4, 'loop', ?, ?, ?, ?)`,
  ).run(stepRowId, runId, opts.agentId ?? "wf-dead_dev", storyRowId, JSON.stringify({ over: "stories" }), ago, ago);

  return { runId, storyId: "S1", storyRowId, stepRowId };
}

function storyState(storyRowId: string): {
  status: string; retry_count: number; abandoned_count: number;
} {
  return getDb().prepare(
    "SELECT status, retry_count, abandoned_count FROM stories WHERE id = ?"
  ).get(storyRowId) as { status: string; retry_count: number; abandoned_count: number };
}

describe("recoverOrphanedStepsForAgent — story-level WLST", () => {
  it("increments story.abandoned_count, not story.retry_count", async () => {
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 5,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);

    assert.equal(result.recovered, 1, "story should be recovered");
    assert.equal(result.failed, 0, "story should not be failed");

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count should increment from 0 to 1");
    assert.equal(story.retry_count, 2, "retry_count should be UNCHANGED (not mixed with infra failures)");
  });

  it("increments abandoned_count cumulatively on repeated recoveries", async () => {
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 3,
      retryCount: 1,
      backdateSeconds: 5,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");

    // First recovery
    let result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);
    assert.equal(result.recovered, 1);

    // Reset step back to running for next recovery
    const db = getDb();
    // Backdate again after first recovery
    const ago = new Date(Date.now() - 5 * 1000).toISOString();
    db.prepare("UPDATE steps SET status = 'running', current_story_id = ?, updated_at = ? WHERE run_id = ?").run(storyRowId, ago, runId);
    db.prepare("UPDATE stories SET status = 'running', updated_at = ? WHERE id = ?").run(ago, storyRowId);

    // Second recovery
    result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);
    assert.equal(result.recovered, 1, "second recovery should also succeed");

    const story = storyState(storyRowId);
    assert.equal(story.abandoned_count, 5, "abandoned_count should be 3 + 1 + 1 = 5");
    assert.equal(story.retry_count, 1, "retry_count should still be 1 (unchanged)");
  });

  it("exhausts ABANDON_STORY_MAX=8 and fails the story/run", async () => {
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 8,
      retryCount: 0,
      backdateSeconds: 5,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);

    assert.equal(result.failed, 1, "story should be failed on abandon exhaustion");
    assert.equal(result.recovered, 0, "story should not be recovered");

    const story = storyState(storyRowId);
    assert.equal(story.status, "failed", "story should be failed");
    assert.equal(story.abandoned_count, 9, "abandoned_count should be 9 (exhausted)");

    const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });

  it("preserves retry_count for honest rejections (does not touch retry_count)", async () => {
    // A story with honest retries already consumed (retry_count=3, max_retries=4)
    // suffers a worker loss. abandoned_count increments, retry_count stays.
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_fixer",
      abandonedCount: 0,
      retryCount: 3,
      maxRetries: 4,
      backdateSeconds: 5,
    });

    const { recoverOrphanedStepsForAgent } = await import("../dist/installer/step-ops.js");
    const result = recoverOrphanedStepsForAgent("wf-dead_fixer", runId, 0);

    assert.equal(result.recovered, 1);
    const story = storyState(storyRowId);
    assert.equal(story.abandoned_count, 1, "abandoned_count should be 1");
    assert.equal(story.retry_count, 3, "retry_count should stay at 3 (honest rejection budget preserved)");
    assert.equal(story.status, "pending");
  });
});

describe("cleanupAbandonedSteps — story-level WLST", () => {
  it("increments story.abandoned_count, not story.retry_count, on age-based cleanup", async () => {
    // Backdate by 1 hour to exceed ABANDONED_THRESHOLD_MS
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 0,
      retryCount: 2,
      backdateSeconds: 3600,
    });

    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    cleanupAbandonedSteps();

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be reset to pending");
    assert.equal(story.abandoned_count, 1, "abandoned_count should increment from 0 to 1");
    assert.equal(story.retry_count, 2, "retry_count should be UNCHANGED");
  });

  it("exhausts ABANDON_STORY_MAX=8 and fails the story/run", async () => {
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 8,
      retryCount: 0,
      backdateSeconds: 3600,
    });

    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    cleanupAbandonedSteps();

    const story = storyState(storyRowId);
    assert.equal(story.status, "failed", "story should be failed");
    assert.equal(story.abandoned_count, 9, "abandoned_count should be 9 (exhausted)");

    const run = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });

  it("recovers story with abundant abandon budget even when retries are exhausted", async () => {
    // Story has exhausted its honest retry budget (retry_count=4, max_retries=4)
    // but has abandon budget remaining (abandoned_count=0). Age-based cleanup
    // should still recover it using the abandon counter.
    const { runId, storyRowId } = seedStoryRun({
      agentId: "wf-dead_dev",
      abandonedCount: 0,
      retryCount: 4,
      maxRetries: 4,
      backdateSeconds: 3600,
    });

    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    cleanupAbandonedSteps();

    const story = storyState(storyRowId);
    assert.equal(story.status, "pending", "story should be recovered (abandon budget available)");
    assert.equal(story.abandoned_count, 1);
    assert.equal(story.retry_count, 4, "retry_count unchanged");
  });

  it("does NOT reset done stories (cleanupAbandonedSteps skips done)", async () => {
    // Set up a done story. cleanupAbandonedSteps explicitly skips 'done' stories.
    const db = getDb();
    const runId = crypto.randomUUID();
    const storyRowId = crypto.randomUUID();
    const ago = new Date(Date.now() - 3600 * 1000).toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-dead', 'task', 'running', '{}', 0, ?, ?)",
    ).run(runId, ago, ago);

    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria,
         status, retry_count, max_retries, abandoned_count, created_at, updated_at)
       VALUES (?, ?, 0, 'S-done', 'Test', 'desc', '[]', 'done', 0, 4, 0, ?, ?)`,
    ).run(storyRowId, runId, ago, ago);

    const { cleanupAbandonedSteps } = await import("../dist/installer/step-ops.js");
    cleanupAbandonedSteps();

    // Story should still be 'done' (NOT touched by cleanupAbandonedSteps story path)
    const story = storyState(storyRowId);
    assert.equal(story.status, "done", "done stories must NOT be reset by cleanupAbandonedSteps");
    assert.equal(story.abandoned_count, 0, "abandoned_count should be unchanged");
  });
});
