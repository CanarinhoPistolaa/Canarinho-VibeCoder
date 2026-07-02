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
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function createTempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-run-token-observability-e2e-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function runNodeScript(script: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv(env),
    encoding: "utf-8",
  });

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

describe("run token observability end-to-end (US-005 integration verification)", () => {
  it("verifies complete data flow: pi output → parse → attribute → increment → emit → DB → dashboard API → CLI logs → CLI status → CLI runs", () => {
    const temp = createTempHome();

    try {
      const result = runNodeScript(
        `
          import fs from "node:fs";
          import path from "node:path";
          import { once } from "node:events";
          import { spawnSync } from "node:child_process";
          import { executePollingRound } from "./dist/installer/agent-scheduler.js";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runA = "11111111-1111-4111-8111-111111111111";
          const runB = "22222222-2222-4222-8222-222222222222";
          const stepA = "33333333-3333-4333-8333-333333333333";
          const stepB = "44444444-4444-4444-8444-444444444444";
          const workflowId = "wf-token-observability";
          const now = new Date().toISOString();

          const db = getDb();
          db.prepare("DELETE FROM steps WHERE run_id IN (?, ?)").run(runA, runB);
          db.prepare("DELETE FROM runs WHERE id IN (?, ?)").run(runA, runB);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, ?, 'Primary token flow', 'running', '{}', 20, ?, ?)"
          ).run(runA, workflowId, now, now);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, ?, 'Secondary token flow', 'running', '{}', 5, ?, ?)"
          ).run(runB, workflowId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement-primary', 'wf_token_observability_dev', 0, '', '', 'running', ?, ?)"
          ).run(stepA, runA, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at) VALUES (?, ?, 'implement-secondary', 'wf_token_observability_dev', 1, '', '', 'running', ?, ?)"
          ).run(stepB, runB, now, now);

          const fakePiPath = path.join(process.env.HOME, "fake-pi");
          const job = {
            id: "job-token-observability",
            name: "wf-token-observability/dev",
            workflowId,
            agentId: "wf_token_observability_dev",
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

          function setFakePiOutput(payload) {
            fs.writeFileSync(
              fakePiPath,
              "#!/usr/bin/env node\\nprocess.stdout.write(" + JSON.stringify(payload) + ");\\n",
              "utf-8",
            );
            fs.chmodSync(fakePiPath, 0o755);
            process.env.TAMANDUA_PI_BINARY = fakePiPath;
          }

          async function runRound(payload) {
            setFakePiOutput(payload);
            await executePollingRound(job, agent);
          }

          // Assumptions for regression coverage:
          // - run/step attribution hints come from tool_execution_* text that contains stepId/runId.
          // - token usage comes from message_end.message.usage fields.
          await runRound([
            JSON.stringify({
              type: "tool_execution_end",
              toolName: "bash",
              result: {
                content: [{ type: "text", text: JSON.stringify({ stepId: stepA }) }],
              },
              isError: false,
            }),
            JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "STATUS: done\\nCHANGES: round-1\\nTESTS: n/a" }],
                usage: { input: 12, output: 8 },
                stopReason: "stop",
              },
            }),
          ].join("\\n"));

          await runRound(JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "HEARTBEAT_OK" }],
              usage: { totalTokens: 999 },
              stopReason: "stop",
            },
          }));

          await runRound([
            JSON.stringify({
              type: "tool_execution_end",
              toolName: "bash",
              result: {
                content: [{ type: "text", text: JSON.stringify({ stepId: stepB, runId: runB }) }],
              },
              isError: false,
            }),
            JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "STATUS: done\\nCHANGES: round-3\\nTESTS: n/a" }],
                usage: { totalTokens: 30 },
                stopReason: "stop",
              },
            }),
          ].join("\\n"));

          await runRound([
            JSON.stringify({
              type: "tool_execution_end",
              toolName: "bash",
              result: {
                content: [{ type: "text", text: JSON.stringify({ runId: runA }) }],
              },
              isError: false,
            }),
            JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "STATUS: done\\nCHANGES: round-4\\nTESTS: n/a" }],
                usage: { inputTokens: 9, outputTokens: 6 },
                stopReason: "stop",
              },
            }),
          ].join("\\n"));

          const runRows = db.prepare("SELECT id, tokens_spent FROM runs WHERE id IN (?, ?) ORDER BY id ASC").all(runA, runB);
          const eventsPath = path.join(process.env.HOME, ".tamandua", "events", "all.jsonl");
          const allEvents = fs.existsSync(eventsPath)
            ? fs.readFileSync(eventsPath, "utf-8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line))
            : [];
          const tokenEvents = allEvents.filter((evt) => evt.event === "run.tokens.updated");

          const cliPath = path.join(process.cwd(), "dist", "cli", "cli.js");
          const childEnv = {};
          for (const key of [
            "PATH",
            "HOME",
            "TMPDIR",
            "TEMP",
            "TMP",
            "TAMANDUA_STATE_DIR",
            "TAMANDUA_DB_PATH",
            "TAMANDUA_WORKTREE_ROOT",
          ]) {
            const value = process.env[key];
            if (value !== undefined) childEnv[key] = value;
          }

          const logsResult = spawnSync(process.execPath, [cliPath, "logs", "200"], {
            env: childEnv,
            encoding: "utf-8",
          });

          const statusAResult = spawnSync(process.execPath, [cliPath, "workflow", "status", runA], {
            env: childEnv,
            encoding: "utf-8",
          });

          const statusBResult = spawnSync(process.execPath, [cliPath, "workflow", "status", runB], {
            env: childEnv,
            encoding: "utf-8",
          });

          const runsResult = spawnSync(process.execPath, [cliPath, "workflow", "runs"], {
            env: childEnv,
            encoding: "utf-8",
          });

          const server = createDashboardServer(0);
          if (!server.listening) {
            await once(server, "listening");
          }

          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Unexpected dashboard address");
          }

          const baseUrl = "http://127.0.0.1:" + address.port;
          let dashboard = {};

          try {
            const listRes = await fetch(baseUrl + "/api/runs");
            const listBody = await listRes.json();
            const detailRes = await fetch(baseUrl + "/api/runs/" + runA);
            const detailBody = await detailRes.json();
            const eventsRes = await fetch(baseUrl + "/api/events?limit=20");
            const eventsBody = await eventsRes.json();

            dashboard = {
              listStatus: listRes.status,
              detailStatus: detailRes.status,
              eventsStatus: eventsRes.status,
              listTokens: (listBody.runs || [])
                .filter((row) => row.id === runA || row.id === runB)
                .map((row) => ({ id: row.id, tokens: row.tokens_spent })),
              detailTokens: detailBody?.run?.tokens_spent ?? null,
              apiTokenEvents: (eventsBody.events || [])
                .filter((evt) => evt.event === "run.tokens.updated")
                .map((evt) => ({ runId: evt.runId, tokenDelta: evt.tokenDelta, tokensSpent: evt.tokensSpent })),
            };
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }

          console.log(JSON.stringify({
            runRows,
            tokenEvents: tokenEvents.map((evt) => ({ runId: evt.runId, tokenDelta: evt.tokenDelta, tokensSpent: evt.tokensSpent })),
            logsStatus: logsResult.status,
            logsStdout: logsResult.stdout,
            logsStderr: logsResult.stderr,
            statusAStatus: statusAResult.status,
            statusAStdout: statusAResult.stdout,
            statusAStderr: statusAResult.stderr,
            statusBStatus: statusBResult.status,
            statusBStdout: statusBResult.stdout,
            statusBStderr: statusBResult.stderr,
            runsStatus: runsResult.status,
            runsStdout: runsResult.stdout,
            runsStderr: runsResult.stderr,
            dashboard,
          }));
        `,
        { HOME: temp.homeDir },
      );

      assert.deepEqual(result.runRows, [
        { id: "11111111-1111-4111-8111-111111111111", tokens_spent: 55 },
        { id: "22222222-2222-4222-8222-222222222222", tokens_spent: 35 },
      ]);

      assert.deepEqual(result.tokenEvents, [
        { runId: "11111111-1111-4111-8111-111111111111", tokenDelta: 20, tokensSpent: 40 },
        { runId: "22222222-2222-4222-8222-222222222222", tokenDelta: 30, tokensSpent: 35 },
        { runId: "11111111-1111-4111-8111-111111111111", tokenDelta: 15, tokensSpent: 55 },
      ]);

      assert.equal(result.logsStatus, 0);
      const logsStdout = String(result.logsStdout ?? "");
      assert.match(logsStdout, /Token spend updated/);
      assert.match(logsStdout, /\[tokens: Δ \+20, total 40\]/);
      assert.match(logsStdout, /\[tokens: Δ \+30, total 35\]/);
      assert.match(logsStdout, /\[tokens: Δ \+15, total 55\]/);
      assert.equal(String(result.logsStderr ?? "").includes("Error:"), false);

      // AC 2 (CLI workflow status): both runs show correct Tokens line
      assert.equal(result.statusAStatus, 0);
      const statusAStdout = String(result.statusAStdout ?? "");
      assert.match(statusAStdout, /Run: 11111111/);
      assert.match(statusAStdout, /Tokens: 55/);
      assert.match(statusAStdout, /Steps:/);
      assert.equal(String(result.statusAStderr ?? "").replace(/^\(node:\d+\) ExperimentalWarning.*\n.*\n/gm, ""), "");

      assert.equal(result.statusBStatus, 0);
      const statusBStdout = String(result.statusBStdout ?? "");
      assert.match(statusBStdout, /Run: 22222222/);
      assert.match(statusBStdout, /Tokens: 35/);
      assert.match(statusBStdout, /Steps:/);
      assert.equal(String(result.statusBStderr ?? "").replace(/^\(node:\d+\) ExperimentalWarning.*\n.*\n/gm, ""), "");

      // AC 3 (CLI workflow runs): both runs appear with token counts
      assert.equal(result.runsStatus, 0);
      const runsStdout = String(result.runsStdout ?? "");
      assert.match(runsStdout, /Workflow runs:/);
      assert.match(runsStdout, /11111111/);
      assert.match(runsStdout, /55.*tokens/);
      assert.match(runsStdout, /22222222/);
      assert.match(runsStdout, /35.*tokens/);
      assert.equal(String(result.runsStderr ?? "").replace(/^\(node:\d+\) ExperimentalWarning.*\n.*\n/gm, ""), "");

      assert.deepEqual(result.dashboard, {
        listStatus: 200,
        detailStatus: 200,
        eventsStatus: 200,
        listTokens: [
          { id: "11111111-1111-4111-8111-111111111111", tokens: 55 },
          { id: "22222222-2222-4222-8222-222222222222", tokens: 35 },
        ],
        detailTokens: 55,
        apiTokenEvents: [
          { runId: "11111111-1111-4111-8111-111111111111", tokenDelta: 20, tokensSpent: 40 },
          { runId: "22222222-2222-4222-8222-222222222222", tokenDelta: 30, tokensSpent: 35 },
          { runId: "11111111-1111-4111-8111-111111111111", tokenDelta: 15, tokensSpent: 55 },
        ],
      });
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
