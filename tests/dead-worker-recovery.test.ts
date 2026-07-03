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
