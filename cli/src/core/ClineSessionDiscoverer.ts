import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getClineStorageDirs } from "./ClineDetector.js";
import type { ClineScanError } from "./ClineTranscriptShared.js";
import { type DiskSession, sessionsForRepo } from "./DiskSessionScan.js";
import { normalizePathForCompare } from "./PathUtils.js";

const log = createLogger("ClineDiscoverer");
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export type { ClineScanError };

export interface ClineScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: ClineScanError;
}

interface TaskHistoryEntry {
	readonly id?: string;
	readonly ts?: number;
	readonly task?: string;
	readonly cwdOnTaskInitialization?: string;
}

/**
 * Reads one editor flavour's `taskHistory.json`, carrying each task's recorded
 * directory rather than matching it — see {@link clineSessionsForRepo} for the match.
 */
async function scanFlavor(storageDir: string, cutoffMs: number): Promise<DiskSession[]> {
	const historyPath = join(storageDir, "state", "taskHistory.json");
	let entries: TaskHistoryEntry[];
	try {
		const parsed = JSON.parse(await readFile(historyPath, "utf8")) as unknown;
		entries = Array.isArray(parsed) ? (parsed as TaskHistoryEntry[]) : [];
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: DiskSession[] = [];
	for (const e of entries) {
		if (typeof e.id !== "string" || typeof e.cwdOnTaskInitialization !== "string") continue;
		// `ts` is the task's updatedAt (always present in real taskHistory). Require
		// it: an entry without a numeric ts has no basis to be judged fresh, so treat
		// it as stale rather than surfacing it with a fabricated `Date.now()` stamp.
		if (typeof e.ts !== "number" || !Number.isFinite(e.ts) || e.ts < cutoffMs) continue;
		// JSON accepts finite numbers far outside JavaScript Date's representable
		// range. One such row must not make `toISOString()` throw and discard every
		// healthy task in this editor flavour, especially now that the machine-wide
		// scan reads unrelated projects in the same history file.
		const updatedAt = new Date(e.ts);
		if (!Number.isFinite(updatedAt.getTime())) continue;
		const title = e.task?.trim();
		out.push({
			session: {
				sessionId: e.id,
				transcriptPath: join(storageDir, "tasks", e.id, "api_conversation_history.json"),
				updatedAt: updatedAt.toISOString(),
				source: "cline",
				...(title ? { title } : {}),
			},
			dirs: [e.cwdOnTaskInitialization],
		});
	}
	return out;
}

/**
 * @param windowMs Optional session-staleness window in milliseconds, defaulting to
 * the 48-hour {@link SESSION_STALE_MS}. Only the dashboard's history back-fill passes
 * a wider one (7 days); every caller that must NOT widen simply omits it — the
 * "Active Conversations" sidebar, `jolli status`, and above all the post-commit
 * summary generation in `hooks/QueueWorker.ts`, which uses this window to decide
 * which conversations belong to the commit being summarised. A wider window there
 * would pull unrelated week-old conversations into that commit's stored memory,
 * which is persisted to the git orphan branch and fails silently — no error, just
 * wrong content.
 */
export async function scanClineSessions(
	projectDir: string,
	storageDirs: string[] = getClineStorageDirs(),
	windowMs?: number,
): Promise<ClineScanResult> {
	const { sessions, error } = await scanClineSessionsOnDisk(storageDirs, windowMs);
	const mine = clineSessionsForRepo(sessions, projectDir);
	return error ? { sessions: mine, error } : { sessions: mine };
}

/** A machine-wide Cline scan: every in-window task, plus the first flavour failure. */
export interface ClineDiskScanResult {
	readonly sessions: ReadonlyArray<DiskSession>;
	readonly error?: ClineScanError;
}

/**
 * Scans every installed Cline flavour's task history once and returns the in-window
 * tasks, each carrying the directory it was started in.
 *
 * MACHINE-WIDE and repo-agnostic on purpose. Each flavour keeps ONE
 * `state/taskHistory.json` holding every project's tasks, so a repo-scoped scan
 * re-reads and re-parses that whole file once per registered repo — and it is a
 * single JSON parse of the user's entire Cline history, not a lazy store. Callers
 * scan once and narrow with {@link clineSessionsForRepo}.
 */
export async function scanClineSessionsOnDisk(
	storageDirs: string[] = getClineStorageDirs(),
	windowMs?: number,
): Promise<ClineDiskScanResult> {
	const staleMs = windowMs ?? SESSION_STALE_MS;
	const cutoffMs = Date.now() - staleMs;
	const sessions: DiskSession[] = [];
	let error: ClineScanError | undefined;
	for (const dir of storageDirs) {
		try {
			sessions.push(...(await scanFlavor(dir, cutoffMs)));
		} catch (err: unknown) {
			log.warn("Cline flavor scan failed at %s: %s", dir, (err as Error).message);
			// Malformed taskHistory.json throws a SyntaxError (parse); anything else
			// reaching here is a filesystem error (e.g. EACCES) — don't mislabel it.
			const kind = err instanceof SyntaxError ? "parse" : "fs";
			error = error ?? { kind, message: (err as Error).message };
		}
	}
	return error ? { sessions, error } : { sessions };
}

/**
 * Narrows a machine-wide Cline scan to one repo.
 *
 * Attribution is EXACT equality on the task's `cwdOnTaskInitialization`, verbatim
 * from when it ran inside the flavour scan — deliberately not the prefix/containment
 * rule the SQLite-backed sources use. A task started from a subdirectory of the repo
 * is NOT attributed to it; that is the known, intentional limitation this source's
 * "subdirectory" contract test pins.
 */
export function clineSessionsForRepo(
	scanned: ReadonlyArray<DiskSession>,
	projectDir: string,
): ReadonlyArray<SessionInfo> {
	const target = normalizePathForCompare(projectDir);
	return sessionsForRepo(scanned, (dir) => normalizePathForCompare(dir) === target);
}

/**
 * QueueWorker wrapper — strips the error channel.
 *
 * @param windowMs Optional staleness window in milliseconds, forwarded verbatim; see
 * {@link scanClineSessions} for the default and for who may widen it.
 */
export async function discoverClineSessions(
	projectDir: string,
	windowMs?: number,
): Promise<ReadonlyArray<SessionInfo>> {
	// `undefined` for storageDirs so the scan applies its own detector default —
	// spelling it here would duplicate that default at the call site.
	const { sessions, error } = await scanClineSessions(projectDir, undefined, windowMs);
	if (error) log.warn("Cline scan error (%s): %s", error.kind, error.message);
	return sessions;
}
