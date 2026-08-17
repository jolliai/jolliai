/**
 * Scope-resolution, decision-text and MCP-identifier helpers shared by
 * `DashboardQuery.ts` and `MemoriesQuery.ts`.
 *
 * Split out rather than left in `DashboardQuery.ts` (which both used to
 * import from) because that created an import cycle: `DashboardQuery.ts`
 * dispatches to `buildMemories` for the memories view, and `MemoriesQuery.ts`
 * needs these same scope helpers. A shared leaf module both can depend on
 * avoids it.
 */

import { createLogger } from "../Logger.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import type { DashboardScope } from "./DashboardModel.js";

const log = createLogger("DashboardScope");

/**
 * WHERE fragment + params for the repo scope.
 *
 * `= ?` for one repo, `IN (…)` for several, nothing at all for every repo. The
 * single-id spelling is not just cosmetic: it is what the query planner reads as
 * an equality lookup on the indexed column, and one repo is the common case.
 */
export function scopeFilter(scope: ResolvedScope, column = "repo_id"): { sql: string; params: unknown[] } {
	const ids = scope.repoIds;
	if (ids == null) return { sql: "", params: [] };
	if (ids.length === 1) return { sql: ` AND ${column} = ?`, params: [ids[0]] };
	return { sql: ` AND ${column} IN (${placeholders(ids.length)})`, params: [...ids] };
}

/**
 * `?, ?, …` for an `IN (…)` list of `n` bound values.
 *
 * Exists so a fixed name list stays a BOUND parameter list instead of being
 * interpolated into the SQL — some callers pass build-time constants, but a
 * helper that inlines them is one refactor away from inlining a user string.
 * The repo-scope list below is exactly that user string.
 */
export function placeholders(n: number): string {
	return new Array(n).fill("?").join(", ");
}

/**
 * A scope with its repo identities already resolved to surrogate keys.
 *
 * Resolved once per query function rather than inside scopeFilter, because a
 * single page builds a dozen filters and they would otherwise repeat the same
 * lookup. `null` is every repo — no WHERE clause at all.
 *
 * A scope naming only repos the database has never seen resolves to `[-1]`,
 * which deliberately reads as "no rows" rather than "every repo": an unknown
 * repo has no data, and widening to all of them would be a silent lie. It is
 * `[-1]` rather than `[]` because an empty `IN ()` is not valid SQLite, and
 * because "matches nothing" has to be expressible — `null` already means the
 * opposite.
 */
export interface ResolvedScope {
	readonly repoIds: readonly number[] | null;
}

/**
 * Resolve a scope's identities to row ids, in one query rather than one per
 * identity.
 *
 * Order follows the scope's own identity list, not the table's, so the bound
 * parameters read the same way the URL does. Unknown identities are dropped
 * individually — a scope naming one live repo and one stale bookmark answers for
 * the live one, which is the only reading that is not a lie in either direction.
 *
 * Filtered in SQL rather than by reading `repos` whole and matching in JS:
 * `repo_identity` is `NOT NULL UNIQUE`, so the `IN` list is an index lookup, and
 * this runs once per filter site — a dozen-plus times for one page build. The
 * doc on {@link ResolvedScope} promises the lookup is not repeated per filter;
 * it should not be a full table scan when it does run.
 */
export function scopeToRepoIds(db: DashboardDbHandle, scope: DashboardScope): ResolvedScope {
	const wanted = scope.kind === "repo" ? scope.repoIdentities : undefined;
	if (!wanted || wanted.length === 0) return { repoIds: null };
	const unique = [...new Set(wanted)];
	const rows = db
		.prepare(`SELECT id, repo_identity FROM repos WHERE repo_identity IN (${placeholders(unique.length)})`)
		.all(...unique) as ReadonlyArray<{
		id: number;
		repo_identity: string;
	}>;
	const byIdentity = new Map(rows.map((row) => [row.repo_identity, row.id]));
	const ids: number[] = [];
	for (const identity of wanted) {
		const id = byIdentity.get(identity);
		if (id != null && !ids.includes(id)) ids.push(id);
	}
	// -1 matches nothing, which is the honest answer when no identity resolved.
	return { repoIds: ids.length > 0 ? ids : [-1] };
}

/**
 * Commit-level category LABELS — `repoName\0hash` (NUL-joined, same convention as SotImport's keyOf) → the mode of that
 * commit's topic categories, straight from `memory_topics`.
 *
 * A label for group headers and meta chips, never an aggregation axis: sums
 * over categories read `memory_topics` with the tokens shared per topic (see
 * the `category` branch of `DashboardQuery.ts`'s `buildSeries`), because a
 * mode erases every category that never wins a commit's vote — measured here,
 * `security` (211 topics) and `docs` (30) never appeared at all.
 *
 * Derived at query time so nothing stored can fall behind a regeneration. The
 * tie rule is pinned to what the old stored copy did: highest count first,
 * then the category whose first topic appears earliest (`MIN(pos)`), which is
 * exactly the stable-sort-over-insertion-order behaviour the collector had.
 */
export function commitCategoryLabels(db: DashboardDbHandle, scope: DashboardScope): Map<string, string> {
	const filter = scopeFilter(scopeToRepoIds(db, scope), "t.repo_id");
	const rows = db
		.prepare(
			`SELECT r.repo_identity, ranked.commit_hash, ranked.category
			   FROM (SELECT t.repo_id, t.commit_hash, t.category,
			                COUNT(*) AS n, MIN(t.pos) AS first_pos,
			                ROW_NUMBER() OVER (PARTITION BY t.repo_id, t.commit_hash ORDER BY COUNT(*) DESC, MIN(t.pos) ASC) AS rn
			           FROM memory_topics t
			          WHERE t.category IS NOT NULL${filter.sql}
			          GROUP BY t.repo_id, t.commit_hash, t.category) ranked
			   JOIN repos r ON r.id = ranked.repo_id
			  WHERE ranked.rn = 1`,
		)
		.all(...filter.params) as ReadonlyArray<{ repo_identity: string; commit_hash: string; category: string }>;
	// Keyed by repo_identity, NOT repo_name: the name is a display label and two
	// registered repos can share one (an upstream and its fork, two clones of the
	// same project). Their hashes overlap by construction, so in the all-repos
	// scope a name-keyed map collided and painted one repo's category label onto
	// the other's memories and standup rows. `CommitRow.repo_identity` carries
	// the same warning for the same reason.
	return new Map(rows.map((row) => [`${row.repo_identity}\0${row.commit_hash}`, row.category]));
}

/**
 * Splits a topic's `decisions` field into cleaned bullet lines.
 *
 * The field is one prose block (a markdown bullet list, or occasionally a
 * plain sentence) — never an array — so this is the one place that turns it
 * into a list. Shared by `DashboardQuery.ts`'s `firstDecisionLine` (the feed
 * card, which wants only the first) and `MemoriesQuery.ts`'s detail pane
 * (which wants all of them for its Decisions callout), so the two can never
 * disagree about what one commit's decisions were. `**Chose X**: because Y`
 * → `Chose X: because Y` — callers style their own emphasis, so markdown
 * markers would otherwise show up literally.
 */
export function splitDecisionBullets(text: string | undefined): ReadonlyArray<string> {
	const block = text?.trim();
	if (!block) return [];
	return block
		.split("\n")
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter((line) => line.length > 0)
		.map((line) => line.replace(/\*\*/g, "").replace(/\s+/g, " "));
}

/**
 * Accepts a repo **name** in the `?repo=` token as well as a full identity, so a
 * shareable link can read `?repo=jolliai` instead of a URL-encoded remote.
 *
 * Precedence is identity first: it is the stored key, so an exact match can
 * never be shadowed by a repo that happens to be *named* like someone else's
 * remote. A name is accepted only when it resolves to exactly one repo —
 * duplicates (two clones of different remotes with the same basename) are left
 * unresolved rather than silently picking one, which would show the wrong
 * project's numbers under a plausible-looking URL.
 *
 * `repos.id` is deliberately NOT accepted: it is a rowid assigned by insert
 * order, so it is not stable across a database rebuild — a bookmarked `?repo=3`
 * could quietly come back pointing at a different project.
 *
 * Every token in a multi-repo scope is resolved INDEPENDENTLY by those rules and
 * the results deduped: `?repo=jolliai&repo=<identity-of-jolliai>` is one repo,
 * not two, and an ambiguous name sitting next to a good identity does not spoil
 * the good one.
 */
export function resolveScope(db: DashboardDbHandle, scope: DashboardScope): DashboardScope {
	const tokens = scope.kind === "repo" ? scope.repoIdentities : undefined;
	if (!tokens || tokens.length === 0) return scope;
	const rows = db.prepare("SELECT repo_identity, repo_name FROM repos").all() as ReadonlyArray<{
		repo_identity: string;
		repo_name: string;
	}>;
	const identities = new Set(rows.map((row) => row.repo_identity));
	const resolved: string[] = [];
	for (const token of tokens) {
		const identity = resolveToken(rows, identities, token);
		if (!resolved.includes(identity)) resolved.push(identity);
	}
	return { kind: "repo", repoIdentities: resolved };
}

function resolveToken(
	rows: ReadonlyArray<{ repo_identity: string; repo_name: string }>,
	identities: ReadonlySet<string>,
	token: string,
): string {
	if (identities.has(token)) return token;
	const byName = rows.filter((row) => row.repo_name === token);
	if (byName.length === 1) return byName[0].repo_identity;
	if (byName.length > 1) {
		log.warn("repo name %s matches %d repos — pass the full identity to disambiguate", token, byName.length);
	}
	// Left as-is on purpose: it then resolves to a key matching nothing, rather
	// than being silently dropped and widening the scope.
	return token;
}

/**
 * Strips a host's plugin-registration prefix off an MCP identifier, so ONE
 * server reached two ways counts once.
 *
 * A server registered by a Claude plugin is namespaced `plugin_<plugin>_<server>`
 * by the host, while the same server registered in the repo's own `.mcp.json`
 * arrives bare. Jolli's own is registered both ways on a normal install — the
 * plugin bundles an `.mcp.json` and `jolli enable` writes one — so the MCPs card
 * showed `jollimemory` and `plugin_jolli_jollimemory` as two servers, splitting
 * one server's call volume across two rows and inflating the "N servers" total.
 *
 * Applied at READ time and to BOTH identifier columns, which is not an
 * implementation detail:
 *
 *   - Read, not write, so rows already in `session_tool_use` merge. Normalizing
 *     in `classifyToolName` would only fix sessions recorded after the change,
 *     and leaves the stored row a literal record of what the host reported —
 *     which is what it is for.
 *   - `tool_name` too, because `mcpTool` folds the server into it
 *     (`<server>.<tool>`). Merging only `server` would count
 *     `jollimemory.recall` and `plugin_jolli_jollimemory.recall` as two distinct
 *     tools, so the merged row would claim "10 tools" for a server with 5. Both
 *     columns carry the alias as a leading prefix, so one expression serves both.
 *
 * The prefix is ambiguous by construction — `plugin_<plugin>_<server>` with
 * underscores legal in either half, so `plugin_a_b_c` cannot be split with
 * certainty — and this takes the first segment after `plugin_` as the plugin
 * name. A plugin whose own name contains an underscore therefore under-strips
 * (`plugin_my_plugin_linear` → `plugin_linear`), which leaves that server
 * un-merged rather than merging it into the wrong one. That is the safe
 * direction, and it is why this cannot be tightened into an allowlist without
 * giving up every other plugin-provided server: the same duplicate arises for
 * any of them, and the host's format is the only thing they share.
 *
 * SQLite's `substr` is 1-based; `'plugin_'` is 7 bytes, so `substr(col, 8)` is
 * the remainder and `8 + instr(...)` lands one past its first underscore.
 *
 * The prefix test is `GLOB`, never `LIKE`. SQLite's `LIKE` is case-INSENSITIVE
 * for ASCII by default, so `LIKE 'plugin\_%'` also claims `Plugin_Manager_Api` —
 * a server whose real name simply starts that way — and folds it to `Api`,
 * silently merging it with any unrelated `Api` server. That is exactly the
 * mis-attribution the deliberate under-stripping above exists to avoid, handed
 * back by the operator rather than by the rule. `GLOB` is always
 * case-sensitive and takes no collating sequence, and it needs no `ESCAPE`
 * clause here because `_` is a literal in GLOB patterns (only `*`, `?` and `[`
 * are wildcards) — so the pattern reads as what it matches.
 *
 * Lives here, not in `DashboardQuery.ts`, because the memory-detail activity
 * query in `MemoriesQuery.ts` groups on the same two columns and must fold them
 * the same way — and that module cannot import from `DashboardQuery.ts`
 * (the cycle this file exists to break). Use {@link mcpFoldedIdentifierSql}
 * from any query whose rows are NOT already restricted to `kind = 'mcp'`.
 */
export function stripPluginPrefixSql(col: string): string {
	return (
		`CASE WHEN ${col} GLOB 'plugin_*' AND instr(substr(${col}, 8), '_') > 0` +
		` THEN substr(${col}, 8 + instr(substr(${col}, 8), '_')) ELSE ${col} END`
	);
}

/**
 * {@link stripPluginPrefixSql} applied to MCP rows ONLY, for a query whose
 * result set mixes `session_tool_use.kind` values.
 *
 * The guard is the same decision `DashboardQuery.ts`'s skill list makes by
 * keeping its raw column: `plugin_…` is a registration alias an MCP host
 * prepended, so folding it is meaningful only for an identifier that host
 * produced. A skill name and a builtin tool name are names somebody chose, and
 * one that happens to start `plugin_` would be silently renamed by a rule that
 * has nothing to do with it. Queries already pinned to `kind = 'mcp'` by their
 * WHERE clause call {@link stripPluginPrefixSql} directly instead.
 */
export function mcpFoldedIdentifierSql(col: string, kindCol: string): string {
	return `CASE WHEN ${kindCol} = 'mcp' THEN ${stripPluginPrefixSql(col)} ELSE ${col} END`;
}
