// camera.js — pan/zoom camera over the board canvas, wrapping the vendored
// @panzoom/panzoom (Timmy Willison, MIT). #board-wrap is the transformed
// "canvas"; cards and the SVG edge layer live inside it, so they move and
// scale together. With origin "0 0" the mapping is:
//   screen = canvasLayoutOrigin + scale * (localPoint + translate)
// which keeps fit/focus math a one-liner. Plain script; exposes window.WikiCamera.

(function () {
  "use strict";

  const MIN_SCALE = 0.2;
  const MAX_SCALE = 2.5;
  const FIT_MARGIN = 70;
  // Readability standard for a clicked unit: below this scale its text is too
  // small, so focusUnit zooms IN to it. At/above it the zoom is left untouched
  // (a click never zooms out). See focusUnit's rules.
  const READABLE_SCALE = 0.8;
  // Viewport padding (px) used when deciding "fully visible" / computing pans.
  const FOCUS_PAD = 16;

  let pz = null;
  let main = null;
  let canvas = null;
  let ready = false;
  let pendingOp = null;

  function init() {
    main = document.getElementById("main");
    canvas = document.getElementById("board-wrap");
    pz = window.Panzoom(canvas, {
      canvas: true,        // the parent (#main) handles pointer events: pan from empty space too
      origin: "0 0",
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
      step: 0.18,
      cursor: "grab",
    });

    // Panzoom's constructor schedules a setTimeout(0) that force-pans to its
    // start position, clobbering any camera move that lands first. Queue our
    // readiness behind it (same macrotask queue, FIFO) and replay the last
    // requested move once it has run.
    setTimeout(() => {
      ready = true;
      if (pendingOp) { const op = pendingOp; pendingOp = null; op(); }
    }, 0);

    // Wheel zoom around the cursor; trackpad pinch arrives as ctrl+wheel and
    // zoomWithWheel handles both.
    main.addEventListener("wheel", (e) => {
      e.preventDefault();
      pz.zoomWithWheel(e);
    }, { passive: false });

    // Suppress the click that fires after a drag-pan so cards don't open.
    // Capture phase runs before the cards' own click handlers.
    let downX = 0, downY = 0, dragged = false;
    main.addEventListener("pointerdown", (e) => {
      downX = e.clientX; downY = e.clientY; dragged = false;
    }, true);
    main.addEventListener("pointermove", (e) => {
      if (e.buttons && (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5)) dragged = true;
    }, true);
    main.addEventListener("click", (e) => {
      if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; }
    }, true);

    // Zoom controls + live percentage readout
    const pct = document.getElementById("zoom-pct");
    canvas.addEventListener("panzoomchange", () => {
      if (pct) pct.textContent = Math.round(pz.getScale() * 100) + "%";
    });
    wire("zoom-in", () => pz.zoomIn({ animate: true }));
    wire("zoom-out", () => pz.zoomOut({ animate: true }));
    wire("zoom-fit", () => fit({ animate: true }));

    main.addEventListener("dblclick", (e) => {
      // Double-click zooms only on empty canvas — on a card it's the
      // "open category" gesture, handled by the view.
      if (e.target.closest(".zoom-controls, .category-card, .portal, .unit-card, .topic-group")) return;
      pz.zoomToPoint(clamp(pz.getScale() * 1.5, MIN_SCALE, MAX_SCALE), e, { animate: true });
    });
  }

  function wire(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  }

  function scale() { return pz ? pz.getScale() : 1; }

  // Pan/zoom so canvas-local point (cx, cy) lands on the viewport center.
  // (cx, cy) are transform-independent, so replaying after init is safe.
  function centerOn(cx, cy, s, animate) {
    if (!ready) { pendingOp = () => centerOn(cx, cy, s, animate); return; }
    const ox = canvas.offsetLeft, oy = canvas.offsetTop; // untransformed layout origin
    const tx = (main.clientWidth / 2 - ox) / s - cx;
    const ty = (main.clientHeight / 2 - oy) / s - cy;
    pz.zoom(s, { animate });
    pz.pan(tx, ty, { animate });
  }

  // Scale the whole canvas content into the viewport and center it.
  function fit(opts) {
    if (!pz) return;
    const animate = !opts || opts.animate !== false;
    const bw = canvas.offsetWidth, bh = canvas.offsetHeight;
    if (!bw || !bh) return;
    const s = clamp(
      Math.min((main.clientWidth - FIT_MARGIN) / bw, (main.clientHeight - FIT_MARGIN) / bh),
      0.4, 1,
    );
    centerOn(bw / 2, bh / 2, s, animate);
  }

  // Bring one element into a comfortable view. If it is ALREADY fully visible,
  // we don't yank the board to recenter it (that "jump to center on every
  // click" is jarring) — we only adjust the zoom in place, scaling around the
  // element's own center so its position doesn't shift. Only when the element
  // is off-screen / clipped do we pan it to the viewport center.
  function focusOn(el, opts) {
    if (!pz || !el) return;
    // No explicit target → KEEP the current zoom (don't force a min like 0.9):
    // a plain click on an already-visible card must not yank the zoom level.
    // Callers wanting a specific readable scale pass opts.scale (e.g. settleCamera).
    const target = opts && opts.scale != null
      ? clamp(opts.scale, MIN_SCALE, MAX_SCALE)
      : scale();
    const c = canvas.getBoundingClientRect();
    const r = el.getBoundingClientRect();

    // Fully within the viewport (minus a small margin)? Keep position; only
    // change size. `keepIfVisible` lets callers force the old centering.
    const m = main.getBoundingClientRect();
    const pad = 8;
    const fullyVisible =
      r.left >= m.left + pad && r.right <= m.right - pad &&
      r.top >= m.top + pad && r.bottom <= m.bottom - pad;
    if (fullyVisible && !(opts && opts.forceCenter)) {
      if (Math.abs(target - scale()) > 0.01) {
        pz.zoomToPoint(target, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }, { animate: true });
      }
      return;
    }

    // Off-screen / clipped → center it. Visual scale from the rect itself:
    // exact even mid-transition, when getScale() already reports the target
    // while the CSS transition is still interpolating.
    const sv = c.width / canvas.offsetWidth;
    const cx = (r.left + r.width / 2 - c.left) / sv;
    const cy = (r.top + r.height / 2 - c.top) / sv;
    centerOn(cx, cy, target, true);
  }

  // Focus a clicked UNIT, following the unit-focus rules:
  //   1. Readability — only ever zoom IN, up to READABLE_SCALE; never zoom out.
  //      (At/above the standard the zoom is left exactly as-is.)
  //   2. Anchor — zoom around the unit's OWN center, so that center stays on the
  //      same screen pixel; no recentering pan when the unit stays fully visible.
  //   3. Pan only when the unit would not be fully visible, and then by the
  //      minimal amount that brings it in (translate only — scale is never lowered).
  //   4. Within the slack that still keeps the unit fully visible, bias the pan to
  //      reveal as many related units as fit; fit the whole unit+related group when
  //      it can, else keep the unit visible and lean toward the group. Never zoom
  //      out to fit related units — the unit's readability wins.
  // relatedEls: the unit's neighbor card elements (may be empty or contain nulls).
  function focusUnit(el, relatedEls, opts) {
    if (!pz || !el) return;
    if (!ready) { pendingOp = () => focusUnit(el, relatedEls, opts); return; }
    if (!canvas.offsetWidth || !canvas.offsetHeight) return; // not laid out yet → avoid /0
    const animate = !opts || opts.animate !== false;

    const c = canvas.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    const sv = c.width / canvas.offsetWidth;       // current visual scale (robust mid-transition)
    const ox = canvas.offsetLeft, oy = canvas.offsetTop;

    // Rule 1: raise the scale to the readable standard only if it is below it.
    const s = clamp(Math.max(sv, READABLE_SCALE), MIN_SCALE, MAX_SCALE);

    // Canvas-local (pre-transform) geometry of an element, from its screen rect.
    const toLocal = (rect) => ({
      cx: (rect.left + rect.width / 2 - c.left) / sv,
      cy: (rect.top + rect.height / 2 - c.top) / sv,
      w: rect.width / sv,
      h: rect.height / sv,
    });
    const u = toLocal(el.getBoundingClientRect());

    // Rule 2: anchor the unit center at its current main-local screen position, so
    // the zoom pivots there. A local point p then maps to ax + s*(p - u.center).
    const r = el.getBoundingClientRect();
    const ax = (r.left + r.width / 2) - m.left;
    const ay = (r.top + r.height / 2) - m.top;
    const box = (g) => ({
      x0: ax + s * ((g.cx - g.w / 2) - u.cx),
      x1: ax + s * ((g.cx + g.w / 2) - u.cx),
      y0: ay + s * ((g.cy - g.h / 2) - u.cy),
      y1: ay + s * ((g.cy + g.h / 2) - u.cy),
    });
    const ub = box(u);

    // Group bbox = unit ∪ related, in the same anchored main-local space.
    let gx0 = ub.x0, gx1 = ub.x1, gy0 = ub.y0, gy1 = ub.y1;
    for (const re of relatedEls || []) {
      if (!re || !re.offsetWidth) continue;
      const rb = box(toLocal(re.getBoundingClientRect()));
      gx0 = Math.min(gx0, rb.x0); gx1 = Math.max(gx1, rb.x1);
      gy0 = Math.min(gy0, rb.y0); gy1 = Math.max(gy1, rb.y1);
    }

    // Rules 3+4: minimal per-axis pan (screen px) keeping the unit fully visible
    // and revealing the group as far as that allows.
    const dx = solveAxis(FOCUS_PAD, main.clientWidth - FOCUS_PAD, ub.x0, ub.x1, gx0, gx1);
    const dy = solveAxis(FOCUS_PAD, main.clientHeight - FOCUS_PAD, ub.y0, ub.y1, gy0, gy1);

    // Compose anchored translate + the chosen screen-space pan (÷s → local units).
    const txAnchor = (ax - ox) / s - u.cx;
    const tyAnchor = (ay - oy) / s - u.cy;
    pz.zoom(s, { animate });
    pz.pan(txAnchor + dx / s, tyAnchor + dy / s, { animate });
  }

  // Minimal screen-space shift along one axis. Hard constraint: keep the unit
  // [uA,uB] fully inside [viewMin,viewMax]. Within that freedom, bring the group
  // [gA,gB] (unit ∪ related) in too — fully when it fits, else lean to its center.
  // Returns the delta closest to 0 (the smallest pan) satisfying the constraints.
  function solveAxis(viewMin, viewMax, uA, uB, gA, gB) {
    const viewLen = viewMax - viewMin;
    // Unit alone overflows the viewport → can't fully fit; center it (no slack).
    if (uB - uA > viewLen) return (viewMin + viewMax) / 2 - (uA + uB) / 2;
    const fMin = viewMin - uA, fMax = viewMax - uB; // feasible Δ keeping the unit in
    if (gB - gA <= viewLen) {
      // Group fits → minimal Δ to bring the whole group in (unit ⊆ group, so this
      // keeps the unit in too). 0 when everything is already visible.
      return clamp(0, Math.max(fMin, viewMin - gA), Math.min(fMax, viewMax - gB));
    }
    // Group too spread to fit at this scale → keep the unit fully visible and lean
    // toward the group's center as far as the unit's slack allows (no zoom-out).
    return clamp((viewMin + viewMax) / 2 - (gA + gB) / 2, fMin, fMax);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  window.WikiCamera = { init, scale, fit, focusOn, focusUnit };
})();
