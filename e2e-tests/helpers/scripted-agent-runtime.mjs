/**
 * Scripted-agent runtime — a deterministic stand-in for the `pi` binary.
 *
 * The agent scheduler invokes this exactly like pi:
 *   fake-pi --print --mode json --no-session "<work prompt>"
 *
 * Unlike the static canned fake-pi used by unit tests, this runtime actually
 * executes the work protocol that the prompt describes:
 *
 *   1. Parse workflow/agent/run IDs and the tamandua CLI path from the prompt
 *   2. Defensive `step peek` — the dispatch motor only spawns a harness when
 *      a pending step exists, so NO_WORK here is a motor bug or a rare race;
 *      it is journaled as phase "heartbeat" (the N2 tripwire) and answered
 *      with NO_WORK_AVAILABLE
 *   3. Run `step claim`, look up this agent's scripted behavior, apply file
 *      edits / shell commands in the harness workdir, then report via
 *      `step complete` / `step fail`
 *   4. Emit pi-shaped JSON events (tool_execution_end with {stepId, runId}
 *      for token attribution, message_end with usage.totalTokens)
 *
 * Behaviors come from a JSON file (TAMANDUA_SCRIPTED_BEHAVIORS), keyed by the
 * short agent id (the part after "<workflowId>_"). Each agent maps to one
 * behavior or an array consumed per work invocation (last entry repeats), so
 * tests can script "fail once, then succeed" sequences.
 *
 * Every invocation appends a JSON line to TAMANDUA_SCRIPTED_STATE/invocations.jsonl
 * so tests can assert exactly how many rounds ran, which agents did work, and
 * what each round observed.
 *
 * Chaos modes (behavior.mode): "work" (default), "hang", "die-before-claim",
 * "die-after-claim", "no-status", "garbage".
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const prompt = process.argv[process.argv.length - 1] ?? "";
const behaviorsPath = process.env.TAMANDUA_SCRIPTED_BEHAVIORS ?? "";
const stateDir = process.env.TAMANDUA_SCRIPTED_STATE ?? "";

// ── State-dir logging (test diagnostics) ────────────────────────────

function logInvocation(entry) {
  if (!stateDir) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, "invocations.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + "\n",
      "utf-8",
    );
  } catch {
    // never let diagnostics kill the round
  }
}

function fatal(note) {
  logInvocation({ phase: "error", note });
  process.stderr.write(`scripted-agent: ${note}\n`);
  process.exit(1);
}

// ── pi-shaped JSON event emission ───────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitToolAttribution(stepId, runId) {
  emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: { content: [{ type: "text", text: JSON.stringify({ stepId, runId }) }] },
    isError: false,
  });
}

function emitMessageEnd(text, totalTokens) {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "scripted",
      provider: "scripted",
      model: "scripted-agent",
      usage: {
        input: Math.max(0, totalTokens - 1),
        output: totalTokens > 0 ? 1 : 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
      responseId: crypto.randomUUID(),
    },
  });
}

// ── Parse the work prompt (this pins the prompt protocol) ───────────
//
// The header line is `... workflow "X", agent "Y", run "Z"` and the CLI
// path comes from the `step claim` command line. The work prompt has no
// peek phase — the dispatch motor peeks in-process before spawning us.

const header = prompt.match(
  /workflow "([^"]+)", agent "([^"]+)", run "([^"]+)"/,
);
if (!header) fatal(`could not parse workflow/agent/run from prompt: ${prompt.slice(0, 200)}`);
const [, workflowId, agentId, runId] = header;

const cliMatch = prompt.match(/(?:node )?"([^"]+)" step (?:claim|peek)/);
if (!cliMatch) fatal("could not parse tamandua CLI path from prompt");
const cliPath = cliMatch[1];

const shortAgent = agentId.startsWith(`${workflowId}_`)
  ? agentId.slice(workflowId.length + 1)
  : agentId;

// ── Behaviors config ────────────────────────────────────────────────

let config = { agents: {}, heartbeatTokens: 17, defaultTokens: 111 };
if (behaviorsPath && fs.existsSync(behaviorsPath)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(behaviorsPath, "utf-8")) };
}

function behaviorForInvocation(index) {
  const entry = config.agents[shortAgent] ?? config.agents[agentId];
  if (entry === undefined) return undefined;
  const list = Array.isArray(entry) ? entry : [entry];
  if (list.length === 0) return undefined;
  return list[Math.min(index, list.length - 1)];
}

function nextWorkIndex() {
  const countFile = path.join(stateDir, `${shortAgent}.workcount`);
  let count = 0;
  try {
    count = parseInt(fs.readFileSync(countFile, "utf-8"), 10) || 0;
  } catch {
    // first invocation
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(countFile, String(count + 1), "utf-8");
  return count;
}

// ── tamandua CLI invocation (inherits daemon env: state dir, DB, ports) ──
//
// The prompt's CLI path may be the bin/tamandua shell launcher (exec it
// directly) or a .js entry point (run it through node). Detect by shebang
// so this runtime works with either prompt/motor generation.
const cliIsShellScript = (() => {
  try {
    const fd = fs.openSync(cliPath, "r");
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf.toString("utf-8") === "#!";
  } catch {
    return false;
  }
})();

function cli(args, input) {
  const [command, baseArgs] = cliIsShellScript
    ? [cliPath, []]
    : [process.execPath, [cliPath]];
  return spawnSync(command, [...baseArgs, ...args], {
    encoding: "utf-8",
    cwd: process.cwd(),
    env: process.env,
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// ── Placeholder substitution ────────────────────────────────────────
// {{cwd}} → harness workdir; {{input.KEY}} → "KEY: value" line from step input

function parseInputVars(input) {
  const vars = {};
  for (const line of input.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*):\s*(.*)$/);
    if (m) vars[m[1]] = m[2].trim();
  }
  return vars;
}

function substitute(text, inputVars) {
  return text
    .replaceAll("{{cwd}}", process.cwd())
    .replace(/\{\{input\.([A-Za-z0-9_]+)\}\}/g, (_, key) => {
      const upper = key.toUpperCase();
      if (!(upper in inputVars)) {
        throw new Error(`no "${upper}:" line in step input for placeholder {{input.${key}}}`);
      }
      return inputVars[upper];
    });
}

// ── Main ────────────────────────────────────────────────────────────

const base = { workflowId, agentId, shortAgent, runId, cwd: process.cwd(), jobId: process.env.TAMANDUA_WORKER_JOB_ID ?? null };

// Phase 1: defensive peek. The dispatch motor decides HAS_WORK in-process
// before ever spawning this runtime, so NO_WORK here means a motor bug or a
// (rare) race with another round. Journal it as "heartbeat" — the scripted
// e2e asserts this count is ZERO under the deterministic motor (N2).
const peek = cli(["step", "peek", agentId, "--run-id", runId]);
const peekOut = `${peek.stdout}\n${peek.stderr}`;
if (peek.status !== 0) {
  logInvocation({ ...base, phase: "error", note: `step peek exited ${peek.status}: ${peekOut.slice(0, 500)}` });
  fatal(`step peek failed (exit ${peek.status})`);
}

if (peekOut.includes("NO_WORK")) {
  logInvocation({ ...base, phase: "heartbeat", note: "spawned without pending work" });
  emitMessageEnd("NO_WORK_AVAILABLE", config.heartbeatTokens);
  process.exit(0);
}
if (!peekOut.includes("HAS_WORK")) {
  logInvocation({ ...base, phase: "error", note: `unrecognized peek output: ${peekOut.slice(0, 500)}` });
  fatal("unrecognized step peek output");
}

// Phase 2: work
const workIndex = nextWorkIndex();
const behavior = behaviorForInvocation(workIndex);
const mode = behavior?.mode ?? "work";
const tokens = behavior?.tokens ?? config.defaultTokens;
const work = { ...base, phase: "work", workIndex, mode };

if (behavior === undefined) {
  // Work arrived for an agent the test did not script: fail the run fast and
  // loudly instead of letting the e2e test time out.
  const claim = cli(["step", "claim", agentId, "--run-id", runId]);
  const claimed = claim.status === 0 ? JSON.parse(claim.stdout.trim()) : null;
  logInvocation({ ...work, note: "no scripted behavior for this agent", stepId: claimed?.stepId ?? null });
  emitMessageEnd(`STATUS: failed\nREASON: no scripted behavior for agent "${shortAgent}"`, tokens);
  if (claimed?.stepId) {
    cli(["step", "fail", claimed.stepId, `scripted-agent: no behavior configured for agent "${shortAgent}"`]);
  }
  process.exit(0);
}

if (mode === "hang") {
  logInvocation({ ...work, note: "hanging until killed" });
  setInterval(() => {}, 1 << 30); // hold the event loop; scheduler timeout kills us
} else if (mode === "die-before-claim") {
  logInvocation({ ...work, note: "exiting before claim" });
  process.exit(behavior.exitCode ?? 3);
} else if (mode === "garbage") {
  logInvocation({ ...work, note: "emitting garbage output" });
  process.stdout.write("%%% not json — scripted garbage output %%%\n{truncated\n");
  process.exit(0);
} else {
  runWorkRound();
}

function runWorkRound() {
  const claim = cli(["step", "claim", agentId, "--run-id", runId]);
  if (claim.status !== 0) {
    logInvocation({ ...work, phase: "error", note: `step claim exited ${claim.status}: ${claim.stderr.slice(0, 500)}` });
    fatal(`step claim failed (exit ${claim.status})`);
  }
  const claimRaw = claim.stdout.trim();
  if (claimRaw.includes("NO_WORK")) {
    // Raced with another round; reply exactly as the work prompt instructs.
    logInvocation({ ...base, phase: "heartbeat", note: "claim returned NO_WORK after HAS_WORK peek" });
    emitMessageEnd("NO_WORK_AVAILABLE", config.heartbeatTokens);
    process.exit(0);
  }
  const claimed = JSON.parse(claimRaw);
  const stepId = claimed.stepId;
  const inputVars = parseInputVars(claimed.input ?? "");

  // Log the work round NOW: once the final `step complete` of a run lands,
  // the daemon tears down crons and SIGTERMs this process group, so any
  // bookkeeping after that call may never happen.
  logInvocation({ ...work, stepId, note: "claimed" });

  const failStep = (reason) => {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: reason.slice(0, 500) });
    emitToolAttribution(stepId, runId);
    emitMessageEnd(`STATUS: failed\nREASON: ${reason.slice(0, 500)}`, tokens);
    cli(["step", "fail", stepId, reason.slice(0, 1000)]);
    process.exit(0);
  };

  try {
    for (const edit of behavior.edits ?? []) {
      const filePath = path.resolve(process.cwd(), substitute(edit.file, inputVars));
      const content = fs.readFileSync(filePath, "utf-8");
      const find = substitute(edit.find, inputVars);
      if (!content.includes(find)) {
        return failStep(`scripted edit: pattern not found in ${edit.file}: ${find}`);
      }
      fs.writeFileSync(filePath, content.replaceAll(find, substitute(edit.replace, inputVars)), "utf-8");
    }
    for (const write of behavior.writes ?? []) {
      const filePath = path.resolve(process.cwd(), substitute(write.file, inputVars));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, substitute(write.content, inputVars), "utf-8");
    }
    for (const command of behavior.commands ?? []) {
      const rendered = substitute(command, inputVars);
      const r = spawnSync("bash", ["-c", rendered], {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status !== 0) {
        return failStep(`scripted command failed (exit ${r.status}): ${rendered}\n${r.stderr}`);
      }
    }
  } catch (err) {
    return failStep(`scripted behavior error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (mode === "die-after-claim") {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "dying after claim without reporting" });
    process.exit(behavior.exitCode ?? 1);
  }

  const outputText = substitute(behavior.output ?? "STATUS: done", inputVars);

  if (mode === "no-status") {
    // Did the work (maybe) but never reported — the lost-step case.
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "no-status: exiting without step complete" });
    emitMessageEnd(outputText, tokens);
    process.exit(0);
  }

  if (behavior.reportBeforeEmit) {
    // Real pi event ordering: the tool call that runs `step complete`
    // happens BEFORE the final assistant message carrying token usage.
    // Completing the run's final step triggers scheduling teardown, so this
    // models the window where an immediate kill would lose the usage event
    // (guarded by HARNESS_TEARDOWN_GRACE_MS in the scheduler).
    emitToolAttribution(stepId, runId);
    logInvocation({ ...work, phase: "result", stepId, ok: true, note: "reporting step complete before emitting usage" });
    const complete = cli(["step", "complete", stepId], outputText);
    if (complete.status !== 0) {
      logInvocation({ ...work, phase: "result", stepId, ok: false, note: `step complete exited ${complete.status}: ${complete.stderr.slice(0, 300)}` });
    }
    spawnSync("sleep", ["0.3"]);
    emitMessageEnd(outputText, tokens);
    process.exit(0);
  }

  // Default ordering: flush all pi-shaped events BEFORE reporting, so even
  // an immediate post-completion kill cannot lose them.
  emitToolAttribution(stepId, runId);
  emitMessageEnd(outputText, tokens);

  if (behavior.stepAction === "fail") {
    logInvocation({ ...work, phase: "result", stepId, ok: false, note: "scripted step fail" });
    cli(["step", "fail", stepId, behavior.failReason ?? "scripted failure"]);
    process.exit(0);
  }

  logInvocation({ ...work, phase: "result", stepId, ok: true, note: "reporting step complete" });
  const complete = cli(["step", "complete", stepId], outputText);
  if (complete.status !== 0) {
    logInvocation({
      ...work,
      phase: "result",
      stepId,
      ok: false,
      note: `step complete exited ${complete.status}: ${complete.stderr.slice(0, 300)}`,
    });
  }
  process.exit(0);
}
