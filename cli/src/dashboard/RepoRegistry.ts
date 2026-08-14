/**
 * RepoRegistry — the durable list of Jolli-enabled repos on this machine.
 *
 * Lives at `~/.jolli/jollimemory/dashboard-repos.json`, deliberately OUTSIDE
 * the dashboard database. `jollimemory.db` is a derived read model that any of
 * bootstrap, gap recovery or a user can throw away; rebuilding it for every
 * repo needs a persistent list of "which repos are enabled, and where are their
 * worktrees". If that list lived only in the DB, deleting the DB would make the
 * multi-repo rebuild impossible — the `repos` table is a projection *of* this
 * file, never the other way round.
 *
 * It is machine-global rather than per-repo for the same reason: no single
 * repo's Memory Bank folder can own the list of all the others, and the Memory
 * Bank root is user-retargetable while this list must not move with it.
 *
 * Identity: a normalized remote URL when the repo has one, otherwise a hash of
 * the main-worktree path. The known limitation of the fallback is that moving a
 * local-only repo's directory changes its identity; `worktree_root` existence
 * filtering plus set reconciliation converge on that rather than pretending it
 * cannot happen.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../core/AtomicJsonFile.js";
import { getProjectRootDir } from "../core/GitOps.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import { withRepoRegistryLock } from "../core/Locks.js";
import { normalizePathForCompareOn, toForwardSlash } from "../core/PathUtils.js";
import { getGlobalConfigDir } from "../core/SessionTracker.js";
import { createLogger, errMsg, isEnoent } from "../Logger.js";

const log = createLogger("RepoRegistry");

const REGISTRY_FILE = "dashboard-repos.json";

/** One registered repo. Mirrors the `repos` table's identity columns. */
export interface RegisteredRepo {
	readonly repoIdentity: string;
	readonly repoName: string;
	/**
	 * The most recently registered main-worktree path — the one shown in the UI.
	 *
	 * NOT the only place to collect from: see {@link worktrees}. Identity is the
	 * normalized remote, so two clones of the same project share one entry and
	 * this field alone would silently hide whichever registered first.
	 */
	readonly worktreeRoot: string;
	/**
	 * Every main-worktree path known for this project, newest last.
	 *
	 * Kept here rather than in the database for the same reason the registry
	 * itself is (§4.3): rebuilding a deleted database needs to know where this
	 * project's checkouts are, so that list cannot live only inside the thing
	 * being rebuilt. Absent on entries written before this field existed —
	 * readers must fall back to `[worktreeRoot]`.
	 */
	readonly worktrees?: ReadonlyArray<string>;
	readonly remoteUrl?: string;
	readonly enabledAt: string;
	/** Set when the repo is disabled. Rows are kept so history stays queryable. */
	readonly disabledAt?: string;
}

/**
 * Whether two recorded paths name the same checkout.
 *
 * The spelling of a recorded path is inherited from whatever `cwd` the caller
 * passed: `getProjectRootDir` ends in `resolve(cwd, …)`, which preserves the
 * caller's drive-letter case. The callers are different surfaces — a
 * PowerShell `jolli`, the ide-bridge, a git hook launched by a GUI client —
 * and they do not agree on it. So a raw `!==` recorded `C:\…` and `c:\…` as
 * two checkouts of one clone, and every {@link existingWorktrees} consumer
 * then did the same idempotent work twice (the hook sync in
 * `SettingsMutations`, the backfill sweep). The cutover is the one consumer
 * already immune: `collectSources` keys on `realpath` of the common dir.
 *
 * Comparison ONLY — the stored value keeps the spelling git reported, so a
 * path recorded here still matches what a later `git status` prints.
 *
 * The platform is a parameter for the same reason `normalizePathForCompareOn`
 * takes one: case folds on win32/darwin and not on Linux, so a test asserting
 * the drive-letter case cannot leave that to the host it runs on.
 */
export function sameRecordedRoot(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
	return normalizePathForCompareOn(a, platform) === normalizePathForCompareOn(b, platform);
}

/**
 * Every worktree of a repo that still exists on disk, newest first.
 *
 * Tolerates entries written before `worktrees` existed (falls back to
 * `worktreeRoot`) and drops paths that have since been deleted or moved — which
 * is also what stops a relocated local-only repo from stranding its old path.
 */
export function existingWorktrees(repo: RegisteredRepo): ReadonlyArray<string> {
	const known = repo.worktrees && repo.worktrees.length > 0 ? repo.worktrees : [repo.worktreeRoot];
	const alive = [...known].reverse().filter((path) => existsSync(path));
	// Never return empty while the repo is registered: a caller that would then
	// collect nothing is better off trying the recorded path and failing loudly
	// in git than silently sweeping zero worktrees.
	return alive.length > 0 ? alive : [repo.worktreeRoot];
}

/**
 * Whether ANY checkout of this repo still exists on disk.
 *
 * The companion to {@link existingWorktrees}' deliberate non-empty fallback: a
 * caller that only wants to know "is this entry still backed by anything?"
 * cannot read that off the returned list, because the fallback makes a repo
 * whose every path is gone look identical to one with a single live checkout.
 *
 * The registry is append-only in practice — nothing prunes it, and
 * `deregisterRepo` has to run from inside the repo it removes, which a deleted
 * directory makes impossible — so dead entries accumulate and every sweep pays
 * for them again. Asking this first is how a sweep tells "gone" from "broken".
 */
export function hasLiveWorktree(repo: RegisteredRepo): boolean {
	const known = repo.worktrees && repo.worktrees.length > 0 ? repo.worktrees : [repo.worktreeRoot];
	return known.some((path) => existsSync(path));
}

/**
 * The repo's cutover fence, found by asking EVERY surviving checkout — plus the
 * root it was found in, which is the only one whose orphan branch is the frozen
 * one.
 *
 * "Is this repo fenced?" is a repo-level question and must never be asked of a
 * single checkout. `worktrees` holds the main roots of DISTINCT CLONES (both
 * writers normalize through `getProjectRootDir`, so linked worktrees of one
 * clone collapse to one entry), while `profile.json` is repo-wide only WITHIN a
 * clone (`RepoProfile` anchors it to `dirname(git-common-dir)`). And
 * {@link existingWorktrees} returns newest-first. So a repo cut over in clone A
 * and later cloned into B answers "no fence" to anyone who asks `roots[0]` —
 * which is B.
 *
 * Every consequence of that is silent and lands on a fenced repo's newest data:
 * a `catch-up` import with `protectNewerThanMs` omitted does not fail, it
 * OVERWRITES — the mirror's hidden JSON stopped being written at the freeze, so
 * importing it unprotected reverts every memory regenerated since (during
 * `doctor --recover`, when there is no other copy) — and the frozen-orphan fill
 * simply `continue`s past a repo it was the last resort for.
 *
 * Earliest fence wins when several clones carry one: the widest protection
 * window, i.e. the direction that reverts least. Callers that need to READ the
 * frozen branch must use the returned `root`, not `roots[0]` — a fresh clone
 * has no orphan branch to resolve at all.
 */
export async function readRepoCutoverFence(
	repo: RegisteredRepo,
): Promise<{ root: string; at: string; atMs: number } | null> {
	const { readCutoverFence } = await import("../core/RepoProfile.js");
	let best: { root: string; at: string; atMs: number } | null = null;
	for (const root of existingWorktrees(repo)) {
		const fence = await readCutoverFence(root).catch(() => null);
		if (!fence) continue;
		const atMs = Date.parse(fence.at);
		const candidate = { root, at: fence.at, atMs };
		if (best === null) {
			best = candidate;
			continue;
		}
		// An unparsable stamp still proves the repo IS fenced, it just cannot date
		// the protection — so a clone that CAN date it outranks one that cannot,
		// and among those the earliest wins.
		if (Number.isFinite(atMs) && (!Number.isFinite(best.atMs) || atMs < best.atMs)) best = candidate;
	}
	return best;
}

export interface RepoRegistryFile {
	readonly version: 1;
	readonly repos: ReadonlyArray<RegisteredRepo>;
	/**
	 * The database's identity (schema_meta 'instance-id'), stamped here so an
	 * ABSENT database can be classified: an id here matching the mirror's
	 * proves deletion; a mismatch is residue for doctor --recover. Presence
	 * alone proves nothing — this file survives the database independently.
	 */
	readonly instanceId?: string;
}

const EMPTY: RepoRegistryFile = { version: 1, repos: [] };

/** Absolute path of the registry file. */
export function getRepoRegistryPath(configDir: string = getGlobalConfigDir()): string {
	return join(configDir, REGISTRY_FILE);
}

/**
 * Reads the registry, returning an empty one when it does not exist yet or is
 * unparseable. A corrupt registry must not brick the dashboard: the file is
 * rebuildable by re-running `jolli enable`, whereas throwing here would take
 * down every read path with it.
 */
export async function readRepoRegistry(configDir?: string): Promise<RepoRegistryFile> {
	try {
		return await readRepoRegistryStrict(configDir);
	} catch (err) {
		log.warn("repo registry unreadable (%s) — treating as empty", errMsg(err));
		return EMPTY;
	}
}

/**
 * The same read, but it THROWS on a registry it could not read.
 *
 * Every writer below is a read-modify-write over the returned value, so a read
 * that fails open is not a graceful degradation there — it is a delete. One
 * transient EACCES / EMFILE / Windows AV hold, or a single truncated file, and
 * the next `registerRepo` writes back a registry containing only the repo it
 * happens to be handling, dropping every other repo AND `instanceId`. The
 * damage is silent and lands where it hurts most: `readRegistryInstanceId`
 * returns null, so `classifyIdentity` calls a genuinely deleted database a
 * `fresh-install` and suppresses the alarm, while `doctor --recover` iterates
 * none of the lost repos. Failing the one operation is strictly better.
 *
 * "Absent" is NOT a failure: a registry that does not exist yet is genuinely
 * empty, and that is the case the fail-open contract was written for.
 */
export async function readRepoRegistryStrict(configDir?: string): Promise<RepoRegistryFile> {
	const path = getRepoRegistryPath(configDir);
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (err) {
		if (isEnoent(err)) return EMPTY;
		throw err;
	}
	const raw = JSON.parse(text) as RepoRegistryFile;
	if (!Array.isArray(raw?.repos)) throw new Error(`repo registry at ${path} has no repos array`);
	return {
		version: 1,
		repos: raw.repos,
		// Preserve the identity stamp: every registry rewrite goes through a
		// read-modify-write, and dropping it here would erase the deletion
		// detector's witness on the next repo registration.
		...(typeof raw.instanceId === "string" && { instanceId: raw.instanceId }),
	};
}

/** Writes the registry with user-only permissions (it lists local paths). */
async function writeRepoRegistry(file: RepoRegistryFile, configDir?: string): Promise<void> {
	// Atomic: a torn write reads back as corrupt JSON, and the very next writer
	// would cement that loss through its read-modify-write (see
	// `readRepoRegistryStrict`). This file outranks `profile.json`, which has
	// used temp+rename for the same reason since it shipped.
	await writeFileAtomic(getRepoRegistryPath(configDir), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

/** Records the database's instance id; no-op when already current. */
export async function stampRegistryInstanceId(id: string, configDir?: string): Promise<void> {
	await withRepoRegistryLock(
		async () => {
			const registry = await readRepoRegistryStrict(configDir);
			if (registry.instanceId === id) return;
			await writeRepoRegistry({ ...registry, instanceId: id }, configDir);
		},
		{ globalDir: configDir },
	);
}

/** The stamped database identity, or null on a registry that predates it. */
export async function readRegistryInstanceId(configDir?: string): Promise<string | null> {
	return (await readRepoRegistry(configDir)).instanceId ?? null;
}

/**
 * Derives a stable identity for the repo rooted at `worktreeRoot`.
 *
 * Prefers the normalized remote URL so the same repo cloned to two paths (or
 * checked out as several worktrees) is one identity. Falls back to a hash of
 * the forward-slashed main-worktree path — hashed rather than stored raw so the
 * identity is a fixed-width opaque key like the remote-derived one, and so a
 * path with a username in it does not become a primary key echoed into every
 * table.
 */
export async function resolveRepoIdentity(worktreeRoot: string): Promise<{ identity: string; remoteUrl?: string }> {
	try {
		const remote = await getCanonicalRepoUrl(worktreeRoot);
		// `getCanonicalRepoUrl` never returns empty: with no `origin` it falls
		// back to `file://<path>`. That fallback is NOT a usable identity here —
		// it would embed the absolute worktree path (and the user's home
		// directory) as a primary key echoed into every table. Detect it and take
		// the hashed-path branch instead.
		if (remote && !remote.startsWith("file:")) {
			return { identity: remote, remoteUrl: remote };
		}
	} catch (err) {
		// git missing or not a repo. Local-only repos are a supported case, so
		// this is a debug note rather than a warning.
		log.debug("no canonical remote for %s (%s) — using path identity", worktreeRoot, errMsg(err));
	}
	const hash = createHash("sha256").update(toForwardSlash(worktreeRoot)).digest("hex").slice(0, 32);
	return { identity: `local:${hash}` };
}

/**
 * The identity for the repo CONTAINING `cwd` — the form every consumer wants.
 *
 * {@link resolveRepoIdentity} takes a main-worktree ROOT, and on the remote-less
 * branch it hashes exactly the path it is handed. So calling it with a raw cwd
 * is only accidentally correct: for a repo with no usable remote it produces a
 * different `local:<hash>` for a linked worktree (and for any subdirectory that
 * a caller passed straight through) than the one `registerRepo` wrote. The two
 * then disagree about what is registered — post-cutover that means
 * `resolveCutoverRoute` finds the fence but no row, routes to `legacy-fenced`,
 * and the resulting `SqliteStorage` refuses every write while the orphan branch
 * is frozen shut: the memory has nowhere to go.
 *
 * Every caller that starts from a cwd rather than a known root must use this.
 * `registerRepo`/`deregisterRepo` below and `ProducerHooks.repoIdentityFor`
 * already did the same two steps by hand; this is that pair, named once.
 */
export async function resolveRepoIdentityForCwd(cwd: string): Promise<{ identity: string; remoteUrl?: string }> {
	return resolveRepoIdentity(await getProjectRootDir(cwd));
}

/** Human-facing repo name: the remote's repo name, else the directory name. */
export function deriveRepoName(worktreeRoot: string, remoteUrl?: string): string {
	if (remoteUrl) {
		const fromUrl = deriveRepoNameFromUrl(remoteUrl);
		if (fromUrl) return fromUrl;
	}
	const parts = toForwardSlash(worktreeRoot).replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || worktreeRoot;
}

export interface RegisterRepoOptions {
	/** Any directory inside the repo; resolved to the main worktree root. */
	readonly cwd: string;
	readonly configDir?: string;
	/** Injected clock, so tests get a fixed `enabledAt`. */
	readonly now?: () => Date;
}

/**
 * Registers (or refreshes) the repo containing `cwd` and returns its entry.
 *
 * Anchored to the MAIN worktree root via `getProjectRootDir`, so enabling Jolli
 * in a linked worktree updates the existing row instead of creating a second
 * identity for the same repository. Re-registering an entry that was disabled
 * clears `disabledAt` — an explicit re-enable is exactly the signal that should
 * reactivate it.
 */
export async function registerRepo(opts: RegisterRepoOptions): Promise<RegisteredRepo> {
	const worktreeRoot = await getProjectRootDir(opts.cwd);
	const { identity, remoteUrl } = await resolveRepoIdentity(worktreeRoot);
	const now = (opts.now ?? (() => new Date()))().toISOString();
	return withRepoRegistryLock(
		async () => {
			// Re-read INSIDE the lock: a concurrent registrar's write between our
			// git resolution above and here must not be lost-updated by ours.
			const registry = await readRepoRegistryStrict(opts.configDir);
			const existing = registry.repos.find((r) => r.repoIdentity === identity);
			// Union rather than replace: two clones of one remote share an identity, and
			// overwriting would leave the other clone's commits uncollected with nothing to
			// show that it had been dropped. Existing paths are preserved in order, the new
			// one moves to the end (newest), and vanished paths are filtered on read.
			//
			// Matched with `sameRecordedRoot`, not `!==`: a re-registration that spells
			// this checkout differently must REPLACE the old spelling rather than add a
			// second entry for it. Appending the new one last is what makes the freshest
			// spelling win.
			const previous = existing?.worktrees ?? (existing ? [existing.worktreeRoot] : []);
			const worktrees = [...previous.filter((path) => !sameRecordedRoot(path, worktreeRoot)), worktreeRoot];
			const entry: RegisteredRepo = {
				repoIdentity: identity,
				repoName: deriveRepoName(worktreeRoot, remoteUrl),
				worktreeRoot,
				worktrees,
				...(remoteUrl ? { remoteUrl } : {}),
				enabledAt: existing?.enabledAt ?? now,
			};
			const repos = [...registry.repos.filter((r) => r.repoIdentity !== identity), entry];
			await writeRepoRegistry({ ...registry, version: 1, repos }, opts.configDir);
			return entry;
		},
		{ globalDir: opts.configDir },
	);
}

/**
 * Adds `cwd`'s main worktree root to its identity's `worktrees` list and
 * touches NOTHING else — most importantly `disabledAt`, which `registerRepo`
 * clears by rebuilding the entry. This is the hook self-registration path for
 * a SECOND clone of an already-known remote: two clones share one identity, so
 * "identity already registered" says nothing about whether THIS checkout is
 * listed, and a checkout the list never learns is structurally invisible to
 * the cutover's source enumeration — its orphan branch would be neither
 * imported nor fenced. A stray hook must be able to fill that gap without
 * being able to undo a `jolli disable`.
 */
export async function ensureWorktreeListed(opts: RegisterRepoOptions): Promise<RegisteredRepo | null> {
	const worktreeRoot = await getProjectRootDir(opts.cwd);
	const { identity } = await resolveRepoIdentity(worktreeRoot);
	return withRepoRegistryLock(
		async () => {
			const registry = await readRepoRegistryStrict(opts.configDir);
			const existing = registry.repos.find((r) => r.repoIdentity === identity);
			// No entry to extend: the identity-unknown case belongs to registerRepo,
			// which builds the full row. Racing a concurrent deregister here is fine —
			// a disabled entry still gets the worktree listed (data, not activation).
			if (!existing) return null;
			const previous =
				existing.worktrees && existing.worktrees.length > 0 ? existing.worktrees : [existing.worktreeRoot];
			// `sameRecordedRoot`, not `includes`: a checkout already listed under a
			// different spelling is already listed. Returning `existing` unchanged is
			// also what keeps this function's "adds, never rewrites" contract — the
			// freshest spelling is `registerRepo`'s business, not a stray hook's.
			if (previous.some((path) => sameRecordedRoot(path, worktreeRoot))) return existing;
			const entry: RegisteredRepo = { ...existing, worktrees: [...previous, worktreeRoot] };
			const repos = [...registry.repos.filter((r) => r.repoIdentity !== identity), entry];
			await writeRepoRegistry({ ...registry, version: 1, repos }, opts.configDir);
			return entry;
		},
		{ globalDir: opts.configDir },
	);
}

/**
 * Marks the repo containing `cwd` disabled, keeping its row and its data.
 *
 * Deliberately not a delete: a user who disables Jolli in one repo has not
 * asked to erase that repo's history from their dashboard, and re-enabling
 * should not have to re-import it. Returns the identity it disabled, or null
 * when the repo was never registered.
 */
export async function deregisterRepo(opts: RegisterRepoOptions): Promise<string | null> {
	const worktreeRoot = await getProjectRootDir(opts.cwd);
	const { identity } = await resolveRepoIdentity(worktreeRoot);
	const now = (opts.now ?? (() => new Date()))().toISOString();
	return withRepoRegistryLock(
		async () => {
			const registry = await readRepoRegistryStrict(opts.configDir);
			const existing = registry.repos.find((r) => r.repoIdentity === identity);
			if (!existing) return null;
			const repos = registry.repos.map((r) => (r.repoIdentity === identity ? { ...r, disabledAt: now } : r));
			await writeRepoRegistry({ ...registry, version: 1, repos }, opts.configDir);
			return identity;
		},
		{ globalDir: opts.configDir },
	);
}

/** Registered repos that are not disabled. */
export async function listActiveRepos(configDir?: string): Promise<ReadonlyArray<RegisteredRepo>> {
	return (await readRepoRegistry(configDir)).repos.filter((r) => !r.disabledAt);
}
