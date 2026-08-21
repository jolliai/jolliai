import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_CLI_TRANSCRIPT_JSONL } from "../testUtils/cursorCliFixture.js";
import { readCursorCliTranscript } from "./CursorCliTranscriptReader.js";

// Partial mock: the fixture helpers below stay real; only `readFile` is made
// steerable, so a failure with no `errno` code can be injected. Every real fs error
// carries one, and the reader's code-copying guard has to survive one that does not.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, readFile: vi.fn(actual.readFile) };
});

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

	it("still throws its own wrapper when the underlying error carries no code", async () => {
		// Callers branch on `code` (ENOENT is routine, anything else is worth a warning),
		// so the wrapper must not invent one — an absent code has to stay absent.
		vi.mocked(readFile).mockRejectedValueOnce(new Error("something else went wrong"));
		const err = await readCursorCliTranscript(join(dir, "t.jsonl")).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("Cannot read Cursor CLI transcript");
		expect(err).not.toHaveProperty("code");
	});

	it("keeps a user turn that carries a stamp but no <user_query> wrapper", async () => {
		// The wrapper marks a typed prompt; a resumed or injected turn arrives as bare
		// text after the stamp, and dropping the stamp is all that is needed there.
		const p = join(dir, "bare.jsonl");
		await writeFile(
			p,
			`${JSON.stringify({
				role: "user",
				message: {
					content: [
						{
							type: "text",
							text: "<timestamp>Tuesday, Jul 21, 2026, 6:56 PM (UTC+8)</timestamp>\nbare prompt",
						},
					],
				},
			})}\n`,
			"utf8",
		);
		const r = await readCursorCliTranscript(p);
		expect(r.entries).toEqual([{ role: "human", content: "bare prompt" }]);
	});

	it("tolerates a user turn with no message body and a text part with no text", async () => {
		// Both shapes are read twice per line under a cutoff — once to look for a
		// timestamp and once to extract content — so neither may throw on either pass.
		const p = join(dir, "sparse.jsonl");
		await writeFile(
			p,
			[
				JSON.stringify({ role: "user" }),
				JSON.stringify({ role: "user", message: { content: [{ type: "text" }] } }),
				asst("still here"),
				"",
			].join("\n"),
			"utf8",
		);
		const r = await readCursorCliTranscript(p, null, new Date("2026-07-21T10:57:00Z").toISOString());
		expect(r.entries).toEqual([{ role: "assistant", content: "still here" }]);
		// Contentless turns are consumed, not deferred — nothing about them is pending.
		expect(r.newCursor.lineNumber).toBe(3);
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

describe("readCursorCliTranscript toolUse", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cursor-cli-tools-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	// Shapes copied from a real capture (see the `mcp` cases below for the whole
	// story): a tool call is a `type:"tool_use"` part, and Cursor writes NO `id` on
	// it. The `id`s are omitted here for that reason — an earlier version of this
	// fixture invented `toolu_…` ids and an `mcp__jollimemory__search` name, neither
	// of which appears anywhere in the corpus.
	const withTools = [
		JSON.stringify({
			role: "assistant",
			message: {
				content: [
					{ type: "text", text: "Checking." },
					{ type: "tool_use", name: "Read", input: {} },
					{ type: "tool_use", name: "Shell", input: {} },
				],
			},
		}),
		JSON.stringify({
			role: "assistant",
			message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
		}),
		"",
	].join("\n");

	it("counts tool_use parts, bucketing repeats of one builtin together", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(p, withTools);
		const result = await readCursorCliTranscript(p);
		expect(result.toolUse).toEqual([
			{ name: "Read", kind: "builtin", calls: 2 },
			{ name: "Shell", kind: "builtin", calls: 1 },
		]);
	});

	// ── MCP: the shape Cursor actually writes ────────────────────────────────────
	//
	// These replace a case that asserted an `mcp__<server>__<tool>` name was
	// classified by its prefix. That case passed, agreed with the reader's comment,
	// and described a transcript Cursor has never produced: across 10 real captures
	// there are ZERO `mcp__` names, and every MCP call is a generic `CallMcpTool`
	// carrying `{server, toolName}` in `input`. Both the fixture and the code it
	// verified were imagined, so the three real calls in that corpus were being filed
	// as `builtin:CallMcpTool` with their server discarded and nothing failing.

	it("classifies CallMcpTool from its input, not its name — the real MCP shape", async () => {
		const p = join(dir, "t.jsonl");
		// Verbatim block shape from ~/.cursor/projects/…/78230cc6…jsonl.
		await writeFile(
			p,
			`${JSON.stringify({
				role: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							name: "CallMcpTool",
							input: {
								server: "jollimemory",
								toolName: "search",
								description: "Search Jolli memories for this branch's work",
								arguments: { query: "cursor session rescan", limit: 10 },
							},
						},
					],
				},
			})}\n`,
		);
		const result = await readCursorCliTranscript(p);
		expect(result.toolUse).toEqual([{ name: "jollimemory.search", kind: "mcp", server: "jollimemory", calls: 1 }]);
	});

	it("keeps GetMcpTools a builtin — it is a discovery call that invokes no server", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(
			p,
			`${JSON.stringify({
				role: "assistant",
				message: {
					content: [
						// Both real `input` shapes: a name filter, and a server+tool probe.
						{ type: "tool_use", name: "GetMcpTools", input: { pattern: "jolli" } },
						{ type: "tool_use", name: "GetMcpTools", input: { server: "jollimemory", toolName: "search" } },
					],
				},
			})}\n`,
		);
		const result = await readCursorCliTranscript(p);
		// Notably the second one names a server, so a classifier keyed on "does input
		// have a server" rather than on the tool name would file it as an MCP call.
		expect(result.toolUse).toEqual([{ name: "GetMcpTools", kind: "builtin", calls: 2 }]);
	});

	it("keeps a CallMcpTool with no server as a builtin rather than an empty-server MCP row", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(
			p,
			`${JSON.stringify({
				role: "assistant",
				message: { content: [{ type: "tool_use", name: "CallMcpTool", input: {} }] },
			})}\n`,
		);
		const result = await readCursorCliTranscript(p);
		// The call is real and must not be dropped; inventing a server for it would put
		// a nameless row in the dashboard's group-by-server ranking.
		expect(result.toolUse).toEqual([{ name: "CallMcpTool", kind: "builtin", calls: 1 }]);
	});

	it("counts a turn that is nothing but tool calls, which produces no entry", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(
			p,
			`${JSON.stringify({
				role: "assistant",
				message: { content: [{ type: "tool_use", id: "toolu_1", name: "read_file", input: {} }] },
			})}\n`,
		);
		const result = await readCursorCliTranscript(p);
		expect(result.entries).toEqual([]);
		expect(result.toolUse).toEqual([{ name: "read_file", kind: "builtin", calls: 1 }]);
	});

	it("reports an empty array — not undefined — for a tool-free slice", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(p, REAL_JSONL);
		const result = await readCursorCliTranscript(p);
		expect(result.toolUse).toEqual([]);
	});

	it("counts only the calls inside the consumed slice", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(p, withTools);
		const first = await readCursorCliTranscript(p, { transcriptPath: p, lineNumber: 1, updatedAt: "" });
		// Resuming past line 0 skips the first record's two calls, leaving only the
		// second record's single `Read`.
		expect(first.toolUse).toEqual([{ name: "Read", kind: "builtin", calls: 1 }]);
	});

	// ── The tool-call clock ──────────────────────────────────────────────────────
	//
	// `TOOL_CALL_TIME_SOURCES` lists both Cursor sources, and its docstring requires
	// that a listed source is "actually passing a timestamp through". The stamp is not
	// a record field: it is embedded in the USER turn's text, while `tool_use` blocks
	// are in ASSISTANT turns. Measured across 10 real transcripts — 12/12 user turns
	// carry one, 0/35 assistant turns do, and 0 of the 24 lines carrying a `tool_use`
	// do — so a per-line read could never stamp a single bucket.

	/** A user turn stamped at `hhmm`, then an assistant turn calling `tool`. */
	const stampedTurn = (time: string, tool: string) =>
		[
			JSON.stringify({
				role: "user",
				message: { content: [{ type: "text", text: `hi <timestamp>${time}</timestamp>` }] },
			}),
			JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", name: tool, input: {} }] } }),
		].join("\n");

	it("stamps a tool call with the instant of the user turn it answers", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(p, `${stampedTurn("Thursday, Aug 20, 2026, 3:24 PM (UTC+8)", "Shell")}\n`);
		const result = await readCursorCliTranscript(p);
		expect(result.toolUse).toEqual([
			{
				name: "Shell",
				kind: "builtin",
				calls: 1,
				lastCallAtMs: Date.parse("2026-08-20T07:24:00.000Z"),
			},
		]);
	});

	it("advances the clock as later user turns arrive", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(
			p,
			`${stampedTurn("Thursday, Aug 20, 2026, 3:24 PM (UTC+8)", "Shell")}\n` +
				`${stampedTurn("Thursday, Aug 20, 2026, 4:00 PM (UTC+8)", "Shell")}\n`,
		);
		const result = await readCursorCliTranscript(p);
		// One bucket, carrying the LATER of the two — `lastCallAtMs`, not first-call.
		expect(result.toolUse).toEqual([
			{ name: "Shell", kind: "builtin", calls: 2, lastCallAtMs: Date.parse("2026-08-20T08:00:00.000Z") },
		]);
	});

	it("leaves the stamp ABSENT when the slice opens on an assistant turn", async () => {
		// A resumed read can begin past the user turn that dated these calls. Absence is
		// the honest answer — the consumer falls back to the session's own instant — and
		// an invented one would file the call under the wrong day.
		const p = join(dir, "t.jsonl");
		await writeFile(p, `${stampedTurn("Thursday, Aug 20, 2026, 3:24 PM (UTC+8)", "Shell")}\n`);
		const resumed = await readCursorCliTranscript(p, { transcriptPath: p, lineNumber: 1, updatedAt: "" });
		expect(resumed.toolUse).toEqual([{ name: "Shell", kind: "builtin", calls: 1 }]);
	});

	it("does not stamp calls with the instant of a turn deferred past the cutoff", async () => {
		// The carry-forward is assigned AFTER the cutoff check, so a turn this commit
		// refused cannot leave its clock behind for the calls it never consumed.
		const p = join(dir, "t.jsonl");
		await writeFile(
			p,
			`${stampedTurn("Thursday, Aug 20, 2026, 3:24 PM (UTC+8)", "Shell")}\n` +
				`${stampedTurn("Thursday, Aug 20, 2026, 5:00 PM (UTC+8)", "Read")}\n`,
		);
		const result = await readCursorCliTranscript(p, null, "2026-08-20T08:00:00.000Z");
		expect(result.toolUse).toEqual([
			{ name: "Shell", kind: "builtin", calls: 1, lastCallAtMs: Date.parse("2026-08-20T07:24:00.000Z") },
		]);
	});
});
