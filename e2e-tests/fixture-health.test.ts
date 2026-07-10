/**
 * Fixture Health — Deterministic Compilation Checks
 *
 * Tests all three e2e fixtures deterministically: no agents, no models,
 * no tokens. For each fixture, copies it to a temp dir, runs
 * `npm install --no-audit --no-fund --no-package-lock` followed by
 * `npm exec --yes --package typescript -- tsc`, and asserts the result.
 *
 * Guards:
 * - sample-project-review and sample-project-vuln MUST compile clean (exit 0).
 * - sample-project MUST compile clean AND still contain the planted-bug markers
 *   ("a - b" in src/math.ts, test named "returns the difference").
 *
 * Temp dirs are cleaned up in finally blocks.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const fixturesDir = path.join(process.cwd(), "e2e-tests", "fixtures");

/**
 * Copy a fixture to a temp dir and run the install+tsc sequence.
 * Returns { exitCode, stderr, tempDir }.
 */
function buildFixture(fixtureName: string): {
  exitCode: number;
  stderr: string;
  tempDir: string;
} {
  const src = path.join(fixturesDir, fixtureName);
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `canarinho-fix-health-${fixtureName}-`),
  );

  // Copy fixture to temp dir
  const cpResult = spawnSync("cp", ["-r", `${src}/.`, `${tempDir}/`], {
    encoding: "utf-8",
  });
  assert.equal(cpResult.status, 0, `cp ${fixtureName} failed: ${cpResult.stderr}`);

  // Install deps then compile (matching buildSampleProject sequence)
  const cmd =
    "npm install --no-audit --no-fund --no-package-lock && npm exec --yes --package typescript -- tsc";
  const result = spawnSync(cmd, {
    cwd: tempDir,
    shell: true,
    encoding: "utf-8",
  });

  return { exitCode: result.status ?? -1, stderr: result.stderr, tempDir };
}

describe("fixture-health — sample-project-review", () => {
  it("compiles clean (tsc exit 0)", () => {
    const { exitCode, stderr, tempDir } = buildFixture("sample-project-review");
    try {
      assert.equal(
        exitCode,
        0,
        `sample-project-review tsc failed (exit ${exitCode}): ${stderr}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("fixture-health — sample-project-vuln", () => {
  it("compiles clean (tsc exit 0)", () => {
    const { exitCode, stderr, tempDir } = buildFixture("sample-project-vuln");
    try {
      assert.equal(
        exitCode,
        0,
        `sample-project-vuln tsc failed (exit ${exitCode}): ${stderr}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("fixture-health — sample-project", () => {
  it("compiles clean (tsc exit 0)", () => {
    const { exitCode, stderr, tempDir } = buildFixture("sample-project");
    try {
      assert.equal(
        exitCode,
        0,
        `sample-project tsc failed (exit ${exitCode}): ${stderr}`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('still contains planted bug "a - b" in src/math.ts', () => {
    const mathPath = path.join(fixturesDir, "sample-project", "src", "math.ts");
    assert.ok(fs.existsSync(mathPath), `src/math.ts not found at ${mathPath}`);
    const content = fs.readFileSync(mathPath, "utf-8");
    assert.ok(
      content.includes("a - b"),
      "Planted bug marker 'a - b' missing from sample-project/src/math.ts — " +
        "the fixture may have been inadvertently fixed.",
    );
  });

  it('still contains test named "returns the difference" in test/math.test.ts', () => {
    const testPath = path.join(
      fixturesDir,
      "sample-project",
      "test",
      "math.test.ts",
    );
    assert.ok(
      fs.existsSync(testPath),
      `test/math.test.ts not found at ${testPath}`,
    );
    const content = fs.readFileSync(testPath, "utf-8");
    assert.ok(
      content.includes('returns the difference'),
      "Test 'returns the difference' missing from sample-project/test/math.test.ts — " +
        "the fixture may have been inadvertently fixed.",
    );
  });
});
