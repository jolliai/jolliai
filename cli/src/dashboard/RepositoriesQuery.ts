/**
 * RepositoriesQuery — the Repositories page's repo list, joining the durable
 * registry (`dashboard-repos.json`, which repos exist and whether each is
 * enabled — the read model's own `repos` table only ever mirrors it) against
 * this machine's SQLite for memory/session counts.
 *
 * Reads the registry file directly (async), unlike every other `build*`
 * function in this directory: `DashboardServer.ts`'s model builder does this
 * read *before* calling the synchronous `buildDashboardModel`, the same
 * pattern already used for `envFacts`/`hooks` on the Settings view.
 */

import type { DashboardDbHandle } from "./DashboardDb.js";
import type { RepositoriesModel, RepositoryRow } from "./DashboardModel.js";
import { isReachable, type ReachableCommits } from "./MemoriesQuery.js";
import { type RegisteredRepo, readRepoRegistry } from "./RepoRegistry.js";

/** The setup card's "what gets installed" manifest — shared by Repositories and Settings → Hooks. */
export const HOOKS_MANIFEST: ReadonlyArray<{ readonly title: string; readonly detail: string }> = [
	{ title: "Git hooks", detail: "post-commit, post-rewrite, prepare-commit-msg" },
	{ title: "Agent hooks", detail: "so your AI session is recorded alongside the commit" },
	{ title: "MCP server", detail: "lets your agent query memory mid-chat" },
	{ title: "Memory branch", detail: "an orphan branch in this repo, so memories travel with it" },
];

interface SessionCountsRow {
	readonly repo_identity: string;
	readonly sessions: number;
}

interface RootMemoryRow {
	readonly repo_identity: string;
	readonly commit_hash: string;
}

function readCounts(
	db: DashboardDbHandle,
	reachable: ReachableCommits | undefined,
): Map<string, { memories: number; sessions: number }> {
	const counts = new Map<string, { memories: number; sessions: number }>();
	const sessionRows = db
		.prepare(
			// Counted live off the detail table, over its repo_id index. `sessions`
			// used to read a stored aggregate that the projection path maintained
			// for this one query; counting it here removed that whole write path,
			// and with it the window where a prune left the aggregate describing
			// rows it had just deleted. This page lists a handful of repos.
			`SELECT r.repo_identity,
			        (SELECT COUNT(*) FROM sessions s WHERE s.repo_id = r.id) AS sessions
			   FROM repos r`,
		)
		.all() as ReadonlyArray<SessionCountsRow>;
	for (const row of sessionRows) counts.set(row.repo_identity, { memories: 0, sessions: row.sessions });

	// Memories are counted by the SAME two rules the Memories browser applies —
	// keep the pair in step, or the badge and the tree report different totals
	// for one repo (they did: the badge read ~2.5x high on a machine whose
	// branches had been rebased away).
	//
	// (1) `parent_hash IS NULL` counts MEMORIES, not memory ROWS: `memories` is
	// a tree (amend/squash/rebase file the follow-up under the original as a
	// child — see SotSchema's root_hash/depth), so a plain COUNT(*) inflates
	// every repo by its rewrite history.
	//
	// (2) git reachability drops roots no local branch can still reach. That
	// cannot be expressed in SQL, so — exactly like `buildMemoriesList` — the
	// hashes are fetched and filtered here rather than COUNTed. The row set is
	// one machine's root memories, not the whole `memories` tree. `reachable`
	// is undefined for callers that did not pay for the `git rev-list` (and
	// `isReachable` fails open per repo), which restores the old raw count.
	const rootRows = db
		.prepare(
			`SELECT r.repo_identity, m.commit_hash
			   FROM memories m
			   JOIN repos r ON r.id = m.repo_id
			  WHERE m.parent_hash IS NULL`,
		)
		.all() as ReadonlyArray<RootMemoryRow>;
	for (const row of rootRows) {
		if (!isReachable(reachable, row.repo_identity, row.commit_hash)) continue;
		const entry = counts.get(row.repo_identity);
		if (entry) entry.memories += 1;
		else counts.set(row.repo_identity, { memories: 1, sessions: 0 });
	}
	return counts;
}

function toRow(repo: RegisteredRepo, counts: Map<string, { memories: number; sessions: number }>): RepositoryRow {
	const c = counts.get(repo.repoIdentity) ?? { memories: 0, sessions: 0 };
	return {
		repoIdentity: repo.repoIdentity,
		repoName: repo.repoName,
		worktreeRoot: repo.worktreeRoot,
		remoteUrl: repo.remoteUrl,
		enabled: !repo.disabledAt,
		memories: c.memories,
		sessions: c.sessions,
	};
}

export async function buildRepositoriesModel(
	db: DashboardDbHandle,
	configDir?: string,
	reachable?: ReachableCommits,
): Promise<RepositoriesModel> {
	const registry = await readRepoRegistry(configDir);
	const counts = readCounts(db, reachable);
	return {
		repos: registry.repos.map((repo) => toRow(repo, counts)),
		hooksManifest: HOOKS_MANIFEST,
	};
}
