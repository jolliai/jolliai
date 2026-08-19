/**
 * SkillTranscriptScanner — per-source dispatch for skill extraction.
 *
 * Mirrors `PlanTranscriptScanner`. A source with no entry here has no skill
 * extraction, and the two reasons for that are NOT the same:
 *
 *   - **No skill concept on disk at all** — Gemini CLI, Antigravity, Cline and
 *     Devin. There is nothing to capture. Verified by on-disk probe, not assumed.
 *   - **A skill concept whose invocation is only inferable** — Codex, whose
 *     invocation is an `exec_command` reading a `SKILL.md`. Covered here, with
 *     `detection: "heuristic"` on every entry, after 976 real calls across 1,503
 *     session files were measured.
 *   - **A skill concept whose only record is an inference, in a store this table
 *     cannot read** — Cursor. An earlier note here said a scan of 139 chat files and
 *     the IDE composer store found ZERO references, and concluded that no envelope
 *     existed to pin a matcher against; that is OUT OF DATE. Measured on Cursor
 *     3.15.x: `state.vscdb` under the app's `globalStorage` holds one `cursorDiskKV`
 *     row per conversation, keyed `composerData:<composerId>`, whose
 *     `fullConversationHeadersOnly` array carries one entry per bubble with `type`
 *     (1 = user, 2 = assistant), a millisecond `createdAt`, and — on a tool bubble —
 *     `grouping.toolCallCase` plus `grouping.toolDisplayPath`. A skill appears as
 *     `toolCallCase: "readToolCall"` whose path ends `skills/<name>/SKILL.md`, and it
 *     was captured live: a natural-language request naming the skill, then 44 s later
 *     a read of `.claude/skills/jolli-recall/SKILL.md`.
 *
 *     An envelope therefore EXISTS, and it is the same KIND as Codex CLI's — a file
 *     read, not an entry event — so it would carry `detection: "heuristic"`. Two
 *     things still block a scanner, and neither of them is "no data". It is not
 *     line-oriented JSONL, so it needs a reader of its own the way OpenCode does
 *     rather than an entry in this table. And its coverage is UNMEASURED: in that
 *     same capture the agent read the `SKILL.md` and then went straight to
 *     `getMcpToolsToolCall`, so a skill whose body routes to MCP may well be entered
 *     with no file read to infer from at all. One conversation is not a corpus, which
 *     is what the warning below is about.
 *
 *     `ItemTable`'s `cursor.skills.recentlyUsed` is NOT a second source: a
 *     machine-global LRU of `<name>/SKILL.md` strings carrying no time, no
 *     conversation and no entry path, so it can prove a skill was used and no more.
 *
 *   - **A skill concept with no on-disk invocation record at all** — Copilot CLI,
 *     whose `forge_skill_proposals` is an authoring table, not an invocation log. No
 *     matcher may be written until a real invocation is captured from a live run —
 *     this repo has shipped a parser whose fixtures and code were both imagined,
 *     which agreed with each other and with nothing real.
 *
 * OpenCode IS covered, but not through this table: its transcripts are SQLite rows
 * rather than JSONL lines, so it has its own reader
 * (`OpenCodeSkillDiscovery.discoverOpenCodeSkills`) driven from the 60-second
 * polling tick. This table only serves the line-oriented `scanSkillsFrom` path.
 */

import type { SkillSource, TranscriptSource } from "../../Types.js";
import { type SkillScanResult, scanClaudeSkillLines } from "./ClaudeSkillScanner.js";
import { scanCodexSkillLines } from "./CodexSkillScanner.js";
import { scanKimiSkillLines } from "./KimiSkillScanner.js";

/** Scans already-read transcript lines for skill invocations. */
export type SkillLineScanner = (lines: ReadonlyArray<string>, fromLine: number) => SkillScanResult;

const SCANNERS: Partial<Record<TranscriptSource, { source: SkillSource; scan: SkillLineScanner }>> = {
	claude: { source: "claude", scan: scanClaudeSkillLines },
	// Codex produces BOTH kinds, because its two hosts differ. Codex Desktop injects a
	// `<skill>` block on a real entry (observed, no marker); the CLI has no such
	// mechanism, so there it stays an inference from a shell command that read a
	// SKILL.md (`detection: "heuristic"`). See `CodexSkillScanner`.
	codex: { source: "codex", scan: scanCodexSkillLines },
	// Kimi ships a real `Skill` tool, so its invocations are OBSERVED (no
	// `detection` marker) — its wire.jsonl carries a `tool.call` named "Skill".
	kimi: { source: "kimi", scan: scanKimiSkillLines },
};

/** The scanner for `source`, or undefined when that source has no skill extraction. */
export function getSkillScanner(source: TranscriptSource): { source: SkillSource; scan: SkillLineScanner } | undefined {
	return SCANNERS[source];
}
