import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { checkActiveRuns, uninstallWorkflow, uninstallAllWorkflows } from "../../dist/installer/uninstall.js";

describe("uninstall", () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-uninstall-"));
    dbPath = path.join(tempDir, ".tamandua", "tamandua.db");
    process.env.TAMANDUA_DB_PATH = dbPath;
    process.env.HOME = tempDir;
    process.env.TAMANDUA_STATE_DIR = path.join(tempDir, ".tamandua");

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
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
    `);
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

  it("returns empty array when no active runs", async () => {
    const runs = await checkActiveRuns();
    assert.deepEqual(runs, []);
  });

  it("returns empty array for completed runs", async () => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("r1", "wf1", "task1", "completed", "{}");
    const runs = await checkActiveRuns();
    assert.deepEqual(runs, []);
  });

  it("returns running runs", async () => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("r1", "wf1", "task1", "running", "{}");
    const runs = await checkActiveRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.id, "r1");
    assert.equal(runs[0]!.task, "task1");
    assert.equal(runs[0]!.status, "running");
  });

  it("returns paused runs", async () => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("r2", "wf2", "task2", "paused", "{}");
    const runs = await checkActiveRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.id, "r2");
  });

  it("filters active runs by workflow_id", async () => {
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("r1", "wf-a", "task A", "running", "{}");
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run("r2", "wf-b", "task B", "running", "{}");

    const runsA = await checkActiveRuns("wf-a");
    assert.equal(runsA.length, 1);
    assert.equal(runsA[0]!.id, "r1");
  });

  describe("uninstallAllWorkflows", () => {
    it("returns empty array when no workflows dir exists", async () => {
      const results = await uninstallAllWorkflows();
      assert.deepEqual(results, []);
    });

    it("processes workflow dirs when present", async () => {
      // Create a workflow directory
      const wfDir = path.join(tempDir, ".tamandua", "workflows", "wf-empty");
      fs.mkdirSync(wfDir, { recursive: true });

      // Create agents.json with an entry for this workflow
      const tamanduaDir = path.join(tempDir, ".tamandua");
      fs.mkdirSync(path.join(tamanduaDir, "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(tamanduaDir, "agents.json"),
        JSON.stringify([
          { id: "wf-empty_dev-agent", workflowId: "wf-empty", name: "Dev" },
        ]),
        "utf-8",
      );

      const results = await uninstallAllWorkflows();
      assert.ok(results.length >= 1, "should process at least one workflow");
    });
  });
});
