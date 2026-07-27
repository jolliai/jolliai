# 200. Knowledge Graph Interactive Viewer

## Topic Statement

The interactive knowledge-graph viewer renders a repository's distilled knowledge model as a pan/zoom board of two navigable levels — a project overview of category cards and a per-category detail of topic groups, unit cards, cross-category portals, and typed relationship edges — with a search box, a contextual detail panel, a back/history model, and a self-contained single-file package that carries its own data and runtime so it opens directly from a local file with no server.

## Scope

**In scope:**
- The standalone package structure: how the data, stylesheet, and viewer runtime are inlined into one document, and the embedded-data convention the runtime reads.
- The data contract the viewer consumes (the graph model: categories, topics, units, unit edges, co-change topic edges, per-entity rollups, project stats, and the schema version) — as read by the viewer, not as produced.
- Client-side defensive data normalization the viewer applies on load (symmetric-edge dedup, subsumed-generic-edge drop) and the index structures it builds, including the merged per-category-pair overview model spanning both edge populations.
- The stale-schema advisory notice: when it triggers, what it says, and how it is dismissed.
- The load-failure state and the inertness of a host-supplied failure reason.
- The two board levels and the transitions between them; the breadcrumb; the central navigation state with history.
- Rendering and automatic layout of each level (overview category grid, category-detail topic masonry / engine-driven layout, isolated-unit packing, portal rail).
- Edge drawing: two stacked edge layers, layer routing rules, edge geometry/anchoring, arrowheads, count bubbles, labels, dimming, and the locked "spotlight" flow animation.
- The pan/zoom camera: fit, focus-on-element, and unit-focus rules.
- Card/group dragging.
- The detail panel's content per selection kind, including the in-panel full wiki page reading mode.
- Search behavior; keyboard shortcuts; theme adaptation; resize handling.

**Out of scope / boundaries:**
- How the graph model is distilled, validated, assembled, or persisted — the viewer receives a finished model and never writes it.
- The three host surfaces that embed this viewer (a command-line export to a single file; an editor-integrated panel; a web page embedding it in an iframe) — covered by their own specs. This spec documents only the viewer behavior they share, plus the three data-delivery conventions (inlined embedded data; a host postMessage handshake; a fetched fallback) the viewer tolerates.
- Markdown-to-HTML conversion of wiki bodies (delegated to a bundled converter; the viewer only invokes it).

## Data Contracts

### Embedded data delivery

The viewer resolves its graph model through three delivery paths, tried in order:

1. **Inlined in-page global** — a single in-page global the host injects before the runtime scripts run. If present, the viewer uses it directly (no network).
2. **Host postMessage handshake** — when that global is absent AND the document is framed inside a host, the viewer performs a postMessage handshake with the host frame (covered by the web-embed host-bridge spec).
3. **Fetched fallback** — otherwise, a fetch of a JSON file at a fixed relative path; a non-OK fetch is a fatal load error.

The standalone package and the editor panel use the embedded global; paths (2) and (3) are fallbacks.

When the host inlines the model, three sequences in the JSON are neutralized so they cannot break out of the inline-script context: the closing-script-tag sequence (case-insensitive) and the two raw line-separator characters that JSON leaves unescaped. (The latter two are inert on modern engines; the escaping is defense in depth.)

### Graph model (as consumed)

A single object with:

- **stats** — project rollups: counts of categories, topics, units, total unit edges, intra-topic edges, cross-topic edges, and the co-change topic-edge count. There is **no** cross-category unit-edge count. The panel's empty-state reads the cross-topic count **verbatim** as "links within a category" — it no longer subtracts anything, because no unit edge in produced data spans two categories — and reads the co-change count for its own row, treating an absent value as zero.
- **schemaVersion** — an integer, consumed only by the stale-schema notice (below).
- **categories** — each with an id, a short title, a summary, and rollup counts (topic count, commit count, unit count). The viewer assigns each category a display color by position in a fixed muted palette (cycled if there are more categories than palette entries; the palette deliberately omits pure red/blue, which are reserved for two edge colors).
- **topics** — each with a slug (its identity), a short title, a long title, a summary, an owning category id, rollup counts (unit count, commit count), and an optional full wiki body (long-form markdown) rendered in-panel on demand.
- **units** — each with an id (its identity), an owning topic slug, an ordered kinds list (one to three; primary first), a short title, a summary, and optional anchors (a list of file references and a list of commit references) shown as evidence.
- **edges** — each a directed pair (from-unit, to-unit) with a relationship type, a numeric confidence in [0,1], and an evidence string.
- **co-change topic edges** — a second, structurally distinct edge population whose endpoints are **topic slugs**, not unit ids. Each carries the fixed kind `co-change`, a shared-file list, a shared-file count, and an optional semantic type. Read defensively: an **absent field is treated as an empty list**, so a graph written before this population existed renders exactly as it did before, with every co-change affordance simply absent. The optional semantic type would prefix a chip's label if present, but produced data never carries one, so that label form is never rendered in practice.

Relationship types: five total. Two are **symmetric/undirected** (drawn without an arrowhead, listed without a direction marker); the other three are **directed**. A generic "related-to" type is the weakest "these two are connected" claim; any other type is more specific.

A unit carries an ordered list of one to three kinds, the first the PRIMARY. Each kind renders as a chip with a per-kind color; the primary chip is full-size, any others render smaller/dimmer as secondary badges. The primary kind also drives the unit card's left accent bar and its selected-outline color. An unknown kind still renders a chip (unstyled — no special color) and never leaks a literal "undefined". An empty or missing kinds list renders no chip.

### Derived indexes built on load

After normalization the viewer builds: category-by-id, topic-by-slug, unit-by-id, units-grouped-by-topic, topics-grouped-by-category, a per-unit adjacency list (both directions, each entry carrying the peer id, direction, and the edge), a helper mapping a **unit** to its category, a helper mapping a **topic slug** to its category, and a **category-pair aggregation** keyed by the unordered pair of distinct categories that any unit edge crosses, accumulating all crossing edges per pair (read by the category-pair panel).

Over the co-change population it additionally builds:

- a **co-change adjacency by topic slug** — both directions, each entry carrying the peer topic slug and the edge (read by the topic panel and the category-level co-change edge drawing);
- a **co-change category-pair aggregation**, keyed the same way (sorted category pair) and skipping any pair whose two topics share a category. It is a **separate map that is never merged into** the unit-edge aggregation, whose entries the panel resolves through the unit index and which would break on topic-slug endpoints;
- **merged overview pairs** — the two aggregations combined per category pair, and the only source the overview's aggregated edges draw from.

**Merged overview pairs.** One entry per unordered category pair connected by *either* population. Per entry:

- the **count is the sum** of the pair's typed unit edges and its co-change edges — one number, one bubble, regardless of how many layers connect the pair;
- the **type** is the dominant *typed* relationship type; when the pair has no typed edges at all, the type is the literal `co-change`;
- the **direction** is the majority direction of the typed edges, defaulting to the sorted-first category as source when there are no typed edges (co-change is undirected, so the direction is arbitrary for a co-change-only pair and matters only to the layout engine's ranking).

## Behaviors (execution order)

### Load-time normalization (defensive; no-op on already-clean data)

On load, before indexing, the viewer rewrites the edge list twice. This mirrors normalization the producer already applies, so freshly produced data passes through unchanged; the steps exist to clean models produced before the producer normalized:

1. **Symmetric-edge dedup.** For each symmetric edge type, collapse both orientations of one undirected pair to a single edge, keeping the higher-confidence side; on a confidence tie the first occurrence wins. Directed edges are untouched.
2. **Subsumed-generic drop.** Drop a generic "related-to" edge whenever any more-specific edge already links the same unordered unit pair.

### Boot sequence

1. Load and normalize data; **on failure** render the load-error state (below) and stop.
2. Reveal the stale-schema notice if the loaded model is stale, and wire its dismiss control (see *Stale-schema notice*).
3. Seed navigation-change tracking from the initial state so the first user selection is not misread as a navigation (which would wipe selection styling).
4. Subscribe to state changes (see *Render dispatch*).
5. Wire theme observation, initialize the camera, render the current level, render the panel, and wire global keys, search, empty-canvas click, and resize.

**Load-error state.** The board is emptied, then a single styled block is appended whose message — "Failed to load the knowledge graph data — `<reason>`." — is set as a **text node**, never as markup. The reason is not viewer-controlled: it can be a host-supplied error string delivered over the framed handshake, a fetch status line, or a handshake-timeout message. Because it is a text node, any markup inside such a string appears **literally as characters and executes nothing**. Boot returns immediately afterwards, so nothing later in the sequence runs — including the stale-schema notice, which is therefore never shown over a failed load.

### Stale-schema notice

A dismissible advisory bar, first child of the app shell and above the topbar, hidden in the markup and revealed at load time when the loaded model's schema version is older than the version this viewer was built for.

- The viewer carries its **own hand-duplicated supported-version constant** — a literal in the viewer runtime, not a value imported or injected from the producer. Keeping the two in step is a manual obligation.
- The notice triggers **only** when the model's schema version is a number **strictly less than** that constant. A **missing** version is not stale; a **non-numeric** version is not stale; a **higher** version is not stale. The check is computed once during the load, after indexing, and is a read-only signal — it never mutates the model.
- The bar reads "This graph was generated by an older version. Regenerate it for the full experience." with a `×` dismiss button labelled "Dismiss". It is a full-width translucent amber strip in the body text colour at a small type size.
- Dismissing hides the bar for the rest of the page's life and **persists nothing** — no storage, no host message, no state field — so it reappears on every reload of a still-stale model.
- It is **purely advisory**: the graph renders completely and normally either way. Nothing about rendering, layout, navigation, or the panel is gated on it, and every field introduced after the older version is read with an absent-tolerant default.
- It ships in the shared viewer template, so all three host surfaces carry it; the wiring is a no-op when the markup is absent (a host page that strips it).
- It is a **view-time** signal only. Nothing at build time, in the command-line surface, or in the editor extension inspects the schema version to warn the user.

### Navigation state and history

State carries: current **level** ("overview" or "category"), the active **category id** (when in a category), the current **selection** (a tagged value: a unit, a topic, a category, a category-pair, or a wiki page — or none), the set of **collapsed topic slugs**, and the search query.

- The "navigation" subset is level + category id + selection. A history stack (capped at 50 entries) records the prior navigation snapshot whenever any navigation field changes to a genuinely different value.
- **Returning to the clean overview** (level overview with nothing selected) **clears the entire history** — it ends a browsing session.
- Collapsed-topic changes and any change marked silent do not push history.
- Back pops the last snapshot and restores it without itself pushing history.

### Render dispatch (on every state change)

The subscriber compares the new level/category against the last-rendered ones:

- **Navigation changed** → full re-render of the board for the new level.
- **Selection-only change** → no relayout. Clear prior selected styling; then, by selection kind:
  - **unit** — mark the unit's card selected and apply the *unit-focus camera* (see below).
  - **topic** — mark the topic group selected (reached by click or by Back into a topic in the same category).
  - **category** — mark the category card (overview) or portal (category level) selected and focus the camera on it.
  - Re-assert the locked spotlight.
- The panel re-renders on every state change.

### Level 1 — Overview

- Renders one card per category: a "CATEGORY" label, a jump arrow, the short title, the summary (clamped to two lines), and a stats line ("N topics · N commits · N units"). Each card carries its category color as a left border and accent.
- An automatic **layered layout** ranks categories top-to-bottom by the direction recorded on each **merged overview pair** (upstream categories sit above the ones that build on them); categories with no cross-links land in the top row. The layout engine assigns absolute positions; the board grows to fit. If the layout fails, the cards keep a simple responsive grid. Until laid out, the grid is hidden to avoid a flash.
- **Aggregated category-pair edges** are drawn on the back layer (category cards are opaque), one per **merged overview pair** — so both edge populations collapse into a single line per category pair. Each pair-edge's width scales with the merged count (capped), is semi-transparent, carries no arrowhead, and carries a **count bubble** showing the merged count. Its colour is the pair's dominant *typed* relationship colour; a pair with typed edges draws **solid** in that colour. A pair connected **only** by co-change draws **dashed** in a neutral grey (its own theme colour token, one value for dark and one for light). Clicking a pair-edge selects that category-pair (panel lists what underlies it). Hovering it dims all other edges.
- **Single-click** a category card → select it (inspect in panel). **Jump arrow or double-click** → enter that category (level 2).

### Level 2 — Category detail

For the active category:

- Renders one **topic group** per topic: a header (caret + short title, acting as a collapse toggle and the drag handle) and a subtitle ("N units · N commits"); a collapsed hint; and a grid of **unit cards** (short title, then primary + any secondary kind chips, then two-line-clamped summary), each with a left accent bar in its primary kind's color.
- All topics start expanded. Collapsing is per-topic, survives navigation (persisted in the collapsed set), and **keeps the group's box size** (cards become hidden, a centered "N units hidden — click to expand" hint appears) so neighbors never move. Toggling a group does not relayout — it only redraws edges and refreshes the spotlight.
- **Portals** (a bottom rail): one card per *other* category connected to this one, showing a "CATEGORY" label, a jump arrow, the other category's name and color, and a connection count. The count sums **both** populations — typed unit edges crossing into that category *and* cross-category co-change edges touching this category's topics — so a category reachable only via co-change still gets a portal card. Portals are sorted by connection count descending. The portal set is load-bearing for edge drawing: it is what a far endpoint gets promoted onto.
- A selected **topic group** highlights in the current category's color; a selected **unit card** highlights in its **primary kind's color** (falling back to the category color, then a generic accent, for a unit with no kind).

**Automatic two-pass layout:**

- **Pass 1 — each topic's interior.** A topic's units that participate in an *intra-topic* edge are laid out as edge-driven vertical stacks by the layout engine; the topic's remaining ("isolated") units are packed into a compact grid (capped columns) **above** the connected stacks. Isolated units are ordered so those with a cross-boundary edge come before pure orphans. Cross-topic/cross-category edges do **not** make a unit "connected" for interior purposes. A topic with no intra-topic edges still runs through this pass (its units use the compact grid; the engine sub-call is skipped).
- **Pass 2 — place each topic group as a fixed-size leaf** (interior already resolved), using group-level edges only to influence positioning. Isolated (edge-less) groups join the top layer rather than being packed aside. The board grows to fit; the portal rail is placed as a full-width row below the columns.
- If the engine layout fails, the viewer falls back to a **masonry** layout (fixed-width columns, shortest-column-first packing, portal rail below). Until laid out, the detail is hidden to avoid a stacked-at-origin flash.

**Interactions:**

- Topic group: clicking the **title zone** (caret + title) toggles collapse; clicking a **collapsed** card's body expands it; clicking an **expanded** card anywhere else selects the topic (opens its detail in the panel); clicking a unit card selects that unit (its own handler; the group handler bails on unit clicks). Dragging from anywhere on a group moves it (except interactive controls and unit cards).
- Unit card: click selects the unit; hovering previews (dims non-neighbors) but only when no selection is locked. Engine-placed cards are individually draggable.
- Portal: single click selects (inspect in panel); jump arrow or double-click travels to that category.
- Clicking the **empty board** clears the selection → the panel falls back to the current category's summary. A drag-pan never counts as a click (the camera suppresses the trailing click).

### Edges

Two SVG layers straddle the board:

- **Back layer** (behind the board, lower z): cross-topic / cross-category unit edges between two promoted endpoints (no visible unit endpoint), plus the overview's aggregated pair-edges and **every** co-change edge. Opaque boxes occlude these, so they read as clean connectors in the gaps.
- **Front layer** (above the board, higher z): any edge with at least one visible unit-card endpoint, so it stays visible where it enters a box to reach its unit. A front edge rides above *every* box — there is no per-edge occlusion, so it may thread over an unrelated box it merely passes (accepted over fragile masking).

**Endpoint promotion** (category level): each unit-edge endpoint resolves to its visible representative — the unit card if its topic is expanded; the topic group header if its topic is collapsed; the other category's portal if the unit lives in another category. Edges whose two endpoints resolve to the same element are dropped. Edges that promote onto the same element pair (and same type) are deduped to one.

**Co-change edges** (category level) are drawn on their own path, on the **back layer only**, and only for edges touching the active category. Their endpoint resolution is deliberately coarser than unit-edge promotion: a topic endpoint in the **active** category resolves to that topic's group box — never to a unit card, even when the group is expanded — and a topic endpoint in **any other** category resolves to that category's portal card. Resolved lines are then grouped by their element pair and each group's shared-file counts are **summed** into one line per pair. Each line is dashed, arrowhead-less, at a fixed low opacity, in the neutral co-change theme colour, with width scaling with the summed shared-file count up to a cap, and carries a small `co-change` type label rather than a count bubble. Clicking a line selects the **from-endpoint topic of that group's sampled edge** — which is not necessarily the endpoint nearer the click, and not necessarily the peer of the category being viewed. Hovering dims every other edge.

**Geometry:** anchors are restricted to the top/bottom borders. Stacked cards connect bottom-of-upper → top-of-lower; same-row cards use a U-route with both anchors on the bottom borders curving through the gap below. A bezier is drawn with computed control points; the visible stroke stops at the arrowhead base so dashes never poke past the triangle. Small semicircular "nub" markers are attached to each anchored card border (as DOM children, so they ride along with hover-lift transforms).

**Styling per edge:** stroke color is read **live from theme CSS variables** at draw time (falling back to built-in constants), so a theme switch re-colors edges on redraw. Width and opacity scale with confidence; portal edges are dashed and use a fixed opacity. Symmetric types get no arrowhead. A typed edge carries its type as a small label (with a background plate); an aggregated overview edge carries a count bubble instead. Arrowheads are drawn fully opaque into a group kept as the layer's last child (so the triangle hides other edges converging on the same anchor — SVG paint order is document order).

**Clearing:** on every navigation the viewer clears both layers synchronously the instant it navigates (so the old level's edges don't float over the blank incoming board during async layout), then re-draws after layout settles.

**Dimming and spotlight:**

- Hovering an edge or a related-unit list row dims every edge except the matching one.
- A **locked selection** on a unit drives a persistent spotlight: the selected unit's edges get a marching-dash flow animation, every non-adjacent edge and non-neighbor unit card dims, and the **back layer is lifted above the boxes** while focused so a highlighted cross-edge can't hide behind a box between its endpoints. The spotlight clears when the selection is cleared (empty-canvas click / Escape) or moves to another card.

### Camera

A pan/zoom transform wraps the board (cards and both edge layers transform together, so edge geometry stays valid at any zoom). Bounds: a fixed min/max scale. Controls:

- **Wheel** zooms around the cursor; trackpad pinch (arriving as ctrl+wheel) is handled the same way.
- A bottom-left control cluster: zoom out, a live percentage readout, zoom in, and **fit-to-view**.
- **Double-click on empty canvas** zooms in around the point; double-click on a card is reserved for the "open category" gesture.
- A **drag-pan suppresses the trailing click** (capture-phase) so cards don't open after a pan.
- A start-up race guard: the underlying pan library force-pans to its start on a deferred tick; the camera queues its readiness behind that same tick and replays the last requested move once it has run.

**fit** scales all content into the viewport (clamped) and centers it. **focus-on-element**: if the element is already fully visible it only adjusts zoom in place (anchored on the element's own center) — it does not yank the board to recenter; only an off-screen/clipped element is panned to center.

**Unit-focus rules** (applied when a unit is selected, by click or by landing on it via navigation):

1. **Readability** — raise zoom only up to a readable standard; never zoom out. At/above the standard, zoom is left exactly as-is.
2. **Anchor** — pivot the zoom around the unit's own center so that center stays on the same screen pixel.
3. **Pan** only when the unit would not be fully visible, and then by the minimal amount that brings it in (translate only; scale never lowered).
4. Within the slack that still keeps the unit fully visible, **bias the pan toward revealing related units** — fit the whole unit-plus-related group when it fits, otherwise lean toward the group's center while keeping the unit fully visible. Never zoom out to fit related units; the unit's readability wins.

Related units behind a portal or otherwise unrendered resolve to no element and are skipped; a related unit hidden in a collapsed group resolves to its visible group box. Focusing a unit that is itself in a collapsed group focuses the visible group box instead.

### Dragging

Absolutely-positioned elements (overview category cards, category-level topic groups and engine-placed unit cards, portals) can be dragged. A press becomes a drag only past a small movement threshold; movement is divided by the camera scale so the element tracks the cursor at any zoom; edges redraw live (throttled) and once on drop. Drags never start from interactive controls (jump arrows, the title/caret toggle). Pointer capture is taken only after the threshold is crossed, so a pure click is never swallowed; a real drag swallows the trailing click (one-shot, capture phase) so the element doesn't also select/open.

### Detail panel

Renders by selection kind (with a **Back** button when history is non-empty):

- **Nothing selected, overview** — project header, a "Project stats" table with six rows (Categories / Topics / Units / Links within a topic / Links within a category / **Co-change links (cross-category)**), and a "How to read this" explainer. "Links within a category" is the cross-topic count read verbatim; the former "Links across categories" row is **gone**, replaced by the co-change row (which reads zero when the model carries no co-change count).
- **Nothing selected, in a category** — the current category's summary (passive: no "open" button).
- **Unit** — short title, the primary + any secondary kind chips and owning topic, summary, a "Related units" list (each row: direction arrow unless symmetric, a confidence pill, peer short title, peer topic, and the edge evidence; clicking navigates to the peer; hovering spotlights the matching edge), and evidence anchors (files, commits) when present.
- **Topic** — short title, long title, summary, an "Open full wiki page" button when the topic has a full body, a list of its units (each a quick link into the board), and — when the topic has any — a "**Co-change links — N**" section after the units. Each row shows a `co-change` chip, the peer topic's short title, and "N shared file(s)"; clicking a row travels into the peer topic's category and selects the peer topic. The section is absent entirely for a topic with no co-change edges.
- **Wiki** — the topic's full body converted from markdown and shown in-panel; the panel widens into a reading mode and scrolls to the top; Back returns to the topic.
- **Category** (selected, not entered) — summary plus an "Open category" button and its topic list; (entered) — same without the open button, with a "click a unit" hint.
- **Category-pair** — rendered when the pair has a typed aggregate **or** a co-change aggregate (and both categories resolve); otherwise the panel falls back to its empty state. A header names both categories, then a meta line reads "**X typed link(s) · Y co-change link(s)**" (replacing the old single cross-category count). Then, when present, one row per typed unit edge (type, confidence pill, "from → to" or "↔" for symmetric, and evidence) — a typed edge whose from- or to-unit is missing from the unit index is **skipped** rather than rendered with a blank endpoint. Then, when present, a "**Co-change links — N**" section listing each topic↔topic pair with a `co-change` chip, both topic short titles joined by "↔", the shared-file count, and the **full shared-file list rendered as inline code chips**; clicking a row travels to the edge's from-endpoint topic. Co-change rows carry no confidence pill and no direction (the population is undirected and unweighted beyond the file count).

Confidence pills are tiered into three bands (high / mid / low) by threshold and show the rounded percentage. Topic links and the "Open category" / "Open full wiki page" buttons are wired by event delegation.

### Search

A debounced (160 ms) substring search over topics (short title + long title + summary) and units (short title + summary), capped at 20 results, shown in a floating dropdown (kind tag, title, sub-line). Selecting a topic result navigates to its category and selects the topic; selecting a unit result navigates to its category and selects the unit. Clicking outside the dropdown (or the box) hides it. Pressing `/` (outside a text field) focuses the search box.

### Keyboard

- **Escape** in a text field blurs it; otherwise it clears a selection, or (if nothing selected and in a category) returns to the overview.
- **Backspace** (outside a text field) goes back if history allows.

### Theme and resize

- The viewer follows the host theme via a theme class on the document body; a mutation observer on that class **repaints edges** on a theme switch (edge colors are computed at draw time, not live `var()` references).
- On resize (debounced 120 ms): if nothing is selected, re-fit; otherwise leave the camera (board geometry is viewport-independent).

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Overview | Single-click category card | Overview + category selected (panel inspects) |
| Overview | Jump arrow / double-click category card / "Open category" button | Category level (selection cleared) |
| Overview | Click aggregated pair-edge | Overview + category-pair selected |
| Category | Click co-change edge line | The sampled edge's from-topic selected |
| Topic selected | Click a "Co-change links" row | Peer topic's category entered + peer topic selected |
| Stale notice shown | Click dismiss | Notice hidden for this page load only (returns on reload) |
| Category | Click empty board / Escape | Selection cleared (panel → category summary) |
| Category | Escape with nothing selected | Overview (history of this session cleared) |
| Category | Click unit card / topic body / portal | That unit / topic / category selected |
| Category | Jump arrow / double-click portal | That category entered |
| Topic selected | "Open full wiki page" | Wiki page shown in-panel (reading mode) |
| Wiki | Back / Backspace | Previous navigation (typically the topic) |
| Any | Reaching clean overview (overview + nothing selected) | History fully reset |

## Notable / Surprising Behavior

- **Front edges have no per-edge occlusion** — a front-layer edge rides above every box and may visibly thread over an unrelated box it merely passes. This was chosen deliberately over fragile per-edge masking. (Surprising; intentional.)
- **Collapsing a topic preserves the group's box size.** Cards are hidden in place rather than removed, so neighbors never shift and the spatial map stays stable. (Notable.)
- **Focus-on-element does not recenter an already-visible card** — it only adjusts zoom in place, anchored on the card's own center, to avoid a jarring "jump to center on every click." (Notable.)
- **A click never zooms out.** Unit-focus only ever raises zoom to the readability standard; at/above it, zoom is untouched. (Notable.)
- **The history fully resets on return to the clean overview** — Back does not walk back into a prior browsing session once the user has reached the top with nothing selected. (Surprising; intentional.)
- **Edge colors are baked at draw time, not via live CSS `var()`.** A theme switch therefore requires an explicit edge repaint, triggered by observing the body theme class. (Notable.)
- **The viewer carries a defensive mirror of edge normalization that is a no-op on freshly produced data** — it exists only to clean models produced before the producer normalized. (Notable.)
- **The whole board's edges are cleared synchronously on navigation, before the new layout exists**, so stale edges never float over the blank incoming board during async layout. (Notable.)
- **A single shared layout-engine instance is reused across every layout** (overview, category, and per-topic sub-layouts) because each new instance spins up a worker; rapid navigation would otherwise churn workers. (Notable.)
- **The camera defers its first move behind the pan library's own startup force-pan** and replays the last requested move, so an initial fit/focus isn't clobbered. (Notable.)
- **Aggregated overview edges sit on the back layer** because category cards are opaque, matching the "tucked behind the cards" look. (Notable.)
- **The overview collapses two edge populations into one line per category pair.** The bubble shows the *sum* of typed unit edges and co-change edges, and the line's colour comes from the typed edges only. Since produced data no longer contains cross-category typed unit edges at all, most overview lines are in practice co-change-only — dashed and neutral-coloured. (Notable.)
- **A co-change edge never anchors on a unit card.** Its endpoints are topics, so in the category view it resolves to a topic group box or a portal, even when the topic's group is fully expanded and its unit cards are visible. (Notable.)
- **Clicking a co-change line selects a sampled edge's from-topic**, not the peer topic and not the nearer endpoint — several edges are merged into one drawn line, and the selection is taken from one arbitrary member of the group. (Surprising.)
- **A portal can exist purely because of co-change.** Portal connection counts sum both populations, so a category with no typed link to the active category still gets a portal card — which is required, since the co-change edge needs an element to promote onto. (Notable.)
- **The viewer duplicates the producer's supported schema version by hand.** The stale-schema constant is a literal in the viewer runtime rather than a value imported or injected from the producer, so a producer-side bump has to be mirrored here manually or the notice silently stops firing. (Surprising; a standing maintenance obligation.)
- **The stale-schema notice fires only on a strictly-lower numeric version.** A missing or non-numeric version is not stale, and a *newer* graph than the viewer supports is not stale either — a viewer older than its data shows no warning at all. (Surprising.)
- **Dismissing the stale-schema notice persists nothing.** It reappears on every reload until the graph is regenerated. (Notable.)
- **The stale-schema notice is deliberately not wired on the load-failure path.** Boot returns from the failure branch before the notice is revealed, so a failed load never stacks an "older version" advisory on top of an error message. (Notable.)
- **The load-error message is a text node, not markup.** The failure reason can originate from a host page (over the framed handshake) or from a fetch/timeout string, so it is inserted as text: markup inside it renders as literal characters and executes nothing. (Security-relevant.)
- **The breadcrumb root label resolves from three sources in order:** a host-supplied override (repo name, when embedded), else the repo display name stamped into the graph model, else a generic "Project"/"Project Overview" fallback for a pre-field model. (Notable.)
