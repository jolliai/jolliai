import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execGit } from "../GitOps.js";
import { pairStrandedHash } from "./ReflogPairing.js";

async function commit(dir: string, message: string): Promise<string> {
	await execGit(["commit", "--allow-empty", "-m", message], dir);
	return (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();
}

/** Stage real content, for the one case that needs a patch git can match. */
async function write(dir: string, name: string, content: string): Promise<void> {
	await writeFile(join(dir, name), `${content}\n`, "utf8");
	await execGit(["add", "-A"], dir);
}

describe("pairStrandedHash", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "jolli-pair-"));
		await execGit(["init", "-b", "main"], dir);
		await execGit(["config", "user.email", "t@example.com"], dir);
		await execGit(["config", "user.name", "T"], dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("pairs an amended-away hash to the amended commit", async () => {
		await commit(dir, "base");
		const old = await commit(dir, "work");
		await execGit(["commit", "--allow-empty", "--amend", "-m", "work amended"], dir);
		const head = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();

		expect(await pairStrandedHash(old, dir)).toEqual({ kind: "paired", newHash: head });
	});

	it("pairs through a chain of several amends to the final commit", async () => {
		await commit(dir, "base");
		const first = await commit(dir, "work");
		await execGit(["commit", "--allow-empty", "--amend", "-m", "v2"], dir);
		await execGit(["commit", "--allow-empty", "--amend", "-m", "v3"], dir);
		const head = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();

		expect(await pairStrandedHash(first, dir)).toEqual({ kind: "paired", newHash: head });
	});

	it("returns none for a hash the reflog never saw", async () => {
		await commit(dir, "base");
		expect(await pairStrandedHash("0".repeat(40), dir)).toEqual({ kind: "none" });
	});

	it("pairs to the rewritten commit, not to wherever HEAD happens to be now", async () => {
		await commit(dir, "base");
		const stranded = await commit(dir, "work");
		await execGit(["commit", "--allow-empty", "--amend", "-m", "work v2"], dir);
		const rewritten = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();
		await execGit(["checkout", "-b", "side"], dir);
		const head = await commit(dir, "side work");

		expect(await pairStrandedHash(stranded, dir)).toEqual({
			kind: "paired",
			newHash: rewritten,
		});
		expect(rewritten).not.toBe(head);
	});

	it("pairs a rewrite performed in ANOTHER worktree, whose reflog this worktree's HEAD never saw", async () => {
		// The cross-worktree gap: the amend happens in a linked worktree, so the
		// old->new transition lands in that branch's reflog, never in THIS
		// worktree's HEAD reflog. A HEAD-only `reflog show` returns `none`; only
		// `reflog --all` (grouped per ref) can find it.
		await commit(dir, "base");
		const wt = await mkdtemp(join(tmpdir(), "jolli-pair-wt-"));
		try {
			await execGit(["worktree", "add", wt, "-b", "feature"], dir);
			const old = await commit(wt, "work");
			await execGit(["commit", "--allow-empty", "--amend", "-m", "work amended"], wt);
			const head = (await execGit(["rev-parse", "HEAD"], wt)).stdout.trim();

			// Queried from the MAIN worktree, whose HEAD never moved off base.
			expect(await pairStrandedHash(old, dir)).toEqual({ kind: "paired", newHash: head });
		} finally {
			await execGit(["worktree", "remove", "--force", wt], dir).catch(() => {});
			await rm(wt, { recursive: true, force: true });
		}
	});

	it("reports a conflict when one hash is amended into two different commits", async () => {
		// Two rewrites of the SAME commit, each recorded by its own ref: `main`
		// amends x into t1, then `side` (branched off x before the amend) amends x
		// into t2. Both targets are reachable, so neither can be preferred.
		await commit(dir, "base");
		const x = await commit(dir, "x");
		await execGit(["branch", "side"], dir);
		await execGit(["commit", "--allow-empty", "--amend", "-m", "x on main"], dir);
		const t1 = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();
		await execGit(["checkout", "side"], dir);
		await execGit(["commit", "--allow-empty", "--amend", "-m", "x on side"], dir);
		const t2 = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();

		const result = await pairStrandedHash(x, dir);

		expect(result.kind).toBe("conflict");
		expect([...(result as { candidates: ReadonlyArray<string> }).candidates].sort()).toEqual([t1, t2].sort());
	});

	it("pairs a rebased-away branch tip through the rebase (finish) entry", async () => {
		// A rebase records its result as `rebase (finish)`, whose immediately-older
		// entry is the pre-rebase tip. That is the only adjacency a rebase offers,
		// and it is the one the stranded ROOT needs.
		const base = await commit(dir, "base");
		await execGit(["checkout", "-b", "feature"], dir);
		const old = await commit(dir, "feature work");
		await execGit(["checkout", "main"], dir);
		await commit(dir, "main moves on");
		await execGit(["checkout", "feature"], dir);
		await execGit(["rebase", "main"], dir);
		const rebased = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();

		expect(rebased).not.toBe(old);
		expect(base).not.toBe(old);
		expect(await pairStrandedHash(old, dir)).toEqual({ kind: "paired", newHash: rebased });
	});

	it("does not pair a hash HEAD merely moved away from", async () => {
		// The defect this rule exists to remove: `checkout` and `reset` record where
		// HEAD went next, which is not a claim about what a commit became. Both
		// leave `abandoned` unreachable with a reachable neighbour one entry newer.
		await commit(dir, "base");
		await execGit(["checkout", "-b", "scratch"], dir);
		const abandoned = await commit(dir, "scratch work");
		await execGit(["checkout", "main"], dir);
		await execGit(["branch", "-D", "scratch"], dir);
		const unrelated = await commit(dir, "unrelated work");

		expect(await pairStrandedHash(abandoned, dir)).toEqual({ kind: "none" });
		expect(unrelated).toBeTruthy();
	});

	it("does not pair a rebase that dropped every local commit and fast-forwarded", async () => {
		// The `rebase (finish)` trap, and why that edge alone is not enough. A
		// pull --rebase whose local work is already upstream drops it and
		// fast-forwards, so the branch's old tip becomes unreachable while the
		// new tip is an unrelated upstream commit — indistinguishable from a
		// replayed tip by adjacency, separated by the commit subject.
		//
		// Dropping the commit has to be git's own decision, reached by patch-id,
		// or no rebase happens and no `rebase (finish)` is written at all — an
		// earlier version of this test discarded the commit itself with a reset
		// and passed without ever building the edge it names.
		await write(dir, "base.txt", "base");
		await commit(dir, "base");
		const clone = await mkdtemp(join(tmpdir(), "jolli-pair-clone-"));
		try {
			await execGit(["clone", dir, clone], dir);
			await execGit(["config", "user.email", "t@example.com"], clone);
			await execGit(["config", "user.name", "T"], clone);
			await write(clone, "a.txt", "hello");
			const localTip = await commit(clone, "the same change");

			// Upstream lands the identical patch under its own commit, then moves
			// on. The rebase recognises the local commit as already applied.
			await write(dir, "a.txt", "hello");
			await commit(dir, "same change, landed upstream");
			await write(dir, "b.txt", "x");
			const unrelated = await commit(dir, "chore(deps): bump something unrelated");

			await execGit(["fetch", "origin"], clone);
			await execGit(["rebase", "origin/main"], clone);
			const newTip = (await execGit(["rev-parse", "HEAD"], clone)).stdout.trim();

			// The trap in full: `rebase (finish)` sits immediately newer than the
			// abandoned tip, so adjacency alone pairs them.
			expect(newTip).toBe(unrelated);
			const reflog = (await execGit(["reflog", "show", "--format=%H %gs", "main"], clone)).stdout.split("\n");
			expect(reflog[0]).toMatch(/^\w+ rebase \(finish\)/);
			expect(reflog[1]?.startsWith(localTip)).toBe(true);

			expect(await pairStrandedHash(localTip, clone)).toEqual({ kind: "none" });
		} finally {
			await rm(clone, { recursive: true, force: true });
		}
	});

	it("pairs an amend that rewords, which no subject match would allow", async () => {
		// The other side of the asymmetry: `commit (amend)` identifies what it
		// rewrote on its own, so requiring a matching subject here would reject
		// the ordinary case of amending a message.
		await commit(dir, "base");
		const old = await commit(dir, "typo in the subejct");
		await execGit(["commit", "--allow-empty", "--amend", "-m", "a completely different subject"], dir);
		const head = (await execGit(["rev-parse", "HEAD"], dir)).stdout.trim();

		expect(await pairStrandedHash(old, dir)).toEqual({ kind: "paired", newHash: head });
	});

	it("does not pair across a reset, which rewrites nothing", async () => {
		await commit(dir, "base");
		const dropped = await commit(dir, "dropped");
		await execGit(["reset", "--hard", "HEAD~1"], dir);
		const replacement = await commit(dir, "replacement");

		expect(await pairStrandedHash(dropped, dir)).toEqual({ kind: "none" });
		expect(replacement).toBeTruthy();
	});
});
