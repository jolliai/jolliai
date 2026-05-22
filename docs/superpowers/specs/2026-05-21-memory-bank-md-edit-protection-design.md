# Memory Bank `.md` Edit Protection — Design

**Status:** Design
**Date:** 2026-05-21
**Branch:** fix-badge-count

## Problem

Memory Bank summary/plan/note files at `<localFolder>/<repo>/<branch>/*.md` look like ordinary editable Markdown but are treated by the system as a one-way export. Any edit — local IDE, GitHub web UI, another synced device — produces silently-lost-changes:

1. The sidebar continues to render system content (read from hidden JSON via the orphan branch), not the edited file.
2. The next regeneration pass (any subsequent commit) silently overwrites the edited file.

Reproduction (any of the following triggers the bug):

- **A. Local edit.** Open `<localFolder>/<repo>/<branch>/<slug>-<hash8>.md` in any editor, save, re-open via Memory Bank sidebar → sidebar shows original content. Make any subsequent commit → file overwritten.
- **B. GitHub web UI edit.** Edit on github.com, sync to Personal Space vault, open via sidebar → sidebar still shows original.
- **C. Cross-device sync.** Device A edits + syncs, Device B pulls, opens via sidebar → sidebar shows original.

The bug is independent of edit origin; all three are "bytes hit a file the system treats as generate-only."

## Root cause

Three closely-related contract violations:

1. **Write path has no divergence check.** [`generateSummaryMarkdown`](../../../cli/src/core/FolderStorage.ts) (line 470) calls `atomicWrite(targetPath, markdown)` unconditionally on every commit. [`generatePlanMarkdown`](../../../cli/src/core/FolderStorage.ts) (line 593) and [`generateNoteMarkdown`](../../../cli/src/core/FolderStorage.ts) (line 623) follow the same pattern. None of them check whether the on-disk file diverges from what the manifest says was last written.
2. **The same fingerprint mechanism already exists for deletion, just not for write.** [`cleanupSupersededDescendants`](../../../cli/src/core/FolderStorage.ts) (line 511-512) already compares on-disk sha256 to manifest fingerprint to skip deleting "files a human edited." The asymmetry — used to avoid deletion but not overwrite — is the root design gap.
3. **Read path is single-sourced from JSON.** [`openMemoryFile`](../../../vscode/src/Extension.ts) (line 2099) routes summary clicks through `bridge.getSummaryAnyRepoWithSource(commitHash)` and renders `SummaryWebviewPanel` from the loaded JSON. The `.md` body is never read. Plans/notes already fall through to `markdown.showPreview` so the read-path issue is summary-only.

The bug is two-headed: (a) writes silently overwrite, (b) reads can't see the divergence even if writes stopped overwriting.

## Goals & non-goals

### Goals

- **System never silently overwrites a user-edited `.md`.** Every regeneration must either match what was already there or be skipped.
- **Sidebar reflects what's actually on disk.** When a summary file diverges, the user sees their edited content, not the system version.
- **UI explicitly signals divergence + offers a path back.** A decoration badge and a revert command keep the contract honest.

### Non-goals

- **Reverse parser (`.md` → JSON heal-back).** That would make `.md` a true product input — out of scope. Tracked separately as Route C in the brainstorming notes.
- **Cross-device synchronization of edits.** User edits stay on local disk; orphan branch / Personal Space push continues to carry JSON-derived content.
- **Merge mode (system body + user appendix).** Discarded as too complex relative to benefit.
- **Orphan-branch-side protection.** A user editing the orphan branch from outside Jolli Memory is not in the Memory Bank scope.
- **Line-ending normalization.** Intentionally simple — any byte difference is treated as a user edit. Trade-off accepted (see §6).

## Design

### Component changes

#### 1. `cli/src/core/FolderStorage.ts` — write-path symmetry

Add a private helper:

```ts
private isUserEditedOnDisk(absPath: string, manifestFingerprint: string | undefined): boolean {
    if (!existsSync(absPath)) return false;       // file gone — not "edited"
    if (!manifestFingerprint) return false;       // legacy entry / no baseline — don't block
    const diskContent = readFileSync(absPath, "utf8");
    const diskFingerprint = MetadataManager.sha256(diskContent);
    return diskFingerprint !== manifestFingerprint;
}
```

Insert into all three write paths *before* `atomicWrite`:

- **`generateSummaryMarkdown` (line 470)** — before line 489's `atomicWrite`, look up `manifest.findByPath(relativePath)?.fingerprint`. If `isUserEditedOnDisk` returns true, `log.info("FolderStorage: skip overwrite of user-edited %s", relativePath)` and `return` (skip both the write and the `updateManifest`). The early return is critical: leaving the manifest fingerprint at its previous "what we last wrote" value is what lets the next pass still recognize the file as diverged.
- **`generatePlanMarkdown` (line 593)** — same insertion before line 604's `atomicWrite`.
- **`generateNoteMarkdown` (line 623)** — same insertion before line 634's `atomicWrite`.

Refactor [`cleanupSupersededDescendants` line 511-512](../../../cli/src/core/FolderStorage.ts) to call `isUserEditedOnDisk` instead of inlining the check. Behavior unchanged; deduplication only.

#### 2. `cli/src/core/FolderStorage.ts` — revert helpers (extend regenerate)

Already exists: `regenerateVisibleMarkdown(entry)` for summaries (line 235).

Add two parallel methods for revert support:

```ts
async regenerateVisiblePlan(slug: string, branch: string): Promise<boolean>
async regenerateVisibleNote(id: string, branch: string): Promise<boolean>
```

Each reads the corresponding hidden file (`.jolli/plans/<slug>.md` or `.jolli/notes/<id>.md`) and reuses the existing `generatePlanMarkdown` / `generateNoteMarkdown` paths. **Critical:** the regenerate methods must `unlinkSync` (or equivalent) the existing visible `.md` first so the generator's write succeeds — the existing `regenerateVisibleMarkdown` has an `existsSync(absPath) → return true` early-return that we explicitly DON'T want when reverting (we want to actively overwrite).

Decision: rather than weaken `regenerateVisibleMarkdown`, add a sibling `forceRegenerateVisibleMarkdown(entry)` that deletes-then-regenerates. The original idempotent variant stays as the safe heal path. The revert command uses the `force*` variants.

Three independent methods (not a generic `regenerateVisible({type, id})`) because the three hidden sources have different id schemes and reading them through a fake-uniform interface would be uglier than three 15-20 line methods.

**Naming asymmetry is intentional.** Summary has an existing `regenerateVisibleMarkdown` with idempotent (no-overwrite-if-exists) semantics used by the heal path; we add `forceRegenerateVisibleMarkdown` alongside it. Plans/notes have no pre-existing heal method, so `regenerateVisiblePlan` / `regenerateVisibleNote` are added with force-overwrite semantics from the start — no need for two variants.

#### 3. `vscode/src/Extension.ts` — read-path divergence routing

Modify `openMemoryFile` (line 2099-2143):

```
if (!absPath.endsWith(".md")) -> vscode.open               // unchanged
parseSummaryFrontmatter(absPath)
  if no meta -> markdown.showPreview                        // unchanged
  else:
    if isUserEditedOnDisk via bridge -> {                   // NEW
       show information message "This memory has on-disk edits. [Revert]"
       markdown.showPreview(uri)
       return
    }
    else (current behaviour):
       bridge.getSummaryAnyRepoWithSource(meta.commitHash)
       -> SummaryWebviewPanel
```

`bridge` (i.e. `JolliCliBridge`) needs a new method:

```ts
isMemoryFileDivergedOnDisk(absPath: string): Promise<boolean>
```

Implementation: walks down to `FolderStorage.isUserEditedOnDisk` by looking up the manifest entry for the relative path. The bridge already owns repo-resolution (it's how `getSummaryAnyRepoWithSource` works); the same resolver tells us which manifest to consult.

The informational message uses `vscode.window.showInformationMessage(msg, "Revert", "Dismiss")` with a one-shot session memo per-`absPath` so it doesn't re-pop on every click within a session.

#### 4. New: `vscode/src/services/MemoryFileDecorationProvider.ts`

Implements `vscode.FileDecorationProvider`. Registered for `file://` URIs under any Memory Bank `kbRoot`.

- `provideFileDecoration(uri)`:
  1. Skip if not under a known `kbRoot` or not `.md`.
  2. Call `bridge.isMemoryFileDivergedOnDisk(uri.fsPath)`.
  3. If diverged: return `{ badge: "✎", tooltip: "Edited on disk — system view unavailable", color: new vscode.ThemeColor("memoryBank.editedForeground") }`.
  4. Else: return undefined.

Decoration cache invalidation:
- On `KbFoldersService` file events (chokidar/fs.watch already in place).
- On manifest writes (we update fingerprints when the system writes; need to fire a `onDidChangeFileDecorations` event for those paths so the badge clears immediately after a revert).

Add to the disposables registered in `activate()`.

#### 5. New command: `jollimemory.revertMemoryFileEdits`

Registered alongside `openMemoryFile`. Accepts an `absPath: string`.

Implementation:
1. Resolve which repo / kbRoot the file belongs to (reuse the bridge's repo resolver).
2. Parse manifest entry by relative path to determine `type` (`commit` | `plan` | `note`) and the corresponding source id.
3. Call the matching `force*` regenerate helper on the FolderStorage instance.
4. Surface result via `window.showInformationMessage("Reverted to system version: <relativePath>")`.
5. Fire decoration provider refresh for that URI.

Two entry points:
- The `[Revert]` action button in the `showInformationMessage` from §3.
- A right-click menu item `Memory Bank: Revert Edits to System Version` on `.md` files under `kbRoot`. Wire via `package.json` `menus.explorer/context` with `when: resourceFilename =~ /.md$/ && resourcePath =~ /<kbRoot>/`. (The exact `when` predicate may need to be a context key set by `KbFoldersService` since `kbRoot` is dynamic; if so, set `jollimemory.isMemoryBankFile` per-tab.)

### Divergence algorithm

```
isUserEditedOnDisk(absPath, manifestFingerprint):
  1. if !existsSync(absPath): return false
  2. if !manifestFingerprint: return false       # legacy / no baseline → don't block
  3. diskContent = readFileSync(absPath, "utf8")
  4. diskFingerprint = sha256(diskContent)
  5. return diskFingerprint !== manifestFingerprint
```

### Behavior matrix

| Scenario                                                         | Pre-fix                            | Post-fix                                                                  |
| ---------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| User edits summary `.md`, then new commit                        | `.md` silently overwritten         | `.md` preserved, log line written                                         |
| User edits summary `.md`, then sidebar click                     | Sidebar shows old JSON content     | Sidebar shows edited content (markdown preview) + info message            |
| User edits plan/note `.md`, then plan/note update                | `.md` silently overwritten         | `.md` preserved                                                           |
| User edits plan/note `.md`, then sidebar click                   | Already showed edited (preview)    | Unchanged; decoration badge added                                         |
| `cleanupSupersededDescendants` sees user-edited child            | Already skipped (existing inline)  | Still skipped, now via shared helper                                      |
| `healMissingVisibleMarkdown` / `regenerateVisibleMarkdown`       | Skipped via `existsSync`           | Unchanged                                                                 |
| User changes frontmatter `commitHash`                            | `parseSummaryFrontmatter` returns valid meta, lookup fails, fallback to preview | Same fallback path; isUserEditedOnDisk also fires |
| User deletes frontmatter                                         | `parseSummaryFrontmatter` returns null → preview | Same                                                    |
| Cross-device sync pulls a new file body                          | Treated as system content          | Treated as diverged (fingerprint mismatch) — banner + decoration appear   |
| Sync push to Personal Space                                      | Pushes JSON-derived content        | Unchanged — still pushes whatever atomicWrite last wrote                  |
| User runs `Memory Bank: Revert Edits to System Version`          | N/A                                | `.md` regenerated from hidden JSON; decoration clears                     |
| Legacy entry without fingerprint in manifest                     | Overwritten                        | Overwritten (no baseline to protect); fingerprint backfilled on next write|

### Manifest schema

No migration required. `SummaryIndexEntry.fingerprint` is already optional and already populated for new writes by `updateManifest`. Legacy entries with absent fingerprint flow through the `!manifestFingerprint → false` branch of `isUserEditedOnDisk`.

## Edge cases & trade-offs

### Intentionally accepted

- **No line-ending normalization.** A Windows editor that flips LF → CRLF will trip divergence detection on every roundtrip. Trade-off accepted: silent data loss for users with the wrong byte ordering is worse than a banner for users on Windows. (See user feedback memory `["Windows 路径分隔符与大小写反复踩坑"]`.)
- **No frontmatter/body separation.** Editing only frontmatter still trips divergence. Simpler contract; user can revert if they meant to.
- **No partial regenerate.** When divergent, the system stops writing entirely; it doesn't try to "merge in" updated metadata. Merge logic is out of scope.

### Defended against

- **Manifest fingerprint stays stale during skip.** Critical: the `return` in §1 must happen *before* `updateManifest`, otherwise the manifest's fingerprint would be updated to whatever the system wanted to write, and the next pass would see "no divergence" and overwrite.
- **Decoration refresh after revert.** The decoration provider must subscribe to manifest writes; otherwise the badge persists until VS Code reloads.
- **Cross-repo sidebar clicks.** `openMemoryFile`'s existing cross-repo handling (`getSummaryAnyRepoWithSource`) must be preserved — the divergence check has to operate on the *correct* repo's manifest, not the workspace repo's.

### Open question (resolve during implementation, not now)

- The `when` clause for the right-click menu — whether a static `resourcePath` regex is feasible or whether we must set a context key from `KbFoldersService`. Depends on whether `kbRoot` is stable enough at registration time. Resolve during implementation; either way is small.

## Testing

### Unit (`cli/src/core/FolderStorage.test.ts`)

- `generateSummaryMarkdown` skips overwrite when on-disk fingerprint diverges from manifest fingerprint.
- `generateSummaryMarkdown` writes normally when on-disk fingerprint matches.
- `generateSummaryMarkdown` writes normally when manifest fingerprint is absent (legacy row); subsequent call sees the new fingerprint and protects.
- `generatePlanMarkdown` parallel: skip / write / legacy.
- `generateNoteMarkdown` parallel: skip / write / legacy.
- `cleanupSupersededDescendants` post-refactor still skips user-edited children.
- `forceRegenerateVisibleMarkdown` overwrites a diverged file when called explicitly.
- `regenerateVisiblePlan` / `regenerateVisibleNote` write from hidden source.

### Integration (`cli/src/core/DualWriteStorage.test.ts`)

- `DualWriteStorage` correctly delegates skip-overwrite to its `FolderStorage` child; orphan branch write is unaffected.

### Integration (VS Code)

- `openMemoryFile` with a diverged file routes to `markdown.showPreview`, not `SummaryWebviewPanel`.
- `openMemoryFile` with a clean file still routes to `SummaryWebviewPanel`.
- `MemoryFileDecorationProvider` reports decoration for diverged files and not for clean ones.
- `jollimemory.revertMemoryFileEdits` deletes-then-regenerates for `commit`/`plan`/`note` types.

## Acceptance criteria

`npm run all` passes. Manual verification:

1. Edit `<kbRoot>/main/<slug>-<hash8>.md` in VS Code editor, save. Make a new commit. **Edited content survives.** Log shows `skip overwrite of user-edited`.
2. Click that file in Memory Bank sidebar. **See edited content** (markdown preview) + an info message with `[Revert]` action.
3. Sidebar shows a decoration badge (`✎`) on the edited file with tooltip "Edited on disk — system view unavailable".
4. Click `[Revert]` (or right-click → Revert). File reverts to system version, badge disappears, subsequent click opens `SummaryWebviewPanel`.
5. Repeat steps 1-4 against `plan--*.md` and `note--*.md`.
6. Legacy summary in a manifest without `fingerprint` is overwritten on next commit; fingerprint is now populated; second edit triggers protection.
