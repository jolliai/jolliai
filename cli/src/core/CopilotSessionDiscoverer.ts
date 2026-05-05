/**
 * GitHub Copilot CLI session discoverer.
 *
 * Copilot stores every session in ~/.copilot/session-store.db. Each session row
 * carries its own `cwd`, so workspace attribution is exact. Sessions older than
 * 48 hours are excluded — matches the OpenCode / Cursor / Codex convention so a
 * user enabling Copilot for the first time doesn't pull months of history into
 * the next commit summary. Synthetic transcript path: "<dbPath>#<sessionId>".
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getCopilotDbPath } from "./CopilotDetector.js";
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
			const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
			const cwdMatch = caseInsensitive ? "LOWER(cwd) = LOWER(:cwd)" : "cwd = :cwd";
			const rows = db
				.prepare(
					`SELECT id, cwd, repository, branch, host_type, summary, created_at, updated_at
					 FROM sessions
					 WHERE ${cwdMatch}
					 ORDER BY updated_at DESC`,
				)
				.all({ cwd: normalized }) as ReadonlyArray<{ id: string; updated_at: string }>;
			return rows.flatMap((row): SessionInfo[] => {
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
					},
				];
			});
		});
		log.info("Discovered %d Copilot session(s) for %s", sessions.length, normalized);
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
