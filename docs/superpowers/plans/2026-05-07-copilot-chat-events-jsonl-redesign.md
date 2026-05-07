# Copilot Chat events.jsonl Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `copilot-chat` source actually capture VS Code chat panel "New Chat" sessions by replacing the failed v1/v2 storage assumptions with two scans (`~/.copilot/session-state/<sid>/events.jsonl` for copilotcli-backend chat sessions, `<wsHash>/chatSessions/<sid>.jsonl` for non-copilotcli-backend chat sessions).

**Architecture:** Three modules in `cli/src/core/` are touched. `CopilotChatDetector` adds a second probe path. `CopilotChatSessionDiscoverer` is fully rewritten to scan two locations. `CopilotChatTranscriptReader` is refactored into a path-dispatching front door with two sub-readers — `readEventsJsonl` (new, line-based cursor) and `readPatchLog` (the existing `readCopilotChatTranscript` body, lifted unchanged + extended with `beforeTimestamp` gate). Existing helpers `_setAtPath` / `_deleteAtPath` / `_replayPatches` are reused unchanged. One line in `QueueWorker.ts` updates to pass `beforeTimestamp` to the reader. The standalone `copilot` source (`CopilotSessionDiscoverer` reading `session-store.db`) is **untouched** — it already covers the "New Copilot CLI Session" entry point (which is a vscode-spawned terminal running the `copilot` binary).

**Tech Stack:** TypeScript ESM, Vitest, biome (tabs, lineWidth 120), `node:fs/promises`, `node:readline`. Follows conventions of `CopilotSessionDiscoverer` / `CursorSessionDiscoverer` / existing test fixtures.

**Spec:** `docs/superpowers/specs/2026-05-07-copilot-chat-events-jsonl-redesign-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `cli/src/core/CopilotChatDetector.ts` | **Modify** | Detector for either Copilot Chat extension OR Copilot CLI agent backend on disk |
| `cli/src/core/CopilotChatDetector.test.ts` | **Rewrite** | Cover both probe paths and their failure modes |
| `cli/src/core/CopilotChatSessionDiscoverer.ts` | **Rewrite** | Two-scan discoverer (Scan A: events.jsonl + folderPath gate; Scan B: chatSessions/*.jsonl) |
| `cli/src/core/CopilotChatSessionDiscoverer.test.ts` | **Rewrite** | Both scans, dedup behavior, error channel |
| `cli/src/core/CopilotChatTranscriptReader.ts` | **Modify** | Dispatcher + readEventsJsonl + readPatchLog (lifted from current body) + `beforeTimestamp` gate. Helpers `_setAtPath`/`_deleteAtPath`/`_replayPatches` stay unchanged. |
| `cli/src/core/CopilotChatTranscriptReader.test.ts` | **Modify** | Keep helper tests, add dispatcher + sub-reader tests, update existing patch-log test cases for new signature |
| `cli/src/hooks/QueueWorker.ts` | **1-line modify** | Pass `beforeTimestamp` to `readCopilotChatTranscript` at line 1532 |
| `cli/src/hooks/QueueWorker.test.ts` | **No change** | Existing mocks of `discoverCopilotChatSessions` / `isCopilotChatInstalled` remain valid (signatures unchanged) |

---

## Pre-flight checks

- [ ] **Step 0.1: Verify clean working tree before starting**

Run: `cd /Users/flyer/jolli/code/jollimemory-worktrees/feature/change-storage-to-folder && git status --short`
Expected: empty output (clean tree). If not clean, stop and reconcile manually.

- [ ] **Step 0.2: Verify spec is committed**

Run: `git log --oneline -3 -- docs/superpowers/specs/2026-05-07-copilot-chat-events-jsonl-redesign-design.md`
Expected: at least one commit exists touching the spec file.

- [ ] **Step 0.3: Run baseline test + typecheck (record current pass count)**

Run: `npm run typecheck:cli && npm run test -w @jolli.ai/cli`
Expected: both succeed (or fail in known/baseline ways — capture the test count for regression comparison).

---

## Task 1: Modify `CopilotChatDetector` to probe two roots

**Why:** The current detector only checks `<userDataDir>/User/globalStorage/github.copilot-chat` (Copilot Chat extension installed). The new design needs the detector to also return true when the user has only the Copilot CLI agent backend on disk (`~/.copilot/session-state/`), since that path can carry vscode chat panel sessions even when the extension global storage is absent.

**Files:**
- Modify: `cli/src/core/CopilotChatDetector.ts`
- Test: `cli/src/core/CopilotChatDetector.test.ts` (rewrite)

- [ ] **Step 1.1: Open the test file and replace its contents with the new cases**

Replace **the entire file contents** with:

```typescript
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

	it("getCopilotCliSessionStateDir returns ~/.copilot/session-state path", async () => {
		const { getCopilotCliSessionStateDir } = await import("./CopilotChatDetector.js");
		expect(getCopilotCliSessionStateDir()).toBe("/Users/test/.copilot/session-state");
	});

	it("isCopilotChatInstalled returns true when ONLY globalStorage exists", async () => {
		vi.mocked(stat).mockImplementation(async (path) => {
			if (String(path).includes("globalStorage/github.copilot-chat")) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
			}
			throw Object.assign(new Error("no dir"), { code: "ENOENT" });
		});
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(true);
	});

	it("isCopilotChatInstalled returns true when ONLY ~/.copilot/session-state exists", async () => {
		vi.mocked(stat).mockImplementation(async (path) => {
			if (String(path).includes(".copilot/session-state")) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
			}
			throw Object.assign(new Error("no dir"), { code: "ENOENT" });
		});
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(true);
	});

	it("isCopilotChatInstalled returns true when BOTH paths exist", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(true);
	});

	it("isCopilotChatInstalled returns false when both paths missing", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("no dir"), { code: "ENOENT" }));
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});

	it("isCopilotChatInstalled returns false when path exists but is not a directory", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as Awaited<ReturnType<typeof stat>>);
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});

	it("isCopilotChatInstalled returns false on unexpected stat error and warn-logs", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("perm denied"), { code: "EACCES" }));
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `npx vitest run cli/src/core/CopilotChatDetector.test.ts`
Expected: 2 of the 8 cases fail — the new `getCopilotCliSessionStateDir` test fails with "is not a function", and the "ONLY ~/.copilot/session-state exists" case fails because the existing detector only checks globalStorage.

- [ ] **Step 1.3: Modify `CopilotChatDetector.ts`**

Replace **the entire file contents** with:

```typescript
/**
 * VS Code Copilot Chat detector.
 *
 * Returns true when EITHER of the two Copilot Chat data roots exist:
 *   - <userDataDir>/User/globalStorage/github.copilot-chat (Copilot Chat extension installed)
 *   - ~/.copilot/session-state                              (Copilot CLI agent backend on disk)
 *
 * Either root can carry chat panel "New Chat" session data; chat-panel sessions
 * with copilotcli-backend models write to the latter (events.jsonl), and
 * sessions with other-vendor models write to chatSessions/<sid>.jsonl under
 * the former's parent workspace storage tree.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { getVscodeUserDataDir } from "./VscodeWorkspaceLocator.js";

const log = createLogger("CopilotChatDetector");

/** Returns vscode's globalStorage/github.copilot-chat directory path. */
export function getCopilotChatStorageDir(home?: string): string {
	return join(getVscodeUserDataDir("Code", home), "User", "globalStorage", "github.copilot-chat");
}

/** Returns ~/.copilot/session-state directory path (Copilot CLI agent backend). */
export function getCopilotCliSessionStateDir(home: string = homedir()): string {
	return join(home, ".copilot", "session-state");
}

async function existsAsDir(path: string): Promise<boolean> {
	try {
		const fileStat = await stat(path);
		return fileStat.isDirectory();
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.warn("Copilot Chat probe stat failed for %s (%s): %s", path, code ?? "unknown", (error as Error).message);
		}
		return false;
	}
}

/**
 * Returns true when either of the two known Copilot Chat data roots exists.
 * Returns false on ENOENT or non-directory state for both.
 */
export async function isCopilotChatInstalled(): Promise<boolean> {
	const [globalStorage, sessionState] = await Promise.all([
		existsAsDir(getCopilotChatStorageDir()),
		existsAsDir(getCopilotCliSessionStateDir()),
	]);
	return globalStorage || sessionState;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `npx vitest run cli/src/core/CopilotChatDetector.test.ts`
Expected: all 8 cases PASS.

- [ ] **Step 1.5: Run typecheck + biome**

Run: `npm run typecheck:cli && npx biome check --error-on-warnings cli/src/core/CopilotChatDetector.ts cli/src/core/CopilotChatDetector.test.ts`
Expected: both succeed.

- [ ] **Step 1.6: Commit**

```bash
git add cli/src/core/CopilotChatDetector.ts cli/src/core/CopilotChatDetector.test.ts
git commit -s -m "$(cat <<'EOF'
feat(copilot-chat): probe both globalStorage and ~/.copilot/session-state

The detector now returns true when either Copilot Chat extension's
globalStorage or Copilot CLI agent backend's session-state directory
exists. This is the precondition for the discoverer to scan two
locations in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Lift existing reader body into `readPatchLog`, add dispatcher

**Why:** The current `readCopilotChatTranscript` body is exactly the patch-log sub-reader the new design needs. Lifting it into a private `readPatchLog` function and putting a thin dispatcher on top is a behavior-preserving refactor that sets the stage for adding `readEventsJsonl` next. We do this as its own task so that a regression at this point would clearly point at the refactor — not get tangled with new functionality.

**Files:**
- Modify: `cli/src/core/CopilotChatTranscriptReader.ts`
- Test: `cli/src/core/CopilotChatTranscriptReader.test.ts` (modify — add dispatcher tests, keep existing tests)

- [ ] **Step 2.1: Add a failing dispatcher test**

Append to `cli/src/core/CopilotChatTranscriptReader.test.ts` after the existing test blocks:

```typescript
describe("readCopilotChatTranscript dispatcher", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-chat-rdr-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("routes <wsHash>/chatSessions/<sid>.jsonl to patch-log reader (yields requests entries)", async () => {
		const wsDir = join(tmpRoot, "ws1", "chatSessions");
		mkdirSync(wsDir, { recursive: true });
		const path = join(wsDir, "abc123.jsonl");
		const lines = [
			JSON.stringify({ kind: 0, v: { requests: [] } }),
			JSON.stringify({
				kind: 1,
				k: ["requests", 0],
				v: { message: { text: "hello" }, response: [{ value: "world" }] },
			}),
		];
		writeFileSync(path, lines.join("\n"));
		const result = await readCopilotChatTranscript(path);
		expect(result.entries).toEqual([
			{ role: "human", content: "hello" },
			{ role: "assistant", content: "world" },
		]);
	});

	it("throws on an unrecognized path pattern", async () => {
		const path = join(tmpRoot, "random", "thing.txt");
		mkdirSync(join(tmpRoot, "random"), { recursive: true });
		writeFileSync(path, "{}");
		await expect(readCopilotChatTranscript(path)).rejects.toThrow(/unrecognized.*path/i);
	});
});
```

You also need to extend the existing top-of-file imports if `mkdirSync` / `mkdtempSync` / `rmSync` / `tmpdir` / `join` aren't already imported. Edit the existing import lines so they look like:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _deleteAtPath, _replayPatches, _setAtPath, readCopilotChatTranscript } from "./CopilotChatTranscriptReader.js";
```

- [ ] **Step 2.2: Run tests to confirm both new dispatcher cases fail**

Run: `npx vitest run cli/src/core/CopilotChatTranscriptReader.test.ts -t "dispatcher"`
Expected: 1st case "routes ... to patch-log reader" — likely passes by coincidence (current reader handles `.jsonl`); 2nd case "throws on an unrecognized path pattern" — FAILS because current reader doesn't validate path shape.

- [ ] **Step 2.3: Refactor `CopilotChatTranscriptReader.ts` — extract `readPatchLog`, add dispatcher**

Replace the existing `readCopilotChatTranscript` function (around lines 138–206 of the current file) with the following. **Keep `_setAtPath`, `_deleteAtPath`, `_replayPatches`, and `CopilotChatScanError` exactly as they are.** Below is the new content that replaces from `interface ChatRequest` to end of file:

```typescript
interface ChatRequest {
	message?: { text?: string };
	response?: ReadonlyArray<{ value?: string }>;
}

/**
 * Reads a `<wsHash>/chatSessions/<sid>.jsonl` patch log: replay all patches
 * into a final document, then emit TranscriptEntry records for `requests[i]`
 * where `i >= cursor.lineNumber`. The cursor's `lineNumber` field is repurposed
 * here as "request count already consumed" — it never exceeds `requests.length`
 * and only advances on successful emit.
 */
async function readPatchLog(
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

/**
 * Front door for Copilot Chat transcript reading. Dispatches to one of two
 * sub-readers based on the trailing path segments of `transcriptPath`:
 *
 *   - `<...>/.copilot/session-state/<sid>/events.jsonl` → readEventsJsonl (added in a later task)
 *   - `<...>/chatSessions/<sid>.jsonl`                 → readPatchLog
 *
 * Throws on an unrecognized path — the discoverer should never emit anything
 * else, so this is a defense-in-depth invariant.
 */
export async function readCopilotChatTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor,
): Promise<TranscriptReadResult> {
	const norm = transcriptPath.replace(/\\/g, "/");
	if (/\/chatSessions\/[^/]+\.jsonl$/.test(norm)) {
		return readPatchLog(transcriptPath, cursor);
	}
	throw new Error(`Copilot Chat reader: unrecognized transcriptPath pattern: ${transcriptPath}`);
}
```

- [ ] **Step 2.4: Run reader test file to verify all tests pass**

Run: `npx vitest run cli/src/core/CopilotChatTranscriptReader.test.ts`
Expected: ALL existing tests pass + the 2 new dispatcher tests pass. The existing patch-log behavior is preserved because the dispatcher routes the `chatSessions/<sid>.jsonl` shape to `readPatchLog`.

- [ ] **Step 2.5: Run typecheck + biome**

Run: `npm run typecheck:cli && npx biome check --error-on-warnings cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts`
Expected: both succeed.

- [ ] **Step 2.6: Commit**

```bash
git add cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts
git commit -s -m "$(cat <<'EOF'
refactor(copilot-chat): extract readPatchLog, add path dispatcher

Behavior-preserving refactor: lifts existing readCopilotChatTranscript
body into a private readPatchLog function and puts a thin dispatcher
on top that validates the path shape. Sets the stage for adding the
events.jsonl sub-reader in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `readEventsJsonl` sub-reader

**Why:** Vscode chat panel "New Chat" with copilotcli-backend models writes its conversation to `~/.copilot/session-state/<sid>/events.jsonl` — a per-line event stream where conversation lives in `type:"user.message"` and `type:"assistant.message"` events. The existing `copilot` source reads `session-store.db` and never sees these sessions; we need a dedicated reader.

**Files:**
- Modify: `cli/src/core/CopilotChatTranscriptReader.ts`
- Test: `cli/src/core/CopilotChatTranscriptReader.test.ts`

- [ ] **Step 3.1: Append failing tests for `readEventsJsonl` via the dispatcher**

Append to `cli/src/core/CopilotChatTranscriptReader.test.ts` after the existing dispatcher describe block:

```typescript
describe("readCopilotChatTranscript via events.jsonl path", () => {
	let tmpRoot: string;
	let sessionDir: string;
	let eventsPath: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-events-"));
		sessionDir = join(tmpRoot, ".copilot", "session-state", "sess-1");
		mkdirSync(sessionDir, { recursive: true });
		eventsPath = join(sessionDir, "events.jsonl");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function writeEvents(events: ReadonlyArray<unknown>): void {
		writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	}

	it("emits user.message and non-empty assistant.message in file order", async () => {
		writeEvents([
			{ type: "session.start", data: {}, timestamp: "2026-05-07T10:00:00.000Z" },
			{ type: "system.message", data: { content: "system prompt" }, timestamp: "2026-05-07T10:00:01.000Z" },
			{ type: "user.message", data: { content: "hi" }, timestamp: "2026-05-07T10:00:02.000Z" },
			{ type: "assistant.turn_start", data: {}, timestamp: "2026-05-07T10:00:03.000Z" },
			{ type: "assistant.message", data: { content: "hello there" }, timestamp: "2026-05-07T10:00:04.000Z" },
			{ type: "tool.execution_start", data: {}, timestamp: "2026-05-07T10:00:05.000Z" },
			{ type: "tool.execution_complete", data: {}, timestamp: "2026-05-07T10:00:06.000Z" },
			{ type: "assistant.turn_end", data: {}, timestamp: "2026-05-07T10:00:07.000Z" },
		]);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([
			{ role: "human", content: "hi", timestamp: "2026-05-07T10:00:02.000Z" },
			{ role: "assistant", content: "hello there", timestamp: "2026-05-07T10:00:04.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(8);
	});

	it("drops assistant.message with empty content (tool-only turn)", async () => {
		writeEvents([
			{ type: "user.message", data: { content: "do tool" }, timestamp: "2026-05-07T10:00:00.000Z" },
			{
				type: "assistant.message",
				data: { content: "", toolRequests: [{ name: "shell" }] },
				timestamp: "2026-05-07T10:00:01.000Z",
			},
			{ type: "assistant.message", data: { content: "ok done" }, timestamp: "2026-05-07T10:00:02.000Z" },
		]);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([
			{ role: "human", content: "do tool", timestamp: "2026-05-07T10:00:00.000Z" },
			{ role: "assistant", content: "ok done", timestamp: "2026-05-07T10:00:02.000Z" },
		]);
	});

	it("returns no entries when file contains only non-conversation events", async () => {
		writeEvents([
			{ type: "session.start", data: {} },
			{ type: "session.shutdown", data: {} },
		]);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([]);
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("advances past a malformed line and continues", async () => {
		writeFileSync(
			eventsPath,
			[
				JSON.stringify({ type: "user.message", data: { content: "before" }, timestamp: "2026-05-07T10:00:00.000Z" }),
				"{not valid json",
				JSON.stringify({ type: "assistant.message", data: { content: "after" }, timestamp: "2026-05-07T10:00:01.000Z" }),
			].join("\n") + "\n",
		);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([
			{ role: "human", content: "before", timestamp: "2026-05-07T10:00:00.000Z" },
			{ role: "assistant", content: "after", timestamp: "2026-05-07T10:00:01.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(3);
	});

	it("respects cursor.lineNumber as resume point", async () => {
		writeEvents([
			{ type: "user.message", data: { content: "old" }, timestamp: "2026-05-07T09:00:00.000Z" },
			{ type: "assistant.message", data: { content: "old reply" }, timestamp: "2026-05-07T09:00:01.000Z" },
			{ type: "user.message", data: { content: "new" }, timestamp: "2026-05-07T10:00:00.000Z" },
			{ type: "assistant.message", data: { content: "new reply" }, timestamp: "2026-05-07T10:00:01.000Z" },
		]);
		const result = await readCopilotChatTranscript(eventsPath, {
			transcriptPath: eventsPath,
			lineNumber: 2,
			updatedAt: "2026-05-07T09:30:00.000Z",
		});
		expect(result.entries).toEqual([
			{ role: "human", content: "new", timestamp: "2026-05-07T10:00:00.000Z" },
			{ role: "assistant", content: "new reply", timestamp: "2026-05-07T10:00:01.000Z" },
		]);
		expect(result.newCursor.lineNumber).toBe(4);
	});

	it("emits entries with timestamp:undefined when event has no timestamp", async () => {
		writeEvents([
			{ type: "user.message", data: { content: "no-ts" } },
			{ type: "assistant.message", data: { content: "also no-ts" } },
		]);
		const result = await readCopilotChatTranscript(eventsPath);
		expect(result.entries).toEqual([
			{ role: "human", content: "no-ts" },
			{ role: "assistant", content: "also no-ts" },
		]);
	});
});
```

- [ ] **Step 3.2: Run reader tests to confirm new tests fail**

Run: `npx vitest run cli/src/core/CopilotChatTranscriptReader.test.ts -t "via events.jsonl"`
Expected: all 6 new cases FAIL — they hit the dispatcher's "unrecognized path" throw because we haven't added the events.jsonl branch yet.

- [ ] **Step 3.3: Add `readEventsJsonl` and route the dispatcher to it**

Edit `cli/src/core/CopilotChatTranscriptReader.ts`. **Add this import at the top of the file** (alongside the existing `node:fs/promises` import):

```typescript
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
```

Then **insert this function above `readPatchLog`** (i.e. between `interface ChatRequest` and `async function readPatchLog`):

```typescript
interface EventsLineEvent {
	type?: string;
	timestamp?: string;
	data?: { content?: string };
}

/**
 * Reads `~/.copilot/session-state/<sid>/events.jsonl` line-by-line. Conversation
 * lives in `type:"user.message"` and non-empty `type:"assistant.message"`
 * events; everything else (session lifecycle, tool calls, assistant turn
 * boundaries, system prompts) is skipped. The cursor's `lineNumber` is the
 * standard "lines already consumed" semantics (first line is line 1).
 *
 * Per-line `JSON.parse` failures are skipped and the cursor still advances
 * past the bad line — matches the Claude / Codex / Gemini JSONL readers'
 * "one bad line never blocks the rest" policy.
 */
async function readEventsJsonl(
	transcriptPath: string,
	cursor?: TranscriptCursor,
): Promise<TranscriptReadResult> {
	const startLine = cursor?.lineNumber ?? 0;
	const stream = createReadStream(transcriptPath, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

	const entries: TranscriptEntry[] = [];
	let currentLine = 0;

	for await (const rawLine of rl) {
		currentLine++;
		if (currentLine <= startLine) continue;

		let evt: EventsLineEvent;
		try {
			evt = JSON.parse(rawLine) as EventsLineEvent;
		} catch {
			// skip malformed line, cursor still advances
			continue;
		}

		const content = evt.data?.content;
		if (typeof content !== "string" || content.length === 0) continue;

		if (evt.type === "user.message") {
			entries.push(evt.timestamp ? { role: "human", content, timestamp: evt.timestamp } : { role: "human", content });
		} else if (evt.type === "assistant.message") {
			entries.push(
				evt.timestamp ? { role: "assistant", content, timestamp: evt.timestamp } : { role: "assistant", content },
			);
		}
	}

	const updatedAt = await stat(transcriptPath).then((s) => new Date(s.mtimeMs).toISOString());
	return {
		entries,
		newCursor: { transcriptPath, lineNumber: currentLine, updatedAt },
		totalLinesRead: currentLine - startLine,
	};
}
```

Then **modify the dispatcher** (the `readCopilotChatTranscript` function added in Task 2) to route to the new sub-reader. Replace its body with:

```typescript
export async function readCopilotChatTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor,
): Promise<TranscriptReadResult> {
	const norm = transcriptPath.replace(/\\/g, "/");
	if (/\/\.copilot\/session-state\/[^/]+\/events\.jsonl$/.test(norm)) {
		return readEventsJsonl(transcriptPath, cursor);
	}
	if (/\/chatSessions\/[^/]+\.jsonl$/.test(norm)) {
		return readPatchLog(transcriptPath, cursor);
	}
	throw new Error(`Copilot Chat reader: unrecognized transcriptPath pattern: ${transcriptPath}`);
}
```

- [ ] **Step 3.4: Run all reader tests to verify they pass**

Run: `npx vitest run cli/src/core/CopilotChatTranscriptReader.test.ts`
Expected: ALL tests pass — 6 new events.jsonl cases + 2 dispatcher cases + all preexisting helper / patch-log cases.

- [ ] **Step 3.5: Run typecheck + biome**

Run: `npm run typecheck:cli && npx biome check --error-on-warnings cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts`
Expected: both succeed.

- [ ] **Step 3.6: Commit**

```bash
git add cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts
git commit -s -m "$(cat <<'EOF'
feat(copilot-chat): add events.jsonl sub-reader for chat panel sessions

Adds readEventsJsonl, routed by the dispatcher when transcriptPath
matches ~/.copilot/session-state/<sid>/events.jsonl. Emits
user.message and non-empty assistant.message events; skips system
prompts, tool calls, and turn boundaries. Per-line JSON.parse
failures are skipped (cursor still advances), matching other JSONL
readers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add `beforeTimestamp` gate to both sub-readers

**Why:** Every other discovery-based source reader (`readGeminiTranscript`, `readCopilotTranscript`, `readCursorTranscript`, `readOpenCodeTranscript`) accepts a `beforeTimestamp` parameter so the QueueWorker can attribute transcript entries to the correct commit (entries with timestamp > cutoff are deferred to the next commit). The Copilot Chat reader has been the odd one out. Adding the gate brings it in line with the rest of the source pipeline.

**Files:**
- Modify: `cli/src/core/CopilotChatTranscriptReader.ts`
- Test: `cli/src/core/CopilotChatTranscriptReader.test.ts`

- [ ] **Step 4.1: Add failing tests for `beforeTimestamp` on both sub-readers**

Append to `cli/src/core/CopilotChatTranscriptReader.test.ts`:

```typescript
describe("readCopilotChatTranscript beforeTimestamp gate", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-cutoff-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("events.jsonl: stops at first event whose timestamp > beforeTimestamp without consuming it", async () => {
		const sessionDir = join(tmpRoot, ".copilot", "session-state", "s1");
		mkdirSync(sessionDir, { recursive: true });
		const path = join(sessionDir, "events.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({ type: "user.message", data: { content: "early" }, timestamp: "2026-05-07T09:00:00.000Z" }),
				JSON.stringify({
					type: "assistant.message",
					data: { content: "early reply" },
					timestamp: "2026-05-07T09:00:30.000Z",
				}),
				JSON.stringify({ type: "user.message", data: { content: "late" }, timestamp: "2026-05-07T11:00:00.000Z" }),
			].join("\n") + "\n",
		);
		const result = await readCopilotChatTranscript(path, undefined, "2026-05-07T10:00:00.000Z");
		expect(result.entries).toEqual([
			{ role: "human", content: "early", timestamp: "2026-05-07T09:00:00.000Z" },
			{ role: "assistant", content: "early reply", timestamp: "2026-05-07T09:00:30.000Z" },
		]);
		// Cursor must NOT advance past the unconsumed late line — it sits at line 2.
		expect(result.newCursor.lineNumber).toBe(2);
	});

	it("events.jsonl: events without timestamp are emitted (treated as before-cutoff)", async () => {
		const sessionDir = join(tmpRoot, ".copilot", "session-state", "s2");
		mkdirSync(sessionDir, { recursive: true });
		const path = join(sessionDir, "events.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({ type: "user.message", data: { content: "untimed" } }),
				JSON.stringify({ type: "assistant.message", data: { content: "untimed reply" } }),
			].join("\n") + "\n",
		);
		const result = await readCopilotChatTranscript(path, undefined, "2026-05-07T10:00:00.000Z");
		expect(result.entries.length).toBe(2);
	});

	it("patch log: stops emitting at first request whose timestamp > beforeTimestamp without advancing cursor past it", async () => {
		const wsDir = join(tmpRoot, "ws1", "chatSessions");
		mkdirSync(wsDir, { recursive: true });
		const path = join(wsDir, "p1.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({ kind: 0, v: { requests: [] } }),
				JSON.stringify({
					kind: 1,
					k: ["requests", 0],
					v: {
						message: { text: "early" },
						response: [{ value: "early reply" }],
						timestamp: Date.parse("2026-05-07T09:00:00.000Z"),
					},
				}),
				JSON.stringify({
					kind: 1,
					k: ["requests", 1],
					v: {
						message: { text: "late" },
						response: [{ value: "late reply" }],
						timestamp: Date.parse("2026-05-07T11:00:00.000Z"),
					},
				}),
			].join("\n"),
		);
		const result = await readCopilotChatTranscript(path, undefined, "2026-05-07T10:00:00.000Z");
		expect(result.entries).toEqual([
			{ role: "human", content: "early" },
			{ role: "assistant", content: "early reply" },
		]);
		// Cursor stays at requests[1] so the next read picks up "late".
		expect(result.newCursor.lineNumber).toBe(1);
	});

	it("patch log: requests without numeric timestamp are emitted (treated as before-cutoff)", async () => {
		const wsDir = join(tmpRoot, "ws1", "chatSessions");
		mkdirSync(wsDir, { recursive: true });
		const path = join(wsDir, "p2.jsonl");
		writeFileSync(
			path,
			[
				JSON.stringify({ kind: 0, v: { requests: [] } }),
				JSON.stringify({
					kind: 1,
					k: ["requests", 0],
					v: { message: { text: "no-ts" }, response: [{ value: "no-ts reply" }] },
				}),
			].join("\n"),
		);
		const result = await readCopilotChatTranscript(path, undefined, "2026-05-07T10:00:00.000Z");
		expect(result.entries.length).toBe(2);
	});
});
```

- [ ] **Step 4.2: Run tests to confirm new cases fail**

Run: `npx vitest run cli/src/core/CopilotChatTranscriptReader.test.ts -t "beforeTimestamp"`
Expected: all 4 cases fail — current `readCopilotChatTranscript` only accepts 2 parameters (`transcriptPath`, `cursor`).

- [ ] **Step 4.3: Update the dispatcher signature, propagate `beforeTimestamp` to both sub-readers**

In `cli/src/core/CopilotChatTranscriptReader.ts`:

Change the dispatcher's signature and body to:

```typescript
export async function readCopilotChatTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const norm = transcriptPath.replace(/\\/g, "/");
	if (/\/\.copilot\/session-state\/[^/]+\/events\.jsonl$/.test(norm)) {
		return readEventsJsonl(transcriptPath, cursor, beforeTimestamp);
	}
	if (/\/chatSessions\/[^/]+\.jsonl$/.test(norm)) {
		return readPatchLog(transcriptPath, cursor, beforeTimestamp);
	}
	throw new Error(`Copilot Chat reader: unrecognized transcriptPath pattern: ${transcriptPath}`);
}
```

Modify `readEventsJsonl`'s signature to accept `beforeTimestamp` and gate the loop. Replace the existing function body with:

```typescript
async function readEventsJsonl(
	transcriptPath: string,
	cursor?: TranscriptCursor,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const startLine = cursor?.lineNumber ?? 0;
	const stream = createReadStream(transcriptPath, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

	const entries: TranscriptEntry[] = [];
	let currentLine = 0;
	let cutoffHit = false;

	for await (const rawLine of rl) {
		currentLine++;
		if (currentLine <= startLine) continue;
		if (cutoffHit) {
			// Once the cutoff has been hit we stop counting AND don't advance cursor.
			currentLine--; // undo the increment so cursor reflects last consumed
			break;
		}

		let evt: EventsLineEvent;
		try {
			evt = JSON.parse(rawLine) as EventsLineEvent;
		} catch {
			continue;
		}

		// beforeTimestamp gate: events with timestamp > cutoff are deferred.
		if (beforeTimestamp && typeof evt.timestamp === "string" && evt.timestamp > beforeTimestamp) {
			cutoffHit = true;
			currentLine--; // do not consume this line
			break;
		}

		const content = evt.data?.content;
		if (typeof content !== "string" || content.length === 0) continue;

		if (evt.type === "user.message") {
			entries.push(evt.timestamp ? { role: "human", content, timestamp: evt.timestamp } : { role: "human", content });
		} else if (evt.type === "assistant.message") {
			entries.push(
				evt.timestamp ? { role: "assistant", content, timestamp: evt.timestamp } : { role: "assistant", content },
			);
		}
	}

	stream.close();
	const updatedAt = await stat(transcriptPath).then((s) => new Date(s.mtimeMs).toISOString());
	return {
		entries,
		newCursor: { transcriptPath, lineNumber: currentLine, updatedAt },
		totalLinesRead: Math.max(0, currentLine - startLine),
	};
}
```

Modify `readPatchLog`'s signature similarly, and gate the request loop. Replace the function body with:

```typescript
async function readPatchLog(
	transcriptPath: string,
	cursor?: TranscriptCursor,
	beforeTimestamp?: string,
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

	const cutoffMs = beforeTimestamp ? Date.parse(beforeTimestamp) : Number.POSITIVE_INFINITY;
	const entries: TranscriptEntry[] = [];
	let lastEmittedIdx = fromIdx;

	for (let i = fromIdx; i < requests.length; i++) {
		const req = requests[i] as ChatRequest & { timestamp?: number };
		// beforeTimestamp gate: stop without advancing cursor past this request.
		if (typeof req?.timestamp === "number" && req.timestamp > cutoffMs) {
			break;
		}
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
		lastEmittedIdx = i + 1;
	}

	const updatedAt = await stat(transcriptPath).then((s) => new Date(s.mtimeMs).toISOString());
	return {
		entries,
		newCursor: { transcriptPath, lineNumber: lastEmittedIdx, updatedAt },
		totalLinesRead: lines.length,
	};
}
```

- [ ] **Step 4.4: Run all reader tests to confirm everything passes**

Run: `npx vitest run cli/src/core/CopilotChatTranscriptReader.test.ts`
Expected: all tests pass — including the 4 new beforeTimestamp tests AND every previously passing test (no regressions).

- [ ] **Step 4.5: Run typecheck + biome**

Run: `npm run typecheck:cli && npx biome check --error-on-warnings cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts`
Expected: both succeed.

- [ ] **Step 4.6: Commit**

```bash
git add cli/src/core/CopilotChatTranscriptReader.ts cli/src/core/CopilotChatTranscriptReader.test.ts
git commit -s -m "$(cat <<'EOF'
feat(copilot-chat): add beforeTimestamp gate to events.jsonl + patch-log readers

Brings copilot-chat reader in line with every other discovery-based
source: when the QueueWorker passes a commit-time cutoff, the reader
stops at the first entry past that cutoff and does NOT advance the
cursor past it. The deferred entry is re-read at the next commit and
attributed to the correct commit boundary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Rewrite `CopilotChatSessionDiscoverer` for two scans

**Why:** The current discoverer scans `<wsHash>/GitHub.copilot-chat/debug-logs/<sid>/main.jsonl` (OpenTelemetry traces — not conversation) as the primary path with `chatSessions/<sid>.jsonl` as fallback. The new design replaces this with two independent scans: Scan A reads `~/.copilot/session-state/<sid>/events.jsonl` filtered by `vscode.metadata.json.workspaceFolder.folderPath === cwd` (covers chat panel "New Chat" with copilotcli-backend models); Scan B reads `<wsHash>/chatSessions/<sid>.jsonl` (covers chat panel "New Chat" with non-copilotcli-backend models). Both scans run in sequence, results concatenated, errors reported via the existing `CopilotChatScanError` channel.

**Files:**
- Rewrite: `cli/src/core/CopilotChatSessionDiscoverer.ts`
- Rewrite: `cli/src/core/CopilotChatSessionDiscoverer.test.ts`

- [ ] **Step 5.1: Replace test file contents with the new test plan**

Replace **the entire contents of `cli/src/core/CopilotChatSessionDiscoverer.test.ts`** with:

```typescript
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

	// ─── Scan A helpers (events.jsonl in ~/.copilot/session-state/<sid>/) ──────
	function makeSessionStateEntry(opts: {
		sid: string;
		folderPath?: string | null; // null ⇒ omit field; undefined ⇒ no metadata file at all
		omitMetadata?: boolean;
		omitEvents?: boolean;
		ageHours?: number;
	}): string {
		const dir = join(tmpRoot, ".copilot", "session-state", opts.sid);
		mkdirSync(dir, { recursive: true });
		if (!opts.omitMetadata) {
			const meta: Record<string, unknown> = { origin: opts.folderPath ? "vscode" : "other" };
			if (opts.folderPath !== null && opts.folderPath !== undefined) {
				meta.workspaceFolder = { folderPath: opts.folderPath };
			} else if (opts.folderPath === null) {
				meta.workspaceFolder = { folderPath: "" };
			}
			writeFileSync(join(dir, "vscode.metadata.json"), JSON.stringify(meta));
		}
		const eventsPath = join(dir, "events.jsonl");
		if (!opts.omitEvents) {
			writeFileSync(eventsPath, JSON.stringify({ type: "session.start", data: {} }) + "\n");
			if (opts.ageHours !== undefined) {
				const targetSec = (Date.now() - opts.ageHours * 3600 * 1000) / 1000;
				utimesSync(eventsPath, targetSec, targetSec);
			}
		}
		return eventsPath;
	}

	// ─── Scan B helpers (<wsHash>/chatSessions/<sid>.jsonl) ────────────────────
	function makeWorkspace(wsHash: string, folderUri: string): string {
		const wsDir = join(tmpRoot, "Library", "Application Support", "Code", "User", "workspaceStorage", wsHash);
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(join(wsDir, "workspace.json"), JSON.stringify({ folder: folderUri }));
		return wsDir;
	}

	function makeChatSessionsFile(wsDir: string, name: string, ageHours: number): string {
		const dir = join(wsDir, "chatSessions");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, name);
		writeFileSync(path, JSON.stringify({ kind: 0, v: { requests: [] } }));
		const targetSec = (Date.now() - ageHours * 3600 * 1000) / 1000;
		utimesSync(path, targetSec, targetSec);
		return path;
	}

	// ─── Scan A (events.jsonl) ─────────────────────────────────────────────────
	it("returns empty when neither root exists", async () => {
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("Scan A: returns empty when session-state exists but is empty", async () => {
		mkdirSync(join(tmpRoot, ".copilot", "session-state"), { recursive: true });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan A: emits a session whose folderPath matches projectDir and events.jsonl is fresh", async () => {
		const eventsPath = makeSessionStateEntry({ sid: "s-match", folderPath: projectDir, ageHours: 1 });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]).toMatchObject({
			sessionId: "s-match",
			source: "copilot-chat",
			transcriptPath: eventsPath,
		});
	});

	it("Scan A: skips folderPath empty string (CLI standalone marker)", async () => {
		makeSessionStateEntry({ sid: "s-empty", folderPath: null, ageHours: 1 });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan A: skips when vscode.metadata.json is missing", async () => {
		makeSessionStateEntry({ sid: "s-nometa", omitMetadata: true, ageHours: 1 });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan A: skips when vscode.metadata.json is malformed", async () => {
		const dir = join(tmpRoot, ".copilot", "session-state", "s-bad");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "vscode.metadata.json"), "{not json");
		writeFileSync(join(dir, "events.jsonl"), "");
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan A: skips when folderPath does not match projectDir", async () => {
		makeSessionStateEntry({ sid: "s-other", folderPath: "/some/other/dir", ageHours: 1 });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan A: matches across case difference on macOS (normalizePathForMatch)", async () => {
		makeSessionStateEntry({ sid: "s-case", folderPath: projectDir.toUpperCase(), ageHours: 1 });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toHaveLength(1);
	});

	it("Scan A: matches across trailing slash difference", async () => {
		makeSessionStateEntry({ sid: "s-slash", folderPath: `${projectDir}/`, ageHours: 1 });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toHaveLength(1);
	});

	it("Scan A: skips when events.jsonl missing", async () => {
		makeSessionStateEntry({ sid: "s-noev", folderPath: projectDir, omitEvents: true });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan A: skips events.jsonl older than 48h", async () => {
		makeSessionStateEntry({ sid: "s-stale", folderPath: projectDir, ageHours: 72 });
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	// ─── Scan B (chatSessions/) ────────────────────────────────────────────────
	it("Scan B: returns empty when no workspaceStorage entry matches projectDir", async () => {
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan B: returns empty when workspace exists but chatSessions/ is missing", async () => {
		makeWorkspace("ws1", `file://${projectDir}`);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan B: emits fresh .jsonl session", async () => {
		const ws = makeWorkspace("ws1", `file://${projectDir}`);
		const path = makeChatSessionsFile(ws, "fresh.jsonl", 1);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]).toMatchObject({
			sessionId: "fresh",
			source: "copilot-chat",
			transcriptPath: path,
		});
	});

	it("Scan B: explicitly skips deprecated .json snapshot files", async () => {
		const ws = makeWorkspace("ws1", `file://${projectDir}`);
		makeChatSessionsFile(ws, "deprecated.json", 1);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan B: skips files older than 48h", async () => {
		const ws = makeWorkspace("ws1", `file://${projectDir}`);
		makeChatSessionsFile(ws, "stale.jsonl", 72);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan B: skips irrelevant suffixes (.tmp, .log)", async () => {
		const ws = makeWorkspace("ws1", `file://${projectDir}`);
		makeChatSessionsFile(ws, "junk.tmp", 1);
		makeChatSessionsFile(ws, "junk.log", 1);
		makeChatSessionsFile(ws, "real.jsonl", 1);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions.map((s) => s.sessionId)).toEqual(["real"]);
	});

	// ─── Combined ──────────────────────────────────────────────────────────────
	it("Combined: emits sessions from both scans", async () => {
		makeSessionStateEntry({ sid: "ev-1", folderPath: projectDir, ageHours: 1 });
		const ws = makeWorkspace("ws1", `file://${projectDir}`);
		makeChatSessionsFile(ws, "patch-1.jsonl", 1);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toHaveLength(2);
		const ids = result.sessions.map((s) => s.sessionId).sort();
		expect(ids).toEqual(["ev-1", "patch-1"]);
	});

	it("Combined: same sid in both scans is emitted twice (no dedup, by design)", async () => {
		makeSessionStateEntry({ sid: "shared", folderPath: projectDir, ageHours: 1 });
		const ws = makeWorkspace("ws1", `file://${projectDir}`);
		makeChatSessionsFile(ws, "shared.jsonl", 1);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toHaveLength(2);
	});
});

describe("discoverCopilotChatSessions", () => {
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

	it("strips error channel and returns array directly", async () => {
		const { discoverCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await discoverCopilotChatSessions(projectDir);
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([]);
	});
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `npx vitest run cli/src/core/CopilotChatSessionDiscoverer.test.ts`
Expected: many failures — current discoverer's `scanSessionsDir` signature returns `SessionInfo[] | { error }` and the path layout it scans is `GitHub.copilot-chat/debug-logs/...`, not the new locations. The test file fixtures don't write that path, so old discoverer returns 0 sessions across the board.

- [ ] **Step 5.3: Replace `CopilotChatSessionDiscoverer.ts` with the new implementation**

Replace **the entire contents of `cli/src/core/CopilotChatSessionDiscoverer.ts`** with:

```typescript
/**
 * VS Code Copilot Chat session discoverer.
 *
 * Two scans run in sequence; results are concatenated:
 *
 *   Scan A — chat panel "New Chat" with copilotcli-backend models:
 *     ~/.copilot/session-state/<sid>/events.jsonl
 *     gated by vscode.metadata.json.workspaceFolder.folderPath === projectDir
 *
 *   Scan B — chat panel "New Chat" with non-copilotcli-backend models:
 *     <userDataDir>/User/workspaceStorage/<wsHash>/chatSessions/<sid>.jsonl
 *     wsHash resolved via VscodeWorkspaceLocator from projectDir
 *
 * Sessions older than 48h are excluded (matches every other discovery-based
 * source: OpenCode / Cursor / Copilot CLI). The deprecated .json snapshot
 * format is explicitly NOT read — see spec for rationale.
 *
 * The standalone `copilot` source (CopilotSessionDiscoverer reading
 * session-store.db) covers the "New Copilot CLI Session" entry point, which
 * is just a vscode-spawned terminal running the copilot binary.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import type { CopilotChatScanError } from "./CopilotChatTranscriptReader.js";
import {
	findVscodeWorkspaceHash,
	getVscodeWorkspaceStorageDir,
	normalizePathForMatch,
} from "./VscodeWorkspaceLocator.js";

const log = createLogger("CopilotChatDiscoverer");

const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export type { CopilotChatScanError };

export interface CopilotChatScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: CopilotChatScanError;
}

interface VscodeMetadata {
	workspaceFolder?: { folderPath?: string };
}

/**
 * Scan A: ~/.copilot/session-state/<sid>/events.jsonl gated by folderPath.
 * Returns sessions and an optional error when readdir of the root fails for
 * non-ENOENT reasons.
 */
async function scanSessionState(projectDir: string): Promise<CopilotChatScanResult> {
	const root = join(homedir(), ".copilot", "session-state");
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		log.error("readdir %s failed (%s): %s", root, code ?? "unknown", (error as Error).message);
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const target = normalizePathForMatch(projectDir);
	const sessions: SessionInfo[] = [];

	for (const sid of entries) {
		const sessionDir = join(root, sid);
		const metaPath = join(sessionDir, "vscode.metadata.json");
		const eventsPath = join(sessionDir, "events.jsonl");

		let meta: VscodeMetadata;
		try {
			meta = JSON.parse(await readFile(metaPath, "utf8")) as VscodeMetadata;
		} catch (error: unknown) {
			log.debug("Skipping %s: vscode.metadata.json read/parse failed (%s)", sid, (error as Error).message);
			continue;
		}

		const folderPath = meta.workspaceFolder?.folderPath;
		if (typeof folderPath !== "string" || folderPath.length === 0) continue;
		if (normalizePathForMatch(folderPath) !== target) continue;

		let mtimeMs: number;
		try {
			mtimeMs = (await stat(eventsPath)).mtimeMs;
		} catch (error: unknown) {
			log.debug("Skipping %s: events.jsonl stat failed (%s)", sid, (error as Error).message);
			continue;
		}
		if (mtimeMs < cutoffMs) continue;

		sessions.push({
			sessionId: sid,
			transcriptPath: eventsPath,
			updatedAt: new Date(mtimeMs).toISOString(),
			source: "copilot-chat",
		});
	}

	return { sessions };
}

/**
 * Scan B: <wsHash>/chatSessions/<sid>.jsonl. Skips .json snapshot files
 * (deprecated). Returns sessions and an optional error on non-ENOENT readdir
 * failure.
 */
async function scanChatSessions(projectDir: string): Promise<CopilotChatScanResult> {
	const wsHash = await findVscodeWorkspaceHash("Code", projectDir);
	if (wsHash === null) {
		log.debug("No vscode workspace matched %s", projectDir);
		return { sessions: [] };
	}
	const dir = join(getVscodeWorkspaceStorageDir("Code"), wsHash, "chatSessions");

	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		log.error("readdir %s failed (%s): %s", dir, code ?? "unknown", (error as Error).message);
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const sessions: SessionInfo[] = [];

	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue; // skip .json snapshots and other suffixes
		const path = join(dir, entry);
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(path)).mtimeMs;
		} catch (error: unknown) {
			log.debug("Skipping %s: stat failed (%s)", entry, (error as Error).message);
			continue;
		}
		if (mtimeMs < cutoffMs) continue;
		const sessionId = entry.slice(0, -".jsonl".length);
		sessions.push({
			sessionId,
			transcriptPath: path,
			updatedAt: new Date(mtimeMs).toISOString(),
			source: "copilot-chat",
		});
	}

	return { sessions };
}

/**
 * Runs Scan A then Scan B; concatenates sessions; returns the first error
 * encountered (subsequent are debug-logged).
 */
export async function scanCopilotChatSessions(projectDir: string): Promise<CopilotChatScanResult> {
	const a = await scanSessionState(projectDir);
	const b = await scanChatSessions(projectDir);
	const sessions = [...a.sessions, ...b.sessions];
	const error = a.error ?? b.error;
	if (a.error && b.error) {
		log.debug("Both scans errored; reporting Scan A's: %s", b.error.message);
	}
	if (sessions.length > 0) {
		log.info("Discovered %d Copilot Chat session(s) for %s", sessions.length, projectDir);
	}
	return { sessions, error };
}

/** Convenience wrapper used by QueueWorker — strips the error channel. */
export async function discoverCopilotChatSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanCopilotChatSessions(projectDir);
	if (error) {
		log.warn("Copilot Chat scan error (%s) — sessions excluded from this run: %s", error.kind, error.message);
	}
	return sessions;
}
```

- [ ] **Step 5.4: Run discoverer tests to verify they pass**

Run: `npx vitest run cli/src/core/CopilotChatSessionDiscoverer.test.ts`
Expected: all tests pass.

- [ ] **Step 5.5: Run typecheck + biome**

Run: `npm run typecheck:cli && npx biome check --error-on-warnings cli/src/core/CopilotChatSessionDiscoverer.ts cli/src/core/CopilotChatSessionDiscoverer.test.ts`
Expected: both succeed.

- [ ] **Step 5.6: Commit**

```bash
git add cli/src/core/CopilotChatSessionDiscoverer.ts cli/src/core/CopilotChatSessionDiscoverer.test.ts
git commit -s -m "$(cat <<'EOF'
feat(copilot-chat): rewrite discoverer with two-scan design

Scan A reads ~/.copilot/session-state/<sid>/events.jsonl, gated by
vscode.metadata.json.workspaceFolder.folderPath matching projectDir.
This covers chat panel sessions backed by the Copilot CLI agent.

Scan B reads <wsHash>/chatSessions/<sid>.jsonl (deprecated .json
snapshots are explicitly skipped). This covers chat panel sessions
backed by direct OpenAI/Anthropic API models.

The legacy debug-logs/main.jsonl scan is gone — those files were
OpenTelemetry traces, not conversation content.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire `beforeTimestamp` into the QueueWorker call site

**Why:** Task 4 added a `beforeTimestamp` parameter to the reader so the QueueWorker can attribute entries to the correct commit boundary. Now we feed the existing `beforeTimestamp` value (already in scope at the call site) to the reader.

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts` (1 line)

- [ ] **Step 6.1: Confirm the line still reads as expected**

Run: `sed -n '1530,1535p' cli/src/hooks/QueueWorker.ts`
Expected output includes the line:
```
				result = await readCopilotChatTranscript(session.transcriptPath, cursor ?? undefined);
```

- [ ] **Step 6.2: Edit the line to pass `beforeTimestamp`**

Use the Edit tool. In `cli/src/hooks/QueueWorker.ts`, change:

```typescript
result = await readCopilotChatTranscript(session.transcriptPath, cursor ?? undefined);
```

To:

```typescript
result = await readCopilotChatTranscript(session.transcriptPath, cursor ?? undefined, beforeTimestamp);
```

- [ ] **Step 6.3: Run typecheck + biome on the QueueWorker**

Run: `npm run typecheck:cli && npx biome check --error-on-warnings cli/src/hooks/QueueWorker.ts`
Expected: both succeed.

- [ ] **Step 6.4: Run the QueueWorker test suite to verify no regressions**

Run: `npx vitest run cli/src/hooks/QueueWorker.test.ts`
Expected: all tests pass. The existing mocks in QueueWorker.test.ts (lines 153–158: `discoverCopilotChatSessions: vi.fn().mockResolvedValue([])`, `isCopilotChatInstalled: vi.fn().mockResolvedValue(false)`) keep working because the function signatures are unchanged from the QueueWorker's perspective.

- [ ] **Step 6.5: Commit**

```bash
git add cli/src/hooks/QueueWorker.ts
git commit -s -m "$(cat <<'EOF'
feat(copilot-chat): pass beforeTimestamp to chat reader at QueueWorker call site

Lets the reader gate entries past the per-commit cutoff so they are
re-read at the next commit, matching every other source's attribution
semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Run the full CLI test+typecheck+lint sweep

**Why:** Catch any cross-module regressions one consolidated check.

- [ ] **Step 7.1: Run the full cli workspace test + typecheck + lint**

Run: `npm run typecheck:cli && npm run lint -w @jolli.ai/cli && npm run test -w @jolli.ai/cli`
Expected: all green. Coverage threshold (97% statements / 96% branches / 97% functions / 97% lines) holds.

- [ ] **Step 7.2: If coverage dipped below threshold, investigate**

If `npm run test -w @jolli.ai/cli` reports a coverage failure:
1. Identify the file/function whose coverage dropped.
2. Add a test case for the uncovered branch in the relevant `*.test.ts` (typically a not-yet-tested error branch in the discoverer or reader).
3. Re-run Step 7.1.
4. Once green, commit the test addition with a `test(copilot-chat): cover <branch>` message.

- [ ] **Step 7.3: If everything passed without changes, no commit needed**

Move on to Task 8.

---

## Task 8: Build the CLI dist + verify on real machine

**Why:** All preceding tasks operate on source. The QueueWorker that runs at `git commit` time uses whichever dist the resolver picks (currently `~/.vscode/extensions/jolli.jollimemory-vscode-0.98.20/dist`, version-resolved). To verify the redesign works end-to-end we need a local build that the resolver will pick up, and then a fresh non-squash commit + manual inspection of the orphan-branch transcript.

- [ ] **Step 8.1: Build the cli dist that dist-paths/cli will pick up**

Run: `npm run build:cli`
Expected: `cli/dist/QueueWorker.js` is rewritten with mtime in the last few seconds. Verify with: `ls -la cli/dist/QueueWorker.js`.

- [ ] **Step 8.2: Bump cli/package.json version so the resolver picks it over the installed vscode extension**

The resolver picks the highest semver across `~/.jolli/jollimemory/dist-paths/*`. The installed vscode extension is currently `0.98.20`. Bump cli to `0.98.21` so this build wins.

Edit `cli/package.json`, find the line `"version": "0.98.0"` (or whatever the current local cli version is), and change it to `"version": "0.98.21"`.

Then re-run the build to make sure dist-paths/cli is updated:

Run: `npm run build:cli`

Verify the resolver now points at the local cli dist:

Run: `~/.jolli/jollimemory/resolve-dist-path`
Expected: prints `<absolute path>/cli/dist`.

- [ ] **Step 8.3: Verify the new dist contains the new code**

Run: `grep -c "session-state\|readEventsJsonl\|chatSessions" cli/dist/QueueWorker.js cli/dist/CopilotChatSessionDiscoverer.js cli/dist/CopilotChatTranscriptReader.js 2>/dev/null || true`
Expected: at least one nonzero count per file (the dist genuinely contains the new strings).

Note: depending on esbuild bundling settings, the QueueWorker.js bundle may inline the discoverer/reader contents and there may not be separate files — that's fine. The string check on `QueueWorker.js` alone is sufficient.

- [ ] **Step 8.4: Make a real non-squash commit on this branch to exercise the pipeline**

Make any small change in the worktree (e.g. add a one-line comment to a file), then commit normally:

Run:
```bash
echo "" >> docs/superpowers/specs/2026-05-07-copilot-chat-events-jsonl-redesign-design.md
git add docs/superpowers/specs/2026-05-07-copilot-chat-events-jsonl-redesign-design.md
git commit -s -m "test: trigger queue worker to verify copilot-chat capture"
```

Wait ~30 seconds for the QueueWorker to finish processing (it runs detached after post-commit).

- [ ] **Step 8.5: Inspect the orphan-branch transcript for the new commit**

Run:
```bash
NEW=$(git rev-parse HEAD)
echo "checking transcripts/$NEW.json"
git show "jollimemory/summaries/v3:transcripts/$NEW.json" 2>&1 | python3 -c "
import sys, json
try:
  data = json.load(sys.stdin)
  print(f'sessions count: {len(data.get(\"sessions\", []))}')
  for sess in data.get('sessions', []):
    print(f\"  source={sess.get('source')!r}, sessionId={sess.get('sessionId')[:12]!r}, entries={len(sess.get('entries', []))}\")
except Exception as e:
  print(f'(no transcript or parse error: {e})')
"
```

Expected: at least one session with `source='copilot-chat'` (in addition to whatever `claude` / `copilot` sessions are also active for the cwd). If you see a `copilot-chat` source with non-zero entries, the redesign works end-to-end.

- [ ] **Step 8.6: If `copilot-chat` is missing from the transcript, troubleshoot in this order**

1. **Was the QueueWorker logging anything?** Run: `tail -200 ~/.jolli/jollimemory/logs/worker-*.log` (replace glob with the most recent file). Look for `Discovered N Copilot Chat session(s)` — should be ≥ 1 if Scan A or B found anything for the cwd.
2. **Is the dist actually the new one?** Re-run Step 8.3.
3. **Is there an active vscode chat panel "New Chat" session for this exact worktree path?** Run: `for d in ~/.copilot/session-state/*/; do python3 -c "import json; d=json.load(open('$d/vscode.metadata.json')); print('$d', d.get('workspaceFolder',{}).get('folderPath','-'))" 2>/dev/null; done | grep change-storage-to-folder`. If empty: open vscode in this worktree, "+" → "New Chat" → say one thing → wait for reply → re-run Step 8.4.
4. **Is `copilotEnabled` true in `~/.jolli/jollimemory/config.json`?** Run: `cat ~/.jolli/jollimemory/config.json | python3 -m json.tool | grep copilot`.

- [ ] **Step 8.7: After verification, leave the test commit in place or amend it away depending on preference**

If you want to preserve a clean history, run `git reset --hard HEAD~1` to drop the test commit. Otherwise leave it — it documents the verification.

---

## Self-Review Notes

The self-review (per writing-plans skill) was performed inline:

1. **Spec coverage:**
   - Detector modify → Task 1 ✅
   - Discoverer Scan A (events.jsonl + folderPath) → Task 5 ✅
   - Discoverer Scan B (chatSessions/.jsonl) → Task 5 ✅
   - Reader dispatcher → Task 2 ✅
   - readEventsJsonl sub-reader → Task 3 ✅
   - readPatchLog sub-reader (refactored) → Task 2 ✅
   - beforeTimestamp gate on both sub-readers → Task 4 ✅
   - QueueWorker 1-line change → Task 6 ✅
   - 48h freshness + path normalization + .json skip → Task 5 ✅
   - End-to-end smoke test on real disk → Task 8 ✅

2. **Placeholder scan:** No "TBD"/"TODO"/"implement later" patterns. All test code blocks contain full assertions; all implementation code blocks contain complete function bodies; all bash steps include exact commands and expected outputs.

3. **Type consistency:** `readCopilotChatTranscript` signature `(transcriptPath, cursor?, beforeTimestamp?)` matches across Tasks 2/3/4/6. `SessionInfo` fields (`sessionId`, `transcriptPath`, `updatedAt`, `source`) match `cli/src/Types.ts`. `TranscriptCursor.lineNumber` semantics — line-based for events.jsonl, request-index-based for patch log — explicitly documented at the dispatcher.
