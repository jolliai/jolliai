import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURSOR_CLI_TRANSCRIPT_JSONL } from "../testUtils/cursorCliFixture.js";
import { readCursorCliTranscript } from "./CursorCliTranscriptReader.js";

// Real line shapes verified on a live cursor-agent install (JOLLI-2023):
//   {role, message:{content:[{type:"text"|"tool_use", …}]}}  and  {type, status}
const USER_TEXT = "<timestamp>Tuesday, Jul 21, 2026, 6:56 PM (UTC+8)</timestamp>\n<user_query>\nhi\n</user_query>";
const REAL_JSONL = [
	JSON.stringify({
		role: "user",
		message: { content: [{ type: "text", text: USER_TEXT }] },
	}),
	JSON.stringify({
		role: "assistant",
		message: { content: [{ type: "text", text: "Hi — how can I help?" }] },
	}),
	JSON.stringify({ type: "turn_ended", status: "completed" }),
	"",
].join("\n");

describe("readCursorCliTranscript", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cursor-cli-read-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("parses user/assistant lines, unwraps <user_query>, skips control lines", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(p, REAL_JSONL, "utf8");
		const r = await readCursorCliTranscript(p);
		expect(r.entries).toEqual([
			{ role: "human", content: "hi" },
			{ role: "assistant", content: "Hi — how can I help?" },
		]);
		expect(r.newCursor.lineNumber).toBe(3); // 3 real lines; the trailing "" is filtered, not counted
	});

	it("parses the pinned real Cursor CLI fixture", async () => {
		const p = join(dir, "fixture.jsonl");
		await writeFile(p, CURSOR_CLI_TRANSCRIPT_JSONL, "utf8");
		const r = await readCursorCliTranscript(p);
		expect(r.entries).toEqual([
			{ role: "human", content: "hello" },
			{ role: "assistant", content: "Hello! How can I help you today?" },
		]);
	});

	it("skips a tool_use-only assistant turn (no text) and malformed lines", async () => {
		const p = join(dir, "t2.jsonl");
		await writeFile(
			p,
			[
				JSON.stringify({
					role: "assistant",
					message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
				}),
				"{ not json",
				JSON.stringify({
					role: "user",
					message: { content: [{ type: "text", text: "<user_query>\nok\n</user_query>" }] },
				}),
			].join("\n"),
			"utf8",
		);
		const r = await readCursorCliTranscript(p);
		expect(r.entries).toEqual([{ role: "human", content: "ok" }]);
	});

	it("resumes from cursor.lineNumber", async () => {
		const p = join(dir, "t3.jsonl");
		await writeFile(p, REAL_JSONL, "utf8");
		const r = await readCursorCliTranscript(p, { transcriptPath: p, lineNumber: 1, updatedAt: "" });
		expect(r.entries).toEqual([{ role: "assistant", content: "Hi — how can I help?" }]);
	});

	it("does not drop the boundary line when resuming after an append (trailing-newline)", async () => {
		// Real cursor-agent JSONL is append-only and every line ends with "\n",
		// so the file always has a trailing empty segment. The returned cursor
		// must not consume that phantom slot, or the first line appended after a
		// resume is silently dropped (JOLLI-2023 regression).
		const p = join(dir, "grow.jsonl");
		const turn = (role: string, text: string) =>
			JSON.stringify({ role, message: { content: [{ type: "text", text }] } });

		await writeFile(p, `${turn("user", "<user_query>\nfirst\n</user_query>")}\n`, "utf8");
		const r1 = await readCursorCliTranscript(p);
		expect(r1.entries).toEqual([{ role: "human", content: "first" }]);

		// Append a second turn and resume from the cursor r1 handed back.
		await writeFile(
			p,
			`${turn("user", "<user_query>\nfirst\n</user_query>")}\n${turn("assistant", "second")}\n`,
			"utf8",
		);
		const r2 = await readCursorCliTranscript(p, r1.newCursor);
		expect(r2.entries).toEqual([{ role: "assistant", content: "second" }]);
	});

	it("throws (with preserved code) when the file is missing", async () => {
		await expect(readCursorCliTranscript(join(dir, "nope.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	const userAt = (clock: string, q: string) =>
		JSON.stringify({
			role: "user",
			message: {
				content: [
					{
						type: "text",
						text: `<timestamp>Tuesday, Jul 21, 2026, ${clock} (UTC+8)</timestamp>\n<user_query>\n${q}\n</user_query>`,
					},
				],
			},
		});
	const asst = (t: string) =>
		JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: t }] } });

	it("defers turns stamped after the beforeTimestamp cutoff to a later commit (P1)", async () => {
		const p = join(dir, "gate.jsonl");
		// 6:56 PM is in-window; 6:58 PM is after the 6:57 PM (UTC+8) = 10:57:00Z cutoff.
		await writeFile(
			p,
			[userAt("6:56 PM", "first"), asst("reply one"), userAt("6:58 PM", "second"), asst("reply two"), ""].join(
				"\n",
			),
			"utf8",
		);
		const cutoff = new Date("2026-07-21T10:57:00Z").toISOString();

		const r1 = await readCursorCliTranscript(p, null, cutoff);
		expect(r1.entries).toEqual([
			{ role: "human", content: "first" },
			{ role: "assistant", content: "reply one" },
		]);
		expect(r1.newCursor.lineNumber).toBe(2); // held before the deferred user turn, not at EOF (4)

		// A later commit resumes from the held cursor and picks up exactly the deferred turns.
		const r2 = await readCursorCliTranscript(p, r1.newCursor, new Date("2026-07-21T11:00:00Z").toISOString());
		expect(r2.entries).toEqual([
			{ role: "human", content: "second" },
			{ role: "assistant", content: "reply two" },
		]);
	});

	it("conservatively keeps turns with missing / unparseable timestamps under a cutoff (P1 fallback)", async () => {
		const p = join(dir, "nots.jsonl");
		await writeFile(
			p,
			[
				JSON.stringify({
					role: "user",
					message: { content: [{ type: "text", text: "<user_query>\nplain\n</user_query>" }] },
				}), // no <timestamp>
				asst("sep one"),
				JSON.stringify({
					role: "user",
					message: {
						content: [
							{ type: "text", text: "<timestamp>garbage</timestamp>\n<user_query>\ng\n</user_query>" },
						],
					},
				}), // tag present, no regex match
				asst("sep two"),
				JSON.stringify({
					role: "user",
					message: {
						content: [
							{
								type: "text",
								text: "<timestamp>Xyz 3, 2026, 6:57 PM (UTC+8)</timestamp>\n<user_query>\nb\n</user_query>",
							},
						],
					},
				}), // matches shape, unknown month
				"",
			].join("\n"),
			"utf8",
		);
		const r = await readCursorCliTranscript(p, null, new Date("2026-07-21T10:57:00Z").toISOString());
		expect(r.entries).toEqual([
			{ role: "human", content: "plain" },
			{ role: "assistant", content: "sep one" },
			{ role: "human", content: "g" },
			{ role: "assistant", content: "sep two" },
			{ role: "human", content: "b" },
		]);
		expect(r.newCursor.lineNumber).toBe(5); // all consumed — nothing deferred
	});

	it("parses negative and fractional UTC offsets when gating", async () => {
		const p = join(dir, "neg.jsonl");
		const mk = (ts: string, q: string) =>
			JSON.stringify({
				role: "user",
				message: {
					content: [
						{ type: "text", text: `<timestamp>${ts}</timestamp>\n<user_query>\n${q}\n</user_query>` },
					],
				},
			});
		// 6:56 AM (UTC-5) = 11:56Z and 5:00 PM (UTC+5:30) = 11:30Z — both before the 12:00Z cutoff.
		await writeFile(
			p,
			[
				mk("Monday, Jul 21, 2026, 6:56 AM (UTC-5)", "neg"),
				asst("mid"),
				mk("Monday, Jul 21, 2026, 5:00 PM (UTC+5:30)", "half"),
				"",
			].join("\n"),
			"utf8",
		);
		const r = await readCursorCliTranscript(p, null, new Date("2026-07-21T12:00:00Z").toISOString());
		expect(r.entries).toEqual([
			{ role: "human", content: "neg" },
			{ role: "assistant", content: "mid" },
			{ role: "human", content: "half" },
		]);
	});

	it("does not drop a trailing partial (mid-write) line; re-reads it once complete (P2)", async () => {
		const p = join(dir, "partial.jsonl");
		// A complete first line, then a half-written second line (invalid JSON, no newline yet).
		await writeFile(p, `${asst("done")}\n{"role":"assist`, "utf8");
		const r1 = await readCursorCliTranscript(p);
		expect(r1.entries).toEqual([{ role: "assistant", content: "done" }]);
		expect(r1.newCursor.lineNumber).toBe(1); // held before the partial line, not at EOF (2)

		// The line finishes writing; resuming from the held cursor now yields it.
		await writeFile(p, `${asst("done")}\n${asst("second")}\n`, "utf8");
		const r2 = await readCursorCliTranscript(p, r1.newCursor);
		expect(r2.entries).toEqual([{ role: "assistant", content: "second" }]);
	});
});
