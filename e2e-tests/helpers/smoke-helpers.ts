/**
 * Shared helpers for smoke/state-machine e2e tests.
 *
 * These helpers support the fast smoke test (manual step claim/complete with
 * canned outputs, no real agents or models). They are also reusable by the
 * slow real e2e test where applicable (e.g. createTempHome, baseEnv, cli).
 */

import assert from "node:assert/strict";
import {
  cleanChildEnv,
  reserveDistinctRandomPorts,
} from "../../tests/helpers/test-env.ts";
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

export async function createTempHome() {
  const [controlPort, dashboardPort] = await reserveDistinctRandomPorts(2);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "canarinho-e2e-workflows-"),
  );
  const homeDir = path.join(root, "home");
  const canarinhoDir = path.join(homeDir, ".canarinho");
  fs.mkdirSync(canarinhoDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    path.join(canarinhoDir, "port"),
    String(dashboardPort),
    "utf-8",
  );
  // Symlink the real developer ~/.pi so the isolated test environment
  // reuses the working pi auth configuration (provider, API key, model).
  // This avoids the auth isolation mismatch where a synthesized
  // settings.json points at providers.openai.apiKey but pi --print
  // cannot resolve it (especially when cleanChildEnv strips env-based
  // auth like OPENAI_API_KEY).
  const realPiDir = path.join(os.homedir(), ".pi");
  const isolatedPiLink = path.join(homeDir, ".pi");
  assert.ok(
    fs.existsSync(realPiDir),
    `Real ~/.pi directory must exist at ${realPiDir} for e2e tests to reuse pi auth configuration.`,
  );
  fs.symlinkSync(realPiDir, isolatedPiLink, "dir");
  // Also symlink real ~/.hermes for hermes-based e2e tests (e.g., hermes
  // canary). Hermes reads its credentials and config from ~/.hermes, the
  // same isolation pattern as ~/.pi above. Skip silently if ~/.hermes
  // doesn't exist (most dev machines won't have hermes installed).
  const realHermesDir = path.join(os.homedir(), ".hermes");
  const isolatedHermesLink = path.join(homeDir, ".hermes");
  if (fs.existsSync(realHermesDir)) {
    fs.symlinkSync(realHermesDir, isolatedHermesLink, "dir");
  }
  return { root, homeDir, canarinhoDir, controlPort, dashboardPort };
}

export function inheritedProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function baseEnv(homeDir: string, controlPort: number) {
  const canarinhoDir = path.join(homeDir, ".canarinho");
  return {
    ...inheritedProcessEnv(),
    HOME: homeDir,
    canarinho_CONTROL_PORT: String(controlPort),
    canarinho_STATE_DIR: canarinhoDir,
    canarinho_DB_PATH: path.join(canarinhoDir, "canarinho.db"),
    canarinho_WORKTREE_ROOT: path.join(canarinhoDir, "worktrees"),
  };
}

export function cli(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: cleanChildEnv(env),
    encoding: "utf-8",
  });
}

export function cliMustSucceed(
  args: string[],
  env: Record<string, string>,
  label: string,
) {
  const r = cli(args, env);
  assert.equal(
    r.status,
    0,
    `${label} failed (exit ${r.status}): ${r.stderr || r.stdout}`,
  );
  return r.stdout;
}

export function stepClaim(
  agentId: string,
  runId: string,
  env: Record<string, string>,
) {
  const r = cli(["step", "claim", agentId, "--run-id", runId], env);
  assert.equal(
    r.status,
    0,
    `step claim ${agentId} failed: ${r.stderr || r.stdout}`,
  );
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.stepId, `no stepId in claim response: ${r.stdout}`);
  return parsed as { stepId: string; runId: string; input: string };
}

export function stepComplete(
  stepId: string,
  output: string,
  env: Record<string, string>,
) {
  const r = spawnSync(process.execPath, [cliPath, "step", "complete", stepId], {
    env: cleanChildEnv(env),
    input: output,
    encoding: "utf-8",
  });
  assert.equal(
    r.status,
    0,
    `step complete ${stepId} failed: ${r.stderr || r.stdout}`,
  );
  return JSON.parse(r.stdout.trim()) as { status: string };
}

/**
 * Spawn `canarinho workflow run` and capture the 8-char run-ID prefix from stdout.
 * Kills the child process once the output is captured.
 */
export function spawnWorkflowRun(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timeout waiting for workflow run output. stdout: ${stdout}, stderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = stdout.match(/^Run:\s+([0-9a-f]{8,})/im);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve(match[1]);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      const match = stdout.match(/^Run:\s+([0-9a-f]{8,})/im);
      if (match) {
        resolve(match[1]);
      } else {
        reject(
          new Error(
            `Workflow run failed (exit ${code}). stdout: ${stdout}, stderr: ${stderr}`,
          ),
        );
      }
    });
  });
}

/** Prepare a clean git repo from the sample project fixture */
export function prepareGitRepo(fixtureDir: string, targetDir: string) {
  fs.mkdirSync(targetDir, { recursive: true });
  const cpResult = spawnSync("cp", ["-r", `${fixtureDir}/.`, `${targetDir}/`], {
    encoding: "utf-8",
  });
  assert.equal(cpResult.status, 0, `cp failed: ${cpResult.stderr}`);

  function git(args: string[]) {
    const r = spawnSync("git", args, { cwd: targetDir, encoding: "utf-8" });
    assert.equal(
      r.status,
      0,
      `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
    );
    return r.stdout.trim();
  }

  git(["init"]);
  git(["config", "user.email", "test@canarinho.local"]);
  git(["config", "user.name", "canarinho E2E Test"]);
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit with sample project"]);
  return targetDir;
}

/** Resolve full run ID from the 8-char prefix using the temp home DB */
export function resolveFullRunId(prefix: string, canarinhoDir: string): string {
  const dbPath = path.join(canarinhoDir, "canarinho.db");
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare("SELECT id FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1")
      .all(`${prefix}%`) as Array<{ id: string }>;
    if (rows.length === 0) {
      throw new Error(`No run found matching prefix "${prefix}"`);
    }
    return rows[0].id;
  } finally {
    db.close();
  }
}

export function cleanupTempHome(
  env: { root: string; homeDir: string; controlPort: number },
) {
  try {
    cli(["dashboard", "stop"], baseEnv(env.homeDir, env.controlPort));
  } catch {
    // best-effort
  }
  try {
    fs.rmSync(env.root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
