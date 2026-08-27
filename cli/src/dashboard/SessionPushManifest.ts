/**
 * What leaves this machine on the session channel — the two lists, and nothing
 * else.
 *
 * The channel sends TABLES: the payload is `{table: rows}` with snake_case
 * column names. Apart from the small, explicit set in `PROJECTED_COLUMNS`, the
 * local column, JSON field and server column all carry one name, so a mismatch
 * is a bug rather than an open-ended translation table.
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
export const SYNCED_TABLES = [
	"sessions",
	"session_model_usage",
	"session_tool_use",
	"session_usage_events",
	"session_activity",
	// ⚠ The first user-authored FREE TEXT on this channel, and that is the decision
	// this line records. `query` is what the reader typed; the Memory Top Search
	// Terms card IS that text — the clustering picks each row's label out of it — so
	// withholding it withholds the feature rather than trimming it. The Settings
	// copy and `jolli configure`'s summary were changed to say so in the same
	// release that started sending it; that disclosure is the consent mechanism and
	// cannot lag a version behind.
	"memory_lookups",
	// Per-invocation metadata is what lets the Web Skills detail pane render the
	// local page's outcomes and record facts. The injected text and invocation
	// arguments remain local; see the explicit column exclusion below.
	"skill_invocations",
] as const;

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
	// Written on every recall by an OLDER dist, read by nothing on the other side.
	// The server's request schema never listed this table — it strips keys it does not
	// know, so every receipt sent was discarded on arrival. Nothing in THIS build
	// writes it any more (`recall` is observed as a `memory_lookups` row of
	// `kind = 'recall'`), and it survives only for cross-version compatibility on one
	// machine: `run-hook` picks the highest registered dist, so a 0.99.11–0.99.15 dist
	// still INSERTs here, and 0.99.10–0.99.12's Recall card still SELECTs from it —
	// unconditionally, inside the one model build, so a missing table is a 500 on the
	// WHOLE dashboard rather than one blank card. That is why the table is not dropped;
	// see `RECALL_RECEIPTS_DDL`. It stays listed here because the partition is asserted
	// in both directions: a table in the database and in neither list fails the build.
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
 * {@link PROJECTED_COLUMNS} / {@link EXCLUDED_COLUMNS} instead, so the test can
 * account for every column the schema has.
 */
export const SYNCED_COLUMNS: Readonly<Record<SyncedTable, ReadonlyArray<string>>> = {
	sessions: [
		"event_id",
		"repo_identity",
		"repo_name",
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
	session_tool_use: [
		"session_event_id",
		"tool_name",
		"kind",
		"server",
		"calls",
		"last_call_at_ms",
		"input_tokens",
		"output_tokens",
		"cached_tokens",
		"usage_confidence",
		"plugin",
		"updated_at_ms",
	],
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
	session_activity: ["session_event_id", "bucket_ms", "recorded_at_ms"],
	memory_lookups: [
		// ⚠ The primary key, and it is DERIVED from the query — `lookup:<repo>:search:
		// <surface>:<atMs>:<fingerprint>`. It carries a fixed-length hash rather than
		// the text (see `lookupQueryFingerprint`), which is what keeps it out of the
		// free-text review below: an opaque column NAME matches neither tier of the
		// net, so a key that interpolated the reader's own words would have travelled
		// unreviewed — and, being capped at 500 on the wire while `query` is capped at
		// 20 000, would have wedged this channel long before the text did.
		"receipt_id",
		"repo_identity",
		"kind",
		"surface",
		"session_id",
		"at_ms",
		"query",
		"query_key",
		"result_count",
		"hit",
		"updated_at_ms",
	],
	// Event time is the invocation's identity; the independent write stamp lets a
	// later transcript read upgrade an old outcome or injected-size measurement.
	skill_invocations: [
		"session_event_id",
		"skill_name",
		"at_ms",
		"ok",
		"ok_confidence",
		"detection",
		"entry_path",
		// Wire name deliberately avoids the Tier-1 content-name net. The projection
		// below reads the local INTEGER `body_chars`; no injected text is sent.
		"injected_chars",
		"updated_at_ms",
	],
};

/**
 * Wire columns projected from a different local column.
 *
 * `sessions.repo_id` is an autoincrement local to one machine: the same repo is
 * 3 here and 17 there, so it never leaves the machine. The join projects both
 * the stable identity used for filtering and the human display name used by
 * detail panes. Two wire columns may therefore share one local source.
 *
 * `skill_invocations.body_chars` is a numeric length, but its local name matches
 * the channel's no-exceptions content-name guard. The wire calls that value
 * `injected_chars`, which states what is counted without weakening Tier 1.
 */
export const PROJECTED_COLUMNS: Readonly<Record<SyncedTable, Readonly<Record<string, string>>>> = {
	sessions: { repo_identity: "repo_id", repo_name: "repo_id" },
	session_model_usage: {},
	session_tool_use: {},
	session_usage_events: {},
	session_activity: {},
	memory_lookups: { repo_identity: "repo_id" },
	skill_invocations: { injected_chars: "body_chars" },
};

/** Local columns held back per table, with the reason each one is held back. */
export const EXCLUDED_COLUMNS: Readonly<Record<SyncedTable, ReadonlyArray<string>>> = {
	sessions: [],
	session_model_usage: [],
	session_usage_events: [],
	// `origin_root` is a machine path and has no cloud reader. The legacy
	// `metadata_json` column is also still present on databases created before it
	// was dropped from the schema definition; no writer or reader uses it.
	session_tool_use: ["origin_root", "metadata_json"],
	session_activity: [],
	// The branch a `recall` asked for. Held back on the discriminator this list is
	// for: a bounded integer discloses nothing about content, while a free-text
	// string needs a reader on the other side to justify it — and nothing there
	// consumes this one. A branch name can also carry a customer or an unannounced
	// feature (`feat/acme-merger`). The recall ROW still goes up, so the count, the
	// recency and the hit survive; only the string is withheld, and flipping it
	// later is one line here plus one column there.
	//
	// ⚠ `result_count` and `hit` are deliberately NOT here. `hit` is not derivable
	// from `result_count` on a recall, and "did memory answer" is the most likely
	// next card.
	memory_lookups: ["target"],
	// Arguments can contain user-authored command/tool input. The Web detail pane
	// consumes only the numeric injected-body length, never the body or arguments.
	skill_invocations: ["args"],
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
	session_activity: 200,
	// ⚠ 200 and not 500, and the arithmetic is the reason rather than caution.
	// These rows are narrow but carry the channel's only variable-length free text,
	// and they carry it TWICE — `query` and `query_key` are two spellings of one
	// string, so a row's worst case is 2 × the 2 000-character producer clamp. 200 of
	// those is roughly 800 KB, well under the server's 10 MB body limit, while 500 at
	// the 20 000-character wire ceiling is 10 MB in one column alone — a 413 the
	// client cannot tell apart from a transient failure. `receipt_id` no longer
	// enters this sum: it is a fixed-length fingerprint, not a third copy.
	memory_lookups: 200,
	skill_invocations: 500,
};
