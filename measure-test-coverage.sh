#!/bin/bash
# Measure canarinho test code coverage with Node's built-in test runner.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/canarinho-coverage.XXXXXX")"
trap 'rm -rf "$RUNTIME_DIR"' EXIT

export HOME="$RUNTIME_DIR/home"
mkdir -p "$HOME"

export GIT_AUTHOR_NAME="canarinho Coverage"
export GIT_AUTHOR_EMAIL="coverage@canarinho.local"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

COVERAGE_OUTPUT="${canarinho_COVERAGE_OUTPUT:-$RUNTIME_DIR/coverage-output.txt}"

# The tests import compiled files from dist/. Restrict the coverage aggregate to
# those canarinho-owned files so dependency code, pi installs, tests, and other
# repository artifacts do not dilute the reported number.
COVERAGE_ARGS=(
  --experimental-test-coverage
  --test-coverage-include='dist/**/*.js'
  --test-coverage-exclude='**/node_modules/**'
  --test-coverage-exclude='tests/**'
  --test-coverage-exclude='src/**/*.test.ts'
)

TEST_FILES=($(find tests src -maxdepth 5 -name '*.test.ts' -type f | sort))

set +e
node --test --test-timeout=120000 "${COVERAGE_ARGS[@]}" "${TEST_FILES[@]}" > "$COVERAGE_OUTPUT" 2>&1
set -e

LC_ALL=C awk -F'|' '
    /^# all files[[:space:]]+\|/ {
      gsub(/[[:space:]%]/, "", $2)
      gsub(/,/, ".", $2)
      printf "%.6f\n", $2 / 100
      found = 1
    }
    END {
      if (!found) print 0
    }
  ' "$COVERAGE_OUTPUT"
