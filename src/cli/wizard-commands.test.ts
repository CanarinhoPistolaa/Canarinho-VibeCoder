/**
 * Tests for wizard-commands.ts — argv validation and shell rendering.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateInitArgv,
  validateLoopArgv,
  shellQuote,
  renderShellCommand,
  renderWizardCommands,
} from "../../dist/cli/wizard-commands.js";
import type { WizardEvaluatorReady } from "../../dist/cli/wizard-types.js";

// ── shellQuote ─────────────────────────────────────────────────────

describe("shellQuote", () => {
  it("single-quotes a simple argument", () => {
    assert.equal(shellQuote("hello"), "'hello'");
  });

  it("escapes embedded single quotes", () => {
    assert.equal(shellQuote("it's fine"), "'it'\\''s fine'");
  });

  it("handles empty string", () => {
    assert.equal(shellQuote(""), "''");
  });

  it("quotes arguments with spaces", () => {
    assert.equal(shellQuote("a b"), "'a b'");
  });

  it("quotes arguments with dollar signs (prevents expansion)", () => {
    assert.equal(shellQuote("$HOME"), "'$HOME'");
  });

  it("quotes arguments with backticks", () => {
    assert.equal(shellQuote("`cmd`"), "'`cmd`'");
  });

  it("quotes arguments with asterisks (prevents glob)", () => {
    assert.equal(shellQuote("*.txt"), "'*.txt'");
  });
});

// ── validateInitArgv ───────────────────────────────────────────────

describe("validateInitArgv", () => {
  it("accepts minimal valid init argv", () => {
    assert.equal(
      validateInitArgv(["autoresearch", "init"]),
      null,
    );
  });

  it("accepts init argv with all known flags", () => {
    assert.equal(
      validateInitArgv([
        "autoresearch",
        "init",
        "--goal",
        "reduce build time",
        "--metric",
        "compile_seconds",
        "--unit",
        "s",
        "--direction",
        "lower",
        "--command",
        "./autoresearch.sh",
        "--metric-regex",
        "compile_seconds:\\s*([\\d.]+)",
        "--checks-command",
        "./checks.sh",
        "--cwd",
        "/tmp",
        "--overwrite",
      ]),
      null,
    );
  });

  it("accepts --overwrite with no value", () => {
    assert.equal(
      validateInitArgv([
        "autoresearch",
        "init",
        "--goal",
        "goal text",
        "--overwrite",
      ]),
      null,
    );
  });

  it("rejects argv not starting with [autoresearch, init]", () => {
    const err = validateInitArgv(["autoresearch", "loop", "--prompt"]);
    assert.ok(err !== null);
    assert.ok(err.includes("must start with"), `got: ${err}`);
  });

  it("rejects too-short argv", () => {
    const err = validateInitArgv(["autoresearch"]);
    assert.ok(err !== null);
    assert.ok(err.includes("must start with"), `got: ${err}`);
  });

  it("rejects empty argv", () => {
    const err = validateInitArgv([]);
    assert.ok(err !== null);
  });

  it("rejects --prompt in init argv", () => {
    const err = validateInitArgv([
      "autoresearch",
      "init",
      "--prompt",
      "--goal",
      "some goal",
    ]);
    assert.ok(err !== null);
    assert.ok(err.includes("--prompt"), `got: ${err}`);
  });

  it("rejects unknown init flag", () => {
    const err = validateInitArgv([
      "autoresearch",
      "init",
      "--unknown-flag",
      "value",
    ]);
    assert.ok(err !== null);
    assert.ok(err.includes("unknown flag"), `got: ${err}`);
  });

  it("rejects unexpected positional arguments after flags", () => {
    const err = validateInitArgv([
      "autoresearch",
      "init",
      "positional",
    ]);
    assert.ok(err !== null);
    assert.ok(err.includes("unexpected positional"), `got: ${err}`);
  });

  it("rejects loop flags in init argv", () => {
    // --max-iterations is NOT in INIT_FLAGS
    const err = validateInitArgv([
      "autoresearch",
      "init",
      "--max-iterations",
      "25",
    ]);
    assert.ok(err !== null);
    assert.ok(err.includes("unknown flag"), `got: ${err}`);
  });
});

// ── validateLoopArgv ───────────────────────────────────────────────

describe("validateLoopArgv", () => {
  it("accepts minimal valid loop argv", () => {
    assert.equal(
      validateLoopArgv(["autoresearch", "loop", "--prompt"]),
      null,
    );
  });

  it("accepts loop argv with all known flags", () => {
    assert.equal(
      validateLoopArgv([
        "autoresearch",
        "loop",
        "--prompt",
        "--target-metric",
        "0.5",
        "--max-iterations",
        "25",
        "--max-consecutive-failures",
        "5",
        "--timeout",
        "10m",
        "--cwd",
        "/tmp",
      ]),
      null,
    );
  });

  it("rejects argv not starting with [autoresearch, loop, --prompt]", () => {
    const err = validateLoopArgv(["autoresearch", "loop"]);
    assert.ok(err !== null);
    assert.ok(
      err.includes("must start with") || err.includes("must include --prompt"),
      `got: ${err}`,
    );
  });

  it("rejects argv starting with autoresearch loop but missing --prompt", () => {
    const err = validateLoopArgv([
      "autoresearch",
      "loop",
      "--max-iterations",
      "25",
    ]);
    assert.ok(err !== null);
    assert.ok(
      err.includes("must start with") || err.includes("must include --prompt"),
      `got: ${err}`,
    );
  });

  it("rejects --prompt with a value following it", () => {
    const err = validateLoopArgv([
      "autoresearch",
      "loop",
      "--prompt",
      "some prompt text",
      "--max-iterations",
      "25",
    ]);
    assert.ok(err !== null);
    assert.ok(
      err.includes("must not have a value"),
      `got: ${err}`,
    );
  });

  it("rejects unknown loop flag", () => {
    const err = validateLoopArgv([
      "autoresearch",
      "loop",
      "--prompt",
      "--unknown-loop-flag",
      "value",
    ]);
    assert.ok(err !== null);
    assert.ok(err.includes("unknown flag"), `got: ${err}`);
  });

  it("rejects init-only flags in loop argv", () => {
    // --goal is NOT in LOOP_FLAGS
    const err = validateLoopArgv([
      "autoresearch",
      "loop",
      "--prompt",
      "--goal",
      "reduce build time",
    ]);
    assert.ok(err !== null);
    assert.ok(err.includes("unknown flag"), `got: ${err}`);
  });

  it("rejects unexpected positional argument", () => {
    // "positional" after --prompt is treated as a --prompt value, which is not allowed.
    // Either error ("must not have a value" or "unexpected positional") is valid.
    const err = validateLoopArgv([
      "autoresearch",
      "loop",
      "--prompt",
      "positional",
    ]);
    assert.ok(err !== null);
    assert.ok(
      err.includes("unexpected positional") || err.includes("must not have a value"),
      `got: ${err}`,
    );
  });

  it("rejects --prompt appearing twice", () => {
    // The prefix check ensures first --prompt is at position 2.
    // The second --prompt is not in LOOP_FLAGS so it's rejected.
    const err = validateLoopArgv([
      "autoresearch",
      "loop",
      "--prompt",
      "--prompt",
    ]);
    assert.ok(err !== null);
    assert.ok(err.includes("unknown flag"), `got: ${err}`);
  });
});

// ── renderShellCommand ─────────────────────────────────────────────

describe("renderShellCommand", () => {
  it("renders a simple command with canarinho prefix", () => {
    const cmd = renderShellCommand(["autoresearch", "loop", "--prompt"]);
    assert.equal(
      cmd,
      "canarinho 'autoresearch' 'loop' '--prompt'",
    );
  });

  it("renders with a custom binary name", () => {
    const cmd = renderShellCommand(["autoresearch", "loop", "--prompt"], "foo");
    assert.equal(cmd, "foo 'autoresearch' 'loop' '--prompt'");
  });

  it("shell-quotes arguments with special chars", () => {
    const cmd = renderShellCommand([
      "autoresearch",
      "init",
      "--goal",
      "reduce build time",
    ]);
    assert.ok(cmd.includes("'reduce build time'"), `got: ${cmd}`);
  });

  it("escapes single quotes in arguments", () => {
    const cmd = renderShellCommand([
      "autoresearch",
      "init",
      "--goal",
      "it's ready",
    ]);
    assert.ok(cmd.includes("'it'\\''s ready'"), `got: ${cmd}`);
  });

  it("works with binaryName omitted (defaults to canarinho)", () => {
    const cmd = renderShellCommand(["autoresearch", "init"]);
    assert.ok(cmd.startsWith("canarinho "));
    assert.ok(cmd.includes("'autoresearch'"));
  });
});

// ── renderWizardCommands ───────────────────────────────────────────

describe("renderWizardCommands", () => {
  const baseReady: WizardEvaluatorReady = {
    ready: true,
    commentary: "Composed from your answers.",
    needsInit: false,
    loopArgv: ["autoresearch", "loop", "--prompt"],
  };

  it("renders single loop command when init not needed", () => {
    const result = renderWizardCommands(baseReady);
    assert.equal(result.needsInit, false);
    assert.equal(
      result.display,
      "canarinho 'autoresearch' 'loop' '--prompt'",
    );
    assert.deepEqual(result.loopArgv, ["autoresearch", "loop", "--prompt"]);
    assert.equal(result.initArgv, undefined);
  });

  it("renders two commands joined by ; when init needed", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "Session not yet initialized.",
      needsInit: true,
      initArgv: [
        "autoresearch",
        "init",
        "--goal",
        "reduce build time",
        "--metric",
        "compile_seconds",
        "--direction",
        "lower",
        "--command",
        "./autoresearch.sh",
      ],
      loopArgv: ["autoresearch", "loop", "--prompt", "--max-iterations", "25"],
    };
    const result = renderWizardCommands(ready);
    assert.equal(result.needsInit, true);
    assert.ok(result.display.includes(" ; "), `got: ${result.display}`);
    assert.ok(
      result.display.includes("canarinho 'autoresearch' 'init'"),
    );
    assert.ok(
      result.display.includes("canarinho 'autoresearch' 'loop' '--prompt'"),
    );
    assert.deepEqual(result.initArgv, ready.initArgv);
    assert.deepEqual(result.loopArgv, ready.loopArgv);
  });

  it("throws when needsInit:true but initArgv is missing", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: true,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    assert.throws(
      () => renderWizardCommands(ready),
      /needsInit is true but initArgv is missing/,
    );
  });

  it("throws when needsInit:true but initArgv is null", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: true,
      initArgv: null,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    assert.throws(
      () => renderWizardCommands(ready),
      /needsInit is true but initArgv is missing/,
    );
  });

  it("throws when needsInit:false but initArgv is present", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: false,
      initArgv: ["autoresearch", "init", "--goal", "x"],
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    assert.throws(
      () => renderWizardCommands(ready),
      /needsInit is false but initArgv is present/,
    );
  });

  it("throws when loopArgv fails validation (unknown flag)", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt", "--bad-flag"],
    };
    assert.throws(
      () => renderWizardCommands(ready),
      /Invalid loopArgv from pi/,
    );
  });

  it("throws when loopArgv fails validation (missing --prompt)", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: false,
      loopArgv: ["autoresearch", "loop"],
    };
    assert.throws(
      () => renderWizardCommands(ready),
      /Invalid loopArgv from pi/,
    );
  });

  it("throws when loopArgv fails validation (--prompt with value)", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt", "some prompt"],
    };
    assert.throws(
      () => renderWizardCommands(ready),
      /Invalid loopArgv from pi/,
    );
  });

  it("throws when initArgv fails validation (unknown flag)", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: true,
      initArgv: ["autoresearch", "init", "--bad-flag"],
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    assert.throws(
      () => renderWizardCommands(ready),
      /Invalid initArgv from pi/,
    );
  });

  it("throws when initArgv fails validation (contains --prompt)", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: true,
      initArgv: ["autoresearch", "init", "--prompt"],
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    assert.throws(
      () => renderWizardCommands(ready),
      /Invalid initArgv from pi/,
    );
  });

  it("renders with custom binary name", () => {
    const ready: WizardEvaluatorReady = {
      ready: true,
      commentary: "done",
      needsInit: true,
      initArgv: ["autoresearch", "init", "--goal", "goal"],
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    const result = renderWizardCommands(ready, "myapp");
    assert.ok(result.display.startsWith("myapp "));
  });
});
