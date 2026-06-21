import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchCatalog, CompiledContext, RecallPayload } from "./ContextCompiler.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./ContextCompiler.js", () => ({
	listBranchCatalog: vi.fn(),
	compileTaskContext: vi.fn(),
	buildRecallPayload: vi.fn(),
	DEFAULT_TOKEN_BUDGET: 60000,
}));

vi.mock("../util/Subprocess.js", async () => {
	const actual = await vi.importActual<typeof import("../util/Subprocess.js")>("../util/Subprocess.js");
	return {
		...actual,
		execFileSyncHidden: vi.fn(() => "feature/seeded"),
	};
});

import { execFileSyncHidden } from "../util/Subprocess.js";
import { buildRecallPayload, compileTaskContext, listBranchCatalog } from "./ContextCompiler.js";
import { resolveRecall } from "./RecallResolver.js";

const mockListBranchCatalog = vi.mocked(listBranchCatalog);
const mockCompileTaskContext = vi.mocked(compileTaskContext);
const mockBuildRecallPayload = vi.mocked(buildRecallPayload);
const mockExecFileSyncHidden = vi.mocked(execFileSyncHidden);

// ─── Test data helpers ────────────────────────────────────────────────────────

const SEEDED_BRANCH = "feature/seeded";
const PERIOD = { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:01:00.000Z" };

function makeEmptyCatalog(): BranchCatalog {
	return { type: "catalog", branches: [] };
}

function makeSeededCatalog(): BranchCatalog {
	return {
		type: "catalog",
		branches: [{ branch: SEEDED_BRANCH, commitCount: 1, period: PERIOD, commitMessages: ["Add feature X"] }],
	};
}

function makeCatalogWithBranch(branch: string): BranchCatalog {
	return {
		type: "catalog",
		branches: [{ branch, commitCount: 1, period: PERIOD, commitMessages: ["Some work"] }],
	};
}

const EMPTY_STATS = {
	topicCount: 0,
	planCount: 0,
	noteCount: 0,
	decisionCount: 0,
	topicTokens: 0,
	planTokens: 0,
	noteTokens: 0,
	decisionTokens: 0,
	transcriptTokens: 0,
	totalTokens: 0,
};

function makeCompiledContext(commitCount: number): CompiledContext {
	return {
		branch: SEEDED_BRANCH,
		period: PERIOD,
		commitCount,
		totalFilesChanged: 0,
		totalInsertions: 0,
		totalDeletions: 0,
		summaries: [],
		plans: [],
		notes: [],
		keyDecisions: [],
		stats: EMPTY_STATS,
	};
}

function makeRecallPayload(): RecallPayload {
	return {
		type: "recall",
		branch: SEEDED_BRANCH,
		period: PERIOD,
		commitCount: 1,
		totalFilesChanged: 0,
		totalInsertions: 0,
		totalDeletions: 0,
		commits: [],
		plans: [],
		notes: [],
		stats: EMPTY_STATS,
		estimatedTokens: 0,
	};
}

// ─── resolveRecall ────────────────────────────────────────────────────────────

describe("resolveRecall", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: git reports the seeded branch
		mockExecFileSyncHidden.mockReturnValue(`${SEEDED_BRANCH}\n`);
		// Default catalog: seeded branch present
		mockListBranchCatalog.mockResolvedValue(makeSeededCatalog());
		// Default compileTaskContext: one commit
		mockCompileTaskContext.mockResolvedValue(makeCompiledContext(1));
		// Default buildRecallPayload: recall result
		mockBuildRecallPayload.mockReturnValue(makeRecallPayload());
	});

	it("returns type:error for invalid characters", async () => {
		const r = await resolveRecall("bad;rm -rf", "/repo");
		expect(r.type).toBe("error");
	});

	it("returns type:recall for an exact branch match", async () => {
		const r = await resolveRecall(SEEDED_BRANCH, "/repo");
		expect(r.type).toBe("recall");
	});

	it("returns type:error when the branch matches but has zero commits recorded", async () => {
		mockCompileTaskContext.mockResolvedValue(makeCompiledContext(0));
		const r = await resolveRecall(SEEDED_BRANCH, "/repo");
		expect(r.type).toBe("error");
	});

	it("returns type:catalog with query for a non-matching fragment", async () => {
		const r = await resolveRecall("no-such-frag", "/repo");
		expect(r.type).toBe("catalog");
		expect((r as { query?: string }).query).toBe("no-such-frag");
	});

	it("returns type:error when the repo has no records and no branch is given", async () => {
		mockListBranchCatalog.mockResolvedValue(makeEmptyCatalog());
		mockExecFileSyncHidden.mockReturnValue("");
		const r = await resolveRecall(undefined, "/empty-repo");
		expect(r.type).toBe("error");
	});

	it("returns type:catalog when no branch arg is given but the repo has records", async () => {
		mockListBranchCatalog.mockResolvedValue(makeCatalogWithBranch("main"));
		// Git returns empty string → branch stays falsy → falls through to catalog return
		mockExecFileSyncHidden.mockReturnValue("");
		const r = await resolveRecall(undefined, "/repo");
		// catalog has branches → should return catalog (not error)
		expect(r.type).toBe("catalog");
	});

	it("returns type:catalog when git throws getting current branch but repo has records", async () => {
		mockListBranchCatalog.mockResolvedValue(makeCatalogWithBranch("main"));
		mockExecFileSyncHidden.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		const r = await resolveRecall(undefined, "/repo");
		expect(r.type).toBe("catalog");
	});
});
