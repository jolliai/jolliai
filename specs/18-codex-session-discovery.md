# 18 — Codex Session Discovery and Transcript Reading

## Topic Statement

This spec defines how recent Codex sessions are discovered on disk without a hook event and how their newline-delimited transcripts are normalized into the canonical role-tagged message form.

## Scope

**In scope**

- The on-disk storage layout for Codex sessions, including the date-organized active tree and the flat archived tree.
- The look-back window applied to discovery (sessions older than the staleness limit are excluded).
- How individual session files are recognized.
- The session-meta record at the head of a session file and the fields the discoverer extracts (working directory, identifier, timestamp).
- Working-directory matching against the current project: containment (a session started in a subdirectory of the project belongs to it), platform-aware case sensitivity, and the nested-repository / submodule / linked-worktree exclusion walk.
- The session-info record produced for each match (session identifier, source tag set to Codex, transcript locator pointing at the file, freshness timestamp).
- The line-level message records the reader emits and the event-type filter that drops everything else.
- Mapping of the surviving event subtypes to the canonical role tags.
- Performance constraint: only date directories that could plausibly contain in-window sessions are descended.

**Out of scope**

- Hook-driven session lifecycle events (Codex has none; this is the entire reason discovery exists).
- Cursor-based incremental reads at the per-line level (handled by the shared transcript reader once a session is selected).
- The downstream LLM call that consumes the assembled context.
- Multi-session merging policy (handled by a shared context-assembly layer).
- Detection of Codex installation as a separate concern (covered as a one-line directory check).

## Data Contracts

### Storage layout

Codex stores active sessions under the user's home in a Codex data directory whose `sessions/` subtree is organized by year, month, and day:

```
<codex-home>/sessions/<YYYY>/<MM>/<DD>/<one-or-more-session-files>
```

A separate flat tree at `<codex-home>/archived_sessions/` holds recently-archived sessions without the date-tier organization.

### Session file naming

Each session file has a newline-delimited records suffix. Files lacking that suffix are skipped during scanning.

### Session-meta record (first line of each session file)

The first line of each session file is a JSON record whose envelope carries:

| Field             | Type   | Notes                                                                |
| ----------------- | ------ | -------------------------------------------------------------------- |
| `type`            | string | Must be the session-meta marker; lines whose first record isn't this are skipped. |
| `timestamp`       | string | Optional ISO 8601 instant of session start; falls back to file mtime. |
| `payload.id`      | string | The session's stable identifier.                                     |
| `payload.cwd`     | string | The absolute working directory the session was launched in.         |

### Per-line event records (rest of the file)

Lines beyond the first follow an event-stream shape:

| Field      | Type   | Notes                                                                              |
| ---------- | ------ | ---------------------------------------------------------------------------------- |
| `timestamp`| string | Optional ISO 8601 instant carried through onto the produced entry.                 |
| `type`     | string | The reader keeps only events whose type marks them as a message event; all others are dropped. |
| `payload`  | object | For message events, carries a `type` and a `message` string.                       |

The two surviving payload subtypes are the user-message subtype and the agent-message subtype. Every other payload subtype (session metadata, turn context, tool calls, response items, compaction events, token counts, task lifecycle, turn aborts, agent reasoning, and any other diagnostic) is silently dropped.

### Session-info record (output of discovery)

| Field            | Type    | Notes                                                                  |
| ---------------- | ------- | ---------------------------------------------------------------------- |
| `sessionId`      | string  | The id from the session-meta payload.                                  |
| `transcriptPath` | string  | Absolute path to the session file.                                     |
| `updatedAt`      | string  | The session-meta `timestamp` if present, else the file's mtime, expressed as ISO 8601. |
| `source`         | string  | The literal source tag for Codex.                                      |

### Normalized entry (output of transcript reading)

| Field       | Type                       | Notes                                                          |
| ----------- | -------------------------- | -------------------------------------------------------------- |
| `role`      | `"human"` or `"assistant"` | User-message events map to `"human"`; agent-message events to `"assistant"`. |
| `content`   | string                     | The trimmed `payload.message` text.                            |
| `timestamp` | string or absent           | The line's `timestamp` if present.                             |

## Behavior

### Discovery flow

1. Resolve the project directory to its absolute form.
2. Compute the recent-date set: the year/month/day triplets that fall within the staleness window, expanded enough to cover the current and immediately preceding calendar days (the window may straddle up to three calendar days in the worst case).
3. Walk the active sessions tree:
    - At the year tier, skip directories that no recent date starts with.
    - At the month tier, skip directories that no recent date starts with for the matched year.
    - At the day tier, descend only the directories that exactly match a recent date triplet.
    - Within each matched day directory, scan files with the newline-delimited records suffix.
4. Walk the archived flat tree as a single directory; scan files with the suffix.
5. For each candidate file: read only the first line, parse as JSON, require the session-meta type marker, extract `cwd`, `id`, and `timestamp`.
6. Resolve `cwd` to its absolute form and match it against the project directory using the shared session-directory attribution rule below. A session started anywhere at or below the project directory is attributed to it, unless an intervening directory carries its own repository marker.
7. Compute the freshness timestamp (`timestamp` if present, otherwise the file mtime). If the resulting age exceeds the staleness limit, drop the candidate. Sessions with neither a session-meta timestamp nor a readable mtime are dropped.
8. Emit a session-info record for each surviving candidate.

### Staleness window

The look-back window is fixed at the same staleness limit used by every other discovery-based source in this product. Sessions older than the limit are excluded from discovery results. The limit is two calendar days.

### Session-directory attribution (shared rule, restated in full)

This is the shared attribution predicate every hookless, directory-scoped source applies; spec 253 is its canonical statement. Codex applies it once per candidate, against the session-meta record's recorded working directory. Evaluated in this order, first rule wins:

1. **Absent directory.** A missing, empty, or otherwise falsy recorded working directory is rejected before any path handling runs; such a session is not attributed to any project.
2. **Containment.** Both paths are normalized — backslashes folded to forward slashes, trailing separators stripped, and the result lowercased **only** on case-insensitive host platforms (Windows and macOS; Linux compares case-sensitively). The session is a candidate only when the normalized session directory either equals the normalized project directory, or begins with it followed by a single separator. The required separator is the boundary guarantee: a sibling directory whose name merely starts with the project directory's name (root `…/repo` vs candidate `…/repo2`) does not match.
3. **Exact match.** When the two normalize equal, the session is attributed immediately and the exclusion walk below is deliberately skipped — the project root is itself a repository root and carries its own marker, so inspecting it would reject every session.
4. **Exclusion walk for a strict subdirectory.** Walk upward one parent at a time from the session directory, stopping when the current directory normalizes equal to the project directory. At each visited directory — **including the session directory, excluding the project directory** — check whether it holds its own `.git` entry. If any does, the session is **not** attributed. One existence check covers all three exclusion cases and they are deliberately not distinguished: a nested clone carries a `.git` directory, a submodule and a linked worktree each carry a `.git` file. No entry-type inspection, no repository is opened, no version-control subprocess is run.
5. **Missing intermediate directory.** A visited directory that no longer exists simply reports "no marker here" and the walk continues, so a session whose recorded directory has since been deleted is **kept** (best-effort).
6. **Loop guard (unreachable).** The walk also stops on reaching a directory that is its own parent. Containment already guaranteed the project directory is an ancestor, so this is structurally unreachable; it exists only to make an infinite loop impossible.

No symbolic links are resolved anywhere in the rule: both the comparison and the walk operate on the literal path strings.

### Per-line message reading

For an already-discovered session file, the reader walks the file line by line:

- Lines that aren't valid JSON are silently dropped.
- Lines whose envelope `type` is not the message-event marker are silently dropped.
- Lines whose `payload.type` is the user-message subtype produce `{ role: "human", content: payload.message.trim(), timestamp }` if the message is a non-empty string.
- Lines whose `payload.type` is the agent-message subtype produce `{ role: "assistant", content: payload.message.trim(), timestamp }` if the message is a non-empty string. Both intermediate-reasoning ("commentary") and final-answer phases are kept; the shared coalescing rule will join them.
- Any other payload subtype is silently dropped.

### Empty / unreadable file

A file whose first line cannot be read or doesn't parse, or whose first line is not a session-meta record, is dropped without producing a session-info record. The discoverer logs at debug level and continues with the next candidate.

### Performance shortcut

Only date directories whose path matches a recent-date triplet are descended. Older year/month/day branches are not enumerated. This bounds discovery cost regardless of how many historical sessions accumulate on disk.

## State Transitions

Discovery does not mutate any state. Each call is a read-only filesystem scan that produces a snapshot list of session-info records.

## Notable Behavior

- **Date-tier filtering before traversal**: the year, month, and day tiers are filtered against the recent-date set. A user who hasn't used Codex this calendar week pays only the cost of listing the year tier.
- **Two storage trees, one staleness limit**: active sessions and archived sessions are scanned separately but unified under the same staleness cutoff and the same per-file recognition rule.
- **First-line read uses a single-line stream**: the first line is read via a streaming-line interface, then the stream is closed immediately — files are not slurped into memory just to compute a session-info record.
- **The session id comes from the payload, not the filename**: the file name is not parsed; the id field of the session-meta payload is authoritative.
- **Working-directory match is containment, not exact equality.** A session launched from a subdirectory of the project — the ordinary case in a monorepo package folder — is attributed to the project. Under the previous exact-equality rule every such session was silently dropped.
- **A nested repository, submodule, or linked worktree inside the project is excluded.** Containment alone would attribute such a session to both the inner context and the enclosing one; the intervening-marker walk makes the inner context its sole owner. The same session is attributed normally when the question is asked about that inner root instead.
- **Working-directory match is platform-aware**: case-sensitive on Linux, case-insensitive on Windows and macOS. The fold also absorbs incidental drift such as a differently-cased drive letter.
- **Session-meta timestamp falls back to file mtime**: a session file whose first line lacks a timestamp still resolves to a freshness instant via the file's mtime.
- **Sessions with neither timestamp nor mtime are dropped**, not assumed fresh.
- **Stale-but-active sessions are excluded**: a long-running session whose start is outside the window will not be re-discovered. Discovery is a recency operation, not an "all open" enumeration.
- **Commentary and final-answer agent messages both surface** as canonical assistant entries; the shared coalescing rule will fuse them into one logical turn.
- **Unrecognized payload types are silently dropped**, not surfaced as warnings.

## Shared Behavior

- **Staleness limit of two days** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source }`) matches every other discovery-based source reader.
- **Source tag of `"codex"`** is the literal value shared with downstream session persistence so two sources that coincidentally collide on identifier remain distinguishable.
- **Newline-delimited record format** for the transcript itself is the same on-disk shape used by Claude Code; the per-line schema differs but the line-by-line reader contract is the same.
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) matches every other source reader so downstream consumers do not branch on source.
- **Working-directory based attribution**: sessions are attributed to a project by the shared session-directory attribution predicate restated above and owned canonically by **spec 253** — containment with a nested-repository / submodule / linked-worktree exclusion walk. The identical rule is applied by the OpenCode (spec 19), GitHub Copilot CLI (spec 21), Devin CLI (spec 277), and Antigravity (spec 278) sources. Adoption is not universal: several other hookless directory-scoped sources still match on exact-path equality (see spec 253's adoption note).

## IntelliJ Implementation Note

The IntelliJ surface no longer carries its own simplified native port of Codex session discovery; it obtains these sessions from the same shared discoverer described above, so the behavior documented in this spec applies uniformly across every surface.
