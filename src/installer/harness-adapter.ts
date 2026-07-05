import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { HarnessType } from "./types.js";
import { logger } from "../lib/logger.js";
import { formatPiCommandPreview } from "./pi-command-preview.js";
import { parsePiOutputStream } from "./pi-stream-parser.js";

// ── Harness round result ───────────────────────────────────────────

export interface HarnessRoundResult {
  /** Full output from the harness round (stdout). */
  output: string;
  /**
   * Optional session reference populated by harnesses that track
   * session continuity (e.g. hermes `session_id` trailer).
   * Placeholder for future use — not populated in this phase.
   */
  sessionRef?: string;
}

// ── Run options shared across harnesses ────────────────────────────

export interface RunHarnessOptions {
  timeout?: number; // seconds, default 60
  workdir?: string;
  env?: Record<string, string>;
  /**
   * Optional callback invoked once the child process is spawned.
   */
  onSpawn?: (handle: { pid: number; pgid: number }) => void;
  /**
   * When true (runs launched with --no-hurry-please-save-tokens-mode),
   * prefer a `pi-token-saver` command from PATH over `pi`.
   * pi-only — hermes adapters accept but ignore this option.
   */
  preferTokenSaver?: boolean;
}

// ── Adapter interface ──────────────────────────────────────────────

export interface HarnessAdapter {
  readonly type: HarnessType;

  /**
   * Resolve the harness binary path.
   * For pi: honors TAMANDUA_PI_BINARY env, pi-token-saver preference,
   * and PATH search.
   * For hermes: honors TAMANDUA_HERMES_BINARY env and PATH search.
   */
  findBinary(options?: { preferTokenSaver?: boolean }): Promise<string>;

  /**
   * Run a single work round from `prompt` through the harness binary,
   * returning the complete output and any session metadata.
   */
  runRound(
    prompt: string,
    options?: RunHarnessOptions,
  ): Promise<HarnessRoundResult>;
}

// ── Shared helpers (minimally duplicated from agent-scheduler) ─────

function searchPathForExecutable(name: string): string | null {
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found in this dir, keep looking
    }
  }
  return null;
}

const MAX_LOG_STREAM_PREVIEW = 200;

interface StreamLogMetadata {
  bytes: number;
  preview: string;
  truncated: boolean;
}

function buildStreamLogMetadata(stream: string): StreamLogMetadata {
  const normalized = stream.trim();
  const truncated = normalized.length > MAX_LOG_STREAM_PREVIEW;
  const preview = truncated
    ? `${normalized.slice(0, MAX_LOG_STREAM_PREVIEW)}…`
    : normalized;

  return {
    bytes: Buffer.byteLength(stream, "utf-8"),
    preview,
    truncated,
  };
}

function safeKillPgid(pgid: number, signal: NodeJS.Signals): void {
  try {
    // Negative PID => kill the entire process group.
    process.kill(-pgid, signal);
  } catch {
    // Group may already be gone.
  }
}

// ── PiHarnessAdapter ───────────────────────────────────────────────

class PiHarnessAdapter implements HarnessAdapter {
  readonly type: HarnessType = "pi";

  async findBinary(
    options?: { preferTokenSaver?: boolean },
  ): Promise<string> {
    // Prefer explicit env override
    const envPi = process.env.TAMANDUA_PI_BINARY?.trim();
    if (envPi) {
      try {
        fs.accessSync(envPi, fs.constants.X_OK);
        return envPi;
      } catch {
        throw new Error(
          `TAMANDUA_PI_BINARY set but not executable: ${envPi}`,
        );
      }
    }

    if (options?.preferTokenSaver) {
      const tokenSaver = searchPathForExecutable("pi-token-saver");
      if (tokenSaver) return tokenSaver;
      // Not installed (yet) — fall through to normal pi resolution.
    }

    const pi = searchPathForExecutable("pi");
    if (pi) return pi;

    throw new Error(
      "pi binary not found in PATH. Install pi (https://github.com/anthropics/pi) or set TAMANDUA_PI_BINARY.",
    );
  }

  async runRound(
    prompt: string,
    options?: RunHarnessOptions,
  ): Promise<HarnessRoundResult> {
    const timeoutMs = ((options?.timeout) ?? 60) * 1000;
    const piPath = await this.findBinary({
      preferTokenSaver: options?.preferTokenSaver,
    });

    // pi --print mode: single-shot work prompt
    const args = ["--print", "--mode", "json", "--no-session", prompt];

    const childEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
      ...(options?.env ?? {}),
    };

    const preview = formatPiCommandPreview(piPath, args);
    const startedAt = Date.now();

    logger.info("pi pre-launch", {
      commandPreview: preview.commandPreview,
      argvPreview: preview.argvPreview,
      redactedIndices: preview.redactedIndices,
      truncatedIndices: preview.truncatedIndices,
      promptElided: preview.promptElided,
      argCount: preview.argCount,
      timeoutMs,
      workdir: options?.workdir,
    });

    // Spawn pi in its own process group so termination paths can kill the
    // whole subtree (pi spawns its own child processes for tools/sessions).
    const child = spawn(piPath, args, {
      cwd: options?.workdir ?? process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const childPid = child.pid;
    // On Linux, the spawned child becomes its own group leader (pgid === pid)
    // when detached:true. Fall back to childPid if getpgid is unavailable.
    const pgid = childPid ?? 0;

    if (childPid && options?.onSpawn) {
      try {
        options.onSpawn({ pid: childPid, pgid });
      } catch (err) {
        logger.warn("pi onSpawn callback threw", { error: String(err) });
      }
    }

    logger.info("pi launched", {
      pid: childPid ?? null,
      pgid,
      timeoutMs,
      workdir: options?.workdir,
    });

    // End stdin immediately — pi --print waits for stdin EOF before responding
    child.stdin?.end();

    // Collect stderr (bounded)
    let stderrPieces: string[] = [];
    let stderrBytes = 0;
    const MAX_STDERR_BYTES = 10 * 1024 * 1024; // 10MB cap for stderr
    child.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      if (stderrBytes + Buffer.byteLength(str, "utf-8") <= MAX_STDERR_BYTES) {
        stderrPieces.push(str);
        stderrBytes += Buffer.byteLength(str, "utf-8");
      }
    });

    // Stream stdout through readline → parsePiOutputStream.
    const rl = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });
    const parseResultPromise = parsePiOutputStream(rl);

    // Wait for child exit. Apply timeout guard.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Terminate the whole process group: SIGTERM, then SIGKILL after 5s.
        if (pgid) {
          safeKillPgid(pgid, "SIGTERM");
          setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            /* best effort */
          }
        }
        reject(new Error(`pi timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0 || code === null) {
          resolve();
        } else {
          const failureDurationMs = Date.now() - startedAt;
          const failureStderr = stderrPieces.join("");
          const failureStderrMeta = buildStreamLogMetadata(failureStderr);
          logger.error("pi execution failed", {
            pid: childPid ?? null,
            pgid,
            exitCode: code,
            signal,
            durationMs: failureDurationMs,
            stderrBytes: failureStderrMeta.bytes,
            stderrPreview: failureStderrMeta.preview,
            stderrTruncated: failureStderrMeta.truncated,
          });
          const stderrSuffix = failureStderr
            ? `\nstderr: ${failureStderr}`
            : "";
          reject(
            new Error(
              `pi failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`,
            ),
          );
        }
      });
    });

    // Wait for stdout parsing to finish (it will complete once stdout closes)
    const parseResult = await parseResultPromise;

    const durationMs = Date.now() - startedAt;
    const stderrOut = stderrPieces.join("");
    const stderrMeta = buildStreamLogMetadata(stderrOut);

    if (stderrMeta.preview) {
      logger.warn("pi stderr", {
        pid: childPid ?? null,
        stderrBytes: stderrMeta.bytes,
        stderrPreview: stderrMeta.preview,
        stderrTruncated: stderrMeta.truncated,
      });
    }

    // Reconstruct filtered stdout from parsed events for backwards compatibility.
    const filteredLines: string[] = [];
    if (parseResult.textFallback !== null) {
      filteredLines.push(parseResult.textFallback);
    }
    for (const event of parseResult.events) {
      filteredLines.push(JSON.stringify(event));
    }
    if (parseResult.assistantText.length > 0) {
      filteredLines.push(parseResult.assistantText);
    }
    const filteredStdout = filteredLines.join("\n");
    const stdoutMeta = buildStreamLogMetadata(filteredStdout);

    logger.info("pi completed", {
      pid: childPid ?? null,
      pgid,
      durationMs,
      exitCode: child.exitCode,
      signal: child.signalCode,
      stdoutBytes: stdoutMeta.bytes,
      stdoutPreview: stdoutMeta.preview,
      stdoutTruncated: stdoutMeta.truncated,
      stderrBytes: stderrMeta.bytes,
      hasStderr: stderrMeta.bytes > 0,
    });

    return { output: filteredStdout.trim() };
  }
}

// ── HermesHarnessAdapter ──────────────────────────────────────────

class HermesHarnessAdapter implements HarnessAdapter {
  readonly type: HarnessType = "hermes";

  async findBinary(
    _options?: { preferTokenSaver?: boolean },
  ): Promise<string> {
    // Prefer explicit env override
    const envHermes = process.env.TAMANDUA_HERMES_BINARY?.trim();
    if (envHermes) {
      try {
        fs.accessSync(envHermes, fs.constants.X_OK);
        return envHermes;
      } catch {
        throw new Error(
          `TAMANDUA_HERMES_BINARY set but not executable: ${envHermes}`,
        );
      }
    }

    // Search PATH
    const hermes = searchPathForExecutable("hermes");
    if (hermes) return hermes;

    throw new Error(
      "hermes binary not found in PATH. Install hermes or set TAMANDUA_HERMES_BINARY.",
    );
  }

  async runRound(
    prompt: string,
    options?: RunHarnessOptions,
  ): Promise<HarnessRoundResult> {
    const timeoutMs = ((options?.timeout) ?? 60) * 1000;
    const hermesPath = await this.findBinary();

    const childEnv: Record<string, string | undefined> = {
      ...(process.env as Record<string, string | undefined>),
      ...(options?.env ?? {}),
    };

    const startedAt = Date.now();

    // Hermes single-shot invocation:
    // -q <prompt> delivers the task in single message mode.
    // --max-turns 8192 gives the agent plenty of room to complete the work.
    // --yolo skips permission confirmations (hermes equivalent of pi -y).
    // -Q suppresses banner/spinner (but NOT session_id).
    // Keep user config enabled so Hermes uses the configured provider/model.
    const args = [
      "chat",
      "--max-turns",
      "8192",
      "--yolo",
      "-Q",
      "-q",
      prompt,
    ];

    logger.info("hermes pre-launch", {
      harness: "hermes",
      hermesPath,
      promptLength: Buffer.byteLength(prompt, "utf-8"),
      timeoutMs,
      workdir: options?.workdir,
    });

    // Spawn hermes in its own process group for clean termination.
    const child = spawn(hermesPath, args, {
      cwd: options?.workdir ?? process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const childPid = child.pid;
    const pgid = childPid ?? 0;

    if (childPid && options?.onSpawn) {
      try {
        options.onSpawn({ pid: childPid, pgid });
      } catch (err) {
        logger.warn("hermes onSpawn callback threw", { error: String(err) });
      }
    }

    logger.info("hermes launched", {
      harness: "hermes",
      pid: childPid ?? null,
      pgid,
      timeoutMs,
      workdir: options?.workdir,
    });

    // End stdin immediately — hermes reads from args (-q).
    child.stdin?.end();

    // Collect stderr (bounded).
    let stderrPieces: string[] = [];
    let stderrBytes = 0;
    const MAX_STDERR_BYTES = 10 * 1024 * 1024;
    child.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      if (
        stderrBytes + Buffer.byteLength(str, "utf-8") <=
        MAX_STDERR_BYTES
      ) {
        stderrPieces.push(str);
        stderrBytes += Buffer.byteLength(str, "utf-8");
      }
    });

    // Collect stdout fully (hermes produces plain text, not JSON events).
    let stdoutPieces: string[] = [];
    let stdoutBytes = 0;
    const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
    child.stdout?.on("data", (chunk: Buffer) => {
      const str = chunk.toString("utf-8");
      if (
        stdoutBytes + Buffer.byteLength(str, "utf-8") <=
        MAX_STDOUT_BYTES
      ) {
        stdoutPieces.push(str);
        stdoutBytes += Buffer.byteLength(str, "utf-8");
      }
    });

    // Wait for child exit, with timeout guard.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (pgid) {
          safeKillPgid(pgid, "SIGTERM");
          setTimeout(() => safeKillPgid(pgid, "SIGKILL"), 5000).unref();
        } else {
          try {
            child.kill("SIGKILL");
          } catch {
            /* best effort */
          }
        }
        reject(new Error(`hermes timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0 || code === null) {
          resolve();
        } else {
          const failureDurationMs = Date.now() - startedAt;
          const failureStderr = stderrPieces.join("");
          const failureStderrMeta = buildStreamLogMetadata(failureStderr);
          logger.error("hermes execution failed", {
            harness: "hermes",
            pid: childPid ?? null,
            pgid,
            exitCode: code,
            signal,
            durationMs: failureDurationMs,
            stderrBytes: failureStderrMeta.bytes,
            stderrPreview: failureStderrMeta.preview,
            stderrTruncated: failureStderrMeta.truncated,
          });
          const stderrSuffix = failureStderr
            ? `\nstderr: ${failureStderr}`
            : "";
          reject(
            new Error(
              `hermes failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`,
            ),
          );
        }
      });
    });

    const durationMs = Date.now() - startedAt;
    const rawStdout = stdoutPieces.join("");
    const stderrOut = stderrPieces.join("");
    const stderrMeta = buildStreamLogMetadata(stderrOut);

    if (stderrMeta.preview) {
      logger.warn("hermes stderr", {
        harness: "hermes",
        pid: childPid ?? null,
        stderrBytes: stderrMeta.bytes,
        stderrPreview: stderrMeta.preview,
        stderrTruncated: stderrMeta.truncated,
      });
    }

    // Filter out session_id lines. Hermes appends a session identifier
    // (e.g. "session_id: 20260518_103004_cdae11") at the end of stdout.
    // Remove it so the scheduler sees clean output.
    const filteredStdout = rawStdout
      .split("\n")
      .filter((line) => !/^session_id:\s*\S+/.test(line.trim()))
      .join("\n")
      .trim();

    const stdoutMeta = buildStreamLogMetadata(filteredStdout);

    logger.info("hermes completed", {
      harness: "hermes",
      pid: childPid ?? null,
      pgid,
      durationMs,
      exitCode: child.exitCode,
      signal: child.signalCode,
      stdoutBytes: stdoutMeta.bytes,
      stdoutPreview: stdoutMeta.preview,
      stdoutTruncated: stdoutMeta.truncated,
      stderrBytes: stderrMeta.bytes,
      hasStderr: stderrMeta.bytes > 0,
    });

    return { output: filteredStdout };
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Return the appropriate {@link HarnessAdapter} for the given harness type.
 *
 * @throws {Error} if the harness type is unknown.
 */
export function getHarnessAdapter(harnessType: string): HarnessAdapter {
  switch (harnessType) {
    case "pi":
      return new PiHarnessAdapter();
    case "hermes":
      return new HermesHarnessAdapter();
    default:
      throw new Error(`unknown harness type: ${harnessType}`);
  }
}
