# The Motor Contract

**The "motor"** is the machinery that drives workflow progress: the agent
scheduler (`src/installer/agent-scheduler.ts`), harness invocation
(`run-harness.ts`, `runPi`/`runHermes`), and the step-ops pipeline advance
(`step-ops.ts`). Today's motor is **model-driven polling**: every
`intervalMinutes` (default 5) each run-scoped agent job spawns a full
`pi --print --mode json` model invocation whose prompt tells the model to run
`step peek` and either reply `HEARTBEAT_OK` or claim-and-execute. Idle polls
therefore burn model tokens ("system tokens", counted in
`tamandua_stats.system_tokens_spent`).

A planned rewrite replaces this with a **deterministic motor**: peek/dispatch
decided by direct DB queries, a model spawned only when there is actual work.
This document defines what must stay true across that swap, and classifies
the existing test suite so that red tests during the rewrite are
interpretable.

## How to use this during the motor rewrite

1. Tests listed under **Mechanism tests** below (also header-tagged
   `MOTOR-MECHANISM` in the file) pin the *current* implementation. They are
   expected to churn, be rewritten, or be deleted alongside the motor.
2. Everything else — especially the **scripted-agent e2e tier**
   (`./run-all-scripted-e2e-tests`) and the smoke tier — asserts the
   contract. A failure there during the rewrite is a real regression, not
   noise.
3. When the deterministic motor lands, flip the "current-motor baseline"
   assertions marked in `e2e-tests/workflows-scripted.test.ts` (system tokens
   > 0 becomes == 0) and satisfy the **New-motor acceptance criteria** below.

## Contract invariants (any motor must satisfy these)

### Lifecycle & pipeline

- **C1** Steps advance `waiting → pending → running → done|failed`; pipeline
  advancement marks the next reachable step(s) `pending` when a step
  completes.
- **C2** Steps execute in the order and dependency structure declared by the
  workflow spec; a run completes exactly when all steps are `done`.
- **C3** Agent output is classified by exact STATUS markers
  (`STATUS: done`, `STATUS: failed`/`error`). Output matching the step's
  `expects` completes it; anything else takes a failure/retry path.
- **C4** `KEY: value` lines in step output are captured into run context and
  resolve `{{placeholders}}` in later step inputs (e.g. `{{branch}}`,
  `{{original_branch}}` seeding for worktrees).

### Dispatch

- **C5** Each pending step is executed exactly once at a time: concurrent
  dispatch attempts (timer tick + nudge, two claimants) must not double-run a
  step (in-flight guards, claim atomicity).
- **C6** Idle agents (no pending step) cause no state changes.
- **C7** `nudge` (control plane) triggers immediate dispatch consideration
  for all scheduled agents of running runs.

### Failure & recovery

- **C8** `step fail` → retry until `max_retries` → escalate per `on_fail`.
- **C9** Lost steps are recovered: an agent that claims a step and exits
  without reporting (no STATUS output, crash, non-zero exit, timeout kill)
  leaves a `running` step that must be requeued and retried — not stuck
  forever.
- **C10** `expects` mismatch (e.g. verifier replies `STATUS: retry`) triggers
  the step's `on_fail` wiring (`retry_step`, `max_retries`, `on_exhausted`).

### Control plane & scheduling lifecycle

- **C11** Pause stops dispatch for the run (draining in-flight work); resume
  restarts it; terminate tears down scheduling and kills in-flight harness
  processes.
- **C12** Run-scoped scheduling is torn down when the run reaches a terminal
  state (no leaked timers polling completed runs). Teardown triggered by
  *natural completion* gives in-flight harness processes a grace window
  (`HARNESS_TEARDOWN_GRACE_MS`) to flush output and exit on their own;
  user-initiated terminate/pause/cancel of an active run kills immediately.
- **C13** Scheduling state is reconstructable from the DB (daemon restart
  reconciles jobs from `runs.scheduling_status`).

### Token accounting

- **C14** Model usage from *work* is attributed to `runs.tokens_spent`
  (via `message_end.usage` + run/step IDs from tool outputs), emitting
  `run.tokens.updated` events with `tokenDelta`/`tokensSpent`.
- **C15** Terminal run events (`run.completed`/`run.failed`) carry
  `tokensSpent`.

### Workspace

- **C16** Worktree runs execute in a managed detached worktree
  (`git worktree add --detach`, shared refs with the origin repository);
  branches created in the worktree are mergeable from the origin.
- **C17** The harness process runs with cwd = the run's
  `workingDirectoryForHarness` and inherits the daemon environment
  (state dir, DB path, control port).

### New-motor acceptance criteria (goals of the rewrite)

- **N1** Idle polling invokes **no model**: with the deterministic motor, an
  idle run accrues **zero** `system_tokens_spent`.
- **N2** Harness (model) invocations per run == number of executed work
  rounds — no model-driven peeks.
- **N3** Work-token attribution (C14/C15) still holds — work still costs.

The scripted e2e prints the current-motor baseline per run, e.g.:
`6 work rounds, ~30 heartbeat rounds, 666 work tokens, ~476 system tokens`
(bug-fix-merge-worktree, 2026-07-02). N1/N2 flip those heartbeat/system
numbers to zero without changing work rounds or outcomes.

## Where the contract is enforced

| Tier | Command | Motor coverage |
|------|---------|----------------|
| Scripted-agent e2e (**primary net for the rewrite**) | `./run-all-scripted-e2e-tests` | Real daemon → scheduler → harness spawn → stream parse → step-ops → pipeline advance → worktree/merge, driven by a deterministic fake pi. Zero tokens, ~1 min. Covers C1–C9, C12, C14–C17. |
| Smoke e2e | `./run-all-smoke-e2e-tests` | State machine + pipeline wiring via manual `step claim`/`complete`. Bypasses the motor — stays green across the swap. C1–C4. |
| Workflow graph simulation | part of `npm test` (`tests/workflow-graph-simulation.test.ts`) | Every bundled workflow simulated to completion in-process through pure step-ops (happy path, mid-run retry, retry exhaustion). Pins C1–C4, C8 independent of any motor. ~3 seconds for the whole catalog. |
| Unit/integration | `npm test` | step-ops invariants, recovery, control plane, DB, CLI. Mixed contract + mechanism (see triage). `tests/deterministic-motor-acceptance.test.ts` carries N1–N3 as todo tests until the new motor lands. |
| Real e2e | `./run-all-real-e2e-tests` | Full pipeline with live models. Final acceptance gate only: real tokens, 30–60 min/workflow. |

## Test triage: mechanism vs contract

**Mechanism tests** (header-tagged `MOTOR-MECHANISM`; expected churn during
the rewrite — they pin model-driven polling internals like
`buildPollingPrompt`, `executePollingRound`, `classifyPollingRoundOutcome`,
`parsePollingRoundMetadata`, heartbeat system-token attribution):

- `tests/agent-scheduler.test.ts`
- `tests/parse-polling-metadata.test.ts`
- `tests/polling-config.test.ts`
- `tests/polling-round-observability.test.ts`
- `tests/polling-round-persona-prompt.test.ts`
- `tests/polling-round-token-attribution.test.ts`
- `tests/pi-token-e2e.test.ts`
- `tests/run-token-observability-e2e.test.ts`
- `tests/system-token-attribution.test.ts`
- `tests/system-token-spend-counter.test.ts`
- `tests/work-prompt.test.ts`
- `src/installer/agent-scheduler.test.ts`
- `src/installer/agent-scheduler-harness-routing.test.ts`
- `src/installer/agent-scheduler-hermes.test.ts`
- `src/installer/agent-cron.test.ts`

Notes on near-misses that are **contract**, not mechanism:

- `tests/peek-step-polling.test.ts` — `peekStep()` semantics survive any
  motor (the deterministic motor calls it directly); only its one
  polling-prompt assertion is mechanism.
- `tests/orphaned-step-recovery.test.ts`, `tests/terminal-state-guards.test.ts`,
  `tests/step-ops.test.ts`, `src/installer/step-ops-*.test.ts` — C5/C8/C9/C10.
- `tests/system-token-spend-migration.test.ts`, `tests/run-token-migration.test.ts`,
  `src/db.test.ts` — schema/migrations survive.
- `tests/pi-stream-parser.test.ts`, `src/installer/pi-stream-parser-extra.test.ts`,
  `src/installer/agent-scheduler-binary-discovery.test.ts`,
  `tests/pi-command-preview.test.ts` — the work phase still spawns pi and
  parses its stream under the new motor.
- Control-plane, daemon, dashboard, CLI, installer, www tests — untouched by
  the motor swap.

## Quirks the scripted tier exposed (2026-07-02) — both fixed same day

- The polling prompt instructed `node "<cli>" ...` while
  `resolveTamanduaCli()` returns the `bin/tamandua` **shell** script;
  `node bin/tamandua` throws a SyntaxError. Live LLM agents had been
  silently noticing the error and working around it every round — a
  deterministic agent cannot. FIXED: prompts now invoke the CLI launcher
  directly (no `node` prefix); the scripted runtime handles either form by
  shebang detection.
- Run completion rugpulled the in-flight harness process group the moment
  the final `step complete` landed. Real pi emits its final assistant
  message (with token usage) AFTER the completing tool call, so the final
  round's usage was systematically lost. FIXED: completion-triggered
  teardown now schedules the kill after `HARNESS_TEARDOWN_GRACE_MS` (leak
  guard only); user-initiated terminate/pause of active runs still kills
  immediately. Regression: "final-round token usage survives completion
  teardown" in workflows-scripted.test.ts (reportBeforeEmit models the
  real-pi ordering).
