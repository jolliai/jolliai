import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClineCliTranscript } from "./ClineCliTranscriptReader.js";

const FIXTURE = {
	version: 1,
	messages: [
		{
			id: "m1",
			role: "user",
			content: [{ type: "text", text: '<user_input mode="act">hi</user_input>' }],
			ts: 1000,
		},
		{
			id: "m2",
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "planning" },
				{ type: "text", text: "Hi! How can I help?" },
			],
			ts: 2000,
		},
		{
			id: "m3",
			role: "assistant",
			content: [
				{ type: "text", text: "Running check" },
				{ type: "tool_use", id: "c1", name: "run_commands", input: { commands: ["git branch"] } },
			],
			ts: 3000,
		},
		{
			id: "m4",
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "c1", name: "run_commands", content: [{ result: "main" }] }],
			ts: 4000,
		},
		{ id: "m5", role: "assistant", content: [{ type: "text", text: "Branch is main" }], ts: 5000 },
	],
};

describe("readClineCliTranscript", () => {
	let dir: string;
	let path: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cline-cli-rd-"));
		path = join(dir, "m.messages.json");
		await writeFile(path, JSON.stringify(FIXTURE), "utf8");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("extracts text blocks, strips <user_input>, drops thinking/tool blocks, merges same-role", async () => {
		const r = await readClineCliTranscript(path);
		// m1 human "hi"; m2+m3+m5 all consecutive assistant entries merge; m4 (empty tool_result) skipped
		expect(r.entries).toEqual([
			{ role: "human", content: "hi", timestamp: new Date(1000).toISOString() },
			{
				role: "assistant",
				content: "Hi! How can I help?\n\nRunning check\n\nBranch is main",
				timestamp: new Date(2000).toISOString(),
			},
		]);
		expect(r.newCursor.lineNumber).toBe(5);
		expect(r.totalLinesRead).toBe(5);
	});

	it("resumes from cursor.lineNumber (starting at m5)", async () => {
		const r = await readClineCliTranscript(path, { transcriptPath: path, lineNumber: 4, updatedAt: "" });
		// m5 is at index 4
		expect(r.entries).toEqual([
			{ role: "assistant", content: "Branch is main", timestamp: new Date(5000).toISOString() },
		]);
		expect(r.totalLinesRead).toBe(1);
	});

	it("honors beforeTimestamp (stops at first message past cutoff, advances cursor to consumed)", async () => {
		const r = await readClineCliTranscript(path, null, new Date(3000).toISOString());
		expect(r.entries.map((e) => e.role)).toEqual(["human", "assistant"]);
		expect(r.newCursor.lineNumber).toBe(3); // m1,m2,m3 consumed; m4 (ts 4000) > cutoff → break
	});

	it("returns empty result on unreadable file", async () => {
		const r = await readClineCliTranscript(join(dir, "missing.json"));
		expect(r.entries).toEqual([]);
		expect(r.totalLinesRead).toBe(0);
	});

	it("handles messages without content array gracefully", async () => {
		const noContentFixture = {
			messages: [
				{ id: "m1", role: "assistant" },
				{ id: "m2", role: "user" },
			],
		};
		await writeFile(path, JSON.stringify(noContentFixture), "utf8");
		const r = await readClineCliTranscript(path);
		// Both messages have no content, so both get empty text → skipped
		expect(r.entries).toEqual([]);
		expect(r.totalLinesRead).toBe(2);
	});

	it("handles undefined parsed.messages gracefully", async () => {
		const noMessagesFixture = { version: 1 }; // no messages field
		await writeFile(path, JSON.stringify(noMessagesFixture), "utf8");
		const r = await readClineCliTranscript(path);
		expect(r.entries).toEqual([]);
		expect(r.totalLinesRead).toBe(0);
	});
});
