import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { printcanarinho } from "../../dist/cli/ant.js";

describe("printcanarinho", () => {
  let output: string;
  const originalWrite = process.stdout.write;

  beforeEach(() => {
    output = "";
    process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("prints ASCII art containing canarinho-like shapes", () => {
    printcanarinho();
    assert.ok(output.length > 100, "art should be substantial");
    assert.ok(output.includes("O"), "should have eyes");
    assert.ok(output.includes("V"), "should have nose");
    assert.ok(/[\\\\/]/.test(output), "should have ASCII art shapes");
  });

  it("prints a quote after the art", () => {
    printcanarinho();
    const lines = output.trim().split("\n");
    const lastLine = lines[lines.length - 1];
    assert.ok(lastLine.length > 10, "last line should be a quote");
  });

  it("picks from at least 8 different quotes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      output = "";
      printcanarinho();
      const lines = output.trim().split("\n");
      seen.add(lines[lines.length - 1]);
    }
    assert.ok(seen.size >= 8, `expected at least 8 unique quotes, got ${seen.size}`);
  });

  it("does not throw", () => {
    assert.doesNotThrow(() => printcanarinho());
  });
});
