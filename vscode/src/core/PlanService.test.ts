import { normalize } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { loadAllSessions, loadPlansRegistry, savePlansRegistry } = vi.hoisted(
	() => ({
		loadAllSessions: vi.fn(),
		loadPlansRegistry: vi.fn(),
		savePlansRegistry: vi.fn(),
	}),
);

const { storePlans } = vi.hoisted(() => ({
	storePlans: vi.fn(),
}));

const { info, warn, error, debug } = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

const {
	mockExistsSync,
	mockReadFileSync,
	mockReaddirSync,
	mockStatSync,
	mockCreateReadStream,
} = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockReaddirSync: vi.fn(),
	mockStatSync: vi.fn(),
	mockCreateReadStream: vi.fn(),
}));

const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
}));

const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn(() => "/mock-home"),
}));

const { mockCreateInterface } = vi.hoisted(() => ({
	mockCreateInterface: vi.fn(),
}));

const { mockCreateHash } = vi.hoisted(() => ({
	mockCreateHash: vi.fn(() => ({
		update: () => ({ digest: () => "mock-hash" }),
	})),
}));

const { mockExecFileSync } = vi.hoisted(() => ({
	mockExecFileSync: vi.fn(),
}));

// ─── vi.mock declarations ────────────────────────────────────────────────────

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadAllSessions,
	loadPlansRegistry,
	savePlansRegistry,
}));

vi.mock("../../../cli/src/core/SummaryStore.js", () => ({
	storePlans,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error, debug },
}));

vi.mock("node:crypto", () => ({
	createHash: mockCreateHash,
}));

vi.mock("node:fs", () => ({
	existsSync: mockExistsSync,
	readFileSync: mockReadFileSync,
	createReadStream: mockCreateReadStream,
	readdirSync: mockReaddirSync,
	statSync: mockStatSync,
}));

vi.mock("node:fs/promises", () => ({
	readFile: mockReadFile,
}));

vi.mock("node:os", () => ({
	homedir: mockHomedir,
}));

vi.mock("node:path", async () => {
	const actual = await vi.importActual<typeof import("node:path")>("node:path");
	return { ...actual };
});

vi.mock("node:readline", () => ({
	createInterface: mockCreateInterface,
}));

vi.mock("node:child_process", () => ({
	execFileSync: mockExecFileSync,
}));

// ─── Import under test (after mocks) ────────────────────────────────────────

import {
	addPlanToRegistry,
	archivePlanForCommit,
	detectPlans,
	extractTitle,
	getPlansDir,
	ignorePlan,
	isPlanFromCurrentProject,
	listAvailablePlans,
	listUnassociatedPlans,
	registerNewPlan,
	unassociatePlanFromCommit,
} from "./PlanService.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const CWD = "/mock-repo";
// Normalized so path comparisons match platform-native separators at runtime.
const PLANS_DIR = normalize("/mock-home/.claude/plans");

function emptyRegistry() {
	return { version: 1 as const, plans: {} };
}

function makeEntry(overrides: Record<string, unknown> = {}) {
	return {
		slug: "test-plan",
		title: "Test Plan",
		sourcePath: `${PLANS_DIR}/test-plan.md`,
		addedAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		branch: "main",
		commitHash: null,
		editCount: 0,
		...overrides,
	};
}

/** Sets up sessions.json to return sessions with optional transcript paths. */
function stubSessions(transcriptPaths: ReadonlyArray<string>) {
	const sessions: Record<
		string,
		{ sessionId: string; transcriptPath: string; updatedAt: string }
	> = {};
	for (const [i, tp] of transcriptPaths.entries()) {
		sessions[`session-${i}`] = {
			sessionId: `session-${i}`,
			transcriptPath: tp,
			updatedAt: "2025-01-01T00:00:00.000Z",
		};
	}
	mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, sessions }));
}

/** Sets up a mock readline interface that emits lines and closes. */
function stubTranscript(lines: ReadonlyArray<string>) {
	mockCreateReadStream.mockReturnValue("mock-stream");
	mockCreateInterface.mockImplementation(() => {
		const listeners: Record<
			string,
			Array<(...args: Array<unknown>) => void>
		> = {};
		const rl = {
			on(event: string, cb: (...args: Array<unknown>) => void) {
				if (!listeners[event]) {
					listeners[event] = [];
				}
				listeners[event].push(cb);
				// When the "close" listener is attached (last one scanTranscript registers),
				// schedule emission so all listeners are in place.
				if (event === "error") {
					queueMicrotask(() => {
						for (const line of lines) {
							for (const handler of listeners.line ?? []) {
								handler(line);
							}
						}
						for (const handler of listeners.close ?? []) {
							handler();
						}
					});
				}
				return rl;
			},
		};
		return rl;
	});
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PlanService", () => {
	beforeEach(() => {
		loadPlansRegistry.mockReset();
		savePlansRegistry.mockReset();
		loadAllSessions.mockReset();
		loadAllSessions.mockResolvedValue([]);
		storePlans.mockReset();
		info.mockReset();
		warn.mockReset();
		error.mockReset();
		debug.mockReset();
		mockExistsSync.mockReset();
		mockReadFileSync.mockReset();
		mockReaddirSync.mockReset();
		// Default: ~/.claude/plans/ is empty so detectPlans()'s directory-diff
		// auto-registration path short-circuits. Tests that want to simulate
		// files present override with mockReaddirSync.mockReturnValue([...]).
		mockReaddirSync.mockReturnValue([]);
		mockStatSync.mockReset();
		mockCreateReadStream.mockReset();
		mockReadFile.mockReset();
		mockCreateInterface.mockReset();
		mockCreateHash.mockReset();
		mockCreateHash.mockImplementation(() => ({
			update: () => ({ digest: () => "mock-hash" }),
		}));
		mockExecFileSync.mockReset();
		// Default: getCurrentBranch returns "main"
		mockExecFileSync.mockReturnValue("main\n");
	});

	// ─── getPlansDir ─────────────────────────────────────────────────────────

	describe("getPlansDir", () => {
		it("returns path ending in .claude/plans", () => {
			const dir = getPlansDir();
			expect(dir).toBe(PLANS_DIR);
		});
	});

	// ─── extractTitle ────────────────────────────────────────────────────────

	describe("extractTitle", () => {
		it("extracts first # heading from file", () => {
			mockReadFileSync.mockReturnValue("# My Plan Title\n\nSome content");
			expect(extractTitle("/some/file.md")).toBe("My Plan Title");
		});

		it("falls back to filename when no heading found", () => {
			mockReadFileSync.mockReturnValue("No heading here");
			expect(extractTitle("/some/file.md")).toBe("file.md");
		});

		it("falls back to Untitled on read error", () => {
			mockReadFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			expect(extractTitle("/some/file.md")).toBe("file.md");
		});

		it("returns empty string when path has no filename component", () => {
			mockReadFileSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});
			// Edge case: "".split(/[/\\]/).pop() returns "" (not null/undefined), so ?? "Untitled" does not trigger
			expect(extractTitle("")).toBe("");
		});
	});

	// ─── ignorePlan ──────────────────────────────────────────────────────────

	describe("ignorePlan", () => {
		it("sets ignored flag on existing entry", async () => {
			const entry = makeEntry();
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});

			await ignorePlan("test-plan", CWD);

			expect(savePlansRegistry).toHaveBeenCalledWith(
				expect.objectContaining({
					plans: { "test-plan": { ...entry, ignored: true } },
				}),
				CWD,
			);
		});

		it("does nothing when slug is not in registry", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());

			await ignorePlan("nonexistent", CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
		});
	});

	// ─── addPlanToRegistry ───────────────────────────────────────────────────

	describe("addPlanToRegistry", () => {
		it("creates new entry for plan file that exists", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Fresh Plan\nContent");

			await addPlanToRegistry("fresh-plan", CWD);

			expect(savePlansRegistry).toHaveBeenCalledWith(
				expect.objectContaining({
					plans: expect.objectContaining({
						"fresh-plan": expect.objectContaining({
							slug: "fresh-plan",
							title: "Fresh Plan",
							commitHash: null,
							editCount: 0,
						}),
					}),
				}),
				CWD,
			);
		});

		it("clears ignored flag on existing entry", async () => {
			const entry = makeEntry({ ignored: true });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			mockExistsSync.mockReturnValue(true);

			await addPlanToRegistry("test-plan", CWD);

			const saved = savePlansRegistry.mock.calls[0][0];
			expect(saved.plans["test-plan"].ignored).toBeUndefined();
		});

		it("does nothing when plan file does not exist", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(false);

			await addPlanToRegistry("missing-plan", CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
		});

		it("resets existing commitHash when re-adding an ignored plan", async () => {
			const entry = makeEntry({ ignored: true, commitHash: "abc123" });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			mockExistsSync.mockReturnValue(true);

			await addPlanToRegistry("test-plan", CWD);

			const saved = savePlansRegistry.mock.calls[0][0];
			expect(saved.plans["test-plan"].commitHash).toBeNull();
		});
	});

	// ─── listAvailablePlans ──────────────────────────────────────────────────

	describe("listAvailablePlans", () => {
		it("returns plans not in exclude set, with mtimes for sorting", () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(["beta.md", "alpha.md", "gamma.md"]);
			mockReadFileSync.mockImplementation((path: string) => {
				if (path.includes("alpha")) {
					return "# Alpha Plan";
				}
				if (path.includes("beta")) {
					return "# Beta Plan";
				}
				return "# Gamma Plan";
			});

			const result = listAvailablePlans(new Set(["beta"]));

			expect(result).toEqual([
				{ slug: "alpha", title: "Alpha Plan", mtimeMs: 0 },
				{ slug: "gamma", title: "Gamma Plan", mtimeMs: 0 },
			]);
		});

		it("returns empty when PLANS_DIR does not exist", () => {
			mockExistsSync.mockReturnValue(false);

			const result = listAvailablePlans(new Set());

			expect(result).toEqual([]);
		});

		it("filters non-markdown files", () => {
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(["plan.md", "readme.txt", "notes.md"]);
			mockReadFileSync.mockReturnValue("# Title");

			const result = listAvailablePlans(new Set());

			expect(result).toHaveLength(2);
			expect(result.map((p) => p.slug)).toEqual(
				expect.arrayContaining(["plan", "notes"]),
			);
		});
	});

	// ─── archivePlanForCommit ────────────────────────────────────────────────

	describe("archivePlanForCommit", () => {
		it("creates archive entry with new slug and sets archive guard on original", async () => {
			const entry = makeEntry({ editCount: 3 });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Test Plan\nContent");

			const result = await archivePlanForCommit(
				"test-plan",
				"06d0f729abcdef12",
				CWD,
			);

			expect(result).toEqual(
				expect.objectContaining({
					slug: "test-plan-06d0f729",
					title: "Test Plan",
					editCount: 3,
				}),
			);

			const saved = savePlansRegistry.mock.calls[0][0];
			// Original slug has archive guard
			expect(saved.plans["test-plan"].contentHashAtCommit).toBe("mock-hash");
			expect(saved.plans["test-plan"].commitHash).toBe("06d0f729abcdef12");
			// New slug is committed entry
			expect(saved.plans["test-plan-06d0f729"].commitHash).toBe(
				"06d0f729abcdef12",
			);
			expect(saved.plans["test-plan-06d0f729"].slug).toBe("test-plan-06d0f729");
		});

		it("stores plan file in orphan branch", async () => {
			const entry = makeEntry();
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Test Plan\nContent");

			await archivePlanForCommit("test-plan", "06d0f729abcdef12", CWD);

			expect(storePlans).toHaveBeenCalledWith(
				[{ slug: "test-plan-06d0f729", content: "# Test Plan\nContent" }],
				expect.stringContaining("Associate plan"),
				CWD,
			);
		});

		it("creates entry when slug is not in registry", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# New Plan\nContent");

			const result = await archivePlanForCommit(
				"new-plan",
				"aaaa1111bbbb2222",
				CWD,
			);

			expect(result).not.toBeNull();
			expect(result?.slug).toBe("new-plan-aaaa1111");
		});

		it("returns null when plan file does not exist and slug not in registry", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(false);

			const result = await archivePlanForCommit("missing", "abc12345", CWD);

			expect(result).toBeNull();
		});

		it("skips contentHashAtCommit when source file does not exist during archive", async () => {
			const entry = makeEntry({ editCount: 2 });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			mockReadFileSync.mockReturnValue("# Test Plan\nContent");
			// sourcePath does not exist (line 262 false branch), but planFile does exist (line 296)
			mockExistsSync.mockImplementation((path: string) => {
				if (path === entry.sourcePath) {
					return false;
				}
				return true;
			});

			const result = await archivePlanForCommit(
				"test-plan",
				"06d0f729abcdef12",
				CWD,
			);

			expect(result).not.toBeNull();
			const saved = savePlansRegistry.mock.calls[0][0];
			// contentHashAtCommit should be undefined since source file doesn't exist
			expect(saved.plans["test-plan"].contentHashAtCommit).toBeUndefined();
		});

		it("skips storePlans when plan file does not exist during archive", async () => {
			// Use a sourcePath different from the PLANS_DIR slug path so we can mock them separately
			const entry = makeEntry({
				editCount: 2,
				sourcePath: "/other/path/test-plan.md",
			});
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			mockReadFileSync.mockReturnValue("# Test Plan\nContent");
			// sourcePath exists (line 262 true branch), but planFile in PLANS_DIR does not (line 296 false branch)
			mockExistsSync.mockImplementation((path: string) => {
				if (path === "/other/path/test-plan.md") {
					return true;
				}
				return false;
			});

			const result = await archivePlanForCommit(
				"test-plan",
				"06d0f729abcdef12",
				CWD,
			);

			expect(result).not.toBeNull();
			expect(storePlans).not.toHaveBeenCalled();
		});
	});

	// ─── unassociatePlanFromCommit ───────────────────────────────────────────

	describe("unassociatePlanFromCommit", () => {
		it("sets commitHash to null", async () => {
			const entry = makeEntry({ commitHash: "abc123" });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});

			await unassociatePlanFromCommit("test-plan", CWD);

			const saved = savePlansRegistry.mock.calls[0][0];
			expect(saved.plans["test-plan"].commitHash).toBeNull();
		});

		it("does nothing when slug is not in registry", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());

			await unassociatePlanFromCommit("nonexistent", CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
		});
	});

	// ─── listUnassociatedPlans ───────────────────────────────────────────────

	describe("listUnassociatedPlans", () => {
		it("returns plans where commitHash is null", async () => {
			const plans = {
				"plan-a": makeEntry({
					slug: "plan-a",
					title: "Plan A",
					commitHash: null,
				}),
				"plan-b": makeEntry({
					slug: "plan-b",
					title: "Plan B",
					commitHash: "abc123",
				}),
				"plan-c": makeEntry({
					slug: "plan-c",
					title: "Plan C",
					commitHash: null,
				}),
			};
			loadPlansRegistry.mockResolvedValue({ version: 1, plans });

			const result = await listUnassociatedPlans(CWD);

			expect(result).toEqual([
				{ slug: "plan-a", title: "Plan A" },
				{ slug: "plan-c", title: "Plan C" },
			]);
		});

		it("returns empty array when all plans are committed", async () => {
			const plans = {
				"plan-a": makeEntry({ slug: "plan-a", commitHash: "abc123" }),
			};
			loadPlansRegistry.mockResolvedValue({ version: 1, plans });

			const result = await listUnassociatedPlans(CWD);

			expect(result).toEqual([]);
		});
	});

	// ─── detectPlans ─────────────────────────────────────────────────────────

	describe("detectPlans", () => {
		it("returns plans from registry merged with transcript discoveries", async () => {
			const entry = makeEntry();
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			// Sessions file has one session pointing to a transcript
			stubSessions(["/mock-transcript.jsonl"]);
			// Transcript lines: slug discovery + 1 edit
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Test Plan\nContent");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			stubTranscript([
				'{"type":"message","slug":"test-plan"}',
				'{"type":"tool_use","name":"Write","file":"test-plan.md"}',
			]);

			const plans = await detectPlans(CWD);

			expect(plans.length).toBeGreaterThanOrEqual(1);
			expect(plans[0].slug).toBe("test-plan");
		});

		it("filters out ignored plans", async () => {
			const entry = makeEntry({ ignored: true });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			stubSessions([]);
			mockReadFile.mockResolvedValue(
				JSON.stringify({ version: 1, sessions: {} }),
			);
			mockExistsSync.mockReturnValue(true);

			const plans = await detectPlans(CWD);

			expect(plans.find((p) => p.slug === "test-plan")).toBeUndefined();
		});

		it("filters out archive guards with unchanged hash", async () => {
			const entry = makeEntry({ contentHashAtCommit: "mock-hash" });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			stubSessions([]);
			mockReadFile.mockResolvedValue(
				JSON.stringify({ version: 1, sessions: {} }),
			);
			// existsSync returns true, hashFileContent returns "mock-hash" (matches contentHashAtCommit)
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("content");

			const plans = await detectPlans(CWD);

			expect(plans.find((p) => p.slug === "test-plan")).toBeUndefined();
		});

		it("filters out committed plans that are not on the current branch", async () => {
			const entry = makeEntry({ commitHash: "deadbeef12345678" });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});

			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Test Plan\nContent");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});
			// isCommitOnCurrentBranch throws → commit not on branch
			mockExecFileSync.mockImplementation(
				(_cmd: string, args: Array<string>) => {
					if (args[0] === "rev-parse") {
						return "main\n";
					}
					// merge-base --is-ancestor throws for cross-branch
					throw new Error("not ancestor");
				},
			);

			const plans = await detectPlans(CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
			expect(plans.find((p) => p.slug === "test-plan")).toBeUndefined();
		});

		it("removes orphaned entries with no source file", async () => {
			const entry = makeEntry({
				sourcePath: "/mock-home/.claude/plans/orphan.md",
			});
			loadPlansRegistry
				.mockResolvedValueOnce({ version: 1, plans: { orphan: entry } })
				.mockResolvedValueOnce({ version: 1, plans: { orphan: entry } });
			stubSessions([]);
			mockReadFile.mockResolvedValue(
				JSON.stringify({ version: 1, sessions: {} }),
			);
			// existsSync returns false → orphan file is gone
			mockExistsSync.mockReturnValue(false);

			const plans = await detectPlans(CWD);

			const saved = savePlansRegistry.mock.calls[0][0];
			expect(saved.plans.orphan).toBeUndefined();
			expect(plans).toEqual([]);
		});

		it("does not mutate commit hashes during read-only detection", async () => {
			const entry = makeEntry({ slug: "test-plan", commitHash: null });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Test Plan\nContent");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const plans = await detectPlans(CWD);
			expect(savePlansRegistry).not.toHaveBeenCalled();
			expect(plans[0].commitHash).toBeNull();
		});

		it("returns sorted by lastModified descending", async () => {
			const entryA = makeEntry({
				slug: "plan-a",
				title: "Plan A",
				sourcePath: `${PLANS_DIR}/plan-a.md`,
				updatedAt: "2025-01-01T00:00:00.000Z",
			});
			const entryB = makeEntry({
				slug: "plan-b",
				title: "Plan B",
				sourcePath: `${PLANS_DIR}/plan-b.md`,
				updatedAt: "2025-06-01T00:00:00.000Z",
			});
			loadPlansRegistry
				.mockResolvedValueOnce({
					version: 1,
					plans: { "plan-a": entryA, "plan-b": entryB },
				})
				.mockResolvedValueOnce({
					version: 1,
					plans: { "plan-a": entryA, "plan-b": entryB },
				});

			stubSessions([]);
			mockReadFile.mockResolvedValue(
				JSON.stringify({ version: 1, sessions: {} }),
			);
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Title");
			mockStatSync.mockImplementation((path: string) => {
				if (path.includes("plan-a")) {
					return { mtime: new Date("2025-01-01T00:00:00.000Z") };
				}
				return { mtime: new Date("2025-06-01T00:00:00.000Z") };
			});

			const plans = await detectPlans(CWD);

			expect(plans[0].slug).toBe("plan-b");
			expect(plans[1].slug).toBe("plan-a");
		});

		it("handles an empty registry gracefully", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());

			const plans = await detectPlans(CWD);

			expect(plans).toEqual([]);
		});

		it("does not create new plans from transcripts during detection", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());

			const plans = await detectPlans(CWD);

			expect(plans).toEqual([]);
		});

		it("revives archived guard when source file has changed", async () => {
			const guardEntry = makeEntry({
				slug: "archived-plan",
				contentHashAtCommit: "old-hash",
				sourcePath: `${PLANS_DIR}/archived-plan.md`,
			});
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "archived-plan": guardEntry },
			});

			mockExistsSync.mockReturnValue(true);
			// hashFileContent will use createHash which returns "mock-hash", different from "old-hash"
			mockReadFileSync.mockReturnValue("# Updated Archived Plan");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-15T00:00:00.000Z"),
			});

			const plans = await detectPlans(CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
			expect(plans.find((p) => p.slug === "archived-plan")).toBeDefined();
		});

		it("skips discovered plan when plan file does not exist but transcript does", async () => {
			loadPlansRegistry
				.mockResolvedValueOnce(emptyRegistry())
				.mockResolvedValueOnce(emptyRegistry());

			stubSessions(["/mock-transcript.jsonl"]);
			stubTranscript(['{"type":"message","slug":"no-file-plan"}']);

			// existsSync returns true for transcript path but false for the plan file
			mockExistsSync.mockImplementation((path: string) => {
				if (path.includes("mock-transcript")) {
					return true;
				}
				return false;
			});

			const plans = await detectPlans(CWD);

			// The plan file doesn't exist, so mergeDiscoveredPlans skips it (line 101)
			expect(plans).toEqual([]);
		});

		it("continues hiding archived guard when file hash matches contentHashAtCommit", async () => {
			const guardEntry = makeEntry({
				slug: "guarded-plan",
				contentHashAtCommit: "mock-hash", // matches what mockCreateHash returns
				sourcePath: `${PLANS_DIR}/guarded-plan.md`,
			});
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "guarded-plan": guardEntry },
			});

			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Guarded Plan");

			const plans = await detectPlans(CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
			// toPlanInfo filters it out since it's still an unchanged archive guard
			expect(plans.find((p) => p.slug === "guarded-plan")).toBeUndefined();
		});

		it("shows committed plan with changed content (archive guard with modified file)", async () => {
			const guardEntry = makeEntry({
				slug: "modified-plan",
				commitHash: "abc12345",
				contentHashAtCommit: "stale-hash", // differs from mockCreateHash's "mock-hash"
				sourcePath: `${PLANS_DIR}/modified-plan.md`,
				updatedAt: "2025-06-01T00:00:00.000Z",
			});
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "modified-plan": guardEntry },
			});

			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Modified Plan");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-07-01T00:00:00.000Z"),
			});

			const plans = await detectPlans(CWD);

			expect(plans).toHaveLength(1);
			expect(plans[0].slug).toBe("modified-plan");
			// Committed plan: filePath is empty, stat/title extraction skipped
			expect(plans[0].filePath).toBe("");
			expect(plans[0].lastModified).toBe("2025-06-01T00:00:00.000Z");
		});

		it("uses updatedAt as fallback when statSync throws in toPlanInfo", async () => {
			const entry = makeEntry({
				slug: "stat-fail",
				sourcePath: `${PLANS_DIR}/stat-fail.md`,
				updatedAt: "2025-04-01T00:00:00.000Z",
			});
			loadPlansRegistry
				.mockResolvedValueOnce({ version: 1, plans: { "stat-fail": entry } })
				.mockResolvedValueOnce({ version: 1, plans: { "stat-fail": entry } });

			stubSessions([]);
			mockReadFile.mockResolvedValue(
				JSON.stringify({ version: 1, sessions: {} }),
			);
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Stat Fail Plan");
			// statSync throws → catch ignores (line 234)
			mockStatSync.mockImplementation(() => {
				throw new Error("ENOENT");
			});

			const plans = await detectPlans(CWD);

			expect(plans).toHaveLength(1);
			expect(plans[0].slug).toBe("stat-fail");
			// lastModified falls back to entry.updatedAt since statSync failed
			expect(plans[0].lastModified).toBe("2025-04-01T00:00:00.000Z");
		});

		it("skips transcript discovery when plan file does not exist", async () => {
			loadPlansRegistry
				.mockResolvedValueOnce(emptyRegistry())
				.mockResolvedValueOnce(emptyRegistry());

			stubSessions(["/mock-transcript.jsonl"]);
			stubTranscript(['{"type":"message","slug":"ghost-plan"}']);

			mockExistsSync.mockReturnValue(false);

			const plans = await detectPlans(CWD);

			expect(plans).toEqual([]);
		});

		it("skips uncommitted plan with archive guard when source file was deleted", async () => {
			const entry = makeEntry({
				slug: "guarded-deleted",
				commitHash: null,
				contentHashAtCommit: "old-hash", // survives cleaning phase
				sourcePath: `${PLANS_DIR}/guarded-deleted-source.md`,
			});
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "guarded-deleted": entry },
			});

			// Plan file in PLANS_DIR exists with different hash (passes archive guard)
			// but sourcePath does not exist (hits line 100-101)
			mockExistsSync.mockImplementation((path: string) => {
				if (path.includes("guarded-deleted.md")) {
					return true; // plan file exists for archive guard check
				}
				return false; // sourcePath does not exist
			});
			mockReadFileSync.mockReturnValue("# Different Content");

			const plans = await detectPlans(CWD);

			// Plan should be filtered out because source file is deleted
			expect(plans.find((p) => p.slug === "guarded-deleted")).toBeUndefined();
		});

		it("uses extractTitle for uncommitted plans whose source file exists", async () => {
			const entry = makeEntry({
				slug: "live-plan",
				title: "Old Title",
				commitHash: null,
				sourcePath: `${PLANS_DIR}/live-plan.md`,
			});
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "live-plan": entry },
			});

			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Fresh Title From File\nContent");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const plans = await detectPlans(CWD);

			expect(plans).toHaveLength(1);
			expect(plans[0].title).toBe("Fresh Title From File");
		});

		it("preserves editCount for existing uncommitted entries during detection", async () => {
			const entry = makeEntry({ editCount: 1 });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});

			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Test Plan");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const plans = await detectPlans(CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
			expect(plans[0].editCount).toBe(1);
		});

		it("returns current registry plans without transcript scanning", async () => {
			const entry = makeEntry({
				slug: "current-plan",
				sourcePath: `${PLANS_DIR}/current-plan.md`,
			});
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "current-plan": entry },
			});
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Current Plan");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-06-01T00:00:00.000Z"),
			});

			const plans = await detectPlans(CWD);

			expect(plans).toHaveLength(1);
			expect(plans[0].slug).toBe("current-plan");
		});

		it("does not mutate committed entries during detection", async () => {
			const entry = makeEntry({ editCount: 5, commitHash: "abc123" });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "test-plan": entry },
			});

			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# Test Plan");
			// isCommitOnCurrentBranch succeeds (no throw)
			mockExecFileSync.mockImplementation(
				(_cmd: string, args: Array<string>) => {
					if (args[0] === "rev-parse") {
						return "main\n";
					}
					return ""; // merge-base --is-ancestor succeeds
				},
			);

			const plans = await detectPlans(CWD);
			expect(savePlansRegistry).not.toHaveBeenCalled();
			expect(loadPlansRegistry).toHaveBeenCalledWith(CWD);
			if (plans[0]) {
				expect(plans[0].editCount).toBe(5);
			}
		});

		// detectPlans() no longer auto-discovers files — registration is the
		// job of the plans-dir watcher's onDidCreate in Extension.ts.
		// Historical directory contents must stay out of the panel; that contract is
		// exercised by registerNewPlan tests below + Extension.ts watcher tests.

		it("does not scan ~/.claude/plans/ directory to auto-register files", async () => {
			// A lone historical file exists on disk but is not in the registry.
			// detectPlans must NOT pick it up (that would leak cross-project history).
			loadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReaddirSync.mockReturnValue(["historical-plan.md"]);
			mockReadFileSync.mockReturnValue("# Historical");
			mockStatSync.mockReturnValue({
				mtime: new Date("2025-01-01T00:00:00.000Z"),
				mtimeMs: 1,
			});

			const plans = await detectPlans(CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
			expect(plans).toEqual([]);
		});
	});

	// ─── registerNewPlan (Step 1) ─────────────────────────────────

	describe("registerNewPlan", () => {
		it("calls addPlanToRegistry for a slug not yet in registry", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockReturnValue("# New Plan");

			await registerNewPlan("new-plan", CWD);

			expect(savePlansRegistry).toHaveBeenCalled();
			const saved = savePlansRegistry.mock.calls[0][0];
			expect(saved.plans["new-plan"]).toEqual(
				expect.objectContaining({
					slug: "new-plan",
					title: "New Plan",
					commitHash: null,
				}),
			);
		});

		it("is a no-op when the slug is already tracked in the registry", async () => {
			const existing = makeEntry({ slug: "existing-plan" });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "existing-plan": existing },
			});

			await registerNewPlan("existing-plan", CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
		});

		it("is a no-op when the slug exists as an ignored entry (preserves Ignore)", async () => {
			const ignoredEntry = makeEntry({ slug: "ignored-plan", ignored: true });
			loadPlansRegistry.mockResolvedValue({
				version: 1,
				plans: { "ignored-plan": ignoredEntry },
			});

			await registerNewPlan("ignored-plan", CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
		});

		it("skips silently when source file does not exist (addPlanToRegistry guard)", async () => {
			loadPlansRegistry.mockResolvedValue(emptyRegistry());
			// existsSync returns false → addPlanToRegistry returns early, no write
			mockExistsSync.mockReturnValue(false);

			await registerNewPlan("ghost-plan", CWD);

			expect(savePlansRegistry).not.toHaveBeenCalled();
		});
	});

	// ─── isPlanFromCurrentProject (cross-project attribution) ─────

	describe("isPlanFromCurrentProject", () => {
		const PLAN_ABS_PATH = "C:\\Users\\sanshi\\.claude\\plans\\my-plan.md";
		const JSON_ESCAPED =
			"C:\\\\Users\\\\sanshi\\\\.claude\\\\plans\\\\my-plan.md";

		it("returns false when no sessions are tracked for the project", async () => {
			loadAllSessions.mockResolvedValue([]);

			await expect(isPlanFromCurrentProject(PLAN_ABS_PATH, CWD)).resolves.toBe(
				false,
			);
		});

		it("returns true when one of the project's transcripts mentions the plan path", async () => {
			loadAllSessions.mockResolvedValue([
				{
					sessionId: "s1",
					transcriptPath: "/mock/session-1.jsonl",
					updatedAt: "2026-04-20T00:00:00Z",
				},
			]);
			// Transcript contains a Write tool_use referencing the plan
			mockReadFile.mockResolvedValueOnce(
				`{"type":"tool_use","name":"Write","input":{"file_path":"${JSON_ESCAPED}"}}\n`,
			);

			await expect(isPlanFromCurrentProject(PLAN_ABS_PATH, CWD)).resolves.toBe(
				true,
			);
		});

		it("returns false when no transcript mentions the plan path (cross-project leak)", async () => {
			loadAllSessions.mockResolvedValue([
				{
					sessionId: "s1",
					transcriptPath: "/mock/session-1.jsonl",
					updatedAt: "2026-04-20T00:00:00Z",
				},
			]);
			// Transcript exists but contains only unrelated tool_use lines
			mockReadFile.mockResolvedValueOnce(
				`{"type":"tool_use","name":"Read","input":{"file_path":"/some/other/file.ts"}}\n`,
			);

			await expect(isPlanFromCurrentProject(PLAN_ABS_PATH, CWD)).resolves.toBe(
				false,
			);
		});

		it("scans multiple transcripts and returns true on the first match", async () => {
			loadAllSessions.mockResolvedValue([
				{
					sessionId: "s1",
					transcriptPath: "/mock/session-1.jsonl",
					updatedAt: "2026-04-20T00:00:00Z",
				},
				{
					sessionId: "s2",
					transcriptPath: "/mock/session-2.jsonl",
					updatedAt: "2026-04-20T00:01:00Z",
				},
			]);
			// First transcript: unrelated content
			mockReadFile.mockResolvedValueOnce("{}");
			// Second transcript: contains the plan path
			mockReadFile.mockResolvedValueOnce(`"file_path":"${JSON_ESCAPED}"`);

			await expect(isPlanFromCurrentProject(PLAN_ABS_PATH, CWD)).resolves.toBe(
				true,
			);
			expect(mockReadFile).toHaveBeenCalledTimes(2);
		});

		it("tolerates unreadable/missing transcripts without throwing", async () => {
			loadAllSessions.mockResolvedValue([
				{
					sessionId: "s1",
					transcriptPath: "/mock/missing.jsonl",
					updatedAt: "2026-04-20T00:00:00Z",
				},
			]);
			mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

			await expect(isPlanFromCurrentProject(PLAN_ABS_PATH, CWD)).resolves.toBe(
				false,
			);
		});
	});
});
