/**
 * Tests for scripts/install.sh bundled workflow installation (US-001).
 *
 * Validates:
 * 1. install.sh calls canarinho workflow install --all after symlink creation
 * 2. install.sh does not fail if workflow installation fails (exit code still 0)
 * 3. Final output no longer instructs user to run canarinho get-ready manually
 * 4. The PATH reminder line is preserved
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "./helpers/test-env.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTALL_SCRIPT = path.resolve(__dirname, "..", "scripts", "install.sh");
const REPO_ROOT = path.resolve(__dirname, "..");

function createTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canarinho-inst-sh-"));
  const piAgentDir = path.join(dir, ".pi", "agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(
    path.join(piAgentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }),
    "utf-8",
  );
  return dir;
}

describe("scripts/install.sh — bundled workflow installation", () => {
  // AC 1: install.sh calls canarinho workflow install --all after symlink creation
  it("script source contains workflow install --all after symlink creation", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Must have the workflow install --all command
    assert.ok(
      content.includes("workflow install --all"),
      "install.sh should contain 'workflow install --all'",
    );

    // workflow install must appear after symlink creation
    const symlinkIdx = content.indexOf("ln -sf");
    const wfInstallIdx = content.indexOf("workflow install --all");
    assert.ok(symlinkIdx !== -1, "install.sh should contain symlink creation (ln -sf)");
    assert.ok(wfInstallIdx !== -1, "install.sh should contain workflow install --all");
    assert.ok(
      wfInstallIdx > symlinkIdx,
      "workflow install --all must appear after symlink creation",
    );
  });

  // AC 2: install.sh uses set +e / set -e to gracefully handle workflow install failures
  it("script uses set +e / set -e to protect against workflow install failure", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Find the block that wraps the workflow install
    const wfInstallIdx = content.indexOf("workflow install --all");
    const regionBefore = content.substring(wfInstallIdx - 200, wfInstallIdx);

    assert.ok(
      regionBefore.includes("set +e"),
      "workflow install should be preceded by 'set +e'",
    );

    // Check set -e appears after workflow install
    const regionAfter = content.substring(wfInstallIdx, wfInstallIdx + 200);
    assert.ok(
      regionAfter.includes("set -e"),
      "workflow install should be followed by 'set -e'",
    );

    // Verify exit code is captured
    assert.ok(
      content.includes("WF_INSTALL_EXIT=") || content.includes("INSTALL_EXIT="),
      "install.sh should capture workflow install exit code",
    );
  });

  // AC 3: Final output no longer instructs user to run canarinho get-ready manually
  it("output no longer mentions 'canarinho get-ready'", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Should NOT instruct user to run get-ready manually
    assert.ok(
      !content.includes("Run: canarinho get-ready"),
      "install.sh should NOT instruct user to run 'canarinho get-ready' manually",
    );
    assert.ok(
      !content.includes("canarinho get-ready"),
      "install.sh should NOT reference 'canarinho get-ready' anywhere",
    );
  });

  // AC 4: The PATH reminder line is preserved
  it("preserves PATH reminder line", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    assert.ok(
      content.includes("Make sure ~/.local/bin is in your PATH"),
      "install.sh should preserve the PATH reminder line",
    );
  });

  // Integration: run install.sh --local and verify workflows are installed
  it("install.sh --local installs bundled workflows and exits 0", async (t) => {
    const cliScript = path.resolve(__dirname, "..", "dist", "cli", "cli.js");
    if (!fs.existsSync(cliScript)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const tempHome = createTempHome();
    try {
      // Run install.sh --local with isolated HOME
      const result = spawnSync("bash", [INSTALL_SCRIPT, "--local", REPO_ROOT], {
        env: cleanChildEnv({ HOME: tempHome }),
        timeout: 120_000, // 2 minute timeout for npm install + build
        encoding: "utf-8",
      });

      const stdout = result.stdout || "";
      const stderr = result.stderr || "";

      // Must exit 0 even if workflow install had issues
      assert.equal(
        result.status,
        0,
        `install.sh should exit 0. Status: ${result.status}, stderr: ${stderr.slice(0, 500)}`,
      );

      // Output should NOT mention get-ready
      assert.ok(
        !stdout.includes("canarinho get-ready"),
        `Output should not mention 'canarinho get-ready'. Got: ${stdout.slice(0, 500)}`,
      );

      // Output should mention success
      assert.ok(
        stdout.includes("canarinho installed successfully!"),
        `Expected 'canarinho installed successfully!' in output. Got: ${stdout.slice(0, 500)}`,
      );

      // PATH reminder should be present
      assert.ok(
        stdout.includes("Make sure ~/.local/bin is in your PATH"),
        `Expected PATH reminder in output. Got: ${stdout.slice(0, 500)}`,
      );

      // Symlink should exist and be executable
      const symlinkPath = path.join(tempHome, ".local", "bin", "canarinho");
      assert.ok(
        fs.existsSync(symlinkPath),
        `Symlink should exist at ${symlinkPath}`,
      );

      // Workflow directories should exist
      const workflowsRoot = path.join(tempHome, ".canarinho", "workflows");
      assert.ok(
        fs.existsSync(workflowsRoot),
        `Workflows directory should exist at ${workflowsRoot}`,
      );

      // At least one workflow directory should exist
      const wfEntries = fs.readdirSync(workflowsRoot, { withFileTypes: true });
      const wfDirs = wfEntries.filter((e) => e.isDirectory());
      assert.ok(
        wfDirs.length > 0,
        `Expected at least one workflow directory in ${workflowsRoot}. stderr: ${stderr.slice(0, 300)}`,
      );

      // agents.json should be populated
      const agentsPath = path.join(tempHome, ".canarinho", "agents.json");
      assert.ok(fs.existsSync(agentsPath), "agents.json should exist");
      const agents = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
      assert.ok(Array.isArray(agents), "agents.json should be an array");
      assert.ok(agents.length > 0, "agents.json should have entries");

      // Should have workflow-prefixed agents
      const workflowAgents = agents.filter(
        (a: Record<string, unknown>) =>
          typeof a.id === "string" && (a.id as string).includes("_"),
      );
      assert.ok(
        workflowAgents.length > 0,
        `agents.json should have workflow agents, got: ${agents.map((a: Record<string, unknown>) => a.id).join(", ")}`,
      );
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // Verify the warning message appears when workflow install fails
  it("prints warning when workflow installation fails", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Script should have a conditional warning
    assert.ok(
      content.includes("Warning: workflow installation failed"),
      "install.sh should print a warning when workflow installation fails",
    );
  });

  // Verify WF_INSTALL_EXIT is checked
  it("checks workflow install exit code", () => {
    const content = fs.readFileSync(INSTALL_SCRIPT, "utf-8");

    // Captures exit code
    assert.ok(
      content.includes("WF_INSTALL_EXIT="),
      "install.sh should capture WF_INSTALL_EXIT",
    );

    // Checks exit code for non-zero
    assert.ok(
      content.includes("$WF_INSTALL_EXIT -ne 0"),
      "install.sh should check WF_INSTALL_EXIT for non-zero",
    );
  });
});
