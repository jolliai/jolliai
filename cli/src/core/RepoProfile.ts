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
import { createLogger, getJolliMemoryDir } from "../Logger.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import { writeFileAtomic } from "./AtomicJsonFile.js";
import { resolveGitFsLayout } from "./GitFsLayout.js";
import { execGit, listWorktrees } from "./GitOps.js";
import { withStrictProfileLock } from "./Locks.js";

const log = createLogger("RepoProfile");

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
	 * The repo's ONE disable switch — the user's own opt-out (`jolli disable`, the
	 * VS Code command, the ide-bridge). When set, EVERYTHING stops: hooks, plugin
	 * bootstraps, skill refresh, orphan and SQLite writes alike, and the
	 * dashboard's machine-wide sweep. `jolli enable` clears it; neither touches
	 * {@link cutoverFence}.
	 *
	 * Read by every runtime, old and new — which is the point of keeping THIS
	 * spelling. It spent one week as a DERIVED bit beside {@link userDisabled},
	 * computed as `userDisabled OR cutoverFence present` so that freezing a repo
	 * would also stop already-shipped clients from writing the retired branch.
	 * Measured consequence on a real machine: a pre-0.99.11 Claude plugin reads
	 * this field, concludes the USER disabled the repo, and its SessionStart
	 * bootstrap runs `uninstall()` — deleting the shared git hooks, the Gemini
	 * hook, and `.mcp.json` / `.cursor/mcp.json` in EVERY worktree (seven of them
	 * in the capture). A current surface reinstalls, the next session tears it down
	 * again, and the sidebar shows "Enable Jolli Memory" after every commit. The
	 * brake and the wrecking ball were the same field. Once the fence stopped being
	 * folded in, the derived bit mirrored its own source — and a bit that mirrors
	 * its source is a second name for one fact, so the two collapsed back into one.
	 *
	 * **Folding the fence back in is a review blocker.** Nothing stops an old
	 * runtime writing a frozen branch; `probeCutoverDrift` is the compensating
	 * control — it notices the moved tip and catch-up imports those memories, so
	 * they are stranded, never lost. The residual cost is accepted: an old surface
	 * still READS the frozen branch, so it shows a view missing everything current
	 * surfaces wrote to SQLite after the cutover, widening until it is upgraded.
	 */
	manuallyDisabled?: boolean;
	/**
	 * LEGACY, migration-only — the truth field of the three-field split that
	 * shipped in 0.99.11 – 0.99.13. Current code NEVER writes it and never decides
	 * on it: {@link readManualDisableFlag} folds it into {@link manuallyDisabled}
	 * on the first read and DELETES the key, and every explicit write drops it.
	 *
	 * While present it WINS, and **deleting that read branch is a review blocker**
	 * rather than a cleanup. A profile from that generation can carry a
	 * fence-derived `manuallyDisabled: true` next to `userDisabled: false`, so
	 * taking the composite there would permanently disable every repo that had cut
	 * over. What makes the one-line precedence a COMPLETE defence rather than a
	 * mitigation: `cutoverFence` and this field were introduced by the same commit,
	 * so a build old enough to fold the fence is also a build that writes this
	 * field beside it — a poisoned composite therefore never appears alone.
	 *
	 * Not a one-shot upgrade step, either. A runtime of that generation can still
	 * be installed alongside a current one — plugin bundles exec their own `dist/`
	 * from the manifest and never pass through `run-hook`'s version race — so the
	 * key can reappear after the migration and the next read folds it in again.
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
	 * FROZEN — new runtimes keep working but write SQLite and read the database.
	 *
	 * It stops NOTHING on an old runtime. Folding it into {@link manuallyDisabled}
	 * was the original design and is a review blocker now — see that field for the
	 * measurement. `probeCutoverDrift` is the compensating control: an old client
	 * that writes the frozen branch moves its tip, which the probe reports and
	 * catch-up imports.
	 *
	 * `jolli enable` must NOT clear it; only doctor's explicit manual path may.
	 * Never auto-revoked: there is no legitimate "unfreeze".
	 */
	cutoverFence?: {
		readonly reason: string;
		readonly at: string;
		/** Frozen orphan tips per source root, pinned when the fence went up —
		 *  what the CAS (and its crash-resume) compares rev-parse against. */
		readonly tips?: Readonly<Record<string, string>>;
	};
}

/**
 * Drops the retired {@link RepoProfile.userDisabled} key and sets the one switch.
 *
 * The delete is not tidiness: 0.99.11 – 0.99.13 read `userDisabled` FIRST, so a
 * stale copy left beside a fresh `manuallyDisabled` is the value those runtimes
 * (and this module's own migration branch) would act on. Removing it is what
 * makes the two generations agree — they fall back to the field below, which is
 * the one being written here.
 */
function withDisableSwitch(profile: RepoProfile, disabled: boolean): RepoProfile {
	const next: RepoProfile = { ...profile, manuallyDisabled: disabled };
	delete next.userDisabled;
	return next;
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
 * anchors `profile.json`, which holds the user's `manuallyDisabled` opt-out. The
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
 * `(profilePath, decidedBy, value)` tuples this process has already traced — see
 * {@link traceDisable} for why a repeat is not worth a line.
 */
const _tracedReads = new Set<string>();

/**
 * The audit trail for the manual-disable flag — kept, not temporary.
 *
 * It was added to answer one question and is retained because the answer was
 * only findable WITH it: two processes read this one file 8 seconds apart and
 * gave OPPOSITE answers (the VS Code bridge read `false` and re-enabled; a
 * SessionStart hook read `true` and tore the repo's hooks down), and what
 * identified the culprit was a NEGATIVE — the process that claimed "disabled"
 * emitted no line at all, which is how a pre-0.99.11 plugin bundle reading the
 * old fence-derived composite was found. Nothing else in the system could have
 * shown that, because neither the resolved profile path, nor which field
 * decided, nor who wrote the value was recorded anywhere.
 *
 * So every field that could explain a disagreement is on the line: the PID (two
 * processes), the caller's `cwd` AND the resolved `profilePath` (they disagree
 * if `--git-common-dir` resolves differently, e.g. from a linked worktree), the
 * DECIDING source (`manuallyDisabled`, the retired-`userDisabled` migration, or
 * the legacy marker — either migration is a read that WRITES), and the raw values
 * of both spellings plus the fence. Writes carry a stack, because the question is
 * always which caller flipped it.
 *
 * **A READ traces once per `(profilePath, decidedBy, value)` per process, not
 * once per call**, because that tuple IS the unit of information — a second
 * identical line answers a question the first already answered, while costing
 * another queued write. Both signals the incident above turned on survive it
 * exactly: two processes disagreeing still produce two lines (the memo is
 * process-local, so each one traces its own answer), the culprit still shows up
 * as a process that emitted NOTHING (a negative has no count to suppress), and a
 * value that CHANGES inside one process re-keys and emits — which is the only
 * read event worth a line anyway.
 *
 * Dropping the whole trace to `debug` was the other way to bound this and is
 * wrong: the default level is `info`, so it would turn the diagnostic off on
 * every machine that has not opted into an override — i.e. off exactly when the
 * next disagreement is being lived through — and it would silence the first,
 * informative line along with the redundant ones. WRITES are never deduped: they
 * are rare, they carry a stack, and "which caller flipped it" is the question.
 *
 * What that removes is not hypothetical. IntelliJ's `refreshStatus()` reaches
 * this through the `repo-profile` / `read-manual-disable` bridge action on every
 * git-repo-change event, every daemon refresh push and every toolbar action,
 * and `ide-bridge` is otherwise silent (warn/error only) — so before the memo,
 * one un-deduped line per refresh was the single highest-frequency write this
 * module could produce, in a repo the user may have disabled.
 *
 * Nothing about that last part is the Logger's job to fix, and the memo is not a
 * stand-in for a gate that should exist elsewhere. `manuallyDisabled` in
 * `profile.json` is the ONE switch; `Logger`'s boolean of the same name is a
 * per-process CACHE of it, seeded only by the VS Code extension host because
 * only that process serves exactly one repo — see its docstring for why arming
 * it anywhere else would make it a second, wrong switch. So this trace has to be
 * bounded on its own terms, which is what the memo does.
 *
 * The memo is keyed by path, so it is bounded by the repos one process asks
 * about (× 3 deciding sources × 2 values) — one entry for a hook, a handful for
 * the dashboard sweep.
 *
 * **Never call this from {@link readManualDisableFlagSync}.** That reader runs
 * inside `activate()` BEFORE `setManuallyDisabled` has been applied, so the
 * Logger's zero-write gate is still open and a line here lands on disk in a
 * repo the user disabled — the exact thing the ordering comment at that call
 * site exists to prevent. It is also a hot path (every `StatusStore.refresh()`,
 * plus two file watchers during a live AI session), where even a deduped line
 * costs a `Set` lookup per refresh for a diagnostic the async reader already
 * carries. The async reader is where this belongs: the writes are what matter
 * anyway, and every process that acts on the flag reads it there.
 */
function traceDisable(
	op: "read" | "write",
	decidedBy: string,
	value: boolean,
	cwd: string,
	profilePath: string,
	profile: RepoProfile,
): boolean {
	if (op === "read") {
		const key = `${profilePath}|${decidedBy}|${value}`;
		if (_tracedReads.has(key)) return value;
		_tracedReads.add(key);
	}
	log.info(
		"manual-disable %s → %s (by=%s, pid=%d, cwd=%s, profile=%s, raw: userDisabled=%s manuallyDisabled=%s fence=%s)",
		op,
		value,
		decidedBy,
		process.pid,
		cwd,
		profilePath,
		String(profile.userDisabled),
		String(profile.manuallyDisabled),
		profile.cutoverFence ? profile.cutoverFence.at : "none",
	);
	return value;
}

/** The caller frames of a manual-disable WRITE — which surface flipped it. */
function writerFrames(): string {
	const stack = new Error("manual-disable write").stack ?? "(no stack)";
	return stack.split("\n").slice(1, 8).join(" | ").replace(/\s+/g, " ");
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
 * Three sources, in strict precedence — only the first one present decides:
 *
 * 1. The retired `userDisabled` (0.99.11 – 0.99.13). It WINS while present, and
 *    is folded into `manuallyDisabled` and deleted in the same locked write. Its
 *    sibling composite may be fence-derived, so taking that instead would
 *    permanently disable every repo that had cut over — see the field's docstring.
 * 2. `manuallyDisabled`, the one switch. Returned as-is, with NO write.
 * 3. The legacy per-worktree `disabled-by-user` marker, enumerated across every
 *    worktree, with the decision persisted. A confirmed absence is persisted as
 *    `false` too, so hot-path hook checks do not enumerate all worktrees forever
 *    on a fresh install.
 *
 * The locked write re-reads and re-derives, so it cannot overwrite a concurrent
 * explicit enable/disable.
 */
export async function readManualDisableFlag(cwd: string): Promise<boolean> {
	const { profilePath } = await resolvePaths(cwd);
	const profile = await readRaw(profilePath);
	if (profile.userDisabled !== undefined) {
		const migrated = await persistDisableSwitch(cwd, profilePath, profile.userDisabled === true);
		return traceDisable("read", "migrate:userDisabled", migrated, cwd, profilePath, profile);
	}
	if (profile.manuallyDisabled !== undefined) {
		return traceDisable("read", "manuallyDisabled", profile.manuallyDisabled === true, cwd, profilePath, profile);
	}
	const legacy = await anyWorktreeHasLegacyDisableMarker(cwd);
	const migrated = await persistDisableSwitch(cwd, profilePath, legacy);
	return traceDisable("read", "migrate:legacy-marker", migrated, cwd, profilePath, profile);
}

/**
 * Locked, clobber-safe persist of a migrated decision — returning the value that
 * WON, not the one that was proposed.
 *
 * The caller decides its value from an UNLOCKED read, and the whole point of
 * taking the lock is that an explicit `jolli disable` — or another process's
 * migration — can land in between. So the value is RE-DERIVED here under the
 * lock, with the same precedence {@link readManualDisableFlag} uses: whatever the
 * profile says NOW beats a migration decided a moment ago. Returning the pre-lock
 * value instead made the caller answer "not disabled" against a profile that says
 * otherwise — and that caller is the hook gate, so the answer captured the very
 * commit the user had just opted out of.
 *
 * Writes nothing once the profile has converged (switch present, retired key
 * gone), so the steady state costs one read.
 *
 * On a lock failure — not acquired, or the write threw — the proposed value
 * stands: nothing was written, so there is no winner to prefer, and the next call
 * migrates again.
 */
async function persistDisableSwitch(cwd: string, profilePath: string, proposed: boolean): Promise<boolean> {
	const result = await withStrictProfileLock(cwd, async () => {
		const current = await readRaw(profilePath);
		// `??`, not `||`: a stored `false` is a decision, not an absent value. The
		// `=== true` normalizes a hand-edited non-boolean before it is written back.
		const decided = current.userDisabled ?? current.manuallyDisabled;
		const value = decided === undefined ? proposed : decided === true;
		if (current.userDisabled === undefined && current.manuallyDisabled !== undefined) return value;
		// A read that WRITES — logged with a stack for the same reason the explicit
		// writer is, plus the fence, because "was this repo merely frozen?" is the
		// question a wrong answer here would raise.
		log.info(
			"manual-disable MIGRATE → manuallyDisabled=%s (pid=%d, profile=%s, fence=%s, from=%s) ← %s",
			value,
			process.pid,
			profilePath,
			current.cutoverFence ? current.cutoverFence.at : "none",
			current.userDisabled !== undefined ? "userDisabled" : "legacy-marker",
			writerFrames(),
		);
		await writeProfile(profilePath, withDisableSwitch(current, value));
		return value;
	}).catch(() => undefined);
	return result?.acquired && result.value !== undefined ? result.value : proposed;
}

/**
 * Sets (`true`) or clears (`false`) the user's own disable. Deliberately blind
 * to the cutover fence: `jolli enable` clearing a fence would simultaneously
 * unfreeze the orphan branch for every old runtime on the machine.
 *
 * Retires the split `userDisabled` key in the same write — see
 * {@link withDisableSwitch} for why leaving it behind would hand older runtimes
 * the stale value.
 */
export async function writeManualDisableFlag(cwd: string, disabled: boolean): Promise<void> {
	const { profilePath } = await resolvePaths(cwd);
	log.info(
		"manual-disable WRITE %s (pid=%d, cwd=%s, profile=%s) ← %s",
		disabled,
		process.pid,
		cwd,
		profilePath,
		writerFrames(),
	);
	const result = await withStrictProfileLock(cwd, async () => {
		const current = await readRaw(profilePath);
		traceDisable("write", `explicit:${disabled}`, disabled, cwd, profilePath, current);
		await writeProfile(profilePath, withDisableSwitch(current, disabled));
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
 * Writes (or, on `null`, removes) the cutover fence — and touches NOTHING else.
 * Removal exists ONLY for doctor's explicit manual path — no automatic caller
 * may pass null, per the "封锁永不自动撤销" rule.
 *
 * It used to resolve and materialize the disable field first, because the
 * composite it then wrote was computed FROM the fence and would otherwise mask an
 * unmigrated legacy marker. With one plain switch there is nothing to recompute,
 * and leaving it alone is what keeps "frozen" and "disabled" orthogonal: freezing
 * a repo must not write, or even settle, the user's own opt-out.
 */
export async function writeCutoverFence(
	cwd: string,
	fence: { reason: string; at: string; tips?: Readonly<Record<string, string>> } | null,
): Promise<void> {
	const { profilePath } = await resolvePaths(cwd);
	const result = await withStrictProfileLock(cwd, async () => {
		const current = await readRaw(profilePath);
		const next = { ...current } as RepoProfile & { cutoverFence?: NonNullable<RepoProfile["cutoverFence"]> };
		if (fence === null) delete next.cutoverFence;
		else next.cutoverFence = fence;
		await writeProfile(profilePath, next);
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

/**
 * Test-only: clears this module's per-process memos so cases don't leak into each
 * other — the resolved roots above, and {@link traceDisable}'s already-traced
 * tuples, which are keyed by profile path and would otherwise let a recycled
 * temp directory suppress a line the next case expects.
 */
export function resetRepoProfileRootCache(): void {
	_mainRootCache.clear();
	_tracedReads.clear();
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
	// Deliberately NOT traced — see the ban in {@link traceDisable}'s docstring:
	// this runs before the Logger's zero-write gate is armed, and it is a hot
	// path. Nothing is lost: every caller that ACTS on this answer goes on to
	// consult the async reader, which does trace.
	let raw: string | undefined;
	try {
		raw = readFileSync(join(getJolliMemoryDir(mainRoot), PROFILE_FILE), "utf-8");
	} catch {
		// Missing or unreadable profile — fall through to the legacy marker.
	}
	const fromProfile = decodeManualDisable(raw);
	if (fromProfile !== undefined) return fromProfile;
	// Legacy per-worktree marker, this worktree only (the async reader
	// enumerates every worktree and migrates; this fast path stays cheap).
	try {
		statSync(join(getJolliMemoryDir(cwd), LEGACY_DISABLE_FILE));
		return true;
	} catch {
		return false;
	}
}

/**
 * The disable decision a profile's raw JSON carries, or `undefined` when it carries
 * none (absent, corrupt, or present but saying nothing about either field).
 *
 * Extracted so {@link readManualDisableFlagSync} and
 * {@link readManualDisableFlagReadonly} cannot drift. Which of the two fields wins is a
 * rule, not a detail, and it mirrors {@link readManualDisableFlag}'s precedence minus the
 * migration: the retired `userDisabled` (0.99.11 – 0.99.13) still WINS wherever a profile
 * carries it, because its sibling `manuallyDisabled` may be the fence-derived composite
 * those builds wrote — take that instead and every repo that had cut over reads as
 * permanently disabled. `manuallyDisabled`, the one switch, answers everything else.
 * Neither reader migrates, so a profile written by an older runtime keeps both spellings
 * until an async read folds them, and both must stay readable here.
 */
function decodeManualDisable(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const profile = parsed as RepoProfile;
	if (profile.userDisabled !== undefined) return profile.userDisabled === true;
	if (profile.manuallyDisabled !== undefined) return profile.manuallyDisabled === true;
	return undefined;
}

/**
 * Asynchronous, read-only variant — same decision as {@link readManualDisableFlagSync},
 * without blocking the event loop.
 *
 * For a caller that asks this repeatedly from a RESIDENT process: the global daemon's
 * session re-scan asks it once per registered repo per worktree every 30 seconds, and
 * the sync form makes that dozens of blocking syscalls a minute for the life of the
 * machine's uptime.
 *
 * NOT {@link readManualDisableFlag}, even though that one is already async, and the
 * difference is the whole reason this exists: that reader MIGRATES — it persists a
 * `userDisabled` decision for a pre-split profile and for the legacy marker. A question
 * asked on the way to a background task must not write someone's profile as a side
 * effect, which is the same rule `jolli dashboard` follows in choosing the sync
 * read-only form over it. This is that rule with the blocking removed, not a relaxation
 * of it.
 *
 * `resolveMainRootSync` is still shared, deliberately: it is memoized per cwd, so the
 * one call that can spawn `git rev-parse` happens at most once per directory per
 * process — and reimplementing the anchor asynchronously would restate the "a linked
 * worktree reads the shared profile" rule a second time.
 */
export async function readManualDisableFlagReadonly(cwd: string): Promise<boolean> {
	const mainRoot = resolveMainRootSync(cwd);
	let raw: string | undefined;
	try {
		raw = await readFile(join(getJolliMemoryDir(mainRoot), PROFILE_FILE), "utf-8");
	} catch {
		// Missing or unreadable profile — fall through to the legacy marker.
	}
	const fromProfile = decodeManualDisable(raw);
	if (fromProfile !== undefined) return fromProfile;
	try {
		await stat(join(getJolliMemoryDir(cwd), LEGACY_DISABLE_FILE));
		return true;
	} catch {
		return false;
	}
}
