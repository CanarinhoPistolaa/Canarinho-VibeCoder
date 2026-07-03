import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveBundledWorkflowsDir, resolveSourcePath } from "../dist/installer/paths.js";

const workflowsDir = resolveBundledWorkflowsDir();
const sourcePath = resolveSourcePath();
const wwwHtmlPath = join(sourcePath, "www", "index.html");
const mcpServerPath = join(sourcePath, "src", "server", "mcp-server.ts");

const wwwContent = readFileSync(wwwHtmlPath, "utf-8");
const mcpServerContent = readFileSync(mcpServerPath, "utf-8");

const bundledIds = readdirSync(workflowsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(resolve(workflowsDir, d.name, "workflow.yml")))
  .map((d) => d.name);

// Count MCP_TOOL_* constant definitions from the source file.
// These are declared as `const MCP_TOOL_X = "tamandua.xxx";` at column 0,
// so ^const MCP_TOOL_ with the multiline flag is precise.
const mcpToolCount = (mcpServerContent.match(/^const MCP_TOOL_\w+ = /gm) || []).length;

describe("www/index.html content sync", () => {
  it("reports the correct bundled workflow count", () => {
    const count = bundledIds.length;
    assert.ok(
      wwwContent.includes(`${count} bundled workflows`),
      `www/index.html should show "${count} bundled workflows" (filesystem has ${count})`,
    );
  });

  it("reports the correct MCP tool count", () => {
    assert.ok(
      wwwContent.includes(`${mcpToolCount} tools at`),
      `www/index.html should show "${mcpToolCount} tools at" (mcp-server.ts defines ${mcpToolCount} MCP_TOOL_ constants)`,
    );
  });

  it("has all five workflow family section headings", () => {
    const headings = [
      "Feature Development",
      "Bug Fix",
      "Security Audit",
      "Quarantine Broken Tests",
      "Quick Tasks",
    ];
    for (const heading of headings) {
      assert.ok(
        wwwContent.includes(`<h3>${heading}</h3>`),
        `www/index.html must have <h3>${heading}</h3> section heading`,
      );
    }
  });

  it("does not contain forbidden phrases", () => {
    const forbidden = [
      "poll for work",
      "polling frequency",
      "SQLite + polling",
      "poll immediately",
    ];
    for (const phrase of forbidden) {
      assert.ok(
        !wwwContent.includes(phrase),
        `www/index.html must not contain forbidden phrase: "${phrase}"`,
      );
    }
  });
});
