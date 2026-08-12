# 339. Kimi Code CLI Session Discovery and Transcript Reading

## Topic Statement

This spec defines how Kimi Code CLI sessions are found on disk without any lifecycle hook, how each session's working directory is recovered from a per-session state document, and how the host's own newline-delimited wire-event stream is normalized into the canonical role-tagged message form.

## Scope

**In scope**

- The data root, its environment-variable override, and the presence check that reports the host installed.
- The on-disk session tree: the grouping directory, the per-session directory, the state document, and the main agent's wire-event transcript.
- The staleness gate applied to the transcript file's modification time, and the fact that it runs **before** the state document is read.
- Working-directory recovery from the state document, the ordered list of field names consulted, and the rule that a session with no working directory is skipped outright.
- Working-directory attribution against the current project (the shared containment predicate, restated in full).
- The session-info record produced per match, including where the session identifier and the freshness timestamp come from.
- The native session title read from the state document.
- Which wire events become human turns, which become assistant turns, which are reasoning and are skipped, and which whole event families are never read.
- The per-event millisecond-epoch timestamp and its conversion, and what becomes of a value the conversion cannot represent.
- Tool-call counting over the same stream, its de-duplication key, and its one re-attribution rule.
- The first-user-message title parser this source contributes to the shared title cascade.
- Where this source sits in the per-source reader dispatch tables (full-transcript, cursor-resumed slice, commit-time read).
- The absence of any agent hook, and what that implies about where sessions come from.

**Out of scope**

- The hook-free artifact discovery pass that extracts references and skills from the same transcripts — owned by spec 340 (references) and spec 341 (skills).
- The shared containment predicate's canonical statement — spec 253; it is restated in full here because this source applies it.
- The cursor-resumption mechanism, the commit-time cutoff, and the same-role coalescing rule applied to every source's normalized entries.
- The overlay that edits or deletes entries before they are counted or displayed.
- Driving this CLI as a summary-generation backend. That is an unrelated role for the same binary and belongs to the local-agent provider spec.
- MCP server registration into this host's configuration file.
- Any surface that renders the resulting rows.

## Data Contracts

### Data root and detection

The host's data root is the value of a dedicated environment variable when set, otherwise a fixed dot-named directory under the user's home. The same resolution is used for discovery and for locating the host's MCP configuration file, so a relocated home is honored by both.

Detection is a single check: the data root exists and is a directory. Any error, including absence, reports not-installed, silently.

### Session tree layout

```
<data root>/sessions/<workDirKey>/<sessionId>/
    state.json                    session metadata document
    agents/main/wire.jsonl        the main agent's conversation record
    agents/<other>/…              sub-agent conversations
```

`<workDirKey>` groups sessions by their working directory and encodes a slug plus a hash of that directory. **It is never decoded or recomputed** — the slug/hash input is not part of the host's published contract. The real working directory comes from the state document instead. The grouping directory's name is otherwise ignored: it is enumerated only to reach the session directories beneath it.

Only the **main** agent's transcript is read. Sibling agent directories are never enumerated by this reader.

### State document

A JSON object. Only two things are read from it:

| Field | Notes |
| --- | --- |
| working directory | The absolute path the session was launched in. Read from the **first** of an ordered list of candidate field names that holds a non-empty string: the one the host writes today, plus five defensive aliases against a future rename. |
| title | The host's own session title. Used when it is a non-empty string; otherwise the record carries no title field at all (never an empty string). |

A read failure, a JSON parse failure, or a parsed value that is not an object all yield "no state document", which in turn yields "no working directory".

**The wire-event stream carries no working directory of any kind.** The state document is the only place it exists, which is why a session whose state document is missing, unparseable, or silent about the directory cannot be attributed to any project and is dropped.

### Session-info record (output of discovery)

| Field | Type | Notes |
| --- | --- | --- |
| session identifier | string | The **session directory's name**. The transcript file's own name is a constant (`wire`) and carries no identity. |
| transcript locator | string | Absolute path to the main agent's wire-event file. |
| freshness timestamp | string | The transcript file's modification time, as an ISO 8601 instant. The state document's own creation/update timestamps are **not** read. |
| source tag | string | The literal tag for this host. |
| title | string, optional | Present only when the state document carried a non-empty title; the field is omitted entirely otherwise. |

### Wire-event stream

One JSON object per line. Every event carries a top-level type tag and a **millisecond-epoch** `time`. Tool and content activity is nested one level deeper, inside a loop-event envelope carrying an inner `event` object.

Two event shapes carry conversation text:

| Shape | Meaning |
| --- | --- |
| A top-level prompt-turn event whose `input` is a content value | One **human** turn. |
| A loop-event envelope whose inner event is a content-part event and whose `part.type` is `text` | One **assistant** turn (streamed — one part per line). |

The content-part event is also accepted **unwrapped** at the top level, though the observed shape is the wrapped one.

### Content-value stringification

The prompt turn's `input` and each content part are normalized to plain text by the same rule:

- A bare non-empty string is returned verbatim.
- An array is walked element by element; each element is stringified by this same rule and the non-empty results are joined with newlines. An array contributing nothing yields "no text".
- An object contributes its `text` field when that field is a non-empty string **and** its `type` is either the text marker or absent entirely. Any other object contributes nothing.
- Anything else contributes nothing.

### Normalized entry (output of transcript reading)

| Field | Type | Notes |
| --- | --- | --- |
| role | `"human"` or `"assistant"` | Prompt-turn events map to human; text content parts to assistant. |
| content | string | The stringified, trimmed text. An empty result produces **no entry at all**. |
| timestamp | string or absent | See the timestamp rule below. |

### Timestamp rule

For any event, the timestamp is taken from `time`, falling back to a `timestamp` field:

- A finite **number** is treated as a millisecond epoch and converted to an ISO 8601 instant.
- A non-empty **string** is taken verbatim.
- Anything else — including a non-finite number — yields no timestamp, and the reader's cutoff logic then conservatively includes the line.

There is **no range check** on this path. A number that is finite but outside the representable instant range passes the finiteness test and then throws while being formatted. That throw is absorbed by the surrounding per-line guard, and the two callers absorb it differently: the message reader drops **the whole line's entry**, while the timestamp-only accessor reports no timestamp. So an absurd-but-finite `time` costs the line, not just its timestamp.

### Tool-call tally

A separate pass over the same lines produces one tally row per distinct tool call:

- The line must contain the loop-event envelope marker (a cheap substring pre-filter), parse as JSON, carry the envelope type, and hold an inner event of type `tool.call` with a string `name`.
- Rows are de-duplicated by the call's own correlation id; a call with no id is counted without de-duplication.
- A call whose name is exactly the skill tool's name **and** whose arguments carry a string skill name is re-attributed to that skill name; every other call is classified by the same tool-name classifier the block-pairing agent's transcripts use, which is correct here rather than merely close because this host names MCP tools with the identical server-prefixed scheme.
- The paired tool-result event is deliberately **not** counted — it is the same call's answer and would double every row.
- Each row carries the call's own timestamp when the event yielded one.

## Behavior

### Discovery flow

1. Resolve the project directory to its absolute form.
2. List the sessions directory under the data root. A listing failure (including absence) logs at debug and returns **no sessions**; it is not an error.
3. For each grouping directory, list its children. A listing failure skips that grouping directory only and the scan continues.
4. For each session directory, attempt to build a session-info record:
   1. Stat the main agent's transcript file. Any failure — including the file not existing — drops the candidate immediately. **This is the staleness gate's first half and it runs before anything else**, so an absent or old session tree costs exactly one stat.
   2. Compute the age from the file's modification time. If it exceeds the staleness limit, drop the candidate.
   3. Read and parse the state document.
   4. Recover the working directory. If none is present, log at debug and drop the candidate — such a session cannot be attributed to any project.
   5. Resolve the recovered directory to its absolute form and evaluate the shared containment predicate against the project directory. On rejection, drop the candidate.
   6. Read the native title.
   7. Emit the session-info record.
5. Log the number of sessions discovered at debug and return them.

Discovery is read-only; it writes nothing and caches nothing.

### Staleness window

Fixed at 48 hours, the same limit every other discovery-based source in this product applies. It is measured against the **transcript file's modification time**, not against any timestamp inside the state document or the event stream.

### Session-directory attribution (shared rule, restated in full)

This is the shared attribution predicate every hookless, directory-scoped source applies; spec 253 is its canonical statement. This source applies it once per candidate, against the working directory recovered from the state document. Evaluated in this order, first rule wins:

1. **Absent directory.** A missing, empty, or otherwise falsy candidate directory is rejected before any path handling runs. (For this source that case has already been screened out one step earlier, since a session with no recoverable directory is dropped before the predicate is called.)
2. **Containment.** Both paths are normalized — backslashes folded to forward slashes, trailing separators stripped, and the result lowercased **only** on case-insensitive host platforms (Windows and macOS; Linux compares case-sensitively). The session is a candidate only when the normalized session directory either equals the normalized project directory, or begins with it followed by a single separator. The required separator is the boundary guarantee: a sibling directory whose name merely starts with the project directory's name (root `…/repo` vs candidate `…/repo2`) does not match.
3. **Exact match.** When the two normalize equal, the session is attributed immediately and the exclusion walk below is deliberately skipped — the project root is itself a repository root and carries its own marker, so inspecting it would reject every session.
4. **Exclusion walk for a strict subdirectory.** Walk upward one parent at a time from the session directory, stopping when the current directory normalizes equal to the project directory. At each visited directory — **including the session directory, excluding the project directory** — check whether it holds its own `.git` entry. If any does, the session is **not** attributed. One existence check covers all three exclusion cases and they are deliberately not distinguished: a nested clone carries a `.git` directory, a submodule and a linked worktree each carry a `.git` file. No entry-type inspection, no repository is opened, no version-control subprocess is run.
5. **Missing intermediate directory.** A visited directory that no longer exists simply reports "no marker here" and the walk continues, so a session whose recorded directory has since been deleted is **kept** (best-effort).
6. **Loop guard (unreachable).** The walk also stops on reaching a directory that is its own parent. Containment already guaranteed the project directory is an ancestor, so this is structurally unreachable; it exists only to make an infinite loop impossible.

No symbolic links are resolved anywhere in the rule: both the comparison and the walk operate on the literal path strings.

### Per-line message reading

For an already-discovered transcript, the reader walks the file line by line. Each line is parsed as JSON; a parse failure logs at debug and produces no entry. Then, in order:

1. If the event's top-level type is the prompt-turn marker, stringify its `input`, trim it, and emit a **human** entry when the result is non-empty.
2. Otherwise, extract a content-part object — from inside a loop-event envelope, or from the top level if the event is itself a content part. If the part's `type` is `text` and its `text` is a string, trim it and emit an **assistant** entry when the result is non-empty.
3. Otherwise produce no entry.

Each emitted entry carries the event's timestamp per the timestamp rule.

### Events deliberately not read

Every other event family produces no entry:

- A content part whose `part.type` is the **reasoning** marker. This is the model's internal reasoning and is treated as noise, exactly as the block-pairing agent's thinking blocks are.
- The **message-append** event, which is a replayed copy of the user's prompt with injected system-reminder blocks. Reading the prompt-turn event instead keeps the genuine input and drops the injected noise.
- Step lifecycle, usage records, model-call events, tool-registration events, configuration updates, metadata, and permission-mode changes.
- Tool-call and tool-result events, on this path. They are read by the tool-call tally, by the reference extractor (spec 340), and by the skill scanner (spec 341), but never become conversation entries.

Parsing is defensive throughout: an unknown shape yields no entry and never throws.

### Title fallback

This source contributes a **real** parser to the shared first-user-message title fallback, not a no-op stub: given one line, it parses it, requires the top-level prompt-turn type, and stringifies the `input`. The fallback is only consulted when the state document carried no title, since a non-empty native title short-circuits the cascade one step earlier.

The stringification there is the title resolver's **own shared helper, not the content rule above**: it joins array elements with a space rather than a newline, and it accepts any object carrying a string `text` without checking the block's declared type. So a title derived from a multi-block prompt is not a prefix of the conversation entry derived from the same prompt.

### Reader dispatch

The same line-oriented parser serves this source in three places:

- **Full-transcript loading** — the shared line-streamed loader selects this source's parser by tag.
- **Cursor-resumed slice reading** — the per-source switch routes this source to the generic line-streamed reader with this source's parser, alongside the two other parser-backed sources; every other source has a dedicated reader.
- **Commit-time reading** — the commit pipeline's per-source chain has no dedicated branch for this source, so it falls through to the same generic line-streamed reader with this source's parser, carrying the commit's cutoff timestamp.

This source is also a member of the set of sources whose parser is known to populate tool-call rows, which is derived from the parser factory's own accepted tags — so a parser that exists but is absent from that list would have its tool-call reporting silently discarded.

## State Transitions

Discovery and reading are read-only with respect to the host's data. Discovery caches nothing; each call is a fresh filesystem scan producing a snapshot list. The only state that moves forward is the caller-held cursor for a given transcript, which is not owned by this topic.

**This source has no lifecycle hook**, so nothing ever writes one of its sessions into the persisted session registry. Every consumer that needs a session of this source obtains it by running the on-demand scan above — at commit time, or on the editor sidebar's refresh tick.

## Notable Behavior

- **The staleness gate precedes the state read, and that ordering is the whole performance story.** An old or absent session tree costs one stat; only sessions inside the window pay for a file read and a JSON parse.
- **Freshness is the transcript file's mtime and nothing else.** A session whose state document records a much later update but whose transcript has not been touched is judged by the transcript. A session directory with **no** transcript file is dropped before its state document is ever opened, even if the state document is fresh.
- **The session identifier is the directory name, because the file name is a constant.** Every session's transcript is named identically; identity lives one directory up (three levels up from the transcript path). Any consumer that derives a session id from a transcript file's stem would collapse every session of this host onto one key.
- **A session with no recoverable working directory is skipped entirely, not attributed to the current project.** The event stream carries no working directory, so there is no second source of evidence to fall back on. (Surprising; the equivalent situation for a source that records its directory in the transcript itself would be recoverable.)
- **The grouping directory encodes the working directory but is never decoded.** The slug-and-hash scheme is not a published contract, so it is treated as an opaque enumeration tier.
- **Five of the six working-directory field names are defensive.** Only the first is written by the host today; the rest exist against a future rename and are, as of this revision, dead alternatives that no observed state document exercises.
- **Assistant text arrives streamed, one part per line.** Consecutive assistant parts become consecutive assistant entries and are fused into one logical turn by the shared same-role coalescing every source's reader is subject to.
- **Reasoning parts are dropped by falling through, not by an explicit skip.** Only the text part type is accepted; every other part type — reasoning included — simply matches nothing.
- **The replayed prompt copy is deliberately ignored in favour of the original prompt event.** Reading it instead would pull injected system-reminder blocks into the conversation.
- **The millisecond-epoch conversion here carries no range check, unlike the two scans over the same stream.** A finite-but-unrepresentable `time` throws while being formatted and is caught by the general per-line guard, so the message reader drops the entire line rather than keeping it with an absent timestamp. The reference parser (spec 340) and the skill scanner (spec 341) each carry an explicit range check that degrades the same value to an empty timestamp while keeping the record — so one malformed line is treated three different ways by three readers of one file. (Surprising.)
- **No token or cost accounting is attempted for this source.** The host emits usage records, but nothing reads them: this reader produces no per-message usage. The same gap exists for several other discovery-based sources.
- **Sub-agent conversations exist on disk and are never read here.** Only the main agent's transcript is opened.
- **This source never enters the persisted session registry.** Only hook-backed sources write it, so any sweep that iterates that registry cannot see a session of this host.

## Shared Behavior

- **Staleness limit of 48 hours** is shared with every other discovery-based source.
- **Canonical session-info shape** (session identifier, transcript locator, freshness timestamp, source tag, optional title) matches every other discovery-based source.
- **The containment attribution predicate** restated above is owned canonically by **spec 253**; the same rule is applied by the Codex (spec 18), OpenCode (spec 19), GitHub Copilot CLI (spec 21), Devin CLI (spec 277) and Antigravity (spec 278) sources. Adoption is not universal — several other hookless sources still match on exact-path equality (spec 253 records which).
- **Canonical normalized-entry shape** (role, content, optional timestamp) and **same-role coalescing** match every other source reader, so downstream consumers never branch on source.
- **The title cascade** this source's line parser plugs into — native title, then the block-pairing agent's dedicated native reader, then the first-user-message fallback, then a constant placeholder — is owned by spec 182.
- **The message counter and its overlay application** are owned by spec 184; this source appears in both of its per-source dispatch tables.
- **The commit-time cutoff** that bounds a read at the queue entry's creation instant is owned by spec 36; this source's reader honours it through the shared line-streamed reader.
- **Reference extraction** from the same transcripts is owned by spec 340, and **skill capture** by spec 341.
