import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getHarnessAdapter,
  type HarnessAdapter,
  type HarnessRoundResult,
  type RunHarnessOptions,
} from "../../dist/installer/harness-adapter.js";

// ── HarnessAdapter interface contract ──────────────────────────────

describe("HarnessAdapter interface", () => {
  it("exports HarnessAdapter type", () => {
    // Type-only — existence verified at compile time.
    // Rely on getHarnessAdapter returning objects that satisfy the interface.
  });

  it("exports HarnessRoundResult type", () => {
    const r: HarnessRoundResult = { output: "test" };
    assert.equal(r.output, "test");
    assert.equal(r.sessionRef, undefined);
    const rWithSession: HarnessRoundResult = {
      output: "test",
      sessionRef: "sess-123",
    };
    assert.equal(rWithSession.sessionRef, "sess-123");
  });

  it("exports RunHarnessOptions type", () => {
    const opts: RunHarnessOptions = {
      timeout: 120,
      workdir: "/tmp",
      env: { FOO: "bar" },
      onSpawn: () => {},
      preferTokenSaver: true,
    };
    assert.equal(opts.timeout, 120);
    assert.equal(opts.workdir, "/tmp");
    assert.deepEqual(opts.env, { FOO: "bar" });
    assert.equal(opts.preferTokenSaver, true);
  });
});

// ── getHarnessAdapter factory ──────────────────────────────────────

describe("getHarnessAdapter", () => {
  it('returns a PiHarnessAdapter for "pi"', () => {
    const adapter = getHarnessAdapter("pi");
    assert.equal(adapter.type, "pi");
  });

  it('returns a HermesHarnessAdapter for "hermes"', () => {
    const adapter = getHarnessAdapter("hermes");
    assert.equal(adapter.type, "hermes");
  });

  it("throws for unknown harness type", () => {
    assert.throws(
      () => getHarnessAdapter("unknown"),
      /unknown harness type/,
    );
  });

  it("throws for empty string", () => {
    assert.throws(
      () => getHarnessAdapter(""),
      /unknown harness type/,
    );
  });

  it("throws for arbitrary unrecognized value", () => {
    assert.throws(
      () => getHarnessAdapter("foo-bar"),
      /unknown harness type/,
    );
  });
});

// ── PiHarnessAdapter implementation ────────────────────────────────

describe("PiHarnessAdapter implementation", () => {
  const adapter = getHarnessAdapter("pi");

  it("has type 'pi'", () => {
    assert.equal(adapter.type, "pi");
  });

  describe("findBinary", () => {
    let savedPiBinary: string | undefined;
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPiBinary = process.env.TAMANDUA_PI_BINARY;
      savedPath = process.env.PATH;
    });

    afterEach(() => {
      if (savedPiBinary === undefined) {
        delete process.env.TAMANDUA_PI_BINARY;
      } else {
        process.env.TAMANDUA_PI_BINARY = savedPiBinary;
      }
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
    });

    it("respects TAMANDUA_PI_BINARY env var when set and executable", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-pi-")
      );
      const piPath = path.join(tmpDir, "pi");
      fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });

      process.env.TAMANDUA_PI_BINARY = piPath;

      const result = await adapter.findBinary();
      assert.equal(result, piPath);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("throws when TAMANDUA_PI_BINARY is set but not executable", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-pi-")
      );
      const piPath = path.join(tmpDir, "pi-broken");
      fs.writeFileSync(piPath, "#!/bin/sh\necho nope\n", { mode: 0o644 });

      process.env.TAMANDUA_PI_BINARY = piPath;

      await assert.rejects(
        () => adapter.findBinary(),
        /TAMANDUA_PI_BINARY set but not executable/
      );

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("throws clear error when pi not found in PATH and no env var set", async () => {
      delete process.env.TAMANDUA_PI_BINARY;

      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-pi-")
      );
      process.env.PATH = tmpDir;

      await assert.rejects(
        () => adapter.findBinary(),
        /pi binary not found in PATH/
      );

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("prefers pi-token-saver over pi when preferTokenSaver is true and both exist", async () => {
      delete process.env.TAMANDUA_PI_BINARY;

      const binDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-ts-")
      );
      const piPath = path.join(binDir, "pi");
      const saverPath = path.join(binDir, "pi-token-saver");
      fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });
      fs.writeFileSync(saverPath, "#!/bin/sh\necho saver\n", { mode: 0o755 });

      process.env.PATH = binDir;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), saverPath);
      assert.equal(await adapter.findBinary({ preferTokenSaver: false }), piPath);
      assert.equal(await adapter.findBinary(), piPath);

      fs.rmSync(binDir, { recursive: true, force: true });
    });

    it("falls back to pi when pi-token-saver is not installed", async () => {
      delete process.env.TAMANDUA_PI_BINARY;

      const binDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-ts-")
      );
      const piPath = path.join(binDir, "pi");
      fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });

      process.env.PATH = binDir;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), piPath);

      fs.rmSync(binDir, { recursive: true, force: true });
    });

    it("TAMANDUA_PI_BINARY overrides pi-token-saver preference", async () => {
      const binDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-ts-")
      );
      const piPath = path.join(binDir, "pi");
      const saverPath = path.join(binDir, "pi-token-saver");
      const pinnedPath = path.join(binDir, "pinned-pi");
      fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });
      fs.writeFileSync(saverPath, "#!/bin/sh\necho saver\n", { mode: 0o755 });
      fs.writeFileSync(pinnedPath, "#!/bin/sh\necho pinned\n", { mode: 0o755 });

      process.env.PATH = binDir;
      process.env.TAMANDUA_PI_BINARY = pinnedPath;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), pinnedPath);

      fs.rmSync(binDir, { recursive: true, force: true });
    });
  });

  describe("runRound", () => {
    it("spawns pi with correct argv and returns HarnessRoundResult", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-runround-")
      );
      const fakePi = path.join(tmpDir, "pi");
      fs.writeFileSync(
        fakePi,
        "#!/usr/bin/env node\nprocess.stdout.write('hello-from-adapter');\n",
        "utf-8"
      );
      fs.chmodSync(fakePi, 0o755);

      const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;

      try {
        const result = await adapter.runRound("test prompt", {
          timeout: 3,
          workdir: tmpDir,
        });

        assert.equal(result.output, "hello-from-adapter");
        assert.equal(result.sessionRef, undefined);
      } finally {
        if (originalPiBinary === undefined) {
          delete process.env.TAMANDUA_PI_BINARY;
        } else {
          process.env.TAMANDUA_PI_BINARY = originalPiBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects on non-zero exit code", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-runround-")
      );
      const fakePi = path.join(tmpDir, "pi");
      fs.writeFileSync(
        fakePi,
        "#!/usr/bin/env node\nprocess.exit(7);\n",
        "utf-8"
      );
      fs.chmodSync(fakePi, 0o755);

      const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;

      try {
        await assert.rejects(
          () => adapter.runRound("prompt", { timeout: 3, workdir: tmpDir }),
          /pi failed: exited with code 7/
        );
      } finally {
        if (originalPiBinary === undefined) {
          delete process.env.TAMANDUA_PI_BINARY;
        } else {
          process.env.TAMANDUA_PI_BINARY = originalPiBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe("HermesHarnessAdapter implementation", () => {
  const adapter = getHarnessAdapter("hermes");

  it("has type 'hermes'", () => {
    assert.equal(adapter.type, "hermes");
  });

  describe("findBinary", () => {
    let savedHermesBinary: string | undefined;
    let savedPath: string | undefined;

    beforeEach(() => {
      savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      savedPath = process.env.PATH;
    });

    afterEach(() => {
      if (savedHermesBinary === undefined) {
        delete process.env.TAMANDUA_HERMES_BINARY;
      } else {
        process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
      }
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
    });

    it("respects TAMANDUA_HERMES_BINARY env var when set and executable", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes-custom");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      const result = await adapter.findBinary();
      assert.equal(result, hermesPath);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("throws when TAMANDUA_HERMES_BINARY is set but not executable", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes-broken");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hi\n", { mode: 0o644 });

      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      await assert.rejects(
        () => adapter.findBinary(),
        /TAMANDUA_HERMES_BINARY set but not executable/,
      );

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("searches PATH for hermes executable", async () => {
      delete process.env.TAMANDUA_HERMES_BINARY;

      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

      const result = await adapter.findBinary();
      assert.equal(result, hermesPath);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("throws clear error when hermes not found in PATH and no env var set", async () => {
      delete process.env.TAMANDUA_HERMES_BINARY;

      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      process.env.PATH = tmpDir;

      await assert.rejects(
        () => adapter.findBinary(),
        /hermes binary not found in PATH/,
      );

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("env var wins over PATH hermes", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const envHermesPath = path.join(tmpDir, "hermes-env");
      fs.writeFileSync(envHermesPath, "#!/bin/sh\necho env-hermes\n", {
        mode: 0o755,
      });

      const tmpDir2 = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const pathHermesPath = path.join(tmpDir2, "hermes");
      fs.writeFileSync(pathHermesPath, "#!/bin/sh\necho path-hermes\n", {
        mode: 0o755,
      });

      process.env.TAMANDUA_HERMES_BINARY = envHermesPath;
      process.env.PATH = `${tmpDir2}:${savedPath ?? ""}`;

      const result = await adapter.findBinary();
      assert.equal(result, envHermesPath);

      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    });
  });

  describe("runRound", () => {
    it("returns stdout with session_id lines filtered out", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "Hello from hermes"
echo "Work completed successfully"
echo "session_id: 20260518_103004_cdae11"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });

        assert.ok(!result.output.includes("session_id:"));
        assert.ok(result.output.includes("Hello from hermes"));
        assert.ok(result.output.includes("Work completed successfully"));
        assert.equal(result.sessionRef, "20260518_103004_cdae11");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("filters all session_id lines", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "session_id: early"
echo "useful output here"
echo "session_id: late"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });

        assert.ok(!result.output.includes("session_id:"));
        assert.ok(result.output.includes("useful output here"));
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns empty string when output is only session_id", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "session_id: 20260518_103004_cdae11"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });
        assert.equal(result.output, "");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects on timeout with clear error message", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
sleep 10`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        await assert.rejects(
          () => adapter.runRound("do something", { timeout: 2 }),
          (err: Error) => {
            return (
              err.message.includes("hermes timed out") &&
              err.message.includes("2000ms")
            );
          },
        );
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("rejects when hermes exits with non-zero code", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "error output" >&2
exit 1`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        await assert.rejects(
          () => adapter.runRound("bad task", { timeout: 5 }),
          (err: Error) => {
            return (
              err.message.includes("hermes failed") &&
              err.message.includes("exited with code 1")
            );
          },
        );
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("stderr data does not appear in returned stdout", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "useful stdout" 1>&1
echo "debug stderr" 1>&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("task", { timeout: 5 });
        assert.equal(result.output, "useful stdout");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("preserves multi-line output with mixed content", async () => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "tamandua-test-harness-adapter-hermes-")
      );
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "STATUS: done"
echo ""
echo "CHANGES: implemented feature X"
echo "TESTS: all passing"
echo "session_id: 20260518_103004_cdae11"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do the work", { timeout: 5 });

        assert.ok(result.output.includes("STATUS: done"));
        assert.ok(result.output.includes("CHANGES: implemented feature X"));
        assert.ok(result.output.includes("TESTS: all passing"));
        assert.ok(!result.output.includes("session_id:"));
        const lines = result.output.split("\n");
        assert.ok(lines.length >= 3);
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

// ── Type-level checks that the implement types work ────────────────

describe("HarnessRoundResult shape", () => {
  it("output is required, sessionRef is optional", () => {
    const minimal: HarnessRoundResult = { output: "hello" };
    assert.equal(minimal.output, "hello");
    assert.equal(minimal.sessionRef, undefined);

    const full: HarnessRoundResult = {
      output: "hello",
      sessionRef: "sess-abc",
    };
    assert.equal(full.output, "hello");
    assert.equal(full.sessionRef, "sess-abc");
  });
});
