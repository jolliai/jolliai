# Zoom Meeting & Doc Context Capture Design

- **Date**: 2026-07-08
- **Status**: Design under review
- **Goal**: Capture Zoom **meeting assets** (AI summary + next steps) and **Zoom Hub docs** that an AI agent reads via the Zoom for Claude MCP server during a session, turning each into a `Reference` injected into Working Memory (the SUMMARIZE prompt) and stored alongside the existing Linear / Jira / GitHub / Notion references.
- **Relationship to prior work**: A **separate new feature** that builds on JOLLI-1877 (the `SourceDefinition` / `SourceEngine` / envelope architecture). It is the direct analog of the [Slack Thread Context Capture design](2026-07-07-slack-thread-context-capture-design.md); the Slack work is landing the shared Claude-MCP `normalize` seam that `zoom-doc` depends on, and Zoom mirrors that implementation rather than re-deriving it.

---

## 1. Background & the fit assessment

JOLLI-1877 established a reference pipeline: an **Envelope** layer recognizes an MCP tool call + return payload in a transcript line, a **`SourceDefinition`** (declarative, data-only, 7-op DSL) describes how to extract a `Reference`, and the **`SourceEngine`** evaluates it. The reference pipeline is **not an MCP client** — it replays the tool call + result that Claude Code / Codex already recorded in its on-disk transcript JSONL. The interactively-authenticated `claude.ai` Zoom connector therefore cannot be called headlessly by Jolli; the only supported ingestion path is: agent calls `mcp__claude_ai_Zoom_for_Claude__*` during a session → the call + payload land in the transcript → a Zoom `SourceDefinition` extracts it.

Two Zoom tools are in scope, and they sit at **opposite ends** of the fit spectrum:

- **`get_meeting_assets`** — a **well-shaped, structured JSON** payload with a stable `meeting_uuid` / `topic` / `summary_doc_url` in the result. It is the happy path: a **pure-DSL definition, zero engine change**, on par with `notion.ts`.
- **`hub_get_file_content`** — a **partial** payload: the result is only `{ file_name, file_content }`. The document's `fileId` (needed for both `nativeId` and the doc URL) exists **only in the tool-call input**, which the envelope currently discards for MCP calls (`normalize: identity`). This is the same "input not retained" gap Slack hit, and it needs the shared Claude-MCP `normalize` seam.

**Why Zoom is simpler than Slack:** Slack needed three things Zoom does not — a configured workspace URL (Zoom's doc URL is `https://docs.zoom.us/doc/<fileId>`, derivable from the input alone), an `optional`-url engine change (both Zoom tools stably produce a URL), and a VS Code config-needed hint. Zoom reuses only Slack's input-threading seam.

---

## 2. Decisions (from brainstorming)

| Decision point | Choice | Rationale |
|---|---|---|
| Definition granularity | **Two independent sources**: `zoom-meeting` + `zoom-doc` | Heterogeneous payloads, different render buckets, and only `zoom-doc` needs a `normalize`. Keeps `zoom-meeting` decoupled from the Slack seam. Mirrors the single-tool `acceptSuffix` pattern of `notion.ts`. |
| `zoom-meeting` body | **AI summary only** (`meeting_summary.summary_markdown`) | The summary already carries Quick recap + Next steps (the distilled, high-value content). The full transcript is an **object array** (`transcript_items[{start,text,end}]`) the DSL cannot join, would force a `normalize` onto the otherwise-pure-DSL meeting source, balloons context/token cost, and risks JSONL truncation. |
| `zoom-doc` `url` source | **Construct `https://docs.zoom.us/doc/<fileId>` from the tool-call input** | The result has no id; `fileId` is in the input. Unlike Slack, **no config** is needed — the public doc URL is a pure function of `fileId`. |
| Where the messy work lives (`zoom-doc`) | **Code-side `normalize`** (merge `fileId` from input + build url); DSL definition only selects fields | Matches JOLLI-1877's philosophy: normalize stays as code, the DSL sees the canonical payload. |
| Shared seam ownership | **Consume the Claude-MCP `normalize` seam delivered by the Slack work**; do not re-implement | Avoids two divergent implementations of the same envelope change. |
| Sequencing | **Phase 1 = `zoom-meeting` (independent, ship now); Phase 2 = `zoom-doc` (after the Slack seam lands)** | `zoom-meeting` has zero dependency and proves the source end-to-end immediately. |

### Explicitly NOT in scope

- **No config schema.** (Contrast Slack's `slack.workspaceUrl`.)
- **No `url`-optional engine change.** Both tools stably produce a URL; the other definitions stay hard-required, unchanged.
- **No VS Code config-needed hint / toast.**
- **Meeting transcript, participants, whiteboards, agenda_doc, recording** capture — out of scope. Only the AI summary is captured for meetings.
- **`search_meetings` / `search_zoom` / `get_recording_resource` / `recordings_list`** — not reference-producing triggers in v1 (list/search return candidates and fragments, not a single titled entity; recordings are unused in practice — see Observed Reality).

---

## 3. Data model

### 3a. `zoom-meeting` (one meeting → one `Reference`)

| `Reference` field | Value | Source |
|---|---|---|
| `mapKey` / `nativeId` | `zoom-meeting:<meeting_uuid>` / `<meeting_uuid>` (e.g. `25955010-93C3-48E7-9F25-9D98CE6B69F7`) | result |
| `title` | `topic` | result |
| `url` | `coalesce(meeting_summary.summary_doc_url, deep_url)`, require `^https://` | result |
| `description` | `meeting_summary.summary_markdown`, optional | result |
| `fields[]` | `entity-type=meeting`, `started=<start_time>`, `meeting-number=<meeting_number>` | result |
| `referencedAt` | transcript timestamp | envelope |

- **Guard**: `meeting_summary.has_summary === true` — a meeting instance with no AI summary (e.g. the empty PMI instance seen in Observed Reality) voids, so we never store an empty-bodied meeting reference.
- **Path safety**: `meeting_uuid` is hex + `-` only → `storage.nativeIdPathSafe: true` (identity, `..`/`/\` guard passes).
- **Pure DSL** — no `normalize`. Depends on nothing outside the merged JOLLI-1877 engine.

### 3b. `zoom-doc` (one Hub doc read → one `Reference`)

| `Reference` field | Value | Source |
|---|---|---|
| `mapKey` / `nativeId` | `zoom-doc:<fileId>` / `<fileId>` (e.g. `y_sTD3ZsQv-o-f2pw3IQCA`) | **tool input** |
| `title` | `file_name` | result |
| `url` | `https://docs.zoom.us/doc/<fileId>` | input (constructed) |
| `description` | `file_content`, optional | result |
| `fields[]` | `entity-type=doc` | const |
| `referencedAt` | transcript timestamp | envelope |

- **Path safety**: `fileId` (`y_sTD3ZsQv-o-f2pw3IQCA`) matches `[\w.-]+` → `storage.nativeIdPathSafe: true`.
- **Needs `normalize`** (`ZoomDocNormalize`): the canonical shape is `{ fileId, title, content, url }`, merging `fileId` from `toolInput`; `zoom-doc.ts` is then a trivial `path`-only definition over that shape.

---

## 4. Architecture & change set

```
transcript ──▶ ClaudeEnvelopeParser
                 · zoom-meeting: matched by acceptSuffix "get_meeting_assets", normalize: identity  (Phase 1)
                 · zoom-doc:     matched by acceptSuffix "hub_get_file_content";
                                 [SHARED SEAM, from Slack work] MCP branch retains tool_use.input and
                                 hands it to a per-def normalize (getClaudeNormalizer)                (Phase 2)
                 ▼
              SourceEngine.extractRef(def, canonicalPayload)   ← DSL only selects fields (unchanged)
                 ▼
              Reference → ReferenceStore → assembleReferenceBlocks / renderBlock   ← unchanged
```

### Phase 1 — `zoom-meeting` (independent)

1. **`cli/src/core/references/sources/definitions/zoom-meeting.ts`** — a pure-DSL `SourceDefinition`:
   - `match: { claude: { prefixes: ["mcp__claude_ai_Zoom_for_Claude__"], acceptSuffix: "get_meeting_assets" } }`
   - `wrapperKeys: []` (the payload is a single meeting object, not a list)
   - `reference`: guard (`has_summary`), `nativeId`/`title`/`url`/`description` per §3a; `fields` per §3a
   - `storage: { nativeIdPathSafe: true }`
   - `render: { wrapperTag: "zoom-meetings", itemTag: "meeting", bodyTag: "summary", maxCharsPerReference: 20000, maxTotalChars: 40000 }`
2. **Register** in `sources/definitions/index.ts` `BUILTIN_DEFINITIONS`.
3. **VS Code `SOURCE_META`** gains one row: `"zoom-meeting": { label: "Zoom Meeting", letter: "Z", icon: "device-camera-video", color: "#2D8CFF" }`.
4. **Codex parity** (`match.codex`): out of scope for v1 unless the Codex Zoom tool naming is confirmed against a real Codex rollout — Claude Code only for v1.

### Phase 2 — `zoom-doc` (after the Slack shared seam lands)

5. **Consume the shared Claude-MCP `normalize` seam** delivered by the Slack work (envelope retains `tool_use.input`; per-def `getClaudeNormalizer` registry under `bindings/claude/`). Mirror that implementation; do not fork it.
6. **`cli/src/core/references/bindings/claude/ZoomDocNormalize.ts`** — defensively parses `{ file_name, file_content }` + merges `fileId` from `toolInput`, builds `url`, returns `{ fileId, title, content, url }`; unparseable / missing `fileId` → returns a shape that voids (never throws). Register in the `getClaudeNormalizer` map (`zoom-doc → zoomDocNormalize`).
7. **`cli/src/core/references/sources/definitions/zoom-doc.ts`** — `path`-only DSL over the canonical shape; `acceptSuffix: "hub_get_file_content"`; `render: { wrapperTag: "zoom-docs", itemTag: "doc", bodyTag: "content", maxCharsPerReference: 30000, maxTotalChars: 60000 }`.
8. **VS Code `SOURCE_META`** gains `"zoom-doc": { label: "Zoom Doc", letter: "Z", icon: "file", color: "#2D8CFF" }`.

Everything downstream (`ReferenceStore`, `plans.json.references`, orphan snapshot, `assembleReferenceBlocks`, `Regenerator`, folder storage) is already generic and needs **no change**.

---

## 5. Rendering / injection

No engine change — the existing slot vocabulary covers both:

```jsonc
// zoom-meeting
"render": { "wrapperTag": "zoom-meetings", "itemTag": "meeting", "bodyTag": "summary",
            "maxCharsPerReference": 20000, "maxTotalChars": 40000 }
// zoom-doc
"render": { "wrapperTag": "zoom-docs", "itemTag": "doc", "bodyTag": "content",
            "maxCharsPerReference": 30000, "maxTotalChars": 60000 }
```

Injection reuses `assembleReferenceBlocks` (bucketed by source, `registry.all()` order).

---

## 6. Observed Reality (real payloads captured 2026-07-08)

Captured live via the `claude.ai` Zoom for Claude connector. These are the pinned fixtures.

### `recordings_list` — **empty in practice**

`{ "total_records": 0, "meetings": [] }`. This org does not use Zoom **cloud recordings**; meeting knowledge lives entirely in **AI summaries + transcripts**. Any design keyed on "recording" artifacts would find nothing. (This is the exact class of at-rest assumption the integrating-external-systems skill warns about.)

### `get_meeting_assets` (input `meetingId = "JZVQEJPDSOefJZ2Yzmtp9w=="`)

Key shape (trimmed):

```jsonc
{
  "meeting_summary": {
    "summary_markdown": "## Quick recap\n…\n## Next steps\n…",
    "summary_plain_text": "…",
    "has_permission": true,
    "has_summary": true,
    "summary_doc_url": "https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA"
  },
  "meeting_transcript": {
    "transcript_items": [ { "start": "00:00:50.000", "text": "…", "end": "00:00:52.000" }, … ],
    "primary_language": "en"
  },
  "my_notes": { "has_my_notes": false },
  "meeting_type": 4,
  "meeting_number": 4456640966,
  "deep_url": "https://jolli.zoom.us/launch/edl?muid=…",
  "start_time": "2026-06-16T02:19:12Z",
  "end_time": "2026-06-16T02:26:41Z",
  "meeting_uuid": "25955010-93C3-48E7-9F25-9D98CE6B69F7",
  "topic": "Flyer Li's Personal Meeting Room",
  "meeting_category": "history"
}
```

Pitfalls captured:
- **Two ID forms coexist.** The input `meetingId` is the base64 form (`JZVQEJPDSOefJZ2Yzmtp9w==`); the result's `meeting_uuid` is the canonical `25955010-…`. `nativeId` uses the **result's `meeting_uuid`** (self-contained, no input needed).
- **`transcript_items` is an object array** — not DSL-joinable (drives the "summary only" decision).
- **`summary_doc_url` is present only when `has_summary`**; `deep_url` is always present → `url` coalesces the two.
- **Permission is per-field.** `has_summary_permission` / `has_transcript_permission` vary per meeting (see `search_meetings`); `meeting_summary.has_permission` gates summary access. The guard (`has_summary`) already voids no-summary payloads.

### `hub_get_file_content` (input `fileId = "y_sTD3ZsQv-o-f2pw3IQCA"`, `format = "markdown"`)

```jsonc
{ "file_name": "Flyer Li's Personal Meeting Room",
  "file_content": "## Quick recap\n…" }
```

Pitfall captured: **the result contains no `fileId`.** `fileId` exists only in the tool-call **input** → `zoom-doc` requires the shared input-threading seam, and `url` is built as `https://docs.zoom.us/doc/<fileId>`. Doc content is bounded at 100 KB by the tool itself.

### `search_meetings` / `search_zoom` (reference only, not v1 triggers)

`search_meetings` returns a meeting list with `meeting_uuid`, `topic`, `attendees[{user_name}]`, `has_summary`, `has_transcript`, `has_summary_permission`, `next_page_token`. `search_zoom` (zoom_doc) returns `{ file_id, title, link, file_type, ancestors[], create_time, modify_time }`. Recorded for completeness; not consumed in v1.

---

## 7. Testing (real fixtures, defensive parsing)

1. **Pinned real fixtures**: the two payloads in §6. `zoom-meeting` — a GoldenParity-style test asserts the final `Reference` + rendered `<zoom-meetings>` block. `zoom-doc` — a `ZoomDocNormalize` unit test asserts the canonical object, then the `Reference` + `<zoom-docs>` block.
2. **Guard matrix (`zoom-meeting`)**: `has_summary: false` (the empty PMI instance) → voids, no reference produced.
3. **URL coalesce (`zoom-meeting`)**: `summary_doc_url` present → used; absent (no summary but reference forced) → falls back to `deep_url`. (Guard normally prevents the no-summary case; test the coalesce directly.)
4. **Envelope test (`zoom-doc`, Phase 2)**: `tool_use.input.fileId` is threaded through to `normalize`; url built correctly.
5. **Defensive parsing (`zoom-doc`)**: missing `fileId` in input, or missing `file_name`/`file_content` → `normalize` returns a voiding shape, never throws.
6. **Coverage**: hold 97/96/97/97; batch `npm run all` + a single DCO-signed commit at the end of each phase.

---

## 8. Pre-implementation verification gates

Confirm against real data **before** writing the plan:

1. ✅ **Real `get_meeting_assets` payload shape** — captured 2026-07-08; pinned.
2. ✅ **Real `hub_get_file_content` payload shape** — captured 2026-07-08; pinned (`fileId` confirmed absent from result).
3. ⚠️ **Large-result truncation** — the `get_meeting_assets` result (full transcript inline) can be large; confirm a real **Claude Code transcript JSONL** records the full tool_result and does not truncate it below the summary. If Claude Code truncates large tool results, `summary_markdown` may still be intact (it precedes the transcript in the object) but this must be checked on a real transcript.
4. ⚠️ **tool_use input keys (`zoom-doc`)** — confirm a real Claude Code transcript records the input under `input` with key `fileId` (exact casing) for `hub_get_file_content`.
5. ⏳ **Slack shared seam** — Phase 2 is blocked until the Slack work merges the envelope input-threading + `getClaudeNormalizer` registry. Rebase onto it and mirror, do not fork.

---

## 9. Out of scope (future)

- Meeting transcript / participants / whiteboards / agenda capture.
- `search_meetings` / `search_zoom` as reference triggers (would produce candidate lists, not single entities).
- `get_recording_resource` capture (org uses AI summaries, not cloud recordings — see §6).
- Codex parity for the Zoom tool namespace.
- IntelliJ panel parity.
