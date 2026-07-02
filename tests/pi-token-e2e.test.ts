/**
 * MOTOR-MECHANISM: pins the CURRENT model-driven polling motor.
 *
 * This test asserts implementation details of the polling motor (model-run
 * peek/claim rounds, polling prompts, heartbeat system-token attribution).
 * It is EXPECTED to churn or be replaced when the deterministic motor lands.
 * During the motor rewrite: a failure here is expected noise; a failure in a
 * contract test is a real regression. See tests/MOTOR-CONTRACT.md.
 */
import fs from "node:fs";
import { cleanChildEnv } from "./helpers/test-env.ts";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

// ---------------------------------------------------------------------------
// Canned message_end line matching the real pi --mode json output shape.
// Extracted from real pi output (echo "" | pi --print --mode json --no-session "say hi")
// and verified in parse-polling-metadata.test.ts (US-003).
// totalTokens = 4242 is the expected delta for this test.
// ---------------------------------------------------------------------------
const CANNED_MESSAGE_END = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "STATUS: done\nCHANGES: fixed stuff\nTESTS: tested" }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    usage: {
      input: 121,
      output: 25,
      cacheRead: 4096,
      cacheWrite: 0,
      totalTokens: 4242,
      cost: {
        input: 0.000052635,
        output: 0.00002175,
        cacheRead: 0.000014848,
        cacheWrite: 0,
        total: 0.000089233,
      },
    },
    stopReason: "stop",
    timestamp: 1777829458436,
    responseId: "df63b1e4-f982-4f9f-85a6-6e0f12d609fa",
  },
});

function createTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-pi-token-e2e-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

/**
 * Create a fake pi bash shell script (NOT inline Node — real executable file)
 * that writes a canned message_end JSON line to stdout and exits 0.
 * Returns the path to the executable script.
 */
function createFakePiShellScript(
  rootDir: string,
  runId: string,
  stepId: string,
): string {
  const scriptPath = path.join(rootDir, "fake-pi");
  // Bash script emits a tool_execution_end + message_end JSON pair.
  // tool_execution_end carries runId/stepId for attribution.
  // content text intentionally avoids HEARTBEAT_OK so the round is classified as work_done.
  const toolEvent = JSON.stringify({
    type: "tool_execution_end",
    toolName: "bash",
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ stepId, runId }),
        },
      ],
    },
    isError: false,
  });

  const script = [
    "#!/usr/bin/env bash",
    "cat << 'JSON'",
    toolEvent,
    CANNED_MESSAGE_END,
    "JSON",
    "",
  ].join("\n");

  fs.writeFileSync(scriptPath, script, "utf-8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      env: cleanChildEnv(env),
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `Script failed with exit ${result.status}`,
      `STDOUT:\n${result.stdout}`,
      `STDERR:\n${result.stderr}`,
    ].join("\n\n"));
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }

  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("pi token end-to-end with fake pi shell script", () => {
  /** AC 1: Fake pi is a shell script file that emits valid message_end JSON and exits 0 */
  it("fake pi shell script emits valid message_end JSON and exits 0", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    try {
      const fakePi = createFakePiShellScript(temp.root, runId, stepId);

      // Execute the fake pi directly and verify output
      const result = spawnSync(fakePi, [], {
        cwd: temp.root,
        encoding: "utf-8",
      });

      assert.equal(result.status, 0, `fake pi should exit 0, got ${result.status}`);
      assert.ok(result.stdout.length > 0, "fake pi should produce stdout");

      // Parse each line as JSON
      const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
      assert.ok(lines.length >= 2, "should have at least 2 JSON lines");

      const toolEvent = JSON.parse(lines[0]);
      assert.equal(toolEvent.type, "tool_execution_end");

      const messageEndEvent = JSON.parse(lines[1]);
      assert.equal(messageEndEvent.type, "message_end");
      assert.equal(messageEndEvent.message.role, "assistant");
      assert.equal(messageEndEvent.message.usage.totalTokens, 4242);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  /** AC 2–5: Full integration — executePollingRound → tokens_spent rises → event emitted */
  it("runs.tokens_spent rises from 0 to 4242 after one polling round with fake pi", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    try {
      const fakePi = createFakePiShellScript(temp.root, runId, stepId);

      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const runId = ${JSON.stringify(runId)};
          const stepId = ${JSON.stringify(stepId)};
          const now = new Date().toISOString();

          // Insert run with tokens_spent = 0 (baseline)
          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf-pi-e2e', 'Implement token tracking', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          // Insert step so toll_execution_end attribution can resolve runId
          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement-token', 'wf_pi_e2e_dev', 0, '', '', 'running', ?, ?)"
          ).run(stepId, runId, now, now);

          const job = {
            id: "job-pi-token-e2e",
            name: "wf-pi-e2e/dev",
            workflowId: "wf-pi-e2e",
            agentId: "wf_pi_e2e_dev",
            intervalMinutes: 5,
            timeoutSeconds: 30,
            workdir: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executePollingRound(job, agent);

          // Verify tokens_spent rose from 0 to 4242
          const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const finalTokens = row.tokens_spent;

          // Check for run.tokens.updated event in the run-specific events file
          const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
          const events = fs.existsSync(eventsPath)
            ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line))
            : [];
          const tokenEvent = events.find((evt) => evt.event === "run.tokens.updated");

          // Also check global events file
          const globalEventsPath = path.join(process.env.HOME, ".tamandua", "events", "all.jsonl");
          const globalEvents = fs.existsSync(globalEventsPath)
            ? fs.readFileSync(globalEventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line))
            : [];
          const globalTokenEvent = globalEvents.find((evt) => evt.event === "run.tokens.updated");

          console.log(JSON.stringify({
            tokensSpent: finalTokens,
            tokenEventRunId: tokenEvent?.runId ?? null,
            tokenEventDelta: tokenEvent?.tokenDelta ?? null,
            tokenEventTotal: tokenEvent?.tokensSpent ?? null,
            globalTokenEventSeen: globalTokenEvent !== undefined,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      // AC 3: tokens_spent rises from 0 → 4242
      assert.equal(result.tokensSpent, 4242, `tokens_spent should be 4242, got ${result.tokensSpent}`);

      // AC 4: run.tokens.updated event is emitted
      assert.equal(result.tokenEventRunId, runId, "token event should reference the correct runId");
      assert.equal(result.tokenEventDelta, 4242, `token delta should be 4242, got ${result.tokenEventDelta}`);
      assert.equal(result.tokenEventTotal, 4242, `token total should be 4242, got ${result.tokenEventTotal}`);

      // Also in the global events file
      assert.equal(result.globalTokenEventSeen, true, "run.tokens.updated event should appear in global events file");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
