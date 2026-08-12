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
 * All four are `NOT NULL DEFAULT 0`, so `WHERE <stamp> >= ?` is always a real
 * comparison. Do not relax that: NULL >= anything is NULL rather than false, so
 * one nullable stamp is a row no cursor can ever select — the same silent-wrong-
 * set failure this map exists to prevent, arrived at from the other side. 0
 * means "written before we tracked this" and is what the backfill starts from.
 */
export const SYNC_STAMP_COLUMNS = {
	sessions: "written_at_ms",
	session_model_usage: "updated_at_ms",
	session_tool_use: "updated_at_ms",
	recall_receipts: "updated_at_ms",
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
 * The business time column each table buckets by, or `undefined` when it has
 * none of its own.
 *
 * Kept beside the stamps because the first sync needs BOTH and they are easy to
 * confuse: the cursor walks the stamp, while "only go back N days on the first
 * run" filters on the business clock. Filtering that window on the stamp instead
 * would be actively wrong — one backfill rewrites every old row's stamp to
 * "just now", and the window then admits sessions from years ago.
 */
export const BUSINESS_TIME_COLUMNS: Readonly<Record<SyncStampTable, string | undefined>> = {
	sessions: "updated_at_ms",
	session_model_usage: undefined,
	session_tool_use: "last_call_at_ms",
	recall_receipts: "at_ms",
};
