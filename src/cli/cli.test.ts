import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkflowRunArgs } from "../../dist/cli/workflow-run-args.js";

function makeTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cli-test-"));
  const stateDir = path.join(tmpDir, "state");
  const homeDir = path.join(tmpDir, "home");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(homeDir);
  return { tmpDir, stateDir, homeDir };
}

function cli(args: string[], env?: Record<string, string>) {
  const wrapperPath = path.resolve("bin/tamandua");
  const testEnv = makeTestEnv();
  try {
    const result = spawnSync("/bin/sh", [wrapperPath, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: testEnv.homeDir,
        TAMANDUA_STATE_DIR: testEnv.stateDir,
        ...env,
      },
    });
    return { ...result, testEnv };
  } catch (err) {
    fs.rmSync(testEnv.tmpDir, { recursive: true, force: true });
    throw err;
  }
}

describe("parseWorkflowRunArgs", () => {
  it("parses task title from positional args (no flags)", () => {
    const result = parseWorkflowRunArgs(["Implement", "a thing"]);
    assert.deepEqual(result, {
      taskTitle: "Implement a thing",
      workingDirectoryForHarness: undefined,
      worktreeOriginRepository: undefined,
      worktreeOriginRef: undefined,
      noHurrySaveTokensMode: undefined,
    });
  });

  it("parses --no-hurry-please-save-tokens-mode as a boolean flag", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "do something",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noHurrySaveTokensMode, true);
  });

  it("parses --no-hurry-please-save-tokens-mode alongside other flags", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--working-directory-for-harness",
      "/some/dir",
      "build the frontend",
    ]);
    assert.equal(result.taskTitle, "build the frontend");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.workingDirectoryForHarness, "/some/dir");
  });

  it("flag not set when absent", () => {
    const result = parseWorkflowRunArgs([
      "--working-directory-for-harness",
      "/tmp",
      "task here",
    ]);
    assert.equal(result.noHurrySaveTokensMode, undefined);
    assert.equal(result.workingDirectoryForHarness, "/tmp");
    assert.equal(result.taskTitle, "task here");
  });

  it("parses all flags together with save-tokens-mode", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--worktree-origin-repository",
      "/repo",
      "--worktree-origin-ref",
      "main",
      "--working-directory-for-harness",
      "/work",
      "do the task",
    ]);
    assert.equal(result.taskTitle, "do the task");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.worktreeOriginRepository, "/repo");
    assert.equal(result.worktreeOriginRef, "main");
    assert.equal(result.workingDirectoryForHarness, "/work");
  });

  it("save-tokens-mode at end of args", () => {
    const result = parseWorkflowRunArgs([
      "do something",
      "--no-hurry-please-save-tokens-mode",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noHurrySaveTokensMode, true);
  });

  it("parses --working-directory-for-harness=VALUE inline form", () => {
    const result = parseWorkflowRunArgs([
      "--working-directory-for-harness=/some/path",
      "task",
    ]);
    assert.equal(result.taskTitle, "task");
    assert.equal(result.workingDirectoryForHarness, "/some/path");
  });

  it("throws when inline --working-directory-for-harness= has empty value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--working-directory-for-harness=", "task"]),
      /Missing value for --working-directory-for-harness/i,
    );
  });

  it("parses --worktree-origin-repository=VALUE inline form", () => {
    const result = parseWorkflowRunArgs([
      "--worktree-origin-repository=/repo/path",
      "task",
    ]);
    assert.equal(result.taskTitle, "task");
    assert.equal(result.worktreeOriginRepository, "/repo/path");
  });

  it("throws when inline --worktree-origin-repository= has empty value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--worktree-origin-repository=", "task"]),
      /Missing value for --worktree-origin-repository/i,
    );
  });

  it("parses --worktree-origin-ref=VALUE inline form", () => {
    const result = parseWorkflowRunArgs([
      "--worktree-origin-ref=main",
      "task",
    ]);
    assert.equal(result.taskTitle, "task");
    assert.equal(result.worktreeOriginRef, "main");
  });

  it("throws when inline --worktree-origin-ref= has empty value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--worktree-origin-ref=", "task"]),
      /Missing value for --worktree-origin-ref/i,
    );
  });

  it("throws when --working-directory-for-harness has missing value (separate form)", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["--working-directory-for-harness"]),
      /Missing value for --working-directory-for-harness/i,
    );
  });

  it("handles inline form with no additional task args", () => {
    const result = parseWorkflowRunArgs(["--working-directory-for-harness=/tmp"]);
    assert.equal(result.taskTitle, "");
    assert.equal(result.workingDirectoryForHarness, "/tmp");
  });
});

describe("CLI entrypoint regression: no ExperimentalWarning", () => {
  it("should not emit SQLite ExperimentalWarning when invoked through bin/tamandua wrapper", () => {
    const result = cli(["version"]);
    try {
      const stderr = result.stderr ?? "";
      const stdout = result.stdout ?? "";

      assert.doesNotMatch(stderr, /ExperimentalWarning/);
      assert.doesNotMatch(stdout, /ExperimentalWarning/);
      assert.match(stdout, /^tamandua v/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("CLI entrypoint", () => {
  it("runs when invoked through a symlink", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cli-test-"));
    const stateDir = path.join(tmpDir, "state");
    const homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(homeDir);

    try {
      const cliPath = path.resolve("dist/cli/cli.js");
      const symlinkPath = path.join(tmpDir, "tamandua");
      fs.symlinkSync(cliPath, symlinkPath);

      const output = execFileSync(symlinkPath, ["version"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: homeDir,
          TAMANDUA_STATE_DIR: stateDir,
        },
      });

      assert.match(output, /^tamandua v/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("--help infrastructure", () => {
  it("tamandua --help prints usage and exits 0", () => {
    const result = cli(["--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua install/);
      assert.match(result.stdout ?? "", /tamandua update/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua -h prints usage and exits 0 (shorthand)", () => {
    const result = cli(["-h"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("command with --help prints usage and exits 0", () => {
    const result = cli(["step", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("--help suppresses update warning on stderr", () => {
    const result = cli(["--help"]);
    try {
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stderr ?? "", /WARNING: A new version/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("--help does not execute the command (no side effects)", () => {
    // Using a command that would normally require state/files
    const result = cli(["workflow", "run", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Start a new workflow run/);
      // Should not produce error about missing workflow name
      assert.doesNotMatch(result.stderr ?? "", /Missing workflow name/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("--help works regardless of position in args", () => {
    const result = cli(["--help", "workflow", "run"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua tamandua --help shows help about the ant easter egg", () => {
    const result = cli(["tamandua", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /ASCII art easter egg/);
      assert.match(result.stdout ?? "", /tamandua tamandua/);
      assert.match(result.stdout ?? "", /randomly selected tamandua-themed quote/);
      // Should NOT contain global usage
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua version --help shows help about version display", () => {
    const result = cli(["version", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Display installed version/);
      assert.match(result.stdout ?? "", /tamandua version/);
      assert.match(result.stdout ?? "", /tamandua --version/);
      assert.match(result.stdout ?? "", /tamandua -v/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua --version --help shows version help (alias)", () => {
    const result = cli(["--version", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Display installed version/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua -v --help shows version help (shorthand alias)", () => {
    const result = cli(["-v", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Display installed version/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua skill-path --help shows help about skill path resolution", () => {
    const result = cli(["skill-path", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Print path to bundled tamandua-agents skill/);
      assert.match(result.stdout ?? "", /AGENTS\.md/);
      assert.match(result.stdout ?? "", /IDENTITY\.md/);
      assert.match(result.stdout ?? "", /SOUL\.md/);
      assert.match(result.stdout ?? "", /provisioned to workflow agents/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua source-path --help shows help about source path resolution", () => {
    const result = cli(["source-path", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Print Tamandua source checkout path/);
      assert.match(result.stdout ?? "", /dist\//);
      assert.match(result.stdout ?? "", /package\.json/);
      assert.match(result.stdout ?? "", /build-and-install/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("existing commands still work when --help is NOT passed", () => {
    const result = cli(["version"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /^tamandua v/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-003: update, install, uninstall
  it("tamandua update --help shows detailed 12-step explanation", () => {
    const result = cli(["update", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /local source maintenance/);
      assert.match(result.stdout ?? "", /not a package-manager update/);
      // Step-by-step detail
      assert.match(result.stdout ?? "", /1\. Resolves the installed/);
      assert.match(result.stdout ?? "", /2\. Reads current git HEAD/);
      assert.match(result.stdout ?? "", /3\. Runs git pull/);
      assert.match(result.stdout ?? "", /4\. Reads git HEAD again/);
      assert.match(result.stdout ?? "", /5\. If HEAD did not change/);
      assert.match(result.stdout ?? "", /6\. If HEAD changed/);
      assert.match(result.stdout ?? "", /7\. Takes a snapshot/);
      assert.match(result.stdout ?? "", /8\. Checks for active runs/);
      assert.match(result.stdout ?? "", /9\. If active runs exist/);
      assert.match(result.stdout ?? "", /10\. Otherwise, it stops/);
      assert.match(result.stdout ?? "", /11\. Installs every bundled/);
      assert.match(result.stdout ?? "", /12\. Restarts only the services/);
      // --force documented
      assert.match(result.stdout ?? "", /--force/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua install --help explains workflow installation and dashboard startup", () => {
    const result = cli(["install", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Install all bundled workflows/);
      assert.match(result.stdout ?? "", /CLI symlink/);
      assert.match(result.stdout ?? "", /starts it on the default port/);
      assert.match(result.stdout ?? "", /registers agents/);
      assert.match(result.stdout ?? "", /MCP server/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua update/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua uninstall --help explains service shutdown and workflow removal", () => {
    const result = cli(["uninstall", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Fully remove Tamandua workflows/);
      assert.match(result.stdout ?? "", /Stops the dashboard daemon/);
      assert.match(result.stdout ?? "", /Stops the standalone MCP/);
      assert.match(result.stdout ?? "", /removes every installed/);
      assert.match(result.stdout ?? "", /agent workspaces/);
      assert.match(result.stdout ?? "", /cron jobs/);
      assert.match(result.stdout ?? "", /--force/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua update/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua update shows --force flag behavior in help", () => {
    const result = cli(["update", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /--force\s+Continue update despite active runs/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua uninstall shows --force flag behavior in help", () => {
    const result = cli(["uninstall", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /--force\s+Skip the active-runs check/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-004: step subcommand help
  it("tamandua step peek --help shows HAS_WORK/NO_WORK output and --run-id", () => {
    const result = cli(["step", "peek", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Check for pending work/);
      assert.match(result.stdout ?? "", /HAS_WORK/);
      assert.match(result.stdout ?? "", /NO_WORK/);
      assert.match(result.stdout ?? "", /--run-id/);
      assert.match(result.stdout ?? "", /agent-id/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step claim --help shows JSON output and --run-id", () => {
    const result = cli(["step", "claim", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Atomically claim a pending step/);
      assert.match(result.stdout ?? "", /"stepId"/);
      assert.match(result.stdout ?? "", /"runId"/);
      assert.match(result.stdout ?? "", /"input"/);
      assert.match(result.stdout ?? "", /--run-id/);
      assert.match(result.stdout ?? "", /NO_WORK/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step complete --help shows stdin input format", () => {
    const result = cli(["step", "complete", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Mark a step as done/);
      assert.match(result.stdout ?? "", /STATUS: done/);
      assert.match(result.stdout ?? "", /CHANGES:/);
      assert.match(result.stdout ?? "", /TESTS:/);
      assert.match(result.stdout ?? "", /stdin/);
      assert.match(result.stdout ?? "", /EOF/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step fail --help shows retry behavior", () => {
    const result = cli(["step", "fail", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Mark a step as failed/);
      assert.match(result.stdout ?? "", /retry logic/);
      assert.match(result.stdout ?? "", /escalated/);
      assert.match(result.stdout ?? "", /Unknown error/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step stories --help shows story status display", () => {
    const result = cli(["step", "stories", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /List all stories/);
      assert.match(result.stdout ?? "", /US-001/);
      assert.match(result.stdout ?? "", /done/);
      assert.match(result.stdout ?? "", /pending/);
      assert.match(result.stdout ?? "", /retry/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua step --help (no known subcommand) falls back to global usage", () => {
    const result = cli(["step", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-005: mcp, dashboard, control-plane help
  it("tamandua mcp --help shows help for all MCP subcommands", () => {
    const result = cli(["mcp", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage the standalone MCP HTTP server/);
      assert.match(result.stdout ?? "", /start.*--port/);
      assert.match(result.stdout ?? "", /stop/);
      assert.match(result.stdout ?? "", /status/);
      assert.match(result.stdout ?? "", /3338/);
      assert.match(result.stdout ?? "", /\/mcp/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua dashboard --help shows help for all dashboard subcommands", () => {
    const result = cli(["dashboard", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage the web dashboard daemon/);
      assert.match(result.stdout ?? "", /start.*--port/);
      assert.match(result.stdout ?? "", /stop/);
      assert.match(result.stdout ?? "", /status/);
      assert.match(result.stdout ?? "", /3334/);
      assert.match(result.stdout ?? "", /MCP server/);
      assert.match(result.stdout ?? "", /monitoring workflow runs/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua control-plane --help shows help for all control-plane subcommands", () => {
    const result = cli(["control-plane", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage the control plane server/);
      assert.match(result.stdout ?? "", /start.*--port/);
      assert.match(result.stdout ?? "", /stop/);
      assert.match(result.stdout ?? "", /status/);
      assert.match(result.stdout ?? "", /3339/);
      assert.match(result.stdout ?? "", /scheduling API/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua mcp start --help shows specific help for the start subcommand", () => {
    const result = cli(["mcp", "start", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Start the standalone MCP HTTP server/);
      assert.match(result.stdout ?? "", /--port/);
      assert.match(result.stdout ?? "", /default: 3338/);
      assert.match(result.stdout ?? "", /already running/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("--port flag is documented in mcp start command help", () => {
    const result = cli(["mcp", "start", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /--port N\s+Port to listen on \(default: 3338\)/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-006: logs and logs-tail help
  it("tamandua logs --help shows selector syntax (run-id, #run-number, line count)", () => {
    const result = cli(["logs", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Show recent activity events/);
      assert.match(result.stdout ?? "", /run-id.*prefix/);
      assert.match(result.stdout ?? "", /#<N>/);
      assert.match(result.stdout ?? "", /last 50/);
      assert.match(result.stdout ?? "", /tamandua logs 20/);
      assert.match(result.stdout ?? "", /tamandua logs abc123/);
      assert.match(result.stdout ?? "", /tamandua logs #3/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua logs-tail --help explains real-time following and SIGINT to stop", () => {
    const result = cli(["logs-tail", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Follow activity events in real-time/);
      assert.match(result.stdout ?? "", /SIGINT/);
      assert.match(result.stdout ?? "", /polling for new events/);
      assert.match(result.stdout ?? "", /TAMANDUA_LOGS_TAIL_POLL_MS/);
      assert.match(result.stdout ?? "", /tamandua logs-tail 20/);
      assert.match(result.stdout ?? "", /tamandua logs-tail abc123/);
      assert.match(result.stdout ?? "", /tamandua logs-tail #3/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-007: worktree commands help
  it("tamandua worktree --help shows all subcommands", () => {
    const result = cli(["worktree", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage git worktrees for workflow runs/);
      assert.match(result.stdout ?? "", /list.*List all managed worktrees/);
      assert.match(result.stdout ?? "", /status.*Show detailed info/);
      assert.match(result.stdout ?? "", /remove.*Remove a managed worktree/);
      assert.match(result.stdout ?? "", /prune.*Remove old completed worktrees/);
      // Should show examples
      assert.match(result.stdout ?? "", /tamandua worktree list/);
      assert.match(result.stdout ?? "", /tamandua worktree status abc12345/);
      assert.match(result.stdout ?? "", /tamandua worktree prune --completed --older-than 7d/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua worktree prune --help documents --completed and --older-than flags", () => {
    const result = cli(["worktree", "prune", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Remove old completed worktrees/);
      assert.match(result.stdout ?? "", /--completed/);
      assert.match(result.stdout ?? "", /--older-than/);
      assert.match(result.stdout ?? "", /completed or canceled/);
      assert.match(result.stdout ?? "", /Duration format/);
      assert.match(result.stdout ?? "", /7d.*7 days/);
      assert.match(result.stdout ?? "", /24h.*24 hours/);
      assert.match(result.stdout ?? "", /30m.*30 minutes/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua worktree remove --help documents --force flag", () => {
    const result = cli(["worktree", "remove", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Remove a managed worktree/);
      assert.match(result.stdout ?? "", /--force/);
      assert.match(result.stdout ?? "", /Allow removal.*any status/);
      assert.match(result.stdout ?? "", /non-ready/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua worktree list --help explains list output", () => {
    const result = cli(["worktree", "list", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /List all managed worktrees/);
      assert.match(result.stdout ?? "", /Status.*Worktree status/);
      assert.match(result.stdout ?? "", /Run ID/);
      assert.match(result.stdout ?? "", /Cleanup/);
      assert.match(result.stdout ?? "", /Path/);
      assert.match(result.stdout ?? "", /Origin/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua worktree status --help shows detailed fields", () => {
    const result = cli(["worktree", "status", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Show detailed worktree info for a run/);
      assert.match(result.stdout ?? "", /Origin repo/);
      assert.match(result.stdout ?? "", /Origin ref/);
      assert.match(result.stdout ?? "", /Origin SHA/);
      assert.match(result.stdout ?? "", /Orig branch/);
      assert.match(result.stdout ?? "", /Worktree.*Absolute filesystem path/);
      assert.match(result.stdout ?? "", /Cleanup/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua logs --help shows examples for each selector kind", () => {
    const result = cli(["logs", "--help"]);
    try {
      assert.equal(result.status, 0);
      // last 50 global
      assert.match(result.stdout ?? "", /Show last 50 global events/);
      // line count
      assert.match(result.stdout ?? "", /Show last 20 global events/);
      // run-id prefix
      assert.match(result.stdout ?? "", /Show events for run starting with/);
      // run number
      assert.match(result.stdout ?? "", /Show events for run #3/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-008: workflow commands help
  it("tamandua workflow --help lists all subcommands with brief descriptions", () => {
    const result = cli(["workflow", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Manage workflows and runs/);
      assert.match(result.stdout ?? "", /list.*List available bundled workflows/);
      assert.match(result.stdout ?? "", /runs.*List all workflow runs/);
      assert.match(result.stdout ?? "", /install.*Install a specific workflow/);
      assert.match(result.stdout ?? "", /uninstall.*Uninstall a workflow/);
      assert.match(result.stdout ?? "", /run.*Start a new workflow run/);
      assert.match(result.stdout ?? "", /status.*Show detailed run status/);
      assert.match(result.stdout ?? "", /stop.*Cancel a running workflow/);
      assert.match(result.stdout ?? "", /pause.*Pause a running workflow/);
      assert.match(result.stdout ?? "", /resume.*Resume a paused or failed/);
      assert.match(result.stdout ?? "", /pause-all.*Pause all running/);
      assert.match(result.stdout ?? "", /resume-all.*Resume all paused/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow run --help documents all flags", () => {
    const result = cli(["workflow", "run", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Start a new workflow run/);
      assert.match(result.stdout ?? "", /--no-hurry-please-save-tokens-mode/);
      assert.match(result.stdout ?? "", /token-saving mode/);
      assert.match(result.stdout ?? "", /--working-directory-for-harness/);
      assert.match(result.stdout ?? "", /--worktree-origin-repository/);
      assert.match(result.stdout ?? "", /--worktree-origin-ref/);
      assert.match(result.stdout ?? "", /Add dark mode toggle/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow pause --help documents --drain flag", () => {
    const result = cli(["workflow", "pause", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Pause a running workflow/);
      assert.match(result.stdout ?? "", /--drain/);
      assert.match(result.stdout ?? "", /in-flight agent sessions/);
      assert.match(result.stdout ?? "", /dashboard daemon/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow uninstall --help documents --all and --force flags", () => {
    const result = cli(["workflow", "uninstall", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Uninstall one or all workflows/);
      assert.match(result.stdout ?? "", /--all.*Uninstall every installed/);
      assert.match(result.stdout ?? "", /--force.*Skip the active-runs/);
      assert.match(result.stdout ?? "", /active runs.*running or paused/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow resume --help explains paused vs failed resume behavior", () => {
    const result = cli(["workflow", "resume", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Resume a paused or failed workflow/);
      assert.match(result.stdout ?? "", /paused.*Connects to the dashboard daemon/);
      assert.match(result.stdout ?? "", /failed.*Restarts the run/);
      assert.match(result.stdout ?? "", /completed.*cannot be resumed/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow list --help shows list help", () => {
    const result = cli(["workflow", "list", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /List available bundled workflows/);
      assert.match(result.stdout ?? "", /workflows\/ directory/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow runs --help shows runs help", () => {
    const result = cli(["workflow", "runs", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /List all workflow runs/);
      assert.match(result.stdout ?? "", /Status.*Run status/);
      assert.match(result.stdout ?? "", /Tokens.*Total tokens spent/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow install --help shows install help", () => {
    const result = cli(["workflow", "install", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Install a specific workflow by name/);
      assert.match(result.stdout ?? "", /YAML spec/);
      assert.match(result.stdout ?? "", /agent workspaces/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow status --help shows status help with step listing", () => {
    const result = cli(["workflow", "status", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Show detailed run status/);
      assert.match(result.stdout ?? "", /done.*Step completed/);
      assert.match(result.stdout ?? "", /running.*Step currently being executed/);
      assert.match(result.stdout ?? "", /failed.*Step failed/);
      assert.match(result.stdout ?? "", /pending.*Step waiting/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow stop --help shows stop help", () => {
    const result = cli(["workflow", "stop", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Cancel a running workflow/);
      assert.match(result.stdout ?? "", /prefix matching/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow pause-all --help shows pause-all help with --drain", () => {
    const result = cli(["workflow", "pause-all", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Pause all running workflows/);
      assert.match(result.stdout ?? "", /--drain/);
      assert.match(result.stdout ?? "", /in-flight agent sessions/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  // US-009: global usage includes --help hint
  it("tamandua --help includes note about command-level --help", () => {
    const result = cli(["--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Run tamandua <command> --help for detailed command help/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });

  it("tamandua workflow resume-all --help shows resume-all help", () => {
    const result = cli(["workflow", "resume-all", "--help"]);
    try {
      assert.equal(result.status, 0);
      assert.match(result.stdout ?? "", /Resume all paused workflows/);
      assert.match(result.stdout ?? "", /Only paused runs are resumed/);
      assert.match(result.stdout ?? "", /failed runs are not resumed/);
      assert.doesNotMatch(result.stdout ?? "", /tamandua install/);
    } finally {
      fs.rmSync(result.testEnv.tmpDir, { recursive: true, force: true });
    }
  });
});
