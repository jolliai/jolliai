import type { TranscriptEntry, TranscriptSource } from "../Types.js";
import type { DashboardDbHandle, DashboardStatement } from "./DashboardDb.js";

/**
 * The ONLY fields {@link projectSessionTurns}, {@link uncoveredSessionsForSlice}
 * and {@link eventIdFor} read from a session. A full `StoredSession` structurally
 * satisfies it, so the live write paths (`SotWrite`/`SotImport`) pass their sessions
 * unchanged — but the historical backfill projects each stored blob down to THIS
 * before holding it in memory, dropping every entry's `content` (the one large
 * field). Without that a machine with many transcripts holds the whole inflated
 * corpus until the backfill transaction commits.
 *
 * Deliberately a hand-written minimal type, not `Pick<StoredSession, …>`: it makes
 * the backfill's content-dropping projection a COMPILE guarantee. A future read of
 * `entry.content` in the projector then fails to build instead of silently seeing
 * the backfill's empty entries drift from the live path's real ones.
 */
export interface SessionTurnInput {
	readonly sessionId: string;
	readonly source?: TranscriptSource;
	readonly entries?: ReadonlyArray<{ readonly role: TranscriptEntry["role"]; readonly timestamp?: string }>;
	readonly compactions?: ReadonlyArray<number>;
	readonly turnAborts?: ReadonlyArray<number>;
	readonly testRuns?: ReadonlyArray<number>;
}

/**
 * Maps a StoredSession (source, sessionId) to its sessions.event_id for a repo,
 * through a caller-owned prepared SELECT so a loop over many sessions compiles the
 * statement once rather than per row. The `?? "claude"` is the same coalescing the
 * historical backfill's selection join must mirror (a legacy session persisted
 * before `source` was recorded is a `claude` row here and a NULL in
 * `transcript_sessions`).
 */
function eventIdFor(stmt: DashboardStatement, repoId: number, session: SessionTurnInput): string | undefined {
	// A session with no id has no `sessions` row (the `transcript_sessions`
	// projection skips it for the same reason), so there is nothing to hang turns
	// off — and binding an undefined `session_id` would throw at the driver.
	if (!session.sessionId) {
		return undefined;
	}
	const row = stmt.get(repoId, session.source ?? "claude", session.sessionId) as { event_id: string } | undefined;
	return row?.event_id;
}

/** The prepared `SELECT event_id …` {@link eventIdFor} consumes. */
function prepareEventIdStmt(db: DashboardDbHandle): DashboardStatement {
	return db.prepare("SELECT event_id FROM sessions WHERE repo_id = ? AND source = ? AND session_id = ?");
}

/**
 * Deletes EVERY `session_turns` row for one transcript slice, repo-scoped.
 *
 * {@link projectSessionTurns} only deletes rows for the sessions it is currently
 * projecting, so a WRITE path (a rewrite whose session list shrank, or a
 * transcript deletion) that stops passing a session would strand its turns —
 * still synced, still feeding coaching signals for a slice that no longer exists.
 * The write/delete paths call this first because they always hold the COMPLETE
 * session set; the backfill must NOT (it narrows to uncovered sessions, and a
 * whole-slice wipe would drop already-covered rows it does not re-insert).
 *
 * Scoped through `sessions` rather than by `slice_id` alone because `session_turns`
 * carries no `repo_id` — only `session_event_id`, which encodes repo identity — so
 * two repos sharing a commit hash share a `slice_id`.
 */
export function deleteSliceSessionTurns(db: DashboardDbHandle, repoId: number, transcriptId: string): void {
	db.prepare(
		`DELETE FROM session_turns
		  WHERE slice_id = ?
		    AND session_event_id IN (SELECT event_id FROM sessions WHERE repo_id = ?)`,
	).run(transcriptId, repoId);
}

/**
 * The subset of `sessions` that carries NO `session_turns` row for this slice yet
 * — what {@link backfillStoredSessionTurns} should hand {@link projectSessionTurns}.
 *
 * The backfill selects a whole transcript blob when ANY of its sessions is
 * uncovered, but {@link projectSessionTurns} re-projects every session it is given
 * (delete-then-insert). Without this filter an already-covered session in a
 * mixed-coverage blob has its rows rewritten with the backfill's fresh, higher
 * `recorded_at_ms`, re-entering the sync window and being re-uploaded — the exact
 * churn the backfill's "the cohort is uncovered by construction" invariant claims
 * cannot happen. A session with no `sessions` row (no `event_id`) is dropped: it
 * cannot be the reason the blob was selected (selection joins `sessions`), and
 * {@link projectSessionTurns} would skip it anyway.
 */
export function uncoveredSessionsForSlice(
	db: DashboardDbHandle,
	repoId: number,
	transcriptId: string,
	sessions: ReadonlyArray<SessionTurnInput>,
): ReadonlyArray<SessionTurnInput> {
	const covered = db.prepare("SELECT 1 FROM session_turns WHERE session_event_id = ? AND slice_id = ? LIMIT 1");
	const eventIdStmt = prepareEventIdStmt(db);
	return sessions.filter((session) => {
		const eventId = eventIdFor(eventIdStmt, repoId, session);
		if (eventId === undefined) {
			return false;
		}
		return covered.get(eventId, transcriptId) === undefined;
	});
}

/**
 * Projects one transcript's sessions into `session_turns`, TEXT-FREE: one `turn`
 * row per entry (role + parsed timestamp, content dropped) then one row per
 * compaction/test-run/turn-abort instant. Idempotent per `transcript_id`
 * (delete-then-insert), mirroring the `transcript_sessions` projection.
 */
export function projectSessionTurns(
	db: DashboardDbHandle,
	repoId: number,
	transcriptId: string,
	sessions: ReadonlyArray<SessionTurnInput>,
	nowMs: number,
): void {
	const insert = db.prepare(
		`INSERT OR REPLACE INTO session_turns
		 (session_event_id, slice_id, seq, role, ts_ms, kind, recorded_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	// Prepared once, not per session: this runs over every session of every stored
	// transcript during the historical backfill, inside SQLite's single writer.
	const eventIdStmt = prepareEventIdStmt(db);
	const deleteStmt = db.prepare("DELETE FROM session_turns WHERE session_event_id = ? AND slice_id = ?");
	for (const session of sessions) {
		const eventId = eventIdFor(eventIdStmt, repoId, session);
		if (eventId === undefined) {
			continue; // no sessions row yet — transcript_sessions projection has the same gap
		}
		deleteStmt.run(eventId, transcriptId);
		let seq = 0;
		// `entries` is optional here (see `SessionTurnInput`) and this projects untrusted on-disk data (a
		// stored transcript blob) as well as live writes: an older or malformed blob
		// can omit it, and `for (const entry of undefined)` would throw mid-cohort —
		// in the backfill that is one bad session failing the whole run's transaction.
		for (const entry of session.entries ?? []) {
			const parsed = entry.timestamp === undefined ? undefined : Date.parse(entry.timestamp);
			const tsMs = parsed === undefined || Number.isNaN(parsed) ? null : parsed;
			insert.run(eventId, transcriptId, seq++, entry.role, tsMs, "turn", nowMs);
		}
		for (const [kind, instants] of [
			["compaction", session.compactions],
			["test-run", session.testRuns],
			["turn-abort", session.turnAborts],
		] as const) {
			for (const atMs of instants ?? []) {
				insert.run(eventId, transcriptId, seq++, null, atMs, kind, nowMs);
			}
		}
	}
}
