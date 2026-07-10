/**
 * AutoResearch Scripted E2E Test (fast, ZERO model tokens)
 *
 * Drives the autoresearch loop through the REAL CLI with a deterministic
 * fake pi binary. Tests the full runLoopIteration lifecycle: baseline
 * measurement, prompted improvement (fake pi edits score.txt), git
 * commit, and working-tree cleanliness.
 *
 * No models are invoked and NO tokens are spent. canarinho_PI_BINARY
 * points at a deterministic fake pi that writes a lower score and emits
 * pi-shaped JSON output.
 *
 * TEST ISOLATION: temp HOME, canarinho_TEST_GUARD=1, random ports,
 * canarinho_PI_BINARY pointing at deterministic fake pi. Never touches
 * real ~/.canarinho or default ports.
 *
 * Run via: ./run-all-scripted-e2e-tests (or ./run-all-e2e-tests)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createTempHome,
  baseEnv,
  cliMustSucceed,
  cli,
  cleanupTempHome,
} from "./helpers/smoke-helpers.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function setUpGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });

  // Initial score: 10
  fs.writeFileSync(path.join(dir, "score.txt"), "10\n", "utf-8");

  function git(args: string[]): string {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    assert.equal(
      r.status,
      0,
      `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
    );
    return r.stdout.trim();
  }

  git(["init"]);
  git(["config", "user.email", "test@canarinho.local"]);
  git(["config", "user.name", "canarinho ARSE Test"]);
  git(["add", "score.txt"]);
  git(["commit", "-m", "initial commit with score=10"]);
}

/**
 * Create a fake pi executable that writes a lower score (5) and emits
 * pi-shaped JSON so runPiAgent can parse it as success.
 */
function createFakePiImprovement(
  rootDir: string,
  nodeExecPath: string,
): string {
  const runtimePath = path.join(rootDir, "fake-pi-improve.mjs");
  fs.writeFileSync(
    runtimePath,
    [
      `import fs from "node:fs";`,
      ``,
      `// Write improved (lower) score`,
      `fs.writeFileSync("score.txt", "5\\n", "utf-8");`,
      ``,
      `// Emit pi-shaped JSON output`,
      `console.log(JSON.stringify({`,
      `  type: "message_end",`,
      `  message: {`,
      `    role: "assistant",`,
      `    content: [{`,
      `      type: "text",`,
      `      text: [`,
      `        "STATUS: done",`,
      `        "CHANGES: reduced score from 10 to 5",`,
      `        "HYPOTHESIS: lower score is achievable",`,
      `        "LEARNED: score reduction works",`,
      `        "NEXT_FOCUS: reduce further",`,
      `      ].join("\\n"),`,
      `    }],`,
      `  },`,
      `}));`,
      ``,
    ].join("\n"),
    "utf-8",
  );

  const binPath = path.join(rootDir, "fake-pi");
  fs.writeFileSync(
    binPath,
    [
      "#!/usr/bin/env bash",
      `exec "${nodeExecPath}" "${runtimePath}" "$@"`,
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(binPath, 0o755);

  return binPath;
}

/**
 * Create a fake pi executable that writes a higher score (15) and emits
 * pi-shaped JSON to simulate a change that WORSENS the metric. The
 * autoresearch loop should detect this as a regression and revert it.
 */
function createFakePiRegression(
  rootDir: string,
  nodeExecPath: string,
): string {
  const runtimePath = path.join(rootDir, "fake-pi-regress.mjs");
  fs.writeFileSync(
    runtimePath,
    [
      `import fs from "node:fs";`,
      ``,
      `// Write worse (higher) score`,
      `fs.writeFileSync("score.txt", "15\\n", "utf-8");`,
      ``,
      `// Emit pi-shaped JSON output (agent reports success, loop decides)`,
      `console.log(JSON.stringify({`,
      `  type: "message_end",`,
      `  message: {`,
      `    role: "assistant",`,
      `    content: [{`,
      `      type: "text",`,
      `      text: [`,
      `        "STATUS: done",`,
      `        "CHANGES: changed score from 10 to 15",`,
      `        "HYPOTHESIS: higher score might help something",`,
      `        "LEARNED: score change works",`,
      `        "NEXT_FOCUS: investigate direction",`,
      `      ].join("\\n"),`,
      `    }],`,
      `  },`,
      `}));`,
      ``,
    ].join("\n"),
    "utf-8",
  );

  const binPath = path.join(rootDir, "fake-pi-regress");
  fs.writeFileSync(
    binPath,
    [
      "#!/usr/bin/env bash",
      `exec "${nodeExecPath}" "${runtimePath}" "$@"`,
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(binPath, 0o755);

  return binPath;
}

// ── Shared state for tests ──────────────────────────────────────────

const EXPERIMENT_CMD =
  "node -e \"console.log('score: ' + require('fs').readFileSync('score.txt','utf8').trim())\"";

// ── Tests ───────────────────────────────────────────────────────────

describe("autoresearch scripted e2e", () => {
  let temp: Awaited<ReturnType<typeof createTempHome>>;
  let repoDir: string;
  let homeDir: string;
  let env: ReturnType<typeof baseEnv>;

  beforeEach(async () => {
    temp = await createTempHome();
    repoDir = path.join(temp.root, "repo");
    homeDir = temp.homeDir;
    env = baseEnv(homeDir, temp.controlPort);

    // Setup isolated git repo with score.txt = 10
    setUpGitRepo(repoDir);

    // Initialize autoresearch session
    cliMustSucceed(
      [
        "autoresearch", "init",
        "--cwd", repoDir,
        "--goal", "reduce score",
        "--metric", "score",
        "--direction", "lower",
        "--command", EXPERIMENT_CMD,
      ],
      env,
      "autoresearch init",
    );

    // Verify autoresearch files were created
    assert.ok(
      fs.existsSync(path.join(repoDir, "autoresearch.config.json")),
      "autoresearch.config.json should exist",
    );
    assert.ok(
      fs.existsSync(path.join(repoDir, "autoresearch.jsonl")),
      "autoresearch.jsonl should exist",
    );
  });

  afterEach(() => {
    cleanupTempHome(temp);
  });

  it("happy path: full loop iteration with improvement", () => {
    // Create fake pi that writes improved score
    const fakePiPath = createFakePiImprovement(temp.root, process.execPath);

    // ── Baseline run (no prompt, just measure) ──
    const baselineOut = cliMustSucceed(
      [
        "autoresearch", "run-loop-iteration",
        "--cwd", repoDir,
        "--iteration", "1",
        "--description", "baseline measurement",
      ],
      { ...env, canarinho_PI_BINARY: fakePiPath },
      "baseline run-loop-iteration",
    );
    const baselineResult = JSON.parse(baselineOut.trim());
    assert.equal(baselineResult.status, "baseline", "baseline run should have status=baseline");
    assert.equal(baselineResult.metric, 10, "baseline metric should be 10");
    // Baseline has no file changes (score.txt unchanged, autoresearch files
    // are protected from commits) so committed is false — this is expected.
    assert.equal(baselineResult.committed, false, "baseline should not commit (no changes)");
    assert.equal(baselineResult.run, 1, "baseline should be run 1");

    // score.txt should still be 10 (no pi agent ran)
    const scoreAfterBaseline = fs.readFileSync(
      path.join(repoDir, "score.txt"), "utf-8").trim();
    assert.equal(scoreAfterBaseline, "10", "score.txt should still be 10 after baseline");

    // ── Improvement run (with prompt, fake pi) ──
    const improveOut = cliMustSucceed(
      [
        "autoresearch", "run-loop-iteration",
        "--cwd", repoDir,
        "--prompt", "try to reduce score",
        "--iteration", "2",
        "--description", "test improvement",
      ],
      { ...env, canarinho_PI_BINARY: fakePiPath },
      "improvement run-loop-iteration",
    );
    const improveResult = JSON.parse(improveOut.trim());
    assert.equal(improveResult.status, "keep", "improvement run should have status=keep");
    assert.equal(improveResult.metric, 5, "improvement metric should be 5");
    assert.ok(improveResult.committed, "improvement should be committed");
    assert.ok(!improveResult.reverted, "improvement should not be reverted");
    assert.ok(improveResult.agentSuccess, "agent should have succeeded");
    assert.equal(improveResult.run, 2, "improvement should be run 2");

    // score.txt should now be 5 (fake pi wrote it)
    const scoreAfterImprove = fs.readFileSync(
      path.join(repoDir, "score.txt"), "utf-8").trim();
    assert.equal(scoreAfterImprove, "5", "score.txt should be 5 after improvement");

    // ── Assert autoresearch.jsonl entries ──
    const logContent = fs.readFileSync(
      path.join(repoDir, "autoresearch.jsonl"), "utf-8");
    const logLines = logContent.trim().split("\n");
    assert.ok(logLines.length >= 5, `autoresearch.jsonl should have at least 5 entries, got ${logLines.length}`);

    // Entry 0: session
    const session = JSON.parse(logLines[0]);
    assert.equal(session.type, "session");

    // Entries: session, run_result(1), run(1), run_result(2), run(2)
    const runEntries = logLines
      .map((l) => JSON.parse(l))
      .filter((e: { type: string }) => e.type === "run");
    const resultEntries = logLines
      .map((l) => JSON.parse(l))
      .filter((e: { type: string }) => e.type === "run_result");

    assert.equal(runEntries.length, 2, "should have 2 run entries");
    assert.equal(resultEntries.length, 2, "should have 2 run_result entries");

    assert.equal(runEntries[0].status, "baseline");
    assert.equal(runEntries[0].metric, 10);
    assert.equal(runEntries[1].status, "keep");
    assert.equal(runEntries[1].metric, 5);
    assert.ok(
      runEntries[1].commit_after,
      "improvement run should have a commit_after",
    );
    assert.ok(
      runEntries[1].asi?.hypothesis,
      "improvement run should have hypothesis from agent",
    );

    // ── Assert git log has the improvement commit ──
    const gitLog = spawnSync(
      "git",
      ["log", "--oneline", "--all"],
      { cwd: repoDir, encoding: "utf-8" },
    );
    assert.equal(gitLog.status, 0, `git log failed: ${gitLog.stderr}`);
    assert.ok(
      gitLog.stdout.includes("autoresearch: keep run 2"),
      `git log should include improvement commit: ${gitLog.stdout}`,
    );

    // ── Assert working tree is clean ──
    const gitStatus = spawnSync(
      "git",
      ["status", "--porcelain"],
      { cwd: repoDir, encoding: "utf-8" },
    );
    assert.equal(gitStatus.status, 0, `git status failed: ${gitStatus.stderr}`);
    // There should be no non-autoresearch dirty files. Untracked
    // autoresearch files (??) are expected and intentional.
    const dirtyLines = gitStatus.stdout
      .split("\n")
      .filter((l: string) => l.trim() && !l.includes("autoresearch."));
    assert.equal(
      dirtyLines.length,
      0,
      `working tree should have no non-autoresearch dirty files, got: ${gitStatus.stdout}`,
    );
  });

  it("regression case: worsening metric is detected and reverted", () => {
    // Create fake pi that writes a worse (higher) score
    const fakePiPath = createFakePiRegression(temp.root, process.execPath);

    // ── Baseline run (no prompt, just measure) ──
    const baselineOut = cliMustSucceed(
      [
        "autoresearch", "run-loop-iteration",
        "--cwd", repoDir,
        "--iteration", "1",
        "--description", "baseline measurement",
      ],
      { ...env, canarinho_PI_BINARY: fakePiPath },
      "baseline run-loop-iteration",
    );
    const baselineResult = JSON.parse(baselineOut.trim());
    assert.equal(baselineResult.status, "baseline", "baseline should be status=baseline");
    assert.equal(baselineResult.metric, 10, "baseline metric should be 10");
    assert.equal(baselineResult.run, 1, "baseline should be run 1");

    // Save original score.txt content for later comparison
    const originalScore = fs.readFileSync(
      path.join(repoDir, "score.txt"), "utf-8").trim();
    assert.equal(originalScore, "10", "original score should be 10");

    // ── Regression run (with prompt, fake pi writes higher score) ──
    const regressOut = cliMustSucceed(
      [
        "autoresearch", "run-loop-iteration",
        "--cwd", repoDir,
        "--prompt", "try something that might worsen the score",
        "--iteration", "2",
        "--description", "test regression",
      ],
      { ...env, canarinho_PI_BINARY: fakePiPath },
      "regression run-loop-iteration",
    );
    const regressResult = JSON.parse(regressOut.trim());
    assert.equal(regressResult.status, "discard", "regression run should have status=discard");
    assert.equal(regressResult.metric, 15, "regression metric should be 15");
    assert.equal(regressResult.committed, false, "regression should not be committed");
    assert.ok(regressResult.reverted, "regression should be reverted");
    assert.ok(regressResult.agentSuccess, "agent should have succeeded");
    assert.equal(regressResult.run, 2, "regression should be run 2");

    // ── Assert score.txt is reverted to original value ──
    const scoreAfterRegress = fs.readFileSync(
      path.join(repoDir, "score.txt"), "utf-8").trim();
    assert.equal(
      scoreAfterRegress,
      originalScore,
      `score.txt should be reverted to original value ${originalScore}, got ${scoreAfterRegress}`,
    );

    // ── Assert autoresearch.jsonl entries ──
    const logContent = fs.readFileSync(
      path.join(repoDir, "autoresearch.jsonl"), "utf-8");
    const logLines = logContent.trim().split("\n");
    assert.ok(logLines.length >= 5, `autoresearch.jsonl should have at least 5 entries, got ${logLines.length}`);

    const runEntries = logLines
      .map((l) => JSON.parse(l))
      .filter((e: { type: string }) => e.type === "run");
    const resultEntries = logLines
      .map((l) => JSON.parse(l))
      .filter((e: { type: string }) => e.type === "run_result");

    assert.equal(runEntries.length, 2, "should have 2 run entries");
    assert.equal(resultEntries.length, 2, "should have 2 run_result entries");

    assert.equal(runEntries[0].status, "baseline");
    assert.equal(runEntries[0].metric, 10);
    // Regression run should be logged as discard
    assert.equal(runEntries[1].status, "discard", "regression run entry should have status=discard");
    assert.equal(runEntries[1].metric, 15, "regression run entry metric should be 15");
    // Discard runs should have no commit_after
    assert.equal(
      runEntries[1].commit_after,
      undefined,
      "discard run should not have commit_after",
    );
    assert.ok(
      runEntries[1].asi?.hypothesis,
      "regression run should have hypothesis from agent",
    );

    // ── Assert git log does NOT have a commit for the regression ──
    const gitLog = spawnSync(
      "git",
      ["log", "--oneline", "--all"],
      { cwd: repoDir, encoding: "utf-8" },
    );
    assert.equal(gitLog.status, 0, `git log failed: ${gitLog.stderr}`);
    assert.ok(
      !gitLog.stdout.includes("autoresearch: discard"),
      `git log should NOT include discard commit: ${gitLog.stdout}`,
    );
    // The only commit should be the initial one
    const commitLines = gitLog.stdout.trim().split("\n");
    assert.equal(
      commitLines.length,
      1,
      `git log should have only 1 commit (initial), got: ${gitLog.stdout}`,
    );

    // ── Assert working tree is clean ──
    const gitStatus = spawnSync(
      "git",
      ["status", "--porcelain"],
      { cwd: repoDir, encoding: "utf-8" },
    );
    assert.equal(gitStatus.status, 0, `git status failed: ${gitStatus.stderr}`);
    const dirtyLines = gitStatus.stdout
      .split("\n")
      .filter((l: string) => l.trim() && !l.includes("autoresearch."));
    assert.equal(
      dirtyLines.length,
      0,
      `working tree should have no non-autoresearch dirty files, got: ${gitStatus.stdout}`,
    );
  });
});
