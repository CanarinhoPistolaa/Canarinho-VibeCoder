import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDefaultUpdateServices,
  defaultRunCommand,
  installAllBundledWorkflowsForUpdate,
} from "../../dist/cli/update.js";

describe("update exports", () => {
  describe("createDefaultUpdateServices", () => {
    it("returns an object with snapshot, stop, and start functions", () => {
      const services = createDefaultUpdateServices();
      assert.equal(typeof services.snapshot, "function");
      assert.equal(typeof services.stopDashboard, "function");
      assert.equal(typeof services.stopMcp, "function");
      assert.equal(typeof services.stopControlPlane, "function");
      assert.equal(typeof services.startDashboard, "function");
      assert.equal(typeof services.startMcp, "function");
      assert.equal(typeof services.startControlPlane, "function");
    });

    it("snapshot returns an object with dashboard, mcp, and controlPlane", () => {
      const services = createDefaultUpdateServices();
      const snap = services.snapshot();
      assert.ok("dashboard" in snap);
      assert.ok("mcp" in snap);
      assert.ok("controlPlane" in snap);
      assert.equal(typeof snap.dashboard.running, "boolean");
      assert.equal(typeof snap.mcp.running, "boolean");
      assert.equal(typeof snap.controlPlane.running, "boolean");
    });
  });

  describe("defaultRunCommand", () => {
    it("executes a simple command and returns stdout", async () => {
      const result = await defaultRunCommand("echo", ["hello"], {
        cwd: "/tmp",
        stdio: "pipe",
      });
      assert.ok(result.stdout.includes("hello"));
      assert.equal(result.stderr, "");
    });

    it("rejects on non-zero exit", async () => {
      await assert.rejects(
        defaultRunCommand("sh", ["-c", "exit 1"], {
          cwd: "/tmp",
          stdio: "pipe",
        }),
        /Command failed/,
      );
    });

    it("captures stderr", async () => {
      const result = await defaultRunCommand("sh", ["-c", "echo err >&2; echo out"], {
        cwd: "/tmp",
        stdio: "pipe",
      });
      assert.ok(result.stdout.includes("out"));
      assert.ok(result.stderr.includes("err"));
    });
  });

  describe("installAllBundledWorkflowsForUpdate", () => {
    it("installs workflows from the provided list", async () => {
      const installed: string[] = [];
      const result = await installAllBundledWorkflowsForUpdate({
        output: { log: () => {}, warn: () => {} },
        listWorkflows: async () => ["feature-dev-merge"],
        installWorkflowById: async (id: string) => {
          installed.push(id);
        },
      });
      assert.deepEqual(result, ["feature-dev-merge"]);
      assert.deepEqual(installed, ["feature-dev-merge"]);
    });

    it("returns empty array when no bundled workflows", async () => {
      const result = await installAllBundledWorkflowsForUpdate({
        output: { log: () => {}, warn: () => {} },
        listWorkflows: async () => [],
      });
      assert.deepEqual(result, []);
    });

    it("throws when one or more workflows fail to install", async () => {
      const installed: string[] = [];
      await assert.rejects(
        installAllBundledWorkflowsForUpdate({
          output: { log: () => {}, warn: () => {} },
          listWorkflows: async () => ["wf-a", "wf-b", "wf-c"],
          installWorkflowById: async (id: string) => {
            if (id === "wf-b") throw new Error("install failed");
            installed.push(id);
          },
        }),
        /Failed to install bundled workflow/,
      );
      // wf-a and wf-c should have been installed before the throw
      assert.deepEqual(installed, ["wf-a", "wf-c"]);
    });
  });
});
