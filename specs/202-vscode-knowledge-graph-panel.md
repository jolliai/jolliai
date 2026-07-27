# 202. Editor Knowledge Graph Panel

## Topic Statement

The editor-integrated knowledge graph panel opens a repository's interactive knowledge graph inside an editor webview tab — one tab per repository, keyed by repo name — loading the repository's already-built graph data and serving the viewer runtime from packaged assets rather than inlining it.

## Scope

**In scope:**
- The command that opens the panel and the inputs it receives.
- Locating the repository's graph data and the empty-state message when none exists.
- The one-tab-per-repository identity model and what happens on re-open.
- The webview configuration (scripts enabled, resource roots, context retention, view column, tab title).
- How the viewer template is rewritten for the webview: the content-security policy, asset URL rewriting, and the nonce'd embedded-data injection.
- Asset-serving strategy (assets served as host-source URLs; only the graph data inlined) and the rationale.
- Error handling when assets are missing or rewriting fails.
- Theme adaptation as it pertains to the panel host.

**Out of scope / boundaries:**
- The interactive viewer's rendering, layout, navigation, camera, search, and panel behavior once loaded — owned by the interactive-viewer spec. The boundary here is the rewritten template (CSP + asset URLs + embedded data) handed to the webview; everything the viewer does with it is that spec's concern.
- How the graph data is produced — a separate build/compile step is a prerequisite; this panel only reads the result. The boundary is the on-disk graph data file.
- The sidebar tree affordance that issues the open command, and the worker/sidebar build-progress status labels (e.g. the "Building knowledge graph…" indicator). The panel only receives the open command with a repo name.

## Data Contracts

### Command input

The panel is opened by a command that receives a repository name (an optional argument). The command also has access to the extension's installed root (for assets) and a configured parent directory under which each repository's data lives. With no repo name, the command does nothing.

### Source data location

The repository's graph data is read from a fixed sub-path beneath `<parent>/<repoName>/` (a hidden `graph` data file under the project's hidden state directory). If that file does not exist, the panel is **not** opened; instead an informational message tells the user to build the knowledge wiki first and try again.

### Panel identity and lifetime

- **One panel per repository**, keyed by repo name.
- Opening a graph for a **different** repo creates a new tab alongside any existing ones, so two repositories' graphs never overwrite each other.
- Re-opening the **same** repo reveals the existing tab and **re-renders** it with freshly read data (the data is re-read on every open).
- On tab disposal, the panel removes itself from the per-repo registry, but only if the registry slot still points at this instance (a stale disposal must not evict a newer instance for the same repo).

### Webview configuration

| Property | Value |
| --- | --- |
| Tab title | "Knowledge Graph — <repoName>". |
| View column | The editor's first column. |
| Scripts | Enabled. |
| Local resource roots | The extension's installed root (so packaged assets resolve). |
| Context retention when hidden | On (the webview keeps its state when the tab is backgrounded). |

### Rewritten template contract

The packaged viewer template is rewritten with three marker-based substitutions before being set as the webview HTML. Each substitution targets an expected marker; a **missing marker is a hard error** (no silent no-op) so a drifted template can never ship a CSP-less webview or unresolved asset references.

1. **Inject a content-security policy** after the charset meta:
   - default: nothing.
   - styles: the webview host-source **plus inline styles allowed** — required because the viewer applies per-category colors via inline style *attributes*, which a nonce cannot authorize.
   - scripts: the webview host-source **plus a per-render nonce** — strict, no arbitrary inline scripts.
   - fonts: host-source. images: host-source plus data URIs.
2. **Rewrite the stylesheet link** to the webview URL for the packaged stylesheet.
3. **Replace the scripts placeholder** with, in order: vendor scripts as host-source URL script tags; then a single **nonce'd** inline script assigning the repository's graph data to the in-page embedded-data global the viewer reads; then the application scripts as host-source URL script tags. The vendor and application scripts are referenced in the same order the viewer template loads them, and the data assignment sits between them.

### Embedded-data escaping

Before inlining, three sequences in the graph JSON are neutralized so they cannot break out of the inline-script context: the closing-script-tag sequence (case-insensitive) and the two raw line-separator characters JSON leaves unescaped. (Inert on modern engines; defense in depth.) The data assignment is the **only** inline script and is the only one carrying the script nonce.

### Asset-serving strategy

The viewer runtime (the pan/zoom library, the layout engine, the markdown converter, and the viewer's own scripts and stylesheet) is served as **host-source webview URLs from the packaged assets**, *not* inlined into the page. Only the repository's graph data is inlined (as the nonce'd embedded-data global). This keeps the large runtime payload out of the activation bundle while still matching the embedded-data convention the viewer expects (so its data-loader uses the embedded global and skips its fetch fallback). A per-render nonce is generated fresh on each render.

## Behaviors (execution order)

1. The open command is invoked with a repo name. If no repo name, do nothing.
2. Compute the repository's graph data path; if the file does not exist, show the "no graph yet — build first" informational message and stop.
3. Read the graph data and call the show routine:
   - If a non-disposed panel for this repo exists: rebuild its HTML from freshly read data and reveal it in the first column.
   - Otherwise: create a new webview panel (with the configuration above), set its HTML, and register the on-dispose handler.
4. Building the HTML: verify the packaged template exists (missing assets → a clear "assets missing, reinstall/rebuild" error); read the template; resolve webview URLs for the stylesheet, vendor scripts, and application scripts; generate a nonce; escape the graph data; and apply the three marker substitutions.
5. Any error from step 3/4 is caught and surfaced to the user as an error message naming the failure; the panel is not left half-open.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Closed | Open command for repo A (graph exists) | Panel A open in the first column |
| Closed | Open command (graph missing) | No panel; informational message shown |
| Panel A open | Open command for repo A again | Panel A revealed and re-rendered from fresh data |
| Panel A open | Open command for repo B | Panel B opens alongside A; A untouched |
| Panel A open | User closes the tab | Panel A disposed; registry slot cleared only if it still points at A |

## Notable Behavior

- **One tab per repo; a second repo never overwrites the first.** Tabs are keyed by repo name, so multiple repositories' graphs coexist. (Notable.)
- **Re-opening the same repo re-reads and re-renders.** It does not merely reveal a stale tab; the data file is read again every open, so a freshly rebuilt graph shows on re-open. (Notable.)
- **The runtime is served, not inlined; only the data is inlined.** The opposite of the standalone-file export — the multi-megabyte viewer payload stays out of the activation bundle and is served as host-source URLs, while the small per-repo data rides inline behind a nonce. (Surprising vs. the export; intentional.)
- **The CSP must allow inline styles but not inline scripts.** Per-category colors are applied via inline style *attributes* (which a nonce cannot cover), so styles permit `unsafe-inline`; scripts stay strict (host-source + nonce), and the data assignment is the sole nonce'd inline script. (Surprising; intentional.)
- **A missing template marker is fatal.** A template that drifted out of sync would otherwise ship a CSP-less webview or unresolved asset URLs; the rewrite refuses rather than degrade. (Notable.)
- **A stale disposal must not evict a live panel.** The dispose handler clears the registry only when the slot still points at this instance, so a replaced-and-re-created panel for the same repo isn't nulled out by the old one's disposal. (Notable.)
- **Theme follows the host editor.** The host applies its theme class to the webview body and exposes its design tokens; the viewer's stylesheet maps onto those, so the graph adopts the active editor theme with no manual toggle. (Notable.)
- **The template carries a hidden advisory element the panel ships verbatim.** Alongside the host-control buttons, the packaged viewer template includes a hidden stale-schema notice that the viewer runtime may reveal at load time. The panel performs no wiring for it and no substitution against it — it travels through as part of the template. (Notable.)
