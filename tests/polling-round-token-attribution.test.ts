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

function createTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-polling-token-attribution-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function createFakePi(root: string, stdoutPayload: string): string {
  const fakePi = path.join(root, "pi");
  fs.writeFileSync(
    fakePi,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdoutPayload)});\n`,
    "utf-8",
  );
  fs.chmodSync(fakePi, 0o755);
  return fakePi;
}

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      env: cleanChildEnv(env),
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    throw new Error([
      `Script failed with exit ${result.status}`,
      `STDOUT:\n${result.stdout}`,
      `STDERR:\n${result.stderr}`,
    ].join("\n\n"));
  }

  const lastLine = result.stdout.trim().split(/\\r?\\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }

  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("polling-round token attribution", () => {
  it("adds polling-round usage to runs.tokens_spent when a run id is present", () => {
    const temp = createTempHome();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();

    try {
      const piOutput = [
        JSON.stringify({
          type: "tool_execution_end",
          toolName: "bash",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ stepId, runId, input: "Implement task" }),
              },
            ],
          },
          isError: false,
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "STATUS: done\nCHANGES: implemented\nTESTS: passed" }],
            usage: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0 },
            stopReason: "stop",
          },
        }),
      ].join("\n");

      const fakePi = createFakePi(temp.root, piOutput);

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

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 7, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement', 'wf_dev', 0, '', '', 'running', ?, ?)"
          ).run(stepId, runId, now, now);

          const job = {
            id: "job-token-attribution",
            name: "wf/dev",
            workflowId: "wf",
            agentId: "wf_dev",
            intervalMinutes: 5,
            timeoutSeconds: 5,
            workdir: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executePollingRound(job, agent);

          const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const eventsPath = path.join(process.env.HOME, ".tamandua", "events", runId + ".jsonl");
          const events = fs.existsSync(eventsPath)
            ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line))
            : [];
          const tokenEvent = events.find((evt) => evt.event === "run.tokens.updated");

          console.log(JSON.stringify({
            tokensSpent: row.tokens_spent,
            tokenEventRunId: tokenEvent?.runId ?? null,
            tokenEventDelta: tokenEvent?.tokenDelta ?? null,
            tokenEventTotal: tokenEvent?.tokensSpent ?? null,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      assert.equal(result.tokensSpent, 107);
      assert.equal(result.tokenEventRunId, runId);
      assert.equal(result.tokenEventDelta, 100);
      assert.equal(result.tokenEventTotal, 107);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("attributes tokens to system spend when run id is unresolvable, leaving run tokens unchanged", () => {
    const temp = createTempHome();

    try {
      const piOutput = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STATUS: done\nCHANGES: n/a\nTESTS: n/a" }],
          usage: { totalTokens: 55 },
          stopReason: "stop",
        },
      });

      const fakePi = createFakePi(temp.root, piOutput);

      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const runId = "${crypto.randomUUID()}";
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 13, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-token-no-run",
            name: "wf/dev",
            workflowId: "wf",
            agentId: "wf_dev",
            intervalMinutes: 5,
            timeoutSeconds: 5,
            workdir: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executePollingRound(job, agent);

          const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const systemRow = db.prepare("SELECT system_tokens_spent FROM tamandua_stats WHERE id = 1").get()
            ?? { system_tokens_spent: 0 };
          const logPath = path.join(process.env.HOME, ".tamandua", "tamandua.log");
          const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

          console.log(JSON.stringify({
            tokensSpent: row.tokens_spent,
            systemTokensSpent: systemRow.system_tokens_spent,
            unresolvedWarningSeen: logContent.includes("not attributed to run — run id unresolved"),
            systemAttributionSeen: logContent.includes("attributed to system spend"),
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      assert.equal(result.tokensSpent, 13, "run tokens_spent should be unchanged");
      assert.equal(result.systemTokensSpent, 55, "system_tokens_spent should record the 55 tokens");
      assert.equal(result.unresolvedWarningSeen, true, "WARN should still fire for unresolved run ID");
      assert.equal(result.systemAttributionSeen, true, "INFO should fire for system attribution");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("attributes heartbeat round token usage to system spend, leaves run unchanged", () => {
    const temp = createTempHome();

    try {
      const piOutput = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "HEARTBEAT_OK" }],
          usage: { totalTokens: 21 },
          stopReason: "stop",
        },
      });

      const fakePi = createFakePi(temp.root, piOutput);

      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

          const db = getDb();
          const runId = "${crypto.randomUUID()}";
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 3, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-token-heartbeat",
            name: "wf/dev",
            workflowId: "wf",
            agentId: "wf_dev",
            intervalMinutes: 5,
            timeoutSeconds: 5,
            workdir: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executePollingRound(job, agent);

          const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const systemTokens = getSystemTokenSpend();
          const logPath = path.join(process.env.HOME, ".tamandua", "tamandua.log");
          const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
          const eventsPath = path.join(process.env.HOME, ".tamandua", "events", "system.jsonl");
          const events = fs.existsSync(eventsPath)
            ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line))
            : [];
          const systemEvent = events.find((evt) => evt.event === "system.tokens.updated");

          console.log(JSON.stringify({
            tokensSpent: row.tokens_spent,
            systemTokensSpent: systemTokens,
            heartbeatSystemOverheadSeen: logContent.includes('"reason":"heartbeat_system_overhead"'),
            systemEventFound: !!systemEvent,
            systemEventRunId: systemEvent?.runId ?? null,
            systemEventTokenDelta: systemEvent?.tokenDelta ?? null,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      assert.equal(result.tokensSpent, 3, "run tokens_spent should remain unchanged for heartbeat");
      assert.equal(result.systemTokensSpent, 21, "system_tokens_spent should capture heartbeat token usage");
      assert.equal(result.heartbeatSystemOverheadSeen, true, "log should contain heartbeat_system_overhead reason");
      assert.equal(result.systemEventFound, true, "system.tokens.updated event should be emitted");
      assert.equal(result.systemEventRunId, "system", "system event runId should be \'system\'");
      assert.equal(result.systemEventTokenDelta, 21, "system event tokenDelta should be 21");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("emits a single warning when pi output contains zero JSON events (--mode json may be off)", () => {
    const temp = createTempHome();

    try {
      // Plain text output — no JSON events at all, simulating --mode json not being used
      const piOutput = "STATUS: done\nCHANGES: fixed something\nTESTS: passed";

      const fakePi = createFakePi(temp.root, piOutput);

      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const runId = "${crypto.randomUUID()}";
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-zero-json-warn",
            name: "wf/dev",
            workflowId: "wf",
            agentId: "wf_dev",
            intervalMinutes: 5,
            timeoutSeconds: 5,
            workdir: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executePollingRound(job, agent);

          const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const logPath = path.join(process.env.HOME, ".tamandua", "tamandua.log");
          const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
          const logLines = logContent.split(/\\r?\\n/).filter(Boolean);

          // WARN-level lines containing "--mode json may be off"
          const warningLines = logLines.filter(
            (line) => line.includes("WARN") && line.includes("--mode json may be off")
          );

          console.log(JSON.stringify({
            tokensSpent: row.tokens_spent,
            zeroJsonWarningCount: warningLines.length,
            zeroJsonWarningSeen: warningLines.length > 0,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      // Warning must be emitted
      assert.equal(result.zeroJsonWarningSeen, true, "expected zero-JSON warning in logs");
      // Exactly one warning per polling round (no duplicates)
      assert.equal(result.zeroJsonWarningCount, 1, "expected exactly one zero-JSON warning per round");
      // tokens_spent must remain 0 (no token attribution from non-JSON output)
      assert.equal(result.tokensSpent, 0);
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("plain-text HEARTBEAT_OK with no JSON does not change any token counters", () => {
    const temp = createTempHome();

    try {
      // Plain-text HEARTBEAT_OK — no JSON events at all
      const piOutput = "HEARTBEAT_OK";

      const fakePi = createFakePi(temp.root, piOutput);

      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

          const db = getDb();
          const runId = "${crypto.randomUUID()}";
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 7, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-plaintext-heartbeat",
            name: "wf/dev",
            workflowId: "wf",
            agentId: "wf_dev",
            intervalMinutes: 5,
            timeoutSeconds: 5,
            workdir: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executePollingRound(job, agent);

          const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const systemTokens = getSystemTokenSpend();
          const logPath = path.join(process.env.HOME, ".tamandua", "tamandua.log");
          const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

          console.log(JSON.stringify({
            tokensSpent: row.tokens_spent,
            systemTokensSpent: systemTokens,
            nonJsonWarningSeen: logContent.includes("--mode json may be off"),
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      // Run tokens should remain at the seeded value (7)
      assert.equal(result.tokensSpent, 7, "run tokens_spent must not change for plain-text heartbeat");
      // System tokens must remain 0 — no JSON metadata, so no tokenUsage to count
      assert.equal(result.systemTokensSpent, 0, "system_tokens_spent must remain 0 for plain-text heartbeat");
      // The non-JSON warning should be logged
      assert.equal(result.nonJsonWarningSeen, true, "non-JSON warning should be logged for plain-text output");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("does not emit zero-JSON warning when jsonMetadataDetected is true but usage is missing", () => {
    const temp = createTempHome();

    try {
      // JSON output with a tool_execution_end event but NO message_end (so no usage).
      // Must NOT contain HEARTBEAT_OK so the round is classified as work_done.
      const piOutput = [
        JSON.stringify({
          type: "tool_execution_end",
          toolName: "bash",
          result: {
            content: [{ type: "text", text: "STATUS: done\nCHANGES: implemented\nTESTS: passed" }],
          },
          isError: false,
        }),
      ].join("\n");

      const fakePi = createFakePi(temp.root, piOutput);

      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const runId = "${crypto.randomUUID()}";
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-json-no-usage",
            name: "wf/dev",
            workflowId: "wf",
            agentId: "wf_dev",
            intervalMinutes: 5,
            timeoutSeconds: 5,
            workdir: process.cwd(),
            createdAt: now,
          };

          const agent = {
            id: "dev",
            role: "coding",
            workspace: { baseDir: process.cwd(), files: {} },
          };

          await executePollingRound(job, agent);

          const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const logPath = path.join(process.env.HOME, ".tamandua", "tamandua.log");
          const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
          const logLines = logContent.split(/\\r?\\n/).filter(Boolean);

          const zeroJsonWarnings = logLines.filter(
            (line) => line.includes("WARN") && line.includes("--mode json may be off")
          );
          const usageMissingLogs = logLines.filter(
            (line) => line.includes("usage metadata missing")
          );

          console.log(JSON.stringify({
            tokensSpent: row.tokens_spent,
            zeroJsonWarningCount: zeroJsonWarnings.length,
            usageMissingLogCount: usageMissingLogs.length,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      // No zero-JSON warning when jsonMetadataDetected is true
      assert.equal(result.zeroJsonWarningCount, 0, "should not warn about --mode json when JSON events are detected");
      // The usage_metadata_missing log should still be present (debug writes at info level)
      assert.ok(result.usageMissingLogCount >= 1, "expected log entry for usage_metadata_missing");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
