/**
 * OpenCodeSkillDiscovery — reads OpenCode's SQLite DB and persists skill usage.
 *
 * OpenCode has no hook, so this runs on the polling path rather than per agent
 * turn. Skills are a signal about how the work is being done *right now*, so
 * surfacing them only at commit time would leave working memory empty for the
 * whole session — which is exactly when the information is useful.
 *
 * The DB is opened read-only through `withSqliteDb`, which brings the lazy
 * `node:sqlite` import (so a Node-18 bundle tolerates the missing module), the
 * locked-retry backoff, and guaranteed close. `node:sqlite` is a real SQLite, so
 * it reads the WAL — which matters here: this database carries megabytes of
 * uncommitted WAL, and a library that ignored it would silently see stale rows.
 */

import { stat } from "node:fs/promises";
import { createLogger, isManuallyDisabled } from "../../Logger.js";
import { getOpenCodeDbPath } from "../OpenCodeSessionDiscoverer.js";
import { sessionDirBelongsToRepo } from "../SessionDirMatch.js";
import { loadConfig, upsertSkillEntry } from "../SessionTracker.js";
import { withSqliteDb } from "../SqliteHelpers.js";
import { type OpenCodeRow, scanOpenCodeSkillRows } from "./OpenCodeSkillScanner.js";

const log = createLogger("OpenCodeSkillDiscovery");

/**
 * How far back to look, by session creation time.
 *
 * Two reasons, and the second is the one worth stating: an unbounded scan of a
 * multi-megabyte database on a 60-second tick is wasteful, AND capture is
 * deliberately forward-only. Skill usage from months-old sessions is not
 * back-filled — the same stance every other discovery path here takes. A reader
 * who finds an old skill call in the database and no row for it has NOT found a
 * bug; widening this window would turn a design decision into a migration.
 */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-cwd single-flight registry, mirroring CodexDiscovery. */
const inFlight = new Map<string, Promise<number>>();

/**
 * Discover and persist OpenCode skill usage for `cwd`.
 *
 * Returns the number of skills persisted. Silent and non-throwing on every
 * failure path: this runs fire-and-forget on a UI tick, and a regressed reader
 * must never take down the surface it feeds.
 *
 * **Single-flight per cwd.** The 60-second tick has four callers (the tick itself,
 * handleReady, refresh, and a detail-panel save), so overlapping runs are normal.
 * They would all be correct — `upsertSkillEntry` serialises on plans.lock — but
 * they would contend for that lock while re-deriving the same answer. Unlike Codex
 * there is no dirty-rerun: a caller that arrives mid-run joins the in-flight pass
 * rather than queueing another, because the tick will come round again in a minute
 * and skill rows change on the order of minutes, not milliseconds.
 */
export function discoverOpenCodeSkills(cwd: string): Promise<number> {
	const existing = inFlight.get(cwd);
	if (existing !== undefined) return existing;
	const run = runOnce(cwd).finally(() => {
		inFlight.delete(cwd);
	});
	inFlight.set(cwd, run);
	return run;
}

async function runOnce(cwd: string): Promise<number> {
	// A pass writes into the project's .jolli/jollimemory/ — disk writes a
	// manually-disabled project must not receive, and the tick keeps firing while
	// the disabled panel is shown.
	if (isManuallyDisabled()) return 0;
	const config = await loadConfig();
	if (config.openCodeEnabled === false) return 0;

	const dbPath = getOpenCodeDbPath();
	try {
		await stat(dbPath);
	} catch {
		// Not installed. Indistinguishable from an unreadable DB at this level and
		// treated the same way — there is nothing a user could act on either way.
		return 0;
	}

	try {
		const scoped = await withSqliteDb(dbPath, (db) => {
			const since = Date.now() - LOOKBACK_MS;

			// Sessions belonging to this repo. Directory matching goes through the shared
			// helper (prefix + separator + case folding + nested-repo exclusion) rather
			// than a SQL equality test, which silently dropped every session started from
			// a subdirectory of the repo.
			const sessionIds: string[] = [];
			for (const row of db
				.prepare("SELECT id, directory FROM session WHERE time_created >= ?")
				.all(since) as Array<{ id: string; directory: string | null }>) {
				// A null directory is real in this data — one such row is enough to throw
				// from the matcher and take the whole batch down with it.
				if (typeof row.directory !== "string" || row.directory === "") continue;
				if (sessionDirBelongsToRepo(row.directory, cwd)) sessionIds.push(row.id);
			}
			if (sessionIds.length === 0) return [];

			const placeholders = sessionIds.map(() => "?").join(",");
			const parts = db
				.prepare(
					`SELECT id, session_id, time_created, data FROM part
					 WHERE session_id IN (${placeholders}) AND json_extract(data,'$.tool') = 'skill'
					 ORDER BY time_created`,
				)
				.all(...sessionIds) as Array<{ id: string; session_id: string; time_created: number; data: string }>;
			if (parts.length === 0) return [];

			const messages = db
				.prepare(
					`SELECT id, session_id, time_created, data FROM message
					 WHERE session_id IN (${placeholders}) ORDER BY time_created`,
				)
				.all(...sessionIds) as Array<{ id: string; session_id: string; time_created: number; data: string }>;

			return groupBySession(parts, messages);
		});

		let persisted = 0;
		for (const group of scoped) {
			const { uses } = scanOpenCodeSkillRows(group.parts, group.messages);
			for (const use of uses) {
				// `<source>:<sessionId>` — the key shape the per-session usage split is
				// stored under, so a detached conversation can be subtracted from it.
				await upsertSkillEntry({ ...use, sessionKey: `opencode:${group.sessionId}` }, cwd);
				persisted++;
			}
		}
		if (persisted > 0) log.info("Persisted %d OpenCode skill(s)", persisted);
		return persisted;
	} catch (err) {
		log.debug("OpenCode skill discovery skipped: %s", err instanceof Error ? err.message : String(err));
		return 0;
	}
}

interface SessionGroup {
	readonly sessionId: string;
	readonly parts: OpenCodeRow[];
	readonly messages: OpenCodeRow[];
}

/**
 * Split rows per session.
 *
 * Interval attribution is positional WITHIN one conversation, so rows from two
 * sessions must never share a timeline — interleaving them by timestamp would let
 * one session's turns be billed to another's skill.
 */
function groupBySession(
	parts: ReadonlyArray<{ id: string; session_id: string; time_created: number; data: string }>,
	messages: ReadonlyArray<{ id: string; session_id: string; time_created: number; data: string }>,
): SessionGroup[] {
	const groups = new Map<string, SessionGroup>();
	const ensure = (sessionId: string): SessionGroup => {
		let group = groups.get(sessionId);
		if (group === undefined) {
			group = { sessionId, parts: [], messages: [] };
			groups.set(sessionId, group);
		}
		return group;
	};
	for (const p of parts) ensure(p.session_id).parts.push({ id: p.id, timeCreated: p.time_created, data: p.data });
	// Only sessions that actually contain a skill row need their messages walked.
	for (const m of messages) {
		const group = groups.get(m.session_id);
		if (group !== undefined) group.messages.push({ id: m.id, timeCreated: m.time_created, data: m.data });
	}
	return [...groups.values()];
}
