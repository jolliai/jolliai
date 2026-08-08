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
import { type RegisteredRepo, readRepoRegistry } from "./RepoRegistry.js";

/** The setup card's "what gets installed" manifest — shared by Repositories and Settings → Hooks. */
export const HOOKS_MANIFEST: ReadonlyArray<{ readonly title: string; readonly detail: string }> = [
	{ title: "Git hooks", detail: "post-commit, post-rewrite, prepare-commit-msg" },
	{ title: "Agent hooks", detail: "so your AI session is recorded alongside the commit" },
	{ title: "MCP server", detail: "lets your agent query memory mid-chat" },
	{ title: "Memory branch", detail: "an orphan branch in this repo, so memories travel with it" },
];

interface CountsRow {
	readonly repo_identity: string;
	readonly memories: number;
	readonly sessions: number;
}

function readCounts(db: DashboardDbHandle): Map<string, { memories: number; sessions: number }> {
	const rows = db
		.prepare(
			// Both counted live off the detail tables, over their repo_id indexes.
			// `sessions` used to read a stored aggregate that the projection path
			// maintained for this one query; counting it here the same way memories
			// were already counted removed that whole write path, and with it the
			// window where a prune left the aggregate describing rows it had just
			// deleted. This page lists a handful of repos — two indexed COUNTs.
			//
			// `parent_hash IS NULL` counts MEMORIES, not memory ROWS: `memories` is
			// a tree (amend/squash/rebase file the follow-up under the original as a
			// child — see SotSchema's root_hash/depth), so a plain COUNT(*) inflated
			// every repo by its rewrite history and disagreed with the Memories
			// browser, which lists roots only (`buildMemoriesList`). Keep the two
			// predicates in step. The browser additionally drops roots no local
			// branch can still reach, which needs a `git rev-list` per repo and so
			// is not reproduced here — this count can therefore still read high for
			// a repo whose history was rewritten away.
			`SELECT r.repo_identity,
			        (SELECT COUNT(*) FROM memories m WHERE m.repo_id = r.id AND m.parent_hash IS NULL) AS memories,
			        (SELECT COUNT(*) FROM sessions s WHERE s.repo_id = r.id) AS sessions
			   FROM repos r`,
		)
		.all() as ReadonlyArray<CountsRow>;
	return new Map(rows.map((row) => [row.repo_identity, { memories: row.memories, sessions: row.sessions }]));
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

export async function buildRepositoriesModel(db: DashboardDbHandle, configDir?: string): Promise<RepositoriesModel> {
	const registry = await readRepoRegistry(configDir);
	const counts = readCounts(db);
	return {
		repos: registry.repos.map((repo) => toRow(repo, counts)),
		hooksManifest: HOOKS_MANIFEST,
	};
}
