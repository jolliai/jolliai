/**
 * Enumerates the commit hashes on the current branch since its merge-base with
 * main — the exact commit SET the VS Code extension uses for PR aggregation
 * (`JolliMemoryBridge.listBranchCommits`), minus the WebView-only metadata
 * (push status, diff stats, tree-hash aliases). Hashes are returned
 * newest-first; the PR loader reverses them to chronological order.
 *
 * Base resolution prefers remote mainline refs (origin/upstream) over a stale
 * local main. When the branch is fully merged (merge-base == HEAD) it switches
 * to "merged mode": reflog creation point + `--author` filter, mirroring the
 * extension's read-only post-merge history view.
 */

import { execGit } from "./GitOps.js";

async function git(cwd: string, args: ReadonlyArray<string>): Promise<string> {
	const r = await execGit(args, cwd);
	return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
	return (await git(cwd, ["rev-parse", "--verify", "--quiet", ref])).length > 0;
}

async function resolveHistoryBaseRef(cwd: string, mainBranch: string): Promise<string> {
	const candidates = [`origin/${mainBranch}`, `upstream/${mainBranch}`, mainBranch].filter((r) => r.length > 0);
	for (const ref of candidates) {
		if (await refExists(cwd, ref)) return ref;
	}
	/* v8 ignore start — mainBranch is always in candidates, so the loop returns first */
	return mainBranch;
	/* v8 ignore stop */
}

async function findBranchCreationPoint(cwd: string, branch: string): Promise<string | undefined> {
	const reflog = await git(cwd, ["reflog", "show", branch, "--format=%H %gs"]);
	if (!reflog) return undefined;
	const lines = reflog.split("\n").filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes("branch: Created from")) return lines[i].split(" ")[0];
	}
	/* v8 ignore start — defensive fallback: reflog exists but has no "Created from" entry */
	const oldest = lines[lines.length - 1];
	return oldest.split(" ")[0];
	/* v8 ignore stop */
}

export async function listBranchCommitHashes(
	cwd: string,
	mainBranch: string,
): Promise<{ hashes: ReadonlyArray<string>; isMerged: boolean }> {
	const empty = { hashes: [] as ReadonlyArray<string>, isMerged: false };

	const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) || "HEAD";
	const baseRef = await resolveHistoryBaseRef(cwd, mainBranch);
	const headHash = await git(cwd, ["rev-parse", "HEAD"]);

	let mergeBase = await git(cwd, ["merge-base", "HEAD", baseRef]);
	if (!mergeBase) return empty;

	let isMerged = false;
	let authorFilter: string | undefined;
	if (mergeBase === headHash) {
		const creationPoint = await findBranchCreationPoint(cwd, branch);
		if (!creationPoint) return empty;
		authorFilter = await git(cwd, ["config", "user.name"]);
		if (!authorFilter) return empty;
		mergeBase = creationPoint;
		isMerged = true;
	}

	const logArgs = ["log", `${mergeBase}..HEAD`, "--pretty=format:%H%x00%s%x00%an%x00%ae%x00%aI%x00%x00"];
	// `--author` is matched as a regex by default, so a `user.name` containing
	// regex metacharacters (`J. Doe (Acme)`) would either error or match the
	// wrong commits. `--fixed-strings` makes it a literal substring match —
	// preserving the extension's substring semantics without the regex hazard.
	// NB: `--fixed-strings` is global; it stays safe only while `--author` is
	// the sole pattern operand here (no `--grep`).
	if (authorFilter) logArgs.push(`--author=${authorFilter}`, "--fixed-strings");

	const logOutput = await git(cwd, logArgs);
	if (!logOutput) return { hashes: [], isMerged: false };

	const hashes = logOutput
		.split("\0\0")
		.map((e) => e.replace(/^\n/, ""))
		.filter((e) => e.trim().length > 0)
		.map((entry) => entry.split("\0"))
		.filter((parts) => parts.length >= 5)
		.map((parts) => parts[0]);

	return { hashes, isMerged };
}
