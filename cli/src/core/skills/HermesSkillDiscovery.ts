/**
 * HermesSkillDiscovery — reads Hermes' state database and persists skill usage.
 *
 * Hermes' shell hooks are machine-global and opt-in (they have to be declared in
 * `~/.hermes/config.yaml` and approved once), so this source is treated as
 * hook-poor and runs on the polling path like OpenCode's. Skills are a signal
 * about how the work is being done *right now*, so surfacing them only at commit
 * time would leave working memory empty for the whole session — exactly when the
 * information is useful.
 *
 * Structurally OpenCode's twin: open read-only through `withSqliteDb` (lazy
 * `node:sqlite` import, locked-retry backoff, guaranteed close, real WAL reads),
 * narrow to this repo's sessions with the shared directory matcher, then hand
 * each conversation's rows to {@link scanHermesSkillRows}.
 *
 * Two differences from OpenCode worth stating, both from the schema:
 *
 *   - **Every profile is scanned**, not one database. `hermes profile` gives a
 *     user isolated instances under `<home>/profiles/<name>/`, and a
 *     profile-only user's default `state.db` is empty — see
 *     {@link listHermesStateDbPaths}.
 *   - **Repo scoping reads two columns.** `git_repo_root` is authoritative when
 *     Hermes has filled it in (it is populated lazily and absent on many rows),
 *     `cwd` is the fallback — the same disjunction the session discoverer makes.
 */

import { createLogger, errMsg, isManuallyDisabled } from "../../Logger.js";
import { listHermesStateDbPaths } from "../HermesSessionDiscoverer.js";
import { sessionDirBelongsToRepo } from "../SessionDirMatch.js";
import { loadConfig, upsertSkillEntry } from "../SessionTracker.js";
import { withSqliteDb } from "../SqliteHelpers.js";
import { type HermesSkillRow, scanHermesSkillRows } from "./HermesSkillScanner.js";

const log = createLogger("HermesSkillDiscovery");

/**
 * How far back to look, by session activity.
 *
 * Matches OpenCode's window and carries the same stance: capture is
 * forward-only, so skill usage from months-old sessions is not back-filled. A
 * reader who finds an old skill call in the database and no row for it has NOT
 * found a bug; widening this would turn a design decision into a migration.
 */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-cwd single-flight registry, mirroring OpenCode / Codex discovery. */
const inFlight = new Map<string, Promise<number>>();

/**
 * Discover and persist Hermes skill usage for `cwd`.
 *
 * Returns the number of skills persisted. Silent and non-throwing on every
 * failure path: this runs fire-and-forget on a UI tick and at post-commit, and a
 * regressed reader must never take down the surface it feeds.
 *
 * **Single-flight per cwd**, for OpenCode's reason: the 60-second tick has
 * several callers, and overlapping runs would all be correct (`upsertSkillEntry`
 * serialises on plans.lock) but would contend for that lock while re-deriving the
 * same answer. A caller arriving mid-run joins the in-flight pass rather than
 * queueing another — skill rows change on the order of minutes.
 */
export function discoverHermesSkills(cwd: string): Promise<number> {
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
	if (config.hermesEnabled === false) return 0;

	let persisted = 0;
	for (const dbPath of await listHermesStateDbPaths()) {
		persisted += await runOneDb(dbPath, cwd);
	}
	if (persisted > 0) log.info("Persisted %d Hermes skill(s)", persisted);
	return persisted;
}

async function runOneDb(dbPath: string, cwd: string): Promise<number> {
	try {
		const groups = await withSqliteDb(dbPath, (db) => {
			const since = (Date.now() - LOOKBACK_MS) / 1000;

			// Sessions belonging to this repo. Directory matching goes through the
			// shared helper (prefix + separator + case folding + nested-repo exclusion)
			// rather than a SQL equality test, which would silently drop every session
			// started from a subdirectory of the repo.
			const sessionIds: string[] = [];
			for (const row of db
				.prepare(
					`SELECT id, cwd, git_repo_root FROM sessions
					 WHERE hidden = 0 AND COALESCE(last_activity_at, started_at) >= :since`,
				)
				.all({ since }) as Array<{ id: string; cwd: string | null; git_repo_root: string | null }>) {
				// A null directory is real in this data (a session started outside any
				// project) — the matcher guards it, but skipping early saves the call.
				const dirs = [row.git_repo_root, row.cwd].filter(
					(d): d is string => typeof d === "string" && d.trim().length > 0,
				);
				if (dirs.some((dir) => sessionDirBelongsToRepo(dir.trim(), cwd))) sessionIds.push(row.id);
			}
			if (sessionIds.length === 0) return [];

			// Rows are read PER SESSION rather than in one `IN (…)` query: the scanner
			// pairs a call with its result positionally within one conversation, and a
			// shared result set would have to be regrouped anyway.
			const stmt = db.prepare(
				`SELECT role, content, tool_call_id, tool_name, tool_calls, timestamp
				 FROM messages
				 WHERE session_id = :sessionId AND (active = 1 OR compacted = 1)
				 ORDER BY id`,
			);
			return sessionIds.map((sessionId) => ({
				sessionId,
				rows: (
					stmt.all({ sessionId }) as Array<{
						role: string;
						content: string | null;
						tool_call_id: string | null;
						tool_name: string | null;
						tool_calls: string | null;
						timestamp: number;
					}>
				).map(
					(r): HermesSkillRow => ({
						role: r.role,
						content: r.content,
						toolCallId: r.tool_call_id,
						toolName: r.tool_name,
						toolCalls: r.tool_calls,
						timestamp: r.timestamp,
					}),
				),
			}));
		});

		let persisted = 0;
		for (const group of groups) {
			for (const use of scanHermesSkillRows(group.rows)) {
				// `<source>:<sessionId>` — the key shape the per-session usage split is
				// stored under, so a detached conversation can be subtracted from it.
				await upsertSkillEntry({ ...use, sessionKey: `hermes:${group.sessionId}` }, cwd);
				persisted++;
			}
		}
		return persisted;
	} catch (err) {
		// Not installed, unreadable, or schema drift. Indistinguishable at this level
		// and treated the same way — there is nothing a user could act on either way,
		// and this runs on a tick that must never surface a stack trace.
		log.debug("Hermes skill discovery skipped for %s: %s", dbPath, errMsg(err));
		return 0;
	}
}
