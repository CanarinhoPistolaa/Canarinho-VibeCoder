import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// We test the migration by directly importing getDb, which calls migrate().
// But since getDb() uses a cached connection and resolves DB path from
// env/home, we test the migration logic directly with an isolated DB.
import { getDb, getDbPath, getSystemTokenSpend, incrementSystemTokenSpend } from "../dist/db.js";

describe("run_worktrees table migration", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origDbPath: string | undefined;

  before(() => {
    tempHome = mkdtempSync(path.join(os.tmpdir(), "tamandua-db-test-"));
    origHome = process.env.HOME;
    origDbPath = process.env.TAMANDUA_DB_PATH;
    // Isolate DB to temp directory by changing HOME
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_DB_PATH;
  });

  after(() => {
    if (origHome) {
      process.env.HOME = origHome;
    } else {
      delete process.env.HOME;
    }
    if (origDbPath) {
      process.env.TAMANDUA_DB_PATH = origDbPath;
    } else {
      delete process.env.TAMANDUA_DB_PATH;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  function columnNames(db: DatabaseSync, table: string): Set<string> {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
  }

  function tableExists(db: DatabaseSync, table: string): boolean {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    return row !== undefined;
  }

  it("creates run_worktrees table on first migration", () => {
    const db = getDb();
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees table should exist");
  });

  it("all required columns present with correct types", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(run_worktrees)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colMap = new Map(cols.map((c) => [c.name, c]));

    // Check each required column
    const runIdCol = colMap.get("run_id");
    assert.ok(runIdCol, "run_id column should exist");
    assert.equal(runIdCol.type, "TEXT", "run_id should be TEXT");
    assert.equal(runIdCol.pk, 1, "run_id should be PRIMARY KEY");

    const originRepoCol = colMap.get("worktree_origin_repository");
    assert.ok(originRepoCol, "worktree_origin_repository column should exist");
    assert.equal(originRepoCol.type, "TEXT", "worktree_origin_repository should be TEXT");

    const gitCommonDirCol = colMap.get("worktree_origin_git_common_dir");
    assert.ok(gitCommonDirCol, "worktree_origin_git_common_dir column should exist");
    assert.equal(gitCommonDirCol.type, "TEXT", "worktree_origin_git_common_dir should be TEXT");

    const worktreePathCol = colMap.get("worktree_path");
    assert.ok(worktreePathCol, "worktree_path column should exist");
    assert.equal(worktreePathCol.type, "TEXT", "worktree_path should be TEXT");

    const originRefCol = colMap.get("worktree_origin_ref");
    assert.ok(originRefCol, "worktree_origin_ref column should exist");
    assert.equal(originRefCol.type, "TEXT", "worktree_origin_ref should be TEXT");

    const originShaCol = colMap.get("worktree_origin_sha");
    assert.ok(originShaCol, "worktree_origin_sha column should exist");
    assert.equal(originShaCol.type, "TEXT", "worktree_origin_sha should be TEXT");

    const originalBranchCol = colMap.get("original_branch");
    assert.ok(originalBranchCol, "original_branch column should exist");
    assert.equal(originalBranchCol.type, "TEXT", "original_branch should be TEXT");

    const statusCol = colMap.get("status");
    assert.ok(statusCol, "status column should exist");
    assert.equal(statusCol.type, "TEXT", "status should be TEXT");

    const cleanupPolicyCol = colMap.get("cleanup_policy");
    assert.ok(cleanupPolicyCol, "cleanup_policy column should exist");
    assert.equal(cleanupPolicyCol.type, "TEXT", "cleanup_policy should be TEXT");

    const createdAtCol = colMap.get("created_at");
    assert.ok(createdAtCol, "created_at column should exist");
    assert.equal(createdAtCol.type, "TEXT", "created_at should be TEXT");

    const removedAtCol = colMap.get("removed_at");
    assert.ok(removedAtCol, "removed_at column should exist");
    assert.equal(removedAtCol.type, "TEXT", "removed_at should be TEXT");

    const errorCol = colMap.get("error");
    assert.ok(errorCol, "error column should exist");
    assert.equal(errorCol.type, "TEXT", "error should be TEXT");
  });

  it("has index on status column for list queries", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_worktrees'",
    ).all() as Array<{ name: string }>;

    const hasStatusIndex = indexes.some((idx) => idx.name === "idx_run_worktrees_status");
    assert.ok(hasStatusIndex, "should have idx_run_worktrees_status index");
  });

  it("existing DB tables unaffected by migration", () => {
    const db = getDb();
    // All existing tables should still be present
    assert.ok(tableExists(db, "runs"), "runs table should exist");
    assert.ok(tableExists(db, "steps"), "steps table should exist");
    assert.ok(tableExists(db, "stories"), "stories table should exist");
    assert.ok(tableExists(db, "tamandua_stats"), "tamandua_stats table should exist");

    // Core runs columns should still be present
    const runCols = columnNames(db, "runs");
    assert.ok(runCols.has("id"), "runs.id should exist");
    assert.ok(runCols.has("workflow_id"), "runs.workflow_id should exist");
    assert.ok(runCols.has("status"), "runs.status should exist");
    assert.ok(runCols.has("tokens_spent"), "runs.tokens_spent should exist");
    assert.ok(runCols.has("scheduling_status"), "runs.scheduling_status should exist");

    // Core steps columns should still be present
    const stepCols = columnNames(db, "steps");
    assert.ok(stepCols.has("id"), "steps.id should exist");
    assert.ok(stepCols.has("run_id"), "steps.run_id should exist");
    assert.ok(stepCols.has("agent_id"), "steps.agent_id should exist");
    assert.ok(stepCols.has("status"), "steps.status should exist");
    assert.ok(stepCols.has("claim_job_id"), "steps.claim_job_id should exist");

    // Core stories columns should still be present
    const storyCols = columnNames(db, "stories");
    assert.ok(storyCols.has("id"), "stories.id should exist");
    assert.ok(storyCols.has("run_id"), "stories.run_id should exist");
    assert.ok(storyCols.has("story_id"), "stories.story_id should exist");
    assert.ok(storyCols.has("status"), "stories.status should exist");

    // tamandua_stats should still be present
    const statsCols = columnNames(db, "tamandua_stats");
    assert.ok(statsCols.has("system_tokens_spent"), "tamandua_stats.system_tokens_spent should exist");
  });

  it("migration is idempotent (second call does nothing harmful)", () => {
    // Calling getDb() again will re-run migrate() on the same DB
    const db = getDb();

    // Table should still exist with no error
    assert.ok(tableExists(db, "run_worktrees"), "run_worktrees should still exist after second migration");

    // Should have exactly the expected columns (no duplicates)
    const cols = db.prepare("PRAGMA table_info(run_worktrees)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    const expectedCols = [
      "run_id",
      "worktree_origin_repository",
      "worktree_origin_git_common_dir",
      "worktree_path",
      "worktree_origin_ref",
      "worktree_origin_sha",
      "original_branch",
      "status",
      "cleanup_policy",
      "created_at",
      "removed_at",
      "error",
    ];
    assert.deepEqual(colNames.sort(), expectedCols.sort(), "columns should match expected after idempotent migrate");
  });

  it("can insert and query a worktree row", () => {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, worktree_origin_ref, worktree_origin_sha,
         original_branch, status, cleanup_policy, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-run-id-001",
      "/home/user/repo",
      "/home/user/repo/.git",
      "/tmp/worktrees/repo-abc/r1-xyz",
      "refs/heads/main",
      "abc1234",
      "main",
      "ready",
      "remove_on_success",
      now,
    );

    const row = db.prepare("SELECT * FROM run_worktrees WHERE run_id = ?").get("test-run-id-001") as {
      run_id: string;
      worktree_origin_repository: string;
      worktree_origin_git_common_dir: string;
      worktree_path: string;
      worktree_origin_ref: string;
      worktree_origin_sha: string;
      original_branch: string;
      status: string;
      cleanup_policy: string;
      created_at: string;
      removed_at: string | null;
      error: string | null;
    };

    assert.ok(row, "should retrieve inserted row");
    assert.equal(row.run_id, "test-run-id-001");
    assert.equal(row.worktree_origin_repository, "/home/user/repo");
    assert.equal(row.worktree_origin_git_common_dir, "/home/user/repo/.git");
    assert.equal(row.worktree_path, "/tmp/worktrees/repo-abc/r1-xyz");
    assert.equal(row.worktree_origin_ref, "refs/heads/main");
    assert.equal(row.worktree_origin_sha, "abc1234");
    assert.equal(row.original_branch, "main");
    assert.equal(row.status, "ready");
    assert.equal(row.cleanup_policy, "remove_on_success");
    assert.equal(row.created_at, now);
    assert.equal(row.removed_at, null);
    assert.equal(row.error, null);
  });

  it("default status is 'creating' when not specified", () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert without specifying status
    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "test-run-id-002",
      "/home/user/repo2",
      "/home/user/repo2/.git",
      "/tmp/worktrees/repo2/r2-xyz",
      now,
    );

    const row = db.prepare("SELECT status, cleanup_policy FROM run_worktrees WHERE run_id = ?").get(
      "test-run-id-002",
    ) as { status: string; cleanup_policy: string };

    assert.equal(row.status, "creating", "default status should be creating");
    assert.equal(row.cleanup_policy, "remove_on_success", "default cleanup_policy should be remove_on_success");
  });

  it("can update status via index-friendly query", () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert with 'creating' status
    db.prepare(`
      INSERT INTO run_worktrees
        (run_id, worktree_origin_repository, worktree_origin_git_common_dir,
         worktree_path, worktree_origin_sha, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "test-run-id-003",
      "/home/user/repo3",
      "/home/user/repo3/.git",
      "/tmp/worktrees/repo3/r3-xyz",
      "def5678",
      now,
    );

    // Update status to 'ready'
    db.prepare("UPDATE run_worktrees SET status = 'ready' WHERE run_id = ?").run("test-run-id-003");

    const row = db.prepare(
      "SELECT status FROM run_worktrees WHERE run_id = ?",
    ).get("test-run-id-003") as { status: string };

    assert.equal(row.status, "ready");

    // Verify the status index is used (by checking explain query plan doesn't error)
    const explain = db.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM run_worktrees WHERE status = ?",
    ).all("ready");
    assert.ok(explain.length > 0, "query plan should be valid");
  });
});

describe("getDbPath", () => {
  it("returns path ending with .tamandua/tamandua.db under HOME", () => {
    const result = getDbPath();
    assert.ok(result.endsWith(path.join(".tamandua", "tamandua.db")), `expected path ending with .tamandua/tamandua.db, got ${result}`);
  });

  it("respects TAMANDUA_DB_PATH env var", () => {
    const customPath = "/tmp/custom-tamandua.db";
    process.env.TAMANDUA_DB_PATH = customPath;
    try {
      const result = getDbPath();
      assert.equal(result, customPath);
    } finally {
      delete process.env.TAMANDUA_DB_PATH;
    }
  });
});

describe("getSystemTokenSpend", () => {
  let startingSpend: number;

  before(() => {
    // Reset tamandua_stats to a known baseline
    const db = getDb();
    db.prepare("UPDATE tamandua_stats SET system_tokens_spent = 0 WHERE id = 1").run();
    // Also ensure the row exists (migrate() creates it)
    db.prepare("INSERT OR IGNORE INTO tamandua_stats (id, system_tokens_spent) VALUES (1, 0)").run();
    startingSpend = getSystemTokenSpend();
  });

  it("returns 0 after reset", () => {
    assert.equal(startingSpend, 0);
  });

  it("returns updated value after incrementSystemTokenSpend", () => {
    incrementSystemTokenSpend(100);
    const result = getSystemTokenSpend();
    assert.equal(result, 100);
  });

  it("accumulates across multiple increments", () => {
    incrementSystemTokenSpend(50);
    incrementSystemTokenSpend(25);
    const result = getSystemTokenSpend();
    assert.equal(result, 175);
  });
});
