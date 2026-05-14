#!/usr/bin/env node

// Runtime check: node:sqlite requires Node.js >= 22
try {
  await import("node:sqlite");
} catch {
  console.error("Error: node:sqlite is not available.\n\nTamandua requires Node.js >= 22 with native SQLite support.");
  process.exit(1);
}

import { installWorkflow } from "../installer/install.js";
import { uninstallAllWorkflows, uninstallWorkflow, checkActiveRuns } from "../installer/uninstall.js";
import { getWorkflowStatus, listRuns, stopWorkflow, type RunInfo, type RunDetail } from "../installer/status.js";
import { runWorkflow, resumeWorkflow, type RunWorkflowResult } from "../installer/run.js";
import { listBundledWorkflows } from "../installer/workflow-fetch.js";
import { getRecentEvents, getRunEvents, readEventsFromCursor, type EventCursorSource, type TamanduaEvent } from "../installer/events.js";
import { formatLogsTailLines } from "../installer/logs-tail-format.js";
import { parseLogsSelector, lookupRunIdByNumber } from "./logs-selector.js";
import { startDaemon, stopDaemon, getDaemonStatus, isRunning, startMcp, stopMcp, getMcpStatus, isMcpRunning, startControlPlane, stopControlPlane, getControlPlaneStatus, isControlPlaneRunning } from "../server/daemonctl.js";
import { DEFAULT_MCP_PORT, MCP_ENDPOINT_PATH } from "../server/mcp-server.js";
import { DEFAULT_CONTROL_PORT } from "../server/control-server.js";
import { claimStep, completeStep, failStep, getStories, peekStep } from "../installer/step-ops.js";
import { ensureCliSymlink } from "../installer/symlink.js";
import { resolveSourcePath } from "../installer/paths.js";
import { runUpdate } from "./update.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "..", "package.json");

const BUILT_VERSION = "__VERSION__";

function getVersion(): string {
  if (BUILT_VERSION !== "__VERSION__") return BUILT_VERSION;
  try { const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")); return pkg.version ?? "unknown"; }
  catch { return "unknown"; }
}

function printEvents(events: TamanduaEvent[]): void {
  if (events.length === 0) { console.log("No events yet."); return; }
  for (const line of formatLogsTailLines(events)) {
    console.log(line);
  }
}

function getLogsTailPollIntervalMs(): number {
  const raw = parseInt(process.env.TAMANDUA_LOGS_TAIL_POLL_MS ?? "1000", 10);
  if (Number.isNaN(raw)) return 1000;
  return Math.max(10, raw);
}

async function streamEventSource(source: EventCursorSource, initialLimit: number): Promise<void> {
  const initial = readEventsFromCursor(source, 0);
  const firstBatch = initial.events.slice(-Math.max(1, initialLimit));
  if (firstBatch.length === 0) console.log("No events yet.");
  else printEvents(firstBatch);

  let cursor = initial.nextOffset;
  const abort = new AbortController();
  const pollIntervalMs = getLogsTailPollIntervalMs();
  const onSigint = () => abort.abort();

  process.on("SIGINT", onSigint);
  try {
    while (!abort.signal.aborted) {
      try {
        await delay(pollIntervalMs, undefined, { signal: abort.signal });
      } catch (err) {
        if ((err as Error).name === "AbortError") break;
        throw err;
      }
      if (abort.signal.aborted) break;

      const next = readEventsFromCursor(source, cursor);
      cursor = next.nextOffset;
      if (next.events.length > 0) printEvents(next.events);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function printUsage() {
  process.stdout.write([
    "tamandua install                      Install all bundled workflows",
    "tamandua uninstall [--force]          Full uninstall",
    "", "tamandua workflow list                List available workflows",
    "tamandua workflow install <name>      Install a workflow",
    "tamandua workflow run <name> <task> [--working-directory-for-harness <dir>]",
    "                                      Start a workflow run",
    "tamandua workflow status <query>      Check run status",
    "tamandua workflow runs                List all workflow runs",
    "tamandua workflow resume <run-id>     Resume a failed run",
    "tamandua workflow stop <run-id>       Stop/cancel a running workflow",
    "tamandua mcp start [--port N]         Start MCP server (default: 3338)",
    "tamandua mcp stop                     Stop MCP server",
    "tamandua mcp status                   Check MCP server status",
    "tamandua control-plane start [--port N]Start control plane (default: 3339)",
    "tamandua control-plane stop            Stop control plane",
    "tamandua control-plane status          Check control plane status",
    "", "tamandua dashboard [start] [--port N] Start dashboard (default: 3334)",
    "tamandua dashboard stop               Stop dashboard",
    "tamandua dashboard status             Check dashboard status",
    "", "tamandua step peek <agent-id> --run-id <run-id>     Check for pending work (HAS_WORK or NO_WORK)",
    "tamandua step claim <agent-id> --run-id <run-id>    Claim pending step (JSON output)",
    "tamandua step complete <step-id>      Complete step (reads output from stdin)",
    "tamandua step fail <step-id> <error>  Fail step with retry logic",
    "tamandua step stories <run-id>        List stories for a run",
    "", "tamandua logs [<lines>|<run-id>|#<run-number>] Show recent activity",
    "tamandua logs-tail [<lines>|<run-id>|#<run-number>] Follow recent activity",
    "", "tamandua version                      Show installed version",
    "tamandua source-path                  Print source checkout path",
    "tamandua update [--force]             Pull latest, rebuild, reinstall",
  ].join("\n") + "\n");
}

function parseWorkflowRunArgs(args: string[]): { taskTitle: string; workingDirectoryForHarness?: string } {
  const taskParts: string[] = [];
  let workingDirectoryForHarness: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--working-directory-for-harness") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      i++;
      continue;
    }

    const inlinePrefix = "--working-directory-for-harness=";
    if (token.startsWith(inlinePrefix)) {
      const value = token.slice(inlinePrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      continue;
    }

    taskParts.push(token);
  }

  return {
    taskTitle: taskParts.join(" ").trim(),
    workingDirectoryForHarness,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const [group, action, target] = args;

  if (group === "version" || group === "--version" || group === "-v") {
    console.log(`tamandua v${getVersion()}`); return;
  }
  if (group === "tamandua") {
    const { printTamandua } = await import("./ant.js"); printTamandua(); return;
  }
  if (group === "source-path") {
    console.log(resolveSourcePath()); return;
  }

  if (group === "update") {
    const force = args.includes("--force");
    const unknownArgs = args.slice(1).filter((arg) => arg !== "--force");
    if (unknownArgs.length > 0) {
      process.stderr.write(`Unknown update option: ${unknownArgs[0]}\nUsage: tamandua update [--force]\n`);
      process.exitCode = 1;
      return;
    }
    const result = await runUpdate({ force });
    if (result.status === "blocked_active_runs") {
      process.exitCode = 1;
    }
    return;
  }

  if (group === "uninstall" && (!args[1] || args[1] === "--force")) {
    const force = args.includes("--force");
    const activeRuns = await checkActiveRuns();
    if (activeRuns.length > 0 && !force) {
      process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`);
      for (const run of activeRuns) process.stderr.write(`  - ${run.id}: ${run.task}\n`);
      process.stderr.write(`\nUse --force to uninstall anyway.\n`); process.exit(1);
    }
    if (isRunning().running) { stopDaemon(); console.log("Dashboard stopped."); }
    if (isMcpRunning().running) { stopMcp(); console.log("MCP server stopped."); }
    await uninstallAllWorkflows();
    console.log("Tamandua fully uninstalled."); return;
  }

  if (group === "install" && !args[1]) {
    const workflows = await listBundledWorkflows();
    if (workflows.length === 0) { console.log("No bundled workflows found."); return; }
    console.log(`Installing ${workflows.length} workflow(s)...`);
    for (const wf of workflows) { try { await installWorkflow({ workflowId: wf }); console.log(`  ✓ ${wf}`); } catch (err) { console.log(`  ✗ ${wf}: ${err instanceof Error ? err.message : String(err)}`); } }
    ensureCliSymlink();
    console.log(`\nDone. Start with: tamandua workflow run <name> "your task"`);
    if (!isRunning().running) { try { const r = await startDaemon(3334); console.log(`\nDashboard started (PID ${r.pid}): http://localhost:${r.port}`); } catch (err) { console.log(`\nNote: dashboard not started: ${err instanceof Error ? err.message : String(err)}`); } }
    else console.log("\nDashboard already running.");
    if (!getMcpStatus().running) {
      console.log("\nMCP server not started. To start it: tamandua mcp start");
    } else {
      console.log("\nMCP server already running.");
    }
    return;
  }

  if (group === "mcp") {
    const sub = args[1];
    if (sub === "stop") {
      console.log(stopMcp() ? "MCP server stopped." : "MCP server is not running.");
      return;
    }
    if (sub === "status") {
      const st = getMcpStatus();
      if (!st.running) {
        console.log("MCP server is not running.");
        console.log(`Default endpoint: http://localhost:${st.port}${st.endpoint}`);
        return;
      }
      console.log(`MCP server running (PID ${st.pid})`);
      console.log(`Port: ${st.port}`);
      console.log(`Endpoint: http://localhost:${st.port}${st.endpoint}`);
      return;
    }
    let port = DEFAULT_MCP_PORT;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1], 10) || DEFAULT_MCP_PORT;
    }
    // Support positional port as well: tamandua mcp start 5555
    if (sub && sub !== "start" && !sub.startsWith("-")) {
      const p = parseInt(sub, 10);
      if (!Number.isNaN(p)) port = p;
    }
    const running = getMcpStatus();
    if (running.running) {
      console.log(`MCP server already running (PID ${running.pid})`);
      console.log(`Port: ${running.port}`);
      console.log(`Endpoint: http://localhost:${running.port}${running.endpoint}`);
      return;
    }
    try {
      const result = await startMcp(port);
      console.log(`MCP server started (PID ${result.pid})`);
      console.log(`Endpoint: http://localhost:${result.port}${MCP_ENDPOINT_PATH}`);
    } catch (err) {
      process.stderr.write(`Failed to start MCP: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return;
  }

  if (group === "dashboard") {
    const sub = args[1];
    if (sub === "stop") { console.log(stopDaemon() ? "Dashboard stopped." : "Dashboard is not running."); return; }
    if (sub === "status") {
      const st = getDaemonStatus();
      const mcp = getMcpStatus();

      if (!st.running) {
        console.log("Dashboard is not running.");
      } else {
        console.log(`Dashboard running (PID ${st.pid})`);
        console.log(`Dashboard endpoint: http://localhost:${st.port}`);
      }

      if (!mcp.running) {
        console.log("MCP server is not running.");
        console.log(`Default MCP endpoint: http://localhost:${mcp.port}${mcp.endpoint}`);
      } else {
        console.log(`MCP server running (PID ${mcp.pid})`);
        console.log(`MCP endpoint: http://localhost:${mcp.port}${mcp.endpoint}`);
      }
      return;
    }
    let port = 3334; const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) port = parseInt(args[portIdx + 1], 10) || 3334;
    else if (sub && sub !== "start" && !sub.startsWith("-")) { const p = parseInt(sub, 10); if (!Number.isNaN(p)) port = p; }
    if (isRunning().running) { const status = getDaemonStatus(); if (status.running) console.log(`Dashboard already running (PID ${status.pid})`); console.log(`  http://localhost:${port}`); return; }
    const result = await startDaemon(port); console.log(`Dashboard started (PID ${result.pid})\n  http://localhost:${result.port}`); return;
  }

  if (group === "control-plane") {
    const sub = args[1];
    if (sub === "stop") {
      console.log(stopControlPlane() ? "Control plane stopped." : "Control plane is not running.");
      return;
    }
    if (sub === "status") {
      const st = getControlPlaneStatus();
      if (!st.running) {
        console.log("Control plane is not running.");
        console.log(`Default endpoint: http://localhost:${st.port}${st.endpoint}`);
        return;
      }
      console.log(`Control plane running (PID ${st.pid})`);
      console.log(`Port: ${st.port}`);
      console.log(`Endpoint: http://localhost:${st.port}${st.endpoint}`);
      return;
    }
    let port = DEFAULT_CONTROL_PORT;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1], 10) || DEFAULT_CONTROL_PORT;
    }
    // Support positional port as well: tamandua control-plane start 4444
    if (sub && sub !== "start" && !sub.startsWith("-")) {
      const p = parseInt(sub, 10);
      if (!Number.isNaN(p)) port = p;
    } else if (target && !target.startsWith("-")) {
      const p = parseInt(target, 10);
      if (!Number.isNaN(p)) port = p;
    }
    const running = getControlPlaneStatus();
    if (running.running) {
      console.log(`Control plane already running (PID ${running.pid})`);
      console.log(`Port: ${running.port}`);
      console.log(`Endpoint: http://localhost:${running.port}${running.endpoint}`);
      return;
    }
    try {
      const result = await startControlPlane(port);
      const label = result.alreadyRunning ? "already running" : "started";
      console.log(`Control plane ${label}${result.pid > 0 ? ` (PID ${result.pid})` : ""}`);
      console.log(`Endpoint: http://localhost:${result.port}${getControlPlaneStatus().endpoint}`);
    } catch (err) {
      process.stderr.write(`Failed to start control plane: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return;
  }

  if (group === "step") {
    if (action === "peek" || action === "claim") {
      if (!target) { process.stderr.write(`Missing agent-id.\nUsage: tamandua step ${action} <agent-id> --run-id <run-id>\n`); process.exit(1); }
      // --run-id is required for peek/claim so concurrent runs of the same
      // workflow + agent can't cross-claim. No implicit inference — the
      // caller (typically the polling prompt) must pass it.
      let runIdArg: string | undefined;
      const remainder = args.slice(3);
      for (let i = 0; i < remainder.length; i++) {
        const tok = remainder[i];
        if (tok === "--run-id") { runIdArg = remainder[i + 1]?.trim(); i++; continue; }
        const inline = "--run-id=";
        if (tok.startsWith(inline)) { runIdArg = tok.slice(inline.length).trim(); }
      }
      if (!runIdArg) {
        process.stderr.write(
          `Missing --run-id for step ${action}.\nUsage: tamandua step ${action} <agent-id> --run-id <run-id>\n`,
        );
        process.exit(1);
      }
      if (action === "peek") {
        console.log(peekStep(target, runIdArg));
        return;
      }
      const jobId = process.env.TAMANDUA_WORKER_JOB_ID;
      const pidStr = process.env.TAMANDUA_WORKER_PID;
      const pgidStr = process.env.TAMANDUA_WORKER_PGID;
      const workerOwnership = (jobId && pidStr)
        ? { jobId, pid: Number(pidStr), ...(pgidStr ? { pgid: Number(pgidStr) } : {}) }
        : undefined;
      const r = claimStep(target, runIdArg, workerOwnership);
      console.log(r.found ? JSON.stringify({ stepId: r.stepId, runId: r.runId, input: r.resolvedInput }) : "NO_WORK");
      return;
    }
    if (action === "complete") { if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); } let output = args.slice(3).join(" ").trim(); if (!output) { const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c); output = Buffer.concat(chunks).toString("utf-8").trim(); } console.log(JSON.stringify(completeStep(target, output))); return; }
    if (action === "fail") { if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); } console.log(JSON.stringify(await failStep(target, args.slice(3).join(" ").trim() || "Unknown error"))); return; }
    if (action === "stories") { if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); } const fullRunId = getWorkflowStatus(target).id; const stories = getStories(fullRunId); if (stories.length === 0) { console.log("No stories found."); return; } for (const s of stories) console.log(`${s.storyId.padEnd(8)} [${s.status.padEnd(7)}] ${s.title}${s.retryCount > 0 ? ` (retry ${s.retryCount})` : ""}`); return; }
    process.stderr.write(`Unknown step action: ${action}\n`); process.exit(1);
  }

  if (group === "logs") {
    const selector = parseLogsSelector(args[1]);

    if (selector.kind === "global-recent" || selector.kind === "global-limit") {
      printEvents(getRecentEvents(selector.limit));
      return;
    }

    if (selector.kind === "run-number") {
      const runId = lookupRunIdByNumber(selector.runNumber);
      if (runId) {
        const events = getRunEvents(runId);
        events.length === 0 ? console.log(`No events for run #${selector.runNumber}.`) : printEvents(events);
        return;
      }

      const fallbackEvents = getRunEvents(selector.raw);
      fallbackEvents.length === 0 ? console.log(`No run #${selector.runNumber}.`) : printEvents(fallbackEvents);
      return;
    }

    let runId: string;
    try {
      runId = getWorkflowStatus(selector.runId).id;
    } catch (err) {
      console.log(err instanceof Error ? err.message : `No run found matching "${selector.runId}".`);
      return;
    }
    const events = getRunEvents(runId);
    events.length === 0 ? console.log(`No events for run "${selector.runId}".`) : printEvents(events);
    return;
  }

  if (group === "logs-tail") {
    const selector = parseLogsSelector(args[1]);

    if (selector.kind === "global-recent" || selector.kind === "global-limit") {
      await streamEventSource({ kind: "global" }, selector.limit);
      return;
    }

    if (selector.kind === "run-number") {
      const runId = lookupRunIdByNumber(selector.runNumber);
      if (!runId) {
        console.log(`No run #${selector.runNumber}.`);
        return;
      }
      await streamEventSource({ kind: "run", runId }, 50);
      return;
    }

    let logsTailRunId: string;
    try {
      logsTailRunId = getWorkflowStatus(selector.runId).id;
    } catch (err) {
      const message = err instanceof Error ? err.message : `No run found matching "${selector.runId}".`;
      // The DB row may lag behind the events file in early bootstrap (events
      // can be written before the run row is committed). If the literal runId
      // already has an events file on disk, tail it; otherwise fall through
      // to the not-found message so unknown prefixes don't hang forever.
      if (message.startsWith("No run found matching")) {
        const { getEventsPath } = await import("../installer/events.js");
        const fsMod = await import("node:fs");
        const pathMod = await import("node:path");
        const eventsFile = pathMod.join(getEventsPath(), `${selector.runId}.jsonl`);
        if (fsMod.existsSync(eventsFile)) {
          await streamEventSource({ kind: "run", runId: selector.runId }, 50);
          return;
        }
      }
      console.log(message);
      return;
    }
    await streamEventSource({ kind: "run", runId: logsTailRunId }, 50);
    return;
  }

  if (args.length < 2) { printUsage(); process.exit(1); }
  if (group !== "workflow") { printUsage(); process.exit(1); }

  if (action === "runs") {
    const runs = listRuns();
    if (runs.length === 0) { console.log("No workflow runs found."); return; }
    console.log("Workflow runs:");
    for (const r of runs) console.log(`  [${r.status.padEnd(9)}] ${r.id.slice(0, 8).padEnd(10)} ${r.workflowId.padEnd(14)} ${r.tokensSpent.toLocaleString().padStart(8)} tokens  ${r.task.slice(0, 50)}${r.task.length > 50 ? "..." : ""}`);
    return;
  }

  if (action === "list") {
    const workflows = await listBundledWorkflows();
    workflows.length === 0 ? console.log("No workflows available.") : (console.log("Available workflows:"), workflows.forEach(w => console.log(`  ${w}`)));
    return;
  }

  if (action === "stop") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    try { const fullId = getWorkflowStatus(target).id; const r = await stopWorkflow(fullId); console.log(`Cancelled run ${r.runId.slice(0, 8)}.`); } catch (err) { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); }
    return;
  }

  if (!target) { printUsage(); process.exit(1); }

  if (action === "install") {
    const result = await installWorkflow({ workflowId: target });
    console.log(`Installed workflow: ${result.workflowId}\nAgent crons will start when a run begins.\n\nStart with: tamandua workflow run ${result.workflowId} "your task"`);
    return;
  }

  if (action === "uninstall") {
    const force = args.includes("--force"); const isAll = target === "--all" || target === "all";
    const activeRuns = await checkActiveRuns(isAll ? undefined : target);
    if (activeRuns.length > 0 && !force) { process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`); activeRuns.forEach(r => process.stderr.write(`  - ${r.id}: ${r.task}\n`)); process.exit(1); }
    if (isAll) { await uninstallAllWorkflows(); console.log("All workflows uninstalled."); } else { await uninstallWorkflow(target); console.log(`Uninstalled: ${target}`); }
    return;
  }

  if (action === "run") {
    const workflowName = args[2];
    if (!workflowName) { process.stderr.write("Missing workflow name.\n"); process.exit(1); }

    let runArgs: ReturnType<typeof parseWorkflowRunArgs>;
    try {
      runArgs = parseWorkflowRunArgs(args.slice(3));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (!runArgs.taskTitle) { process.stderr.write("Missing task description.\n"); process.exit(1); }
    const result = await runWorkflow({
      workflowId: workflowName,
      taskTitle: runArgs.taskTitle,
      workingDirectoryForHarness: runArgs.workingDirectoryForHarness,
    });
    console.log(`Run: ${result.runId.slice(0, 8)}\nWorkflow: ${result.workflowId}\nTask: ${result.taskTitle}\nStatus: ${result.status}\nHarness CWD: ${result.workingDirectoryForHarness}`);
    return;
  }

  if (action === "status") {
    if (!target) { process.stderr.write("Missing query.\n"); process.exit(1); }
    try {
      const result = getWorkflowStatus(target);
      console.log(`Run: ${result.id.slice(0, 8)}\nWorkflow: ${result.workflowId}\nTask: ${result.task}\nStatus: ${result.status}\nTokens: ${result.tokensSpent.toLocaleString()}\nSteps:`);
      for (const step of result.steps) {
        const icon = step.status === "done" ? "  [done   ]" : step.status === "running" ? "  [running]" : step.status === "failed" ? "  [failed ]" : step.status === "pending" ? "  [pending]" : `  [${step.status.padEnd(7)}]`;
        console.log(`${icon} ${step.stepId} (${step.agentId.split("_").slice(-1)[0]})`);
      }
    } catch (err) {
      console.log(`No run found matching "${target}".`);
    }
    return;
  }

  if (action === "resume") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    let fullId = target;
    try { fullId = getWorkflowStatus(target).id; } catch { /* fall through to resumeWorkflow which will return not_found */ }
    const result = await resumeWorkflow(fullId);
    if (result.status === "not_found") { console.log(`No failed run found matching "${target}".`); return; }
    console.log(`Resumed run ${result.runId!.slice(0, 8)} (${result.workflowId}), restarting from step: ${result.stepId}`);
    return;
  }

  if (action === "ensure-crons") {
    // Polling jobs are now tied to (runId, agentId) and admitted via the
    // daemon control plane. There is no longer a workflow-wide
    // "ensure-crons" notion — use `tamandua workflow run` instead
    // (which registers the new run with the daemon).
    process.stderr.write(
      "`workflow ensure-crons` is removed. Run-scoped scheduling makes it obsolete \u2014 " +
      "start a run with `tamandua workflow run <id> '<task>'`.\n",
    );
    process.exit(1);
  }

  printUsage(); process.exit(1);
}

await main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
