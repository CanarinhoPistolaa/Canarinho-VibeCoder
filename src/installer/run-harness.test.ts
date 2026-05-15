import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { validateRunHarnessForScheduling } from "../../dist/installer/run-harness.js";

describe("validateRunHarnessForScheduling", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-harness-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws when context is missing working_directory_for_harness", () => {
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", JSON.stringify({})),
      /missing working_directory_for_harness/,
    );
  });

  it("throws when context is not valid JSON", () => {
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", "not json"),
      /run context is not valid JSON/,
    );
  });

  it("throws when working_directory_for_harness is a relative path", () => {
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: "relative/path",
      })),
      /relative harness workdir/,
    );
  });

  it("throws when harness workdir does not exist", () => {
    const nonexistent = path.join(tempDir, "nonexistent");
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: nonexistent,
      })),
      /harness workdir does not exist/,
    );
  });

  it("throws when harness workdir is a file, not a directory", () => {
    const filePath = path.join(tempDir, "file.txt");
    fs.writeFileSync(filePath, "content", "utf-8");
    assert.throws(
      () => validateRunHarnessForScheduling("run-1", JSON.stringify({
        working_directory_for_harness: filePath,
      })),
      /not a directory/,
    );
  });

  it("returns result for valid absolute working_directory_for_harness", () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const result = validateRunHarnessForScheduling("run-1", JSON.stringify({
      working_directory_for_harness: workdir,
    }));
    assert.equal(result.workingDirectoryForHarness, workdir);
    assert.equal(result.expectedBranch, undefined);
  });

  it("resolves symlinks and relative segments", () => {
    const workdir = path.join(tempDir, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const withDots = path.join(tempDir, ".", "work");
    const result = validateRunHarnessForScheduling("run-1", JSON.stringify({
      working_directory_for_harness: withDots,
    }));
    assert.equal(result.workingDirectoryForHarness, workdir);
  });
});
