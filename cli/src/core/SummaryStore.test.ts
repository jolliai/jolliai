import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock GitOps
vi.mock("./GitOps.js", () => ({
	readFileFromBranch: vi.fn(),
	writeMultipleFilesToBranch: vi.fn(),
	// Default to an empty listing so `getTranscriptHashes` (now called by
	// migrateOneToOne / mergeManyToOne to file-filter legacy transcript IDs)
	// resolves to an iterable instead of `undefined`. Tests that need specific
	// transcript files present override per-case.
	listFilesInBranch: vi.fn().mockResolvedValue([]),
	getTreeHash: vi.fn(),
	getDiffStats: vi.fn(),
	ensureOrphanBranch: vi.fn(),
	orphanBranchExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("./Locks.js", () => ({
	acquireOrphanWriteLock: vi.fn(),
	releaseOrphanWriteLock: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type {
	CommitInfo,
	CommitSummary,
	FileWrite,
	PlanProgressArtifact,
	SummaryIndex,
	SummaryIndexEntry,
} from "../Types.js";
import { FolderStorage } from "./FolderStorage.js";
import {
	getDiffStats,
	getTreeHash,
	listFilesInBranch,
	readFileFromBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";
import { acquireOrphanWriteLock, releaseOrphanWriteLock } from "./Locks.js";
import { MetadataManager } from "./MetadataManager.js";
import type { StorageProvider } from "./StorageProvider.js";
import {
	AmbiguousHashError,
	deleteNoteVisibleArtifact,
	deletePlanVisibleArtifact,
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
	readLinearIssueFromBranch,
	readNoteFromBranch,
	readPlanFromBranch,
	readPlanProgress,
	readTranscript,
	readTranscriptsForCommits,
	removeFromIndex,
	saveTranscriptsBatch,
	scanTreeHashAliases,
	setActiveStorage,
	storeLinearIssues,
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
		vi.mocked(acquireOrphanWriteLock).mockResolvedValue(true);
		vi.mocked(releaseOrphanWriteLock).mockResolvedValue(undefined);
		// Default empty transcript listing so `getTranscriptHashes` (called by
		// migrateOneToOne / mergeManyToOne to file-filter legacy transcript IDs)
		// resolves to an iterable. `resetAllMocks` wipes the factory default each
		// test, so re-establish it here. Tests needing specific transcript files
		// present override with `mockResolvedValueOnce`.
		vi.mocked(listFilesInBranch).mockResolvedValue([]);
	});

	describe("storeSummary", () => {
		it("should write summary and index in a single atomic commit", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			const summary = createMockSummary();
			await storeSummary(summary);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const callArgs = vi.mocked(writeMultipleFilesToBranch).mock.calls[0];
			const files = callArgs[1] as ReadonlyArray<FileWrite>;
			// 3 base writes: summary + index + catalog. catalog.json is the warm
			// path for jolli-search Phase 1; written on every storeSummary call
			// alongside summary + index in the same atomic commit.
			expect(files).toHaveLength(3);
			expect(files[0].path).toBe("summaries/abc123def456.json");
			expect(files[1].path).toBe("index.json");
			expect(files[2].path).toBe("catalog.json");

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

		it("should append a transcript artifact at the v5 transcript-id path when sessions are present", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			const summary = createMockSummary();
			await storeSummary(summary, undefined, false, {
				transcript: {
					id: "transcript-uuid-1",
					data: {
						sessions: [
							{
								sessionId: "claude/session-1",
								source: "claude",
								entries: [],
							},
						],
					},
				},
			});

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			// 3 base (summary + index + catalog) + 1 transcript appended after.
			expect(files).toHaveLength(4);
			expect(files[3]).toMatchObject({ path: "transcripts/transcript-uuid-1.json" });
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
			// 3 base files (summary + index + catalog) + 1 plan progress
			expect(files).toHaveLength(4);
			expect(files[3].path).toBe("plan-progress/my-plan-abc123de.json");

			const content = JSON.parse(files[3].content) as PlanProgressArtifact;
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
			// 3 base (summary + index + catalog) + 2 plan progress
			expect(files).toHaveLength(5);
			expect(files[3].path).toBe("plan-progress/plan-a-abc123de.json");
			expect(files[4].path).toBe("plan-progress/plan-b-abc123de.json");
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
		//   2. Otherwise loadIndex (1 read), then branch by input length:
		//      - 40-char SHA → check commitAliases, then tree-hash fallback.
		//      - shorter prefix → index prefix scan (own describe block below),
		//        then tree-hash fallback.

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

		it("falls back to commitAliases when direct read misses (40-char old SHA → new SHA)", async () => {
			// Alias keys are 40-char in production — use 40-char fixtures so the
			// length-branched lookup takes the alias-map path rather than prefix scan.
			const oldHash = "1111111111111111111111111111111111111111";
			const newHash = "2222222222222222222222222222222222222222";
			const summary = createMockSummary(newHash);
			const index = v3Index([rootEntry(newHash)], { [oldHash]: newHash });

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // direct readSummaryFile(oldHash) miss
				.mockResolvedValueOnce(JSON.stringify(index)) // loadIndex
				.mockResolvedValueOnce(JSON.stringify(summary)); // readSummaryFile(aliasHash)

			const result = await getSummary(oldHash);
			expect(result?.commitHash).toBe(newHash);
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
			// getTreeHash mock left unconfigured -> resolves to null, no match.
			// Use 18-char input so the prefix-scan branch runs and produces 0
			// matches (knownhash00 doesn't start with absolutely-unknown).
			const result = await getSummary("absolutely-unknown");
			expect(result).toBeNull();
		});
	});

	describe("getSummary (abbreviated-hash prefix scan)", () => {
		// Inputs shorter than 40 characters take the index-prefix-scan branch
		// after Step 1 misses. Resolution is purely in-memory via index.entries.

		const ENTRY_ONE = "abcdef1234567890abcdef1234567890abcdef12"; // 40 chars
		const ENTRY_TWO = "abcdef9876543210abcdef9876543210abcdef98"; // 40 chars, shares "abcdef" prefix
		const ENTRY_THREE = "fedcba0000000000000000000000000000000000";

		it("resolves an abbreviated hash to the unique matching entry without touching git or alias map", async () => {
			const summary = createMockSummary(ENTRY_ONE);
			const index = v3Index([rootEntry(ENTRY_ONE), rootEntry(ENTRY_THREE)]);

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1 readSummaryFile("abcdef12") miss
				.mockResolvedValueOnce(JSON.stringify(index)) // loadIndex
				.mockResolvedValueOnce(JSON.stringify(summary)); // readSummaryFile(matched.commitHash)

			// "abcdef12" matches only ENTRY_ONE (ENTRY_THREE starts with "fedcba")
			const result = await getSummary("abcdef12");
			expect(result?.commitHash).toBe(ENTRY_ONE);
			// The behavioral assertion: prefix scan resolves without invoking
			// the git tree-hash subprocess. Read counts are intentionally NOT
			// asserted — they're an implementation detail (caching / batching
			// could change them) and the no-git-call check is the contract.
			expect(vi.mocked(getTreeHash)).not.toHaveBeenCalled();
		});

		it("throws AmbiguousHashError when an abbreviated hash matches multiple entries", async () => {
			const index = v3Index([rootEntry(ENTRY_ONE), rootEntry(ENTRY_TWO), rootEntry(ENTRY_THREE)]);

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1 miss
				.mockResolvedValueOnce(JSON.stringify(index)); // loadIndex

			// "abcdef" matches both ENTRY_ONE and ENTRY_TWO
			let caught: unknown;
			try {
				await getSummary("abcdef");
			} catch (error: unknown) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(AmbiguousHashError);
			expect((caught as AmbiguousHashError).prefix).toBe("abcdef");
			// Order of matches is incidental (could change to e.g. sort by date
			// for deterministic display) — only the SET of colliding hashes is
			// part of the contract.
			expect([...(caught as AmbiguousHashError).matches].sort()).toEqual([ENTRY_ONE, ENTRY_TWO].sort());
			expect((caught as AmbiguousHashError).matches).toHaveLength(2);
			expect((caught as AmbiguousHashError).message).toContain("abbreviation `abcdef` is ambiguous");
		});

		it("falls through to tree-hash fallback when an abbreviated hash has no prefix match in the index", async () => {
			// The hash isn't in the index by name, but git might still resolve it.
			// We can't exercise the tree-hash hit branch here (it's marked
			// `v8 ignore`), but we verify that we ATTEMPT the cross-tree fallback
			// — getTreeHash should be called.
			const index = v3Index([rootEntry(ENTRY_ONE)]);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1 miss
				.mockResolvedValueOnce(JSON.stringify(index)); // loadIndex
			vi.mocked(getTreeHash).mockResolvedValueOnce(null); // no tree resolved → null result

			// "deadbeef" has 0 prefix matches (ENTRY_ONE starts with "abcdef…")
			const result = await getSummary("deadbeef");
			expect(result).toBeNull();
			expect(vi.mocked(getTreeHash)).toHaveBeenCalledWith("deadbeef", undefined);
		});

		it("treats very short prefixes the same as longer ones — multiple matches still throw", async () => {
			// Validates that we don't need a hard minimum-length check at the
			// resolver level: an extremely short input simply hits more entries
			// and surfaces the same AmbiguousHashError, which carries the user-
			// actionable signal.
			const index = v3Index([rootEntry(ENTRY_ONE), rootEntry(ENTRY_TWO)]);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1 miss
				.mockResolvedValueOnce(JSON.stringify(index)); // loadIndex

			await expect(getSummary("a")).rejects.toThrow(AmbiguousHashError);
		});

		it("lowercases the user input before resolving (UPPERCASE prefix still hits)", async () => {
			// Index `commitHash` values are stored lowercase. Without normalizing
			// at the resolver boundary, `--commit ABCDEF12` would scan against
			// lowercase entries and miss every step except the v3 tree-hash
			// fallback. We lowercase up front so all callers (CLI, sidebar, URI
			// handler) see consistent behavior.
			const summary = createMockSummary(ENTRY_ONE);
			const index = v3Index([rootEntry(ENTRY_ONE)]);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1 miss (lowercase already)
				.mockResolvedValueOnce(JSON.stringify(index))
				.mockResolvedValueOnce(JSON.stringify(summary));

			const result = await getSummary("ABCDEF12"); // uppercase prefix
			expect(result?.commitHash).toBe(ENTRY_ONE);
		});

		it("returns null on an empty index (no entries to scan)", async () => {
			// Sanity edge case: prefix scan over zero entries returns 0 matches
			// and falls through to Step 4 cleanly.
			const index = v3Index([]);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1 miss
				.mockResolvedValueOnce(JSON.stringify(index)); // loadIndex (empty)
			vi.mocked(getTreeHash).mockResolvedValueOnce(null);

			const result = await getSummary("abcdef12");
			expect(result).toBeNull();
		});

		it("works against a v1 index — prefix scan matches entries regardless of index version", async () => {
			// v1 indexes have entries with `parentCommitHash: undefined` (vs v3's
			// explicit null). The prefix-scan loop iterates `index.entries`
			// without referencing parentCommitHash, so it should resolve cleanly
			// — and Step 4 (cross-tree) is gated to v3 only, so v1 input that
			// misses prefix scan ends up null with no git call.
			const summary = createMockSummary(ENTRY_ONE);
			const v1Entry: SummaryIndexEntry = {
				commitHash: ENTRY_ONE,
				parentCommitHash: undefined, // v1 marker
				commitMessage: "v1 commit",
				commitDate: "2026-02-19T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-19T10:00:05Z",
			};
			const v1Index: SummaryIndex = { version: 1, entries: [v1Entry] };
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1 miss
				.mockResolvedValueOnce(JSON.stringify(v1Index)) // loadIndex
				.mockResolvedValueOnce(JSON.stringify(summary)); // readSummaryFile(matched)

			const result = await getSummary("abcdef12");
			expect(result?.commitHash).toBe(ENTRY_ONE);
			// Step 4 was gated to v3 — v1 with 0 prefix matches must NOT call git.
			expect(vi.mocked(getTreeHash)).not.toHaveBeenCalled();
		});

		it("v1 index with a non-matching prefix returns null and skips Step 4", async () => {
			// Verifies the Step-4-gated-to-v3 behavior on the miss path.
			const v1Entry: SummaryIndexEntry = {
				commitHash: ENTRY_ONE,
				parentCommitHash: undefined,
				commitMessage: "v1",
				commitDate: "2026-02-19T10:00:00Z",
				branch: "main",
				generatedAt: "2026-02-19T10:00:05Z",
			};
			const v1Index: SummaryIndex = { version: 1, entries: [v1Entry] };
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(v1Index));

			const result = await getSummary("deadbeef"); // no prefix match
			expect(result).toBeNull();
			expect(vi.mocked(getTreeHash)).not.toHaveBeenCalled();
		});
	});

	describe("getSummary (full-SHA Step 4 fallthrough)", () => {
		// Locks in the four-step contract for full SHA inputs that miss
		// Steps 1+2 — i.e. direct file read fails AND alias map has no entry.
		// Without this we only test Step 4 fallthrough on the abbreviated branch.

		it("returns null when 40-char input misses direct file, alias map, AND tree-hash", async () => {
			const fullHash = "ffffffffffffffffffffffffffffffffffffffff";
			const otherEntry = "0000000000000000000000000000000000000001";
			const index = v3Index([rootEntry(otherEntry)]); // no alias for fullHash, no matching tree
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1 miss
				.mockResolvedValueOnce(JSON.stringify(index)); // loadIndex
			// getTreeHash mock: we let it resolve to null to confirm Step 4 was
			// invoked but produced no match.
			vi.mocked(getTreeHash).mockResolvedValueOnce(null);

			const result = await getSummary(fullHash);
			expect(result).toBeNull();
			expect(vi.mocked(getTreeHash)).toHaveBeenCalledWith(fullHash, undefined);
		});

		it("hits commitAliases via lowercase normalization when the input is UPPERCASE 40-char", async () => {
			// Catches the case the reviewer flagged: alias map keys are
			// lowercase in production, so an UPPERCASE 40-char input must
			// lowercase before lookup or the alias path silently misses.
			const oldHashLower = "abcdef1234567890abcdef1234567890abcdef12";
			const oldHashUpper = oldHashLower.toUpperCase();
			const newHash = "1111111111111111111111111111111111111111";
			const summary = createMockSummary(newHash);
			const index = v3Index([rootEntry(newHash)], { [oldHashLower]: newHash });

			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1: readSummaryFile(lowercase) miss
				.mockResolvedValueOnce(JSON.stringify(index)) // loadIndex
				.mockResolvedValueOnce(JSON.stringify(summary)); // readSummaryFile(aliasHash)

			const result = await getSummary(oldHashUpper);
			expect(result?.commitHash).toBe(newHash);
		});

		it("returns null on empty-string input without scanning the index", async () => {
			// Without the empty-string guard, "" would fall through to prefix
			// scan where `e.commitHash.startsWith("")` matches every entry,
			// and `getSummary` would throw `AmbiguousHashError("", [all])`.
			// Guard at the top short-circuits cleanly to null with no I/O.
			const result = await getSummary("");
			expect(result).toBeNull();
			expect(vi.mocked(readFileFromBranch)).not.toHaveBeenCalled();
		});

		it("does NOT resolve an abbreviated hash that only matches a key in commitAliases", async () => {
			// Contract: the alias map is consulted only on the FULL-SHA branch.
			// An abbreviated input that happens to be a prefix of an alias key
			// (but not of any entry's commitHash) must NOT resolve via the
			// alias path — that path is for amend / rebase rewrites where the
			// caller knows the exact 40-char old SHA. Resolving short prefixes
			// against alias keys would be a surprising back-door.
			const onlyAliasEntry = "ffffffffffffffffffffffffffffffffffffffff";
			const aliasOldHash = "abcdef1234567890abcdef1234567890abcdef12"; // 40-char alias key
			const index = v3Index(
				// Entry's commitHash starts with "ff…", so the prefix scan
				// will MISS for an "abcd…" prefix even though the alias map
				// has "abcd…" as a key.
				[rootEntry(onlyAliasEntry)],
				{ [aliasOldHash]: onlyAliasEntry },
			);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(null) // Step 1: readSummaryFile("abcdef12") miss
				.mockResolvedValueOnce(JSON.stringify(index)); // loadIndex
			vi.mocked(getTreeHash).mockResolvedValueOnce(null); // Step 4 also misses

			const result = await getSummary("abcdef12");
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
			// summary + index + catalog (3 base writes per storeSummary call)
			expect(files).toHaveLength(3);
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
		it("hoists recap from a v3 squash root's children (recap not dropped on rebase-pick)", async () => {
			// A v3 squash root keeps its recap on children, not the root. Reading
			// oldSummary.recap directly would drop it; resolveEffectiveRecap picks
			// the newest descendant's recap (mirrors normalizeToV4 + topics).
			const oldHash = "oldhash0000000000000rec";
			const newHash = "newhash0000000000000rec";
			const oldSummary: CommitSummary = {
				...createMockSummary(oldHash, "Squashed feature"),
				recap: undefined, // root carries no recap (v3 squash shape)
				children: [
					{ ...createMockSummary("child0000000000000001"), recap: "Implemented the dark-mode toggle." },
				],
			};

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "Rebased"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newSummary = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummary.recap).toBe("Implemented the dark-mode toggle.");
		});

		it("filters legacy-derived transcript IDs to those with a backing file (#4: no dangling IDs)", async () => {
			// Legacy (v3) input → transcripts derived from the children tree, then
			// filtered to commit hashes that actually have a transcript file —
			// mirrors the v5 migration so a rebase-pick doesn't bake a dangling ID
			// (a session-less commit) into the authoritative v5 array.
			const oldHash = "oldhash0000000000000abc";
			const newHash = "newhash0000000000000def";
			const oldSummary = createMockSummary(oldHash, "Old message"); // v3, no transcripts field

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));
			// Only the old commit's transcript file exists on disk.
			vi.mocked(listFilesInBranch).mockResolvedValueOnce([`transcripts/${oldHash}.json`]);

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newSummary = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummary.transcripts).toEqual([oldHash]);
		});

		it("drops a legacy transcript ID with no backing file from the migrated v5 array (#4)", async () => {
			const oldHash = "oldhash0000000000000abc";
			const newHash = "newhash0000000000000def";
			const oldSummary = createMockSummary(oldHash, "Old message"); // session-less: no file

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));
			// No transcript files on disk → the dangling hash must not be carried.
			vi.mocked(listFilesInBranch).mockResolvedValueOnce([]);

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newSummary = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummary.transcripts).toEqual([]);
		});

		it("should create a rebase container node wrapping the old summary as a child", async () => {
			const oldHash = "oldhash0000000000000001";
			const newHash = "newhash0000000000000002";
			const oldSummary = createMockSummary(oldHash, "Old message");

			const existingIndex = v3Index([rootEntry(oldHash, "Old message", "2026-02-18T10:00:00Z")]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(existingIndex));

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			expect(writeMultipleFilesToBranch).toHaveBeenCalledTimes(1);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			// migrateOneToOne writes summary + index + catalog (same 3-file shape as
			// storeSummary).
			expect(files).toHaveLength(3);
			expect(files[2].path).toBe("catalog.json");

			const newSummaryContent = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummaryContent.commitHash).toBe(newHash);
			expect(newSummaryContent.commitMessage).toBe("New message");
			// v5 root: commitType = "rebase"; topics + recap are Copy-Hoisted from
			// old; the migrated summary inherits the source's transcripts array.
			expect(newSummaryContent.version).toBe(5);
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
						title: "checkout flow",
						steps: ["open cart", "submit order"],
						expectedResults: ["order succeeds"],
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
					title: "checkout flow",
					steps: ["open cart", "submit order"],
					expectedResults: ["order succeeds"],
				},
			]);
			expect(newSummaryContent.children?.[0].plans).toBeUndefined();
			expect(newSummaryContent.children?.[0].e2eTestGuide).toBeUndefined();
		});

		it("should hoist linearIssues onto the rebase container node (regression: rebase silently dropped Linear refs)", async () => {
			// Regression: migrateOneToOne carried plans/notes/e2eTestGuide
			// forward to the new root summary but forgot linearIssues. After
			// rebasing a branch carrying Linear-issue archives, the rebased
			// commits' summaries had linearIssues:[] on the orphan branch even
			// though the registry still pointed at the (renamed-on-disk)
			// snapshot files — panel + PR markdown stopped showing the
			// associations until the next manual commit.
			const oldHash = "oldhash0000000000000001";
			const newHash = "newhash0000000000000002";
			const oldSummary: CommitSummary = {
				...createMockSummary(oldHash, "Old message"),
				linearIssues: [
					{
						archivedKey: "PROJ-1528-oldhash0",
						ticketId: "PROJ-1528",
						title: "Treat referenced Linear issues as a first-class panel item",
						url: "https://linear.app/jolliai/issue/PROJ-1528/test",
						referencedAt: "2026-05-14T09:11:43.708Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			};

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);

			await migrateOneToOne(oldSummary, createMockCommitInfo(newHash, "New message"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const newSummaryContent = JSON.parse(files[0].content) as CommitSummary;
			expect(newSummaryContent.linearIssues).toEqual([
				{
					archivedKey: "PROJ-1528-oldhash0",
					ticketId: "PROJ-1528",
					title: "Treat referenced Linear issues as a first-class panel item",
					url: "https://linear.app/jolliai/issue/PROJ-1528/test",
					referencedAt: "2026-05-14T09:11:43.708Z",
					sourceToolName: "mcp__linear__get_issue",
				},
			]);
			// Wrapped child must have linearIssues stripped (Hoist invariant —
			// root is the only authoritative carrier; same rule as plans/notes).
			expect(newSummaryContent.children?.[0].linearIssues).toBeUndefined();
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

		it("Copy-Hoists summaryError from old summary onto the rebased root", async () => {
			// Rebase-pick doesn't run the LLM, so a degraded old summary stays
			// degraded on the new hash. Without this propagation the webview
			// banner would silently disappear after rebase even though the
			// underlying LLM failure was never resolved.
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const oldSummary: CommitSummary = {
				...createMockSummary("oldhash"),
				summaryError: "llm-failed",
			};

			await migrateOneToOne(oldSummary, createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			expect(migrated.summaryError).toBe("llm-failed");
		});

		it("upgrades legacy stopReason='error' on old summary to summaryError on the rebased root", async () => {
			// Legacy summaries (pre-summaryError field) signal failure via
			// llm.stopReason === "error". isSummaryError() honors both so the
			// new field gets set on migration; without this, post-rebase
			// banners would only fire for summaries written by the new code.
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const oldSummary: CommitSummary = {
				...createMockSummary("oldhash"),
				llm: { model: "x", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "error" },
			};

			await migrateOneToOne(oldSummary, createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			expect(migrated.summaryError).toBe("llm-failed");
		});

		it("does NOT set summaryError on the rebased root when the old summary is healthy", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const oldSummary: CommitSummary = {
				...createMockSummary("oldhash"),
				llm: { model: "x", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
			};

			await migrateOneToOne(oldSummary, createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const migrated = JSON.parse(files[0].content) as CommitSummary;
			expect(migrated.summaryError).toBeUndefined();
		});
	});

	describe("mergeManyToOne", () => {
		it("unions only file-backed legacy transcript IDs into the merged root (#4: no dangling IDs)", async () => {
			const oldHash1 = "oldhash00000000000000a1";
			const oldHash2 = "oldhash00000000000000a2";
			const newHash = "newhash00000000000000a3";
			// Two legacy (v3) sources; only the first has a transcript file.
			const summary1 = createMockSummary(oldHash1, "First");
			const summary2 = createMockSummary(oldHash2, "Second"); // session-less

			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));
			vi.mocked(listFilesInBranch).mockResolvedValueOnce([`transcripts/${oldHash1}.json`]);

			await mergeManyToOne([summary1, summary2], createMockCommitInfo(newHash, "Squashed"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			// oldHash2 had no transcript file → excluded; oldHash1 survives.
			expect(merged.transcripts).toEqual([oldHash1]);
		});

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
			// Root is v5 with consolidated topics/recap on root + unioned transcripts.
			expect(mergedContent.version).toBe(5);

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
								title: "checkout flow",
								steps: ["open cart", "submit order"],
								expectedResults: ["order succeeds"],
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
					title: "checkout flow",
					steps: ["open cart", "submit order"],
					expectedResults: ["order succeeds"],
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

		it("should hoist and dedupe linearIssues from children by newest referencedAt", async () => {
			const old1: CommitSummary = {
				...createMockSummary("old1", "Old 1"),
				linearIssues: [
					{
						archivedKey: "PROJ-1-old1",
						ticketId: "PROJ-1",
						title: "Old title",
						url: "https://linear.app/x/PROJ-1",
						referencedAt: "2026-02-18T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
				children: [
					{
						...createMockSummary("nested-child", "Nested child"),
						linearIssues: [
							{
								archivedKey: "PROJ-1-old1",
								ticketId: "PROJ-1",
								title: "Newer title",
								url: "https://linear.app/x/PROJ-1",
								referencedAt: "2026-02-20T00:00:00Z",
								sourceToolName: "mcp__linear__get_issue",
							},
							{
								archivedKey: "PROJ-2-nested",
								ticketId: "PROJ-2",
								title: "Nested Only",
								url: "https://linear.app/x/PROJ-2",
								referencedAt: "2026-02-19T00:00:00Z",
								sourceToolName: "mcp__linear__get_issue",
							},
						],
					},
				],
			};
			const old2: CommitSummary = {
				...createMockSummary("old2", "Old 2"),
				linearIssues: [
					{
						archivedKey: "PROJ-3-old2",
						ticketId: "PROJ-3",
						title: "Root Only",
						url: "https://linear.app/x/PROJ-3",
						referencedAt: "2026-02-19T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				],
			};
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(v3Index([])));

			await mergeManyToOne([old1, old2], createMockCommitInfo("newhash"));

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			// 3 refs after dedupe-keep-latest on archivedKey
			expect(merged.linearIssues).toHaveLength(3);
			const dup = merged.linearIssues?.find((r) => r.archivedKey === "PROJ-1-old1");
			expect(dup?.title).toBe("Newer title");
			expect(dup?.referencedAt).toBe("2026-02-20T00:00:00Z");
			expect(merged.linearIssues?.find((r) => r.archivedKey === "PROJ-2-nested")).toBeDefined();
			expect(merged.linearIssues?.find((r) => r.archivedKey === "PROJ-3-old2")).toBeDefined();
			// Children should have linearIssues stripped
			expect(merged.children?.[0].linearIssues).toBeUndefined();
			expect(merged.children?.[1].linearIssues).toBeUndefined();
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

		it("propagates summaryError from ConsolidatedTopics onto the merged root", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const newHash = "newhash0000000000000099";

			await mergeManyToOne(
				[createMockSummary("old1"), createMockSummary("old2")],
				createMockCommitInfo(newHash),
				undefined,
				undefined,
				{
					topics: [{ title: "Merged", trigger: "t", response: "r", decisions: "d" }],
					summaryError: "llm-failed",
				},
			);

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.summaryError).toBe("llm-failed");
			expect(merged.topics).toEqual([{ title: "Merged", trigger: "t", response: "r", decisions: "d" }]);
		});

		it("does NOT set summaryError on the merged root when ConsolidatedTopics omits it", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(null);
			const newHash = "newhash0000000000000098";

			await mergeManyToOne([createMockSummary("old1")], createMockCommitInfo(newHash), undefined, undefined, {
				topics: [{ title: "Merged", trigger: "t", response: "r", decisions: "d" }],
			});

			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const merged = JSON.parse(files[0].content) as CommitSummary;
			expect(merged.summaryError).toBeUndefined();
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

		it("threads an explicit StorageProvider to readTranscript instead of the orphan-branch fallback", async () => {
			// Folder-only Memory Bank correctness: when the caller (e.g.
			// JolliMemoryBridge.loadRegenerateContext) passes a storage
			// argument, the read MUST go through that provider, not the
			// resolveStorage fallback that always returns OrphanBranchStorage.
			const fakeStorage = {
				readFile: vi.fn().mockResolvedValue(
					JSON.stringify({
						sessions: [{ sessionId: "from-folder", entries: [] }],
					}),
				),
			} as unknown as Parameters<typeof readTranscript>[2];

			const result = await readTranscript("abc123", undefined, fakeStorage);

			expect(fakeStorage?.readFile).toHaveBeenCalledWith("transcripts/abc123.json");
			expect(result?.sessions[0]?.sessionId).toBe("from-folder");
		});

		it("threads StorageProvider through readTranscriptsForCommits to each read", async () => {
			// The batch wrapper must forward storage to every underlying
			// readTranscript so folder-only users get the same backend on
			// every hash.
			const fakeStorage = {
				readFile: vi
					.fn()
					.mockResolvedValueOnce(JSON.stringify({ sessions: [{ sessionId: "a", entries: [] }] }))
					.mockResolvedValueOnce(JSON.stringify({ sessions: [{ sessionId: "b", entries: [] }] })),
			} as unknown as Parameters<typeof readTranscriptsForCommits>[2];

			const result = await readTranscriptsForCommits(["h1", "h2"], undefined, fakeStorage);

			expect(fakeStorage?.readFile).toHaveBeenCalledTimes(2);
			expect(fakeStorage?.readFile).toHaveBeenNthCalledWith(1, "transcripts/h1.json");
			expect(fakeStorage?.readFile).toHaveBeenNthCalledWith(2, "transcripts/h2.json");
			expect(result.size).toBe(2);
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

		// End-to-end integration test for the 2026-05-26 Windows path bug:
		// drive a REAL FolderStorage (not a mock) and verify getTranscriptHashes
		// finds the hash. Before the toForwardSlash fix, FolderStorage.walkDir
		// on Windows returned `transcripts\<hash>.json`, the regex never
		// matched, and the set came back empty.
		it("extracts hashes from a real FolderStorage backend (Windows regression)", async () => {
			const root = joinPath(
				tmpdir(),
				`getTranscriptHashes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(root, { recursive: true });
			try {
				const mm = new MetadataManager(joinPath(root, ".jolli"));
				const storage: StorageProvider = new FolderStorage(root, mm);
				await storage.ensure();
				await storage.writeFiles(
					[
						{
							path: "transcripts/8af39d0716602b52396ae1cc7ee08420d6dddfc3.json",
							content: '{"sessions":[]}',
						},
						{
							path: "transcripts/0123456789abcdef0123456789abcdef01234567.json",
							content: '{"sessions":[]}',
						},
					],
					"seed",
				);

				const hashes = await getTranscriptHashes(undefined, storage);
				expect(hashes.has("8af39d0716602b52396ae1cc7ee08420d6dddfc3")).toBe(true);
				expect(hashes.has("0123456789abcdef0123456789abcdef01234567")).toBe(true);
				expect(hashes.size).toBe(2);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("should accept v5 UUID filenames (with hyphens) alongside legacy hex hashes", async () => {
			// The pre-fix regex required `[a-f0-9]+` which silently rejected v5
			// UUIDs (`8-4-4-4-12` shape). With UUIDs missing from the file-list
			// intersection, `SummaryWebviewPanel.refreshTranscriptHashes` would
			// treat them as "not on disk" and drop them from the panel — hiding
			// every conversation for v5-written summaries. Guard with mixed-
			// namespace fixture so a future tightening of the pattern reverts.
			vi.mocked(listFilesInBranch).mockResolvedValueOnce([
				"transcripts/abc123def456.json", // legacy commit-hash style
				"transcripts/01234567-89ab-cdef-0123-456789abcdef.json", // v5 UUID
				"transcripts/AAAAAAAA-1234-5678-9ABC-DEFFFFFFFFFF.json", // upper-case UUID
				"transcripts/skip-not-json.txt", // wrong extension
				"other-dir/abc123.json", // wrong prefix
			]);
			const hashes = await getTranscriptHashes();
			expect(hashes).toEqual(
				new Set([
					"abc123def456",
					"01234567-89ab-cdef-0123-456789abcdef",
					"AAAAAAAA-1234-5678-9ABC-DEFFFFFFFFFF",
				]),
			);
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
			// scanTreeHashAliases reads twice: preflight (no lock) + inside-lock re-read.
			vi.mocked(readFileFromBranch).mockResolvedValue(JSON.stringify(index));
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

		it("should defer alias writes when orphan-write lock cannot be acquired", async () => {
			const index = v3Index([{ ...rootEntry("root1", "Root"), treeHash: "tree-1" }]);
			vi.mocked(readFileFromBranch).mockResolvedValueOnce(JSON.stringify(index));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");
			vi.mocked(acquireOrphanWriteLock).mockResolvedValueOnce(false);

			await expect(scanTreeHashAliases(["unknown1"])).resolves.toBe(false);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
			expect(releaseOrphanWriteLock).not.toHaveBeenCalled();
		});

		it("should alias to the most recent shallow match when tree hash depth ties", async () => {
			const index = v3Index([
				{ ...rootEntry("older-root", "Older", "2026-02-18T10:00:00Z"), treeHash: "tree-1" },
				{ ...rootEntry("newer-root", "Newer", "2026-02-19T10:00:00Z"), treeHash: "tree-1" },
			]);
			// scanTreeHashAliases reads twice: preflight + inside-lock re-read.
			vi.mocked(readFileFromBranch).mockResolvedValue(JSON.stringify(index));
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
			// scanTreeHashAliases reads twice: preflight + inside-lock re-read.
			vi.mocked(readFileFromBranch).mockResolvedValue(JSON.stringify(index));
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
			// scanTreeHashAliases reads twice: preflight + inside-lock re-read.
			vi.mocked(readFileFromBranch).mockResolvedValue(JSON.stringify(index));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");

			const result = await scanTreeHashAliases(["unknown1"]);

			expect(result).toBe(true);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const persistedIndex = JSON.parse(files[0].content) as SummaryIndex;
			expect(persistedIndex.commitAliases).toEqual({ unknown1: "cycle-newer" });
		});

		// ── regression: lost-update race ─────────────────────────────────────
		//
		// Before this fix, scanTreeHashAliases read `index` outside the lock,
		// computed `newAliases`, then acquired the lock and wrote
		// `{ ...index, commitAliases: mergedAliases }`. If the worker wrote a
		// new entry to `index.entries` between scan's preflight read and scan's
		// lock-acquire, the worker's entry would be clobbered when scan wrote
		// back its stale `entries`. The fix re-reads inside the lock and merges
		// only `commitAliases` into the fresh index, preserving any entries the
		// worker added concurrently.
		it("preserves worker-written entries that landed between preflight and lock acquire", async () => {
			const preflightIdx = v3Index(
				[{ ...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"), treeHash: "tree-1" }],
				{},
			);
			// Simulates a worker that ran storeSummary between scan's preflight
			// read and scan's inside-lock re-read: a brand-new root entry has
			// landed in the index.
			const freshIdx = v3Index(
				[
					{ ...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"), treeHash: "tree-1" },
					{ ...rootEntry("worker-new", "Worker added me", "2026-02-19T11:00:00Z"), treeHash: "tree-2" },
				],
				{},
			);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(preflightIdx)) // preflight (no lock)
				.mockResolvedValueOnce(JSON.stringify(freshIdx)); // inside-lock re-read
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");

			const result = await scanTreeHashAliases(["unknown1"]);

			expect(result).toBe(true);
			const files = vi.mocked(writeMultipleFilesToBranch).mock.calls[0][1] as ReadonlyArray<FileWrite>;
			const persistedIndex = JSON.parse(files[0].content) as SummaryIndex;

			// Critical assertion: the worker's new entry must survive scan's write.
			const persistedHashes = persistedIndex.entries.map((e) => e.commitHash);
			expect(persistedHashes).toContain("root1");
			expect(persistedHashes).toContain("worker-new");
			// And scan's alias is recorded.
			expect(persistedIndex.commitAliases).toEqual({ unknown1: "root1" });
		});

		it("drops a candidate that was already aliased by a concurrent writer", async () => {
			// Preflight: unknown1 is unaliased; tree-1 matches root1.
			const preflightIdx = v3Index([{ ...rootEntry("root1", "Root"), treeHash: "tree-1" }], {});
			// Fresh: a concurrent scan/writer already aliased unknown1 → root1.
			const freshIdx = v3Index([{ ...rootEntry("root1", "Root"), treeHash: "tree-1" }], {
				unknown1: "root1",
			});
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(preflightIdx))
				.mockResolvedValueOnce(JSON.stringify(freshIdx));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");

			const result = await scanTreeHashAliases(["unknown1"]);

			// Already-aliased → nothing new to write.
			expect(result).toBe(false);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("drops a candidate whose hash already exists as an entry in the fresh index", async () => {
			// Preflight: unknown1 is missing entirely.
			const preflightIdx = v3Index([{ ...rootEntry("root1", "Root"), treeHash: "tree-1" }], {});
			// Fresh: a concurrent worker stored a real summary for unknown1
			// (it is now a first-class entry, no alias needed).
			const freshIdx = v3Index(
				[
					{ ...rootEntry("root1", "Root"), treeHash: "tree-1" },
					{ ...rootEntry("unknown1", "Worker stored me", "2026-02-19T11:00:00Z"), treeHash: "tree-9" },
				],
				{},
			);
			vi.mocked(readFileFromBranch)
				.mockResolvedValueOnce(JSON.stringify(preflightIdx))
				.mockResolvedValueOnce(JSON.stringify(freshIdx));
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-1");

			const result = await scanTreeHashAliases(["unknown1"]);

			expect(result).toBe(false);
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		// ── two-storage contract (readStorage for candidates, storage for write) ───
		//
		// Read-side and write-side may legitimately hold different rows (e.g.
		// a FolderStorage shadow has rows the orphan-branch primary lacks, or
		// vice versa). Preflight candidate discovery uses readStorage so the
		// candidate set reflects what the UI is showing; the inside-lock
		// re-read and the alias write use storage so the persisted entries
		// array matches what's already on the write storage's primary backend
		// (otherwise the dual-write would clobber primary rows).
		it("preflight reads via readStorage; in-lock re-read + write go via storage", async () => {
			const indexJson = JSON.stringify(
				v3Index(
					[
						{
							...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"),
							treeHash: "tree-X",
						},
					],
					{},
				),
			);
			const readStorage: StorageProvider = {
				readFile: vi.fn().mockResolvedValue(indexJson),
				writeFiles: vi.fn(),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			};
			const writeStorage: StorageProvider = {
				readFile: vi.fn().mockResolvedValue(indexJson),
				writeFiles: vi.fn().mockResolvedValue(undefined),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			};
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-X");

			const result = await scanTreeHashAliases(["unknown1"], undefined, writeStorage, readStorage);

			expect(result).toBe(true);
			// Preflight (1) reads readStorage; in-lock re-read reads BOTH:
			// writeStorage to build the persisted entries, then readStorage
			// again for the symmetric divergence check that prevents
			// shadow-clobber. Two reads on readStorage, one on writeStorage.
			expect(readStorage.readFile).toHaveBeenCalledTimes(2);
			expect(writeStorage.readFile).toHaveBeenCalledTimes(1);
			// Alias write hits writeStorage so the alias propagates to both
			// dual-write backends. Routing the write to readStorage would
			// orphan the alias from the primary backend.
			expect(writeStorage.writeFiles).toHaveBeenCalledTimes(1);
			expect(readStorage.writeFiles).not.toHaveBeenCalled();
			const [persistedFiles] = vi.mocked(writeStorage.writeFiles).mock.calls[0] as [
				ReadonlyArray<FileWrite>,
				string,
			];
			const persistedIndex = JSON.parse(persistedFiles[0].content) as SummaryIndex;
			expect(persistedIndex.commitAliases).toEqual({ unknown1: "root1" });
		});

		it("preserves storage's entries when readStorage lacks rows (no orphan-row clobber)", async () => {
			// C1 regression: read-side (FolderStorage shadow) is one row short
			// of the write-side (DualWrite primary = orphan branch). A previous
			// implementation re-read the freshIndex via readStorage and persisted
			// readStorage.entries to BOTH backends — silently deleting the
			// orphan-only row on the primary. Pin the fix: write payload's
			// entries must come from storage so the primary's rows survive.
			const orphanIndex = JSON.stringify(
				v3Index(
					[
						{ ...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"), treeHash: "tree-X" },
						{
							...rootEntry("orphan-only", "Orphan only row", "2026-02-19T10:00:00Z"),
							treeHash: "tree-O",
						},
					],
					{},
				),
			);
			const folderIndex = JSON.stringify(
				v3Index([{ ...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"), treeHash: "tree-X" }], {}),
			);
			const readStorage: StorageProvider = {
				readFile: vi.fn().mockResolvedValue(folderIndex),
				writeFiles: vi.fn(),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			};
			const writeStorage: StorageProvider = {
				readFile: vi.fn().mockResolvedValue(orphanIndex),
				writeFiles: vi.fn().mockResolvedValue(undefined),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			};
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-X");

			await scanTreeHashAliases(["unknown1"], undefined, writeStorage, readStorage);

			const [persistedFiles] = vi.mocked(writeStorage.writeFiles).mock.calls[0] as [
				ReadonlyArray<FileWrite>,
				string,
			];
			const persistedIndex = JSON.parse(persistedFiles[0].content) as SummaryIndex;
			const persistedHashes = persistedIndex.entries.map((e) => e.commitHash);
			// Both rows survive — orphan-only row is the load-bearing one.
			expect(persistedHashes).toContain("root1");
			expect(persistedHashes).toContain("orphan-only");
			// And the alias still landed.
			expect(persistedIndex.commitAliases).toEqual({ unknown1: "root1" });
		});

		it("defers alias write when readStorage has rows storage lacks (no folder-row clobber)", async () => {
			// Symmetric counterpart to the orphan-row-clobber regression above.
			// readStorage (FolderStorage shadow) holds a row that writeStorage
			// (DualWrite → orphan primary) doesn't — e.g. cross-machine cloud
			// sync landed `folder-only` in the folder before this machine
			// pulled the orphan branch. Persisting `freshIndex.entries` from
			// writeStorage via dual-write would overwrite the folder's
			// index.json and delete the synced row. The fix: detect the
			// divergence inside the lock and skip the alias write. Aliases
			// are cross-branch optimization; deferring is safe.
			const orphanIndex = JSON.stringify(
				v3Index([{ ...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"), treeHash: "tree-X" }], {}),
			);
			const folderIndex = JSON.stringify(
				v3Index(
					[
						{ ...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"), treeHash: "tree-X" },
						{
							...rootEntry("folder-only", "Sync-only row", "2026-02-19T10:00:00Z"),
							treeHash: "tree-F",
						},
					],
					{},
				),
			);
			const readStorage: StorageProvider = {
				readFile: vi.fn().mockResolvedValue(folderIndex),
				writeFiles: vi.fn(),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			};
			const writeStorage: StorageProvider = {
				readFile: vi.fn().mockResolvedValue(orphanIndex),
				writeFiles: vi.fn().mockResolvedValue(undefined),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			};
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-X");

			const result = await scanTreeHashAliases(["unknown1"], undefined, writeStorage, readStorage);

			// Deferred — no alias landed, no folder row destroyed.
			expect(result).toBe(false);
			expect(writeStorage.writeFiles).not.toHaveBeenCalled();
		});

		it("falls back to single-storage behavior when readStorage is omitted", async () => {
			// Existing single-storage callers (`storage` only) must continue
			// to work unchanged: both preflight and write flow through that
			// one storage. Without this fallback, CLI surfaces and tests
			// that have never heard of readStorage would regress.
			const indexJson = JSON.stringify(
				v3Index(
					[
						{
							...rootEntry("root1", "Root", "2026-02-18T10:00:00Z"),
							treeHash: "tree-Y",
						},
					],
					{},
				),
			);
			const storage: StorageProvider = {
				readFile: vi.fn().mockResolvedValue(indexJson),
				writeFiles: vi.fn().mockResolvedValue(undefined),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn(),
			};
			vi.mocked(getTreeHash).mockResolvedValueOnce("tree-Y");

			const result = await scanTreeHashAliases(["unknown1"], undefined, storage);

			expect(result).toBe(true);
			expect(storage.readFile).toHaveBeenCalledTimes(2);
			expect(storage.writeFiles).toHaveBeenCalledTimes(1);
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

		describe("deletePlanVisibleArtifact", () => {
			afterEach(() => {
				setActiveStorage(undefined);
			});

			it("delegates to the active storage when it implements deletePlanVisible", async () => {
				const deletePlanVisible = vi.fn().mockResolvedValue(undefined);
				setActiveStorage({
					readFile: vi.fn(),
					writeFiles: vi.fn(),
					listFiles: vi.fn(),
					exists: vi.fn().mockResolvedValue(true),
					ensure: vi.fn(),
					deletePlanVisible,
				} as unknown as StorageProvider);

				await deletePlanVisibleArtifact("my-plan-abc12345", "feature/login");
				expect(deletePlanVisible).toHaveBeenCalledWith("my-plan-abc12345", "feature/login");
			});

			it("is a no-op when the active storage lacks deletePlanVisible (orphan-only mode)", async () => {
				setActiveStorage({
					readFile: vi.fn(),
					writeFiles: vi.fn(),
					listFiles: vi.fn(),
					exists: vi.fn().mockResolvedValue(true),
					ensure: vi.fn(),
				} as unknown as StorageProvider);

				await expect(deletePlanVisibleArtifact("plan-a", "main")).resolves.toBeUndefined();
			});
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

	describe("storeSummary union protection for dual-write readStorage", () => {
		afterEach(() => {
			setActiveStorage(undefined);
		});

		function makeStorage(indexEntries: SummaryIndexEntry[]): StorageProvider {
			const index: SummaryIndex = { version: 3, entries: indexEntries };
			return {
				readFile: vi.fn(async (path: string) => {
					if (path === "index.json") return JSON.stringify(index);
					return null;
				}),
				writeFiles: vi.fn(async () => undefined),
				listFiles: vi.fn(async () => []),
				exists: vi.fn(async () => true),
				ensure: vi.fn(async () => undefined),
			} as unknown as StorageProvider;
		}

		it("preserves rows that exist only on the readStorage when force-writing through a separate writeStorage", async () => {
			// Reviewer scenario: another machine peer-synced an entry into the
			// folder shadow that hasn't reached the orphan branch yet. A
			// force-write through DualWriteStorage previously read the index
			// from orphan-only, then wrote the rebuilt index to BOTH backends,
			// silently dropping the folder-only entry. With readStorage threaded,
			// the union-base includes both sides and the dual-write preserves
			// the folder-only row.
			const writeStorage = makeStorage([rootEntry("orphanonly", "Orphan only")]);
			const readStorage = makeStorage([
				rootEntry("orphanonly", "Orphan only"),
				rootEntry("foldersync", "Folder-only peer sync"),
			]);

			await storeSummary(createMockSummary("newcommit"), undefined, false, undefined, writeStorage, readStorage);

			const writeFilesMock = writeStorage.writeFiles as ReturnType<typeof vi.fn>;
			expect(writeFilesMock).toHaveBeenCalledTimes(1);
			const files = writeFilesMock.mock.calls[0][0] as ReadonlyArray<FileWrite>;
			const indexFile = files.find((f) => f.path === "index.json");
			const newIndex = JSON.parse(indexFile?.content ?? "{}") as SummaryIndex;
			const hashes = newIndex.entries.map((e) => e.commitHash);
			expect(hashes).toContain("orphanonly");
			expect(hashes).toContain("foldersync");
			expect(hashes).toContain("newcommit");
		});

		it("falls back to writeStorage-only loading when readStorage is omitted (callers that don't dual-write)", async () => {
			// QueueWorker and the CLI summarize command don't pass readStorage —
			// they share one storage instance for both paths. The pre-existing
			// behavior must survive: the index is read from the single storage
			// and no union is attempted (so no extra readFile happens against
			// a non-existent shadow).
			const onlyStorage = makeStorage([rootEntry("existing", "Existing")]);

			await storeSummary(createMockSummary("new"), undefined, false, undefined, onlyStorage);

			const writeFilesMock = onlyStorage.writeFiles as ReturnType<typeof vi.fn>;
			expect(writeFilesMock).toHaveBeenCalledTimes(1);
			const files = writeFilesMock.mock.calls[0][0] as ReadonlyArray<FileWrite>;
			const indexFile = files.find((f) => f.path === "index.json");
			const newIndex = JSON.parse(indexFile?.content ?? "{}") as SummaryIndex;
			const hashes = newIndex.entries.map((e) => e.commitHash);
			expect(hashes).toEqual(expect.arrayContaining(["existing", "new"]));
		});

		it("merges commitAliases from both backends, with write-side keys winning on overlap", async () => {
			// Aliases get the same union treatment as entries. Read-side-only
			// aliases (cross-machine tree-hash matches) must survive the
			// rewrite. On the rare collision where both sides hold the same
			// alias key with different target hashes, the write side (orphan,
			// system of record) wins.
			const writeStorage: StorageProvider = {
				readFile: vi.fn(async (path: string) => {
					if (path === "index.json") {
						return JSON.stringify({
							version: 3,
							entries: [rootEntry("a", "A")],
							commitAliases: { sharedKey: "writeTarget" },
						} satisfies SummaryIndex);
					}
					return null;
				}),
				writeFiles: vi.fn(async () => undefined),
				listFiles: vi.fn(async () => []),
				exists: vi.fn(async () => true),
				ensure: vi.fn(async () => undefined),
			} as unknown as StorageProvider;
			const readStorage: StorageProvider = {
				readFile: vi.fn(async (path: string) => {
					if (path === "index.json") {
						return JSON.stringify({
							version: 3,
							entries: [rootEntry("a", "A")],
							commitAliases: {
								sharedKey: "readTarget",
								folderOnlyKey: "folderTarget",
							},
						} satisfies SummaryIndex);
					}
					return null;
				}),
				writeFiles: vi.fn(async () => undefined),
				listFiles: vi.fn(async () => []),
				exists: vi.fn(async () => true),
				ensure: vi.fn(async () => undefined),
			} as unknown as StorageProvider;

			await storeSummary(createMockSummary("new"), undefined, false, undefined, writeStorage, readStorage);

			const files = (writeStorage.writeFiles as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as ReadonlyArray<FileWrite>;
			const newIndex = JSON.parse(files.find((f) => f.path === "index.json")?.content ?? "{}") as SummaryIndex;
			expect(newIndex.commitAliases?.sharedKey).toBe("writeTarget");
			expect(newIndex.commitAliases?.folderOnlyKey).toBe("folderTarget");
		});

		// ── payload backfill for folder-only entries ────────────────────────
		// Union'ing the index alone leaves orphan with index rows that point
		// at `summaries/<hash>.json` files only the folder side actually has.
		// Every orphan-only reader (`getSummary` → `readSummaryFile`,
		// `QueueWorker.loadSourceSummaries`, `SummaryExporter.exportSummaries`)
		// still resolves payloads through the active storage's primary, so a
		// folder-only row whose payload never reached orphan surfaces as a
		// dangling reference. The dual-write must lift those payloads.

		function makeStorageWithFiles(
			indexEntries: SummaryIndexEntry[],
			files: Record<string, string>,
		): StorageProvider {
			const index: SummaryIndex = { version: 3, entries: indexEntries };
			return {
				readFile: vi.fn(async (path: string) => {
					if (path === "index.json") return JSON.stringify(index);
					return files[path] ?? null;
				}),
				writeFiles: vi.fn(async () => undefined),
				listFiles: vi.fn(async () => []),
				exists: vi.fn(async () => true),
				ensure: vi.fn(async () => undefined),
			} as unknown as StorageProvider;
		}

		it("lifts folder-only summary payloads from readStorage into the writeStorage batch", async () => {
			// readStorage holds a peer-synced root entry plus its backing
			// `summaries/<hash>.json` payload. writeStorage (orphan) has not
			// seen this entry yet. After storeSummary, the writeStorage batch
			// must include both the new commit's summary AND the folder-only
			// summary file — otherwise the freshly-unioned orphan index
			// points at a summaries/foldersync.json that doesn't exist on
			// orphan, and `getSummary` (which goes through DualWriteStorage's
			// primary-only readFile) returns null on lookup.
			const folderOnlyPayload = JSON.stringify({
				...createMockSummary("foldersync", "Folder-only peer sync"),
			});
			const writeStorage = makeStorageWithFiles([rootEntry("orphanonly", "Orphan only")], {});
			const readStorage = makeStorageWithFiles(
				[rootEntry("orphanonly", "Orphan only"), rootEntry("foldersync", "Folder-only peer sync")],
				{ "summaries/foldersync.json": folderOnlyPayload },
			);

			await storeSummary(createMockSummary("newcommit"), undefined, false, undefined, writeStorage, readStorage);

			const writeFilesMock = writeStorage.writeFiles as ReturnType<typeof vi.fn>;
			expect(writeFilesMock).toHaveBeenCalledTimes(1);
			const filesWritten = writeFilesMock.mock.calls[0][0] as ReadonlyArray<FileWrite>;
			const paths = filesWritten.map((f) => f.path);
			expect(paths).toContain("summaries/newcommit.json");
			expect(paths).toContain("summaries/foldersync.json");
			// Backfilled payload is the readStorage content verbatim — orphan
			// must end up byte-identical to the folder copy so downstream
			// readers don't diverge based on which backend they hit.
			const backfilled = filesWritten.find((f) => f.path === "summaries/foldersync.json");
			expect(backfilled?.content).toBe(folderOnlyPayload);
		});

		it("lifts folder-only transcripts alongside their summaries", async () => {
			// Transcripts are keyed by the same commitHash as their summary
			// (`transcripts/<hash>.json`). Without backfill, a folder-only
			// entry's transcript is missing on orphan — `readTranscript`
			// (driven through the active storage's primary) returns null
			// and the squash pipeline / sidebar transcript view silently
			// drop data.
			const folderOnlySummary = JSON.stringify(createMockSummary("foldersync", "Folder-only peer sync"));
			const folderOnlyTranscript = JSON.stringify({ sessions: [{ id: "s1", events: [] }] });
			const writeStorage = makeStorageWithFiles([], {});
			const readStorage = makeStorageWithFiles([rootEntry("foldersync", "Folder-only peer sync")], {
				"summaries/foldersync.json": folderOnlySummary,
				"transcripts/foldersync.json": folderOnlyTranscript,
			});

			await storeSummary(createMockSummary("newcommit"), undefined, false, undefined, writeStorage, readStorage);

			const filesWritten = (writeStorage.writeFiles as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as ReadonlyArray<FileWrite>;
			const transcript = filesWritten.find((f) => f.path === "transcripts/foldersync.json");
			expect(transcript?.content).toBe(folderOnlyTranscript);
		});

		it("skips backfill silently when readStorage has the index row but no payload (embedded child case)", async () => {
			// Children of a squash/amend tree live inside the root's
			// `summaries/<rootHash>.json` blob, so the child's own
			// `summaries/<childHash>.json` file may not exist as a separate
			// artifact. The backfill must tolerate a missing payload without
			// emitting a phantom write (which would land empty/`null` content
			// on orphan and corrupt every subsequent direct-read attempt).
			const writeStorage = makeStorageWithFiles([], {});
			const readStorage = makeStorageWithFiles(
				[rootEntry("embeddedchild", "Squashed away")],
				// no summaries/embeddedchild.json, no transcripts/embeddedchild.json
				{},
			);

			await storeSummary(createMockSummary("newcommit"), undefined, false, undefined, writeStorage, readStorage);

			const filesWritten = (writeStorage.writeFiles as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as ReadonlyArray<FileWrite>;
			const paths = filesWritten.map((f) => f.path);
			expect(paths).not.toContain("summaries/embeddedchild.json");
			expect(paths).not.toContain("transcripts/embeddedchild.json");
			// The index still carries the row (union preservation), even
			// though the payload is intentionally absent.
			const newIndex = JSON.parse(
				filesWritten.find((f) => f.path === "index.json")?.content ?? "{}",
			) as SummaryIndex;
			expect(newIndex.entries.map((e) => e.commitHash)).toContain("embeddedchild");
		});

		it("does not double-write the headline summary's payload when the same hash also lives folder-only", async () => {
			// Edge case: user force-writes a commit hash that already exists
			// as a folder-only row (peer-synced). Both the headline write
			// path and the backfill loop would emit `summaries/<hash>.json`,
			// producing two batch entries with the same path. The git tree
			// builder + folder writer would have to pick one and silently
			// drop the other. Skip the backfill probe for the headline's
			// own hash so the batch is uniquely keyed.
			const writeStorage = makeStorageWithFiles([], {});
			const readStorage = makeStorageWithFiles([rootEntry("dupe", "Older folder copy")], {
				"summaries/dupe.json": JSON.stringify(createMockSummary("dupe", "Older folder copy")),
				"transcripts/dupe.json": JSON.stringify({ sessions: [] }),
			});

			await storeSummary(
				createMockSummary("dupe", "Force-rewrite via summarize"),
				undefined,
				true,
				undefined,
				writeStorage,
				readStorage,
			);

			const filesWritten = (writeStorage.writeFiles as ReturnType<typeof vi.fn>).mock
				.calls[0][0] as ReadonlyArray<FileWrite>;
			const dupeSummaryPayloads = filesWritten.filter((f) => f.path === "summaries/dupe.json");
			expect(dupeSummaryPayloads).toHaveLength(1);
			// The single entry that survives is the headline write
			// (fresh summary content), not the stale folder copy.
			const survived = JSON.parse(dupeSummaryPayloads[0].content) as CommitSummary;
			expect(survived.commitMessage).toBe("Force-rewrite via summarize");
		});

		it("does not read backfill paths when readStorage is omitted", async () => {
			// The single-storage callers (QueueWorker, CLI summarize) must
			// not pay extra readFile round-trips for backfill — there's no
			// secondary backend to lift from, and probing the same storage
			// would be wasted IO. Asserts the no-union baseline is untouched.
			const onlyStorage = makeStorageWithFiles([rootEntry("existing", "Existing")], {
				"summaries/existing.json": JSON.stringify(createMockSummary("existing", "Existing")),
			});

			await storeSummary(createMockSummary("new"), undefined, false, undefined, onlyStorage);

			const readFileMock = onlyStorage.readFile as ReturnType<typeof vi.fn>;
			// The only legitimate readFile calls on the single-storage path
			// are `index.json` + catalog probes; no `summaries/existing.json`
			// or `transcripts/existing.json` should be probed for backfill.
			const probedPaths = readFileMock.mock.calls.map((c) => c[0] as string);
			expect(probedPaths).not.toContain("summaries/existing.json");
			expect(probedPaths).not.toContain("transcripts/existing.json");
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

		describe("deleteNoteVisibleArtifact", () => {
			afterEach(() => {
				setActiveStorage(undefined);
			});

			it("delegates to the active storage when it implements deleteNoteVisible", async () => {
				const deleteNoteVisible = vi.fn().mockResolvedValue(undefined);
				setActiveStorage({
					readFile: vi.fn(),
					writeFiles: vi.fn(),
					listFiles: vi.fn(),
					exists: vi.fn().mockResolvedValue(true),
					ensure: vi.fn(),
					deleteNoteVisible,
				} as unknown as StorageProvider);

				await deleteNoteVisibleArtifact("note-42", "main");
				expect(deleteNoteVisible).toHaveBeenCalledWith("note-42", "main");
			});

			it("is a no-op when the active storage lacks deleteNoteVisible", async () => {
				setActiveStorage({
					readFile: vi.fn(),
					writeFiles: vi.fn(),
					listFiles: vi.fn(),
					exists: vi.fn().mockResolvedValue(true),
					ensure: vi.fn(),
				} as unknown as StorageProvider);

				await expect(deleteNoteVisibleArtifact("note-42", "main")).resolves.toBeUndefined();
			});
		});
	});

	describe("storeLinearIssues / readLinearIssueFromBranch", () => {
		it("should write Linear issue files to the orphan branch under linear-issues/<archivedKey>.md", async () => {
			await storeLinearIssues(
				[
					{ archivedKey: "PROJ-1-abc1234", content: "# Issue 1\nbody" },
					{ archivedKey: "PROJ-2-abc1234", content: "# Issue 2\nbody" },
				],
				"Archive linear issues for commit abc1234",
			);

			expect(writeMultipleFilesToBranch).toHaveBeenCalledWith(
				expect.any(String),
				[
					{ path: "linear-issues/PROJ-1-abc1234.md", content: "# Issue 1\nbody" },
					{ path: "linear-issues/PROJ-2-abc1234.md", content: "# Issue 2\nbody" },
				],
				"Archive linear issues for commit abc1234",
				undefined,
			);
		});

		it("should skip writing when linearFiles array is empty", async () => {
			await storeLinearIssues([], "Empty commit");
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
		});

		it("readLinearIssueFromBranch reads markdown content from orphan branch by archivedKey", async () => {
			vi.mocked(readFileFromBranch).mockResolvedValueOnce("# Archived Issue\nContent here");
			await expect(readLinearIssueFromBranch("PROJ-1-abc1234")).resolves.toBe("# Archived Issue\nContent here");
		});

		it("readLinearIssueFromBranch returns null when the orphan branch file is absent", async () => {
			vi.mocked(readFileFromBranch).mockRejectedValueOnce(new Error("ENOENT"));
			await expect(readLinearIssueFromBranch("PROJ-missing")).resolves.toBeNull();
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
			topics: topics.map((t) => ({ title: t, trigger: t, response: t, decisions: "" })),
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
				topics: [{ title: "v4-topic", trigger: "t", response: "r", decisions: "" }],
			};

			const sources = expandSourcesForConsolidation(v4Summary);

			expect(sources).toHaveLength(1);
			expect(sources[0]?.commitHash).toBe("v4abc");
			expect(sources[0]?.topics.map((t) => t.title)).toEqual(["v4-topic"]);
		});

		it("carries ticketId and recap from v4 unified-hoist root onto the source", () => {
			const v4Summary: CommitSummary = {
				version: 4,
				commitHash: "v4withMeta",
				commitMessage: "Squash with meta",
				commitAuthor: "Dev",
				commitDate: "2026-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2026-01-01T00:00:05Z",
				transcriptEntries: 0,
				stats: { filesChanged: 0, insertions: 0, deletions: 0 },
				ticketId: "PROJ-123",
				recap: "The developer added drag-handle reordering.",
				topics: [{ title: "x", trigger: "t", response: "r", decisions: "" }],
			};

			const sources = expandSourcesForConsolidation(v4Summary);

			expect(sources).toHaveLength(1);
			expect(sources[0]?.ticketId).toBe("PROJ-123");
			expect(sources[0]?.recap).toBe("The developer added drag-handle reordering.");
		});

		it("carries ticketId and recap from v3 children onto each source", () => {
			const child1: CommitSummary = {
				...leaf("c1", ["t1"]),
				ticketId: "FEAT-1",
				recap: "Recap for child 1.",
			};
			const child2: CommitSummary = {
				...leaf("c2", ["t2"]),
				// Intentionally no ticketId / recap to exercise the falsy branch
				// of the conditional spreads on lines 458 / 460.
			};
			const root: CommitSummary = {
				...leaf("root", []),
				children: [child1, child2],
			};

			const sources = expandSourcesForConsolidation(root);

			expect(sources).toHaveLength(2);
			expect(sources.find((s) => s.commitHash === "c1")?.ticketId).toBe("FEAT-1");
			expect(sources.find((s) => s.commitHash === "c1")?.recap).toBe("Recap for child 1.");
			expect(sources.find((s) => s.commitHash === "c2")?.ticketId).toBeUndefined();
			expect(sources.find((s) => s.commitHash === "c2")?.recap).toBeUndefined();
		});

		it("appends a legacy v3 amend root carrying its own topics + recap + ticketId as an extra source", () => {
			// v3 amend pattern: the root commit has children (from prior commits) AND
			// its own delta topics/recap/ticketId left behind by the amend operation.
			// Without this branch, the root delta would be silently dropped during squash.
			const child: CommitSummary = leaf("child", ["child-topic"]);
			const amendRoot: CommitSummary = {
				...leaf("amend-root", ["root-delta-topic"]),
				ticketId: "AMEND-9",
				recap: "Recap left on the amend root.",
				children: [child],
			};

			const sources = expandSourcesForConsolidation(amendRoot);

			expect(sources).toHaveLength(2);
			const rootSource = sources.find((s) => s.commitHash === "amend-root");
			expect(rootSource).toBeDefined();
			expect(rootSource?.ticketId).toBe("AMEND-9");
			expect(rootSource?.recap).toBe("Recap left on the amend root.");
			expect(rootSource?.topics.map((t) => t.title)).toEqual(["root-delta-topic"]);
		});

		it("appends a legacy v3 amend root with only recap (no ticketId, no own topics) so the recap survives", () => {
			// Edge case: rootHasOwnData triggers when topics OR recap is present.
			// Without recap on the amend root and no own topics, the branch should
			// NOT trigger and the source list should match children only.
			const child: CommitSummary = leaf("child", ["child-topic"]);
			const recapOnlyRoot: CommitSummary = {
				...leaf("recap-only-root", []),
				recap: "Only a recap here.",
				children: [child],
			};

			const sources = expandSourcesForConsolidation(recapOnlyRoot);

			expect(sources).toHaveLength(2);
			const rootSource = sources.find((s) => s.commitHash === "recap-only-root");
			expect(rootSource?.recap).toBe("Only a recap here.");
			expect(rootSource?.ticketId).toBeUndefined();
		});

		it("handles a legacy v3 amend root where topics is undefined (not [])", () => {
			// rootHasOwnData uses optional chaining `oldSummary.topics?.length`
			// which yields undefined when topics is not set; the `?? 0` fallback
			// then gates on recap. The legacy carry-over also relies on
			// `topics: oldSummary.topics ?? []` to materialise the empty array.
			// This test exercises both nullish-coalesce branches.
			const child: CommitSummary = leaf("child", ["child-topic"]);
			const noTopicsRoot: CommitSummary = {
				version: 3,
				commitHash: "no-topics-root",
				commitMessage: "Amend with only recap",
				commitAuthor: "Dev",
				commitDate: "2026-01-01T00:00:00Z",
				branch: "main",
				generatedAt: "2026-01-01T00:00:05Z",
				transcriptEntries: 0,
				stats: { filesChanged: 0, insertions: 0, deletions: 0 },
				// Intentionally omit `topics` -- exercises optional-chain undefined
				recap: "Recap on a topic-less root.",
				children: [child],
			};

			const sources = expandSourcesForConsolidation(noTopicsRoot);

			expect(sources).toHaveLength(2);
			const rootSource = sources.find((s) => s.commitHash === "no-topics-root");
			expect(rootSource?.topics).toEqual([]);
			expect(rootSource?.recap).toBe("Recap on a topic-less root.");
		});
	});
});
