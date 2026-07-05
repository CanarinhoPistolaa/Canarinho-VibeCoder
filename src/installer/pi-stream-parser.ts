/**
 * Streaming pi event parser — filters pi's JSON event stream on the fly.
 *
 * pi --print --mode json emits one JSON object per line. Most events
 * (message_update / text_delta) re-include the accumulating message
 * snapshot, making output ~quadratic in turn length. This module
 * discards irrelevant events so memory stays bounded regardless of
 * how chatty a pi round is.
 */

import { logger } from "../lib/logger.js";

// ── Types ───────────────────────────────────────────────────────────

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiOutputStreamResult {
  /** Kept JSON events (message_end assistant + tool_execution_*). */
  events: PiEvent[];
  /** Assistant text extracted from the last kept message_end event. */
  assistantText: string;
  /**
   * Full text accumulated from non-JSON lines (text-mode fallback).
   * Capped at MAX_TEXT_FALLBACK_BYTES. `null` means no text-mode
   * lines were encountered.
   */
  textFallback: string | null;
  /** Whether any text-mode lines were truncated due to the cap. */
  textFallbackTruncated: boolean;
}

// ── Constants ───────────────────────────────────────────────────────

/** Maximum bytes of plain-text output to retain in text-mode fallback. */
export const MAX_TEXT_FALLBACK_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Event types whose lines should be kept (stored in the events array).
 * message_end events are only kept when message.role === "assistant".
 */
const KEPT_EVENT_PREFIXES = [
  "message_end",
  "tool_execution_",
] as const;

const KEPT_TYPE_SET: ReadonlySet<string> = new Set([
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

// ── Discard Fast-Path ──────────────────────────────────────────────

/**
 * Event-type prefixes to discard without JSON.parse.
 *
 * pi --print --mode json emits one JSON object per line, and the type
 * key is always serialized first (verified against pi 0.80.3). Each
 * prefix includes the opening `{"type":"` and the closing double-quote
 * after the type name, so a hypothetical type "message_updateX" cannot
 * false-match.
 *
 * Lines matching a discard prefix are dropped immediately — no
 * JSON.parse, even if the remainder of the line is malformed JSON.
 * Previously such malformed lines were routed to text-fallback;
 * now they are discarded (documented behavior change).
 *
 * IMPORTANT: KEPT_TYPE_SET entries (message_end, tool_execution_start,
 * tool_execution_update, tool_execution_end) must NOT appear here.
 */
const DISCARD_PREFIXES = [
  '{"type":"message_update"',
  '{"type":"message_start"',
  '{"type":"turn_start"',
  '{"type":"turn_end"',
  '{"type":"agent_start"',
  '{"type":"agent_end"',
  '{"type":"session"',
];

// ── Helpers ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractAssistantText(messageLike: unknown): string {
  const message = asRecord(messageLike);
  if (!message) return "";

  const content = message.content;
  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  const textSegments: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      textSegments.push(record.text);
    }
  }

  return textSegments.join("\n");
}

function isAssistantMessageEnd(event: PiEvent): boolean {
  if (event.type !== "message_end") return false;
  const message = asRecord(event.message);
  return message?.role === "assistant";
}

function eventTypeShouldBeKept(type: string): boolean {
  return KEPT_TYPE_SET.has(type);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Filter a single line of pi output.
 *
 * Returns:
 *  - A parsed PiEvent object if the line is a JSON event that should be kept.
 *  - The original line string if the line is NOT JSON (text-mode fallback).
 *  - `null` if the line is a JSON event that should be discarded.
 */
export function filterPiEvent(line: string): PiEvent | string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // SNIF: prefix fast-path — discard high-volume events without
  // JSON.parse. Lines matching a discard prefix return null
  // immediately, even if the rest of the line is malformed JSON
  // (documented behavior change from text-fallback to drop).
  for (const prefix of DISCARD_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return null;
    }
  }

  // Quick guard: JSON lines must start with { and end with }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return trimmed; // text-mode fallback
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed; // malformed JSON → treat as text fallback
  }

  const event = asRecord(parsed);
  if (!event || typeof event.type !== "string") {
    return trimmed; // JSON object without a type field → text fallback
  }

  const type: string = event.type;

  // Keep message_end only if assistant role
  if (type === "message_end") {
    if (isAssistantMessageEnd(event as PiEvent)) {
      return event as PiEvent;
    }
    return null; // user/system message_end → discard
  }

  // Keep tool_execution_* events
  if (type.startsWith("tool_execution_")) {
    return event as PiEvent;
  }

  // Discard everything else:
  // message_update (text_delta snapshots — the bulk), message_start,
  // turn_start, turn_end, agent_start, agent_end, etc.
  return null;
}

/**
 * Process a stream of pi output lines, filtering events and extracting
 * assistant text. Memory stays bounded: discarded events are not stored.
 *
 * @param lines - An iterable or async iterable of output lines.
 * @returns Filtered events, assistant text, and text-mode fallback.
 */
export async function parsePiOutputStream(
  lines: Iterable<string> | AsyncIterable<string>,
): Promise<PiOutputStreamResult> {
  const events: PiEvent[] = [];
  /**
   * Track index of the most recent tool_execution_update per toolCallId.
   * On each new update for an existing toolCallId, the event at the stored
   * index is replaced in-place (deterministic: position = first occurrence).
   * toolCallId-less updates share a single sentinel slot.
   */
  const updateIndices = new Map<string, number>();
  const NO_TOOL_CALL_ID = "__no_toolCallId__";
  let assistantText = "";
  let textFallbackBytes = 0;
  let textFallbackPieces: string[] | null = null;
  let textFallbackTruncated = false;

  for await (const rawLine of lines) {
    const result = filterPiEvent(rawLine);

    if (result === null) {
      // Discarded JSON event — skip
      continue;
    }

    if (typeof result === "string") {
      // Text-mode fallback line
      if (textFallbackPieces === null) {
        textFallbackPieces = [];
      }
      const lineBytes = Buffer.byteLength(result, "utf-8");
      if (textFallbackBytes + lineBytes > MAX_TEXT_FALLBACK_BYTES) {
        if (!textFallbackTruncated) {
          textFallbackTruncated = true;
          logger.warn(
            "pi text-mode output exceeded cap — truncating",
            {
              capBytes: MAX_TEXT_FALLBACK_BYTES,
              currentBytes: textFallbackBytes,
            },
          );
        }
        continue;
      }
      textFallbackPieces.push(result);
      textFallbackBytes += lineBytes;
      continue;
    }

    // Kept JSON event
    // CAPP: cap tool_execution_update retention to one per toolCallId.
    // pi's bash tool emits up to 10 updates/sec at up to 50KB each —
    // retaining every one over a long round inflates RSS ~300MB.
    // The latest update per tool call fully satisfies downstream consumers
    // (collectTextFragments & filteredStdout reconstruction).
    if (result.type === "tool_execution_update") {
      const rawId: unknown = result.toolCallId;
      const key =
        typeof rawId === "string" && rawId.length > 0
          ? rawId
          : NO_TOOL_CALL_ID;
      const existingIndex = updateIndices.get(key);
      if (existingIndex !== undefined) {
        // Replace in-place at first occurrence position.
        events[existingIndex] = result;
      } else {
        updateIndices.set(key, events.length);
        events.push(result);
      }
    } else {
      events.push(result);
    }

    if (isAssistantMessageEnd(result)) {
      const text = extractAssistantText(result.message as Record<string, unknown>).trim();
      if (text.length > 0) {
        assistantText = text;
      }
    }
  }

  const textFallback =
    textFallbackPieces !== null ? textFallbackPieces.join("\n") : null;

  return { events, assistantText, textFallback, textFallbackTruncated };
}
