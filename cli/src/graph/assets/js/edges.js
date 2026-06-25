// edges.js — measure DOM card positions and draw SVG bezier edges over the board.
// Implements edge promotion: callers pass element pairs (already resolved to the
// nearest visible container), this module just draws what it's told.
// Plain script; exposes window.WikiEdges.

(function () {
  "use strict";

  const EDGE_COLORS = {
    "extends": "#5fa8ff",
    "caused-by": "#ffb347",
    "supersedes": "#ff6b6b",
    "related-to": "#5fd09c",
    "contradicts": "#c08aff",
  };

  // Resolve an edge color from the live CSS variables so it follows the active
  // (light/dark) theme; fall back to the dark-theme constants above. Read from
  // <body>, not <html>: VS Code puts the `vscode-light` theme class on <body>,
  // where the light --edge-* overrides live (documentElement only sees :root's
  // dark defaults).
  function edgeColor(type) {
    const v = getComputedStyle(document.body).getPropertyValue("--edge-" + type).trim();
    return v || EDGE_COLORS[type] || "#9a9aa8";
  }

  const svgNS = "http://www.w3.org/2000/svg";

  // The board is straddled by two SVG layers — "edge-layer" (front, intra-topic
  // edges, painted above the board) and "edge-layer-back" (cross-topic /
  // cross-category edges, painted behind the board so opaque boxes occlude
  // them). Helpers that touch "the edges" operate on both.
  function layerEls() {
    return ["edge-layer", "edge-layer-back"]
      .map((id) => document.getElementById(id))
      .filter(Boolean);
  }

  // Reset both layers and return { front, back } so callers can route each edge
  // to the right one. `back` falls back to `front` if the back layer is absent.
  function clear() {
    let front = null, back = null;
    for (const layer of layerEls()) {
      while (layer.firstChild) layer.removeChild(layer.firstChild);
      syncSize(layer);
      // Arrowheads are drawn manually into this group, kept as the LAST child
      // of the layer so dashes from other edges can never overlay a triangle
      // (SVG has no z-index — document order is paint order).
      const arrows = document.createElementNS(svgNS, "g");
      arrows.setAttribute("class", "edge-arrows");
      layer.appendChild(arrows);
      if (layer.id === "edge-layer-back") back = layer;
      else front = layer;
    }
    // Anchor nubs live on the cards themselves (so they move with card hover
    // transforms) — clear them along with the edges they belong to
    document.querySelectorAll(".card-nub").forEach((n) => n.remove());
    return { front, back: back || front };
  }

  // Attach a semicircle nub to the inside of a card's top/bottom border.
  // One per side per card; multiple edges sharing an anchor share the nub.
  function addNub(el, side) {
    if (!el || el.querySelector(`:scope > .card-nub.${side}`)) return;
    const nub = document.createElement("span");
    nub.className = "card-nub " + side;
    el.appendChild(nub);
  }

  function syncSize(layer) {
    // offsetWidth/Height are layout (untransformed) values — the SVG lives
    // inside the pan/zoom canvas and scales with it, so it must be sized in
    // canvas-local pixels, not screen pixels.
    const wrap = document.getElementById("board-wrap");
    layer.setAttribute("width", wrap.offsetWidth);
    layer.setAttribute("height", wrap.offsetHeight);
    layer.style.width = wrap.offsetWidth + "px";
    layer.style.height = wrap.offsetHeight + "px";
  }

  // Rect of an element in canvas-local coordinates: getBoundingClientRect
  // returns transformed screen values, so divide by the visual scale. The
  // ratio rect-width / offsetWidth is exact even mid-transition, unlike
  // asking the camera for its (target) scale.
  function relRect(el) {
    const wrap = document.getElementById("board-wrap");
    const w = wrap.getBoundingClientRect();
    const s = w.width / wrap.offsetWidth || 1;
    const r = el.getBoundingClientRect();
    const x = (r.left - w.left) / s, y = (r.top - w.top) / s;
    const wd = r.width / s, ht = r.height / s;
    return { x, y, w: wd, h: ht, cx: x + wd / 2, cy: y + ht / 2 };
  }

  // Anchor points are restricted to the top/bottom borders, like UA. UA can
  // use a fixed bottom(source)→top(target) pair because its layered layout
  // ranks sources above targets; our masonry doesn't rank by edge direction,
  // so the rule is geometric:
  //   stacked cards  → bottom of the upper one → top of the lower one
  //   same-row cards → U-route: both anchors on the BOTTOM borders, curve
  //                    arcs through the gap below (tops carry group headers).
  // Left/right borders never carry an anchor — the board reads top-to-bottom.
  function edgeGeometry(a, b) {
    const sameRow = Math.abs(b.cy - a.cy) < (a.h + b.h) / 2;
    if (!sameRow) {
      const down = b.cy >= a.cy;
      const p1 = { x: a.cx, y: down ? a.y + a.h : a.y };
      const p2 = { x: b.cx, y: down ? b.y : b.y + b.h };
      const dir = down ? 1 : -1;
      const bend = Math.min(130, Math.max(18,
        Math.abs(p2.y - p1.y) * 0.45 + Math.abs(p2.x - p1.x) * 0.12));
      return {
        p1, p2,
        c1: { x: p1.x, y: p1.y + dir * bend },
        c2: { x: p2.x, y: p2.y - dir * bend },
        fromSide: down ? "bottom" : "top",
        toSide: down ? "top" : "bottom",
      };
    }
    const p1 = { x: a.cx, y: a.y + a.h };
    const p2 = { x: b.cx, y: b.y + b.h };
    const bend = Math.max(26, Math.min(64, Math.abs(p2.x - p1.x) * 0.25));
    return {
      p1, p2,
      c1: { x: p1.x, y: p1.y + bend },
      c2: { x: p2.x, y: p2.y + bend },
      fromSide: "bottom",
      toSide: "bottom",
    };
  }

  function pathD(geo, pEnd) {
    const e = pEnd || geo.p2;
    return `M ${geo.p1.x} ${geo.p1.y} C ${geo.c1.x} ${geo.c1.y}, ${geo.c2.x} ${geo.c2.y}, ${e.x} ${e.y}`;
  }

  // Point ON the curve at t=0.5 — where the label/count bubble sits
  function curveMidpoint(geo) {
    return {
      x: (geo.p1.x + 3 * geo.c1.x + 3 * geo.c2.x + geo.p2.x) / 8,
      y: (geo.p1.y + 3 * geo.c1.y + 3 * geo.c2.y + geo.p2.y) / 8,
    };
  }

  // Unit tangent at the p2 end of the curve, and the arrowhead length for a
  // given edge width — shared by the arrowhead and the path pull-back.
  function endTangent(geo) {
    let ux = geo.p2.x - geo.c2.x, uy = geo.p2.y - geo.c2.y;
    const len = Math.hypot(ux, uy) || 1;
    return { ux: ux / len, uy: uy / len };
  }
  function arrowLen(spec) { return 9 + (spec.width || 1.6) * 1.4; }

  // Draw a triangle arrowhead at p2, oriented along the curve's end tangent,
  // into the layer's top-most .edge-arrows group.
  function drawArrowhead(layer, geo, spec, color) {
    const { ux, uy } = endTangent(geo);
    const p2 = geo.p2;
    const px = -uy, py = ux;
    const L = arrowLen(spec);
    const W = L * 0.45;
    const poly = document.createElementNS(svgNS, "polygon");
    poly.setAttribute("points",
      `${p2.x},${p2.y} ` +
      `${p2.x - ux * L + px * W},${p2.y - uy * L + py * W} ` +
      `${p2.x - ux * L - px * W},${p2.y - uy * L - py * W}`);
    // Fully opaque: the arrow group sits above all paths, and an opaque
    // triangle is what hides OTHER edges converging on the same anchor —
    // pulling back this edge's own line can't cover that case.
    poly.setAttribute("fill", color);
    if (spec.key) poly.dataset.edgeKey = spec.key;
    layer.querySelector("g.edge-arrows").appendChild(poly);
  }

  // Re-append the arrow group so it stays the layer's last child (= on top),
  // after the edge group itself has been appended.
  function bringArrowsToFront(layer) {
    const arrows = layer.querySelector("g.edge-arrows");
    if (arrows) layer.appendChild(arrows);
  }

  /**
   * Draw one edge between two DOM elements.
   * spec: { fromEl, toEl, type, width?, opacity?, dashed?, label?, count?,
   *         className?, onClick?, key? }
   * Returns the created <g> group.
   */
  function draw(layer, spec) {
    const a = relRect(spec.fromEl);
    const b = relRect(spec.toEl);
    const geo = edgeGeometry(a, b);
    const color = edgeColor(spec.type);
    const g = document.createElementNS(svgNS, "g");
    if (spec.key) g.dataset.edgeKey = spec.key;
    if (spec.className) g.setAttribute("class", spec.className);

    // With an arrowhead, the visible line stops at the arrow BASE — dashes
    // must never show under (or poke past) the translucent triangle.
    let pEnd = null;
    if (spec.arrow !== false) {
      drawArrowhead(layer, geo, spec, color);
      const { ux, uy } = endTangent(geo);
      const pull = arrowLen(spec) - 1.5;
      pEnd = { x: geo.p2.x - ux * pull, y: geo.p2.y - uy * pull };
    }

    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", pathD(geo, pEnd));
    path.setAttribute("class", "edge-path");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", spec.width || 1.6);
    path.setAttribute("opacity", spec.opacity != null ? spec.opacity : 0.7);
    if (spec.dashed) path.setAttribute("stroke-dasharray", "7 5");
    g.appendChild(path);

    // Invisible fat hit-area for hover/click
    if (spec.onClick || spec.onHover) {
      const hit = document.createElementNS(svgNS, "path");
      hit.setAttribute("d", pathD(geo));
      hit.setAttribute("class", "edge-hit");
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", 14);
      hit.setAttribute("fill", "none");
      if (spec.onClick) hit.addEventListener("click", spec.onClick);
      if (spec.onHover) {
        hit.addEventListener("mouseenter", () => spec.onHover(true));
        hit.addEventListener("mouseleave", () => spec.onHover(false));
      }
      g.appendChild(hit);
    }

    // Anchor nubs on the cards (DOM, not SVG, so they follow hover transforms)
    addNub(spec.fromEl, geo.fromSide);
    addNub(spec.toEl, geo.toSide);

    const mid = curveMidpoint(geo);
    if (spec.count != null) {
      const r = 11;
      const circ = document.createElementNS(svgNS, "circle");
      circ.setAttribute("cx", mid.x); circ.setAttribute("cy", mid.y); circ.setAttribute("r", r);
      circ.setAttribute("class", "edge-count-bubble");
      circ.setAttribute("stroke", color);
      g.appendChild(circ);
      const txt = document.createElementNS(svgNS, "text");
      txt.setAttribute("x", mid.x); txt.setAttribute("y", mid.y + 3.5);
      txt.setAttribute("class", "edge-count-text");
      txt.textContent = spec.count;
      g.appendChild(txt);
    } else if (spec.label) {
      const txt = document.createElementNS(svgNS, "text");
      txt.setAttribute("x", mid.x); txt.setAttribute("y", mid.y + 3);
      txt.setAttribute("class", "edge-label");
      txt.textContent = spec.label;
      g.appendChild(txt);
      layer.appendChild(g); // must be in the DOM before getBBox()
      const bb = txt.getBBox();
      const bg = document.createElementNS(svgNS, "rect");
      bg.setAttribute("x", bb.x - 5); bg.setAttribute("y", bb.y - 2.5);
      bg.setAttribute("width", bb.width + 10); bg.setAttribute("height", bb.height + 5);
      bg.setAttribute("rx", 4);
      bg.setAttribute("class", "edge-label-bg");
      g.insertBefore(bg, txt);
      bringArrowsToFront(layer);
      return g;
    }

    layer.appendChild(g);
    bringArrowsToFront(layer);
    return g;
  }

  function dimAllExcept(predicate) {
    for (const layer of layerEls()) {
      // [data-edge-key] covers both the edge groups and their arrowheads
      layer.querySelectorAll("[data-edge-key]").forEach((g) => {
        g.classList.toggle("edge-dim", !predicate(g.dataset.edgeKey));
      });
    }
  }
  function undim() {
    for (const layer of layerEls()) {
      layer.querySelectorAll("g.edge-dim").forEach((g) => g.classList.remove("edge-dim"));
    }
  }

  window.WikiEdges = { clear, draw, dimAllExcept, undim, EDGE_COLORS };
})();
