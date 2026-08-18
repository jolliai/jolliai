/**
 * What leaves this machine on the session channel — the two lists, and nothing
 * else.
 *
 * The channel sends TABLES: the payload is `{table: rows}` with the local column
 * names verbatim (snake_case, no camelCase rewrite), so the local column, the
 * JSON field and the server column all carry one name and a mismatch is a bug
 * rather than a translation table to maintain.
 *
 * ⚠ That format removes the step that used to decide what is sent. Picking
 * fields by hand is tedious, but it also quietly withheld everything nobody had
 * thought about; sending tables as they are inverts the default to "everything
 * new goes up". This repo has already paid for that inversion once —
 * `summaryJson` is a whitelist by omission, and every field added to it started
 * uploading itself. So the lists below are explicit, and
 * `SessionPushManifest.test.ts` compares them against the real schema: adding a
 * table or a column makes it FAIL, which is the whole mechanism. Do not fix such
 * a failure by widening the list without deciding.
 *
 * # No timezone travels on this channel, and that is a decision
 *
 * Every time value below is an epoch-millisecond INSTANT (`*_at_ms`), the envelope
 * carries none, and no header carries one. The single timezone-bearing table is
 * excluded on purpose — see `stats_daily` in {@link NEVER_SYNCED_TABLES}.
 *
 * ⚠ Do NOT "fix" this by adding a `timeZone` field. It was considered and
 * rejected: the field would record the zone of whichever MACHINE wrote the row,
 * and a person who travels, or who works from two machines, would have one
 * account's history split across zones with nothing able to reconcile it. An
 * instant has no zone; only a QUESTION about days does.
 *
 * Which day a response belongs to is therefore the READER's to decide, and the
 * web API is where that lands: it must take the viewer's IANA zone as a request
 * parameter and bucket on it. `DashboardModel.timeZone` is the shape to mirror on
 * the way back — the response states which zone it bucketed in, so a client can
 * never mistake one zone's chart for another's.
 *
 * The size of getting this wrong is measurable rather than theoretical. Bucketing
 * in UTC for a UTC+8 user moves everything worked between local 00:00 and 08:00
 * onto the previous day: on the author's own database that is 271 of 6,868
 * responses and 1,014,210 of 31,171,692 tokens (3.3%), so the web chart and the
 * local one disagree slightly every single day — the shape a user reports as a
 * bug. It also shifts the window itself: one `nowMs` resolved to
 * `2026-07-20..2026-08-18` in UTC and `2026-07-21..2026-08-19` in Asia/Shanghai,
 * a whole day in and a whole day out.
 *
 * Note the local page needs no such parameter and is not a precedent: its server
 * and its browser are the same machine, so `buildDashboardModel` falls back to
 * `machineTimeZone()` and `ModelRequest` deliberately omits the field.
 */

/** Tables the session channel sends. Adding one here is a privacy decision. */
export const SYNCED_TABLES = ["sessions", "session_model_usage", "session_tool_use", "session_usage_events"] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

/**
 * Tables that must NEVER be sent, each for its own reason. The test requires
 * every table in the database to appear in exactly one of the two lists, so this
 * is not documentation — it is the other half of the partition.
 *
 * The first three are the ones that would be actively harmful:
 *   - `transcripts` / `memory_transcripts` — the conversation text itself.
 *   - `worktree_status` — the content of uncommitted changes.
 * The rest are local bookkeeping with no meaning on another machine (integer
 * ids, cursors, queue state), the memory half of the store, which travels on its
 * own channel with its own binding rules, or a table nothing on the other side
 * reads — sending those costs bytes and buys nothing.
 */
export const NEVER_SYNCED_TABLES = [
	// The conversation text itself, on both halves of the store.
	"transcripts",
	"transcript_sessions",
	"memory_transcripts",
	// The content of uncommitted changes.
	"worktree_status",
	// Local bookkeeping: integer ids, ingest cursors, queue and repo state.
	"events_raw",
	"ingest_cursors",
	"repo_state",
	"repos",
	"schema_meta",
	"schema_migrations",
	"sqlite_sequence",
	// Written on every recall, read by nothing on the other side. The standalone
	// Recall card is gone from both pages, and the server's request schema never
	// listed this table — it strips keys it does not know, so every receipt sent
	// was discarded on arrival. Nothing about the DATA changed (the receipts are
	// still written locally, and the tool-usage card still counts recall calls off
	// `session_tool_use`), so putting the table back on the wire is this line plus
	// its `SYNCED_COLUMNS`, `SYNC_STAMP_COLUMNS`, `KEYSET_COLUMNS` and
	// `BUSINESS_TIME_COLUMNS` entries. Its stamp column and the two indexes behind
	// the channel's paging stay in the schema: they have already been migrated, so
	// they are frozen rather than worth an entry to remove.
	"recall_receipts",
	// Derived locally and re-derivable there: a cache cut in THIS machine's
	// timezone. Sending it would bake that zone into the server's numbers and
	// leave the server unable to re-aggregate along any other axis. The other half
	// of the no-timezone rule in this module's header: instants go up, days are
	// cut by whoever is asking.
	"stats_daily",
	// The memory half. It travels on the commit-push channel, which has its own
	// binding rules, and `commit_aliases` answers a rebase-matching question that
	// does not exist on a server where commits and memories arrive together.
	"memories",
	"memory_topics",
	"commits",
	"commit_files",
	"commit_aliases",
	"commit_branches",
	"branches",
	"context",
	"context_kinds",
	// Not needed by the first web pages.
	"plan_progress",
	"topic_pages",
	"topic_source_refs",
	"topic_processed_sources",
] as const;

/**
 * The columns sent for each table, in wire order.
 *
 * Two kinds of local column are deliberately absent and are listed in
 * {@link REWRITTEN_COLUMNS} / {@link EXCLUDED_COLUMNS} instead, so the test can
 * account for every column the schema has.
 */
export const SYNCED_COLUMNS: Readonly<Record<SyncedTable, ReadonlyArray<string>>> = {
	sessions: [
		"event_id",
		"repo_identity",
		"source",
		"session_id",
		"title",
		"started_at_ms",
		"updated_at_ms",
		"message_count",
		"duration_ms",
		"model",
		"input_tokens",
		"output_tokens",
		"cached_tokens",
		"est_cost_usd",
		"token_coverage",
		"prices_as_of",
		"written_at_ms",
	],
	session_model_usage: [
		"session_event_id",
		"model",
		"input_tokens",
		"output_tokens",
		"cached_tokens",
		"est_cost_usd",
		"updated_at_ms",
	],
	session_tool_use: ["session_event_id", "tool_name", "kind", "server", "calls", "last_call_at_ms", "updated_at_ms"],
	// Added after the three tables above were listed, and it is the one that makes
	// a per-DAY number correct: a session row carries its cumulative total under
	// a single timestamp, so a conversation spanning three days puts all of its
	// spend on the last one. Syncing sessions alone would reproduce on the web
	// exactly the bug this table was created to fix locally.
	session_usage_events: [
		"session_event_id",
		"dedup_key",
		"responded_at_ms",
		"model",
		"input_tokens",
		"output_tokens",
		"cached_tokens",
		"est_cost_usd",
		"updated_at_ms",
	],
};

/**
 * Integer surrogate keys, replaced by the natural key they stand for. This is
 * the ONLY rewrite the format allows.
 *
 * `repos.id` is an autoincrement local to one machine: the same repo is 3 here
 * and 17 there, so sending the integer would attach rows to whichever repo
 * happened to take that id on the server. `session_event_id` needs no rewrite —
 * an `event_id` already embeds repo, source and session id.
 */
export const REWRITTEN_COLUMNS: Readonly<Record<string, string>> = {
	repo_id: "repo_identity",
};

/** Local columns held back per table, with the reason each one is held back. */
export const EXCLUDED_COLUMNS: Readonly<Record<SyncedTable, ReadonlyArray<string>>> = {
	sessions: [],
	session_model_usage: [],
	session_usage_events: [],
	// Dropped from the schema definition long ago (recall_receipts replaced it),
	// but still present on databases created before that. No writer, no reader.
	session_tool_use: ["metadata_json"],
};

/**
 * Rows per request, per table.
 *
 * Usage events are one narrow row per model response, so they get a larger batch.
 * ⚠ Keep the resulting body well under whatever the gateway in front of the server
 * allows: a body-size refusal arrives as a 413 that is indistinguishable from a
 * transient failure, which is how the previous batch endpoint burned its whole
 * retry budget and then expired silently.
 */
export const BATCH_LIMITS: Readonly<Record<SyncedTable, number>> = {
	sessions: 200,
	session_model_usage: 200,
	session_tool_use: 200,
	session_usage_events: 500,
};
