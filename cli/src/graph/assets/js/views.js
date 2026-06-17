// views.js — render the two board levels:
//   Level 1 "overview":  category cards + aggregated category-pair edges (count bubbles)
//   Level 2 "category":     topic groups with unit cards + concrete edges + portals
// Edge promotion happens here: a cross-category edge endpoint is replaced by the
// portal box of the other category; a collapsed topic's units promote to the
// topic header. Plain script; exposes window.WikiViews.

(function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Masonry geometry for the category-detail view: fixed-width topic columns
  // side by side (the pan/zoom camera removes the viewport-width constraint).
  const COL_W = 520;
  const COL_GAP = 40;
  // A topic's edge-less ("isolated") unit cards are packed into a compact grid
  // beneath its edge-connected cards, so a topic with many standalone units no
  // longer sprawls into one wide row. Gaps mirror the .unit-grid CSS.
  const ISO_COLS = 4; // max columns in the isolated-unit grid (tune for width)
  const ISO_GAP_X = 30;
  const ISO_GAP_Y = 42;

  // Reuse ONE ELK instance across every layout (overview, category, and the
  // per-topic sub-layouts). `new ELK()` spins up a Web Worker, so creating one
  // per navigation churns workers and can stall under rapid nav (e.g. a
  // double-click that fires the overview layout and a category's 6 sub-layouts
  // back-to-back). elkjs serializes concurrent layout() calls on one instance.
  let _elk = null;
  function sharedElk() { return _elk || (_elk = new window.ELK()); }

  // ── Level 1: Overview ─────────────────────────────────────────────
  function renderOverview() {
    const D = window.WikiData, S = window.WikiState;
    const board = document.getElementById("board");
    board.style.width = "1340px";
    let html = '<div class="category-grid">';
    const selCat = (() => { const s = S.get().selected; return s && s.kind === "category" ? s.id : null; })();
    for (const th of D.categories) {
      html += `<div class="category-card${th.id === selCat ? " selected" : ""}" data-category="${esc(th.id)}" style="--tcolor:${th.color}">`;
      html += `<div class="c-head"><span class="t-label">CATEGORY</span>` +
        `<span class="c-jump" data-open-category="${esc(th.id)}" title="Open ${esc(th.shortTitle)}">→</span></div>`;
      html += `<h3>${esc(th.shortTitle)}</h3>`;
      html += `<p>${esc(th.summary)}</p>`;
      html += `<div class="t-stats">${th.topicCount} topics · ${th.commitCount} commits · ${th.unitCount} units</div>`;
      html += `</div>`;
    }
    html += "</div>";
    board.innerHTML = html;

    // Single click = inspect in the panel; jump arrow or double-click = drill in.
    const enterCategory = (id) => S.set({ level: "category", categoryId: id, selected: null });
    board.querySelectorAll(".category-card").forEach((el) => {
      el.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-open-category]")) { enterCategory(el.dataset.category); return; }
        S.set({ selected: { kind: "category", id: el.dataset.category } });
      });
      el.addEventListener("dblclick", () => enterCategory(el.dataset.category));
      window.WikiDrag.enable(el, drawOverviewEdges);
    });

    // ELK layout first, then the aggregated category-pair edges
    requestAnimationFrame(() => {
      layoutOverview(board).then(() => {
        drawOverviewEdges();
        settleCamera();
      });
    });
  }

  // Aggregated category-pair edges for the overview (also re-run after a drag).
  function drawOverviewEdges() {
    const D = window.WikiData;
    const board = document.getElementById("board");
    const layer = window.WikiEdges.clear();
    for (const agg of D.categoryAgg) {
      const elA = board.querySelector(`[data-category="${agg.a}"]`);
      const elB = board.querySelector(`[data-category="${agg.b}"]`);
      if (!elA || !elB) continue;
      const key = "agg:" + agg.a + "|" + agg.b;
      window.WikiEdges.draw(layer, {
        fromEl: elA, toEl: elB,
        type: dominantType(agg.edges),
        width: Math.min(3.5, 1 + agg.edges.length * 0.35),
        opacity: 0.5,
        arrow: false,
        count: agg.edges.length,
        key,
        onClick: () => window.WikiState.set({ selected: { kind: "category-pair", id: agg.a + "|" + agg.b } }),
        onHover: (on) => {
          const layerEl = document.getElementById("edge-layer");
          if (on) window.WikiEdges.dimAllExcept(layerEl, (k) => k === key);
          else window.WikiEdges.undim(layerEl);
        },
      });
    }
  }

  // ELK layered layout for the overview: category cards ranked by the
  // MAJORITY direction of the unit edges underlying each category pair, so
  // upstream categories sit above the ones that build on them; categories
  // with no cross-links land in the top row.
  function layoutOverview(board) {
    if (!window.ELK) return Promise.resolve();
    const D = window.WikiData;
    const grid = board.querySelector(".category-grid");
    if (!grid) return Promise.resolve();
    grid.classList.add("elk-grid");
    const CARD_W = 320;
    const cards = [...grid.querySelectorAll(".category-card")];
    for (const c of cards) c.style.width = CARD_W + "px";
    const children = cards.map((c) => ({
      id: "c:" + c.dataset.category,
      width: CARD_W,
      height: c.offsetHeight,
    }));
    const edges = D.categoryAgg.map((agg, i) => {
      let ab = 0;
      for (const e of agg.edges) if (D.categoryOfUnit(e.from) === agg.a) ab++;
      const [s, t] = ab >= agg.edges.length - ab ? [agg.a, agg.b] : [agg.b, agg.a];
      return { id: "oe" + i, sources: ["c:" + s], targets: ["c:" + t] };
    });
    const elk = sharedElk();
    return elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.spacing.nodeNode": "64",
        "elk.layered.spacing.nodeNodeBetweenLayers": "96",
        "elk.separateConnectedComponents": "false",
      },
      children,
      edges,
    }).then((res) => {
      let maxX = 0, maxY = 0;
      for (const n of res.children) {
        const el = grid.querySelector(`[data-category="${CSS.escape(n.id.slice(2))}"]`);
        if (!el) continue;
        el.style.left = n.x + "px";
        el.style.top = n.y + "px";
        maxX = Math.max(maxX, n.x + n.width);
        maxY = Math.max(maxY, n.y + n.height);
      }
      grid.style.width = maxX + "px";
      grid.style.height = maxY + "px";
      board.style.width = maxX + 60 + "px";
      grid.classList.add("laid-out");
    }).catch((err) => {
      console.error("[wiki] overview ELK layout failed, keeping grid", err);
      grid.classList.remove("elk-grid");
    });
  }

  function dominantType(edges) {
    const counts = {};
    for (const e of edges) counts[e.type] = (counts[e.type] || 0) + 1;
    return Object.entries(counts).sort((x, y) => y[1] - x[1])[0][0];
  }

  // ── Level 2: Category detail ─────────────────────────────────────────
  function renderCategory(categoryId) {
    const D = window.WikiData, S = window.WikiState;
    const board = document.getElementById("board");
    const category = D.categoriesById.get(categoryId);
    const topics = D.topicsByCategory.get(categoryId) || [];
    const collapsed = S.get().collapsedTopics;

    const selectedUnitId = (() => {
      const sel = S.get().selected;
      return sel && sel.kind === "unit" ? sel.id : null;
    })();

    let html = '<div class="category-detail masonry">';
    for (const t of topics) {
      const units = D.unitsByTopic.get(t.slug) || [];
      // All topics start expanded; only an explicit click on the title bar
      // collapses one (and that survives navigation via collapsedTopics).
      const isCollapsed = collapsed.has(t.slug);
      html += `<section class="topic-group ${isCollapsed ? "collapsed" : ""}" data-topic="${esc(t.slug)}" title="Drag to move this group">`;
      html += `<div class="topic-head" data-toggle="${esc(t.slug)}">`;
      html += `<span class="tg-toggle"><span class="caret">▼</span><h4>${esc(t.shortTitle)}</h4></span>`;
      html += `<span class="t-sub">${units.length} units · ${t.commitCount} commits</span>`;
      html += `<span class="t-open" data-open-topic="${esc(t.slug)}">details →</span>`;
      html += `</div>`;
      html += `<div class="collapsed-hint">${units.length} unit${units.length === 1 ? "" : "s"} hidden — click to expand</div>`;
      html += `<div class="unit-grid">`;
      for (const u of units) {
        html += `<div class="unit-card${u.id === selectedUnitId ? " selected" : ""}" data-unit="${esc(u.id)}">`;
        html += `<span class="u-kind ${esc(u.kind)}">${esc(u.kind)}</span>`;
        html += `<h5>${esc(u.shortTitle)}</h5>`;
        html += `<p>${esc(u.summary)}</p>`;
        html += `</div>`;
      }
      html += `</div></section>`;
    }

    // Portals: other categories connected to this one (bottom row, UA-style
    // cards: color dot + name + jump arrow, connection count below)
    const portals = computePortals(categoryId);
    if (portals.length) {
      html += `<div class="portal-rail">`;
      for (const p of portals) {
        const th = D.categoriesById.get(p.categoryId);
        html += `<div class="portal" data-portal="${esc(p.categoryId)}" style="--tcolor:${th.color}" title="Open ${esc(th.shortTitle)}">`;
        html += `<div class="p-head"><span class="p-label">CATEGORY</span><span class="p-jump" data-open-category="${esc(p.categoryId)}">→</span></div>`;
        html += `<div class="p-name">${esc(th.shortTitle)}</div>`;
        html += `<div class="p-count">${p.count} connection${p.count === 1 ? "" : "s"}</div>`;
        html += `</div>`;
      }
      html += `</div>`;
    }
    html += "</div>";
    board.innerHTML = html;

    // Wire interactions
    function toggleGroup(group, slug) {
      const next = new Set(S.get().collapsedTopics);
      const isNowCollapsed = group.classList.toggle("collapsed");
      if (isNowCollapsed) next.add(slug);
      else next.delete(slug);
      S.set({ collapsedTopics: next }, { silent: true });
      // Box size is constant across collapse/expand (spatial stability),
      // so no masonry relayout — just re-promote the edges.
      drawCategoryEdges(categoryId);
      refreshSpotlight();
    }
    board.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        // Collapse only when the title/caret zone is clicked; the rest of the
        // header bar is the drag handle, and "details" opens the panel.
        if (!ev.target.closest(".tg-toggle")) return;
        toggleGroup(el.closest(".topic-group"), el.dataset.toggle);
      });
    });
    // A collapsed group's whole body ("N units hidden — click to expand")
    // expands it; the header keeps its own toggle.
    board.querySelectorAll(".topic-group").forEach((sec) => {
      sec.addEventListener("click", (ev) => {
        if (!sec.classList.contains("collapsed")) return;
        if (ev.target.closest(".topic-head")) return;
        toggleGroup(sec, sec.dataset.topic);
      });
    });
    board.querySelectorAll("[data-open-topic]").forEach((el) => {
      el.addEventListener("click", () => {
        S.set({ selected: { kind: "topic", id: el.dataset.openTopic } });
      });
    });
    const redraw = () => { drawCategoryEdges(categoryId); refreshSpotlight(); };
    board.querySelectorAll(".unit-card").forEach((el) => {
      el.addEventListener("click", () => {
        S.set({ selected: { kind: "unit", id: el.dataset.unit } });
      });
      el.addEventListener("mouseenter", () => highlightUnit(el.dataset.unit, true));
      el.addEventListener("mouseleave", () => highlightUnit(el.dataset.unit, false));
      // ELK-placed cards are absolute and individually draggable.
      if (el.closest(".topic-group.elk-cards")) window.WikiDrag.enable(el, redraw);
    });
    // Topic groups drag from anywhere on the group (same as overview cards);
    // the title zone still collapses, "details" still opens, and dragging a
    // child unit card moves just that card (it stops propagation).
    board.querySelectorAll(".topic-group").forEach((g) => {
      window.WikiDrag.enable(g, redraw);
    });
    board.querySelectorAll(".portal").forEach((el) => window.WikiDrag.enable(el, redraw));
    // Portal = the cross-category card: single click inspects it in the panel,
    // jump arrow or double-click travels to that category.
    board.querySelectorAll("[data-portal]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-open-category]")) {
          S.set({ level: "category", categoryId: el.dataset.portal, selected: null });
          return;
        }
        S.set({ selected: { kind: "category", id: el.dataset.portal } });
      });
      el.addEventListener("dblclick", () => {
        S.set({ level: "category", categoryId: el.dataset.portal, selected: null });
      });
    });

    requestAnimationFrame(() => {
      // .catch → masonry so a layout failure never leaves the cards stuck
      // hidden (the .category-detail is visibility:hidden until .laid-out). The
      // trailing .then always runs (catch resolves), so edges get (re)drawn and
      // any lingering overview edges are cleared regardless of outcome.
      layoutCategory(board, categoryId)
        .catch((err) => {
          console.error("[wiki] layoutCategory failed, falling back to masonry", err);
          layoutMasonry(board);
        })
        .then(() => {
          drawCategoryEdges(categoryId);
          refreshSpotlight();
          settleCamera();
        });
    });
  }

  // ── ELK layered layout (edge-driven, UA-style) ────────────────────
  // Two-level layout. Pass 1 lays out each topic's INTERIOR: cards that take
  // part in an intra-topic edge go through an ELK sub-layout (edge-driven
  // vertical stacks), while the topic's edge-less cards are packed into a
  // compact grid beneath them (so a topic with many standalone units doesn't
  // sprawl into one wide row). Pass 2 places every topic group as a fixed-size
  // leaf — interior already resolved — and routes group-level edges only for
  // positioning. Edges are DRAWN later by edges.js from the cards' DOM rects
  // (see drawCategoryEdges/resolveEl), so packing cards ourselves never costs a
  // unit→unit connection.
  async function layoutCategory(board, categoryId) {
    if (!window.ELK) { layoutMasonry(board); return; }
    const D = window.WikiData;
    const detail = board.querySelector(".category-detail.masonry");
    if (!detail) return;
    const groups = [...detail.querySelectorAll(".topic-group")];
    const rail = detail.querySelector(".portal-rail");
    if (!groups.length) return;

    // Units that take part in an intra-topic edge (→ ELK-laid vertical stacks);
    // the rest of a topic's units are "isolated" and go into the compact grid.
    // Note: cross-topic / cross-category edges do NOT count — they impose no
    // in-card structure, so such units stay "isolated" for layout purposes.
    const intraUnits = new Set();
    const edgedUnits = new Set(); // units in ANY edge (intra OR cross-boundary)
    for (const e of D.edges) {
      edgedUnits.add(e.from);
      edgedUnits.add(e.to);
      const tf = D.unitsById.get(e.from), tt = D.unitsById.get(e.to);
      if (tf && tt && tf.topicSlug === tt.topicSlug) {
        intraUnits.add(e.from);
        intraUnits.add(e.to);
      }
    }

    const elk = sharedElk();

    try {
      // Pass 1 — lay out EVERY topic's interior. A topic with no intra-topic
      // edges still goes through here so its units use the same ≤ISO_COLS grid
      // (layoutTopicInterior skips the ELK sub-call when nothing is connected).
      const interior = new Map(); // slug -> { cards: Map(unitId->{x,y,w}), width, height }
      for (const g of groups) {
        g.style.width = COL_W + "px"; // measure cards at the standard width
        await layoutTopicInterior(elk, g, g.dataset.topic, intraUnits, edgedUnits, interior);
      }

      // Pass 2 — place every group as a fixed-size leaf (interior resolved above).
      const elkChildren = groups.map((g) => {
        const it = interior.get(g.dataset.topic);
        return { id: "g:" + g.dataset.topic, width: it.width, height: it.height };
      });
      // Group-level edges (positioning influence only; drawing is DOM-based).
      const elkEdges = [];
      let ei = 0;
      for (const e of D.edges) {
        if (D.categoryOfUnit(e.from) !== categoryId || D.categoryOfUnit(e.to) !== categoryId) continue;
        const s = "g:" + D.unitsById.get(e.from).topicSlug;
        const t = "g:" + D.unitsById.get(e.to).topicSlug;
        if (s === t) continue;
        elkEdges.push({ id: "e" + ei++, sources: [s], targets: [t] });
      }

      const res = await elk.layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "DOWN",
          "elk.spacing.nodeNode": "48",
          "elk.layered.spacing.nodeNodeBetweenLayers": "76",
          // One component: isolated (edge-less) groups join layer 0 — the top
          // row — instead of being packed beside the connected component.
          "elk.separateConnectedComponents": "false",
          "elk.padding": "[top=0,left=0,right=0,bottom=0]",
        },
        children: elkChildren,
        edges: elkEdges,
      });

      let maxX = 0, maxY = 0;
      for (const node of res.children) {
        const slug = node.id.slice(2);
        const g = detail.querySelector(`[data-topic="${CSS.escape(slug)}"]`);
        if (!g) continue;
        g.style.left = node.x + "px";
        g.style.top = node.y + "px";
        g.style.width = node.width + "px";
        g.style.height = node.height + "px";
        maxX = Math.max(maxX, node.x + node.width);
        maxY = Math.max(maxY, node.y + node.height);
        const it = interior.get(slug);
        if (it) {
          g.classList.add("elk-cards");
          for (const [unitId, p] of it.cards) {
            const card = g.querySelector(`[data-unit="${CSS.escape(unitId)}"]`);
            if (!card) continue;
            card.style.left = p.x + "px";
            card.style.top = p.y + "px";
            card.style.width = p.w + "px";
          }
        }
      }
      if (rail) {
        rail.style.left = "0px";
        rail.style.top = maxY + COL_GAP + "px";
        rail.style.width = maxX + "px";
        maxY += COL_GAP + rail.offsetHeight;
      }
      detail.style.width = maxX + "px";
      detail.style.height = maxY + "px";
      board.style.width = maxX + 60 + "px";
      detail.classList.add("laid-out");
    } catch (err) {
      console.error("[wiki] ELK layout failed, falling back to masonry", err);
      layoutMasonry(board);
    }
  }

  // Lay out one topic's interior: pack the edge-less ("isolated") cards into a
  // compact grid at the TOP (right under the header), then ELK the edge-connected
  // cards as vertical stacks BELOW it. Edge-less units up top keeps them out of
  // the connected flow (no "mixed in" look) and gives them the first-layer slot.
  // Records each card's group-relative position + the group's final size in
  // `interior` so the category pass can treat the group as a fixed leaf.
  async function layoutTopicInterior(elk, g, slug, intraUnits, edgedUnits, interior) {
    const D = window.WikiData;
    const allCards = [...g.querySelectorAll(".unit-card")];
    const connected = allCards.filter((c) => intraUnits.has(c.dataset.unit));
    // Isolated = no intra-topic edge. Order them so units with a cross-boundary
    // edge (connection points to other topics/categories) come first and pure
    // orphans (no edge at all) trail — a stable partition that keeps the outward
    // links grouped at the front of the grid.
    const isolated = allCards
      .filter((c) => !intraUnits.has(c.dataset.unit))
      .sort((a, b) => (edgedUnits.has(b.dataset.unit) ? 1 : 0) - (edgedUnits.has(a.dataset.unit) ? 1 : 0));
    const cards = new Map(); // unitId -> { x, y, w }
    const padL = 20, padR = 22;
    let width = 0;

    // 1) Isolated cards → compact ≤ISO_COLS grid at the top.
    let y = 54; // clears the topic header
    if (isolated.length) {
      const cardW = isolated[0].offsetWidth;
      const cols = Math.max(1, Math.min(ISO_COLS, isolated.length));
      for (let row = 0; row * cols < isolated.length; row++) {
        const rowCards = isolated.slice(row * cols, row * cols + cols);
        let rowH = 0;
        rowCards.forEach((c, col) => {
          const x = padL + col * (cardW + ISO_GAP_X);
          cards.set(c.dataset.unit, { x, y, w: cardW });
          rowH = Math.max(rowH, c.offsetHeight);
          width = Math.max(width, x + cardW + padR);
        });
        y += rowH + ISO_GAP_Y;
      }
    }
    let bottom = isolated.length ? y - ISO_GAP_Y : 54;

    // 2) Connected cards → ELK sub-layout (intra-topic edges), shifted to start
    //    below the isolated block. ELK lays out with its own top padding; we
    //    translate the whole block down so it sits under the isolated grid.
    if (connected.length) {
      const sub = await elk.layout({
        id: "sub:" + slug,
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "DOWN",
          "elk.padding": "[top=54,left=20,right=20,bottom=22]",
          "elk.spacing.nodeNode": "44",
          "elk.layered.spacing.nodeNodeBetweenLayers": "70",
        },
        children: connected.map((c) => ({ id: "u:" + c.dataset.unit, width: c.offsetWidth, height: c.offsetHeight })),
        edges: D.edges
          .filter((e) => {
            const uf = D.unitsById.get(e.from), ut = D.unitsById.get(e.to);
            return uf && ut && uf.topicSlug === slug && ut.topicSlug === slug;
          })
          .map((e, i) => ({ id: "ie" + i, sources: ["u:" + e.from], targets: ["u:" + e.to] })),
      });
      let subTop = Infinity;
      for (const c of sub.children || []) subTop = Math.min(subTop, c.y);
      if (!isFinite(subTop)) subTop = 54;
      const dy = isolated.length ? y - subTop : 0; // start below the isolated grid
      for (const c of sub.children || []) {
        cards.set(c.id.slice(2), { x: c.x, y: c.y + dy, w: c.width });
        bottom = Math.max(bottom, c.y + c.height + dy);
      }
      width = Math.max(width, sub.width || 0);
    }

    interior.set(slug, { cards, width: width || COL_W, height: bottom + 22 });
  }

  // Position topic groups in side-by-side masonry columns (shortest column
  // first), with the portal rail as an extra column on the right. Absolute
  // positioning inside .category-detail; the board width grows to fit.
  function layoutMasonry(board) {
    const detail = board.querySelector(".category-detail.masonry");
    if (!detail) return;
    const groups = [...detail.querySelectorAll(".topic-group")];
    const rail = detail.querySelector(".portal-rail");
    if (!groups.length) return;

    const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(groups.length))));
    for (const g of groups) g.style.width = COL_W + "px";
    const heights = new Array(cols).fill(0);
    for (const g of groups) {
      let col = 0;
      for (let i = 1; i < cols; i++) if (heights[i] < heights[col]) col = i;
      g.style.left = col * (COL_W + COL_GAP) + "px";
      g.style.top = heights[col] + "px";
      heights[col] += g.offsetHeight + COL_GAP;
    }

    const width = cols * (COL_W + COL_GAP) - COL_GAP;
    // Portal rail sits below the columns as a full-width horizontal row
    let height = Math.max(...heights) - COL_GAP;
    if (rail) {
      rail.style.left = "0px";
      rail.style.top = height + COL_GAP + "px";
      rail.style.width = width + "px";
      height += COL_GAP + rail.offsetHeight;
    }
    detail.style.width = width + "px";
    detail.style.height = height + "px";
    board.style.width = width + 60 + "px";
    detail.classList.add("laid-out");
  }

  // After a level renders: focus the selected card if there is one, otherwise
  // fit the whole level into the viewport.
  function settleCamera() {
    const s = window.WikiState.get();
    let el = null;
    if (s.selected) {
      if (s.selected.kind === "unit") el = document.querySelector(`[data-unit="${s.selected.id}"]`);
      else if (s.selected.kind === "topic") el = document.querySelector(`[data-topic="${s.selected.id}"]`);
    }
    if (el) window.WikiCamera.focusOn(el, { scale: 1 });
    else window.WikiCamera.fit({ animate: true });
  }

  function computePortals(categoryId) {
    const D = window.WikiData;
    const counts = new Map();
    for (const e of D.edges) {
      const ta = D.categoryOfUnit(e.from), tb = D.categoryOfUnit(e.to);
      if (ta === categoryId && tb !== categoryId) counts.set(tb, (counts.get(tb) || 0) + 1);
      else if (tb === categoryId && ta !== categoryId) counts.set(ta, (counts.get(ta) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ categoryId: id, count }))
      .sort((a, b) => b.count - a.count);
  }

  // Resolve a unit to its visible representative element inside the category view:
  //   expanded topic  → the unit card itself
  //   collapsed topic → the topic group header
  //   other category     → that category's portal box
  function resolveEl(unitId, categoryId) {
    const D = window.WikiData;
    const board = document.getElementById("board");
    const u = D.unitsById.get(unitId);
    if (!u) return null;
    const t = D.topicsBySlug.get(u.topicSlug);
    if (t.categoryId !== categoryId) {
      return board.querySelector(`[data-portal="${t.categoryId}"]`);
    }
    const card = board.querySelector(`[data-unit="${unitId}"]`);
    // Collapsed groups keep their box size (cards merely visibility:hidden),
    // so visibility is decided by the group's collapsed class, not offsetParent.
    if (card && !card.closest(".topic-group.collapsed")) return card;
    return board.querySelector(`[data-topic="${t.slug}"]`); // collapsed group
  }

  function drawCategoryEdges(categoryId) {
    const D = window.WikiData;
    const layer = window.WikiEdges.clear();
    const drawn = new Set(); // dedupe promoted pairs

    for (const e of D.edges) {
      const ta = D.categoryOfUnit(e.from), tb = D.categoryOfUnit(e.to);
      if (ta !== categoryId && tb !== categoryId) continue;

      const fromEl = resolveEl(e.from, categoryId);
      const toEl = resolveEl(e.to, categoryId);
      if (!fromEl || !toEl || fromEl === toEl) continue;

      // Dedupe edges that promoted onto the same element pair (e.g. several
      // unit edges collapsing onto one topic header or portal)
      const pairKey = pk(fromEl) + ">" + pk(toEl) + ":" + e.type;
      if (drawn.has(pairKey)) continue;
      drawn.add(pairKey);

      const isPortalEdge = fromEl.hasAttribute("data-portal") || toEl.hasAttribute("data-portal");
      window.WikiEdges.draw(layer, {
        fromEl, toEl,
        type: e.type,
        width: 1 + (e.confidence - 0.6) * 4,        // 0.6→1.0, 0.9→2.2
        opacity: isPortalEdge ? 0.45 : 0.3 + (e.confidence - 0.6) * 1.6,
        dashed: isPortalEdge,
        label: e.type,
        key: e.from + ">" + e.to,
        onClick: () => window.WikiState.set({ selected: { kind: "unit", id: e.from } }),
        onHover: (on) => {
          const l = document.getElementById("edge-layer");
          if (on) window.WikiEdges.dimAllExcept(l, (k) => k === e.from + ">" + e.to);
          else refreshSpotlight();
        },
      });
    }
  }

  function pk(el) {
    return el.dataset.unit || el.dataset.topic || el.dataset.portal || "x";
  }

  // Dim everything not adjacent to unitId; null restores the neutral state.
  function dimToUnit(unitId) {
    const layer = document.getElementById("edge-layer");
    const D = window.WikiData;
    if (!unitId) {
      window.WikiEdges.undim(layer);
      document.querySelectorAll(".unit-card.dimmed").forEach((el) => el.classList.remove("dimmed"));
      return;
    }
    const neighbors = new Set([unitId]);
    for (const r of D.adj.get(unitId) || []) neighbors.add(r.peer);
    window.WikiEdges.dimAllExcept(layer, (k) => {
      const [f, t] = k.split(">");
      return f === unitId || t === unitId;
    });
    document.querySelectorAll(".unit-card").forEach((el) => {
      el.classList.toggle("dimmed", !neighbors.has(el.dataset.unit));
    });
  }

  function lockedUnitId() {
    const sel = window.WikiState.get().selected;
    return sel && sel.kind === "unit" ? sel.id : null;
  }

  // Locked spotlight: the selected unit's edges flow (marching dashes) and
  // everything else dims, until the selection is cleared (canvas click / Esc)
  // or moves to another card.
  function applySpotlight(unitId) {
    const layer = document.getElementById("edge-layer");
    layer.querySelectorAll("g.edge-flow").forEach((g) => g.classList.remove("edge-flow"));
    // Lift the edge layer above the cards while focused, so highlighted edges
    // can't be hidden behind unrelated topic boxes that sit between endpoints.
    layer.classList.toggle("spotlight", !!unitId);
    dimToUnit(unitId);
    if (!unitId) return;
    layer.querySelectorAll("g[data-edge-key]").forEach((g) => {
      const [f, t] = g.dataset.edgeKey.split(">");
      if (f === unitId || t === unitId) g.classList.add("edge-flow");
    });
  }

  // Re-assert the spotlight for the current selection (used after temporary
  // hover overrides and after edges are redrawn).
  function refreshSpotlight() {
    applySpotlight(lockedUnitId());
  }

  // Hover preview — only active while no selection is locked, so it never
  // fights the spotlight.
  function highlightUnit(unitId, on) {
    if (lockedUnitId()) return;
    dimToUnit(on ? unitId : null);
  }

  function render() {
    const s = window.WikiState.get();
    if (s.level === "category" && s.categoryId) renderCategory(s.categoryId);
    else renderOverview();
    renderBreadcrumb();
  }

  // Redraw only the edges for the current view (edge colors are read live from
  // CSS vars, so this re-colors them after a theme switch).
  function redrawEdges() {
    const s = window.WikiState.get();
    if (s.level === "category" && s.categoryId) { drawCategoryEdges(s.categoryId); refreshSpotlight(); }
    else drawOverviewEdges();
  }

  function renderBreadcrumb() {
    const D = window.WikiData, S = window.WikiState;
    const s = S.get();
    const bc = document.getElementById("breadcrumb");
    let html = "";
    if (s.level === "overview") {
      html = `<span class="crumb current">Project Overview</span>`;
    } else {
      const th = D.categoriesById.get(s.categoryId);
      html = `<span class="crumb" data-nav="overview">Project</span>` +
        `<span class="sep">›</span>` +
        `<span class="crumb current">${esc(th ? th.shortTitle : s.categoryId)}</span>` +
        `<span class="esc-hint">(Esc to go back)</span>`;
    }
    bc.innerHTML = html;
    bc.querySelectorAll("[data-nav=overview]").forEach((el) => {
      el.addEventListener("click", () => S.set({ level: "overview", categoryId: null, selected: null }));
    });
  }

  window.WikiViews = { render, redrawEdges, highlightUnit, drawCategoryEdges, applySpotlight, refreshSpotlight };
})();
