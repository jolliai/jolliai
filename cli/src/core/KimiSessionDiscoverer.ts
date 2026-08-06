/**
 * Kimi Session Discoverer
 *
 * On-demand scanner for Moonshot AI's Kimi Code CLI (`@kimi-code/cli`, the
 * `kimi` binary). Structurally a twin of {@link discoverCodexSessions}: Kimi has
 * no lifecycle hook we can use, so sessions are discovered by scanning the
 * filesystem at post-commit time (for summaries) and on the VS Code sidebar's
 * Active Conversations tick.
 *
 * On-disk layout (Kimi Code CLI "Data locations", verified against a real
 * ~/.kimi-code install, Aug 2026):
 *
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/
 *     state.json                 session metadata: { workDir, title, createdAt, updatedAt, … }
 *     agents/main/wire.jsonl     the main agent's full conversation record (Kimi's wire protocol)
 *     agents/agent-0/…           sub-agent conversations (ignored here)
 *
 * `<workDirKey>` groups sessions by their working directory — it is
 * `wd_<slug>_<first-12-hex-of-sha256(workDir)>` — but the slug/hash input is not
 * part of Kimi's public contract, so we do NOT recompute it. Instead the real
 * absolute working directory is read from `state.json.workDir` (the wire.jsonl
 * event stream carries no cwd of any kind — confirmed against real captures), and
 * matched to the repo via {@link sessionDirBelongsToRepo} (prefix/containment +
 * nested-repo exclusion), shared with Codex/Devin/OpenCode. A session whose
 * `state.json` is missing or carries no working directory is simply skipped — it
 * cannot be attributed to any repo.
 *
 * Performance: staleness is gated on the transcript file mtime BEFORE `state.json`
 * is read, so old session trees are skipped with a single `stat`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";

const log = createLogger("KimiDiscoverer");

/** Sessions older than 48 hours are considered stale (matches Claude/Codex staleness). */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/** Base directory for Kimi Code CLI data. */
const KIMI_DIR_NAME = ".kimi-code";

/**
 * Field names on state.json that carry the working directory. `workDir` is the
 * one Kimi writes today; the aliases are defensive against a future rename.
 */
const CWD_STATE_FIELDS = ["workDir", "cwd", "workingDirectory", "workspaceRoot", "projectRoot", "root"] as const;

/**
 * Discovers Kimi Code CLI sessions relevant to the given project directory.
 * Scans ~/.kimi-code/sessions/ for session trees whose `state.json.workDir`
 * matches the project directory. Only returns sessions updated within the
 * staleness window (48 hours).
 *
 * @param projectDir - The git repository root to match sessions against
 * @returns Array of matching sessions with source="kimi"
 */
export async function discoverKimiSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const sessionsDir = join(homedir(), KIMI_DIR_NAME, "sessions");
	const resolvedProject = resolve(projectDir);
	const sessions: SessionInfo[] = [];

	let workDirKeys: string[];
	try {
		workDirKeys = await readdir(sessionsDir);
	} catch {
		log.debug("Kimi sessions directory not found: %s", sessionsDir);
		return sessions;
	}

	for (const workDirKey of workDirKeys) {
		const workDirPath = join(sessionsDir, workDirKey);
		let sessionIds: string[];
		try {
			sessionIds = await readdir(workDirPath);
		} catch {
			continue;
		}

		for (const sessionId of sessionIds) {
			const sessionDir = join(workDirPath, sessionId);
			const session = await tryParseSession(sessionDir, sessionId, resolvedProject);
			if (session) {
				sessions.push(session);
			}
		}
	}

	log.debug("Discovered %d Kimi session(s)", sessions.length);
	return sessions;
}

/**
 * Checks whether the Kimi Code CLI data directory exists.
 * Used by the discovery gate / status tree to detect Kimi presence.
 */
export async function isKimiInstalled(): Promise<boolean> {
	const kimiDir = join(homedir(), KIMI_DIR_NAME);
	try {
		const dirStat = await stat(kimiDir);
		return dirStat.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Builds a SessionInfo for one `<workDirKey>/<sessionId>/` tree, or null when it
 * has no readable transcript, is stale, or cannot be attributed to the project.
 */
async function tryParseSession(
	sessionDir: string,
	sessionId: string,
	resolvedProject: string,
): Promise<SessionInfo | null> {
	const transcriptPath = join(sessionDir, "agents", "main", "wire.jsonl");

	// Staleness gate BEFORE reading state.json — an absent/old transcript is
	// skipped with a single stat.
	let mtimeIso: string;
	try {
		const fileStat = await stat(transcriptPath);
		mtimeIso = fileStat.mtime.toISOString();
	} catch {
		return null;
	}
	if (Date.now() - new Date(mtimeIso).getTime() > SESSION_STALE_MS) {
		return null;
	}

	const state = await readState(sessionDir);
	const cwd = cwdFromState(state);
	if (!cwd) {
		log.debug("No working directory in state.json for Kimi session %s", sessionId);
		return null;
	}
	if (!sessionDirBelongsToRepo(resolve(cwd), resolvedProject)) {
		return null;
	}

	const title = titleFromState(state);
	return {
		sessionId,
		transcriptPath,
		updatedAt: mtimeIso,
		source: "kimi",
		...(title ? { title } : {}),
	};
}

/** Reads and parses `state.json`, returning the raw object or null. */
async function readState(sessionDir: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await readFile(join(sessionDir, "state.json"), "utf-8");
		const data = JSON.parse(raw) as unknown;
		return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Recovers the working-directory string from a parsed state.json, if present. */
export function cwdFromState(state: Record<string, unknown> | null): string | null {
	if (!state) return null;
	for (const field of CWD_STATE_FIELDS) {
		const value = state[field];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return null;
}

/** Reads the native session title from a parsed state.json, if present. */
function titleFromState(state: Record<string, unknown> | null): string | undefined {
	const title = state?.title;
	return typeof title === "string" && title.length > 0 ? title : undefined;
}
