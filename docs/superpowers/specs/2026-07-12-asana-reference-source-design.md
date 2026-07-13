# Asana reference source — design

**Date:** 2026-07-12
**Task:** Asana — "Add Asana MCP integration for Claude Code and Codex" (Jolli Memory project)
**Status:** Approved, ready for implementation plan

## Summary

Add Asana as a built-in reference-extraction source so that when a user's Claude
Code **or Codex** session calls the Asana connector's `get_task` tool, the
referenced task (title, notes, URL) is captured as a Jolli reference — exactly
like the existing Linear / Jira / GitHub / Notion / Zoom sources.

This is a **declarative `SourceDefinition`** addition. The Claude half follows the
`zoom-doc` template end-to-end; the Codex half adds a `match.codex` block plus an
identity `CodexAsanaBinding` (mirroring `CodexNotionBinding`). No changes to
`SourceEngine`, the envelope parsers, or the DSL vocabulary are required.

## Scope decisions

1. **Claude Code first, then Codex (both now shipped).**
   The task text names "Claude Code and Codex". The Claude half shipped first
   (commit 11734a5c). Codex was **initially deferred** because at design time no
   Asana connector existed on disk and the prior precedent (the Codex Rovo Jira
   matcher was hallucinated and never matched; JOLLI-1921 shipped only the
   verified Linear half) forbids shipping a guessed `match.codex` block.

   **That precondition is now met.** The machine has the `openai-curated-remote`
   Asana plugin (`~/.codex/plugins/cache/.../asana/7.0.0/`) installed, and a real
   rollout captured a live `get_task` call. The Codex half is implemented against
   that real rollout — see "Codex support" below. No value in `match.codex` is
   guessed; every field is transcribed from the on-disk envelope.

2. **Task entity only (`get_task`).**
   Asana projects and other entities are out of scope. Only single-task fetches
   are extracted. Bulk enumeration/search tools are excluded (they flood Working
   Memory, the same rationale as Linear's `denySuffixes`).

## Truth source (fixture)

A **real** Claude-side Asana `get_task` payload was captured (from the Asana MCP
connector during this session) and is the fixture of record. Shape:

```json
{ "data": {
    "gid": "1216474542361983",
    "name": "Add Asana MCP integration",
    "notes": "Add Asana MCP integration for Claude Code and Codex",
    "permalink_url": "https://app.asana.com/1/.../project/.../task/1216474542361983",
    "assignee": null,
    "completed": false,
    "projects": [ { "gid": "...", "name": "Jolli Memory" } ],
    "memberships": [ { "section": { "name": "Shipped" } } ]
} }
```

The task object is wrapped in a top-level `data` key.

## The `asanaDefinition`

New file: `cli/src/core/references/sources/definitions/asana.ts`.

```
id:      "asana"
label:   "Asana"
icon:    "checklist"           // codicon; finalize in TDD
match.claude: { prefixes: ["mcp__claude_ai_Asana__"], acceptSuffix: "get_task" }
match.codex:  { namespaceSuffix: "asana", functionCallNames: ["_get_task"], invocationTools: ["asana.get_task"] }
wrapperKeys: ["data"]          // descends {data:{task}}; also iterates {data:[...]}
reference:
  nativeId:    path "gid"            require ^\d+$
  title:       path "name"          require .+
  url:         path "permalink_url" require ^https://app\.asana\.com/
  description: path "notes"         optional
fields:
  { key: "entity-type", const: "task" }
  { key: "assignee",    path "assignee.name" }   // object subpath; drops when null
storage: { nativeIdPathSafe: true }   // gid is numeric → identity path
render:  { wrapperTag: "asana-tasks", itemTag: "task", bodyTag: "description",
           maxCharsPerReference: 4000, maxTotalChars: 30000 }
```

### Why these choices

- **`acceptSuffix: "get_task"`** (single-tool allowlist, mirrors Notion's
  `notion-fetch`) rather than `denySuffixes` (blacklist, Linear). Asana's tool
  surface is large; an allowlist is the safer default. `endsWith("get_task")`
  precisely matches `mcp__claude_ai_Asana__get_task` and excludes `get_tasks`,
  `get_my_tasks`, `search_tasks`, `create_task_confirm`, and all write tools.
- **`wrapperKeys: ["data"]`** unwraps the `{data:{...}}` envelope; `walkPayload`
  first tries `extractRef` at the top level (voids — `gid`/`name` live under
  `data`), then descends `data` and matches the task object.
- **`nativeId` from `gid`, `nativeIdPathSafe: true`**: Asana gids are numeric,
  opaque, path-safe strings (like Linear/Notion ids), so the on-disk reference
  path uses the id directly — no sha8 hashing (contrast GitHub's slashed keys).
- **`url` host allowlist `^https://app\.asana\.com/`**: mirrors Notion's
  allow-listed-host approach; rejects arbitrary URLs.
- **Minimal, honest `fields`.** Two DSL constraints (both verified against
  `SourceEngine`) shape this:
  - `readPath` splits on `.` and descends via `isObject` only — it does **not**
    support array indexing, so `projects.0.name` / `memberships.0.section.name`
    cannot be read. Section and project are therefore **not** shown.
  - `toScalar` returns `undefined` for booleans, so `completed` cannot render as
    a field.

  We use a constant `entity-type` (pattern from Notion/Zoom) and `assignee.name`
  (a plain object subpath that cleanly drops when the assignee is null). The
  exact field set is locked against the real fixture during TDD.

## Touch list

Verified against the current subsystem. Ordering downstream (`CLAUDE_TOOL_PREFIXES`,
`referencesBySourceOrder`) derives from `getRegistry().all()`, so appending to
`BUILTIN_DEFINITIONS` is the only functional registration.

| # | File | Edit |
|---|------|------|
| 1 | `cli/src/core/references/sources/definitions/asana.ts` | **NEW** — `asanaDefinition` (above) |
| 2 | `cli/src/core/references/sources/definitions/index.ts` | Import + append `asanaDefinition` to `BUILTIN_DEFINITIONS` |
| 3 | `cli/src/Types.ts` (~775) | Add `"asana"` to `KnownSourceId` union |
| 4 | `vscode/src/views/SourceLabels.ts` | Add `asana` row to `SOURCE_META` (TS-forced by #3): `{ label:"Asana", letter:"A", icon:"checklist", color:"#f06a6a" }` (icon/color match existing `SourceMeta` shape; confirm shape when editing) |
| 5 | `cli/src/core/references/sources/definitions/asana.test.ts` | **NEW** — definition test, mirror `zoom-doc.test.ts`, using the real fixture (canonical case, void case, render case) |
| 6 | `cli/src/core/references/SourceDefinitionRegistry.test.ts` | Extend the `all()` stable-order assertion (append `"asana"`) + add an `asana registration` describe: `match("claude","mcp__claude_ai_Asana__get_task")?.id === "asana"`, and assert enumeration/write tools are rejected |
| 7 *(optional)* | `vscode/src/views/SummaryHtmlBuilder.ts` | Append `"asana"` to `HTML_REFERENCE_SOURCE_ORDER` (committed-memory HTML panel ordering) |

**No edit needed:** `CLAUDE_TOOL_PREFIXES` (auto-derived), `SourceEngine.ts`,
`SourceDefinition.ts`, `ClaudeEnvelopeParser.ts` / `CodexEnvelopeParser.ts`
(Asana payloads are self-contained — no `CONTEXT_NORMALIZERS` entry),
`ReferenceExtractor.ts`.

## Testing

- **Definition test** (`asana.test.ts`): feed the real fixture through
  `extractRef` + `renderBlock`; assert `source`/`nativeId`/`title`/`url`/
  `description`/`fields`; a void case (missing `gid` or non-Asana host); a render
  case (`<asana-tasks><task …>`).
- **Registry test**: stable-order list includes `"asana"`; `get_task` resolves to
  the asana def; `search_tasks` / `get_my_tasks` / `create_task_confirm` do not.
- `npm run all` must pass (CLI 97% coverage floor). New code is a data literal +
  tests, so coverage is met by the definition test exercising every field/require.

## Codex support

### Observed Reality (real rollout, not a fixture)

Captured from `~/.codex/sessions/2026/07/12/rollout-…T20-21-42-…019f5646….jsonl`,
where the user asked Codex to capture an Asana task URL and it called `get_task`.
The connector spans the standard three `codex_apps` line types:

- **`function_call`** (request): `name: "_get_task"`,
  `namespace: "mcp__codex_apps__asana"`, `arguments` a JSON string.
- **`mcp_tool_call_end`** (event): `invocation.server: "codex_apps"`,
  `invocation.tool: "asana.get_task"` — **dotted**, taken verbatim (contrast the
  Notion connector's underscore `notion_fetch`; the tool name is the connector's
  own, not a normalized form). `result.Ok.content[0].text` and
  `result.Ok.structuredContent.data` both carry the task.
- **`function_call_output`** (result): `output` is
  `"Wall time: …\nOutput:\n{\"data\":{…}}"`. After the parser strips the prefix
  the payload is `{ data: { gid, name, notes, permalink_url, assignee, … } }` —
  **byte-identical to the Claude Asana MCP shape.**

The full Asana Codex tool surface (namespace `codex_apps__asana`, `tool_name`
with a leading underscore / `tool.name` prefixed `asana.`) lives in
`~/.codex/cache/codex_apps_tools/*.json`; `_get_task` / `asana.get_task` is the
single-task fetch, alongside `_get_my_tasks`, `_search_tasks`, `_create_tasks`,
etc. (all excluded).

Because the result payload matches the Claude shape, the existing
`wrapperKeys:["data"]` + reference DSL consume it unchanged — **no reshaping**.

### Implementation

1. **`asanaDefinition.match.codex`** (mirrors `notion.ts`):
   ```
   codex: { namespaceSuffix: "asana", functionCallNames: ["_get_task"], invocationTools: ["asana.get_task"] }
   ```
   - `namespaceSuffix: "asana"` + `functionCallNames: ["_get_task"]` — the
     PRIMARY (function_call) match path; `registry.match` strips the shared
     `mcp__codex_apps__` prefix before comparing the suffix.
   - `invocationTools: ["asana.get_task"]` — the FALLBACK (`mcp_tool_call_end`)
     match path, compared against the raw dotted `invocation.tool`.
2. **`CodexAsanaBinding.ts`** — `asanaCodexBinding` with identity `normalize`
   (the payload already matches the def) and
   `canonicalToolName: "mcp__claude_ai_Asana__get_task"` (so a Codex-sourced
   Asana ref persists the same synthetic tool name as the Claude one).
   Registered in `bindings/codex/index.ts` `CODEX_NORMALIZERS` (appended).
3. **Tests**:
   - `CodexEnvelopeParser.test.ts`: an `ASANA` fixture (the real `{data:{…}}`
     output), a PRIMARY-path test, a FALLBACK-path (dotted invocation) test, an
     enumeration-guard test (`_get_my_tasks` yields nothing), and an end-to-end
     `extractReferencesFromTranscript` assertion (`asana:<gid>` → title + url).
   - `SourceDefinitionRegistry.test.ts` `asana registration`: both codex match
     paths resolve; enumeration/write tools and an underscore invocation name do
     not.
   - `bindings/codex/index.test.ts`: `canonicalToolName` + identity `normalize`.

**No edit needed** beyond the above: `SourceEngine`, `CodexEnvelopeParser`, the
DSL vocabulary, and storage/render are untouched — the payload is self-contained,
so no `CONTEXT_NORMALIZERS` / `recover` hook is required (unlike Jira).

## Non-goals

- Asana projects, portfolios, users, or any non-task entity.
- Codex Asana enumeration/search/write tools (only `get_task` is extracted).
- Any change to the DSL vocabulary, the envelope parsers, or storage/render
  common layers.
