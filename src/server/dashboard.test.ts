import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { createDashboardServer } from "../../dist/server/dashboard.js";
import { type TamanduaEvent } from "../../dist/installer/events.js";
import { DEFAULT_MCP_PORT } from "../../dist/server/mcp-server.js";
import { getDb, incrementSystemTokenSpend, getSystemTokenSpend } from "../../dist/db.js";

interface LogsTailResponse {
  lines: string[];
  nextOffset: number;
}

function appendGlobalEvent(stateDir: string, evt: TamanduaEvent): void {
  const filePath = path.join(stateDir, "events", "all.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(evt)}\n`, "utf-8");
}

async function startDashboard(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = createDashboardServer(0);
  if (!server.listening) {
    await once(server, "listening");
  }

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopDashboard(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("dashboard logs-tail API", () => {
  it("returns initial logs-tail lines and cursor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-logs-tail-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T10:15:00.000Z",
      event: "step.pending",
      runId: "runalpha01",
      agentId: "feature-dev_developer",
      storyTitle: "Expose logs-tail API",
      detail: "initial poll",
    });
    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T10:16:00.000Z",
      event: "story.done",
      runId: "runalpha01",
      storyTitle: "Expose logs-tail API",
    });

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/logs-tail?offset=0`);
      assert.equal(response.status, 200);

      const payload = await response.json() as LogsTailResponse;
      assert.equal(payload.lines.length, 2);
      assert.ok(payload.nextOffset > 0);

      assert.match(payload.lines[0], /\[runalpha\]/);
      assert.match(payload.lines[0], /developer/);
      assert.match(payload.lines[0], /Step pending/);
      assert.match(payload.lines[0], /— Expose logs-tail API/);
      assert.match(payload.lines[0], /\(initial poll\)/);
      assert.match(payload.lines[1], /Story done/);
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports incremental cursor polling", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-logs-tail-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    appendGlobalEvent(stateDir, {
      ts: "2026-05-01T11:00:00.000Z",
      event: "step.pending",
      runId: "runbeta02",
      detail: "first",
    });

    const { server, baseUrl } = await startDashboard();

    try {
      const initialResponse = await fetch(`${baseUrl}/api/logs-tail?offset=0`);
      assert.equal(initialResponse.status, 200);
      const initialPayload = await initialResponse.json() as LogsTailResponse;
      assert.equal(initialPayload.lines.length, 1);
      assert.match(initialPayload.lines[0], /\(first\)/);

      appendGlobalEvent(stateDir, {
        ts: "2026-05-01T11:01:00.000Z",
        event: "step.running",
        runId: "runbeta02",
        detail: "second",
      });
      appendGlobalEvent(stateDir, {
        ts: "2026-05-01T11:02:00.000Z",
        event: "step.done",
        runId: "runbeta02",
        detail: "third",
      });

      const nextResponse = await fetch(`${baseUrl}/api/logs-tail?offset=${initialPayload.nextOffset}`);
      assert.equal(nextResponse.status, 200);
      const nextPayload = await nextResponse.json() as LogsTailResponse;

      assert.equal(nextPayload.lines.length, 2);
      assert.ok(nextPayload.nextOffset > initialPayload.nextOffset);
      assert.equal(nextPayload.lines.some((line) => line.includes("(first)")), false);
      assert.match(nextPayload.lines[0], /Claimed step/);
      assert.match(nextPayload.lines[0], /\(second\)/);
      assert.match(nextPayload.lines[1], /Step completed/);
      assert.match(nextPayload.lines[1], /\(third\)/);
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard logs-tail UI", () => {
  it("renders logs-tail textbox and cursor polling hook in dashboard HTML", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      assert.match(html, /<section class="section" id="logs-tail-section">/);
      assert.match(html, /<textarea[\s\S]*id="logs-tail-output"[\s\S]*readonly/);
      assert.match(html, /fetch\(`\/api\/logs-tail\?offset=\$\{logsTailOffset\}`\)/);
      assert.match(html, /appendLogsTailLines\(data\.lines \|\| \[\]\)/);
      assert.match(html, /logsTailOffset = data\.nextOffset/);
      assert.match(html, /output\.scrollTop = output\.scrollHeight/);
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard stats API", () => {
  it("GET /api/stats returns systemTokensSpent and totalTokensSpent on fresh DB", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    try {
      // Open DB to trigger migration (creates tamandua_stats with default 0)
      getDb();

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        assert.equal(typeof body.systemTokensSpent, "number");
        assert.equal(typeof body.totalTokensSpent, "number");
        assert.equal(body.systemTokensSpent, 0);
        assert.equal(body.totalTokensSpent, 0);
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/stats totalTokensSpent equals system + run tokens", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    try {
      const db = getDb();

      // Add some run token data
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('run-1', 1, 'wf-1', 'task 1', 'running', 500, '2026-01-01', '2026-01-01')
      `).run();
      db.prepare(`
        INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('run-2', 2, 'wf-2', 'task 2', 'done', 300, '2026-01-01', '2026-01-01')
      `).run();

      // Add system token spend
      incrementSystemTokenSpend(150);

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        assert.equal(body.systemTokensSpent, 150);
        assert.equal(body.totalTokensSpent, 950); // 500 + 300 + 150
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/stats handles DB without tamandua_stats gracefully", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-stats-"));
    const homeDir = path.join(root, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const dbPath = path.join(homeDir, ".tamandua", "tamandua.db");
    const previousHome = process.env.HOME;
    const previousDbPath = process.env.TAMANDUA_DB_PATH;
    process.env.HOME = homeDir;
    process.env.TAMANDUA_DB_PATH = dbPath;

    try {
      // Create a DB with runs table but WITHOUT tamandua_stats (legacy DB)
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import("node:sqlite");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          context TEXT NOT NULL DEFAULT '{}',
          tokens_spent INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      legacyDb.exec(`
        INSERT INTO runs (id, workflow_id, task, status, tokens_spent, created_at, updated_at)
        VALUES ('legacy-run', 'wf-legacy', 'legacy task', 'done', 200, '2025-01-01', '2025-01-01')
      `);
      legacyDb.close();

      const { server, baseUrl } = await startDashboard();

      try {
        const response = await fetch(`${baseUrl}/api/stats`);
        assert.equal(response.status, 200);

        const body = await response.json() as { systemTokensSpent: number; totalTokensSpent: number };
        // getSystemTokenSpend returns 0 when the table doesn't exist
        assert.equal(body.systemTokensSpent, 0);
        // total = system(0) + sum of run tokens(200)
        assert.equal(body.totalTokensSpent, 200);
      } finally {
        await stopDashboard(server);
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dashboard token counters UI", () => {
  it("renders system and total token spend counters in dashboard HTML", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // Token counter container
      assert.match(html, /<div class="token-counters" id="token-counters">/);
      // System token span
      assert.match(html, /<span class="mono" id="system-tokens">/);
      // Total token span
      assert.match(html, /<span class="mono" id="total-tokens">/);
      // Default value is 0
      assert.match(html, /<span class="mono" id="system-tokens">0<\/span>/);
      assert.match(html, /<span class="mono" id="total-tokens">0<\/span>/);
      // Separator
      assert.match(html, /<span class="token-sep">\|<\/span>/);
      // System: and Total: labels
      assert.match(html, /System:/);
      assert.match(html, /Total:/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("dashboard HTML includes fetchStats call in refreshAll", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // fetchStats function exists
      assert.match(html, /async function fetchStats/);
      // fetchStats is called in refreshAll
      assert.match(html, /fetchStats\(\)/);
      // fetch is called with /api/stats
      assert.match(html, /fetch\(["']\/api\/stats["']\)/);
      // comma format function
      assert.match(html, /function fmtNum/);
      // toLocaleString for number formatting
      assert.match(html, /\.toLocaleString\(\)/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("token counters are positioned near top in header area", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();
      // Token counters should be inside the header
      const headerIndex = html.indexOf("<header>");
      const headerCloseIndex = html.indexOf("</header>");
      assert.ok(headerIndex >= 0, "header tag not found");
      assert.ok(headerCloseIndex > headerIndex, "header close tag not found");

      const tokenCountersIndex = html.indexOf('class="token-counters"');
      assert.ok(tokenCountersIndex > headerIndex, "token counters not inside header");
      assert.ok(tokenCountersIndex < headerCloseIndex, "token counters not inside header");
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard pause/resume UI", () => {
  it("renders pause/resume controls bar with buttons and drain checkbox", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /class="controls-bar"/);
      assert.match(html, /Pause All/);
      assert.match(html, /Pause All \(Drain\)/);
      assert.match(html, /Resume All/);
      assert.match(html, /id="drain-checkbox"/);
      assert.match(html, /type="checkbox"/);
      assert.match(html, /id="pause-feedback"/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("includes pauseRun and resumeRun JS functions", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /async function pauseRun\(/);
      assert.match(html, /async function resumeRun\(/);
      assert.match(html, /function handlePause\(/);
      assert.match(html, /function handleResume\(/);
      assert.match(html, /async function pauseAllRuns\(/);
      assert.match(html, /async function resumeAllRuns\(/);
      assert.match(html, /\/api\/runs\/.*\/pause/);
      assert.match(html, /\/api\/runs\/.*\/resume/);
      assert.match(html, /pauseRun\(id, drain\)\.then\(refreshAll\)/);
      assert.match(html, /resumeRun\(id\)\.then\(refreshAll\)/);
      assert.match(html, /\?drain=true/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("has badge-paused CSS class with amber color", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /\.badge-paused/);
      assert.match(html, /#d29922/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("renders Actions column in runs table header", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /<th>Actions<\/th>/);
      assert.match(html, /\.action-btn\.pause-btn/);
      assert.match(html, /\.action-btn\.resume-btn/);
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard MCP status API", () => {
  it("GET /api/mcp-status returns { running, port, path }", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/mcp-status`);
      assert.equal(response.status, 200);

      const body = await response.json() as { running: boolean; port: number; path: string };
      assert.equal(typeof body.running, "boolean");
      assert.equal(body.port, DEFAULT_MCP_PORT);
      assert.equal(body.path, "/mcp");
    } finally {
      await stopDashboard(server);
    }
  });
});

describe("dashboard version status API", () => {
  it("GET /api/version-status returns { updateAvailable, currentHead, remoteHead, checkedAt } when no file exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-version-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/version-status`);
      assert.equal(response.status, 200);

      const body = await response.json() as { updateAvailable: boolean; currentHead: string; remoteHead: string; checkedAt: string };
      assert.equal(body.updateAvailable, false);
      assert.equal(body.currentHead, "");
      assert.equal(body.remoteHead, "");
      assert.equal(body.checkedAt, "");
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/version-status returns updateAvailable: true when file says so", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-version-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    // Write version-status.json with updateAvailable: true
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "version-status.json"),
      JSON.stringify({
        updateAvailable: true,
        currentHead: "abc1234",
        remoteHead: "def5678",
        checkedAt: "2026-05-15T10:00:00.000Z",
      }),
      "utf-8",
    );

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/version-status`);
      assert.equal(response.status, 200);

      const body = await response.json() as { updateAvailable: boolean; currentHead: string; remoteHead: string; checkedAt: string };
      assert.equal(body.updateAvailable, true);
      assert.equal(body.currentHead, "abc1234");
      assert.equal(body.remoteHead, "def5678");
      assert.equal(body.checkedAt, "2026-05-15T10:00:00.000Z");
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GET /api/version-status returns updateAvailable: false when file says so", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-version-"));
    const stateDir = path.join(root, "state");
    const previousStateDir = process.env.TAMANDUA_STATE_DIR;
    process.env.TAMANDUA_STATE_DIR = stateDir;

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "version-status.json"),
      JSON.stringify({
        updateAvailable: false,
        currentHead: "abc1234",
        remoteHead: "abc1234",
        checkedAt: "2026-05-15T10:00:00.000Z",
      }),
      "utf-8",
    );

    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/api/version-status`);
      assert.equal(response.status, 200);

      const body = await response.json() as { updateAvailable: boolean };
      assert.equal(body.updateAvailable, false);
    } finally {
      await stopDashboard(server);
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("dashboard HTML contains version banner element with yellow background", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Banner div exists with correct id and hidden by default
      assert.match(html, /id="version-banner"/);
      assert.match(html, /#version-banner \{[\s\S]*display:\s*none/);

      // Yellow background
      assert.match(html, /#ffd700/);

      // Banner text tells user to run tamandua update
      assert.match(html, /A new version of tamandua is available!/);
      assert.match(html, /tamandua update/);

      // Dismiss button
      assert.match(html, /class="banner-dismiss"/);
      assert.match(html, /✕/);
      assert.match(html, /function dismissVersionBanner/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("version banner is positioned between header and container", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      const headerCloseIndex = html.indexOf("</header>");
      const bannerIndex = html.indexOf('id="version-banner"');
      const containerIndex = html.indexOf('class="container"');

      assert.ok(headerCloseIndex >= 0, "</header> not found");
      assert.ok(bannerIndex >= 0, "version-banner not found");
      assert.ok(containerIndex >= 0, "container not found");
      assert.ok(bannerIndex > headerCloseIndex, "banner must be after </header>");
      assert.ok(bannerIndex < containerIndex, "banner must be before container");
    } finally {
      await stopDashboard(server);
    }
  });

  it("dashboard HTML includes fetchVersionStatus and calls it in refreshAll", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // fetchVersionStatus function exists
      assert.match(html, /async function fetchVersionStatus/);
      // Calls /api/version-status
      assert.match(html, /fetch\(["']\/api\/version-status["']\)/);
      // Called in refreshAll
      assert.match(html, /fetchVersionStatus\(\)/);
      // Checks updateAvailable
      assert.match(html, /data\.updateAvailable/);
      // Shows banner on true
      assert.match(html, /banner\.style\.display\s*=\s*["']block["']/);
      // Hides banner on false
      assert.match(html, /banner\.style\.display\s*=\s*["']none["']/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("dismissVersionBanner hides the banner via display:none", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // dismissVersionBanner function sets display:none
      assert.match(html, /function dismissVersionBanner/);
      assert.match(html, /banner\.style\.display\s*=\s*["']none["']/);
    } finally {
      await stopDashboard(server);
    }
  });
});
