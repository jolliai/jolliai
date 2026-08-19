import { execGit } from "../GitOps.js";

/**
 * Is `hash` reachable from ANY ref in this repository?
 *
 * "Any ref", never "HEAD's history": a memory root that lives on another
 * branch is healthy, and a HEAD-based predicate would report every other
 * branch's roots as stranded the moment the user switches branches.
 *
 * An object git does not have (gc'd, or a hash from another clone) is
 * unreachable rather than an error — the caller's next question is whether a
 * repair target exists, and a missing object answers that the same way.
 */
export async function isReachableFromAnyRef(hash: string, cwd: string): Promise<boolean> {
	const exists = await execGit(["cat-file", "-e", `${hash}^{commit}`], cwd);
	if (exists.exitCode !== 0) return false;
	const res = await execGit(["for-each-ref", "--contains", hash, "--count=1", "--format=%(refname)"], cwd);
	if (res.exitCode !== 0) return false;
	return res.stdout.trim().length > 0;
}

/**
 * Every commit reachable from any ref in this repository, as a set of full
 * SHAs. One `git rev-list --all` answers reachability for ALL roots at once —
 * the batch form of {@link isReachableFromAnyRef}, for callers (`findStrandedRoots`)
 * that would otherwise spawn two git processes per root. Membership is the exact
 * predicate `isReachableFromAnyRef` computes: a hash absent from the set is
 * unreachable, whether because it was rewritten away or git never had it.
 *
 * `--all` walks branches, tags and remotes (everything under `refs/`) plus HEAD,
 * matching `for-each-ref`'s ref set. An empty repository yields an empty set.
 */
export async function listReachableCommits(cwd: string): Promise<Set<string>> {
	const res = await execGit(["rev-list", "--all"], cwd);
	if (res.exitCode !== 0) return new Set();
	return new Set(
		res.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
	);
}

/**
 * The full SHA `ref` names in this repository, or `null` when git cannot
 * resolve it to a commit.
 *
 * `--from` is prefix-matched against the stranded set, so `--to` looks
 * abbreviated too — and the tool's own output invites it, printing 8-character
 * hashes everywhere. Nothing downstream normalises it: a `summaries/<hash>.json`
 * probe against an abbreviation misses, so the plan picks `migrate` for a target
 * that already has a memory, `migrateOneToOne`'s idempotency guard then sees the
 * FULL hash already in the index, logs "skipping migration" and returns, and the
 * command reports a success that wrote nothing.
 *
 * `--verify` (plus `^{commit}`) is what makes an ambiguous prefix a refusal
 * rather than a guess, which is the spec's rule for a target: never guess one.
 */
export async function resolveCommitHash(ref: string, cwd: string): Promise<string | null> {
	const res = await execGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], cwd);
	if (res.exitCode !== 0) return null;
	const hash = res.stdout.trim();
	return hash.length > 0 ? hash : null;
}

/**
 * The subject line (`%s`) of `hash`, or `null` when the object is gone or is
 * not a commit.
 *
 * Two callers, one of which is load-bearing rather than cosmetic. Pairing uses
 * it to corroborate a `rebase (finish)` edge, and `--status` prints it beside
 * every hash so the user can review a proposed pairing before it is written —
 * `Fix transcript token stats` grafted onto `chore(deps): bump …` is obvious at
 * a glance and invisible as two hashes.
 */
export async function commitSubject(hash: string, cwd: string): Promise<string | null> {
	const res = await execGit(["log", "-1", "--format=%s", `${hash}^{commit}`], cwd);
	if (res.exitCode !== 0) return null;
	const subject = res.stdout.trim();
	return subject.length > 0 ? subject : null;
}
