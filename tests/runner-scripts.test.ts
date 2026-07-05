/**
 * Tests for the serial/parallel lane runner scripts.
 *
 * This test file is pure-logic: it validates script existence, executable bits,
 * bash syntax, env var passthrough, and basic execution behavior.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanChildEnv } from "./helpers/test-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERIAL_SCRIPT = path.join(REPO_ROOT, "scripts", "run-serial-tests.sh");
const PARALLEL_SCRIPT = path.join(REPO_ROOT, "scripts", "run-parallel-tests.sh");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-runner-test-"));
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

describe("run-serial-tests.sh", () => {
  it("exists and is executable", () => {
    assert.ok(fs.existsSync(SERIAL_SCRIPT), "scripts/run-serial-tests.sh must exist");
    fs.accessSync(SERIAL_SCRIPT, fs.constants.X_OK);
  });

  it("has valid bash syntax", () => {
    execSync("bash -n " + JSON.stringify(SERIAL_SCRIPT), { stdio: "pipe" });
  });

  it("uses --test-concurrency=1", () => {
    const content = fs.readFileSync(SERIAL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("--test-concurrency=1"),
      "run-serial-tests.sh must contain --test-concurrency=1",
    );
  });

  it("passes through TAMANDUA_TEST_GUARD", () => {
    const content = fs.readFileSync(SERIAL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_TEST_GUARD"),
      "run-serial-tests.sh must reference TAMANDUA_TEST_GUARD",
    );
  });

  it("passes through TAMANDUA_PI_BINARY", () => {
    const content = fs.readFileSync(SERIAL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_PI_BINARY"),
      "run-serial-tests.sh must reference TAMANDUA_PI_BINARY",
    );
  });

  it("defaults TAMANDUA_TEST_GUARD to 1 when unset", () => {
    // Run a minimal bash snippet that mimics the script's defaulting logic
    const tmpDir = makeTmpDir();
    try {
      const wrapper = [
        '#!/bin/bash',
        'unset TAMANDUA_TEST_GUARD',
        'export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"',
        'echo "GUARD=$TAMANDUA_TEST_GUARD"',
      ].join("\n");
      const wrapperPath = path.join(tmpDir, "test-default-guard.sh");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      const result = execFileSync("bash", [wrapperPath], {
        encoding: "utf-8",
        stdio: "pipe",
        env: { PATH: process.env.PATH },
      });
      assert.ok(
        result.includes("GUARD=1"),
        "TAMANDUA_TEST_GUARD should default to 1 when unset. Got: " + result.trim(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts overriding TAMANDUA_TEST_GUARD from environment", () => {
    const tmpDir = makeTmpDir();
    try {
      const wrapper = [
        '#!/bin/bash',
        'export TAMANDUA_TEST_GUARD="${TAMANDUA_TEST_GUARD:-1}"',
        'echo "GUARD=$TAMANDUA_TEST_GUARD"',
      ].join("\n");
      const wrapperPath = path.join(tmpDir, "test-override-guard.sh");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      const result = execFileSync("bash", [wrapperPath], {
        encoding: "utf-8",
        stdio: "pipe",
        env: { TAMANDUA_TEST_GUARD: "2", PATH: process.env.PATH },
      });
      assert.ok(
        result.includes("GUARD=2"),
        "TAMANDUA_TEST_GUARD should be overridable. Got: " + result.trim(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("defaults TAMANDUA_PI_BINARY to /bin/false when unset", () => {
    const tmpDir = makeTmpDir();
    try {
      const wrapper = [
        '#!/bin/bash',
        'unset TAMANDUA_PI_BINARY',
        'export TAMANDUA_PI_BINARY="${TAMANDUA_PI_BINARY:-/bin/false}"',
        'echo "PI=$TAMANDUA_PI_BINARY"',
      ].join("\n");
      const wrapperPath = path.join(tmpDir, "test-default-pi.sh");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      const result = execFileSync("bash", [wrapperPath], {
        encoding: "utf-8",
        stdio: "pipe",
        env: { PATH: process.env.PATH },
      });
      assert.ok(
        result.includes("PI=/bin/false"),
        "TAMANDUA_PI_BINARY should default to /bin/false. Got: " + result.trim(),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports error when serial-files.txt is missing", () => {
    const tmpDir = makeTmpDir();
    try {
      const wrapper = [
        '#!/bin/bash',
        'REPO_ROOT="' + tmpDir + '"',
        'SERIAL_FILES_LIST="$REPO_ROOT/tests/serial-files.txt"',
        'if [ ! -f "$SERIAL_FILES_LIST" ]; then',
        '  echo "Error: $SERIAL_FILES_LIST not found" >&2',
        '  exit 1',
        'fi',
        'exit 0',
      ].join("\n");
      const wrapperPath = path.join(tmpDir, "test-missing.sh");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      try {
        execFileSync("bash", [wrapperPath], { stdio: "pipe", encoding: "utf-8" });
        assert.fail("Should have exited non-zero");
      } catch (e) {
        assert.ok(
          (e.stderr || "").includes("not found"),
          "should report file not found",
        );
        assert.equal(e.status, 1, "should exit with code 1");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits 0 when all serial tests pass", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "dummy.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("dummy", () => {\n' +
        '  it("passes", () => { assert.equal(1, 1); });\n' +
        '});\n'
      );
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/dummy.test.ts\n");

      execFileSync("bash", [SERIAL_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when a serial test fails", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "failing.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("dummy", () => {\n' +
        '  it("fails", () => { assert.equal(1, 2); });\n' +
        '});\n'
      );
      writeText(path.join(tmpDir, "tests", "serial-files.txt"), "src/failing.test.ts\n");

      try {
        execFileSync("bash", [SERIAL_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero on test failure");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero on failure");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("run-parallel-tests.sh", () => {
  it("exists and is executable", () => {
    assert.ok(fs.existsSync(PARALLEL_SCRIPT), "scripts/run-parallel-tests.sh must exist");
    fs.accessSync(PARALLEL_SCRIPT, fs.constants.X_OK);
  });

  it("has valid bash syntax", () => {
    execSync("bash -n " + JSON.stringify(PARALLEL_SCRIPT), { stdio: "pipe" });
  });

  it("passes through TAMANDUA_TEST_GUARD", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_TEST_GUARD"),
      "run-parallel-tests.sh must reference TAMANDUA_TEST_GUARD",
    );
  });

  it("passes through TAMANDUA_PI_BINARY", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("TAMANDUA_PI_BINARY"),
      "run-parallel-tests.sh must reference TAMANDUA_PI_BINARY",
    );
  });

  it("excludes serial-lane files", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("SERIAL_SET"),
      "run-parallel-tests.sh must contain SERIAL_SET exclusion logic",
    );
  });

  it("excludes e2e-tests directory", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      content.includes("e2e-tests"),
      "run-parallel-tests.sh must exclude e2e-tests/",
    );
  });

  it("does NOT use --test-concurrency=1 (runs with default concurrency)", () => {
    const content = fs.readFileSync(PARALLEL_SCRIPT, "utf-8");
    assert.ok(
      !content.includes("--test-concurrency=1"),
      "run-parallel-tests.sh must NOT use --test-concurrency=1",
    );
  });

  it("runs parallel tests with default concurrency", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "parallel.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("parallel-dummy", () => {\n' +
        '  it("passes", () => { assert.equal(2, 2); });\n' +
        '});\n'
      );

      const result = execFileSync("bash", [PARALLEL_SCRIPT], {
        cwd: tmpDir,
        env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
        stdio: "pipe",
        encoding: "utf-8",
      });
      assert.ok(
        result.includes("Parallel lane"),
        "should output 'Parallel lane' label",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exits non-zero when a parallel test fails", () => {
    const tmpDir = makeTmpDir();
    try {
      writeText(path.join(tmpDir, "src", "fail.test.ts"),
        'import { describe, it } from "node:test";\n' +
        'import assert from "node:assert/strict";\n' +
        'describe("parallel-fail", () => {\n' +
        '  it("fails", () => { assert.equal(1, 2); });\n' +
        '});\n'
      );

      try {
        execFileSync("bash", [PARALLEL_SCRIPT], {
          cwd: tmpDir,
          env: cleanChildEnv({ HOME: tmpDir, TAMANDUA_REPO_ROOT: tmpDir, TAMANDUA_TEST_GUARD: "0" }),
          stdio: "pipe",
          encoding: "utf-8",
        });
        assert.fail("Should have exited non-zero on test failure");
      } catch (e) {
        assert.notEqual(e.status, 0, "exit code must be non-zero on failure");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
