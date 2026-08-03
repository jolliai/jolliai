import { describe, expect, it } from "vitest";
import { getParserForSource } from "../TranscriptParser.js";
import {
	TOOL_BODY,
	TOOL_CALL,
	TOOL_RESULT,
	USAGE_NO_MESSAGE_ID,
	USAGE_OTHER_SKILL,
	USAGE_SECOND_RESPONSE,
	USAGE_SPLIT_LINE_1,
	USAGE_SPLIT_LINE_2,
	USAGE_SPLIT_LINE_3,
	USAGE_SUBAGENT_TURN,
	USAGE_UNATTRIBUTED,
} from "./__fixtures__/claudeTranscript.js";
import { attributeSkillUsage } from "./SkillAttribution.js";

describe("attributeSkillUsage — attributed path", () => {
	it("counts one API response once even though it spans three JSONL lines", () => {
		// Real data: lines 50-52 of one session are ONE response, each line repeating
		// the whole usage object. Per-line summing inflated this corpus 2.49x.
		const usage = attributeSkillUsage([USAGE_SPLIT_LINE_1, USAGE_SPLIT_LINE_2, USAGE_SPLIT_LINE_3]);
		expect(usage.get("superpowers:brainstorming")).toEqual({
			input: 1,
			cached: 4162,
			output: 797,
			confidence: "attributed",
		});
	});

	it("excludes cache_read_input_tokens, which is a cumulative counter", () => {
		// The fixture carries cache_read_input_tokens: 67943. Summing it would report
		// ~68k of spend for a response that actually cost 4,960 — and would re-count
		// the same cached prefix again on every following turn.
		const usage = attributeSkillUsage([USAGE_SPLIT_LINE_1]);
		const brainstorming = usage.get("superpowers:brainstorming");
		expect(brainstorming?.input).toBe(1);
		expect(brainstorming?.cached).toBe(4162);
		expect((brainstorming?.input ?? 0) + (brainstorming?.cached ?? 0) + (brainstorming?.output ?? 0)).toBe(4960);
	});

	it("sums distinct responses under the same skill", () => {
		const usage = attributeSkillUsage([USAGE_SPLIT_LINE_1, USAGE_SPLIT_LINE_2, USAGE_SECOND_RESPONSE]);
		expect(usage.get("superpowers:brainstorming")).toEqual({
			input: 3,
			cached: 5029,
			output: 1981,
			confidence: "attributed",
		});
	});

	it("keeps two skills' spend apart", () => {
		const usage = attributeSkillUsage([USAGE_SPLIT_LINE_1, USAGE_OTHER_SKILL]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(797);
		expect(usage.get("superpowers:writing-plans")?.output).toBe(2000);
	});

	it("drops unattributed turns instead of assigning them to a neighbouring skill", () => {
		// These 14 messages are interleaved throughout a real session, not bunched
		// before the first skill. A "first Skill call → next Skill call" window would
		// swallow them; grouping by attribution excludes them correctly.
		const usage = attributeSkillUsage([USAGE_UNATTRIBUTED, USAGE_SPLIT_LINE_1, USAGE_UNATTRIBUTED]);
		expect(usage.get("superpowers:brainstorming")?.cached).toBe(4162);
		expect([...usage.keys()]).toEqual(["superpowers:brainstorming"]);
	});

	it("assigns the response that CALLS a skill to the pre-skill segment", () => {
		// For a 9,857-char body the injection cost lands as cache_creation on the NEXT
		// response, not the calling one. The calling response carries no attribution,
		// so it is excluded — which matters because 7% of Skill calls share their
		// response with other tools.
		const usage = attributeSkillUsage([TOOL_CALL, TOOL_RESULT, TOOL_BODY, USAGE_SPLIT_LINE_1]);
		expect(usage.get("superpowers:brainstorming")?.cached).toBe(4162);
	});

	it("always counts a usage line that carries no message.id", () => {
		// Same rule the commit-level reader uses: a line with no identity cannot be
		// deduped away, so it must count rather than be silently dropped.
		const usage = attributeSkillUsage([USAGE_NO_MESSAGE_ID, USAGE_NO_MESSAGE_ID]);
		expect(usage.get("superpowers:brainstorming")).toEqual({
			input: 6,
			cached: 200,
			output: 100,
			confidence: "attributed",
		});
	});

	it("returns nothing for a transcript with no usage at all", () => {
		expect(attributeSkillUsage([TOOL_CALL, TOOL_RESULT, TOOL_BODY]).size).toBe(0);
	});

	it("ignores malformed lines", () => {
		const usage = attributeSkillUsage(["{bad", USAGE_SPLIT_LINE_1, ""]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(797);
	});

	it("drops a usage-bearing line that is not parseable JSON", () => {
		// The pre-filter is a substring test, so a truncated write — the shape a
		// transcript takes while the host is mid-flush — reaches the parser. It has to
		// fall out of the scan rather than take the whole pass down with it.
		const truncated = '{"type":"assistant","message":{"id":"m","usage":{"output_tokens":5';
		expect(attributeSkillUsage([truncated, USAGE_SPLIT_LINE_1]).get("superpowers:brainstorming")?.output).toBe(797);
	});

	it("drops a usage-bearing line whose JSON is not an object", () => {
		// JSONL is one record per line by convention, not by enforcement; an array
		// would satisfy `JSON.parse` and then read every field as undefined.
		const arrayLine = '[{"usage":{"output_tokens":5}}]';
		expect(attributeSkillUsage([arrayLine, USAGE_SPLIT_LINE_1]).get("superpowers:brainstorming")?.output).toBe(797);
	});

	it("tolerates a usage object missing the optional counters", () => {
		const sparse =
			'{"type":"assistant","timestamp":"2026-07-12T11:00:00.000Z","attributionSkill":"a:b","message":{"id":"m","usage":{"output_tokens":5}}}';
		expect(attributeSkillUsage([sparse]).get("a:b")).toEqual({
			input: 0,
			cached: 0,
			output: 5,
			confidence: "attributed",
		});
	});
});

describe("attributeSkillUsage — agreement with the commit-level reader", () => {
	// These are the tests that keep per-skill numbers from drifting away from the
	// commit total. They compare against the SAME extractor the reader and the
	// per-model split use, so a change to either side fails here rather than
	// showing up as two different token counts for one transcript.
	const parser = getParserForSource("claude");

	it("reports the same segments the commit-level parser reports for one line", () => {
		const mine = attributeSkillUsage([USAGE_SPLIT_LINE_1]).get("superpowers:brainstorming");
		const theirs = parser.parseUsageTokens?.(USAGE_SPLIT_LINE_1, 1);
		expect({ input: mine?.input, cached: mine?.cached, output: mine?.output }).toEqual({
			input: theirs?.input,
			cached: theirs?.cached,
			output: theirs?.output,
		});
	});

	it("dedupes on the same identity the commit-level parser keys on", () => {
		// If one side keyed on something else — the timestamp, the uuid, the whole
		// usage object — the three lines of this response would collapse differently
		// and the two totals would part ways.
		const lines = [USAGE_SPLIT_LINE_1, USAGE_SPLIT_LINE_2, USAGE_SPLIT_LINE_3];
		const keys = new Set(lines.map((l) => parser.parseUsageTokens?.(l, 1)?.dedupKey));
		expect(keys.size).toBe(1);

		const mine = attributeSkillUsage(lines).get("superpowers:brainstorming");
		const single = parser.parseUsageTokens?.(USAGE_SPLIT_LINE_1, 1);
		expect(mine?.output).toBe(single?.output);
	});

	it("agrees on a whole multi-response slice", () => {
		const lines = [USAGE_SPLIT_LINE_1, USAGE_SPLIT_LINE_2, USAGE_SPLIT_LINE_3, USAGE_SECOND_RESPONSE];
		const mine = attributeSkillUsage(lines).get("superpowers:brainstorming");

		// Reader-side sum, deduped exactly as TranscriptReader does it.
		const counted = new Set<string>();
		let expected = 0;
		for (const line of lines) {
			const u = parser.parseUsageTokens?.(line, 1);
			if (u === undefined) continue;
			if (u.dedupKey && counted.has(u.dedupKey)) continue;
			if (u.dedupKey) counted.add(u.dedupKey);
			expected += u.input + u.cached + u.output;
		}
		expect((mine?.input ?? 0) + (mine?.cached ?? 0) + (mine?.output ?? 0)).toBe(expected);
	});

	it("excludes the cumulative cache-read counter on both sides", () => {
		const theirs = parser.parseUsageTokens?.(USAGE_SPLIT_LINE_1, 1);
		const raw = JSON.parse(USAGE_SPLIT_LINE_1).message.usage.cache_read_input_tokens as number;
		expect(raw).toBeGreaterThan(0);
		expect(theirs?.cached).not.toBe(raw);
		expect(attributeSkillUsage([USAGE_SPLIT_LINE_1]).get("superpowers:brainstorming")?.cached).not.toBe(raw);
	});
});

describe("attributeSkillUsage — subagent transcripts", () => {
	it("bills a subagent's spend to the skill that dispatched it", () => {
		// Measured on real data: including subagent files moved one skill's
		// cache_creation from 21k to 199k. A subagent run under a skill is part of
		// that skill's cost, and its inherited attribution says so directly.
		const usage = attributeSkillUsage([USAGE_SPLIT_LINE_1], [[USAGE_SUBAGENT_TURN]]);
		expect(usage.get("superpowers:brainstorming")).toEqual({
			input: 8,
			cached: 34162,
			output: 1697,
			confidence: "attributed",
		});
	});

	it("dedupes across the session and subagent files together", () => {
		// Defensive: a response id must not be counted twice if it somehow appears in
		// both files.
		const usage = attributeSkillUsage([USAGE_SPLIT_LINE_1], [[USAGE_SPLIT_LINE_2]]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(797);
	});

	it("scans every subagent group", () => {
		const usage = attributeSkillUsage([], [[USAGE_SUBAGENT_TURN], [USAGE_OTHER_SKILL]]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(900);
		expect(usage.get("superpowers:writing-plans")?.output).toBe(2000);
	});
});

describe("attributeSkillUsage — interval fallback", () => {
	/** A pre-attribution host: usage-bearing turns with no attributionSkill field. */
	const turn = (id: string, at: string, out: number) =>
		`{"type":"assistant","timestamp":"${at}","message":{"id":"${id}","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_creation_input_tokens":100,"output_tokens":${out}},"content":[{"type":"text","text":"x"}]}}`;

	const userTurn = (at: string) =>
		`{"type":"user","timestamp":"${at}","message":{"role":"user","content":"next question"}}`;

	it("falls back to interval attribution when the host reports no attribution at all", () => {
		// Claude Code below ~2.1.181 emits no attributionSkill. Without a fallback
		// every skill on those transcripts would silently report zero.
		const usage = attributeSkillUsage([
			TOOL_CALL,
			TOOL_RESULT,
			TOOL_BODY,
			turn("m1", "2026-07-12T11:09:00.000Z", 500),
			turn("m2", "2026-07-12T11:10:00.000Z", 300),
		]);
		expect(usage.get("superpowers:brainstorming")).toEqual({
			input: 2,
			cached: 200,
			output: 800,
			confidence: "estimated",
		});
	});

	it("marks fallback numbers as estimated, never as attributed", () => {
		const usage = attributeSkillUsage([TOOL_CALL, turn("m1", "2026-07-12T11:09:00.000Z", 500)]);
		expect(usage.get("superpowers:brainstorming")?.confidence).toBe("estimated");
	});

	it("ends a fallback interval at the next user turn", () => {
		// Attribution clears on the next user prompt and there is no skill-exit
		// record, so an unbounded interval would over-attribute indefinitely.
		const usage = attributeSkillUsage([
			TOOL_CALL,
			turn("m1", "2026-07-12T11:09:00.000Z", 500),
			userTurn("2026-07-12T11:09:30.000Z"),
			turn("m2", "2026-07-12T11:10:00.000Z", 9999),
		]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(500);
	});

	it("ends a fallback interval at the next skill entry", () => {
		const otherCall = TOOL_CALL.replace('"skill":"superpowers:brainstorming"', '"skill":"j:specs"').replace(
			'"toolu_019BtdUXtkPLcwtXEUiUv1Dc"',
			'"toolu_OTHER"',
		);
		const usage = attributeSkillUsage([
			TOOL_CALL,
			turn("m1", "2026-07-12T11:09:00.000Z", 500),
			otherCall,
			turn("m2", "2026-07-12T11:10:00.000Z", 700),
		]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(500);
		expect(usage.get("j:specs")?.output).toBe(700);
	});

	it("excludes the calling response from the fallback interval too", () => {
		// TOOL_CALL itself carries usage (in=2 cache_creation=1412 out=718). The body's
		// injection cost appears on the FOLLOWING response, so the caller belongs to
		// the pre-skill segment on this path as well.
		const usage = attributeSkillUsage([TOOL_CALL, turn("m1", "2026-07-12T11:09:00.000Z", 500)]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(500);
	});

	it("still dedupes repeated lines on the fallback path", () => {
		const repeated = turn("m1", "2026-07-12T11:09:00.000Z", 500);
		const usage = attributeSkillUsage([TOOL_CALL, repeated, repeated, repeated]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(500);
	});

	it("steps over unreadable lines without closing the open interval", () => {
		// Both shapes clear the substring pre-filter and then fail: a truncated write,
		// and a line that parses to an array. Neither is a user turn, so neither may
		// end the interval — dropping the line is the whole of the correct response.
		const truncated = '{"type":"assistant","message":{"id":"mX","usage":{"output_tokens":5';
		const arrayLine = '[{"role":"user"}]';
		// A blank line and a record the pre-filter rejects outright, for the same reason.
		const uninteresting = '{"type":"summary","summary":"Skill coverage work"}';
		const usage = attributeSkillUsage([
			TOOL_CALL,
			"",
			uninteresting,
			truncated,
			arrayLine,
			turn("m1", "2026-07-12T11:09:00.000Z", 500),
		]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(500);
	});

	it("counts every unidentified line in the interval, since none can be deduped", () => {
		// A line with no `message.id` carries no response identity. Collapsing two of
		// them onto each other would silently discard real spend, so the dedupe set is
		// bypassed and both count — the same rule the attributed path follows.
		const anon = (at: string, out: number) =>
			`{"type":"assistant","timestamp":"${at}","message":{"role":"assistant","usage":{"input_tokens":1,"output_tokens":${out}},"content":[{"type":"text","text":"x"}]}}`;
		const usage = attributeSkillUsage([
			TOOL_CALL,
			anon("2026-07-12T11:09:00.000Z", 500),
			anon("2026-07-12T11:10:00.000Z", 300),
		]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(800);
	});

	it("ends the interval at a user record that carries no message body", () => {
		const bare = '{"type":"user","timestamp":"2026-07-12T11:09:30.000Z"}';
		const usage = attributeSkillUsage([
			TOOL_CALL,
			turn("m1", "2026-07-12T11:09:00.000Z", 500),
			bare,
			turn("m2", "2026-07-12T11:10:00.000Z", 9999),
		]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(500);
	});

	it("does not treat a Skill block that names no skill as an entry", () => {
		// A `Skill` tool_use whose input never made it to disk resolves to no id. It
		// must leave the open interval alone: closing it would strand the following
		// turns under no skill at all, which is worse than billing them to the caller.
		const noInput =
			'{"type":"assistant","timestamp":"2026-07-12T11:08:30.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_TRUNC","name":"Skill"}]}}';
		const usage = attributeSkillUsage([TOOL_CALL, noInput, turn("m1", "2026-07-12T11:09:00.000Z", 500)]);
		expect(usage.get("superpowers:brainstorming")?.output).toBe(500);
	});

	it("prefers attribution over intervals whenever even one turn is attributed", () => {
		// Mixed transcript (a host upgraded mid-session). The attributed path is more
		// accurate, so a single attributed turn switches the whole scan to it rather
		// than mixing two confidence levels in one number.
		const usage = attributeSkillUsage([TOOL_CALL, USAGE_SPLIT_LINE_1, turn("m1", "2026-07-12T11:09:00.000Z", 500)]);
		expect(usage.get("superpowers:brainstorming")?.confidence).toBe("attributed");
		expect(usage.get("superpowers:brainstorming")?.output).toBe(797);
	});

	it("returns nothing when a pre-attribution transcript entered no skill", () => {
		expect(attributeSkillUsage([turn("m1", "2026-07-12T11:09:00.000Z", 500)]).size).toBe(0);
	});
});
