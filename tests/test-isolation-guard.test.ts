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
      ...collectTestFiles(path.join(process.cwd(), "src")),
    ];

    const forbidden = [
      /\bstopDaemon\(\s*\);/,
      /\bstopMcp\(\s*\);/,
      /\bstopControlPlane\(\s*\);/,
      /fs\.unlinkSync\(\s*(?:PID_FILE|MCP_PID_FILE|MCP_PORT_FILE|CONTROL_PLANE_PID_FILE|CONTROL_PLANE_PORT_FILE)\s*\)/,
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
});
