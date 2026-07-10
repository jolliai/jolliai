# Exclude enumeration tools from reference extraction — design

**Issue:** JOLLI-1921 — Linear `list_issues` / `search_issues` results are bulk-captured
as references into Working Memory → Context.

**Date:** 2026-07-10

## Problem

When an agent calls an MCP enumeration tool (`list_issues` / `search_issues`), the
reference extractor walks the whole tool result and captures **every** returned
issue as a reference. A single call floods the sidebar's **Working Memory →
Context** with dozens of issues the user is not working on. A list/search
enumeration is not the same as the user actively working on those entities.

Two independent paths cause this:

- **Claude path** — `SourceDefinitionRegistry.match("claude", …)` matches by
  tool-name **prefix only**, so `mcp__…_Linear__list_issues` resolves to the
  Linear definition exactly like `get_issue`. `walkPayload` (ReferenceExtractor)
  then descends into the definition's `wrapperKeys` (`issues` / `results` / …)
  and emits one `Reference` per array element.
- **Codex Linear** — `linear.ts` declares `_list_issues` / `_search` (and their
  dotted `linear.*` invocation forms) in `match.codex`. Per `CodexLinearBinding`,
  these were added speculatively and their payload shape is **not verified live**.

## Scope

Fixed:

- **Claude path** enumeration exclusion for **Linear** (the confirmed, reported
  bug — real `linear.app` URLs; `list_issues` is a live connector tool this very
  session). Linear matches by prefix and unwraps `issues`/`results`.
- **Codex Linear** speculative `_list_issues` / `_search` recognition removed.

Intentionally **not** changed:

- **GitHub** — deferred to a fixture-first follow-up (same reasoning as Jira).
  The final review surfaced that GitHub's Claude-path MCP tool names are **not
  verified** anywhere in the codebase: the established canonical is
  `mcp__github__issue_read` (13 uses), while `get_issue` / `list_issues` /
  `search_issues` appeared only in newly-written test code. GitHub MCP matching
  has always been prefix-only, so no real GitHub tool name was ever pinned, and
  the GitHub definition also captures **pull requests** (`nativeId` regex matches
  `(?:issues|pull)/\d+`), so `list_pull_requests` / `search_pull_requests` /
  `list_sub_issues` would flood too. Shipping guessed deny suffixes risks being
  a no-op (wrong names) or incomplete (PRs). Per the repo's real-fixture rule,
  GitHub is deferred until a real GitHub MCP transcript confirms the actual tool
  surface (issues **and** PRs).
- **Codex GitHub `_search_issues`** — a verified, tested single-entity discovery
  flow (search → `gh` shell backfill → dedupe into one rich reference; see
  `CodexEnvelopeParser.test.ts` and the `CodexBinding` header). Left intact.
- **Jira** — codex path is already single-entity-only (`_getjiraissue`). Its
  Claude-path JQL-search tool name is not verified against a real transcript, so
  no deny suffix is invented here (repo rule: real fixtures, not guesses). Left
  as a follow-up once the tool name is confirmed.
- **Notion** — already gated: `match.claude.acceptSuffix: "notion-fetch"` plus a
  `metadata.type === "page"` guard. Enumeration (`notion-search`) never matches.

## Design

### 1. New schema primitive: `denySuffixes` on `MatchClaude`

The Claude path matches by prefix, so exclusion cannot be expressed by "removing
a name" (unlike Codex, which lists explicit tool names). Add a symmetric deny
gate — the mirror of the existing `acceptSuffix`:

```ts
export interface MatchClaude {
    readonly prefixes: ReadonlyArray<string>;
    readonly acceptSuffix?: string;
    /** After a prefix match, reject if the tool name ends with any of these.
     *  Enumeration tools (list_issues / search_issues) bulk-capture their whole
     *  result array, so they are excluded from reference extraction. */
    readonly denySuffixes?: ReadonlyArray<string>;
}
```

`SourceDefinitionRegistry.match("claude", toolName)` — after the prefix and
`acceptSuffix` checks pass — additionally rejects when
`denySuffixes.some((s) => toolName.endsWith(s))`. Matching by `endsWith` is
consistent with `acceptSuffix`; false positives (a non-enumeration tool literally
ending in `list_issues`) are not a concern for these connectors.

`validateDefinition` does not deep-validate `match` today (per its own doc
comment — `match`/`storage`/`render` are internal wiring for built-ins), so no
validator change is required.

### 2. `linear.ts`

- Claude: `denySuffixes: ["list_issues", "search_issues"]`.
- Codex: drop `_list_issues` / `_search` from `functionCallNames`; drop
  `linear.list_issues` / `linear.search` from `invocationTools`. Leaves the
  single-entity `_fetch` / `_get_issue` (and their invocation forms).

### 3. `github.ts` — deferred

Not changed (see Scope). GitHub enumeration exclusion is a follow-up that must
start by capturing a real GitHub MCP transcript to verify the actual tool names
(issues and PRs) before any deny suffix is added.

### 4. Doc lockstep: `CodexLinearBinding.ts`

Its header currently documents `_list_issues` / `_search` as recognized. Update
it to state they are intentionally excluded to prevent Working Memory → Context
flooding, so code and comment stay in lockstep.

## Behavior after fix

- Claude `mcp__…_Linear__list_issues` / `search_issues` → `match()` returns
  `undefined` → `walkPayload` never runs → **0 references**.
- Claude Linear `get_issue` → unchanged (1 reference).
- Codex Linear `_list_issues` / `_search` → no longer match → 0 references.
- Codex GitHub `_search_issues` → unchanged (discovery + dedupe intact).
- GitHub Claude path → unchanged in this PR (deferred).

Note: excluding list/search on the Claude path removes no *new* references beyond
what single-entity fetches already produce — dedupe already merged a
list-and-then-`get_issue` pair by `mapKey`. What it removes is the flood of
*un-fetched* enumeration entries.

## Testing

- **Invert** the two current buggy-behavior tests in `ReferenceExtractor.test.ts`:
  - `"extracts all issues from a list_issues array result…"` → now asserts 0
    references.
  - The list-then-`get_issue` dedupe test → repurpose to two `get_issue` calls
    (the list line no longer contributes), keeping the "latest referencedAt wins"
    assertion meaningful.
- **Add** (ReferenceExtractor level): Claude Linear `list_issues` → 0 references;
  `get_issue` still yields its reference (regression guard).
- **`SourceDefinitionRegistry.test.ts`**: `match("claude", …_Linear__list_issues)`
  / `…__search_issues` → `undefined`; Linear `…__get_issue` still resolves; codex
  Linear `_list_issues` / `_search` no longer match.
- Run the **whole** affected test files (no `-t` filter) — the source-definition
  id ordering and match tables are exhaustive; a filtered run can mask a ripple.

## Risks

- Low. The change narrows matching; it cannot produce new references. The only
  behavioral removal is the intended one (enumeration flooding). Codex GitHub
  discovery and all single-entity fetches are preserved.
- CLI coverage floor (97%) — the new `denySuffixes` branch and the Linear source
  edit are covered by the added registry + extractor tests.

## Follow-up (deferred)

- **GitHub enumeration exclusion.** Capture a real GitHub MCP transcript to
  confirm the actual Claude-path tool names for both issue and PR enumeration,
  then apply the same `denySuffixes` gate. Do not guess the names.
