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

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getJolliMemoryDir } from "../Logger.js";
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
	 * The user explicitly disabled Jolli Memory for this repo (`jolli disable` or
	 * the VS Code "Disable" command). Repo-wide — it matches the shared git hook
	 * that `status.enabled` reflects, so one disable holds across every worktree.
	 * Highest priority: never auto-cleared by upgrades, window reloads, or hook
	 * repair; only an explicit re-enable sets it back to false.
	 */
	manuallyDisabled?: boolean;
}

/** Resolved paths for a repo's profile, plus the legacy marker to migrate from. */
interface ProfilePaths {
	readonly profilePath: string;
	/** Legacy marker path, or null when not in a git repo (nothing to migrate). */
	readonly legacyMarkerPath: string | null;
}

/**
 * Resolves the profile path, anchored to the MAIN worktree root so the file is
 * shared across all worktrees of the repo. Falls back to the current-dir
 * `.jolli/jollimemory/` only when `cwd` is not a git repo — the front door never
 * offers back-fill there, so the fallback is inert.
 */
async function resolvePaths(cwd: string): Promise<ProfilePaths> {
	const res = await execGit(["rev-parse", "--git-common-dir"], cwd);
	const raw = res.exitCode === 0 ? res.stdout.trim() : "";
	if (!raw) {
		return { profilePath: join(getJolliMemoryDir(cwd), PROFILE_FILE), legacyMarkerPath: null };
	}
	const commonDir = isAbsolute(raw) ? raw : join(cwd, raw);
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
	await mkdir(dirname(profilePath), { recursive: true });
	// Atomic write: a torn/partial file reads back as `{}` (corrupt JSON), which
	// would silently drop a durable opt-out. Write a PID-scoped temp then rename
	// (atomic on the same volume; replaces the target on Windows). The PID suffix
	// avoids a temp-file collision if two writers ever race without the lock.
	const tmpPath = `${profilePath}.${process.pid}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(profile, null, "\t")}\n`);
	try {
		await rename(tmpPath, profilePath);
	} catch (err) {
		await unlink(tmpPath).catch(() => {});
		throw err;
	}
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
		// Persist under the profile lock, re-reading inside so a concurrent write of
		// the OTHER field (manuallyDisabled) isn't clobbered. Best-effort: a persist
		// failure still returns the migrated value, and the next read re-migrates.
		await withStrictProfileLock(cwd, async () => {
			const current = await readRaw(profilePath);
			if (current.backfillDismissed === undefined) {
				await writeProfile(profilePath, { ...current, backfillDismissed: true });
			}
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
	if (profile.manuallyDisabled !== undefined) {
		return profile.manuallyDisabled === true;
	}
	const legacy = await anyWorktreeHasLegacyDisableMarker(cwd);
	const migration = await withStrictProfileLock(cwd, async () => {
		const current = await readRaw(profilePath);
		if (current.manuallyDisabled === undefined) {
			await writeProfile(profilePath, { ...current, manuallyDisabled: legacy });
			return legacy;
		}
		return current.manuallyDisabled === true;
	}).catch(() => null);
	return migration?.acquired ? (migration.value ?? legacy) : legacy;
}

/** Sets (`true`) or clears (`false`) the repo-wide manual-disable flag. */
export async function writeManualDisableFlag(cwd: string, disabled: boolean): Promise<void> {
	await updateRepoProfile(cwd, { manuallyDisabled: disabled });
}
