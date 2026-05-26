/**
 * Allowlist-staging entry point — replaces `git add --all` for the four
 * staging sites in `SyncEngine` (auto-reconcile, steady-state, migration,
 * branch-switch preservation).
 *
 * Flow:
 *
 *   1. Snapshot `git status --porcelain -z --untracked-files=all` →
 *      structured `PorcelainEntry[]` via the shared parser.
 *   2. Decompose renames into discrete `(add new, del old)` operations so
 *      every op classifies independently.
 *   3. For each op:
 *      - Classify via `classifyVaultPath`. `null` → `unowned` (canary
 *        warns; not staged).
 *      - `transcript` kind + `syncTranscripts: false` → `skipped`.
 *      - Add ops: lstat the leaf AND check the path chain for symlinks.
 *        Either symlink → `symlinked` (canary warns at higher severity;
 *        not staged — sync silently dropping data is the failure mode
 *        we cannot accept).
 *      - Survivors split into `toAdd` / `toRm`.
 *   4. `git add -f -- <toAdd>` (the `-f` overrides the post-allowlist
 *      `.gitignore`'s catch-all deny — classifier is the staging
 *      authority, not gitignore).
 *   5. `git rm --ignore-unmatch --quiet -- <toRm>` for deletions.
 *
 * Returns a `StageReport` the caller logs as telemetry. The `unowned`
 * and `symlinked` arrays are the **canary signals** dogfood watchers
 * grep for — non-empty means either FolderStorage added a write site
 * the classifier doesn't recognise (drift) or something outside the
 * engine put a file in the vault (foreign writer / hostile placement).
 */

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { GitClient } from "./GitClient.js";
import type { OwnedPathKind } from "./OwnedPathKind.js";
import { isDeletion, type PorcelainEntry } from "./PorcelainParser.js";
import { classifyVaultPath } from "./VaultPathClassifier.js";
import { assertNoSymlinksInPath } from "./VaultSymlinkGuard.js";

const log = createLogger("Sync:StageVault");

/**
 * Per-round telemetry. SyncEngine consumes this for the info-log
 * (per-kind counts) and the warn-log (`unowned` / `symlinked` non-empty).
 *
 * Counts buckets:
 *
 *   - `added` / `removed` — what actually got staged.
 *   - `skipped` — count of `transcript` entries dropped via the
 *     `syncTranscripts: false` opt-out.
 *   - `unowned` — paths the classifier returned `null` for. Listed (not
 *     just counted) so the canary log can name the first N.
 *   - `symlinked` — paths that classified as owned BUT had a symlink in
 *     their leaf or path chain. Listed for the same reason.
 *
 * `byKind` is the per-kind breakdown for stage attempts (includes
 * `skipped` + `symlink-blocked` so the totals reconcile against
 * `entries.length`).
 */
export interface StageReport {
	readonly added: number;
	readonly removed: number;
	readonly skipped: number;
	readonly unowned: ReadonlyArray<string>;
	readonly symlinked: ReadonlyArray<string>;
	readonly byKind: ReadonlyMap<OwnedPathKind | "unowned" | "skipped" | "symlink-blocked", number>;
}

export interface StageVaultOpts {
	/**
	 * Honours the user's "sync transcripts" setting. When `false`,
	 * `kind === "transcript"` entries are filtered out before the leaf /
	 * symlink check — same semantics the pre-refactor `.gitignore` had
	 * (the conditional trailer), just done at stage time instead of
	 * gitignore time.
	 */
	readonly syncTranscripts: boolean;
}

/**
 * Stages the vault's owned-path changes via `git add -f` / `git rm`.
 * See module docstring for the full pipeline.
 *
 * Parameters:
 *   - `client` — already-bound `GitClient` for the vault working tree.
 *   - `vaultRoot` — absolute path to the vault working tree. Used to
 *     compute absolute paths for the leaf-symlink lstat + the
 *     path-chain check.
 *   - `opts.syncTranscripts` — gates the `"transcript"` kind.
 *
 * The function never throws on a classifier mismatch or a symlinked
 * path — those route into `unowned` / `symlinked` for telemetry.
 * Throws only on underlying `git add` / `git rm` failures (which are
 * real bugs — classifier said the path is owned and on disk, but git
 * rejected the stage), and on `client.statusPorcelainZ` propagation.
 */
export async function stageVault(client: GitClient, vaultRoot: string, opts: StageVaultOpts): Promise<StageReport> {
	const entries = await client.statusPorcelainZ();
	const ops = decomposeOps(entries);

	const byKind = new Map<OwnedPathKind | "unowned" | "skipped" | "symlink-blocked", number>();
	const toAdd: string[] = [];
	const toRm: string[] = [];
	// `toUnstage` — paths the classifier rejects (UNOWNED) that are
	// CURRENTLY in the git index. Issued via `git rm --cached` (no
	// working-tree removal). For an unowned path with no HEAD blob (e.g.
	// a foreign writer's `git add foreign.txt`), this just drops the
	// index entry; for one that HAS a HEAD blob (legacy committed foreign
	// content), this stages a deletion that the next commit will push.
	// The latter is intentional under the current contract — the
	// classifier is authoritative; anything outside the catalogue is
	// either drift to clean up or junk to evict.
	const toUnstage: string[] = [];
	// `toReset` — paths we want to REMOVE FROM THE PENDING COMMIT without
	// staging a deletion against HEAD. Issued via `git reset HEAD --`.
	// Distinct from `toUnstage` because the path is recognised as
	// engine-owned but should not propagate this round:
	//
	//   - `transcript` + `syncTranscripts=false`: Model 2 says OFF is
	//     passive — don't upload local edits, don't delete peers'.
	//     Continuing without resetting leaves a staged A/M/D in the
	//     index from a prior ON-state, external `git add`, or interrupted
	//     round, which `commit()` would then push (P1#4).
	//   - symlink-blocked owned path: leaf or parent chain is a symlink,
	//     so we refuse to stage the symlink content. Pre-fix this routed
	//     into `toUnstage` → `git rm --cached` → staged deletion of the
	//     HEAD blob → peers lose the file. `git reset HEAD --` restores
	//     the HEAD blob into the index instead (P1#3).
	const toReset: string[] = [];
	const unowned: string[] = [];
	const symlinked: string[] = [];
	let skipped = 0;

	for (const op of ops) {
		const kind = classifyVaultPath(op.path);
		if (kind === null) {
			unowned.push(op.path);
			bump(byKind, "unowned");
			if (op.staged) toUnstage.push(op.path);
			continue;
		}
		if (kind === "transcript" && !opts.syncTranscripts) {
			skipped++;
			bump(byKind, "skipped");
			// Model 2 (MemoryBankBootstrap.ts §"transcripts=OFF semantics"):
			// OFF means "this device does not upload NEW transcripts", NOT
			// "delete what other devices already uploaded".
			//
			// If the transcript has a staged index entry (A/M/D against
			// HEAD — possible from a prior ON-state, external `git add`,
			// or an interrupted round), a bare `continue` would leave the
			// staged change intact and the round's `commit()` (which has
			// no pathspec — see `GitClient.commit`) would propagate it.
			// `git reset HEAD --` reverts the index entry to its HEAD blob
			// (or removes it if HEAD has none), so the commit carries
			// nothing for this path. Unlike `git rm --cached`, it does NOT
			// stage a deletion against a HEAD-tracked transcript.
			if (op.staged) toReset.push(op.path);
			continue;
		}
		if (op.kind === "del") {
			toRm.push(op.path);
			bump(byKind, kind);
			continue;
		}
		// Add path — verify the path chain + leaf are symlink-free. A
		// symlink at the leaf could be a hostile placement at a
		// classifier-matching location (e.g. `<repo>/.jolli/index.json` →
		// `~/.aws/credentials`); a symlink in the path chain is the
		// intermediate-segment exploit. Either case: refuse to stage,
		// surface in the canary, let the operator investigate.
		const absPath = join(vaultRoot, op.path);
		const isOk = await isSymlinkSafeForStaging(vaultRoot, absPath);
		if (!isOk) {
			symlinked.push(op.path);
			bump(byKind, "symlink-blocked");
			// `toReset` (not `toUnstage`) so a HEAD-tracked path now
			// shadowed by a hostile symlink doesn't get its HEAD blob
			// staged-as-deleted (which `git rm --cached` would do and
			// `commit` would push, deleting the file from every peer's
			// vault). `git reset HEAD --` instead restores the HEAD blob
			// in the index — the working-tree symlink is preserved for the
			// operator to inspect, but the round commits nothing for this
			// path. Unowned still uses `git rm --cached` (above) because
			// for those the classifier asserts the path is foreign content
			// to evict.
			if (op.staged) toReset.push(op.path);
			continue;
		}
		toAdd.push(op.path);
		bump(byKind, kind);
	}

	if (toAdd.length > 0) await client.stageAddPaths(toAdd);
	if (toRm.length > 0) await client.stageRemovePaths(toRm);
	if (toUnstage.length > 0) await client.unstagePaths(toUnstage);
	if (toReset.length > 0) await client.resetPathsToHead(toReset);

	if (unowned.length > 0) {
		log.warn(
			"stageVault: %d unowned path(s) skipped (classifier drift or foreign writer). First %d: %s",
			unowned.length,
			Math.min(unowned.length, 5),
			unowned.slice(0, 5).join(", "),
		);
	}
	if (symlinked.length > 0) {
		log.warn(
			"stageVault: %d symlinked path(s) blocked from staging (POTENTIAL HOSTILE PLACEMENT). Inspect immediately: %s",
			symlinked.length,
			symlinked.slice(0, 5).join(", "),
		);
	}
	log.info(
		"stageVault: added=%d removed=%d unstaged=%d reset=%d skipped=%d unowned=%d symlinked=%d",
		toAdd.length,
		toRm.length,
		toUnstage.length,
		toReset.length,
		skipped,
		unowned.length,
		symlinked.length,
	);

	return {
		added: toAdd.length,
		removed: toRm.length,
		skipped,
		unowned,
		symlinked,
		byKind,
	};
}

/**
 * Per-op intermediate used by the staging loop. `kind` is "add" or "del"
 * after rename decomposition — every rename `R` entry becomes one
 * `del(oldPath) + add(path)` pair so each operation classifies and
 * symlink-checks independently.
 *
 * `staged` tells the loop whether the path currently has an index entry
 * (so a classifier-reject must `git rm --cached` it instead of merely
 * skipping). True for any porcelain row except `??` (untracked) and `!!`
 * (ignored) — those have nothing in the index to remove. False otherwise.
 */
interface Op {
	readonly kind: "add" | "del";
	readonly path: string;
	readonly staged: boolean;
}

/**
 * Flattens `PorcelainEntry[]` into the per-op stream `stageVault` operates
 * on. Rename / copy handling differs:
 *
 *   - **Rename (`R`)** — source path is gone from the working tree, so we
 *     emit `del(old) + add(new)`. Both ops are classified independently
 *     (a rename FROM an owned location TO an unowned one stages the del
 *     but skips the add via the classifier, and vice versa).
 *   - **Copy (`C`)** — source path is STILL PRESENT in the working tree
 *     (that's the definition of copy vs rename). Emitting `del(old)`
 *     would `git rm` a live file. We emit only `add(new)` and leave the
 *     source alone — it remains either tracked-and-unchanged (no
 *     porcelain entry) or surfaces as its own independent entry.
 *
 * Plain deletes contribute one `del`; everything else contributes one
 * `add`. Unmerged (`U`) entries are skipped — the caller's responsibility
 * to resolve them BEFORE stageVault runs. If they slip through, dropping
 * them is safer than staging conflict-marker content into a commit.
 */
function decomposeOps(entries: ReadonlyArray<PorcelainEntry>): ReadonlyArray<Op> {
	const ops: Op[] = [];
	for (const e of entries) {
		// Unmerged entries — the caller violated stageVault's precondition.
		// Log + drop. (This is defence; in normal flow the conflict
		// resolver runs before stageVault.)
		if (e.indexStatus === "U" || e.worktreeStatus === "U") {
			log.warn(
				"stageVault: dropping unmerged entry %s (XY=%s%s) — conflict resolver should have run first",
				e.path,
				e.indexStatus,
				e.worktreeStatus,
			);
			continue;
		}
		// `staged` predicate — there is a STAGED CHANGE against HEAD for
		// this path (i.e. the index entry differs from HEAD). Restricted
		// to the real-mutation index statuses (A/M/D/R/C); the space (" ")
		// status means "tracked, index matches HEAD" — committing with
		// this path's index entry unchanged produces no diff, so there's
		// nothing to unstage / reset, and a `git rm --cached` would
		// gratuitously stage a deletion. `?` (untracked) and `!`
		// (ignored) have no index entry at all.
		const staged =
			e.indexStatus === "A" ||
			e.indexStatus === "M" ||
			e.indexStatus === "D" ||
			e.indexStatus === "R" ||
			e.indexStatus === "C";
		// Rename / copy: parser sets `oldPath` for BOTH. Distinguish so a
		// copy doesn't `git rm` its still-present source. Rename old path
		// is always staged (rename presupposes the source was tracked).
		if (e.oldPath !== undefined) {
			const isRename = e.indexStatus === "R" || e.worktreeStatus === "R";
			if (isRename) {
				ops.push({ kind: "del", path: e.oldPath, staged: true });
			}
			ops.push({ kind: "add", path: e.path, staged });
			continue;
		}
		// Pure deletion.
		if (isDeletion(e)) {
			ops.push({ kind: "del", path: e.path, staged });
			continue;
		}
		// Everything else (added, modified, untracked, ignored, type-changed)
		// is an add. Ignored (`!!`) reaches us only when the caller invoked
		// `git status --ignored` — `stageVault`'s only caller does that
		// because the deny-all `.gitignore` template means brand-new owned
		// files appear as ignored, not untracked.
		ops.push({ kind: "add", path: e.path, staged });
	}
	return ops;
}

/**
 * Returns true if the path is safe to stage from a symlink standpoint:
 * no symlink at the leaf AND no symlink in the path chain. Catches both:
 *
 *   - Leaf is a symlink: hostile / accidental placement at a
 *     classifier-matching location.
 *   - An intermediate directory is a symlink: parent-segment traversal
 *     exploit.
 *
 * Returns false on either failure or on a thrown error from the path
 * checks (defensive — a stat permission failure is treated as "can't
 * verify safety, refuse to stage").
 */
async function isSymlinkSafeForStaging(vaultRoot: string, absPath: string): Promise<boolean> {
	try {
		// Leaf check.
		const leaf = await lstat(absPath);
		if (leaf.isSymbolicLink()) return false;
		// Path-chain check.
		await assertNoSymlinksInPath(vaultRoot, absPath);
		return true;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			// The file disappeared between `git status` snapshot and our
			// lstat. Treat as "can't verify, skip" — `git add` would
			// reject ENOENT anyway, and the disappearance is recoverable
			// next round if the file reappears.
			return false;
		}
		log.warn("stageVault: lstat/chain-check failed for %s: %s — refusing to stage", absPath, (e as Error).message);
		return false;
	}
}

function bump<K>(map: Map<K, number>, key: K): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}
