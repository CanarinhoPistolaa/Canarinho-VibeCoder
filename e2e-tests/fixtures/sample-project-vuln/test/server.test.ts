import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catFile } from "../dist/server.js";
import { writeFileSync, unlinkSync } from "node:fs";

describe("catFile", () => {
  it("reads a legitimate filename correctly", async () => {
    const testFile = "/tmp/test-catfile-safe.txt";
    writeFileSync(testFile, "hello world");
    try {
      const result = await catFile(testFile);
      assert.equal(result.trim(), "hello world");
    } finally {
      unlinkSync(testFile);
    }
  });

  it("demonstrates command injection vulnerability with unsanitized input", async () => {
    // Create a legitimate file so "cat" succeeds on the first command
    const testFile = "/tmp/test-catfile-safe.txt";
    writeFileSync(testFile, "hello world");
    try {
      // The semicolon injects a second command that also writes to stdout.
      // If the shell executes both, the combined output contains both strings.
      const maliciousFilename = testFile + "; echo EXTRA_OUTPUT";
      const result = await catFile(maliciousFilename);
      assert.ok(
        result.includes("hello world"),
        "Should contain the original file contents",
      );
      assert.ok(
        result.includes("EXTRA_OUTPUT"),
        "Should contain injected command output - vulnerability confirmed",
      );
    } finally {
      unlinkSync(testFile);
    }
  });
});
