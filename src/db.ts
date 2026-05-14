import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let _db: DatabaseSync | null = null;
let _dbOpenedAt = 0;
let _dbPath: string | null = null;
const DB_MAX_AGE_MS = 5000;

// Dynamic import to avoid top-level await issues in non-Node22 environments
import { DatabaseSync } from "node:sqlite";

function resolveDbPath(): string {
  const explicit = process.env.TAMANDUA_DB_PATH?.trim();
  if (explicit) return path.resolve(explicit);

  return path.join(os.homedir(), ".tamandua", "tamandua.db");
}

export function getDb(): DatabaseSync {
  const now = Date.now();
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath && (now - _dbOpenedAt) < DB_MAX_AGE_MS) return _db;
  // Only close if the ref is non-null (avoid double-close warnings)
  if (_db) {
    try {
      _db.close();
    } catch {
      // Don't throw on double-close — we just want a fresh connection
    }
    _db = null;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _dbPath = dbPath;
  _dbOpenedAt = now;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  migrate(_db);
  return _db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Backfill run_number for existing runs
  const runCols = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  const runColNames = new Set(runCols.map((c) => c.name));
  if (!runColNames.has("run_number")) {
    db.exec("ALTER TABLE runs ADD COLUMN run_number INTEGER");
    runColNames.add("run_number");
    db.exec(`
      UPDATE runs SET run_number = (
        SELECT COUNT(*) FROM runs r2 WHERE r2.created_at <= runs.created_at
      ) WHERE run_number IS NULL
    `);
  }

  if (!runColNames.has("tokens_spent")) {
    db.exec("ALTER TABLE runs ADD COLUMN tokens_spent INTEGER NOT NULL DEFAULT 0");
  }

  db.exec("UPDATE runs SET tokens_spent = 0 WHERE tokens_spent IS NULL");

  // ── Run-scoped scheduling metadata ──
  // - scheduling_status: lifecycle of daemon-side scheduling for the run
  //   (pending_register | active | queued | paused | error | NULL)
  // - scheduling_requested_at: ISO ts used for FIFO admission ordering
  // - scheduling_error: human-readable reason when scheduling_status='error'
  if (!runColNames.has("scheduling_status")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_status TEXT");
  }
  if (!runColNames.has("scheduling_requested_at")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_requested_at TEXT");
  }
  if (!runColNames.has("scheduling_error")) {
    db.exec("ALTER TABLE runs ADD COLUMN scheduling_error TEXT");
  }

  // ── Worker ownership columns for steps ──
  // Tracks which polling worker process (job/PID/PGID) claimed each step.
  // Nullable — legacy rows stay NULL, ownership-agnostic callers are unaffected.
  const stepCols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  const stepColNames = new Set(stepCols.map((c) => c.name));
  if (!stepColNames.has("claim_job_id")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_job_id TEXT");
  }
  if (!stepColNames.has("claim_pid")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_pid INTEGER");
  }
  if (!stepColNames.has("claim_pgid")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_pgid INTEGER");
  }
  if (!stepColNames.has("claim_updated_at")) {
    db.exec("ALTER TABLE steps ADD COLUMN claim_updated_at TEXT");
  }

  // Indexes for run-scoped scheduling and step claim queries.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_steps_agent_run_status ON steps(agent_id, run_id, status)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_status_sched ON runs(status, scheduling_status, scheduling_requested_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_sched_queue ON runs(scheduling_status, scheduling_requested_at, created_at)",
  );
}

export function nextRunNumber(): number {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM runs").get() as { next: number };
  return row.next;
}

export function getDbPath(): string {
  return resolveDbPath();
}
