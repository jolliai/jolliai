# Confluence reference source (Claude path) — design

**Date:** 2026-07-11
**Status:** Approved, ready for implementation plan
**Branch:** `feature/confluence-mcp-integration`

## Summary

Add a built-in `SourceDefinition` (`confluence`) that passively captures the
result of `mcp__claude_ai_Atlassian__getConfluencePage` calls made by the user's
Claude sessions and turns each into a `Reference` stored in memory. Body content
is normalized to a plain string (markdown passed through; ADF flattened to text).
Claude path only this iteration; Codex is a deferred follow-up (no real fixture
yet — see §8).

## Motivation

The reference subsystem already captures Linear / Jira / GitHub / Notion / Slack /
Zoom entities that an agent touched during a session and folds them into the
memory context. Confluence pages are a first-class source of design/spec context
in this org but are not captured today. When a Claude session reads a Confluence
page via the Atlassian MCP connector, that page's title, URL, space, author, and
body should become a durable reference like any other.

## Architecture: passive capture, zero new I/O

**jollimemory never calls MCP.** The Atlassian MCP host and OAuth are owned by
Claude Code (the `mcp__claude_ai_Atlassian__` connector). The agent calls
`getConfluencePage` *during a session*; the call + its result land in the session
transcript JSONL. jollimemory reads that transcript after the fact
(`ReferenceExtractor.extractReferencesFromTranscript`) and reconstructs a
`Reference` from the recorded `tool_use` / `tool_result` pair.

Consequence: this feature adds **no MCP client, no auth, no network code**. It is
one new `SourceDefinition`, one normalizer, and a shared-helper extraction. When
the Atlassian connector is unauthorized, the agent's tool call fails, the result
payload carries no usable fields, the required-field `require` regexes don't match,
and the reference simply voids — no crash (same behavior as every other MCP
source; MCP entries are `requireSuccess: false`).

Storage is unchanged: references persist through the existing `ReferenceStore`
(active markdown at `<jolliMemoryDir>/references/confluence/<pageId>.md`) and the
`SummaryStore` orphan-branch snapshot. No storage-layer changes.

## Matching and ordering (the critical ordering gotcha)

`jira.match.claude` is `prefixes: ["mcp__claude_ai_Atlassian__"]` with **no
`acceptSuffix`** — it is the catch-all for every Atlassian MCP tool.
`SourceDefinitionRegistry.match()` returns the *first* definition in
`BUILTIN_DEFINITIONS` order whose prefix (and optional suffix) matches.

Therefore:

- `confluence.match.claude = { prefixes: ["mcp__claude_ai_Atlassian__"], acceptSuffix: "getConfluencePage" }`
- **`confluenceDefinition` must be placed BEFORE `jiraDefinition`** in
  `sources/definitions/index.ts` → `BUILTIN_DEFINITIONS`.

Result: `getConfluencePage` → confluence matches first (prefix + suffix);
`getJiraIssue` → confluence's suffix fails, falls through to jira (prefix-only).

## Observed payload (real captures, 3 formats)

`getConfluencePage` returns (verified against a live page, all three
`contentFormat` values):

```
{ content: { totalCount, nodes: [ {
    id: "557292",                 // numeric page id (string)
    type: "page", status: "current",
    title: "…",
    summary: "…",
    space: { key, name },
    author: { displayName, avatarUrls },
    _links: { webui },
    lastModified: "17 minutes ago",   // relative text, NOT a usable timestamp
    body: <string | ADF-object>,      // markdown string (default / "markdown");
                                       // ADF object ({type:"doc",content:[…]}) when "adf"
    webUrl: "https://…/wiki/spaces/…" // absolute
} ] } }
```

- **default (omitted) and `markdown`**: `body` is a markdown **string**.
- **`adf`**: `body` is an **object** (Atlassian Document Format AST).

Real captures of all three shapes become test fixtures (§7).

## The `confluence` SourceDefinition

The normalizer (below) reshapes the raw payload into a single canonical object,
mirroring `zoom-doc`, so the definition reads plain `path` ops and needs no
`wrapperKeys`:

```
id: "confluence"
label: "Confluence"
icon: "book"
match: { claude: { prefixes: ["mcp__claude_ai_Atlassian__"], acceptSuffix: "getConfluencePage" } }
wrapperKeys: []
reference:
  nativeId:    { pipe: [{ op: "path", path: "pageId" }], require: "^\\d+$" }
  title:       { pipe: [{ op: "path", path: "title"  }], require: ".+" }
  url:         { pipe: [{ op: "path", path: "url"    }], require: "^https://[^/]+/wiki/" }
  description: { pipe: [{ op: "path", path: "body"   }], optional: true }
fields:
  - { key: "space",       label: "Space",  icon: "symbol-namespace", pipe: [{ op: "path", path: "space"  }] }
  - { key: "author",      label: "Author", icon: "account",          pipe: [{ op: "path", path: "author" }] }
  - { key: "entity-type", label: "Type",   icon: "symbol-class",     pipe: [{ op: "const", value: "page" }] }
storage: { nativeIdPathSafe: true }          // numeric id is path-safe
render:
  wrapperTag: "confluence-pages"
  itemTag: "page"
  bodyTag: "content"
  maxCharsPerReference: 30000                 // long-form, same tier as notion / zoom-doc
  maxTotalChars: 60000
```

**URL `require` decision:** `^https://[^/]+/wiki/` — any HTTPS host with a `/wiki/`
path. Stricter than jira's bare `^https?://` (confirms it is a wiki link), looser
than hard-coding `atlassian.net` (does not exclude future custom domains / Data
Center). May be tightened to `\\.atlassian\\.net/wiki/` later, since the claude.ai
Atlassian connector is Cloud-only today.

## Normalizer + shared `adfToText`

### `sources/ConfluenceNormalize.ts` (new)

Contract mirrors `ZoomDocNormalize` — returns `null` on anything unparseable (the
caller voids the reference); never throws.

```
interface ConfluenceCanonical {
  readonly pageId: string
  readonly title: string
  readonly url: string
  readonly body?: string
  readonly space?: string
  readonly author?: string
}

normalizeConfluence(rawResult): ConfluenceCanonical | null
  1. !isObject(rawResult)            → null
  2. content = rawResult.content; !isObject(content) → null
  3. nodes = content.nodes; !Array.isArray(nodes) || length === 0 → null
  4. node = nodes[0]; !isObject(node) → null   // getConfluencePage(pageId) → exactly 1 node
  5. pageId = node.id, title = node.title, url = node.webUrl
     — do NOT null-check title/url here; let the definition's `require` void it
       (keep "normalize only normalizes")
  6. body = typeof node.body === "string" ? node.body : adfToText(node.body)
     — empty/whitespace → undefined
  7. space = node.space?.name, author = node.author?.displayName (optional)
  return { pageId, title, url, body?, space?, author? }
```

### `sources/AdfToText.ts` (new — extracted, no behavior change)

`adfToText` currently lives privately in
`bindings/codex/CodexJiraBinding.ts`. It is agent-agnostic and body-format-generic
(handles heading / paragraph / list / blockquote / codeBlock / text; unknown
nodes concatenate children). Move it verbatim to `sources/AdfToText.ts`;
`CodexJiraBinding.ts` imports it and deletes its local copy. **Pure move, zero
behavior change** — the existing `CodexJiraBinding.test.ts` guards against
regression.

### Registration in `ClaudeEnvelopeParser.ts`

Add to `CONTEXT_NORMALIZERS`:

```
"confluence": (payload) => normalizeConfluence(payload),   // ignores toolInput / env
```

`CONTEXT_NORMALIZER_IDS` is derived from `Object.keys(CONTEXT_NORMALIZERS)` — no
manual edit.

**Docstring honesty note:** `CONTEXT_NORMALIZERS` is documented as the home for
sources whose canonical shape "needs out-of-payload context (the originating
`tool_use` input, and/or parse-scoped state)". Confluence needs neither — it lives
here purely for an ADF-object → string **type coercion** the DSL cannot express
(`path` returns the object; `transform` fns are `(string) => string`). Broaden the
docstring from "needs out-of-payload context" to "…**or a payload-internal shape
coercion the DSL cannot express**", so the registry's stated boundary matches its
actual residents.

## Ripple list (every touched file)

**New**

- `cli/src/core/references/sources/definitions/confluence.ts`
- `cli/src/core/references/sources/ConfluenceNormalize.ts`
- `cli/src/core/references/sources/AdfToText.ts`
- `cli/src/core/references/sources/definitions/confluence.test.ts`
- `cli/src/core/references/sources/ConfluenceNormalize.test.ts`

**Modified**

- `cli/src/core/references/sources/definitions/index.ts` — import + insert into
  `BUILTIN_DEFINITIONS` **before jira**
- `cli/src/core/references/ClaudeEnvelopeParser.ts` — add confluence to
  `CONTEXT_NORMALIZERS`; broaden the docstring
- `cli/src/core/references/bindings/codex/CodexJiraBinding.ts` — delete local
  `adfToText`, import from `AdfToText.ts`
- `cli/src/Types.ts` — add `"confluence"` to `KnownSourceId` (cosmetic; runtime
  uses the registry)
- `cli/src/core/references/SourceDefinitionRegistry.test.ts` — add `"confluence"`
  to the id-order assertion, positioned before `"jira"`

**Verified NOT to require changes**

- `CLAUDE_TOOL_PREFIXES` — reuses the existing `mcp__claude_ai_Atlassian__` prefix
  (already contributed by jira); deduped array unchanged. Re-run
  `bindings/claude/index.test.ts` to confirm.
- Storage layer, MCP server tool set, folder layout.

## Testing & fixtures

- **Real fixtures**: the three live `getConfluencePage` captures (string body ×2,
  ADF-object body ×1) pinned as fixtures (per the hard rule: external-data parsers
  must be anchored to a real capture, never a hand-authored one).
- `ConfluenceNormalize.test.ts`: string body passes through unchanged; ADF body
  flattens to text preserving headings/list markers/inline `code`; malformed
  shapes (`content` missing, empty `nodes`, non-object node) → `null`.
- `confluence.test.ts`: fed a normalizer output, asserts
  nativeId/title/url/description/fields; a non-wiki URL voids; a `getJiraIssue`
  tool name does NOT get captured by confluence (ordering regression guard).
- CLI coverage floor (97% statements / 96% branches / 97% functions / 97% lines)
  held — new code must add zero uncovered gaps.
- `npm run all` once at the end (clean → build → lint → test), not per-task.

## Codex follow-up (explicitly NOT this iteration)

Codex/Rovo Atlassian payloads are a completely different shape from Claude's
(`{issues:{nodes:[…]}}`, field values under `versionedRepresentations`, `webUrl`
top-level, ADF description) — the `CodexJiraBinding` shape was derived from a real
Codex Jira capture. **No real Codex Confluence transcript exists in the repo**, and
it is unconfirmed whether Codex's Rovo connector even exposes a Confluence-page-read
tool. Building a Codex binding now would mean guessing the tool name, namespace, and
payload shape — the exact self-consistent-but-wrong trap the real-fixture rule
forbids.

When a real Codex Confluence transcript (the `function_call_output` JSON) is
available, add:

- `confluence.match.codex` (namespace + function-call / invocation names from the
  real capture)
- `cli/src/core/references/bindings/codex/CodexConfluenceBinding.ts` (reusing the
  now-shared `AdfToText.ts`)

## Out of scope

- Proactive fetching (jollimemory calling MCP/API itself) — rejected in favor of
  passive capture, consistent with every existing source.
- Confluence search / space-listing / comment tools — only `getConfluencePage`.
- Codex support — deferred (above).
