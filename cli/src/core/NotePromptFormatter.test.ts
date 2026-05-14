import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile: mockReadFile };
});

import type { NoteEntry } from "../Types.js";
import { formatNotesBlock } from "./NotePromptFormatter.js";

function makeNote(overrides: Partial<NoteEntry> = {}): NoteEntry {
	return {
		id: "my-note",
		title: "My Note",
		format: "snippet",
		addedAt: "2026-05-13T00:00:00Z",
		updatedAt: "2026-05-14T00:00:00Z",
		branch: "main",
		commitHash: null,
		sourcePath: "/abs/path/my-note.md",
		...overrides,
	};
}

beforeEach(() => {
	mockReadFile.mockReset();
});

describe("formatNotesBlock", () => {
	it("returns empty string when no notes", async () => {
		expect(await formatNotesBlock([])).toBe("");
	});

	it("renders one note with id, format attribute, title, and content", async () => {
		mockReadFile.mockResolvedValue("Reminder to do X");
		const out = await formatNotesBlock([makeNote()]);
		expect(out).toContain("<notes>");
		expect(out).toContain("</notes>");
		expect(out).toContain('id="my-note"');
		expect(out).toContain('format="snippet"');
		expect(out).toContain("<title>My Note</title>");
		expect(out).toContain("Reminder to do X");
	});

	it("escapes XML-special characters in attributes and body", async () => {
		mockReadFile.mockResolvedValue("body has <tag>");
		const out = await formatNotesBlock([makeNote({ id: "x&y", title: 'T "Q"' })]);
		expect(out).toContain('id="x&amp;y"');
		expect(out).toContain('<title>T "Q"</title>'); // " not escaped in text content
		expect(out).toContain("&lt;tag&gt;");
	});

	it("truncates body when over maxCharsPerNote", async () => {
		mockReadFile.mockResolvedValue("y".repeat(10000));
		const out = await formatNotesBlock([makeNote()], { maxCharsPerNote: 200 });
		expect(out).toContain("…[truncated,");
	});

	it("drops oldest notes when maxTotalChars exceeded", async () => {
		const notes = [
			makeNote({ id: "older", updatedAt: "2026-05-14T01:00:00Z" }),
			makeNote({ id: "newer", updatedAt: "2026-05-14T02:00:00Z" }),
		];
		mockReadFile.mockImplementation(async () => "z".repeat(3000));
		const out = await formatNotesBlock(notes, { maxCharsPerNote: 4000, maxTotalChars: 3500 });
		expect(out).toContain('id="newer"');
		expect(out).not.toContain('id="older"');
	});

	it("renders without <content> when source file is unreadable", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));
		const out = await formatNotesBlock([makeNote()]);
		expect(out).toContain('id="my-note"');
		expect(out).not.toContain("<content>");
	});

	it("renders without <content> when sourcePath is absent (defensive)", async () => {
		const out = await formatNotesBlock([makeNote({ sourcePath: undefined })]);
		expect(out).toContain('id="my-note"');
		expect(out).not.toContain("<content>");
	});

	it("uses markdown format value in the format attribute", async () => {
		mockReadFile.mockResolvedValue("body");
		const out = await formatNotesBlock([makeNote({ format: "markdown" })]);
		expect(out).toContain('format="markdown"');
	});
});
