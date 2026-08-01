# 319. Skill Usage Working Record

## Topic Statement

Every captured entry into an agent Skill is persisted as **one accumulating markdown file per (host, skill)** under `<projectDir>/.jolli/jollimemory/skills/<source>/<stem>.md`, plus one index row in the `plans.json.skills` map keyed `<source>:<skill>`. Skills are the **fourth** first-class working artifact alongside plans, notes and references, but they are the only one that keeps accumulating after it has been committed: a skill entered five times is ONE row with `invocationCount: 5`, and it can be entered again after being frozen onto a commit. The markdown file — not the registry row — is the **sole dedup ledger**: every scan pass is a read-modify-write that folds newly-discovered invocations into whatever is already on disk, identifying an invocation by its `at` timestamp. That is what makes re-scanning safe, and it is why the file is never cleared or zeroed at archive time (spec 322 subtracts a baseline instead). The registry row is an index over that file and never carries history the file does not: `upsertSkillEntry` copies the post-fold counters `writeSkillMarkdown` returns, not the counters of the pass that was handed in.

## Scope

**In scope:**
- The persisted shapes: `SkillEntry` (registry row), `SkillFileContent` (file), `SkillInvocation`, `SkillUsage`, `SkillArchivedTotals`, and the ephemeral `SkillUse` a scanner produces.
- `sanitizeSkillIdForPath` — the only boundary between a host-supplied skill id and a filesystem path — and the two properties it must hold.
- `writeSkillMarkdown` / `foldSkillUse`: the fold rules for invocations, entry paths, timestamp bounds, usage, `detection` and `trimmed`.
- The markdown render/parse round-trip (frontmatter and invocation detail rows), including how each degrades on corrupt input.
- `upsertSkillEntry`: what it copies from the fold, what it must never resurrect, and the near-write reload.
- The rule that every field-by-field rebuild of a `PlansRegistry` must carry the `skills` map, and the repo-wide test that enforces it.

**Out of scope:**
- Producing a `SkillUse` from a Claude transcript (spec 320), an OpenCode store (spec 325), or a Codex transcript (spec 326).
- Computing `SkillUsage` figures for a session (spec 321) — this spec only folds a number it is handed.
- Freezing a row onto a commit, `archivedTotals` as an archival baseline, and the orphan-branch copy (spec 322).
- Rendering skills into a commit summary, the PR-wide aggregate, and the Memory Bank visible layer (spec 323).
- The VS Code Context list row and its exclusion checkbox (spec 324).
- The `plans.json` file itself, its lock (`withPlansLock`), and the plan / note / reference maps that share it (specs 29, 42, 43, 179).

## Data Contracts

### Where the record lives

Two places, both per-project and both gitignored:

- `<projectDir>/.jolli/jollimemory/skills/<source>/<stem>.md` — the accumulating markdown, one file per skill per host. `skillDir` / `skillPath` build it off `getJolliMemoryDir(cwd)`, so it is worktree-local like `sessions.json` and `plans.json`.
- `plans.json.skills` — `Readonly<Record<string, SkillEntry>>`, keyed `<source>:<skill>` (the **mapKey**). The map is **optional** on `PlansRegistry`, which is the source of the erasure hazard recorded under Notable Behavior.

`SkillSource` is `"claude" | "opencode" | "codex" | "cursor"`. Gemini, Antigravity, Cline and Devin are absent because they have no skill concept on disk at all — nothing to capture, as opposed to something not yet done.

### The filesystem stem

`sanitizeSkillIdForPath(skill)` substitutes every byte outside `[\w-]` with `-`, strips leading and trailing `-`, caps the readable part at 80 characters, and then **unconditionally** appends the first 8 hex of `sha256` over the ORIGINAL id. An id made entirely of substituted bytes (`..`) leaves nothing readable and yields the hash alone, which is still a valid stem.

Two properties are load-bearing and pinned by tests:

- **Path-safe.** No `:`, `/`, `\` or `..` may appear in the result for any input. Skill ids are host-namespaced and routinely carry a colon (`superpowers:brainstorming`, `j:specs-pr-review`), which is illegal in a Windows filename and is displayed as a path separator by macOS Finder. `.` is substituted too — unlike the GitHub `sanitizeNativeIdForPath` rule which keeps it — purely so `..` can never survive into the stem.
- **Injective.** Two skill ids must never map to one stem. A collision is silent data loss: both skills write the same file and each overwrites the other's invocation history, while the two registry rows (keyed separately, unaffected) keep claiming both exist. The hash is what buys this — a pure substitution collapses `superpowers:brainstorming` onto a skill literally named `superpowers-brainstorming`, and `a:b:c` onto `a:b-c`. Because the suffix derives from the original id, the readable prefix may collide freely.

### `SkillInvocation` — one measured entry

```ts
{ at: string; args?: string; bodyChars?: number; ok: boolean }
```

`at` (ISO 8601, the timestamp of the record that entered the skill) **is the invocation's identity** — a skill cannot be entered twice at the same instant. `args` is frequently absent (the source tag is optional AND can be present-but-empty). `bodyChars` is the length of the injected skill body measured from the transcript's own body record and is **never** re-derived from the `SKILL.md` on disk: repeat invocations inject a short "already loaded above" stub rather than the full text, and bundled skills live under a temp path that no longer exists by the time a post-commit hook runs. `ok` is false only for an observed failure.

### `SkillUsage` — tokens spent under a skill

```ts
{ input: number; output: number; cached: number; confidence: "attributed" | "estimated" }
```

`confidence` is user-visible, not an internal note. A source that can neither attribute nor estimate carries **no `usage` field at all** — an absent field is honest, a zero would claim the skill was free.

### `SkillEntry` — the registry row

Carries `source`, `skill`, optional `plugin`, `entryPaths`, the capped `invocations` list, the exact `invocationCount`, `firstUsedAt` / `lastUsedAt`, optional `usage` and `usageBySession`, optional `detection: "heuristic"`, the absolute `sourcePath`, and three archival fields owned by spec 322 (`commitHash`, `contentHashAtCommit`, `archivedTotals`).

`usageBySession` — keyed `<source>:<sessionId>` — is **the authoritative record, not a cache**, for two reasons a single aggregate cannot serve. Capture runs once per transcript, so a skill used in several sessions is folded several times; attribution recomputes a whole session from line 0 on every pass (spec 321), so a session's contribution must REPLACE its prior entry while a different session's must be ADDED. One aggregate cannot distinguish those. Second, committed conversation figures are corrected when a user detaches a conversation (spec 306) using the per-session usage persisted at write time; without the same split here a skill's number goes stale the moment anything is detached.

`detection: "heuristic"` marks an inferred rather than observed invocation. It is deliberately **not** folded into `SkillUsage.confidence`: that field qualifies a token figure, and a heuristic source reports no tokens at all, so there would be nothing to hang it on. Detection quality and token quality are independent.

### `SkillUse` — the ephemeral scan output

What a scanner produces for one skill within one scan pass, already aggregated across repeat entries *inside* that pass: `source`, `skill`, optional `plugin`, `entryPaths`, `invocations` (newest-first), optional `usage`, optional `detection`, optional `sessionKey`. It stands to `SkillEntry` as `Reference` stands to `ReferenceEntry`. `sessionKey` is set **only** when `usage` is present — there is nothing to attribute to a session otherwise.

### `SkillFileContent` — the persisted file shape

Everything `SkillEntry` holds except `sourcePath` and the archival guard, plus a `trimmed: boolean`. Rendered as YAML-style frontmatter keys with **JSON-encoded values** (matching `ReferenceStore`, spec 179, so the two files read the same way), then a blank line, then the invocation detail rows newest-first, then — when `trimmed` — the sentinel `<!-- jolli:skill-trimmed -->` and a one-line notice.

An invocation detail row is:

```
- <at> · args: "<json string>" · body: <n> · failed
```

`args` is JSON-encoded, which is what makes the row parseable at all: the value is host-supplied free text that can itself contain the ` · ` separator, a newline, `body: 999`, or `failed`.

## Behavior

### Writing: read, fold, render, compare

`writeSkillMarkdown(use, cwd)` is a read-modify-write:

1. Read the existing file. A **missing** file and an **unparseable** one both degrade to "no prior history" — they collapse to the same `undefined` before the fold, so a corrupt file can never throw into a hook.
2. Fold the incoming `SkillUse` into that prior content (`foldSkillUse`).
3. Render the canonical markdown and hash it.
4. **Skip the write when the merged bytes equal what is already on disk**, so the file's mtime is untouched and nothing downstream reads an unchanged file as fresh.

It returns the post-fold counters (`invocationCount`, `entryPaths`, `firstUsedAt`, `lastUsedAt`, the capped `invocations`, and the folded `usage` / `usageBySession` / `detection`) for the caller to persist.

**Callers must hold `withPlansLock`.** This is a read-modify-write on both the markdown and the derived counters, so two unsynchronized writers of the same skill each fold into the same pre-merge body and the later write drops the earlier one's invocations. That is reachable, not theoretical: the Claude Stop hook (spec 26) and the hookless 60-second discovery tick can both be capturing skills for one project at once.

### The fold rules

- **Invocations union by `at`.** A timestamp not already present is added and increments `freshCount`; a collision UPGRADES the stored record field-by-field via `moreCompleteInvocation` rather than discarding the incoming one. First-write-wins looks like the safe default and is not: the Claude scanner deliberately reports a `tool_use` whose result has not arrived yet and rewinds its cursor so the next pass can complete it (spec 320). Dropping the duplicate would throw away exactly the fields that pass exists to supply. The upgrade is not "newer wins" either — `bodyChars` and `args` prefer whichever reading has them (absent means "not seen in that window", never "measured as nothing"), while `ok` is `prior && incoming`, so a `false` from either reading stands and a later optimistic `true` cannot revive an invocation already known to have failed.
- **`invocationCount` advances by `freshCount` only.** A colliding invocation is not fresh.
- **Detail is sorted newest-first and trimmed to `SKILL_INVOCATION_CAP` (20).** `invocationCount` stays exact past the cap — a plan-driven loop re-entering one skill per step can legitimately exceed it, which is why the total is carried separately rather than derived from the list length.
- **`entryPaths` is a sorted union** of the prior file's and this pass's.
- **`firstUsedAt` / `lastUsedAt` come from every timestamp seen in the fold PLUS the prior frontmatter — never from the retained list.** The cap drops the oldest rows, so a retained-list minimum would walk `firstUsedAt` forward on every trim and make a long-running skill look freshly started. The prior file's own bounds are the only surviving record of invocations already trimmed away.
- **`trimmed` is sticky**: `(prior.trimmed) || merged.length > kept.length`. A file that has announced a trim keeps saying so.
- **`detection: "heuristic"` is sticky**: once a skill has been recorded as inferred it stays inferred even if a later pass happens not to say so. Downgrading to "observed" would overstate what is known.
- **`plugin` prefers this pass's value, falling back to the prior file's.**

### The usage fold: replace per session, add across sessions

`foldUsage` starts from the prior `usageBySession`, then:

- With both `use.usage` and `use.sessionKey`, it **overwrites** that one session's entry. Attribution recomputes a whole session from line 0 on every pass, so re-scanning session A must replace A's entry rather than add to it, while a first pass over session B must add alongside A.
- With `use.usage` but **no** `sessionKey`, it logs at debug and **ignores the number**, retaining the existing split. Overwriting the whole split in favour of one unattributable figure would discard known-good per-session data.
- With no keys at all it returns `{}` — no `usage`, no `usageBySession`.

It then re-totals across every key into `usage`, and **`confidence` degrades to the weakest contributor**: a total mixing an attributed session with an estimated one is only as trustworthy as the estimate.

### Parsing back: degrade, never throw

`parseSkillMarkdownFromString` returns `null` only when the `---`-delimited frontmatter block is missing or when `source` / `skill` are not both strings. Everything else degrades:

- A **single** unparseable frontmatter line is skipped (`JSON.parse` failure swallowed) rather than voiding an otherwise readable history.
- `invocationCount` falls back to the retained row count rather than 0, so a corrupt-frontmatter file cannot report "never used" while its rows sit right there.
- `entryPaths` falls back to `[]`; `firstUsedAt` / `lastUsedAt` to `""`; `usage` / `usageBySession` / `detection` are dropped unless they type-check.
- `trimmed` is recovered from the presence of the sentinel comment anywhere in the file — which also strips it from ever accumulating on re-render.

`parseInvocationLine` requires a `- ` prefix and an ISO-shaped leading timestamp (`/^\d{4}-\d{2}-\d{2}T/`); without one the line is **not a row**, because the timestamp IS the identity and a row without one cannot participate in dedupe. `args` is then lifted out FIRST, matched as a JSON string literal (`/args: ("(?:[^"\\]|\\.)*")/`) and **excised from the tail before** the remainder is split on ` · `. Splitting first would tear a value containing the separator in half and read its contents as sibling fields. Unrecoverable `args` text is dropped while the invocation itself still counts.

### `upsertSkillEntry` — one row per skill

Everything runs inside `withPlansLock(cwd)`:

1. `writeSkillMarkdown` folds and writes the file.
2. Load the registry and read the existing row for `<source>:<skill>`.
3. Build the next row from **the fold**, not from the incoming pass. Reading `use.usage` here was an under-count — the last session scanned won.
4. **Never resurrect a guard.** `commitHash` is carried as `existing?.commitHash ?? null` and `contentHashAtCommit` is carried only if it was there; archival owns those fields. What makes a row uncommitted again is the counters growing past `archivedTotals`, not the guard being cleared.
5. **Seed a legacy baseline.** A row guarded by a version that predates `archivedTotals` gets one built from its **pre-fold** counters (`archivedTotalsOf(existing)`) — exactly what that archive froze. Without this the row would keep reading as fully committed forever.
6. **Near-write reload.** The registry is loaded a second time immediately before saving and only this mapKey is overwritten (`{ ...freshRegistry, skills: { ...skillsOf(freshRegistry), [mapKey]: next } }`), so a concurrent writer touching other mapKeys between the two loads is preserved. The spread form also carries every other artifact map without naming it.

A `withPlansLock` timeout does not abort the write — it logs a warning and proceeds best-effort, relying on the per-key merge above to mitigate.

### Normalization must pass `skills` through untouched

`normalizePlansRegistry` strips legacy fields from `plans` / `notes` and **drops guarded rows** from `references` (a committed reference row always carries `commitHash`, and reference rows are deleted rather than guarded). Skills take neither treatment: they are a post-legacy artifact type with no dead fields and no `ignored` rows, and they follow the plan/note lifecycle where **guarded rows MUST survive**. Copying the reference branch here would delete every archive guard on load.

## State Transitions

Per skill file / registry row:

| From | Event | To | Notes |
|---|---|---|---|
| No file, no row | First `upsertSkillEntry` for `<source>:<skill>` | File written, row created with `commitHash: null` | `invocationCount` = number of invocations in the pass. |
| File + row | A pass carrying only already-seen `at` values | Row unchanged; **write skipped** if bytes are identical | Count untouched; a fragment may still be upgraded in place, which does change the bytes. |
| File + row | A pass carrying new `at` values | `invocationCount += freshCount`, bounds widened, detail re-sorted | Detail trimmed to 20 if it overflows; `trimmed` set and stays set. |
| Detail at cap | Any further fresh invocation | Oldest rows dropped from detail, count still exact | `firstUsedAt` is preserved from the prior frontmatter, not recomputed from the retained list. |
| Row with `usageBySession[k]` | Re-scan of session `k` | `usageBySession[k]` **replaced**, `usage` re-totalled | Confidence re-derived across all sessions. |
| Row with `usageBySession[k]` | First scan of a different session `j` | `usageBySession[j]` **added**, `usage` re-totalled | |
| Row, `commitHash: null` | Archival (spec 322) | Guarded: `commitHash`, `contentHashAtCommit`, `archivedTotals` set | The file and the row are **not** cleared. |
| Guarded row | A later `upsertSkillEntry` | Counters grow; guard fields preserved verbatim | The row is uncommitted again by arithmetic, not by clearing the guard. |
| Guarded row, no `archivedTotals` (legacy) | A later `upsertSkillEntry` | Baseline seeded from pre-fold counters | Makes the first archive after upgrade carry the new increment only. |

## Notable Behavior

- **Any field-by-field rebuild of `PlansRegistry` that omits `skills` erases the whole skill registry, silently, with nothing failing to compile.** Every artifact map on `PlansRegistry` is optional, so this is a type-clean bug. It shipped: `finalizeReferenceArchive` (`cli/src/hooks/QueueWorker.ts`) and the VS Code reference-removal path (`vscode/src/core/ReferenceService.ts`) both dropped the map, so **every commit that archived a reference wiped the skill registry one step before skill archival read it** — a symptom that pointed at the skill subsystem rather than at a reference write. Three such rebuilds were patched (those two plus `upsertReferenceEntry` in `SessionTracker.ts`). A comment enumerating the writers by name had already gone stale once, so the rule is now enforced by `cli/src/core/PlansRegistryWriters.test.ts`, which scans `cli/src` and `vscode/src` for literal rebuilds and fails until every one accounts for every entry in its `ARTIFACT_MAPS` list. Spread rebuilds (`{ ...registry, plans: … }`) preserve maps they never name and are exempt — prefer them. (Surprising; the reason this is a test and not a doc comment.)
- **`invocationCount` carries a known bounded imprecision.** It advances by the number of incoming invocations not present in the *retained* detail list, and invocations already trimmed past the cap are no longer available to dedupe against — so a cursor rewind that re-reads them counts them a second time. The alternative, deriving the total from the retained list, would under-report by the whole trimmed tail on every capped skill, which is the worse error. Rewinds are rare (version skew, catch-up) and the drift is bounded by what was trimmed.
- **The working file is load-bearing, not a convenience cache.** Three ways: `contentHashAtCommit` hashes THIS file, so with no file the archive guard is inert; archival is a byte-for-byte COPY of it rather than a re-render from the row, which keeps the display format in one place; and it exists from the moment of capture, so working state is inspectable on disk without an IDE.
- **The file is never cleared or zeroed at archive time**, even though that is the obvious way to answer "what is uncommitted". It is the only dedup ledger: main transcripts ride a monotonic mark, but subagent files are re-scanned in full on every pass by design (spec 320), so invocations are re-emitted and deduped by `at` against what is already on disk. Clearing it would make a re-scan of an already-archived transcript read as fresh usage. Spec 322 subtracts a stored baseline instead.
- **A skill entered again after being committed keeps ACCUMULATING in the same row.** This is the property that separates skills from plans and notes throughout the subsystem — it is why the guard alone cannot answer "what is uncommitted", why `detectActiveSkillsForBranch` and the VS Code panel use `uncommittedDelta` instead of the guard predicate, and why `archivedTotals` exists.
- **The stem's hash suffix is unconditional, not a fallback.** It reads worse than a plain substitution and is the only thing making the mapping injective; the readable prefix is free to collide.
- **The invocation row's `args` is JSON-encoded specifically so the row can be parsed, and the parser must lift it out before splitting.** This is the one ordering constraint in the format: an `args` value containing ` · ` is legitimate host-supplied text, and a naive split-then-scan reads its contents as sibling `body:` / `failed` fields.
- **A corrupt file and a missing file are the same outcome by construction.** `parseSkillMarkdownFromString` returning `null` collapses to `undefined` at the call site, so the pass folds against "no prior history" and rewrites the file — losing the unreadable history but never throwing into a hook and never leaving the skill uncapturable.

## Shared Behavior

- The scanners that produce a `SkillUse` are owned by spec 320 (Claude), spec 325 (OpenCode) and spec 326 (Codex); the per-source dispatch table `getSkillScanner` is described in spec 320.
- The `SkillUsage` figures folded here are computed by spec 321, and corrected after a conversation detach by spec 306.
- `commitHash`, `contentHashAtCommit`, `archivedTotals` and `uncommittedDelta` are owned by spec 322; this spec only preserves them.
- Rendering skills onto a commit summary, the PR-wide aggregate, and the Memory Bank `skills--<hash8>.md` visible file are owned by spec 323.
- The VS Code Context list projection (`detectSkills` / `SkillInfo`) and the per-skill exclusion checkbox are owned by spec 324.
- `plans.json`, `withPlansLock`, `loadPlansRegistry` / `savePlansRegistry` and the sibling plan / note / reference maps are owned by specs 29, 42, 43 and 179; the reference markdown store (spec 179) is the format precedent this file follows.
- The exclusion selection store that supplies `exclusions.skills` is owned by spec 188.
