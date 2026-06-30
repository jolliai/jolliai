/**
 * CommitTargetIndex — the set of real code commits a back-fill attribution may
 * point at, plus a file→commits index for file-orthogonality anchoring.
 *
 * Built from `git log` over all refs EXCEPT the jolli orphan summaries branch.
 * Two classes of commit are excluded because they are never valid attribution
 * targets and would pollute matching (both observed in real history):
 *   1. jolli's own "Add summary for <hash>: <msg>" bookkeeping commits — they
 *      echo the original commit message and would steal message/file matches.
 *   2. Commits whose entire diff is orphan-branch bookkeeping
 *      (summaries/ transcripts/ plans/ notes/ catalog.json / index.json).
 *
 * Anchoring contract: an edit of file F at time t belongs to the *earliest
 * commit that touches F at or after t* (within a horizon). `fileToCommits` is
 * therefore sorted by commit time ascending so the attributor can binary-walk
 * to that commit. History rewrites (squash/rebase) mean the original commit may
 * be gone; pointing at the current commit that now carries F is exactly right.
 */

import { execGit } from "../core/GitOps.js";
import { toForwardSlash } from "../core/PathUtils.js";
import { createLogger, ORPHAN_BRANCH } from "../Logger.js";

const log = createLogger("CommitTargetIndex");

/** Commit time (epoch ms) + hash, used as a file→commit anchor candidate. */
export interface CommitRef {
	readonly ts: number;
	readonly hash: string;
}

export interface CommitTargetIndex {
	/**
	 * hash → { ts (epoch ms), subject, branch? } for every real code commit.
	 * `branch` is the short name of the ref the commit was reached from in the
	 * `--all` traversal (via `git log --source` / `%S`); used by the MEDIUM
	 * time-window attribution to reject a candidate on a different branch than
	 * the conversation segment. Absent when the source ref isn't a branch.
	 */
	readonly commitMeta: ReadonlyMap<string, { ts: number; subject: string; branch?: string }>;
	/** repo-relative forward-slash path → commits touching it, sorted by ts asc. */
	readonly fileToCommits: ReadonlyMap<string, ReadonlyArray<CommitRef>>;
	/** basename → commits touching a file with that basename, sorted by ts asc. */
	readonly baseToCommits: ReadonlyMap<string, ReadonlyArray<CommitRef>>;
}

const ORPHAN_PREFIXES = ["summaries/", "transcripts/", "plans/", "plan-progress/", "notes/", "linear-issues/"];
const ORPHAN_BOOKKEEPING_FILES = new Set(["catalog.json", "index.json"]);

function isOrphanPath(p: string): boolean {
	return ORPHAN_BOOKKEEPING_FILES.has(p) || ORPHAN_PREFIXES.some((pre) => p.startsWith(pre));
}

function basename(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Reduces a `%S` source ref to a short branch name for matching against the
 * transcript's `gitBranch`: `refs/heads/feat-x` → `feat-x`,
 * `refs/remotes/origin/feat-x` → `feat-x`. Returns undefined for non-branch refs
 * (tags, HEAD, etc.) so the MEDIUM gate simply doesn't constrain on them.
 */
export function shortBranch(ref: string): string | undefined {
	if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
	if (ref.startsWith("refs/remotes/")) {
		const rest = ref.slice("refs/remotes/".length);
		const slash = rest.indexOf("/"); // drop the remote name segment
		return slash >= 0 ? rest.slice(slash + 1) : undefined;
	}
	return undefined;
}

function pushRef(map: Map<string, CommitRef[]>, key: string, ref: CommitRef): void {
	const list = map.get(key);
	if (list) list.push(ref);
	else map.set(key, [ref]);
}

/** Returns true when the orphan summaries branch exists (so `--not` is safe). */
async function orphanRefExists(cwd: string): Promise<boolean> {
	const res = await execGit(["rev-parse", "--verify", "--quiet", `${ORPHAN_BRANCH}^{commit}`], cwd);
	return res.exitCode === 0;
}

/**
 * Builds the {@link CommitTargetIndex} for the repo at `cwd`.
 *
 * Uses one `git log --all --name-only` pass with NUL-free record markers. The
 * orphan branch is excluded via `--not` only when it actually exists.
 */
export async function buildCommitTargetIndex(cwd: string): Promise<CommitTargetIndex> {
	const args = ["log", "--all", "--source"];
	if (await orphanRefExists(cwd)) {
		args.push("--not", ORPHAN_BRANCH);
	}
	// @@ record marker keeps parsing simple; %ct is author-independent commit time;
	// %S (needs --source) is the ref the commit was reached from → its branch.
	args.push("--name-only", "--pretty=format:@@%H|%ct|%S|%s");

	const res = await execGit(args, cwd);
	if (res.exitCode !== 0) {
		log.warn("git log failed building target index: %s", res.stderr.substring(0, 200));
		return { commitMeta: new Map(), fileToCommits: new Map(), baseToCommits: new Map() };
	}

	const commitMeta = new Map<string, { ts: number; subject: string; branch?: string }>();
	const fileToCommits = new Map<string, CommitRef[]>();
	const baseToCommits = new Map<string, CommitRef[]>();

	let curHash: string | null = null;
	let curTs = 0;
	let curFiles: string[] = [];
	let curSubject = "";
	let curBranch: string | undefined;

	const flush = (): void => {
		if (!curHash) return;
		const real = curFiles.filter((f) => !isOrphanPath(f));
		// Skip jolli bookkeeping commits and orphan-only commits — never targets.
		if (!curSubject.startsWith("Add summary for") && real.length > 0) {
			commitMeta.set(curHash, { ts: curTs, subject: curSubject, ...(curBranch ? { branch: curBranch } : {}) });
			const ref: CommitRef = { ts: curTs, hash: curHash };
			for (const f of real) {
				pushRef(fileToCommits, f, ref);
				pushRef(baseToCommits, basename(f), ref);
			}
		}
		curHash = null;
		curFiles = [];
		curBranch = undefined;
	};

	for (const rawLine of res.stdout.split("\n")) {
		const line = rawLine.trimEnd();
		if (line.startsWith("@@")) {
			flush();
			const body = line.slice(2);
			const sep1 = body.indexOf("|");
			const sep2 = body.indexOf("|", sep1 + 1);
			const sep3 = body.indexOf("|", sep2 + 1);
			if (sep1 < 0 || sep2 < 0 || sep3 < 0) continue;
			curHash = body.slice(0, sep1);
			curTs = Number.parseInt(body.slice(sep1 + 1, sep2), 10) * 1000;
			curBranch = shortBranch(body.slice(sep2 + 1, sep3));
			curSubject = body.slice(sep3 + 1);
		} else if (line.length > 0 && curHash) {
			curFiles.push(toForwardSlash(line));
		}
	}
	flush();

	for (const list of fileToCommits.values()) list.sort((a, b) => a.ts - b.ts);
	for (const list of baseToCommits.values()) list.sort((a, b) => a.ts - b.ts);

	log.info("Target index: %d commits, %d files", commitMeta.size, fileToCommits.size);
	return { commitMeta, fileToCommits, baseToCommits };
}

const ANCHOR_SKEW_MS = 60_000; // allow a commit up to 60s before the edit (clock skew)
const ANCHOR_HORIZON_MS = 21 * 24 * 60 * 60 * 1000; // 21 days

/**
 * Resolves the commit an edit of `rel` (basename fallback `base`) at epoch-ms
 * `editMs` belongs to: the earliest commit touching that file at or after the
 * edit time (minus skew), within the horizon. Returns null when no such commit
 * exists (file never committed, or only committed long after / before).
 */
export function anchorCommitForEdit(
	index: CommitTargetIndex,
	rel: string,
	base: string,
	editMs: number,
): string | null {
	if (Number.isNaN(editMs)) return null;
	const candidates = index.fileToCommits.get(rel) ?? index.baseToCommits.get(base);
	if (!candidates) return null;
	const lower = editMs - ANCHOR_SKEW_MS;
	for (const c of candidates) {
		if (c.ts >= lower && c.ts - editMs <= ANCHOR_HORIZON_MS) return c.hash;
	}
	return null;
}
