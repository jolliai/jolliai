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

	it("returns the anchor composer when workspace pointer is set, even outside time window", async () => {
		const ancientTs = Date.now() - 365 * 24 * 60 * 60 * 1000;
		await setupCursorHome(tmpHome, {
			globalComposers: [{ composerId: "anchor-1", createdAtMs: ancientTs, lastUpdatedAtMs: ancientTs }],
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

	it("skips composerData rows with malformed JSON without crashing", async () => {
		// Set up a normal workspace + global DB with one good and one bad composer row
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		await mkdir(join(userDir, "workspaceStorage", "ws-00000000"), { recursive: true });
		await writeFile(
			join(userDir, "workspaceStorage", "ws-00000000", "workspace.json"),
			JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }),
		);

		// Workspace DB with anchor pointing to good-1
		const wsDbPath = join(userDir, "workspaceStorage", "ws-00000000", "state.vscdb");
		const wsDb = new DatabaseSync(wsDbPath);
		for (const sql of CURSOR_DDL) wsDb.prepare(sql).run();
		wsDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
			"composer.composerData",
			JSON.stringify({ lastFocusedComposerIds: ["good-1"] }),
		);
		wsDb.close();

		// Global DB with one good composer + one row of garbage JSON
		const globalDbPath = join(userDir, "globalStorage", "state.vscdb");
		const globalDb = new DatabaseSync(globalDbPath);
		for (const sql of CURSOR_DDL) globalDb.prepare(sql).run();
		globalDb
			.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
			.run("composerData:good-1", JSON.stringify({ composerId: "good-1", lastUpdatedAt: Date.now() }));
		globalDb
			.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
			.run("composerData:bad-2", "this is not json");
		globalDb.close();

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions.map((s) => s.sessionId)).toEqual(["good-1"]);
	});

	it("skips composerData rows with missing or non-string composerId", async () => {
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		await mkdir(join(userDir, "workspaceStorage", "ws-00000000"), { recursive: true });
		await writeFile(
			join(userDir, "workspaceStorage", "ws-00000000", "workspace.json"),
			JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }),
		);

		const wsDbPath = join(userDir, "workspaceStorage", "ws-00000000", "state.vscdb");
		const wsDb = new DatabaseSync(wsDbPath);
		for (const sql of CURSOR_DDL) wsDb.prepare(sql).run();
		wsDb.close();

		const globalDbPath = join(userDir, "globalStorage", "state.vscdb");
		const globalDb = new DatabaseSync(globalDbPath);
		for (const sql of CURSOR_DDL) globalDb.prepare(sql).run();
		// Row with no composerId field
		globalDb
			.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
			.run("composerData:c-1", JSON.stringify({ lastUpdatedAt: Date.now() }));
		// Row with non-string composerId
		globalDb
			.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
			.run("composerData:c-2", JSON.stringify({ composerId: 12345, lastUpdatedAt: Date.now() }));
		globalDb.close();

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toEqual([]);
	});

	it("skips composerData rows with non-finite lastUpdatedAt (anchor and non-anchor)", async () => {
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		await mkdir(join(userDir, "workspaceStorage", "ws-00000000"), { recursive: true });
		await writeFile(
			join(userDir, "workspaceStorage", "ws-00000000", "workspace.json"),
			JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }),
		);

		const wsDbPath = join(userDir, "workspaceStorage", "ws-00000000", "state.vscdb");
		const wsDb = new DatabaseSync(wsDbPath);
		for (const sql of CURSOR_DDL) wsDb.prepare(sql).run();
		wsDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
			"composer.composerData",
			JSON.stringify({ lastFocusedComposerIds: ["anchor-bad"] }),
		);
		wsDb.close();

		const globalDbPath = join(userDir, "globalStorage", "state.vscdb");
		const globalDb = new DatabaseSync(globalDbPath);
		for (const sql of CURSOR_DDL) globalDb.prepare(sql).run();
		// Anchor composer with null lastUpdatedAt
		globalDb
			.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
			.run("composerData:anchor-bad", JSON.stringify({ composerId: "anchor-bad", lastUpdatedAt: null }));
		// Non-anchor composer with null lastUpdatedAt
		globalDb
			.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
			.run("composerData:other-bad", JSON.stringify({ composerId: "other-bad", lastUpdatedAt: null }));
		globalDb.close();

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toEqual([]);
	});

	it("skips workspaces whose folder URI is not file://", async () => {
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
			{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() },
		]);

		// Workspace with a remote URI (vscode-remote://...) — should not match a local path
		const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(wsDir, { recursive: true });
		await writeFile(
			join(wsDir, "workspace.json"),
			JSON.stringify({ folder: "vscode-remote://ssh-remote+host/Users/flyer/work/proj-a" }),
		);
		createCursorWorkspaceDb(join(wsDir, "state.vscdb"), { lastFocusedComposerIds: ["c-1"] });

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toEqual([]);
	});

	it("returns empty when workspace composer.composerData has malformed JSON", async () => {
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
			{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() - 100 * 60 * 60 * 1000 }, // outside window
		]);

		const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(wsDir, { recursive: true });
		await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }));

		// Workspace DB has the composer.composerData key but with garbage JSON
		const wsDb = new DatabaseSync(join(wsDir, "state.vscdb"));
		for (const sql of CURSOR_DDL) wsDb.prepare(sql).run();
		wsDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
			"composer.composerData",
			"{not valid json",
		);
		wsDb.close();

		// No anchors should be extracted; the stale composer is outside the time window;
		// overall result is empty without the read crashing.
		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toEqual([]);
	});

	it("uses selectedComposerIds as anchor when lastFocusedComposerIds is absent", async () => {
		const ancientTs = Date.now() - 365 * 24 * 60 * 60 * 1000;
		await setupCursorHome(tmpHome, {
			globalComposers: [{ composerId: "selected-1", createdAtMs: ancientTs, lastUpdatedAtMs: ancientTs }],
			workspaces: [
				{
					folder: "file:///Users/flyer/work/proj-a",
					pointers: null, // creates the DB with tables but no composer.composerData row
				},
			],
		});

		// Insert composer.composerData with only selectedComposerIds (no lastFocusedComposerIds key)
		// into the already-created workspace DB.
		const wsDbPath = join(
			tmpHome,
			"Library/Application Support/Cursor/User",
			"workspaceStorage",
			"ws-00000000",
			"state.vscdb",
		);
		const wsDb = new DatabaseSync(wsDbPath);
		wsDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
			"composer.composerData",
			JSON.stringify({ selectedComposerIds: ["selected-1"] }),
		);
		wsDb.close();

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("selected-1");
	});

	it("skips workspaces whose folder URI cannot be parsed by fileURLToPath", async () => {
		// fileURLToPath throws ERR_INVALID_FILE_URL_HOST when a `file://` URI
		// has a non-empty host on POSIX. The bad workspace must be skipped
		// without aborting the scan; the good workspace right after must still
		// match and resolve its anchor composer.
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
			{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() },
		]);

		// Bad workspace: `file://hostname/path` — fileURLToPath rejects this on POSIX.
		const badWsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(badWsDir, { recursive: true });
		await writeFile(
			join(badWsDir, "workspace.json"),
			JSON.stringify({ folder: "file://nonempty.host/Users/flyer/work/proj-a" }),
		);
		createCursorWorkspaceDb(join(badWsDir, "state.vscdb"), null);

		// Good workspace right after — confirms the loop continued past the bad one.
		const goodWsDir = join(userDir, "workspaceStorage", "ws-00000001");
		await mkdir(goodWsDir, { recursive: true });
		await writeFile(
			join(goodWsDir, "workspace.json"),
			JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }),
		);
		createCursorWorkspaceDb(join(goodWsDir, "state.vscdb"), { lastFocusedComposerIds: ["c-1"] });

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe("c-1");
	});

	it("returns time-window-only sessions when workspace state.vscdb is missing", async () => {
		// Workspace folder matches but its state.vscdb file does not exist —
		// readCursorAnchorComposerIds must swallow the stat() ENOENT and return [].
		// The scan should still surface fresh composers from the global DB.
		const fresh = Date.now() - 60 * 1000;
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
			{ composerId: "fresh-1", createdAtMs: fresh, lastUpdatedAtMs: fresh },
		]);

		const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(wsDir, { recursive: true });
		await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }));
		// Intentionally do NOT create wsDir/state.vscdb

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions.map((s) => s.sessionId)).toEqual(["fresh-1"]);
	});

	it("returns [] when the global state.vscdb file is missing (ENOENT)", async () => {
		// workspaceStorage exists and matches projectDir, but globalStorage/state.vscdb
		// is absent — this is a "Cursor not yet booted" / fresh-install scenario.
		// scanCursorSessions must short-circuit silently with no error surface.
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		// Intentionally do NOT create globalStorage/state.vscdb

		const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(wsDir, { recursive: true });
		await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }));

		const result = await scanCursorSessions("/Users/flyer/work/proj-a");
		expect(result).toEqual({ sessions: [] });
	});

	it("skips workspace.json files that are unreadable or not valid JSON", async () => {
		// readFile throws (file missing) for ws-0; JSON.parse throws for ws-1.
		// Both cases fall through to the generic catch and `continue` — the loop
		// must keep going and find the good workspace at ws-2.
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
			{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() },
		]);

		// ws-0: directory exists but workspace.json does not
		await mkdir(join(userDir, "workspaceStorage", "ws-00000000"), { recursive: true });

		// ws-1: workspace.json exists but is not valid JSON
		const ws1 = join(userDir, "workspaceStorage", "ws-00000001");
		await mkdir(ws1, { recursive: true });
		await writeFile(join(ws1, "workspace.json"), "{ this is not json");

		// ws-2: good
		const ws2 = join(userDir, "workspaceStorage", "ws-00000002");
		await mkdir(ws2, { recursive: true });
		await writeFile(join(ws2, "workspace.json"), JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }));
		createCursorWorkspaceDb(join(ws2, "state.vscdb"), { lastFocusedComposerIds: ["c-1"] });

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions.map((s) => s.sessionId)).toEqual(["c-1"]);
	});

	it("skips workspace.json whose `folder` field is not a string", async () => {
		// Schema-drift / corruption guard: if `folder` is missing or a non-string
		// value, folderUri stays undefined and the workspace is skipped at
		// `!folderUri` rather than reaching fileURLToPath.
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
			{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() },
		]);

		const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(wsDir, { recursive: true });
		// folder is a number, not a string
		await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: 12345 }));

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions).toEqual([]);
	});

	it("walks past non-matching workspaces before finding the matching one", async () => {
		// Multiple workspaces, only the second one matches the target. This
		// exercises the "folderPath !== target" falsy branch at the equality check
		// — without it, the first workspace's truthy match would short-circuit.
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
			{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() },
		]);

		// Non-matching workspace
		const ws0 = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(ws0, { recursive: true });
		await writeFile(join(ws0, "workspace.json"), JSON.stringify({ folder: "file:///Users/flyer/work/other-proj" }));
		createCursorWorkspaceDb(join(ws0, "state.vscdb"), null);

		// Matching workspace
		const ws1 = join(userDir, "workspaceStorage", "ws-00000001");
		await mkdir(ws1, { recursive: true });
		await writeFile(join(ws1, "workspace.json"), JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }));
		createCursorWorkspaceDb(join(ws1, "state.vscdb"), { lastFocusedComposerIds: ["c-1"] });

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions.map((s) => s.sessionId)).toEqual(["c-1"]);
	});

	it("dedupes composers that appear under multiple keys with the same composerId", async () => {
		// Defensive dedupe path: two distinct rows in cursorDiskKV where the
		// embedded composerId collides. The second occurrence must be filtered
		// out via the seenIds Set rather than producing a duplicate session.
		const fresh = Date.now() - 60 * 1000;
		const userDir = join(tmpHome, "Library/Application Support/Cursor/User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });

		const globalDbPath = join(userDir, "globalStorage", "state.vscdb");
		const globalDb = new DatabaseSync(globalDbPath);
		for (const sql of CURSOR_DDL) globalDb.prepare(sql).run();
		// Two distinct keys, but both point at composerId="dup-1".
		globalDb
			.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
			.run("composerData:dup-1", JSON.stringify({ composerId: "dup-1", lastUpdatedAt: fresh }));
		globalDb
			.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
			.run("composerData:dup-1-alt", JSON.stringify({ composerId: "dup-1", lastUpdatedAt: fresh }));
		globalDb.close();

		const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(wsDir, { recursive: true });
		await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///Users/flyer/work/proj-a" }));
		createCursorWorkspaceDb(join(wsDir, "state.vscdb"), null);

		const sessions = await discoverCursorSessions("/Users/flyer/work/proj-a");
		expect(sessions.map((s) => s.sessionId)).toEqual(["dup-1"]);
	});

	it("normalizes paths case-insensitively on win32", async () => {
		// Covers the win32 leg of the `darwin || win32` short-circuit in
		// normalizePathForMatch. Cursor on Windows reads from %APPDATA%/Cursor;
		// we point APPDATA at tmpHome so the fixture is discoverable.
		// Folder URI uses POSIX form because fileURLToPath runs on the real
		// host (darwin) and would reject a Windows drive-letter URL — the
		// platform mock only steers our own normalization path.
		const prevAppData = process.env.APPDATA;
		process.env.APPDATA = join(tmpHome, "Roaming");
		try {
			mockPlatform.mockReturnValue("win32");
			const userDir = join(process.env.APPDATA, "Cursor", "User");
			await mkdir(join(userDir, "globalStorage"), { recursive: true });
			createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
				{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() },
			]);
			const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
			await mkdir(wsDir, { recursive: true });
			await writeFile(
				join(wsDir, "workspace.json"),
				JSON.stringify({ folder: "file:///Users/Flyer/Code%20Folder/Proj" }),
			);
			createCursorWorkspaceDb(join(wsDir, "state.vscdb"), { lastFocusedComposerIds: ["c-1"] });

			// Lowercased target should match the original-cased stored path
			// because the win32 normalize branch lowercases both sides.
			const sessions = await discoverCursorSessions("/users/flyer/code folder/proj");
			expect(sessions).toHaveLength(1);
		} finally {
			if (prevAppData === undefined) delete process.env.APPDATA;
			else process.env.APPDATA = prevAppData;
		}
	});

	it("preserves casing on linux (case-sensitive filesystem)", async () => {
		// On linux, normalizePathForMatch does NOT lowercase — a casing mismatch
		// must NOT resolve to a workspace match. Linux reads from ~/.config/Cursor.
		mockPlatform.mockReturnValue("linux");
		const userDir = join(tmpHome, ".config", "Cursor", "User");
		await mkdir(join(userDir, "globalStorage"), { recursive: true });
		createCursorGlobalDb(join(userDir, "globalStorage", "state.vscdb"), [
			{ composerId: "c-1", createdAtMs: Date.now(), lastUpdatedAtMs: Date.now() },
		]);
		const wsDir = join(userDir, "workspaceStorage", "ws-00000000");
		await mkdir(wsDir, { recursive: true });
		await writeFile(join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///home/flyer/Work/Proj" }));
		createCursorWorkspaceDb(join(wsDir, "state.vscdb"), { lastFocusedComposerIds: ["c-1"] });

		// Lowercased target must NOT match the original-cased stored path on linux.
		const sessions = await discoverCursorSessions("/home/flyer/work/proj");
		expect(sessions).toEqual([]);

		// Same-case target DOES match — confirms the linux branch was reached
		// rather than the lookup short-circuiting on a missing workspace dir.
		const sessions2 = await discoverCursorSessions("/home/flyer/Work/Proj");
		expect(sessions2).toHaveLength(1);
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
		expect(result.error).toBeDefined();
		expect(["corrupt", "permission", "unknown"]).toContain(result.error?.kind);
	});
});
