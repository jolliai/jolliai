# Leaf-Only Memory Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Memory Bank tree, Timeline / KB Memories, and Branch tab Memories on showing only the leaf of each `(repo, branch)` amend chain. Visible `<branch>/<slug>-<hash8>.md` files for non-leaves are cleaned up; orphan branch + `<repo>/.jolli/` JSON archive stay untouched.

**Architecture:** A single `ChainLeafFilter` helper computes per-`(repoName, branch)` chain leaves from index entries. Two consumers call it: read-path filters in `JolliMemoryBridge` (Timeline + foreign Branch tab) and a shared `LeafMarkdownCleanup` helper that drives both a one-shot startup `MigrationEngine` v2 step and a per-op `QueueWorker` tail step. `FolderStorage.deleteVisibleMarkdown` performs the narrow disk delete, propagated through `DualWriteStorage`.

**Tech Stack:** TypeScript (CLI Node 22.5+ ESM, VS Code esbuild→CJS); Vitest; existing `StorageProvider` interface; `MetadataManager` for migration state.

**Reference:** [docs/superpowers/specs/2026-05-12-leaf-only-memory-display-design.md](../specs/2026-05-12-leaf-only-memory-display-design.md)

**Branch:** `fix-change-other-repo-memory` (existing work continues here)

---

## Preflight (do once before Task 1)

This branch currently carries uncommitted Sidebar work from an earlier session — the leaf-only PR is **separate**. Either commit those changes on a side branch first, or stash them so the working tree is clean before Task 1's commits start landing on `fix-change-other-repo-memory`. Verify:

```bash
git status --short
# Expected: only docs/ (current spec/plan files) — no other dirty paths.
```

If `vscode/src/views/SidebarScriptBuilder.ts` (or its test) is dirty, stash:

```bash
git stash push -m "pre-leaf-only sidebar work" vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts
```

(Recover later with `git stash pop` — done out-of-band, not part of this plan.)

---

## Task 1: `ChainLeafFilter` — pure helper for chain-leaf computation

**Files:**
- Create: `cli/src/core/ChainLeafFilter.ts`
- Create: `cli/src/core/ChainLeafFilter.test.ts`

This is the single source of truth for "given a flat list of `SummaryIndexEntry`s, which `commitHash`es are leaves of their `(repoName, branch)`-scoped chain?" Both bridge read paths and disk cleanup call this.

- [ ] **Step 1: Write the failing test file**

Create `cli/src/core/ChainLeafFilter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filterToBranchLeaves, getBranchLeaves } from "./ChainLeafFilter.js";
import type { SummaryIndexEntry } from "../Types.js";

function e(
	commitHash: string,
	branch: string,
	parent: string | null | undefined,
	repoName?: string,
): SummaryIndexEntry {
	return {
		commitHash,
		parentCommitHash: parent,
		commitMessage: commitHash,
		commitDate: "2026-05-12T00:00:00Z",
		branch,
		generatedAt: "2026-05-12T00:00:00Z",
		...(repoName !== undefined ? { repoName } : {}),
	};
}

describe("ChainLeafFilter", () => {
	describe("getBranchLeaves", () => {
		it("returns empty set for empty input", () => {
			expect(getBranchLeaves([])).toEqual(new Set());
		});

		it("returns the single entry when there's only one", () => {
			expect(getBranchLeaves([e("a", "main", null)])).toEqual(new Set(["a"]));
		});

		it("collapses a linear chain to its leaf", () => {
			// a (root) → b → c (leaf)
			const leaves = getBranchLeaves([
				e("a", "main", null),
				e("b", "main", "a"),
				e("c", "main", "b"),
			]);
			expect(leaves).toEqual(new Set(["c"]));
		});

		it("keeps parallel chains on the same branch each as a separate leaf", () => {
			// chain 1: a → b ;  chain 2: x → y
			const leaves = getBranchLeaves([
				e("a", "main", null),
				e("b", "main", "a"),
				e("x", "main", null),
				e("y", "main", "x"),
			]);
			expect(leaves).toEqual(new Set(["b", "y"]));
		});

		it("scopes leaf judgement by branch — rebase-pick keeps each branch's tip", () => {
			// branch X: a (leaf) ;  branch Y: a' parent = a (cross-branch parent ignored)
			const leaves = getBranchLeaves([
				e("a", "feature-x", null),
				e("aprime", "feature-y", "a"),
			]);
			// `a` is leaf on X (no entry on X parents it); `aprime` is leaf on Y.
			expect(leaves).toEqual(new Set(["a", "aprime"]));
		});

		it("scopes leaf judgement by repoName — same branch name in two repos stays isolated", () => {
			const leaves = getBranchLeaves([
				e("a", "main", null, "repoA"),
				e("b", "main", "a", "repoA"),
				e("x", "main", null, "repoB"),
				e("y", "main", "x", "repoB"),
			]);
			expect(leaves).toEqual(new Set(["b", "y"]));
		});

		it("treats undefined parentCommitHash (legacy v1) as root, still a leaf if no descendant", () => {
			const leaves = getBranchLeaves([e("a", "main", undefined)]);
			expect(leaves).toEqual(new Set(["a"]));
		});

		it("treats a dangling parent pointer as a regular root in scope", () => {
			// b's parent 'a' is not in the list. b is a root in scope; still leaf if nothing parents it.
			expect(getBranchLeaves([e("b", "main", "a")])).toEqual(new Set(["b"]));
		});

		it("collapses a 2-cycle (a↔b) to zero leaves", () => {
			// Malicious / corrupted index. Documented behavior: both members parent
			// each other in scope, so neither is a leaf.
			const leaves = getBranchLeaves([
				e("a", "main", "b"),
				e("b", "main", "a"),
			]);
			expect(leaves).toEqual(new Set());
		});
	});

	describe("filterToBranchLeaves", () => {
		it("returns entries whose commitHash is a leaf", () => {
			const root = e("a", "main", null);
			const leaf = e("b", "main", "a");
			expect(filterToBranchLeaves([root, leaf])).toEqual([leaf]);
		});

		it("preserves input order among the leaves", () => {
			const leaf1 = e("b", "main", "a");
			const root = e("a", "main", null);
			const leaf2 = e("y", "main", "x");
			const root2 = e("x", "main", null);
			expect(
				filterToBranchLeaves([leaf1, root, leaf2, root2]).map((x) => x.commitHash),
			).toEqual(["b", "y"]);
		});
	});
});
```

- [ ] **Step 2: Run test, verify it fails (module not found)**

```bash
npm run test -w @jolli.ai/cli -- src/core/ChainLeafFilter.test.ts
```
Expected: FAIL — `Failed to resolve import "./ChainLeafFilter.js"`.

- [ ] **Step 3: Create the implementation**

Create `cli/src/core/ChainLeafFilter.ts`:

```ts
/**
 * ChainLeafFilter — single source of truth for "which entries are chain leaves?".
 *
 * Scope: a leaf is judged within a single `(repoName, branch)` group.
 * - Cross-branch parent links (rebase-pick X→Y) do NOT demote `c1` on X.
 * - Cross-repo parent links (rare, structurally not produced today) similarly
 *   do not cross repo boundaries — same-named branches in two repos stay
 *   independent.
 *
 * Cycle safety: an index where two entries in the same scope parent each
 * other (`a→b, b→a`) collapses to zero leaves — neither is a leaf because
 * the other parents it. Bad data hides itself rather than crashing the
 * renderer. Documented; no exception is thrown.
 *
 * Legacy v1 entries have `parentCommitHash === undefined`; treated as
 * roots (no parent claim), still leaf-eligible if no descendant points at
 * them in scope.
 */

import type { SummaryIndexEntry } from "../Types.js";

const SCOPE_SEP = "\0";

function scopeKey(e: Pick<SummaryIndexEntry, "repoName" | "branch">): string {
	return `${e.repoName ?? ""}${SCOPE_SEP}${e.branch}`;
}

/** Returns the set of commitHashes that are leaves of their `(repoName, branch)`-scoped chain. */
export function getBranchLeaves(
	entries: Iterable<SummaryIndexEntry>,
): Set<string> {
	const all: SummaryIndexEntry[] = [];
	const parentedByScope = new Map<string, Set<string>>();

	for (const entry of entries) {
		all.push(entry);
		const parent = entry.parentCommitHash;
		if (parent != null) {
			const key = scopeKey(entry);
			let bucket = parentedByScope.get(key);
			if (!bucket) {
				bucket = new Set();
				parentedByScope.set(key, bucket);
			}
			bucket.add(parent);
		}
	}

	const leaves = new Set<string>();
	for (const entry of all) {
		const parented = parentedByScope.get(scopeKey(entry));
		if (!parented || !parented.has(entry.commitHash)) {
			leaves.add(entry.commitHash);
		}
	}
	return leaves;
}

/** Convenience: returns only the entries whose commitHash is a branch leaf. Preserves input order. */
export function filterToBranchLeaves<T extends SummaryIndexEntry>(
	entries: Iterable<T>,
): T[] {
	const buffered: T[] = [];
	for (const e of entries) buffered.push(e);
	const leaves = getBranchLeaves(buffered);
	return buffered.filter((e) => leaves.has(e.commitHash));
}
```

- [ ] **Step 4: Run test, verify all pass**

```bash
npm run test -w @jolli.ai/cli -- src/core/ChainLeafFilter.test.ts
```
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/ChainLeafFilter.ts cli/src/core/ChainLeafFilter.test.ts
git commit -s -m "Add ChainLeafFilter: per-(repo, branch) leaf computation

Single source of truth used by both display read-path filters and disk
cleanup. Cycle-safe (a↔b collapses to zero leaves) and tolerates
dangling-parent + legacy-v1 (undefined parent) entries."
```

---

## Task 2: `StorageProvider.deleteVisibleMarkdown` — narrow interface + FolderStorage impl

**Files:**
- Modify: `cli/src/core/StorageProvider.ts`
- Modify: `cli/src/core/FolderStorage.ts`
- Modify: `cli/src/core/FolderStorage.test.ts`

Adds an optional interface method (orphan storage has no visible md, so it stays unimplemented), and a real implementation on `FolderStorage` that deletes ONLY the visible `<branch>/<slug>-<hash8>.md` file. `.jolli/summaries/<hash>.json` and `.jolli/index.json` are untouched.

- [ ] **Step 1: Write failing test for `FolderStorage.deleteVisibleMarkdown`**

Append to `cli/src/core/FolderStorage.test.ts` (inside the `describe("FolderStorage", …)` block, after the existing `describe("amend/squash cleanup of superseded MDs", …)` block):

```ts
	describe("deleteVisibleMarkdown", () => {
		beforeEach(async () => {
			await storage.ensure();
		});

		it("deletes the visible md file and leaves .jolli/ untouched", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "deadbeef12345678",
				commitMessage: "Add login",
				branch: "feature/login",
			});
			await storage.writeFiles(
				[{ path: "summaries/deadbeef12345678.json", content: summaryJson }],
				"seed",
			);

			const visiblePath = join(rootPath, "feature/login", "add-login-deadbeef.md");
			expect(existsSync(visiblePath)).toBe(true);

			await storage.deleteVisibleMarkdown({
				commitHash: "deadbeef12345678",
				commitMessage: "Add login",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "feature/login",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			expect(existsSync(visiblePath)).toBe(false);
			// Hidden JSON intact.
			expect(
				existsSync(join(rootPath, ".jolli", "summaries", "deadbeef12345678.json")),
			).toBe(true);
		});

		it("is idempotent on a missing file (no throw)", async () => {
			await expect(
				storage.deleteVisibleMarkdown({
					commitHash: "ffffffffffffffff",
					commitMessage: "ghost",
					commitDate: "2026-01-15T10:00:00Z",
					branch: "ghost-branch",
					generatedAt: "2026-01-15T10:00:00Z",
					parentCommitHash: null,
				}),
			).resolves.toBeUndefined();
		});

		it("leaves the <branch>/ directory in place after the last md is removed", async () => {
			const summaryJson = makeSummaryJson({
				commitHash: "aaaa11112222bbbb",
				commitMessage: "Solo entry",
				branch: "lone-branch",
			});
			await storage.writeFiles(
				[{ path: "summaries/aaaa11112222bbbb.json", content: summaryJson }],
				"seed",
			);

			await storage.deleteVisibleMarkdown({
				commitHash: "aaaa11112222bbbb",
				commitMessage: "Solo entry",
				commitDate: "2026-01-15T10:00:00Z",
				branch: "lone-branch",
				generatedAt: "2026-01-15T10:00:00Z",
				parentCommitHash: null,
			});

			expect(existsSync(join(rootPath, "lone-branch"))).toBe(true);
		});
	});
```

- [ ] **Step 2: Run test, verify failure**

```bash
npm run test -w @jolli.ai/cli -- src/core/FolderStorage.test.ts -t "deleteVisibleMarkdown"
```
Expected: FAIL — `storage.deleteVisibleMarkdown is not a function`.

- [ ] **Step 3: Extend `StorageProvider` interface**

Edit `cli/src/core/StorageProvider.ts` — add this method after the existing methods, before the closing `}`:

```ts
	/**
	 * Remove the user-visible Markdown copy for a single summary entry.
	 * Does NOT touch .jolli/summaries/<hash>.json, .jolli/index.json, or any
	 * orphan-branch state. Idempotent: a missing file is not an error.
	 *
	 * Optional: implemented by FolderStorage and delegated by DualWriteStorage.
	 * OrphanBranchStorage does not implement it (no visible layer).
	 */
	deleteVisibleMarkdown?(entry: SummaryIndexEntry): Promise<void>;
```

And add the import at the top of `StorageProvider.ts`:

```ts
import type { FileWrite, SummaryIndexEntry } from "../Types.js";
```

(Replacing the existing `import type { FileWrite } from "../Types.js";` line.)

- [ ] **Step 4: Implement on `FolderStorage`**

Edit `cli/src/core/FolderStorage.ts`. Add to the imports at the top — `SummaryIndexEntry` to the `../Types.js` import line (it already imports `FileWrite` / `CommitSummary` etc.; add `SummaryIndexEntry` to the list).

Then add the method body inside the `FolderStorage` class. A good spot is right after `clearDirty()` / `isDirty()`, before the `// ── Markdown generation ───` divider (around line 114). Insert:

```ts
	/**
	 * Remove ONLY the visible <branch>/<slug>-<hash8>.md file for this entry.
	 * Leaves .jolli/summaries/<hash>.json, .jolli/index.json, manifest entry,
	 * and the <branch>/ directory itself in place. Idempotent on a missing
	 * file. See StorageProvider.deleteVisibleMarkdown for the contract.
	 */
	async deleteVisibleMarkdown(entry: SummaryIndexEntry): Promise<void> {
		const branchFolder = this.metadataManager.resolveFolderForBranch(entry.branch);
		const slug = FolderStorage.slugify(entry.commitMessage);
		const hash8 = entry.commitHash.substring(0, 8);
		const relativePath = `${branchFolder}/${slug}-${hash8}.md`;
		const absPath = join(this.rootPath, relativePath);
		if (!existsSync(absPath)) return;
		try {
			unlinkSync(absPath);
			log.info("Deleted visible MD (leaf cleanup): %s", relativePath);
		} catch (err) {
			// EEXIST race with concurrent writer is the only realistic non-fatal
			// failure; surface anything else so callers can record dirty state.
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return;
			throw err;
		}
	}
```

- [ ] **Step 5: Run tests, verify all pass**

```bash
npm run test -w @jolli.ai/cli -- src/core/FolderStorage.test.ts
```
Expected: PASS (existing + 3 new tests).

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/StorageProvider.ts cli/src/core/FolderStorage.ts cli/src/core/FolderStorage.test.ts
git commit -s -m "Add FolderStorage.deleteVisibleMarkdown — visible-md-only delete

Narrow, idempotent API used by the upcoming leaf-cleanup paths. Touches
nothing under .jolli/ and leaves the <branch>/ directory in place after
removing its last md file (avoids ENOENT race with the next writer)."
```

---

## Task 3: `DualWriteStorage` — delegate `deleteVisibleMarkdown` to the folder side

**Files:**
- Modify: `cli/src/core/DualWriteStorage.ts`
- Modify: `cli/src/core/DualWriteStorage.test.ts`

`DualWriteStorage` wraps two providers (orphan primary + folder shadow). It must forward `deleteVisibleMarkdown` to the folder side and swallow any failure into the existing dirty-mark mechanism.

- [ ] **Step 1: Write failing test**

Open `cli/src/core/DualWriteStorage.test.ts` and append a new `describe` block at the end (inside the outer `describe("DualWriteStorage", …)`):

```ts
	describe("deleteVisibleMarkdown delegation", () => {
		it("delegates to the folder-side provider", async () => {
			const folderDelete = vi.fn().mockResolvedValue(undefined);
			const orphan = makeMockStorage();
			const folder = { ...makeMockStorage(), deleteVisibleMarkdown: folderDelete };
			const dual = new DualWriteStorage(orphan, folder);
			const entry = {
				commitHash: "deadbeef",
				parentCommitHash: null,
				commitMessage: "Add login",
				commitDate: "2026-05-12T00:00:00Z",
				branch: "main",
				generatedAt: "2026-05-12T00:00:00Z",
			};
			await dual.deleteVisibleMarkdown(entry);
			expect(folderDelete).toHaveBeenCalledWith(entry);
		});

		it("is a no-op when the folder side lacks the method", async () => {
			const orphan = makeMockStorage();
			const folder = makeMockStorage(); // no deleteVisibleMarkdown
			const dual = new DualWriteStorage(orphan, folder);
			await expect(
				dual.deleteVisibleMarkdown({
					commitHash: "deadbeef",
					parentCommitHash: null,
					commitMessage: "x",
					commitDate: "2026-05-12T00:00:00Z",
					branch: "main",
					generatedAt: "2026-05-12T00:00:00Z",
				}),
			).resolves.toBeUndefined();
		});

		it("marks dirty when the folder side throws", async () => {
			const folderDelete = vi
				.fn()
				.mockRejectedValue(new Error("disk gone"));
			const markDirty = vi.fn();
			const orphan = makeMockStorage();
			const folder = {
				...makeMockStorage(),
				deleteVisibleMarkdown: folderDelete,
				markDirty,
			};
			const dual = new DualWriteStorage(orphan, folder);
			await dual.deleteVisibleMarkdown({
				commitHash: "deadbeef",
				parentCommitHash: null,
				commitMessage: "x",
				commitDate: "2026-05-12T00:00:00Z",
				branch: "main",
				generatedAt: "2026-05-12T00:00:00Z",
			});
			expect(markDirty).toHaveBeenCalled();
		});
	});
```

If `makeMockStorage` does not exist in the test file's helpers, scan the file for the existing factory and use whatever shape the prior tests use (typically `{ readFile, writeFiles, listFiles, exists, ensure }` stubs). If absent, define inline at the top of the new block.

- [ ] **Step 2: Run test, verify failure**

```bash
npm run test -w @jolli.ai/cli -- src/core/DualWriteStorage.test.ts -t "deleteVisibleMarkdown delegation"
```
Expected: FAIL — method missing on `DualWriteStorage`.

- [ ] **Step 3: Implement delegation**

Edit `cli/src/core/DualWriteStorage.ts`. Add the method inside the class (a good spot is right after the existing `writeFiles` so the read-then-write methods stay grouped):

```ts
	async deleteVisibleMarkdown(entry: SummaryIndexEntry): Promise<void> {
		if (!this.shadow.deleteVisibleMarkdown) return;
		try {
			await this.shadow.deleteVisibleMarkdown(entry);
		} catch (err) {
			log.warn(
				"Shadow deleteVisibleMarkdown failed for %s: %s",
				entry.commitHash.substring(0, 8),
				err instanceof Error ? err.message : String(err),
			);
			this.shadow.markDirty?.(`deleteVisibleMarkdown ${entry.commitHash.substring(0, 8)}`);
		}
	}
```

Then add `SummaryIndexEntry` to the `../Types.js` import line at the top.

- [ ] **Step 4: Run test, verify all pass**

```bash
npm run test -w @jolli.ai/cli -- src/core/DualWriteStorage.test.ts
```
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/DualWriteStorage.ts cli/src/core/DualWriteStorage.test.ts
git commit -s -m "Delegate DualWriteStorage.deleteVisibleMarkdown to folder side

Orphan side has no visible layer, so the call routes only to the
folder-side provider. Failures get swallowed into markDirty (matches the
write-side dirty-mark contract); orphan reads stay authoritative."
```

---

## Task 4: `LeafMarkdownCleanup` — shared cleanup helper (Migration + Worker callers)

**Files:**
- Create: `cli/src/core/LeafMarkdownCleanup.ts`
- Create: `cli/src/core/LeafMarkdownCleanup.test.ts`

One module called both by `MigrationEngine` (one-shot over every branch) and `QueueWorker` (per-op over the active branch). Reads the index via the existing `getIndexEntryMap`, computes leaves via `ChainLeafFilter`, deletes via `storage.deleteVisibleMarkdown`.

- [ ] **Step 1: Write failing test**

Create `cli/src/core/LeafMarkdownCleanup.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
	cleanupAllBranchesLeafMarkdown,
	cleanupBranchLeafMarkdown,
} from "./LeafMarkdownCleanup.js";
import type { StorageProvider } from "./StorageProvider.js";
import type { SummaryIndexEntry } from "../Types.js";

vi.mock("./SummaryStore.js", async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return { ...real, getIndexEntryMap: vi.fn() };
});

const { getIndexEntryMap } = await import("./SummaryStore.js");

function e(
	commitHash: string,
	branch: string,
	parent: string | null,
): SummaryIndexEntry {
	return {
		commitHash,
		parentCommitHash: parent,
		commitMessage: `msg-${commitHash}`,
		commitDate: "2026-05-12T00:00:00Z",
		branch,
		generatedAt: "2026-05-12T00:00:00Z",
	};
}

function makeStorage(): StorageProvider & {
	readonly deletions: SummaryIndexEntry[];
} {
	const deletions: SummaryIndexEntry[] = [];
	return {
		readFile: vi.fn(),
		writeFiles: vi.fn(),
		listFiles: vi.fn(),
		exists: vi.fn(),
		ensure: vi.fn(),
		deleteVisibleMarkdown: async (entry) => {
			deletions.push(entry);
		},
		deletions,
	};
}

describe("LeafMarkdownCleanup", () => {
	describe("cleanupBranchLeafMarkdown", () => {
		it("deletes non-leaves on the named branch", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["c", e("c", "main", "b")],
				]),
			);
			const storage = makeStorage();
			const result = await cleanupBranchLeafMarkdown(
				"/cwd",
				"main",
				storage,
			);
			expect(result.deleted).toBe(2);
			expect(storage.deletions.map((d) => d.commitHash).sort()).toEqual([
				"a",
				"b",
			]);
		});

		it("does not touch entries on other branches", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["x", e("x", "feature", null)],
					["y", e("y", "feature", "x")],
				]),
			);
			const storage = makeStorage();
			await cleanupBranchLeafMarkdown("/cwd", "main", storage);
			// Only main's non-leaf (a) deleted; feature's non-leaf (x) untouched.
			expect(storage.deletions.map((d) => d.commitHash)).toEqual(["a"]);
		});

		it("is a no-op when storage lacks deleteVisibleMarkdown", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
				]),
			);
			const storage = {
				readFile: vi.fn(),
				writeFiles: vi.fn(),
				listFiles: vi.fn(),
				exists: vi.fn(),
				ensure: vi.fn(),
			} satisfies StorageProvider;
			const result = await cleanupBranchLeafMarkdown(
				"/cwd",
				"main",
				storage,
			);
			expect(result.deleted).toBe(0);
		});
	});

	describe("cleanupAllBranchesLeafMarkdown", () => {
		it("walks every branch in the index and deletes their non-leaves", async () => {
			(getIndexEntryMap as ReturnType<typeof vi.fn>).mockResolvedValue(
				new Map<string, SummaryIndexEntry>([
					["a", e("a", "main", null)],
					["b", e("b", "main", "a")],
					["x", e("x", "feature", null)],
					["y", e("y", "feature", "x")],
				]),
			);
			const storage = makeStorage();
			const result = await cleanupAllBranchesLeafMarkdown(
				"/cwd",
				storage,
			);
			expect(result.deleted).toBe(2);
			expect(storage.deletions.map((d) => d.commitHash).sort()).toEqual([
				"a",
				"x",
			]);
		});
	});
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
npm run test -w @jolli.ai/cli -- src/core/LeafMarkdownCleanup.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cli/src/core/LeafMarkdownCleanup.ts`:

```ts
/**
 * LeafMarkdownCleanup — shared helper for "delete non-leaf visible .md files".
 *
 * Two entry points:
 *   - cleanupBranchLeafMarkdown(cwd, branch, storage): scoped to one branch
 *     of the active repo. Called by QueueWorker at the tail of every op so
 *     the disk invariant is restored after amend / rebase / squash.
 *   - cleanupAllBranchesLeafMarkdown(cwd, storage): walks every branch in
 *     the index. Called by MigrationEngine's v2 step at startup to drain
 *     any backlog accumulated before this code shipped.
 *
 * Reads from index via getIndexEntryMap. Computes leaves via ChainLeafFilter.
 * Deletes via storage.deleteVisibleMarkdown (optional method; no-op when
 * the storage backend has no visible layer, e.g. OrphanBranchStorage).
 */

import { createLogger } from "../Logger.js";
import { getBranchLeaves } from "./ChainLeafFilter.js";
import type { StorageProvider } from "./StorageProvider.js";
import { getIndexEntryMap } from "./SummaryStore.js";

const log = createLogger("LeafMarkdownCleanup");

export interface CleanupResult {
	readonly deleted: number;
	readonly failed: number;
}

/** Delete non-leaf visible .md files on a single branch. */
export async function cleanupBranchLeafMarkdown(
	cwd: string | undefined,
	branch: string,
	storage: StorageProvider,
): Promise<CleanupResult> {
	if (!storage.deleteVisibleMarkdown) {
		return { deleted: 0, failed: 0 };
	}
	const map = await getIndexEntryMap(cwd, storage);
	const branchEntries = [...map.values()].filter((e) => e.branch === branch);
	const leaves = getBranchLeaves(branchEntries);

	let deleted = 0;
	let failed = 0;
	for (const entry of branchEntries) {
		if (leaves.has(entry.commitHash)) continue;
		try {
			await storage.deleteVisibleMarkdown(entry);
			deleted++;
		} catch (err) {
			failed++;
			log.warn(
				"deleteVisibleMarkdown failed for %s on %s: %s",
				entry.commitHash.substring(0, 8),
				branch,
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	return { deleted, failed };
}

/** Delete non-leaf visible .md files across every branch in the index. */
export async function cleanupAllBranchesLeafMarkdown(
	cwd: string | undefined,
	storage: StorageProvider,
): Promise<CleanupResult> {
	if (!storage.deleteVisibleMarkdown) {
		return { deleted: 0, failed: 0 };
	}
	const map = await getIndexEntryMap(cwd, storage);
	const allEntries = [...map.values()];
	const leaves = getBranchLeaves(allEntries);

	let deleted = 0;
	let failed = 0;
	for (const entry of allEntries) {
		if (leaves.has(entry.commitHash)) continue;
		try {
			await storage.deleteVisibleMarkdown(entry);
			deleted++;
		} catch (err) {
			failed++;
			log.warn(
				"deleteVisibleMarkdown failed for %s on %s: %s",
				entry.commitHash.substring(0, 8),
				entry.branch,
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	return { deleted, failed };
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npm run test -w @jolli.ai/cli -- src/core/LeafMarkdownCleanup.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/LeafMarkdownCleanup.ts cli/src/core/LeafMarkdownCleanup.test.ts
git commit -s -m "Add LeafMarkdownCleanup helper (Migration + Worker share)

cleanupBranchLeafMarkdown(cwd, branch, storage) for per-op cleanup;
cleanupAllBranchesLeafMarkdown(cwd, storage) for the one-shot migration
sweep. Both no-op cleanly when storage has no visible layer."
```

---

## Task 5: Bridge filter — `listSummaryEntries` switches to leaf semantics

**Files:**
- Modify: `vscode/src/JolliMemoryBridge.ts`
- Modify: `vscode/src/JolliMemoryBridge.test.ts`

Replace the existing `parentCommitHash != null` rejection with `filterToBranchLeaves`. Dedup-by-commitHash for cross-repo aliasing stays. Existing tests will FAIL because the old behavior asserted "shows roots" — they need updating to the new "shows leaves" semantics.

- [ ] **Step 1: Update the existing test that asserts old behavior**

Edit `vscode/src/JolliMemoryBridge.test.ts`. Find the test `it("filters out entries with parentCommitHash", …)` near line 3126 and replace its whole `it(...)` block with:

```ts
		it("filters chain non-leaves out, surfacing the leaf instead", async () => {
			const root = makeEntry("aaa", "2025-01-01T00:00:00Z", "root", "main");
			const leaf = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"child",
				"main",
				"aaa",
			);
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", root],
					["bbb", leaf],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			// New semantics: leaves only. `bbb` is the leaf of chain aaa→bbb.
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].commitHash).toBe("bbb");
		});

		it("treats each branch as independent — rebase-pick keeps both branches' tips", async () => {
			const xOnly = makeEntry(
				"aaa",
				"2025-01-01T00:00:00Z",
				"X tip",
				"feature-x",
			);
			const yChild = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"Y child of X",
				"feature-y",
				"aaa",
			);
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", xOnly],
					["bbb", yChild],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			// `aaa` still leaf on feature-x; `bbb` leaf on feature-y.
			expect(result.entries.map((e) => e.commitHash).sort()).toEqual([
				"aaa",
				"bbb",
			]);
		});

		it("returns the leaf even when its chain root was removed from the index (dangling parent)", async () => {
			// Only the descendant remains; parent 'aaa' is gone.
			const leaf = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"orphan child",
				"main",
				"aaa",
			);
			getIndexEntryMap.mockResolvedValue(new Map([["bbb", leaf]]));

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].commitHash).toBe("bbb");
		});
```

- [ ] **Step 2: Run tests, verify the new ones fail and any old-behavior assertions also fail**

```bash
npm run test:vscode -- src/JolliMemoryBridge.test.ts -t "listSummaryEntries"
```
Expected: FAIL — "filters chain non-leaves out" expects `bbb`, current code returns `aaa`.

- [ ] **Step 3: Replace the filter in `listSummaryEntries`**

Edit `vscode/src/JolliMemoryBridge.ts`. At the top of the file, add to the existing import block from `cli`:

```ts
import { filterToBranchLeaves } from "../../cli/src/core/ChainLeafFilter.js";
```

(Place it next to the other `cli/src/core/*` imports; the existing pattern uses these relative paths because the VS Code esbuild bundle inlines them — see CLAUDE.md.)

Find the block inside `listSummaryEntries` that currently reads (around the `cachedRootEntries` assignment, near line 1397):

```ts
			const seen = new Set<string>();
			this.cachedRootEntries = merged
				.filter((e) => {
					if (e.parentCommitHash != null || seen.has(e.commitHash)) {
						return false;
					}
					seen.add(e.commitHash);
					return true;
				})
				.sort(
					(a, b) =>
						Date.parse(getDisplayDate(b)) - Date.parse(getDisplayDate(a)),
				);
```

Replace with:

```ts
			// Leaf filter is the headline behavior: collapses each (repoName, branch)
			// chain to its tip rather than its root. The trailing dedup is a
			// separate concern — same commit can appear under two repos via
			// tree-hash aliasing, and the current-repo copy wins (it was pushed to
			// `merged` first in step 1).
			const seen = new Set<string>();
			const leaves = filterToBranchLeaves(merged);
			this.cachedRootEntries = leaves
				.filter((e) => {
					if (seen.has(e.commitHash)) return false;
					seen.add(e.commitHash);
					return true;
				})
				.sort(
					(a, b) =>
						Date.parse(getDisplayDate(b)) - Date.parse(getDisplayDate(a)),
				);
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
npm run test:vscode -- src/JolliMemoryBridge.test.ts -t "listSummaryEntries"
```
Expected: PASS.

Also run the whole bridge file to catch downstream test impact:

```bash
npm run test:vscode -- src/JolliMemoryBridge.test.ts
```
Expected: PASS. If other tests reference the old behavior, update them to expect leaves (same renaming pattern as Step 1).

- [ ] **Step 5: Commit**

```bash
git add vscode/src/JolliMemoryBridge.ts vscode/src/JolliMemoryBridge.test.ts
git commit -s -m "listSummaryEntries: filter chains to leaves, not roots

Timeline / KB Memories list now shows the current tip of each
(repoName, branch) chain instead of the original commit. Cross-repo
dedup by commitHash stays; tests updated to assert the new semantics."
```

---

## Task 6: Bridge filter — `listBranchMemories` adds leaf filter (foreign view)

**Files:**
- Modify: `vscode/src/JolliMemoryBridge.ts`
- Modify: `vscode/src/JolliMemoryBridge.test.ts`

`listBranchMemories` currently returns every entry on the branch (no filter). The foreign Branch tab needs leaf-only too.

- [ ] **Step 1: Write failing test**

Find the existing `describe("listBranchMemories", …)` in `vscode/src/JolliMemoryBridge.test.ts`. (If none, search for the method by name to find where to insert.) Add inside it:

```ts
		it("returns only chain leaves on the named branch", async () => {
			const root = makeEntry("aaa", "2025-01-01T00:00:00Z", "root", "main");
			const child = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"leaf",
				"main",
				"aaa",
			);
			const other = makeEntry(
				"ccc",
				"2025-01-03T00:00:00Z",
				"other branch",
				"feature",
			);
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", root],
					["bbb", child],
					["ccc", other],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listBranchMemories(
				"workspace-repo",
				"main",
			);
			expect(result.map((e) => e.commitHash)).toEqual(["bbb"]);
		});
```

(If the test file's `makeEntry` factory in the `listSummaryEntries` block isn't visible at this scope, either lift it to the outer `describe` or define it locally inside the `listBranchMemories` block.)

- [ ] **Step 2: Run test, verify failure**

```bash
npm run test:vscode -- src/JolliMemoryBridge.test.ts -t "listBranchMemories"
```
Expected: FAIL — current `listBranchMemories` returns both `aaa` and `bbb`.

- [ ] **Step 3: Add the filter**

Edit `listBranchMemories` in `vscode/src/JolliMemoryBridge.ts`. The current body (around line 1484) reads:

```ts
		try {
			const map = await getIndexEntryMap(cwd, storage);
			const items: SummaryIndexEntry[] = [];
			for (const entry of map.values()) {
				if (entry.branch === branchName) {
					items.push({ ...entry, repoName });
				}
			}
			items.sort(
				(a, b) => Date.parse(getDisplayDate(b)) - Date.parse(getDisplayDate(a)),
			);
			return items;
		} catch (err) { ... }
```

Replace the inner block with:

```ts
		try {
			const map = await getIndexEntryMap(cwd, storage);
			const branchEntries: SummaryIndexEntry[] = [];
			for (const entry of map.values()) {
				if (entry.branch === branchName) {
					branchEntries.push({ ...entry, repoName });
				}
			}
			const leaves = filterToBranchLeaves(branchEntries);
			leaves.sort(
				(a, b) => Date.parse(getDisplayDate(b)) - Date.parse(getDisplayDate(a)),
			);
			return leaves;
		} catch (err) { ... }
```

(Same `filterToBranchLeaves` import added in Task 5 covers this.)

- [ ] **Step 4: Run tests, verify pass**

```bash
npm run test:vscode -- src/JolliMemoryBridge.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/JolliMemoryBridge.ts vscode/src/JolliMemoryBridge.test.ts
git commit -s -m "listBranchMemories: filter to chain leaves on the named branch

Foreign-view Branch tab now matches the Memory Bank tree count (also
leaf-only after Tasks 7/8 drain disk). Cross-branch chains keep each
branch's tip independent."
```

---

## Task 7: `MigrationEngine` v2 step — one-shot leaf cleanup on startup

**Files:**
- Modify: `cli/src/core/KBTypes.ts`
- Modify: `cli/src/core/MigrationEngine.ts`
- Modify: `cli/src/core/MigrationEngine.test.ts`

Extends `MigrationState` with a `leafCleanup` block and runs `cleanupAllBranchesLeafMarkdown` once per repo after the existing v1 migration completes. Idempotent gate via `leafCleanup.completedAt`.

- [ ] **Step 1: Extend `MigrationState`**

Edit `cli/src/core/KBTypes.ts`. Update the `MigrationState` interface (around line 49) to append the new optional block:

```ts
/** .jolli/migration.json — tracks orphan→folder migration progress */
export interface MigrationState {
	readonly status: "pending" | "in_progress" | "completed" | "partial" | "failed";
	readonly totalEntries: number;
	readonly migratedEntries: number;
	readonly failedHashes?: readonly string[];
	readonly lastMigratedHash?: string;
	/**
	 * v2 leaf-cleanup step (added 2026-05-12): one-shot deletion of non-leaf
	 * visible .md files. `completedAt` set on first successful run; subsequent
	 * runs skip when present. Absent = not yet attempted.
	 */
	readonly leafCleanup?: { readonly completedAt: string };
}
```

- [ ] **Step 2: Write failing test for the v2 step**

Append to `cli/src/core/MigrationEngine.test.ts` (inside the outermost `describe`):

```ts
	describe("v2 leaf cleanup", () => {
		it("deletes non-leaves and records completedAt", async () => {
			// Seed the folder storage with a chain a → b (b is leaf on main).
			const folderStorage = makeFolderStorage(); // existing helper in test file
			await folderStorage.writeFiles(
				[
					{
						path: "summaries/aaa.json",
						content: JSON.stringify({
							version: 3,
							commitHash: "aaa",
							commitMessage: "root",
							commitAuthor: "x",
							commitDate: "2026-05-12T00:00:00Z",
							branch: "main",
							generatedAt: "2026-05-12T00:00:00Z",
							topics: [],
						}),
					},
					{
						path: "summaries/bbb.json",
						content: JSON.stringify({
							version: 3,
							commitHash: "bbb",
							commitMessage: "leaf",
							commitAuthor: "x",
							commitDate: "2026-05-12T00:00:00Z",
							branch: "main",
							generatedAt: "2026-05-12T00:00:00Z",
							topics: [],
						}),
					},
					{
						path: "index.json",
						content: JSON.stringify({
							version: 3,
							entries: [
								{
									commitHash: "aaa",
									parentCommitHash: null,
									commitMessage: "root",
									commitDate: "2026-05-12T00:00:00Z",
									branch: "main",
									generatedAt: "2026-05-12T00:00:00Z",
								},
								{
									commitHash: "bbb",
									parentCommitHash: "aaa",
									commitMessage: "leaf",
									commitDate: "2026-05-12T00:00:00Z",
									branch: "main",
									generatedAt: "2026-05-12T00:00:00Z",
								},
							],
						}),
					},
				],
				"seed",
			);

			const engine = new MigrationEngine(
				makeOrphanStorage(/* same seed or empty — main migration not under test here */),
				folderStorage,
				makeMetadataManager(folderStorage.rootPath),
			);
			const state = await engine.runLeafCleanup();

			expect(state.leafCleanup?.completedAt).toBeTruthy();
			// `aaa` md gone, `bbb` md kept.
			expect(visibleMdExists(folderStorage.rootPath, "main", "root-aaa")).toBe(false);
			expect(visibleMdExists(folderStorage.rootPath, "main", "leaf-bbb")).toBe(true);
		});

		it("is a no-op when leafCleanup.completedAt is already set", async () => {
			const folderStorage = makeFolderStorage();
			const metadataManager = makeMetadataManager(folderStorage.rootPath);
			metadataManager.saveMigrationState({
				status: "completed",
				totalEntries: 0,
				migratedEntries: 0,
				leafCleanup: { completedAt: "2026-05-01T00:00:00Z" },
			});
			const engine = new MigrationEngine(
				makeOrphanStorage(),
				folderStorage,
				metadataManager,
			);
			const state = await engine.runLeafCleanup();
			expect(state.leafCleanup?.completedAt).toBe("2026-05-01T00:00:00Z");
		});
	});
```

If `makeFolderStorage` / `makeOrphanStorage` / `makeMetadataManager` / `visibleMdExists` helpers don't already exist in the test file, scan for the existing setup (the existing migration tests already construct these — reuse their pattern, or extract their bodies to local helpers at the top of this `describe`).

- [ ] **Step 3: Run test, verify failure**

```bash
npm run test -w @jolli.ai/cli -- src/core/MigrationEngine.test.ts -t "v2 leaf cleanup"
```
Expected: FAIL — `engine.runLeafCleanup is not a function`.

- [ ] **Step 4: Implement `runLeafCleanup` on `MigrationEngine`**

Edit `cli/src/core/MigrationEngine.ts`. Add import at top:

```ts
import { cleanupAllBranchesLeafMarkdown } from "./LeafMarkdownCleanup.js";
```

Add the new method as a public member after the existing `validateMigration()`:

```ts
	/**
	 * v2 step (added 2026-05-12): one-shot leaf-only cleanup of visible .md
	 * files on the folder storage. Idempotent via `state.leafCleanup.completedAt`.
	 * Called from `runMigration` after the v1 migration completes; can also be
	 * invoked directly (e.g. by hosts that already finished v1 but missed v2).
	 */
	async runLeafCleanup(): Promise<MigrationState> {
		const existing = this.metadataManager.readMigrationState();
		if (existing?.leafCleanup?.completedAt) {
			log.info("v2 leaf cleanup already completed at %s — skipping", existing.leafCleanup.completedAt);
			return existing;
		}

		log.info("=== v2 leaf cleanup started ===");
		const result = await cleanupAllBranchesLeafMarkdown(undefined, this.folderStorage);
		log.info("v2 leaf cleanup: deleted=%d failed=%d", result.deleted, result.failed);

		const merged: MigrationState = {
			status: existing?.status ?? "completed",
			totalEntries: existing?.totalEntries ?? 0,
			migratedEntries: existing?.migratedEntries ?? 0,
			...(existing?.failedHashes ? { failedHashes: existing.failedHashes } : {}),
			...(existing?.lastMigratedHash ? { lastMigratedHash: existing.lastMigratedHash } : {}),
			leafCleanup: { completedAt: new Date().toISOString() },
		};
		this.metadataManager.saveMigrationState(merged);
		return merged;
	}
```

Then call it from inside `runMigration`, right before the final `return finalState` line — append:

```ts
		// v2 step: drain backlog of non-leaf visible .md files left by amend /
		// rebase / squash sequences from before this code shipped. Idempotent.
		try {
			await this.runLeafCleanup();
		} catch (err) {
			log.warn("v2 leaf cleanup raised: %s", err instanceof Error ? err.message : String(err));
		}
```

- [ ] **Step 5: Run tests, verify pass**

```bash
npm run test -w @jolli.ai/cli -- src/core/MigrationEngine.test.ts
```
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/KBTypes.ts cli/src/core/MigrationEngine.ts cli/src/core/MigrationEngine.test.ts
git commit -s -m "MigrationEngine: add v2 leaf-cleanup step + completedAt gate

One-shot pass per repo over every branch via cleanupAllBranchesLeafMarkdown.
Records leafCleanup.completedAt in migration.json so the next boot skips.
Invoked at the tail of runMigration and exposed publicly for direct calls."
```

---

## Task 8: `QueueWorker` tail step — per-op incremental cleanup

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts`
- Modify: `cli/src/hooks/QueueWorker.test.ts`

Run `cleanupBranchLeafMarkdown` once after `processQueueEntry`'s switch returns, scoped to the current branch. Wrapped in try/catch — cleanup failure must NOT roll back the queue entry.

- [ ] **Step 1: Expose `processQueueEntry` via `__test__` + add mock for the cleanup module**

The existing test file already uses an `__test__` export pattern (see `cli/src/hooks/QueueWorker.ts:1603`). The new tests drive `processQueueEntry` directly. First, add `processQueueEntry` to the `__test__` export in `QueueWorker.ts`:

```ts
export const __test__ = {
	detectPlanSlugsFromRegistry,
	detectUncommittedNoteIds,
	hoistMetadataFromOldSummary,
	associatePlansWithCommit,
	executePipeline,
	handleAmendPipeline,
	handleSquashFromQueue,
	loadSessionTranscripts,
	buildStoredTranscript,
	processQueueEntry,
};
```

Next, at the top of `cli/src/hooks/QueueWorker.test.ts`, add a `vi.mock` for the new cleanup module alongside the existing mocks:

```ts
vi.mock("../core/LeafMarkdownCleanup.js", () => ({
	cleanupBranchLeafMarkdown: vi.fn().mockResolvedValue({ deleted: 0, failed: 0 }),
	cleanupAllBranchesLeafMarkdown: vi.fn().mockResolvedValue({ deleted: 0, failed: 0 }),
}));
```

Then add this import next to the existing `import { __test__, runWorker } from "./QueueWorker.js";` line:

```ts
import { cleanupBranchLeafMarkdown } from "../core/LeafMarkdownCleanup.js";
```

Append the new tests inside the outer `describe("QueueWorker", …)`:

```ts
	describe("post-op leaf cleanup", () => {
		const mockStorage = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
			deleteVisibleMarkdown: vi.fn(),
		};

		beforeEach(() => {
			vi.mocked(cleanupBranchLeafMarkdown).mockClear();
			vi.mocked(cleanupBranchLeafMarkdown).mockResolvedValue({
				deleted: 0,
				failed: 0,
			});
		});

		it("invokes cleanupBranchLeafMarkdown after processing an amend op", async () => {
			await __test__.processQueueEntry(
				{
					type: "amend",
					commitHash: "deadbeef1234567890abcdef0123456789abcdef",
					createdAt: new Date().toISOString(),
				} as never,
				"/test/cwd",
				mockStorage as never,
				false,
			);

			expect(cleanupBranchLeafMarkdown).toHaveBeenCalledWith(
				"/test/cwd",
				"feature/test", // mocked getCurrentBranch in the test scaffold
				mockStorage,
			);
		});

		it("swallows cleanup errors — the op succeeds even when cleanup throws", async () => {
			vi.mocked(cleanupBranchLeafMarkdown).mockRejectedValueOnce(
				new Error("disk-gone"),
			);

			await expect(
				__test__.processQueueEntry(
					{
						type: "commit",
						commitHash: "feedface1234567890abcdef0123456789abcdef",
						createdAt: new Date().toISOString(),
					} as never,
					"/test/cwd",
					mockStorage as never,
					false,
				),
			).resolves.toBeUndefined();
		});
	});
```

(The `getCurrentBranch` mock is already configured at the top of the test file to return `"feature/test"` — see existing setup.)

- [ ] **Step 2: Run test, verify failure**

```bash
npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.test.ts -t "post-op leaf cleanup"
```
Expected: FAIL — cleanup is not yet wired.

- [ ] **Step 3: Thread storage into `processQueueEntry`**

Edit `cli/src/hooks/QueueWorker.ts`. Add import at top:

```ts
import { cleanupBranchLeafMarkdown } from "../core/LeafMarkdownCleanup.js";
```

Currently `processQueueEntry(op, cwd, force)` accesses storage indirectly via the module-level `setActiveStorage` singleton inside SummaryStore. The cleanup call needs the storage instance directly (for the optional `deleteVisibleMarkdown` method), so promote `storage` to a parameter.

Update the call site at `runWorker` (around line 228) from:

```ts
					await processQueueEntry(op, cwd, force);
```

to:

```ts
					await processQueueEntry(op, cwd, storage, force);
```

Update `processQueueEntry`'s signature (around line 275) from:

```ts
async function processQueueEntry(op: GitOperation, cwd: string, force: boolean): Promise<void> {
```

to:

```ts
async function processQueueEntry(
	op: GitOperation,
	cwd: string,
	storage: StorageProvider,
	force: boolean,
): Promise<void> {
```

Add the `StorageProvider` import to the top of the file (or extend the existing one if `StorageProvider` is already imported elsewhere — grep first):

```ts
import type { StorageProvider } from "../core/StorageProvider.js";
```

Then append the tail step after the switch statement (right before the function's final `}`):

```ts
	// Tail step: prune visible .md files that this op left non-leaf on the
	// active branch. Pure index-driven — works the same for amend, rebase-pick,
	// squash, and rebase-squash. Failures here MUST NOT roll back the op.
	try {
		const branch = await getCurrentBranch(cwd);
		const { deleted, failed } = await cleanupBranchLeafMarkdown(cwd, branch, storage);
		if (deleted > 0 || failed > 0) {
			log.info(
				"Leaf cleanup on %s: deleted=%d failed=%d",
				branch,
				deleted,
				failed,
			);
		}
	} catch (err) {
		log.warn(
			"Leaf cleanup tail step failed for %s: %s",
			op.commitHash.substring(0, 8),
			err instanceof Error ? err.message : String(err),
		);
	}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts
git commit -s -m "QueueWorker: tail leaf-cleanup step after every op

Runs cleanupBranchLeafMarkdown against the active branch once
processQueueEntry's switch returns. Failures swallowed into a warn log
so a cleanup hiccup never rolls back the queue entry."
```

---

## Task 9: CLI parity audit + full gate

**Files:** none expected to change.

`jolli` CLI commands (`search`, etc.) read through `SummaryStore` / `getIndexEntryMap` — the same modules the bridge uses. Verify by grep + smoke test.

- [ ] **Step 1: Grep for any direct read paths**

```bash
grep -rn "parentCommitHash != null\|parentCommitHash !==\|\.parentCommitHash\b" cli/src/commands cli/src/core 2>/dev/null
```
Expected: every match either inside a write/storage path or already routed through `getIndexEntryMap` callers (`listSummaryEntries`, etc.). If you find a command that filters entries with `parentCommitHash != null` for display, switch it to `filterToBranchLeaves`.

- [ ] **Step 2: Smoke-test a search command against a tmpdir-rooted repo**

Set up a tmpdir with a fake `.jolli/index.json` containing a 3-entry chain (`a→b→c`), run:

```bash
cd <tmpdir>
node <jolli-cli-dist>/cli.js search --limit 10
```
Expected: only `c` (the leaf) listed.

(If no `search` command exists, substitute whichever CLI surface reads the index for display — `jolli list`, `jolli history`, etc.)

- [ ] **Step 3: Run the full gate**

```bash
cd /Users/flyer/jolli/code/jollimemory
npm run all
```
Expected: PASS — CLI 97%+ coverage holds; VS Code tests pass; biome clean.

- [ ] **Step 4: Manual UI smoke test**

Build the VSCode extension and reload it in a real workspace that already has chain memories (a repo with a 5-amend chain):

```bash
cd vscode && npm run deploy
# In VS Code: Developer: Reload Window.
```

Verify:
- Memory Bank tree shows leaf-only.
- Timeline / KB Memories list shows leaf-only.
- Branch tab Memories (workspace) shows what `git log mergeBase..HEAD` gives — unchanged behavior, but the now-deleted non-leaf `.md` files no longer surface in any view that read from disk or storage.
- Click a leaf row → Summary panel opens normally.

- [ ] **Step 5: Commit the audit notes (only if any code changed)**

If grep surfaced and fixed a stray filter site in cli/src/, commit those changes. Otherwise skip.

---

## Self-review checkpoints (run after Task 9)

- [ ] Spec coverage: each section of `docs/superpowers/specs/2026-05-12-leaf-only-memory-display-design.md` (ChainLeafFilter, FolderStorage.deleteVisibleMarkdown, listSummaryEntries / listBranchMemories filters, MigrationEngine v2, QueueWorker incremental, CLI parity) maps to a task above.
- [ ] No regression in `cleanupSupersededDescendants`: that older write-time cleanup path stays in place as defense-in-depth; the new leaf-cleanup runs additionally. Both are idempotent.
- [ ] Coverage floor: CLI 97% statements / 96% branches / 97% functions / 97% lines (per `cli/vite.config.ts`). New files have ≥97% coverage from their `.test.ts` siblings.
- [ ] `npm run all` green.
