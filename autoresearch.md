# Autoresearch: Increase test coverage to 100%

## Objective
Increase line coverage of the tamandua project by adding tests to source files under `src/`.

## Metrics
- **Primary**: `coverage` (ratio, higher is better) — line coverage from `./measure-test-coverage.sh`
- **Secondary**: none

## Current Status (after 19 experiments)
- **Baseline**: 0.4677 (46.77%)
- **Stable best**: 0.4815 (48.15%)
- **Improvement**: +0.0138 / +3.0%
- **New test files**: 16 files, ~130 tests
- **New modules covered**: agent-cron (0→100%), checks (0→65%), medic-cron (0→83%), medic (0→44%)
- **Biggest per-file gains**: pi-config (45→100%), symlink (66→87%), workspace-files (75→92%), run-harness (76→96%), update (70→89%)
- **Limiting factor**: Pi dependency code (~thousands of uncovered lines) dominates the aggregate metric. Tamandua's own modules are now well-covered but the `all files` aggregate is capped by third-party code.

## How to Run
`./measure-test-coverage.sh` — outputs `0.XXXXXX` (line coverage ratio). The `autoresearch.sh` wrapper reads the script output and produces `METRIC coverage=0.XXXXX`.

## Files in Scope
All `.ts` source files under `src/` (compiled to `dist/`). Tests live in:
- `src/**/*.test.ts` — unit tests co-located with source (preferred for new tests)
- `tests/*.test.ts` — integration tests

### Remaining tamandua gaps (complex, DB-heavy)
- `install.js`: 49.13% — internal functions (needs full installWorkflow integration test)
- `cli.js`: 71.70% — main CLI handlers (needs subprocess testing)
- `daemonctl.js`: 70.32% — daemon start/stop paths
- `medic.js`: 43.92% — runSyncChecks/remediate (DB-heavy)
- `step-ops.js`: 77.97% — completeStep, advancePipeline, cleanupAbandonedSteps (complex DB logic)

## Off Limits
- Do NOT modify `measure-test-coverage.sh` — it must remain a pure coverage gauge
- Do NOT add new dependencies to package.json
- Do NOT modify production source code to make it "more testable" — only add tests

## Constraints
- All tests must pass: `npm test` must exit 0 (enforced by `autoresearch.checks.sh`)
- Rebuild before measuring: `./build` must succeed
- Tests are parallel-safe: use isolated HOME/TAMANDUA_STATE_DIR temp dirs per test
- Prefer `src/**/*.test.ts` (co-located) to `tests/*.test.ts` (integration) for new unit tests

## What's Been Tried

### Experiments (13 total, baseline 0.4677, best 0.4817)

| # | Description | Coverage | Status | Delta |
|---|-------------|----------|--------|-------|
| 1 | Baseline | 0.4677 | keep | — |
| 2 | pi-config tests (readPiConfig, writePiConfig, readPiAuth) — 9 tests | 0.4687 | keep | +0.0010 |
| 3 | install exports + symlink + workflow-fetch + step-ops pure functions — 60 tests | 0.4795 | keep | +0.0108 |
| 4 | workspace-files + control-server unit exports — 19 tests | 0.4799 | keep | +0.0004 |
| 5 | parseAndInsertStories — 9 tests | 0.4698 | discard | -0.0101 (noise) |
| 6 | Medic modules + agent-cron + update tests — 33 tests | 0.4708 | keep | +0.0010 |
| 7 | checks.test.ts + extended update.test.ts — 11 tests | 0.4712 | keep | +0.0004 |
| 8 | uninstall + run-harness tests — 12 tests | 0.4714 | keep | +0.0002 |
| 9 | daemonctl dashboard tests | 0.4715 | checks_failed | pi binary timeout |
| 10 | daemonctl dashboard helpers (re-added) | 0.4817 | keep | +0.0103 |
| 11 | status.ts tests | 0.4815 | checks_failed | pi binary timeout |
| 12 | status.ts tests (re-added) | 0.4714 | discard | below best |
| 13 | workflow-spec tests | 0.4714 | discard | below best |

### Modules brought from 0% coverage
- `agent-cron.js`: 0% → 100%
- `checks.js`: 0% → 65.25%
- `medic-cron.js`: 0% → 83.33%
- `medic.js`: 0% → 43.92%

### Largest individual improvements
- `update.js`: 70.29% → 88.70% (+18.4pp)
- `pi-config.js`: 45.16% → 100% (+54.8pp)
- `symlink.js`: 66.09% → 86.96% (+20.9pp)
- `workspace-files.js`: 74.70% → 91.57% (+16.9pp)
- `run-harness.js`: 76.47% → 95.59% (+19.1pp)

### Key insight
Pi dependency code (~thousands of uncovered lines from node_modules) dominates the aggregate coverage metric. Tamandua's own modules have improved dramatically but the `all files` aggregate barely moves. The 0.47-0.48 range appears to be a practical ceiling for this approach. To reach significantly higher values, the measurement would need to exclude pi dependencies (e.g., filter to `dist/` only).

### Remaining tamandua gaps
- `install.js`: 49.13% — internal functions (needs full installWorkflow integration test)
- `cli.js`: 71.70% — main handlers (needs CLI subprocess tests)
- `daemonctl.js`: 70.32% — daemon start/stop paths
- `medic.js`: 43.92% — runSyncChecks/remediate (DB-heavy)
- `step-ops.js`: 77.97% — completeStep, advancePipeline, cleanupAbandonedSteps (complex DB logic)
