import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readmePath = resolve(import.meta.dirname, "..", "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");

// Tool names as defined in src/server/mcp-server.ts
const allMcpTools = [
  "canarinho.runs.list",
  "canarinho.run.status",
  "canarinho.run.start",
  "canarinho.run.pause",
  "canarinho.run.resume",
  "canarinho.run.delete",
  "canarinho.events.recent",
  "canarinho.skill.path",
  "canarinho.source.path",
  "canarinho.update.command",
  "canarinho.autoresearch.init",
  "canarinho.autoresearch.run_experiment",
  "canarinho.autoresearch.log_experiment",
  "canarinho.autoresearch.status",
];

describe("README MCP tools documentation", () => {
  it("lists all 14 MCP tools", () => {
    assert.equal(allMcpTools.length, 14, "There should be exactly 14 MCP tools");
    for (const tool of allMcpTools) {
      const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp("`" + escaped + "`");
      assert.ok(
        pattern.test(readmeContent),
        `MCP tool '${tool}' must be documented in README.md`
      );
    }
  });

  it("documents canarinho.run.pause with its parameters", () => {
    assert.ok(
      readmeContent.includes("canarinho.run.pause"),
      "README must document canarinho.run.pause"
    );
    assert.ok(
      readmeContent.includes("runId"),
      "canarinho.run.pause documentation must mention runId parameter"
    );
    assert.ok(
      readmeContent.includes("drain"),
      "canarinho.run.pause documentation must mention drain parameter"
    );
  });

  it("documents canarinho.run.resume with its parameters", () => {
    assert.ok(
      readmeContent.includes("canarinho.run.resume"),
      "README must document canarinho.run.resume"
    );
    assert.ok(
      readmeContent.includes("runId"),
      "canarinho.run.resume documentation must mention runId parameter"
    );
  });

  it("documents canarinho.run.delete with its parameters", () => {
    assert.ok(
      readmeContent.includes("canarinho.run.delete"),
      "README must document canarinho.run.delete"
    );
    assert.ok(
      readmeContent.includes("force"),
      "canarinho.run.delete documentation must mention force parameter"
    );
  });

  it("documents canarinho.run.start worktree parameters", () => {
    assert.ok(
      readmeContent.includes("worktreeOriginRepository"),
      "README must document worktreeOriginRepository parameter for run.start"
    );
    assert.ok(
      readmeContent.includes("worktreeOriginRef"),
      "README must document worktreeOriginRef parameter for run.start"
    );
    assert.ok(
      readmeContent.includes("noHurrySaveTokensMode"),
      "README must document noHurrySaveTokensMode parameter for run.start"
    );
  });

  it("documents workingDirectoryForHarness and worktreeOriginRepository mutual exclusivity", () => {
    assert.ok(
      readmeContent.includes("mutually exclusive"),
      "README must state workingDirectoryForHarness and worktreeOriginRepository are mutually exclusive"
    );
  });

  it("parameter descriptions match mcp-server.ts requirements", () => {
    // Verify that key descriptions from the MCP server are reflected in the README
    assert.ok(
      readmeContent.includes("Harness working directory"),
      "README must describe workingDirectoryForHarness as harness working directory"
    );
    assert.ok(
      readmeContent.includes("pi-token-saver"),
      "README must document the pi-token-saver wrapper for noHurrySaveTokensMode"
    );
    assert.ok(
      readmeContent.includes("hermes-token-saver"),
      "README must document the hermes-token-saver wrapper for noHurrySaveTokensMode"
    );
    assert.ok(
      readmeContent.includes("wait for in-flight work"),
      "README must describe drain parameter behavior for canarinho.run.pause"
    );
    assert.ok(
      readmeContent.includes("Pause a running"),
      "README must describe canarinho.run.pause as pausing a running workflow"
    );
    assert.ok(
      readmeContent.includes("Resume a paused"),
      "README must describe canarinho.run.resume as resuming a paused workflow"
    );
  });
});
