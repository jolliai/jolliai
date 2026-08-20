/**
 * CursorTurnTimestamp — the one place a Cursor turn's instant is recovered.
 *
 * Cursor's `agent-transcripts` JSONL records carry NO time field of any kind: every
 * record's keys are `('message','role')` or `('status','type')` (measured across 10
 * real transcripts). What every USER turn does carry is a human-readable stamp
 * embedded in its text:
 *
 *     <timestamp>Thursday, Aug 20, 2026, 4:00 PM (UTC+8)</timestamp>
 *
 * Present in 10/10 real transcripts, at MINUTE resolution. Assistant and control
 * records have no stamp at all — callers treat them as belonging to the preceding
 * user turn's window.
 *
 * A leaf module (node builtins only) because two unrelated consumers need the same
 * instant and must not drift: `CursorCliTranscriptReader` uses it for the per-commit
 * `beforeTimestamp` cutoff AND for each tool bucket's `lastCallAtMs`, while
 * `CursorSkillScanner` uses it for `SkillInvocation.at`. A second copy would let a
 * skill and the tool call beside it date from different instants.
 */

const MONTHS: Record<string, number> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};

const TIMESTAMP_CAPTURE_RE = /<timestamp>([\s\S]*?)<\/timestamp>/i;
// "Tuesday, Jul 21, 2026, 6:57 PM (UTC+8)": English 3-letter month, minute
// resolution, explicit UTC offset. Parsed with an explicit regex (not `new Date`,
// whose non-ISO parsing is implementation-defined) so a non-matching or localized
// stamp cleanly falls back to "no timestamp" rather than a wrong-but-valid date.
const TS_PARSE_RE = /([A-Za-z]{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2})\s*(AM|PM) \(UTC([+-]\d{1,2})(?::?(\d{2}))?\)/i;

/** Strips every `<timestamp>…</timestamp>` tag — the global form, for text cleanup. */
export const CURSOR_TIMESTAMP_STRIP_RE = /<timestamp>[\s\S]*?<\/timestamp>\s*/gi;

/** Parse a `<timestamp>` tag BODY to epoch ms, or undefined when it does not match. */
export function parseCursorTurnTimestamp(raw: string): number | undefined {
	const m = TS_PARSE_RE.exec(raw);
	if (!m) return undefined;
	const month = MONTHS[m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()];
	if (month === undefined) return undefined;
	let hour = Number(m[4]) % 12;
	if (/pm/i.test(m[6])) hour += 12;
	const offsetHours = Number(m[7]);
	const offsetMinutes = m[8] ? Number(m[8]) : 0;
	const offsetTotal = offsetHours >= 0 ? offsetHours * 60 + offsetMinutes : offsetHours * 60 - offsetMinutes;
	return Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offsetTotal * 60000;
}

/** Epoch ms of the stamp embedded in `text`, or undefined when it carries none. */
export function timestampMsInText(text: string): number | undefined {
	const m = TIMESTAMP_CAPTURE_RE.exec(text);
	return m ? parseCursorTurnTimestamp(m[1]) : undefined;
}

/**
 * Epoch ms of a whole transcript RECORD's stamp — user turns only.
 *
 * Takes `unknown` rather than a typed line so both consumers can pass whatever
 * shape they already parsed, and tolerates a `content` that is a bare string as
 * well as the usual part array.
 */
export function cursorTurnTimestampMs(record: unknown): number | undefined {
	if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
	const line = record as { role?: unknown; message?: unknown };
	if (line.role !== "user") return undefined;
	const message =
		typeof line.message === "object" && line.message !== null ? (line.message as { content?: unknown }) : undefined;
	const content = message?.content;
	if (typeof content === "string") return timestampMsInText(content);
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const p = part as { type?: unknown; text?: unknown };
		if (p.type === "text" && typeof p.text === "string") {
			const ms = timestampMsInText(p.text);
			if (ms !== undefined) return ms;
		}
	}
	return undefined;
}
