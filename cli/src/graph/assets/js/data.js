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
    } else {
      const res = await fetch("../data/wiki-graph.json");
      if (!res.ok) throw new Error("wiki-graph.json: " + res.status);
      graph = await res.json();
    }

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
    };
    return window.WikiData;
  }

  window.WikiDataLoader = { load };
})();
