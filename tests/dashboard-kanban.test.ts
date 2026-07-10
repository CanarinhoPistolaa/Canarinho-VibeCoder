import fs from "node:fs";
import { cleanChildEnv } from "./helpers/test-env.ts";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

function createTempHome(): { root: string; homeDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canarinho-dashboard-kanban-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, homeDir };
}

function runNodeScript(script: string, env: Record<string, string>): Record<string, unknown> {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv(env),
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error([
      `Script failed with exit ${result.status}`,
      `STDOUT:\n${result.stdout}`,
      `STDERR:\n${result.stderr}`,
    ].join("\n\n"));
  }

  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!lastLine) {
    throw new Error(`Script produced no JSON output. STDERR:\n${result.stderr}`);
  }
  return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("dashboard kanban view", () => {
  it("serves a lane-grouped snapshot at /api/runs/:id/kanban", () => {
    const temp = createTempHome();
    try {
      const result = runNodeScript(
        `
          import { once } from "node:events";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runId = "run_kanban_api_001";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 9, 'feature-dev-merge', 'kanban test', 'running', '{}', 1234, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'plan', 'feature-dev-merge_planner', 0, '', '', 'done', 'single', NULL, ?, ?)"
          ).run("step_k_planner", runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'implement', 'feature-dev-merge_developer', 1, '', '', 'running', 'loop', 'US-002', ?, ?)"
          ).run("step_k_dev", runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'verify', 'feature-dev-merge_verifier', 2, '', '', 'waiting', 'single', NULL, ?, ?)"
          ).run("step_k_verify", runId, now, now);

          db.prepare(
            "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'first', 'done', ?, ?)"
          ).run("story_k_001", runId, now, now);
          db.prepare(
            "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, 1, 'US-002', 'second', 'pending', ?, ?)"
          ).run("story_k_002", runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const apiRes = await fetch(baseUrl + "/api/runs/" + runId + "/kanban");
            const apiBody = await apiRes.json();
            const htmlRes = await fetch(baseUrl + "/runs/" + runId + "/kanban");
            const htmlBody = await htmlRes.text();
            const jsRes = await fetch(baseUrl + "/kanban-ui.js");
            const jsBody = await jsRes.text();
            const missingRes = await fetch(baseUrl + "/api/runs/does_not_exist/kanban");

            const devLane = (apiBody.lanes || []).find((l) => l.agent === "developer");
            const verLane = (apiBody.lanes || []).find((l) => l.agent === "verifier");

            const toggleCount = (jsBody.match(/class="card-toggle-btn"/g) || []).length;
            const hasPlusOnButton = jsBody.includes("card-toggle-btn") && jsBody.includes(">+</button>");

            console.log(JSON.stringify({
              apiStatus: apiRes.status,
              htmlStatus: htmlRes.status,
              htmlIsKanban: htmlBody.includes("Canarinho VibeCoder Kanban") || htmlBody.includes("canarinho Kanban") || htmlBody.includes("workflow kanban"),
              missingStatus: missingRes.status,
              laneCount: (apiBody.lanes || []).length,
              laneAgents: (apiBody.lanes || []).map((l) => l.agent),
              tokensSpent: apiBody.run?.tokens_spent ?? null,
              currentStoryId: apiBody.currentStoryId,
              devCardIds: (devLane?.cards || []).map((c) => c.id),
              devCardStatuses: (devLane?.cards || []).map((c) => c.status),
              verLaneStatus: verLane?.status ?? null,
              verLaneStepType: verLane?.stepType ?? null,
              toggleCount,
              hasPlusOnButton,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

      assert.equal(result.apiStatus, 200);
      assert.equal(result.htmlStatus, 200);
      assert.equal(result.htmlIsKanban, true);
      assert.equal(result.missingStatus, 404);
      assert.equal(result.laneCount, 3);
      assert.deepEqual(result.laneAgents, ["planner", "developer", "verifier"]);
      assert.equal(result.tokensSpent, 1234);
      assert.equal(result.currentStoryId, "US-002");
      assert.deepEqual(result.devCardIds, ["US-001", "US-002"]);
      // US-001 done, US-002 promoted from pending → running because the loop step
      // is alive and current_story_id matches.
      assert.deepEqual(result.devCardStatuses, ["done", "running"]);
      assert.equal(result.verLaneStatus, "todo");
      assert.equal(result.verLaneStepType, "single");
      assert.ok(result.toggleCount > 0, "kanban cards should contain toggle buttons");
      assert.ok(result.hasPlusOnButton, "toggle buttons should show + by default");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("kanban cards have data-card-id attributes for expansion wiring", () => {
    const temp = createTempHome();
    try {
      const result = runNodeScript(
        `
          import { once } from "node:events";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runId = "run_kanban_us004";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feat', 'US-004 test', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'dev', 'feat_developer', 0, 'test prompt', '', 'running', 'loop', 'US-001', ?, ?)"
          ).run("step_us004", runId, now, now);

          db.prepare(
            "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'wire toggle', 'pending', ?, ?)"
          ).run("story_us004", runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const htmlRes = await fetch(baseUrl + "/runs/" + runId + "/kanban");
            const htmlBody = await htmlRes.text();
            const jsRes = await fetch(baseUrl + "/kanban-ui.js");
            const jsBody = await jsRes.text();
            const cssRes = await fetch(baseUrl + "/kanban-ui.css");
            const cssBody = await cssRes.text();
            const combined = jsBody + cssBody;

            const hasSetCardId = combined.includes('setAttribute("data-card-id"');
            const hasDelegateHandler = combined.includes('closest(".card-toggle-btn")');
            const hasCreateDetail = combined.includes('createDetailSection');
            const hasCreateError = combined.includes('createErrorSection');
            const hasDetailCss = combined.includes('card-detail') && combined.includes('detail-section');
            const hasToggleMinus = combined.includes('−');
            const hasDetailFailureCss = combined.includes('detail-failure-text');

            await new Promise((resolve) => server.close(() => resolve()));

            console.log(JSON.stringify({
              hasSetCardId,
              hasDelegateHandler,
              hasCreateDetail,
              hasCreateError,
              hasDetailCss,
              hasToggleMinus,
              hasDetailFailureCss,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

      assert.ok(result.hasSetCardId, "cards should set data-card-id attribute");
      assert.ok(result.hasDelegateHandler, "should have event delegation for toggle buttons");
      assert.ok(result.hasCreateDetail, "should have createDetailSection function");
      assert.ok(result.hasCreateError, "should have createErrorSection function for fetch errors");
      assert.ok(result.hasDetailCss, "should have card-detail CSS styles");
      assert.ok(result.hasToggleMinus, "should have minus sign for toggle");
      assert.ok(result.hasDetailFailureCss, "should have failure detail CSS styling");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("US-005: styles detail section, handles missing data, preserves expanded state", () => {
    const temp = createTempHome();
    try {
      const result = runNodeScript(
        `
          import { once } from "node:events";
          import { getDb } from "./dist/db.js";
          import { createDashboardServer } from "./dist/server/dashboard.js";

          const runId = "run_kanban_us005";
          const now = new Date().toISOString();
          const db = getDb();

          db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);

          db.prepare(
            "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feat', 'US-005 test', 'running', '{}', 0, ?, ?)"
          ).run(runId, now, now);

          db.prepare(
            "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, created_at, updated_at) VALUES (?, ?, 'dev', 'feat_developer', 0, 'test prompt', '', 'running', 'loop', 'US-001', ?, ?)"
          ).run("step_us005", runId, now, now);

          db.prepare(
            "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) VALUES (?, ?, 0, 'US-001', 'style detail', 'pending', ?, ?)"
          ).run("story_us005", runId, now, now);

          const server = createDashboardServer(0);
          if (!server.listening) await once(server, "listening");
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("bad address");
          const baseUrl = "http://127.0.0.1:" + addr.port;

          try {
            const htmlRes = await fetch(baseUrl + "/runs/" + runId + "/kanban");
            const htmlBody = await htmlRes.text();
            const jsRes = await fetch(baseUrl + "/kanban-ui.js");
            const jsBody = await jsRes.text();
            const cssRes = await fetch(baseUrl + "/kanban-ui.css");
            const cssBody = await cssRes.text();
            const combined = jsBody + cssBody;

            // Missing data placeholder
            const hasDetailPlaceholder = combined.includes('detail-placeholder');
            const hasEmDash = combined.includes('—');

            // Expanded state persistence
            const hasExpandedSet = combined.includes('expandedCardIds');
            const hasReExpand = combined.includes('Re-expand') || combined.includes('expandedCardIds');

            // Keyboard accessibility
            const hasKeydownHandler = combined.includes('keydown') && combined.includes('card-toggle-btn');

            // Loading animation
            const hasLoadingBlink = combined.includes('loading-blink');

            // Monospace font for prompts
            const hasMonoPrompt = combined.includes('detail-prompt-text');

            // Timing format
            const hasFmtDuration = combined.includes('fmtDuration');

            // Token format
            const hasFmtTokens = combined.includes('fmtTokens');

            // Failure visual treatment
            const hasDetailFailure = combined.includes('detail-failure-text');

            // Expanded state persistence: collapse calls delete
            const hasExpandedDelete = combined.includes('expandedCardIds.delete');
            const hasExpandedAdd = combined.includes('expandedCardIds.add');

            await new Promise((resolve) => server.close(() => resolve()));

            console.log(JSON.stringify({
              hasDetailPlaceholder,
              hasEmDash,
              hasExpandedSet,
              hasReExpand,
              hasKeydownHandler,
              hasLoadingBlink,
              hasMonoPrompt,
              hasFmtDuration,
              hasFmtTokens,
              hasDetailFailure,
              hasExpandedDelete,
              hasExpandedAdd,
            }));
          } finally {
            await new Promise((resolve) => server.close(() => resolve()));
          }
        `,
        { HOME: temp.homeDir },
      );

      // Missing data placeholders
      assert.ok(result.hasDetailPlaceholder, "should have detail-placeholder CSS class for missing data");
      assert.ok(result.hasEmDash, "should have em-dash placeholder text");

      // Expanded state persistence
      assert.ok(result.hasExpandedSet, "should have expandedCardIds Set for state persistence");
      assert.ok(result.hasExpandedDelete, "should remove from expandedCardIds on collapse");
      assert.ok(result.hasExpandedAdd, "should add to expandedCardIds on successful expand");

      // Keyboard accessibility
      assert.ok(result.hasKeydownHandler, "should have keydown handler for Enter/Space on toggle buttons");

      // Loading animation
      assert.ok(result.hasLoadingBlink, "should have loading-blink CSS animation");

      // Monospace font for prompts
      assert.ok(result.hasMonoPrompt, "should have detail-prompt-text CSS for monospace prompts");

      // Human-readable timing format
      assert.ok(result.hasFmtDuration, "should have fmtDuration for human-readable timing");

      // Token k/M formatting
      assert.ok(result.hasFmtTokens, "should have fmtTokens for k/M formatting");

      // Failure visual treatment
      assert.ok(result.hasDetailFailure, "should have detail-failure-text for failure styling");
    } finally {
      fs.rmSync(temp.root, { recursive: true, force: true });
    }
  });

  it("links the kanban view from each run row rendered by dashboard-ui.js", () => {
    const js = fs.readFileSync(path.join(repoRoot, "src", "server", "dashboard-ui.js"), "utf-8");
    const css = fs.readFileSync(path.join(repoRoot, "src", "server", "dashboard-ui.css"), "utf-8");
    // Two affordances: the run-ID chip stays clickable, and there is also an
    // explicit "Kanban →" pill in a dedicated "View" column so the option is
    // unambiguous on every row.
    assert.match(js, /\/runs\/\$\{encodeURIComponent\(r\.id\)\}\/kanban/);
    assert.match(js, /class="mono run-link"/);
    assert.match(js, /class="kanban-link"/);
    assert.match(js, /Kanban &rarr;/);
    assert.match(js, /<th>View<\/th>/);
    assert.match(css, /a\.kanban-link\s*\{[^}]*border-radius:\s*999px/);
  });
});
