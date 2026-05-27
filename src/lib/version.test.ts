import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getBuildVersion } from "../../dist/lib/version.js";

const distVersionPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "dist",
  "version",
);

// Save and restore dist/version across tests
let savedVersionContent: string | null = null;
let versionFileExisted = false;
try {
  savedVersionContent = fs.readFileSync(distVersionPath, "utf-8");
  versionFileExisted = true;
} catch {
  versionFileExisted = false;
}

function cleanupVersionFile() {
  try {
    if (versionFileExisted) {
      fs.writeFileSync(distVersionPath, savedVersionContent!, "utf-8");
    } else {
      fs.unlinkSync(distVersionPath);
    }
  } catch {
    // best effort
  }
}

describe("getBuildVersion", () => {
  it("returns content of dist/version when file exists", () => {
    const expectedVersion = "20260526T140530Z_4ad4844ff86d37cd04eaf736e8cc43ad467b0338";
    try {
      fs.writeFileSync(distVersionPath, expectedVersion + "\n", "utf-8");
      const result = getBuildVersion();
      assert.equal(result, expectedVersion);
    } finally {
      cleanupVersionFile();
    }
  });

  it("returns 'unknown' when dist/version does not exist", () => {
    // Ensure the file does not exist
    try { fs.unlinkSync(distVersionPath); } catch {}
    try {
      const result = getBuildVersion();
      assert.equal(result, "unknown");
    } finally {
      cleanupVersionFile();
    }
  });

  it("returns 'unknown' when dist/version is empty", () => {
    try {
      fs.writeFileSync(distVersionPath, "", "utf-8");
      const result = getBuildVersion();
      assert.equal(result, "unknown");
    } finally {
      cleanupVersionFile();
    }
  });

  it("returns 'unknown' when dist/version is whitespace only", () => {
    try {
      fs.writeFileSync(distVersionPath, "   \n  \t  ", "utf-8");
      const result = getBuildVersion();
      assert.equal(result, "unknown");
    } finally {
      cleanupVersionFile();
    }
  });

  it("returns trimmed content without trailing newline", () => {
    const version = "20260526T140530Z_abcdef";
    try {
      fs.writeFileSync(distVersionPath, version + "\n\n", "utf-8");
      const result = getBuildVersion();
      assert.equal(result, version);
    } finally {
      cleanupVersionFile();
    }
  });
});
