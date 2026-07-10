import fs from "node:fs/promises";
import path from "node:path";
import { writeWorkflowFile } from "./workspace-files.js";
import {
  resolveWorkflowWorkspaceDir,
  resolvePiStateDir,
} from "./paths.js";
import type { WorkflowAgent, WorkflowSpec } from "./types.js";

export interface ProvisionedAgent {
  id: string;
  name?: string;
  model?: string;
  timeoutSeconds?: number;
  workspaceDir: string;
  agentDir: string;
}

export interface ProvisionAgentsParams {
  workflow: WorkflowSpec;
  workflowDir: string;
  bundledSourceDir?: string;
  overwriteFiles?: boolean;
}

/**
 * Provision agent workspaces and agent directories for all agents in a workflow.
 *
 * For each agent:
 * 1. Creates a workspace directory under ~/.canarinho/workspaces/workflows/<workflowId>/
 * 2. Copies agent persona files (AGENTS.md, IDENTITY.md, SOUL.md) from the workflow dir
 * 3. Creates an agent directory under ~/.canarinho/agents/<agentId>/
 * 4. Installs workflow skills if the agent defines any
 *
 * Returns an array of ProvisionedAgent descriptors with workspace and agent dir paths.
 */
export async function provisionAgents(
  params: ProvisionAgentsParams,
): Promise<ProvisionedAgent[]> {
  const { workflow, workflowDir, bundledSourceDir, overwriteFiles = false } = params;
  const results: ProvisionedAgent[] = [];

  for (const agent of workflow.agents) {
    const provisioned = await provisionSingleAgent({
      workflow,
      agent,
      workflowDir,
      bundledSourceDir,
      overwriteFiles,
    });
    results.push(provisioned);
  }

  return results;
}

async function provisionSingleAgent(params: {
  workflow: WorkflowSpec;
  agent: WorkflowAgent;
  workflowDir: string;
  bundledSourceDir?: string;
  overwriteFiles: boolean;
}): Promise<ProvisionedAgent> {
  const { workflow, agent, workflowDir, bundledSourceDir, overwriteFiles } = params;

  // Build the canarinho-scoped agent id: workflowId + "_" + localAgentId
  const canarinhoAgentId = `${workflow.id}_${agent.id}`;

  // ── Workspace directory ──────────────────────────────────────────
  const workspaceDir = resolveWorkflowWorkspaceDir(canarinhoAgentId);
  await fs.mkdir(workspaceDir, { recursive: true });

  // ── Agent directory (under ~/.canarinho/agents/) ─────────────────
  const agentsRoot = path.join(resolvePiStateDir(), "agents");
  const agentDir = path.join(agentsRoot, canarinhoAgentId);
  await fs.mkdir(agentDir, { recursive: true });

  // ── Copy persona files ──────────────────────────────────────────
  // Agent files are stored under the workflow directory, in a subdirectory
  // matching the agent's workspace baseDir (or the agent id if not specified).
  const agentSourceDir = path.join(
    workflowDir,
    agent.workspace.baseDir || agent.id,
  );

  const personaFiles = ["AGENTS.md", "IDENTITY.md", "SOUL.md"];
  for (const fileName of personaFiles) {
    const sourcePath = path.join(agentSourceDir, fileName);
    const destPath = path.join(workspaceDir, fileName);

    // Only copy if the source file exists
    try {
      await fs.stat(sourcePath);
      await writeWorkflowFile({
        source: sourcePath,
        destination: destPath,
        overwrite: overwriteFiles,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") continue; // file doesn't exist — skip
      throw err;
    }
  }

  // ── Copy any custom files from the agent's workspace definition ──
  // Source paths in `workspace.files` are resolved against the workflow root
  // so that values like `agents/developer/AGENTS.md` (local) and
  // `../../agents/shared/verifier/AGENTS.md` (escaping out to a repo-shared
  // dir) both work. Try the bundled source dir first (where shared `../..`
  // paths can resolve into the original repo tree), then the copied workflow
  // dir (the runtime location), then the per-agent source dir for legacy
  // YAMLs that authored paths relative to the agent.
  if (agent.workspace.files) {
    const candidateBases = [bundledSourceDir, workflowDir, agentSourceDir].filter(
      (b): b is string => Boolean(b),
    );
    for (const [destFileName, srcFileName] of Object.entries(agent.workspace.files)) {
      const destPath = path.join(workspaceDir, destFileName);
      let copied = false;
      for (const base of candidateBases) {
        const sourcePath = path.resolve(base, srcFileName);
        try {
          await fs.stat(sourcePath);
          await writeWorkflowFile({
            source: sourcePath,
            destination: destPath,
            overwrite: overwriteFiles,
          });
          copied = true;
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") continue;
          throw err;
        }
      }
      // If no candidate base resolved, silently skip — matches previous
      // best-effort behavior for missing optional persona files.
      void copied;
    }
  }

  // ── Install skills if present ───────────────────────────────────
  if (agent.workspace.skills && agent.workspace.skills.length > 0) {
    await installAgentSkills({
      agentId: canarinhoAgentId,
      agentDir,
      skills: agent.workspace.skills,
      workflowDir,
      bundledSourceDir,
      agentSourceDir,
    });
  }

  return {
    id: canarinhoAgentId,
    name: agent.name,
    model: agent.model,
    timeoutSeconds: agent.timeoutSeconds,
    workspaceDir,
    agentDir,
  };
}

/**
 * Install workflow-defined skills for an agent.
 *
 * Skills can be:
 * 1. Local files in the workflow dir (copied to agent's skills/ directory)
 * 2. Named skills that exist in a shared skills directory
 *
 * Skills are stored under ~/.canarinho/agents/<agentId>/skills/
 */
async function installAgentSkills(params: {
  agentId: string;
  agentDir: string;
  skills: string[];
  workflowDir: string;
  bundledSourceDir?: string;
  agentSourceDir: string;
}): Promise<void> {
  const { agentDir, skills, workflowDir, bundledSourceDir, agentSourceDir } = params;
  const skillsDir = path.join(agentDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });

  for (const skill of skills) {
    // Check if the skill is a local directory/file in the workflow
    const localSkillDir = path.join(agentSourceDir, "skills", skill);
    try {
      const stat = await fs.stat(localSkillDir);
      if (stat.isDirectory()) {
        const destSkillDir = path.join(skillsDir, skill);
        await copyDirContents(localSkillDir, destSkillDir);
        continue;
      }
    } catch {
      // Not a local directory — might be a file or a named skill
    }

    // Check if it's a single skill file
    const localSkillFile = path.join(agentSourceDir, "skills", `${skill}.md`);
    try {
      await fs.stat(localSkillFile);
      const destSkillFile = path.join(skillsDir, `${skill}.md`);
      await fs.copyFile(localSkillFile, destSkillFile);
      continue;
    } catch {
      // Not found locally either
    }

    const sharedSkillDirs = resolveSharedSkillDirs({
      workflowDir,
      bundledSourceDir,
      skill,
    });
    let copiedSharedSkill = false;
    for (const sharedSkillDir of sharedSkillDirs) {
      try {
        const stat = await fs.stat(sharedSkillDir);
        if (!stat.isDirectory()) continue;

        const destSkillDir = path.join(skillsDir, skill);
        await copyDirContents(sharedSkillDir, destSkillDir);
        copiedSharedSkill = true;
        break;
      } catch {
        // Try next shared-skill location candidate.
      }
    }

    if (copiedSharedSkill) continue;
  }
}

/**
 * Resolve candidate directories for bundled shared skills.
 */
function resolveSharedSkillDirs(params: {
  workflowDir: string;
  bundledSourceDir?: string;
  skill: string;
}): string[] {
  const { workflowDir, bundledSourceDir, skill } = params;
  const candidates = new Set<string>();

  // Backward-compatible location for ad-hoc installs where skills sit next to workflows.
  candidates.add(path.join(workflowDir, "..", "skills", skill));

  // Bundled canarinho workflows live under <repo>/workflows/<workflowId> while shared skills
  // live under <repo>/skills/<skill>; walk up two levels from the bundled workflow source.
  if (bundledSourceDir) {
    candidates.add(path.resolve(bundledSourceDir, "..", "..", "skills", skill));
  }

  return [...candidates];
}

/**
 * Recursively copy all files and directories from src to dest.
 */
async function copyDirContents(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDirContents(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
