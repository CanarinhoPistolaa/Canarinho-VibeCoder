import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveTamanduaCli, resolveWorkflowWorkspaceDir } from "./paths.js";
import type { WorkflowSpec, WorkflowAgent } from "./types.js";
import { logger } from "../lib/logger.js";
import { getRoleTimeoutSeconds, inferRole } from "./install.js";
import { formatPiCommandPreview } from "./pi-command-preview.js";
import { emitEvent } from "./events.js";
import { parsePiOutputStream } from "./pi-stream-parser.js";

// ── State ──────────────────────────────────────────────────────────

const CRON_JOBS_FILE = path.join(os.homedir(), ".tamandua", "cron-jobs.json");

/** Maps job id → active setInterval handle */
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Maps job id → persistent metadata for resume-after-restart support */
const jobMetadata = new Map<string, CronJobInfo>();

/**
 * Set of job ids whose pi process is currently running. Used to skip a polling
 * tick when the previous one for the same agent has not finished — without this
 * guard, setInterval keeps spawning new pi every interval even though pi rounds
 * can take 10–30 minutes (per the role timeout), causing process accumulation
 * and memory exhaustion.
 */
const inFlightJobs = new Set<string>();

export interface CronJobInfo {
  id: string;
  name: string;
  workflowId: string;
  agentId: string;
  intervalMinutes: number;
  model?: string;
  workModel?: string;
  sessionLabel?: string;
  timeoutSeconds?: number;
  workdir?: string;
  createdAt: string;
}

export interface CreateCronJobParams {
  workflowId: string;
  agent: WorkflowAgent;
  workflow?: WorkflowSpec;
  intervalMinutes?: number;
  staggerOffsetMs?: number;
  workdir?: string;
}

// ── Persistence helpers ────────────────────────────────────────────

function persistJobs(): void {
  try {
    const dir = path.dirname(CRON_JOBS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const data = JSON.stringify([...jobMetadata.values()], null, 2);
    fs.writeFileSync(CRON_JOBS_FILE, data, "utf-8");
  } catch (err) {
    logger.warn("Failed to persist cron jobs", { error: String(err) });
  }
}

function loadPersistedJobs(): CronJobInfo[] {
  try {
    if (!fs.existsSync(CRON_JOBS_FILE)) return [];
    const raw = fs.readFileSync(CRON_JOBS_FILE, "utf-8");
    return JSON.parse(raw) as CronJobInfo[];
  } catch {
    return [];
  }
}

// ── pi binary discovery ────────────────────────────────────────────

export async function findPiBinary(): Promise<string> {
  // Prefer explicit env override
  const envPi = process.env.TAMANDUA_PI_BINARY?.trim();
  if (envPi) {
    try {
      fs.accessSync(envPi, fs.constants.X_OK);
      return envPi;
    } catch {
      throw new Error(`TAMANDUA_PI_BINARY set but not executable: ${envPi}`);
    }
  }

  // Search PATH
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "pi");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not found in this dir, keep looking
    }
  }

  throw new Error(
    "pi binary not found in PATH. Install pi (https://github.com/anthropics/pi) or set TAMANDUA_PI_BINARY."
  );
}

// ── Low-level pi execution ─────────────────────────────────────────

export interface RunPiOptions {
  timeout?: number; // seconds, default 60
  workdir?: string;
  env?: Record<string, string>;
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
  const preview = truncated ? `${normalized.slice(0, MAX_LOG_STREAM_PREVIEW)}…` : normalized;

  return {
    bytes: Buffer.byteLength(stream, "utf-8"),
    preview,
    truncated,
  };
}

export async function runPi(
  args: string[],
  options: RunPiOptions = {},
): Promise<string> {
  const timeoutMs = (options.timeout ?? 60) * 1000;
  const piPath = await findPiBinary();

  const childEnv: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    ...(options.env ?? {}),
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
    workdir: options.workdir,
  });

  const child = spawn(piPath, args, {
    cwd: options.workdir ?? process.cwd(),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const childPid = child.pid;

  logger.info("pi launched", {
    pid: childPid ?? null,
    timeoutMs,
    workdir: options.workdir,
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
  // parsePiOutputStream consumes the readline iterable and resolves when the
  // stream ends (child stdout closes).
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const parseResultPromise = parsePiOutputStream(rl);

  // Wait for child exit. Apply timeout guard.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
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
          exitCode: code,
          signal,
          durationMs: failureDurationMs,
          stderrBytes: failureStderrMeta.bytes,
          stderrPreview: failureStderrMeta.preview,
          stderrTruncated: failureStderrMeta.truncated,
        });
        const stderrSuffix = failureStderr ? `\nstderr: ${failureStderr}` : "";
        reject(new Error(`pi failed: exited with code ${code}${signal ? ` (signal ${signal})` : ""}${stderrSuffix}`));
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
  // Downstream callers (parsePollingRoundMetadata, classifyPollingRoundOutcome,
  // etc.) consume a string, not an event array. We serialize only the kept
  // JSON events + the assistant text (so the classifier can still read it).
  const filteredLines: string[] = [];
  if (parseResult.textFallback !== null) {
    filteredLines.push(parseResult.textFallback);
  }
  for (const event of parseResult.events) {
    filteredLines.push(JSON.stringify(event));
  }
  // Always include the assistant text so downstream classifiers can read it
  if (parseResult.assistantText.length > 0) {
    filteredLines.push(parseResult.assistantText);
  }
  const filteredStdout = filteredLines.join("\n");
  const stdoutMeta = buildStreamLogMetadata(filteredStdout);

  logger.info("pi completed", {
    pid: childPid ?? null,
    durationMs,
    exitCode: child.exitCode,
    signal: child.signalCode,
    stdoutBytes: stdoutMeta.bytes,
    stdoutPreview: stdoutMeta.preview,
    stdoutTruncated: stdoutMeta.truncated,
    stderrBytes: stderrMeta.bytes,
    hasStderr: stderrMeta.bytes > 0,
  });

  return filteredStdout.trim();
}

// ── Prompt builders ─────────────────────────────────────────────────

/**
 * Build the prompt an agent gets to check for and execute work.
 * Uses step claim/complete/fail commands via the tamandua CLI.
 */
export function buildAgentPrompt(workflowId: string, agentId: string): string {
  const cli = resolveTamanduaCli();

  return [
    `You are agent "${agentId}" in workflow "${workflowId}".`,
    ``,
    `Your job is to poll for work and execute it.`,
    ``,
    `STEP 1 — Check for pending work:`,
    `Run: node "${cli}" step peek "${agentId}"`,
    ``,
    `STEP 2 — If NO_WORK:`,
    `Reply HEARTBEAT_OK and stop. Do NOT do anything else.`,
    ``,
    `STEP 3 — If HAS_WORK:`,
    `Claim the step and capture the JSON response:`,
    `Run: node "${cli}" step claim "${agentId}"`,
    `The output will be JSON: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}`,
    `SAVE the stepId — you MUST use it in step 4.`,
    ``,
    `Read the "input" field carefully. It describes the actual work you must do.`,
    `Execute the work using all available tools and capabilities.`,
    ``,
    `STEP 4 — Report results using the SAVED stepId (NOT the agent ID):`,
    `On success: echo 'STATUS: done
CHANGES: <what you changed>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `On failure: node "${cli}" step fail "<stepId>" "<clear reason>"`,
    ``,
    `CRITICAL: You MUST report results using the step complete or step fail commands.`,
    `Failing to report will leave the workflow stuck forever. Always report, even if you`,
    `could not complete the work — use step fail with a clear reason.`,
  ].join("\n");
}

/**
 * Build the work prompt for when work was already claimed.
 * Does NOT include step claim — just work execution instructions.
 */
export function buildWorkPrompt(workflowId: string, agentId: string): string {
  const cli = resolveTamanduaCli();

  return [
    `You are agent "${agentId}" in workflow "${workflowId}".`,
    `You have already claimed this step. Now execute the work.`,
    ``,
    `The claimed step JSON contains a "stepId" field. You MUST save this and use it`,
    `when reporting results.`,
    ``,
    `Work instructions are in the "input" field. Execute them thoroughly.`,
    ``,
    `When done, report your results using the SAVED stepId (NOT the agent ID):`,
    `On success: echo 'STATUS: done
CHANGES: <what you changed>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `On failure: node "${cli}" step fail "<stepId>" "<reason>"`,
    ``,
    `CRITICAL: You MUST report results. Do not exit without calling step complete or step fail.`,
  ].join("\n");
}

/**
 * Build the polling prompt — a two-phase script executed by `pi --print`.
 *
 * Phase 1 (cheap): peek for work. If none → HEARTBEAT_OK.
 * Phase 2 (work):   if work exists, claim it and execute.
 */
export function buildPollingPrompt(
  workflowId: string,
  agentId: string,
): string {
  const cli = resolveTamanduaCli();

  return [
    `You are a polling agent for workflow "${workflowId}", agent "${agentId}".`,
    `You run in --print mode. Your goal: check for work and execute it if present.`,
    ``,
    `─── PHASE 1: PEEK ───`,
    `Run this exact command and capture its output:`,
    `node "${cli}" step peek "${agentId}"`,
    ``,
    `If the output contains NO_WORK:`,
    `  Reply exactly: HEARTBEAT_OK`,
    `  Then STOP. Do not proceed to PHASE 2.`,
    ``,
    `If the output contains HAS_WORK:`,
    `  Proceed to PHASE 2.`,
    ``,
    `─── PHASE 2: CLAIM AND EXECUTE ───`,
    `1. Claim the step and capture the JSON response:`,
    `   node "${cli}" step claim "${agentId}"`,
    `   The output is JSON: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}`,
    `   SAVE the stepId — you MUST use it when reporting results.`,
    ``,
    `2. Read the "input" field carefully. It describes the actual work you must do.`,
    ``,
    `3. Execute the work using all available tools and capabilities.`,
    ``,
    `4. When finished, report using the SAVED stepId (NOT the agent ID):`,
    `   - Success: echo 'STATUS: done
CHANGES: <what you did>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `   - Failure: node "${cli}" step fail "<stepId>" "<clear reason for failure>"`,
    ``,
    `─── RULES ───`,
    `- ALWAYS report results. Never exit without calling step complete or step fail.`,
    `- If you cannot complete the work, use step fail — do not hang.`,
    `- Keep responses concise; you are a background agent.`,
    `- If something is unclear, use step fail with an explanation of what is missing.`,
  ].join("\n");
}

// ── Polling loop internals ──────────────────────────────────────────

const MAX_POLLING_OUTPUT_PREVIEW = 240;
const MAX_POLLING_ERROR_PREVIEW = 240;

type PollingRoundOutcome =
  | "heartbeat"
  | "work_done"
  | "work_failed"
  | "empty_output"
  | "other_output";

interface BoundedPreviewMetadata {
  preview: string;
  bytes: number;
  truncated: boolean;
}

interface PollingRoundOutputSummary extends BoundedPreviewMetadata {
  outcome: PollingRoundOutcome;
  lines: number;
}

function buildBoundedPreview(value: string, maxChars: number): BoundedPreviewMetadata {
  const truncated = value.length > maxChars;
  const preview = truncated ? `${value.slice(0, maxChars)}…` : value;

  return {
    preview,
    bytes: Buffer.byteLength(value, "utf-8"),
    truncated,
  };
}

function classifyPollingRoundOutcome(output: string): PollingRoundOutcome {
  if (output.length === 0) return "empty_output";
  if (/\bHEARTBEAT_OK\b/.test(output)) return "heartbeat";
  if (/STATUS:\s*(fail|failed|error)/i.test(output)) return "work_failed";
  if (/STATUS:\s*done/i.test(output)) return "work_done";
  return "other_output";
}

function summarizePollingRoundOutput(output: string): PollingRoundOutputSummary {
  const normalized = output.trim();
  const bounded = buildBoundedPreview(normalized, MAX_POLLING_OUTPUT_PREVIEW);

  return {
    ...bounded,
    outcome: classifyPollingRoundOutcome(normalized),
    lines: normalized ? normalized.split(/\r?\n/).length : 0,
  };
}

const UUID_CAPTURE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const RUN_ID_FIELD_REGEX = new RegExp(`["']?run(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");
const STEP_ID_FIELD_REGEX = new RegExp(`["']?step(?:_|-)?id["']?\\s*[:=]\\s*["'](${UUID_CAPTURE})["']`, "i");

interface PollingRoundMetadata {
  assistantOutput: string;
  tokenUsage: number | null;
  runId: string | null;
  stepId: string | null;
  jsonMetadataDetected: boolean;
}

interface PollingIdentifierHints {
  runId: string | null;
  stepId: string | null;
}

type RunIdSource = "metadata_run_id" | "step_lookup" | "none";

interface ResolvedRunId {
  runId: string | null;
  source: RunIdSource;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeTokenUsage(value: number): number {
  return Math.max(0, Math.round(value));
}

function firstNumeric(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = parseNumeric(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function extractTokenUsage(usageLike: unknown): number | null {
  const usage = asRecord(usageLike);
  if (!usage) return null;

  const directTotal = firstNumeric(usage, ["totalTokens", "total_tokens", "total"]);
  if (directTotal !== null) return normalizeTokenUsage(directTotal);

  const parts: Array<number | null> = [
    firstNumeric(usage, ["input", "inputTokens", "input_tokens", "prompt_tokens"]),
    firstNumeric(usage, ["output", "outputTokens", "output_tokens", "completion_tokens"]),
    firstNumeric(usage, ["cacheRead", "cache_read", "cache_read_tokens"]),
    firstNumeric(usage, ["cacheWrite", "cache_write", "cache_write_tokens"]),
  ];

  if (!parts.some((value) => value !== null)) return null;

  const total = parts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return normalizeTokenUsage(total);
}

function collectTextFragments(value: unknown, sink: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;

  if (typeof value === "string") {
    if (value.trim().length > 0) sink.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTextFragments(item, sink, depth + 1);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  for (const nested of Object.values(record)) {
    collectTextFragments(nested, sink, depth + 1);
  }
}

function extractAssistantText(messageLike: unknown): string {
  const message = asRecord(messageLike);
  if (!message) return "";

  const content = message.content;
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  const textSegments: string[] = [];
  for (const item of content) {
    const contentRecord = asRecord(item);
    if (!contentRecord) continue;
    if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
      textSegments.push(contentRecord.text);
    }
  }

  return textSegments.join("\n");
}

function extractIdentifierHints(text: string): PollingIdentifierHints {
  const runMatch = text.match(RUN_ID_FIELD_REGEX);
  const stepMatch = text.match(STEP_ID_FIELD_REGEX);

  return {
    runId: runMatch?.[1] ?? null,
    stepId: stepMatch?.[1] ?? null,
  };
}

export function parsePollingRoundMetadata(output: string): PollingRoundMetadata {
  const normalized = output.trim();
  if (normalized.length === 0) {
    return {
      assistantOutput: "",
      tokenUsage: null,
      runId: null,
      stepId: null,
      jsonMetadataDetected: false,
    };
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const events: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      const record = asRecord(parsed);
      if (record) events.push(record);
    } catch {
      // best-effort parsing; ignore malformed/non-JSON lines
    }
  }

  if (events.length === 0) {
    const hints = extractIdentifierHints(normalized);
    return {
      assistantOutput: normalized,
      tokenUsage: null,
      runId: hints.runId,
      stepId: hints.stepId,
      jsonMetadataDetected: false,
    };
  }

  let assistantOutput = "";
  let tokenUsage: number | null = null;
  const toolTextFragments: string[] = [];

  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "message_end") {
      const message = asRecord(event.message);
      if (message?.role === "assistant") {
        const assistantText = extractAssistantText(message).trim();
        if (assistantText.length > 0) assistantOutput = assistantText;

        const extractedUsage = extractTokenUsage(message.usage);
        if (extractedUsage !== null) tokenUsage = extractedUsage;
      }
    }

    if (type.startsWith("tool_execution")) {
      collectTextFragments(event, toolTextFragments);
    }
  }

  if (!assistantOutput) {
    assistantOutput = normalized;
  }

  const hintsFromToolData = extractIdentifierHints(toolTextFragments.join("\n"));
  const fallbackHints = extractIdentifierHints(`${assistantOutput}\n${normalized}`);

  return {
    assistantOutput,
    tokenUsage,
    runId: hintsFromToolData.runId ?? fallbackHints.runId,
    stepId: hintsFromToolData.stepId ?? fallbackHints.stepId,
    jsonMetadataDetected: true,
  };
}

async function resolveRunIdForAttribution(metadata: PollingRoundMetadata): Promise<ResolvedRunId> {
  if (metadata.runId) {
    return { runId: metadata.runId, source: "metadata_run_id" };
  }

  if (!metadata.stepId) {
    return { runId: null, source: "none" };
  }

  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const row = db.prepare("SELECT run_id FROM steps WHERE id = ?").get(metadata.stepId) as { run_id: string } | undefined;
    if (!row?.run_id) return { runId: null, source: "none" };
    return { runId: row.run_id, source: "step_lookup" };
  } catch {
    return { runId: null, source: "none" };
  }
}

interface TokenSpendUpdate {
  workflowId?: string;
  tokensSpent: number;
}

async function incrementRunTokenSpend(runId: string, tokenUsage: number): Promise<TokenSpendUpdate | null> {
  const { getDb } = await import("../db.js");
  const db = getDb();
  const result = db
    .prepare("UPDATE runs SET tokens_spent = tokens_spent + ?, updated_at = datetime('now') WHERE id = ?")
    .run(tokenUsage, runId);

  if ((result.changes ?? 0) <= 0) return null;

  const row = db
    .prepare("SELECT workflow_id, tokens_spent FROM runs WHERE id = ?")
    .get(runId) as { workflow_id: string; tokens_spent: number } | undefined;

  if (!row) return null;

  return {
    workflowId: row.workflow_id,
    tokensSpent: row.tokens_spent,
  };
}

/**
 * Auto-complete fallback: when a polling round produces work_done-shaped output
 * but the agent never invoked `node ${cli} step complete <stepId>` itself, the
 * step would otherwise stay `running` forever — peekStep returns NO_WORK for a
 * running step, so subsequent rounds heartbeat and the run wedges. If the round
 * output classifies as work_done and we extracted a stepId, call completeStep
 * here. Guarded by a status check so we don't double-complete when the agent
 * did report results via the CLI.
 */
async function autoCompleteStepIfRunning(
  context: Record<string, unknown>,
  metadata: PollingRoundMetadata,
): Promise<void> {
  if (!metadata.stepId) {
    logger.warn("Auto-complete fallback skipped — no stepId in output", { ...context });
    return;
  }

  const { getDb } = await import("../db.js");
  const { completeStep } = await import("./step-ops.js");
  const db = getDb();

  const row = db
    .prepare("SELECT status, type, current_story_id FROM steps WHERE id = ?")
    .get(metadata.stepId) as { status: string; type: string; current_story_id: string | null } | undefined;

  if (!row) {
    logger.warn("Auto-complete fallback skipped — step not found", {
      ...context,
      stepId: metadata.stepId,
    });
    return;
  }

  // A loop step with current_story_id=NULL means completeStep already ran
  // (the iteration was advanced or the loop reached a verify_each pause).
  // Calling completeStep again would fall through to the single-step branch
  // and mark the entire loop done, skipping remaining stories.
  if (row.type === "loop" && row.current_story_id === null) {
    logger.debug("Auto-complete fallback skipped — loop step mid-iteration (agent already advanced via CLI)", {
      ...context,
      stepId: metadata.stepId,
      stepStatus: row.status,
    });
    return;
  }

  if (row.status !== "running") {
    logger.debug("Auto-complete fallback skipped — step not running (agent likely reported via CLI)", {
      ...context,
      stepId: metadata.stepId,
      stepStatus: row.status,
    });
    return;
  }

  try {
    const result = completeStep(metadata.stepId, metadata.assistantOutput);
    logger.info("Auto-complete fallback invoked completeStep on work_done output", {
      ...context,
      stepId: metadata.stepId,
      result: result.status,
      outputBytes: Buffer.byteLength(metadata.assistantOutput, "utf-8"),
    });
  } catch (err) {
    logger.error("Auto-complete fallback completeStep threw", {
      ...context,
      stepId: metadata.stepId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function attributePollingRoundTokenUsage(
  context: Record<string, unknown>,
  outputSummary: PollingRoundOutputSummary,
  metadata: PollingRoundMetadata,
): Promise<void> {
  if (metadata.tokenUsage === null) {
    if (metadata.jsonMetadataDetected) {
      logger.debug("Polling round token usage unavailable — usage metadata missing", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "usage_metadata_missing",
      });
    } else {
      logger.warn("Polling round token usage unavailable — --mode json may be off", {
        ...context,
        outcome: outputSummary.outcome,
        reason: "non_json_output",
      });
    }
    return;
  }

  if (metadata.tokenUsage <= 0) {
    logger.debug("Polling round token usage not attributed", {
      ...context,
      outcome: outputSummary.outcome,
      reason: "non_positive_usage",
      tokenUsage: metadata.tokenUsage,
    });
    return;
  }

  if (outputSummary.outcome === "heartbeat") {
    logger.debug("Polling round token usage not attributed", {
      ...context,
      outcome: outputSummary.outcome,
      reason: "heartbeat_round",
      tokenUsage: metadata.tokenUsage,
    });
    return;
  }

  const resolved = await resolveRunIdForAttribution(metadata);
  if (!resolved.runId) {
    logger.warn("Polling round token usage not attributed — run id unresolved", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      outputPreview: outputSummary.preview,
      outputTruncated: outputSummary.truncated,
    });
    return;
  }

  try {
    const updated = await incrementRunTokenSpend(resolved.runId, metadata.tokenUsage);

    if (!updated) {
      logger.warn("Polling round token usage not attributed — run missing", {
        ...context,
        outcome: outputSummary.outcome,
        tokenUsage: metadata.tokenUsage,
        runId: resolved.runId,
        runIdSource: resolved.source,
      });
      return;
    }

    emitEvent({
      ts: new Date().toISOString(),
      event: "run.tokens.updated",
      runId: resolved.runId,
      workflowId: updated.workflowId,
      tokenDelta: metadata.tokenUsage,
      tokensSpent: updated.tokensSpent,
    });

    logger.debug("Polling round token usage attributed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      runId: resolved.runId,
      runIdSource: resolved.source,
      tokensSpent: updated.tokensSpent,
    });
  } catch (err) {
    logger.warn("Polling round token attribution failed", {
      ...context,
      outcome: outputSummary.outcome,
      tokenUsage: metadata.tokenUsage,
      error: String(err),
    });
  }
}

function buildPollingRoundContext(
  job: CronJobInfo,
  agent: WorkflowAgent,
  timeoutSeconds: number,
  workflow?: WorkflowSpec,
): Record<string, unknown> {
  const model = agent.pollingModel ?? workflow?.polling?.model ?? agent.model ?? job.workModel ?? job.model;

  return {
    jobId: job.id,
    agentId: job.agentId,
    role: agent.role ?? inferRole(agent.id),
    timeoutSeconds,
    workdir: job.workdir,
    model,
  };
}

export async function executePollingRound(
  job: CronJobInfo,
  agent: WorkflowAgent,
  workflow?: WorkflowSpec,
): Promise<void> {
  const role = agent.role ?? inferRole(agent.id);
  const timeout = agent.timeoutSeconds ?? job.timeoutSeconds ?? getRoleTimeoutSeconds(role);
  const context = buildPollingRoundContext(job, agent, timeout, workflow);

  // Skip this tick if a pi for the same agent is still running. setInterval keeps
  // firing every intervalMs regardless of how long pi takes; without this guard
  // we'd accumulate 10+ pi processes per agent (each ~100MB) over the role timeout.
  if (inFlightJobs.has(job.id)) {
    logger.info("Polling round skipped — previous pi still in flight", {
      ...context,
      reason: "previous_round_in_flight",
    });
    return;
  }

  // If the workflow has no active runs left, tear down our local timers and
  // skip the round. Without this the workflow-run CLI process leaks: its
  // setInterval timers keep the Node event loop alive long after every run is
  // completed/failed/canceled, polling pi forever for nothing. The teardown
  // path called from short-lived `step complete` processes is a no-op there
  // because those processes don't own the timers — only this process does.
  //
  // Gate on `activeTimers.has(job.id)` so direct callers (tests) that invoke
  // executePollingRound without going through setupAgentCrons don't hit the
  // idle check — they have no timers to tear down anyway.
  if (activeTimers.has(job.id)) {
    try {
      const { getDb } = await import("../db.js");
      const db = getDb();
      const activeRuns = db
        .prepare(
          "SELECT COUNT(*) AS cnt FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused')",
        )
        .get(job.workflowId) as { cnt: number } | undefined;
      if ((activeRuns?.cnt ?? 0) === 0) {
        logger.info(
          "Polling round skipped — workflow has no active runs; tearing down local crons",
          { ...context, reason: "workflow_idle" },
        );
        await removeAgentCrons(job.workflowId);
        return;
      }
    } catch (err) {
      // best-effort: don't crash the polling round if the idle check fails
      logger.warn("Idle check failed; continuing polling round", {
        ...context,
        error: String(err),
      });
    }
  }

  const pollingPrompt = buildPollingPrompt(job.workflowId, job.agentId);

  logger.info("Polling round start", context);

  inFlightJobs.add(job.id);
  try {
    const output = await runPi(
      ["--print", "--mode", "json", "--no-session", pollingPrompt],
      {
        timeout,
        workdir: job.workdir,
      },
    );

    const metadata = parsePollingRoundMetadata(output);
    const outputSummary = summarizePollingRoundOutput(metadata.assistantOutput || output);

    logger.info("Polling round complete", {
      ...context,
      outcome: outputSummary.outcome,
      outputBytes: outputSummary.bytes,
      outputLines: outputSummary.lines,
      outputPreview: outputSummary.preview,
      outputTruncated: outputSummary.truncated,
      tokenUsage: metadata.tokenUsage,
      metadataFormat: metadata.jsonMetadataDetected ? "json" : "text",
    });

    await attributePollingRoundTokenUsage(context, outputSummary, metadata);

    if (outputSummary.outcome === "work_done") {
      await autoCompleteStepIfRunning(context, metadata);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorSummary = buildBoundedPreview(errorMessage, MAX_POLLING_ERROR_PREVIEW);

    logger.error("Polling round failed", {
      ...context,
      errorBytes: errorSummary.bytes,
      errorPreview: errorSummary.preview,
      errorTruncated: errorSummary.truncated,
    });
    // Don't crash the interval — let the next round retry naturally
  } finally {
    inFlightJobs.delete(job.id);
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create a scheduled job for an agent.
 * Uses a polling daemon approach with setInterval (not OS cron).
 */
export async function createAgentCronJob(
  params: CreateCronJobParams,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const { workflowId, agent, workflow, workdir } = params;
  const intervalMinutes = params.intervalMinutes ?? 5;
  const staggerMs = params.staggerOffsetMs ?? 0;

  const id = `tamandua-${workflowId}-${agent.id}`;
  const name = `${workflowId}/${agent.id}`;

  // Check for existing job
  if (activeTimers.has(id)) {
    return { ok: false, error: `Job already exists: ${id}`, id };
  }

  // Per-pi-call execution budget. Prefer an explicit per-agent override, then the
  // role policy (analysis=30m, coding=30m, etc.). polling.timeoutSeconds is NOT
  // used here — it determines the polling INTERVAL, not how long pi has to work.
  const role = agent.role ?? inferRole(agent.id);
  const timeoutSeconds = agent.timeoutSeconds ?? getRoleTimeoutSeconds(role);

  // Use fully qualified agent ID (workflowId_agentId) for DB matching
  const fullAgentId = agent.id.startsWith(`${workflowId}_`) ? agent.id : `${workflowId}_${agent.id}`;

  const jobInfo: CronJobInfo = {
    id,
    name,
    workflowId,
    agentId: fullAgentId,
    intervalMinutes,
    sessionLabel: `${agent.id}-cron`,
    timeoutSeconds,
    workdir,
    createdAt: new Date().toISOString(),
  };

  // Stagger the first execution
  const startPolling = () => {
    const intervalMs = intervalMinutes * 60 * 1000;
    const timer = setInterval(() => {
      executePollingRound(jobInfo, agent, workflow).catch((err) => {
        logger.error("Unhandled polling error", { jobId: id, error: String(err) });
      });
    }, intervalMs);

    activeTimers.set(id, timer);
    jobMetadata.set(id, jobInfo);
    persistJobs();

    logger.info("Cron job created", { id, agentId: agent.id, intervalMinutes, staggerMs });
  };

  if (staggerMs > 0) {
    setTimeout(startPolling, staggerMs);
    logger.info("Cron job scheduled with stagger", { id, staggerMs });
  } else {
    startPolling();
  }

  return { ok: true, id };
}

/**
 * Set up polling for all agents in a workflow.
 * Staggers agent starts by 1 minute each.
 */
export async function setupAgentCrons(workflow: WorkflowSpec): Promise<void> {
  const staggerBaseMs = 60_000; // 1 minute per agent

  for (let i = 0; i < workflow.agents.length; i++) {
    const agent = workflow.agents[i];
    const staggerMs = i * staggerBaseMs;

    const fullAgentId = agent.id.startsWith(`${workflow.id}_`) ? agent.id : `${workflow.id}_${agent.id}`;

    const result = await createAgentCronJob({
      workflowId: workflow.id,
      agent,
      workflow,
      intervalMinutes: workflow.polling?.timeoutSeconds
        ? Math.max(1, Math.ceil(workflow.polling.timeoutSeconds / 60))
        : 5,
      staggerOffsetMs: staggerMs,
      workdir: resolveWorkflowWorkspaceDir(fullAgentId),
    });

    if (!result.ok) {
      logger.warn("Failed to set up cron for agent", {
        agentId: agent.id,
        error: result.error,
      });
    }
  }
}

/**
 * Remove all cron jobs for a given workflow.
 */
export async function removeAgentCrons(workflowId: string): Promise<void> {
  const prefix = `tamandua-${workflowId}-`;
  const toRemove: string[] = [];

  for (const [id, timer] of activeTimers) {
    if (id.startsWith(prefix)) {
      clearInterval(timer);
      activeTimers.delete(id);
      jobMetadata.delete(id);
      toRemove.push(id);
    }
  }

  if (toRemove.length > 0) {
    persistJobs();
    logger.info("Removed agent crons", { workflowId, count: toRemove.length, jobIds: toRemove });
  }
}

/**
 * Ensure crons are set up for a workflow.
 * Idempotent — will not duplicate existing jobs.
 */
export async function ensureWorkflowCrons(workflow: WorkflowSpec): Promise<void> {
  for (const agent of workflow.agents) {
    const id = `tamandua-${workflow.id}-${agent.id}`;
    if (activeTimers.has(id)) continue;

    const fullAgentId = agent.id.startsWith(`${workflow.id}_`) ? agent.id : `${workflow.id}_${agent.id}`;

    await createAgentCronJob({
      workflowId: workflow.id,
      agent,
      workflow,
      intervalMinutes: 5,
      workdir: resolveWorkflowWorkspaceDir(fullAgentId),
    });
  }
}

/**
 * Tear down workflow crons if the workflow has no active runs.
 * Inspects via DB: if no runs with status 'running' or 'paused', remove crons.
 */
export async function teardownWorkflowCronsIfIdle(workflowId: string): Promise<void> {
  try {
    // Dynamic import to keep the scheduler decoupled from db at module level
    const { getDb } = await import("../db.js");
    const db = getDb();

    const activeRuns = db
      .prepare("SELECT COUNT(*) AS cnt FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused')")
      .get(workflowId) as { cnt: number } | undefined;

    const count = activeRuns?.cnt ?? 0;

    if (count === 0) {
      logger.info("Workflow idle — tearing down crons", { workflowId });
      await removeAgentCrons(workflowId);
    } else {
      logger.info("Workflow has active runs — keeping crons", { workflowId, activeRuns: count });
    }
  } catch (err) {
    logger.warn("Failed to check idle status for teardown", {
      workflowId,
      error: String(err),
    });
  }
}

/**
 * List all active cron jobs.
 */
export async function listCronJobs(): Promise<{
  ok: boolean;
  jobs?: Array<{ id: string; name: string }>;
}> {
  const jobs: Array<{ id: string; name: string }> = [];

  for (const [id, info] of jobMetadata) {
    jobs.push({ id, name: info.name });
  }

  return { ok: true, jobs };
}

/**
 * Delete agent cron jobs matching a name prefix.
 */
export async function deleteAgentCronJobs(namePrefix: string): Promise<void> {
  const toRemove: string[] = [];

  for (const [id, timer] of activeTimers) {
    const info = jobMetadata.get(id);
    if (info && info.name.startsWith(namePrefix)) {
      clearInterval(timer);
      activeTimers.delete(id);
      jobMetadata.delete(id);
      toRemove.push(id);
    }
  }

  if (toRemove.length > 0) {
    persistJobs();
    logger.info("Deleted agent cron jobs", { prefix: namePrefix, count: toRemove.length });
  }
}

/**
 * Resume persisted jobs after a process restart.
 * Call this once during tamandua startup.
 */
export async function resumePersistedCrons(workflows: WorkflowSpec[]): Promise<void> {
  const persisted = loadPersistedJobs();
  if (persisted.length === 0) return;

  logger.info("Resuming persisted cron jobs", { count: persisted.length });

  const workflowMap = new Map(workflows.map((w) => [w.id, w]));

  for (const job of persisted) {
    // Skip if already running
    if (activeTimers.has(job.id)) continue;

    const workflow = workflowMap.get(job.workflowId);
    if (!workflow) {
      logger.warn("Workflow not found for persisted cron job — skipping", {
        jobId: job.id,
        workflowId: job.workflowId,
      });
      continue;
    }

    const agent = workflow.agents.find(
      (a) => a.id === job.agentId || `${job.workflowId}_${a.id}` === job.agentId,
    );
    if (!agent) {
      logger.warn("Agent not found in workflow for persisted cron job — skipping", {
        jobId: job.id,
        agentId: job.agentId,
      });
      continue;
    }

    const intervalMs = job.intervalMinutes * 60 * 1000;
    const timer = setInterval(() => {
      executePollingRound(job, agent, workflow).catch((err) => {
        logger.error("Unhandled polling error", { jobId: job.id, error: String(err) });
      });
    }, intervalMs);

    activeTimers.set(job.id, timer);
    jobMetadata.set(job.id, job);

    logger.info("Resumed cron job", { id: job.id, agentId: job.agentId });
  }

  persistJobs();
}

/**
 * Gracefully shut down all cron jobs.
 */
export function shutdownAllCrons(): void {
  let count = 0;
  for (const [id, timer] of activeTimers) {
    clearInterval(timer);
    activeTimers.delete(id);
    count++;
  }
  jobMetadata.clear();
  if (count > 0) {
    logger.info("Shut down all cron jobs", { count });
  }
}
