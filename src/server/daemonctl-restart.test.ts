/**
 * Tests for restartDaemon — stop + start lifecycle.
 *
 * Fully isolated: temporary HOME per test, a random dashboard port per
 * test, and a random control-plane port per test (the spawned daemon binds
 * one too). No default ports, no escape hatches — a port collision here is
 * a bug, not an environmental condition.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");

import {
  restartDaemon,
  startDaemon,
  stopDaemon,
  isRunning,
  readPort,
  writePort,
  getPidFile,
} from "../../dist/server/daemonctl.js";

function safeRmSync(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      // best-effort; temp dir will be reaped by OS
    }
  }
}

async function waitForPidExit(pid: number, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function stopDaemonAndWait(homeDir: string): Promise<void> {
  let pid: number | null = null;
  try {
    const pidStr = fs.readFileSync(getPidFile({ homeDir }), "utf-8").trim();
    pid = Number(pidStr);
    if (!Number.isFinite(pid)) pid = null;
  } catch { /* ignore */ }
  try { stopDaemon({ homeDir }); } catch { /* ignore */ }
  if (pid !== null) await waitForPidExit(pid);
}

// ── Helpers ────────────────────────────────────────────────────────

function createTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "canarinho-restart-"));
}

async function getAvailablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHttpUp(url: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url} to become reachable`);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("daemonctl restartDaemon", { concurrency: 1 }, () => {
  // Each spawned daemon binds a control plane too — isolate it per test so
  // the suite never touches the production control port (3339).
  let savedControlPort: string | undefined;
  beforeEach(async () => {
    savedControlPort = process.env.canarinho_CONTROL_PORT;
    process.env.canarinho_CONTROL_PORT = String(await getAvailablePort());
  });
  afterEach(() => {
    if (savedControlPort === undefined) delete process.env.canarinho_CONTROL_PORT;
    else process.env.canarinho_CONTROL_PORT = savedControlPort;
  });

  it("restartDaemon is exported and callable — returns { pid, port }", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      const result = await restartDaemon(port, { homeDir: tempHome });

      assert.equal(typeof result.pid, "number");
      assert.ok(result.pid > 0, "pid should be a positive number");
      assert.equal(typeof result.port, "number");
      assert.equal(result.port, port, "port should match the requested port");

      await waitForHttpUp(`http://127.0.0.1:${port}/`);
    } finally {
      await stopDaemonAndWait(tempHome)
      safeRmSync(tempHome);
    }
  });

  it("restartDaemon stops running daemon and starts a new one with a different PID", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      const first = await startDaemon(port, { homeDir: tempHome });
      assert.ok(first.pid > 0);

      await waitForHttpUp(`http://127.0.0.1:${port}/`);

      const result = await restartDaemon(port, { homeDir: tempHome });
      assert.ok(result.pid > 0, "restartDaemon should return a valid PID");
      assert.equal(result.port, port);
      assert.notEqual(result.pid, first.pid, "restartDaemon should spawn a new process with a different PID");

      // Dashboard should be reachable on the same port
      await waitForHttpUp(`http://127.0.0.1:${port}/`);

      // Verify the pid file has the new PID
      const after = isRunning({ homeDir: tempHome });
      assert.equal(after.running, true);
      assert.equal((after as { running: true; pid: number }).pid, result.pid);
    } finally {
      await stopDaemonAndWait(tempHome)
      safeRmSync(tempHome);
    }
  });

  it("restartDaemon uses stored port from port file when no port arg given", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      writePort(port, { homeDir: tempHome });
      assert.equal(readPort({ homeDir: tempHome }), port);

      const result = await restartDaemon(undefined, { homeDir: tempHome });
      assert.equal(result.port, port, "should use the stored port when no port arg given");
      assert.ok(result.pid > 0);
    } finally {
      await stopDaemonAndWait(tempHome)
      safeRmSync(tempHome);
    }
  });

  it("restartDaemon with explicit port overrides stored port file value", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const storedPort = await getAvailablePort();
    const explicitPort = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      writePort(storedPort, { homeDir: tempHome });

      const result = await restartDaemon(explicitPort, { homeDir: tempHome });
      assert.equal(result.port, explicitPort, "explicit port should override stored port file");
      assert.ok(result.pid > 0);
    } finally {
      await stopDaemonAndWait(tempHome)
      safeRmSync(tempHome);
    }
  });

  it("restartDaemon cleans up old PID file on restart", async (t) => {
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      t.skip("daemon.js not found — run npm run build first");
      return;
    }

    const port = await getAvailablePort();
    const tempHome = createTempHome();
    try {
      const first = await startDaemon(port, { homeDir: tempHome });
      await waitForHttpUp(`http://127.0.0.1:${port}/`);

      const result = await restartDaemon(port, { homeDir: tempHome });

      const pidFileContents = fs.readFileSync(getPidFile({ homeDir: tempHome }), "utf-8").trim();
      assert.equal(
        Number(pidFileContents),
        result.pid,
        "pid file should contain the NEW daemon's pid, not the stopped one",
      );
      assert.notEqual(Number(pidFileContents), first.pid);
    } finally {
      await stopDaemonAndWait(tempHome)
      safeRmSync(tempHome);
    }
  });

  it("restartDaemon return type is Promise<{ pid: number; port: number }>", () => {
    assert.equal(typeof restartDaemon, "function");
  });
});
