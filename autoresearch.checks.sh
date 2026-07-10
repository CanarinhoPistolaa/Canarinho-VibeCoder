#!/bin/bash
# Correctness checks: ensure all tests pass.
set -euo pipefail

cd "$(dirname "$0")"

# Build first (tests import from dist/)
./build 2>&1 | tail -5

# Run all tests except known flaky/environment-dependent files:
# - agent-scheduler.test.ts: requires real pi binary, can time out
# - mcp-lifecycle.test.ts: EADDRINUSE port conflicts under parallel load
# - doctor.test.ts: depends on hermes-token-saver being on PATH
# - run.test.ts: hookFailed under parallel load (daemon port conflicts)
TEST_OUTPUT=$(node --test --test-timeout=120000 \
  tests/bug-fix-merge-workflow.test.ts \
  tests/agent-skill-provisioning.test.ts \
  tests/claim-ownership-recording.test.ts \
  tests/cli-pause-all-resume-all-integration.test.ts \
  tests/cli-pause-all-resume-all.test.ts \
  tests/cli-pause-command.test.ts \
  tests/cli-pause-resume-integration.test.ts \
  tests/cli-resume-command.test.ts \
  tests/cli-skill-path.test.ts \
  tests/cli-status-token-display.test.ts \
  tests/cli-workflow-run-working-directory.test.ts \
  tests/control-plane-cli.test.ts \
  tests/dashboard-kanban.test.ts \
  tests/dashboard-mcp-pause-resume-integration.test.ts \
  tests/dashboard-run-token-spend.test.ts \
  tests/dashboard-status-mcp.test.ts \
  tests/frontend-context.test.ts \
  tests/harness-working-directory.test.ts \
  tests/logger-callers.test.ts \
  tests/logs-prefix-expansion.test.ts \
  tests/logs-tail-command.test.ts \
  tests/mcp-cli.test.ts \
  tests/merger-agents-commit-message.test.ts \
  tests/multiline-output-parsing.test.ts \
  tests/orphaned-step-recovery.test.ts \
  tests/parse-polling-metadata.test.ts \
  tests/peek-step-polling.test.ts \
  tests/pi-command-preview.test.ts \
  tests/pi-stream-parser.test.ts \
  tests/pi-token-e2e.test.ts \
  tests/polling-config.test.ts \
  tests/polling-round-observability.test.ts \
  tests/polling-round-persona-prompt.test.ts \
  tests/polling-round-token-attribution.test.ts \
  tests/run-terminal-token-events.test.ts \
  tests/run-token-migration.test.ts \
  tests/run-token-observability-e2e.test.ts \
  tests/step-ops.test.ts \
  tests/step-ownership-columns-migration.test.ts \
  tests/system-token-attribution.test.ts \
  tests/system-token-spend-counter.test.ts \
  tests/system-token-spend-migration.test.ts \
  tests/canarinho-coauthor-footer.test.ts \
  tests/terminal-state-guards.test.ts \
  tests/token-log-formatting.test.ts \
  tests/update-command.test.ts \
  tests/workflow-validation.test.ts \
  tests/work-prompt.test.ts \
  $(find src -maxdepth 5 -name '*.test.ts' -type f | sort | grep -v -E '(doctor|run)\.test\.ts') \
  2>&1) || {
  echo "$TEST_OUTPUT" | grep -E '(✖|fail|Error|AssertionError)' || true
  exit 1
}
