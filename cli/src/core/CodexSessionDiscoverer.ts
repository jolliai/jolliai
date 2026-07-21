/**
 * Codex Session Discoverer
 *
 * On-demand scanner for OpenAI Codex CLI sessions. Since Codex has no
 * lifecycle hook we can use (the Stop hook needs per-user manual trust and is
 * broken under git worktrees), sessions are discovered by scanning the
 * filesystem. This runs both at post-commit time (for summaries) and on the
 * VS Code sidebar's 60s Active Conversations tick — the latter also drives
 * Codex reference extraction (Linear/Jira/GitHub/Notion) via
 * `CodexDiscovery.discoverCodexConversations`, which reuses the shared
 * `discovery-cursors.json` incremental cursor.
 *
 * Algorithm:
 *   1. Scan ~/.codex/sessions/YYYY/MM/DD/ for recent JSONL files
 *   2. Read only line 1 of each file (session_meta) to extract cwd
 *   3. Match cwd against the project dir via sessionDirBelongsToRepo (prefix/
 *      containment + nested-repo exclusion, shared with Devin/OpenCode/Copilot)
 *   4. Also scan ~/.codex/archived_sessions/ for recently archived sessions
 *   5. Return matching sessions as SessionInfo[] with source="codex"
 *
 * Performance: Only date directories within the 48h staleness window are
 * scanned, avoiding traversal of old session files.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";

const log = createLogger("CodexDiscoverer");

/** Sessions older than 48 hours are considered stale (matches Claude session staleness) */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/** Base directory for Codex data */
const CODEX_DIR_NAME = ".codex";

/**
 * Discovers Codex CLI sessions relevant to the given project directory.
 * Scans ~/.codex/sessions/ for JSONL files whose session_meta.cwd matches
 * the project directory. Only returns sessions updated within the staleness
 * window (48 hours).
 *
 * @param projectDir - The git repository root to match sessions against
 * @returns Array of matching sessions with source="codex"
 */
export async function discoverCodexSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const codexBase = join(homedir(), CODEX_DIR_NAME);
	const resolvedProject = resolve(projectDir);
	const sessions: SessionInfo[] = [];

	// Scan active sessions in date-organized directories
	const sessionsDir = join(codexBase, "sessions");
	const activeSessions = await scanSessionsDirectory(sessionsDir, resolvedProject);
	sessions.push(...activeSessions);

	// Scan archived sessions (flat directory)
	const archivedDir = join(codexBase, "archived_sessions");
	const archivedSessions = await scanFlatDirectory(archivedDir, resolvedProject);
	sessions.push(...archivedSessions);

	log.debug("Discovered %d Codex session(s)", sessions.length);
	return sessions;
}

/**
 * Checks whether the Codex CLI data directory exists.
 * Used by the Installer to detect Codex CLI presence.
 */
export async function isCodexInstalled(): Promise<boolean> {
	const sessionsDir = join(homedir(), CODEX_DIR_NAME);
	try {
		const dirStat = await stat(sessionsDir);
		return dirStat.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Scans the date-organized ~/.codex/sessions/YYYY/MM/DD/ directory structure.
 * Only traverses date directories within the 48h staleness window.
 */
async function scanSessionsDirectory(sessionsDir: string, resolvedProject: string): Promise<SessionInfo[]> {
	const results: SessionInfo[] = [];
	const recentDates = getRecentDateDirs();

	let yearDirs: string[];
	try {
		yearDirs = await readdir(sessionsDir);
	} catch {
		log.debug("Codex sessions directory not found: %s", sessionsDir);
		return results;
	}

	for (const year of yearDirs) {
		// Quick filter: only process years that could contain recent sessions
		if (!recentDates.some((d) => d.startsWith(year))) {
			continue;
		}

		const yearPath = join(sessionsDir, year);
		let monthDirs: string[];
		try {
			monthDirs = await readdir(yearPath);
		} catch {
			continue;
		}

		for (const month of monthDirs) {
			const monthKey = `${year}/${month}`;
			if (!recentDates.some((d) => d.startsWith(monthKey))) {
				continue;
			}

			const monthPath = join(yearPath, month);
			let dayDirs: string[];
			try {
				dayDirs = await readdir(monthPath);
			} catch {
				continue;
			}

			for (const day of dayDirs) {
				const dateKey = `${year}/${month}/${day}`;
				if (!recentDates.includes(dateKey)) {
					continue;
				}

				const dayPath = join(monthPath, day);
				const daySessions = await scanFlatDirectory(dayPath, resolvedProject);
				results.push(...daySessions);
			}
		}
	}

	return results;
}

/**
 * Scans a flat directory for .jsonl files and checks each for cwd match.
 * Used for both day directories (active sessions) and archived_sessions.
 */
async function scanFlatDirectory(dirPath: string, resolvedProject: string): Promise<SessionInfo[]> {
	const results: SessionInfo[] = [];

	let files: string[];
	try {
		files = await readdir(dirPath);
	} catch {
		return results;
	}

	for (const file of files) {
		if (!file.endsWith(".jsonl")) {
			continue;
		}

		const filePath = join(dirPath, file);
		const session = await tryParseSessionMeta(filePath, resolvedProject);
		if (session) {
			results.push(session);
		}
	}

	return results;
}

/**
 * Reads only the first line of a Codex JSONL file to extract session_meta.
 * Returns a SessionInfo if the session's cwd matches the project directory
 * and the session is within the staleness window.
 */
async function tryParseSessionMeta(filePath: string, resolvedProject: string): Promise<SessionInfo | null> {
	let firstLine: string;
	try {
		firstLine = await readFirstLine(filePath);
	} catch {
		log.debug("Cannot read Codex session file: %s", filePath);
		return null;
	}

	if (!firstLine) {
		return null;
	}

	try {
		const data = JSON.parse(firstLine) as Record<string, unknown>;

		if (data.type !== "session_meta") {
			log.debug("First line is not session_meta in %s", filePath);
			return null;
		}

		const payload = data.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object") {
			return null;
		}

		const cwd = payload.cwd;
		const id = payload.id;
		const timestamp = typeof data.timestamp === "string" ? data.timestamp : undefined;

		if (typeof cwd !== "string" || typeof id !== "string") {
			return null;
		}

		// Match cwd against the project directory via `sessionDirBelongsToRepo`
		// (shared with Devin/OpenCode/Copilot): prefix/containment with separator +
		// case folding (handling the Windows "e:\foo" vs "E:\foo" drive-letter drift)
		// plus the nested-repo exclusion. It replaced the exact `resolvedCwd ===
		// resolvedProject` match, which silently dropped every session run from a
		// subdirectory of the repo (JOLLI-2015).
		if (!sessionDirBelongsToRepo(resolve(cwd), resolvedProject)) {
			return null;
		}

		// Determine session freshness from timestamp or file mtime
		const updatedAt = timestamp ?? (await getFileMtime(filePath));
		if (!updatedAt) {
			return null;
		}

		// Check staleness
		const age = Date.now() - new Date(updatedAt).getTime();
		if (age > SESSION_STALE_MS) {
			log.debug("Stale Codex session %s (age: %dh)", id, Math.round(age / 3600000));
			return null;
		}

		return {
			sessionId: id,
			transcriptPath: filePath,
			updatedAt,
			source: "codex",
		};
	} catch (error: unknown) {
		log.debug("Failed to parse session_meta from %s: %s", filePath, (error as Error).message);
		return null;
	}
}

/**
 * Reads only the first line of a file using a stream (efficient for large files).
 * Closes the stream immediately after reading one line.
 */
function readFirstLine(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const stream = createReadStream(filePath, { encoding: "utf-8" });
		const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		let resolved = false;

		rl.on("line", (line: string) => {
			resolved = true;
			rl.close();
			stream.destroy();
			resolve(line);
		});

		rl.on("close", () => {
			if (!resolved) {
				resolve("");
			}
		});

		/* v8 ignore start - stream read errors are rare filesystem issues */
		stream.on("error", (err: Error) => {
			if (!resolved) {
				reject(err);
			}
		});
		/* v8 ignore stop */
	});
}

/**
 * Returns the file modification time as an ISO 8601 string.
 * Used as fallback when session_meta lacks a timestamp.
 */
async function getFileMtime(filePath: string): Promise<string | null> {
	try {
		const fileStat = await stat(filePath);
		return fileStat.mtime.toISOString();
	} catch {
		return null;
	}
}

/**
 * Returns date directory paths (YYYY/MM/DD format) for the last 3 days.
 * The 48h window may span up to 3 calendar days (today, yesterday, day before).
 */
function getRecentDateDirs(): string[] {
	const dates: string[] = [];
	const now = new Date();

	for (let i = 0; i < 3; i++) {
		const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
		const year = String(d.getFullYear());
		const month = String(d.getMonth() + 1).padStart(2, "0");
		const day = String(d.getDate()).padStart(2, "0");
		dates.push(`${year}/${month}/${day}`);
	}

	return dates;
}
