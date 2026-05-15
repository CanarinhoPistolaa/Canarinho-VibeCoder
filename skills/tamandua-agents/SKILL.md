---
name: tamandua-agents
description: Guide agents to run Tamandua workflow and step lifecycle commands consistently. Use when an agent must poll for work, claim a step, execute task input, and report completion or failure.
---

# Tamandua Agents

## Instructions

Use this skill when operating as a Tamandua workflow agent.

### 1) Confirm CLI access

Use the `tamandua` CLI if available on PATH.

```bash
tamandua version
tamandua source-path
```

If the binary is not on PATH, use the Node entrypoint directly:

```bash
node /path/to/tamandua/dist/cli/cli.js <command>
```

### 2) Know the workflow-level commands

Use these when managing workflow runs (outside individual step execution):

```bash
tamandua workflow list
tamandua workflow run <workflow-id> "<task>" [--working-directory-for-harness <dir>] [--no-hurry-please-save-tokens-mode]
tamandua workflow status <query>
tamandua workflow runs
tamandua workflow pause <run-id>
tamandua workflow pause-all [--drain]
tamandua workflow resume <run-id>
tamandua workflow resume-all
tamandua workflow stop <run-id>
```

`resume` works for both paused runs (restarted via the daemon) and failed
runs (resumed directly). `pause-all --drain` lets in-progress steps finish
before pausing.

Use `tamandua update [--force]` only for local Tamandua maintenance. Without
`--force`, update blocks after rebuilding if active runs are present — it
leaves services and installed workflows unchanged. Use `--force` to proceed
despite active runs (services are stopped and restarted, workflows reinstalled).
Remote MCP clients can discover the same maintenance command via
`tamandua.update.command`; run the actual update through the local CLI because
it may restart dashboard, MCP, and the control plane.

Harness working directory guidance:

- CLI run: `--working-directory-for-harness` is optional; if omitted it defaults to the shell's current working directory.
- Prefer passing an explicit absolute path when the task depends on a specific repo checkout.

Use `--no-hurry-please-save-tokens-mode` to lower agent polling frequency
for the run. When enabled, the scheduler floor becomes 15 minutes (default
15 minutes) instead of the normal 1 minute (default 5 minutes), reducing
token consumption. Use this for low-priority or long-running background
runs where responsiveness is less important than cost savings.

### 3) Follow the step lifecycle exactly

Always execute step commands in this order:

1. `tamandua step peek <agent-id> --run-id <run-id>`
2. If result is `HAS_WORK`, run `tamandua step claim <agent-id> --run-id <run-id>`
3. Parse claim JSON: `{"stepId":"...","runId":"...","input":"..."}`
4. **SAVE `stepId` immediately** and execute the `input` task
5. Report with the saved step id:
   - Success: `tamandua step complete <stepId>` (send status output through stdin)
   - Failure: `tamandua step fail <stepId> "<reason>"`

Use the run ID supplied by your scheduler prompt or workflow context. `step peek` and `step claim` require `--run-id` so agents serving concurrent runs cannot claim each other's work.

Never call `step complete` or `step fail` with an agent ID. They require the claimed step UUID.

For diagnostics, use `tamandua step stories <run-id>` to list all stories
for a run and their statuses. This is useful when diagnosing blocked
pipelines or understanding story progress.

### 4) Completion contract

On success, provide structured output that includes:

- `STATUS: done`
- `CHANGES: ...`
- `TESTS: ...`

Then pipe that output into `tamandua step complete <stepId>`.

On failure, call `tamandua step fail <stepId> "<clear reason>"` with actionable detail.

### 2.1) MCP run start (remote)

When using MCP, `tamandua.run.start` requires a harness working directory.
`workingDirectoryForHarness` is mandatory (not optional) for MCP runs.

Required MCP args:

- `workflowId`
- `taskTitle`
- `workingDirectoryForHarness` (mandatory)

Optional MCP args:

- `noHurrySaveTokensMode` (boolean) — lowers agent polling frequency to
  save tokens, same as the CLI `--no-hurry-please-save-tokens-mode` flag.
  When `true`, the scheduler uses a 15-minute floor and 15-minute default
  instead of the normal 1-minute floor and 5-minute default.

Recovery pattern for tool-calling models:

- If MCP returns: `Argument "workingDirectoryForHarness" must be a non-empty string`
- Retry the same tool call with an explicit absolute path (for example `/home/user/repo`).

### 2.2) Inspect activity with logs and logs-tail

Use logs to inspect recent run activity or follow events as they happen.

The selector can be:
- A number — shows that many most recent entries globally
- A run ID prefix — shows entries for that run
- `#<run-number>` — shows entries for the Nth run

```bash
# Show recent entries
tamandua logs                        # default: last 20 entries
tamandua logs 50                     # last 50 entries
tamandua logs <run-id>               # entries for a specific run
tamandua logs #3                     # entries for run number 3

# Follow activity as new events arrive
tamandua logs-tail                   # tail recent activity (live)
tamandua logs-tail 50                # tail, starting with last 50 entries
tamandua logs-tail <run-id>          # tail events for a specific run
tamandua logs-tail #3                # tail events for run number 3
```

Example: after starting a workflow, follow its progress:

```bash
tamandua workflow run feature-dev "Add login page"
# -> Run started: 8a3b2c1d-...
tamandua logs-tail 8a3b2c1d          # follow events as they arrive
```

### 2.3) Dashboard lifecycle and source path

Start, stop, and check the web dashboard:

```bash
tamandua dashboard [start] [--port N]  # Start dashboard (default: 3334)
tamandua dashboard stop                # Stop dashboard
tamandua dashboard status              # Check dashboard + MCP status
```

`dashboard status` reports both dashboard and MCP server status in a single
output. The remote MCP server can be managed independently with
`tamandua mcp start [--port N]`, `tamandua mcp stop`, and `tamandua mcp status`
(standalone on port 3338 by default).

`tamandua source-path` prints the source checkout path that `tamandua update`
uses to pull, rebuild, and reinstall.

## Examples

### Polling loop example

```bash
# Phase 1: Peek
tamandua step peek feature-dev_developer --run-id 7aeb4da9-1111-4222-8333-abcdefabcdef
# -> NO_WORK (stop) OR HAS_WORK (continue)

# Phase 2: Claim
tamandua step claim feature-dev_developer --run-id 7aeb4da9-1111-4222-8333-abcdefabcdef
# -> {"stepId":"87409f73-...","runId":"7aeb4da9-...","input":"Implement ..."}
# Save stepId=87409f73-...

# Execute the input task...

# Success report (uses saved stepId)
echo 'STATUS: done
CHANGES: Added skill docs and tests
TESTS: node --test tests/*.test.ts' | tamandua step complete 87409f73-4ba6-492a-be44-30b2b6ffbadb

# Failure alternative
# tamandua step fail 87409f73-4ba6-492a-be44-30b2b6ffbadb "Missing repository path"
```

### Manual step inspection

```bash
tamandua step stories <run-id>
```

Use `step stories` to inspect current story status for a run when diagnosing blocked pipelines.
