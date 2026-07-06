import path from "node:path";
import { spawnSync } from "node:child_process";
import { logger } from "../lib/logger.js";
import { emitEvent } from "./events.js";
import {
  getEnvironText,
  getPgid,
  getProcessCwd,
  hasProcfs,
  listPids,
} from "../lib/proc-info.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RunCleanupResult {
  runId: string;
  worktreePath: string;
  scannedPids: number;
  killedPids: number[];
  evidence: Record<number, string>;
}

export interface SweepOptions {
  /** PID that must never be killed (typically the daemon). */
  daemonPid?: number;
  /** Process groups to spare (in-grace harness groups; leak guard owns them). */
  excludePgids?: number[];
}

/** One process observation: pid plus the evidence channels we match on. */
export interface ProcessSnapshotEntry {
  pid: number;
  cwd: string | null;
  environ: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Current working directory of a process (procfs on Linux, lsof on macOS).
 * Returns the absolute path, or null if the process is gone or unreadable.
 */
export function readProcCwd(pid: number): string | null {
  return getProcessCwd(pid);
}

/**
 * Environment text of a process (procfs on Linux — NUL-separated; `ps -E`
 * on macOS — space-separated after the command). Null if gone/unreadable.
 */
export function readProcEnviron(pid: number): string | null {
  return getEnvironText(pid);
}

/**
 * Evidence matcher over already-collected cwd/environ observations.
 * Returns the evidence string (which check matched), or null if no match.
 */
export function matchRunEvidence(
  cwd: string | null,
  environ: string | null,
  runId: string,
  worktreePath: string,
): string | null {
  // (a) cwd resolves to or under worktreePath
  if (cwd) {
    const resolvedCwd = path.resolve(cwd);
    const resolvedWorktree = path.resolve(worktreePath);
    // Check if cwd is under worktreePath (including the path itself)
    if (resolvedCwd === resolvedWorktree || resolvedCwd.startsWith(resolvedWorktree + path.sep)) {
      return `cwd under worktree: ${cwd}`;
    }
  }

  // (b) environ contains the string worktreePath
  if (environ && environ.includes(worktreePath)) {
    return `environ contains worktree path: ${worktreePath}`;
  }

  // (c) environ contains TAMANDUA_WORKER_JOB_ID=... with runId as substring.
  // Job-id values are NUL- and whitespace-free, so one regex covers both the
  // NUL-separated procfs form and the space-separated ps -E form.
  if (environ) {
    const m = environ.match(/TAMANDUA_WORKER_JOB_ID=([^\0\s]*)/);
    if (m && m[1].includes(runId)) {
      return `TAMANDUA_WORKER_JOB_ID contains runId: ${m[1]}`;
    }
  }

  return null;
}

/**
 * Check if a process belongs to the run by inspecting its cwd and environ.
 * Returns the evidence string (which check matched), or null if no match.
 */
export function processBelongsToRun(
  pid: number,
  runId: string,
  worktreePath: string,
): string | null {
  return matchRunEvidence(readProcCwd(pid), readProcEnviron(pid), runId, worktreePath);
}

/**
 * Get a list of visible numeric PIDs (procfs on Linux, `ps` elsewhere).
 */
export function getProcPids(): number[] {
  return listPids();
}

/**
 * One observation per visible process. On Linux this walks procfs per pid.
 * On macOS per-pid reads would spawn two subprocesses per process, so the
 * whole table is captured with ONE `ps -axwwEo` call (command+environ) and
 * ONE `lsof -d cwd` call (cwd) instead.
 */
export function collectProcessSnapshot(): ProcessSnapshotEntry[] {
  if (hasProcfs()) {
    return getProcPids().map((pid) => ({
      pid,
      cwd: readProcCwd(pid),
      environ: readProcEnviron(pid),
    }));
  }

  const environByPid = new Map<number, string>();
  try {
    const r = spawnSync("ps", ["-axwwEo", "pid=,command="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status === 0 && typeof r.stdout === "string") {
      for (const line of r.stdout.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (m) environByPid.set(Number(m[1]), m[2]);
      }
    }
  } catch {
    // ps unavailable — snapshot stays empty for environ.
  }

  const cwdByPid = new Map<number, string>();
  try {
    const r = spawnSync("lsof", ["-d", "cwd", "-Fpn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (typeof r.stdout === "string") {
      let currentPid: number | null = null;
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("p")) currentPid = Number(line.slice(1)) || null;
        else if (line.startsWith("n") && currentPid !== null) {
          cwdByPid.set(currentPid, line.slice(1));
        }
      }
    }
  } catch {
    // lsof unavailable — cwd evidence channel stays empty.
  }

  const pids = new Set<number>([...environByPid.keys(), ...cwdByPid.keys()]);
  return [...pids].map((pid) => ({
    pid,
    cwd: cwdByPid.get(pid) ?? null,
    environ: environByPid.get(pid) ?? null,
  }));
}

// ── Main export ──────────────────────────────────────────────────────

/**
 * Sweep for surviving processes that belong to a run and kill them with SIGKILL.
 *
 * A process belongs to the run when:
 *  - its cwd resolves to or under `worktreePath`, OR
 *  - its environ contains the string `worktreePath`, OR
 *  - its environ contains `TAMANDUA_WORKER_JOB_ID=...` where `runId` is a substring
 *
 * Never kills: pid 1 (init), our own process (process.pid), the daemonPid (if provided).
 *
 * Logs every kill via `logger.info` with pid and evidence, and emits a
 * `run.process_cleanup` event summarizing the sweep.
 */
export function sweepRunProcesses(
  runId: string,
  worktreePath: string,
  options?: SweepOptions,
): RunCleanupResult {
  const skipPids = new Set<number>([1, process.pid]);
  if (options?.daemonPid !== undefined) {
    skipPids.add(options.daemonPid);
  }
  const excludePgids = new Set<number>(options?.excludePgids ?? []);

  const killedPids: number[] = [];
  const evidence: Record<number, string> = {};
  let scannedPids = 0;

  const snapshot = collectProcessSnapshot();

  for (const entry of snapshot) {
    const pid = entry.pid;
    if (skipPids.has(pid)) continue;
    scannedPids++;

    try {
      // Spare in-grace harness groups: the run's final work round may still
      // be flushing its token usage (HARNESS_TEARDOWN_GRACE_MS); the
      // scheduler's leak guard kills those groups after the grace window.
      if (excludePgids.size > 0) {
        const pgid = getPgid(pid);
        if (pgid !== null && excludePgids.has(pgid)) continue;
      }
      const matchReason = matchRunEvidence(entry.cwd, entry.environ, runId, worktreePath);
      if (matchReason) {
        process.kill(pid, "SIGKILL");
        killedPids.push(pid);
        evidence[pid] = matchReason;
        logger.info(`Sweep killed process ${pid}`, {
          runId,
          pid,
          evidence: matchReason,
        });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ESRCH: process already exited between our check and kill — OK
      if (code === "ESRCH") {
        logger.info(`Sweep skipped process ${pid} (already exited)`, {
          runId,
          pid,
        });
      } else {
        logger.warn(`Sweep failed to kill process ${pid}`, {
          runId,
          pid,
          error: String(err),
        });
      }
    }
  }

  // Emit a run event summarizing the sweep
  emitEvent({
    ts: new Date().toISOString(),
    event: "run.process_cleanup",
    runId,
    detail: JSON.stringify({
      worktreePath,
      scannedPids,
      killedPids,
      evidence,
    }),
  });

  return { runId, worktreePath, scannedPids, killedPids, evidence };
}
