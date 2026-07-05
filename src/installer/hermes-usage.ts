import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { logger } from "../lib/logger.js";

const REQUIRED_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
] as const;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 700;

/**
 * Look up token usage for a hermes session from its state.db.
 *
 * Resolves `$HERMES_HOME/state.db` from the provided `env` (falling back
 * to `process.env.HERMES_HOME`, then `~/.hermes/state.db`). Opens the DB
 * **read-only** — it never creates or writes the file.
 *
 * Token total = input_tokens + output_tokens + cache_read_tokens +
 * cache_write_tokens (excludes reasoning_tokens). Negatives are clamped
 * to 0, total is rounded to integer.
 *
 * Retries the row lookup up to 3 attempts (~2 s total) to tolerate
 * hermes WAL writer lag. On **any** failure (file missing, table/columns
 * missing, row not found, schema change) returns `null` and logs ONE
 * clear warning — it never throws into the dispatch path.
 *
 * @returns Total tokens used for the session, or `null` if unavailable.
 */
export async function lookupHermesSessionTokens(
  sessionRef: string,
  env?: NodeJS.ProcessEnv,
): Promise<number | null> {
  const hermesHome =
    env?.HERMES_HOME ??
    process.env.HERMES_HOME ??
    path.join(os.homedir(), ".hermes");
  const dbPath = path.join(hermesHome, "state.db");

  let lastReason: string | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (!fs.existsSync(dbPath)) {
      lastReason = `hermes state.db not found at ${dbPath}`;
      break; // file missing — retrying won't help
    }

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });

      // ── Schema probe ─────────────────────────────────────────
      const schemaResult = db
        .prepare("SELECT name FROM pragma_table_info('sessions')")
        .all() as Array<{ name: string }>;

      if (schemaResult.length === 0) {
        lastReason = "hermes state.db has no sessions table";
        break; // no table — retrying won't help
      }

      const columnNames = new Set(schemaResult.map((col) => col.name));
      const missing = REQUIRED_COLUMNS.filter((col) => !columnNames.has(col));
      if (missing.length > 0) {
        lastReason = `hermes state.db sessions table missing columns: ${missing.join(", ")}`;
        break; // missing columns — retrying won't help
      }

      // ── Row lookup ───────────────────────────────────────────
      const row = db
        .prepare(
          "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions WHERE id = ?",
        )
        .get(sessionRef) as
        | {
            input_tokens: number;
            output_tokens: number;
            cache_read_tokens: number;
            cache_write_tokens: number;
          }
        | undefined;

      if (row) {
        const total =
          Math.max(0, row.input_tokens ?? 0) +
          Math.max(0, row.output_tokens ?? 0) +
          Math.max(0, row.cache_read_tokens ?? 0) +
          Math.max(0, row.cache_write_tokens ?? 0);
        return Math.round(total);
      }

      lastReason = `hermes session ${sessionRef} not found in state.db`;
      // Row not found — retry (WAL writer may not have committed yet)
    } catch (err) {
      lastReason = `hermes state.db read error: ${err instanceof Error ? err.message : String(err)}`;
      // Retry on transient read errors
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close errors
      }
    }

    if (attempt < MAX_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  // ── Log ONE clear warning ─────────────────────────────────────
  if (lastReason) {
    logger.warn("Hermes session token lookup failed", {
      sessionRef,
      reason: lastReason,
    });
  }

  return null;
}
