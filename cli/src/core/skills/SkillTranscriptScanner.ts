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
 *   - **A skill concept with no on-disk invocation record at all** — Cursor and
 *     Copilot CLI. Cursor DOES ship skills (`~/.cursor/skills-cursor/`), but a scan
 *     of 139 real chat files and the IDE composer store found ZERO references to
 *     any of them, so there is no envelope to pin a matcher against. Copilot CLI's
 *     `forge_skill_proposals` is an authoring table, not an invocation log. No
 *     matcher may be written for either until a real invocation is captured from a
 *     live run — this repo has shipped a parser whose fixtures and code were both
 *     imagined, which agreed with each other and with nothing real.
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
