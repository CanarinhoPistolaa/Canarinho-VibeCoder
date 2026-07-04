import { describe, it } from "node:test";
import assert from "node:assert";
import { parseWorkflowRunArgs } from "../../dist/cli/workflow-run-args.js";

describe("parseWorkflowRunArgs", () => {
  it("parses task only", () => {
    const result = parseWorkflowRunArgs(["Do something"]);
    assert.equal(result.taskTitle, "Do something");
    assert.deepEqual(result.context, {});
  });

  it("parses --context with single key=value", () => {
    const result = parseWorkflowRunArgs(["Some task", "--context", "branch=feature/x"]);
    assert.equal(result.taskTitle, "Some task");
    assert.deepEqual(result.context, { branch: "feature/x" });
  });

  it("parses --context with value containing =", () => {
    const result = parseWorkflowRunArgs(["task", "--context", "url=http://example.com?a=b&c=d"]);
    assert.deepEqual(result.context, { url: "http://example.com?a=b&c=d" });
  });

  it("parses multiple --context flags", () => {
    const result = parseWorkflowRunArgs([
      "Multi context",
      "--context", "branch=fix/bug",
      "--context", "env=staging",
      "--context", "repo=/tmp/repo",
    ]);
    assert.deepEqual(result.context, {
      branch: "fix/bug",
      env: "staging",
      repo: "/tmp/repo",
    });
  });

  it("rejects --context with missing =", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "novalueseparator"]),
      /must contain '='/,
    );
  });

  it("rejects --context with empty key", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "=value"]),
      /key must be non-empty/,
    );
  });

  it("rejects duplicate --context keys", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "branch=a", "--context", "branch=b"]),
      /Duplicate --context key "branch"/,
    );
  });

  it("rejects --context with missing value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context"]),
      /Missing value for --context/,
    );
  });

  it("parses context alongside other flags", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--context", "branch=quarantine/broken-tests",
      "Quarantine broken tests",
      "--context", "repo=/tmp/myapp",
    ]);
    assert.equal(result.taskTitle, "Quarantine broken tests");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.deepEqual(result.context, {
      branch: "quarantine/broken-tests",
      repo: "/tmp/myapp",
    });
  });

  it("parses empty context when no --context flags provided", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--worktree-origin-repository", "/tmp/repo",
      "Build feature",
    ]);
    assert.equal(result.taskTitle, "Build feature");
    assert.deepEqual(result.context, {});
    assert.equal(result.worktreeOriginRepository, "/tmp/repo");
  });
});
