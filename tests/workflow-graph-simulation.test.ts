/**
 * Workflow graph simulation — every bundled workflow, pure step-ops.
 *
 * For each bundled workflow this test simulates a full run to completion
 * IN-PROCESS through the real step-ops pipeline (peekStep / claimStep /
 * completeStep / failStep / advancePipeline) with auto-generated step
 * outputs — no daemon, no scheduler, no subprocesses, no models.
 * Milliseconds per workflow.
 *
 * What this pins (motor contract C1–C4, C8 — see tests/MOTOR-CONTRACT.md):
 * - every workflow's step graph terminates: no unreachable steps, no
 *   deadlocks, loop wiring (stories, verify_each) converges
 * - context propagation: KEY: value outputs resolve later {{placeholders}}
 * - a mid-run step failure retries and the run still completes
 * - exhausting a step's retries fails the run (escalation path)
 *
 * Output generation is generic: each completed step emits its `expects`
 * text plus a `KEY: sim-<key>` line for every {{placeholder}} any LATER
 * step references (mirroring how real agents feed context forward), and
 * steps whose instructions mention STORIES_JSON emit a two-story plan so
 * loop-over-stories steps have work.
 *
 * A workflow that hangs here would hang identically under any motor —
 * failures in this file are workflow-spec or step-ops regressions, not
 * polling-motor churn.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";
import { getDb } from "../dist/db.js";
import {
  peekStep,
  claimStep,
  completeStep,
  failStep,
  advancePipeline,
} from "../dist/installer/step-ops.js";
import type { WorkflowSpec } from "../dist/installer/types.js";

// ── Environment isolation ───────────────────────────────────────────
// getDb/emitEvent/logger resolve their paths lazily (first call), so
// setting env here — after the hoisted imports but before any test body
// runs — isolates all state. TAMANDUA_CONTROL_PORT points at port 1
// (nothing listens there) so completion-triggered control-plane
// notifications fail fast instead of reaching a live daemon.

const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
const _savedDbPath = process.env.TAMANDUA_DB_PATH;
const _savedControlPort = process.env.TAMANDUA_CONTROL_PORT;
const _isolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-graph-sim-"));
process.env.TAMANDUA_STATE_DIR = _isolationDir;
process.env.TAMANDUA_DB_PATH = path.join(_isolationDir, "tamandua.db");
process.env.TAMANDUA_CONTROL_PORT = "1";

process.on("exit", () => {
  if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
  else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
  if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
  else process.env.TAMANDUA_DB_PATH = _savedDbPath;
  if (_savedControlPort === undefined) delete process.env.TAMANDUA_CONTROL_PORT;
  else process.env.TAMANDUA_CONTROL_PORT = _savedControlPort;
  try { fs.rmSync(_isolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Run creation (mirrors the DB work of runWorkflow in run.ts, minus
//    daemon registration, worktree creation, and cron setup) ─────────

/** Context keys the harness/step-ops provide at runtime — never emitted
 *  as simulated step output. */
const AUTO_CONTEXT_KEYS = new Set([
  "run_id",
  "task",
  "retry_feedback",
  "verify_feedback",
  "timeout_retry",
  "has_frontend_changes",
  "has_pr",
  "current_story",
  "current_story_id",
  "current_story_title",
  "completed_stories",
  "stories_remaining",
  "progress",
]);

function seedContext(spec: WorkflowSpec): Record<string, string> {
  const workspaceMode = spec.run?.workspace ?? "direct";
  const seeded: Record<string, string> = {
    task: `Simulated task for ${spec.id}`,
    workspace_mode: workspaceMode,
    no_hurry_save_tokens_mode: "false",
    harness_type: "pi",
    no_relaunch_upon_rugpull: "false",
    repo: "/sim/origin-repo",
    original_branch: "main",
    working_directory_for_harness: "/sim/origin-repo",
    base_branch_sha: "sim-sha",
  };
  if (workspaceMode === "worktree") {
    seeded.worktree_path = "/sim/worktree";
    seeded.worktree_origin_repository = "/sim/origin-repo";
    seeded.worktree_origin_ref = "main";
    seeded.worktree_origin_sha = "sim-sha";
    seeded.repo = "/sim/worktree";
    seeded.working_directory_for_harness = "/sim/worktree";
  }
  if (spec.id === "just-do-it") {
    seeded.target_working_directory_for_harness = "/sim/origin-repo";
  }
  return seeded;
}

function createSimRun(spec: WorkflowSpec): { runId: string; seeded: Record<string, string> } {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const seeded = seedContext(spec);

  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, 0, NULL, ?, ?)`,
  ).run(runId, Math.floor(Math.random() * 1_000_000), spec.id, seeded.task, JSON.stringify(seeded), now, now);

  const insertStep = getDb().prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < spec.steps.length; i++) {
    const step = spec.steps[i];
    insertStep.run(
      crypto.randomUUID(),
      runId,
      step.id,
      step.agent.startsWith(`${spec.id}_`) ? step.agent : `${spec.id}_${step.agent}`,
      i,
      step.input,
      step.expects,
      step.max_retries ?? 4,
      step.type ?? "single",
      step.loop ? JSON.stringify(step.loop) : null,
      now,
      now,
    );
  }

  advancePipeline(runId);
  return { runId, seeded };
}

// ── Simulation ──────────────────────────────────────────────────────

const MAX_ROUNDS = 500;

const SIM_STORIES = [
  {
    id: "S1",
    title: "First simulated story",
    description: "Do the first simulated thing",
    acceptanceCriteria: ["it works"],
  },
  {
    id: "S2",
    title: "Second simulated story",
    description: "Do the second simulated thing",
    acceptanceCriteria: ["it also works"],
  },
];

function collectPlaceholders(template: string): string[] {
  const keys: string[] = [];
  template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_m, key: string) => {
    keys.push(key.toLowerCase());
    return "";
  });
  return keys;
}

function runStatus(runId: string): string {
  const row = getDb().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
  return row.status;
}

function stepsSnapshot(runId: string): string {
  const rows = getDb()
    .prepare("SELECT step_index, step_id, agent_id, status, retry_count FROM steps WHERE run_id = ? ORDER BY step_index")
    .all(runId) as Array<{ step_index: number; step_id: string; agent_id: string; status: string; retry_count: number }>;
  return rows
    .map((r) => `  #${r.step_index} ${r.step_id} (${r.agent_id}) status=${r.status} retries=${r.retry_count}`)
    .join("\n");
}

interface SimState {
  emitted: Set<string>;
  storiesEmitted: boolean;
}

/**
 * Candidate lines for satisfying `regex:` expects clauses. validateExpects
 * treats a `regex:<pattern>` line as a pattern the output must match; a
 * simulated agent must synthesize a plausible line. Each candidate is tested
 * against the actual pattern, so a stale candidate fails loudly.
 */
const REGEX_EXPECTS_CANDIDATES = [
  "PR: https://github.com/sim-org/sim-repo/pull/1",
  "MERGE_COMMIT: 0123abc",
  "STATUS: done",
];

function satisfyExpects(expects: string): string[] {
  const lines: string[] = [];
  for (const rawLine of (expects.trim() || "STATUS: done").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("regex:")) {
      const pattern = new RegExp(line.slice("regex:".length), "m");
      const candidate = REGEX_EXPECTS_CANDIDATES.find((c) => pattern.test(c));
      assert.ok(
        candidate,
        `simulation cannot satisfy expects pattern "${line}" — add a matching candidate to REGEX_EXPECTS_CANDIDATES`,
      );
      lines.push(candidate);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function generateOutput(spec: WorkflowSpec, stepIndex: number, state: SimState): string {
  const specStep = spec.steps[stepIndex];
  const lines: string[] = satisfyExpects(specStep.expects ?? "STATUS: done");

  // Feed forward every key any LATER step's template references, the way a
  // real agent's structured output block does.
  const futureKeys = new Set<string>();
  for (let j = stepIndex + 1; j < spec.steps.length; j++) {
    for (const key of collectPlaceholders(spec.steps[j].input)) futureKeys.add(key);
  }
  for (const key of futureKeys) {
    if (state.emitted.has(key) || AUTO_CONTEXT_KEYS.has(key)) continue;
    lines.push(`${key.toUpperCase()}: sim-${key}`);
    state.emitted.add(key);
  }

  // Planner steps that are instructed to produce a story plan feed the
  // loop-over-stories step. Emit exactly once per run.
  if (
    !state.storiesEmitted &&
    /STORIES_JSON/.test(specStep.input) &&
    spec.steps.some((s) => s.type === "loop")
  ) {
    lines.push(`STORIES_JSON: ${JSON.stringify(SIM_STORIES)}`);
    state.storiesEmitted = true;
  }

  return lines.join("\n");
}

interface SimulateOptions {
  /** Fail the Nth successful claim once before proceeding (1-based). */
  failOnceAtClaim?: number;
}

interface SimulateResult {
  status: string;
  workRounds: number;
  failuresInjected: number;
}

async function simulate(
  spec: WorkflowSpec,
  runId: string,
  seeded: Record<string, string>,
  options: SimulateOptions = {},
): Promise<SimulateResult> {
  const state: SimState = { emitted: new Set(Object.keys(seeded)), storiesEmitted: false };
  let claims = 0;
  let failuresInjected = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const status = runStatus(runId);
    if (status !== "running") {
      return { status, workRounds: claims, failuresInjected };
    }

    let sawWork = false;
    for (const agent of spec.agents) {
      const scopedAgentId = `${spec.id}_${agent.id}`;
      if (peekStep(scopedAgentId, runId) !== "HAS_WORK") continue;
      sawWork = true;

      const claim = claimStep(scopedAgentId, runId);
      // found:false covers loop-step internal transitions (story bookkeeping,
      // loop completion) — state changed, so just continue to the next round.
      if (!claim.found || !claim.stepId) continue;
      claims++;

      const stepRow = getDb()
        .prepare("SELECT step_index FROM steps WHERE id = ?")
        .get(claim.stepId) as { step_index: number };

      if (options.failOnceAtClaim === claims) {
        failuresInjected++;
        await failStep(claim.stepId, "simulated agent failure");
        continue;
      }

      completeStep(claim.stepId, generateOutput(spec, stepRow.step_index, state));
    }

    if (!sawWork && runStatus(runId) === "running") {
      assert.fail(
        `Workflow ${spec.id} deadlocked: run still 'running' but no agent has claimable work.\nSteps:\n${stepsSnapshot(runId)}`,
      );
    }
  }

  assert.fail(
    `Workflow ${spec.id} did not terminate within ${MAX_ROUNDS} simulation rounds.\nSteps:\n${stepsSnapshot(runId)}`,
  );
}

// ── Discover bundled workflows ──────────────────────────────────────

const workflowsDir = resolveBundledWorkflowsDir();
const workflowIds = fs
  .readdirSync(workflowsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(workflowsDir, e.name, "workflow.yml")))
  .map((e) => e.name)
  .sort();

describe("workflow graph simulation (all bundled workflows, pure step-ops)", () => {
  before(() => {
    assert.ok(workflowIds.length >= 20, `expected the full bundled catalog, found ${workflowIds.length}`);
  });

  for (const workflowId of workflowIds) {
    describe(workflowId, () => {
      it("simulates to completion (happy path)", async () => {
        const spec = await loadWorkflowSpec(path.join(workflowsDir, workflowId));
        const { runId, seeded } = createSimRun(spec);
        const result = await simulate(spec, runId, seeded);
        assert.equal(
          result.status,
          "completed",
          `run should complete, got "${result.status}"\nSteps:\n${stepsSnapshot(runId)}`,
        );
        const notDone = getDb()
          .prepare("SELECT COUNT(*) AS cnt FROM steps WHERE run_id = ? AND status != 'done'")
          .get(runId) as { cnt: number };
        assert.equal(notDone.cnt, 0, `all steps should be done\nSteps:\n${stepsSnapshot(runId)}`);
      });

      it("recovers from a single mid-run step failure (retry) and completes", async () => {
        const spec = await loadWorkflowSpec(path.join(workflowsDir, workflowId));
        const { runId, seeded } = createSimRun(spec);
        // Fail the second claim: exercises retry on a step that already has
        // upstream context (the first step's failure path is equivalent but
        // covers less of the context-propagation surface).
        const target = spec.steps.length > 1 ? 2 : 1;
        const result = await simulate(spec, runId, seeded, { failOnceAtClaim: target });
        assert.equal(result.failuresInjected, 1, "exactly one failure should have been injected");
        assert.equal(
          result.status,
          "completed",
          `run should complete after a retried failure, got "${result.status}"\nSteps:\n${stepsSnapshot(runId)}`,
        );
      });

      it("fails the run when the first step exhausts its retries", async () => {
        const spec = await loadWorkflowSpec(path.join(workflowsDir, workflowId));
        const { runId } = createSimRun(spec);
        const firstAgent = `${spec.id}_${spec.steps[0].agent.replace(new RegExp(`^${spec.id}_`), "")}`;
        const maxRetries = spec.steps[0].max_retries ?? 4;

        for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
          if (runStatus(runId) !== "running") break;
          const claim = claimStep(firstAgent, runId);
          assert.ok(claim.found && claim.stepId, `attempt ${attempt}: first step should be claimable while run is running`);
          await failStep(claim.stepId!, "simulated persistent failure");
        }

        assert.equal(
          runStatus(runId),
          "failed",
          `run should fail after ${maxRetries} retries are exhausted\nSteps:\n${stepsSnapshot(runId)}`,
        );
      });
    });
  }
});
