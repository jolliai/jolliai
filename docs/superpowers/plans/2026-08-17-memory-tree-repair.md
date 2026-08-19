# Memory Tree Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `jolli repair-memory`, a CLI command that reattaches memory trees left stranded under a hash the branch no longer has after an amend, rebase or squash.

**Architecture:** Detection runs on `listSummaries()` plus git reachability, so it is storage-backend agnostic and behaves identically before and after cutover. Repair dispatches on the target's state: `migrate` reuses `migrateOneToOne` / `mergeManyToOne` unchanged, `remount` is new and preserves the target's own topics. The squash consolidation pipeline is extracted out of `QueueWorker` so both callers share it with different failure policies.

**Tech Stack:** TypeScript (ESM, Node 22.13+), commander, vitest, biome (tabs, 120 cols).

**Spec:** `docs/superpowers/specs/2026-08-17-memory-tree-repair-design.md`

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude` trailer, no `🤖 Generated with` footer.
- **`npm run all` must pass before the final commit** (clean → build → typecheck → lint → test).
- **CLI coverage floor**: 97% statements / 96% branches / 97% functions / 97% lines.
- **Biome**: tabs, 4-wide, 120 column limit. `noExplicitAny: error`, `noUnusedImports/Variables: error`. CI runs `biome check --error-on-warnings` — warnings fail.
- **Never call `acquireOrphanWriteLock` directly** — always through `withRequiredOrphanWriteLock` / `withDeferrableOrphanWriteLock` / `Locks.withOrphanWriteLock`. A bare acquire is a review blocker, and nesting one inside a section that already holds it self-blocks and reports contention while the write silently never lands.
- **Any new real-`git` test file MUST be added to BOTH `SLOW_TEST_FILES` AND `SLOW_ONLY_SOURCES` in `cli/vite.config.ts`.** `SLOW_TEST_FILES` is the single source of truth for the tier split (a one-sided edit leaves a file in both tiers or neither). `SLOW_ONLY_SOURCES` is its **required pair**: `--mode fast` drops the slow test files, so it must also drop the source files those tests are solely responsible for, or their lines and branches stay in the coverage denominator with nothing exercising them and `test:fast` fails the 97/96/97/97 thresholds on a suite that passed. That file's own header records this being measured twice ("425 files all green, 94.93% branches, exit 1"). A source file whose ONLY coverage comes from a slow test file belongs in `SLOW_ONLY_SOURCES`.
- **Use `toForwardSlash` from `cli/src/core/PathUtils.ts`** for any `\` → `/` normalization; never inline `path.replace(/\\/g, "/")`.

---

## File Structure

| File | Responsibility |
|---|---|
| `cli/src/core/repair/GitReachability.ts` (create) | One predicate: is a commit reachable from any ref. |
| `cli/src/core/repair/StrandedTrees.ts` (create) | Find memory roots whose commit no longer reachable. |
| `cli/src/core/repair/ReflogPairing.ts` (create) | Derive old→new rewrite pairs from reflog. |
| `cli/src/core/repair/RepairPlan.ts` (create) | Turn stranded trees + pairs into typed repair actions. |
| `cli/src/core/repair/RepairExecutor.ts` (create) | Back up, then execute actions. |
| `cli/src/core/SquashConsolidation.ts` (create) | Squash consolidation pipeline extracted from `QueueWorker`, failure policy parameterized. |
| `cli/src/core/SummaryStore.ts` (modify) | Extract `copyHoistFields`; add `remountStrandedTree`. |
| `cli/src/hooks/QueueWorker.ts` (modify) | `runSquashPipeline` delegates to the extracted module. |
| `cli/src/commands/RepairMemoryCommand.ts` (create) | Command registration, `--status` rendering. |
| `cli/src/commands/DoctorCommand.ts` (modify) | Add the `Memory tree` check. |
| `cli/src/Api.ts` (modify) | Register the command. |
| `cli/vite.config.ts` (modify) | Register the real-git test files in `SLOW_TEST_FILES`. |

---

### Task 1: Reachability predicate

**Files:**
- Create: `cli/src/core/repair/GitReachability.ts`
- Test: `cli/src/core/repair/GitReachability.realgit.test.ts`
- Modify: `cli/vite.config.ts` (add the test file to `SLOW_TEST_FILES`)

**Interfaces:**
- Consumes: `execGit(args: ReadonlyArray<string>, cwd?: string): Promise<GitCommandResult>` from `cli/src/core/GitOps.js`
- Produces: `isReachableFromAnyRef(hash: string, cwd: string): Promise<boolean>`

This is the core invariant of the whole feature. It must be "reachable from **any ref**", never "in HEAD's history" — a memory root on another branch is perfectly healthy, and a HEAD-based predicate would flag every tree on every other branch the moment you switch branches.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execGit } from "../GitOps.js";
import { isReachableFromAnyRef } from "./GitReachability.js";

async function commit(dir: string, message: string): Promise<string> {
	await execGit(["commit", "--allow-empty", "-m", message], dir);
	const res = await execGit(["rev-parse", "HEAD"], dir);
	return res.stdout.trim();
}

describe("isReachableFromAnyRef", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "jolli-reach-"));
		await execGit(["init", "-b", "main"], dir);
		await execGit(["config", "user.email", "t@example.com"], dir);
		await execGit(["config", "user.name", "T"], dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reports a commit on the current branch as reachable", async () => {
		const hash = await commit(dir, "one");
		expect(await isReachableFromAnyRef(hash, dir)).toBe(true);
	});

	it("reports an amended-away commit as unreachable", async () => {
		const old = await commit(dir, "one");
		await execGit(["commit", "--amend", "-m", "one amended"], dir);
		expect(await isReachableFromAnyRef(old, dir)).toBe(false);
	});

	it("reports a commit on ANOTHER branch as reachable", async () => {
		await commit(dir, "base");
		await execGit(["checkout", "-b", "side"], dir);
		const sideHash = await commit(dir, "side work");
		await execGit(["checkout", "main"], dir);
		expect(await isReachableFromAnyRef(sideHash, dir)).toBe(true);
	});

	it("reports an unknown hash as unreachable instead of throwing", async () => {
		await commit(dir, "one");
		expect(await isReachableFromAnyRef("0".repeat(40), dir)).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/GitReachability.realgit.test.ts`
Expected: FAIL — cannot resolve `./GitReachability.js`

- [ ] **Step 3: Write minimal implementation**

```ts
import { execGit } from "../GitOps.js";

/**
 * Is `hash` reachable from ANY ref in this repository?
 *
 * "Any ref", never "HEAD's history": a memory root that lives on another
 * branch is healthy, and a HEAD-based predicate would report every other
 * branch's roots as stranded the moment the user switches branches.
 *
 * An object git does not have (gc'd, or a hash from another clone) is
 * unreachable rather than an error — the caller's next question is whether a
 * repair target exists, and a missing object answers that the same way.
 */
export async function isReachableFromAnyRef(hash: string, cwd: string): Promise<boolean> {
	const exists = await execGit(["cat-file", "-e", `${hash}^{commit}`], cwd);
	if (exists.exitCode !== 0) return false;
	const res = await execGit(["for-each-ref", "--contains", hash, "--count=1", "--format=%(refname)"], cwd);
	if (res.exitCode !== 0) return false;
	return res.stdout.trim().length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/GitReachability.realgit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Register the test file in the slow tier**

In `cli/vite.config.ts`, add to the `SLOW_TEST_FILES` array, keeping the list alphabetically sorted:

```ts
	"src/core/repair/GitReachability.realgit.test.ts",
```

- [ ] **Step 6: Verify the tier split still partitions**

Run: `npm run test:fast`
Expected: PASS, and the new file is NOT among the files run.

- [ ] **Step 7: Commit**

```bash
git add cli/src/core/repair/GitReachability.ts cli/src/core/repair/GitReachability.realgit.test.ts cli/vite.config.ts
git commit -s -m "feat(repair): add any-ref reachability predicate"
```

---

### Task 2: Stranded-root detection

**Files:**
- Create: `cli/src/core/repair/StrandedTrees.ts`
- Test: `cli/src/core/repair/StrandedTrees.test.ts`

**Interfaces:**
- Consumes: `isReachableFromAnyRef` (Task 1); `listSummaries(count?: number, cwd?: string, storage?: StorageProvider): Promise<ReadonlyArray<CommitSummary>>` from `cli/src/core/SummaryStore.js`
- Produces:
  ```ts
  export interface StrandedTree {
      readonly oldHash: string;
      readonly root: CommitSummary;
      readonly conversationCount: number;
      readonly skillCount: number;
  }
  export interface StrandedDeps {
      readonly isReachable?: (hash: string, cwd: string) => Promise<boolean>;
      readonly loadRoots?: (cwd: string, storage?: StorageProvider) => Promise<ReadonlyArray<CommitSummary>>;
      readonly storage?: StorageProvider;
  }
  export async function findStrandedRoots(cwd: string, deps?: StrandedDeps): Promise<ReadonlyArray<StrandedTree>>
  ```

`isReachable` and `loadRoots` are injectable so this task's tests stay in the fast tier — only Task 1 pays for real git. `listSummaries` needs a large `count`: its default is 10, which would silently only inspect the ten newest roots.

Tests inject **`loadRoots`**, never a fake `storage`. `storage` is typed `StorageProvider` and is passed straight through to `listSummaries`; satisfying it in a test with an object literal plus an `as never` cast would be a lie in the type, and would force a branch in the implementation whose only purpose is to serve that lie.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../Types.js";

vi.mock("./GitReachability.js", () => ({ isReachableFromAnyRef: vi.fn() }));
vi.mock("../SummaryStore.js", () => ({ listSummaries: vi.fn() }));

const { isReachableFromAnyRef } = await import("./GitReachability.js");
const { listSummaries } = await import("../SummaryStore.js");
const { findStrandedRoots } = await import("./StrandedTrees.js");

function root(hash: string, over: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 5,
		commitHash: hash,
		commitMessage: `msg ${hash}`,
		commitAuthor: "T",
		commitDate: "2026-08-17T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T00:00:00.000Z",
		topics: [],
		recap: "",
		...over,
	} as CommitSummary;
}

describe("findStrandedRoots", () => {
	const withRoots = (...roots: CommitSummary[]) => async () => roots;

	it("returns roots whose commit is unreachable", async () => {
		const result = await findStrandedRoots("/repo", {
			loadRoots: withRoots(root("aaa"), root("bbb")),
			isReachable: async (h) => h === "bbb",
		});
		expect(result.map((r) => r.oldHash)).toEqual(["aaa"]);
	});

	it("ignores reachable roots entirely", async () => {
		const result = await findStrandedRoots("/repo", {
			loadRoots: withRoots(root("aaa")),
			isReachable: async () => true,
		});
		expect(result).toEqual([]);
	});

	it("counts conversations and skills the repair would bring back", async () => {
		const [only] = await findStrandedRoots("/repo", {
			loadRoots: withRoots(
				root("aaa", {
					transcripts: ["t1", "t2", "t3"],
					skills: [{ archivedKey: "k1" }, { archivedKey: "k2" }],
				} as Partial<CommitSummary>),
			),
			isReachable: async () => false,
		});
		expect(only?.conversationCount).toBe(3);
		expect(only?.skillCount).toBe(2);
	});

	it("counts across the whole tree, not just the root node", async () => {
		const child = root("child", { transcripts: ["t1", "t2"], skills: [{ archivedKey: "k" }] } as Partial<CommitSummary>);
		const [only] = await findStrandedRoots("/repo", {
			loadRoots: withRoots(root("aaa", { children: [child] } as Partial<CommitSummary>)),
			isReachable: async () => false,
		});
		expect(only?.conversationCount).toBe(2);
		expect(only?.skillCount).toBe(1);
	});

	// The DEFAULT wiring is the production path and every test above injects
	// past it. Without this case, passing the wrong function or the wrong
	// argument order to `listSummaries` would not fail a single test.
	it("defaults to the real reachability predicate and the real root loader", async () => {
		vi.mocked(listSummaries).mockResolvedValue([root("aaa")]);
		vi.mocked(isReachableFromAnyRef).mockResolvedValue(false);

		const result = await findStrandedRoots("/repo");

		expect(listSummaries).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER, "/repo", undefined);
		expect(isReachableFromAnyRef).toHaveBeenCalledWith("aaa", "/repo");
		expect(result.map((r) => r.oldHash)).toEqual(["aaa"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/StrandedTrees.test.ts`
Expected: FAIL — cannot resolve `./StrandedTrees.js`

- [ ] **Step 3: Write minimal implementation**

```ts
import type { CommitSummary } from "../../Types.js";
import type { StorageProvider } from "../StorageProvider.js";
import { listSummaries } from "../SummaryStore.js";
import { isReachableFromAnyRef } from "./GitReachability.js";

/** Large enough to cover every root; `listSummaries` defaults to 10. */
const ALL_ROOTS = Number.MAX_SAFE_INTEGER;

export interface StrandedTree {
	readonly oldHash: string;
	readonly root: CommitSummary;
	readonly conversationCount: number;
	readonly skillCount: number;
}

export interface StrandedDeps {
	readonly isReachable?: (hash: string, cwd: string) => Promise<boolean>;
	readonly loadRoots?: (cwd: string, storage?: StorageProvider) => Promise<ReadonlyArray<CommitSummary>>;
	readonly storage?: StorageProvider;
}

function walk(node: CommitSummary, visit: (n: CommitSummary) => void): void {
	visit(node);
	for (const child of node.children ?? []) walk(child, visit);
}

function countTree(root: CommitSummary): { conversations: number; skills: number } {
	let conversations = 0;
	let skills = 0;
	walk(root, (n) => {
		conversations += n.transcripts?.length ?? 0;
		skills += n.skills?.length ?? 0;
	});
	return { conversations, skills };
}

export async function findStrandedRoots(cwd: string, deps: StrandedDeps = {}): Promise<ReadonlyArray<StrandedTree>> {
	const isReachable = deps.isReachable ?? isReachableFromAnyRef;
	const loadRoots =
		deps.loadRoots ?? ((dir: string, storage?: StorageProvider) => listSummaries(ALL_ROOTS, dir, storage));
	const roots = await loadRoots(cwd, deps.storage);

	const stranded: StrandedTree[] = [];
	for (const root of roots) {
		if (await isReachable(root.commitHash, cwd)) continue;
		const counts = countTree(root);
		stranded.push({
			oldHash: root.commitHash,
			root,
			conversationCount: counts.conversations,
			skillCount: counts.skills,
		});
	}
	return stranded;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/StrandedTrees.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/repair/StrandedTrees.ts cli/src/core/repair/StrandedTrees.test.ts
git commit -s -m "feat(repair): detect memory roots stranded under unreachable commits"
```

---

### Task 3: Reflog pairing

**Files:**
- Create: `cli/src/core/repair/ReflogPairing.ts`
- Test: `cli/src/core/repair/ReflogPairing.realgit.test.ts`
- Modify: `cli/vite.config.ts`

**Interfaces:**
- Consumes: `execGit`; `isReachableFromAnyRef` (Task 1)
- Produces:
  ```ts
  export type PairingResult =
      | { readonly kind: "paired"; readonly newHash: string }
      | { readonly kind: "none" }
      | { readonly kind: "conflict"; readonly candidates: ReadonlyArray<string> };
  export async function pairStrandedHash(
      oldHash: string,
      cwd: string,
      deps?: { readonly isReachable?: (hash: string, cwd: string) => Promise<boolean> },
  ): Promise<PairingResult>
  ```

Algorithm: read `git reflog show --format=%H` (newest first). Find every position holding `oldHash`; from each, scan **newer** entries for the first hash that is currently reachable — that is the candidate target. Distinct candidates across positions is a `conflict`, not a guess. This one rule covers amend chains and squashes alike: several stranded roots pairing to the same target is exactly what an N→1 squash looks like.

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execGit } from "../GitOps.js";
import { pairStrandedHash } from "./ReflogPairing.js";

async function commit(dir: string, message: string): Promise<string> {
	await execGit(["commit", "--allow-empty", "-m", message], dir);
	return (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();
}

describe("pairStrandedHash", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "jolli-pair-"));
		await execGit(["init", "-b", "main"], dir);
		await execGit(["config", "user.email", "t@example.com"], dir);
		await execGit(["config", "user.name", "T"], dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("pairs an amended-away hash to the amended commit", async () => {
		await commit(dir, "base");
		const old = await commit(dir, "work");
		await execGit(["commit", "--amend", "-m", "work amended"], dir);
		const head = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();

		expect(await pairStrandedHash(old, dir)).toEqual({ kind: "paired", newHash: head });
	});

	it("pairs through a chain of several amends to the final commit", async () => {
		await commit(dir, "base");
		const first = await commit(dir, "work");
		await execGit(["commit", "--amend", "-m", "v2"], dir);
		await execGit(["commit", "--amend", "-m", "v3"], dir);
		const head = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();

		expect(await pairStrandedHash(first, dir)).toEqual({ kind: "paired", newHash: head });
	});

	it("returns none for a hash the reflog never saw", async () => {
		await commit(dir, "base");
		expect(await pairStrandedHash("0".repeat(40), dir)).toEqual({ kind: "none" });
	});

	// TEETH. Without this case the three above are all satisfied by a shortcut
	// that never scans reflog positions at all:
	//     if (!entries.includes(oldHash)) return { kind: "none" };
	//     return { kind: "paired", newHash: <current HEAD> };
	// — because in those fixtures HEAD never leaves the amend chain, so "current
	// HEAD" and "the rewritten commit" are the same commit. Here they differ.
	it("pairs to the rewritten commit, not to wherever HEAD happens to be now", async () => {
		await commit(dir, "base");
		const stranded = await commit(dir, "work");
		await execGit(["commit", "--allow-empty", "--amend", "-m", "work v2"], dir);
		const rewritten = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();
		await execGit(["checkout", "-b", "side"], dir);
		const head = await commit(dir, "side work");

		expect(await pairStrandedHash(stranded, dir)).toEqual({ kind: "paired", newHash: rewritten });
		expect(rewritten).not.toBe(head);
	});

	// The `conflict` arm — the one behavior that distinguishes "we know the
	// target" from "the user must tell us". It needs the stranded hash to appear
	// at TWO reflog positions with a DIFFERENT reachable entry newer than each.
	// The sequence below produces reflog [R, A, X, R, X, R, base] (newest first):
	// X sits at positions 2 and 4; scanning newer from 2 reaches A first, from 4
	// reaches R first, and both are kept reachable by their own branches.
	// Measured before being written down — a plausible-looking variant that
	// leaves both positions resolving to the same commit yields `paired`, not
	// `conflict`, and would pass while proving nothing.
	it("reports a conflict when one hash pairs to two different targets", async () => {
		await commit(dir, "base");
		const r = await commit(dir, "r");
		await execGit(["branch", "keep-r"], dir);
		const x = await commit(dir, "x");
		await execGit(["reset", "--hard", r], dir);
		await execGit(["reset", "--hard", x], dir);
		const a = await commit(dir, "a");
		await execGit(["branch", "keep-a"], dir);
		await execGit(["reset", "--hard", r], dir);

		const result = await pairStrandedHash(x, dir);

		expect(result.kind).toBe("conflict");
		expect([...(result as { candidates: ReadonlyArray<string> }).candidates].sort()).toEqual([a, r].sort());
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/ReflogPairing.realgit.test.ts`
Expected: FAIL — cannot resolve `./ReflogPairing.js`

- [ ] **Step 3: Write minimal implementation**

```ts
import { execGit } from "../GitOps.js";
import { isReachableFromAnyRef } from "./GitReachability.js";

export type PairingResult =
	| { readonly kind: "paired"; readonly newHash: string }
	| { readonly kind: "none" }
	| { readonly kind: "conflict"; readonly candidates: ReadonlyArray<string> };

export interface PairingDeps {
	readonly isReachable?: (hash: string, cwd: string) => Promise<boolean>;
}

/**
 * Which currently-reachable commit did `oldHash` become?
 *
 * The reflog is newest-first. For each position holding `oldHash`, the answer
 * is the first NEWER entry whose hash is still reachable. Two positions
 * disagreeing is a `conflict` rather than a guess — the user then supplies
 * `--from/--to`.
 *
 * The reflog is gc'd (90 days by default), is per-clone and does not travel
 * between machines, so `none` is an ordinary outcome, not a fault.
 */
export async function pairStrandedHash(oldHash: string, cwd: string, deps: PairingDeps = {}): Promise<PairingResult> {
	const isReachable = deps.isReachable ?? isReachableFromAnyRef;
	const res = await execGit(["reflog", "show", "--format=%H"], cwd);
	if (res.exitCode !== 0) return { kind: "none" };
	const entries = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

	const candidates = new Set<string>();
	for (let i = 0; i < entries.length; i++) {
		if (entries[i] !== oldHash) continue;
		for (let j = i - 1; j >= 0; j--) {
			const candidate = entries[j];
			if (candidate === oldHash) continue;
			if (await isReachable(candidate, cwd)) {
				candidates.add(candidate);
				break;
			}
		}
	}

	if (candidates.size === 0) return { kind: "none" };
	if (candidates.size > 1) return { kind: "conflict", candidates: [...candidates] };
	return { kind: "paired", newHash: [...candidates][0] as string };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/ReflogPairing.realgit.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register in the slow tier — BOTH lists**

Add to `SLOW_TEST_FILES` in `cli/vite.config.ts`, alphabetically:

```ts
	"src/core/repair/ReflogPairing.realgit.test.ts",
```

And to `SLOW_ONLY_SOURCES` in the same file, because this test is the only coverage `ReflogPairing.ts` has:

```ts
	"src/core/repair/ReflogPairing.ts",
```

Omitting the second list leaves the source in `test:fast`'s coverage denominator with its only test excluded, which fails the thresholds on a suite that passed.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/repair/ReflogPairing.ts cli/src/core/repair/ReflogPairing.realgit.test.ts cli/vite.config.ts
git commit -s -m "feat(repair): derive rewrite targets from the reflog"
```

---

### Task 4: Shared Copy-Hoist + `remountStrandedTree`

**Files:**
- Modify: `cli/src/core/SummaryStore.ts` (extract the hoist block out of `migrateOneToOne`'s `newSummary` literal, around line 540-585; add the new export)
- Test: `cli/src/core/SummaryStore.remount.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function copyHoistFields(oldSummary: CommitSummary): Partial<CommitSummary>
  export async function remountStrandedTree(
      target: CommitSummary,
      strandedRoot: CommitSummary,
      cwd?: string,
      storage?: StorageProvider,
  ): Promise<void>
  ```

This is the action for "the target already has a memory". `migrateOneToOne` cannot serve it: its `topics` come from `resolveEffectiveTopics(oldSummary)`, so it would overwrite the target's own topics and recap.

`copyHoistFields` must be the **only** place the hoisted field set is written down. Two hand-maintained lists is precisely how a field gets dropped — during the manual recovery that produced this spec, the first attempt remounted without hoisting and silently left `skills: 0`.

The spec asks for a test asserting the two callers' field sets are equal. Extracting one shared function is the **stronger** form of that requirement: the sets cannot differ, so the assertion becomes structural rather than something a test has to catch after the fact. Do not additionally write a comparison test between the two call sites — there is only one site to compare. Test `copyHoistFields` directly (Step 1) and let both callers inherit it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../Types.js";
import { copyHoistFields } from "./SummaryStore.js";

function summary(over: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 5,
		commitHash: "old",
		commitMessage: "m",
		commitAuthor: "T",
		commitDate: "2026-08-17T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T00:00:00.000Z",
		topics: [],
		recap: "",
		...over,
	} as CommitSummary;
}

describe("copyHoistFields", () => {
	it("copies every field migrateOneToOne hoists onto a new root", () => {
		const old = summary({
			skills: [{ archivedKey: "k" }],
			jolliSkillsDocId: 11113,
			jolliSkillsDocUrl: "https://example.test/skills",
			transcripts: ["t1", "t2"],
			plans: [{ slug: "p" }],
			notes: [{ slug: "n" }],
			references: [{ key: "r" }],
		} as Partial<CommitSummary>);

		expect(copyHoistFields(old)).toEqual({
			skills: [{ archivedKey: "k" }],
			jolliSkillsDocId: 11113,
			jolliSkillsDocUrl: "https://example.test/skills",
			transcripts: ["t1", "t2"],
			plans: [{ slug: "p" }],
			notes: [{ slug: "n" }],
			references: [{ key: "r" }],
		});
	});

	it("omits absent fields rather than writing undefined", () => {
		expect(copyHoistFields(summary())).toEqual({});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryStore.remount.test.ts`
Expected: FAIL — `copyHoistFields` is not exported

- [ ] **Step 3: Extract `copyHoistFields` and make `migrateOneToOne` use it**

Add the export, then replace the corresponding spread lines inside `migrateOneToOne`'s `newSummary` literal with `...copyHoistFields(oldSummary),`:

```ts
/**
 * The fields a rewrite copies from the old root onto the new one.
 *
 * Copy, not move: skills are deliberately NOT stripped off the child
 * (`stripFunctionalMetadata` has no stripSkills), so root and child hold the
 * same ref. A later squash's `collectChildSkills` meets each ref from both
 * ends and `mergeSkillRefs` dedupes by `archivedKey`.
 *
 * ONE definition, two callers (`migrateOneToOne` and `remountStrandedTree`).
 * A second hand-maintained list is how the next field gets dropped, and the
 * failure is silent: a memory simply missing its skills, with nothing to say so.
 */
export function copyHoistFields(oldSummary: CommitSummary): Partial<CommitSummary> {
	return {
		...(oldSummary.skills && { skills: oldSummary.skills }),
		...(oldSummary.jolliSkillsDocId && { jolliSkillsDocId: oldSummary.jolliSkillsDocId }),
		...(oldSummary.jolliSkillsDocUrl && { jolliSkillsDocUrl: oldSummary.jolliSkillsDocUrl }),
		...(oldSummary.transcripts && { transcripts: oldSummary.transcripts }),
		...(oldSummary.plans && { plans: oldSummary.plans }),
		...(oldSummary.notes && { notes: oldSummary.notes }),
		...(oldSummary.references && { references: oldSummary.references }),
	};
}
```

- [ ] **Step 4: Run the full SummaryStore suite to prove the extraction is behaviour-preserving**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryStore.test.ts src/core/SummaryStore.remount.test.ts`
Expected: PASS — existing `migrateOneToOne` tests unchanged and green.

- [ ] **Step 5: Write the failing test for `remountStrandedTree`**

Append to `cli/src/core/SummaryStore.remount.test.ts`:

```ts
import { remountStrandedTree } from "./SummaryStore.js";

describe("remountStrandedTree", () => {
	it("keeps the target's own topics and recap while attaching the stranded tree", async () => {
		const stored: CommitSummary[] = [];
		const storage = {
			readFile: async () => null,
			writeFiles: async (files: ReadonlyArray<{ path: string; content: string }>) => {
				for (const f of files) if (f.path.startsWith("summaries/")) stored.push(JSON.parse(f.content));
			},
			listFiles: async () => [],
			exists: async () => true,
			ensure: async () => undefined,
		} as never;

		const target = summary({ commitHash: "new", topics: [{ title: "fresh" }], recap: "fresh recap" } as Partial<CommitSummary>);
		const stranded = summary({ commitHash: "old", skills: [{ archivedKey: "k" }], transcripts: ["t1"] } as Partial<CommitSummary>);

		await remountStrandedTree(target, stranded, "/repo", storage);

		const written = stored.find((s) => s.commitHash === "new");
		expect(written?.topics).toEqual([{ title: "fresh" }]);
		expect(written?.recap).toBe("fresh recap");
		expect(written?.children?.[0]?.commitHash).toBe("old");
		expect(written?.skills).toEqual([{ archivedKey: "k" }]);
		expect(written?.transcripts).toEqual(["t1"]);
	});

	it("refuses when the target already has children", async () => {
		const target = summary({ commitHash: "new", children: [summary({ commitHash: "existing" })] } as Partial<CommitSummary>);
		await expect(remountStrandedTree(target, summary(), "/repo", {} as never)).rejects.toThrow(/already has children/);
	});
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryStore.remount.test.ts`
Expected: FAIL — `remountStrandedTree` is not exported

- [ ] **Step 7: Extract `storeSummaryLocked` so the new writer can reuse it without double-locking**

`storeSummary`'s locked body is currently an inline anonymous arrow function, so there is nothing for a second caller to reuse. Give it a name. In `cli/src/core/SummaryStore.ts`, change:

```ts
	if (isManuallyDisabled()) return;
	await withRequiredOrphanWriteLock(cwd, "storeSummary", async () => {
		const writeIndex = await loadIndex(cwd, storage);
		// … existing body …
	});
}
```

to:

```ts
	if (isManuallyDisabled()) return;
	await withRequiredOrphanWriteLock(cwd, "storeSummary", () =>
		storeSummaryLocked(summary, cwd, force, artifacts, storage, readStorage),
	);
}

/**
 * The body of {@link storeSummary}, minus the lock.
 *
 * Named so a second writer (`remountStrandedTree`) can run it under its OWN
 * lock acquisition. Calling the public `storeSummary` from inside another
 * locked section would acquire the lock a second time; the lock refuses even
 * its own PID, so that write polls out its budget and then reports
 * contention — a log line identical to real contention, while nothing lands.
 */
async function storeSummaryLocked(
	summary: CommitSummary,
	cwd?: string,
	force = false,
	artifacts?: {
		readonly transcript?: { readonly id: string; readonly data: StoredTranscript };
		readonly planProgress?: ReadonlyArray<PlanProgressArtifact>;
	},
	storage?: StorageProvider,
	readStorage?: StorageProvider,
): Promise<void> {
	const writeIndex = await loadIndex(cwd, storage);
	// … the rest of the existing body, unchanged …
}
```

Note `isManuallyDisabled()` stays in the public wrapper, not in the extracted body — it is checked before the lock on purpose (acquiring the lock is itself a disk write, so a disabled project would otherwise be left with a lock artifact). `remountStrandedTree` must therefore check it too.

- [ ] **Step 8: Run the SummaryStore suite to prove the extraction changed nothing**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryStore.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 9: Implement `remountStrandedTree`**

```ts
/**
 * Attach a stranded tree under a target that ALREADY has its own memory.
 *
 * The counterpart to `migrateOneToOne`, for the case that function cannot
 * serve: its `topics` come from `resolveEffectiveTopics(oldSummary)`, so it
 * would overwrite the target's own topics and recap. Here the target's
 * generated content wins and only the tree and the hoisted refs come across.
 *
 * Uses the same lock wrapper as every other orphan write. The caller must NOT
 * hold the lock — a nested acquire self-blocks and reports contention while
 * the write silently never lands.
 */
export async function remountStrandedTree(
	target: CommitSummary,
	strandedRoot: CommitSummary,
	cwd?: string,
	storage?: StorageProvider,
): Promise<void> {
	if ((target.children ?? []).length > 0) {
		throw new Error(`target ${target.commitHash.substring(0, 8)} already has children — refusing to clobber`);
	}
	if (isManuallyDisabled()) return;
	const merged: CommitSummary = {
		...target,
		...copyHoistFields(strandedRoot),
		children: [strandedRoot],
	};
	await withRequiredOrphanWriteLock(cwd, "remountStrandedTree", () =>
		storeSummaryLocked(merged, cwd, true, undefined, storage),
	);
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SummaryStore.remount.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 11: Commit**

```bash
git add cli/src/core/SummaryStore.ts cli/src/core/SummaryStore.remount.test.ts
git commit -s -m "feat(repair): share the Copy-Hoist field set and add remountStrandedTree"
```

---

### Task 5: Extract the squash consolidation pipeline

**Files:**
- Create: `cli/src/core/SquashConsolidation.ts`
- Modify: `cli/src/hooks/QueueWorker.ts` (`runSquashPipeline` delegates)
- Test: `cli/src/core/SquashConsolidation.test.ts`

**Interfaces:**
- Consumes: `generateSquashConsolidation(params: SquashConsolidationParams): Promise<SquashConsolidationOutcome>` from `cli/src/core/Summarizer.js`; `expandSourcesForConsolidation`, `ConsolidatedTopics` from `cli/src/core/SummaryStore.js`
- Produces:
  ```ts
  export type ConsolidationFailurePolicy = "mechanical" | "throw";
  export async function consolidateSquashSources(
      oldSummaries: ReadonlyArray<CommitSummary>,
      commitMessage: string,
      opts: { readonly onFailure: ConsolidationFailurePolicy; readonly useLlm: boolean },
  ): Promise<(ConsolidatedTopics & { readonly status: "llm" | "mechanical" }) | undefined>
  ```

The two callers need **different failure policies**, and that difference is the reason for the seam rather than an afterthought:

- `QueueWorker` runs at commit time, fire-and-forget, with no retry — losing the memory is unacceptable, so a failed LLM call must degrade to `mechanicalConsolidate`.
- `repair-memory` is interactive and re-runnable — per the spec it must **throw** and point the user at `--no-llm`, because a silent downgrade produces content that looks fine and is worse.

`useLlm: false` skips the call entirely and returns the mechanical result (that is what `--no-llm` selects); it is not a failure path.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../Types.js";

vi.mock("./Summarizer.js", () => ({
	generateSquashConsolidation: vi.fn(),
}));

const { generateSquashConsolidation } = await import("./Summarizer.js");
const { consolidateSquashSources } = await import("./SquashConsolidation.js");

function src(hash: string): CommitSummary {
	return {
		version: 5,
		commitHash: hash,
		commitMessage: `m ${hash}`,
		commitAuthor: "T",
		commitDate: "2026-08-17T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T00:00:00.000Z",
		topics: [{ title: `t-${hash}` }],
		recap: `r-${hash}`,
	} as CommitSummary;
}

describe("consolidateSquashSources", () => {
	it("returns the LLM result when the call succeeds", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({
			status: "ok",
			topics: [{ title: "merged" }],
			recap: "merged recap",
			llm: { model: "m" },
		} as never);

		const out = await consolidateSquashSources([src("a"), src("b")], "squashed", {
			onFailure: "throw",
			useLlm: true,
		});
		expect(out?.status).toBe("llm");
		expect(out?.topics).toEqual([{ title: "merged" }]);
	});

	it("throws under the throw policy when the LLM errors", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({ status: "llm-error" } as never);

		await expect(
			consolidateSquashSources([src("a")], "squashed", { onFailure: "throw", useLlm: true }),
		).rejects.toThrow(/--no-llm/);
	});

	it("degrades to a mechanical merge under the mechanical policy", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({ status: "llm-error" } as never);

		const out = await consolidateSquashSources([src("a"), src("b")], "squashed", {
			onFailure: "mechanical",
			useLlm: true,
		});
		expect(out?.status).toBe("mechanical");
		expect(out?.topics.length).toBeGreaterThan(0);
	});

	it("never calls the LLM when useLlm is false", async () => {
		vi.mocked(generateSquashConsolidation).mockClear();
		const out = await consolidateSquashSources([src("a")], "squashed", {
			onFailure: "throw",
			useLlm: false,
		});
		expect(generateSquashConsolidation).not.toHaveBeenCalled();
		expect(out?.status).toBe("mechanical");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SquashConsolidation.test.ts`
Expected: FAIL — cannot resolve `./SquashConsolidation.js`

- [ ] **Step 3: Move the body out of `QueueWorker.runSquashPipeline`**

Create `cli/src/core/SquashConsolidation.ts` holding the consolidation half of `runSquashPipeline`: source expansion via `expandSourcesForConsolidation`, outer-ticket extraction via `extractTicketIdFromMessage`, and the `generateSquashConsolidation` call. Keep the source-state inheritance (`anySourceFailed` → `summaryError: LLM_FAILED`) exactly as it is — it is why a squash of a degraded input stays marked degraded.

**Do NOT move `mechanicalConsolidate`.** It is already exported from `cli/src/core/Summarizer.ts:1349`, which is where `QueueWorker` imports it from today — import it from there. Its real signature is:

```ts
mechanicalConsolidate(sources: ReadonlyArray<SquashConsolidationSource>, outerTicketId?: string): {
	topics: ReadonlyArray<TopicSummary>;
	recap?: string;
	ticketId?: string;
}
```

Note it takes `outerTicketId` as its second argument — **not** a boolean — and returns no `status` field, so the wrapper attaches `status` and the error marker:

```ts
function mechanical(
	sources: ReadonlyArray<SquashConsolidationSource>,
	outerTicketId: string | undefined,
	anySourceFailed: boolean,
): ConsolidatedTopics & { readonly status: "mechanical" } {
	return {
		...mechanicalConsolidate(sources, outerTicketId),
		status: "mechanical",
		...(anySourceFailed && { summaryError: LLM_FAILED }),
	};
}
```

The policy branch:

```ts
if (outcome.status !== "ok") {
	if (opts.onFailure === "throw") {
		throw new Error(
			`squash consolidation failed (${outcome.status}) — re-run with --no-llm to merge mechanically instead`,
		);
	}
	return mechanical(sources, outerTicketId, anySourceFailed);
}
```

`useLlm: false` returns `mechanical(...)` without calling `generateSquashConsolidation` at all.

- [ ] **Step 4: Make `QueueWorker.runSquashPipeline` delegate**

Replace the moved block with a call passing the commit-time policy:

```ts
const consolidated = await consolidateSquashSources(oldSummaries, commitInfo.message, {
	onFailure: "mechanical",
	useLlm: true,
});
```

Leave everything else in `runSquashPipeline` (the `clearAiSelection` call, the `mergeManyToOne` write) where it is.

- [ ] **Step 5: Run both suites**

Run: `npm run test -w @jolli.ai/cli -- src/core/SquashConsolidation.test.ts src/hooks/QueueWorker.test.ts`
Expected: PASS — the extraction must not change any existing QueueWorker assertion.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/SquashConsolidation.ts cli/src/core/SquashConsolidation.test.ts cli/src/hooks/QueueWorker.ts
git commit -s -m "refactor(squash): extract consolidation pipeline with a failure policy"
```

---

### Task 6: Repair plan and executor

**Files:**
- Create: `cli/src/core/repair/RepairPlan.ts`
- Create: `cli/src/core/repair/RepairExecutor.ts`
- Test: `cli/src/core/repair/RepairPlan.test.ts`
- Test: `cli/src/core/repair/RepairExecutor.test.ts`

**Interfaces:**
- Consumes: `findStrandedRoots` (Task 2), `pairStrandedHash` (Task 3), `remountStrandedTree` + `copyHoistFields` (Task 4), `consolidateSquashSources` (Task 5), `migrateOneToOne` / `mergeManyToOne` from `SummaryStore.js`, `getCommitInfo` from `cli/src/core/GitOps.js`
- Produces:
  ```ts
  export type RepairAction =
      | { readonly kind: "migrate"; readonly targetHash: string; readonly sources: ReadonlyArray<StrandedTree>; readonly needsLlm: boolean }
      | { readonly kind: "remount"; readonly targetHash: string; readonly source: StrandedTree }
      | { readonly kind: "unpaired"; readonly source: StrandedTree; readonly reason: "none" | "conflict" };
  export interface PlanDeps {
      readonly stranded?: ReadonlyArray<StrandedTree>;
      readonly pair?: (oldHash: string, cwd: string) => Promise<PairingResult>;
      readonly targetHasMemory?: (hash: string, cwd: string) => Promise<boolean>;
  }
  export async function buildRepairPlan(
      cwd: string,
      override?: { readonly from: string; readonly to: string },
      deps?: PlanDeps,
  ): Promise<ReadonlyArray<RepairAction>>

  export interface RepairOutcome { readonly action: RepairAction; readonly ok: boolean; readonly error?: string }
  export interface ExecutorDeps {
      readonly useLlm: boolean;
      readonly remount?: (target: CommitSummary, stranded: CommitSummary, cwd: string) => Promise<void>;
      readonly readTarget?: (hash: string, cwd: string) => Promise<CommitSummary | undefined>;
  }
  export async function executeRepairs(
      actions: ReadonlyArray<RepairAction>,
      cwd: string,
      opts: ExecutorDeps,
  ): Promise<ReadonlyArray<RepairOutcome>>
  ```

  The injectable `deps` / `opts` collaborators default to the real implementations; they exist so these two modules' tests stay in the fast tier (no real git, no real storage).

Dispatch rule: group stranded roots by paired target. For a target with **no stored memory** → `migrate` (one source → `migrateOneToOne`; several → `mergeManyToOne`, `needsLlm: true`). For a target that **already has** a memory → `remount`, and `needsLlm` is always false.

- [ ] **Step 1: Write the failing plan test**

```ts
import { describe, expect, it } from "vitest";
import { buildRepairPlan } from "./RepairPlan.js";

describe("buildRepairPlan", () => {
	it("plans a remount when the target already has a memory", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [{ oldHash: "old", root: { commitHash: "old" }, conversationCount: 26, skillCount: 7 }] as never,
			pair: async () => ({ kind: "paired", newHash: "new" }),
			targetHasMemory: async () => true,
		});
		expect(plan).toEqual([
			{ kind: "remount", targetHash: "new", source: expect.objectContaining({ oldHash: "old" }) },
		]);
	});

	it("plans a migrate when the target has no memory", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [{ oldHash: "old", root: { commitHash: "old" }, conversationCount: 0, skillCount: 0 }] as never,
			pair: async () => ({ kind: "paired", newHash: "new" }),
			targetHasMemory: async () => false,
		});
		expect(plan[0]).toMatchObject({ kind: "migrate", targetHash: "new", needsLlm: false });
	});

	it("marks a multi-source migrate as needing an LLM call", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [
				{ oldHash: "a", root: { commitHash: "a" }, conversationCount: 0, skillCount: 0 },
				{ oldHash: "b", root: { commitHash: "b" }, conversationCount: 0, skillCount: 0 },
			] as never,
			pair: async () => ({ kind: "paired", newHash: "new" }),
			targetHasMemory: async () => false,
		});
		expect(plan).toHaveLength(1);
		expect(plan[0]).toMatchObject({ kind: "migrate", needsLlm: true });
	});

	// Idempotency: after a repair the old root is no longer a root, so
	// findStrandedRoots stops returning it and a re-run plans nothing.
	it("plans nothing when no root is stranded", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [],
			pair: async () => ({ kind: "none" }),
			targetHasMemory: async () => true,
		});
		expect(plan).toEqual([]);
	});

	it("reports an unpaired source instead of guessing", async () => {
		const plan = await buildRepairPlan("/repo", undefined, {
			stranded: [{ oldHash: "a", root: { commitHash: "a" }, conversationCount: 0, skillCount: 0 }] as never,
			pair: async () => ({ kind: "conflict", candidates: ["x", "y"] }),
			targetHasMemory: async () => false,
		});
		expect(plan[0]).toMatchObject({ kind: "unpaired", reason: "conflict" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/RepairPlan.test.ts`
Expected: FAIL — cannot resolve `./RepairPlan.js`

- [ ] **Step 3: Implement `buildRepairPlan`**

```ts
export async function buildRepairPlan(
	cwd: string,
	override?: { readonly from: string; readonly to: string },
	deps: PlanDeps = {},
): Promise<ReadonlyArray<RepairAction>> {
	const pair = deps.pair ?? ((hash: string, dir: string) => pairStrandedHash(hash, dir));
	const targetHasMemory = deps.targetHasMemory ?? defaultTargetHasMemory;
	const stranded = deps.stranded ?? (await findStrandedRoots(cwd));

	// Explicit override: trust the user, skip detection and pairing entirely.
	if (override) {
		const source = stranded.find((s) => s.oldHash.startsWith(override.from));
		if (!source) throw new Error(`no stranded memory tree found for ${override.from}`);
		return [await actionFor(override.to, [source], cwd, targetHasMemory)];
	}

	// Group by paired target: several sources landing on one target IS a squash.
	const byTarget = new Map<string, StrandedTree[]>();
	const unpaired: RepairAction[] = [];
	for (const source of stranded) {
		const result = await pair(source.oldHash, cwd);
		if (result.kind === "paired") {
			const group = byTarget.get(result.newHash) ?? [];
			group.push(source);
			byTarget.set(result.newHash, group);
		} else {
			unpaired.push({ kind: "unpaired", source, reason: result.kind });
		}
	}

	const actions: RepairAction[] = [];
	for (const [targetHash, sources] of byTarget) {
		actions.push(await actionFor(targetHash, sources, cwd, targetHasMemory));
	}
	return [...actions, ...unpaired];
}

async function actionFor(
	targetHash: string,
	sources: ReadonlyArray<StrandedTree>,
	cwd: string,
	targetHasMemory: (hash: string, cwd: string) => Promise<boolean>,
): Promise<RepairAction> {
	// A target that already has a memory must keep its own topics/recap, which
	// migrateOneToOne would overwrite — hence remount. Remount never calls an LLM.
	if (await targetHasMemory(targetHash, cwd)) {
		const source = sources[0] as StrandedTree;
		return { kind: "remount", targetHash, source };
	}
	return { kind: "migrate", targetHash, sources, needsLlm: sources.length > 1 };
}
```

`defaultTargetHasMemory` reads `summaries/<hash>.json` through the storage `resolveReadStorage(undefined, cwd)` returns, and answers `false` when the read yields `null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/RepairPlan.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing executor test**

```ts
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeRepairs } from "./RepairExecutor.js";

describe("executeRepairs", () => {
	it("backs up each affected root before writing", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const remount = vi.fn(async () => undefined);
		await executeRepairs(
			[{ kind: "remount", targetHash: "new", source: { oldHash: "old", root: { commitHash: "old" } } }] as never,
			cwd,
			{ useLlm: true, remount, readTarget: async () => ({ commitHash: "new" }) as never },
		);
		const dirs = await readdir(join(cwd, ".jolli", "jollimemory", "repair-backups"));
		expect(dirs).toHaveLength(1);
		await rm(cwd, { recursive: true, force: true });
	});

	it("keeps going after one action fails and reports both", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const remount = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(undefined);
		const outcomes = await executeRepairs(
			[
				{ kind: "remount", targetHash: "n1", source: { oldHash: "o1", root: { commitHash: "o1" } } },
				{ kind: "remount", targetHash: "n2", source: { oldHash: "o2", root: { commitHash: "o2" } } },
			] as never,
			cwd,
			{ useLlm: true, remount, readTarget: async () => ({ commitHash: "n" }) as never },
		);
		expect(outcomes.map((o) => o.ok)).toEqual([false, true]);
		expect(outcomes[0]?.error).toMatch(/boom/);
		await rm(cwd, { recursive: true, force: true });
	});

	it("skips an unpaired action without touching storage", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "jolli-exec-"));
		const remount = vi.fn();
		const outcomes = await executeRepairs(
			[{ kind: "unpaired", source: { oldHash: "o" }, reason: "none" }] as never,
			cwd,
			{ useLlm: true, remount, readTarget: async () => undefined },
		);
		expect(remount).not.toHaveBeenCalled();
		expect(outcomes[0]?.ok).toBe(false);
		await rm(cwd, { recursive: true, force: true });
	});
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/RepairExecutor.test.ts`
Expected: FAIL — cannot resolve `./RepairExecutor.js`

- [ ] **Step 7: Implement `executeRepairs`**

```ts
export async function executeRepairs(
	actions: ReadonlyArray<RepairAction>,
	cwd: string,
	opts: ExecutorDeps,
): Promise<ReadonlyArray<RepairOutcome>> {
	const remount = opts.remount ?? ((t, s, dir) => remountStrandedTree(t, s, dir));
	const readTarget = opts.readTarget ?? defaultReadTarget;
	const backupDir = join(getJolliMemoryDir(cwd), "repair-backups", new Date().toISOString().replace(/[:.]/g, "-"));
	const outcomes: RepairOutcome[] = [];

	// NO outer lock: every write path below takes withRequiredOrphanWriteLock
	// itself, and a nested acquire self-blocks — it polls out the full budget
	// and then reports contention while the write silently never lands.
	for (const action of actions) {
		if (action.kind === "unpaired") {
			outcomes.push({
				action,
				ok: false,
				error: `no repair target for ${action.source.oldHash.substring(0, 8)} (${action.reason})`,
			});
			continue;
		}
		try {
			await backupBeforeWrite(backupDir, action, cwd, readTarget);
			if (action.kind === "remount") {
				const target = await readTarget(action.targetHash, cwd);
				if (!target) throw new Error(`target ${action.targetHash.substring(0, 8)} has no stored memory`);
				await remount(target, action.source.root, cwd);
			} else {
				await executeMigrate(action, cwd, opts.useLlm);
			}
			outcomes.push({ action, ok: true });
		} catch (err) {
			outcomes.push({ action, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return outcomes;
}

async function executeMigrate(
	action: Extract<RepairAction, { kind: "migrate" }>,
	cwd: string,
	useLlm: boolean,
): Promise<void> {
	const commitInfo = await getCommitInfo(action.targetHash, cwd);
	const sources = action.sources.map((s) => s.root);
	if (sources.length === 1) {
		await migrateOneToOne(sources[0] as CommitSummary, commitInfo, cwd, { commitType: "rebase" });
		return;
	}
	const consolidated = await consolidateSquashSources(sources, commitInfo.message, {
		onFailure: "throw",
		useLlm,
	});
	await mergeManyToOne(sources, commitInfo, cwd, { ...(consolidated && { consolidated }) });
}
```

`backupBeforeWrite` writes the target's current JSON (and each source root's) into `backupDir` before anything is overwritten — `storeSummary` overwrites and `SotWrite`'s upsert replaces `summary_json`, so there is no second copy otherwise. Import `getJolliMemoryDir` from `cli/src/Logger.js`.

Note `onFailure: "throw"` here is the repair-side policy from Task 5: a failed consolidation surfaces and points at `--no-llm`, it never silently degrades.

- [ ] **Step 8: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/repair/RepairExecutor.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add cli/src/core/repair/RepairPlan.ts cli/src/core/repair/RepairPlan.test.ts cli/src/core/repair/RepairExecutor.ts cli/src/core/repair/RepairExecutor.test.ts
git commit -s -m "feat(repair): plan and execute memory tree repairs"
```

---

### Task 7: CLI command and doctor check

**Files:**
- Create: `cli/src/commands/RepairMemoryCommand.ts`
- Test: `cli/src/commands/RepairMemoryCommand.test.ts`
- Modify: `cli/src/Api.ts` (import + `registerRepairMemoryCommand(program)` beside `registerCutoverCommand(program)` at line ~381)
- Modify: `cli/src/commands/DoctorCommand.ts` (add the `Memory tree` check)

**Interfaces:**
- Consumes: `buildRepairPlan`, `executeRepairs` (Task 6)
- Produces: `registerRepairMemoryCommand(program: Command): void`

Surface, mirroring `jolli cutover` / `cutover --status` (repair-by-default with an inspection flag) rather than `doctor` / `doctor --fix`:

```
jolli repair-memory
jolli repair-memory --status
jolli repair-memory --from <old> --to <new>
jolli repair-memory --no-llm
jolli repair-memory --cwd <dir>
```

- [ ] **Step 1: Write the failing test**

```ts
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/repair/RepairPlan.js", () => ({ buildRepairPlan: vi.fn() }));
vi.mock("../core/repair/RepairExecutor.js", () => ({ executeRepairs: vi.fn() }));

const { buildRepairPlan } = await import("../core/repair/RepairPlan.js");
const { executeRepairs } = await import("../core/repair/RepairExecutor.js");
const { registerRepairMemoryCommand } = await import("./RepairMemoryCommand.js");

function program(): Command {
	const p = new Command();
	p.exitOverride();
	registerRepairMemoryCommand(p);
	return p;
}

describe("repair-memory", () => {
	it("--status reports without executing", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{ kind: "remount", targetHash: "newhash1", source: { oldHash: "oldhash1", conversationCount: 26, skillCount: 7 } },
		] as never);
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await program().parseAsync(["node", "jolli", "repair-memory", "--status"]);

		expect(executeRepairs).not.toHaveBeenCalled();
		expect(log.mock.calls.flat().join("\n")).toMatch(/26 conversation/);
		log.mockRestore();
	});

	it("repairs by default", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{ kind: "remount", targetHash: "n", source: { oldHash: "o", conversationCount: 0, skillCount: 0 } },
		] as never);
		vi.mocked(executeRepairs).mockResolvedValue([{ action: { kind: "remount" }, ok: true }] as never);
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		await program().parseAsync(["node", "jolli", "repair-memory"]);

		expect(executeRepairs).toHaveBeenCalledOnce();
	});

	it("passes useLlm false for --no-llm", async () => {
		vi.mocked(buildRepairPlan).mockResolvedValue([
			{ kind: "migrate", targetHash: "n", sources: [], needsLlm: true },
		] as never);
		vi.mocked(executeRepairs).mockResolvedValue([{ action: { kind: "migrate" }, ok: true }] as never);
		vi.spyOn(console, "log").mockImplementation(() => undefined);

		await program().parseAsync(["node", "jolli", "repair-memory", "--no-llm"]);

		expect(vi.mocked(executeRepairs).mock.calls[0]?.[2]).toMatchObject({ useLlm: false });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/commands/RepairMemoryCommand.test.ts`
Expected: FAIL — cannot resolve `./RepairMemoryCommand.js`

- [ ] **Step 3: Implement the command**

```ts
export function registerRepairMemoryCommand(program: Command): void {
	program
		.command("repair-memory")
		.description("Reattach memory trees stranded by an amend, rebase or squash")
		.option("--status", "Show what would be repaired without changing anything")
		.option("--from <hash>", "Stranded commit hash (when the reflog cannot pair it)")
		.option("--to <hash>", "Target commit hash to reattach it under")
		.option("--no-llm", "Merge squashed sources mechanically instead of calling the LLM")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (opts) => {
			const cwd = opts.cwd as string;
			if ((opts.from === undefined) !== (opts.to === undefined)) {
				console.error("--from and --to must be given together");
				process.exitCode = 1;
				return;
			}
			const override = opts.from ? { from: opts.from as string, to: opts.to as string } : undefined;
			const plan = await buildRepairPlan(cwd, override);

			if (plan.length === 0) {
				console.log("No stranded memory trees.");
				return;
			}
			for (const action of plan) console.log(describeAction(action));

			// `--no-llm` arrives from commander as `llm: false`.
			if (opts.status) return;

			const outcomes = await executeRepairs(plan, cwd, { useLlm: opts.llm !== false });
			for (const outcome of outcomes) {
				console.log(outcome.ok ? `✓ ${describeAction(outcome.action)}` : `✗ ${outcome.error}`);
			}
			if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
		});
}

function describeAction(action: RepairAction): string {
	if (action.kind === "unpaired") {
		return `${action.source.oldHash.substring(0, 8)}: no target (${action.reason}) — pass --from/--to`;
	}
	if (action.kind === "remount") {
		const { oldHash, conversationCount, skillCount } = action.source;
		return `remount ${oldHash.substring(0, 8)} → ${action.targetHash.substring(0, 8)}: restores ${conversationCount} conversation(s), ${skillCount} skill(s)`;
	}
	const conversations = action.sources.reduce((n, s) => n + s.conversationCount, 0);
	const skills = action.sources.reduce((n, s) => n + s.skillCount, 0);
	const llm = action.needsLlm ? " [calls the LLM]" : "";
	return `migrate ${action.sources.length} source(s) → ${action.targetHash.substring(0, 8)}: restores ${conversations} conversation(s), ${skills} skill(s)${llm}`;
}
```

Import `resolveProjectDir` the same way `CutoverCommand.ts` does. Note commander maps `--no-llm` onto `opts.llm === false`, not `opts.noLlm`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/commands/RepairMemoryCommand.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register in `Api.ts`**

```ts
import { registerRepairMemoryCommand } from "./commands/RepairMemoryCommand.js";
```

and beside the other registrations:

```ts
	registerRepairMemoryCommand(program);
```

- [ ] **Step 6: Add the doctor check**

In `runDoctor`, after the `Orphan branch` check, push:

```ts
	const stranded = await findStrandedRoots(cwd).catch(() => []);
	checks.push({
		name: "Memory tree",
		status: stranded.length === 0 ? "ok" : "warn",
		message:
			stranded.length === 0
				? "no stranded trees"
				: `${stranded.length} stranded tree(s) — run \`jolli repair-memory\` to reattach`,
	});
```

`doctor --fix` must NOT repair this. Every other `--fix` repair is instant, free and idempotent; memory repair can cost money, take tens of seconds and fail, and folding it in would make running `doctor` a risky act.

- [ ] **Step 7: Run the doctor suite**

Run: `npm run test -w @jolli.ai/cli -- src/commands/DoctorCommand.test.ts`
Expected: PASS — add a case asserting the check reports `warn` with a non-empty stranded list and that `--fix` leaves it untouched.

- [ ] **Step 8: Run the full gate**

Run: `npm run all`
Expected: PASS — clean → build → typecheck → lint → test, with CLI coverage at or above 97/96/97/97.

- [ ] **Step 9: Commit**

```bash
git add cli/src/commands/RepairMemoryCommand.ts cli/src/commands/RepairMemoryCommand.test.ts cli/src/commands/DoctorCommand.ts cli/src/commands/DoctorCommand.test.ts cli/src/Api.ts
git commit -s -m "feat(repair): add jolli repair-memory and the doctor Memory tree check"
```

---

## Verification against the original incident

After Task 7, this sequence must reproduce the manual recovery:

1. A branch whose HEAD was amended while the memory migration did not run.
2. `jolli repair-memory --status` reports one `remount` naming the target and the conversation / skill counts it will restore.
3. `jolli repair-memory` reattaches the tree; the target keeps its own topics and recap.
4. A second `jolli repair-memory` is a no-op — the old root is no longer a root, so detection no longer matches it.
5. Switching to another branch and re-running reports nothing, because reachability is measured against **any ref**, not HEAD.

Step 5 is the regression guard for the predicate: a HEAD-based reachability test passes every other check in this plan and fails only here.
