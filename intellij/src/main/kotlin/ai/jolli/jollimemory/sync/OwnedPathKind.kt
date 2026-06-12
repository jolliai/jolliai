package ai.jolli.jollimemory.sync

/**
 * Tagged enum identifying which vault path family a relative path belongs to.
 *
 * Port of `cli/src/sync/OwnedPathKind.ts`.
 *
 * Drives sync's allowlist staging: [stageVault] filters `git status` output
 * through [classifyVaultPath] and stages only entries whose kind is non-null.
 */
enum class OwnedPathKind {
	// Root-level
	ROOT_GITIGNORE,
	ROOT_REPOS,

	// Per-repo aggregates (under <repoFolder>/.jolli/)
	REPO_CONFIG,
	REPO_INDEX,
	REPO_MANIFEST,
	REPO_BRANCHES,
	REPO_CATALOG,
	REPO_MIGRATION,

	// Per-repo content
	SUMMARY,
	TRANSCRIPT,
	PLAN,
	PLAN_PROGRESS,
	NOTE,

	// Per-repo visible markdown (under <repoFolder>/<branch>/)
	VISIBLE_SUMMARY,
	VISIBLE_PLAN,
	VISIBLE_NOTE,

	// Catch-all for safe paths that don't match a specific catalogue shape
	USER_CONTENT,
}
