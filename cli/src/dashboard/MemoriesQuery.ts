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
import { formatMemoryRefId } from "../core/MemoryRefId.js";
import { firstUserMessageTitleFromEntries } from "../core/SessionTitleResolver.js";
import { assembleMemoryTree } from "../core/SqliteStorage.js";
import {
	aggregateConversationTokenBreakdown,
	aggregateConversationTokens,
	collectDisplayTopics,
} from "../core/SummaryTree.js";
import { TOOL_RECORDING_SOURCES } from "../core/TranscriptParser.js";
import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary, StoredTranscript } from "../Types.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import {
	type ContextDoc,
	type DashboardScope,
	MEMORIES_LIST_LIMIT,
	type MemoriesModel,
	type MemoryActivityRow,
	type MemoryContextRow,
	type MemoryConversationRow,
	type MemoryDetail,
	type MemoryExcludedRow,
	type MemoryFileRow,
	type MemoryListItem,
	type MemoryReferenceRow,
	type MemoryTopic,
} from "./DashboardModel.js";
import {
	commitCategoryLabels,
	resolveScope,
	scopeFilter,
	scopeToRepoId,
	splitDecisionBullets,
} from "./DashboardScopeUtil.js";

const log = createLogger("MemoriesQuery");

interface MemoryListRow {
	readonly commit_hash: string;
	readonly branch: string | null;
	readonly commit_message: string | null;
	readonly commit_date_ms: number;
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

/** The tree's list of rows and the sidebar's vitals — no per-memory detail. */
export function buildMemoriesList(
	db: DashboardDbHandle,
	scope: DashboardScope,
	reachable?: ReachableCommits,
): Omit<MemoriesModel, "selected"> {
	const resolved = scopeToRepoId(db, scope);
	const listFilter = scopeFilter(resolved, "m.repo_id");
	// No SQL LIMIT: reachability can only be checked in JS (git, not the DB),
	// so the full root-memory set for this scope is fetched, filtered, then
	// paged — `memories` only grows with real commits, so this scales with a
	// single repo's history, not with the git-cost of the check itself.
	const allRows = db
		.prepare(
			`SELECT m.commit_hash, m.branch, m.commit_message, m.commit_date_ms, m.ticket_id, m.jolli_doc_id,
			        r.repo_identity, r.repo_name
			   FROM memories m
			   JOIN repos r ON r.id = m.repo_id
			  WHERE m.parent_hash IS NULL
				${listFilter.sql}
			  ORDER BY m.commit_date_ms DESC`,
		)
		.all(...listFilter.params) as ReadonlyArray<MemoryListRow>;
	const rows = allRows.filter((row) => isReachable(reachable, row.repo_identity, row.commit_hash));

	const truncated = rows.length > MEMORIES_LIST_LIMIT;
	const page = truncated ? rows.slice(0, MEMORIES_LIST_LIMIT) : rows;
	const categoryLabels = commitCategoryLabels(db, scope);

	const items: MemoryListItem[] = page.map((row) => {
		const category = categoryLabels.get(`${row.repo_name}\0${row.commit_hash}`);
		const memoryRefId = formatMemoryRefId(row.jolli_doc_id == null ? undefined : Number(row.jolli_doc_id));
		return {
			repoIdentity: row.repo_identity,
			repoName: row.repo_name,
			commitHash: row.commit_hash,
			shortHash: row.commit_hash.slice(0, 7),
			...(memoryRefId ? { memoryRefId } : {}),
			title: row.commit_message ?? "",
			...(row.branch ? { branch: row.branch } : {}),
			committedAtMs: row.commit_date_ms,
			...(row.ticket_id ? { ticketId: row.ticket_id } : {}),
			...(category ? { category } : {}),
			synced: row.jolli_doc_id != null,
		};
	});

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
		truncated,
		vitals: { memories: memoriesTotal, topics: topicsTotal, repos: reposTotal },
	};
}

interface MemoryDetailRow {
	readonly commit_hash: string;
	readonly branch: string | null;
	readonly commit_message: string | null;
	readonly commit_author: string | null;
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
 * The live `sessions` row is still consulted, but only as the title of first
 * resort — it carries the discoverer's native title (opencode/cursor/copilot),
 * which is `resolveSessionTitle`'s own step 1. Its steps 2-3 need either the
 * live transcript file or the merged entries; only the latter is reachable from
 * a database transaction, and for an archived session it is what the editor
 * ends up using anyway (the stored session carries no `title`, and its
 * `transcriptPath` is usually gone), so `firstUserMessageTitleFromEntries` is
 * the same answer rather than an approximation of it.
 */
function buildConversations(db: DashboardDbHandle, repoId: number, hash: string): ReadonlyArray<MemoryConversationRow> {
	const blobs = db
		.prepare(
			`SELECT mt.transcript_id, t.sessions_blob
			   FROM memory_transcripts mt
			   JOIN transcripts t ON t.repo_id = mt.repo_id AND t.transcript_id = mt.transcript_id
			  WHERE mt.repo_id = ? AND mt.commit_hash = ?`,
		)
		.all(repoId, hash) as ReadonlyArray<{ transcript_id: string; sessions_blob: Uint8Array }>;

	const transcripts: Array<readonly [string, StoredTranscript]> = [];
	for (const b of blobs) {
		try {
			transcripts.push([b.transcript_id, JSON.parse(inflateSync(Buffer.from(b.sessions_blob)).toString("utf8"))]);
		} catch (err) {
			// One unreadable blob must not blank the whole panel; the others are
			// still real conversations. Counted nowhere because this is a read
			// path — the import already reports what it skipped.
			log.warn("transcript %s unreadable for the memories view: %s", b.transcript_id, errMsg(err));
		}
	}

	const nativeTitles = new Map(
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

	const { order, grouped } = groupArchivedSessions(transcripts);
	return order.map((key) => {
		const g = grouped.get(key) as NonNullable<ReturnType<typeof grouped.get>>;
		return {
			source: g.session.source ?? "claude",
			title: nativeTitles.get(key) ?? firstUserMessageTitleFromEntries(g.entries),
			messageCount: g.entries.length,
		};
	});
}

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
			`SELECT stu.tool_name, stu.kind, stu.server, SUM(stu.calls) AS calls
			   FROM (SELECT DISTINCT s.event_id
			           FROM memory_transcripts mt
			           JOIN transcript_sessions ts
			             ON ts.repo_id = mt.repo_id AND ts.transcript_id = mt.transcript_id
			            AND ts.source IS NOT NULL
			           JOIN sessions s
			             ON s.repo_id = ts.repo_id AND s.source = ts.source AND s.session_id = ts.session_id
			          WHERE mt.repo_id = ? AND mt.commit_hash = ?) se
			   JOIN session_tool_use stu ON stu.session_event_id = se.event_id
			  GROUP BY stu.kind, stu.tool_name, stu.server`,
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

/** One memory's full detail, or undefined when `hash` does not resolve within `scope`. */
export function buildMemoryDetail(
	db: DashboardDbHandle,
	scope: DashboardScope,
	hash: string,
): MemoryDetail | undefined {
	const resolved = scopeToRepoId(db, scope);
	const filter = scopeFilter(resolved, "m.repo_id");
	const row = db
		.prepare(
			`SELECT m.commit_hash, m.branch, m.commit_message, m.commit_author, m.commit_date_ms, m.ticket_id,
			        m.summary_json, m.files_changed, m.insertions, m.deletions, m.jolli_doc_id,
			        m.repo_id, r.repo_identity, r.repo_name
			   FROM memories m
			   JOIN repos r ON r.id = m.repo_id
			  WHERE m.commit_hash = ?${filter.sql}
			  -- Deterministic pick. Without a scope filter (the all-repos view) one
			  -- hash can match rows in two repos — two clones of a project, or the
			  -- same commit cherry-picked into another — and an unordered LIMIT 1 let
			  -- the engine hand back a different repo's memory between renders.
			  ORDER BY m.repo_id
			  LIMIT 1`,
		)
		.get(hash, ...filter.params) as MemoryDetailRow | undefined;
	if (!row) return undefined;

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
	const summary = (assembleMemoryTree(db, row.repo_id, hash) ?? JSON.parse(row.summary_json)) as CommitSummary;

	const categoryLabels = commitCategoryLabels(db, scope);
	const category = categoryLabels.get(`${row.repo_name}\0${row.commit_hash}`);

	const filesRows = db
		.prepare(
			`SELECT cf.path, cf.insertions, cf.deletions
			   FROM commit_files cf
			   JOIN commits c ON c.id = cf.commit_id
			  WHERE c.repo_id = ? AND c.hash = ?
			  ORDER BY cf.path`,
		)
		.all(row.repo_id, hash) as ReadonlyArray<{ path: string; insertions: number | null; deletions: number | null }>;
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

	const references: MemoryReferenceRow[] = (summary.references ?? []).map((r) => ({
		source: r.source,
		nativeId: r.nativeId,
		title: r.title,
		...(r.url ? { url: r.url } : {}),
	}));
	// `contextKey` is what `readContextDoc` looks the body up by, and it must be
	// the key `SotImport` filed the document under: the plan's slug (already the
	// archived `slug-hash` form here) and the note's id.
	const context: MemoryContextRow[] = [
		...(summary.plans ?? []).map((p) => ({ kind: "plan" as const, title: p.title, contextKey: p.slug })),
		...(summary.notes ?? []).map((n) => ({ kind: "note" as const, title: n.title, contextKey: n.id })),
	];
	const excluded: MemoryExcludedRow[] = (summary.excludedContext ?? []).map((e) => ({
		title: e.title,
		reason: e.reason,
	}));

	const { activity, uncoveredSources } = buildActivity(db, row.repo_id, hash);

	// Aggregated over the tree, matching the editor's token meter
	// (`SummaryHtmlBuilder.buildTokenMeter`): a squash/amend memory keeps its
	// conversation tokens on the folded children, so the root's own breakdown
	// understates the total — here by 5x on a three-commit chain.
	//
	// `costUsd` stays the root's own `estimatedCostUsd` rather than a sum: the
	// field is a per-node estimate at that node's `pricesAsOf`, and adding
	// figures stamped at different price tables would invent a number no node
	// agrees with. The editor prices the aggregate from `conversationModels`
	// instead, which needs the price table this query has no business loading.
	const breakdown = aggregateConversationTokenBreakdown(summary);
	const tokens =
		aggregateConversationTokens(summary) > 0 || summary.conversationTokenBreakdown
			? {
					input: breakdown.input,
					output: breakdown.output,
					cached: breakdown.cached,
					...(summary.estimatedCostUsd != null ? { costUsd: summary.estimatedCostUsd } : {}),
					...(summary.pricesAsOf ? { pricesAsOf: summary.pricesAsOf } : {}),
				}
			: undefined;
	const summarizedBy = summary.llm
		? {
				model: summary.llm.model,
				tokens: summary.llm.inputTokens + summary.llm.outputTokens + (summary.llm.cachedTokens ?? 0),
			}
		: undefined;

	return {
		repoIdentity: row.repo_identity,
		repoName: row.repo_name,
		commitHash: row.commit_hash,
		shortHash: row.commit_hash.slice(0, 7),
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
		...(summary.recap ? { recap: summary.recap } : {}),
		conversations: buildConversations(db, row.repo_id, hash),
		references,
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

/** The full Memories page payload: the list, plus the selected memory's detail when `hash` resolves. */
export function buildMemories(
	db: DashboardDbHandle,
	scope: DashboardScope,
	hash: string | undefined,
	reachable?: ReachableCommits,
): MemoriesModel {
	const list = buildMemoriesList(db, scope, reachable);
	if (!hash) return list;
	const selected = buildMemoryDetail(db, scope, hash);
	return selected ? { ...list, selected } : list;
}

/**
 * One plan/note body, for the Context viewer dialog.
 *
 * Scoped to a repo but NOT to a commit: the same plan backs several memories,
 * and the caller already knows which row was clicked. `repoToken` goes through
 * `resolveScope` so this accepts the same `?repo=` values every other route
 * does — a full identity or a unique repo name — instead of being the one
 * endpoint that silently 404s on a name.
 *
 * Returns undefined for an unknown repo/kind/key rather than throwing, so the
 * route can answer 404 without special-casing.
 */
export function readContextDoc(
	db: DashboardDbHandle,
	repoToken: string,
	kind: "plan" | "note",
	contextKey: string,
): ContextDoc | undefined {
	const { repoId } = scopeToRepoId(db, resolveScope(db, { kind: "repo", repoIdentity: repoToken }));
	if (repoId == null) return undefined;
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
