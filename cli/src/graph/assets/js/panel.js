// panel.js — right-side detail panel. Renders, by selection kind:
//   (nothing)    → project stats + hint
//   unit         → knowledge unit detail: summary, anchors, related units
//   topic        → wiki topic detail: overview, commits, branches, its units
//   category-pair   → list of the underlying cross-category edges with evidence
// Plain script; exposes window.WikiPanel.

(function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function confPill(c) {
    if (typeof c !== "number") return "";
    const pct = Math.round(c * 100);
    const tier = c >= 0.85 ? "hi" : c >= 0.7 ? "mid" : "lo";
    return `<span class="conf-pill ${tier}" title="confidence ${c.toFixed(2)}">${pct}%</span>`;
  }

  function relItemHtml(edge, dir, peerUnit, topicOfPeer) {
    // Symmetric relationships are undirected, so they carry no direction arrow.
    const sym = window.WikiData.symmetricTypes.has(edge.type);
    const arrow = sym ? "" : (dir === "out" ? "→ " : "← ");
    return `<div class="rel-item" data-goto-unit="${esc(peerUnit.id)}" data-edge-key="${esc(edge.from + ">" + edge.to)}">` +
      `<div class="rel-head">` +
      `<span class="rel-type ${esc(edge.type)}">${arrow}${esc(edge.type)}</span>` +
      confPill(edge.confidence) +
      `<span class="rel-title">${esc(peerUnit.shortTitle)}</span>` +
      `</div>` +
      `<div class="rel-dir">${esc(topicOfPeer ? topicOfPeer.shortTitle : "")}</div>` +
      `<div class="rel-evidence">${esc(edge.evidence)}</div>` +
      `</div>`;
  }

  function renderEmpty() {
    const D = window.WikiData;
    const g = D.graph;
    let html = "";
    html += `<h2>Jolli Graph</h2>`;
    html += `<div class="p-meta">Distilled from your local knowledge base · regenerated on every merge</div>`;
    html += `<h6>Project stats</h6><div class="stat-rows">`;
    html += row("Categories", g.stats.categories);
    html += row("Topics", g.stats.topics);
    html += row("Units", g.stats.units);
    // Typed (LLM) links by scope. Under per-category edge batching the LLM never
    // sees two categories at once, so cross-category typed edges no longer exist —
    // there is no cross-category typed count (the old always-zero row + its stat
    // field were removed). The remaining typed links are within a topic, or across
    // topics inside one category (= crossTopicEdges, since none span categories now).
    html += row("Links within a topic", g.stats.intraTopicEdges);
    html += row("Links within a category", g.stats.crossTopicEdges);
    // Cross-category coupling now lives entirely in the deterministic co-change
    // layer — a separate, additive bucket. `?? 0` tolerates a pre-v4 graph.json.
    html += row("Co-change links (cross-category)", g.stats.coChangeTopicEdgeCount ?? 0);
    html += `</div>`;
    html += `<h6>How to read this</h6>`;
    html += `<p class="summary">Each big card is a <strong>category</strong>. Click one to see its knowledge topics and the units inside. Lines with numbers show how many links connect two categories — click a line to list them.</p>`;
    html += `<div class="panel-hint">Click any card to see its details here.</div>`;
    return html;

    function row(l, v) { return `<div class="row"><span class="lbl">${l}</span><span class="val">${v}</span></div>`; }
  }

  function renderUnit(unitId) {
    const D = window.WikiData;
    const u = D.unitsById.get(unitId);
    if (!u) return renderEmpty();
    const topic = D.topicsBySlug.get(u.topicSlug);
    let html = "";
    html += `<h2>${esc(u.shortTitle)}</h2>`;
    html += `<div class="p-meta"><span class="p-kinds">${window.WikiRender.kindBadges(u.kinds)}</span>` +
      `in <code>${esc(topic.shortTitle)}</code></div>`;
    html += `<p class="summary">${esc(u.summary)}</p>`;

    const rels = D.adj.get(unitId) || [];
    if (rels.length) {
      html += `<h6>Related units — ${rels.length}</h6>`;
      for (const r of rels) {
        const peer = D.unitsById.get(r.peer);
        if (!peer) continue;
        html += relItemHtml(r.edge, r.dir, peer, D.topicsBySlug.get(peer.topicSlug));
      }
    }

    if (u.anchors) {
      if (u.anchors.files && u.anchors.files.length) {
        html += `<h6>Evidence — files</h6><div class="anchor-list">` +
          u.anchors.files.map((f) => `<code>${esc(f)}</code>`).join("") + `</div>`;
      }
      if (u.anchors.commits && u.anchors.commits.length) {
        html += `<h6>Evidence — commits</h6><div class="anchor-list">` +
          u.anchors.commits.map((c) => `<code>${esc(c)}</code>`).join("") + `</div>`;
      }
    }
    html += `<div class="panel-hint">Esc returns to the previous view.</div>`;
    return html;
  }

  function renderTopic(slug) {
    const D = window.WikiData;
    const t = D.topicsBySlug.get(slug);
    if (!t) return renderEmpty();
    const units = D.unitsByTopic.get(slug) || [];
    let html = "";
    html += `<h2>${esc(t.shortTitle)}</h2>`;
    html += `<div class="p-meta">${esc(t.title)}</div>`;
    html += `<p class="summary">${esc(t.summary)}</p>`;

    // Full wiki page opens in-panel (kind: "wiki"); Back returns to this topic.
    // Sits right under the description, mirroring the "Open category" button.
    if (t.fullBody) {
      html += `<button type="button" class="wiki-open" data-open-wiki="${esc(slug)}">📖 Open full wiki page</button>`;
    }

    // Distilled units as quick links into the board.
    if (units.length) {
      html += `<h6>Units in this topic — ${units.length}</h6>`;
      for (const u of units) {
        html += `<div class="rel-item" data-goto-unit="${esc(u.id)}">` +
          `<div class="rel-head"><span class="rel-title">${esc(u.shortTitle)}</span></div>` +
          window.WikiRender.kindBadges(u.kinds) +
          `<div class="rel-evidence">${esc(u.summary)}</div></div>`;
      }
    }

    // Co-change links: deterministic cross-category coupling for THIS topic
    // (topics in other categories whose units touch the same files).
    const coChange = (D.coChangeByTopic && D.coChangeByTopic.get(slug)) || [];
    if (coChange.length) {
      html += `<h6>Co-change links — ${coChange.length}</h6>`;
      for (const { peerTopic, edge } of coChange) {
        const pt = D.topicsBySlug.get(peerTopic);
        const n = edge.sharedFileCount ?? (edge.sharedFiles ? edge.sharedFiles.length : 0);
        const label = edge.semanticType ? `${esc(edge.semanticType)} · co-change` : "co-change";
        html += `<div class="rel-item" data-goto-topic="${esc(peerTopic)}">` +
          `<div class="rel-head"><span class="rel-type co-change">${label}</span>` +
          `<span class="rel-title">${esc(pt ? pt.shortTitle : peerTopic)}</span></div>` +
          `<div class="rel-evidence">${n} shared file${n === 1 ? "" : "s"}</div></div>`;
      }
    }

    return html;
  }

  // Full markdown wiki page, rendered inside the panel (reading mode widens it).
  function renderWiki(slug) {
    const D = window.WikiData;
    const t = D.topicsBySlug.get(slug);
    if (!t) return renderEmpty();
    const md = (window.marked && window.marked.parse)
      ? window.marked.parse(t.fullBody || "")
      : `<pre>${esc(t.fullBody || "")}</pre>`;
    let html = "";
    html += `<h2>${esc(t.shortTitle)}</h2>`;
    html += `<div class="p-meta">${esc(t.title)}</div>`;
    html += `<div class="wiki-body">${md}</div>`; // marked output is our own wiki HTML
    return html;
  }

  function renderCategoryPair(pairId) {
    const D = window.WikiData;
    const [a, b] = pairId.split("|");
    const agg = D.categoryAgg.find((x) => x.a === a && x.b === b);
    const coAgg = (D.coChangeCategoryAgg || []).find((x) => x.a === a && x.b === b);
    const ta = D.categoriesById.get(a), tb = D.categoriesById.get(b);
    // A pair may exist via typed unit edges, co-change edges, or both.
    if ((!agg && !coAgg) || !ta || !tb) return renderEmpty();
    const typedCount = agg ? agg.edges.length : 0;
    const coCount = coAgg ? coAgg.edges.length : 0;
    let html = "";
    html += `<h2>${esc(ta.shortTitle)} ↔ ${esc(tb.shortTitle)}</h2>`;
    html += `<div class="p-meta">${typedCount} typed link${typedCount === 1 ? "" : "s"} · ` +
      `${coCount} co-change link${coCount === 1 ? "" : "s"}</div>`;
    if (agg) {
      for (const e of agg.edges) {
        const fu = D.unitsById.get(e.from), tu = D.unitsById.get(e.to);
        if (!fu || !tu) continue;
        // Symmetric relationships are undirected → a non-directional connector.
        const conn = D.symmetricTypes.has(e.type) ? "↔" : "→";
        html += `<div class="rel-item" data-goto-unit="${esc(e.from)}">` +
          `<div class="rel-head"><span class="rel-type ${esc(e.type)}">${esc(e.type)}</span>${confPill(e.confidence)}</div>` +
          `<div class="rel-title" style="margin-bottom:3px">${esc(fu.shortTitle)} ${conn} ${esc(tu.shortTitle)}</div>` +
          `<div class="rel-evidence">${esc(e.evidence)}</div></div>`;
      }
    }
    // Co-change links: topic↔topic, evidence is the shared-file list (no confidence,
    // no semantic type unless a slow sweep backfilled `semanticType`).
    if (coAgg && coAgg.edges.length) {
      html += `<h6>Co-change links — ${coAgg.edges.length}</h6>`;
      for (const e of coAgg.edges) {
        const ft = D.topicsBySlug.get(e.fromTopic), tt = D.topicsBySlug.get(e.toTopic);
        const label = e.semanticType ? `${esc(e.semanticType)} · co-change` : "co-change";
        const files = (e.sharedFiles || []).map((f) => `<code>${esc(f)}</code>`).join("");
        const n = e.sharedFileCount ?? (e.sharedFiles ? e.sharedFiles.length : 0);
        html += `<div class="rel-item" data-goto-topic="${esc(e.fromTopic)}">` +
          `<div class="rel-head"><span class="rel-type co-change">${label}</span></div>` +
          `<div class="rel-title" style="margin-bottom:3px">${esc(ft ? ft.shortTitle : e.fromTopic)} ↔ ` +
          `${esc(tt ? tt.shortTitle : e.toTopic)}</div>` +
          `<div class="rel-evidence">${n} shared file${n === 1 ? "" : "s"}: <span class="anchor-list">${files}</span></div></div>`;
      }
    }
    return html;
  }

  function render() {
    const S = window.WikiState, D = window.WikiData;
    const s = S.get();
    const body = document.getElementById("panel-body");
    let html = "";
    if (S.canGoBack()) {
      html += `<button type="button" class="panel-back" id="panel-back" title="Back (Backspace)">← Back</button>`;
    }
    const sel = s.selected;
    if (!sel) html += s.level === "category" ? renderCategorySummary(s.categoryId, true) : renderEmpty();
    else if (sel.kind === "unit") html += renderUnit(sel.id);
    else if (sel.kind === "topic") html += renderTopic(sel.id);
    else if (sel.kind === "wiki") html += renderWiki(sel.id);
    else if (sel.kind === "category") html += renderCategorySummary(sel.id, s.categoryId === sel.id);
    else if (sel.kind === "category-pair") html += renderCategoryPair(sel.id);
    else html += renderEmpty();

    body.innerHTML = html;
    // Reading mode widens the panel for the long-form wiki page.
    const panelEl = document.getElementById("panel");
    if (panelEl) panelEl.classList.toggle("reading", !!(sel && sel.kind === "wiki"));
    // Opening the full wiki page: jump to the top so reading starts at the
    // beginning, not wherever the previous panel content was scrolled.
    if (panelEl && sel && sel.kind === "wiki") panelEl.scrollTop = 0;

    const back = document.getElementById("panel-back");
    if (back) back.addEventListener("click", () => S.goBack());

    body.querySelectorAll("[data-goto-unit]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.gotoUnit;
        const u = D.unitsById.get(id);
        const t = u && D.topicsBySlug.get(u.topicSlug);
        if (!u || !t) return;
        // Navigate to the unit's category and select it
        S.set({ level: "category", categoryId: t.categoryId, selected: { kind: "unit", id } });
      });
      // Spotlight matching edge on hover (when visible in current view)
      el.addEventListener("mouseenter", () => {
        const key = el.dataset.edgeKey;
        if (!key) return;
        el.classList.add("spotlight");
        window.WikiEdges.dimAllExcept((k) => k === key);
      });
      el.addEventListener("mouseleave", () => {
        el.classList.remove("spotlight");
        // Restore the locked selection spotlight rather than clearing all dims
        window.WikiViews.refreshSpotlight();
      });
    });
  }

  // opened = true when this category is the one currently entered on the board
  // (panel is a passive summary); false when it was merely selected from the
  // overview or a portal, so we offer an "open" affordance.
  function renderCategorySummary(categoryId, opened) {
    const D = window.WikiData;
    const th = D.categoriesById.get(categoryId);
    if (!th) return renderEmpty();
    const topics = D.topicsByCategory.get(categoryId) || [];
    let html = "";
    html += `<h2>${esc(th.shortTitle)}</h2>`;
    html += `<div class="p-meta">${th.topicCount} topics · ${th.commitCount} commits · ${th.unitCount} units</div>`;
    html += `<p class="summary">${esc(th.summary)}</p>`;
    if (!opened) {
      html += `<button type="button" class="panel-open" data-open-category="${esc(categoryId)}">Open category →</button>`;
    }
    html += `<h6>Topics</h6>`;
    for (const t of topics) {
      html += `<div class="rel-item" data-goto-topic="${esc(t.slug)}">` +
        `<div class="rel-head"><span class="rel-title">${esc(t.shortTitle)}</span></div>` +
        `<div class="rel-evidence">${esc(t.summary)}</div></div>`;
    }
    html += `<div class="panel-hint">${opened
      ? "Click a unit card on the left to inspect it."
      : "Click a topic to open it, or use “Open category”."}</div>`;
    return html;
  }

  // Late-bind topic links + the "Open category" button (event delegation).
  // Clicking a topic drills into its category and selects it — works whether
  // the panel is showing the entered category or one picked from the overview.
  document.addEventListener("click", (ev) => {
    const open = ev.target.closest && ev.target.closest(".panel-open[data-open-category]");
    if (open) {
      window.WikiState.set({ level: "category", categoryId: open.dataset.openCategory, selected: null });
      return;
    }
    // "Open full wiki page" → show it in-panel as a wiki selection (Back returns
    // to the topic). The topic is already in view, so only `selected` changes.
    const wiki = ev.target.closest && ev.target.closest("[data-open-wiki]");
    if (wiki) {
      window.WikiState.set({ selected: { kind: "wiki", id: wiki.dataset.openWiki } });
      return;
    }
    const el = ev.target.closest && ev.target.closest("[data-goto-topic]");
    if (!el) return;
    const t = window.WikiData.topicsBySlug.get(el.dataset.gotoTopic);
    if (!t) return;
    window.WikiState.set({ level: "category", categoryId: t.categoryId, selected: { kind: "topic", id: t.slug } });
  });

  window.WikiPanel = { render };
})();
