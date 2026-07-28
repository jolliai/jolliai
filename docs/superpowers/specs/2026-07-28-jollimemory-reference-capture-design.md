# Jolli Memory self-reference capture (track-only) — design

**Date:** 2026-07-28
**Status:** draft — Codex path blocked on live capture (see Ground truth)
**Scope:** Add `jollimemory` as a new *reference source* in the reference-extraction subsystem, recording that the agent consulted past memory while working on a commit. Track-only and arguments-derived: the call and its query are recorded; the memories that came back are not. The referenced system is Jolli itself.

## Goal

Jolli's MCP server exposes memory-read tools (`recall`, `search`, `get_decision_timeline`). When an agent calls one and then commits, nothing today links the new commit back to the memory that informed it. We want to record **that memory was consulted, and what was asked**, associated with the next commit — so a reader can later see "while working on this commit, memory was searched for `queue worker lock`."

The reference surfaces in the VS Code References panel and in the Jolli Space push payload. It must never influence generated memory content.

## Non-goals (YAGNI)

- **Which memories came back.** Scope is call + arguments only. Resolving returned commit hashes / topic slugs into a provenance chain ("commit X was informed by memories A, B, C") is a strictly larger feature and is deliberately deferred. This is the main thing the design does *not* deliver, and it is a conscious trade: it needs the tool *result*, which this design never reads.
- **`list_branches`.** It takes no arguments (`McpServer.ts:130-133`), so its reference would carry a tool name and nothing else.
- **The seven non-memory Jolli tools** (`get_pr_description`, `queue_status`, `status`, `bind_space`, `list_spaces`, `push_memory`) and all plugin-contributed platform tools. These are not memory lookups.
- **Server-side instrumentation.** `McpServer.ts:333` sees every tool call with its result and would work for every MCP host, not just the two with transcript parsers. It was considered and rejected for v1 (see Alternatives).
- **IntelliJ surfacing.** `intellij/.../ReferenceTypes.kt:11` is a closed `SourceId` enum already missing six sources; it is not in lockstep and is out of scope.
- **Registering anything.** Jolli's MCP server is already registered in ten hosts; we only observe its calls in transcripts.

## Ground truth

Split honestly between what was read from the code today and what has **not** been captured. This repo's rule is that envelope shapes come from real runs, not inference — the Context7 work established it and the Codex/Rovo work re-learned it the hard way.

### Verified (read from source, 2026-07-28)

**Tool argument schemas** — `cli/src/mcp/McpServer.ts:95-133`:

| Tool | Args | Required |
|------|------|----------|
| `search` | `{ query, branch?, type?, limit? }` | `query` |
| `recall` | `{ branch? }` | — |
| `get_decision_timeline` | `{ slug }` | `slug` |
| `list_branches` | `{}` | — (out of scope) |

Two consequences fall out of this table:

- **`get_decision_timeline` keys on a topic slug, not a branch.** Its reference content is a slug, not a branch name.
- **A bare `recall()` and `list_branches()` are byte-identical on the wire (`{}`).** No amount of argument inspection can separate them. This is what forces tool-name threading (below) rather than duck-typing.

**Prefix collision is real.** `SourceDefinitionRegistry.match` is a pure `toolName.startsWith(prefix)` with no exact-match concept (`SourceDefinitionRegistry.ts:195`). `mcp__jollimemory__search` is a `startsWith` prefix of the plugin-contributed `mcp__jollimemory__search_remote_articles` and `mcp__jollimemory__search_remote_repo`. A naive prefix match silently captures Space/repo searches as memory recalls.

**Every shipped source has a URL.** `extractRef` voids the whole reference when a required `url` field-spec yields nothing (`SourceEngine.ts:199-204`), and no built-in marks `url` optional — including Context7, which synthesizes `https://context7.com{libraryId}` (`context7.ts:37-46`). The `Reference.url?` optionality in the type is a forward-compat allowance that nothing exercises (`Types.ts:840`).

**But the persistence layer already tolerates a missing URL.** `parseMarkdown` omits the `url:` line when absent and explicitly excludes `url` from its required-field guard (`ReferenceStore.ts:362-368`). The round-trip seam for a link-less reference exists; only `extractRef` and the UI are strict.

**The Space push surface needs no work.** References travel two ways: as standalone `docType:"reference"` articles whose body is markdown (`SummaryMarkdownBuilder.ts:268-293`), and as full `ReferenceCommitRef` objects inside the `summaryJson` sidecar (`Types.ts:880-896`). `source` is a plain string end-to-end — `SourceId = string` (`Types.ts:789`), and the backend validates with `.passthrough()` (`JolliMemoryAggregateValidator.ts:144-149`). No client or server enum gates a new id.

**Only two hosts can see MCP tool calls.** `getEnvelopeParser` has exactly two real implementations, Claude and Codex; every other `TranscriptSource` falls through to the Claude parser and produces nothing (`TranscriptEnvelopeParser.ts:110-117`). Each non-Claude/Codex reader drops tool calls at the source: Cursor, Cursor CLI, OpenCode, Copilot CLI, Devin, Cline, Cline CLI and Gemini all extract text parts only; Antigravity folds tool calls into a prose summary line that is not wired into reference extraction at all.

There is an irony worth stating plainly: the sibling `feature/mcp-tools` branch just added MCP registration for Cline, Devin and Antigravity, so those hosts *can now call* Jolli's memory tools — and this feature cannot observe a single one of those calls.

**Claude's context-normalizer signature has no tool name.** `CONTEXT_NORMALIZERS` entries are `(payload, toolInput, env) => object | null` (`ClaudeEnvelopeParser.ts:317-319`). `toolInput` is retained only for sources registered in that map (`:240-245`).

**`writeReferenceMarkdown` already reads the existing file** for its byte-equality idempotence check (`ReferenceStore.ts:111-126`). The accumulation merge slots into a read that already happens.

**The track-only seam already exists.** Context7 added the `def.trackOnly === true` guard to both `assembleReferenceBlocks` (`QueueWorker.ts:1549`) and `rebuildReferenceBlocks` (`Regenerator.ts`), plus the ranker split/splice. Setting the flag costs nothing new.

### NOT captured — blocks the Codex path

**The Codex envelope for `mcp__jollimemory__*` has not been observed.** Jolli registers itself in Codex as a *local* MCP server in `~/.codex/config.toml` (per `AGENTS.md`), which puts it in the same category as local Context7: `resolveCodexDef` requires an `mcp__codex_apps__` namespace prefix (`CodexEnvelopeParser.ts:389-396`), so the PRIMARY path rejects a local server, and only the `mcp_tool_call_end` FALLBACK survives — matched on `invocation.tool`.

The concrete unknown is **what string lands in `invocation.tool`**. Context7's local shape was `"query-docs"`; Rovo's was `"atlassian_rovo.getJiraIssue"` (dotted). Both were captured, and in the Rovo case the inferred name was wrong. Guessing `"recall"` vs `"jollimemory.recall"` here would repeat a mistake this repo has already paid for twice.

Also unverified: whether the Codex pre-filter's four hard-coded needles let a local-server `mcp_tool_call_end` line through for this server. Context7 says yes for local MCP; it should be confirmed, not assumed.

**Required before implementing the Codex path:** drive a real `codex` session that calls `mcp__jollimemory__recall`, and pin the `function_call` namespace/name and the `mcp_tool_call_end` `invocation.tool` from the rollout file as a fixture. Use a natural prompt ("use jolli memory to recall…") — Codex lazy-loads MCP tools and a "call it exactly" prompt makes it refuse before loading.

## Current State

The reference pipeline observes an agent's MCP tool calls and turns them into per-commit evidence:

1. **Match** — the tool name resolves to a `SourceDefinition` via the registry's declarative `match` rules.
2. **Normalize** — the paired result is JSON-parsed; a source registered in `CONTEXT_NORMALIZERS` may instead reshape from the call's *arguments*.
3. **Extract** — `SourceEngine.extractRef` runs the definition's field pipes to build a `Reference` with `mapKey = <source>:<nativeId>`.
4. **Persist** — one markdown file at `.jolli/jollimemory/references/<source>/<key>.md` plus a registry row in `plans.json.references`, keyed by `mapKey`, last-write-wins.
5. **Archive on commit** — active rows are snapshotted into `CommitSummary.references`, written to the orphan branch, then the local row and file are deleted. References have no archive/guard row; the orphan snapshot is the system of record.
6. **Surface** — VS Code References panel (live rows), commit detail, PR description, Jolli Space push.

Eleven sources ship today. All of them describe an **external** system.

### Three assumptions that break for a self-referential source

**A reference is a bookmark to somewhere else.** Spec 256 states the principle outright: *"a reference the user can never click through to is considered to carry nothing worth keeping"* — Slack voids a thread whose permalink can't be resolved. Jolli has no external page. This design deliberately breaks that precedent, and it should be recorded as a break rather than glossed over. The justification: Slack's link-less case is a *failure* (the data exists somewhere, we just couldn't find the link); Jolli's is *definitional* (there is no elsewhere — the referenced thing is this repo's own memory, and the reference's own markdown file is the destination).

**A source maps to one entity type with one identity.** Linear has ticket ids; Notion has page ids. Jolli's three tools take three unrelated argument shapes and there is no entity — only an act of consultation.

**One reference is one entity, overwritten on repeat.** Dedupe is last-write-wins on `mapKey` (`ReferenceExtractor.ts:158-171`, `SessionTracker.upsertReferenceEntry`). Re-querying Linear ticket ENG-1 twice should collapse to one row; that is correct for an entity. Three *different* searches are three different facts, and collapsing them to the last one loses the record. Nothing in the pipeline accumulates.

## Proposed Design

### Source identity

| | |
|---|---|
| `id` | `jollimemory` — matches the MCP server name (`McpServer.ts:308`) and the `mcp__jollimemory__` tool namespace |
| `label` | `Jolli Memory` |
| `icon` | codicon `history` (`book` is taken by Confluence/Context7) |
| badge | letter `J`, color `#9B5CFF` — the primary from `vscode/assets/icon.svg` |
| `trackOnly` | `true` |
| `argumentsDerived` | `true` |
| `storage.nativeIdPathSafe` | `true` — nativeId is a bare tool name, no `/`, `\` or `..` |

### Three new DSL affordances

Like Context7's two flags, each is optional, defaults to absent, and leaves every existing source byte-for-byte unchanged. Each exists because this source is the first to need it.

**1. `MatchClaude.exact?: ReadonlyArray<string>`** — after the prefix match, require the tool name to equal one of these exactly.

`prefixes` must stay `["mcp__jollimemory__"]` regardless, because `CLAUDE_TOOL_PREFIXES` derives the transcript line pre-filter needles from it (`bindings/claude/index.ts:32-38`) — narrowing the prefixes to full tool names would still work for matching but is redundant, and the prefix is the honest pre-filter. `exact` then narrows:

```ts
claude: {
    prefixes: ["mcp__jollimemory__"],
    exact: [
        "mcp__jollimemory__recall",
        "mcp__jollimemory__search",
        "mcp__jollimemory__get_decision_timeline",
    ],
},
```

This is immune to new sibling tools. The alternative — `denySuffixes` — requires enumerating every other tool under the namespace and silently breaks the day a plugin adds another `search_*` (see Alternatives).

**2. `SourceDefinition.reference.url?: FieldSpec`** — make the field-spec itself optional in the interface, and have `extractRef` treat an absent spec as "no url" instead of evaluating one:

```ts
const urlR = def.reference.url !== undefined
    ? evalField(def.reference.url, payload)
    : { ok: true, value: undefined };
```

This is the honest expression of "this source has no URL." The type (`Reference.url?`) and the markdown round-trip already support it; only `extractRef` is strict. Rendering already degrades gracefully — `renderOne` omits the `<url>` line when absent (`SourceEngine.ts:241`).

**3. `SourceDefinition.accumulateBody?: boolean`** — the reference body accumulates across repeated calls to the same `mapKey` instead of being overwritten. See Accumulation below.

### Tool set and matching

Three tools, each carrying real content:

| Tool | Argument read | Becomes |
|------|---------------|---------|
| `recall` | `branch` (absent ⇒ current branch) | `recall` reference, query = branch name or `(current branch)` |
| `search` | `query` (required) | `search` reference, query = the search string |
| `get_decision_timeline` | `slug` (required) | `get_decision_timeline` reference, query = the topic slug |

Codex matching, **pending live capture**: `match.codex = { namespaceSuffix: "jollimemory", functionCallNames: [...], invocationTools: [...] }`. The connector PRIMARY path is unreachable for a local server; `invocationTools` is the live path and its exact contents come from the fixture, not from this document.

### Arguments-derived normalizer, and threading the tool name

`argumentsDerived: true` is load-bearing for two independent reasons:

- **Codex reach.** For a local MCP server only the self-sufficient `mcp_tool_call_end` fallback line survives pre-filtering, and it carries the invocation's own arguments. An arguments-derived source is the only kind that can be captured that way.
- **`recall` results are enormous.** A single `recall()` on this repo returned 72,378 characters during the research for this document — large enough to be offloaded. Never touching the result sidesteps parsing, offload recovery, and storage of a payload we have no intention of keeping.

Because a bare `recall()` and `list_branches()` are both `{}`, the normalizer must know which tool fired. **Add `toolName` to `ContextNormalizeEnv`** rather than adding a fourth positional parameter — the env object already threads through both hosts, and no existing normalizer breaks by ignoring a new field.

- Claude: populate from `pendingEntry.toolName` at the `CONTEXT_NORMALIZERS` call site (`ClaudeEnvelopeParser.ts:437-441`).
- Codex: populate from the resolved raw tool name at both `normalize` call sites (`CodexEnvelopeParser.ts:246`, `:324`).

New `cli/src/core/references/sources/JolliMemoryNormalize.ts`:

```
normalizeJolliMemory(toolInput, toolName) -> { tool, query } | null
  mcp__jollimemory__recall                -> { tool: "recall",                query: branch ?? "(current branch)" }
  mcp__jollimemory__search                -> { tool: "search",                query: <query> }   // null if absent
  mcp__jollimemory__get_decision_timeline -> { tool: "get_decision_timeline", query: <slug> }    // null if absent
  anything else                           -> null
```

No `isError` guard: a failed recall still means memory was consulted, which is what tracking records. This mirrors Context7's reasoning.

### Data model — one reference per tool, queries accumulated

`mapKey = jollimemory:<tool>`, so at most three rows exist at any time, bounded regardless of how many calls a session makes.

| field | value | notes |
|-------|-------|-------|
| `source` | `jollimemory` | |
| `nativeId` | `recall` \| `search` \| `get_decision_timeline` | bare tool name; path-safe |
| `title` | `Recall` \| `Search` \| `Decision timeline` | fixed human label per tool |
| `url` | *absent* | no field-spec declared |
| `description` | accumulated query list | see below |
| `fields` | `calls` = total call count | bag field; key matches `^[\w-]+$` |
| `referencedAt` | latest call timestamp | |
| `sourceToolName` | full MCP tool name, verbatim | |

On disk: `.jolli/jollimemory/references/jollimemory/search.md`.

The accumulated body is a newest-first markdown list, deduped on the query string (a repeat keeps the newer timestamp), **capped at 20 entries** with the oldest dropped:

```markdown
- `queue worker lock` — 2026-07-28T09:14:02Z
- `folder storage dual write` — 2026-07-28T08:51:40Z
```

The accumulation window is exactly the gap between commits, because the local row and file are deleted at archive time. That maps precisely onto "which memory was used for *this* commit."

### Accumulation — two seams

One seam is not enough; each covers a different collapse point.

| Seam | Location | Change |
|------|----------|--------|
| Within one transcript scan | `dedupeKeepLatest`, `ReferenceExtractor.ts:158-171` | for `accumulateBody` defs, merge descriptions instead of replacing the entry; still take the latest `referencedAt` |
| Across incremental scans | `writeReferenceMarkdown`, `ReferenceStore.ts:111-132` | for `accumulateBody` defs, parse the already-read `existing` content and merge its body before rendering |

Seam 2 alone fails because seam 1 drops the duplicates before they ever reach the store. Seam 1 alone fails because the Stop hook re-scans incrementally and each scan would overwrite the previous file.

Seam 2 is cheap: `writeReferenceMarkdown` already reads the existing file for its idempotence check. Merge via `readReferenceMarkdownFromString` (which strips the `<!-- jolli:auto-note -->` sentinel) so the note is not accumulated into the body, then re-render.

`dedupeKeepLatest` is **not** inside a `v8 ignore` block, so new branching there needs test coverage.

### The URL-less seam

`extractRef` is handled by affordance 2. Three UI call sites currently offer "open in browser" unconditionally and would each produce the warning toast *"jollimemory reference … has a non-http(s) URL — refusing to open"* — a message written for a hand-tampered-URL defense, not for an intentionally link-less source:

| Surface | Location |
|---------|----------|
| Sidebar context menu | `SidebarScriptBuilder.ts:5994` |
| Hover card action | `SidebarScriptBuilder.ts:3007` |
| Summary panel 🌍 button | `SummaryHtmlBuilder.ts:1338` |

Each should omit the affordance at build time when the reference has no URL — a conditional render, not a runtime toggle, so the webview CSP's inline-style/JS ban is not in play. `openReferenceInBrowser`'s scheme guard (`ReferenceService.ts:148-161`) stays exactly as is; it remains the correct defense for a tampered URL.

Plain row click already previews the reference's own markdown, which for this source is the right and only destination.

### The auto-note copy

`referenceNote()` renders *"Only the query and the `<label>` link are recorded here"* for arguments-derived sources (`ReferenceStore.ts:236`). For a link-less source that sentence is factually wrong. It needs a variant selected on the absence of a URL — e.g. *"Only the query is recorded here — Jolli Memory's full response is intentionally not saved."*

This matters more than it looks: the note exists precisely because sparse Context7 references made users think the system was broken.

### Track-only, and the Space push

`trackOnly: true` reuses the seams Context7 already built — the skip in `assembleReferenceBlocks` and `rebuildReferenceBlocks`, and the ranker split/splice. **No code change.** The reference is still archived into `CommitSummary.references` and still surfaces everywhere references are listed; it simply never enters the `{{references}}` block.

This is the right default here for a reason beyond Context7's: without it, memory about memory-usage feeds the generator that produces the next memory. That is a feedback loop, not a feature.

**The Space push requires no change at all.** The reference flows as a `docType:"reference"` article titled `"Jolli Memory · Search"` (`buildReferencePushTitle`) with the accumulated query list as its body, and as a `ReferenceCommitRef` inside `summaryJson`. `source` is an unvalidated passthrough string on both ends.

### Host reach

Claude Code and Codex only. Every other transcript reader discards tool calls before extraction could see them. This should be stated in user-facing docs rather than discovered — the feature will simply appear not to work for a Cursor or Copilot user.

## Alternatives Considered

**Server-side ledger instead of transcript parsing.** Instrument `McpServer.ts:333`, which already sees every tool call with args *and result*, and append to a per-project ledger. Strictly more capable: host-agnostic (works for all ten registered MCP hosts, not two), and it can capture which memories came back — the provenance version this design defers. Rejected for v1 because it is a new channel with its own storage, lifecycle, archival and surfacing, duplicating a pipeline that already delivers panel + Space + commit attachment for free. It remains the right home if provenance is ever wanted, and the two are not mutually exclusive — a ledger could feed the same reference storage later.

**`denySuffixes` instead of a new `exact` matcher.** Zero DSL change, but requires listing every other tool under `mcp__jollimemory__` and silently starts miscapturing the day a plugin registers another `search_*` platform tool. Given plugin-contributed tools are registered dynamically at runtime, a static denylist is guaranteed to drift. `exact` is a few lines and cannot drift.

**One reference per distinct query** (`nativeId = <tool>-<sha8(args)>`). Preserves each query as its own row with no new accumulation code. Rejected: twelve searches become twelve panel rows and twelve Space articles — exactly the flooding the Linear enumeration exclusion was written to stop (`linear.ts:28-32`). Note that flooding here would come from *repeat calls*, not from walking a result array, so `denySuffixes` would not have helped.

**One reference per tool, latest query wins.** Bounded and needs no new code at all — the existing last-wins dedupe just works. Rejected because it discards the query history, and the query history is the substance of "what memory was consulted."

**Synthesizing an https URL** so every existing affordance keeps working untouched. Rejected: any URL we could construct is either fabricated or conditional on a Space binding, and a dead link is worse than an honest absence. Context7's synthesized URL was verified to resolve before it shipped; nothing comparable exists here.

## Migration / Rollout

No migration — this is additive, and references have no historical records to convert.

1. **DSL affordances, no behavior change.** `MatchClaude.exact`, optional `reference.url`, `accumulateBody` flag; registry match honors `exact`; `extractRef` skips an absent url spec. Every existing source unaffected; existing fixtures are the regression test.
2. **Accumulation seams.** `dedupeKeepLatest` merge, `writeReferenceMarkdown` read-merge-write. Inert for every source without the flag.
3. **`toolName` in `ContextNormalizeEnv`,** populated at all three call sites (one Claude, two Codex). No existing normalizer reads it.
4. **Claude path.** The definition, `JolliMemoryNormalize.ts`, the `CONTEXT_NORMALIZERS` entry, registration in `BUILTIN_DEFINITIONS`. Shippable on its own — Claude Code is the majority host.
5. **VS Code.** `KnownSourceId` + `SOURCE_META` row (the `Record<KnownSourceId, …>` type makes this a forced compile error), the three affordance gates, and the link-less auto-note variant. `REFERENCE_SOURCE_IDS` derives from `SOURCE_META` keys automatically — without the row, clicking a `jollimemory` row inside a committed memory's evidence group silently no-ops.
6. **Codex path — gated on the live capture.** Do not write `match.codex` from inference.
7. **Docs and specs.**

Steps 1–5 deliver the feature for Claude Code users. Step 6 is independently shippable once the fixture exists.

## Risks & Open Questions

**The Codex tool name is unverified.** Called out twice deliberately. Ship step 6 only from a captured fixture.

**Self-referential noise.** Every `jollimemory` reference becomes a Jolli Space article ("Jolli Memory · Search") that is itself searchable by `search_remote_articles`, and lands in `CommitSummary.references` which feeds the local Orama index. Memory about consulting memory becomes memory that can be consulted. `trackOnly` blocks the generation feedback loop but not index pollution. The one-per-tool cap bounds the volume to three articles per commit; whether that is acceptable noise is worth watching after the first few weeks of dogfooding. If it is not, the cheapest lever is excluding `trackOnly` sources from the search index.

**Spec 256's precedent is being broken deliberately.** A link-less reference contradicts *"a reference the user can never click through to is considered to carry nothing worth keeping."* The justification is in Current State; spec 256 should be amended to distinguish a *failed* link resolution (void it) from a source with *no* external destination (keep it, suppress the affordance) rather than left silently contradicted.

**`CommitSummary.references` has no formal spec.** Spec 04 documents `PlanReference` and `NoteReference` record shapes but not the archived-reference shape, which must be reverse-engineered from spec 231. Pre-existing gap, not caused by this work, but an implementer will trip over it.

**Accumulation cap is a guess.** 20 entries is chosen for readability, not measured. A heavy research session could exceed it and silently drop the oldest queries. Acceptable — the newest are the most likely to relate to the commit — but the drop should be visible in the body rather than silent.

**Open: should a bare `recall()` resolve the branch name?** The design records `(current branch)` because the normalizer has no branch in scope. Resolving it at capture time would give a more useful record, and `ContextNormalizeEnv` is already being extended — but the branch at extraction time is not necessarily the branch at call time.

**Open: is `jollimemory` the right source id, or `jolli`?** `jollimemory` matches the MCP server name and namespace exactly, which argues for it. `jolli` reads better in the Space article title. The id is user-visible in the on-disk path and the panel, and changing it later means migrating reference files.

## Change set (ripple)

Derived from the real git history of the two most recent source additions — `monday` (`c47bd450`) and `context7` (`df990af0`).

1. `cli/src/core/references/SourceDefinition.ts` — add `MatchClaude.exact?`, make `reference.url?` optional, add `accumulateBody?`.
2. `cli/src/core/references/SourceDefinitionRegistry.ts` — honor `exact` in `match()`.
3. `cli/src/core/references/SourceEngine.ts` — `extractRef` skips an absent url field-spec.
4. `cli/src/core/references/ReferenceExtractor.ts` — accumulating merge in `dedupeKeepLatest`.
5. `cli/src/core/references/ReferenceStore.ts` — accumulating read-merge-write in `writeReferenceMarkdown`; link-less variant of `referenceNote()`.
6. `cli/src/core/references/ClaudeEnvelopeParser.ts` — `toolName` in `ContextNormalizeEnv`; register `jollimemory` in `CONTEXT_NORMALIZERS`.
7. `cli/src/core/references/CodexEnvelopeParser.ts` — `toolName` in env at both normalize call sites. *(Codex matching itself: step 6 of rollout.)*
8. **new** `cli/src/core/references/sources/JolliMemoryNormalize.ts` (+ `.test.ts`).
9. **new** `cli/src/core/references/sources/definitions/jollimemory.ts` (+ `.test.ts`); register in `BUILTIN_DEFINITIONS` (`definitions/index.ts`).
10. **new** `cli/src/core/references/bindings/codex/CodexJolliMemoryBinding.ts` — register in `CODEX_NORMALIZERS`. *(Rollout step 6.)*
11. `cli/src/Types.ts` — add `"jollimemory"` to `KnownSourceId`. Excluded from coverage, but forces item 12.
12. `vscode/src/views/SourceLabels.ts` — `SOURCE_META` row. Compile error until done.
13. `vscode/src/views/SidebarScriptBuilder.ts` (`:3007`, `:5994`) and `vscode/src/views/SummaryHtmlBuilder.ts` (`:1338`) — gate the open-in-browser affordance on a non-empty url.
14. **Tests that break and must be hand-edited:** the stable-order id list in `SourceDefinitionRegistry.test.ts:46` (append `"jollimemory"`, rename the `it()` title) and the exact-array assertion in `bindings/claude/index.test.ts:15` (append `"mcp__jollimemory__"`).
15. Docs: `specs/153-transcript-reference-extraction.md` (two source enumerations), `specs/154-external-reference-source-adapters.md` (id list, per-source subsection, budgets table, Codex-reachability tally), `specs/256` (the link-less amendment above), `cli/README.md:22,85`, `vscode/README.md:110`.

`CLAUDE_TOOL_PREFIXES` is derived from the registry — no production edit, only its pinned test (item 14). No change to `JolliMemoryPushClient.ts`, `JolliMemoryPushOrchestrator.ts`, `McpTools.ts`, `McpServer.ts`, or the backend. No `intellij/` change.

## Testing strategy

- **Claude fixtures from a real transcript** — capture an actual session calling all three tools; do not hand-author the envelope.
- **Codex fixtures gate the Codex path entirely** (Ground truth).
- **Tool disambiguation:** a bare `recall()` and a `list_branches()` both present `{}`; assert the first yields a `recall` reference and the second yields nothing. This is the test that proves the `toolName` threading works.
- **Exact matching:** `mcp__jollimemory__search_remote_articles` and `mcp__jollimemory__search_remote_repo` produce no reference, while `mcp__jollimemory__search` does.
- **URL-less round-trip:** a reference with no url renders markdown without a `url:` line, parses back to `url === undefined`, and survives archive to the orphan branch.
- **Accumulation, both seams:** three `search` calls in one scan yield one reference with three body entries; a second incremental scan adds a fourth without losing the first three; a repeated identical query updates its timestamp without duplicating; the 20-entry cap drops oldest-first.
- **Track-only invariant** (load-bearing): a committed `jollimemory` reference appears in `summary.references`, the PR body and the push payload, but never in the reference block from either builder.
- **Existing sources unaffected:** all three DSL affordances are absent on every current definition; the untouched JSON-source fixtures are the regression.
- **Run whole files, not `-t` slices,** for `SourceDefinitionRegistry.test.ts`, `bindings/claude/index.test.ts`, `ClaudeEnvelopeParser.test.ts` and `CodexEnvelopeParser.test.ts` — all depend on module-level registry state computed once at import.
- Coverage stays at or above the CLI floor (97/96/97/97). New branches in `SourceEngine`, `ReferenceExtractor` and `ReferenceStore` are all in covered files; `dedupeKeepLatest` is not inside a `v8 ignore` block.

## References

- `cli/src/mcp/McpServer.ts:95-133` — tool argument schemas; `:308` server name; `:333` the per-call dispatch point the rejected ledger alternative would use
- `cli/src/core/references/SourceDefinition.ts` — the DSL; `SourceDefinitionRegistry.ts:191-199` — matching; `SourceEngine.ts:181-227` — `extractRef`
- `cli/src/core/references/sources/definitions/context7.ts` — the track-only / arguments-derived precedent
- `cli/src/core/references/ClaudeEnvelopeParser.ts:317-344` — `CONTEXT_NORMALIZERS`; `CodexEnvelopeParser.ts:389-396` — `resolveCodexDef`
- `cli/src/core/references/ReferenceStore.ts:111-132`, `:236`, `:362-368`; `ReferenceExtractor.ts:158-171`
- `cli/src/Types.ts:789-803`, `:833-847`, `:880-896`
- `vscode/src/views/SourceLabels.ts:40-52`; `vscode/src/core/ReferenceService.ts:148-161`
- `specs/153`, `specs/154`, `specs/179`, `specs/180`, `specs/187`, `specs/231`, `specs/255`, `specs/256`
- `docs/superpowers/specs/2026-07-22-context7-tracking-design.md` — the structural model for this document
