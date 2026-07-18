import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClineTranscript } from "./ClineTranscriptReader.js";

// Block structure captured from a real Cline VS Code extension task on
// 2026-07-18 (api_conversation_history.json); paths/timestamps sanitized.
// role:"user" turns carry a <task>/<feedback> wrapper plus Cline-injected
// scaffolding (# task_progress boilerplate, <environment_details>, and tool
// results echoed as plain text) that must NOT be attributed to the human.
const FIXTURE = [
	{
		role: "user",
		content: [
			{ type: "text", text: "<task>\n查看当前分支\n</task>" },
			{ type: "text", text: "# task_progress RECOMMENDED\n\nWhen starting a new task, include a todo list…" },
			{
				type: "text",
				text: "<environment_details>\n# VS Code Open Tabs\nsrc/app.ts\n\n# Current Time\n2026/7/18\n</environment_details>",
			},
		],
		ts: 1000,
	},
	{
		role: "assistant",
		content: [
			{ type: "thinking", text: "" },
			{
				type: "text",
				text: "<execute_command>\n<command>git branch --show-current</command>\n</execute_command>",
			},
		],
		ts: 2000,
	},
	{
		role: "user",
		content: [
			{
				type: "text",
				text: "[execute_command for 'git branch --show-current'] Result:\nCommand executed.\nOutput:\nmain",
			},
			{ type: "text", text: "<environment_details>\n# Current Time\n2026/7/18\n</environment_details>" },
		],
		ts: 3000,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "当前分支是 `main`" }],
		ts: 4000,
	},
];

describe("readClineTranscript", () => {
	let dir: string;
	let path: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cline-ext-rd-"));
		path = join(dir, "api_conversation_history.json");
		await writeFile(path, JSON.stringify(FIXTURE), "utf8");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("unwraps <task>, strips env/boilerplate, drops tool-result-as-user, merges assistant", async () => {
		const r = await readClineTranscript(path);
		// msg0 → "查看当前分支" (task unwrapped, boilerplate + env dropped);
		// msg2 → "" (tool-result echo + env) → dropped;
		// msg1 + msg3 assistant collapse into one merged entry.
		expect(r.entries).toEqual([
			{ role: "human", content: "查看当前分支", timestamp: new Date(1000).toISOString() },
			{
				role: "assistant",
				content:
					"<execute_command>\n<command>git branch --show-current</command>\n</execute_command>\n\n当前分支是 `main`",
				timestamp: new Date(2000).toISOString(),
			},
		]);
		expect(r.newCursor.lineNumber).toBe(4);
	});

	it("drops native tool_use / tool_result blocks (Anthropic-family models)", async () => {
		// Anthropic-family models emit native tool_use/tool_result blocks instead
		// of XML-in-text; tool output lands under role "user" as a tool_result
		// block. textBlocks keeps only `text`, so neither surfaces as an entry —
		// only the human prose and the assistant's own text remain.
		const native = [
			{ role: "user", content: [{ type: "text", text: "<task>\nlist files\n</task>" }], ts: 1000 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Listing now" },
					{ type: "tool_use", id: "c1", name: "run_commands", input: { commands: ["ls"] } },
				],
				ts: 2000,
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "a.ts\nb.ts" }] }],
				ts: 3000,
			},
			{ role: "assistant", content: [{ type: "text", text: "Two files." }], ts: 4000 },
		];
		await writeFile(path, JSON.stringify(native), "utf8");
		const r = await readClineTranscript(path);
		// tool_use (msg1) + tool_result (msg2) blocks dropped; assistant msg1+msg3
		// collapse (the empty tool_result turn is skipped, not a role boundary).
		expect(r.entries).toEqual([
			{ role: "human", content: "list files", timestamp: new Date(1000).toISOString() },
			{ role: "assistant", content: "Listing now\n\nTwo files.", timestamp: new Date(2000).toISOString() },
		]);
	});

	it("unwraps <feedback> and keeps plain human text as-is", async () => {
		const fb = [
			{ role: "user", content: [{ type: "text", text: "<feedback>\ntry again\n</feedback>" }], ts: 1000 },
			{ role: "user", content: [{ type: "text", text: "plain follow-up" }], ts: 2000 },
		];
		await writeFile(path, JSON.stringify(fb), "utf8");
		const r = await readClineTranscript(path);
		expect(r.entries).toEqual([
			{ role: "human", content: "try again\n\nplain follow-up", timestamp: new Date(1000).toISOString() },
		]);
	});

	it("honors cursor + beforeTimestamp", async () => {
		const r = await readClineTranscript(path, { transcriptPath: path, lineNumber: 3, updatedAt: "" });
		expect(r.entries).toEqual([
			{ role: "assistant", content: "当前分支是 `main`", timestamp: new Date(4000).toISOString() },
		]);
		const cut = await readClineTranscript(path, null, new Date(1500).toISOString());
		expect(cut.entries.map((e) => e.role)).toEqual(["human"]);
		expect(cut.newCursor.lineNumber).toBe(1);
	});

	it("empty on bad file", async () => {
		const r = await readClineTranscript(join(dir, "nope.json"));
		expect(r.entries).toEqual([]);
	});
});
