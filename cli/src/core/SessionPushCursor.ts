/**
 * The session sync channel's own state file: cursors, client identity, the
 * throttle mark, and the per-scope silences.
 *
 * `~/.jolli/jollimemory/session-push-channel.json` — MACHINE-level, and that is
 * a correctness requirement rather than tidiness. The sync itself is cross-repo:
 * one run carries every repo's rows out of the one machine-level database (there
 * is only one). A per-project file would mean three open projects keep three
 * separate records of the same machine-wide progress, and each of their daemons
 * would push the whole machine again.
 *
 * It is deliberately NOT `config.json`: that file is the user's own settings, and
 * mixing runtime state into it makes the two overwrite each other.
 *
 * ⚠ No SQLite here, and no imports that reach it. Hooks call into this
 * synchronously to decide whether there is anything to do at all, and the whole
 * point of that check is that it costs one file read — opening the database to
 * find out there is nothing to send would defeat it.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger, errMsg, isEnoent } from "../Logger.js";
import { atomicWriteFileSync } from "./AtomicWrite.js";
import { getGlobalConfigDir } from "./SessionTracker.js";

const log = createLogger("SessionPushCursor");

/**
 * How far one table has been delivered: a sync stamp, plus the primary key of
 * the last row sent to break ties inside it.
 *
 * The key is what makes the cursor able to move. A stamp alone deadlocks the
 * moment more rows share a millisecond than fit in one batch — see
 * `KEYSET_COLUMNS` for the measurement. The tuple `(stamp, ...key)` is unique,
 * so it strictly increases with every row sent.
 *
 * An EMPTY key means "the start of that millisecond": every text key sorts at or
 * after `""`, so `(stamp, "") <=` any row in that millisecond. That is what lets
 * a bare stamp — all a backend echoing no tie-breaker gives us — be read as
 * `{stamp, key: []}` without skipping a row; it re-delivers that millisecond
 * once, which is harmless since the server upserts.
 */
export interface TableCursor {
	readonly stamp: number;
	/** PK values of the last row sent, in `KEYSET_COLUMNS` order. */
	readonly key: ReadonlyArray<string>;
}

/**
 * One cursor per table — see `SYNC_STAMP_COLUMNS` for why each has its own, and
 * why they must advance independently (a run where one table succeeds and
 * another fails would otherwise skip the failed one's rows forever).
 *
 * Keyed by table NAME rather than by the `SyncedTable` union on purpose: this
 * module is imported by hooks that must not reach SQLite, and the union lives
 * beside the reader that does. A stored file can also carry a table name a later
 * build renamed, which a closed union would refuse to represent.
 */
export type SessionPushCursors = Readonly<Record<string, TableCursor>>;

/**
 * Reads one table's cursor out of anything that might be stored or received:
 * this build's shape, a bare stamp with no tie-breaker, or junk.
 *
 * ⚠ Answers `undefined` rather than a zero cursor for junk, and the difference
 * matters: absent means "first run", which applies the 90-day window, while
 * `{stamp: 0}` means "deliver everything ever recorded". Guessing the second
 * from a corrupt file would push a machine's whole history.
 *
 * The key is NOT validated against a column count here — this module knows
 * nothing about table shapes by design. The reader pads or truncates it, which
 * degrades to re-delivering one millisecond rather than to a wrong page.
 */
export function toTableCursor(value: unknown): TableCursor | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? { stamp: value, key: [] } : undefined;
	if (!isRecord(value) || typeof value.stamp !== "number" || !Number.isFinite(value.stamp)) return undefined;
	const key = Array.isArray(value.key) ? value.key.filter((k): k is string => typeof k === "string") : [];
	return { stamp: value.stamp, key };
}

/** Every readable cursor in a stored or received map, junk entries dropped. */
export function toCursors(value: unknown): SessionPushCursors {
	if (!isRecord(value)) return {};
	const out: Record<string, TableCursor> = {};
	for (const [table, raw] of Object.entries(value)) {
		const cursor = toTableCursor(raw);
		if (cursor !== undefined) out[table] = cursor;
	}
	return out;
}

export interface SessionPushChannelState {
	readonly version: 1;
	/**
	 * Latest request payload version whose replay preparation has been applied.
	 *
	 * This is deliberately separate from `version`, which describes this FILE's
	 * shape. When a request version starts sending new columns, existing per-table
	 * cursors must move back to the start or those columns on already-acknowledged
	 * rows can never reach the server. Recording the preparation here makes that
	 * reset exactly-once and, unlike a database migration, gives it the actual
	 * persisted cursors for every backend scope.
	 */
	readonly payloadVersion?: number;
	/**
	 * This INSTALLATION's stable id, generated once. Not the database's instance
	 * id, which is the identity of the file and changes the moment it is rebuilt
	 * — precisely when resuming matters most. Two accepted edges: copying a home
	 * directory to a second machine shares one id (harmless — sessions are unique
	 * by `session_id`), and losing this file means becoming a new client, which
	 * falls back to the first-run window.
	 */
	readonly clientId: string;
	/**
	 * The database's own instance id as of the last successful run. A rebuilt
	 * database can hold rows whose stamps are LOWER than the cursor, which no
	 * cursor would ever select again, so a mismatch resets progress.
	 */
	readonly dbInstanceId?: string;
	/**
	 * Last attempt, success or failure. ⚠ Written on FAILURE too — unlike the
	 * cursors, which only move on success. It is a throttle, not progress: if it
	 * only moved on success, every tick would retry a request that is going to
	 * fail again.
	 */
	readonly lastAttemptAtMs?: number;
	/**
	 * Silence after a 403/404/412, PER SCOPE — see `SILENCE_MS` and
	 * {@link isChannelSilenced}.
	 *
	 * ⚠ It was one machine-wide `silencedUntilMs`, and that is the bug this field
	 * replaces: the refusal is an answer from ONE backend about ONE tenant, while
	 * the mark it wrote stopped every other backend too. Measured — a repo whose
	 * key briefly pointed at a deployment with the session scope off got the whole
	 * machine silenced for 24h, and re-pointing the key at a working backend
	 * minutes later changed nothing: the upload stayed off until the next day,
	 * having sent nothing and logged nothing.
	 *
	 * A legacy machine-wide mark is deliberately DROPPED on read rather than
	 * folded onto every scope. Keeping it would carry exactly the outage above
	 * across the upgrade that fixes it, and the cost of dropping it is one retry
	 * against a backend that will refuse again and re-silence its own scope.
	 */
	readonly silencedByScope: Readonly<Record<string, number>>;
	/**
	 * Progress per backend SCOPE — origin plus tenant slug, as
	 * `https://host[/tenant]`.
	 *
	 * Correctness does not depend on this split — the server reconciles every
	 * mismatch with a 409 — but without it, switching between a dev and a prod
	 * backend re-pushes a large range every time: rejected by dev, the cursor
	 * drops to dev's low-water mark, and the next prod run starts from there and
	 * re-sends everything prod already had.
	 *
	 * ⚠ The tenant slug is part of the key because one origin serves many
	 * tenants, and a cursor is meaningless across them. The field NAME stays
	 * `byOrigin` so an existing file keeps its progress: a bare-origin key written
	 * by an earlier build is still read, via the `legacyKey` argument of
	 * {@link cursorsFor}. New progress is written under the scoped key.
	 */
	readonly byOrigin: Readonly<Record<string, SessionPushCursors>>;
}

/**
 * How long a permission/endpoint refusal silences ONE scope.
 *
 * 403 and 404 both mean "this will not work until something changes on the
 * server" — a scope that is off, or a deployment that does not have the endpoint
 * yet. Retrying either on every trigger is pure noise.
 *
 * ⚠ Scoped, never machine-wide: see `SessionPushChannelState.silencedByScope`.
 * A user who wants the wait cut short does not have to edit this file — an
 * explicit `jolli` run passes `force`, which bypasses the silence and says so.
 */
export const SILENCE_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum gap between attempts, machine-wide — the upload's real period.
 *
 * Beside `SILENCE_MS` because the two are the same kind of thing: both throttle
 * this file's own marks (`lastAttemptAtMs` and `silencedUntilMs`), and both are
 * read to answer "is there anything to do" WITHOUT opening the database, which
 * is the whole point of `isDueForSessionSync` living one file read away from a
 * git hook.
 *
 * ⚠ It is enforced HERE, by the run itself, and never by how often a caller
 * asks. A scheduler that set its interval to this value would be a second owner
 * of the period, and a losing one: the comparison is `>=`, so any negative
 * jitter turns a tick that should have run into "throttled" and doubles the real
 * period. Callers tick faster and get told no — see `SESSION_SYNC_TICK_MS`.
 */
export const MIN_ATTEMPT_INTERVAL_MS = 30 * 60 * 1000;

/** Absolute path of the channel state file. */
export function getSessionPushChannelPath(configDir: string = getGlobalConfigDir()): string {
	return join(configDir, "session-push-channel.json");
}

function emptyState(): SessionPushChannelState {
	return { version: 1, clientId: randomUUID(), silencedByScope: {}, byOrigin: {} };
}

/**
 * Reads the state, answering a fresh one for anything unreadable.
 *
 * A corrupt or truncated file is treated as absent rather than surfaced: the
 * cost of losing the cursor is re-sending rows the server upserts anyway, while
 * throwing here would take down a git hook over a bookkeeping file.
 *
 * ⚠ Reading NEVER writes — no lazy `clientId` persistence here. Callers on the
 * decide-whether-to-run path must be able to ask without touching the disk.
 */
export function readSessionPushChannel(configDir?: string): SessionPushChannelState {
	return parseChannel(configDir).state;
}

/** The parse, plus whether the file already carried a usable state. */
function parseChannel(configDir?: string): { state: SessionPushChannelState; stored: boolean } {
	let raw: string;
	try {
		raw = readFileSync(getSessionPushChannelPath(configDir), "utf-8");
	} catch (err) {
		if (!isEnoent(err)) log.debug("session push channel state unreadable: %s", errMsg(err));
		return { state: emptyState(), stored: false };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<SessionPushChannelState>;
		if (parsed.version !== 1 || typeof parsed.clientId !== "string" || parsed.clientId === "") {
			return { state: emptyState(), stored: false };
		}
		return {
			state: {
				version: 1,
				clientId: parsed.clientId,
				...(typeof parsed.payloadVersion === "number" && Number.isInteger(parsed.payloadVersion)
					? { payloadVersion: parsed.payloadVersion }
					: {}),
				...(typeof parsed.dbInstanceId === "string" ? { dbInstanceId: parsed.dbInstanceId } : {}),
				...(typeof parsed.lastAttemptAtMs === "number" ? { lastAttemptAtMs: parsed.lastAttemptAtMs } : {}),
				// A legacy machine-wide `silencedUntilMs` is read past and dropped —
				// see `silencedByScope` for why it must not be folded onto the scopes.
				silencedByScope: toSilences(parsed.silencedByScope),
				// Normalised on the way in, so nothing downstream has to handle a
				// stored position that carries only a stamp.
				byOrigin: isRecord(parsed.byOrigin)
					? Object.fromEntries(Object.entries(parsed.byOrigin).map(([o, c]) => [o, toCursors(c)]))
					: {},
			},
			stored: true,
		};
	} catch {
		return { state: emptyState(), stored: false };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalises the stored silence map, dropping anything that is not a number.
 *
 * A garbled entry reads as "not silenced" rather than as an error: the worst
 * outcome is one request against a backend that refuses it and writes the mark
 * again, while refusing to run over a malformed bookkeeping value would stop the
 * upload with nothing able to repair it.
 */
function toSilences(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const out: Record<string, number> = {};
	for (const [scope, until] of Object.entries(value)) {
		if (typeof until === "number" && Number.isFinite(until)) out[scope] = until;
	}
	return out;
}

/** Writes the state. Best effort: a failure here must not fail a caller. */
export function writeSessionPushChannel(state: SessionPushChannelState, configDir?: string): void {
	const path = getSessionPushChannelPath(configDir);
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		// Atomic (tmpfile + rename), NOT a bare in-place write: this channel holds
		// no lock and three producers (the daemon tick, the commit-drain tail, and
		// `doctor --sync-sessions`) can overlap, so an in-place write let a reader —
		// or the next producer — observe a half-written file. The rename makes every
		// write all-or-nothing; the accepted residual is last-writer-wins on the
		// whole file, which costs one duplicated delivery into an upsert, never a
		// corrupt cursor map.
		atomicWriteFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 0o600);
	} catch (err) {
		log.debug("could not write session push channel state: %s", errMsg(err));
	}
}

/**
 * Reads the state, persisting a freshly generated `clientId` if there was none.
 *
 * Separate from {@link readSessionPushChannel} on purpose: this one writes, so
 * only a caller that has already decided to run may use it.
 */
export function loadChannelForRun(configDir?: string): SessionPushChannelState {
	const { state, stored } = parseChannel(configDir);
	// The generated id must be persisted BEFORE the run, not after it succeeds:
	// the server keys its own cursor on `clientId`, so a client that made a new
	// one on every failed attempt would look like a new machine each time and be
	// handed an empty cursor forever.
	if (!stored) writeSessionPushChannel(state, configDir);
	return state;
}

/**
 * Prepares existing scopes for a request payload that adds or renames columns.
 *
 * Only tables that ALREADY have a cursor are rewound, to `{stamp: 0}` rather
 * than removed. Removing it would invoke the 90-day first-run window and omit
 * older acknowledged rows whose new columns also need replaying; adding a zero
 * cursor to a fresh scope would do the opposite and upload its whole history.
 * Leaving absent cursors absent preserves both contracts.
 */
export function preparePayloadVersion(
	state: SessionPushChannelState,
	payloadVersion: number,
	replayTables: ReadonlyArray<string>,
): SessionPushChannelState {
	if ((state.payloadVersion ?? 0) >= payloadVersion) return state;
	const replay = new Set(replayTables);
	const byOrigin = Object.fromEntries(
		Object.entries(state.byOrigin).map(([scope, cursors]) => [
			scope,
			Object.fromEntries(
				Object.entries(cursors).map(([table, cursor]) => [
					table,
					replay.has(table) ? { stamp: 0, key: [] } : cursor,
				]),
			),
		]),
	);
	return { ...state, payloadVersion, byOrigin };
}

/**
 * When `scope`'s 403/404/412 silence expires, or `undefined` if it is not
 * silenced. Returned rather than a bare boolean so a caller can say how long is
 * left instead of only that it waited.
 */
export function silencedUntilFor(state: SessionPushChannelState, scope: string, nowMs: number): number | undefined {
	const until = state.silencedByScope[scope];
	return until !== undefined && until > nowMs ? until : undefined;
}

/** True while `scope`'s 403/404/412 silence is still in effect. */
export function isChannelSilenced(state: SessionPushChannelState, nowMs: number, scope: string): boolean {
	return silencedUntilFor(state, scope, nowMs) !== undefined;
}

/**
 * Silences one scope until `untilMs`, leaving every other scope untouched.
 *
 * Expired entries are pruned on the way through, so a machine that has talked to
 * several backends over its life does not accumulate them forever.
 */
export function withSilence(
	state: SessionPushChannelState,
	scope: string,
	untilMs: number,
	nowMs: number,
): SessionPushChannelState {
	const kept: Record<string, number> = {};
	for (const [key, until] of Object.entries(state.silencedByScope)) {
		if (key !== scope && until > nowMs) kept[key] = until;
	}
	kept[scope] = untilMs;
	return { ...state, silencedByScope: kept };
}

/**
 * The cursors recorded for one backend scope. Empty for an unseen one.
 *
 * `legacyKey` is the bare origin an earlier build stored progress under; it is
 * consulted only when the scoped key has nothing, so an upgrade keeps its place
 * in the stream instead of re-sending from the first-run window.
 */
export function cursorsFor(state: SessionPushChannelState, scope: string, legacyKey?: string): SessionPushCursors {
	const scoped = state.byOrigin[scope];
	if (scoped !== undefined) return scoped;
	if (legacyKey !== undefined && legacyKey !== scope) return state.byOrigin[legacyKey] ?? {};
	return {};
}

/** Replaces one scope's cursors, leaving every other scope untouched. */
export function withCursors(
	state: SessionPushChannelState,
	scope: string,
	cursors: SessionPushCursors,
): SessionPushChannelState {
	return { ...state, byOrigin: { ...state.byOrigin, [scope]: cursors } };
}
