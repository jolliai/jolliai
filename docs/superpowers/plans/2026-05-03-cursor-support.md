# Cursor Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cursor (the IDE) as a fifth `TranscriptSource`. The CLI discovers Cursor Composer transcripts on every commit by scanning Cursor's local SQLite (`globalStorage/state.vscdb` `cursorDiskKV` table) using a "β′" attribution algorithm — workspace pointer + 48 h time window. No hooks, no Cursor-side files, no VS Code extension changes.

**Architecture:** Mirrors the OpenCode pattern (passive SQLite discovery, no hook). Three new files in `cli/src/core/` (`CursorDetector.ts`, `CursorSessionDiscoverer.ts`, `CursorTranscriptReader.ts`) and one shared refactor (`SqliteHelpers.ts` extracted from OpenCode). Wired into `Installer.ts`, `QueueWorker.ts`, `StatusCommand.ts`, `ConfigureCommand.ts`, and `SessionTracker.ts`. See [`docs/superpowers/specs/2026-05-03-cursor-support-design.md`](../specs/2026-05-03-cursor-support-design.md).

**Tech Stack:** TypeScript 5, Node 22.5+ (`node:sqlite` built-in), Vitest, Biome (tabs, 120-col), npm workspaces. The implementation lives in the `cli/` workspace only.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `cli/src/core/SqliteHelpers.ts` | **Create** | `withSqliteDb`, `hasNodeSqliteSupport`, `NODE_SQLITE_MIN_VERSION`, `classifyScanError`, `SqliteScanError`, `SqliteScanErrorKind`. Extracted from OpenCode. |
| `cli/src/core/SqliteHelpers.test.ts` | **Create** | Unit tests for `classifyScanError` and `hasNodeSqliteSupport`. |
| `cli/src/core/OpenCodeSessionDiscoverer.ts` | **Modify** | Import from `SqliteHelpers.ts` (replace 4 inlined definitions). Re-export under old names for one minor version of compat. |
| `cli/src/core/OpenCodeTranscriptReader.ts` | **Modify** | Switch import from `withOpenCodeDb` to `withSqliteDb` (1 line). |
| `cli/src/core/OpenCodeSessionDiscoverer.test.ts` | **Modify** | Update import paths. Tests for `classifyScanError`/`hasNodeSqliteSupport` migrate to `SqliteHelpers.test.ts`. |
| `cli/src/Types.ts` | **Modify** | Add `"cursor"` to `TranscriptSource` union; add `cursorEnabled` to `JolliMemoryConfig`; add `cursorDetected`, `cursorEnabled`, `cursorScanError` to `StatusInfo`. |
| `cli/src/core/SessionTracker.ts` | **Modify** | `filterSessionsByEnabledIntegrations`: add cursor branch. |
| `cli/src/core/SessionTracker.test.ts` | **Modify** | Add a cursor-disabled filtering test. |
| `cli/src/core/CursorDetector.ts` | **Create** | `isCursorInstalled()`: checks app bundle, db file, and `hasNodeSqliteSupport()`. Platform-aware paths. |
| `cli/src/core/CursorDetector.test.ts` | **Create** | Tests for installed/not-installed across platforms. |
| `cli/src/core/CursorSessionDiscoverer.ts` | **Create** | β′ algorithm: workspace lookup → anchor pointers → time-window union. Exports `discoverCursorSessions`, `scanCursorSessions`, `getCursorGlobalDbPath`. |
| `cli/src/core/CursorSessionDiscoverer.test.ts` | **Create** | Unit tests with real fixture SQLite databases. |
| `cli/src/core/CursorTranscriptReader.ts` | **Create** | `readCursorTranscript(path, cursor?, beforeTimestamp?)`. Reads composerData → bubbleId rows, maps `bubble.type` to role. |
| `cli/src/core/CursorTranscriptReader.test.ts` | **Create** | Unit tests for ordering, type→role mapping, cursor resume, beforeTimestamp. |
| `cli/src/hooks/QueueWorker.ts` | **Modify** | `loadSessionTranscripts` discoverer fan-out + `readAllTranscripts` source dispatch. |
| `cli/src/install/Installer.ts` | **Modify** | Auto-detect cursor at install time + populate `cursorDetected`/`cursorEnabled`/`cursorScanError` in `getStatus`. |
| `cli/src/commands/StatusCommand.ts` | **Modify** | Add Cursor integration row. |
| `cli/src/commands/ConfigureCommand.ts` | **Modify** | Add `cursorEnabled` to `VALID_CONFIG_KEYS` and the boolean coerce branch. |

---

## Pre-flight

- [ ] **Verify branch and clean state**

```bash
cd /Users/flyer/jolli/code/jollimemory
git status --short
git branch --show-current
```

Expected: branch is `feature-support-cursor`, working tree clean.

- [ ] **Confirm baseline tests pass before starting**

```bash
npm run test -w @jolli.ai/cli
```

Expected: all tests pass. (Coverage threshold may be at the threshold — that's the baseline we maintain.)

---

## Task 1: Extract `SqliteHelpers.ts` (pure refactor)

**Files:**
- Create: `cli/src/core/SqliteHelpers.ts`
- Create: `cli/src/core/SqliteHelpers.test.ts`
- Modify: `cli/src/core/OpenCodeSessionDiscoverer.ts`
- Modify: `cli/src/core/OpenCodeTranscriptReader.ts`
- Modify: `cli/src/core/OpenCodeSessionDiscoverer.test.ts`

**Why this is first:** Cursor will reuse the SQLite helpers OpenCode already has, but they are currently named `withOpenCodeDb` / `OpenCodeScanError`. Extract before adding a second caller — otherwise we either duplicate or end up with cursor importing from a file named for a different agent.

- [ ] **Step 1: Create `SqliteHelpers.ts` with the renamed shared helpers**

Create a new file `cli/src/core/SqliteHelpers.ts`. Its content has four sections:

1. A module docstring noting it was extracted from OpenCode for shared SQLite agents (currently OpenCode and Cursor).
2. The `SqliteDbHandle` interface — structurally typed against `node:sqlite`'s `DatabaseSync` (do not import the type; reference the same shape with `prepare`, `close` methods).
3. The async `withSqliteDb<T>(dbPath: string, fn: (db: SqliteDbHandle) => T): Promise<T>` function — dynamically `await import("node:sqlite")`, open `new DatabaseSync(dbPath, { readOnly: true })`, run `fn`, close in `finally`.
4. `NODE_SQLITE_MIN_VERSION = { major: 22, minor: 5 } as const` and `hasNodeSqliteSupport(nodeVersion?: string): boolean` — parse the `M.m` of `process.versions.node` (or the override) and compare.
5. `SqliteScanErrorKind` union (`"corrupt" | "locked" | "permission" | "schema" | "unknown"`), `SqliteScanError` interface, and `classifyScanError(error: unknown): SqliteScanError | null` — the regex/code matchers from the existing OpenCode helper, returning `null` on `ENOENT`.

The simplest way to author this is to **copy the existing definitions verbatim from `cli/src/core/OpenCodeSessionDiscoverer.ts`** (the four matching exports plus their docstrings) and rename them in the new file:

| Old (in OpenCode) | New (in SqliteHelpers) |
|---|---|
| `OpenCodeDbHandle` | `SqliteDbHandle` |
| `withOpenCodeDb` | `withSqliteDb` |
| `OpenCodeScanErrorKind` | `SqliteScanErrorKind` |
| `OpenCodeScanError` | `SqliteScanError` |
| `hasNodeSqliteSupport` | unchanged |
| `NODE_SQLITE_MIN_VERSION` | unchanged |
| `classifyScanError` | unchanged |

Adjust the docstrings to refer to "SQLite-based agents (OpenCode, Cursor)" instead of "OpenCode".

- [ ] **Step 2: Create `SqliteHelpers.test.ts` (migrate the tests for these symbols)**

Find the existing tests in `cli/src/core/OpenCodeSessionDiscoverer.test.ts` for `classifyScanError` and `hasNodeSqliteSupport` (search the file for those names — they are top-level `describe(...)` blocks). Copy each `describe` block into a new `cli/src/core/SqliteHelpers.test.ts` file, replacing the import statement so it pulls from `./SqliteHelpers.js` instead of `./OpenCodeSessionDiscoverer.js`.

The test bodies stay identical: ENOENT → null, EACCES/EPERM → permission, SQLITE_CORRUPT/SQLITE_NOTADB → corrupt, SQLITE_BUSY/SQLITE_LOCKED → locked, "no such table"/"no such column" → schema, anything else → unknown; and the Node-version semver comparison cases (`22.5.0` true, `22.4.0` false, `18.20.4` false, etc.).

- [ ] **Step 3: Update `OpenCodeSessionDiscoverer.ts` to import from `SqliteHelpers.ts`**

Open `cli/src/core/OpenCodeSessionDiscoverer.ts`. At the top of the file, add:

```ts
import {
	classifyScanError as classifySqliteError,
	hasNodeSqliteSupport,
	NODE_SQLITE_MIN_VERSION,
	type SqliteDbHandle,
	type SqliteScanError,
	type SqliteScanErrorKind,
	withSqliteDb,
} from "./SqliteHelpers.js";
```

Then **delete** the original definitions of `OpenCodeDbHandle`, `withOpenCodeDb`, `NODE_SQLITE_MIN_VERSION`, `hasNodeSqliteSupport`, `OpenCodeScanErrorKind`, `OpenCodeScanError`, and `classifyScanError` from this file. In their place, add backwards-compat re-exports so callers that import the old names still work for one minor:

```ts
/** @deprecated use SqliteDbHandle from SqliteHelpers.js */
export type OpenCodeDbHandle = SqliteDbHandle;
/** @deprecated use withSqliteDb from SqliteHelpers.js */
export const withOpenCodeDb = withSqliteDb;
export { NODE_SQLITE_MIN_VERSION, hasNodeSqliteSupport };
/** @deprecated use SqliteScanErrorKind */
export type OpenCodeScanErrorKind = SqliteScanErrorKind;
/** @deprecated use SqliteScanError */
export type OpenCodeScanError = SqliteScanError;
export const classifyScanError = classifySqliteError;
```

Inside the file, replace internal call sites using `withOpenCodeDb(...)` with `withSqliteDb(...)`, and any `OpenCodeDbHandle` annotations with `SqliteDbHandle`. The OpenCode-specific exports (`getOpenCodeDbPath`, `isOpenCodeInstalled`, `OpenCodeScanResult`, `scanOpenCodeSessions`, `discoverOpenCodeSessions`) stay in this file.

- [ ] **Step 4: Update `OpenCodeTranscriptReader.ts` to import `withSqliteDb`**

Open `cli/src/core/OpenCodeTranscriptReader.ts`. Find the line:

```ts
import { withOpenCodeDb } from "./OpenCodeSessionDiscoverer.js";
```

Replace with:

```ts
import { withSqliteDb } from "./SqliteHelpers.js";
```

Then in the function body, replace the call site `withOpenCodeDb(...)` with `withSqliteDb(...)`.

- [ ] **Step 5: Update `OpenCodeSessionDiscoverer.test.ts`**

Open `cli/src/core/OpenCodeSessionDiscoverer.test.ts`. Remove `classifyScanError`, `hasNodeSqliteSupport`, and `NODE_SQLITE_MIN_VERSION` from the imports list, and remove the corresponding `describe(...)` blocks (they have moved to `SqliteHelpers.test.ts`). Keep imports for `discoverOpenCodeSessions`, `getOpenCodeDbPath`, `isOpenCodeInstalled`, and `scanOpenCodeSessions`.

- [ ] **Step 6: Run the lint, typecheck, and test trio**

```bash
npm run typecheck -w @jolli.ai/cli
npm run lint -w @jolli.ai/cli
npm run test -w @jolli.ai/cli
```

Expected: all green. The OpenCode test suite still passes, the new `SqliteHelpers.test.ts` passes, and coverage threshold (97% statements) holds.

- [ ] **Step 7: Commit**

```bash
git add cli/src/core/SqliteHelpers.ts cli/src/core/SqliteHelpers.test.ts \
        cli/src/core/OpenCodeSessionDiscoverer.ts cli/src/core/OpenCodeTranscriptReader.ts \
        cli/src/core/OpenCodeSessionDiscoverer.test.ts
git commit -s -m "Extract SqliteHelpers from OpenCodeSessionDiscoverer

Pulls withSqliteDb / hasNodeSqliteSupport / classifyScanError into a
neutral file before adding Cursor as a second SQLite-based source.
OpenCode keeps its old export names as @deprecated re-exports for
backwards compatibility within this minor."
```

---

## Task 2: Add `cursor` to `TranscriptSource` + config / status types

**Files:**
- Modify: `cli/src/Types.ts`
- Modify: `cli/src/core/SessionTracker.ts`
- Modify: `cli/src/core/SessionTracker.test.ts`

- [ ] **Step 1: Extend `TranscriptSource` and add config / status fields in `Types.ts`**

Open `cli/src/Types.ts`. Make these three edits:

**Edit 1:** find the `TranscriptSource` definition (around line 8) and add `"cursor"`:

```ts
export type TranscriptSource = "claude" | "codex" | "gemini" | "opencode" | "cursor";
```

**Edit 2:** in `JolliMemoryConfig` (after the `openCodeEnabled` field), add:

```ts
	/** Enable Cursor Composer session discovery at post-commit time (default: auto-detect) */
	readonly cursorEnabled?: boolean;
```

**Edit 3:** in `StatusInfo` (after the `openCodeEnabled` field, just before `globalConfigDir`), add:

```ts
	/** Whether Cursor data dir was detected (Cursor.app + state.vscdb + node:sqlite) */
	readonly cursorDetected?: boolean;
	/** Whether Cursor session discovery is enabled in config (undefined = auto-detect) */
	readonly cursorEnabled?: boolean;
	/**
	 * Cursor DB scan failed with a real (non-ENOENT) error — corrupt, locked,
	 * schema drift, or permission denied. UI surfaces this adjacent to the Cursor
	 * row instead of silently rendering "0 sessions".
	 */
	readonly cursorScanError?: {
		readonly kind: "corrupt" | "locked" | "permission" | "schema" | "unknown";
		readonly message: string;
	};
```

- [ ] **Step 2: Write failing test for cursor branch of `filterSessionsByEnabledIntegrations`**

Open `cli/src/core/SessionTracker.test.ts`. Find the existing `filterSessionsByEnabledIntegrations` describe block and add these tests:

```ts
it("filters out cursor sessions when cursorEnabled === false", () => {
	const sessions: SessionInfo[] = [
		{ sessionId: "claude-1", transcriptPath: "/c.jsonl", updatedAt: "2026-05-03T00:00:00Z", source: "claude" },
		{ sessionId: "cursor-1", transcriptPath: "/db.vscdb#abc", updatedAt: "2026-05-03T00:00:00Z", source: "cursor" },
	];
	const result = filterSessionsByEnabledIntegrations(sessions, { cursorEnabled: false });
	expect(result).toEqual([sessions[0]]);
});

it("retains cursor sessions when cursorEnabled is undefined or true", () => {
	const sessions: SessionInfo[] = [
		{ sessionId: "cursor-1", transcriptPath: "/db.vscdb#abc", updatedAt: "2026-05-03T00:00:00Z", source: "cursor" },
	];
	expect(filterSessionsByEnabledIntegrations(sessions, {})).toEqual(sessions);
	expect(filterSessionsByEnabledIntegrations(sessions, { cursorEnabled: true })).toEqual(sessions);
});
```

- [ ] **Step 3: Run the new tests to confirm they fail**

```bash
npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts -t "filters out cursor"
```

Expected: FAIL — the cursor sessions are not filtered (current code has no cursor branch).

- [ ] **Step 4: Add cursor branch to `filterSessionsByEnabledIntegrations`**

Open `cli/src/core/SessionTracker.ts`. Find the function and add a cursor branch right after the `openCodeEnabled` check (around line 167):

```ts
	if (config.openCodeEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "opencode");
	}
	if (config.cursorEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "cursor");
	}
	return filtered;
```

- [ ] **Step 5: Re-run tests**

```bash
npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts
npm run typecheck -w @jolli.ai/cli
npm run lint -w @jolli.ai/cli
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add cli/src/Types.ts cli/src/core/SessionTracker.ts cli/src/core/SessionTracker.test.ts
git commit -s -m "Add cursor literal to TranscriptSource and config types

Threads the new cursor source through TranscriptSource, JolliMemoryConfig
(cursorEnabled), StatusInfo (cursorDetected, cursorEnabled, cursorScanError),
and the filter in SessionTracker. No runtime call sites yet — those follow
in subsequent tasks."
```

---

## Task 3: `CursorDetector.ts`

**Files:**
- Create: `cli/src/core/CursorDetector.ts`
- Create: `cli/src/core/CursorDetector.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/CursorDetector.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => {});

const { mockHomedir, mockPlatform } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
	mockPlatform: vi.fn().mockReturnValue("darwin"),
}));
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir, platform: mockPlatform };
});

const { mockSqliteSupport } = vi.hoisted(() => ({
	mockSqliteSupport: vi.fn().mockReturnValue(true),
}));
vi.mock("./SqliteHelpers.js", async () => ({
	hasNodeSqliteSupport: mockSqliteSupport,
}));

import { getCursorGlobalDbPath, isCursorInstalled } from "./CursorDetector.js";

describe("isCursorInstalled (darwin)", () => {
	let tmpHome: string;

	beforeEach(async () => {
		tmpHome = await mkdtemp(join(tmpdir(), "cursor-detector-"));
		mockHomedir.mockReturnValue(tmpHome);
		mockPlatform.mockReturnValue("darwin");
		mockSqliteSupport.mockReturnValue(true);
	});

	afterEach(async () => {
		await rm(tmpHome, { recursive: true, force: true });
	});

	it("returns false when neither app nor data dir exists", async () => {
		expect(await isCursorInstalled()).toBe(false);
	});

	it("returns false when data db does not exist", async () => {
		await mkdir(join(tmpHome, "Library/Application Support/Cursor/User/globalStorage"), { recursive: true });
		expect(await isCursorInstalled()).toBe(false);
	});

	it("returns true when data db exists and Node has SQLite support", async () => {
		const globalDir = join(tmpHome, "Library/Application Support/Cursor/User/globalStorage");
		await mkdir(globalDir, { recursive: true });
		await writeFile(join(globalDir, "state.vscdb"), "stub");
		expect(await isCursorInstalled()).toBe(true);
	});

	it("returns false when Node lacks SQLite support, even if data exists", async () => {
		const globalDir = join(tmpHome, "Library/Application Support/Cursor/User/globalStorage");
		await mkdir(globalDir, { recursive: true });
		await writeFile(join(globalDir, "state.vscdb"), "stub");
		mockSqliteSupport.mockReturnValue(false);
		expect(await isCursorInstalled()).toBe(false);
	});
});

describe("isCursorInstalled (linux)", () => {
	let tmpHome: string;

	beforeEach(async () => {
		tmpHome = await mkdtemp(join(tmpdir(), "cursor-detector-"));
		mockHomedir.mockReturnValue(tmpHome);
		mockPlatform.mockReturnValue("linux");
		mockSqliteSupport.mockReturnValue(true);
	});

	afterEach(async () => {
		await rm(tmpHome, { recursive: true, force: true });
	});

	it("uses ~/.config/Cursor on linux", async () => {
		const globalDir = join(tmpHome, ".config/Cursor/User/globalStorage");
		await mkdir(globalDir, { recursive: true });
		await writeFile(join(globalDir, "state.vscdb"), "stub");
		expect(await isCursorInstalled()).toBe(true);
	});
});

describe("getCursorGlobalDbPath", () => {
	beforeEach(() => {
		mockHomedir.mockReturnValue("/home/user");
	});

	it("returns the darwin path", () => {
		mockPlatform.mockReturnValue("darwin");
		expect(getCursorGlobalDbPath()).toBe(
			"/home/user/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
		);
	});

	it("returns the linux path", () => {
		mockPlatform.mockReturnValue("linux");
		expect(getCursorGlobalDbPath()).toBe("/home/user/.config/Cursor/User/globalStorage/state.vscdb");
	});

	it("returns a Cursor-rooted path on win32", () => {
		mockPlatform.mockReturnValue("win32");
		const path = getCursorGlobalDbPath();
		expect(path.endsWith("Cursor/User/globalStorage/state.vscdb")).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w @jolli.ai/cli -- src/core/CursorDetector.test.ts
```

Expected: FAIL with "Cannot find module './CursorDetector.js'".

- [ ] **Step 3: Implement `CursorDetector.ts`**

Create `cli/src/core/CursorDetector.ts` with:

1. A module docstring noting platform paths:
   - darwin: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
   - linux: `~/.config/Cursor/User/globalStorage/state.vscdb`
   - win32: `%APPDATA%/Cursor/User/globalStorage/state.vscdb`
2. Imports: `stat` from `node:fs/promises`, `homedir`, `platform` from `node:os`, `join` from `node:path`, `createLogger` from `../Logger.js`, `hasNodeSqliteSupport` from `./SqliteHelpers.js`.
3. A private `getCursorUserDataDir(home = homedir())` that branches on `platform()`:
   - `darwin` → `join(home, "Library", "Application Support", "Cursor")`
   - `win32` → `join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor")`
   - else (linux/unix) → `join(home, ".config", "Cursor")`
4. Exported `getCursorGlobalDbPath(home?)` returning `join(getCursorUserDataDir(home), "User", "globalStorage", "state.vscdb")`.
5. Exported `getCursorWorkspaceStorageDir(home?)` returning `join(getCursorUserDataDir(home), "User", "workspaceStorage")`.
6. Exported async `isCursorInstalled()`:
   - First, if `!hasNodeSqliteSupport()`: log and return `false`.
   - Then `stat(getCursorGlobalDbPath())`; on success return `fileStat.isFile()`; on any error return `false`.

The implementation closely mirrors `cli/src/core/ClaudeDetector.ts` and the `isOpenCodeInstalled` pattern in `cli/src/core/OpenCodeSessionDiscoverer.ts` — refer to those for exact prose style.

- [ ] **Step 4: Re-run the tests**

```bash
npm run test -w @jolli.ai/cli -- src/core/CursorDetector.test.ts
npm run typecheck -w @jolli.ai/cli
npm run lint -w @jolli.ai/cli
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/CursorDetector.ts cli/src/core/CursorDetector.test.ts
git commit -s -m "Add CursorDetector (one-shot installation probe)

Checks Cursor's global state.vscdb across darwin/linux/win32 and gates
on hasNodeSqliteSupport() so VS Code-host runtimes (Node 18) report
'not installed' rather than 'detected but unreadable'."
```

---

## Task 4: `CursorSessionDiscoverer.ts` (β′ algorithm)

**Files:**
- Create: `cli/src/core/CursorSessionDiscoverer.ts`
- Create: `cli/src/core/CursorSessionDiscoverer.test.ts`

This task is the heart of the integration. β′ algorithm: workspace lookup → anchor pointers → time-window union. We build it bottom-up: helpers first, public API last.

**Reference:** `cli/src/core/OpenCodeSessionDiscoverer.ts` for the overall structure (pre-flight stat, withSqliteDb, scan-result with optional error).

- [ ] **Step 1: Write the fixture-builder + first failing test**

Create `cli/src/core/CursorSessionDiscoverer.test.ts`. Begin with the fixture helpers and the first test (workspace not found):

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const { mockHomedir, mockPlatform } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue(""),
	mockPlatform: vi.fn().mockReturnValue("darwin"),
}));
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir, platform: mockPlatform };
});

import { discoverCursorSessions, scanCursorSessions } from "./CursorSessionDiscoverer.js";

const CURSOR_DDL = [
	`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`,
	`CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`,
];

interface ComposerFixture {
	composerId: string;
	name?: string;
	createdAtMs: number;
	lastUpdatedAtMs: number;
	bubbleHeaders?: ReadonlyArray<{ bubbleId: string; type: number }>;
}

function createCursorGlobalDb(dbPath: string, composers: ReadonlyArray<ComposerFixture>): void {
	const db = new DatabaseSync(dbPath);
	for (const sql of CURSOR_DDL) db.prepare(sql).run();
	for (const c of composers) {
		const value = JSON.stringify({
			_v: 16,
			composerId: c.composerId,
			name: c.name ?? "Untitled",
			createdAt: c.createdAtMs,
			lastUpdatedAt: c.lastUpdatedAtMs,
			fullConversationHeadersOnly: (c.bubbleHeaders ?? []).map((h) => ({ ...h, grouping: null })),
			status: "completed",
			unifiedMode: "agent",
		});
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`composerData:${c.composerId}`, value);
	}
	db.close();
}

function createCursorWorkspaceDb(
	dbPath: string,
	pointers: { lastFocusedComposerIds?: string[]; selectedComposerIds?: string[] } | null,
): void {
	const db = new DatabaseSync(dbPath);
	for (const sql of CURSOR_DDL) db.prepare(sql).run();
	if (pointers) {
		const value = JSON.stringify({
			lastFocusedComposerIds: pointers.lastFocusedComposerIds ?? [],
			selectedComposerIds: pointers.selectedComposerIds ?? [],
			hasMigratedComposerData: true,
			hasMigratedMultipleComposers: true,
		});
		db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", value);
	}
	db.close();
}

async function setupCursorHome(
	tmpHome: string,
	opts: {
		globalComposers: ReadonlyArray<ComposerFixture>;
		workspaces: ReadonlyArray<{
			folder: string;
			pointers: { lastFocusedComposerIds?: string[]; selectedComposerIds?: string[] } | null;
		}>;
	},
): Promise<void> {
	const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
	await mkdir(join(userDir, "globalStorage"), { recursive: true });
	createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), opts.globalComposers);

	let i = 0;
	for (const ws of opts.workspaces) {
		const wsHash = `ws-${String(i).padStart(8, "0")}`;
		const wsDir = join(userDir, "workspaceStorage", wsHash);
		await mkdir(wsDir, { recursive: true });
		await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: ws.folder }));
		createCursorWorkspaceDb(join(wsDir, "state.vscdb"), ws.pointers);
		i++;
	}
}

describe("discoverCursorSessions", () => {
	let tmpHome: string;

	beforeEach(async () => {
		tmpHome = await mkdtemp(join(tmpdir(), "cursor-disc-"));
		mockHomedir.mockReturnValue(tmpHome);
		mockPlatform.mockReturnValue("darwin");
	});

	afterEach(async () => {
		await rm(tmpHome, { recursive: true, force: true });
	});

	it("returns [] when projectDir does not match any workspace", async () => {
		await setupCursorHome(tmpHome, { globalComposers: [], workspaces: [] });
		const sessions = await discoverCursorSessions("/Users/flyer/jolli/code/somewhere");
		expect(sessions).toEqual([]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test -w @jolli.ai/cli -- src/core/CursorSessionDiscoverer.test.ts
```

Expected: FAIL — `Cannot find module './CursorSessionDiscoverer.js'`.

- [ ] **Step 3: Implement `CursorSessionDiscoverer.ts`**

Create `cli/src/core/CursorSessionDiscoverer.ts`. Structure:

**Module docstring** — explain the storage layout (global vs per-workspace), the β′ algorithm (4 steps), and the synthetic transcript path format `<globalDbPath>#<composerId>`.

**Imports:**

```ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getCursorGlobalDbPath, getCursorWorkspaceStorageDir } from "./CursorDetector.js";
import { classifyScanError, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";
```

**Constants:**

```ts
const log = createLogger("CursorDiscoverer");
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;
```

**Public types:**

```ts
export interface CursorScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: SqliteScanError;
}
```

**Public API — `scanCursorSessions(projectDir)`** (the workhorse). Algorithm:

1. Call `findCursorWorkspaceHash(projectDir)`. If no match, return `{ sessions: [] }`.
2. `stat(globalDbPath)` to pre-flight; on `ENOENT`, return `{ sessions: [] }`; on other errors, classify and return with error.
3. Call `readCursorAnchorComposerIds(wsHash)` → `Set<string>` of anchor IDs.
4. Compute `cutoffMs = Date.now() - SESSION_STALE_MS`.
5. Open the global db with `withSqliteDb`. SELECT `key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`. For each row:
   - Parse JSON. Extract `composerId` and `lastUpdatedAt`.
   - Compute `inAnchor = anchorSet.has(composerId)` and `inWindow = lastUpdatedAt >= cutoffMs`.
   - Skip if neither.
   - Skip rows with non-finite `lastUpdatedAt` (with warn log).
   - Otherwise push a `SessionInfo`:
     - `sessionId: composerId`
     - `transcriptPath: <globalDbPath>#<composerId>` (synthetic — same pattern as OpenCode)
     - `updatedAt: new Date(lastUpdatedAt).toISOString()`
     - `source: "cursor"`
   - Add to seenIds set to dedupe.
6. Return `{ sessions: out }`.
7. On any thrown error, call `classifyScanError`. Null → return `{ sessions: [] }` (TOCTOU); else log and return `{ sessions: [], error }`.

**Public API — `discoverCursorSessions(projectDir)`** — thin wrapper returning just `result.sessions`.

**Internal helper — `findCursorWorkspaceHash(projectDir)`:**

1. Read directory entries of `getCursorWorkspaceStorageDir()`. On error return `null`.
2. Compute `target = normalizePathForMatch(projectDir)`.
3. For each entry, read `<entry>/workspace.json`. Parse JSON, extract `folder` URI. Skip if missing or not `file://`.
4. Convert URI to absolute path with `fileURLToPath(folderUri)`.
5. If `normalizePathForMatch(folderPath) === target`, return `entry`.
6. Return `null` if nothing matches.

**Internal helper — `readCursorAnchorComposerIds(wsHash)`:**

1. Path = `<workspaceStorageDir>/<wsHash>/state.vscdb`. `stat()` first; on error return `[]`.
2. Open with `withSqliteDb`. SELECT `value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1`. If absent, return `[]`.
3. Parse JSON. Union of `lastFocusedComposerIds` and `selectedComposerIds`. Return as array.
4. On any thrown error, log warn and return `[]`.

**Internal helper — `normalizePathForMatch(p)`:**

```ts
function normalizePathForMatch(p: string): string {
	const trimmed = p.replace(/\/+$/, "");
	return process.platform === "darwin" || process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}
```

- [ ] **Step 4: Re-run the first test**

```bash
npm run test -w @jolli.ai/cli -- src/core/CursorSessionDiscoverer.test.ts -t "does not match any workspace"
```

Expected: PASS.

- [ ] **Step 5: Add the remaining test cases**

Append to `CursorSessionDiscoverer.test.ts` inside the existing `describe("discoverCursorSessions", ...)`:

```ts
	it("returns the anchor composer when workspace pointer is set, even outside time window", async () => {
		const ancientTs = Date.now() - 365 * 24 * 60 * 60 * 1000;
		await setupCursorHome(tmpHome, {
			globalComposers: [
				{ composerId: "anchor-1", createdAtMs: ancientTs, lastUpdatedAtMs: ancientTs },
			],
			workspaces: [
				{
					folder: "file:///Users/flyer/work/proj-a",
					pointers: { lastFocusedComposerIds: ["anchor-1"] },
				},
			],
		});

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ sessionId: "anchor-1", source: "cursor" });
		expect(sessions[0].transcriptPath).toContain("#anchor-1");
	});

	it("includes time-window composers in addition to anchors, deduped", async () => {
		const fresh = Date.now() - 60 * 1000;
		const stale = Date.now() - 100 * 60 * 60 * 1000;
		await setupCursorHome(tmpHome, {
			globalComposers: [
				{ composerId: "anchor-1", createdAtMs: fresh, lastUpdatedAtMs: fresh },
				{ composerId: "fresh-2", createdAtMs: fresh, lastUpdatedAtMs: fresh },
				{ composerId: "stale-3", createdAtMs: stale, lastUpdatedAtMs: stale },
			],
			workspaces: [
				{
					folder: "file:///Users/flyer/work/proj-a",
					pointers: { lastFocusedComposerIds: ["anchor-1"] },
				},
			],
		});

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		const ids = sessions.map((s) => s.sessionId).sort();
		expect(ids).toEqual(["anchor-1", "fresh-2"]);
	});

	it("URL-decodes file:// folder paths and matches case-insensitively on darwin", async () => {
		await setupCursorHome(tmpHome, {
			globalComposers: [{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() }],
			workspaces: [
				{
					folder: "file:///Users/Flyer/Code%20Folder/Proj",
					pointers: { lastFocusedComposerIds: ["c-1"] },
				},
			],
		});

		const sessions = await discoverCursorSessions("/users/flyer/code folder/proj");
		expect(sessions).toHaveLength(1);
	});

	it("returns empty when no anchor and no fresh composers, even if workspace matches", async () => {
		const stale = Date.now() - 100 * 60 * 60 * 1000;
		await setupCursorHome(tmpHome, {
			globalComposers: [{ composerId: "stale-1", createdAtMs: stale, lastUpdatedAtMs: stale }],
			workspaces: [
				{
					folder: "file:///Users/flyer/work/proj-a",
					pointers: null,
				},
			],
		});

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toEqual([]);
	});

	it("surfaces a corrupt-DB error via scanCursorSessions", async () => {
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		await writeFile(join(userDir, "globalStorage", "state.vscdb"), "this is not a sqlite file");

		const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(wsDir, { recursive: true });
		await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }));
		await writeFile(join(wsDir, "state.vscdb"), "garbage too");

		const result = await scanCursorSessions("/Users/flyer/work/proj-a");
		expect(result.sessions).toEqual([]);
		if (result.error) {
			expect(["corrupt", "permission", "unknown"]).toContain(result.error.kind);
		}
	});
```

- [ ] **Step 6: Run the full discoverer test suite**

```bash
npm run test -w @jolli.ai/cli -- src/core/CursorSessionDiscoverer.test.ts
npm run typecheck -w @jolli.ai/cli
npm run lint -w @jolli.ai/cli
```

Expected: all green. If any test fails, read the failure and fix the implementation — do not weaken the test.

- [ ] **Step 7: Commit**

```bash
git add cli/src/core/CursorSessionDiscoverer.ts cli/src/core/CursorSessionDiscoverer.test.ts
git commit -s -m "Add CursorSessionDiscoverer with β' attribution

Implements the workspace pointer + 48h time window union from the
Cursor support spec. Workspace lookup goes through workspace.json's
folder URI; anchor IDs come from each workspace's composer.composerData;
time-window IDs come from the global cursorDiskKV table. Synthetic
transcript path uses the OpenCode pattern (<dbPath>#<composerId>)."
```

---

## Task 5: `CursorTranscriptReader.ts`

**Files:**
- Create: `cli/src/core/CursorTranscriptReader.ts`
- Create: `cli/src/core/CursorTranscriptReader.test.ts`

The reader takes a synthetic path `<globalDbPath>#<composerId>` and produces `TranscriptEntry[]` by:
1. Reading `composerData:<composerId>` to get the ordered `fullConversationHeadersOnly` list of bubbleIds.
2. Reading each `bubbleId:<composerId>:<bubbleId>` row, mapping `bubble.type` to role, and using `bubble.text` as content.
3. Supporting cursor-based resumption (skip already-consumed bubbles) and `beforeTimestamp` cutoff.

**Bubble type → role mapping:** Empirically `1 → human`, `2 → assistant`. The spec mandates a fixture-based confirmation in Step 5 below.

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/CursorTranscriptReader.test.ts`:

```ts
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

import { readCursorTranscript } from "./CursorTranscriptReader.js";

const CURSOR_DDL = [
	`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`,
	`CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`,
];

interface BubbleFixture {
	bubbleId: string;
	type: 1 | 2;
	text: string;
	createdAt: string;
}

function createCursorTranscriptDb(
	dbPath: string,
	composerId: string,
	bubbles: ReadonlyArray<BubbleFixture>,
): void {
	const db = new DatabaseSync(dbPath);
	for (const sql of CURSOR_DDL) db.prepare(sql).run();

	const composerData = JSON.stringify({
		_v: 16,
		composerId,
		name: "Test composer",
		createdAt: Date.now(),
		lastUpdatedAt: Date.now(),
		fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type, grouping: null })),
		status: "completed",
		unifiedMode: "agent",
	});
	db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
		`composerData:${composerId}`,
		composerData,
	);

	for (const b of bubbles) {
		const bubbleData = JSON.stringify({
			_v: 3,
			bubbleId: b.bubbleId,
			type: b.type,
			text: b.text,
			createdAt: b.createdAt,
		});
		db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
			`bubbleId:${composerId}:${b.bubbleId}`,
			bubbleData,
		);
	}
	db.close();
}

describe("readCursorTranscript", () => {
	let tmpDir: string;
	let dbPath: string;
	const composerId = "11111111-2222-3333-4444-555555555555";

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cursor-tr-"));
		await mkdir(tmpDir, { recursive: true });
		dbPath = join(tmpDir, "state.vscdb");
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("rejects malformed synthetic paths", async () => {
		await expect(readCursorTranscript("/no/hash/in/path")).rejects.toThrow(/missing #composerId/);
		await expect(readCursorTranscript("#only-id")).rejects.toThrow(/empty/);
		await expect(readCursorTranscript("/path#")).rejects.toThrow(/empty/);
	});

	it("returns ordered user/assistant entries with type→role mapping", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "what is 2 + 2?", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "2 + 2 = 4.", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "thanks", createdAt: "2026-05-03T10:00:02.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);

		expect(result.entries).toEqual([
			{ role: "human", content: "what is 2 + 2?", timestamp: "2026-05-03T10:00:00.000Z" },
			{ role: "assistant", content: "2 + 2 = 4.", timestamp: "2026-05-03T10:00:01.000Z" },
			{ role: "human", content: "thanks", timestamp: "2026-05-03T10:00:02.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(3);
		expect(result.totalLinesRead).toBe(3);
	});

	it("merges consecutive same-role entries", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 2, text: "Looking at the file...", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "I see the issue.", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "what is it?", createdAt: "2026-05-03T10:00:02.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].role).toBe("assistant");
		expect(result.entries[0].content).toBe("Looking at the file...\n\nI see the issue.");
		expect(result.entries[1].role).toBe("human");
	});

	it("skips bubbles with empty text", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "hi", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "ping", createdAt: "2026-05-03T10:00:02.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries.map((e) => e.role)).toEqual(["human"]);
	});

	it("skips bubbles whose type does not map to a role", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "hi", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 99 as unknown as 1, text: "system noise", createdAt: "2026-05-03T10:00:01.000Z" },
		]);
		const result = await readCursorTranscript(`${dbPath}#${composerId}`);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].role).toBe("human");
	});

	it("skips already-read bubbles when given a cursor", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "first", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "second", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "third", createdAt: "2026-05-03T10:00:02.000Z" },
		]);

		const result = await readCursorTranscript(`${dbPath}#${composerId}`, {
			transcriptPath: `${dbPath}#${composerId}`,
			lineNumber: 2,
			updatedAt: "2026-05-03T10:00:01.000Z",
		});
		expect(result.entries).toEqual([
			{ role: "human", content: "third", timestamp: "2026-05-03T10:00:02.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(3);
	});

	it("respects beforeTimestamp cutoff and advances cursor only to last consumed", async () => {
		createCursorTranscriptDb(dbPath, composerId, [
			{ bubbleId: "b1", type: 1, text: "first", createdAt: "2026-05-03T10:00:00.000Z" },
			{ bubbleId: "b2", type: 2, text: "second", createdAt: "2026-05-03T10:00:01.000Z" },
			{ bubbleId: "b3", type: 1, text: "after-cutoff", createdAt: "2026-05-03T10:00:05.000Z" },
		]);

		const result = await readCursorTranscript(
			`${dbPath}#${composerId}`,
			null,
			"2026-05-03T10:00:01.500Z",
		);
		expect(result.entries.map((e) => e.content)).toEqual(["first", "second"]);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("throws a friendly error when the composer is not in the DB", async () => {
		createCursorTranscriptDb(dbPath, composerId, []);
		await expect(readCursorTranscript(`${dbPath}#missing-id`)).rejects.toThrow(/Cannot read Cursor session/);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test -w @jolli.ai/cli -- src/core/CursorTranscriptReader.test.ts
```

Expected: FAIL with "Cannot find module './CursorTranscriptReader.js'".

- [ ] **Step 3: Implement `CursorTranscriptReader.ts`**

Create `cli/src/core/CursorTranscriptReader.ts`. Structure:

**Module docstring** describing the storage layout, the `bubble.type` mapping (1=human, 2=assistant, others skipped), and that the cursor reuses `lineNumber` to track bubble index (same pattern as `OpenCodeTranscriptReader`).

**Imports:**

```ts
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { withSqliteDb } from "./SqliteHelpers.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";
```

**Constants and types:**

```ts
const log = createLogger("CursorTranscriptReader");

const BUBBLE_TYPE_TO_ROLE: Readonly<Record<number, "human" | "assistant">> = {
	1: "human",
	2: "assistant",
};

interface ConversationHeader {
	readonly bubbleId: string;
	readonly type?: number;
}

interface ComposerDataRow {
	readonly fullConversationHeadersOnly?: ReadonlyArray<ConversationHeader>;
}

interface BubbleRow {
	readonly type?: number;
	readonly text?: string;
	readonly createdAt?: string;
}
```

**Public function — `readCursorTranscript(transcriptPath, cursor?, beforeTimestamp?)`:**

1. `parseSyntheticPath(transcriptPath)` → `{ dbPath, composerId }`. (Throw on missing/empty `#`.)
2. `startIndex = cursor?.lineNumber ?? 0`.
3. `cutoffTime = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined`.
4. Open the db with `withSqliteDb`. Inside the callback:
   - SELECT `value FROM cursorDiskKV WHERE key = 'composerData:<id>' LIMIT 1`. Throw `Composer ${composerId} not found in database` if missing.
   - Parse JSON into `ComposerDataRow`. Throw on parse failure.
   - `headers = composer.fullConversationHeadersOnly ?? []`.
   - Slice `headers` from `startIndex` onwards.
   - For each header in the slice:
     - SELECT the matching `bubbleId:<id>:<bubbleId>` row. Skip if missing (advance index but no entry).
     - Parse JSON → `BubbleRow`. Skip if parse fails.
     - `type = bubble.type ?? header.type`. `role = BUBBLE_TYPE_TO_ROLE[type]`. `text = (bubble.text ?? "").trim()`. `timestamp = bubble.createdAt`.
     - If `cutoffTime` set and `timestamp` parses to a number after the cutoff, **break** the loop (do not advance index past this point).
     - If `role` is defined and `text.length > 0`, push `{ role, content: text, timestamp }`.
     - Advance `lastConsumedIndex = startIndex + i + 1`.
   - Return `{ rawEntries, totalBubbles: headers.length, lastConsumedIndex }`.
5. Outside the callback, `entries = mergeConsecutiveEntries(rawEntries)`.
6. Build `newCursor`: `lineNumber = beforeTimestamp ? lastConsumedIndex : totalBubbles`.
7. Return `{ entries, newCursor, totalLinesRead: lastConsumedIndex - startIndex }`.
8. On any thrown error, log and rethrow as `Error("Cannot read Cursor session: " + composerId)`.

**Internal helper — `parseSyntheticPath(transcriptPath)`:**

- `hashIndex = transcriptPath.lastIndexOf("#")`. Throw if `-1` with "missing #composerId".
- `dbPath = substring(0, hashIndex)`, `composerId = substring(hashIndex + 1)`.
- Throw if either is empty (separate "empty" message).

- [ ] **Step 4: Re-run the reader test suite**

```bash
npm run test -w @jolli.ai/cli -- src/core/CursorTranscriptReader.test.ts
npm run typecheck -w @jolli.ai/cli
npm run lint -w @jolli.ai/cli
```

Expected: all green.

- [ ] **Step 5: Real-Cursor smoke verification (manual, before commit)**

The plan author confirmed `type:1=user, type:2=assistant` empirically during the design phase. Verify this still holds in your local Cursor before merging:

1. In Cursor, open any project and start a new Composer chat.
2. Send one user message ("hello").
3. Wait for the assistant reply.
4. From a terminal:

```bash
sqlite3 "$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb" \
  "SELECT key, json_extract(value, '\$.type'), substr(json_extract(value, '\$.text'), 1, 40) \
   FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY rowid DESC LIMIT 4;"
```

Expected: rows where the user's "hello" has `type=1` and the assistant's reply has `type=2`. If reversed or different, update `BUBBLE_TYPE_TO_ROLE` in `CursorTranscriptReader.ts` and re-run unit tests before committing.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/CursorTranscriptReader.ts cli/src/core/CursorTranscriptReader.test.ts
git commit -s -m "Add CursorTranscriptReader

Reads composerData -> fullConversationHeadersOnly index, then per-bubble
rows from cursorDiskKV. Maps bubble.type 1 -> human, 2 -> assistant;
unknown types skipped. Supports cursor-based resume and beforeTimestamp
cutoff (matches OpenCodeTranscriptReader semantics)."
```

---

## Task 6: Wire `QueueWorker` discoverer fan-out + reader dispatch

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts`

The Worker has two relevant points:
- `loadSessionTranscripts` — discovers sessions from each enabled source.
- `readAllTranscripts` — dispatches to the right reader based on `session.source`.

- [ ] **Step 1: Add the imports**

At the top of `cli/src/hooks/QueueWorker.ts`, add (next to the OpenCode imports):

```ts
import { isCursorInstalled } from "../core/CursorDetector.js";
import { discoverCursorSessions } from "../core/CursorSessionDiscoverer.js";
import { readCursorTranscript } from "../core/CursorTranscriptReader.js";
```

- [ ] **Step 2: Add cursor discovery to `loadSessionTranscripts`**

Find the existing OpenCode discovery block in `loadSessionTranscripts` (around line 1418-1426):

```ts
	// Discover OpenCode sessions (on-demand SQLite scan)
	if (config.openCodeEnabled !== false && (await isOpenCodeInstalled())) {
		const openCodeSessions = await discoverOpenCodeSessions(cwd);
		if (openCodeSessions.length > 0) {
			allSessions = [...allSessions, ...openCodeSessions];
			log.info("Discovered %d OpenCode session(s)", openCodeSessions.length);
		}
	}
```

Add a parallel cursor block immediately after:

```ts
	// Discover Cursor Composer sessions (on-demand SQLite scan from globalStorage)
	if (config.cursorEnabled !== false && (await isCursorInstalled())) {
		const cursorSessions = await discoverCursorSessions(cwd);
		if (cursorSessions.length > 0) {
			allSessions = [...allSessions, ...cursorSessions];
			log.info("Discovered %d Cursor session(s)", cursorSessions.length);
		}
	}
```

- [ ] **Step 3: Add the cursor branch to `readAllTranscripts` dispatch**

In the same file, find the dispatch block in `readAllTranscripts` (around line 1466-1472):

```ts
		if (source === "gemini") {
			result = await readGeminiTranscript(session.transcriptPath, cursor, beforeTimestamp);
		} else if (source === "opencode") {
			result = await readOpenCodeTranscript(session.transcriptPath, cursor, beforeTimestamp);
		} else {
			result = await readTranscript(session.transcriptPath, cursor, getParserForSource(source), beforeTimestamp);
		}
```

Replace with:

```ts
		if (source === "gemini") {
			result = await readGeminiTranscript(session.transcriptPath, cursor, beforeTimestamp);
		} else if (source === "opencode") {
			result = await readOpenCodeTranscript(session.transcriptPath, cursor, beforeTimestamp);
		} else if (source === "cursor") {
			result = await readCursorTranscript(session.transcriptPath, cursor, beforeTimestamp);
		} else {
			result = await readTranscript(session.transcriptPath, cursor, getParserForSource(source), beforeTimestamp);
		}
```

- [ ] **Step 4: Run typecheck + lint + existing QueueWorker tests**

```bash
npm run typecheck -w @jolli.ai/cli
npm run lint -w @jolli.ai/cli
npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add cli/src/hooks/QueueWorker.ts
git commit -s -m "Wire Cursor discovery and reader into QueueWorker

loadSessionTranscripts now invokes discoverCursorSessions when
cursorEnabled !== false and Cursor is installed. readAllTranscripts
dispatches source==='cursor' to readCursorTranscript."
```

---

## Task 7: Wire `Installer.ts` (auto-detect + status fields)

**Files:**
- Modify: `cli/src/install/Installer.ts`

Three small edits: auto-enable on install, populate `getStatus` fields, and update the status log line.

- [ ] **Step 1: Add imports**

At the top of `cli/src/install/Installer.ts`, add (next to the OpenCode imports):

```ts
import { isCursorInstalled } from "../core/CursorDetector.js";
import { scanCursorSessions } from "../core/CursorSessionDiscoverer.js";
import type { SqliteScanError } from "../core/SqliteHelpers.js";
```

- [ ] **Step 2: Auto-detect cursor at install time**

Find the OpenCode auto-detect block in the `install()` function (around line 250-256):

```ts
	// Auto-detect OpenCode and enable session discovery
	const openCodeDetected = config.openCodeEnabled !== false && (await isOpenCodeInstalled());
	if (openCodeDetected) {
		if (config.openCodeEnabled === undefined) {
			await saveConfig({ openCodeEnabled: true });
			log.info("OpenCode detected — enabled OpenCode session discovery");
		}
	}
```

Add the cursor block immediately after:

```ts
	// Auto-detect Cursor and enable Composer session discovery
	const cursorDetected = config.cursorEnabled !== false && (await isCursorInstalled());
	if (cursorDetected) {
		if (config.cursorEnabled === undefined) {
			await saveConfig({ cursorEnabled: true });
			log.info("Cursor detected — enabled Cursor Composer session discovery");
		}
	}
```

- [ ] **Step 3: Populate `cursor*` fields in `getStatus`**

Find the OpenCode block in `getStatus()` (around line 472):

```ts
	const openCodeDetected = await isOpenCodeInstalled();
```

Add immediately after:

```ts
	const cursorDetected = await isCursorInstalled();
```

Find the OpenCode discovery block (around line 502-512):

```ts
	let openCodeScanError: OpenCodeScanError | undefined;
	if (config.openCodeEnabled !== false && openCodeDetected) {
		const scan = await scanOpenCodeSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		openCodeScanError = scan.error;
	}
```

Add the cursor analog immediately after:

```ts
	let cursorScanError: SqliteScanError | undefined;
	if (config.cursorEnabled !== false && cursorDetected) {
		const scan = await scanCursorSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		cursorScanError = scan.error;
	}
```

Find the `status: StatusInfo = {...}` literal (around line 564-593). After `openCodeEnabled: config.openCodeEnabled,` add:

```ts
		cursorDetected,
		cursorEnabled: config.cursorEnabled,
		cursorScanError,
```

(Place these next to the openCodeScanError field at the end of the literal.)

Lastly update the `log.info(...)` status line near the end of `getStatus()`. Replace the format string:

```ts
		"Status: enabled=%s, claude=%s, git=%s, geminiHook=%s, worktreeHooks=%s, sessions=%d, summaries=%d, codex=%s/%s, gemini=%s/%s, enabledWorktrees=%s, opencode=%s/%s",
```

With:

```ts
		"Status: enabled=%s, claude=%s, git=%s, geminiHook=%s, worktreeHooks=%s, sessions=%d, summaries=%d, codex=%s/%s, gemini=%s/%s, enabledWorktrees=%s, opencode=%s/%s, cursor=%s/%s",
```

And add at the end of the argument list (after `status.openCodeEnabled,`):

```ts
		status.cursorDetected,
		status.cursorEnabled,
```

- [ ] **Step 4: Run typecheck + lint + existing Installer tests**

```bash
npm run typecheck -w @jolli.ai/cli
npm run lint -w @jolli.ai/cli
npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add cli/src/install/Installer.ts
git commit -s -m "Wire Cursor auto-detect and status fields in Installer

install() now auto-enables cursorEnabled when Cursor is detected and
config has not explicitly set it. getStatus() populates cursorDetected,
cursorEnabled, and cursorScanError, mirroring the OpenCode treatment."
```

---

## Task 8: Wire CLI surfaces (`StatusCommand`, `ConfigureCommand`)

**Files:**
- Modify: `cli/src/commands/StatusCommand.ts`
- Modify: `cli/src/commands/ConfigureCommand.ts`

- [ ] **Step 1: Add Cursor row to StatusCommand `integrationRows`**

Open `cli/src/commands/StatusCommand.ts`. Find the `integrationRows` array (around line 110-150). Add a new entry after the OpenCode entry:

```ts
				[
					"Cursor:",
					status.cursorDetected,
					{
						enabled: status.cursorEnabled !== false,
						hookInstalled: undefined,
						sessionCount: counts.cursor,
						scanError: status.cursorScanError,
					},
				],
```

The row format mirrors OpenCode exactly: no hook (undefined), session count from per-source breakdown, and surface the scan error if any.

- [ ] **Step 2: Add `cursorEnabled` to ConfigureCommand**

Open `cli/src/commands/ConfigureCommand.ts`.

**Edit 1:** in `VALID_CONFIG_KEYS` (around line 24-36), add `"cursorEnabled"` after `"openCodeEnabled"`:

```ts
const VALID_CONFIG_KEYS = [
	"apiKey",
	"model",
	"maxTokens",
	"jolliApiKey",
	"authToken",
	"codexEnabled",
	"geminiEnabled",
	"claudeEnabled",
	"openCodeEnabled",
	"cursorEnabled",
	"logLevel",
	"excludePatterns",
] as const satisfies ReadonlyArray<keyof JolliMemoryConfig>;
```

**Edit 2:** in `coerceConfigValue` (around line 67), include `cursorEnabled` in the boolean branch:

```ts
	if (
		key === "codexEnabled" ||
		key === "geminiEnabled" ||
		key === "claudeEnabled" ||
		key === "openCodeEnabled" ||
		key === "cursorEnabled"
	) {
		const lower = raw.toLowerCase();
		if (lower === "true" || lower === "1" || lower === "yes") return true;
		if (lower === "false" || lower === "0" || lower === "no") return false;
		throw new Error(`${key} must be true/false (got: ${raw})`);
	}
```

**Edit 3:** in `CONFIG_KEY_INFO` (around line 92-108), add a description after `openCodeEnabled`:

```ts
	{
		key: "cursorEnabled",
		type: "boolean",
		description: "Enable Cursor Composer session discovery (true/false; requires Node 22.5+ at runtime)",
	},
```

- [ ] **Step 3: Run all CLI checks**

```bash
npm run typecheck -w @jolli.ai/cli
npm run lint -w @jolli.ai/cli
npm run test -w @jolli.ai/cli
```

Expected: all green, including coverage threshold.

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/StatusCommand.ts cli/src/commands/ConfigureCommand.ts
git commit -s -m "Surface cursor in 'jolli status' and 'jolli configure'

StatusCommand renders a Cursor integration row with the same shape as
OpenCode (no hook, session count, scan error). ConfigureCommand accepts
'cursorEnabled' as a boolean key."
```

---

## Task 9: End-to-end smoke verification (manual)

**Goal:** Confirm a real Cursor Composer conversation produces a Cursor-attributed session in a freshly-generated commit summary.

This task does not modify code — it validates the full pipeline on the implementer's local machine. It must pass before merging.

- [ ] **Step 1: Build the CLI from this branch and link globally**

```bash
cd cli
npm run build
npm install -g .
cd ..
```

- [ ] **Step 2: Set up a sandbox repo and enable jollimemory**

```bash
mkdir -p /tmp/cursor-smoke && cd /tmp/cursor-smoke
git init
git commit --allow-empty -m "init" -s
jolli enable
jolli status
```

Expected `jolli status` output should include a `Cursor:` row reporting "detected" and a session count (likely 0 if you have not used Cursor in this directory yet).

- [ ] **Step 3: Open the sandbox in Cursor and have a Composer conversation**

1. `open -a Cursor /tmp/cursor-smoke` (macOS).
2. Open a new Composer chat. Send: "create a file hello.txt that says hello world".
3. Let Cursor's agent create the file.
4. Save changes (if Cursor stages them, accept).

- [ ] **Step 4: Make a commit and verify cursor is attributed**

```bash
cd /tmp/cursor-smoke
git add .
git commit -m "feat: add hello.txt" -s
sleep 10
jolli status
HEAD_HASH=$(git rev-parse HEAD)
git show "jollimemory/summaries/v3:summaries/${HEAD_HASH}.json" | jq '.children // .' | head -50
```

Expected:

- `jolli status` shows a non-zero count in the `Cursor:` row.
- The summary JSON contains a `sessions` entry whose `source` is `"cursor"`.

- [ ] **Step 5: Cleanup**

```bash
cd ~ && rm -rf /tmp/cursor-smoke
npm uninstall -g @jolli.ai/cli
```

- [ ] **Step 6: If everything passes, this task is complete — no commit (no code change).**

If anything fails, treat it as a real bug: open a new branch off `feature-support-cursor`, fix, and re-run from Step 4.

---

## Final Sweep

- [ ] **Run the full repo check from root**

```bash
cd /Users/flyer/jolli/code/jollimemory
npm run all
```

Expected: clean → build → lint → test all green across both `cli/` and `vscode/`. If `vscode/` tests break, double-check that `cli/src/Types.ts` still type-checks under both CLI and VSCode tsconfigs (the VSCode bundler inlines `cli/src/**`).

- [ ] **Verify the diff is bounded to the planned files**

```bash
git diff --stat main..HEAD
```

Expected: changes confined to the file list at the top of this plan. No incidental edits.

- [ ] **Push and open the PR**

```bash
git push -u origin feature-support-cursor
gh pr create --title "Add Cursor IDE support" --body "$(cat <<'PRBODY'
## Summary

Adds Cursor (the Anysphere VS Code fork) as a fifth TranscriptSource. The CLI now discovers Cursor Composer transcripts at post-commit time by scanning Cursor's local SQLite (~/Library/Application Support/Cursor/User/globalStorage/state.vscdb), using a workspace-pointer + 48 h time-window attribution algorithm.

Mirrors the OpenCode integration pattern: passive scan, no hook, no Cursor-side files. Setup-time auto-detect via isCursorInstalled(), with `jolli status` and `jolli configure cursorEnabled` exposing the toggle.

## Intentionally unchanged

- vscode/: no marketplace, host-detection, or engines.vscode work.
- intellij/: no Kotlin port of the discoverer.
- The jollimemory/summaries/v3 orphan branch format.
- ~/.jolli/jollimemory/ runtime state shape (no new files).
- No Cursor-side hook installed (Cursor exposes no hook protocol).
- chatSessions/*.jsonl: verified empty of conversation content during exploration.

## Test plan

- [ ] npm run all from repo root passes
- [ ] cli/ coverage stays at 97% statements / 96% branches / 97% funcs / 97% lines
- [ ] Smoke test in Task 9 of the plan passed locally:
  - real Cursor Composer conversation -> commit -> cursor-attributed session in the summary tree

## Spec & plan

- Spec: docs/superpowers/specs/2026-05-03-cursor-support-design.md
- Plan: docs/superpowers/plans/2026-05-03-cursor-support.md
PRBODY
)"
```

---

## Self-Review Notes

**Spec coverage check:**

- §3.2 (new files) → covered by Tasks 3, 4, 5.
- §3.3 (β′ algorithm) → Task 4.
- §3.4 (transcript reading) → Task 5.
- §3.5 (type extensions) → Task 2.
- §3.6 (wiring: SessionTracker, QueueWorker, Installer, StatusCommand) → Tasks 2, 6, 7, 8.
- §4 (setup integration) → Task 7.
- §5 (error handling) → Tasks 1 (helpers) and 4 (error surfacing).
- §6.1 (unit tests) → embedded in each task.
- §6.2 (bubble.type confirmation) → Task 5 step 5.
- §7.4 (`SqliteHelpers.ts` extraction) → Task 1.
- §8 (implementation order) → mirrored by tasks 1–9.
- §9 (intentionally unchanged) → reflected in PR body.

**Type / signature consistency check:**

- `withSqliteDb<T>(dbPath, fn): Promise<T>` — defined Task 1, used in Task 4 and Task 5.
- `SqliteScanError.kind` literal — defined Task 1, used in Task 7 status field. The `Types.ts` field (Task 2) duplicates the literal union by design (per spec §3.5).
- `discoverCursorSessions(projectDir): Promise<ReadonlyArray<SessionInfo>>` — defined Task 4, used Task 6.
- `readCursorTranscript(path, cursor?, beforeTimestamp?): Promise<TranscriptReadResult>` — defined Task 5, used Task 6.
- Synthetic transcript path format `<dbPath>#<composerId>` — produced in Task 4, parsed in Task 5.

**No-placeholder check:** every step contains the code or command an implementer needs; no "TBD" / "TODO" / "fill in details" anywhere.

