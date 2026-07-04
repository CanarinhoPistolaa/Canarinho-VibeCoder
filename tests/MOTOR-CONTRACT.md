# The Motor Contract

**The "motor"** is the machinery that drives workflow progress: the agent
scheduler (`src/installer/agent-scheduler.ts`), harness invocation
(`runPi`/`runHermes`), and the step-ops pipeline advance (`step-ops.ts`).

The motor is **deterministic dispatch**: per-(runId, agentId) in-memory
jobs whose rounds (`executeDispatchRound`) decide "is there work?" with an
in-process `peekStep` SQL COUNT and spawn a `pi --print --mode json` (or
hermes) harness ONLY when a pending step exists. Checking for work never
invokes a model, so idle runs spend **zero** tokens. The 15-second tick
(`DISPATCH_INTERVAL_MS`) is a fallback sweep (it also drives stale-claim
recovery); step completions, retries, and run starts nudge the daemon
(`/control/nudge`) for immediate dispatch, so step-to-step latency is
near zero.

This replaced the model-driven polling motor (removed 2026-07-02), where
every poll tick spawned a full model invocation whose prompt told the model
to run `step peek` and reply `HEARTBEAT_OK` when idle — measured at ~30%
token overhead on real runs (see the historical baselines at the bottom).

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

- **C0-binary** Work spawns resolve the harness binary PER INVOCATION:
  `TAMANDUA_PI_BINARY` env override (config/test seam) → `pi-token-saver`
  from PATH when the run is no-hurry (`--no-hurry-please-save-tokens-mode`)
  → `pi` from PATH. Installing pi-token-saver mid-run takes effect on the
  next round. Pinned by `tests/pi-token-saver.test.ts`.
- **C5** Each pending step is executed exactly once at a time: concurrent
  dispatch attempts (timer tick + nudge, two claimants) must not double-run a
  step (in-flight guards, claim atomicity), and duplicate completions
  (at-least-once delivery) must be no-ops. Late completions after a
  stale-claim sweep ARE accepted — the work was done. Pinned by
  `tests/step-ops-dispatch-races.test.ts`.
- **C6** Idle agents (no pending step) cause no state changes.
- **C7** `nudge` (control plane) triggers immediate dispatch consideration
  for all scheduled agents of running runs. `completeStep`/`failStep`-retry
  and run start/resume fire best-effort nudges; the fallback tick covers a
  missed nudge.

### Deterministic-motor guarantees

- **N1** Idle dispatch invokes **no model**: an idle run accrues **zero**
  `system_tokens_spent`. The ledger (`tamandua_stats.system_tokens_spent`)
  is kept as a tripwire — nothing writes to it; a growing value means
  model-driven dispatch was reintroduced.
- **N2** Harness (model) invocations per run == executed work rounds — the
  scripted-agent invocation journal records zero heartbeat invocations.
- **N3** Work-token attribution (C14/C15) still holds — work still costs.

Pinned by `tests/deterministic-motor-acceptance.test.ts` (in-process
dispatch rounds with an instrumented fake pi) and by the scripted e2e
baseline assertions.

### Failure & recovery

- **C8** `step fail` → retry until `max_retries` → escalate per `on_fail`.
- **C9** Lost steps are recovered: an agent that claims a step and exits
  without reporting (no STATUS output, crash, non-zero exit, timeout kill)
  leaves a `running` step that must be requeued and retried — not stuck
  forever.
- **C10** `expects` mismatch (e.g. verifier replies `STATUS: retry`) triggers
  the step's `on_fail` wiring (`retry_step`, `max_retries`, `on_exhausted`).
- **C8-rugpull** Rugpull relaunch applies **only** to `finalize_merge` step
  failures in merge workflows (`*-merge`, `*-merge-worktree`) where the base
  branch tip moved since the run started. Mid-pipeline step retry exhaustion,
  expects validation exhaustion, and worker death permanently fail the run by
  design UNLESS the workflow declares `on_fail.retry_step` (see C19).
  Permanently failed runs are retryable via `tamandua workflow resume` with
  fix-then-restart semantics.
- **C19 (RETR — declarative cross-step retry routing)** When a step declares
  `on_fail.retry_step` and exhausts its local retries, the run does NOT
  immediately fail. Instead the run reroutes to the named upstream producer
  step (lower `step_index` in the same workflow) with a bounded reroute
  budget (`on_fail.max_reroutes`, default 2). The producer is re-pended
  (status `pending`, `retry_count` unchanged) with retry feedback in its
  output; the failing consumer is reset to `waiting` with `retry_count=0`
  and `reroute_count` incremented; intermediate `done` steps between
  producer and consumer are untouched — `advancePipeline` naturally
  re-pends the consumer after the producer completes. When the consumer's
  `reroute_count` reaches `max_reroutes`, the budget is exhausted and the
  run falls through to normal failure semantics (including rugpull detection
  on merge-step failures). The reroute budget is separate from `retry_count`:
  the producer's `retry_count` stays unchanged; the consumer's `retry_count`
  resets to 0 on each reroute; `reroute_count` is the dedicated boundedness
  counter. Each reroute emits a `step.rerouted` event; budget exhaustion
  emits `step.reroute_budget_exhausted`. RETR does NOT fire for loop-step
  story-level exhaustion (`verify_each` territory) or for `finalize_merge`
  (rugpull owns merge-failure recovery).

### Control plane & scheduling lifecycle

- **C11** Pause stops dispatch for the run (draining in-flight work); resume
  restarts it; terminate tears down scheduling and kills in-flight harness
  processes.
- **C12** Run-scoped scheduling is torn down when the run reaches a terminal
  state (no leaked timers dispatching for completed runs). Teardown triggered
  by *natural completion* gives in-flight harness processes a grace window
  (`HARNESS_TEARDOWN_GRACE_MS`) to flush output and exit on their own;
  user-initiated terminate/pause/cancel of an active run kills immediately.
- **C13** Scheduling state is reconstructable from the DB (daemon restart
  reconciles jobs from `runs.scheduling_status`).
- **C18** Steps claimed by DEAD workers are requeued promptly: the daemon
  reconciler sweeps `running` steps whose `claim_pid` no longer exists
  (first tick ~1 s after startup, then every cycle) and nudges the affected
  runs. A daemon crash/reboot/kill therefore un-wedges interrupted runs in
  seconds — not the 1.5×timeout age threshold (up to 45 min), and never
  "forever" when no dispatch was running. Survivor guard: if the step's
  claim_pgid (the harness process group, self-detected by `step claim`) is
  still ALIVE, the step is left alone — an ungracefully killed daemon does
  not kill its detached harness children, and requeuing would put two
  agents in one workdir; the survivor's late completion is accepted (C5).
  Pinned by `tests/dead-worker-recovery.test.ts` and the scripted e2e
  daemon-SIGKILL test. Relatedly, `stopDaemon`/`stopMcp`/`stopControlPlane`
  refuse to signal the daemon named by TAMANDUA_WORKER_PID — an agent can
  no longer stop the very daemon scheduling it
  (`src/server/daemonctl-self-stop-guard.test.ts`).

### Post-grace process cleanup sweep

When a run reaches a terminal state, in-flight harness processes are given a
grace window (`HARNESS_TEARDOWN_GRACE_MS`, 10 s) to flush output and exit
(C12). After the grace window expires, a **post-grace process cleanup
sweep** (`sweepRunProcesses` in `src/installer/run-cleanup.ts`) kills any
surviving orphan processes associated with the run.

**Architecture:**

- **Daemon-resident scheduling:** `removeRunCrons` in
  `src/installer/agent-scheduler.ts` schedules a one-shot, unref-ed timer at
  `HARNESS_TEARDOWN_GRACE_MS + 2 s` for every run whose crons are torn down.
  When the timer fires, `sweepRunProcesses` is called with the daemon PID
  excluded and NO `excludePgids` — after the grace window, any remaining
  harness process group was not cleaned up by the leak guard (C12) and IS a
  leak. The 2 s buffer gives the leak guard's immediate kill time to
  complete before the sweep runs.
- **Deduplication:** At most one pending timer per run (module-level
  `Map<runId, Timeout>` in agent-scheduler.ts). Duplicate `removeRunCrons`
  calls (e.g., control-plane terminate + natural completion race) do not
  create duplicate sweeps.
- **Daemon-resident by design:** The sweep timer is scheduled inside the
  daemon, not in the short-lived CLI process (`scheduleRunCronTeardown` in
  `step-ops.ts` no longer schedules a sweep — the CLI-side hook was removed
  in US-003; its unref-ed timer never fired in short-lived CLI processes
  anyway). The daemon is the natural long-lived home for the post-grace
  sweep.
- **Complementary pre-removal sweep:** The worktree-manager
  pre-removal sweep (`src/installer/worktree-manager.ts`, line ~354) runs
  `sweepRunProcesses` WITH `excludePgids` at worktree removal time, and
  remains unchanged. This sweep handles cleanup during worktree garbage
  collection, not during teardown.

**Accepted-miss risks:**

- **Daemon restart before sweep timer fires:** If the daemon is stopped or
  crashes between scheduling the timer and its firing, the sweep is lost.
  The pending sweep timers are in-memory only — they are not persisted.
- **Late-detaching stragglers:** A process that detaches from the harness
  process group after the sweep has already run (e.g., a deeply nested
  child subprocess that survives parent exit and re-parents to init) will
  not be caught by the one-shot sweep.

**Accountability layer — doctor check:** The `runProcessLeakChecks` function
in `src/doctor.ts` (STATE category, report-only, NEVER kills) scans for
processes belonging to runs in terminal status and reports them as warnings
with PID, evidence string, and run ID. This is the accountability layer for
accepted-miss risks: it surfaces leaked processes that escaped the sweep so
a human can clean them up. Remedy text: `Manual cleanup: kill <pid>`.

### Token accounting

- **C14** Model usage from *work* is attributed to `runs.tokens_spent`
  (via `message_end.usage` + run/step IDs from tool outputs, falling back to
  the dispatch job's own runId), emitting `run.tokens.updated` events with
  `tokenDelta`/`tokensSpent`.
- **C15** Terminal run events (`run.completed`/`run.failed`) carry
  `tokensSpent`. Caveat (inherent to the event ordering): the FINAL round's
  usage is parsed only after the harness exits, i.e. after the terminal
  event fired — so the event's `tokensSpent` can under-report by the final
  round (a single-step run reports 0). `runs.tokens_spent` in the DB is the
  eventually-correct total; tests must wait for it (`waitForRunWorkTokens`
  in e2e-helpers) rather than race it.

### Workspace

- **C16** Worktree runs execute in a managed detached worktree
  (`git worktree add --detach`, shared refs with the origin repository);
  branches created in the worktree are mergeable from the origin.
- **C17** The harness process runs with cwd = the run's
  `workingDirectoryForHarness` and inherits the daemon environment
  (state dir, DB path, control port).

## Where the contract is enforced

| Tier | Command | Motor coverage |
|------|---------|----------------|
| Scripted-agent e2e (**primary net**) | `./run-all-scripted-e2e-tests` | Real daemon → dispatch scheduler → harness spawn → stream parse → step-ops → pipeline advance → worktree/merge, driven by a deterministic fake pi. Zero tokens, ~1 min. Covers C1–C9, C12, C14–C17 and asserts N1/N2 (0 heartbeats, 0 system tokens). |
| Deterministic-motor acceptance | part of `npm test` (`tests/deterministic-motor-acceptance.test.ts`) | N1–N3 via in-process `executeDispatchRound` with an instrumented fake pi. |
| Smoke e2e | `./run-all-smoke-e2e-tests` | State machine + pipeline wiring via manual `step claim`/`complete`. Bypasses the motor. C1–C4. |
| Workflow graph simulation | part of `npm test` (`tests/workflow-graph-simulation.test.ts`) | Every bundled workflow simulated to completion in-process through pure step-ops (happy path, mid-run retry, retry exhaustion). Pins C1–C4, C8 independent of any motor. ~3 seconds for the whole catalog. |
| Unit/integration | `npm test` | step-ops invariants, recovery, control plane, DB, CLI, work-prompt shape, harness routing, work-round token attribution, persona injection. `npm test` pins `TAMANDUA_PI_BINARY=/bin/false` so no unit test can ever reach a real model. |
| Real canary | `./run-real-e2e-canary` | ONE do-now run with a live model + token-accounting audit (C14/C15) and real-model baseline print (`systemTokens` must be 0). Small token spend. Run at motor milestones before the full real suite. |
| Real e2e | `./run-all-real-e2e-tests` | Full pipeline with live models, with token audits and on-timeout diagnostics. Final acceptance gate only: real tokens, minutes-to-tens-of-minutes per workflow. |

## Baselines

Deterministic motor (scripted e2e, zero-token, printed every run):
`bug-fix-merge-worktree = 6 work rounds, 0 heartbeat rounds, 666 work
tokens attributed to the run, 0 system tokens.`

Historical — the model-driven polling motor this replaced (real-model
campaign, 2026-07-03, all tiers green):

| Run | Work tokens | System tokens (idle polls) | Wall time |
|---|---|---|---|
| do-now canary | ~3,300 | ~0 (nudge-driven, finished before idle polls) | ~14 s |
| bug-fix-merge-worktree (real e2e) | 45,869 | 19,286 | 7.9 min |
| feature-dev-merge-worktree (real e2e) | 51,207 | ~23,105 (counter cumulative: 42,391) | 7.7 min |

Idle polling added ~30% token overhead on top of real work and scaled with
wall time, not with work.

Deterministic motor — real-model baselines (post-rewrite acceptance
campaign, 2026-07-02, all tiers green):

| Run | Work tokens | System tokens | Wall time |
|---|---|---|---|
| do-now canary | 3,052 | **0** | ~15 s |
| bug-fix-merge-worktree (real e2e) | 42,251 | **0** (was 19,286) | 3.5 min (was 7.9) |
| feature-dev-merge-worktree (real e2e) | 39,679 | **0** (was ~23,105) | 3.3 min (was 7.7) |

The idle-poll overhead is zero by construction (N1), and wall time roughly
halved: nudge-driven dispatch removed the poll-interval dead time between
steps, so runs now spend their time on model work, not waiting.

## Quirks the motor test campaigns exposed — all fixed

2026-07-02 (found by the scripted tier before the rewrite):

- `completeStep` had no duplicate-completion guard: a completion arriving
  for a step already `done` (agent CLI retry, orphan-recovery reclaim race)
  re-merged context, re-inserted STORIES_JSON stories, and re-advanced the
  pipeline. Rarely hit under the slow polling motor; the fast deterministic
  dispatcher would hit it. FIXED: terminal-status steps return
  `{ status: "blocked" }`; running/pending steps still complete normally.
  Regression: `tests/step-ops-dispatch-races.test.ts`.
- Prompts instructed `node "<cli>" ...` while `resolveTamanduaCli()` returns
  the `bin/tamandua` **shell** script; `node bin/tamandua` throws a
  SyntaxError. Live LLM agents had been silently working around the error
  every round — a deterministic agent cannot. FIXED: prompts invoke the CLI
  launcher directly.
- Run completion rugpulled the in-flight harness process group the moment
  the final `step complete` landed. Real pi emits its final assistant
  message (with token usage) AFTER the completing tool call, so the final
  round's usage was systematically lost. FIXED: completion-triggered
  teardown schedules the kill after `HARNESS_TEARDOWN_GRACE_MS` (leak guard
  only); user-initiated terminate/pause of active runs still kills
  immediately. Regression: "final-round token usage survives completion
  teardown" in workflows-scripted.test.ts.

2026-07-02 (exposed by the faster dispatch during the rewrite):

- `getDb()` rotated its cached handle every 5 s by closing it in place,
  killing the handle out from under synchronous callers that captured it
  earlier in the same call chain. FIXED: the close is deferred one tick.
- Concurrent writers (daemon dispatch + CLI completions + migrations) hit
  instant "database is locked" errors. FIXED: `PRAGMA busy_timeout = 5000`.
- Unit tests that start daemons could reach a REAL model: the old motor's
  minutes-long first poll had masked it; instant dispatch exposed it.
  FIXED: `npm test` pins `TAMANDUA_PI_BINARY=/bin/false` (passes through
  `cleanChildEnv`), and the one deliberately-real-pi unit test is opt-in
  via `TAMANDUA_REAL_PI_TESTS=1`.

### Report-format contract (MPRT)

The work prompt's REPORT section defers to each step's own `Reply with:`
format; the generic `STATUS/CHANGES/TESTS` shape is a fallback used only
when the task specifies no reply format. History (both dev machines, both
motors): the old always-generic example trained agents to answer
`STATUS/CHANGES/TESTS` regardless of the step's key contract, starving
downstream template keys (`branch`, `verified`, …) in 10–90% of runs —
first silently (`[missing: key]` rendered into prompts), then fatally once
claim-time key enforcement landed. Pinned by tests/work-prompt.test.ts.
