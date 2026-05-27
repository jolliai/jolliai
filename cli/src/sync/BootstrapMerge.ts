/**
 * Bootstrap merge — handles the "fresh local vault + populated remote" sync
 * case where `git pull --rebase` would otherwise hard-fail with
 * "untracked working tree files would be overwritten by checkout".
 *
 * **The problem.** When MigrationEngine writes FolderStorage outputs
 * (`<repo>/.jolli/migration.json`, transcripts, etc.) BEFORE any sync round
 * runs, and the remote Personal Space repo already carries those same paths
 * from another device, the round's `pullRebase` aborts because git refuses
 * to overwrite untracked files. The round flips to `offline` and every
 * subsequent round hits the same wall — sticky failure with no UI path.
 *
 * **The solution.** When we detect a "truly fresh local + non-empty remote"
 * combination, run a one-shot bootstrap merge BEFORE pullRebase:
 *
 *   1. Move every local file into `<vaultRoot>/.jolli-bootstrap-stash/<relpath>`.
 *   2. `git checkout -B <default> origin/<default>` — adopt remote as-is.
 *   3. Walk the stash: for each file, compare against the working-tree
 *      counterpart. Pure additions (no counterpart) move back. Byte-identical
 *      paths are no-ops (stash entry discarded). Conflicting paths (both
 *      sides differ) — **remote wins in the working tree, local stays in the
 *      stash dir** so the user can manually merge. Canary reports the stash
 *      survivors so UI can surface them.
 *   4. Stage + commit the merged result.
 *   5. Caller (`SyncEngine.doRound`) continues with the normal push step.
 *
 * **Why no JSON union merge in v1.** The aggregate JSONs (`repo-index`,
 * `repo-manifest`, etc.) could in principle be union-merged
 * (`{...remote, ...local}` with `updatedAt` tiebreak). That's a meaningful
 * improvement but requires careful per-kind logic + tests. Shipping it
 * deferred to a follow-up; the v1 "remote wins, local in stash" policy is
 * already no-data-loss (stash preserves every local byte) and unblocks the
 * sticky-failure scenario today.
 *
 * **Safety / "宁可漏触发，不能错触发".** Mistriggering on a vault with real
 * local history would wipe it via the destructive `checkout -B`. The
 * trigger conditions (`shouldRunBootstrapMerge`) and the in-function
 * pre-flight reassertion are intentionally strict: ANY signal that a
 * branch ref / stash ref exists, or that HEAD is born, aborts the
 * bootstrap path with no destructive side effect.
 */

import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isAggregatePath, tryAggregateMerge } from "./ConflictResolver.js";
import type { GitClient } from "./GitClient.js";

/**
 * Stash directory under the vault root. Listed in `MemoryBankBootstrap`'s
 * `.gitignore` template so it never enters the index. Per-segment leading-dot
 * also makes the classifier reject anything inside it as `unowned`, which is
 * a second-layer safeguard against accidentally staging stashed content.
 */
export const BOOTSTRAP_STASH_DIRNAME = ".jolli-bootstrap-stash";

/**
 * Snapshot of the trigger-condition probe. Caller logs `reason` when the
 * answer is `false` so the offline-fallback case has a clear audit trail.
 */
export type ShouldRunResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Strict trigger check — all of C1-C5 must hold. C6 (HEAD reflog empty)
 * from the plan is folded into C1+C4+C5: with unborn HEAD AND no local
 * branches AND no stash, there's no surface a reflog entry could persist
 * on, so a separate reflog probe would be redundant.
 *
 *   C1: `!hasHead()`                                  — unborn HEAD
 *   C2: `refExists(refs/remotes/origin/<default>)`    — remote fetched
 *   C3: `hasUncommittedChanges({includeIgnored:true})` — working tree non-empty
 *   C4: `listLocalBranches().length === 0`            — no local branch refs
 *   C5: `!refExists(refs/stash)`                       — no git stash
 */
export async function shouldRunBootstrapMerge(client: GitClient, defaultBranch: string): Promise<ShouldRunResult> {
	if (await client.hasHead()) return { ok: false, reason: "HEAD is born (C1 failed)" };
	if (!(await client.refExists(`refs/remotes/origin/${defaultBranch}`))) {
		return { ok: false, reason: `origin/${defaultBranch} missing (C2 failed)` };
	}
	if (!(await client.hasUncommittedChanges({ includeIgnored: true }))) {
		return { ok: false, reason: "working tree empty (C3 failed)" };
	}
	const branches = await client.listLocalBranches();
	if (branches.length > 0) {
		return { ok: false, reason: `local branches present: ${branches.join(",")} (C4 failed)` };
	}
	if (await client.refExists("refs/stash")) {
		return { ok: false, reason: "git stash present (C5 failed)" };
	}
	return { ok: true };
}

/**
 * Per-path disposition recorded by the merge walk. Used by tests and
 * callers (canary) — not just logging.
 */
export interface BootstrapPathReport {
	readonly path: string;
	readonly disposition:
		| "added-from-local"
		| "no-op"
		| "remote-wins-local-stashed"
		| "remote-only"
		| "aggregate-merged";
}

export interface BootstrapMergeResult {
	readonly ok: true;
	readonly commitSha: string;
	readonly reports: ReadonlyArray<BootstrapPathReport>;
	/** Paths still sitting in the stash dir after the merge — user-visible drift signal. */
	readonly stashedSurvivors: ReadonlyArray<string>;
}

export interface BootstrapMergeFailure {
	readonly ok: false;
	readonly code: "race-detected" | "checkout-failed" | "commit-failed";
	readonly message: string;
}

export interface BootstrapMergeDeps {
	readonly client: GitClient;
	readonly vaultRoot: string;
	readonly defaultBranch: string;
	readonly author: { readonly name: string; readonly email: string };
	readonly log?: {
		readonly info: (msg: string, ...args: unknown[]) => void;
		readonly warn: (msg: string, ...args: unknown[]) => void;
	};
}

/**
 * Run the bootstrap merge. Caller MUST have verified `shouldRunBootstrapMerge`
 * first; this function reasserts C1+C4 internally as a race guard but the
 * upstream check covers C2/C3/C5.
 */
export async function runBootstrapMerge(
	deps: BootstrapMergeDeps,
): Promise<BootstrapMergeResult | BootstrapMergeFailure> {
	const { client, vaultRoot, defaultBranch, author, log } = deps;
	const stashRoot = join(vaultRoot, BOOTSTRAP_STASH_DIRNAME);

	// Pre-flight race reassertion (C1 + C4). C2/C3/C5 already checked by
	// `shouldRunBootstrapMerge`; re-checking C1/C4 here defends against
	// another process committing or creating a branch between the trigger
	// check and the destructive checkout. The cost of false-negative here
	// is one offline round; the cost of false-positive on the destructive
	// path is real data loss, so this guard is worth the duplicate I/O.
	if (await client.hasHead()) {
		return { ok: false, code: "race-detected", message: "HEAD appeared between trigger check and stash" };
	}
	const branchesNow = await client.listLocalBranches();
	if (branchesNow.length > 0) {
		return {
			ok: false,
			code: "race-detected",
			message: `local branch appeared mid-flight: ${branchesNow.join(",")}`,
		};
	}

	// Step 1: stash every local file (except `.git/` and a pre-existing
	// stash dir from an aborted prior run) into `<stashRoot>/<relpath>`.
	const localFiles = await collectLocalFiles(vaultRoot, stashRoot);
	log?.info("bootstrap-merge: stashing %d local files into %s", localFiles.length, BOOTSTRAP_STASH_DIRNAME);
	for (const rel of localFiles) {
		const src = join(vaultRoot, rel);
		const dst = join(stashRoot, rel);
		await fs.mkdir(dirname(dst), { recursive: true });
		// `rename` is atomic within a filesystem and cheap. If it fails
		// (cross-device, etc.), fall back to copy+unlink.
		try {
			await fs.rename(src, dst);
		} catch {
			await fs.copyFile(src, dst);
			await fs.unlink(src);
		}
	}

	// Step 2: adopt remote.
	try {
		await client.checkoutTrackingBranch(defaultBranch);
	} catch (e) {
		const msg = (e as Error).message ?? String(e);
		log?.warn("bootstrap-merge: checkout failed: %s — rolling back stash", msg);
		// Roll back step 1: move the files we just stashed back to their
		// original working-tree locations so a checkout failure leaves the
		// vault byte-for-byte as we found it. Without this, the canonical
		// FolderStorage paths stay empty (content relocated into the hidden
		// stash dir) until a later round's bootstrap happens to succeed and
		// re-consume the stash — a confusing, hard-to-observe transient state
		// if the process exits in between. Restoring here makes the failure
		// path idempotent. Only `localFiles` (what THIS run moved) is restored;
		// a pre-existing stash from an aborted prior run is left alone for that
		// run's own recovery.
		await restoreStashedFiles(localFiles, vaultRoot, stashRoot);
		return { ok: false, code: "checkout-failed", message: msg };
	}

	// Step 3: walk stash, decide per-path disposition.
	const reports: BootstrapPathReport[] = [];
	const stashedFiles = await collectStashFiles(stashRoot);
	for (const rel of stashedFiles) {
		const stashPath = join(stashRoot, rel);
		const workingPath = join(vaultRoot, rel);
		const workingExists = await pathExists(workingPath);

		if (!workingExists) {
			// Pure local addition — restore.
			await fs.mkdir(dirname(workingPath), { recursive: true });
			await fs.rename(stashPath, workingPath);
			reports.push({ path: rel, disposition: "added-from-local" });
			continue;
		}

		// Both sides have it.
		const stashBytes = await fs.readFile(stashPath);
		const workingBytes = await fs.readFile(workingPath);
		if (stashBytes.equals(workingBytes)) {
			await fs.unlink(stashPath);
			reports.push({ path: rel, disposition: "no-op" });
			continue;
		}

		// Both sides have a conflicting path.
		//
		// Aggregate JSON paths (`<repo>/.jolli/{manifest,index,branches,catalog}.json`
		// and root `.jolli/repos.json`) have a deterministic union merger via
		// `tryAggregateMerge` — the same Tier 1.5 path exercised by acceptance
		// §12. Use it here so the bootstrap case ends with both peers' entries
		// preserved, matching pullRebase's Tier 1.5 behavior on the same
		// content. If the merger returns `null` (parse failure, unknown
		// envelope shape), fall through to the conservative remote-wins +
		// local-stashed policy.
		if (isAggregatePath(rel)) {
			const oursText = stashBytes.toString("utf-8");
			const theirsText = workingBytes.toString("utf-8");
			const merged = tryAggregateMerge(rel, oursText, theirsText);
			if (merged !== null) {
				await fs.writeFile(workingPath, merged);
				await fs.unlink(stashPath);
				reports.push({ path: rel, disposition: "aggregate-merged" });
				continue;
			}
			log?.warn("bootstrap-merge: aggregate merge returned null for %s — falling back to remote-wins", rel);
		}

		// Conservative fallback: remote stays in working tree, local stays
		// in stash dir. User can recover from the stash dir; canary reports
		// the survivor so UI can surface it.
		reports.push({ path: rel, disposition: "remote-wins-local-stashed" });
	}

	// Sweep stash dir empty directories — keeps `git status` clean when the
	// merge had no surviving conflicts.
	await pruneEmptyDirs(stashRoot);
	const stashedSurvivors = await collectStashFiles(stashRoot);

	// Step 4: stage + commit. We stage everything (the working tree at this
	// point is `origin/<default>` plus restored local additions). The
	// commit reaffirms `<default>` HEAD; if no diff vs `origin/<default>`
	// exists, the commit is empty and skipped via `--allow-empty=false`.
	await client.stageAll();
	let commitSha: string;
	try {
		commitSha = await client.commit(
			"[jolli-mb] reconcile: bootstrap merge of fresh local into populated remote",
			author,
		);
	} catch (e) {
		const msg = (e as Error).message ?? String(e);
		// "nothing to commit" is the empty-merge case — there were no pure
		// local additions and nothing to add on top of origin/<default>.
		// HEAD already points at the right ref via checkout, so this is a
		// success: just synthesize the current HEAD as the commitSha.
		if (/nothing to commit|no changes added/i.test(msg)) {
			const head = await client.revParse("HEAD");
			if (head === null) {
				return { ok: false, code: "commit-failed", message: "HEAD missing after empty merge" };
			}
			commitSha = head;
		} else {
			log?.warn("bootstrap-merge: commit failed: %s", msg);
			return { ok: false, code: "commit-failed", message: msg };
		}
	}

	log?.info(
		"bootstrap-merge: done commit=%s reports=%d stashedSurvivors=%d",
		commitSha,
		reports.length,
		stashedSurvivors.length,
	);

	return { ok: true, commitSha, reports, stashedSurvivors };
}

/**
 * Recursively enumerate every file under `root`, returning relative POSIX
 * paths. Skips `.git/` (would corrupt the repo if we moved it) and the
 * `BOOTSTRAP_STASH_DIRNAME` (so a prior aborted run's stash doesn't get
 * re-stashed into itself).
 */
async function collectLocalFiles(root: string, stashRoot: string): Promise<ReadonlyArray<string>> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const ent of entries) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				if (ent.name === ".git") continue;
				if (full === stashRoot) continue;
				await walk(full);
			} else if (ent.isFile() || ent.isSymbolicLink()) {
				// Symlinks are moved as-is (rename preserves them); the
				// stage step downstream surfaces hostile symlinks via the
				// existing `stageVault` canary, not here.
				out.push(toPosix(relative(root, full)));
			}
		}
	};
	try {
		await walk(root);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	return out;
}

/**
 * Like `collectLocalFiles` but rooted at the stash dir and returns paths
 * relative to it. Separate function (not a parameterized version of the
 * above) for the symmetry of intent — and because stash walk doesn't need
 * to skip `.git/` or itself.
 */
async function collectStashFiles(stashRoot: string): Promise<ReadonlyArray<string>> {
	const out: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: Array<import("node:fs").Dirent>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
			throw e;
		}
		for (const ent of entries) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				await walk(full);
			} else if (ent.isFile() || ent.isSymbolicLink()) {
				out.push(toPosix(relative(stashRoot, full)));
			}
		}
	};
	await walk(stashRoot);
	return out;
}

/**
 * Inverse of step 1's stash move: relocate each `rel` from
 * `<stashRoot>/<rel>` back to `<vaultRoot>/<rel>`. Used on the
 * checkout-failure rollback path so a failed bootstrap leaves the working
 * tree exactly as it was found. Mirrors step 1's `rename`-with-`copyFile`
 * fallback for the cross-device case. Skips a `rel` whose stash entry is
 * already gone (defensive — nothing to restore), then prunes the now-empty
 * stash dirs so a clean rollback leaves no hidden directory behind.
 */
async function restoreStashedFiles(rels: ReadonlyArray<string>, vaultRoot: string, stashRoot: string): Promise<void> {
	for (const rel of rels) {
		const src = join(stashRoot, rel);
		const dst = join(vaultRoot, rel);
		if (!(await pathExists(src))) continue;
		await fs.mkdir(dirname(dst), { recursive: true });
		try {
			await fs.rename(src, dst);
		} catch {
			await fs.copyFile(src, dst);
			await fs.unlink(src);
		}
	}
	await pruneEmptyDirs(stashRoot);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.lstat(p);
		return true;
	} catch {
		return false;
	}
}

async function pruneEmptyDirs(root: string): Promise<void> {
	const walk = async (dir: string): Promise<boolean> => {
		let entries: Array<import("node:fs").Dirent>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw e;
		}
		let remaining = 0;
		for (const ent of entries) {
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				const wasRemoved = await walk(full);
				if (!wasRemoved) remaining++;
			} else {
				remaining++;
			}
		}
		if (remaining === 0) {
			try {
				await fs.rmdir(dir);
				return true;
			} catch {
				return false;
			}
		}
		return false;
	};
	await walk(root);
}

function toPosix(p: string): string {
	return p.split(/[\\/]/).join("/");
}
