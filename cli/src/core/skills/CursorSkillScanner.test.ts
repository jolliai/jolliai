import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_ASSISTANT_TURN,
	CURSOR_CONTROL_RECORD,
	CURSOR_PLAIN_USER_TURN,
	CURSOR_SKILL_GLOBAL,
	CURSOR_SKILL_REPO_AGENTS,
	CURSOR_SKILL_TWO_IN_ONE_TURN,
} from "./__fixtures__/cursorSkillTurns.js";
import { classifySkillOriginRoot, scanCursorSkillLines } from "./CursorSkillScanner.js";
import { skillOutcomeConfidence } from "./SkillOutcomeConfidence.js";

/**
 * The fixtures' paths are rooted at `/Users/dev`, so HOME is pointed there for the
 * duration — `classifySkillOriginRoot` reads it lazily for exactly this reason.
 */
const FIXTURE_HOME = "/Users/dev";
const SYSTEM_HOME = userInfo().homedir;
let realHome: string | undefined;
let realUserProfile: string | undefined;

beforeEach(() => {
	realHome = process.env.HOME;
	realUserProfile = process.env.USERPROFILE;
	process.env.HOME = FIXTURE_HOME;
});
afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	if (realUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = realUserProfile;
});

describe("scanCursorSkillLines", () => {
	it("extracts a skill from a real IDE turn, with its root and its own instant", () => {
		const { uses, lastLine } = scanCursorSkillLines([CURSOR_SKILL_REPO_AGENTS], 0);
		expect(uses).toEqual([
			{
				source: "cursor",
				skill: "jolli-recall",
				entryPaths: ["command"],
				originRoot: "repo-agents",
				// From the `<timestamp>` that FOLLOWS the block, at minute resolution.
				invocations: [{ at: "2026-08-19T08:36:00.000Z", ok: true, entryPath: "command" }],
			},
		]);
		expect(lastLine).toBe(1);
	});

	it("extracts a skill from a real cursor-agent turn — same shape, different root", () => {
		const { uses } = scanCursorSkillLines([CURSOR_SKILL_GLOBAL], 0);
		expect(uses).toEqual([
			{
				source: "cursor",
				skill: "jolli",
				entryPaths: ["command"],
				originRoot: "cursor-global",
				invocations: [{ at: "2026-08-20T07:24:00.000Z", ok: true, entryPath: "command" }],
			},
		]);
	});

	it("keeps the full Path line when Unix or Windows directories contain spaces", () => {
		for (const path of [
			"/Users/dev/My Project/.agents/skills/jolli-recall/SKILL.md",
			"C:\\Users\\dev\\My Project\\.agents\\skills\\jolli-recall\\SKILL.md",
		]) {
			const line = JSON.stringify({
				role: "user",
				message: {
					content: `<manually_attached_skills>\r\nSkill Name: jolli-recall\r\nPath: ${path}  \r\nSKILL.md content:\r\n`,
				},
			});
			const { uses } = scanCursorSkillLines([line], 0);
			expect(uses).toHaveLength(1);
			expect(uses[0]).toMatchObject({ skill: "jolli-recall", originRoot: "repo-agents" });
		}
	});

	it("reports both skills when one turn attaches two, each with its own root", () => {
		const { uses } = scanCursorSkillLines([CURSOR_SKILL_TWO_IN_ONE_TURN], 0);
		expect(uses.map((u) => [u.skill, u.originRoot])).toEqual([
			["jolli-recall", "repo-agents"],
			["jolli-search", "repo-cursor"],
		]);
	});

	it("ignores assistant turns, plain user turns and control records", () => {
		const { uses } = scanCursorSkillLines(
			[CURSOR_ASSISTANT_TURN, CURSOR_PLAIN_USER_TURN, CURSOR_CONTROL_RECORD],
			0,
		);
		expect(uses).toEqual([]);
	});

	it("groups repeat entries of one skill into a single use, newest first", () => {
		const { uses } = scanCursorSkillLines([CURSOR_SKILL_REPO_AGENTS, CURSOR_SKILL_GLOBAL], 0);
		// Two DIFFERENT skills here, so grouping is visible in the repeat below rather
		// than in this line — kept as the ordering guard.
		expect(uses).toHaveLength(2);

		const repeated = scanCursorSkillLines([CURSOR_SKILL_REPO_AGENTS, CURSOR_SKILL_TWO_IN_ONE_TURN], 0);
		const recall = repeated.uses.find((u) => u.skill === "jolli-recall");
		expect(recall?.invocations).toEqual([
			// Newest first: 3:32 PM (the two-skill turn) ahead of 4:36 PM the day before.
			{ at: "2026-08-20T07:32:00.000Z", ok: true, entryPath: "command" },
			{ at: "2026-08-19T08:36:00.000Z", ok: true, entryPath: "command" },
		]);
	});

	it("takes the NEWEST root when one skill was attached from two of them", () => {
		// The opposite of `detection`'s sticky rule: a skill really does move between
		// roots, so pinning the first would keep naming one the host has stopped using.
		// `CURSOR_SKILL_REPO_AGENTS` is the older turn (Aug 19) and carries `.agents`;
		// the two-skill turn is newer (Aug 20) and also carries `.agents` for recall —
		// so this asserts through `jolli-search`, whose only root is `.cursor`.
		const { uses } = scanCursorSkillLines([CURSOR_SKILL_TWO_IN_ONE_TURN, CURSOR_SKILL_REPO_AGENTS], 0);
		expect(uses.find((u) => u.skill === "jolli-search")?.originRoot).toBe("repo-cursor");
	});

	it("resumes from fromLine, skipping already-scanned turns", () => {
		const { uses, lastLine } = scanCursorSkillLines([CURSOR_SKILL_REPO_AGENTS, CURSOR_SKILL_GLOBAL], 1);
		expect(uses.map((u) => u.skill)).toEqual(["jolli"]);
		expect(lastLine).toBe(2);
	});

	it("survives a truncated trailing line — normal while a conversation is live", () => {
		const { uses } = scanCursorSkillLines([CURSOR_SKILL_GLOBAL, '{"role":"user","message":{"con'], 0);
		expect(uses.map((u) => u.skill)).toEqual(["jolli"]);
	});

	it("reports no invocation instant rather than a wrong one when the stamp is missing", () => {
		// An absent stamp must not become epoch 0, which would sort as the oldest call
		// ever made and drop the skill out of every windowed view at the wrong end.
		const noStamp = JSON.stringify({
			role: "user",
			message: {
				content: [
					{
						type: "text",
						text: "<manually_attached_skills>\nSkill Name: jolli\nPath: /Users/dev/.cursor/skills/jolli/SKILL.md\nSKILL.md content:\n",
					},
				],
			},
		});
		const { uses } = scanCursorSkillLines([noStamp], 0);
		expect(uses[0].invocations).toEqual([{ at: "", ok: true, entryPath: "command" }]);
	});

	it("does not treat Skill Name / Path documentation inside a body as another attachment", () => {
		const line = JSON.stringify({
			role: "user",
			message: {
				content: [
					"<manually_attached_skills>",
					"Skill Name: real-skill",
					"Path: /Users/dev/repo/.agents/skills/real-skill/SKILL.md",
					"SKILL.md content:",
					"# Documentation example",
					"Skill Name: phantom-skill",
					"Path: /Users/dev/repo/.agents/skills/phantom-skill/SKILL.md",
					"</manually_attached_skills>",
					"Skill Name: outside-skill",
					"Path: /Users/dev/repo/.agents/skills/outside-skill/SKILL.md",
					"SKILL.md content:",
				].join("\n"),
			},
		});
		const { uses } = scanCursorSkillLines([line], 0);
		expect(uses.map((u) => u.skill)).toEqual(["real-skill"]);
	});

	it("reads a content that arrived as a bare string rather than a part array", () => {
		const bare = JSON.stringify({
			role: "user",
			message: {
				content:
					"<manually_attached_skills>\nSkill Name: jolli\nPath: /Users/dev/.cursor/skills/jolli/SKILL.md\nSKILL.md content:\n<timestamp>Thursday, Aug 20, 2026, 3:24 PM (UTC+8)</timestamp>",
			},
		});
		const { uses } = scanCursorSkillLines([bare], 0);
		expect(uses[0]).toMatchObject({ skill: "jolli", originRoot: "cursor-global" });
	});

	it("never moves the cursor backwards", () => {
		expect(scanCursorSkillLines([], 7).lastLine).toBe(7);
	});

	it("stamps entryPath on every INVOCATION, not only on the bucket's entryPaths set", () => {
		// `skill_invocations.entry_path` is written from `invocation.entryPath`, never
		// from the bucket's set — so leaving it off wrote NULL on every Cursor row and
		// the skill detail's "Entered by" was permanently blank. Claude, Codex and Kimi
		// all stamp it; this asserts Cursor joined them.
		const { uses } = scanCursorSkillLines([CURSOR_SKILL_REPO_AGENTS, CURSOR_SKILL_TWO_IN_ONE_TURN], 0);
		const every = uses.flatMap((u) => u.invocations);
		expect(every.length).toBeGreaterThan(1);
		expect(every.every((i) => i.entryPath === "command")).toBe(true);
	});

	it("keeps the outcome 'assumed' — now because the mechanism reports none, not because entryPath was missing", () => {
		// The stamp above must not accidentally promote Cursor into the
		// outcome-reporting allowlist: this block records that a skill was ATTACHED and
		// carries no result record, so `ok: true` is a default and must stay qualified.
		const { uses } = scanCursorSkillLines([CURSOR_SKILL_REPO_AGENTS], 0);
		const invocation = uses[0].invocations[0];
		expect(invocation.entryPath).toBe("command");
		expect(skillOutcomeConfidence("cursor", invocation.entryPath)).toBe("assumed");
		expect(skillOutcomeConfidence("cursor-cli", invocation.entryPath)).toBe("assumed");
	});
});

describe("classifySkillOriginRoot", () => {
	it("recognises every root observed on a real machine", () => {
		expect(classifySkillOriginRoot("/Users/dev/repo/.agents/skills/jolli-recall/SKILL.md", "/Users/dev")).toBe(
			"repo-agents",
		);
		expect(classifySkillOriginRoot("/Users/dev/.cursor/skills/jolli/SKILL.md", "/Users/dev")).toBe("cursor-global");
		expect(classifySkillOriginRoot("/Users/dev/repo/.cursor/skills/jolli-search/SKILL.md", "/Users/dev")).toBe(
			"repo-cursor",
		);
	});

	it("puts a path inside a plugin bundle ahead of any repo rule", () => {
		// A bundle contains its own `skills/` tree, so a later repo test would claim
		// this path if the plugin check did not lead.
		expect(
			classifySkillOriginRoot(
				"/Users/dev/.cursor/plugins/local/jolli/mirror/jolli-recall/SKILL.md",
				"/Users/dev",
			),
		).toBe("plugin-bundle");
	});

	it("does not treat an unrelated plugins directory as a Cursor plugin bundle", () => {
		expect(
			classifySkillOriginRoot("/Users/dev/plugins/myrepo/.agents/skills/jolli-recall/SKILL.md", "/Users/dev"),
		).toBe("repo-agents");
	});

	it("labels another host's tree as such rather than guessing", () => {
		for (const p of [
			"/Users/dev/repo/.claude/skills/foo/SKILL.md",
			"/Users/dev/repo/.codex/skills/foo/SKILL.md",
			"/Users/dev/.claude/skills/foo/SKILL.md",
		]) {
			expect(classifySkillOriginRoot(p, "/Users/dev")).toBe("other-host");
		}
	});

	it("answers unknown for a path that matches no root", () => {
		expect(classifySkillOriginRoot("/Users/dev/somewhere/else/SKILL.md", "/Users/dev")).toBe("unknown");
	});

	it("classifies a Windows path — the paths are host-written and arrive with backslashes", () => {
		expect(
			classifySkillOriginRoot("C:\\Users\\dev\\repo\\.agents\\skills\\jolli-recall\\SKILL.md", "C:\\Users\\dev"),
		).toBe("repo-agents");
		expect(classifySkillOriginRoot("C:\\Users\\dev\\.cursor\\skills\\jolli\\SKILL.md", "C:\\Users\\dev")).toBe(
			"cursor-global",
		);
	});

	it("does not mistake a repo merely NAMED like a root for the root itself", () => {
		// Matching is on the `/skills/` segment, not on a bare directory name.
		expect(classifySkillOriginRoot("/Users/dev/.cursor/other/thing/SKILL.md", "/Users/dev")).toBe("unknown");
	});

	it("tolerates an empty or trailing-slash home", () => {
		expect(classifySkillOriginRoot("/Users/dev/.cursor/skills/jolli/SKILL.md", "/Users/dev/")).toBe(
			"cursor-global",
		);
		// With no home to compare against, the machine-global root is indistinguishable
		// from any other absolute path — reported as a repo-cursor root by the generic
		// segment rule rather than guessed at.
		expect(classifySkillOriginRoot("/Users/dev/.cursor/skills/jolli/SKILL.md", "")).toBe("repo-cursor");
	});

	it("uses the OS home when a detached process has no HOME or USERPROFILE", () => {
		delete process.env.HOME;
		delete process.env.USERPROFILE;
		const path = join(SYSTEM_HOME, ".cursor", "skills", "jolli", "SKILL.md");
		const line = JSON.stringify({
			role: "user",
			message: {
				content: `<manually_attached_skills>\nSkill Name: jolli\nPath: ${path}\nSKILL.md content:\n`,
			},
		});
		expect(scanCursorSkillLines([line], 0).uses[0]?.originRoot).toBe("cursor-global");
	});
});
