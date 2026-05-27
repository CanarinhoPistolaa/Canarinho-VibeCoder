import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the path to dist/version relative to this module's location at runtime.
 * dist/lib/version.js -> ../version -> dist/version
 */
function resolveVersionPath(): string {
  return path.resolve(__dirname, "..", "version");
}

/**
 * Reads the build version from the dist/version file.
 *
 * @returns The trimmed version string on success, "unknown" on any error
 *          (missing file, permission denied, empty file, etc.)
 */
export function getBuildVersion(): string {
  try {
    const versionPath = resolveVersionPath();
    const content = fs.readFileSync(versionPath, "utf-8").trim();
    return content || "unknown";
  } catch {
    return "unknown";
  }
}
