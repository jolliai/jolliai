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

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getJolliMemoryDir } from "../Logger.js";
import { execGit } from "./GitOps.js";

const PROFILE_FILE = "profile.json";
/** Legacy marker (pre-RepoProfile): `<git-common-dir>/jollimemory/backfill-card-dismissed`. */
const LEGACY_DISMISS_DIR = "jollimemory";
const LEGACY_DISMISS_FILE = "backfill-card-dismissed";

export interface RepoProfile {
	/**
	 * The user chose "don't ask again" for the back-fill cold-start offer in this
	 * repo. STICKY: once set, nothing clears it automatically — it is an explicit,
	 * permanent opt-out (contrast the earlier behavior, which auto-cleared it after
	 * any generation). Only an explicit re-set to false would undo it.
	 */
	backfillDismissed?: boolean;
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
	// so the profile lands under `.git/` rather than a working-tree root. That is
	// harmless and self-consistent (reads/writes resolve identically, and it matches
	// where the pre-RepoProfile marker already lived), just not the out-of-`.git` ideal.
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
		return parsed && typeof parsed === "object" ? (parsed as RepoProfile) : {};
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
	await writeFile(profilePath, `${JSON.stringify(profile, null, "\t")}\n`);
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
		const migrated: RepoProfile = { ...profile, backfillDismissed: true };
		// Best-effort persist so the legacy marker only needs to be read once.
		await writeProfile(profilePath, migrated).catch(() => {});
		return migrated;
	}
	return profile;
}

/** Merges `patch` into the repo's profile and persists it. */
export async function updateRepoProfile(cwd: string, patch: Partial<RepoProfile>): Promise<void> {
	const { profilePath } = await resolvePaths(cwd);
	const current = await readRaw(profilePath);
	await writeProfile(profilePath, { ...current, ...patch });
}
