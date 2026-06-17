// state.js — central state + navigation history + subscriber bus.
// Plain script; exposes window.WikiState.

(function () {
  "use strict";

  const state = {
    level: "overview",        // "overview" | "category"
    categoryId: null,            // active category when level === "category"
    selected: null,           // { kind: "unit"|"topic"|"category-pair", id } | null
    collapsedTopics: new Set(), // topic slugs the user collapsed (category view)
    searchQuery: "",
  };

  const subscribers = new Set();
  const HISTORY_MAX = 50;
  const history = [];

  function snapshot() {
    return { level: state.level, categoryId: state.categoryId, selected: state.selected };
  }
  function sameNav(a, b) {
    return a.level === b.level && a.categoryId === b.categoryId &&
      JSON.stringify(a.selected) === JSON.stringify(b.selected);
  }

  function set(updates, opts) {
    const navKeys = ["level", "categoryId", "selected"];
    const touchesNav = navKeys.some((k) => Object.prototype.hasOwnProperty.call(updates, k));
    if (touchesNav && !(opts && opts.silent)) {
      const before = snapshot();
      const after = { ...before, ...updates };
      if (!sameNav(before, after)) {
        // Returning to the clean overview resets history (a browsing session ended)
        if (after.level === "overview" && after.selected == null) {
          history.length = 0;
        } else {
          history.push(before);
          if (history.length > HISTORY_MAX) history.shift();
        }
      }
    }
    Object.assign(state, updates);
    notify();
  }

  function canGoBack() { return history.length > 0; }

  function goBack() {
    if (!history.length) return false;
    const prev = history.pop();
    set({ level: prev.level, categoryId: prev.categoryId, selected: prev.selected }, { silent: true });
    return true;
  }

  function notify() {
    for (const fn of subscribers) {
      try { fn(state); } catch (err) { console.error("[state] subscriber error", err); }
    }
  }

  window.WikiState = {
    get: () => state,
    set,
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    canGoBack,
    goBack,
  };
})();
