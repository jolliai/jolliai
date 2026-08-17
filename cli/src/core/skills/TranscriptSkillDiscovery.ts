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
 *
 * ── DELIBERATE — NOT A REVIEW FINDING ────────────────────────────────────────
 * **The mark records a POSITION and not the logic that read it, so improving a
 * scanner never reaches the lines already behind it.** That is a real limitation,
 * it is understood, and it is ACCEPTED — do not re-raise it as a defect.
 *
 * The shape it takes: `SkillUse` reaches two stores through two different routes,
 * and only one of them can be re-derived. The dashboard database carries a
 * `SESSION_READ_GENERATION` stamp (see `DbBackfill`), so bumping that number
 * invalidates every stored session at once and a smarter scanner is applied
 * retroactively. This registry has no equivalent: the mark says "read to line 500",
 * never "read to line 500 with version N of the scanner", so a session it has
 * passed keeps whatever the OLD scanner concluded, permanently and silently.
 *
 * The consequence is a disagreement between the two stores, not a crash and not an
 * empty screen. It shipped for real when Codex skill capture learned to read the
 * `<skill>` block Codex Desktop injects (`CodexSkillScanner`): the generation bump
 * healed the dashboard, so an already-scanned Desktop session now reads as three
 * skills there and zero in the SKILLS panel and on the commit summary, with nothing
 * anywhere comparing the two.
 *
 * "Healed the dashboard" holds for a source with NO lifecycle hook, which is what
 * Codex is — and it is not a general property. On Claude and Gemini the Stop /
 * AfterAgent hook writes the session row with a wall-clock instant that is
 * necessarily ahead of the transcript's last turn, so `projectSession`'s monotonic
 * guard drops the bump's re-read and the dashboard is NOT healed either. That half is
 * documented in place, at the guard in `StatsWriter`, and is likewise deliberate and
 * deferred — do not report either half as a review finding. Sessions started after such a change are unaffected —
 * they have no mark yet and are read from line 0 — so the exposure is bounded to
 * conversations that existed when the scanner changed.
 *
 * Adding a generation key here was CONSIDERED and NOT DONE. It cannot be scoped to
 * the source whose scanner changed: the mark is per transcript with no record of
 * which scanner wrote it, so invalidating it re-reads every source's whole history
 * for every user — a cost decided by product, not by a review. The monotonicity it
 * would break is also load-bearing in its own right (see the paragraph above on
 * what a mark that moves backwards costs). If this is ever revisited, treat it as a
 * migration with a measured re-scan budget, not as a bug fix.
 * ─────────────────────────────────────────────────────────────────────────────
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
