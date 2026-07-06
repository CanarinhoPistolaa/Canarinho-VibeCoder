/**
 * Portable process-introspection helpers.
 *
 * Linux exposes everything through procfs, which is cheap and exact, so it
 * is always tried first. macOS/BSD have no /proc; there the helpers fall
 * back to `ps` (pgid, cmdline, environment) and `lsof` (cwd). The fallbacks
 * only see same-user processes — sufficient for every process tamandua
 * manages, since the daemon, harnesses, and CLI all run as the same user.
 *
 * The environment fallback reads `ps -wwEo command=`, where env entries are
 * appended to the command line space-separated. That means exact-entry
 * matching (environHasEntry) requires the value to be whitespace-free —
 * true for tamandua state dirs, temp HOMEs, and worktree paths.
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
 * Raw environment text of a pid, or null when gone or unreadable.
 *
 * On Linux this is /proc/<pid>/environ verbatim (NUL-separated entries).
 * On macOS it is the `ps -wwEo command=` line: the command followed by
 * space-separated env entries. Both forms support substring evidence
 * matching; for exact entry matching use environHasEntry().
 */
export function getEnvironText(pid: number): string | null {
  if (hasProcfs()) {
    try {
      const buf = fs.readFileSync(`/proc/${pid}/environ`);
      return buf.toString("utf-8");
    } catch {
      return null;
    }
  }
  const out = ps(["-wwEo", "command=", "-p", String(pid)]);
  return out ? out.trim() : null;
}

/** Exact `NAME=value` membership test against a pid's environment. */
export function environHasEntry(pid: number, name: string, value: string): boolean {
  const needle = `${name}=${value}`;
  if (hasProcfs()) {
    const environ = getEnvironText(pid);
    if (environ === null) return false;
    return environ.split("\0").includes(needle);
  }
  // ps -E appends env entries space-separated; whitespace-free values only.
  const environ = getEnvironText(pid);
  if (environ === null) return false;
  return environ.split(/\s+/).includes(needle);
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
