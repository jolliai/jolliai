import { execGit } from "../GitOps.js";
import { commitSubject, isReachableFromAnyRef } from "./GitReachability.js";

export type PairingResult =
	| { readonly kind: "paired"; readonly newHash: string }
	| { readonly kind: "none" }
	| { readonly kind: "conflict"; readonly candidates: ReadonlyArray<string> };

export interface PairingDeps {
	readonly isReachable?: (hash: string, cwd: string) => Promise<boolean>;
	readonly subjectOf?: (hash: string, cwd: string) => Promise<string | null>;
}

/**
 * `commit (amend)` names the ONE operation whose reflog entry, on its own,
 * identifies what it rewrote: amend acts on HEAD, and HEAD is the entry
 * immediately older. Nothing else has to corroborate it — which matters,
 * because an amend routinely rewords, so demanding a matching subject here
 * would reject the common case.
 */
const AMEND_SUBJECT = /^commit \(amend\):/;

/**
 * `rebase (finish)` is weaker, and the difference is the whole reason this
 * module has two categories. It records a branch moving from its old tip to
 * its new one, which equals a rewrite only when the rebase actually replayed
 * commits. When every local commit is already upstream — the usual
 * `git pull --rebase` after a squash-merge — the rebase drops them all and the
 * branch fast-forwards, so the "new tip" is an unrelated upstream commit while
 * the old tip becomes unreachable and looks exactly like a rewritten one.
 * Measured: a `Fix transcript token stats` tip paired to
 * `chore(actions)(deps): bump actions/setup-java`.
 *
 * A replayed tip keeps its subject (rebase preserves messages, and preserves
 * them through conflict resolution, where a patch-id comparison would not), so
 * an identical subject on both ends is what separates the two cases.
 *
 * Deliberately ABSENT: `checkout`, `reset`, `branch`, `pull`, `merge`,
 * `cherry-pick`, `rebase (start)`, `rebase (abort)`, and the mid-rebase
 * `rebase (squash|fixup|reword)` steps — a squash step's predecessor is the
 * half-built commit, not the original source, so it pairs nothing a caller
 * wants. Every one of these moves a ref without claiming the old commit became
 * the new one.
 */
const REBASE_FINISH_SUBJECT = /^rebase(?: -i)? \(finish\):/;

interface ReflogEntry {
	readonly hash: string;
	readonly subject: string;
}

/** An old→new step git recorded, and whether it stands on its own. */
interface RewriteEdge {
	readonly to: string;
	/** `rebase (finish)` only: both ends must carry the same commit subject. */
	readonly requiresSubjectMatch: boolean;
}

/** Parse `reflog --all` into per-ref, newest-first entry lists. */
function groupByRef(stdout: string): Map<string, ReflogEntry[]> {
	const byRef = new Map<string, ReflogEntry[]>();
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		// `%gs` can hold anything, tabs included in principle, so split on the
		// first two separators only and keep the remainder as the subject.
		const first = line.indexOf("\t");
		if (first < 0) continue;
		const second = line.indexOf("\t", first + 1);
		if (second < 0) continue;
		const selector = line.slice(0, first); // e.g. "main@{2}", "worktrees/x/HEAD@{0}"
		const hash = line.slice(first + 1, second).trim();
		if (!hash) continue;
		const at = selector.lastIndexOf("@{");
		const ref = at >= 0 ? selector.slice(0, at) : selector;
		let entries = byRef.get(ref);
		if (!entries) {
			entries = [];
			byRef.set(ref, entries);
		}
		entries.push({ hash, subject: line.slice(second + 1) });
	}
	return byRef;
}

/**
 * old -> {new} edges, taken ONLY from adjacent pairs whose newer entry declares
 * a rewrite. A hash can have several successors when two refs each recorded a
 * rewrite of it, which is what a genuine `conflict` is made of.
 */
function buildRewriteGraph(byRef: Map<string, ReflogEntry[]>): Map<string, RewriteEdge[]> {
	const edges = new Map<string, RewriteEdge[]>();
	for (const entries of byRef.values()) {
		// Newest-first, so `i - 1` is the entry written immediately AFTER `i`.
		for (let i = 1; i < entries.length; i++) {
			const newer = entries[i - 1] as ReflogEntry;
			const older = entries[i] as ReflogEntry;
			if (newer.hash === older.hash) continue; // no-op rebase, nothing rewritten
			const isAmend = AMEND_SUBJECT.test(newer.subject);
			if (!isAmend && !REBASE_FINISH_SUBJECT.test(newer.subject)) continue;
			const list = edges.get(older.hash);
			const edge: RewriteEdge = { to: newer.hash, requiresSubjectMatch: !isAmend };
			if (list) list.push(edge);
			else edges.set(older.hash, [edge]);
		}
	}
	return edges;
}

/**
 * Which currently-reachable commit did `oldHash` become?
 *
 * Answered from `git reflog --all`, by following the rewrite edges git itself
 * recorded — never by adjacency alone. An entry is a rewrite of its immediate
 * predecessor only when its subject says so, and the two subjects that qualify
 * carry different weight: `AMEND_SUBJECT` stands alone, `REBASE_FINISH_SUBJECT`
 * additionally needs both ends to share a commit subject. Anything else records
 * where a ref went next, which is a different claim entirely — reading it as a
 * pairing is how two separate `chore(deps): bump …` commits ended up carrying
 * other commits' memories, silently and reported as repairs.
 *
 * Reads EVERY ref's reflog, not just HEAD's: an amend/rebase performed in
 * another worktree — or while checked out on a different branch — records the
 * transition in that ref's reflog, which a HEAD-only `reflog show` never sees.
 * `--all` interleaves refs by timestamp, so adjacency in the RAW stream crosses
 * refs; entries are grouped by ref (`%gd` minus its `@{N}` suffix) and the
 * pairing runs WITHIN each ref.
 *
 * Rewrites CHAIN: amending three times leaves the first two hashes unreachable,
 * so the walk follows edges until it lands on a commit some ref still holds.
 * It only ever moves along declared rewrites, so a chain cannot wander off into
 * an unrelated commit the way a scan for "the next reachable entry" does.
 *
 * Two refs recording a rewrite of the same hash into DIFFERENT commits is a
 * `conflict` rather than a guess — the user then supplies `--from/--to`.
 *
 * The reflog is gc'd (90 days by default), is per-clone and does not travel
 * between machines, so `none` is an ordinary outcome, not a fault. It is also
 * the answer for every rewrite git records no adjacency for — a rebase pairs
 * its branch TIP and nothing below it, and `git merge --squash` records nothing
 * at all. Under-pairing is the intended failure direction: an unpaired tree is
 * reported and waits for `--from/--to`, while a wrong pairing grafts one
 * commit's memory onto another and stops being reported at all.
 */
export async function pairStrandedHash(oldHash: string, cwd: string, deps: PairingDeps = {}): Promise<PairingResult> {
	const isReachable = deps.isReachable ?? isReachableFromAnyRef;
	const subjectOf = deps.subjectOf ?? commitSubject;
	const res = await execGit(["reflog", "--all", "--format=%gd%x09%H%x09%gs"], cwd);
	if (res.exitCode !== 0) return { kind: "none" };

	const edges = buildRewriteGraph(groupByRef(res.stdout));
	const subjects = new Map<string, string | null>();
	const subject = async (hash: string): Promise<string | null> => {
		if (!subjects.has(hash)) subjects.set(hash, await subjectOf(hash, cwd));
		return subjects.get(hash) ?? null;
	};

	// Walk the rewrite chain outwards from `oldHash`, stopping each path at the
	// first commit that is still reachable. `seen` both terminates the amend
	// loops a reflog can genuinely contain (`reset` back to an earlier hash, then
	// amend again) and keeps the walk linear.
	const candidates = new Set<string>();
	const seen = new Set<string>([oldHash]);
	const frontier = [oldHash];
	while (frontier.length > 0) {
		const current = frontier.pop() as string;
		for (const edge of edges.get(current) ?? []) {
			if (seen.has(edge.to)) continue;
			seen.add(edge.to);
			if (edge.requiresSubjectMatch) {
				// A subject we cannot read is not corroboration. Dropping the edge
				// costs an unpaired tree; trusting it costs a wrong graft.
				const [from, to] = [await subject(current), await subject(edge.to)];
				if (from === null || to === null || from !== to) continue;
			}
			if (await isReachable(edge.to, cwd)) candidates.add(edge.to);
			else frontier.push(edge.to);
		}
	}

	if (candidates.size === 0) return { kind: "none" };
	if (candidates.size > 1) return { kind: "conflict", candidates: [...candidates] };
	return { kind: "paired", newHash: [...candidates][0] as string };
}
