import http from "node:http";
import path from "node:path";

const BASE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CI",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  // Harness binary pins pass through so the npm-test-level
  // TAMANDUA_PI_BINARY=/bin/false safety net reaches spawned daemons and
  // scripts. Tiers that need a real or scripted harness set their own
  // value (explicit overrides win over the passthrough).
  "TAMANDUA_PI_BINARY",
  "TAMANDUA_HERMES_BINARY",
  // Isolation guard: npm test sets TAMANDUA_TEST_GUARD=1 so any spawned
  // daemon/script that reaches the real ~/.tamandua or a production port
  // fails loudly instead of silently interfering with the live instance.
  "TAMANDUA_TEST_GUARD",
];

export function cleanChildEnv(
  overrides: Record<string, string | undefined> = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of BASE_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const homeDir = env.HOME?.trim();
  const configuredStateDir = env.TAMANDUA_STATE_DIR?.trim();
  const stateDir = configuredStateDir || (homeDir ? path.join(homeDir, ".tamandua") : undefined);
  if (stateDir) {
    env.TAMANDUA_STATE_DIR = stateDir;
    env.TAMANDUA_DB_PATH = env.TAMANDUA_DB_PATH?.trim() || path.join(stateDir, "tamandua.db");
    env.TAMANDUA_WORKTREE_ROOT =
      env.TAMANDUA_WORKTREE_ROOT?.trim() || path.join(stateDir, "worktrees");
  }

  return env;
}

/** A handle that holds a port reservation. Call close() to release. */
export interface PortHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Reserve a random port by binding an HTTP server and keeping it bound.
 * The port stays owned until the caller invokes handle.close().
 * This avoids the TOCTOU race of bind-close-return patterns.
 */
export async function reservePortHandle(): Promise<PortHandle> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a random TCP port");
  }
  const port = address.port;
  server.unref();
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Reserve multiple ports held by handles. */
export async function reservePortHandles(count: number): Promise<PortHandle[]> {
  const handles: PortHandle[] = [];
  for (let i = 0; i < count; i++) {
    handles.push(await reservePortHandle());
  }
  return handles;
}

/**
 * Reserve `count` distinct ports, call `fn(ports)`, then release all ports
 * in a finally block. This is the preferred pattern for daemon/control-plane
 * tests that need guaranteed port ownership for their duration.
 */
export async function withReservedPorts<T>(
  count: number,
  fn: (ports: number[]) => Promise<T>,
): Promise<T> {
  const handles = await reservePortHandles(count);
  try {
    return await fn(handles.map((h) => h.port));
  } finally {
    await Promise.all(handles.map((h) => h.close()));
  }
}

/**
 * @deprecated Use reservePortHandle() or withReservedPorts() instead.
 * This function releases the port immediately, creating a TOCTOU race in
 * parallel test environments. It is kept for backward compatibility.
 */
export async function reserveRandomPort(): Promise<number> {
  const handle = await reservePortHandle();
  await handle.close();
  return handle.port;
}

/**
 * @deprecated Use reservePortHandles() or withReservedPorts() instead.
 * These ports are released immediately, creating a TOCTOU race in parallel
 * test environments. Kept for backward compatibility.
 */
export async function reserveDistinctRandomPorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    ports.add(await reserveRandomPort());
  }
  return [...ports];
}
