import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertStatePathIsolation } from "./test-guard.js";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROTATED_FILES = 5;

function getLogDir(): string {
  const stateDir = process.env.canarinho_STATE_DIR?.trim();
  return stateDir ? path.resolve(stateDir) : path.join(os.homedir(), ".canarinho");
}

function getLogFile(): string {
  return path.join(getLogDir(), "canarinho.log");
}

function ensureDir(): void {
  fs.mkdirSync(getLogDir(), { recursive: true });
}

function rotateIfNeeded(): void {
  const logFile = getLogFile();
  try {
    const stats = fs.statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      // Shift numbered archives: delete oldest, then rename 4->5, 3->4, ..., 1->2, current->1
      const oldest = `${logFile}.${MAX_ROTATED_FILES}`;
      try { fs.unlinkSync(oldest); } catch {}
      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const src = `${logFile}.${i}`;
        const dst = `${logFile}.${i + 1}`;
        try { fs.renameSync(src, dst); } catch { /* race with concurrent writer — acceptable */ }
      }
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {}
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Debug lines are high-volume diagnostics (e.g. per-agent dispatch rounds
 * fire several times per second and were filling the 5MB log rotation).
 * They are dropped unless canarinho_DEBUG is set.
 */
function debugLoggingEnabled(): boolean {
  const v = process.env.canarinho_DEBUG?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

let isolationViolationReported = false;

function writeLine(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  if (level === "debug" && !debugLoggingEnabled()) return;
  try {
    assertStatePathIsolation(getLogFile(), "logger");
  } catch (err) {
    // Guard tripped: a guarded process resolved the production log path.
    // Drop the line — the production log must never be polluted — but do
    // not throw: logging must never take down execution, and production
    // timers (sweeps, cron teardowns) routinely fire after a test has
    // ended and restored its env, which would otherwise turn every late
    // write into an unhandledRejection that fails the whole test file.
    if (!isolationViolationReported) {
      isolationViolationReported = true;
      process.stderr.write(`[logger] ${String(err instanceof Error ? err.message : err)} — log line dropped (reported once)\n`);
    }
    return;
  }
  try {
    ensureDir();
    rotateIfNeeded();
    const ts = formatTimestamp();
    const extraStr = extra ? " " + JSON.stringify(extra) : "";
    const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${message}${extraStr}\n`;
    fs.appendFileSync(getLogFile(), line, "utf-8");
  } catch {
    // Logging must never take down workflow execution.
  }
}

export const logger = {
  info(message: string, extra?: Record<string, unknown>) {
    writeLine("info", message, extra);
  },
  warn(message: string, extra?: Record<string, unknown>) {
    writeLine("warn", message, extra);
  },
  error(message: string, extra?: Record<string, unknown>) {
    writeLine("error", message, extra);
  },
  debug(message: string, extra?: Record<string, unknown>) {
    writeLine("debug", message, extra);
  },
};

export const log = (
  level: string,
  message: string,
  extra?: Record<string, unknown>,
): void => {
  writeLine(level as LogLevel, message, extra);
};

export function formatEntry(entry: {
  timestamp: string;
  level: string;
  message: string;
  runId?: string;
}): string {
  const runPart = entry.runId ? `[${entry.runId.slice(0, 8)}] ` : "";
  return `[${entry.timestamp.replace("T", " ").slice(0, 19)}] [${entry.level.toUpperCase()}] ${runPart}${entry.message}`;
}

export async function readRecentLogs(lines = 50): Promise<string[]> {
  try {
    const content = fs.readFileSync(getLogFile(), "utf-8");
    const all = content.trim().split("\n").filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

export function getLogPath(): string {
  return getLogFile();
}
