(function () {
  var MODEL_PRICING = {
    "deepseek-v4-pro-official": { input: 0.43, output: 0.87, cache: 0.043 },
    "glm-5.2-tencent": { input: 1.05, output: 3.30, cache: 0.105 },
    "kimi-k2.6": { input: 1.20, output: 4.50, cache: 0.12 },
  };
  var DEFAULT_MODEL = "deepseek-v4-pro-official";

  function calcCost(model, prompt, completion, cached) {
    var p = MODEL_PRICING[model] || MODEL_PRICING[DEFAULT_MODEL];
    return (prompt / 1e6) * p.input + (completion / 1e6) * p.output + (cached / 1e6) * p.cache;
  }

  var REFRESH_MS = 3000;
  const runId = window.location.pathname.split("/")[2];

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtElapsed(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return h + "h " + String(m).padStart(2, "0") + "m";
    if (m) return m + "m " + String(s).padStart(2, "0") + "s";
    return s + "s";
  }

  function fmtTokens(n) {
    if (n == null) return "—";
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(v);
  }

  function parseTimestamp(ts) {
    if (!ts) return NaN;
    // canarinho mixes ISO-Z and naive space-separated UTC strings.
    const iso = /Z$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
    return Date.parse(iso);
  }

  function fmtTime(ts) {
    const t = parseTimestamp(ts);
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  function renderHeader(snapshot) {
    const run = snapshot.run;
    const idChip = run.workflow_id + " #" + (run.run_number ?? "?") +
      " · " + String(run.id).slice(0, 8);
    document.getElementById("run-id").textContent = idChip;
    document.getElementById("run-status-text").textContent = run.status;
    const pulse = document.getElementById("run-pulse");
    pulse.className = "pulse " + statusBucket(run.status);

    // Prefer server frozen elapsed for finished runs (avoids timer running forever after workflow ends).
    document.getElementById("elapsed").textContent =
      run.elapsed_seconds != null
        ? fmtElapsed(run.elapsed_seconds)
        : Number.isFinite(parseTimestamp(run.created_at))
          ? fmtElapsed((Date.now() - parseTimestamp(run.created_at)) / 1000)
          : "—";
    document.getElementById("tokens").textContent = fmtTokens(run.tokens_spent);
    document.getElementById("prompt-tokens").textContent = fmtTokens(run.prompt_tokens ?? 0);
    document.getElementById("completion-tokens").textContent = fmtTokens(run.completion_tokens ?? 0);
    document.getElementById("cached-tokens").textContent = fmtTokens(run.cached_tokens ?? 0);
  }

  function statusBucket(raw) {
    const s = String(raw || "").toLowerCase();
    if (s === "running") return "running";
    if (s === "done" || s === "completed") return "done";
    if (s === "failed" || s === "canceled" || s === "cancelled") return "failed";
    return "todo";
  }

  function buildLaneFootHTML(summary) {
    const total = summary.total;
    const done = summary.done;
    const failed = summary.failed;
    const running = summary.running;
    const todo = summary.total - done - failed - running;
    const pct = total ? Math.round((done / total) * 100) : 0;

    function w(n) {
      return total ? Math.round((n / total) * 100) : 0;
    }

    let labels = [];
    if (done > 0) labels.push('<span class="l done">' + done + ' done</span>');
    if (running > 0) labels.push('<span class="l running">' + running + ' running</span>');
    if (failed > 0) labels.push('<span class="l failed">' + failed + ' failed</span>');
    if (todo > 0) labels.push('<span class="l todo">' + todo + ' todo</span>');
    if (labels.length === 0) labels.push('<span class="l">—</span>');

    return {
      labels: labels.join('<span class="l" style="margin:0 4px;">·</span>'),
      stacked:
        '<div class="lane-progress-stacked">' +
        (done > 0 ? '<div class="seg done" style="width:' + w(done) + '%"></div>' : '') +
        (running > 0 ? '<div class="seg running" style="width:' + w(running) + '%"></div>' : '') +
        (failed > 0 ? '<div class="seg failed" style="width:' + w(failed) + '%"></div>' : '') +
        (todo > 0 ? '<div class="seg todo" style="width:' + w(todo) + '%"></div>' : '') +
        '</div>',
      pct: pct,
    };
  }

  // ── Full rebuild (first load or structural reset) ───────────────

  function renderBoard(snapshot) {
    const board = document.getElementById("board");
    board.style.setProperty("--lanes", String(Math.max(1, snapshot.lanes.length)));
    board.innerHTML = "";
    for (const lane of snapshot.lanes) {
      const laneEl = document.createElement("section");
      laneEl.className = "lane";
      laneEl.setAttribute("data-step-id", lane.stepId);

      laneEl.appendChild(buildLaneHead(lane));
      laneEl.appendChild(buildCardsContainer(lane));
      laneEl.appendChild(buildLaneFoot(lane));

      board.appendChild(laneEl);
    }
  }

  function buildLaneHead(lane) {
    const head = document.createElement("div");
    head.className = "lane-head";
    const itemWord = lane.summary.total === 1 ? "item" : "items";
    head.innerHTML =
      '<div class="lane-name ' + lane.status + '">' +
      '<span class="dot"></span>' + escapeHtml(lane.label) +
      '</div>' +
      '<div class="lane-sub">' + lane.summary.total + ' ' + itemWord +
      ' · ' + escapeHtml(lane.stepType) + (lane.model ? ' · <span class="lane-model">' + escapeHtml(lane.model) + '</span>' : '') + '</div>';
    return head;
  }

  function buildCardsContainer(lane) {
    const cardsEl = document.createElement("div");
    cardsEl.className = "cards";
    if (lane.cards.length === 0) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.innerHTML = '<div class="title" style="color:var(--ink-soft)">—</div>';
      cardsEl.appendChild(empty);
    } else {
      for (const c of lane.cards) {
        cardsEl.appendChild(buildCardEl(c, lane));
      }
    }
    return cardsEl;
  }

  function buildCardEl(c, lane) {
    var cardEl = document.createElement("div");
    cardEl.className = "card " + c.status;
    cardEl.setAttribute("data-card-id", c.id);

    var tokenLine = '';
    if (c.totalTokens > 0) {
      var cardCost = calcCost(lane.model, c.promptTokens, c.completionTokens, c.cachedTokens);
      tokenLine = '<div class="card-tokens">' +
        'In:' + fmtTokens(c.promptTokens) + ' Out:' + fmtTokens(c.completionTokens) +
        ' C:' + fmtTokens(c.cachedTokens) + ' Tot:' + fmtTokens(c.totalTokens) +
        ' <span class="card-cost">$' + cardCost.toFixed(2) + '</span></div>';
    }

    cardEl.innerHTML =
      '<div class="id-row">' +
        '<span><span class="dot"></span>' + escapeHtml(c.id) + '</span>' +
        '<span>' + escapeHtml(c.status) + '</span>' +
      '</div>' +
      '<button class="card-toggle-btn" aria-label="Expand card">+</button>' +
      '<div class="title">' + escapeHtml(c.title) + '</div>' +
      '<div class="meta-row">' + escapeHtml(c.sub) + '</div>' + tokenLine;
    return cardEl;
  }

  function buildLaneFoot(lane) {
    var foot = document.createElement("div");
    foot.className = "lane-foot";
    var part = buildLaneFootHTML(lane.summary);

    var totalPrompt = 0, totalCompletion = 0, totalCached = 0, totalTokens = 0;
    for (var i = 0; i < lane.cards.length; i++) {
      var c = lane.cards[i];
      totalPrompt += c.promptTokens || 0;
      totalCompletion += c.completionTokens || 0;
      totalCached += c.cachedTokens || 0;
      totalTokens += c.totalTokens || 0;
    }
    var cost = calcCost(lane.model, totalPrompt, totalCompletion, totalCached);

    var tokenHTML = '';
    if (totalTokens > 0) {
      tokenHTML = '<div class="lane-tokens">' +
        '<span>In: ' + fmtTokens(totalPrompt) + '</span>' +
        '<span>Out: ' + fmtTokens(totalCompletion) + '</span>' +
        '<span>Cache: ' + fmtTokens(totalCached) + '</span>' +
        '<span>Tot: ' + fmtTokens(totalTokens) + '</span>' +
        '<span>$' + cost.toFixed(2) + '</span>' +
        '</div>';
    }

    foot.innerHTML =
      '<div class="lane-progress-labels">' + part.labels + '</div>' +
      part.stacked +
      '<span style="font-size:11px;font-weight:600;color:var(--ink-soft);">' + part.pct + '%</span>' + tokenHTML;
    return foot;
  }

  // ── Incremental patch (preserves scroll, focus, expanded cards) ──

  function updateBoard(snapshot, prevSnapshot) {
    const board = document.getElementById("board");
    board.style.setProperty("--lanes", String(Math.max(1, snapshot.lanes.length)));

    const prevLanes = new Map();
    if (prevSnapshot && prevSnapshot.lanes) {
      for (const l of prevSnapshot.lanes) prevLanes.set(l.stepId, l);
    }
    const nextLanes = new Map();
    for (const l of snapshot.lanes) nextLanes.set(l.stepId, l);

    // Remove lanes that disappeared
    for (const el of board.querySelectorAll('.lane')) {
      const sid = el.getAttribute('data-step-id');
      if (sid && !nextLanes.has(sid)) el.remove();
    }

    // Build/Update lanes in order (lanes don't reorder within a run)
    for (let i = 0; i < snapshot.lanes.length; i++) {
      const lane = snapshot.lanes[i];
      const existing = board.querySelector('.lane[data-step-id="' + lane.stepId + '"]');
      let laneEl;
      if (existing) {
        laneEl = existing;
        patchLaneHead(laneEl, lane, prevLanes.get(lane.stepId));
        patchCards(laneEl, lane, prevLanes.get(lane.stepId));
        patchLaneFoot(laneEl, lane, prevLanes.get(lane.stepId));
      } else {
        laneEl = document.createElement("section");
        laneEl.className = "lane";
        laneEl.setAttribute("data-step-id", lane.stepId);
        laneEl.appendChild(buildLaneHead(lane));
        laneEl.appendChild(buildCardsContainer(lane));
        laneEl.appendChild(buildLaneFoot(lane));
        board.appendChild(laneEl);
      }
    }
  }

  function patchLaneHead(laneEl, lane, prevLane) {
    if (prevLane && prevLane.status === lane.status && prevLane.label === lane.label && prevLane.summary.total === lane.summary.total && prevLane.stepType === lane.stepType) return;
    const head = laneEl.querySelector('.lane-head');
    if (!head) return;
    const itemWord = lane.summary.total === 1 ? "item" : "items";
    const nameEl = head.querySelector('.lane-name');
    if (nameEl) {
      nameEl.className = 'lane-name ' + lane.status;
      nameEl.innerHTML = '<span class="dot"></span>' + escapeHtml(lane.label);
    }
    const subEl = head.querySelector('.lane-sub');
    if (subEl) {
      subEl.textContent = lane.summary.total + ' ' + itemWord + ' · ' + lane.stepType;
    }
  }

  function patchCards(laneEl, lane, prevLane) {
    const container = laneEl.querySelector('.cards');
    if (!container) return;

    const prevCards = new Map();
    if (prevLane && prevLane.cards) {
      for (const c of prevLane.cards) prevCards.set(c.id, c);
    }
    const nextCards = new Map();
    for (const c of lane.cards) nextCards.set(c.id, c);

    // Remove cards that disappeared
    for (const el of container.querySelectorAll('.card')) {
      const cid = el.getAttribute('data-card-id');
      if (cid && !nextCards.has(cid)) el.remove();
      if (!cid) el.remove();
    }

    // Update / insert cards in order
    for (const c of lane.cards) {
      const existing = container.querySelector('.card[data-card-id="' + c.id.replace(/"/g, '\\"') + '"]');
      if (existing) {
        const p = prevCards.get(c.id);
        if (!p || p.status !== c.status || p.title !== c.title || p.sub !== c.sub || p.totalTokens !== c.totalTokens) {
          existing.className = 'card ' + c.status;
          var tokenLine = '';
          if (c.totalTokens > 0) {
            var cardCost = calcCost(lane.model, c.promptTokens, c.completionTokens, c.cachedTokens);
            tokenLine = '<div class="card-tokens">' +
              'In:' + fmtTokens(c.promptTokens) + ' Out:' + fmtTokens(c.completionTokens) +
              ' C:' + fmtTokens(c.cachedTokens) + ' Tot:' + fmtTokens(c.totalTokens) +
              ' <span class="card-cost">$' + cardCost.toFixed(2) + '</span></div>';
          }
          existing.innerHTML =
            '<div class="id-row">' +
              '<span><span class="dot"></span>' + escapeHtml(c.id) + '</span>' +
              '<span>' + escapeHtml(c.status) + '</span>' +
            '</div>' +
            '<button class="card-toggle-btn" aria-label="Expand card">+</button>' +
            '<div class="title">' + escapeHtml(c.title) + '</div>' +
            '<div class="meta-row">' + escapeHtml(c.sub) + '</div>' + tokenLine;
        }
      } else {
        container.appendChild(buildCardEl(c, lane));
      }
    }

    if (lane.cards.length === 0 && container.querySelectorAll('.card').length === 0) {
      const empty = document.createElement("div");
      empty.className = "card";
      empty.innerHTML = '<div class="title" style="color:var(--ink-soft)">—</div>';
      container.appendChild(empty);
    }
  }

  function patchLaneFoot(laneEl, lane, prevLane) {
    var summaryChanged = !prevLane || !prevLane.summary ||
        prevLane.summary.done !== lane.summary.done ||
        prevLane.summary.failed !== lane.summary.failed ||
        prevLane.summary.running !== lane.summary.running ||
        prevLane.summary.total !== lane.summary.total;

    var foot = laneEl.querySelector('.lane-foot');
    if (!foot) return;

    if (!summaryChanged) {
      // Still update tokens in case they changed
      var tokenEl = foot.querySelector('.lane-tokens');
      if (tokenEl) {
        var totalPrompt = 0, totalCompletion = 0, totalCached = 0, totalTokens = 0;
        for (var i = 0; i < lane.cards.length; i++) {
          var c = lane.cards[i];
          totalPrompt += c.promptTokens || 0;
          totalCompletion += c.completionTokens || 0;
          totalCached += c.cachedTokens || 0;
          totalTokens += c.totalTokens || 0;
        }
        if (totalTokens > 0) {
          var cost = calcCost(lane.model, totalPrompt, totalCompletion, totalCached);
          tokenEl.innerHTML = '<span>In: ' + fmtTokens(totalPrompt) + '</span>' +
            '<span>Out: ' + fmtTokens(totalCompletion) + '</span>' +
            '<span>Cache: ' + fmtTokens(totalCached) + '</span>' +
            '<span>Tot: ' + fmtTokens(totalTokens) + '</span>' +
            '<span>$' + cost.toFixed(2) + '</span>';
        }
      }
      return;
    }

    var part = buildLaneFootHTML(lane.summary);

    var totalPrompt = 0, totalCompletion = 0, totalCached = 0, totalTokens = 0;
    for (var i = 0; i < lane.cards.length; i++) {
      var c = lane.cards[i];
      totalPrompt += c.promptTokens || 0;
      totalCompletion += c.completionTokens || 0;
      totalCached += c.cachedTokens || 0;
      totalTokens += c.totalTokens || 0;
    }
    var cost = calcCost(lane.model, totalPrompt, totalCompletion, totalCached);

    var tokenHTML = '';
    if (totalTokens > 0) {
      tokenHTML = '<div class="lane-tokens">' +
        '<span>In: ' + fmtTokens(totalPrompt) + '</span>' +
        '<span>Out: ' + fmtTokens(totalCompletion) + '</span>' +
        '<span>Cache: ' + fmtTokens(totalCached) + '</span>' +
        '<span>Tot: ' + fmtTokens(totalTokens) + '</span>' +
        '<span>$' + cost.toFixed(2) + '</span>' +
        '</div>';
    }

    foot.innerHTML =
      '<div class="lane-progress-labels">' + part.labels + '</div>' +
      part.stacked +
      '<span style="font-size:11px;font-weight:600;color:var(--ink-soft);">' + part.pct + '%</span>' + tokenHTML;
  }

  let lastGoodAt = null;
  const expandedCardIds = new Set();
  // Tracks which collapsible sections (by label) the user has manually
  // collapsed; survives polling re-renders so the user's choice sticks.
  const collapsedSections = new Set();

  // ── Card expansion helpers ────────────────────────────────────

  function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    ms = Math.max(0, Math.round(ms));
    if (ms >= 60000) {
      const m = Math.floor(ms / 60000);
      const s = Math.round((ms % 60000) / 1000);
      return s ? m + "m " + s + "s" : m + "m";
    }
    if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
    return ms + "ms";
  }

  function createDetailSection(detail, isLoading) {
    const div = document.createElement("div");
    div.className = "card-detail";

    if (isLoading) {
      div.innerHTML = '<div class="detail-loading">Loading…</div>';
      return div;
    }

    if (!detail) {
      div.innerHTML = '<div class="detail-error">No detail available</div>';
      return div;
    }

    const parts = [];

    // Prompt — always shown, collapsible
    parts.push(
      '<details class="detail-section detail-collapsible" open>',
      '<summary class="detail-summary">',
      '<span class="detail-chevron" aria-hidden="true"></span>',
      '<span class="detail-label">Prompt</span>',
      '</summary>',
      '<div class="detail-collapse-body">',
      detail.input_template
        ? '<pre class="detail-prompt-text">' + escapeHtml(detail.input_template) + '</pre>'
        : '<div class="detail-placeholder detail-value">—</div>',
      '</div>',
      '</details>'
    );

    // Task context — collapsible, same formatting as Prompt
    if (detail.task) {
      parts.push(
        '<details class="detail-section detail-collapsible" open>',
        '<summary class="detail-summary">',
        '<span class="detail-chevron" aria-hidden="true"></span>',
        '<span class="detail-label">Task</span>',
        '</summary>',
        '<div class="detail-collapse-body">',
        '<pre class="detail-task-text">', escapeHtml(detail.task), '</pre>',
        '</div>',
        '</details>'
      );
    }

    // Description (story cards)
    if (detail.description) {
      parts.push(
        '<div class="detail-section">',
        '<div class="detail-label">Description</div>',
        '<div class="detail-value">', escapeHtml(detail.description), '</div>',
        '</div>'
      );
    }

    // Acceptance criteria
    if (detail.acceptanceCriteria && detail.acceptanceCriteria.length > 0) {
      parts.push(
        '<div class="detail-section">',
        '<div class="detail-label">Acceptance Criteria</div>',
        '<ul class="detail-list">'
      );
      for (const ac of detail.acceptanceCriteria) {
        parts.push('<li>', escapeHtml(ac), '</li>');
      }
      parts.push('</ul></div>');
    }

    // Timing — always shown
    parts.push(
      '<div class="detail-section">',
      '<div class="detail-label">Timing</div>',
      '<div class="detail-value">',
      escapeHtml(detail.timing ? fmtDuration(detail.timing.durationMs) : '—'),
      '</div>',
      '</div>'
    );

    // Tokens — always shown
    var dbTokens = (detail.tokens && detail.tokens.promptTokens || 0) + (detail.tokens && detail.tokens.completionTokens || 0) + (detail.tokens && detail.tokens.cachedTokens || 0);
    var eventTokens = detail.tokens && detail.tokens.total || 0;
    var displayTotal = dbTokens > 0 ? dbTokens : eventTokens;
    parts.push(
      '<div class="detail-section">',
      '<div class="detail-label">Tokens</div>',
      '<div class="detail-value">', displayTotal > 0 ? fmtTokens(displayTotal) : '—',
      detail.tokens && detail.tokens.model ? ' · <span style="color:var(--accent)">' + escapeHtml(detail.tokens.model) + '</span>' : '',
      '</div></div>');

    // Retry info
    if ((detail.retryCount ?? 0) > 0 || (detail.maxRetries ?? 0) > 0) {
      parts.push(
        '<div class="detail-section">',
        '<div class="detail-label">Retries</div>',
        '<div class="detail-value">',
        String(detail.retryCount ?? 0), ' / ', String(detail.maxRetries ?? 4),
        '</div></div>'
      );
    }

    // Failure detail
    if (detail.failureDetail) {
      parts.push(
        '<div class="detail-section detail-failure">',
        '<div class="detail-label">Failure Reason</div>',
        '<pre class="detail-failure-text">', escapeHtml(detail.failureDetail), '</pre>',
        '</div>'
      );
    }

    // Output — collapsible
    if (detail.output) {
      parts.push(
        '<details class="detail-section detail-collapsible" open>',
        '<summary class="detail-summary">',
        '<span class="detail-chevron" aria-hidden="true"></span>',
        '<span class="detail-label">Output</span>',
        '</summary>',
        '<div class="detail-collapse-body">',
        '<pre class="detail-output-text">', escapeHtml(detail.output), '</pre>',
        '</div>',
        '</details>'
      );
    }

    div.innerHTML = parts.join("");
    return div;
  }

  function createErrorSection(msg) {
    const div = document.createElement("div");
    div.className = "card-detail";
    div.innerHTML = '<div class="detail-error">Fetch failed: ' + escapeHtml(msg) + '</div>';
    return div;
  }

  // ── Modal helpers ─────────────────────────────────────────────

  const modalEl = document.getElementById("card-detail-modal");
  const modalBodyEl = document.getElementById("card-detail-modal-body");
  const modalIdEl = modalEl.querySelector(".card-detail-modal-id");
  const modalIdTextEl = modalEl.querySelector(".card-detail-modal-id-text");
  const modalStatusEl = modalEl.querySelector(".card-detail-modal-status");
  let lastFocusedToggleBtn = null;

  function setToggleButtonState(cardEl, expanded) {
    const btn = cardEl.querySelector(".card-toggle-btn");
    if (!btn) return;
    if (expanded) {
      btn.textContent = "−";
      btn.setAttribute("aria-label", "Collapse card");
      btn.setAttribute("aria-expanded", "true");
    } else {
      btn.textContent = "+";
      btn.setAttribute("aria-label", "Expand card");
      btn.setAttribute("aria-expanded", "false");
    }
  }

  function syncToggleButtons() {
    const cards = document.getElementById("board").querySelectorAll(".card[data-card-id]");
    for (const cardEl of cards) {
      const cid = cardEl.getAttribute("data-card-id");
      setToggleButtonState(cardEl, cid && expandedCardIds.has(cid));
    }
  }

  function findCardEl(cardId) {
    return document.getElementById("board").querySelector(
      '[data-card-id="' + cardId.replace(/"/g, '\\"') + '"]'
    );
  }

  function updateModalHeader(cardId) {
    modalIdTextEl.textContent = cardId;
    const cardEl = findCardEl(cardId);
    const status = cardEl
      ? (cardEl.classList.contains("running") ? "running"
        : cardEl.classList.contains("done") ? "done"
        : cardEl.classList.contains("failed") ? "failed"
        : "todo")
      : "todo";
    modalIdEl.classList.remove("running", "done", "failed", "todo");
    modalIdEl.classList.add(status);
    modalStatusEl.textContent = status;
  }

  function showModal() {
    modalEl.classList.add("open");
    modalEl.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function hideModal() {
    modalEl.classList.remove("open");
    modalEl.setAttribute("aria-hidden", "true");
    modalBodyEl.innerHTML = "";
    document.body.style.overflow = "";
  }

  function applyCollapsedState(container) {
    const items = container.querySelectorAll("details.detail-collapsible");
    for (const det of items) {
      const labelEl = det.querySelector(".detail-label");
      const label = labelEl ? labelEl.textContent.trim() : "";
      if (label && collapsedSections.has(label)) {
        det.open = false;
      }
    }
  }

  let lastDetailCardId = null;
  let lastDetailJson = null;

  async function loadDetailIntoModal(cardId) {
    const savedScroll = modalBodyEl.scrollTop;
    try {
      const apiUrl = "/api/runs/" + encodeURIComponent(runId) +
        "/kanban/card-detail?cardId=" + encodeURIComponent(cardId);
      const r = await fetch(apiUrl, { cache: "no-store" });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error("HTTP " + r.status + " — " + txt.slice(0, 200));
      }
      const rText = await r.text();
      // Skip re-render if content hasn't changed (preserves scroll & collapse state)
      if (cardId === lastDetailCardId && rText === lastDetailJson) {
        return true;
      }
      lastDetailCardId = cardId;
      lastDetailJson = rText;
      const detail = JSON.parse(rText);
      modalBodyEl.innerHTML = "";
      modalBodyEl.appendChild(createDetailSection(detail));
      applyCollapsedState(modalBodyEl);
      modalBodyEl.scrollTop = savedScroll;
      return true;
    } catch (err) {
      modalBodyEl.innerHTML = "";
      modalBodyEl.appendChild(createErrorSection(err.message));
      modalBodyEl.scrollTop = savedScroll;
      return false;
    }
  }

  // The native `toggle` event does not bubble, so listen in the capture phase
  // to track every collapsible section inside the modal.
  modalBodyEl.addEventListener("toggle", function (e) {
    const det = e.target;
    if (!det || det.tagName !== "DETAILS") return;
    if (!det.classList.contains("detail-collapsible")) return;
    const labelEl = det.querySelector(".detail-label");
    const label = labelEl ? labelEl.textContent.trim() : "";
    if (!label) return;
    if (det.open) {
      collapsedSections.delete(label);
    } else {
      collapsedSections.add(label);
    }
  }, true);

  async function openCardDetail(cardId, opts) {
    const isRefresh = !!(opts && opts.refresh);
    // Only one card can be expanded at a time in the modal.
    expandedCardIds.clear();
    expandedCardIds.add(cardId);
    updateModalHeader(cardId);
    if (!isRefresh) showModal();
    syncToggleButtons();
    const ok = await loadDetailIntoModal(cardId);
    if (!ok && !isRefresh) {
      // Keep the error visible; user can dismiss with Esc / overlay click.
    }
  }

  function closeCardDetail() {
    if (expandedCardIds.size === 0 && !modalEl.classList.contains("open")) return;
    expandedCardIds.clear();
    hideModal();
    syncToggleButtons();
    if (lastFocusedToggleBtn && document.contains(lastFocusedToggleBtn)) {
      try { lastFocusedToggleBtn.focus(); } catch {}
    }
    lastFocusedToggleBtn = null;
    lastDetailCardId = null;
    lastDetailJson = null;
  }

  // ── Event delegation for toggle buttons ───────────────────────

  document.getElementById("board").addEventListener("click", async function (e) {
    const btn = e.target.closest(".card-toggle-btn");
    if (!btn) return;
    e.stopPropagation();

    const card = btn.closest(".card");
    if (!card) return;
    const cardId = card.getAttribute("data-card-id");
    if (!cardId) return;

    if (expandedCardIds.has(cardId)) {
      closeCardDetail();
    } else {
      lastFocusedToggleBtn = btn;
      await openCardDetail(cardId);
    }
  });

  // ── Keyboard: Enter / Space on toggle button ──────────────────
  document.getElementById("board").addEventListener("keydown", function (e) {
    if (e.target.matches(".card-toggle-btn") && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.target.click();
    }
  });

  // ── Modal dismissal: Esc, overlay click, close button ─────────
  modalEl.addEventListener("click", function (e) {
    if (e.target.closest("[data-modal-close]")) {
      closeCardDetail();
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modalEl.classList.contains("open")) {
      e.preventDefault();
      closeCardDetail();
    }
  });

  let pollInterval;

  function updatePollLabel() {
    const chk = document.getElementById("poll-toggle");
    const label = document.getElementById("poll-label");
    if (chk && label) {
      label.textContent = chk.checked ? "poll " + (REFRESH_MS / 1000) + "s" : "poll paused";
    }
  }

  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    tick();
    pollInterval = setInterval(tick, REFRESH_MS);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    const chk = document.getElementById("poll-toggle");
    if (chk) {
      updatePollLabel();
      chk.addEventListener("change", function () {
        updatePollLabel();
        if (chk.checked) {
          startPolling();
        } else {
          stopPolling();
        }
      });
    }
  });

  let previousSnapshot = null;

  async function tick() {
    if (!runId) {
      document.getElementById("footer-left").innerHTML =
        '<span class="err">no runId in URL — expected /runs/&lt;id&gt;/kanban</span>';
      return;
    }
    try {
      const r = await fetch("/api/runs/" + encodeURIComponent(runId) + "/kanban", {
        cache: "no-store",
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error("HTTP " + r.status + " — " + txt.slice(0, 200));
      }
      const data = await r.json();
      renderHeader(data);

      if (previousSnapshot) {
        updateBoard(data, previousSnapshot);
      } else {
        renderBoard(data);
      }
      previousSnapshot = data;

      // Re-sync expanded card state after the board re-render and refresh the
      // open modal in place (so latest tokens/timing/output show through).
      const missingCardIds = [];
      for (const cardId of expandedCardIds) {
        if (!findCardEl(cardId)) missingCardIds.push(cardId);
      }
      for (const id of missingCardIds) {
        expandedCardIds.delete(id);
      }
      if (expandedCardIds.size === 0 && modalEl.classList.contains("open")) {
        // The expanded card disappeared from the snapshot — close the modal.
        closeCardDetail();
      } else if (expandedCardIds.size > 0) {
        const openCardId = Array.from(expandedCardIds)[0];
        syncToggleButtons();
        // Refresh modal contents in place; do NOT toggle visibility.
        openCardDetail(openCardId, { refresh: true });
      }

      lastGoodAt = new Date();
      document.getElementById("footer-left").textContent =
        "live · refreshed " + lastGoodAt.toLocaleTimeString();
    } catch (e) {
      const last = lastGoodAt ? lastGoodAt.toLocaleTimeString() : "never";
      document.getElementById("footer-left").innerHTML =
        '<span class="err">disconnected</span> · ' + escapeHtml(e.message) +
        ' · last good ' + last;
    }
  }

  startPolling();
})();
