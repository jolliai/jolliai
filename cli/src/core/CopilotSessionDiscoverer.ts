/**
 * GitHub Copilot CLI session discoverer.
 *
 * Copilot stores every session in ~/.copilot/session-store.db. Each session row
 * carries its own `cwd`; attribution is prefix/containment via
 * `sessionDirBelongsToRepo` (shared with Devin/OpenCode), so a session run from a
 * subdirectory of the repo is still captured (JOLLI-2015). Sessions older than
 * 48 hours are excluded — matches the OpenCode / Cursor / Codex convention so a
 * user enabling Copilot for the first time doesn't pull months of history into
 * the next commit summary. Synthetic transcript path: "<dbPath>#<sessionId>".
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getCopilotDbPath } from "./CopilotDetector.js";
import { sessionDirBelongsToRepo } from "./SessionDirMatch.js";
import { classifyScanError, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("CopilotDiscoverer");

/** Sessions older than 48 hours are considered stale (matches other sources) */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export interface CopilotScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: SqliteScanError;
}

function normalizeCwd(p: string): string {
	return resolve(p);
}

export async function scanCopilotSessions(projectDir: string): Promise<CopilotScanResult> {
	const dbPath = getCopilotDbPath();
	const normalized = normalizeCwd(projectDir);
	const cutoffMs = Date.now() - SESSION_STALE_MS;

	try {
		await stat(dbPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		/* v8 ignore start -- TOCTOU branch covered by classifier tests */
		if (code !== "ENOENT") {
			const scanError = classifyScanError(error);
			if (scanError) {
				log.error("Copilot DB stat failed (%s): %s", scanError.kind, scanError.message);
				return { sessions: [], error: scanError };
			}
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.debug("Copilot DB not present at %s — treating as not installed", dbPath);
		return { sessions: [] };
	}

	try {
		const sessions = await withSqliteDb(dbPath, (db) => {
			// The directory match runs in JS via `sessionDirBelongsToRepo` (shared with
			// Devin/OpenCode): prefix/containment with separator + case folding plus the
			// nested-repo exclusion. It replaced the SQL `cwd = :cwd` (and its win32/darwin
			// LOWER() variant), which silently dropped every session run from a
			// subdirectory of the repo (JOLLI-2015). updated_at is TEXT with no clean SQL
			// cutoff, so the staleness filter is already JS-side below — the directory
			// filter joins it there.
			const rows = db
				.prepare(
					// No ORDER BY: every row passing the directory + staleness filters below is
					// kept regardless of order, so sorting would only add a full-table sort on
					// top of an already-unavoidable full scan (updated_at is TEXT — see above).
					`SELECT id, cwd, repository, branch, host_type, summary, created_at, updated_at
					 FROM sessions`,
				)
				.all() as ReadonlyArray<{ id: string; cwd: string; updated_at: string; summary: unknown }>;
			return rows.flatMap((row): SessionInfo[] => {
				if (!sessionDirBelongsToRepo(row.cwd, normalized)) {
					return [];
				}
				const ms = Date.parse(row.updated_at);
				if (!Number.isFinite(ms)) {
					log.warn("Skipping Copilot session %s: non-finite updated_at", row.id);
					return [];
				}
				// JS post-filter rather than SQL `WHERE updated_at > :cutoff` because
				// updated_at is TEXT and SQL `>` would do lexicographic comparison —
				// only valid if every row uses canonical UTC ISO-8601. Filtering after
				// Date.parse tolerates any format Date.parse accepts.
				if (ms < cutoffMs) return [];
				return [
					{
						sessionId: String(row.id),
						transcriptPath: `${dbPath}#${row.id}`,
						updatedAt: new Date(ms).toISOString(),
						source: "copilot",
						title:
							typeof row.summary === "string" && row.summary.trim().length > 0 ? row.summary : undefined,
					},
				];
			});
		});
		log.debug("Discovered %d Copilot session(s) for %s", sessions.length, normalized);
		return { sessions };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU branch covered by classifier tests */
		if (scanError === null) {
			log.debug("Copilot DB disappeared between detection and scan: %s", (error as Error).message);
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.error("Copilot scan failed (%s): %s", scanError.kind, scanError.message);
		return { sessions: [], error: scanError };
	}
}

/** Convenience wrapper without the error channel — used by QueueWorker. */
export async function discoverCopilotSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanCopilotSessions(projectDir);
	if (error) {
		log.warn("Copilot scan error (%s) — sessions excluded from this run: %s", error.kind, error.message);
	}
	return sessions;
}
