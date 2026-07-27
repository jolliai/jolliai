# 03. Storage-Mode Selection

## Topic Statement
Select one of three storage configurations — version-controlled-ref-only, folder-mirror-only, or a dual-write composite that fans every write across both with primary-wins conflict semantics — based on a single configuration value.

## Scope
**In scope:**
- The three accepted storage configurations and the configuration value that selects between them.
- How each configuration is constructed at storage-create time on the write side and on the read side.
- The default configuration applied when the configuration value is missing, unparseable, or carries an unrecognised value.
- The optional `localFolder` configuration value that is forwarded to the folder-backend constructor in the two configurations that include one.
- The composite storage (used by the dual-write configuration only) that wraps two underlying backends as a primary read-source and a shadow follower.
- Which backend serves reads, listings, and existence probes in each configuration.
- The order writes are issued and what happens on failure of either backend in the composite.
- Initialization of both backends in the composite and what happens when the secondary's initialization fails.
- The dirty-flag protocol used to mark the shadow as out-of-sync after a failed shadow write, and to clear it on success.
- The read-side fallback chain in the dual-write configuration: probes for the folder shadow's readiness and its dirty flag before serving reads from it.
- Delegation of optional storage-provider methods that only the folder backend implements (visible-markdown delete / regenerate, plan-and-note visible delete, branch-mapping prune, heal-missing-visible-markdown, topic-wiki render, wiki-presence probe) to the shadow when in the composite configuration.

**Out of scope (boundaries):**
- The internal mechanics of either backend (covered by "Orphan Branch Summary Storage" and "Folder-Based Summary Storage").
- The schema or interpretation of summary content (covered by "Summary Tree Structure").
- The schema of canonical topic pages and the topic-wiki rebuild input (covered by "Topic Index and Page Storage" and "Wiki Markdown Rendering").
- Any background reconciliation or back-fill from one backend to the other; this storage layer performs none.
- The host-specific reload mechanics that recreate a storage instance after the user changes the configuration value (covered by host-specific extension specs).

## Data Contracts

### Mode selector
A configuration value (loaded at storage-create time from the project-scoped configuration document) named `storageMode` with three accepted string values:
- `"orphan"`: selects the version-controlled-ref backend alone. No folder mirror is constructed. No composite is created.
- `"folder"`: selects the folder-mirror backend alone. No version-controlled-ref backend is constructed. No composite is created.
- `"dual-write"`: selects the composite described in this spec. **This is also the default value used when the configuration is missing, fails to load, contains no `storageMode` field, or carries any value other than the three above on the write side.** (On the read side, an unrecognised value falls back to `"orphan"` instead — see Read-side resolution.)

A second configuration value `localFolder` is read at the same time. When present and non-empty it is forwarded to the folder-backend constructor as a custom parent directory in both the `"folder"` and `"dual-write"` configurations; otherwise the folder-backend uses its own default parent. The version-controlled-ref backend ignores `localFolder` entirely.

The configuration value is read fresh per storage-creation call; consumers that need it to reflect a settings change must reconstruct their storage instance (e.g. the host extension's reload-storage path).

### Storage configurations

Three configurations are constructed end-to-end from the mode selector:

| Mode value | Write-path construction | Read-path construction |
| --- | --- | --- |
| `"orphan"` | The version-controlled-ref backend alone. | The version-controlled-ref backend alone. |
| `"folder"` | The folder-mirror backend alone (with `localFolder` as custom parent when present). | The folder-mirror backend alone (with `localFolder` as custom parent when present). |
| `"dual-write"` | The composite below: primary = version-controlled-ref backend, shadow = folder-mirror backend (with `localFolder` as custom parent when present). | The folder-mirror backend by default, with two documented fallbacks to the version-controlled-ref backend (see Read-side resolution). |

A diagnostic / "heal" entry point that exists to repair the folder-mirror's visible Markdown layer rejects the `"orphan"` configuration with a message instructing the user to switch to `"dual-write"` or `"folder"` first; it proceeds in the other two configurations.

### Composite identity (the `"dual-write"` configuration only)
Two named slots:
- `primary`: a storage-provider instance treated as the canonical source of truth for reads (always the version-controlled-ref backend in this configuration).
- `shadow`: a storage-provider instance that receives a copy of every write (always the folder-mirror backend in this configuration).

Both slots implement the same storage-provider contract documented in "Orphan Branch Summary Storage" / "Folder-Based Summary Storage" (read one path, write a batch with a message, list under a prefix, check existence, ensure initialization, optional dirty-flag operations, optional visible-layer and wiki-layer entry points).

### Write batch (forwarded to both backends)
A list of file-write entries plus a message string, identical in shape to the contract documented in the per-backend specs.

### Dirty-flag protocol (on the shadow)
The composite calls three optional storage-provider methods on the shadow only — never on the primary:
- `markDirty(message)`: requested after any failed shadow-write (including delegated shadow-only operations such as visible-markdown delete / regenerate, plan-and-note visible delete, branch-mapping prune, and heal-missing-visible-markdown).
- `clearDirty()`: requested after any successful shadow-write batch.
- `isDirty()`: forwarded through the composite so external code can observe the shadow's flag without holding a direct reference. The composite never invokes it on the primary; the version-controlled-ref backend has no dirty concept.

Each method is invoked using optional-call semantics: if the shadow does not implement the method, the call is a no-op.

## Behavior

### Write-side storage construction
1. Load the project-scoped configuration document. If loading throws, log a warning with the error message and continue with an empty configuration object.
2. Read `storageMode` from the configuration; if absent, default to `"dual-write"`.
3. Read `localFolder` from the configuration; if absent, leave undefined.
4. Switch on the mode:
   - `"dual-write"`: construct a version-controlled-ref backend over the working directory, construct a folder-mirror backend rooted at the resolved KB path for the project (using `localFolder` as the custom parent if present), and return the composite with the version-controlled-ref backend as `primary` and the folder-mirror backend as `shadow`.
   - `"folder"`: construct and return the folder-mirror backend directly (no composite).
   - default (`"orphan"` **and any unrecognised value**): construct and return the version-controlled-ref backend directly. A typo in the configuration value silently produces the orphan-only configuration on the write side.

The folder-backend construction sub-step (used by both `"folder"` and `"dual-write"`):
1. Derive the repository name from the project path using the host repository's remote-origin URL → common-ref-storage parent → project-path-basename → `unknown` fallback chain (defined in "Folder-Based Summary Storage").
2. Read the host repository's remote-origin URL (or null).
3. Resolve the KB root using the repo name, remote URL, and (optional) custom parent path.
4. Construct the metadata-management surface rooted at the KB's hidden subdirectory.
5. Return a folder-backend bound to the KB root and metadata manager.

### Read-side storage resolution
A separate read-side entry point exists (used by code paths that need a read-only view of the same storage the user sees in the UI — notably the CLI's recall and compile commands and the host extension's read-side surface). It re-reads the same configuration document on every call and dispatches as follows:
- `"orphan"`: return a fresh version-controlled-ref backend over the working directory.
- `"folder"`: return a fresh folder-mirror backend with `localFolder` as custom parent if present.
- `"dual-write"`: construct the folder-mirror backend with `localFolder` as custom parent if present, then probe its readiness:
  1. If the folder backend's read of the summary-index document returns null (the folder layer is incomplete — fresh install before the orphan-to-folder migration has run, or the user wiped the folder layer manually): log a warning and return the version-controlled-ref backend instead.
  2. Otherwise, if the folder backend's dirty flag is set (the last shadow write into it failed and was suppressed): log a warning and return the version-controlled-ref backend instead.
  3. Otherwise return the folder backend.
- Any unrecognised value: log a warning and return the version-controlled-ref backend.

Caller is responsible for caching when applicable — this resolution performs a fresh configuration load (and, in `"dual-write"`, a fresh folder-index probe and dirty-flag check) on every call. Long-lived host surfaces (e.g. a host-side bridge serving repeated reads) memoise and invalidate on a settings-save signal; one-shot CLI commands need no caching.

### `readFile(path)` (composite only)
Forward unchanged to `primary.readFile(path)`. The shadow is **never read**.

### `batchReadFiles(paths)` (composite only)
Forward to `primary.batchReadFiles(paths)` if the primary implements it; otherwise loop `primary.readFile(path)` and assemble the result map. The shadow is **never read**.

### `listFiles(prefix)` (composite only)
Forward unchanged to `primary.listFiles(prefix)`. The shadow is **never listed**.

### `exists()` (composite only)
Forward unchanged to `primary.exists()`. The shadow's existence is **never** checked here.

### `ensure()` (composite only)
1. Await `primary.ensure()`. If it throws, the error propagates to the caller.
2. Then await `shadow.ensure()`. If it throws, log a warning with the error message and **swallow** the error. The composite reports success regardless.

### `writeFiles(files, message)` (composite only)
1. Await `primary.writeFiles(files, message)`. If it throws, the error propagates to the caller and the shadow is **not** written.
2. Then enter a try/catch around `shadow.writeFiles(files, message)`:
   - On success: optionally call `shadow.clearDirty()` (no-op if not implemented).
   - On any thrown error: log a warning with the error's message (or the stringified error if it is not an Error instance), then optionally call `shadow.markDirty(message)` (no-op if not implemented). The composite reports success regardless.

There is no retry, no queue, and no background reconciliation. A shadow that has been marked dirty stays dirty until either an external process clears the flag or a subsequent successful shadow-write clears it on the next batch.

### Shadow-only delegated operations (composite only)
The composite exposes several optional storage-provider methods whose semantics only apply to the visible / wiki layer of the folder backend. The version-controlled-ref backend does not implement them. The composite delegates each to the shadow:
- Visible-markdown delete for a single summary entry.
- Visible-markdown regeneration for a single summary entry from the hidden source.
- Plan visible-Markdown delete.
- Note visible-Markdown delete.
- Branch-mapping prune (removes the per-repository branch-folder mapping for a set of branch names; reported as a count of mappings actually removed).
- Heal-missing-visible-markdown (manifest walk that re-emits visible Markdown the manifest still records but the filesystem has lost).
- Topic-wiki render (full wipe-and-rewrite of the generated wiki layer from a snapshot of canonical topic pages).
- Topic-wiki presence probe (whether the wiki layer's index page exists on disk).

For each delegated operation:
- If the shadow does not implement it, the call is a no-op returning a sensible neutral value (`false`, `0`, an empty result, or `void` as appropriate).
- If the delegated call throws, the composite catches the error, logs a warning naming the operation and the affected identifier, and calls `shadow.markDirty(<contextual message>)`. The composite returns the same neutral value. The throw does **not** propagate to the caller.

The heal-missing-visible-markdown delegation passes through the caller's `dropOrphanedManifestEntries` flag, defaulting to **true** at this seam (the orphan branch is the system of record in dual-write mode and can re-source any manifest row whose hidden JSON is also missing). A successful delegation returns the shadow's count of `{healed, skipped, failed, droppedIds?}`. A thrown delegation returns `{healed: 0, skipped: 0, failed: 0, error: <annotated message>}` where the message is prefixed with the underlying error's errno (e.g. `[EACCES] ...`) when present.

### Dirty-flag forwarding (composite only)
The composite implements `isDirty()` by delegating to `shadow.isDirty?.()` (returns false when the shadow does not implement it). `markDirty` and `clearDirty` are not exposed as public methods on the composite — they are invoked only internally as a side effect of `writeFiles` outcomes and the shadow-only delegated operations above.

## State Transitions

The configuration value drives a top-level mode-state, but mode changes are observed only at storage-create time; an in-process storage instance reflects the configuration that was loaded when it was constructed. Triggers:
- `"orphan"` → `"folder"` / `"dual-write"`: settings save followed by host reconstruction of the storage instance. No back-fill: data previously written to the version-controlled-ref backend does not appear in the folder mirror until a subsequent write batch touches the same file IDs.
- `"folder"` → `"orphan"` / `"dual-write"`: same construction-time observation; same no-back-fill rule.
- `"dual-write"` → `"orphan"` / `"folder"`: same.

Within the `"dual-write"` configuration, the composite's observable state combines the states of its two backends. Of interest are the shadow's two flag states:
- **In-sync**: the shadow either has never been written, or its most recent write (or `clearDirty` call) succeeded.
- **Dirty**: the shadow's most recent write failed; the dirty marker is recorded (subject to the shadow's own best-effort behavior — see "Folder-Based Summary Storage" for how that marker is persisted there).

Triggers:
- In-sync → Dirty: a `writeFiles` call where the primary write succeeds and the shadow write throws; OR any shadow-only delegated operation (visible-markdown delete / regenerate, plan-and-note visible delete, branch-mapping prune, heal-missing-visible-markdown, topic-wiki render) that throws inside the composite's catch.
- Dirty → In-sync: any subsequent `writeFiles` call where both the primary and the shadow write succeed. Shadow-only delegated operations do not clear the dirty flag on success (the clear path is `writeFiles`-only).
- Both failure modes during `ensure()` are observable but do not modify the dirty flag (the composite logs and continues).

## Notable Behavior

- **Three modes, one configuration value.** The same `storageMode` value selects between an orphan-only configuration, a folder-only configuration, and the dual-write composite. The mode is read once per storage-create call; an in-process storage instance does not observe a mid-life mode change. Host extensions that surface the setting in their UI must reconstruct their storage instance after a settings save. (Notable.)
- **Default mode is dual-write.** A missing or unparseable configuration document still produces the composite. The user must explicitly opt out by setting `storageMode` to `"orphan"` or `"folder"`. (Surprising.)
- **Unknown-value handling differs between write and read sides.** On the write side, any unrecognised `storageMode` value silently falls back to the orphan-only configuration (so a typo cannot half-construct the composite). On the read side, any unrecognised value falls back to the orphan-only configuration **with a warning**. In both cases a config typo splits no state — both sides reach the same backend. (Notable; intentional safety-first asymmetry.)
- **Read-side picks the folder shadow when it's ready.** In the dual-write configuration, the read-side resolution returns the folder backend rather than the version-controlled-ref backend whenever the folder layer has been initialised (its summary-index document is present) AND is not dirty. This is so any read-side surface (recall, compile, host extension's tree view) sees the exact bytes the user can see in their KB folder. Two documented fallbacks to the version-controlled-ref backend exist: (1) fresh install with the migration not yet run; (2) folder shadow is dirty after a suppressed shadow-write failure. (Notable.)
- **Reads always go to the primary inside the composite.** The composite's own `readFile` / `listFiles` / `exists` paths consult only the primary. The read-side resolution above picks the folder backend directly (bypassing the composite) when the conditions hold; the composite itself never serves a read from its shadow. (Notable; intentional.)
- **Sequential, primary-first writes.** The two backends are written one after the other, not concurrently. A long-running primary write delays the shadow write. (Notable.)
- **Primary failures abort the batch.** If the primary throws, the shadow is not even attempted. The caller sees the primary's error verbatim. (Notable.)
- **Shadow failures are silent at the API surface.** A shadow write or shadow ensure that throws is logged at warning level and swallowed. The composite returns success. The dirty marker is the only observable trace. (Surprising; intentional.)
- **No partial-rollback.** If the primary succeeds and the shadow fails, the primary's write stays in place. There is no attempt to undo it or to enqueue a retry of the shadow. (Notable; intentional.)
- **No back-fill on mode switch.** Changing the configuration between any two of the three modes does not migrate any pre-existing content from the no-longer-written backend to the newly-written backend. A separate one-shot migration entry point exists in the wider system for orphan → folder back-fill (out of scope here); the configuration switch itself is data-preserving but not data-replicating. (Notable; intentional.)
- **`ensure()` reports success even when the shadow is unprepared.** Because the shadow's `ensure()` failure is caught and swallowed, a subsequent `writeFiles` call will retry the shadow and either succeed (silently fixing the earlier ensure failure) or fail and set the dirty flag. (Surprising.)
- **Dirty-flag operations are optional and shadow-only.** The composite uses optional-call syntax against the shadow. A shadow that does not implement the dirty-flag methods produces a working composite that simply never marks or clears a dirty state. The primary is never asked about its dirty state — the version-controlled-ref backend has no such concept. (Notable.)
- **Hard-coded primary/shadow assignment for dual-write.** When mode is `"dual-write"`, the composite's primary is always the version-controlled-ref backend and its shadow is always the folder-mirror backend. The reverse assignment is not configurable. (Notable; intentional.)
- **Custom-parent path forwarded only to the folder-mirror.** The `localFolder` configuration value is consumed only by the folder-backend construction step (in both the `"folder"` and `"dual-write"` configurations); the version-controlled-ref backend ignores it entirely. (Notable.)
- **Heal entry point rejects orphan-only.** The "heal-folder" diagnostic command, which exists to re-emit missing visible Markdown from the manifest's recorded paths, fails fast with a user-facing message when the active configuration is `"orphan"` (the version-controlled-ref backend has no visible layer to heal). It runs against the folder backend directly in `"folder"` mode and against the composite (which delegates to its shadow) in `"dual-write"` mode. (Notable.)
- **Shadow-only delegations mark dirty on failure but do not clear on success.** The composite's catch-and-swallow wrapper around each shadow-only operation (visible-markdown delete / regenerate, plan-and-note visible delete, branch-mapping prune, heal-missing-visible-markdown, topic-wiki render) calls `shadow.markDirty` on a thrown delegation. None of these operations call `shadow.clearDirty` on success — only `writeFiles` does. A folder shadow can therefore stay dirty across many successful shadow-only operations until the next successful batch `writeFiles`. (Surprising.)
- **Heal seam defaults `dropOrphanedManifestEntries` to true.** The composite's heal delegation passes through the caller's flag if set, but defaults it to true at this seam. Rationale: callers reach the composite exactly when the version-controlled-ref backend exists to re-source any manifest row whose hidden JSON is also missing. Folder-only callers bypass the composite and must NOT set this flag — for them the manifest is the last record. (Notable; intentional.)
- **Wiki layer lives on the shadow.** The composite's topic-wiki render entry point and wiki-presence probe both delegate to the shadow; the version-controlled-ref backend has no visible-wiki layer. (Notable.)

## Shared Behavior
- The atomicity, plumbing, and ref-update semantics of the primary backend are defined by **Orphan Branch Summary Storage**.
- The three-layer file layout (hidden machine-readable, visible per-branch, generated topic-wiki), manifest, branch-mapping registry, atomic-write semantics, dirty-flag persistence, and the topic-wiki rebuild contract of the shadow backend are defined by **Folder-Based Summary Storage**.
- The schema of the content carried by both backends is defined by **Summary Tree Structure**.
- The wider per-repository folder layout — including the parent-folder identity registry and the read-side fallback's interaction with fresh-install state — is defined by **Memory Bank Folder Layout**.
