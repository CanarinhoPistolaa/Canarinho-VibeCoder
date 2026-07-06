/**
 * Portable process-introspection helpers.
 *
 * Linux exposes everything through procfs, which is cheap and exact, so it
 * is always tried first. macOS/BSD have no /proc; there the helpers fall
 * back to `ps` (pgid, cmdline, elapsed time) and `lsof` (cwd). The fallbacks
 * only see same-user processes — sufficient for every process tamandua
 * manages, since the daemon, harnesses, and CLI all run as the same user.
 *
 * IMPORTANT macOS limitation: the kernel does not let unprivileged callers
 * read another process's ENVIRONMENT (KERN_PROCARGS2 only yields argv;
 * `ps -E`/`ps e` print nothing for processes they didn't inherit). So
 * environ-based evidence (getEnvironText/environHasEntry) is procfs-only
 * and returns null/false on macOS — callers must rely on cwd and cmdline
 * evidence there instead.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

let procfsChecked = false;
let procfsAvailable = false;

/** Whether procfs is present and readable (true on Linux, false on macOS). */
export function hasProcfs(): boolean {
  if (!procfsChecked) {
    procfsChecked = true;
    try {
      fs.accessSync("/proc/self", fs.constants.R_OK);
      procfsAvailable = true;
    } catch {
      procfsAvailable = false;
    }
  }
  return procfsAvailable;
}

/** Run ps with the given args; null on any failure (including missing ps). */
function ps(args: string[]): string | null {
  try {
    const r = spawnSync("ps", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
  } catch {
    // ps unavailable — nothing portable left to try.
  }
  return null;
}

/** All visible pids: /proc entries on Linux, `ps -axo pid=` elsewhere. */
export function listPids(): number[] {
  if (hasProcfs()) {
    const pids: number[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      return pids;
    }
    for (const entry of entries) {
      const pid = parseInt(entry, 10);
      if (pid > 0 && pid.toString() === entry) pids.push(pid);
    }
    return pids;
  }
  const out = ps(["-axo", "pid="]);
  if (!out) return [];
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const pid = parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** Parse the pgrp field out of /proc/<pid>/stat content. */
function parsePgrpFromStat(stat: string): number | null {
  // Fields after the parenthesized comm (which may contain spaces):
  // state(0) ppid(1) pgrp(2) ...
  const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
  const pgrp = Number(afterComm.split(" ")[2]);
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
}

/** Process-group id of a pid. Null when the process is gone or unreadable. */
export function getPgid(pid: number): number | null {
  if (hasProcfs()) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      return parsePgrpFromStat(stat);
    } catch {
      return null;
    }
  }
  const out = ps(["-o", "pgid=", "-p", String(pid)]);
  if (!out) return null;
  const pgid = Number(out.trim());
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
}

/** Current working directory of a pid. Null when gone or unreadable. */
export function getProcessCwd(pid: number): string | null {
  if (hasProcfs()) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
      // ENOENT/EACCES/ESRCH — treat as not found.
    }
    return null;
  }
  try {
    const r = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (typeof r.stdout === "string") {
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("n") && line.length > 1) return line.slice(1);
      }
    }
  } catch {
    // lsof unavailable.
  }
  return null;
}

/**
 * Raw environment text of a pid (NUL-separated entries), or null.
 * Procfs-only: macOS does not expose other processes' environments to
 * unprivileged callers, so this returns null there — use cwd/cmdline
 * evidence instead.
 */
export function getEnvironText(pid: number): string | null {
  if (!hasProcfs()) return null;
  try {
    const buf = fs.readFileSync(`/proc/${pid}/environ`);
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Exact `NAME=value` membership test against a pid's environment.
 * Procfs-only (see getEnvironText); always false on macOS.
 */
export function environHasEntry(pid: number, name: string, value: string): boolean {
  const environ = getEnvironText(pid);
  if (environ === null) return false;
  return environ.split("\0").includes(`${name}=${value}`);
}

/** Full command line of a pid ("" unknown). Space-joined on Linux. */
export function getCmdline(pid: number): string {
  if (hasProcfs()) {
    try {
      return fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf-8")
        .replaceAll("\0", " ")
        .trim();
    } catch {
      return "";
    }
  }
  const out = ps(["-ww", "-o", "command=", "-p", String(pid)]);
  return out ? out.trim() : "";
}

/** Parse a ps etime value ([[dd-]hh:]mm:ss) into seconds. Null on mismatch. */
export function parseEtimeSeconds(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return (
    (dd ? Number(dd) * 86400 : 0) +
    (hh ? Number(hh) * 3600 : 0) +
    Number(mm) * 60 +
    Number(ss)
  );
}

/** Elapsed wall-clock seconds since the process started. Null when gone. */
export function getElapsedSeconds(pid: number): number | null {
  const out = ps(["-o", "etime=", "-p", String(pid)]);
  if (!out) return null;
  return parseEtimeSeconds(out);
}
