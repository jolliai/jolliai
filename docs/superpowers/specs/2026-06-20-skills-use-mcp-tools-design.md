# Skills use MCP tools — design

**Date:** 2026-06-20 (revised same day)
**Branch:** `change-skill-use-mcp`
**Status:** Draft — pending user review

## Goal

Move the `jolli-recall` and `jolli-search` skill templates off the
shell-injection-defended CLI here-doc bridge and onto the structured
JolliMemory MCP tools (`mcp__jollimemory__recall`, `mcp__jollimemory__search`),
and register the MCP server for non-Claude hosts. MCP tool calls carry no shell
surface, so the per-invocation hex-delimiter here-doc recipe is eliminated on
the primary path; it remains as a fallback for hosts without the MCP server.

The defining principle of this design: **the MCP tool and the CLI fallback for a
skill must return byte-identical results.** This is guaranteed structurally by
extracting one shared implementation per skill that BOTH the CLI command and the
MCP tool call — not by keeping two parallel code paths in sync by hand.

## Confirmed decisions (current — supersedes earlier draft)

1. **recall — unify results.** `mcp__jollimemory__recall` must produce the same
   result as the CLI `recall --format json` the skill fallback calls today: the
   `type`-tagged discriminated union (`recall` / `catalog` / `error`) **including
   the catalog fuzzy-match fallback**. Achieved by extracting a shared
   `resolveRecall()` that both the CLI `recall` command and the MCP `runRecall`
   tool call. (User: "recall 兑底也抽出共享实现，MCP 和兑底都使用它.")
2. **search — use the current MCP BM25 search, lightweight.** `mcp__jollimemory__search`
   stays a single Orama BM25 query returning lightweight
   `{ hits: [{ id, type, title, snippet, branch, commitDate, slug, hash, score }] }`
   — **no full content, no two-phase, no `load_commits` tool.** The CLI fallback
   is changed to produce the **same** lightweight `{ hits }` via the **same**
   shared `searchHits()` implementation (BM25), so primary and fallback match.
   (User: "skill search 用当前 MCP search 实现… 兑底改成和 MCP search 同样的实现.")
3. **Host scope.** Register the MCP server for non-Claude hosts too
   (Codex / Cursor / Gemini, optionally Windsurf / OpenCode), gated on each
   host's existing detector.
4. **Fallback retained for both skills.** MCP-preferred with CLI here-doc
   fallback, so cross-platform hosts keep working before/without MCP registration.

### Reversals from the earlier draft (now void)

- ~~Add a `load_commits` MCP tool~~ — dropped (decision 2). Search is lightweight.
- ~~Extract `parseHashList` for `load_commits`~~ — dropped (no `--hashes` path).
- ~~Keep the rich two-phase SearchHit rendering~~ — dropped; lightweight render.

## Background facts (verified in code)

- **One byte-identical SKILL.md** is written to both `.claude/skills/<name>/`
  and `.agents/skills/<name>/` ([SkillInstaller.ts](../../../cli/src/install/SkillInstaller.ts)).
- **MCP is registered only in Claude's `.mcp.json`** today
  ([McpRegistration.ts](../../../cli/src/install/McpRegistration.ts),
  [Installer.ts:232](../../../cli/src/install/Installer.ts#L232)). VS Code reuses
  the bundled CLI Installer; **IntelliJ registers no MCP at all.**
- **CLI `recall --format json`** emits a discriminated union:
  `RecallPayload` (`type:"recall"`, [ContextCompiler.ts:135](../../../cli/src/core/ContextCompiler.ts#L135)),
  `BranchCatalog` (`type:"catalog"`, [ContextCompiler.ts:179](../../../cli/src/core/ContextCompiler.ts#L179), with optional `query`),
  or `{type:"error", message}`. The dispatch (resolve branch → load catalog →
  exact match → fuzzy fallback → empty/error) lives inline in
  [RecallCommand.ts:259-385](../../../cli/src/commands/RecallCommand.ts#L259).
- **MCP `runRecall`** ([McpTools.ts:43](../../../cli/src/mcp/McpTools.ts#L43))
  currently returns a bare `RecallPayload` only — no catalog fuzzy match, no
  error/empty envelope. **This is the gap decision 1 closes.**
- **MCP `runSearch`** ([McpTools.ts:24](../../../cli/src/mcp/McpTools.ts#L24)) is
  `SearchIndex.openCached(...).search(...)` (Orama BM25) → `{ hits }`.
- **CLI two-phase `search`** (`LocalSearchProvider.buildCatalog`/`loadHits`,
  [SearchCommand.ts](../../../cli/src/commands/SearchCommand.ts)) — **its only
  consumer is the current jolli-search skill.** Verified: no VS Code / core
  module calls `buildCatalog`/`loadHits` outside `SearchCommand` (and the
  `SearchProvider` interface + `RemoteSearchProvider` stub). So the CLI `search`
  command can be switched to BM25 single-phase without breaking other consumers.
- **Three independent "search" paths exist — do not conflate them.** (1) The VS
  Code / IntelliJ **Memory Bank timeline view** search is
  `JolliMemoryBridge.listSummaryEntries(count, offset, filter)` — an in-process
  case-insensitive substring filter over `commitMessage`/`branch`/`repoName`
  ([JolliMemoryBridge.ts:1485](../../../vscode/src/JolliMemoryBridge.ts#L1485)).
  It touches none of the search backends below. (2) CLI two-phase catalog
  (`SearchCommand`→`LocalSearchProvider`) — old skill only, being retired here.
  (3) BM25 `SearchIndex` — the MCP `search` tool. This work touches only (2) and
  (3); the timeline view (1) is unaffected.

## Component 1 — unify CLI ↔ MCP results

### 1a. Shared `resolveRecall`

Create `cli/src/core/RecallResolver.ts` exporting:

```ts
export type RecallResult = RecallPayload | BranchCatalog | { type: "error"; message: string };

/**
 * The single source of truth for "what does recall return for this input".
 * Mirrors the existing RecallCommand JSON dispatch exactly. Used by the CLI
 * `recall --format json` path AND the MCP `recall` tool, so both are identical.
 */
export async function resolveRecall(
	branchOrKeyword: string | undefined,
	projectDir: string,
	options?: { budget?: number; depth?: number; includeTranscripts?: boolean; includePlans?: boolean },
): Promise<RecallResult>;
```

Logic (lifted verbatim from RecallCommand's action):
1. Validate `branchOrKeyword` with `SAFE_ARGUMENT_PATTERN`; invalid → `{type:"error", …}`.
2. Resolve branch: explicit arg, else current git branch (`getCurrentBranch`).
3. Load `listBranchCatalog(projectDir)`.
4. If branch + exact catalog match → `compileTaskContext` → `commitCount===0`
   ? `{type:"error", message:"No Jolli Memory records found for branch …"}`
   : `buildRecallPayload(ctx, budget)`.
5. If branch + no exact match → `{...catalog, query: branch}` (`type:"catalog"`).
6. No branch + empty catalog → `{type:"error", message:"No … records in this repository."}`.
7. No branch + non-empty catalog → `catalog` (`type:"catalog"`).

Then:
- **RecallCommand** `--format json` path calls `resolveRecall` and
  `console.log(JSON.stringify(result))`. (The `--full`/`--output`/default text
  modes stay in the command — they are human-facing renders, not the JSON
  contract.) The catalog text fallback (`renderCatalogText`) for non-JSON modes
  stays in the command.
- **MCP `runRecall`** becomes `return resolveRecall(args.branch, cwd)`. The
  server still wraps a thrown error as `{error}`+`isError`, but `resolveRecall`
  returns `{type:"error"}` for the *expected* empty/no-match cases (matching the
  CLI), reserving throws for genuinely unexpected failures.

### 1b. Shared `searchHits` + CLI search → BM25

Create `cli/src/core/SearchHits.ts` exporting:

```ts
export interface SearchHitsArgs { query: string; branch?: string; type?: "topic" | "commit"; limit?: number; }
/** BM25 hits — the single implementation behind MCP `search` and CLI `search`. */
export async function searchHits(cwd: string, args: SearchHitsArgs, storage?: StorageProvider): Promise<SearchHitResult[]>;
```

Body = the current `runSearch` core (`SearchIndex.openCached(cwd, storage).search({query,branch,type,limit})`), including its non-empty-query guard and `limit` sanitization.

Then:
- **MCP `runSearch`** becomes `return { hits: await searchHits(cwd, args, getActiveStorage()) }`.
- **CLI `search` command** is rewritten to single-phase BM25: parse query
  (+ `--limit`, `--branch`, `--type`, `--arg-stdin`, `--format`, `--output`,
  `--cwd`), call `searchHits`, emit `{ hits }` JSON (or a compact text render).
  **Remove** the two-phase flags/logic (`--hashes`, `--since`, `--budget`,
  `buildCatalog`/`loadHits`, `parseHashList`, `HASH_LIST_PATTERN`,
  `renderResultText`). The skill's CLI fallback calls this and gets the same
  `{ hits }` as MCP.

### Intentionally unchanged (now unused by the skill, retained on purpose)

- `LocalSearchProvider` (`buildCatalog`/`loadHits`), the `SearchProvider`
  interface, `RemoteSearchProvider`, and the `SearchCatalog`/`SearchHit`/
  `SearchResult` types in `Search.ts`. They lose their only live consumer
  (the old `search` command) but are kept as the designed pluggable-provider
  extension point and remain independently tested. Removing them is a separate
  cleanup, out of scope here. (Listed explicitly so the omission is a decision.)

## Component 2 — multi-host MCP registration

Unchanged from the earlier draft. Generalize `McpRegistration` into a per-host
registrar list; each registrar idempotent, preserves other servers, reuses the
dist-path-indirected `run-cli mcp` entry from `mcpServerEntry`, gated on the
host's existing detector. **integrating-external-systems applies** — verify each
host's real config location/schema before writing its registrar; omit a host if
unverifiable (the skill CLI fallback covers it).

| Host | Location (hypothesis — verify) | Shape | Scope |
|------|-------------------------------|-------|-------|
| Claude (done) | `<wt>/.mcp.json` | `mcpServers` | project |
| Cursor | `<wt>/.cursor/mcp.json` | `mcpServers` | project |
| Gemini | `~/.gemini/settings.json` | `mcpServers` | global |
| Codex | `~/.codex/config.toml` | `[mcp_servers.jollimemory]` TOML | global |
| Windsurf / OpenCode | verify | verify | deferred behind verification |

- **No TOML lib available** (verified: `@iarna/toml`/`smol-toml` absent, none in
  any `package.json`; repo avoids new deps) → Codex uses a hand-written
  block-level TOML merge that only ever touches our own table.
- Cursor/Gemini/Windsurf share the `mcpServers` JSON shape → one shared JSON
  writer, multiple locations.
- Project-local config files get a `.git/info/exclude` entry; global configs
  don't. `jolli disable`/uninstall must remove every host's entry.
- **IntelliJ MCP registration: out of scope** (it registers no MCP today).

## Component 3 — rewrite skill templates

Both templates ([SkillInstaller.ts](../../../cli/src/install/SkillInstaller.ts))
become MCP-preferred with the existing `heredocInvocation` recipe reused verbatim
as the fallback (DRY — the security recipe is not duplicated).

### jolli-recall

Because MCP `recall` now returns the same `type`-tagged union as the CLI, the
MCP path and the fallback path share identical Step-2 handling. New Step 1:

- **Preferred:** if `mcp__jollimemory__recall` exists, call it with `{ branch }`
  (omit for current branch). It returns the discriminated union directly.
- **Fallback:** the existing `recall --format json` here-doc.
- **Step 2 (shared):** handle `type:"recall"` (render Part A fact opener + Part B
  synthesis — unchanged), `type:"catalog"` (semantic-match the user's input
  against `branches`/`commitMessages`/`topicTitles`; one match → re-call recall
  with that branch; many → ask; none → show catalog), `type:"error"` (surface
  verbatim). All existing rendering guidance is retained.

### jolli-search

Single-phase, lightweight. New body:

- **Step 1:** parse query (+ optional `limit`; note `--since`/`--budget` are not
  supported on either path now).
- **Step 2 — get hits:**
  - **Preferred:** if `mcp__jollimemory__search` exists, call it with
    `{ query, limit }` → `{ hits }`.
  - **Fallback:** `jolli search --arg-stdin --format json` here-doc → `{ hits }`
    (same shape, same BM25 implementation).
- **Step 3 — render:** each hit has `type` (`topic`/`commit`), `title`,
  `snippet`, `branch`, `commitDate`, `slug`, `hash`, `score`. Render a relevance-
  ordered answer grounded by `hash` (commit) / `slug` (topic) and `branch`.
  Universal principles (lead with the answer; ground every claim to hash/file;
  reply in the user's language; don't expose machinery) are retained. The old
  Step-5 SearchHit schema (decisions/recap/full topics) is **removed** — those
  fields are not in a lightweight hit; the template must not promise them. If the
  user needs deeper content, point them at `jolli-recall` for the relevant branch.

## Data flow

```
recall:  input → [MCP recall | CLI recall here-doc] → resolveRecall()
         → {type:recall|catalog|error} → LLM (catalog?→re-call; recall?→synthesize)

search:  query → [MCP search | CLI search here-doc] → searchHits()
         → {hits[]} → LLM renders ranked list grounded by hash/slug/branch
```

## Error handling

- `resolveRecall` returns `{type:"error"}` for expected empty/no-match/invalid;
  genuine failures throw → MCP `{error}`+`isError`, CLI non-zero exit. Templates
  surface error text verbatim, never fabricate.
- MCP tool absent → CLI here-doc fallback.
- Per-host registration failure → non-fatal `log.warn`; hooks still install.
- Unreadable host config → refuse to write (preserve), `log.warn`, retry next install.

## Testing & coverage

CLI ≥ 97%/96%. New/changed code needing tests:
- `resolveRecall` — all 7 branches (exact/fuzzy/empty/no-branch/invalid/error).
- `runRecall` returns the same union (delegates to `resolveRecall`).
- `searchHits` — empty-query guard, limit sanitization, hits passthrough.
- Rewritten `SearchCommand` — `{hits}` JSON output, `--limit`/`--branch`/`--type`,
  removed-flag behavior; update existing two-phase tests (they will be deleted/
  rewritten — verify no other test imports `parseHashList` from SearchCommand).
- Per-host MCP registrars (JSON writer, Codex TOML writer, registrar list,
  Installer wiring) — idempotent / preserve-others / unreadable-guard / remove.
- SkillInstaller template assertions (MCP tool refs + fallback recipe present).
- `npm run all` green; DCO sign-off; no Claude co-author trailer.

## Out of scope

- IntelliJ MCP registration (Kotlin).
- Removing `LocalSearchProvider` / `SearchProvider` / catalog types (separate cleanup).
- Any change to MCP search ranking/semantics (BM25 used as-is).

## Verification gates before implementation

1. Per-host config format/location verified (integrating-external-systems) before
   that host's registrar is written; omit if unverifiable.
2. Confirm no test outside `SearchCommand.test.ts` imports `parseHashList` /
   two-phase types before deleting them.
3. Confirm `LocalSearchProvider` has no live consumer besides `SearchCommand`
   after the rewrite (re-grep) — keep it, but verify the "intentionally unchanged"
   claim holds.
