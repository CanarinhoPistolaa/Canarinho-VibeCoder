import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  resolveBundledWorkflowsDir,
  resolveBundledWorkflowDir,
  resolveWorkflowDir,
} from "./paths.js";

/**
 * Copy a bundled workflow from the canarinho source checkout to ~/.canarinho/workflows/.
 * Returns the target workflow directory and the bundled source directory.
 */
export async function fetchWorkflow(
  workflowId: string,
): Promise<{ workflowDir: string; bundledSourceDir: string }> {
  const bundledSourceDir = resolveBundledWorkflowDir(workflowId);
  const workflowDir = resolveWorkflowDir(workflowId);

  // Verify the bundled source exists
  try {
    const stat = await fs.stat(bundledSourceDir);
    if (!stat.isDirectory()) {
      throw new Error(`Bundled workflow "${workflowId}" is not a directory`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `Bundled workflow "${workflowId}" not found. Available workflows: ${(await listBundledWorkflows()).join(", ") || "(none)"}`,
      );
    }
    throw err;
  }

  // Create the target directory
  await fs.mkdir(workflowDir, { recursive: true });

  // Recursively copy all files from bundled source to target
  await copyDirContents(bundledSourceDir, workflowDir);

  return { workflowDir, bundledSourceDir };
}

/**
 * List all bundled workflow IDs (directory names under the bundled workflows dir).
 */
export async function listBundledWorkflows(): Promise<string[]> {
  const dir = resolveBundledWorkflowsDir();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Extract the first sentence (up to and including the first period, exclamation
 * mark, or question mark) from a workflow's description field and return it
 * trimmed. Falls back to the workflow ID when the YAML is missing, unparseable,
 * or has no description.
 */
export async function getWorkflowShortDescription(
  workflowId: string,
): Promise<string> {
  const dir = resolveBundledWorkflowDir(workflowId);
  const ymlPath = path.join(dir, "workflow.yml");

  let raw: string;
  try {
    raw = await fs.readFile(ymlPath, "utf-8");
  } catch {
    return workflowId;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return workflowId;
  }

  if (!parsed || typeof parsed !== "object") {
    return workflowId;
  }

  const description = (parsed as Record<string, unknown>).description;
  if (typeof description !== "string" || !description.trim()) {
    return workflowId;
  }

  const desc = description.trim();
  // Split on the first sentence-ending punctuation followed by whitespace or end-of-string.
  const match = desc.match(/^(.+?[.!?])(\s|$)/);
  if (match) {
    // If the first sentence contains a newline within it, it is multi-line.
    // Keep the trimmed first line / sentence as-is.
    return match[1].trim().replace(/\s+/g, " ");
  }

  // No sentence-ending punctuation found; return the whole description trimmed.
  return desc.replace(/\s+/g, " ");
}

/**
 * Recursively copy all files and directories from src to dest,
 * OVERWRITING existing files.
 *
 * Workflow definitions are owned by the bundled source: installs and
 * `canarinho update` must deliver the current definitions, not freeze the
 * copy made at first install. (The previous "fetch once" skip-existing
 * semantic silently pinned every user to the workflow YAML of their first
 * install — shipped workflow fixes never arrived, and update's
 * "installed <workflow>" output was a no-op for existing installs.)
 * Users who customize workflows should copy them under a new id; installed
 * bundled ids are refreshed on every install.
 */
async function copyDirContents(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDirContents(srcPath, destPath);
    } else {
      // Remove the destination first: worktree-variant workflows ship
      // symlinked agent dirs (e.g. agents/fixer -> ../../bug-fix-merge/...),
      // and fs.cp onto an existing symlink dereferences into a self-copy
      // EINVAL. Removing the link (not its target — rm does not follow
      // symlinks) lets cp recreate it; cp's default non-verbatim mode
      // resolves relative link targets to absolute source paths, matching
      // what first-time installs have always produced.
      await fs.rm(destPath, { recursive: true, force: true });
      await fs.cp(srcPath, destPath, { force: true });
    }
  }
}
