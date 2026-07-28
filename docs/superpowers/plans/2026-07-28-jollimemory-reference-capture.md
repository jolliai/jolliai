# Jolli Memory self-reference capture (track-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Tasks use checkbox (`- [ ]`) syntax for tracking.

> **Source design:** `docs/superpowers/specs/2026-07-28-jollimemory-reference-capture-design.md`
> Each **Step** below is sized for ONE session. Steps 1-4 are the Claude-only shippable slice. Step 5 is HARD-BLOCKED on a live capture. Step 6 is docs.

**Goal:** Add `jollimemory` as a track-only reference source so Jolli records that past memory was consulted (`recall` / `search` / `get_decision_timeline`) while working on a commit — the call and its query only, never the memories that came back. Surfaced in the VS Code References panel and pushed to Jolli Space; never fed to the memory-decision LLM.

**Architecture:** `jollimemory` becomes the 12th `SourceDefinition`, and the first **self-referential** one — the system being referenced is Jolli itself. Like context7 it is *arguments-derived* and *track-only*. Unlike every existing source it has **no URL** and it **accumulates** rather than overwrites: one reference per tool (`mapKey = jollimemory:<tool>`), whose body collects the queries asked since the last commit. Three new DSL affordances carry this: `MatchClaude.exact` (the `mcp__jollimemory__search` prefix collides with plugin tools), optional `reference.url`, and `accumulateBody`.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome. Workspaces `@jolli.ai/cli` and `vscode`.

## Global Constraints

- DCO sign-off on every commit: `git commit -s`. No `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines (`cli/vite.config.ts`). **Global, not per-file** — a new definition with untested void/reject branches can drag the whole repo under. Mirror how `asana`/`monday`/`context7` tests cover the happy path *and every reject branch*.
- Biome: tabs, 4-wide, 120 columns; `noExplicitAny: error`, `noUnusedImports/Variables: error`. `npm run lint` runs `biome check --error-on-warnings`.
- **Project workflow override (per user preference):** do NOT run `npm run all` or commit per task. Each task writes test + implementation code only. The FINAL task of each Step runs `npm run all` once and makes one commit for that Step.
- **Run these test files WHOLE — never with a `-t` filter** (module-level registry state is computed once at import): `SourceDefinitionRegistry.test.ts`, `bindings/claude/index.test.ts`, `ClaudeEnvelopeParser.test.ts`, `CodexEnvelopeParser.test.ts`.
- `cli/src/Types.ts` is excluded from coverage — the `KnownSourceId` edit needs no test of its own, but it forces the `SOURCE_META` edit to compile.
- If the worktree index is clobbered by a plugin (`invalid object … Error building trees`): `rm .git/index` then `git read-tree HEAD`, then re-`git add`. Never run destructive git inside a pipeline (`&&` short-circuits behind a pipe).

## Verified against current code (2026-07-28)

Every `file:line` below was re-checked after the design was written. Two corrections to the design doc:

- **There are TWO normalizer env types, not one.** Claude's `ContextNormalizeEnv` (`ClaudeEnvelopeParser.ts:299`, module-private) and Codex's `CodexNormalizeEnv` (`bindings/codex/CodexBinding.ts:30`). Both need `toolName`.
- **`CodexNormalizer.canonicalToolName` is a single string per binding** (`CodexBinding.ts:46`) and becomes `NormalizedToolResult.toolName` on the Codex path. It cannot represent three tools. See Step 5's known wrinkle.

Confirmed unchanged and load-bearing:

| Location | Fact |
|---|---|
| `SourceDefinitionRegistry.ts:195-197` | `startsWith(prefix)` → `acceptSuffix` → `denySuffixes`. No exact-match concept. |
| `SourceEngine.ts:199-200` | `evalField(def.reference.url, …)`; `!urlR.ok` voids the reference. |
| `SourceEngine.ts:241` | `renderOne` already omits `<url>` when absent — no change needed. |
| `ReferenceStore.ts:254-257` | `renderMarkdown` already omits the `url:` line entirely when absent. |
| `ReferenceStore.ts:282`, `:365`, `:368` | `parseMarkdown` treats `url` as optional; required guard is title/referencedAt/sourceToolName. |
| `ReferenceStore.ts:200`, `:306` | `stripReferenceNote` runs on read — the auto-note never enters `description`. |
| `ReferenceExtractor.ts:158-171` | `dedupeKeepLatest`, last-wins. **Not** inside a `v8 ignore` block — new branches need coverage. |
| `ClaudeEnvelopeParser.ts:244` | `toolInput` retained only for ids in `CONTEXT_NORMALIZER_IDS` — automatic once registered. |
| `ClaudeEnvelopeParser.ts:317-319`, `:441` | `CONTEXT_NORMALIZERS` map + its single call site. |
| `CodexEnvelopeParser.ts:246`, `:324` | Two `normalizer.normalize(...)` call sites. |
| `CodexEnvelopeParser.ts:394-395` | `resolveCodexDef` requires the `mcp__codex_apps__` prefix — local servers use the FALLBACK path only. |
| `QueueWorker.ts:1549`, `:1798-1830`, `:2920-2953`; `Regenerator.ts:280` | **All four `trackOnly` seams already exist** (context7 built them). Setting the flag costs zero code. |
| `definitions/index.ts:28-39` | `BUILTIN_DEFINITIONS`, 11 entries, `context7Definition` last. |
| `SourceLabels.ts:40` | `SOURCE_META: Record<KnownSourceId, SourceMeta>` — compile-forced. |
| `ReferenceService.ts:148-150` | `openReferenceInBrowser` rejects a non-http(s) scheme; `Uri.parse("")` has scheme `""`. |

## File Structure

**New files (cli):**
- `cli/src/core/references/sources/JolliMemoryNormalize.ts` (+ `.test.ts`) — arguments + toolName → `{ tool, query }`.
- `cli/src/core/references/sources/definitions/jollimemory.ts` (+ `.test.ts`) — the `SourceDefinition`.
- `cli/src/core/references/bindings/codex/CodexJolliMemoryBinding.ts` — Step 5 only.

**Modified (cli):** `SourceDefinition.ts`, `SourceDefinitionRegistry.ts`, `SourceEngine.ts`, `ReferenceExtractor.ts`, `ReferenceStore.ts`, `ClaudeEnvelopeParser.ts`, `CodexEnvelopeParser.ts`, `bindings/codex/CodexBinding.ts`, `sources/definitions/index.ts`, `Types.ts`.

**Modified (vscode):** `views/SourceLabels.ts`, `views/SidebarScriptBuilder.ts`, `views/SummaryHtmlBuilder.ts`.

**Untouched, deliberately:** `JolliMemoryPushClient.ts`, `JolliMemoryPushOrchestrator.ts`, `McpTools.ts`, `McpServer.ts`, the backend, and all of `intellij/`. The Space push path already carries an arbitrary `source` string end-to-end — `SourceId = string` (`Types.ts:789`) and the backend validates with `.passthrough()`.

---

## Step 1 — DSL affordances + `toolName` threading  — STATUS: DONE

**Goal:** All three new DSL capabilities plus tool-name plumbing, entirely inert for existing sources. Nothing user-visible ships; the untouched fixtures for the 11 existing sources are the regression test.

**Contracts to honor:** Adding a field to `SourceDefinition` must not change any existing source's behavior. `validateDefinition` accepts extra fields, so no validator change is needed for the flags — but `exact` DOES need the registry match to honor it.

- [ ] **Task 1: Add the three affordances to `SourceDefinition.ts`**

In `MatchClaude` (after `denySuffixes`):

```ts
	/**
	 * Exact tool-name allow-list, applied after the prefix match. When present, the
	 * tool name must EQUAL one of these. Use when a vendor prefix is shared with
	 * unrelated tools whose names extend a wanted name — `mcp__jollimemory__search`
	 * is a startsWith-prefix of `mcp__jollimemory__search_remote_articles`, so
	 * prefix+denySuffixes cannot express "these three tools and nothing else".
	 * Absent for every existing source.
	 */
	readonly exact?: ReadonlyArray<string>;
```

In `SourceDefinition.reference`, make `url` optional — change `readonly url: FieldSpec;` to:

```ts
	/**
	 * Absent when the source has no external destination at all (jollimemory: the
	 * referenced system is this repo's own memory). Distinct from a url FieldSpec
	 * that evaluates to nothing, which VOIDS the reference (Slack's unresolved
	 * permalink). Every source but jollimemory declares one.
	 */
	readonly url?: FieldSpec;
```

On `SourceDefinition` itself, alongside `trackOnly` / `argumentsDerived`:

```ts
	/**
	 * The reference body ACCUMULATES across repeated calls sharing a mapKey instead
	 * of being overwritten. For a source whose identity is an act (a memory query),
	 * not an entity, each call is a distinct fact worth keeping. Absent (falsy) for
	 * every existing source, which correctly overwrites on repeat.
	 */
	readonly accumulateBody?: boolean;
```

- [ ] **Task 2: Honor `exact` in the registry — test first**

In `cli/src/core/references/SourceDefinitionRegistry.test.ts`, add a describe block using a locally-constructed definition (do NOT depend on `jollimemory`, which does not exist until Step 3). Assert: a name in `exact` matches; a name sharing the prefix but not in `exact` does not; a definition with no `exact` behaves exactly as before.

- [ ] **Task 3: Honor `exact` in `match()`**

In `SourceDefinitionRegistry.ts`, in the `claude` branch, insert between the prefix test (`:195`) and the `acceptSuffix` test (`:196`):

```ts
				if (m.exact !== undefined && !m.exact.includes(toolName)) return false;
```

Order matters: prefix first (it is also the pre-filter needle contract), then `exact`, then the existing suffix rules. A definition may declare both; `exact` simply narrows further.

- [ ] **Task 4: `extractRef` tolerates an absent url spec — test first**

In `cli/src/core/references/SourceEngine.test.ts`, add: a definition whose `reference.url` is absent yields a `Reference` with `url === undefined` (not a void); a definition whose url spec is present-but-unsatisfied still voids (the Slack contract must not regress).

- [ ] **Task 5: `extractRef` implementation**

In `SourceEngine.ts`, replace line 199:

```ts
	const urlR =
		def.reference.url !== undefined
			? evalField(def.reference.url, payload)
			: { ok: true as const, value: undefined };
```

Line 200's `!urlR.ok` check and line 222's `...(urlR.value !== undefined ? { url: urlR.value } : {})` both keep working unchanged.

- [ ] **Task 6: Add `toolName` to BOTH env types**

Claude — `ClaudeEnvelopeParser.ts:299`, add to `interface ContextNormalizeEnv`:

```ts
	/** The MCP tool name that produced this call. A source matching several tools
	 *  (jollimemory) cannot infer which one fired from arguments alone — a bare
	 *  `recall()` and `list_branches()` are both `{}`. */
	readonly toolName: string;
```

Populate at the call site (`:441`): `contextNormalize(parsedPayload, pendingEntry.toolInput, { permalinks, opts, toolName: pendingEntry.toolName })`.

Codex — add the same field to `CodexNormalizeEnv` in `bindings/codex/CodexBinding.ts`, and populate at BOTH `normalizer.normalize(...)` call sites (`CodexEnvelopeParser.ts:246` and `:324`) from the raw tool name in scope at each. Note the two sites derive the name differently (function-call name vs `invocation.tool`) — read each site's locals rather than assuming.

Every existing normalizer ignores the new field, so this is additive only.

- [ ] **Task 7: Verify & commit**

`npm run all`. Then one commit: `feat(references): add exact matching, optional url, and accumulateBody to the source DSL`.

**Done when:** all three affordances exist and are honored; `exact` and url-less extraction have tests; both env types carry `toolName`; every existing source's behavior is byte-identical and its fixtures pass untouched.

### Step 1 outcome (landed 2026-07-28, branch `feature/mcp-integration`)

All seven tasks complete. Files changed: `SourceDefinition.ts`, `SourceDefinitionRegistry.ts` (+`.test.ts`), `SourceEngine.ts` (+`.test.ts`), `ClaudeEnvelopeParser.ts`, `CodexEnvelopeParser.ts`, `bindings/codex/CodexBinding.ts`.

Verified: typecheck ✓ both workspaces · lint ✓ (701 + 221 files, `--error-on-warnings`) · CLI 8710 tests pass, coverage 98.8 / 96.65 / 98.68 / 99.06 vs the 97 / 96 / 97 / 97 floor · vscode 4296 pass. The stable-order and `CLAUDE_TOOL_PREFIXES` tests correctly did NOT break (no source registered yet).

**Learnings that change later steps:**

1. **`validateDefinition` ALSO required `url` — the plan missed this.** `SourceDefinitionRegistry.ts` had `for (const key of ["nativeId", "title", "url"])` requiring a present object. Making `url?` optional in the interface alone would have left `getRegistry()` **throwing at process start** in Step 3, because the built-in load is fail-fast. Fixed here: `url` moved out of the required loop into an optional check beside `description`/`guard`. **General rule for Steps 2-5: any schema-level optionality must be mirrored in the validator, or the fail-fast built-in load turns it into a startup crash.**
2. **`toolName` is per-CALL, the rest of the Codex env is per-SCAN.** `slackEnv` was hoisted once outside both loops, so it could not carry a tool name. It is now `scanEnv`, typed `Omit<CodexNormalizeEnv, "toolName">`, spread at each call site with the name in scope — `call.name` on PRIMARY (`:246`), `ev.tool` on FALLBACK (`:324`). Step 5's binding reads `env.toolName`; the two paths supply differently-shaped names, which is a further reason the Step 5 capture must pin both.
3. **`Object.hasOwn` is NOT in the CLI tsconfig's `lib` target** (the vscode workspace's is newer). Use the `in` operator in `cli/` tests. Cost one typecheck round-trip.
4. **A stale comment in `SourceEngine.ts` claimed Slack marks `url` optional.** It does not — no shipped source does. Corrected while touching those lines.
5. **`SourceDefinitionRegistry` is exported**, so `new SourceDefinitionRegistry([localDef])` tests match rules without touching the singleton. Use this in later steps rather than mutating global registry state.

**Environment flakes on this machine — do NOT chase these as regressions.** Both pass in isolation; both fail only under full-suite parallel load:
- `cli/src/sync/BootstrapMerge.test.ts` — one 30s timeout (passes 31/31 alone). Run the CLI suite with `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all GIT_CONFIG_KEY_1=core.excludesFile GIT_CONFIG_VALUE_1=/dev/null` to suppress this machine's `safe.bareRepository=explicit` and XDG `.jolli/` global-ignore interference.
- `vscode/src/services/BackfillDismissFlag.test.ts` and `ManualDisableFlag.test.ts` — "reads false when nothing is set" (pass 9/9 alone). The repo's real `.jolli/jollimemory/profile.json` is written during test runs, so these race against actual machine state. **Latent test-isolation bug in the repo, pre-existing and out of scope here** — worth its own issue if it keeps costing time.

---

## Step 2 — Accumulation seams + link-less auto-note  — STATUS: DONE

**Goal:** A source flagged `accumulateBody` collects query entries in its markdown body across both the within-scan and across-scan collapse points, capped and deduped. The auto-note stops claiming a link exists for a source that has none.

**Contracts to honor:** The body must round-trip through `renderMarkdown` → `parseMarkdown` unchanged, and the `<!-- jolli:auto-note -->` sentinel must never be accumulated into the body (`stripReferenceNote` at `:200`/`:306` already handles this on read — rely on it, do not re-implement).

**Why two seams:** `writeReferenceMarkdown` alone is insufficient because `dedupeKeepLatest` discards duplicates before they reach the store. `dedupeKeepLatest` alone is insufficient because the Stop hook re-scans incrementally and each scan would overwrite the previous file.

**Body format** (newest first, cap 20, deduped on the query string keeping the newer timestamp):

```markdown
- `queue worker lock` — 2026-07-28T09:14:02.000Z
- `folder storage dual write` — 2026-07-28T08:51:40.000Z
```

- [x] **Task 1: Write the merge helper's tests**

In `cli/src/core/references/ReferenceStore.test.ts`, test a new exported `mergeAccumulatedBody(existingBody: string, incomingBody: string, cap = 20): string`:
  - empty existing → incoming unchanged;
  - two distinct entries → both present, newest first;
  - same query twice with different timestamps → one entry, the newer timestamp;
  - 21 distinct entries → 20 kept, oldest dropped;
  - a non-conforming existing body (a hand-edited line) is preserved rather than silently discarded — assert the exact chosen behavior;
  - input that already had the auto-note stripped stays note-free.

- [x] **Task 2: Implement the merge helper**

Add to `ReferenceStore.ts` near `stripReferenceNote`. Parse lines with an anchored regex (`` /^- `(.+)` — (\S+)$/ ``), merge into a Map keyed by query text keeping max timestamp, sort descending by timestamp, slice to `cap`, re-render. Export it for tests.

- [x] **Task 3: Accumulate in `writeReferenceMarkdown` — test first**

Test in `ReferenceStore.test.ts`: writing an `accumulateBody` reference twice with different queries produces a file containing both; writing a non-accumulating reference twice keeps only the latest (regression).

- [x] **Task 4: Implement the store seam**

In `writeReferenceMarkdown` (`ReferenceStore.ts:111-132`) the existing file is **already read** for the byte-equality check — reuse that read. Restructure so the merge happens before render and hash:

```ts
	const def = getRegistry().byId(ref.source);
	let effective = ref;
	if (def?.accumulateBody === true && existing !== undefined) {
		const prior = readReferenceMarkdownFromString(existing);
		if (prior?.description !== undefined) {
			effective = { ...ref, description: mergeAccumulatedBody(prior.description, ref.description ?? "") };
		}
	}
	const content = renderMarkdown(effective);
	const contentHash = hashReferenceContent(effective);
```

**Critical:** `content` and `contentHash` must both derive from `effective`, not `ref` — the current code computes them from `ref` at `:117-118` before the read. Move those two lines below the read and the merge. `readReferenceMarkdownFromString` strips the sentinel, so the note is never accumulated.

- [x] **Task 5: Accumulate in `dedupeKeepLatest` — test first**

Test: three `Reference` objects sharing a mapKey from an `accumulateBody` source collapse to one whose description holds all three entries and whose `referencedAt` is the latest. Non-accumulating sources still collapse last-wins.

- [x] **Task 6: Implement the extractor seam**

In `ReferenceExtractor.ts:158-171`, in the `existing !== undefined` branch, merge descriptions for accumulating defs before applying the existing latest-wins timestamp rule. `dedupeKeepLatest` is **not** inside a `v8 ignore` block, so both the accumulating and non-accumulating branches need coverage.

- [x] **Task 7: Link-less auto-note variant — test first, then implement**

`referenceNote()` (`ReferenceStore.ts:228`) currently renders *"Only the query and the `<label>` link are recorded here"*, which is factually wrong for a source with no URL. Branch on `def.reference.url === undefined` (pure def inspection, no reference instance needed) to emit e.g. *"Only the query is recorded here — <label>'s full response is intentionally not saved."* Test both arms. This note is not cosmetic: it exists because sparse context7 references made users think the system was broken.

- [x] **Task 8: Verify & commit**

`npm run all`. One commit: `feat(references): accumulate reference bodies for act-shaped sources`.

**Done when:** both seams merge for accumulating sources and are provably inert for the other 11; the cap and query-dedupe are tested; the auto-note has a link-less variant; round-trip through render/parse is asserted.

### Step 2 outcome (2026-07-28, branch `feature/mcp-integration`)

All eight tasks complete. Files changed: `ReferenceStore.ts` (+`.test.ts`), `ReferenceExtractor.ts` (+`.test.ts`).

Verified: build ✓ both workspaces · typecheck ✓ both · lint ✓ (922 files, `--error-on-warnings`) · CLI 8734 tests pass, coverage **98.8 / 96.66 / 98.69 / 99.06** vs the 97 / 96 / 97 / 97 floor (branches and functions each up a hundredth from Step 1) · vscode: only the two known flag-service flakes below.

**Design change from the plan — bodies are lifted at EXTRACTION, not at either merge site.**

The plan's `mergeAccumulatedBody(existingBody, incomingBody, cap)` signature only works if both arguments are already entry-line form. But `extractRef` produces a BARE body (the `description` FieldSpec reads `query` from the payload), and the timestamp each entry needs lives on `Reference.referencedAt` — not in the payload — so no `FieldSpec` can produce the line. Had the lifting been left to the merge sites, each would have had to sniff "is this body raw or already a list?", and `dedupeKeepLatest`'s existing side is bare on the FIRST merge and list-form on every later one.

Resolved by adding `formatAccumulatedEntry(text, at)` and calling it in `walkPayload`, the single `extractRef` call site, for `accumulateBody` defs only. That establishes the invariant *an accumulating source's `description` is always entry-line form*, so both merge sites are pure list∪list merges and the plan's signature is kept verbatim. **Step 3 depends on this:** the `jollimemory` definition's `description` spec stays a plain `{ op: "path", path: "query" }` — do NOT try to build the entry line in the DSL.

**Two open behaviours settled with the user (both were flagged for decision):**

1. **A hand-edited (non-conforming) line is preserved, hoisted above the machine-managed list.** These files are the human-browsable Memory Bank layer; a user's own text must survive the next memory query. A wholly non-conforming body is treated the same way.
2. **The cap drop is announced in the body**, not silent — `> _Older queries beyond the most recent 20 were dropped._`, recognized on parse and re-derived on render so it never accumulates. It is **sticky**: carried forward once seen, because deriving it purely from "did *this* merge overflow?" makes it vanish on a later merge whose incoming query happens to be a duplicate — announcing a permanent loss and then retracting it.

**Learnings that change later steps:**

1. **The accumulation window needs no windowing code.** `finalizeReferenceArchive` (`QueueWorker.ts:1462`) deletes the local `.md` AND the `plans.json` row after the orphan snapshot lands, so "queries since the last commit" falls out of the lifecycle for free.
2. **References have no guard row** — unlike plans/notes, `contentHashAtCommit` is never persisted for a reference (`SessionTracker.ts:1252`, and `associateReferencesWithCommit` recomputes nothing). So a changing body cannot trigger the infinite re-upsert loop the edge-newline regression test guards against. The returned `contentHash` still must derive from the MERGED reference, which is why the existing-file read now happens *before* render/hash in `writeReferenceMarkdown`.
3. **Testing an accumulating source before `jollimemory` exists needs a registry mock, and the safe shape is EXTEND, not replace.** `vi.mock("./SourceDefinitionRegistry.js", …)` wrapping `importOriginal` and returning `new actual.SourceDefinitionRegistry([...actual.getRegistry().all(), SYNTHETIC])`. Every shipped definition stays exactly as loaded, so no existing expectation moves — including the module-load-time `CLAUDE_TOOL_PREFIXES` derivation, which simply gains one unused needle. Used in both `ReferenceStore.test.ts` and `ReferenceExtractor.test.ts` with id `acctest` / prefix `mcp__acctest__`. **Step 3 should DELETE neither** — they cover the seams against a url-less definition independently of the real one; Step 3 Task 8's end-to-end test is the backstop that proves the real wiring matches the synthetic.
4. **Route repeated `x.description ?? ""` through one helper (`bodyOf`).** Inlined at N sites it is N independent branch pairs the 96% branch floor demands N body-less tests for; funnelled through one function a single test covers the nullish arm everywhere. Same trick applies to any Step 3/5 normalizer with several optional reads.
5. **`vitest --testTimeout` cannot raise a file that calls `vi.setConfig`.** `GitClient.test.ts:37` and `BootstrapMerge.test.ts:43` both set `testTimeout: 30_000`, *below* the config's 45s — so under full-suite parallel load they starve and no CLI flag helps. **`--maxWorkers=2` is what gets a green CLI run on this machine**, and vitest prints NO coverage report at all when any test fails, so a flaky run yields no coverage number to check against the floor.

**Environment flakes — unchanged from Step 1, still not regressions.** All pass in isolation; all fail only under full-suite parallel load, and none of these files touch references:
- `cli/src/sync/GitClient.test.ts` (3 tests), `cli/src/sync/BootstrapMerge.test.ts` (1), `cli/src/core/BranchCommitLister.test.ts` (1) — real-git subprocess suites, 175/175 in isolation. Run the CLI suite with `--maxWorkers=2` plus `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all GIT_CONFIG_KEY_1=core.excludesFile GIT_CONFIG_VALUE_1=/dev/null`.
- `vscode/src/services/BackfillDismissFlag.test.ts` and `ManualDisableFlag.test.ts` — "reads false when nothing is set", 9/9 in isolation. Still the latent test-isolation bug against the repo's real `.jolli/jollimemory/profile.json`; worth its own issue.

---

## Step 3 — The `jollimemory` source (Claude path)  — STATUS: DONE

**Goal:** The source itself, end to end on Claude Code. After this Step the feature works for Claude users.

**Contracts to honor:** `nativeId` is the bare tool name (path-safe: no `/`, `\`, `..` — so `nativeIdPathSafe: true`). `trackOnly: true` reuses the four existing seams with zero code change. `argumentsDerived: true` means the result is never read — which also sidesteps `recall`'s enormous payloads (72,378 chars observed during design research, large enough to be offloaded).

**Settled by the design — do not re-litigate:** id `jollimemory`; three tools (`recall`, `search`, `get_decision_timeline`); `list_branches` dropped; no URL; one reference per tool.

- [x] **Task 1: Normalizer test**

`cli/src/core/references/sources/JolliMemoryNormalize.test.ts` — `normalizeJolliMemory(toolInput, toolName)`:
  - `recall` with `{branch:"feature/x"}` → `{tool:"recall", query:"feature/x"}`;
  - `recall` with `{}` → `{tool:"recall", query:"(current branch)"}`;
  - `search` with `{query:"queue worker"}` → `{tool:"search", query:"queue worker"}`;
  - `search` with no query → `null`;
  - `get_decision_timeline` with `{slug:"config-driven-mcp-sources"}` → `{tool:"get_decision_timeline", query:"config-driven-mcp-sources"}`;
  - `get_decision_timeline` with no slug → `null`;
  - `mcp__jollimemory__list_branches` → `null` (explicitly out of scope);
  - an unknown tool name → `null`;
  - non-object `toolInput` → `null` for the arg-requiring tools, but `recall` still yields `(current branch)` **only if** `toolInput` is an object — decide and test the exact behavior for `undefined`.

Every one of these branches is required for the coverage floor.

- [x] **Task 2: Normalizer implementation**

`JolliMemoryNormalize.ts` — switch on `toolName` (never duck-type: a bare `recall()` and `list_branches()` are both `{}`). Mirror `Context7Normalize.ts`'s shape: `isObject` guard from `../guards.js`, a local `readString`, explicit `null` returns.

- [x] **Task 3: Definition test**

`sources/definitions/jollimemory.test.ts` — assert `trackOnly`/`argumentsDerived`/`accumulateBody` are all `true`; `reference.url` is `undefined`; `extractRef` on `{tool:"search", query:"queue worker"}` yields `mapKey === "jollimemory:search"`, `nativeId === "search"`, `title === "Search"`, `url === undefined`; a payload with an unknown `tool` voids. Cover every reject branch.

- [x] **Task 4: The definition**

`sources/definitions/jollimemory.ts`:

```ts
export const jolliMemoryDefinition: SourceDefinition = {
	id: "jollimemory",
	label: "Jolli Memory",
	icon: "history",
	trackOnly: true,
	argumentsDerived: true,
	accumulateBody: true,
	match: {
		claude: {
			prefixes: ["mcp__jollimemory__"],
			exact: [
				"mcp__jollimemory__recall",
				"mcp__jollimemory__search",
				"mcp__jollimemory__get_decision_timeline",
			],
		},
		// codex: Step 5 — MUST come from a captured fixture, never inference.
	},
	wrapperKeys: [],
	reference: {
		nativeId: { pipe: [{ op: "path", path: "tool" }], require: "^(recall|search|get_decision_timeline)$" },
		title: { pipe: [ /* map tool → "Recall" | "Search" | "Decision timeline" */ ], require: ".+" },
		// url: deliberately absent — the referenced system is this repo's own memory.
		description: { pipe: [{ op: "path", path: "query" }], optional: true },
	},
	fields: [],
	storage: { nativeIdPathSafe: true },
	render: { wrapperTag: "jolli-memory-lookups", itemTag: "lookup", bodyTag: "queries", maxCharsPerReference: 2000, maxTotalChars: 6000 },
};
```

`prefixes` must stay the bare namespace — `CLAUDE_TOOL_PREFIXES` derives the transcript pre-filter needles from it (`bindings/claude/index.ts:32-38`). For `title`, either carry the display label in the normalizer output (simplest — add a `title` key there and use a `path` op) or build it with a `coalesce` of `regex` ops; prefer the former, and adjust Task 1/2 accordingly.

The `render` block is dead configuration (track-only sources never reach a block builder), same as context7's — include it because the DSL requires it.

- [x] **Task 5: Register the normalizer and the definition**

- `ClaudeEnvelopeParser.ts:317-344` — add `jollimemory: (_payload, toolInput, env) => normalizeJolliMemory(toolInput, env.toolName),`. `CONTEXT_NORMALIZER_IDS` derives from `Object.keys`, so `toolInput` retention at `:244` is automatic.
- `sources/definitions/index.ts:28-39` — import and append `jolliMemoryDefinition` after `context7Definition`. Position is unconstrained (the prefix is unique), but appending keeps the stable-order test diff minimal.

- [x] **Task 6: `KnownSourceId` + `SOURCE_META` (compile-coupled pair)**

- `cli/src/Types.ts:792` — append `| "jollimemory"`.
- `vscode/src/views/SourceLabels.ts:40` — this is now a **compile error** until you add:
  ```ts
  	jollimemory: { label: "Jolli Memory", letter: "J", icon: "history", color: "#9B5CFF" },
  ```
  `#9B5CFF` is the primary from `vscode/assets/icon.svg`. This row also feeds `REFERENCE_SOURCE_IDS` (`SidebarWebviewProvider.ts:62`, `Object.keys(SOURCE_META)`), the security allow-list for the committed-memory evidence-open message — without it those clicks silently no-op. It also generates the badge CSS rule; without it the badge falls through to a different neutral than every other unknown-source path.

- [x] **Task 7: THE TWO TESTS THAT WILL BREAK — hand-edit both**

Neither auto-passes.

1. `cli/src/core/references/SourceDefinitionRegistry.test.ts:46` — append `"jollimemory"` to the expected array **and** update the `it(...)` title string, which spells out the full order.
2. `cli/src/core/references/bindings/claude/index.test.ts:15` — append `"mcp__jollimemory__"` to the `CLAUDE_TOOL_PREFIXES` exact-array assertion.

Run **both files whole**, no `-t` filter.

- [x] **Task 8: Claude parser fixture tests**

Add a describe block to `ClaudeEnvelopeParser.test.ts` following that file's existing `tool_use`/`tool_result` builder style. Cover:
  - a `search` call yields one reference with the query as description;
  - **the disambiguation test that proves the whole `toolName` mechanism**: a bare `recall()` (`input: {}`) yields a `recall` reference, while `mcp__jollimemory__list_branches` (also `input: {}`) yields nothing;
  - **the exact-match test**: `mcp__jollimemory__search_remote_articles` and `mcp__jollimemory__search_remote_repo` yield nothing, while `mcp__jollimemory__search` yields a reference;
  - three `search` calls in one transcript collapse to one reference with three accumulated body entries (the Step 2 seam, exercised end to end).

Prefer a real captured transcript slice over hand-authored envelopes.

- [x] **Task 9: Verify & commit**

`npm run all`. One commit: `feat(references): capture Jolli memory lookups as track-only references`.

**Done when:** a Claude session calling the three tools produces exactly three accumulating references; the sibling `search_*` tools and `list_branches` produce none; both breaking tests are updated; typecheck passes in both workspaces.

### Step 3 outcome (2026-07-28, branch `feature/mcp-integration`)

All nine tasks complete. New: `sources/JolliMemoryNormalize.ts` (+`.test.ts`), `sources/definitions/jollimemory.ts` (+`.test.ts`). Modified: `ClaudeEnvelopeParser.ts` (+`.test.ts`), `sources/definitions/index.ts`, `Types.ts`, `SourceDefinitionRegistry.test.ts`, `bindings/claude/index.test.ts`, `ReferenceExtractor.test.ts`, `vscode/views/SourceLabels.ts`.

Verified: build ✓ · typecheck ✓ both · lint ✓ (926 files) · CLI 8756 tests, coverage **98.8 / 96.67 / 98.69 / 99.06** vs the 97 / 96 / 97 / 97 floor · vscode all pass (99.22 / 98.03 / 98.79 / 99.4) — the two flag-service flakes happened to pass this run too.

**Both open questions settled with the user:** id is **`jollimemory`** (matches the MCP server name and namespace, so id / prefix / persisted `sourceToolName` all agree; readability rides on the separate `label`), and a bare `recall()` records the **literal `(current branch)`** (extraction runs at post-commit time, so a resolved branch may not be the branch at call time; keeping it literal also keeps the normalizer pure, which Step 5's differently-shaped env needs).

**THE finding — `recall`'s result is ALWAYS offloaded, and `argumentsDerived` is the only reason recall is captured at all.**

Real transcripts show `recall` returning 72,378 chars, which blows Claude Code's tool-output cap, so the transcript carries only `Error: result (72,378 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to <path>.` The offload path is recall's NORMAL case. Traced through `ClaudeEnvelopeParser.ts:401-437`: `JSON.parse` throws → `recoverOffloadedPayload` runs → if the session-scoped offload file is already cleaned up (the common case at post-commit time) recovery returns undefined → **`argumentsDerived === true` supplies `parsedPayload = {}`** instead of dropping. Both outcomes are now pinned by tests using the real pointer wording. Without that flag, recall would have silently vanished most of the time. The existing `OFFLOAD_POINTER_RES[0]` regex handles the real wording unchanged (`across 1 line` sits before the matched phrase).

Minor, deliberately not fixed: for an `argumentsDerived` source the offload recovery reads back a file whose payload is then discarded (72 KB for a recall). Harmless — each call is scanned once behind the cursor — but skipping recovery when `argumentsDerived` is set would be a free win if the ordering is ever revisited.

**Learnings that change later steps:**

1. **The plan misplaced one test; it now lives in `ReferenceExtractor.test.ts`.** `claudeEnvelopeParser.parse()` returns raw per-call results and never dedupes, so the "three searches collapse to one reference with three body entries" assertion cannot be made in `ClaudeEnvelopeParser.test.ts`. It is now an end-to-end extractor test against the REAL definition — which is what proves Step 2's synthetic `acctest` source and the real one agree.
2. **`normalizeJolliMemory` accepts a bare (un-prefixed) tool name**, stripping only the known `mcp__jollimemory__` prefix and matching anything else verbatim. **Step 5 can reuse it untouched** once the real Codex names are captured — but note a dotted form (`jollimemory.recall`, as Rovo produces) will NOT match and needs whatever mapping the fixture dictates. Do not add that mapping speculatively.
3. **Two independent gates reject the out-of-scope tools, on purpose.** The registry's `exact` allow-list rejects before extraction; the normalizer's `default:` arm rejects again. Keep both — they are edited by different future changes, and `MatchCodex` has no `exact` equivalent, so on Codex the normalizer arm will be the ONLY gate.
4. **`list_branches` was never actually called in any local transcript**, nor were `search_remote_articles` / `search_remote_repo` — so those negative fixtures are hand-authored. Acceptable because what is under test is the tool NAME, and the names come from `TOOL_DEFINITIONS` in this repo's own `McpServer.ts` (authoritative, not inferred). `recall` / `search` / `get_decision_timeline` argument names were all pinned against that same source: `branch?` / `query` / `slug`.
5. **`SOURCE_META`'s letter `J` collides with Jira's.** Accepted: `zoom-meeting` / `zoom-doc` already collide on `Z`, the badge colors differ (`#9B5CFF` vs Jira's `#0052cc`), and Jolli is the first-party brand. Flag it in Step 4's manual verification if the two ever appear adjacent in one panel.
6. **Ripple sites were exactly the three the plan named** — stable-order list, `CLAUDE_TOOL_PREFIXES`, and `KnownSourceId`→`SOURCE_META`. `REFERENCE_SOURCE_IDS` (`SidebarWebviewProvider.ts:62`) is `Object.keys(SOURCE_META)` so it updated itself, and `SourceLabels.test.ts` has no exhaustive count assertion. Confirmed by grep for `Record<KnownSourceId` and `BUILTIN_DEFINITIONS` consumers; no fourth site exists.

---

## Step 4 — VS Code: suppress the dead open-in-browser affordance  — STATUS: IN PROGRESS (Tasks 1–2 done, 3–4 open)

**Findings not anticipated by this plan:**

1. **No data-contract change was needed.** `ReferenceHover.url` and `ReferenceInfo.url` are already required strings carrying `""` for "no url" (`entry.url ?? ""`), and the serialized `referenceHover` already reaches the webview. So all three gates are a plain emptiness test — nothing new had to be threaded through `SidebarMessages`. The context menu reads it via the existing `lookupBranchHoverById(id)` in the same closure.
2. **The hover card's `<hr>` had to become conditional too.** The plan only listed the action row. But `appendAiReasonRow` early-returns on a normal row, so with the action row gone the unconditional rule at the end of `renderReferenceHoverCard` was left dangling as a bare line under the fields. Fix: collect everything below the rule into a `tail` array, emit the rule only when `tail` is non-empty, and pop `appendAiReasonRow`'s own trailing rule when no action row follows it.
3. **Two comments asserted an invariant `jollimemory` had already broken.** `ReferenceService.ts:193` ("every shipping source requires it, so it is effectively always present") and the `SummaryHtmlBuilder` test at old line 1307 ("defensive — no shipping source emits one"). Both updated: an empty url is now a real, expected state for a track-only source. The `SummaryHtmlBuilder` test was inverted from "emits an empty `data-reference-url`" to "omits the button entirely", plus a new regression test for the url-bearing arm.
4. **One existing test legitimately broke.** `SidebarScriptBuilder.test.ts` pins `appendAiReasonRow(kids, <idKey>)` for all three renderers; the reference renderer now passes `tail`. Assertion updated to `appendAiReasonRow(tail, mapKey)` — the id key is what that test is really pinning, and the comment now says so.

**Verification status:** `npm run all` — build / lint / typecheck clean; CLI 8763 passed, VS Code 4300 passed. Two failures, both pre-existing environment flakes unrelated to this change (zero overlap with the changed files), each green in isolation: `GitClient.test.ts` (needs `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all` on this machine → 135/135) and `ManualDisableFlag.test.ts` (full-suite-only flake → 6/6). Coverage is unaffected in the sidebar builder because its conditionals live inside the emitted template literal, never executed by tests; the one real TS conditional (`SummaryHtmlBuilder`'s `openExternalBtn` ternary) has both arms covered.

**Goal:** A URL-less reference stops offering an action that cannot work. Today all three affordances render unconditionally and produce the warning toast *"jollimemory reference … has a non-http(s) URL — refusing to open"* — a message written for a tampered-URL defense, not for an intentionally link-less source.

**Contracts to honor:** `openReferenceInBrowser`'s scheme guard (`ReferenceService.ts:148-150`) stays **exactly as is** — it remains the correct defense against a hand-edited URL. We suppress the affordance upstream; we do not weaken the sink.

**CSP constraint:** the VS Code webviews run under a strict CSP with no `unsafe-inline` — inline `style=""` and inline event handlers are silently dropped. These must be **conditional renders at build time** (omit the element when there is no URL), not runtime toggles. If any variant does need runtime show/hide, use the `.hidden` class, never the HTML `hidden` attribute or `el.hidden` (both get overridden by `display: flex`).

- [x] **Task 1: Gate the three call sites**

| Surface | Location | Change |
|---|---|---|
| Sidebar context menu | `SidebarScriptBuilder.ts:5994` | omit the `Open in Browser` entry when the reference has no url |
| Hover-card action | `SidebarScriptBuilder.ts:3007` | omit the `jollimemory.openReferenceInBrowser` action when there is no url |
| Summary panel 🌍 | `SummaryHtmlBuilder.ts:1338` | already interpolates `e.url ?? ""` — omit the whole `<button>` when that is empty |

Beware the builder backtick trap: these builders return one big template literal, so a backtick inside a comment truncates the entire literal. Quote identifiers with single or double quotes in any comment you add.

- [x] **Task 2: Tests**

Add to the existing builder test suites: a reference with a url still renders all three affordances (regression); a reference without one renders none of them, and the surrounding row/hover-card is otherwise unchanged.

- [ ] **Task 3: Manual verification**

`cd vscode && npm run deploy`, then **Developer: Reload Window**. Run a Claude session that calls `recall` and `search`, confirm two rows appear in the References panel with the Jolli badge, plain click previews the markdown, and no open-in-browser affordance is offered. Also click a `jollimemory` row inside a committed memory's evidence group to confirm the `SOURCE_META`-derived allow-list from Step 3 lets it through. If `cli/src/**` changed since the last build, run `cd cli && npm run build` first — the extension bundles the CLI at build time.

- [ ] **Task 4: Verify & commit**

`npm run all`. One commit: `fix(vscode): hide open-in-browser for references with no external URL`.

**Done when:** no dead affordance renders for a URL-less reference; the scheme guard is untouched; every URL-bearing source is unchanged; manually verified in a reloaded window.

---

## Step 5 — Codex path  — STATUS: DONE

> **DO NOT START THIS STEP until Task 1 has produced a real captured fixture. Do not write `match.codex` from inference.**

**Why this is a hard gate.** Jolli registers itself in Codex as a *local* MCP server (`~/.codex/config.toml`), so `resolveCodexDef` (`CodexEnvelopeParser.ts:394-395`) rejects it — it requires the `mcp__codex_apps__` namespace prefix. Only the `mcp_tool_call_end` FALLBACK survives, matched on `invocation.tool`. The unknown is **what string lands there**: context7's local shape was `"query-docs"`; Rovo's was the dotted `"atlassian_rovo.getJiraIssue"`. This repo has already inferred a Codex tool name wrongly once, and the design doc for that work records the lesson. Guessing here would repeat it.

- [x] **Task 1: PREREQUISITE — capture a real envelope**

In a scratch checkout, run a `codex` session that calls `mcp__jollimemory__recall`, `search`, and `get_decision_timeline`. Use a **natural** prompt ("use jolli memory to recall what we decided about X") — Codex lazy-loads MCP tools and an "call it exactly" instruction makes it refuse before loading. Then from the rollout JSONL, pin verbatim:
  - the `function_call` `namespace` and `name` for each of the three tools;
  - the `mcp_tool_call_end` `invocation.tool` and `invocation.arguments` for each;
  - whether the request line survives the parser's four hard-coded pre-filter needles at all.

Record these in this plan file under this task before writing any code. Scrub anything sensitive.

**CAPTURED — live Codex rollout, 2026-07-28** (`~/.codex/sessions/2026/07/28/rollout-…`, `cli_version` gpt-5.4 session; 12 envelope lines extracted for fixture use). All three tools were exercised naturally.

Codex models a LOCAL MCP server as a *namespace of bare tool names* — a third shape, distinct from both Claude and the `codex_apps` connectors:

| Surface | namespace | tool string |
|---|---|---|
| Claude | — | `mcp__jollimemory__recall` (namespace+tool fused) |
| Codex `codex_apps` connector | `mcp__codex_apps__asana` | `asana.get_task` (**dotted**) |
| **Codex local server (this)** | `mcp__jollimemory` | `recall` (**bare, undotted**) |

The namespace only appears in `tool_search_output` (Codex lazy-loads tools via its own tool search); it is **absent from the call envelope entirely**.

Per-tool capture — `function_call.name` is the bare tool, `invocation.arguments` is an ALREADY-PARSED object:

| tool | `function_call.name` | `function_call.arguments` (string) | `invocation` |
|---|---|---|---|
| recall | `recall` | `{}` | `{server:"jollimemory", tool:"recall", arguments:{}}` |
| search | `search` | `{"query":"oauth","limit":10}` | `{server:"jollimemory", tool:"search", arguments:{query:"oauth",limit:10}}` |
| get_decision_timeline | `get_decision_timeline` | `{"slug":"ide-sign-in-support"}` | `{server:"jollimemory", tool:"get_decision_timeline", arguments:{slug:"ide-sign-in-support"}}` |

Argument names match `McpServer.ts` `TOOL_DEFINITIONS` — no inference needed.

**Pre-filter answer (the question this task asked): the request line does NOT survive.** Measured against the four needles at `CodexEnvelopeParser.ts:137-144`:

| line | survives | needle |
|---|---|---|
| `function_call` | **NO — dropped** | none (no `mcp__codex_apps__` prefix; name is bare) |
| `mcp_tool_call_end` | yes | `mcp_tool_call_end` |
| `function_call_output` | yes | `function_call_output` |

Confirmed for all three tools. This matches the gate's prediction exactly: only the `mcp_tool_call_end` FALLBACK can see a local server. It costs us **nothing** here — `invocation` carries server + tool + arguments together, and the source is `argumentsDerived`, so the dropped request line held no information we need.

Two shape details no amount of inference would have produced:

1. **`result` is wrapped in `Ok`** — `{"Ok":{content:[{type:"text",text:"…"}]}}`. Rust `Result<T,E>` serialization leaking into the wire format (Codex is Rust); presumably `Err` on failure.
2. **`function_call_output.output` carries a preamble** — `Wall time: 4.4036 seconds\nOutput:\n` precedes the MCP content-array JSON. Not clean JSON.

Being `argumentsDerived` sidesteps BOTH: nothing reads `result` or `output` on this path.

- [x] **Task 2: `match.codex` + the binding**

Add `match.codex` to `jollimemory.ts` using **only** the captured names, and create `bindings/codex/CodexJolliMemoryBinding.ts` registered in `CODEX_NORMALIZERS` (`bindings/codex/index.ts`).

**Known wrinkle to resolve here, not before:** `CodexNormalizer.canonicalToolName` (`CodexBinding.ts:46`) is a **single string per binding** and becomes `NormalizedToolResult.toolName` on the Codex path — it cannot represent three tools, so the persisted `sourceToolName` would be one fixed value for all three. Options: (a) accept it and store the namespace-level name, (b) widen `canonicalToolName` to allow a resolver function. Decide once the fixture shows what the raw names actually are; (b) is a shared-interface change affecting every binding, so prefer (a) unless the fixture forces otherwise.

- [x] **Task 3: Codex parser fixture tests**

Add a describe block to `CodexEnvelopeParser.test.ts` (run whole, no `-t`) built from the Task 1 capture, mirroring the context7 local-MCP fallback tests already in that file. Include a negative case for the sibling `search_*` tools — note `MatchCodex` has **no** `denySuffixes` or `exact` equivalent, so exclusion on Codex must come from `invocationTools`/`functionCallNames` listing only the wanted names, or from a guard in the normalizer. Confirm which, from the fixture.

- [x] **Task 4: Verify & commit**

`npm run all`. One commit: `feat(references): capture Jolli memory lookups on Codex`.

**RESOLVED — the wrinkle (Task 2).** The fixture forced the wider option, but in a gentler form than anticipated. All ten existing bindings set `canonicalToolName` to the CLAUDE tool name — that is what makes `sourceToolName` host-independent, so one lookup captured from either agent persists one string. jollimemory needs three such names, which a single string cannot hold; option (a) would have made Codex-captured references disagree with Claude-captured ones, and because `accumulateBody` merges both hosts into the same file (same `mapKey`), the frontmatter value would drift with whoever wrote last. So `canonicalToolName` became `string | ((rawToolName: string) => string)` — a UNION, not a signature change, leaving all ten existing bindings valid and untouched. Reads go through a new `resolveCanonicalToolName` helper at the two `CodexNormalizer` call sites; the third (line 279) is a `CliBinding`, a different interface, unaffected.

**RESOLVED — Codex-side exclusion (Task 3).** No guard needed. `registry.match` tests the no-namespace case with `m.invocationTools.includes(toolName)` — `Array.includes`, exact by construction. Claude's `prefixes` are a `startsWith` test, which is exactly why `MatchClaude.exact` had to be invented to stop `mcp__jollimemory__search` swallowing `search_remote_articles`. On Codex, naming only the wanted three IS the exclusion; a test pins the `search_*` siblings out.

**Also unchanged, deliberately:** `JolliMemoryNormalize` needed no edit — Step 3 already wrote it to accept a bare OR Claude-prefixed tool name, so the FALLBACK's bare `invocation.tool` flows straight through.

**Done when:** a real Codex session produces the same three references as Claude; the fixture is committed and scrubbed; no inferred tool name exists anywhere in the source.

---

## Step 6 — Docs & specs  — STATUS: DONE

**Goal:** The doc surfaces that enumerate sources stop being stale, and the deliberate precedent break is recorded rather than left as a silent contradiction.

- [x] **Task 1: `specs/153-transcript-reference-extraction.md`**

Two prose enumerations of the built-in count and list (~lines 39 and ~50). Also note the source-id model section's path-safe vs hashed list if it enumerates.

- [x] **Task 2: `specs/154-external-reference-source-adapters.md`**

The heaviest one: opening topic statement, the id list (~39), the registration-order paragraph (~49), the per-source budget/render-tag tables, a new `### jollimemory` subsection, and the Codex-reachability tally (~335 — currently "10 of 11"). If Step 5 is still blocked when this Step runs, say so explicitly in the tally rather than counting it.

Also worth stating here: the spec's title and framing say **external**. `jollimemory` is the first source where that is false. Add a sentence acknowledging it.

- [x] **Task 3: `specs/256-slack-thread-reference-capture.md` — the precedent amendment**

Spec 256 currently states the general principle that *"a reference the user can never click through to is considered to carry nothing worth keeping"*, used to justify voiding a Slack thread with no permalink. `jollimemory` deliberately contradicts it. Amend to distinguish the two cases:
  - a **failed** link resolution (the destination exists, we could not resolve it) → void, as Slack does today;
  - a source with **no external destination at all** → keep, and suppress the open affordance.

Do not weaken Slack's behavior; only scope the principle so it stops reading as a blanket ban.

- [x] **Task 4: READMEs**

`cli/README.md:22` and `:85` (feature bullet + Codex-support table row) and `vscode/README.md:110` (reference-capture bullet). State the **Claude Code + Codex only** limitation plainly — every other transcript reader discards tool calls, so a Cursor or Copilot user will otherwise just see a feature that appears broken.

- [x] **Task 5: Verify & commit**

`npm run all` (docs-only, but the gate is cheap and catches a stray lint). One commit: `docs: document the jollimemory reference source`.

**Beyond the listed counts, three statements had become false rather than merely stale** — each is a place the docs asserted an invariant this source breaks:

- spec 153 said the record shape models `url` as optional "as a forward-compatibility allowance, though no current built-in emits an absent url". One now does.
- spec 153 said "exactly one built-in declares the flag today (Context7)". Two do.
- spec 153's path-safe list read "every built-in except `github` and `context7`" — `jollimemory` is path-safe and had to join the list, not just the count.

Spec 154's title dropped "external" and its scope now states the self-referential exception explicitly, rather than leaving the word quietly wrong. Step 5 landing before this Step means the Codex reachability tallies count `jollimemory` normally (twelve on Claude, eleven on Codex — Zoom Doc remains the sole Codex-unreachable source) instead of carrying the "still blocked" caveat this task allowed for.

**Done when:** no doc enumerates 11 sources; the external-framing and link-less-precedent contradictions are addressed in the specs rather than left implicit; the host limitation is stated in both READMEs.

---

## Self-Review

**Design coverage:**
- Three DSL affordances (`exact`, optional `url`, `accumulateBody`) → Step 1. ✓
- Accumulation at both collapse points + cap + query-dedupe → Step 2. ✓
- `toolName` threading through both env types → Step 1 Task 6. ✓
- Three tools, `list_branches` dropped, sibling `search_*` excluded → Step 3 Tasks 1/4/8. ✓
- URL-less end to end (extract → persist → render → UI) → Step 1 Task 5, Step 2 Task 7, Step 4. ✓
- `trackOnly` → Step 3 Task 4 (flag only; all four seams pre-exist). ✓
- VS Code References panel surface → Step 3 Task 6 + Step 4. ✓
- Jolli Space push surface → **no work required**; verified the payload carries an arbitrary `source` string end to end. ✓
- Codex → Step 5, gated. ✓
- Docs/specs incl. the spec-256 amendment → Step 6. ✓

**Ripple checklist reconciliation:** all 15 items from the design's change set map onto a task above. Item 10 (Codex binding) is Step 5; items 14-15 are Step 3 Task 7 and Step 6.

**Sizing:** Steps 1, 2 and 4 are comfortably one session. Step 3 is the largest (9 tasks) but is a single coherent unit — splitting it would leave `KnownSourceId` edited without `SOURCE_META`, which does not compile. Step 6 is small and could be folded into Step 4 if a session has room.

**Workflow preference honored:** no task runs `npm run all` or commits except the final task of each Step, which does both once.

**Placeholder scan:** one deliberate open choice — the `title` derivation in Step 3 Task 4 offers two mechanisms with a stated preference (carry the label in the normalizer) and instructs adjusting Tasks 1/2 to match. Step 5 Task 2 carries a genuinely undecidable-until-captured option pair, with a stated default. Everything else is concrete.

## Known residuals (flag during review)

- **Self-referential noise.** Each reference becomes a Jolli Space article ("Jolli Memory · Search") that is itself findable by `search_remote_articles`, and lands in `CommitSummary.references` feeding the local Orama index. `trackOnly` blocks the generation feedback loop but not index pollution. Bounded to three articles per commit by the one-per-tool design. Watch during dogfooding; the cheapest lever if it becomes noise is excluding `trackOnly` sources from the search index.
- **Accumulation cap of 20 is unmeasured** — chosen for readability. A heavy research session will exceed it and drop the oldest queries. Make the drop visible in the body rather than silent.
- ~~**Open: should a bare `recall()` resolve the actual branch name?**~~ **SETTLED in Step 3: no** — it records the literal `(current branch)`. Extraction runs at post-commit time, so a resolved name may not be the branch at call time, and a resolved-but-wrong name is worse than an honest placeholder. Keeping it literal also keeps the normalizer pure, which Step 5's differently-shaped env needs.
- ~~**Open: `jollimemory` vs `jolli` as the source id.**~~ **SETTLED in Step 3: `jollimemory`** — id, tool prefix, and persisted `sourceToolName` all agree, and readability rides on the separate `label: "Jolli Memory"`. Now on disk under `references/jollimemory/`, so changing it would require a migration.
- **Hosts other than Claude and Codex cannot see these calls at all** — including Cline, Devin and Antigravity, which only just gained Jolli MCP registration on this branch. Not fixable within this design; the server-side ledger alternative in the design doc is the path if that coverage is ever needed.
