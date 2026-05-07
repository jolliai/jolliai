# VS Code Copilot Chat Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VS Code Copilot Chat as a seventh transcript source, sharing the existing `copilotEnabled` flag with Copilot CLI but isolated as `"copilot-chat"` in the source enum and pipeline.

**Architecture:** Extract a shared `VscodeWorkspaceLocator` so Cursor and Copilot Chat both resolve workspace hashes through one module. Read sessions from per-workspace `chatSessions/<id>.jsonl` files in vscode workspaceStorage. JSONL is a JSON-document patch log, not message stream — implement a small in-place patch replayer (kind 0/1/2). Transcript reader extracts `requests[].message.text` and flattened `response[]`.

**Tech Stack:** TypeScript (cli workspace), node:fs/promises, vitest (≥97% coverage), biome (tab indent, 120 col), Node 22.5+. No new runtime deps.

**Spec:** [`docs/superpowers/specs/2026-05-06-copilot-chat-support-design.md`](../specs/2026-05-06-copilot-chat-support-design.md)

**Conventions used throughout this plan:**
- Code style: tabs (4-wide), 120-col limit, biome `noExplicitAny: error`, `useImportType: warn`
- Test layout: each `Foo.ts` has a sibling `Foo.test.ts`; use `vi.mock` for filesystem and module-level dependencies
- Test commands: `npm run test -w @jolli.ai/cli -- <path> -t "<test name>"` for single test; `npm run test -w @jolli.ai/cli` for full
- Coverage gate: cli workspace enforces 97% statements/lines/branches/functions
- Commit format: imperative subject, no conventional-commit prefix (e.g. "Add VscodeWorkspaceLocator shared module"). Always use `git commit -s` for DCO sign-off.

---

## Task 1: Create `VscodeWorkspaceLocator` shared module

Extract per-platform vscode user-data path resolution and workspace.json scanning into one module that takes a `flavor: "Cursor" | "Code"` parameter. This module will be consumed by both Cursor (existing) and Copilot Chat (new).

**Files:**
- Create: `cli/src/core/VscodeWorkspaceLocator.ts`
- Create: `cli/src/core/VscodeWorkspaceLocator.test.ts`

- [ ] **Step 1: Write failing tests for path resolution**

```typescript
// cli/src/core/VscodeWorkspaceLocator.test.ts
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const { mockHomedir, mockPlatform } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue("/Users/test"),
	mockPlatform: vi.fn().mockReturnValue("darwin"),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir, platform: mockPlatform };
});

describe("getVscodeUserDataDir", () => {
	it("returns ~/Library/Application Support/Code on darwin", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeUserDataDir("Code")).toBe("/Users/test/Library/Application Support/Code");
	});

	it("returns ~/Library/Application Support/Cursor on darwin for Cursor flavor", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeUserDataDir("Cursor")).toBe("/Users/test/Library/Application Support/Cursor");
	});

	it("returns %APPDATA%/Code on win32", async () => {
		mockPlatform.mockReturnValue("win32");
		mockHomedir.mockReturnValue("C:\\Users\\test");
		const prev = process.env.APPDATA;
		process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
		try {
			const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
			expect(getVscodeUserDataDir("Code")).toBe(join("C:\\Users\\test\\AppData\\Roaming", "Code"));
		} finally {
			if (prev === undefined) delete process.env.APPDATA;
			else process.env.APPDATA = prev;
		}
	});

	it("falls back to ~/AppData/Roaming/Code on win32 when APPDATA is unset", async () => {
		mockPlatform.mockReturnValue("win32");
		mockHomedir.mockReturnValue("C:\\Users\\test");
		const prev = process.env.APPDATA;
		delete process.env.APPDATA;
		try {
			const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
			expect(getVscodeUserDataDir("Code")).toBe(join("C:\\Users\\test", "AppData", "Roaming", "Code"));
		} finally {
			if (prev !== undefined) process.env.APPDATA = prev;
		}
	});

	it("returns ~/.config/Code on linux and other unix-like platforms", async () => {
		mockPlatform.mockReturnValue("linux");
		const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeUserDataDir("Code")).toBe("/Users/test/.config/Code");
	});

	it("respects an explicit home override", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { getVscodeUserDataDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeUserDataDir("Code", "/custom/home")).toBe(
			"/custom/home/Library/Application Support/Code",
		);
	});
});

describe("getVscodeWorkspaceStorageDir", () => {
	it("appends User/workspaceStorage to the user data dir", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { getVscodeWorkspaceStorageDir } = await import("./VscodeWorkspaceLocator.js");
		expect(getVscodeWorkspaceStorageDir("Code")).toBe(
			"/Users/test/Library/Application Support/Code/User/workspaceStorage",
		);
	});
});

describe("normalizePathForMatch", () => {
	it("strips trailing slashes", async () => {
		mockPlatform.mockReturnValue("linux");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("/a/b/c/")).toBe("/a/b/c");
		expect(normalizePathForMatch("/a/b/c////")).toBe("/a/b/c");
		expect(normalizePathForMatch("/a/b/c")).toBe("/a/b/c");
	});

	it("lowercases on darwin", async () => {
		mockPlatform.mockReturnValue("darwin");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("/Users/Foo/Bar")).toBe("/users/foo/bar");
	});

	it("lowercases on win32", async () => {
		mockPlatform.mockReturnValue("win32");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("C:\\Users\\Test")).toBe("c:\\users\\test");
	});

	it("preserves case on linux", async () => {
		mockPlatform.mockReturnValue("linux");
		const { normalizePathForMatch } = await import("./VscodeWorkspaceLocator.js");
		expect(normalizePathForMatch("/Users/Foo")).toBe("/Users/Foo");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/core/VscodeWorkspaceLocator.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement basic path helpers**

```typescript
// cli/src/core/VscodeWorkspaceLocator.ts
/**
 * VscodeWorkspaceLocator
 *
 * Per-platform path resolution and workspace.json scanning for VS Code-family
 * user data directories. Used by both Cursor (`flavor: "Cursor"`) and VS Code
 * Copilot Chat (`flavor: "Code"`) integrations. Adding a new vscode fork
 * (Insiders, Code-OSS, Windsurf, …) requires only extending the flavor union.
 *
 * Public symbols:
 *   - getVscodeUserDataDir(flavor, home?)
 *   - getVscodeWorkspaceStorageDir(flavor, home?)
 *   - findVscodeWorkspaceHash(flavor, projectDir)
 *   - normalizePathForMatch(p)
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../Logger.js";

const log = createLogger("VscodeWorkspaceLocator");

export type VscodeFlavor = "Cursor" | "Code";

/**
 * Returns the VS Code-family user-data root for the current platform.
 *
 *   darwin   ~/Library/Application Support/<flavor>
 *   linux    ~/.config/<flavor>
 *   win32    %APPDATA%/<flavor>  (fallback to ~/AppData/Roaming/<flavor>)
 */
export function getVscodeUserDataDir(flavor: VscodeFlavor, home: string = homedir()): string {
	switch (platform()) {
		case "darwin":
			return join(home, "Library", "Application Support", flavor);
		case "win32":
			return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), flavor);
		default:
			return join(home, ".config", flavor);
	}
}

/** Returns the workspaceStorage dir for the given flavor. */
export function getVscodeWorkspaceStorageDir(flavor: VscodeFlavor, home?: string): string {
	return join(getVscodeUserDataDir(flavor, home), "User", "workspaceStorage");
}

/**
 * Normalises a filesystem path for workspace matching.
 * - Strips trailing slashes (linear-time loop, not regex — avoids CodeQL polynomial-redos
 *   warnings on JSON-loaded paths).
 * - Lowercases on case-insensitive platforms (darwin, win32).
 */
export function normalizePathForMatch(p: string): string {
	let end = p.length;
	while (end > 0 && (p[end - 1] === "/" || p[end - 1] === "\\")) {
		end--;
	}
	const trimmed = p.slice(0, end);
	const os = platform();
	return os === "darwin" || os === "win32" ? trimmed.toLowerCase() : trimmed;
}
```

- [ ] **Step 4: Run tests to verify path helpers pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/VscodeWorkspaceLocator.test.ts`
Expected: PASS for all `getVscodeUserDataDir`, `getVscodeWorkspaceStorageDir`, `normalizePathForMatch` tests.

- [ ] **Step 5: Add tests for `findVscodeWorkspaceHash`**

Append to `VscodeWorkspaceLocator.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("findVscodeWorkspaceHash", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "vscode-locator-"));
		mockPlatform.mockReturnValue("darwin");
		mockHomedir.mockReturnValue(tmpRoot);
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function makeWorkspaceEntry(flavor: VscodeFlavor, wsHash: string, content: object | null): void {
		const dir = join(tmpRoot, "Library", "Application Support", flavor, "User", "workspaceStorage", wsHash);
		mkdirSync(dir, { recursive: true });
		if (content !== null) {
			writeFileSync(join(dir, "workspace.json"), JSON.stringify(content));
		}
	}

	it("returns the hash for a single-folder workspace whose folder URI matches projectDir", async () => {
		makeWorkspaceEntry("Code", "abc123", { folder: "file:///Users/test/myproject" });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", "/Users/test/myproject")).toBe("abc123");
	});

	it("matches case-insensitively on darwin", async () => {
		makeWorkspaceEntry("Code", "abc123", { folder: "file:///Users/Test/MyProject" });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", "/users/test/myproject")).toBe("abc123");
	});

	it("returns null when no workspace.json folder URI matches projectDir", async () => {
		makeWorkspaceEntry("Code", "abc123", { folder: "file:///Users/test/other" });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", "/Users/test/myproject")).toBeNull();
	});

	it("skips entries whose workspace.json has a multi-root `workspace` URI instead of a `folder` URI", async () => {
		makeWorkspaceEntry("Code", "multi", { workspace: "file:///Users/test/x.code-workspace" });
		makeWorkspaceEntry("Code", "single", { folder: "file:///Users/test/myproject" });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", "/Users/test/myproject")).toBe("single");
	});

	it("skips entries with no workspace.json", async () => {
		makeWorkspaceEntry("Code", "empty", null);
		makeWorkspaceEntry("Code", "single", { folder: "file:///Users/test/myproject" });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", "/Users/test/myproject")).toBe("single");
	});

	it("skips entries whose folder URI is unparseable", async () => {
		makeWorkspaceEntry("Code", "bad", { folder: "garbage:///not-a-uri" });
		makeWorkspaceEntry("Code", "good", { folder: "file:///Users/test/myproject" });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", "/Users/test/myproject")).toBe("good");
	});

	it("returns null when workspaceStorage dir doesn't exist", async () => {
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", "/Users/test/myproject")).toBeNull();
	});

	it("isolates flavors — a Cursor entry doesn't match a Code lookup", async () => {
		makeWorkspaceEntry("Cursor", "cursor1", { folder: "file:///Users/test/myproject" });
		const { findVscodeWorkspaceHash } = await import("./VscodeWorkspaceLocator.js");
		expect(await findVscodeWorkspaceHash("Code", "/Users/test/myproject")).toBeNull();
		expect(await findVscodeWorkspaceHash("Cursor", "/Users/test/myproject")).toBe("cursor1");
	});
});
```

Add the missing imports at the top of the test file: `import { afterEach, beforeEach } from "vitest";` (vitest re-exports both).

- [ ] **Step 6: Implement `findVscodeWorkspaceHash`**

Append to `VscodeWorkspaceLocator.ts`:

```typescript
/**
 * Scans the workspaceStorage directory for an entry whose `workspace.json` has
 * a `folder` URI that resolves to projectDir. Returns the entry name (workspace
 * hash) on match, or null when no match is found.
 *
 * Single-folder workspaces only — entries with a `workspace` field instead of
 * `folder` (multi-root .code-workspace files) are skipped silently.
 */
export async function findVscodeWorkspaceHash(
	flavor: VscodeFlavor,
	projectDir: string,
): Promise<string | null> {
	const wsStorageDir = getVscodeWorkspaceStorageDir(flavor);

	let entries: string[];
	try {
		entries = await readdir(wsStorageDir);
	} catch {
		log.debug("%s workspaceStorage not readable at %s", flavor, wsStorageDir);
		return null;
	}

	const target = normalizePathForMatch(projectDir);

	for (const entry of entries) {
		const wsJsonPath = join(wsStorageDir, entry, "workspace.json");
		let folderUri: string | undefined;
		try {
			const raw = await readFile(wsJsonPath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			folderUri = typeof parsed.folder === "string" ? parsed.folder : undefined;
		} catch {
			continue;
		}

		if (!folderUri || !folderUri.startsWith("file://")) {
			continue;
		}

		let folderPath: string;
		try {
			folderPath = fileURLToPath(folderUri);
		} catch {
			log.warn("%s workspace %s has unparseable folder URI: %s", flavor, entry, folderUri);
			continue;
		}

		if (normalizePathForMatch(folderPath) === target) {
			return entry;
		}
	}

	return null;
}
```

- [ ] **Step 7: Run all VscodeWorkspaceLocator tests**

Run: `npm run test -w @jolli.ai/cli -- src/core/VscodeWorkspaceLocator.test.ts`
Expected: ALL PASS.

- [ ] **Step 8: Run typecheck and biome**

Run: `npm run typecheck:cli && npm run lint -- --files-include="cli/src/core/VscodeWorkspaceLocator*"`
Expected: 0 errors. If unused imports flagged, remove them.

- [ ] **Step 9: Commit**

```bash
git add cli/src/core/VscodeWorkspaceLocator.ts cli/src/core/VscodeWorkspaceLocator.test.ts
git commit -s -m "Add VscodeWorkspaceLocator shared module"
```

---

## Task 2: Migrate `CursorDetector` to use `VscodeWorkspaceLocator`

`CursorDetector.ts` currently has its own copies of `getCursorUserDataDir`, `getCursorGlobalDbPath`, `getCursorWorkspaceStorageDir`. Replace the path resolution with thin wrappers over the shared locator. Keep all public symbols and signatures unchanged so no downstream import breaks.

**Files:**
- Modify: `cli/src/core/CursorDetector.ts`
- Verify: `cli/src/core/CursorDetector.test.ts` (no changes; existing tests must still pass)

- [ ] **Step 1: Refactor `CursorDetector.ts`**

Replace the body of `cli/src/core/CursorDetector.ts` (preserve `isCursorInstalled` semantics):

```typescript
/**
 * Cursor Detector
 *
 * Detects Cursor presence by checking for its global state database. Path
 * resolution delegates to VscodeWorkspaceLocator with `flavor: "Cursor"` —
 * shared with VS Code Copilot Chat (`flavor: "Code"`).
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";
import { getVscodeUserDataDir, getVscodeWorkspaceStorageDir } from "./VscodeWorkspaceLocator.js";

const log = createLogger("CursorDetector");

/**
 * Returns the Cursor user-data root directory for the current platform.
 * Thin wrapper over VscodeWorkspaceLocator.getVscodeUserDataDir("Cursor", …).
 */
function getCursorUserDataDir(home?: string): string {
	return getVscodeUserDataDir("Cursor", home);
}

/** Returns the path to Cursor's global state database. */
export function getCursorGlobalDbPath(home?: string): string {
	return join(getCursorUserDataDir(home), "User", "globalStorage", "state.vscdb");
}

/** Returns the path to Cursor's workspace storage directory. */
export function getCursorWorkspaceStorageDir(home?: string): string {
	return getVscodeWorkspaceStorageDir("Cursor", home);
}

/**
 * Checks whether Cursor is installed AND the current runtime can read its DB.
 * Returns false on Node <22.5 (no built-in node:sqlite).
 */
export async function isCursorInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Cursor support disabled: this runtime is Node %s, requires 22.5+ for built-in SQLite",
			process.versions.node,
		);
		return false;
	}
	const dbPath = getCursorGlobalDbPath();
	try {
		const fileStat = await stat(dbPath);
		return fileStat.isFile();
	} catch {
		return false;
	}
}
```

- [ ] **Step 2: Run existing CursorDetector tests**

Run: `npm run test -w @jolli.ai/cli -- src/core/CursorDetector.test.ts`
Expected: ALL PASS (the public surface is unchanged; tests should not need updating).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck:cli`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add cli/src/core/CursorDetector.ts
git commit -s -m "Refactor CursorDetector to use VscodeWorkspaceLocator"
```

---

## Task 3: Migrate `CursorSessionDiscoverer` to use `VscodeWorkspaceLocator`

Replace `findCursorWorkspaceHash` and `normalizePathForMatch` with calls to the shared module. Keep `scanCursorSessions` and `discoverCursorSessions` signatures unchanged.

**Files:**
- Modify: `cli/src/core/CursorSessionDiscoverer.ts`
- Verify: `cli/src/core/CursorSessionDiscoverer.test.ts` (existing tests must still pass)

- [ ] **Step 1: Edit `CursorSessionDiscoverer.ts`**

In `cli/src/core/CursorSessionDiscoverer.ts`:

Replace the import line for `getCursorWorkspaceStorageDir`:

```typescript
import { getCursorGlobalDbPath } from "./CursorDetector.js";
import { findVscodeWorkspaceHash, getVscodeWorkspaceStorageDir } from "./VscodeWorkspaceLocator.js";
```

Remove the imports of `readdir`, `readFile`, `fileURLToPath` if they are no longer used (the inlined `findCursorWorkspaceHash` and `normalizePathForMatch` will be deleted). Keep `stat` since `scanCursorSessions` still uses it for the global DB pre-flight.

Replace the local `findCursorWorkspaceHash` function (currently around line 200-243) with a thin wrapper:

```typescript
async function findCursorWorkspaceHash(projectDir: string): Promise<string | null> {
	return findVscodeWorkspaceHash("Cursor", projectDir);
}
```

Replace the `getCursorWorkspaceStorageDir` import-and-use chain in `readCursorAnchorComposerIds` (line ~253) with a direct call to `getVscodeWorkspaceStorageDir("Cursor")`:

```typescript
async function readCursorAnchorComposerIds(wsHash: string): Promise<ReadonlyArray<string>> {
	const wsStorageDir = getVscodeWorkspaceStorageDir("Cursor");
	const wsDbPath = join(wsStorageDir, wsHash, "state.vscdb");
	// ... rest unchanged
}
```

Delete the local `normalizePathForMatch` function (currently lines ~305-316).

- [ ] **Step 2: Run existing CursorSessionDiscoverer tests**

Run: `npm run test -w @jolli.ai/cli -- src/core/CursorSessionDiscoverer.test.ts`
Expected: ALL PASS. If a test mocks `readdir`/`readFile` directly to test workspace lookup, those mocks should now apply via the locator module.

If tests fail because they mocked at `CursorSessionDiscoverer` level, update the mock target to `./VscodeWorkspaceLocator.js`. Show the exact mock change here only if a test fails — otherwise skip.

- [ ] **Step 3: Run all Cursor-related tests**

Run: `npm run test -w @jolli.ai/cli -- src/core/Cursor`
Expected: ALL PASS.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck:cli`
Expected: 0 errors. Remove any newly-unused imports.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/CursorSessionDiscoverer.ts cli/src/core/CursorSessionDiscoverer.test.ts
git commit -s -m "Refactor CursorSessionDiscoverer to use VscodeWorkspaceLocator"
```

---

## Task 4: Create `CopilotChatDetector`

Detects Copilot Chat presence by checking for vscode's `globalStorage/github.copilot-chat` directory. No SQLite gate — the storage format is JSONL.

**Files:**
- Create: `cli/src/core/CopilotChatDetector.ts`
- Create: `cli/src/core/CopilotChatDetector.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// cli/src/core/CopilotChatDetector.test.ts
import { stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return { ...actual, stat: vi.fn() };
});

const { mockHomedir, mockPlatform } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue("/Users/test"),
	mockPlatform: vi.fn().mockReturnValue("darwin"),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir, platform: mockPlatform };
});

describe("CopilotChatDetector", () => {
	beforeEach(() => {
		mockHomedir.mockReturnValue("/Users/test");
		mockPlatform.mockReturnValue("darwin");
		vi.mocked(stat).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("getCopilotChatStorageDir returns vscode globalStorage path on darwin", async () => {
		const { getCopilotChatStorageDir } = await import("./CopilotChatDetector.js");
		expect(getCopilotChatStorageDir()).toBe(
			"/Users/test/Library/Application Support/Code/User/globalStorage/github.copilot-chat",
		);
	});

	it("isCopilotChatInstalled returns true when storage dir exists", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(true);
	});

	it("isCopilotChatInstalled returns false when storage dir is missing", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("no dir"), { code: "ENOENT" }));
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});

	it("isCopilotChatInstalled returns false when path exists but is not a directory", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as Awaited<ReturnType<typeof stat>>);
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});

	it("isCopilotChatInstalled returns false on permission errors", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatDetector.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `CopilotChatDetector.ts`**

```typescript
// cli/src/core/CopilotChatDetector.ts
/**
 * VS Code Copilot Chat detector.
 *
 * Detects Copilot Chat by the presence of vscode's
 * <userDataDir>/User/globalStorage/github.copilot-chat directory.
 * No SQLite gate — chat sessions are JSONL files (plain JSON parsing).
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { getVscodeUserDataDir } from "./VscodeWorkspaceLocator.js";

const log = createLogger("CopilotChatDetector");

/** Returns vscode's globalStorage/github.copilot-chat directory path. */
export function getCopilotChatStorageDir(home?: string): string {
	return join(getVscodeUserDataDir("Code", home), "User", "globalStorage", "github.copilot-chat");
}

/**
 * Returns true when vscode's Copilot Chat storage directory is present.
 * Returns false on ENOENT, permission errors, or when the path exists but
 * isn't a directory.
 */
export async function isCopilotChatInstalled(): Promise<boolean> {
	const dir = getCopilotChatStorageDir();
	try {
		const fileStat = await stat(dir);
		return fileStat.isDirectory();
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Copilot Chat dir stat failed (%s): %s", code ?? "unknown", (error as Error).message);
		}
		return false;
	}
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatDetector.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/CopilotChatDetector.ts cli/src/core/CopilotChatDetector.test.ts
git commit -s -m "Add CopilotChatDetector"
```

---

## Task 5: Update `TranscriptSource` enum and `SessionTracker` filter

Add `"copilot-chat"` to `TranscriptSource` and extend the SessionTracker filter so `copilotEnabled === false` excludes both `"copilot"` and `"copilot-chat"`. The `StatusInfo` field additions (`copilotChatDetected`, `copilotChatScanError`) are deferred to Task 11 so this commit can typecheck without depending on `CopilotChatTranscriptReader.ts` (which is created later).

**Files:**
- Modify: `cli/src/Types.ts:10` (TranscriptSource)
- Modify: `cli/src/core/SessionTracker.ts:172-174` (filter)
- Modify: `cli/src/core/SessionTracker.test.ts` (add tests)

- [ ] **Step 1: Update `TranscriptSource` enum**

Edit `cli/src/Types.ts:10`. Replace:

```typescript
export type TranscriptSource = "claude" | "codex" | "gemini" | "opencode" | "cursor" | "copilot";
```

with:

```typescript
export type TranscriptSource = "claude" | "codex" | "gemini" | "opencode" | "cursor" | "copilot" | "copilot-chat";
```

- [ ] **Step 2: Write failing test for filter extension**

In `cli/src/core/SessionTracker.test.ts`, add a new test inside the `filterSessionsByEnabledIntegrations` describe block:

```typescript
it("excludes copilot-chat sessions when copilotEnabled is false", () => {
	const sessions: ReadonlyArray<SessionInfo> = [
		{ sessionId: "a", transcriptPath: "/a", updatedAt: "2026-05-06T00:00:00Z", source: "copilot" },
		{ sessionId: "b", transcriptPath: "/b", updatedAt: "2026-05-06T00:00:00Z", source: "copilot-chat" },
		{ sessionId: "c", transcriptPath: "/c", updatedAt: "2026-05-06T00:00:00Z", source: "claude" },
	];
	const filtered = filterSessionsByEnabledIntegrations(sessions, { copilotEnabled: false });
	expect(filtered.map((s) => s.sessionId)).toEqual(["c"]);
});

it("includes copilot-chat sessions when copilotEnabled is unset (auto-detect)", () => {
	const sessions: ReadonlyArray<SessionInfo> = [
		{ sessionId: "b", transcriptPath: "/b", updatedAt: "2026-05-06T00:00:00Z", source: "copilot-chat" },
	];
	const filtered = filterSessionsByEnabledIntegrations(sessions, {});
	expect(filtered.map((s) => s.sessionId)).toEqual(["b"]);
});
```

- [ ] **Step 3: Run tests to verify the new tests fail**

Run: `npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts -t "copilot-chat"`
Expected: FAIL — the filter doesn't yet exclude `"copilot-chat"`.

- [ ] **Step 4: Update the filter**

Edit `cli/src/core/SessionTracker.ts:172-174`. Replace:

```typescript
	if (config.copilotEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "copilot");
	}
```

with:

```typescript
	if (config.copilotEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "copilot" && s.source !== "copilot-chat");
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts`
Expected: ALL PASS (existing + 2 new).

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck:cli`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add cli/src/Types.ts cli/src/core/SessionTracker.ts cli/src/core/SessionTracker.test.ts
git commit -s -m "Add copilot-chat to TranscriptSource and SessionTracker filter"
```

---

## Task 6: Implement `setAtPath` and `deleteAtPath` (patch primitives)

These are the primitives the patch replayer uses. Mutate the document in place. Numeric path segments index arrays; string segments key objects.

**Files:**
- Create: `cli/src/core/CopilotChatTranscriptReader.ts` (initial: just primitives)
- Create: `cli/src/core/CopilotChatTranscriptReader.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// cli/src/core/CopilotChatTranscriptReader.test.ts
import { describe, expect, it } from "vitest";
import { _deleteAtPath, _setAtPath } from "./CopilotChatTranscriptReader.js";

describe("_setAtPath", () => {
	it("sets a leaf string key on an object", () => {
		const doc: Record<string, unknown> = { a: { b: 1 } };
		_setAtPath(doc, ["a", "b"], 42);
		expect(doc).toEqual({ a: { b: 42 } });
	});

	it("creates intermediate objects when string segments are missing", () => {
		const doc: Record<string, unknown> = {};
		_setAtPath(doc, ["a", "b", "c"], "x");
		expect(doc).toEqual({ a: { b: { c: "x" } } });
	});

	it("creates intermediate arrays when next segment is numeric", () => {
		const doc: Record<string, unknown> = {};
		_setAtPath(doc, ["requests", 0, "message"], { text: "hi" });
		expect(doc).toEqual({ requests: [{ message: { text: "hi" } }] });
	});

	it("appends to an existing array at the next index", () => {
		const doc: Record<string, unknown> = { requests: [{ message: { text: "first" } }] };
		_setAtPath(doc, ["requests", 1], { message: { text: "second" } });
		expect((doc.requests as unknown[]).length).toBe(2);
		expect((doc.requests as unknown[])[1]).toEqual({ message: { text: "second" } });
	});

	it("grows arrays with sparse undefined slots when index is past length", () => {
		const doc: Record<string, unknown> = { requests: [] };
		_setAtPath(doc, ["requests", 2], { v: 1 });
		expect((doc.requests as unknown[]).length).toBe(3);
		expect((doc.requests as unknown[])[0]).toBeUndefined();
		expect((doc.requests as unknown[])[2]).toEqual({ v: 1 });
	});

	it("overwrites an existing leaf value", () => {
		const doc: Record<string, unknown> = { a: 1 };
		_setAtPath(doc, ["a"], 2);
		expect(doc).toEqual({ a: 2 });
	});

	it("handles empty path by replacing nothing (root replacement is replayPatches's job, not ours)", () => {
		const doc: Record<string, unknown> = { a: 1 };
		_setAtPath(doc, [], 99);
		// Empty path is undefined behavior in patch terms — we expect no change here
		// since the caller (replayPatches kind:0) handles root replacement directly.
		expect(doc).toEqual({ a: 1 });
	});
});

describe("_deleteAtPath", () => {
	it("deletes an object property", () => {
		const doc: Record<string, unknown> = { a: 1, b: 2 };
		_deleteAtPath(doc, ["a"]);
		expect(doc).toEqual({ b: 2 });
	});

	it("removes an array element via splice (preserves array semantics)", () => {
		const doc: Record<string, unknown> = { a: [10, 20, 30] };
		_deleteAtPath(doc, ["a", 1]);
		expect(doc.a).toEqual([10, 30]);
	});

	it("is a no-op when the path doesn't exist", () => {
		const doc: Record<string, unknown> = { a: 1 };
		_deleteAtPath(doc, ["b", "c"]);
		expect(doc).toEqual({ a: 1 });
	});

	it("is a no-op for empty path", () => {
		const doc: Record<string, unknown> = { a: 1 };
		_deleteAtPath(doc, []);
		expect(doc).toEqual({ a: 1 });
	});

	it("is a no-op when array index is out of bounds", () => {
		const doc: Record<string, unknown> = { a: [10, 20] };
		_deleteAtPath(doc, ["a", 5]);
		expect(doc.a).toEqual([10, 20]);
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatTranscriptReader.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement primitives**

```typescript
// cli/src/core/CopilotChatTranscriptReader.ts
/**
 * VS Code Copilot Chat transcript reader.
 *
 * vscode persists each chat session as a JSONL document patch log:
 *   line 0:  {kind:0, v:<initial document>}
 *   line N:  {kind:1, k:[...path], v:<value>}   set at path
 *   line N:  {kind:2, k:[...path]}              delete at path
 *
 * To reconstruct the conversation we replay all patches in order, then read
 * `requests[]` from the final document. See spec
 * docs/superpowers/specs/2026-05-06-copilot-chat-support-design.md.
 */

type PathSegment = string | number;

/**
 * Mutates `doc` in place by setting `value` at `path`. Creates intermediate
 * objects/arrays as needed (next-segment-type decides container shape).
 *
 * Exported with the `_` prefix as a unit-test seam — replayPatches and
 * readCopilotChatTranscript are the public contract; primitives are internal.
 */
export function _setAtPath(doc: unknown, path: PathSegment[], value: unknown): void {
	if (path.length === 0) {
		return; // Root replacement is replayPatches's responsibility (kind:0).
	}
	let cur = doc as Record<string | number, unknown>;
	for (let i = 0; i < path.length - 1; i++) {
		const seg = path[i];
		const next = path[i + 1];
		if (cur[seg] === undefined || cur[seg] === null) {
			cur[seg] = typeof next === "number" ? [] : {};
		}
		cur = cur[seg] as Record<string | number, unknown>;
	}
	cur[path[path.length - 1]] = value;
}

/**
 * Mutates `doc` in place by removing the value at `path`. No-op if the path
 * doesn't exist or is empty. For array elements, uses `splice` so the array
 * shifts (matching vscode's emitted semantics for `pendingRequests` cleanup).
 */
export function _deleteAtPath(doc: unknown, path: PathSegment[]): void {
	if (path.length === 0) return;
	let cur = doc as Record<string | number, unknown> | undefined;
	for (let i = 0; i < path.length - 1; i++) {
		if (cur === undefined || cur === null) return;
		cur = cur[path[i]] as Record<string | number, unknown> | undefined;
	}
	if (cur === undefined || cur === null) return;
	const last = path[path.length - 1];
	if (Array.isArray(cur) && typeof last === "number") {
		if (last >= 0 && last < cur.length) {
			cur.splice(last, 1);
		}
		return;
	}
	delete cur[last];
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatTranscriptReader.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts
git commit -s -m "Add patch path primitives for Copilot Chat reader"
```

---

## Task 7: Implement `replayPatches`

Apply a series of patch events to build the final document.

**Files:**
- Modify: `cli/src/core/CopilotChatTranscriptReader.ts`
- Modify: `cli/src/core/CopilotChatTranscriptReader.test.ts`

- [ ] **Step 1: Add failing tests for `replayPatches`**

Append to `CopilotChatTranscriptReader.test.ts`:

```typescript
import { _replayPatches } from "./CopilotChatTranscriptReader.js";

describe("_replayPatches", () => {
	it("returns empty doc when input is empty", () => {
		expect(_replayPatches([])).toEqual({});
	});

	it("applies kind:0 as full document replacement", () => {
		const lines = [JSON.stringify({ kind: 0, v: { foo: "bar", requests: [] } })];
		expect(_replayPatches(lines)).toEqual({ foo: "bar", requests: [] });
	});

	it("applies kind:1 as set-at-path", () => {
		const lines = [
			JSON.stringify({ kind: 0, v: { requests: [] } }),
			JSON.stringify({ kind: 1, k: ["requests", 0, "message"], v: { text: "hello" } }),
		];
		expect(_replayPatches(lines)).toEqual({ requests: [{ message: { text: "hello" } }] });
	});

	it("applies kind:2 as delete-at-path", () => {
		const lines = [
			JSON.stringify({ kind: 0, v: { pendingRequests: [{ id: "x" }] } }),
			JSON.stringify({ kind: 2, k: ["pendingRequests", 0] }),
		];
		expect(_replayPatches(lines)).toEqual({ pendingRequests: [] });
	});

	it("applies patches in file order", () => {
		const lines = [
			JSON.stringify({ kind: 0, v: { a: 1 } }),
			JSON.stringify({ kind: 1, k: ["a"], v: 2 }),
			JSON.stringify({ kind: 1, k: ["a"], v: 3 }),
		];
		expect(_replayPatches(lines)).toEqual({ a: 3 });
	});

	it("warns and skips on unknown kind, leaving doc untouched", () => {
		const lines = [
			JSON.stringify({ kind: 0, v: { a: 1 } }),
			JSON.stringify({ kind: 99, k: ["a"], v: "should-be-ignored" }),
		];
		expect(_replayPatches(lines)).toEqual({ a: 1 });
	});

	it("throws on JSON parse failure (caller handles mid-write)", () => {
		const lines = [JSON.stringify({ kind: 0, v: {} }), "{not-json"];
		expect(() => _replayPatches(lines)).toThrow();
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatTranscriptReader.test.ts -t "_replayPatches"`
Expected: FAIL — `_replayPatches` not exported.

- [ ] **Step 3: Implement `_replayPatches`**

Append to `CopilotChatTranscriptReader.ts` (after the primitives):

```typescript
import { createLogger } from "../Logger.js";

const log = createLogger("CopilotChatReader");

interface KindZeroEvent { kind: 0; v: unknown; }
interface KindOneEvent { kind: 1; k: PathSegment[]; v: unknown; }
interface KindTwoEvent { kind: 2; k: PathSegment[]; }
type PatchEvent = KindZeroEvent | KindOneEvent | KindTwoEvent | { kind: number };

/**
 * Replays a JSONL patch log into a final document.
 *
 *   kind 0 → replace entire document with `v`
 *   kind 1 → set `v` at path `k`
 *   kind 2 → delete value at path `k`
 *
 * Unknown `kind` is logged and skipped (forward compatibility — vscode may add
 * new event types in future versions). JSON parse errors are propagated so the
 * caller can distinguish "mid-write" from "structurally broken file".
 */
export function _replayPatches(lines: ReadonlyArray<string>): unknown {
	let doc: unknown = {};
	for (const raw of lines) {
		const evt = JSON.parse(raw) as PatchEvent;
		switch (evt.kind) {
			case 0:
				doc = (evt as KindZeroEvent).v;
				break;
			case 1: {
				const e = evt as KindOneEvent;
				_setAtPath(doc, e.k, e.v);
				break;
			}
			case 2: {
				const e = evt as KindTwoEvent;
				_deleteAtPath(doc, e.k);
				break;
			}
			default:
				log.warn("Unknown patch kind %s — skipping", evt.kind);
				break;
		}
	}
	return doc;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatTranscriptReader.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts
git commit -s -m "Add replayPatches for Copilot Chat JSONL"
```

---

## Task 8: Implement `readCopilotChatTranscript`

Read a `.jsonl` session file, replay it, and emit `TranscriptEntry` records from `requests[]` past the cursor's `lineNumber` (re-purposed to mean "request count already consumed"). Throw on fs / parse / schema errors so the QueueWorker dispatch's existing try/catch handles them uniformly with the other readers.

**Why match `TranscriptReadResult`:** the dispatch in `QueueWorker.ts:1521` accesses `result.newCursor.lineNumber` and `result.entries` (each with `role` + `content`). Returning anything else would force an adapter — match the existing contract instead.

**Files:**
- Modify: `cli/src/core/CopilotChatTranscriptReader.ts`
- Modify: `cli/src/core/CopilotChatTranscriptReader.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `CopilotChatTranscriptReader.test.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { readCopilotChatTranscript } from "./CopilotChatTranscriptReader.js";

describe("readCopilotChatTranscript", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-chat-reader-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function writeJsonl(name: string, events: object[]): string {
		const path = join(tmpRoot, name);
		writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n"));
		return path;
	}

	it("returns empty entries for an init-only file (cursor.lineNumber stays 0)", async () => {
		const path = writeJsonl("a.jsonl", [{ kind: 0, v: { requests: [] } }]);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([]);
		expect(result.newCursor.transcriptPath).toBe(path);
		expect(result.newCursor.lineNumber).toBe(0);
	});

	it("emits one human + one assistant per request with content", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "hello" },
			{ kind: 1, k: ["requests", 0, "response"], v: [{ value: "hi there" }] },
		];
		const path = writeJsonl("b.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([
			{ role: "human", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);
		expect(result.newCursor.lineNumber).toBe(1);
	});

	it("flattens multi-chunk response[] into a single assistant entry", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "explain" },
			{ kind: 1, k: ["requests", 0, "response"], v: [{ value: "Part A " }, { value: "Part B" }] },
		];
		const path = writeJsonl("c.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries.find((e) => e.role === "assistant")?.content).toBe("Part A Part B");
	});

	it("only emits requests at index >= cursor.lineNumber", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "first" },
			{ kind: 1, k: ["requests", 0, "response"], v: [{ value: "r1" }] },
			{ kind: 1, k: ["requests", 1, "message", "text"], v: "second" },
			{ kind: 1, k: ["requests", 1, "response"], v: [{ value: "r2" }] },
		];
		const path = writeJsonl("d.jsonl", events);
		const result = await readCopilotChatTranscript(path, {
			transcriptPath: path,
			lineNumber: 1,
			updatedAt: "2026-05-06T00:00:00Z",
		});
		expect(result.entries).toEqual([
			{ role: "human", content: "second" },
			{ role: "assistant", content: "r2" },
		]);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("skips requests with empty/missing message.text", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "" },
			{ kind: 1, k: ["requests", 0, "response"], v: [{ value: "answer" }] },
		];
		const path = writeJsonl("e.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([{ role: "assistant", content: "answer" }]);
	});

	it("skips requests with empty assistant response", async () => {
		const events = [
			{ kind: 0, v: { requests: [] } },
			{ kind: 1, k: ["requests", 0, "message", "text"], v: "question" },
			{ kind: 1, k: ["requests", 0, "response"], v: [] },
		];
		const path = writeJsonl("f.jsonl", events);
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([{ role: "human", content: "question" }]);
	});

	it("throws CopilotChatScanError on mid-write JSON parse failure (kind=parse)", async () => {
		const path = join(tmpRoot, "g.jsonl");
		writeFileSync(path, `${JSON.stringify({ kind: 0, v: { requests: [] } })}\n{not-json`);
		await expect(readCopilotChatTranscript(path)).rejects.toThrow(/parse/);
	});

	it("throws CopilotChatScanError when file is missing (kind=fs)", async () => {
		await expect(
			readCopilotChatTranscript(join(tmpRoot, "does-not-exist.jsonl")),
		).rejects.toThrow(/fs|ENOENT/i);
	});

	it("treats empty file as init-less doc → no entries, no throw", async () => {
		const path = join(tmpRoot, "empty.jsonl");
		writeFileSync(path, "");
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([]);
	});

	it("throws schema error when requests is not an array", async () => {
		const path = writeJsonl("bad-shape.jsonl", [{ kind: 0, v: { requests: "not-an-array" } }]);
		await expect(readCopilotChatTranscript(path)).rejects.toThrow(/schema|requests/);
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatTranscriptReader.test.ts -t "readCopilotChatTranscript"`
Expected: FAIL — `readCopilotChatTranscript` not exported.

- [ ] **Step 3: Implement `readCopilotChatTranscript`**

Append to `CopilotChatTranscriptReader.ts`:

```typescript
import { readFile, stat } from "node:fs/promises";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";

/** Structured error thrown by the Copilot Chat reader. Surfaced via `error.cause.kind`. */
export interface CopilotChatScanError {
	readonly kind: "parse" | "fs" | "schema" | "unknown";
	readonly message: string;
}

/** Throws an Error with a `CopilotChatScanError` payload attached to .cause. */
function throwScanError(kind: CopilotChatScanError["kind"], message: string): never {
	const err = new Error(`Copilot Chat scan failed (${kind}): ${message}`);
	(err as Error & { cause: CopilotChatScanError }).cause = { kind, message };
	throw err;
}

interface ChatRequest {
	message?: { text?: string };
	response?: ReadonlyArray<{ value?: string }>;
}

/**
 * Reads a vscode Copilot Chat session JSONL, replays patches into the final
 * document, and emits TranscriptEntry records for `requests[i]` where
 * i >= cursor.lineNumber. The cursor's `lineNumber` is re-purposed as
 * "request count already consumed" — monotonic, matches the TranscriptCursor
 * contract used by every other reader.
 *
 * Errors are thrown (not returned) so the QueueWorker dispatch's existing
 * try/catch + continue path handles them uniformly. The cursor is not
 * advanced on error: the next commit-time scan retries.
 */
export async function readCopilotChatTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor,
): Promise<TranscriptReadResult> {
	const fromIdx = cursor?.lineNumber ?? 0;

	let raw: string;
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch (error: unknown) {
		throwScanError("fs", (error as Error).message);
	}

	const lines = raw.split("\n").filter((l) => l.length > 0);
	if (lines.length === 0) {
		const updatedAt = await stat(transcriptPath).then((s) => new Date(s.mtimeMs).toISOString());
		return {
			entries: [],
			newCursor: { transcriptPath, lineNumber: 0, updatedAt },
			totalLinesRead: 0,
		};
	}

	let doc: unknown;
	try {
		doc = _replayPatches(lines);
	} catch (error: unknown) {
		throwScanError("parse", (error as Error).message);
	}

	const requests = (doc as { requests?: unknown }).requests;
	if (!Array.isArray(requests)) {
		throwScanError("schema", "requests is not an array");
	}

	const entries: TranscriptEntry[] = [];
	for (let i = fromIdx; i < requests.length; i++) {
		const req = requests[i] as ChatRequest;
		const userText = req?.message?.text;
		if (typeof userText === "string" && userText.length > 0) {
			entries.push({ role: "human", content: userText });
		}
		const responseList = Array.isArray(req?.response) ? req.response : [];
		const assistantText = responseList
			.map((chunk) => (typeof chunk?.value === "string" ? chunk.value : ""))
			.join("");
		if (assistantText.length > 0) {
			entries.push({ role: "assistant", content: assistantText });
		}
	}

	const updatedAt = await stat(transcriptPath).then((s) => new Date(s.mtimeMs).toISOString());
	return {
		entries,
		newCursor: { transcriptPath, lineNumber: requests.length, updatedAt },
		totalLinesRead: lines.length,
	};
}
```

- [ ] **Step 4: Run all reader tests**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatTranscriptReader.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Run typecheck and lint**

Run: `npm run typecheck:cli && npm run lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts
git commit -s -m "Add readCopilotChatTranscript matching TranscriptReadResult"
```

---

## Task 9: Implement `CopilotChatSessionDiscoverer`

Locate the workspace hash for `projectDir`, list `.jsonl` files in its `chatSessions/` dir, filter by 48-hour mtime window, return `SessionInfo[]`.

**Files:**
- Create: `cli/src/core/CopilotChatSessionDiscoverer.ts`
- Create: `cli/src/core/CopilotChatSessionDiscoverer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// cli/src/core/CopilotChatSessionDiscoverer.test.ts
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomedir, mockPlatform } = vi.hoisted(() => ({
	mockHomedir: vi.fn(),
	mockPlatform: vi.fn().mockReturnValue("darwin"),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir, platform: mockPlatform };
});

describe("scanCopilotChatSessions", () => {
	let tmpRoot: string;
	let projectDir: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-chat-disc-"));
		projectDir = join(tmpRoot, "myproject");
		mkdirSync(projectDir, { recursive: true });
		mockHomedir.mockReturnValue(tmpRoot);
		mockPlatform.mockReturnValue("darwin");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		vi.resetModules();
	});

	function makeWorkspace(wsHash: string, folderUri: string): string {
		const wsDir = join(
			tmpRoot,
			"Library",
			"Application Support",
			"Code",
			"User",
			"workspaceStorage",
			wsHash,
		);
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(join(wsDir, "workspace.json"), JSON.stringify({ folder: folderUri }));
		return wsDir;
	}

	function makeSessionFile(wsDir: string, sessionId: string, ageHours: number): string {
		const sessionsDir = join(wsDir, "chatSessions");
		mkdirSync(sessionsDir, { recursive: true });
		const path = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(path, JSON.stringify({ kind: 0, v: { requests: [] } }));
		const targetMs = Date.now() - ageHours * 3600 * 1000;
		const targetSec = targetMs / 1000;
		utimesSync(path, targetSec, targetSec);
		return path;
	}

	it("returns empty when projectDir has no matching workspace", async () => {
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("returns empty when workspace exists but chatSessions/ is missing", async () => {
		makeWorkspace("ws1", `file://${projectDir}`);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("returns fresh sessions, excludes sessions older than 48h", async () => {
		const wsDir = makeWorkspace("ws1", `file://${projectDir}`);
		makeSessionFile(wsDir, "fresh", 1);
		makeSessionFile(wsDir, "stale", 72);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions.map((s) => s.sessionId)).toEqual(["fresh"]);
		expect(result.sessions[0].source).toBe("copilot-chat");
		expect(result.sessions[0].transcriptPath.endsWith("fresh.jsonl")).toBe(true);
	});

	it("ignores non-.jsonl files in chatSessions/", async () => {
		const wsDir = makeWorkspace("ws1", `file://${projectDir}`);
		makeSessionFile(wsDir, "real", 1);
		const sessionsDir = join(wsDir, "chatSessions");
		writeFileSync(join(sessionsDir, "ignore-me.txt"), "");
		writeFileSync(join(sessionsDir, "ignore-me.json"), "{}");
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions.map((s) => s.sessionId)).toEqual(["real"]);
	});

	it("reports updatedAt as ISO string from file mtime", async () => {
		const wsDir = makeWorkspace("ws1", `file://${projectDir}`);
		makeSessionFile(wsDir, "s1", 2);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("returns fs error when chatSessions/ readdir fails for non-ENOENT reason", async () => {
		const wsDir = makeWorkspace("ws1", `file://${projectDir}`);
		// Create a file (not a directory) at chatSessions path → ENOTDIR
		writeFileSync(join(wsDir, "chatSessions"), "");
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
		expect(result.error?.kind).toBe("fs");
	});

	it("discoverCopilotChatSessions wrapper returns array unchanged on success", async () => {
		const wsDir = makeWorkspace("ws1", `file://${projectDir}`);
		makeSessionFile(wsDir, "s1", 1);
		const { discoverCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const sessions = await discoverCopilotChatSessions(projectDir);
		expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);
	});
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatSessionDiscoverer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `CopilotChatSessionDiscoverer.ts`**

```typescript
// cli/src/core/CopilotChatSessionDiscoverer.ts
/**
 * VS Code Copilot Chat session discoverer.
 *
 * Locates the vscode workspaceStorage entry whose `workspace.json` resolves to
 * projectDir, then enumerates `*.jsonl` files in `<wsHash>/chatSessions/`.
 * Each file is one chat session — `transcriptPath` is the absolute file path.
 * Sessions older than 48 h are excluded (matches the OpenCode/Cursor/Copilot
 * convention).
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import type { CopilotChatScanError } from "./CopilotChatTranscriptReader.js";
import { findVscodeWorkspaceHash, getVscodeWorkspaceStorageDir } from "./VscodeWorkspaceLocator.js";

const log = createLogger("CopilotChatDiscoverer");

const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export type { CopilotChatScanError };

export interface CopilotChatScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: CopilotChatScanError;
}

export async function scanCopilotChatSessions(projectDir: string): Promise<CopilotChatScanResult> {
	const wsHash = await findVscodeWorkspaceHash("Code", projectDir);
	if (wsHash === null) {
		log.debug("No vscode workspace matched %s", projectDir);
		return { sessions: [] };
	}

	const sessionsDir = join(getVscodeWorkspaceStorageDir("Code"), wsHash, "chatSessions");

	let entries: string[];
	try {
		entries = await readdir(sessionsDir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			log.debug("chatSessions/ not present at %s", sessionsDir);
			return { sessions: [] };
		}
		log.error("readdir %s failed (%s): %s", sessionsDir, code ?? "unknown", (error as Error).message);
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const sessions: SessionInfo[] = [];

	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const filePath = join(sessionsDir, entry);
		let mtimeMs: number;
		try {
			const fileStat = await stat(filePath);
			mtimeMs = fileStat.mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs < cutoffMs) continue;
		const sessionId = entry.slice(0, -".jsonl".length);
		sessions.push({
			sessionId,
			transcriptPath: filePath,
			updatedAt: new Date(mtimeMs).toISOString(),
			source: "copilot-chat",
		});
	}

	log.info("Discovered %d Copilot Chat session(s) for %s", sessions.length, projectDir);
	return { sessions };
}

/** Convenience wrapper without the error channel — used by QueueWorker. */
export async function discoverCopilotChatSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanCopilotChatSessions(projectDir);
	if (error) {
		log.warn("Copilot Chat scan error (%s) — sessions excluded from this run: %s", error.kind, error.message);
	}
	return sessions;
}
```

- [ ] **Step 4: Run all discoverer tests**

Run: `npm run test -w @jolli.ai/cli -- src/core/CopilotChatSessionDiscoverer.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Run typecheck and lint**

Run: `npm run typecheck:cli && npm run lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/CopilotChatSessionDiscoverer.ts cli/src/core/CopilotChatSessionDiscoverer.test.ts
git commit -s -m "Add CopilotChatSessionDiscoverer"
```

---

## Task 10: Wire Copilot Chat into `Installer.install()` (auto-enable)

Auto-enable `copilotEnabled` on first install when **either** form is detected.

**Files:**
- Modify: `cli/src/install/Installer.ts:272-279` (Copilot CLI auto-detect block)
- Modify: `cli/src/install/Installer.test.ts` (add "auto-enables on Chat-only install" case)

- [ ] **Step 1: Write failing test**

Add to `cli/src/install/Installer.test.ts` near the existing copilot auto-enable tests (around line 298-329):

```typescript
it("auto-enables copilotEnabled when only Copilot Chat is detected", async () => {
	const { install } = await import("./Installer.js");
	const { isCopilotInstalled } = await import("../core/CopilotDetector.js");
	const { isCopilotChatInstalled } = await import("../core/CopilotChatDetector.js");
	vi.mocked(isCopilotInstalled).mockResolvedValueOnce(false);
	vi.mocked(isCopilotChatInstalled).mockResolvedValueOnce(true);

	await install(testCwd);

	const globalConfig = await loadConfigFromDir(getGlobalConfigDir());
	expect(globalConfig.copilotEnabled).toBe(true);
});

it("does not auto-enable when neither Copilot form is present", async () => {
	const { install } = await import("./Installer.js");
	const { isCopilotInstalled } = await import("../core/CopilotDetector.js");
	const { isCopilotChatInstalled } = await import("../core/CopilotChatDetector.js");
	vi.mocked(isCopilotInstalled).mockResolvedValueOnce(false);
	vi.mocked(isCopilotChatInstalled).mockResolvedValueOnce(false);

	await install(testCwd);

	const globalConfig = await loadConfigFromDir(getGlobalConfigDir());
	expect(globalConfig.copilotEnabled).toBeUndefined();
});
```

Add the `isCopilotChatInstalled` mock to the existing module mock block at the top of the test file (around line 60-75):

```typescript
vi.mock("../core/CopilotChatDetector.js", () => ({
	isCopilotChatInstalled: vi.fn().mockResolvedValue(false),
	getCopilotChatStorageDir: vi.fn().mockReturnValue("/fake/Code/User/globalStorage/github.copilot-chat"),
}));
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts -t "Copilot Chat"`
Expected: FAIL — `isCopilotChatInstalled` not yet imported in Installer.

- [ ] **Step 3: Update `Installer.ts:install()` auto-detect block**

In `cli/src/install/Installer.ts`, at the top imports (near line 22-23), add:

```typescript
import { isCopilotChatInstalled } from "../core/CopilotChatDetector.js";
import { scanCopilotChatSessions } from "../core/CopilotChatSessionDiscoverer.js";
```

Replace the Copilot auto-detect block at line 272-279:

```typescript
// Auto-detect Copilot CLI and enable session discovery
const copilotDetected = config.copilotEnabled !== false && (await isCopilotInstalled());
if (copilotDetected) {
    if (config.copilotEnabled === undefined) {
        await saveConfig({ copilotEnabled: true });
        log.info("Copilot CLI detected — enabled Copilot session discovery");
    }
}
```

with:

```typescript
// Auto-detect GitHub Copilot in either form (terminal CLI or vscode Chat) and
// enable the shared copilotEnabled flag. Both sources share one toggle —
// see docs/superpowers/specs/2026-05-06-copilot-chat-support-design.md.
const copilotDetected = config.copilotEnabled !== false && (await isCopilotInstalled());
const copilotChatDetected = config.copilotEnabled !== false && (await isCopilotChatInstalled());
if ((copilotDetected || copilotChatDetected) && config.copilotEnabled === undefined) {
    await saveConfig({ copilotEnabled: true });
    log.info("GitHub Copilot detected (CLI=%s, Chat=%s) — enabled session discovery",
        copilotDetected, copilotChatDetected);
}
```

- [ ] **Step 4: Run install tests to verify pass**

Run: `npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts -t "Copilot"`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/install/Installer.ts cli/src/install/Installer.test.ts
git commit -s -m "Wire Copilot Chat detection into Installer.install auto-enable"
```

---

## Task 11: Wire Copilot Chat into `Installer.getStatus()`

Add `copilotChatDetected` and `copilotChatScanError` to `StatusInfo` (Types.ts) and to the `getStatus()` return value, and run `scanCopilotChatSessions` for session counts. The reader exists by this point (Tasks 6-8) so importing `CopilotChatScanError` typechecks cleanly.

**Files:**
- Modify: `cli/src/Types.ts:578-616` (StatusInfo)
- Modify: `cli/src/install/Installer.ts:497` (detector calls), `:549-557` (Copilot CLI scan block), `:633-635` (StatusInfo build), `:647-666` (log)
- Modify: `cli/src/install/Installer.test.ts`

- [ ] **Step 1: Add Copilot Chat fields to `StatusInfo`**

In `cli/src/Types.ts`, near the top imports, add:

```typescript
import type { CopilotChatScanError } from "./core/CopilotChatTranscriptReader.js";
```

Then after the existing `copilotScanError` field (line ~616), add:

```typescript
	/** Whether vscode's Copilot Chat globalStorage dir was detected */
	readonly copilotChatDetected?: boolean;
	/** Copilot Chat scan failed with a real (non-ENOENT) error: parse / fs / schema. */
	readonly copilotChatScanError?: CopilotChatScanError;
```

(No `copilotChatEnabled` field — `copilotEnabled` is shared.)

Run: `npm run typecheck:cli`
Expected: 0 errors. (The reader from Tasks 6-8 already exports `CopilotChatScanError`.)

- [ ] **Step 2: Write failing test**

Add to `Installer.test.ts` near the existing Copilot status test (around line 2118-2162):

```typescript
it("getStatus reports copilotChatDetected when chat dir is present", async () => {
	const { getStatus } = await import("./Installer.js");
	const { isCopilotChatInstalled } = await import("../core/CopilotChatDetector.js");
	vi.mocked(isCopilotChatInstalled).mockResolvedValue(true);

	const status = await getStatus(testCwd);

	expect(status.copilotChatDetected).toBe(true);
});

it("getStatus surfaces copilot-chat sessions and uses copilotEnabled gating", async () => {
	const { getStatus } = await import("./Installer.js");
	const { isCopilotChatInstalled } = await import("../core/CopilotChatDetector.js");
	const { scanCopilotChatSessions } = await import("../core/CopilotChatSessionDiscoverer.js");
	vi.mocked(isCopilotChatInstalled).mockResolvedValue(true);
	vi.mocked(scanCopilotChatSessions).mockResolvedValue({
		sessions: [
			{
				sessionId: "chat-1",
				transcriptPath: "/fake/Code/.../chat-1.jsonl",
				updatedAt: "2026-05-06T00:00:00Z",
				source: "copilot-chat",
			},
		],
	});
	await saveConfigScoped({ copilotEnabled: true }, getGlobalConfigDir());

	const status = await getStatus(testCwd);
	expect(status.sessionsBySource?.["copilot-chat"]).toBe(1);
});
```

Also add `scanCopilotChatSessions` to the existing CopilotChatDetector mock block (Task 10 step 1):

```typescript
vi.mock("../core/CopilotChatSessionDiscoverer.js", () => ({
	scanCopilotChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
	discoverCopilotChatSessions: vi.fn().mockResolvedValue([]),
}));
```

- [ ] **Step 3: Run test to verify failure**

Run: `npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts -t "copilotChatDetected"`
Expected: FAIL — field not populated by `getStatus()` yet.

- [ ] **Step 4: Add `getStatus` calls and field**

In `Installer.ts:getStatus()`:

After line 497 (`const copilotDetected = await isCopilotInstalled();`), add:

```typescript
const copilotChatDetected = await isCopilotChatInstalled();
```

After the Copilot CLI scan block at lines 549-557, add:

```typescript
// Discover Copilot Chat sessions on-demand (not stored in sessions.json).
let copilotChatScanError: CopilotChatScanError | undefined;
if (config.copilotEnabled !== false && copilotChatDetected) {
    const scan = await scanCopilotChatSessions(projectDir);
    if (scan.sessions.length > 0) {
        allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
    }
    copilotChatScanError = scan.error;
}
```

Add to the imports at the top of `Installer.ts` (near line 22):

```typescript
import type { CopilotChatScanError } from "../core/CopilotChatTranscriptReader.js";
```

In the `StatusInfo` build at lines 633-635, after `copilotScanError`, add:

```typescript
copilotChatDetected,
copilotChatScanError,
```

In the final `log.info` at 647-666, append the new fields to the format string:

Find:
```typescript
log.info(
    "Status: enabled=%s, claude=%s, git=%s, geminiHook=%s, worktreeHooks=%s, sessions=%d, summaries=%d, codex=%s/%s, gemini=%s/%s, enabledWorktrees=%s, opencode=%s/%s, cursor=%s/%s, copilot=%s/%s",
    ...,
    status.copilotDetected,
    status.copilotEnabled,
);
```

Replace with:
```typescript
log.info(
    "Status: enabled=%s, claude=%s, git=%s, geminiHook=%s, worktreeHooks=%s, sessions=%d, summaries=%d, codex=%s/%s, gemini=%s/%s, enabledWorktrees=%s, opencode=%s/%s, cursor=%s/%s, copilot=%s/%s, copilotChat=%s",
    ...,
    status.copilotDetected,
    status.copilotEnabled,
    status.copilotChatDetected,
);
```

- [ ] **Step 5: Run getStatus tests to verify pass**

Run: `npm run test -w @jolli.ai/cli -- src/install/Installer.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/Types.ts cli/src/install/Installer.ts cli/src/install/Installer.test.ts
git commit -s -m "Surface Copilot Chat status in Installer.getStatus"
```

---

## Task 12: Wire `discoverCopilotChatSessions` into `QueueWorker`

Discover Copilot Chat sessions during the post-commit pipeline.

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts:1443-1448` (after the Copilot CLI block)

- [ ] **Step 1: Add import and discovery block**

In `cli/src/hooks/QueueWorker.ts`, near the existing Copilot imports (line 25-27):

```typescript
import { discoverCopilotChatSessions } from "../core/CopilotChatSessionDiscoverer.js";
import { isCopilotChatInstalled } from "../core/CopilotChatDetector.js";
```

After the Copilot CLI discovery block at line 1443-1448:

```typescript
// Discover Copilot CLI sessions (on-demand SQLite scan).
if (config.copilotEnabled !== false && (await isCopilotInstalled())) {
    const copilotSessions = await discoverCopilotSessions(cwd);
    if (copilotSessions.length > 0) {
        allSessions = [...allSessions, ...copilotSessions];
        log.info("Discovered %d Copilot session(s)", copilotSessions.length);
    }
}
```

Add a parallel block:

```typescript
// Discover Copilot Chat sessions (on-demand JSONL scan in vscode workspaceStorage).
// Shares copilotEnabled with the CLI source (one user-facing toggle for "GitHub Copilot").
if (config.copilotEnabled !== false && (await isCopilotChatInstalled())) {
    const chatSessions = await discoverCopilotChatSessions(cwd);
    if (chatSessions.length > 0) {
        allSessions = [...allSessions, ...chatSessions];
        log.info("Discovered %d Copilot Chat session(s)", chatSessions.length);
    }
}
```

- [ ] **Step 2: Run QueueWorker tests**

Run: `npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.test.ts`
Expected: ALL PASS. If a test asserts on the number of session-source modules called, add a mock for `isCopilotChatInstalled` (returns false by default) and `discoverCopilotChatSessions` (returns []).

If new test cases needed for the chat-source path, add:

```typescript
it("includes Copilot Chat sessions when chat is detected and copilotEnabled is true", async () => {
	const { isCopilotChatInstalled } = await import("../core/CopilotChatDetector.js");
	const { discoverCopilotChatSessions } = await import("../core/CopilotChatSessionDiscoverer.js");
	vi.mocked(isCopilotChatInstalled).mockResolvedValueOnce(true);
	vi.mocked(discoverCopilotChatSessions).mockResolvedValueOnce([
		{
			sessionId: "chat-1",
			transcriptPath: "/fake/chat-1.jsonl",
			updatedAt: "2026-05-06T00:00:00Z",
			source: "copilot-chat",
		},
	]);

	// ... existing harness to invoke QueueWorker
	// Assert: chat-1 appears in the session pool used for transcript reading.
});
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck:cli`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts
git commit -s -m "Wire Copilot Chat discovery into QueueWorker"
```

---

## Task 13: Wire `readCopilotChatTranscript` into `QueueWorker` reader dispatch

Add the `"copilot-chat"` case in the transcript-reader switch.

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts:1510-1514` (transcript reader dispatch)

- [ ] **Step 1: Add the `copilot-chat` reader branch**

In `cli/src/hooks/QueueWorker.ts`, near line 27 (existing Copilot reader import), add:

```typescript
import { readCopilotChatTranscript } from "../core/CopilotChatTranscriptReader.js";
```

In the reader dispatch around line 1510-1521, locate the Copilot CLI branch:

```typescript
} else if (source === "copilot") {
    try {
        result = await readCopilotTranscript(session.transcriptPath, cursor, beforeTimestamp);
    } catch (error: unknown) {
        log.error("Skipping Copilot session %s: %s", session.sessionId, (error as Error).message);
        continue;
    }
}
```

Add a parallel Copilot Chat branch immediately after, before the trailing `else { result = await readTranscript(...) }`:

```typescript
} else if (source === "copilot-chat") {
    try {
        result = await readCopilotChatTranscript(session.transcriptPath, cursor);
    } catch (error: unknown) {
        log.error("Skipping Copilot Chat session %s: %s", session.sessionId, (error as Error).message);
        continue;
    }
}
```

(`readCopilotChatTranscript` returns `TranscriptReadResult` directly — no adapter needed. `beforeTimestamp` isn't passed because the chat reader filters by `cursor.lineNumber` (request count), not timestamp; the session-level mtime filtering already happened in the discoverer.)

- [ ] **Step 2: Run QueueWorker tests with chat reader path**

Run: `npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.test.ts`
Expected: ALL PASS.

If the existing reader dispatch returns a typed `TranscriptReadResult` shape, ensure `readCopilotChatTranscript` is shaped compatibly — adapter conversion may be needed inline. Check the function `readCopilotTranscript`'s return type; if the dispatch normalizes via a wrapper type, do the same here.

- [ ] **Step 3: Run typecheck and full cli test suite**

Run: `npm run typecheck:cli && npm run test -w @jolli.ai/cli`
Expected: 0 errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts
git commit -s -m "Wire Copilot Chat reader into QueueWorker dispatch"
```

---

## Task 14: VS Code `StatusTreeProvider` — show form breakdown

Update the Copilot status row to OR-detect across both forms and surface a tooltip indicating which forms were found.

**Files:**
- Modify: `vscode/src/providers/StatusTreeProvider.ts:318-338`
- Modify: `vscode/src/providers/StatusTreeProvider.test.ts`

- [ ] **Step 1: Write failing test**

Add to `StatusTreeProvider.test.ts`:

```typescript
it("Copilot row tooltip distinguishes CLI / Chat detection", async () => {
	const { provider } = setupProvider({
		copilotDetected: true,
		copilotChatDetected: false,
		copilotEnabled: true,
	});
	const items = await provider.getChildren();
	const copilotItem = items.find((i) => i.label?.toString().includes("Copilot"));
	expect(copilotItem?.tooltip?.toString()).toContain("CLI: ✓");
	expect(copilotItem?.tooltip?.toString()).toContain("Chat: ✗");
});

it("Copilot row detected = true when only Chat is detected", async () => {
	const { provider } = setupProvider({
		copilotDetected: false,
		copilotChatDetected: true,
		copilotEnabled: true,
	});
	const items = await provider.getChildren();
	const copilotItem = items.find((i) => i.label?.toString().includes("Copilot"));
	// Item is rendered with detected=true (e.g. shows "available" rather than "not detected")
	expect(copilotItem).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -w jollimemory-vscode -- src/providers/StatusTreeProvider.test.ts -t "Copilot"`
Expected: FAIL — current code only reads `copilotDetected`.

- [ ] **Step 3: Update `StatusTreeProvider.ts` Copilot block (around line 318-338)**

The existing block uses an `if (scanError) { ... } else { pushIntegrationItem(...) }` structure — when the CLI's DB is unreadable, no row is shown. We change this to **always** show one Copilot row (OR-detected across forms), plus independent warn rows for each form's scan error. This way, partial outages (e.g. CLI locked but Chat fine) still inform the user that Chat is working.

Replace:

```typescript
// Copilot CLI also has a scan-time error channel (DB can be locked/corrupt).
if (s.copilotScanError) {
    items.push(
        new StatusItem(
            "Copilot Integration",
            `unavailable — ${s.copilotScanError.kind}`,
            ICON_WARN,
            `Copilot database scan failed (${s.copilotScanError.kind}): ${s.copilotScanError.message}`,
        ),
    );
} else {
    pushIntegrationItem(
        items,
        s.copilotDetected,
        s.copilotEnabled !== false,
        undefined,
        "Copilot Integration",
        "Copilot CLI database found — session discovery is enabled",
        "Copilot CLI detected but session discovery is disabled in config",
        undefined,
        counts.copilot,
    );
}
```

with:

```typescript
// Copilot integration: shared `copilotEnabled` toggle for terminal CLI and VS Code Chat.
// Each form has its own scan-error channel; each surfaces as a separate warn row.
if (s.copilotScanError) {
    items.push(
        new StatusItem(
            "Copilot Integration",
            `unavailable — ${s.copilotScanError.kind}`,
            ICON_WARN,
            `Copilot CLI database scan failed (${s.copilotScanError.kind}): ${s.copilotScanError.message}`,
        ),
    );
}
if (s.copilotChatScanError) {
    items.push(
        new StatusItem(
            "Copilot Chat",
            `unavailable — ${s.copilotChatScanError.kind}`,
            ICON_WARN,
            `Copilot Chat scan failed (${s.copilotChatScanError.kind}): ${s.copilotChatScanError.message}`,
        ),
    );
}
const cliMark = s.copilotDetected ? "✓" : "✗";
const chatMark = s.copilotChatDetected ? "✓" : "✗";
const anyCopilotDetected = (s.copilotDetected ?? false) || (s.copilotChatDetected ?? false);
const copilotSessions = (counts.copilot ?? 0) + (counts["copilot-chat"] ?? 0);
pushIntegrationItem(
    items,
    anyCopilotDetected,
    s.copilotEnabled !== false,
    undefined,
    "Copilot Integration",
    `GitHub Copilot detected (CLI: ${cliMark}, Chat: ${chatMark}) — session discovery is enabled`,
    `GitHub Copilot detected (CLI: ${cliMark}, Chat: ${chatMark}) but session discovery is disabled in config`,
    undefined,
    copilotSessions,
);
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test -w jollimemory-vscode -- src/providers/StatusTreeProvider.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/providers/StatusTreeProvider.ts vscode/src/providers/StatusTreeProvider.test.ts
git commit -s -m "Show CLI/Chat form breakdown in Copilot status row"
```

---

## Task 15: VS Code Settings panel — update Copilot description

Single toggle, but the description should mention both source forms.

**Files:**
- Modify: `vscode/src/views/SettingsHtmlBuilder.ts:88`
- Modify: `vscode/src/views/SettingsHtmlBuilder.test.ts`

- [ ] **Step 1: Update description**

In `SettingsHtmlBuilder.ts:88`, replace:

```typescript
${buildToggleRow("copilotEnabled", "Copilot", "Session discovery via ~/.copilot/session-store.db")}
```

with:

```typescript
${buildToggleRow("copilotEnabled", "Copilot", "Session discovery for GitHub Copilot CLI (~/.copilot/session-store.db) and VS Code Copilot Chat (workspace storage)")}
```

- [ ] **Step 2: Update existing test if it asserts on description text**

In `SettingsHtmlBuilder.test.ts`, find any test that asserts on the Copilot description string and update the expected text to match the new wording.

If no test asserts on description text, add a regression-style assertion:

```typescript
it("Copilot toggle description mentions both CLI and Chat sources", () => {
	const html = build(/* ... */);
	expect(html).toContain("Copilot CLI");
	expect(html).toContain("Copilot Chat");
});
```

- [ ] **Step 3: Run tests**

Run: `npm run test -w jollimemory-vscode -- src/views/SettingsHtmlBuilder.test.ts`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add vscode/src/views/SettingsHtmlBuilder.ts vscode/src/views/SettingsHtmlBuilder.test.ts
git commit -s -m "Update Copilot toggle description to mention CLI and Chat"
```

---

## Task 16: VS Code Summary panel — add `copilot-chat` to source ordering

Surface Copilot Chat sessions in the summary details list with the right label and ordering.

**Files:**
- Modify: `vscode/src/views/SummaryWebviewPanel.ts:2050` (getEnabledSources)
- Modify: `vscode/src/views/SummaryScriptBuilder.ts:1136` (label map), `:1562` (sourceOrder)
- Modify corresponding `*.test.ts` files.

- [ ] **Step 1: Update `SummaryWebviewPanel.getEnabledSources`**

In `SummaryWebviewPanel.ts` around line 2050:

```typescript
if (config.copilotEnabled !== false) {
    sources.add("copilot");
}
```

Change to:

```typescript
if (config.copilotEnabled !== false) {
    sources.add("copilot");
    sources.add("copilot-chat");
}
```

- [ ] **Step 2: Update `SummaryScriptBuilder` label and order**

In `SummaryScriptBuilder.ts:1136`, add a Copilot Chat label after the existing Copilot label:

```javascript
if (source === 'copilot') return 'Copilot';
if (source === 'copilot-chat') return 'Copilot Chat';
```

In `SummaryScriptBuilder.ts:1562`, extend the source order array:

```javascript
var sourceOrder = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'copilot-chat'];
```

- [ ] **Step 3: Add tests**

In `SummaryWebviewPanel.test.ts`, add:

```typescript
it("includes copilot-chat in enabled sources when copilotEnabled is true", () => {
	const sources = getEnabledSources({ copilotEnabled: true });
	expect(sources).toContain("copilot-chat");
});

it("excludes copilot-chat when copilotEnabled is false", () => {
	const sources = getEnabledSources({ copilotEnabled: false });
	expect(sources).not.toContain("copilot-chat");
});
```

In `SummaryScriptBuilder.test.ts`, add:

```typescript
it("renders 'Copilot Chat' label for copilot-chat source", () => {
	const script = buildSummaryScript(/* ... */);
	expect(script).toContain("'Copilot Chat'");
});

it("places copilot-chat after copilot in source ordering", () => {
	const script = buildSummaryScript(/* ... */);
	expect(script).toMatch(/'copilot',\s*'copilot-chat'/);
});
```

- [ ] **Step 4: Run tests**

Run: `npm run test -w jollimemory-vscode -- src/views/Summary`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add vscode/src/views/SummaryWebviewPanel.ts vscode/src/views/SummaryScriptBuilder.ts vscode/src/views/SummaryWebviewPanel.test.ts vscode/src/views/SummaryScriptBuilder.test.ts
git commit -s -m "Add copilot-chat source to Summary panel rendering"
```

---

## Task 17: CLI `StatusCommand` — show form breakdown sub-line

Append a sub-line to the Copilot status row showing CLI / Chat detection state.

**Files:**
- Modify: `cli/src/commands/StatusCommand.ts:162-168`
- Modify: `cli/src/commands/StatusCommand.test.ts`

- [ ] **Step 1: Update `StatusCommand.ts`**

In `StatusCommand.ts` around line 160-175, find the existing Copilot tuple in `integrationRows` and the loop that prints it. We modify the tuple's `detected` predicate, sum the session count across both forms, and append a sub-line after the row.

Replace the Copilot tuple in `integrationRows`:

```typescript
[
    "Copilot:",
    status.copilotDetected,
    {
        enabled: status.copilotEnabled !== false,
        hookInstalled: undefined,
        sessionCount: counts.copilot,
        scanError: status.copilotScanError,
    },
],
```

with:

```typescript
[
    "Copilot:",
    (status.copilotDetected ?? false) || (status.copilotChatDetected ?? false),
    {
        enabled: status.copilotEnabled !== false,
        hookInstalled: undefined,
        sessionCount: (counts.copilot ?? 0) + (counts["copilot-chat"] ?? 0),
        // CLI scan error takes precedence; chat scan error surfaced via sub-line below.
        scanError: status.copilotScanError,
    },
],
```

Then, immediately after the `for (const [label, detected, inputs] of integrationRows)` loop completes (the closing brace `}` of that for-loop), append a sub-line for Copilot when applicable:

```typescript
const anyCopilotDetected = (status.copilotDetected ?? false) || (status.copilotChatDetected ?? false);
if (anyCopilotDetected) {
    const cliMark = status.copilotDetected ? "✓" : "✗";
    const chatMark = status.copilotChatDetected ? "✓" : "✗";
    console.log(`  ${"".padEnd(18)}↳ CLI: ${cliMark}, Chat: ${chatMark}`);
    if (status.copilotChatScanError) {
        console.log(
            `  ${"".padEnd(18)}↳ Chat scan failed (${status.copilotChatScanError.kind}): ${status.copilotChatScanError.message}`,
        );
    }
}
```

- [ ] **Step 2: Update `StatusCommand.test.ts`**

```typescript
it("Copilot row shows CLI/Chat breakdown when only chat is detected", async () => {
	const status: StatusInfo = {
		// ... fixture
		copilotDetected: false,
		copilotChatDetected: true,
		copilotEnabled: true,
		sessionsBySource: { "copilot-chat": 2 },
	};
	const output = captureStdout(() => printStatus(status));
	expect(output).toContain("CLI: ✗");
	expect(output).toContain("Chat: ✓");
	expect(output).toMatch(/sessions:\s*2/);
});
```

- [ ] **Step 3: Run StatusCommand tests**

Run: `npm run test -w @jolli.ai/cli -- src/commands/StatusCommand.test.ts`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/StatusCommand.ts cli/src/commands/StatusCommand.test.ts
git commit -s -m "Show CLI/Chat form breakdown in jolli status output"
```

---

## Task 18: Final integration check — `npm run all` + fix-up

Run the project-wide gate and resolve any remaining issues.

- [ ] **Step 1: Run the full pipeline**

Run from repo root:

```bash
npm run all
```

This chains: clean → build → lint → test, with the cli workspace's 97% coverage gate enforced.

Expected: PASS. If failures occur, they will fall into one of these classes — diagnose and fix:

| Failure class | Likely cause | Fix |
|---|---|---|
| Coverage below 97% on a new module | Missing edge case test | Add targeted unit test for the uncovered branch |
| Biome lint warning (becomes error in CI) | Unused import / explicit any | Remove import or narrow type |
| Type error in QueueWorker dispatch | `cursor` shape mismatch between Copilot CLI and Copilot Chat readers | Add a type guard or shape adapter at the dispatch site |
| VS Code panel test asserting old wording | Description text changed in Task 15 | Update assertion to new wording |

- [ ] **Step 2: Run any patch-up edits**

For each failure observed in Step 1, apply the targeted fix and re-run `npm run all` until clean.

- [ ] **Step 3: Final commit (only if any fix-up changes were made in Step 2)**

```bash
git add -A
git commit -s -m "Patch up coverage / lint / type gaps for Copilot Chat support"
```

If no fix-up was needed, skip this commit.

- [ ] **Step 4: Verify git log**

Run: `git log --oneline -20`
Expected: a clean sequence of commits, each scoped to one task. No "WIP" / "fix" without context. The series should look like:

```
xxxxxxx Patch up coverage / lint / type gaps for Copilot Chat support  (optional)
xxxxxxx Show CLI/Chat form breakdown in jolli status output
xxxxxxx Add copilot-chat source to Summary panel rendering
xxxxxxx Update Copilot toggle description to mention CLI and Chat
xxxxxxx Show CLI/Chat form breakdown in Copilot status row
xxxxxxx Wire Copilot Chat reader into QueueWorker dispatch
xxxxxxx Wire Copilot Chat discovery into QueueWorker
xxxxxxx Surface Copilot Chat status in Installer.getStatus
xxxxxxx Wire Copilot Chat detection into Installer.install auto-enable
xxxxxxx Add CopilotChatSessionDiscoverer
xxxxxxx Add readCopilotChatTranscript matching TranscriptReadResult
xxxxxxx Add replayPatches for Copilot Chat JSONL
xxxxxxx Add patch path primitives for Copilot Chat reader
xxxxxxx Add copilot-chat to TranscriptSource and SessionTracker filter
xxxxxxx Add CopilotChatDetector
xxxxxxx Refactor CursorSessionDiscoverer to use VscodeWorkspaceLocator
xxxxxxx Refactor CursorDetector to use VscodeWorkspaceLocator
xxxxxxx Add VscodeWorkspaceLocator shared module
```

---

## Out of plan (NOT done here — listed for awareness)

These are flagged in the spec's "Out of scope" section. The plan does **not** include them:

- Multi-root `.code-workspace` workspace support
- VS Code Insiders / Code-OSS / fork support
- Live tail of in-progress sessions
- Reading `chatEditingSessions/`

If a follow-up plan is needed for any of these, write a new design doc + plan; do not stretch this one.
