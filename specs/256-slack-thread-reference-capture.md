# 256. Slack thread reference capture and permalink resolution

## Topic Statement

Recognize a Slack thread read out of an AI agent's conversation transcript, resolve the thread's shareable link from whatever evidence the transcript offers (a link the user pasted, or a configured workspace base address), and turn the thread's human-readable transcript blob into a canonical record ready for the generic external-reference extraction step — voiding the whole capture when no link can be established.

## Scope

**In scope:**

- The permalink text grammar: what a Slack thread permalink looks like, and the timestamp-format conversion between its URL-embedded compact form and the dotted form used internally.
- The one-pass, whole-transcript harvest of pasted permalinks from the user's own conversation turns, and the key used to look one up later.
- The precedence order used to resolve a thread's shareable link at the moment its read-result is being processed: harvested pasted link, else a link reconstructed from a configured workspace base address, else no link.
- The normalization of the thread-read result's human-readable text blob into a canonical thread record, including the title-selection rule and its length cap, the reply count, and the full body text.
- The void-on-no-link rule and why it means no Slack reference is ever persisted without a working link, even though the generic reference record shape allows an absent link for forward compatibility.
- How each of the two supported producers reaches this capture path today, using its own transcript wire-format to harvest pasted permalinks, and how the Codex path's normal point of delivery (the shared pipeline's fallback pairing pass) differs from the Claude path's.

**Boundaries:**

- This spec does NOT cover the generic, source-agnostic transcript scanning pipeline — recognizing that a line is a tool call/result pair, threading a cursor, deduping, or persisting the resulting reference. See the transcript-reference-extraction spec (153).
- This spec does NOT cover the declarative rule-evaluation engine that turns a canonical record into a stored reference record (native id / title / url / description fields, required-vs-optional field semantics, the void mechanism itself) or the prompt-rendering of a stored reference. See the source-definition evaluation spec (255). This spec only describes what values feed into that evaluation for the Slack source and the field-level requirement (a link) that produces the void outcome.
- This spec does NOT cover how the resolved workspace base address is entered, validated, or persisted as configuration. See the configuration-command spec (62).
- This spec does NOT cover on-disk persistence of a stored reference (frontmatter shape, filename sanitization, idempotent-write semantics). See the reference-store persistence spec (179), which documents the general optional-link allowance this source relies on.
- This spec does NOT cover how a reference is displayed once stored (panels, badges, labels). See the references-panel spec (187).
- This spec does NOT cover recognizing which tool call belongs to Slack in the first place (the producer-side binding/prefix/namespace match) beyond what is needed to explain how each producer's path reaches normalization; that recognition mechanism itself is generic and belongs to spec 153.

## Data Contracts

### Permalink grammar

A Slack thread permalink is a web address of the shape:

```
https://<workspace>.slack.com/archives/<channel-id>/p<16-digit-timestamp>
```

- `<workspace>` — the workspace subdomain (lowercase letters, digits, hyphens).
- The host is fixed to `<workspace>.slack.com`. Only the `.slack.com` domain is accepted; any other host — including an enterprise/grid domain — does not match and is rejected.
- `<channel-id>` — an uppercase alphanumeric channel identifier.
- `<16-digit-timestamp>` — exactly sixteen decimal digits with no separator: a 10-digit whole-seconds part immediately followed by a 6-digit fractional (microsecond) part.

A candidate string that does not match this exact shape (a host that is not `<workspace>.slack.com`, missing the `/archives/<channel>/p<digits>` segment entirely, or a digit run that is not exactly 16 digits long) is not a permalink and is rejected.

### Dotless-to-dotted timestamp conversion

Internally, a thread's timestamp is represented in "dotted" form: the same digits with a decimal point inserted six digits from the end (whole-seconds part, a literal `.`, then the six-digit fractional part). A parsed permalink's compact 16-digit timestamp is converted to this dotted form immediately upon recognition; every subsequent lookup, key, and reconstruction in this capture path uses the dotted form. Reconstructing a permalink from a dotted timestamp is the inverse: remove the single `.` to get back the compact 16-digit form.

### Harvested-permalink map

A transient, per-transcript-scan map built once, keyed by `<channel-id>:<dotted-timestamp>`, valued by the permalink text that produced that key. Only one permalink is retained per key — when the same channel/timestamp pair is pasted more than once in a transcript, the later-encountered occurrence overwrites the earlier one in the map. Each producer builds this map from its own transcript wire-format (see "Behavior" below); the map's shape and lookup key are identical across producers.

### Canonical thread record

The intermediate object produced by normalizing one thread-read result, before it is handed to the generic reference-evaluation step (spec 255):

| Field | Description |
|---|---|
| channel id | The channel identifier the read was performed against. |
| parent timestamp | The dotted timestamp of the thread's parent message, read out of the result blob itself (not out of the permalink). |
| title | See "Title selection" below. Always present — a fallback applies when no better text is available. |
| text | The complete result blob, with leading/trailing whitespace trimmed. Always present. |
| reply count | A non-negative integer; zero when the blob carries no reply section. |
| url | The resolved shareable link (see "Link resolution precedence"), present only when one could be resolved; entirely absent from the record otherwise (not an empty string, not null). |

### Link resolution precedence

At the moment a thread-read result is being normalized, the shareable link is resolved in this fixed order, stopping at the first that succeeds:

1. Look up the harvested-permalink map by `<channel-id>:<dotted-timestamp>` for the channel and parent timestamp that this specific thread-read call was invoked against. If present, use it.
2. Otherwise, if a workspace base address is configured (see spec 62), reconstruct a permalink by combining the base address with the channel id and the compact (dotless) form of the timestamp, following the same grammar described above.
3. Otherwise, no link is available.

### Title selection

The result blob is a human-readable presentation of a thread, not structured data. It presents the thread's parent message first, followed — only when the thread has replies — by a clearly marked reply section. The title is derived only from the parent-message portion of the blob (everything before the start of the reply section, or the whole blob when there is no reply section):

- Within that parent portion, the first line of free text immediately following the line that states the parent message's timestamp is taken as the title candidate.
- If no such line exists (e.g., the parent post carries no text body), the title falls back to a fixed label built from the parent timestamp.
- The chosen title (candidate or fallback) is capped at 50 characters: text exceeding the cap is cut to 50 characters (trailing whitespace trimmed) with a single trailing ellipsis character appended; text at or under the cap is left as-is.
- Deliberately confined to the parent portion: a reply's text is never eligible to become the title, even when the parent has no body of its own.

### Reference-evaluation inputs derived from the canonical record

The canonical record feeds a fixed set of reference-evaluation fields (spec 255 defines how these are evaluated and combined into a stored reference):

- A native identifier built by combining the channel id and the parent timestamp, required to look like `<channel-id>-<seconds>.<fraction>`.
- A title, required to be non-empty (always satisfied — see "Title selection").
- A link, required to look like a secure (https) address. This requirement is **not** relaxed to optional at the field-definition level, even though the canonical record's own `url` property is optional. A canonical record with no `url` therefore fails this required field outright.
- A description, optional, sourced from the full trimmed text.
- Three opaque display attributes: a constant marking the entity as a thread, the reply count, and the channel id.

## Behavior

### One-pass permalink harvest (per producer)

Before any thread-read result is normalized, the entire transcript is scanned once, independent of how many thread-read calls it contains. Each producer harvests from its own transcript wire-format:

**Claude producer:**

1. Only text authored by the human user is considered — never the agent's own turns, and never the payload of a tool result, even one nested inside a user turn.
2. Within each qualifying user turn, every plain-text content block is checked for a permalink-shaped substring.
3. Every permalink found (a user turn may contain more than one, and a block may be one of several blocks in the same turn) is parsed and recorded into the harvested-permalink map keyed by channel + dotted parent timestamp.
4. Lines that fail to parse as transcript records, user turns whose content is not a list of blocks, and blocks that are not plain-text are silently skipped — a malformed or unexpected shape never aborts the scan.

**Codex producer:**

1. The harvest scans from the transcript's first line, not from the cursor — the pasted-permalink evidence for a thread may sit earlier in the transcript than the cursor's current scan window, so a cursor-bounded scan could miss it.
2. Only user-authored message bodies are considered. Two shapes are recognized: an `input_text` content block inside a structured user message, and a bare `user_message` event whose body is a plain string (not a block list).
3. Each recognized message body is checked for a permalink-shaped substring exactly as on the Claude producer; every permalink found is parsed and recorded into the same harvested-permalink map, keyed by channel + dotted parent timestamp.
4. Lines that fail to parse, message shapes matching neither recognized form, and non-text bodies are silently skipped — a malformed or unexpected shape never aborts the scan.

Scanning once up front — rather than once per thread-read result — matters because a single pasted permalink is the resolution evidence for every thread-read result sharing its channel and timestamp; scanning per-result would either double-count work or, worse, miss a permalink that appears earlier or later in the transcript than the particular result being resolved. This is also why the Codex harvest starts at the transcript's first line rather than the cursor: the shared pipeline's cursor tracks how far tool-call processing has advanced, but a permalink pasted before the cursor's current window remains valid resolution evidence for a thread read after it.

### Per-result resolution and normalization (per producer)

When a recognized thread-read call's result is reached during the same transcript walk:

1. The channel id and the parent timestamp that the *call itself* requested (not anything from the result payload) are recovered from the call's original invocation arguments — on the Claude producer, from the `tool_use` block's input; on the Codex producer, from the tool call's parsed arguments (preferring the event's own invocation arguments on the fallback pass, falling back to the paired request's arguments when the event carries none of its own).
2. The link is resolved using the precedence in "Link resolution precedence" above, using the harvested-permalink map built in the one-pass scan and the (already-loaded) workspace base address.
3. The result's text blob and the resolved channel id / link are combined into the canonical thread record described above.
4. If the blob does not carry a recognizable result payload at all, or no parent-timestamp line can be found in it, normalization fails outright and produces no canonical record — this is a stronger failure than the link-only void described next; it means the result did not look like a thread read at all.
5. The canonical record (when produced) proceeds into the generic reference-evaluation step exactly like every other source's normalized result.

### Void-on-no-link

A thread whose canonical record carries no `url` — because nothing was pasted for its channel/timestamp AND no workspace base address is configured — fails the required-link field during reference evaluation. The consequence:

- No reference record is produced for that thread.
- Nothing is queued for on-disk persistence.
- The failure is silent from the transcript-scan's point of view (not a logged error, not a partial/placeholder reference) — from the shared pipeline's perspective this thread-read call simply produced no reference, indistinguishable from a call the recognition layer never matched at all.

This is deliberate: a reference the user can never click through to is considered to carry nothing worth keeping.

### Reachable on both producers: the Codex fallback-pairing path

A second, non-interactive transcript producer (documented generically in spec 153) is also capable of recognizing a Slack thread-read call — the recognition rule for this source is registered for both producers' identity schemes — and, unlike an earlier revision, now carries its own registered normalizer that performs the Codex-side harvest and resolution described above.

In practice, a Slack reference captured through this second producer is normally delivered on the shared pipeline's **fallback pairing** pass rather than its primary pass. A canonical thread record with no resolvable `url` is a void (the url field is required — see "Void-on-no-link" below), and the shared pipeline treats a normalizer's void return as "skip without marking the call emitted" rather than as a terminal failure, precisely so a paired end-of-call event can retry the same call on the fallback pass. A Slack call whose primary-pass attempt cannot yet resolve a link — for instance because the relevant pasted permalink is threaded through only on the fallback event's own invocation arguments — is left unmarked for exactly this reason, and it is the fallback pass that most often ends up producing the resolved canonical record.

This is also why the one-pass permalink harvest and the per-call channel/timestamp carry-through described above are implemented separately for each producer's transcript walk, using each producer's own wire-format, even though both converge on the same harvested-permalink map shape and the same link-resolution precedence.

## State Transitions

| From | Trigger | To |
|---|---|---|
| (permalink not yet seen) | The one-pass harvest encounters a pasted permalink in a qualifying user turn | Harvested — available under its channel+timestamp key for the rest of this transcript's resolution attempts (all within the same scan) |
| (link unresolved for this thread) | A harvested permalink exists for this thread's channel+timestamp | Resolved via pasted link (highest precedence; a configured workspace address is not even consulted) |
| (link unresolved for this thread) | No harvested permalink, but a workspace base address is configured | Resolved via reconstruction |
| (link unresolved for this thread) | No harvested permalink and no configured workspace address | Unresolved — canonical record carries no link |
| Canonical record produced, link unresolved | Reference evaluation runs the required-link field | Voided — no reference record, nothing persisted |
| Canonical record produced, link resolved (either precedence branch) | Reference evaluation runs every required field successfully | Reference record produced, proceeds into the shared pipeline (spec 153) exactly like any other source |

## Notable Behavior

- **The link is the reason this source needs its own whole-transcript pre-pass.** Most supported sources' result payloads are self-sufficient — the payload already carries (or omits) its own canonical link. Slack's result blob never carries a link at all; the link exists only as evidence sitting elsewhere in the transcript (something the user pasted) or in configuration. The whole-transcript permalink pre-pass and workspace-URL reconstruction are unique to Slack, which is why Slack keeps its own spec. Slack is **not**, however, the only source that needs *out-of-payload context*: it belongs to a small five-member context-normalizer registry (owned by spec 153) alongside **zoom-doc**, **confluence**, **monday.com**, and **Context7**. Zoom-doc likewise reads a value that lives only in the originating tool call's arguments — its file id — to build both the canonical id and the doc URL. Confluence is routed through the same registry for a *different* reason: it needs no out-of-payload context, only a payload-internal reshape the declarative engine cannot express (flattening an Atlassian-Document-Format body object to a plain-text string). monday.com is routed through the registry for both reasons at once: it reads the originating tool call's input to gate targeted-fetch versus whole-board-browse, and it flattens a Quill-delta body the declarative engine cannot express. Context7 is the registry's fifth member and its most extreme case: it needs the tool call's input **exclusively** — its library id and query — and ignores the tool's returned payload entirely, which sharpens rather than weakens the argument here. Slack still reads its result blob for the thread's content; Context7 does not read a result at all. What is genuinely Slack-only is the permalink harvesting and workspace-URL reconstruction, not the mere fact of needing a context-aware normalizer.
- **Optional-at-the-record-shape, required-at-the-field-definition.** The generic reference record type allows an absent link as a forward-compatibility allowance for some future link-optional source. Slack is not that source: its field definition keeps the link required, so in practice no Slack reference is ever stored without one — the type-level optionality is dead code for this source specifically, load-bearing only for the storage layer's general shape (spec 179).
- **Later-pasted-wins, not first-pasted-wins.** If a user pastes the same thread's permalink twice in one conversation, the harvest keeps only the most recently encountered one for that channel/timestamp key; earlier occurrences are silently overwritten during the single up-front pass.
- **Title confinement prevents reply-body leakage.** Without confining the title search to the parent portion of the blob, a parent post with no text body (e.g., a file-only post) could accidentally surface the first reply's text as the thread's title. The fallback label exists specifically to avoid that.
- **The link is out-of-payload on both producers** — Slack's result blob carries no link on either producer, so both harvest pasted permalinks up front and thread them (plus the workspace-address fallback) into normalization.

## Shared Behavior

- The source-agnostic scanning, cursoring, deduplication, and persistence-triggering pipeline that this capture path plugs into — including how "recognized but produced nothing" is treated identically to "never recognized" — is owned by spec 153.
- The declarative field-evaluation engine that turns the canonical thread record's derived inputs into a stored reference record (or voids it) is owned by spec 255; this spec only specifies which values are handed to it and which one field's requiredness produces the void behavior described here.
- The workspace base address used in link reconstruction is a user-configured value; its entry, format validation, and normalization are owned by spec 62. This spec only consumes the already-validated, already-persisted value.
- The stored reference's optional link field, its on-disk representation when absent, and the general persistence contract are owned by spec 179; this spec is the reason a Slack reference's link is, in every case that actually reaches storage, always present despite the field being modeled as optional.
- How a stored Slack reference is displayed (icon, badge, color, label policy) is owned by spec 187 and is out of scope here entirely — this spec ends at the point a reference record is handed to the shared pipeline.
