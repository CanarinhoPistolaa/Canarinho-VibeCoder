export interface WorkflowRunArgs {
  taskTitle: string;
  workingDirectoryForHarness?: string;
  worktreeOriginRepository?: string;
  worktreeOriginRef?: string;
  noHurrySaveTokensMode?: boolean;
  noRelaunchUponRugpull?: boolean;
  harnessAs?: "pi" | "hermes";
  /** Key-value pairs injected as run template context */
  context: Record<string, string>;
}

export function parseWorkflowRunArgs(args: string[]): WorkflowRunArgs {
  const taskParts: string[] = [];
  let workingDirectoryForHarness: string | undefined;
  let worktreeOriginRepository: string | undefined;
  let worktreeOriginRef: string | undefined;
  let noHurrySaveTokensMode: boolean | undefined;
  let noRelaunchUponRugpull: boolean | undefined;
  let harnessAs: "pi" | "hermes" | undefined;
  const context: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--no-hurry-please-save-tokens-mode") {
      noHurrySaveTokensMode = true;
      continue;
    }

    if (token === "--no-relaunch-upon-rugpull") {
      noRelaunchUponRugpull = true;
      continue;
    }

    if (token === "--pi-as-harness") {
      if (harnessAs !== undefined) {
        throw new Error(
          "Cannot specify both --pi-as-harness and --hermes-as-harness. Choose one harness.",
        );
      }
      harnessAs = "pi";
      continue;
    }

    if (token === "--hermes-as-harness") {
      if (harnessAs !== undefined) {
        throw new Error(
          "Cannot specify both --pi-as-harness and --hermes-as-harness. Choose one harness.",
        );
      }
      harnessAs = "hermes";
      continue;
    }

    if (token === "--working-directory-for-harness") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      i++;
      continue;
    }

    const inlinePrefix = "--working-directory-for-harness=";
    if (token.startsWith(inlinePrefix)) {
      const value = token.slice(inlinePrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      continue;
    }

    if (token === "--worktree-origin-repository") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-repository.");
      }
      worktreeOriginRepository = value;
      i++;
      continue;
    }

    const wtRepoPrefix = "--worktree-origin-repository=";
    if (token.startsWith(wtRepoPrefix)) {
      const value = token.slice(wtRepoPrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-repository.");
      }
      worktreeOriginRepository = value;
      continue;
    }

    if (token === "--worktree-origin-ref") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-ref.");
      }
      worktreeOriginRef = value;
      i++;
      continue;
    }

    const wtRefPrefix = "--worktree-origin-ref=";
    if (token.startsWith(wtRefPrefix)) {
      const value = token.slice(wtRefPrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-ref.");
      }
      worktreeOriginRef = value;
      continue;
    }

    if (token === "--context") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --context. Expected format: --context key=value");
      }
      const eqIdx = value.indexOf("=");
      if (eqIdx === -1) {
        throw new Error(`Invalid --context value "${value}": expected key=value format (must contain '=')`);
      }
      const key = value.slice(0, eqIdx);
      const val = value.slice(eqIdx + 1);
      if (key.length === 0) {
        throw new Error(`Invalid --context value "${value}": key must be non-empty`);
      }
      if (key in context) {
        throw new Error(`Duplicate --context key "${key}": each key may only be specified once`);
      }
      context[key] = val;
      i++;
      continue;
    }

    taskParts.push(token);
  }

  return {
    taskTitle: taskParts.join(" ").trim(),
    workingDirectoryForHarness,
    worktreeOriginRepository,
    worktreeOriginRef,
    noHurrySaveTokensMode,
    noRelaunchUponRugpull,
    harnessAs,
    context,
  };
}
