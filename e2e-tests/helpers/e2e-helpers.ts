/**
 * Helpers for real end-to-end workflow tests.
 *
 * These helpers manage daemon lifecycle and workflow run polling for the
 * slow real e2e tests. They use isolated HOME/TAMANDUA_STATE_DIR to avoid
 * touching live Tamandua state.
 *
 * IMPORTANT: The real e2e tests using these helpers are SLOW and spend
 * real model tokens.  Do not run them as part of regular test suites.
 *
 * Run only via:  ./run-all-real-e2e-tests
 */

import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";
import { baseEnv } from "./smoke-helpers.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");
const daemonScript = path.resolve(repoRoot, "dist", "server", "daemon.js");

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000; // 30 minutes
export const DAEMON_START_TIMEOUT_MS = 15_000;

const TERMINAL_STATUSES = new Set(["completed", "done", "failed", "canceled"]);
const SUCCESSFUL_RUN_STATUSES = new Set(["completed", "done"]);

export function isSuccessfulRunTerminalStatus(status: string): boolean {
  return SUCCESSFUL_RUN_STATUSES.has(status);
}

/**
 * Poll for a workflow run to reach a terminal status.
 *
 * Calls `tamandua workflow status <runId>` at regular intervals and
 * parses the output to extract the current status. Returns the terminal
 * status string ("completed", "failed", or "canceled") when reached.
 * "done" is also accepted as a legacy success alias.
 *
 * Throws with timeout diagnostics (last known status and output) if the
 * run does not reach a terminal status within `timeoutMs`.
 */
export async function pollForRunCompletion(
  runId: string,
  env: Record<string, string>,
  timeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<string> {
  const startedAt = Date.now();
  let lastOutput = "";
  let lastStatus = "";

  while (Date.now() - startedAt < timeoutMs) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });

    lastOutput = result.stdout || result.stderr || "";

    // Extract status from "Status: <value>" line
    const statusMatch = lastOutput.match(/^Status:\s+(\S+)/m);
    if (statusMatch) {
      lastStatus = statusMatch[1];
      if (TERMINAL_STATUSES.has(lastStatus)) {
        return lastStatus;
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Timeout after ${timeoutMs}ms waiting for run ${runId.slice(0, 8)} to complete.\n` +
      `Last status: ${lastStatus || "(unknown)"}\n` +
      `Last output:\n${lastOutput || "(no output)"}`,
  );
}

/**
 * Start an isolated daemon process.
 *
 * Spawns the daemon.js script with an isolated HOME directory (so all
 * PID, port, DB, and log files go to the temp ~/.tamandua directory).
 *
 * The ~/.tamandua/port file in the isolated HOME must already exist
 * before calling this (createTempHome from smoke-helpers handles this).
 *
 * Waits for the daemon to print its "control plane listening" message
 * before resolving.  Throws if the daemon fails to start or exits
 * before becoming ready.
 *
 * Returns the ChildProcess handle for cleanup via stopIsolatedDaemon.
 */
export function startIsolatedDaemon(
  port: number,
  homeDir: string,
  controlPort: number,
  extraEnv: Record<string, string> = {},
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["--disable-warning=ExperimentalWarning", daemonScript, String(port)],
      {
        env: cleanChildEnv({ ...baseEnv(homeDir, controlPort), ...extraEnv }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Daemon failed to start within ${DAEMON_START_TIMEOUT_MS}ms.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    }, DAEMON_START_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      if (!resolved && output.includes("Tamandua control plane listening")) {
        resolved = true;
        clearTimeout(timeout);
        resolve(child);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Daemon exited with code ${code} before becoming ready.\n` +
            `Output:\n${output || "(no output)"}`,
        ),
      );
    });
  });
}

/**
 * Stop an isolated daemon process.
 *
 * Sends SIGTERM to the daemon and waits for it to exit.  Falls back to
 * SIGKILL after 5 s if the process does not exit gracefully.
 */
export async function stopIsolatedDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (!child.pid) return;

  // Check if the process is still alive
  try {
    process.kill(child.pid, 0);
  } catch {
    return; // already dead
  }

  child.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const forceTimeout = setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try {
          child.kill("SIGKILL");
        } catch {
          // process may have already exited
        }
      }
      resolve();
    }, 5000);

    child.once("exit", () => {
      clearTimeout(forceTimeout);
      resolve();
    });
  });
}

/**
 * Poll for run completion while nudging the scheduler every cycle.
 *
 * The in-process cron timers fire only once per intervalMinutes (default
 * 5 minutes), so without nudging even an instant agent advances one step
 * per 5 minutes. `tamandua nudge` asks the daemon to launch a polling
 * round for every scheduled agent immediately, which lets scripted-agent
 * e2e tests advance the pipeline at second scale.
 *
 * Returns the terminal status. Throws with diagnostics on timeout.
 */
export async function pollForRunCompletionWithNudge(
  runId: string,
  env: Record<string, string>,
  timeoutMs: number,
  nudgeIntervalMs = 1_500,
): Promise<string> {
  const startedAt = Date.now();
  let lastOutput = "";
  let lastStatus = "";

  while (Date.now() - startedAt < timeoutMs) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
    lastOutput = result.stdout || result.stderr || "";
    const statusMatch = lastOutput.match(/^Status:\s+(\S+)/m);
    if (statusMatch) {
      lastStatus = statusMatch[1];
      if (TERMINAL_STATUSES.has(lastStatus)) {
        return lastStatus;
      }
    }

    // Wake every scheduled agent for the next round (best-effort).
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });

    await sleep(nudgeIntervalMs);
  }

  throw new Error(
    `Timeout after ${timeoutMs}ms waiting for run ${runId.slice(0, 8)} to complete (with nudging).\n` +
      `Last status: ${lastStatus || "(unknown)"}\n` +
      `Last output:\n${lastOutput || "(no output)"}`,
  );
}

/**
 * Wait for a workflow run to reach a successful terminal status.
 *
 * Thin wrapper around pollForRunCompletion that throws if the terminal
 * status is anything other than "completed" (or legacy alias "done").
 */
export async function waitForRunTerminal(
  runId: string,
  env: Record<string, string>,
  timeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<string> {
  const status = await pollForRunCompletion(runId, env, timeoutMs, pollIntervalMs);

  if (!isSuccessfulRunTerminalStatus(status)) {
    throw new Error(
      `Run ${runId.slice(0, 8)} reached terminal status "${status}" (expected "completed").`,
    );
  }

  return status;
}
