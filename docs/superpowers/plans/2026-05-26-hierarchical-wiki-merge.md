# Hierarchical Wiki Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `<kbRoot>/_wiki/` cover **every** branch with compiled knowledge, not just the top-20 by mtime, by introducing a two-level (hierarchical) merge that splits N branches into batches of ≤ `BATCH_SIZE`, level-1-merges each batch, then level-2-merges those batch results into a single `MergedKnowledge` that drives wiki rendering.

**Architecture:** Two new functions in [cli/src/core/KnowledgeCompiler.ts](../../cli/src/core/KnowledgeCompiler.ts) — `mergeOfMerges(level1Results, config, cwd)` for level-2 and `mergeBranchesHierarchical(branches, config, cwd)` as the orchestrator. When N ≤ `BATCH_SIZE`, the orchestrator delegates to the existing flat `mergeBranches` (zero behavior change). When N > `BATCH_SIZE`, it sorts branches by name, batches into chunks of `BATCH_SIZE`, runs `mergeBranches` per batch, then calls `mergeOfMerges` to produce the top-level artifact. Level-2's output shape is **identical** to flat merge output — `branches` = union of all batches' branches (sorted), `sourceCompiledFingerprints` = concat of all level-1 inputs' fingerprints. `buildMergeSlug` hashes the canonical branch set, so the final on-disk path is the same as a hypothetical "single flat merge of all N branches" — `FolderStorage.generateWikiPages` works unchanged.

**Tech Stack:** TypeScript (ESM), Vitest with `vi.mock`, existing `callLlm` + `formatCompiledForMerge` helpers, no new prompt template (level-2 reuses the `merge` action with each input formatted as a "batch" label instead of a "branch" label).

---

## Rationale (amends prior spec)

[docs/superpowers/specs/2026-05-26-compile-all-branches-design.md](../specs/2026-05-26-compile-all-branches-design.md) declared the `MAX_MERGE_BRANCHES = 20` cap was *intentional* because "merge is a single LLM call whose prompt size scales with branch count; the cap is there for a real reason." This plan removes that single-call constraint, which removes the real reason, which allows the cap to come down. Per-branch compile remains uncapped (unchanged from the prior spec).

The 64K output ceiling ([cli/src/core/KnowledgeCompiler.ts](../../cli/src/core/KnowledgeCompiler.ts) `MERGE_MAX_TOKENS`) still applies to each individual LLM call. Hierarchical merge keeps each call's input small (≤ `BATCH_SIZE` branches' worth of compiled topics, or ≤ `BATCH_SIZE` level-1 results' worth of merged topics) — well inside the truncation safety margin.

Cost: a 50-branch repo becomes `ceil(50/20) + 1 = 4` LLM calls instead of 1. Acceptable because (a) compile cost is dominated by per-branch compile, not merge, and (b) the user explicitly asked for full coverage. The CLI prints the batching plan up front so cost is not hidden.

---

## File Structure

**Create:**
- (none — all changes are in existing files; no new modules)

**Modify:**
- [cli/src/core/KnowledgeCompiler.ts](../../cli/src/core/KnowledgeCompiler.ts) — extract `formatTopicsForMerge` helper from `formatCompiledForMerge`; add `mergeOfMerges` and `mergeBranchesHierarchical` exports; add `HIERARCHICAL_BATCH_SIZE` constant.
- [cli/src/core/KnowledgeCompiler.test.ts](../../cli/src/core/KnowledgeCompiler.test.ts) — add `describe("mergeBranchesHierarchical")` and `describe("mergeOfMerges")` blocks.
- [cli/src/commands/CompileCommand.ts](../../cli/src/commands/CompileCommand.ts) — replace `MAX_MERGE_BRANCHES = 20` slicing in both `runForceMerge` and `runCompileAll` with `mergeBranchesHierarchical`; remove the local constant.
- [cli/src/commands/CompileCommand.test.ts](../../cli/src/commands/CompileCommand.test.ts) — update existing tests that asserted top-20 capping behavior; add tests for ≤ BATCH_SIZE and > BATCH_SIZE paths.
- [cli/src/hooks/QueueWorker.ts](../../cli/src/hooks/QueueWorker.ts) — same change in `runCompileMergeFromQueue`: remove local `MAX_MERGE_BRANCHES = 20`, call `mergeBranchesHierarchical(allBranches, …)`.
- [cli/src/hooks/QueueWorker.test.ts](../../cli/src/hooks/QueueWorker.test.ts) — update tests that asserted top-20 behavior in the auto-merge path.
- [docs/superpowers/specs/2026-05-26-compile-all-branches-design.md](../specs/2026-05-26-compile-all-branches-design.md) — add a "Superseded by 2026-05-26-hierarchical-wiki-merge" note to the section that motivated the cap.

**Create (spec amendment):**
- [docs/superpowers/specs/2026-05-26-hierarchical-wiki-merge-design.md](../specs/2026-05-26-hierarchical-wiki-merge-design.md) — short spec capturing the rationale + invariants. Written in Task 8.

**Do NOT touch:**
- [cli/src/core/FolderStorage.ts](../../cli/src/core/FolderStorage.ts) `generateWikiPages` — already wholesale-rebuilds `_wiki/` from a single `MergedKnowledge` JSON. Level-2 output has identical shape; this code path is invariant by design.
- [cli/src/core/CompiledStore.ts](../../cli/src/core/CompiledStore.ts) `buildMergeSlug` / `saveMerged` / `readMerged` — slug already hashes the sorted branch set, so the same N-branch input yields the same path whether produced by flat or hierarchical merge.
- [cli/src/core/CacheValidator.ts](../../cli/src/core/CacheValidator.ts) — operates on `sourceCompiledFingerprints` which level-2 still populates (flattened from all batches), so validator behavior is preserved.
- [cli/src/Types.ts](../../cli/src/Types.ts) `MergedKnowledge` — no new fields; level-2 output uses the existing optional shape.

---

## Project conventions enforced in this plan

- **No per-task commit and no per-task `npm run test`.** Memory of this repo's owner: write code + tests across all tasks, then run `npm run all` once + commit once in the final task. (Standard writing-plans format calls for per-task commit; user instruction overrides.)
- **DCO sign-off required**: final commit uses `git commit -s …` — no `Co-Authored-By: Claude` trailer, no "🤖 Generated with …" footer.
- **97% statements / 96% branches / 97% functions / 97% lines coverage threshold** on `cli/src/**` ([cli/vite.config.ts](../../cli/vite.config.ts)). New code in `KnowledgeCompiler.ts` and the three callers must be covered by the new tests.
- **Pin behavior with a failing test first** (TDD per memory). Task 1 is the failing-test pin; only after that do implementation tasks land.

---

## Task 1: Pin the hierarchical contract with a failing test

**Files:**
- Modify: [cli/src/core/KnowledgeCompiler.test.ts](../../cli/src/core/KnowledgeCompiler.test.ts) — append a new `describe("mergeBranchesHierarchical")` block at end of file.

- [ ] **Step 1: Add the failing contract test**

Edit `cli/src/core/KnowledgeCompiler.test.ts`. At the very bottom of the file (after the existing `describe("mergeBranches")` block closes), append:

```ts
describe("mergeBranchesHierarchical", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function makeCompiled(branch: string): CompiledKnowledge {
		return {
			version: 1,
			branch,
			compiledAt: "2026-04-10T12:00:00Z",
			sourceSummaries: ["aaa111"],
			sourceUserFiles: [],
			topics: [
				{
					title: `Topic from ${branch}`,
					stableSlug: `topic-from-${branch.replace(/[^a-z0-9-]+/gi, "-")}`,
					content: `Content from ${branch}`,
					sourceCommits: ["aaa111"],
				},
			],
		};
	}

	it("returns a single MergedKnowledge whose branches contain every input when N > BATCH_SIZE", async () => {
		const branches = Array.from({ length: 25 }, (_, i) => `feature/b${String(i).padStart(2, "0")}`);
		mockReadCompiled.mockImplementation(async (branch: string) => makeCompiled(branch));
		mockCallLlm.mockResolvedValue({
			source: "anthropic-config",
			text: `===TOPIC===
---TITLE---
Synthesized Topic
---CONTENT---
Merged across batches.
---SOURCECOMMITS---
aaa111`,
			inputTokens: 1000,
			outputTokens: 200,
			apiLatencyMs: 1500,
			model: "claude-haiku-4-5-20251001",
			stopReason: "end_turn",
		});
		mockSaveMerged.mockResolvedValue();

		const { mergeBranchesHierarchical } = await import("./KnowledgeCompiler.js");
		const result = await mergeBranchesHierarchical(branches, llmConfig, "/test");

		expect(result).not.toBeNull();
		expect(result?.branches).toHaveLength(25);
		// Result branches must cover every input, in sorted order.
		const expected = [...branches].sort();
		expect(result?.branches).toEqual(expected);
		// 25 / 20 = 2 batches → 2 level-1 calls + 1 level-2 call = 3 LLM calls total.
		expect(mockCallLlm).toHaveBeenCalledTimes(3);
		// All three calls must use the "merge" action.
		for (const call of mockCallLlm.mock.calls) {
			expect(call[0].action).toBe("merge");
		}
	});

	it("delegates to flat mergeBranches when N <= BATCH_SIZE (single LLM call)", async () => {
		const branches = Array.from({ length: 10 }, (_, i) => `feature/b${i}`);
		mockReadCompiled.mockImplementation(async (branch: string) => makeCompiled(branch));
		mockCallLlm.mockResolvedValue({
			source: "anthropic-config",
			text: `===TOPIC===
---TITLE---
Flat Merge
---CONTENT---
Single call.
---SOURCECOMMITS---
aaa111`,
			inputTokens: 500,
			outputTokens: 100,
			apiLatencyMs: 800,
			model: "claude-haiku-4-5-20251001",
			stopReason: "end_turn",
		});
		mockSaveMerged.mockResolvedValue();

		const { mergeBranchesHierarchical } = await import("./KnowledgeCompiler.js");
		const result = await mergeBranchesHierarchical(branches, llmConfig, "/test");

		expect(result).not.toBeNull();
		expect(result?.branches).toHaveLength(10);
		expect(mockCallLlm).toHaveBeenCalledTimes(1);
	});

	it("returns null when no branches have compiled knowledge", async () => {
		mockReadCompiled.mockResolvedValue(null);

		const { mergeBranchesHierarchical } = await import("./KnowledgeCompiler.js");
		const result = await mergeBranchesHierarchical(
			Array.from({ length: 25 }, (_, i) => `feature/b${i}`),
			llmConfig,
			"/test",
		);

		expect(result).toBeNull();
		expect(mockCallLlm).not.toHaveBeenCalled();
	});

	it("returns null (fail-loud) when any level-1 batch truncates at max_tokens", async () => {
		const branches = Array.from({ length: 25 }, (_, i) => `feature/b${String(i).padStart(2, "0")}`);
		mockReadCompiled.mockImplementation(async (branch: string) => makeCompiled(branch));
		// First batch's LLM call truncates → mergeBranches returns null → hierarchical bails.
		mockCallLlm.mockResolvedValueOnce({
			source: "anthropic-config",
			text: "===TOPIC===\n---TITLE---\nPartial\n---CONTENT---\nTruncated.",
			inputTokens: 1000,
			outputTokens: 64_000,
			apiLatencyMs: 5000,
			model: "claude-haiku-4-5-20251001",
			stopReason: "max_tokens",
		});

		const { mergeBranchesHierarchical } = await import("./KnowledgeCompiler.js");
		const result = await mergeBranchesHierarchical(branches, llmConfig, "/test");

		expect(result).toBeNull();
	});
});
```

This block pins four contract invariants (sorted branch union, correct call count, empty-input fail-soft, truncation fail-loud). The first invariant alone is enough to drive most of the implementation.

---

## Task 2: Refactor `formatCompiledForMerge` to share a topic formatter

**Files:**
- Modify: [cli/src/core/KnowledgeCompiler.ts](../../cli/src/core/KnowledgeCompiler.ts) `formatCompiledForMerge` (lines 415-435).

- [ ] **Step 1: Extract the topic-formatting body into `formatTopicsForMerge`**

In `cli/src/core/KnowledgeCompiler.ts`, replace the existing `formatCompiledForMerge` function (currently lines 415-435) with:

```ts
/** Formats a labeled topic block for the merge LLM prompt. Used by both
 * level-1 (`label = branch name`) and level-2 (`label = "batch-N"`) paths. */
function formatTopicsForMerge(label: string, dateStr: string, topics: ReadonlyArray<CompiledTopic>): string {
	const lines: string[] = [`## ${label} (compiled ${dateStr})`];

	for (const topic of topics) {
		lines.push("");
		lines.push(`### ${topic.title}`);
		lines.push(topic.content);
		if (topic.keyDecisions && topic.keyDecisions.length > 0) {
			lines.push("**Key Decisions:**");
			for (const d of topic.keyDecisions) {
				lines.push(`- ${d}`);
			}
		}
		if (topic.sourceCommits.length > 0) {
			lines.push(`**Source commits:** ${topic.sourceCommits.join(", ")}`);
		}
	}

	return lines.join("\n");
}

/** Formats a branch's compiled knowledge into text for the merge prompt. */
function formatCompiledForMerge(branch: string, compiled: CompiledKnowledge): string {
	return formatTopicsForMerge(`Branch: ${branch}`, compiled.compiledAt, compiled.topics);
}
```

Note: the heading prefix `Branch:` is preserved verbatim from the previous implementation so the existing merge prompt continues to receive the exact same text shape. Level-2 will use `Batch <i>/<n>` as the label.

The `CompiledTopic` import already exists at the top of the file (line 12). No new imports required.

---

## Task 3: Implement `mergeOfMerges` (the level-2 merger)

**Files:**
- Modify: [cli/src/core/KnowledgeCompiler.ts](../../cli/src/core/KnowledgeCompiler.ts) — append the new `mergeOfMerges` export below the existing `mergeBranches`.

- [ ] **Step 1: Add `HIERARCHICAL_BATCH_SIZE` constant near the existing `MERGE_MAX_TOKENS`**

Below the line `const MERGE_MAX_TOKENS = 64_000;` (currently line 36), add:

```ts
/** Maximum branches fed into a single LLM merge call. Beyond this, callers
 * should use `mergeBranchesHierarchical` which splits into batches of this
 * size and runs a level-2 merge of merges. Chosen to keep each LLM call's
 * input + output comfortably below MERGE_MAX_TOKENS (64K) even for
 * topic-heavy branches. */
export const HIERARCHICAL_BATCH_SIZE = 20;
```

- [ ] **Step 2: Add the `mergeOfMerges` function**

Append at the end of the file (after the existing helpers, before any default export if present — match the file's tail style):

```ts
/**
 * Level-2 merge — takes the {@link MergedKnowledge} outputs of multiple
 * level-1 batch merges and produces a single top-level {@link MergedKnowledge}
 * whose `branches` is the union of all inputs' branches.
 *
 * Reuses the existing `merge` LLM action by formatting each level-1 input as
 * a "Batch i/n" labeled topic block. The LLM doesn't need to know its
 * inputs are already-merged — the merge prompt's instructions apply
 * recursively (group/deduplicate topics across the inputs).
 *
 * Fingerprints: the returned `sourceCompiledFingerprints` is the concatenation
 * of all level-1 inputs' fingerprints, so {@link CacheValidator} can detect
 * any underlying per-branch compile drift across the full set transparently.
 *
 * Returns null if (a) the LLM truncates at `max_tokens`, or (b) any input
 * has zero topics (caller should not invoke us in that case, but we guard
 * defensively).
 */
export async function mergeOfMerges(
	level1Results: ReadonlyArray<MergedKnowledge>,
	config: LlmConfig,
	cwd?: string,
): Promise<MergedKnowledge | null> {
	if (level1Results.length === 0) {
		log.info("mergeOfMerges: no level-1 inputs — nothing to merge");
		return null;
	}

	// Format each level-1 result as a labeled topic block. We pass `Batch i/n`
	// as the label so the LLM's grouping prompt treats them as peer inputs
	// the same way it treats branch inputs at level 1.
	const compiledTopicsText = level1Results
		.map((merged, i) => formatTopicsForMerge(`Batch ${i + 1}/${level1Results.length}`, merged.mergedAt, merged.topics))
		.join("\n\n===BRANCH_SEPARATOR===\n\n");

	// Union of all input branches, sorted for deterministic slug + storage path.
	const allBranches = [...new Set(level1Results.flatMap((m) => m.branches))].sort();

	log.info(
		"mergeOfMerges: merging %d level-1 results spanning %d branches",
		level1Results.length,
		allBranches.length,
	);

	const result = await callLlm({
		action: "merge",
		params: {
			branches: allBranches.join(", "),
			compiledTopics: compiledTopicsText,
		},
		model: resolveModelId(config.model),
		apiKey: config.apiKey,
		jolliApiKey: config.jolliApiKey,
		maxTokens: MERGE_MAX_TOKENS,
	});

	if (result.stopReason === "max_tokens") {
		log.error(
			"Level-2 merge LLM output truncated at max_tokens (model=%s, output=%d tokens). Reduce HIERARCHICAL_BATCH_SIZE or raise MERGE_MAX_TOKENS.",
			result.model ?? "unknown",
			result.outputTokens,
		);
		return null;
	}

	const topics = parseCompileResponse(result.text ?? "");

	// Flatten level-1 fingerprints + sourceCompilations so the validator's
	// existing per-branch drift checks keep working unchanged.
	const flattenedFingerprints = level1Results.flatMap((m) => m.sourceCompiledFingerprints ?? []);
	const flattenedSources = level1Results.flatMap((m) => m.sourceCompilations);

	const merged: MergedKnowledge = {
		version: 1,
		branches: allBranches,
		mergedAt: new Date().toISOString(),
		sourceCompilations: flattenedSources,
		sourceCompiledFingerprints: flattenedFingerprints,
		topics,
		...(result.model && {
			llm: {
				model: result.model,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				apiLatencyMs: result.apiLatencyMs,
				stopReason: result.stopReason ?? null,
			},
		}),
	};

	await saveMerged(merged, cwd);
	log.info("Level-2 merge complete: %d topics from %d branches", topics.length, allBranches.length);
	return merged;
}
```

- [ ] **Step 3: Add a test for `mergeOfMerges`**

Append to `cli/src/core/KnowledgeCompiler.test.ts` (after the `describe("mergeBranchesHierarchical")` block):

```ts
describe("mergeOfMerges", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function makeLevel1(branches: string[]): MergedKnowledge {
		return {
			version: 1,
			branches,
			mergedAt: "2026-04-10T12:00:00Z",
			sourceCompilations: branches.map((b) => ({ branch: b, compiledAt: "2026-04-10T12:00:00Z" })),
			sourceCompiledFingerprints: branches.map((b) => ({ branch: b, fingerprint: "f".repeat(64) })),
			topics: [
				{
					title: `Level1 topic ${branches.join("+")}`,
					stableSlug: `level1-${branches.join("-").replace(/[^a-z0-9-]+/gi, "-")}`,
					content: `Content`,
					sourceCommits: ["aaa111"],
				},
			],
		};
	}

	it("unions input branches and flattens fingerprints into the level-2 result", async () => {
		const inputs = [makeLevel1(["a", "b"]), makeLevel1(["c", "d"])];
		mockCallLlm.mockResolvedValue({
			source: "anthropic-config",
			text: `===TOPIC===
---TITLE---
Top
---CONTENT---
Top-level merged.
---SOURCECOMMITS---
aaa111`,
			inputTokens: 800,
			outputTokens: 150,
			apiLatencyMs: 1200,
			model: "claude-haiku-4-5-20251001",
			stopReason: "end_turn",
		});
		mockSaveMerged.mockResolvedValue();

		const { mergeOfMerges } = await import("./KnowledgeCompiler.js");
		const result = await mergeOfMerges(inputs, llmConfig, "/test");

		expect(result).not.toBeNull();
		expect(result?.branches).toEqual(["a", "b", "c", "d"]);
		expect(result?.sourceCompiledFingerprints).toHaveLength(4);
		expect(result?.sourceCompilations).toHaveLength(4);
		// Each batch is labeled as "Batch i/n" in the prompt.
		const llmCall = mockCallLlm.mock.calls[0][0];
		expect(llmCall.params.compiledTopics).toContain("Batch 1/2");
		expect(llmCall.params.compiledTopics).toContain("Batch 2/2");
		expect(mockSaveMerged).toHaveBeenCalledOnce();
	});

	it("returns null when LLM truncates at max_tokens", async () => {
		mockCallLlm.mockResolvedValue({
			source: "anthropic-config",
			text: "===TOPIC===\n---TITLE---\nPartial\n---CONTENT---\nx",
			inputTokens: 1000,
			outputTokens: 64_000,
			apiLatencyMs: 5000,
			model: "claude-haiku-4-5-20251001",
			stopReason: "max_tokens",
		});

		const { mergeOfMerges } = await import("./KnowledgeCompiler.js");
		const result = await mergeOfMerges([makeLevel1(["a"]), makeLevel1(["b"])], llmConfig, "/test");

		expect(result).toBeNull();
		expect(mockSaveMerged).not.toHaveBeenCalled();
	});

	it("returns null when input list is empty", async () => {
		const { mergeOfMerges } = await import("./KnowledgeCompiler.js");
		const result = await mergeOfMerges([], llmConfig, "/test");
		expect(result).toBeNull();
		expect(mockCallLlm).not.toHaveBeenCalled();
	});
});
```

The `MergedKnowledge` type import already exists at the top of the test file via `CompiledKnowledge` and friends — verify the import line currently reads `import type { CommitSummary, CompiledKnowledge, LlmConfig } from "../Types.js";` and update it to include `MergedKnowledge`:

```ts
import type { CommitSummary, CompiledKnowledge, LlmConfig, MergedKnowledge } from "../Types.js";
```

---

## Task 4: Implement `mergeBranchesHierarchical` (the orchestrator)

**Files:**
- Modify: [cli/src/core/KnowledgeCompiler.ts](../../cli/src/core/KnowledgeCompiler.ts) — append the new export.

- [ ] **Step 1: Add `mergeBranchesHierarchical` below `mergeOfMerges`**

```ts
/**
 * Top-level entry point for cross-branch wiki merge. Picks the right
 * strategy automatically:
 *
 *  - N <= {@link HIERARCHICAL_BATCH_SIZE}: delegate to flat `mergeBranches`
 *    (1 LLM call). Zero behavior change from the pre-hierarchical world.
 *  - N >  {@link HIERARCHICAL_BATCH_SIZE}: sort branches by name, split into
 *    batches of HIERARCHICAL_BATCH_SIZE, run `mergeBranches` per batch
 *    (level 1), then run `mergeOfMerges` over the level-1 results
 *    (level 2). Total LLM calls: ceil(N/B) + 1.
 *
 * Sorting branches by name (not mtime) makes batching deterministic across
 * runs and across machines — same input set produces the same batch
 * composition, which lets level-1 caches reuse on repeat invocations.
 *
 * Returns null if no input branches have compiled knowledge, or if any
 * LLM call truncates at max_tokens (matches the existing flat
 * `mergeBranches` fail-loud contract).
 */
export async function mergeBranchesHierarchical(
	branches: ReadonlyArray<string>,
	config: LlmConfig,
	cwd?: string,
): Promise<MergedKnowledge | null> {
	if (branches.length === 0) {
		log.info("mergeBranchesHierarchical: empty input — nothing to merge");
		return null;
	}

	// Fast path: small set fits in one LLM call.
	if (branches.length <= HIERARCHICAL_BATCH_SIZE) {
		log.info("mergeBranchesHierarchical: %d branches fit in one call — using flat merge", branches.length);
		return mergeBranches(branches, config, cwd);
	}

	// Deterministic batching: sort by branch name and chunk.
	const sorted = [...branches].sort();
	const batches: string[][] = [];
	for (let i = 0; i < sorted.length; i += HIERARCHICAL_BATCH_SIZE) {
		batches.push(sorted.slice(i, i + HIERARCHICAL_BATCH_SIZE));
	}

	log.info(
		"mergeBranchesHierarchical: %d branches → %d batches of <= %d (total %d LLM calls expected)",
		sorted.length,
		batches.length,
		HIERARCHICAL_BATCH_SIZE,
		batches.length + 1,
	);

	// Level 1: merge each batch. Fail loud on any null (truncation or empty).
	const level1Results: MergedKnowledge[] = [];
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		log.info("Level-1 batch %d/%d: %d branches", i + 1, batches.length, batch.length);
		const result = await mergeBranches(batch, config, cwd);
		if (!result) {
			log.error(
				"Level-1 batch %d/%d returned null (truncation or no compiled inputs) — aborting hierarchical merge",
				i + 1,
				batches.length,
			);
			return null;
		}
		level1Results.push(result);
	}

	// Level 2: merge of merges.
	log.info("Level-2 merge over %d batch results", level1Results.length);
	return mergeOfMerges(level1Results, config, cwd);
}
```

- [ ] **Step 2: Verify the four `describe("mergeBranchesHierarchical")` tests from Task 1 pass without further changes**

The tests from Task 1 cover: > BATCH_SIZE (25 branches, 3 calls), <= BATCH_SIZE (10 branches, 1 call), all-null compiled inputs, and level-1 truncation. They should now pass.

---

## Task 5: Wire `CompileCommand.runCompileAll` through hierarchical merge

**Files:**
- Modify: [cli/src/commands/CompileCommand.ts](../../cli/src/commands/CompileCommand.ts) — replace `MAX_MERGE_BRANCHES` slicing in `runCompileAll` (currently lines 235-256), remove the file-local constant if no other reference remains after Task 6.

- [ ] **Step 1: Update the import line**

Change:

```ts
import { compileBranches, mergeBranches } from "../core/KnowledgeCompiler.js";
```

to:

```ts
import { compileBranches, mergeBranches, mergeBranchesHierarchical } from "../core/KnowledgeCompiler.js";
```

- [ ] **Step 2: Replace the `--all --merge` slice path**

In `runCompileAll`, replace this block (currently lines 235-256):

```ts
	if (opts.merge) {
		const readStorage = await createReadStorage(cwd);
		const allWithMtime = await listCompiledWithMtime(cwd, readStorage);
		const selected = [...allWithMtime]
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, MAX_MERGE_BRANCHES)
			.map((e) => e.branch);

		console.log(`\n  Merging ${selected.length} branch(es) into the wiki (capped from ${allWithMtime.length})...`);
		console.log(`  Branches: ${selected.join(", ")}`);

		const merged = await mergeBranches(selected, config, cwd);
		await markMergeTouched(cwd);
		if (merged) {
			console.log("\n  Wiki rebuilt!");
			console.log(`  Topics:     ${merged.topics.length}`);
			if (merged.llm) {
				console.log(`  LLM:        ${merged.llm.model} (${merged.llm.apiLatencyMs}ms)`);
			}
		} else {
			console.log("\n  Merge skipped: no compiled knowledge to merge.");
		}
	}
```

with:

```ts
	if (opts.merge) {
		const readStorage = await createReadStorage(cwd);
		const allWithMtime = await listCompiledWithMtime(cwd, readStorage);
		const allBranches = allWithMtime.map((e) => e.branch).sort();

		console.log(`\n  Merging ${allBranches.length} branch(es) into the wiki...`);
		console.log(`  Branches: ${allBranches.join(", ")}`);

		const merged = await mergeBranchesHierarchical(allBranches, config, cwd);
		await markMergeTouched(cwd);
		if (merged) {
			console.log("\n  Wiki rebuilt!");
			console.log(`  Branches:   ${merged.branches.length}`);
			console.log(`  Topics:     ${merged.topics.length}`);
			if (merged.llm) {
				console.log(`  LLM (top):  ${merged.llm.model} (${merged.llm.apiLatencyMs}ms)`);
			}
		} else {
			console.log("\n  Merge skipped: no compiled knowledge to merge, or LLM call truncated.");
		}
	}
```

Note: `listCompiledWithMtime` is still used purely to enumerate which branches have compiled caches — mtime is dropped (full set, no LRU cut), branches sorted by name for deterministic batching.

- [ ] **Step 3: Update the existing `describe("compile --all --merge")` test in CompileCommand.test.ts**

Locate the existing test in [cli/src/commands/CompileCommand.test.ts](../../cli/src/commands/CompileCommand.test.ts) that asserts `--all --merge` calls `mergeBranches` with the top-20 mtime selection. Replace its mock expectation:

Old (find by searching for `MAX_MERGE_BRANCHES` or `slice(0, 20)` or `top 20` assertions in that file — if no such assertion exists, this step becomes a no-op-verify):

```ts
// OLD
expect(vi.mocked(mergeBranches)).toHaveBeenCalledWith(
    expect.arrayContaining([/* exactly 20 branches */]),
    expect.anything(),
    expect.anything(),
);
```

New:

```ts
// NEW
expect(vi.mocked(mergeBranchesHierarchical)).toHaveBeenCalledWith(
    expect.arrayContaining([/* all branches, sorted */]),
    expect.anything(),
    expect.anything(),
);
```

Also add the `mergeBranchesHierarchical` import to the mock block at the top of the file:

```ts
vi.mock("../core/KnowledgeCompiler.js", () => ({
    compileBranches: vi.fn(),
    mergeBranches: vi.fn(),
    mergeBranchesHierarchical: vi.fn(),
}));
```

(If the existing mock block does not yet exist, add it.)

---

## Task 6: Wire `CompileCommand.runForceMerge` through hierarchical merge + drop the file-local cap constant

**Files:**
- Modify: [cli/src/commands/CompileCommand.ts](../../cli/src/commands/CompileCommand.ts) — replace `runForceMerge`'s slicing (currently lines 156-188), then delete the file-local `MAX_MERGE_BRANCHES` constant on line 41.

- [ ] **Step 1: Replace `runForceMerge` body**

Replace the existing `runForceMerge` function (currently lines 156-188) with:

```ts
/**
 * spec 110 — full-coverage force-merge. Enumerates every branch with a
 * compiled cache and routes through `mergeBranchesHierarchical`, which
 * picks flat vs. two-level automatically based on count. Touches the
 * cooldown so the next auto-merge collapses against this manual run.
 */
async function runForceMerge(
	config: { apiKey?: string; jolliApiKey?: string; model?: string },
	cwd: string,
): Promise<void> {
	const readStorage = await createReadStorage(cwd);
	const allWithMtime = await listCompiledWithMtime(cwd, readStorage);
	if (allWithMtime.length === 0) {
		console.log(
			"\n  No compiled caches yet. Run `jolli compile <branch>` first, or commit + push to trigger auto-compile.\n",
		);
		return;
	}
	const allBranches = allWithMtime.map((e) => e.branch).sort();

	console.log(`\n  Merging ${allBranches.length} branch(es) into the wiki...`);
	console.log(`  Branches: ${allBranches.join(", ")}`);

	const merged = await mergeBranchesHierarchical(allBranches, config, cwd);
	await markMergeTouched(cwd);
	if (merged) {
		console.log("\n  Wiki rebuilt!");
		console.log(`  Branches:   ${merged.branches.length}`);
		console.log(`  Topics:     ${merged.topics.length}`);
		if (merged.llm) {
			console.log(`  LLM (top):  ${merged.llm.model} (${merged.llm.apiLatencyMs}ms)`);
		}
		console.log("");
	} else {
		console.log("\n  Merge skipped: no compiled knowledge to merge, or LLM call truncated.\n");
	}
}
```

- [ ] **Step 2: Delete the file-local `MAX_MERGE_BRANCHES` constant**

Remove line 41:

```ts
const MAX_MERGE_BRANCHES = 20;
```

After Tasks 5 and 6, this constant has no remaining references in `CompileCommand.ts`. Delete it.

- [ ] **Step 3: Update or add the `runForceMerge` / `compile --merge` test**

In [cli/src/commands/CompileCommand.test.ts](../../cli/src/commands/CompileCommand.test.ts), locate the existing test for `compile --merge` (the no-args force-rebuild path). Update it to assert `mergeBranchesHierarchical` is called with the sorted full branch list instead of the top-20 slice:

```ts
it("forwards all compiled branches (sorted) to mergeBranchesHierarchical on --merge", async () => {
    vi.mocked(listCompiledWithMtime).mockResolvedValue([
        { branch: "feature/c", mtimeMs: 3000 },
        { branch: "feature/a", mtimeMs: 1000 },
        { branch: "feature/b", mtimeMs: 2000 },
    ]);
    vi.mocked(mergeBranchesHierarchical).mockResolvedValue({
        version: 1,
        branches: ["feature/a", "feature/b", "feature/c"],
        mergedAt: "2026-05-26T00:00:00Z",
        sourceCompilations: [],
        topics: [],
    });

    await runCli(["compile", "--merge", "--cwd", "/test"]);

    expect(mergeBranchesHierarchical).toHaveBeenCalledWith(
        ["feature/a", "feature/b", "feature/c"], // sorted, not mtime-ranked
        expect.anything(),
        "/test",
    );
});
```

Replace any existing assertion that expected mtime-descending order.

---

## Task 7: Wire `QueueWorker.runCompileMergeFromQueue` through hierarchical merge

**Files:**
- Modify: [cli/src/hooks/QueueWorker.ts](../../cli/src/hooks/QueueWorker.ts) — replace the slicing in `runCompileMergeFromQueue` (currently lines 464-505).

- [ ] **Step 1: Replace the function body**

Replace the existing `runCompileMergeFromQueue` function with:

```ts
/**
 * spec 110 — drives the cross-branch wiki merge from a queue entry. Uses
 * `mergeBranchesHierarchical` so the wiki covers every branch with a
 * compiled cache, regardless of count.
 *
 * Cooldown was already checked at enqueue time by `MergeTrigger`. We
 * could re-check here against a stale queue entry, but a cooldown miss
 * at the worker level means the cooldown file already records the merge
 * we are about to do — re-checking would block the very merge that owns
 * the cooldown timestamp. Trust the enqueue gate.
 */
async function runCompileMergeFromQueue(_op: CompileMergeOperation, cwd: string): Promise<void> {
	const { mergeBranchesHierarchical } = await import("../core/KnowledgeCompiler.js");
	const { listCompiledWithMtime } = await import("../core/CompiledStore.js");
	const { createReadStorage } = await import("../core/ReadStorageResolver.js");

	const config = await loadConfig();
	if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
		log.info("No API key configured — skipping compile-merge");
		return;
	}

	const readStorage = await createReadStorage(cwd);
	const allWithMtime = await listCompiledWithMtime(cwd, readStorage);
	if (allWithMtime.length === 0) {
		log.info("Compile-merge: no per-branch caches yet — skipping");
		return;
	}
	const allBranches = allWithMtime.map((e) => e.branch).sort();

	log.info("Compile-merge: %d branches → hierarchical merge: %s", allBranches.length, allBranches.join(", "));

	const llmConfig = {
		...(config.apiKey ? { apiKey: config.apiKey } : {}),
		...(config.jolliApiKey ? { jolliApiKey: config.jolliApiKey } : {}),
		...(config.model ? { model: config.model } : {}),
	};
	await mergeBranchesHierarchical(allBranches, llmConfig, cwd);
}
```

- [ ] **Step 2: Update QueueWorker tests**

In [cli/src/hooks/QueueWorker.test.ts](../../cli/src/hooks/QueueWorker.test.ts), find any test that mocks `mergeBranches` and asserts the top-20 mtime slice in the auto-merge path. Update the mock to `mergeBranchesHierarchical` and the assertion to sorted full set:

```ts
// OLD mock entry
vi.mock("../core/KnowledgeCompiler.js", () => ({
    mergeBranches: vi.fn(),
}));

// NEW
vi.mock("../core/KnowledgeCompiler.js", () => ({
    mergeBranchesHierarchical: vi.fn(),
}));
```

And in the test body that exercises `runCompileMergeFromQueue`:

```ts
it("forwards all compiled branches (sorted) to mergeBranchesHierarchical", async () => {
    vi.mocked(listCompiledWithMtime).mockResolvedValue([
        { branch: "feature/c", mtimeMs: 3000 },
        { branch: "feature/a", mtimeMs: 1000 },
        { branch: "feature/b", mtimeMs: 2000 },
    ]);
    vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" });

    await runCompileMergeFromQueue({ /* CompileMergeOperation shape */ } as never, "/repo");

    const { mergeBranchesHierarchical } = await import("../core/KnowledgeCompiler.js");
    expect(vi.mocked(mergeBranchesHierarchical)).toHaveBeenCalledWith(
        ["feature/a", "feature/b", "feature/c"],
        expect.objectContaining({ apiKey: "sk-test" }),
        "/repo",
    );
});
```

---

## Task 8: Documentation, spec amendment, final verification + commit

**Files:**
- Modify: [cli/src/commands/CompileCommand.ts](../../cli/src/commands/CompileCommand.ts) — update the file-level docstring (currently lines 1-25) to remove the "top-20 by mtime" language.
- Modify: [docs/superpowers/specs/2026-05-26-compile-all-branches-design.md](../specs/2026-05-26-compile-all-branches-design.md) — add a one-paragraph "Superseded by" note inline at the section that motivated the cap (around lines 45-51).
- Create: [docs/superpowers/specs/2026-05-26-hierarchical-wiki-merge-design.md](../specs/2026-05-26-hierarchical-wiki-merge-design.md) — short companion spec.

- [ ] **Step 1: Refresh `CompileCommand.ts` header docstring**

Replace the existing header (currently lines 1-25 of `CompileCommand.ts`) to reflect that `--all --merge` and `--merge` now cover every branch (no LRU cap). Concretely, replace any sentence containing "top-20" or "LRU top-20" or "MAX_MERGE_BRANCHES" in that header with full-coverage language:

Replace:

```ts
 *   `jolli compile --all [--merge]`      — enumerate every branch with
 *                                          summaries from index.json,
 *                                          compile each, and optionally
 *                                          merge top-20 by mtime into the
 *                                          wiki. Convenience entry point
 *                                          for first-time adopters.
 *   `jolli compile --merge`              — spec 110: force-rebuild the
 *                                          `<kbRoot>/_wiki/` layer from
 *                                          whatever compiled caches already
 *                                          exist (LRU top-20). Bypasses
 *                                          the 6h cooldown that gates the
 *                                          PostCommitHook auto-merge path.
```

with:

```ts
 *   `jolli compile --all [--merge]`      — enumerate every branch with
 *                                          summaries from index.json,
 *                                          compile each, and optionally
 *                                          merge **all** branches into the
 *                                          wiki via hierarchical merge
 *                                          (batches of HIERARCHICAL_BATCH_SIZE
 *                                          + one level-2 merge). Convenience
 *                                          entry point for first-time adopters.
 *   `jolli compile --merge`              — force-rebuild the
 *                                          `<kbRoot>/_wiki/` layer from
 *                                          **every** compiled cache on disk
 *                                          (hierarchical when count exceeds
 *                                          HIERARCHICAL_BATCH_SIZE). Bypasses
 *                                          the 6h cooldown that gates the
 *                                          PostCommitHook auto-merge path.
```

- [ ] **Step 2: Amend the prior spec**

In [docs/superpowers/specs/2026-05-26-compile-all-branches-design.md](../specs/2026-05-26-compile-all-branches-design.md), find the bullet that begins `- `--all --merge` reuses the existing `MAX_MERGE_BRANCHES = 20` cap` (around lines 45-51) and append a note immediately below the bullet:

```markdown
  **Update 2026-05-26 (superseded by 2026-05-26-hierarchical-wiki-merge):** the
  cap has been removed in favor of a hierarchical (two-level) merge. The
  reason cited above ("merge is a single LLM call whose prompt size scales
  with branch count") is dissolved by batching into level-1 merges of size
  `HIERARCHICAL_BATCH_SIZE` and then merging the level-1 results in a
  level-2 call. See the companion spec for invariants.
```

- [ ] **Step 3: Write the companion spec**

Create [docs/superpowers/specs/2026-05-26-hierarchical-wiki-merge-design.md](../specs/2026-05-26-hierarchical-wiki-merge-design.md):

```markdown
# Hierarchical wiki merge — full-coverage `_wiki/`

## Motivation

The 2026-05-26 `--all` spec kept the cross-branch wiki merge capped at the
LRU top-20 branches by mtime, on the rationale that the merge is "a single
LLM call whose prompt size scales with branch count". With 64K output
ceilings (`MERGE_MAX_TOKENS`) and streaming guardrail handling already in
place, the constraint is now per-call, not per-merge-operation. A two-level
merge lifts the cap without raising any single LLM call's input.

## Surface

No CLI flag changes. The change is transparent:

- `jolli compile --all --merge` — now merges **every** branch with a
  compiled cache, not the top-20.
- `jolli compile --merge` — now rebuilds the wiki from **every** compiled
  cache on disk, not the top-20.
- The auto-merge path in `QueueWorker.runCompileMergeFromQueue` — same.

A new constant `HIERARCHICAL_BATCH_SIZE = 20` lives in `KnowledgeCompiler.ts`.
It is the batch size used to split work into level-1 merges. Each level-1
call sees ≤ `HIERARCHICAL_BATCH_SIZE` branches' worth of compiled topics,
exactly matching the empirical safety envelope of the prior flat-merge cap.

## Invariants

- **Output shape parity.** `mergeBranchesHierarchical(allBranches, ...)`
  returns a `MergedKnowledge` indistinguishable in shape from a hypothetical
  flat `mergeBranches(allBranches, ...)`. `branches` is the sorted union,
  `sourceCompiledFingerprints` is the flattened union, on-disk path is the
  same `compiled/merged/<sha256(canonical-branches)>.json`. `FolderStorage`
  and `CacheValidator` see no shape difference.
- **Deterministic batching.** Branches are sorted by name before chunking,
  so the same input set always produces the same batch composition across
  runs and machines. Level-1 artifacts are addressable + cacheable per batch.
- **Fast path preserved.** When `N <= HIERARCHICAL_BATCH_SIZE`,
  `mergeBranchesHierarchical` delegates directly to flat `mergeBranches`.
  Small repos pay no overhead and behave identically.
- **Fail-loud on truncation.** A `max_tokens` stop reason at either level
  returns `null`. Partial merges are never persisted. Matches the existing
  flat-merge guard.

## What is explicitly out of scope

- Adaptive batch size (shrink-on-retry after truncation). Future work.
- Topic-level caching across batches (level-1 reuse when only one batch's
  underlying compiled artifacts changed). The level-1 results land in
  `compiled/merged/<batch-slug>.json` so the infrastructure is in place,
  but no caller reads them as cache today — every invocation re-runs both
  levels. Tracked separately.
- New LLM prompt template for level-2. The level-2 call reuses the same
  `merge` action with each input formatted as a "Batch i/n" labeled block.
  If quality measurement shows level-2 needs different guidance, that is a
  prompt-engineering follow-up, not a structural one.
```

- [ ] **Step 4: Run the full pre-commit gate**

```bash
npm run all
```

Expected: clean → build → lint → test all pass. Coverage on `cli/src/**` stays at or above 97% statements / 96% branches / 97% functions / 97% lines.

If coverage dips below threshold on any of the modified files (`KnowledgeCompiler.ts`, `CompileCommand.ts`, `QueueWorker.ts`), add the missing test cases — every new branch in those files must be covered.

- [ ] **Step 5: Stage and commit**

Stage exactly the files this plan touched:

```bash
git add \
  cli/src/core/KnowledgeCompiler.ts \
  cli/src/core/KnowledgeCompiler.test.ts \
  cli/src/commands/CompileCommand.ts \
  cli/src/commands/CompileCommand.test.ts \
  cli/src/hooks/QueueWorker.ts \
  cli/src/hooks/QueueWorker.test.ts \
  docs/superpowers/specs/2026-05-26-compile-all-branches-design.md \
  docs/superpowers/specs/2026-05-26-hierarchical-wiki-merge-design.md \
  docs/superpowers/plans/2026-05-26-hierarchical-wiki-merge.md
```

Commit with DCO sign-off, no Claude trailer, no emoji footer:

```bash
git commit -s -m "$(cat <<'EOF'
Hierarchical merge: cover every branch in `_wiki/`

Replace the LRU top-20 cap in the cross-branch wiki merge with a
two-level (hierarchical) merge so `<kbRoot>/_wiki/` covers every
branch with a compiled cache, not just the freshest 20.

`mergeBranchesHierarchical` sorts branches by name, splits into
batches of `HIERARCHICAL_BATCH_SIZE = 20`, runs flat `mergeBranches`
per batch (level 1), then runs `mergeOfMerges` over the level-1
results (level 2). N <= 20 takes the flat fast path unchanged.

The level-2 output is shape-identical to a hypothetical flat merge
of all N branches — same on-disk path (slug hashes the sorted branch
set), same `sourceCompiledFingerprints` shape (flattened across
batches), so `FolderStorage.generateWikiPages` and `CacheValidator`
see no difference.

Touched callers: `CompileCommand.runCompileAll`,
`CompileCommand.runForceMerge`, `QueueWorker.runCompileMergeFromQueue`.
The file-local `MAX_MERGE_BRANCHES = 20` constants are removed.

Generated by Jolli Memory · via Anthropic
EOF
)"
```

The "Generated by Jolli Memory · via Anthropic" line is the product's dogfood signature (intentional, distinct from the disallowed Claude trailer).

- [ ] **Step 6: Verify the commit landed with sign-off**

```bash
git log -1 --format='%B' | grep -q 'Signed-off-by:' && echo "DCO sign-off present"
```

Expected: `DCO sign-off present`.

---

## Self-review checklist (run after writing, before handoff)

- [x] **Spec coverage** — every section of the rationale is implemented by a task: hierarchical orchestration (Task 4), level-2 merger (Task 3), three caller wirings (Tasks 5-7), determinism via sorted batching (Task 4 step 1), fail-loud on truncation (covered in `mergeOfMerges` and asserted in Task 1 test 4).
- [x] **No placeholders** — every code step shows real code. No "TBD", no "implement later", no "similar to Task N", no unreferenced types.
- [x] **Type consistency** — `mergeOfMerges(level1Results, config, cwd)`, `mergeBranchesHierarchical(branches, config, cwd)`, `HIERARCHICAL_BATCH_SIZE` are named identically across tasks 3-7. `MergedKnowledge` shape unchanged; flattening uses `sourceCompiledFingerprints` and `sourceCompilations` exactly as defined in `Types.ts`.
- [x] **Coverage floor** — Task 1 + Task 3 step 3 provide 7 test cases across `mergeBranchesHierarchical` and `mergeOfMerges` covering: > BATCH_SIZE, ≤ BATCH_SIZE, empty input, truncation at both levels, branch union correctness, fingerprint flattening. Task 5/6/7 update caller tests. Total new test count ≈ 7-9. Should comfortably meet the 97% threshold for new lines.
- [x] **DCO + no Claude trailer** — Task 8 step 5 uses `-s` and the commit body is human-voiced with only the Jolli Memory dogfood footer.
- [x] **No per-task commit/test** — only Task 8 runs `npm run all` and commits. Per repo owner's standing preference.
