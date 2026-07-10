import fs from "node:fs/promises";
import path from "node:path";
import { getDb } from "../db.js";
import { removeAgentCrons } from "./agent-scheduler.js";
import {
  resolveWorkflowDir,
  resolveWorkflowWorkspaceDir,
  resolveWorkflowRoot,
  resolveWorkflowWorkspaceRoot,
  resolvePiStateDir,
} from "./paths.js";

export interface UninstallResult {
  workflowId: string;
  removedDirs: string[];
  removedAgents: string[];
  errors: string[];
}

export interface ActiveRunInfo {
  id: string;
  task: string;
  status: string;
  createdAt: string;
}

/**
 * Uninstall a single workflow: remove its directories, agent entries, and cron jobs.
 * Refuses to uninstall if the workflow has active (running/paused) runs.
 */
export async function uninstallWorkflow(
  workflowId: string,
): Promise<UninstallResult> {
  const result: UninstallResult = {
    workflowId,
    removedDirs: [],
    removedAgents: [],
    errors: [],
  };

  // Check for active runs first
  const activeRuns = await checkActiveRuns(workflowId);
  if (activeRuns.length > 0) {
    const runIds = activeRuns.map((r) => r.id).join(", ");
    throw new Error(
      `Cannot uninstall workflow "${workflowId}" — ${activeRuns.length} active run(s): ${runIds}. Stop or cancel active runs first.`,
    );
  }

  // Remove cron jobs for this workflow
  try {
    await removeAgentCrons(workflowId);
  } catch (err) {
    result.errors.push(
      `Failed to remove cron jobs: ${(err as Error).message}`,
    );
  }

  // Remove workflow directory (~/.canarinho/workflows/<id>)
  const workflowDir = resolveWorkflowDir(workflowId);
  try {
    await fs.rm(workflowDir, { recursive: true, force: true });
    result.removedDirs.push(workflowDir);
  } catch (err) {
    result.errors.push(
      `Failed to remove workflow dir ${workflowDir}: ${(err as Error).message}`,
    );
  }

  // Remove workspace directories for this workflow's agents
  // Agent workspaces are under ~/.canarinho/workspaces/workflows/<workflowId>_<agentId>
  const workspaceRoot = resolveWorkflowWorkspaceRoot();
  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    const prefix = `${workflowId}_`;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        const wsDir = path.join(workspaceRoot, entry.name);
        try {
          await fs.rm(wsDir, { recursive: true, force: true });
          result.removedDirs.push(wsDir);
        } catch (err) {
          result.errors.push(
            `Failed to remove workspace ${wsDir}: ${(err as Error).message}`,
          );
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      result.errors.push(
        `Failed to scan workspace dir: ${(err as Error).message}`,
      );
    }
  }

  // Remove agent directories under ~/.canarinho/agents/<workflowId>_<agentId>
  const agentsRoot = path.join(resolvePiStateDir(), "agents");
  try {
    const entries = await fs.readdir(agentsRoot, { withFileTypes: true });
    const prefix = `${workflowId}_`;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        const agentDir = path.join(agentsRoot, entry.name);
        try {
          await fs.rm(agentDir, { recursive: true, force: true });
          result.removedDirs.push(agentDir);
          result.removedAgents.push(entry.name);
        } catch (err) {
          result.errors.push(
            `Failed to remove agent dir ${agentDir}: ${(err as Error).message}`,
          );
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      result.errors.push(
        `Failed to scan agents dir: ${(err as Error).message}`,
      );
    }
  }

  // Remove agent entries from agents.json
  await removeAgentsFromList(workflowId, result);

  return result;
}

/**
 * Uninstall all workflows — removes all workflow dirs, workspaces, agents, and crons.
 */
export async function uninstallAllWorkflows(): Promise<UninstallResult[]> {
  const results: UninstallResult[] = [];

  // Find all installed workflows by reading the workflows root dir
  const workflowRoot = resolveWorkflowRoot();
  let workflowIds: string[] = [];
  try {
    const entries = await fs.readdir(workflowRoot, { withFileTypes: true });
    workflowIds = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return results; // nothing installed
    throw err;
  }

  for (const wfId of workflowIds) {
    try {
      const result = await uninstallWorkflow(wfId);
      results.push(result);
    } catch (err) {
      results.push({
        workflowId: wfId,
        removedDirs: [],
        removedAgents: [],
        errors: [(err as Error).message],
      });
    }
  }

  return results;
}

/**
 * Check for active (running or paused) runs. Optionally scoped to a workflow.
 */
export async function checkActiveRuns(
  workflowId?: string,
): Promise<ActiveRunInfo[]> {
  const db = getDb();

  let rows: Array<{
    id: string;
    task: string;
    status: string;
    created_at: string;
  }>;

  if (workflowId) {
    rows = db
      .prepare(
        "SELECT id, task, status, created_at FROM runs WHERE workflow_id = ? AND status IN ('running', 'paused')",
      )
      .all(workflowId) as Array<{
        id: string;
        task: string;
        status: string;
        created_at: string;
      }>;
  } else {
    rows = db
      .prepare(
        "SELECT id, task, status, created_at FROM runs WHERE status IN ('running', 'paused')",
      )
      .all() as Array<{
        id: string;
        task: string;
        status: string;
        created_at: string;
      }>;
  }

  return rows.map((r) => ({
    id: r.id,
    task: r.task,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/**
 * Remove agent entries from ~/.canarinho/agents.json for a given workflow.
 */
async function removeAgentsFromList(
  workflowId: string,
  result: UninstallResult,
): Promise<void> {
  const agentsPath = path.join(resolvePiStateDir(), "agents.json");
  try {
    const raw = await fs.readFile(agentsPath, "utf-8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;

    const prefix = `${workflowId}_`;
    const filtered = list.filter(
      (entry: Record<string, unknown>) =>
        typeof entry.id === "string" && !entry.id.startsWith(prefix),
    );

    if (filtered.length < list.length) {
      const content = `${JSON.stringify(filtered, null, 2)}\n`;
      await fs.writeFile(agentsPath, content, "utf-8");
      result.removedAgents.push(
        ...list
          .filter(
            (e: Record<string, unknown>) =>
              typeof e.id === "string" && (e.id as string).startsWith(prefix),
          )
          .map((e: Record<string, unknown>) => e.id as string),
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return; // no agents file — nothing to clean
    result.errors.push(
      `Failed to update agents.json: ${(err as Error).message}`,
    );
  }
}
