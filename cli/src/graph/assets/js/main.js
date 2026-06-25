// main.js — boot: load data, first render, global event wiring.
// Plain script; runs last.

(function () {
  "use strict";

  function wireGlobalKeys() {
    document.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      const S = window.WikiState;
      if (e.key === "Escape") {
        const s = S.get();
        if (s.selected) S.set({ selected: null });
        else if (s.level === "category") S.set({ level: "overview", categoryId: null, selected: null });
      } else if (e.key === "Backspace" && S.canGoBack()) {
        e.preventDefault();
        S.goBack();
      }
    });
  }

  function wireSearch() {
    const box = document.getElementById("searchbox");
    const results = document.getElementById("search-results");
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    function run(q) {
      const D = window.WikiData;
      q = q.trim().toLowerCase();
      if (!q) { results.hidden = true; return; }
      const hits = [];
      for (const t of D.topics) {
        if ((t.shortTitle + " " + t.title + " " + t.summary).toLowerCase().includes(q)) {
          hits.push({ kind: "topic", id: t.slug, title: t.shortTitle, sub: t.summary });
        }
      }
      for (const u of D.units) {
        if ((u.shortTitle + " " + u.summary).toLowerCase().includes(q)) {
          const t = D.topicsBySlug.get(u.topicSlug);
          hits.push({ kind: "unit", id: u.id, title: u.shortTitle, sub: t ? t.shortTitle : "" });
        }
        if (hits.length > 20) break;
      }
      if (!hits.length) {
        results.innerHTML = `<div class="sr-empty">No matches</div>`;
      } else {
        results.innerHTML = hits.slice(0, 20).map((h) =>
          `<div class="sr-item" data-kind="${h.kind}" data-id="${esc(h.id)}">` +
          `<span class="sr-kind">${h.kind}</span><span class="sr-title">${esc(h.title)}</span>` +
          `<div class="sr-sub">${esc(h.sub)}</div></div>`
        ).join("");
      }
      results.hidden = false;
      results.querySelectorAll(".sr-item").forEach((el) => {
        el.addEventListener("click", () => {
          const D2 = window.WikiData, S = window.WikiState;
          results.hidden = true;
          box.value = "";
          if (el.dataset.kind === "topic") {
            const t = D2.topicsBySlug.get(el.dataset.id);
            S.set({ level: "category", categoryId: t.categoryId, selected: { kind: "topic", id: t.slug } });
          } else {
            const u = D2.unitsById.get(el.dataset.id);
            const t = D2.topicsBySlug.get(u.topicSlug);
            S.set({ level: "category", categoryId: t.categoryId, selected: { kind: "unit", id: u.id } });
          }
        });
      });
    }

    let timer = null;
    box.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(box.value), 160);
    });
    document.addEventListener("click", (ev) => {
      if (!results.contains(ev.target) && ev.target !== box) results.hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== box) {
        const tag = (document.activeElement && document.activeElement.tagName) || "";
        if (tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); box.focus(); }
      }
    });
  }

  function wireCanvasClear() {
    // Clicking the empty board (outside every card) releases the locked selection,
    // so the panel falls back to the current category's summary — the third
    // category-page detail level (unit / topic / category). The whole topic card
    // is excluded (its own handler selects the topic), as are units, portals,
    // category cards, and controls. The camera's capture-phase handler already
    // suppresses the click that follows a drag-pan.
    document.getElementById("main").addEventListener("click", (e) => {
      if (e.target.closest(".unit-card, .topic-group, .portal, .category-card, .zoom-controls, .edge-hit")) return;
      const S = window.WikiState;
      if (S.get().selected) S.set({ selected: null });
    });
  }

  function wireTheme() {
    // The webview <body> carries VS Code's theme class (vscode-light /
    // vscode-dark / vscode-high-contrast) and the CSS keys off it, so the graph
    // follows the editor theme automatically — there is no manual toggle. SVG
    // edge strokes are computed from CSS vars at draw time (not live var()
    // references), so repaint them whenever VS Code flips the <body> theme class.
    const observer = new MutationObserver(() => {
      if (window.WikiViews && window.WikiViews.redrawEdges) window.WikiViews.redrawEdges();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  function wireResize() {
    // Canvas geometry is independent of the viewport (fixed board widths,
    // pan/zoom transform) — on resize just re-fit when nothing is selected.
    let timer = null;
    window.addEventListener("resize", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!window.WikiState.get().selected) window.WikiCamera.fit({ animate: false });
      }, 120);
    });
  }

  async function boot() {
    try {
      await window.WikiDataLoader.load();
    } catch (err) {
      document.getElementById("board").innerHTML =
        `<div style="padding:40px;color:#c66">Failed to load the knowledge graph data — ${err.message}.</div>`;
      return;
    }
    // Track last nav to know when a full re-render is needed vs panel-only.
    // Seed from the state the initial render already drew, so the first
    // selection isn't misread as a navigation (which would wipe its styling).
    let lastLevel = window.WikiState.get().level;
    let lastCategory = window.WikiState.get().categoryId;
    window.WikiState.subscribe((s) => {
      const navChanged = s.level !== lastLevel || s.categoryId !== lastCategory;
      lastLevel = s.level; lastCategory = s.categoryId;
      if (navChanged) {
        window.WikiViews.render();
      } else {
        // Selection-only change: refresh selected styling without relayout,
        // glide the camera to the newly selected card, and lock the spotlight
        // (flowing edges + dimmed neighbors) on it
        document.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
        if (s.selected && s.selected.kind === "unit") {
          const el = document.querySelector(`[data-unit="${s.selected.id}"]`);
          // Unit-focus rules (readability zoom + minimal pan); same path as a
          // navigation that lands on a unit (see views.settleCamera).
          if (el) { el.classList.add("selected"); window.WikiViews.focusSelectedUnit(s.selected.id); }
        } else if (s.selected && s.selected.kind === "topic") {
          // A topic card whose detail is showing in the panel — highlight it
          // (reached by click OR by Back into a topic within the same category).
          const el = document.querySelector(`[data-topic="${s.selected.id}"]`);
          if (el) el.classList.add("selected");
        } else if (s.selected && s.selected.kind === "category") {
          // A category card (overview) or portal (level 2) selected for inspection
          const el = document.querySelector(
            `.category-card[data-category="${s.selected.id}"], .portal[data-portal="${s.selected.id}"]`);
          if (el) { el.classList.add("selected"); window.WikiCamera.focusOn(el); }
        }
        window.WikiViews.refreshSpotlight();
      }
      window.WikiPanel.render();
    });

    wireTheme();
    window.WikiCamera.init();
    window.WikiViews.render();
    window.WikiPanel.render();
    wireGlobalKeys();
    wireSearch();
    wireCanvasClear();
    wireResize();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
