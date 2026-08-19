/**
 * MemoriesQuery — the repo > branch > memory browser's list and detail
 * queries.
 *
 * Folds in what used to be the standalone Decisions page: each memory's
 * topics carry their own Decisions callout (`splitDecisionBullets` in
 * `DashboardQuery.ts`), so there is no separate corpus-level aggregate here.
 *
 * Several mockup fields have no counterpart in this schema and are
 * deliberately omitted rather than invented:
 *   - conversation `kind` (cli_workspace/agent_hub/doc_draft) — not recorded.
 *   - an "Immutable" flag — false in this system: regeneration is an UPDATE
 *     of `summary_json` (see `SotSchema.ts`'s header), there is no revision
 *     history to point a lock icon at.
 *   - minted `JM-###` ids — the handle is the commit's own short hash, which
 *     is already stable and content-bound, so a citable handle is
 *     content-stable by construction rather than by adding an id scheme.
 *   - per-file A/M/D status — `commit_files` stores insertions/deletions
 *     only, no git status letter (a `--name-status` pass would need to ride
 *     along with `DashboardCollector`'s existing `--numstat` pass, not a new
 *     one — numstat is already a second git invocation because it multiplies
 *     output by file count).
 *   - tool-call ARGUMENTS — `session_tool_use` stores call counts only, so
 *     activity rows read "Read ×22", never "Read 22 files under api/src".
 */

import { inflateSync } from "node:zlib";

import { groupArchivedSessions } from "../core/ArchivedConversations.js";
import { formatMemoryRefId, formatMemoryRefIdWithHashFallback } from "../core/MemoryRefId.js";
import {
	labelLeadsWithNativeId,
	referenceDisplayTitle,
	referenceSourceLabel,
} from "../core/references/ReferenceDisplay.js";
import { sanitizeNativeIdForPath } from "../core/references/ReferenceStore.js";
import { firstUserMessageTitleFromEntries } from "../core/SessionTitleResolver.js";
import { buildSkillsAggregateMarkdown, buildSkillsSummaryLabel } from "../core/SkillsAggregateMarkdown.js";
import { assembleMemoryTree } from "../core/SqliteStorage.js";
import { formatProviderLabel } from "../core/SummaryFormat.js";
import {
	aggregateConversationTokenBreakdown,
	aggregateConversationTokens,
	collectDisplayTopics,
	getTranscriptIds,
} from "../core/SummaryTree.js";
import { estimateSummaryCostUsd } from "../core/TokenCost.js";
import { TOOL_RECORDING_SOURCES } from "../core/TranscriptParser.js";
import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary, StoredTranscript } from "../Types.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import {
	type ContextDoc,
	type ConversationDoc,
	type DashboardScope,
	MEMORIES_PAGE_SIZE,
	type MemoriesModel,
	type MemoryActivityRow,
	type MemoryContextKind,
	type MemoryContextRow,
	type MemoryConversationRow,
	type MemoryDetail,
	type MemoryExcludedRow,
	type MemoryFileRow,
	type MemoryListItem,
	type MemoryTopic,
} from "./DashboardModel.js";
import {
	commitCategoryLabels,
	mcpFoldedIdentifierSql,
	resolveScope,
	scopeFilter,
	scopeToRepoIds,
	splitDecisionBullets,
} from "./DashboardScopeUtil.js";

const log = createLogger("MemoriesQuery");

interface MemoryListRow {
	readonly commit_hash: string;
	readonly branch: string | null;
	readonly commit_message: string | null;
	/** The COALESCEd committer date — see {@link reachableMemoryRows}, not `memories.commit_date_ms`. */
	readonly committed_at_ms: number;
	readonly ticket_id: string | null;
	readonly jolli_doc_id: number | null;
	readonly repo_identity: string;
	readonly repo_name: string;
}

/**
 * Per repo (keyed by `repo_identity`), the commit hashes still reachable from
 * a local branch tip — or `null` when reachability could not be determined
 * (a git failure), which means "don't filter this repo's rows". A repo
 * missing from the map is treated the same as `null`: fail open rather than
 * hide real memories because the caller never computed a set for it.
 *
 * Needed because a rebase/reset that rewrites history away leaves the old
 * commits' rows sitting in `memories` forever — nothing else in this schema
 * notices they stopped existing on any branch. `commit_branches` cannot answer
 * this instead: an event that omits `branches` leaves the previous set in
 * place, so an empty set means "observed unreachable" only for the producers
 * that always send one.
 */
export type ReachableCommits = ReadonlyMap<string, ReadonlySet<string> | null>;

/** Shared with the stats/standup builders, which filter the same dead rows. */
export function isReachable(reachable: ReachableCommits | undefined, repoIdentity: string, hash: string): boolean {
	const set = reachable?.get(repoIdentity);
	return set == null || set.has(hash);
}

/**
 * The reachable root memories for a scope, newest first — the whole set, before
 * any page is cut from it.
 *
 * No SQL LIMIT and no SQL OFFSET, both for the same reason: reachability can
 * only be checked in JS (git, not the DB), so a row the filter drops would make
 * a database-level window skip a different memory on every page. The set is
 * small (one row per root memory), and the cost this page cares about is bytes
 * on the wire, not rows read.
 *
 * `commit_hash` is the second sort key, and it is load-bearing rather than
 * cosmetic: two memories can share a timestamp to the millisecond (a squash, a
 * scripted series of commits), and the page cursor is a position in THIS order.
 * Ordering by the date alone leaves those rows in whatever order SQLite happens
 * to produce, so the same cursor could land on either side of the pair between
 * two requests — dropping one memory or repeating it.
 *
 * The date is the COMMITTER date, falling back to the memory's own
 * `commit_date_ms` only when no `commits` row exists yet — the same COALESCE
 * `buildMemoryCards` uses, and for the same reason: `commit_date_ms` comes from
 * `CommitSummary.commitDate`, which `GitOps.getHeadCommitInfo` reads with `%aI`
 * (AUTHOR date), while `commits.committed_at_ms` is collected with `%cI`. Two
 * clocks means a rebased or cherry-picked memory sorts — and renders its
 * timestamp — differently in the tree than in the Stats feed listing the very
 * same memory.
 */
function reachableMemoryRows(
	db: DashboardDbHandle,
	resolved: ReturnType<typeof scopeToRepoIds>,
	reachable?: ReachableCommits,
): ReadonlyArray<MemoryListRow> {
	const listFilter = scopeFilter(resolved, "m.repo_id");
	const allRows = db
		.prepare(
			`SELECT m.commit_hash, m.branch, m.commit_message, m.ticket_id, m.jolli_doc_id,
			        COALESCE(cm.committed_at_ms, m.commit_date_ms) AS committed_at_ms,
			        r.repo_identity, r.repo_name
			   FROM memories m
			   JOIN repos r ON r.id = m.repo_id
			   LEFT JOIN commits cm ON cm.repo_id = m.repo_id AND cm.hash = m.commit_hash
			  WHERE m.parent_hash IS NULL
				${listFilter.sql}
			  ORDER BY COALESCE(cm.committed_at_ms, m.commit_date_ms) DESC, m.commit_hash DESC`,
		)
		.all(...listFilter.params) as ReadonlyArray<MemoryListRow>;
	return allRows.filter((row) => isReachable(reachable, row.repo_identity, row.commit_hash));
}

/**
 * One page of tree rows — what `/api/memories` answers, and what the inlined
 * model's first page is cut with.
 *
 * Paged rather than capped: the tree's search box filters this array in the
 * browser, so a hard cap would quietly turn "search my memories" into "search
 * my recent memories". But the model is inlined into a `<script>` block on
 * every render, so the whole set cannot ride there either — an all-repos scope
 * is the sum of every enabled repo's entire history. The HTML carries the first
 * {@link MEMORIES_PAGE_SIZE} rows and the tree's "Load more" button pulls each
 * further page from this same function over HTTP.
 *
 * `totalCount` is the reachable total, so `items.length < totalCount` is the
 * client's "there is another page" test — no separate truncation flag to keep
 * in step with it.
 *
 * **Keyed on the last row the client holds, never on an offset.** The set this
 * pages over is filtered by git reachability at request time, so it SHRINKS
 * under a rebase mid-browse: with an offset, every row after the vanished one
 * moves up a slot, and the one that lands on the boundary falls inside the
 * already-loaded range and is never shown again. A gap is the failure mode that
 * matters here, because the client can dedupe a repeat but cannot notice
 * something it was never sent. A cursor has no such window — it says "continue
 * after this exact memory" and stays correct however the rows around it move.
 */
export function buildMemoriesPage(
	db: DashboardDbHandle,
	scope: DashboardScope,
	cursor: MemoriesPageCursor | undefined,
	reachable?: ReachableCommits,
): {
	readonly items: ReadonlyArray<MemoryListItem>;
	readonly totalCount: number;
	readonly cursorMissing?: true;
} {
	// Resolve repo NAME tokens to identities FIRST. The `/api/memories` paging route
	// hands us the raw `?repo=` scope: `buildDashboardModel` resolves it for the page
	// HTML, but this route did not, so a name-keyed scope (the picker's common token —
	// see `JD.repoToken`) matched no identity, collapsed to the `[-1]` sentinel, and
	// answered totalCount 0 + cursorMissing — which the client renders as a wiped tree.
	// Idempotent for the already-resolved scope `buildMemoriesList` receives.
	const resolvedScope = resolveScope(db, scope);
	const resolved = scopeToRepoIds(db, resolvedScope);
	const rows = reachableMemoryRows(db, resolved, reachable);
	const at = cursor
		? rows.findIndex((row) => row.repo_identity === cursor.repoIdentity && row.commit_hash === cursor.commitHash)
		: -1;
	// A cursor whose memory is gone (rebased away while the reader browsed) gets
	// the FIRST page plus a flag — not an empty page, and not a silent restart.
	// Empty would strand the tree at what it had loaded; a silent restart would
	// return rows the client already holds, which its dedupe drops, leaving a
	// "Load more" button that visibly does nothing however often it is clicked.
	// The flag is what lets the client re-seat itself on a list it can page.
	const cursorMissing = cursor !== undefined && at < 0;
	const start = cursorMissing ? 0 : at + 1;
	return {
		items: toListItems(db, resolvedScope, rows.slice(start, start + MEMORIES_PAGE_SIZE)),
		totalCount: rows.length,
		...(cursorMissing ? { cursorMissing: true as const } : {}),
	};
}

/** Position in the list: the last row the client already holds. */
export interface MemoriesPageCursor {
	readonly repoIdentity: string;
	readonly commitHash: string;
}

/** The tree's first page and the sidebar's vitals — no per-memory detail. */
export function buildMemoriesList(
	db: DashboardDbHandle,
	scope: DashboardScope,
	reachable?: ReachableCommits,
): Omit<MemoriesModel, "selected"> {
	const resolved = scopeToRepoIds(db, scope);
	const rows = reachableMemoryRows(db, resolved, reachable);
	const items = toListItems(db, scope, rows.slice(0, MEMORIES_PAGE_SIZE));

	const plainFilter = scopeFilter(resolved);
	const memoriesTotal = rows.length;
	const topicsTotal =
		(
			db
				.prepare(`SELECT COUNT(*) AS n FROM memory_topics WHERE 1=1${plainFilter.sql}`)
				.get(...plainFilter.params) as { n: number } | undefined
		)?.n ?? 0;
	const reposTotal =
		(
			db
				.prepare(`SELECT COUNT(DISTINCT repo_id) AS n FROM memories WHERE 1=1${plainFilter.sql}`)
				.get(...plainFilter.params) as { n: number } | undefined
		)?.n ?? 0;

	return {
		items,
		totalCount: memoriesTotal,
		vitals: { memories: memoriesTotal, topics: topicsTotal, repos: reposTotal },
	};
}

/** Row → tree item. Shared by the inlined first page and every `/api/memories` page. */
function toListItems(
	db: DashboardDbHandle,
	scope: DashboardScope,
	rows: ReadonlyArray<MemoryListRow>,
): ReadonlyArray<MemoryListItem> {
	const categoryLabels = commitCategoryLabels(db, scope);
	return rows.map((row) => {
		const category = categoryLabels.get(`${row.repo_identity}\0${row.commit_hash}`);
		const memoryRefId = formatMemoryRefId(row.jolli_doc_id == null ? undefined : Number(row.jolli_doc_id));
		return {
			repoIdentity: row.repo_identity,
			repoName: row.repo_name,
			commitHash: row.commit_hash,
			shortHash: row.commit_hash.slice(0, 7),
			...(memoryRefId ? { memoryRefId } : {}),
			title: row.commit_message ?? "",
			...(row.branch ? { branch: row.branch } : {}),
			committedAtMs: row.committed_at_ms,
			...(row.ticket_id ? { ticketId: row.ticket_id } : {}),
			...(category ? { category } : {}),
			synced: row.jolli_doc_id != null,
		};
	});
}

interface MemoryDetailRow {
	readonly commit_hash: string;
	readonly branch: string | null;
	readonly commit_message: string | null;
	readonly commit_author: string | null;
	/** The COALESCEd committer date — see {@link buildMemoryDetail}, not the raw `memories.commit_date_ms`. */
	readonly commit_date_ms: number;
	readonly ticket_id: string | null;
	readonly summary_json: string;
	readonly files_changed: number | null;
	readonly insertions: number | null;
	readonly deletions: number | null;
	readonly jolli_doc_id: number | null;
	readonly repo_id: number;
	readonly repo_identity: string;
	readonly repo_name: string;
}

interface ToolSessionCoverageRow {
	readonly source: string;
	readonly total: number;
	readonly with_tools: number;
}

/**
 * Every session linked to one memory's transcripts, honesty-checked against
 * {@link TOOL_RECORDING_SOURCES} — same shape as `DashboardQuery.ts`'s
 * `buildToolUsage`, scoped to one commit instead of a whole window.
 */
function linkedSessionCoverage(
	db: DashboardDbHandle,
	repoId: number,
	hash: string,
): ReadonlyArray<ToolSessionCoverageRow> {
	// DISTINCT for the same reason as `buildActivity`'s subquery: one session
	// listed in several of this memory's transcript files joins to one row per
	// FILE, so a plain COUNT(*) counts an amend chain's sessions once per
	// commit. `with_tools` happens to survive the fan-out (it only ever gets
	// compared against 0), but `total` does not, and the two must not be read
	// from a row set that is only half trustworthy.
	return db
		.prepare(
			`SELECT s.source,
			        COUNT(DISTINCT s.event_id) AS total,
			        COUNT(DISTINCT CASE
			          WHEN EXISTS (SELECT 1 FROM session_tool_use t WHERE t.session_event_id = s.event_id)
			          THEN s.event_id END) AS with_tools
			   FROM memory_transcripts mt
			   JOIN transcript_sessions ts
			     ON ts.repo_id = mt.repo_id AND ts.transcript_id = mt.transcript_id AND ts.source IS NOT NULL
			   JOIN sessions s ON s.repo_id = ts.repo_id AND s.source = ts.source AND s.session_id = ts.session_id
			  WHERE mt.repo_id = ? AND mt.commit_hash = ?
			  GROUP BY s.source`,
		)
		.all(repoId, hash) as ReadonlyArray<ToolSessionCoverageRow>;
}

/**
 * The memory's conversations, reassembled from the ARCHIVED transcripts the
 * same way the VS Code summary panel does — {@link groupArchivedSessions}.
 *
 * Deliberately not the `transcript_sessions ⋈ sessions` join this used to be.
 * That join answered a different question and got two things wrong that were
 * visible side by side with the editor:
 *
 *   - One conversation appeared once PER transcript file. An amend chain files
 *     a slice per commit, all three pointing at the same session, and with no
 *     DISTINCT the same row rendered three times (measured on JOLLI-2131).
 *   - `sessions.message_count` is the whole LIVE session's message count, which
 *     keeps growing after the commit. The count a memory should show is the
 *     number of turns archived INTO it.
 *
 * Titles come from the ARCHIVE first (`StoredSession.title`, resolved by
 * `resolveArchivedTitle` when the memory was written), then from the live
 * `sessions` row, then from the archived first user message. That order is the
 * point: the archived string is the full ladder's answer as of this commit,
 * taken while the transcript was still readable, and it is the only one of the
 * three that survives session pruning or arriving on another machine.
 *
 * This whole function is synchronous, and that is now a property rather than a
 * limitation. It used to hand each row a `transcriptPath` so a later async pass
 * could re-read the live file for Claude's `ai-title` — which put an absolute
 * path under the user's home into a payload nothing rendered, and (measured)
 * could only fire where it was least likely to succeed: a row with a stored
 * title skipped the read, and a row without one had no readable file to read.
 *
 * **The row ORDER comes from `summary.transcripts`, not from the link table.**
 * `groupArchivedSessions` emits conversations in first-seen order over the
 * transcripts it is handed, so the order this function feeds it IS the displayed
 * order — and `memory_transcripts` cannot supply it. That table is a SET (its PK
 * stores no array index, by the comment on it in `SotSchema.ts`), and the query
 * below is served by the PK's covering index, so rows arrive sorted by
 * `transcript_id` — a UUID, i.e. arbitrary (measured: `aaa`, `mmm`, `zzz` for
 * insertions in the reverse order). The editor reads the summary's own
 * `transcripts` array via `getTranscriptIds`, so the same memory listed its
 * conversations in a different order on the two surfaces. Ordering by the array
 * here is what makes them agree; a linked id the array does not name keeps its
 * query position after the named ones rather than being dropped, since a row the
 * link table has is still a real conversation.
 */
/**
 * A memory's stored transcripts, inflated and ordered the way the summary names
 * them — the input `groupArchivedSessions` takes.
 *
 * Extracted because two readers need the identical list and the ordering is not
 * incidental: it decides which slice's `StoredSession` wins first-seen, and so
 * which title a session carries. A viewer that re-read the blobs in query order
 * could title a conversation differently from the row that opened it.
 */
function readMemoryTranscripts(
	db: DashboardDbHandle,
	repoId: number,
	hash: string,
	summary: CommitSummary,
): Array<readonly [string, StoredTranscript]> {
	const blobs = db
		.prepare(
			`SELECT mt.transcript_id, t.sessions_blob
			   FROM memory_transcripts mt
			   JOIN transcripts t ON t.repo_id = mt.repo_id AND t.transcript_id = mt.transcript_id
			  WHERE mt.repo_id = ? AND mt.commit_hash = ?`,
		)
		.all(repoId, hash) as ReadonlyArray<{ transcript_id: string; sessions_blob: Uint8Array }>;

	// First occurrence wins: `transcripts[]` carries no uniqueness guarantee (a
	// squash that concatenated two arrays repeats the shared ids), and the editor
	// reaches such an id at its first position too.
	const rank = new Map<string, number>();
	for (const [i, id] of getTranscriptIds(summary).entries()) {
		if (!rank.has(id)) rank.set(id, i);
	}
	// Unnamed ids all score `rank.size`, so the sort's stability keeps them in
	// query order behind the named ones instead of shuffling them.
	const unnamed = rank.size;
	const ordered = [...blobs].sort(
		(a, b) => (rank.get(a.transcript_id) ?? unnamed) - (rank.get(b.transcript_id) ?? unnamed),
	);

	const transcripts: Array<readonly [string, StoredTranscript]> = [];
	for (const b of ordered) {
		try {
			transcripts.push([b.transcript_id, JSON.parse(inflateSync(Buffer.from(b.sessions_blob)).toString("utf8"))]);
		} catch (err) {
			// One unreadable blob must not blank the whole panel; the others are
			// still real conversations. Counted nowhere because this is a read
			// path — the import already reports what it skipped.
			log.warn("transcript %s unreadable for the memories view: %s", b.transcript_id, errMsg(err));
		}
	}
	return transcripts;
}

/**
 * The live `sessions.title` for every session one memory's transcripts name,
 * keyed by `archivedSessionKey`'s `${source}:${sessionId}`.
 *
 * Shared by {@link buildConversations} and {@link readConversationEntries} —
 * the row and the dialog it opens must agree on a title, and the middle rung of
 * that three-step fallback is the one only this query can supply. Keeping it in
 * one place is what stops the two drifting: a row titled from `sessions` while
 * the dialog re-derived a first-user-message title read as two conversations.
 */
function readNativeSessionTitles(db: DashboardDbHandle, repoId: number, hash: string): ReadonlyMap<string, string> {
	return new Map(
		(
			db
				.prepare(
					`SELECT s.source, s.session_id, s.title
					   FROM transcript_sessions ts
					   JOIN sessions s ON s.repo_id = ts.repo_id AND s.source = ts.source AND s.session_id = ts.session_id
					  WHERE ts.repo_id = ? AND ts.transcript_id IN (SELECT transcript_id FROM memory_transcripts WHERE repo_id = ? AND commit_hash = ?)`,
				)
				.all(repoId, repoId, hash) as ReadonlyArray<{
				source: string;
				session_id: string;
				title: string | null;
			}>
		)
			.filter((r) => (r.title ?? "").trim().length > 0)
			.map((r) => [`${r.source}:${r.session_id}`, r.title as string]),
	);
}

function buildConversations(
	db: DashboardDbHandle,
	repoId: number,
	hash: string,
	summary: CommitSummary,
): ReadonlyArray<MemoryConversationRow> {
	const transcripts = readMemoryTranscripts(db, repoId, hash, summary);

	const nativeTitles = readNativeSessionTitles(db, repoId, hash);

	const { order, grouped } = groupArchivedSessions(transcripts);
	return order.map((key) => {
		const g = grouped.get(key) as NonNullable<ReturnType<typeof grouped.get>>;
		const source = g.session.source ?? "claude";
		return {
			source,
			// Archive first: see the note above for why it outranks a live row that
			// may not exist. `?? ` and not `||` would be wrong the other way round —
			// an archived empty string is not a title, and the writer stores the
			// field only when it resolved one, so absence is the only empty case.
			title: g.session.title ?? nativeTitles.get(key) ?? firstUserMessageTitleFromEntries(g.entries),
			messageCount: g.entries.length,
			sessionId: g.session.sessionId,
		};
	});
}

/**
 * The two identifier columns this page's activity rows are grouped by, with a
 * plugin registration alias folded away — the same merge the MCPs card makes,
 * so one server reached two ways is one row on both surfaces.
 *
 * The GUARDED form, unlike `DashboardQuery.ts`'s `TOOL_KEY_SQL` /
 * `SERVER_KEY_SQL`: those sit behind a `t.kind = 'mcp'` WHERE clause, while this
 * query deliberately returns every kind in one pass (its rows carry `kind` for
 * the client to badge). Folding unconditionally would rename a skill or a
 * builtin that happens to start `plugin_`.
 *
 * Worth having even though the client does not render `detail.activity` today:
 * the field still travels in every selected-memory payload, so without the fold
 * the same MCP server sits in it twice — `jollimemory` and
 * `plugin_jolli_jollimemory` — waiting for whoever renders it next.
 */
const ACTIVITY_TOOL_KEY_SQL = mcpFoldedIdentifierSql("stu.tool_name", "stu.kind");
const ACTIVITY_SERVER_KEY_SQL = mcpFoldedIdentifierSql("stu.server", "stu.kind");

function buildActivity(
	db: DashboardDbHandle,
	repoId: number,
	hash: string,
): { activity: ReadonlyArray<MemoryActivityRow>; uncoveredSources: ReadonlyArray<string> } {
	// The session set is resolved to DISTINCT event ids BEFORE the tool table is
	// joined. `sessions` is keyed by (repo, source, session_id) — nothing about
	// a transcript — while `memory_transcripts` links one memory to N transcript
	// files and `transcript_sessions` lists that session inside each of them. So
	// the three-way join yields one row per (transcript_id, session_id) pair,
	// all pointing at the SAME event id, and `SUM(stu.calls)` multiplies every
	// tool count by the number of transcript files. That is not an edge case: an
	// amend chain files a slice per commit and the root memory owns all of them
	// (the reason `groupArchivedSessions` exists), so two amends turned a real
	// `Read ×22` into `Read ×66`. `buildConversations` above was rewritten off
	// the same fan-out; this is the same table relation, one query later.
	const rows = db
		.prepare(
			`SELECT ${ACTIVITY_TOOL_KEY_SQL} AS tool_name, stu.kind, ${ACTIVITY_SERVER_KEY_SQL} AS server,
			        SUM(stu.calls) AS calls
			   FROM (SELECT DISTINCT s.event_id
			           FROM memory_transcripts mt
			           JOIN transcript_sessions ts
			             ON ts.repo_id = mt.repo_id AND ts.transcript_id = mt.transcript_id
			            AND ts.source IS NOT NULL
			           JOIN sessions s
			             ON s.repo_id = ts.repo_id AND s.source = ts.source AND s.session_id = ts.session_id
			          WHERE mt.repo_id = ? AND mt.commit_hash = ?) se
			   JOIN session_tool_use stu ON stu.session_event_id = se.event_id
			  GROUP BY stu.kind, ${ACTIVITY_TOOL_KEY_SQL}, ${ACTIVITY_SERVER_KEY_SQL}`,
		)
		.all(repoId, hash) as ReadonlyArray<{ tool_name: string; kind: string; server: string | null; calls: number }>;
	const activity: MemoryActivityRow[] = rows.map((r) => ({
		label: r.kind === "mcp" && r.server ? r.server : r.tool_name,
		kind: r.kind as MemoryActivityRow["kind"],
		calls: r.calls,
	}));
	const coverage = linkedSessionCoverage(db, repoId, hash);
	const uncoveredSources = coverage
		.filter((row) => row.with_tools === 0 && !TOOL_RECORDING_SOURCES.has(row.source))
		.map((row) => row.source);
	return { activity, uncoveredSources };
}

/**
 * `context.context_key` for an archived reference, or undefined when it cannot
 * be derived.
 *
 * Must reproduce `SummaryStore.orphanPathFor` minus the `references/` prefix and
 * the `.md` suffix, because that path is exactly what `SotImport` files the
 * document under. Re-derived here rather than exported from there because the
 * only thing this page needs is the key, and the writer's copy carries a
 * throw-on-unknown-source guard that is correct for a WRITE and wrong for a read
 * path: a reference whose source has since left the registry must render as a
 * plain row, not blow up the whole memory detail. Hence the catch — both
 * `sanitizeNativeIdForPath`'s traversal guard and an unregistered source land
 * there and mean the same thing: no document to open.
 */
function referenceDocKey(source: string, archivedKey: string | undefined): string | undefined {
	// An archived reference always carries the key; a hand-written or pre-archive
	// row may not, and there is no document to open without one.
	if (!archivedKey) return undefined;
	const prefix = `${source}:`;
	const bareKey = archivedKey.startsWith(prefix) ? archivedKey.slice(prefix.length) : archivedKey;
	try {
		return `${source}/${sanitizeNativeIdForPath(source, bareKey)}`;
	} catch (err) {
		log.debug("no reference doc key for %s: %s", archivedKey, errMsg(err));
		return undefined;
	}
}

/**
 * The memory's Context list, in the editor's order: plans, notes, references,
 * then the single skills row.
 *
 * The order and the per-kind display rules are the editor's, not this page's —
 * `referenceDisplayTitle` decides whether a reference leads with its issue key,
 * and `buildSkillsSummaryLabel` writes the aggregate line. Both are the same CLI
 * helpers `SummaryHtmlBuilder` calls, so the two surfaces cannot drift into
 * describing the same memory differently.
 *
 * The skills row is ONE row keyed by the commit hash, not one row per skill:
 * its document is the whole `skills--<hash8>` table, rendered from the summary
 * on demand (see {@link readContextDoc}).
 */
function buildContextRows(summary: CommitSummary): ReadonlyArray<MemoryContextRow> {
	const skills = summary.skills ?? [];
	const inferred = skills.some((s) => s.detection === "heuristic") ? " · some inferred" : "";
	return [
		// The plan slug is already the archived `slug-hash8` form here, and the
		// note id already carries its archive suffix — both are the filed key.
		...(summary.plans ?? []).map((p) => ({
			kind: "plan" as const,
			title: p.title,
			contextKey: p.slug,
			meta: `${p.slug}.md`,
		})),
		...(summary.notes ?? []).map((n) => ({
			kind: "note" as const,
			title: n.title,
			contextKey: n.id,
			meta: `${n.id}.md`,
		})),
		...(summary.references ?? []).map((r) => {
			const key = referenceDocKey(r.source, r.archivedKey);
			// Same slot rule as the editor's reference row: the `<nativeId> (Source)`
			// line is meaningful only for the trackers whose key a reader recognizes;
			// an accumulating source claims the slot for its newest query instead.
			const meta = labelLeadsWithNativeId(r.source)
				? `${r.nativeId} (${referenceSourceLabel(r.source)})`
				: (r.latestQuery ?? "");
			return {
				kind: "reference" as const,
				title: referenceDisplayTitle(r),
				// Unconditional, unlike the three optional fields below: the badge
				// needs it for EVERY reference, including one whose source has left
				// the registry (which is precisely when `contextKey` is absent, so
				// the key's prefix cannot stand in). An unknown id lands on the
				// neutral fallback client-side rather than on no badge at all.
				source: r.source,
				...(key ? { contextKey: key } : {}),
				...(meta ? { meta } : {}),
				...(r.url ? { url: r.url } : {}),
			};
		}),
		...(skills.length > 0
			? [
					{
						kind: "skills" as const,
						title: "Skills used",
						contextKey: summary.commitHash,
						meta: `${buildSkillsSummaryLabel(skills)}${inferred}`,
					},
				]
			: []),
	];
}

/** One memory's full detail, or undefined when `hash` does not resolve within `scope`. */
export function buildMemoryDetail(
	db: DashboardDbHandle,
	scope: DashboardScope,
	hash: string,
): MemoryDetail | undefined {
	// Guard the empty string explicitly: with the prefix predicate below,
	// `length("")=0` makes `substr(commit_hash,1,0)=""` true for EVERY row (the
	// old `commit_hash = ""` matched none), so an empty hash would resolve to an
	// arbitrary memory. `buildMemories` already returns early on a falsy hash, but
	// this is exported and must not depend on every caller repeating that guard.
	if (!hash) return undefined;
	const resolved = scopeToRepoIds(db, scope);
	const filter = scopeFilter(resolved, "m.repo_id");
	const row = db
		.prepare(
			`SELECT m.commit_hash, m.branch, m.commit_message, m.commit_author, m.ticket_id,
			        -- Same COALESCE as reachableMemoryRows and buildMemoryCards, for the
			        -- same reason: raw m.commit_date_ms is the AUTHOR date, so a rebased
			        -- memory would render one instant in the tree row and another here.
			        COALESCE(cm.committed_at_ms, m.commit_date_ms) AS commit_date_ms,
			        m.summary_json, m.files_changed, m.insertions, m.deletions, m.jolli_doc_id,
			        m.repo_id, r.repo_identity, r.repo_name
			   FROM memories m
			   JOIN repos r ON r.id = m.repo_id
			   LEFT JOIN commits cm ON cm.repo_id = m.repo_id AND cm.hash = m.commit_hash
			  -- Prefix match on the leading length(hash) chars, so a SHORT hash
			  -- resolves too: the wiki's source-commit links carry an 8-char hash
			  -- (commitHash.substring(0,8)), and /memories?hash=a742fa47 must open the
			  -- same memory as the full 40-char form. A full hash makes this
			  -- substr(commit_hash,1,40)=hash, i.e. exactly the old '=' — so every
			  -- existing full-hash caller (stats/memories cards) is unchanged. substr
			  -- rather than LIKE ...||'%' keeps it a plain equality with no wildcard or
			  -- escape semantics (a hash is hex, but this stays true if that changes).
			  WHERE substr(m.commit_hash, 1, length(?)) = ?${filter.sql}
			  -- Deterministic pick. Without a scope filter (the all-repos view) one
			  -- hash can match rows in two repos — two clones of a project, or the
			  -- same commit cherry-picked into another — and an unordered LIMIT 1 let
			  -- the engine hand back a different repo's memory between renders.
			  -- m.commit_hash is the SECOND key, not decoration: a short hash can
			  -- prefix-collide WITHIN one repo (same repo_id), where repo_id alone is a
			  -- tie and LIMIT 1 would again be engine-defined. Ordering by the full
			  -- hash breaks that tie by a stable rule (lexicographic first), so the pick
			  -- is reproducible rather than whichever row the engine emits. It is a
			  -- deterministic choice among ambiguous matches, not a claim about which
			  -- commit the user meant — an 8-char prefix cannot say. detailRepo narrows
			  -- the scope first; within one scope a FULL hash matches exactly one row.
			  -- (In the all-repos view a full hash can still match two rows — the same
			  -- commit cherry-picked into two repos — but there the repo_id key breaks
			  -- the tie and the equal commit_hash makes the second key inert.)
			  ORDER BY m.repo_id, m.commit_hash
			  LIMIT 1`,
		)
		.get(hash, hash, ...filter.params) as MemoryDetailRow | undefined;
	if (!row) return undefined;

	// The `hash` argument may be a SHORT prefix (wiki source-commit links carry an
	// 8-char hash). The WHERE above resolved it to a row, but every downstream
	// lookup below matches `commit_hash = ?` EXACTLY — feeding the short prefix
	// would miss, silently degrading the detail (bare row instead of the folded
	// tree → tokens understated ~5x and topics lost; no commit_files → per-file
	// line counts lost; empty activity; conversations vanish entirely). Use the
	// full hash the row actually carries for all of them.
	const fullHash = row.commit_hash;

	// Not guarded: `memories` computes STORED generated columns with
	// `json_extract`, so SQLite rejects a malformed payload at INSERT
	// ("malformed JSON") — no unparseable row can exist to read here. Same
	// trust `DashboardQuery.ts`'s `buildMemoryCards` places in this column.
	// The TREE, not the bare row: `memories.summary_json` has its `children`
	// emptied (each child is its own row), and an amend/squash memory carries
	// most of its conversation tokens — and, on legacy v3/v4 data, its topics —
	// on those folded children. Reading the row alone reported 639k tokens for a
	// memory the editor shows as 3.45M. Falls back to the row if assembly finds
	// nothing, so a detail page never fails on a tree query.
	const summary = (assembleMemoryTree(db, row.repo_id, fullHash) ?? JSON.parse(row.summary_json)) as CommitSummary;

	const categoryLabels = commitCategoryLabels(db, scope);
	const category = categoryLabels.get(`${row.repo_identity}\0${row.commit_hash}`);

	const filesRows = db
		.prepare(
			`SELECT cf.path, cf.insertions, cf.deletions
			   FROM commit_files cf
			   JOIN commits c ON c.id = cf.commit_id
			  WHERE c.repo_id = ? AND c.hash = ?
			  ORDER BY cf.path`,
		)
		.all(row.repo_id, fullHash) as ReadonlyArray<{
		path: string;
		insertions: number | null;
		deletions: number | null;
	}>;
	const topicsRaw = collectDisplayTopics(summary);
	// `commit_files` comes from the collector's `--numstat` pass over git, which
	// only ever ran for commits it walked — a repo enrolled after the fact has
	// memories with no rows at all. The header still printed "4 files" (that
	// count is generated off `summary_json.diffStats`), so the page contradicted
	// itself and the section the editor fills was simply absent. The summary's
	// own per-topic `filesAffected` is the fallback: same paths the editor shows
	// in each topic's Files callout, minus the per-file line counts git alone
	// knows.
	const files: MemoryFileRow[] =
		filesRows.length > 0
			? filesRows.map((f) => ({
					path: f.path,
					...(f.insertions != null ? { insertions: f.insertions } : {}),
					...(f.deletions != null ? { deletions: f.deletions } : {}),
				}))
			: [...new Set(topicsRaw.flatMap((t) => t.filesAffected ?? []))].sort().map((path) => ({ path }));

	const topics: MemoryTopic[] = topicsRaw.map((t) => ({
		title: t.title,
		...(t.category ? { category: t.category } : {}),
		trigger: t.trigger,
		decisions: splitDecisionBullets(t.decisions),
		response: t.response,
		...(t.todo ? { todo: t.todo } : {}),
		files: t.filesAffected ?? [],
	}));

	const context = buildContextRows(summary);
	const excluded: MemoryExcludedRow[] = (summary.excludedContext ?? []).map((e) => ({
		title: e.title,
		reason: e.reason,
	}));

	const { activity, uncoveredSources } = buildActivity(db, row.repo_id, fullHash);

	// Aggregated over the tree, matching the editor's token meter
	// (`SummaryHtmlBuilder.buildTokenMeter`): a squash/amend memory keeps its
	// conversation tokens on the folded children, so the root's own breakdown
	// understates the total — here by 5x on a three-commit chain.
	//
	// `costUsd` is the SAME tree walk the editor's meter runs
	// (`estimateSummaryCostUsd`), not the root's own `estimatedCostUsd`. Reading
	// the root alone priced only the tip of a consolidation while the headline
	// beside it counted every folded node's tokens: measured ≈$2.59 here against
	// ≈$27.61 in the editor for one commit, with identical 3.1M token figures on
	// both. The objection that stored per-node costs carry different `pricesAsOf`
	// stamps is real but does not justify a number nothing agrees with — the
	// shared helper sums them the same way on every surface, and `pricesAsOf`
	// stays the root's stamp, which is what the "est. at <date> prices" note has
	// always meant.
	const breakdown = aggregateConversationTokenBreakdown(summary);
	const cost = estimateSummaryCostUsd(summary);
	// The headline is the editor's `aggregateConversationTokens`, which is NOT
	// the segment sum: a folded session reporting a scalar count with no
	// breakdown lands in it and in no segment. The segment-sum fallback covers
	// the one shape that aggregate cannot describe — a memory carrying a
	// breakdown but no scalar count, which this page has always rendered
	// (the editor's meter shows its "not reported" state there instead) and
	// which would otherwise print a 0 headline above a populated bar.
	const segmentSum = breakdown.input + breakdown.output + breakdown.cached;
	const totalTokens = aggregateConversationTokens(summary) || segmentSum;
	const tokens =
		totalTokens > 0 || summary.conversationTokenBreakdown
			? {
					total: totalTokens,
					input: breakdown.input,
					output: breakdown.output,
					cached: breakdown.cached,
					...(cost.usd > 0 ? { costUsd: cost.usd } : {}),
					...(summary.pricesAsOf ? { pricesAsOf: summary.pricesAsOf } : {}),
				}
			: undefined;
	const summarizedBy = summary.llm
		? {
				model: summary.llm.model,
				tokens: summary.llm.inputTokens + summary.llm.outputTokens + (summary.llm.cachedTokens ?? 0),
			}
		: undefined;
	// The whole tree, not `summary.llm` beside it — see MemoryDetail.provider.
	const provider = formatProviderLabel(summary);
	// This memory's OWN stamp — see MemoryDetail.generatedAtMs for why the page's
	// is not a substitute. `Date.parse` answers NaN for the empty string this
	// field is persisted as on some paths, which is what selects the fallback.
	const parsedGeneratedAt = Date.parse(summary.generatedAt ?? "");
	const generatedAtMs = Number.isFinite(parsedGeneratedAt) ? parsedGeneratedAt : row.commit_date_ms;

	return {
		repoIdentity: row.repo_identity,
		repoName: row.repo_name,
		commitHash: row.commit_hash,
		shortHash: row.commit_hash.slice(0, 7),
		// Always present, hash-derived until the memory syncs — the editor's page
		// title carries the same `JM-…` handle on every memory
		// (`buildPageTitleAndMetaStrip`), so the two surfaces name the same memory
		// the same way instead of one showing a bare commit message.
		memoryRefId: formatMemoryRefIdWithHashFallback(
			row.jolli_doc_id == null ? undefined : Number(row.jolli_doc_id),
			row.commit_hash,
		),
		title: row.commit_message ?? "",
		...(row.branch ? { branch: row.branch } : {}),
		...(row.commit_author ? { author: row.commit_author } : {}),
		committedAtMs: row.commit_date_ms,
		...(row.ticket_id ? { ticketId: row.ticket_id } : {}),
		...(category ? { category } : {}),
		synced: row.jolli_doc_id != null,
		...(row.files_changed != null ? { filesChanged: row.files_changed } : {}),
		...(row.insertions != null ? { insertions: row.insertions } : {}),
		...(row.deletions != null ? { deletions: row.deletions } : {}),
		...(tokens ? { tokens } : {}),
		...(summarizedBy ? { summarizedBy } : {}),
		...(provider ? { provider } : {}),
		generatedAtMs,
		...(summary.recap ? { recap: summary.recap } : {}),
		conversations: buildConversations(db, row.repo_id, fullHash, summary),
		context,
		excluded,
		activity,
		activityUncoveredSources: uncoveredSources,
		topics,
		files,
		e2e: (summary.e2eTestGuide ?? []).map((s) => ({
			title: s.title,
			...(s.preconditions ? { preconditions: s.preconditions } : {}),
			steps: s.steps,
			expectedResults: s.expectedResults,
		})),
	};
}

/**
 * The full Memories page payload: the list, plus the selected memory's detail
 * when `hash` resolves.
 *
 * `detailRepoIdentity` disambiguates the DETAIL only and deliberately does not
 * touch `scope`. Opening a memory used to carry the owning repo in `?repo=`,
 * which is the page-wide scope param — so clicking any row collapsed the tree to
 * that one repository, and the reader lost every other repo's memories as the
 * price of opening one. The two questions are separate: which repo owns the hash
 * (needed only when two clones share it) and which repos the tree lists.
 */
export function buildMemories(
	db: DashboardDbHandle,
	scope: DashboardScope,
	hash: string | undefined,
	reachable?: ReachableCommits,
	detailRepoIdentity?: string,
): MemoriesModel {
	const list = buildMemoriesList(db, scope, reachable);
	if (!hash) return list;
	// Through `resolveScope`, because the link carries whatever `JD.repoToken`
	// picked — usually the repo NAME, since that is the readable token. Handing a
	// name straight to `buildMemoryDetail` resolves to repo id -1 (matches
	// nothing), so the tree row navigated to a page whose detail pane stayed
	// empty: the click looked like it did nothing at all.
	// Always exactly ONE identity: this names the memory's owner, not the page
	// scope, and a detail pane showing one memory has one owning repo.
	const detailScope: DashboardScope = detailRepoIdentity
		? resolveScope(db, { kind: "repo", repoIdentities: [detailRepoIdentity] })
		: scope;
	// A token that resolves to no repo means the link is stale (repo removed, or
	// renamed since the page was rendered). Fall back to the page scope rather
	// than to a filter that matches nothing — the hash still identifies the
	// memory, and showing it is strictly better than showing an empty pane.
	const detailIds = scopeToRepoIds(db, detailScope).repoIds;
	const detail = detailIds?.includes(-1) ? scope : detailScope;
	const selected = buildMemoryDetail(db, detail, hash);
	return selected ? { ...list, selected } : list;
}

/**
 * One context body, for the Context viewer dialog.
 *
 * Scoped to a repo but NOT to a commit: the same plan backs several memories,
 * and the caller already knows which row was clicked. `repoToken` goes through
 * `resolveScope` so this accepts the same `?repo=` values every other route
 * does — a full identity or a unique repo name — instead of being the one
 * endpoint that silently 404s on a name.
 *
 * `skills` is the one kind that is RENDERED rather than read: its per-commit
 * table is not a stored document at all (the `skills--<hash8>.md` file exists
 * only in the Memory Bank's visible layer, which orphan-branch-only installs
 * never write), so it is built from the summary with the same renderer that
 * wrote that file — exactly what `jollimemory.previewCommittedSkills` does in
 * the editor. Its `contextKey` is therefore the commit hash, not a `context`
 * row key.
 *
 * Returns undefined for an unknown repo/kind/key rather than throwing, so the
 * route can answer 404 without special-casing.
 */
export function readContextDoc(
	db: DashboardDbHandle,
	repoToken: string,
	kind: MemoryContextKind,
	contextKey: string,
): ContextDoc | undefined {
	// One token in, so at most one id out — this read is per-repository, never
	// scoped across the picker's selection.
	const { repoIds } = scopeToRepoIds(db, resolveScope(db, { kind: "repo", repoIdentities: [repoToken] }));
	const repoId = repoIds?.[0];
	if (repoId == null) return undefined;
	if (kind === "skills") return readSkillsDoc(db, repoId, contextKey);
	const row = db
		.prepare(
			`SELECT c.title, c.body_md
			   FROM context c
			  WHERE c.repo_id = ? AND c.kind = ? AND c.context_key = ?
			  LIMIT 1`,
		)
		.get(repoId, kind, contextKey) as { title: string | null; body_md: string } | undefined;
	if (!row) return undefined;
	return { kind, title: row.title ?? contextKey, bodyMd: row.body_md };
}

/**
 * How much of one archived conversation `/api/conversation` will serve.
 *
 * The editor reads the same archive in-process and shows all of it; this crosses
 * HTTP into a modal, and an agent session can carry thousands of turns of
 * unbounded text. Generous enough that a normal conversation is never clipped,
 * and {@link ConversationDoc.truncated} says so when one is — a viewer showing a
 * silent prefix would read as the whole conversation.
 */
const CONVERSATION_ENTRY_LIMIT = 400;
const CONVERSATION_CONTENT_LIMIT = 20_000;

/**
 * One archived conversation's turns, for the Memories page's Conversation
 * viewer — the read behind `/api/conversation`.
 *
 * Resolves the session exactly as {@link buildConversations} does, through the
 * same {@link readMemoryTranscripts} + `groupArchivedSessions` pair, so the
 * dialog shows the conversation the clicked row named. The lookup key is a plain
 * string compare against the group map: `archivedSessionKey` is
 * `${source}:${sessionId}` with a `"claude"` default for a source-less stored
 * session, and the row already carries that same defaulted source — so what the
 * client sends back IS the key, and re-deriving it here would only add a second
 * place for the default to drift.
 *
 * Returns undefined for an unknown repo or session rather than throwing, so the
 * route can answer 404 without special-casing — the same contract
 * {@link readContextDoc} has.
 */
export function readConversationEntries(
	db: DashboardDbHandle,
	repoToken: string,
	hash: string,
	source: string,
	sessionId: string,
): ConversationDoc | undefined {
	const { repoIds } = scopeToRepoIds(db, resolveScope(db, { kind: "repo", repoIdentities: [repoToken] }));
	const repoId = repoIds?.[0];
	if (repoId == null) return undefined;

	// The TREE, matching buildMemoryDetail and readSkillsDoc: the row that opened
	// this dialog was built from the assembled tree, so reading the bare row could
	// resolve a different transcript set than the row's own count line claims.
	const memory = db
		.prepare("SELECT summary_json FROM memories WHERE repo_id = ? AND commit_hash = ? LIMIT 1")
		.get(repoId, hash) as { summary_json: string } | undefined;
	if (!memory) return undefined;
	const summary = (assembleMemoryTree(db, repoId, hash) ?? JSON.parse(memory.summary_json)) as CommitSummary;

	const key = `${source}:${sessionId}`;
	const { grouped } = groupArchivedSessions(readMemoryTranscripts(db, repoId, hash, summary));
	const group = grouped.get(key);
	if (!group) return undefined;

	const total = group.entries.length;
	// Counted, not just flagged: the viewer has to name which of the two caps bit,
	// and clipping is the one that leaves no trace in the counts it can see.
	let clippedEntries = 0;
	const entries = group.entries.slice(0, CONVERSATION_ENTRY_LIMIT).map((e) => {
		const clipped = e.content.length > CONVERSATION_CONTENT_LIMIT;
		if (clipped) clippedEntries += 1;
		return {
			role: e.role,
			content: clipped ? e.content.slice(0, CONVERSATION_CONTENT_LIMIT) : e.content,
			...(e.timestamp ? { timestamp: e.timestamp } : {}),
		};
	});

	return {
		// The row's precedence, all three rungs of it: the archived title first
		// (see buildConversations for why it outranks anything re-derived here),
		// then the live `sessions` row, and only then a title derived from the
		// turns. Dropping the middle rung is not a smaller version of the same
		// answer — it renames the conversation the moment the dialog opens, for
		// exactly the memories whose archive predates the title being stored.
		title:
			group.session.title ??
			readNativeSessionTitles(db, repoId, hash).get(key) ??
			firstUserMessageTitleFromEntries(group.entries),
		source: group.session.source ?? "claude",
		sessionId: group.session.sessionId,
		messageCount: total,
		entries,
		truncated: total > CONVERSATION_ENTRY_LIMIT || clippedEntries > 0,
		clippedEntries,
	};
}

/**
 * The skills table for one commit, rendered from its summary.
 *
 * Reads the TREE, matching {@link buildMemoryDetail}: the row that opened this
 * dialog was built from the assembled tree, so reading the bare row here could
 * answer with a different skill set than the row's own count line claims.
 */
function readSkillsDoc(db: DashboardDbHandle, repoId: number, commitHash: string): ContextDoc | undefined {
	const row = db
		.prepare("SELECT summary_json FROM memories WHERE repo_id = ? AND commit_hash = ? LIMIT 1")
		.get(repoId, commitHash) as { summary_json: string } | undefined;
	if (!row) return undefined;
	const summary = (assembleMemoryTree(db, repoId, commitHash) ?? JSON.parse(row.summary_json)) as CommitSummary;
	const skills = summary.skills ?? [];
	if (skills.length === 0) return undefined;
	return {
		kind: "skills",
		title: `Skills used — ${commitHash.substring(0, 8)}`,
		bodyMd: buildSkillsAggregateMarkdown(summary, skills),
	};
}
