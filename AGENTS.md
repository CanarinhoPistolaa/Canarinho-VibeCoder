# AGENTS.md

Instructions for AI coding assistants and developers working on the tamandua codebase.

## Development

### Build and Install

```bash
# Build from source (checkout root):
./build              # npm install + tsc + inject-version
./install            # symlink ~/.local/bin/tamandua → this checkout
./build-and-install  # both steps at once
```

The `build` script requires Node.js >= 22. It runs `npm install` followed by `npm run build` (TypeScript compilation, HTML copy, version injection).

The `install` script delegates to `scripts/install.sh --local <pwd>` — it creates a symlink so `tamandua` on your PATH always uses the dist from your checkout. No global npm install, no GitHub clone needed.

```bash
# After editing source, rebuild:
./build

# Run tests:
npm test
```

## Project Structure

```
tamandua/
├── bin/tamandua                  # Shell wrapper
├── src/
│   ├── index.ts                  # Export entry
│   ├── db.ts                     # SQLite database
│   ├── cli/
│   │   ├── cli.ts                # Main CLI entry point
│   │   ├── ant.ts                # ASCII art easter egg
│   │   └── ant.test.ts           # Easter egg tests
│   ├── installer/
│   │   ├── install.ts            # Workflow installer
│   │   ├── uninstall.ts          # Workflow uninstaller
│   │   ├── agent-provision.ts    # Agent workspace provisioning
│   │   ├── agent-scheduler.ts    # Pi-based agent polling scheduler
│   │   ├── workflow-fetch.ts     # Fetch bundled workflows
│   │   ├── workflow-spec.ts      # Load/workflowspec from YAML
│   │   ├── workspace-files.ts    # File copy utilities
│   │   ├── step-ops.ts           # Step claim/complete/fail/pipeline logic
│   │   ├── run.ts                # Run creation
│   │   ├── status.ts             # Run status queries
│   │   ├── events.ts             # Event logging
│   │   ├── logs-tail-format.ts   # Shared logs-tail line formatting (CLI + dashboard API)
│   │   ├── paths.ts              # Path resolution
│   │   ├── types.ts              # Shared types
│   │   ├── pi-config.ts          # pi config reading
│   │   └── symlink.ts            # CLI symlink management
│   ├── server/
│   │   ├── daemon.ts             # Dashboard daemon process (co-manages dashboard + MCP listeners)
│   │   ├── daemonctl.ts          # Daemon lifecycle control
│   │   ├── dashboard.ts          # Dashboard HTTP server
│   │   ├── mcp-server.ts         # Remote MCP HTTP server bootstrap (streamable transport)
│   │   └── index.html            # Dashboard UI
│   ├── medic/
│   │   ├── medic.ts              # Health check orchestration
│   │   ├── checks.ts             # Individual health checks
│   │   └── medic-cron.ts         # Cron setup for medic
│   └── lib/
│       ├── logger.ts             # File logging
│       ├── logger.test.ts        # Logger tests
│       └── frontend-detect.ts    # Frontend file detection
├── workflows/                    # Bundled workflow definitions
├── agents/shared/                # Shared agent personas
├── skills/                       # Bundled skills
├── docs/                         # User documentation
├── tests/                        # Integration tests
├── scripts/                      # Build scripts
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

Tamandua is an agent team orchestrator built on top of pi (the coding agent CLI).

### Runtime model

- Agent settings live at `~/.pi/agent/settings.json`
- Work is dispatched via direct `pi --print` invocation (no gateway HTTP API)
- Sessions use `pi --print --session`
- Agent config lives in `~/.tamandua/agents.json`
- Permissions are expressed as role descriptions

### Agent Scheduler

The agent scheduler uses in-memory `setInterval` timers (not OS cron) to poll agents:

1. Polling phase: cheap model checks `step peek` → HAS_WORK or NO_WORK
2. Work phase: if HAS_WORK, spawns `pi --print` with the agent's workspace and prompt
3. `runPi` emits lifecycle logs (`pi pre-launch`, `pi launched`, `pi completed`/`pi execution failed`) with PID, timing, and bounded stream preview metadata for observability without dumping full prompts or large stderr payloads
4. `executePollingRound` emits stage logs (`Polling round skipped/start/complete/failed`) with shared round context (`jobId`, `agentId`, timeout/workdir/model when available) and bounded outcome/error previews
5. Polling rounds run pi in JSON mode (`--mode json`) so scheduler logic can extract `message_end.message.usage` token metadata and attribute increments to `runs.tokens_spent` using run IDs parsed from tool outputs (with step-id fallback).
6. Successful token attribution emits a `run.tokens.updated` event (`tokenDelta` + `tokensSpent` fields); terminal run lifecycle events (`run.completed`/`run.failed`) also carry `tokensSpent` for cost visibility.

### Step Lifecycle

```
waiting → pending → running → done/failed
```

- Steps start as `waiting` (blocked by preceding steps)
- Pipeline advancement marks them `pending`
- Agent claims → `running`
- Agent completes → `done`, pipeline advances
- Agent fails → retry or escalate

## State

- SQLite database: `~/.tamandua/tamandua.db`
- Agent config: `~/.tamandua/agents.json`
- Cron jobs: `~/.tamandua/cron-jobs.json`
- Events: `~/.tamandua/events.jsonl`
- Logs: `~/.tamandua/tamandua.log`
- Medic: `~/.tamandua/medic.json`

## Testing

```bash
# Run all tests
npm test

# Or build first then test (tests import from dist/)
npm run build && npm test
```

Tests use Node's built-in `node:test` and `node:assert`.
The full suite must run serially because several integration tests exercise fixed local ports and daemon state; `npm test` includes `--test-concurrency=1`.

`src/server/mcp-server.ts` supports dependency injection via `createTamanduaMcpServer(..., { services })` / `startTamanduaMcpServer(..., { services })`; protocol tests in `src/server/mcp-server.test.ts` should use this hook instead of duplicating DB/event setup.

`src/server/daemon.ts` now starts dashboard + MCP together (dashboard port from `~/.tamandua/port`, MCP fixed to 3338). Co-lifecycle regression coverage lives in `src/server/daemon.test.ts`.

Dashboard UI regressions are covered in `src/server/dashboard.test.ts` by fetching `/` from `createDashboardServer(...)` and asserting required HTML/script hooks (including logs-tail cursor polling markup).

Bundled skill artifacts are validated in `tests/workflow-validation.test.ts` (existence, frontmatter, required command guidance, and workflow `workspace.skills` wiring).
Bundled workflows are discovered by directory under `workflows/`; `tests/workflow-validation.test.ts` asserts each directory's `workflow.yml` has a matching `id` and that every `workspace.files` path exists relative to the workflow directory.
Workflow catalog discoverability is also regression-tested there: README entries (heading + pipeline sequence) can be enforced for bundled workflows such as `feature-dev-merge`.
Bundled workflow agents that run Tamandua steps should declare `tamandua-agents` in `workspace.skills`; when adding it, preserve any existing skills like `agent-browser`.
Step output parsing (`parseOutputKeyValues` in `src/installer/step-ops.ts`) lowercases keys, so an agent output like `ORIGINAL_BRANCH: main` is consumed downstream as `{{original_branch}}`.
Installer skill copy behavior (workflow-local + shared bundled skills) is covered in `tests/agent-skill-provisioning.test.ts`.

For CLI integration tests, spawn `dist/cli/cli.js` and set temporary `TAMANDUA_STATE_DIR` plus `HOME` so event files and SQLite DB access are isolated per test.
Dashboard API integration tests should also run in a subprocess with temp `HOME` (e.g., `dist/server/dashboard.js`), because DB path resolution in `src/db.ts` is bound at module load.
