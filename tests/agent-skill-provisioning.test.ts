import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provisionAgents } from "../dist/installer/agent-provision.js";

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function withStateDir<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.canarinho_STATE_DIR;
  process.env.canarinho_STATE_DIR = stateDir;
  return run().finally(() => {
    if (previous === undefined) delete process.env.canarinho_STATE_DIR;
    else process.env.canarinho_STATE_DIR = previous;
  });
}

describe("agent skill provisioning", () => {
  it("copies workflow-local agent skills into the provisioned agent directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canarinho-local-skill-"));
    const stateDir = path.join(root, "state");
    const workflowDir = path.join(root, "workflow");

    try {
      writeText(
        path.join(workflowDir, "agents", "developer", "skills", "local-helper", "SKILL.md"),
        "# local skill\n",
      );
      writeText(
        path.join(workflowDir, "agents", "developer", "skills", "local-helper", "examples", "example.md"),
        "example",
      );

      const workflow = {
        id: "workflow-local",
        agents: [
          {
            id: "developer",
            workspace: {
              baseDir: "agents/developer",
              files: {},
              skills: ["local-helper"],
            },
          },
        ],
        steps: [],
      };

      await withStateDir(stateDir, async () => {
        await provisionAgents({
          workflow,
          workflowDir,
        });
      });

      const copiedSkillDir = path.join(
        stateDir,
        "agents",
        "workflow-local_developer",
        "skills",
        "local-helper",
      );
      assert.equal(fs.existsSync(path.join(copiedSkillDir, "SKILL.md")), true);
      assert.equal(
        fs.readFileSync(path.join(copiedSkillDir, "examples", "example.md"), "utf-8"),
        "example",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies shared bundled skills from repository-level skills directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canarinho-shared-skill-"));
    const stateDir = path.join(root, "state");
    const workflowDir = path.join(root, "installed", "workflows", "workflow-shared");
    const bundledSourceDir = path.join(root, "bundled", "workflows", "workflow-shared");

    try {
      writeText(path.join(workflowDir, "agents", "developer", ".keep"), "");
      writeText(path.join(bundledSourceDir, "agents", "developer", ".keep"), "");
      writeText(
        path.join(root, "bundled", "skills", "canarinho-agents", "SKILL.md"),
        "# bundled shared skill\n",
      );
      writeText(
        path.join(root, "bundled", "skills", "canarinho-agents", "examples", "usage.md"),
        "shared usage",
      );

      const workflow = {
        id: "workflow-shared",
        agents: [
          {
            id: "developer",
            workspace: {
              baseDir: "agents/developer",
              files: {},
              skills: ["canarinho-agents"],
            },
          },
        ],
        steps: [],
      };

      await withStateDir(stateDir, async () => {
        await provisionAgents({
          workflow,
          workflowDir,
          bundledSourceDir,
        });
      });

      const copiedSkillDir = path.join(
        stateDir,
        "agents",
        "workflow-shared_developer",
        "skills",
        "canarinho-agents",
      );
      assert.equal(fs.existsSync(path.join(copiedSkillDir, "SKILL.md")), true);
      assert.equal(
        fs.readFileSync(path.join(copiedSkillDir, "examples", "usage.md"), "utf-8"),
        "shared usage",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
