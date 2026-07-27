# VS Code Memory-File Divergence Decoration

## Topic Statement

A file-decoration provider that paints a single-glyph badge on every memory-bank Markdown file whose on-disk content no longer matches the canonical fingerprint recorded by the system, signaling to the user that the rich system view of that file is unavailable until the edits are reverted.

## Scope

**In scope:**
- The single file decoration the provider contributes: badge glyph, tooltip text, and propagation flag.
- The path-extension filter that short-circuits the per-URI query before any divergence work is attempted.
- The divergence query itself (delegated to the bridge's cross-repository fingerprint comparison) viewed from the consumer's side: what it is asked, what it returns, what causes it to return "not diverged" without producing a badge.
- The eventing surface that lets external code request a redraw of one file's decoration or of every decoration the provider has produced.
- The provider's lifecycle: when it is registered, what surfaces VS Code automatically polls it from, and when its event emitter is torn down.
- The trigger points that fire the per-URI refresh signal (post-revert) and the all-URIs refresh signal (repository discovery churn).
- What the provider does for non-Markdown URIs, Markdown URIs outside any known memory-bank root, manifest-unknown Markdown files, and legacy manifest entries that carry no recorded fingerprint.
- The error-tolerance contract: divergence queries that throw must not propagate into VS Code's decoration pipeline, and the provider must remain functional after any individual query failure.

**Out of scope (boundaries):**
- The on-disk layout of the memory bank (parent folder, per-repository subdirectories, hidden machine-readable layer, visible per-branch layer) — covered by the memory-bank-folder-layout spec.
- The memory-bank folder browser (sidebar tree) that uses its own divergence signal to draw an in-tree marker — covered by the folder-browser spec.
- The actual fingerprint algorithm, manifest schema, manifest-entry path normalization, branch-folder mapping registry, and repository discovery walk — owned by the storage and bridge layers; here we describe only the contract presented to this provider.
- The "revert edits to system version" command itself (what it overwrites, the source it reads, the safety checks it applies) — covered by the revert-command spec.
- The one-shot informational message that appears when the user opens a diverged file via the extension's open-memory-file command — covered by the open-memory-file spec.
- Any other badge or marker drawn inside the extension's own webviews (sidebar tabs, memory-bank tree, summary panel). This provider feeds only VS Code-native file UIs.
- Other decoration providers the extension may register (e.g. a commit-files decoration). They are independent registrations with disjoint URI domains.
- Persistence: this provider keeps no on-disk state, no cache file, and no user-visible configuration.

## Data Contracts

### Input

A file URI offered to the provider by VS Code. The provider treats the URI's filesystem path as its sole input; the URI's scheme, authority, query, and fragment are not consulted.

### Divergence query

A pure delegation to the bridge, parameterized by the URI's filesystem path. The query returns a boolean. The provider's responsibilities are:
- Ask the query only when the path's basename, case-folded, ends with the literal Markdown extension.
- Treat any boolean answer as authoritative.
- Treat a thrown error as "not diverged" — VS Code's decoration pipeline must not be exposed to provider exceptions.

### Output

For each URI:
- **Badge**: a single-character glyph (a pencil-edit mark) when the divergence query returns true; nothing otherwise.
- **Tooltip**: a constant short string explaining that the file has been edited on disk and that the system view is unavailable.
- **Propagation flag**: explicitly off — the badge applies only to the file itself, never to any ancestor directory in the file tree.
- **Color / foreground**: unset; the badge uses the default foreground from the active theme.

There is no second variant of the decoration — there is exactly one badge, drawn or not drawn.

### Refresh signal

A one-shot event the provider emits to tell VS Code that the decoration of some URI(s) may have changed. Two forms:
- **Targeted**: carries a single URI; VS Code re-queries decoration for that URI only.
- **Global**: carries no URI; VS Code re-queries decoration for every URI currently visible in any file UI.

External callers reach this signal through two helpers:
- A targeted refresh, called by the revert flow after it has successfully rewritten a diverged file back to the system view.
- A global refresh, called when the set of known memory-bank repository roots churns (re-discovery has produced a different root list).

### Lifecycle contract

| Lifecycle event | Side effect |
| --- | --- |
| Construction | Captures a reference to the divergence-query source; creates a single event emitter for refresh signals. No I/O. |
| Registration | The host registers the provider once with VS Code's file-decoration registry. From that moment on, VS Code calls the provider for every file URI shown in any file UI (project explorer, memory-bank sidebar tree, quick-open list, breadcrumb, editor tab, etc.). |
| Per-URI query | Triggered by VS Code; the provider may return synchronously (for non-Markdown URIs) or asynchronously (for Markdown URIs, where it awaits the divergence query). |
| Targeted refresh helper | Fires the event with the supplied URI; VS Code re-queries that URI. |
| Global refresh helper | Fires the event with no URI; VS Code re-queries every visible URI. |
| Disposal | Tears down the event emitter. Subsequent refresh helper calls would no-op against the disposed emitter; subsequent per-URI queries are still safe to answer but no consumer should call them after dispose. |

## Behavior

### Per-URI query (the VS Code-driven hot path)

1. VS Code passes the provider a file URI.
2. The provider lower-cases the URI's filesystem path's tail and checks whether it ends with the Markdown extension. If not, the provider returns "no decoration" immediately. The divergence query is **not** invoked for non-Markdown URIs — this is the cheap fast-path that keeps the decoration pipeline acceptable when the file UI is showing thousands of mixed-type files.
3. Otherwise the provider awaits the divergence query with the absolute filesystem path.
4. The divergence query resolves to false (or throws — see error tolerance below) when any of the following hold:
   - The path is not under any known memory-bank repository root.
   - The path is under such a root but the manifest has no entry whose recorded relative path matches.
   - The path's manifest entry has no recorded fingerprint (a legacy entry written before fingerprint tracking).
   - The file does not exist on disk.
   - The file's on-disk fingerprint equals the manifest's recorded fingerprint.
5. In every false case the provider returns "no decoration".
6. The divergence query resolves to true when the path is under a known root, has a manifest entry with a recorded fingerprint, exists on disk, and the on-disk fingerprint differs from the recorded fingerprint. The provider returns the single decoration: badge glyph, constant tooltip, propagation off.

### Targeted refresh

1. An external caller invokes the targeted refresh helper with a single URI.
2. The provider fires its event with that URI.
3. VS Code re-queries the provider for that URI and repaints any visible decoration.
4. Used by the revert-edits command immediately after a successful revert, so the badge disappears without waiting for VS Code's own re-poll cycle.

### Global refresh

1. An external caller invokes the global refresh helper.
2. The provider fires its event with no URI.
3. VS Code re-queries every URI currently shown in any file UI and repaints decorations.
4. Used when the set of known memory-bank repository roots has changed (a repository under the parent has been discovered, lost, renamed, or re-keyed), because the per-URI answer for paths under the affected roots may have shifted from "outside any known root" to "inside" or vice versa.

### Error tolerance

1. If the divergence query throws or rejects, the provider treats the outcome as "not diverged" — it returns "no decoration" rather than propagating.
2. The provider does not catch the throw itself; it relies on the divergence-query implementation to swallow its own discovery / read errors and surface a boolean. The contract is symmetric: the query never throws, the provider never crashes.
3. A failed query for one URI does not affect any subsequent URI; VS Code's decoration pipeline continues to call the provider.

### Disposal

1. The host calls dispose on the provider during extension deactivation.
2. The provider disposes its internal event emitter.
3. The registration itself (the provider-to-VS Code link) is disposed by the host's disposable collection, not by the provider.

## State Transitions

The provider itself is stateless beyond the event emitter — every per-URI query is computed from scratch by re-asking the divergence query. The user-visible badge passes through three observable states for a given file:

| From | Trigger | To |
| --- | --- | --- |
| No badge | First time VS Code queries the file after the on-disk content has diverged from the manifest fingerprint | Badged |
| Badged | A successful revert command rewrites the file to match the manifest fingerprint and calls the targeted refresh helper | No badge |
| Badged | A successful system-driven write rewrites both the file and the manifest fingerprint together (e.g. a new summary supersedes the previous one) | No badge — but only after VS Code's next decoration poll, because no targeted refresh is wired for this case (see Notable Behavior) |
| Badged | The memory-bank discovery walk excludes the file's containing root (root churn) and the host fires the global refresh | No badge (the divergence query now returns "outside any known root") |
| Any | Extension deactivation | Provider disposed; VS Code unregisters the decoration source |

The badge does not have intermediate "loading" or "querying" states from the user's perspective; VS Code paints whatever the latest resolved value is and re-queries asynchronously.

## Notable Behavior

- **Single-source-of-truth registration.** The provider is registered once at activation against VS Code's global file-decoration registry; it is automatically polled for every URI shown in any file-UI surface (project explorer, memory-bank sidebar tree, quick-open list, breadcrumb, editor tab, …). No per-surface re-registration is needed. (Notable.)
- **Non-Markdown URIs short-circuit before any divergence work.** The path-extension check uses a lower-cased suffix match on the literal `.md` extension and runs before any bridge call. This is what keeps the provider cheap when the file UI is showing thousands of mixed-type files — only Markdown URIs ever incur a divergence query. (Notable; intentional.)
- **Case-folding the extension is intentional.** A file ending in `.MD` (uppercase) is treated as a Markdown file and is eligible for the badge. The system never writes uppercase-extension Markdown files itself, but a user-renamed file with an uppercase extension is still classified as Markdown and still asked about. (Notable.)
- **Path outside any known memory-bank root means "no badge".** Non-memory-bank Markdown files (a project's `README.md`, arbitrary notes outside the parent folder, etc.) are queried — the path-extension check does not know about the memory-bank root — but the divergence query resolves to false for any path that is not under a known root. This is by design: the provider answers about every URI VS Code shows it; the bridge is responsible for narrowing to memory-bank paths only. (Notable; intentional. A wider gate at the provider level would require knowing the discovered roots, which the provider does not own.)
- **Manifest-unknown paths inside a known root mean "no badge".** A Markdown file the user has placed by hand inside a memory-bank repository's subdirectory (user-placed knowledge, not system-emitted) has no manifest entry. The divergence query returns false. The badge applies only to system-emitted files that have since been hand-edited — never to user-original files. (Notable.)
- **Legacy entries without recorded fingerprints mean "no badge".** When the manifest entry exists but has no recorded fingerprint baseline (manifests written before fingerprint tracking was added), the divergence query returns false and the provider draws no badge. The system cannot prove the file has diverged without a baseline to compare against, so it errs on the side of silence. The next system-side write to that file will populate the fingerprint and bring the file under protection. (Notable; intentional.)
- **Read errors are treated as divergence by the underlying query, not by the provider.** When the divergence-query layer encounters a read failure while computing the on-disk fingerprint of an existing file, it conservatively reports "diverged". The provider then paints the badge. The reasoning: a file the system wrote but can no longer read is at least as suspect as one that demonstrably mismatches. The provider itself does not need to know this — it just trusts the boolean. (Notable; intentional conservatism at the query layer.)
- **Tooltip is constant.** Every badged file gets the same tooltip — there is no per-file detail, no fingerprint hex, no last-modified timestamp. (Notable.)
- **Propagation is explicitly off.** A diverged file does not paint its ancestor directory. The badge applies only to the file itself. (Notable; intentional. Propagation would interact badly with the memory-bank parent folder's role as a multi-repository container.)
- **Badge symbol is a single visible glyph, not a colored bar.** The provider does not set a foreground color, so the badge picks up whichever foreground the active theme uses for file decorations. (Notable.)
- **No per-file divergence cache.** Every per-URI query re-asks the divergence query, which itself re-walks discovery (with its own internal caching) and re-reads the file from disk to recompute the on-disk fingerprint. The provider keeps nothing. (Notable.)
- **VS Code throttles re-polling.** The provider does not control how often VS Code re-asks about a given URI; it can only nudge with the refresh helpers. Practically, the badge updates "soon" after a system-side write, but a stale badge that lingers until VS Code's next sweep is observable. The targeted refresh helper exists to make the post-revert case crisp. (Notable.)
- **The post-system-write case is not wired to a refresh.** When a system-driven write (queue worker, dual-write orchestration, etc.) rewrites a previously-diverged file back into sync with the manifest, no targeted refresh fires. The badge clears on VS Code's next decoration poll. This is documented as an acknowledged gap, not a bug; the fix would be to plumb file-change events from the storage layer back through the provider. (Notable; intentional acknowledged gap.)
- **Targeted refresh is the only post-revert hook.** The revert-edits command is the one caller that fires a targeted refresh for the URI it just rewrote, so the user sees the badge disappear the moment the revert completes. (Notable.)
- **Global refresh follows repository-list churn, not file content.** Re-discovery of memory-bank repository roots (a new repository appears under the parent, an old one is removed) fires the global refresh; any individual file changing is **not** a global-refresh trigger. (Notable; intentional — the global signal is for "the set of paths-eligible-for-divergence has changed", not "some files' content changed".)
- **Errors in the divergence query are absorbed.** A thrown error must not propagate into VS Code's decoration pipeline — a single bad query for a single file would otherwise risk poisoning the whole decoration source. The query layer swallows discovery and read failures and returns false. (Notable; intentional. The provider does not catch its own awaits because the query contract is "never throws".)
- **Disposal tears down the emitter only.** The provider's dispose does not unregister the provider from VS Code (that is the host disposable's responsibility) and does not cancel any in-flight per-URI queries (they resolve naturally; nobody is listening). The contract is "stop emitting refresh events". (Notable.)
- **Refresh helpers after dispose are harmless.** Calling the targeted or global refresh helper on a disposed provider fires against a torn-down emitter — no listeners, no effect. The provider does not throw. (Notable.)
- **The same divergence signal feeds at least three surfaces.** The same boolean drives this VS Code-native badge, an in-extension one-shot info message that appears when the user opens a diverged file through the extension's open-memory-file command, and the in-webview marker in the memory-bank folder browser. All three resolve through the same bridge query, so they cannot disagree about a single file's divergence at a single moment in time (though they may update at different rates because each surface has its own refresh cadence). (Notable.)

## Shared Behavior

- **Fingerprint comparison and manifest lookup.** The actual sha256-style fingerprint algorithm, the manifest schema, the path-normalization rules that turn an absolute URI into a manifest-relative key (slash normalization, case preservation on case-sensitive filesystems, etc.), and the repository discovery walk that maps an absolute path to a memory-bank root are owned by the bridge and storage layers. This provider only consumes the resulting boolean. (See memory-bank-folder-layout spec for the hand-edit-protection contract and the visible-vs-hidden layer split that makes divergence possible at all.)
- **Memory-bank folder layout.** The parent folder, the per-repository subdirectories, the visible per-branch layer of Markdown files, the hidden machine-readable layer that owns the canonical fingerprints, and the system-reserved subdirectory names are defined by the memory-bank-folder-layout spec. This provider is a consumer of that layout and does not duplicate any of its rules.
- **Memory-bank folder browser.** The in-extension folder browser surface has its own in-tree marker for divergence; it reads from the same bridge query but renders inside a webview (not via VS Code's file-decoration pipeline) and has its own refresh signal. See the folder-browser spec.
- **Revert-edits command.** The user-driven path that rewrites a diverged file back to the system view and clears the badge is defined by the revert-command spec. The only contact this provider has with that command is the targeted refresh call the command makes after a successful revert.
- **Open-memory-file command.** The one-shot informational message that explains divergence to the user the first time they open a diverged file via the extension's open command is a separate surface that consumes the same bridge query; it does not interact with this provider.
- **Memory-bank discovery.** The walk that identifies which subdirectories under the parent folder are memory-bank repositories — and therefore which paths are eligible to be reported as "diverged" — is defined by the memory-bank-folder-layout spec (repository discovery section). Changes to that set fire the global refresh into this provider.
