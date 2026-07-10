    const STATUS_CLASS = {
      running: "badge-running",
      completed: "badge-completed",
      failed: "badge-failed",
      canceled: "badge-canceled",
      paused: "badge-paused",
      blocked: "badge-blocked",
    };

    let logsTailOffset = 0;
    let logsTailGeneration = 0;
    let latestRuns = [];
    let selectedAutoresearchSessionId = null;

    async function fetchMcpStatus() {
      try {
        const res = await fetch("/api/mcp-status");
        const data = await res.json();
        renderMcpStatus(data);
      } catch (err) {
        console.error("Failed to fetch MCP status:", err);
        var el = document.getElementById("popover-mcp-status");
        if (el) el.innerHTML = '<span style="color:var(--red)">Unable to fetch MCP status</span>';
      }
    }

    function renderMcpStatus(data) {
      var el = document.getElementById("popover-mcp-status");
      if (!el) return;
      var running = data.running;
      var statusDot = running
        ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);margin-right:6px;"></span>'
        : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red);margin-right:6px;"></span>';
      var statusText = running ? "Running" : "Stopped";
      var statusColor = running ? "var(--green)" : "var(--red)";
      el.innerHTML = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
        '<span>' + statusDot + '</span>' +
        '<span style="color:' + statusColor + ';font-weight:600;">' + statusText + '</span>' +
        '<span>Port: <span class="mono">' + esc(String(data.port)) + '</span></span>' +
        '</div>';
    }

    let currentPage = 1;
    let currentStatus = "all";
    let totalPages = 1;

    async function fetchRuns() {
      try {
        var params = new URLSearchParams({ page: currentPage, status: currentStatus });
        const res = await fetch("/api/runs?" + params.toString());
        const data = await res.json();
        latestRuns = data.runs || [];
        totalPages = data.totalPages || 1;
        currentPage = data.page || 1;
        renderRuns(latestRuns);
        renderPagination();
        document.getElementById("status-dot").classList.remove("error");
      } catch (err) {
        document.getElementById("status-dot").classList.add("error");
        console.error("Failed to fetch runs:", err);
        document.getElementById("runs-content").innerHTML =
          '<div class="error-state">Unable to fetch runs.<br><button class="retry-btn" data-action="retry-runs">Retry</button></div>';
      }
    }

    function renderPagination() {
      var el = document.getElementById("pagination");
      if (totalPages <= 1) { el.innerHTML = ""; return; }
      el.innerHTML =
        '<button ' + (currentPage <= 1 ? 'disabled' : '') + ' data-action="page-prev">← Prev</button>' +
        '<span class="page-info">Page ' + currentPage + ' of ' + totalPages + '</span>' +
        '<button ' + (currentPage >= totalPages ? 'disabled' : '') + ' data-action="page-next">Next →</button>';
    }

    document.addEventListener("click", function(e) {
      if (e.target.getAttribute("data-action") === "page-prev") {
        if (currentPage > 1) { currentPage--; fetchRuns(); }
      }
      if (e.target.getAttribute("data-action") === "page-next") {
        if (currentPage < totalPages) { currentPage++; fetchRuns(); }
      }
    });

    var statusFilter = document.getElementById("status-filter");
    if (statusFilter) {
      statusFilter.addEventListener("change", function() {
        currentStatus = this.value;
        currentPage = 1;
        fetchRuns();
      });
    }

    async function fetchAutoresearchSessions() {
      try {
        const res = await fetch("/api/autoresearch/sessions");
        const data = await res.json();
        updateAutoresearchSessionSelector(data.sessions || []);
        if (selectedAutoresearchSessionId) fetchAutoresearchProgress();
      } catch (err) {
        console.error("Failed to fetch autoresearch sessions:", err);
      }
    }

    async function fetchEvents() {
      try {
        const res = await fetch("/api/events?limit=40");
        const data = await res.json();
        renderEvents(data.events || []);
      } catch (err) {
        console.error("Failed to fetch events:", err);
        document.getElementById("events-content").innerHTML =
          '<div class="error-state">Unable to fetch events.<br><button class="retry-btn" data-action="retry-events">Retry</button></div>';
      }
    }

    async function fetchLogsTail() {
      try {
        const res = await fetch(`/api/logs-tail?offset=${logsTailOffset}&generation=${logsTailGeneration}`);
        const data = await res.json();
        appendLogsTailLines(data.lines || []);
        if (Number.isFinite(data.nextOffset)) {
          logsTailOffset = data.nextOffset;
        }
        if (Number.isFinite(data.generation)) {
          logsTailGeneration = data.generation;
        }
      } catch (err) {
        console.error("Failed to fetch logs-tail:", err);
      }
    }

    function renderRuns(runs) {
      const el = document.getElementById("runs-content");
      if (!runs.length) {
        el.innerHTML = '<div class="empty-state">No runs yet. Start a workflow to see it here.</div>';
        return;
      }

      const rows = runs.map(r => {
        const total = Number(r.total_steps) || 0;
        const done = Number(r.completed_steps) || 0;
        const failed = Number(r.failed_steps) || 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const fillClass = r.status;
        const badgeClass = STATUS_CLASS[r.status] || "badge-running";
        const task = (r.task || "").slice(0, 80);
        const parsedTokens = Number(r.tokens_spent);
        const tokensSpent = Number.isFinite(parsedTokens) ? parsedTokens : 0;
        const cost = Number(r.cost);
        const costDisplay = Number.isFinite(cost) && cost > 0 ? '$' + cost.toFixed(2) : (Number.isFinite(cost) ? '$0.00' : '—');

        return `<tr>
          <td class="num" data-label="#">#${r.run_number ?? "-"}</td>
          <td data-label="Run ID"><a class="mono run-link" href="/runs/${encodeURIComponent(r.id)}/kanban" title="Open kanban view">${esc(r.id).slice(0, 8)}</a></td>
          <td data-label="Workflow">${esc(r.workflow_id)}</td>
          <td class="truncate" data-label="Task" title="${esc(r.task || "")}">${esc(task)}</td>
          <td data-label="Status"><span class="badge ${badgeClass}">${r.status}</span></td>
          <td data-label="Progress">
            <div class="progress-bar" title="${done}/${total} steps (${failed} failed)">
              <div class="progress-fill ${fillClass}" style="width:${pct}%"></div>
            </div>
          </td>
          <td class="num" data-label="Tokens">${fmtNum(tokensSpent)}</td>
          <td class="num" data-label="Cost" style="font-variant-numeric:tabular-nums">${costDisplay}</td>
          <td class="num" data-label="Updated" style="font-size:11px">${timeAgo(r.updated_at)}</td>
          <td class="actions" data-label="Actions">
            ${r.status === 'running' ? `<button class="action-btn pause-btn" data-action="pause" data-run-id="${r.id}">Pause</button>` : ''}
            ${r.status === 'paused' ? `<button class="action-btn resume-btn" data-action="resume" data-run-id="${r.id}">Resume</button> <button class="action-btn cancel-btn" data-action="cancel" data-run-id="${r.id}">Cancel</button>` : ''}
            ${(r.status === 'failed' || r.status === 'canceled') ? `<button class="action-btn relaunch-btn" data-action="relaunch" data-run-id="${r.id}">Relaunch</button>` : ''}
            <button class="action-btn delete-btn" data-action="delete" data-run-id="${r.id}" data-status="${esc(r.status)}" title="Delete this run">Delete</button>
          </td>
          <td data-label="View"><a class="kanban-link" href="/runs/${encodeURIComponent(r.id)}/kanban" aria-label="Open kanban for run ${esc(r.id)}">Kanban &rarr;</a></td>
        </tr>`;
      }).join("");

      el.innerHTML = `<table class="runs-table">
        <thead><tr>
          <th>#</th><th>Run ID</th><th>Workflow</th><th>Task</th><th>Status</th><th>Progress</th><th>Tokens</th><th>Cost</th><th>Updated</th><th>Actions</th><th>View</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    function renderEvents(events) {
      const el = document.getElementById("events-content");
      if (!events.length) {
        el.innerHTML = '<div class="empty-state">No events recorded yet.</div>';
        return;
      }

      const rows = events.map(e => {
        const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : "--";
        const runId = (e.runId || "").slice(0, 8);
        const detail = e.detail || e.stepId || e.agentId || "";
        return `<div class="event-row">
          <span class="event-ts">${ts}</span>
          <span class="event-type">${esc(e.event)}</span>
          <span class="event-detail">${esc(detail)} <span class="num">[${runId}]</span></span>
        </div>`;
      }).join("");

      el.innerHTML = `<div class="events-list">${rows}</div>`;
    }

    function updateAutoresearchSessionSelector(sessions) {
      const select = document.getElementById("autoresearch-session-select");
      if (!select) return;

      const previous = selectedAutoresearchSessionId || select.value;
      const nextValue = sessions.some(s => s.id === previous) ? previous : (sessions[0] ? sessions[0].id : "");

      select.innerHTML = sessions.length
        ? sessions.map(s => {
            const cwdBase = s.cwd.split("/").pop() || s.cwd;
            const metricDisplay = s.best_metric != null
              ? `best ${Number(s.best_metric).toFixed(2)}${s.metric_unit ?? ""}`
              : "no data";
            return `<option value="${esc(s.id)}">${esc(`${cwdBase} · ${s.metric_name || "?"} · ${metricDisplay}`)}</option>`;
          }).join("")
        : '<option value="">No AutoResearch sessions found</option>';
      select.value = nextValue;
      selectedAutoresearchSessionId = nextValue || null;
      select.onchange = () => {
        selectedAutoresearchSessionId = select.value || null;
        fetchAutoresearchProgress();
      };
    }

    async function fetchAutoresearchProgress() {
      const sessionId = selectedAutoresearchSessionId || document.getElementById("autoresearch-session-select")?.value;
      const feedback = document.getElementById("autoresearch-feedback");
      if (!sessionId) {
        document.getElementById("autoresearch-content").innerHTML =
          '<div class="empty-state">No AutoResearch sessions found</div>';
        return;
      }

      try {
        if (feedback) feedback.textContent = "Loading...";
        const res = await fetch(`/api/autoresearch/sessions/${encodeURIComponent(sessionId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Failed to load AutoResearch (${res.status})`);
        renderAutoresearchProgress(data);
        if (feedback) feedback.textContent = "";
      } catch (err) {
        if (feedback) feedback.textContent = "";
        document.getElementById("autoresearch-content").innerHTML =
          `<div class="empty-state">Unable to fetch AutoResearch progress: ${esc(err.message)}</div>`;
      }
    }

    function renderAutoresearchProgress(data) {
      const el = document.getElementById("autoresearch-content");
      if (!data.exists) {
        el.innerHTML = `<div class="empty-state">${esc(data.reason || data.summary?.nextPrompt || "No AutoResearch session found.")}</div>`;
        return;
      }

      const summary = data.summary || {};
      const experiments = data.experiments || [];
      const metricLabel = `${summary.metricName || "metric"}${summary.metricUnit ? ` (${summary.metricUnit})` : ""}`;
      const lastExperiment = experiments[experiments.length - 1];
      const confidenceValue = summary.confidence_score === null || summary.confidence_score === undefined
        ? `${summary.confidence_band === "high" ? "high" : "unknown"} (${summary.confidence_sample_count || 0})`
        : `${summary.confidence_band} (${summary.confidence_score === Infinity ? "Infinity" : Number(summary.confidence_score).toFixed(2)})`;

      const kpis = [
        ["Best", summary.bestMetric ?? "(none)"],
        ["Baseline", summary.baselineMetric ?? "(none)"],
        ["Confidence", confidenceValue],
        ["Runs", `${summary.totalRuns ?? 0}`],
        ["Kept", `${summary.keptRuns ?? 0}`],
        ["Failures", `${(summary.crashedRuns ?? 0) + (summary.metricNotFoundRuns ?? 0) + (summary.checksFailedRuns ?? 0)}`],
      ].map(([label, value]) => `<div class="autoresearch-kpi"><div class="label">${esc(label)}</div><div class="value mono">${esc(String(value))}</div></div>`).join("");

      const chart = renderAutoresearchTraceChart(experiments, summary, metricLabel);

      const rows = experiments.slice(-10).reverse().map(e => {
        const badgeClass = e.status === "discard" ? "badge-paused" : (e.status === "crash" || e.status === "checks_failed" || e.status === "metric_not_found" ? "badge-failed" : "badge-completed");
        return `<tr>
          <td class="num">#${e.run}</td>
          <td><span class="badge ${badgeClass}">${esc(e.status)}</span></td>
          <td class="num">${e.metric === null || e.metric === undefined ? "-" : esc(String(e.metric))}</td>
          <td>
            <div>${esc(e.description || "")}</div>
            ${e.confidence_score !== null && e.confidence_score !== undefined ? `<div class="autoresearch-detail">Confidence: ${esc(e.confidence_band || "unknown")} (${esc(e.confidence_score === Infinity ? "Infinity" : Number(e.confidence_score).toFixed(2))})</div>` : (e.confidence_band === "high" ? `<div class="autoresearch-detail">Confidence: high</div>` : "")}
            ${e.learned ? `<div class="autoresearch-detail">Learned: ${esc(e.learned)}</div>` : ""}
            ${e.next_focus ? `<div class="autoresearch-detail">Next: ${esc(e.next_focus)}</div>` : ""}
          </td>
          <td class="num">${e.duration_ms ? `${Math.round(e.duration_ms / 1000)}s` : "-"}</td>
        </tr>`;
      }).join("");

      el.innerHTML = `
        <div class="autoresearch-detail" style="margin-bottom:8px">
          <strong style="color:#e6edf3">Goal:</strong> ${esc(summary.goal || "")}
          <span class="mono"> ${esc(metricLabel)} ${esc(summary.direction || "")}</span>
        </div>
        <div class="autoresearch-grid">${kpis}</div>
        <div class="autoresearch-chart" id="autoresearch-metric-chart">${chart}</div>
        <div class="autoresearch-detail" style="margin-bottom:10px">
          ${lastExperiment?.next_focus ? `Next focus: ${esc(lastExperiment.next_focus)}` : esc(summary.nextPrompt || "")}
        </div>
        <table id="autoresearch-timeline">
          <thead><tr><th>Run</th><th>Status</th><th>${esc(metricLabel)}</th><th>Learning</th><th>Time</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5"><div class="empty-state">No logged experiments yet.</div></td></tr>'}</tbody>
        </table>
      `;
    }

    function renderAutoresearchTraceChart(experiments, summary, metricLabel) {
      const points = experiments
        .map(e => ({ ...e, metricValue: Number(e.metric) }))
        .filter(e => Number.isFinite(e.metricValue))
        .sort((a, b) => Number(a.run) - Number(b.run));

      if (!points.length) {
        return '<div class="empty-state" style="padding:24px;color:#57606a">No numeric metrics yet.</div>';
      }

      const kept = [];
      let best = null;
      const lowerIsBetter = summary.direction === "lower";
      for (const point of points) {
        const improves = best === null || (lowerIsBetter ? point.metricValue < best : point.metricValue > best);
        if (improves) {
          kept.push(point);
          best = point.metricValue;
        }
      }

      const width = 900;
      const height = 430;
      const margin = { top: 54, right: 34, bottom: 62, left: 78 };
      const plotW = width - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;
      const values = points.map(p => p.metricValue);
      const rawMin = Math.min(...values);
      const rawMax = Math.max(...values);
      const padding = rawMin === rawMax ? Math.max(Math.abs(rawMin) * 0.02, 0.001) : (rawMax - rawMin) * 0.08;
      const yMin = rawMin - padding;
      const yMax = rawMax + padding;
      const xMin = points.length === 1 ? points[0].run - 0.5 : Math.min(...points.map(p => Number(p.run)));
      const xMax = points.length === 1 ? points[0].run + 0.5 : Math.max(...points.map(p => Number(p.run)));
      const xScale = (run) => margin.left + ((Number(run) - xMin) / Math.max(1, xMax - xMin)) * plotW;
      const yScale = (metric) => margin.top + ((yMax - Number(metric)) / Math.max(0.000001, yMax - yMin)) * plotH;
      const fmtMetric = (value) => Math.abs(value) >= 10 ? value.toFixed(2) : value.toFixed(3);
      const keptRuns = new Set(kept.map(p => Number(p.run)));
      const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i / 4));
      const xTickCount = Math.min(8, points.length);
      const xTicks = Array.from(new Set(Array.from({ length: xTickCount }, (_, i) => {
        const run = xMin + ((xMax - xMin) * i / Math.max(1, xTickCount - 1));
        return Math.round(run);
      }).filter(run => points.some(p => Number(p.run) === run))));
      const linePoints = kept.map(p => `${xScale(p.run).toFixed(1)},${yScale(p.metricValue).toFixed(1)}`).join(" ");
      const title = `Autoresearch Progress: ${points.length} Experiments, ${kept.length} Kept Improvements`;
      const directionText = lowerIsBetter ? "lower is better" : "higher is better";

      const grid = yTicks.map(t => {
        const y = yScale(t);
        return `<line class="autoresearch-chart-grid" x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}"></line>
          <text class="autoresearch-chart-tick" x="${margin.left - 10}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmtMetric(t))}</text>`;
      }).join("");
      const xGrid = xTicks.map(t => {
        const x = xScale(t);
        return `<line class="autoresearch-chart-grid" x1="${x.toFixed(1)}" y1="${margin.top}" x2="${x.toFixed(1)}" y2="${height - margin.bottom}"></line>
          <text class="autoresearch-chart-tick" x="${x.toFixed(1)}" y="${height - margin.bottom + 18}" text-anchor="middle">${esc(String(t))}</text>`;
      }).join("");
      const discardedDots = points.filter(p => !keptRuns.has(Number(p.run))).map(p =>
        `<circle class="autoresearch-chart-discarded" cx="${xScale(p.run).toFixed(1)}" cy="${yScale(p.metricValue).toFixed(1)}" r="4.5">
          <title>Experiment ${esc(String(p.run))}: ${esc(fmtMetric(p.metricValue))} - ${esc(p.description || "discarded")}</title>
        </circle>`
      ).join("");
      const keptDots = kept.map(p =>
        `<circle class="autoresearch-chart-kept" cx="${xScale(p.run).toFixed(1)}" cy="${yScale(p.metricValue).toFixed(1)}" r="6">
          <title>Kept experiment ${esc(String(p.run))}: ${esc(fmtMetric(p.metricValue))} - ${esc(p.description || "new best")}</title>
        </circle>`
      ).join("");

      return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
        <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"></rect>
        <text class="autoresearch-chart-title" x="${width / 2}" y="27">${esc(title)}</text>
        ${grid}
        ${xGrid}
        <line class="autoresearch-chart-axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"></line>
        <line class="autoresearch-chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}"></line>
        ${linePoints ? `<polyline class="autoresearch-chart-line" points="${linePoints}"></polyline>` : ""}
        ${discardedDots}
        ${keptDots}
        <text class="autoresearch-chart-label" x="${width / 2}" y="${height - 18}" text-anchor="middle">Experiment</text>
        <text class="autoresearch-chart-label" transform="translate(20 ${height / 2}) rotate(-90)" text-anchor="middle">${esc(metricLabel)} (${directionText})</text>
        <circle class="autoresearch-chart-kept" cx="${width - 210}" cy="58" r="5"></circle>
        <text class="autoresearch-chart-legend" x="${width - 198}" y="62">Kept improvements</text>
        <circle class="autoresearch-chart-discarded" cx="${width - 90}" cy="58" r="5"></circle>
        <text class="autoresearch-chart-legend" x="${width - 78}" y="62">Discarded</text>
      </svg>`;
    }

    function appendLogsTailLines(lines) {
      if (!lines.length) return;
      const output = document.getElementById("logs-tail-output");
      if (!output) return;

      const chunk = lines.join("\n");
      output.value = output.value ? `${output.value}\n${chunk}` : chunk;
      output.scrollTop = output.scrollHeight;
    }

    async function fetchStats() {
      try {
        const res = await fetch("/api/stats");
        const data = await res.json();
        const systemEl = document.getElementById("system-tokens");
        const totalEl = document.getElementById("total-tokens");
        const promptEl = document.getElementById("prompt-tokens");
        const completionEl = document.getElementById("completion-tokens");
        const cachedEl = document.getElementById("cached-tokens");
        const costEl = document.getElementById("total-cost");
        if (systemEl) systemEl.textContent = fmtNum(data.systemTokensSpent ?? 0);
        if (totalEl) totalEl.textContent = fmtNum(data.totalTokensSpent ?? 0);
        if (promptEl) promptEl.textContent = fmtNum(data.promptTokens ?? 0);
        if (completionEl) completionEl.textContent = fmtNum(data.completionTokens ?? 0);
        if (cachedEl) cachedEl.textContent = fmtNum(data.cachedTokens ?? 0);
        if (costEl) costEl.textContent = '$' + (data.totalCost ?? 0).toFixed(2);
        document.getElementById("status-dot").classList.remove("error");
      } catch (err) {
        document.getElementById("status-dot").classList.add("error");
        console.error("Failed to fetch stats:", err);
      }
    }

    function dismissVersionBanner() {
      const banner = document.getElementById("version-banner");
      if (banner) banner.style.display = "none";
    }

    async function fetchBuildVersion() {
      try {
        const res = await fetch("/api/version");
        const data = await res.json();
        const el = document.getElementById("build-version");
        if (el) el.textContent = data.version || "unknown";
      } catch (err) {
        console.error("Failed to fetch build version:", err);
      }
    }

    async function fetchVersionStatus() {
      try {
        const res = await fetch("/api/version-status");
        const data = await res.json();
        const banner = document.getElementById("version-banner");
        if (!banner) return;
        if (data.updateAvailable) {
          banner.style.display = "block";
        } else {
          banner.style.display = "none";
        }
      } catch (err) {
        console.error("Failed to fetch version status:", err);
      }
    }

    function fmtNum(n) {
      if (!Number.isFinite(n)) return "0";
      if (n >= 1e12) return (n / 1e12).toFixed(1) + "T";
      if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }

    function refreshAll() {
      const dot = document.getElementById("status-dot");
      if (dot) dot.classList.add("refreshing");
      Promise.allSettled([
        fetchMcpStatus(),
        fetchRuns(),
        fetchAutoresearchSessions(),
        fetchEvents(),
        fetchLogsTail(),
        fetchStats(),
        fetchBuildVersion(),
        fetchVersionStatus(),
      ]).finally(() => {
        if (dot) dot.classList.remove("refreshing");
        document.getElementById("last-update").textContent = new Date().toLocaleTimeString();
      });
    }

    function esc(s) {
      if (!s) return "";
      const div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function showToast(message, type) {
      const container = document.getElementById("toast-container");
      if (!container) return;
      const toast = document.createElement("div");
      toast.className = "toast " + (type || "info");
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => {
        toast.classList.add("removing");
        toast.addEventListener("animationend", () => toast.remove(), { once: true });
      }, 4000);
    }

    function timeAgo(iso) {
      if (!iso) return "--";
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.floor(hrs / 24)}d ago`;
    }

    async function pauseRun(id, drain) {
      const qs = drain ? '?drain=true' : '';
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/pause${qs}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to pause (${res.status})`);
      }
    }

    async function resumeRun(id) {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to resume (${res.status})`);
      }
    }

    function handlePause(id) {
      const drain = document.getElementById('drain-checkbox')?.checked || false;
      pauseRun(id, drain).then(() => { refreshAll(); showToast('Run paused', 'success'); }).catch(e => showToast('Pause failed: ' + e.message, 'error'));
    }

    function handleResume(id) {
      resumeRun(id).then(() => { refreshAll(); showToast('Run resumed', 'success'); }).catch(e => showToast('Resume failed: ' + e.message, 'error'));
    }

    async function cancelRun(id) {
      const res = await fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to cancel (${res.status})`);
      }
    }

    function handleCancel(id) {
      cancelRun(id).then(() => { refreshAll(); showToast('Run canceled', 'success'); }).catch(e => showToast('Cancel failed: ' + e.message, 'error'));
    }

    async function pauseAllRuns(drain) {
      const el = document.getElementById('pause-feedback');
      if (!el) return;
      try {
        el.textContent = 'Pausing...';
        const res = await fetch('/api/runs');
        const data = await res.json();
        const runningRuns = (data.runs || []).filter(r => r.status === 'running');
        if (!runningRuns.length) {
          el.textContent = 'No running runs to pause.';
          return;
        }
        let ok = 0;
        for (const r of runningRuns) {
          try { await pauseRun(r.id, drain); ok++; }
          catch (e) { console.error('Failed to pause run ' + r.id, e); }
        }
        el.textContent = `Paused ${ok}/${runningRuns.length} run(s).`;
      } catch (e) {
        el.textContent = 'Error: ' + e.message;
      } finally {
        setTimeout(() => { if (el) el.textContent = ''; }, 4000);
        refreshAll();
      }
    }

    async function resumeAllRuns() {
      const el = document.getElementById('pause-feedback');
      if (!el) return;
      try {
        el.textContent = 'Resuming...';
        const res = await fetch('/api/runs');
        const data = await res.json();
        const pausedRuns = (data.runs || []).filter(r => r.status === 'paused');
        if (!pausedRuns.length) {
          el.textContent = 'No paused runs to resume.';
          return;
        }
        let ok = 0;
        for (const r of pausedRuns) {
          try { await resumeRun(r.id); ok++; }
          catch (e) { console.error('Failed to resume run ' + r.id, e); }
        }
        el.textContent = `Resumed ${ok}/${pausedRuns.length} run(s).`;
      } catch (e) {
        el.textContent = 'Error: ' + e.message;
      } finally {
        setTimeout(() => { if (el) el.textContent = ''; }, 4000);
        refreshAll();
      }
    }

    // ── Delete Modal Functions ──────────────────────────────────────

    let deleteRunId = null;
    let deleteRunActive = false;

    function openDeleteModal(runId, status) {
      deleteRunId = runId;
      deleteRunActive = status === 'running' || status === 'paused';
      document.getElementById('delete-run-id-display').value = runId;
      document.getElementById('delete-status-display').value = status;
      document.getElementById('delete-active-warning').style.display = deleteRunActive ? 'block' : 'none';
      document.getElementById('delete-modal-overlay').classList.add('active');
    }

    function closeDeleteModal() {
      document.getElementById('delete-modal-overlay').classList.remove('active');
      deleteRunId = null;
      deleteRunActive = false;
    }

    async function handleDeleteSubmit() {
      if (!deleteRunId) return;
      const submitBtn = document.getElementById('delete-submit-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Deleting...';
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(deleteRunId)}${deleteRunActive ? '?force=true' : ''}`, {
          method: 'DELETE'
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Delete failed (${res.status})`);
        }
        closeDeleteModal();
        refreshAll();
      } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Delete Permanently';
      }
    }

    // ── Relaunch Modal Functions ────────────────────────────────────

    let relaunchRunId = null;

    async function openRelaunchModal(runId) {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
        if (!res.ok) throw new Error(`Failed to load run detail (${res.status})`);
        const data = await res.json();

        relaunchRunId = runId;
        document.getElementById('relaunch-failure-reason').value = data.failure_reason || 'Unknown';
        document.getElementById('relaunch-prompt').value = data.prompt || '';
        document.getElementById('relaunch-modal-overlay').classList.add('active');
      } catch (err) {
        showToast('Failed to open relaunch dialog: ' + err.message, 'error');
      }
    }

    function closeRelaunchModal() {
      document.getElementById('relaunch-modal-overlay').classList.remove('active');
      relaunchRunId = null;
    }

    async function handleRelaunchSubmit() {
      if (!relaunchRunId) return;
      const submitBtn = document.getElementById('relaunch-submit-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Launching...';
      try {
        const prompt = document.getElementById('relaunch-prompt').value.trim();
        const res = await fetch(`/api/runs/${encodeURIComponent(relaunchRunId)}/relaunch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: prompt || undefined })
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Relaunch failed (${res.status})`);
        }
        closeRelaunchModal();
        refreshAll();
      } catch (err) {
        showToast('Relaunch failed: ' + err.message, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Relaunch';
      }
    }

    document.addEventListener("click", function (e) {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const runId = btn.getAttribute("data-run-id");
      switch (action) {
        case "dismiss-version-banner": dismissVersionBanner(); break;
        case "pause-all": pauseAllRuns(btn.getAttribute("data-drain") === "true"); break;
        case "resume-all": resumeAllRuns(); break;
        case "refresh-autoresearch": fetchAutoresearchProgress(); break;
        case "close-delete-modal": closeDeleteModal(); break;
        case "delete-submit": handleDeleteSubmit(); break;
        case "close-relaunch-modal": closeRelaunchModal(); break;
        case "relaunch-submit": handleRelaunchSubmit(); break;
        case "pause": handlePause(runId); break;
        case "resume": handleResume(runId); break;
        case "cancel": handleCancel(runId); break;
        case "relaunch": openRelaunchModal(runId); break;
        case "delete": openDeleteModal(runId, btn.getAttribute("data-status")); break;
        case "retry-runs": fetchRuns(); break;
        case "retry-events": fetchEvents(); break;
      }
    });

    // Initial load
    refreshAll();

    // Auto-refresh every 10 seconds
    setInterval(refreshAll, 10000);
