import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY = "working_directory_for_harness";

export interface HarnessValidationResult {
  workingDirectoryForHarness: string;
  expectedBranch?: string;
}

function parseRunContext(contextRaw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(contextRaw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  throw new Error("run context is not valid JSON");
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readCurrentGitBranch(workdir: string): string {
  const result = spawnSync("git", ["-C", workdir, "branch", "--show-current"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `cannot read git branch at harness workdir ${workdir}${stderr ? `: ${stderr}` : ""}`,
    );
  }

  return result.stdout.trim();
}

export function validateRunHarnessForScheduling(
  runId: string,
  contextRaw: string,
): HarnessValidationResult {
  const context = parseRunContext(contextRaw);
  const rawWorkdir = readNonEmptyString(context, RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY);

  if (!rawWorkdir) {
    throw new Error(
      `Run ${runId} is missing ${RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY}; refusing to schedule without an explicit harness workdir`,
    );
  }

  if (!path.isAbsolute(rawWorkdir)) {
    throw new Error(
      `Run ${runId} has a relative harness workdir (${rawWorkdir}); refusing to schedule because resume must not depend on daemon cwd`,
    );
  }

  const workingDirectoryForHarness = path.resolve(rawWorkdir);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(workingDirectoryForHarness);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Run ${runId} harness workdir does not exist: ${workingDirectoryForHarness}`,
      );
    }
    throw err;
  }

  if (!stats.isDirectory()) {
    throw new Error(
      `Run ${runId} harness workdir is not a directory: ${workingDirectoryForHarness}`,
    );
  }

  const expectedBranch = readNonEmptyString(context, "branch");
  if (expectedBranch) {
    const actualBranch = readCurrentGitBranch(workingDirectoryForHarness);
    if (actualBranch !== expectedBranch) {
      throw new Error(
        `Run ${runId} harness branch mismatch at ${workingDirectoryForHarness}: expected ${expectedBranch}, got ${actualBranch || "<detached>"}`,
      );
    }
  }

  return { workingDirectoryForHarness, expectedBranch };
}
