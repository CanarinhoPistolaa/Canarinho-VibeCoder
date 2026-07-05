import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger, readRecentLogs, getLogPath, log, formatEntry } from "../../dist/lib/logger.js";

const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-logger-"));
process.env.TAMANDUA_STATE_DIR = testStateDir;

after(() => {
  if (originalStateDir === undefined) {
    delete process.env.TAMANDUA_STATE_DIR;
  } else {
    process.env.TAMANDUA_STATE_DIR = originalStateDir;
  }
  fs.rmSync(testStateDir, { recursive: true, force: true });
});

describe("logger", () => {
  const logPath = getLogPath();

  it("creates log file on first write", () => {
    assert.doesNotThrow(() => logger.info("test message"));
  });

  it("writes messages to log file", () => {
    logger.info("hello world");
    const content = fs.readFileSync(logPath, "utf-8");
    assert.ok(content.includes("hello world"));
  });

  it("includes timestamp and level", async () => {
    logger.warn("warning test");
    const lines = await readRecentLogs(5);
    const line = lines.find((l: string) => l.includes("warning test"));
    assert.ok(line, "should find the warning line");
    assert.ok(line!.includes("WARN"), "should contain WARN level");
  });

  it("readRecentLogs returns limited lines", async () => {
    for (let i = 0; i < 10; i++) logger.info(`line ${i}`);
    const lines = await readRecentLogs(5);
    assert.ok(lines.length <= 5, "should respect limit");
  });

  it("getLogPath returns the isolated state log path", () => {
    assert.equal(logPath, path.join(testStateDir, "tamandua.log"));
  });

  it("logger.error writes an error-level message", () => {
    logger.error("test error");
    const content = fs.readFileSync(logPath, "utf-8");
    assert.ok(content.includes("ERROR") || content.includes("error"));
  });

  it("logger.debug writes an info-level message", () => {
    logger.debug("debug msg");
    const content = fs.readFileSync(logPath, "utf-8");
    assert.ok(content.includes("debug msg"));
  });

  it("formatEntry formats a log entry with runId", () => {
    const result = formatEntry({
      timestamp: "2024-01-15T10:30:00Z",
      level: "INFO",
      message: "test message",
      runId: "abcdef1234567890",
    });
    assert.ok(result.includes("test message"));
    assert.ok(result.includes("abcdef12"));
    assert.ok(result.includes("INFO"));
  });

  it("formatEntry formats a log entry without runId", () => {
    const result = formatEntry({
      timestamp: "2024-01-15T10:30:00Z",
      level: "WARN",
      message: "no run",
    });
    assert.ok(result.includes("no run"));
    assert.ok(result.includes("WARN"));
  });

  it("log function writes to log file", () => {
    log("info", "standalone log test");
    const content = fs.readFileSync(logPath, "utf-8");
    assert.ok(content.includes("standalone log test"));
  });

  it("rotates log file when it exceeds 5MB", () => {
    // Create a large log file to trigger rotation
    const largeSize = 5 * 1024 * 1024 + 100; // 5MB + 100 bytes
    const fd = fs.openSync(logPath, "w");
    const buf = Buffer.alloc(1, "x");
    // Use write at the offset just beyond MAX_LOG_SIZE to create a sparse file
    fs.writeSync(fd, buf, 0, 1, largeSize - 1);
    fs.closeSync(fd);

    // Now write a new message — this should trigger rotation
    logger.info("after rotation");

    // The original file should have been renamed to .1
    const rotatedPath = logPath + ".1";
    assert.ok(fs.existsSync(rotatedPath), "rotated file should exist");

    // The current log file should contain only the new message
    const currentContent = fs.readFileSync(logPath, "utf-8");
    assert.ok(
      currentContent.includes("after rotation"),
      "current log file should have the new message",
    );
  });

  it("numbered rotation keeps up to 5 archives and shifts them on each rotation", () => {
    // Simulate 7 rotations to verify archives shift correctly and stop at .5
    for (let gen = 0; gen < 7; gen++) {
      // Create a large log file to trigger rotation
      const largeSize = 5 * 1024 * 1024 + 100;
      const fd = fs.openSync(logPath, "w");
      const buf = Buffer.alloc(1, "x");
      fs.writeSync(fd, buf, 0, 1, largeSize - 1);
      fs.closeSync(fd);

      // Write a marker for this generation
      logger.info(`generation-${gen}`);
    }

    // archives .1 through .5 should exist (most recent 5 rotations)
    const archiveFiles = [];
    for (let i = 1; i <= 5; i++) {
      const p = `${logPath}.${i}`;
      assert.ok(fs.existsSync(p), `archive .${i} should exist`);
      archiveFiles.push(p);
    }

    // .6 should NOT exist (only 5 archives kept)
    assert.ok(!fs.existsSync(`${logPath}.6`), "archive .6 should not exist");

    // Clean up archives for subsequent tests
    for (const a of archiveFiles) {
      try { fs.unlinkSync(a); } catch {}
    }
  });

  it("readRecentLogs uses default limit of 50", async () => {
    // When called with no arguments, should default to 50
    const lines = await readRecentLogs();
    assert.ok(Array.isArray(lines), "should return an array");
  });

  it("test-guard: does not fire when TAMANDUA_STATE_DIR isolates into a temp dir (guard active, path isolated)", () => {
    // The test module already sets TAMANDUA_STATE_DIR to a temp dir.
    // Set TAMANDUA_TEST_GUARD=1 to activate the guard — it should NOT throw
    // because the resolved log path is under the temp dir, not real ~/.tamandua.
    const prevGuard = process.env.TAMANDUA_TEST_GUARD;
    process.env.TAMANDUA_TEST_GUARD = "1";
    try {
      assert.doesNotThrow(() => {
        logger.info("isolated log write — guard should not fire");
      }, "guard must not fire when TAMANDUA_STATE_DIR isolates the log path");
    } finally {
      process.env.TAMANDUA_TEST_GUARD = prevGuard;
    }
  });

  it("test-guard: throws TEST ISOLATION VIOLATION when guard is active and path resolves into real state dir", () => {
    // Simulate a test process that forgot to set TAMANDUA_STATE_DIR and
    // os.homedir() returns the real user home → log path is real ~/.tamandua/tamandua.log.
    const prevGuard = process.env.TAMANDUA_TEST_GUARD;
    const prevStateDir = process.env.TAMANDUA_STATE_DIR;
    try {
      process.env.TAMANDUA_TEST_GUARD = "1";
      // Point TAMANDUA_STATE_DIR into the real state dir to trigger the guard.
      // This matches the scenario where HOME is the real home and TAMANDUA_STATE_DIR is unset:
      // getLogDir() → os.homedir()/.tamandua → real ~/.tamandua.
      const realStateRoot = path.join(os.userInfo().homedir, ".tamandua");
      process.env.TAMANDUA_STATE_DIR = path.join(realStateRoot, "leaked-from-test");

      assert.throws(
        () => logger.info("should be blocked by guard"),
        /TEST ISOLATION VIOLATION/,
        "guard must throw when log path resolves into real state dir",
      );
    } finally {
      process.env.TAMANDUA_TEST_GUARD = prevGuard;
      process.env.TAMANDUA_STATE_DIR = prevStateDir;
    }
  });

  it("test-guard: guard checks os.userInfo().homedir, not os.homedir() (HOME-spoof resistance)", () => {
    // Set HOME to a temp dir (spoof) but TAMANDUA_STATE_DIR to the real state dir.
    // The guard must still detect the violation because it uses os.userInfo().homedir.
    const prevGuard = process.env.TAMANDUA_TEST_GUARD;
    const prevStateDir = process.env.TAMANDUA_STATE_DIR;
    const prevHome = process.env.HOME;
    try {
      process.env.TAMANDUA_TEST_GUARD = "1";
      process.env.HOME = path.join(os.tmpdir(), "spoofed-home-" + Date.now());
      const realStateRoot = path.join(os.userInfo().homedir, ".tamandua");
      process.env.TAMANDUA_STATE_DIR = path.join(realStateRoot, "spoofed-leak");

      assert.throws(
        () => logger.info("should be blocked even with spoofed HOME"),
        /TEST ISOLATION VIOLATION/,
        "guard must use os.userInfo().homedir, not os.homedir()",
      );
    } finally {
      process.env.TAMANDUA_TEST_GUARD = prevGuard;
      process.env.TAMANDUA_STATE_DIR = prevStateDir;
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  it("readRecentLogs returns empty array for non-existent log file", async () => {
    // Create a fresh temp dir with no log file yet
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-logger-empty-"));
    try {
      process.env.TAMANDUA_STATE_DIR = emptyDir;
      const lines = await readRecentLogs(10);
      assert.deepEqual(lines, []);
    } finally {
      process.env.TAMANDUA_STATE_DIR = testStateDir;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
