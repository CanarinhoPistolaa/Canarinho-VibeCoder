/**
 * Test-isolation guard.
 *
 * Tamandua is the main tool used to develop tamandua itself, so a test (or
 * anything a test spawns) touching the REAL ~/.tamandua state or binding
 * the production ports would interfere with the live instance — leaked
 * daemons squatting the control port, EADDRINUSE collisions, state
 * pollution, and cross-talk between the suite and real runs have all
 * happened. `npm test` sets TAMANDUA_TEST_GUARD=1 (passed through
 * cleanChildEnv to spawned daemons/scripts), turning any such touch into a
 * loud, attributable failure instead of silent interference.
 *
 * Production is unaffected: the guard is inert unless TAMANDUA_TEST_GUARD
 * is set.
 */
import os from "node:os";
import path from "node:path";

/** Ports the live tamandua instance uses by default. */
const PRODUCTION_PORTS = new Set([3334, 3338, 3339]);

export function testGuardActive(): boolean {
  return process.env.TAMANDUA_TEST_GUARD === "1";
}

/**
 * The invoking user's actual home directory from the OS account database —
 * deliberately NOT os.homedir(), which follows the HOME env var that
 * isolated tests legitimately point at temp directories.
 */
function realUserHome(): string | null {
  try {
    return os.userInfo().homedir || null;
  } catch {
    return null;
  }
}

/** Throw if a server is about to bind a production port under the guard. */
export function assertPortIsolation(port: number, what: string): void {
  if (!testGuardActive()) return;
  if (!PRODUCTION_PORTS.has(port)) return;
  throw new Error(
    `TEST ISOLATION VIOLATION: ${what} tried to bind production port ${port} while ` +
      `TAMANDUA_TEST_GUARD=1. Tests (and anything they spawn) must use random ports — ` +
      `see reservePortHandle() in tests/helpers/test-env.ts and set ` +
      `TAMANDUA_CONTROL_PORT / explicit port arguments for every daemon they start.`,
  );
}

/** Throw if a state path resolves into the REAL ~/.tamandua under the guard. */
export function assertStatePathIsolation(resolvedPath: string, what: string): void {
  if (!testGuardActive()) return;
  const home = realUserHome();
  if (!home) return;
  const realStateDir = path.join(home, ".tamandua");
  const normalized = path.resolve(resolvedPath);
  if (normalized === realStateDir || normalized.startsWith(realStateDir + path.sep)) {
    throw new Error(
      `TEST ISOLATION VIOLATION: ${what} resolved to the real tamandua state ` +
        `(${normalized}) while TAMANDUA_TEST_GUARD=1. Tests must point HOME / ` +
        `TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH at a per-test temp directory.`,
    );
  }
}
