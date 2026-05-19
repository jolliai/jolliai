import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRename } = vi.hoisted(() => ({
	mockRename: vi.fn<typeof import("node:fs/promises").rename>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
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
	GitOperation,
	LinearIssueRef,
	SessionInfo,
	SessionsRegistry,
	SquashPendingState,
	TranscriptCursor,
} from "../Types.js";
import {
	associateLinearIssueWithCommit,
	associateNoteWithCommit,
	associatePlanWithCommit,
	checkStaleSquashPending,
	countActiveQueueEntries,
	countStaleQueueEntries,
	countStaleSessions,
	deletePluginSource,
	deleteQueueEntry,
	deleteSquashPending,
	dequeueAllGitOperations,
	detectActiveNotesForBranch,
	detectActivePlansForBranch,
	detectUncommittedLinearIssueIds,
	enqueueGitOperation,
	ensureJolliMemoryDir,
	filterSessionsByEnabledIntegrations,
	getGlobalConfigDir,
	getLinearIssueEntriesForBranch,
	loadAllSessions,
	loadConfig,
	loadConfigFromDir,
	loadCursorForTranscript,
	loadMostRecentSession,
	loadPlanEntry,
	loadPlansRegistry,
	loadPluginSource,
	loadSquashPending,
	pruneStaleQueueEntries,
	pruneStaleSessions,
	saveConfig,
	saveConfigScoped,
	saveCursor,
	savePlansRegistry,
	savePluginSource,
	saveSession,
	saveSquashPending,
	upsertLinearIssueEntry,
} from "./SessionTracker.js";

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

		it("should prune stale plan cursors during save", async () => {
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
					transcriptPath: "plan:/path/stale-plan.jsonl",
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

			await expect(loadCursorForTranscript("plan:/path/stale-plan.jsonl", tempDir)).resolves.toBeNull();
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
						branch: "main",
						commitHash: null,
						editCount: 0,
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
						branch: "main",
						commitHash: null,
						editCount: 0,
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

		it("should associate a plan with a commit and update updatedAt", async () => {
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
						commitHash: null,
						editCount: 0,
					},
				},
			};
			await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			await associatePlanWithCommit("feature-auth", "abcdef1234567890", tempDir);

			const after = await loadPlansRegistry(tempDir);
			expect(after.plans["feature-auth"]?.commitHash).toBe("abcdef1234567890");
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
						branch: "main",
						commitHash: null,
						editCount: 0,
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
			it("should migrate the guard entry's commitHash and recompute contentHashAtCommit when the file is unchanged", async () => {
				const planFile = join(tempDir, "plan.md");
				const planBody = "# My Plan\n\nstep 1\n";
				await writeFile(planFile, planBody, "utf-8");
				const { createHash } = await import("node:crypto");
				const fileHash = createHash("sha256").update(planBody).digest("hex");

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
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
							contentHashAtCommit: fileHash,
							editCount: 1,
						},
						"my-plan-35080b05": {
							slug: "my-plan-35080b05",
							title: "My Plan",
							sourcePath: planFile,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
							editCount: 1,
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associatePlanWithCommit("my-plan-35080b05", "6c66a12e50f0cf1129f8e63b340897832d22ecee", tempDir);

				const after = await loadPlansRegistry(tempDir);
				expect(after.plans["my-plan-35080b05"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
				expect(after.plans["my-plan"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
				expect(after.plans["my-plan"]?.contentHashAtCommit).toBe(fileHash);
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
							editCount: 1,
						},
						"my-plan-deadbeef": {
							slug: "my-plan-deadbeef",
							title: "My Plan",
							sourcePath: planFile,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
							editCount: 1,
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
							editCount: 1,
						},
						"my-plan-35080b05": {
							slug: "my-plan-35080b05",
							title: "My Plan",
							sourcePath: join(tempDir, "does-not-exist.md"),
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/x",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
							editCount: 1,
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associatePlanWithCommit("my-plan-35080b05", "6c66a12e50f0cf1129f8e63b340897832d22ecee", tempDir);

				const after = await loadPlansRegistry(tempDir);
				expect(after.plans["my-plan"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
				expect(after.plans["my-plan"]?.contentHashAtCommit).toBe("stalehash");
			});

			it("should not migrate any guard when the archive id has no -<shortHash> suffix", async () => {
				// Defensive: a caller could pass a base-slug-shaped id (no suffix). The
				// function must not invent a guard target out of an unrelated entry.
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
							editCount: 1,
						},
					},
				};
				await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

				await associatePlanWithCommit("my-plan", "6c66a12e50f0cf1129f8e63b340897832d22ecee", tempDir);

				const after = await loadPlansRegistry(tempDir);
				// Direct migration of the named entry still happens, but contentHashAtCommit
				// is left alone — only guard-entry migration triggered through an archive id
				// recomputes it.
				expect(after.plans["my-plan"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
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
						branch: "main",
						editCount: 0,
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
		it("should associate a note with a commit and update updatedAt", async () => {
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
						branch: "feature/test",
						commitHash: null,
					},
				},
			};
			await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			await associateNoteWithCommit("note-1-abc", "abcdef1234567890", tempDir);

			const after = await loadPlansRegistry(tempDir);
			expect(after.notes?.["note-1-abc"]?.commitHash).toBe("abcdef1234567890");
			expect(after.notes?.["note-1-abc"]?.updatedAt).not.toBe("2026-03-01T10:00:00Z");
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
						branch: "feature/test",
						commitHash: null,
					},
				},
			};
			await savePlansRegistry(before as unknown as Parameters<typeof savePlansRegistry>[0], tempDir);

			await associateNoteWithCommit("missing-note", "abcdef1234567890", tempDir);

			await expect(loadPlansRegistry(tempDir)).resolves.toEqual(before);
		});

		describe("guard-entry migration on squash/rebase", () => {
			it("should migrate the guard entry's commitHash and recompute contentHashAtCommit when the source file is unchanged", async () => {
				const noteFile = join(tempDir, "note.md");
				const body = "# Active AI Conversations — Design Document\n\nA note body.\n";
				await writeFile(noteFile, body, "utf-8");
				const { createHash } = await import("node:crypto");
				const fileHash = createHash("sha256").update(body).digest("hex");

				const before = {
					version: 1 as const,
					plans: {},
					notes: {
						"note-035b": {
							id: "note-035b",
							title: "Active AI Conversations — Design Document",
							format: "markdown" as const,
							sourcePath: noteFile,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/active-conversations",
							commitHash: "35080b05360866b87dc03dfe9204ec148f263660",
							contentHashAtCommit: fileHash,
						},
						"note-035b-35080b05": {
							id: "note-035b-35080b05",
							title: "Active AI Conversations — Design Document",
							format: "markdown" as const,
							sourcePath: noteFile,
							addedAt: "2026-03-01T10:00:00Z",
							updatedAt: "2026-03-01T10:00:00Z",
							branch: "feature/active-conversations",
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
				expect(after.notes?.["note-035b-35080b05"]?.commitHash).toBe(
					"6c66a12e50f0cf1129f8e63b340897832d22ecee",
				);
				expect(after.notes?.["note-035b"]?.commitHash).toBe("6c66a12e50f0cf1129f8e63b340897832d22ecee");
				expect(after.notes?.["note-035b"]?.contentHashAtCommit).toBe(fileHash);
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
						"note-035b-deadbeef": {
							id: "note-035b-deadbeef",
							title: "Note",
							format: "snippet" as const,
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
					"6c66a12e50f0cf1129f8e63b340897832d22ecee",
					tempDir,
				);

				const after = await loadPlansRegistry(tempDir);
				expect(after.notes?.["note-035b-deadbeef"]?.commitHash).toBe(
					"6c66a12e50f0cf1129f8e63b340897832d22ecee",
				);
				// Guard untouched because its commitHash didn't match the archive id's
				// `deadbeef` suffix — different commit lineage.
				expect(after.notes?.["note-035b"]?.commitHash).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
				expect(after.notes?.["note-035b"]?.contentHashAtCommit).toBe("stalehash");
			});
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
		const makeOp = (hash: string, type: GitOperation["type"] = "commit"): GitOperation => ({
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
			expect(entries[0].op.commitHash).toBe("aaa111");
			expect(entries[1].op.commitHash).toBe("bbb222");
		});

		it("should return empty array when queue directory does not exist", async () => {
			const entries = await dequeueAllGitOperations(tempDir);
			expect(entries).toEqual([]);
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
			expect(entries[0].op.commitHash).toBe("ddd444");
		});

		it("should prune stale entries older than 7 days", async () => {
			const { mkdir } = await import("node:fs/promises");
			const queueDir = join(tempDir, ".jolli", "jollimemory", "git-op-queue");
			await mkdir(queueDir, { recursive: true });

			// Create a stale entry with createdAt 8 days ago
			const staleOp: GitOperation = {
				type: "commit",
				commitHash: "stale1",
				createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
			};
			await writeFile(join(queueDir, "0000000001-stale1.json"), JSON.stringify(staleOp), "utf-8");

			// Also enqueue a fresh entry
			await enqueueGitOperation(makeOp("fresh1"), tempDir);

			const entries = await dequeueAllGitOperations(tempDir);
			expect(entries).toHaveLength(1);
			expect(entries[0].op.commitHash).toBe("fresh1");
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

	describe("detectUncommittedLinearIssueIds / getLinearIssueEntriesForBranch", () => {
		const ref = (overrides: Partial<LinearIssueRef> = {}): LinearIssueRef => ({
			ticketId: "PROJ-1528",
			title: "t",
			url: "https://linear.app/x/PROJ-1528",
			toolName: "mcp__linear__get_issue",
			referencedAt: "2026-05-14T06:00:00Z",
			...overrides,
		});

		async function seed(entries: Record<string, object>) {
			await savePlansRegistry(
				{ version: 1, plans: {}, linearIssues: entries } as Parameters<typeof savePlansRegistry>[0],
				tempDir,
			);
		}

		it("returns uncommitted entries on the current branch", async () => {
			await upsertLinearIssueEntry(ref(), "/s/PROJ-1528.md", "hash-1", "main", tempDir);
			expect(await detectUncommittedLinearIssueIds(tempDir, "main")).toEqual(["PROJ-1528"]);
			expect((await getLinearIssueEntriesForBranch(tempDir, "main")).map((e) => e.ticketId)).toEqual([
				"PROJ-1528",
			]);
		});

		it("filters out entries on other branches", async () => {
			await upsertLinearIssueEntry(ref(), "/s/PROJ-1528.md", "hash-1", "feature-a", tempDir);
			expect(await detectUncommittedLinearIssueIds(tempDir, "main")).toEqual([]);
		});

		it("filters out ignored entries", async () => {
			await seed({
				"PROJ-1": {
					ticketId: "PROJ-1",
					title: "t",
					url: "u",
					sourcePath: "p",
					branch: "main",
					addedAt: "x",
					updatedAt: "x",
					commitHash: null,
					sourceToolName: "mcp__linear__get_issue",
					ignored: true,
				},
			});
			expect(await detectUncommittedLinearIssueIds(tempDir, "main")).toEqual([]);
		});

		it("filters out guard entries (have contentHashAtCommit)", async () => {
			await seed({
				"PROJ-1": {
					ticketId: "PROJ-1",
					title: "t",
					url: "u",
					sourcePath: "p",
					branch: "main",
					addedAt: "x",
					updatedAt: "x",
					commitHash: "abc1234",
					contentHashAtCommit: "hash",
					sourceToolName: "mcp__linear__get_issue",
				},
			});
			expect(await detectUncommittedLinearIssueIds(tempDir, "main")).toEqual([]);
		});

		it("filters out archived snapshot entries (commitHash set)", async () => {
			await seed({
				"PROJ-1-abc1234": {
					ticketId: "PROJ-1",
					title: "t",
					url: "u",
					sourcePath: "p",
					branch: "main",
					addedAt: "x",
					updatedAt: "x",
					commitHash: "abc1234",
					sourceToolName: "mcp__linear__get_issue",
				},
			});
			expect(await detectUncommittedLinearIssueIds(tempDir, "main")).toEqual([]);
		});

		it("returns empty for repos with no linearIssues section", async () => {
			await savePlansRegistry({ version: 1, plans: {} }, tempDir);
			expect(await detectUncommittedLinearIssueIds(tempDir, "main")).toEqual([]);
			expect(await getLinearIssueEntriesForBranch(tempDir, "main")).toEqual([]);
		});
	});

	describe("upsertLinearIssueEntry", () => {
		const ref = (overrides: Partial<LinearIssueRef> = {}): LinearIssueRef => ({
			ticketId: "PROJ-1528",
			title: "Treat referenced Linear issues",
			url: "https://linear.app/x/PROJ-1528",
			toolName: "mcp__linear__get_issue",
			referencedAt: "2026-05-14T06:00:00Z",
			...overrides,
		});

		it("creates a fresh entry when none exists", async () => {
			await upsertLinearIssueEntry(ref(), "/abs/PROJ-1528.md", "hash-1", "main", tempDir);
			const reg = await loadPlansRegistry(tempDir);
			const e = reg.linearIssues?.["PROJ-1528"];
			expect(e).toBeDefined();
			expect(e?.commitHash).toBeNull();
			expect(e?.contentHashAtCommit).toBeUndefined();
			expect(e?.branch).toBe("main");
			expect(e?.sourcePath).toBe("/abs/PROJ-1528.md");
			expect(e?.sourceToolName).toBe("mcp__linear__get_issue");
		});

		it("preserves addedAt, branch, ignored on update of existing uncommitted entry", async () => {
			await upsertLinearIssueEntry(ref(), "/abs/PROJ-1528.md", "hash-1", "main", tempDir);
			const first = await loadPlansRegistry(tempDir);
			// Optional chaining + explicit defined check: the upsert above
			// guarantees this exists, but the registry type's
			// optional-chaining returns LinearIssueEntry | undefined which
			// spreads as all-optional and the resulting object literal then
			// fails to satisfy LinearIssueEntry's required fields. The
			// `if (!existing) throw` guard narrows the type and replaces a
			// `!` non-null assertion (biome forbids those).
			const existing = first.linearIssues?.["PROJ-1528"];
			if (!existing) {
				throw new Error("test setup invariant: upserted entry missing");
			}
			const addedAt = existing.addedAt;
			// Pretend the user ignored it manually
			await savePlansRegistry(
				{
					...first,
					linearIssues: {
						...first.linearIssues,
						"PROJ-1528": { ...existing, ignored: true },
					},
				},
				tempDir,
			);
			// Second upsert (StopHook re-discovers) should NOT clear ignored, but should be a no-op
			await upsertLinearIssueEntry(
				ref({ title: "new title", referencedAt: "2026-05-14T07:00:00Z" }),
				"/abs/PROJ-1528.md",
				"hash-1",
				"main",
				tempDir,
			);
			const after = await loadPlansRegistry(tempDir);
			const e = after.linearIssues?.["PROJ-1528"];
			expect(e?.ignored).toBe(true);
			expect(e?.title).toBe("Treat referenced Linear issues"); // unchanged because ignored
			expect(e?.addedAt).toBe(addedAt);
		});

		it("refreshes title/url/sourceToolName on uncommitted entry without ignored", async () => {
			await upsertLinearIssueEntry(ref(), "/abs/PROJ-1528.md", "hash-1", "main", tempDir);
			const before = await loadPlansRegistry(tempDir);
			const addedAt = before.linearIssues?.["PROJ-1528"]?.addedAt;

			await upsertLinearIssueEntry(
				ref({
					title: "new title",
					url: "https://linear.app/x/PROJ-1528/v2",
					toolName: "mcp__linear__list_issues",
				}),
				"/abs/PROJ-1528.md",
				"hash-2",
				"main",
				tempDir,
			);
			const after = await loadPlansRegistry(tempDir);
			const e = after.linearIssues?.["PROJ-1528"];
			expect(e?.title).toBe("new title");
			expect(e?.url).toBe("https://linear.app/x/PROJ-1528/v2");
			expect(e?.sourceToolName).toBe("mcp__linear__list_issues");
			expect(e?.addedAt).toBe(addedAt); // preserved
		});

		it("returns no-op when an existing guard's contentHashAtCommit matches", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					linearIssues: {
						"PROJ-1528": {
							ticketId: "PROJ-1528",
							title: "old",
							url: "u",
							sourcePath: "/p",
							branch: "main",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
							commitHash: "abc1234",
							contentHashAtCommit: "matching-hash",
							sourceToolName: "mcp__linear__get_issue",
						},
					},
				},
				tempDir,
			);
			await upsertLinearIssueEntry(ref({ title: "new title" }), "/p", "matching-hash", "main", tempDir);
			const after = await loadPlansRegistry(tempDir);
			expect(after.linearIssues?.["PROJ-1528"]?.title).toBe("old"); // unchanged
			expect(after.linearIssues?.["PROJ-1528"]?.commitHash).toBe("abc1234");
		});

		it("replaces a guard entry with a fresh uncommitted one when content hash differs", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					linearIssues: {
						"PROJ-1528": {
							ticketId: "PROJ-1528",
							title: "old",
							url: "u",
							sourcePath: "/p",
							branch: "main",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
							commitHash: "abc1234",
							contentHashAtCommit: "old-hash",
							sourceToolName: "mcp__linear__get_issue",
						},
					},
				},
				tempDir,
			);
			await upsertLinearIssueEntry(ref({ title: "new" }), "/p", "new-hash", "main", tempDir);
			const after = await loadPlansRegistry(tempDir);
			const e = after.linearIssues?.["PROJ-1528"];
			expect(e?.title).toBe("new");
			expect(e?.commitHash).toBeNull();
			expect(e?.contentHashAtCommit).toBeUndefined();
		});

		it("creates a fresh entry when an existing one is on a different branch (defensive isolation)", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					linearIssues: {
						"PROJ-1528": {
							ticketId: "PROJ-1528",
							title: "old on feature-a",
							url: "u",
							sourcePath: "/p",
							branch: "feature-a",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
							commitHash: null,
							sourceToolName: "mcp__linear__get_issue",
						},
					},
				},
				tempDir,
			);
			// Upsert from a different branch — defensive replacement to a fresh entry on "main"
			await upsertLinearIssueEntry(
				ref({ title: "fresh on main" }),
				"/abs/PROJ-1528.md",
				"hash-x",
				"main",
				tempDir,
			);
			const after = await loadPlansRegistry(tempDir);
			const e = after.linearIssues?.["PROJ-1528"];
			expect(e?.branch).toBe("main");
			expect(e?.title).toBe("fresh on main");
		});

		it("never resurrects an entry whose guard is ignored", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					linearIssues: {
						"PROJ-1528": {
							ticketId: "PROJ-1528",
							title: "old",
							url: "u",
							sourcePath: "/p",
							branch: "main",
							addedAt: "2026-01-01T00:00:00Z",
							updatedAt: "2026-01-01T00:00:00Z",
							commitHash: "abc1234",
							contentHashAtCommit: "old-hash",
							ignored: true,
							sourceToolName: "mcp__linear__get_issue",
						},
					},
				},
				tempDir,
			);
			await upsertLinearIssueEntry(ref({ title: "new" }), "/p", "new-hash", "main", tempDir);
			const after = await loadPlansRegistry(tempDir);
			expect(after.linearIssues?.["PROJ-1528"]?.title).toBe("old"); // unchanged
			expect(after.linearIssues?.["PROJ-1528"]?.ignored).toBe(true);
		});
	});

	describe("associateLinearIssueWithCommit", () => {
		it("updates commitHash on the entry keyed by archivedKey", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {},
					linearIssues: {
						"PROJ-1528-abc1234": {
							ticketId: "PROJ-1528",
							title: "t",
							url: "u",
							sourcePath: "/p",
							branch: "main",
							addedAt: "x",
							updatedAt: "x",
							commitHash: "abc1234",
							sourceToolName: "mcp__linear__get_issue",
						},
					},
				},
				tempDir,
			);
			await associateLinearIssueWithCommit("PROJ-1528-abc1234", "def5678abc", tempDir);
			const after = await loadPlansRegistry(tempDir);
			expect(after.linearIssues?.["PROJ-1528-abc1234"]?.commitHash).toBe("def5678abc");
		});

		it("is a no-op when the archivedKey is not in the registry", async () => {
			await savePlansRegistry({ version: 1, plans: {}, linearIssues: {} }, tempDir);
			await associateLinearIssueWithCommit("PROJ-99-zzz", "newhash", tempDir);
			const after = await loadPlansRegistry(tempDir);
			expect(after.linearIssues).toEqual({});
		});
	});

	describe("detectActivePlansForBranch / detectActiveNotesForBranch", () => {
		it("returns uncommitted plans for current branch", async () => {
			await savePlansRegistry(
				{
					version: 1,
					plans: {
						"plan-1": {
							slug: "plan-1",
							title: "t",
							sourcePath: "/p",
							branch: "main",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
							editCount: 1,
						},
						"plan-2": {
							slug: "plan-2",
							title: "t",
							sourcePath: "/p",
							branch: "feature",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
							editCount: 1,
						},
						"plan-3": {
							slug: "plan-3",
							title: "t",
							sourcePath: "/p",
							branch: "main",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
							editCount: 1,
							ignored: true,
						},
					},
				},
				tempDir,
			);
			const plans = await detectActivePlansForBranch(tempDir, "main");
			expect(plans.map((p) => p.slug)).toEqual(["plan-1"]);
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
							branch: "main",
							addedAt: "x",
							updatedAt: "x",
							commitHash: null,
						},
						"note-2": {
							id: "note-2",
							title: "t",
							format: "snippet",
							branch: "main",
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
});
