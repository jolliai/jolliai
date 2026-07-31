import { describe, expect, it } from "vitest";
import {
	OC_ASSISTANT_MESSAGE,
	OC_NON_SKILL_TOOL,
	OC_SKILL_NO_TOP_METADATA,
	OC_SKILL_WITH_TOP_METADATA,
	OC_USER_MESSAGE,
} from "./__fixtures__/openCodeParts.js";
import { openCodeTurnSpend, scanOpenCodeSkillRows } from "./OpenCodeSkillScanner.js";

/** A `part` row as the reader hands it over: id + ordering key + raw JSON. */
const part = (data: string, at = 1785216878468, id = "prt_1") => ({ id, timeCreated: at, data });

/** A `message` row, same shape. */
const message = (data: string, at = 1785216878500, id = "msg_1") => ({ id, timeCreated: at, data });

describe("scanOpenCodeSkillRows", () => {
	it("captures a skill invocation from the first-class skill tool", () => {
		const { uses } = scanOpenCodeSkillRows([part(OC_SKILL_NO_TOP_METADATA)], []);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("jolli");
		expect(uses[0].source).toBe("opencode");
		expect(uses[0].entryPaths).toEqual(["tool"]);
	});

	it("reads the body length from the inline output, not from the skill file on disk", () => {
		// OpenCode inlines the injected body in `state.output` — unlike Claude, which
		// puts it in a separate record. `state.metadata.dir` names the source directory,
		// but reading that file would measure the file rather than what was injected.
		const { uses } = scanOpenCodeSkillRows([part(OC_SKILL_NO_TOP_METADATA)], []);
		const output = JSON.parse(OC_SKILL_NO_TOP_METADATA).state.output as string;
		expect(uses[0].invocations[0].bodyChars).toBe(output.length);
	});

	it("uses the millisecond timestamp from state.time.start", () => {
		// Epoch ms here, ISO strings in Claude transcripts. The store identifies
		// invocations by this value, so the conversion has to happen exactly once.
		const { uses } = scanOpenCodeSkillRows([part(OC_SKILL_NO_TOP_METADATA)], []);
		expect(uses[0].invocations[0].at).toBe(new Date(1785216878468).toISOString());
	});

	it("tolerates both row shapes — with and without the top-level metadata key", () => {
		// Older rows carry a provider `metadata` at the top level; newer ones omit it
		// entirely. Nothing may depend on its presence.
		const { uses } = scanOpenCodeSkillRows(
			[
				part(OC_SKILL_WITH_TOP_METADATA, 1779005748620, "prt_a"),
				part(OC_SKILL_NO_TOP_METADATA, 1785216878468, "prt_b"),
			],
			[],
		);
		expect(uses.map((u) => u.skill).sort()).toEqual(["comprehensive-review-full-review", "jolli"]);
	});

	it("leaves plugin absent because OpenCode skill names are flat", () => {
		// No `plugin:name` id exists anywhere in the corpus — the namespace lives in the
		// on-disk directory, not in the id, so deriving a plugin from a colon split
		// would invent one.
		const { uses } = scanOpenCodeSkillRows([part(OC_SKILL_NO_TOP_METADATA)], []);
		expect(uses[0].plugin).toBeUndefined();
	});

	it("ignores rows for other tools", () => {
		const { uses } = scanOpenCodeSkillRows([part(OC_NON_SKILL_TOOL)], []);
		expect(uses).toEqual([]);
	});

	it("aggregates repeat entries of one skill into a single use", () => {
		// The invocation identity is state.time.start, so a second entry must carry a
		// different one — varying only the row's storage clock would collapse the two.
		const second = OC_SKILL_NO_TOP_METADATA.replace('"start":1785216878468', '"start":1785216999999');
		const { uses } = scanOpenCodeSkillRows(
			[part(OC_SKILL_NO_TOP_METADATA, 1785216878468, "prt_a"), part(second, 1785216999999, "prt_b")],
			[],
		);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations).toHaveLength(2);
		// Newest first, matching the Claude scanner's contract.
		expect(uses[0].invocations[0].at).toBe(new Date(1785216999999).toISOString());
	});

	it("marks a failed invocation as not ok", () => {
		const errored = OC_SKILL_NO_TOP_METADATA.replace('"status":"completed"', '"status":"error"');
		const { uses } = scanOpenCodeSkillRows([part(errored)], []);
		expect(uses[0].invocations[0].ok).toBe(false);
	});

	it("skips a row still in flight", () => {
		// A pending call has no output and no end time; recording it would report a
		// body size of zero for a skill that may still be loading.
		const pending = OC_SKILL_NO_TOP_METADATA.replace('"status":"completed"', '"status":"pending"');
		expect(scanOpenCodeSkillRows([part(pending)], []).uses).toEqual([]);
	});

	it("ignores malformed row JSON", () => {
		const { uses } = scanOpenCodeSkillRows([part("{not json"), part(OC_SKILL_NO_TOP_METADATA, 1, "prt_b")], []);
		expect(uses).toHaveLength(1);
	});

	it("reports the newest row id so the caller can resume", () => {
		const { lastRowId } = scanOpenCodeSkillRows(
			[part(OC_SKILL_NO_TOP_METADATA, 1, "prt_a"), part(OC_NON_SKILL_TOOL, 2, "prt_b")],
			[],
		);
		// The cursor tracks EVERY row consumed, not only the skill ones — otherwise a
		// scan whose newest rows were all non-skill would re-read them forever.
		expect(lastRowId).toBe("prt_b");
	});
});

describe("openCodeTurnSpend", () => {
	it("excludes cache.read, which is a cumulative counter", () => {
		// Measured on a real session: cache.read ran 0 → 25344 → 25472 → 31488 → …
		// → 63360. Summing it re-counts the cached prefix on every turn.
		const spend = openCodeTurnSpend(JSON.parse(OC_ASSISTANT_MESSAGE));
		expect(spend).toEqual({ input: 89, output: 151, cached: 0 });
	});

	it("never uses the total field, which includes the cumulative counter", () => {
		// `total` is 31728 here and equals the sum of every component INCLUDING
		// cache.read — so trusting it inherits the same inflation.
		const spend = openCodeTurnSpend(JSON.parse(OC_ASSISTANT_MESSAGE));
		const total = (JSON.parse(OC_ASSISTANT_MESSAGE) as { tokens: { total: number } }).tokens.total;
		expect(total).toBe(31728);
		expect((spend?.input ?? 0) + (spend?.output ?? 0) + (spend?.cached ?? 0)).toBeLessThan(total);
	});

	it("folds reasoning into output", () => {
		// Reasoning tokens bill at the output rate — the same fold Pricing.ts documents.
		const spend = openCodeTurnSpend(JSON.parse(OC_ASSISTANT_MESSAGE));
		expect(spend?.output).toBe(47 + 104);
	});

	it("counts cache.write as cached spend", () => {
		// The provider in the fixture never writes cache, but the field exists and maps
		// to Claude's cache_creation — newly written cache IS new work.
		const withWrite = JSON.parse(OC_ASSISTANT_MESSAGE);
		withWrite.tokens.cache.write = 500;
		expect(openCodeTurnSpend(withWrite)?.cached).toBe(500);
	});

	it("returns undefined for a message with no token block", () => {
		expect(openCodeTurnSpend(JSON.parse(OC_USER_MESSAGE))).toBeUndefined();
	});

	it("treats missing counters as zero rather than failing", () => {
		expect(openCodeTurnSpend({ role: "assistant", tokens: { output: 5 } })).toEqual({
			input: 0,
			output: 5,
			cached: 0,
		});
	});
});

describe("scanOpenCodeSkillRows — interval attribution", () => {
	it("estimates a skill's spend from the turns that follow it", () => {
		// OpenCode carries NO per-skill attribution anywhere in its schema, so an
		// interval is the only option — and it is therefore always "estimated", never
		// "attributed".
		const { uses } = scanOpenCodeSkillRows(
			[part(OC_SKILL_NO_TOP_METADATA, 1000, "prt_a")],
			[message(OC_ASSISTANT_MESSAGE, 2000, "msg_a")],
		);
		expect(uses[0].usage).toEqual({ input: 89, output: 151, cached: 0, confidence: "estimated" });
	});

	it("ignores turns that precede the skill call", () => {
		const { uses } = scanOpenCodeSkillRows(
			[part(OC_SKILL_NO_TOP_METADATA, 5000, "prt_a")],
			[message(OC_ASSISTANT_MESSAGE, 1000, "msg_before")],
		);
		expect(uses[0].usage).toBeUndefined();
	});

	it("ends the interval at the next user turn", () => {
		// Nothing marks a skill as finished, so an unbounded interval would attribute
		// the rest of the session to it.
		const { uses } = scanOpenCodeSkillRows(
			[part(OC_SKILL_NO_TOP_METADATA, 1000, "prt_a")],
			[
				message(OC_ASSISTANT_MESSAGE, 2000, "msg_a"),
				message(OC_USER_MESSAGE, 3000, "msg_user"),
				message(OC_ASSISTANT_MESSAGE, 4000, "msg_b"),
			],
		);
		expect(uses[0].usage?.output).toBe(151);
	});

	it("ends the interval at the next skill call", () => {
		// Every occurrence, not just the first: the name appears in BOTH
		// state.input.name and state.metadata.name, and the scanner prefers the metadata
		// one (the resolved name) — so replacing only the first leaves both rows
		// resolving to "jolli" and collapsing into one use.
		const other = OC_SKILL_NO_TOP_METADATA.split('"name":"jolli"').join('"name":"git-commit"');
		const { uses } = scanOpenCodeSkillRows(
			[part(OC_SKILL_NO_TOP_METADATA, 1000, "prt_a"), part(other, 3000, "prt_b")],
			[message(OC_ASSISTANT_MESSAGE, 2000, "msg_a"), message(OC_ASSISTANT_MESSAGE, 4000, "msg_b")],
		);
		const byName = new Map(uses.map((u) => [u.skill, u]));
		expect(byName.get("jolli")?.usage?.output).toBe(151);
		expect(byName.get("git-commit")?.usage?.output).toBe(151);
	});

	it("leaves usage absent when no turn followed the skill", () => {
		// Absent, not zero: the skill ran, we just have nothing to attribute to it.
		const { uses } = scanOpenCodeSkillRows([part(OC_SKILL_NO_TOP_METADATA, 1000, "prt_a")], []);
		expect(uses[0].usage).toBeUndefined();
	});
});
