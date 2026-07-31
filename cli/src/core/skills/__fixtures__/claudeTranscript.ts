/**
 * Real Claude Code transcript records, for the skill scanner and discovery tests.
 *
 * Shared rather than duplicated per test file so there is exactly ONE pinned copy
 * of each real shape: if the host changes a field, one edit here makes every
 * consumer fail loudly instead of leaving a stale fixture agreeing with a stale
 * parser.
 */

/**
 * Every fixture below is a real record copied out of `~/.claude/projects/**`,
 * with only the injected body text truncated (its original length is noted) and
 * `thinking` content elided. Field names, nesting, ordering and the presence or
 * absence of every optional key are verbatim.
 *
 * Pinning real records is a hard rule in this repo: a parser and a fixture that
 * were both imagined form a self-consistent, entirely wrong closed loop, and
 * this codebase has shipped that mistake before.
 */

// ─── Skill-tool entry path ───────────────────────────────────────────────────
// Session 4650ec72, lines 46-50. Claude Code 2.1.207.
// NB the tool_result timestamp (…24.966Z) is LATER than the body record that
// follows it (…24.965Z) — association must follow line order, not time order.

export const TOOL_CALL =
	'{"type":"assistant","uuid":"fd8350c4","parentUuid":"cef51397","timestamp":"2026-07-12T11:08:24.954Z","isSidechain":false,"version":"2.1.207","message":{"id":"msg_011Ccx4KUaTe2ammBcwS9WYJ","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":2,"cache_creation_input_tokens":1412,"cache_read_input_tokens":66531,"output_tokens":718,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":1412,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":718,"type":"message"}],"speed":"standard"},"content":[{"type":"tool_use","id":"toolu_019BtdUXtkPLcwtXEUiUv1Dc","name":"Skill","input":{"skill":"superpowers:brainstorming"}}]}}';

export const TOOL_RESULT =
	'{"type":"user","uuid":"d3367db3","parentUuid":"fd8350c4","timestamp":"2026-07-12T11:08:24.966Z","isSidechain":false,"toolUseResult":{"success":true,"commandName":"superpowers:brainstorming"},"version":"2.1.207","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_019BtdUXtkPLcwtXEUiUv1Dc","content":"Launching skill: superpowers:brainstorming"}]}}';

/** Original injected body was 10,280 chars; truncated to 200 here. */
export const TOOL_BODY =
	'{"type":"user","uuid":"d7a20737","parentUuid":"d3367db3","timestamp":"2026-07-12T11:08:24.965Z","isMeta":true,"isSidechain":false,"sourceToolUseID":"toolu_019BtdUXtkPLcwtXEUiUv1Dc","version":"2.1.207","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /Users/flyer/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/brainstorming\\n\\n# Brainstorming Ideas Into Designs\\n\\nHelp turn ideas into fully formed"}]}}';

export const ATTRIBUTED_TURN =
	'{"type":"assistant","uuid":"06716f08","parentUuid":"acc3a274","timestamp":"2026-07-12T11:08:35.523Z","isSidechain":false,"attributionSkill":"superpowers:brainstorming","attributionPlugin":"superpowers","version":"2.1.207","message":{"id":"msg_011Ccx4LXco4MNGLePaxvmHU","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_creation_input_tokens":4162,"cache_read_input_tokens":67943,"output_tokens":797},"content":[{"type":"thinking","thinking":"<elided>"}]}}';

// ─── Slash-command entry path ────────────────────────────────────────────────
// Session e2afc1ff, lines 10-11. Claude Code 2.1.220. Tag order here is
// message-then-name; the other live order is name-then-message (see below).

export const COMMAND_TAGS =
	'{"type":"user","uuid":"1176588a","parentUuid":"023aedb9","timestamp":"2026-07-30T03:42:11.043Z","isSidechain":false,"version":"2.1.220","message":{"role":"user","content":"<command-message>j:specs-pr-review</command-message>\\n<command-name>/j:specs-pr-review</command-name>\\n<command-args>408</command-args>"}}';

/** Original injected body was 15,651 chars. Same timestamp as the tag record. */
export const COMMAND_BODY =
	'{"type":"user","uuid":"d7d3ca2a","parentUuid":"1176588a","timestamp":"2026-07-30T03:42:11.043Z","isMeta":true,"isSidechain":false,"version":"2.1.220","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /Users/flyer/jolli/code/jolli/.claude-plugins/plugins/jolli/skills/specs-pr-review\\n\\n# Spec-Grounded PR Review\\n\\nReview a GitHub Pull Request against how"}]}}';

// Session 146120e5, lines 11-12. NO <command-args> tag at all, and an id with no
// plugin namespace.
export const COMMAND_TAGS_NO_ARGS =
	'{"type":"user","uuid":"01b81e33","parentUuid":"d1f3f343","timestamp":"2026-07-21T05:54:33.624Z","isSidechain":false,"version":"2.1.216","message":{"role":"user","content":"<command-message>jolli-init</command-message>\\n<command-name>/jolli-init</command-name>"}}';

export const COMMAND_BODY_NO_ARGS =
	'{"type":"user","uuid":"cffc3c3a","parentUuid":"01b81e33","timestamp":"2026-07-21T05:54:33.624Z","isMeta":true,"isSidechain":false,"version":"2.1.216","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: /Users/flyer/jolli/code/worktrees/jolli-wt-2/.claude/skills/jolli-init\\n\\n# Initialize Jolli Team Plugin & Memory\\n\\nInstall the Jolli team plugin"}]}}';

// ─── Client-side slash command, NOT a skill ──────────────────────────────────
// Session 4650ec72, lines 21-23. `/mcp` never reaches the model. Note the
// caveat record is itself isMeta AND precedes the tag record.

export const CAVEAT =
	'{"type":"user","uuid":"240a315b","parentUuid":"742f2d98","timestamp":"2026-07-12T11:02:11.116Z","isMeta":true,"isSidechain":false,"version":"2.1.207","message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"}}';

export const CLIENT_COMMAND_TAGS =
	'{"type":"user","uuid":"531eee19","parentUuid":"240a315b","timestamp":"2026-07-12T11:02:11.114Z","isSidechain":false,"version":"2.1.207","message":{"role":"user","content":"<command-name>/mcp</command-name>\\n            <command-message>mcp</command-message>\\n            <command-args></command-args>"}}';

export const CLIENT_SYSTEM_RECORD =
	'{"type":"system","uuid":"fd483ce6","parentUuid":"531eee19","timestamp":"2026-07-12T11:02:11.116Z","isMeta":false,"isSidechain":false,"version":"2.1.207"}';

// ─── Repeated-usage lines (G4) ───────────────────────────────────────────────
// Session 4650ec72, lines 50-52. ONE API response written as three JSONL lines,
// each repeating the entire usage object byte-identically while carrying its own
// distinct timestamp. Summing per line inflates this response threefold.
//
// `cache_read_input_tokens: 67943` is the counter that must NOT be summed: it is
// a per-turn cumulative running total, so adding it across turns re-counts the
// cached prefix every turn. Real spend is input + cache_creation + output.

/** Response msg_…ePaxvmHU, line 1 of 3. in=1 cache_creation=4162 out=797. */
export const USAGE_SPLIT_LINE_1 =
	'{"type":"assistant","timestamp":"2026-07-12T11:08:35.523Z","isSidechain":false,"attributionSkill":"superpowers:brainstorming","attributionPlugin":"superpowers","message":{"id":"msg_011Ccx4LXco4MNGLePaxvmHU","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_creation_input_tokens":4162,"cache_read_input_tokens":67943,"output_tokens":797,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":4162,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":1,"output_tokens":797,"type":"message"}],"speed":"standard"},"content":[{"type":"thinking","thinking":"<elided>"}]}}';

/** Same response, line 2 of 3 — identical usage, different timestamp. */
export const USAGE_SPLIT_LINE_2 =
	'{"type":"assistant","timestamp":"2026-07-12T11:08:38.883Z","isSidechain":false,"attributionSkill":"superpowers:brainstorming","attributionPlugin":"superpowers","message":{"id":"msg_011Ccx4LXco4MNGLePaxvmHU","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_creation_input_tokens":4162,"cache_read_input_tokens":67943,"output_tokens":797,"service_tier":"standard","iterations":[{"input_tokens":1,"output_tokens":797,"type":"message"}],"speed":"standard"},"content":[{"type":"text","text":"先按 brainstorming 流程走。"}]}}';

/** Same response, line 3 of 3. */
export const USAGE_SPLIT_LINE_3 =
	'{"type":"assistant","timestamp":"2026-07-12T11:08:40.441Z","isSidechain":false,"attributionSkill":"superpowers:brainstorming","attributionPlugin":"superpowers","message":{"id":"msg_011Ccx4LXco4MNGLePaxvmHU","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1,"cache_creation_input_tokens":4162,"cache_read_input_tokens":67943,"output_tokens":797,"service_tier":"standard","iterations":[{"input_tokens":1,"output_tokens":797,"type":"message"}],"speed":"standard"},"content":[{"type":"tool_use","id":"toolu_016kHmTpMcRuBMK3sTEX1nwW","name":"TodoWrite","input":{"todos":[]}}]}}';

/** A second, distinct response under the same skill. in=2 cache_creation=867 out=1184. */
export const USAGE_SECOND_RESPONSE =
	'{"type":"assistant","timestamp":"2026-07-12T11:08:44.639Z","isSidechain":false,"attributionSkill":"superpowers:brainstorming","attributionPlugin":"superpowers","message":{"id":"msg_011Ccx4MTcisDbwUJNavSbiB","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":2,"cache_creation_input_tokens":867,"cache_read_input_tokens":72105,"output_tokens":1184,"service_tier":"standard","speed":"standard"},"content":[{"type":"tool_use","id":"toolu_01YXqcPdvMZgYCHbpU81xg47","name":"Bash","input":{"command":"ls"}}]}}';

/** A turn under a DIFFERENT skill, for grouping. in=10 cache_creation=500 out=2000. */
export const USAGE_OTHER_SKILL =
	'{"type":"assistant","timestamp":"2026-07-12T12:00:00.000Z","isSidechain":false,"attributionSkill":"superpowers:writing-plans","attributionPlugin":"superpowers","message":{"id":"msg_OTHER","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":10,"cache_creation_input_tokens":500,"cache_read_input_tokens":90000,"output_tokens":2000},"content":[{"type":"text","text":"x"}]}}';

/** An unattributed turn — interleaved through a real session, never inside a skill. */
export const USAGE_UNATTRIBUTED =
	'{"type":"assistant","timestamp":"2026-07-12T11:00:00.000Z","isSidechain":false,"message":{"id":"msg_NONE","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":4,"cache_creation_input_tokens":60000,"cache_read_input_tokens":100,"output_tokens":3775},"content":[{"type":"text","text":"y"}]}}';

/**
 * A subagent turn. `attributionSkill` here is INHERITED from the parent and never
 * updated, so it correctly bills the subagent's cost to the skill that dispatched
 * it — a subagent run under a skill is part of that skill's cost.
 */
export const USAGE_SUBAGENT_TURN =
	'{"type":"assistant","timestamp":"2026-07-12T11:10:00.000Z","isSidechain":true,"attributionSkill":"superpowers:brainstorming","attributionPlugin":"superpowers","attributionAgent":"Explore","message":{"id":"msg_SUB","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":7,"cache_creation_input_tokens":30000,"cache_read_input_tokens":50000,"output_tokens":900},"content":[{"type":"text","text":"z"}]}}';

/** A usage-bearing line with NO message.id — must always count (cannot dedupe it away). */
export const USAGE_NO_MESSAGE_ID =
	'{"type":"assistant","timestamp":"2026-07-12T11:20:00.000Z","attributionSkill":"superpowers:brainstorming","message":{"role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":3,"cache_creation_input_tokens":100,"output_tokens":50},"content":[{"type":"text","text":"w"}]}}';
