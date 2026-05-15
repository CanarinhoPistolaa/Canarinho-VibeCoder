import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDb, nextRunNumber } from "../db.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import {
  ensureDaemonControlAvailable,
  registerRunWithDaemon,
} from "../server/control-client.js";
import { emitEvent } from "./events.js";
import { advancePipeline } from "./step-ops.js";
import {
  RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY,
  validateRunHarnessForScheduling,
} from "./run-harness.js";
import { createRunWorktree, type ManagedRunWorktree } from "./worktree-manager.js";

export interface RunWorkflowParams {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
  /** Optional initial context for template resolution */
  context?: Record<string, string>;
  /** Working directory for the pi harness/tool execution environment */
  workingDirectoryForHarness?: string;
  /** Origin repository for worktree-based workflows */
  worktreeOriginRepository?: string;
  /** Origin ref for worktree-based workflows */
  worktreeOriginRef?: string;
  /** When true, reduces polling frequency to save tokens (15-min floor, 15-min default) */
  noHurrySaveTokensMode?: boolean;
}

export interface RunWorkflowResult {
  runId: string;
  runNumber: number;
  workflowId: string;
  taskTitle: string;
  status: string;
  stepCount: number;
  workingDirectoryForHarness: string;
}

/**
 * Start a new workflow run.
 *
 * 1. Loads the workflow spec
 * 2. Creates a run record in the DB
 * 3. Creates step records for each step
 * 4. Starts agent cron jobs for polling
 * 5. Emits a run.started event
 */
export async function runWorkflow(
  params: RunWorkflowParams,
): Promise<RunWorkflowResult> {
  const {
    workflowId,
    taskTitle,
    notifyUrl,
    context = {},
    workingDirectoryForHarness: requestedWorkingDirectoryForHarness,
    worktreeOriginRepository,
    worktreeOriginRef,
    noHurrySaveTokensMode,
  } = params;

  // Load the workflow spec from the installed workflow directory
  const workflowDir = resolveWorkflowDir(workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);

  await ensureDaemonControlAvailable();

  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const runNumber = nextRunNumber();

  const workspaceMode = workflow.run?.workspace ?? "direct";

  let workingDirectoryForHarness: string;

  // Seed the run context with the task description so step input templates can
  // reference {{task}} from the very first step. Without this, the planner step
  // (which always references {{task}}) fails immediately on claim with a missing
  // template key error, aborting the whole run.
  const seededContext: Record<string, string> = {
    task: taskTitle,
    ...context,
    workspace_mode: workspaceMode,
    no_hurry_save_tokens_mode: String(noHurrySaveTokensMode ?? false),
  };

  if (workspaceMode === "direct") {
    if (worktreeOriginRepository) {
      throw new Error(
        "--worktree-origin-repository is only valid for workflows with run.workspace: worktree",
      );
    }
    if (worktreeOriginRef) {
      throw new Error(
        "--worktree-origin-ref is only valid for workflows with run.workspace: worktree",
      );
    }

    workingDirectoryForHarness = path.resolve(
      requestedWorkingDirectoryForHarness ?? process.cwd(),
    );
    seededContext[RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY] =
      workingDirectoryForHarness;
    seededContext.repo = workingDirectoryForHarness;
  } else if (workspaceMode === "worktree") {
    if (requestedWorkingDirectoryForHarness) {
      throw new Error(
        "--working-directory-for-harness is not valid for workflows with run.workspace: worktree. Use --worktree-origin-repository and --worktree-origin-ref instead.",
      );
    }

    const originRepo = worktreeOriginRepository ?? process.cwd();
    let managedWorktree: ManagedRunWorktree;
    try {
      managedWorktree = createRunWorktree({
        runId,
        runNumber,
        workflowId,
        worktreeOriginRepository: originRepo,
        worktreeOriginRef,
      });
    } catch (err) {
      // createRunWorktree already marks the run_worktrees row as error internally.
      // Fail the run start before registering with the daemon.
      throw new Error(
        `Failed to create managed worktree for run: ${(err as Error).message}`,
      );
    }

    workingDirectoryForHarness = managedWorktree.worktreePath;
    seededContext[RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY] =
      managedWorktree.worktreePath;
    seededContext.repo = managedWorktree.worktreePath;
    seededContext.worktree_path = managedWorktree.worktreePath;
    seededContext.worktree_origin_repository =
      managedWorktree.worktreeOriginRepository;
    seededContext.worktree_origin_ref = managedWorktree.worktreeOriginRef;
    seededContext.worktree_origin_sha = managedWorktree.worktreeOriginSha;
    seededContext.original_branch = managedWorktree.originalBranch ?? "";
  } else {
    throw new Error(
      `Invalid run.workspace value: "${workspaceMode}". Expected "direct" or "worktree".`,
    );
  }

  let workingDirectoryStats;
  try {
    workingDirectoryStats = await fs.stat(workingDirectoryForHarness);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `working-directory-for-harness does not exist: ${workingDirectoryForHarness}`,
      );
    }
    throw err;
  }

  if (!workingDirectoryStats.isDirectory()) {
    throw new Error(
      `working-directory-for-harness must be a directory: ${workingDirectoryForHarness}`,
    );
  }

  const contextJson = JSON.stringify(seededContext);

  // Insert the run record. New runs start with
  // scheduling_status='pending_register' so the daemon control plane
  // (and/or reconciler) can admit them.
  db.prepare(
    `INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent,
                       scheduling_status, scheduling_requested_at, notify_url,
                       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, 0, 'pending_register', ?, ?, ?, ?)`,
  ).run(runId, runNumber, workflowId, taskTitle, contextJson, now, notifyUrl ?? null, now, now);

  // Insert step records for each workflow step
  const insertStep = db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', 0, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const stepDbId = crypto.randomUUID();
    const maxRetries = step.max_retries ?? 4;
    const stepType = step.type ?? "single";
    const loopConfig = step.loop ? JSON.stringify(step.loop) : null;
    const scopedAgentId = step.agent.startsWith(`${workflow.id}_`)
      ? step.agent
      : `${workflow.id}_${step.agent}`;

    insertStep.run(
      stepDbId,
      runId,
      step.id,
      scopedAgentId,
      i,
      step.input,
      step.expects,
      maxRetries,
      stepType,
      loopConfig,
      now,
      now,
    );
  }

  // Emit run.started event
  emitEvent({
    ts: now,
    event: "run.started",
    runId,
    workflowId,
    detail: `Run #${runNumber}: ${taskTitle}`,
  });

  // Promote the first step from 'waiting' to 'pending' so an agent can claim it.
  // Without this kickoff, claimStep (which only matches 'pending') would never find
  // the first step and the run would loop forever on peek=HAS_WORK / claim=NO_WORK.
  advancePipeline(runId);

  const registration = await registerRunWithDaemon(runId, 5000);
  if (!registration || registration.status < 200 || registration.status >= 300) {
    const message =
      typeof registration?.body.error === "string"
        ? registration.body.error
        : "daemon registration failed";
    db.prepare(
      "UPDATE runs SET scheduling_status = 'error', scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(message, runId);
    throw new Error(`Failed to register run with daemon: ${message}`);
  }

  return {
    runId,
    runNumber,
    workflowId,
    taskTitle,
    status: "running",
    stepCount: workflow.steps.length,
    workingDirectoryForHarness,
  };
}

export interface ResumeResult {
  status: "not_found" | "resumed";
  runId?: string;
  workflowId?: string;
  stepId?: string;
}

export async function resumeWorkflow(runId: string): Promise<ResumeResult> {
  const db = getDb();
  const run = db.prepare(
    "SELECT id, workflow_id, status, context FROM runs WHERE id = ? AND status = 'failed'",
  ).get(runId) as { id: string; workflow_id: string; status: string; context: string } | undefined;

  if (!run) return { status: "not_found" };

  await ensureDaemonControlAvailable();
  validateRunHarnessForScheduling(run.id, run.context);

  // Reset the run to running and request fresh scheduling admission.
  const resumeNow = new Date().toISOString();
  db.prepare(
    "UPDATE runs SET status = 'running', scheduling_status = 'pending_register', scheduling_requested_at = ?, scheduling_error = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(resumeNow, run.id);

  // Find the first failed step and reset it + subsequent steps
  const failedStep = db.prepare(
    "SELECT id, step_id, step_index FROM steps WHERE run_id = ? AND status = 'failed' ORDER BY step_index ASC LIMIT 1",
  ).get(run.id) as { id: string; step_id: string; step_index: number } | undefined;

  if (failedStep) {
    // Reset this step and all subsequent steps back to waiting
    db.prepare(
      "UPDATE steps SET status = 'waiting', retry_count = 0, output = NULL, updated_at = datetime('now') WHERE run_id = ? AND step_index >= ?",
    ).run(run.id, failedStep.step_index);
  }

  // Promote the next eligible waiting step to 'pending' so polling agents can claim it.
  advancePipeline(run.id);

  const registration = await registerRunWithDaemon(run.id, 5000);
  if (!registration || registration.status < 200 || registration.status >= 300) {
    const message =
      typeof registration?.body.error === "string"
        ? registration.body.error
        : "daemon registration failed";
    db.prepare(
      "UPDATE runs SET scheduling_status = 'error', scheduling_error = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(message, run.id);
    throw new Error(`Failed to register resumed run with daemon: ${message}`);
  }

  return { status: "resumed", runId: run.id, workflowId: run.workflow_id, stepId: failedStep?.step_id };
}
