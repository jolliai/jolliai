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
      categoryOfUnit: (unitId) => unitCategory(unitsById.get(unitId)),
      // Relationship types with no direction — drawn as a single line, no arrow.
      symmetricTypes: SYMMETRIC,
    };
    return window.WikiData;
  }

  window.WikiDataLoader = { load };
})();
