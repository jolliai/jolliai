# Asana reference source — design

**Date:** 2026-07-12
**Task:** Asana — "Add Asana MCP integration for Claude Code and Codex" (Jolli Memory project)
**Status:** Approved, ready for implementation plan

## Summary

Add Asana as a built-in reference-extraction source so that when a user's Claude
Code session calls the Asana MCP connector's `get_task` tool, the referenced task
(title, notes, URL) is captured as a Jolli reference — exactly like the existing
Linear / Jira / GitHub / Notion / Zoom sources.

This is a **declarative `SourceDefinition`** addition. It follows the
`zoom-doc` template (the most recently added source) end-to-end. No changes to
`SourceEngine`, the envelope parsers, or the DSL vocabulary are required.

## Scope decisions

Two scope questions were resolved with the requester before design:

1. **Claude Code only this round; Codex deferred.**
   The task text names "Claude Code and Codex", but the Codex half has **no
   truth source** and cannot get one right now:
   - `~/.codex/config.toml` has no Asana MCP server.
   - The real Codex MCP tools observed in on-disk rollouts are `codex_apps` →
     `atlassian_rovo.*` and `notion.fetch` — **no Asana**.
   - Codex itself, in a rollout, stated it had no Asana connection capability.

   Per prior precedent (the Codex Rovo Jira matcher was hallucinated and never
   matched; JOLLI-1921 shipped only the verified Linear half), we do **not**
   ship an unverified `match.codex` block. Shipping a guessed Codex matcher
   produces dead code, not working coverage.

   **Codex is recorded as a follow-up** (see "Deferred: Codex" below) with an
   explicit precondition: a real `codex_apps` Asana rollout captured on disk.

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

## Deferred: Codex

Not implemented this round. Preconditions to add it later:

1. A real Codex rollout on disk showing an Asana call under the `codex_apps`
   server — the exact `server`/`tool` naming (e.g. `asana.get_task` vs
   `asana.fetch`) must be read from that rollout, not guessed.
2. Then add a `match.codex` block to `asanaDefinition` and a
   `CodexAsanaBinding` (identity normalize, mirroring `CodexNotionBinding.ts`),
   registered in `bindings/codex/index.ts` `CODEX_NORMALIZERS`, plus a
   `CodexEnvelopeParser.test.ts` case built from the real rollout JSONL.

## Non-goals

- Asana projects, portfolios, users, or any non-task entity.
- Codex support (deferred, above).
- Any change to the DSL vocabulary, the envelope parsers, or storage/render
  common layers.
