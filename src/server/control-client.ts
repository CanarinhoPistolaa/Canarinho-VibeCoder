/**
 * Tamandua Daemon Control Plane Client
 *
 * Thin HTTP client used by the CLI / MCP / installer paths to talk to
 * the daemon's control plane on 127.0.0.1:3339 (or TAMANDUA_CONTROL_PORT).
 *
 * All operations are best-effort: if the daemon isn't running, the calling
 * path falls back to in-process scheduling so local development and test
 * paths keep working. Production deployments should always run the daemon.
 */
import http from "node:http";
import { getControlPort, readDaemonSecret } from "./control-server.js";
import { readPort, startDaemon } from "./daemonctl.js";

export interface ControlPlaneResponse {
  status: number;
  body: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 1500;

async function controlRequest(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ControlPlaneResponse | null> {
  const port = getControlPort();
  const secret = readDaemonSecret();
  const payload = body ? JSON.stringify(body) : "";

  const options: http.RequestOptions = {
    method,
    hostname: "127.0.0.1",
    port,
    path,
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-tamandua-secret": secret } : {}),
      ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
    },
  };

  return await new Promise<ControlPlaneResponse | null>((resolve) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
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
    });

    req.on("error", () => resolve(null)); // daemon not running / unreachable
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("control plane timeout"));
      resolve(null);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** Quick liveness probe; returns true when the daemon control plane responds. */
export async function isDaemonControlReachable(timeoutMs: number = 500): Promise<boolean> {
  const r = await controlRequest("GET", "/control/health", undefined, timeoutMs);
  return r !== null && r.status === 200;
}

const PROBE_TIMEOUT_OVERRIDE_ENV = "TAMANDUA_CONTROL_PROBE_TIMEOUT_OVERRIDE";

function resolveProbeTimeout(defaultMs: number): number {
  const override = process.env[PROBE_TIMEOUT_OVERRIDE_ENV];
  if (override !== undefined) {
    const parsed = parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return defaultMs;
}

export async function waitForDaemonControl(timeoutMs: number = 30_000): Promise<boolean> {
  const effectiveTimeout = resolveProbeTimeout(timeoutMs);
  const startedAt = Date.now();
  let delay = 100;
  const maxDelay = 2_000;
  while (Date.now() - startedAt < effectiveTimeout) {
    if (await isDaemonControlReachable(500)) return true;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, maxDelay);
  }
  return false;
}

export async function ensureDaemonControlAvailable(timeoutMs: number = 30_000): Promise<void> {
  const effectiveTimeout = resolveProbeTimeout(timeoutMs);
  if (await isDaemonControlReachable(500)) return;

  await startDaemon(readPort());

  if (!(await waitForDaemonControl(effectiveTimeout))) {
    throw new Error(
      `Tamandua daemon started but control plane did not become reachable on port ${getControlPort()}.`,
    );
  }
}

/**
 * Notify the daemon that a new run has been created and should be admitted
 * into the scheduler. Returns the parsed response on success, null when the
 * daemon is unreachable (caller should fall back to in-process scheduling).
 */
export async function registerRunWithDaemon(runId: string, timeoutMs?: number): Promise<ControlPlaneResponse | null> {
  return controlRequest("POST", "/control/register-run", { runId }, timeoutMs);
}

/** Request termination of a run's scheduling state. */
export async function terminateRunWithDaemon(runId: string): Promise<ControlPlaneResponse | null> {
  return controlRequest("POST", "/control/terminate-run", { runId });
}

/** Pause a run (clears timers; sets status='paused'). Optionally drain first. */
export async function pauseRunWithDaemon(runId: string, drain = false): Promise<ControlPlaneResponse | null> {
  return controlRequest("POST", "/control/pause-run", drain ? { runId, drain: true } : { runId });
}

/** Resume a paused run (re-enters admission). */
export async function resumeRunWithDaemon(runId: string): Promise<ControlPlaneResponse | null> {
  return controlRequest("POST", "/control/resume-run", { runId });
}

/** Request the daemon to nudge all scheduled agents for all running runs. */
export async function nudgeWithDaemon(timeoutMs?: number): Promise<ControlPlaneResponse | null> {
  return controlRequest("POST", "/control/nudge", {}, timeoutMs);
}
