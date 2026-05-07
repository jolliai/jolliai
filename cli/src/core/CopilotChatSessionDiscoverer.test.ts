import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Native-path → file:// URI. Cross-platform — `pathToFileURL` returns
 * `file:///D:/...` on Windows and `file:///Users/...` on POSIX, both of which
 * round-trip cleanly through `fileURLToPath` (unlike a hardcoded `file://${p}`
 * concatenation, which yields invalid URIs on Windows).
 */
function nativePathToFileUri(nativePath: string): string {
	return pathToFileURL(nativePath).href;
}

// Path-segment markers used to identify which directory a mocked readdir is
// being asked for. Match both POSIX (`/`) and Windows (`\`) separators so the
// same test asserts identically on both platforms.
const SESSION_STATE_MARKER = /[\\/]\.copilot[\\/]session-state$/;
const CHAT_SESSIONS_MARKER = /[\\/]chatSessions$/;

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
		// folderPath: undefined ⇒ omit `workspaceFolder` field; null ⇒ write empty string;
		// string ⇒ write that path. omitMetadata: true ⇒ skip the metadata file entirely.
		folderPath?: string | null;
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
			writeFileSync(eventsPath, `${JSON.stringify({ type: "session.start", data: {} })}\n`);
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
		makeWorkspace("ws1", nativePathToFileUri(projectDir));
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan B: emits fresh .jsonl session", async () => {
		const ws = makeWorkspace("ws1", nativePathToFileUri(projectDir));
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
		const ws = makeWorkspace("ws1", nativePathToFileUri(projectDir));
		makeChatSessionsFile(ws, "deprecated.json", 1);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan B: skips files older than 48h", async () => {
		const ws = makeWorkspace("ws1", nativePathToFileUri(projectDir));
		makeChatSessionsFile(ws, "stale.jsonl", 72);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toEqual([]);
	});

	it("Scan B: skips irrelevant suffixes (.tmp, .log)", async () => {
		const ws = makeWorkspace("ws1", nativePathToFileUri(projectDir));
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
		const ws = makeWorkspace("ws1", nativePathToFileUri(projectDir));
		makeChatSessionsFile(ws, "patch-1.jsonl", 1);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toHaveLength(2);
		const ids = result.sessions.map((s) => s.sessionId).sort();
		expect(ids).toEqual(["ev-1", "patch-1"]);
	});

	it("Combined: same sid in both scans is emitted twice (no dedup, by design)", async () => {
		makeSessionStateEntry({ sid: "shared", folderPath: projectDir, ageHours: 1 });
		const ws = makeWorkspace("ws1", nativePathToFileUri(projectDir));
		makeChatSessionsFile(ws, "shared.jsonl", 1);
		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.sessions).toHaveLength(2);
	});
});

describe("scanCopilotChatSessions error precedence", () => {
	let tmpRoot: string;
	let projectDir: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-chat-disc-err-"));
		projectDir = join(tmpRoot, "myproject");
		mkdirSync(projectDir, { recursive: true });
		mockHomedir.mockReturnValue(tmpRoot);
		mockPlatform.mockReturnValue("darwin");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		vi.resetModules();
		vi.doUnmock("node:fs/promises");
	});

	it("Scan A readdir EACCES: surfaces { kind:'fs' } error, Scan B still emits", async () => {
		// Build a Scan B-discoverable file before mocking fs (mock is path-selective).
		const ws = join(tmpRoot, "Library", "Application Support", "Code", "User", "workspaceStorage", "ws-only-b");
		mkdirSync(join(ws, "chatSessions"), { recursive: true });
		writeFileSync(join(ws, "workspace.json"), JSON.stringify({ folder: nativePathToFileUri(projectDir) }));
		writeFileSync(join(ws, "chatSessions", "from-b.jsonl"), JSON.stringify({ kind: 0, v: { requests: [] } }));

		// Mock readdir to throw EACCES for the session-state root only; everything else delegates to real fs.
		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readdir: vi.fn(async (path: string, ...rest: unknown[]) => {
					if (SESSION_STATE_MARKER.test(String(path))) {
						throw Object.assign(new Error("permission denied"), { code: "EACCES" });
					}
					return (actual.readdir as (p: string, ...args: unknown[]) => Promise<string[]>)(path, ...rest);
				}),
			};
		});

		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.error).toEqual({ kind: "fs", message: "permission denied" });
		expect(result.sessions.map((s) => s.sessionId)).toEqual(["from-b"]);
	});

	it("Scan B readdir EACCES + Scan A succeeded: Scan A wins, Scan B error reported", async () => {
		// Build a Scan A-discoverable session before mocking fs.
		const sessionDir = join(tmpRoot, ".copilot", "session-state", "from-a");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "vscode.metadata.json"),
			JSON.stringify({ origin: "vscode", workspaceFolder: { folderPath: projectDir } }),
		);
		writeFileSync(join(sessionDir, "events.jsonl"), JSON.stringify({ type: "session.start", data: {} }));

		// Build a workspaceStorage entry so findVscodeWorkspaceHash matches; mock readdir to fail on chatSessions.
		const ws = join(tmpRoot, "Library", "Application Support", "Code", "User", "workspaceStorage", "ws-b-error");
		mkdirSync(join(ws, "chatSessions"), { recursive: true });
		writeFileSync(join(ws, "workspace.json"), JSON.stringify({ folder: nativePathToFileUri(projectDir) }));

		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readdir: vi.fn(async (path: string, ...rest: unknown[]) => {
					if (CHAT_SESSIONS_MARKER.test(String(path))) {
						throw Object.assign(new Error("denied B"), { code: "EACCES" });
					}
					return (actual.readdir as (p: string, ...args: unknown[]) => Promise<string[]>)(path, ...rest);
				}),
			};
		});

		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.error).toEqual({ kind: "fs", message: "denied B" });
		expect(result.sessions.map((s) => s.sessionId)).toEqual(["from-a"]);
	});

	it("Both scans error: Scan A's error wins (reported), Scan B's is debug-logged and dropped", async () => {
		// Build a workspaceStorage entry so Scan B reaches readdir (and fails there).
		const ws = join(tmpRoot, "Library", "Application Support", "Code", "User", "workspaceStorage", "ws-both-err");
		mkdirSync(join(ws, "chatSessions"), { recursive: true });
		writeFileSync(join(ws, "workspace.json"), JSON.stringify({ folder: nativePathToFileUri(projectDir) }));

		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readdir: vi.fn(async (path: string, ...rest: unknown[]) => {
					if (SESSION_STATE_MARKER.test(String(path))) {
						throw Object.assign(new Error("denied A"), { code: "EACCES" });
					}
					if (CHAT_SESSIONS_MARKER.test(String(path))) {
						throw Object.assign(new Error("denied B"), { code: "EACCES" });
					}
					return (actual.readdir as (p: string, ...args: unknown[]) => Promise<string[]>)(path, ...rest);
				}),
			};
		});

		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.error).toEqual({ kind: "fs", message: "denied A" });
		expect(result.sessions).toEqual([]);
	});

	it("Scan A readdir error without errno code: error log falls back to 'unknown'", async () => {
		// Exercises the `code ?? "unknown"` fallback in scanSessionState.
		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readdir: vi.fn(async (path: string, ...rest: unknown[]) => {
					if (SESSION_STATE_MARKER.test(String(path))) {
						throw new Error("oddball without errno");
					}
					return (actual.readdir as (p: string, ...args: unknown[]) => Promise<string[]>)(path, ...rest);
				}),
			};
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.error).toEqual({ kind: "fs", message: "oddball without errno" });
		const formatted = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(formatted).toMatch(/unknown/);
		errorSpy.mockRestore();
	});

	it("Scan B readdir error without errno code: error log falls back to 'unknown'", async () => {
		// Build a workspaceStorage entry so Scan B reaches readdir.
		const ws = join(tmpRoot, "Library", "Application Support", "Code", "User", "workspaceStorage", "ws-b-noerrno");
		mkdirSync(join(ws, "chatSessions"), { recursive: true });
		writeFileSync(join(ws, "workspace.json"), JSON.stringify({ folder: nativePathToFileUri(projectDir) }));

		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readdir: vi.fn(async (path: string, ...rest: unknown[]) => {
					if (CHAT_SESSIONS_MARKER.test(String(path))) {
						throw new Error("oddball B without errno");
					}
					return (actual.readdir as (p: string, ...args: unknown[]) => Promise<string[]>)(path, ...rest);
				}),
			};
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.error).toEqual({ kind: "fs", message: "oddball B without errno" });
		const formatted = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(formatted).toMatch(/unknown/);
		errorSpy.mockRestore();
	});
});

describe("scanCopilotChatSessions Scan B mid-loop stat skip", () => {
	let tmpRoot: string;
	let projectDir: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "copilot-chat-disc-mid-"));
		projectDir = join(tmpRoot, "myproject");
		mkdirSync(projectDir, { recursive: true });
		mockHomedir.mockReturnValue(tmpRoot);
		mockPlatform.mockReturnValue("darwin");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
		vi.resetModules();
		vi.doUnmock("node:fs/promises");
	});

	it("Scan B: skips entries whose stat() fails (e.g., file vanished between readdir and stat)", async () => {
		// Real file kept on disk so the loop has at least one entry it can fully process;
		// readdir is overridden to also return a phantom .jsonl name that is not present
		// on disk, exercising the inside-loop catch around stat().
		const ws = join(tmpRoot, "Library", "Application Support", "Code", "User", "workspaceStorage", "ws-phantom");
		mkdirSync(join(ws, "chatSessions"), { recursive: true });
		writeFileSync(join(ws, "workspace.json"), JSON.stringify({ folder: nativePathToFileUri(projectDir) }));
		const realPath = join(ws, "chatSessions", "real.jsonl");
		writeFileSync(realPath, JSON.stringify({ kind: 0, v: { requests: [] } }));
		const targetSec = (Date.now() - 1 * 3600 * 1000) / 1000;
		utimesSync(realPath, targetSec, targetSec);

		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readdir: vi.fn(async (path: string, ...rest: unknown[]) => {
					if (CHAT_SESSIONS_MARKER.test(String(path))) {
						return ["phantom.jsonl", "real.jsonl"];
					}
					return (actual.readdir as (p: string, ...args: unknown[]) => Promise<string[]>)(path, ...rest);
				}),
			};
		});

		const { scanCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await scanCopilotChatSessions(projectDir);
		expect(result.error).toBeUndefined();
		expect(result.sessions.map((s) => s.sessionId)).toEqual(["real"]);
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
		vi.doUnmock("node:fs/promises");
	});

	it("strips error channel and returns array directly", async () => {
		const { discoverCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await discoverCopilotChatSessions(projectDir);
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([]);
	});

	it("warn-logs and returns sessions when underlying scan reports an error", async () => {
		// Build a Scan B-discoverable file so the warn branch runs alongside non-empty
		// sessions; Scan A is forced to error via readdir EACCES.
		const ws = join(tmpRoot, "Library", "Application Support", "Code", "User", "workspaceStorage", "ws-warn");
		mkdirSync(join(ws, "chatSessions"), { recursive: true });
		writeFileSync(join(ws, "workspace.json"), JSON.stringify({ folder: nativePathToFileUri(projectDir) }));
		const fresh = join(ws, "chatSessions", "fresh.jsonl");
		writeFileSync(fresh, JSON.stringify({ kind: 0, v: { requests: [] } }));
		const targetSec = (Date.now() - 1 * 3600 * 1000) / 1000;
		utimesSync(fresh, targetSec, targetSec);

		vi.doMock("node:fs/promises", async () => {
			const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return {
				...actual,
				readdir: vi.fn(async (path: string, ...rest: unknown[]) => {
					if (SESSION_STATE_MARKER.test(String(path))) {
						throw Object.assign(new Error("perm denied"), { code: "EACCES" });
					}
					return (actual.readdir as (p: string, ...args: unknown[]) => Promise<string[]>)(path, ...rest);
				}),
			};
		});

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { discoverCopilotChatSessions } = await import("./CopilotChatSessionDiscoverer.js");
		const result = await discoverCopilotChatSessions(projectDir);
		expect(result.map((s) => s.sessionId)).toEqual(["fresh"]);
		const formatted = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(formatted).toMatch(/Copilot Chat scan error/);
		expect(formatted).toMatch(/perm denied/);
		warnSpy.mockRestore();
	});
});
