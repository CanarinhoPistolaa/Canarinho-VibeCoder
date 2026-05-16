import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { completeStep } from "../../dist/installer/step-ops.js";

describe("completeStep basic paths", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let originalDbPath: string | undefined;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-complete-step-"));
    dbPath = path.join(tempDir, ".tamandua", "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempDir;
    process.env.TAMANDUA_STATE_DIR = path.join(tempDir, ".tamandua");

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL DEFAULT 'test',
      task TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      scheduling_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      input_template TEXT NOT NULL DEFAULT '',
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  });

  afterEach(() => {
    if (originalDbPath) process.env.TAMANDUA_DB_PATH = originalDbPath;
    else delete process.env.TAMANDUA_DB_PATH;
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    try { db.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("completes a simple single step", () => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)"
    ).run("run-1", "wf", "test", "running");

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("step-1-id", "run-1", "plan", "dev", 0, "", "running");

    const result = completeStep("step-1-id", "CHANGES: done");
    assert.ok(result.status === "advanced" || result.status === "completed");

    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get("step-1-id") as { status: string };
    assert.equal(step.status, "done");
  });

  it("blocks completion for failed runs", () => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)"
    ).run("run-fail", "wf", "test", "failed");

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("step-fail-id", "run-fail", "plan", "dev", 0, "running");

    const result = completeStep("step-fail-id", "output");
    assert.equal(result.status, "blocked");
  });

  it("throws when step not found", () => {
    assert.throws(
      () => completeStep("nonexistent-id", "output"),
      /Step not found/,
    );
  });

  it("passes expects validation", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r2", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run("s2", "r2", "plan", "dev", 0, "STATUS: done", "running");
    const r = completeStep("s2", "STATUS: done");
    assert.ok(r.status === "advanced" || r.status === "completed");
  });

  it("retries on expects failure", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r3", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run("s3", "r3", "plan", "dev", 0, "REPO: x", "running");
    const r = completeStep("s3", "wrong");
    assert.equal(r.status, "retrying");
  });

  it("fails when expects exhausted", () => {
    db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)").run("r4", "wf", "t", "running");
    db.prepare("INSERT INTO steps (id, run_id, step_id, agent_id, step_index, expects, status, retry_count, max_retries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s4", "r4", "plan", "dev", 0, "REPO: x", "running", 3, 3);
    const r = completeStep("s4", "no");
    assert.equal(r.status, "failed");
  });
});
