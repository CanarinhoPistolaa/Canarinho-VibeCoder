/**
 * Wizard interaction orchestrator for AutoResearch.
 *
 * Drives the interactive wizard flow: prints an AutoResearch explanation,
 * asks open-ended questions via readline, calls the pi evaluator after each
 * answer, displays commentary and commands when ready, and handles the
 * launch/abort/adjust flow.
 *
 * All I/O dependencies (terminal, pi spawning, command spawning) are
 * injectable for testability.
 */

import * as readline from "node:readline";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { evaluateWizardResponse, type PiSpawnFn } from "./wizard-evaluator.js";
import { buildEvaluatorPrompt } from "./wizard-prompt.js";
import {
  renderWizardCommands,
  type RenderedWizardCommands,
} from "./wizard-commands.js";
import type {
  WizardTranscriptEntry,
  WizardEvaluatorReady,
} from "./wizard-types.js";
import { summarizeAutoresearch } from "../autoresearch/autoresearch.js";
import { logger } from "../lib/logger.js";

// ── Injectable terminal interface ──────────────────────────────────

export interface WizardTerminal {
  /** Print a line to stdout. */
  print(line: string): void;
  /** Ask an open-ended question and return the user's answer. */
  question(prompt: string): Promise<string>;
  /** Ask a yes/no question. Returns true for Y/y, false for N/n. */
  confirm(prompt: string): Promise<boolean>;
  /** Ask a choice question. Returns the user's selection. */
  choice(prompt: string, options: string[]): Promise<string>;
  /** Close the terminal. */
  close(): void;
}

// ── Injectable command spawner ─────────────────────────────────────

export type CommandSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Spawn a command and wait for it to finish.
 * Returns the exit code. Resolves the promise when the process exits.
 */
function spawnAndWait(
  spawnFn: CommandSpawnFn,
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      ...options,
      stdio: "inherit",
    });

    child.on("error", (err: Error) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      resolve(code ?? 1);
    });
  });
}

// ── Readline-based terminal implementation ─────────────────────────

function createReadlineTerminal(): WizardTerminal {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return {
    print(line: string): void {
      console.log(line);
    },

    question(prompt: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(prompt, (answer: string) => {
          resolve(answer.trim());
        });
      });
    },

    async confirm(prompt: string): Promise<boolean> {
      while (true) {
        const answer = await this.question(prompt);
        const lower = answer.toLowerCase();
        if (lower === "y" || lower === "yes") return true;
        if (lower === "n" || lower === "no") return false;
        this.print('Please answer "Y" or "n".');
      }
    },

    async choice(prompt: string, options: string[]): Promise<string> {
      while (true) {
        const answer = await this.question(prompt);
        const lower = answer.toLowerCase();
        for (const opt of options) {
          if (lower === opt.toLowerCase()) return opt;
        }
        this.print(`Please choose one of: ${options.join("/")}`);
      }
    },

    close(): void {
      rl.close();
    },
  };
}

// ── Explanation text ───────────────────────────────────────────────

const WIZARD_EXPLANATION = `AutoResearch lets canarinho run an automated experiment loop to
iteratively improve a measurable metric in your project.

Key concepts:
  • autoresearch init — creates project-local config declaring the
    optimization goal, metric, measurement command, and direction.
  • autoresearch loop --prompt — runs a bounded experiment cycle:
    canarinho proposes one small change, measures the metric, records
    the result, and repeats. The loop stops when it hits a target
    metric, max iterations, consecutive failures, or Ctrl-C.

This wizard will guide you through configuring your AutoResearch session.`;

const FIRST_QUESTION =
  "What do you want AutoResearch to improve, and how should canarinho measure success?";

// ── Helpers ────────────────────────────────────────────────────────

function checkAutoResearchInitialized(cwd: string): {
  initialized: boolean;
  configSummary?: string;
} {
  try {
    const summary = summarizeAutoresearch(cwd);
    if (!summary.exists) {
      return { initialized: false };
    }
    return {
      initialized: true,
      configSummary: [
        `goal="${summary.goal ?? "?"}"`,
        `metric=${summary.metricName ?? "?"}`,
        summary.metricUnit ? `unit=${summary.metricUnit}` : null,
        `direction=${summary.direction ?? "?"}`,
        summary.baselineMetric != null
          ? `baseline=${summary.baselineMetric}`
          : null,
        summary.bestMetric != null ? `best=${summary.bestMetric}` : null,
        `runs=${summary.totalRuns ?? 0}`,
      ]
        .filter(Boolean)
        .join(", "),
    };
  } catch {
    return { initialized: false };
  }
}

// ── Main orchestrator ──────────────────────────────────────────────

export interface RunWizardOptions {
  /** Working directory (default: process.cwd()). */
  cwd?: string;
  /** Binary name for rendered commands (default: "canarinho"). */
  binaryName?: string;
  /** Injectable pi spawn function (for testing). */
  piSpawn?: PiSpawnFn;
  /** Injectable terminal (for testing). */
  terminal?: WizardTerminal;
  /** Injectable command spawn function (for testing). */
  commandSpawn?: CommandSpawnFn;
}

/**
 * Run the interactive AutoResearch wizard.
 *
 * Orchestrates the full flow:
 * 1. Print AutoResearch explanation
 * 2. Ask open-ended first question
 * 3. After each answer, call pi evaluator
 * 4. Show follow-up questions or display ready commands
 * 5. Handle launch/abort/adjust
 */
export async function runWizard(options: RunWizardOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const binaryName = options.binaryName ?? "canarinho";
  const piSpawn = options.piSpawn ?? spawn;
  const terminal = options.terminal ?? createReadlineTerminal();
  const commandSpawn = options.commandSpawn ?? spawn;

  const transcript: WizardTranscriptEntry[] = [];

  // ── Step 1: Print explanation ────────────────────────────────────
  terminal.print(WIZARD_EXPLANATION);
  terminal.print("");

  // ── Step 2: Gather information loop ──────────────────────────────

  let firstQuestion = true;
  let currentQuestion: string = FIRST_QUESTION;

  while (true) {
    // Ask question
    const answer = await terminal.question(
      firstQuestion ? `> ${currentQuestion}\n> ` : `> ${currentQuestion}\n> `,
    );
    firstQuestion = false;

    if (answer.length === 0) {
      terminal.print(
        "(No response received. Please provide some information.)",
      );
      continue;
    }

    // Record in transcript
    transcript.push({ role: "user", text: answer });

    // Build evaluator prompt
    const { initialized, configSummary } = checkAutoResearchInitialized(cwd);
    const prompt = buildEvaluatorPrompt({
      cwd,
      initialized,
      configSummary,
      transcript: [...transcript],
    });

    // Evaluate with pi
    let evaluatorResult: WizardEvaluatorReady | { ready: false; question: string; reason: string };
    try {
      evaluatorResult = await evaluateWizardResponse(piSpawn, cwd, prompt);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      terminal.print(`\nError evaluating response: ${message}`);
      terminal.print("Let me ask again with adjusted context.\n");
      transcript.push({
        role: "assistant",
        text: `[Error: ${message}]`,
      });
      // Ask for clarification and continue
      currentQuestion =
        "Could you provide more details about how you want to measure success? What command should AutoResearch run to get the metric?";
      continue;
    }

    // Record evaluator response in transcript
    if (evaluatorResult.ready === false) {
      transcript.push({
        role: "assistant",
        text: `[Question: ${evaluatorResult.question}]`,
      });
    }

    if (!evaluatorResult.ready) {
      // Show follow-up question
      terminal.print(`\n${evaluatorResult.question}`);
      currentQuestion = evaluatorResult.question;
      continue;
    }

    // ── Ready: display results ─────────────────────────────────────

    terminal.print("");
    terminal.print(evaluatorResult.commentary);
    terminal.print("");

    // Render and validate commands
    let rendered: RenderedWizardCommands;
    try {
      rendered = renderWizardCommands(evaluatorResult, binaryName);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      terminal.print(`\nError: pi returned invalid commands: ${message}`);
      terminal.print("Let me re-evaluate.\n");
      transcript.push({
        role: "assistant",
        text: `[Error: pi returned invalid commands — ${message}]`,
      });
      currentQuestion =
        "I couldn't construct valid commands from your input. Could you describe your measurement approach differently?";
      continue;
    }

    // Display pasteable command(s)
    terminal.print("Pasteable command line:");
    terminal.print(`  ${rendered.display}`);
    terminal.print("");

    // ── Launch prompt ──────────────────────────────────────────────
    const shouldLaunch = await terminal.confirm("Launch this command now? (Y/n) ");

    if (shouldLaunch) {
      terminal.print("");

      // Execute init if needed
      if (rendered.needsInit && rendered.initArgv) {
        terminal.print("Running init...");
        logger.debug("Wizard: running init", {
          initArgv: rendered.initArgv,
        });
        try {
          const initCode = await spawnAndWait(
            commandSpawn,
            binaryName,
            rendered.initArgv,
            { cwd, stdio: "inherit" },
          );
          if (initCode !== 0) {
            terminal.print(`Init failed with exit code ${initCode}. Not starting loop.`);
            break;
          }
          terminal.print("Init completed successfully.");
          terminal.print("");
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          terminal.print(`Init failed: ${message}. Not starting loop.`);
          break;
        }
      }

      // Execute loop
      terminal.print("Running loop...");
      logger.debug("Wizard: running loop", {
        loopArgv: rendered.loopArgv,
      });
      try {
        const loopCode = await spawnAndWait(
          commandSpawn,
          binaryName,
          rendered.loopArgv,
          { cwd, stdio: "inherit" },
        );
        if (loopCode !== 0) {
          terminal.print(`Loop exited with code ${loopCode}.`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        terminal.print(`Loop failed: ${message}`);
      }
      break;
    }

    // ── Abort or adjust ────────────────────────────────────────────
    const decision = await terminal.choice(
      "Abort or adjust? [abort/adjust] ",
      ["abort", "adjust"],
    );

    if (decision === "abort") {
      terminal.print("Aborting. No commands were executed.");
      break;
    }

    // Adjust: ask what to change
    const adjustment = await terminal.question(
      "\nWhat would you like to change? ",
    );
    if (adjustment.length === 0) {
      terminal.print("(No changes specified. Returning to main prompt.)\n");
      currentQuestion = FIRST_QUESTION;
    } else {
      transcript.push({ role: "user", text: adjustment });
      terminal.print("");
      currentQuestion =
        "Given your adjustments, let me re-evaluate. Is there anything else I should know?";
    }
  }

  terminal.close();
}
