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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-system-token-attribution-"));
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

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }

  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("system token attribution (US-002)", () => {
  it("records tokens from polling rounds with unresolvable run ID in tamandua_stats.system_tokens_spent", () => {
    const temp = createTempHome();

    try {
      // No run ID or step ID in the output — unresolvable run
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
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

          const db = getDb();
          const runId = "${crypto.randomUUID()}";
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 13, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-system-attribution",
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

          const runRow = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const systemTokens = getSystemTokenSpend();

          console.log(JSON.stringify({
            runTokensSpent: runRow.tokens_spent,
            systemTokensSpent: systemTokens,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      // Run tokens should be unchanged (13 from initial insert)
      assert.equal(result.runTokensSpent, 13, "run tokens_spent should not change for unresolvable run ID");
      // System tokens should now be 55 (the 55 tokens from the polling round)
      assert.equal(result.systemTokensSpent, 55, "system_tokens_spent should record the 55 tokens");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("existing run-attributed token increments are unaffected (regression guard)", () => {
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
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

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
            id: "job-run-attribution-regression",
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

          const runRow = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const systemTokens = getSystemTokenSpend();

          console.log(JSON.stringify({
            runTokensSpent: runRow.tokens_spent,
            systemTokensSpent: systemTokens,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      // Run tokens should have increased by 100 (7 + 100 = 107)
      assert.equal(result.runTokensSpent, 107, "run tokens_spent should be 107 (7 + 100)");
      // System tokens should remain 0 — attribution went to the run, not system
      assert.equal(result.systemTokensSpent, 0, "system_tokens_spent should remain 0 when run ID is resolvable");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("heartbeat rounds attribute token usage to system spend, leaving run unchanged — neither run nor system", () => {
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
            id: "job-heartbeat-system",
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

          const runRow = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId);
          const systemTokens = getSystemTokenSpend();
          const logPath = path.join(process.env.HOME, ".tamandua", "tamandua.log");
          const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

          console.log(JSON.stringify({
            runTokensSpent: runRow.tokens_spent,
            systemTokensSpent: systemTokens,
            heartbeatSystemOverheadSeen: logContent.includes('"reason":"heartbeat_system_overhead"'),
            systemAttributionSeen: logContent.includes("attributed to system spend"),
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      // Run tokens unchanged
      assert.equal(result.runTokensSpent, 3, "run tokens_spent should remain 3 for heartbeat");
      // System tokens should now capture the heartbeat usage
      assert.equal(result.systemTokensSpent, 21, "system_tokens_spent should become 21 for heartbeat");
      // Heartbeat system overhead log should be present
      assert.equal(result.heartbeatSystemOverheadSeen, true, "heartbeat_system_overhead should be logged");
      // System attribution log line should appear (via shared "attributed to system spend" message)
      assert.equal(result.systemAttributionSeen, true, "system attribution should happen for heartbeat rounds");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("system.tokens.updated event is emitted with tokenDelta and tokensSpent", () => {
    const temp = createTempHome();

    try {
      const piOutput = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STATUS: done\nCHANGES: n/a\nTESTS: n/a" }],
          usage: { totalTokens: 42 },
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
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-system-event",
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

          const eventsPath = path.join(process.env.HOME, ".tamandua", "events", "system.jsonl");
          const events = fs.existsSync(eventsPath)
            ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line))
            : [];
          const systemEvent = events.find((evt) => evt.event === "system.tokens.updated");

          console.log(JSON.stringify({
            eventFound: !!systemEvent,
            runId: systemEvent?.runId ?? null,
            tokenDelta: systemEvent?.tokenDelta ?? null,
            tokensSpent: systemEvent?.tokensSpent ?? null,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      assert.equal(result.eventFound, true, "system.tokens.updated event should be emitted");
      assert.equal(result.runId, "system", "runId should be 'system' sentinel");
      assert.equal(result.tokenDelta, 42, "tokenDelta should be 42");
      assert.equal(result.tokensSpent, 42, "tokensSpent should be 42 (total system spend)");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("accumulates system tokens across multiple polling rounds", () => {
    const temp = createTempHome();

    try {
      // Round 1: 30 tokens
      const piOutput1 = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STATUS: done" }],
          usage: { totalTokens: 30 },
          stopReason: "stop",
        },
      });

      const fakePi = createFakePi(temp.root, piOutput1);

      runNodeScript(
        `
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb } from "./dist/db.js";

          const db = getDb();
          const runId = "${crypto.randomUUID()}";
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-accum-1",
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
          console.log(JSON.stringify({ done: true }));
        `,
        { HOME: temp.homeDir, TAMANDUA_PI_BINARY: fakePi },
      );

      // Round 2: 20 tokens (same fake Pi, same unresolvable output)
      const result = runNodeScript(
        `
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb, getSystemTokenSpend } from "./dist/db.js";

          const db = getDb();
          const runId = "${crypto.randomUUID()}";
          const now = new Date().toISOString();

          db.prepare(
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          // Write a different pi payload with 20 tokens for this round
          const fs = await import("node:fs");
          const piPath = process.env.TAMANDUA_PI_BINARY;
          fs.writeFileSync(
            piPath,
            "#!/usr/bin/env node\\nprocess.stdout.write(" + JSON.stringify(JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "STATUS: done" }],
                usage: { totalTokens: 20 },
                stopReason: "stop",
              },
            })) + ");\\n"
          );

          const job = {
            id: "job-accum-2",
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

          const systemTokens = getSystemTokenSpend();

          console.log(JSON.stringify({ systemTokensSpent: systemTokens }));
        `,
        { HOME: temp.homeDir, TAMANDUA_PI_BINARY: fakePi },
      );

      // 30 + 20 = 50
      assert.equal(result.systemTokensSpent, 50, "system_tokens_spent should be 50 (30 + 20)");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("WARN log still fires for unresolved run IDs and INFO log fires for successful system attribution", () => {
    const temp = createTempHome();

    try {
      const piOutput = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "STATUS: done" }],
          usage: { totalTokens: 33 },
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
            "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'wf', 'task', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          const job = {
            id: "job-logs-check",
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

          const logPath = path.join(process.env.HOME, ".tamandua", "tamandua.log");
          const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

          const warnLinePresent = logContent.includes("not attributed to run — run id unresolved");
          const infoLinePresent = logContent.includes("attributed to system spend");

          console.log(JSON.stringify({
            warnLinePresent,
            infoLinePresent,
          }));
        `,
        {
          HOME: temp.homeDir,
          TAMANDUA_PI_BINARY: fakePi,
        },
      );

      assert.equal(result.warnLinePresent, true, "WARN log should still fire for unresolved run IDs");
      assert.equal(result.infoLinePresent, true, "INFO log should fire for successful system attribution");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
