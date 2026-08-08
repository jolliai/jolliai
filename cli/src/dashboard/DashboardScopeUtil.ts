/**
 * Scope-resolution and decision-text helpers shared by `DashboardQuery.ts` and
 * `MemoriesQuery.ts`.
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

/** WHERE fragment + params for the repo scope. */
export function scopeFilter(scope: ResolvedScope, column = "repo_id"): { sql: string; params: unknown[] } {
	if (scope.repoId != null) return { sql: ` AND ${column} = ?`, params: [scope.repoId] };
	return { sql: "", params: [] };
}

/**
 * `?, ?, …` for an `IN (…)` list of `n` bound values.
 *
 * Exists so a fixed name list stays a BOUND parameter list instead of being
 * interpolated into the SQL — the values here are build-time constants, but a
 * helper that inlines them is one refactor away from inlining a user string.
 */
export function placeholders(n: number): string {
	return new Array(n).fill("?").join(", ");
}

/**
 * A scope with its repo identity already resolved to a surrogate key.
 *
 * Resolved once per query function rather than inside scopeFilter, because a
 * single page builds a dozen filters and they would otherwise repeat the same
 * lookup. A scope naming a repo the database has never seen resolves to `null`,
 * which deliberately reads as "no rows" rather than "every repo": an unknown
 * repo has no data, and widening to all of them would be a silent lie.
 */
export interface ResolvedScope {
	readonly repoId: number | null;
}

export function scopeToRepoId(db: DashboardDbHandle, scope: DashboardScope): ResolvedScope {
	if (scope.kind !== "repo" || !scope.repoIdentity) return { repoId: null };
	const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(scope.repoIdentity) as
		| { id: number }
		| undefined;
	// -1 matches nothing, which is the honest answer for an unknown repo.
	return { repoId: row?.id ?? -1 };
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
	const filter = scopeFilter(scopeToRepoId(db, scope), "t.repo_id");
	const rows = db
		.prepare(
			`SELECT r.repo_name, ranked.commit_hash, ranked.category
			   FROM (SELECT t.repo_id, t.commit_hash, t.category,
			                COUNT(*) AS n, MIN(t.pos) AS first_pos,
			                ROW_NUMBER() OVER (PARTITION BY t.repo_id, t.commit_hash ORDER BY COUNT(*) DESC, MIN(t.pos) ASC) AS rn
			           FROM memory_topics t
			          WHERE t.category IS NOT NULL${filter.sql}
			          GROUP BY t.repo_id, t.commit_hash, t.category) ranked
			   JOIN repos r ON r.id = ranked.repo_id
			  WHERE ranked.rn = 1`,
		)
		.all(...filter.params) as ReadonlyArray<{ repo_name: string; commit_hash: string; category: string }>;
	return new Map(rows.map((row) => [`${row.repo_name}\0${row.commit_hash}`, row.category]));
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
 */
export function resolveScope(db: DashboardDbHandle, scope: DashboardScope): DashboardScope {
	const token = scope.kind === "repo" ? scope.repoIdentity : undefined;
	if (!token) return scope;
	const rows = db.prepare("SELECT repo_identity, repo_name FROM repos").all() as ReadonlyArray<{
		repo_identity: string;
		repo_name: string;
	}>;
	if (rows.some((row) => row.repo_identity === token)) return scope;
	const byName = rows.filter((row) => row.repo_name === token);
	if (byName.length === 1) return { kind: "repo", repoIdentity: byName[0].repo_identity };
	if (byName.length > 1) {
		log.warn("repo name %s matches %d repos — pass the full identity to disambiguate", token, byName.length);
	}
	return scope;
}
