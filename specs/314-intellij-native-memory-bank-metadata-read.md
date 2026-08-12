# 314. IntelliJ Native Memory Bank Metadata Read

## Topic Statement

A native reader in the IntelliJ plugin — [`KBFolderReader`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/KBFolderReader.kt) — answers exactly two reads off the Memory Bank's hidden layer with `Files.readString` + Gson and no bridge round-trip: the per-repository manifest (`<kbRoot>/.jolli/manifest.json` → `Manifest`) and the summary index (`<kbRoot>/.jolli/index.json` → `SummaryIndex?`). It exists because the Memory Bank tree's per-repository loop previously issued one `ide-bridge` daemon call per repository per refresh, adding 50–200 ms of pure IPC on a Memory Bank holding ten or more repositories. It is read-only by contract, fails soft in both directions (missing file is silent, malformed JSON is the same result plus a WARN), and carries **no dirty-gate**, justified by the fact that both files are written through a write-to-temp-then-rename, so a reader always sees one complete version or the other. Since the plugin's other filesystem-direct reader was deleted, this is the **only** read path on the JVM host that touches the mirror's hidden layer without going through the bridge — every data read (memory documents, plan and note bodies, archived reference bodies, stored transcripts) is now a bridge call, and this metadata pair is the sole exception. Its two callers are the shared Memory Bank data cache and the explorer tree's own build loop.

## Scope

**In scope:**
- The two read entry points, their exact paths relative to a per-repository Memory Bank root, and their return types.
- The error policy per failure class, and which failures leave a log breadcrumb.
- The absence of a dirty-gate, the argument that makes that safe here, and the read families it therefore cannot protect.
- Its position as the host's last remaining filesystem-direct read, and what that does *not* imply about the reads that left.
- The read-only boundary and why writes must not be added.
- The two production callers and what each does with the parsed result.
- The cross-language schema lockstep this reader creates, and the stale writer-side comment that contradicts it.

**Out of scope:**
- The hidden layer's own definition — the parent folder, the per-repository subdirectory, the file set, and the reserved names (owned by spec 151).
- The writer that emits `manifest.json` and `index.json`, its atomic-write helper, and its read-modify-write guards (owned by specs 02 and 03).
- The *deleted* IntelliJ direct-filesystem reader and everything that went with it — its per-read dirty-gate, containment guard, and attach preconditions (historical record in spec 307, retired). This spec states only that it is gone and what that leaves behind here.
- The archived-reference read that used to be one of that reader's shapes and is now a bridge call with a derived-stem guard (owned by spec 317).
- The Memory Bank explorer tree's node model, badges, expansion, search, and timeline grouping (owned by spec 193).
- The visible-Markdown heal pass that runs immediately before these reads in the tree loop (owned by spec 315).
- The bridge-backed `MetadataManager` that still serves every **write** and every non-hot-path metadata read (owned by spec 287).

## Data Contracts

### Entry points

| Function | File read | Returns on success | Returns on any failure |
|---|---|---|---|
| `readManifest(kbRoot: Path): Manifest` | `<kbRoot>/.jolli/manifest.json` | the parsed `Manifest` | an empty `Manifest()` |
| `readIndex(kbRoot: Path): SummaryIndex?` | `<kbRoot>/.jolli/index.json` | the parsed `SummaryIndex` | `null` |

`kbRoot` is the **per-repository** root (`<localFolder>/<repo>`), already resolved by the caller. The reader appends `.jolli` itself and never enumerates, globs, or walks — both calls are single-file whole-reads by a path the caller already holds.

`readManifest` additionally coerces a Gson `null` result (the JSON literal `null`) to `Manifest()` via `?: Manifest()`; `readIndex` deliberately does not, since `null` is already its absent value.

### The parsed shapes

`Manifest` (`core/KBTypes.kt:35-38`): `version: Int = 1`, `files: List<ManifestEntry> = emptyList()`. Each `ManifestEntry` (`:19-32`) carries `path`, `fileId`, `type` (`"commit"` | `"plan"` | `"note"` | `"wiki"`), `fingerprint`, a nested `ManifestSource(commitHash, branch, generatedAt)`, and the nullable `title` / `updatedAt`.

`SummaryIndex` (`core/Types.kt:589-593`): `version: Int = 3`, `entries: List<SummaryIndexEntry> = emptyList()`, `commitAliases: Map<String, String>?`. Each `SummaryIndexEntry` (`:575-586`) carries `commitHash`, the nullable `parentCommitHash` (a row is a head **iff** this is null), `treeHash`, `commitType`, `commitMessage`, `commitDate`, `branch`, `generatedAt`, `topicCount`, `diffStats`.

Only a subset of each shape is actually consumed (see Behavior); the rest is decoded and discarded.

### The read-only boundary

The object's entire filesystem vocabulary is `Files.readString`. It creates, updates, and deletes nothing. Writes to both files stay with the CLI's `MetadataManager` over the bridge, so dual-write consistency, read-modify-write guards, and atomic-write semantics have exactly one implementation.

## Behavior

### Error policy, per failure class

Both functions wrap the read in the same three-arm catch:

1. `NoSuchFileException` → the empty result, **silently**. A fresh repository whose Memory Bank folder has been initialized but never written to is the expected case, and it must not produce log noise on every tree rebuild.
2. `JsonSyntaxException` → the empty result, logged at **WARN** naming the path and the exception message.
3. Any other `Exception` (permissions, decoding, an IO error mid-read) → the empty result, logged at **WARN** with the throwable.

The split exists because a corrupt manifest is otherwise indistinguishable from "no memories yet" — the tree renders the same empty state either way, and the WARN line is the only trace that the two are different situations.

### Why there is no dirty-gate

The reader that *did* gate on the mirror's out-of-sync marker — probing `<kbRoot>/.jolli/shadow-status.json` before **every** read and declining when it existed, because the reads it served participated in a multi-file transaction — has been deleted (spec 307, retired). Nothing on the JVM host reads that marker any more. The marker itself is unchanged: still written by the CLI, still meaning what it meant.

This reader omits the gate deliberately, on two grounds:

- **Atomicity.** Both files are written write-to-temp-then-rename — the CLI's `MetadataManager.atomicWrite` (`cli/src/core/MetadataManager.ts:400-407`) for the manifest, and `FolderStorage`'s `safeAtomicWriteSync` (which also renames, after a symlink-chain check) for anything routed through `writeHiddenFile`, including `index.json`. A reader therefore sees either the complete old file or the complete new one, never a torn write.
- **Eventual consistency of the consumer.** Both callers feed a tree render. A manifest that is one transaction stale renders a tree that is one transaction stale, and the next refresh corrects it — which was never true of a stale summary body opened in a viewer, and is why that read family was gated and this one is not.

The consequence is stated plainly: this reader can serve stale metadata during a shadow-write transaction, and nothing anywhere notices.

### The two callers

| Caller | Reads | Uses |
|---|---|---|
| `KBDataCache.reload` (`core/KBDataCache.kt:33-34`) | both, per discovered repository | Builds the flat `KBEntry` list backing the Timeline and A-Z views. `index.entries` is folded to the set of hashes with a non-null `parentCommitHash`; a manifest row of type `"commit"` whose `fileId` is in that set is **dropped** (squash/amend children are not separate rows). Every surviving row contributes `repo`, `branch`, `title`, `date` (from `source.generatedAt`), `path`, `type`, `kbRoot`, `fullPath`, `isCurrentRepo`. |
| `KBExplorerPanel.buildTree` (`toolwindow/KBExplorerPanel.kt:486`, `:494`) | both, per rendered repository | The same child-hash set, here used to build a `hiddenPaths` set rather than to drop rows; plus a per-path badge map (`commit`→`C`, `plan`→`P`, `note`→`N`, anything else→empty), a per-path title map, and a per-path branch map. |

`commitAliases`, `treeHash`, `commitType`, `topicCount`, `diffStats`, `fingerprint`, and `updatedAt` are decoded by neither caller.

### Position in the tree refresh

`KBExplorerPanel.refresh()` runs `resolveKBRoot()` → `reconcile()` → `reloadCache()` → `rebuildCurrentView()`. `reloadCache` drives `KBDataCache.reload`, and `rebuildCurrentView` in TREE mode drives `buildTree`. Both read the same two files for the same repositories, so **one refresh reads each file twice per repository** — the native read is cheap enough that no one deduplicated it.

## Notable Behavior

- **This is now the only IntelliJ direct-filesystem reader, full stop — and it is the ungated one.** The gated accessor was deleted; the ungated pair survived. So the host's *entire* remaining filesystem-direct surface is the one that was always allowed to serve stale metadata, and the reasoning still does not generalize: atomicity protects against a *torn* file, not against a file that is intentionally behind because a shadow write was swallowed. The trade is deliberate — a stale tree row corrects itself on the next refresh; a stale summary body did not. That family did not migrate here when its reader was deleted — it went to the bridge. (Central design point.)
- **A corrupt `index.json` silently un-hides squash children.** `readIndex` returning `null` collapses the child-hash set to empty, so both callers stop hiding the child commits of a squash or amend: the timeline gains rows and the tree gains files, with no error state and no visual marker. The only trace is one WARN line. The docstring frames `null` as matching the bridge path's `JsonNull`, which is true, and understates what the tree then does with it. (Surprising.)
- **The writer's own lockstep note says this file does not exist — and names a reader that no longer does.** `cli/src/core/FolderStorage.ts`'s header still reads "`.jolli/index.json` is CLI-only (no read path in IntelliJ today) so its schema can evolve independently; if a future Kotlin read path starts consuming it, add it to the list here AND to AGENTS.md", and the paragraph above it still directs schema changes at the *deleted* reader's source file and at the summary / plan / note / reference / dirty-marker paths it used to consume. AGENTS.md's "Critical rules" is the one that matches the code: it registers `KBFolderReader` as the Kotlin reader parsing both `manifest.json` and `index.json`, and separately records the other reader's retirement. So the repository carries a header comment that is wrong twice over — it denies the obligation that exists and asserts one that does not. The real obligation is unchanged. (Surprising; a documentation hazard rather than a behavior.)
- **The empty-manifest result is indistinguishable from an empty repository at the call site.** Neither caller can tell `Manifest()`-because-missing from `Manifest()`-because-corrupt; both render "No memories yet". The WARN split in the reader is the entire difference, and no surface promotes it.
- **The reader takes an already-resolved root and resolves nothing itself.** It performs no root discovery, no claiming write, and no bridge call — unlike the deleted reader's attach path, where locating the root was itself several bridge round-trips and could create a directory. Here the cost of resolving `kbRoot` sits entirely with the caller (`KBRepoDiscoverer.discover`, which is a bridge call).
- **Reads are duplicated once per refresh and that is fine.** `reloadCache` and `buildTree` each parse the same two files per repository. At native speed the duplication is invisible; it is recorded because the whole reason this reader exists is that the *previous* duplication — over the bridge — was not.
- **"Never add a write here" is a contract, not a preference.** A Kotlin writer would fork the schema decision away from the CLI, where dual-write ordering and the dirty-marker protocol live. The read/write asymmetry (native reads, bridge writes) is the shape that keeps one writer.

## Shared Behavior

- **Memory Bank Folder Layout (151)** — owns the hidden layer, the per-repository root, and the file names read here.
- **Folder-Based Summary Storage (02)** and **Dual-Write Summary Storage (03)** — own the writer that emits both files, its atomic-write helper, and the dirty-marker protocol this reader declines to consult.
- **IntelliJ Direct Memory-Mirror Read Path, Retired (307)** — the historical record of the deleted sibling reader, its per-read out-of-sync gate, its containment guard, and its attach lifecycle. It describes no live behavior; the contrast with this reader's ungated design is stated above, and this reader is what survived.
- **IntelliJ Archived Reference Body Read (317)** — one of the deleted reader's shapes, now a bridge call; the only read on this host that still derives a key before issuing it.
- **IntelliJ KB Explorer Panel (193)** — owns the tree and timeline this reader feeds, including the node model, badges, and search.
- **IntelliJ Memory Bank Heal Pass Gating (315)** — owns the heal call that runs immediately before `readIndex` / `readManifest` in the tree loop.
- **CLI IDE-Bridge Command Surface (287)** and **IntelliJ CLI Daemon Connection (288)** — own the bridge path this reader bypasses and which still serves every write and the repository discovery that supplies `kbRoot`.
