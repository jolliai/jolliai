/**
 * One run of the session sync: gate, read, send, reconcile, persist.
 *
 * The channel is CROSS-REPO. There is one database per machine, so a run carries
 * whatever is new across every repo on it, and the envelope has no repo field —
 * `repo_identity` rides on the rows. Two consequences shape everything here:
 *
 *  - Any trigger, from any project, does the whole machine's work. Several open
 *    projects therefore mean several triggers wanting the same job, which is what
 *    the machine-level `lastAttemptAtMs` throttle is for. It is not a politeness
 *    delay; it is what stops N daemons from each pushing the same rows.
 *  - The gates are about the PRODUCT being on, not about any repo's binding.
 *    Session statistics need no Space: the API key carries the organisation, so
 *    there is nowhere else for them to go. See {@link runSessionSync} for the
 *    two that are still enforced.
 *  - `jolli disable` is therefore NOT a gate here but a ROW FILTER, and that is
 *    the only shape that can keep the promise the Settings page makes. A gate can
 *    only answer for the repo that triggered the run — every other repo's rows
 *    are in the same batch — so it both let a disabled repo's backlog out through
 *    any other trigger and, when it did fire, stopped the whole machine over one
 *    switched-off repo. See {@link disabledIdentities}.
 *
 * Nothing here may throw at its caller. It runs beside a git hook and beside a
 * memory push, and neither may fail because a statistics upload did.
 */

import { parseBaseUrl } from "../core/JolliApiUtils.js";
import {
	ClientOutdatedError,
	JolliMemoryPushClient,
	NotAuthenticatedError,
	PermissionDeniedError,
	SessionCursorAheadError,
	SessionEndpointMissingError,
	SessionPreconditionFailedError,
	type SessionPushResult,
} from "../core/JolliMemoryPushClient.js";
import {
	completeReplayForScope,
	cursorsFor,
	loadChannelForRun,
	MIN_ATTEMPT_INTERVAL_MS,
	prepareReplayForScope,
	readSessionPushChannel,
	replayForScope,
	type SessionPushChannelState,
	type SessionPushCursors,
	SILENCE_MS,
	silencedUntilFor,
	type TableCursor,
	toTableCursor,
	withCursors,
	withReplayCursors,
	withSilence,
	writeSessionPushChannel,
} from "../core/SessionPushCursor.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createLogger, errMsg } from "../Logger.js";
import { canUseDashboardDb, getDashboardDbPath, withReadonlyDashboardDb } from "./DashboardDb.js";
import { isRepoDisabled, readRepoRegistryStrict } from "./RepoRegistry.js";
import { BATCH_LIMITS, SYNCED_TABLES, type SyncedTable } from "./SessionPushManifest.js";
import {
	batchSize,
	batchTables,
	isBatchEmpty,
	isBatchTruncated,
	readDbInstanceId,
	readSessionBatch,
	type SessionBatch,
	type TableSlice,
} from "./SessionPushReader.js";

const log = createLogger("SessionSync");

/**
 * Batches per run. The first run on a well-used machine can be thousands of
 * rows; without a ceiling that is dozens of serial requests inside one
 * background run. Stopping early is not a failure — the cursor is exactly the
 * mechanism that makes the rest someone else's turn.
 */
export const MAX_BATCHES_PER_RUN = 10;

/**
 * Consecutive 409s tolerated before the run gives up until next time.
 *
 * A 409 is normally self-correcting: adopt the server's cursor, send that range,
 * done. A server that keeps answering 409 is one whose cursor is moving
 * backwards under us, and retrying that forever is a spin, not a recovery.
 */
export const MAX_CURSOR_RETRIES = 2;

/** Request shape spoken by this build; see `SessionPushPayload.version`. */
const SESSION_PAYLOAD_VERSION = 3;

/**
 * Tables whose existing rows gained wire data and need one client-owned replay.
 *
 * This does not change the wire protocol and does not reset the server cursor.
 * The upgraded client walks these local tables independently from zero, so an
 * older client can continue writing its own server cursor without racing it.
 */
const HISTORICAL_REPLAY_TABLES = ["sessions", "session_tool_use", "skill_invocations"] as const;
const HISTORICAL_REPLAY_GENERATION = "skills-mcps-fields-v1";

export interface SessionSyncOptions {
	/**
	 * No `cwd`: this run has no repo of its own. The channel is cross-repo, so
	 * every trigger does the whole machine's work, and which repos are switched
	 * off is asked of each repo's own profile — see {@link disabledIdentities}.
	 */
	readonly nowMs?: number;
	readonly client?: JolliMemoryPushClient;
	readonly configDir?: string;
	/**
	 * Bypasses the throttle AND a backend silence. For an explicit, user-initiated
	 * run — `jolli doctor --sync-sessions` is the one caller.
	 *
	 * ⚠ It has to cover the silence, not just the throttle. A silence is a 24h bet
	 * that the server's answer will not change, and the moment an operator fixes
	 * the server that bet is wrong; without a bypass the only way out was editing
	 * `session-push-channel.json` by hand. The bypass is logged, so a forced run
	 * that hits a still-refusing backend explains itself.
	 */
	readonly force?: boolean;
}
export type SessionSyncOutcome =
	| { readonly status: "skipped"; readonly reason: string }
	| {
			readonly status: "done";
			readonly batches: number;
			/** Rows the server acknowledged. Held rows are NOT in here — see `held`. */
			readonly rows: number;
			/**
			 * What the server did not take, and which tables it did not take it for.
			 *
			 * Kept out of `rows` because a caller that adds the two together turns the
			 * one failure this channel cannot report on its own back into a success
			 * line — see {@link unacknowledgedTables}.
			 *
			 * ⚠ One field rather than two, so the count cannot be printed without the
			 * names. Backend-first deployment is the policy, so this fires only when
			 * that policy was BROKEN — which makes it rare, and a rare signal has to be
			 * legible the one time someone sees it. "200 row(s) held" is not something
			 * a reader can act on; the table name is the whole actionable half, and it
			 * is what says which deploy is missing. The bug this PR fixed was already
			 * one number printed without the context that made it mean anything.
			 */
			readonly held: { readonly rows: number; readonly tables: ReadonlyArray<SyncedTable> };
	  }
	| { readonly status: "failed"; readonly reason: string };

/**
 * True when enough time has passed to attempt again. One file read.
 *
 * ⚠ Answers the THROTTLE only, never the silence: a silence belongs to one
 * backend scope, and the scope is not known until the key has been resolved,
 * which is `sync`'s job. Consulting it here would have to read the mark
 * scope-blind — the machine-wide behaviour that `silencedByScope` exists to
 * remove. A silenced scope is still bounded by this throttle, so the cost of the
 * split is one config read per 30 minutes, not per tick.
 */
export function isDueForSessionSync(nowMs: number, configDir?: string, intervalMs = MIN_ATTEMPT_INTERVAL_MS): boolean {
	// Deliberately a pure file read: a caller deciding whether there is anything
	// to do must not have to open SQLite to find out there is not.
	const state = readSessionPushChannel(configDir);
	return state.lastAttemptAtMs === undefined || nowMs - state.lastAttemptAtMs >= intervalMs;
}

/**
 * Reasons already reported by this process, so a stable state is stated once.
 *
 * The skip reasons below are conditions that hold for hours — a switch the user
 * turned off, a backend that refuses this scope — and every trigger on the
 * machine asks again. Logging each one every time buries the file; logging none
 * of them is what made a 24h silence leave no trace anywhere, which is the whole
 * reason this memo exists rather than a plain `log.debug`. A long-lived daemon
 * therefore states each reason once, and a short-lived hook process states it
 * once per commit.
 */
const reported = new Set<string>();

/**
 * Cap on {@link reported}, because one of its keys is not drawn from a fixed set.
 *
 * Every other key is a constant (`off`, `no-key`, …), but the catch-all in
 * {@link runSessionSync} keys on `throw:${errMsg(err)}` — an arbitrary string. In
 * a hook process that set dies in milliseconds; in the global daemon it lives for
 * as long as the machine is up, so a message carrying anything variable (a path, a
 * port, a timestamp) would grow it without bound. Clearing on overflow degrades
 * the memo to "state this reason again", which is the failure this whole mechanism
 * is a nicety for — never a correctness matter.
 */
const MAX_REPORTED_KEYS = 64;

/** Test seam: forget what this process has already reported. */
export function resetSessionSyncReportMemo(): void {
	reported.clear();
}

/** Logs at `info` the first time this process sees `key`. */
function reportOnce(key: string, message: string, ...args: unknown[]): void {
	if (reported.has(key)) return;
	if (reported.size >= MAX_REPORTED_KEYS) reported.clear();
	reported.add(key);
	log.info(message, ...args);
}

/** Whole hours left, rounded up — enough precision for "come back tomorrow". */
function hoursLeft(untilMs: number, nowMs: number): number {
	return Math.max(1, Math.ceil((untilMs - nowMs) / (60 * 60 * 1000)));
}

/**
 * Runs one sync. Never throws.
 *
 * Two gates, and only two:
 *
 *  - No API key — no credential, nowhere to send.
 *  - `syncSessions: false` — this channel's own switch. ⚠ Deliberately NOT
 *    `syncOnPush`, and not the per-repo push toggle: the decision is that session
 *    statistics go up for every repo, bound or not, which is exactly what those
 *    two do not mean. Reusing one would make the code contradict itself.
 *
 * ⚠ Every one of them says so in the log, once per process. They used to return
 * silently, and "nothing is being uploaded and nothing anywhere says why" is the
 * failure this channel actually shipped — a switched-off toggle, an invalid key
 * and a silenced scope were indistinguishable from a healthy machine with nothing
 * new to send. The throttle is the one skip that stays quiet: it is the normal
 * case, it resolves itself within the half hour, and it is the only one that
 * cannot be a misconfiguration.
 */
export async function runSessionSync(opts: SessionSyncOptions = {}): Promise<SessionSyncOutcome> {
	const nowMs = opts.nowMs ?? Date.now();
	try {
		const config = await loadConfig();
		if (config.syncSessions === false) {
			reportOnce("off", "session sync: not uploading — syncSessions is off in the config");
			return { status: "skipped", reason: "syncSessions is off" };
		}
		if (!config.jolliApiKey) {
			reportOnce("no-key", "session sync: not uploading — no API key configured");
			return { status: "skipped", reason: "not signed in" };
		}
		// Node without flag-free `node:sqlite`, or a machine that never enabled the
		// dashboard: skip whole, never an error. The rows stay put and the next
		// capable runtime sends them.
		if (!canUseDashboardDb()) {
			reportOnce("no-sqlite", "session sync: not uploading — this runtime cannot open the dashboard database");
			return { status: "skipped", reason: "runtime cannot open the database" };
		}
		if (!opts.force && !isDueForSessionSync(nowMs, opts.configDir)) {
			return { status: "skipped", reason: "throttled" };
		}
		return await sync(loadChannelForRun(opts.configDir), nowMs, opts);
	} catch (err) {
		// Includes "the database file does not exist", which is a normal state on a
		// machine that has never enabled a repo — hence `reportOnce` rather than a
		// line per attempt, and `info` rather than the `debug` this used to be: at
		// `debug` it was invisible under the default threshold, so a key with no
		// resolvable URL (this catch's other realistic arrival) reported nothing at
		// all while the upload stayed off indefinitely.
		reportOnce(`throw:${errMsg(err)}`, "session sync: not uploading — %s", errMsg(err));
		return { status: "skipped", reason: errMsg(err) };
	}
}

async function sync(
	initial: SessionPushChannelState,
	nowMs: number,
	opts: SessionSyncOptions,
): Promise<SessionSyncOutcome> {
	const client = opts.client ?? new JolliMemoryPushClient();
	const baseUrl = await client.resolveBaseUrl();
	const scope = scopeOf(baseUrl);
	const legacyKey = originOf(baseUrl);
	// ⚠ Written whatever happens, unlike the cursors, which move only on success.
	// It is a throttle: recording only successes would make every trigger retry a
	// request that is going to fail the same way. Written BEFORE the silence check
	// for the same reason — a silenced scope that left this mark alone would be
	// re-resolved on every tick instead of every throttle window.
	let state: SessionPushChannelState = { ...initial, lastAttemptAtMs: nowMs };
	writeSessionPushChannel(state, opts.configDir);

	const silencedUntil = silencedUntilFor(state, scope, nowMs);
	if (silencedUntil !== undefined) {
		if (!opts.force) {
			reportOnce(
				`silenced:${scope}:${silencedUntil}`,
				"session sync: not uploading to %s — silenced for another %dh after it refused this channel; run `jolli doctor --sync-sessions` to retry now",
				scope,
				hoursLeft(silencedUntil, nowMs),
			);
			return { status: "skipped", reason: "silenced" };
		}
		// Not `reportOnce`: an explicit run is a thing the user just did, and the
		// answer to "why did my forced sync try a backend that was refusing?" has to
		// be in the log for THAT run, not only for whichever earlier run first hit it.
		log.info(
			"session sync: %s is silenced for another %dh — retrying anyway (forced)",
			scope,
			hoursLeft(silencedUntil, nowMs),
		);
	}

	// Which repos are switched off, asked once per run rather than per batch: every
	// batch shares one answer, and the read is one `profile.json` per registered
	// repo. A throw here reaches `runSessionSync`'s catch — see the function.
	const excludedIdentities = await disabledIdentities(opts.configDir);
	if (excludedIdentities.size > 0) {
		reportOnce(
			`excluded:${excludedIdentities.size}`,
			"session sync: withholding %d disabled repository(ies) — their statistics are not uploaded, and re-enabling does not send the backlog",
			excludedIdentities.size,
		);
	}

	const dbPath = getDashboardDbPath();
	const instanceId = await withReadonlyDashboardDb(readDbInstanceId, { dbPath });
	state = reconcileInstance(state, instanceId, scope);
	state = prepareReplayForScope(state, scope, legacyKey, HISTORICAL_REPLAY_GENERATION, HISTORICAL_REPLAY_TABLES);
	writeSessionPushChannel(state, opts.configDir);

	let batches = 0;
	let rows = 0;
	let heldRows = 0;
	let cursorRetries = 0;
	let reconciled = false;
	// Tables this server stripped earlier in THIS run — see `unacknowledgedTables`.
	// A backend does not learn a table between two requests seconds apart, so
	// re-offering one costs a full page in every later request of the run and can
	// only be stripped again; the rows are already safe, because the same answer
	// held their cursor. Withholding them is also what keeps `heldRows` a count of
	// ROWS rather than of attempts.
	const heldTables = new Set<SyncedTable>();

	// Drain the one-time replay before ordinary incremental work. Its keysets are
	// local-only: a server may already hold a much higher cursor, and adopting that
	// response here would jump directly over the historical pages this pass exists
	// to resend. The server accepts a client behind its cursor and upserts the rows;
	// every acknowledged page is therefore advanced by the page's own local maximum.
	let replay = replayForScope(state, scope, HISTORICAL_REPLAY_GENERATION);
	const replayWasPending = replay !== undefined && !replay.completed;
	while (replay !== undefined && !replay.completed && batches < MAX_BATCHES_PER_RUN) {
		const completedTables = new Set(replay.completedTables);
		const includedTables = new Set<SyncedTable>(
			HISTORICAL_REPLAY_TABLES.filter((table) => !completedTables.has(table)),
		);
		if (includedTables.size === 0) {
			state = finishHistoricalReplay(state, scope, legacyKey, replay.cursors, completedTables);
			writeSessionPushChannel(state, opts.configDir);
			break;
		}
		const batch = await withReadonlyDashboardDb(
			(db) =>
				readSessionBatch(db, {
					cursors: replay?.cursors ?? {},
					nowMs,
					excludedIdentities,
					includedTables,
				}),
			{ dbPath },
		);

		// Empty affected tables need no acknowledgement. Recording them as drained
		// avoids manufacturing a request whose only purpose would be an empty cursor.
		for (const table of includedTables) {
			if (batch[table].rows.length === 0) completedTables.add(table);
		}
		if (isBatchEmpty(batch)) {
			state = finishHistoricalReplay(state, scope, legacyKey, replay.cursors, completedTables);
			writeSessionPushChannel(state, opts.configDir);
			break;
		}

		try {
			const result = await client.pushSessions({
				version: SESSION_PAYLOAD_VERSION,
				clientId: state.clientId,
				cursor: wireCursor(replay.cursors),
				tables: batchTables(batch),
			});
			batches++;
			cursorRetries = 0;
			const unknown = unacknowledgedTables(batch, result);
			const stripped = rowsIn(batch, unknown);
			rows += batchSize(batch) - stripped;
			heldRows += stripped;
			for (const table of unknown) heldTables.add(table);

			const maxima = localMaxima(batch);
			const nextReplayCursors: Record<string, TableCursor> = { ...replay.cursors };
			for (const table of includedTables) {
				if (unknown.has(table)) continue;
				const maximum = maxima[table];
				if (maximum !== undefined) nextReplayCursors[table] = maximum;
				if (batch[table].rows.length < BATCH_LIMITS[table]) completedTables.add(table);
			}

			if (HISTORICAL_REPLAY_TABLES.every((table) => completedTables.has(table))) {
				state = finishHistoricalReplay(state, scope, legacyKey, nextReplayCursors, completedTables);
			} else {
				state = withReplayCursors(state, scope, HISTORICAL_REPLAY_GENERATION, nextReplayCursors, [
					...completedTables,
				]);
			}
			writeSessionPushChannel(state, opts.configDir);

			if (unknown.size > 0) {
				log.warn(
					"session sync: historical replay is waiting for %s to be acknowledged by %s; its cursor remains queued",
					[...unknown].join(", "),
					scope,
				);
				break;
			}
			replay = replayForScope(state, scope, HISTORICAL_REPLAY_GENERATION);
		} catch (err) {
			if (err instanceof SessionCursorAheadError) {
				cursorRetries++;
				if (cursorRetries > MAX_CURSOR_RETRIES) {
					log.warn(
						"session sync: the server kept moving behind the historical replay — stopping until the next trigger",
					);
					return { status: "failed", reason: "cursor kept moving backwards" };
				}
				// A server cursor can only be below this dedicated replay after external
				// cursor loss. Restarting the three local walks is safe and prevents the
				// replay from claiming completion over a range the server forgot.
				const reset = replayOrigin();
				state = withReplayCursors(state, scope, HISTORICAL_REPLAY_GENERATION, reset);
				writeSessionPushChannel(state, opts.configDir);
				replay = replayForScope(state, scope, HISTORICAL_REPLAY_GENERATION);
				continue;
			}
			return { status: "failed", reason: classifyAndRecord(err, state, nowMs, scope, opts) };
		}
	}

	replay = replayForScope(state, scope, HISTORICAL_REPLAY_GENERATION);
	if (replay !== undefined && !replay.completed) {
		if (batches > 0) {
			log.info(
				"session sync: historical replay sent %d row(s) in %d batch(es); more remains queued",
				rows,
				batches,
			);
		}
		return { status: "done", batches, rows, held: { rows: heldRows, tables: [...heldTables] } };
	}
	if (replayWasPending && batches > 0) {
		log.info("session sync: historical replay completed after %d row(s) in %d batch(es)", rows, batches);
		return { status: "done", batches, rows, held: { rows: heldRows, tables: [...heldTables] } };
	}

	while (batches < MAX_BATCHES_PER_RUN) {
		const cursors = cursorsFor(state, scope, legacyKey);
		const batch = withoutHeldTables(
			await withReadonlyDashboardDb((db) => readSessionBatch(db, { cursors, nowMs, excludedIdentities }), {
				dbPath,
			}),
			heldTables,
		);
		// An empty batch still gets ONE request per run, and only the first one.
		// Reconciliation happens on requests, so a client whose cursor sits above
		// every local row would otherwise never contact the server at all — and
		// that is precisely the shape of "pointed at a fresh backend": nothing new
		// to send, so nothing discovers that the new backend has none of it. One
		// small request per throttle window closes it.
		if (isBatchEmpty(batch)) {
			if (reconciled || isEmptyCursor(cursors)) break;
			reconciled = true;
		}
		try {
			const result = await client.pushSessions({
				// Keep the full keyset position in the server's response. A bare stamp
				// cannot advance through a millisecond containing a full page of rows.
				version: SESSION_PAYLOAD_VERSION,
				clientId: state.clientId,
				cursor: wireCursor(cursors),
				tables: batchTables(batch),
			});
			batches++;
			cursorRetries = 0;
			// A table this server does not know keeps its cursor where it is, so its
			// rows are offered again on the next RUN instead of being stepped over —
			// and are withheld for the rest of THIS one.
			const unknown = unacknowledgedTables(batch, result);
			for (const table of unknown) heldTables.add(table);
			const stripped = rowsIn(batch, unknown);
			// ⚠ Held rows are counted OUT of the total, never into it. `rows` is what
			// `jolli doctor` prints as "Uploaded N row(s)", so counting rows the server
			// stripped is the one place this failure reads back as a success — which is
			// the whole thing `unacknowledgedTables` exists to stop.
			rows += batchSize(batch) - stripped;
			heldRows += stripped;
			if (unknown.size > 0) {
				log.warn(
					"session sync: %s acknowledged neither a row count nor a cursor for %s — holding that cursor; " +
						"the %d row(s) stay queued until the backend implements the table",
					scope,
					[...unknown].join(", "),
					stripped,
				);
			}
			// The server's answer wins where it has one — it is the authority on what
			// it holds, and taking its word is what lets a restored-from-backup server
			// pull the client back. Where it says nothing, the batch's own high-water
			// mark is used, which is what guarantees the loop advances: a server that
			// echoes no cursor would otherwise leave the same rows selected forever
			// and burn the whole per-run ceiling re-sending them.
			const before = cursorsFor(state, scope, legacyKey);
			const adopted = adoptCursor(before, result.cursor, localMaxima(batch), unknown);
			state = withCursors(state, scope, adopted);
			writeSessionPushChannel(state, opts.configDir);
			// Nothing was truncated, so this batch WAS the remainder. Selection is
			// `>=`, so looping again would re-read the boundary row and keep doing so
			// until the per-run ceiling — see `isBatchTruncated`.
			if (!isBatchTruncated(batch)) break;
			// Truncated, but nothing moved: the next read returns the identical rows.
			// Still load-bearing after {@link withoutHeldTables}, and for the case that
			// function CANNOT cover — a table is only withheld once it has been
			// stripped, so the FIRST batch of a run whose only backlog is a held table
			// arrives here truncated with every cursor where it started. Withholding
			// removes the repeat; this is what ends the run. The other producer left is
			// a server echoing a cursor it has already given us, since a keyset cursor
			// otherwise advances by at least one row per pass. Breaking costs nothing a
			// later run does not do: the cursor is exactly where the next trigger
			// should resume.
			if (!cursorsAdvanced(before, adopted)) break;
		} catch (err) {
			if (err instanceof SessionCursorAheadError) {
				cursorRetries++;
				if (cursorRetries > MAX_CURSOR_RETRIES) {
					log.warn("session sync: the server kept rejecting our cursor — stopping until the next trigger");
					return { status: "failed", reason: "cursor kept moving backwards" };
				}
				// ⚠ Down, never up: this is the whole point. The server is missing a
				// range we thought we had delivered, and only lowering the cursor
				// re-sends it. `null` means the server has no record at all, which is
				// treated as "lower than anything" — the new-backend case.
				state = withCursors(state, scope, adoptCursor(cursorsFor(state, scope, legacyKey), err.serverCursor));
				writeSessionPushChannel(state, opts.configDir);
				log.info("session sync: adopted the server's cursor and re-sending that range");
				continue;
			}
			return { status: "failed", reason: classifyAndRecord(err, state, nowMs, scope, opts) };
		}
	}
	const held = { rows: heldRows, tables: [...heldTables] };
	if (batches > 0) {
		log.info(
			"session sync: sent %d row(s) in %d batch(es)%s",
			rows,
			batches,
			held.rows === 0 ? "" : `; ${held.rows} row(s) held for ${held.tables.join(", ")}`,
		);
	}
	return { status: "done", batches, rows, held };
}

/**
 * Silences ONE SCOPE for the failures that cannot be retried into success, and
 * names the rest.
 *
 * ⚠ Every branch logs, and that is the point of the function rather than a
 * detail of it. The three silencing branches used to return their reason as a
 * string and log nothing — and both callers drop the returned outcome
 * (`QueueWorker` is `void runSessionSync().catch()`, the daemon hands it to a
 * `log.debug`), so a scope going quiet for 24h left no line anywhere. The 401
 * branch was the same, and worse: it silences nothing, so an invalid key retried
 * every half hour forever with no trace at all.
 *
 * ⚠ None of these touches the repo→Space binding cache. The memory push clears
 * it on 401/403/412 because there those really are answers about a binding; here
 * they are answers about a scope, and clearing it would degrade an unrelated,
 * user-visible Space display.
 *
 * ⚠ Every branch dispatches on a CLASS, never on the message. Two of them used to
 * be regexes over `errMsg(err)` (`/HTTP 404/`, `/HTTP 412/`) and both were
 * fragile by construction: the client raises a non-2xx as the server's own
 * message when the body carries one, so a 404 answered `{"error":"Not Found"}` —
 * the ordinary gateway shape — fell through to the last line and was retried
 * every half hour for ever, which is precisely the outcome the silences exist to
 * prevent. `SessionEndpointMissingError` / `SessionPreconditionFailedError` are
 * keyed on the status where the status is known.
 */
function classifyAndRecord(
	err: unknown,
	state: SessionPushChannelState,
	nowMs: number,
	scope: string,
	opts: SessionSyncOptions,
): string {
	if (err instanceof NotAuthenticatedError) {
		// Not silenced, deliberately: a key is re-issued by the user, and the next
		// attempt after they do must go through. `warn`, because unlike the silences
		// below this one will not clear on its own.
		log.warn("session sync: %s rejected our credentials (401) — not uploading until the API key is fixed", scope);
		return "not authenticated";
	}
	if (
		err instanceof PermissionDeniedError ||
		err instanceof ClientOutdatedError ||
		err instanceof SessionEndpointMissingError
	) {
		// `SessionEndpointMissingError` covers BOTH ways a deployment says "no such
		// endpoint": an honest 404, and a single-page app answering an unknown route
		// with 200 and its `index.html` (which is what production actually did — the
		// channel reported success for months and nothing had ever been ingested).
		// The client raises one class for the two because they call for the same
		// answer here: silence the scope for a day rather than retry it 48 times.
		writeSessionPushChannel(withSilence(state, scope, nowMs + SILENCE_MS, nowMs), opts.configDir);
		log.warn("session sync: %s refused this channel (%s) — silencing it for 24h", scope, errMsg(err));
		return `not available on this backend (${errMsg(err)}) — silenced for 24h`;
	}
	if (err instanceof SessionPreconditionFailedError) {
		// 412 should be unreachable: this channel does not require a binding. If one
		// arrives, the server has made a binding a precondition after all, and that
		// disagreement must be findable rather than retried into the ground.
		writeSessionPushChannel(withSilence(state, scope, nowMs + SILENCE_MS, nowMs), opts.configDir);
		log.warn(
			"session sync: %s answered 412 — it appears to require a binding, which this channel does not; silencing it for 24h",
			scope,
		);
		return "server requires a binding (412) — silenced for 24h";
	}
	log.info("session sync failed against %s: %s", scope, errMsg(err));
	return errMsg(err);
}

/**
 * The identities of every registered repo that `jolli disable` is set on.
 *
 * ⚠ A STRICT registry read, so an unreadable registry FAILS THE RUN instead of
 * degrading to "nothing is disabled". Every other read in this module fails open
 * because the cost of being wrong is a slower page or a delayed upload; the cost
 * here is shipping statistics from a repo whose owner switched the product off,
 * and no later run can take that back. `runSessionSync`'s catch turns the throw
 * into a skipped run with a line in the log.
 *
 * `isRepoDisabled` is the same predicate `DbBackfill` and `listActiveRepos` use,
 * deliberately: "which repos do I import", "which repos does the database call
 * paused" and "which repos do I withhold from the wire" must not be three
 * predicates that can disagree. It asks EVERY live checkout, because a registry
 * row is one repo IDENTITY while `profile.json` is per clone — one clone still
 * enabled means the repo is.
 */
async function disabledIdentities(configDir?: string): Promise<ReadonlySet<string>> {
	const registry = await readRepoRegistryStrict(configDir);
	return new Set(registry.repos.filter((repo) => isRepoDisabled(repo)).map((repo) => repo.repoIdentity));
}

/**
 * Drops THIS SCOPE's cursors when the database is not the one the progress
 * belongs to.
 *
 * A rebuilt database re-derives its rows, and their stamps can land BELOW the
 * stored cursor — rows no cursor would ever select again, with nothing to report
 * it. An absent id means the database has never been asked for one (it is minted
 * lazily by a writer), and this path is read-only, so it neither mints nor binds:
 * it simply leaves the recorded id alone.
 *
 * ⚠ One scope, not all of them, and the recorded id moves on the first run that
 * notices — so a scope this machine has not talked to since the rebuild keeps a
 * cursor that may sit above every local row, and will never be reset from here.
 * That is deliberate rather than an oversight: it self-heals through the server,
 * which is the only party that knows what a given backend actually holds. The
 * empty-batch reconciliation in {@link sync} guarantees one request per throttle
 * window even with nothing to send, the server answers 409 `cursor_ahead` (or
 * echoes its own lower cursor), and `adoptCursor` takes it. Resetting every
 * scope here instead would re-send the whole 90-day window to every backend the
 * machine has ever used, on the strength of a rebuild that says nothing about
 * what any of them received.
 */
function reconcileInstance(
	state: SessionPushChannelState,
	instanceId: string | undefined,
	scope: string,
): SessionPushChannelState {
	if (instanceId === undefined) return state;
	if (state.dbInstanceId === instanceId) return state;
	if (state.dbInstanceId !== undefined) {
		log.info("session sync: the local database was rebuilt — restarting from the first-run window");
		return { ...withCursors(state, scope, {}), dbInstanceId: instanceId };
	}
	return { ...state, dbInstanceId: instanceId };
}

/** Zero keysets for every table in the one-time historical replay. */
function replayOrigin(): SessionPushCursors {
	return Object.fromEntries(HISTORICAL_REPLAY_TABLES.map((table) => [table, { stamp: 0, key: [] }]));
}

/**
 * Atomically publishes the replay's final local positions as normal progress and
 * records the generation complete. The positions remain local maxima rather
 * than the server's reply: a higher server cursor may have been written by an
 * old client, and using it here would reintroduce the range-skipping race this
 * replay is designed to avoid.
 */
function finishHistoricalReplay(
	state: SessionPushChannelState,
	scope: string,
	legacyKey: string | undefined,
	replayCursors: SessionPushCursors,
	completedTables: ReadonlySet<string>,
): SessionPushChannelState {
	const normal: Record<string, TableCursor> = { ...cursorsFor(state, scope, legacyKey) };
	for (const table of HISTORICAL_REPLAY_TABLES) {
		normal[table] = replayCursors[table] ?? { stamp: 0, key: [] };
	}
	return completeReplayForScope(
		withCursors(state, scope, normal),
		scope,
		HISTORICAL_REPLAY_GENERATION,
		replayCursors,
		[...completedTables],
	);
}

/** Only the tables that have a cursor — an absent one means "first run". */
function wireCursor(cursors: SessionPushCursors): Record<string, TableCursor> {
	const wire: Record<string, TableCursor> = {};
	for (const table of SYNCED_TABLES) {
		const value = cursors[table];
		if (value !== undefined) wire[table] = value;
	}
	return wire;
}

/**
 * The batch minus every table this run has already seen stripped.
 *
 * ⚠ Withheld for the REST OF THIS RUN only — never persisted, and never a reason
 * to stop reading the table. The next trigger offers it again from the same
 * cursor, and it starts landing the day the backend learns the name with nothing
 * to replay by hand. See {@link unacknowledgedTables} for what "stripped" means
 * and why holding the cursor is what makes the rows safe.
 *
 * ⚠ Its reason is CORRECTNESS, and reading it as a bandwidth optimisation is how
 * it gets deleted. `held.rows` has to count rows, and without this it counts
 * ATTEMPTS: a held table with a backlog above its batch limit reports
 * `isBatchTruncated` for ever, so while a SECOND table was still draining, the
 * run re-read the identical page in every pass and added it to the total again
 * each time. The number then over-reports exactly the way `rows` used to.
 *
 * The bandwidth it also saves — one full page per later request in the run
 * (`BATCH_LIMITS` carries what one weighs on this table), bounded only by
 * `MAX_BATCHES_PER_RUN` — is real but is NOT what justifies it. Backend-first
 * deployment is the policy, so the state this function optimises should exist
 * only inside a deploy window; measured against that, saving the bytes alone
 * would not be worth the mechanism.
 */
function withoutHeldTables(batch: SessionBatch, held: ReadonlySet<SyncedTable>): SessionBatch {
	if (held.size === 0) return batch;
	const next = { ...batch } as Record<SyncedTable, TableSlice>;
	// No `next` keyset: an empty slice must contribute nothing to `localMaxima`,
	// or the cursor this whole mechanism is holding would advance anyway.
	for (const table of held) next[table] = { rows: [], skipped: 0 };
	return next;
}

/** Rows this batch carried for the named tables. */
function rowsIn(batch: SessionBatch, tables: ReadonlySet<string>): number {
	return SYNCED_TABLES.reduce((sum, table) => (tables.has(table) ? sum + batch[table].rows.length : sum), 0);
}

/**
 * Tables this batch SENT that the server acknowledged in no way at all.
 *
 * ⚠ The one failure this channel cannot report on its own. A request schema is a
 * closed object: a table the backend has not learned is STRIPPED, and the batch
 * still answers 2xx with a cursor for everything else — so the rows were never
 * stored, nothing was refused, and `localMaxima` would step the cursor over them
 * for ever. This repo has already paid for that once, from the other direction:
 * `recall_receipts` uploaded into a schema that never listed it for its whole
 * life (see `NEVER_SYNCED_TABLES`). Client and backend deploy independently, so
 * every new table spends some window in exactly this state.
 *
 * Two signals, and either one counts as an acknowledgement:
 *  - an `accepted[table]` KEY — the server says it processed this table. The
 *    count itself is deliberately not compared with the page length: selection
 *    is `>=`, so every non-first page re-sends one already-stored boundary row,
 *    and a backend may report newly inserted rows rather than submitted rows.
 *  - a KEY in the cursor reply. The backend fills one for every table it knows,
 *    `null` included ("I know it, I hold nothing"), so an ABSENT key is the
 *    server saying it does not know the table rather than having no opinion. That
 *    has been true of every deployed version of this endpoint, which is what makes
 *    reading it this way safe rather than a new protocol rule.
 *
 * Only tables with rows IN THIS BATCH: nothing was at risk for the rest, and a
 * reconcile ping sends none at all.
 *
 * ⚠ PARTIAL acknowledgement only — a reply that names no table at all is left
 * alone, and that is deliberate rather than an oversight. "Named some, not this
 * one" is a statement ABOUT this table; "named nothing" is the wholesale case the
 * fallback below exists for, and reading it as a refusal would hold every cursor
 * for ever against a backend that simply echoes no per-table detail. The absent
 * shape of that case is already fatal upstream: `pushSessions` raises
 * `SessionEndpointMissingError` when rows were sent and BOTH fields are missing.
 * The residual is the empty-but-present `{accepted: {}, cursor: {}}`, which stays
 * the fallback's; tightening it belongs to that guard, where the whole response
 * is in view.
 */
function unacknowledgedTables(batch: SessionBatch, result: SessionPushResult): ReadonlySet<SyncedTable> {
	const unknown = new Set<SyncedTable>();
	if (Object.keys(result.accepted).length === 0 && Object.keys(result.cursor).length === 0) return unknown;
	for (const table of SYNCED_TABLES) {
		if (batch[table].rows.length === 0) continue;
		if (result.accepted[table] === undefined && !(table in result.cursor)) unknown.add(table);
	}
	return unknown;
}

/** True when any table's cursor moved — the loop's proof that it can make progress. */
function cursorsAdvanced(before: SessionPushCursors, after: SessionPushCursors): boolean {
	return SYNCED_TABLES.some((table) => !sameCursor(before[table], after[table]));
}

function sameCursor(a: TableCursor | undefined, b: TableCursor | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.stamp === b.stamp && a.key.length === b.key.length && a.key.every((k, i) => k === b.key[i]);
}

/**
 * Applies the server's cursor.
 *
 * A cursor replaces. An explicit `null` CLEARS — "this backend has no record"
 * has to read as lower than anything rather than as no opinion, or the client
 * carries on from its own high-water mark and the range below it never reaches
 * that backend. A table the server did not mention falls back to `fallback` (the
 * batch's own last row on success, nothing on a rejection), then to what the
 * client already had.
 *
 * ⚠ `held` overrides that fallback, and it is the only thing standing between a
 * table the backend has not deployed yet and a cursor stepping over rows nobody
 * stored — see {@link unacknowledgedTables}. Held means "keep what the client
 * had": not cleared (that would re-push the whole 90-day window once the backend
 * lands) and not advanced. It is deliberately NOT a reason to stop READING the
 * table: {@link withoutHeldTables} withholds it for the rest of the current run
 * only, so the rows are offered again on the next one and start landing the day
 * the backend learns the name, with nothing to replay by hand.
 *
 * ⚠ A server answering with a bare NUMBER is read as `{stamp, key: []}` — the
 * start of that millisecond. A backend that has not learned the keyset yet
 * therefore keeps working and simply re-delivers one millisecond per pass into
 * an upsert; what it must not do is make the client drop back to stamp-only
 * paging, which is the deadlock this replaced.
 */
function adoptCursor(
	current: SessionPushCursors,
	server: Readonly<Record<string, TableCursor | number | null>>,
	fallback: Readonly<Record<string, TableCursor>> = {},
	held: ReadonlySet<string> = new Set(),
): SessionPushCursors {
	const next: Record<string, TableCursor> = {};
	for (const table of SYNCED_TABLES) {
		if (held.has(table)) {
			const kept = current[table];
			if (kept !== undefined) next[table] = kept;
			continue;
		}
		const answered = table in server ? server[table] : (fallback[table] ?? current[table] ?? null);
		const cursor = answered === null ? undefined : toTableCursor(answered);
		if (cursor !== undefined) next[table] = cursor;
	}
	return next;
}

/** Each table's last row in this batch — the local view of progress. */
function localMaxima(batch: SessionBatch): Record<string, TableCursor> {
	const maxima: Record<string, TableCursor> = {};
	for (const table of SYNCED_TABLES) {
		const value = batch[table].next;
		if (value !== undefined) maxima[table] = value;
	}
	return maxima;
}

/** True when this origin has no recorded progress at all — a first run. */
function isEmptyCursor(cursors: SessionPushCursors): boolean {
	return SYNCED_TABLES.every((table) => cursors[table] === undefined);
}

/**
 * The backend's origin — the key EARLIER BUILDS filed progress under, kept only
 * so {@link cursorsFor} can fall back to it on the first scoped run.
 */
function originOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return baseUrl;
	}
}

/**
 * The key local progress and silences are filed under: origin plus tenant slug.
 *
 * ⚠ The tenant is part of it because one origin serves many, and neither a
 * cursor nor a refusal carries across them. Filing by origin alone made two
 * tenants on one host share a cursor (survivable — the server answers 409 and the
 * client re-sends) and, before `silencedByScope`, made one tenant's 403 stop the
 * others (not survivable — nothing retries for 24h).
 *
 * `parseBaseUrl` reads the slug off the first path segment, which is exactly what
 * the request itself sends as `x-tenant-slug`, so this key cannot disagree with
 * the tenant the rows actually went to.
 */
function scopeOf(baseUrl: string): string {
	try {
		const { origin, tenantSlug } = parseBaseUrl(baseUrl);
		return tenantSlug === undefined ? origin : `${origin}/${tenantSlug}`;
	} catch {
		return baseUrl;
	}
}
