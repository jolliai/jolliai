# 321. Skill Token Attribution

## Topic Statement

`attributeSkillUsage` determines how many tokens were spent under each skill in a Claude conversation and reports the **confidence** of that figure. Two paths exist and which one runs is decided by the data, never configured. When the host tags assistant records with a top-level `attributionSkill`, spend is deduped and grouped by that field — *more* accurate than any positional window, because it correctly excludes turns that fall between skills. When a transcript carries no attribution anywhere (hosts below ~2.1.181), spend is estimated from the interval that follows each `Skill` tool_use. A single attributed turn anywhere — session file or subagent file — switches the whole scan to the attributed path, because mixing the two would put two different confidence levels inside one number and `SkillUsage.confidence` is user-visible precisely so that never has to be guessed at. Both counting rules that make the number correct — dedupe on `message.id`, and never summing `cache_read_input_tokens` — are **defined elsewhere**, in `extractClaudeUsageFromRecord`, so a per-skill total cannot drift from the commit total for the same transcript.

## Scope

**In scope:**
- `attributeSkillUsage`: its inputs, its return shape, and how it picks a path.
- The attributed path: dedupe, grouping by `attributionSkill`, and what happens to unattributed spend.
- The estimated path: what opens an interval, what closes it, and what is excluded from it.
- How subagent transcripts are billed.
- Why the whole transcript is re-read from line 0 on every pass regardless of the scan cursor.
- The two documented limitations that are properties of the transcript rather than of this code.

**Out of scope:**
- `extractClaudeUsageFromRecord` itself — the definition of what a Claude turn cost and of what identifies it (spec 243).
- Recognizing skill *invocations* and producing `SkillUse` (spec 320); this module only produces numbers, keyed by skill id.
- Folding the returned figures into the working record — replace-per-session, add-across-sessions, and confidence degradation across sessions (spec 319).
- Subtracting a detached conversation's share from committed figures (spec 306).
- Splitting a commit's total spend by model, and the commit-level conversation totals (specs 243, 244, 245).
- Sources that report no token figures at all: Codex (spec 326) and OpenCode (spec 325) carry no `usage` field, so nothing here runs for them.

## Data Contracts

### Signature

```ts
attributeSkillUsage(
  sessionLines: ReadonlyArray<string>,
  subagentLineGroups: ReadonlyArray<ReadonlyArray<string>> = [],
): ReadonlyMap<string, SkillUsage>
```

Keyed by **skill id** — the same id space `SkillUse.skill` uses, so the caller looks a use's figures up with `usageBySkill.get(use.skill)`. A skill with no entry in the map gets **no `usage` field at all** on its `SkillUse`, never a zero.

`SkillUsage` is `{ input, output, cached, confidence: "attributed" | "estimated" }`. Every entry the map returns carries the same `confidence`, because the path is chosen once for the whole scan.

### `TurnUsage` — one response's spend

```ts
{ dedupKey?: string; skill?: string; input: number; cached: number; output: number }
```

A module-local shape, built by `parseTurnUsage` from the shared extractor's `ClaudeTurnUsage`:

- `dedupKey` is `ClaudeTurnUsage.id` (i.e. `message.id`), **omitted when that id is the empty string**. A line with no response identity cannot be deduped, so representing that as `undefined` is what makes it always count; dropping such a line would lose real spend.
- `skill` is `record.attributionSkill`, read from the **top level of the record, not from inside `message`**. That is what makes the host's own attribution reusable here at all — it is the only skills-specific field this module reads.
- The three counters come verbatim from `extractClaudeUsageFromRecord`, which sums `input_tokens + cache_creation_input_tokens + output_tokens` and deliberately excludes `cache_read_input_tokens`.

### The two counting rules, and where they live

Neither is implemented here:

- **Dedupe on `message.id`.** One API response is written as several JSONL lines, each repeating the entire `usage` object byte-identically while carrying its own timestamp. Measured inflation across 1,966 real transcripts: median 2.13x, up to 6.92x.
- **Never sum `cache_read_input_tokens`.** It is a per-turn CUMULATIVE running total, so adding it across a slice re-counts the cached prefix on every turn and inflates the result by an order of magnitude.

Both come from `extractClaudeUsageFromRecord` (`cli/src/core/TranscriptParser.ts`), which is also what the commit-level reader and the per-model split use. `SkillAttribution.test.ts` pins that agreement directly rather than trusting the two to stay in step by inspection.

### The estimated path's pre-filter

```ts
const LINE_NEEDLES = ['"usage"', '"name":"Skill"', '"role":"user"', '"type":"user"'];
```

Used only by `estimateByInterval`; the attributed path's own scan filters on `"usage"` alone, since a turn with no usage object cannot contribute either spend or path-selection evidence.

## Behavior

### Path selection

1. Parse every usage-bearing line of the main transcript into a `TurnUsage`, and every usage-bearing line of every subagent group likewise. Deduplication deliberately does **not** happen here: a caller needs to know whether ANY line was attributed before it can choose a path, and that question is asked over all lines.
2. If **any** turn — session or subagent — carries a `skill`, take the attributed path over the concatenation of both.
3. Otherwise take the estimated path over **the main transcript only**, and log at debug how many skills it produced.

### Attributed path

Dedupe the concatenated turns by `dedupKey` (a turn with no key always counts), then sum per `attributionSkill`. **Unattributed spend is dropped, never folded into a neighbour** — that is the error the attributed path exists to avoid. Measured on a real session, 14 unattributed messages were interleaved throughout rather than bunched before the first skill, so a "first `Skill` call → next `Skill` call" window would have swallowed them. Every result is stamped `confidence: "attributed"`.

### Estimated path

Walk the main transcript in order, maintaining one `openSkill` slot and a `counted` set of dedup keys:

- A record containing a `Skill` **tool_use** block opens an interval on `input.skill`. A new entry closes the previous interval, nested or sequential alike. The calling response itself is **excluded** — the record that opens the interval is `continue`d past before any usage is read from it.
- A usage-bearing record is added to the open interval, subject to the same `dedupKey` collapse (a turn with no key always counts). With no interval open, it is skipped entirely.
- A **user turn** clears the interval. `isUserTurn` requires `type === "user"`, `isMeta !== true`, and — when `message.content` is an array — no `tool_result` block in it. Tool results and injected bodies are `type: "user"` too but are not prompts; treating them as bounds would cut every interval at its own body. Without this bound an interval would run to the end of the transcript.

Every result is stamped `confidence: "estimated"`.

The calling response is excluded deliberately, not incidentally: a skill body's injection cost lands as `cache_creation_input_tokens` on the NEXT response, not on the one that called it — and 7% of `Skill` calls share their response with other tools, so including it would bill unrelated work to the skill.

### Subagent billing

Subagent spend is billed to the skill named in the subagent's **own** records. That field is inherited from the parent and never updated, which is exactly the right answer here: a subagent dispatched under a skill is part of that skill's cost. Measured on real data, including subagent files moved one skill's `cache_creation` from 21k to 199k — so omitting them does not make the number conservative, it makes it wrong.

Subagent lines feed **only** the attributed path. They are a separate line sequence, so a positional window across the concatenation would be meaningless, and older hosts predate the subagent layout anyway.

### Recomputation from line 0

`TranscriptSkillDiscovery` calls this with the **whole** main transcript on every pass, regardless of how far the `skills` extractor's cursor has advanced. A skill's spend is a property of the whole session, not of the slice discovered in this pass. Re-reading earlier lines re-derives the same total rather than adding to it, because the dedupe is keyed on response identity. That is also why the working record persists a **per-session** split rather than a single aggregate: this function's output for one session must REPLACE that session's prior contribution, while a different session's must be added (spec 319).

## State Transitions

The estimated path's `openSkill` slot:

| From | Event | To | Effect |
|---|---|---|---|
| closed | record with a `Skill` tool_use block | open on `input.skill` | The opening record's own usage is never counted. |
| open on A | record with a `Skill` tool_use block | open on B | A's interval ends; no attempt is made to restore A. |
| open on A | usage-bearing record, key unseen | open on A | Counters added to A; key recorded. |
| open on A | usage-bearing record, key already counted | open on A | Ignored — one response, several lines. |
| open on A | usage-bearing record with no `message.id` | open on A | Always counted. |
| open on A | non-meta, non-tool-result `type: "user"` record | closed | The host clears attribution on a user prompt, so the interval must too. |
| open on A | end of transcript | closed | Whatever accumulated stands. |

The attributed path is stateless per turn — only the dedupe set and the per-skill totals accumulate.

## Notable Behavior

- **One attributed turn anywhere switches the entire scan.** The test is `allTurns.some(turn => turn.skill !== undefined)` over session and subagent turns together — not per skill, not per file. A transcript that gained attribution partway through is scanned wholly on the attributed path, which means the pre-attribution turns are dropped as unattributed rather than estimated. That is the deliberate trade: a single number must carry a single confidence.
- **Unattributed spend is dropped rather than redistributed.** No skill absorbs the turns between skills. A skill's figure is therefore a lower bound on session cost, never an upper one.
- **Nested skills flatten, and nothing compensates for it.** `attributionSkill` is a scalar that is REPLACED, never pushed. When an outer skill invokes an inner one, records after the inner call read the inner id and the outer frame is never restored, so the outer skill's remaining tokens are billed to the inner one. There is no stack in the data to recover. Documented, not fixed — it is a property of the transcript. (Surprising; recorded so a future reader does not go looking for the bug.)
- **Attribution is turn-scoped.** It clears on the next user prompt, so a skill's segment ends at a user turn rather than at skill completion. Also a property of the transcript, also uncompensated — and it is why `isUserTurn` bounds the *estimated* path the same way, so the fallback mirrors the host's real behavior rather than inventing a longer window.
- **A line with no `message.id` always counts, on both paths.** The absence of a response identity means "cannot dedupe", not "duplicate". Both `dedupe` and the estimated path's inline `counted` check are written to skip the set entirely for such a turn.
- **The counters and the dedupe identity come from ONE definition, on purpose.** Both rules fail silently when reimplemented — a second `cache_read` sum inflates by an order of magnitude, a missing dedupe by ~2x — and the failure mode is a per-skill total that quietly disagrees with the commit total for the same transcript. `extractClaudeUsageFromRecord` exists as a record-level overload precisely so this module can reuse those semantics without parsing the line twice.
- **`attributionSkill` sits at the top level of the record, not inside `message`.** Everything else this module reads (`usage`, `model`, `id`, `content`) lives under `message`. Reading it from the wrong level yields `undefined` for every turn, which silently routes the whole scan onto the estimated path with no error anywhere.
- **The estimated path deliberately opens on `input.skill`, not on the resolved `commandName`.** It reads only the assistant record and never the tool result, so the interval is keyed by the *requested* id — where the extractor (spec 320) prefers the resolved one for the invocation record. On a transcript old enough to lack attribution the two are normally the same; where they differ the estimated figure simply lands under a key no `SkillUse` looks up, and the skill reports no usage rather than a wrong one.
- **A skill's usage is looked up by the id the scanner settled on.** `TranscriptSkillDiscovery` does `usageBySkill.get(use.skill)`, so a key mismatch degrades to an absent `usage` field — honest, and consistent with the "absent, never zero" rule.

## Shared Behavior

- `extractClaudeUsageFromRecord`, `ClaudeTurnUsage`, the `cache_read_input_tokens` exclusion and the `message.id` dedupe rule are owned by spec 243.
- Commit-level conversation totals and the per-model split that share those semantics are owned by specs 244 and 245.
- Extracting invocations and calling this function with the right line groups is owned by spec 320.
- Folding the returned map into `usageBySession`, re-totalling, and degrading confidence across sessions are owned by spec 319.
- Correcting committed figures after a conversation detach, using the persisted per-session split, is owned by spec 306.
- Carrying a snapshot of the split onto a commit is owned by spec 322; presenting the resulting figures is owned by specs 323 and 324.
