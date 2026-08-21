import { describe, expect, it } from "vitest";
import {
	CURSOR_TIMESTAMP_STRIP_RE,
	cursorTurnTimestampMs,
	parseCursorTurnTimestamp,
	timestampMsInText,
} from "./CursorTurnTimestamp.js";

/** Real stamps, copied from `~/.cursor/projects/**` user turns. */
const REAL = "Thursday, Aug 20, 2026, 4:00 PM (UTC+8)";
const REAL_MS = Date.UTC(2026, 7, 20, 8, 0);

describe("parseCursorTurnTimestamp", () => {
	it("parses a real stamp, applying the UTC offset", () => {
		expect(parseCursorTurnTimestamp(REAL)).toBe(REAL_MS);
	});

	it("handles both meridiems, including the 12-hour wrap", () => {
		expect(parseCursorTurnTimestamp("Thursday, Aug 20, 2026, 12:30 AM (UTC+0)")).toBe(Date.UTC(2026, 7, 20, 0, 30));
		expect(parseCursorTurnTimestamp("Thursday, Aug 20, 2026, 12:30 PM (UTC+0)")).toBe(
			Date.UTC(2026, 7, 20, 12, 30),
		);
	});

	it("applies a negative offset in the right direction, minutes included", () => {
		expect(parseCursorTurnTimestamp("Thu, Aug 20, 2026, 1:00 AM (UTC-5:30)")).toBe(Date.UTC(2026, 7, 20, 6, 30));
	});

	it("returns undefined rather than a wrong-but-valid date for anything unrecognised", () => {
		// The reason the parse is an explicit regex and not `new Date`: a localized or
		// reshaped stamp must degrade to "no timestamp", never to a plausible instant.
		for (const raw of [
			"",
			"2026-08-20T08:00:00Z",
			"星期四, 8月 20, 2026, 4:00 下午 (UTC+8)",
			"Thursday, Xxx 20, 2026, 4:00 PM (UTC+8)",
		]) {
			expect(parseCursorTurnTimestamp(raw)).toBeUndefined();
		}
	});
});

describe("timestampMsInText", () => {
	it("finds the stamp wherever it sits in the turn", () => {
		// Real turns put it AFTER a skill block, so a matcher anchored at the start
		// would read no instant on exactly the turns that carry a skill.
		expect(
			timestampMsInText(`<manually_attached_skills>…</manually_attached_skills>\n<timestamp>${REAL}</timestamp>`),
		).toBe(REAL_MS);
	});

	it("returns undefined when there is no stamp", () => {
		expect(timestampMsInText("just text")).toBeUndefined();
	});
});

describe("cursorTurnTimestampMs", () => {
	const userTurn = (text: string): unknown => ({ role: "user", message: { content: [{ type: "text", text }] } });

	it("reads a user turn's part array", () => {
		expect(cursorTurnTimestampMs(userTurn(`<timestamp>${REAL}</timestamp>`))).toBe(REAL_MS);
	});

	it("reads a content that arrived as a bare string", () => {
		expect(cursorTurnTimestampMs({ role: "user", message: { content: `<timestamp>${REAL}</timestamp>` } })).toBe(
			REAL_MS,
		);
	});

	it("skips leading parts with no stamp and keeps looking", () => {
		expect(
			cursorTurnTimestampMs({
				role: "user",
				message: {
					content: [
						{ type: "text", text: "no stamp here" },
						{ type: "text", text: `<timestamp>${REAL}</timestamp>` },
					],
				},
			}),
		).toBe(REAL_MS);
	});

	it("answers undefined for every record that cannot carry a stamp", () => {
		// Only USER turns are stamped. Assistant and control records are conservatively
		// treated as belonging to the preceding user turn's window by the callers.
		for (const record of [
			{ role: "assistant", message: { content: [{ type: "text", text: `<timestamp>${REAL}</timestamp>` }] } },
			{ type: "turn_ended", status: "completed" },
			{ role: "user" },
			{ role: "user", message: { content: 7 } },
			{ role: "user", message: { content: [null, { type: "tool_use", name: "Read" }] } },
			null,
			[],
			"string",
		]) {
			expect(cursorTurnTimestampMs(record)).toBeUndefined();
		}
	});
});

describe("CURSOR_TIMESTAMP_STRIP_RE", () => {
	it("strips every stamp, and is reusable across calls despite the /g flag", () => {
		const once = `a<timestamp>${REAL}</timestamp>b<timestamp>${REAL}</timestamp>c`;
		expect(once.replace(CURSOR_TIMESTAMP_STRIP_RE, "")).toBe("abc");
		// `String.replace` with a /g regex resets `lastIndex` itself; asserted because a
		// shared module-level /g regex used with `.exec` would NOT.
		expect(once.replace(CURSOR_TIMESTAMP_STRIP_RE, "")).toBe("abc");
	});
});
