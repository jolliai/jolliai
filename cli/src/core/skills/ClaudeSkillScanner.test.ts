import { describe, expect, it } from "vitest";
import {
	ATTRIBUTED_TURN,
	CAVEAT,
	CLIENT_COMMAND_TAGS,
	CLIENT_SYSTEM_RECORD,
	COMMAND_BODY,
	COMMAND_BODY_NO_ARGS,
	COMMAND_TAGS,
	COMMAND_TAGS_NO_ARGS,
	TOOL_BODY,
	TOOL_CALL,
	TOOL_RESULT,
} from "./__fixtures__/claudeTranscript.js";
import { scanClaudeSkillLines } from "./ClaudeSkillScanner.js";

describe("scanClaudeSkillLines — Skill tool entry path", () => {
	it("captures one invocation from the tool_use / tool_result / body triple", () => {
		const { uses } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY, ATTRIBUTED_TURN], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("superpowers:brainstorming");
		expect(uses[0].entryPaths).toEqual(["tool"]);
		expect(uses[0].invocations).toHaveLength(1);
		expect(uses[0].invocations[0].ok).toBe(true);
	});

	it("measures bodyChars from the body record, not from any skill file on disk", () => {
		// The transcript carries the exact injected text. Disk is not a valid source:
		// a repeat invocation injects a short stub instead of the full body, and
		// bundled skills live under a temp path that is gone by post-commit time.
		const { uses } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY], 0);
		const text = JSON.parse(TOOL_BODY).message.content[0].text as string;
		expect(uses[0].invocations[0].bodyChars).toBe(text.length);
	});

	it("associates the body by sourceToolUseID even though its timestamp precedes the tool_result", () => {
		// Real ordering: tool_result …24.966Z, body …24.965Z. Anything that sorts by
		// time before associating mispairs these two.
		const { uses } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY], 0);
		expect(uses[0].invocations[0].bodyChars).toBeGreaterThan(0);
		expect(uses[0].invocations[0].at).toBe("2026-07-12T11:08:24.954Z");
	});

	it("prefers the resolved commandName from toolUseResult over the requested input.skill", () => {
		// `input.skill` is what the model asked for; `commandName` is what the host
		// actually resolved and launched.
		const renamed = TOOL_CALL.replace('"skill":"superpowers:brainstorming"', '"skill":"brainstorming"');
		const { uses } = scanClaudeSkillLines([renamed, TOOL_RESULT, TOOL_BODY], 0);
		expect(uses[0].skill).toBe("superpowers:brainstorming");
	});

	it("falls back to input.skill when no tool_result was written", () => {
		// A session that ended mid-invocation leaves the tool_use with no result.
		const { uses } = scanClaudeSkillLines([TOOL_CALL], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("superpowers:brainstorming");
		expect(uses[0].invocations[0].bodyChars).toBeUndefined();
	});

	it("rewinds the cursor to before a tool_use whose result has not arrived", () => {
		// Regression: the mark advanced to EOF over an in-flight triple. Since
		// `discovery-cursors.json` is monotonic, the pass that could have supplied the
		// result and body never saw those lines again and the fragment's gaps — no
		// bodyChars, an optimistic ok:true — were frozen permanently.
		const { uses, lastLine } = scanClaudeSkillLines([ATTRIBUTED_TURN, TOOL_CALL], 0);
		// Still REPORTED: a tool_use that reached the transcript is a real entry, and a
		// session killed right there leaves no other evidence of it.
		expect(uses).toHaveLength(1);
		// ...but the mark stops before it, so the next pass re-reads the whole triple.
		expect(lastLine).toBe(1);
	});

	it("advances the cursor normally once every tool_use has its result", () => {
		const { lastLine } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY], 0);
		expect(lastLine).toBe(3);
	});

	it("rewinds to the EARLIEST unresolved tool_use, not the last one seen", () => {
		// Two in-flight entries: stopping at the later one would strand the earlier
		// one's result forever, which is the exact failure the rewind exists to prevent.
		const second = TOOL_CALL.replace('"toolu_019BtdUXtkPLcwtXEUiUv1Dc"', '"toolu_SECOND"').replace(
			'"msg_011Ccx4KUaTe2ammBcwS9WYJ"',
			'"msg_SECOND"',
		);
		const { lastLine } = scanClaudeSkillLines([ATTRIBUTED_TURN, TOOL_CALL, second], 0);
		expect(lastLine).toBe(1);
	});

	it("never rewinds behind the caller's own resume point", () => {
		// The mark is monotonic on disk; returning a value below `fromLine` would ask the
		// caller to move it backwards, which `scanSkillsWithCursor` refuses anyway — but
		// the scanner must not produce the request in the first place.
		const { lastLine } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY, TOOL_CALL], 3);
		expect(lastLine).toBe(3);
	});

	it("does not rewind for an unresolved tool_use when a resolved one follows it", () => {
		// A failed/denied invocation still gets a result, so an entry left unresolved
		// mid-file is only possible while the window is still open at that point. The
		// rewind therefore keys on the entry, not on file position.
		const failed = TOOL_RESULT.replace('"toolUseResult":{"success":true,', '"toolUseResult":{"success":false,');
		const { uses, lastLine } = scanClaudeSkillLines([TOOL_CALL, failed], 0);
		expect(lastLine).toBe(2);
		expect(uses[0].invocations[0].ok).toBe(false);
	});

	it("records a failed invocation as not ok", () => {
		const failed = TOOL_RESULT.replace(
			'"toolUseResult":{"success":true,"commandName":"superpowers:brainstorming"}',
			'"toolUseResult":{"success":false,"commandName":"superpowers:brainstorming"}',
		);
		const { uses } = scanClaudeSkillLines([TOOL_CALL, failed], 0);
		expect(uses[0].invocations[0].ok).toBe(false);
	});

	it("treats an is_error tool_result block as a failed invocation", () => {
		const errored = TOOL_RESULT.replace('"tool_use_id"', '"is_error":true,"tool_use_id"');
		const { uses } = scanClaudeSkillLines([TOOL_CALL, errored], 0);
		expect(uses[0].invocations[0].ok).toBe(false);
	});

	it("carries args through when the model supplied them", () => {
		const withArgs = TOOL_CALL.replace(
			'"input":{"skill":"superpowers:brainstorming"}',
			'"input":{"skill":"superpowers:brainstorming","args":"plan build"}',
		);
		const { uses } = scanClaudeSkillLines([withArgs, TOOL_RESULT], 0);
		expect(uses[0].invocations[0].args).toBe("plan build");
	});

	it("takes the plugin from attributionPlugin when a later turn reports it", () => {
		const { uses } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY, ATTRIBUTED_TURN], 0);
		expect(uses[0].plugin).toBe("superpowers");
	});

	it("derives the plugin from the id prefix when no turn is attributed", () => {
		// Claude Code below ~2.1.181 emits no attribution fields at all.
		const { uses } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT], 0);
		expect(uses[0].plugin).toBe("superpowers");
	});

	it("leaves plugin absent for an id with no namespace", () => {
		const bare = TOOL_CALL.replace('"skill":"superpowers:brainstorming"', '"skill":"jolli-init"');
		const result = TOOL_RESULT.replace('"commandName":"superpowers:brainstorming"', '"commandName":"jolli-init"');
		const { uses } = scanClaudeSkillLines([bare, result], 0);
		expect(uses[0].plugin).toBeUndefined();
	});

	it("aggregates repeat entries of one skill into a single use", () => {
		const second = TOOL_CALL.replace(
			'"timestamp":"2026-07-12T11:08:24.954Z"',
			'"timestamp":"2026-07-12T12:00:00.000Z"',
		)
			.replace('"toolu_019BtdUXtkPLcwtXEUiUv1Dc"', '"toolu_SECOND"')
			.replace('"msg_011Ccx4KUaTe2ammBcwS9WYJ"', '"msg_SECOND"');
		const { uses } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY, second], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations).toHaveLength(2);
		expect(uses[0].invocations.map((i) => i.at)).toEqual(["2026-07-12T12:00:00.000Z", "2026-07-12T11:08:24.954Z"]);
	});

	it("keeps two different skills as two uses", () => {
		const other = TOOL_CALL.replace('"skill":"superpowers:brainstorming"', '"skill":"j:specs"').replace(
			'"toolu_019BtdUXtkPLcwtXEUiUv1Dc"',
			'"toolu_OTHER"',
		);
		const { uses } = scanClaudeSkillLines([TOOL_CALL, other], 0);
		expect(uses.map((u) => u.skill).sort()).toEqual(["j:specs", "superpowers:brainstorming"]);
	});

	it("ignores a non-Skill tool_use sharing the response", () => {
		// 7% of Skill calls share their response with other tools; one observed
		// response held three parallel Agent calls plus a Skill.
		const withAgent = TOOL_CALL.replace(
			'"content":[{"type":"tool_use","id":"toolu_019BtdUXtkPLcwtXEUiUv1Dc","name":"Skill","input":{"skill":"superpowers:brainstorming"}}]',
			'"content":[{"type":"tool_use","id":"toolu_AGENT","name":"Agent","input":{"subagent_type":"Explore"}},{"type":"tool_use","id":"toolu_019BtdUXtkPLcwtXEUiUv1Dc","name":"Skill","input":{"skill":"superpowers:brainstorming"}}]',
		);
		const { uses } = scanClaudeSkillLines([withAgent], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("superpowers:brainstorming");
	});
});

describe("scanClaudeSkillLines — slash-command entry path", () => {
	it("captures a skill the user invoked by typing a slash command", () => {
		// There is no SlashCommand tool anywhere in the corpus, so an extractor keyed
		// only on the Skill tool misses this path entirely.
		const { uses } = scanClaudeSkillLines([COMMAND_TAGS, COMMAND_BODY], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("j:specs-pr-review");
		expect(uses[0].entryPaths).toEqual(["command"]);
		expect(uses[0].invocations[0].args).toBe("408");
	});

	it("parses the tag block by tag name, not by position", () => {
		// Both orders are live in the corpus: message-then-name (73 records) and
		// name-then-message (35, indented 12 spaces).
		const reordered = COMMAND_TAGS.replace(
			"<command-message>j:specs-pr-review</command-message>\\n<command-name>/j:specs-pr-review</command-name>\\n<command-args>408</command-args>",
			"            <command-name>/j:specs-pr-review</command-name>\\n            <command-args>408</command-args>\\n            <command-message>j:specs-pr-review</command-message>",
		);
		const { uses } = scanClaudeSkillLines([reordered, COMMAND_BODY], 0);
		expect(uses[0].skill).toBe("j:specs-pr-review");
		expect(uses[0].invocations[0].args).toBe("408");
	});

	it("handles a tag block with no command-args tag at all", () => {
		const { uses } = scanClaudeSkillLines([COMMAND_TAGS_NO_ARGS, COMMAND_BODY_NO_ARGS], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("jolli-init");
		expect(uses[0].invocations[0].args).toBeUndefined();
	});

	it("treats a present-but-empty command-args tag as no args", () => {
		const empty = COMMAND_TAGS.replace("<command-args>408</command-args>", "<command-args></command-args>");
		const { uses } = scanClaudeSkillLines([empty, COMMAND_BODY], 0);
		expect(uses[0].invocations[0].args).toBeUndefined();
	});

	it("strips the leading slash from the command name", () => {
		const { uses } = scanClaudeSkillLines([COMMAND_TAGS, COMMAND_BODY], 0);
		expect(uses[0].skill).not.toContain("/");
	});

	it("drops a client-side command that never reached the model", () => {
		// `/mcp`, `/plugin`, `/compact` produce a tag record with no injected body.
		// Counting them would report skills that never ran.
		const { uses } = scanClaudeSkillLines([CAVEAT, CLIENT_COMMAND_TAGS, CLIENT_SYSTEM_RECORD], 0);
		expect(uses).toEqual([]);
	});

	it("does not mistake the local-command caveat for a skill body", () => {
		// The caveat record is itself isMeta and PRECEDES the tag record, so a naive
		// "is there an isMeta record nearby" test promotes every client-side command
		// into a skill.
		const { uses } = scanClaudeSkillLines([CAVEAT, CLIENT_COMMAND_TAGS], 0);
		expect(uses).toEqual([]);
	});

	it("does not let one command's caveat validate the next command", () => {
		// Two client-side commands back to back: the second one's caveat must not be
		// read as a body belonging to the first.
		const { uses } = scanClaudeSkillLines(
			[CAVEAT, CLIENT_COMMAND_TAGS, CAVEAT, CLIENT_COMMAND_TAGS, CLIENT_SYSTEM_RECORD],
			0,
		);
		expect(uses).toEqual([]);
	});

	it("does not attach a tool-path body to a command-path entry", () => {
		// A body carrying sourceToolUseID belongs to a Skill tool call. If the
		// command record has no body of its own it is client-side, even when an
		// unrelated tool body follows.
		const { uses } = scanClaudeSkillLines([CLIENT_COMMAND_TAGS, TOOL_BODY], 0);
		expect(uses).toEqual([]);
	});

	it("records both entry paths when one skill was entered each way", () => {
		const commandForSameSkill = COMMAND_TAGS.replace(
			"<command-message>j:specs-pr-review</command-message>\\n<command-name>/j:specs-pr-review</command-name>\\n<command-args>408</command-args>",
			"<command-name>/superpowers:brainstorming</command-name>",
		);
		const { uses } = scanClaudeSkillLines(
			[TOOL_CALL, TOOL_RESULT, TOOL_BODY, commandForSameSkill, COMMAND_BODY],
			0,
		);
		expect(uses).toHaveLength(1);
		expect([...uses[0].entryPaths].sort()).toEqual(["command", "tool"]);
		expect(uses[0].invocations).toHaveLength(2);
	});
});

describe("scanClaudeSkillLines — resumption and robustness", () => {
	it("reports the last line it consumed so the cursor can advance", () => {
		const { lastLine } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY], 0);
		expect(lastLine).toBe(3);
	});

	it("skips lines before the resume point", () => {
		const { uses, lastLine } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY], 3);
		expect(uses).toEqual([]);
		expect(lastLine).toBe(3);
	});

	it("still resolves a triple that straddles the resume point", () => {
		// The tool_use is before the cursor but its body is after. Emitting the
		// invocation twice (once per scan) is harmless — the store dedupes on the
		// timestamp — but losing it is not.
		const { uses } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, TOOL_BODY], 1);
		expect(uses.flatMap((u) => u.invocations)).toHaveLength(0);
	});

	it("ignores malformed JSON lines without aborting the scan", () => {
		const { uses } = scanClaudeSkillLines(["{not json", TOOL_CALL, "", TOOL_RESULT], 0);
		expect(uses).toHaveLength(1);
	});

	it("ignores record types it has never seen", () => {
		// `attachment` and `queue-operation` records appear in real transcripts and
		// are not in any documented union — unknown types must be skipped, not
		// exhaustively matched.
		const unknown = '{"type":"attachment","uuid":"x","timestamp":"2026-07-12T11:08:24.900Z"}';
		const queueOp = '{"type":"queue-operation","message":null}';
		const { uses } = scanClaudeSkillLines([queueOp, TOOL_CALL, unknown, TOOL_RESULT], 0);
		expect(uses).toHaveLength(1);
	});

	it("returns nothing for a transcript with no skill activity", () => {
		const plain =
			'{"type":"assistant","timestamp":"2026-07-12T11:00:00.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":1,"output_tokens":1}}}';
		expect(scanClaudeSkillLines([plain], 0).uses).toEqual([]);
	});

	it("tolerates a body record whose content is a bare string", () => {
		const stringBody = TOOL_BODY.replace(
			'"content":[{"type":"text","text":"Base directory for this skill: /Users/flyer/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/brainstorming\\n\\n# Brainstorming Ideas Into Designs\\n\\nHelp turn ideas into fully formed"}]',
			'"content":"short body"',
		);
		const { uses } = scanClaudeSkillLines([TOOL_CALL, TOOL_RESULT, stringBody], 0);
		expect(uses[0].invocations[0].bodyChars).toBe("short body".length);
	});

	it("orders invocations newest-first across the whole scan", () => {
		const later = TOOL_CALL.replace(
			'"timestamp":"2026-07-12T11:08:24.954Z"',
			'"timestamp":"2026-07-12T23:00:00.000Z"',
		).replace('"toolu_019BtdUXtkPLcwtXEUiUv1Dc"', '"toolu_LATER"');
		const { uses } = scanClaudeSkillLines([TOOL_CALL, later], 0);
		expect(uses[0].invocations[0].at).toBe("2026-07-12T23:00:00.000Z");
	});
});

describe("scanClaudeSkillLines — subagent transcripts", () => {
	it("captures a subagent's own Skill call despite the inherited attribution", () => {
		// Inside a subagent file `attributionSkill` is copied from the parent and never
		// updated, verified on every subagent file in the corpus that contains a Skill
		// call. So a subagent's own invocation is invisible to attribution and must
		// come from the tool_use itself.
		const inSubagent = TOOL_CALL.replace('"isSidechain":false', '"isSidechain":true')
			.replace(
				'"version"',
				'"attributionSkill":"superpowers:subagent-driven-development","attributionAgent":"general-purpose","version"',
			)
			.replace('"skill":"superpowers:brainstorming"', '"skill":"superpowers:test-driven-development"');
		const { uses } = scanClaudeSkillLines([inSubagent], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("superpowers:test-driven-development");
	});
});
