import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output during tests
beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

import { readGeminiTranscript } from "./GeminiTranscriptReader.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "gemini-reader-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Creates a Gemini session JSON file with the given messages */
async function createSession(
	messages: Array<{
		id: string;
		type: string;
		timestamp: string;
		content: unknown;
	}>,
	sessionId = "test-session",
): Promise<string> {
	const filePath = join(tempDir, `session-${sessionId}.json`);
	const record = {
		sessionId,
		projectHash: "abc123",
		startTime: "2026-03-20T10:00:00.000Z",
		lastUpdated: "2026-03-20T11:00:00.000Z",
		messages,
	};
	await writeFile(filePath, JSON.stringify(record), "utf-8");
	return filePath;
}

describe("readGeminiTranscript", () => {
	it("should parse user and gemini messages with string content", async () => {
		const filePath = await createSession([
			{ id: "m1", type: "user", timestamp: "2026-03-20T10:00:00Z", content: "Hello" },
			{ id: "m2", type: "gemini", timestamp: "2026-03-20T10:00:01Z", content: "Hi there!" },
		]);

		const result = await readGeminiTranscript(filePath);

		expect(result.entries).toHaveLength(2);
		expect(result.entries[0]).toEqual({
			role: "human",
			content: "Hello",
			timestamp: "2026-03-20T10:00:00Z",
		});
		expect(result.entries[1]).toEqual({
			role: "assistant",
			content: "Hi there!",
			timestamp: "2026-03-20T10:00:01Z",
		});
		expect(result.totalLinesRead).toBe(2);
	});

	it("should parse array content (PartListUnion)", async () => {
		const filePath = await createSession([
			{
				id: "m1",
				type: "gemini",
				timestamp: "2026-03-20T10:00:00Z",
				content: [{ text: "Part 1" }, { text: "Part 2" }],
			},
		]);

		const result = await readGeminiTranscript(filePath);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Part 1\nPart 2");
	});

	it("should skip info, error, and warning messages", async () => {
		const filePath = await createSession([
			{ id: "m1", type: "user", timestamp: "2026-03-20T10:00:00Z", content: "Do something" },
			{ id: "m2", type: "info", timestamp: "2026-03-20T10:00:01Z", content: "Info message" },
			{ id: "m3", type: "error", timestamp: "2026-03-20T10:00:02Z", content: "Error occurred" },
			{ id: "m4", type: "warning", timestamp: "2026-03-20T10:00:03Z", content: "Warning" },
			{ id: "m5", type: "gemini", timestamp: "2026-03-20T10:00:04Z", content: "Done" },
		]);

		const result = await readGeminiTranscript(filePath);

		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].role).toBe("human");
		expect(result.entries[1].role).toBe("assistant");
	});

	it("should merge consecutive same-role messages", async () => {
		const filePath = await createSession([
			{ id: "m1", type: "gemini", timestamp: "2026-03-20T10:00:00Z", content: "Part A" },
			{ id: "m2", type: "gemini", timestamp: "2026-03-20T10:00:01Z", content: "Part B" },
		]);

		const result = await readGeminiTranscript(filePath);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Part A\n\nPart B");
	});

	it("should support cursor-based resumption", async () => {
		const filePath = await createSession([
			{ id: "m1", type: "user", timestamp: "2026-03-20T10:00:00Z", content: "First" },
			{ id: "m2", type: "gemini", timestamp: "2026-03-20T10:00:01Z", content: "Response" },
			{ id: "m3", type: "user", timestamp: "2026-03-20T10:00:02Z", content: "Second" },
		]);

		// First read: all messages
		const result1 = await readGeminiTranscript(filePath);
		expect(result1.entries).toHaveLength(3);
		expect(result1.newCursor.lineNumber).toBe(3);

		// Second read with cursor: no new messages
		const result2 = await readGeminiTranscript(filePath, result1.newCursor);
		expect(result2.entries).toHaveLength(0);
		expect(result2.totalLinesRead).toBe(0);
	});

	it("should read new messages when file grows after cursor", async () => {
		const messages = [{ id: "m1", type: "user", timestamp: "2026-03-20T10:00:00Z", content: "Hello" }];
		const filePath = await createSession(messages);

		// First read
		const result1 = await readGeminiTranscript(filePath);
		expect(result1.entries).toHaveLength(1);

		// Add more messages to the file
		messages.push({ id: "m2", type: "gemini", timestamp: "2026-03-20T10:00:01Z", content: "World" });
		const record = {
			sessionId: "test-session",
			projectHash: "abc123",
			startTime: "2026-03-20T10:00:00.000Z",
			lastUpdated: "2026-03-20T11:00:00.000Z",
			messages,
		};
		await writeFile(filePath, JSON.stringify(record), "utf-8");

		// Second read with cursor: only new message
		const result2 = await readGeminiTranscript(filePath, result1.newCursor);
		expect(result2.entries).toHaveLength(1);
		expect(result2.entries[0].content).toBe("World");
	});

	it("should handle empty messages array", async () => {
		const filePath = await createSession([]);

		const result = await readGeminiTranscript(filePath);
		expect(result.entries).toHaveLength(0);
		expect(result.totalLinesRead).toBe(0);
	});

	it("should handle messages with empty content", async () => {
		const filePath = await createSession([
			{ id: "m1", type: "user", timestamp: "2026-03-20T10:00:00Z", content: "" },
			{ id: "m2", type: "gemini", timestamp: "2026-03-20T10:00:01Z", content: "  " },
		]);

		const result = await readGeminiTranscript(filePath);
		expect(result.entries).toHaveLength(0);
	});

	it("should handle messages with undefined content", async () => {
		const filePath = await createSession([
			{ id: "m1", type: "user", timestamp: "2026-03-20T10:00:00Z", content: undefined },
		]);

		const result = await readGeminiTranscript(filePath);
		expect(result.entries).toHaveLength(0);
	});

	it("should handle array content with empty text parts", async () => {
		const filePath = await createSession([
			{
				id: "m1",
				type: "gemini",
				timestamp: "2026-03-20T10:00:00Z",
				content: [{ text: "" }, { text: "  " }, { text: "Valid" }],
			},
		]);

		const result = await readGeminiTranscript(filePath);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Valid");
	});

	it("should ignore non-object parts in array content", async () => {
		const filePath = await createSession([
			{
				id: "m1",
				type: "gemini",
				timestamp: "2026-03-20T10:00:00Z",
				content: [null, "plain-string-part", { text: "Valid" }, { notText: "ignored" }],
			},
		]);

		const result = await readGeminiTranscript(filePath);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].content).toBe("Valid");
	});

	it("should return no entries when array content has no valid text parts", async () => {
		const filePath = await createSession([
			{
				id: "m1",
				type: "gemini",
				timestamp: "2026-03-20T10:00:00Z",
				content: [null, { text: "   " }, { notText: "ignored" }],
			},
		]);

		const result = await readGeminiTranscript(filePath);
		expect(result.entries).toHaveLength(0);
	});

	it("should throw on non-existent file", async () => {
		await expect(readGeminiTranscript("/nonexistent/file.json")).rejects.toThrow("Cannot read Gemini session");
	});

	it("should throw on invalid JSON", async () => {
		const filePath = join(tempDir, "invalid.json");
		await writeFile(filePath, "not json {{{", "utf-8");

		await expect(readGeminiTranscript(filePath)).rejects.toThrow("Invalid Gemini session JSON");
	});

	it("should handle missing messages field gracefully", async () => {
		const filePath = join(tempDir, "no-messages.json");
		await writeFile(filePath, JSON.stringify({ sessionId: "x", projectHash: "y" }), "utf-8");

		const result = await readGeminiTranscript(filePath);
		expect(result.entries).toHaveLength(0);
	});

	it("should stop consuming messages at beforeTimestamp cutoff", async () => {
		const filePath = await createSession([
			{ id: "m1", type: "user", timestamp: "2026-03-20T10:00:00Z", content: "Before cutoff" },
			{ id: "m2", type: "gemini", timestamp: "2026-03-20T10:00:01Z", content: "Also before" },
			{ id: "m3", type: "user", timestamp: "2026-03-20T12:00:00Z", content: "After cutoff" },
		]);

		const result = await readGeminiTranscript(filePath, undefined, "2026-03-20T11:00:00Z");

		// Should only include messages before the cutoff
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0].content).toBe("Before cutoff");
		expect(result.entries[1].content).toBe("Also before");
		// Cursor should advance only to last consumed index (not end of messages)
		expect(result.newCursor.lineNumber).toBe(2);
		expect(result.totalLinesRead).toBe(2);
	});

	it("should advance cursor to end when no beforeTimestamp is provided", async () => {
		const filePath = await createSession([
			{ id: "m1", type: "user", timestamp: "2026-03-20T10:00:00Z", content: "msg1" },
			{ id: "m2", type: "gemini", timestamp: "2026-03-20T10:00:01Z", content: "msg2" },
		]);

		const result = await readGeminiTranscript(filePath);

		// Without beforeTimestamp, cursor should advance to end of all messages
		expect(result.newCursor.lineNumber).toBe(2);
	});
});
