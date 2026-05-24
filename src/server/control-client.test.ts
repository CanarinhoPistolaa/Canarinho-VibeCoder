/**
 * Tests for the daemon control client (nudgeWithDaemon).
 *
 * Spawns the dashboard daemon in a tmp HOME, then exercises the nudgeWithDaemon
 * client function over HTTP. This validates that the client correctly calls the
 * POST /control/nudge endpoint and handles both reachable and unreachable daemon
 * cases.
 */
import { describe, it, before, after } from "node:test";
import { cleanChildEnv, reserveDistinctRandomPorts } from "../../tests/helpers/test-env.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");
let dashboardPort = 0;
let controlPort = 0;

/** JSON request helper matching the control-server test pattern. */
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
        port: controlPort,
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

/** Wait for the daemon control plane to become reachable. */
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
  throw new Error(`control plane did not come up on port ${controlPort}`);
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

describe("control client", { concurrency: 1 }, () => {
  let tempHome: string;
  let daemon: ChildProcess | undefined;
  let secret: string | undefined;

  before(async (t) => {
    [dashboardPort, controlPort] = await reserveDistinctRandomPorts(2);
    if (!(await canBind(dashboardPort))) {
      console.warn(`Port ${dashboardPort} is in use; skipping control client tests`);
      return;
    }
    if (!(await canBind(controlPort))) {
      console.warn(`Port ${controlPort} is in use; skipping control client tests`);
      return;
    }

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cc-home-"));
    daemon = spawn("node", [DAEMON_SCRIPT, String(dashboardPort)], {
      env: cleanChildEnv({ HOME: tempHome, TAMANDUA_CONTROL_PORT: String(controlPort) }),
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

  it("nudgeWithDaemon returns response when daemon is reachable", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    // The daemon's reconciler creates the DB schema on its first tick (~1s).
    // Wait a moment to ensure the DB is initialized.
    await sleep(1500);

    // Insert a running run so there's something to nudge (even if no agents are scheduled).
    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, 'wf-nudge-client', 'nudge-client-test', 'running', '{}', 0, 'pending_register', ?, ?, ?)",
    ).run(runId, now, now, now);
    db.close();

    // control-client reads the daemon secret from ~/.tamandua/daemon-secret
    // and the control port from TAMANDUA_CONTROL_PORT. Set both to match the
    // test daemon's tempHome so nudgeWithDaemon reaches the correct daemon.
    const savedHome = process.env.HOME;
    const savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.HOME = tempHome;
    process.env.TAMANDUA_CONTROL_PORT = String(controlPort);

    // Dynamic import to get a fresh module after setting env vars.
    const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
    const response = await nudgeWithDaemon(3000);

    // Restore env
    process.env.HOME = savedHome;
    if (savedControlPort !== undefined) {
      process.env.TAMANDUA_CONTROL_PORT = savedControlPort;
    } else {
      delete process.env.TAMANDUA_CONTROL_PORT;
    }

    assert.ok(response !== null, "nudgeWithDaemon should return a response when daemon is up");
    assert.equal(typeof response.status, "number");
    assert.equal(typeof response.body.runningRuns, "number");

    // Cleanup DB
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("nudgeWithDaemon returns null when daemon is not reachable (no crash)", async (t) => {
    // Use a port that is very likely not in use, and a non-existent HOME so
    // readDaemonSecret returns null (not an error — control-client treats null
    // secret as no-auth). nudgeWithDaemon uses controlRequest which resolves
    // with null on connection error.
    const savedHome = process.env.HOME;
    const savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
    process.env.HOME = "/nonexistent-tamandua-test-home";
    process.env.TAMANDUA_CONTROL_PORT = "65530";

    const { nudgeWithDaemon } = await import("../../dist/server/control-client.js");
    const response = await nudgeWithDaemon(500);

    process.env.HOME = savedHome;
    if (savedControlPort !== undefined) {
      process.env.TAMANDUA_CONTROL_PORT = savedControlPort;
    } else {
      delete process.env.TAMANDUA_CONTROL_PORT;
    }

    assert.equal(response, null, "nudgeWithDaemon should return null when daemon is unreachable");
  });
});
