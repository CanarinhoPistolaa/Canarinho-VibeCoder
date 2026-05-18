import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");
const fixtureDir = path.join(repoRoot, "e2e-tests", "fixtures", "sample-project");

// ── Helpers ──

function createTempHome(controlPort: number, dashboardPort: number) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "tamandua-e2e-workflows-"),
  );
  const homeDir = path.join(root, "home");
  const tamanduaDir = path.join(homeDir, ".tamandua");
  const piAgentDir = path.join(homeDir, ".pi", "agent");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(tamanduaDir, "port"),
    String(dashboardPort),
    "utf-8",
  );
  // Minimal pi config required by workflow install
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }),
    "utf-8",
  );
  return { root, homeDir, tamanduaDir, controlPort, dashboardPort };
}

function baseEnv(homeDir: string, controlPort: number) {
  return {
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
  };
}

function cli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

function cliMustSucceed(
  args: string[],
  env: Record<string, string>,
  label: string,
) {
  const r = cli(args, env);
  assert.equal(
    r.status,
    0,
    `${label} failed (exit ${r.status}): ${r.stderr || r.stdout}`,
  );
  return r.stdout;
}

function stepClaim(
  agentId: string,
  runId: string,
  env: Record<string, string>,
) {
  const r = cli(["step", "claim", agentId, "--run-id", runId], env);
  assert.equal(
    r.status,
    0,
    `step claim ${agentId} failed: ${r.stderr || r.stdout}`,
  );
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.stepId, `no stepId in claim response: ${r.stdout}`);
  return parsed as { stepId: string; runId: string; input: string };
}

function stepComplete(
  stepId: string,
  output: string,
  env: Record<string, string>,
) {
  const r = spawnSync(process.execPath, [cliPath, "step", "complete", stepId], {
    env: { ...process.env, ...env },
    input: output,
    encoding: "utf-8",
  });
  assert.equal(
    r.status,
    0,
    `step complete ${stepId} failed: ${r.stderr || r.stdout}`,
  );
  return JSON.parse(r.stdout.trim()) as { status: string };
}

/**
 * Spawn `tamandua workflow run` and capture the 8-char run-ID prefix from stdout.
 * Kills the child process once the output is captured.
 */
function spawnWorkflowRun(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timeout waiting for workflow run output. stdout: ${stdout}, stderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/^Run:\s+([0-9a-f]{8,})/im);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve(match[1]);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      const match = stdout.match(/^Run:\s+([0-9a-f]{8,})/im);
      if (match) {
        resolve(match[1]);
      } else {
        reject(
          new Error(
            `Workflow run failed (exit ${code}). stdout: ${stdout}, stderr: ${stderr}`,
          ),
        );
      }
    });
  });
}

/** Prepare a clean git repo from the sample project fixture */
function prepareGitRepo(fixtureDir: string, targetDir: string) {
  fs.mkdirSync(targetDir, { recursive: true });
  const cpResult = spawnSync("cp", ["-r", `${fixtureDir}/.`, `${targetDir}/`], {
    encoding: "utf-8",
  });
  assert.equal(cpResult.status, 0, `cp failed: ${cpResult.stderr}`);

  function git(args: string[]) {
    const r = spawnSync("git", args, { cwd: targetDir, encoding: "utf-8" });
    assert.equal(
      r.status,
      0,
      `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
    );
    return r.stdout.trim();
  }

  git(["init"]);
  git(["config", "user.email", "test@tamandua.local"]);
  git(["config", "user.name", "Tamandua E2E Test"]);
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit with sample project"]);
  return targetDir;
}

/** Stop the daemon and remove temp directory */
/** Resolve full run ID from the 8-char prefix using the temp home DB */
function resolveFullRunId(prefix: string, tamanduaDir: string): string {
  const dbPath = path.join(tamanduaDir, "tamandua.db");
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare("SELECT id FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1")
      .all(`${prefix}%`) as Array<{ id: string }>;
    if (rows.length === 0) {
      throw new Error(`No run found matching prefix "${prefix}"`);
    }
    return rows[0].id;
  } finally {
    db.close();
  }
}

function cleanupTempHome(
  env: { root: string; homeDir: string; controlPort: number },
) {
  try {
    cli(["dashboard", "stop"], baseEnv(env.homeDir, env.controlPort));
  } catch {
    // best-effort
  }
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ── Tests ──

describe("workflows e2e", { concurrency: 1 }, () => {
  // Use unique high ports to avoid conflicts
  const CONTROL_PORT = 35500;
  const DASHBOARD_PORT = 36500;

  it(
    "feature-dev-merge-worktree: plan → setup → implement → verify → test → merge → done",
    { timeout: 120_000 },
    async () => {
      const env = createTempHome(CONTROL_PORT, DASHBOARD_PORT);

      try {
        // 1. Install the workflow
        cliMustSucceed(
          ["workflow", "install", "feature-dev-merge-worktree"],
          baseEnv(env.homeDir, CONTROL_PORT),
          "install feature-dev-merge-worktree",
        );

        // 2. Prepare a clean git repo from the sample project
        const repoDir = path.join(env.root, "sample-repo");
        prepareGitRepo(fixtureDir, repoDir);

        // 3. Create the run
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "feature-dev-merge-worktree",
            "Add a multiply function to math.ts",
            "--worktree-origin-repository",
            repoDir,
          ],
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // ---- Advance pipeline ----

        // Step: plan (planner)
        const plan = stepClaim(
          "feature-dev-merge-worktree_planner",
          runId,
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        const planResult = stepComplete(
          plan.stepId,
          "STATUS: done\n" +
            `REPO: ${repoDir}\n` +
            "BRANCH: feature/add-multiply\n" +
            'STORIES_JSON: [{"id":"US-001","title":"Add multiply function","description":"Add a function multiply(a,b) that returns a * b to src/math.ts","acceptanceCriteria":["multiply function exists in src/math.ts","export is added to index if applicable","tests pass","Typecheck passes"]}]\n',
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        assert.ok(
          planResult.status === "advanced" || planResult.status === "completed",
          `plan: expected advanced/completed, got ${planResult.status}`,
        );

        // Step: setup (setup)
        const setup = stepClaim(
          "feature-dev-merge-worktree_setup",
          runId,
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        const setupResult = stepComplete(
          setup.stepId,
          "STATUS: done\n" +
            `ORIGINAL_BRANCH: main\n` +
            "BUILD_CMD: npm run build\n" +
            "TEST_CMD: npm test\n" +
            "CI_NOTES: Standard TypeScript project\n" +
            "BASELINE: Build succeeds, 1 test passes, 1 test fails (known bug in add)\n",
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        assert.equal(setupResult.status, "advanced");

        // Step: implement (developer, loop — US-001)
        const implement = stepClaim(
          "feature-dev-merge-worktree_developer",
          runId,
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        assert.ok(
          implement.input.includes("US-001"),
          `implement input should reference US-001: ${implement.input.substring(0, 200)}`,
        );
        const implResult = stepComplete(
          implement.stepId,
          "STATUS: done\n" +
            "CHANGES: Added multiply function to src/math.ts\n" +
            "TESTS: Added test for multiply function, all tests pass\n",
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        assert.equal(implResult.status, "advanced");

        // Step: verify (verifier, triggered by verify_each)
        const verify = stepClaim(
          "feature-dev-merge-worktree_verifier",
          runId,
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        const verifyResult = stepComplete(
          verify.stepId,
          "STATUS: done\n" +
            "VERIFIED: multiply function exists in src/math.ts, test passes\n",
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        assert.ok(
          verifyResult.status === "advanced" ||
            verifyResult.status === "completed",
          `verify: expected advanced/completed, got ${verifyResult.status}`,
        );

        // Step: test (tester)
        const testStep = stepClaim(
          "feature-dev-merge-worktree_tester",
          runId,
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        const testResult = stepComplete(
          testStep.stepId,
          "STATUS: done\n" +
            "RESULTS: Full test suite passes, integration verified\n",
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        assert.equal(testResult.status, "advanced");

        // Step: finalize_merge (merger)
        const merge = stepClaim(
          "feature-dev-merge-worktree_merger",
          runId,
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        const mergeResult = stepComplete(
          merge.stepId,
          "STATUS: done\n" +
            "REBASED: false\n" +
            "MERGE_COMMIT: abc1234\n" +
            "MERGED_INTO: main\n",
          baseEnv(env.homeDir, CONTROL_PORT),
        );
        assert.equal(mergeResult.status, "completed");

        // 4. Verify the run completed
        const statusOut = cliMustSucceed(
          ["workflow", "status", runId],
          baseEnv(env.homeDir, CONTROL_PORT),
          "workflow status",
        );
        assert.match(statusOut, /Status:\s+completed/i);
        assert.match(statusOut, /\[done\s+\]\s+plan/);
        assert.match(statusOut, /\[done\s+\]\s+setup/);
        assert.match(statusOut, /\[done\s+\]\s+implement/);
        assert.match(statusOut, /\[done\s+\]\s+verify/);
        assert.match(statusOut, /\[done\s+\]\s+test/);
        assert.match(statusOut, /\[done\s+\]\s+finalize_merge/);
      } finally {
        cleanupTempHome(env);
      }
    },
  );

  it(
    "bug-fix-merge-worktree: triage → investigate → setup → fix → verify → merge → done",
    { timeout: 120_000 },
    async () => {
      const env = createTempHome(CONTROL_PORT + 100, DASHBOARD_PORT + 100);
      const be = () => baseEnv(env.homeDir, env.controlPort);

      try {
        // 1. Install the workflow
        cliMustSucceed(
          ["workflow", "install", "bug-fix-merge-worktree"],
          be(),
          "install bug-fix-merge-worktree",
        );

        // 2. Prepare a clean git repo from the sample project
        const repoDir = path.join(env.root, "sample-repo");
        prepareGitRepo(fixtureDir, repoDir);

        // 3. Create the run
        const runIdPrefix = await spawnWorkflowRun(
          [
            "workflow",
            "run",
            "bug-fix-merge-worktree",
            "The add function in src/math.ts returns a - b instead of a + b",
            "--worktree-origin-repository",
            repoDir,
          ],
          be(),
        );
        const runId = resolveFullRunId(runIdPrefix, env.tamanduaDir);

        // ---- Advance pipeline ----

        // Step: triage (triager)
        const triage = stepClaim(
          "bug-fix-merge-worktree_triager",
          runId,
          be(),
        );
        const triageResult = stepComplete(
          triage.stepId,
          "STATUS: done\n" +
            `REPO: ${repoDir}\n` +
            "BRANCH: bugfix/fix-add-function\n" +
            "SEVERITY: high\n" +
            "AFFECTED_AREA: src/math.ts — add function\n" +
            "REPRODUCTION: Call add(2, 3) — returns -1 instead of 5\n" +
            "PROBLEM_STATEMENT: The add(a,b) function computes a - b instead of a + b\n",
          be(),
        );
        assert.equal(triageResult.status, "advanced");

        // Step: investigate (investigator)
        const investigate = stepClaim(
          "bug-fix-merge-worktree_investigator",
          runId,
          be(),
        );
        const investigateResult = stepComplete(
          investigate.stepId,
          "STATUS: done\n" +
            "ROOT_CAUSE: The add function in src/math.ts line 2 has a typo: uses subtraction operator (-) instead of addition operator (+)\n" +
            "FIX_APPROACH: Change 'return a - b' to 'return a + b' in src/math.ts\n",
          be(),
        );
        assert.equal(investigateResult.status, "advanced");

        // Step: setup (setup)
        const setup = stepClaim(
          "bug-fix-merge-worktree_setup",
          runId,
          be(),
        );
        const setupResult = stepComplete(
          setup.stepId,
          "STATUS: done\n" +
            "ORIGINAL_BRANCH: main\n" +
            "BUILD_CMD: npm run build\n" +
            "TEST_CMD: npm test\n" +
            "BASELINE: Build succeeds, 1 test passes (bug-matching), 1 test fails (correct expectation)\n",
          be(),
        );
        assert.equal(setupResult.status, "advanced");

        // Step: fix (fixer)
        const fix = stepClaim(
          "bug-fix-merge-worktree_fixer",
          runId,
          be(),
        );
        const fixResult = stepComplete(
          fix.stepId,
          "STATUS: done\n" +
            "CHANGES: Changed 'return a - b' to 'return a + b' in src/math.ts\n" +
            "REGRESSION_TEST: Added test that verifies add(2, 3) === 5 (catches the subtraction bug)\n",
          be(),
        );
        assert.equal(fixResult.status, "advanced");

        // Step: verify (verifier)
        const verify = stepClaim(
          "bug-fix-merge-worktree_verifier",
          runId,
          be(),
        );
        const verifyResult = stepComplete(
          verify.stepId,
          "STATUS: done\n" +
            "VERIFIED: Fix correct — add now returns a + b, regression test passes, all tests pass\n",
          be(),
        );
        assert.equal(verifyResult.status, "advanced");

        // Step: finalize_merge (merger)
        const merge = stepClaim(
          "bug-fix-merge-worktree_merger",
          runId,
          be(),
        );
        const mergeResult = stepComplete(
          merge.stepId,
          "STATUS: done\n" +
            "REBASED: false\n" +
            "MERGE_COMMIT: def5678\n" +
            "MERGED_INTO: main\n",
          be(),
        );
        assert.equal(mergeResult.status, "completed");

        // 4. Verify the run completed
        const statusOut = cliMustSucceed(
          ["workflow", "status", runId],
          be(),
          "workflow status",
        );
        assert.match(statusOut, /Status:\s+completed/i);
        assert.match(statusOut, /\[done\s+\]\s+triage/);
        assert.match(statusOut, /\[done\s+\]\s+investigate/);
        assert.match(statusOut, /\[done\s+\]\s+setup/);
        assert.match(statusOut, /\[done\s+\]\s+fix/);
        assert.match(statusOut, /\[done\s+\]\s+verify/);
        assert.match(statusOut, /\[done\s+\]\s+finalize_merge/);
      } finally {
        cleanupTempHome(env);
      }
    },
  );
});
