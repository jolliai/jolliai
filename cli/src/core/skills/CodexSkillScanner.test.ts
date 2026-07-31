import { describe, expect, it } from "vitest";
import {
	CODEX_CAT_SKILL,
	CODEX_COMPOUND_SKILL,
	CODEX_GLOB_LOOP_OVER_SKILLS,
	CODEX_RG_SEARCH_FOR_SKILLS,
	CODEX_SED_SKILL,
	CODEX_UNRELATED_EXEC,
	codexRecord,
} from "./__fixtures__/codexExecCalls.js";
import { scanCodexSkillLines } from "./CodexSkillScanner.js";

const T1 = "2026-03-03T09:11:34.000Z";
const T2 = "2026-03-03T10:00:00.000Z";

describe("scanCodexSkillLines", () => {
	it("infers a skill from a shell command that reads its SKILL.md", () => {
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_CAT_SKILL, T1)], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("comprehensive-review-full-review");
		expect(uses[0].source).toBe("codex");
	});

	it("marks the capture as heuristic", () => {
		// Codex has no skill tool. The row must say the invocation was INFERRED, or a
		// reader has no way to tell it apart from an observed one.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_CAT_SKILL, T1)], 0);
		expect(uses[0].detection).toBe("heuristic");
	});

	it("reports no token usage at all", () => {
		// Codex records tokens, but attributing a whole turn to "a file was read" would
		// dress a guess up as a measurement. Absent is the honest answer.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_CAT_SKILL, T1)], 0);
		expect(uses[0].usage).toBeUndefined();
	});

	it("recognises the paged-read form, which is the common case", () => {
		// 532 of 549 real reads of one skill were `sed -n '1,220p' <path>`.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_SED_SKILL, T1)], 0);
		expect(uses[0].skill).toBe("comprehensive-review-full-review");
	});

	it("recognises a read chained into a compound command", () => {
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_COMPOUND_SKILL, T1)], 0);
		expect(uses).toHaveLength(1);
	});

	it("rejects a command that SEARCHES for skill files instead of reading one", () => {
		// Real false positive: `rg --files -g 'SKILL.md'` looks for files named
		// SKILL.md. The give-away is the absence of a `.../skills/<name>/` path — a
		// substring match on "SKILL.md" alone would count this as using a skill.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_RG_SEARCH_FOR_SKILLS, T1)], 0);
		expect(uses).toEqual([]);
	});

	it("rejects a loop that enumerates every skill file", () => {
		// Second real false positive, and one the fixtures alone did not surface — it
		// only appeared when the scanner was run over all 1,503 sessions. The path
		// matches structurally but the name segment is the glob `*`: the command is
		// listing skills, not using one.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_GLOB_LOOP_OVER_SKILLS, T1)], 0);
		expect(uses).toEqual([]);
	});

	it("rejects any name segment carrying a glob metacharacter", () => {
		for (const glob of ["*", "?", "[abc]", "{a,b}"]) {
			const line = codexRecord(CODEX_CAT_SKILL.split("comprehensive-review-full-review").join(glob), T1);
			expect(scanCodexSkillLines([line], 0).uses, glob).toEqual([]);
		}
	});

	it("ignores unrelated shell calls", () => {
		expect(scanCodexSkillLines([codexRecord(CODEX_UNRELATED_EXEC, T1)], 0).uses).toEqual([]);
	});

	it("counts one entry per skill however many times the file was read", () => {
		// This is the load-bearing modelling decision. Codex has no entry event — only
		// reads — and one use is routinely several paged reads (49% of real
		// (session, skill) pairs were read more than once, up to 10 times). Counting
		// reads would report a skill "entered 10 times" when it was entered once, so
		// the count is deliberately capped at the only thing the data supports: this
		// session used this skill.
		const { uses } = scanCodexSkillLines(
			[
				codexRecord(CODEX_SED_SKILL, T1),
				codexRecord(CODEX_SED_SKILL, T2),
				codexRecord(CODEX_CAT_SKILL, "2026-03-03T11:00:00.000Z"),
			],
			0,
		);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations).toHaveLength(1);
	});

	it("dates the entry from the FIRST read", () => {
		// The first read is when the skill entered the picture; later reads are the same
		// use continuing.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_SED_SKILL, T2), codexRecord(CODEX_CAT_SKILL, T1)], 0);
		expect(uses[0].invocations[0].at).toBe(T1);
	});

	it("keeps two different skills apart", () => {
		const other = CODEX_CAT_SKILL.split("comprehensive-review-full-review").join("git-commit");
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_CAT_SKILL, T1), codexRecord(other, T2)], 0);
		expect(uses.map((u) => u.skill).sort()).toEqual(["comprehensive-review-full-review", "git-commit"]);
	});

	it("leaves plugin absent — the namespace is a directory, not part of the id", () => {
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_CAT_SKILL, T1)], 0);
		expect(uses[0].plugin).toBeUndefined();
	});

	it("records no body size", () => {
		// A shell read gives no injected-body length. The command may have paged a
		// slice, and the file on disk is not what reached the model.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_CAT_SKILL, T1)], 0);
		expect(uses[0].invocations[0].bodyChars).toBeUndefined();
	});

	it("resumes from the given line", () => {
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_CAT_SKILL, T1)], 1);
		expect(uses).toEqual([]);
	});

	it("reports the last line consumed", () => {
		const { lastLine } = scanCodexSkillLines(
			[codexRecord(CODEX_CAT_SKILL, T1), codexRecord(CODEX_UNRELATED_EXEC, T2)],
			0,
		);
		expect(lastLine).toBe(2);
	});

	it("ignores malformed lines", () => {
		const { uses } = scanCodexSkillLines(["{bad", codexRecord(CODEX_CAT_SKILL, T1)], 0);
		expect(uses).toHaveLength(1);
	});

	it("drops a line with no skill path before it is ever parsed", () => {
		// Named for what it actually exercises: the L79 needle pre-filter, which bails
		// before the envelope is unwrapped. The unwrapping itself is covered by the
		// flat-record cases below — a line without "SKILL.md" cannot reach that code.
		const { uses } = scanCodexSkillLines(['{"type":"turn_context","cwd":"/repo"}'], 0);
		expect(uses).toEqual([]);
	});

	it("unwraps a flat record that carries no payload envelope", () => {
		// Not every Codex line is a response_item; the reader must not assume the shape.
		// The bare fixture IS the flat form — `codexRecord` is what adds the envelope —
		// so this reaches the `: record` fallback that an enveloped line never touches.
		// Flat lines also carry no envelope timestamp, and the payload has none either,
		// so there is no moment to record and the read is dropped rather than guessed at.
		expect(scanCodexSkillLines([CODEX_CAT_SKILL], 0).uses).toEqual([]);
	});

	it("falls back to the payload's own timestamp when the envelope has none", () => {
		// The envelope normally owns the timestamp, but it is not guaranteed to. Taking
		// the payload's is strictly better than dropping an otherwise complete read.
		const inner = `{"type":"function_call","arguments":"{\\"cmd\\":\\"cat /x/skills/git-commit/SKILL.md\\"}","timestamp":"${T1}"}`;
		const { uses } = scanCodexSkillLines([`{"type":"response_item","payload":${inner}}`], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations[0].at).toBe(T1);
	});

	it("accepts the custom_tool_call shape as well as function_call", () => {
		// Codex emits both for shell work. Matching only `function_call` would silently
		// halve the signal for whichever sessions used the other form.
		const inner = CODEX_CAT_SKILL.replace('"type":"function_call"', '"type":"custom_tool_call"');
		expect(scanCodexSkillLines([codexRecord(inner, T1)], 0).uses).toHaveLength(1);
	});

	it("ignores a non-call record even when it quotes a skill path", () => {
		// An assistant message discussing a skill path is not a read of it.
		const inner = CODEX_CAT_SKILL.replace('"type":"function_call"', '"type":"message"');
		expect(scanCodexSkillLines([codexRecord(inner, T1)], 0).uses).toEqual([]);
	});

	it("ignores a line whose JSON is valid but not an object", () => {
		// JSON.parse succeeds on a bare string or array, so the parse guard alone is not
		// enough — property access on the result has to be gated separately.
		expect(scanCodexSkillLines(['"/x/skills/git-commit/SKILL.md"'], 0).uses).toEqual([]);
	});

	it("ignores a call whose arguments are not a string", () => {
		// The path only counts if it is in the shell string the model actually ran. A
		// structured `arguments` object still puts "SKILL.md" in the raw line, so the
		// needle pre-filter lets it through and the type check is what rejects it.
		const inner = '{"type":"function_call","arguments":{"cmd":"cat /x/skills/git-commit/SKILL.md"}}';
		expect(scanCodexSkillLines([codexRecord(inner, T1)], 0).uses).toEqual([]);
	});

	it("rejects a name segment that is a relative-path marker", () => {
		// `/x/skills/../SKILL.md` matches the path shape but names no skill — it points
		// outside the skills root. Recording it would invent a skill called "..".
		for (const dots of [".", ".."]) {
			const stray = CODEX_CAT_SKILL.split("comprehensive-review-full-review").join(dots);
			expect(scanCodexSkillLines([codexRecord(stray, T1)], 0).uses, dots).toEqual([]);
		}
	});

	it("skips a path that is not under a skills directory", () => {
		// A SKILL.md sitting somewhere else is not a skill in a skills root, and the
		// parent-directory name would be meaningless as an id.
		const stray = CODEX_CAT_SKILL.split("/skills/comprehensive-review-full-review/").join("/docs/");
		expect(scanCodexSkillLines([codexRecord(stray, T1)], 0).uses).toEqual([]);
	});
});
