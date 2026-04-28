import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock GitOps
vi.mock("./GitOps.js", () => ({
	readFileFromBranch: vi.fn(),
	writeMultipleFilesToBranch: vi.fn(),
	listFilesInBranch: vi.fn(),
	getTreeHash: vi.fn(),
	getDiffStats: vi.fn(),
}));

vi.mock("./SessionTracker.js", () => ({
	acquireLock: vi.fn(),
	releaseLock: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import type {
	CommitInfo,
	CommitSummary,
	FileWrite,
	PlanProgressArtifact,
	SummaryIndex,
	SummaryIndexEntry,
} from "../Types.js";
import {
	getDiffStats,
	getTreeHash,
	listFilesInBranch,
	readFileFromBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";
import { acquireLock, releaseLock } from "./SessionTracker.js";
import {
	deleteTranscript,
	expandSourcesForConsolidation,
	getIndex,
	getIndexEntryMap,
	getSummary,
	getSummaryCount,
	getTranscriptHashes,
	indexNeedsMigration,
	listSummaries,
	listSummaryHashes,
	mergeManyToOne,
	migrateIndexToV3,
	migrateOneToOne,
	readNoteFromBranch,
	readPlanFromBranch,
	readPlanProgress,
	readTranscript,
	readTranscriptsForCommits,
	removeFromIndex,
	saveTranscriptsBatch,
	scanTreeHashAliases,
	storeNotes,
	storePlans,
	storeSummary,
	stripFunctionalMetadata,
} from "./SummaryStore.js";

/** Creates a minimal mock CommitSummary in tree format (leaf node). */
function createMockSummary(hash = "abc123def456", message = "Fix bug"): CommitSummary {
	return {
		version: 3,
		commitHash: hash,
		commitMessage: message,
		commitAuthor: "John",
		commitDate: "2026-02-19T10:00:00Z",
		branch: "main",
		generatedAt: "2026-02-19T10:00:05Z",
		transcriptEntries: 5,
		stats: { filesChanged: 2, insertions: 10, deletions: 5 },
		topics: [
			{
				title: "Fix login",
				trigger: "Users experiencing errors",
				response: "Fixed the bug",
				decisions: "None",
			},
		],
	};
}

function createMockCommitInfo(hash: string, message = "New commit"): CommitInfo {
	return { hash, message, author: "Jane", date: "2026-02-20T10:00:00Z" };
}

/** Creates a v3 SummaryIndexEntry for a root node. */
function rootEntry(hash: string, message = "commit", date = "2026-02-19T10:00:00Z"): SummaryIndexEntry {
	return {
		commitHash: hash,
		parentCommitHash: null,
		commitMessage: message,
		commitDate: date,
		branch: "main",
		generatedAt: date,
	};
}

/** Creates a v3 SummaryIndex with root-only entries. */
function v3Index(entries: SummaryIndexEntry[], commitAliases?: Record<string, string>): SummaryIndex {
	return { version: 3, entries, ...(commitAliases && { commitAliases }) };
}

describe("SummaryStore", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		// Default: getTreeHash returns null (no treeHash tracking by default)
		vi.mocked(getTreeHash).mockResolvedValue(null);
		vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 2 });
		vi.mocked(acquireLock).mockResolvedValue(true);
		vi.mocked(releaseLock).mockResolvedValue(undefined);
	});

	describe("storeSummary", () => {
		it("should write summary and index in a single atomic commit", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			const summary = createMockSummary();
			await storeSummary(summary);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const callArgs = vi.mocked(writeMultipleFilesToBranch).mock.calls[0];
			const files = callArgs[1] as ReadonlyArray<FileWrite>;
			expect(files).toHaveLength(2);
			expect(files[0].path).toBe("summaries/abc123def456.json");
			expect(files[1].path).toBe("index.json");

			const summaryContent = JSON.parse(files[0].content) as CommitSummary;
			expect(summaryContent.commitHash).toBe("abc123def456");

			const indexContent = JSON.parse(files[1].content) as SummaryIndex;
			expect(indexContent.version).toBe(3);
			expect(indexContent.entries).toHaveLength(1);
			expect(indexContent.entries[0].commitHash).toBe("abc123def456");
			expect(indexContent.entries[0].parentCommitHash).toBeNull();
			// Root entry should have cached diffStats and topicCount from flattenSummaryTree
			expect(indexContent.entries[0].diffStats).toEqual({ filesChanged: 1, insertions: 5, deletions: 2 });
			expect(indexContent.entries[0].topicCount).toBe(1);
		});

		it("should append a transcript artifact when transcript sessions are present", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			const summary = createMockSummary();
			await storeSummary(summary, undefined, false, {
				transcript: {
					version: 1,
					commitHash: summary.commitHash,
					sessions: [
						{
							sessionId: "claude/session-1",
							source: "claude",
							startedAt: "2026-02-19T09:55:00Z",
							entries: [],
						},
					],
				},
			});

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			expect(files).toHaveLength(3);
			expect(files[2]).toMatchObject({ path: "transcripts/abc123def456.json" });
		});

		it("should append plan progress artifacts when provided", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			const summary = createMockSummary();
			const planProgress: PlanProgressArtifact[] = [
				{
					version: 1,
					commitHash: summary.commitHash,
					commitMessage: summary.commitMessage,
					commitDate: "2026-02-19T10:00:00Z",
					planSlug: "my-plan-abc123de",
					originalSlug: "my-plan",
					summary: "Implemented the feature.",
					steps: [
						{ id: "1", description: "Add types", status: "completed", note: "Done." },
						{ id: "2", description: "Wire up", status: "not_started", note: null },
					],
					llm: {
						model: "claude-haiku-4-5-20251001",
						inputTokens: 500,
						outputTokens: 200,
						apiLatencyMs: 350,
						stopReason: "end_turn",
					},
				},
			];

			await storeSummary(summary, undefined, false, { planProgress });

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			// 2 base files (summary + index) + 1 plan progress
			expect(files).toHaveLength(3);
			expect(files[2].path).toBe("plan-progress/my-plan-abc123de.json");

			const content = JSON.parse(files[2].content) as PlanProgressArtifact;
			expect(content.planSlug).toBe("my-plan-abc123de");
			expect(content.originalSlug).toBe("my-plan");
			expect(content.summary).toBe("Implemented the feature.");
			expect(content.steps).toHaveLength(2);
			expect(content.steps[0].status).toBe("completed");
		});

		it("should write multiple plan progress artifacts for multiple plans", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			const summary = createMockSummary();
			const planProgress: PlanProgressArtifact[] = [
				{
					version: 1,
					commitHash: summary.commitHash,
					commitMessage: summary.commitMessage,
					commitDate: "2026-02-19T10:00:00Z",
					planSlug: "plan-a-abc123de",
					originalSlug: "plan-a",
					summary: "Worked on plan A.",
					steps: [],
					llm: {
						model: "claude-haiku-4-5-20251001",
						inputTokens: 100,
						outputTokens: 50,
						apiLatencyMs: 200,
						stopReason: "end_turn",
					},
				},
				{
					version: 1,
					commitHash: summary.commitHash,
					commitMessage: summary.commitMessage,
					commitDate: "2026-02-19T10:00:00Z",
					planSlug: "plan-b-abc123de",
					originalSlug: "plan-b",
					summary: "Worked on plan B.",
					steps: [],
					llm: {
						model: "claude-haiku-4-5-20251001",
						inputTokens: 100,
						outputTokens: 50,
						apiLatencyMs: 200,
						stopReason: "end_turn",
					},
				},
			];

			await storeSummary(summary, undefined, false, { planProgress });

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			expect(files).toHaveLength(4); // summary + index + 2 plan progress
			expect(files[2].path).toBe("plan-progress/plan-a-abc123de.json");
			expect(files[3].path).toBe("plan-progress/plan-b-abc123de.json");
		});

		it("should flatten tree children into the index", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			const child = createMockSummary("child111", "Child commit");
			const parent: CommitSummary = { ...createMockSummary("parent222", "Parent commit"), children: [child] };
			await storeSummary(parent);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const indexContent = JSON.parse(files[1].content) as SummaryIndex;
			// Both parent and child should be in the flat index
			expect(indexContent.entries).toHaveLength(2);
			const parentEntry = indexContent.entries.find((e) => e.commitHash === "parent222");
			const childEntry = indexContent.entries.find((e) => e.commitHash === "child111");
			expect(parentEntry?.parentCommitHash).toBeNull();
			expect(childEntry?.parentCommitHash).toBe("parent222");
			// Only root entries get diffStats and topicCount
			expect(parentEntry?.diffStats).toEqual({ filesChanged: 1, insertions: 5, deletions: 2 });
			// countTopics sums recursively: parent (1 topic) + child (1 topic) = 2
			expect(parentEntry?.topicCount).toBe(2);
			expect(childEntry?.diffStats).toBeUndefined();
			expect(childEntry?.topicCount).toBeUndefined();
		});
	});

	describe("getSummary (direct-read)", () => {
		// readFileFromBranch is mocked per test. Lookup contract:
		//   1. Try readSummaryFile(hash) -- 1 read; if it returns non-null, return.
		//   2. Otherwise loadIndex (1 read), check commitAliases, optional tree-hash
		//      scan, then a final readSummaryFile(matchedHash) when an alias hits.
		//
		// Direct file read returns the original summary for any hash that ever
		// owned a `summaries/{hash}.json` file -- which is every hash that entered
		// the system, since mergeManyToOne / migrateOneToOne never delete old files.

		it("returns the original summary directly via readSummaryFile (root hash)", async () => {
			const summary = createMockSummary();
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(summary));

			const result = await getSummary("abc123def456");
			expect(result).not.toBeNull();
			expect(result?.commitHash).toBe("abc123def456");
			expect(result?.topics?.[0].title).toBe("Fix login");
			// Only one read -- direct path hit, no index lookup needed.
			expect(vi.mocked(readFileFromBranch)).toHaveBeenCalledTimes(1);
		});

		it("returns the original child summary when the child still has its independent file", async () => {
			// In v3+v4 storage, mergeManyToOne and migrateOneToOne preserve the old
			// `summaries/{childHash}.json` files. Direct read returns the child's
			// pre-Hoist data with its full topics (rather than the stripped child
			// embedded in the squash root, which would have empty topics under v4).
			const childOriginal = createMockSummary("child111", "Child commit");
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(childOriginal));

			const result = await getSummary("child111");
			expect(result?.commitHash).toBe("child111");
			expect(result?.topics?.[0].title).toBe("Fix login");
		});

		it("falls back to commitAliases when direct read misses", async () => {
			const summary = createMockSummary("knownhash00");
			const index = v3Index([rootEntry("knownhash00")], { unknownhash0: "knownhash00" });

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // direct readSummaryFile("unknownhash0") miss
				.mockResolvedValueOnce(JSON.stringify(index)) // loadIndex
				.mockResolvedValueOnce(JSON.stringify(summary)); // readSummaryFile(aliasHash)

			const result = await getSummary("unknownhash0");
			expect(result?.commitHash).toBe("knownhash00");
		});

		it("returns null when the file read fails AND there is no index", async () => {
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // direct miss
				.mockResolvedValueOnce(null); // loadIndex returns null
			const result = await getSummary("nonexistent");
			expect(result).toBeNull();
		});

		it("returns null when the file content is malformed JSON", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("not json");
			const result = await getSummary("bad-json");
			expect(result).toBeNull();
		});

		it("returns null when nothing matches: direct miss, no aliases, no tree-hash hit", async () => {
			const index = v3Index([rootEntry("knownhash00")]);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // direct miss
				.mockResolvedValueOnce(JSON.stringify(index)); // loadIndex (no aliases match)
			// getTreeHash mock left unconfigured -> resolves to undefined, no match
			const result = await getSummary("absolutely-unknown");
			expect(result).toBeNull();
		});
	});

	describe("listSummaries", () => {
		// Read order per entry:
		//   listSummaries() -> loadIndex (1 read)
		//   then for each root entry, getSummary -> readSummaryFile (1 read; direct hit)
		//   or readSummaryFile (null) + loadIndex + maybe alias resolution (3+ reads)
		// We exercise the happy path with one direct read per entry.

		it("should skip entries whose summary files are missing (getSummary returns null)", async () => {
			const index = v3Index([
				rootEntry("hash1", "First", "2026-02-18T10:00:00Z"),
				rootEntry("hash2", "Second (missing file)", "2026-02-19T10:00:00Z"),
				rootEntry("hash3", "Third", "2026-02-20T10:00:00Z"),
			]);

			vi.mocked(readFileFromBranch)
				// listSummaries -> loadIndex
				.mockResolvedValueOnce(JSON.stringify(index))
				// getSummary("hash3") direct read (newest first)
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("hash3", "Third")))
				// getSummary("hash2") direct miss -> loadIndex (no aliases match) -> null
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(JSON.stringify(index))
				// getSummary("hash1") direct read
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("hash1", "First")));

			const summaries = await listSummaries(10);
			expect(summaries).toHaveLength(2);
			expect(summaries[0].commitHash).toBe("hash3");
			expect(summaries[1].commitHash).toBe("hash1");
		});

		it("should return summaries in reverse chronological order (root-only)", async () => {
			const index = v3Index([
				rootEntry("hash1", "First", "2026-02-18T10:00:00Z"),
				rootEntry("hash2", "Second", "2026-02-19T10:00:00Z"),
			]);

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(index)) // listSummaries -> loadIndex
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("hash2", "Second"))) // direct read newest first
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("hash1", "First"))); // direct read

			const summaries = await listSummaries(10);
			expect(summaries.length).toBe(2);
			expect(summaries[0].commitMessage).toBe("Second");
			expect(summaries[1].commitMessage).toBe("First");
		});

		it("should only list root entries (parentCommitHash == null), not children", async () => {
			const index: SummaryIndex = {
				version: 3,
				entries: [
					rootEntry("root000", "Root"),
					{
						commitHash: "child00",
						parentCommitHash: "root000",
						commitMessage: "Child",
						commitDate: "2026-02-18T10:00:00Z",
						branch: "main",
						generatedAt: "2026-02-18T10:00:05Z",
					},
				],
			};

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(index))
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("root000", "Root")));

			const summaries = await listSummaries(10);
			expect(summaries).toHaveLength(1);
			expect(summaries[0].commitHash).toBe("root000");
		});

		it("should return empty array when no index exists", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const summaries = await listSummaries();
			expect(summaries).toEqual([]);
		});

		it("should skip entries where getSummary returns null", async () => {
			const index = v3Index([
				rootEntry("exists", "Good", "2026-02-19T10:00:00Z"),
				rootEntry("missing", "Gone", "2026-02-18T10:00:00Z"),
			]);

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(index)) // listSummaries -> loadIndex
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("exists", "Good"))) // direct read
				// getSummary("missing"): direct miss -> loadIndex -> null
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(JSON.stringify(index));

			const summaries = await listSummaries(10);
			expect(summaries).toHaveLength(1);
			expect(summaries[0].commitHash).toBe("exists");
		});
	});

	describe("storeSummary edge cases", () => {
		it("should handle corrupt index JSON gracefully", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("not valid json");
			await storeSummary(createMockSummary());
			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			expect(files).toHaveLength(2);
		});

		it("should skip duplicate commit entirely", async () => {
			const existingIndex = v3Index([rootEntry("abc123def456", "Fix bug")]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));
			await storeSummary(createMockSummary());
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should handle missing branch gracefully (null index)", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			await storeSummary(createMockSummary());
			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const indexContent = JSON.parse(files[1].content) as SummaryIndex;
			expect(indexContent.entries).toHaveLength(1);
		});
	});

	describe("getSummaryCount", () => {
		it("should count only root entries (parentCommitHash is null or undefined)", async () => {
			const index: SummaryIndex = {
				version: 3,
				entries: [
					{ commitHash: "root1", parentCommitHash: null } as SummaryIndexEntry,
					{ commitHash: "child1", parentCommitHash: "root1" } as SummaryIndexEntry,
					{ commitHash: "root2", parentCommitHash: null } as SummaryIndexEntry,
					{ commitHash: "legacy", parentCommitHash: undefined } as SummaryIndexEntry,
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			expect(await getSummaryCount()).toBe(3);
		});

		it("should return 0 when no index exists", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			expect(await getSummaryCount()).toBe(0);
		});
	});

	describe("migrateOneToOne", () => {
		it("should create a rebase container node wrapping the old summary as a child", async () => {
			const oldHash = "oldhash0000000000000001";
			const newHash = "newhash0000000000000002";
			const oldSummary = createMockSummary(oldHash, "Old message");

			const existingIndex = v3Index([rootEntry(oldHash, "Old message", "2026-02-18T10:00:00Z")]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			expect(files).toHaveLength(2);

			const newSummaryContent = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummaryContent.commitHash).toBe(newHash);
			expect(newSummaryContent.commitMessage).toBe("New message");
			// v4 root: commitType = "rebase"; topics + recap are now Copy-Hoisted from old.
			expect(newSummaryContent.version).toBe(4);
			expect(newSummaryContent.commitType).toBe("rebase");
			expect(newSummaryContent.topics).toEqual(oldSummary.topics);
			expect(newSummaryContent.stats).toBeUndefined();
			expect(newSummaryContent.diffStats).toEqual({ filesChanged: 1, insertions: 5, deletions: 2 });
			// Old summary preserved as the sole child, with all 8 Hoist fields stripped.
			expect(newSummaryContent.children).toHaveLength(1);
			expect(newSummaryContent.children?.[0].commitHash).toBe(oldHash);
			// Topics are now stripped from the embedded child under the unified Hoist contract.
			expect(newSummaryContent.children?.[0].topics).toBeUndefined();

			const newIndexContent = JSON.parse(files[1].content) as SummaryIndex;
			const hashes = newIndexContent.entries.map((e) => e.commitHash);
			// Both new hash (root) and old hash (child) are in the flat index
			expect(hashes).toContain(newHash);
			expect(hashes).toContain(oldHash);

			// Old hash is now a child of new hash
			const oldEntry = newIndexContent.entries.find((e) => e.commitHash === oldHash);
			expect(oldEntry?.parentCommitHash).toBe(newHash);

			// New hash is the root
			const newEntry = newIndexContent.entries.find((e) => e.commitHash === newHash);
			expect(newEntry?.parentCommitHash).toBeNull();
		});

		it("should hoist jolliDocUrl and jolliDocId from old summary onto the container node", async () => {
			const oldHash = "oldhash0000000000000001";
			const newHash = "newhash0000000000000002";
			const oldSummary: CommitSummary = {
				...createMockSummary(oldHash, "Old message"),
				jolliDocId: 42,
				jolliDocUrl: "https://team.jolli.app/articles?doc=42",
				commitSource: "plugin",
			};

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newSummaryContent = JSON.parse(files[0].content) as CommitSummary;
			// Container SHOULD inherit jolliDocUrl and jolliDocId (docId-based update):
			// the server article is stable across rebases, so hoisting enables "Update on Jolli".
			expect(newSummaryContent.jolliDocId).toBe(42);
			expect(newSummaryContent.jolliDocUrl).toBe("https://team.jolli.app/articles?doc=42");
			expect(newSummaryContent.commitSource).toBeUndefined();
			// The old summary in children should have jolliDocUrl stripped (hoisted to root)
			expect(newSummaryContent.children?.[0].jolliDocUrl).toBeUndefined();
		});

		it("should hoist orphanedDocIds from old summary onto the container node", async () => {
			const oldHash = "oldhash0000000000000001";
			const newHash = "newhash0000000000000002";
			const oldSummary: CommitSummary = {
				...createMockSummary(oldHash, "Old message"),
				orphanedDocIds: [101, 102],
			};

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newSummaryContent = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummaryContent.orphanedDocIds).toEqual([101, 102]);
			// Children should have orphanedDocIds stripped
			expect(newSummaryContent.children?.[0].orphanedDocIds).toBeUndefined();
		});

		it("should hoist plans and e2e guides onto the rebase container node", async () => {
			const oldHash = "oldhash0000000000000001";
			const newHash = "newhash0000000000000002";
			const oldSummary: CommitSummary = {
				...createMockSummary(oldHash, "Old message"),
				plans: [
					{
						slug: "plan-1",
						title: "Plan 1",
						editCount: 1,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				e2eTestGuide: [
					{
						name: "checkout flow",
						steps: ["open cart", "submit order"],
						expectedResult: "order succeeds",
					},
				],
			};

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newSummaryContent = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummaryContent.plans).toEqual([
				{
					slug: "plan-1",
					title: "Plan 1",
					editCount: 1,
					addedAt: "2026-02-18T00:00:00Z",
					updatedAt: "2026-02-18T00:00:00Z",
				},
			]);
			expect(newSummaryContent.e2eTestGuide).toEqual([
				{
					name: "checkout flow",
					steps: ["open cart", "submit order"],
					expectedResult: "order succeeds",
				},
			]);
			expect(newSummaryContent.children?.[0].plans).toBeUndefined();
			expect(newSummaryContent.children?.[0].e2eTestGuide).toBeUndefined();
		});

		it("should hoist notes onto the rebase container node", async () => {
			const oldHash = "oldhash0000000000000001";
			const newHash = "newhash0000000000000002";
			const oldSummary: CommitSummary = {
				...createMockSummary(oldHash, "Old message"),
				notes: [
					{
						id: "note-1-abc",
						title: "My Note",
						format: "snippet",
						content: "Some content",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
			};

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newSummaryContent = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummaryContent.notes).toEqual([
				{
					id: "note-1-abc",
					title: "My Note",
					format: "snippet",
					content: "Some content",
					addedAt: "2026-02-18T00:00:00Z",
					updatedAt: "2026-02-18T00:00:00Z",
				},
			]);
			expect(newSummaryContent.children?.[0].notes).toBeUndefined();
		});

		it("should skip migration when new hash already in index", async () => {
			const oldHash = "oldhash0000000000000001";
			const newHash = "newhash0000000000000002";

			const existingIndex = v3Index([
				rootEntry(oldHash, "Old", "2026-02-18T10:00:00Z"),
				rootEntry(newHash, "New", "2026-02-20T10:00:00Z"),
			]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));

			await migrateOneToOne(createMockSummary(oldHash), createMockCommitInfo(newHash));
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should work when index is empty (null)", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const newHash = "newhash0000000000000002";
			await migrateOneToOne(createMockSummary("oldhash"), createMockCommitInfo(newHash));

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const indexContent = JSON.parse(files[1].content) as SummaryIndex;
			// Both new hash (root) and old hash (child) should be in the index
			const hashes = indexContent.entries.map((e) => e.commitHash);
			expect(hashes).toContain(newHash);
			expect(hashes).toContain("oldhash");
		});

		it("falls back to zero diffStats when git diff fails on the new rebase-pick root", async () => {
			vi.mocked(getDiffStats).mockRejectedValueOnce(new Error("git diff failed"));
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			const newHash = "newhash0000000000000002";
			await migrateOneToOne(createMockSummary("oldhash"), createMockCommitInfo(newHash));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			expect(migrated.diffStats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
		});
	});

	describe("mergeManyToOne", () => {
		it("should place all source summaries as children sorted by commitDate descending", async () => {
			const oldHash1 = "oldhash0000000000000001";
			const oldHash2 = "oldhash0000000000000002";
			const newHash = "newhash0000000000000003";

			const summary1: CommitSummary = {
				...createMockSummary(oldHash1, "First feature"),
				commitDate: "2026-02-18T10:00:00Z",
				generatedAt: "2026-02-18T10:00:05Z",
				topics: [
					{ title: "Dark mode", trigger: "User request", response: "Added toggle", decisions: "CSS vars" },
				],
			};
			const summary2: CommitSummary = {
				...createMockSummary(oldHash2, "Second feature"),
				commitDate: "2026-02-19T10:00:00Z",
				generatedAt: "2026-02-19T10:00:05Z",
				topics: [
					{ title: "Auth fix", trigger: "Bug report", response: "Fixed JWT", decisions: "Use httpOnly" },
					{ title: "Logging", trigger: "Debug need", response: "Added pino", decisions: "JSON format" },
				],
			};

			const existingIndex = v3Index([
				rootEntry(oldHash1, "First", "2026-02-18T10:00:00Z"),
				rootEntry(oldHash2, "Second", "2026-02-19T10:00:00Z"),
			]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));

			await mergeManyToOne([summary1, summary2], createMockCommitInfo(newHash, "Squashed commit"));

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;

			const mergedContent = JSON.parse(files[0].content) as CommitSummary;
			expect(mergedContent.commitHash).toBe(newHash);
			expect(mergedContent.commitMessage).toBe("Squashed commit");
			// Root is v4 with consolidated topics/recap on root.
			expect(mergedContent.version).toBe(4);

			// Children: sorted by commitDate desc -> summary2 (Feb 19) first, then summary1 (Feb 18).
			// Topics are now stripped from children under the unified Hoist contract.
			expect(mergedContent.children).toHaveLength(2);
			expect(mergedContent.children?.[0].commitHash).toBe(oldHash2);
			expect(mergedContent.children?.[0].topics).toBeUndefined();
			expect(mergedContent.children?.[1].commitHash).toBe(oldHash1);
			expect(mergedContent.children?.[1].topics).toBeUndefined();

			// Without a passed `consolidated` arg, mergeManyToOne defaults to an empty
			// topics array on the root (no LLM ran). Real callers (runSquashPipeline /
			// handleAmendPipeline) always pass a populated `consolidated`.
			expect(mergedContent.topics).toEqual([]);
			expect(mergedContent.stats).toBeUndefined();
			expect(mergedContent.llm).toBeUndefined();
			// diffStats IS populated — it's the real `git diff {squashHash}^..{squashHash}`
			// computed at merge time, so the display layer never needs to recursively
			// aggregate children (which over-counts files edited by multiple sources).
			expect(mergedContent.diffStats).toEqual({ filesChanged: 1, insertions: 5, deletions: 2 });

			// Index: all three hashes present; old hashes are now children of new hash
			const newIndexContent = JSON.parse(files[1].content) as SummaryIndex;
			const hashes = newIndexContent.entries.map((e) => e.commitHash);
			expect(hashes).toContain(newHash);
			expect(hashes).toContain(oldHash1);
			expect(hashes).toContain(oldHash2);

			const newRootEntry = newIndexContent.entries.find((e) => e.commitHash === newHash);
			expect(newRootEntry?.parentCommitHash).toBeNull();

			const old1Entry = newIndexContent.entries.find((e) => e.commitHash === oldHash1);
			expect(old1Entry?.parentCommitHash).toBe(newHash);

			const old2Entry = newIndexContent.entries.find((e) => e.commitHash === oldHash2);
			expect(old2Entry?.parentCommitHash).toBe(newHash);
		});

		it("should skip merge when new hash already in index", async () => {
			const newHash = "newhash0000000000000003";
			const existingIndex = v3Index([rootEntry(newHash, "Already here", "2026-02-20T10:00:00Z")]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));

			await mergeManyToOne([createMockSummary("old1"), createMockSummary("old2")], createMockCommitInfo(newHash));
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should work when index is null (empty repo)", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const newHash = "newhash0000000000000003";
			await mergeManyToOne([createMockSummary("old1"), createMockSummary("old2")], createMockCommitInfo(newHash));

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const indexContent = JSON.parse(files[1].content) as SummaryIndex;
			// All three hashes in index
			const hashes = indexContent.entries.map((e) => e.commitHash);
			expect(hashes).toContain(newHash);
			expect(hashes).toContain("old1");
			expect(hashes).toContain("old2");
		});

		it("defaults topics to [] when no `consolidated` argument is passed (legacy callers)", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await mergeManyToOne(
				[createMockSummary("old1"), createMockSummary("old2")],
				createMockCommitInfo("newhash"),
			);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const mergedContent = JSON.parse(files[0].content) as CommitSummary;
			expect(mergedContent.llm).toBeUndefined();
			expect(mergedContent.stats).toBeUndefined();
			// Empty topics array (rather than undefined) keeps the v4 invariant: every
			// root carries a topics field. Real callers always pass `consolidated`.
			expect(mergedContent.topics).toEqual([]);
			expect(mergedContent.recap).toBeUndefined();
			expect(mergedContent.children).toHaveLength(2);
		});

		it("writes consolidated topics + recap onto the merged root when `consolidated` is provided", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await mergeManyToOne(
				[createMockSummary("old1"), createMockSummary("old2")],
				createMockCommitInfo("newhash"),
				undefined,
				undefined,
				{
					topics: [{ title: "Consolidated topic", trigger: "t", response: "r", decisions: "d" }],
					recap: "Consolidated paragraph.",
					ticketId: "PROJ-1",
				},
			);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const mergedContent = JSON.parse(files[0].content) as CommitSummary;
			expect(mergedContent.topics).toHaveLength(1);
			expect(mergedContent.topics?.[0].title).toBe("Consolidated topic");
			expect(mergedContent.recap).toBe("Consolidated paragraph.");
			expect(mergedContent.ticketId).toBe("PROJ-1");
			// Children still get stripped via stripFunctionalMetadata.
			expect(mergedContent.children?.[0].topics).toBeUndefined();
		});

		it("should write orphanedDocIds to root when merging summaries with different jolliDocIds", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const s1: CommitSummary = {
				...createMockSummary("old1", "First"),
				commitDate: "2026-02-18T10:00:00Z",
				generatedAt: "2026-02-18T10:00:05Z",
				jolliDocId: 101,
				jolliDocUrl: "https://team.jolli.app/articles?doc=101",
			};
			const s2: CommitSummary = {
				...createMockSummary("old2", "Second"),
				commitDate: "2026-02-19T10:00:00Z",
				generatedAt: "2026-02-19T10:00:05Z",
				jolliDocId: 102,
				jolliDocUrl: "https://team.jolli.app/articles?doc=102",
			};

			const result = await mergeManyToOne([s1, s2], createMockCommitInfo("newhash", "Squashed"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			// Winner is s2 (newer activity date via getDisplayDate)
			expect(merged.jolliDocId).toBe(102);
			expect(merged.jolliDocUrl).toBe("https://team.jolli.app/articles?doc=102");
			// Loser goes to orphanedDocIds
			expect(merged.orphanedDocIds).toEqual([101]);
			expect(result.orphanedDocIds).toEqual([101]);
			// Children should have no Jolli metadata
			expect(merged.children?.[0].jolliDocId).toBeUndefined();
			expect(merged.children?.[0].jolliDocUrl).toBeUndefined();
			expect(merged.children?.[0].orphanedDocIds).toBeUndefined();
		});

		it("should accumulate orphanedDocIds from prior squashes (double-squash)", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const s1: CommitSummary = {
				...createMockSummary("old1", "Prior squash"),
				commitDate: "2026-02-18T10:00:00Z",
				generatedAt: "2026-02-18T10:00:05Z",
				jolliDocId: 101,
				jolliDocUrl: "https://team.jolli.app/articles?doc=101",
				orphanedDocIds: [99],
			};
			const s2: CommitSummary = {
				...createMockSummary("old2", "Second"),
				commitDate: "2026-02-19T10:00:00Z",
				generatedAt: "2026-02-19T10:00:05Z",
				jolliDocId: 102,
				jolliDocUrl: "https://team.jolli.app/articles?doc=102",
			};

			const result = await mergeManyToOne([s1, s2], createMockCommitInfo("newhash", "Squashed"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			// Winner is s2 (newer activity), loser is s1's 101, plus inherited 99
			expect(merged.jolliDocId).toBe(102);
			expect(merged.orphanedDocIds).toEqual([101, 99]);
			expect(result.orphanedDocIds).toEqual([101, 99]);
		});

		it("should pick the amend-updated child over a sibling with newer commitDate (getDisplayDate wins)", async () => {
			// s1: older git author-date, but user amended its summary *just now* → generatedAt is newest.
			// s2: author-date is newer (e.g. cherry-picked or fresh commit), but no amend happened.
			// Expected winner is s1 because getDisplayDate prefers generatedAt, which reflects "most
			// recently touched by the user" — the opposite of what commitDate-based sorting would pick.
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const s1: CommitSummary = {
				...createMockSummary("old1", "Amended just now"),
				commitDate: "2026-02-10T10:00:00Z",
				generatedAt: "2026-02-20T15:00:00Z",
				jolliDocId: 101,
				jolliDocUrl: "https://team.jolli.app/articles?doc=101",
			};
			const s2: CommitSummary = {
				...createMockSummary("old2", "Fresh sibling"),
				commitDate: "2026-02-19T10:00:00Z",
				generatedAt: "2026-02-19T10:00:05Z",
				jolliDocId: 102,
				jolliDocUrl: "https://team.jolli.app/articles?doc=102",
			};

			const result = await mergeManyToOne([s1, s2], createMockCommitInfo("newhash", "Squashed"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.jolliDocId).toBe(101);
			expect(merged.jolliDocUrl).toBe("https://team.jolli.app/articles?doc=101");
			expect(merged.orphanedDocIds).toEqual([102]);
			expect(result.orphanedDocIds).toEqual([102]);
		});

		it("should hoist the newest nested child jolli metadata from deep descendants", async () => {
			const old1: CommitSummary = {
				...createMockSummary("old1", "Old 1"),
				children: [
					{
						...createMockSummary("nested-child", "Nested child"),
						commitDate: "2026-02-20T00:00:00Z",
						jolliDocId: 201,
						jolliDocUrl: "https://jolli.app/articles/201",
					},
				],
			};
			const old2: CommitSummary = {
				...createMockSummary("old2", "Old 2"),
				commitDate: "2026-02-19T00:00:00Z",
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			await mergeManyToOne([old1, old2], createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.jolliDocId).toBe(201);
			expect(merged.jolliDocUrl).toBe("https://jolli.app/articles/201");
		});

		it("should use the descendant's own generatedAt (not the parent's) when comparing a nested winner against a direct sibling", async () => {
			// old1 is stale overall, but its grandchild was amended today — its generatedAt (2026-04-20)
			// is the newest activity in the whole tree. old2 is a direct sibling with its own docId and
			// an author-date that falls between old1's stale date and the grandchild's fresh generatedAt.
			//
			// With the bug, the recursive winner bubbles up with old1's (stale) dates attached, so old2
			// wins and the just-amended grandchild doc 301 gets orphaned. Correct behavior: grandchild
			// (301) wins, old2's 302 is orphaned.
			const old1: CommitSummary = {
				...createMockSummary("old1", "Old 1 (stale parent)"),
				commitDate: "2026-01-01T00:00:00Z",
				generatedAt: "2026-01-01T00:00:00Z",
				children: [
					{
						...createMockSummary("grandchild-amended", "Grandchild just amended"),
						commitDate: "2026-01-01T00:00:00Z",
						generatedAt: "2026-04-20T12:00:00Z",
						jolliDocId: 301,
						jolliDocUrl: "https://jolli.app/articles/301",
					},
				],
			};
			const old2: CommitSummary = {
				...createMockSummary("old2", "Old 2 (direct sibling)"),
				commitDate: "2026-03-01T00:00:00Z",
				generatedAt: "2026-03-01T00:00:00Z",
				jolliDocId: 302,
				jolliDocUrl: "https://jolli.app/articles/302",
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			const result = await mergeManyToOne([old1, old2], createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.jolliDocId).toBe(301);
			expect(merged.jolliDocUrl).toBe("https://jolli.app/articles/301");
			expect(merged.orphanedDocIds).toEqual([302]);
			expect(result.orphanedDocIds).toEqual([302]);
		});

		it("should hoist and dedupe plans from nested descendants by newest updatedAt", async () => {
			const old1: CommitSummary = {
				...createMockSummary("old1", "Old 1"),
				plans: [
					{
						slug: "shared",
						title: "Shared plan",
						editCount: 1,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				children: [
					{
						...createMockSummary("nested-child", "Nested child"),
						plans: [
							{
								slug: "shared",
								title: "Shared plan",
								editCount: 2,
								addedAt: "2026-02-18T00:00:00Z",
								updatedAt: "2026-02-20T00:00:00Z",
							},
							{
								slug: "nested-only",
								title: "Nested only",
								editCount: 1,
								addedAt: "2026-02-19T00:00:00Z",
								updatedAt: "2026-02-19T00:00:00Z",
							},
						],
					},
				],
			};
			const old2: CommitSummary = {
				...createMockSummary("old2", "Old 2"),
				plans: [
					{
						slug: "root-only",
						title: "Root only",
						editCount: 1,
						addedAt: "2026-02-19T00:00:00Z",
						updatedAt: "2026-02-19T00:00:00Z",
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			await mergeManyToOne([old1, old2], createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.plans).toEqual([
				{
					slug: "shared",
					title: "Shared plan",
					editCount: 2,
					addedAt: "2026-02-18T00:00:00Z",
					updatedAt: "2026-02-20T00:00:00Z",
				},
				{
					slug: "nested-only",
					title: "Nested only",
					editCount: 1,
					addedAt: "2026-02-19T00:00:00Z",
					updatedAt: "2026-02-19T00:00:00Z",
				},
				{
					slug: "root-only",
					title: "Root only",
					editCount: 1,
					addedAt: "2026-02-19T00:00:00Z",
					updatedAt: "2026-02-19T00:00:00Z",
				},
			]);
		});

		it("should hoist merge metadata and e2e guides onto the new container summary", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await mergeManyToOne(
				[
					{
						...createMockSummary("old1"),
						e2eTestGuide: [
							{
								name: "checkout flow",
								steps: ["open cart", "submit order"],
								expectedResult: "order succeeds",
							},
						],
					},
					createMockSummary("old2"),
				],
				createMockCommitInfo("newhash"),
				undefined,
				{ commitType: "squash", commitSource: "plugin" },
			);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.commitType).toBe("squash");
			expect(merged.commitSource).toBe("plugin");
			expect(merged.e2eTestGuide).toEqual([
				{
					name: "checkout flow",
					steps: ["open cart", "submit order"],
					expectedResult: "order succeeds",
				},
			]);
		});

		it("should keep the first plan when duplicate slugs have the same updatedAt", async () => {
			const old1: CommitSummary = {
				...createMockSummary("old1", "Old 1"),
				plans: [
					{
						slug: "shared",
						title: "Original",
						editCount: 1,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-20T00:00:00Z",
					},
				],
			};
			const old2: CommitSummary = {
				...createMockSummary("old2", "Old 2"),
				children: [
					{
						...createMockSummary("nested-child", "Nested child"),
						plans: [
							{
								slug: "shared",
								title: "Replacement",
								editCount: 9,
								addedAt: "2026-02-18T00:00:00Z",
								updatedAt: "2026-02-20T00:00:00Z",
							},
						],
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			await mergeManyToOne([old1, old2], createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.plans).toEqual([
				{
					slug: "shared",
					title: "Original",
					editCount: 1,
					addedAt: "2026-02-18T00:00:00Z",
					updatedAt: "2026-02-20T00:00:00Z",
				},
			]);
		});

		it("should keep the newer existing plan when a duplicate slug has an older updatedAt", async () => {
			const old1: CommitSummary = {
				...createMockSummary("old1", "Old 1"),
				plans: [
					{
						slug: "shared",
						title: "Newest",
						editCount: 3,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-21T00:00:00Z",
					},
				],
			};
			const old2: CommitSummary = {
				...createMockSummary("old2", "Old 2"),
				plans: [
					{
						slug: "shared",
						title: "Older",
						editCount: 1,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-19T00:00:00Z",
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			await mergeManyToOne([old1, old2], createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.plans).toEqual([
				{
					slug: "shared",
					title: "Newest",
					editCount: 3,
					addedAt: "2026-02-18T00:00:00Z",
					updatedAt: "2026-02-21T00:00:00Z",
				},
			]);
		});

		it("should hoist and dedupe notes from children by newest updatedAt", async () => {
			const old1: CommitSummary = {
				...createMockSummary("old1", "Old 1"),
				notes: [
					{
						id: "shared-note",
						title: "Shared Note",
						format: "snippet",
						content: "Old content",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				children: [
					{
						...createMockSummary("nested-child", "Nested child"),
						notes: [
							{
								id: "shared-note",
								title: "Shared Note Updated",
								format: "snippet",
								content: "New content",
								addedAt: "2026-02-18T00:00:00Z",
								updatedAt: "2026-02-20T00:00:00Z",
							},
							{
								id: "nested-only-note",
								title: "Nested Only",
								format: "markdown",
								addedAt: "2026-02-19T00:00:00Z",
								updatedAt: "2026-02-19T00:00:00Z",
							},
						],
					},
				],
			};
			const old2: CommitSummary = {
				...createMockSummary("old2", "Old 2"),
				notes: [
					{
						id: "root-only-note",
						title: "Root Only",
						format: "snippet",
						content: "Root content",
						addedAt: "2026-02-19T00:00:00Z",
						updatedAt: "2026-02-19T00:00:00Z",
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			await mergeManyToOne([old1, old2], createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			// Should have 3 notes: shared-note (deduped to newest), nested-only-note, root-only-note
			expect(merged.notes).toHaveLength(3);
			const sharedNote = merged.notes?.find((n) => n.id === "shared-note");
			expect(sharedNote?.title).toBe("Shared Note Updated");
			expect(sharedNote?.updatedAt).toBe("2026-02-20T00:00:00Z");
			expect(merged.notes?.find((n) => n.id === "nested-only-note")).toBeDefined();
			expect(merged.notes?.find((n) => n.id === "root-only-note")).toBeDefined();
			// Children should have notes stripped
			expect(merged.children?.[0].notes).toBeUndefined();
			expect(merged.children?.[1].notes).toBeUndefined();
		});

		it("should not have orphanedDocIds when no summaries have jolliDocId", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await mergeManyToOne(
				[createMockSummary("old1"), createMockSummary("old2")],
				createMockCommitInfo("newhash"),
			);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.orphanedDocIds).toBeUndefined();
		});

		it("should keep the existing note when a duplicate appears with an older updatedAt", async () => {
			// Covers both `!existing` false branches AND `note.updatedAt > existing.updatedAt`
			// false branch in collectChildNotes (lines 281, 289). Three axes:
			// (a) two top-level nodes with the same note id → line 281's existing+older path
			// (b) nested child with older duplicate of top-level id → line 289's existing+older path
			const old1: CommitSummary = {
				...createMockSummary("old1", "Old 1"),
				notes: [
					{
						id: "dupe",
						title: "Newer",
						format: "snippet",
						content: "new",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-25T00:00:00Z",
					},
				],
				children: [
					{
						...createMockSummary("nested", "Nested"),
						notes: [
							{
								id: "dupe",
								title: "Nested Older",
								format: "snippet",
								content: "nested",
								addedAt: "2026-02-18T00:00:00Z",
								updatedAt: "2026-02-22T00:00:00Z",
							},
						],
					},
				],
			};
			const old2: CommitSummary = {
				...createMockSummary("old2", "Old 2"),
				notes: [
					{
						id: "dupe",
						title: "Older",
						format: "snippet",
						content: "old",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-20T00:00:00Z",
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			await mergeManyToOne([old1, old2], createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.notes).toHaveLength(1);
			expect(merged.notes?.[0].title).toBe("Newer");
		});

		it("stores diffStats from git --shortstat even when child .stats would over-count", async () => {
			// Scenario: 3 source commits all edit the SAME file. Recursive aggregation
			// (today's aggregateStats) would report filesChanged=3 because each child
			// has its own stats{filesChanged:1}. The real git diff of the squash commit,
			// however, is filesChanged=1 (one distinct file on disk). Our persisted
			// diffStats reflects the real number — not the inflated aggregate.

			// Override default getDiffStats for this test: real squash diff = 1 file.
			vi.mocked(getDiffStats).mockResolvedValueOnce({
				filesChanged: 1,
				insertions: 42,
				deletions: 5,
			});

			const makeSourceWithStats = (hash: string, insertions: number): CommitSummary => ({
				...createMockSummary(hash),
				stats: { filesChanged: 1, insertions, deletions: 1 },
			});

			const old1 = makeSourceWithStats("abc1", 10);
			const old2 = makeSourceWithStats("abc2", 20);
			const old3 = makeSourceWithStats("abc3", 15);

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			await mergeManyToOne([old1, old2, old3], createMockCommitInfo("squash1"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;

			// Real diff wins: 1 file changed, NOT 3 (which children.stats summed would give)
			expect(merged.diffStats).toEqual({ filesChanged: 1, insertions: 42, deletions: 5 });
			// Sanity: children retain their original per-commit stats unchanged
			expect(merged.children?.[0].stats?.filesChanged).toBe(1);
			expect(merged.children?.[1].stats?.filesChanged).toBe(1);
			expect(merged.children?.[2].stats?.filesChanged).toBe(1);
		});

		it("falls back to zero diffStats when git diff fails (e.g. first commit)", async () => {
			vi.mocked(getDiffStats).mockRejectedValueOnce(new Error("git diff failed"));

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			await mergeManyToOne(
				[createMockSummary("old1"), createMockSummary("old2")],
				createMockCommitInfo("newhash"),
			);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.diffStats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
		});
	});

	describe("removeFromIndex", () => {
		it("should remove the specified hash from the index", async () => {
			const hashToRemove = "removeHash000000000001";
			const hashToKeep = "keepHash0000000000002";

			const existingIndex = v3Index([
				rootEntry(hashToRemove, "To remove", "2026-02-18T10:00:00Z"),
				rootEntry(hashToKeep, "To keep", "2026-02-19T10:00:00Z"),
			]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));

			await removeFromIndex(hashToRemove);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			expect(files).toHaveLength(1);
			expect(files[0].path).toBe("index.json");

			const updatedIndex = JSON.parse(files[0].content) as SummaryIndex;
			const hashes = updatedIndex.entries.map((e) => e.commitHash);
			expect(hashes).not.toContain(hashToRemove);
			expect(hashes).toContain(hashToKeep);
		});

		it("should skip when no index exists", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			await removeFromIndex("anyhash");
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should skip when hash is not found in index", async () => {
			const existingIndex = v3Index([rootEntry("somehash000000000001", "Some commit", "2026-02-18T10:00:00Z")]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));
			await removeFromIndex("nonexistenthash");
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});
	});

	describe("listSummaryHashes", () => {
		it("should return a Set of all commit hashes (roots + children) from the index", async () => {
			const index: SummaryIndex = {
				version: 3,
				entries: [
					rootEntry("hash1", "A"),
					{
						commitHash: "hash2",
						parentCommitHash: "hash1",
						commitMessage: "B",
						commitDate: "2026-02-19T10:00:00Z",
						branch: "main",
						generatedAt: "2026-02-19T10:00:05Z",
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));

			const hashes = await listSummaryHashes();
			expect(hashes).toBeInstanceOf(Set);
			expect(hashes.size).toBe(2);
			expect(hashes.has("hash1")).toBe(true);
			expect(hashes.has("hash2")).toBe(true);
		});

		it("should include alias keys in the returned set", async () => {
			const index = v3Index([rootEntry("knownhash", "A")], { aliashash: "knownhash" });
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));

			const hashes = await listSummaryHashes();
			expect(hashes.has("knownhash")).toBe(true);
			expect(hashes.has("aliashash")).toBe(true);
		});

		it("should return empty Set when no index exists", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const hashes = await listSummaryHashes();
			expect(hashes.size).toBe(0);
		});

		it("should return empty Set when index has no entries", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));
			const hashes = await listSummaryHashes();
			expect(hashes.size).toBe(0);
		});
	});

	describe("getIndexEntryMap", () => {
		it("should return entries keyed by commitHash", async () => {
			const entry1 = rootEntry("hash1", "A");
			const entry2 = rootEntry("hash2", "B");
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([entry1, entry2])));

			const map = await getIndexEntryMap();
			expect(map.size).toBe(2);
			expect(map.get("hash1")).toEqual(entry1);
			expect(map.get("hash2")).toEqual(entry2);
		});

		it("should resolve aliases to the target entry", async () => {
			const entry = rootEntry("target", "A");
			const index = v3Index([entry], { aliased: "target" });
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));

			const map = await getIndexEntryMap();
			expect(map.get("aliased")).toEqual(entry);
		});

		it("should not overwrite a direct entry with an alias", async () => {
			const directEntry = rootEntry("hash1", "Direct");
			const targetEntry = rootEntry("hash2", "Target");
			// alias "hash1" → "hash2", but hash1 already exists as a direct entry
			const index = v3Index([directEntry, targetEntry], { hash1: "hash2" });
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));

			const map = await getIndexEntryMap();
			expect(map.get("hash1")).toEqual(directEntry);
		});

		it("should return empty Map when no index exists", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const map = await getIndexEntryMap();
			expect(map.size).toBe(0);
		});

		it("should preserve topicCount and diffStats on entries", async () => {
			const entry: SummaryIndexEntry = {
				...rootEntry("hash1", "A"),
				topicCount: 3,
				diffStats: { filesChanged: 2, insertions: 10, deletions: 5 },
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([entry])));

			const map = await getIndexEntryMap();
			const result = map.get("hash1");
			expect(result?.topicCount).toBe(3);
			expect(result?.diffStats).toEqual({ filesChanged: 2, insertions: 10, deletions: 5 });
		});
	});

	describe("transcripts", () => {
		it("should return null when transcript does not exist", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			await expect(readTranscript("abc123")).resolves.toBeNull();
		});

		it("should parse a stored transcript", async () => {
			const transcript = {
				sessions: [{ sessionId: "sess-1", source: "codex", entries: [{ role: "human", content: "hello" }] }],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(transcript));

			const result = await readTranscript("abc123");
			expect(result).toEqual(transcript);
		});

		it("should return null for malformed transcript JSON", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("not json");
			await expect(readTranscript("abc123")).resolves.toBeNull();
		});

		it("should read transcripts for multiple commits and skip missing ones", async () => {
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify({ sessions: [{ sessionId: "one", entries: [] }] }))
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(JSON.stringify({ sessions: [{ sessionId: "three", entries: [] }] }));

			const result = await readTranscriptsForCommits(["hash1", "hash2", "hash3"]);
			expect(result.size).toBe(2);
			expect(result.has("hash1")).toBe(true);
			expect(result.has("hash2")).toBe(false);
			expect(result.has("hash3")).toBe(true);
		});

		it("should write and delete transcript files in a single batch", async () => {
			await saveTranscriptsBatch(
				[{ hash: "hash1", data: { sessions: [{ sessionId: "s1", entries: [] }] } }],
				["hash2"],
			);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			expect(files).toHaveLength(2);
			expect(files[0]).toMatchObject({ path: "transcripts/hash1.json" });
			expect(files[0]?.content).toContain('"sessionId": "s1"');
			expect(files[1]).toMatchObject({ path: "transcripts/hash2.json", delete: true, content: "" });
		});

		it("should summarize transcript writes without a deleted suffix when nothing is deleted", async () => {
			await saveTranscriptsBatch([{ hash: "hash1", data: { sessions: [{ sessionId: "s1", entries: [] }] } }], []);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			expect(vi.mocked(writeMultipleFilesToBranch).mock.calls[0][2]).toBe("Update transcripts: 1 written");
		});

		it("should delete a single transcript via deleteTranscript", async () => {
			await deleteTranscript("hash2");

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			expect(files).toEqual([{ path: "transcripts/hash2.json", delete: true, content: "" }]);
		});

		it("should no-op when transcript batch is empty", async () => {
			await saveTranscriptsBatch([], []);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should list only transcript hashes that match the expected pattern", async () => {
			vi.mocked(listFilesInBranch).mockResolvedValueOnce([
				"transcripts/abc123.json",
				"transcripts/def456.json",
				"transcripts/not-a-hash.txt",
				"other/abc123.json",
			]);

			const hashes = await getTranscriptHashes();
			expect(hashes).toEqual(new Set(["abc123", "def456"]));
		});
	});

	describe("tree hash aliases", () => {
		it("should return false when index is missing", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			await expect(scanTreeHashAliases(["hash1"])).resolves.toBe(false);
		});

		it("should persist new aliases when tree hashes match shallow entries", async () => {
			const index = v3Index(
				[
					{ ...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"), treeHash: "tree-1" },
					{
						commitHash: "child1",
						parentCommitHash: "root1",
						commitMessage: "Child",
						commitDate: "2026-02-19T10:00:00Z",
						branch: "main",
						generatedAt: "2026-02-19T10:00:05Z",
						treeHash: "tree-1",
					},
				],
				{ knownAlias: "root1" },
			);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");

			const result = await scanTreeHashAliases(["unknown1", "root1", "knownAlias"]);

			expect(result).toBe(true);
			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const persistedIndex = JSON.parse(files[0].content) as SummaryIndex;
			expect(persistedIndex.commitAliases).toEqual({
				knownAlias: "root1",
				unknown1: "root1",
			});
		});

		it("should return false when no aliases are discovered", async () => {
			const index = v3Index([{ ...rootEntry("root1", "Root"), treeHash: "tree-1" }]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			vi.mocked(getTreeHash).mockResolvedValueOnce(null);

			await expect(scanTreeHashAliases(["unknown1"])).resolves.toBe(false);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should skip a hash when getTreeHash returns a tree hash that matches no entry", async () => {
			const index = v3Index([{ ...rootEntry("root1", "Root"), treeHash: "tree-1" }]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			// getTreeHash returns a valid tree hash, but it matches no entry in the index
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-no-match");

			await expect(scanTreeHashAliases(["unknown1"])).resolves.toBe(false);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should defer alias writes when the shared lock cannot be acquired", async () => {
			const index = v3Index([{ ...rootEntry("root1", "Root"), treeHash: "tree-1" }]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");
			vi.mocked(acquireLock).mockResolvedValueOnce(false);

			await expect(scanTreeHashAliases(["unknown1"])).resolves.toBe(false);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
			expect(releaseLock).not.toHaveBeenCalled();
		});

		it("should alias to the most recent shallow match when tree hash depth ties", async () => {
			const index = v3Index([
				{ ...rootEntry("older-root", "Older", "2026-02-18T10:00:00Z"), treeHash: "tree-1" },
				{ ...rootEntry("newer-root", "Newer", "2026-02-19T10:00:00Z"), treeHash: "tree-1" },
			]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");

			const result = await scanTreeHashAliases(["unknown1"]);

			expect(result).toBe(true);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const persistedIndex = JSON.parse(files[0].content) as SummaryIndex;
			expect(persistedIndex.commitAliases).toEqual({ unknown1: "newer-root" });
		});

		it("should prefer the entry with newer generatedAt when tree hash depth ties, even if its commitDate is older", async () => {
			// Two root entries, same tree hash, same depth. commitDate favors entry-a, but
			// entry-b was regenerated most recently (amend/rebase case). The tie-break must
			// use getDisplayDate (generatedAt || commitDate), not raw commitDate — otherwise
			// we alias to the stale summary and the just-regenerated one becomes unreachable.
			const index = v3Index([
				{
					commitHash: "entry-a",
					parentCommitHash: null,
					commitMessage: "Newer author-date, stale regen",
					commitDate: "2026-02-19T10:00:00Z",
					branch: "main",
					generatedAt: "2026-02-18T10:00:00Z",
					treeHash: "tree-1",
				},
				{
					commitHash: "entry-b",
					parentCommitHash: null,
					commitMessage: "Older author-date, just regenerated",
					commitDate: "2026-02-18T10:00:00Z",
					branch: "main",
					generatedAt: "2026-02-20T10:00:00Z",
					treeHash: "tree-1",
				},
			]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");

			const result = await scanTreeHashAliases(["unknown1"]);

			expect(result).toBe(true);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const persistedIndex = JSON.parse(files[0].content) as SummaryIndex;
			expect(persistedIndex.commitAliases).toEqual({ unknown1: "entry-b" });
		});

		it("should break depth calculation cycles when matching tree hashes", async () => {
			const index = v3Index([
				{
					commitHash: "cycle-older",
					parentCommitHash: "cycle-newer",
					commitMessage: "Older",
					commitDate: "2026-02-18T10:00:00Z",
					branch: "main",
					generatedAt: "2026-02-18T10:00:05Z",
					treeHash: "tree-1",
				},
				{
					commitHash: "cycle-newer",
					parentCommitHash: "cycle-older",
					commitMessage: "Newer",
					commitDate: "2026-02-19T10:00:00Z",
					branch: "main",
					generatedAt: "2026-02-19T10:00:05Z",
					treeHash: "tree-1",
				},
			]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");

			const result = await scanTreeHashAliases(["unknown1"]);

			expect(result).toBe(true);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const persistedIndex = JSON.parse(files[0].content) as SummaryIndex;
			expect(persistedIndex.commitAliases).toEqual({ unknown1: "cycle-newer" });
		});
	});

	describe("index migration", () => {
		it("should detect when an index needs migration", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(
				JSON.stringify({ version: 1, entries: [rootEntry("old1")] }),
			);
			await expect(indexNeedsMigration()).resolves.toBe(true);
		});

		it("should report false when index is already v3 or missing", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([rootEntry("new1")])));
			await expect(indexNeedsMigration()).resolves.toBe(false);

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			await expect(indexNeedsMigration()).resolves.toBe(false);
		});

		it("should no-op when migrateIndexToV3 is called on an already-v3 index", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([rootEntry("new1")])));

			await expect(migrateIndexToV3()).resolves.toEqual({ migrated: 0, skipped: 0 });
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should no-op when migrateIndexToV3 is called with no index file", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await expect(migrateIndexToV3()).resolves.toEqual({ migrated: 0, skipped: 0 });
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should migrate a v1 index to v3 entries", async () => {
			const oldIndex = { version: 1, entries: [rootEntry("root1"), rootEntry("root2")] };
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(oldIndex))
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("root1", "Root 1")))
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("root2", "Root 2")));

			const result = await migrateIndexToV3();

			expect(result).toEqual({ migrated: 2, skipped: 0 });
			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newIndex = JSON.parse(files[0].content) as SummaryIndex;
			expect(newIndex.version).toBe(3);
			expect(newIndex.entries.map((entry) => entry.commitHash)).toEqual(["root1", "root2"]);
		});

		it("should skip missing summaries during v1 migration", async () => {
			const oldIndex = { version: 1, entries: [rootEntry("root1"), rootEntry("missing2")] };
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(oldIndex))
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("root1", "Root 1")))
				.mockResolvedValueOnce(null);

			const result = await migrateIndexToV3();
			expect(result).toEqual({ migrated: 1, skipped: 1 });
		});

		it("should skip summaries that fail to flatten during v1 migration", async () => {
			const oldIndex = { version: 1, entries: [rootEntry("root1"), rootEntry("root2")] };
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(oldIndex))
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("root1", "Root 1")))
				.mockResolvedValueOnce(JSON.stringify(createMockSummary("root2", "Root 2")));
			vi.mocked(getTreeHash)
				.mockResolvedValueOnce("tree-1")
				.mockRejectedValueOnce(new Error("git object missing"));

			const result = await migrateIndexToV3();

			expect(result).toEqual({ migrated: 1, skipped: 1 });
			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newIndex = JSON.parse(files[0].content) as SummaryIndex;
			expect(newIndex.entries.map((entry) => entry.commitHash)).toEqual(["root1"]);
		});
	});

	describe("plans", () => {
		it("should store plan files in a single commit", async () => {
			await storePlans(
				[
					{ slug: "plan-a", content: "# Plan A" },
					{ slug: "plan-b", content: "# Plan B" },
				],
				"Store plans",
			);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			expect(files).toEqual([
				{ path: "plans/plan-a.md", content: "# Plan A" },
				{ path: "plans/plan-b.md", content: "# Plan B" },
			]);
		});

		it("should no-op when there are no plan files to store", async () => {
			await storePlans([], "No plans");
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("should read a plan file and swallow branch read failures", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("# Saved plan");
			await expect(readPlanFromBranch("plan-a")).resolves.toBe("# Saved plan");

			vi.mocked(readFileFromBranch).mockRejectedValueOnce(new Error("missing"));
			await expect(readPlanFromBranch("plan-a")).resolves.toBeNull();
		});
	});

	describe("readPlanProgress", () => {
		it("should read and parse a plan progress artifact from the orphan branch", async () => {
			const artifact: PlanProgressArtifact = {
				version: 1,
				commitHash: "abc123",
				commitMessage: "Fix",
				commitDate: "2026-02-19T10:00:00Z",
				planSlug: "my-plan-abc123de",
				originalSlug: "my-plan",
				summary: "Did stuff.",
				steps: [{ id: "1", description: "Step one", status: "completed", note: "Done." }],
				llm: {
					model: "claude-haiku-4-5-20251001",
					inputTokens: 100,
					outputTokens: 50,
					apiLatencyMs: 200,
					stopReason: "end_turn",
				},
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(artifact));

			const result = await readPlanProgress("my-plan-abc123de");

			expect(result).toEqual(artifact);
			expect(readFileFromBranch).toHaveBeenCalledWith(
				expect.any(String),
				"plan-progress/my-plan-abc123de.json",
				undefined,
			);
		});

		it("should return null when the file does not exist", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null as unknown as string);
			await expect(readPlanProgress("nonexistent")).resolves.toBeNull();
		});

		it("should return null when branch read fails", async () => {
			vi.mocked(readFileFromBranch).mockRejectedValueOnce(new Error("not found"));
			await expect(readPlanProgress("missing-plan")).resolves.toBeNull();
		});
	});

	describe("notes", () => {
		it("should read a note file from the orphan branch", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("# My Note Content");
			await expect(readNoteFromBranch("note-42")).resolves.toBe("# My Note Content");

			expect(readFileFromBranch).toHaveBeenCalledWith(expect.any(String), "notes/note-42.md", undefined);
		});

		it("should return null when branch read fails", async () => {
			vi.mocked(readFileFromBranch).mockRejectedValueOnce(new Error("not found"));
			await expect(readNoteFromBranch("missing-note")).resolves.toBeNull();
		});
	});

	describe("stripFunctionalMetadata", () => {
		it("should strip notes (and topics, recap) from a summary node, preserving identity fields", () => {
			const summary: CommitSummary = {
				...createMockSummary("abc123", "With notes"),
				notes: [
					{
						id: "note-1",
						title: "Note",
						format: "snippet",
						content: "Content",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				recap: "Should be stripped too",
			};

			const stripped = stripFunctionalMetadata(summary);
			expect(stripped.notes).toBeUndefined();
			expect(stripped.commitHash).toBe("abc123");
			// topics + recap are part of the Hoist family and get stripped.
			expect(stripped.topics).toBeUndefined();
			expect(stripped.recap).toBeUndefined();
		});

		it("should strip notes from nested children", () => {
			const child: CommitSummary = {
				...createMockSummary("child1", "Child"),
				notes: [
					{
						id: "child-note",
						title: "Child Note",
						format: "markdown",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
			};
			const parent: CommitSummary = {
				...createMockSummary("parent1", "Parent"),
				notes: [
					{
						id: "parent-note",
						title: "Parent Note",
						format: "snippet",
						content: "Content",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				children: [child],
			};

			const stripped = stripFunctionalMetadata(parent);
			expect(stripped.notes).toBeUndefined();
			expect(stripped.children?.[0].notes).toBeUndefined();
		});

		it("should also strip plans, e2eTestGuide, and Jolli metadata", () => {
			const summary: CommitSummary = {
				...createMockSummary("abc123", "Full metadata"),
				plans: [
					{
						slug: "plan-1",
						title: "Plan",
						editCount: 1,
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				notes: [
					{
						id: "note-1",
						title: "Note",
						format: "snippet",
						content: "Content",
						addedAt: "2026-02-18T00:00:00Z",
						updatedAt: "2026-02-18T00:00:00Z",
					},
				],
				e2eTestGuide: [{ title: "test", steps: ["step1"], expectedResults: ["result1"] }],
				jolliDocId: 42,
				jolliDocUrl: "https://jolli.app/42",
				orphanedDocIds: [99],
			};

			const stripped = stripFunctionalMetadata(summary);
			expect(stripped.plans).toBeUndefined();
			expect(stripped.notes).toBeUndefined();
			expect(stripped.e2eTestGuide).toBeUndefined();
			expect(stripped.jolliDocId).toBeUndefined();
			expect(stripped.jolliDocUrl).toBeUndefined();
			expect(stripped.orphanedDocIds).toBeUndefined();
		});
	});

	describe("storeSummary with force", () => {
		it("should overwrite existing summary when force=true", async () => {
			const summary = createMockSummary("existinghash001");
			const existingIndex = v3Index([rootEntry("existinghash001", "Old", "2026-02-18T10:00:00Z")]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));

			await storeSummary(summary, undefined, true);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			// Verify the commit message says "Overwrite"
			const commitMsg = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][2] as string;
			expect(commitMsg).toContain("Overwrite");
		});

		it("should reuse existing diffStats when force=true and entry already has them", async () => {
			const summary = createMockSummary("existing");
			const existingEntry: SummaryIndexEntry = {
				...rootEntry("existing", "Old"),
				diffStats: { filesChanged: 10, insertions: 100, deletions: 50 },
				topicCount: 3,
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([existingEntry])));

			await storeSummary(summary, undefined, true);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const indexContent = JSON.parse(files[1].content) as SummaryIndex;
			// Should reuse existing diffStats (same commit hash → same diff)
			expect(indexContent.entries[0].diffStats).toEqual({ filesChanged: 10, insertions: 100, deletions: 50 });
			// getDiffStats should NOT be called — reused from existing entry
			expect(getDiffStats).not.toHaveBeenCalled();
		});

		it("should prefer node.diffStats over index and skip git call (new-data path)", async () => {
			// CommitSummary carries its own persisted diffStats (written by the pipeline).
			// flattenSummaryTree must prefer it — this guarantees summary.json and
			// index.json carry the same value by construction AND avoids a redundant
			// git call. Priority: node.diffStats > existing entry > fresh git diff.
			const summary: CommitSummary = {
				...createMockSummary("newdata"),
				diffStats: { filesChanged: 7, insertions: 77, deletions: 17 },
			};
			// Existing index has stale diffStats — should be ignored
			const staleEntry: SummaryIndexEntry = {
				...rootEntry("newdata", "Stale"),
				diffStats: { filesChanged: 99, insertions: 999, deletions: 999 },
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([staleEntry])));

			await storeSummary(summary, undefined, true);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const indexContent = JSON.parse(files[1].content) as SummaryIndex;
			// Index entry reflects node.diffStats, not the stale value nor a fresh git diff
			expect(indexContent.entries[0].diffStats).toEqual({ filesChanged: 7, insertions: 77, deletions: 17 });
			// No redundant git call when the node already carries the answer
			expect(getDiffStats).not.toHaveBeenCalled();
			// summary.json on disk reflects the same value — single source of truth
			const summaryContent = JSON.parse(files[0].content) as CommitSummary;
			expect(summaryContent.diffStats).toEqual({ filesChanged: 7, insertions: 77, deletions: 17 });
		});
	});

	// ── getIndex ──────────────────────────────────────────────────────────────

	describe("getIndex", () => {
		it("should return parsed index when it exists on the orphan branch", async () => {
			const mockIndex: SummaryIndex = {
				version: 3,
				entries: [rootEntry("aaa111", "First commit")],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(mockIndex));

			const result = await getIndex();

			expect(result).toEqual(mockIndex);
		});

		it("should return null when index file does not exist", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			const result = await getIndex();

			expect(result).toBeNull();
		});

		it("should return null when index file contains invalid JSON", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("not valid json {{{");

			const result = await getIndex();

			expect(result).toBeNull();
		});
	});

	// ── storeNotes ────────────────────────────────────────────────────────────

	describe("storeNotes", () => {
		it("should write note files to the orphan branch", async () => {
			await storeNotes(
				[
					{ id: "note-1", content: "# Note 1\nSome content" },
					{ id: "note-2", content: "# Note 2\nMore content" },
				],
				"Store session notes",
			);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledWith(
				expect.any(String),
				[
					{ path: "notes/note-1.md", content: "# Note 1\nSome content" },
					{ path: "notes/note-2.md", content: "# Note 2\nMore content" },
				],
				"Store session notes",
				undefined,
			);
		});

		it("should skip writing when noteFiles array is empty", async () => {
			await storeNotes([], "Empty commit");

			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});
	});

	describe("expandSourcesForConsolidation", () => {
		const leaf = (hash: string, topics: string[]): CommitSummary => ({
			version: 3,
			commitHash: hash,
			commitMessage: `Commit ${hash}`,
			commitAuthor: "Dev",
			commitDate: "2026-01-01T00:00:00Z",
			branch: "main",
			generatedAt: "2026-01-01T00:00:05Z",
			transcriptEntries: 0,
			stats: { filesChanged: 0, insertions: 0, deletions: 0 },
			topics: topics.map((t) => ({ title: t, detail: t, decisions: undefined })),
		});

		it("preserves grandchild topics in v3 squash-of-squash scenario", () => {
			// Inner squash: grandchild1 + grandchild2 were squashed into innerSquash
			const gc1 = leaf("gc1", ["gc1-topic"]);
			const gc2 = leaf("gc2", ["gc2-topic"]);
			const innerSquash: CommitSummary = {
				...leaf("inner", []),
				children: [gc2, gc1], // newest-first
			};
			// Outer squash combines innerSquash + another commit
			const sibling = leaf("sib", ["sib-topic"]);
			const outerSquash: CommitSummary = {
				...leaf("outer", []),
				children: [sibling, innerSquash], // newest-first
			};

			const sources = expandSourcesForConsolidation(outerSquash);

			// Should have two sources (one per direct child)
			expect(sources).toHaveLength(2);

			const innerSource = sources.find((s) => s.commitHash === "inner");
			const sibSource = sources.find((s) => s.commitHash === "sib");

			expect(sibSource?.topics.map((t) => t.title)).toEqual(["sib-topic"]);
			// Without the fix this would be [] — innerSquash.topics was empty
			expect(innerSource?.topics.map((t) => t.title)).toEqual(["gc1-topic", "gc2-topic"]);
		});

		it("returns a single source for v4 unified-hoist format", () => {
			const v4Summary: CommitSummary = {
				version: 4,
				commitHash: "v4abc",
				commitMessage: "Squash",
				commitAuthor: "Dev",
				commitDate: "2026-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2026-01-01T00:00:05Z",
				transcriptEntries: 0,
				stats: { filesChanged: 0, insertions: 0, deletions: 0 },
				topics: [{ title: "v4-topic", detail: "d", decisions: undefined }],
			};

			const sources = expandSourcesForConsolidation(v4Summary);

			expect(sources).toHaveLength(1);
			expect(sources[0]?.commitHash).toBe("v4abc");
			expect(sources[0]?.topics.map((t) => t.title)).toEqual(["v4-topic"]);
		});
	});
});
