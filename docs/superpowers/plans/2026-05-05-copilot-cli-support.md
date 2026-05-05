# GitHub Copilot CLI Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Copilot CLI as the sixth transcript source, treated as a discovery-based SQLite-backed peer of OpenCode and Cursor.

**Architecture:** Mirror the OpenCode integration template. Extract a shared `SqliteHelpers` module from `OpenCodeSessionDiscoverer` (pure refactor), then build three new core modules (`CopilotDetector`, `CopilotSessionDiscoverer`, `CopilotTranscriptReader`). Wire through `Types`, `SessionTracker`, `Installer`, `QueueWorker`, CLI commands, and the VSCode Status / Summary / Settings panels. No new dependencies — `node:sqlite` is already in use.

**Tech Stack:** TypeScript (ESM, Node 22.5+), `node:sqlite` (built-in), Vitest, Biome (tabs / 120 col), GitHub Copilot CLI v1.0.x as the external system.

**Spec:** [`docs/superpowers/specs/2026-05-05-copilot-cli-support-design.md`](../specs/2026-05-05-copilot-cli-support-design.md)

**Project conventions to remember:**
- All commits require DCO sign-off: `git commit -s -m "..."`. Co-Authored-By trailer for Claude.
- Biome config at [`cli/biome.json`](../../../cli/biome.json) — tabs, 120 col, no `any`, no unused imports.
- Test coverage gate in `cli/`: ≥97% statements / ≥96% branches.
- `npm run all` from repo root must pass before any push.
- VSCode webview enforces strict CSP (no inline `style=` / inline event handlers); use CSS classes + `addEventListener`.
- Test fixtures use `node:sqlite` `DatabaseSync` directly. Each CREATE/INSERT is run via `prepare(sql).run()` — one statement per call (DatabaseSync.prepare requires single statements).

---

## File Structure

### New files (CLI)

| Path | Responsibility |
|---|---|
| [`cli/src/core/SqliteHelpers.ts`](../../../cli/src/core/SqliteHelpers.ts) | Generic SQLite open / version-gate / error-classify helpers. Pure-refactor extraction from `OpenCodeSessionDiscoverer.ts`. |
| [`cli/src/core/SqliteHelpers.test.ts`](../../../cli/src/core/SqliteHelpers.test.ts) | Unit tests for the extracted helpers. |
| [`cli/src/core/CopilotDetector.ts`](../../../cli/src/core/CopilotDetector.ts) | Resolve `~/.copilot/session-store.db`. Gate on Node SQLite support. |
| [`cli/src/core/CopilotDetector.test.ts`](../../../cli/src/core/CopilotDetector.test.ts) | |
| [`cli/src/core/CopilotSessionDiscoverer.ts`](../../../cli/src/core/CopilotSessionDiscoverer.ts) | `scanCopilotSessions(projectDir)` — exact `cwd` match (case-insensitive on macOS/Windows). |
| [`cli/src/core/CopilotSessionDiscoverer.test.ts`](../../../cli/src/core/CopilotSessionDiscoverer.test.ts) | |
| [`cli/src/core/CopilotTranscriptReader.ts`](../../../cli/src/core/CopilotTranscriptReader.ts) | Reads `turns` table; maps `user_message` → `human` / `assistant_response` → `assistant`. |
| [`cli/src/core/CopilotTranscriptReader.test.ts`](../../../cli/src/core/CopilotTranscriptReader.test.ts) | |

### Modified files (CLI)

| Path | What changes |
|---|---|
| [`cli/src/core/OpenCodeSessionDiscoverer.ts`](../../../cli/src/core/OpenCodeSessionDiscoverer.ts) | Replace inline helpers with imports + deprecated re-exports from `SqliteHelpers.ts`. |
| [`cli/src/core/OpenCodeTranscriptReader.ts`](../../../cli/src/core/OpenCodeTranscriptReader.ts) | Switch import to `withSqliteDb` from `SqliteHelpers.ts`. |
| [`cli/src/Types.ts`](../../../cli/src/Types.ts) | Add `"copilot"` to `TranscriptSource`; `copilotEnabled?` to `JolliMemoryConfig`; `copilotDetected?`, `copilotEnabled?`, `copilotScanError?` to `StatusInfo`. |
| [`cli/src/core/SessionTracker.ts`](../../../cli/src/core/SessionTracker.ts) | Add `copilotEnabled === false` filter branch. |
| [`cli/src/install/Installer.ts`](../../../cli/src/install/Installer.ts) | Auto-detect Copilot during install; surface in `getStatus()`. |
| [`cli/src/hooks/QueueWorker.ts`](../../../cli/src/hooks/QueueWorker.ts) | Discover Copilot sessions in the post-commit pipeline; route reads. |
| [`cli/src/commands/StatusCommand.ts`](../../../cli/src/commands/StatusCommand.ts) | Add a "Copilot Integration" row mirroring OpenCode's. |
| [`cli/src/commands/ConfigureCommand.ts`](../../../cli/src/commands/ConfigureCommand.ts) | Accept `copilotEnabled` as a settable key. |

### Modified files (VSCode)

| Path | What changes |
|---|---|
| [`vscode/src/providers/StatusTreeProvider.ts`](../../../vscode/src/providers/StatusTreeProvider.ts) | Copilot integration row + scanError surfacing. |
| [`vscode/src/views/SummaryWebviewPanel.ts`](../../../vscode/src/views/SummaryWebviewPanel.ts) | Include `"copilot"` in `getEnabledSources()`. |
| [`vscode/src/views/SummaryScriptBuilder.ts`](../../../vscode/src/views/SummaryScriptBuilder.ts) | Map `copilot` → `"Copilot"`; add to `sourceOrder`. |
| [`vscode/src/views/SettingsHtmlBuilder.ts`](../../../vscode/src/views/SettingsHtmlBuilder.ts) | Toggle row "Copilot". |
| [`vscode/src/views/SettingsScriptBuilder.ts`](../../../vscode/src/views/SettingsScriptBuilder.ts) | DOM ref + dirty-check + validation + save payload + load handler. |
| [`vscode/src/views/SettingsWebviewPanel.ts`](../../../vscode/src/views/SettingsWebviewPanel.ts) | `copilotEnabled` field on `SettingsPayload` + load/save. |

Plus paired `*.test.ts` updates.

---

## Phases (commit ordering)

1. **Phase 0** — Extract `SqliteHelpers` (pure refactor, zero behavior change).
2. **Phase 1+2** — Copilot core modules + Types/Config/SessionTracker (committed together because Phase 1 needs the widened `TranscriptSource`).
3. **Phase 3** — Installer auto-detect + status.
4. **Phase 4** — QueueWorker pipeline.
5. **Phase 5** — CLI Status / Configure commands.
6. **Phase 6** — VSCode StatusTreeProvider.
7. **Phase 7** — VSCode Summary panel + script.
8. **Phase 8** — VSCode Settings panel + script + html.
9. **Phase 9** — `npm run all` + manual smoke check.

---

## Phase 0 — Extract SqliteHelpers

**Why:** Spec calls for `SqliteHelpers` to be the shared SQLite plumbing. PR #65 plans the same extraction but is open and not in main; we land it here with the identical public surface so PR #65 can resolve by deleting its own copy.

### Task 0.1: Create `SqliteHelpers.ts`

**Files:** Create `cli/src/core/SqliteHelpers.ts`.

- [ ] **Step 1: Write the file**

Copy lines 38–191 of `cli/src/core/OpenCodeSessionDiscoverer.ts` and rename to agent-agnostic symbols (the logic is identical):

```ts
/**
 * Shared helpers for reading SQLite databases produced by external AI agents
 * (OpenCode, Copilot CLI, Cursor — all use the same node:sqlite read pattern).
 */

/**
 * Database handle shape passed to `withSqliteDb` callbacks.
 *
 * Structurally typed against node:sqlite's DatabaseSync rather than importing
 * the type directly, so the module is not loaded until the helper runs — this
 * keeps the ExperimentalWarning out of every PostCommitHook invocation that
 * only transitively imports this file.
 */
export interface SqliteDbHandle {
	prepare(sql: string): {
		all(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown[];
		get(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown;
		run(params?: Record<string, unknown> | unknown, ...rest: unknown[]): unknown;
	};
	close(): void;
}

/**
 * Opens a SQLite database read-only, runs a callback, then closes it.
 * Uses Node's built-in `node:sqlite` (statically linked; full WAL support).
 * Lazy-imports the module so the ExperimentalWarning only appears when this
 * helper is actually invoked.
 */
export async function withSqliteDb<T>(dbPath: string, fn: (db: SqliteDbHandle) => T): Promise<T> {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return fn(db as unknown as SqliteDbHandle);
	} finally {
		db.close();
	}
}

/** Minimum Node version that ships `node:sqlite`. */
export const NODE_SQLITE_MIN_VERSION = { major: 22, minor: 5 } as const;

export function hasNodeSqliteSupport(nodeVersion: string = process.versions.node): boolean {
	const match = /^(\d+)\.(\d+)/.exec(nodeVersion);
	/* v8 ignore start -- defensive */
	if (!match) return false;
	/* v8 ignore stop */
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	if (major > NODE_SQLITE_MIN_VERSION.major) return true;
	if (major < NODE_SQLITE_MIN_VERSION.major) return false;
	return minor >= NODE_SQLITE_MIN_VERSION.minor;
}

export type SqliteScanErrorKind = "corrupt" | "locked" | "permission" | "schema" | "unknown";

export interface SqliteScanError {
	readonly kind: SqliteScanErrorKind;
	readonly message: string;
}

/** Returns null for ENOENT (silent), otherwise classifies the error. */
export function classifyScanError(error: unknown): SqliteScanError | null {
	const err = error as (Error & { code?: string }) | undefined;
	const message = err?.message ?? String(error);
	const code = err?.code;
	if (code === "ENOENT") return null;
	if (code === "EACCES" || code === "EPERM") return { kind: "permission", message };
	if (/SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database/i.test(message)) {
		return { kind: "corrupt", message };
	}
	if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)) {
		return { kind: "locked", message };
	}
	if (/no such table|no such column/i.test(message)) {
		return { kind: "schema", message };
	}
	if (/SQLITE_CANTOPEN|unable to open/i.test(message)) {
		return { kind: "permission", message };
	}
	return { kind: "unknown", message };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:cli`
Expected: passes (file is self-contained).

### Task 0.2: Migrate OpenCode files to import from SqliteHelpers

**Files:** Modify `cli/src/core/OpenCodeSessionDiscoverer.ts` and `cli/src/core/OpenCodeTranscriptReader.ts`.

- [ ] **Step 1: Update OpenCodeSessionDiscoverer imports + delete inlined helpers**

In `cli/src/core/OpenCodeSessionDiscoverer.ts`:

1. Add import block near the existing `import type { SessionInfo }`:

```ts
import {
	type SqliteDbHandle,
	type SqliteScanError,
	type SqliteScanErrorKind,
	classifyScanError as classifySqliteScanError,
	hasNodeSqliteSupport,
	NODE_SQLITE_MIN_VERSION,
	withSqliteDb,
} from "./SqliteHelpers.js";
```

2. **Delete** the inline definitions: `OpenCodeDbHandle` interface, `withOpenCodeDb` function, `NODE_SQLITE_MIN_VERSION`, `hasNodeSqliteSupport`, `OpenCodeScanErrorKind`/`OpenCodeScanError` types, and `classifyScanError` function. (Lines 38–191 in the current file.)

3. Append deprecated re-exports so external callers keep working:

```ts
/** @deprecated Use SqliteDbHandle from ./SqliteHelpers.js */
export type OpenCodeDbHandle = SqliteDbHandle;

/** @deprecated Use withSqliteDb from ./SqliteHelpers.js */
export const withOpenCodeDb = withSqliteDb;

/** @deprecated Use SqliteScanErrorKind from ./SqliteHelpers.js */
export type OpenCodeScanErrorKind = SqliteScanErrorKind;

/** @deprecated Use SqliteScanError from ./SqliteHelpers.js */
export type OpenCodeScanError = SqliteScanError;

/** @deprecated Use classifyScanError from ./SqliteHelpers.js */
export const classifyScanError = classifySqliteScanError;

export { hasNodeSqliteSupport, NODE_SQLITE_MIN_VERSION };
```

Existing call sites inside this file (e.g. `withOpenCodeDb(dbPath, …)`, `classifyScanError(error)`) continue to resolve through the re-exports.

- [ ] **Step 2: Update OpenCodeTranscriptReader import**

In `cli/src/core/OpenCodeTranscriptReader.ts`:

```ts
// REPLACE
import { withOpenCodeDb } from "./OpenCodeSessionDiscoverer.js";
// WITH
import { withSqliteDb } from "./SqliteHelpers.js";
```

Then replace the single `withOpenCodeDb(` call site (~line 54) with `withSqliteDb(`.

- [ ] **Step 3: Run typecheck + opencode tests**

Run: `npm run typecheck:cli && npm run test -w @jolli.ai/cli -- src/core/OpenCodeSessionDiscoverer.test.ts src/core/OpenCodeTranscriptReader.test.ts`
Expected: PASS — zero behavior change, no test edits required.

### Task 0.3: Add `SqliteHelpers.test.ts`

**Files:** Create `cli/src/core/SqliteHelpers.test.ts`.

- [ ] **Step 1: Write tests**

```ts
import { describe, expect, it } from "vitest";
import {
	classifyScanError,
	hasNodeSqliteSupport,
	NODE_SQLITE_MIN_VERSION,
	withSqliteDb,
} from "./SqliteHelpers.js";

describe("hasNodeSqliteSupport", () => {
	it.each([
		["22.5.0", true],
		["22.10.1", true],
		["23.0.0", true],
		["100.0.0", true],
		["22.4.99", false],
		["21.99.0", false],
		["18.0.0", false],
	])("returns %s for Node %s", (version, expected) => {
		expect(hasNodeSqliteSupport(version)).toBe(expected);
	});

	it("uses NODE_SQLITE_MIN_VERSION as the boundary", () => {
		const { major, minor } = NODE_SQLITE_MIN_VERSION;
		expect(hasNodeSqliteSupport(`${major}.${minor}.0`)).toBe(true);
		expect(hasNodeSqliteSupport(`${major}.${minor - 1}.99`)).toBe(false);
	});
});

describe("classifyScanError", () => {
	it("returns null for ENOENT", () => {
		const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
		expect(classifyScanError(err)).toBeNull();
	});

	it.each([
		[Object.assign(new Error("denied"), { code: "EACCES" }), "permission"],
		[Object.assign(new Error("denied"), { code: "EPERM" }), "permission"],
		[new Error("SQLITE_CORRUPT: malformed"), "corrupt"],
		[new Error("file is not a database"), "corrupt"],
		[new Error("SQLITE_BUSY: database is locked"), "locked"],
		[new Error("database is locked"), "locked"],
		[new Error("no such table: sessions"), "schema"],
		[new Error("no such column: cwd"), "schema"],
		[new Error("SQLITE_CANTOPEN"), "permission"],
		[new Error("unable to open database file"), "permission"],
		[new Error("anything else weird"), "unknown"],
	])("classifies %s as %s", (err, kind) => {
		expect(classifyScanError(err)).toEqual({ kind, message: expect.any(String) });
	});

	it("falls back to String(error) for non-Error values", () => {
		expect(classifyScanError("plain string failure")).toEqual({ kind: "unknown", message: "plain string failure" });
	});
});

describe("withSqliteDb", () => {
	it("opens a real DB read-only, runs the callback, then closes", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdtemp } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { DatabaseSync } = await import("node:sqlite");
		const dir = await mkdtemp(join(tmpdir(), "sqlite-helpers-"));
		const dbPath = join(dir, "x.db");

		// Seed: one CREATE then one INSERT, each through prepare().run() so this test
		// works on every node:sqlite version (DatabaseSync.prepare accepts only single
		// statements).
		const seed = new DatabaseSync(dbPath);
		seed.prepare("CREATE TABLE t (k TEXT)").run();
		seed.prepare("INSERT INTO t (k) VALUES ('hi')").run();
		seed.close();

		const value = await withSqliteDb(dbPath, (db) => {
			return (db.prepare("SELECT k FROM t").get() as { k: string }).k;
		});
		expect(value).toBe("hi");
	});

	it("propagates errors from the callback", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdtemp } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { DatabaseSync } = await import("node:sqlite");
		const dir = await mkdtemp(join(tmpdir(), "sqlite-helpers-"));
		const dbPath = join(dir, "x.db");
		new DatabaseSync(dbPath).close();

		await expect(
			withSqliteDb(dbPath, () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});
```

- [ ] **Step 2: Run**

Run: `npm run test -w @jolli.ai/cli -- src/core/SqliteHelpers.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit Phase 0**

```bash
git add cli/src/core/SqliteHelpers.ts cli/src/core/SqliteHelpers.test.ts \
        cli/src/core/OpenCodeSessionDiscoverer.ts cli/src/core/OpenCodeTranscriptReader.ts
git commit -s -m "$(cat <<'EOF'
refactor: extract SqliteHelpers from OpenCodeSessionDiscoverer

Pure refactor. OpenCode keeps deprecated re-exports (OpenCodeDbHandle,
withOpenCodeDb, classifyScanError, etc.) for backward compatibility —
zero behavior change, all existing tests pass without edits.

PR #65 (Cursor) plans the same extraction with the identical public
surface; whichever PR merges first owns the file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 1 + Phase 2 — Copilot core + Types/Config/SessionTracker

These phases land in one commit because Phase 1's `source: "copilot"` literal requires Phase 2's `TranscriptSource` widening to typecheck. Implement in this order: Types → SessionTracker → Detector → Discoverer → TranscriptReader.

### Task 1.0: Widen `TranscriptSource`, add config + status fields

**Files:** Modify `cli/src/Types.ts`.

- [ ] **Step 1: Widen the union (line 8)**

```ts
// REPLACE
export type TranscriptSource = "claude" | "codex" | "gemini" | "opencode";
// WITH
export type TranscriptSource = "claude" | "codex" | "gemini" | "opencode" | "copilot";
```

- [ ] **Step 2: Add `copilotEnabled` to `JolliMemoryConfig`**

After the existing `openCodeEnabled?: boolean;` line (~488):

```ts
	/** Enable GitHub Copilot CLI session discovery at post-commit time (default: auto-detect) */
	readonly copilotEnabled?: boolean;
```

- [ ] **Step 3: Add Copilot fields to `StatusInfo`**

After the existing `openCodeEnabled?: boolean;` line in `StatusInfo` (~560):

```ts
	/** Whether Copilot CLI's session DB (~/.copilot/session-store.db) was detected */
	readonly copilotDetected?: boolean;
	/** Whether Copilot CLI session discovery is enabled in config (undefined = auto-detect) */
	readonly copilotEnabled?: boolean;
```

After the existing `openCodeScanError?: { … }` block at the end of `StatusInfo`:

```ts
	/** Copilot DB scan failed with a real (non-ENOENT) error. Same UI semantics as openCodeScanError. */
	readonly copilotScanError?: {
		readonly kind: "corrupt" | "locked" | "permission" | "schema" | "unknown";
		readonly message: string;
	};
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:cli`
Expected: PASS.

### Task 1.1: Filter copilot sessions when disabled

**Files:** Modify `cli/src/core/SessionTracker.ts` and its test.

- [ ] **Step 1: Add tests**

In `cli/src/core/SessionTracker.test.ts`, inside the existing `describe("filterSessionsByEnabledIntegrations", …)` block:

```ts
it("filters out copilot sessions when copilotEnabled is false", () => {
	const sessions = [
		{ sessionId: "a", transcriptPath: "/a", updatedAt: "2026-05-05T00:00:00Z", source: "claude" as const },
		{ sessionId: "b", transcriptPath: "/b", updatedAt: "2026-05-05T00:00:00Z", source: "copilot" as const },
	];
	const result = filterSessionsByEnabledIntegrations(sessions, { copilotEnabled: false });
	expect(result.map((s) => s.sessionId)).toEqual(["a"]);
});

it("keeps copilot sessions when copilotEnabled is unset or true", () => {
	const sessions = [
		{ sessionId: "b", transcriptPath: "/b", updatedAt: "2026-05-05T00:00:00Z", source: "copilot" as const },
	];
	expect(filterSessionsByEnabledIntegrations(sessions, {})).toHaveLength(1);
	expect(filterSessionsByEnabledIntegrations(sessions, { copilotEnabled: true })).toHaveLength(1);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts -t copilot`
Expected: FAIL.

- [ ] **Step 3: Add the filter branch**

In `cli/src/core/SessionTracker.ts`, after the `if (config.openCodeEnabled === false)` block (~line 166):

```ts
	if (config.copilotEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "copilot");
	}
```

- [ ] **Step 4: Run — expect pass**

Expected: PASS.

### Task 1.2: `CopilotDetector.ts`

**Files:** Create `cli/src/core/CopilotDetector.ts` and `cli/src/core/CopilotDetector.test.ts`.

- [ ] **Step 1: Write tests**

```ts
import { stat } from "node:fs/promises";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return { ...actual, stat: vi.fn() };
});

describe("CopilotDetector", () => {
	beforeEach(() => {
		vi.spyOn(os, "homedir").mockReturnValue("/Users/test");
		vi.spyOn(os, "platform").mockReturnValue("darwin");
		vi.mocked(stat).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns ~/.copilot/session-store.db on macOS/Linux", async () => {
		const { getCopilotDbPath } = await import("./CopilotDetector.js");
		expect(getCopilotDbPath()).toBe("/Users/test/.copilot/session-store.db");
	});

	it("returns the equivalent path on Windows", async () => {
		vi.spyOn(os, "platform").mockReturnValue("win32");
		vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\test");
		const { getCopilotDbPath } = await import("./CopilotDetector.js");
		expect(getCopilotDbPath()).toContain(".copilot");
		expect(getCopilotDbPath()).toContain("session-store.db");
	});

	it("isCopilotInstalled returns true when DB exists", async () => {
		vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
		const { isCopilotInstalled } = await import("./CopilotDetector.js");
		await expect(isCopilotInstalled()).resolves.toBe(true);
	});

	it("isCopilotInstalled returns false when DB is missing", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("no file"), { code: "ENOENT" }));
		const { isCopilotInstalled } = await import("./CopilotDetector.js");
		await expect(isCopilotInstalled()).resolves.toBe(false);
	});

	it("isCopilotInstalled returns false when runtime lacks node:sqlite", async () => {
		vi.doMock("./SqliteHelpers.js", async () => {
			const actual = await vi.importActual<typeof import("./SqliteHelpers.js")>("./SqliteHelpers.js");
			return { ...actual, hasNodeSqliteSupport: () => false };
		});
		const { isCopilotInstalled } = await import("./CopilotDetector.js");
		await expect(isCopilotInstalled()).resolves.toBe(false);
		vi.doUnmock("./SqliteHelpers.js");
	});
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotDetector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * GitHub Copilot CLI detector.
 *
 * Copilot CLI stores conversations in ~/.copilot/session-store.db (SQLite, WAL).
 * We read the DB via node:sqlite — pure-JS SQLite libraries cannot see WAL data.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { hasNodeSqliteSupport, NODE_SQLITE_MIN_VERSION } from "./SqliteHelpers.js";

const log = createLogger("CopilotDetector");

/** Returns the absolute path to Copilot CLI's session-store database. */
export function getCopilotDbPath(): string {
	return join(homedir(), ".copilot", "session-store.db");
}

/**
 * Returns true when Copilot CLI's session DB is present *and* the current
 * runtime can read it. Mirrors `isOpenCodeInstalled`'s shape.
 */
export async function isCopilotInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Copilot CLI support disabled: this runtime is Node %s, requires %d.%d+ for built-in SQLite",
			process.versions.node,
			NODE_SQLITE_MIN_VERSION.major,
			NODE_SQLITE_MIN_VERSION.minor,
		);
		return false;
	}
	const dbPath = getCopilotDbPath();
	try {
		const fileStat = await stat(dbPath);
		return fileStat.isFile();
	} catch {
		return false;
	}
}
```

- [ ] **Step 4: Run — expect pass**

Expected: PASS, all 5 tests green.

### Task 1.3: `CopilotSessionDiscoverer.ts`

**Files:** Create `cli/src/core/CopilotSessionDiscoverer.ts` and its test.

- [ ] **Step 1: Write tests (build fixtures via prepare/run, one statement at a time)**

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCHEMA_STATEMENTS = [
	`CREATE TABLE sessions (
		id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT,
		branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT
	)`,
	`CREATE TABLE turns (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		turn_index INTEGER NOT NULL,
		user_message TEXT, assistant_response TEXT, timestamp TEXT
	)`,
];

interface SeedSession {
	id: string;
	cwd: string;
	updated_at: string;
}

async function makeFixtureDb(sessions: SeedSession[]): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "copilot-disc-"));
	const dbPath = join(dir, "session-store.db");
	const db = new DatabaseSync(dbPath);
	for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run();
	const insertSql =
		"INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at) " +
		"VALUES (?, ?, NULL, 'github', NULL, NULL, ?, ?)";
	const insert = db.prepare(insertSql);
	for (const s of sessions) insert.run(s.id, s.cwd, s.updated_at, s.updated_at);
	db.close();
	return { dbPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("scanCopilotSessions", () => {
	let cleanups: Array<() => Promise<void>>;

	beforeEach(() => { cleanups = []; });
	afterEach(async () => {
		for (const c of cleanups) await c();
		vi.restoreAllMocks();
	});

	async function withFixture(seeds: SeedSession[]) {
		const fx = await makeFixtureDb(seeds);
		cleanups.push(fx.cleanup);
		const detector = await import("./CopilotDetector.js");
		vi.spyOn(detector, "getCopilotDbPath").mockReturnValue(fx.dbPath);
		return fx;
	}

	it("returns sessions whose cwd matches the project directory", async () => {
		await withFixture([
			{ id: "a", cwd: "/Users/x/project", updated_at: "2026-05-05T07:00:00.000Z" },
			{ id: "b", cwd: "/other", updated_at: "2026-05-05T08:00:00.000Z" },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions("/Users/x/project");
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ sessionId: "a", source: "copilot" });
		expect(sessions[0].transcriptPath).toMatch(/session-store\.db#a$/);
	});

	it("normalizes trailing slashes on the projectDir", async () => {
		await withFixture([{ id: "a", cwd: "/Users/x/project", updated_at: "2026-05-05T07:00:00.000Z" }]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions("/Users/x/project/");
		expect(sessions).toHaveLength(1);
	});

	it("matches case-insensitively on darwin/win32", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		await withFixture([{ id: "a", cwd: "/Users/X/Project", updated_at: "2026-05-05T07:00:00.000Z" }]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions("/users/x/project");
		expect(sessions).toHaveLength(1);
	});

	it("returns empty when nothing matches", async () => {
		await withFixture([{ id: "a", cwd: "/elsewhere", updated_at: "2026-05-05T07:00:00.000Z" }]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions("/Users/x/project");
		expect(sessions).toEqual([]);
	});

	it("returns empty silently when the DB file is missing", async () => {
		const detector = await import("./CopilotDetector.js");
		vi.spyOn(detector, "getCopilotDbPath").mockReturnValue("/tmp/does-not-exist/x.db");
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions, error } = await scanCopilotSessions("/Users/x/project");
		expect(sessions).toEqual([]);
		expect(error).toBeUndefined();
	});

	it("classifies a corrupt DB as a scan error", async () => {
		const dir = await mkdtemp(join(tmpdir(), "copilot-disc-"));
		const dbPath = join(dir, "session-store.db");
		await writeFile(dbPath, "not a sqlite file");
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const detector = await import("./CopilotDetector.js");
		vi.spyOn(detector, "getCopilotDbPath").mockReturnValue(dbPath);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions, error } = await scanCopilotSessions("/Users/x/project");
		expect(sessions).toEqual([]);
		expect(error?.kind).toBe("corrupt");
	});

	it("skips a row whose updated_at is non-finite", async () => {
		await withFixture([
			{ id: "good", cwd: "/p", updated_at: "2026-05-05T07:00:00.000Z" },
			{ id: "bad", cwd: "/p", updated_at: "not-a-date" },
		]);
		const { scanCopilotSessions } = await import("./CopilotSessionDiscoverer.js");
		const { sessions } = await scanCopilotSessions("/p");
		expect(sessions.map((s) => s.sessionId)).toEqual(["good"]);
	});
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement**

```ts
/**
 * GitHub Copilot CLI session discoverer.
 *
 * Copilot stores every session in ~/.copilot/session-store.db. Each session row
 * carries its own `cwd`, so workspace attribution is exact — no time-window
 * heuristic. Synthetic transcript path: "<dbPath>#<sessionId>".
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getCopilotDbPath } from "./CopilotDetector.js";
import { classifyScanError, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("CopilotDiscoverer");

export interface CopilotScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: SqliteScanError;
}

function normalizeCwd(p: string): string {
	return resolve(p);
}

export async function scanCopilotSessions(projectDir: string): Promise<CopilotScanResult> {
	const dbPath = getCopilotDbPath();
	const normalized = normalizeCwd(projectDir);

	try {
		await stat(dbPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		/* v8 ignore start -- TOCTOU branch covered by classifier tests */
		if (code !== "ENOENT") {
			const scanError = classifyScanError(error);
			if (scanError) {
				log.error("Copilot DB stat failed (%s): %s", scanError.kind, scanError.message);
				return { sessions: [], error: scanError };
			}
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.debug("Copilot DB not present at %s — treating as not installed", dbPath);
		return { sessions: [] };
	}

	try {
		const sessions = await withSqliteDb(dbPath, (db) => {
			const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
			const cwdMatch = caseInsensitive ? "LOWER(cwd) = LOWER(:cwd)" : "cwd = :cwd";
			const rows = db
				.prepare(
					`SELECT id, cwd, repository, branch, host_type, summary, created_at, updated_at
					 FROM sessions
					 WHERE ${cwdMatch}
					 ORDER BY updated_at DESC`,
				)
				.all({ cwd: normalized }) as ReadonlyArray<{ id: string; updated_at: string }>;
			return rows.flatMap((row): SessionInfo[] => {
				const ms = Date.parse(row.updated_at);
				if (!Number.isFinite(ms)) {
					log.warn("Skipping Copilot session %s: non-finite updated_at", row.id);
					return [];
				}
				return [
					{
						sessionId: String(row.id),
						transcriptPath: `${dbPath}#${row.id}`,
						updatedAt: new Date(ms).toISOString(),
						source: "copilot",
					},
				];
			});
		});
		log.info("Discovered %d Copilot session(s) for %s", sessions.length, normalized);
		return { sessions };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU branch covered by classifier tests */
		if (scanError === null) {
			log.debug("Copilot DB disappeared between detection and scan: %s", (error as Error).message);
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.error("Copilot scan failed (%s): %s", scanError.kind, scanError.message);
		return { sessions: [], error: scanError };
	}
}

/** Convenience wrapper without the error channel — used by QueueWorker. */
export async function discoverCopilotSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanCopilotSessions(projectDir);
	return sessions;
}
```

- [ ] **Step 4: Run — expect pass**

Expected: PASS.

### Task 1.4: `CopilotTranscriptReader.ts`

**Files:** Create `cli/src/core/CopilotTranscriptReader.ts` and its test.

- [ ] **Step 1: Write tests**

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCHEMA_STATEMENTS = [
	"CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)",
	`CREATE TABLE turns (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		session_id TEXT NOT NULL,
		turn_index INTEGER NOT NULL,
		user_message TEXT, assistant_response TEXT, timestamp TEXT
	)`,
];

interface SeedTurn {
	turn_index: number;
	user_message?: string | null;
	assistant_response?: string | null;
	timestamp?: string;
}

async function makeDb(sessionId: string, turns: SeedTurn[]): Promise<{ dbPath: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "copilot-tr-"));
	const dbPath = join(dir, "session-store.db");
	const db = new DatabaseSync(dbPath);
	for (const stmt of SCHEMA_STATEMENTS) db.prepare(stmt).run();
	db.prepare("INSERT INTO sessions (id, cwd) VALUES (?, '/x')").run(sessionId);
	const ins = db.prepare(
		"INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)",
	);
	for (const t of turns) {
		ins.run(
			sessionId,
			t.turn_index,
			t.user_message ?? null,
			t.assistant_response ?? null,
			t.timestamp ?? "2026-05-05T07:00:00.000Z",
		);
	}
	db.close();
	return { dbPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("readCopilotTranscript", () => {
	let cleanups: Array<() => Promise<void>>;

	beforeEach(() => { cleanups = []; });
	afterEach(async () => { for (const c of cleanups) await c(); });

	it("returns ordered human/assistant entries", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "hi", assistant_response: "hello" },
			{ turn_index: 1, user_message: "how are you", assistant_response: "good" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`);
		expect(result.entries.map((e) => [e.role, e.content])).toEqual([
			["human", "hi"],
			["assistant", "hello"],
			["human", "how are you"],
			["assistant", "good"],
		]);
		expect(result.totalLinesRead).toBe(2);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("skips empty/null messages within a turn", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "hi", assistant_response: null },
			{ turn_index: 1, user_message: "", assistant_response: "ack" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`);
		expect(result.entries.map((e) => [e.role, e.content])).toEqual([
			["human", "hi"],
			["assistant", "ack"],
		]);
	});

	it("resumes from a cursor", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "first", assistant_response: "ok" },
			{ turn_index: 1, user_message: "second", assistant_response: "yep" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`, {
			transcriptPath: `${dbPath}#s1`,
			lineNumber: 1,
			updatedAt: "2026-05-05T07:00:00.000Z",
		});
		expect(result.entries.map((e) => e.content)).toEqual(["second", "yep"]);
	});

	it("respects beforeTimestamp cutoff", async () => {
		const { dbPath, cleanup } = await makeDb("s1", [
			{ turn_index: 0, user_message: "early", assistant_response: "ok", timestamp: "2026-05-05T07:00:00.000Z" },
			{ turn_index: 1, user_message: "late", assistant_response: "no", timestamp: "2026-05-05T09:00:00.000Z" },
		]);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`, null, "2026-05-05T08:00:00.000Z");
		expect(result.entries.map((e) => e.content)).toEqual(["early", "ok"]);
		expect(result.newCursor.lineNumber).toBe(1);
	});

	it("throws on a malformed transcriptPath", async () => {
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		await expect(readCopilotTranscript("no-hash-marker")).rejects.toThrow(/Invalid Copilot transcript path/);
	});

	it("returns empty when the session has no rows", async () => {
		const { dbPath, cleanup } = await makeDb("s1", []);
		cleanups.push(cleanup);
		const { readCopilotTranscript } = await import("./CopilotTranscriptReader.js");
		const result = await readCopilotTranscript(`${dbPath}#s1`);
		expect(result.entries).toEqual([]);
		expect(result.newCursor.lineNumber).toBe(0);
	});
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Implement**

```ts
/**
 * Reads conversation turns from Copilot CLI's session-store SQLite database.
 *
 * Each `turns` row contains a (user_message, assistant_response) pair, ordered
 * by turn_index. We expand each row into two TranscriptEntry items, skipping
 * empty/null messages.
 *
 * Cursor tracks turn_index — the count of fully-consumed turns from the last
 * read — to support incremental reads across post-commit invocations.
 */

import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { withSqliteDb } from "./SqliteHelpers.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("CopilotTranscriptReader");

export async function readCopilotTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const { dbPath, sessionId } = parseSyntheticPath(transcriptPath);
	const startIndex = cursor?.lineNumber ?? 0;
	const cutoffMs = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;

	try {
		const { rawEntries, totalTurns, lastConsumedIndex } = await withSqliteDb(dbPath, (db) => {
			const rows = db
				.prepare(
					`SELECT turn_index, user_message, assistant_response, timestamp
					 FROM turns
					 WHERE session_id = :sessionId
					 ORDER BY turn_index ASC`,
				)
				.all({ sessionId }) as ReadonlyArray<{
				turn_index: number;
				user_message: string | null;
				assistant_response: string | null;
				timestamp: string | null;
			}>;
			const newRows = rows.slice(startIndex);
			const out: TranscriptEntry[] = [];
			let consumed = startIndex;
			for (let i = 0; i < newRows.length; i++) {
				const r = newRows[i];
				if (cutoffMs !== undefined && r.timestamp) {
					const ts = Date.parse(r.timestamp);
					if (Number.isFinite(ts) && ts > cutoffMs) break;
				}
				const tsIso = r.timestamp && Number.isFinite(Date.parse(r.timestamp)) ? r.timestamp : undefined;
				if (typeof r.user_message === "string" && r.user_message.trim().length > 0) {
					out.push({ role: "human", content: r.user_message, timestamp: tsIso });
				}
				if (typeof r.assistant_response === "string" && r.assistant_response.trim().length > 0) {
					out.push({ role: "assistant", content: r.assistant_response, timestamp: tsIso });
				}
				consumed = startIndex + i + 1;
			}
			return { rawEntries: out, totalTurns: rows.length, lastConsumedIndex: consumed };
		});

		const entries = mergeConsecutiveEntries(rawEntries);
		const newCursor: TranscriptCursor = {
			transcriptPath,
			lineNumber: beforeTimestamp ? lastConsumedIndex : totalTurns,
			updatedAt: new Date().toISOString(),
		};
		const totalLinesRead = lastConsumedIndex - startIndex;
		log.info(
			"Read Copilot session %s: %d new turns, %d entries (index %d→%d)",
			sessionId.substring(0, 8),
			totalLinesRead,
			entries.length,
			startIndex,
			newCursor.lineNumber,
		);
		return { entries, newCursor, totalLinesRead };
	} catch (error: unknown) {
		log.error("Failed to read Copilot session %s: %s", sessionId.substring(0, 8), (error as Error).message);
		throw new Error(`Cannot read Copilot session: ${sessionId}`);
	}
}

function parseSyntheticPath(transcriptPath: string): { dbPath: string; sessionId: string } {
	const hashIndex = transcriptPath.lastIndexOf("#");
	if (hashIndex === -1) {
		throw new Error(`Invalid Copilot transcript path (missing #sessionId): ${transcriptPath}`);
	}
	const dbPath = transcriptPath.substring(0, hashIndex);
	const sessionId = transcriptPath.substring(hashIndex + 1);
	if (dbPath.length === 0 || sessionId.length === 0) {
		throw new Error(`Invalid Copilot transcript path (empty dbPath or sessionId): ${transcriptPath}`);
	}
	return { dbPath, sessionId };
}
```

- [ ] **Step 4: Run — expect pass.**

### Task 1.5: Commit Phase 1 + Phase 2

- [ ] **Step 1: Commit**

```bash
git add cli/src/Types.ts \
        cli/src/core/SessionTracker.ts cli/src/core/SessionTracker.test.ts \
        cli/src/core/CopilotDetector.ts cli/src/core/CopilotDetector.test.ts \
        cli/src/core/CopilotSessionDiscoverer.ts cli/src/core/CopilotSessionDiscoverer.test.ts \
        cli/src/core/CopilotTranscriptReader.ts cli/src/core/CopilotTranscriptReader.test.ts
git commit -s -m "$(cat <<'EOF'
feat(cli): add Copilot CLI as a transcript source — core modules

Three new modules under cli/src/core:
- CopilotDetector: resolves ~/.copilot/session-store.db, gates on Node SQLite support.
- CopilotSessionDiscoverer: SELECT … FROM sessions WHERE cwd = ? against the
  Copilot CLI database (case-insensitive on macOS/Windows). Returns one
  SessionInfo per match with source="copilot" and a synthetic <dbPath>#<sessionId>
  transcript path matching the OpenCode pattern.
- CopilotTranscriptReader: reads the turns table in order, expands each
  (user_message, assistant_response) pair into one human + one assistant
  TranscriptEntry, supports cursor-based incremental reads and beforeTimestamp.

Adds "copilot" to TranscriptSource, copilotEnabled to JolliMemoryConfig, and
{copilotDetected, copilotEnabled, copilotScanError} to StatusInfo. SessionTracker
filters copilot sessions when copilotEnabled === false, mirroring OpenCode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Installer auto-detect + status

### Task 3.1: Auto-enable on install

**Files:** Modify `cli/src/install/Installer.ts` and its test.

- [ ] **Step 1: Add tests**

In `cli/src/install/Installer.test.ts`, near the existing `openCodeEnabled` auto-enable test, add:

```ts
it("auto-enables Copilot when DB is detected and config is undefined", async () => {
	const detector = await import("../core/CopilotDetector.js");
	vi.spyOn(detector, "isCopilotInstalled").mockResolvedValue(true);
	// (re-use the same setup helpers the openCode test uses for projectDir + config)
	await install(projectDir);
	const config = await loadConfig();
	expect(config.copilotEnabled).toBe(true);
});

it("does not overwrite copilotEnabled when explicitly set", async () => {
	const detector = await import("../core/CopilotDetector.js");
	vi.spyOn(detector, "isCopilotInstalled").mockResolvedValue(true);
	await saveConfig({ copilotEnabled: false });
	await install(projectDir);
	const config = await loadConfig();
	expect(config.copilotEnabled).toBe(false);
});
```

(Adapt the helpers from the existing `openCodeEnabled` test in this file — do not invent new helpers.)

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Wire auto-detect**

In `cli/src/install/Installer.ts`:

1. Add to imports near the existing OpenCode imports:

```ts
import { isCopilotInstalled } from "../core/CopilotDetector.js";
import { scanCopilotSessions } from "../core/CopilotSessionDiscoverer.js";
import type { SqliteScanError } from "../core/SqliteHelpers.js";
```

2. After the OpenCode auto-detect block (lines 249–256), add:

```ts
		// Auto-detect Copilot CLI and enable session discovery
		const copilotDetected = config.copilotEnabled !== false && (await isCopilotInstalled());
		if (copilotDetected) {
			if (config.copilotEnabled === undefined) {
				await saveConfig({ copilotEnabled: true });
				log.info("Copilot CLI detected — enabled Copilot session discovery");
			}
		}
```

- [ ] **Step 4: Run — expect pass.**

### Task 3.2: Surface Copilot in `getStatus()`

- [ ] **Step 1: Add tests**

```ts
it("includes copilotDetected/copilotEnabled in status when DB present", async () => {
	const detector = await import("../core/CopilotDetector.js");
	vi.spyOn(detector, "isCopilotInstalled").mockResolvedValue(true);
	await saveConfig({ copilotEnabled: true });
	const status = await getStatus(projectDir);
	expect(status.copilotDetected).toBe(true);
	expect(status.copilotEnabled).toBe(true);
});

it("surfaces copilotScanError on scan failure", async () => {
	const detector = await import("../core/CopilotDetector.js");
	const discoverer = await import("../core/CopilotSessionDiscoverer.js");
	vi.spyOn(detector, "isCopilotInstalled").mockResolvedValue(true);
	vi.spyOn(discoverer, "scanCopilotSessions").mockResolvedValue({
		sessions: [],
		error: { kind: "locked", message: "database is locked" },
	});
	await saveConfig({ copilotEnabled: true });
	const status = await getStatus(projectDir);
	expect(status.copilotScanError).toEqual({ kind: "locked", message: "database is locked" });
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Wire status**

In `getStatus()`:

1. After `const openCodeDetected = await isOpenCodeInstalled();` (~line 472):

```ts
	const copilotDetected = await isCopilotInstalled();
```

2. After the OpenCode discovery block (lines 502–512):

```ts
	let copilotScanError: SqliteScanError | undefined;
	if (config.copilotEnabled !== false && copilotDetected) {
		const scan = await scanCopilotSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		copilotScanError = scan.error;
	}
```

3. In the `StatusInfo` literal (~line 564), after the `openCodeScanError,` line:

```ts
		copilotDetected,
		copilotEnabled: config.copilotEnabled,
		copilotScanError,
```

4. Update the `log.info("Status: ...")` line to append `, copilot=%s/%s` and the values `copilotDetected, config.copilotEnabled` — mirror exactly how `opencode=%s/%s` is appended.

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit Phase 3**

```bash
git add cli/src/install/Installer.ts cli/src/install/Installer.test.ts
git commit -s -m "$(cat <<'EOF'
feat(cli): auto-detect Copilot CLI on install and surface in status

install() mirrors the OpenCode auto-enable pattern: when
~/.copilot/session-store.db is present and copilotEnabled is undefined, the
installer sets it to true. Explicit values are never overwritten.

getStatus() reports copilotDetected, copilotEnabled, and copilotScanError
alongside the OpenCode equivalents and includes Copilot session counts in
activeSessions / sessionsBySource.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — QueueWorker pipeline

**Files:** Modify `cli/src/hooks/QueueWorker.ts` and its test.

- [ ] **Step 1: Add tests**

In `cli/src/hooks/QueueWorker.test.ts`, find the OpenCode pipeline test (search `discoverOpenCodeSessions`) and mirror it:

```ts
it("discovers Copilot sessions and routes reads through readCopilotTranscript", async () => {
	const det = await import("../core/CopilotDetector.js");
	const disc = await import("../core/CopilotSessionDiscoverer.js");
	const reader = await import("../core/CopilotTranscriptReader.js");
	vi.spyOn(det, "isCopilotInstalled").mockResolvedValue(true);
	vi.spyOn(disc, "discoverCopilotSessions").mockResolvedValue([
		{
			sessionId: "c1",
			transcriptPath: "/db.sqlite#c1",
			updatedAt: "2026-05-05T07:00:00.000Z",
			source: "copilot",
		},
	]);
	const readSpy = vi.spyOn(reader, "readCopilotTranscript").mockResolvedValue({
		entries: [{ role: "human", content: "hi" }],
		newCursor: { transcriptPath: "/db.sqlite#c1", lineNumber: 1, updatedAt: "now" },
		totalLinesRead: 1,
	});
	// Run whatever pipeline-entry function the existing OpenCode test calls.
	await runPipelineForTesting(/* re-use same boilerplate as opencode test */);
	expect(readSpy).toHaveBeenCalledWith("/db.sqlite#c1", null, expect.any(String));
});

it("short-circuits Copilot discovery when copilotEnabled is false", async () => {
	const det = await import("../core/CopilotDetector.js");
	const disc = await import("../core/CopilotSessionDiscoverer.js");
	const detSpy = vi.spyOn(det, "isCopilotInstalled");
	const discSpy = vi.spyOn(disc, "discoverCopilotSessions");
	await saveConfig({ copilotEnabled: false });
	await runPipelineForTesting(/* … */);
	expect(detSpy).not.toHaveBeenCalled();
	expect(discSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Wire the discovery + read**

In `cli/src/hooks/QueueWorker.ts`:

1. Imports near line 27:

```ts
import { isCopilotInstalled } from "../core/CopilotDetector.js";
import { discoverCopilotSessions } from "../core/CopilotSessionDiscoverer.js";
import { readCopilotTranscript } from "../core/CopilotTranscriptReader.js";
```

2. After the OpenCode discovery block (lines 1418–1426):

```ts
	// Discover Copilot CLI sessions (on-demand SQLite scan).
	if (config.copilotEnabled !== false && (await isCopilotInstalled())) {
		const copilotSessions = await discoverCopilotSessions(cwd);
		if (copilotSessions.length > 0) {
			allSessions = [...allSessions, ...copilotSessions];
			log.info("Discovered %d Copilot session(s)", copilotSessions.length);
		}
	}
```

3. In `readAllTranscripts` (~line 1466), insert a Copilot branch between the existing `opencode` branch and the `else` fallback:

```ts
		} else if (source === "copilot") {
			result = await readCopilotTranscript(session.transcriptPath, cursor, beforeTimestamp);
```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit Phase 4**

```bash
git add cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts
git commit -s -m "feat(cli): wire Copilot CLI into the post-commit pipeline

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — CLI Status / Configure

### Task 5.1: StatusCommand row

**Files:** Modify `cli/src/commands/StatusCommand.ts` and its test.

- [ ] **Step 1: Read OpenCode block (lines 264–290) for the template.**

- [ ] **Step 2: Add tests**

```ts
it("renders Copilot Integration row when detected", () => {
	const out = renderStatus({
		...baseStatus,
		copilotDetected: true,
		copilotEnabled: true,
		sessionsBySource: { copilot: 3 },
	});
	expect(out).toContain("Copilot Integration");
	expect(out).toContain("3");
});

it("renders Copilot row as unavailable on scan error", () => {
	const out = renderStatus({
		...baseStatus,
		copilotDetected: true,
		copilotScanError: { kind: "locked", message: "database is locked" },
	});
	expect(out).toContain("Copilot Integration");
	expect(out).toContain("unavailable");
	expect(out).toContain("locked");
});
```

(Use existing `renderStatus`/`baseStatus` helpers — don't invent new ones.)

- [ ] **Step 3: Run — expect failure.**

- [ ] **Step 4: Append the Copilot block**

After the OpenCode block, insert a parallel Copilot block. Token replacement: `OpenCode` → `Copilot`, `openCode` → `copilot`, `opencode` → `copilot`. Healthy descriptions:
- enabled: `"Copilot CLI database found — session discovery is enabled"`
- detected-but-disabled: `"Copilot CLI detected but session discovery is disabled in config"`

Error path: `` `unavailable — ${s.copilotScanError.kind}` `` and tooltip `` `Copilot database scan failed (${s.copilotScanError.kind}): ${s.copilotScanError.message}` ``.

Also widen the `scanError` field declared at the top of the file (line 26) so it can carry either `StatusInfo["openCodeScanError"]` or `StatusInfo["copilotScanError"]`. Both have the identical shape, so changing the type to `StatusInfo["openCodeScanError"]` (which is structurally equal) compiles unchanged — but adjust if the type alias is named after one specific source.

- [ ] **Step 5: Run — expect pass.**

### Task 5.2: ConfigureCommand key

**Files:** Modify `cli/src/commands/ConfigureCommand.ts` and its test.

- [ ] **Step 1: Add tests**

```ts
it("accepts copilotEnabled as a boolean key", async () => {
	await runConfigure(["--set", "copilotEnabled=true"]);
	expect((await loadConfig()).copilotEnabled).toBe(true);
	await runConfigure(["--set", "copilotEnabled=false"]);
	expect((await loadConfig()).copilotEnabled).toBe(false);
});

it("lists copilotEnabled in help/description output", async () => {
	const help = await runConfigureHelp();
	expect(help).toContain("copilotEnabled");
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Wire the key**

In `cli/src/commands/ConfigureCommand.ts`:

1. Add `"copilotEnabled"` to the valid-keys array (~line 31).

2. Update the boolean coercion guard (~line 67) by adding `key === "copilotEnabled"` to the OR chain.

3. In the metadata array (~line 99), after the `openCodeEnabled` entry:

```ts
	{
		key: "copilotEnabled",
		type: "boolean",
		description: "Enable Copilot CLI session discovery (true/false). Requires Node 22.5+.",
	},
```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit Phase 5**

```bash
git add cli/src/commands/StatusCommand.ts cli/src/commands/StatusCommand.test.ts \
        cli/src/commands/ConfigureCommand.ts cli/src/commands/ConfigureCommand.test.ts
git commit -s -m "feat(cli): surface Copilot CLI in jolli status and jolli configure

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6 — VSCode StatusTreeProvider

**Files:** Modify `vscode/src/providers/StatusTreeProvider.ts` and its test.

- [ ] **Step 1: Locate the OpenCode block in StatusTreeProvider.ts (~lines 264–290).**

- [ ] **Step 2: Add tests**

```ts
it("shows Copilot Integration row when detected and enabled", () => {
	const items = provider.getChildren({
		...mockStatus,
		copilotDetected: true,
		copilotEnabled: true,
		sessionsBySource: { copilot: 2 },
	});
	const item = items.find((i) => i.label === "Copilot Integration");
	expect(item).toBeDefined();
	expect(item?.description).toContain("2");
});

it("shows Copilot Integration as unavailable when scan errors", () => {
	const items = provider.getChildren({
		...mockStatus,
		copilotDetected: true,
		copilotScanError: { kind: "locked", message: "database is locked" },
	});
	const item = items.find((i) => i.label === "Copilot Integration");
	expect(item?.description).toContain("locked");
	expect(item?.tooltip).toContain("Copilot database scan failed");
});
```

(Use the existing `mockStatus` helper.)

- [ ] **Step 3: Run — expect failure.**

- [ ] **Step 4: Append parallel Copilot block**

Replace tokens 1:1 from the OpenCode block: messages match the StatusCommand wording above. Use `pushIntegrationItem` for the healthy state, the explicit unavailable-row branch for `s.copilotScanError`.

- [ ] **Step 5: Run — expect pass.**

- [ ] **Step 6: Commit Phase 6**

```bash
git add vscode/src/providers/StatusTreeProvider.ts vscode/src/providers/StatusTreeProvider.test.ts
git commit -s -m "feat(vscode): add Copilot Integration row to status tree

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 7 — VSCode Summary panel + script

### Task 7.1: `getEnabledSources()` includes copilot

**Files:** Modify `vscode/src/views/SummaryWebviewPanel.ts` and its test.

- [ ] **Step 1: Add tests**

```ts
it("includes 'copilot' when copilotEnabled !== false", () => {
	expect(getEnabledSources({ copilotEnabled: true })).toContain("copilot");
	expect(getEnabledSources({})).toContain("copilot");
});

it("excludes 'copilot' when copilotEnabled === false", () => {
	expect(getEnabledSources({ copilotEnabled: false })).not.toContain("copilot");
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Add the source (after line 2044 — the OpenCode block)**

```ts
		if (config.copilotEnabled !== false) {
			sources.add("copilot");
		}
```

- [ ] **Step 4: Run — expect pass.**

### Task 7.2: SummaryScriptBuilder label + sourceOrder

**Files:** Modify `vscode/src/views/SummaryScriptBuilder.ts` and its test.

- [ ] **Step 1: Add tests**

```ts
it("maps 'copilot' source to 'Copilot' label", () => {
	expect(scriptForSource("copilot")).toContain("'Copilot'");
});

it("appends 'copilot' to sourceOrder", () => {
	expect(builtScript()).toContain("['claude', 'codex', 'gemini', 'opencode', 'copilot']");
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Edits**

At line 1134 (after the `opencode` mapping):

```ts
    if (source === 'copilot') return 'Copilot';
```

At line 1560:

```ts
        var sourceOrder = ['claude', 'codex', 'gemini', 'opencode', 'copilot'];
```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit Phase 7**

```bash
git add vscode/src/views/SummaryWebviewPanel.ts vscode/src/views/SummaryWebviewPanel.test.ts \
        vscode/src/views/SummaryScriptBuilder.ts vscode/src/views/SummaryScriptBuilder.test.ts
git commit -s -m "feat(vscode): show Copilot CLI in Summary Details source breakdown

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 8 — VSCode Settings panel

### Task 8.1: HTML toggle row

**Files:** Modify `vscode/src/views/SettingsHtmlBuilder.ts` and its test.

- [ ] **Step 1: Add test**

```ts
it("includes a Copilot toggle row", () => {
	const html = buildSettingsHtml(/* … */);
	expect(html).toContain('id="copilotEnabled"');
	expect(html).toContain("Copilot");
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Add (after line 86, the openCodeEnabled row)**

```ts
      ${buildToggleRow("copilotEnabled", "Copilot", "Session discovery via ~/.copilot/session-store.db")}
```

- [ ] **Step 4: Run — expect pass.**

### Task 8.2: SettingsScriptBuilder

**Files:** Modify `vscode/src/views/SettingsScriptBuilder.ts` and its test.

- [ ] **Step 1: Add tests**

```ts
it("references the copilotEnabled DOM input", () => {
	expect(builtScript()).toContain("getElementById('copilotEnabled')");
});

it("includes copilotEnabled in validation guard", () => {
	expect(builtScript()).toMatch(/!openCodeEnabledInput\.checked && !copilotEnabledInput\.checked/);
});

it("ships copilotEnabled in save payload", () => {
	expect(builtScript()).toContain("copilotEnabled: copilotEnabledInput.checked");
});

it("loads copilotEnabled from host message", () => {
	expect(builtScript()).toContain("copilotEnabledInput.checked = msg.settings.copilotEnabled");
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Edits across the file**

1. **Line 30** (after `openCodeEnabledInput`):

```ts
  const copilotEnabledInput = document.getElementById('copilotEnabled');
```

2. **Line 132** (validation guard):

```ts
    if (!claudeEnabledInput.checked && !codexEnabledInput.checked && !geminiEnabledInput.checked && !openCodeEnabledInput.checked && !copilotEnabledInput.checked) {
```

3. **Both save-payload sites (lines 164 and 234)** — append after `openCodeEnabled: openCodeEnabledInput.checked,`:

```ts
        copilotEnabled: copilotEnabledInput.checked,
```

4. **Dirty check (line 180)** — add the OR clause:

```ts
      copilotEnabledInput.checked !== initialState.copilotEnabled ||
```

5. **Change-listener array (line 205)**:

```ts
  [claudeEnabledInput, codexEnabledInput, geminiEnabledInput, openCodeEnabledInput, copilotEnabledInput].forEach(function(input) {
```

6. **Host load handler (line 255)** — after `openCodeEnabledInput.checked = msg.settings.openCodeEnabled;`:

```ts
        copilotEnabledInput.checked = msg.settings.copilotEnabled;
```

7. **`initialState`** — search for the `initialState =` block, add `copilotEnabled: settings.copilotEnabled,` next to the other `*Enabled` keys.

- [ ] **Step 4: Run — expect pass.**

### Task 8.3: SettingsWebviewPanel

**Files:** Modify `vscode/src/views/SettingsWebviewPanel.ts` and its test.

- [ ] **Step 1: Add tests**

```ts
it("loads copilotEnabled from config (default true)", async () => {
	await saveConfig({ copilotEnabled: false });
	expect((await buildPayload()).copilotEnabled).toBe(false);

	await saveConfig({});
	expect((await buildPayload()).copilotEnabled).toBe(true);
});

it("persists copilotEnabled when the user submits", async () => {
	await applySettings({ ...defaults, copilotEnabled: false });
	expect((await loadConfig()).copilotEnabled).toBe(false);
});
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Edits**

1. **`SettingsPayload` (line 44)** — after `openCodeEnabled`:

```ts
	readonly copilotEnabled: boolean;
```

2. **`buildPayload()` (line 252)** — after the openCode line:

```ts
			copilotEnabled: config.copilotEnabled !== false,
```

3. **`applySettings()` (line 327)** — after the openCode line:

```ts
			copilotEnabled: settings.copilotEnabled,
```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit Phase 8**

```bash
git add vscode/src/views/SettingsHtmlBuilder.ts vscode/src/views/SettingsHtmlBuilder.test.ts \
        vscode/src/views/SettingsScriptBuilder.ts vscode/src/views/SettingsScriptBuilder.test.ts \
        vscode/src/views/SettingsWebviewPanel.ts vscode/src/views/SettingsWebviewPanel.test.ts
git commit -s -m "$(cat <<'EOF'
feat(vscode): add Copilot CLI toggle to Settings panel

Adds a Copilot enable/disable toggle alongside the existing
Claude/Codex/Gemini/OpenCode toggles. Participates in dirty detection,
the "at least one integration enabled" validation guard, and load/save
round-trips with the underlying jolli config.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 9 — End-to-end verification

### Task 9.1: Full gate

- [ ] **Step 1: Run `npm run all` from repo root**

Run: `npm run all`
Expected: clean → build → lint → test all pass in both `cli` and `vscode` workspaces.

- [ ] **Step 2: Coverage check on new files**

Run: `npm run test -w @jolli.ai/cli -- --coverage --include 'src/core/Copilot*.ts' --include 'src/core/SqliteHelpers.ts'`
Expected: each new file ≥97% statements / ≥96% branches.

If a file dips below: add broken-fixture tests for the defensive branches (e.g. drop a `cwd` row to trigger `!Number.isFinite` skip; corrupt a row to trigger malformed-row skip). Match the approach from Cursor PR #65 (see spec § Testing strategy).

### Task 9.2: Live smoke test

- [ ] **Step 1: Run status against the live `~/.copilot` DB**

```bash
cd /Users/flyer/jolli/code/jollimemory
npm run cli -- status
```

Expected: status shows a Copilot integration line with `detected: true`, `enabled: true`, sessions ≥0.

- [ ] **Step 2: Trigger one post-commit cycle**

```bash
echo "" >> docs/superpowers/plans/2026-05-05-copilot-cli-support.md
git add docs/superpowers/plans/2026-05-05-copilot-cli-support.md
git commit -s -m "test: trigger jolli post-commit pipeline for Copilot smoke check"
```

Watch the worker log (path documented in `cli/src/Logger.ts`) for `Discovered N Copilot session(s)` and `Read Copilot session …`.

- [ ] **Step 3: Revert the smoke commit**

```bash
git reset --hard HEAD~1
```

### Task 9.3: PR

- [ ] **Step 1: Verify branch state**

```bash
git status
git log --oneline main..HEAD
```

Expected: 9 feature commits + 3 docs commits.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feature-support-copilot
gh pr create --title "Add GitHub Copilot CLI as a transcript source" --body "$(cat <<'EOF'
## Summary

- Adds Copilot CLI as the sixth transcript source (discovery-based, like OpenCode/Cursor).
- Reads `~/.copilot/session-store.db` via `node:sqlite` (WAL-safe); workspace match is exact via the DB's own `cwd` column.
- Extracts a shared `SqliteHelpers` module from `OpenCodeSessionDiscoverer` (pure refactor) so future SQLite-backed sources don't duplicate the open / version-gate / classify logic. Coordinated with PR #65.

## Spec

`docs/superpowers/specs/2026-05-05-copilot-cli-support-design.md`

## Intentionally not changed

- `~/.copilot/session-state/<id>/checkpoints/` — Copilot's own conversation-compression nodes are NOT ingested. Slicing mismatch with git commits, optional existence, and a larger drift surface than `turns`. Spec § "Intentionally not done" lists the supplemental-context follow-up path.
- `session_files`, `session_refs`, FTS5 `search_index` — not read.
- Hook-based integration — Copilot CLI exposes no hook surface; discovery only.
- Windows live-CI verification — code path supported, deferred to first user report.
- New top-level dependency — none.

## Test plan

- [ ] `npm run all` passes (build + lint + test in both workspaces).
- [ ] Coverage on new files ≥97% statements / ≥96% branches.
- [ ] `jolli status` shows the Copilot Integration row.
- [ ] After a real `git commit -s`, queue worker log shows `Discovered N Copilot session(s)` and `Read Copilot session …`.
- [ ] VSCode Settings: Copilot toggle renders, dirty-detects, validates "at least one integration", round-trips.
- [ ] VSCode Status panel: Copilot row + scan-error variant render correctly.
- [ ] OpenCode tests stay green — no regression.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- Every code step shows the actual code to write — no "implement appropriately".
- Every test step shows test code and the expected fail/pass outcome of the next step.
- File paths are absolute from repo root; line numbers were taken from a verified read of main as of `f9b07415`.
- TDD ordering: failing test → minimal implementation → verify pass → commit.
- The `SqliteHelpers` extraction is its own commit (Phase 0) so PR #65's conflict resolution stays mechanical.
- Phase 1 (core modules) needs Phase 2 (Types widening) for typecheck — the plan handles this by landing both in one commit, called out at the start of Phase 1+2.
- Test fixtures use `db.prepare(sql).run()` per single-statement to satisfy node:sqlite's API (DatabaseSync.prepare requires single statements; this is also why we don't show a multi-statement `db.exec(...)` form).
- Coverage gate is checked explicitly in Phase 9; if any new file dips, the plan tells the engineer to add broken-fixture tests Cursor-style.
