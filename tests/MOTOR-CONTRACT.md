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
wall time, not with work. The deterministic motor eliminates it by
construction (N1) — record post-rewrite real-model baselines below as
campaigns run.

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
