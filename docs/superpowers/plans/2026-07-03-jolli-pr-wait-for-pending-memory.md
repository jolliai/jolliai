# jolli-pr: Wait for Pending Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before `jolli-pr` builds a PR description, wait for in-progress memory-summary generation to finish so freshly-committed summaries are included — bounded by a timeout, and excluding wiki/graph ingest work.

**Architecture:** A new `QueueStatus` core composes two existing signals — the count of non-ingest queue entries and the "worker is blocking-busy" lock state — into a `drained` verdict, plus a bounded `waitForQueueDrained` poll loop. That core is exposed through a new `jolli queue-status` CLI command and a `queue_status` MCP tool (the same single-engine / two-surface pattern as `get_pr_description`). `get_pr_description` gains backstop status fields. The `jolli-pr` skill template inserts a "Step 0: wait for pending memory" gate.

**Tech Stack:** TypeScript (ESM), Node 22.5+, Commander (CLI), `@modelcontextprotocol/sdk` (MCP), Vitest + coverage, Biome (tabs, 120 col).

## Global Constraints

- DCO sign-off on the single final commit: `git commit -s`. CI rejects PRs without `Signed-off-by:`.
- No `Co-Authored-By: Claude …` trailer or `🤖 Generated with …` footer in the commit message.
- `npm run all` must pass before the (single) commit — run it once at the end, not per task.
- **No per-task commits and no per-task `npm run all`** (user preference): each task writes test + implementation and runs only its own targeted Vitest; the full gate + commit happen once in the final task.
- CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines (`cli/vite.config.ts`). New code needs tests.
- Coverage-exempt lines must use `/* v8 ignore start */ … /* v8 ignore stop */` blocks — the single-line `ignore next` form does NOT work in this repo.
- Biome: tabs, 4-wide, 120 columns; `noExplicitAny: error`, `noUnusedImports/Variables: error`. `biome check --error-on-warnings` — warnings fail.
- Worktree-aware: all queue/lock reads go through `getJolliMemoryDir(cwd)` — never assume a single working tree.
- `Date.now()` is allowed here (it is only forbidden inside Workflow scripts, not CLI runtime code).

---

## File Structure

**Create:**
- `cli/src/core/QueueStatus.ts` — `QueueStatus` type, `getQueueStatus(cwd)`, `waitForQueueDrained(cwd, opts)`.
- `cli/src/core/QueueStatus.test.ts`
- `cli/src/commands/QueueStatusCommand.ts` — `registerQueueStatusCommand(program)`.
- `cli/src/commands/QueueStatusCommand.test.ts`

**Modify:**
- `cli/src/core/Locks.ts` — add `isWorkerBlockingBusy(cwd)` (+ private ingest-phase reader).
- `cli/src/core/Locks.test.ts` — tests for `isWorkerBlockingBusy`.
- `cli/src/core/SessionTracker.ts` — add `countActiveSummaryQueueEntries(cwd)`.
- `cli/src/core/SessionTracker.test.ts` — tests for the filtered count.
- `cli/src/Api.ts` — register the new command.
- `cli/src/mcp/McpServer.ts` — add `queue_status` tool def + dispatch case.
- `cli/src/mcp/McpTools.ts` — add `runQueueStatus`.
- `cli/src/mcp/McpTools.test.ts` — test `runQueueStatus`.
- `cli/src/core/PrDescription.ts` — add `queueActive` + `workerBlocking` to `PrDescriptionResult`.
- `cli/src/core/PrDescription.test.ts` — assert the new fields.
- `cli/src/install/SkillInstaller.ts` — add "Step 0" to `buildPrSkillTemplate`.
- `cli/src/install/SkillInstaller.test.ts` — assert Step 0 content.

---

## Task 1: `isWorkerBlockingBusy` in Locks.ts

Ports the vscode `LockUtils.isWorkerBlockingBusy` semantics into the CLI core so the queue status can tell "worker generating a summary" apart from "worker rendering the wiki/graph".

**Files:**
- Modify: `cli/src/core/Locks.ts`
- Test: `cli/src/core/Locks.test.ts`

**Interfaces:**
- Consumes: existing `isWorkerLockHeld(cwd)`, `LOCK_TIMEOUT_MS`, `WORKER_PHASE_FILE`, `getJolliMemoryDir` (all already in `Locks.ts`).
- Produces: `isWorkerBlockingBusy(cwd?: string): Promise<boolean>` — true when `worker.lock` is held AND the `worker-phase` marker is not a fresh `ingest*` phase.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/Locks.test.ts` (follow the file's existing tempdir + `getJolliMemoryDir` setup; these tests write directly under `<tmp>/.jolli/jollimemory/`):

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWorkerBlockingBusy } from "./Locks.js";
import { getJolliMemoryDir } from "../Logger.js";

describe("isWorkerBlockingBusy", () => {
	async function jmDir(cwd: string): Promise<string> {
		const dir = getJolliMemoryDir(cwd);
		await mkdir(dir, { recursive: true });
		return dir;
	}

	it("is false when no worker lock is held", async () => {
		expect(await isWorkerBlockingBusy(tempDir)).toBe(false);
	});

	it("is true when the lock is held and no phase marker exists (default summary phase)", async () => {
		const dir = await jmDir(tempDir);
		await writeFile(join(dir, "worker.lock"), String(process.pid));
		expect(await isWorkerBlockingBusy(tempDir)).toBe(true);
	});

	it("is false when the lock is held and a fresh ingest phase is active", async () => {
		const dir = await jmDir(tempDir);
		await writeFile(join(dir, "worker.lock"), String(process.pid));
		await writeFile(join(dir, "worker-phase"), "ingest:wiki");
		expect(await isWorkerBlockingBusy(tempDir)).toBe(false);
	});

	it("is true when the phase marker is a non-ingest value", async () => {
		const dir = await jmDir(tempDir);
		await writeFile(join(dir, "worker.lock"), String(process.pid));
		await writeFile(join(dir, "worker-phase"), "summary");
		expect(await isWorkerBlockingBusy(tempDir)).toBe(true);
	});
});
```

- [ ] **Step 2: Run the targeted test — expect FAIL**

Run: `npm run test -w @jolli.ai/cli -- src/core/Locks.test.ts -t "isWorkerBlockingBusy"`
Expected: FAIL — `isWorkerBlockingBusy is not a function` / not exported.

- [ ] **Step 3: Implement in `cli/src/core/Locks.ts`**

Add `readFile` to the existing `node:fs/promises` import:

```ts
import { mkdir, readFile, stat } from "node:fs/promises";
```

Append these functions (place them right after `isWorkerLockStale`, near line 260):

```ts
/**
 * True when the `worker-phase` marker is a fresh `ingest*` phase. Mirrors the
 * vscode `LockUtils.isFreshIngestPhase`: the worker writes `ingest:wiki` /
 * `ingest:graph` (older workers: bare `ingest`) and heartbeats the marker, so a
 * stale marker is residue from a failed cleanup and is treated as NOT ingest
 * (fail-safe → the run is assumed to be a blocking summary).
 */
async function isFreshIngestPhase(cwd?: string): Promise<boolean> {
	const phasePath = join(getJolliMemoryDir(cwd), WORKER_PHASE_FILE);
	try {
		const content = await readFile(phasePath, "utf-8");
		if (!content.trim().startsWith("ingest")) return false;
		const phaseStat = await stat(phasePath);
		return Date.now() - phaseStat.mtimeMs < LOCK_TIMEOUT_MS;
	} catch {
		return false;
	}
}

/**
 * True only when the worker is busy with a phase that generates memory
 * summaries — i.e. `worker.lock` is held AND the current phase is not a fresh
 * ingest (wiki/graph) phase. Callers waiting on "is a summary still being
 * written?" use this, not `isWorkerLockHeld`, so they never block on Memory
 * Bank wiki/graph rendering. CLI analogue of vscode `LockUtils.isWorkerBlockingBusy`.
 */
export async function isWorkerBlockingBusy(cwd?: string): Promise<boolean> {
	if (!(await isWorkerLockHeld(cwd))) return false;
	return !(await isFreshIngestPhase(cwd));
}
```

- [ ] **Step 4: Run the targeted test — expect PASS**

Run: `npm run test -w @jolli.ai/cli -- src/core/Locks.test.ts -t "isWorkerBlockingBusy"`
Expected: PASS (4 tests).

---

## Task 2: `countActiveSummaryQueueEntries` in SessionTracker.ts

Adds a queue count that excludes ingest entries, reusing the existing active-entry read pattern.

**Files:**
- Modify: `cli/src/core/SessionTracker.ts`
- Test: `cli/src/core/SessionTracker.test.ts`

**Interfaces:**
- Consumes: `GitOperation`, `isIngestOperation` (from `../Types.js`), `GIT_OP_QUEUE_DIR`, `GIT_OP_QUEUE_STALE_MS` (module-local constants).
- Produces: `countActiveSummaryQueueEntries(cwd?: string): Promise<number>` — count of non-stale queue entries whose `type` is NOT `ingest`.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/SessionTracker.test.ts` (reuse the file's tempdir + queue-writing helpers; the queue dir is `<getJolliMemoryDir(cwd)>/git-op-queue/`). Write entries as `{timestamp}-{tag}.json` files:

```ts
import { isIngestOperation } from "../Types.js";
import { countActiveSummaryQueueEntries } from "./SessionTracker.js";

describe("countActiveSummaryQueueEntries", () => {
	async function writeQueueEntry(cwd: string, name: string, op: object): Promise<void> {
		const dir = join(getJolliMemoryDir(cwd), "git-op-queue");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, name), JSON.stringify(op));
	}

	it("returns 0 when the queue dir is absent", async () => {
		expect(await countActiveSummaryQueueEntries(tempDir)).toBe(0);
	});

	it("counts commit-type entries and excludes ingest entries", async () => {
		const now = new Date().toISOString();
		await writeQueueEntry(tempDir, "1-a.json", { type: "commit", commitHash: "a", createdAt: now });
		await writeQueueEntry(tempDir, "2-b.json", { type: "squash", commitHash: "b", createdAt: now });
		await writeQueueEntry(tempDir, "3-ingest.json", { type: "ingest", triggeredBy: "post-commit", createdAt: now });
		expect(await countActiveSummaryQueueEntries(tempDir)).toBe(2);
	});

	it("excludes stale entries", async () => {
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		await writeQueueEntry(tempDir, "1-old.json", { type: "commit", commitHash: "a", createdAt: old });
		expect(await countActiveSummaryQueueEntries(tempDir)).toBe(0);
	});
});
```

- [ ] **Step 2: Run the targeted test — expect FAIL**

Run: `npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts -t "countActiveSummaryQueueEntries"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `cli/src/core/SessionTracker.ts`**

Ensure `isIngestOperation` is imported from `../Types.js` (add it to the existing type import from that module). Add this function next to `countActiveQueueEntries` (near line 528):

```ts
/**
 * Counts active (non-stale) queue entries that produce a memory summary —
 * every op EXCEPT `ingest` (wiki/graph rendering). Used by the queue-status /
 * PR-wait path so building a PR never blocks on Memory Bank wiki generation.
 */
export async function countActiveSummaryQueueEntries(cwd?: string): Promise<number> {
	const queueDir = join(getJolliMemoryDir(cwd), GIT_OP_QUEUE_DIR);
	let files: string[];
	try {
		files = await readdir(queueDir);
	} catch {
		return 0;
	}

	const now = Date.now();
	let count = 0;
	for (const file of files.filter((f) => f.endsWith(".json"))) {
		try {
			const content = await readFile(join(queueDir, file), "utf-8");
			const op = JSON.parse(content) as GitOperation;
			const age = now - new Date(op.createdAt).getTime();
			if (age <= GIT_OP_QUEUE_STALE_MS && !isIngestOperation(op)) {
				count++;
			}
		} catch {
			// Corrupt entry — ignore (treated as neither active-summary nor countable).
		}
	}
	return count;
}
```

- [ ] **Step 4: Run the targeted test — expect PASS**

Run: `npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts -t "countActiveSummaryQueueEntries"`
Expected: PASS (3 tests).

---

## Task 3: `QueueStatus` core (snapshot + bounded wait)

Composes Task 1 + Task 2 into the status object and the poll loop.

**Files:**
- Create: `cli/src/core/QueueStatus.ts`
- Test: `cli/src/core/QueueStatus.test.ts`

**Interfaces:**
- Consumes: `isWorkerLockHeld`, `isWorkerBlockingBusy` (Task 1) from `./Locks.js`; `countActiveQueueEntries`, `countActiveSummaryQueueEntries` (Task 2), `countStaleQueueEntries` from `./SessionTracker.js`.
- Produces:
  - `interface QueueStatus { active: number; ingestActive: number; workerBusy: boolean; workerBlocking: boolean; drained: boolean; stale: number; }`
  - `getQueueStatus(cwd?: string): Promise<QueueStatus>`
  - `waitForQueueDrained(cwd: string | undefined, opts?: { timeoutMs?: number; pollMs?: number }): Promise<QueueStatus & { waitedMs: number }>`
  - `const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 120_000; const DEFAULT_QUEUE_WAIT_POLL_MS = 1_000;`

- [ ] **Step 1: Write the failing test**

Create `cli/src/core/QueueStatus.test.ts`:

```ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";
import { getQueueStatus, waitForQueueDrained } from "./QueueStatus.js";

let tempDir: string;

async function queueDir(): Promise<string> {
	const dir = join(getJolliMemoryDir(tempDir), "git-op-queue");
	await mkdir(dir, { recursive: true });
	return dir;
}

async function writeSummaryEntry(name: string): Promise<string> {
	const dir = await queueDir();
	const path = join(dir, name);
	await writeFile(path, JSON.stringify({ type: "commit", commitHash: "a", createdAt: new Date().toISOString() }));
	return path;
}

beforeEach(async () => {
	tempDir = join(tmpdir(), `qstatus-${process.pid}-${Math.floor(Date.now() % 1e9)}`);
	await mkdir(tempDir, { recursive: true });
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("getQueueStatus", () => {
	it("reports drained on an empty queue with no worker", async () => {
		const s = await getQueueStatus(tempDir);
		expect(s).toMatchObject({ active: 0, workerBlocking: false, drained: true });
	});

	it("is not drained while a summary entry is queued", async () => {
		await writeSummaryEntry("1-a.json");
		const s = await getQueueStatus(tempDir);
		expect(s.active).toBe(1);
		expect(s.drained).toBe(false);
	});

	it("is drained when only an ingest entry is queued and no worker runs", async () => {
		const dir = await queueDir();
		await writeFile(
			join(dir, "1-ingest.json"),
			JSON.stringify({ type: "ingest", triggeredBy: "post-commit", createdAt: new Date().toISOString() }),
		);
		const s = await getQueueStatus(tempDir);
		expect(s.active).toBe(0);
		expect(s.ingestActive).toBe(1);
		expect(s.drained).toBe(true);
	});
});

describe("waitForQueueDrained", () => {
	it("returns not-drained after the timeout when work stays queued", async () => {
		await writeSummaryEntry("1-a.json");
		const r = await waitForQueueDrained(tempDir, { timeoutMs: 40, pollMs: 5 });
		expect(r.drained).toBe(false);
		expect(r.waitedMs).toBeGreaterThanOrEqual(40);
	});

	it("returns drained once the entry is removed mid-wait", async () => {
		const path = await writeSummaryEntry("1-a.json");
		setTimeout(() => void rm(path, { force: true }), 15);
		const r = await waitForQueueDrained(tempDir, { timeoutMs: 500, pollMs: 5 });
		expect(r.drained).toBe(true);
	});
});
```

- [ ] **Step 2: Run the targeted test — expect FAIL**

Run: `npm run test -w @jolli.ai/cli -- src/core/QueueStatus.test.ts`
Expected: FAIL — module `./QueueStatus.js` not found.

- [ ] **Step 3: Implement `cli/src/core/QueueStatus.ts`**

```ts
/**
 * QueueStatus — a single verdict on whether memory-summary generation is still
 * in progress for a worktree, plus a bounded wait loop.
 *
 * `drained` is decided by two axes only: (1) no non-ingest queue entries remain,
 * and (2) the worker is not blocking-busy (not mid-summary). Wiki/graph ingest
 * entries and the ingest worker phase are intentionally excluded so the PR-wait
 * path never blocks on Memory Bank wiki rendering. The other fields are
 * informational (debugging / progress messaging).
 */

import { isWorkerBlockingBusy, isWorkerLockHeld } from "./Locks.js";
import {
	countActiveQueueEntries,
	countActiveSummaryQueueEntries,
	countStaleQueueEntries,
} from "./SessionTracker.js";

export interface QueueStatus {
	/** Non-stale queue entries that produce a summary (ingest excluded). */
	active: number;
	/** Non-stale ingest (wiki/graph) entries — informational. */
	ingestActive: number;
	/** worker.lock held, any phase — informational. */
	workerBusy: boolean;
	/** worker.lock held AND not a fresh ingest phase (a summary is in flight). */
	workerBlocking: boolean;
	/** active === 0 && !workerBlocking. */
	drained: boolean;
	/** Stale (age > 7d) entries lingering in the queue — informational. */
	stale: number;
}

export const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 120_000;
export const DEFAULT_QUEUE_WAIT_POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the current queue/worker state without blocking. */
export async function getQueueStatus(cwd?: string): Promise<QueueStatus> {
	const [active, totalActive, stale, workerBusy, workerBlocking] = await Promise.all([
		countActiveSummaryQueueEntries(cwd),
		countActiveQueueEntries(cwd),
		countStaleQueueEntries(cwd),
		isWorkerLockHeld(cwd),
		isWorkerBlockingBusy(cwd),
	]);
	const ingestActive = Math.max(0, totalActive - active);
	const drained = active === 0 && !workerBlocking;
	return { active, ingestActive, workerBusy, workerBlocking, drained, stale };
}

/**
 * Polls `getQueueStatus` until `drained` or `timeoutMs` elapses. Returns the
 * final status plus `waitedMs`. Never blocks longer than the timeout, so a
 * crashed worker (stale lock) cannot hang the caller — the caller decides what
 * to do with a non-drained result.
 */
export async function waitForQueueDrained(
	cwd: string | undefined,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<QueueStatus & { waitedMs: number }> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? DEFAULT_QUEUE_WAIT_POLL_MS;
	const start = Date.now();
	for (;;) {
		const status = await getQueueStatus(cwd);
		const waitedMs = Date.now() - start;
		if (status.drained || waitedMs >= timeoutMs) {
			return { ...status, waitedMs };
		}
		await sleep(Math.min(pollMs, Math.max(1, timeoutMs - waitedMs)));
	}
}
```

- [ ] **Step 4: Run the targeted test — expect PASS**

Run: `npm run test -w @jolli.ai/cli -- src/core/QueueStatus.test.ts`
Expected: PASS (5 tests).

---

## Task 4: `jolli queue-status` CLI command

**Files:**
- Create: `cli/src/commands/QueueStatusCommand.ts`
- Modify: `cli/src/Api.ts`
- Test: `cli/src/commands/QueueStatusCommand.test.ts`

**Interfaces:**
- Consumes: `getQueueStatus`, `waitForQueueDrained` (Task 3); `resolveProjectDir` from `./CliUtils.js`; `setLogDir` from `../Logger.js`; `Command`, `Option` from `commander`.
- Produces: `registerQueueStatusCommand(program: Command): void`. Command name `queue-status`, options `--wait`, `--timeout <seconds>`, `--format json`, `--cwd <dir>`.

- [ ] **Step 1: Write the failing test**

Create `cli/src/commands/QueueStatusCommand.test.ts`. Model it on `PrDescriptionCommand.test.ts` (build a `Command`, register, `parseAsync`, capture `console.log`):

```ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";
import { registerQueueStatusCommand } from "./QueueStatusCommand.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = join(tmpdir(), `qcmd-${process.pid}-${Math.floor(Date.now() % 1e9)}`);
	await mkdir(tempDir, { recursive: true });
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function run(args: string[]): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerQueueStatusCommand(program);
	await program.parseAsync(["node", "jolli", "queue-status", "--cwd", tempDir, ...args]);
	return logs.join("\n");
}

describe("queue-status command", () => {
	it("prints drained JSON for an empty queue", async () => {
		const out = await run(["--format", "json"]);
		expect(JSON.parse(out)).toMatchObject({ active: 0, drained: true });
	});

	it("prints not-drained JSON while a summary entry is queued", async () => {
		const dir = join(getJolliMemoryDir(tempDir), "git-op-queue");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "1-a.json"),
			JSON.stringify({ type: "commit", commitHash: "a", createdAt: new Date().toISOString() }),
		);
		const out = await run(["--format", "json"]);
		expect(JSON.parse(out)).toMatchObject({ active: 1, drained: false });
	});

	it("--wait returns waitedMs and drained on an empty queue", async () => {
		const out = await run(["--wait", "--timeout", "1", "--format", "json"]);
		const parsed = JSON.parse(out);
		expect(parsed.drained).toBe(true);
		expect(parsed).toHaveProperty("waitedMs");
	});

	it("prints a human-readable summary without --format json", async () => {
		const out = await run([]);
		expect(out).toMatch(/drained|generating|queue/i);
	});
});
```

- [ ] **Step 2: Run the targeted test — expect FAIL**

Run: `npm run test -w @jolli.ai/cli -- src/commands/QueueStatusCommand.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cli/src/commands/QueueStatusCommand.ts`**

```ts
/**
 * QueueStatusCommand — report whether memory-summary generation is still
 * in progress for the current worktree, and optionally wait for it to drain.
 *
 * This is the CLI surface the `jolli-pr` skill polls before building a PR so
 * freshly-committed summaries are included. Wiki/graph ingest is excluded from
 * the "still generating" verdict (see QueueStatus).
 *
 * Output modes:
 *   - `--format json` — the full status object (skill/agent consumption)
 *   - Default — a one-line human-readable summary
 */

import { type Command, Option } from "commander";
import { getQueueStatus, waitForQueueDrained } from "../core/QueueStatus.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

interface QueueStatusOptions {
	wait?: boolean;
	timeout?: string;
	format?: string;
	cwd: string;
}

/** Registers the `queue-status` command on the given Commander program. */
export function registerQueueStatusCommand(program: Command): void {
	program
		.command("queue-status")
		.description("Report whether memory-summary generation is still in progress (skill/agent consumption)")
		.option("--wait", "Block until the queue drains or the timeout elapses")
		.option("--timeout <seconds>", "Max seconds to wait with --wait (default 120)")
		.addOption(new Option("--format <fmt>", "Output format").choices(["json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: QueueStatusOptions) => {
			try {
				const projectDir = options.cwd;
				setLogDir(projectDir);

				const timeoutMs = options.timeout ? Math.max(0, Number(options.timeout)) * 1000 : undefined;
				const result = options.wait
					? await waitForQueueDrained(projectDir, { timeoutMs })
					: await getQueueStatus(projectDir);

				if (options.format === "json") {
					console.log(JSON.stringify(result));
				} else if (result.drained) {
					console.log("\n  Memory generation is idle (queue drained).\n");
				} else {
					console.log(`\n  ${result.active} memory summary(ies) still generating.\n`);
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				if (options.format === "json") {
					console.log(JSON.stringify({ type: "error", message }));
				} else {
					console.error(`\n  Error: ${message}\n`);
				}
				process.exitCode = 1;
			}
		});
}
```

- [ ] **Step 4: Register in `cli/src/Api.ts`**

Add the import next to the other command imports (near line 25):

```ts
import { registerQueueStatusCommand } from "./commands/QueueStatusCommand.js";
```

Add the registration call next to `registerPrDescriptionCommand(program);` (near line 339):

```ts
	registerQueueStatusCommand(program);
```

- [ ] **Step 5: Run the targeted test — expect PASS**

Run: `npm run test -w @jolli.ai/cli -- src/commands/QueueStatusCommand.test.ts`
Expected: PASS (4 tests).

---

## Task 5: `queue_status` MCP tool

**Files:**
- Modify: `cli/src/mcp/McpTools.ts`, `cli/src/mcp/McpServer.ts`
- Test: `cli/src/mcp/McpTools.test.ts`

**Interfaces:**
- Consumes: `getQueueStatus`, `waitForQueueDrained`, `QueueStatus` (Task 3).
- Produces: `runQueueStatus(cwd: string, args: { wait?: boolean; timeoutMs?: number }): Promise<QueueStatus & { waitedMs?: number }>`; a `queue_status` entry in `TOOL_DEFINITIONS`; a dispatch case.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/mcp/McpTools.test.ts` (reuse its tempdir setup; write a queue entry directly under `<getJolliMemoryDir(cwd)>/git-op-queue/`):

```ts
import { runQueueStatus } from "./McpTools.js";

describe("runQueueStatus", () => {
	it("returns drained for an empty queue", async () => {
		const r = await runQueueStatus(tempDir, {});
		expect(r).toMatchObject({ active: 0, drained: true });
	});

	it("returns waitedMs when wait is requested", async () => {
		const r = await runQueueStatus(tempDir, { wait: true, timeoutMs: 20 });
		expect(r).toHaveProperty("waitedMs");
	});
});
```

- [ ] **Step 2: Run the targeted test — expect FAIL**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpTools.test.ts -t "runQueueStatus"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the handler in `cli/src/mcp/McpTools.ts`**

Add the import near the other core imports (with the existing `PrDescription` import):

```ts
import { getQueueStatus, type QueueStatus, waitForQueueDrained } from "../core/QueueStatus.js";
```

Append the handler at the end of the file:

```ts
export interface QueueStatusArgs {
	wait?: boolean;
	timeoutMs?: number;
}

export async function runQueueStatus(
	cwd: string,
	args: QueueStatusArgs,
): Promise<QueueStatus & { waitedMs?: number }> {
	if (args.wait) {
		return waitForQueueDrained(cwd, { timeoutMs: args.timeoutMs });
	}
	return getQueueStatus(cwd);
}
```

- [ ] **Step 4: Wire the tool in `cli/src/mcp/McpServer.ts`**

Add `runQueueStatus` to the import from `./McpTools.js`:

```ts
import {
	runDecisionTimeline,
	runGetPrDescription,
	runListBranches,
	runQueueStatus,
	runRecall,
	runSearch,
} from "./McpTools.js";
```

Add this entry to `TOOL_DEFINITIONS` (after the `get_pr_description` entry):

```ts
	{
		name: "queue_status",
		description:
			"Report whether this repo's memory-summary generation is still in progress. Call before building a PR (get_pr_description) so freshly-committed summaries are included. Wiki/graph rendering is excluded from the verdict. Pass {\"wait\": true} to block until drained (default 120s, override with timeoutMs).",
		inputSchema: {
			type: "object",
			properties: {
				wait: { type: "boolean", description: "Block until the queue drains or the timeout elapses." },
				timeoutMs: { type: "number", description: "Max ms to wait when wait is true (default 120000)." },
			},
		},
	},
```

Add the dispatch case (after the `get_pr_description` case):

```ts
		case "queue_status":
			return runQueueStatus(cwd, args as { wait?: boolean; timeoutMs?: number });
```

- [ ] **Step 5: Run the targeted test — expect PASS**

Run: `npm run test -w @jolli.ai/cli -- src/mcp/McpTools.test.ts -t "runQueueStatus"`
Expected: PASS (2 tests).

---

## Task 6: `get_pr_description` backstop fields

**Files:**
- Modify: `cli/src/core/PrDescription.ts`
- Test: `cli/src/core/PrDescription.test.ts`

**Interfaces:**
- Consumes: `getQueueStatus` (Task 3).
- Produces: `PrDescriptionResult` gains `queueActive: number` and `workerBlocking: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/PrDescription.test.ts` a field-presence assertion on a successful build. Reuse the file's existing fixture that yields at least one summary; append field checks to that test (or add a focused one):

```ts
it("includes queueActive and workerBlocking backstop fields", async () => {
	// (reuse the existing successful-build setup in this file that stores >=1 summary)
	const result = await buildPrDescription(cwd, {});
	expect(result).toHaveProperty("queueActive");
	expect(result).toHaveProperty("workerBlocking");
	expect(typeof result.queueActive).toBe("number");
	expect(typeof result.workerBlocking).toBe("boolean");
});
```

- [ ] **Step 2: Run the targeted test — expect FAIL**

Run: `npm run test -w @jolli.ai/cli -- src/core/PrDescription.test.ts -t "backstop"`
Expected: FAIL — properties absent.

- [ ] **Step 3: Implement in `cli/src/core/PrDescription.ts`**

Add the import:

```ts
import { getQueueStatus } from "./QueueStatus.js";
```

Extend the interface (after `missingCount: number;`):

```ts
	/** Non-ingest queue entries still pending — backstop so a single call reveals in-progress generation. */
	queueActive: number;
	/** True when a summary is still being written (worker blocking-busy). */
	workerBlocking: boolean;
```

In `buildPrDescription`, compute status just before the return (after `const body = …`) and add the fields:

```ts
	const queue = await getQueueStatus(cwd);

	return {
		type: "pr_description",
		branch,
		baseBranch,
		title,
		body,
		commitCount: summaries.length + missingCount,
		summaryCount: summaries.length,
		missingCount,
		queueActive: queue.active,
		workerBlocking: queue.workerBlocking,
	};
```

- [ ] **Step 4: Run the targeted test — expect PASS**

Run: `npm run test -w @jolli.ai/cli -- src/core/PrDescription.test.ts`
Expected: PASS (existing tests still green + the new one).

---

## Task 7: `jolli-pr` skill — Step 0 wait gate

**Files:**
- Modify: `cli/src/install/SkillInstaller.ts`
- Test: `cli/src/install/SkillInstaller.test.ts`

**Interfaces:**
- Consumes: nothing new (template string only).
- Produces: `buildPrSkillTemplate()` output gains a "## Step 0: Wait for pending memory" section before "## Step 1".

- [ ] **Step 1: Write the failing test**

Add to `cli/src/install/SkillInstaller.test.ts`, alongside the existing PR-template assertions (near line 165, where `pr` is the built PR template string):

```ts
it("the jolli-pr template gates on queue-status before building the description", () => {
	const pr = buildPrSkillTemplate();
	expect(pr).toContain("## Step 0: Wait for pending memory");
	expect(pr).toContain("queue-status");
	expect(pr).toContain("queue_status");
	// Step 0 must come before Step 1.
	expect(pr.indexOf("## Step 0")).toBeLessThan(pr.indexOf("## Step 1"));
});
```

If `buildPrSkillTemplate` is not already imported/exported in the test, export it from `SkillInstaller.ts` (it is currently module-private) and import it in the test.

- [ ] **Step 2: Run the targeted test — expect FAIL**

Run: `npm run test -w @jolli.ai/cli -- src/install/SkillInstaller.test.ts -t "Step 0"`
Expected: FAIL — Step 0 not present (and/or `buildPrSkillTemplate` not exported).

- [ ] **Step 3: Implement in `cli/src/install/SkillInstaller.ts`**

If needed, change `function buildPrSkillTemplate()` to `export function buildPrSkillTemplate()`.

Insert this block into the template string, immediately before the `## Step 1: Get the PR description` heading (after the `## Hard rule …` section, near line 522). Note: all backticks are escaped as `\`` because the template is itself a backtick literal (see the builder-backtick trap in this repo):

```ts
## Step 0: Wait for pending memory

A freshly-committed change is summarized by a detached background worker that
can take tens of seconds. If you build the PR before it finishes, those commits
land in the "skipped" footnote instead of the body. So first make sure memory
generation is idle.

### Probe the queue

Preferred (MCP): call the \`queue_status\` tool (on Claude Code
\`mcp__jollimemory__queue_status\`) with no arguments.

Fallback (CLI):

\`\`\`bash
"$HOME/.jolli/jollimemory/run-cli" queue-status --format json
\`\`\`

Both return a status object:

\`\`\`json
{ "active": 2, "workerBlocking": true, "drained": false }
\`\`\`

- If \`drained\` is \`true\` → skip straight to Step 1.
- Otherwise tell the user "N memory summaries are still generating — waiting…"
  (N = \`active\`), then wait for it to finish:

  Preferred (MCP): call \`queue_status\` with \`{"wait": true, "timeoutMs": 120000}\`.

  Fallback (CLI):

  \`\`\`bash
  "$HOME/.jolli/jollimemory/run-cli" queue-status --wait --timeout 120 --format json
  \`\`\`

- The wait call returns \`drained: true\` → continue to Step 1.
- It returns \`drained: false\` (timed out) → **STOP and ask the user**:
  "Memory is still generating after 120s. Keep waiting, or create the PR now
  with what's ready?" Continue only when they answer; if they choose to keep
  waiting, repeat the wait call.

\`active\` counts only memory-summary work — Memory Bank wiki/graph rendering is
intentionally excluded, so this never blocks on wiki generation.

```

- [ ] **Step 4: Run the targeted test — expect PASS**

Run: `npm run test -w @jolli.ai/cli -- src/install/SkillInstaller.test.ts -t "Step 0"`
Expected: PASS.

---

## Task 8: Full verification + single commit

**Files:** none (gate + commit only).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all pass; CLI coverage stays at/above 97/96/97/97. If coverage dips on any new file, add the missing-branch test (e.g. the command's error path, `getQueueStatus` with a worker lock present) rather than an ignore block.

- [ ] **Step 2: Stage and commit (single, signed, no AI trailer)**

```bash
git add cli/src/core/QueueStatus.ts cli/src/core/QueueStatus.test.ts \
  cli/src/commands/QueueStatusCommand.ts cli/src/commands/QueueStatusCommand.test.ts \
  cli/src/core/Locks.ts cli/src/core/Locks.test.ts \
  cli/src/core/SessionTracker.ts cli/src/core/SessionTracker.test.ts \
  cli/src/mcp/McpServer.ts cli/src/mcp/McpTools.ts cli/src/mcp/McpTools.test.ts \
  cli/src/core/PrDescription.ts cli/src/core/PrDescription.test.ts \
  cli/src/Api.ts cli/src/install/SkillInstaller.ts cli/src/install/SkillInstaller.test.ts
git commit -s -m "feat(cli): jolli-pr waits for pending memory before building the PR

Add jolli queue-status CLI + queue_status MCP tool that report (and optionally
wait for) in-progress memory-summary generation, excluding wiki/graph ingest.
get_pr_description gains queueActive/workerBlocking backstop fields, and the
jolli-pr skill gains a Step 0 wait gate."
```

Do NOT add a `Co-Authored-By: Claude` trailer or a "Generated with Claude" footer.

---

## Self-Review

**1. Spec coverage:**
- Two new surfaces (`jolli queue-status` CLI + `queue_status` MCP) → Tasks 4, 5. ✅
- Wait predicate excludes ingest (queue layer + worker layer) → Task 1 (`isWorkerBlockingBusy`) + Task 2 (`countActiveSummaryQueueEntries`) + Task 3 (`drained = active===0 && !workerBlocking`). ✅
- Bounded wait, timeout → ask → Task 3 (`waitForQueueDrained`) + Task 7 (skill STOP-and-ask on `drained:false`). ✅
- `get_pr_description` backstop fields → Task 6. ✅
- Skill Step 0 (auto-wait + visible message, timeout asks) → Task 7. ✅
- Testing + 97% floor + single `npm run all` + single signed commit → Task 8 + Global Constraints. ✅
- Out-of-scope items (Q2 push/space, vscode LockUtils consolidation, IntelliJ) → not implemented, as specified. ✅

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. The only "reuse the existing fixture" note (Task 6 Step 1) points at concrete existing test scaffolding rather than inventing a new summary-store fixture — acceptable because that setup already exists in `PrDescription.test.ts`.

**3. Type consistency:** `QueueStatus` fields (`active`, `ingestActive`, `workerBusy`, `workerBlocking`, `drained`, `stale`) are used identically in Tasks 3/4/5/6. `isWorkerBlockingBusy` (Task 1) name matches its consumer in Task 3. `countActiveSummaryQueueEntries` (Task 2) name matches its consumer in Task 3. `runQueueStatus` signature matches the dispatch case in Task 5.
