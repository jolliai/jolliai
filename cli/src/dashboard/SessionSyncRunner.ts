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
} from "../core/JolliMemoryPushClient.js";
import {
	cursorsFor,
	loadChannelForRun,
	MIN_ATTEMPT_INTERVAL_MS,
	readSessionPushChannel,
	type SessionPushChannelState,
	type SessionPushCursors,
	SILENCE_MS,
	silencedUntilFor,
	type TableCursor,
	toTableCursor,
	withCursors,
	withSilence,
	writeSessionPushChannel,
} from "../core/SessionPushCursor.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createLogger, errMsg } from "../Logger.js";
import { canUseDashboardDb, getDashboardDbPath, withReadonlyDashboardDb } from "./DashboardDb.js";
import { isRepoDisabled, readRepoRegistryStrict } from "./RepoRegistry.js";
import { SYNCED_TABLES } from "./SessionPushManifest.js";
import {
	batchSize,
	batchTables,
	isBatchEmpty,
	isBatchTruncated,
	readDbInstanceId,
	readSessionBatch,
	type SessionBatch,
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
	| { readonly status: "done"; readonly batches: number; readonly rows: number }
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

	let batches = 0;
	let rows = 0;
	let cursorRetries = 0;
	let reconciled = false;
	while (batches < MAX_BATCHES_PER_RUN) {
		const cursors = cursorsFor(state, scope, legacyKey);
		const batch = await withReadonlyDashboardDb(
			(db) => readSessionBatch(db, { cursors, nowMs, excludedIdentities }),
			{ dbPath },
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
				version: 1,
				clientId: state.clientId,
				cursor: wireCursor(cursors),
				tables: batchTables(batch),
			});
			rows += batchSize(batch);
			batches++;
			cursorRetries = 0;
			// The server's answer wins where it has one — it is the authority on what
			// it holds, and taking its word is what lets a restored-from-backup server
			// pull the client back. Where it says nothing, the batch's own high-water
			// mark is used, which is what guarantees the loop advances: a server that
			// echoes no cursor would otherwise leave the same rows selected forever
			// and burn the whole per-run ceiling re-sending them.
			state = withCursors(
				state,
				scope,
				adoptCursor(cursorsFor(state, scope, legacyKey), result.cursor, localMaxima(batch)),
			);
			writeSessionPushChannel(state, opts.configDir);
			// Nothing was truncated, so this batch WAS the remainder. Selection is
			// `>=`, so looping again would re-read the boundary row and keep doing so
			// until the per-run ceiling — see `isBatchTruncated`.
			if (!isBatchTruncated(batch)) break;
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
	if (batches > 0) log.info("session sync: sent %d row(s) in %d batch(es)", rows, batches);
	return { status: "done", batches, rows };
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
 * Applies the server's cursor.
 *
 * A cursor replaces. An explicit `null` CLEARS — "this backend has no record"
 * has to read as lower than anything rather than as no opinion, or the client
 * carries on from its own high-water mark and the range below it never reaches
 * that backend. A table the server did not mention falls back to `fallback` (the
 * batch's own last row on success, nothing on a rejection), then to what the
 * client already had.
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
): SessionPushCursors {
	const next: Record<string, TableCursor> = {};
	for (const table of SYNCED_TABLES) {
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
