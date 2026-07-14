# monday.com reference source — design

**Date:** 2026-07-14
**Task:** monday — "Add monday MCP integration" (Jolli Memory project)
**Status:** Approved, ready for implementation plan

## Summary

Add monday.com as a built-in reference-extraction source so that when a user's
Claude Code **or Codex** session fetches a monday item, the referenced item
(title, description, URL) is captured as a Jolli reference — like the existing
Linear / Jira / GitHub / Notion / Slack / Zoom / Asana sources.

Unlike Asana (a pure-DSL, self-contained source), monday lands in the
**context-normalizer tier** (alongside Slack / zoom-doc / Confluence) because its
data shape forces it there on **two** independent counts:

1. **No single-item getter tool exists.** monday's `get_board_items_page` serves
   *both* "fetch specific items by id" *and* "list/browse a whole board"
   (up to 500 items). Tool-name matching (`acceptSuffix` / `denySuffixes`) cannot
   tell them apart. The only reliable discriminator is the **tool input**: a
   targeted fetch passes `itemIds`; a board browse does not. Reading tool input
   is exactly what the context-normalizer tier is for (Slack's `channel_id`,
   zoom-doc's `fileId`).
2. **The description is doubly-encoded inside an array.** An item's body lives at
   `item_description.blocks[].content`, where each `content` is a **JSON string**
   holding a Quill-style `deltaFormat`. The DSL's dotted `readPath` cannot index
   arrays (`isObject` rejects arrays) nor parse embedded JSON — the same
   limitation that put Confluence's ADF flattening in a normalizer.

Both counts are satisfied by one small `normalizeMonday(payload, { itemIds })`
function; the `mondayDefinition` is then pure-DSL over its clean output.

**One architectural extension is required** (approved): the Codex envelope parser
must thread the `function_call` `arguments` to the normalizer so the `itemIds`
gate works on Codex too. See "Codex support".

## Scope decisions

1. **Item entity only, via `get_board_items_page`.** Boards, docs, updates,
   users, dashboards, widgets, etc. are out of scope. A monday *subitem* is just
   an item on a "Subitems of …" board (same shape, same `/pulses/` URL) — it needs
   no special handling and is covered for free.
2. **Anti-flood gate on `itemIds` (approved).** A reference is produced **only**
   when the tool call carried a non-empty `itemIds` argument (a targeted lookup).
   A board browse (no `itemIds`, N items) is voided — this is monday's equivalent
   of Linear/Jira's enumeration exclusion, and the only anti-flood signal
   available given no single-item tool exists.
3. **Both hosts now (approved).** Claude and Codex. The Codex half is grounded in
   a real on-disk rollout (below), not guessed — honoring the JOLLI-1921 / GitHub
   precedent that forbids a hallucinated `match.codex`.
4. **`column_values` are NOT surfaced as fields.** Their keys are **board-defined**
   and vary per board (proven: the Tasks board uses `task_status`/`task_type`; the
   Subitems board uses `person`/`status`/`date0`). A static DSL path into them
   would work on one board and silently fail on the next. Only stable top-level
   API fields are used.

## Truth source (two real fixtures)

Both captured live this session from the monday MCP connector (Claude side); the
Codex `function_call_output` for the identical call is **byte-identical** after
prefix-strip (verified — see Codex support). Saved:
`scratchpad/monday-real-payload.json`.

**Fixture A — Tasks item, WITH description** (`board 18421599187` / item `12511130115`):

```json
{ "board": { "id": "18421599187", "name": "Tasks" },
  "items": [ {
    "id": "12511130115",
    "name": "Add monday MCP integration",
    "url": "https://jolli-squad.monday.com/boards/18421599187/pulses/12511130115",
    "created_at": "2026-07-12T11:05:25Z",
    "updated_at": "2026-07-14T08:30:22Z",
    "column_values": { "task_status": "In Progress", "task_type": "Feature", "item_id": "TJOL-001", "...": "..." },
    "item_description": { "id": "44442382", "blocks": [
      { "id": "c5d5…", "type": "normal text",
        "content": "{\"direction\":\"ltr\",\"deltaFormat\":[{\"insert\":\"Use MCP to get monday task info in Agents (Claude Code, Codex, etc), Jolli Memory will capture the context in sessions, and show as context reference in working memory.\"}]}" } ] } } ],
  "pagination": { "has_more": false, "nextCursor": null, "count": 1 } }
```

**Fixture B — Subitem, NO description** (`board 18421888353` / item `12526313713`):

```json
{ "board": { "id": "18421888353", "name": "Subitems of Tasks" },
  "items": [ {
    "id": "12526313713",
    "name": "Claude Code Support",
    "url": "https://jolli-squad.monday.com/boards/18421888353/pulses/12526313713",
    "created_at": "2026-07-14T09:15:22Z",
    "updated_at": "2026-07-14T09:15:22Z",
    "column_values": { "person": null, "status": null, "date0": null } } ],
  "pagination": { "has_more": false, "nextCursor": null, "count": 1 } }
```

Fixture B pins two contracts: `item_description` may be **entirely absent**
(→ no description, not an error), and `column_values` keys differ per board.

## `normalizeMonday` (new — `cli/src/core/references/sources/MondayNormalize.ts`)

Signature (mirrors `normalizeZoomDoc` / `normalizeConfluence`):

```
normalizeMonday(payload: unknown, ctx: { itemIds: readonly number[] | undefined }): { items: MondayItem[] } | null
```

Behavior:

1. **Gate:** if `ctx.itemIds` is `undefined` or empty → return `null` (voids the
   whole result — a board browse produces no reference).
2. Read `payload.board?.name` once (carried onto every item as `board`).
3. For each entry in `payload.items` (array), emit a flat canonical item:
   ```
   { id, name, url, created_at, updated_at, board, description? }
   ```
   - `id` / `name` / `url` / `created_at` / `updated_at` copied verbatim.
   - `board` = the board name (may be undefined → dropped downstream).
   - `description` = flattened from `item_description.blocks[]`: for each block,
     `JSON.parse(content)` and concat every `deltaFormat[].insert` string; join
     blocks with `\n`. If `item_description` is absent, no block parses, or the
     result is empty → **omit** `description`. Defensive: any block whose
     `content` is not valid JSON, or lacks `deltaFormat`, is skipped (never
     throws). **Fixture note:** only the single-block / single-insert shape is
     pinned by a real fixture (A); the multi-block/multi-insert concat is written
     defensively and covered by a synthetic test, and flagged as such.
4. Return `{ items }` — even when `items` is empty (extraction then yields nothing,
   which is correct; a non-null empty-items wrapper is fine).

The messy work lives here; the definition below is pure `path` DSL over the
`{ items: [...] }` output — exactly the zoom-doc pattern.

## The `mondayDefinition` (new — `.../sources/definitions/monday.ts`)

```
id:      "monday"
label:   "monday.com"
icon:    "table"                 // codicon; finalize in TDD
match.claude: { prefixes: ["mcp__claude_ai_monday_com__"], acceptSuffix: "get_board_items_page" }
match.codex:  { namespaceSuffix: "monday_com",
                functionCallNames: ["_get_board_items_page"],
                invocationTools:   ["monday_com.get_board_items_page"] }
wrapperKeys: ["items"]           // walkPayload voids at the {items,...} wrapper, descends items[]
reference:
  nativeId:    path "id"          require ^\d+$
  title:       path "name"        require .+
  url:         path "url"         require ^https://[\w-]+\.monday\.com/   flags i
  description: path "description" optional            // already flattened by normalize
fields:
  { key: "entity-type", const: "item" }
  { key: "board",       path "board" }                // drops when board name absent
storage: { nativeIdPathSafe: true }   // monday ids are numeric → identity path
render:  { wrapperTag: "monday-items", itemTag: "item", bodyTag: "description",
           maxCharsPerReference: 4000, maxTotalChars: 30000 }
```

### Why these choices

- **`acceptSuffix: "get_board_items_page"`** (single-tool allowlist, like
  Notion/Asana) — monday's tool surface is ~100 tools; an allowlist is the safe
  default. All write/enumeration/doc/dashboard tools are excluded automatically.
- **`wrapperKeys: ["items"]`** — `normalizeMonday` returns `{ items: [...] }`;
  `walkPayload` voids `extractRef` at the wrapper (no `id`), then descends `items`
  and extracts each flattened item.
- **`url` host allowlist `^https://[\w-]+\.monday\.com/` (case-insensitive)** —
  accepts any account subdomain (`jolli-squad.monday.com`), rejects arbitrary
  hosts. `flags: "i"` because URL hosts are case-insensitive (mirrors Asana).
- **Minimal, honest `fields`** — only `entity-type` (const) and `board` (a stable
  top-level value carried down by normalize). `column_values` deliberately omitted
  (board-specific keys; see scope decision 4).

## Codex support

### Observed reality (real rollout — authoritative, not guessed)

Tool catalog `~/.codex/cache/codex_apps_tools/*.json` (authoritative for tool
existence/names): connector `Monday.com`, `tool_namespace: codex_apps__monday_com`,
`tool.name: monday_com.get_board_items_page`, input schema includes `itemIds`.

Real rollout
`~/.codex/sessions/2026/07/14/rollout-…T17-10-35-019f5fe4….jsonl` — the user had
Codex fetch item `12511130115`. The three `codex_apps` line types:

- **`function_call`** (request): `namespace: "mcp__codex_apps__monday_com"`,
  `name: "_get_board_items_page"`,
  `arguments: {"boardId":18421599187,"itemIds":[12511130115],"includeColumns":true,"includeItemDescription":true,"includeSubItems":true,"subItemLimit":50,"limit":1}`
  — **`itemIds` is present in `arguments`** (the LLM naturally set it, plus `limit:1`).
- **`mcp_tool_call_end`** (event): `invocation.tool: "monday_com.get_board_items_page"`.
- **`function_call_output`** (result): `"Wall time: …\nOutput:\n{board,items,pagination}"`
  — after prefix strip, **byte-identical to the Claude MCP payload** (Fixture A).

Because the result payload matches the Claude shape, `normalizeMonday` consumes it
unchanged — **no reshaping**. The only Codex-specific problem is that `itemIds`
lives in `arguments`, a *different* line from the result, and the current parser
discards it.

### Parser extension (approved deviation from "add a source, don't touch the parser")

Slack / zoom-doc — the existing input-dependent sources — are **Claude-only**
precisely because the Codex path never exposed tool input to normalizers. monday
needs `itemIds`, so we add that capability, minimally and symmetrically with
Claude's existing `toolInput` threading:

1. **`CodexEnvelopeParser`** — `FunctionCallRow` gains `arguments?: string` (the
   raw JSON string, already read for the shell path). Store `payload.arguments` on
   the row in the `function_call` case.
2. In **both** emit loops (PRIMARY `function_call_output` pairs, and the
   `mcp_tool_call_end` FALLBACK), look up the paired request by `call_id`, parse
   its `arguments`, and pass them to `normalize`.
3. **`CodexNormalizer.normalize`** signature gains an optional second param:
   `normalize(business, toolInput?)`. Every existing binding ignores it (identity /
   collection logic unchanged); only monday reads `toolInput.itemIds`.
4. **`CodexMondayBinding.ts`** — `mondayCodexBinding`:
   `normalize: (business, toolInput) => normalizeMonday(business, { itemIds: readItemIds(toolInput) })`,
   `canonicalToolName: "mcp__claude_ai_monday_com__get_board_items_page"` (a
   Codex-sourced monday ref persists the same synthetic tool name as the Claude
   one). Registered in `bindings/codex/index.ts` `CODEX_NORMALIZERS` (appended).

`readItemIds` reads a `number[]` `itemIds` off the parsed arguments object,
returning `undefined` when absent/malformed → the gate then voids (correct: a
Codex board browse has no `itemIds`).

### Claude side

`CONTEXT_NORMALIZERS.monday` in `ClaudeEnvelopeParser.ts`:
`(payload, toolInput) => normalizeMonday(payload, { itemIds: readItemIds(toolInput) })`,
where `toolInput` is the `get_board_items_page` tool_use `input` (already threaded
for sources in `CONTEXT_NORMALIZER_IDS`). `monday` is added to that set — the
existing `CONTEXT_NORMALIZER_IDS.has(def.id)` machinery does the rest.

## Touch list

Verified against the current subsystem. Downstream ordering
(`CLAUDE_TOOL_PREFIXES`, `referencesBySourceOrder`) derives from
`getRegistry().all()`, so appending to `BUILTIN_DEFINITIONS` is the only
functional registration.

| # | File | Edit |
|---|------|------|
| 1 | `cli/src/core/references/sources/MondayNormalize.ts` | **NEW** — `normalizeMonday` + `readItemIds` (delta flatten, itemIds gate) |
| 2 | `cli/src/core/references/sources/definitions/monday.ts` | **NEW** — `mondayDefinition` (above) |
| 3 | `cli/src/core/references/sources/definitions/index.ts` | Import + append `mondayDefinition` to `BUILTIN_DEFINITIONS` |
| 4 | `cli/src/Types.ts` (~775) | Add `"monday"` to `KnownSourceId` union |
| 5 | `cli/src/core/references/ClaudeEnvelopeParser.ts` | Add `monday` entry to `CONTEXT_NORMALIZERS` (reads tool_use `input.itemIds`) |
| 6 | `cli/src/core/references/bindings/codex/CodexBinding.ts` | `normalize(business, toolInput?)` — add optional 2nd param to the interface |
| 7 | `cli/src/core/references/CodexEnvelopeParser.ts` | Keep `arguments` on `FunctionCallRow`; join by `call_id` and pass parsed args to `normalize` in both emit loops |
| 8 | `cli/src/core/references/bindings/codex/CodexMondayBinding.ts` | **NEW** — `mondayCodexBinding` (normalize via `normalizeMonday`, canonicalToolName) |
| 9 | `cli/src/core/references/bindings/codex/index.ts` | Import + append `mondayCodexBinding` to `CODEX_NORMALIZERS` |
| 10 | `vscode/src/views/SourceLabels.ts` | Add `monday` row to `SOURCE_META` (TS-forced by #4): `{ label:"monday.com", letter:"M", icon:"table", color:"#ff3d57" }` (color = monday brand; confirm when editing) |
| 11 | `.../definitions/monday.test.ts` | **NEW** — definition test over both fixtures (with/without description, void cases, render) |
| 12 | `.../sources/MondayNormalize.test.ts` | **NEW** — gate (no itemIds → null), delta flatten (single + synthetic multi-block), missing description |
| 13 | `cli/src/core/references/SourceDefinitionRegistry.test.ts` | Extend `all()` stable-order (append `"monday"`); add a `monday registration` describe (claude `get_board_items_page` resolves; both codex paths resolve; enumeration/write tools do not) |
| 14 | `cli/src/core/references/ClaudeEnvelopeParser.test.ts` | monday end-to-end: tool_use(input.itemIds)+tool_result → `monday:<id>`; board-browse (no itemIds) → nothing |
| 15 | `cli/src/core/references/CodexEnvelopeParser.test.ts` | monday PRIMARY + FALLBACK paths using the real rollout arguments+output; no-itemIds → nothing |
| 16 | `cli/src/core/references/bindings/codex/index.test.ts` | `mondayCodexBinding` canonicalToolName + normalize-with-toolInput |
| 17 *(optional)* | `vscode/src/views/SummaryHtmlBuilder.ts` | Append `"monday"` to `HTML_REFERENCE_SOURCE_ORDER` if that list is exhaustive |

**No edit needed:** `CLAUDE_TOOL_PREFIXES` (auto-derived), `SourceEngine.ts`,
`SourceDefinition.ts` (no new op — delta flattening is in `normalizeMonday`, not
the DSL), `ReferenceExtractor.ts`.

## Testing

- **`MondayNormalize.test.ts`**: itemIds gate (undefined/empty → null; present →
  wrapper); delta flatten for Fixture A's single block; a synthetic multi-block /
  multi-insert case; missing `item_description` (Fixture B) → no `description`; a
  malformed-`content` block is skipped without throwing.
- **`monday.test.ts`**: feed the normalized shape through `extractRef` +
  `renderBlock` — assert source/nativeId/title/url/description/fields for A;
  description-absent for B; void cases (missing `id`, non-monday host); render
  `<monday-items><item …>`.
- **Registry test**: stable-order list includes `"monday"`; claude
  `get_board_items_page` and both codex match paths resolve to monday; write/
  enumeration tools (`create_item`, `get_updates`, `get_board_info`, …) do not.
- **Envelope tests** (Claude + Codex): end-to-end with real
  arguments/output; the no-`itemIds` browse yields nothing on both hosts.
- `npm run all` must pass (CLI 97% coverage floor). The parser change is the only
  non-data code — covered by the two envelope tests (PRIMARY + FALLBACK, gated and
  ungated).

## Non-goals

- monday boards, docs, updates, users, dashboards, widgets, or any non-item entity.
- Surfacing `column_values` (status/owner/type/…) — board-specific keys.
- monday write/enumeration/search tools.
- Any change to the DSL op vocabulary or storage/render common layers.
- Retroactive Codex input-threading for Slack / zoom-doc (out of scope; they stay
  Claude-only unless separately revisited).
