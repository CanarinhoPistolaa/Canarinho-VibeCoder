/**
 * Doctor — tamandua one-shot diagnostic tool.
 *
 * Runs grouped health checks (ENVIRONMENT, SERVICES, STALENESS, STATE, LLM PROMPT ADHERENCE)
 * and produces pass/fail output with exact remedy commands for failures.
 * All functions return results rather than printing directly, so the
 * CLI layer handles I/O and tests can assert on data.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  isRunning,
  readControlPlanePort,
  readPort,
  readMcpPort,
  isMcpRunning,
  readLogTail,
  getLogFile,
  getMcpPidFile,
} from "./server/daemonctl.js";
import type { DaemonctlPathOptions } from "./server/daemonctl.js";
import { getBuildVersion } from "./lib/version.js";
import { parseExpectedKeys } from "./installer/step-ops.js";
import { getDb } from "./db.js";
import { runMedicCheck } from "./medic/medic.js";
import type { MedicFinding } from "./medic/medic.js";
import { getRunWorktree } from "./installer/worktree-manager.js";
import { getProcPids, processBelongsToRun } from "./installer/run-cleanup.js";

// ── Types ──────────────────────────────────────────────────────────

export interface DoctorCheckResult {
  /** Human-readable name of the check (e.g. "Node.js >= 22"). */
  name: string;
  /** Check outcome. */
  status: "pass" | "fail" | "warn" | "info";
  /** Human-readable detail message. */
  message: string;
  /** Exact command to run to fix the issue (only for non-pass statuses). */
  remedy?: string;
}

export interface CheckGroup {
  /** Category label (e.g. "ENVIRONMENT", "SERVICES", etc.). */
  label: string;
  /** Checks in this group. */
  checks: DoctorCheckResult[];
}

// ── Formatter ──────────────────────────────────────────────────────

const STATUS_ICONS: Record<DoctorCheckResult["status"], string> = {
  pass: "✓",
  fail: "✗",
  warn: "⚠",
  info: "ℹ",
};

/**
 * Format check results into a human-readable string.
 *
 * Returns the full output text. Does NOT print to stdout/stderr — the
 * CLI layer handles I/O.
 *
 * @returns The formatted output as a string. Also returns whether any
 *          checks failed (for exit-code logic in the CLI).
 */
export function formatDoctorOutput(groups: CheckGroup[]): { output: string; hasFailures: boolean } {
  const lines: string[] = [];
  let hasFailures = false;
  let warningCount = 0;

  for (const group of groups) {
    lines.push(`─── ${group.label} ───`);
    for (const check of group.checks) {
      const icon = STATUS_ICONS[check.status];
      lines.push(`  ${icon} ${check.name}: ${check.message}`);
      if (check.remedy) {
        lines.push(`    → remedy: ${check.remedy}`);
      }
      if (check.status === "fail") {
        hasFailures = true;
      }
      if (check.status === "warn") {
        warningCount++;
      }
    }
    lines.push("");
  }

  if (hasFailures) {
    lines.push("Some checks failed. Review the remedies above to fix each issue.");
  } else if (warningCount > 0) {
    lines.push(`All checks passed with ${warningCount} warning(s) - review items marked with the warning symbol above.`);
  } else {
    lines.push("All checks passed.");
  }

  return { output: lines.join("\n"), hasFailures };
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Check whether a command is available on PATH.
 * Uses `command -v` (POSIX) to avoid shell aliases and builtins.
 */
function commandIsOnPath(name: string): boolean {
  try {
    const stdout = execSync(`command -v "${name}"`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── ENVIRONMENT checks ──────────────────────────────────────────

/**
 * Probe `node:sqlite` availability. This module only exists in Node.js >= 22.
 * Incompatible runtimes (Bun, node-wrapper, etc.) will throw on import.
 */
async function checkNodeVersion(): Promise<DoctorCheckResult> {
  try {
    await import("node:sqlite");
    const version = process.version;
    return {
      name: "Node.js >= 22",
      status: "pass",
      message: `Node.js ${version} detected`,
    };
  } catch {
    return {
      name: "Node.js >= 22",
      status: "fail",
      message:
        "node:sqlite is unavailable — you may be running an incompatible runtime (Bun, node-wrapper, or Node.js < 22). A real Node.js >= 22 installation is required.",
      remedy:
        "Install Node.js >= 22 from https://nodejs.org or via nvm / fnm",
    };
  }
}

/** Check that `pi` is available on PATH. */
function checkPiOnPath(): DoctorCheckResult {
  const found = commandIsOnPath("pi");
  if (found) {
    return {
      name: "pi present on PATH",
      status: "pass",
      message: "pi found on PATH",
    };
  }
  return {
    name: "pi present on PATH",
    status: "fail",
    message: "pi not found on PATH",
    remedy:
      "Install pi: https://github.com/igorhvr/pi or clone and ./install",
  };
}

/** Check that `gh` (GitHub CLI) is available on PATH. */
function checkGhOnPath(): DoctorCheckResult {
  const found = commandIsOnPath("gh");
  if (found) {
    return {
      name: "gh present",
      status: "pass",
      message: "gh found on PATH",
    };
  }
  return {
    name: "gh present",
    status: "fail",
    message: "gh not found on PATH",
    remedy:
      "Install GitHub CLI: https://cli.github.com",
  };
}

/**
 * Detect `pi-token-saver` on PATH.
 * This is an optional tool — never fail, always report as "info" or "pass".
 */
function checkPiTokenSaver(): DoctorCheckResult {
  const found = commandIsOnPath("pi-token-saver");
  if (found) {
    return {
      name: "pi-token-saver detection",
      status: "pass",
      message: "pi-token-saver found on PATH (optional token-saving tool)",
    };
  }
  return {
    name: "pi-token-saver detection",
    status: "info",
    message:
      "pi-token-saver not found on PATH (optional — only preferred by no-hurry runs)",
  };
}

/**
 * Detect Hermes binary availability.
 * Checks `TAMANDUA_HERMES_BINARY` env var first, then PATH.
 * Hermes support is alpha — always informational.
 */
function checkHermesBinary(): DoctorCheckResult {
  const envBinary = process.env.TAMANDUA_HERMES_BINARY;
  if (envBinary) {
    return {
      name: "TAMANDUA_HERMES_BINARY / hermes",
      status: "info",
      message: `TAMANDUA_HERMES_BINARY is set to: ${envBinary}`,
    };
  }
  const onPath = commandIsOnPath("hermes");
  if (onPath) {
    return {
      name: "TAMANDUA_HERMES_BINARY / hermes",
      status: "info",
      message: "hermes found on PATH (alpha support)",
    };
  }
  return {
    name: "TAMANDUA_HERMES_BINARY / hermes",
    status: "info",
    message:
      "TAMANDUA_HERMES_BINARY not set and hermes not found on PATH (alpha support — optional)",
  };
}

// ── Doctor options ──────────────────────────────────────────────

/** Options for runDoctorChecks. */
export interface DoctorOpts {
  /** Override HOME directory for test isolation. */
  homeDir?: string;
}

// ── STALENESS check (US-005) ───────────────────────────────────

/**
 * Compare the running daemon's buildVersion (from control plane health)
 * against the local dist/version file.
 *
 * - If buildVersion differs: fail with dashboard restart remedy
 * - If buildVersion is missing (old daemon): warn with inconclusive message
 * - If control plane is unreachable: info (skip — covered by SERVICES)
 * - If matches: pass
 */
async function runStalenessCheck(opts?: DoctorOpts): Promise<DoctorCheckResult[]> {
  const dctlOpts: DaemonctlPathOptions | undefined = opts?.homeDir ? { homeDir: opts.homeDir } : undefined;
  const localVersion = getBuildVersion();

  // Try to fetch health from the control plane.
  try {
    const cpPort = readControlPlanePort(dctlOpts);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${cpPort}/control/health`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      return [{
        name: "Daemon build version vs installed",
        status: "info",
        message: "Staleness check skipped (control plane health returned non-200)",
      }];
    }

    const body = await res.json() as Record<string, unknown>;
    const daemonVersion = body.buildVersion as string | undefined;

    if (daemonVersion === undefined) {
      return [{
        name: "Daemon build version vs installed",
        status: "warn",
        message: "Staleness check inconclusive — daemon predates build version reporting",
        remedy: "Run: tamandua dashboard restart to update",
      }];
    }

    if (daemonVersion !== localVersion) {
      return [{
        name: "Daemon build version vs installed",
        status: "fail",
        message: `Daemon running build ${daemonVersion} but installed build is ${localVersion}`,
        remedy: "Run: tamandua dashboard restart",
      }];
    }

    return [{
      name: "Daemon build version vs installed",
      status: "pass",
      message: `Daemon build ${daemonVersion} matches installed build ${localVersion}`,
    }];
  } catch {
    return [{
      name: "Daemon build version vs installed",
      status: "info",
      message: "Staleness check skipped (control plane unreachable — covered by SERVICES checks above)",
    }];
  }
}

// ── SERVICES checks (US-004) ─────────────────────────────────────

async function runServicesChecks(opts?: DoctorOpts): Promise<DoctorCheckResult[]> {
  const dctlOpts: DaemonctlPathOptions | undefined = opts?.homeDir ? { homeDir: opts.homeDir } : undefined;
  const results: DoctorCheckResult[] = [];
  const daemonStatus = isRunning(dctlOpts);

  // Lazily read daemon log tail on first failure
  let logTail: string | null = null;
  function getLogTailOnce(): string {
    if (logTail === null) {
      logTail = readLogTail(getLogFile(dctlOpts), 20);
    }
    return logTail;
  }
  function withLogTail(msg: string): string {
    const tail = getLogTailOnce();
    return tail ? `${msg}\n\nDaemon log tail:\n${tail}` : msg;
  }

  // 1. Dashboard daemon PID
  if (daemonStatus.running) {
    results.push({
      name: "Dashboard daemon PID alive",
      status: "pass",
      message: `Daemon running (PID ${daemonStatus.pid})`,
    });
  } else {
    results.push({
      name: "Dashboard daemon PID alive",
      status: "fail",
      message: withLogTail("Daemon is not running"),
      remedy: "tamandua dashboard start",
    });
  }

  // 2. Control plane health
  if (daemonStatus.running) {
    try {
      const cpPort = readControlPlanePort(dctlOpts);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`http://127.0.0.1:${cpPort}/control/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        results.push({
          name: "Control plane reachable",
          status: "pass",
          message: `Control plane responding on port ${cpPort}`,
        });
      } else {
        results.push({
          name: "Control plane reachable",
          status: "fail",
          message: withLogTail(`Control plane returned HTTP ${res.status} on port ${cpPort}`),
          remedy: "tamandua dashboard restart",
        });
      }
    } catch {
      results.push({
        name: "Control plane reachable",
        status: "fail",
        message: withLogTail(`Control plane unreachable on port ${readControlPlanePort(dctlOpts)}`),
        remedy: "tamandua dashboard restart",
      });
    }
  } else {
    results.push({
      name: "Control plane reachable",
      status: "fail",
      message: "Control plane unreachable (daemon is not running)",
      remedy: "tamandua dashboard start",
    });
  }

  // 3. Dashboard HTTP
  if (daemonStatus.running) {
    try {
      const dashPort = readPort(dctlOpts);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`http://127.0.0.1:${dashPort}/`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        results.push({
          name: "Dashboard HTTP up",
          status: "pass",
          message: `Dashboard responding on port ${dashPort}`,
        });
      } else {
        results.push({
          name: "Dashboard HTTP up",
          status: "fail",
          message: withLogTail(`Dashboard returned HTTP ${res.status} on port ${dashPort}`),
          remedy: "tamandua dashboard restart",
        });
      }
    } catch {
      results.push({
        name: "Dashboard HTTP up",
        status: "fail",
        message: withLogTail(`Dashboard unreachable on port ${readPort(dctlOpts)}`),
        remedy: "tamandua dashboard restart",
      });
    }
  } else {
    results.push({
      name: "Dashboard HTTP up",
      status: "fail",
      message: "Dashboard unreachable (daemon is not running)",
      remedy: "tamandua dashboard start",
    });
  }

  // 4. MCP server status
  const mcpPidFile = getMcpPidFile(dctlOpts);
  const mcpPidFileExists = fs.existsSync(mcpPidFile);
  if (mcpPidFileExists) {
    const mcpStatus = isMcpRunning(dctlOpts);
    const mcpPort = readMcpPort(dctlOpts);
    if (mcpStatus.running) {
      results.push({
        name: "MCP server status",
        status: "pass",
        message: `MCP server running (PID ${mcpStatus.pid}, port ${mcpPort})`,
      });
    } else {
      results.push({
        name: "MCP server status",
        status: "fail",
        message: withLogTail(`MCP pidfile exists but process not running (pidfile: ${mcpPidFile})`),
        remedy: "tamandua mcp restart",
      });
    }
  } else {
    results.push({
      name: "MCP server status",
      status: "info",
      message: "MCP server is not running (optional — start with: tamandua mcp start)",
    });
  }

  return results;
}

// ── STATE checks (US-006) ──────────────────────────────────────────

/** Map MedicFinding severity to DoctorCheckResult status. */
function medicSeverityToStatus(severity: MedicFinding["severity"]): DoctorCheckResult["status"] {
  switch (severity) {
    case "critical": return "fail";
    case "warning": return "warn";
    default: return "info";
  }
}

/** Map MedicFinding action to a readable remedy hint. */
function medicActionToRemedy(action: MedicFinding["action"]): string | undefined {
  switch (action) {
    case "fail_run":
      return "Medic would fail the zombie run. Run: tamandua medic check to auto-remediate.";
    case "teardown_crons":
      return "Medic would teardown idle workflow crons. Run: tamandua medic check to auto-remediate.";
    case "none":
    default:
      return undefined;
  }
}

/**
 * Run STATE checks: database health and run-level anomaly detection.
 *
 * - Opens the database via getDb() and runs a simple query to verify connectivity.
 * - Calls runMedicCheck() to detect stuck steps and zombie runs.
 * - Does NOT write new detection logic — wires the existing medic.
 */
async function runStateChecks(opts?: DoctorOpts): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];

  // If an isolated homeDir is provided, point DB resolution at it.
  // getDb() reads process.env.TAMANDUA_DB_PATH, so we set it temporarily.
  const savedDbPath = process.env.TAMANDUA_DB_PATH;
  if (opts?.homeDir) {
    process.env.TAMANDUA_DB_PATH = path.join(opts.homeDir, ".tamandua", "tamandua.db");
  }

  try {
    // ── 1. Database connectivity check ──
    try {
      const db = getDb();
      // A simple query that exercises the connection.
      db.prepare("SELECT 1").get();
      results.push({
        name: "Database opens",
        status: "pass",
        message: "Database opened successfully",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        name: "Database opens",
        status: "fail",
        message: `Database failed to open: ${msg}`,
        remedy: "Check disk space and file permissions. Ensure the database directory exists and is writable.",
      });
      // Can't run medic if DB doesn't open — return early.
      return results;
    }

    // ── 2. Run-level anomalies (via medic) ──
    try {
      const medicResult = await runMedicCheck();

      if (medicResult.findings.length === 0) {
        results.push({
          name: "Run-level anomalies",
          status: "pass",
          message: "No run-level anomalies detected",
        });
      } else {
        for (const finding of medicResult.findings) {
          results.push({
            name: "Run-level anomaly",
            status: medicSeverityToStatus(finding.severity),
            message: finding.message,
            remedy: medicActionToRemedy(finding.action),
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        name: "Run-level anomalies",
        status: "warn",
        message: `Medic check could not be completed: ${msg}`,
        remedy: "Ensure the database is accessible and medic tables exist. Run: tamandua medic check",
      });
    }

    return results;
  } finally {
    // Restore the original DB path.
    if (savedDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = savedDbPath;
    } else if (opts?.homeDir) {
      delete process.env.TAMANDUA_DB_PATH;
    }
  }
}

// ── Process-Leak Check (US-004) ──────────────────────────────────

/**
 * Scan for processes tied to terminal runs — report-only, never kills.
 *
 * Serves as the accountability layer for accepted sweep-miss risks:
 * daemon restarted before a pending sweep timer fired, late-detaching
 * stragglers after the one-shot sweep, etc.
 */
function runProcessLeakChecks(opts?: DoctorOpts): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  // Check if /proc exists (Linux only) — skip gracefully on non-Linux
  try {
    fs.accessSync("/proc", fs.constants.R_OK);
  } catch {
    return results;
  }

  const savedDbPath = process.env.TAMANDUA_DB_PATH;
  if (opts?.homeDir) {
    process.env.TAMANDUA_DB_PATH = path.join(opts.homeDir, ".tamandua", "tamandua.db");
  }

  try {
    const db = getDb();

    const rows = db
      .prepare("SELECT id FROM runs WHERE status IN ('completed', 'failed', 'canceled')")
      .all() as { id: string }[];

    for (const row of rows) {
      const runId = row.id;

      const wt = getRunWorktree(runId);
      if (!wt) continue;

      // Worktree directory may have been removed — skip gracefully
      if (!fs.existsSync(wt.worktreePath)) continue;

      const pids = getProcPids();
      for (const pid of pids) {
        if (pid === process.pid) continue;

        const evidence = processBelongsToRun(pid, runId, wt.worktreePath);
        if (evidence) {
          results.push({
            name: "Run-process leak",
            status: "warn",
            message: `Process ${pid} belongs to terminal run ${runId}: ${evidence}`,
            remedy: `Manual cleanup: kill ${pid}`,
          });
        }
      }
    }

    return results;
  } finally {
    if (savedDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = savedDbPath;
    } else if (opts?.homeDir) {
      delete process.env.TAMANDUA_DB_PATH;
    }
  }
}

// ── Check Runner ───────────────────────────────────────────────────

/**
 * Run all doctor check groups.
 *
 * Orchestrates the four check categories:
 *   1. ENVIRONMENT — runtime environment checks (Node.js, pi, gh, etc.)
 *   2. SERVICES    — daemon, control plane, dashboard, MCP liveness
 *   3. STALENESS   — running daemon build vs. installed build
 *   4. STATE       — database health, run-level anomalies, process leaks
 */
/**
 * Run LLM PROMPT ADHERENCE checks: per-step key-emission rates.
 *
 * Queries the most recent 50 terminal runs and checks which Reply-with
 * contract keys each DONE step actually delivered in the run context.
 * Reports emission rates grouped by workflow, warns on keys below 50%
 * over at least 5 samples.
 */
export async function runLlmPromptAdherenceChecks(opts?: DoctorOpts): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];

  const savedDbPath = process.env.TAMANDUA_DB_PATH;
  if (opts?.homeDir) {
    process.env.TAMANDUA_DB_PATH = path.join(opts.homeDir, ".tamandua", "tamandua.db");
  }

  try {
    const db = getDb();

    // Query most recent 50 terminal runs
    const runs = db.prepare(
      `SELECT id, workflow_id, status, context, created_at, updated_at
       FROM runs
       WHERE status IN ('completed', 'failed', 'canceled')
       ORDER BY updated_at DESC
       LIMIT 50`
    ).all() as { id: string; workflow_id: string; status: string; context: string; created_at: string; updated_at: string }[];

    if (runs.length === 0) {
      return results;
    }

    if (runs.length < 5) {
      results.push({
        name: "Key-emission rates",
        status: "info",
        message: `Insufficient data — only ${runs.length} terminal runs found (need at least 5)`,
      });
      return results;
    }

    // Aggregation: workflow_id → step_id → key → { present, total }
    const stats: Record<string, Record<string, Record<string, { present: number; total: number }>>> = {};
    let totalKeysTracked = 0;
    let totalKeyPresence = 0;

    for (const run of runs) {
      let runContext: Record<string, unknown> = {};
      try {
        runContext = JSON.parse(run.context);
      } catch {
        // Legacy / corrupt context — treat as empty
      }

      const steps = db.prepare(
        `SELECT step_id, input_template
         FROM steps
         WHERE run_id = ? AND status = 'done'
         ORDER BY step_index ASC`
      ).all(run.id) as { step_id: string; input_template: string }[];

      const wfId = run.workflow_id;

      for (const step of steps) {
        const expectedKeys = parseExpectedKeys(step.input_template);
        if (expectedKeys.length === 0) continue;

        const wfStats = (stats[wfId] = stats[wfId] ?? {});
        const keyStats = (wfStats[step.step_id] = wfStats[step.step_id] ?? {});

        for (const key of expectedKeys) {
          const entry = (keyStats[key] = keyStats[key] ?? { present: 0, total: 0 });
          entry.total++;
          if (hasOwn(runContext, key)) {
            entry.present++;
            totalKeyPresence++;
          }
          totalKeysTracked++;
        }
      }
    }

    // Generate output lines — only entries below 100%
    for (const [wfId, wfStats] of Object.entries(stats).sort()) {
      for (const [stepId, keyMap] of Object.entries(wfStats).sort()) {
        for (const [key, entry] of Object.entries(keyMap).sort()) {
          const rate = entry.present / entry.total;
          const percent = (rate * 100).toFixed(0);

          if (rate < 1) {
            if (rate < 0.5 && entry.total >= 5) {
              results.push({
                name: `${wfId} ${stepId} ${key.toUpperCase()}`,
                status: "warn",
                message: `${wfId} ${stepId} ${key.toUpperCase()}: ${entry.present}/${entry.total} (${percent}%)`,
                remedy: `Check the ${stepId} step prompt in ${wfId} workflow for ${key.toUpperCase()} key emission`,
              });
            } else {
              results.push({
                name: `${wfId} ${stepId} ${key.toUpperCase()}`,
                status: "info",
                message: `${wfId} ${stepId} ${key.toUpperCase()}: ${entry.present}/${entry.total} (${percent}%)`,
              });
            }
          }
        }
      }
    }

    // Summary line
    const overallRate = totalKeysTracked > 0 ? totalKeyPresence / totalKeysTracked : 0;
    const overallPercent = (overallRate * 100).toFixed(0);
    const oldest = runs[runs.length - 1].updated_at;
    const newest = runs[0].updated_at;

    results.push({
      name: "Summary",
      status: "info",
      message: `${totalKeysTracked} keys tracked across ${runs.length} runs (${oldest} → ${newest}), overall emission rate: ${overallPercent}%`,
    });

    return results;
  } finally {
    if (savedDbPath !== undefined) {
      process.env.TAMANDUA_DB_PATH = savedDbPath;
    } else if (opts?.homeDir) {
      delete process.env.TAMANDUA_DB_PATH;
    }
  }
}

/** Orphan-safe own-property check. */
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export async function runDoctorChecks(opts?: DoctorOpts): Promise<CheckGroup[]> {
  // ENVIRONMENT — wired in US-003
  const environmentChecks = await Promise.all([
    checkNodeVersion(),
    Promise.resolve(checkPiOnPath()),
    Promise.resolve(checkGhOnPath()),
    Promise.resolve(checkPiTokenSaver()),
    Promise.resolve(checkHermesBinary()),
  ]);

  // SERVICES — wired in US-004
  const servicesChecks = await runServicesChecks(opts);

  // STALENESS — wired in US-005
  const stalenessChecks = await runStalenessCheck(opts);

  // STATE — wired in US-006
  const stateChecks = await runStateChecks(opts);

  // Process-leak checks — wired in US-004 (report-only, appended after existing STATE checks)
  const leakChecks = runProcessLeakChecks(opts);
  stateChecks.push(...leakChecks);

  // LLM PROMPT ADHERENCE — wired in US-001
  const adherenceChecks = await runLlmPromptAdherenceChecks(opts);

  return [
    { label: "ENVIRONMENT", checks: environmentChecks },
    { label: "SERVICES", checks: servicesChecks },
    { label: "STALENESS", checks: stalenessChecks },
    { label: "STATE", checks: stateChecks },
    { label: "LLM PROMPT ADHERENCE", checks: adherenceChecks },
  ];
}
