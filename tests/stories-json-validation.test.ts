/**
 * SJSN — story-ingestion structural validation (motor contract C20, see
 * tests/MOTOR-CONTRACT.md).
 *
 * JSON.parse accepts duplicate keys silently (last-one-wins). A planner that
 * omits "},{" separators between stories therefore emits ONE fused object
 * that still parses as valid JSON, passes every per-story field check, and
 * silently discards all but the final story. Run 9672c8dd (LSEM, 2026-07-04)
 * lost 6 of 7 stories exactly this way: the only surviving story was the
 * final "verification" story, so the developer verified unchanged main,
 * declared success, and the run burned 560k tokens delivering nothing.
 *
 * Invariants pinned here:
 * - fused/duplicate-key payloads are rejected with a structural-mismatch
 *   error naming both counts
 * - escaped quotes inside string values (a description that *talks about*
 *   `"id":`) do not trigger false positives
 * - validation is two-phase: a rejected payload inserts ZERO stories
 * - completeStep converts any STORIES_JSON validation failure into a bounded
 *   informed retry (step re-pended, retry_count bumped, reason in output so
 *   claimStep surfaces it as {{retry_feedback}}), never a thrown error
 * - retries exhaust into a failed run, not an infinite loop
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Environment isolation (see step-ops-dispatch-races.test.ts) ─────
const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
const _savedDbPath = process.env.TAMANDUA_DB_PATH;
const _savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
const _isolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-sjsn-"));
process.env.TAMANDUA_STATE_DIR = _isolationDir;
process.env.TAMANDUA_DB_PATH = path.join(_isolationDir, "tamandua.db");
process.env.TAMANDUA_CONTROL_PORT = "1"; // nothing listens; control-plane calls fail fast

process.on("exit", () => {
  if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
  if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = _savedDbPath;
  if (_savedControlPort === undefined) delete process.env.TAMANDUA_CONTROL_PORT;
  else process.env.TAMANDUA_CONTROL_PORT = _savedControlPort;
  try { fs.rmSync(_isolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

import { getDb } from "../dist/db.js";
import {
  claimStep,
  completeStep,
  countUnescapedJsonKey,
  parseAndInsertStories,
  advancePipeline,
} from "../dist/installer/step-ops.js";

// ── Fixtures ─────────────────────────────────────────────────────────

function story(id: string, title = `Title ${id}`) {
  return { id, title, description: `Description for ${id}`, acceptanceCriteria: ["AC1", "AC2"] };
}

/**
 * Build the fused-object payload shape from the LSEM incident: N stories'
 * keys concatenated into ONE object (no "},{" between stories).
 */
function fusedStoriesJson(ids: string[]): string {
  const inner = ids
    .map((id) => `"id":"${id}","title":"T ${id}","description":"D ${id}","acceptanceCriteria":["AC"]`)
    .join(",");
  return `[{${inner}}]`;
}

interface PlanFixture {
  runId: string;
  planAgent: string;
  planStepDbId: string;
  loopStepDbId: string;
}

/** A minimal plan → implement(loop over stories) run. */
function createPlanLoopRun(maxRetries = 4): PlanFixture {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const wf = `sjsn-wf-${runId.slice(0, 8)}`;
  const planAgent = `${wf}_planner`;

  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, 'sjsn test', 'running', '{"task":"sjsn test"}', 0, ?, ?)`,
  ).run(runId, wf, now, now);

  const planStepDbId = crypto.randomUUID();
  const loopStepDbId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, 'plan', ?, 0, ?, 'STATUS: done', 'waiting', 0, ?, 'single', ?, ?)`,
  ).run(planStepDbId, runId, planAgent, "Plan {{task}}.\nRETRY FEEDBACK:\n{{retry_feedback}}", maxRetries, now, now);
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 1, 'do {{current_story}}', 'STATUS: done', 'waiting', 0, ?, 'loop', '{"over":"stories","completion":"all_done"}', ?, ?)`,
  ).run(loopStepDbId, runId, `${wf}_developer`, maxRetries, now, now);
  advancePipeline(runId);

  return { runId, planAgent, planStepDbId, loopStepDbId };
}

function planOutput(storiesJson: string): string {
  return `STATUS: done\nBRANCH: feature/sjsn-test\nSTORIES_JSON: ${storiesJson}`;
}

function storyCount(runId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS cnt FROM stories WHERE run_id = ?").get(runId) as { cnt: number };
  return row.cnt;
}

// ── countUnescapedJsonKey ────────────────────────────────────────────

describe("countUnescapedJsonKey", () => {
  it("counts real key occurrences", () => {
    const text = '[{"id":"US-001","title":"A"},{"id":"US-002","title":"B"}]';
    assert.equal(countUnescapedJsonKey(text, "id"), 2);
    assert.equal(countUnescapedJsonKey(text, "title"), 2);
  });

  it("counts duplicate keys inside one fused object", () => {
    assert.equal(countUnescapedJsonKey(fusedStoriesJson(["US-001", "US-002", "US-003"]), "id"), 3);
  });

  it("does not count escaped quotes inside string values", () => {
    // description talks ABOUT the "id": key — JSON-escaped in the raw text
    const text = '[{"id":"US-001","title":"A","description":"the \\"id\\": key is required"}]';
    assert.equal(countUnescapedJsonKey(text, "id"), 1);
  });

  it("does not match longer keys containing the target as a suffix", () => {
    const text = '[{"story_id":"US-001","id":"US-002"}]';
    assert.equal(countUnescapedJsonKey(text, "id"), 1);
  });
});

// ── parseAndInsertStories: structural rejection + atomicity ─────────

describe("parseAndInsertStories (SJSN guard)", () => {
  it("rejects the fused-object duplicate-key collapse with both counts in the message", () => {
    const fx = createPlanLoopRun();
    const fused = fusedStoriesJson(["US-001", "US-002", "US-003", "US-004", "US-005", "US-006", "US-007"]);
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${fused}\n`, fx.runId),
      (err: Error) =>
        /structural mismatch/.test(err.message) &&
        /7 "id" keys/.test(err.message) &&
        /only 1 story/.test(err.message) &&
        /fused/.test(err.message),
    );
    assert.equal(storyCount(fx.runId), 0, "rejected payload must insert zero stories");
  });

  it("accepts a properly separated array of the same stories", () => {
    const fx = createPlanLoopRun();
    const stories = ["US-001", "US-002", "US-003", "US-004", "US-005", "US-006", "US-007"].map((id) => story(id));
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 7);
  });

  it("does not false-positive on descriptions that mention the id key", () => {
    const fx = createPlanLoopRun();
    const s = story("US-001");
    s.description = 'This story documents the "id": key convention for STORIES_JSON.';
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify([s])}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 1);
  });

  it("inserts nothing when a later story fails field validation (two-phase atomicity)", () => {
    const fx = createPlanLoopRun();
    const stories = [story("US-001"), { id: "US-002" }]; // second story invalid
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /missing required fields/,
    );
    assert.equal(storyCount(fx.runId), 0, "partial validation failure must not leave partial stories");
  });
});

// ── completeStep: informed bounded retry, not a throw ────────────────

describe("completeStep STORIES_JSON validation (SJSN retry contract)", () => {
  it("fused payload → retrying: step re-pended with feedback, zero stories, run alive", () => {
    const fx = createPlanLoopRun();
    const claim = claimStep(fx.planAgent, fx.runId);
    assert.ok(claim.found, "plan step must be claimable");

    const result = completeStep(fx.planStepDbId, planOutput(fusedStoriesJson(["US-001", "US-002", "US-003"])));
    assert.equal(result.status, "retrying");
    assert.match(result.detail ?? "", /structural mismatch/);

    const db = getDb();
    const step = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(fx.planStepDbId) as
      { status: string; retry_count: number; output: string | null };
    assert.equal(step.status, "pending", "step must be re-pended for an informed retry");
    assert.equal(step.retry_count, 1);
    assert.match(step.output ?? "", /structural mismatch/, "reason must be in output for retry_feedback");

    assert.equal(storyCount(fx.runId), 0);
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(fx.runId) as { status: string };
    assert.equal(run.status, "running", "run must stay alive for the retry");

    // The retried planner must see the structural complaint as RETRY FEEDBACK.
    const retryClaim = claimStep(fx.planAgent, fx.runId);
    assert.ok(retryClaim.found, "step must be re-claimable");
    assert.match(
      retryClaim.resolvedInput ?? "",
      /RETRY FEEDBACK:[\s\S]*structural mismatch[\s\S]*fused/i,
      "retry prompt must carry the structural-mismatch feedback",
    );
  });

  it("corrected payload on retry completes the step and inserts all stories", () => {
    const fx = createPlanLoopRun();
    claimStep(fx.planAgent, fx.runId);
    completeStep(fx.planStepDbId, planOutput(fusedStoriesJson(["US-001", "US-002"])));

    claimStep(fx.planAgent, fx.runId);
    const stories = [story("US-001"), story("US-002")];
    const result = completeStep(fx.planStepDbId, planOutput(JSON.stringify(stories)));
    assert.equal(result.status, "advanced");
    assert.equal(storyCount(fx.runId), 2);

    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(fx.planStepDbId) as { status: string };
    assert.equal(step.status, "done");
  });

  it("malformed JSON also takes the informed-retry path instead of throwing", () => {
    const fx = createPlanLoopRun();
    claimStep(fx.planAgent, fx.runId);
    const result = completeStep(fx.planStepDbId, planOutput('[{"id":"US-001" this is not json'));
    assert.equal(result.status, "retrying");
    assert.match(result.detail ?? "", /Failed to parse STORIES_JSON/);
    const step = getDb().prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(fx.planStepDbId) as
      { status: string; retry_count: number };
    assert.equal(step.status, "pending");
    assert.equal(step.retry_count, 1);
  });

  it("validation retries exhaust into a failed run", () => {
    const fx = createPlanLoopRun(1); // max_retries=1 → second failure exhausts
    claimStep(fx.planAgent, fx.runId);
    const first = completeStep(fx.planStepDbId, planOutput(fusedStoriesJson(["US-001", "US-002"])));
    assert.equal(first.status, "retrying");

    claimStep(fx.planAgent, fx.runId);
    const second = completeStep(fx.planStepDbId, planOutput(fusedStoriesJson(["US-001", "US-002"])));
    assert.equal(second.status, "failed");

    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(fx.planStepDbId) as { status: string };
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(fx.runId) as { status: string };
    assert.equal(step.status, "failed");
    assert.equal(run.status, "failed");
  });
});
