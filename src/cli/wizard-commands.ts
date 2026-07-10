/**
 * Command argv validation and shell rendering for the AutoResearch wizard.
 *
 * Pure functions — no I/O, no side effects. Designed for testability.
 */

import type { WizardEvaluatorReady } from "./wizard-types.js";

// ── Allowed flag sets ──────────────────────────────────────────────

const INIT_FLAGS = new Set([
  "--goal",
  "--metric",
  "--unit",
  "--direction",
  "--command",
  "--metric-regex",
  "--checks-command",
  "--cwd",
  "--overwrite",
]);

const LOOP_FLAGS = new Set([
  "--target-metric",
  "--max-iterations",
  "--max-consecutive-failures",
  "--timeout",
  "--cwd",
]);

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Validates that an argv array starts with a given prefix, and that every
 * flag encountered after the prefix is in allowedFlags.  Flags that take
 * values consume the next element.  When checkPromptFlag=true, --prompt is
 * required to be the first flag after the prefix and must NOT consume a value.
 */
function validateArgv(
  argv: string[],
  requiredPrefix: string[],
  allowedFlags: Set<string>,
  checkPromptFlag: boolean,
): string | null {
  // Must be long enough for the prefix.
  if (argv.length < requiredPrefix.length) {
    return `argv must start with ${JSON.stringify(requiredPrefix)}`;
  }
  for (let i = 0; i < requiredPrefix.length; i++) {
    if (argv[i] !== requiredPrefix[i]) {
      return `argv must start with ${JSON.stringify(requiredPrefix)}, got ${JSON.stringify(argv.slice(0, requiredPrefix.length))}`;
    }
  }

  let i = requiredPrefix.length;

  // If --prompt is required as first flag.
  if (checkPromptFlag) {
    if (i >= argv.length || argv[i] !== "--prompt") {
      return `argv must include --prompt immediately after ${JSON.stringify(requiredPrefix)}`;
    }
    // --prompt is a flag: the next element must NOT be a prompt value
    // (if there is a next element, it must start with "--" or be the end).
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      return `--prompt is a flag and must not have a value (got "${argv[i + 1]}")`;
    }
    i++; // consume --prompt
  }

  // Walk remaining flags.
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      // Check if it's a known value flag (e.g. --direction lower-like value).
      // The flag must be in allowedFlags.
      if (!allowedFlags.has(arg)) {
        return `unknown flag: ${arg}`;
      }
      // Consume the flag.  Some flags like --overwrite take no value,
      // but we treat everything that looks like a flag as a flag and
      // check the next element to decide whether it's a value or another flag.
      i++;
      // If the next element exists and does NOT start with "--", it's a value.
      if (i < argv.length && !argv[i].startsWith("--")) {
        i++; // consume value
      }
    } else {
      // Non-flag argument not allowed after prefix.
      return `unexpected positional argument: ${arg}`;
    }
  }

  return null; // valid
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Validate initArgv returned by the pi evaluator.
 *
 * Rules:
 * - Must start with ["autoresearch", "init"]
 * - Only allowed flags (see INIT_FLAGS)
 * - --prompt is NOT allowed
 *
 * @returns null if valid, or an error message string.
 */
export function validateInitArgv(argv: string[]): string | null {
  return validateArgv(argv, ["autoresearch", "init"], INIT_FLAGS, false);
}

/**
 * Validate loopArgv returned by the pi evaluator.
 *
 * Rules:
 * - Must start with ["autoresearch", "loop", "--prompt"]
 * - --prompt is a flag (takes NO value)
 * - Only allowed flags (see LOOP_FLAGS)
 *
 * @returns null if valid, or an error message string.
 */
export function validateLoopArgv(argv: string[]): string | null {
  // Must start with ["autoresearch", "loop", "--prompt"] where --prompt
  // is a flag (takes NO value).  validateArgv with checkPromptFlag=true
  // handles both the --prompt presence and the no-value check.
  const prefixErr = validateArgv(argv, ["autoresearch", "loop"], LOOP_FLAGS, true);
  if (prefixErr !== null) return prefixErr;
  // Also reject if --prompt appears again later (not in LOOP_FLAGS).
  // The walker will catch it as an unknown flag.
  return null;
}

// ── Shell quoting ──────────────────────────────────────────────────

/**
 * Quote a single argument for shell use.
 *
 * Prefers single-quote wrapping because it prevents all expansions (variable,
 * command substitution, glob).  Escapes embedded single quotes by ending
 * the single-quote span, inserting an escaped quote, and re-opening.
 *
 * Edge cases handled:
 * - Empty string  →  '' (two single quotes)
 * - `it's fine`   →  'it'\''s fine'
 * - `hello`       →  'hello'
 * - `a b`         →  'a b'
 */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  // If the arg has no special characters, we could return it unquoted,
  // but single-quoting everything is safer and consistent.
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Render an argv array into a pasteable shell command string.
 *
 * @param argv       The command and its arguments (e.g. ["canarinho", "autoresearch", "loop", "--prompt"])
 * @param binaryName Optional binary name to prepend (defaults to "canarinho").
 * @returns A shell-safe single-line string suitable for copy-paste.
 */
export function renderShellCommand(
  argv: string[],
  binaryName: string = "canarinho",
): string {
  return [binaryName, ...argv.map(shellQuote)].join(" ");
}

// ── Wizard command rendering ───────────────────────────────────────

export interface RenderedWizardCommands {
  /** Pasteable shell command(s) to display. */
  display: string;
  /** Whether init is needed before loop. */
  needsInit: boolean;
  /** The init argv (validated), only when needsInit is true. */
  initArgv?: string[];
  /** The loop argv (validated). */
  loopArgv: string[];
}

/**
 * Render the wizard commands from a WizardEvaluatorReady result.
 *
 * Performs argv validation before rendering. If validation fails, throws
 * with a descriptive error message so the orchestrator can surface it.
 *
 * @param result     The ready evaluator output from pi.
 * @param binaryName Optional binary name (defaults to "canarinho").
 * @returns Rendered command display and structured argvs.
 */
export function renderWizardCommands(
  result: WizardEvaluatorReady,
  binaryName: string = "canarinho",
): RenderedWizardCommands {
  // Validate loop argv.
  const loopError = validateLoopArgv(result.loopArgv);
  if (loopError !== null) {
    throw new Error(`Invalid loopArgv from pi: ${loopError}`);
  }

  if (result.needsInit) {
    // Must have initArgv.
    if (!result.initArgv || !Array.isArray(result.initArgv)) {
      throw new Error(
        "needsInit is true but initArgv is missing or not an array",
      );
    }
    const initError = validateInitArgv(result.initArgv);
    if (initError !== null) {
      throw new Error(`Invalid initArgv from pi: ${initError}`);
    }

    const initCmd = renderShellCommand(result.initArgv, binaryName);
    const loopCmd = renderShellCommand(result.loopArgv, binaryName);
    return {
      display: `${initCmd} ; ${loopCmd}`,
      needsInit: true,
      initArgv: result.initArgv,
      loopArgv: result.loopArgv,
    };
  }

  // Not initialized — initArgv should be null or absent.
  if (result.initArgv != null) {
    throw new Error(
      "needsInit is false but initArgv is present (must be null or omitted)",
    );
  }

  const loopCmd = renderShellCommand(result.loopArgv, binaryName);
  return {
    display: loopCmd,
    needsInit: false,
    loopArgv: result.loopArgv,
  };
}
