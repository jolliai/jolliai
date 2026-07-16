// data.js — load wiki-graph.json and build lookup indexes.
// Plain script (no modules); exposes window.WikiData after load() resolves.
// The standalone bundle replaces fetch via window.__EMBEDDED_GRAPH__.

(function () {
  "use strict";

  // Muted jewel-tone palette for categories — deliberately avoids pure red/blue
  // (those hues belong to the supersedes/extends edge colors).
  const CATEGORY_PALETTE = [
    "#7d99c4", "#a3b577", "#cc977c", "#a995cf", "#c8a06b", "#7eb0b0",
    "#c99898", "#b5c47a", "#bc8e5c", "#9d8cc4", "#8aaab8", "#a0a0a0",
  ];

  async function load() {
    let graph;
    if (window.__EMBEDDED_GRAPH__) {
      graph = window.__EMBEDDED_GRAPH__;
    } else if (window.WikiHost && window.WikiHost.embedded) {
      // Embedded in a host page (iframe): the host posts the graph (and theme) to us.
      graph = await window.WikiHost.requestGraph();
    } else {
      const res = await fetch("../data/wiki-graph.json");
      if (!res.ok) throw new Error("wiki-graph.json: " + res.status);
      graph = await res.json();
    }

    // `related-to` / `contradicts` are SYMMETRIC relationships. The extractor
    // sometimes emits both directions (A→B and B→A) for one relationship, which
    // would otherwise draw two arrowed lines (and list two "related units") for
    // what is really a single undirected link. Collapse each symmetric pair to
    // one edge, keeping the higher-confidence side.
    //
    // Source-of-truth dedup now lives in GraphSchema.normalizeSymmetricEdges
    // (assembleGraph), so freshly-built graph.json is already clean. This block
    // is a defensive mirror that keeps graph.json files written BEFORE that
    // normalization (not yet rebuilt) from rendering the duplicate; on clean
    // data it is a no-op. Keep the two in lockstep.
    const SYMMETRIC = new Set(["related-to", "contradicts"]);
    const symKey = (e) => (e.from < e.to ? e.from + "|" + e.to : e.to + "|" + e.from) + "|" + e.type;
    const bestSym = new Map();
    for (const e of graph.edges) {
      if (!SYMMETRIC.has(e.type)) continue;
      const k = symKey(e);
      const prev = bestSym.get(k);
      // Strict `>` keeps the first occurrence on a tie — byte-identical to
      // GraphSchema.normalizeSymmetricEdges (confidence is always a number in any
      // graph.json that passed assembly validation, so no `|| 0` guard is needed).
      if (!prev || e.confidence > prev.confidence) bestSym.set(k, e);
    }
    graph.edges = graph.edges.filter((e) => !SYMMETRIC.has(e.type) || bestSym.get(symKey(e)) === e);

    // Drop a generic `related-to` when a more specific typed edge already links the
    // same unordered pair: the specific edge (extends/caused-by/supersedes/
    // contradicts) subsumes "these two are connected", so keeping both just draws
    // two redundant lines. Mirrors GraphSchema.dropSubsumedRelatedTo; keep in
    // lockstep. No-op on freshly-built (already-normalized) graph.json.
    const pairKey = (e) => (e.from < e.to ? e.from + "|" + e.to : e.to + "|" + e.from);
    const specificPairs = new Set();
    for (const e of graph.edges) {
      if (e.type !== "related-to") specificPairs.add(pairKey(e));
    }
    graph.edges = graph.edges.filter((e) => e.type !== "related-to" || !specificPairs.has(pairKey(e)));

    const categoriesById = new Map();
    graph.categories.forEach((t, i) => {
      t.color = CATEGORY_PALETTE[i % CATEGORY_PALETTE.length];
      categoriesById.set(t.id, t);
    });

    const topicsBySlug = new Map(graph.topics.map((t) => [t.slug, t]));
    const unitsById = new Map(graph.units.map((u) => [u.id, u]));

    const unitsByTopic = new Map();
    for (const u of graph.units) {
      if (!unitsByTopic.has(u.topicSlug)) unitsByTopic.set(u.topicSlug, []);
      unitsByTopic.get(u.topicSlug).push(u);
    }
    const topicsByCategory = new Map();
    for (const t of graph.topics) {
      if (!topicsByCategory.has(t.categoryId)) topicsByCategory.set(t.categoryId, []);
      topicsByCategory.get(t.categoryId).push(t);
    }

    // Per-unit adjacency (both directions, preserving edge data)
    const adj = new Map();
    for (const e of graph.edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      if (!adj.has(e.to)) adj.set(e.to, []);
      adj.get(e.from).push({ peer: e.to, dir: "out", edge: e });
      adj.get(e.to).push({ peer: e.from, dir: "in", edge: e });
    }

    const unitCategory = (u) => topicsBySlug.get(u.topicSlug)?.categoryId;

    // Category-pair aggregation for the overview level
    const categoryAgg = new Map(); // "a|b" sorted -> {a, b, edges: []}
    for (const e of graph.edges) {
      const ta = unitCategory(unitsById.get(e.from));
      const tb = unitCategory(unitsById.get(e.to));
      if (!ta || !tb || ta === tb) continue;
      const [a, b] = ta < tb ? [ta, tb] : [tb, ta];
      const key = a + "|" + b;
      if (!categoryAgg.has(key)) categoryAgg.set(key, { a, b, edges: [] });
      categoryAgg.get(key).edges.push(e);
    }

    // --- Deterministic co-change topic↔topic edges (parallel to graph.edges) ---
    // A separate layer with TOPIC endpoints (fromTopic/toTopic), NOT unit ids — so
    // it gets its own indexes and its own resolve/draw path. Older graph.json (pre
    // schema v4) lacks the field; default to [] so the viz stays a no-op there.
    const coChangeTopicEdges = graph.coChangeTopicEdges || [];
    // topic slug -> [{ peerTopic, edge }] adjacency.
    const coChangeByTopic = new Map();
    for (const e of coChangeTopicEdges) {
      if (!coChangeByTopic.has(e.fromTopic)) coChangeByTopic.set(e.fromTopic, []);
      if (!coChangeByTopic.has(e.toTopic)) coChangeByTopic.set(e.toTopic, []);
      coChangeByTopic.get(e.fromTopic).push({ peerTopic: e.toTopic, edge: e });
      coChangeByTopic.get(e.toTopic).push({ peerTopic: e.fromTopic, edge: e });
    }
    // Category-pair aggregation of co-change edges (its own map — NEVER merged into
    // categoryAgg, whose entries are unit edges the panel reads via unitsById).
    const coChangeCategoryAgg = new Map(); // "a|b" sorted -> { a, b, edges: [] }
    for (const e of coChangeTopicEdges) {
      const ca = topicsBySlug.get(e.fromTopic)?.categoryId;
      const cb = topicsBySlug.get(e.toTopic)?.categoryId;
      if (!ca || !cb || ca === cb) continue;
      const [a, b] = ca < cb ? [ca, cb] : [cb, ca];
      const key = a + "|" + b;
      if (!coChangeCategoryAgg.has(key)) coChangeCategoryAgg.set(key, { a, b, edges: [] });
      coChangeCategoryAgg.get(key).edges.push(e);
    }

    // Unified overview pairs: typed cross-category unit edges AND deterministic
    // co-change edges, merged per category pair so the overview draws ONE bubble
    // per pair regardless of which layer(s) connect them. After per-category edge
    // batching, typed cross-category edges vanish and these become co-change-only —
    // the overview still shows the cross-category structure via this merge.
    const overviewPairs = [];
    {
      const merged = new Map(); // "a|b" -> { a, b, typed: [], coChange: [] }
      const bucket = (a, b) => {
        const k = a + "|" + b;
        let p = merged.get(k);
        if (!p) { p = { a, b, typed: [], coChange: [] }; merged.set(k, p); }
        return p;
      };
      for (const agg of categoryAgg.values()) bucket(agg.a, agg.b).typed = agg.edges;
      for (const agg of coChangeCategoryAgg.values()) bucket(agg.a, agg.b).coChange = agg.edges;
      for (const p of merged.values()) {
        const count = p.typed.length + p.coChange.length;
        // Color by dominant TYPED type; co-change-only pairs use the neutral type.
        let type = "co-change";
        if (p.typed.length) {
          const c = {};
          for (const e of p.typed) c[e.type] = (c[e.type] || 0) + 1;
          type = Object.entries(c).sort((x, y) => y[1] - x[1])[0][0];
        }
        // ELK rank direction: majority direction of typed edges (a→b when most
        // point from a). Co-change is undirected → default a→b.
        let ab = 0;
        for (const e of p.typed) if (unitCategory(unitsById.get(e.from)) === p.a) ab++;
        const src = ab >= p.typed.length - ab ? p.a : p.b;
        overviewPairs.push({ a: p.a, b: p.b, count, type, src, dst: src === p.a ? p.b : p.a });
      }
    }

    window.WikiData = {
      graph,
      categories: graph.categories,
      topics: graph.topics,
      units: graph.units,
      edges: graph.edges,
      categoriesById,
      topicsBySlug,
      unitsById,
      unitsByTopic,
      topicsByCategory,
      adj,
      categoryAgg: [...categoryAgg.values()],
      overviewPairs,
      categoryOfUnit: (unitId) => unitCategory(unitsById.get(unitId)),
      categoryOfTopic: (slug) => topicsBySlug.get(slug)?.categoryId,
      // Deterministic co-change layer (topic↔topic). See above.
      coChangeTopicEdges,
      coChangeByTopic,
      coChangeCategoryAgg: [...coChangeCategoryAgg.values()],
      // Relationship types with no direction — drawn as a single line, no arrow.
      symmetricTypes: SYMMETRIC,
    };
    return window.WikiData;
  }

  // Shared unit-kind chip renderer. A unit carries `kinds[]` (1-3, primary first);
  // the primary drives the colour, the rest render as smaller secondary badges.
  // Centralised here (loaded first) so views.js and panel.js never drift. Kind
  // values come from a closed vocabulary in validated graph.json, but escape
  // defensively anyway. Callers that need spacing around the whole cluster wrap
  // the return value (see the panel's `.p-kinds`) rather than styling one chip.
  const kindEsc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  function kindBadges(kinds) {
    const list = Array.isArray(kinds) ? kinds : [];
    if (!list.length) return "";
    let html = `<span class="u-kind ${kindEsc(list[0])}">${kindEsc(list[0])}</span>`;
    for (let i = 1; i < list.length; i++) {
      html += `<span class="u-kind u-kind--sec ${kindEsc(list[i])}">${kindEsc(list[i])}</span>`;
    }
    return html;
  }
  window.WikiRender = { kindBadges };

  window.WikiDataLoader = { load };
})();
