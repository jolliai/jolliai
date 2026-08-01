# 320. Claude Skill Invocation Extraction

## Topic Statement

`scanClaudeSkillLines` recognizes each entry into an agent Skill from a Claude Code transcript, across **both** entry paths the host actually uses: the `Skill` tool (the agent decided to invoke it) and a user-typed `/plugin:skill` slash command (which bypasses the `Skill` tool entirely — there is no `SlashCommand` tool anywhere in the corpus, so an extractor keyed on the tool alone misses that path completely). Neither path is one record. The tool path is three consecutive records whose body is *not* in the tool result; the command path is a `<command-name>` tag block validated only by a following injected-body record. `sourceToolUseID` is the discriminator across all three mechanisms: present on an `isMeta` body ⇒ Skill tool, absent ⇒ slash command, no `isMeta` body at all ⇒ client-side only (`/mcp`, `/plugin`, `/compact`) and **not** a skill. Association walks **line order, never timestamp order**. `TranscriptSkillDiscovery` wraps the scanner: it reads the main transcript from the `skills` extractor's own high-water mark, re-reads every subagent file in full on every pass, asks spec 321 for token figures, and persists each result through `upsertSkillEntry` sequentially.

## Scope

**In scope:**
- `scanClaudeSkillLines` — the line-oriented Claude scanner: pre-filter, the two entry paths, the discriminator, name and plugin resolution, grouping, and the cursor rewind.
- `SkillScanResult` and the `SkillEntryPath` union.
- `getSkillScanner` — the per-source dispatch table and what an absent entry means.
- `scanSkillsFrom` / `scanSkillsWithCursor`: transcript reading, subagent enumeration, `sessionKey` derivation, sequential persistence, and the cursor protocol.
- The three production call sites that drive skill discovery for a JSONL source.

**Out of scope:**
- Token attribution — `attributeSkillUsage` and its two paths (spec 321). This spec only hands it the lines and forwards its map.
- Persisting a `SkillUse` (fold rules, markdown format, registry row) — spec 319.
- Codex's heuristic `SKILL.md`-read inference, which is the *other* entry in the dispatch table (spec 326).
- OpenCode capture, which does **not** go through this table at all — its transcripts are SQLite rows, so it has its own reader driven from the 60-second polling tick (spec 325).
- Archival of the captured rows onto a commit (spec 322).
- `discovery-cursors.json` itself — the cursor file, its per-extractor marks and the legacy-seeding rule (spec 24).

## Data Contracts

### `SkillScanResult`

```ts
{ uses: ReadonlyArray<SkillUse>; lastLine: number }
```

`uses` holds one entry per distinct skill id with invocations newest-first; `lastLine` is the 1-based mark for the caller's cursor. **`lastLine` is not always the last line read** — see the rewind below.

### `SkillEntryPath`

`"tool" | "command"`. A skill can be both agent-invoked and user-invoked, so `SkillUse.entryPaths` is a set, emitted sorted.

### The pre-filter

```ts
const LINE_NEEDLES = ['"name":"Skill"', '"sourceToolUseID"', "<command-name>", '"toolUseResult"', '"isMeta":true'];
```

A line matching none of these is never `JSON.parse`d. **`"isMeta":true` is load-bearing and cannot be dropped as redundant**: a slash-command body record is DEFINED by the *absence* of `sourceToolUseID`, so it matches no other needle, and filtering on the others alone silently discards the entire slash-command entry path before parsing ever runs. This is the same shape of bug as `NAME_NEEDLES` in the reference parser (spec 153), which cannot see the `Skill` tool at all because every needle it derives is an `mcp__` namespace.

### The two record triples

**Skill tool path** — three consecutive records:

| Record | Shape | Supplies |
|---|---|---|
| assistant | `content[].type == "tool_use"`, `name == "Skill"`, `input` is `{skill}` or `{skill, args}` | the requested id, `args`, the `at` timestamp, the tool_use id |
| user | a `tool_result` block, with `toolUseResult == {success, commandName, allowedTools?}` on the record | the **resolved** id and the `ok` outcome |
| user | `isMeta`, `sourceToolUseID` == the tool_use id, `message.content[0].text` == the injected body | `bodyChars` |

The body is **not** in the tool result. That is the obvious assumption and it is wrong. `toolUseResult.commandName` is the resolved id and the better name source than the requested `input.skill`.

**Slash-command path** — a `<command-name>` tag block in a user record, followed by an `isMeta` body record with **no** `sourceToolUseID`.

### The per-source dispatch table

`SCANNERS` in `SkillTranscriptScanner.ts` maps a `TranscriptSource` to `{ source: SkillSource, scan: SkillLineScanner }`. Two entries today: `claude` → `scanClaudeSkillLines`, `codex` → `scanCodexSkillLines`. `getSkillScanner` returns `undefined` for anything else, and `scanSkillsFrom` then returns 0 immediately.

An absent entry means one of three distinct things, and they are not interchangeable:

- **No skill concept on disk at all** — Gemini CLI, Antigravity, Cline, Devin. Nothing to capture. Verified by on-disk probe, not assumed.
- **A skill concept whose invocation is only inferable** — Codex, which *is* in the table and carries `detection: "heuristic"` on every entry (spec 326).
- **A skill concept with no on-disk invocation record** — Cursor and Copilot CLI. Cursor ships skills (`~/.cursor/skills-cursor/`) but a scan of 139 real chat files and the IDE composer store found zero references to any of them; Copilot CLI's `forge_skill_proposals` is an authoring table, not an invocation log. **No matcher may be written for either until a real invocation is captured from a live run** — this repo has previously shipped a parser whose fixtures and code were both imagined, which agreed with each other and with nothing real.

## Behavior

### The single forward pass

`scanClaudeSkillLines(lines, fromLine)` walks `lines` from index `fromLine` (a 1-based high-water mark, so lines at or below it are skipped) and maintains four pieces of state: `pendingTools` (tool_use id → entry), `toolEntries` (every tool entry in order), `commandEntries` (promoted command entries), and a single `openCommand` slot. For each line, in this order:

1. **Non-needle line** → if a command is open and the line does not contain `<local-command-caveat>`, **drop the open command**. An unrelated record between the tag and its body means the command produced no body, so it was client-side. Continue.
2. **Unparseable JSON** → skip. A truncated last line is normal while a session is live.
3. `captureAttribution` — record any `attributionSkill` → `attributionPlugin` pair from the top level of the record.
4. **Body record?** (`isMeta === true`, with a `message.content` string or a leading `{type:"text"}` block). If `sourceToolUseID` is present, it names its own tool_use and sets that pending entry's `bodyChars` — timestamps are irrelevant. If absent and a command is open, it **validates and promotes** the open command into `commandEntries`. Continue.
5. **`Skill` tool_use blocks?** Any open command is dropped (a client-side command that never reached the model is not a skill), and every `Skill` block in the response becomes a `PendingToolEntry` — a single response can carry several tools, only some of them skills. Blocks without both a string `id` and a string `input.skill` are ignored; an empty-string `input.args` is treated as absent. Continue.
6. **Tool result?** Look up `tool_use_id`; if a pending entry matches, set its `resolvedSkill` from `toolUseResult.commandName`, its `ok`, and `sawResult = true`. Continue.
7. **`<command-name>` tag block?** Becomes the new `openCommand`, replacing any previous one (which by definition never got a body).

### Reading a body record

`skillBodyLength` returns a length only for `isMeta === true` records. It rejects content containing `<local-command-caveat>` or `<local-command-stdout>`: those records are themselves `isMeta` and are **not** skill bodies. The caveat in particular **precedes** the tag record, so a naive "is there an `isMeta` record nearby" test promotes every client-side command into a skill.

### Reading a tool result

Failure is reported two independent ways and **either alone** marks the invocation failed: `toolUseResult.success === false`, or `is_error === true` on the `tool_result` block. `ok` is `toolUseResult?.success !== false && block.is_error !== true`.

### Reading a `<command-name>` block

Tags are read **by name, never by position**: both `message,name,args` and `name,args,message` orders are live in the corpus, the latter indented twelve spaces. `<command-args>` is optional AND can be present-but-empty; both mean "no arguments". A leading `/` is stripped from the name; an empty name yields no entry.

### Name and plugin resolution

The **resolved** `commandName` wins over the requested `input.skill` — the former is what the host actually launched, the latter is what the model asked for. The plugin is `attributionPlugin` paired with `attributionSkill` when the host supplies it, otherwise the `<prefix>:` of the id (`superpowers:brainstorming` → `superpowers`); an unnamespaced id has no plugin.

### Grouping

`assemble` buckets every tool entry and every promoted command entry by resolved skill id into one `SkillUse` each, sorts invocations newest-first, and emits `entryPaths` as a sorted set. Command-path invocations are always `ok: true` — there is no result record to say otherwise.

### The cursor rewind

The scan window routinely closes mid-triple: a pass that runs while the agent is still working sees the `tool_use` of the turn in flight and not yet its result. Such an entry **is still reported** — a `tool_use` that reached the transcript is a real entry into the skill, and a session killed right there is the one case where the fragment is all the evidence there will ever be. What it must not do is freeze the fragment's gaps, since it carries no `bodyChars` and an optimistic `ok: true`.

So `lastLine` is rewound to **just before the earliest unresolved `tool_use`** (`firstUnresolvedLine - 1`, floored at `fromLine`), and the next pass re-reads the whole triple. The rewind is only half the fix: `foldSkillUse` (spec 319) must upgrade the stored invocation in place, because that fold would otherwise be first-write-wins and discard the completed record on arrival.

Rewinding cannot strand the mark. A `tool_result` is emitted for every `tool_use`, including denials and interrupts, so the only file that holds the mark forever is one whose session died mid-tool — which by definition has no further lines to strand. It is also the safe direction for a monotonic cursor, which loses data only when it runs AHEAD of what was scanned.

### Orchestration: `scanSkillsFrom`

1. `getSkillScanner(source)`; return 0 if absent.
2. Read the main transcript's lines; return 0 if unreadable. `readLines` strips the trailing newline **before** splitting and treats an empty result as zero lines — without both steps a file holding only `"\n"` splits to `[""]` and advances the caller's cursor to line 1 over content that does not exist.
3. Scan the main transcript from `fromLine`.
4. **Enumerate and scan every subagent transcript from line 0.** `<dir>/<sessionId>.jsonl` → `<dir>/<sessionId>/subagents/agent-*.jsonl`, filtered on the `.jsonl` suffix because each transcript has an `agent-<id>.meta.json` sibling that is not a transcript. Sidechain records live only in those files and are never duplicated into the session file, so a scan of the session alone cannot see a skill a subagent entered.
5. Call `attributeSkillUsage(lines, subagentGroups)` (spec 321) over the **whole** main transcript regardless of the scan cursor.
6. Derive `sessionKey = "<scanner.source>:<basename minus .jsonl>"`, and attach it together with `usage` **only when a usage figure exists** for that skill id. Absent, never zero: a zero would claim the skill cost nothing.
7. `await upsertSkillEntry(...)` for each use, **sequentially, not concurrently** — every upsert contends for the same `plans.lock` and the same markdown file, so parallelism would only serialize on the lock while multiplying the chance of a lock timeout.
8. Return the main transcript's `lastLine`.

### Orchestration: `scanSkillsWithCursor`

The single load/scan/save wrapper every discovery site calls rather than open-coding the three steps, because **the cursor protocol — not the scan — is the part that fails silently when it is got wrong**. A site that advanced the mark without scanning, or advanced it on a throw, would strand those lines permanently: `discovery-cursors.json` is monotonic, so nothing ever re-reads a line the mark has passed.

It loads the `skills` extractor's own mark, scans, and saves **only when the mark moved forward**. It **never throws** — every caller is a hook or a UI tick, and a failed pass leaves the mark where it was so the next pass retries the same window.

The `skills` mark is deliberately independent of the shared `lineNumber` the plan/reference pair ride: it neither constrains nor is constrained by how far that cursor advances in the same pass.

### The three production call sites

| Site | Source | Why here |
|---|---|---|
| `StopHook.discoverFromTranscript` | `claude` | Turn-level. Claude skill usage has to appear in working memory while the session is still running, which is when it is useful — not only once a commit lands. Runs with its own error handling so a throwing skill scan cannot hold the plan/reference cursor, and vice versa. |
| `DiscoveryCatchUp` | the session's source | Skills ride their own high-water mark, so the backlog they drain is their own — a window the shared cursor may already have passed while the project was disabled (spec 305). Deliberately **not** counted into that pass's `scanned` total, which reports how many *shared* cursors advanced. |
| `CodexDiscovery` | `codex` | The 60-second polling tick. Scans on the skills mark independently of the reference/plan window resolved above it. |

## State Transitions

The `openCommand` slot (slash-command path):

| From | Event | To |
|---|---|---|
| empty | `<command-name>` tag record | open |
| open | `isMeta` body with **no** `sourceToolUseID` | empty — **promoted** to a `commandEntries` invocation |
| open | line containing `<local-command-caveat>` | open (unchanged) — the caveat is `isMeta` and precedes the tag |
| open | any non-needle line | empty — dropped, the command was client-side |
| open | a `Skill` tool_use record | empty — dropped |
| open | another `<command-name>` tag record | open (replaced) — the previous one never got a body |

A `PendingToolEntry` (tool path):

| From | Event | To |
|---|---|---|
| — | `Skill` tool_use block | pending: `sawResult: false`, `ok: true`, no `bodyChars` |
| pending | matching `tool_result` | `resolvedSkill` + `ok` set, `sawResult: true` |
| pending | matching `isMeta` body (`sourceToolUseID`) | `bodyChars` set |
| pending, `sawResult: false` | scan window ends | **reported anyway**, and `lastLine` rewinds to just before its line so the next pass completes it |

## Notable Behavior

- **Association is by line order, never timestamp order.** An observed `tool_result` carries `…24.966Z` while the body record that follows it carries `…24.965Z` — the host's write order and its timestamps disagree. A time-sorted matcher would associate the wrong records. (Surprising; the reason the scanner is a single forward pass over raw lines.)
- **`<local-command-caveat>` is itself `isMeta` and PRECEDES the tag record.** This is why the open-command slot survives a caveat line but nothing else, and why `skillBodyLength` explicitly rejects caveat and `<local-command-stdout>` content. A "nearby `isMeta` record" heuristic promotes every client-side command into a skill.
- **Unknown record types exist.** `attachment` and `queue-operation` show up in the wild; `type` is not a closed union in practice, so nothing keys on an exhaustive list of record types.
- **A fragment is emitted AND the cursor rewinds — both, not either.** Emitting alone would freeze an invocation with no body and an optimistic `ok`; rewinding alone would re-emit it into a first-write-wins fold that discards the completed record. The correctness of this path is split across two modules and neither half works without the other (see spec 319's `moreCompleteInvocation`).
- **The open-command drop fires only on a non-needle line or a `Skill` tool_use.** A needle-matching record that is none of the four recognized shapes leaves the slot open. This is a consequence of where the drop sits in the loop, not a separate rule.
- **`sessionKey` is derived from the transcript's filename stem, which is correct for Claude and wrong for Codex.** Claude names its transcript after the session id; Codex names its `rollout-<timestamp>-<uuid>`. It is harmless today **only** because Codex reports no usage (its capture is heuristic), so the key is never attached — the field is set only when `usage` is present. If Codex ever gains usage, its real session id must be resolved here first or conversation detach (spec 306) will fail to match. Recorded at the derivation site because the failure would be a silently-stale number, not an error. (Surprising; a latent correctness dependency between two otherwise unrelated features.)
- **Subagent files are re-scanned in full on every pass, by design.** They are short and self-contained, so cursor-tracking them would cost more than it saves; re-emitting an invocation is harmless because the store identifies invocations by timestamp and folds duplicates away (spec 319). A subagent's `attributionSkill` is inherited from its parent and never updated, so its OWN invocation is invisible to attribution and must come from the `Skill` tool_use directly — which is precisely why the scanner runs over them rather than leaving them to spec 321.
- **Attribution is deliberately not done in the scanner.** Keeping extraction and token counting in separate modules is what lets the scanner stay a pure line walk with no dependency on the usage-dedupe rules, and lets spec 321 read from line 0 while the scanner reads from a cursor.
- **An empty or whitespace-only transcript yields zero lines, not one.** Without the trailing-newline strip a `"\n"` file would advance the caller's monotonic cursor past content that does not exist — unrecoverable, since the mark never moves backwards.

## Shared Behavior

- Folding a `SkillUse` into the working record, the invocation-identity rule (`at`), and the fragment-upgrade (`moreCompleteInvocation`) that the rewind depends on are owned by spec 319.
- `attributeSkillUsage`, its attributed/estimated path selection, and the subagent billing rule are owned by spec 321.
- The Codex entry in the dispatch table is owned by spec 326; the OpenCode reader, which bypasses the table entirely, by spec 325.
- Archival of the captured rows onto a commit is owned by spec 322.
- `discovery-cursors.json`, `loadExtractorCursorLine` / `saveExtractorCursor`, the per-extractor marks and the legacy `lineNumber` seeding rule are owned by spec 24.
- The Claude Stop hook's session recording and its other extractors are owned by specs 26 and 29; reference extraction from the same transcript by spec 153.
- The catch-up pass that re-drains discovery after a re-enable is owned by spec 305; the Codex polling tick by spec 180.
