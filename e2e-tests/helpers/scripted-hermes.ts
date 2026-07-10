/**
 * Scripted-hermes test helper — fake hermes binary for full-pipeline e2e.
 *
 * createScriptedHermes() materializes an executable that the agent scheduler
 * can spawn in place of the real hermes binary (via canarinho_HERMES_BINARY).
 * Unlike the canned fake-pi in unit tests, the scripted hermes executes the
 * real work protocol — step claim / complete against the isolated canarinho DB
 * (plus a defensive peek) — and applies deterministic per-agent behaviors
 * (file edits, shell commands, canned STATUS outputs) in the harness workdir.
 *
 * This lets e2e tests drive the REAL daemon → scheduler → hermes harness →
 * step-ops → pipeline advance path with zero model tokens.
 *
 * See scripted-hermes-runtime.mjs for the behavior semantics and chaos modes.
 *
 * Shares types with scripted-agent.ts so both factories use the same
 * ScriptedAgentConfig shape. The hermes factory also sets:
 *   canarinho_PI_BINARY=/usr/bin/false  (accidental pi spawns fail loudly)
 *   HERMES_HOME=<temp hermes home>  (fake state.db lives here)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ScriptedAgentConfig,
  InvocationLogEntry,
  ScriptedAgent,
} from "./scripted-agent.js";

const runtimePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "scripted-hermes-runtime.mjs",
);

/**
 * Materialize a scripted hermes binary under `rootDir` (a temp dir owned by
 * the test).
 *
 * The factory creates:
 *   - A bash wrapper script that invokes the hermes runtime via node
 *   - A HERMES_HOME directory (no pre-creation of state.db — runtime creates it)
 *   - Environment variables for the daemon and CLI to use the fake hermes
 *
 * Returns an object compatible with the ScriptedAgent interface (same shape
 * as createScriptedAgent) so existing test infrastructure can consume both
 * uniformly.
 */
export function createScriptedHermes(
  rootDir: string,
  config: ScriptedAgentConfig,
): ScriptedAgent {
  const dir = path.join(rootDir, "scripted-hermes");
  const stateDir = path.join(dir, "state");
  const hermesHome = path.join(dir, "hermes-home");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(hermesHome, { recursive: true });

  const behaviorsPath = path.join(dir, "behaviors.json");
  fs.writeFileSync(behaviorsPath, JSON.stringify(config, null, 2), "utf-8");

  // Wrapper script: absolute node path so the daemon's PATH doesn't matter.
  // Invokes hermes argv: chat --max-turns 8192 --yolo -Q -q "<prompt>"
  const binPath = path.join(dir, "scripted-hermes");
  fs.writeFileSync(
    binPath,
    [
      "#!/usr/bin/env bash",
      `exec "${process.execPath}" "${runtimePath}" "$@"`,
      "",
    ].join("\n"),
    "utf-8",
  );
  fs.chmodSync(binPath, 0o755);

  const readInvocations = (): InvocationLogEntry[] => {
    const logPath = path.join(stateDir, "invocations.jsonl");
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InvocationLogEntry);
  };

  return {
    binPath,
    stateDir,
    env: {
      canarinho_HERMES_BINARY: binPath,
      HERMES_HOME: hermesHome,
      canarinho_PI_BINARY: "/usr/bin/false",
      canarinho_SCRIPTED_BEHAVIORS: behaviorsPath,
      canarinho_SCRIPTED_STATE: stateDir,
    },
    readInvocations,
    workInvocations: (shortAgent?: string) =>
      readInvocations().filter(
        (e) =>
          e.phase === "work" &&
          (shortAgent === undefined || e.shortAgent === shortAgent),
      ),
    heartbeats: (shortAgent?: string) =>
      readInvocations().filter(
        (e) =>
          e.phase === "heartbeat" &&
          (shortAgent === undefined || e.shortAgent === shortAgent),
      ),
    describe: () =>
      readInvocations()
        .map(
          (e) =>
            `${e.ts} ${e.phase}${
              e.shortAgent ? ` agent=${e.shortAgent}` : ""
            }${e.mode ? ` mode=${e.mode}` : ""}${
              e.stepId ? ` step=${String(e.stepId).slice(0, 8)}` : ""
            }${
              e.ok !== undefined ? ` ok=${e.ok}` : ""
            }${e.note ? ` note=${e.note}` : ""}`,
        )
        .join("\n") || "(no scripted-hermes invocations recorded)",
  };
}
