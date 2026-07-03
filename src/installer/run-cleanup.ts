import fs from "node:fs";
import path from "node:path";
import { logger } from "../lib/logger.js";
import { emitEvent } from "./events.js";

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

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Read /proc/<pid>/cwd (the current working directory of the process).
 * Returns the absolute path, or null if the entry disappeared.
 */
function readProcCwd(pid: number): string | null {
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "ESRCH") return null;
    // For other errors (e.g. EACCES), treat as not found gracefully
    return null;
  }
  return null;
}

/**
 * Read /proc/<pid>/environ as a raw Buffer and convert to string.
 * Returns the raw environ content, or null if the entry disappeared.
 */
function readProcEnviron(pid: number): string | null {
  try {
    const buf = fs.readFileSync(`/proc/${pid}/environ`);
    // environ entries are null-separated
    return buf.toString("utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "ESRCH") return null;
    return null;
  }
}

/**
 * Check if a process belongs to the run by inspecting its cwd and environ.
 * Returns the evidence string (which check matched), or null if no match.
 */
function processBelongsToRun(
  pid: number,
  runId: string,
  worktreePath: string,
): string | null {
  const cwd = readProcCwd(pid);
  const environ = readProcEnviron(pid);

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

  // (c) environ contains TAMANDUA_WORKER_JOB_ID=... with runId as substring
  if (environ) {
    // Null-separated entries — split and check each
    const entries = environ.split("\0");
    for (const entry of entries) {
      if (entry.startsWith("TAMANDUA_WORKER_JOB_ID=")) {
        const value = entry.substring("TAMANDUA_WORKER_JOB_ID=".length);
        if (value.includes(runId)) {
          return `TAMANDUA_WORKER_JOB_ID contains runId: ${value}`;
        }
      }
    }
  }

  return null;
}

/**
 * Get a list of numeric PIDs from /proc.
 */
function getProcPids(): number[] {
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const entry of entries) {
    const pid = parseInt(entry, 10);
    if (pid > 0 && pid.toString() === entry) {
      pids.push(pid);
    }
  }
  return pids;
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

/** Process-group id of a pid via /proc/<pid>/stat (Linux). Null on failure. */
function readPgid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const pgrp = Number(afterComm.split(" ")[2]);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

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

  const pids = getProcPids();

  for (const pid of pids) {
    if (skipPids.has(pid)) continue;
    scannedPids++;

    try {
      // Spare in-grace harness groups: the run's final work round may still
      // be flushing its token usage (HARNESS_TEARDOWN_GRACE_MS); the
      // scheduler's leak guard kills those groups after the grace window.
      if (excludePgids.size > 0) {
        const pgid = readPgid(pid);
        if (pgid !== null && excludePgids.has(pgid)) continue;
      }
      const matchReason = processBelongsToRun(pid, runId, worktreePath);
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
