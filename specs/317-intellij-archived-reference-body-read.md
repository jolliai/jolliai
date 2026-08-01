# 317. IntelliJ Archived Reference Body Read

## Topic Statement

Reading an archived external-reference body in IntelliJ — the Markdown the CLI wrote to `references/<source>/<stem>.md` when a commit landed — cannot interpolate the key the caller holds. The caller holds an `archivedKey` of the form `<wire>:<nativeId>-<shortHash>`, and for GitHub (whose native id is `owner/repo#n`) and Context7 (whose native id is `/org/project`) that bare key contains bytes the CLI never puts in a file name. `SourceIds.pathKey` ([`core/references/ReferenceTypes.kt:98-106`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/references/ReferenceTypes.kt)) is the Kotlin read-side mirror of the CLI's `sanitizeNativeIdForPath`: identity for every path-safe source, and `[^\w.-] → "-"` plus an eight-hex SHA-256 tail computed over the **raw** bare key for those two. Both Kotlin readers apply it before touching disk — the folder mirror first (dirty-gated, with a doubled containment guard because the path has two caller-derived segments), then the orphan branch, whose leg keeps its own defense-in-depth check on the final stem. Getting this wrong is not a partial failure: before the sanitize was ported, every GitHub and Context7 body resolved to a nested path the CLI never writes and returned null on every surface.

## Scope

**In scope:**
- `SourceIds.wireName` / `stripPrefix` / `pathKey`, and the closed set of path-unsafe sources.
- The two-leg read (`SummaryReader.readReferenceBody`), its ordering, and the service entry point it is reached through.
- The folder leg's dirty gate and its **two** containment checks, and why the reference shape needs two where the plan and note shapes need one.
- The orphan leg's stem check and why it is unreachable on well-formed data.
- The byte-for-byte lockstep obligation against the CLI writer, and the tests that pin it.
- The regression this closed and the divergences from the CLI implementation that remain.

**Out of scope:**
- The write side — how a reference is extracted, rendered to Markdown with YAML frontmatter, and archived on commit (owned by specs 153, 179, and 255, and by `SummaryStore.storeReferences` on the orphan branch).
- The direct-mirror reader's construction preconditions, its attach and re-attach lifecycle, its per-read out-of-sync gate mechanics, and its canonicalization-based containment helper — all owned by spec 307 and cited here, not restated.
- The orphan-branch storage backend and the native git wrapper the fallback leg reads through (owned by specs 01 and 126).
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

### The two on-disk layouts

| Leg | Path |
|---|---|
| Folder mirror | `<kbRoot>/.jolli/references/<wire>/<stem>.md` |
| Orphan branch | `references/<wire>/<stem>.md` on `jollimemory/summaries/v3` |

`<stem>` is `pathKey(source, stripPrefix(wireName(source), archivedKey))` in both.

## Behavior

### The read, end to end

`JolliMemoryService.readArchivedReference(source, archivedKey)` (`services/JolliMemoryService.kt:988-989`) delegates to `SummaryReader.readReferenceBody`, which:

1. Tries the folder mirror: `folder?.readReferenceBody(source, archivedKey)?.let { return it }`. A live mirror reader that returns a body short-circuits.
2. Otherwise derives `wire`, `bareKey`, `stem` exactly as above.
3. Applies a final-stem check: `if (".." in stem || "/" in stem || "\\" in stem) return null`.
4. Reads `references/$wire/$stem.md` from the orphan branch through the native git wrapper.

Returns null when the archived Markdown is absent on both legs.

### The folder leg

`FolderStorageReader.readReferenceBody` (`bridge/FolderStorageReader.kt:151-166`):

1. **Dirty gate first** — `if (isDirty()) return null`, the same presence-only probe of `.jolli/shadow-status.json` that every other shape on this reader performs. Mechanics are owned by spec 307.
2. Derive `wire`, `bareKey`, `stem`.
3. Build `sourceDir = File(referencesDir, wire)` and `file = File(sourceDir, "$stem.md")`.
4. **Two containment checks**, in order: `sourceDir` must sit safely within `referencesDir`, then `file` must sit safely within `sourceDir` and be a regular file. Either refusal returns null.
5. Read the file's text; any throw returns null with no log line.

The doubling is what distinguishes this shape from the plan and note shapes, which build a single caller-derived segment under a fixed directory and therefore need one check. Here the path has **two** caller-derived segments — the source subdirectory and the file stem — so a hostile or malformed `wire` is rejected before the stem check even runs. The `pathKey` sanitize already strips `/` for the unsafe sources, so both checks are documented as defense-in-depth against a future refactor routing unsanitized data past this point.

### The orphan leg's stem check

Step 3 above (`SummaryReader.kt:128-133`) is documented as unreachable on well-formed data: `pathKey` strips `/` and `\` for the unsafe sources, and identity is applied only to sources whose native ids cannot contain those bytes. It is retained for tampered or older-format data that predates the sanitize contract. Unlike the folder leg it is a byte test on the final stem, not a canonicalized containment check — the orphan branch is a git object database, un-escapable by path composition, so the weaker guard is sufficient there.

### The call site

`CommitsPanel`'s CONTEXT group routes a reference row's click by whether the reference carries an upstream `url`. Rows **without** one — a Jolli Memory recall, and any track-only source — call `openArchivedMarkdownSource(commit, label) { service.readArchivedReference(src, ref.archivedKey) }` (`CommitsPanel.kt:1548-1550`). The body opens in a **source-view** editor rather than a rendered preview, because the archived file's YAML frontmatter and HTML comments carry the metadata (source, native id, `referencedAt`, tool name) a user opening a reference expects to see. A null body falls back to opening the whole commit summary when the commit has one, and does nothing otherwise.

The editor's file name is the row's display title, composed by `SourceDisplay.displayTitle` (spec 313).

## Notable Behavior

- **This is the one read shape on the direct mirror reader whose key must be transformed.** The reader's other shapes — parsed summary record, raw summary bytes, plan body, note body — interpolate the caller's key verbatim. `readReferenceBody` consumes a path of its own (`.jolli/references/<source>/<stem>.md`) and derives its stem. The CLI writer's own lockstep note (`cli/src/core/FolderStorage.ts:18-23`), AGENTS.md's "Critical rules", and spec 307 all list this path alongside the others.
- **The regression this closed returned null, not an error.** The readers previously interpolated the raw bare key. For GitHub that produced `references/github/owner/repo#42-abc12345.md` — a **nested subdirectory** the CLI never creates — and for Context7 a path with a leading-slash segment. Both legs missed, both returned null, and the UI's null path silently falls back to opening the entire commit summary. So every GitHub and Context7 reference row appeared to work while showing the wrong document, on every IntelliJ surface, with no log line anywhere. (Surprising; a naming bug that presents as a UX quirk.)
- **The Kotlin and CLI sanitizers agree on output and disagree on refusal.** `sanitizeNativeIdForPath` (`cli/src/core/references/ReferenceStore.ts:79-97`) **throws** when a path-safe source's native id contains `..`, `/`, or `\`, on the grounds that the CLI rehydrates native ids from untrusted orphan-branch Markdown with no per-source format check. `SourceIds.pathKey` has no such throw — identity is unconditional — and the Kotlin side instead defends *after* composition: the byte check on the orphan leg, the doubled canonicalized containment on the folder leg. Same stems on well-formed input, different failure shapes on hostile input.
- **The CLI is conservative about unknown sources; the Kotlin port cannot be.** `sanitizeNativeIdForPath` treats a source unregistered in `SourceDefinitionRegistry` as path-**unsafe** (the sha8 form is safe for any input), and `orphanPathFor` refuses an unregistered source outright with a thrown error. `SourceId` is a closed Kotlin enum, so an unrecognized source decodes to `null` and is filtered out long before `pathKey` — the conservative arm has no Kotlin counterpart because it has no Kotlin input. The corresponding CONTEXT row is skipped entirely (spec 313), so an unknown source's archived body is simply unreachable from IntelliJ until the enum is extended.
- **The eight-hex tail is computed over a key that already ends in a hash.** The archive form is `<nativeId>-<shortHash>`, so a GitHub stem reads `owner-repo-42-abc12345-<sha8>` — two unrelated hashes in one file name. This is correct and required: the CLI hashes the same value, and the same reference archived against two commits legitimately yields two different files.
- **The dirty gate and the containment guards protect different things and both are cheap because the fallback exists.** Declining costs nothing measurable, because the orphan branch can serve the identical body and is not reachable by path composition. That asymmetry — a free decline, an expensive wrong answer — is why every check on this path is written to refuse first.
- **Three of the four failure modes are silent.** A dirty mirror, a containment refusal, and a read throw all return null with no log line; only the parsed-summary shape on this reader logs at debug. The user sees the commit summary open instead of the reference and has no way to tell which of the four happened.

## State Transitions

Stateless. Every call derives its path from its arguments and the mirror's current out-of-sync marker; nothing is cached, memoized, or carried between calls. (The host's bounded memory cache described in spec 307 covers the parsed-summary shape only and never this one.)

## Shared Behavior

- **IntelliJ Direct Memory-Mirror Read Path (307)** — owns the mirror reader this shape is added to: its construction preconditions, storage-mode gate, per-read out-of-sync probe, canonicalized containment helper, and the fact that every decline is a silent fallback. Cited above, not restated.
- **Orphan Branch Summary Storage (01)** and **IntelliJ Native Git CLI Wrapper (126)** — own the fallback leg and the subprocess that performs it.
- **Reference store markdown persistence (179)** — owns the archived file's frontmatter and body format, and the per-source subdirectory convention.
- **Source-definition DSL and evaluation engine (255)** and **Transcript reference extraction (153)** — own `nativeIdPathSafe`, which sources carry it, and where a native id comes from.
- **IntelliJ Source Presentation Table (313)** — owns `SourceId`'s display half (badge, colour, label) and the `displayTitle` used as the opened editor's name; `ReferenceTypes.kt` hosts both halves.
- **IntelliJ Commits Panel (123)** — owns the CONTEXT row whose click reaches this read, and the summary-viewer fallback taken when it returns null.
- **Lockstep pinning** — `SourceIdsTest` (wire names, prefix stripping, identity for every path-safe source, the GitHub canonical stem regenerated byte-for-byte, determinism, and cross-repo / versioned-id collision separation) and `FolderStorageReaderTest.readReferenceBody*` (identity stem, GitHub sanitized stem, a *different* GitHub key missing, Context7 sanitized stem, and the dirty short-circuit) are the gate. A change to `SummaryStore.orphanPathFor` or a new source declared `nativeIdPathSafe: false` must update `PATH_UNSAFE_SOURCES` and these tests in the same change; AGENTS.md registers the pair.
