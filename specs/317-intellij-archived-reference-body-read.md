# 317. IntelliJ Archived Reference Body Read

## Topic Statement

Reading an archived external-reference body in IntelliJ — the Markdown the CLI wrote to `references/<source>/<stem>.md` when a commit landed — cannot interpolate the key the caller holds. The caller holds an `archivedKey` of the form `<wire>:<nativeId>-<shortHash>`, and for GitHub (whose native id is `owner/repo#n`) and Context7 (whose native id is `/org/project`) that bare key contains bytes the CLI never puts in a file name. `SourceIds.pathKey` ([`core/references/ReferenceTypes.kt`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/references/ReferenceTypes.kt)) is the Kotlin read-side mirror of the CLI's `sanitizeNativeIdForPath`: identity for every path-safe source, and `[^\w.-] → "-"` plus an eight-hex SHA-256 tail computed over the **raw** bare key for those two. The stem must therefore be derived **before** any read is issued — the sanitize call is what makes the path resolvable at all, and the one guard that survives is a byte check on that derived stem. There is now exactly one read leg: the request goes through the bridge-backed storage stack like every other data read on this host. Getting the derivation wrong is not a partial failure: before the sanitize was ported, every GitHub and Context7 body resolved to a nested path the CLI never writes and returned null on every surface.

## Scope

**In scope:**
- `SourceIds.wireName` / `stripPrefix` / `pathKey`, and the closed set of path-unsafe sources.
- The single-leg read (`SummaryReader.readReferenceBody`), the stem derivation that must precede it, and the service entry point it is reached through.
- The surviving stem check and why it is unreachable on well-formed data.
- The byte-for-byte lockstep obligation against the CLI writer, and the test that pins it.
- The regression this closed and the divergences from the CLI implementation that remain.

**Out of scope:**
- The write side — how a reference is extracted, rendered to Markdown with YAML frontmatter, and archived on commit (owned by specs 153, 179, and 255, and by `SummaryStore.storeReferences`).
- The deleted second read source on this host — its construction preconditions, its attach lifecycle, its per-read out-of-sync gate, and its canonicalization-based containment helper. All of that is gone; spec 307 (retired) is the historical record.
- Which backend the bridge's storage action actually serves for this path (owned by spec 344), and the transport that carries it (owned by specs 287 and 288).
- The badge, colour, and label the reference row displays, and the display title used as the editor's file name (owned by spec 313).
- The CONTEXT group's row anatomy and click routing (owned by spec 123).

## Data Contracts

### Wire names and the bare key

`SourceIds.wireName(id)` maps the Kotlin enum to the exact string the CLI writes: `zoom_doc → "zoom-doc"`, `zoom_meeting → "zoom-meeting"`, everything else `id.name` verbatim.

`SourceIds.stripPrefix(wire, archivedKey)` removes a leading `"<wire>:"` when present and otherwise passes the value through unchanged. `"jollimemory:recall-abc12345"` → `"recall-abc12345"`. The pass-through arm is defense-in-depth for hand-passed inputs; production callers always hold the prefixed form.

### `pathKey`

```kotlin
fun pathKey(source: SourceId, bareKey: String): String =
    if (source in PATH_UNSAFE_SOURCES) {
        val safe = bareKey.replace(Regex("[^\\w.-]"), "-")
        "$safe-" + sha256Hex(bareKey).substring(0, 8)
    } else bareKey
```

`PATH_UNSAFE_SOURCES = setOf(github, context7)` — exactly the sources declared `nativeIdPathSafe: false` in the CLI's source definitions. Every other source (`linear`, `jira`, `notion`, `slack`, `jollimemory`, `confluence`, `asana`, `monday`, `zoom-doc`, `zoom-meeting`) is identity.

Two properties are load-bearing and pinned by test:

- The SHA-256 is taken over the **raw** bare key, not the already-substituted one — so `orgA/proj#100-abc12345` and `orgB/proj#100-abc12345`, which collapse to different safe stems anyway, are additionally distinguished by suffix, and two genuinely different tuples can never land on one file.
- Identity is byte-for-byte for the path-safe sources, including the archive form: `pathKey(linear, "PROJ-1234-abc12345") == "PROJ-1234-abc12345"`.

`isPathUnsafe(source)` exposes the same set as a predicate.

### The one storage path

The read asks the storage stack for the storage-relative path `references/<wire>/<stem>.md`, where `<stem>` is `pathKey(source, stripPrefix(wireName(source), archivedKey))`. It is the same path shape the CLI writer emits, and the same shape the plan and note reads use one directory level shallower (`plans/<slug>.md`, `notes/<id>.md`). Nothing on this host composes a filesystem path for this read any more — the path is a key handed to the bridge, and which backend resolves it is the command-line surface's decision (spec 344).

## Behavior

### The read, end to end

`JolliMemoryService.readArchivedReference(source, archivedKey)` delegates to `SummaryReader.readReferenceBody`, which:

1. Derives `wire` from the source, `bareKey` by stripping the `"<wire>:"` prefix, and `stem` via `pathKey` — in that order, before anything is read.
2. Applies a stem check: `if (".." in stem || "/" in stem || "\\" in stem) return null`.
3. Reads `references/$wire/$stem.md` through the bridge-backed storage provider.

Returns null when the archived Markdown is absent. There is no second leg and no short-circuit: the derivation is unconditional, and it is the only thing standing between the caller's key and the storage lookup.

### The stem check

Step 2 is documented as unreachable on well-formed data: `pathKey` strips `/` and `\` for the unsafe sources, and identity is applied only to sources whose native ids cannot contain those bytes. It is retained for tampered or older-format data that predates the sanitize contract. It is a byte test on the derived stem — not a canonicalized containment check against a composed filesystem path, because no filesystem path is composed here.

### The call site

`CommitsPanel`'s CONTEXT group routes a reference row's click by whether the reference carries an upstream `url`. Rows **without** one — a Jolli Memory recall, and any track-only source — call `openArchivedMarkdownSource(commit, label) { service.readArchivedReference(src, ref.archivedKey) }`. The body opens in a **source-view** editor rather than a rendered preview, because the archived file's YAML frontmatter and HTML comments carry the metadata (source, native id, `referencedAt`, tool name) a user opening a reference expects to see. A null body falls back to opening the whole commit summary when the commit has one, and does nothing otherwise.

The editor's file name is the row's display title, composed by `SourceDisplay.displayTitle` (spec 313).

## Notable Behavior

- **This is the one read shape on this host whose key must be transformed.** Its siblings — parsed summary record, raw summary bytes, plan body, note body, stored transcript — interpolate the caller's key verbatim into a storage-relative path. Only this one derives a stem first, and the derivation is what the CLI writer's own layout note and AGENTS.md's "Critical rules" both register. The obligation survived the deletion of the second read source unchanged, because it was never about the filesystem: the stem is the key the storage stack is asked for, whichever backend answers.
- **The regression this closed returned null, not an error.** The read previously interpolated the raw bare key. For GitHub that produced `references/github/owner/repo#42-abc12345.md` — a **nested subdirectory** the CLI never creates — and for Context7 a path with a leading-slash segment. The lookup missed, returned null, and the UI's null path silently falls back to opening the entire commit summary. So every GitHub and Context7 reference row appeared to work while showing the wrong document, on every IntelliJ surface, with no log line anywhere. (Surprising; a naming bug that presents as a UX quirk.)
- **The Kotlin and CLI sanitizers agree on output and disagree on refusal.** `sanitizeNativeIdForPath` **throws** when a path-safe source's native id contains `..`, `/`, or `\`, on the grounds that the CLI rehydrates native ids from untrusted archived Markdown with no per-source format check. `SourceIds.pathKey` has no such throw — identity is unconditional — and the Kotlin side instead defends *after* derivation, with the single byte check on the stem. Same stems on well-formed input, different failure shapes on hostile input.
- **The CLI is conservative about unknown sources; the Kotlin port cannot be.** `sanitizeNativeIdForPath` treats a source unregistered in `SourceDefinitionRegistry` as path-**unsafe** (the sha8 form is safe for any input), and `orphanPathFor` refuses an unregistered source outright with a thrown error. `SourceId` is a closed Kotlin enum, so an unrecognized source decodes to `null` and is filtered out long before `pathKey` — the conservative arm has no Kotlin counterpart because it has no Kotlin input. The corresponding CONTEXT row is skipped entirely (spec 313), so an unknown source's archived body is simply unreachable from IntelliJ until the enum is extended.
- **The eight-hex tail is computed over a key that already ends in a hash.** The archive form is `<nativeId>-<shortHash>`, so a GitHub stem reads `owner-repo-42-abc12345-<sha8>` — two unrelated hashes in one file name. This is correct and required: the CLI hashes the same value, and the same reference archived against two commits legitimately yields two different files.
- **Refusing is no longer free.** The stem check was written when a decline cost nothing — a second read source could serve the identical body — and it kept its refuse-first shape after that source was deleted. With one leg, a refusal is the final answer for that row: the user gets the whole commit summary instead of the reference. Nothing about the check changed; what changed is what a refusal now costs.
- **Both silent outcomes look identical, and the third is not silent at all.** A stem refusal and an absent file both return null with no log line, and the user sees the commit summary open with no way to tell them apart. A *failed* read is different: the bridge call throws rather than returning null, and nothing on the path between the storage call and the click handler converts it, so the summary fallback does not run for a failure — only for an absence. (Surprising.)

## State Transitions

Stateless. Every call derives its path from its arguments alone; nothing is cached, memoized, or carried between calls, and no marker or attach state is consulted.

## Shared Behavior

- **IntelliJ Direct Memory-Mirror Read Path, Retired (307)** — the historical record of the deleted second read source this shape used to try first, including the out-of-sync gate and containment guard that went with it. Nothing in it describes live behavior.
- **CLI IDE-Bridge Command Surface (287)** and **IntelliJ CLI Daemon Connection (288)** — own the storage action that now carries this read and the transport it travels on; **Cutover Routing State Table (344)** owns which backend answers it.
- **Reference store markdown persistence (179)** — owns the archived file's frontmatter and body format, and the per-source subdirectory convention.
- **Source-definition DSL and evaluation engine (255)** and **Transcript reference extraction (153)** — own `nativeIdPathSafe`, which sources carry it, and where a native id comes from.
- **IntelliJ Source Presentation Table (313)** — owns `SourceId`'s display half (badge, colour, label) and the `displayTitle` used as the opened editor's name; `ReferenceTypes.kt` hosts both halves.
- **IntelliJ Commits Panel (123)** — owns the CONTEXT row whose click reaches this read, and the summary-viewer fallback taken when it returns null.
- **Lockstep pinning** — `SourceIdsTest` is now the whole gate: wire names, prefix stripping, identity for every path-safe source, the GitHub canonical stem regenerated byte-for-byte, determinism, and cross-repo / versioned-id collision separation. The read-shape tests that used to sit alongside it (`FolderStorageReaderTest.readReferenceBody*` — identity stem, GitHub sanitized stem, a *different* GitHub key missing, Context7 sanitized stem, and the dirty short-circuit) went with the deleted reader, so nothing pins the composed path any more, only the stem function. A change to `SummaryStore.orphanPathFor` or a new source declared `nativeIdPathSafe: false` must update `PATH_UNSAFE_SOURCES` and that test in the same change; AGENTS.md registers the pair.
