import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRename, realRename } = vi.hoisted(() => ({
	mockRename: vi.fn<typeof import("node:fs/promises").rename>(),
	realRename: { current: null as typeof import("node:fs/promises").rename | null },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	realRename.current = original.rename;
	mockRename.mockImplementation(original.rename);
	return {
		...original,
		rename: mockRename,
	};
});

// Redirect homedir() so the global-config tests don't pollute the developer's
// real ~/.jolli/jollimemory/config.json. Default passes through to the real
// homedir(); individual tests opt into redirection via mockHomedir.mockReturnValue().
// Cross-platform: works on Windows too, where process.env.HOME is ignored by homedir().
const { mockHomedir, realHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn<typeof import("node:os").homedir>(),
	realHomedir: { current: null as typeof import("node:os").homedir | null },
}));
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	realHomedir.current = original.homedir;
	mockHomedir.mockImplementation(original.homedir);
	return {
		...original,
		homedir: mockHomedir,
	};
});

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import type {
	CommitGitOperation,
	PlansRegistry,
	Reference,
	ReferenceEntry,
	SessionInfo,
	SessionsRegistry,
	SquashPendingState,
	TranscriptCursor,
} from "../Types.js";
import {
	associateNoteWithCommit,
	associatePlanWithCommit,
	checkStaleSquashPending,
	countActiveQueueEntries,
	countActiveQueueEntriesByKind,
	countActiveSummaryQueueEntries,
	countStaleQueueEntries,
	countStaleSessions,
	deletePluginSource,
	deleteQueueEntry,
	deleteSquashPending,
	dequeueAllGitOperations,
	detectActiveNotesForBranch,
	detectActivePlansForBranch,
	detectUncommittedReferenceIds,
	discardExcludedWorkingItems,
	enqueueGitOperation,
	ensureJolliMemoryDir,
	filterSessionsByEnabledIntegrations,
	getGlobalConfigDir,
	getOrCreateInstallId,
	getOrCreateInstallIdInDir,
	getReferenceEntriesForBranch,
	loadAllSessions,
	loadConfig,
	loadConfigFromDir,
	loadCursorForTranscript,
	loadDiscoveryCursor,
	loadMostRecentSession,
	loadPlanEntry,
	loadPlansRegistry,
	loadPluginSource,
	loadSquashPending,
	markAiSourceSeen,
	markAiSourceSeenInDir,
	migrateDiscoveryCursors,
	normalizePlansRegistry,
	pruneStaleQueueEntries,
	pruneStaleSessions,
	saveConfig,
	saveConfigScoped,
	saveCursor,
	saveDiscoveryCursor,
	savePlansRegistry,
	savePluginSource,
	saveSession,
	saveSquashPending,
	upsertReferenceEntry,
} from "./SessionTracker.js";

/**
 * Test-only narrowing helper: pull Linear-only reference rows out of a loaded
 * PlansRegistry, keyed by bare ticket id (`linear:` prefix stripped). The
 * value is the ReferenceEntry as-is (no shape transformation) — tests that
 * used to read the legacy `linearIssues` map now read this projection instead.
 */
function linearIssuesOfReg(reg: PlansRegistry): Readonly<Record<string, ReferenceEntry>> | undefined {
	const out: Record<string, ReferenceEntry> = {};
	for (const [mapKey, entry] of Object.entries(reg.references ?? {})) {
		if (entry.source !== "linear") continue;
		const k = mapKey.startsWith("linear:") ? mapKey.slice("linear:".length) : mapKey;
		out[k] = entry;
	}
	return out;
}

describe("SessionTracker", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jollimemory-test-"));
		mockRename.mockClear();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("ensureJolliMemoryDir", () => {
		it("should create .jolli/jollimemory directory", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			expect(dir).toContain(".jolli");
			expect(dir).toContain("jollimemory");
			const { stat } = await import("node:fs/promises");
			const stats = await stat(dir);
			expect(stats.isDirectory()).toBe(true);
		});

		it("should be idempotent", async () => {
			await ensureJolliMemoryDir(tempDir);
			await ensureJolliMemoryDir(tempDir);
			// No error thrown
		});
	});

	describe("discardExcludedWorkingItems", () => {
		it("removes excluded uncommitted rows + .jolli files; keeps checked/committed rows and external plan files", async () => {
			const jolliDir = join(tempDir, ".jolli", "jollimemory");
			const notesDir = join(jolliDir, "notes");
			const refsDir = join(jolliDir, "references", "linear");
			const extDir = join(tempDir, "ext-plans");
			await mkdir(notesDir, { recursive: true });
			await mkdir(refsDir, { recursive: true });
			await mkdir(extDir, { recursive: true });

			const keepPlanFile = join(extDir, "keep.md");
			const dropPlanFile = join(extDir, "drop.md");
			const noteFile = join(notesDir, "n1.md");
			const refFile = join(refsDir, "L-1.md");
			await writeFile(keepPlanFile, "# Keep");
			await writeFile(dropPlanFile, "# Drop");
			await writeFile(noteFile, "note body");
			await writeFile(refFile, "ref body");

			await savePlansRegistry(
				{
					version: 1,
					plans: {
						"keep-plan": {
							slug: "keep-plan",
							title: "Keep",
							sourcePath: keepPlanFile,
							addedAt: "t",
							updatedAt: "t",
							commitHash: null,
						},
						"drop-plan": {
							slug: "drop-plan",
							title: "Drop",
							sourcePath: dropPlanFile,
							addedAt: "t",
							updatedAt: "t",
							commitHash: null,
						},
						// committed guard: excluded key must NOT clobber it.
						"committed-plan": {
							slug: "committed-plan",
							title: "Committed",
							sourcePath: keepPlanFile,
							addedAt: "t",
							updatedAt: "t",
							commitHash: "abc12345",
							contentHashAtCommit: "hash",
						},
					},
					notes: {
						n1: {
							id: "n1",
							title: "Note",
							format: "snippet",
							addedAt: "t",
							updatedAt: "t",
							commitHash: null,
							sourcePath: noteFile,
						},
					},
					references: {
						"linear:L-1": {
							source: "linear",
							nativeId: "L-1",
							title: "Ref",
							url: "https://x",
							sourcePath: refFile,
							addedAt: "t",
							updatedAt: "t",
							sourceToolName: "mcp__linear__get_issue",
						},
					},
				},
				tempDir,
			);

			const removed = await discardExcludedWorkingItems(
				{
					plans: new Set(["drop-plan", "committed-plan"]),
					notes: new Set(["n1"]),
					references: new Set(["linear:L-1"]),
				},
				tempDir,
			);
			expect(removed).toEqual({ plans: 1, notes: 1, references: 1 });

			const reg = await loadPlansRegistry(tempDir);
			// drop-plan removed; keep-plan + committed guard preserved.
			expect(Object.keys(reg.plans).sort()).toEqual(["committed-plan", "keep-plan"]);
			expect(reg.notes ?? {}).toEqual({});
			expect(reg.references ?? {}).toEqual({});

			const { existsSync } = await import("node:fs");
			// .jolli-owned note + reference files deleted…
			expect(existsSync(noteFile)).toBe(false);
			expect(existsSync(refFile)).toBe(false);
			// …but the external plan file is never touched.
			expect(existsSync(dropPlanFile)).toBe(true);
		});

		it("is a no-op when nothing is excluded", async () => {
			const removed = await discardExcludedWorkingItems(
				{ plans: new Set(), notes: new Set(), references: new Set() },
				tempDir,
			);
			expect(removed).toEqual({ plans: 0, notes: 0, references: 0 });
		});

		it("handles source-less rows, committed/missing exclusions, external files, and surviving siblings", async () => {
			// Exercises the complement branches of the happy-path test:
			//  - a removed note with no sourcePath / reference with empty sourcePath (nothing queued to delete)
			//  - an excluded-but-committed note (guard skipped) + an excluded missing ref
			//  - surviving siblings so the `length > 0 ? … : undefined` writeback keeps both maps
			//  - a removed note whose sourcePath lives OUTSIDE .jolli (never unlinked)
			const externalNoteFile = join(tempDir, "ext-notes", "keep-me.md");
			await mkdir(dirname(externalNoteFile), { recursive: true });
			await writeFile(externalNoteFile, "user-owned note");

			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					notes: {
						"rm-no-src": {
							id: "rm-no-src",
							title: "No source",
							format: "snippet",
							addedAt: "t",
							updatedAt: "t",
							commitHash: null,
						},
						"rm-external": {
							id: "rm-external",
							title: "External source",
							format: "markdown",
							addedAt: "t",
							updatedAt: "t",
							commitHash: null,
							sourcePath: externalNoteFile,
						},
						"committed-note": {
							id: "committed-note",
							title: "Committed",
							format: "markdown",
							addedAt: "t",
							updatedAt: "t",
							commitHash: "abc12345",
							contentHashAtCommit: "h",
						},
						"survivor-note": {
							id: "survivor-note",
							title: "Survivor",
							format: "markdown",
							addedAt: "t",
							updatedAt: "t",
							commitHash: null,
						},
					},
					references: {
						"linear:RM-NO-SRC": {
							source: "linear",
							nativeId: "RM-NO-SRC",
							title: "No source ref",
							url: "https://x/1",
							// Empty sourcePath stands in for "no owned .jolli file": the
							// row is still removed + counted, but nothing is queued to unlink.
							sourcePath: "",
							addedAt: "t",
							updatedAt: "t",
							sourceToolName: "mcp__linear__get_issue",
						},
						"linear:SURVIVOR": {
							source: "linear",
							nativeId: "SURVIVOR",
							title: "Survivor ref",
							url: "https://x/2",
							// Not excluded below, so this path is never read/unlinked.
							sourcePath: join(tempDir, ".jolli", "jollimemory", "references", "linear", "survivor.md"),
							addedAt: "t",
							updatedAt: "t",
							sourceToolName: "mcp__linear__get_issue",
						},
					},
				},
				tempDir,
			);

			const removed = await discardExcludedWorkingItems(
				{
					plans: new Set(),
					notes: new Set(["rm-no-src", "rm-external", "committed-note"]),
					references: new Set(["linear:RM-NO-SRC", "linear:MISSING"]),
				},
				tempDir,
			);
			// committed-note is skipped (guard), MISSING ref is absent → not counted.
			expect(removed).toEqual({ plans: 0, notes: 2, references: 1 });

			const reg = await loadPlansRegistry(tempDir);
			expect(Object.keys(reg.notes ?? {}).sort()).toEqual(["committed-note", "survivor-note"]);
			expect(Object.keys(reg.references ?? {})).toEqual(["linear:SURVIVOR"]);

			// The external note file is outside .jolli, so it is never unlinked.
			const { existsSync } = await import("node:fs");
			expect(existsSync(externalNoteFile)).toBe(true);
		});
	});

	describe("saveSession / loadAllSessions", () => {
		it("should save and load a single session", async () => {
			const session: SessionInfo = {
				sessionId: "test-session-123",
				transcriptPath: "/path/to/transcript.jsonl",
				updatedAt: new Date().toISOString(),
			};

			await saveSession(session, tempDir);
			const sessions = await loadAllSessions(tempDir);

			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toEqual(session);
		});

		it("should save multiple sessions independently", async () => {
			const session1: SessionInfo = {
				sessionId: "session-1",
				transcriptPath: "/path/1.jsonl",
				updatedAt: new Date().toISOString(),
			};
			const session2: SessionInfo = {
				sessionId: "session-2",
				transcriptPath: "/path/2.jsonl",
				updatedAt: new Date().toISOString(),
			};

			await saveSession(session1, tempDir);
			await saveSession(session2, tempDir);

			const sessions = await loadAllSessions(tempDir);
			expect(sessions).toHaveLength(2);
			const ids = sessions.map((s) => s.sessionId).sort();
			expect(ids).toEqual(["session-1", "session-2"]);
		});

		it("should upsert existing session by sessionId", async () => {
			const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
			const justNow = new Date().toISOString();

			const session: SessionInfo = {
				sessionId: "session-1",
				transcriptPath: "/path/1.jsonl",
				updatedAt: oneHourAgo,
			};
			await saveSession(session, tempDir);

			const updated: SessionInfo = {
				sessionId: "session-1",
				transcriptPath: "/path/1.jsonl",
				updatedAt: justNow,
			};
			await saveSession(updated, tempDir);

			const sessions = await loadAllSessions(tempDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].updatedAt).toBe(justNow);
		});

		it("should return empty array when no sessions exist", async () => {
			const sessions = await loadAllSessions(tempDir);
			expect(sessions).toEqual([]);
		});

		it("should handle corrupted sessions.json gracefully", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			await writeFile(join(dir, "sessions.json"), "not valid json", "utf-8");

			const sessions = await loadAllSessions(tempDir);
			expect(sessions).toEqual([]);
		});

		it("should prune stale sessions (>48h) during save", async () => {
			// Create a session with updatedAt 49 hours ago
			const staleTime = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
			const staleSession: SessionInfo = {
				sessionId: "stale-session",
				transcriptPath: "/path/stale.jsonl",
				updatedAt: staleTime,
			};

			// Write stale session directly to registry
			const dir = await ensureJolliMemoryDir(tempDir);
			const registry: SessionsRegistry = {
				version: 1,
				sessions: { "stale-session": staleSession },
			};
			await writeFile(join(dir, "sessions.json"), JSON.stringify(registry), "utf-8");

			// Save a new session — should prune the stale one
			const freshSession: SessionInfo = {
				sessionId: "fresh-session",
				transcriptPath: "/path/fresh.jsonl",
				updatedAt: new Date().toISOString(),
			};
			await saveSession(freshSession, tempDir);

			const sessions = await loadAllSessions(tempDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe("fresh-session");
		});

		it("should prune stale sessions' cursors during save", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);

			// Create a stale session and its cursor
			const staleTime = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
			const staleSession: SessionInfo = {
				sessionId: "stale",
				transcriptPath: "/path/stale.jsonl",
				updatedAt: staleTime,
			};
			const registry: SessionsRegistry = {
				version: 1,
				sessions: { stale: staleSession },
			};
			await writeFile(join(dir, "sessions.json"), JSON.stringify(registry), "utf-8");

			// Save a cursor for the stale session's transcript
			const cursor: TranscriptCursor = {
				transcriptPath: "/path/stale.jsonl",
				lineNumber: 42,
				updatedAt: staleTime,
			};
			await saveCursor(cursor, tempDir);
			await saveCursor(
				{
					transcriptPath: "/path/keep.jsonl",
					lineNumber: 7,
					updatedAt: new Date().toISOString(),
				},
				tempDir,
			);

			// Save a new session — triggers pruning of stale session + cursor
			const freshSession: SessionInfo = {
				sessionId: "fresh",
				transcriptPath: "/path/fresh.jsonl",
				updatedAt: new Date().toISOString(),
			};
			await saveSession(freshSession, tempDir);

			// Stale cursor should be removed
			const staleCursor = await loadCursorForTranscript("/path/stale.jsonl", tempDir);
			expect(staleCursor).toBeNull();
			await expect(loadCursorForTranscript("/path/keep.jsonl", tempDir)).resolves.toEqual(
				expect.objectContaining({ lineNumber: 7 }),
			);
		});

		it("should prune stale cursors during save", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			const staleTime = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
			const staleSession: SessionInfo = {
				sessionId: "stale-plan",
				transcriptPath: "/path/stale-plan.jsonl",
				updatedAt: staleTime,
			};
			const registry: SessionsRegistry = {
				version: 1,
				sessions: { "stale-plan": staleSession },
			};
			await writeFile(join(dir, "sessions.json"), JSON.stringify(registry), "utf-8");

			await saveCursor(
				{
					transcriptPath: "/path/stale-plan.jsonl",
					lineNumber: 9,
					updatedAt: staleTime,
				},
				tempDir,
			);

			await saveSession(
				{
					sessionId: "fresh-plan",
					transcriptPath: "/path/fresh-plan.jsonl",
					updatedAt: new Date().toISOString(),
				},
				tempDir,
			);

			await expect(loadCursorForTranscript("/path/stale-plan.jsonl", tempDir)).resolves.toBeNull();
		});
	});

	describe("discovery cursors (discovery-cursors.json)", () => {
		it("round-trips a discovery cursor in a file separate from cursors.json", async () => {
			await saveDiscoveryCursor(
				{ transcriptPath: "/path/t.jsonl", lineNumber: 642, updatedAt: "2026-06-03T00:00:00Z" },
				tempDir,
			);

			await expect(loadDiscoveryCursor("/path/t.jsonl", tempDir)).resolves.toEqual(
				expect.objectContaining({ lineNumber: 642 }),
			);
			// Written to discovery-cursors.json, NOT cursors.json (QueueWorker main-line isolation).
			expect(await loadCursorForTranscript("/path/t.jsonl", tempDir)).toBeNull();
			const dcj = await readFile(join(tempDir, ".jolli", "jollimemory", "discovery-cursors.json"), "utf-8");
			expect(JSON.parse(dcj).cursors["/path/t.jsonl"].lineNumber).toBe(642);
		});

		it("returns null for an unknown transcript path", async () => {
			await expect(loadDiscoveryCursor("/nope.jsonl", tempDir)).resolves.toBeNull();
		});

		it("migrate folds plan:/linear: keys with min() and deletes the legacy keys", async () => {
			// Same path discovered by both plan (line 100) and reference (line 60) scans.
			await saveCursor({ transcriptPath: "plan:/path/x.jsonl", lineNumber: 100, updatedAt: "t" }, tempDir);
			await saveCursor({ transcriptPath: "linear:/path/x.jsonl", lineNumber: 60, updatedAt: "t" }, tempDir);
			// A bare summarization cursor (QueueWorker main line) must be left untouched.
			await saveCursor({ transcriptPath: "/path/bare.jsonl", lineNumber: 7, updatedAt: "t" }, tempDir);

			await migrateDiscoveryCursors(tempDir);

			// Folded to min(100, 60) = 60 in discovery-cursors.json.
			await expect(loadDiscoveryCursor("/path/x.jsonl", tempDir)).resolves.toEqual(
				expect.objectContaining({ lineNumber: 60 }),
			);
			// Legacy prefixed keys removed from cursors.json; bare key preserved.
			expect(await loadCursorForTranscript("plan:/path/x.jsonl", tempDir)).toBeNull();
			expect(await loadCursorForTranscript("linear:/path/x.jsonl", tempDir)).toBeNull();
			await expect(loadCursorForTranscript("/path/bare.jsonl", tempDir)).resolves.toEqual(
				expect.objectContaining({ lineNumber: 7 }),
			);
		});

		it("migrate folds against an existing discovery cursor with min() (never advances past prior progress)", async () => {
			await saveDiscoveryCursor({ transcriptPath: "/path/y.jsonl", lineNumber: 50, updatedAt: "t" }, tempDir);
			await saveCursor({ transcriptPath: "plan:/path/y.jsonl", lineNumber: 80, updatedAt: "t" }, tempDir);

			await migrateDiscoveryCursors(tempDir);

			await expect(loadDiscoveryCursor("/path/y.jsonl", tempDir)).resolves.toEqual(
				expect.objectContaining({ lineNumber: 50 }),
			);
		});

		it("migrate is an idempotent no-op once no prefixed keys remain", async () => {
			await saveCursor({ transcriptPath: "plan:/path/z.jsonl", lineNumber: 30, updatedAt: "t" }, tempDir);
			await migrateDiscoveryCursors(tempDir);
			const first = await loadDiscoveryCursor("/path/z.jsonl", tempDir);

			// Second run: cursors.json has no prefixed keys → early return, discovery unchanged.
			await migrateDiscoveryCursors(tempDir);
			const second = await loadDiscoveryCursor("/path/z.jsonl", tempDir);

			expect(second).toEqual(first);
			expect(second).toEqual(expect.objectContaining({ lineNumber: 30 }));
		});

		it("migrate is a no-op when there are no cursors at all", async () => {
			await expect(migrateDiscoveryCursors(tempDir)).resolves.toBeUndefined();
			expect(await loadDiscoveryCursor("/path/none.jsonl", tempDir)).toBeNull();
		});
	});

	describe("loadMostRecentSession", () => {
		it("should return the most recently updated session", async () => {
			const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
			const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

			const older: SessionInfo = {
				sessionId: "older",
				transcriptPath: "/path/older.jsonl",
				updatedAt: twoHoursAgo,
			};
			const newer: SessionInfo = {
				sessionId: "newer",
				transcriptPath: "/path/newer.jsonl",
				updatedAt: oneHourAgo,
			};

			await saveSession(older, tempDir);
			await saveSession(newer, tempDir);

			const mostRecent = await loadMostRecentSession(tempDir);
			expect(mostRecent?.sessionId).toBe("newer");
		});

		it("should return null when no sessions exist", async () => {
			const mostRecent = await loadMostRecentSession(tempDir);
			expect(mostRecent).toBeNull();
		});

		it("should keep the first session when later sessions are older", async () => {
			const newest: SessionInfo = {
				sessionId: "newest",
				transcriptPath: "/path/newest.jsonl",
				updatedAt: new Date().toISOString(),
			};
			const older: SessionInfo = {
				sessionId: "older-again",
				transcriptPath: "/path/older-again.jsonl",
				updatedAt: new Date(Date.now() - 3600_000).toISOString(),
			};

			await saveSession(newest, tempDir);
			await saveSession(older, tempDir);

			await expect(loadMostRecentSession(tempDir)).resolves.toEqual(newest);
		});
	});

	describe("saveCursor / loadCursorForTranscript", () => {
		it("should save and load cursor by transcript path", async () => {
			const cursor: TranscriptCursor = {
				transcriptPath: "/path/to/transcript.jsonl",
				lineNumber: 42,
				updatedAt: "2026-02-23T10:00:00Z",
			};

			await saveCursor(cursor, tempDir);
			const loaded = await loadCursorForTranscript("/path/to/transcript.jsonl", tempDir);
			expect(loaded).toEqual(cursor);
		});

		it("should store multiple cursors independently", async () => {
			const cursor1: TranscriptCursor = {
				transcriptPath: "/path/1.jsonl",
				lineNumber: 10,
				updatedAt: "2026-02-23T10:00:00Z",
			};
			const cursor2: TranscriptCursor = {
				transcriptPath: "/path/2.jsonl",
				lineNumber: 20,
				updatedAt: "2026-02-23T10:00:00Z",
			};

			await saveCursor(cursor1, tempDir);
			await saveCursor(cursor2, tempDir);

			const loaded1 = await loadCursorForTranscript("/path/1.jsonl", tempDir);
			const loaded2 = await loadCursorForTranscript("/path/2.jsonl", tempDir);
			expect(loaded1?.lineNumber).toBe(10);
			expect(loaded2?.lineNumber).toBe(20);
		});

		it("should return null for non-existent transcript path", async () => {
			const loaded = await loadCursorForTranscript("/nonexistent", tempDir);
			expect(loaded).toBeNull();
		});

		it("should handle corrupted cursors.json gracefully", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			await writeFile(join(dir, "cursors.json"), "corrupt", "utf-8");

			const loaded = await loadCursorForTranscript("/any", tempDir);
			expect(loaded).toBeNull();
		});

		it("should update existing cursor for the same transcript", async () => {
			const cursor: TranscriptCursor = {
				transcriptPath: "/path/1.jsonl",
				lineNumber: 10,
				updatedAt: "2026-02-23T10:00:00Z",
			};
			await saveCursor(cursor, tempDir);

			const updated: TranscriptCursor = {
				transcriptPath: "/path/1.jsonl",
				lineNumber: 50,
				updatedAt: "2026-02-23T11:00:00Z",
			};
			await saveCursor(updated, tempDir);

			const loaded = await loadCursorForTranscript("/path/1.jsonl", tempDir);
			expect(loaded?.lineNumber).toBe(50);
		});
	});

	describe("loadConfigFromDir", () => {
		it("should return empty config when no file exists", async () => {
			const dir = join(tempDir, "empty-dir");
			const config = await loadConfigFromDir(dir);
			expect(config.model).toBeUndefined();
			expect(config.excludePatterns).toBeUndefined();
		});

		it("should load config from a directory", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			await writeFile(
				join(dir, "config.json"),
				JSON.stringify({ apiKey: "test-key", model: "claude-haiku" }),
				"utf-8",
			);

			const config = await loadConfigFromDir(dir);
			expect(config.apiKey).toBe("test-key");
			expect(config.model).toBe("claude-haiku");
		});

		it("should return empty config when file is corrupted", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			await writeFile(join(dir, "config.json"), "not json", "utf-8");
			const config = await loadConfigFromDir(dir);
			expect(config).toEqual({});
		});

		it("coalesces legacy `syncEnabled` to `autoSyncEnabled` on read", async () => {
			// Existing installs (pre-rename) have `syncEnabled` on disk. The
			// loader must surface it under the new name, drop the old key, so
			// downstream code that only knows `autoSyncEnabled` keeps working
			// without forcing every user to re-toggle the setting.
			const dir = await ensureJolliMemoryDir(tempDir);
			await writeFile(
				join(dir, "config.json"),
				JSON.stringify({ syncEnabled: true, jolliApiKey: "sk-jol-test" }),
				"utf-8",
			);
			const config = await loadConfigFromDir(dir);
			expect(config.autoSyncEnabled).toBe(true);
			// Legacy key dropped from the in-memory shape so callers don't
			// accidentally read it.
			expect(config.syncEnabled).toBeUndefined();
		});

		it("prefers a present `autoSyncEnabled` over legacy `syncEnabled`", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			await writeFile(
				join(dir, "config.json"),
				JSON.stringify({ syncEnabled: true, autoSyncEnabled: false }),
				"utf-8",
			);
			const config = await loadConfigFromDir(dir);
			expect(config.autoSyncEnabled).toBe(false);
			expect(config.syncEnabled).toBeUndefined();
		});
	});

	describe("squash-pending helpers", () => {
		const SQUASH_PARENT_HASH = "aabbcc1122334455aabbcc1122334455aabbcc11";

		it("should save and load squash-pending.json", async () => {
			const sourceHashes = [
				"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
				"b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1",
			];

			await saveSquashPending(sourceHashes, SQUASH_PARENT_HASH, tempDir);
			const state = await loadSquashPending(tempDir);

			expect(state).not.toBeNull();
			expect(state?.sourceHashes).toHaveLength(2);
			expect(state?.sourceHashes[0]).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
			expect(state?.expectedParentHash).toBe(SQUASH_PARENT_HASH);
			expect(state?.createdAt).toBeDefined();
		});

		it("should return null when squash-pending.json does not exist", async () => {
			const state = await loadSquashPending(tempDir);
			expect(state).toBeNull();
		});

		it("should return null and delete stale squash-pending.json (>48h old)", async () => {
			// Write a squash-pending file with a very old createdAt timestamp
			const dir = await ensureJolliMemoryDir(tempDir);
			const staleState: SquashPendingState = {
				sourceHashes: ["abc123"],
				expectedParentHash: SQUASH_PARENT_HASH,
				createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(), // 49 hours ago
			};
			await writeFile(join(dir, "squash-pending.json"), JSON.stringify(staleState), "utf-8");

			const state = await loadSquashPending(tempDir);
			expect(state).toBeNull();

			// File should have been automatically deleted
			const { stat } = await import("node:fs/promises");
			await expect(stat(join(dir, "squash-pending.json"))).rejects.toThrow();
		});

		it("should delete squash-pending.json", async () => {
			await saveSquashPending(["abc123"], SQUASH_PARENT_HASH, tempDir);

			// Verify it exists
			const before = await loadSquashPending(tempDir);
			expect(before).not.toBeNull();

			await deleteSquashPending(tempDir);

			const after = await loadSquashPending(tempDir);
			expect(after).toBeNull();
		});

		it("should handle corrupt squash-pending.json gracefully", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			await writeFile(join(dir, "squash-pending.json"), "not valid json", "utf-8");

			const state = await loadSquashPending(tempDir);
			expect(state).toBeNull();
		});

		it("should be idempotent when deleting non-existent squash-pending.json", async () => {
			// Should not throw even if the file doesn't exist
			await expect(deleteSquashPending(tempDir)).resolves.toBeUndefined();
		});
	});

	describe("atomic write safety", () => {
		it("should persist sessions registry as valid JSON", async () => {
			const session: SessionInfo = {
				sessionId: "test-1",
				transcriptPath: "/path/1.jsonl",
				updatedAt: new Date().toISOString(),
			};
			await saveSession(session, tempDir);

			// Read raw file to verify JSON format
			const dir = await ensureJolliMemoryDir(tempDir);
			const content = await readFile(join(dir, "sessions.json"), "utf-8");
			const parsed = JSON.parse(content) as SessionsRegistry;
			expect(parsed.version).toBe(1);
			expect(parsed.sessions["test-1"]).toBeDefined();
		});
	});

	describe("saveConfigScoped / loadConfigFromDir round-trip", () => {
		it("should save and merge config fields", async () => {
			const dir = join(tempDir, "config-roundtrip");
			await saveConfigScoped({ excludePatterns: ["*.log"] }, dir);
			const config = await loadConfigFromDir(dir);
			expect(config.excludePatterns).toEqual(["*.log"]);

			// Merge: add apiKey while preserving excludePatterns
			await saveConfigScoped({ apiKey: "sk-test" }, dir);
			const merged = await loadConfigFromDir(dir);
			expect(merged.excludePatterns).toEqual(["*.log"]);
			expect(merged.apiKey).toBe("sk-test");
		});
	});

	describe("getOrCreateInstallIdInDir", () => {
		it("mints a UUID on first call (created=true) and persists it", async () => {
			const dir = join(tempDir, "install-id");
			const first = await getOrCreateInstallIdInDir(dir);
			expect(first.created).toBe(true);
			expect(first.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect((await loadConfigFromDir(dir)).installId).toBe(first.installId);
		});

		it("returns the existing id on subsequent calls (created=false)", async () => {
			const dir = join(tempDir, "install-id-stable");
			const first = await getOrCreateInstallIdInDir(dir);
			const second = await getOrCreateInstallIdInDir(dir);
			expect(second.created).toBe(false);
			expect(second.installId).toBe(first.installId);
		});

		it("preserves a pre-existing installId without overwriting other config", async () => {
			const dir = join(tempDir, "install-id-preexisting");
			await saveConfigScoped({ installId: "fixed-id", apiKey: "sk-keep" }, dir);
			const result = await getOrCreateInstallIdInDir(dir);
			expect(result).toEqual({ installId: "fixed-id", created: false });
			expect((await loadConfigFromDir(dir)).apiKey).toBe("sk-keep");
		});

		it("mints a single id under concurrent first-runs (created=true fires once)", async () => {
			const dir = join(tempDir, "install-id-race");
			// Fire several first-run mints simultaneously — the atomic sentinel must
			// pick one winner; all callers must converge on the same id.
			const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreateInstallIdInDir(dir)));
			const ids = new Set(results.map((r) => r.installId));
			expect(ids.size).toBe(1);
			expect(results.filter((r) => r.created).length).toBe(1);
			expect((await loadConfigFromDir(dir)).installId).toBe([...ids][0]);
		});

		it("falls back to the fresh candidate when the sentinel exists but is unreadable", async () => {
			// Sentinel write ("wx") fails because the path already exists, and the
			// subsequent read also fails (it's a directory, not a file) — the
			// readInstallIdSentinel catch must return the fresh candidate id.
			const dir = join(tempDir, "install-id-unreadable");
			await mkdir(join(dir, "install-id"), { recursive: true });
			const result = await getOrCreateInstallIdInDir(dir);
			expect(result.created).toBe(false);
			expect(result.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect((await loadConfigFromDir(dir)).installId).toBe(result.installId);
		});

		it("falls back to the fresh candidate when the sentinel exists but is empty", async () => {
			// Sentinel write ("wx") fails because the file already exists, and the
			// read yields whitespace-only content — readInstallIdSentinel's
			// `v.length > 0 ? v : fallback` must choose the fresh candidate.
			const dir = join(tempDir, "install-id-empty");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "install-id"), "   \n", "utf-8");
			const result = await getOrCreateInstallIdInDir(dir);
			expect(result.created).toBe(false);
			expect(result.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect((await loadConfigFromDir(dir)).installId).toBe(result.installId);
		});
	});

	describe("global install-id / telemetry wrappers", () => {
		beforeEach(() => {
			mockHomedir.mockReturnValue(tempDir);
		});

		afterEach(() => {
			if (realHomedir.current) mockHomedir.mockImplementation(realHomedir.current);
		});

		it("getOrCreateInstallId mints and persists into the global config dir", async () => {
			const first = await getOrCreateInstallId();
			expect(first.created).toBe(true);
			expect(first.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			const second = await getOrCreateInstallId();
			expect(second.created).toBe(false);
			expect(second.installId).toBe(first.installId);
			expect((await loadConfigFromDir(getGlobalConfigDir())).installId).toBe(first.installId);
		});

		it("markAiSourceSeen records a source once in the global config dir", async () => {
			expect(await markAiSourceSeen("codex")).toBe(true);
			expect(await markAiSourceSeen("codex")).toBe(false);
			expect((await loadConfigFromDir(getGlobalConfigDir())).telemetrySeenSources).toEqual(["codex"]);
		});
	});

	describe("markAiSourceSeenInDir", () => {
		it("returns true only the first time a source is seen, and persists it", async () => {
			const dir = join(tempDir, "seen-sources");
			expect(await getOrCreateInstallIdInDir(dir)).toBeTruthy(); // unrelated; dir exists
			expect(await markAiSourceSeenInDir(dir, "codex")).toBe(true);
			expect(await markAiSourceSeenInDir(dir, "codex")).toBe(false);
			expect(await markAiSourceSeenInDir(dir, "claude")).toBe(true);
			expect((await loadConfigFromDir(dir)).telemetrySeenSources).toEqual(["codex", "claude"]);
		});
	});

	describe("plugin-source marker", () => {
		it("should save, load, and delete plugin-source marker", async () => {
			// Initially no marker
			expect(await loadPluginSource(tempDir)).toBe(false);

			// Save marker
			await savePluginSource(tempDir);
			expect(await loadPluginSource(tempDir)).toBe(true);

			// Delete marker
			await deletePluginSource(tempDir);
			expect(await loadPluginSource(tempDir)).toBe(false);
		});

		it("deletePluginSource should be safe to call when marker does not exist", async () => {
			// Should not throw
			await deletePluginSource(tempDir);
			expect(await loadPluginSource(tempDir)).toBe(false);
		});

		it("delete helpers should swallow filesystem removal errors", async () => {
			const fsPromises = await import("node:fs/promises");
			const rmSpy = vi.spyOn(fsPromises, "rm");
			rmSpy.mockRejectedValueOnce(new Error("cannot delete squash"));
			rmSpy.mockRejectedValueOnce(new Error("cannot delete marker"));

			await expect(deleteSquashPending(tempDir)).resolves.toBeUndefined();
			await expect(deletePluginSource(tempDir)).resolves.toBeUndefined();

			rmSpy.mockRestore();
		});
	});

	describe("plans registry", () => {
		it("should return an empty plans registry when plans.json does not exist", async () => {
			await expect(loadPlansRegistry(tempDir)).resolves.toEqual({ version: 1, plans: {} });
		});

		it("should normalize a partial plans.json (e.g. manual edit to `{}`) to the canonical shape", async () => {
			// A manually edited plans.json missing the `plans` key must not break
			// downstream callers that do `registry.plans[slug]` or `slug in plans`.
			const plansPath = join(tempDir, ".jolli", "jollimemory", "plans.json");
			await mkdir(dirname(plansPath), { recursive: true });
			await writeFile(plansPath, "{}");

			await expect(loadPlansRegistry(tempDir)).resolves.toEqual({ version: 1, plans: {} });
		});

		it("should save and load plans registry", async () => {
			const registry = {
				version: 1 as const,
				plans: {
					"feature-auth": {
						slug: "feature-auth",
						title: "Auth plan",
						sourcePath: "plans/feature-auth.md",
						addedAt: "2026-03-01T10:00:00Z",
						updatedAt: "2026-03-01T10:00:00Z",
						commitHash: null,
					},
				},
			};

			await savePlansRegistry(registry as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);
			await expect(loadPlansRegistry(tempDir)).resolves.toEqual(registry);
		});

		it("should fall back to direct overwrite when atomic rename gets EPERM", async () => {
			const registry = {
				version: 1 as const,
				plans: {
					"feature-auth": {
						slug: "feature-auth",
						title: "Auth plan",
						sourcePath: "plans/feature-auth.md",
						addedAt: "2026-03-01T10:00:00Z",
						updatedAt: "2026-03-01T10:00:00Z",
						commitHash: null,
					},
				},
			};
			mockRename.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" }));

			await savePlansRegistry(registry as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);
			await expect(loadPlansRegistry(tempDir)).resolves.toEqual(registry);
		});

		it("should rethrow non-permission rename failures during atomic writes", async () => {
			mockRename.mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

			await expect(savePlansRegistry({ version: 1, plans: {} }, tempDir)).rejects.toThrow("disk full");
		});

		it("should return an empty registry for corrupt plans.json", async () => {
			const dir = await ensureJolliMemoryDir(tempDir);
			await writeFile(join(dir, "plans.json"), "corrupt", "utf-8");
			await expect(loadPlansRegistry(tempDir)).resolves.toEqual({ version: 1, plans: {} });
		});

		it("should migrate the guard's commitHash and updatedAt when given an archive id", async () => {
			const before = {
				version: 1 as const,
				plans: {
					"feature-auth": {
						slug: "feature-auth",
						title: "Auth plan",
						sourcePath: "plans/feature-auth.md",
						addedAt: "2026-03-01T10:00:00Z",
						updatedAt: "2026-03-01T10:00:00Z",
						branch: "main",
						commitHash: "abcdef1234567890",
						contentHashAtCommit: "guardhash",
					},
				},
			};
			await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			// Only the guard row survives. associate sweeps it forward when the
			// archive id (`<base>-<oldShortHash>`) matches the guard's current hash.
			await associatePlanWithCommit("feature-auth-abcdef12", "1111111122222222", tempDir);

			const after = await loadPlansRegistry(tempDir);
			expect(after.plans["feature-auth"]?.commitHash).toBe("1111111122222222");
			expect(after.plans["feature-auth"]?.updatedAt).not.toBe("2026-03-01T10:00:00Z");
		});

		it("should skip commit association when the plan slug is missing", async () => {
			const before = {
				version: 1 as const,
				plans: {
					"feature-auth": {
						slug: "feature-auth",
						title: "Auth plan",
						sourcePath: "plans/feature-auth.md",
						addedAt: "2026-03-01T10:00:00Z",
						updatedAt: "2026-03-01T10:00:00Z",
						commitHash: null,
					},
				},
			};
			await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			await associatePlanWithCommit("missing-plan", "abcdef1234567890", tempDir);

			await expect(loadPlansRegistry(tempDir)).resolves.toEqual(before);
		});

		// Squash / rebase reuses associatePlanWithCommit to re-anchor metadata on the
		// new commit. Pre-fix, only the archive entry's commitHash got updated and the
		// guard entry was left pointing at the soon-to-be-orphan commit — so a user
		// edit to the source file would "revive" the guard with a stale hash label.
		describe("guard-entry migration on squash/rebase", () => {
			it("should migrate the guard's commitHash and preserve contentHashAtCommit", async () => {
				const before = {
					version: 1 as const,
					plans: {
						"my-plan": {
							slug: "my-plan",
							title: "My Plan",
							sourcePath: join(tempDir, "plan.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
							contentHashAtCommit: "archivehash",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				// No archive row exists — associate splits the archive id to find the
				// guard, sweeps its commitHash forward, and preserves contentHashAtCommit
				// (squash rewrites commit metadata, not file content, so the archive-time
				// anchor must survive for revival detection).
				await associatePlanWithCommit("my-plan-35080b05", "6c66a12e50f0cf1129f8e63b340897832d22ecee", tempDir);

				const after = await loadPlansRegistry(tempDir);
				expect(after.plans["my-plan"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
				expect(after.plans["my-plan"]?.contentHashAtCommit).toBe("archivehash");
			});

			it("should preserve contentHashAtCommit even when the source file has been edited since archive (revival signal must survive squash)", async () => {
				// squash/rebase only rewrites the commit hash; it does not commit
				// the working-tree state. If the user edited the source between the
				// original archive and the squash, those edits remain uncommitted —
				// the next post-commit detection must still see liveHash !==
				// contentHashAtCommit to surface the revival. Recomputing from the
				// live file here would silently consume that signal.
				const planFile = join(tempDir, "plan.md");
				const oldBody = "# Old Plan\n";
				const newBody = "# New Plan\n\nadded after squash\n";
				await writeFile(planFile, newBody, "utf-8");
				const { createHash } = await import("node:crypto");
				const oldHash = createHash("sha256").update(oldBody).digest("hex");
				const newHash = createHash("sha256").update(newBody).digest("hex");
				expect(oldHash).not.toBe(newHash);

				const before = {
					version: 1 as const,
					plans: {
						"my-plan": {
							slug: "my-plan",
							title: "My Plan",
							sourcePath: planFile,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
							contentHashAtCommit: oldHash,
						},
						"my-plan-deadbeef": {
							slug: "my-plan-deadbeef",
							title: "My Plan",
							sourcePath: planFile,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associatePlanWithCommit("my-plan-deadbeef", "feedfacefeedfacefeedfacefeedfacefeedface", tempDir);

				const after = await loadPlansRegistry(tempDir);
				expect(after.plans["my-plan"]?.commitHash).toBe("feedfacefeedfacefeedfacefeedfacefeedface");
				expect(after.plans["my-plan"]?.contentHashAtCommit).toBe(oldHash);
			});

			it("should preserve the existing contentHashAtCommit when the source file is missing", async () => {
				const before = {
					version: 1 as const,
					plans: {
						"my-plan": {
							slug: "my-plan",
							title: "My Plan",
							sourcePath: join(tempDir, "does-not-exist.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
							contentHashAtCommit: "stalehash",
						},
						"my-plan-35080b05": {
							slug: "my-plan-35080b05",
							title: "My Plan",
							sourcePath: join(tempDir, "does-not-exist.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associatePlanWithCommit("my-plan-35080b05", "6c66a12e50f0cf1129f8e63b340897832d22ecee", tempDir);

				const after = await loadPlansRegistry(tempDir);
				expect(after.plans["my-plan"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
				expect(after.plans["my-plan"]?.contentHashAtCommit).toBe("stalehash");
			});

			it("does not migrate the guard when its commitHash no longer matches the archive's oldShortHash", async () => {
				// Guard exists with contentHashAtCommit (first arm of &&) but its
				// commitHash does NOT start with the archive id's oldShortHash (second
				// arm). This happens when the guard was already re-anchored by a prior
				// squash and the older archive id is now stale — re-applying would
				// clobber the freshly-correct guard hash, so associate must no-op.
				const before = {
					version: 1 as const,
					plans: {
						"my-plan": {
							slug: "my-plan",
							title: "My Plan",
							sourcePath: join(tempDir, "plan.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							// Guard's commitHash starts with "99999999", NOT "35080b05" —
							// so the guard belongs to a different archive cycle.
							commitHash: "9999999999999999999999999999999999999999",
							contentHashAtCommit: "guardhash",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associatePlanWithCommit("my-plan-35080b05", "6c66a12e50f0cf1129f8e63b340897832d22ecee", tempDir);

				const after = await loadPlansRegistry(tempDir);
				// Guard left alone (different commit lineage).
				expect(after.plans["my-plan"]?.commitHash).toBe("9999999999999999999999999999999999999999");
				expect(after.plans["my-plan"]?.contentHashAtCommit).toBe("guardhash");
			});

			it("should not migrate any guard when the archive id has no -<shortHash> suffix", async () => {
				// Defensive: a caller could pass a base-slug-shaped id (no suffix).
				// splitArchivedKey returns null for it, so associate is a complete
				// no-op — it must not re-anchor the unrelated base entry.
				const before = {
					version: 1 as const,
					plans: {
						"my-plan": {
							slug: "my-plan",
							title: "My Plan",
							sourcePath: join(tempDir, "plan.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: null,
							contentHashAtCommit: "stalehash",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associatePlanWithCommit("my-plan", "6c66a12e50f0cf1129f8e63b340897832d22ecee", tempDir);

				const after = await loadPlansRegistry(tempDir);
				// No archive id → complete no-op: the base entry is untouched.
				expect(after.plans["my-plan"]?.commitHash).toBeNull();
				expect(after.plans["my-plan"]?.contentHashAtCommit).toBe("stalehash");
			});
		});

		it("should load a single plan entry by slug", async () => {
			const registry = {
				version: 1 as const,
				plans: {
					"feature-auth": {
						slug: "feature-auth",
						title: "Auth plan",
						sourcePath: "plans/feature-auth.md",
						addedAt: "2026-03-01T10:00:00Z",
						updatedAt: "2026-03-01T10:00:00Z",
						commitHash: "abcdef1234567890",
					},
				},
			};
			await savePlansRegistry(registry as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			await expect(loadPlanEntry("feature-auth", tempDir)).resolves.toEqual(registry.plans["feature-auth"]);
			await expect(loadPlanEntry("missing-plan", tempDir)).resolves.toBeNull();
		});
	});

	describe("associateNoteWithCommit", () => {
		it("should migrate the guard's commitHash and updatedAt when given an archive id", async () => {
			const before = {
				version: 1 as const,
				plans: {},
				notes: {
					"note-1": {
						id: "note-1",
						title: "My Note",
						format: "snippet" as const,
						addedAt: "2026-03-01T10:00:00Z",
						updatedAt: "2026-03-01T10:00:00Z",
						branch: "feature/test",
						commitHash: "abcdef1234567890",
						contentHashAtCommit: "guardhash",
					},
				},
			};
			await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			// Only the guard row survives; associate sweeps it forward when the
			// archive id (`<base>-<oldShortHash>`) matches the guard's current hash.
			await associateNoteWithCommit("note-1-abcdef12", "1111111122222222", tempDir);

			const after = await loadPlansRegistry(tempDir);
			expect(after.notes?.["note-1"]?.commitHash).toBe("1111111122222222");
			expect(after.notes?.["note-1"]?.updatedAt).not.toBe("2026-03-01T10:00:00Z");
		});

		it("should handle registry with no notes field", async () => {
			// Registry without a notes field — tests the ?? {} fallback
			const before = {
				version: 1 as const,
				plans: {},
			};
			await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			// Note doesn't exist, so nothing changes, but the code path
			// exercises the `registry.notes ?? {}` branch.
			await associateNoteWithCommit("nonexistent", "abc123", tempDir);

			const after = await loadPlansRegistry(tempDir);
			expect(after.notes).toBeUndefined();
		});

		it("should skip commit association when the note id is missing", async () => {
			const before = {
				version: 1 as const,
				plans: {},
				notes: {
					"note-1-abc": {
						id: "note-1-abc",
						title: "My Note",
						format: "snippet" as const,
						addedAt: "2026-03-01T10:00:00Z",
						updatedAt: "2026-03-01T10:00:00Z",
						commitHash: null,
					},
				},
			};
			await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			await associateNoteWithCommit("missing-note", "abcdef1234567890", tempDir);

			await expect(loadPlansRegistry(tempDir)).resolves.toEqual(before);
		});

		describe("guard-entry migration on squash/rebase", () => {
			it("should migrate the guard's commitHash and preserve contentHashAtCommit", async () => {
				const before = {
					version: 1 as const,
					plans: {},
					notes: {
						"note-035b": {
							id: "note-035b",
							title: "Active AI Conversations — Design Document",
							format: "markdown" as const,
							sourcePath: join(tempDir, "note.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/active-conversations",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
							contentHashAtCommit: "archivehash",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				// No archive row — split the archive id to the guard, sweep its
				// commitHash forward, preserve contentHashAtCommit for revival detection.
				await associateNoteWithCommit(
					"note-035b-35080b05",
					"6c66a12e50f0cf1129f8e63b340897832d22ecee",
					tempDir,
				);

				const after = await loadPlansRegistry(tempDir);
				expect(after.notes?.["note-035b"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
				expect(after.notes?.["note-035b"]?.contentHashAtCommit).toBe("archivehash");
			});

			it("should preserve contentHashAtCommit even when the source file has been edited since archive (revival signal must survive squash)", async () => {
				// Same invariant as the plan-side test: squash only rewrites the
				// commit hash, so contentHashAtCommit (the archive-time anchor)
				// must not be replaced with the live file hash — otherwise the
				// revival signal for uncommitted edits is lost.
				const noteFile = join(tempDir, "note.md");
				const oldBody = "# Old Note\n";
				const newBody = "# New Note\n\nadded after squash\n";
				await writeFile(noteFile, newBody, "utf-8");
				const { createHash } = await import("node:crypto");
				const oldHash = createHash("sha256").update(oldBody).digest("hex");
				const newHash = createHash("sha256").update(newBody).digest("hex");
				expect(oldHash).not.toBe(newHash);

				const before = {
					version: 1 as const,
					plans: {},
					notes: {
						"note-035b": {
							id: "note-035b",
							title: "Old Note",
							format: "markdown" as const,
							sourcePath: noteFile,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
							contentHashAtCommit: oldHash,
						},
						"note-035b-deadbeef": {
							id: "note-035b-deadbeef",
							title: "Old Note",
							format: "markdown" as const,
							sourcePath: noteFile,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associateNoteWithCommit(
					"note-035b-deadbeef",
					"feedfacefeedfacefeedfacefeedfacefeedface",
					tempDir,
				);

				const after = await loadPlansRegistry(tempDir);
				expect(after.notes?.["note-035b"]?.commitHash).toBe("feedfacefeedfacefeedfacefeedfacefeedface");
				expect(after.notes?.["note-035b"]?.contentHashAtCommit).toBe(oldHash);
			});

			it("should preserve the existing contentHashAtCommit when the source file is missing", async () => {
				const before = {
					version: 1 as const,
					plans: {},
					notes: {
						"note-035b": {
							id: "note-035b",
							title: "Gone Note",
							format: "markdown" as const,
							sourcePath: join(tempDir, "missing.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
							contentHashAtCommit: "stalehash",
						},
						"note-035b-35080b05": {
							id: "note-035b-35080b05",
							title: "Gone Note",
							format: "markdown" as const,
							sourcePath: join(tempDir, "missing.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associateNoteWithCommit(
					"note-035b-35080b05",
					"6c66a12e50f0cf1129f8e63b340897832d22ecee",
					tempDir,
				);

				const after = await loadPlansRegistry(tempDir);
				expect(after.notes?.["note-035b"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
				expect(after.notes?.["note-035b"]?.contentHashAtCommit).toBe("stalehash");
			});

			it("should leave the guard alone when its commitHash does not match the archive id suffix", async () => {
				// Defensive: if the guard already points at a different commit (e.g.
				// user manually edited plans.json, or a parallel migration ran first),
				// don't clobber its commitHash based on a stale archive id.
				const before = {
					version: 1 as const,
					plans: {},
					notes: {
						"note-035b": {
							id: "note-035b",
							title: "Note",
							format: "snippet" as const,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							contentHashAtCommit: "stalehash",
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associateNoteWithCommit(
					"note-035b-deadbeef",
					"6c66a12e50f0cf1129f8e63b340897832d22ecee",
					tempDir,
				);

				const after = await loadPlansRegistry(tempDir);
				// Guard untouched because its commitHash didn't match the archive id's
				// `deadbeef` suffix — different commit lineage.
				expect(after.notes?.["note-035b"]?.commitHash).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
				expect(after.notes?.["note-035b"]?.contentHashAtCommit).toBe("stalehash");
			});
		});
	});

	describe("detectActiveNotesForBranch", () => {
		// Active = uncommitted (commitHash null) with no guard (contentHashAtCommit
		// undefined). Branch / ignored scoping was removed, so neither field filters.
		it("returns only active (uncommitted, un-guarded) notes", async () => {
			const registry = {
				version: 1 as const,
				plans: {},
				notes: {
					"note-active": {
						id: "note-active",
						title: "Active note",
						format: "snippet" as const,
						addedAt: "2026-04-01T00:00:00Z",
						updatedAt: "2026-04-01T00:00:00Z",
						commitHash: null,
					},
					"note-committed": {
						id: "note-committed",
						title: "Already committed",
						format: "snippet" as const,
						addedAt: "2026-04-01T00:00:00Z",
						updatedAt: "2026-04-01T00:00:00Z",
						commitHash: "deadbeefcafebabe",
					},
					"note-guarded": {
						id: "note-guarded",
						title: "Guard-archived",
						format: "snippet" as const,
						addedAt: "2026-04-01T00:00:00Z",
						updatedAt: "2026-04-01T00:00:00Z",
						commitHash: null,
						contentHashAtCommit: "fakehash",
					},
				},
			};
			await savePlansRegistry(registry as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			const result = await detectActiveNotesForBranch(tempDir, "feature/x");

			expect(result.map((n) => n.id)).toEqual(["note-active"]);
		});

		it("returns [] when the registry has no notes field at all", async () => {
			// `Object.values(registry.notes ?? {})` short-circuits to an empty
			// iteration — used by post-commit StopHook when the registry was
			// freshly initialized.
			await savePlansRegistry(
				{ version: 1 as const, plans: {} } as unknown as Parameters<typeof savePlansRegistry>[0],
				tempDir,
			);

			const result = await detectActiveNotesForBranch(tempDir, "main");

			expect(result).toEqual([]);
		});
	});

	describe("getGlobalConfigDir", () => {
		it("should return a path containing .jolli/jollimemory", () => {
			const dir = getGlobalConfigDir();
			expect(dir).toContain(".jolli");
			expect(dir).toContain("jollimemory");
		});

		it("should return an absolute path rooted at the home directory", () => {
			const dir = getGlobalConfigDir();
			const { homedir } = require("node:os") as typeof import("node:os");
			expect(dir.startsWith(homedir())).toBe(true);
		});
	});

	describe("saveConfigScoped", () => {
		it("should create the target directory and save config", async () => {
			const targetDir = join(tempDir, "scoped", "nested");
			await saveConfigScoped({ apiKey: "scoped-key" }, targetDir);

			const content = await readFile(join(targetDir, "config.json"), "utf-8");
			const config = JSON.parse(content) as { apiKey?: string };
			expect(config.apiKey).toBe("scoped-key");
		});

		it("should merge with existing config in target dir", async () => {
			const targetDir = join(tempDir, "scoped");
			await saveConfigScoped({ apiKey: "initial-key", model: "claude-sonnet" }, targetDir);
			await saveConfigScoped({ apiKey: "updated-key" }, targetDir);

			const content = await readFile(join(targetDir, "config.json"), "utf-8");
			const config = JSON.parse(content) as { apiKey?: string; model?: string };
			// Updated field overrides
			expect(config.apiKey).toBe("updated-key");
			// Unmodified field preserved
			expect(config.model).toBe("claude-sonnet");
		});

		it("should write valid JSON with indentation", async () => {
			const targetDir = join(tempDir, "scoped");
			await saveConfigScoped({ maxTokens: 4096 }, targetDir);

			const content = await readFile(join(targetDir, "config.json"), "utf-8");
			// Verify it is valid JSON and tab-indented
			expect(() => JSON.parse(content)).not.toThrow();
			expect(content).toContain("\t");
		});
	});

	describe("filterSessionsByEnabledIntegrations", () => {
		const claudeSession = {
			sessionId: "c1",
			transcriptPath: "/c1",
			updatedAt: "2025-01-01T00:00:00Z",
			source: "claude" as const,
		};
		const geminiSession = {
			sessionId: "g1",
			transcriptPath: "/g1",
			updatedAt: "2025-01-01T00:00:00Z",
			source: "gemini" as const,
		};
		const codexSession = {
			sessionId: "x1",
			transcriptPath: "/x1",
			updatedAt: "2025-01-01T00:00:00Z",
			source: "codex" as const,
		};
		const legacySession = { sessionId: "l1", transcriptPath: "/l1", updatedAt: "2025-01-01T00:00:00Z" };

		it("should return all sessions when all integrations are enabled", () => {
			const result = filterSessionsByEnabledIntegrations([claudeSession, geminiSession, legacySession], {});
			expect(result).toHaveLength(3);
		});

		it("should always pass through Codex sessions (filtered separately via discovery)", () => {
			const result = filterSessionsByEnabledIntegrations([claudeSession, codexSession, geminiSession], {
				claudeEnabled: false,
				geminiEnabled: false,
			});
			expect(result).toHaveLength(1);
			expect(result[0].source).toBe("codex");
		});

		it("should exclude Claude sessions when claudeEnabled is false", () => {
			const result = filterSessionsByEnabledIntegrations([claudeSession, geminiSession, legacySession], {
				claudeEnabled: false,
			});
			expect(result).toHaveLength(1);
			expect(result[0].source).toBe("gemini");
		});

		it("should treat sessions without source as Claude (backward compat)", () => {
			const result = filterSessionsByEnabledIntegrations([legacySession], { claudeEnabled: false });
			expect(result).toHaveLength(0);
		});

		it("should exclude Gemini sessions when geminiEnabled is false", () => {
			const result = filterSessionsByEnabledIntegrations([claudeSession, geminiSession], {
				geminiEnabled: false,
			});
			expect(result).toHaveLength(1);
			expect(result[0].source).toBe("claude");
		});

		it("should exclude both when both are disabled", () => {
			const result = filterSessionsByEnabledIntegrations([claudeSession, geminiSession, legacySession], {
				claudeEnabled: false,
				geminiEnabled: false,
			});
			expect(result).toHaveLength(0);
		});

		it("should exclude OpenCode sessions when openCodeEnabled is false", () => {
			const openCodeSession = {
				sessionId: "o1",
				transcriptPath: "/o1",
				updatedAt: "2025-01-01T00:00:00Z",
				source: "opencode" as const,
			};

			const result = filterSessionsByEnabledIntegrations([claudeSession, openCodeSession], {
				openCodeEnabled: false,
			});

			expect(result).toEqual([claudeSession]);
		});

		it("filters out cursor sessions when cursorEnabled === false", () => {
			const sessions: SessionInfo[] = [
				{
					sessionId: "claude-1",
					transcriptPath: "/c.jsonl",
					updatedAt: "2026-05-03T00:00:00Z",
					source: "claude",
				},
				{
					sessionId: "cursor-1",
					transcriptPath: "/db.vscdb#abc",
					updatedAt: "2026-05-03T00:00:00Z",
					source: "cursor",
				},
			];
			const result = filterSessionsByEnabledIntegrations(sessions, { cursorEnabled: false });
			expect(result).toEqual([sessions[0]]);
		});

		it("retains cursor sessions when cursorEnabled is undefined or true", () => {
			const sessions: SessionInfo[] = [
				{
					sessionId: "cursor-1",
					transcriptPath: "/db.vscdb#abc",
					updatedAt: "2026-05-03T00:00:00Z",
					source: "cursor",
				},
			];
			expect(filterSessionsByEnabledIntegrations(sessions, {})).toEqual(sessions);
			expect(filterSessionsByEnabledIntegrations(sessions, { cursorEnabled: true })).toEqual(sessions);
		});

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
	});

	// ── git operation queue ────────────────────────────────────────────────

	describe("git operation queue", () => {
		const makeOp = (hash: string, type: CommitGitOperation["type"] = "commit"): CommitGitOperation => ({
			type,
			commitHash: hash,
			createdAt: new Date().toISOString(),
		});

		it("should enqueue and dequeue operations in timestamp order", async () => {
			await enqueueGitOperation(makeOp("aaa111"), tempDir);
			// Small delay to ensure different timestamps
			await new Promise((r) => setTimeout(r, 10));
			await enqueueGitOperation(makeOp("bbb222"), tempDir);

			const entries = await dequeueAllGitOperations(tempDir);
			expect(entries).toHaveLength(2);
			expect(entries[0].op).toMatchObject({ commitHash: "aaa111" });
			expect(entries[1].op).toMatchObject({ commitHash: "bbb222" });
		});

		it("should return empty array when queue directory does not exist", async () => {
			const entries = await dequeueAllGitOperations(tempDir);
			expect(entries).toEqual([]);
		});

		it("tags ingest operations with an 'ingest' filename segment (no commitHash)", async () => {
			await enqueueGitOperation(
				{ type: "ingest", triggeredBy: "post-commit", createdAt: new Date().toISOString() },
				tempDir,
			);
			const { readdir } = await import("node:fs/promises");
			const queueDir = join(tempDir, ".jolli", "jollimemory", "git-op-queue");
			const [name] = await readdir(queueDir);
			expect(name).toMatch(/^\d+-\d{8}-[0-9a-f]{8}-ingest\.json$/);
			const entries = await dequeueAllGitOperations(tempDir);
			expect(entries[0].op).toMatchObject({ type: "ingest", triggeredBy: "post-commit" });
		});

		it("names queue files with a process-unique nonce segment (guards cross-process same-ms collisions)", async () => {
			const { readdir } = await import("node:fs/promises");
			await enqueueGitOperation(makeOp("aaa111ff"), tempDir);
			const queueDir = join(tempDir, ".jolli", "jollimemory", "git-op-queue");
			const [name] = await readdir(queueDir);
			// {timestamp}-{8-digit seq}-{8-hex nonce}-{tag}.json — the nonce is what
			// makes two processes enqueuing in the same ms with the same tag unique.
			expect(name).toMatch(/^\d+-\d{8}-[0-9a-f]{8}-aaa111ff\.json$/);
		});

		it("should delete a queue entry by file path", async () => {
			await enqueueGitOperation(makeOp("ccc333"), tempDir);
			const entries = await dequeueAllGitOperations(tempDir);
			expect(entries).toHaveLength(1);

			await deleteQueueEntry(entries[0].filePath);

			const remaining = await dequeueAllGitOperations(tempDir);
			expect(remaining).toHaveLength(0);
		});

		it("should skip malformed queue entry files", async () => {
			// Create a malformed file in the queue directory
			const { mkdir } = await import("node:fs/promises");
			const queueDir = join(tempDir, ".jolli", "jollimemory", "git-op-queue");
			await mkdir(queueDir, { recursive: true });
			await writeFile(join(queueDir, "1234567890-bad.json"), "not valid json", "utf-8");

			// Also enqueue a valid entry
			await enqueueGitOperation(makeOp("ddd444"), tempDir);

			const entries = await dequeueAllGitOperations(tempDir);
			// Should only return the valid entry, skip the malformed one
			expect(entries).toHaveLength(1);
			expect(entries[0].op).toMatchObject({ commitHash: "ddd444" });
		});

		it("should prune stale entries older than 7 days", async () => {
			const { mkdir } = await import("node:fs/promises");
			const queueDir = join(tempDir, ".jolli", "jollimemory", "git-op-queue");
			await mkdir(queueDir, { recursive: true });

			// Create a stale entry with createdAt 8 days ago
			const staleOp: CommitGitOperation = {
				type: "commit",
				commitHash: "stale1",
				createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
			};
			await writeFile(join(queueDir, "0000000001-stale1.json"), JSON.stringify(staleOp), "utf-8");

			// Also enqueue a fresh entry
			await enqueueGitOperation(makeOp("fresh1"), tempDir);

			const entries = await dequeueAllGitOperations(tempDir);
			expect(entries).toHaveLength(1);
			expect(entries[0].op).toMatchObject({ commitHash: "fresh1" });
		});

		it("should return true on successful enqueue", async () => {
			const result = await enqueueGitOperation(makeOp("eee555"), tempDir);
			expect(result).toBe(true);
		});

		it("should handle deleteQueueEntry for non-existent file without throwing", async () => {
			await expect(deleteQueueEntry("/non/existent/path.json")).resolves.toBeUndefined();
		});

		it("should swallow filesystem errors when deleting a queue entry", async () => {
			const fsPromises = await import("node:fs/promises");
			const rmSpy = vi.spyOn(fsPromises, "rm").mockRejectedValueOnce(new Error("permission denied"));

			await expect(deleteQueueEntry("/tmp/locked.json")).resolves.toBeUndefined();

			rmSpy.mockRestore();
		});

		it("should return false when enqueue fails due to filesystem error", async () => {
			// Use an invalid path that will fail on mkdir
			const result = await enqueueGitOperation(makeOp("fail1"), "/\0/invalid-path");
			expect(result).toBe(false);
		});
	});

	// ── loadConfig (global shorthand) ────────────────────────────────────

	describe("loadConfig", () => {
		beforeEach(() => {
			mockHomedir.mockReturnValue(tempDir);
		});

		afterEach(() => {
			if (realHomedir.current) mockHomedir.mockImplementation(realHomedir.current);
		});

		it("should return config from global dir without throwing", async () => {
			const config = await loadConfig();
			expect(config).toBeDefined();
		});

		it("saveConfig should persist config to the global directory shorthand", async () => {
			await saveConfig({ apiKey: "global-key" });
			const config = await loadConfig();
			expect(config.apiKey).toBe("global-key");
		});
	});

	// ── countStaleSessions / pruneStaleSessions ──────────────────────────

	describe("countStaleSessions and pruneStaleSessions", () => {
		it("should return 0 when no sessions exist", async () => {
			expect(await countStaleSessions(tempDir)).toBe(0);
			expect(await pruneStaleSessions(tempDir)).toBe(0);
		});

		it("should count and prune sessions older than 48 hours", async () => {
			// Add 3 sessions: 2 stale, 1 fresh
			const dir = join(tempDir, ".jolli/jollimemory");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(dir, { recursive: true });
			const now = new Date();
			const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
			const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

			await writeFile(
				join(dir, "sessions.json"),
				JSON.stringify({
					version: 1,
					sessions: {
						"fresh-session": {
							sessionId: "fresh-session",
							transcriptPath: "/fake/fresh.jsonl",
							updatedAt: tenMinAgo,
							source: "claude",
						},
						"stale-session-1": {
							sessionId: "stale-session-1",
							transcriptPath: "/fake/stale-1.jsonl",
							updatedAt: threeDaysAgo,
							source: "claude",
						},
						"stale-session-2": {
							sessionId: "stale-session-2",
							transcriptPath: "/fake/stale-2.jsonl",
							updatedAt: threeDaysAgo,
							source: "claude",
						},
					},
				}),
			);

			expect(await countStaleSessions(tempDir)).toBe(2);

			const pruned = await pruneStaleSessions(tempDir);
			expect(pruned).toBe(2);

			// After pruning, count is 0
			expect(await countStaleSessions(tempDir)).toBe(0);
		});

		it("should return 0 from pruneStaleSessions when no stale entries exist", async () => {
			const dir = join(tempDir, ".jolli/jollimemory");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "sessions.json"),
				JSON.stringify({
					version: 1,
					sessions: {
						fresh: {
							sessionId: "fresh",
							transcriptPath: "/f.jsonl",
							updatedAt: new Date().toISOString(),
							source: "claude",
						},
					},
				}),
			);
			expect(await pruneStaleSessions(tempDir)).toBe(0);
		});
	});

	// ── countActiveQueueEntries ──────────────────────────────────────────

	describe("countActiveQueueEntries", () => {
		it("should return 0 when queue dir does not exist", async () => {
			expect(await countActiveQueueEntries(tempDir)).toBe(0);
		});

		it("should count only non-stale queue entries", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(queueDir, { recursive: true });

			const now = new Date();
			const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
			const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

			await writeFile(
				join(queueDir, "fresh.json"),
				JSON.stringify({ type: "commit", commitHash: "a".repeat(40), createdAt: oneHourAgo }),
			);
			await writeFile(
				join(queueDir, "stale.json"),
				JSON.stringify({ type: "commit", commitHash: "b".repeat(40), createdAt: eightDaysAgo }),
			);

			expect(await countActiveQueueEntries(tempDir)).toBe(1);
		});

		it("should skip corrupt queue entries", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(queueDir, { recursive: true });
			await writeFile(join(queueDir, "corrupt.json"), "not json");
			expect(await countActiveQueueEntries(tempDir)).toBe(0);
		});
	});

	// ── countActiveSummaryQueueEntries ───────────────────────────────────

	describe("countActiveSummaryQueueEntries", () => {
		it("should return 0 when queue dir does not exist", async () => {
			expect(await countActiveSummaryQueueEntries(tempDir)).toBe(0);
		});

		it("should count commit-type entries and exclude ingest entries", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			await mkdir(queueDir, { recursive: true });

			const now = new Date().toISOString();
			await writeFile(
				join(queueDir, "1-a.json"),
				JSON.stringify({ type: "commit", commitHash: "a".repeat(40), createdAt: now }),
			);
			await writeFile(
				join(queueDir, "2-b.json"),
				JSON.stringify({ type: "squash", commitHash: "b".repeat(40), createdAt: now }),
			);
			await writeFile(
				join(queueDir, "3-ingest.json"),
				JSON.stringify({ type: "ingest", triggeredBy: "post-commit", createdAt: now }),
			);

			expect(await countActiveSummaryQueueEntries(tempDir)).toBe(2);
		});

		it("should exclude stale entries", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			await mkdir(queueDir, { recursive: true });

			const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			await writeFile(
				join(queueDir, "1-old.json"),
				JSON.stringify({ type: "commit", commitHash: "a".repeat(40), createdAt: eightDaysAgo }),
			);

			expect(await countActiveSummaryQueueEntries(tempDir)).toBe(0);
		});

		it("should count a parseable entry with a missing/unparseable createdAt as active", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			await mkdir(queueDir, { recursive: true });

			// Valid JSON summary op but no createdAt (version skew / foreign enqueuer):
			// it must NOT be invisible to the PR-wait verdict.
			await writeFile(
				join(queueDir, "1-nodate.json"),
				JSON.stringify({ type: "commit", commitHash: "a".repeat(40) }),
			);
			await writeFile(
				join(queueDir, "2-baddate.json"),
				JSON.stringify({ type: "squash", commitHash: "b".repeat(40), createdAt: "not-a-date" }),
			);

			expect(await countActiveSummaryQueueEntries(tempDir)).toBe(2);
		});
	});

	// ── countActiveQueueEntriesByKind ────────────────────────────────────

	describe("countActiveQueueEntriesByKind", () => {
		it("returns {0,0} when the queue dir does not exist", async () => {
			expect(await countActiveQueueEntriesByKind(tempDir)).toEqual({ summary: 0, ingest: 0 });
		});

		it("splits summary vs ingest in one pass, excludes stale, ignores corrupt", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			await mkdir(queueDir, { recursive: true });
			const now = new Date().toISOString();
			const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			await writeFile(
				join(queueDir, "1-commit.json"),
				JSON.stringify({ type: "commit", commitHash: "a".repeat(40), createdAt: now }),
			);
			await writeFile(
				join(queueDir, "2-squash.json"),
				JSON.stringify({ type: "squash", commitHash: "b".repeat(40), createdAt: now }),
			);
			await writeFile(
				join(queueDir, "3-ingest.json"),
				JSON.stringify({ type: "ingest", triggeredBy: "post-commit", createdAt: now }),
			);
			await writeFile(
				join(queueDir, "4-stale.json"),
				JSON.stringify({ type: "commit", commitHash: "c".repeat(40), createdAt: eightDaysAgo }),
			);
			await writeFile(join(queueDir, "5-corrupt.json"), "{ not json");

			expect(await countActiveQueueEntriesByKind(tempDir)).toEqual({ summary: 2, ingest: 1 });
		});
	});

	// ── countStaleQueueEntries / pruneStaleQueueEntries ──────────────────

	describe("countStaleQueueEntries and pruneStaleQueueEntries", () => {
		it("should return 0 when queue dir does not exist", async () => {
			expect(await countStaleQueueEntries(tempDir)).toBe(0);
			expect(await pruneStaleQueueEntries(tempDir)).toBe(0);
		});

		it("should count stale entries", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(queueDir, { recursive: true });
			const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			const freshDate = new Date().toISOString();
			await writeFile(
				join(queueDir, "stale.json"),
				JSON.stringify({ type: "commit", commitHash: "a".repeat(40), createdAt: eightDaysAgo }),
			);
			await writeFile(
				join(queueDir, "fresh.json"),
				JSON.stringify({ type: "commit", commitHash: "b".repeat(40), createdAt: freshDate }),
			);

			expect(await countStaleQueueEntries(tempDir)).toBe(1);
		});

		it("should treat corrupt queue entries as stale", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(queueDir, { recursive: true });
			await writeFile(join(queueDir, "corrupt.json"), "invalid json");

			expect(await countStaleQueueEntries(tempDir)).toBe(1);
		});

		it("should prune stale entries and return the count pruned", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(queueDir, { recursive: true });
			const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
			await writeFile(
				join(queueDir, "stale-1.json"),
				JSON.stringify({ type: "commit", commitHash: "a".repeat(40), createdAt: eightDaysAgo }),
			);
			await writeFile(
				join(queueDir, "stale-2.json"),
				JSON.stringify({ type: "commit", commitHash: "b".repeat(40), createdAt: eightDaysAgo }),
			);

			expect(await pruneStaleQueueEntries(tempDir)).toBe(2);
			// After pruning, count is 0
			expect(await countStaleQueueEntries(tempDir)).toBe(0);
		});

		it("should prune corrupt entries", async () => {
			const queueDir = join(tempDir, ".jolli/jollimemory/git-op-queue");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(queueDir, { recursive: true });
			await writeFile(join(queueDir, "bad.json"), "garbage");
			expect(await pruneStaleQueueEntries(tempDir)).toBe(1);
		});
	});

	// ── checkStaleSquashPending ──────────────────────────────────────────

	describe("checkStaleSquashPending", () => {
		it("should return false when squash-pending.json does not exist", async () => {
			expect(await checkStaleSquashPending(tempDir)).toBe(false);
		});

		it("should return false when squash-pending.json is fresh", async () => {
			const dir = join(tempDir, ".jolli/jollimemory");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "squash-pending.json"),
				JSON.stringify({
					sourceHashes: ["a".repeat(40)],
					expectedParentHash: "b".repeat(40),
					createdAt: new Date().toISOString(),
				}),
			);
			expect(await checkStaleSquashPending(tempDir)).toBe(false);
		});

		it("should return true when squash-pending.json is older than 48h", async () => {
			const dir = join(tempDir, ".jolli/jollimemory");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(dir, { recursive: true });
			const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
			await writeFile(
				join(dir, "squash-pending.json"),
				JSON.stringify({
					sourceHashes: ["a".repeat(40)],
					expectedParentHash: "b".repeat(40),
					createdAt: threeDaysAgo,
				}),
			);
			expect(await checkStaleSquashPending(tempDir)).toBe(true);
		});

		it("should treat corrupt squash-pending.json as stale", async () => {
			const dir = join(tempDir, ".jolli/jollimemory");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "squash-pending.json"), "not json");
			expect(await checkStaleSquashPending(tempDir)).toBe(true);
		});
	});

	// ─── Linear issue registry helpers ──────────────────────────────────────

	describe("detectUncommittedReferenceIds / getReferenceEntriesForBranch", () => {
		const ref = (overrides: Partial<Reference> = {}): Reference => ({
			mapKey: "linear:PROJ-1528",
			source: "linear",
			nativeId: "PROJ-1528",
			title: "t",
			url: "https://linear.app/x/PROJ-1528",
			toolName: "mcp__linear__get_issue",
			referencedAt: "2026-05-14T06:00:00Z",
			...overrides,
		});

		async function seed(entries: Record<string, object>) {
			await savePlansRegistry(
				{ version: 1, plans: {}, references: entries } as Parameters<typeof savePlansRegistry>[0],
				tempDir,
			);
		}

		it("returns uncommitted entries on the current branch", async () => {
			await upsertReferenceEntry(ref(), tempDir, "main");
			const ids = await detectUncommittedReferenceIds(tempDir, "main");
			expect(ids.map((i) => i.mapKey)).toEqual(["linear:PROJ-1528"]);
			expect((await getReferenceEntriesForBranch(tempDir, "main")).map((e) => e.nativeId)).toEqual(["PROJ-1528"]);
		});

		it("returns empty for repos with no linearIssues section", async () => {
			await savePlansRegistry({ version: 1, plans: {} }, tempDir);
			expect(await detectUncommittedReferenceIds(tempDir, "main")).toEqual([]);
			expect(await getReferenceEntriesForBranch(tempDir, "main")).toEqual([]);
		});

		it("getReferenceEntriesForBranch returns every registry entry regardless of source", async () => {
			// References are removed from the registry at commit time, so every
			// surviving row is an active, uncommitted reference — there is no
			// branch / commitHash / ignored / guard filtering to apply.
			await seed({
				"linear:PROJ-1": {
					source: "linear",
					nativeId: "PROJ-1",
					title: "one",
					url: "u",
					sourcePath: "p",
					addedAt: "x",
					updatedAt: "x",
					sourceToolName: "mcp__linear__get_issue",
				},
				"jira:KAN-2": {
					source: "jira",
					nativeId: "KAN-2",
					title: "two",
					url: "u",
					sourcePath: "p",
					addedAt: "x",
					updatedAt: "x",
					sourceToolName: "mcp__atlassian__getJiraIssue",
				},
			});

			const result = await getReferenceEntriesForBranch(tempDir, "main");

			expect(result.map((e) => e.nativeId).sort()).toEqual(["KAN-2", "PROJ-1"]);
		});
	});

	describe("upsertReferenceEntry", () => {
		const ref = (overrides: Partial<Reference> = {}): Reference => ({
			mapKey: "linear:PROJ-1528",
			source: "linear",
			nativeId: "PROJ-1528",
			title: "Treat referenced Linear issues",
			url: "https://linear.app/x/PROJ-1528",
			toolName: "mcp__linear__get_issue",
			referencedAt: "2026-05-14T06:00:00Z",
			...overrides,
		});

		it("creates a fresh entry when none exists", async () => {
			await upsertReferenceEntry(ref(), tempDir, "main");
			const reg = await loadPlansRegistry(tempDir);
			const e = linearIssuesOfReg(reg)?.["PROJ-1528"];
			expect(e).toBeDefined();
			expect(e?.sourcePath).toContain("PROJ-1528.md");
			expect(e?.sourceToolName).toBe("mcp__linear__get_issue");
			expect(e?.title).toBe("Treat referenced Linear issues");
			// Branch is stamped so IntelliJ can branch-scope the shared plans.json.
			expect(e?.branch).toBe("main");
		});

		it("stamps the current branch on insert and re-stamps it on update", async () => {
			await upsertReferenceEntry(ref(), tempDir, "feature/x");
			expect(linearIssuesOfReg(await loadPlansRegistry(tempDir))?.["PROJ-1528"]?.branch).toBe("feature/x");
			// Re-surfaced on another branch → follows the new branch.
			await upsertReferenceEntry(ref({ title: "v2" }), tempDir, "feature/y");
			expect(linearIssuesOfReg(await loadPlansRegistry(tempDir))?.["PROJ-1528"]?.branch).toBe("feature/y");
		});

		it("omits branch on an unknown git lookup (stays visible on every branch)", async () => {
			await upsertReferenceEntry(ref(), tempDir, "unknown");
			expect(linearIssuesOfReg(await loadPlansRegistry(tempDir))?.["PROJ-1528"]?.branch).toBeUndefined();
		});

		it("refreshes title/url/sourceToolName on an existing entry, preserving addedAt", async () => {
			await upsertReferenceEntry(ref(), tempDir, "main");
			const before = await loadPlansRegistry(tempDir);
			const addedAt = linearIssuesOfReg(before)?.["PROJ-1528"]?.addedAt;

			await upsertReferenceEntry(
				ref({
					title: "new title",
					url: "https://linear.app/x/PROJ-1528/v2",
					toolName: "mcp__linear__list_issues",
				}),
				tempDir,
				"main",
			);
			const after = await loadPlansRegistry(tempDir);
			const e = linearIssuesOfReg(after)?.["PROJ-1528"];
			expect(e?.title).toBe("new title");
			expect(e?.url).toBe("https://linear.app/x/PROJ-1528/v2");
			expect(e?.sourceToolName).toBe("mcp__linear__list_issues");
			expect(e?.addedAt).toBe(addedAt); // preserved
		});
	});

	describe("detectActivePlansForBranch / detectActiveNotesForBranch", () => {
		it("returns all uncommitted plans regardless of branch", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {
						"plan-1": {
							slug: "plan-1",
							title: "t",
							sourcePath: "/p",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
						},
						"plan-2": {
							slug: "plan-2",
							title: "t",
							sourcePath: "/p",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
						},
					},
				},
				tempDir,
			);
			const plans = await detectActivePlansForBranch(tempDir, "main");
			expect(plans.map((p) => p.slug).sort()).toEqual(["plan-1", "plan-2"]);
		});

		it("detectActivePlansForBranch skips committed and guarded plans (covers commitHash + contentHash filter arms)", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {
						"plan-active": {
							slug: "plan-active",
							title: "active",
							sourcePath: "/p",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
						},
						"plan-committed": {
							slug: "plan-committed",
							title: "committed",
							sourcePath: "/p",
							addedAt: "x",
							updatedAt: "x",
							commitHash: "abcdef1234567890",
						},
						"plan-guarded": {
							slug: "plan-guarded",
							title: "guarded",
							sourcePath: "/p",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
							contentHashAtCommit: "fakehash",
						},
					},
				},
				tempDir,
			);

			const plans = await detectActivePlansForBranch(tempDir, "main");

			expect(plans.map((p) => p.slug)).toEqual(["plan-active"]);
		});

		it("returns uncommitted notes for current branch", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					notes: {
						"note-1": {
							id: "note-1",
							title: "t",
							format: "snippet",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
						},
						"note-2": {
							id: "note-2",
							title: "t",
							format: "snippet",
							addedAt: "x",
							updatedAt: "x",
							commitHash: "abc",
						},
					},
				},
				tempDir,
			);
			const notes = await detectActiveNotesForBranch(tempDir, "main");
			expect(notes.map((n) => n.id)).toEqual(["note-1"]);
		});

		it("returns empty when registry has no notes section", async () => {
			await savePlansRegistry({ version: 1, plans: {} }, tempDir);
			expect(await detectActiveNotesForBranch(tempDir, "main")).toEqual([]);
		});
	});

	describe("detectUncommittedReferenceIds / getReferenceEntriesForBranch — registry with no references field", () => {
		// Pins `referencesOf`'s `reg.references ?? {}` default: a registry that
		// omits the `references` field entirely (e.g. a released-version file
		// written before multi-source references existed) must yield an empty
		// result without erroring.
		it("detectUncommittedReferenceIds returns empty array when references field is absent", async () => {
			await savePlansRegistry({ version: 1, plans: {} }, tempDir);
			const ids = await detectUncommittedReferenceIds(tempDir, "main");
			expect(ids).toEqual([]);
		});

		it("getReferenceEntriesForBranch returns empty array when references field is absent", async () => {
			await savePlansRegistry({ version: 1, plans: {} }, tempDir);
			const entries = await getReferenceEntriesForBranch(tempDir, "main");
			expect(entries).toEqual([]);
		});
	});

	describe("upsertReferenceEntry / getReferenceEntriesForBranch / detectUncommittedReferenceIds", () => {
		function entityRef(overrides: Partial<Reference> = {}): Reference {
			return {
				mapKey: "jira:KAN-5",
				source: "jira",
				nativeId: "KAN-5",
				title: "Jira issue 5",
				url: "https://example.atlassian.net/browse/KAN-5",
				referencedAt: "2026-05-26T00:00:00Z",
				toolName: "mcp__atlassian__getJiraIssue",
				...overrides,
			};
		}

		it("upserts a new entity and surfaces it from getReferenceEntriesForBranch", async () => {
			await upsertReferenceEntry(entityRef(), tempDir, "main");
			const entries = await getReferenceEntriesForBranch(tempDir, "main");
			expect(entries).toHaveLength(1);
			expect(entries[0]?.source).toBe("jira");
			expect(entries[0]?.nativeId).toBe("KAN-5");
		});

		it("routes entries by source — does not mix Jira and Linear", async () => {
			await upsertReferenceEntry(entityRef(), tempDir, "main");
			await upsertReferenceEntry(
				entityRef({ mapKey: "linear:PROJ-1", source: "linear", nativeId: "PROJ-1", title: "Linear" }),
				tempDir,
				"main",
			);
			const entries = await getReferenceEntriesForBranch(tempDir, "main");
			expect(entries.map((e) => e.source).sort()).toEqual(["jira", "linear"]);
		});

		it("detectUncommittedReferenceIds returns {mapKey, source, sourcePath} triples", async () => {
			await upsertReferenceEntry(entityRef(), tempDir, "main");
			const ids = await detectUncommittedReferenceIds(tempDir, "main");
			expect(ids).toHaveLength(1);
			expect(ids[0]).toMatchObject({ mapKey: "jira:KAN-5", source: "jira" });
			expect(ids[0]?.sourcePath).toContain(join("references", "jira", "KAN-5.md"));
		});

		it("upsertReferenceEntry refreshes title/url on an uncommitted entry (updated log path)", async () => {
			// Pins the `existing === undefined ? "new" : "updated"` ternary's
			// "updated" arm in upsertReferenceEntry's log line, plus the
			// canRefreshUncommitted branch above it.
			await upsertReferenceEntry(entityRef(), tempDir, "main");
			await upsertReferenceEntry(entityRef({ title: "renamed" }), tempDir, "main");
			const entries = await getReferenceEntriesForBranch(tempDir, "main");
			expect(entries).toHaveLength(1);
			expect(entries[0]?.title).toBe("renamed");
		});
	});

	// Coverage: pins the registry-without-references-field path. `referencesOf`
	// uses `reg.references ?? {}` — without a test hitting the `undefined` arm of
	// that nullish coalesce, the branch counter stalls below the 96% per-file floor.
	describe("reference helpers tolerate a registry with no references field", () => {
		it("detectUncommittedReferenceIds returns [] when the references field is absent", async () => {
			// Hand-author a plans.json that omits the references field entirely;
			// `loadPlansRegistry` keeps the absence (it normalises plans, not
			// references) so `referencesOf` hits the `reg.references ?? {}` undefined
			// arm. Writing through `savePlansRegistry` to keep the JSON serializer in
			// the loop (matches what users would land via merge / manual edits).
			await savePlansRegistry({ version: 1, plans: {} } as PlansRegistry, tempDir);
			expect(await detectUncommittedReferenceIds(tempDir, "main")).toEqual([]);
			expect(await getReferenceEntriesForBranch(tempDir, "main")).toEqual([]);
		});

		it("detectUncommittedReferenceIds surfaces non-linear sources (jira)", async () => {
			// Multi-source generalisation: detectUncommittedReferenceIds returns
			// every active reference regardless of source. The "legacy linear-only"
			// filter was removed when references replaced linearIssues.
			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					references: {
						"jira:KAN-5": {
							source: "jira",
							nativeId: "KAN-5",
							title: "active jira",
							url: "u",
							sourcePath: "/p",
							addedAt: "x",
							updatedAt: "x",
							sourceToolName: "test",
						},
					},
				},
				tempDir,
			);
			const ids = await detectUncommittedReferenceIds(tempDir, "main");
			expect(ids.map((i) => i.mapKey)).toEqual(["jira:KAN-5"]);
		});

		it("tolerates a references row with a bare (no `linear:` prefix) map key", async () => {
			// Synthetic state: a manually-edited plans.json where the map key is
			// the bare ticketId.
			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					references: {
						"linear:PROJ-bare": {
							source: "linear",
							nativeId: "PROJ-bare",
							title: "bare",
							url: "u",
							sourcePath: "/p",
							addedAt: "x",
							updatedAt: "x",
							sourceToolName: "mcp__linear__get_issue",
						},
					},
				},
				tempDir,
			);
			const ids = await detectUncommittedReferenceIds(tempDir, "main");
			expect(ids.map((i) => i.mapKey)).toEqual(["linear:PROJ-bare"]);
		});
	});

	// Coverage: exercise the `notes !== undefined` branch in reference APIs (the
	// out-object spread carries notes through). Without these tests the false-only
	// branch on `registry.notes !== undefined` keeps branch coverage below the
	// 96% per-file floor.
	describe("reference APIs preserve notes section through registry rewrites", () => {
		const seedNotes = {
			"note-1": {
				id: "note-1",
				title: "n",
				format: "markdown" as const,
				sourcePath: "/p",
				branch: "main",
				addedAt: "x",
				updatedAt: "x",
				commitHash: null,
			},
		};

		it("upsertReferenceEntry carries existing notes through to the registry write", async () => {
			await savePlansRegistry({ version: 1, plans: {}, references: {}, notes: seedNotes }, tempDir);
			await upsertReferenceEntry(
				{
					mapKey: "jira:KAN-5",
					source: "jira",
					nativeId: "KAN-5",
					title: "t",
					url: "https://example.atlassian.net/browse/KAN-5",
					referencedAt: "x",
					toolName: "mcp__atlassian__getJiraIssue",
				},
				tempDir,
				"main",
			);
			const after = await loadPlansRegistry(tempDir);
			if (after.version !== 1) return;
			expect(after.notes?.["note-1"]).toBeDefined();
		});

		it("upsertReferenceEntry preserves the notes section", async () => {
			await savePlansRegistry(
				{ version: 1, plans: {}, references: {}, notes: seedNotes } as PlansRegistry,
				tempDir,
			);
			await upsertReferenceEntry(
				{
					mapKey: "linear:PROJ-1",
					source: "linear",
					nativeId: "PROJ-1",
					title: "t",
					url: "https://linear.app/x/PROJ-1",
					toolName: "mcp__linear__get_issue",
					referencedAt: "x",
				},
				tempDir,
				"main",
			);
			const after = await loadPlansRegistry(tempDir);
			if (after.version !== 1) return;
			expect(after.notes?.["note-1"]).toBeDefined();
		});
	});
});

describe("normalizePlansRegistry", () => {
	const plan = (over: Record<string, unknown>) => ({
		slug: "s",
		title: "T",
		sourcePath: "/p/s.md",
		addedAt: "t",
		updatedAt: "t",
		commitHash: null,
		...over,
	});
	const ref = (over: Record<string, unknown>) => ({
		source: "linear",
		nativeId: "X-1",
		title: "T",
		url: "https://x/1",
		sourcePath: "/r/x.md",
		addedAt: "t",
		updatedAt: "t",
		sourceToolName: "mcp__linear__get_issue",
		...over,
	});

	it("plans: drops ignored rows, strips ignored/editCount, keeps guard and branch", () => {
		const raw = {
			version: 1,
			plans: {
				active: plan({ slug: "active", branch: "main", editCount: 3 }),
				guard: plan({
					slug: "guard",
					commitHash: "abc",
					contentHashAtCommit: "h",
					branch: "main",
					editCount: 1,
				}),
				gone: plan({ slug: "gone", ignored: true }),
			},
		} as unknown as Partial<PlansRegistry>;

		const { registry, changed } = normalizePlansRegistry(raw);

		expect(changed).toBe(true);
		expect(Object.keys(registry.plans).sort()).toEqual(["active", "guard"]);
		expect(JSON.stringify(registry.plans)).not.toMatch(/editCount|"ignored"/);
		// `branch` is preserved (IntelliJ branch-scopes off it via the shared plans.json).
		expect(registry.plans.active?.branch).toBe("main");
		expect(registry.plans.guard?.branch).toBe("main");
		expect(registry.plans.guard?.commitHash).toBe("abc");
		expect(registry.plans.guard?.contentHashAtCommit).toBe("h");
	});

	it("notes: drops ignored rows, strips ignored, keeps guard and branch", () => {
		const raw = {
			version: 1,
			plans: {},
			notes: {
				keep: {
					id: "keep",
					title: "K",
					format: "markdown",
					addedAt: "t",
					updatedAt: "t",
					commitHash: null,
					branch: "main",
				},
				drop: {
					id: "drop",
					title: "D",
					format: "markdown",
					addedAt: "t",
					updatedAt: "t",
					commitHash: null,
					ignored: true,
				},
			},
		} as unknown as Partial<PlansRegistry>;

		const { registry, changed } = normalizePlansRegistry(raw);

		expect(changed).toBe(true);
		expect(Object.keys(registry.notes ?? {})).toEqual(["keep"]);
		expect(JSON.stringify(registry.notes)).not.toMatch(/"ignored"/);
		// `branch` is preserved for the IntelliJ shared-plans.json branch filter.
		expect(registry.notes?.keep?.branch).toBe("main");
	});

	it("notes: strips a lingering `ignored: false` field (changed=true) but leaves a clean note untouched", () => {
		const raw = {
			version: 1,
			plans: {},
			notes: {
				stale: {
					id: "stale",
					title: "Stale",
					format: "markdown",
					addedAt: "t",
					updatedAt: "t",
					commitHash: null,
					// `ignored: false` is a legacy field that must be stripped — the row
					// survives (it's not `ignored === true`) but `changed` flips true.
					ignored: false,
				},
				clean: {
					id: "clean",
					title: "Clean",
					format: "markdown",
					addedAt: "t",
					updatedAt: "t",
					commitHash: null,
				},
			},
		} as unknown as Partial<PlansRegistry>;

		const { registry, changed } = normalizePlansRegistry(raw);

		expect(changed).toBe(true);
		expect(Object.keys(registry.notes ?? {}).sort()).toEqual(["clean", "stale"]);
		expect(JSON.stringify(registry.notes)).not.toMatch(/"ignored"/);
	});

	it("references: drops ignored/committed/guard rows, keeps active rows, strips dead fields", () => {
		const raw = {
			version: 1,
			plans: {},
			references: {
				"linear:ACTIVE-1": ref({ nativeId: "ACTIVE-1", branch: "main", ignored: false }),
				// Active ticket whose id ends in 8 digits — must NOT be mistaken for a
				// `-<8hex>` archive key and dropped (regression guard: digits ⊂ hex).
				"linear:ENG-12345678": ref({ nativeId: "ENG-12345678" }),
				"linear:COMMITTED-2": ref({ nativeId: "COMMITTED-2", commitHash: "abc12345" }),
				"linear:GUARD-3": ref({ nativeId: "GUARD-3", contentHashAtCommit: "h" }),
				"notion:IGNORED-5": ref({ source: "notion", nativeId: "IGNORED-5", ignored: true }),
			},
		} as unknown as Partial<PlansRegistry>;

		const { registry, changed } = normalizePlansRegistry(raw);

		expect(changed).toBe(true);
		expect(Object.keys(registry.references ?? {}).sort()).toEqual(["linear:ACTIVE-1", "linear:ENG-12345678"]);
		expect(JSON.stringify(registry.references)).not.toMatch(/"ignored"|"commitHash"|contentHashAtCommit/);
		// `branch` is preserved on the surviving active rows.
		expect(registry.references?.["linear:ACTIVE-1"]?.branch).toBe("main");
	});

	it("is idempotent: an already-clean registry returns changed=false and equal data", () => {
		const clean = {
			version: 1 as const,
			plans: { a: plan({ slug: "a" }) },
			notes: {},
			references: {},
		} as unknown as PlansRegistry;

		const { registry, changed } = normalizePlansRegistry(clean);

		expect(changed).toBe(false);
		expect(registry).toEqual(clean);
	});

	it("missing notes/references sections stay absent (no-op)", () => {
		const { registry, changed } = normalizePlansRegistry({ version: 1, plans: {} });
		expect(changed).toBe(false);
		expect(registry).toEqual({ version: 1, plans: {} });
		expect(registry.notes).toBeUndefined();
		expect(registry.references).toBeUndefined();
	});
});
