/**
 * HermesDiscovery — MCP reference extraction for the SQLite-backed Hermes store.
 *
 * Structurally the twin of {@link discoverKimiConversations}, minus skill
 * discovery — Hermes skills already have their own SQLite driver
 * ({@link discoverHermesSkills}), so this file is references only.
 *
 * ## Why Hermes has its own file
 *
 * The line-oriented reference discovery driver (`scanReferencesFrom`) reads a
 * transcript as `lines: string[]`. Hermes has no such stream: its transcript is
 * `messages` rows behind an AUTOINCREMENT `id`. So the discovery half of Kimi's
 * pattern is reused verbatim (single-flight, dirty-rerun, per-session cursor,
 * error-per-session containment) while the scan itself goes through the
 * SQLite-shaped {@link extractHermesReferences} and lands references through the
 * SAME {@link upsertReferenceEntry} that every other host uses.
 *
 * ## Drivers (both required — neither alone covers every user)
 *
 *   - VS Code sidebar's 60-second Active Conversations tick — sub-minute
 *     freshness for the panel. Fire-and-forget.
 *   - QueueWorker at post-commit — the baseline. Awaited, so a CLI-only Hermes
 *     user gets the panel-tier freshness on commit even without VS Code open.
 *
 * ## Contract: `discoverHermesConversations` NEVER rejects
 *
 * All errors are swallowed and logged, so callers can `void`-call it without an
 * unhandled rejection.
 */

import { createLogger, isManuallyDisabled } from "../Logger.js";
import { discoverHermesSessions, isHermesInstalled } from "./HermesSessionDiscoverer.js";
import { extractHermesReferences, type HermesMessageRow } from "./references/HermesReferenceExtractor.js";
import { referencesFromNormalizedResults } from "./references/ReferenceExtractor.js";
import {
	loadConfig,
	loadDiscoveryCursor,
	migrateDiscoveryCursors,
	saveDiscoveryCursor,
	upsertReferenceEntry,
} from "./SessionTracker.js";
import { withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("HermesDiscovery");

interface InFlight {
	promise: Promise<void>;
	dirty: boolean;
}

/** Per-cwd single-flight registry (keyed by the workspace cwd). */
const inFlight = new Map<string, InFlight>();

/**
 * Scan every recent Hermes session for this cwd and persist any discovered
 * references. Single-flight + dirty-rerun per cwd. Never rejects.
 */
export function discoverHermesConversations(cwd: string): Promise<void> {
	const existing = inFlight.get(cwd);
	if (existing !== undefined) {
		existing.dirty = true;
		return existing.promise;
	}
	const state: InFlight = { promise: Promise.resolve(), dirty: false };
	state.promise = runWithRerun(cwd, state).finally(() => {
		inFlight.delete(cwd);
	});
	inFlight.set(cwd, state);
	return state.promise;
}

async function runWithRerun(cwd: string, state: InFlight): Promise<void> {
	do {
		state.dirty = false;
		await runOnce(cwd);
	} while (state.dirty);
}

async function runOnce(cwd: string): Promise<void> {
	try {
		// A pass writes into the project's .jolli/jollimemory/ — disk writes a
		// manually-disabled project must not receive, and the tick keeps firing
		// while the disabled panel is shown.
		if (isManuallyDisabled()) return;
		const config = await loadConfig();
		if (config.hermesEnabled === false) return;
		if (!(await isHermesInstalled())) return;

		await migrateDiscoveryCursors(cwd);
		const sessions = await discoverHermesSessions(cwd);
		let advanced = 0;
		for (const session of sessions) {
			// Per-session try/catch: one bad transcript (SQLite read error, envelope
			// drift) must not abort the rest of the batch or block cursor advances.
			try {
				const fromRowId = (await loadDiscoveryCursor(session.transcriptPath, cwd))?.lineNumber ?? 0;
				const advancedTo = await scanOneSession(
					session.transcriptPath,
					fromRowId,
					cwd,
					config.slack?.workspaceUrl,
				);
				if (advancedTo > fromRowId) {
					await saveDiscoveryCursor(
						{
							transcriptPath: session.transcriptPath,
							lineNumber: advancedTo,
							updatedAt: new Date().toISOString(),
						},
						cwd,
					);
					advanced++;
				}
			} catch (err) {
				log.warn("Hermes discovery failed for %s: %s", session.sessionId, (err as Error).message);
			}
		}
		if (sessions.length > 0) {
			log.info("Hermes discovery pass: %d session(s) scanned, %d advanced", sessions.length, advanced);
		}
	} catch (err) {
		// Top-level guard: loadConfig / discoverHermesSessions / migrate can throw.
		log.warn("Hermes discovery pass failed: %s", (err as Error).message);
	}
}

/**
 * Scan one Hermes session's new rows for MCP references and upsert them.
 *
 * Returns the row id the cursor should advance to. Held at `fromRowId` on any
 * throw so the next pass re-reads the same window — a re-scan is idempotent via
 * the shared dedupe + upsert-by-mapKey.
 */
async function scanOneSession(
	transcriptPath: string,
	fromRowId: number,
	cwd: string,
	slackWorkspaceUrl: string | undefined,
): Promise<number> {
	const { dbPath, sessionId } = parseSyntheticPath(transcriptPath);
	// The SQLite read is factored out so its cost — one indexed scan and one
	// bounded row-set — is paid in this file rather than smeared through the
	// discovery driver. The predicate mirrors the reader's own filter (active
	// history plus compaction archive), so a scan never sees a row a re-run of
	// the conversation cannot reproduce.
	const rows = await withSqliteDb(dbPath, (db) => {
		return db
			.prepare(
				`SELECT id, role, content, tool_call_id, tool_calls, timestamp
				 FROM messages
				 WHERE session_id = :sessionId
				   AND id > :fromRowId
				   AND (active = 1 OR compacted = 1)
				 ORDER BY id`,
			)
			.all({ sessionId, fromRowId }) as Array<{
			id: number;
			role: string;
			content: string | null;
			tool_call_id: string | null;
			tool_calls: string | null;
			timestamp: number;
		}>;
	});
	if (rows.length === 0) return fromRowId;

	const mapped: HermesMessageRow[] = rows.map((r) => ({
		id: r.id,
		role: r.role,
		content: r.content,
		toolCallId: r.tool_call_id,
		toolCalls: r.tool_calls,
		timestamp: r.timestamp,
	}));
	const { results, lastRowId } = extractHermesReferences(mapped, {
		fromRowId,
		...(slackWorkspaceUrl !== undefined ? { slackWorkspaceUrl } : {}),
	});
	const references = referencesFromNormalizedResults(results);
	for (const ref of references) {
		// Per-iteration try/catch: a single bad ref (write contention, markdown
		// permission error) must not abort the batch — otherwise later refs are
		// lost AND the cursor advance is skipped, and the next pass hits the
		// same failure in a loop.
		try {
			await upsertReferenceEntry(ref, cwd);
		} catch (err) {
			log.warn("Hermes reference upsert failed for %s: %s", ref.mapKey, (err as Error).message);
		}
	}
	return lastRowId;
}

/** Split "<dbPath>#<sessionId>" into its parts. */
function parseSyntheticPath(transcriptPath: string): { dbPath: string; sessionId: string } {
	const hash = transcriptPath.lastIndexOf("#");
	if (hash === -1) {
		throw new Error(`Invalid Hermes transcript path (expected "<dbPath>#<sessionId>"): ${transcriptPath}`);
	}
	return { dbPath: transcriptPath.slice(0, hash), sessionId: transcriptPath.slice(hash + 1) };
}
