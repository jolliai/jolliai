/**
 * Which column on each activity table records "when did WE last write this row".
 *
 * An outbound sync selects changed rows with `WHERE <that column> >= cursor`,
 * so getting the column wrong is not a compile error — it is a query that runs
 * and quietly returns the wrong set. Hence a map rather than a convention.
 *
 * ⚠ The name is NOT uniform, and `sessions` is the exception that matters most.
 * That table's `updated_at_ms` is already the business clock ("when was this
 * session last active"), and `projectCommitSummary` deliberately does not bump
 * it when it enriches a `sessions-only` row into a `full` one — so a sync keyed
 * on it would never see the better token split it just wrote. `sessions` therefore
 * stamps `written_at_ms` (the same concept `memories.written_at_ms` already
 * carries) and the other three stamp `updated_at_ms`, which on them is free.
 *
 * Writing `WHERE updated_at_ms >= ?` against all four compiles, runs, and reads
 * the WRONG column on `sessions`. Go through this map instead. `SyncColumns.test.ts`
 * pins every entry against the real schema so a rename cannot pass silently.
 *
 * These columns are bookkeeping: bumped unconditionally on every write, to the
 * current wall clock — never to a timestamp carried on the event, which would
 * make them a second business clock and reintroduce the problem above.
 *
 * The map is exactly `SYNCED_TABLES`, and `SessionPushManifest.test.ts` asserts
 * that: a stamped table that is not sent is either a missing decision or a stale
 * stamp. `memory_lookups` joined the list once the backend listed the table — before
 * that, sending would have uploaded into a void, which is what its predecessor
 * `recall_receipts` did for its whole life. That one is the stale case and has no
 * entry here: it left the channel while staying in the schema for cross-version
 * compatibility (see its entry in `NEVER_SYNCED_TABLES`), and its own stamp column
 * and the two indexes behind the channel's paging stay behind with it, already
 * migrated.
 *
 * Every stamp is `NOT NULL`, so `WHERE <stamp> >= ?` is always a real
 * comparison. Do not relax that: NULL >= anything is NULL rather than false, so
 * one nullable stamp is a row no cursor can ever select — the same silent-wrong-
 * set failure this map exists to prevent, arrived at from the other side.
 *
 * The four legacy stamps are additionally `DEFAULT 0`, where 0 means "written
 * before we tracked this" and is what their backfill starts from. Neither newer
 * table relies on that sentinel: both are INSERT-only and every row is stamped with
 * its real insert time on the way in, so there is nothing to backfill. Hence
 * `session_activity` gives `recorded_at_ms` no default at all, while
 * `memory_lookups` keeps `DEFAULT 0` on `updated_at_ms` purely as the guard against
 * a nullable stamp above — never a value a row is expected to carry.
 */
export const SYNC_STAMP_COLUMNS = {
	sessions: "written_at_ms",
	session_model_usage: "updated_at_ms",
	session_tool_use: "updated_at_ms",
	session_usage_events: "updated_at_ms",
	session_activity: "recorded_at_ms",
	memory_lookups: "updated_at_ms",
} as const;

/** A table that carries a sync stamp. */
export type SyncStampTable = keyof typeof SYNC_STAMP_COLUMNS;

/** Every table carrying a sync stamp, in a stable order. */
export const SYNC_STAMP_TABLES = Object.keys(SYNC_STAMP_COLUMNS) as ReadonlyArray<SyncStampTable>;

/**
 * The stamp column for `table`.
 *
 * Prefer this over spelling a column name at a call site: the point of the map
 * is that no caller has to remember which table is the odd one out.
 */
export function syncStampColumn(table: SyncStampTable): string {
	return SYNC_STAMP_COLUMNS[table];
}

/**
 * The PRIMARY KEY columns that break a tie inside one sync stamp, in key order.
 *
 * A stamp alone cannot page a table, and the failure is a deadlock rather than a
 * slowdown. Selection is `<stamp> >= cursor ORDER BY <stamp> LIMIT n`, so when
 * MORE than `n` rows share one millisecond, every pass reads the same first `n`
 * of them, the highest stamp it sees equals the cursor it started from, the
 * cursor cannot advance, and the table stops syncing for good. Measured on a
 * real machine: `session_usage_events` sat on a millisecond holding 840 rows
 * against a limit of 500 and had not moved in five days, with 9,657 rows behind
 * it and five more such milliseconds after that (the largest 2,307 rows).
 *
 * Rows written together share a stamp by construction — `projectSession` stamps
 * every one of a session's usage events with the same `nowMs`, and a backfill
 * projects many sessions inside one millisecond — so this is the normal case at
 * scale, not a pathological one.
 *
 * So the cursor is `(stamp, ...these)` and paging is keyset: the tuple is unique,
 * therefore strictly increasing, therefore always advances. `ORDER BY` must list
 * exactly these columns in exactly this order — a mismatch does not error, it
 * silently skips rows between pages.
 *
 * ⚠ Every column here must also appear in `SYNCED_COLUMNS` for its table: the
 * next cursor is read back off the row that was just sent, so a key column the
 * wire does not carry cannot be recovered. `SyncColumns.test.ts` pins both that
 * and the match against the real PRIMARY KEY.
 */
export const KEYSET_COLUMNS: Readonly<Record<SyncStampTable, ReadonlyArray<string>>> = {
	sessions: ["event_id"],
	session_model_usage: ["session_event_id", "model"],
	session_tool_use: ["session_event_id", "tool_name", "kind"],
	session_usage_events: ["session_event_id", "dedup_key"],
	session_activity: ["session_event_id", "bucket_ms"],
	memory_lookups: ["receipt_id"],
};

/**
 * How the first-run window reaches one table — the ONE thing that is per-table
 * about it, as a two-case union rather than two half-filled maps.
 *
 * `own` is the table's own business time column. Kept beside the stamps because
 * the first sync needs BOTH and they are easy to confuse: the cursor walks the
 * stamp, while "only go back N days on the first run" filters on the business
 * clock. Filtering that window on the stamp instead would be actively wrong —
 * one backfill rewrites every old row's stamp to "just now", and the window then
 * admits sessions from years ago.
 *
 * `parent` is the column pointing at the owning `sessions` row, for a table with
 * no clock of its own. A table without a clock is NOT a table without a date:
 * `session_model_usage` has no instant, but the session it hangs off does, and
 * that session is what the window is really about. Without it the window applied
 * to nothing there and the first run walked the WHOLE table — not merely "more
 * data than asked for", since the extra rows are children of the very sessions
 * the same window withheld, leaving the server usage it could only file under a
 * session it was never sent.
 *
 * ⚠ A UNION, deliberately, and the shape is the invariant: every table has
 * EXACTLY ONE answer. Two `Record<…, string | undefined>` maps could express
 * "neither" — a table with no window at all, which is the bug above — and they
 * did, so the reader carried a dead `undefined` branch no test could ever reach
 * and no type could rule out. Here the compiler rules it out instead, and both
 * arms of the one remaining branch are real cases.
 */
export type WindowSource = { readonly own: string } | { readonly parent: string };

export const WINDOW_SOURCES: Readonly<Record<SyncStampTable, WindowSource>> = {
	sessions: { own: "updated_at_ms" },
	// Its own clock, and NOT routed through the parent even though it has one: a
	// session touched today can hold a response from last month.
	session_model_usage: { parent: "session_event_id" },
	session_tool_use: { own: "last_call_at_ms" },
	session_usage_events: { own: "responded_at_ms" },
	// Through the parent session, NOT on `bucket_ms`, even though `bucket_ms` is a
	// genuine epoch-ms business time. The window applies only on a first run and its
	// job is to stay aligned with the cursor, and here the two are decoupled: the
	// cursor is `recorded_at_ms`, which a backfill stamps at "just now" for a bucket
	// whose `bucket_ms` is months old (this table is INSERT-only over old
	// transcripts). Windowing on `bucket_ms` would decline those old buckets on the
	// first run while the cursor still advanced past their fresh `recorded_at_ms` —
	// stranding them below every future cursor with nothing to send them, the exact
	// silent loss `session_model_usage` routes through the parent to avoid. Safe
	// because `bucket_ms <= sessions.updated_at_ms`, so a bucket is admitted only
	// when its session is.
	session_activity: { parent: "session_event_id" },
	// ⚠ `own`, and `{parent}` here is not merely worse — it is BROKEN. The parent
	// predicate joins `sessions.event_id`, while this table's `session_id` holds a
	// `sessions.session_id` (a different column) and is NULL for every `jolli
	// search` typed into a plain terminal. An `EXISTS` over it would silently drop
	// every one of those rows from the first sync's window, for ever.
	memory_lookups: { own: "at_ms" },
};

/** The table's own business time column, or `undefined` when it has none. */
export function businessTimeColumn(table: SyncStampTable): string | undefined {
	const source = WINDOW_SOURCES[table];
	return "own" in source ? source.own : undefined;
}
