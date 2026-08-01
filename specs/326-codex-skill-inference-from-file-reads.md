# 326. Codex Skill Inference From File Reads

## Topic Statement

Codex has **no skill tool**. Its only on-disk trace of a skill is a shell call whose command string happens to read a `SKILL.md`, so unlike the Claude and OpenCode capture paths this one infers rather than observes, and every record it produces says so by carrying `detection: "heuristic"`. The implementation was shaped by measuring 1,503 real session files before any of it was written: 976 calls touch a `SKILL.md`, across 594 distinct (session, skill) pairs. Three properties of that corpus drive the design — `sed` outnumbers `cat` roughly 14:1 (532 of 549 reads of the busiest skill were `sed -n '1,220p' <path>`), so **the verb is not matched at all**, only the path shape; 6% of the calls are compound (`cat … | sed …`, `pwd && rg … && cat …`), so the path may appear anywhere in the string; and 49% of pairs are read more than once, up to 10×, because one use is routinely several paged reads — so the record is capped at **one entry per skill per scan**, timestamped at the earliest read. Two limits cannot be fixed by better parsing: a human running `cat …/SKILL.md` produces a record identical to an agent consulting it, and "read" is not "used". Both are properties of the signal, which is exactly why the capture is marked heuristic and surfaced with a `†` and a spelled-out footnote (spec 323) rather than presented as an observation.

## Scope

**In scope:**
- `CodexSkillScanResult` and the shape of the records this scanner produces.
- Record recognition: the `SKILL.md` pre-filter, both envelope forms, and the two accepted payload types.
- The path matcher, why the verb is not matched, and the two rejection rules (bare filename, glob metacharacter).
- Timestamp resolution and the skipped-record case.
- The one-entry-per-skill-per-scan rule and the earliest-read timestamp.
- What every produced record deliberately omits.
- The `lastLine` cursor contract.
- The per-source dispatch table, what drives the Codex path, and what does not.

**Out of scope:**
- Codex session discovery, the polling tick, and the shared reference/plan cursor window (owned by specs 18, 180, 181).
- The `skills` extractor cursor's own storage and the never-rewind protocol shared with other sources (owned by spec 319 with `scanSkillsWithCursor`).
- `upsertSkillEntry`, the `plans.json.skills` registry, and per-skill Markdown persistence (owned by spec 319).
- Claude extraction (spec 320) and OpenCode capture (spec 325).
- Token attribution (spec 321) — Codex produces none.
- Archival onto a commit (spec 322) and rendering, including the `†` footnote text (spec 323).
- The VS Code Context row that displays the result (spec 324).

## Data Contracts

### The scan result

```ts
interface CodexSkillScanResult {
    readonly uses: ReadonlyArray<SkillUse>;
    readonly lastLine: number;   // highest line number consumed, 1-based
}
```

This is the same `SkillScanResult` shape the Claude scanner returns, which is what lets both sit behind one dispatch entry.

### The produced record

Every `SkillUse` this scanner emits is fixed in shape:

```ts
{
    source: "codex",
    skill: <name segment>,
    entryPaths: ["tool"],
    invocations: [{ at: <earliest ISO timestamp>, ok: true }],
    detection: "heuristic",
}
```

Four deliberate omissions, each for its own reason:

- **No `plugin`.** The namespace is the containing `skills/` directory, not part of the id.
- **No `usage`.** There is nothing to attribute — see below.
- **No `bodyChars`.** A paged read tells us nothing about what actually reached the model.
- **No `invocationCount` above 1 per scan.** See the capping rule.

`ok` is unconditionally `true`: a shell read either produced the record or it did not, and the record carries no exit status this scanner reads.

### Matchers

```ts
const NEEDLE = "SKILL.md";
const SKILL_PATH = /[^\s"']*\/skills(?:-[a-z]+)?\/([^/\s"']+)\/SKILL\.md/g;
const GLOB_CHARS = /[*?[\]{}]/;
```

`SKILL_PATH` requires a `skills/` or `skills-<suffix>/` segment followed by a single name segment. The `[^/\s"']+` name class stops at a quote or a space so a path embedded in a compound shell string terminates correctly.

## Behavior

### Scanning

`scanCodexSkillLines(lines, fromLine)` walks from `fromLine` to the end. For every line it first sets `lastLine = i + 1` — **before** any filtering — then applies, in order:

1. **Cheap pre-filter.** The raw line must contain `SKILL.md`; no line without it can matter.
2. **Parse.** A `JSON.parse` failure skips the line.
3. **Envelope.** Codex wraps most records in a `payload`; some lines (`turn_context`, `world_state`) are flat. Both are handled — `payload = isRecord(record.payload) ? record.payload : record` — rather than assuming the envelope.
4. **Payload type.** Only `"function_call"` and `"custom_tool_call"` are considered.
5. **Arguments.** `payload.arguments` must be a string and must itself contain `SKILL.md`.
6. **Timestamp.** `record.timestamp` if it is a string, else `payload.timestamp`. A record with **neither is skipped entirely** — an invocation with no time cannot be deduped or ordered downstream.
7. **Path matching.** `SKILL_PATH` is run globally over the arguments string (with `lastIndex` reset first, since the regex is module-level and stateful).

For each match, the captured name segment is rejected when it is `""`, `"."` or `".."`, or when it contains a shell glob metacharacter. Surviving names are folded into a `Map<skill, earliestTimestamp>`: `firstSeen.set(name, at)` when the name is new or when `at` sorts before the stored value (ISO strings compare lexicographically).

After the walk, one `SkillUse` is emitted per distinct name, and a non-empty result is logged at debug.

### The verb is deliberately not matched

Matching on `cat` — the intuitive reader — would have found almost nothing: `sed -n '1,220p'` accounted for 532 of 549 reads of the busiest skill in the corpus. Any reader would do, and new ones appear all the time. **The path is the whole signal.**

### The two rejection rules

- **A bare `SKILL.md` filename is not a use.** Requiring the `skills[-<suffix>]/<name>/` segment is what rejects the real false positive `rg --files -g 'SKILL.md'` — a search *for* skill files, which carries the bare filename with no path in front of it. A substring test on `"SKILL.md"` alone counts that as using a skill.
- **A glob in the name segment means enumeration, not use.** `for f in .../skills/*/SKILL.md; do … done` matches the path shape structurally and would otherwise be recorded as a skill literally named `*`. This one was found only by running the scanner over the whole corpus — the fixtures alone did not surface it.

### One entry per skill, per scan

This is the load-bearing modelling decision. Codex has no entry *event*, only reads, and a single use is routinely several paged reads — 49% of real (session, skill) pairs were read more than once, up to 10 times. Counting reads would report a skill "entered 10 times" when it was entered once, which is worse than not counting at all. The count is capped at the only claim the data supports: **this session used this skill**. The timestamp recorded is the **first** read, when the skill entered the picture.

The downstream consequence is that a Codex row's `invocationCount` is a per-session marker, not a measurement — which is exactly what the `†` footnote spells out to the reader (spec 323).

### No token attribution

`scanSkillsFrom` computes attribution over the transcript and attaches `usage` plus a `sessionKey` **only when a figure exists for the skill**. The attribution pass is Claude-shaped, so a Codex transcript produces none and neither field is ever attached. That is load-bearing beyond the obvious: the session key is derived from the transcript file's stem, which **is** the session id for Claude but is **not** for Codex, whose transcripts are named `rollout-<timestamp>-<uuid>`. The mismatch is harmless today only because the key is never attached. If Codex ever gains usage, its real session id must be resolved first or detach correction (spec 306) will fail to match.

### The cursor

`lastLine` is set to `i + 1` for **every** line the loop touches, before any filter, and never rewinds. `scanSkillsFrom` returns it, and `scanSkillsWithCursor` persists it under the `skills` extractor's own high-water mark only when it moved forward, and never on a throw. A re-scan of an already-covered window is harmless: the records are identified by name and timestamp, so an idempotent re-emit folds away in the store (spec 319).

The `skills` mark is deliberately **independent** of the shared `lineNumber` cursor that the Codex reference and plan scans ride (specs 180, 181): it neither constrains nor is constrained by how far that cursor advances in the same pass. `CodexDiscovery` reflects this — references and plans share a carefully-aligned window whose cursor is held on a throw, while `scanSkillsWithCursor` is called afterwards against its own mark, because a Codex re-scan is idempotent by name.

### Dispatch and drivers

[`SkillTranscriptScanner.ts`](../cli/src/core/skills/SkillTranscriptScanner.ts) holds the per-source table for the line-oriented path. It has exactly **two** entries: `claude` and `codex`. A source absent from it has no skill extraction, and the reasons differ:

| Source | Why absent |
|---|---|
| Gemini CLI, Antigravity, Cline, Devin | No skill concept on disk at all — verified by on-disk probe, not assumed. |
| Cursor, Copilot CLI | A skill concept with **no on-disk invocation record**. Cursor does ship skills (`~/.cursor/skills-cursor/`), but a scan of 139 real chat files and the IDE composer store found zero references to any of them, so there is no envelope to pin a matcher against. Copilot CLI's `forge_skill_proposals` is an authoring table, not an invocation log. |
| OpenCode | Covered, but not here — its transcripts are SQLite rows rather than JSONL lines, so it has its own reader (spec 325). |

No matcher may be written for Cursor or Copilot CLI until a real invocation is captured from a live run. This repository has already shipped a parser whose fixtures and code were both imagined, agreeing with each other and with nothing real.

The Codex path is driven from `CodexDiscovery.discoverCodexConversations`, which calls `scanSkillsWithCursor(session.transcriptPath, cwd, "codex")` per in-scope session. `DiscoveryCatchUp` — the re-enable catch-up sweep (spec 305) — **explicitly skips Codex sessions** so it does not duplicate that work or mis-order the references-first scan there.

## State Transitions

| From | Event | To | Notes |
|---|---|---|---|
| `skills` mark at line N | scan reaches EOF | mark advances to the last line touched | Persisted only when `toLine > fromLine`. |
| `skills` mark at line N | scan throws | mark held at N | `scanSkillsWithCursor` never advances on a throw; the next pass retries the same window. |
| Skill not yet seen this scan | first matching read | entry created at that read's timestamp | — |
| Skill already seen this scan | later read | entry unchanged | Count stays 1. |
| Skill already seen this scan | **earlier** read encountered later in the file | timestamp lowered | ISO strings compare lexicographically; file order is not assumed to be time order. |
| Any state | record with no timestamp on envelope or payload | skipped | Not recorded at all. |

## Notable Behavior

- **The two limits are properties of the signal, not of the parser, and they are surfaced rather than hidden.** A human reading a `SKILL.md` is indistinguishable from an agent consulting it, and a read is not a use. No amount of better matching closes either gap; the only honest response is the `detection: "heuristic"` flag, which becomes a `†` and a spelled-out footnote at every render surface (spec 323). (Central design point.)
- **`detection` and `SkillUsage.confidence` are different axes and this source proves it.** Codex rows are heuristic *and* carry no usage at all, so they never carry a `confidence` value; OpenCode rows (spec 325) are non-heuristic *and* always estimated. Collapsing the two flags into one would make both sources unrepresentable.
- **The verb is deliberately unmatched.** Anyone extending this will reach for `cat`; the corpus says `sed` wins 14:1 and the path is the entire signal.
- **The glob rejection was found by corpus run, not by fixtures.** `for f in .../skills/*/SKILL.md` matches the path shape structurally and would have shipped a skill named `*`. Recorded because the same class of false positive is what any future loosening of `SKILL_PATH` will reintroduce.
- **`lastLine` advances before filtering, on purpose.** The cursor records how far the scan *looked*, not how far it *matched*; anything else would re-read the same non-matching lines forever.
- **The session key would be wrong for Codex, and is never written.** Codex transcripts are `rollout-<timestamp>-<uuid>`, so the file stem is not the session id — a latent hazard that only stays latent while Codex reports no usage.
- **`"cursor"` is a declared but currently unreachable member of `SkillSource`.** The union in [`cli/src/Types.ts`](../cli/src/Types.ts) lists `claude | opencode | codex | cursor`, but there is no `CursorSkillScanner`, no `cursor` entry in the dispatch table, and no other producer of a `source: "cursor"` skill row anywhere in the repository. Nothing constructs one today. (Surprising; the union is the set of hosts whose skills are *conceptually* readable, and Cursor is the one member for which no invocation record has yet been found on disk.)
- **Codex skill capture, like OpenCode's, runs only on the VS Code polling tick.** `discoverCodexConversations` has one caller — the sidebar's 60 s Active Conversations refresh — and the re-enable catch-up sweep skips Codex by design. There is no post-commit Codex skill scan.

## Shared Behavior

- Codex session discovery, the polling tick, and the shared reference/plan cursor window are owned by specs 18, 180 and 181.
- The `skills` extractor cursor protocol (`scanSkillsWithCursor`, per-extractor high-water marks, never advancing on a throw) and `upsertSkillEntry` / the `plans.json.skills` registry are owned by spec 319.
- Re-enable transcript discovery catch-up, and its deliberate exclusion of Codex, is owned by spec 305.
- Claude extraction — including the subagent-transcript walk and the Claude-shaped attribution pass that `scanSkillsFrom` also runs for Codex — is owned by spec 320.
- OpenCode capture is owned by spec 325.
- `SkillUsage`, `confidence`, per-session splits and detach correction are owned by specs 321 and 306.
- Archival onto a commit is owned by spec 322; the `†` marker and its footnote text by spec 323; the VS Code Context row by spec 324.
