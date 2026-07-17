// host-bridge.js — embed adapter.
//
// When the graph runs standalone (the VS Code webview export, or opened as a
// plain file) it reads window.__EMBEDDED_GRAPH__ or fetches wiki-graph.json.
// When it runs EMBEDDED in a host page (inside an <iframe>), that host instead
// injects the graph data and the current theme over postMessage — the host
// holds any auth / network access, so the iframe makes no requests of its own.
//
// Inert unless framed: window.WikiHost.embedded is false when not in an iframe,
// and data.js only takes the handshake path when __EMBEDDED_GRAPH__ is absent,
// so the VS Code webview / export (which set __EMBEDDED_GRAPH__) never touch it.
//
// Plain script (no modules); loaded before data.js; exposes window.WikiHost.
(function () {
  "use strict";

  // True when this document is rendered inside another frame (a host page).
  var embedded = window.parent && window.parent !== window;

  // Apply host-provided CSS custom properties (already-resolved theme tokens,
  // e.g. "--vscode-editor-background" -> "hsl(0 0% 8%)") onto :root, then flip
  // the light/dark class the palette keys off. Edge strokes are computed from
  // CSS vars at draw time (not live var() refs), so repaint after a change.
  function applyTheme(theme, vars) {
    if (vars && typeof vars === "object") {
      var root = document.documentElement;
      for (var name in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, name)) {
          root.style.setProperty(name, vars[name]);
        }
      }
    }
    if (theme === "light") {
      document.body.classList.add("vscode-light");
    } else {
      document.body.classList.remove("vscode-light");
    }
    // Repaint edges only once the graph data AND views are ready. On the initial
    // data handshake WikiData isn't built yet (data.js is still resolving) — the
    // first WikiViews.render() will draw themed edges, so skip here to avoid
    // redrawEdges reading an undefined WikiData. Live theme changes (post-render)
    // have WikiData set and do repaint.
    if (window.WikiData && window.WikiViews && typeof window.WikiViews.redrawEdges === "function") {
      window.WikiViews.redrawEdges();
    }
  }

  // The host page's origin, captured from the first message it sends us. Unknown
  // until then: the initial `jolli-graph-ready` ping must broadcast because the
  // parent can be on any origin and we have no other way to reach it. Once
  // captured we pin both inbound checks and outbound targets to it, so a frame on
  // another origin can neither spoof messages to us nor observe the ones we send.
  var hostOrigin = null;

  // Only trust messages coming from our parent (host) frame. Source gating alone
  // already excludes sibling frames; the origin pin (once known) additionally
  // rejects a parent that has navigated to a different origin mid-session.
  function fromHost(event) {
    if (!embedded || event.source !== window.parent) return false;
    return hostOrigin === null || event.origin === hostOrigin;
  }

  function postToHost(type) {
    if (!embedded) return;
    // An opaque parent origin (sandboxed iframe / file://) reports as "null",
    // which is not a valid postMessage targetOrigin — broadcast in that case.
    var target = hostOrigin && hostOrigin !== "null" ? hostOrigin : "*";
    window.parent.postMessage({ type: type }, target);
  }

  // Host-activated topbar controls (progressive enhancement). The buttons live
  // in index.html but start hidden; the hosting page reveals them via the
  // handshake `host` config and can toggle them live with `jolli-graph-host`.
  // Standalone / VS Code never send these, so the buttons stay hidden there.
  function wireHostControls() {
    var closeBtn = document.getElementById("host-btn-close");
    var expandBtn = document.getElementById("host-btn-expand-tree");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        postToHost("jolli-graph-close");
      });
    }
    if (expandBtn) {
      expandBtn.addEventListener("click", function () {
        postToHost("jolli-graph-expand-tree");
      });
    }
  }

  function applyHostControls(host) {
    if (!host || typeof host !== "object") return;
    var closeBtn = document.getElementById("host-btn-close");
    var expandBtn = document.getElementById("host-btn-expand-tree");
    if (closeBtn && host.canClose === true) {
      closeBtn.hidden = false;
    }
    // The expand-tree affordance only makes sense while the host's sidebar is
    // collapsed; the host sends the current state and updates it live.
    if (expandBtn && typeof host.treeCollapsed === "boolean") {
      expandBtn.hidden = !host.treeCollapsed;
    }
    // The graph is per-repo; the host supplies the repo name so the breadcrumb
    // root reads e.g. "jolli" instead of the generic "Project" (views.js reads
    // window.WikiHost.rootLabel). Set on the initial data handshake, before the
    // first render.
    if (typeof host.repoName === "string" && host.repoName) {
      window.WikiHost.rootLabel = host.repoName;
    }
  }

  wireHostControls();

  // Live updates after boot: theme toggles and host-control state changes.
  window.addEventListener("message", function (event) {
    if (!fromHost(event)) return;
    var data = event.data;
    if (!data) return;
    if (data.type === "jolli-graph-theme") {
      applyTheme(data.theme, data.vars);
    } else if (data.type === "jolli-graph-host") {
      applyHostControls(data.host);
    }
  });

  // One-shot handshake: announce readiness to the host and resolve with the
  // graph it posts back. Rejects if the host reports a load error, or if the host
  // never replies within the timeout (otherwise data.js awaits forever and the
  // graph is stuck on the loading state — boot() renders the rejection visibly).
  var HANDSHAKE_TIMEOUT_MS = 15000;
  function requestGraph() {
    return new Promise(function (resolve, reject) {
      var timer = null;
      function cleanup() {
        window.removeEventListener("message", onMessage);
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }
      function onMessage(event) {
        if (!fromHost(event)) return;
        var data = event.data;
        if (!data || data.type !== "jolli-graph-data") return;
        hostOrigin = event.origin; // pin every later message to this host
        cleanup();
        applyTheme(data.theme, data.vars);
        applyHostControls(data.host);
        if (data.error) {
          reject(new Error(String(data.error)));
        } else {
          resolve(data.graph);
        }
      }
      window.addEventListener("message", onMessage);
      timer = setTimeout(function () {
        cleanup();
        reject(new Error("host did not provide graph data within " + HANDSHAKE_TIMEOUT_MS / 1000 + "s"));
      }, HANDSHAKE_TIMEOUT_MS);
      postToHost("jolli-graph-ready");
    });
  }

  // Announce to the host that the themed graph is on screen (so it can reveal the
  // iframe). Routed here rather than posted inline so it targets the pinned host
  // origin, not "*".
  function notifyRendered() {
    postToHost("jolli-graph-rendered");
  }

  // rootLabel: breadcrumb root override (repo name), set from the host handshake.
  window.WikiHost = {
    embedded: embedded,
    requestGraph: requestGraph,
    notifyRendered: notifyRendered,
    applyTheme: applyTheme,
    rootLabel: null,
  };
})();
