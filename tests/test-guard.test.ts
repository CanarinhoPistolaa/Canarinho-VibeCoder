/**
 * The test-isolation guard itself: under TAMANDUA_TEST_GUARD=1, binding a
 * production port or opening state under the REAL ~/.tamandua throws
 * loudly. Tamandua develops tamandua — without this, under-isolated tests
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

beforeEach(() => {
  savedGuard = process.env.TAMANDUA_TEST_GUARD;
});

afterEach(() => {
  if (savedGuard === undefined) delete process.env.TAMANDUA_TEST_GUARD;
  else process.env.TAMANDUA_TEST_GUARD = savedGuard;
});

describe("test-isolation guard", () => {
  it("blocks production ports (3334/3338/3339) when active", () => {
    process.env.TAMANDUA_TEST_GUARD = "1";
    for (const port of [3334, 3338, 3339]) {
      assert.throws(
        () => assertPortIsolation(port, "unit test"),
        /TEST ISOLATION VIOLATION.*production port/s,
        `port ${port} must be blocked`,
      );
    }
  });

  it("allows random ports when active", () => {
    process.env.TAMANDUA_TEST_GUARD = "1";
    assert.doesNotThrow(() => assertPortIsolation(39181, "unit test"));
    assert.doesNotThrow(() => assertPortIsolation(1, "unit test"));
  });

  it("blocks the real ~/.tamandua state dir when active — even if HOME is spoofed", () => {
    process.env.TAMANDUA_TEST_GUARD = "1";
    // The guard uses the OS account database, not the HOME env var, so a
    // test that forgot isolation cannot dodge it by accident.
    const realHome = os.userInfo().homedir;
    assert.throws(
      () => assertStatePathIsolation(path.join(realHome, ".tamandua", "tamandua.db"), "unit test"),
      /TEST ISOLATION VIOLATION.*real tamandua state/s,
    );
    assert.throws(
      () => assertStatePathIsolation(path.join(realHome, ".tamandua"), "unit test"),
      /TEST ISOLATION VIOLATION/,
    );
  });

  it("allows temp-dir state when active", () => {
    process.env.TAMANDUA_TEST_GUARD = "1";
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(os.tmpdir(), "tamandua-x", ".tamandua", "tamandua.db"), "unit test"),
    );
  });

  it("is completely inert without TAMANDUA_TEST_GUARD (production)", () => {
    delete process.env.TAMANDUA_TEST_GUARD;
    assert.equal(testGuardActive(), false);
    assert.doesNotThrow(() => assertPortIsolation(3334, "prod"));
    const realHome = os.userInfo().homedir;
    assert.doesNotThrow(() =>
      assertStatePathIsolation(path.join(realHome, ".tamandua", "tamandua.db"), "prod"),
    );
  });
});
