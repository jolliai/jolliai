/**
 * Real Cursor `<manually_attached_skills>` turns, copied out of
 * `~/.cursor/projects/*​/agent-transcripts/*​/*.jsonl` with only the home directory
 * rewritten and each skill BODY truncated (the bodies run to ~12 KB and nothing in
 * the scanner reads them).
 *
 * Two things about the real shape drove the scanner and are easy to get wrong:
 *
 *   - **The `<timestamp>` follows the skill block**, not the other way round, and the
 *     user query follows both. A matcher that stopped at the first `</…>` tag, or
 *     that expected the stamp first, reads no instant at all.
 *   - **The user typed a slash command** (`/jolli-recall`, `/jolli`), which is what
 *     "manually attached" means here and why `entryPaths` is `["command"]`. There is
 *     no `Skill` tool call anywhere in these transcripts.
 *
 * `CURSOR_SKILL_REPO_AGENTS` came from an IDE conversation and
 * `CURSOR_SKILL_CLI_SEARCH` from a `cursor-agent` one — the block is byte-identical
 * in shape across the two sources, which is why one scanner serves both.
 */

/** IDE turn, skill loaded from the per-repo `.agents/skills/` tree. */
export const CURSOR_SKILL_REPO_AGENTS = JSON.stringify({
	role: "user",
	message: {
		content: [
			{
				type: "text",
				text: [
					"<manually_attached_skills>",
					"The user has manually attached the following skills to their message.",
					"These skills contain specific instructions or workflows that the user wants you to follow for this request.",
					"Only read the files if needed, the full skill content is inlined here.",
					"",
					"Skill Name: jolli-recall",
					"Path: /Users/dev/develop/code/jolliai/.agents/skills/jolli-recall/SKILL.md",
					"SKILL.md content:",
					"# Jolli Recall",
					"",
					"> Every commit deserves a Memory.",
					"</manually_attached_skills>",
					"<timestamp>Wednesday, Aug 19, 2026, 4:36 PM (UTC+8)</timestamp>",
					"<user_query>",
					"/jolli-recall 看一下,这个工程实现了什么东西",
					"</user_query>",
				].join("\n"),
			},
		],
	},
});

/** cursor-agent turn, skill loaded from the machine-global `~/.cursor/skills/` root. */
export const CURSOR_SKILL_GLOBAL = JSON.stringify({
	role: "user",
	message: {
		content: [
			{
				type: "text",
				text: [
					"<manually_attached_skills>",
					"The user has manually attached the following skills to their message.",
					"Only read the files if needed, the full skill content is inlined here.",
					"",
					"Skill Name: jolli",
					"Path: /Users/dev/.cursor/skills/jolli/SKILL.md",
					"SKILL.md content:",
					"# Jolli Memory",
					"</manually_attached_skills>",
					"<timestamp>Thursday, Aug 20, 2026, 3:24 PM (UTC+8)</timestamp>",
					"<user_query>",
					"/jolli",
					"</user_query>",
				].join("\n"),
			},
		],
	},
});

/**
 * Two skills attached to ONE turn.
 *
 * Assembled from the real single-skill block by repeating its pair — the only edited
 * fixture here, and it is edited in the one dimension the format makes unambiguous
 * (the block's own wording is plural: "the following skills"). Kept because the
 * corpus happens to contain no two-skill turn and the repeat loop needs one.
 */
export const CURSOR_SKILL_TWO_IN_ONE_TURN = JSON.stringify({
	role: "user",
	message: {
		content: [
			{
				type: "text",
				text: [
					"<manually_attached_skills>",
					"The user has manually attached the following skills to their message.",
					"",
					"Skill Name: jolli-recall",
					"Path: /Users/dev/develop/code/jolliai/.agents/skills/jolli-recall/SKILL.md",
					"SKILL.md content:",
					"# Jolli Recall",
					"",
					"Skill Name: jolli-search",
					"Path: /Users/dev/develop/code/jolliai/.cursor/skills/jolli-search/SKILL.md",
					"SKILL.md content:",
					"# Jolli Search",
					"</manually_attached_skills>",
					"<timestamp>Thursday, Aug 20, 2026, 3:32 PM (UTC+8)</timestamp>",
					"<user_query>",
					"/jolli-search",
					"</user_query>",
				].join("\n"),
			},
		],
	},
});

/** An assistant turn carrying tool calls — the scanner must ignore it entirely. */
export const CURSOR_ASSISTANT_TURN = JSON.stringify({
	role: "assistant",
	message: {
		content: [
			{ type: "text", text: "Reading the skill." },
			{ type: "tool_use", name: "Read", input: {} },
		],
	},
});

/** A plain user turn with no skill block. */
export const CURSOR_PLAIN_USER_TURN = JSON.stringify({
	role: "user",
	message: {
		content: [
			{
				type: "text",
				text: "<timestamp>Thursday, Aug 20, 2026, 4:00 PM (UTC+8)</timestamp>\n<user_query>\nhi\n</user_query>",
			},
		],
	},
});

/** A control record — the other real top-level shape (`('status','type')`). */
export const CURSOR_CONTROL_RECORD = JSON.stringify({ type: "turn_ended", status: "completed" });
