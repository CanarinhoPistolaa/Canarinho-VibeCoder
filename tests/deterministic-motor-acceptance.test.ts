/**
 * Deterministic-motor acceptance spec — written BEFORE the motor rewrite.
 *
 * These are the acceptance criteria (N1–N3 in tests/MOTOR-CONTRACT.md) for
 * replacing the model-driven polling motor with a deterministic dispatcher.
 * They are recorded as `todo` tests so the definition of done is visible in
 * every `npm test` run; implement each one as a real test when the
 * deterministic motor lands, then delete the todo.
 *
 * Counterpart baselines that must FLIP at the same time:
 * - e2e-tests/workflows-scripted.test.ts asserts the CURRENT motor burns
 *   system tokens on idle polls (heartbeats > 0) — invert that assertion.
 * - MOTOR-MECHANISM-tagged unit tests pin the polling implementation and
 *   are expected to be rewritten or deleted.
 */

import { describe, it } from "node:test";

describe("deterministic motor acceptance (MOTOR-CONTRACT.md N1–N3)", () => {
  it.todo(
    "N1: an idle run accrues zero system tokens — checking for work must not invoke a model " +
      "(tamandua_stats.system_tokens_spent stays 0 across polling cycles with no pending steps)",
  );

  it.todo(
    "N2: harness (model) invocations per run == executed work rounds — no model-driven peeks " +
      "(scripted-agent invocation journal records zero heartbeat-only invocations)",
  );

  it.todo(
    "N3: work-token attribution still holds under the new motor — runs.tokens_spent rises from " +
      "message_end usage, run.tokens.updated events fire, terminal events carry tokensSpent",
  );
});
