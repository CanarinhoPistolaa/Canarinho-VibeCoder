/**
 * The test-isolation guard itself: under canarinho_TEST_GUARD=1, binding a
 * production port or opening state under the REAL ~/.canarinho throws
 * loudly. canarinho develops canarinho — without this, under-isolated tests
 * leak daemons onto production ports and pollute live state (both have
 * happened; see tests/MOTOR-CONTRACT.md quirks).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  assertPortIsolation,
  assertStatePathIsolation,
  testGuardActive,
} from "../dist/lib/test-guard.js";

let savedGuard: string | undefined;
let savedNodeTestContext: string | undefined;

beforeEach(() => {
  savedGuard = process.env.canarinho_TEST_GUARD;
  savedNodeTestContext = process.env.NODE_TEST_CONTEXT;
});

afterEach(() => {
  if (savedGuard === undefined) delete process.env.canarinho_TEST_GUARD;
  else process.env.canarinho_TEST_GUARD = savedGuard;
  if (savedNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
});

describe("test-isolation guard", () => {
  it("blocks production ports (3334/3338/3339) when active", () => {
    process.env.canarinho_TEST_GUARD = "1";
    for (const port of [3334, 3338, 3339]) {
      assert.throws(
        () => assertPortIsolation(port, "unit test"),
        /TEST ISOLATION VIOLATION.*production port/s,
        `port ${port} must be blocked`,
      );
    }
  });

  it("allows random ports when active", () => {
    process.env.canarinho_TEST_GUARD = "1";
    assert.doesNotThrow(() => assertPortIsolation(39181, "unit test"));
    assert.doesNotThrow(() => assertPortIsolation(1, "unit test"));
  });

  it("blocks the real ~/.canarinho state dir when active — even if HOME is spoofed", () => {
    process.env.canarinho_TEST_GUARD = "1";
    // The guard uses the OS account database, not the HOME env var, so a
    // test that forgot isolation cannot dodge it by accident.
    const realHome = os.userInfo().homedir;
    assert.throws(
      () => assertStatePathIsolation(path.join(realHome, ".canarinho", "canarinho.db"), "unit test"),
      /TEST ISOLATION VIOLATION.*real canarinho state/s,
    );
    assert.throws(
      () => assertStatePathIsolation(path.join(realHome, ".canarinho"), "unit test"),
      /TEST ISOLATION VIOLATION/,
    );
  });

  it("allows temp-dir state when active", () => {
    process.env.canarinho_TEST_GUARD = "1";
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(os.tmpdir(), "canarinho-x", ".canarinho", "canarinho.db"), "unit test"),
    );
  });

  it("is completely inert when canarinho_TEST_GUARD=0 even with NODE_TEST_CONTEXT (explicit escape hatch)", () => {
    process.env.canarinho_TEST_GUARD = "0";
    // NODE_TEST_CONTEXT is set by the test runner — keep it present to
    // prove the escape hatch overrides auto-activation.
    assert.equal(testGuardActive(), false);
    assert.doesNotThrow(() => assertPortIsolation(3334, "prod"));
    const realHome = os.userInfo().homedir;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(realHome, ".canarinho", "canarinho.db"), "prod"),
    );
  });

  it("auto-activates when only NODE_TEST_CONTEXT is set (no canarinho_TEST_GUARD)", () => {
    delete process.env.canarinho_TEST_GUARD;
    process.env.NODE_TEST_CONTEXT = "child-v8";
    assert.equal(testGuardActive(), true);
    assert.throws(
      () => assertPortIsolation(3334, "auto-activated test"),
      /TEST ISOLATION VIOLATION/,
    );
  });

  it("canarinho_TEST_GUARD=0 overrides NODE_TEST_CONTEXT (escape hatch disables the guard)", () => {
    process.env.canarinho_TEST_GUARD = "0";
    process.env.NODE_TEST_CONTEXT = "child-v8";
    assert.equal(testGuardActive(), false);
    assert.doesNotThrow(() => assertPortIsolation(3334, "escape hatch"));
  });
});
