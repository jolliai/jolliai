# 283. Web-Embedded Knowledge Graph Host Bridge

## Topic Statement

A guest-side adapter that lets an external host web page embed the knowledge-graph viewer inside an iframe: instead of inlined data or a same-origin fetch, the host delivers the graph model, the active theme, and host-control state to the framed viewer over a `postMessage` handshake, and the framed viewer makes no network requests of its own. The bridge also exposes host-activated topbar controls, an origin-pinned two-way message channel, live theme updates, and a "rendered" notification so the host can reveal the iframe only once the themed graph is on screen.

## Scope

**In scope:**
- Detecting whether the viewer document is running framed inside a host page.
- The one-shot handshake that requests the graph from the host and resolves (or rejects) with it, including the handshake timeout.
- The bridge as the viewer's second data-delivery path (used only when framed and no inlined global is present).
- Applying a host-provided theme: injecting resolved CSS custom-property tokens, flipping the light/dark class, and gating an edge repaint.
- Origin pinning: capturing the host origin from its first message and pinning every later inbound check and outbound target to it.
- The host-activated topbar controls (close, expand-sidebar) — how they are wired, revealed, and toggled live.
- The breadcrumb-root override supplied by the host.
- The outbound "ready" and "rendered" notifications and the two control-action notifications.
- The inert-unless-framed contract (standalone file / editor panel never take this path).

**Out of scope (boundaries):**
- The host web application itself (it lives outside this codebase); this spec documents only the guest-side protocol the framed viewer implements and the message shapes it exchanges.
- The viewer's rendering, layout, navigation, camera, search, and panel behavior once it has data — owned by the interactive-viewer spec. The boundary is the delivered model, theme, and root label; everything the viewer does with them is that spec's concern.
- The inlined-embedded-global and same-origin-fetch delivery paths (interactive-viewer spec); this spec is only the framed handshake path.
- How the graph model is produced, assembled, or persisted.
- The editor-integrated panel and the standalone single-file export (their own specs); both use the inlined global and never handshake.

## Data Contracts

### Framed-detection flag

A boolean the bridge exposes on a global host object: true when the document has a parent frame that is not itself (i.e. it is embedded). The bridge is inert when this is false — every send early-returns and the handshake path is never entered.

### Host-bridge global

A single global object the bridge publishes for the rest of the runtime:
- **embedded** — the framed-detection flag.
- **requestGraph** — begins the handshake and returns a promise of the graph model.
- **notifyRendered** — sends the rendered notification to the host.
- **applyTheme** — applies a theme payload (also invoked internally on the data reply and on live theme messages).
- **rootLabel** — the breadcrumb-root override (a repo name), or none until the host supplies one.

### Inbound messages (host → framed viewer)

Each is an object with a type discriminator:
- **graph-data** — the handshake reply. Carries the graph model, an optional theme name, optional resolved theme tokens, an optional host-control config, and an optional error string. An error string rejects the handshake; otherwise it resolves with the model.
- **graph-theme** — a live theme change after boot. Carries a theme name and resolved theme tokens.
- **graph-host** — a live host-control-state change. Carries a host-control config.

### Outbound messages (framed viewer → host)

Each is an object carrying only a type:
- **graph-ready** — the initial readiness ping that opens the handshake.
- **graph-rendered** — sent once the themed graph is on screen.
- **graph-close** — the close control was activated.
- **graph-expand-tree** — the expand-sidebar control was activated.

### Theme payload

A theme name (`light` or otherwise) plus an optional map of already-resolved CSS custom-property tokens (name → value). The tokens are resolved by the host (e.g. editor/design tokens), not computed in the frame.

### Host-control config

An optional object:
- **canClose** — when true, reveal the close control.
- **treeCollapsed** — a boolean; the expand-sidebar control is revealed only while the host's sidebar is collapsed and hidden otherwise (the host updates this live).
- **repoName** — a non-empty string sets the breadcrumb-root override on the host-bridge global.

## Behavior (execution order)

### Boot-time wiring

1. Compute the framed-detection flag.
2. Wire the host-control buttons' click handlers (present in the markup but hidden): the close button sends the close notification; the expand-sidebar button sends the expand notification.
3. Subscribe to inbound messages for the post-boot live channel (theme changes and host-control-state changes), each gated by the trust check below.
4. Publish the host-bridge global.

### Data-delivery selection (in the runtime's loader)

The loader chooses, in order: the inlined embedded global if present; else, when framed, the handshake; else the same-origin fetch fallback. So the handshake path is taken only when framed **and** no inlined global exists.

### The handshake

1. Register a one-shot inbound listener and send the readiness ping to the host. Because the host origin is not yet known, this first ping is broadcast (target `*`) — it is the only outbound message that broadcasts.
2. On the first trusted graph-data message: capture the sender's origin as the pinned host origin (all later inbound checks and outbound targets pin to it); clear the listener and the timeout; apply the theme payload; apply the host-control config; then, if the message carries an error, reject with it, else resolve with the graph model.
3. If no trusted reply arrives within the handshake timeout (a fixed 15 seconds), reject with a timeout error so the loader surfaces a visible load-error state rather than hanging on the loading screen forever.

### Inbound trust check

A message is trusted only when the document is framed, the message source is the parent frame, **and** either the host origin is not yet pinned or the message origin equals the pinned host origin. Source gating alone already excludes sibling frames; the origin pin additionally rejects a parent that navigates to a different origin mid-session. Untrusted messages are ignored.

### Outbound targeting

Once the host origin is pinned, every outbound message targets that exact origin. An opaque parent origin (a sandboxed iframe or a `file://` parent reports as the literal `null`) is not a valid target, so the bridge broadcasts (`*`) in that case. The initial readiness ping always broadcasts because no origin is known yet.

### Applying a theme

Given a theme payload: set each provided token as a CSS custom property on the document root; add the light-mode class when the theme name is `light`, otherwise remove it. Then repaint edges **only if** the graph data and the view runtime are both already initialized — on the initial handshake the data is not built yet, so the repaint is skipped and the first render draws themed edges; a live post-render theme change does repaint.

### Host-control reveal and live toggle

Given a host-control config (on the data reply and on any live host-control message): reveal the close control when close is permitted; reveal the expand-sidebar control only while the sidebar is reported collapsed, hiding it otherwise; and set the breadcrumb-root override when a non-empty repo name is supplied. The controls start hidden in the markup, so a standalone/editor viewer (which never handshakes) never shows them.

### Rendered notification

After the viewer completes its first render and wires its interactions, if the document is framed the bridge sends the rendered notification to the host (routed through the bridge so it targets the pinned host origin). The host keeps the iframe hidden until this arrives, avoiding a dark→light flash while the runtime loads. The notification is inert when not framed, and an unknown message type is ignored by any host.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Not framed | Loader runs | Bridge inert; loader uses inlined global or fetch |
| Framed, no inlined global | Loader runs | Handshake begins (ready ping broadcast) |
| Handshake open | Trusted graph-data with model | Origin pinned; theme + controls applied; resolves with model |
| Handshake open | Trusted graph-data with error | Origin pinned; theme + controls applied; rejects with error |
| Handshake open | Timeout elapses (15 s) | Rejects with timeout error (loader shows load error) |
| Rendered | Viewer's first render completes (framed) | Rendered notification sent to pinned host |
| Live | Trusted graph-theme | Theme re-applied; edges repainted |
| Live | Trusted graph-host | Controls revealed/hidden; root label updated |
| Any | Untrusted message (wrong source or origin) | Ignored |

## Notable Behavior

- **The bridge is inert unless framed.** Standalone and editor-panel viewers set the inlined global and never enter the handshake; every send early-returns when not framed.
- **Only the initial ping broadcasts; everything after pins to the host origin.** The first ready ping must broadcast because the host can be on any origin and is not yet known; the first reply captures the origin and pins all subsequent inbound checks and outbound targets to it, so another-origin frame can neither spoof nor observe. (Security-relevant.)
- **An opaque parent origin forces a broadcast target.** A sandboxed or `file://` parent reports origin `null`, which is not a valid post target, so the bridge falls back to broadcast for those.
- **The initial theme apply skips the edge repaint.** On the data handshake the graph data is not built yet; repainting then would read undefined state, so the first render is relied on to draw themed edges. Only live theme changes repaint.
- **The host reveals the iframe only after the rendered notification.** This is what prevents a theme flash while vendor scripts load.
- **Host controls are progressive enhancement.** They exist hidden in the markup and are revealed only by a host config over the handshake, so no non-embedding surface ever shows them; the expand-sidebar control additionally hides itself whenever the host's sidebar is not collapsed.
- **A missed handshake reply fails visibly rather than hanging.** The 15-second timeout rejects so the loader renders an error instead of an indefinite loading state.
- **A host-supplied error string surfaces as inert text.** The error string on a graph-data reply is host-controlled, and it reaches the viewer's load-error state as its failure reason; the viewer renders that reason as a text node, so markup inside it appears literally and executes nothing. (Security-relevant.)

## Shared Behavior

- The bridge is one of three data-delivery paths the viewer tolerates (inlined embedded global, this host handshake, same-origin fetch fallback); the delivery selection and everything the viewer does with the delivered model are owned by the interactive-viewer spec.
- The breadcrumb-root label the host supplies via the host-control config is the first-priority source in the viewer's breadcrumb-root resolution (host override → the graph model's stamped repo display name → a generic fallback).
- The theme tokens are resolved by the host (e.g. an editor's or web app's design tokens); this bridge only injects the already-resolved values.
