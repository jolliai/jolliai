import { describe, expect, it } from "vitest";
import {
	CODEX_AVAILABLE_SKILLS_LISTING,
	CODEX_CAT_SKILL,
	CODEX_COMPOUND_SKILL,
	CODEX_EXEC_TOOL_COMPOUND_SKILL,
	CODEX_EXEC_TOOL_SKILL,
	CODEX_GLOB_LOOP_OVER_SKILLS,
	CODEX_INJECTED_LOCAL_SKILL_BLOCK,
	CODEX_INJECTED_SKILL_BLOCK,
	CODEX_RG_SEARCH_FOR_SKILLS,
	CODEX_SED_SKILL,
	CODEX_UNRELATED_EXEC,
	CODEX_USER_MESSAGE_WITHOUT_BLOCK,
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

	it("reads a real custom_tool_call, whose command lives in `input` and not `arguments`", () => {
		// The majority form — 619 of 729 shell calls across 41 real session files — and
		// the one this scanner could not see for a year. The predecessor of this test
		// built its record by string-replacing the TYPE of a `function_call` fixture and
		// left `arguments` in place, so it passed while every real `custom_tool_call`
		// was dropped at the field read: 2 of 17 (session, skill) pairs survived on one
		// machine's 7-day window. The fixture is a capture now, which is what makes the
		// assertion mean anything.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_EXEC_TOOL_SKILL, T1)], 0);
		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("comprehensive-review-full-review");
		expect(uses[0].detection).toBe("heuristic");
	});

	it("reads the custom_tool_call form when the command chains other work after the read", () => {
		// How it usually arrives: the capture chained the read with printf, pwd and git
		// status in one `cmd`. The path is no longer at the end of the string, so this
		// exercises the regex against trailing shell text rather than a clean terminator.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_EXEC_TOOL_COMPOUND_SKILL, T1)], 0);
		expect(uses.map((u) => u.skill)).toEqual(["comprehensive-review-full-review"]);
	});

	it("folds both record shapes into one entry for the same skill", () => {
		// A session mixes the two forms freely. Keying on the skill name rather than on
		// the record shape is what stops one skill being reported as two.
		const { uses } = scanCodexSkillLines(
			[codexRecord(CODEX_SED_SKILL, T2), codexRecord(CODEX_EXEC_TOOL_SKILL, T1)],
			0,
		);
		expect(uses).toHaveLength(1);
		expect(uses[0].invocations[0].at).toBe(T1);
	});

	it("ignores a custom_tool_call whose `input` is not a string", () => {
		// Same rule as the `arguments` case below: the path only counts when it is in the
		// text the model ran. A structured object still carries the needle into the raw
		// line, so the pre-filter admits it and the type check is what rejects it.
		const inner = '{"type":"custom_tool_call","name":"exec","input":{"cmd":"cat /x/skills/git-commit/SKILL.md"}}';
		expect(scanCodexSkillLines([codexRecord(inner, T1)], 0).uses).toEqual([]);
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

	// A torn write (Codex appends while the scan runs) leaves a half-flushed line
	// that still carries the needle. Skip it and keep scanning — the lines after
	// it are intact, and the cursor must still advance past the bad one.
	it("skips an unparsable line that carries the needle and keeps scanning", () => {
		const truncated = `{"payload":{"type":"function_call","arguments":"cat /x/skills/foo/SKILL.md`;
		const { uses, lastLine } = scanCodexSkillLines([truncated, codexRecord(CODEX_CAT_SKILL, T1)], 0);
		expect(uses.map((u) => u.skill)).toEqual(["comprehensive-review-full-review"]);
		expect(lastLine).toBe(2);
	});
});

describe("scanCodexSkillLines — the injected block (Codex Desktop)", () => {
	it("records the skill named by an injected block", () => {
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_INJECTED_SKILL_BLOCK, T1)], 0);

		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("documents");
		expect(uses[0].source).toBe("codex");
	});

	it("marks it observed rather than heuristic", () => {
		// The host injects this block only when a skill is actually entered, so unlike a
		// shell read it is not an inference. `detection` is absent for observed captures.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_INJECTED_SKILL_BLOCK, T1)], 0);

		expect(uses[0].detection).toBeUndefined();
	});

	it("attributes it to the command path, not the tool path", () => {
		// The user picked the skill and the host injected it — the same shape as Claude's
		// `/plugin:skill`. A shell read is the model's own doing and stays `tool`.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_INJECTED_SKILL_BLOCK, T1)], 0);

		expect(uses[0].entryPaths).toEqual(["command"]);
	});

	it("splits a namespaced id into skill and plugin", () => {
		// `documents:documents` — keeping the namespace inside `skill` would make one
		// skill two registry rows, since the store keys a row `<source>:<skill>` and the
		// shell heuristic can only ever produce the bare directory name.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_INJECTED_SKILL_BLOCK, T1)], 0);

		expect(uses[0].skill).toBe("documents");
		expect(uses[0].plugin).toBe("documents");
	});

	it("leaves plugin absent for an unnamespaced id", () => {
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_INJECTED_LOCAL_SKILL_BLOCK, T1)], 0);

		expect(uses[0].skill).toBe("jolli-recall");
		expect(uses[0].plugin).toBeUndefined();
	});

	it("withholds the plugin when two namespaces claim the same bare name", () => {
		// Two plugins may ship a same-named skill, and the key here is the bare name — it
		// has to be, or the shell heuristic (which only ever sees a directory name) would
		// stop agreeing with this path and one use would become two rows.
		//
		// So keeping the FIRST namespace would assert, with the confidence of a definite
		// entry, that `documents`' skill ran when `other`'s may be what did. Both uses stay
		// recorded; only the label — the one part the data cannot settle — is withheld.
		const other = CODEX_INJECTED_SKILL_BLOCK.split("documents:documents").join("other:documents");
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_INJECTED_SKILL_BLOCK, T1), codexRecord(other, T2)], 0);

		expect(uses).toHaveLength(1);
		expect(uses[0].skill).toBe("documents");
		expect(uses[0].plugin).toBeUndefined();
		// The second use is not the thing being dropped — that was the other half of this bug.
		expect(uses[0].invocations.map((i) => i.at)).toEqual([T2, T1]);
	});

	it("does not let an UNnamespaced id clear a known plugin", () => {
		// An id with no namespace says nothing about one, so it neither sets nor clears the
		// label — the same direction `SkillStore`'s `use.plugin ?? prior?.plugin` merge takes.
		// Only two NAMED namespaces disagreeing is a conflict.
		const bare = CODEX_INJECTED_SKILL_BLOCK.split("documents:documents").join("documents");
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_INJECTED_SKILL_BLOCK, T1), codexRecord(bare, T2)], 0);

		expect(uses).toHaveLength(1);
		expect(uses[0].plugin).toBe("documents");
	});

	it("learns a plugin when a bare id is followed by a namespaced id", () => {
		// A bare id has no opinion about ownership. A later definite namespace may
		// therefore fill the label without creating a second skill row.
		const bare = CODEX_INJECTED_SKILL_BLOCK.split("documents:documents").join("documents");
		const { uses } = scanCodexSkillLines([codexRecord(bare, T1), codexRecord(CODEX_INJECTED_SKILL_BLOCK, T2)], 0);

		expect(uses).toHaveLength(1);
		expect(uses[0].plugin).toBe("documents");
		expect(uses[0].invocations.map((i) => i.at)).toEqual([T2, T1]);
	});

	it("ignores a user message that names a SKILL.md but carries no block", () => {
		// The block requirement, isolated. Every other non-entry fixture is rejected by the
		// role check first, so this is the only one that can fail when the block test alone
		// is dropped — which is what the available-skills listing's docblock used to claim
		// for itself.
		//
		// The shape is real: a skill pick appears in the user's OWN turn as markdown, and the
		// host answers with the injected block in a separate message. Recording this would
		// turn "the user mentioned a skill" into "the skill ran".
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_USER_MESSAGE_WITHOUT_BLOCK, T1)], 0);

		expect(uses).toEqual([]);
	});

	it("does NOT count the available-skills listing as usage", () => {
		// The listing carries a full `…/skills/<name>/SKILL.md` locator per entry — 27 of
		// them in the captured session — and is re-injected every turn. This is the whole
		// reason the block, and not the path, is the signal outside a shell call.
		const { uses } = scanCodexSkillLines([codexRecord(CODEX_AVAILABLE_SKILLS_LISTING, T1)], 0);

		expect(uses).toEqual([]);
	});

	it("still records the listed skill when it is later actually entered", () => {
		// The listing must not suppress a real entry either — it is neither evidence for
		// nor against use.
		const { uses } = scanCodexSkillLines(
			[codexRecord(CODEX_AVAILABLE_SKILLS_LISTING, T1), codexRecord(CODEX_INJECTED_SKILL_BLOCK, T2)],
			0,
		);

		expect(uses.map((u) => u.skill)).toEqual(["documents"]);
		expect(uses[0].invocations[0].at).toBe(T2);
	});

	it("records BOTH entries when a skill is entered twice, newest first", () => {
		// One row, two invocations. An injected block is a definite entry, so a session that
		// enters a skill twice used it twice — unlike the shell heuristic, where repeated
		// `SKILL.md` reads are one use paged several times.
		//
		// Collapsing these to one invocation stamped at the EARLIEST instant is what this
		// used to do, and it cost two things downstream: `SkillExtractor.toToolCall` wrote
		// `calls: 1`, and it took `lastCallAtMs` as the FIRST use — early enough for a
		// windowed dashboard view starting after that instant to drop the skill entirely.
		// Claude and Kimi both push one invocation per entry, so it also made the agents'
		// rows incomparable.
		const { uses } = scanCodexSkillLines(
			[codexRecord(CODEX_INJECTED_SKILL_BLOCK, T2), codexRecord(CODEX_INJECTED_SKILL_BLOCK, T1)],
			0,
		);

		expect(uses).toHaveLength(1);
		// Newest-first, which is what `SkillUse.invocations` documents — asserted on the
		// whole list rather than on `[0]`, so a regression to one invocation fails here
		// instead of silently passing whichever end it kept.
		expect(uses[0].invocations.map((i) => i.at)).toEqual([T2, T1]);
	});

	it("keeps one invocation when one message injects the same skill twice", () => {
		// Two blocks in ONE record share that record's timestamp, and `SkillStore.foldSkillUse`
		// keys invocations on `at` — so a duplicate would be dropped downstream anyway and
		// would only inflate `calls` on the way there.
		// Duplicated INSIDE the record's `text` value — the fixture is a whole JSON payload,
		// so concatenating two of them would just be unparseable and prove nothing.
		const marker = "<skill>\\n<name>documents:documents</name>";
		const twoBlocks = CODEX_INJECTED_SKILL_BLOCK.split(marker).join(`${marker}\\n${marker}`);
		const { uses } = scanCodexSkillLines([codexRecord(twoBlocks, T1)], 0);

		expect(uses).toHaveLength(1);
		expect(uses[0].invocations.map((i) => i.at)).toEqual([T1]);
	});

	it("prefers the observed entry when the same skill was also read by a shell call", () => {
		// One session can both pick a skill and page through its file. That is one use,
		// and the definite signal is the one worth keeping.
		const shellRead = CODEX_CAT_SKILL.split("comprehensive-review-full-review").join("jolli-recall");
		const { uses } = scanCodexSkillLines(
			[codexRecord(shellRead, T1), codexRecord(CODEX_INJECTED_LOCAL_SKILL_BLOCK, T2)],
			0,
		);

		expect(uses).toHaveLength(1);
		expect(uses[0].detection).toBeUndefined();
		expect(uses[0].entryPaths).toEqual(["command"]);
	});

	it("keeps a shell-only skill alongside an injected one", () => {
		const { uses } = scanCodexSkillLines(
			[codexRecord(CODEX_CAT_SKILL, T1), codexRecord(CODEX_INJECTED_SKILL_BLOCK, T2)],
			0,
		);

		expect(uses.map((u) => u.skill).sort()).toEqual(["comprehensive-review-full-review", "documents"]);
		expect(uses.find((u) => u.skill === "comprehensive-review-full-review")?.detection).toBe("heuristic");
		expect(uses.find((u) => u.skill === "documents")?.detection).toBeUndefined();
	});

	it("ignores an assistant message that quotes the block", () => {
		// Measured across 463 real rollouts: all 47 injected blocks are role "user", and no
		// assistant message carries one. So narrowing costs nothing real and removes the
		// case where a model echoing a skill's own text would be recorded as OBSERVED —
		// a stronger claim than the shell heuristic makes, from weaker evidence.
		const echoed = CODEX_INJECTED_LOCAL_SKILL_BLOCK.split('"role":"user"').join('"role":"assistant"');

		expect(scanCodexSkillLines([codexRecord(echoed, T1)], 0).uses).toEqual([]);
	});

	it("ignores a developer message that carries a real block", () => {
		// The listing arrives as `developer`; nothing else is expected to, but the rule is
		// "user or nothing" rather than "not developer", so this pins the whole complement.
		const injected = CODEX_INJECTED_LOCAL_SKILL_BLOCK.split('"role":"user"').join('"role":"developer"');

		expect(scanCodexSkillLines([codexRecord(injected, T1)], 0).uses).toEqual([]);
	});

	it("does not let a non-user message fall through to the shell heuristic", () => {
		// The `continue` is terminal for EVERY message, not only user ones. An assistant
		// turn whose text happens to name a SKILL.md path must not be re-read as a shell
		// call — that is the available-skills-listing failure through a different door.
		const chatter =
			'{"type":"message","role":"assistant","content":[{"type":"input_text","text":"see /x/skills/documents/SKILL.md"}]}';

		expect(scanCodexSkillLines([codexRecord(chatter, T1)], 0).uses).toEqual([]);
	});

	it("ignores a message that carries no block", () => {
		const plain = '{"type":"message","role":"user","content":[{"type":"input_text","text":"read the SKILL.md"}]}';

		expect(scanCodexSkillLines([codexRecord(plain, T1)], 0).uses).toEqual([]);
	});

	it("ignores an injected block with no timestamp rather than inventing one", () => {
		// Flat records exist, but an invocation without an observed instant cannot be
		// keyed or ordered downstream.
		expect(scanCodexSkillLines([CODEX_INJECTED_LOCAL_SKILL_BLOCK], 0).uses).toEqual([]);
	});

	it("ignores malformed message content parts independently", () => {
		const block = "SKILL.md <skill><name>documents:documents</name></skill>";
		const nonArray = JSON.stringify({ type: "message", role: "user", timestamp: T1, content: block });
		const malformedParts = JSON.stringify({
			type: "message",
			role: "user",
			timestamp: T1,
			content: [null, { text: 42 }],
		});

		expect(scanCodexSkillLines([nonArray, malformedParts], 0).uses).toEqual([]);
	});

	it("ignores a non-message, non-call record that quotes a skill path", () => {
		const output = JSON.stringify({
			type: "custom_tool_call_output",
			output: "cat /x/skills/documents/SKILL.md",
			timestamp: T1,
		});

		expect(scanCodexSkillLines([output], 0).uses).toEqual([]);
	});

	it("advances across a sparse transcript line without reading it", () => {
		const lines = Array<string>(2);
		lines[1] = codexRecord(CODEX_INJECTED_LOCAL_SKILL_BLOCK, T1);

		const result = scanCodexSkillLines(lines, 0);
		expect(result.uses).toHaveLength(1);
		expect(result.lastLine).toBe(2);
	});

	it("ignores a block whose name tag is empty", () => {
		const empty = CODEX_INJECTED_LOCAL_SKILL_BLOCK.split("<name>jolli-recall</name>").join("<name></name>");

		expect(scanCodexSkillLines([codexRecord(empty, T1)], 0).uses).toEqual([]);
	});

	it("keeps a trailing-colon id whole rather than emitting an empty name", () => {
		const trailing = CODEX_INJECTED_LOCAL_SKILL_BLOCK.split("jolli-recall</name>").join("jolli-recall:</name>");
		const { uses } = scanCodexSkillLines([codexRecord(trailing, T1)], 0);

		expect(uses[0].skill).toBe("jolli-recall:");
		expect(uses[0].plugin).toBeUndefined();
	});
});
