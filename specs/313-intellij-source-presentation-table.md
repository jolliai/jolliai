# 313. IntelliJ Source Presentation Table

## Topic Statement

One Kotlin object, [`SourceDisplay`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/references/SourceDisplay.kt), is the single table every IntelliJ surface consults before painting an external-reference row: it maps each of the twelve `SourceId` enum values to a `Style(tag, color, label)` — a one-character badge letter, a brand hue, and a human label — resolves an unrecognized (Gson-nulled) source to a fixed neutral placeholder instead of throwing, and additionally owns the *label composition* policy (`<nativeId> — <title>` for the three issue trackers whose native id a human recognizes, bare title for everyone else). Five panels consume it — the plans/notes/references list, the commits panel's CONTEXT group, the working-memory web view, the summary panel's remove-confirmation dialog, and the pin write path — so a new source lands in one file rather than five letter switches. The letters and hex values are a hand-maintained byte-for-byte mirror of the VS Code extension's `SOURCE_META` and the CLI's `ReferenceDisplay.ts`; the *fallback* deliberately is not a mirror, and the pin write path stamps a badge the PINNED panel's own colour map can no longer key on.

## Scope

**In scope:**
- The twelve `Style` rows, the neutral fallback row, and the exhaustive `when` that resolves a nullable `SourceId` to one of them.
- The `labelLeadsWithNativeId` / `displayTitle` label-composition policy and which sources opt in.
- Every IntelliJ call site that reads the table, and what each does with the result.
- The cross-language lockstep obligation this table creates against VS Code's `SOURCE_META` and the CLI's `ReferenceDisplay.ts`, and precisely where the mirror stops.
- The two deliberate letter collisions, and the drift the table's letters created for pinned rows.

**Out of scope:**
- The `SourceId` enum's own membership, wire names, and the `pathKey` sanitize that shares the file — the enum's storage-facing half is owned by spec 317; its extraction-facing half by specs 153 and 255.
- The PINNED panel's row model, badge fallback chain, and colour maps — owned by spec 220; this spec owns only the badge *value* the pin write path stamps.
- The COMMITTED MEMORIES row anatomy and CONTEXT group structure — owned by spec 123.
- The PLANS & NOTES list's own row model and icons — owned by spec 132.
- The WORKING MEMORY web view's rendering — owned by specs 221 / 222.
- The VS Code and CLI implementations this table mirrors — owned by their own display specs; this spec states only the obligation and where it diverges.
- Reading an archived reference body when a row is clicked — owned by spec 317.

## Data Contracts

### `Style`

`data class Style(val tag: String, val color: Color, val label: String)`. Every field is a display value; nothing here is persisted or parsed.

### The twelve rows

| `SourceId` | `tag` | `color` (light / dark) | `label` |
|---|---|---|---|
| `linear` | `L` | `0x5E6AD2` / `0x5E6AD2` | Linear |
| `jira` | `J` | `0x0052CC` / `0x0052CC` | Jira |
| `github` | `G` | `0x6E7681` / `0x6E7681` | GitHub |
| `notion` | `N` | `0x787774` / `0x787774` | Notion |
| `slack` | `S` | `0x4A154B` / `0x4A154B` | Slack |
| `jollimemory` | `J` | `0x9B5CFF` / `0x9B5CFF` | Jolli Memory |
| `context7` | `7` | `0x0B7285` / `0x0B7285` | Context7 |
| `confluence` | `C` | `0x1868DB` / `0x1868DB` | Confluence |
| `asana` | `A` | `0xF06A6A` / `0xF06A6A` | Asana |
| `monday` | `M` | `0xFF3D57` / `0xFF3D57` | monday.com |
| `zoom-doc` | `Z` | `0x2D8CFF` / `0x2D8CFF` | Zoom Doc |
| `zoom-meeting` | `Z` | `0x2D8CFF` / `0x2D8CFF` | Zoom Meeting |

Every row is a `JBColor(light, dark)` whose two arguments are **identical** — the table commits to the source's brand hue in both IDE themes rather than adapting. (Contrast `PinnedPanel.TAG_COLORS`, which does carry distinct dark values for four of its seven entries.)

### The neutral fallback

`UNKNOWN = Style("R", JBColor(0x6E7681, 0x6E7681), "Reference")`, exposed both as the `null` arm of `of(...)` and as the public accessor `unknown()`. It is reached whenever Gson leaves `source` null — which happens for any source string the CLI writes that this closed Kotlin enum does not yet carry.

### Label composition

`labelLeadsWithNativeId(source)` is `true` for exactly `linear`, `jira`, `github` — the three trackers whose native id is a key a human reads at a glance (`PROJ-42`, `KAN-5`, `owner/repo#123`). `displayTitle(source, nativeId, title)` returns `"$nativeId — $title"` for those three and the bare `title` for every other source and for `null`. The separator is an em dash surrounded by single spaces.

### The lockstep set

The letters and hex values mirror `vscode/src/views/SourceLabels.ts` `SOURCE_META`; the label policy mirrors `cli/src/core/references/ReferenceDisplay.ts` (`labelLeadsWithNativeId` / `referenceDisplayTitle`, whose `NATIVE_ID_TRACKER_SOURCES` is the same three-element set). All twelve rows agree byte-for-byte with `SOURCE_META` today. What is **not** mirrored is the fallback (see Notable Behavior) and the VS Code table's two extra fields (`icon`, the codicon id; and its CSS-token derivation), which have no IntelliJ counterpart.

## Behavior

### Resolution

`SourceDisplay.of(source: SourceId?)` is a total function over the nullable enum: twelve arms plus `null → UNKNOWN`. It is a `when` with **no `else` arm**, which is load-bearing — adding an enum value fails compilation here rather than silently rendering as unknown.

### Consumers

| Call site | What it reads | Effect |
|---|---|---|
| `PlansPanel.tagFor` (`PlansPanel.kt:741`) | `of(ref.source)` → `tag to color` | Reference rows get their letter and hue; plan/note/snippet rows use the panel's own `TAG_PLAN` / `TAG_NOTE` / `TAG_SNIPPET` constants. All four kinds render through `TagLabel` (a filled pill). |
| `PlansPanel.titleFor` (`:758`) | `displayTitle(...)` | The CONTEXT row's title text. |
| `PlansPanel.pinItem` (`:350`, `:360`) | `displayTitle(...)` and `of(...).tag` | The title and badge written into the pin store for a reference pin. |
| `PlansPanel.buildReferencePopupContent` (`:905`) | `of(ref.source).label` | The hover popup's `Source: <label>` line. The popup deliberately shows the **plain title**, not `displayTitle`, so it does not repeat the row. |
| `CommitsPanel` CONTEXT group (`:1525`, `:1537`) | `displayTitle(...)` and `of(src)` | The row label plus a filled brand-coloured `TagLabel`. |
| `WorkingMemoryPanel.referenceTag` (`:373`) | `of(source).tag` | The letter carried into the web view's reference row model. |
| `SummaryPanel.handleRemoveReference` (`:2170-2173`) | `SourceIds.parse(source)` then `displayTitle(...)` | The confirmation dialog title, so `Remove reference "…"?` reads exactly like the row the user clicked. |

### Filled pill versus outlined chip

`TagLabel` (`TagLabel.kt:43-54`) paints a solid rounded rect in the supplied colour with a white 9pt bold letter, sized 18 px wide for a one-character tag and 24 px for two. `CommitsPanel.contextRow` (`:1901-1912`) takes `tagColor` as a **nullable** parameter: reference rows pass the brand colour and get the filled pill, while plan and note rows omit it and fall through to `chip(tag, CHIP_DIM_COLOR)` — the original outlined dim chip. `PlansPanel` makes no such distinction: it renders `TagLabel` for every kind (`:579-583`), so the same plan row is an outlined chip in COMMITTED MEMORIES and a filled blue pill in PLANS & NOTES.

### The unknown-source path is not uniform

Two consumers reach the neutral fallback and one does not:

- `PlansPanel.tagFor` and `WorkingMemoryPanel.referenceTag` accept a nullable source and render `R` / `#6E7681` / "Reference".
- `CommitsPanel`'s CONTEXT loop (`:1520`) instead **skips the row entirely** — `val src = ref.source ?: return@forEach` — with a comment stating the row will start rendering once the enum is extended. So an unrecognized source is a neutral placeholder in two panels and an invisible row in the third.

## Notable Behavior

- **Two letter collisions are deliberate.** `J` is shared by Jira (`0x0052CC`) and Jolli Memory (`0x9B5CFF`); `Z` is shared by Zoom Doc and Zoom Meeting, which additionally share one hue (`0x2D8CFF`) and are therefore visually indistinguishable at badge size. The Jira/Jolli collision is documented at `SourceDisplay.kt:29-32` as an accepted trade (badge colours differ, Jolli is the first-party brand) and matches the same call VS Code made. The Zoom pair collides on both axes with no comment. (Intentional.)
- **The fallback is where the "byte-for-byte mirror" stops.** VS Code's `getSourceMeta` derives its fallback *from the id*: `{label: id, letter: id[0].toUpperCase(), icon: "link", color: NEUTRAL_SOURCE_COLOR}`. IntelliJ's is a fixed constant: `R` / "Reference". Only the colour agrees. So a future CLI source named `hubspot` renders as `H` / "hubspot" in VS Code and `R` / "Reference" in IntelliJ, from identical on-disk data. The file's own docstring claims the neutral colour is "VSCode's fallback color for the same purpose", which is true — and easy to read as a claim about the whole fallback, which it is not. (Surprising.)
- **The pin badge and the PINNED panel's colour map no longer agree.** `PlansPanel.pinItem` stamps the badge from `SourceDisplay.of(...).tag` (`:357-361`), so a GitHub pin is persisted with badge `"G"` and a Notion pin with `"N"`. `PinnedPanel.TAG_COLORS` (`PinnedPanel.kt:387-395`) still keys on the pre-table letters `"GH"` and `"No"` — both are now **dead keys**, reachable only by pins written before the table landed. The consequences differ per source:
  - `"G"` (GitHub) misses the map and falls through to `JBColor.GRAY` (`PinnedPanel.kt:289`).
  - `"N"` (Notion) *hits* — but hits the **note-green** `0x3FA45B` entry, so a Notion pin renders in the colour reserved for notes.
  - `"S"` (Slack) likewise hits the snippet-amber entry.
  - `"L"` (Linear) and `"J"` (Linear's neighbours Jira/Jolli) hit entries whose hues (`0x7A6FF0`, `0x2A78C8`) do not match `SourceDisplay`'s (`0x5E6AD2`, `0x0052CC` / `0x9B5CFF`), so the same reference is one colour in CONTEXT and a different colour in PINNED.
  - `"C"`, `"A"`, `"M"`, `"Z"`, `"7"`, and the fallback `"R"` are absent from the map entirely and render grey.

  The map's own comment still reads "Mirrors PlansPanel tag colors (P/N/S/L/GH/J/No)" — accurate for the three plan/note letters (`P`/`N`/`S` match `TAG_PLAN`/`TAG_NOTE`/`TAG_SNIPPET` exactly) and stale for everything else. Documented here as observed reality; see spec 220 for the panel's own badge-resolution chain.
- **`CommitsPanel.referenceTag` is dead.** The helper at `CommitsPanel.kt:1996-1997` is defined, documented, and referenced only by a comment (`:1518`); no call site remains — the CONTEXT loop inlines `SourceDisplay.of(src)` at `:1537` to get the colour as well as the letter. It is the vestige of the letter-switch this table replaced.
- **The table owns a policy, not just pixels.** `displayTitle` is the reason a Linear row reads `PROJ-42 — Fix the thing` while a Jolli Memory row reads only `Recall`. Moving that decision here is what lets `PlansPanel`, `CommitsPanel`, and `SummaryPanel`'s confirm dialog agree on the string a user is about to act on — the dialog explicitly composes the same title so "Remove reference X?" names the row that was clicked.
- **The `when` has no `else` on purpose.** `ReferenceTypes.kt:26-29` states the rule directly: an `else` arm would let a newly-added enum value slip past this table silently instead of failing to compile. The nullable input is what absorbs the *runtime* unknown (a CLI-side source this enum has not caught up with); the exhaustive `when` is what absorbs the *compile-time* one.

## Shared Behavior

- **IntelliJ Commits Panel (123)** — owns the CONTEXT group this table paints into, and the collapsed/expanded row anatomy around it. Its scope text still describes the reference tags as `L/J/GH/No`, which predates this table.
- **IntelliJ PLANS & NOTES Panel (132)** and **IntelliJ Working Memory (221 / 222)** — own the lists whose reference rows read the table.
- **IntelliJ Pinned Panel (220)** and **Pin Store (246)** — own the persisted badge field, its fallback chain, and the colour maps the letters above are fed into.
- **IntelliJ Summary Viewer (120)** — owns the summary panel whose remove-reference dialog composes `displayTitle`.
- **IntelliJ Archived Reference Body Read (317)** — owns `SourceId`'s wire names and the `pathKey` sanitize that shares `ReferenceTypes.kt`, and the read a reference row's click performs.
- **Transcript reference extraction (153)**, **External reference source adapters (154)**, and **Source-definition DSL (255)** — own where a `SourceId` comes from and what a source's `label` means upstream.
