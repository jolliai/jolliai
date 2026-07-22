# context7 reference tracking (track-only) — design

**Date:** 2026-07-22
**Status:** approved for planning
**Scope:** Add context7 as a new *reference source* in the reference-extraction subsystem, purely for tracking which libraries were referenced during work on a commit. Track-only: it is attached to the commit and shown wherever references are listed, but it never feeds the LLM that generates memory decisions.

## Goal

context7 (`@upstash/context7-mcp`) is a third-party MCP server that serves up-to-date library documentation. When an AI agent uses it, we want to record **when context7 was used and which libraries it referenced**, associated with the commit — so a reader can later see "while working on this commit, docs for `/vercel/next.js` were consulted." Nothing more: we do not summarize the docs, and the reference must not influence generated memory content.

## Non-goals (YAGNI)

- Tracking `resolve-library-id` searches (fuzzy intent). Only confirmed `query-docs` fetches count.
- Storing the returned documentation body.
- Per-call history (references dedupe per library).
- Registering the context7 MCP server. context7 is installed by the user; we only *observe* its calls in transcripts.
- IntelliJ surfacing.

## Ground truth (captured live 2026-07-22)

All shapes below were captured from real runs, not inferred. Raw MCP payloads captured by driving `npx @upstash/context7-mcp` over stdio; the real Codex envelope captured from a live `codex-cli 0.145` rollout. Fixtures were scrubbed of the user's API key.

### context7 tool surface (server v3.2.4)

Two tools:

| Tool | Args | Returns |
|------|------|---------|
| `resolve-library-id` | `{ query, libraryName }` | markdown text: candidate library IDs (`- Context7-compatible library ID: /vercel/next.js`) |
| `query-docs` | `{ libraryId, query }` | markdown text: aggregated doc snippets |

Critical facts:

- The **current** doc-fetch tool is `query-docs`, **not** `get-library-docs` — the older name returns `MCP error -32602: Tool ... not found` on v3.2.4. We still accept the legacy name for older installs.
- The **referenced library lives in the tool-call arguments** (`query-docs.libraryId`), not in the result. The result is prose. context7 is therefore an *input-dependent* source (same category as `monday`, which reads `itemIds` from arguments).
- **The result is markdown prose, not JSON — and both core parsers assume JSON.** `ClaudeEnvelopeParser` does `JSON.parse(payloadText)` (`:346`) and drops the entry if it throws; `CodexEnvelopeParser`'s fallback does `tryParse(ev.text); if (null) continue` (`:283`). context7's markdown fails both, dropping the call *before* the arguments-only normalizer runs. context7 is the first prose-result source (monday is input-dependent but its result is JSON). This is why the design adds `argumentsDerived` and a guarded parse-fail branch to both parsers.
- Results carry no single "doc page URL"; each snippet has its own `Source:` GitHub link. There is no per-query doc URL to store.
- The library-level browsable page `https://context7.com/<libraryId>` **does** resolve (verified for `/vercel/next.js`) — this is the correct URL for the reference (the entity is the library, not a doc).

### Host envelope shapes

**Claude** (local MCP): `tool_use.name = "mcp__context7__query-docs"`, `input = { libraryId, query }`; paired `tool_result.content` = the doc text (JSON-stringified or string).

**Codex** — two real shapes exist:

1. Local MCP server (this machine's `[mcp_servers.context7]`): `function_call.name = "query_docs"`, `namespace = "mcp__context7"`; `mcp_tool_call_end.invocation = { server: "context7", tool: "query-docs" }`.
2. `codex_apps` connector (tool catalog): `function_call.name = "_query_docs"`, `namespace = "codex_apps__context7"`; `invocation.tool = "context7.query-docs"`.

On this machine context7 is a **local** MCP server (`[mcp_servers.context7]`), so its calls appear as shape 1 — `namespace = "mcp__context7"`, which does **not** start with `mcp__codex_apps__`. The Codex parser's PRIMARY path (`resolveCodexDef`) therefore rejects it; local-MCP context7 matches only via the **FALLBACK** path on the `mcp_tool_call_end` event, where `invocation = {server:"context7", tool:"query-docs"}` and `invocation.arguments` carries `{libraryId, query}` (both verified in the capture). The `codex_apps` connector variant (shape 2) matches via PRIMARY. `match.codex.invocationTools` must include both `"query-docs"` (local) and `"context7.query-docs"` (connector). Codex 0.145 lazy-loads MCP tools (a `tool_search_call` precedes first use), and a "call it exactly" prompt makes it refuse before loading — a natural "use context7 to…" prompt is required to capture a real call.

## Design

### Two new `SourceDefinition` flags

The reference subsystem has neither a "tracking-only" notion nor a "non-JSON result" notion today. We add two optional flags, both defaulting to absent/false, both leaving every existing source byte-for-byte unchanged. `validateDefinition` accepts unknown extra fields (no exhaustiveness check), so neither flag needs validator changes.

**1. `trackOnly?: boolean`** — with registry helper `isTrackOnlySource(source: string): boolean`. A track-only reference behaves **identically** to any other reference (discovered, upserted to `plans.json.references`, archived into `CommitSummary.references`, shown in the detail-page Context section, PR description, Push-to-Space, and decision timeline) — with a **single** exception: it is excluded from the two functions that build the `{{references}}` block fed to the LLM.

**2. `argumentsDerived?: boolean`** — marks a source whose reference is built entirely from the tool-call *arguments*, so a non-JSON (prose) result is expected, not a parse failure. Both parsers, in their parse-fail branch, pass an **empty payload** (`{}`) to the normalizer instead of dropping the call — but only when `def.argumentsDerived === true`. Existing sources have the flag absent and continue to drop on parse failure exactly as before.

Both flags are read directly off the resolved `SourceDefinition` (`pendingEntry.def` in Claude; `def` in Codex), so no change to the `CodexNormalizer` interface is required.

### Data model (one Reference per library ID)

Dedup key `context7:<libraryId>`, so a library queried N times is one row whose `referencedAt` reflects the latest use.

| field | value | source |
|-------|-------|--------|
| `source` | `context7` | — |
| `nativeId` | `/vercel/next.js` | arg `libraryId`, guarded `^/[^/\s]+/[^/\s]+` |
| `title` | `vercel/next.js` | derived from `libraryId` (leading `/` stripped) |
| `url` | `https://context7.com/vercel/next.js` | constructed `https://context7.com` + `libraryId` (optional) |
| `description` | the `query` topic | arg `query` |
| `referencedAt` | tool-call timestamp | envelope |

No doc body stored; small `render` budget. `storage.nativeIdPathSafe: false` (nativeId contains `/`).

### Matching (query-docs only)

Only the current `query-docs` tool is matched. Legacy `get-library-docs` is out of scope — it uses a different argument name (`context7CompatibleLibraryID`) and we have no real fixture for it.

- Claude: `match.claude = { prefixes: ["mcp__context7__"], acceptSuffix: "query-docs" }`. `acceptSuffix` is a single string; `mcp__context7__query-docs` ends with it, while `resolve-library-id` and `get-library-docs` do not — so the resolver and the legacy tool are excluded without needing `denySuffixes`.
- Codex: `match.codex = { namespaceSuffix: "context7", functionCallNames: ["_query_docs"], invocationTools: ["query-docs", "context7.query-docs"] }`. `functionCallNames` serves the connector PRIMARY path; `invocationTools` serves both the local-MCP FALLBACK (`query-docs`) and the connector FALLBACK (`context7.query-docs`). `resolve-library-id` matches none of these and is ignored.

### Input-dependent normalizer

context7's reference data is in the arguments, so a normalizer reshapes `toolInput` (`{ libraryId, query }`) into the object the DSL reads, ignoring the (prose) result. It returns `null` (voiding the reference) only when `libraryId` is absent or malformed. There is **no** isError guard: an errored fetch still means that library was consulted, which is what tracking records. Registered per host:

- Claude: `CONTEXT_NORMALIZERS.context7` → new `sources/Context7Normalize.ts`.
- Codex: `CODEX_NORMALIZERS` entry → new `bindings/codex/CodexContext7Binding.ts`.

Because the result is prose, the normalizer is reached only after the parsers' `argumentsDerived` branch supplies an empty payload (see below); the normalizer never inspects that payload.

### The track-only seam (where generation is blocked)

References reach the LLM through exactly two block builders. Both must skip track-only sources; nothing else changes.

| Path | Function / location | track-only handling |
|------|--------------------|--------------------|
| Live summarizer | `assembleReferenceBlocks` (input assembled at `QueueWorker.ts:1762`/`1813`, amend twin `:2878`) | filter out track-only sources |
| Regeneration | `rebuildReferenceBlocks` (`Regenerator.ts:112`/`137`, reads `summary.references` at `:209`) | filter out track-only sources |

The archive path (`consumeWorkspaceContext` → `associateReferencesWithCommit`, `QueueWorker.ts:1607-1615`) is **not** filtered, so context7 lands in `CommitSummary.references` and surfaces everywhere references are listed.

Regeneration must be filtered explicitly: because context7 *is* present in `summary.references`, `rebuildReferenceBlocks` would otherwise re-feed it into the regen prompt.

### The argumentsDerived seam (prose-result survival)

Because context7's result is markdown, both parsers must not drop it on JSON-parse failure. Each gets one guarded branch, gated on `def.argumentsDerived === true`:

| Parser | Location | Change |
|--------|----------|--------|
| Claude | `ClaudeEnvelopeParser.ts` ~`:346-363` (the `JSON.parse` catch, after `recoverOffloadedPayload` returns `undefined`) | if `pendingEntry.def.argumentsDerived`, set `parsedPayload = {}` and proceed to the normalizer instead of dropping |
| Codex | `CodexEnvelopeParser.ts` ~`:283-284` (fallback `business = tryParse(ev.text)`) | if `business === null`: `continue` unless `def.argumentsDerived`, in which case set `business = {}` and proceed |

Existing sources have `argumentsDerived` absent, so both branches are inert for them — no behavior change, verified by the untouched JSON-source fixtures.

## Change set (ripple)

1. `cli/src/core/references/SourceDefinition.ts` — add optional `trackOnly?: boolean` and `argumentsDerived?: boolean`.
2. `cli/src/core/references/SourceDefinitionRegistry.ts` — add `isTrackOnlySource` helper.
3. `cli/src/core/references/ClaudeEnvelopeParser.ts` — `argumentsDerived` parse-fail branch; register `context7` in `CONTEXT_NORMALIZERS`.
4. `cli/src/core/references/CodexEnvelopeParser.ts` — `argumentsDerived` fallback branch.
5. **new** `cli/src/core/references/sources/definitions/context7.ts` (+ `.test.ts`) — the definition; add to `BUILTIN_DEFINITIONS` in `definitions/index.ts`.
6. **new** `cli/src/core/references/sources/Context7Normalize.ts` (+ `.test.ts`).
7. **new** `cli/src/core/references/bindings/codex/CodexContext7Binding.ts` — register in `CODEX_NORMALIZERS` (`bindings/codex/index.ts`).
8. `cli/src/Types.ts` — add `"context7"` to `KnownSourceId`.
9. `vscode/src/views/SourceLabels.ts` — add a `SOURCE_META` entry (label "Context7", icon `book`).
10. LLM filter — `assembleReferenceBlocks` (`QueueWorker.ts`) and `rebuildReferenceBlocks` (`Regenerator.ts`) skip `isTrackOnlySource` inside their `getRegistry().all()` loop.
11. Tests — update the hardcoded stable-order id list in `SourceDefinitionRegistry.test.ts`; add real captured envelopes as inline fixtures in `ClaudeEnvelopeParser.test.ts` and `CodexEnvelopeParser.test.ts`; add a regression test asserting a track-only reference **is** present in `CommitSummary.references` (and PR/push output) but **absent** from the assembled/rebuilt reference blocks.

`CLAUDE_TOOL_PREFIXES` is auto-derived from the registry, so no manual edit there.

## Testing strategy

- Parser fixtures come from the pinned real envelopes (Claude raw payload + established wrapping; real Codex local-MCP rollout + catalog-confirmed connector names), API key scrubbed.
- `argumentsDerived`: a prose (non-JSON) result still yields a reference on both hosts; an existing JSON source is unaffected (regression fixture).
- Guard behavior: a malformed/absent `libraryId` produces no reference.
- Dedup: two `query-docs` calls to the same `libraryId` produce one reference with the later `referencedAt` and latest `query` as description.
- Track-only invariant (the load-bearing test): a committed context7 reference appears in `summary.references` / PR / push output but never in the LLM reference block from either builder.
- Coverage stays at or above the CLI floor (97/96/97/97).

## Resolved during planning

- `MatchClaude.acceptSuffix` is a single string; `acceptSuffix: "query-docs"` alone excludes `resolve-library-id` and legacy `get-library-docs` (query-docs scope).
- The Codex parser strips only the `mcp__codex_apps__` prefix, so the local `mcp__context7` shape matches via the FALLBACK `invocationTools` path, not PRIMARY. `match.codex` covers both shapes.
- `url` kept: `https://context7.com/<libraryId>` verified to resolve.
- Both parsers assume JSON results → the `argumentsDerived` flag + guarded parse-fail branch is required (not optional) for context7 on either host.
