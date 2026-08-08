/**
 * TranscriptSkillDiscovery — source-aware skill scan + persist.
 *
 * Mirrors `TranscriptPlanDiscovery`: pick the per-source scanner, scan from a
 * resume line, upsert each discovered skill into `plans.json.skills`. Like
 * `scanPlansFrom`, this does NOT own the discovery cursor — it returns the line
 * target and the caller persists it, so one caller can drive several extractors
 * against independent high-water marks.
 *
 * **Subagent transcripts are scanned too.** Sidechain records live in a separate
 * file (`<sessionId>/subagents/agent-<agentId>.jsonl`) and are never duplicated
 * into the session file, so a scan of the session alone cannot see a skill a
 * subagent entered. Two consequences forced by the data:
 *
 *   - A subagent's `attributionSkill` is inherited from its parent and never
 *     updated, so its OWN invocation is invisible to attribution and has to come
 *     from the `Skill` tool_use directly.
 *   - Subagent files are short and self-contained, so they are scanned in full
 *     each pass rather than cursor-tracked. Re-emitting an invocation is harmless:
 *     the store identifies invocations by timestamp and folds duplicates away.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createLogger } from "../../Logger.js";
import type { SkillSource, TranscriptSource } from "../../Types.js";
import { loadExtractorCursorLine, saveExtractorCursor, upsertSkillEntry } from "../SessionTracker.js";
import { attributeSkillUsage } from "./SkillAttribution.js";
import { getSkillScanner } from "./SkillTranscriptScanner.js";

const log = createLogger("SkillDiscovery");

/**
 * Scan one transcript for skills against the `skills` extractor's OWN high-water
 * mark, advancing it only when it moved forward.
 *
 * Every discovery site calls this rather than open-coding the three steps, because
 * the cursor protocol — not the scan — is the part that fails silently when it is
 * got wrong. A site that advanced the mark without scanning, or advanced it on a
 * throw, would strand those lines permanently: `discovery-cursors.json` is
 * monotonic, so nothing ever re-reads a line the mark has passed. That is the exact
 * hazard the per-extractor marks were introduced to close, so it must not be
 * re-opened by a copy of this block drifting at one of the three call sites.
 *
 * Deliberately independent of the shared `lineNumber` the plan/reference pair ride:
 * the skills mark neither constrains nor is constrained by how far that cursor
 * advances in the same pass.
 *
 * Never throws — every caller is a hook or a UI tick. A failed pass leaves the mark
 * where it was, so the next pass retries the same window.
 */
export async function scanSkillsWithCursor(
	transcriptPath: string,
	cwd: string,
	source: TranscriptSource,
): Promise<void> {
	try {
		const fromLine = await loadExtractorCursorLine(transcriptPath, "skills", cwd);
		const toLine = await scanSkillsFrom(transcriptPath, fromLine, cwd, source);
		if (toLine > fromLine) await saveExtractorCursor(transcriptPath, "skills", toLine, cwd);
	} catch (err) {
		log.warn("Skill discovery failed for %s: %s", basename(transcriptPath), (err as Error).message);
	}
}

/**
 * Scan `transcriptPath` (and its subagent files) for skill invocations and persist
 * them.
 *
 * Returns the number of lines consumed in the main transcript, for the caller's
 * cursor. Returns 0 for a source with no skill extraction and for an unreadable
 * transcript — this runs inside hooks, which must never fail loudly.
 */
export async function scanSkillsFrom(
	transcriptPath: string,
	fromLine: number,
	cwd: string,
	source: TranscriptSource,
): Promise<number> {
	const scanner = getSkillScanner(source);
	if (scanner === undefined) return 0;

	const lines = await readLines(transcriptPath);
	if (lines === undefined) return 0;

	const { uses, lastLine } = scanner.scan(lines, fromLine);
	const all = [...uses];

	const subagentGroups: string[][] = [];
	for (const subagentPath of await subagentTranscripts(transcriptPath)) {
		const subagentLines = await readLines(subagentPath);
		if (subagentLines === undefined) continue;
		subagentGroups.push(subagentLines);
		all.push(...scanner.scan(subagentLines, 0).uses);
	}

	// Attribution reads from line 0 regardless of the scan cursor: a skill's spend is
	// a property of the whole session, not of the slice discovered in this pass. Its
	// dedupe is keyed on response identity, so re-reading earlier lines re-derives the
	// same total rather than adding to it.
	const usageBySkill = attributeSkillUsage(lines, subagentGroups);

	// `<source>:<sessionId>` — the same key shape stored sessions use, so a detached
	// conversation can be matched against a skill's per-session split.
	//
	// The stem IS the session id for Claude. It is NOT for Codex, whose transcripts
	// are named `rollout-<timestamp>-<uuid>`. That is harmless today only because
	// Codex reports no usage (its capture is heuristic), so the key below is never
	// attached — the field is only set when `usage` is present. If Codex ever gains
	// usage, resolve its real session id here first, or detach will fail to match.
	//
	// Kimi is worse: its file basename is ALWAYS "wire" (the identity lives in the
	// session directory, not the filename), so every Kimi session would collide on
	// `kimi:wire`. `sessionStemFor` resolves the real id from the path for it. Also
	// dormant today (Kimi reports no usage), fixed here so it stays correct if it does.
	const sessionKey = `${scanner.source}:${sessionStemFor(scanner.source, transcriptPath)}`;

	for (const use of all) {
		const usage = usageBySkill.get(use.skill);
		// Absent, never zero: a zero would claim the skill cost nothing, while absent
		// says we could not attribute it. `confidence` carries the rest of that story.
		const withUsage = usage !== undefined ? { ...use, usage, sessionKey } : use;
		// Sequential, not concurrent: every upsert contends for the same plans.lock
		// and the same markdown file, so parallelism here would only serialise on the
		// lock while multiplying the chance of a lock timeout.
		await upsertSkillEntry({ ...withUsage, source: scanner.source }, cwd);
	}

	if (all.length > 0) log.info("Persisted %d skill(s) from %s", all.length, basename(transcriptPath));
	return lastLine;
}

/**
 * Session-id stem for the `<source>:<sessionId>` key. Every source names its
 * transcript file after the session id EXCEPT Kimi, whose transcript is always
 * `.../sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl` — the basename is
 * the constant "wire", so the id has to come from the session directory (three
 * levels up) instead, or all Kimi sessions collide on `kimi:wire`.
 */
function sessionStemFor(source: SkillSource, transcriptPath: string): string {
	if (source === "kimi") return basename(dirname(dirname(dirname(transcriptPath))));
	return basename(transcriptPath).replace(/\.jsonl$/, "");
}

/** Read a transcript's lines, or undefined when it cannot be read. */
async function readLines(path: string): Promise<string[] | undefined> {
	try {
		const raw = await readFile(path, "utf-8");
		// Strip the trailing newline before splitting, then treat an empty result as
		// zero lines. Without both steps a file holding only "\n" splits to [""] and
		// advances the caller's cursor to line 1 over content that does not exist.
		const trimmed = raw.replace(/\n$/, "");
		return trimmed.length === 0 ? [] : trimmed.split("\n");
	} catch {
		return undefined;
	}
}

/**
 * Absolute paths of the subagent transcripts belonging to a session file.
 *
 * `<dir>/<sessionId>.jsonl` → `<dir>/<sessionId>/subagents/agent-*.jsonl`. Each
 * transcript has an `agent-<id>.meta.json` sibling that is not a transcript, so
 * the `.jsonl` suffix check is required, not defensive padding.
 */
async function subagentTranscripts(transcriptPath: string): Promise<ReadonlyArray<string>> {
	const sessionId = basename(transcriptPath).replace(/\.jsonl$/, "");
	const dir = join(dirname(transcriptPath), sessionId, "subagents");
	try {
		const names = await readdir(dir);
		return names
			.filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
			.sort()
			.map((name) => join(dir, name));
	} catch {
		// No subagents directory is the common case.
		return [];
	}
}
