/**
 * Regression tests for the daemon control plane.
 *
 * Spawns the dashboard daemon in a tmp HOME, then exercises the control
 * endpoints directly over HTTP. The reconciler tick interval is unref'd so
 * it doesn't keep the test process alive.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTROL_PORT } from "../../dist/server/control-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");
const DASHBOARD_PORT = 3344;
const CONTROL_PORT = DEFAULT_CONTROL_PORT + 1000;

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function jsonRequest(
  method: "GET" | "POST",
  pathName: string,
  body?: Record<string, unknown>,
  secret?: string,
): Promise<JsonResponse> {
  const payload = body ? JSON.stringify(body) : "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) headers["x-tamandua-secret"] = secret;
  if (payload) headers["content-length"] = String(Buffer.byteLength(payload));

  return await new Promise<JsonResponse>((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port: CONTROL_PORT,
        path: pathName,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let parsed: Record<string, unknown> = {};
          if (raw.trim()) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { raw };
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error("control plane timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForControlUp(timeoutMs = 7000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const r = await jsonRequest("GET", "/control/health");
      if (r.status === 200) return;
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  throw new Error(`control plane did not come up on port ${CONTROL_PORT}`);
}

async function waitForExit(child: ChildProcess, timeoutMs = 7000): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

async function canBind(port: number): Promise<boolean> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => resolve());
      server.listen(port, "127.0.0.1");
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
}

describe("daemon control plane", { concurrency: 1 }, () => {
  let tempHome: string;
  let daemon: ChildProcess | undefined;
  let secret: string | undefined;

  before(async (t) => {
    if (!(await canBind(DASHBOARD_PORT))) {
      console.warn(`Port ${DASHBOARD_PORT} is in use; skipping control plane tests`);
      return;
    }
    if (!(await canBind(CONTROL_PORT))) {
      console.warn(`Port ${CONTROL_PORT} is in use; skipping control plane tests`);
      return;
    }

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-control-home-"));
    daemon = spawn("node", [DAEMON_SCRIPT, String(DASHBOARD_PORT)], {
      env: { ...process.env, HOME: tempHome, TAMANDUA_CONTROL_PORT: String(CONTROL_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout?.resume();
    daemon.stderr?.resume();

    await waitForControlUp();
    secret = fs.readFileSync(path.join(tempHome, ".tamandua", "daemon-secret"), "utf-8").trim();
    assert.ok(secret && secret.length > 0, "daemon secret should be created on startup");
  });

  after(async () => {
    if (daemon && daemon.exitCode === null && daemon.pid) {
      try {
        process.kill(daemon.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      try {
        await waitForExit(daemon);
      } catch {
        if (daemon.pid) {
          try { process.kill(daemon.pid, "SIGKILL"); } catch { /* ignore */ }
        }
      }
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("GET /control/health returns 200 without auth", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest("GET", "/control/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "ok");
  });

  it("GET /control/limits requires auth", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const unauth = await jsonRequest("GET", "/control/limits");
    assert.equal(unauth.status, 401);

    const auth = await jsonRequest("GET", "/control/limits", undefined, secret);
    assert.equal(auth.status, 200);
    assert.equal(typeof auth.body.maxActiveTimers, "number");
  });

  it("POST /control/register-run returns 404 for unknown run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId: crypto.randomUUID() },
      secret,
    );
    assert.equal(r.status, 404);
  });

  it("POST /control/register-run is idempotent for an existing run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    // Insert a run row directly into the DB the daemon is reading.
    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    // Use the same DB the daemon is using by inserting via node:sqlite.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, ?, 'control-test', 'running', '{}', 0, 'pending_register', ?, ?, ?)",
    ).run(runId, "wf-control-test", now, now, now);
    db.close();

    // First call: workflow-spec resolution will fail (workflow not installed)
    // so the daemon returns 422, but the run is now flagged 'error' rather
    // than a leaked 'active' state. Second call should be deterministic.
    const r1 = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId },
      secret,
    );
    assert.ok(r1.status === 422 || (r1.status >= 200 && r1.status < 300));

    const r2 = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId },
      secret,
    );
    assert.ok(r2.status === 422 || (r2.status >= 200 && r2.status < 300));

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/terminate-run is a no-op for unknown run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest(
      "POST",
      "/control/terminate-run",
      { runId: crypto.randomUUID() },
      secret,
    );
    assert.equal(r.status, 404);
  });

  it("POST /control/pause-run emits run.paused event", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-pause-test";
    const now = new Date().toISOString();

    // Insert a running run so pause will succeed.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'pause-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Check run-specific events file.
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const pauseEvent = runEvents.find((e: any) => e.event === "run.paused");
    assert.ok(pauseEvent, "expected a run.paused event in run events file");
    assert.equal(pauseEvent.runId, runId);
    assert.equal(pauseEvent.workflowId, workflowId);
    assert.ok(typeof pauseEvent.ts === "string" && pauseEvent.ts.length > 0);

    // Check global events file also received the event.
    const globalEventsPath = path.join(tempHome, ".tamandua", "events", "all.jsonl");
    assert.ok(fs.existsSync(globalEventsPath), "global events file should exist");
    const globalRaw = fs.readFileSync(globalEventsPath, "utf-8");
    const globalEvents = globalRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const globalPause = globalEvents.find((e: any) => e.event === "run.paused" && e.runId === runId);
    assert.ok(globalPause, "expected a run.paused event in global events file");
    assert.equal(globalPause.workflowId, workflowId);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/resume-run emits run.resumed event", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-resume-test";
    const now = new Date().toISOString();
    const context = JSON.stringify({ working_directory_for_harness: tempHome });

    // Insert a paused run so resume will process it.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'resume-test', 'paused', ?, 0, 'paused', ?, ?)",
    ).run(runId, workflowId, context, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/resume-run",
      { runId },
      secret,
    );
    // The resume handler emits the event before calling handleRegisterRun,
    // which may fail (workflow not installed) but the event is already emitted.
    // Accept 200 (if register succeeds) or 422 (if workflow doesn't exist).
    assert.ok(r.status === 200 || r.status === 422,
      `expected 200 or 422, got ${r.status}`);

    // Check run-specific events file for run.resumed.
    const runEventsPath = path.join(tempHome, ".tamandua", "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const resumeEvent = runEvents.find((e: any) => e.event === "run.resumed");
    assert.ok(resumeEvent, "expected a run.resumed event in run events file");
    assert.equal(resumeEvent.runId, runId);
    assert.equal(resumeEvent.workflowId, workflowId);
    assert.ok(typeof resumeEvent.ts === "string" && resumeEvent.ts.length > 0);

    // Check global events file also received the event.
    const globalEventsPath = path.join(tempHome, ".tamandua", "events", "all.jsonl");
    assert.ok(fs.existsSync(globalEventsPath), "global events file should exist");
    const globalRaw = fs.readFileSync(globalEventsPath, "utf-8");
    const globalEvents = globalRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const globalResume = globalEvents.find((e: any) => e.event === "run.resumed" && e.runId === runId);
    assert.ok(globalResume, "expected a run.resumed event in global events file");
    assert.equal(globalResume.workflowId, workflowId);

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  // ── Drain-before-pause tests ───────────────────────────────────────

  it("POST /control/pause-run with drain=true waits for in-flight steps", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-test";
    const stepId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a running run.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-test', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'impl', 0, 'wf-drain-test_developer', 'single', 'running', 'implement', '', 0, 3, ?, ?)",
    ).run(stepId, runId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "draining_pause");
    assert.equal(r.body.drained, true);

    // Verify DB: status should still be running, scheduling_status should be draining_pause.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "running", "status should remain running during drain");
    assert.equal(row.scheduling_status, "draining_pause", "scheduling_status should be draining_pause");

    // Cleanup
    db2.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with drain=true pauses immediately when nothing is in flight", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-empty";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-empty', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "status should transition to paused when no steps are in flight");
    assert.equal(row.scheduling_status, "paused", "scheduling_status should be paused");

    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with drain=false pauses immediately (unchanged behavior)", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-immediate";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-immediate', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    // drain=false (explicit)
    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: false },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Verify DB: status should be paused.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "status should be paused");
    assert.equal(row.scheduling_status, "paused", "scheduling_status should be paused");

    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with omitted drain pauses immediately (backward compat)", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-omitted";
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-omitted', 'running', '{}', 0, 'active', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    // No drain field in body
    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "status should be paused");
    assert.equal(row.scheduling_status, "paused", "scheduling_status should be paused");

    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("finalizeDrainingPause transitions run to paused when no running steps remain", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    // Use TAMANDUA_DB_PATH and TAMANDUA_STATE_DIR to point to the daemon's
    // state so finalizeDrainingPause (which calls getDb() and emitEvent())
    // operates on the same DB and events files as the daemon.
    const stateDir = path.join(tempHome, ".tamandua");
    const dbPath = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-finalize";
    const stepId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a run with draining_pause scheduling_status.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-finalize', 'running', '{}', 0, 'draining_pause', ?, ?)",
    ).run(runId, workflowId, now, now);

    // Insert a step that is already done (no running steps).
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'planner', 0, 'wf-drain-finalize_planner', 'single', 'done', 'plan', '', 0, 3, ?, ?)",
    ).run(stepId, runId, now, now);
    db.close();

    // Import finalizeDrainingPause from dist. getDb() and emitEvent() will
    // now resolve to the daemon's state because of the env vars.
    const { finalizeDrainingPause } = await import("../../dist/installer/step-ops.js");
    finalizeDrainingPause(runId);

    // Verify the run is now paused.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "status should transition to paused");
    assert.equal(row.scheduling_status, "paused", "scheduling_status should be paused");

    // Verify a run.paused event was emitted.
    const runEventsPath = path.join(stateDir, "events", `${runId}.jsonl`);
    assert.ok(fs.existsSync(runEventsPath), `expected events file at ${runEventsPath}`);
    const runEventsRaw = fs.readFileSync(runEventsPath, "utf-8");
    const runEvents = runEventsRaw.trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
    const pauseEvent = runEvents.find((e: any) => e.event === "run.paused");
    assert.ok(pauseEvent, "expected a run.paused event from drain finalization");
    assert.equal(pauseEvent.runId, runId);
    assert.equal(pauseEvent.workflowId, workflowId);

    // Cleanup
    delete process.env.TAMANDUA_DB_PATH;
    delete process.env.TAMANDUA_STATE_DIR;
    db2.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("finalizeDrainingPause does nothing when running steps remain", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const stateDir = path.join(tempHome, ".tamandua");
    const dbPath = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-running";
    const stepId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a run with draining_pause scheduling_status.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-running', 'running', '{}', 0, 'draining_pause', ?, ?)",
    ).run(runId, workflowId, now, now);

    // Insert a step that is still running.
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'impl', 0, 'wf-drain-running_developer', 'single', 'running', 'implement', '', 0, 3, ?, ?)",
    ).run(stepId, runId, now, now);
    db.close();

    // Import and call finalizeDrainingPause.
    const { finalizeDrainingPause } = await import("../../dist/installer/step-ops.js");
    finalizeDrainingPause(runId);

    // Verify the run is still running with draining_pause (not yet paused).
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "running", "status should remain running while steps are in flight");
    assert.equal(row.scheduling_status, "draining_pause", "scheduling_status should remain draining_pause");

    // Cleanup
    delete process.env.TAMANDUA_DB_PATH;
    delete process.env.TAMANDUA_STATE_DIR;
    db2.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("finalizeDrainingPause pauses verify_each loops waiting for verifier work", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const stateDir = path.join(tempHome, ".tamandua");
    const dbPath = path.join(stateDir, "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-verify-each";
    const loopStepId = crypto.randomUUID();
    const verifyStepId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-verify-each', 'running', '{}', 0, 'draining_pause', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, loop_config, current_story_id, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'implement', 0, 'wf-drain-verify-each_developer', 'loop', 'running', ?, NULL, 'implement', '', 0, 3, ?, ?)",
    ).run(loopStepId, runId, JSON.stringify({ over: "stories", verify_each: true, verify_step: "verify" }), now, now);
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, step_index, agent_id, type, status, input_template, expects, retry_count, max_retries, created_at, updated_at) VALUES (?, ?, 'verify', 1, 'wf-drain-verify-each_verifier', 'single', 'pending', 'verify', '', 0, 3, ?, ?)",
    ).run(verifyStepId, runId, now, now);
    db.close();

    const { finalizeDrainingPause } = await import("../../dist/installer/step-ops.js");
    finalizeDrainingPause(runId);

    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused", "loop placeholder waiting for verifier should not block drain finalization");
    assert.equal(row.scheduling_status, "paused");

    delete process.env.TAMANDUA_DB_PATH;
    delete process.env.TAMANDUA_STATE_DIR;
    db2.prepare("DELETE FROM steps WHERE id IN (?, ?)").run(loopStepId, verifyStepId);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with drain=true on already paused run returns paused state", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const workflowId = "wf-drain-already-paused";
    const now = new Date().toISOString();

    // Insert an already paused run.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, created_at, updated_at) VALUES (?, ?, 'drain-already-paused', 'paused', '{}', 0, 'paused', ?, ?)",
    ).run(runId, workflowId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "paused");

    // Verify DB unchanged.
    const db2 = new DatabaseSync(dbPath);
    const row = db2.prepare("SELECT status, scheduling_status FROM runs WHERE id = ?").get(runId) as { status: string; scheduling_status: string } | undefined;
    assert.ok(row, "run should exist");
    assert.equal(row.status, "paused");
    assert.equal(row.scheduling_status, "paused");

    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/pause-run with drain=true on terminal run returns 409", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert a completed run.
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-drain-terminal', 'terminal-test', 'completed', '{}', 0, ?, ?)",
    ).run(runId, now, now);
    db.close();

    const r = await jsonRequest(
      "POST",
      "/control/pause-run",
      { runId, drain: true },
      secret,
    );
    assert.equal(r.status, 409);
    assert.ok(String(r.body.error).includes("terminal"));

    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });
});
