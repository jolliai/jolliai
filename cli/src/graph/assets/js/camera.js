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

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  window.WikiCamera = { init, scale, fit, focusOn };
})();
