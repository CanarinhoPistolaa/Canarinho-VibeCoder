import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundled workflows ship with canarinho (in the repo's workflows/ directory)
export function resolveBundledWorkflowsDir(): string {
  // From dist/installer/paths.js -> ../../workflows
  return path.resolve(__dirname, "..", "..", "workflows");
}

export function resolveSourcePath(): string {
  // From dist/installer/paths.js -> ../.. (the checkout/package root)
  const sourcePath = path.resolve(__dirname, "..", "..");
  try {
    return fs.realpathSync(sourcePath);
  } catch {
    return sourcePath;
  }
}

export function resolveSkillPath(): string {
  // From dist/installer/paths.js -> ../../skills/canarinho-agents/SKILL.md
  const skillPath = path.resolve(__dirname, "..", "..", "skills", "canarinho-agents", "SKILL.md");
  try {
    return fs.realpathSync(skillPath);
  } catch {
    return skillPath;
  }
}

export function resolveBundledWorkflowDir(workflowId: string): string {
  return path.join(resolveBundledWorkflowsDir(), workflowId);
}

export function resolvePiStateDir(): string {
  const env = process.env.canarinho_STATE_DIR?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".canarinho");
}

export function resolvePiConfigPath(): string {
  const env = process.env.PI_SETTINGS_PATH?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function resolvePiAuthPath(): string {
  const env = process.env.PI_AUTH_PATH?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

export function resolvecanarinhoRoot(): string {
  return resolvePiStateDir();
}

export function resolveWorkflowRoot(): string {
  return path.join(resolvecanarinhoRoot(), "workflows");
}

export function resolveWorkflowDir(workflowId: string): string {
  return path.join(resolveWorkflowRoot(), workflowId);
}

export function resolveWorkflowWorkspaceRoot(): string {
  return path.join(resolvecanarinhoRoot(), "workspaces", "workflows");
}

export function resolveWorkflowWorkspaceDir(workflowId: string): string {
  return path.join(resolveWorkflowWorkspaceRoot(), workflowId);
}

export function resolveRunRoot(): string {
  return path.join(resolvecanarinhoRoot(), "runs");
}

export function resolvecanarinhoCli(): string {
  // From dist/installer/paths.js -> ../../bin/canarinho. Use the shell
  // launcher rather than dist/cli/cli.js so Node runtime flags stay centralized.
  return path.resolve(__dirname, "..", "..", "bin", "canarinho");
}
