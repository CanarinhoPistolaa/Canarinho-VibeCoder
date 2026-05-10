/**
 * Tests for tamandua control-plane CLI commands (US-004).
 *
 * Validates:
 * 1. tamandua control-plane start prints PID and endpoint URL
 * 2. tamandua control-plane start --port 4444 starts control plane on port 4444
 * 3. tamandua control-plane start 4444 (positional) starts on custom port
 * 4. tamandua control-plane start when already running shows existing status without restarting
 * 5. tamandua control-plane status shows running state, PID, port, and endpoint when up
 * 6. tamandua control-plane status shows not running when down
 * 7. tamandua control-plane stop kills control plane process and prints confirmation
 * 8. tamandua control-plane stop when not running prints not running message
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In dev (tsx), compiled CLI is in dist/cli/
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

// Import daemonctl for direct cleanup (shared PID/port files)
import {
  stopControlPlane,
  isControlPlaneRunning,
  getControlPlaneStatus,
  CONTROL_PLANE_PID_FILE,
  CONTROL_PLANE_PORT_FILE,
} from "../dist/server/daemonctl.js";
import { DEFAULT_CONTROL_PORT } from "../dist/server/control-server.js";

async function canBind(port: number): Promise<boolean> {
  const server = http.createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });

    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function waitForHttpUp(url: string, timeoutMs = 7000): Promise<Response> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetch(url);
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out waiting for ${url} to become reachable: ${String(lastError)}`);
}

async function waitForHttpDown(url: string, timeoutMs = 7000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(url);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }

  throw new Error(`Timed out waiting for ${url} to become unreachable`);
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Filter harmless node warnings from stderr (e.g. SQLite experimental warning)
 * so they don't pollute test assertions.
 */
function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function cleanupControlPlaneFiles(): void {
  try { fs.unlinkSync(CONTROL_PLANE_PID_FILE); } catch {}
  try { fs.unlinkSync(CONTROL_PLANE_PORT_FILE); } catch {}
}

// ── Tests ──────────────────────────────────────────────────────────

describe("tamandua control-plane CLI", { concurrency: 1 }, () => {
  before(() => {
    // Best-effort cleanup of any stale control plane that might interfere
    stopControlPlane();
    cleanupControlPlaneFiles();
  });

  after(() => {
    stopControlPlane();
    cleanupControlPlaneFiles();
  });

  // AC 6 (partial): tamandua control-plane status shows not running when down
  it("control-plane status shows not running when down", async () => {
    cleanupControlPlaneFiles();

    const { stdout, stderr, exitCode } = await runCli(["control-plane", "status"]);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("not running"), `Expected "not running" in output, got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");
  });

  // AC 1: tamandua control-plane start starts standalone control plane process
  it("control-plane start prints PID and endpoint URL", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    if (!(await canBind(DEFAULT_CONTROL_PORT))) {
      t.skip(`Port ${DEFAULT_CONTROL_PORT} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      const { stdout, stderr, exitCode } = await runCli(["control-plane", "start"]);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);
      assert.ok(stdout.includes("PID"), `Expected "PID" in output, got: ${stdout}`);
      assert.ok(stdout.includes(`localhost:${DEFAULT_CONTROL_PORT}`), `Expected port ${DEFAULT_CONTROL_PORT} in output, got: ${stdout}`);
      assert.ok(stdout.includes("/control/health"), `Expected /control/health endpoint in output, got: ${stdout}`);

      // Verify it actually started
      const status = getControlPlaneStatus();
      assert.equal(status.running, true);
      assert.notEqual(status.pid, null);

      // Verify health endpoint reachable
      const res = await waitForHttpUp(`http://127.0.0.1:${DEFAULT_CONTROL_PORT}/control/health`);
      assert.ok(res.status >= 200 && res.status < 500);

    } finally {
      stopControlPlane();
      cleanupControlPlaneFiles();
    }
  });

  // AC 2: tamandua control-plane start --port 4444 starts on custom port
  it("control-plane start --port 4444 starts on custom port", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const customPort = 4444;
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      const { stdout, stderr, exitCode } = await runCli(["control-plane", "start", "--port", String(customPort)]);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);
      assert.ok(stdout.includes(`localhost:${customPort}`), `Expected port ${customPort} in output, got: ${stdout}`);

      // Verify on custom port
      const res = await waitForHttpUp(`http://127.0.0.1:${customPort}/control/health`);
      assert.ok(res.status >= 200 && res.status < 500);

      // Verify default port is NOT reachable
      try {
        await fetch(`http://127.0.0.1:${DEFAULT_CONTROL_PORT}/control/health`);
        assert.fail("Control plane should not be reachable on default port when custom port was used");
      } catch {
        // Expected
      }

    } finally {
      stopControlPlane();
      cleanupControlPlaneFiles();
    }
  });

  // AC 3: tamandua control-plane start 4444 (positional) starts on custom port
  it("control-plane start 4444 (positional) starts on custom port", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const customPort = 4446;
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      const { stdout, stderr, exitCode } = await runCli(["control-plane", "start", String(customPort)]);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);
      assert.ok(stdout.includes(`localhost:${customPort}`), `Expected port ${customPort} in output, got: ${stdout}`);

      // Verify on custom port
      const res = await waitForHttpUp(`http://127.0.0.1:${customPort}/control/health`);
      assert.ok(res.status >= 200 && res.status < 500);

    } finally {
      stopControlPlane();
      cleanupControlPlaneFiles();
    }
  });

  // AC 6: Already running message shown when control plane is already up
  it("control-plane start when already running shows existing status", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    if (!(await canBind(DEFAULT_CONTROL_PORT))) {
      t.skip(`Port ${DEFAULT_CONTROL_PORT} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      // First start
      const first = await runCli(["control-plane", "start"]);
      assert.equal(first.exitCode, 0);
      assert.ok(first.stdout.includes("started"));

      // Capture the PID from first start
      const runningStatus = getControlPlaneStatus();
      assert.equal(runningStatus.running, true);
      const firstPid = runningStatus.pid;

      // Second start - should show "already running" with the same PID
      const second = await runCli(["control-plane", "start"]);
      assert.equal(second.exitCode, 0);
      assert.ok(second.stdout.includes("already running"), `Expected "already running", got: ${second.stdout}`);
      assert.ok(second.stdout.includes(`PID ${firstPid}`), `Expected PID ${firstPid}, got: ${second.stdout}`);
      assert.ok(second.stdout.includes(`localhost:${DEFAULT_CONTROL_PORT}`));
      assert.ok(second.stdout.includes("/control/health"));
      // Should NOT show "started" (second attempt didn't restart)
      assert.ok(!second.stdout.includes("Control plane started"));

    } finally {
      stopControlPlane();
      cleanupControlPlaneFiles();
    }
  });

  // AC 4: tamandua control-plane status reports running/not running with PID, port, endpoint
  it("control-plane status shows running state when up", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    if (!(await canBind(DEFAULT_CONTROL_PORT))) {
      t.skip(`Port ${DEFAULT_CONTROL_PORT} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      // Start control plane
      const start = await runCli(["control-plane", "start"]);
      assert.equal(start.exitCode, 0);

      const runningStatus = getControlPlaneStatus();
      assert.equal(runningStatus.running, true);

      // Check status
      const { stdout, stderr, exitCode } = await runCli(["control-plane", "status"]);

      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("running"), `Expected "running", got: ${stdout}`);
      assert.ok(stdout.includes(`PID ${runningStatus.pid}`), `Expected PID ${runningStatus.pid}, got: ${stdout}`);
      assert.ok(stdout.includes(`Port: ${runningStatus.port}`), `Expected Port: ${runningStatus.port}, got: ${stdout}`);
      assert.ok(stdout.includes(`localhost:${runningStatus.port}`), `Expected localhost, got: ${stdout}`);
      assert.ok(stdout.includes("/control/health"), `Expected /control/health endpoint, got: ${stdout}`);
      assert.equal(cleanStderr(stderr), "");

    } finally {
      stopControlPlane();
      cleanupControlPlaneFiles();
    }
  });

  // AC 5: tamandua control-plane stop stops the control plane
  it("control-plane stop kills process and prints confirmation", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    if (!(await canBind(DEFAULT_CONTROL_PORT))) {
      t.skip(`Port ${DEFAULT_CONTROL_PORT} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      // Start control plane
      const start = await runCli(["control-plane", "start"]);
      assert.equal(start.exitCode, 0);

      // Verify it's running
      let status = getControlPlaneStatus();
      assert.equal(status.running, true);

      // Stop
      const { stdout, stderr, exitCode } = await runCli(["control-plane", "stop"]);

      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("stopped"), `Expected "stopped", got: ${stdout}`);
      assert.equal(cleanStderr(stderr), "");

      // Wait for process to fully exit
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify it's actually stopped
      status = getControlPlaneStatus();
      assert.equal(status.running, false, "Control plane should not be running after stop");

      // Verify PID file is cleaned up
      assert.equal(fs.existsSync(CONTROL_PLANE_PID_FILE), false, "PID file should be removed after stop");

    } finally {
      stopControlPlane();
      cleanupControlPlaneFiles();
    }
  });

  // AC 5 (partial): stop when not running
  it("control-plane stop when not running prints not running", async () => {
    cleanupControlPlaneFiles();

    // Ensure nothing is running
    stopControlPlane();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    const { stdout, stderr, exitCode } = await runCli(["control-plane", "stop"]);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("not running"), `Expected "not running", got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");
  });
});
