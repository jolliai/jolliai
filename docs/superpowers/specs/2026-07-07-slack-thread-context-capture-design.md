# Slack Thread Context Capture Design

- **Date**: 2026-07-07
- **Status**: Design under review
- **Goal**: Capture Slack **discussion threads** (parent message + replies) that an AI agent reads via the Slack MCP server during a session, turning each thread into a `Reference` that is injected into Working Memory (the SUMMARIZE prompt) and stored alongside the existing Linear / Jira / GitHub / Notion references.
- **Relationship to JOLLI-1877**: This is a **separate new feature**, not part of JOLLI-1877 (the source-definition consolidation). It *builds on* that work (the `SourceDefinition` / `SourceEngine` / envelope architecture) and needs its own Linear issue.

---

## 1. Background & the fit problem

JOLLI-1877 established a reference pipeline: an **Envelope** layer recognizes an MCP tool call + return payload in a transcript line, a **`SourceDefinition`** (declarative) describes how to extract a `Reference`, and the **`SourceEngine`** evaluates it. Adding a well-shaped source (issue-like entity with a stable `nativeId`/`title`/`url`/`description`) is now one definition file.

Slack does **not** fit that happy path, for three verified reasons (all checked against real MCP payloads on 2026-07-07):

1. **The result is a text blob, not structured data.** `slack_read_thread` returns `{ messages: "<one big formatted string>", pagination_info }`. There are no per-field JSON keys — author / time / ts / text are baked into human-readable text (`=== THREAD PARENT MESSAGE ===`, `--- Reply N of M ---`, `Message TS: …`).
2. **No `url` anywhere in the result.** Slack's underlying `conversations.replies` API does not return message permalinks, and the MCP wrapper does not add them. A thread permalink is `https://<workspace>.slack.com/archives/<channelId>/p<parentTs>` — buildable only from workspace (config) + channelId + parentTs.
3. **No `channelId` in the thread result either.** The thread blob contains only per-message `From / Time / Message TS / text`. The `channelId` exists **only in the tool-call input** (`{ channel_id, message_ts }`), which the envelope currently **discards** for MCP calls (`normalize: identity`, input not retained).

So the permalink's three inputs come from three different places: `workspace` = **config**, `channelId` = **tool_use input**, `parentTs` = **result blob**.

### Real captured payload (the pinned fixture, verified today)

```
{"messages":"=== THREAD PARENT MESSAGE ===\nFrom: Flyer Li <…> (U0BGFSM16DN)\nTime: 2026-07-07 16:46:24 CST\nMessage TS: 1783413984.700009\nConsolidate the existing Linear / Jira / GitHub / Notion …\n\n=== THREAD REPLIES (2 total) ===\n\n--- Reply 1 of 2 ---\nFrom: … (U0BGFSM16DN)\nTime: 2026-07-07 17:18:37 CST\nMessage TS: 1783415917.422609\nConfig-driven MCP integration\n\n--- Reply 2 of 2 ---\nFrom: … (U0BGFSM16DN)\nTime: 2026-07-07 17:23:48 CST\nMessage TS: 1783416228.715669\nHow to do?\n","pagination_info":"There are no more messages in this thread.\n"}
```

## 2. Decisions (from brainstorming)

| Decision point | Choice | Rationale |
|---|---|---|
| Capture unit | **Thread** (parent + replies), one thread → one `Reference` | Bounded discussion unit with a stable permalink; best fit for the issue/document-shaped `Reference` model |
| Trigger tool | **`slack_read_thread` only** (v1) | Channel reads (`slack_read_channel`) and `slack_search_public` are **out of scope for v1** — a channel is a stream, not a titled entity; search returns fragments |
| `url` source | **Construct from a configured workspace URL** + channelId + parentTs | The only reliable way to a working permalink; payload permalink doesn't exist, and dropping the link loses half the value |
| Missing config | **Degrade, do not disable** | Content is still captured (title + thread body + fields); only the clickable link is missing, and the UI prompts the user to configure `slack.workspaceUrl` |
| Where the messy work lives | **Code-side `normalize`** (blob parse + input merge + permalink build); DSL definition only selects fields | Matches JOLLI-1877's philosophy: "normalize/recover stays as code; the DSL sees the canonical payload." Concentrates brittle parsing in one testable function |
| Config-needed hint | **UI-only** (VS Code panel), never in the Reference data / SUMMARIZE prompt | Capture is headless (post-commit worker); a hint in `fields`/`description` would pollute the LLM prompt |

### Explicitly NOT config-driven

Because Slack needs a code-side `normalize` (blob parsing + config injection), it is a **built-in source** on par with GitHub/Jira. It can **never** be added via Phase-2 zero-code user config — it is not "one config rule." This must be stated so it isn't mistaken for a declarative-only source.

## 3. Data model — one thread → one `Reference`

| `Reference` field | Value | Source |
|---|---|---|
| `mapKey` / `nativeId` | `slack:<channelId>-<parentTs>` / `<channelId>-<parentTs>` (e.g. `C0BFF9UHBD1-1783413984.700009`) | channelId (tool input) + parentTs (result blob) |
| `title` | Parent message first line, truncated (e.g. "Consolidate the existing Linear / Jira / GitHub…") | result blob |
| `url` | `https://<workspace>/archives/<channelId>/p<parentTs-without-dot>` **when configured; otherwise absent** | config + input + blob |
| `description` | Full thread text (parent + all replies, with author/time), lightly cleaned | result blob |
| `fields[]` | `entity-type=thread`, `replies=<N>`, `channel=<channelId>` | blob + input |
| `referencedAt` | transcript timestamp | envelope |

**Path safety**: `nativeId` = `<channelId>-<parentTs>` contains only `\w . -` (the ts dot is allowed by `[^\w.-]`), no `/`, no `..` → `storage.nativeIdPathSafe: true` (identity, the `..`/`/\` guard passes).

**No channel name**: the thread blob has no `#channel-name` (only channel-read does), so `title` uses the parent text, not `#channel`.

## 4. Architecture (5 changes; reference pipeline otherwise untouched)

```
transcript ──▶ ClaudeEnvelopeParser
                 · [①] MCP branch also retains tool_use.input (for channelId)
                 · [②] passes { toolInput, config } to a per-def normalize
                 │      (today the Claude-MCP path is hardcoded normalize: identity)
                 │  NormalizedToolResult{ def, payload = normalize(rawResult, {toolInput, config}) }
                 ▼
              SourceEngine.extractRef(slackDef, canonicalPayload)   ← DSL only selects fields
                 · [④] `url` respects FieldSpec.optional (was hard-required)
                 ▼
              Reference → ReferenceStore → assembleReferenceBlocks / renderBlock   ← unchanged
                 ▼
              [⑤] VS Code panel: slack ref without url + workspaceUrl unset → inline config hint + one-time toast
```

### The change set

1. **Envelope: thread the MCP `tool_use.input` through.** Today `collectToolUses`'s MCP branch stores only `{ toolName, def, normalize: identity }`. Retain the tool_use `input` object and carry it on `NormalizedToolResult` (or hand it to `normalize`). This is the same capability the CLI/shell path already uses (`readCommand(b.input)`); it just wasn't wired for MCP.
2. **Open the Claude-MCP `normalize` seam.** Extend the `normalize` signature from `(business) => unknown` to `(business, ctx: { toolInput?: unknown; config: JolliConfig }) => unknown`. Existing Codex/CLI callers ignore `ctx` (backward compatible). The Slack definition's source registers a real `normalize`.
3. **`SlackNormalize.ts` (code) + `slack.ts` (definition).** `SlackNormalize` parses the blob (defensively) into a canonical object `{ channelId, parentTs, title, text, replyCount, permalink? }`, merging `channelId` from `toolInput` and building `permalink` from `config.slack.workspaceUrl` (omitted when unset). `slack.ts` is a trivial `path`-only definition over that canonical shape.
4. **Engine: `url` respects `optional`.** `extractRef` currently hard-voids when `url` is missing ([SourceEngine.ts:158-159](../../../cli/src/core/references/SourceEngine.ts)). Change it to evaluate `url` through the same optional-aware path as `description`. The other 4 definitions do **not** set `url.optional`, so they remain hard-required — behavior unchanged.
5. **VS Code config-needed hint (UI-only).** When the panel renders a `source === "slack"` reference whose `url` is empty and `config.slack.workspaceUrl` is unset, show an inline "configure `slack.workspaceUrl` to enable jump-to-thread" hint with a settings deep-link, plus a one-time toast on first occurrence. No data-model or prompt change.

## 5. Config schema

Machine-global `~/.jolli/jollimemory/config.json` (Slack workspace is user/machine-level, shared across repos):

```jsonc
{ "slack": { "workspaceUrl": "https://flyer-q4r7867.slack.com" } }
```

- **Save-time validation** (mirrors the repo's origin-allowlist discipline): `https://` only, host must end with `.slack.com`.
- **Unset ≠ disabled**: capture still runs; `permalink` is omitted, the `Reference` is still produced (url absent), and the VS Code hint fires. Setting `slack.workspaceUrl` upgrades subsequent captures to include a working link.

## 6. Rendering / injection

No engine change — the existing slot vocabulary covers it:

```jsonc
"render": { "wrapperTag": "slack-threads", "itemTag": "thread", "bodyTag": "messages",
            "fieldAttrs": true, "maxCharsPerReference": 8000, "maxTotalChars": 40000 }
```

Injection reuses `assembleReferenceBlocks` (bucketed by source, `registry.all()` order). VS Code `SOURCE_META` gains one row: `slack: { label: "Slack", letter: "S", icon: "comment-discussion", color: "#4a154b" }`.

## 7. Testing (real fixtures, defensive parsing)

1. **Pinned real fixture**: the 2026-07-07 `slack_read_thread` blob above (parent + 2 replies). `SlackNormalize` unit test asserts the canonical object; a GoldenParity-style test asserts the final `Reference` + rendered `<slack-threads>` block.
2. **Config matrix**: workspaceUrl set → `url` present; unset → `Reference` still produced with `url` absent (does NOT void).
3. **Defensive parsing**: malformed / format-drifted blob → `normalize` returns a shape that voids (never throws). `replies (N total)` count parse, `Message TS:` extraction, first-reply detection.
4. **Envelope test**: `tool_use.input.channel_id` is threaded through to `normalize`.
5. **Engine test**: a definition with `url.optional: true` produces a `Reference` without url; the 4 existing definitions (no `optional`) still void on missing url.
6. **Coverage**: hold 97/96/97/97; batch `npm run all` + commit at the end.

## 8. Pre-implementation verification gates

Confirm against real data **before** writing the plan (the JOLLI-1877 "Confirm before writing the plan" discipline):

1. ✅ **Real `slack_read_thread` payload shape** — captured 2026-07-07; pinned as fixture.
2. ⚠️ **Blob text format stability** — only one real sample so far. The format (`=== THREAD PARENT MESSAGE ===`, `--- Reply N of M ---`, `THREAD REPLIES (N total)`, `Message TS:`) is defined by the MCP wrapper (human-facing text, not a stable API schema). `normalize` MUST be defensive: unparseable → void, never throw. Capture a second real thread if possible.
3. **tool_use input keys** — confirm a real Claude Code transcript records the input under `input` with keys `channel_id` / `message_ts`.
4. **Scope** — `slack_read_channel` / `slack_search_public` confirmed OUT of v1.

## 9. Out of scope (future)

- Channel-snapshot capture (`slack_read_channel`) and search-result capture.
- IntelliJ panel parity for the config-needed hint (VS Code first).
- Per-repo (vs machine-global) workspace override.
- Auto-resolving the permalink via a `chat.getPermalink`-style call (avoids needing configured workspace) — rejected for v1 (extra round-trip, not available through the current MCP tool set).
