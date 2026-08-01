# 324. VS Code Skills Context Row

## Topic Statement

Every skill captured in the working session is represented in VS Code as **one collapsed "Skills used" row**, not one row per skill. A session routinely enters a dozen skills, and none of the Context surfaces — the sidebar's live Context list, the Next Memory review panel, an expanded memory's evidence group, the memory-detail panel — can absorb a dozen affordance-free rows without burying the plans, notes and references those lists exist to show. The row is a genuine fourth artifact kind alongside plan / note / reference, but it is the only one whose serialized `id` is a **sentinel** (`SKILLS_GROUP_ID = "__skills__"`) rather than an artifact key, so every consumer that addresses rows by id must special-case it and go back to the store for the real `plans.json.skills` keys. Per-kind behaviour that used to live in ternary chains — badge, checkbox class, id attribute, toggle message, open message, inline actions, edit label — now lives in one injected decision table, [`CONTEXT_ROW_KINDS`](../vscode/src/views/ContextRowKinds.ts), which both webview script builders read; a kind with no entry resolves to `null` and degrades to a visibly inert identity-only row instead of silently rendering as some other kind. The read path is the one place where skills differ from references: a reference row is deleted when its commit lands, a skill row is **guarded** and keeps accumulating, so the panel must filter by the uncommitted delta rather than returning everything.

## Scope

**In scope:**
- `SkillInfo`, the `PlansOrNote` skills arm, the `SkillsHover` / `SkillsHoverRow` wire payloads, and `SKILLS_GROUP_ID`.
- `detectSkills` — the panel read path, its delta filter, and which figures come from the delta versus the row.
- Bridge and store plumbing: `listSkills()`, `PlansStore`, and the merge / empty computation.
- `SkillsGroupItem` — label, description, icon, `contextValue`, command, hover payload, and the `isSelected` rule.
- The `CONTEXT_ROW_KINDS` table and how both webviews resolve every per-kind decision from it.
- The checkbox write path (webview dispatch → host handler → the `"skills"` exclusion set) and Select-All / Deselect-All.
- The hover card's content and its single action.
- `jollimemory.openSkillsAggregate` (live) and `jollimemory.previewCommittedSkills` (committed), and why both open untitled documents.
- The committed memory's evidence `kind: "skill"` row and its `kb:openEvidenceSkills` route.
- The OpenCode skill-discovery tick injected into the 60 s Active Conversations refresh.

**Out of scope:**
- The `plans.json.skills` registry, `SkillEntry`, `archivedTotals`, and `uncommittedDelta`'s own definition (owned by spec 319).
- Skill capture from Claude (spec 320), OpenCode (spec 325), Codex (spec 326).
- Token attribution and `SkillUsage.confidence` (owned by spec 321).
- Archival onto a commit and the `skills--<hash8>.md` file (owned by spec 322).
- The Markdown table and summary label these surfaces render (owned by spec 323).
- The exclusion store's file format, locking and `setAllExcluded` semantics (owned by spec 188).
- The Context list's plan / note / reference rows and their own hover cards (owned by specs 114, 187).
- The Next Memory review panel's overall structure and AI relevance overlay (owned by specs 247, 258).

## Data Contracts

### `SkillInfo` — the panel projection

Declared in [`vscode/src/Types.ts`](../vscode/src/Types.ts) with a discriminated `kind: "skill"`. It carries `mapKey` (the `plans.json.skills` key, `<source>:<skill>`), `source`, `skill`, optional `plugin`, `entryPaths`, `invocationCount`, `firstUsedAt`, `lastUsedAt`, optional `usage`, `sourcePath`, optional `detection: "heuristic"`, and `lastModified`. `lastModified` mirrors `lastUsedAt` so a skill sorts against plans / notes / references in one list, exactly the way `ReferenceInfo` mirrors `updatedAt`. `usage` is **absent, never zero**, when the source could not attribute tokens.

`SkillInfo` is structurally assignable to spec 323's `SkillTableRow`, which is what lets the live document and the committed file share one renderer.

### The merged-list arm

[`PlansDataService`](../vscode/src/services/data/PlansDataService.ts) widens `PlansOrNote` with a fourth arm carrying an **array**:

```ts
| { readonly kind: "skills"; readonly skills: ReadonlyArray<SkillInfo> }
```

The plural arm is the collapse: the other three arms carry one artifact each.

### Hover payloads

[`SidebarMessages.ts`](../vscode/src/views/SidebarMessages.ts) declares `SkillsHover` (`count`, optional `totalTokensLabel`, optional `totalBreakdownLabel`, `anyInferred`, `relativeDate`, `rows`, `overflow`) and `SkillsHoverRow` (`skill`, `invocationCount`, optional `tokensLabel`, optional `breakdownLabel`, `inferred`). It is **group-shaped, not skill-shaped**: there is one row for N skills, so there is no per-skill hover and no `mapKey` to open — the card's action opens the whole aggregate.

Every token figure crosses the wire **pre-formatted as a string**, including the `~` estimate marker and the three-way `input · output · cached` split. The host already owns the compact formatting; splitting that decision across the message boundary is how the card and the document it previews would drift apart. `totalBreakdownLabel` is present exactly when `totalTokensLabel` is, and `breakdownLabel` exactly when `tokensLabel` is — an unattributed row has no components either.

`anyInferred` is true when at least one **member** was inferred. It qualifies some rows rather than the group, which is why the card marks individual rows with `†` instead of labelling the whole card.

### `SKILLS_GROUP_ID`

`export const SKILLS_GROUP_ID = "__skills__"` lives in `SidebarMessages.ts`, beside the wire types, **not** in `PlansTreeProvider` — the provider imports `vscode` at runtime, so consumers that must not (`SelectAllSelection` and its tests) could not reach a constant declared there. Anything that treats a Context row's id as an artifact key must special-case it: writing this string into an exclusion set matches no skill and silently excludes nothing.

### `CONTEXT_ROW_KINDS`

[`ContextRowKinds.ts`](../vscode/src/views/ContextRowKinds.ts) exports one record keyed by `contextValue`, each entry declaring `badge`, `cls`, `attr`, `msg`, `idKey`, `openMsg`, `openIdKey`, `actions`, `editLabel`, `editCmd`, `editMsg`, `removeCmd`, `pinKind`. The `skills` entry is:

| field | value | why |
|---|---|---|
| `badge` | `"skill"` | drives the letter and the `.mem-ctx-badge--skill` hue |
| `cls` | `"jm-skill-check"` | its own checkbox class, so dispatch cannot confuse it with another kind |
| `attr` / `idKey` / `openIdKey` | `null` | the row carries no artifact id |
| `msg` | `"branch:toggleSkillSelection"` | writes into the `"skills"` exclusion set |
| `openMsg` | `"branch:openSkillsAggregate"` | opens the live table |
| `actions` | `[]` | nothing to pin, edit or remove — the checkbox is the only write |
| `editLabel` / `editCmd` / `editMsg` / `removeCmd` / `pinKind` | `null` | follows from the empty action set |

Fields a given surface ignores are still declared for every kind: the Next Memory panel ignores `cls` / `attr` / `pinKind`, but a kind that omitted them would break the sidebar the moment someone reused the table there.

## Behavior

### Read path — `detectSkills`

[`vscode/src/core/SkillService.ts`](../vscode/src/core/SkillService.ts) loads `plans.json`, walks `registry.skills`, and for each row computes `uncommittedDelta(entry)` (imported from the CLI, spec 319). A row whose delta is `undefined` is **skipped**. The survivors are projected and sorted **newest-first** by `lastModified`.

The filter is the asymmetry with references, and it is load-bearing. A reference row is deleted when its commit lands, so every row in that registry is by definition uncommitted and `detectReferences` can return all of them. A skill row is **guarded** instead — archival leaves it in place so a later re-entry is still detectable — so returning every row would put every skill ever used back on the panel as if it were fresh working state.

The predicate is imported rather than restated: a local copy of the rule drifted out of sync once already and hid every re-used skill from this panel. It is also **not** the plan/note guard check — a plan is archived once and finished, while a skill can be entered again afterwards and keeps accumulating, so "uncommitted" here means *the counters have moved past the archived baseline*.

**The delta is what gets projected, not merely what decides visibility.** `invocationCount` and `usage` come from the delta; `firstUsedAt`, `lastUsedAt` and `lastModified` come from the **row**. That split is exactly what archival stamps: `SkillArchivedTotals` carries no time fields, and spec 322's `storeSkills` likewise takes its ref's timestamps from `entry.firstUsedAt` / `entry.lastUsedAt`. Projecting the row's running counters instead would overstate a re-used skill by everything already frozen onto earlier commits — this panel previews what the *next* commit will carry.

### Plumbing — bridge and store

`JolliMemoryBridge.listSkills()` delegates to `detectSkills(this.cwd)`. `PlansStore` holds a `skills` cache beside `plans` / `notes` / `references`, clears it when disabled, and reads it in `refresh()` through the same optional-call shape references use (`this.bridge.listSkills?.() ?? Promise.resolve([])`) so an older host or a test fixture without the method still renders the rest of the Context list. `skills` participates in both `PlansDataService.mergeByLastModified` and `PlansDataService.isEmpty`.

### Merge and ordering

`mergeByLastModified` pushes **at most one** `{ kind: "skills", skills }` item, and only when the array is non-empty. Sorting is by `lastModified` descending; on a tie the kind rank is `plan → note → reference → skills`, so **skills rank last**: they are metadata about *how* the work happened, while the other kinds are what it was *about*. The group's own timestamp is its **newest** member's, computed by a reduce rather than an index — the incoming array's order is the registry's, not a sorted one — so a skill entered just now pulls the row up the way any freshly-touched artifact rises.

Both `lastModifiedOf` and `kindRank` switch **exhaustively** with no default arm. They used to end in a bare `return item.reference…` / `return 2`, which silently mis-read any newly added kind as a reference: the wrong timestamp field (so `undefined` at runtime) and the wrong sort rank, with nothing failing to compile.

### The tree item

`SkillsGroupItem` (in [`PlansTreeProvider.ts`](../vscode/src/providers/PlansTreeProvider.ts)) is constructed from the member array:

- **label** `Skills`; **description** `N skills · <total> [†]` — member count, the summed compact token figure when anything was attributed, and a trailing ` †` when any member is heuristic. The dagger rather than the word "inferred": on a group row the flag qualifies *some* members, and `†` is exactly what the aggregate table and the hover card use for the same qualification, so the mark the user sees is the one they can look up one hover away.
- **icon** `zap`, tinted `charts.purple`. A skill is an *act*, not a document: `zap` reads as "this ran" where the file/lock icons the other kinds use read as "this is stored".
- **contextValue** `skills`; **command** `jollimemory.openSkillsAggregate`.
- **`skillInfos`** — every member, in registry order, so callers that need the real keys have them.
- **`skillsHover`** — members sorted heaviest-first (`compareSkillsByWeight`, the aggregate table's own ordering, so the card and the opened document read in the same order), capped at `SKILLS_HOVER_ROW_CAP = 8`, with `overflow` counting what was hidden.

Summation goes through one accumulator, `sumSkillsUsage`, which produces all four figures **and** the `~` marker in a single pass — `anyEstimated` qualifies the whole result, so deciding it per column is how a card ends up marking its total as an estimate while presenting the three parts it was summed from as measurements. The same helper is called with a single-element array for each per-member row, which keeps the row and the group summary on literally one code path.

### Serialization and the selection rule

`PlansTreeProvider.serialize()` maps each item to a `SerializedTreeItem` with an `idHint`. For the skills row the hint is `SKILLS_GROUP_ID`, and `isSelected` is computed as:

```ts
isSelected = it.skillInfos.every((s) => !(this.exclusions.skills?.has(s.mapKey) ?? false));
```

So the aggregate reads as checked **only when every member is un-excluded**. `skills` is optional on `CommitExclusions` — a selection file written before skills were selectable has no such field, and absent means nothing was excluded, hence the `?? false`. `every` also keeps a partially-excluded set from reading as fully kept.

`skillMapKeys()` exists precisely because the sentinel cannot be reversed into artifact keys: it returns `store.getSnapshot().skills.map((s) => s.mapKey)` for the callers that need to *write* per-skill exclusions.

### Rendering, in both webviews

`CONTEXT_ROW_KINDS` is injected as JSON into **both** [`SidebarScriptBuilder`](../vscode/src/views/SidebarScriptBuilder.ts) and [`NextMemoryScriptBuilder`](../vscode/src/views/NextMemoryScriptBuilder.ts). Each resolves `contextRowKind(item.contextValue)`; a lookup miss yields `null` and the row degrades to **identity-only** — badge and title, no checkbox, no actions, no click.

- **Badge** comes from `rowKind.badge` (references additionally key their letter/hue off `referenceHover.source`).
- **Checkbox** is rendered with `rowKind.cls`, and the id attribute is written **only if `rowKind.attr` is non-null** — the skills aggregate has none.
- **Inline actions** come from `rowKind.actions`, not from a ternary on `contextValue`. Skills declare none, so no pin / edit / remove button is rendered. A button that shipped anyway would post the sentinel as a key the host cannot resolve and fail silently, which is exactly what the pre-table code did.
- **Row click** posts `{ type: rowKind.openMsg }`, adding the id field only when `openIdKey` is non-null.
- **Context menu** for `skills` offers a single entry, `Open Skills Used`, mirroring the row click — no Edit / Remove, because the row stands for N skills rather than a document and leaving them out of the memory is the checkbox's job, not a destructive delete.

This table replaced *independent* ternary chains on the two surfaces, with **different** defaults: the sidebar's ended in `plan`, the Next Memory panel's in `reference`. The skills row shipped hitting both — an "Edit Plan" tooltip on one surface, and on the other a checkbox posting `branch:toggleReferenceSelection` with `__skills__` as a `mapKey`.

### The checkbox write path

1. The webview's checkbox-change handler iterates `CONTEXT_ROW_KINDS`, matching the checkbox's class against `spec.cls`, then posts `{ type: spec.msg, selected }`. The id field is written **only when `spec.idKey` is non-null** — writing it anyway would post an explicit `undefined` that the host reads as a real, unresolvable key.
2. [`SidebarWebviewProvider`](../vscode/src/views/SidebarWebviewProvider.ts) routes `branch:toggleSkillSelection` to `deps.applySkillCheckbox(msg.selected)` — note the absence of an id parameter.
3. The host handler in [`Extension.ts`](../vscode/src/Extension.ts) is **all-or-nothing**: it calls `bridge.listSkills()`, then `setAllExcluded(workspaceRoot, "skills", skills.map(s => s.mapKey), !selected)`, then refreshes exclusions. Reading the keys here rather than from the message means the write always covers the set **as it stands at click time**.

Writing into the `"skills"` set matters: that is the set `QueueWorker` reads when deciding what to archive. Before this callback existed the row's checkbox posted `togglePlanSelection`, so the key landed in `"plans"` and the exclusion silently did nothing.

### Select All / Deselect All

Both commands in [`SelectAllSelection.ts`](../vscode/src/commands/SelectAllSelection.ts) include skills. The asymmetry: the *verdict* ("is everything already selected?") reads the aggregate row from `serialize()` output like the other three kinds, but the *keys written* come from `ctx.plansProvider.skillMapKeys()`. Mapping `r.id` here as the other three do would write the literal sentinel into the exclusion set, where it matches no skill and silently excludes nothing. Both bugs shipped: filtering skills out left them untouched by the buttons **and** excluded from the all-selected test, so the button's own state could disagree with what the list showed; and in the unified command the aggregate row *was* covered by the `rows.every` verdict but never written, so clicking Deselect All struck the skills row through and then left the skills included.

### The hover card

`renderSkillsHoverCard(rowId, h)` builds, in order: a title row (`skill` badge + "Skills used"), a summary line with the `zap` icon reading `N skills · <total> tokens` (or just `N skills`), an indented muted line carrying `totalBreakdownLabel`, a clock line with `relativeDate`, then one muted line per capped member showing `<skill>[ †]` and `×N · <tokens or —>` with the member's own split on its own indented line, an `…and N more` tail when `overflow > 0`, a `†` explanation line when `anyInferred`, a rule, and a **single** action, `Open Skills Used`, bound to `jollimemory.openSkillsAggregate`. There is no Open-in-Source equivalent — skills have no upstream page.

The splits sit on their own indented lines rather than inline because the card is at most 480 px and a skill id already eats a row, so three figures appended to the line above would wrap mid-figure.

`lookupBranchHoverById` returns `{ kind: "skills", hover }` when the serialized row carries `skillsHover`, and the renderer dispatch is **exhaustive** rather than falling through to the reference renderer — a new kind reaching that default would render with the wrong card and read `h.source` / `h.url` off a payload that has neither.

### Committed memories — the evidence row

When the sidebar pushes an expanded memory's evidence, `SidebarWebviewProvider` emits **one** `kind: "skill"` context entry for the whole commit when `summary.skills` is non-empty:

```ts
context.push({ kind: "skill", id: commitHash, title: `Skills used (${skills.length})` });
```

The `id` is the **commit hash**, not a skill key — the row opens the commit's whole table and no individual skill is addressable there. The webview posts `{ type: "kb:openEvidenceSkills", commitHash, sourceRepoName, sourceRemoteUrl }` — deliberately **not** `branch:openSkillsAggregate`, which renders the LIVE working registry and no longer contains these skills once they are archived. The host tracks `memory_item_opened { item_type: "skill" }` (singular, matching the vocabulary the other four `memory_item_opened` calls and IntelliJ's CommitsPanel use, because the metric joins on that vocabulary) and executes `jollimemory.previewCommittedSkills`.

The memory-detail panel renders its own equivalent single row via `SummaryHtmlBuilder.buildSkillsRow` — badge `S`, title `Skills used`, a meta line from spec 323's `buildSkillsSummaryLabel` plus ` · some inferred`, and a `previewCommittedSkills` link. It is deliberately affordance-free: nothing to edit (the record is a measurement, not a document), nothing to dissociate (the row stands for a set), and no relevance line, because the relevance ranker (spec 258) is never fed skills so a verdict for one cannot exist.

### The two open commands

| Command | Source of rows | Empty case |
|---|---|---|
| `jollimemory.openSkillsAggregate` | `bridge.listSkills()` — the working registry | information message: "No skills have been captured for this working session yet." |
| `jollimemory.previewCommittedSkills(commitHash, …)` | `bridge.getSummaryAnyRepoWithSource(commitHash)` → `summary.skills` | information message: "This memory has no archived skill usage." |

Both render into an **untitled** document (`openTextDocument({ content, language: "markdown" })`, shown with `preview: true`), never a file on disk.

- The live command has no file to open: on disk each skill is its own per-skill Markdown under the working area (spec 319), and the aggregate only becomes a real file once the work is committed. Rendering through spec 323's `buildLiveSkillsMarkdown` keeps the two views identical, so the table does not change shape under the user at commit time.
- The committed command is deliberately **not** routed through `listSkills()`: that reads the working registry, which no longer holds these skills once archived, so the live path would open an unrelated or empty table. It is untitled rather than opening `skills--<hash8>.md` because that file exists only in the Memory Bank's visible layer — absent in orphan-branch-only storage mode, and absent for a foreign repo whose folder this machine may never have seen. Rendering from the summary works in every mode, using the same `buildSkillsAggregateMarkdown` that wrote the file. Its `foreignRepoName` / `foreignRepoUrl` parameters are accepted for signature parity with the other committed-evidence commands but unused, since `getSummaryAnyRepoWithSource` already searches every known repo by hash.

Both empty cases are reachable and are handled with a message rather than an empty table: a commit landing between the panel render and the click empties the live list, and a memory can be squashed or amended away between the evidence push and the click.

### The OpenCode discovery tick

`SidebarWebviewProvider` declares an optional dependency `openCodeSkillDiscovery?: { discover(): void }` and fires it inside its own `try`/`catch`, fire-and-forget, on the same 60 s Active Conversations refresh that drives Codex discovery (spec 180). `Extension.ts` wires it to `discoverOpenCodeSkills(cwd)` after resolving the workspace folder. The impl never rejects and single-flights per cwd (spec 325); the `try`/`catch` is belt-and-braces so a regressed reader can never take down the conversation list the method exists to render.

## State Transitions

| From | Event | To | Notes |
|---|---|---|---|
| No skills captured | first capture lands in `plans.json.skills` | one aggregate row appears | `mergeByLastModified` pushes the arm only when the array is non-empty; `isEmpty` counts skills. |
| Row visible, all members included | checkbox unchecked | every member's `mapKey` written into the `"skills"` exclusion set | All-or-nothing; keys read from the store at click time. |
| Row visible, some members excluded | `serialize()` | `isSelected: false` | `every` — a partial exclusion never reads as fully kept. |
| Row visible | Select All / Deselect All | all member keys set/cleared together | Verdict from the aggregate row; keys from `skillMapKeys()`. |
| Row visible | the work is committed | delta collapses, row disappears from the live list | `uncommittedDelta` returns `undefined` for the now-archived row; the registry row itself survives (guarded, not deleted). |
| Committed memory expanded | evidence push | one `kind: "skill"` row keyed by commit hash | Reads the archived snapshot, never the working registry. |

## Notable Behavior

- **The skills row's `id` is a sentinel, and three separate consumers had to learn that the hard way.** `SelectAllSelection` (twice), the webview checkbox dispatcher, and the inline-action buttons all default to "the row id is the artifact key". Each now special-cases it, and `skillMapKeys()` exists solely to serve them. (Central design point.)
- **Skills filter on read; references do not.** The difference is a lifecycle difference — deleted-on-commit versus guarded-on-commit — not an optimisation, and collapsing the two read paths would resurrect every skill ever used onto the working panel. (Surprising if the two kinds are assumed symmetric because both are auto-captured.)
- **The panel projects the DELTA's counters and the ROW's timestamps.** Mixing them either way is wrong: the row's counters overstate a re-used skill, and the delta has no time fields to read. The split is chosen to match exactly what archival stamps, so the preview and the commit agree.
- **The hover card for the skills row is currently unreachable in the sidebar.** `renderSkillsHoverCard` exists, `skillsHover` is serialized to the webview, and the renderer dispatch handles `kind: "skills"` exhaustively — but the Context tab's `mouseover` listener returns early unless `data-context` is `plan`, `note` or `reference`, so the `skills` row never reaches the dispatch. The `SkillsGroupItem.tooltip` MarkdownString is no fallback either: the extension contributes only a **webview** view (`jollimemory.mainView`), with no native `TreeView`, so `tooltip` is inert for every kind. In practice the row's affordances today are its description text, its click, and its context menu. (Documented as-is; the gate is a one-line omission, not a design decision anything else depends on.)
- **Neither open command is palette-visible.** `jollimemory.openSkillsAggregate` and `jollimemory.previewCommittedSkills` are registered but absent from `contributes.commands`, so they exist only as programmatic invocations (row click, hover action, evidence route). That is deliberate and the [contract guard](../vscode/src/CommandManifestContract.test.ts) asserts only the manifest→registration direction: a declared-but-unregistered command is palette-visible and throws when invoked, while a registered-but-undeclared one is a normal working command. The guard exists *because* of this feature — a previously-shipped `jollimemory.openSkillMarkdown` manifest entry outlived the inline edit action it belonged to, leaving a palette command that could only throw, and was removed.
- **`SKILLS_GROUP_ID` lives with the wire types, not with the tree provider, for an import reason.** `PlansTreeProvider` imports `vscode`; `SelectAllSelection` and its tests must not. (Surprising placement with a concrete cause.)
- **The per-kind decision table is a two-surface contract.** Adding a Context kind is a one-line change in `ContextRowKinds.ts`, not a hunt through two script builders and seven ternary chains — and an unknown kind now degrades to an inert row rather than impersonating whichever kind that surface's default happened to be.
- **Token figures cross the message boundary pre-formatted.** The webview never sees a raw number for skills, so the `~` marker, the compact `k` form and the split-line ordering are decided once, host-side.
- **The all-or-nothing checkbox is a consequence of the collapse, not a limitation.** There is one row, so there is one decision; per-skill exclusion would need per-skill rows, which is the thing this design rejected. The exclusion *set* is still per-`mapKey`, so a selection file written by some other surface with a partial set is read correctly (and renders unchecked).

## Shared Behavior

- The `plans.json.skills` registry, `SkillEntry`, `archivedTotals` and `uncommittedDelta` are owned by spec 319.
- Capture is owned by specs 320 (Claude), 325 (OpenCode) and 326 (Codex).
- `SkillUsage`, `confidence`, per-session splits and detach correction are owned by specs 321 and 306.
- Archival onto a commit (`summary.skills`, `SkillCommitRef`, `archivedKey`) is owned by spec 322.
- `buildSkillsTable` / `buildSkillsSummaryLabel` / `buildLiveSkillsMarkdown` / `buildSkillsAggregateMarkdown` are owned by spec 323.
- The exclusion store (`setExcluded`, `setAllExcluded`, `CommitExclusions`, the `"skills"` set's on-disk shape) is owned by spec 188.
- The sidebar webview message protocol and serialization envelope are owned by spec 101; the bridge data abstraction by spec 134.
- The Next Memory review panel and the AI relevance overlay are owned by specs 247 and 258.
- The memory-detail webview panel is owned by spec 109.
- The 60 s Active Conversations tick and Codex polling discovery are owned by specs 155 and 180.
- The telemetry event catalog (`memory_item_opened`) is owned by spec 205.
