# Skill-usage capture (fourth first-class artifact) — design

**Date:** 2026-07-30
**Ticket:** JOLLI-2061 — *Capture what Skills were used in a conversation into Jolli Memory*
**Status:** draft — blocked on PR #403 (`fix-token-stats`) for token correctness; OpenCode / Codex / Cursor paths gated on their own prerequisites
**Scope:** Add **skills** as a fourth first-class artifact type alongside plans, notes and references. Record that an agent Skill ran during the work leading to a commit — its name, plugin, arguments, entry path, invocation count, and the tokens spent under it — and archive that onto the commit. Store the *act*, never the skill body.

## Goal

When a developer works with an agent, the Skills that ran are a large part of *how* the work was done, and today Jolli Memory records none of it. Skill invocations are `tool_use` blocks, and the normalized-transcript pipeline discards `tool_use` entirely (spec 16), so a skill leaves no trace in any surface: not the sidebar, not the commit memory, not the pushed article.

We want a reader of a commit to be able to see: *"this work was done under `superpowers:test-driven-development`, entered twice, and about 34k output tokens were spent under it."*

Skill usage is **metadata about how the work happened, not substance of the work**. It must never influence generated memory content — same contract as `trackOnly` references ([`QueueWorker.ts:1572`](../../../cli/src/hooks/QueueWorker.ts)).

## Non-goals (YAGNI)

- **Skill bodies.** Bodies are injected verbatim into the transcript and reach **616,048 characters** in the measured corpus (the bundled `claude-api` skill). We store the name and the measured injected size, never the text.
- **Retroactive backfill.** Existing transcripts are not re-scanned for historical skill usage. New capture is forward-only, like every other discovery path.
- **`docType: "skill"` standalone push articles.** `docType` is a closed union and "the sole disambiguator the server uses" ([`JolliMemoryPushClient.ts:262-277`](../../../cli/src/core/JolliMemoryPushClient.ts), spec 94). Adding a value needs a lockstep backend change. v1 rides `summaryJson` instead, which costs nothing (see §5.4).
- **IntelliJ.** Its `SourceId` enum is closed and already missing six sources; out of scope, consistent with prior source additions.
- **Gemini CLI, Antigravity, Cline, Devin.** These hosts have **no skill concept on disk at all** — verified by exhaustive probe (§4.4). There is nothing to capture.
- **Fixing commit-level token inflation.** Handled independently in PR #403; this design *depends* on it (§7).
- **Recall / search integration.** References shipped without it and that is a proven precedent ([`ContextCompiler.ts`](../../../cli/src/core/ContextCompiler.ts) never loads references). Deferred.

## Ground truth

Everything in this section was read off real on-disk data, not inferred. Corpus: **2,678 transcripts** under `~/.claude/projects/` (1,596 session + 1,082 subagent files), Claude Code `2.1.119` → `2.1.220`, plus on-disk probes of seven other hosts.

### G1 — The host already attributes tokens to skills

Assistant records carry **`attributionSkill`**, **`attributionPlugin`** (and `attributionAgent` in subagents) at the *top level* of the record — 26,041 such records in the corpus, versions `2.1.181`+.

This is the single most consequential finding: skill-level token attribution does not need to be estimated from intervals. Grouping deduped usage by `attributionSkill` is *more* accurate than a positional interval, because it correctly excludes turns that fall between skills with no attribution. Measured on one session:

```
<none>                                msgs= 7  in=14     cache_create=60153  out=3775
superpowers:systematic-debugging      msgs=11  in=10387  cache_create=46606  out=8935
superpowers:test-driven-development   msgs=40  in=79     cache_create=59796  out=33944
```

A naive "first Skill call → next Skill call" window would have swallowed the 7 unattributed messages, which are interleaved across the whole session (`06:01:57 → 06:35:21`).

**Caveat:** the field is undocumented and version-dependent. It must be treated as optional, with a fallback path (§5.3).

### G2 — A skill invocation is three records, not one

```
assistant   content[].type=="tool_use", name=="Skill"
              input is ONLY {skill} or {skill,args}   (408/408)
              caller is ONLY {"type":"direct"}        (399/399)
user        tool_result  content == "Launching skill: <id>"   (49 chars)
              toolUseResult == {success, commandName, allowedTools?}
user        isMeta: true,  sourceToolUseID == <the tool_use id>
              message.content[0].text == the injected body
```

**The body is not in the tool result.** This is the most likely design error and is called out because the obvious assumption is wrong. `toolUseResult.commandName` is the resolved skill id and is the reliable name source on this path.

Body sizes across 398 linked records: min 0, **median 9,857**, max 616,048 characters.

### G3 — User-typed slash commands bypass the Skill tool entirely

There is **no `SlashCommand` tool** anywhere in the corpus (`grep` over all 2,678 files → zero). A user-typed `/plugin:skill` produces:

```
user        text == "<command-message>…</command-message>\n<command-name>/j:specs</command-name>\n<command-args>plan build</command-args>"
user        isMeta: true, body text, NO sourceToolUseID
assistant   attributionSkill == "j:specs-pr-review"
```

106 files contain `<command-name>`. An extractor keyed only on the `Skill` tool misses all of them.

Two hazards in the tag block: **ordering is not stable** (`message,name,args` ×73 vs `name,message,args` ×35, the latter with 12-space indentation), and **`<command-args>` is optional** (absent in 22 records). Parse by tag name, never by position.

Not every `<command-name>` is a skill: 23/106 reach the model as a skill body, 23 are client-side only (`<local-command-stdout>`, e.g. `/plugin`, `/compact`), 14 produce a bare `type:"system"` record.

**The clean discriminator across all three mechanisms is `sourceToolUseID`:** present ⇒ Skill tool; absent on an `isMeta` body ⇒ slash command; no `isMeta` body at all ⇒ client-side, not a skill.

### G4 — Usage repeats per content-block line

Confirmed and quantified. One API response is written as several JSONL lines, **each repeating the entire `usage` object byte-identically**:

```
assistant records: 156   distinct message.id: 58
naive per-line sum : 22,657,018      message.id dedupe : 8,680,068
INFLATION          : 2.61x           lines per message.id: max 5
```

Corpus-wide over 1,966 transcripts: min 1.00 · p25 1.87 · **median 2.13** · p75 2.52 · max 6.92.

Deduping on `message.id` is mandatory for any token number this design produces. See §7 for the state of the underlying fix.

### G5 — Subagents live in separate files and their attribution is stale

`isSidechain: true` count in top-level session files is **zero**. Sidechain records live in `~/.claude/projects/<mangled>/<sessionId>/subagents/agent-<agentId>.jsonl` (1,082 files here), with 51,052 usage-bearing records — separately accounted, never duplicated into the parent.

Inside a subagent, `attributionSkill` is **inherited from the parent and never updated**, verified on 3/3 files that contain an in-subagent Skill call. A subagent's own skill invocation is therefore invisible to `attributionSkill` and must be detected from the `Skill` tool_use directly.

### G6 — Other hosts

| Host | Skill concept | Invocation machine-identifiable |
|---|---|---|
| Claude Code | ✅ | ✅ `Skill` tool + `<command-name>` + `attributionSkill` |
| OpenCode | ✅ | ✅ first-class `skill` tool; body inlined in the result |
| Codex | ✅ `~/.codex/skills/.system/`, `~/.agents/skills/` | ❌ invocation is `exec_command` running `sed` on a `SKILL.md` |
| Cursor CLI | ✅ `~/.cursor/skills-cursor/` | ❌ invocation is a generic `Read` of a `SKILL.md` |
| Cursor IDE | ✅ `cursor.commands.globalCommands.*` | ❌ global MRU only, no per-conversation record |
| Copilot CLI | ⚠️ `forge_skill_proposals` table, 0 rows | ❌ authoring table, not an invocation log |
| Gemini CLI / Antigravity / Cline / Devin | ❌ | — |

OpenCode's real row, for reference:

```json
{"type":"tool","tool":"skill","callID":"call_CmMnF4DXOeTnXMs7haokuDxu",
 "state":{"status":"completed","input":{"name":"comprehensive-review-full-review"},
          "output":"<skill_content name=\"…\">…"}}
```

## Current state

### The extraction layer cannot see `Skill` today

The reference subsystem is the only machinery that reads raw `tool_use` blocks, and it is structurally unable to match `Skill`:

```ts
// cli/src/core/references/ClaudeEnvelopeParser.ts:56-59
const NAME_NEEDLES = [
    ...CLAUDE_TOOL_PREFIXES.map((p) => `"name":"${p}`),
    ...[...CLAUDE_SHELL_TOOL_NAMES].map((n) => `"name":"${n}"`),
];
```

`CLAUDE_TOOL_PREFIXES` is derived exclusively from `match.claude.prefixes`, every one of which is an `mcp__…` namespace ([`bindings/claude/index.ts:29-34`](../../../cli/src/core/references/bindings/claude/index.ts)). The only non-MCP escape hatch is `CLAUDE_SHELL_TOOL_NAMES = new Set(["Bash"])`, whose payload contract is "parse `input.command` as a shell string". A line carrying a `Skill` tool_use fails the substring pre-filter and is never even `JSON.parse`d.

This is *why* the fourth-artifact-type shape is right rather than a twelfth reference source — see §6.1.

### The storage layer is half-generic

The orphan branch is fully path-generic: `OrphanBranchStorage` is a 41-line wrapper over `GitOps`, and every path string (`summaries/`, `plans/`, `notes/`, `plan-progress/`) is constructed by the caller in [`SummaryStore.ts`](../../../cli/src/core/SummaryStore.ts). Writing `skills/<id>.md` needs **zero** orphan-branch code.

The Memory Bank visible layer is **not** generic. [`FolderStorage.ts:95-107`](../../../cli/src/core/FolderStorage.ts) is a hardcoded three-armed cascade:

```ts
if (file.path.startsWith("summaries/") && file.path.endsWith(".json")) this.generateSummaryMarkdown(...)
if (file.path.startsWith("plans/")     && file.path.endsWith(".md"))   this.generatePlanMarkdown(...)
if (file.path.startsWith("notes/")     && file.path.endsWith(".md"))   this.generateNoteMarkdown(...)
```

A `skills/…` write lands in the hidden layer only and produces **no visible markdown, no manifest entry, and no error** — a silent half-success rather than a failure.

That silence is only a hazard if skills are supposed to have a visible copy. References — the closest analogue in both volume and nature — decided they are not: references appear **zero** times in `FolderStorage.ts`, living on the orphan branch and in the hidden mirror only. §5.4 takes the middle path for skills and explains why.

### Discovery runs at only three sites

`scanPlansFrom` / `scanReferencesFrom` are called from exactly three places:

| Site | Hosts covered | Cadence |
|---|---|---|
| [`StopHook.ts:241-250`](../../../cli/src/hooks/StopHook.ts) | Claude (Gemini via catch-up only) | every agent turn |
| [`CodexDiscovery.ts:95,106`](../../../cli/src/core/CodexDiscovery.ts) | Codex | 60 s sidebar tick |
| [`DiscoveryCatchUp.ts:87,93`](../../../cli/src/core/DiscoveryCatchUp.ts) | Claude, Gemini | on enable |

**The other eight hookless producers have no discovery-time scan at all.** They are visited only at commit time inside `QueueWorker.loadSessionTranscripts`, which reads normalized text and discards `tool_use`.

### Token extraction discards the ordering it needs

`readTranscript` walks lines with `lineNum` and per-line timestamps in hand, then folds usage into three running scalars and throws the line↔token mapping away ([`TranscriptReader.ts:109-142`](../../../cli/src/core/TranscriptReader.ts)). There is no ordered per-turn usage list anywhere to reuse.

Notably, the loop already reasons about exactly the record class a Skill call produces:

> *"A tool-only assistant turn yields no entry (extractContent keeps only text) yet carries a real timestamp and usage"* — [`TranscriptReader.ts:115-120`](../../../cli/src/core/TranscriptReader.ts)

The pipeline anticipates these turns; it just never gives them an identity.

## Proposed design

### 5.1 The entry types

Two types, mirroring the `PlanEntry` → `PlanReference` / `ReferenceEntry` → `ReferenceCommitRef` split.

```ts
/** Working-area row, one per (source, skill) per project. Lives in plans.json. */
interface SkillEntry {
    source: SkillSource;              // "claude" | "opencode" | "codex" | "cursor"
    skill: string;                    // "superpowers:systematic-debugging"
    plugin?: string;                  // "superpowers" — attributionPlugin, else the id prefix
    entryPaths: SkillEntryPath[];     // ("tool" | "command")[] — distinct paths seen
    invocations: SkillInvocation[];   // newest-first, capped (see below)
    invocationCount: number;          // total, may exceed invocations.length
    firstUsedAt: string;
    lastUsedAt: string;
    usage?: SkillUsage;               // absent when the source cannot attribute
    sourcePath: string;               // .jolli/jollimemory/skills/<source>/<slug>.md
    commitHash: string | null;        // null until archived — same guard shape as PlanEntry
    contentHashAtCommit?: string;     // hash of the file at sourcePath when archived
}

interface SkillInvocation {
    at: string;
    args?: string;                    // Skill tool input.args / <command-args>; often absent
    bodyChars?: number;               // measured from the isMeta record, NEVER from disk
    ok: boolean;                      // false for the is_error results in G2
}

interface SkillUsage {
    input: number; output: number; cached: number;
    confidence: "attributed" | "estimated";
}
```

`SkillEntry.usage.confidence` is a first-class, user-visible field, not an internal note. Codex and Cursor entries carry **no `usage` at all** (§5.5) — an absent field is honest; a zero is a lie.

The archived form `SkillCommitRef` mirrors `ReferenceCommitRef`: the same fields plus `archivedKey`, minus the working-area guard fields.

**Identity and accumulation.** The map key is `<source>:<skill>` — the same shape as a reference's `mapKey`. A skill entered five times is **one** row with `invocationCount: 5`, mirroring the accumulate-body precedent already proven for context7 and jollimemory. `invocations` is capped at **20**, newest-first, with the cap announced in the rendered markdown exactly as accumulated references do. Rationale: a single skill re-entered in a loop (`/j:specs-plan-build` per step) must not flood the Context list.

**Storage of the working row.** `PlansRegistry` ([`Types.ts:698-703`](../../../cli/src/Types.ts)) already holds `plans`, `notes` and `references` in one `plans.json`. Adding `skills?: Record<string, SkillEntry>` means **no new registry file and no new lock** — `withPlansLock` already serializes this file, which is precisely the coordination point the reference lost-update fix landed on.

**The working-area markdown file is not optional.** All three existing artifact types keep their *content* in a file and use the registry row as an index pointing at it via `sourcePath` — references at `.jolli/jollimemory/references/<source>/<key>.md`, notes at `.jolli/jollimemory/notes/<id>.md`, plans at an arbitrary authored path. Skills follow references exactly:

```
.jolli/jollimemory/skills/<source>/<slug>.md
```

This is load-bearing in three ways, not cosmetic:

1. **`contentHashAtCommit` becomes meaningful.** It hashes the file at `sourcePath`; without a file there is nothing to hash and the archive guard that plans and notes rely on would be inert.
2. **Archival stays a copy, not a render.** `storeSkills` reads the working file and writes it to the orphan branch, the same shape as `storePlans` / `storeNotes` / `storeReferences`. Rendering markdown from the registry row at archival time would put the display format in a second place.
3. **Pre-commit browsability.** The file exists from the moment the skill is captured, so working state is inspectable on disk — not only through the IDE.

It is written under the same `withPlansLock` as the registry upsert, for the same reason `writeReferenceMarkdown` requires it: accumulating an invocation into an existing file is a read-modify-write, and two closely-timed captures otherwise lose one.

Note this file lives under `.jolli/` in the **project** (hidden, gitignored) — it is not the Memory Bank visible layer of §5.4 and carries none of that layer's noise concerns.

### 5.2 Extraction

New module tree, mirroring the existing `cli/src/core/plans/` layout exactly:

```
cli/src/core/skills/
  TranscriptSkillDiscovery.ts   scanSkillsFrom(transcriptPath, fromLine, cwd, source)
  SkillTranscriptScanner.ts     getSkillScanner(source) — dispatch
  ClaudeSkillScanner.ts
  OpenCodeSkillScanner.ts
  CodexSkillScanner.ts          heuristic, no usage
  CursorSkillScanner.ts         heuristic, no usage
```

Deliberately **not** the reference `SourceDefinition` DSL — see §6.1.

**Claude scanner.** Both entry paths, unified on `attributionSkill`:

1. Walk raw lines. Collect, in order: `Skill` tool_use blocks (id, `input.skill`, `input.args`, timestamp); `tool_result` records (`toolUseResult.commandName`, `success`); `isMeta` body records (`sourceToolUseID`, `text.length`); `<command-name>` user records (parsed **by tag name**, per G3); and assistant records (`message.id`, `attributionSkill`, `attributionPlugin`, `usage`).
2. **Entry events** come from the tool_use blocks and the command-tag records. The `sourceToolUseID` test (G3) assigns each `isMeta` body to its entry path and yields `bodyChars`.
3. **Names** come from `toolUseResult.commandName` when present (authoritative, resolved), else `input.skill`, else the `<command-name>` tag minus its leading `/`.
4. A `<command-name>` record with **no** following `isMeta` body is client-side (`/plugin`, `/compact`) and is dropped — it never reached the model and is not a skill.

**Subagents.** After scanning a session file, also scan `<sessionId>/subagents/agent-*.jsonl` (G5). Two rules, both forced by the data:
- Tokens in a subagent file are attributed to the **parent's** `attributionSkill`, which is the honest answer to "what did this skill cost" — a subagent dispatched under a skill is part of that skill's cost.
- A subagent's *own* Skill invocation is recorded from its `Skill` tool_use, since `attributionSkill` there is stale.

### 5.3 Token attribution

Primary path, with an explicit fallback, as decided:

**Primary — `attributionSkill` grouping (`confidence: "attributed"`).**

1. Dedupe assistant records on `message.id` (G4). This design consumes the `dedupKey` primitive introduced by PR #403 rather than adding its own — see §7.
2. Preserve the cache-read exclusion contract verbatim: `input_tokens + cache_creation_input_tokens + output_tokens`, never `cache_read_input_tokens` ([`TranscriptParser.ts:188-195`](../../../cli/src/core/TranscriptParser.ts)). It is a per-turn cumulative counter; summing it re-counts the cached prefix every turn.
3. Group the deduped records by `attributionSkill` and sum per segment.

**Boundary rule.** The response containing the `Skill` tool_use is assigned to the **pre-skill** segment. Justification from the data: for a 9,857-char body the cost appears as `cache_creation_input_tokens: 3,923` on the *next* response, not on the calling one. This matters because in **29 of 408 cases (7.1%)** a `Skill` call shares its response with other tools — one observed response held three parallel `Agent` calls plus a `Skill`.

**Fallback — interval attribution (`confidence: "estimated"`).** When `attributionSkill` is absent (Claude Code below ~`2.1.181`, or if the field is withdrawn), fall back to summing deduped usage from the record after a `Skill` tool_use up to the next `Skill` tool_use or the next user turn — whichever comes first. The "next user turn" bound matters: attribution clears on the next user prompt, and there is no skill-exit record, so an unbounded interval would over-attribute indefinitely.

**Two limitations that are documented, not fixed.** Both are properties of the transcript, not of our code:

- **Nested skills flatten.** `attributionSkill` is a scalar that is *replaced*, never pushed. When `/j:specs` invokes `j:specs-plan-build`, records after the inner call read `j:specs-plan-build` and the outer frame is **never restored**. The outer skill's remaining tokens are attributed to the inner one. There is no stack in the data to recover.
- **Attribution is turn-scoped.** It clears on the next user prompt, so a skill's segment ends at a user turn rather than at skill completion.

Both are surfaced in the doc-comment of the attribution module and in the design's Risks section rather than being silently absorbed.

### 5.4 Storage and archival

**Orphan branch** — free. `skills/<slug>-<shortHash>.md`, written through the existing `storePlans`/`storeNotes` shape in `SummaryStore.ts`; `CommitSummary` gains `skills?: ReadonlyArray<SkillCommitRef>`.

Adding an optional array field to `CommitSummary` needs **no migration and no schema-version bump** — the precedent is `excludedContext` / `contextRelevance`, which shipped purely additively, and summaries load through a bare parse with no schema validation (spec 04). The `transcripts` field is the counter-example: it needed `SchemaV5Migration` only because it changed structural semantics.

**Memory Bank folder — hidden layer is free, visible layer is one aggregate per commit.**

The hidden layer needs no code at all: `writeHiddenFile` runs unconditionally *before* the visible cascade ([`FolderStorage.ts:91`](../../../cli/src/core/FolderStorage.ts)), so `skills/<slug>-<hash8>.md` lands at `<kbRoot>/.jolli/skills/…` automatically. That alone satisfies the folder-mode rule that every class of orphan-stored data must land on disk — which is exactly how references satisfy it (references appear **zero** times in `FolderStorage.ts`; they have no visible layer).

The visible layer is **one aggregate file per commit**, not one per skill:

```
<branchFolder>/skills--<hash8>.md
```

```markdown
# Skills used — a1b2c3d4

| Skill | × | Tokens | Input | Output | Cached |
|---|---|---|---|---|---|
| superpowers:test-driven-development | 2 | 34.0k | 79 | 12.1k | 21.8k |
| j:specs-plan-build | 1 | 12.3k | 40 | 4.1k | 8.2k |
```

`Tokens` is kept alongside the three-way split rather than replaced by it: the rows are ordered by that total, and every aggregate row elsewhere summarises by it, so dropping the column would leave both the sort key and the summary figure with no counterpart in the table a reader is looking at. All four cells dash together for an unattributed skill — a row that dashed only the total while zeroing the split would claim the three components were measured. The `~` estimate marker rides every cell, because it qualifies how a figure was arrived at, not its magnitude.

**It is generated from the summary write, not from the skill writes.** The obvious implementation — a fourth arm on `skills/*.md` — is wrong here: the existing cascade emits one visible copy *per written file*, so aggregating N skills into one file would become a read-modify-write repeated N times, and would acquire an ordering dependency on whether `storeSkills` runs before or after `storeSummary`.

Instead the aggregate is emitted from the existing `summaries/*.json` arm, whose payload already carries `CommitSummary.skills`. One trigger, complete data, and the commit hash is inherently correct. Two consequences, both simplifying:

1. **No new `StorageProvider` method pair.** The aggregate's lifecycle is the summary's, so the existing `deleteVisibleMarkdown` / `regenerateVisibleMarkdown` (which already take a `SummaryIndexEntry`) extend to delete and regenerate the `skills--<hash8>.md` sibling. No `deleteSkillVisible`, no `DualWriteStorage` delegation stanza.
2. `KBTypes.ManifestEntry.type` still gains `"skill"` so the aggregate is registered and stale-cleanup (spec 186) can reach it.

Net: `FolderStorage.ts` changes inside the arm it already has; `StorageProvider.ts` and `DualWriteStorage.ts` are untouched.

**Archival on commit.** `detectActiveSkillsForBranch` → `associateSkillsWithCommit` → `storeSkills`, wired into `executePipeline` beside the plan and note calls at [`QueueWorker.ts:1803-1807`](../../../cli/src/hooks/QueueWorker.ts). The working row is guarded (`commitHash` + `contentHashAtCommit` set), not deleted — identical to plans and notes.

### 5.5 Where the extractor runs

`scanSkillsFrom` is added beside the existing scan pairs at all three discovery sites, inheriting `discovery-cursors.json` and its single-owner gate for free:

| Site | Hosts | Notes |
|---|---|---|
| `StopHook.ts` | Claude | turn-level freshness |
| `CodexDiscovery.ts` | Codex | 60 s tick |
| `DiscoveryCatchUp.ts` | Claude, Gemini | on enable |

**OpenCode and Cursor have no scan point — and a post-commit-only sweep is not acceptable here.** Skills are a signal about *how the work is being done right now*; surfacing them only after the commit lands would leave working memory empty for those hosts during the entire session, which is when the information is useful.

The mechanism already exists and does not need inventing. `SidebarWebviewProvider.pushConversations` is the 60 s Active-Conversations refresh, and it already enumerates **every** source via `activeSessionsProvider.listWithDiagnostics()`. Codex artifact discovery rides it opportunistically:

> *"Ride this 60s tick to run Codex artifact discovery on the polling path."* — [`SidebarWebviewProvider.ts:2096`](../../../vscode/src/views/SidebarWebviewProvider.ts)

Skill discovery for hookless sources rides the same tick, inheriting its established guarantees: fire-and-forget, per-cwd single-flight collapsing the four callers, and a `try/catch` so a regressed extractor can never take down the conversation list it exists to render.

A **post-commit raw sweep** in `QueueWorker` is retained as a safety net rather than the primary path — it guarantees per-commit coverage for a source whose IDE surface was never open (a pure-CLI OpenCode session with no VS Code window). Belt and braces: the tick gives live working memory, the sweep guarantees nothing is lost.

**Codex and Cursor are heuristic and say so.** Their only signal is a path ending in `SKILL.md` inside a generic `exec_command` / `Read` call. The scanner derives the skill name from the parent directory and marks the entry `confidence: "heuristic"` with **no `usage`**. Two limits are stated in the entry's own rendering, not buried: a human reading a skill file produces a false positive, and "read" cannot be distinguished from "used".

### 5.6 Cursor versioning — closing a known stranding hazard

`discovery-cursors.json` is monotonic and shared. A dist that does not know about an extractor advances the cursor past its data, and a newer dist resuming from that cursor **never re-reads those lines**. The single-owner gate in `StopHook.ts:189-201` mitigates the Claude plugin-vs-CLI race but does nothing for version skew: every already-shipped dist will happily advance the cursor past skill data.

Because old dists are already in the field, this must ship **with** the extractor, not after it. The cursor record gains a per-extractor high-water mark:

```jsonc
{ "<transcriptPath>": { "lineNumber": 512, "extractors": { "plans": 512, "references": 512, "skills": 0 } } }
```

A dist that finds no `skills` key (or a lower one) rewinds **for that extractor only**, leaving the plan and reference cursors untouched. Legacy records with a bare `lineNumber` migrate exactly as `migrateDiscoveryCursors` already migrates the legacy `plan:`-prefixed keys.

### 5.7 Surfaces

**VS Code sidebar — this is the working-memory surface.** Skills become a fourth row-kind in the existing **Context** subsection, where plans, notes and references already merge into one list via `PlansStore` → [`PlansTreeProvider`](../../../vscode/src/providers/PlansTreeProvider.ts). Concretely: a `SkillsGroupItem` beside `PlanItem` / `NoteItem` / `ReferenceItem`, a `skillsHover` payload, and `"skills"` added to the merged-entry kind union.

**One aggregate row, not one row per skill** — the same call §5.4 makes for the Memory Bank's visible layer, for the same reason and more sharply: the Context list is a fixed-height panel that plans, notes and references already compete for, and a session routinely enters a dozen skills. Row label: `Skills`; description: `<N> skills · <summed tokens>`, with `~` when any member's figure is estimated and a trailing `†` when any member was inferred. The hover card lists members heaviest-first (capped, with an "…and N more" tail); clicking the row opens the live aggregate — the §5.4 table rendered from the uncommitted registry through the same `buildSkillsTable`, so the view does not change shape when the work is committed.

Three consequences follow from the row standing for N artifacts rather than one:

- Its `id` is a sentinel (`SKILLS_GROUP_ID`), not a `plans.json.skills` map key. Anything that addresses Context rows by id — the checkbox dispatcher, Select All — must go back to the store for the real keys.
- It carries **no inline actions**. There is no single document to pin, edit, or delete; the checkbox is the row's only write.
- Selection is **all-or-nothing**. `CommitExclusions.skills` stays a `Set<mapKey>` (per-skill exclusion remains representable and is still written per-key), but this surface can only express "keep them all" or "drop them all".

An earlier draft of this section specified one row per skill with a `×N · <tokens>` description, contradicting §5.4 in the same document; it shipped that way first and was corrected.

Uncommitted skills need no new visibility mechanism. `detectActiveSkillsForBranch` filters on `entry.commitHash !== null → continue` ([`SessionTracker.ts:1333`](../../../cli/src/core/SessionTracker.ts)) exactly as plans and notes do, so a captured-but-unarchived skill is "active" by the same rule and renders in the same group. Refresh cadence follows the extractor: per agent turn for Claude (Stop hook), per 60 s tick for every hookless source (§5.5).

So the two visible artefacts answer different questions and coexist without overlap: the **Context group** shows *what this working session has run so far* (rows with `commitHash: null`, updated live), while **`skills--<hash8>.md`** (§5.4) is the frozen record of *what the committed work ran under*. Skills also appear as excludable context items in the pre-commit review panel via `CommitSelectionStore.ExclusionKind`, so a skill can be kept out of the memory before it is archived.

Three house rules govern the webview work and are non-negotiable:
- Strict CSP — no inline `style=`, no inline handlers. Dynamic widths go through `data-*` + a scripted `.style` write, as the token meter already does.
- `.hidden` class only, never the `hidden` attribute or `el.hidden`. Note the Commit Memory panel currently violates this; do not copy that habit into the sidebar.
- These builders return one template literal — a backtick anywhere, including in a comment, truncates the file silently.

**Memory markdown.** A row inside the existing `## Context` section emitted by `pushPlansAndNotesSection` ([`SummaryMarkdownBuilder.ts`](../../../cli/src/core/SummaryMarkdownBuilder.ts)), keeping skills adjacent to the other artifacts rather than inventing a section. One aggregate row — `- Skills used — 3 skills · 93.8k tokens` — matching §5.6, and counting as **one** toward the `## Context (N)` heading. Shared with the multi-commit PR body, which merges skills across commits by ACCUMULATION (`<source>:<skill>` key, summed usage) rather than the first-wins dedupe the other kinds use: the same skill in three commits is one skill used three times, not a duplicate to drop.

### 5.8 The same aggregate row, on all four Context surfaces

There are four places a Context list is rendered, and skills appear as the identical single `Skills used` row on every one — the label comes from one shared helper, `buildSkillsSummaryLabel` in [`SkillsAggregateMarkdown.ts`](../../../cli/src/core/SkillsAggregateMarkdown.ts), so the surfaces cannot disagree about a count or a token format:

| Surface | Row opens |
|---|---|
| Sidebar live Context list (`PlansTreeProvider`) | the live table, from the uncommitted registry |
| Next Memory review panel (`NextMemoryScriptBuilder`) | the same live table |
| Committed memory's evidence group (`SidebarWebviewProvider` → `renderMemoryEvidence`) | that commit's `skills--<hash8>.md`, via `previewCommittedSkills` |
| Committed memory's detail panel (`SummaryHtmlBuilder.buildPlansAndNotesSection`) | the same commit table |

The two committed surfaces deliberately do **not** post `branch:openSkillsAggregate`: that renders the working registry, which no longer holds those skills once they are archived, so the live message would open an unrelated or empty table. They route to `jollimemory.previewCommittedSkills`, keyed by commit hash, which renders from the summary snapshot — correct in orphan-branch-only mode and for a foreign repo whose Memory Bank folder this machine has never seen.

The first two surfaces resolve every per-kind decision — badge, checkbox message, id field name, open message, inline actions — from one injected table, [`ContextRowKinds.ts`](../../../vscode/src/views/ContextRowKinds.ts). Before it was shared, each surface had its own ternary chain with its own fall-through default (the sidebar's ended in `plan`, the Next Memory panel's in `reference`), and the skills row hit both: an "Edit Plan" tooltip on one, and on the other a checkbox posting `branch:toggleReferenceSelection` with the `__skills__` sentinel as a `mapKey`. Adding a kind is a one-line change in that table.

**LLM prompt — excluded.** Skills are never injected into `{{references}}`/`{{plans}}`/`{{notes}}` and never enter the relevance ranker. This is the `trackOnly` contract, reused verbatim: archived and displayed, but invisible to the summarizer. Skill usage describes *how* the work was done; letting it steer the memory's content would be a category error.

**Jolli Space push — free.** `serializeSummaryJson` spreads the entire `CommitSummary` minus four doc-id fields ([`JolliMemoryPushOrchestrator.ts:85-101`](../../../cli/src/core/JolliMemoryPushOrchestrator.ts)), so `summary.skills` rides along with **zero code**, subject only to the 1.5 MiB cap. The rendered markdown carries the human-readable form. No `docType` change, therefore no backend lockstep.

## Alternatives considered

### 6.1 A twelfth reference `SourceDefinition` (rejected)

The reference DSL owns transcript-derived, track-only, arguments-derived capture — superficially an exact fit, and it would have brought storage, dedupe, markdown persistence, the sidebar row and the push path for free.

It was rejected on two independent grounds.

**Mechanical.** The matching layer is built around MCP namespaces. `Skill` has no `mcp__` prefix, so no `match.claude.prefixes` entry can `startsWith` it, and it contributes no needle to `NAME_NEEDLES` — the line is dropped before `JSON.parse`. Support would require a new independent match mode (today's `exact` only *narrows* an already-prefix-matched definition), a literal in the needle set, and a payload contract unlike anything the `path`/`require` ops assume. That is a new matching path bolted into a registry whose fail-fast validator runs for all twelve existing sources at process start.

**Semantic.** A reference is a pointer to an *external system* — it has a `url`, a `nativeId` in someone else's namespace, and a "go look at this" affordance. A skill invocation is a *local act* with no external referent. The jollimemory self-reference source already stretched this by shipping link-less references; stretching it again to cover something with no external system at all would leave `ReferenceEntry.url`, `nativeId` and the whole source-badge vocabulary carrying no meaning.

The mechanical cost and the semantic cost point the same way, so skills get their own type. The price is explicit and quantified in §8.

### 6.2 Pure interval attribution (rejected as primary, retained as fallback)

Originally chosen on the premise that per-skill usage is unavailable from the API. G1 disproved the premise. Intervals remain the fallback for hosts and versions without `attributionSkill`, carrying `confidence: "estimated"`.

### 6.3 Skill-body cost from disk (rejected)

Reconstructing injection cost from the on-disk `SKILL.md` matched a real transcript to within 1 character, so it is *technically* viable — and still wrong, for four reasons: repeat invocations inject a ~140-char "already loaded above" stub; legacy `commands/*.md` bodies have `$ARGUMENTS` already interpolated so no disk file matches; bundled skills live under a version+hash-scoped `/private/tmp/claude-501/bundled-skills/…` path that will not exist when the post-commit hook runs; and the transcript already carries the exact injected text. Measure `bodyChars` from the `isMeta` record.

### 6.4 Summary metadata only, no artifact type (rejected)

Cheapest option, but it gives no sidebar presence and no cross-commit aggregation — and the ticket's framing ("capture that it happened") is squarely about a durable record, not a rendering detail.

### 6.5 Visible-layer granularity — two rejected extremes

The visible Memory Bank layer exists to be *browsed by a human*, so its granularity is a signal-to-noise decision, not a consistency one.

**One visible file per skill (`skill--<slug>.md`), mirroring `plan--` / `note--` — rejected.** It aligns skills with the wrong neighbours. Plans and notes are few per branch, human-authored, and substantial; skills are auto-captured metadata arriving several per commit. At a realistic rate of three skills per commit, a hundred commits produce three hundred `skill--*.md` files interleaved with the handful of memory documents the user actually opens — burying the visible layer's whole reason for existing.

**No visible layer at all, mirroring references — rejected, narrowly.** This is what references chose and it is defensible: the hidden layer already satisfies the folder-mode landing rule, and it would have removed every `FolderStorage` / `KBTypes` change. It was rejected because a per-commit skills table is genuinely readable on its own — "what did this commit's work run under" is a question a human browsing the folder would ask, in a way that "which Linear issue did the agent open" (a reference) is not.

The aggregate lands between them: one file per commit, table-shaped, sharing the summary's lifecycle. It keeps the folder browsable while holding file count to 1× commits rather than N× commits.

## Token-accounting prerequisite

This design's numbers are only as good as the layer beneath them, and that layer had a defect.

`readTranscript` accumulates usage **per line, unconditionally** ([`TranscriptReader.ts:133-138`](../../../cli/src/core/TranscriptReader.ts)), while a single API response is written as 3–6 lines each repeating the full `usage` object (G4). The existing guard — dropping `cache_read_input_tokens` — addresses a *different* failure (that counter being cumulative) and does nothing about repeated lines. Measured inflation: **median 2.13×**, up to 6.92×.

**This is being fixed in PR #403** (`fix-token-stats`, **open, not merged**), which introduces `ParsedTurnUsage.dedupKey` (`message.id` for Claude) and dedupes in both the reader and the per-model split — correctly noting that the two must dedupe on the *same* identity or the cost estimate drifts from the headline total.

Consequences for this design:

1. **Skill-level attribution must not ship before #403 merges.** Built on the pre-fix reader, every skill token count would be inflated ~2×.
2. **Reuse `dedupKey`; do not add a second dedupe.** Two independent dedupe implementations over the same data is exactly the drift #403 exists to prevent.
3. **Numbers are not comparable across the fix.** Skill usage recorded before and after #403 would differ by ~2× for identical work. Since skill capture ships after, this affects only the relationship between new skill totals and pre-existing commit totals — worth a note wherever both are shown together.

## Migration / rollout

Ordered so that every step is shippable and no step strands data. Steps 6–8 are **gated**, not scheduled.

| # | Step | Gate |
|---|---|---|
| 1 | `SkillEntry` / `SkillCommitRef` types; `skills` map in `PlansRegistry`; working-area load/save under `withPlansLock` | — |
| 2 | Per-extractor cursor high-water marks + legacy migration (§5.6) | must precede any new cursor advance |
| 3 | Claude scanner — both entry paths, subagent files, real-fixture tests | — |
| 4 | Attribution module on `attributionSkill`, consuming `dedupKey`; interval fallback | **PR #403 merged** |
| 5 | Archival: orphan `skills/`, `CommitSummary.skills`, the `skills--<hash8>.md` aggregate inside the existing `summaries/` arm, `KBTypes` manifest type | — |
| 6 | Surfaces: sidebar Context row, memory markdown group; push rides free | — |
| 7 | OpenCode scanner + hookless skill discovery riding the 60 s tick (§5.5) | shape verified |
| 8 | Codex / Cursor heuristic scanners, `confidence: "heuristic"`, no usage | real captured envelope for each before any matcher is written |

**Step 8 is a hard gate, not a formality.** This repo has been burned by parsers whose fixtures and code were both imagined, forming a self-consistent but entirely wrong closed loop. No `SKILL.md`-path matcher is written for Codex or Cursor until a real invocation has been captured from a live run of that host.

### Change set (ripple)

The measured cost of a new artifact kind. The `"plan" | "note" | "reference"` literal union is **redeclared inline at 24 sites across 17 files** with no shared alias, so `grep '"plan" | "note"'` is the authoritative sweep, not a type-level single point of change:

`cli/src/Types.ts` (×2) · `cli/src/core/ContextRelevance.ts` · `cli/src/core/SummaryMarkdownBuilder.ts` · `cli/src/core/JolliMemoryPushOrchestrator.ts` · `cli/src/core/JolliMemoryPushClient.ts` (×2) · `cli/src/core/KBTypes.ts` · `cli/src/core/MigrationEngine.ts` · `cli/src/core/TopicKBTypes.ts` · `cli/src/core/PinStore.ts` · `cli/src/core/FolderPlanNoteSource.ts` (×2) · `cli/src/commands/IdeBridgeCommand.ts` (×2) · `vscode/src/views/SidebarMessages.ts` (×3) · `vscode/src/views/SidebarWebviewProvider.ts` · `vscode/src/views/SummaryHtmlBuilder.ts` · `vscode/src/services/JolliPushService.ts` (×2) · `vscode/src/services/KbFoldersService.ts` · `vscode/src/commands/SelectAllSelection.ts`

Plus: `CommitSelectionStore.ExclusionKind` (so skills can be excluded from a commit like any other context item), `KBTypes.ManifestEntry.type`, and the CLI coverage floor of **97 / 96 / 97 / 97** — global, not per-file — meaning every new reject branch in the scanners and the attribution module needs a covering test.

Deliberately **not** touched, per §5.4: `StorageProvider.ts` and `DualWriteStorage.ts` gain no new method pair, because the visible aggregate rides the summary's existing `deleteVisibleMarkdown` / `regenerateVisibleMarkdown` lifecycle rather than owning its own. Coverage exemptions must use the `/* v8 ignore start/stop */` block form; the single-line `ignore next` does not work in this workspace.

No shipped skill template changes, so no `metadata.revision` bump and no fingerprint-test update — unless a user-facing command to view skill usage is added later, which would need a line in the `jolli` umbrella menu and both its revisions bumped in lockstep.

## Risks and open questions

**`attributionSkill` is an undocumented private field.** It is the load-bearing input for the primary attribution path, verified on 26,041 records but carrying no compatibility promise. Mitigations: treat as optional everywhere; keep the interval fallback live and tested rather than dormant; pin a real-transcript fixture so a shape change fails loudly in CI rather than silently degrading to zeros.

**PR #403 is not merged.** Step 4 is blocked on it. If #403 changes shape before merging, the attribution module's consumption of `dedupKey` must follow.

**Nested-skill flattening is unfixable from the transcript.** An outer skill that dispatches an inner one will under-report. The data has no stack to recover; this is a stated limitation, not a bug to fix later.

**Codex / Cursor heuristics will produce false positives.** A human reading a `SKILL.md` is indistinguishable from an agent using it. Open question: should heuristic entries be visually separated in the Context list, or filtered out of the pushed article? Current proposal is to show them marked and push them marked; worth revisiting once real data exists.

**The `usage` key set is model-dependent.** Opus emits `iterations`, `speed` and `server_tool_use`; Sonnet does not. Everything beyond the four core counters must be treated as optional.

**Cursor stranding is mitigated but not eliminated.** Per-extractor high-water marks let a newer dist rewind, but a dist older than step 2 still advances the bare `lineNumber`. Skill data written before every surface upgrades may be lost. Open question: is a bounded "rescan last N lines on first sight of a new extractor" worth the cost on top of the high-water mark?

**Working memory for hookless sources depends on an open IDE.** The 60 s tick that keeps OpenCode and Cursor skills live is a VS Code surface. A developer running OpenCode purely from a terminal with no editor window gets no live working memory — capture still happens, but only via the post-commit sweep, so nothing is visible until the commit lands. Claude and Codex are unaffected (Stop hook and Codex discovery run outside the IDE). Open question: is a `jolli status`-adjacent CLI read of the working-area context items worth adding, or is the IDE the accepted surface for this?

**Open — repeated invocation cap.** 20 invocations, newest-first, mirroring accumulated references. A plan-driven loop can legitimately exceed this. Is the cap plus an announcement enough, or should totals be preserved exactly while only the detail list is capped? (Current proposal already keeps `invocationCount` exact.)

## References

**Ticket:** [JOLLI-2061](https://linear.app/jolliai/issue/JOLLI-2061/capture-what-skills-were-used-in-a-conversation-into-jolli-memory) · **Dependency:** PR #403 `fix-token-stats`

**Specs:** 01, 02, 03, 04 (summary tree, additive-field precedent), 06 (migration — not triggered), 11, 12, 15, 16 (`tool_use` discarded), 24 (cursor resumption), 29, 36 (attribution cutoff), 42, 43, 94 (`docType` closed union), 101, 105, 109, 151, 153, 154, 179, 187, 243, 244, 245, 257

**Code:**
- Matching-layer limit — [`ClaudeEnvelopeParser.ts:56-59`](../../../cli/src/core/references/ClaudeEnvelopeParser.ts), [`bindings/claude/index.ts:29-34`](../../../cli/src/core/references/bindings/claude/index.ts)
- Visible-layer cascade — [`FolderStorage.ts:95-107`](../../../cli/src/core/FolderStorage.ts)
- Discovery sites — [`StopHook.ts:241-250`](../../../cli/src/hooks/StopHook.ts), [`CodexDiscovery.ts:95,106`](../../../cli/src/core/CodexDiscovery.ts), [`DiscoveryCatchUp.ts:87,93`](../../../cli/src/core/DiscoveryCatchUp.ts)
- Stranding hazard + single-owner gate — [`StopHook.ts:189-201`](../../../cli/src/hooks/StopHook.ts)
- Token extraction — [`TranscriptParser.ts:188-222`](../../../cli/src/core/TranscriptParser.ts), [`TranscriptReader.ts:109-142`](../../../cli/src/core/TranscriptReader.ts)
- `trackOnly` precedent — [`QueueWorker.ts:1559-1578`](../../../cli/src/hooks/QueueWorker.ts)
- Push payload — [`JolliMemoryPushOrchestrator.ts:85-101`](../../../cli/src/core/JolliMemoryPushOrchestrator.ts), [`JolliMemoryPushClient.ts:262-277`](../../../cli/src/core/JolliMemoryPushClient.ts)
- Artifact-type template — [`Types.ts:677-722`](../../../cli/src/Types.ts), [`SummaryStore.ts:2336-2446`](../../../cli/src/core/SummaryStore.ts), [`PlansTreeProvider.ts:32-169`](../../../vscode/src/providers/PlansTreeProvider.ts)

**Prior design pairs mirrored:** [`2026-07-28-jollimemory-reference-capture-design.md`](2026-07-28-jollimemory-reference-capture-design.md), [`2026-07-22-context7-tracking-design.md`](2026-07-22-context7-tracking-design.md)
