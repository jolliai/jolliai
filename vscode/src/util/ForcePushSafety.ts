/**
 * ForcePushSafety
 *
 * Pure (vscode-free) divergence inspection used to gate force-push after a
 * non-fast-forward rejection. Kept separate from `ForcePushPrompt` — which owns
 * the vscode modal UI — so non-UI callers (e.g. `JolliMemoryBridge`, which runs
 * under the node test harness without a `vscode` mock) can import the git logic
 * without pulling in `vscode`.
 */

/** Runs a git command (args only — cwd is bound by the caller) and returns stdout. */
export type GitRunner = (args: ReadonlyArray<string>) => Promise<string>;

/**
 * How the local branch and its remote-tracking ref diverge after a
 * non-fast-forward rejection. `remoteOnly` is the count of commits a force-push
 * would permanently drop; `behindOnly` flags the dangerous "I didn't rewrite
 * anything, I'm just behind" case where force-push must NOT be offered.
 */
export interface ForcePushSafety {
	readonly branch: string;
	/** Commits on `origin/<branch>` missing from local HEAD — lost by force-push. */
	readonly remoteOnly: number;
	/** Commits on local HEAD missing from `origin/<branch>`. */
	readonly localOnly: number;
	/**
	 * True when the remote is strictly ahead (`remoteOnly > 0 && localOnly === 0`):
	 * the local branch was not rewritten, it is simply behind. Force-pushing here
	 * would discard collaborator commits, so callers refuse and ask the user to
	 * integrate the remote first.
	 */
	readonly behindOnly: boolean;
}

async function countRevs(
	runGit: GitRunner,
	range: string,
): Promise<number | null> {
	const out = (await runGit(["rev-list", "--count", range])).trim();
	const n = Number.parseInt(out, 10);
	return Number.isNaN(n) ? null : n;
}

/**
 * After a non-fast-forward rejection, refreshes the branch's remote-tracking ref
 * and measures how local and remote diverge, so the caller can tell an actual
 * history rewrite (safe to force-push) apart from a branch that is merely behind
 * a collaborator's new commits (must rebase, never force).
 *
 * The fetch is deliberate: the rejection means the *real* remote has commits the
 * local branch lacks, but the local `origin/<branch>` ref may be stale, so the
 * counts would be wrong without first observing the true remote.
 *
 * Returns null when the comparison can't be made (detached HEAD, no remote-tracking
 * ref, git/network error) — the caller then falls back to its existing
 * confirm-then-force behavior rather than block a legitimate force-push on an
 * inconclusive probe.
 */
export async function inspectForcePushSafety(
	runGit: GitRunner,
	branch: string,
): Promise<ForcePushSafety | null> {
	if (!branch || branch === "HEAD") {
		return null;
	}
	const remoteRef = `origin/${branch}`;
	try {
		// Refresh just this branch's tracking ref so the counts reflect the true
		// remote. A failure here (network, no such remote branch) falls through to
		// the catch and yields null → caller keeps its prior behavior.
		await runGit(["fetch", "origin", branch]);
		const remoteOnly = await countRevs(runGit, `HEAD..${remoteRef}`);
		const localOnly = await countRevs(runGit, `${remoteRef}..HEAD`);
		if (remoteOnly === null || localOnly === null) {
			return null;
		}
		return {
			branch,
			remoteOnly,
			localOnly,
			behindOnly: remoteOnly > 0 && localOnly === 0,
		};
	} catch {
		return null;
	}
}
