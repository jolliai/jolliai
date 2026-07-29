# 154. Built-in reference source definitions

## Topic Statement

Twelve built-in reference sources — Linear, Confluence, Jira, GitHub, Notion, Slack, Zoom Meeting, Zoom Doc, Asana, monday.com, Context7, and Jolli Memory — are each described as a single **data-only source definition**: a declarative bundle of extraction pipes over an already-parsed tool-result payload plus render metadata, carrying no source-specific code. A shared engine (spec 255) evaluates any definition to project a payload into a uniform cross-source reference record and to render those records into the summarization prompt. This spec is the catalog: the fixed set of built-ins, their **correctness-sensitive** registration order, and each source's field extraction, id/url rules, display fields, description handling, wrapper keys, budgets, and render tags. It also covers the two engine transforms the definitions invoke (HTML-entity decode, ASCII lowercase) and the producer-side payload reshapes the engine-external layer performs before some definitions run (the GitHub issue reshape, the shared Atlassian-Document-Format → plain-text flattener, the Confluence dual-envelope normalization, the Zoom Doc normalization, the monday.com item normalization, and the two arguments normalizations — Context7 and Jolli Memory).

## Scope

**In scope:**

- The fixed ordered set of twelve built-in source definitions and the fact that registration order is preserved, observable, and — at the Claude tool-name layer — correctness-sensitive (Confluence must precede Jira).
- The fact that this spec's title said **external** until the twelfth source arrived. `jollimemory` is **self-referential**: the system being referenced is Jolli's own memory, so there is no external service, no external identifier, and no external destination. Everything else in the catalog is an external system, and every framing below that says "external" should be read as true of the first eleven.
- The three optional consumer flags a definition may declare (track-only; arguments-derived; accumulate-body), which today two built-ins set between them, and the consequence that a track-only source's declared render tags and budgets are unreachable.
- Per-source native-id extraction and its match constraint (id/key grammar; GitHub `owner/repo#number` assembly; Notion page-id extraction and lowercasing; Slack composite id; Confluence numeric page id; Zoom meeting UUID; Zoom doc file id; Asana numeric gid; Context7 library id).
- Per-source title, url, and description field extraction and the url match constraint (scheme; host allow-list or path prefix where one exists).
- The per-source guard where one exists (Notion's page-type gate; Zoom Meeting's non-empty-summary gate).
- Per-source display-field sets: key, label, icon, source value pipe, and list-join rule.
- Per-source wrapper-key lists used by the shared payload walk to descend into collections/envelopes.
- Per-source character budgets (per-reference body cap; per-block total cap) and per-source render tags (wrapper tag, item tag, body tag, and whether display fields render as attributes).
- The two engine-registered transforms the definitions use: an HTML-entity decoder (GitHub body) and an ASCII lowercaser (Notion page id).
- The Notion `<content>` envelope extraction, expressed as an ordinary regex op inside the Notion description pipe.
- The producer-side payload reshapes (engine-external, run before the definition sees the payload): the GitHub issue reshape, the shared Atlassian-Document-Format → plain-text flattener (used by both Confluence bodies and the Codex Jira description path), the Confluence dual-envelope normalization, the Zoom Doc normalization, the monday.com item normalization — an input-gated fetch-vs-browse filter plus a Quill-delta body flatten — the Context7 arguments normalization, and the Jolli Memory arguments normalization; the last two read the tool call's arguments and never the tool's result.
- Which built-ins are reachable on each producer (all twelve on Claude; eleven on Codex — only Zoom Doc is not) and why.
- The open source-id model: a source id is a plain string; twelve built-ins are known, but the id space is not a closed enum.

**Boundaries:**

- This spec does NOT define the DSL op vocabulary, the pipe evaluation semantics, the field-spec/guard mechanism, the render selection algorithm, the transform-registry security boundary, or the structural validator. Those are spec 255. This spec expresses each source purely in terms of that vocabulary.
- This spec does NOT cover transcript parsing, tool-call/result pairing, source recognition (which definition owns a tool call), or the payload-tree walk. Those are spec 153.
- This spec does NOT cover on-disk persistence, native-id path sanitization, or the source-id path guards. Those are spec 179.
- This spec does NOT cover Slack's capture mechanics — permalink harvesting, workspace-URL reconstruction, the read-thread tool scope, or Slack's dual-producer reachability. Slack appears here only as a registered definition; its behavior is owned by **spec 256**.
- This spec does NOT cover how an emitted prompt block is composed into the larger summarize prompt or sent to the LLM.
- This spec does NOT cover free-text mention scanning; every definition operates on a structured payload delivered by a tool-result envelope, never on prose.
- This spec does NOT cover real-time title/status resolution; the title/fields a definition emits are whatever the payload carried at extraction time.

## Data Contracts

### Source identity (open)

A source id is a plain string. Twelve ids ship as built-in definitions: `linear`, `confluence`, `jira`, `github`, `notion`, `slack`, `zoom-meeting`, `zoom-doc`, `asana`, `monday`, `context7`, `jollimemory`. The id space is **open** — it is not a closed enumeration of a fixed count; persistence and identity layers key off the string directly and tolerate ids they do not currently recognize (spec 179's lenient read path). The twelve built-ins are the only ones registered today. Each id doubles as the value placed on every record the definition produces and the registry-key prefix (`<id>:<nativeId>`).

### Definition shape

Each built-in is a source definition as defined by spec 255 (id, label, icon, match block, wrapper-key list, reference field-specs, display-field list, storage spec, render spec, plus three optional consumer flags) — data only. The per-source content of each of those parts is the substance of this catalog.

The optional flags (spec 255 owns their contract) are **track-only** — references from this source are kept as background context and never reach the summarization prompt or the relevance ranker's input — **arguments-derived** — the reference is built from the tool call's arguments rather than the tool's returned payload — and **accumulate-body** — several records sharing one key merge their bodies instead of the newest overwriting the rest. **Two** built-ins declare any flag: Context7 declares track-only and arguments-derived; Jolli Memory declares those two plus accumulate-body, which no other built-in declares. All three are inert to the engine; each is read only by specific downstream consumers.

### Built-in registry (fixed order)

A single list registers the twelve definitions in this order: **Linear, Confluence, Jira, GitHub, Notion, Slack, Zoom Meeting, Zoom Doc, Asana, monday.com, Context7, Jolli Memory**. The order is more than continuity — at the Claude tool-name resolution layer it is a **correctness requirement**. Both Confluence and Jira match the same Atlassian tool prefix (`mcp__claude_ai_Atlassian__`); Jira's Claude rule is a prefix-only catch-all with no accept-suffix, and identity resolution returns the *first* matching definition in registration order (spec 153). Confluence declares the narrower accept-suffix (`getConfluencePage`), so it must be registered **before** Jira — otherwise every Confluence page fetch would resolve to Jira and void on the Jira `key`/`fields.summary` requirements. Zoom Meeting and Zoom Doc similarly share one prefix (`mcp__claude_ai_Zoom_for_Claude__`) and are disambiguated purely by their accept-suffixes, so their relative order does not matter. Adding a source is, at this layer, appending one data-only definition — but insertion point matters whenever a new source shares a prefix with a catch-all definition. The Claude tool-name prefix pre-filter list is *derived* from this registry (deduplicated), so two definitions sharing a prefix contribute one needle, and a newly appended definition's prefix becomes a pre-filter needle automatically with no separate edit.

The last two entries, Context7 and Jolli Memory, are both **order-insensitive**: each has a Claude prefix unique to it and a Codex namespace suffix unique to it, so neither can shadow another definition nor be shadowed by one. Their positions at the end are therefore continuity only, not a correctness constraint — but the final position does place **Jolli Memory** rows last on every registry-ordered display surface, with Context7's second-to-last.

### Shared engine transforms

The definitions invoke exactly two engine-registered transforms by name:

- **HTML-entity decoder** — used by the GitHub description pipe (see below). Decodes a closed set of five named entities (`amp`→`&`, `lt`→`<`, `gt`→`>`, `quot`→`"`, `apos`→`'`) and numeric entities. Any other named entity passes through verbatim (so text containing `&foo;`/`&nbsp;`/`&copy;` is never silently corrupted). Numeric entities: hex `&#x<hex>;` (lowercase `x` only; uppercase `&#X…;` is intentionally not matched) and decimal `&#<dec>;`. A parsed code point is emitted only when it is in `U+0000…U+10FFFF` and NOT in the UTF-16 surrogate block `U+D800…U+DFFF`; out-of-range and lone-surrogate code points pass through verbatim (the entity text preserved). Code points just below/above the surrogate block decode normally.
- **ASCII lowercaser** — used by the Notion native-id pipe to lowercase the extracted page id.

Both are members of the engine's closed transform registry; a definition can only name them (spec 255's security boundary). The Atlassian-Document-Format flattener (used by Confluence bodies and the Codex Jira description path) is **not** one of these engine transforms — it is a producer-side reshape run before the definition evaluates (see "Producer-side payload reshapes" below), because an engine transform is a pure `(string) => string` and the flattener consumes a whole node tree.

### Per-source budgets

| Source | Per-reference body cap | Per-block total cap |
|---|---|---|
| Linear | 4000 | 30000 |
| Confluence | 30000 | 60000 |
| Jira | 4000 | 30000 |
| GitHub | 4000 | 30000 |
| Notion | 30000 | 60000 |
| Slack | 8000 | 40000 |
| Zoom Meeting | 20000 | 40000 |
| Zoom Doc | 30000 | 60000 |
| Asana | 4000 | 30000 |
| monday.com | 4000 | 30000 |
| Context7 | 2000 | 8000 |
| Jolli Memory | 2000 | 6000 |

The widened page/doc budgets (Confluence, Notion, Zoom Doc) reflect that documents are typically much larger than ticket descriptions; Zoom Meeting's mid-range budget covers its AI-generated meeting summary.

**The Context7 and Jolli Memory caps are unreachable configuration.** Both call sites that render a prompt block — the commit-summarization assembly and the regeneration rebuild — skip a track-only definition before any rendering happens, and those two are the track-only built-ins. No reachable code path renders either block, so none of those caps can be observed. They are recorded here for completeness, not as behavior.

### Per-source wrapper-key descent lists

Used by the shared payload walk (spec 153) to descend when the payload itself is not a leaf entity; first key whose value is a list or object is descended.

| Source | Wrapper keys (in order) |
|---|---|
| Linear | `items`, `issues`, `nodes`, `results` |
| Confluence | (none) |
| Jira | `nodes`, `issues`, `items`, `results` |
| GitHub | `items`, `issues`, `nodes`, `results` |
| Notion | `results`, `items`, `pages` |
| Slack | (none) |
| Zoom Meeting | (none) |
| Zoom Doc | (none) |
| Asana | `data` |
| monday.com | `items` |
| Context7 | (none) |
| Jolli Memory | (none) |

Confluence, Slack, Zoom Meeting, Zoom Doc, Context7, and Jolli Memory take no wrapper keys — each operates on a canonical single-entity object already flattened by a producer-side reshape (Confluence, Slack, Zoom Doc, Context7, Jolli Memory) or delivered as a single object (Zoom Meeting). With no wrapper keys the payload walk never descends: the post-reshape object is a leaf, so exactly one reference (or zero) results per tool call. Asana's single `data` key both descends into the connector's `{ data: { …task… } }` single-task envelope and iterates a `{ data: [ … ] }` array shape.

### Per-source render tags

| Source | Wrapper tag | Item tag | Body tag | Fields as attributes? |
|---|---|---|---|---|
| Linear | `linear-issues` | `issue` | `description` | yes |
| Confluence | `confluence-pages` | `page` | `content` | yes |
| Jira | `jira-issues` | `issue` | `description` | yes |
| GitHub | `github-issues` | `issue` | `description` | yes |
| Notion | `notion-pages` | `page` | `content` | **no** |
| Slack | `slack-threads` | `thread` | `messages` | yes |
| Zoom Meeting | `zoom-meetings` | `meeting` | `summary` | yes |
| Zoom Doc | `zoom-docs` | `doc` | `content` | yes |
| Asana | `asana-tasks` | `task` | `description` | yes |
| monday.com | `monday-items` | `item` | `description` | yes |
| Context7 | `context7-libraries` | `library` | `content` | yes |
| Jolli Memory | `jolli-memory-lookups` | `lookup` | `queries` | yes |

Only Notion disables field attributes; every other source (default `true`) renders its display fields as item attributes.

**The Context7 and Jolli Memory rows are unreachable configuration**, for the same reason their budgets are: both prompt-block call sites skip a track-only definition before rendering, so neither a `context7-libraries` nor a `jolli-memory-lookups` block is ever emitted. The rows record what the definitions declare, not observable output. (Their field-attribute settings are doubly moot — both declare no display fields at all.)

## Behavior

The twelve definitions are pure data; "behavior" below is the observable projection each produces when the shared engine (spec 255) evaluates it. The id/key grammar shared by Linear and Jira is `^[A-Z][A-Z0-9_]*-\d+$` — an uppercase-leading prefix (uppercase letters, digits, underscores), a hyphen, then digits. Each source owns its own copy of that constant even though the two coincide today.

### Linear

- **nativeId:** `id`, required to match the ticket-id grammar. Kept verbatim (not lowercased).
- **title:** `title`, required non-empty.
- **url:** `url`, required to start with `http://` or `https://`.
- **description:** `description`, optional (verbatim, no transform).
- **Display fields (in order):** `status` (label "Status", icon "circle-large-filled") from `status`; `priority` (label "Priority", icon "flame") from `priority` OR `priority.name` (string-or-`{name}` via a coalesce); `labels` (label "Labels", icon "tag") from the `labels` string list joined with `", "`.
- **Match:** Claude prefixes `mcp__linear__` and `mcp__claude_ai_Linear__` (the standalone Linear MCP and the official Claude-bundled connector), with **deny-suffixes** `list_issues` and `search_issues` — those enumeration tools bulk-capture whole result arrays and are excluded from reference extraction (spec 153). Codex is reachable via single-issue read tools only (function-call `_fetch`/`_get_issue`, invocation `linear_fetch`/`linear.get_issue`); enumeration tool names are intentionally absent, so Codex-side Linear enumeration is unreachable.

### Confluence

Runs on a **post-normalize canonical object** — `{ pageId, title, url, body?, space?, author?, entityType? }` — produced by a producer-side reshape (see "Confluence dual-envelope normalization" below), NOT the raw MCP payload, because the page body arrives either as markdown text or as an Atlassian-Document-Format node tree the DSL cannot flatten. All extraction is plain `path` ops, so no wrapper keys.

- **nativeId:** `pageId`, required to match `^\d+$` (Confluence Cloud page ids are numeric).
- **title:** `title`, required non-empty.
- **url:** `url`, required to match `^https://[^/]+/wiki/` — any HTTPS host with a `/wiki/` path. This is stricter than a bare scheme check (it confirms a Cloud wiki link) but looser than hard-coding `atlassian.net` (it tolerates Cloud custom domains, which keep the `/wiki/` prefix). Data Center's `/display/` URL layout is intentionally out of scope; the connector is Cloud-only.
- **description:** `body`, optional (already flattened to text by the normalizer).
- **Display fields (in order):** `space` (label "Space", icon "symbol-namespace") from `space`; `author` (label "Author", icon "account") from `author`; `entity-type` (label "Type", icon "symbol-class") from `entityType` OR the constant `page` (coalesce) — the page's real content type ("page" / "blogpost") when present, else `page` for older/leaner captures.
- **Match:** Claude prefix `mcp__claude_ai_Atlassian__` with accept-suffix `getConfluencePage` (registered before Jira — see registration order). Codex via the Atlassian Rovo app's dedicated page-fetch tool (namespace-suffix `atlassian_rovo`, function-call `_getconfluencepage`, invocation `atlassian_rovo.getConfluencePage`). A page fetched through Rovo's *generic* `_fetch` tool does not match here — it routes to Jira by tool name and is dropped (see the Jira known-gap note).
- **Codex-only display-field gap:** the two producers deliver different envelope shapes to the normalizer. Claude's wrapped node carries `space:{name}` / `author:{displayName}` objects; Codex's flat page node carries only `spaceId` / `authorId` *IDs*, with no name objects — so for a Codex-captured Confluence page the `space` and `author` display fields come back **undefined** (deliberately left blank rather than surfaced as opaque numeric IDs). `entity-type` and the core fields are unaffected.

### Jira

Every field lives under `fields.*`, so a missing/non-object `fields` naturally voids the required title and thus the whole reference — this is the discriminator between a Jira issue and another Atlassian payload kind (e.g. a Confluence page lacks `key` + `fields.summary`).

- **nativeId:** `key`, required to match the id/key grammar.
- **title:** `fields.summary`, required non-empty.
- **url:** `webUrl`, required `http(s)`.
- **description:** `fields.description`, optional.
- **Display fields (in order):** `status` from `fields.status.name` OR `fields.status` (dual shape); `priority` from `fields.priority.name` OR `fields.priority` (dual shape); `labels` from `fields.labels` joined with `", "`. Labels/icons match Linear's.
- **Match:** Claude prefix `mcp__claude_ai_Atlassian__` with no accept-suffix — a prefix-only catch-all (which is why Confluence, sharing the prefix, must be registered first). Codex reaches a Jira issue two ways under the Atlassian Rovo namespace-suffix `atlassian_rovo`: the generic `_fetch` (invocation `atlassian_rovo.fetch`) and the dedicated get-issue tool (function-call `_getjiraissue`, invocation `atlassian_rovo.getJiraIssue`). The dotted invocation name must be exactly `atlassian_rovo.getJiraIssue`; an earlier fabricated name never matched a real event, so dedicated get-issue fetches were silently dropped until it was corrected. Both Codex payload shapes are reshaped into the `{ key, fields, webUrl }` this definition reads (see "Codex Jira reshapes" below); the get-issue REST shape carries no top-level `webUrl` (only a `self` REST-endpoint link), so `self` is mapped to `webUrl` or the whole reference would void on the `url` requirement.
- **Known gap:** the generic `_fetch` can also return a Confluence-page entity. It routes here by tool name, passes through the Jira reshape unchanged (its type is not `jira-issue`), and voids on the `key`/`fields.summary` requirements — such a page is **dropped, not captured as Confluence**. Per-payload-type dispatch of the shared `_fetch` is deferred.

### GitHub

Operates on the post-reshape shape (see "GitHub producer-side reshape" below): `{ number, title, html_url, body, state, labels: string[], assignees: string[], milestone, issue_type, repository?: { full_name } }`.

- **nativeId:** assembled by a template `{owner}/{repo}#{number}`, required to match `^[^/]+/[^/]+#\d+$`:
  - **owner:** prefer `repository.full_name` split on `/` (first segment); else parse `html_url` anchored `^https?://github.com/<owner>/<repo>/(issues|pull)/<number>` for the owner group.
  - **repo:** same two fallbacks for the repo segment.
  - **number:** taken **only** from the payload `number` field. *Changed / notable:* the native id is NOT derived from the URL when `number` is absent — a payload carrying a valid `html_url` but no `number` field produces an incomplete template that fails the trailing `require` and voids the reference. (A URL-fallback for `number` was considered and rejected: it would accept a payload the pre-DSL adapter voided.) The trailing `require` also rejects a non-integer number (e.g. `1.5` stringifies to `"1.5"`, failing `#\d+$`).
- **title:** `title`, required non-empty. **url:** `html_url`, required `http(s)`.
- **description:** `body` passed through the HTML-entity decoder transform, optional.
- **Display fields (in order):** `status` (label "Status") from `state`; `labels` from the `labels` list joined `", "`; `assignees` (label "Assignees", icon "account") from the `assignees` list joined `", "`; `milestone` (label "Milestone", icon "milestone") from `milestone` OR `milestone.title` (dual shape); `entity-type` (label "Type", icon "symbol-class") from `issue_type` OR `issue_type.name` (dual shape). The hyphenated key `entity-type` is fixed and intentional and is shared with Notion.

### Notion

- **guard:** `metadata.type` required to equal `page` (anchored `^page$`). Database / data-source payloads void.
- **nativeId:** from `url` — a regex extracts the **last** 32-hex run preceded by `-` or `/` and followed by `/`, `?`, `#`, or end-of-string (pattern `[-/]([0-9a-fA-F]{32})(?=[/?#]|$)`, global, last match), then the ASCII lowercaser transform. Required to match `^[0-9a-fA-F]{32}$`. Taking the last match keys a `…/Parent-<id>/Child-<id>` URL off the child (deepest) page.
- **title:** `title`, required non-empty.
- **url:** `url`, required to match an allow-listed Notion host — `www.notion.so`, `notion.so`, `app.notion.com`, or any `*.notion.site` host — HTTPS only, matched case-insensitively. *Fidelity note:* the constraint is a raw regex on the URL string, marginally less strict against userinfo tricks (`https://evil@www.notion.so.evil.example/…`) than a structural URL parse would be; no payload exercises this gap.
- **description:** `text`, then a regex op that captures the first `<content …>…</content>` block's body (pattern `<content\b[^>]*>([\s\S]*?)</content>`, first match). Optional. Only the first content block is read (the documented Notion shape is a single non-nested content block); open-tag attributes are tolerated; a malformed/absent envelope yields no description.
- **Display fields:** exactly one constant `entity-type` (label "Type", icon "symbol-class") with the literal value `page`. The guard already restricts extraction to page-typed payloads. This field is **not** rendered (Notion's render spec disables field attributes) but is stored so consumers (tooltip, persistence) can read it under the same key GitHub uses.

### Slack

Slack is a registered, url-required source, reachable on both the Claude and Codex producers. Its definition operates on a **post-normalize canonical object** (channel id + parent timestamp + title + text + reply count + url), not the raw MCP blob; the normalization, permalink harvesting, and workspace-URL reconstruction are owned by **spec 256**.

- **nativeId:** template `{c}-{t}` from `channelId` and `parentTs`, required to match `^[A-Z0-9]+-\d{7,}\.\d+$`.
- **title:** `title`, required non-empty.
- **url:** `url`, **required** to start with `https://`. A thread whose url could not be resolved is voided and never stored — a linkless thread reference has nothing to jump to. (This is the one url-required-but-source-may-lack-it case; see spec 256 for when a url is absent.)
- **description:** `text`, optional.
- **Display fields (in order):** `entity-type` (label "Type", icon "comment-discussion") constant `thread`; `replies` (label "Replies", icon "reply") from `replyCount`; `channel` (label "Channel", icon "symbol-namespace") from `channelId`.
- **Reachability:** reachable on both Claude and Codex producers, each with a registered normalizer resolving the thread url from a producer-specific pasted-permalink harvest else workspace-address reconstruction (spec 256); a urlless thread is voided on either producer.

### Zoom Meeting

Operates on a single meeting object delivered directly by the meeting-assets tool (no wrapper keys, no reshape — it is self-contained). Both producers deliver the identical shape.

- **guard:** `meeting_summary.summary_markdown` required non-empty. A meeting with no AI-generated summary voids rather than producing an empty-bodied reference.
- **nativeId:** `meeting_uuid`, required to match `^[\w-]+$`.
- **title:** `topic`, required non-empty.
- **url:** `meeting_summary.summary_doc_url` OR (fallback) `deep_url` (coalesce), required to start with `https://`. Prefer the summary doc; fall back to the always-present deep link.
- **description:** `meeting_summary.summary_markdown`, optional.
- **Display fields (in order):** `entity-type` (label "Type", icon "symbol-class") constant `meeting`; `started` (label "Started", icon "calendar") from `start_time`; `meeting-number` (label "Meeting #", icon "symbol-number") from `meeting_number`.
- **Match:** Claude prefix `mcp__claude_ai_Zoom_for_Claude__` with accept-suffix `get_meeting_assets`. Codex via namespace-suffix `zoom`, function-call `_get_meeting_assets`, invocation `zoom.get_meeting_assets`. Enumeration/recording tools are omitted from the match (allow-list semantics), so they never match.
- **Notable:** on long meetings the primary Codex result copy is frequently malformed JSON (a stray escape mid-transcript), so extraction succeeds through the parser's redundant-event fallback — whose payload is complete and already carries the URLs, so unlike Jira no salvage/recover hook is needed (spec 153).

### Zoom Doc

Operates on a **post-normalize canonical object** — `{ fileId, title, content?, url }` — because the raw doc-content result carries only `{ file_name, file_content }`: the file id lives **only** in the originating tool-call input and the URL is a pure function of that id, so a producer-side normalizer threads the id in and constructs the URL (see "Zoom Doc normalization" below). No wrapper keys.

- **nativeId:** `fileId`, required to match `^[\w.-]+$`.
- **title:** `title` (the file name), required non-empty.
- **url:** `url`, required to match `^https://docs\.zoom\.us/doc/` — the fixed Zoom-doc host + path prefix, constructed from the file id.
- **description:** `content`, optional.
- **Display fields:** exactly one constant `entity-type` (label "Type", icon "symbol-class") value `doc`.
- **Match:** Claude prefix `mcp__claude_ai_Zoom_for_Claude__` with accept-suffix `hub_get_file_content`. **Zoom Doc declares no Codex match rule at all** — it is reachable on the Claude producer only (specs 153, 180).

### Asana

Pure-DSL over the get-task result. The connector returns `{ data: { …task… } }`, so the single wrapper key `data` voids at the top level (the task fields live under `data`), then descends into `data` to extract the task.

- **nativeId:** `gid`, required to match `^\d+$` (Asana task gids are numeric).
- **title:** `name`, required non-empty.
- **url:** `permalink_url`, required to match `^https://app\.asana\.com/`, matched case-insensitively (URL hosts are case-insensitive, so a mixed-case host must not silently void the reference).
- **description:** `notes`, optional.
- **Display fields (in order):** `entity-type` (label "Type", icon "symbol-class") constant `task`; `assignee` (label "Assignee", icon "person") from `assignee.name` (an object subpath). Fields are deliberately minimal: Asana section/project live under array-index paths the DSL's dotted path cannot address, and `completed` is a boolean the scalar coercion drops — so only the constant type and the assignee name are surfaced.
- **Match:** Claude prefix `mcp__claude_ai_Asana__` with accept-suffix `get_task`. Codex via namespace-suffix `asana`, function-call `_get_task`, invocation `asana.get_task`; the Codex `get_task` payload is byte-identical to Claude's, so the Codex normalizer is identity. Only the get-task tool is recognized; enumeration/search/write tools never reach extraction.

### monday.com

Pure-path DSL over a canonical shape `{ id, name, url, created_at, updated_at, board?, description? }` produced by a producer-side reshape (see "monday.com item normalization" below), NOT the raw `get_board_items_page` payload.

- **nativeId:** `id`, required to match `^\d+$` (numeric item ids, serialized as strings).
- **title:** `name`, required non-empty.
- **url:** `url`, required to match `^https://([\w-]+\.)*monday\.com/`, matched case-insensitively — the host must be `monday.com` itself or a subdomain of it; the pattern is anchored so a lookalike host such as `evilmonday.com` is rejected.
- **description:** `description`, optional (already flattened from a Quill-delta body by the normalizer).
- **Display fields (in order):** `entity-type` (label "Type", icon "symbol-class") constant `item`; `board` from `board`.
- **Match:** Claude prefix `mcp__claude_ai_monday_com__` with accept-suffix `get_board_items_page` (every write, enumeration, doc, and dashboard tool is excluded by the allow-list). Codex via namespace-suffix `monday_com`, function-call `_get_board_items_page`.
- **Deliberately not surfaced:** `column_values` — column definitions are board-specific and vary per board, so no fixed display field can represent them generically.

### Context7

A library-documentation lookup service. Context7 is one of the catalog's two **track-only** and **arguments-derived** sources (Jolli Memory is the other), and it declares both flags (spec 255 owns the flag contract; the consumer behavior is specs 12, 258, 153, and 179).

It runs on a **post-normalize canonical object** — `{ libraryId, query? }` — produced by a producer-side reshape that reads the *tool call's arguments* (see "Context7 arguments normalization" below). The tool's actual returned documentation is never read by anything.

- **nativeId:** `libraryId`, kept **verbatim** including its leading `/`, required to match a leading `/<segment>/<segment>` shape where neither segment may contain a slash or whitespace. The constraint is a **prefix** match, not an anchored whole-string match — so a library id carrying a third (version) segment satisfies it and is carried through **whole**. There is no version field and no version stripping anywhere.
- **title:** `libraryId` with its leading `/` removed. Required non-empty.
- **url:** the fixed Context7 web address with the library id appended verbatim, required to start with that same fixed `https` host-and-path prefix. The url is a pure function of the library id; no configuration is involved.
- **description:** `query` — the question the agent asked — optional. Absent when the call carried no query.
- **Display fields:** **none.** Context7 declares an empty display-field list, so its references never carry a display-field bag and its persisted markdown has no fields block at all.
- **Guard:** none.
- **Wrapper keys:** none (the post-reshape object is always a leaf).
- **Storage:** declares itself **not** path-safe, because a library id contains slashes — so its on-disk file stem goes through the replace-unsafe-then-append-content-hash form rather than identity (spec 179).
- **Match:** Claude via a Context7-specific tool-name prefix with an accept-suffix scoping it to the documentation-query tool. Codex two ways under a Context7 namespace suffix: a function-call name, and an invocation-tool name in both bare and dotted form. No deny-suffixes.
  - The companion library-id-resolution tool matches the Claude prefix but **fails the accept-suffix**, so it is not a match at all — indistinguishable from any other unmatched tool. Nothing in the catalog treats it specially, and nothing detects or rejects any other legacy documentation tool name either.
  - The Codex function-call path additionally requires the shared connector-app namespace prefix upstream, so it is only reachable for a Context7 exposed as a hosted connector. A Context7 running as a **local** documentation server is delivered instead through the invocation-tool path, on the parser's redundant-event line (spec 153, spec 180). The connector-app path is therefore **declared and code-reachable but has no observed real-world envelope**.
- **Void cases** (each produces no reference, silently):
  - A library id with fewer than two path segments fails the native-id constraint.
  - A library id whose third segment contains an embedded newline satisfies the native-id constraint but voids on the title constraint, whose pattern is single-line.
  - A library id whose non-first segment carries a query, fragment, or dot-segment character passes every constraint and flows **verbatim into the url**. There is no URL parse and no structural host check beyond the fixed-prefix requirement, so such a value is not rejected — only the host portion is pinned.

### Jolli Memory

The catalog's only **self-referential** source: the system referenced is Jolli's own memory, so — uniquely — there is no external service, no external identifier, and **no external destination**. It records that memory was consulted while working on a commit, and what was asked; never what came back. Like Context7 it is both **track-only** and **arguments-derived**; unlike every other source it also declares **accumulate-body**.

Three MCP tools are captured and nothing else on that server: `recall`, `search`, and `get_decision_timeline`. It runs on a post-normalize canonical object — `{ tool, title, query }` — produced by a reshape over the tool call's *arguments* plus the tool's own name (see "Jolli Memory arguments normalization" below).

- **nativeId:** `tool` — the bare tool name, constrained to exactly that closed set of three. The identity is therefore an **act, not an entity**, which is what accumulate-body exists for: one reference per tool, whose body collects the queries asked since the last commit, rather than each lookup overwriting the previous one.
- **title:** carried in the normalizer output (`Recall`, `Search`, `Decision timeline`) rather than derived by a regex ladder over the tool name. Required non-empty.
- **url:** **declared absent.** Not a url spec that failed to resolve — there is no destination to resolve. Spec 256 scopes the difference; spec 153 records that consumers test url emptiness to decide whether to offer an open-in-browser affordance at all.
- **description:** `query` — what was asked — optional. For a `recall` with no branch argument it is the literal string `(current branch)`, recorded rather than resolved: extraction runs later, at post-commit time, when the branch may no longer be the one the lookup ran on.
- **Display fields:** none.
- **Guard:** none.
- **Wrapper keys:** none (the post-reshape object is always a leaf).
- **Storage:** declares itself **path-safe** — the three tool names contain no path-unsafe byte, and the native-id constraint pins them to exactly that closed set.
- **Match:** Claude via the `mcp__jollimemory__` prefix **plus an exact allow-list** of the three tool names. The exact gate is required, not decorative: a prefix match is a `startsWith` test, so `mcp__jollimemory__search` alone would also capture the sibling `search_remote_articles` / `search_remote_repo` tools. A deny-suffix list could enumerate today's siblings but would silently start miscapturing the day a new `search_*` tool ships; an allow-list cannot drift that way.
  - **Codex** matches on the invocation-tool path only, by the three **bare** tool names. Jolli registers there as a *local* MCP server, which Codex models as a namespace of bare names (`mcp__jollimemory` + `recall`) — so the request line carries neither the connector-app namespace nor a prefixed tool name, matches none of the parser's line pre-filter needles, and is dropped before parsing. Only the redundant `mcp_tool_call_end` event survives, and it carries server, tool, and already-parsed arguments together, which is all an arguments-derived source needs. No exclusion gate is needed on this producer: the registry tests invocation tools by exact list membership, so naming only the wanted three *is* the exclusion. Shapes captured from a live rollout 2026-07-28.
- **Void cases** (each produces no reference, silently):
  - Any tool on the server outside the captured three — `list_branches`, `status`, the Space and workflow tools. Two independent gates reject them: the registry's allow-list, and the normalizer's default arm.
  - A `search` or `get_decision_timeline` whose required argument (`query` / `slug`) is unreadable: there is no act to describe, so the reference voids. A `recall` does **not** void on an unreadable argument — calling it takes no arguments legitimately, and the fact worth recording is that a recall happened.

### GitHub producer-side reshape

A GitHub-owned utility maps a producer's non-canonical GitHub-issue object into the shape the GitHub definition reads. It is self-contained (no engine dependency) and used by producers that emit issues in a raw connector/CLI shape. Behavior:

- Non-object input returned unchanged.
- If the input has a plain-object `issue` property, that inner object is the source; else the input itself.
- `number` ← `issue_number` else `number`, only when numeric. `title` ← verbatim string. `html_url` ← `url` else `html_url`, only when string. `body`, `state` ← verbatim strings.
- `labels` ← list flattened to strings: keep non-empty string entries; from object entries take a non-empty `name`; set only if at least one survives. `assignees` ← same, keyed off `login`.
- `repository_full_name` ← inner issue first, then outer raw object; when set, wrapped as `{ repository: { full_name: <value> } }`.
- When `number` is still unset but `html_url` is present, derive it from the URL via `/(issues|pull)/(\d+)/`. This covers search hits that leave `number` null but always carry the URL. *Note:* this URL-derivation is on the **reshape** side (producer normalization), and it feeds the GitHub definition's payload `number` field — which is why the definition's own native-id pipe can read `number` directly and need not itself parse the URL for the number. An explicitly-set `number` is never overwritten by the URL.

### Atlassian-Document-Format → plain-text flattener (shared reshape)

A small agent- and source-agnostic utility renders an Atlassian-Document-Format (ADF) node tree into markdown-ish plain text. It exists because two payloads deliver rich bodies as an ADF *object* rather than a string, and the declarative engine cannot flatten a node tree (a transform op is a pure `(string) => string`): the **Confluence** page body (under the "adf" content format) and the **Codex Jira** issue description (from the heavy-expand representation). It is engine-external and analogous to the GitHub reshape — a producer-side reshape that runs before the definition's `path` op reads a plain string.

Behavior: a text node renders its `text`; a heading renders `#`×level (clamped 1–6) + its inline children; paragraph and code-block render their inline children; blockquote prefixes each child with `> `; bullet/ordered lists prefix each child with `- ` / `N. `; a document joins its blocks with blank lines; any unknown node type simply concatenates its children. Good enough for a reference body; the consumer truncates it to the per-reference cap.

### Confluence dual-envelope normalization (producer-side reshape)

A Confluence-owned normalizer reshapes a page-fetch MCP result into the `{ pageId, title, url, body?, space?, author?, entityType? }` the Confluence definition reads. **Two envelope shapes** reach it, both carrying the same logical page:

- **Wrapped** `{ content: { nodes: [ node ] } }` — the Claude page-fetch tool result (a single-page fetch yields exactly one node). The node carries `space:{name}` and `author:{displayName}` objects.
- **Flat** `{ id, title, webUrl, body, spaceId, authorId, … }` — the Codex Rovo page-fetch result, whose extracted text block is the page node itself, not a wrapper. The flat node has **no** `space`/`author` name objects — only `spaceId`/`authorId` IDs.

Disambiguation is on presence of a top-level `content` object: once `content` is an object the normalizer commits to `content.nodes[0]` (a flat page node never has a top-level `content`); otherwise a top-level object that looks like a page node (`id` plus a `title` or `webUrl`) is treated as the flat Codex shape. Anything else is unparseable (returns nothing → the reference voids).

From the resolved node it lifts `id`→`pageId`, `title`, `webUrl`→`url`, `type`→`entityType`, and — only from the wrapped shape's objects — `space.name`→`space` and `author.displayName`→`author` (undefined for the flat Codex shape, the display-field gap noted above). The `body` is coerced to a string: passed through verbatim when already a markdown string, or run through the ADF flattener when it is an ADF object (true under the "adf" content format in both shapes). The normalizer never throws — a missing `title`/`url` is left undefined so the definition's `require` regexes void the reference; it returns nothing only for structurally unparseable input.

### Zoom Doc normalization (producer-side reshape)

A Zoom-Doc-owned normalizer builds the `{ fileId, title, content?, url }` canonical object from the doc-content result plus out-of-payload context. The raw result carries only `{ file_name, file_content }`; the file id is threaded in from the originating tool-call input (the reference-extraction pipeline retains that input for this source — spec 153). It sets `title` from `file_name`, `content` from `file_content` (when a string), `fileId` from the threaded id, and constructs `url` as `https://docs.zoom.us/doc/<fileId>` — a pure function of the id, no configuration involved (contrast Slack's config-derived workspace URL). It returns nothing for any shape it cannot parse (a missing/empty `file_name` voids), never throws.

### monday.com item normalization (producer-side reshape)

monday.com has no single-item getter — `get_board_items_page` serves both a targeted `itemIds` fetch and a whole-board browse (up to 500 items), and the tool name alone cannot distinguish the two calls. The normalizer gates on the tool call's **input**: a reference is produced only when the call carried a non-empty `itemIds` (a targeted lookup); a board browse (no `itemIds`) voids the whole result to `null` — this prevents a whole-board browse from bulk-capturing one reference per board row. Item ids are accepted whether they arrive as numbers or numeric strings.

The normalizer also flattens each item's body: `item_description.blocks[].content` is a JSON string holding a Quill `deltaFormat`, a shape the dotted-path DSL cannot express. It is flattened by concatenating each block's insert segments and joining blocks with newlines. A block whose `content` is not JSON-shaped is kept verbatim; a block whose content is JSON-shaped but unparseable, or that lacks a `deltaFormat` array, is skipped — broken JSON is never surfaced and never throws. Wired into both producers.

### Context7 arguments normalization (producer-side reshape)

A Context7-owned normalizer builds the `{ libraryId, query? }` canonical object. It is the catalog's only reshape that consumes the tool call's **arguments** rather than its result. The complete rule set:

1. If the arguments value is not a plain object — including absent, null, an array, or any primitive — the result is nothing and the reference voids.
2. `libraryId` is read as a string: it must be of string type **and** non-empty. Anything else (an empty string, a number, an object) yields nothing and voids the reference **here**, before the definition's own shape constraints ever run.
3. `query` is read the same way, but a non-string or empty `query` is simply **omitted** from the canonical object rather than voiding it.
4. **The tool's result is never read.** Both producers' bindings discard the result payload entirely; only the call arguments reach the normalizer. This is exactly what the arguments-derived flag declares, and it is why a result whose JSON fails to parse still produces a reference (spec 153).
5. A present-but-malformed `libraryId` is deliberately **not** shape-checked here — no segment counting, no host reasoning. That is left to the definition's own native-id / title / url constraints, so the shape rules live in one place.

The same normalizer serves both producers: the Claude path reaches it through the context-normalizer registry, the Codex path through a registered Codex binding whose synthetic canonical tool name is fixed.

### Jolli Memory arguments normalization (producer-side reshape)

A Jolli-Memory-owned normalizer builds the `{ tool, title, query }` canonical object. Like the Context7 reshape it consumes the tool call's **arguments** rather than its result, and additionally the **tool name**, because that is the only thing distinguishing the three tools it serves — two argument-less tools on one server produce byte-identical inputs. The complete rule set:

1. The tool name may arrive **prefixed** (Claude: `mcp__jollimemory__search`) or **bare** (Codex: `search`). The known Claude prefix is stripped; anything else is matched verbatim. One normalizer therefore serves both producers with no per-producer adaptation.
2. `recall` reads an optional `branch` argument. When it is unreadable — the normal shape, since `recall()` legitimately takes none — the query becomes the literal `(current branch)` rather than voiding. Dropping the reference would lose the act itself, which is the fact this source exists to record.
3. `search` requires `query` and `get_decision_timeline` requires `slug`; both are read as non-empty strings. With neither readable there is nothing to describe and the reference voids.
4. Any other tool name returns nothing. This is a second, independent gate behind the registry's exact allow-list, so a matching change on one side cannot silently widen capture.
5. **The tool's result is never read**, on either producer. This is what makes the source safe against `recall`'s very large results, which a host may store out of band and leave absent from the transcript entirely — the reference is still produced.

Because the persisted tool name must not depend on which agent captured the lookup, the Codex binding maps each bare name back onto its Claude spelling; a source owning three tools cannot express that with the single fixed string the other bindings use, so that field accepts a resolver form.

### Render projection (per definition, via the shared engine)

The engine's render algorithm (spec 255) is identical across all twelve; the only per-source differences are the render tags, the field-attribute toggle, and the budgets tabulated above. Context7 and Jolli Memory are the exceptions in reachability rather than in algorithm: being track-only, both are skipped before rendering at either call site, so their render rows are never exercised. Concretely: an opening item element with an `id` attribute (and, unless disabled, one attribute per display field in field order), a title element, a url element (only when a url is present), an optional body element (`bodyTag`) carrying the description truncated to the per-reference cap, and the closing element — all wrapped in the source's outer wrapper tag. Notion emits no field attributes because it disables them; Context7 and Jolli Memory emit none because they declare none; the other nine emit theirs. Attribute values use attribute-context escaping (escapes quotes); title/url/body use text-context escaping (quotes preserved). Selection is newest-first-admit / oldest-first-emit under the per-block budget, skipping any single over-budget record (spec 255).

## State Transitions

This catalog is stateless. Each definition is immutable data; evaluating it is a pure function of the payload (extraction) or the record list (render). No persistence, caches, or side effects live here.

## Notable Behavior

- **Definitions are data, not code.** There is no per-source module of executable logic, no adapter contract, and no adapter-lookup dispatch. A source is a declarative bundle the shared engine interprets. The only code a definition references is a transform name resolved against the engine's closed registry.
- **The source-id space is open.** Twelve ids are known and registered, but the id is a plain string, not a closed fixed-member enum. Layers that must reject an unknown id do so via a registry-membership check, not by matching a fixed union (spec 179).
- **No free-text mention scanning.** No definition parses prose for `TEAM-123`, `owner/repo#issue`, SHAs, or blob URLs; each operates only on a structured payload delivered by an upstream tool-result envelope.
- **Extraction never throws on malformed payloads.** A shape mismatch voids the reference (produces nothing); it does not raise. (The one raise in the whole engine is naming an unregistered transform — impossible for a validated built-in.)
- **Source recognition is not the definition's job.** No definition inspects the tool name to decide scope; recognition lives in the match block resolved upstream (spec 153). The Jira gate's `key + fields.summary` requirement, not any tool-name test, is what discriminates a Jira issue from a Confluence page.
- **GitHub native id no longer derives `number` from the URL.** Changed behavior: the native-id template reads `number` only from the payload field. A payload with a valid url but no `number` field is voided. (URL-derivation of `number` survives only on the producer-side reshape, which populates the payload field before the definition runs.)
- **GitHub owner/repo prefer `repository.full_name`, then the URL.** If the explicit field is malformed, the URL is consulted next; a payload missing both voids even when every other field is valid.
- **GitHub `entity-type` field key is hyphenated and shared with Notion.** The literal key is `entity-type`, deliberately shared so the "Type" concept persists under one key across sources.
- **Notion id casing is normalized; Linear and Jira ids are not.** Notion page ids are lowercased; Linear/Jira ids are kept verbatim (already uppercase by grammar).
- **Notion takes the deepest 32-hex id from a parent/child URL** (last match), on the rationale that the deepest segment is the actually-fetched page.
- **Notion accepts `app.notion.com` and any `*.notion.site`** in addition to `www.notion.so`/`notion.so`, unconditionally across producers.
- **Notion's body element is `content`, not `description`,** and Notion emits no per-record field attributes even though it carries the `entity-type` field.
- **The HTML-entity decode and Notion `<content>` extraction are now engine ops, not per-source helper modules.** The decode is a registered transform named by the GitHub description pipe; the Notion content lift is an ordinary regex op inside the Notion description pipe. Observable behavior is unchanged (same five named entities, same numeric range/surrogate guard, same first-block-only content capture, same attribute tolerance).
- **The HTML-entity decoder rejects the HTML-spec uppercase hex form** (`&#X…;`) — only lowercase `&#x…;` is matched — and preserves lone-surrogate and unknown named entities verbatim.
- **Registration order is correctness-sensitive, not just observable.** Confluence must be registered *before* Jira: both match the Atlassian tool prefix, Jira's Claude rule is a prefix-only catch-all, and the first matching definition wins — so if Jira came first, every Confluence page fetch would resolve to Jira and void. Adding a source appends, but insertion point matters when it shares a prefix with a catch-all. The Claude tool-name prefix pre-filter list is derived from this registry, deduplicated (prefix-sharing definitions contribute one needle).
- **Codex reachability is 11 of 12.** All twelve are Claude-reachable. Linear, Confluence, Jira, GitHub, Notion, Zoom Meeting, Asana, monday.com, Slack, Context7, and Jolli Memory are also Codex-reachable (each declares a Codex match rule and has a registered Codex normalizer). Only **Zoom Doc** is not — it declares no Codex match rule at all (never matched), so it remains Claude-only (specs 153, 180). Slack was Codex-unreachable in an earlier revision (its Codex match had no registered normalizer, so a matched call was dropped after recognition); a Codex Slack normalizer now exists (spec 256), closing that gap.
- **A locally-registered MCP server must be scoped by the server it reports, because its tool names are bare.** Every connector-app source's invocation-path match key is already server-qualified (`asana.get_task`, `atlassian_rovo.fetch`, `monday_com.get_board_items_page`), which makes it self-scoping. A local server's tool name carries no namespace at all — Jolli Memory's are `recall`, `search`, `get_decision_timeline` — and the invocation-path lookup is a single scan across every registered definition with no other qualifier. A definition registering bare names therefore also pins itself to a server name, compared against the server the end-of-call event reports; without that pin, any other locally-registered server exposing an identically-named tool would resolve to this source and its query text would be persisted here. The pin is optional per definition and can only ever reject, so every server-qualified source keeps its behaviour unchanged. The comparison **fails closed**: an event reporting no server matches no pinned definition, because mis-attributing a foreign lookup is worse than missing one.
- **Confluence's Codex path silently loses `space`/`author`.** The two producers hand the normalizer different envelopes: Claude's wrapped node carries `space`/`author` name objects, Codex's flat node carries only numeric IDs. A Codex-captured Confluence page therefore has `space` and `author` display fields undefined — deliberately blank rather than showing raw IDs. The core fields and `entity-type` are unaffected.
- **The ADF flattener is a shared producer-side reshape, not an engine transform.** Confluence page bodies and the Codex Jira description both arrive as Atlassian-Document-Format node trees; the declarative engine can only run a `(string) => string` transform, so a node-tree → plain-text flattener runs producer-side before the definition sees a string. It is analogous to the GitHub issue reshape.
- **Slack is url-required and reachable on both producers.** Unlike the other sources (whose url is required by a scheme/host constraint but always present in practice), Slack's url can genuinely be absent upstream, in which case the reference is voided on either producer (spec 256).
- **Zoom Meeting guards on a non-empty summary, and rides the redundant-event copy on Codex.** A meeting with no AI summary voids. On long meetings the primary Codex result copy is often malformed JSON; extraction still succeeds through the parser's redundant-event fallback, whose complete copy already carries the URLs — so, unlike Jira, no salvage/recover hook is needed.
- **Asana surfaces a deliberately minimal field set.** Section/project live under array-index paths the DSL cannot address and `completed` is a boolean the scalar coercion drops, so only the constant `entity-type` and the assignee name (an object subpath) are surfaced.
- **The body truncation cue and budget selection are shared, not per-source.** They live in the engine (spec 255); each definition only supplies the two cap numbers.
- **Context7 was the catalog's first arguments-derived source; Jolli Memory is the second.** Either source's reference is assembled entirely from the tool call's arguments — Context7's library id and question, Jolli Memory's tool and query — and the tool's actual returned payload is discarded by both producers' bindings and never read. This is why such a call whose result payload is unparseable still yields a reference (spec 153).
- **Context7 was the catalog's first track-only source; Jolli Memory is the second.** Either source's references are stored, archived, and displayed like any other, but never enter the summarization prompt and never enter the relevance ranker's input (specs 12, 258).
- **Jolli Memory is the catalog's only accumulate-body source.** Its native id is the tool rather than an entity, so successive lookups with one tool merge into a single reference whose body collects the queries asked, instead of the newest lookup overwriting the previous ones. The entry format, merge rule, and cap belong to spec 179; the decision to merge rather than discard at extraction belongs to spec 153.
- **Context7's declared render tags and budgets are unreachable dead configuration.** Both prompt-block call sites skip a track-only definition before rendering, so no `context7-libraries` block is emitted anywhere. The declarations are recorded for completeness only and must not be read as observable behavior.
- **A version-suffixed library id is carried whole.** The native-id constraint is a prefix match, so a library id with a third (version) segment satisfies it and flows unchanged into the native id, the title, and the url. There is no version display field and no stripping — a versioned and an unversioned lookup of the same library are two distinct references.
- **A library id with query, fragment, or dot-segment characters flows unescaped into the url.** Only the host-and-path prefix is pinned by the url constraint; there is no URL parse and no structural host check, so such a value is not voided. The pinned prefix is what keeps the resulting link on the Context7 host regardless.
- **The library-id-resolution companion tool is simply not a match.** It shares Context7's tool-name prefix but fails the accept-suffix, so recognition rejects it exactly as it rejects any unrelated tool. Nothing detects, special-cases, or explains it, and no other legacy documentation tool name is handled either.
- **Context7 is the only built-in whose native id is not path-safe besides GitHub.** Its library id contains slashes, so it joins GitHub on the replace-then-hash file-stem branch (spec 179) rather than the identity branch every other built-in uses.
- **Context7 carries no display fields at all.** It is the only built-in with an empty display-field list, so its references never have a fields block on disk and its rows never render field chips.

## Shared Behavior

- **The DSL op vocabulary, evaluation semantics, field-spec/guard mechanism, transform-registry security boundary, structural validator, render selection algorithm, the optional-destination-link allowance, and the three optional consumer flags' contract** are spec 255. This catalog only supplies the per-source data.
- **The consumer flags' downstream effects** are owned elsewhere: track-only's exclusion from the summarization prompt block is spec 12, its removal from the relevance ranker's input is spec 258, arguments-derived's empty-payload allowance in the envelope parsers is spec 153, accumulate-body's body lift and merge-instead-of-discard collapse is spec 153 with the merge rule and entry format in spec 179, and the explanatory note the first two flags trigger on the persisted markdown is spec 179.
- **Transcript envelope parsing, source recognition, the payload-tree walk, cross-record dedupe, and per-payload error containment** are spec 153.
- **On-disk persistence, native-id path sanitization (driven by each definition's `storage.nativeIdPathSafe`), and the lenient-vs-strict source-id checks** are spec 179.
- **Slack's capture, permalink harvesting, workspace-URL reconstruction, and dual-producer reachability** are spec 256.
- **Prompt-block strings feed the summarization prompt** via an upstream caller; the empty-string return is the "contributes nothing" protocol.
- **Produced records persist downstream** and are later snapshotted onto a commit; the short content-hash suffix is appended at the persistence layer (spec 179), never in the map key emitted here.
