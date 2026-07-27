# Back-fill Raw Transcript Scanning

## Topic Statement

Scan every on-disk Claude Code session transcript into per-line signal records that the back-fill attributor consumes, keeping only lines whose working directory belongs to the target repository, and grouping the surviving records by session in chronological order. This is a standalone historical indexer, deliberately decoupled from the live post-commit transcript pipeline.

## Scope

**In scope:**
- Walking the on-disk Claude transcript store (per-project subdirectories of newline-delimited session files).
- The predicate that decides whether a line's working directory belongs to the target repo.
- The per-line signal record shape.
- Extraction of edited-file paths from file-editing tool invocations, and their relativization.
- Reuse of the live conversational-line parser for byte-identical turn text.
- Which lines are dropped, and the grouping/sort order of the output.

**Out of scope (boundaries):**
- The line-level parsing/cleaning of conversational role and content (owned by **Claude Code Transcript Reading**; reused verbatim here for parity).
- The commit target index (owned by **Back-fill Commit Target Index**).
- The attribution algorithm (owned by **Back-fill Commit Attribution Algorithm**).
- Any non-Claude transcript source — this scanner is Claude-only; its source tag is fixed.

## Data Contracts

### On-disk transcript store

The scanner reads a projects root that contains one subdirectory per project; each project subdirectory holds one newline-delimited transcript file per session, named by the session identifier. The projects root defaults to the user's Claude state directory but is overridable (tests inject a temp dir).

### Working-directory predicate

A caller-supplied predicate `(cwd) → boolean` decides whether a given line belongs to the target repo. The scanner offers a standard predicate built from a set of repo worktree roots: it accepts a working directory that, after separator/case normalization, **equals or is nested under** any of the roots. An absent working directory is rejected.

### Raw signal record (per accepted line)

| Field | Type | Notes |
|-------|------|-------|
| session id | string | from the line, else the file's session id |
| transcript path | string | absolute path of the source file |
| source | fixed `"claude"` | this scanner is Claude-only |
| line number | int | 0-based position in the file |
| timestamp | string, optional | raw instant string if present |
| numeric timestamp | number | epoch ms parsed from the instant; **not-a-number** when absent/unparseable |
| git branch | string, optional | branch recorded on the line |
| working directory | string, optional | as recorded on the line |
| role | `"human"`/`"assistant"`, optional | conversational role, when the line carried a turn |
| content | string, optional | cleaned conversational text, when present |
| edited-relative[] | string[] | repo-relative forward-slash paths of file-edit tool targets |
| edited-basename[] | string[] | basenames of the same edited files |

## Behavior

### Scan flow

1. List the projects root. If it cannot be read, log and return an empty result (no error thrown).
2. For each project subdirectory, list its newline-delimited transcript files. If the entry is not a readable directory, skip it silently.
3. For each transcript file, read its full contents. If unreadable, skip it silently.
4. Split into lines and parse each line into a signal record (see per-line parsing). Discard `null` results.
5. Apply the working-directory predicate to each record; drop records the predicate rejects.
6. Group surviving records by session id.
7. Within each session, sort chronologically (see sort order).

### Per-line parsing

For one raw line:
1. Trim; an empty line yields nothing.
2. Parse as a JSON object; a parse failure yields nothing.
3. Read the optional timestamp, working directory, and git branch fields. Read the session id from the line, falling back to the file's session id.
4. Extract edited-file signals (see below).
5. Run the **live conversational-line parser** (the exact same parser the live pipeline uses) to obtain role + cleaned content, so back-fill summaries see byte-identical turn text (IDE-tag stripping, noise filtering) to the live pipeline.
6. **Drop the line entirely if it carries no signal at all** — i.e. no timestamp, no edited files, and no conversational turn.
7. Otherwise emit the signal record, with numeric timestamp = the parsed instant (or not-a-number when the instant is absent/unparseable).

### Edited-file extraction

Only file-editing tool invocations contribute edited paths. From the line's message content blocks, for each tool-use block whose tool name is one of the edit/write/multi-edit tools, take the target file path and:
- Push its basename onto the basename list.
- Compute its path **relative to the line's own working directory** and push that onto the relative list; when relativization does not yield a usable relative path — the path is not nested under that working directory, no working directory is known, **or the path is exactly equal to the working directory (which yields an empty relative path the caller treats as unusable)** — push the forward-slashed absolute path instead.

Relativization is case-insensitive at the prefix-match step (so a working directory whose casing differs from the recorded path still matches on case-insensitive filesystems), but the returned slice preserves the **original casing** of the path so downstream matching against real repository paths keeps true casing.

### Grouping and sort order

Records are grouped by session id. Within a session they are sorted by numeric timestamp ascending; records whose numeric timestamp is not-a-number sort **last**; ties (and unparseable-vs-unparseable) break by line number ascending.

## State Transitions

Stateless: the scanner reads the filesystem once and returns an in-memory grouping. It never writes, never advances a cursor, and never consults the live pipeline's session/cursor state.

## Notable Behavior

- **Claude-only.** The source tag is hard-coded; other transcript sources are not scanned by back-fill. The record shape leaves room for future sources. (Notable.)
- **Decoupled from the live pipeline.** The live flow learns a transcript's path from a hook payload and advances per-session cursors; this scanner instead brute-scans every on-disk transcript and holds no cursor state. (Notable.)
- **A line with no timestamp, no edit, and no turn is dropped.** Such lines carry nothing the attributor can use. (Notable.)
- **Unparseable timestamps become not-a-number and sort last**, so malformed lines never reorder good chronological data. (Notable.)
- **The conversational text is produced by the live parser**, guaranteeing back-fill turn text matches the live pipeline exactly. (Notable — cross-source parity.)
- **Failures are silent and localized:** an unreadable projects root returns empty; an unreadable project dir or transcript file is skipped; the scan continues. (Notable.)
- **Edited-path relativization is case-insensitive to match but case-preserving to emit** — a deliberate split so it works on case-insensitive filesystems without corrupting real repo path casing. (Notable.)

## Unreachable / Not-live

None — every branch is reachable during a scan.

## Shared Behavior

- Conversational role/content parsing (record recognition, IDE-tag stripping, noise-prefix filtering, same-role handling at the line level) is owned by **Claude Code Transcript Reading** and reused here unchanged.
- Separator/case path normalization for the working-directory predicate and for edit-path comparison is the product-wide normalization convention.
- The output grouping (session id → time-ordered records) is what the attributor consumes; the attributor's window/tier logic is **Back-fill Commit Attribution Algorithm**.
