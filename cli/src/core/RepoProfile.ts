/**
 * RepoProfile — per-repo, machine-local front-door preferences.
 *
 * Stored as JSON at `<main-worktree-root>/.jolli/jollimemory/profile.json`. This
 * is the repo-level sibling of the user-level `~/.jolli/jollimemory/profile.json`
 * (the machine-global `UserProfile`): same filename, different scope.
 *
 * Deliberately **repo-wide, not per-worktree**. The cold-start decision it gates
 * (`repoHasAnyMemory` reads the shared orphan branch) is itself repo-wide, so a
 * "don't ask again" chosen in one worktree must hold in every worktree. We anchor
 * to the MAIN worktree root (derived from `git rev-parse --git-common-dir`) rather
 * than the current `cwd`, so all linked worktrees resolve to the same file. The
 * `.jolli/jollimemory/` dir is gitignored, so this never gets committed.
 *
 * This replaces the earlier `backfill-card-dismissed` marker that lived inside the
 * shared `.git` common dir. Reads transparently migrate that old marker (see
 * {@link readRepoProfile}), so users who dismissed the card before this change are
 * not re-prompted.
 */

import { readFileSync, statSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getJolliMemoryDir } from "../Logger.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import { writeFileAtomic } from "./AtomicJsonFile.js";
import { resolveGitFsLayout } from "./GitFsLayout.js";
import { execGit, listWorktrees } from "./GitOps.js";
import { withStrictProfileLock } from "./Locks.js";

const PROFILE_FILE = "profile.json";
/** Legacy marker (pre-RepoProfile): `<git-common-dir>/jollimemory/backfill-card-dismissed`. */
const LEGACY_DISMISS_DIR = "jollimemory";
const LEGACY_DISMISS_FILE = "backfill-card-dismissed";
/**
 * Legacy manual-disable marker (pre-repo-scope): a per-worktree file at
 * `<worktreeRoot>/.jolli/jollimemory/disabled-by-user`, written by the VS Code
 * extension before the flag became a repo-wide `profile.json` field. Reads
 * migrate it (see {@link readManualDisableFlag}).
 */
const LEGACY_DISABLE_FILE = "disabled-by-user";

export interface RepoProfile {
	/**
	 * The user chose "don't ask again" for the back-fill cold-start offer in this
	 * repo. STICKY: once set, nothing clears it automatically — it is an explicit,
	 * permanent opt-out (contrast the earlier behavior, which auto-cleared it after
	 * any generation). Only an explicit re-set to false would undo it.
	 */
	backfillDismissed?: boolean;
	/**
	 * DERIVED bit for OLD runtimes only: `userDisabled OR cutoverFence present`.
	 * Old clients (pre-cutover CLI/extensions) read this one field and stop
	 * writing — that is the entire reason it still exists. It is recomputed on
	 * every write of its two sources and NEVER hand-written; new runtime code
	 * must not read it for decisions (the readers below consult
	 * {@link userDisabled} instead). Kept as a field name because it is the only
	 * flag already-shipped clients understand.
	 */
	manuallyDisabled?: boolean;
	/**
	 * The user's own disable (`jolli disable` / the VS Code command). When set,
	 * EVERYTHING stops — orphan and SQLite writes alike. `jolli disable` sets it,
	 * `jolli enable` clears it; neither touches {@link cutoverFence}. Highest
	 * priority: userDisabled > cutoverFence.
	 */
	userDisabled?: boolean;
	/**
	 * When the automatic cutover attempt last RAN for this clone (epoch ms).
	 *
	 * Only a throttle, never evidence of state: the two witnesses that decide
	 * routing are {@link cutoverFence} and the database's `repo_state.cutover`
	 * row, and this field is deliberately not consulted by either. It exists
	 * because the attempt's step 2 re-imports every source at its pinned tip and
	 * step 3 then reads every file that tip lists, which is far too expensive to
	 * repeat on every commit for a repo that keeps answering `not-ready`. Absent
	 * means "never attempted", which is what every repo enabled before
	 * auto-cutover shipped reads back.
	 */
	cutoverAttemptedAtMs?: number;
	/**
	 * When the automatic post-cutover DRIFT probe last ran for this clone (epoch
	 * ms) — a separate stamp from {@link cutoverAttemptedAtMs} because the two
	 * never run in the same state: the attempt stops once the repo is `cutover`,
	 * which is exactly where the probe starts.
	 *
	 * Also only a throttle. The probe is cheap when nothing drifted (one
	 * `rev-parse` per source) and expensive when something did (a catch-up
	 * import), and drift is deliberately never cleared automatically — so
	 * without a stamp a repo with a live bypassing writer would pay that import
	 * on every single commit, forever.
	 */
	cutoverDriftProbedAtMs?: number;
	/**
	 * The cutover fence (phase D): present means this repo's orphan branch is
	 * FROZEN — new runtimes keep working but write SQLite and read the database;
	 * old runtimes are stopped via the derived bit. `jolli enable` must NOT
	 * clear it; only doctor's explicit manual path may. Never auto-revoked:
	 * there is no legitimate "unfreeze" — old clients must never write the
	 * frozen branch again.
	 */
	cutoverFence?: {
		readonly reason: string;
		readonly at: string;
		/** Frozen orphan tips per source root, pinned when the fence went up —
		 *  what the CAS (and its crash-resume) compares rev-parse against. */
		readonly tips?: Readonly<Record<string, string>>;
	};
}

/** Recomputes the old-runtime composite from its two sources — the ONLY writer. */
function withDerivedDisable(profile: RepoProfile): RepoProfile {
	return { ...profile, manuallyDisabled: profile.userDisabled === true || profile.cutoverFence !== undefined };
}

/** Resolved paths for a repo's profile, plus the legacy marker to migrate from. */
interface ProfilePaths {
	readonly profilePath: string;
	/** Legacy marker path, or null when not in a git repo (nothing to migrate). */
	readonly legacyMarkerPath: string | null;
}

/**
 * The absolute git-common-dir for `cwd`, or null when `cwd` is not in a repo.
 *
 * Tries the filesystem first ({@link resolveGitFsLayout}) and only spawns `git`
 * when that declines. The read is on the SessionStart hook's critical path, where
 * a `rev-parse` costs ~10 ms of pure process creation and this was one of three
 * identical calls in a single run — see the GitFsLayout module docstring.
 *
 * `realpath: false` is load-bearing, not a default taken by accident: this path
 * anchors `profile.json`, which holds the user's `userDisabled` opt-out. The
 * subprocess form below resolves git's output against `cwd` WITHOUT resolving
 * symlinks, so normalizing here would relocate the profile of any repo reached
 * through a symlinked path — reading as "never disabled" on the next hook run.
 */
async function resolveCommonDir(cwd: string): Promise<string | null> {
	const fromFs = resolveGitFsLayout(cwd)?.commonDir;
	if (fromFs) return fromFs;
	const res = await execGit(["rev-parse", "--git-common-dir"], cwd);
	const raw = res.exitCode === 0 ? res.stdout.trim() : "";
	if (!raw) return null;
	return isAbsolute(raw) ? raw : join(cwd, raw);
}

/**
 * Resolves the profile path, anchored to the MAIN worktree root so the file is
 * shared across all worktrees of the repo. Falls back to the current-dir
 * `.jolli/jollimemory/` only when `cwd` is not a git repo — the front door never
 * offers back-fill there, so the fallback is inert.
 */
async function resolvePaths(cwd: string): Promise<ProfilePaths> {
	const commonDir = await resolveCommonDir(cwd);
	if (commonDir === null) {
		return { profilePath: join(getJolliMemoryDir(cwd), PROFILE_FILE), legacyMarkerPath: null };
	}
	// The main worktree root is the parent of the common `.git` dir. Linked
	// worktrees still report the main repo's common dir, so they resolve here too
	// — this shared common dir is exactly why we use it rather than
	// `--show-toplevel` (which returns the CURRENT worktree, breaking sharing).
	// Edge case: inside a git submodule the common dir is `<super>/.git/modules/<name>`,
	// and dirname drops the `<name>` segment, so the profile lands at
	// `<super>/.git/modules/.jolli/...`, shared by every submodule of that super-repo.
	// Reads/writes stay self-consistent, but sibling submodules then share one profile,
	// so a dismiss in one submodule suppresses the offer in the others — and likewise a
	// `manuallyDisabled` set in one submodule turns Jolli off for every sibling submodule
	// of that super-repo. Known, low-severity limitation (no data loss); git submodules
	// are rare enough that a per-submodule special-case isn't worth it. Note the legacy
	// markers are anchored per-worktree/per-submodule-checkout, so they were per-submodule.
	const mainRoot = dirname(commonDir);
	return {
		profilePath: join(getJolliMemoryDir(mainRoot), PROFILE_FILE),
		legacyMarkerPath: join(commonDir, LEGACY_DISMISS_DIR, LEGACY_DISMISS_FILE),
	};
}

/** Parses profile.json; returns `{}` on any error (missing file, corrupt JSON). */
async function readRaw(profilePath: string): Promise<RepoProfile> {
	try {
		const text = await readFile(profilePath, "utf-8");
		const parsed = JSON.parse(text);
		// Arrays are `typeof "object"` too — reject them so a stray `[...]` profile
		// isn't spread into `{0:..., 1:...}` by a later migration.
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RepoProfile) : {};
	} catch {
		return {};
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function writeProfile(profilePath: string, profile: RepoProfile): Promise<void> {
	// Atomic write: a torn/partial file reads back as `{}` (corrupt JSON), which
	// would silently drop a durable opt-out. `writeFileAtomic` is the shared
	// temp-then-rename writer -- see its header for why every fail-open JSON
	// state file in this codebase goes through it.
	await writeFileAtomic(profilePath, `${JSON.stringify(profile, null, "\t")}\n`);
}

/**
 * Reads the repo's profile. If the profile has no `backfillDismissed` field but the
 * legacy `<git-common-dir>/jollimemory/backfill-card-dismissed` marker exists, the
 * dismiss is treated as `true` and persisted into the new profile (best-effort —
 * a persist failure still returns the migrated value). Returns `{}` when nothing
 * has been set.
 */
export async function readRepoProfile(cwd: string): Promise<RepoProfile> {
	const { profilePath, legacyMarkerPath } = await resolvePaths(cwd);
	const profile = await readRaw(profilePath);
	if (profile.backfillDismissed === undefined && legacyMarkerPath && (await fileExists(legacyMarkerPath))) {
		const marker = legacyMarkerPath;
		// Persist under the profile lock, re-reading inside so a concurrent write of
		// the OTHER field (manuallyDisabled) isn't clobbered, then retire the legacy
		// marker so a later profile.json reset can't resurrect a stale dismiss.
		// Best-effort throughout: if the persist throws we never reach the unlink, so
		// the marker survives and the next read re-migrates.
		await withStrictProfileLock(cwd, async () => {
			const current = await readRaw(profilePath);
			if (current.backfillDismissed === undefined) {
				await writeProfile(profilePath, { ...current, backfillDismissed: true });
			}
			// profile.json now durably carries the field, so the marker is obsolete —
			// a failed unlink just leaves it inert (the field suppresses re-migration).
			await unlink(marker).catch(() => {});
		}).catch(() => {});
		return { ...profile, backfillDismissed: true };
	}
	return profile;
}

/**
 * Merges `patch` into the repo's profile and persists it. The read-modify-write
 * runs under the shared `profile.lock` (see {@link withStrictProfileLock}) so a
 * concurrent writer in another process/worktree can't lose-update a sibling
 * field — e.g. a VS Code `backfillDismissed` write must not drop a CLI
 * `manuallyDisabled` write, which would silently re-enable a disabled repo.
 */
export async function updateRepoProfile(cwd: string, patch: Partial<RepoProfile>): Promise<void> {
	const { profilePath } = await resolvePaths(cwd);
	const result = await withStrictProfileLock(cwd, async () => {
		const current = await readRaw(profilePath);
		await writeProfile(profilePath, { ...current, ...patch });
	});
	if (!result.acquired) {
		throw new Error("Timed out acquiring the repo profile lock");
	}
}

/**
 * True iff any worktree of this repo still carries the legacy per-worktree
 * `disabled-by-user` marker. Enumerating all worktrees (not just `cwd`) is what
 * makes the migration robust: a repo disabled in one worktree stays disabled no
 * matter which worktree first reads the flag after the upgrade. Falls back to
 * checking just `cwd` when worktree enumeration fails (e.g. not a git repo).
 */
async function anyWorktreeHasLegacyDisableMarker(cwd: string): Promise<boolean> {
	let worktrees: ReadonlyArray<string>;
	try {
		worktrees = await listWorktrees(cwd);
	} catch {
		worktrees = [cwd];
	}
	for (const wt of worktrees) {
		if (await fileExists(join(getJolliMemoryDir(wt), LEGACY_DISABLE_FILE))) {
			return true;
		}
	}
	return false;
}

/**
 * Reads the repo-wide manual-disable flag — the user's highest-priority opt-out.
 *
 * If `profile.json` has no `manuallyDisabled` field yet but any worktree still
 * carries the legacy `disabled-by-user` marker, the repo is treated as disabled
 * and the decision is persisted into the profile. A confirmed absence is also
 * persisted as `false`, so hot-path hook checks do not enumerate all worktrees
 * forever on a fresh install. The locked write re-reads the profile, so it
 * cannot overwrite a concurrent explicit enable/disable.
 */
export async function readManualDisableFlag(cwd: string): Promise<boolean> {
	const { profilePath } = await resolvePaths(cwd);
	const profile = await readRaw(profilePath);
	if (profile.userDisabled !== undefined) {
		return profile.userDisabled === true;
	}
	// Migration: a profile that predates the three-field split carries only the
	// composite, and a pre-fence-era disable can only have been the USER's — so
	// it migrates onto userDisabled. This is the one sanctioned read of the
	// composite in new code (it IS the migration).
	if (profile.manuallyDisabled !== undefined) {
		return persistUserDisabled(cwd, profilePath, profile.manuallyDisabled === true);
	}
	const legacy = await anyWorktreeHasLegacyDisableMarker(cwd);
	return persistUserDisabled(cwd, profilePath, legacy);
}

/**
 * Locked, clobber-safe persist of a migrated userDisabled decision — returning
 * the value that WON, not the one that was proposed.
 *
 * The migration decides its value from an unlocked read, and the whole point of
 * taking the lock is that an explicit `jolli disable` can land in between. Such a
 * write is correctly kept (the guard below declines to overwrite it), so
 * returning the pre-lock value made the caller answer "not disabled" against a
 * profile that says otherwise — and this caller is the hook gate, so that answer
 * captured the commit the user had just opted out of.
 *
 * On a lock failure — not acquired, or the write threw — the proposed value
 * stands: nothing was written, so there is no winner to prefer, and the next call
 * migrates again.
 */
async function persistUserDisabled(cwd: string, profilePath: string, value: boolean): Promise<boolean> {
	const result = await withStrictProfileLock(cwd, async () => {
		const current = await readRaw(profilePath);
		if (current.userDisabled !== undefined) return current.userDisabled === true;
		await writeProfile(profilePath, withDerivedDisable({ ...current, userDisabled: value }));
		return value;
	}).catch(() => undefined);
	return result?.acquired && result.value !== undefined ? result.value : value;
}

/**
 * Sets (`true`) or clears (`false`) the USER's own disable. Deliberately blind
 * to the cutover fence: `jolli enable` clearing a fence would simultaneously
 * unfreeze the orphan branch for every old runtime on the machine. The
 * old-runtime composite is recomputed either way.
 */
export async function writeManualDisableFlag(cwd: string, disabled: boolean): Promise<void> {
	const { profilePath } = await resolvePaths(cwd);
	const result = await withStrictProfileLock(cwd, async () => {
		const current = await readRaw(profilePath);
		await writeProfile(profilePath, withDerivedDisable({ ...current, userDisabled: disabled }));
	});
	if (!result.acquired) {
		throw new Error("Timed out acquiring the repo profile lock");
	}
}

/** The repo's cutover fence, or null when the orphan branch is not frozen. */
export async function readCutoverFence(
	cwd: string,
): Promise<{ reason: string; at: string; tips?: Readonly<Record<string, string>> } | null> {
	const { profilePath } = await resolvePaths(cwd);
	return (await readRaw(profilePath)).cutoverFence ?? null;
}

/**
 * Writes (or, on `null`, removes) the cutover fence, recomputing the composite.
 * Removal exists ONLY for doctor's explicit manual path — no automatic caller
 * may pass null, per the "封锁永不自动撤销" rule.
 */
export async function writeCutoverFence(
	cwd: string,
	fence: { reason: string; at: string; tips?: Readonly<Record<string, string>> } | null,
): Promise<void> {
	// Force `userDisabled` to a resolved, persisted boolean BEFORE the fence
	// goes up. Without this, a profile that never had `userDisabled` written
	// gets `manuallyDisabled: true` from the fence alone (via
	// `withDerivedDisable` below) with `userDisabled` still absent — and
	// `readManualDisableFlag`'s legacy-migration branch (it only ever sees a
	// pre-three-field-split profile that way) would then wrongly fold that
	// fence-only composite onto `userDisabled: true`, permanently disabling
	// SQLite writes for a repo the user never actually disabled.
	const resolvedUserDisabled = await readManualDisableFlag(cwd);
	const { profilePath } = await resolvePaths(cwd);
	const result = await withStrictProfileLock(cwd, async () => {
		const current = await readRaw(profilePath);
		const next = { ...current } as RepoProfile & { cutoverFence?: NonNullable<RepoProfile["cutoverFence"]> };
		// The forcing call above persists through a fire-and-forget lock attempt
		// (`persistUserDisabled` swallows a lock timeout without running), so its
		// write can silently lose to contention — e.g. a concurrent
		// `backfillDismissed` write holding the lock at exactly that moment.
		// Materialize the split field in THE SAME locked write as the fence, so a
		// fence can never land on a pre-split profile. Absence-only: a value a
		// concurrent explicit enable/disable just persisted must win.
		if (next.userDisabled === undefined) next.userDisabled = resolvedUserDisabled;
		if (fence === null) delete next.cutoverFence;
		else next.cutoverFence = fence;
		await writeProfile(profilePath, withDerivedDisable(next));
	});
	if (!result.acquired) {
		throw new Error("Timed out acquiring the repo profile lock");
	}
}

/**
 * Memo for the sync reader's main-worktree-root resolution, keyed by input `cwd`.
 *
 * Mirrors `GitOps._stateRootCache` and exists for the same reason: this is no
 * longer a once-per-process seed. The onboarding-funnel gate calls
 * {@link readManualDisableFlagSync} from `maybeEmitOnboardingProgress`, which VS
 * Code runs on every `StatusStore.refresh()` — including two file watchers that
 * fire repeatedly while an AI session is live — so an unmemoized
 * `git rev-parse --git-common-dir` would spawn a subprocess per refresh on the
 * extension host's event loop.
 *
 * Memoizing this cannot stale the flag: a repo's common dir is fixed for the life
 * of a process, and the `profile.json` read that carries the actual answer stays
 * uncached, so every enable/disable is still observed on the next call. The
 * not-a-git-repo answer is memoized too — equally stable, and the case that pays
 * the full subprocess cost.
 */
const _mainRootCache = new Map<string, string>();

/** Test-only: clears the memo so cases don't leak resolved roots into each other. */
export function resetRepoProfileRootCache(): void {
	_mainRootCache.clear();
}

/** Resolves (and memoizes) the main worktree root for the sync reader. */
function resolveMainRootSync(cwd: string): string {
	const cached = _mainRootCache.get(cwd);
	if (cached !== undefined) return cached;
	// Filesystem first, for the reason spelled out on the async `resolveCommonDir`
	// above — including why the answer must NOT be realpath-normalized.
	const fromFs = resolveGitFsLayout(cwd)?.commonDir;
	if (fromFs) {
		const root = dirname(fromFs);
		_mainRootCache.set(cwd, root);
		return root;
	}
	let commonDir = "";
	try {
		const raw = execFileSyncHidden("git", ["rev-parse", "--git-common-dir"], {
			cwd,
			encoding: "utf-8",
			// Capture git's stderr so a non-git cwd doesn't leak "fatal: not a git
			// repository …" to the user's terminal; the throw is handled below. Load
			// bearing since the onboarding-funnel gate calls this from the guided
			// front door's non-git dead end, where the leak would print directly
			// under jolli's own "not a git repository" message.
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		if (raw) {
			commonDir = isAbsolute(raw) ? raw : join(cwd, raw);
		}
	} catch {
		commonDir = "";
	}
	const mainRoot = commonDir ? dirname(commonDir) : cwd;
	_mainRootCache.set(cwd, mainRoot);
	return mainRoot;
}

/**
 * Synchronous, read-only variant of {@link readManualDisableFlag}. Two callers:
 * the VS Code extension's `activate()` seeds the in-memory zero-write flag with
 * it before any async work runs (a stray log line during early activation must
 * not touch disk in a manually disabled repo, and the async reader can't be
 * awaited that early), and the onboarding-funnel telemetry gate uses it as the
 * disk-backed truth that CLI processes — which never set the in-memory mirror —
 * need. The funnel gate calls it repeatedly, hence the `_mainRootCache` memo.
 *
 * Best-effort by design: unlike the async reader it never migrates the legacy
 * marker or persists a decision (the async reader does that later); it only
 * reports the current state. It still anchors to the main worktree root via a
 * sync `git rev-parse --git-common-dir` so a linked worktree of a disabled repo
 * reads the shared `profile.json` rather than re-enabling on reload. Any failure
 * (not a git repo, missing/corrupt profile) falls through to the legacy marker
 * in `cwd`, then to `false`.
 */
export function readManualDisableFlagSync(cwd: string): boolean {
	const mainRoot = resolveMainRootSync(cwd);
	try {
		const parsed = JSON.parse(readFileSync(join(getJolliMemoryDir(mainRoot), PROFILE_FILE), "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const profile = parsed as RepoProfile;
			// userDisabled first (the axis new code decides on); the composite
			// only as the read-only migration fallback for pre-split profiles —
			// a fence must NOT stop this runtime, only old ones.
			if (profile.userDisabled !== undefined) {
				return profile.userDisabled === true;
			}
			if (profile.manuallyDisabled !== undefined) {
				return profile.manuallyDisabled === true;
			}
		}
	} catch {
		// Missing or corrupt profile — fall through to the legacy marker.
	}
	// Legacy per-worktree marker, this worktree only (the async reader
	// enumerates every worktree and migrates; this fast path stays cheap).
	try {
		statSync(join(getJolliMemoryDir(cwd), LEGACY_DISABLE_FILE));
		return true;
	} catch {
		return false;
	}
}
