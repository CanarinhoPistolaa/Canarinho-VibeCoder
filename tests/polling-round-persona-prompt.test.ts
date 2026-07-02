/**
 * MOTOR-MECHANISM: pins the CURRENT model-driven polling motor.
 *
 * This test asserts implementation details of the polling motor (model-run
 * peek/claim rounds, polling prompts, heartbeat system-token attribution).
 * It is EXPECTED to churn or be replaced when the deterministic motor lands.
 * During the motor rewrite: a failure here is expected noise; a failure in a
 * contract test is a real regression. See tests/MOTOR-CONTRACT.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

function createTempState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-persona-prompt-"));
  const homeDir = path.join(root, "home");
  const stateDir = path.join(homeDir, ".tamandua");
  const harnessDir = path.join(root, "harness-repo");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(harnessDir, { recursive: true });
  return { root, homeDir, stateDir, harnessDir };
}

function createFakePi(root: string): { fakePi: string; capturePath: string } {
  const fakePi = path.join(root, "fake-pi");
  const capturePath = path.join(root, "captured-pi-invocation.json");
  fs.writeFileSync(
    fakePi,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const capture = {",
      "  cwd: process.cwd(),",
      "  argv: process.argv.slice(2),",
      "  prompt: process.argv[process.argv.length - 1] || \"\",",
      "};",
      "fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(capture));",
      "process.stdout.write(\"HEARTBEAT_OK\");",
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(fakePi, 0o755);
  return { fakePi, capturePath };
}

describe("executePollingRound persona prompt injection", () => {
  it("runs pi in the harness cwd while embedding AGENTS.md, IDENTITY.md, and SOUL.md", async () => {
    const temp = createTempState();
    const { fakePi, capturePath } = createFakePi(temp.root);
    const runId = crypto.randomUUID();
    const agentId = "feature-dev-merge_merger";
    const agentWorkspace = path.join(temp.stateDir, "workspaces", "workflows", agentId);
    const originalHome = process.env.HOME;
    const originalStateDir = process.env.TAMANDUA_STATE_DIR;
    const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
    const originalCapturePath = process.env.CAPTURE_PATH;

    fs.mkdirSync(agentWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(agentWorkspace, "AGENTS.md"),
      [
        "# Agent instructions sentinel",
        "Commit messages must include this footer:",
        "Co-Authored-By: Tamandua <tamandua@tetradactyla.org>",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentWorkspace, "IDENTITY.md"),
      "# Identity sentinel\nYou are the test merger identity.\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(agentWorkspace, "SOUL.md"),
      "# Soul sentinel\nYou preserve the test merger principles.\n",
      "utf-8",
    );

    try {
      process.env.HOME = temp.homeDir;
      process.env.TAMANDUA_STATE_DIR = temp.stateDir;
      process.env.TAMANDUA_PI_BINARY = fakePi;
      process.env.CAPTURE_PATH = capturePath;

      const { executePollingRound } = await import("../dist/installer/agent-scheduler.js");
      const { getDb } = await import("../dist/db.js");
      const db = getDb();
      const now = new Date().toISOString();

      db.prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 'feature-dev-merge', 'persona prompt test', 'running', '{}', 0, ?, ?)",
      ).run(runId, now, now);

      const job = {
        id: "job-persona-prompt",
        workflowId: "feature-dev-merge",
        runId,
        agentId,
        intervalMinutes: 5,
        timeoutSeconds: 5,
        workingDirectoryForHarness: temp.harnessDir,
        createdAt: now,
      };

      const agent = {
        id: "merger",
        role: "pr" as const,
        workspace: { baseDir: "ignored", files: {} },
      };

      await executePollingRound(job, agent);

      const result = JSON.parse(fs.readFileSync(capturePath, "utf-8")) as Record<string, unknown>;

      assert.equal(result.cwd, temp.harnessDir);

      const argv = result.argv;
      assert.ok(Array.isArray(argv), "fake pi should capture argv");
      assert.deepEqual(argv.slice(0, 4), ["--print", "--mode", "json", "--no-session"]);

      const prompt = result.prompt;
      assert.equal(typeof prompt, "string");
      assert.ok((prompt as string).includes("PROVISIONED AGENT PERSONA"));
      assert.ok((prompt as string).includes("### AGENTS.md"));
      assert.ok((prompt as string).includes("Agent instructions sentinel"));
      assert.ok((prompt as string).includes("Co-Authored-By: Tamandua <tamandua@tetradactyla.org>"));
      assert.ok((prompt as string).includes("### IDENTITY.md"));
      assert.ok((prompt as string).includes("Identity sentinel"));
      assert.ok((prompt as string).includes("### SOUL.md"));
      assert.ok((prompt as string).includes("Soul sentinel"));
      assert.ok((prompt as string).includes(`step peek "${agentId}" --run-id "${runId}"`));
      assert.ok((prompt as string).includes(`step claim "${agentId}" --run-id "${runId}"`));
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = originalStateDir;
      if (originalPiBinary === undefined) delete process.env.TAMANDUA_PI_BINARY;
      else process.env.TAMANDUA_PI_BINARY = originalPiBinary;
      if (originalCapturePath === undefined) delete process.env.CAPTURE_PATH;
      else process.env.CAPTURE_PATH = originalCapturePath;
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });
});
