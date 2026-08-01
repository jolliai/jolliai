# 323. Skill-Usage Aggregate Rendering

## Topic Statement

One module — [`cli/src/core/SkillsAggregateMarkdown.ts`](../cli/src/core/SkillsAggregateMarkdown.ts) — owns every rendering of a captured skill set, on both sides of the commit boundary. It exports a token-breakdown **table** (`buildSkillsTable`), a one-line **summary label** (`buildSkillsSummaryLabel`), the two **documents** that wrap the table (`buildSkillsAggregateMarkdown` for a commit, `buildLiveSkillsMarkdown` for the working session), and the aggregate's file name (`skillsAggregateFileName`). The renderers take `SkillTableRow` — a four-field structural type deliberately **narrower** than either concrete skill type, so the archived `SkillCommitRef` (spec 322) and the VS Code panel's live `SkillInfo` projection (spec 324) are both assignable to it and produce a byte-identical table. That is the whole point: a user who sees one table before committing and a differently-shaped one after has to re-learn the surface for no reason. Every display rule here is about **not overstating what is known** — an unattributed skill renders four em dashes rather than zeros, an estimated figure carries a `~` on every cell rather than the total alone, and a heuristically-inferred row carries a `†` plus a spelled-out footnote. The renderers are pure functions of their inputs; they read no config, touch no disk, and hold no state.

## Scope

**In scope:**
- The `SkillTableRow` contract and why it is narrower than both concrete types.
- The table: columns, row ordering, the em-dash / `~` / `†` display rules, the compact number format, and the Markdown cell escaping (including why the substitution order is load-bearing).
- `buildSkillsSummaryLabel` — the one-line label every Context surface shows — and its deliberate omission of the `†` marker.
- The two wrapper documents (`buildSkillsAggregateMarkdown`, `buildLiveSkillsMarkdown`) and the `skills--<hash8>.md` file name.
- Which surfaces consume which export.

**Out of scope:**
- Where skill rows come from and how they accumulate in `plans.json.skills` (owned by spec 319).
- Claude and Codex/OpenCode extraction (owned by specs 320, 325, 326).
- What `SkillUsage.confidence` means and how the token figures are attributed (owned by spec 321).
- Archiving `SkillCommitRef`s onto a commit, and the `FolderStorage` write/heal/delete lifecycle of `skills--<hash8>.md` (owned by spec 322).
- The VS Code Context row, its hover card, and the commands that open these documents (owned by spec 324).
- The Memory Bank visible/hidden layer split and manifest bookkeeping (owned by specs 02, 151, 300).

## Data Contracts

### `SkillTableRow` — the render contract

```ts
interface SkillTableRow {
    readonly skill: string;
    readonly invocationCount: number;
    readonly usage?: SkillUsage;
    readonly detection?: "heuristic";
}
```

Four fields, and nothing else. `SkillCommitRef` (the archived snapshot behind `skills--<hash8>.md`) carries `archivedKey`, `source`, `plugin`, `entryPaths`, `firstUsedAt`, `lastUsedAt` and `usageBySession` on top of these; `SkillInfo` (spec 324's panel projection) carries `kind`, `mapKey`, `sourcePath`, `lastModified` and the same timestamps. Neither is imported here — both are **structurally assignable** to `SkillTableRow`, so one renderer serves both without either side depending on the other's shape. Widening this interface to anything the archived and the live projections do not both carry would fork the table.

`SkillUsage` (`{ input, output, cached, confidence: "attributed" | "estimated" }`) and the `detection: "heuristic"` marker are defined in [`cli/src/Types.ts`](../cli/src/Types.ts) and owned by specs 321 and 319 respectively. The two are deliberately different axes and this module treats them as such: `confidence` qualifies a **token figure**, `detection` qualifies the **invocation record**. A heuristic source reports no tokens at all, so the row it produces is both dashed and daggered.

### The rendered documents

| Export | Wrapper | Consumed by |
|---|---|---|
| `buildSkillsTable(rows)` | none — returns `string[]` so callers splice it under their own heading | both documents below |
| `buildSkillsAggregateMarkdown(summary, refs)` | frontmatter + `# Skills used — <hash8>` + italicised commit message | `FolderStorage.generateSkillsAggregate` writes it to `<branchFolder>/skills--<hash8>.md`; the VS Code `previewCommittedSkills` command renders it into an untitled document |
| `buildLiveSkillsMarkdown(rows)` | `# Skills used — uncommitted` + a one-line explanation | the VS Code `openSkillsAggregate` command, into an untitled document |
| `buildSkillsSummaryLabel(rows)` | none — one line of text | `SummaryMarkdownBuilder` (the exported memory Markdown's `- Skills used — …` row) and `SummaryHtmlBuilder` (the VS Code memory-detail panel's aggregate row) |
| `skillsAggregateFileName(hash8)` | — | `FolderStorage` (write, heal, delete) |

`buildSkillsTable` returns **lines rather than a joined string** precisely so those two wrappers can splice it without re-splitting.

## Behavior

### The table

Header is fixed at six columns — `Skill | × | Tokens | Input | Output | Cached` — followed by the standard `|---|` separator row.

`Tokens` is kept **alongside** the three-way split rather than replaced by it. The rows are ordered by that total and `buildSkillsSummaryLabel` summarises by it, so dropping the column would leave both the sort key and the summary figure with no counterpart in the table the reader is looking at.

**Ordering** is heaviest total first, then by skill id ascending. The tie-break is a **raw `<` / `>` comparison, not `localeCompare`** — the aggregate file is regenerated on every write, and a locale-sensitive collation would reorder the rows under a different ambient ICU locale and show up as a spurious diff for a colleague. (The same reasoning as the code-point ordering of the push-control store in spec 310.)

**Per-row rendering:**
- The skill id is escaped (see below) and, when `detection === "heuristic"`, gets a trailing ` †`.
- `invocationCount` is printed verbatim.
- The four token cells come from `tokenCells`.

**The footnote.** If *any* row carried the `†`, a blank line and one footnote line are appended after the table:

> `† Inferred from a file read rather than an observed invocation: the count is per session, and a human reading the skill file looks the same.`

Spelled out rather than left as a bare dagger: a host with no skill tool leaves only a file read behind, which cannot tell an agent using a skill from a human reading it and cannot count entries, so the row must not be read as an observation (spec 326).

### Token cells

`tokenCells(row)` returns exactly four strings, in the order `total, input, output, cached`:
- When `usage` is **absent**: `["—", "—", "—", "—"]`. All four dash **together**, never partially — a row mixing `—` with zeros would read as "measured, and it was nothing" for the zeroed components.
- When `usage` is present: each of the four numbers goes through `formatCompact`, carrying a `~` marker when `confidence !== "attributed"`. The marker rides **every** component, not just the total: it qualifies the measurement, not the magnitude.

`totalOf(row)` is `input + cached + output` (0 for an unattributed row, which is what makes such rows sort last).

`formatCompact(n, marker)` is `<marker><n>` verbatim below 1000, and `<marker><n/1000 to one decimal>k` at or above it — e.g. `93.8k`, `~12.3k`.

### Cell escaping

`escapeCell` applies three substitutions and **the order of the first two is load-bearing**:

1. `\` → `\\` **first**. Escaping only the pipe was incomplete: for an id containing `\|`, appending a backslash yields `\\|`, which Markdown reads as an escaped backslash followed by a **live** pipe — so the "escape" produced exactly the cell split it was added to prevent. Running this substitution second would instead double-escape the backslashes the function itself just introduced.
2. `|` → `\|`, now safe because every pre-existing backslash is already inert.
3. `[\r\n]+` → a single space. A newline is worse than a pipe: it terminates the table row outright, so every remaining row is parsed as body text.

This is not defensive padding. A skill id is host-supplied text read out of another program's transcript, and each of these characters breaks the table **silently** — the row still renders, just with its cells misaligned against the header.

### The summary label

`buildSkillsSummaryLabel(rows)` produces `N skill` / `N skills`, plus ` · <total> tokens` **only when at least one member attributed something**. There is deliberately no figure when nothing was attributed: a rendered `0` would read as a measurement of nothing rather than an absence of measurement. One estimated member marks the whole sum (`~`), because the marker qualifies the figure and cannot be dropped just because the other members were measured.

The `†` inferred marker is **deliberately excluded** from this label. Each consuming surface spells the qualification its own way — a dagger where a footnote is within reach, the words "some inferred" where it is not — so the caller appends its own. `SummaryMarkdownBuilder` and `SummaryHtmlBuilder` both append ` · some inferred`; spec 324's tree row appends ` †`.

### The two documents

`buildSkillsAggregateMarkdown(summary, skills)` emits, in order: a frontmatter block (`type: skill-usage`, `commitHash`, `branch`, `generatedAt` — all read off the `CommitSummary`), a blank line, `# Skills used — <hash8>` where `hash8` is the commit hash's first eight characters, the commit message rendered in italics on its own line, and then the table. The result ends in a trailing newline.

`buildLiveSkillsMarkdown(skills)` emits `# Skills used — uncommitted`, the italicised line `_Captured in this working session. Archived onto the memory when you commit._`, and the same table. **No frontmatter and no commit hash**, because neither exists yet — this is a view of the working registry (spec 319), not a stored artifact, and it is opened as an untitled document rather than written to disk. Once the work is committed the same rows reappear as `skills--<hash8>.md` with the commit's identity attached.

`skillsAggregateFileName(hash8)` is `skills--${hash8}.md`. The double hyphen matches the `plan--<slug>.md` convention already used in the Memory Bank's visible layer (spec 151), so the aggregate sorts and reads as a generated sibling rather than as a memory document.

## Notable Behavior

- **The render contract is narrower than both of its inputs on purpose.** `SkillTableRow` is not an abstraction over `SkillCommitRef` and `SkillInfo` — it is the intersection of what the table needs. Adding a field that only one of them carries would break structural assignability for the other and silently fork the table into two. (Central design point; the reason this module imports neither concrete type for its row parameter.)
- **The module lives outside `FolderStorage` deliberately.** Rendering can therefore be tested without standing up a storage backend, and any future human-facing surface can reuse the table without importing a storage class. The VS Code extension already does exactly this, importing all four builders across the package boundary via the bundled CLI path.
- **`localeCompare` is avoided for the same reason the push-control store avoids it.** The output is regenerated on every write and lands in a user-visible file tree, so ordering must not depend on ambient locale. (Surprising only if the sort is read as a display concern rather than a file-content one.)
- **Absent is not zero, anywhere.** Both the table (four dashes) and the summary label (no figure at all) refuse to render a zero for an unattributed skill. Codex's heuristic capture attributes nothing at all (spec 326), so this is the common case, not an edge one.
- **The `~` estimate marker rides every cell; the `†` inferred marker rides only the skill name.** They mark different things: `~` says the number is positional rather than host-attributed (spec 321), `†` says the invocation itself was inferred from a file read. A row can carry both, one, or neither.
- **The footnote is emitted only when a row earned it,** and it is appended after a blank line so it renders as body text under the table rather than as a malformed row.
- **`buildSkillsSummaryLabel` is exported from this file, next to the table, so the summary and the thing it summarises cannot disagree about how a token count is formatted.** Both go through `formatCompact`. That guarantee stops at the package boundary, though: `PlansTreeProvider.formatCompactTokens` (spec 324) is a **second, independent copy** of the same rule — `<1000` verbatim, otherwise one decimal plus `k`, marker prefixed — used for the Context row's description and its hover payload. Nothing links the two, so a change to the format here must be mirrored there by hand. (Surprising; the module docstring's "cannot disagree" guarantee covers only the exports of this file.)
- **The escaping order was a real bug, not a hypothetical.** `\|` in a skill id produced a live pipe under the pipe-only version, splitting the cell the escape existed to protect. Recorded here because the two substitutions look commutative and are not.

## Shared Behavior

- The `plans.json.skills` registry, `SkillEntry`, `archivedTotals`, and the per-skill working Markdown files are owned by spec 319.
- Claude skill invocation extraction is owned by spec 320; OpenCode by spec 325; Codex by spec 326.
- `SkillUsage`, its `confidence` axis, per-session splits, and detach-time correction are owned by spec 321 (and spec 306 for the detach path itself).
- Archival onto a commit (`SkillCommitRef`, `archivedKey`, the orphan-branch copy) and the `FolderStorage` write / heal / delete lifecycle of `skills--<hash8>.md` are owned by spec 322.
- The VS Code Context row, hover card, `openSkillsAggregate` / `previewCommittedSkills` commands, and the memory-detail aggregate row are owned by spec 324.
- The Memory Bank's hidden/visible layer split, `MetadataManager` fingerprints, the user-edit guard, and stale-child cleanup are owned by specs 02, 151, 186 and 300.
- The exported memory Markdown that carries the `- Skills used — …` row is owned by the summary-rendering specs (12, 15); this spec owns only the label it embeds.
