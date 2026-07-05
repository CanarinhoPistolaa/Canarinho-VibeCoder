import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePiStateDir } from "./paths.js";
import { logger } from "../lib/logger.js";

// ── Types ────────────────────────────────────────────────────────────

export interface TamanduaEvent {
  ts: string;
  event: string;
  runId: string;
  workflowId?: string;
  stepId?: string;
  storyId?: string;
  storyTitle?: string;
  agentId?: string;
  detail?: string;
  tokenDelta?: number;
  tokensSpent?: number;
}

export type EventCursorSource =
  | { kind: "global" }
  | { kind: "run"; runId: string };

export interface EventCursorReadResult {
  events: TamanduaEvent[];
  nextOffset: number;
}

// ── Paths ────────────────────────────────────────────────────────────

function getEventsDir(): string {
  return path.join(resolvePiStateDir(), "events");
}

function getEventsFile(runId: string): string {
  return path.join(getEventsDir(), `${runId}.jsonl`);
}

function getGlobalEventsFile(): string {
  return path.join(getEventsDir(), "all.jsonl");
}

function getEventsFileForSource(source: EventCursorSource): string {
  if (source.kind === "global") return getGlobalEventsFile();
  return getEventsFile(source.runId);
}

// ── Event Emission ───────────────────────────────────────────────────

/**
 * Dispatch-nudge bookkeeping events. Every nudge fans out to all agents of
 * all running runs, so at steady state these are ~99% of all.jsonl volume
 * (observed: 464k of 467k events, 92MB) — and the dashboard re-reads that
 * file on every poll. Dropped unless TAMANDUA_DEBUG_EVENTS is set.
 */
const NOISE_EVENTS: ReadonlySet<string> = new Set([
  "run.nudged",
  "agent.nudged",
  "agent.nudge.skipped",
]);

function isEnvFlagEnabled(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/**
 * Emit a Tamandua event.
 *
 * Writes:
 * 1. To the run-specific JSONL file (~/.tamandua/events/<runId>.jsonl)
 * 2. To the global JSONL file (~/.tamandua/events/all.jsonl)
 * 3. Fires a webhook if a notify URL is configured for the run (fire-and-forget)
 *
 * High-volume nudge bookkeeping events (NOISE_EVENTS) are dropped unless
 * TAMANDUA_DEBUG_EVENTS is set.
 */
export function emitEvent(evt: TamanduaEvent): void {
  if (NOISE_EVENTS.has(evt.event) && !isEnvFlagEnabled(process.env.TAMANDUA_DEBUG_EVENTS)) {
    return;
  }
  const line = JSON.stringify(evt) + "\n";

  // Ensure events directory exists
  const eventsDir = getEventsDir();
  fs.mkdirSync(eventsDir, { recursive: true });

  // Write to run-specific events file
  const runFile = getEventsFile(evt.runId);
  try {
    fs.appendFileSync(runFile, line, "utf-8");
  } catch (err) {
    logger.warn("Failed to write run event", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  }

  // Write to global events file
  const globalFile = getGlobalEventsFile();
  try {
    fs.appendFileSync(globalFile, line, "utf-8");
  } catch (err) {
    logger.warn("Failed to write global event", {
      event: evt.event,
      error: String(err),
    });
  }

  // Fire-and-forget webhook if applicable
  fireWebhook(evt).catch((err) => {
    logger.warn("Webhook delivery failed", {
      runId: evt.runId,
      event: evt.event,
      error: String(err),
    });
  });
}

// ── Tail-window reading constants ───────────────────────────────────

const TAIL_CHUNK_SIZE = 256 * 1024; // 256 KB
const MAX_TAIL_READ = 4 * 1024 * 1024; // 4 MB

// ── Event Reading ────────────────────────────────────────────────────

/**
 * Read events appended after a byte offset from either:
 * - ~/.tamandua/events/all.jsonl (global)
 * - ~/.tamandua/events/<runId>.jsonl (per-run)
 *
 * Returns only complete newline-terminated records and the next cursor offset.
 * Malformed JSON lines are skipped safely.
 */
export function readEventsFromCursor(source: EventCursorSource, offset = 0): EventCursorReadResult {
  const eventsFile = getEventsFileForSource(source);
  const safeOffset = Math.max(0, Math.floor(offset));

  let fd: number | undefined;
  try {
    fd = fs.openSync(eventsFile, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    const effectiveOffset = safeOffset > fileSize ? 0 : safeOffset;
    const readLength = fileSize - effectiveOffset;

    if (readLength === 0) return { events: [], nextOffset: effectiveOffset };

    const fileBuffer = Buffer.alloc(readLength);
    fs.readSync(fd, fileBuffer, 0, readLength, effectiveOffset);

    let cursor = 0;
    const events: TamanduaEvent[] = [];

    while (cursor < fileBuffer.length) {
      const newlineIndex = fileBuffer.indexOf(0x0A, cursor);
      if (newlineIndex === -1) break; // trailing partial line

      const lineBuffer = fileBuffer.subarray(cursor, newlineIndex);
      cursor = newlineIndex + 1;

      if (lineBuffer.length === 0) continue;

      const line = lineBuffer.toString("utf-8").replace(/\r$/, "");
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          events.push(parsed as TamanduaEvent);
        }
      } catch {
        // Ignore malformed JSONL rows so later valid events still stream.
      }
    }

    return { events, nextOffset: effectiveOffset + cursor };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { events: [], nextOffset: 0 };

    logger.warn("Failed to read event cursor source", {
      source: source.kind,
      runId: source.kind === "run" ? source.runId : undefined,
      error: String(err),
    });
    return { events: [], nextOffset: safeOffset };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Read the most recent N events from the global events file.
 *
 * Uses fd-based tail-window reading instead of readFileSync so that
 * reading the last ~40 events from a 92 MB file takes constant time.
 * Reads chunks backward from EOF (256 KB at a time) up to a 4 MB cap,
 * stopping early once enough complete JSONL records have been found.
 */
export function getRecentEvents(limit = 50): TamanduaEvent[] {
  const globalFile = getGlobalEventsFile();
  let fd: number | undefined;
  try {
    fd = fs.openSync(globalFile, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) return [];

    let windowStart = fileSize;
    let buffer = "";
    let totalRead = 0;

    // Read backwards in TAIL_CHUNK_SIZE chunks until we have at least
    // `limit` valid JSONL events, we hit the file start, or we reach
    // the MAX_TAIL_READ cap.
    while (totalRead < MAX_TAIL_READ && windowStart > 0) {
      const readSize = Math.min(TAIL_CHUNK_SIZE, windowStart);
      windowStart -= readSize;

      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, windowStart);
      buffer = buf.toString("utf-8") + buffer;
      totalRead += readSize;

      // If the window starts after byte 0 the first line in `buffer`
      // may be a partial line (we read starting mid-line).  Skip it.
      let parseStart = 0;
      if (windowStart > 0) {
        const firstNewline = buffer.indexOf("\n");
        if (firstNewline === -1) continue; // still no complete line
        parseStart = firstNewline + 1;
      }

      const parseable = buffer.slice(parseStart);
      const lines = parseable.split("\n").filter((l) => l.length > 0);

      let validCount = 0;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object") validCount++;
        } catch {
          // skip malformed lines
        }
      }

      if (validCount >= limit) break;
    }

    // Final parse: skip initial partial line, extract valid events,
    // and return the last `limit`.
    let parseStart = 0;
    if (windowStart > 0) {
      const firstNewline = buffer.indexOf("\n");
      if (firstNewline !== -1) parseStart = firstNewline + 1;
    }

    const eventLines = buffer.slice(parseStart).split("\n").filter((l) => l.length > 0);
    const events: TamanduaEvent[] = [];
    for (const line of eventLines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          events.push(parsed as TamanduaEvent);
        }
      } catch {
        // skip malformed lines
      }
    }

    return events.slice(-limit);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logger.warn("Failed to read global events", { error: String(err) });
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // fd may already be closed
      }
    }
  }
}

/**
 * Read events for a specific run.
 *
 * When limit is provided, reads only the last N valid JSON lines from the
 * per-run events file using an efficient byte-offset scan from end-of-file,
 * without reading and parsing the entire file.
 *
 * When limit is omitted, reads all events (unchanged behaviour).
 */
export function getRunEvents(runId: string, limit?: number): TamanduaEvent[] {
  const runFile = getEventsFile(runId);

  // Bounded tail-read path
  if (limit !== undefined && limit > 0) {
    return tailRunEvents(runFile, limit);
  }

  // Unbounded full-read path — existing behaviour
  try {
    const content = fs.readFileSync(runFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      try {
        return JSON.parse(line) as TamanduaEvent;
      } catch {
        return null;
      }
    }).filter((e): e is TamanduaEvent => e !== null);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    logger.warn("Failed to read run events", { runId, error: String(err) });
    return [];
  }
}

/**
 * Read the last `limit` valid JSON events from a JSONL file using a
 * byte-offset tail scan.  This avoids parsing the entire file.
 */
function tailRunEvents(filePath: string, limit: number): TamanduaEvent[] {
  let fileBuffer: Buffer;
  try {
    fileBuffer = fs.readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    // EISDIR or anything else — return empty
    return [];
  }

  if (fileBuffer.length === 0) return [];

  // Scan backwards from EOF to collect at most `limit` complete lines.
  const lines: string[] = [];
  let end = fileBuffer.length;

  while (lines.length < limit && end > 0) {
    // Find the start of the next newline-terminated segment going backwards.
    let nl = end - 1;
    while (nl >= 0 && fileBuffer[nl] !== 0x0A) nl--;

    let line: string;
    if (nl < 0) {
      // Reached beginning of file — extract the first (non-\n-prefixed) line.
      line = fileBuffer.toString("utf-8", 0, end).replace(/\r$/, "");
    } else if (nl + 1 < end) {
      line = fileBuffer.toString("utf-8", nl + 1, end).replace(/\r$/, "");
    } else {
      // Empty line (consecutive newlines) — skip.
      end = nl;
      continue;
    }

    if (line) lines.unshift(line);

    if (nl < 0) break; // exhausted the file

    end = nl;
  }

  // Parse and filter out malformed lines.
  const result: TamanduaEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        result.push(parsed as TamanduaEvent);
      }
    } catch {
      // Skip malformed lines.
    }
  }

  return result;
}

/**
 * Fast-count non-empty lines in the per-run events file without JSON-parsing
 * every line. Returns 0 for nonexistent / empty / directory files.
 */
export function countRunEvents(runId: string): number {
  const runFile = getEventsFile(runId);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(runFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return 0;
    return 0;
  }

  // Directory instead of file
  if (stats.isDirectory()) return 0;

  // Empty file
  if (stats.size === 0) return 0;

  let content: string;
  try {
    content = fs.readFileSync(runFile, "utf-8");
  } catch {
    return 0;
  }

  // Count non-empty lines — the same filter used by getRunEvents (trim + filter Boolean)
  return content.trim().split("\n").filter(Boolean).length;
}

/**
 * Get the path to the events directory.
 */
export function getEventsPath(): string {
  return getEventsDir();
}

// ── Webhook Support ──────────────────────────────────────────────────

/**
 * Fire-and-forget POST to the webhook URL configured for a run.
 * Looks up the notify_url from the runs table.
 * Does not throw — webhook failures are logged and swallowed.
 */
async function fireWebhook(evt: TamanduaEvent): Promise<void> {
  // Only notify on significant events to avoid flooding
  const significantEvents = new Set([
    "run.started",
    "run.completed",
    "run.failed",
    "step.failed",
    "step.worker_lost",
    "pipeline.advanced",
  ]);

  if (!significantEvents.has(evt.event)) return;

  let notifyUrl: string | undefined;

  // Try to look up notify_url from the DB
  try {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const row = db
      .prepare("SELECT notify_url FROM runs WHERE id = ?")
      .get(evt.runId) as { notify_url: string | null } | undefined;
    notifyUrl = row?.notify_url ?? undefined;
  } catch {
    // DB might not be available — skip webhook
    return;
  }

  if (!notifyUrl) return;

  const payload = JSON.stringify(evt);

  // Use global fetch (Node 18+)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    await fetch(notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);
  } catch (err) {
    // Fire-and-forget: log and move on
    logger.warn("Webhook POST failed", {
      url: notifyUrl,
      event: evt.event,
      runId: evt.runId,
      error: String(err),
    });
  }
}
