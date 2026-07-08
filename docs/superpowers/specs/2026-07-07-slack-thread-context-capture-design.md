# Slack Thread Context Capture Design

- **Date**: 2026-07-07 (revised 2026-07-08: permalink-anchored model)
- **Status**: Design under review
- **Goal**: Capture Slack **discussion threads** (parent message + replies) that an AI agent reads via the Slack MCP server during a session, turning each thread into a `Reference` injected into Working Memory (the SUMMARIZE prompt) and stored alongside the existing Linear / Jira / GitHub / Notion references.
- **Relationship to JOLLI-1877**: A **separate new feature**, not part of JOLLI-1877 (source-definition consolidation). It builds on that architecture (`SourceDefinition` / `SourceEngine` / envelope) and needs its own Linear issue.

---

## 1. Background & the fit problem

JOLLI-1877 established a reference pipeline: an **Envelope** layer recognizes an MCP tool call + return payload in a transcript line; a declarative **`SourceDefinition`** describes how to extract a `Reference`; the **`SourceEngine`** evaluates it. Adding an issue-shaped source (stable `nativeId`/`title`/`url`/`description`) is one definition file.

Slack does not fit that happy path, for reasons verified against **real MCP payloads and the real session transcript** (2026-07-07/08):

1. **The result is a text blob, not structured data.** `slack_read_thread` returns `{ messages: "<one formatted string>", pagination_info }`; author / time / ts / text are baked into human-readable text (`=== THREAD PARENT MESSAGE ===`, `--- Reply N of M ---`, `Message TS: …`).
2. **No `url` and no `channelId` in the result.** The thread blob has only per-message `From / Time / Message TS / text`. Slack's `conversations.replies` returns no permalinks, and the MCP wrapper adds none.
3. **But the user pastes a full permalink.** The observed workflow: the user types a thread permalink into the conversation — `https://flyer-q4r7867.slack.com/archives/C0BFF9UHBD1/p1783413984700009` — which contains **everything**: workspace `flyer-q4r7867`, channel `C0BFF9UHBD1`, parent ts `1783413984.700009`. Claude then derives `channel_id`/`message_ts` from it to call `slack_read_thread`.

**This reframes the capture anchor**: the source of the identity + link is the **user-pasted permalink in the transcript**, not the tool result. The tool result supplies only the body. No workspace config is required.

### Verified facts (real session transcript `…/ca9cb9b2-….jsonl`, 2026-07-08)

- `slack_read_thread` tool_use input keys are exactly `{"channel_id":"C0BFF9UHBD1","message_ts":"1783413984.700009"}`.
- The permalink appears verbatim in `role: user` message text.
- Permalink `(channel, ts)` **exactly equals** the tool_use input `(channel_id, message_ts)` → correlation is sound.
- ⚠️ The permalink also appears in a `"type":"last-prompt"` metadata line — the scanner must read **only `role:user` `message.content` text blocks**, or the same thread is captured twice.

## 2. Decisions (from brainstorming)

| Decision point | Choice | Rationale |
|---|---|---|
| Capture unit | **Thread** (parent + replies), one thread → one `Reference` | Bounded discussion unit; fits the issue/document-shaped model |
| **Capture anchor** | **The user-pasted Slack permalink** in `role:user` text | It carries workspace + channel + ts; makes `url` authoritative and config-free |
| Trigger for the body | **`slack_read_thread`** result, correlated to the permalink by `(channel, ts)` | Supplies the thread text; `slack_read_channel` / `slack_search_public` are OUT of v1 |
| `url` source (priority) | **① pasted permalink (primary, zero-config) → ② `config.slack.workspaceUrl` reconstruction (fallback) → ③ degrade** | Permalink is present in the real workflow; config only matters when no permalink was pasted |
| Missing all url sources | **Degrade, not disable** | Body still captured (title + thread text + fields); UI prompts to set `slack.workspaceUrl` |
| Where the messy work lives | **Code-side `normalize`** parses the body blob only (url now comes from the permalink) | Matches JOLLI-1877: "normalize stays as code; DSL sees the canonical payload" |
| Config-needed hint | **UI-only** (VS Code panel), never in Reference data / SUMMARIZE prompt | Capture is headless; a hint in `fields`/`description` would pollute the LLM prompt |

### Explicitly NOT config-driven

Slack needs a code-side `normalize` (blob parsing) **and** a new transcript-scanning channel, so it is a **built-in source** like GitHub/Jira — it can never be added via Phase-2 zero-code user config. Not "one config rule."

## 3. Data model — one thread → one `Reference`

| `Reference` field | Value | Source |
|---|---|---|
| `mapKey` / `nativeId` | `slack:<channelId>-<parentTs>` / `<channelId>-<parentTs>` (e.g. `C0BFF9UHBD1-1783413984.700009`) | permalink (channel, ts) |
| `title` | Parent message first line, truncated | body blob |
| `url` | The pasted permalink verbatim; else reconstructed from `config.slack.workspaceUrl` + channel + ts; else **absent** | ① permalink → ② config |
| `description` | Full thread text (parent + replies, with author/time), lightly cleaned | body blob |
| `fields[]` | `entity-type=thread`, `replies=<N>`, `channel=<channelId>` | blob + permalink |
| `referencedAt` | transcript timestamp | envelope |

**Path safety**: `nativeId` = `<channelId>-<parentTs>` contains only `\w . -` (ts dot allowed), no `/`, no `..` → `storage.nativeIdPathSafe: true` (identity; the `..`/`/\` guard passes).

**No channel name** in the thread blob, so `title` uses the parent text, not `#channel`.

## 4. Architecture (permalink-anchored)

```
transcript
  ├─ [①] scan role:user message.content TEXT blocks for  *.slack.com/archives/<ch>/p<ts>
  │        → permalinkMap keyed by (channel, ts):  { url, workspace, channel, parentTs }
  │        (read ONLY role:user text blocks — not "last-prompt" metadata, not tool results)
  │
  └─ ClaudeEnvelopeParser  (slack_read_thread tool_use/tool_result)
        · [②] retain tool_use.input {channel_id, message_ts}  (correlation key)
        · [③] normalize(rawResultBlob) → { parentTs, title, text, replyCount }   (body only)
             │
             ▼  correlate on (channel_id/message_ts) == permalinkMap key
        SourceEngine.extractRef(slackDef, { ...body, channelId, url? })  ← DSL selects fields
             · [④] `url` respects FieldSpec.optional (was hard-required)
             ▼
        Reference → ReferenceStore → assembleReferenceBlocks / renderBlock   (unchanged)
             ▼
        [⑤] VS Code panel: slack ref with no url + workspaceUrl unset → inline hint + one-time toast
```

### The change set

1. **New: scan `role:user` message text for Slack permalinks.** A small pre-pass (or an added branch in the Claude envelope) that reads **only** `role:user` `message.content` text blocks, extracts `*.slack.com/archives/<channel>/p<ts>` permalinks, and builds a map keyed by `(channel, ts)`. Deliberately excludes `"type":"last-prompt"` lines and tool-result content to avoid duplicate capture (verified real risk).
2. **Retain the `slack_read_thread` tool_use input** `{channel_id, message_ts}` as the correlation key (the envelope discards MCP input today).
3. **`SlackNormalize.ts` (code) + `slack.ts` (definition).** `SlackNormalize` defensively parses the body blob into `{ parentTs, title, text, replyCount }`. The permalink-derived `url` + `channelId` are merged in at correlation time. `slack.ts` is a `path`-only definition over that canonical shape.
4. **Engine: `url` respects `optional`.** `extractRef` hard-voids on missing `url` today ([SourceEngine.ts:158-159](../../../cli/src/core/references/SourceEngine.ts)); change it to evaluate `url` via the same optional-aware path as `description`. The other 4 definitions omit `url.optional`, so they stay hard-required — behavior unchanged.
5. **VS Code config-needed hint (UI-only).** When the panel renders a `source === "slack"` reference with empty `url` and `config.slack.workspaceUrl` unset, show an inline "configure `slack.workspaceUrl` to enable jump-to-thread" hint + settings deep-link, plus a one-time toast. No data-model / prompt change.

### Correlation & fallback

- Match permalink `(channel, ts)` ↔ tool_use input `(channel_id, message_ts)`. On match: `url` = pasted permalink (authoritative), body = normalized result.
- **No permalink, config set**: reconstruct `url` from `config.slack.workspaceUrl` + `channelId` (input) + `parentTs` (body).
- **No permalink, no config**: `Reference` still produced with `url` absent → UI hint.

## 5. Config schema (fallback only)

Machine-global `~/.jolli/jollimemory/config.json`:

```jsonc
{ "slack": { "workspaceUrl": "https://flyer-q4r7867.slack.com" } }
```

- **No longer the primary path** — only used when no permalink was pasted in the session.
- **Save-time validation**: `https://` only, host ends with `.slack.com`.
- Optional to set; the permalink workflow makes it unnecessary in the common case.

## 6. Rendering / injection

No engine change — the slot vocabulary covers it:

```jsonc
"render": { "wrapperTag": "slack-threads", "itemTag": "thread", "bodyTag": "messages",
            "fieldAttrs": true, "maxCharsPerReference": 8000, "maxTotalChars": 40000 }
```

Injection reuses `assembleReferenceBlocks` (bucketed by source, `registry.all()` order). VS Code `SOURCE_META` gains: `slack: { label: "Slack", letter: "S", icon: "comment-discussion", color: "#4a154b" }`.

## 7. Testing (real fixtures)

1. **Pinned real fixtures** (both captured this session): the `slack_read_thread` body blob (parent + 2 replies) and the pasted permalink. `SlackNormalize` unit test asserts the canonical body object; a GoldenParity-style test asserts the correlated `Reference` (url = permalink) + rendered `<slack-threads>` block.
2. **Correlation**: permalink `(channel, ts)` == tool input → url from permalink. Permalink absent + config set → reconstructed url. Both absent → `Reference` produced with url absent (does NOT void).
3. **Duplicate-guard**: a permalink present in both a `role:user` text block and a `"last-prompt"` line yields **one** Reference, not two.
4. **Defensive parsing**: malformed / format-drifted body blob → `normalize` voids (never throws).
5. **Engine**: a definition with `url.optional: true` produces a Reference without url; the 4 existing definitions still void on missing url.
6. **Coverage**: hold 97/96/97/97; batch `npm run all` + commit at the end.

## 8. Pre-implementation verification gates

1. ✅ **Real `slack_read_thread` payload shape** — captured; pinned fixture.
2. ⚠️ **Body-blob format stability** — one real sample; format is MCP-wrapper text, not a stable schema. `normalize` MUST be defensive (unparseable → void, never throw). Capture a second real thread if possible.
3. ✅ **tool_use input keys + permalink-in-user-text + correlation** — verified against the real session transcript (§1). Duplicate-across-line-types risk identified and handled by change #1.
4. ✅ **Scope** — `slack_read_channel` / `slack_search_public` OUT of v1.

## 9. Out of scope (future)

- Channel-snapshot and search-result capture.
- IntelliJ panel parity for the config-needed hint.
- Per-repo workspace override.
- Harvesting the workspace from a permalink to **auto-seed** `config.slack.workspaceUrl` for later permalink-free captures (a natural extension of change #1; deferred to keep v1 focused).
