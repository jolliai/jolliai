/**
 * RawTranscriptScanner — historical Claude transcript indexer for back-fill.
 *
 * This module is part of the **isolated** historical back-fill flow and is
 * deliberately decoupled from the live pipeline (StopHook / sessions.json /
 * QueueWorker cursors). The live flow learns a transcript's path from the Stop
 * hook payload; back-fill instead scans every on-disk Claude transcript under
 * `~/.claude/projects/<encoded-cwd>/*.jsonl` and reconstructs, per JSONL line,
 * the signals the attributor needs to map a conversation slice to a historical
 * commit:
 *
 *   - `ts` / `tsMs`      — entry timestamp (the time-window backbone)
 *   - `gitBranch`        — branch the user was on at that moment
 *   - `cwd`              — working dir, used to scope transcripts to this repo
 *   - `editedRel`        — repo-relative paths from Edit/Write/MultiEdit tool
 *                          calls (the file-orthogonality anchor)
 *   - `role` / `content` — the conversational turn (fed to the summarizer)
 *
 * Only Claude Code is supported for now (the `source` field is fixed to
 * "claude"); the record shape leaves room for other sources later.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePathForCompare, toForwardSlash } from "../core/PathUtils.js";
import { parseTranscriptLine } from "../core/TranscriptReader.js";
import { createLogger } from "../Logger.js";

const log = createLogger("RawTranscriptScanner");

/** One indexed Claude JSONL line with the signals the attributor consumes. */
export interface RawEntry {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly source: "claude";
	readonly lineNo: number;
	readonly ts?: string;
	/** Epoch ms parsed from `ts`; `Number.NaN` when absent/unparseable. */
	readonly tsMs: number;
	readonly gitBranch?: string;
	readonly cwd?: string;
	/** Conversational role, when this line carried human/assistant text. */
	readonly role?: "human" | "assistant";
	/** Conversational text (IDE tags stripped), when present. */
	readonly content?: string;
	/** Repo-relative (forward-slash) paths of Edit/Write/MultiEdit targets. */
	readonly editedRel: ReadonlyArray<string>;
	/** Basenames of edited files (fallback matching when relative path drifts). */
	readonly editedBase: ReadonlyArray<string>;
}

/** Predicate deciding whether a transcript entry's `cwd` belongs to the repo. */
export type CwdPredicate = (cwd: string | undefined) => boolean;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Returns the path of `abs` relative to `cwd` in forward-slash form, or null
 * when `abs` is not nested under `cwd`. Case-insensitive prefix match on
 * Windows/macOS (via {@link normalizePathForCompare}) but the returned slice is
 * taken from the original-case forward-slashed path so downstream git-path
 * matching keeps the real casing.
 */
export function relativizeUnderCwd(abs: string, cwd: string | undefined): string | null {
	if (!cwd) return null;
	const absFwd = toForwardSlash(abs);
	const cwdFwd = toForwardSlash(cwd).replace(/\/+$/, "");
	const absCmp = normalizePathForCompare(abs);
	const cwdCmp = normalizePathForCompare(cwd);
	if (absCmp === cwdCmp) return "";
	if (!absCmp.startsWith(`${cwdCmp}/`)) return null;
	// Slice the original-case forward-slashed path by the cwd segment length + 1.
	return absFwd.slice(cwdFwd.length + 1);
}

function basename(p: string): string {
	const fwd = toForwardSlash(p);
	const idx = fwd.lastIndexOf("/");
	return idx >= 0 ? fwd.slice(idx + 1) : fwd;
}

interface ParsedLine {
	editedRel: string[];
	editedBase: string[];
}

/** Extracts edited file paths from one raw JSONL object's tool_use blocks. */
function extractToolSignals(obj: Record<string, unknown>, cwd: string | undefined): ParsedLine {
	const editedRel: string[] = [];
	const editedBase: string[] = [];

	const message = obj.message as Record<string, unknown> | undefined;
	const content = message?.content;
	if (!Array.isArray(content)) return { editedRel, editedBase };

	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type !== "tool_use") continue;
		const name = b.name;
		const input = (b.input ?? {}) as Record<string, unknown>;
		if (typeof name === "string" && EDIT_TOOLS.has(name)) {
			const fp = input.file_path;
			if (typeof fp === "string" && fp.length > 0) {
				editedBase.push(basename(fp));
				const rel = relativizeUnderCwd(fp, cwd);
				editedRel.push(rel && rel.length > 0 ? rel : toForwardSlash(fp));
			}
		}
	}
	return { editedRel, editedBase };
}

/** Parses one JSONL line into a {@link RawEntry}, or null when it should be skipped. */
function parseLine(line: string, lineNo: number, fileSessionId: string, transcriptPath: string): RawEntry | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return null;
	}

	const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
	const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
	const gitBranch = typeof obj.gitBranch === "string" ? obj.gitBranch : undefined;
	const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : fileSessionId;

	const { editedRel, editedBase } = extractToolSignals(obj, cwd);

	// Reuse the live conversational parser so back-fill summaries see byte-identical
	// turn text to the live pipeline (IDE-tag stripping, noise filtering, etc.).
	const conv = parseTranscriptLine(trimmed, lineNo);

	// Drop lines that carry no signal at all (no ts, no edits, no text).
	if (!ts && editedRel.length === 0 && !conv) return null;

	return {
		sessionId,
		transcriptPath,
		source: "claude",
		lineNo,
		ts,
		tsMs: ts ? Date.parse(ts) : Number.NaN,
		gitBranch,
		cwd,
		role: conv?.role,
		content: conv?.content,
		editedRel,
		editedBase,
	};
}

/**
 * Scans every `~/.claude/projects/<dir>/*.jsonl` transcript and returns the
 * entries whose `cwd` satisfies `acceptCwd`, grouped by sessionId and sorted by
 * timestamp ascending within each session.
 *
 * @param acceptCwd  predicate scoping entries to the target repo's worktree(s)
 * @param projectsRoot  override for `~/.claude/projects` (tests inject a temp dir)
 * @param acceptDir  optional pre-filter on the project DIRECTORY name (the
 *   encoded cwd Claude Code names each `~/.claude/projects/<dir>` after). When
 *   given, directories it rejects are skipped WITHOUT being read — a pure
 *   performance narrowing for a host that already knows which repo it wants
 *   (e.g. the desktop Conversations panel scoped to one worktree). It never
 *   changes results versus scanning every dir: `acceptCwd` still gates every
 *   entry, so an over-inclusive `acceptDir` is harmless and an omitted one keeps
 *   the original whole-tree behaviour. Existing callers pass nothing.
 */
export async function scanClaudeTranscripts(
	acceptCwd: CwdPredicate,
	projectsRoot: string = join(homedir(), ".claude", "projects"),
	acceptDir?: (dirName: string) => boolean,
): Promise<Map<string, RawEntry[]>> {
	const bySession = new Map<string, RawEntry[]>();

	let dirents: string[];
	try {
		dirents = await readdir(projectsRoot);
	} catch (err) {
		log.info("No Claude projects dir at %s: %s", projectsRoot, (err as Error).message);
		return bySession;
	}

	for (const dir of dirents) {
		if (acceptDir && !acceptDir(dir)) continue;
		const projectDir = join(projectsRoot, dir);
		let files: string[];
		try {
			files = (await readdir(projectDir)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue; // not a directory / unreadable — skip
		}
		for (const file of files) {
			const transcriptPath = join(projectDir, file);
			const fileSessionId = file.replace(/\.jsonl$/, "");
			let raw: string;
			try {
				raw = await readFile(transcriptPath, "utf8");
			} catch (err) {
				log.debug("Skipping unreadable transcript %s: %s", transcriptPath, (err as Error).message);
				continue;
			}
			const lines = raw.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const entry = parseLine(lines[i], i, fileSessionId, transcriptPath);
				if (!entry) continue;
				if (!acceptCwd(entry.cwd)) continue;
				const list = bySession.get(entry.sessionId);
				if (list) list.push(entry);
				else bySession.set(entry.sessionId, [entry]);
			}
		}
	}

	// Stable chronological order within each session (NaN timestamps sort last).
	for (const list of bySession.values()) {
		list.sort((a, b) => {
			const at = Number.isNaN(a.tsMs) ? Number.POSITIVE_INFINITY : a.tsMs;
			const bt = Number.isNaN(b.tsMs) ? Number.POSITIVE_INFINITY : b.tsMs;
			return at - bt || a.lineNo - b.lineNo;
		});
	}

	log.info("Indexed %d session(s) from %s", bySession.size, projectsRoot);
	return bySession;
}

/**
 * Builds a {@link CwdPredicate} accepting any cwd equal to or nested under one
 * of `repoRoots` (worktree roots). Comparison is separator/case normalized.
 */
export function cwdInRoots(repoRoots: ReadonlyArray<string>): CwdPredicate {
	const roots = repoRoots.map((r) => normalizePathForCompare(r));
	return (cwd) => {
		if (!cwd) return false;
		const c = normalizePathForCompare(cwd);
		return roots.some((r) => c === r || c.startsWith(`${r}/`));
	};
}
