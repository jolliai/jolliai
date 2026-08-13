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
import { mapWithConcurrency, withIoBudget } from "../util/Concurrency.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";

const log = createLogger("KimiDiscoverer");

/** Sessions older than 48 hours are considered stale (matches Claude/Codex staleness). */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

/** Base directory for Kimi Code CLI data (default, before the KIMI_CODE_HOME override). */
const KIMI_DIR_NAME = ".kimi-code";

/**
 * Kimi Code CLI's data root: `$KIMI_CODE_HOME` when set, else `~/.kimi-code`.
 * Mirrors the CLI's own "Data locations" contract, so a user who relocates their
 * Kimi home is still discovered (and gets the MCP server written to the right file).
 * Exported so `HostRegistrars` resolves `<root>/mcp.json` from the same source.
 */
export function kimiCodeHome(): string {
	return process.env.KIMI_CODE_HOME || join(homedir(), KIMI_DIR_NAME);
}

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
 * @param windowMs - Staleness window; defaults to {@link SESSION_STALE_MS}. The
 *   dashboard's history back-fill passes a wider one (7 days); every caller that
 *   must keep the 48 h horizon omits it — the sidebar's Active Conversations,
 *   `jolli status`, and `QueueWorker`'s post-commit summary, which decides which
 *   conversations belong to the commit being summarised. Widening that last one
 *   would write week-old unrelated conversations into a commit's stored memory,
 *   persistently and silently, which is why the constant stays a default.
 * @returns Array of matching sessions with source="kimi"
 */
export async function discoverKimiSessions(projectDir: string, windowMs?: number): Promise<ReadonlyArray<SessionInfo>> {
	return kimiSessionsForRepo(await scanKimiSessionsOnDisk(windowMs), projectDir);
}

/**
 * Scans every Kimi session tree on this machine and returns those inside the window,
 * each carrying the working directory its `state.json` recorded.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. `~/.kimi-code/sessions/` is one global
 * tree whose `<workDirKey>` buckets are `wd_<slug>_<hash>` names Kimi does not
 * document, so they cannot be derived from a repo path and every bucket has to be
 * opened. A repo-scoped scan therefore re-reads every `state.json` on the machine
 * once per registered repo. Callers scan once and narrow with
 * {@link kimiSessionsForRepo}.
 */
export async function scanKimiSessionsOnDisk(windowMs?: number): Promise<ReadonlyArray<DiskSession>> {
	const sessionsDir = join(kimiCodeHome(), "sessions");
	const staleMs = windowMs ?? SESSION_STALE_MS;
	const scanned: DiskSession[] = [];

	let workDirKeys: string[];
	try {
		workDirKeys = await readdir(sessionsDir);
	} catch {
		log.debug("Kimi sessions directory not found: %s", sessionsDir);
		return scanned;
	}

	// Every session directory on the machine, flattened first so the fan-out below is
	// over sessions rather than over buckets. Bucket counts are lopsided — one project
	// the user lives in can hold most of their sessions — so fanning out per bucket
	// would leave the widest one running alone.
	const sessionDirs: Array<{ readonly sessionId: string; readonly sessionDir: string }> = [];
	for (const workDirKey of workDirKeys) {
		const workDirPath = join(sessionsDir, workDirKey);
		let sessionIds: string[];
		try {
			sessionIds = await readdir(workDirPath);
		} catch {
			continue;
		}
		for (const sessionId of sessionIds) {
			sessionDirs.push({ sessionId, sessionDir: join(workDirPath, sessionId) });
		}
	}

	// One `stat` plus one small `state.json` read per session, each independent — and
	// each taking a slot from the shared budget inside `tryParseSession`, so this
	// running alongside the other scans cannot push the process past its total.
	const parsed = await mapWithConcurrency(sessionDirs, ({ sessionId, sessionDir }) =>
		tryParseSession(sessionDir, sessionId, staleMs),
	);
	scanned.push(...parsed.filter((session): session is DiskSession => session !== null));

	log.debug("Kimi disk scan: %d session(s) inside the window", scanned.length);
	return scanned;
}

/**
 * Narrows a machine-wide Kimi scan to one repo.
 *
 * Attribution is prefix/containment, unchanged from when it ran inside the scan: a
 * session started in a SUBDIRECTORY of the repo still counts, while one living in a
 * nested git repo does not.
 */
export function kimiSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	// The predicate is verbatim what ran inside the scan, `resolve` on both sides
	// included — this change moved when it runs, not what it says.
	const resolvedProject = resolve(projectDir);
	const mine = sessionsForRepo(scanned, (dir) => sessionDirBelongsToRepo(resolve(dir), resolvedProject));
	log.debug("Discovered %d Kimi session(s) for %s", mine.length, projectDir);
	return mine;
}

/**
 * Checks whether the Kimi Code CLI data directory exists.
 * Used by the discovery gate / status tree to detect Kimi presence.
 */
export async function isKimiInstalled(): Promise<boolean> {
	const kimiDir = kimiCodeHome();
	try {
		const dirStat = await stat(kimiDir);
		return dirStat.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Builds a scanned session for one `<workDirKey>/<sessionId>/` tree, or null when it
 * has no readable transcript, is stale, or records no working directory at all.
 *
 * Repo attribution is deliberately NOT done here: it belongs to
 * {@link kimiSessionsForRepo}, so one scan of this global tree can serve every
 * registered repo instead of being re-run per repo. A session with no working
 * directory is still dropped here — with no directory it can never be attributed, so
 * carrying it forward would only make every filter re-decide the same thing.
 */
async function tryParseSession(sessionDir: string, sessionId: string, staleMs: number): Promise<DiskSession | null> {
	const transcriptPath = join(sessionDir, "agents", "main", "wire.jsonl");

	// Staleness gate BEFORE reading state.json — an absent/old transcript is
	// skipped with a single stat. Zero bytes claimed from the budget: a `stat` and a
	// small `state.json` need a slot, not part of the byte allowance a whole
	// transcript would take.
	let mtimeIso: string;
	try {
		const fileStat = await withIoBudget(0, () => stat(transcriptPath));
		mtimeIso = fileStat.mtime.toISOString();
	} catch {
		return null;
	}
	if (Date.now() - new Date(mtimeIso).getTime() > staleMs) {
		return null;
	}

	const state = await withIoBudget(0, () => readState(sessionDir));
	const cwd = cwdFromState(state);
	if (!cwd) {
		log.debug("No working directory in state.json for Kimi session %s", sessionId);
		return null;
	}

	const title = titleFromState(state);
	return {
		session: {
			sessionId,
			transcriptPath,
			updatedAt: mtimeIso,
			source: "kimi",
			...(title ? { title } : {}),
		},
		dirs: [cwd],
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
