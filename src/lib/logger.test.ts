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

  it("readRecentLogs uses default limit of 50", async () => {
    // When called with no arguments, should default to 50
    const lines = await readRecentLogs();
    assert.ok(Array.isArray(lines), "should return an array");
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
