/**
 * Maintains `<memoryBankRoot>/.gitignore` and untracks paths that newly fall
 * under the deny list.
 *
 * `<localFolder>` IS the git working tree (see plan §1.2), so the sync
 * engine has no "mirror" step copying source files to a separate target.
 * The only static artifact the engine writes into the working tree is
 * `.gitignore`. This module owns that file plus the side-effect of
 * untracking already-committed paths when their deny status flips on
 * (currently: per-repo `.jolli/transcripts/` when `syncTranscripts`
 * toggles ON → OFF).
 *
 * `applyLegacyContent` (db→git first-bind migration) lives in
 * `LegacyMigration.ts` — different lifecycle (one-shot vs every round)
 * and different removal trajectory (legacy migration code can be deleted
 * once all v1 users have migrated; bootstrap is permanent).
 */

import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createLogger } from "../Logger.js";
import type { GitClient } from "./GitClient.js";

/**
 * `<hash>.json` filename pattern AllowList.ts requires for entries
 * under `.jolli/summaries/`. Lowercase hex, 7-64 chars. Anything else
 * is rejected by the allow-list but `.gitignore` can't express the
 * regex, so `MemoryBankBootstrap.ensureBootstrap()` untracks any
 * non-conforming file on every round (see P2 fix).
 */
const SUMMARY_HASH_FILENAME = /^[0-9a-f]{7,64}\.json$/;

/**
 * Per-device state file used to skip the full `untrackNonHashSummaries`
 * walk when no summaries directory has changed since the last clean
 * scan. Lives at the root of `<memoryBankRoot>` and is gitignored by
 * the `.* / **\/.*` deny rules (§3 of the gitignore base) — never
 * synced.
 *
 * Schema: `{ version: 1, scannedDirs: { "<repo>/.jolli/summaries": mtimeMs, ... } }`.
 * Directories absent from the map are scanned; directories whose live
 * `mtimeMs` differs from the cached value are scanned. Linux/macOS/Windows
 * all update parent-directory mtime on child create/rename/delete (NTFS
 * via `LastWriteTime`), so any drop / quarantine / peer-synced summary
 * invalidates the cache automatically.
 */
const BOOTSTRAP_STATE_FILE = ".memorybank-state.json";
const BOOTSTRAP_STATE_VERSION = 1;

interface BootstrapState {
	readonly version: number;
	readonly scannedDirs: Readonly<Record<string, number>>;
}

const log = createLogger("Sync:Bootstrap");

/**
 * Returns `true` if any intermediate path segment between `root` and
 * `root/segments[0]/segments[1]/…/segments[N-2]` is a symbolic link.
 * The leaf (`segments[N-1]`) is NOT inspected — the caller already
 * `lstat`s it and decides how to react to a symlink there.
 *
 * `lstat` only inspects the final component for symlink-ness; it
 * happily follows symlinks on every intermediate segment. So checking
 * only the leaf, as the previous code did, leaves a TOCTOU window
 * between SymlinkSweep (step 3a) and this scan (step 5) where a race
 * process can swap `<repo>` or `<repo>/.jolli` for a link to `/etc`
 * and the quarantine rename will move files OUT of the link target.
 * Walk the chain and bail on the first symlink.
 */
async function intermediateContainsSymlink(root: string, segments: ReadonlyArray<string>): Promise<boolean> {
	let current = root;
	for (let i = 0; i < segments.length - 1; i++) {
		current = join(current, segments[i]);
		try {
			const st = await lstat(current);
			if (st.isSymbolicLink()) return true;
		} catch {
			// Missing intermediate is fine — the caller's own lstat on the
			// leaf will fail and skip the dir. Bail out without flagging.
			return false;
		}
	}
	return false;
}

// Glob matching per-repo transcripts at any nesting level. Used in both
// the .gitignore deny line and the untrack `git rm --cached` glob.
const TRANSCRIPTS_GLOB = "**/.jolli/transcripts/";

/**
 * Per-device JSON inside `<repo>/.jolli/` that must never be synced.
 * The `.gitignore` already denies all dot-prefixed paths and then only
 * re-allows the specific aggregate + summary names — these are listed
 * separately so the engine can `git rm --cached` any pre-existing
 * tracked copies from before the tightened rules landed.
 *
 * `git rm --cached --ignore-unmatch` makes this idempotent.
 */
// `config.json` used to live here — it was untracked as a per-device file.
// It now carries cross-device identity (remoteUrl / repoName) and IS synced
// (AllowList allow-list + the §5 gitignore re-allow). Only `shadow-status.json`
// remains genuinely per-device (records FolderStorage's dirty-write recovery
// state, meaningless to peers).
const PER_DEVICE_JSON_GLOBS: ReadonlyArray<string> = ["**/.jolli/shadow-status.json"];

// `.gitignore` for the Memory Bank working tree. The previous version
// allowed `!*.md` / `!*.json` at every depth, which let `repo/.env.json`,
// `repo/.hidden/secret.md`, and `repo/.jolli/random.json` slip through
// because `git add --all` stages whatever isn't ignored (no AllowList
// filter on the stage path any more). This version mirrors
// `cli/src/sync/AllowList.ts` semantics directly:
//
//   - Allow `.md` / `.json` at the content area (any non-hidden segment).
//   - Allow only the four named aggregate files + content-addressed
//     `summaries/<hash>.json` under `.jolli/`.
//   - Deny every other dot-prefixed file or directory.
//   - Transcripts (`**/.jolli/transcripts/`) gated separately by
//     `syncTranscripts` (the trailing block).
//
// The format leans on the fact that `.gitignore` evaluates rules in
// order: later patterns override earlier ones, and a deeper-path negation
// can re-include something a broader rule excluded.
const GITIGNORE_BASE = `# Jolli Memory Bank — auto-managed allow-list. Do not edit by hand;
# the next sync round will overwrite changes.
#
# Mirrors \`cli/src/sync/AllowList.ts\` semantics directly. Rules are
# applied in order; the LAST match wins. The previous version used a
# shorter \`!*.md\`/\`!*.json\` pattern which re-allowed files inside
# hidden dirs — verified empirically that this leaked \`.env.json\`,
# \`.hidden/secret.md\`, and unknown \`.jolli/*.json\` files. The form
# below was tested with \`git add -A\` against a fixture covering each
# AllowList rule.

# 0. Deny everything.
*

# 1. Allow this file + recurse into all directories. Children are
#    re-filtered by the later rules.
!.gitignore
!*/

# 2. Re-allow content-area markdown / JSON broadly.
!*.md
!*.json

# 3. Deny anything starting with a dot at any depth (overrides §2 for
#    hidden paths). Covers \`.env*\`, \`.vscode/\`, \`.DS_Store\`,
#    \`.hidden/\`, and the entire \`.jolli/\` tree before §4 re-opens
#    selected children.
.*
**/.*

# 4. Re-allow \`.jolli/\` directories, then deny every child broadly so
#    that the §5 whitelist is the only way content under \`.jolli/\`
#    gets staged.
!**/.jolli/
**/.jolli/*

# 5. Re-allow exactly the aggregate files AllowList.ts allows.
!**/.jolli/manifest.json
!**/.jolli/index.json
!**/.jolli/branches.json
!**/.jolli/catalog.json
!**/.jolli/repos.json
!**/.jolli/config.json

# 6. Summaries directory — re-allow the dir, deny its children broadly,
#    then re-allow only \`.json\`. \`<hash>.json\` constraint is enforced
#    by AllowList at write time; the gitignore only filters extension
#    so a malformed \`abc.txt\` can't sneak in via the dir negation.
!**/.jolli/summaries/
**/.jolli/summaries/*
!**/.jolli/summaries/*.json

# 7. Plans / plan-progress / notes — user-authored cross-device artifacts.
#    Same shape as §6: re-allow the dir, broadly deny children, then
#    re-allow the expected extension. Slug-shape enforcement (no
#    \`..\`, no leading-dot, length cap) lives in AllowList.ts at write
#    time — the gitignore only filters extension so a stray
#    \`<slug>.exe\` can't sneak in via the dir negation.
!**/.jolli/plans/
**/.jolli/plans/*
!**/.jolli/plans/*.md

!**/.jolli/plan-progress/
**/.jolli/plan-progress/*
!**/.jolli/plan-progress/*.json

!**/.jolli/notes/
**/.jolli/notes/*
!**/.jolli/notes/*.md
`;

// Transcripts trailer.
// OFF: §4 (`**/.jolli/*`) already denies the `transcripts/` directory,
//      and §5 doesn't re-allow it — no extra rule needed. The
//      commented marker keeps the toggle state human-greppable.
// ON:  re-include the directory + its JSON children so they get staged.
const GITIGNORE_TRANSCRIPTS_DENY = `\n# AI session transcripts — Settings.syncTranscripts is OFF (denied by §4)\n# ${TRANSCRIPTS_GLOB}\n`;
const GITIGNORE_TRANSCRIPTS_ALLOW = `\n# AI session transcripts — Settings.syncTranscripts is ON\n!${TRANSCRIPTS_GLOB}\n!${TRANSCRIPTS_GLOB}*.json\n`;

export interface MemoryBankBootstrapOpts {
	readonly vaultClient: GitClient;
	readonly memoryBankRoot: string;
	readonly transcripts: boolean;
}

export class MemoryBankBootstrap {
	private readonly vaultClient: GitClient;
	private readonly memoryBankRoot: string;
	private readonly transcripts: boolean;

	constructor(opts: MemoryBankBootstrapOpts) {
		this.vaultClient = opts.vaultClient;
		this.memoryBankRoot = opts.memoryBankRoot;
		this.transcripts = opts.transcripts;
	}

	/**
	 * Maintains `<memoryBankRoot>/.gitignore`. Idempotent — rewrites only if
	 * the on-disk body diverges from the expected content for the current
	 * `syncTranscripts` setting.
	 *
	 * Side effect when toggle flipped from ON → OFF: runs
	 * `git rm --cached -r <transcripts glob>` so any previously-committed
	 * transcripts get untracked. The files stay on disk but the next
	 * commit records deletions and pushes them to the remote.
	 */
	async ensureBootstrap(): Promise<void> {
		const desired = buildGitignore(this.transcripts);
		const gitignorePath = join(this.memoryBankRoot, ".gitignore");
		await mkdir(this.memoryBankRoot, { recursive: true });

		let existing: string | null = null;
		try {
			existing = await readFile(gitignorePath, "utf-8");
		} catch {
			existing = null;
		}

		if (existing !== desired) {
			await writeFile(gitignorePath, desired);
			log.info("Wrote .gitignore (transcripts=%s)", this.transcripts ? "on" : "off");
		}

		// transcripts=OFF semantics (plan §2.5 Model 2): the toggle is a
		// passive per-device switch. OFF means "this device does not
		// upload NEW transcripts" — enforced via the `.gitignore` deny
		// rule written above. It explicitly does NOT mean "delete what
		// other devices have already uploaded".
		//
		// Pre-Model-2 versions ran `git rm --cached -r '*/.jolli/transcripts/'`
		// every OFF round. Three problems that motivated Model 2:
		//
		//   1. Silent failure (orig I8): `git rm --cached` exited
		//      non-zero (index lock, perm) → swallowed at GitClient layer
		//      → bootstrap's WARN never fired → stageAll + push still
		//      carried the transcripts out. User's OFF intent was
		//      privacy-under-protected.
		//   2. Auto-deletion without consent: OFF was treated as
		//      subtractive (delete cloud) when most users mean it
		//      additively (stop uploading new). Peers `git pull`-ed the
		//      deletion commits and lost their local copies.
		//   3. Cross-device ping-pong: A=ON pushed adds, B=OFF pushed
		//      deletes, A pulled deletes and FolderStorage rewrote +
		//      re-pushed adds, B pulled adds and re-deleted… loop. Only
		//      reason it didn't burn the world pre-fix is that I8's
		//      silent-failure killed the cycle on most rounds — at the
		//      cost of B's OFF intent.
		//
		// Retraction is now a separate, explicit user action (purge
		// command + UI confirmation; tracked as follow-up).

		// Every round, untrack per-device JSON that might have been committed
		// in a previous round before this rule landed. `--ignore-unmatch`
		// makes this idempotent — if the index never contained these paths,
		// the calls are no-ops.
		for (const glob of PER_DEVICE_JSON_GLOBS) {
			try {
				await this.vaultClient.untrackPathGlob(glob);
			} catch (e) {
				log.warn("untrackPathGlob %s failed (non-fatal): %s", glob, (e as Error).message);
			}
		}

		// P2 fix — gitignore can re-allow `**/.jolli/summaries/*.json` but
		// can't express AllowList.ts's `[0-9a-f]{7,64}` filename
		// constraint. Walk every `.jolli/summaries/` we can find and
		// untrack files that don't match. Non-conforming entries can
		// only arrive from a peer device's pre-fix push, a user manually
		// dropping a file in, or a future FolderStorage bug — all rare
		// but worth defending against, especially because tracking a
		// `summaries/secret.json` would leak data with a misleading path.
		await this.untrackNonHashSummaries();
	}

	// Walks every <repo>/.jolli/summaries/ beneath memoryBankRoot and
	// quarantines files whose basename violates the hash filename
	// pattern. Non-conforming files are renamed to
	// <repo>/.jolli/quarantine-summaries/<basename> — which sits under
	// the §4 deny so it never syncs — and untracked from the index in
	// case a prior round committed them. Untracking alone wouldn't
	// stop the next stageAll / "git add --all" from re-adding them;
	// the rename is what removes them from the staging path.
	//
	// Skips entire directories whose mtime matches the last clean scan
	// recorded in `.memorybank-state.json`. POSIX/NTFS bump parent-dir
	// mtime on child create/rename/delete, so any newly-dropped file
	// invalidates the cache — there is no scenario where a non-hash
	// file lands in `summaries/` without bumping mtime. Sentinel is
	// only updated when the per-dir scan completed without errors;
	// any I/O hiccup leaves the dir in the "must rescan" set so the
	// next round retries.
	//
	// Errors are warned and swallowed so a single bad permissions /
	// filesystem hiccup doesn't break the whole round.
	private async untrackNonHashSummaries(): Promise<void> {
		const sentinelPath = join(this.memoryBankRoot, BOOTSTRAP_STATE_FILE);
		const previous = await readBootstrapState(sentinelPath);
		const scannedDirs: Record<string, number> = { ...(previous?.scannedDirs ?? {}) };
		let sentinelChanged = false;

		let repoDirs: string[];
		try {
			repoDirs = await readdir(this.memoryBankRoot);
		} catch {
			/* v8 ignore start -- ensureBootstrap always mkdir's memoryBankRoot before reaching here, so readdir failure requires a TOCTOU race the test fixture cannot reproduce */
			return;
			/* v8 ignore stop */
		}
		for (const repoName of repoDirs) {
			if (repoName.startsWith(".")) continue;
			const summariesDir = join(this.memoryBankRoot, repoName, ".jolli", "summaries");
			const relDir = relative(this.memoryBankRoot, summariesDir);

			let preStat: Awaited<ReturnType<typeof lstat>>;
			try {
				// `lstat`, not `stat` (plan §P2). If `summariesDir` itself is
				// a symlink — e.g. a hostile process replaced
				// `<repo>/.jolli/summaries` with a link to `/etc` — `stat`
				// would silently follow it and the subsequent `readdir` +
				// `rename` loop would scan and move files out of the link
				// target. Refusing on `isSymbolicLink()` is the only safe
				// option: the engine's own writer (FolderStorage) always
				// produces a real directory here, so anything else is a
				// tampered state we should not honour.
				//
				// `lstat` on the leaf still follows symlinks on intermediate
				// segments (I2) — a race process could `ln -s /etc <repo>`
				// or `ln -s /etc <repo>/.jolli` between the SymlinkSweep
				// (step 3a) and this scan (step 5) and the quarantine rename
				// would clobber the link target. Walk each intermediate
				// segment with `lstat` and bail on the first symlink.
				if (await intermediateContainsSymlink(this.memoryBankRoot, [repoName, ".jolli", "summaries"])) {
					log.warn(
						"Skipping summaries scan for %s — intermediate segment is a symlink, refusing to follow (plan §P2)",
						relDir,
					);
					continue;
				}
				preStat = await lstat(summariesDir);
			} catch {
				continue; // dir doesn't exist on this repo — fine
			}
			if (preStat.isSymbolicLink()) {
				log.warn("Skipping summaries scan for %s — path is a symlink, refusing to follow (plan §P2)", relDir);
				continue;
			}
			if (scannedDirs[relDir] === preStat.mtimeMs) {
				continue; // unchanged since last clean scan — skip
			}

			let entries: string[];
			try {
				entries = await readdir(summariesDir);
			} catch {
				/* v8 ignore start -- TOCTOU-only: lstat just succeeded one syscall ago, so reaching this catch requires the dir to be deleted between lstat and readdir. Tests can't deterministically reproduce that race. */
				continue;
				/* v8 ignore stop */
			}
			const quarantineDir = join(this.memoryBankRoot, repoName, ".jolli", "quarantine-summaries");
			let quarantineEnsured = false;
			let scanErrored = false;
			for (const file of entries) {
				if (SUMMARY_HASH_FILENAME.test(file)) continue;
				const src = join(summariesDir, file);
				const dst = join(quarantineDir, file);
				const relPath = relative(this.memoryBankRoot, src);
				try {
					if (!quarantineEnsured) {
						// Mirror the §P2 check we did on `summaries/`: a hostile
						// process can swap `<repo>/.jolli/quarantine-summaries`
						// (or any intermediate segment) for a symlink between
						// the SymlinkSweep step 3a and this mkdir+rename. We'd
						// then move attacker-chosen files into the link target
						// outside the vault.
						/* v8 ignore start -- defense-in-depth: if `<repo>/.jolli` itself is a symlink, the summaries-side `intermediateContainsSymlink` check at L342 already bailed; this branch only fires under a race where the link is planted between that check and this one (CX1 §P2 follow-up) */
						if (
							await intermediateContainsSymlink(this.memoryBankRoot, [
								repoName,
								".jolli",
								"quarantine-summaries",
							])
						) {
							log.warn(
								"Skipping quarantine for %s — quarantine path intermediate is a symlink (plan §P2)",
								relDir,
							);
							scanErrored = true;
							break;
						}
						/* v8 ignore stop */
						const existingDst = await lstat(quarantineDir).catch(() => null);
						if (existingDst?.isSymbolicLink()) {
							log.warn(
								"Skipping quarantine for %s — quarantine-summaries is a symlink (plan §P2)",
								relDir,
							);
							scanErrored = true;
							break;
						}
						await mkdir(quarantineDir, { recursive: true });
						quarantineEnsured = true;
					}
					// TOCTOU recheck: confirm the destination leaf is still not
					// a symlink immediately before `rename` clobbers it.
					const dstStat = await lstat(dst).catch(() => null);
					if (dstStat?.isSymbolicLink()) {
						log.warn("Skipping %s — quarantine destination is a symlink (plan §P2)", relPath);
						scanErrored = true;
						continue;
					}
					await rename(src, dst);
					log.warn("Quarantined non-hash summary file: %s → %s", relPath, relative(this.memoryBankRoot, dst));
					// Also untrack the original path in case it was committed
					// in a previous round. `--ignore-unmatch` keeps this safe
					// when the index never had it.
					try {
						await this.vaultClient.untrackPathGlob(relPath);
					} catch (e) {
						log.warn("Quarantined %s but untrack failed (non-fatal): %s", relPath, (e as Error).message);
					}
				} catch (e) {
					scanErrored = true;
					log.warn("Failed to quarantine non-hash summary %s (non-fatal): %s", relPath, (e as Error).message);
				}
			}

			// Only update the sentinel for dirs whose scan completed without
			// errors. Re-stat AFTER the loop because quarantines (renames)
			// bump the parent-dir mtime; we need to record the post-scan
			// value so the next round's pre-stat compares equal.
			if (!scanErrored) {
				try {
					// Keep using `lstat` here for parity with the pre-scan
					// check — if the path turned into a symlink mid-round
					// (improbable but cheap to defend against), we must not
					// record the link's mtime as if it were the directory's.
					const postStat = await lstat(summariesDir);
					/* v8 ignore start -- defensive: a path that was a directory at pre-stat shouldn't turn into a symlink mid-round; this branch exists only to prevent the sentinel from recording a link's mtime if a hostile process did the swap */
					if (postStat.isSymbolicLink()) {
						// Don't update the sentinel — leave it so the next
						// round re-detects and warns.
					} else if (scannedDirs[relDir] !== postStat.mtimeMs) {
						/* v8 ignore stop */
						scannedDirs[relDir] = postStat.mtimeMs;
						sentinelChanged = true;
					}
				} catch {
					// Dir vanished mid-scan — leave sentinel untouched so we
					// rescan next round if it reappears.
				}
			}
		}

		if (sentinelChanged) {
			try {
				const next: BootstrapState = { version: BOOTSTRAP_STATE_VERSION, scannedDirs };
				await writeFile(sentinelPath, JSON.stringify(next));
			} catch (e) {
				log.warn("Failed to persist bootstrap state (non-fatal): %s", (e as Error).message);
			}
		}
	}

	/* v8 ignore next 6 -- exposed for diagnostics only, not in hot path */
	async statBootstrap(): Promise<{ gitignoreExists: boolean }> {
		const gitignorePath = join(this.memoryBankRoot, ".gitignore");
		// `lstat` to stay consistent with the rest of the bootstrap (plan
		// §P2). For a normal file this is identical to `stat`; for a
		// symlink it correctly reports "exists at this path" without
		// following — which is what a diagnostics method should do anyway.
		const gitignoreExists = await lstat(gitignorePath).then(
			() => true,
			() => false,
		);
		return { gitignoreExists };
	}
}

/**
 * Builds the expected `.gitignore` body for the given `syncTranscripts`
 * toggle. Exported for testing.
 */
export function buildGitignore(syncTranscripts: boolean): string {
	const trailer = syncTranscripts ? GITIGNORE_TRANSCRIPTS_ALLOW : GITIGNORE_TRANSCRIPTS_DENY;
	return GITIGNORE_BASE + trailer;
}

/**
 * Reads `<memoryBankRoot>/.memorybank-state.json`. Returns `null` on
 * missing file, parse error, or unknown version — the caller treats null
 * as "scan everything from scratch", so any corruption is self-healing.
 */
async function readBootstrapState(sentinelPath: string): Promise<BootstrapState | null> {
	try {
		const raw = await readFile(sentinelPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<BootstrapState>;
		if (parsed.version !== BOOTSTRAP_STATE_VERSION) return null;
		/* v8 ignore next -- defensive: shape guard for a future bootstrap-state schema variant; covered by version-mismatch return above for any reasonable corruption case */
		if (typeof parsed.scannedDirs !== "object" || parsed.scannedDirs === null) return null;
		return parsed as BootstrapState;
	} catch {
		return null;
	}
}
