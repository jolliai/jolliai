# P0: Knowledge Index & Search — Design

**Date:** 2026-06-08
**Scope:** Phase 2 **P0 only** — a full-text search index plus an MCP server. P1/P2 explicitly deferred.

## Background & rationale

The Linear issue was written **before** the topic-KB refactor (SP1–SP5). Two of its premises are now stale and the design corrects them:

- It names "Phase 1 compiled artifacts" as the index source via a `CompiledStore`. That module was removed in the SP5 teardown. The current equivalents are the **topic KB** (`topics/index.json` + `topics/<slug>.json`, LLM-reconciled topic pages) and the **raw commit catalog** (`catalog.json`, per-commit topics).
- Its §2.4 proposes "refactor ContextCompiler into L0–L3 layered loading." `ContextCompiler` is now the recall engine and reads **raw summaries only** — topic-KB shape was deliberately decoupled from recall. L0–L3 conflicts with that architecture and is **out of scope** for P0.

The only genuinely new, no-prior-art capabilities are **(1) a full-text search index** and **(2) an MCP server**. Both are P0 in the issue's own priority table. We start with Orama full-text (the issue's recommended "Approach A"), no embeddings.

## Scope

**In scope (P0):**
- Orama full-text index over **two sources**: topic KB pages + raw commit catalog, distinguished by a `type` field so search can hit a topic and drill down to commits.
- Local persistence at `.jolli/jollimemory/search-index.json` (already gitignored via `.gitignore` `.jolli/`). Never on the orphan branch — always rebuildable from source.
- Index freshness: **incremental upsert** appended to `compileAllRepos`, **plus** a cheap staleness fingerprint checked at query time with full-rebuild fallback. `jolli mcp --reindex` forces a full rebuild.
- A stdio **MCP server** exposing **4 tools**: `search`, `recall`, `get_decision_timeline`, `list_branches`.
- **Auto-registration** of the MCP server into Claude Code's project `.mcp.json`, wired into the existing Installer, gated on `claudeEnabled`.

**Out of scope (deferred follow-ups):**
- Embeddings / vector search (issue "Approach B", P2).
- Hybrid re-ranking — time decay, branch affinity, importance weight (P2). P0 uses Orama default BM25 ranking.
- L0–L3 progressive context loading (P1; conflicts with current recall architecture).
- Cross-branch association discovery / `get_related_work` / `RelatedBranchFinder` (P1).
- IntelliJ-side MCP auto-registration (CLI + VS Code only; IntelliJ documents manual setup).
- Any change to `QueueWorker` / the git-hook pipeline.

## Module structure

All new code under `cli/src/` (bundled into the VS Code extension by esbuild as usual).

| Module | Responsibility |
|---|---|
| `core/SearchIndex.ts` | Orama wrapper: schema, `buildFromSources`, incremental `upsert`, `save`/`load` (via `@orama/plugin-data-persistence`), `search`, staleness-fingerprint check + rebuild. |
| `core/SearchIndexSource.ts` | Projects the two sources (topic KB `index.json` + pages; raw `catalog.json`) into the unified Orama document shape. The only module that knows source layouts. |
| `mcp/McpServer.ts` | MCP stdio server: declares the 4 tools, validates inputs, dispatches to `SearchIndex` + `ContextCompiler`. No business logic of its own. |
| `commands/McpCommand.ts` | `registerMcpCommand(program)` → `jolli mcp` starts the stdio server; `jolli mcp --reindex` forces a full rebuild and exits. Registered in `Api.ts` alongside the other `register*` calls. |
| `install/McpRegistration.ts` | Writes/removes the MCP server entry in `.mcp.json`, invoked from the Installer. Uses the same `resolve-dist-path` indirection as hooks so the entry survives version bumps. Gated on `claudeEnabled`. |

## Index document schema & data flow

Unified Orama document (no embedding field in P0; pure BM25 full-text):

```ts
interface SearchDoc {
  id: string;          // "topic:<slug>" | "commit:<fullHash>"
  type: "topic" | "commit";
  title: string;
  content: string;     // searchable body
  decisions: string;   // joined decision text (empty if none)
  branch: string;      // commit: branch; topic: relatedBranches joined
  category: string;    // commit: source kind; topic: source type
  commitDate: string;  // ISO 8601
  slug: string;        // topic slug, else ""
  hash: string;        // commit fullHash, else ""
}
```

Orama schema declares every field as `"string"` (filterable/searchable). `commitDate` kept as string for P0 (time-decay ranking is P2).

**Projection (`SearchIndexSource`):**
- **topic doc:** `id = "topic:<stableSlug>"`, `content` = topic page body, `branch` = `relatedBranches.join(" ")`, `category` = dominant `sourceRefs[].type`, `commitDate` = `lastUpdatedAt`.
- **commit doc:** `id = "commit:<fullHash>"`, `content` = the commit's topics' `trigger`/`response` concatenated, `decisions` = joined decision texts, `hash` = `fullHash`, `branch` = entry branch, `commitDate` = entry date.

**Persistence:** `@orama/plugin-data-persistence` `persist`/`restore` → `.jolli/jollimemory/search-index.json` (resolved via `getJolliMemoryDir(cwd)`). A sidecar manifest stores `{ schemaVersion, catalogSig, topicIndexSig, savedAt }`.

**Freshness (the "both combined" strategy):**
- At query time `SearchIndex` computes a cheap signature: `catalog` entry count + `index.json` head hash + max `lastUpdatedAt` across `topics/index.json`. If it differs from the persisted manifest (or the file is missing/corrupt/version-mismatched), it **rebuilds from scratch** and re-persists.
- `compileAllRepos`, after its existing `drainIngest` + `renderTopicKBWiki` per repo, calls an **incremental upsert** so the common path stays warm and the query-time rebuild is rarely triggered.
- Commits created by `summarize` (via `QueueWorker`) are **not** hooked directly; the query-time staleness check is what picks them up. This keeps the hook pipeline untouched (a hard scope boundary).

## MCP tools

The server starts with its launch `cwd` as the project root, resolves config + storage through the existing `StorageFactory` / `setActiveStorage`, reads from the orphan branch (system of record), and uses the local index for search. All four tools reuse existing engines — zero new business logic.

| Tool | Input | Implementation |
|---|---|---|
| `search` | `{ query, branch?, type?, limit? }` | `SearchIndex.search`; returns hits `{ title, snippet, type, branch, commitDate, hash?, slug? }`. `type`/`branch` map to Orama `where` filters. |
| `recall` | `{ branch? }` | Defaults to current git branch when omitted. `compileTaskContext(branch)` → `buildRecallPayload`. **Reads raw `CommitSummary` records from `index.json` (NOT the topic KB)** — the exact same path the jolli-recall skill uses; "compile" in the function name means "assemble raw summaries", unrelated to topic-KB compiled artifacts. Covers both "resume my branch" (no arg) and "look at branch X" (arg) — merged from the originally-proposed `get_branch_context`. |
| `get_decision_timeline` | `{ slug }` | Loads the topic page, sorts `sourceRefs` by `timestamp`, returns a chronological list of `{ timestamp, branch, sourceType, sourceId }` plus the page title. |
| `list_branches` | `{}` | `listBranchCatalog()`. |

Invalid input → a structured tool error (never crashes the process). Storage miss / empty corpus → empty result, not a throw.

## Dependencies & cross-surface

New `cli/package.json` runtime deps (inlined into the VS Code bundle by esbuild):
- `@orama/orama`
- `@orama/plugin-data-persistence`
- `@modelcontextprotocol/sdk`

**Risk to validate first:** all three must bundle to CJS cleanly inside `vscode/esbuild.config.mjs`. The implementation plan's first step is a packaging smoke test (build the VS Code bundle, confirm no unresolved ESM/CJS issues) before building features on top.

**Auto-registration:** `McpRegistration.ts` writes a server entry to the project `.mcp.json` whose command invokes the dist-path-resolved `Cli.js mcp` (same indirection as hooks, so version bumps don't break it). Hooked into the Installer's per-worktree pass, gated on `claudeEnabled`, and removed on uninstall. IntelliJ auto-registration is deferred; IntelliJ users get documented manual setup.

## Error handling

- **Index corrupt / schema-version mismatch / unreadable:** delete and rebuild from source. The index is never authoritative — source data (orphan branch / folder) always is.
- **MCP tool bad input:** return a structured MCP error; the server stays up.
- **Storage unavailable / empty corpus:** return empty results rather than throwing.
- **`compileAllRepos` upsert failure:** logged and swallowed (matches the existing shadow-write tolerance); next query-time staleness check rebuilds.

## Testing

Must hold the CLAUDE.md CLI coverage floor (97% statements / 96% branches / 97% functions / 97% lines).

- `SearchIndex`: build-from-sources, search (term + filters), staleness detection (sig match → no rebuild; mismatch → rebuild), save/load round-trip, corrupt-file recovery.
- `SearchIndexSource`: topic and commit projection from fixture `index.json` / `catalog.json` / topic pages.
- `McpServer`: each tool's dispatch with mocked `SearchIndex` + `ContextCompiler`; bad-input → structured error; `recall` default-branch resolution.
- `McpRegistration`: writes a correct `.mcp.json` entry; idempotent re-write; removal on uninstall; `claudeEnabled === false` → no-op.
- `compileAllRepos` incremental-upsert hook covered by extending its existing test.

Per repo convention: write tests + implementation per task, run `npm run all` and commit **once at the end**, not per task.
