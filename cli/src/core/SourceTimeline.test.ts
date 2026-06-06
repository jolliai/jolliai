import { beforeEach, describe, expect, it, vi } from "vitest";
import { addProcessed, emptyProcessedSet } from "./ProcessedSourceStore.js";
import { compareSourceRefs, listPendingSources } from "./SourceTimeline.js";
import type { SourceRef } from "./TopicKBTypes.js";

vi.mock("./SummaryStore.js", () => ({
	// resolveStorage is referenced by stores but not by listPendingSources directly;
	// getIndex is what the timeline calls.
	getIndex: vi.fn(),
	resolveStorage: vi.fn(),
}));
vi.mock("./SessionTracker.js", () => ({ loadPlansRegistry: vi.fn() }));
vi.mock("./MemoryBankScanner.js", () => ({ listAllUserKnowledge: vi.fn(), listAllUserKnowledgeFromRoot: vi.fn() }));
vi.mock("./FolderPlanNoteSource.js", () => ({ listFolderPlanNoteRefs: vi.fn() }));
vi.mock("./ReadStorageResolver.js", () => ({ createReadStorage: vi.fn(async () => ({})) }));

import { listFolderPlanNoteRefs } from "./FolderPlanNoteSource.js";
import { FolderStorage } from "./FolderStorage.js";
import { listAllUserKnowledge, listAllUserKnowledgeFromRoot } from "./MemoryBankScanner.js";
import { loadPlansRegistry } from "./SessionTracker.js";
import { getIndex } from "./SummaryStore.js";

const r = (type: SourceRef["type"], id: string, timestamp: string): SourceRef => ({ type, id, timestamp });

/** Real FolderStorage so `readStorage instanceof FolderStorage` resolves a kbRoot; metadata is unused here. */
// biome-ignore lint/suspicious/noExplicitAny: MetadataManager is never touched on the folder-scan path (all loaders mocked)
const folderStorage = (kbRoot: string) => new FolderStorage(kbRoot, {} as any);

describe("compareSourceRefs", () => {
	it("orders by epoch ascending, honoring timezone offsets", () => {
		// 2026-01-01T08:00:00+08:00 === 2026-01-01T00:00:00Z (same instant);
		// the +09:00 one is one hour EARLIER in epoch despite a later wall-clock string.
		const utc = r("summary", "a", "2026-01-01T00:00:00Z");
		const earlier = r("summary", "b", "2026-01-01T08:00:00+09:00"); // = 2025-12-31T23:00:00Z
		expect(compareSourceRefs(earlier, utc)).toBeLessThan(0);
		expect([utc, earlier].sort(compareSourceRefs).map((x) => x.id)).toEqual(["b", "a"]);
	});

	it("breaks equal-instant ties by type rank then id", () => {
		const t = "2026-01-01T00:00:00Z";
		const refs = [r("userfile", "z", t), r("summary", "b", t), r("summary", "a", t), r("note", "m", t)];
		expect(refs.sort(compareSourceRefs).map((x) => `${x.type}:${x.id}`)).toEqual([
			"summary:a",
			"summary:b",
			"note:m",
			"userfile:z",
		]);
	});

	it("sorts unparseable timestamps deterministically after valid ones", () => {
		const valid = r("summary", "a", "2026-01-01T00:00:00Z");
		const bad = r("summary", "b", "not-a-date");
		expect(compareSourceRefs(valid, bad)).toBeLessThan(0);
		expect(compareSourceRefs(bad, valid)).toBeGreaterThan(0);
		// two bad timestamps fall through to type/id tie-break
		const bad2 = r("plan", "a", "also-bad");
		expect(compareSourceRefs(bad, bad2)).toBeLessThan(0); // summary < plan
	});

	it("breaks two-NaN same-type ties by id", () => {
		const a = r("summary", "a", "garbage");
		const b = r("summary", "b", "rubbish");
		expect(compareSourceRefs(a, b)).toBeLessThan(0);
		expect(compareSourceRefs(b, a)).toBeGreaterThan(0);
		expect(compareSourceRefs(a, a)).toBe(0);
	});
});

describe("listPendingSources", () => {
	beforeEach(() => {
		vi.mocked(getIndex).mockReset();
		vi.mocked(loadPlansRegistry).mockReset();
		vi.mocked(listAllUserKnowledge).mockReset();
	});

	it("merges all four streams, filters processed, sorts old→new", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{ commitHash: "c2", commitDate: "2026-01-03T00:00:00Z", branch: "main", parentCommitHash: null },
				{ commitHash: "c1", commitDate: "2026-01-01T00:00:00Z", branch: "main", parentCommitHash: null },
				// child entry (non-root) must be ignored:
				{ commitHash: "c1a", commitDate: "2026-01-01T01:00:00Z", branch: "main", parentCommitHash: "c1" },
			],
			// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		} as any);
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"claude:p1": {
					slug: "p1",
					title: "P",
					updatedAt: "2026-01-02T00:00:00Z",
					branch: "main",
					commitHash: null,
					addedAt: "x",
					sourcePath: "x",
				},
			},
			notes: {
				n1: {
					id: "n1",
					title: "N",
					format: "markdown",
					updatedAt: "2026-01-04T00:00:00Z",
					branch: "main",
					commitHash: null,
					addedAt: "x",
				},
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal registry stub for test
		} as any);
		vi.mocked(listAllUserKnowledge).mockResolvedValue([
			// biome-ignore lint/suspicious/noExplicitAny: minimal user-file stub for test
			{ path: "u.md", fingerprint: "ff", mtime: "2026-01-05T00:00:00Z", scope: "repo" } as any,
		]);

		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		expect(pending.map((p) => `${p.type}:${p.id}`)).toEqual([
			"summary:c1", // 01-01
			"plan:p1", // 01-02
			"summary:c2", // 01-03
			"note:n1", // 01-04
			"userfile:u.md@ff", // 01-05
		]);
	});

	it("carries the originating branch on summary refs; orphan-mode plan/note + userfiles have none", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{
					commitHash: "c1",
					commitDate: "2026-01-01T00:00:00Z",
					branch: "signin-oauth-code",
					parentCommitHash: null,
				},
			],
			// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		} as any);
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"claude:p1": {
					slug: "p1",
					title: "P",
					updatedAt: "2026-01-02T00:00:00Z",
					commitHash: null,
					addedAt: "x",
					sourcePath: "x",
				},
			},
			notes: {
				n1: {
					id: "n1",
					title: "N",
					format: "markdown",
					updatedAt: "2026-01-03T00:00:00Z",
					commitHash: null,
					addedAt: "x",
				},
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal registry stub for test
		} as any);
		vi.mocked(listAllUserKnowledge).mockResolvedValue([
			// biome-ignore lint/suspicious/noExplicitAny: minimal user-file stub for test
			{ path: "u.md", fingerprint: "ff", mtime: "2026-01-05T00:00:00Z", scope: "repo" } as any,
		]);

		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		const branchById = Object.fromEntries(pending.map((p) => [`${p.type}:${p.id}`, p.branch]));
		expect(branchById["summary:c1"]).toBe("signin-oauth-code");
		// Orphan-mode plan/note refs carry no branch: `branch` was stripped from
		// PlanEntry/NoteEntry by the 2026-06-01 migration. (Folder mode still
		// derives branch from the visible path — covered by FolderPlanNoteSource.)
		expect(branchById["plan:p1"]).toBeUndefined();
		expect(branchById["note:n1"]).toBeUndefined();
		// userfiles are repo/global knowledge, not branch-scoped -> no branch.
		expect(branchById["userfile:u.md@ff"]).toBeUndefined();
	});

	it("treats a registry with no `notes` key as empty (orphan mode)", async () => {
		// notes omitted entirely → exercises the `registry.notes ?? {}` fallback.
		vi.mocked(getIndex).mockResolvedValue(null);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		vi.mocked(listAllUserKnowledge).mockResolvedValue([]);
		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		expect(pending.filter((p) => p.type === "note")).toEqual([]);
	});

	it("treats an entry with an absent parentCommitHash as a root summary", async () => {
		// parentCommitHash omitted entirely → exercises the `=== undefined` arm of
		// the root-commit predicate (the `=== null` arm short-circuits otherwise).
		vi.mocked(getIndex).mockResolvedValue({
			entries: [{ commitHash: "c1", commitDate: "2026-01-01T00:00:00Z", branch: "main" }],
			// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		} as any);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		vi.mocked(listAllUserKnowledge).mockResolvedValue([]);
		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		expect(pending.map((p) => p.id)).toEqual(["c1"]);
	});

	it("excludes already-processed refs", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			entries: [{ commitHash: "c1", commitDate: "2026-01-01T00:00:00Z", branch: "main", parentCommitHash: null }],
			// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		} as any);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		vi.mocked(listAllUserKnowledge).mockResolvedValue([]);

		const processed = addProcessed(emptyProcessedSet(), [
			{ type: "summary", id: "c1", timestamp: "2026-01-01T00:00:00Z" },
		]);
		const pending = await listPendingSources("/tmp/x", processed);
		expect(pending).toEqual([]);
	});

	it("dedupes user files returned more than once by path@fingerprint", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{ commitHash: "c1", commitDate: "2026-01-01T00:00:00Z", branch: "main", parentCommitHash: null },
				{ commitHash: "c2", commitDate: "2026-01-02T00:00:00Z", branch: "feat", parentCommitHash: null },
			],
			// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		} as any);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		// Same file id surfaced twice in the single disk-driven scan → dedupe to one.
		vi.mocked(listAllUserKnowledge).mockResolvedValue([
			// biome-ignore lint/suspicious/noExplicitAny: minimal user-file stub for test
			{ path: "g.md", fingerprint: "aa", mtime: "2026-01-03T00:00:00Z", scope: "global" } as any,
			// biome-ignore lint/suspicious/noExplicitAny: minimal user-file stub for test
			{ path: "g.md", fingerprint: "aa", mtime: "2026-01-03T00:00:00Z", scope: "global" } as any,
		]);

		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		const userFiles = pending.filter((p) => p.type === "userfile");
		expect(userFiles).toEqual([{ type: "userfile", id: "g.md@aa", timestamp: "2026-01-03T00:00:00Z" }]);
		// Disk-driven: one scan total (not one per index branch).
		expect(vi.mocked(listAllUserKnowledge).mock.calls.length).toBe(1);
	});

	it("handles a missing index (null) without throwing", async () => {
		vi.mocked(getIndex).mockResolvedValue(null);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		vi.mocked(listAllUserKnowledge).mockResolvedValue([]);
		// User files no longer depend on the index — a single disk-driven scan runs.
		const pending = await listPendingSources("/tmp/x", emptyProcessedSet());
		expect(pending).toEqual([]);
		expect(vi.mocked(listAllUserKnowledge).mock.calls.length).toBe(1);
		expect(vi.mocked(listAllUserKnowledge).mock.calls[0][0]).toBe("/tmp/x");
	});

	it("enumerates branch-scoped user files even with an empty summary index (folder mode)", async () => {
		// Regression: index-driven branch enumeration skipped branch folders that had
		// no summary yet. Disk-driven scan must still surface them.
		vi.mocked(getIndex).mockResolvedValue(null);
		vi.mocked(listFolderPlanNoteRefs).mockResolvedValue([]);
		vi.mocked(listAllUserKnowledgeFromRoot).mockResolvedValue([
			{
				path: "jolliai/feat/n.md",
				absolutePath: "/kb/root/feat/n.md",
				fingerprint: "bb",
				mtime: "2026-01-06T00:00:00Z",
				scope: "branch",
				branch: "feat",
				content: "note body",
			},
		]);

		const pending = await listPendingSources("/tmp/x", emptyProcessedSet(), folderStorage("/kb/root"));
		expect(pending.map((p) => `${p.type}:${p.id}`)).toEqual(["userfile:jolliai/feat/n.md@bb"]);
		expect(vi.mocked(listAllUserKnowledgeFromRoot)).toHaveBeenCalledWith("/kb/root");
	});

	it("reads plan/note from the folder source and scans userfiles by kbRoot when storage is FolderStorage", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			entries: [{ commitHash: "c1", commitDate: "2026-01-01T00:00:00Z", branch: "feat", parentCommitHash: null }],
			// biome-ignore lint/suspicious/noExplicitAny: minimal index stub for test
		} as any);
		// Folder mode: plan/note come from listFolderPlanNoteRefs (carrying branch), NOT the registry.
		vi.mocked(listFolderPlanNoteRefs).mockResolvedValue([
			{ type: "plan", id: "p1", timestamp: "2026-01-02T00:00:00Z", branch: "feat" },
			{ type: "note", id: "n1", timestamp: "2026-01-04T00:00:00Z", branch: "feat" },
		]);
		vi.mocked(listAllUserKnowledgeFromRoot).mockResolvedValue([
			// biome-ignore lint/suspicious/noExplicitAny: minimal user-file stub for test
			{ path: "u.md", fingerprint: "ff", mtime: "2026-01-05T00:00:00Z", scope: "repo" } as any,
		]);

		const pending = await listPendingSources("/tmp/x", emptyProcessedSet(), folderStorage("/kb/root"));
		expect(pending.map((p) => `${p.type}:${p.id}`)).toEqual([
			"summary:c1",
			"plan:p1",
			"note:n1",
			"userfile:u.md@ff",
		]);
		// Folder mode keeps plan/note branch derived from the visible path.
		const byId = Object.fromEntries(pending.map((p) => [p.id, p.branch]));
		expect(byId.p1).toBe("feat");
		expect(byId.n1).toBe("feat");
		// Folder loaders are used; the orphan registry / cwd scanner are bypassed.
		expect(vi.mocked(listFolderPlanNoteRefs)).toHaveBeenCalledWith("/kb/root");
		expect(vi.mocked(listAllUserKnowledgeFromRoot)).toHaveBeenCalledWith("/kb/root");
		expect(vi.mocked(loadPlansRegistry)).not.toHaveBeenCalled();
		expect(vi.mocked(listAllUserKnowledge)).not.toHaveBeenCalled();
	});
});
