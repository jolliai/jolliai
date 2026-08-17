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
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
 * The paths this entry claims, tolerating entries written before `worktrees`
 * existed — the whole claim, live or not.
 *
 * Naming the fallback once is what stops its consumers disagreeing about it:
 * {@link existingWorktrees} wants the live subset, {@link hasLiveWorktree} wants
 * "any of them", {@link isDisposableRepo} wants "all of them", and `RepoForget`
 * asks which volume each one is on.
 */
export function recordedRepoPaths(repo: RegisteredRepo): ReadonlyArray<string> {
	return repo.worktrees && repo.worktrees.length > 0 ? repo.worktrees : [repo.worktreeRoot];
}

/**
 * Every worktree of a repo that still exists on disk, newest first.
 *
 * Tolerates entries written before `worktrees` existed (falls back to
 * `worktreeRoot`) and drops paths that have since been deleted or moved — which
 * is also what stops a relocated local-only repo from stranding its old path.
 */
export function existingWorktrees(repo: RegisteredRepo): ReadonlyArray<string> {
	const alive = [...recordedRepoPaths(repo)].reverse().filter((path) => existsSync(path));
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
 * Dead entries are REMOVABLE but not automatically removed: `deregisterRepo`
 * has to run from inside the repo it removes, which a deleted directory makes
 * impossible, so the identity-addressed `forgetRepo` (see `RepoForget.ts`) is
 * what reaches them — automatically for the narrow {@link isDisposableRepo}
 * class, and only on request for everything else. A sweep still meets dead
 * entries in between, so asking this first is how it tells "gone" from "broken".
 */
export function hasLiveWorktree(repo: RegisteredRepo): boolean {
	return recordedRepoPaths(repo).some((path) => existsSync(path));
}

/** Prefix of the path-hashed identity a repo with no usable remote falls back to. */
export const LOCAL_IDENTITY_PREFIX = "local:";

/**
 * The temp roots a recorded path may legitimately sit under.
 *
 * Both spellings, because they are produced by different halves of the same
 * flow: `os.tmpdir()` answers `/var/folders/…` on macOS while every path this
 * registry stores came from `git rev-parse --show-toplevel`, which resolves the
 * `/var` → `private/var` symlink and reports `/private/var/folders/…`. Matching
 * only the first makes {@link isDisposableRepo} answer `false` for every macOS
 * fixture — silently, since "not disposable" is also the answer for a real repo.
 *
 * Known residual: a Windows path recorded in 8.3 short form (`APPDAT~1`) does
 * not match the long `%TEMP%`. Such an entry is simply never auto-pruned, which
 * is the safe direction — `jolli doctor --fix` still reaches it.
 */
export function tempRoots(): ReadonlyArray<string> {
	const raw = tmpdir();
	const roots = new Set<string>([raw]);
	try {
		roots.add(realpathSync(raw));
		/* v8 ignore start -- `os.tmpdir()` not being resolvable means the machine has
		   no usable temp directory at all; kept so this cannot be the thing that
		   throws, but there is no state a test can put the host in to reach it */
	} catch (err) {
		// A temp dir that cannot be resolved is still a temp dir; the raw spelling
		// is what most callers will match anyway.
		log.debug("could not resolve the real path of %s: %s", raw, errMsg(err));
	}
	/* v8 ignore stop */
	return [...roots];
}

export interface DisposableRepoOptions {
	/** Defaults to {@link tempRoots}; a test names them so it needs no real temp dir. */
	readonly tempRoots?: ReadonlyArray<string>;
	/** Same contract as {@link sameRecordedRoot}'s: never a guess about the host. */
	readonly platform?: NodeJS.Platform;
}

/** True when `path` is `root` or lives under it, for the named platform. */
function isUnder(path: string, root: string, platform: NodeJS.Platform): boolean {
	const p = normalizePathForCompareOn(path, platform);
	const r = normalizePathForCompareOn(root, platform);
	return p === r || p.startsWith(`${r}/`);
}

/**
 * Segments that mark a temp directory as a throwaway THIS machine created.
 *
 * `jolli-` is the mkdtemp prefix every fixture in this repo uses
 * (`jolli-cutover-…`, `jolli-autocut-…`), and `scratchpad` is the tree an agent
 * session works in. Both are conventions rather than guarantees, which is why
 * they only ever RELAX the identity clause and never the other two — see
 * {@link isDisposableRepo}.
 */
const FIXTURE_SEGMENTS = ["jolli-", "scratchpad"] as const;

/**
 * Whether the part of `path` BELOW `root` names a throwaway directory.
 *
 * Relative to the root on purpose. The absolute form would match the root's own
 * name, and a test that injects its own `tempRoots` — a `jolli-forget-…` mkdtemp
 * dir, say — would then see every fixture inside it marked, which is exactly the
 * distinction being tested. Relative, the same path is a fixture when measured
 * against the real `%TEMP%` and an ordinary directory when measured against the
 * throwaway it already lives in.
 */
function isFixturePathUnder(path: string, root: string, platform: NodeJS.Platform): boolean {
	const p = normalizePathForCompareOn(path, platform);
	const r = normalizePathForCompareOn(root, platform);
	if (!p.startsWith(`${r}/`)) return false;
	return p
		.slice(r.length + 1)
		.split("/")
		.some((segment) => FIXTURE_SEGMENTS.some((mark) => segment.startsWith(mark)));
}

/**
 * Whether this entry is high-confidence garbage that may be removed WITHOUT
 * asking — a fixture or scratch checkout under the system temp directory whose
 * every recorded path is gone.
 *
 * Two clauses always hold, and a third decides what an identity has to prove:
 *
 * 1. **Every recorded path under a temp root.** The union of `worktreeRoot` and
 *    `worktrees`, not just the live subset — an entry with one temp path and one
 *    real one is a real repo that was once opened from a scratch checkout, which
 *    is exactly the shape a fixture leak leaves behind.
 * 2. **No path left on disk.** A user working under `%TEMP%` right now has a
 *    working repo, and a sweep must not delete the history of a session in
 *    progress. The SAME union as clause 1, never {@link hasLiveWorktree}: this
 *    function deletes data, so having declined to trust `registerRepo`'s
 *    "`worktreeRoot` is inside `worktrees`" invariant for the clause that decides
 *    whether an entry is IN SCOPE, it cannot go on to rely on it for the clause
 *    that decides whether the entry is ALIVE — an entry whose `worktrees` omitted
 *    a live `worktreeRoot` would be pruned with its own checkout on disk.
 * 3. **A `local:` identity, OR every path names a known throwaway directory.**
 *
 * Clause 3 is the only inference here, and it is drawn where it is because the
 * two halves are not equally safe. A `local:` identity is the sha256 of ONE
 * path, so it cannot be shared and removing it structurally cannot touch
 * anything else. A remote-backed identity IS shared — the `repos` row is keyed
 * by it, so every clone of that remote answers to the same row — and "no other
 * clone exists on this machine" can only be inferred from paths that record the
 * last registrar. {@link FIXTURE_SEGMENTS} is what makes that inference narrow
 * enough to act on: a vanished `%TEMP%/jolli-cutover-…/repo` is a fixture
 * whichever remote it was cloned from. A vanished temp path with no such marker
 * still needs a human, and `jolli doctor --fix` is where it goes.
 *
 * The state `DbBackfill` deliberately refuses to act on — "temporarily
 * unmounted" (network share, external drive) — cannot arise under any of them: a
 * temp root is local by construction, so "gone" really does mean gone.
 */
export function isDisposableRepo(repo: RegisteredRepo, opts: DisposableRepoOptions = {}): boolean {
	const roots = opts.tempRoots ?? tempRoots();
	const platform = opts.platform ?? process.platform;
	// Deduped: `recordedRepoPaths` falls back to `[worktreeRoot]` on an entry with
	// no `worktrees`, which would otherwise make the union `[root, root]` and read
	// as a typo.
	const claimed = [...new Set([repo.worktreeRoot, ...recordedRepoPaths(repo)])];
	if (!claimed.every((path) => roots.some((root) => isUnder(path, root, platform)))) return false;
	if (
		!repo.repoIdentity.startsWith(LOCAL_IDENTITY_PREFIX) &&
		!claimed.every((path) => roots.some((root) => isFixturePathUnder(path, root, platform)))
	) {
		return false;
	}
	return !claimed.some((path) => existsSync(path));
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
	return { identity: `${LOCAL_IDENTITY_PREFIX}${hash}` };
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

/**
 * Removes entries by IDENTITY, returning the identities that were actually
 * present — the half `deregisterRepo` structurally cannot do.
 *
 * `deregisterRepo` resolves its target by asking `cwd` (`getProjectRootDir` then
 * `resolveRepoIdentity`), so a checkout that no longer exists can never be
 * named; and its remedy — stamp `disabledAt` — is the wrong one anyway, since a
 * disabled entry is still an entry. Both survive because they answer different
 * questions: this is "forget it", `deregisterRepo` is `jolli disable`.
 *
 * Batched deliberately. The prune sweep has 85 victims on a machine that ran the
 * test suite before HOME isolation became the default, and one lock plus one
 * atomic write is the difference between that and 85 read-modify-write cycles
 * racing every other registrar. It also makes the sweep's registry half
 * all-or-nothing, which is what `forgetRepos`' ordering contract wants.
 *
 * Callers must delete the database rows FIRST — see `forgetRepos`.
 */
export async function removeReposFromRegistry(
	identities: ReadonlyArray<string>,
	configDir?: string,
): Promise<ReadonlyArray<string>> {
	if (identities.length === 0) return [];
	const wanted = new Set(identities);
	return withRepoRegistryLock(
		async () => {
			// Strict, not the fail-open read: this is a read-modify-write, and a
			// registry that failed open here would be written back as "everything
			// except the ones I meant to remove" — i.e. every other repo deleted. See
			// `readRepoRegistryStrict`.
			const registry = await readRepoRegistryStrict(configDir);
			const removed = registry.repos.filter((r) => wanted.has(r.repoIdentity)).map((r) => r.repoIdentity);
			if (removed.length === 0) return [];
			await writeRepoRegistry(
				{ ...registry, version: 1, repos: registry.repos.filter((r) => !wanted.has(r.repoIdentity)) },
				configDir,
			);
			return removed;
		},
		{ globalDir: configDir },
	);
}

/** {@link removeReposFromRegistry} for one identity; true when it was present. */
export async function removeRepoFromRegistry(identity: string, configDir?: string): Promise<boolean> {
	return (await removeReposFromRegistry([identity], configDir)).length > 0;
}

export interface RegistryRepairOptions extends DisposableRepoOptions {
	readonly configDir?: string;
	/**
	 * Compute the repairs and write nothing.
	 *
	 * What makes `doctor --dry-run` honest about this half: the removals can be
	 * previewed from a survey, but a path repair is only knowable by running the
	 * same pass that would apply it, and a preview computed by different code is
	 * a second implementation of the rule.
	 *
	 * Also takes NO registry lock — see the tail of {@link repairRegistryEntries}.
	 */
	readonly dryRun?: boolean;
}

/** What {@link repairRegistryEntries} changed about one entry. */
export interface RegistryRepair {
	readonly repoIdentity: string;
	/** Temp-only paths that no longer exist, removed from `worktrees`. */
	readonly droppedPaths: ReadonlyArray<string>;
	/** Alternate spellings of a path the entry already listed (`C:` vs `c:`). */
	readonly collapsedPaths: ReadonlyArray<string>;
	/** Set when `worktreeRoot` named a dead path and a live one took over. */
	readonly repointedTo?: string;
}

/**
 * Repairs entries that are partly wrong rather than wholly dead — the state a
 * removal cannot express.
 *
 * Three edits, and the two it deliberately does NOT make are the interesting part:
 *
 * 1. **Drops a recorded path that is gone AND under a temp root.** That is the
 *    shape a real repo picks up from a fixture leak: a genuine `worktreeRoot`
 *    with two `%TEMP%/jolli-cutover-…/repo` paths merged into its `worktrees`.
 * 2. **Collapses alternate spellings** with {@link sameRecordedRoot}, newest
 *    spelling winning — the same rule and the same tie-break `registerRepo`
 *    applies when it re-registers a checkout. So a `C:` / `c:` pair that has not
 *    been re-registered since is fixed here, and cannot regrow afterwards.
 * 3. **Repoints `worktreeRoot`** to the newest live path when the recorded one is
 *    gone. That field is what every surface displays, so a dead value makes a
 *    working repo look broken.
 *
 * NOT dropped: a dead path that is not under a temp root. {@link existingWorktrees}
 * already filters those on read, so removing them from the file buys nothing and
 * costs the one thing the file is for — an unmounted share or external drive
 * comes back, and a checkout the list has forgotten is invisible to the cutover's
 * source enumeration, so its orphan branch would be neither imported nor fenced.
 * Same reason `DbBackfill` skips such a repo rather than deregistering it.
 *
 * NOT touched: an entry with no live path at all. That is `forgetRepos`'
 * territory, and rewriting it here would only make dead data tidier.
 */
export async function repairRegistryEntries(opts: RegistryRepairOptions = {}): Promise<ReadonlyArray<RegistryRepair>> {
	const platform = opts.platform ?? process.platform;
	const roots = opts.tempRoots ?? tempRoots();
	const pass = async (): Promise<ReadonlyArray<RegistryRepair>> => {
		const registry = await readRepoRegistryStrict(opts.configDir);
		const repairs: RegistryRepair[] = [];
		const repos = registry.repos.map((repo) => {
			if (!hasLiveWorktree(repo)) return repo;
			const droppedPaths: string[] = [];
			const collapsedPaths: string[] = [];
			const kept: string[] = [];
			for (const path of recordedRepoPaths(repo)) {
				if (!existsSync(path) && roots.some((root) => isUnder(path, root, platform))) {
					droppedPaths.push(path);
					continue;
				}
				// Newest spelling wins: drop the earlier one and re-append.
				const clash = kept.findIndex((seen) => sameRecordedRoot(seen, path, platform));
				if (clash !== -1) collapsedPaths.push(...kept.splice(clash, 1));
				kept.push(path);
			}
			// Newest-first, matching `existingWorktrees` — the path a collector would
			// have picked anyway, so the displayed root and the collected one agree.
			const live = [...kept].reverse().find((path) => existsSync(path));
			const repointedTo = live !== undefined && !existsSync(repo.worktreeRoot) ? live : undefined;
			// `registerRepo` guarantees `worktreeRoot` is the last entry of
			// `worktrees`; keep that invariant when a repair rewrote the list. AFTER
			// the repoint, or a `worktreeRoot` that was itself a dead temp path is
			// re-appended by the very pass that just dropped it.
			const nextRoot = repointedTo ?? repo.worktreeRoot;
			if (!kept.some((path) => sameRecordedRoot(path, nextRoot, platform))) kept.push(nextRoot);
			if (droppedPaths.length === 0 && collapsedPaths.length === 0 && repointedTo === undefined) return repo;
			repairs.push({
				repoIdentity: repo.repoIdentity,
				droppedPaths,
				collapsedPaths,
				...(repointedTo !== undefined && { repointedTo }),
			});
			return {
				...repo,
				...(repointedTo !== undefined && { worktreeRoot: repointedTo }),
				worktrees: kept,
			};
		});
		if (repairs.length > 0 && opts.dryRun !== true) {
			await writeRepoRegistry({ ...registry, version: 1, repos }, opts.configDir);
		}
		return repairs;
	};
	// A dry run takes NO lock. The lock serialises read-modify-WRITE cycles, and a
	// preview performs no write — `writeRepoRegistry` is atomic, so a lock-free read
	// can never see a torn file either. Taking it anyway put `jolli doctor`, a
	// read-only diagnostic that computes this preview on EVERY run, into contention
	// with the `registerRepo` a post-commit hook is running at the same time.
	return opts.dryRun === true ? pass() : withRepoRegistryLock(pass, { globalDir: opts.configDir });
}

/** Registered repos that are not disabled. */
export async function listActiveRepos(configDir?: string): Promise<ReadonlyArray<RegisteredRepo>> {
	return (await readRepoRegistry(configDir)).repos.filter((r) => !r.disabledAt);
}
