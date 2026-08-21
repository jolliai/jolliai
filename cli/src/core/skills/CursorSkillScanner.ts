/**
 * CursorSkillScanner — extracts skill invocations from a Cursor `agent-transcripts`
 * JSONL, for BOTH Cursor sources (the IDE's Agents Window and cursor-agent).
 *
 * ## The envelope, and why this file exists at all
 *
 * `SkillTranscriptScanner`'s header used to record that Cursor had no on-disk
 * invocation record: "a scan of 139 real chat files and the IDE composer store
 * found ZERO references to any of them, so there is no envelope to pin a matcher
 * against." That measurement was right about the places it looked and wrong about
 * the conclusion — it never looked at `~/.cursor/projects/<enc>/agent-transcripts/`,
 * where Cursor injects an explicit, structured block into the user turn:
 *
 *     <manually_attached_skills>
 *     The user has manually attached the following skills to their message.
 *     …
 *     Only read the files if needed, the full skill content is inlined here.
 *
 *     Skill Name: jolli-recall
 *     Path: /Users/me/repo/.agents/skills/jolli-recall/SKILL.md
 *     SKILL.md content:
 *     # Jolli Recall
 *     …
 *
 * Measured across 10 real transcripts: 4 carried the block, and the shape is
 * IDENTICAL for the IDE and the CLI — which is why one scanner serves both keys in
 * the dispatch table.
 *
 * ## Observed, not inferred — and only one of the two entry paths
 *
 * This is a real record of the act, so it carries NO `detection: "heuristic"`
 * marker (contrast `CodexSkillScanner`, whose only signal is a shell command that
 * happened to read a `SKILL.md`). But it covers exactly one entry path: the block
 * is named `manually_attached_skills` and its own text says "The user has manually
 * attached" — a user @-mention, so `entryPaths` is `["command"]`, never `"tool"`.
 *
 * **The agent-decided path is NOT covered here, and no sample of it exists yet.**
 * Its complement is the `readToolCall` heuristic over `composerData`
 * (`grouping.toolDisplayPath` ending `skills/<name>/SKILL.md`), which is a
 * genuinely different signal rather than a worse version of this one: on the three
 * manually-attached captures above that heuristic matched 0 of 3, because the block
 * INLINES the body and so produces no file read to infer from. Whichever is added
 * next, treat the two as complementary; neither is the complete picture.
 *
 * ## Timestamps come from the turn's text, not from a field
 *
 * These JSONL records carry no time field of any kind (every record's keys are
 * `('message','role')` or `('status','type')`). What every user turn DOES carry is
 * an embedded `<timestamp>Thursday, Aug 20, 2026, 4:00 PM (UTC+8)</timestamp>`
 * (10/10 real transcripts, minute resolution) — the same stamp
 * `CursorCliTranscriptReader` parses for its per-commit cutoff, reused here through
 * the shared parser so the two cannot drift. An unparseable or absent stamp yields
 * `at: ""`, matching what `KimiSkillScanner` does with a malformed `time`.
 */

import { userInfo } from "node:os";
import { createLogger } from "../../Logger.js";
import type { SkillInvocation, SkillOriginRoot, SkillUse } from "../../Types.js";
import { cursorTurnTimestampMs } from "../CursorTurnTimestamp.js";
import { toForwardSlash } from "../PathUtils.js";
import type { SkillScanResult } from "./ClaudeSkillScanner.js";

const log = createLogger("CursorSkillScanner");

/**
 * Cheap pre-filter and exact envelope bounds. Skill bodies are inlined inside this
 * element, so the scanner must not run a pair regex over the whole decoded user turn.
 */
const BLOCK_NEEDLE = "<manually_attached_skills>";
const BLOCK_END = "</manually_attached_skills>";

/** The three host-written metadata lines before each inlined skill body. */
const SKILL_NAME_LINE_RE = /^[ \t]*Skill Name:[ \t]*(\S+)[ \t]*$/;
const SKILL_PATH_LINE_RE = /^[ \t]*Path:[ \t]*(.*\S)[ \t]*$/;
const SKILL_BODY_MARKER_RE = /^[ \t]*SKILL\.md content:[ \t]*$/;

interface ScannedSkill {
	readonly skill: string;
	readonly at: string;
	readonly originRoot: SkillOriginRoot;
}

/**
 * Classifies the skill root a `Path:` points into.
 *
 * Ordered most-specific first, and the plugin-bundle test leads deliberately: a
 * bundle contains its own `skills/` tree, so a path inside one would otherwise
 * match a repo rule by accident.
 *
 * Every test is on the forward-slash form via {@link toForwardSlash} — the paths
 * are absolute and host-written, so on Windows they arrive with backslashes and a
 * literal `/.agents/skills/` test would silently match nothing there. Matching is
 * on the SEGMENT (`/skills/` included) rather than on a bare directory name, so a
 * repo that merely happens to be called `.cursor` cannot be mistaken for the root.
 */
export function classifySkillOriginRoot(path: string, home: string): SkillOriginRoot {
	const p = toForwardSlash(path);
	const h = toForwardSlash(home).replace(/\/+$/, "");
	if (p.includes("/.cursor/plugins/")) return "plugin-bundle";
	if (h.length > 0 && p.startsWith(`${h}/.cursor/skills/`)) return "cursor-global";
	if (p.includes("/.agents/skills/")) return "repo-agents";
	if (p.includes("/.cursor/skills/")) return "repo-cursor";
	// Every other tree Cursor reads from is another host's — `.claude/skills/`,
	// `.codex/skills/` and their `~` variants all share this shape. Listed rather
	// than inferred from "not one of ours" so an unrecognised layout still reports
	// `unknown` instead of being mislabelled as a sibling host's.
	if (/\/\.(claude|codex|gemini|opencode|windsurf|github)\/skills\//.test(p)) return "other-host";
	return "unknown";
}

interface AttachedSkillHeader {
	readonly skill: string;
	readonly path: string;
}

/**
 * Extracts only Cursor's host-written metadata triples from attachment envelopes.
 *
 * The third line is load-bearing: a skill body's prose can itself document adjacent
 * `Skill Name:` / `Path:` lines. Treating that pair as another attachment creates a
 * phantom invocation. Requiring Cursor's `SKILL.md content:` marker, keeping the match
 * inside the envelope, and checking that the path's parent directory names the same
 * skill separates the host header from ordinary documentation without changing the
 * repeated-header shape used when one turn attaches multiple skills.
 */
function attachedSkillHeaders(text: string): ReadonlyArray<AttachedSkillHeader> {
	const headers: AttachedSkillHeader[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const open = text.indexOf(BLOCK_NEEDLE, cursor);
		if (open < 0) break;
		const contentStart = open + BLOCK_NEEDLE.length;
		const close = text.indexOf(BLOCK_END, contentStart);
		// A complete JSONL record normally carries the closing tag. Treating the rest of
		// the turn as the envelope when it does not preserves captures from older builds
		// that emitted an unterminated wrapper.
		const block = text.slice(contentStart, close < 0 ? text.length : close);
		const lines = block.split(/\r?\n/);
		for (let i = 0; i + 2 < lines.length; i++) {
			const name = SKILL_NAME_LINE_RE.exec(lines[i]);
			const path = SKILL_PATH_LINE_RE.exec(lines[i + 1]);
			if (!name || !path || !SKILL_BODY_MARKER_RE.test(lines[i + 2])) continue;
			const skillPath = path[1].trim();
			const parts = toForwardSlash(skillPath).replace(/\/+$/, "").split("/");
			if (parts.at(-1) !== "SKILL.md" || parts.at(-2) !== name[1]) continue;
			headers.push({ skill: name[1], path: skillPath });
			i += 2;
		}
		if (close < 0) break;
		cursor = close + BLOCK_END.length;
	}
	return headers;
}

/**
 * Scan Cursor transcript lines for skill invocations.
 *
 * `fromLine` is the 0-based resume index. Returns one {@link SkillUse} per distinct
 * skill (invocations newest-first) and the 1-based highest line consumed.
 *
 * There is no pending/pairing state and therefore no cursor rewind, unlike the
 * Claude and Kimi scanners: this block is self-contained in ONE record — the skill,
 * its path and the whole body arrive together — so nothing can be left half-read at
 * the window boundary. `ok` is always true for the same reason: the block records
 * that the skill was attached, and there is no result record that could fail.
 */
export function scanCursorSkillLines(lines: ReadonlyArray<string>, fromLine: number): SkillScanResult {
	const scanned: ScannedSkill[] = [];
	let lastLine = fromLine;
	const home = homeDir();

	for (let i = fromLine; i < lines.length; i++) {
		lastLine = i + 1;
		const raw = lines[i];
		if (raw.length === 0 || !raw.includes(BLOCK_NEEDLE)) continue;

		let record: unknown;
		try {
			record = JSON.parse(raw);
		} catch {
			// A truncated trailing line is normal while a conversation is live.
			continue;
		}
		const text = userTurnText(record);
		if (text === undefined) continue;

		// Parsed out of the DECODED text rather than the raw JSON line: the block's
		// newlines are `\n` escapes on the wire, which the header parser cannot match.
		const at = isoFromTurn(record);
		for (const header of attachedSkillHeaders(text)) {
			scanned.push({ skill: header.skill, at, originRoot: classifySkillOriginRoot(header.path, home) });
		}
	}

	const uses = assemble(scanned);
	if (uses.length > 0) log.debug("Scanned %d Cursor skill(s) from lines %d..%d", uses.length, fromLine + 1, lastLine);
	return { uses, lastLine: Math.max(fromLine, lastLine) };
}

/** Group by skill id into one {@link SkillUse} each, invocations newest-first. */
function assemble(scanned: ReadonlyArray<ScannedSkill>): ReadonlyArray<SkillUse> {
	const bySkill = new Map<string, ScannedSkill[]>();
	for (const entry of scanned) {
		const prior = bySkill.get(entry.skill);
		if (prior === undefined) bySkill.set(entry.skill, [entry]);
		else prior.push(entry);
	}

	const uses: SkillUse[] = [];
	for (const [skill, group] of bySkill) {
		// Newest-first, matching ClaudeSkillScanner.assemble.
		const sorted = [...group].sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
		// `entryPath` is stamped PER INVOCATION, not left to the bucket's `entryPaths`
		// set — the same rule Claude, Codex and Kimi already follow. It is what reaches
		// `skill_invocations.entry_path`, so omitting it wrote NULL on every Cursor row
		// and the skill detail's "Entered by" was permanently blank; it is also what
		// `skillOutcomeConfidence` reads, which was reaching its `entryPath === undefined`
		// branch rather than deciding on the mechanism.
		//
		// Always `"command"`, hard-coded for the same reason the bucket's `entryPaths` is:
		// the block is named `manually_attached_skills` and its own text says "The user
		// has manually attached" — a user @-mention. The agent-decided path produces a
		// different record shape this scanner does not match (see the header).
		const invocations: SkillInvocation[] = sorted.map((e) => ({
			at: e.at,
			ok: true,
			entryPath: "command" as const,
		}));
		// The NEWEST observation wins: a skill really can move between roots (a repo
		// gains `.cursor/skills/` when `.agents/skills/` stops supplying it), so unlike
		// `detection` this is not sticky. `sorted` is newest-first, so index 0 is it.
		uses.push({ source: "cursor", skill, entryPaths: ["command"], invocations, originRoot: sorted[0].originRoot });
	}
	return uses;
}

/** The text of a `role:"user"` record, or undefined when this is not one. */
function userTurnText(record: unknown): string | undefined {
	if (!isRecord(record) || record.role !== "user") return undefined;
	const message = isRecord(record.message) ? record.message : undefined;
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** ISO instant of this turn's embedded `<timestamp>`, or "" when it has none. */
function isoFromTurn(record: unknown): string {
	const ms = cursorTurnTimestampMs(record);
	if (ms === undefined) return "";
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/**
 * Read lazily rather than captured at module load: tests redirect HOME per case,
 * and a module-level constant would freeze whichever value happened to be set when
 * the module was first imported.
 */
function homeDir(): string {
	const fromEnv = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
	return fromEnv || userInfo().homedir;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
