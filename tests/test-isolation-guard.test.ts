import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("test isolation guard", () => {
  it("does not contain patterns that can touch the live daemon", () => {
    const testFiles = [
      ...collectTestFiles(path.join(process.cwd(), "tests")),
      ...collectTestFiles(path.join(process.cwd(), "e2e-tests")),
      ...collectTestFiles(path.join(process.cwd(), "src")),
    ];

    const forbidden = [
      /\bstopDaemon\(\s*\);/,
      /\bstopMcp\(\s*\);/,
      /\bstopControlPlane\(\s*\);/,
      /fs\.unlinkSync\(\s*(?:PID_FILE|MCP_PID_FILE|MCP_PORT_FILE|CONTROL_PLANE_PID_FILE|CONTROL_PLANE_PORT_FILE)\s*\)/,
      /\.{3}process\.env/,
      /env\s*\?\s*\{\s*\.{3}process\.env/,
      /:\s*process\.env\s*[,}]/,
      /\b(?:canBind|fetch)\(\s*(?:`[^`]*(?:3334|3338|3339)|["'][^"']*(?:3334|3338|3339)|3334|3338|3339)/,
      /\b(?:startDaemon|startMcp|startControlPlane)\(\s*(?:3334|3338|3339|DEFAULT_MCP_PORT|DEFAULT_CONTROL_PORT)/,
    ];

    const violations: string[] = [];
    for (const file of testFiles) {
      const relative = path.relative(process.cwd(), file);
      const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const pattern of forbidden) {
          if (pattern.test(line)) {
            violations.push(`${relative}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    assert.deepEqual(violations, []);
  });

  it("test files that use logger or agent-scheduler must set TAMANDUA_STATE_DIR", () => {
    // Test files that import logger or agent-scheduler functions must isolate
    // their log output using TAMANDUA_STATE_DIR to avoid polluting the live
    // ~/.tamandua/tamandua.log. This regression test guards against that.
    const testFiles = [
      ...collectTestFiles(path.join(process.cwd(), "tests")),
      ...collectTestFiles(path.join(process.cwd(), "e2e-tests")),
      ...collectTestFiles(path.join(process.cwd(), "src")),
    ];

    // Patterns that indicate the test file uses logger functions that write to disk.
    // 1. Direct import from logger.js => logger.info/warn/error/debug/log calls write to disk.
    // 2. Import of runPi or executeDispatchRound from agent-scheduler => these call the logger internally.
    const loggerSensitiveImports = [
      /from\s+["'].*\/lib\/logger\.js["']/,
      /from\s+["'].*\/installer\/agent-scheduler\.js["'].*\brunPi\b/,
      /from\s+["'].*\/installer\/agent-scheduler\.js["'].*\bexecuteDispatchRound\b/,
    ];

    const logsViaTamanduaDir = /TAMANDUA_STATE_DIR/;
    // Acceptable alternatives to TAMANDUA_STATE_DIR: monkey-patching logger so it never writes to disk
    const hasLoggerPatch = /captureLoggerCalls|mutableLogger\.(?:info|warn|error)\s*=/;

    const violations: string[] = [];
    for (const file of testFiles) {
      const relative = path.relative(process.cwd(), file);
      const content = fs.readFileSync(file, "utf-8");

      const importsLogger = loggerSensitiveImports.some((p) => p.test(content));
      if (!importsLogger) continue;

      if (!logsViaTamanduaDir.test(content) && !hasLoggerPatch.test(content)) {
        violations.push(
          `${relative}: imports logger or agent-scheduler without setting TAMANDUA_STATE_DIR or monkey-patching logger`,
        );
      }
    }

    assert.deepEqual(violations, []);
  });
});
