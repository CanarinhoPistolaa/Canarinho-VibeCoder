import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  findHermesBinary,
  findPiBinary,
} from "../../dist/installer/agent-scheduler.js";

// We use mkdtempSync for per-test isolation, since these tests manipulate
// environment variables (canarinho_HERMES_BINARY, PATH).

describe("findHermesBinary", () => {
  let savedHermesBinary: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    // Save env vars we'll manipulate
    savedHermesBinary = process.env.canarinho_HERMES_BINARY;
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    // Restore env vars
    if (savedHermesBinary === undefined) {
      delete process.env.canarinho_HERMES_BINARY;
    } else {
      process.env.canarinho_HERMES_BINARY = savedHermesBinary;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
  });

  it("respects canarinho_HERMES_BINARY env var when set and executable", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-hermes-")
    );
    const hermesPath = path.join(tmpDir, "hermes-custom");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

    process.env.canarinho_HERMES_BINARY = hermesPath;

    const result = await findHermesBinary();
    assert.equal(result, hermesPath);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when canarinho_HERMES_BINARY is set but not executable", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-hermes-")
    );
    const hermesPath = path.join(tmpDir, "hermes-broken");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hi\n", { mode: 0o644 });

    process.env.canarinho_HERMES_BINARY = hermesPath;

    assert.throws(
      () => findHermesBinary(),
      /canarinho_HERMES_BINARY set but not executable/
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("searches PATH for hermes executable", async () => {
    delete process.env.canarinho_HERMES_BINARY;

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-hermes-")
    );
    const hermesPath = path.join(tmpDir, "hermes");
    fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

    process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

    const result = await findHermesBinary();
    assert.equal(result, hermesPath);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws clear error when hermes not found in PATH and no env var set", async () => {
    delete process.env.canarinho_HERMES_BINARY;

    // Set PATH to an empty temp dir so there's no hermes anywhere
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-hermes-")
    );
    process.env.PATH = tmpDir;

    assert.throws(
      () => findHermesBinary(),
      /hermes binary not found in PATH/
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns cached env var path without searching PATH", async () => {
    // Set canarinho_HERMES_BINARY to a valid executable AND have PATH
    // contain a different hermes. The env var should win.
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-hermes-env-")
    );
    const envHermesPath = path.join(tmpDir, "hermes-env");
    fs.writeFileSync(envHermesPath, "#!/bin/sh\necho env-hermes\n", {
      mode: 0o755,
    });

    const tmpDir2 = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-hermes-path-")
    );
    const pathHermesPath = path.join(tmpDir2, "hermes");
    fs.writeFileSync(pathHermesPath, "#!/bin/sh\necho path-hermes\n", {
      mode: 0o755,
    });

    process.env.canarinho_HERMES_BINARY = envHermesPath;
    process.env.PATH = `${tmpDir2}:${savedPath ?? ""}`;

    const result = await findHermesBinary();
    assert.equal(result, envHermesPath);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("findPiBinary", () => {
  let savedPiBinary: string | undefined;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedPiBinary = process.env.canarinho_PI_BINARY;
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPiBinary === undefined) {
      delete process.env.canarinho_PI_BINARY;
    } else {
      process.env.canarinho_PI_BINARY = savedPiBinary;
    }
    if (savedPath !== undefined) {
      process.env.PATH = savedPath;
    }
  });

  it("respects canarinho_PI_BINARY env var when set and executable", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-pi-")
    );
    const piPath = path.join(tmpDir, "pi");
    fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });

    process.env.canarinho_PI_BINARY = piPath;

    const result = await findPiBinary();
    assert.equal(result, piPath);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when canarinho_PI_BINARY is set but not executable", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-pi-")
    );
    const piPath = path.join(tmpDir, "pi-broken");
    fs.writeFileSync(piPath, "#!/bin/sh\necho nope\n", { mode: 0o644 });

    process.env.canarinho_PI_BINARY = piPath;

    await assert.rejects(
      () => findPiBinary(),
      /canarinho_PI_BINARY set but not executable/
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws clear error when pi not found in PATH and no env var set", async () => {
    delete process.env.canarinho_PI_BINARY;

    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "canarinho-test-pi-")
    );
    process.env.PATH = tmpDir;

    await assert.rejects(
      () => findPiBinary(),
      /pi binary not found in PATH/
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
