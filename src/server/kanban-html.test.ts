import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createDashboardServer } from "../../dist/server/dashboard.js";

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

describe("kanban poll toggle HTML", () => {
  it("contains poll toggle checkbox with default checked state", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Checkbox element exists with id poll-toggle
      assert.match(html, /id="poll-toggle"/);
      // Checkbox is checked by default
      assert.match(html, /<input[^>]*type="checkbox"[^>]*checked/);
      // Checkbox is inside footer-right
      const footerRightStart = html.indexOf('id="footer-right"');
      const pollToggleStart = html.indexOf('id="poll-toggle"');
      assert.ok(pollToggleStart > footerRightStart, "poll toggle not inside footer-right");
    } finally {
      await stopDashboard(server);
    }
  });

  it("contains poll label span inside footer-right", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Poll label span exists
      assert.match(html, /id="poll-label"/);
      // Default text is "poll 3s"
      assert.match(html, /poll 3s/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("contains setInterval/clearInterval toggle logic", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const jsRes = await fetch(`${baseUrl}/kanban-ui.js`);
      const js = await jsRes.text();

      // startPolling function exists and calls setInterval
      assert.match(js, /function startPolling/);
      assert.match(js, /pollInterval = setInterval\(tick, REFRESH_MS\)/);
      // stopPolling function exists and calls clearInterval
      assert.match(js, /function stopPolling/);
      assert.match(js, /clearInterval\(pollInterval\)/);
      // updatePollLabel function exists
      assert.match(js, /function updatePollLabel/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("REFRESH_MS constant is unchanged at 3000", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const jsRes = await fetch(`${baseUrl}/kanban-ui.js`);
      const js = await jsRes.text();

      assert.match(js, /var REFRESH_MS = 3000;/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("checkbox change event listener calls startPolling and stopPolling", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const jsRes = await fetch(`${baseUrl}/kanban-ui.js`);
      const js = await jsRes.text();

      // Event listener for checkbox change
      assert.match(js, /addEventListener\("change"/);
      // startPolling called when checked
      assert.match(js, /if \(chk\.checked\)/);
      assert.match(js, /startPolling\(\)/);
      // stopPolling called when unchecked
      assert.match(js, /stopPolling\(\)/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("footer-right contains poll toggle label structure", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // footer-right span exists
      assert.match(html, /id="footer-right"/);
      // Contains a label element wrapping the checkbox and text
      assert.match(html, /<label>/);
      // The poll label and checkbox are inside the same footer-right area
      const footerRightStart = html.indexOf('id="footer-right"');
      const footerRightEnd = html.indexOf("</footer>", footerRightStart);
      const footerRightContent = html.slice(footerRightStart, footerRightEnd);

      assert.match(footerRightContent, /id="poll-toggle"/);
      assert.match(footerRightContent, /id="poll-label"/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("poll label text updates for paused state", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const jsRes = await fetch(`${baseUrl}/kanban-ui.js`);
      const js = await jsRes.text();

      // updatePollLabel sets "poll paused" when unchecked
      assert.match(js, /"poll paused"/);
      // and "poll " + seconds when checked
      assert.match(js, /"poll " \+ \(REFRESH_MS \/ 1000\) \+ "s"/);
    } finally {
      await stopDashboard(server);
    }
  });
});
