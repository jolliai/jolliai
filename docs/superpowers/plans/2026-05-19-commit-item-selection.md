# Commit-time item selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution model for this plan:** Tasks 1–10 only WRITE code and tests — **do not run tests, do not lint, do not commit**. All verification (`npm run all`, manual smoke test) and the **single** commit happen in Task 11. If the implementer subagent normally runs tests after every change, override that behavior here: write the code, save the file, move on.

**Goal:** Add per-row + per-section selection checkboxes to Conversations, Plans, Notes, and the Changes-panel file list. Unchecking writes a sticky entry to a new project-local `commit-selection.json` that the summary pipeline filters on; the file is **never** auto-cleared by any git operation.

**Architecture:** New `CommitSelectionStore` in `cli/src/core/` holds an on-disk exclusion set. `ActiveSessionAggregator` and `PlansTreeProvider.serialize()` read the store and stamp `isSelected: boolean` onto each row. `QueueWorker.runSummaryPipeline` reads the store and filters sessions / plans / notes before LLM input. Webview gains per-row checkboxes and a "Select / Deselect All" header icon button (same shape as the existing Changes/Commits one). Changes-panel `FilesStore.refresh()` flips its seed-selection default to "all selected"; the Commits panel default is intentionally unchanged.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Biome lint, Vitest, esbuild bundling for the VS Code extension. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-05-19-commit-item-selection-design.md](../specs/2026-05-19-commit-item-selection-design.md)

---

## File Structure

**Create:**

- `cli/src/core/CommitSelectionStore.ts` — sticky exclusion store
- `cli/src/core/CommitSelectionStore.test.ts` — focused unit tests
- `cli/src/hooks/QueueWorker.selection.test.ts` — pipeline filter integration
- `vscode/src/commands/SelectAllSelection.ts` — Select/Deselect All command handlers
- `vscode/src/commands/SelectAllSelection.test.ts` — command behavior tests

**Modify (CLI):**

- `cli/src/core/ActiveSessionAggregator.ts` — add `isSelected` to interface; populate from store
- `cli/src/core/ActiveSessionAggregator.test.ts` — extend with isSelected coverage
- `cli/src/hooks/QueueWorker.ts` — read exclusions + filter sessions / plans / notes inside `runSummaryPipeline`; **never write**

**Modify (VSCode):**

- `vscode/src/views/SidebarMessages.ts` — three new outbound message types
- `vscode/src/views/SidebarWebviewProvider.ts` — new dep callbacks + handler dispatch
- `vscode/src/views/SidebarWebviewProvider.test.ts` — extend
- `vscode/src/views/SidebarScriptBuilder.ts` — per-row checkboxes; two new section-header `check-all` icon buttons; cmdMap entries; click handlers
- `vscode/src/views/SidebarScriptBuilder.test.ts` — extend
- `vscode/src/providers/PlansTreeProvider.ts` — populate `isSelected` on plan / note rows in `serialize()`
- `vscode/src/providers/PlansTreeProvider.test.ts` — extend
- `vscode/src/services/ActiveSessionsProvider.ts` — pass `isSelected` through (likely no-op)
- `vscode/src/services/ActiveSessionsProvider.test.ts` — extend
- `vscode/src/Extension.ts` — register two new commands; wire three per-row callbacks; pass cwd through to provider
- `vscode/src/stores/FilesStore.ts` — flip `refresh()` seed: every raw entry goes into `selectedPaths`
- `vscode/src/stores/FilesStore.test.ts` — extend
- `cli/CHANGELOG.md`, `vscode/CHANGELOG.md` — single bullet each (Task 11)

Convention reminders (from CLAUDE.md):

- The single final commit must be signed off: `git commit -s -m "…"`. NO `Co-Authored-By: Claude` / "🤖 Generated" trailers. CI rejects PRs without DCO.
- VSCode source imports CLI core via the relative path `../../../cli/src/core/<Name>.js` — esbuild resolves at bundle time. Don't refactor those into package imports.
- VSCode webview CSP forbids inline `style=""` / `onclick=""` — wire everything via CSS class + `addEventListener` (memory note `feedback_vscode_webview_csp_no_inline.md`).
- Inside `SidebarScriptBuilder` template literals, never use backticks in comments — wrap identifier mentions in `'…'` or `"…"` (memory note `feedback_sidebar_script_builder_backtick_trap.md`).
- CLI test coverage floor is 97 % statements / 96 % branches / 97 % functions / 97 % lines on **new** code under `cli/src/`. Don't add untested branches.

---

## Task 1: Create CommitSelectionStore (CLI)

**Files:**

- Create: `cli/src/core/CommitSelectionStore.ts`
- Create: `cli/src/core/CommitSelectionStore.test.ts`

- [ ] **Step 1: Skim `cli/src/core/HiddenConversationsStore.ts` for reference**

Confirm the atomic-write + null-prototype pattern. The new store follows the same shape but holds three sets (conversations / plans / notes) instead of one map. Do not modify HiddenConversationsStore.

- [ ] **Step 2: Write `cli/src/core/CommitSelectionStore.test.ts`**

```ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import {
	conversationKey,
	type CommitExclusions,
	readExclusions,
	setAllExcluded,
	setExcluded,
} from "./CommitSelectionStore.js";

let cwd: string;

beforeEach(async () => {
	cwd = await mkdir(join(tmpdir(), `commit-sel-${Date.now()}-${Math.random()}`), {
		recursive: true,
	}).then((p) => p ?? "");
	await mkdir(join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR), { recursive: true });
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function filePath(): string {
	return join(cwd, JOLLI_DIR, JOLLIMEMORY_DIR, "commit-selection.json");
}

describe("CommitSelectionStore", () => {
	it("returns empty exclusions when the file is missing", async () => {
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
		expect(ex.plans.size).toBe(0);
		expect(ex.notes.size).toBe(0);
	});

	it("returns empty exclusions when the file is malformed", async () => {
		await writeFile(filePath(), "not json", "utf8");
		const ex = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
	});

	it("setExcluded adds a conversation key and is readable", async () => {
		await setExcluded(cwd, "conversations", conversationKey("claude", "abc"), true);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has(conversationKey("claude", "abc"))).toBe(true);
	});

	it("setExcluded(false) removes an existing key", async () => {
		await setExcluded(cwd, "conversations", conversationKey("claude", "abc"), true);
		await setExcluded(cwd, "conversations", conversationKey("claude", "abc"), false);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has(conversationKey("claude", "abc"))).toBe(false);
	});

	it("setAllExcluded bulk-adds the given keys for a kind", async () => {
		await setAllExcluded(cwd, "plans", ["p1", "p2", "p3"], true);
		const ex = await readExclusions(cwd);
		expect([...ex.plans].sort()).toEqual(["p1", "p2", "p3"]);
	});

	it("setAllExcluded bulk-removes the given keys for a kind", async () => {
		await setAllExcluded(cwd, "plans", ["p1", "p2", "p3"], true);
		await setAllExcluded(cwd, "plans", ["p1", "p3"], false);
		const ex = await readExclusions(cwd);
		expect([...ex.plans].sort()).toEqual(["p2"]);
	});

	it("conversationKey joins source and sessionId with a colon", () => {
		expect(conversationKey("claude", "abc")).toBe("claude:abc");
	});

	it("readExclusions rejects an unknown version", async () => {
		await writeFile(filePath(), JSON.stringify({ version: 99, conversations: ["x"] }), "utf8");
		const ex: CommitExclusions = await readExclusions(cwd);
		expect(ex.conversations.size).toBe(0);
	});

	it("tolerates a stale conversation key that no longer exists", async () => {
		await setExcluded(cwd, "conversations", conversationKey("codex", "ghost"), true);
		const ex = await readExclusions(cwd);
		expect(ex.conversations.has(conversationKey("codex", "ghost"))).toBe(true);
	});

	it("notes round-trip independently of plans", async () => {
		await setExcluded(cwd, "plans", "p1", true);
		await setExcluded(cwd, "notes", "n1", true);
		const ex = await readExclusions(cwd);
		expect(ex.plans.has("p1")).toBe(true);
		expect(ex.notes.has("n1")).toBe(true);
		expect(ex.plans.has("n1")).toBe(false);
	});
});
```

- [ ] **Step 3: Implement `cli/src/core/CommitSelectionStore.ts`**

```ts
/**
 * CommitSelectionStore
 *
 * Persists the set of sidebar items the user wants EXCLUDED from the next
 * summary pipeline run. Three kinds (conversations / plans / notes) live
 * in a single JSON file under
 * `<projectDir>/.jolli/jollimemory/commit-selection.json`.
 *
 * Sticky semantics: an entry stays in this file until the user explicitly
 * un-excludes the item (re-checks the row, or hits the section's Select /
 * Deselect All button). No git operation, no pipeline outcome, no editor
 * lifecycle event modifies the file — the QueueWorker only ever READS it.
 *
 * Distinct from `HiddenConversationsStore` (permanent hide — row vanishes
 * from sidebar) and from `PlanEntry.ignored` / `NoteEntry.ignored`
 * (permanent ignore at the plans-registry layer). Exclusions are visible
 * in the sidebar with an unchecked box; the row still renders.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg, isEnoent, JOLLI_DIR, JOLLIMEMORY_DIR } from "../Logger.js";
import type { TranscriptSource } from "../Types.js";

const log = createLogger("CommitSelection");

const SELECTION_FILE = "commit-selection.json";
const SELECTION_VERSION = 1 as const;

export type ExclusionKind = "conversations" | "plans" | "notes";

export interface CommitExclusions {
	readonly conversations: ReadonlySet<string>;
	readonly plans: ReadonlySet<string>;
	readonly notes: ReadonlySet<string>;
}

interface PersistedShape {
	readonly version: typeof SELECTION_VERSION;
	readonly conversations: readonly string[];
	readonly plans: readonly string[];
	readonly notes: readonly string[];
}

function selectionPath(projectDir: string): string {
	return join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR, SELECTION_FILE);
}

/**
 * Encode (source, sessionId) into a single string key. The colon is
 * reserved across jollimemory (TranscriptSource values never contain one)
 * so the key is unambiguously splittable if a debugging tool ever needs to.
 */
export function conversationKey(source: TranscriptSource, sessionId: string): string {
	return `${source}:${sessionId}`;
}

function emptyExclusions(): CommitExclusions {
	return {
		conversations: new Set<string>(),
		plans: new Set<string>(),
		notes: new Set<string>(),
	};
}

export async function readExclusions(projectDir: string): Promise<CommitExclusions> {
	let raw: string;
	try {
		raw = await readFile(selectionPath(projectDir), "utf8");
	} catch (err) {
		if (!isEnoent(err)) {
			log.warn("readExclusions read failed: %s", errMsg(err));
		}
		return emptyExclusions();
	}
	let parsed: Partial<PersistedShape>;
	try {
		parsed = JSON.parse(raw) as Partial<PersistedShape>;
	} catch (err) {
		log.warn("readExclusions JSON parse failed: %s", errMsg(err));
		return emptyExclusions();
	}
	if (parsed.version !== SELECTION_VERSION) {
		log.warn("readExclusions version mismatch (got %s) — ignoring file", String(parsed.version));
		return emptyExclusions();
	}
	return {
		conversations: new Set(asStringArray(parsed.conversations)),
		plans: new Set(asStringArray(parsed.plans)),
		notes: new Set(asStringArray(parsed.notes)),
	};
}

function asStringArray(v: unknown): readonly string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

async function writeExclusions(projectDir: string, next: CommitExclusions): Promise<void> {
	const dir = join(projectDir, JOLLI_DIR, JOLLIMEMORY_DIR);
	await mkdir(dir, { recursive: true });
	const payload: PersistedShape = {
		version: SELECTION_VERSION,
		conversations: [...next.conversations],
		plans: [...next.plans],
		notes: [...next.notes],
	};
	const tmp = `${selectionPath(projectDir)}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, JSON.stringify(payload, null, "\t"), "utf8");
	await rename(tmp, selectionPath(projectDir));
}

function mutableClone(ex: CommitExclusions): {
	conversations: Set<string>;
	plans: Set<string>;
	notes: Set<string>;
} {
	return {
		conversations: new Set(ex.conversations),
		plans: new Set(ex.plans),
		notes: new Set(ex.notes),
	};
}

export async function setExcluded(
	projectDir: string,
	kind: ExclusionKind,
	key: string,
	excluded: boolean,
): Promise<void> {
	const current = await readExclusions(projectDir);
	const next = mutableClone(current);
	const set = next[kind];
	if (excluded) set.add(key);
	else set.delete(key);
	await writeExclusions(projectDir, next);
}

export async function setAllExcluded(
	projectDir: string,
	kind: ExclusionKind,
	keys: readonly string[],
	excluded: boolean,
): Promise<void> {
	const current = await readExclusions(projectDir);
	const next = mutableClone(current);
	const set = next[kind];
	if (excluded) {
		for (const k of keys) set.add(k);
	} else {
		for (const k of keys) set.delete(k);
	}
	await writeExclusions(projectDir, next);
}

/** Delete the file from disk. Tolerates ENOENT. Not used by the pipeline — exposed for tests / manual operator use. */
export async function deleteSelectionFile(projectDir: string): Promise<void> {
	try {
		await unlink(selectionPath(projectDir));
	} catch (err) {
		if (!isEnoent(err)) {
			log.warn("deleteSelectionFile failed: %s", errMsg(err));
		}
	}
}
```

---

## Task 2: ActiveConversationItem.isSelected (CLI)

**Files:**

- Modify: `cli/src/core/ActiveSessionAggregator.ts` (interface + populate logic)
- Modify: `cli/src/core/ActiveSessionAggregator.test.ts` (extend)

- [ ] **Step 1: Skim the existing test file's fixture helpers**

Read `cli/src/core/ActiveSessionAggregator.test.ts` (first 100 lines) so the new tests reuse the same fixture pattern (mkdtemp, mocked sources, etc.).

- [ ] **Step 2: Append failing tests to `cli/src/core/ActiveSessionAggregator.test.ts`**

Add at the top of the test file:

```ts
import { conversationKey, setExcluded } from "./CommitSelectionStore.js";
```

Inside the existing top-level `describe(...)` block, append:

```ts
it("stamps isSelected=false on rows whose key is in the exclusion file", async () => {
	// Arrange: project dir with one claude session that would pass filters.
	const cwd = await createFixtureWithOneClaudeSession(); // existing helper in this file
	const sessionId = await getFixtureSessionId(cwd);     // existing helper

	// Mark the row excluded.
	await setExcluded(cwd, "conversations", conversationKey("claude", sessionId), true);

	const { items } = await listActiveConversationsWithDiagnostics({ cwd, windowMs: 60_000 });

	expect(items).toHaveLength(1);
	expect(items[0].isSelected).toBe(false);
});

it("defaults isSelected=true when the row is not in the exclusion file", async () => {
	const cwd = await createFixtureWithOneClaudeSession();
	const { items } = await listActiveConversationsWithDiagnostics({ cwd, windowMs: 60_000 });
	expect(items).toHaveLength(1);
	expect(items[0].isSelected).toBe(true);
});
```

If the existing test file uses different helper names, substitute them — the helpers are the fixture creators in that file, not invented here. If no such helper exists, inline the fixture creation following the patterns at the top of the test file.

- [ ] **Step 3: Add the field to the interface in `cli/src/core/ActiveSessionAggregator.ts`**

Replace the interface (around line 23):

```ts
export interface ActiveConversationItem {
	readonly sessionId: string;
	readonly source: TranscriptSource;
	readonly title: string;
	readonly messageCount: number;
	readonly updatedAt: string;
	readonly transcriptPath: string;
	/**
	 * Per-commit-selection signal. `false` = user has unchecked this row;
	 * the QueueWorker will skip its transcript when generating the next
	 * summary. Default `true` for any row absent from
	 * `commit-selection.json`. Independent of `HiddenConversationsStore`
	 * (which hides the row entirely).
	 */
	readonly isSelected: boolean;
}
```

- [ ] **Step 4: Populate `isSelected` in `listActiveConversationsWithDiagnostics`**

Add the import at the top of the file:

```ts
import { conversationKey, readExclusions } from "./CommitSelectionStore.js";
```

Alongside the existing `Promise.all([collectFromAllSources(...), loadHiddenConversations(...)])`, add `readExclusions(opts.cwd)`. Then in the items map, derive `isSelected`:

```ts
const [collected, hidden, exclusions] = await Promise.all([
	collectFromAllSources(opts.cwd),
	loadHiddenConversations(opts.cwd),
	readExclusions(opts.cwd),
]);

// … existing dedupe / filter logic unchanged …

const items: ActiveConversationItem[] = await Promise.all(
	visible.map(async (s) => {
		const unread = await safeLoadUnreadMerged(s, opts.cwd);
		const titleEntries = unread.length > 0 ? await safeLoadMerged(s, opts.cwd) : unread;
		const source = s.source ?? "claude";
		return {
			sessionId: s.sessionId,
			source,
			title: await resolveSessionTitle(s, titleEntries),
			messageCount: unread.length,
			updatedAt: s.updatedAt,
			transcriptPath: s.transcriptPath,
			isSelected: !exclusions.conversations.has(conversationKey(source, s.sessionId)),
		};
	}),
);
```

---

## Task 3: QueueWorker filter integration (CLI)

**Files:**

- Modify: `cli/src/hooks/QueueWorker.ts` (inside `runSummaryPipeline` / `executePipeline`)
- Create: `cli/src/hooks/QueueWorker.selection.test.ts`

- [ ] **Step 1: Skim the current pipeline header**

Read `cli/src/hooks/QueueWorker.ts` lines 870–1000 to locate:

- `executePipeline(cwd, op, force)` entry
- `loadSessionTranscripts(cwd)` call site
- `detectActivePlansForBranch` / `detectActiveNotesForBranch` call sites
- `generateSummary(summaryParams)` call site

The filter goes between "load all" and "pass to LLM" at each of those points. No file path edits elsewhere.

- [ ] **Step 2: Create `cli/src/hooks/QueueWorker.selection.test.ts`**

Use the existing `QueueWorker.overlay.test.ts` fixture pattern as the model. Skeleton (replace fixture-builder names with whatever already exists in `QueueWorker.overlay.test.ts`):

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { conversationKey, setExcluded } from "../core/CommitSelectionStore.js";
// If overlay test does not export fixture helpers, copy them inline here.
// Do NOT introduce a new fixture helper file — keep the duplication local
// until a third test file in this directory needs the same pattern.

describe("QueueWorker selection filter", () => {
	it("skips a conversation that is marked excluded in commit-selection.json", async () => {
		const ctx = await buildPipelineFixture(); // claude + codex sessions present, one commit queued
		await setExcluded(ctx.cwd, "conversations", conversationKey("codex", ctx.codexSessionId), true);

		const summaryParams = await runPipelineAndCapture(ctx); // returns args generateSummary was called with

		expect(summaryParams.conversation).not.toContain(ctx.codexTranscriptMarker);
		expect(summaryParams.conversation).toContain(ctx.claudeTranscriptMarker);
	});

	it("filters excluded plans out of formatPlansBlock input", async () => {
		const ctx = await buildPipelineFixture({ withPlanIds: ["plan-keep", "plan-skip"] });
		await setExcluded(ctx.cwd, "plans", "plan-skip", true);
		const summaryParams = await runPipelineAndCapture(ctx);
		expect(summaryParams.plans).toContain("plan-keep");
		expect(summaryParams.plans).not.toContain("plan-skip");
	});

	it("filters excluded notes out of formatNotesBlock input", async () => {
		const ctx = await buildPipelineFixture({ withNoteIds: ["note-keep", "note-skip"] });
		await setExcluded(ctx.cwd, "notes", "note-skip", true);
		const summaryParams = await runPipelineAndCapture(ctx);
		expect(summaryParams.notes).toContain("note-keep");
		expect(summaryParams.notes).not.toContain("note-skip");
	});

	it("never writes commit-selection.json from the pipeline (commit path)", async () => {
		const ctx = await buildPipelineFixture();
		await setExcluded(ctx.cwd, "conversations", conversationKey("codex", ctx.codexSessionId), true);
		const before = await readFile(ctx.selectionFilePath, "utf8");
		await runPipelineAndCapture(ctx); // normal commit op
		const after = await readFile(ctx.selectionFilePath, "utf8");
		expect(after).toBe(before);
	});

	it("never writes commit-selection.json on the amend path", async () => {
		const ctx = await buildPipelineFixture({ opType: "amend" });
		await setExcluded(ctx.cwd, "conversations", conversationKey("codex", ctx.codexSessionId), true);
		const before = await readFile(ctx.selectionFilePath, "utf8");
		await runPipelineAndCapture(ctx);
		const after = await readFile(ctx.selectionFilePath, "utf8");
		expect(after).toBe(before);
	});

	it("never writes commit-selection.json on rebase-pick / squash / failure paths", async () => {
		for (const op of ["squash", "rebase-pick", "rebase-squash"] as const) {
			const ctx = await buildPipelineFixture({ opType: op });
			await setExcluded(ctx.cwd, "conversations", conversationKey("codex", ctx.codexSessionId), true);
			const before = await readFile(ctx.selectionFilePath, "utf8");
			await runPipelineAndCapture(ctx);
			expect(await readFile(ctx.selectionFilePath, "utf8")).toBe(before);
		}
	});
});
```

- [ ] **Step 3: Modify `cli/src/hooks/QueueWorker.ts` — add the filter**

Add the import at the top of the file:

```ts
import { conversationKey, readExclusions } from "../core/CommitSelectionStore.js";
```

Inside `executePipeline(cwd, op, force)`, before transcript loading and plan/note detection:

```ts
const exclusions = await readExclusions(cwd);
```

Right after `await loadSessionTranscripts(cwd)`:

```ts
const filteredSessions = sessions.filter(
	(s) => !exclusions.conversations.has(conversationKey(s.source, s.sessionId)),
);
// use filteredSessions below in place of sessions
```

Right after `detectActivePlansForBranch(cwd, branch)`:

```ts
const filteredPlans = plans.filter((p) => !exclusions.plans.has(p.id));
```

Right after `detectActiveNotesForBranch(cwd, branch)`:

```ts
const filteredNotes = notes.filter((n) => !exclusions.notes.has(n.id));
```

Variable names should match what the existing code uses — adapt if `sessions` is called something else. The exact identifier doesn't matter; what matters is that `formatPlansBlock` / `formatNotesBlock` / `buildMultiSessionContext` receives the filtered arrays.

**Do not** add any `clear()` / write call. The pipeline is read-only against this file.

---

## Task 4: PlansTreeProvider stamps isSelected on plan / note rows (VSCode)

**Files:**

- Modify: `vscode/src/providers/PlansTreeProvider.ts` (`serialize()` and a new `refreshExclusions` helper)
- Modify: `vscode/src/providers/PlansTreeProvider.test.ts` (extend)
- Modify: `vscode/src/Extension.ts` (pass cwd into `PlansTreeProvider` constructor if not already)

- [ ] **Step 1: Skim both files**

Find `serialize()` (around line 205) and the existing test file. Note that `SerializedTreeItem.isSelected` is already an optional field — only the populate step is new.

- [ ] **Step 2: Append failing tests to `PlansTreeProvider.test.ts`**

```ts
import { setExcluded } from "../../../cli/src/core/CommitSelectionStore.js";

it("stamps isSelected=false on a plan row whose slug is in the exclusion set", async () => {
	const cwd = await mkdtempPlansFixture(["plan-keep", "plan-skip"]); // existing helper
	await setExcluded(cwd, "plans", "plan-skip", true);

	const provider = new PlansTreeProvider(/* construct with cwd */);
	await provider.refreshExclusions();
	const items = provider.serialize();

	const skip = items.find((i) => i.id?.endsWith("plan-skip"));
	const keep = items.find((i) => i.id?.endsWith("plan-keep"));
	expect(skip?.isSelected).toBe(false);
	expect(keep?.isSelected).toBe(true);
});

it("stamps isSelected=true by default when no exclusion file is present", async () => {
	const provider = new PlansTreeProvider(/* construct */);
	await provider.refreshExclusions();
	const items = provider.serialize();
	for (const it of items) {
		expect(it.isSelected).toBe(true);
	}
});
```

- [ ] **Step 3: Update `PlansTreeProvider` to load + cache exclusions**

`serialize()` is synchronous; it cannot itself `await readExclusions`. Cache the exclusions on the provider and refresh them whenever the file might have changed. Add to the class:

```ts
import { readExclusions, type CommitExclusions } from "../../../cli/src/core/CommitSelectionStore.js";

// class fields:
private exclusions: CommitExclusions = { conversations: new Set(), plans: new Set(), notes: new Set() };

// public refresh entry point:
async refreshExclusions(): Promise<void> {
	this.exclusions = await readExclusions(this.cwd);
	this._onDidChangeTreeData.fire();
}
```

If the constructor does not already take a `cwd: string`, add one. Update `vscode/src/Extension.ts` where `new PlansTreeProvider(plansStore)` is called (around line 514) to pass the workspace folder path:

```ts
const plansProvider = new PlansTreeProvider(plansStore, cwd);
```

Where `cwd` is the same workspace path the rest of `Extension.ts` already uses (search for nearby usages of `workspaceFolder.uri.fsPath` to confirm).

Also kick off an initial refresh in the constructor (fire-and-forget — the empty default exclusions are safe until the read resolves):

```ts
constructor(plansStore: PlansStore, private readonly cwd: string) {
	// …existing init…
	void this.refreshExclusions();
}
```

- [ ] **Step 4: Populate `isSelected` in `serialize()`**

Replace the existing `serialize()` body:

```ts
serialize(): ReadonlyArray<SerializedTreeItem> {
	return this.getChildren().map((it) => {
		let idHint: string;
		let isSelected = true;
		if (it instanceof PlanItem) {
			idHint = it.plan.slug;
			isSelected = !this.exclusions.plans.has(idHint);
		} else if (it instanceof NoteItem) {
			idHint = it.note.id;
			isSelected = !this.exclusions.notes.has(idHint);
		} else {
			idHint = it.issue.mapKey;
			// Linear-issue rows are not user-selectable; default true (no exclusion key applies).
		}
		const ser = treeItemToSerialized(it, idHint);
		return { ...ser, isSelected };
	});
}
```

---

## Task 5: ActiveSessionsProvider passes isSelected through (VSCode)

**Files:**

- Modify: `vscode/src/services/ActiveSessionsProvider.ts` (likely no production change)
- Modify: `vscode/src/services/ActiveSessionsProvider.test.ts` (extend)

The CLI aggregator already populates `isSelected` (Task 2). This provider is a thin wrapper — most likely no code change is needed (the field rides through structural sharing). The test below pins the contract.

- [ ] **Step 1: Append a pass-through test to `ActiveSessionsProvider.test.ts`**

```ts
it("passes isSelected through from the aggregator to the webview payload", async () => {
	const provider = makeProviderWithFakeAggregator([
		{
			sessionId: "abc",
			source: "claude",
			title: "t",
			messageCount: 1,
			updatedAt: new Date().toISOString(),
			transcriptPath: "/tmp/x",
			isSelected: false,
		},
	]);
	const { items } = await provider.listActiveConversationsWithDiagnostics();
	expect(items[0].isSelected).toBe(false);
});
```

If `makeProviderWithFakeAggregator` doesn't exist, build the fake inline following the surrounding test patterns. If the provider's current projection drops fields explicitly, add `isSelected` to that projection in `ActiveSessionsProvider.ts`. Otherwise no production-code change is required.

---

## Task 6: New outbound message types + handler dispatch (VSCode)

**Files:**

- Modify: `vscode/src/views/SidebarMessages.ts` (3 new types)
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` (deps + handler)
- Modify: `vscode/src/views/SidebarWebviewProvider.test.ts` (extend)

- [ ] **Step 1: Append failing tests to `SidebarWebviewProvider.test.ts`**

```ts
it("dispatches branch:toggleConversationSelection to applyConversationCheckbox", async () => {
	const calls: Array<{ source: string; sessionId: string; selected: boolean }> = [];
	const provider = makeProvider({
		applyConversationCheckbox: (source, sessionId, selected) => {
			calls.push({ source, sessionId, selected });
		},
	});
	await provider.handleOutboundForTest({
		type: "branch:toggleConversationSelection",
		source: "claude",
		sessionId: "abc",
		selected: false,
	});
	expect(calls).toEqual([{ source: "claude", sessionId: "abc", selected: false }]);
});

it("dispatches branch:togglePlanSelection to applyPlanCheckbox", async () => {
	const calls: Array<{ planId: string; selected: boolean }> = [];
	const provider = makeProvider({
		applyPlanCheckbox: (planId, selected) => calls.push({ planId, selected }),
	});
	await provider.handleOutboundForTest({
		type: "branch:togglePlanSelection",
		planId: "plan-slug",
		selected: false,
	});
	expect(calls).toEqual([{ planId: "plan-slug", selected: false }]);
});

it("dispatches branch:toggleNoteSelection to applyNoteCheckbox", async () => {
	const calls: Array<{ noteId: string; selected: boolean }> = [];
	const provider = makeProvider({
		applyNoteCheckbox: (noteId, selected) => calls.push({ noteId, selected }),
	});
	await provider.handleOutboundForTest({
		type: "branch:toggleNoteSelection",
		noteId: "note-id",
		selected: false,
	});
	expect(calls).toEqual([{ noteId: "note-id", selected: false }]);
});
```

(`makeProvider` and `handleOutboundForTest` are existing helpers in this test file — match the shape of the `toggleFileSelection` tests.)

- [ ] **Step 2: Add the new message types in `vscode/src/views/SidebarMessages.ts`**

Inside the `SidebarOutboundMsg` discriminated union, alongside `branch:toggleFileSelection`:

```ts
| {
		readonly type: "branch:toggleConversationSelection";
		readonly source: TranscriptSource;
		readonly sessionId: string;
		readonly selected: boolean;
  }
| {
		readonly type: "branch:togglePlanSelection";
		readonly planId: string;
		readonly selected: boolean;
  }
| {
		readonly type: "branch:toggleNoteSelection";
		readonly noteId: string;
		readonly selected: boolean;
  }
```

- [ ] **Step 3: Add the dep callbacks to `vscode/src/views/SidebarWebviewProvider.ts`**

Next to `applyFileCheckbox` / `applyCommitCheckbox` (around line 115):

```ts
applyConversationCheckbox?: (source: TranscriptSource, sessionId: string, selected: boolean) => void | Promise<void>;
applyPlanCheckbox?:         (planId: string, selected: boolean) => void | Promise<void>;
applyNoteCheckbox?:         (noteId: string, selected: boolean) => void | Promise<void>;
```

In `handleOutbound` (around line 519), add three cases:

```ts
case "branch:toggleConversationSelection":
	await this.deps.applyConversationCheckbox?.(msg.source, msg.sessionId, msg.selected);
	break;
case "branch:togglePlanSelection":
	await this.deps.applyPlanCheckbox?.(msg.planId, msg.selected);
	break;
case "branch:toggleNoteSelection":
	await this.deps.applyNoteCheckbox?.(msg.noteId, msg.selected);
	break;
```

- [ ] **Step 4: Expose `pushConversations` / `pushPlans` as public refresh methods**

The Extension callbacks in Task 7 need to re-push panels after a successful write. If `pushConversations` / `pushPlans` are currently private, add small public wrappers:

```ts
public async refreshConversationsPanel(): Promise<void> {
	await this.pushConversations();
}

public async refreshPlansPanel(): Promise<void> {
	await this.pushPlans();
}
```

If they're already public, skip this step.

---

## Task 7: Wire toggle callbacks in Extension.ts (VSCode)

**Files:**

- Modify: `vscode/src/Extension.ts`

- [ ] **Step 1: Locate the existing `applyFileCheckbox` / `applyCommitCheckbox` wiring (around line 726)**

```ts
applyFileCheckbox: (filePath, selected) =>
	filesStore.applyCheckboxBatch([[filePath, selected]]),
applyCommitCheckbox: (hash, selected) =>
	commitsStore.onCheckboxToggle(hash, selected),
```

- [ ] **Step 2: Add three new wirings underneath**

Add this import block at the top of `Extension.ts`:

```ts
import {
	conversationKey,
	setAllExcluded,
	setExcluded,
} from "../../cli/src/core/CommitSelectionStore.js";
```

(`setAllExcluded` is used in Task 9; declare it now to keep the import single-line.)

Add the three callbacks to the SidebarWebviewProvider deps:

```ts
applyConversationCheckbox: async (source, sessionId, selected) => {
	await setExcluded(
		cwd,
		"conversations",
		conversationKey(source, sessionId),
		!selected,
	);
	// Re-push the conversations panel so the checkbox state in the UI
	// reflects the new on-disk truth.
	await sidebarProvider.refreshConversationsPanel();
},
applyPlanCheckbox: async (planId, selected) => {
	await setExcluded(cwd, "plans", planId, !selected);
	await plansProvider.refreshExclusions();
},
applyNoteCheckbox: async (noteId, selected) => {
	await setExcluded(cwd, "notes", noteId, !selected);
	await plansProvider.refreshExclusions();
},
```

`cwd` should already be in scope at this construction point — verify by searching for the existing `applyFileCheckbox` line and reusing whatever local holds the workspace path there.

---

## Task 8: Sidebar render — per-row checkboxes (VSCode)

**Files:**

- Modify: `vscode/src/views/SidebarScriptBuilder.ts` (per-row render + click handlers)
- Modify: `vscode/src/views/SidebarScriptBuilder.test.ts` (extend)

- [ ] **Step 1: Locate the conversation, plan, and note row render blocks**

```bash
grep -n "branch:openConversation\|branch:openPlan\|branch:openNote" vscode/src/views/SidebarScriptBuilder.ts
```

Use those line numbers as the anchor.

- [ ] **Step 2: Append failing tests to `SidebarScriptBuilder.test.ts`**

```ts
it("renders a checked conversation checkbox when isSelected=true", () => {
	const html = buildConversationRow({ /* …minimal fixture, isSelected: true… */ });
	expect(html).toContain('class="jm-row-check jm-conv-check"');
	expect(html).toContain(" checked ");
});

it("renders an unchecked conversation checkbox when isSelected=false", () => {
	const html = buildConversationRow({ /* …isSelected: false… */ });
	expect(html).toContain('class="jm-row-check jm-conv-check"');
	expect(html).not.toContain(" checked ");
});

it("renders a plan-row checkbox driven by isSelected", () => {
	const html = buildPlanRow({ /* …isSelected: false… */ });
	expect(html).toContain('class="jm-row-check jm-plan-check"');
	expect(html).not.toContain(" checked ");
});

it("renders a note-row checkbox driven by isSelected", () => {
	const html = buildNoteRow({ /* …isSelected: false… */ });
	expect(html).toContain('class="jm-row-check jm-note-check"');
	expect(html).not.toContain(" checked ");
});
```

If `buildConversationRow` / `buildPlanRow` / `buildNoteRow` are not directly exported, exercise the wider render function — whatever shape the existing checkbox tests already use.

- [ ] **Step 3: Add a leading checkbox to the conversation row template**

Mirror the existing file/commit checkbox: CSS class + `addEventListener` (NO inline `style=""` / `onclick=""` per CSP). Use the existing `escAttr` (or whatever name the file gives its attribute escaper).

Inside the conversation row rendering function, BEFORE the title `<span>`:

```js
'<input type="checkbox" class="jm-row-check jm-conv-check" '
  + 'data-source="' + escAttr(it.source) + '" '
  + 'data-session="' + escAttr(it.sessionId) + '" '
  + (it.isSelected ? 'checked ' : '')
  + '/>'
```

For plan rows:

```js
'<input type="checkbox" class="jm-row-check jm-plan-check" '
  + 'data-plan-id="' + escAttr(it.id) + '" '
  + (it.isSelected ? 'checked ' : '')
  + '/>'
```

For note rows:

```js
'<input type="checkbox" class="jm-row-check jm-note-check" '
  + 'data-note-id="' + escAttr(it.id) + '" '
  + (it.isSelected ? 'checked ' : '')
  + '/>'
```

- [ ] **Step 4: Add the click handler at the delegated-event entry point**

Find the existing change-listener for `.jm-file-check` / `.jm-commit-check` (search for `branch:toggleFileSelection` in the file). Insert three new branches near it. Each branch must call `e.stopPropagation()` so the row's `click` handler doesn't fire after the checkbox toggle (otherwise the detail panel would open every time the user toggles a row).

```js
const convCheck = e.target.closest('.jm-conv-check');
if (convCheck) {
	vscode.postMessage({
		type: 'branch:toggleConversationSelection',
		source: convCheck.getAttribute('data-source'),
		sessionId: convCheck.getAttribute('data-session'),
		selected: convCheck.checked,
	});
	e.stopPropagation();
	return;
}
const planCheck = e.target.closest('.jm-plan-check');
if (planCheck) {
	vscode.postMessage({
		type: 'branch:togglePlanSelection',
		planId: planCheck.getAttribute('data-plan-id'),
		selected: planCheck.checked,
	});
	e.stopPropagation();
	return;
}
const noteCheck = e.target.closest('.jm-note-check');
if (noteCheck) {
	vscode.postMessage({
		type: 'branch:toggleNoteSelection',
		noteId: noteCheck.getAttribute('data-note-id'),
		selected: noteCheck.checked,
	});
	e.stopPropagation();
	return;
}
```

- [ ] **Step 5: Add a CSS rule for `.jm-row-check`**

Find the section's CSS string (search for `.jm-file-check` styles). Append:

```css
.jm-row-check { margin-right: 6px; vertical-align: middle; }
```

If a shared class already covers this layout, reuse it.

---

## Task 9: Select / Deselect All commands + header buttons (VSCode)

**Files:**

- Create: `vscode/src/commands/SelectAllSelection.ts`
- Create: `vscode/src/commands/SelectAllSelection.test.ts`
- Modify: `vscode/src/Extension.ts` (register two commands)
- Modify: `vscode/src/views/SidebarScriptBuilder.ts` (two new icon buttons + cmdMap entries)
- Modify: `vscode/src/views/SidebarScriptBuilder.test.ts` (extend if section actions are testable)

- [ ] **Step 1: Write failing tests in `vscode/src/commands/SelectAllSelection.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
	conversationKey,
	readExclusions,
	setAllExcluded,
	setExcluded,
} from "../../../cli/src/core/CommitSelectionStore.js";
import {
	selectAllConversationsCommand,
	selectAllPlansAndNotesCommand,
} from "./SelectAllSelection.js";

describe("selectAllConversationsCommand", () => {
	it("excludes everything when nothing is currently excluded", async () => {
		const ctx = await makeCtxWithVisibleConversations([
			{ source: "claude", sessionId: "a" },
			{ source: "codex",  sessionId: "b" },
		]);
		await selectAllConversationsCommand(ctx);
		const ex = await readExclusions(ctx.cwd);
		expect(ex.conversations.has(conversationKey("claude", "a"))).toBe(true);
		expect(ex.conversations.has(conversationKey("codex",  "b"))).toBe(true);
	});

	it("clears the visible set when everything is currently excluded", async () => {
		const ctx = await makeCtxWithVisibleConversations([
			{ source: "claude", sessionId: "a" },
			{ source: "codex",  sessionId: "b" },
		]);
		await setAllExcluded(ctx.cwd, "conversations", [
			conversationKey("claude", "a"),
			conversationKey("codex",  "b"),
		], true);
		await selectAllConversationsCommand(ctx);
		const ex = await readExclusions(ctx.cwd);
		expect(ex.conversations.size).toBe(0);
	});

	it("with mixed state, switches to all-excluded", async () => {
		const ctx = await makeCtxWithVisibleConversations([
			{ source: "claude", sessionId: "a" },
			{ source: "codex",  sessionId: "b" },
		]);
		await setExcluded(ctx.cwd, "conversations", conversationKey("claude", "a"), true);
		await selectAllConversationsCommand(ctx);
		const ex = await readExclusions(ctx.cwd);
		expect(ex.conversations.size).toBe(2);
	});
});

describe("selectAllPlansAndNotesCommand", () => {
	it("flips plans AND notes together based on the combined visible state", async () => {
		const ctx = await makeCtxWithVisiblePlansAndNotes(
			["plan-1", "plan-2"],
			["note-1"],
		);
		await selectAllPlansAndNotesCommand(ctx);
		const ex = await readExclusions(ctx.cwd);
		expect([...ex.plans].sort()).toEqual(["plan-1", "plan-2"]);
		expect([...ex.notes]).toEqual(["note-1"]);
	});
});
```

`makeCtxWithVisibleConversations` / `makeCtxWithVisiblePlansAndNotes` are local fixture builders the test file itself defines — they construct a `SelectAllCtx` (see implementation below) with a stub `activeSessions` / `plansProvider` and a temporary `cwd`.

- [ ] **Step 2: Implement `vscode/src/commands/SelectAllSelection.ts`**

```ts
import {
	conversationKey,
	readExclusions,
	setAllExcluded,
} from "../../../cli/src/core/CommitSelectionStore.js";
import type { ActiveSessionsProvider } from "../services/ActiveSessionsProvider.js";
import type { PlansTreeProvider } from "../providers/PlansTreeProvider.js";

export interface SelectAllCtx {
	readonly cwd: string;
	readonly activeSessions: Pick<ActiveSessionsProvider, "listActiveConversationsWithDiagnostics">;
	readonly plansProvider: Pick<PlansTreeProvider, "serialize" | "refreshExclusions">;
	readonly onChanged: () => Promise<void> | void;
}

export async function selectAllConversationsCommand(ctx: SelectAllCtx): Promise<void> {
	const { items } = await ctx.activeSessions.listActiveConversationsWithDiagnostics();
	const keys = items.map((it) => conversationKey(it.source, it.sessionId));
	const allCurrentlyExcluded = items.length > 0 && items.every((it) => it.isSelected === false);
	await setAllExcluded(ctx.cwd, "conversations", keys, !allCurrentlyExcluded);
	await ctx.onChanged();
}

export async function selectAllPlansAndNotesCommand(ctx: SelectAllCtx): Promise<void> {
	const rows = ctx.plansProvider.serialize();
	// Split rows by kind. Adapt the predicate to whatever id-naming convention
	// `treeItemToSerialized` uses — if ids carry no prefix, expose a `kind`
	// discriminator on SerializedTreeItem and switch on that instead.
	const planRows = rows.filter((r) => typeof r.id === "string" && r.id.startsWith("plan:"));
	const noteRows = rows.filter((r) => typeof r.id === "string" && r.id.startsWith("note:"));
	const planKeys = planRows.map((r) => stripPrefix(r.id!, "plan:"));
	const noteKeys = noteRows.map((r) => stripPrefix(r.id!, "note:"));

	const visibleSelectable = [...planRows, ...noteRows];
	const allCurrentlyExcluded =
		visibleSelectable.length > 0 && visibleSelectable.every((r) => r.isSelected === false);

	const target = !allCurrentlyExcluded;
	await setAllExcluded(ctx.cwd, "plans", planKeys, target);
	await setAllExcluded(ctx.cwd, "notes", noteKeys, target);
	await ctx.plansProvider.refreshExclusions();
	await ctx.onChanged();
}

function stripPrefix(id: string, prefix: string): string {
	return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
```

When implementing, verify the actual id prefix used by `treeItemToSerialized` in `PlansTreeProvider.ts` and adjust the `startsWith` predicates. If ids carry no prefix, add a `kind: "plan" | "note" | "linear"` discriminator to `SerializedTreeItem` in `SidebarMessages.ts` and switch on that — cleaner than string sniffing.

- [ ] **Step 3: Register the commands in `Extension.ts`**

Near `jollimemory.selectAllFiles`:

```ts
vscode.commands.registerCommand("jollimemory.selectAllConversations", () =>
	selectAllConversationsCommand({
		cwd,
		activeSessions: activeSessionsProvider,
		plansProvider,
		onChanged: () => sidebarProvider.refreshConversationsPanel(),
	}),
);
vscode.commands.registerCommand("jollimemory.selectAllPlansAndNotes", () =>
	selectAllPlansAndNotesCommand({
		cwd,
		activeSessions: activeSessionsProvider,
		plansProvider,
		onChanged: () => sidebarProvider.refreshPlansPanel(),
	}),
);
```

Add the two new ids to the registered-commands constant at the top of `Extension.ts` (search for `"jollimemory.selectAllFiles"` and append the new ids in the same array).

- [ ] **Step 4: Add icon buttons in `SidebarScriptBuilder.ts`**

Find the conversations section's actions block (search for the section id — `'conversations'` or similar):

```js
items.push(iconButton('conversations-select-all', 'Select/Deselect All Conversations', 'check-all'));
```

For the plans-and-notes section (search `plans-add-menu`):

```js
items.push(iconButton('plans-select-all', 'Select/Deselect All Plans & Notes', 'check-all'));
```

Order in each header: alongside the existing add-menu / refresh icons; pick a position consistent with how Changes has `Select All` first.

- [ ] **Step 5: Extend `cmdMap`**

```js
const cmdMap = {
	'changes-select-all':         'jollimemory.selectAllFiles',
	'changes-commit-ai':          'jollimemory.commitAI',
	'changes-discard':            'jollimemory.discardSelectedChanges',
	'commits-select-all':         'jollimemory.selectAllCommits',
	'commits-squash':             'jollimemory.squash',
	'commits-push-branch':        'jollimemory.pushBranch',
	'conversations-select-all':   'jollimemory.selectAllConversations',
	'plans-select-all':           'jollimemory.selectAllPlansAndNotes',
};
```

---

## Task 10: Flip FilesStore default to all-selected (VSCode)

**Files:**

- Modify: `vscode/src/stores/FilesStore.ts` (refresh seed step)
- Modify: `vscode/src/stores/FilesStore.test.ts` (extend)

- [ ] **Step 1: Append failing tests to `FilesStore.test.ts`**

```ts
it("seeds selectedPaths with every raw file on first refresh", async () => {
	const bridge = makeBridgeStub([
		{ relativePath: "a.ts", isSelected: false /* …other fields…*/ },
		{ relativePath: "b.ts", isSelected: false },
		{ relativePath: "c.ts", isSelected: false },
	]);
	const store = new FilesStore(bridge, /* …other deps… */);
	await store.refresh();
	expect(store.getSnapshot().visibleFiles.map((f) => f.relativePath).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	for (const f of store.getSnapshot().visibleFiles) {
		expect(f.isSelected).toBe(true);
	}
});

it("preserves an explicit user uncheck across a same-raw refresh", async () => {
	const bridge = makeBridgeStub([
		{ relativePath: "a.ts", isSelected: false },
		{ relativePath: "b.ts", isSelected: false },
	]);
	const store = new FilesStore(bridge, /* … */);
	await store.refresh();
	store.applyCheckboxBatch([["a.ts", false]]);
	await store.refresh();
	const visible = store.getSnapshot().visibleFiles;
	expect(visible.find((f) => f.relativePath === "a.ts")?.isSelected).toBe(false);
	expect(visible.find((f) => f.relativePath === "b.ts")?.isSelected).toBe(true);
});
```

Use the existing `makeBridgeStub` helper / `FileStatus` shape from the surrounding tests.

- [ ] **Step 2: Modify `FilesStore.refresh()` (lines 142–157 today)**

The store needs a negative-memory set so an explicit user uncheck survives a refresh against the same `raw`. Replace the seeding loop:

```ts
// Seed selection from every freshly-seen file. Default-select matches the
// behavior of conversations / plans / notes: the user opts out per-row.
// Stale unchecks survive refresh via `unselectedPaths`; we never re-add a
// path the user has explicitly removed from `selectedPaths`.
for (const f of raw) {
	if (!this.unselectedPaths?.has(f.relativePath)) {
		this.selectedPaths.add(f.relativePath);
	}
}
```

Update `applyCheckboxBatch` so it populates the new set:

```ts
applyCheckboxBatch(items: ReadonlyArray<readonly [path: string, checked: boolean]>): void {
	if (items.length === 0) return;
	for (const [path, checked] of items) {
		if (checked) {
			this.selectedPaths.add(path);
			this.unselectedPaths?.delete(path);
		} else {
			this.selectedPaths.delete(path);
			this.unselectedPaths ??= new Set<string>();
			this.unselectedPaths.add(path);
		}
	}
	this.rebuildSnapshot({ reorder: false, reason: "userCheckbox" });
}
```

Declare the field:

```ts
private unselectedPaths?: Set<string>;
```

Make sure the existing prune-stale-selections step also prunes `unselectedPaths`:

```ts
const currentPaths = new Set(raw.map((f) => f.relativePath));
for (const p of [...this.selectedPaths]) {
	if (!currentPaths.has(p)) this.selectedPaths.delete(p);
}
if (this.unselectedPaths) {
	for (const p of [...this.unselectedPaths]) {
		if (!currentPaths.has(p)) this.unselectedPaths.delete(p);
	}
}
```

If a simpler implementation can preserve the user-uncheck-across-refresh invariant without `unselectedPaths`, use that — but verify both new tests still pass.

---

## Task 11: Final integration — run, smoke test, single commit

**Files:** all touched by Tasks 1–10, plus `cli/CHANGELOG.md`, `vscode/CHANGELOG.md`

- [ ] **Step 1: Update CHANGELOG entries**

Append a single bullet to the "Unreleased" section of both `cli/CHANGELOG.md` and `vscode/CHANGELOG.md`:

```
- Add per-row checkboxes and a Select/Deselect All button on Conversations and Plans & Notes; uncheck excludes the item from future summaries, sticky until re-checked. Default-select the Changes panel files (file behavior is the only change visible without unchecking).
```

- [ ] **Step 2: Run the project-wide gate**

```bash
npm run all
```

Expected: clean → build → lint → test all pass for both workspaces. CLI coverage must stay ≥97 % statements / 96 % branches / 97 % functions / 97 % lines (CLAUDE.md hard rule).

If a coverage gap is reported, add focused tests to close it (do NOT lower the threshold). The most likely thin spots:

- `CommitSelectionStore` ENOENT / parse-error branches (cover with intentionally-corrupt fixture).
- `QueueWorker.executePipeline` filter branches when one kind has 0 items (cover with empty plans / notes fixture).

If a test fails, fix the underlying code or test until `npm run all` is green. Do not proceed to Step 3 with a red build.

- [ ] **Step 3: Manual smoke test in VS Code dev host**

```bash
cd vscode && npm run deploy
```

Then **Developer: Reload Window** in the VS Code instance that just got the VSIX installed. Smoke checklist:

1. Open a project with an active Claude / Codex / Cursor / Copilot conversation.
2. Sidebar shows conversation rows with a leading checkbox, all checked.
3. Uncheck one conversation → checkbox stays unchecked.
4. Reload window → checkbox is still unchecked (sticky).
5. Make a trivial commit → wait for the post-commit hook to finish (5–30s).
6. Open the resulting memory file (orphan branch) → confirm the unchecked conversation's content is NOT mentioned in the summary.
7. The checkbox stays unchecked after the commit (sticky).
8. Repeat for a plan and a note in the Plans & Notes section.
9. Click the conversations header "Select/Deselect All" → all conversations flip.
10. Verify the Changes panel now defaults every file to checked.
11. Verify the Commits panel defaults remain unchecked (squash candidates).

Fix any regression surfaced by the smoke test; re-run `npm run all` after the fix.

- [ ] **Step 4: Single DCO-signed commit covering everything**

```bash
git add cli/src/core/CommitSelectionStore.ts cli/src/core/CommitSelectionStore.test.ts \
        cli/src/core/ActiveSessionAggregator.ts cli/src/core/ActiveSessionAggregator.test.ts \
        cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.selection.test.ts \
        vscode/src/views/SidebarMessages.ts \
        vscode/src/views/SidebarWebviewProvider.ts vscode/src/views/SidebarWebviewProvider.test.ts \
        vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts \
        vscode/src/providers/PlansTreeProvider.ts vscode/src/providers/PlansTreeProvider.test.ts \
        vscode/src/services/ActiveSessionsProvider.ts vscode/src/services/ActiveSessionsProvider.test.ts \
        vscode/src/stores/FilesStore.ts vscode/src/stores/FilesStore.test.ts \
        vscode/src/commands/SelectAllSelection.ts vscode/src/commands/SelectAllSelection.test.ts \
        vscode/src/Extension.ts \
        cli/CHANGELOG.md vscode/CHANGELOG.md

git commit -s -m "$(cat <<'EOF'
Add per-item commit-time selection across the sidebar

Conversations, plans, notes, and the Changes-panel file list each get a
per-row checkbox plus a Select/Deselect All header button. Unchecking
writes a sticky entry to .jolli/jollimemory/commit-selection.json that
the summary pipeline filters on; the file is never auto-cleared by any
git operation. The Commits-squash panel default is intentionally
unchanged because squash is destructive.
EOF
)"
```

If the `git add` command lists a file that was not actually modified (e.g. ActiveSessionsProvider.ts when Task 5 turned out to need no production change), drop that path from the `add` line. `git status` before the commit confirms the real working set.

---

## Self-review checklist (done while writing)

- **Spec coverage:** each spec section has a task — Storage (Task 1), Pipeline integration (Task 3), ActiveConversationItem (Task 2), Plans/Notes isSelected (Task 4), ActiveSessionsProvider (Task 5), wire protocol (Task 6), per-row toggle persistence (Task 7), per-row render (Task 8), Select-All buttons + commands (Task 9), File panel default (Task 10), end-to-end + commit (Task 11).
- **Placeholder scan:** no "TBD" / "implement later" / "similar to Task N" stubs. Every code change shows a code block. The few "adapt to actual naming" hints are explicit, bounded resolution instructions for the executor, not stubs.
- **Type consistency:** `CommitExclusions`, `ExclusionKind`, `conversationKey`, `setExcluded`, `setAllExcluded`, `readExclusions` names are stable across Tasks 1, 2, 3, 4, 6, 7, 9. `op.type` matches the existing `GitOperation.type` discriminator (verified against [QueueWorker.ts:327](../../cli/src/hooks/QueueWorker.ts)).
- **Execution-model note honored:** Tasks 1–10 contain no "run tests" / "lint" / "commit" steps. All such steps live in Task 11 as the single final integration.
- **YAGNI:** no `clear()` method on the store; no per-row provider observer wiring (provider re-push is enough); no commits-panel default change (deliberately out of scope per spec); no IntelliJ port.
- **TDD shape:** each task still lands tests before implementation — only the test/lint/commit *runs* are deferred to Task 11.
- **Single commit at the end:** all 21 touched paths land in one DCO-signed commit. Smoke-test fallout fixes are folded into the same commit before it lands.
