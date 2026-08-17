# Claude Multi-Owner Session Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Claude session be attributed to several worktrees and repositories, so a commit made from a checkout the session merely *touched* still stores its own transcript slice instead of `transcripts: []` — plus a bounded repair path for summaries already written empty.

**Architecture:** A machine-global Claude ownership ledger (`~/.jolli/jollimemory/claude-owners.json`) records, per session, one edge per worktree root the transcript's `cwd` lines prove it visited. The Stop hook fills it as a fourth `discovery-cursors.json` extractor (`owners`, its own high-water mark). QueueWorker merges ledger candidates for the current worktree root into `sessions.json`'s list, and — the load-bearing rule — seeds the *lower bound* of a first read from that owner's `firstSeenLine` instead of `0`. Phase 2 adds `jolli doctor --repair-transcripts`, which replays the same bounded window for historical empty summaries, and a three-state memory-detail copy across the four surfaces that render it.

**Tech Stack:** TypeScript (ESM, Node ≥22.13), Vitest, Biome (tabs, 120 cols); Kotlin/Gradle for the IntelliJ copy string.

**Spec:** [`docs/superpowers/specs/2026-08-17-claude-multi-owner-session-attribution-design.md`](../specs/2026-08-17-claude-multi-owner-session-attribution-design.md)

## Global Constraints

- **Ledger location is machine-global**, `~/.jolli/jollimemory/claude-owners.json`. Resolved via `getGlobalConfigDir()`. The spec's §5 phrase "under `.jolli/jollimemory`" is realised as the *global* dir, not the per-worktree one: a per-worktree ledger can only ever hold what that worktree's own Stop hook saw, which is the same information as its `sessions.json`, so it would fix nothing.
- **Every owner root — written or looked up — goes through `resolveStateRoot()`** (`core/GitOps.ts`), which realpaths and forward-slashes. The Stop hook already anchors that way; QueueWorker's `cwd` is git's hook cwd and is NOT anchored, so on macOS it can read `/var/…` where the ledger holds `/private/var/…`. An unnormalised lookup misses every edge and the whole feature silently does nothing.
- **Line numbers are counted by `splitTranscriptLines`** (`core/TranscriptReader.ts`) and nothing else. `firstSeenLine` becomes a cursor `lineNumber`, and `discovery-cursors.json` is monotonic — a definition that disagreed by one blank line strands records permanently rather than failing.
- **The `owners` extractor rides its own high-water mark** in `discovery-cursors.json`, never the shared `lineNumber`. Follow `scanSkillsWithCursor`'s three-step protocol (load mark → scan → advance only when it moved) exactly; never advance on a throw.
- **Ledger updates are set-union / max-progress only** (spec §6.1). A later pass may extend an edge; it may never reset `firstSeenAt` / `firstSeenLine`.
- **Repair prefers a false negative** (spec §8.3). Every refusal rule returns "did not repair", never a partial write.
- **No non-Claude source changes in this slice** (spec §2.2, §11).
- **Coverage floor for `cli/src/`**: 97% statements / 96% branches / 97% functions / 97% lines ([`cli/vite.config.ts`](../../cli/vite.config.ts)). New modules need real tests, not smoke tests.
- **Biome**: tabs, 4-wide, 120 columns, `noExplicitAny: error`, `noUnusedImports/Variables: error`. CI runs `biome check --error-on-warnings`.
- **Commit discipline**: `git commit -s` (DCO). No `Co-Authored-By: Claude …`, no `🤖 Generated with …`.
- **Per this repo's working preference, tasks below contain NO commit step and NO full-gate step.** Write the test, write the implementation, move on. Task 11 runs `npm run all` once and makes the commits. While iterating inside a task you may of course run that one test file (`npm run test -w @jolli.ai/cli -- <file>`); just don't wire it in as a plan step.

---

## File Structure

**New (CLI):**
- `cli/src/core/ClaudeOwnership.ts` — the ledger: types, load, upsert, per-owner query. Storage only; knows nothing about transcripts.
- `cli/src/core/ClaudeOwnership.test.ts`
- `cli/src/core/ClaudeOwnerScan.ts` — transcript-window → owner edges. Parsing only; knows nothing about JSON files.
- `cli/src/core/ClaudeOwnerScan.test.ts`
- `cli/src/core/TranscriptRepair.ts` — Phase 2 repair engine + the shared repairability predicate the four UI surfaces consume.
- `cli/src/core/TranscriptRepair.test.ts`

**Modified (CLI):**
- `cli/src/Types.ts` — `DiscoveryExtractor` gains `"owners"`; `CommitSummary` gains `transcriptsRepairedAt?`.
- `cli/src/core/Locks.ts` — `withClaudeOwnersLock`.
- `cli/src/hooks/StopHook.ts` — call `scanOwnersWithCursor` in `discoverFromTranscript`.
- `cli/src/hooks/QueueWorker.ts` — ledger candidate merge in `loadSessionTranscripts`; owner seed in `readAllTranscripts`.
- `cli/src/commands/DoctorCommand.ts` — `--repair-transcripts`.
- `cli/src/commands/IdeBridgeCommand.ts` — `transcript-repair-state` action.
- `cli/src/dashboard/assets/js/memories.js` — three-state copy.

**Modified (hosts):**
- `vscode/src/views/SummaryScriptBuilder.ts` — three-state copy (2 sites).
- `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/views/SummaryHtmlBuilder.kt` — three-state copy.
- `intellij/src/main/kotlin/ai/jolli/jollimemory/core/TranscriptRepairState.kt` (new) — bridge adapter.

Split rationale: the ledger's failure mode is concurrent JSON read-modify-write; the scan's is line counting and `cwd` attribution. They fail differently, are tested differently, and only the scan needs transcript fixtures — so they are separate files even though Phase 1 always uses them together.

---

## Phase 1 — Forward fix

### Task 1: Ownership ledger storage

**Files:**
- Create: `cli/src/core/ClaudeOwnership.ts`
- Create: `cli/src/core/ClaudeOwnership.test.ts`
- Modify: `cli/src/core/Locks.ts` (add `withClaudeOwnersLock` beside `withRepoRegistryLock`)

**Interfaces:**
- Consumes: `getGlobalConfigDir()` from `core/SessionTracker.js`, `atomicWriteFile` from `core/AtomicWrite.js`, `resolveStateRoot` from `core/GitOps.js`.
- Produces:
  - `interface ClaudeOwnerEdge { readonly firstSeenAt: string; readonly firstSeenLine: number; readonly lastSeenAt: string; readonly firstSeenCwd?: string; readonly lastSeenCwd?: string }`
  - `interface ClaudeOwnedSession { readonly sessionId: string; readonly transcriptPath: string; readonly source: "claude"; readonly owners: Readonly<Record<string, ClaudeOwnerEdge>> }`
  - `interface ClaudeOwnersLedger { readonly version: 1; readonly sessions: Readonly<Record<string, ClaudeOwnedSession>> }`
  - `claudeOwnersPath(globalDir?: string): string`
  - `loadClaudeOwners(globalDir?: string): Promise<ClaudeOwnersLedger>`
  - `recordClaudeOwners(input: { sessionId: string; transcriptPath: string; edges: ReadonlyMap<string, ClaudeOwnerEdge> }, globalDir?: string): Promise<void>`
  - `claudeSessionsOwnedBy(ownerRoot: string, globalDir?: string): Promise<ReadonlyArray<{ sessionId: string; transcriptPath: string; edge: ClaudeOwnerEdge }>>`
  - `withClaudeOwnersLock<T>(fn: () => Promise<T>, opts?: { timeoutMs?: number; pollMs?: number; globalDir?: string }): Promise<T>`

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/ClaudeOwnership.test.ts`:

```typescript
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type ClaudeOwnerEdge,
	claudeSessionsOwnedBy,
	loadClaudeOwners,
	recordClaudeOwners,
} from "./ClaudeOwnership.js";

let dir: string;

function edge(over: Partial<ClaudeOwnerEdge> = {}): ClaudeOwnerEdge {
	return {
		firstSeenAt: "2026-08-17T10:00:00.000Z",
		firstSeenLine: 12,
		lastSeenAt: "2026-08-17T10:05:00.000Z",
		...over,
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-owners-"));
});

describe("ClaudeOwnership", () => {
	it("returns an empty ledger when the file does not exist", async () => {
		expect(await loadClaudeOwners(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("returns an empty ledger for unparseable JSON rather than throwing", async () => {
		await writeFile(join(dir, "claude-owners.json"), "{ not json", "utf-8");
		expect(await loadClaudeOwners(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("records one session under two owner roots", async () => {
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([
					["/repo/a", edge({ firstSeenLine: 0 })],
					["/repo/b", edge({ firstSeenLine: 412 })],
				]),
			},
			dir,
		);
		const ledger = await loadClaudeOwners(dir);
		expect(Object.keys(ledger.sessions)).toEqual(["claude:s1"]);
		expect(Object.keys(ledger.sessions["claude:s1"].owners).sort()).toEqual(["/repo/a", "/repo/b"]);
	});

	it("extends an existing edge without resetting its first-seen position", async () => {
		await recordClaudeOwners(
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/a", edge({ firstSeenLine: 12 })]]) },
			dir,
		);
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([
					[
						"/repo/a",
						edge({
							firstSeenAt: "2026-08-17T11:00:00.000Z",
							firstSeenLine: 900,
							lastSeenAt: "2026-08-17T11:00:00.000Z",
							lastSeenCwd: "/repo/a/sub",
						}),
					],
				]),
			},
			dir,
		);
		const owners = (await loadClaudeOwners(dir)).sessions["claude:s1"].owners;
		expect(owners["/repo/a"].firstSeenLine).toBe(12);
		expect(owners["/repo/a"].firstSeenAt).toBe("2026-08-17T10:00:00.000Z");
		expect(owners["/repo/a"].lastSeenAt).toBe("2026-08-17T11:00:00.000Z");
		expect(owners["/repo/a"].lastSeenCwd).toBe("/repo/a/sub");
	});

	it("adds a new owner to a session that already has one", async () => {
		await recordClaudeOwners(
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/a", edge()]]) },
			dir,
		);
		await recordClaudeOwners(
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/b", edge({ firstSeenLine: 77 })]]) },
			dir,
		);
		const owners = (await loadClaudeOwners(dir)).sessions["claude:s1"].owners;
		expect(Object.keys(owners).sort()).toEqual(["/repo/a", "/repo/b"]);
		expect(owners["/repo/b"].firstSeenLine).toBe(77);
	});

	it("queries sessions by owner root and ignores other owners' sessions", async () => {
		await recordClaudeOwners(
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/a", edge({ firstSeenLine: 5 })]]) },
			dir,
		);
		await recordClaudeOwners(
			{ sessionId: "s2", transcriptPath: "/t/s2.jsonl", edges: new Map([["/repo/b", edge()]]) },
			dir,
		);
		const mine = await claudeSessionsOwnedBy("/repo/a", dir);
		expect(mine).toEqual([{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edge: expect.objectContaining({ firstSeenLine: 5 }) }]);
	});

	it("writes valid JSON that a second load round-trips", async () => {
		await recordClaudeOwners(
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/a", edge()]]) },
			dir,
		);
		const raw = await readFile(join(dir, "claude-owners.json"), "utf-8");
		expect(JSON.parse(raw)).toEqual(await loadClaudeOwners(dir));
	});

	it("records nothing when the edge map is empty", async () => {
		await recordClaudeOwners({ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map() }, dir);
		expect(await loadClaudeOwners(dir)).toEqual({ version: 1, sessions: {} });
	});
});
```

- [ ] **Step 2: Add the lock**

In `cli/src/core/Locks.ts`, beside `withRepoRegistryLock`, add the constant with the other lock-file names and the function:

```typescript
/** Serialises read-modify-write of the machine-global `claude-owners.json`. */
const CLAUDE_OWNERS_LOCK_FILE = "claude-owners.lock";

/**
 * Serialises the read-modify-write of `claude-owners.json` across every repo's
 * Stop hook on this machine. Same shape and same reasoning as
 * {@link withRepoRegistryLock}: one machine-global JSON file whose whole-object
 * overwrite would otherwise let a stale reader drop a peer's freshly-written
 * owner edge.
 *
 * Best-effort — on timeout `fn` runs unlocked rather than dropping an edge.
 * Losing an edge is what this whole feature exists to prevent; a rare clobber
 * is recovered by the next Stop hook, since the scan is idempotent from its own
 * high-water mark.
 */
export async function withClaudeOwnersLock<T>(fn: () => Promise<T>, opts: RepoRegistryLockOpts = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_REPO_REGISTRY_LOCK_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_PROFILE_LOCK_POLL_MS;
	const dir = opts.globalDir ?? join(homedir(), ".jolli", "jollimemory");
	await mkdir(dir, { recursive: true });
	const lockPath = join(dir, CLAUDE_OWNERS_LOCK_FILE);
	const acquired = await acquireWithPoll(lockPath, { timeoutMs, pollMs });
	if (!acquired) {
		log.warn(
			"withClaudeOwnersLock: could not acquire %s within %d ms — proceeding best-effort",
			CLAUDE_OWNERS_LOCK_FILE,
			timeoutMs,
		);
	}
	try {
		return await fn();
	} finally {
		if (acquired) await releaseIfOwned(lockPath, CLAUDE_OWNERS_LOCK_FILE);
	}
}
```

- [ ] **Step 3: Write `ClaudeOwnership.ts`**

```typescript
/**
 * Claude ownership ledger — which worktree roots a Claude session actually
 * visited, and where in the transcript each of them first appeared.
 *
 * MACHINE-GLOBAL on purpose (`~/.jolli/jollimemory/claude-owners.json`). The
 * question it answers is asked by a worktree that never ran the session: Claude
 * was launched in checkout A, the user `cd`-ed into checkout B mid-conversation,
 * and the commit lands in B. B's own `.jolli/jollimemory/` holds nothing about
 * that session — its Stop hook never fired — so a per-worktree ledger would be
 * a second copy of `sessions.json` and would fix nothing. One shared file lets
 * A's hook record B's edge and B's post-commit read find it.
 *
 * Storage only. What counts as a `cwd`, and which line it was first seen on,
 * is {@link ClaudeOwnerScan}'s job.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, errMsg } from "../Logger.js";
import { atomicWriteFile } from "./AtomicWrite.js";
import { withClaudeOwnersLock } from "./Locks.js";
import { getGlobalConfigDir } from "./SessionTracker.js";

const log = createLogger("ClaudeOwnership");

const CLAUDE_OWNERS_FILE = "claude-owners.json";

/** One worktree root's participation in one Claude session. */
export interface ClaudeOwnerEdge {
	readonly firstSeenAt: string;
	/**
	 * Line index (against `splitTranscriptLines`) of the first line whose `cwd`
	 * belonged to this owner. Becomes a cursor lower bound, so it must never be
	 * re-derived with a different notion of "line N".
	 */
	readonly firstSeenLine: number;
	readonly lastSeenAt: string;
	readonly firstSeenCwd?: string;
	readonly lastSeenCwd?: string;
}

export interface ClaudeOwnedSession {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly source: "claude";
	readonly owners: Readonly<Record<string, ClaudeOwnerEdge>>;
}

export interface ClaudeOwnersLedger {
	readonly version: 1;
	readonly sessions: Readonly<Record<string, ClaudeOwnedSession>>;
}

const EMPTY: ClaudeOwnersLedger = { version: 1, sessions: {} };

export function claudeOwnersPath(globalDir?: string): string {
	return join(globalDir ?? getGlobalConfigDir(), CLAUDE_OWNERS_FILE);
}

function sessionKey(sessionId: string): string {
	return `claude:${sessionId}`;
}

/**
 * Reads the ledger. A missing or unparseable file reads as empty: this is
 * consulted from the post-commit path, where throwing would take the whole
 * summary down over a state file that the next Stop hook rewrites anyway.
 */
export async function loadClaudeOwners(globalDir?: string): Promise<ClaudeOwnersLedger> {
	try {
		const raw = JSON.parse(await readFile(claudeOwnersPath(globalDir), "utf-8")) as Partial<ClaudeOwnersLedger>;
		if (!raw || typeof raw !== "object" || typeof raw.sessions !== "object" || raw.sessions === null) return EMPTY;
		return { version: 1, sessions: raw.sessions };
	} catch (err) {
		log.debug("claude-owners.json unreadable (%s) — treating as empty", errMsg(err));
		return EMPTY;
	}
}

/**
 * Folds `edges` into the ledger. Set-union / max-progress ONLY (spec §6.1): an
 * existing edge keeps its `firstSeenAt` / `firstSeenLine` / `firstSeenCwd` and
 * takes the newer `lastSeenAt` / `lastSeenCwd`. A later pass extends an edge; it
 * never rewinds one, because the first-seen position is the lower bound a future
 * commit will read from and moving it forward would silently skip that owner's
 * earliest turns.
 */
export async function recordClaudeOwners(
	input: {
		readonly sessionId: string;
		readonly transcriptPath: string;
		readonly edges: ReadonlyMap<string, ClaudeOwnerEdge>;
	},
	globalDir?: string,
): Promise<void> {
	if (input.edges.size === 0) return;
	await withClaudeOwnersLock(async () => {
		// Read inside the lock: a snapshot taken before it would merge a peer's
		// write away, which is the exact race the lock exists for.
		const ledger = await loadClaudeOwners(globalDir);
		const key = sessionKey(input.sessionId);
		const existing = ledger.sessions[key];
		const owners: Record<string, ClaudeOwnerEdge> = { ...(existing?.owners ?? {}) };
		for (const [root, incoming] of input.edges) {
			const prior = owners[root];
			owners[root] = prior
				? {
						...prior,
						lastSeenAt: incoming.lastSeenAt > prior.lastSeenAt ? incoming.lastSeenAt : prior.lastSeenAt,
						...(incoming.lastSeenCwd !== undefined ? { lastSeenCwd: incoming.lastSeenCwd } : {}),
					}
				: incoming;
		}
		const next: ClaudeOwnersLedger = {
			version: 1,
			sessions: {
				...ledger.sessions,
				[key]: { sessionId: input.sessionId, transcriptPath: input.transcriptPath, source: "claude", owners },
			},
		};
		await atomicWriteFile(claudeOwnersPath(globalDir), JSON.stringify(next, null, "\t"));
	}, globalDir === undefined ? {} : { globalDir });
}

/**
 * Every Claude session this worktree root is an owner of, with that root's own
 * edge. Callers MUST pass a `resolveStateRoot()`-normalised root — the keys were
 * written that way, and a raw `process.cwd()` on macOS (`/var/…` vs
 * `/private/var/…`) matches nothing while looking perfectly reasonable.
 */
export async function claudeSessionsOwnedBy(
	ownerRoot: string,
	globalDir?: string,
): Promise<ReadonlyArray<{ sessionId: string; transcriptPath: string; edge: ClaudeOwnerEdge }>> {
	const ledger = await loadClaudeOwners(globalDir);
	const mine: { sessionId: string; transcriptPath: string; edge: ClaudeOwnerEdge }[] = [];
	for (const session of Object.values(ledger.sessions)) {
		const edge = session.owners[ownerRoot];
		if (edge) mine.push({ sessionId: session.sessionId, transcriptPath: session.transcriptPath, edge });
	}
	return mine;
}
```

---

### Task 2: Transcript window → owner edges

**Files:**
- Create: `cli/src/core/ClaudeOwnerScan.ts`
- Create: `cli/src/core/ClaudeOwnerScan.test.ts`

**Interfaces:**
- Consumes: `splitTranscriptLines` from `core/TranscriptReader.js`, `resolveStateRoot` from `core/GitOps.js`, `ClaudeOwnerEdge` from Task 1.
- Produces: `scanOwnerEdges(lines: ReadonlyArray<string>, fromLine: number, resolveRoot?: (cwd: string) => string | null): { edges: Map<string, ClaudeOwnerEdge>; lastLine: number }`

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/ClaudeOwnerScan.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { scanOwnerEdges } from "./ClaudeOwnerScan.js";

/** One transcript line carrying a cwd and a timestamp. */
function line(cwd: string, ts: string): string {
	return JSON.stringify({ cwd, timestamp: ts, message: { role: "user", content: "hi" } });
}

// Identity roots: each cwd's first path segment pair is its "worktree root".
const roots = (cwd: string): string | null => (cwd.startsWith("/repo/") ? `/repo/${cwd.split("/")[2]}` : null);

describe("scanOwnerEdges", () => {
	it("records one edge per distinct worktree root", () => {
		const lines = [
			line("/repo/a", "2026-08-17T10:00:00.000Z"),
			line("/repo/b/sub", "2026-08-17T10:01:00.000Z"),
			line("/repo/a/deep", "2026-08-17T10:02:00.000Z"),
		];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect([...edges.keys()].sort()).toEqual(["/repo/a", "/repo/b"]);
		expect(edges.get("/repo/a")?.firstSeenLine).toBe(0);
		expect(edges.get("/repo/b")?.firstSeenLine).toBe(1);
	});

	it("keeps the FIRST line of a root and the LAST timestamp/cwd", () => {
		const lines = [
			line("/repo/a", "2026-08-17T10:00:00.000Z"),
			line("/repo/a/sub", "2026-08-17T10:09:00.000Z"),
		];
		const edge = scanOwnerEdges(lines, 0, roots).edges.get("/repo/a");
		expect(edge?.firstSeenLine).toBe(0);
		expect(edge?.firstSeenAt).toBe("2026-08-17T10:00:00.000Z");
		expect(edge?.firstSeenCwd).toBe("/repo/a");
		expect(edge?.lastSeenAt).toBe("2026-08-17T10:09:00.000Z");
		expect(edge?.lastSeenCwd).toBe("/repo/a/sub");
	});

	it("numbers lines against the WHOLE file, not the scanned window", () => {
		const lines = [
			line("/repo/a", "2026-08-17T10:00:00.000Z"),
			line("/repo/a", "2026-08-17T10:01:00.000Z"),
			line("/repo/b", "2026-08-17T10:02:00.000Z"),
		];
		const { edges, lastLine } = scanOwnerEdges(lines, 2, roots);
		expect([...edges.keys()]).toEqual(["/repo/b"]);
		expect(edges.get("/repo/b")?.firstSeenLine).toBe(2);
		expect(lastLine).toBe(3);
	});

	it("returns the line count as lastLine so the caller can advance its mark", () => {
		expect(scanOwnerEdges([line("/repo/a", "2026-08-17T10:00:00.000Z")], 0, roots).lastLine).toBe(1);
	});

	it("skips lines with no cwd, an empty cwd, or unparseable JSON", () => {
		const lines = [
			"not json",
			JSON.stringify({ timestamp: "2026-08-17T10:00:00.000Z" }),
			JSON.stringify({ cwd: "", timestamp: "2026-08-17T10:00:00.000Z" }),
			line("/repo/a", "2026-08-17T10:03:00.000Z"),
		];
		const { edges } = scanOwnerEdges(lines, 0, roots);
		expect([...edges.keys()]).toEqual(["/repo/a"]);
		expect(edges.get("/repo/a")?.firstSeenLine).toBe(3);
	});

	it("skips a cwd that resolves to no worktree root", () => {
		const { edges } = scanOwnerEdges([line("/tmp/scratch", "2026-08-17T10:00:00.000Z")], 0, roots);
		expect(edges.size).toBe(0);
	});

	it("falls back to a caller-supplied instant when a line carries no timestamp", () => {
		const lines = [JSON.stringify({ cwd: "/repo/a" })];
		const edge = scanOwnerEdges(lines, 0, roots, () => "2026-08-17T12:00:00.000Z").edges.get("/repo/a");
		expect(edge?.firstSeenAt).toBe("2026-08-17T12:00:00.000Z");
	});

	it("returns no edges for an empty window", () => {
		const { edges, lastLine } = scanOwnerEdges([], 0, roots);
		expect(edges.size).toBe(0);
		expect(lastLine).toBe(0);
	});
});
```

- [ ] **Step 2: Write `ClaudeOwnerScan.ts`**

```typescript
/**
 * Turns a window of Claude transcript lines into owner edges.
 *
 * `cwd` is read off the RAW line object, never off `parseTranscriptLine`: Claude
 * stamps it on records that are not conversation turns at all (`attachment`,
 * `queue-operation`), and gating on the turn parser throws away most of the
 * directories a session ever visited. This mirrors `ClaudeSessionDiscoverer`'s
 * `scanSlice`, which learned the same lesson against 64 real transcripts.
 *
 * The index a line reports is its index in the WHOLE file, because it becomes a
 * cursor lower bound — the caller passes the file's full `splitTranscriptLines`
 * output plus the line to start at, rather than a pre-sliced window, so the two
 * notions of "line N" cannot drift apart.
 */

import { resolveStateRoot } from "./GitOps.js";
import type { ClaudeOwnerEdge } from "./ClaudeOwnership.js";

/**
 * A `cwd` → worktree-root resolver. Defaults to {@link resolveStateRoot}, which
 * realpaths and forward-slashes; returns null for a directory that resolves to
 * nothing usable, so the line is ignored rather than creating an owner nobody
 * will ever look up.
 */
export type RootResolver = (cwd: string) => string | null;

function defaultResolveRoot(cwd: string): string | null {
	try {
		const root = resolveStateRoot(cwd);
		return root.length > 0 ? root : null;
	} catch {
		return null;
	}
}

export function scanOwnerEdges(
	lines: ReadonlyArray<string>,
	fromLine: number,
	resolveRoot: RootResolver = defaultResolveRoot,
	now: () => string = () => new Date().toISOString(),
): { edges: Map<string, ClaudeOwnerEdge>; lastLine: number } {
	const edges = new Map<string, ClaudeOwnerEdge>();
	// Resolving a root shells out to the filesystem, so cache within the pass:
	// a long session stamps the same handful of directories on thousands of lines.
	const rootCache = new Map<string, string | null>();

	for (let i = Math.max(0, fromLine); i < lines.length; i++) {
		const text = lines[i].trim();
		if (!text.startsWith("{")) continue;
		let raw: { cwd?: unknown; timestamp?: unknown };
		try {
			raw = JSON.parse(text) as typeof raw;
		} catch {
			continue;
		}
		const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
		if (cwd.length === 0) continue;

		let root = rootCache.get(cwd);
		if (root === undefined) {
			root = resolveRoot(cwd);
			rootCache.set(cwd, root);
		}
		if (root === null) continue;

		const at = typeof raw.timestamp === "string" && raw.timestamp.length > 0 ? raw.timestamp : now();
		const prior = edges.get(root);
		edges.set(
			root,
			prior
				? { ...prior, lastSeenAt: at, lastSeenCwd: cwd }
				: { firstSeenAt: at, firstSeenLine: i, lastSeenAt: at, firstSeenCwd: cwd, lastSeenCwd: cwd },
		);
	}

	return { edges, lastLine: lines.length };
}
```

---

### Task 3: Stop hook writes the ledger

**Files:**
- Modify: `cli/src/Types.ts` (`DiscoveryExtractor`)
- Modify: `cli/src/core/ClaudeOwnerScan.ts` (add the cursor-protocol wrapper)
- Modify: `cli/src/hooks/StopHook.ts:279` (`discoverFromTranscript`)
- Modify: `cli/src/core/ClaudeOwnerScan.test.ts` (append the wrapper's tests)
- Modify: `cli/src/hooks/StopHook.test.ts`

**Interfaces:**
- Consumes: `loadExtractorCursorLine` / `saveExtractorCursor` from `core/SessionTracker.js`, `recordClaudeOwners` (Task 1), `scanOwnerEdges` (Task 2).
- Produces: `scanOwnersWithCursor(transcriptPath: string, sessionId: string, cwd: string, globalDir?: string): Promise<void>`

- [ ] **Step 1: Widen `DiscoveryExtractor`**

In `cli/src/Types.ts:65`:

```typescript
export type DiscoveryExtractor = "plans" | "references" | "skills" | "owners";
```

Leave `LEGACY_COVERED_EXTRACTORS` in `SessionTracker.ts` untouched — `owners` is new, so a legacy bare `lineNumber` must NOT be credited to it (that is exactly the stranding the per-extractor marks exist to prevent).

- [ ] **Step 2: Write the failing tests**

Append to `cli/src/core/ClaudeOwnerScan.test.ts`:

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadClaudeOwners } from "./ClaudeOwnership.js";
import { loadExtractorCursorLine, saveExtractorCursor } from "./SessionTracker.js";
import { scanOwnersWithCursor } from "./ClaudeOwnerScan.js";

describe("scanOwnersWithCursor", () => {
	it("records edges and advances only the owners mark", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-owners-g-"));
		const repo = await mkdtemp(join(tmpdir(), "jolli-owners-r-"));
		const transcript = join(global, "s1.jsonl");
		await writeFile(transcript, `${JSON.stringify({ cwd: repo, timestamp: "2026-08-17T10:00:00.000Z" })}\n`, "utf-8");

		await scanOwnersWithCursor(transcript, "s1", repo, global);

		const ledger = await loadClaudeOwners(global);
		expect(Object.keys(ledger.sessions)).toEqual(["claude:s1"]);
		expect(await loadExtractorCursorLine(transcript, "owners", repo)).toBe(1);
		expect(await loadExtractorCursorLine(transcript, "plans", repo)).toBe(0);
	});

	it("re-scans nothing once the mark has passed the file", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-owners-g2-"));
		const repo = await mkdtemp(join(tmpdir(), "jolli-owners-r2-"));
		const transcript = join(global, "s2.jsonl");
		await writeFile(transcript, `${JSON.stringify({ cwd: repo, timestamp: "2026-08-17T10:00:00.000Z" })}\n`, "utf-8");
		await saveExtractorCursor(transcript, "owners", 1, repo);

		await scanOwnersWithCursor(transcript, "s2", repo, global);

		expect(await loadClaudeOwners(global)).toEqual({ version: 1, sessions: {} });
	});

	it("never throws when the transcript is missing", async () => {
		const global = await mkdtemp(join(tmpdir(), "jolli-owners-g3-"));
		const repo = await mkdtemp(join(tmpdir(), "jolli-owners-r3-"));
		await expect(scanOwnersWithCursor(join(repo, "gone.jsonl"), "s3", repo, global)).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 3: Add the wrapper to `ClaudeOwnerScan.ts`**

```typescript
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createLogger } from "../Logger.js";
import { recordClaudeOwners } from "./ClaudeOwnership.js";
import { loadExtractorCursorLine, saveExtractorCursor } from "./SessionTracker.js";
import { splitTranscriptLines } from "./TranscriptReader.js";

const log = createLogger("ClaudeOwnerScan");

/**
 * Scan one transcript for owner edges against the `owners` extractor's OWN
 * high-water mark, advancing it only when it moved forward — the same three-step
 * protocol as `scanSkillsWithCursor`, and for the same reason: advancing a
 * monotonic mark without scanning, or on a throw, strands those lines forever.
 *
 * Deliberately independent of the shared `lineNumber` the plan/reference pair
 * ride, so a dist that predates this extractor cannot advance past the lines it
 * needs.
 *
 * Never throws — the Stop hook must survive an unreadable transcript.
 */
export async function scanOwnersWithCursor(
	transcriptPath: string,
	sessionId: string,
	cwd: string,
	globalDir?: string,
): Promise<void> {
	try {
		const fromLine = await loadExtractorCursorLine(transcriptPath, "owners", cwd);
		const lines = splitTranscriptLines(await readFile(transcriptPath, "utf-8"));
		if (lines.length <= fromLine) return;
		const { edges, lastLine } = scanOwnerEdges(lines, fromLine);
		await recordClaudeOwners({ sessionId, transcriptPath, edges }, globalDir);
		if (lastLine > fromLine) await saveExtractorCursor(transcriptPath, "owners", lastLine, cwd);
	} catch (err) {
		log.warn("Owner discovery failed for %s: %s", basename(transcriptPath), (err as Error).message);
	}
}
```

- [ ] **Step 4: Call it from the Stop hook**

In `cli/src/hooks/StopHook.ts`, inside `discoverFromTranscript`, immediately after the `scanSkillsWithCursor` call (line ~279):

```typescript
	// Own cursor, own error handling — see scanSkillsWithCursor above.
	await scanSkillsWithCursor(transcriptPath, cwd, "claude");

	// Fourth extractor, same protocol. This is the ONLY writer of the machine-global
	// ownership ledger, and it is what lets a DIFFERENT checkout later prove it owns
	// a slice of this session: the transcript's own `cwd` lines are the evidence, and
	// they are only visible while the file is being scanned here.
	await scanOwnersWithCursor(transcriptPath, sessionInfo.sessionId, cwd);
```

Add the import:

```typescript
import { scanOwnersWithCursor } from "../core/ClaudeOwnerScan.js";
```

- [ ] **Step 5: Assert the hook wiring**

Add to `cli/src/hooks/StopHook.test.ts`, following the file's existing mocking style for `../core/skills/TranscriptSkillDiscovery.js`:

```typescript
vi.mock("../core/ClaudeOwnerScan.js", () => ({ scanOwnersWithCursor: vi.fn(async () => undefined) }));

it("runs owner discovery for the session's transcript", async () => {
	// …arrange the same happy-path stdin payload the neighbouring cases use…
	await handleStopHook();
	const { scanOwnersWithCursor } = await import("../core/ClaudeOwnerScan.js");
	expect(scanOwnersWithCursor).toHaveBeenCalledWith(expect.stringContaining(".jsonl"), "test-session", expect.any(String));
});

it("skips owner discovery when it defers to the CLI hook", async () => {
	// …set CLAUDE_PLUGIN_ROOT + an installed CLI hook, as the existing defer test does…
	await handleStopHook();
	const { scanOwnersWithCursor } = await import("../core/ClaudeOwnerScan.js");
	expect(scanOwnersWithCursor).not.toHaveBeenCalled();
});
```

---

### Task 4: QueueWorker merges ledger candidates

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts:3907` (`loadSessionTranscripts`)
- Modify: `cli/src/hooks/QueueWorker.test.ts`

**Interfaces:**
- Consumes: `claudeSessionsOwnedBy` (Task 1), `resolveStateRoot` from `core/GitOps.js`.
- Produces: a private `claudeLedgerCandidates(cwd, config)` returning `{ sessions, seeds }`, where `seeds` is `Map<string, number>` keyed by `transcriptPath` — Task 5 consumes it.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/hooks/QueueWorker.test.ts` (the file already fakes `sessions.json`; add a fake global dir via the ledger's own writer):

```typescript
it("reads a Claude session this worktree owns even when sessions.json has none", async () => {
	// repoDir is a git worktree fixture; transcript records a cwd inside it.
	await writeFile(transcript, `${JSON.stringify({ cwd: repoDir, timestamp: "2026-08-17T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "why is X like this" }] } })}\n`, "utf-8");
	await recordClaudeOwners(
		{
			sessionId: "foreign-1",
			transcriptPath: transcript,
			edges: new Map([[resolveStateRoot(repoDir), { firstSeenAt: "2026-08-17T10:00:00.000Z", firstSeenLine: 0, lastSeenAt: "2026-08-17T10:00:00.000Z" }]]),
		},
		globalDir,
	);

	const summary = await runCommitPipelineForTest(repoDir);

	expect(summary.transcripts ?? []).not.toHaveLength(0);
});

it("does not read a session owned only by a different worktree", async () => {
	await recordClaudeOwners(
		{
			sessionId: "other-1",
			transcriptPath: transcript,
			edges: new Map([["/somewhere/else", { firstSeenAt: "2026-08-17T10:00:00.000Z", firstSeenLine: 0, lastSeenAt: "2026-08-17T10:00:00.000Z" }]]),
		},
		globalDir,
	);

	const summary = await runCommitPipelineForTest(repoDir);

	expect(summary.transcripts ?? []).toHaveLength(0);
});

it("does not duplicate a session present in both sessions.json and the ledger", async () => {
	await saveSession({ sessionId: "dup-1", transcriptPath: transcript, updatedAt: NOW, source: "claude" }, repoDir);
	await recordClaudeOwners(
		{ sessionId: "dup-1", transcriptPath: transcript, edges: new Map([[resolveStateRoot(repoDir), edge]]) },
		globalDir,
	);

	const summary = await runCommitPipelineForTest(repoDir);

	expect(summary.transcriptEntries).toBe(1);
});

it("ignores the ledger when claudeEnabled is false", async () => {
	await saveConfig({ claudeEnabled: false });
	await recordClaudeOwners(
		{ sessionId: "off-1", transcriptPath: transcript, edges: new Map([[resolveStateRoot(repoDir), edge]]) },
		globalDir,
	);

	const summary = await runCommitPipelineForTest(repoDir);

	expect(summary.transcripts ?? []).toHaveLength(0);
});
```

- [ ] **Step 2: Implement the merge**

In `cli/src/hooks/QueueWorker.ts`, replace line 3907's single assignment with the merge, and thread the seeds out of the function:

```typescript
	const trackedSessions = filterSessionsByEnabledIntegrations(await loadAllSessions(cwd), config);

	// Claude candidates from the machine-global ownership ledger (spec §7.1).
	// `sessions.json` only knows the sessions whose Stop hook fired against THIS
	// checkout; the ledger knows every checkout a session's transcript proves it
	// visited, which is the whole point of the fix. Merged, not replaced — the
	// local registry stays the cheap fast path and the fallback for a session the
	// ledger never got (an older dist, a wiped global dir).
	//
	// The lookup key MUST be the anchored root: this `cwd` is git's hook cwd, and
	// on macOS that is `/var/…` where `resolveStateRoot` wrote `/private/var/…`.
	const ownerRoot = resolveStateRoot(cwd);
	const ledgerOwned = config.claudeEnabled === false ? [] : await claudeSessionsOwnedBy(ownerRoot);
	/** transcriptPath → this owner's lower bound, for a first read (see readAllTranscripts). */
	const ownerSeeds = new Map<string, number>();
	for (const owned of ledgerOwned) ownerSeeds.set(owned.transcriptPath, owned.edge.firstSeenLine);

	const seen = new Set(
		trackedSessions.map((s) => `${s.source ?? "claude"} ${s.sessionId} ${s.transcriptPath}`),
	);
	const ledgerSessions = ledgerOwned
		.filter((o) => !seen.has(`claude ${o.sessionId} ${o.transcriptPath}`))
		.map((o) => ({
			sessionId: o.sessionId,
			transcriptPath: o.transcriptPath,
			updatedAt: o.edge.lastSeenAt,
			source: "claude" as const,
		}));
	if (ledgerSessions.length > 0) {
		log.info("Claude ownership ledger contributed %d session(s) for %s", ledgerSessions.length, ownerRoot);
	}

	let allSessions: ReadonlyArray<SessionInfo> = [...trackedSessions, ...ledgerSessions];
```

Add the imports:

```typescript
import { claudeSessionsOwnedBy } from "../core/ClaudeOwnership.js";
```

(`resolveStateRoot` is already imported in this module; confirm before adding a duplicate.)

---

### Task 5: Owner-seeded lower bound (the load-bearing rule)

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts:4327` (`readAllTranscripts`) and its call site at 4028
- Modify: `cli/src/hooks/QueueWorker.test.ts`

**Interfaces:**
- Consumes: `ownerSeeds` from Task 4.
- Produces: `readAllTranscripts(sessions, cwd, beforeTimestamp?, ownerSeeds?)` — a fourth optional parameter, so every existing caller and test is untouched.

- [ ] **Step 1: Write the failing tests**

Add to `cli/src/hooks/QueueWorker.test.ts`:

```typescript
it("starts a first read from the owner's firstSeenLine, not from line 0", async () => {
	// 3 turns from another checkout, then 1 turn from this one.
	await writeFile(transcript, [foreignTurn(0), foreignTurn(1), foreignTurn(2), localTurn(3)].join("\n"), "utf-8");
	await recordClaudeOwners(
		{
			sessionId: "seeded-1",
			transcriptPath: transcript,
			edges: new Map([[resolveStateRoot(repoDir), { firstSeenAt: T3, firstSeenLine: 3, lastSeenAt: T3 }]]),
		},
		globalDir,
	);

	const summary = await runCommitPipelineForTest(repoDir);

	expect(summary.transcriptEntries).toBe(1);
});

it("resumes from this worktree's own cursor once it has one", async () => {
	await saveCursor({ transcriptPath: transcript, lineNumber: 4, updatedAt: NOW }, repoDir);
	await recordClaudeOwners(
		{ sessionId: "seeded-2", transcriptPath: transcript, edges: new Map([[resolveStateRoot(repoDir), { firstSeenAt: T0, firstSeenLine: 0, lastSeenAt: T0 }]]) },
		globalDir,
	);

	const summary = await runCommitPipelineForTest(repoDir);

	// The seed must NOT rewind an established cursor.
	expect(summary.transcriptEntries ?? 0).toBe(0);
});

it("still honours beforeTimestamp as the upper bound when seeded", async () => {
	await writeFile(transcript, [localTurn(0, T0), localTurn(1, "2099-01-01T00:00:00.000Z")].join("\n"), "utf-8");
	await recordClaudeOwners(
		{ sessionId: "seeded-3", transcriptPath: transcript, edges: new Map([[resolveStateRoot(repoDir), { firstSeenAt: T0, firstSeenLine: 0, lastSeenAt: T0 }]]) },
		globalDir,
	);

	const summary = await runCommitPipelineForTest(repoDir);

	expect(summary.transcriptEntries).toBe(1);
});

it("leaves a non-Claude source's first read at line 0", async () => {
	// A gemini session with an owner seed present for the same path must ignore it.
	// (Nothing writes such a seed today; the assertion pins that the branch is
	// source-gated rather than path-gated.)
});
```

- [ ] **Step 2: Implement the seed**

In `readAllTranscripts`, widen the signature and replace the cursor load:

```typescript
async function readAllTranscripts(
	sessions: ReadonlyArray<{ sessionId: string; transcriptPath: string; source?: TranscriptSource }>,
	cwd: string,
	beforeTimestamp?: string,
	/**
	 * Claude-only lower bounds from the ownership ledger, keyed by transcriptPath.
	 * Consulted ONLY when this worktree has no cursor of its own for that
	 * transcript — see the seed below.
	 */
	ownerSeeds?: ReadonlyMap<string, number>,
): Promise<{
```

then, at the top of the per-session loop (replacing lines 4368-4370):

```typescript
		const source = session.source ?? "claude";
		const saved = await loadCursorForTranscript(session.transcriptPath, cwd);
		// THE load-bearing rule (spec §7.3). With no saved cursor the reader used to
		// start at line 0 and stop only at `beforeTimestamp`, which for a session this
		// checkout joined late means absorbing every earlier turn — turns that belong
		// to whichever checkout was driving the conversation then. The ledger knows
		// where this owner first appears, so that is the floor.
		//
		// Only when there is NO saved cursor: an established cursor is this owner's own
		// progress and always wins, or a seed would rewind it and re-read spent lines.
		// Claude-only, because the ledger has no other source in it (spec §2.2).
		const seedLine = saved === null && source === "claude" ? ownerSeeds?.get(session.transcriptPath) : undefined;
		const cursor =
			seedLine !== undefined && seedLine > 0
				? { transcriptPath: session.transcriptPath, lineNumber: seedLine, updatedAt: new Date().toISOString() }
				: saved;
		const startLine = cursor?.lineNumber ?? 0;
		if (seedLine !== undefined && seedLine > 0) {
			log.info("Seeding first read of %s from owner line %d", session.sessionId, seedLine);
		}
```

- [ ] **Step 3: Pass the seeds through the call site**

At line 4028 in `loadSessionTranscripts`:

```typescript
	const rawAll = await readAllTranscripts(allSessions, cwd, beforeTimestamp, ownerSeeds);
```

---

## Phase 2 — Bounded repair

### Task 6: Repair marker and the shared repairability predicate

**Files:**
- Modify: `cli/src/Types.ts` (`CommitSummary`)
- Create: `cli/src/core/TranscriptRepair.ts` (predicate half only; the engine lands in Task 7)
- Create: `cli/src/core/TranscriptRepair.test.ts`

**Interfaces:**
- Consumes: `getTranscriptIds` from `core/SummaryTree.js`, `claudeSessionsOwnedBy` (Task 1).
- Produces:
  - `type TranscriptRepairState = "present" | "repaired" | "repairable" | "unrepairable"`
  - `transcriptRepairState(summary: CommitSummary, cwd: string): Promise<TranscriptRepairState>`

- [ ] **Step 1: Add the marker field**

In `cli/src/Types.ts`, inside `CommitSummary`, after `transcripts`:

```typescript
	/**
	 * Set by `jolli doctor --repair-transcripts --fix` when this summary's empty
	 * `transcripts` was refilled from local transcript history. Purely additive —
	 * no schema bump, matching how `skills` / `excludedContext` shipped.
	 *
	 * Two jobs. It is the repair's idempotency key: a summary carrying it is never
	 * a candidate again, so a repeated run cannot create a second artifact for the
	 * same evidence window (spec §8.2). And it is what lets the memory-detail UI
	 * say "repaired from local transcript history" rather than implying the
	 * conversation was captured live.
	 */
	readonly transcriptsRepairedAt?: string;
```

- [ ] **Step 2: Write the failing tests**

Create `cli/src/core/TranscriptRepair.test.ts`:

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommitSummary } from "../Types.js";
import { recordClaudeOwners } from "./ClaudeOwnership.js";
import { transcriptRepairState } from "./TranscriptRepair.js";

let globalDir: string;
let repo: string;
let transcript: string;

const EDGE = { firstSeenAt: "2026-08-17T10:00:00.000Z", firstSeenLine: 0, lastSeenAt: "2026-08-17T10:00:00.000Z" };

function summary(over: Partial<CommitSummary> = {}): CommitSummary {
	return {
		commitHash: "a".repeat(40),
		commitMessage: "x",
		commitAuthor: "a",
		commitDate: "2026-08-17T11:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T11:00:05.000Z",
		topics: [],
		...over,
	} as CommitSummary;
}

beforeEach(async () => {
	globalDir = await mkdtemp(join(tmpdir(), "jolli-rep-g-"));
	repo = await mkdtemp(join(tmpdir(), "jolli-rep-r-"));
	transcript = join(globalDir, "s.jsonl");
	await writeFile(transcript, `${JSON.stringify({ cwd: repo, timestamp: "2026-08-17T10:00:00.000Z" })}\n`, "utf-8");
});

describe("transcriptRepairState", () => {
	it("is present when the summary already references a transcript", async () => {
		expect(await transcriptRepairState(summary({ transcripts: ["t1"] }), repo, globalDir)).toBe("present");
	});

	it("is repaired when the marker is set", async () => {
		expect(
			await transcriptRepairState(summary({ transcripts: ["t1"], transcriptsRepairedAt: "2026-08-17T12:00:00.000Z" }), repo, globalDir),
		).toBe("repaired");
	});

	it("is repairable when an owner edge and the transcript both exist", async () => {
		await recordClaudeOwners({ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) }, globalDir);
		expect(await transcriptRepairState(summary({ transcripts: [] }), repo, globalDir)).toBe("repairable");
	});

	it("is unrepairable when no owner edge proves this checkout", async () => {
		expect(await transcriptRepairState(summary({ transcripts: [] }), repo, globalDir)).toBe("unrepairable");
	});

	it("is unrepairable when the transcript file is gone", async () => {
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: join(globalDir, "vanished.jsonl"), edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		expect(await transcriptRepairState(summary({ transcripts: [] }), repo, globalDir)).toBe("unrepairable");
	});
});
```

- [ ] **Step 3: Write the predicate**

Create `cli/src/core/TranscriptRepair.ts` with the predicate (the engine is appended in Task 7):

```typescript
/**
 * Repair for summaries written with `transcripts: []`.
 *
 * Deliberately conservative (spec §8.3): every uncertainty resolves to "do not
 * repair". A false negative leaves a memory looking exactly as it does today; a
 * false positive staples someone else's conversation onto a commit, which is
 * worse than the gap it would be papering over.
 */

import { existsSync } from "node:fs";
import { resolveStateRoot } from "./GitOps.js";
import type { CommitSummary } from "../Types.js";
import { claudeSessionsOwnedBy } from "./ClaudeOwnership.js";
import { getTranscriptIds } from "./SummaryTree.js";

/**
 * What the memory-detail UI is allowed to claim about a summary's conversations:
 *
 * - `present`     — captured live; render the conversations.
 * - `repaired`    — refilled from local transcript history after the fact.
 * - `repairable`  — empty, but the evidence to rebuild it is still on this machine.
 * - `unrepairable`— empty, and nothing local can fix it.
 *
 * The last two are the distinction spec §9 exists for: "No conversations linked
 * yet" reads as "not yet", which is misleading for a capture that already failed
 * and will never complete on its own.
 */
export type TranscriptRepairState = "present" | "repaired" | "repairable" | "unrepairable";

export async function transcriptRepairState(
	summary: CommitSummary,
	cwd: string,
	globalDir?: string,
): Promise<TranscriptRepairState> {
	if (summary.transcriptsRepairedAt !== undefined) return "repaired";
	if (getTranscriptIds(summary).length > 0) return "present";
	const owned = await claudeSessionsOwnedBy(resolveStateRoot(cwd), globalDir);
	return owned.some((o) => existsSync(o.transcriptPath)) ? "repairable" : "unrepairable";
}
```

---

### Task 7: Repair engine

**Files:**
- Modify: `cli/src/core/TranscriptRepair.ts`
- Modify: `cli/src/core/TranscriptRepair.test.ts`

**Interfaces:**
- Consumes: `readTranscript` from `core/TranscriptReader.js`, `getParserForSource` from `core/TranscriptParser.js`, `generateTranscriptId` from `core/TranscriptId.js`, `getSummary` / `storeSummary` from `core/SummaryStore.js`.
- Produces:
  - `interface RepairOutcome { readonly commitHash: string; readonly repaired: boolean; readonly reason: "repaired" | "already-present" | "no-owner-proof" | "transcript-missing" | "no-entries-in-window" | "no-upper-bound" }`
  - `repairSummaryTranscripts(commitHash: string, cwd: string, opts?: { apply?: boolean; globalDir?: string }): Promise<RepairOutcome>`

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/core/TranscriptRepair.test.ts`:

```typescript
describe("repairSummaryTranscripts", () => {
	it("repairs an empty summary when transcript, owner edge and upper bound all exist", async () => {
		// transcript holds one turn at 10:00; summary.generatedAt is 11:00:05.
		await recordClaudeOwners({ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) }, globalDir);
		const out = await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir });
		expect(out).toMatchObject({ repaired: true, reason: "repaired" });
		const stored = await getSummary(HASH, repo);
		expect(stored?.transcripts).toHaveLength(1);
		expect(stored?.transcriptsRepairedAt).toBeTruthy();
	});

	it("is idempotent — a second run reports already-present and writes nothing", async () => {
		await recordClaudeOwners({ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) }, globalDir);
		await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir });
		const before = await getSummary(HASH, repo);
		const out = await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir });
		expect(out.reason).toBe("already-present");
		expect((await getSummary(HASH, repo))?.transcripts).toEqual(before?.transcripts);
	});

	it("refuses when the transcript file is gone", async () => {
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: join(globalDir, "gone.jsonl"), edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		expect((await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir })).reason).toBe("transcript-missing");
	});

	it("refuses when no owner edge proves this checkout", async () => {
		expect((await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir })).reason).toBe("no-owner-proof");
	});

	it("refuses when the bounded window yields no entries", async () => {
		// Owner edge seeded past every line in the file.
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, { ...EDGE, firstSeenLine: 99 }]]) },
			globalDir,
		);
		expect((await repairSummaryTranscripts(HASH, repo, { apply: true, globalDir })).reason).toBe("no-entries-in-window");
	});

	it("writes nothing when apply is false", async () => {
		await recordClaudeOwners({ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) }, globalDir);
		const out = await repairSummaryTranscripts(HASH, repo, { globalDir });
		expect(out.repaired).toBe(true);
		expect((await getSummary(HASH, repo))?.transcripts ?? []).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Implement the engine**

Append to `cli/src/core/TranscriptRepair.ts`:

```typescript
export interface RepairOutcome {
	readonly commitHash: string;
	/** True when a repair happened, or WOULD have happened under `apply: false`. */
	readonly repaired: boolean;
	readonly reason:
		| "repaired"
		| "already-present"
		| "no-owner-proof"
		| "transcript-missing"
		| "no-entries-in-window"
		| "no-upper-bound";
	readonly entries?: number;
}

/**
 * Rebuilds one summary's transcript slice from local history (spec §8.2).
 *
 * Bounds, both mandatory:
 *   - LOWER — the owner edge's `firstSeenLine`, exactly as the live read path
 *     seeds a first read. Never 0-by-default: a summary whose owner cannot be
 *     proven is refused, not read from the top.
 *   - UPPER — `generatedAt` (the capture instant), falling back to `commitDate`.
 *     `generatedAt` is preferred because it is when capture actually ran; the
 *     commit's own timestamp can precede the turns that produced it.
 *
 * `apply: false` performs every step except the write, so the outcome a dry run
 * reports is the outcome the real run produces — the reasons cannot drift,
 * because there is one code path.
 */
export async function repairSummaryTranscripts(
	commitHash: string,
	cwd: string,
	opts: { readonly apply?: boolean; readonly globalDir?: string } = {},
): Promise<RepairOutcome> {
	const summary = await getSummary(commitHash, cwd);
	if (!summary) return { commitHash, repaired: false, reason: "no-owner-proof" };
	if (summary.transcriptsRepairedAt !== undefined || getTranscriptIds(summary).length > 0) {
		return { commitHash, repaired: false, reason: "already-present" };
	}

	const before = summary.generatedAt || summary.commitDate;
	if (!before) return { commitHash, repaired: false, reason: "no-upper-bound" };

	const owned = await claudeSessionsOwnedBy(resolveStateRoot(cwd), opts.globalDir);
	if (owned.length === 0) return { commitHash, repaired: false, reason: "no-owner-proof" };
	const live = owned.filter((o) => existsSync(o.transcriptPath));
	if (live.length === 0) return { commitHash, repaired: false, reason: "transcript-missing" };

	const sessions: StoredSession[] = [];
	for (const owner of live) {
		let read: TranscriptReadResult;
		try {
			read = await readTranscript(
				owner.transcriptPath,
				{
					transcriptPath: owner.transcriptPath,
					lineNumber: owner.edge.firstSeenLine,
					updatedAt: owner.edge.firstSeenAt,
				},
				getParserForSource("claude"),
				before,
			);
		} catch (err) {
			log.debug("repair: cannot read %s: %s", owner.transcriptPath, errMsg(err));
			continue;
		}
		if (read.entries.length === 0) continue;
		sessions.push({
			sessionId: owner.sessionId,
			transcriptPath: owner.transcriptPath,
			source: "claude",
			entries: read.entries,
		});
	}
	if (sessions.length === 0) return { commitHash, repaired: false, reason: "no-entries-in-window" };

	const entries = sessions.reduce((n, s) => n + s.entries.length, 0);
	if (opts.apply !== true) return { commitHash, repaired: true, reason: "repaired", entries };

	const id = generateTranscriptId();
	await storeSummary(
		{ ...summary, transcripts: [id], transcriptsRepairedAt: new Date().toISOString() },
		cwd,
		true,
		{ transcript: { id, data: { sessions } } },
	);
	return { commitHash, repaired: true, reason: "repaired", entries };
}
```

---

### Task 8: `jolli doctor --repair-transcripts`

**Files:**
- Modify: `cli/src/commands/DoctorCommand.ts:715` (registration) + a new `runRepairTranscripts`
- Modify: `cli/src/commands/DoctorCommand.test.ts`

**Interfaces:**
- Consumes: `listSummaries` from `core/SummaryStore.js`, `repairSummaryTranscripts` (Task 7).
- Produces: `runRepairTranscripts(cwd: string, apply: boolean): Promise<void>`

- [ ] **Step 1: Write the failing test**

Add to `cli/src/commands/DoctorCommand.test.ts`:

```typescript
it("lists repair candidates without writing when --fix is absent", async () => {
	const out = await captureStdout(() => runRepairTranscripts(repo, false));
	expect(out).toContain("would repair");
	expect((await getSummary(HASH, repo))?.transcripts ?? []).toHaveLength(0);
});

it("repairs and reports per-summary reasons with --fix", async () => {
	const out = await captureStdout(() => runRepairTranscripts(repo, true));
	expect(out).toContain("repaired");
	expect((await getSummary(HASH, repo))?.transcripts).toHaveLength(1);
});

it("reports a clean result when no summary has an empty transcript list", async () => {
	const out = await captureStdout(() => runRepairTranscripts(repoWithFullSummaries, true));
	expect(out).toContain("No summaries need transcript repair");
});
```

- [ ] **Step 2: Implement the runner**

```typescript
/**
 * Scans this repo's summaries for an empty `transcripts` list and offers, or
 * performs, the bounded repair.
 *
 * List-then-act like `--recover`: the bare flag reports what it WOULD do and
 * `--fix` performs it. Repair rewrites stored memories from evidence that may be
 * days old, so it is never something a diagnostic command does on its own.
 */
export async function runRepairTranscripts(cwd: string, apply: boolean): Promise<void> {
	const summaries = await listSummaries(Number.MAX_SAFE_INTEGER, cwd);
	const candidates = summaries.filter((s) => s.transcriptsRepairedAt === undefined && getTranscriptIds(s).length === 0);
	if (candidates.length === 0) {
		console.log("No summaries need transcript repair.");
		return;
	}

	let repaired = 0;
	for (const candidate of candidates) {
		const out = await repairSummaryTranscripts(candidate.commitHash, cwd, { apply });
		const hash = candidate.commitHash.substring(0, 8);
		if (out.repaired) {
			repaired++;
			console.log(`  ${hash}  ${apply ? "repaired" : "would repair"} — ${out.entries} entr(ies)`);
		} else {
			console.log(`  ${hash}  skipped — ${out.reason}`);
		}
	}
	console.log(
		apply
			? `Repaired ${repaired} of ${candidates.length} summar(ies).`
			: `${repaired} of ${candidates.length} summar(ies) can be repaired. Re-run with --fix to apply.`,
	);
}
```

- [ ] **Step 3: Register the flag**

In `registerDoctorCommand`, add the option and dispatch it BEFORE `runDoctor` (and after `--recover`, matching the existing precedence comments):

```typescript
		.option("--repair-transcripts", "Refill summaries written with no conversation from local transcript history")
```

```typescript
				if (options.repairTranscripts === true) {
					await runRepairTranscripts(options.cwd, options.fix === true);
					return;
				}
```

and widen the action's option type with `repairTranscripts?: boolean`.

---

### Task 9: Three-state memory-detail copy

**Files:**
- Modify: `cli/src/commands/IdeBridgeCommand.ts` (new `transcript-repair-state` action)
- Modify: `cli/src/dashboard/assets/js/memories.js:456`
- Modify: `vscode/src/views/SummaryScriptBuilder.ts:2278` and `:2462`
- Create: `intellij/src/main/kotlin/ai/jolli/jollimemory/core/TranscriptRepairState.kt`
- Modify: `intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/views/SummaryHtmlBuilder.kt:278`
- Modify: `cli/src/commands/IdeBridgeCommand.test.ts`

**Interfaces:**
- Consumes: `transcriptRepairState` (Task 6).
- Produces: bridge action `{ action: "transcript-repair-state", commitHash }` → `{ state: TranscriptRepairState }`.

The three strings, verbatim from spec §9 — use these exact words on every surface:

| state | copy |
|---|---|
| `unrepairable` | `No conversations were captured for this memory` |
| `repairable` | `Conversation capture is missing but repair may still be possible` |
| `repaired` | `Conversation capture was repaired from local transcript history` |

- [ ] **Step 1: Add the bridge action**

IntelliJ has no in-process access to `cli/src` (unlike VS Code, which bundles it), so a predicate with no bridge operation is silently "VS Code only". In `IdeBridgeCommand.ts`, beside the other read actions:

```typescript
		case "transcript-repair-state": {
			const summary = await getSummary(String(request.commitHash ?? ""), cwd);
			if (!summary) return { state: "unrepairable" satisfies TranscriptRepairState };
			return { state: await transcriptRepairState(summary, cwd) };
		}
```

- [ ] **Step 2: Write the bridge test**

```typescript
it("answers transcript-repair-state for a summary with no conversations", async () => {
	const res = await dispatch({ action: "transcript-repair-state", commitHash: HASH }, repo);
	expect(res).toEqual({ state: "unrepairable" });
});

it("answers unrepairable for an unknown commit rather than throwing", async () => {
	const res = await dispatch({ action: "transcript-repair-state", commitHash: "f".repeat(40) }, repo);
	expect(res).toEqual({ state: "unrepairable" });
});
```

- [ ] **Step 3: VS Code copy**

At both sites in `SummaryScriptBuilder.ts`, replace the fixed string with a state lookup the panel already has (the summary payload carries `transcriptsRepairedAt`; the `repairable` split comes from the extension calling `transcriptRepairState` in-process and putting it on the payload as `transcriptRepairState`):

```javascript
      conversationsBody.innerHTML =
        '<p class="conv-empty">' +
        (summary.transcriptRepairState === 'repairable'
          ? 'Conversation capture is missing but repair may still be possible'
          : 'No conversations were captured for this memory') +
        '</p>';
```

Remember this webview runs under a strict CSP — no inline `style=`, no inline handlers.

- [ ] **Step 4: Dashboard copy**

`cli/src/dashboard/assets/js/memories.js:456` — same three-way branch, reading the state the page's own server-side render attaches to each row.

- [ ] **Step 5: IntelliJ copy**

Create `TranscriptRepairState.kt` as the thin bridge adapter (follow `FileDiscarder`'s shape — parse defensively, treat an unparseable body as the mildest verdict, `unrepairable`), and branch `SummaryHtmlBuilder.kt:278`'s `conversationsEmpty` paragraph on it.

---

### Task 10: Regression coverage for the spec's §10.4 list

**Files:**
- Modify: `cli/src/hooks/QueueWorker.test.ts`

- [ ] **Step 1: Write the three regression tests**

```typescript
it("same-worktree Claude capture is unchanged when the ledger is empty", async () => {
	await saveSession({ sessionId: "plain", transcriptPath: transcript, updatedAt: NOW, source: "claude" }, repoDir);
	const summary = await runCommitPipelineForTest(repoDir);
	expect(summary.transcriptEntries).toBeGreaterThan(0);
});

it("linked-worktree capture works when the session was first seen elsewhere", async () => {
	// Edge written for worktree B by A's hook; the commit runs in B, which has no
	// sessions.json row at all.
	await recordClaudeOwners(
		{ sessionId: "cross", transcriptPath: transcript, edges: new Map([[resolveStateRoot(worktreeB), EDGE_AT_LINE_3]]) },
		globalDir,
	);
	const summary = await runCommitPipelineForTest(worktreeB);
	expect(summary.transcripts ?? []).not.toHaveLength(0);
});

it("agrees with claudeSessionsForRepo about which sessions belong to this repo", async () => {
	// The disk discoverer and the ledger must not disagree for the same session.
	const scanned = claudeSessionsForRepo([{ sessionId: "cross", transcriptPath: transcript, updatedAt: NOW, dirs: [repoDir], complete: true }], repoDir);
	const owned = await claudeSessionsOwnedBy(resolveStateRoot(repoDir), globalDir);
	expect(owned.map((o) => o.sessionId)).toEqual(scanned.map((s) => s.sessionId));
});
```

---

### Task 11: Gate and commit

- [ ] **Step 1: Run the fast tier**

```bash
npm run test:fast
```

- [ ] **Step 2: Run the full gate**

```bash
npm run all
```

Triage by failure SHAPE first: a `Test timed out in NNNNms` in one of the real-`git` files is contention under `--coverage`, not a regression — re-run that file alone with the stock timeout to confirm. An assertion or thrown error is a real break.

- [ ] **Step 3: Build the IntelliJ side**

```bash
cd intellij && ./gradlew build
```

- [ ] **Step 4: Commit in two logical commits**

```bash
git add cli/src/core/ClaudeOwnership.ts cli/src/core/ClaudeOwnership.test.ts \
        cli/src/core/ClaudeOwnerScan.ts cli/src/core/ClaudeOwnerScan.test.ts \
        cli/src/core/Locks.ts cli/src/Types.ts \
        cli/src/hooks/StopHook.ts cli/src/hooks/StopHook.test.ts \
        cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts
git commit -s -m "fix(capture): attribute one Claude session to every worktree it visited

Claude capture read candidates only from the current worktree's sessions.json,
so a session that started in another checkout — or moved between repositories
mid-conversation — produced a summary with no transcript at all. Record the
worktree roots each session's transcript proves it visited in a machine-global
ownership ledger, and seed a first read from that owner's own first-seen line
so a newly-attributed checkout takes its slice rather than the whole history."

git add cli/src/core/TranscriptRepair.ts cli/src/core/TranscriptRepair.test.ts \
        cli/src/commands/DoctorCommand.ts cli/src/commands/DoctorCommand.test.ts \
        cli/src/commands/IdeBridgeCommand.ts cli/src/commands/IdeBridgeCommand.test.ts \
        cli/src/dashboard/assets/js/memories.js \
        vscode/src/views/SummaryScriptBuilder.ts \
        intellij/src/main/kotlin/ai/jolli/jollimemory/core/TranscriptRepairState.kt \
        intellij/src/main/kotlin/ai/jolli/jollimemory/toolwindow/views/SummaryHtmlBuilder.kt
git commit -s -m "feat(doctor): repair summaries written with no conversation

Adds jolli doctor --repair-transcripts, which refills an empty transcript list
from local history bounded below by the owner's first-seen line and above by the
capture instant, refusing whenever either bound cannot be established. The memory
detail now distinguishes a capture that never happened from one that can still be
repaired and from one that was."
```

---

## Self-Review

**Spec coverage.** §4 ownership semantics → Task 1's edge shape and Task 2's root resolution. §5 storage → Task 1 (global, per the answered question). §6.1 Stop-hook write path → Task 3. §6.2 `firstSeenLine` from transcript evidence → Task 2 (`firstSeenLine` is the line index of the first matching `cwd`, never a wall clock). §7.1 candidate selection → Task 4. §7.2 owner-specific cursor → satisfied structurally: `cursors.json` already lives in `<worktree>/.jolli/jollimemory/`, so `(cwd, transcriptPath)` IS `(ownerRoot, transcriptPath)` and no new file is needed; Task 5 adds the only missing half, the seed. §7.3 first read from a foreign owner → Task 5. §8 repair → Tasks 6-8. §9 UI copy → Task 9. §10.1/§10.2/§10.3 → Tasks 3/5/7. §10.4 → Task 10. §11 risk limits → non-Claude sources untouched (Task 5's branch is source-gated), the lower bound lives outside the parser (a synthesized cursor, not a reader change).

**Deviation to flag.** The spec's §7.2 implies a NEW owner-keyed cursor store. This plan does not add one, because the existing store is already keyed by owner through its directory; adding a second would create two owners of one fact with no tie-breaker. The behavioural contract §7.2 states — first read starts at `firstSeenLine`, subsequent reads resume from this owner's cursor, owners never advance one another — holds exactly as written.

**Type consistency.** `ClaudeOwnerEdge` is produced by `scanOwnerEdges` (Task 2), stored by `recordClaudeOwners` (Task 1), and read by `claudeSessionsOwnedBy` (Task 1) / `repairSummaryTranscripts` (Task 7) — one shape throughout. `firstSeenLine` is a line index against `splitTranscriptLines` at every one of those sites and at the `TranscriptCursor.lineNumber` it becomes in Task 5. `TranscriptRepairState`'s four values are spelled identically in Tasks 6, 8 and 9.

**Known gap left open deliberately.** A ledger edge is only ever written by a Stop hook that fired, so a session from before this ships has no edges and is `unrepairable` even when its transcript is on disk. Seeding the ledger from `scanClaudeSessionsOnDisk` (which already computes exactly this `dirs` set) would close it, and is a natural follow-up — but it is a machine-wide disk sweep and spec §2.1 rules it out of the commit path, so it belongs behind the `doctor` flag rather than in this slice.
