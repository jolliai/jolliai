# 325. OpenCode Skill Invocation Capture

## Topic Statement

OpenCode is the one non-Claude host with a **first-class skill tool**, so nothing about this capture is heuristic: a `part` row whose `data.type === "tool"` and `data.tool === "skill"` *is* an invocation. But OpenCode has no hook, so the capture cannot ride an agent turn — it runs on a polling tick, reading OpenCode's embedded SQLite database read-only, scoping sessions to the current repository, and upserting one registry row per skill. Skills describe how work is happening *right now*, so surfacing them only at commit time would leave working memory empty for exactly the window in which the information is useful. Everything in the reader was measured against a real `~/.local/share/opencode/opencode.db` rather than inferred: the skill body is **inline** in `state.output` (no correlation record to join), timestamps are **epoch milliseconds**, skill ids are **flat** (no `plugin:name` form exists in the corpus), and the top-level `metadata` key comes and goes across versions so nothing may depend on it. Token spend is **always an estimate** — OpenCode records no per-skill attribution anywhere in its schema, so the only available method is a positional interval and the result can never be upgraded to `attributed` by better parsing. The one thing to know before reading anything else here: this reader has **exactly one driver**, the VS Code sidebar's 60 s tick. There is no post-commit sweep.

## Scope

**In scope:**
- The row shapes (`OpenCodeRow`, `OpenCodeSkillScanResult`, `OpenCodeTurnSpend`) and the discovery gates.
- Per-cwd single-flight and how it differs from Codex's.
- Session selection (lookback window, directory matching), the SQL pre-filter, and per-session grouping.
- Skill-row recognition, name resolution, body size, and the two clocks (`state.time.start` versus `time_created`).
- The token-spend rules — what is summed, what is excluded, and why `tokens.total` is never read.
- Positional interval attribution and why it is always `estimated`.
- The cursor value (`lastRowId`) and the session key.
- The absence of any post-commit path, and what that costs.

**Out of scope:**
- OpenCode session discovery and transcript reading for conversations (owned by spec 19), including `getOpenCodeDbPath` and the `node:sqlite` feature gate.
- The shared read-only SQLite helper's retry/close contract (owned by spec 19's sibling plumbing).
- The repo-directory matcher `sessionDirBelongsToRepo` (owned by spec 253).
- `upsertSkillEntry`, the `plans.json.skills` registry, dedupe-by-timestamp, and per-skill Markdown persistence (owned by spec 319).
- Claude extraction (spec 320) and Codex inference (spec 326).
- What `SkillUsage.confidence` means downstream and how per-session splits are folded or subtracted (owned by specs 321, 306).
- Archival onto a commit (spec 322) and rendering (specs 323, 324).
- The 60 s Active Conversations refresh itself and its VS Code wiring (owned by specs 155, 324).

## Data Contracts

### The row envelope

[`OpenCodeSkillScanner.ts`](../cli/src/core/skills/OpenCodeSkillScanner.ts) is handed rows already read from SQLite, so it never touches a database:

```ts
interface OpenCodeRow {
    readonly id: string;
    readonly timeCreated: number;   // the `time_created` column — epoch ms, the ordering key
    readonly data: string;          // the raw `data` column (JSON text)
}
```

One shape for both `part` and `message` rows.

```ts
interface OpenCodeSkillScanResult {
    readonly uses: ReadonlyArray<SkillUse>;
    readonly lastRowId?: string;
}

interface OpenCodeTurnSpend {
    readonly input: number;
    readonly output: number;
    readonly cached: number;
}
```

`lastRowId` is the id of the **newest `part` row consumed**, tracked for *every* row seen and not only the skill ones — a scan whose newest rows were all non-skill would otherwise never advance and would re-read them forever.

### The produced `SkillUse`

Every use carries `source: "opencode"`, the resolved `skill`, `entryPaths: ["tool"]`, its `invocations` (newest first), and `usage` when the interval attributed anything. It carries **no `plugin`**: OpenCode ids are flat, and the namespace lives in `state.metadata.dir`, so splitting the id on a colon would invent a plugin the host never reported. Each invocation is `{ at: <ISO>, bodyChars?: <number>, ok: <boolean> }`.

The discovery layer attaches `sessionKey: "opencode:<sessionId>"` before persisting — the `<source>:<sessionId>` key shape the per-session usage split is stored under, so a detached conversation can be subtracted from it (spec 306).

## Behavior

### Gates, in order

[`OpenCodeSkillDiscovery.discoverOpenCodeSkills(cwd)`](../cli/src/core/skills/OpenCodeSkillDiscovery.ts) returns the number of skills persisted, and returns **0 silently** on each of three gates, checked in this order:

1. `isManuallyDisabled()` — a pass writes into the project's `.jolli/jollimemory/`, which a manually-disabled project must not receive, and the tick keeps firing while the disabled panel is shown (spec 304).
2. `config.openCodeEnabled === false` — the same per-source discovery toggle conversations use.
3. `stat(getOpenCodeDbPath())` throws — not installed. Indistinguishable from an unreadable DB at this level and treated the same way, because there is nothing a user could act on either way.

Beyond the gates, the entire read is wrapped in one `try`/`catch` that logs at **debug** and returns 0. This runs fire-and-forget on a UI tick; a regressed reader must never take down the surface it feeds.

### Single-flight per cwd

An in-flight promise is registered per `cwd` and cleared in `finally`. A caller arriving mid-run **joins** the in-flight pass rather than queueing another. The 60 s tick has four callers (the tick itself, `handleReady`, `refresh`, and a detail-panel save), so overlapping runs are normal; they would all be correct — `upsertSkillEntry` serialises on `plans.lock` — but they would contend for that lock while re-deriving the same answer.

This is **unlike `CodexDiscovery`**, which single-flights *with* a dirty-rerun. There is no dirty-rerun here: the tick comes round again in a minute and skill rows change on the order of minutes, not milliseconds.

### Reading the database

The whole read runs inside `withSqliteDb(dbPath, …)` — the shared read-only helper that brings the lazy `node:sqlite` import (so a Node-18 bundle tolerates the missing module), the locked-retry backoff, and a guaranteed close. `node:sqlite` is a real SQLite and therefore reads the WAL, which matters here: this database carries megabytes of uncommitted WAL, and a library that ignored it would silently see stale rows.

**Sessions.** `SELECT id, directory FROM session WHERE time_created >= ?` with `? = Date.now() - LOOKBACK_MS`, where `LOOKBACK_MS` is 7 days. Two reasons for the window, and the second is the one that matters: an unbounded scan of a multi-megabyte database on a 60 s tick is wasteful, **and** capture is deliberately forward-only. Skill usage from months-old sessions is not back-filled — the same stance every other discovery path takes. A reader who finds an old skill call in the database and no row for it has not found a bug; widening the window would turn a design decision into a migration.

Each candidate's `directory` is then filtered through the shared repo matcher `sessionDirBelongsToRepo(directory, cwd)` (spec 253) — prefix plus separator, case folding, nested-repo exclusion — **not** a SQL equality test, which silently dropped every session started from a subdirectory of the repo. A row whose `directory` is null or empty is **skipped rather than passed on**: a null directory is real in this data, and one such row is enough to throw from the matcher and take the whole batch down with it.

**Parts.** Pre-filtered in SQL — `WHERE session_id IN (…) AND json_extract(data,'$.tool') = 'skill' ORDER BY time_created`. Pushing the tool test into SQLite is what keeps this cheap on a 60 s tick.

**Messages.** Fetched for the same session ids, ordered by `time_created`, with no content filter — attribution needs every turn in the window.

**Grouping.** `groupBySession` splits both lists per session before scanning. Interval attribution is positional *within one conversation*, so rows from two sessions must never share a timeline — interleaving them by timestamp would let one session's turns be billed to another's skill. Only sessions that actually contain a skill part get their messages walked.

### Recognising a skill row

For each `part` row, in order: record `lastRowId`, `JSON.parse` the `data` column (a parse failure skips the row), then require `data.type === "tool"` and `data.tool === "skill"`.

`state.status` must be `"completed"` or `"error"`. A call still in flight has no output yet, and recording it would report a body size of **zero** for a skill that may still be loading. `ok` is set to `status === "completed"`, so an errored invocation is still recorded — it happened.

**Name.** `state.metadata.name` is authoritative (it is what the host resolved); `state.input.name` is the fallback (it is what was requested). A non-string or empty value falls through, and a row with neither name is skipped.

**Body size.** `bodyChars` is the length of the inline `state.output` string, omitted when absent. There is nothing to correlate: unlike Claude, which puts the body in a separate record keyed by tool-use id, OpenCode wraps it inline in `<skill_content name="…">` within `state.output`.

### The two clocks

Each entry keeps two timestamps, deliberately from different sources:

- **`orderAt` = the row's `time_created`.** Used for every interval comparison, because `message` rows carry the same column — so the comparison stays within one clock.
- **`invocation.at` = `state.time.start`** (epoch ms → ISO), falling back to the row's `time_created` when absent. This is the actual event moment and the value the store dedupes on.

Measured on real rows the two differ by tens of milliseconds — enough to put a turn on the wrong side of a boundary if they are mixed.

### Token spend for one turn

`openCodeTurnSpend(messageData)` returns `undefined` unless the message carries a `tokens` block. Otherwise:

| field | source | reason |
|---|---|---|
| `input` | `tokens.input` | — |
| `output` | `tokens.output + tokens.reasoning` | reasoning bills at the output rate |
| `cached` | `tokens.cache.write` | newly written cache IS new work; maps to Claude's `cache_creation` |

Two exclusions, both measured rather than assumed:

- **`cache.read` is excluded because it is cumulative.** Across one real session it ran 0 → 25344 → 25472 → 31488 → … → 63360, so summing it re-counts the cached prefix on every turn. Same property as Claude's `cache_read_input_tokens`, reached through a differently-named field.
- **`tokens.total` is never used.** It equals the sum of every component *including* `cache.read` (31728 = 89 + 47 + 104 + 0 + 31488 in the pinned fixture), so the obvious "just read the total" shortcut inherits the same inflation while looking authoritative.

Missing or non-numeric fields coerce to 0.

### Interval attribution

`attributeByInterval` walks the entries in row order. For each entry the interval opens at its `orderAt` and closes at the **earlier** of:

- the next entry's `orderAt` (or `+Infinity` when it is the last), and
- the `time_created` of the first `message` row in that window whose parsed `data.role === "user"`.

Every message row strictly inside the resulting window contributes its `openCodeTurnSpend` to the entry's skill.

The user-turn bound matters for the same reason it does on Claude's fallback path: nothing marks a skill as *finished*, so an unbounded interval would attribute the remainder of the session to whichever skill ran last.

Every resulting total is stamped `confidence: "estimated"`. This is not a conservative default — OpenCode records no per-skill attribution at all (verified by scanning every message row; zero carry any such field), so the figure can never be upgraded to `"attributed"` by better parsing.

### Folding and persistence

Entries are grouped by skill name; each skill's invocations are sorted **newest first**; the skill's attributed spend (if any) is attached. `discoverOpenCodeSkills` then calls `upsertSkillEntry({ ...use, sessionKey: "opencode:<sessionId>" }, cwd)` once per use, per session, and counts the persisted rows. A non-zero count is logged at info.

### What drives this

**Exactly one caller: `vscode/src/Extension.ts`**, which wires `openCodeSkillDiscovery.discover()` into the sidebar's 60 s Active Conversations refresh (spec 324). Nothing else in the repository calls `discoverOpenCodeSkills` — not the post-commit hook, not `QueueWorker`, not `catchUpTranscriptDiscovery`, not the IDE bridge, not a CLI command.

## State Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Idle | `discoverOpenCodeSkills(cwd)` | in-flight promise registered for `cwd` | Cleared in `finally`, success or failure. |
| In-flight | second call for the same `cwd` | joins the same promise | No queue, no dirty-rerun (unlike Codex). |
| In-flight | any gate trips, or any throw | resolves 0 | Debug log only; the tick retries in ~60 s. |
| Scan complete | `lastRowId` set | returned for the caller's cursor | Advances on **every** part row seen, not only skill rows. |
| Skill row seen with `status` not `completed`/`error` | — | skipped | In-flight call; recording it would report `bodyChars: 0`. |

## Notable Behavior

- **There is no post-commit sweep, and that is the behavior.** OpenCode skill capture happens only while a VS Code window with this workspace open is running its 60 s tick. A terminal-only OpenCode session in a repo with no editor window captures **nothing**, and committing does not go back and look. The design note that accompanied this feature described a "belt and braces" post-commit sweep; it does not exist in the code. Recorded explicitly because the absence is invisible — every gate returns 0 silently, so the failure mode is an empty skills list with no diagnostic anywhere. (Surprising; the single most load-bearing fact about this reader.)
- **Nothing here is heuristic, but everything here is estimated.** OpenCode's skill *invocation* is a first-class tool record, so no row carries `detection: "heuristic"` (contrast Codex, spec 326). Its skill *cost* has no host attribution at all, so every `usage` carries `confidence: "estimated"`. The two axes are independent and this source sits on opposite ends of them.
- **Skill ids are flat, so `plugin` is never derived.** The namespace lives in `state.metadata.dir`. Splitting on a colon — the shape Claude uses — would invent a plugin the host never reported.
- **`tokens.total` is a trap, not a shortcut.** It is the sum *including* the cumulative `cache.read`, so reading it looks authoritative and inflates every figure. Same for summing `cache.read` directly.
- **The two clocks are never mixed.** Interval comparison uses `time_created` on both sides; the recorded invocation timestamp uses `state.time.start`. They differ by tens of milliseconds on real rows, which is enough to move a turn across a boundary. (Surprising; the reason the entry struct carries `orderAt` separately from `invocation.at`.)
- **`lastRowId` tracks every part row, not every skill row.** Anything else would stall the cursor behind a run of non-skill rows forever. (Note that no caller currently persists it — the discovery layer re-derives the window from the 7-day lookback each pass, and dedupe happens in the store by timestamp, spec 319.)
- **A null `directory` is skipped rather than passed to the matcher.** One such row is real in this data and would throw, taking the whole batch — and therefore every session's skills — down with it.
- **The SQL directory test was wrong and the shared matcher is right.** An equality test on `directory` silently dropped every session started from a subdirectory of the repo; spec 253's predicate is the single rule every hookless discoverer applies.
- **Per-session grouping is a correctness requirement, not tidiness.** Positional attribution over an interleaved two-session timeline bills one session's turns to another session's skill.
- **The lookback window is a decision, not a limit to raise.** Capture is forward-only across every source; back-filling months of history would be a migration with a different design.

## Shared Behavior

- The OpenCode database path, the `node:sqlite` feature gate, and OpenCode conversation/transcript reading are owned by spec 19.
- `sessionDirBelongsToRepo` is owned by spec 253.
- `isManuallyDisabled` and the zero-write contract are owned by spec 304.
- `upsertSkillEntry`, the `plans.json.skills` registry, the timestamp-keyed invocation dedupe, and the per-skill Markdown ledger are owned by spec 319.
- `SkillUsage`, the `confidence` axis, and per-session split folding are owned by spec 321; detach-time subtraction by spec 306.
- Archival onto a commit is owned by spec 322; rendering by spec 323; the VS Code surface and the tick that drives this reader by spec 324.
- The 60 s Active Conversations refresh and its Codex sibling are owned by specs 155 and 180.
