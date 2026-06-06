import { describe, expect, it, vi } from "vitest";

vi.mock("./SummaryStore.js", () => ({ getSummary: vi.fn() }));
vi.mock("./SessionTracker.js", () => ({ loadPlansRegistry: vi.fn() }));
vi.mock("./MemoryBankScanner.js", () => ({ listAllUserKnowledge: vi.fn(), listAllUserKnowledgeFromRoot: vi.fn() }));
vi.mock("./FolderPlanNoteSource.js", () => ({
	loadFolderPlanNoteContent: vi.fn(),
	loadFolderPlanNoteHeadline: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

import { readFile } from "node:fs/promises";
import { loadFolderPlanNoteContent, loadFolderPlanNoteHeadline } from "./FolderPlanNoteSource.js";
import { FolderStorage } from "./FolderStorage.js";
import { listAllUserKnowledge, listAllUserKnowledgeFromRoot } from "./MemoryBankScanner.js";
import { loadPlansRegistry } from "./SessionTracker.js";
import { loadSourceContent, loadSourceHeadline } from "./SourceContent.js";
import { getSummary } from "./SummaryStore.js";
import type { SourceRef } from "./TopicKBTypes.js";

const ref = (type: SourceRef["type"], id: string): SourceRef => ({ type, id, timestamp: "2026-01-01T00:00:00Z" });

/** Real FolderStorage so `storage instanceof FolderStorage` passes; metadata is unused on these paths. */
// biome-ignore lint/suspicious/noExplicitAny: MetadataManager is never touched by the folder-mode loaders (all mocked)
const folderStorage = (kbRoot: string) => new FolderStorage(kbRoot, {} as any);

describe("loadSourceContent", () => {
	it("formats a summary via getSummary", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal CommitSummary stub
		const stub: any = {
			commitHash: "abc12345",
			commitMessage: "Add auth",
			commitDate: "2026-01-01T00:00:00Z",
			records: [],
		};
		vi.mocked(getSummary).mockResolvedValue(stub);
		const body = await loadSourceContent(ref("summary", "abc12345"), "/tmp/x");
		expect(body).toContain("abc12345");
		expect(body).toContain("Add auth");
	});

	it("reads a plan body from its sourcePath", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal PlanEntry stub
		const planEntry: any = {
			slug: "p1",
			title: "Plan",
			sourcePath: "/abs/p1.md",
			updatedAt: "x",
			commitHash: null,
			addedAt: "x",
		};
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: { "c:p1": planEntry },
			notes: {},
		});
		vi.mocked(readFile).mockResolvedValue("# Plan body");
		const body = await loadSourceContent(ref("plan", "p1"), "/tmp/x");
		expect(body).toContain("# Plan body");
		expect(vi.mocked(readFile)).toHaveBeenCalledWith("/abs/p1.md", "utf-8");
	});

	it("returns null when a plan id is unknown", async () => {
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		expect(await loadSourceContent(ref("plan", "gone"), "/tmp/x")).toBeNull();
	});

	it("returns null when the summary has vanished", async () => {
		vi.mocked(getSummary).mockResolvedValue(null);
		expect(await loadSourceContent(ref("summary", "gone"), "/tmp/x")).toBeNull();
	});

	it("threads the read-side storage into getSummary so summaries read the same view as plans/notes", async () => {
		vi.mocked(getSummary).mockResolvedValue(null);
		const storage = folderStorage("/kb/root");
		await loadSourceContent(ref("summary", "abc12345"), "/tmp/x", storage);
		expect(vi.mocked(getSummary)).toHaveBeenCalledWith("abc12345", "/tmp/x", storage);
	});

	it("treats a registry with no `notes` key as empty", async () => {
		// notes omitted entirely -> exercises the `registry.notes ?? {}` fallback.
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		expect(await loadSourceContent(ref("note", "n1"), "/tmp/x")).toBeNull();
	});

	it("decodes a userfile id that has no '@' as path-only (empty fingerprint)", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal UserKnowledgeFile stub
		const uf: any = { path: "plain.md", fingerprint: "", mtime: "x", scope: "repo", content: "plain body" };
		vi.mocked(listAllUserKnowledge).mockResolvedValue([uf]);
		expect(await loadSourceContent(ref("userfile", "plain.md"), "/tmp/x")).toBe("plain body");
	});

	it("returns the userfile content matched by path@fingerprint", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal UserKnowledgeFile stub
		const uf: any = { path: "u.md", fingerprint: "ff", mtime: "x", scope: "repo", content: "hello" };
		vi.mocked(listAllUserKnowledge).mockResolvedValue([uf]);
		expect(await loadSourceContent(ref("userfile", "u.md@ff"), "/tmp/x")).toBe("hello");
	});

	it("returns null when a userfile fingerprint no longer matches", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal UserKnowledgeFile stub
		const uf: any = { path: "u.md", fingerprint: "NEW", mtime: "x", scope: "repo", content: "hello" };
		vi.mocked(listAllUserKnowledge).mockResolvedValue([uf]);
		expect(await loadSourceContent(ref("userfile", "u.md@ff"), "/tmp/x")).toBeNull();
	});

	it("folder mode: reads the single userfile directly (no whole-vault scan) and matches fingerprint", async () => {
		const { createHash } = await import("node:crypto");
		const content = "user note body";
		const fp = createHash("sha256").update(content, "utf-8").digest("hex");
		vi.mocked(readFile).mockResolvedValue(content);

		const storage = folderStorage("/mb/jolli");
		const result = await loadSourceContent(ref("userfile", `notes/a.md@${fp}`), "/tmp/x", storage);

		expect(result).toBe(content);
		// Reads the one named file at <dirname(kbRoot)>/<path>, not a vault scan.
		expect(vi.mocked(readFile)).toHaveBeenCalledWith("/mb/notes/a.md", "utf-8");
		expect(vi.mocked(listAllUserKnowledgeFromRoot)).not.toHaveBeenCalled();
	});

	it("folder mode: returns null when the file's hash no longer matches the ref fingerprint", async () => {
		vi.mocked(readFile).mockResolvedValue("changed content");
		const storage = folderStorage("/mb/jolli");
		const result = await loadSourceContent(ref("userfile", "notes/a.md@deadbeef"), "/tmp/x", storage);
		expect(result).toBeNull();
		expect(vi.mocked(listAllUserKnowledgeFromRoot)).not.toHaveBeenCalled();
	});

	it("folder mode: returns null when the userfile has vanished", async () => {
		vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
		const storage = folderStorage("/mb/jolli");
		const result = await loadSourceContent(ref("userfile", "notes/gone.md@ff"), "/tmp/x", storage);
		expect(result).toBeNull();
	});

	it("reads a note body from its sourcePath", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal NoteEntry stub
		const noteEntry: any = {
			id: "n1",
			title: "Note",
			format: "markdown",
			sourcePath: "/abs/notes/n1.md",
			updatedAt: "2026-01-02T00:00:00Z",
			commitHash: null,
			addedAt: "x",
		};
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: { n1: noteEntry } });
		vi.mocked(readFile).mockResolvedValue("note text");
		const body = await loadSourceContent(ref("note", "n1"), "/tmp/x");
		expect(body).toBe("note text");
		expect(vi.mocked(readFile)).toHaveBeenCalledWith("/abs/notes/n1.md", "utf-8");
	});

	it("returns null when a note id is unknown or has no sourcePath", async () => {
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		expect(await loadSourceContent(ref("note", "gone"), "/tmp/x")).toBeNull();
	});

	it("returns null (not throw) when the plan's sourcePath cannot be read", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal PlanEntry stub
		const planEntry: any = {
			slug: "p1",
			title: "Plan",
			sourcePath: "/abs/missing.md",
			updatedAt: "x",
			commitHash: null,
			addedAt: "x",
		};
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: { "c:p1": planEntry }, notes: {} });
		vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
		expect(await loadSourceContent(ref("plan", "p1"), "/tmp/x")).toBeNull();
	});

	it("reads plan/note content from the Memory Bank folder when storage is FolderStorage", async () => {
		vi.mocked(loadFolderPlanNoteContent).mockResolvedValueOnce("plan body").mockResolvedValueOnce("note body");
		const storage = folderStorage("/kb/root");
		expect(await loadSourceContent(ref("plan", "p1"), "/tmp/x", storage)).toBe("plan body");
		expect(await loadSourceContent(ref("note", "n1"), "/tmp/x", storage)).toBe("note body");
		expect(vi.mocked(loadFolderPlanNoteContent)).toHaveBeenCalledWith(
			"/kb/root",
			expect.objectContaining({ id: "p1" }),
		);
		// Folder path never falls back to the working-repo registry.
		expect(vi.mocked(loadPlansRegistry)).not.toHaveBeenCalled();
	});
});

describe("loadSourceHeadline", () => {
	it("builds a one-line headline for a plan", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal PlanEntry stub
		const planEntry: any = {
			slug: "p1",
			title: "My Plan",
			sourcePath: "/abs/p1.md",
			updatedAt: "2026-01-02T00:00:00Z",
			commitHash: null,
			addedAt: "x",
		};
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: { "c:p1": planEntry },
			notes: {},
		});
		// Title comes from the registry entry; branch now comes from the SourceRef
		// (registry entries no longer carry branch — see SourceTimeline migration note).
		const h = await loadSourceHeadline({ ...ref("plan", "p1"), branch: "main" }, "/tmp/x");
		expect(h).toContain("My Plan");
		expect(h).toContain("main");
	});

	it("builds a one-line headline for a note", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal NoteEntry stub
		const noteEntry: any = {
			id: "n1",
			title: "My Note",
			format: "markdown",
			updatedAt: "2026-01-02T00:00:00Z",
			commitHash: null,
			addedAt: "x",
		};
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: { n1: noteEntry } });
		const h = await loadSourceHeadline({ ...ref("note", "n1"), branch: "feat" }, "/tmp/x");
		expect(h).toContain("My Note");
		expect(h).toContain("feat");
	});

	it("builds a summary headline from commitMessage + branch", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal CommitSummary stub
		const summary: any = { commitHash: "abc12345", commitMessage: "Add auth", branch: "signin-oauth" };
		vi.mocked(getSummary).mockResolvedValue(summary);
		const h = await loadSourceHeadline(ref("summary", "abc12345"), "/tmp/x");
		expect(h).toContain("Add auth");
		expect(h).toContain("signin-oauth");
	});

	it("falls back to ref.id + '?' branch when the summary is missing", async () => {
		vi.mocked(getSummary).mockResolvedValue(null);
		const h = await loadSourceHeadline(ref("summary", "deadbeef"), "/tmp/x");
		expect(h).toContain("deadbeef");
		expect(h).toContain("?");
	});

	it("threads the read-side storage into getSummary for the headline path too", async () => {
		vi.mocked(getSummary).mockResolvedValue(null);
		const storage = folderStorage("/kb/root");
		await loadSourceHeadline(ref("summary", "deadbeef"), "/tmp/x", storage);
		expect(vi.mocked(getSummary)).toHaveBeenCalledWith("deadbeef", "/tmp/x", storage);
	});

	it("collapses a multi-line commit message into a single-line headline", async () => {
		// A commit body (subject\n\nbody) must not leak newlines: the route prompt
		// joins headlines with `[i] ...`.join("\n"), so a multi-line headline would
		// break the ordinal-per-line map the route LLM indexes into.
		// biome-ignore lint/suspicious/noExplicitAny: minimal CommitSummary stub
		const summary: any = {
			commitHash: "abc12345",
			commitMessage: "Add auth\n\nLong body line one.\nLong body line two.",
			branch: "main",
		};
		vi.mocked(getSummary).mockResolvedValue(summary);
		const h = await loadSourceHeadline(ref("summary", "abc12345"), "/tmp/x");
		expect(h).not.toContain("\n");
		expect(h).toContain("Add auth");
	});

	it("builds a userfile headline from the decoded path", async () => {
		const h = await loadSourceHeadline(ref("userfile", "docs/u.md@ff"), "/tmp/x");
		expect(h).toContain("userfile");
		expect(h).toContain("docs/u.md");
	});

	it("uses '?' branch and ref.id title for an orphan plan with no SourceRef branch", async () => {
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, notes: {} });
		const h = await loadSourceHeadline(ref("plan", "p-unknown"), "/tmp/x");
		expect(h).toContain("p-unknown");
		expect(h).toContain("?");
	});

	it("uses '?' branch and ref.id title for an orphan note absent from a notes-less registry", async () => {
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		const h = await loadSourceHeadline(ref("note", "n-unknown"), "/tmp/x");
		expect(h).toContain("n-unknown");
		expect(h).toContain("?");
	});

	it("delegates plan/note headlines to the folder source when storage is FolderStorage", async () => {
		vi.mocked(loadFolderPlanNoteHeadline)
			.mockResolvedValueOnce("(plan, feat, t) Folder Plan")
			.mockResolvedValueOnce("(note, feat, t) Folder Note");
		const storage = folderStorage("/kb/root");
		expect(await loadSourceHeadline(ref("plan", "p1"), "/tmp/x", storage)).toBe("(plan, feat, t) Folder Plan");
		expect(await loadSourceHeadline(ref("note", "n1"), "/tmp/x", storage)).toBe("(note, feat, t) Folder Note");
		expect(vi.mocked(loadFolderPlanNoteHeadline)).toHaveBeenCalledWith(
			"/kb/root",
			expect.objectContaining({ id: "n1" }),
		);
		expect(vi.mocked(loadPlansRegistry)).not.toHaveBeenCalled();
	});
});
