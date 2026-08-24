/**
 * Global-daemon task that keeps `memories.reachable` current, so the coaching
 * and memories feeds never run `git rev-list --branches` on the read path.
 *
 * The dashboard backfill sweep already marks reachability when it runs, but that
 * only fires when someone opens the dashboard or runs `jolli enable`. Reachability
 * also drifts through operations that produce no commit and therefore no git hook
 * — `git reset --hard`, `git branch -f`, a branch deletion, a force-fetched
 * vendored repo — so a machine-level timer is what keeps the flag honest for a
 * machine whose dashboard is never opened. Staleness between ticks is the
 * accepted, documented cost (see {@link MEMORY_REACHABLE_DDL}); the feeds fail
 * toward "visible", never toward hiding a just-made memory.
 */

import { existingWorktrees, listActiveRepos } from "../dashboard/RepoRegistry.js";
import { createLogger, errMsg } from "../Logger.js";
import type { DaemonTask } from "./TaskScheduler.js";

const log = createLogger("ReachabilityReconcile");

/** Rare ref-only rewrites are the only thing this catches, so minutes is plenty. */
export const REACHABILITY_RECONCILE_TICK_MS = 5 * 60 * 1000;

export const REACHABILITY_RECONCILE_TASK_NAME = "reachability-reconcile";

/**
 * `tickIntervalMs` is injectable so a test can drive a tick without waiting; the
 * git and DB dependencies are lazily imported inside `run` for the same reason
 * the other tasks defer theirs — a daemon that never ticks this pays for none of
 * it, and the DB stack is heavy.
 */
export function reachabilityReconcileTask(tickIntervalMs: number = REACHABILITY_RECONCILE_TICK_MS): DaemonTask {
	// Branch-tip signature per repo, last APPLIED to the DB, kept in process across
	// ticks. Reachability is a pure function of the branch tips (`rev-list --branches`
	// walks exactly those), so identical tips guarantee an identical reachable set and
	// there is nothing to re-apply — the expensive `rev-list` and the full-table mark
	// are skipped for an idle repo, which is the overwhelmingly common case between the
	// rare ref-only rewrites this task exists to catch. A moved/added/removed tip, a
	// worktree that becomes readable, or the repo dropping out all change the signature
	// and force the full path. This lives in the closure, not the scheduler (which holds
	// no persistent state) — it is lost on restart, where the first tick per repo runs
	// in full, exactly the warm-up we want. A repo git could not answer for is never
	// cached, so it is retried every tick until it recovers.
	const lastSignature = new Map<string, string>();

	const run = async (): Promise<string> => {
		const { listBranchTips, listReachableCommits } = await import("../core/GitOps.js");
		const repos = await listActiveRepos();
		if (repos.length === 0) {
			lastSignature.clear();
			return "no active repos";
		}
		// Forget repos no longer registered, so a de-registered-then-re-registered repo
		// re-runs rather than matching a stale signature.
		const liveIdentities = new Set(repos.map((repo) => repo.repoIdentity));
		for (const identity of [...lastSignature.keys()]) {
			if (!liveIdentities.has(identity)) lastSignature.delete(identity);
		}

		// Compute each repo's reachable set FIRST (git, no DB lock held), then apply
		// under one writable open. The union across a repo's worktrees mirrors the
		// prune's union: a commit only a sibling checkout reaches is still reachable,
		// and marking it unreachable here would flip it back on the next tick.
		const marks: Array<{ repoIdentity: string; signature: string; reachable: ReadonlySet<string> }> = [];
		let skipped = 0;
		for (const repo of repos) {
			const worktrees = existingWorktrees(repo);
			// Cheap gate: read only the branch tips (a ref read) before the O(history)
			// rev-list. A per-worktree signature so a change in any checkout is seen; a
			// null (unreadable) tip read is folded in as `?` so a recovering worktree
			// differs from a readable one. `\x00`/`\x01` separate path from tips and one
			// worktree from the next — bytes a filesystem path and a git OID cannot hold.
			const perWorktree = await Promise.all(
				worktrees.map(async (worktree) => {
					const tips = (await listBranchTips(worktree)) ?? ["?"];
					return `${worktree}\x00${tips.join(",")}`;
				}),
			);
			const signature = perWorktree.join("\x01");
			if (lastSignature.get(repo.repoIdentity) === signature) {
				skipped++;
				continue;
			}

			const union = new Set<string>();
			let anyReadable = false;
			for (const worktree of worktrees) {
				const hashes = await listReachableCommits(worktree);
				if (hashes) {
					anyReadable = true;
					for (const hash of hashes) union.add(hash);
				}
			}
			// A repo git could not answer for AT ALL is skipped, never marked: an
			// empty set would mark every one of its memories unreachable and hide
			// them all — the exact failure the read-path fail-open existed to avoid.
			// Leaving the flags as they are keeps the last good answer until git
			// recovers. It is deliberately NOT cached, so the next tick retries it.
			if (anyReadable) marks.push({ repoIdentity: repo.repoIdentity, signature, reachable: union });
		}
		if (marks.length === 0) {
			return skipped > 0 ? `up to date (${skipped} repo(s) unchanged)` : "no repos readable";
		}

		const { withDashboardDb } = await import("../dashboard/DashboardDb.js");
		const { markCommitsReachability, markMemoriesReachability } = await import("../dashboard/DbBackfill.js");
		let flips = 0;
		await withDashboardDb((db) => {
			for (const mark of marks) {
				// Both tiers, from the one git set: the memory feeds filter
				// `memories.reachable`, stats/standup filter `commits.reachable`.
				flips += markMemoriesReachability(db, mark.repoIdentity, mark.reachable);
				flips += markCommitsReachability(db, mark.repoIdentity, mark.reachable);
			}
		});
		// Only record the signature once its marks have landed: a throw above leaves the
		// cache untouched so the next tick re-applies rather than skipping unwritten work.
		for (const mark of marks) lastSignature.set(mark.repoIdentity, mark.signature);
		const tail = skipped > 0 ? `, ${skipped} unchanged` : "";
		return `reconciled ${marks.length} repo(s), ${flips} flip(s)${tail}`;
	};

	return {
		name: REACHABILITY_RECONCILE_TASK_NAME,
		tickIntervalMs,
		run: async (): Promise<string> => {
			try {
				return await run();
			} catch (err) {
				// A reconcile failure is never fatal — the flag simply stays at its last
				// value and the next tick retries. Report it rather than throwing so the
				// scheduler keeps ticking the other tasks.
				log.warn("reconcile failed: %s", errMsg(err));
				return `failed: ${errMsg(err)}`;
			}
		},
	};
}
