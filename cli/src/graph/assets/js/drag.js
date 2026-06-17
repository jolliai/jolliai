// drag.js — let the user reposition cards/groups on the board by dragging.
// Works on absolutely-positioned elements (style.left/top): category cards on
// the overview, topic groups (dragged by their header) and ELK-placed unit
// cards in the category view. Movement is divided by the camera scale so the
// card tracks the cursor at any zoom; edges redraw live via the supplied
// callback. A real drag suppresses the trailing click so the card doesn't open.
// Plain script; exposes window.WikiDrag.

(function () {
  "use strict";

  const THRESHOLD = 4; // px before a press counts as a drag

  // target: the element actually moved (its style.left/top is updated).
  // redraw: called (rAF-throttled) while dragging and once on drop.
  // opts.handle: optional CSS selector — drag only starts from a matching
  //   descendant (used so a topic group drags by its header, not its body).
  function enable(target, redraw, opts) {
    opts = opts || {};
    target.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (opts.handle && !(e.target.closest && e.target.closest(opts.handle))) return;
      // Never start a drag from an interactive control inside the card
      // (jump arrows, the "details" link, or the collapse title zone).
      if (e.target.closest("[data-open-category],[data-open-topic],.p-jump,.c-jump,.t-open,.tg-toggle")) return;

      const scale = window.WikiCamera ? window.WikiCamera.scale() : 1;
      const startX = e.clientX, startY = e.clientY;
      const x0 = parseFloat(target.style.left) || 0;
      const y0 = parseFloat(target.style.top) || 0;
      let moved = false, raf = null;

      const move = (ev) => {
        if (!moved) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= THRESHOLD) return;
          // Promote to a real drag only now. Pointer capture is deferred to
          // this point on purpose: capturing on pointerdown would retarget the
          // trailing `click` to this element, swallowing a plain click's
          // selection. A pure click never captures, so its click fires normally.
          moved = true;
          target.classList.add("wiki-dragging");
          try { target.setPointerCapture(e.pointerId); } catch (_) {}
        }
        const dx = (ev.clientX - startX) / scale;
        const dy = (ev.clientY - startY) / scale;
        target.style.left = x0 + dx + "px";
        target.style.top = y0 + dy + "px";
        if (!raf) raf = requestAnimationFrame(() => { raf = null; redraw(); });
      };
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        if (!moved) return;
        target.classList.remove("wiki-dragging");
        redraw();
        // Swallow the click that the browser fires after the drag's pointerup,
        // so the card doesn't also select/open. One-shot, capture phase.
        const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
        target.addEventListener("click", swallow, { capture: true, once: true });
      };

      // stopPropagation keeps panzoom from panning when a press starts on a
      // card; pointer capture is taken later (see move) so clicks still work.
      e.stopPropagation();
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    });
  }

  window.WikiDrag = { enable };
})();
