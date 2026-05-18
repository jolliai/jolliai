import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadFile, mockWriteFile, mockMkdir, mockRename } = vi.hoisted(() => ({
	mockReadFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
	mockWriteFile: vi.fn<(path: string, data: string, encoding: string) => Promise<void>>(),
	mockMkdir: vi.fn<(path: string, opts: object) => Promise<void>>(),
	mockRename: vi.fn<(oldPath: string, newPath: string) => Promise<void>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: mockReadFile,
		writeFile: mockWriteFile,
		mkdir: mockMkdir,
		rename: mockRename,
	};
});

import type { LinearIssueRef } from "../Types.js";
import {
	hashLinearIssueContent,
	hashLinearIssueContentFromMarkdown,
	linearIssueDir,
	linearIssuePath,
	readLinearIssueMarkdown,
	renameLinearIssueMarkdown,
	writeLinearIssueMarkdown,
} from "./LinearIssueStore.js";

const CWD = "/repo";

function makeRef(overrides: Partial<LinearIssueRef> = {}): LinearIssueRef {
	return {
		ticketId: "PROJ-1528",
		title: "Treat referenced Linear issues",
		url: "https://linear.app/jolliai/issue/PROJ-1528/",
		status: "In Progress",
		priority: "No priority",
		labels: ["JolliMemory", "Feature"],
		description: "## Problem\n\nLinear issues are high-density context.",
		toolName: "mcp__linear__get_issue",
		referencedAt: "2026-05-14T06:06:01.123Z",
		...overrides,
	};
}

beforeEach(() => {
	mockReadFile.mockReset();
	mockWriteFile.mockReset();
	mockMkdir.mockReset();
	mockRename.mockReset();
	mockMkdir.mockResolvedValue(undefined);
	mockWriteFile.mockResolvedValue(undefined);
	mockRename.mockResolvedValue(undefined);
});

describe("linearIssueDir / linearIssuePath", () => {
	it("returns the canonical absolute directory and path", () => {
		expect(linearIssueDir(CWD)).toBe(join(CWD, ".jolli", "jollimemory", "linear-issues"));
		expect(linearIssuePath("PROJ-1528", CWD)).toBe(
			join(CWD, ".jolli", "jollimemory", "linear-issues", "PROJ-1528.md"),
		);
	});
});

describe("writeLinearIssueMarkdown", () => {
	it("writes the file under the canonical path with frontmatter + body", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));

		const { sourcePath, contentHash } = await writeLinearIssueMarkdown(makeRef(), CWD);

		expect(sourcePath).toBe(linearIssuePath("PROJ-1528", CWD));
		expect(contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(mockMkdir).toHaveBeenCalledWith(linearIssueDir(CWD), expect.objectContaining({ recursive: true }));
		expect(mockWriteFile).toHaveBeenCalledOnce();
		const writtenContent = mockWriteFile.mock.calls[0][1];
		expect(writtenContent).toContain("---");
		expect(writtenContent).toContain('ticketId: "PROJ-1528"');
		expect(writtenContent).toContain('"Treat referenced Linear issues"');
		expect(writtenContent).toContain("## Problem");
		expect(writtenContent).toContain("Linear issues are high-density");
	});

	it("is idempotent: skips fs.writeFile when existing content matches", async () => {
		// First write to capture the canonical content
		mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
		await writeLinearIssueMarkdown(makeRef(), CWD);
		const writtenContent = mockWriteFile.mock.calls[0][1];

		// Reset write mock, set read mock to return the previously written content
		mockWriteFile.mockClear();
		mockReadFile.mockResolvedValue(writtenContent);

		// Second write with identical ref → no fs.writeFile
		await writeLinearIssueMarkdown(makeRef(), CWD);
		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	it("writes again when content differs (e.g. Linear payload changed)", async () => {
		mockReadFile.mockResolvedValue('---\nticketId: "PROJ-1528"\n---\nOLD BODY\n');
		await writeLinearIssueMarkdown(makeRef(), CWD);
		expect(mockWriteFile).toHaveBeenCalledOnce();
	});

	it("includes labels array in YAML list form", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		await writeLinearIssueMarkdown(makeRef({ labels: ["A", "B", "C"] }), CWD);
		const content = mockWriteFile.mock.calls[0][1];
		expect(content).toMatch(/labels:\s*\n\s+- "A"\s*\n\s+- "B"\s*\n\s+- "C"/);
	});

	it("omits optional fields when undefined", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		await writeLinearIssueMarkdown(
			makeRef({ status: undefined, priority: undefined, labels: undefined, description: undefined }),
			CWD,
		);
		const content = mockWriteFile.mock.calls[0][1];
		expect(content).not.toContain("status:");
		expect(content).not.toContain("priority:");
		expect(content).not.toContain("labels:");
	});

	it("escapes special characters in title and description via JSON encoding", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		await writeLinearIssueMarkdown(
			makeRef({
				title: `Edge "case" with : colon and \\ backslash`,
				description: "Body with `code` and\nnewlines",
			}),
			CWD,
		);
		const content = mockWriteFile.mock.calls[0][1];
		// JSON.stringify handles all escaping
		expect(content).toContain('title: "Edge \\"case\\" with : colon and \\\\ backslash"');
		expect(content).toContain("Body with `code` and\nnewlines");
	});
});

describe("readLinearIssueMarkdown", () => {
	async function roundtrip(ref: LinearIssueRef): Promise<LinearIssueRef | null> {
		mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));
		await writeLinearIssueMarkdown(ref, CWD);
		const written = mockWriteFile.mock.calls[0][1];
		mockReadFile.mockReset();
		mockReadFile.mockResolvedValue(written);
		return readLinearIssueMarkdown(linearIssuePath(ref.ticketId, CWD));
	}

	it("round-trips a fully populated ref", async () => {
		const original = makeRef();
		const got = await roundtrip(original);
		expect(got).toMatchObject({
			ticketId: original.ticketId,
			title: original.title,
			url: original.url,
			status: original.status,
			priority: original.priority,
			labels: original.labels,
			description: original.description,
			toolName: original.toolName,
			referencedAt: original.referencedAt,
		});
	});

	it("round-trips a minimal ref (no optional fields)", async () => {
		const minimal = makeRef({
			status: undefined,
			priority: undefined,
			labels: undefined,
			description: undefined,
		});
		const got = await roundtrip(minimal);
		expect(got?.ticketId).toBe(minimal.ticketId);
		expect(got?.status).toBeUndefined();
		expect(got?.priority).toBeUndefined();
		expect(got?.labels).toBeUndefined();
		expect(got?.description).toBeUndefined();
	});

	it("preserves SUMMARIZE sentinel strings (===SUMMARY===) in the body verbatim", async () => {
		const got = await roundtrip(makeRef({ description: "Body contains ===SUMMARY=== as literal text." }));
		expect(got?.description).toContain("===SUMMARY===");
	});

	it("returns null when the file does not exist", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		const got = await readLinearIssueMarkdown("/nope.md");
		expect(got).toBeNull();
	});

	it("returns null when the frontmatter delimiter is missing", async () => {
		mockReadFile.mockResolvedValue("no frontmatter\njust body\n");
		const got = await readLinearIssueMarkdown("/x.md");
		expect(got).toBeNull();
	});

	it("returns null when the file is missing the required ticketId field", async () => {
		mockReadFile.mockResolvedValue(
			'---\ntitle: "x"\nurl: "https://x"\nreferencedAt: "2026-01-01T00:00:00Z"\nsourceToolName: "mcp__linear__get_issue"\n---\nbody\n',
		);
		const got = await readLinearIssueMarkdown("/x.md");
		expect(got).toBeNull();
	});

	it("returns null when a required field value fails JSON.parse", async () => {
		mockReadFile.mockResolvedValue('---\nticketId: "PROJ-1\nbroken\n---\nbody\n');
		const got = await readLinearIssueMarkdown("/x.md");
		expect(got).toBeNull();
	});

	it("handles missing labels list cleanly (no labels: header)", async () => {
		mockReadFile.mockResolvedValue(
			'---\nticketId: "PROJ-1"\ntitle: "t"\nurl: "https://x/PROJ-1"\nreferencedAt: "2026-01-01T00:00:00Z"\nsourceToolName: "mcp__linear__get_issue"\n---\nbody\n',
		);
		const got = await readLinearIssueMarkdown("/x.md");
		expect(got?.labels).toBeUndefined();
	});

	it("returns null when a label list item is not valid JSON-encoded string", async () => {
		mockReadFile.mockResolvedValue(
			'---\nticketId: "PROJ-1"\ntitle: "t"\nurl: "https://x/PROJ-1"\nlabels:\n  - bare-not-quoted\nreferencedAt: "2026-01-01T00:00:00Z"\nsourceToolName: "mcp__linear__get_issue"\n---\nbody\n',
		);
		const got = await readLinearIssueMarkdown("/x.md");
		expect(got).toBeNull();
	});

	it("ignores labels: header followed by zero list items", async () => {
		mockReadFile.mockResolvedValue(
			'---\nticketId: "PROJ-1"\ntitle: "t"\nurl: "https://x/PROJ-1"\nlabels:\nreferencedAt: "2026-01-01T00:00:00Z"\nsourceToolName: "mcp__linear__get_issue"\n---\nbody\n',
		);
		const got = await readLinearIssueMarkdown("/x.md");
		expect(got?.labels).toBeUndefined();
	});
});

describe("hashLinearIssueContent", () => {
	it("produces stable 64-char hex hash", () => {
		const h = hashLinearIssueContent(makeRef());
		expect(h).toMatch(/^[a-f0-9]{64}$/);
		// Same ref → same hash
		expect(hashLinearIssueContent(makeRef())).toBe(h);
	});

	it("changes when any field changes (status / labels / description)", () => {
		const base = hashLinearIssueContent(makeRef());
		expect(hashLinearIssueContent(makeRef({ status: "Done" }))).not.toBe(base);
		expect(hashLinearIssueContent(makeRef({ description: "different" }))).not.toBe(base);
		expect(hashLinearIssueContent(makeRef({ labels: ["X"] }))).not.toBe(base);
	});

	it("does not depend on referencedAt (a pure re-reference must not flip the guard)", () => {
		const a = hashLinearIssueContent(makeRef({ referencedAt: "2026-05-14T00:00:00.000Z" }));
		const b = hashLinearIssueContent(makeRef({ referencedAt: "2026-05-14T23:59:59.999Z" }));
		expect(a).toBe(b);
	});

	it("writeLinearIssueMarkdown returns the referencedAt-excluding hash so re-references stay guarded", async () => {
		// Regression: the production write path used sha256(rawContent) which
		// INCLUDED the fresh referencedAt timestamp on every MCP fetch, so the
		// guard match in SessionTracker.upsertLinearIssueEntry always missed
		// and the entry got wrongly resurfaced as a new uncommitted entry. The
		// fix routes writeLinearIssueMarkdown's contentHash through
		// hashLinearIssueContent (the referencedAt-excluding scheme), pinning
		// the two hashes equal for the same logical content.
		mockMkdir.mockResolvedValue(undefined);
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		mockWriteFile.mockResolvedValue(undefined);
		const ref1 = makeRef({ referencedAt: "2026-05-14T00:00:00.000Z" });
		const ref2 = makeRef({ referencedAt: "2026-05-14T23:59:59.999Z" });
		const r1 = await writeLinearIssueMarkdown(ref1, "/repo");
		const r2 = await writeLinearIssueMarkdown(ref2, "/repo");
		expect(r1.contentHash).toBe(r2.contentHash);
		// Both should also match the standalone hashLinearIssueContent output
		// — verifies they share one canonical scheme rather than two parallel
		// hashing pipelines that happen to coincide.
		expect(r1.contentHash).toBe(hashLinearIssueContent(ref1));
	});
});

describe("hashLinearIssueContentFromMarkdown", () => {
	// Companion to hashLinearIssueContent: takes raw markdown bytes (as they
	// live on disk / in the orphan branch) and produces the same hash as
	// hashLinearIssueContent on the corresponding ref. Used by QueueWorker
	// at archive time when it only has file content, not a ref.

	it("produces the same hash as hashLinearIssueContent for the same logical content", async () => {
		mockMkdir.mockResolvedValue(undefined);
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		mockWriteFile.mockResolvedValue(undefined);
		const ref = makeRef({ referencedAt: "2026-05-14T00:00:00.000Z" });
		// writeLinearIssueMarkdown writes the rendered content somewhere; we
		// fish it out of the mock to feed hashLinearIssueContentFromMarkdown.
		await writeLinearIssueMarkdown(ref, "/repo");
		const writtenContent = mockWriteFile.mock.calls[0][1] as string;
		expect(hashLinearIssueContentFromMarkdown(writtenContent)).toBe(hashLinearIssueContent(ref));
	});

	it("returns the same hash regardless of the referencedAt value baked into the markdown", () => {
		// Reproduces the bug from the QueueWorker side: archive reads bytes
		// from disk, hashes them. Pre-fix this differed across re-references;
		// post-fix the strip-normalize step makes them equal.
		const docA = [
			"---",
			'ticketId: "PROJ-1528"',
			'title: "T"',
			'url: "u"',
			'referencedAt: "2026-05-14T00:00:00.000Z"',
			'sourceToolName: "mcp__linear__get_issue"',
			"---",
			"",
			"body",
		].join("\n");
		const docB = docA.replace("2026-05-14T00:00:00.000Z", "2026-05-14T23:59:59.999Z");
		expect(hashLinearIssueContentFromMarkdown(docA)).toBe(hashLinearIssueContentFromMarkdown(docB));
	});
});

describe("renameLinearIssueMarkdown", () => {
	it("calls fs.rename with the old and new paths", async () => {
		await renameLinearIssueMarkdown("/old.md", "/new.md");
		expect(mockRename).toHaveBeenCalledWith("/old.md", "/new.md");
	});
});
