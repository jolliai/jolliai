import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pass-through by default; `failNextProfileLock` makes exactly one acquisition
 * report a timeout, which is how a fire-and-forget locked write (it ignores
 * `acquired: false`) silently loses to a concurrent writer.
 */
let failNextProfileLock = false;
vi.mock("./Locks.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./Locks.js")>();
	return {
		...actual,
		withStrictProfileLock: async <T>(cwd: string, fn: () => Promise<T>, opts?: unknown) => {
			if (failNextProfileLock) {
				failNextProfileLock = false;
				return { acquired: false };
			}
			return actual.withStrictProfileLock(cwd, fn, opts as Parameters<typeof actual.withStrictProfileLock>[2]);
		},
	};
});

import {
	readCutoverFence,
	readManualDisableFlag,
	readManualDisableFlagReadonly,
	readManualDisableFlagSync,
	readRepoProfile,
	resetRepoProfileRootCache,
	updateRepoProfile,
	writeCutoverFence,
	writeManualDisableFlag,
} from "./RepoProfile.js";

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@t",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@t",
};

describe("RepoProfile", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "jolli-repoprofile-"));
		execFileSync("git", ["init", "-q"], { cwd });
		// The sync reader memoizes its main-root resolution per cwd; clear it so a
		// recycled temp path can't inherit a previous case's answer.
		resetRepoProfileRootCache();
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const profilePath = (root: string) => join(root, ".jolli", "jollimemory", "profile.json");

	it("returns an empty profile when no file exists", async () => {
		expect(await readRepoProfile(cwd)).toEqual({});
	});

	it("persists a field to <main-root>/.jolli/jollimemory/profile.json and reads it back", async () => {
		await updateRepoProfile(cwd, { backfillDismissed: true });
		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: true });
		expect(existsSync(profilePath(cwd))).toBe(true);
	});

	it("merges patches instead of overwriting the whole profile", async () => {
		await updateRepoProfile(cwd, { backfillDismissed: true });
		await updateRepoProfile(cwd, {});
		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: true });
		await updateRepoProfile(cwd, { backfillDismissed: false });
		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: false });
	});

	it("tolerates a corrupt profile.json (returns empty)", async () => {
		mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
		writeFileSync(profilePath(cwd), "{ not json");
		expect(await readRepoProfile(cwd)).toEqual({});
	});

	it("treats valid-but-non-object JSON as empty", async () => {
		mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
		writeFileSync(profilePath(cwd), "null");
		expect(await readRepoProfile(cwd)).toEqual({});
	});

	it("migrates the legacy backfill-card-dismissed marker on read, persists it, and retires the marker", async () => {
		// Legacy location: <git-common-dir>/jollimemory/backfill-card-dismissed.
		const legacyMarker = join(cwd, ".git", "jollimemory", "backfill-card-dismissed");
		mkdirSync(join(cwd, ".git", "jollimemory"), { recursive: true });
		writeFileSync(legacyMarker, new Date(0).toISOString());

		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: true });
		expect(existsSync(profilePath(cwd))).toBe(true);
		// A successful migration retires the marker so a later profile.json reset
		// (deleting the field) can't resurrect a stale dismiss.
		expect(existsSync(legacyMarker)).toBe(false);

		// The dismiss survives from profile.json alone (marker already gone).
		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: true });
	});

	it("still returns the migrated value when persisting the migration fails", async () => {
		// Make writeProfile fail deterministically: put a DIRECTORY where profile.json
		// should be, so the best-effort persist throws (EISDIR/EPERM) but read recovers.
		mkdirSync(profilePath(cwd), { recursive: true });
		const legacyDir = join(cwd, ".git", "jollimemory");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "backfill-card-dismissed"), new Date(0).toISOString());
		// Precondition guard: profile.json must be an (unwritable/unreadable) directory,
		// so the persist genuinely throws and the .catch is genuinely exercised. If a
		// platform ever let the write through, this asserts the setup is still valid.
		expect(statSync(profilePath(cwd)).isDirectory()).toBe(true);

		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: true });
		// Persist failed → profile.json is still the directory (never became a file).
		expect(statSync(profilePath(cwd)).isDirectory()).toBe(true);
		// ...and the marker is preserved (unlink never runs when the persist throws),
		// so the next read re-migrates.
		expect(existsSync(join(legacyDir, "backfill-card-dismissed"))).toBe(true);
	});

	it("migrates and persists even when retiring the marker fails", async () => {
		// Make the unlink fail deterministically: the marker is a non-empty DIRECTORY,
		// so fileExists() still sees it but unlink() throws (EISDIR/EPERM). The persist
		// succeeds, so the dismiss must still land in profile.json without crashing.
		const legacyMarker = join(cwd, ".git", "jollimemory", "backfill-card-dismissed");
		mkdirSync(legacyMarker, { recursive: true });
		writeFileSync(join(legacyMarker, "child"), "keeps the dir non-empty");

		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: true });
		expect(existsSync(profilePath(cwd))).toBe(true);
		// The marker dir lingers (unlink failed) but is now inert: profile.json carries
		// the field, so the next read never consults the marker again.
		expect(existsSync(legacyMarker)).toBe(true);
		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: true });
	});

	it("does NOT let the legacy marker override an explicit profile value", async () => {
		const legacyDir = join(cwd, ".git", "jollimemory");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "backfill-card-dismissed"), new Date(0).toISOString());
		// Explicit false in the profile wins over the legacy "dismissed" marker.
		await updateRepoProfile(cwd, { backfillDismissed: false });
		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: false });
	});

	it("falls back to the per-project .jolli dir when not a git repo", async () => {
		const nonGit = mkdtempSync(join(tmpdir(), "jolli-repoprofile-nogit-"));
		try {
			expect(await readRepoProfile(nonGit)).toEqual({});
			await updateRepoProfile(nonGit, { backfillDismissed: true });
			expect(await readRepoProfile(nonGit)).toEqual({ backfillDismissed: true });
			expect(existsSync(profilePath(nonGit))).toBe(true);
			expect(existsSync(join(nonGit, ".git"))).toBe(false);
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	});

	it("is shared across worktrees of the same repo (repo-wide, not per-worktree)", async () => {
		execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd, env: GIT_ENV });
		await updateRepoProfile(cwd, { backfillDismissed: true });
		const wt = mkdtempSync(join(tmpdir(), "jolli-repoprofile-wt-"));
		try {
			execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd });
			// Linked worktree resolves to the MAIN worktree's profile.json.
			expect(await readRepoProfile(wt)).toEqual({ backfillDismissed: true });
		} finally {
			rmSync(wt, { recursive: true, force: true });
		}
	});

	describe("manual-disable flag", () => {
		const legacyMarker = (root: string) => join(root, ".jolli", "jollimemory", "disabled-by-user");

		it("defaults to false when nothing is set", async () => {
			expect(await readManualDisableFlag(cwd)).toBe(false);
			expect(await readRepoProfile(cwd)).toEqual({ userDisabled: false, manuallyDisabled: false });
		});

		it("round-trips true/false through profile.json", async () => {
			await writeManualDisableFlag(cwd, true);
			expect(await readManualDisableFlag(cwd)).toBe(true);
			expect(await readRepoProfile(cwd)).toEqual({ userDisabled: true, manuallyDisabled: true });

			await writeManualDisableFlag(cwd, false);
			expect(await readManualDisableFlag(cwd)).toBe(false);
		});

		it("does not clobber a sibling profile field (backfillDismissed)", async () => {
			await updateRepoProfile(cwd, { backfillDismissed: true });
			await writeManualDisableFlag(cwd, true);
			expect(await readRepoProfile(cwd)).toEqual({
				backfillDismissed: true,
				userDisabled: true,
				manuallyDisabled: true,
			});
		});

		it("migrates a legacy per-worktree disabled-by-user marker in the main worktree", async () => {
			mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
			writeFileSync(legacyMarker(cwd), new Date(0).toISOString());

			expect(await readManualDisableFlag(cwd)).toBe(true);
			// Persisted (read-once): removing the legacy marker still reads disabled.
			rmSync(legacyMarker(cwd));
			expect(await readManualDisableFlag(cwd)).toBe(true);
		});

		it("migrates a legacy marker that lives in a LINKED worktree (enumerates all worktrees)", async () => {
			execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd, env: GIT_ENV });
			const wt = mkdtempSync(join(tmpdir(), "jolli-repoprofile-wt-"));
			try {
				execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd });
				mkdirSync(join(wt, ".jolli", "jollimemory"), { recursive: true });
				writeFileSync(legacyMarker(wt), new Date(0).toISOString());
				// Reading from the MAIN worktree finds the marker in the linked one.
				expect(await readManualDisableFlag(cwd)).toBe(true);
			} finally {
				rmSync(wt, { recursive: true, force: true });
			}
		});

		it("lets an explicit profile value win over a leftover legacy marker", async () => {
			mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
			writeFileSync(legacyMarker(cwd), new Date(0).toISOString());
			await writeManualDisableFlag(cwd, false);
			expect(await readManualDisableFlag(cwd)).toBe(false);
		});

		it("uses the explicit true fast-path (no migration) even with a legacy marker present", async () => {
			mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
			writeFileSync(legacyMarker(cwd), new Date(0).toISOString());
			await writeManualDisableFlag(cwd, true);
			expect(await readManualDisableFlag(cwd)).toBe(true);
		});

		it("still returns the migrated value when persisting the migration fails", async () => {
			// profile.json is a directory → best-effort persist throws, read recovers.
			mkdirSync(profilePath(cwd), { recursive: true });
			mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
			writeFileSync(legacyMarker(cwd), new Date(0).toISOString());
			expect(statSync(profilePath(cwd)).isDirectory()).toBe(true);

			expect(await readManualDisableFlag(cwd)).toBe(true);
			expect(statSync(profilePath(cwd)).isDirectory()).toBe(true);
		});

		it("falls back to checking only cwd when not a git repo (listWorktrees fails)", async () => {
			const nonGit = mkdtempSync(join(tmpdir(), "jolli-repoprofile-nogit-"));
			try {
				mkdirSync(join(nonGit, ".jolli", "jollimemory"), { recursive: true });
				writeFileSync(legacyMarker(nonGit), new Date(0).toISOString());
				expect(await readManualDisableFlag(nonGit)).toBe(true);
			} finally {
				rmSync(nonGit, { recursive: true, force: true });
			}
		});

		it("is shared across worktrees (disable in one holds in the other)", async () => {
			execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd, env: GIT_ENV });
			await writeManualDisableFlag(cwd, true);
			const wt = mkdtempSync(join(tmpdir(), "jolli-repoprofile-wt-"));
			try {
				execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd });
				expect(await readManualDisableFlag(wt)).toBe(true);
			} finally {
				rmSync(wt, { recursive: true, force: true });
			}
		});

		it("does not lose a sibling field under interleaved concurrent writes (shared lock)", async () => {
			// A backfill-dismiss write (updateRepoProfile) and a manual-disable write
			// racing on the same repo-wide profile.json must BOTH survive — the
			// profile lock serialises the read-modify-writes so neither clobbers the
			// other. Pre-lock, last-writer-wins could silently drop manuallyDisabled.
			await Promise.all([updateRepoProfile(cwd, { backfillDismissed: true }), writeManualDisableFlag(cwd, true)]);
			expect(await readRepoProfile(cwd)).toEqual({
				backfillDismissed: true,
				userDisabled: true,
				manuallyDisabled: true,
			});
		});

		describe("readManualDisableFlagSync", () => {
			it("returns false when nothing is set", () => {
				expect(readManualDisableFlagSync(cwd)).toBe(false);
			});

			it("reads an explicit profile.json value (true then false)", async () => {
				await writeManualDisableFlag(cwd, true);
				expect(readManualDisableFlagSync(cwd)).toBe(true);
				await writeManualDisableFlag(cwd, false);
				expect(readManualDisableFlagSync(cwd)).toBe(false);
			});

			it("reads the main-worktree profile from a linked worktree", async () => {
				execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd, env: GIT_ENV });
				await writeManualDisableFlag(cwd, true);
				const wt = mkdtempSync(join(tmpdir(), "jolli-repoprofile-wt-"));
				try {
					execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd });
					expect(readManualDisableFlagSync(wt)).toBe(true);
				} finally {
					rmSync(wt, { recursive: true, force: true });
				}
			});

			it("falls back to the legacy cwd marker when no profile value is set", () => {
				mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
				writeFileSync(legacyMarker(cwd), new Date(0).toISOString());
				expect(readManualDisableFlagSync(cwd)).toBe(true);
			});

			it("memoizes the main-root resolution so repeat calls spawn no further git", async () => {
				// The funnel telemetry gate calls this on every VS Code status refresh, so
				// the `git rev-parse` must be paid once per cwd. Proven behaviorally: read
				// from a SUBDIR (where the resolution is what maps it back to the repo
				// root), then remove `.git`. A memoized reader keeps answering from the
				// main root; an unmemoized one would re-resolve, fail, and fall back to the
				// subdir — where there is no profile.
				const sub = join(cwd, "nested");
				mkdirSync(sub, { recursive: true });
				await writeManualDisableFlag(cwd, true);
				expect(readManualDisableFlagSync(sub)).toBe(true);

				rmSync(join(cwd, ".git"), { recursive: true, force: true });
				expect(readManualDisableFlagSync(sub)).toBe(true);

				resetRepoProfileRootCache();
				expect(readManualDisableFlagSync(sub)).toBe(false);
			});

			it("returns false for a non-git dir with no profile or marker", () => {
				const nonGit = mkdtempSync(join(tmpdir(), "jolli-repoprofile-nogit-"));
				try {
					expect(readManualDisableFlagSync(nonGit)).toBe(false);
				} finally {
					rmSync(nonGit, { recursive: true, force: true });
				}
			});
		});

		/**
		 * The async twin, for a RESIDENT caller: the global daemon's session re-scan asks
		 * this once per repo per worktree every 30 seconds, and the sync form makes that
		 * dozens of blocking syscalls a minute for the machine's whole uptime.
		 *
		 * Asserted to agree with the sync form case for case rather than tested in
		 * isolation — the two share `decodeManualDisable` precisely so the "userDisabled
		 * wins, the composite is only the pre-split fallback" rule exists once, and a
		 * divergence here would mean a cutover fence starting to block a runtime it must
		 * not block.
		 */
		describe("readManualDisableFlagReadonly", () => {
			it("returns false when nothing is set", async () => {
				await expect(readManualDisableFlagReadonly(cwd)).resolves.toBe(false);
			});

			it("reads an explicit profile.json value (true then false)", async () => {
				await writeManualDisableFlag(cwd, true);
				await expect(readManualDisableFlagReadonly(cwd)).resolves.toBe(true);
				await writeManualDisableFlag(cwd, false);
				await expect(readManualDisableFlagReadonly(cwd)).resolves.toBe(false);
			});

			it("prefers userDisabled, then falls back to the pre-split composite", async () => {
				mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
				// A fence-era profile: the composite says disabled, the user's own axis says
				// otherwise. New code decides on `userDisabled`, so a fence must NOT stop
				// this runtime — the whole reason the composite is a fallback and not a peer.
				writeFileSync(profilePath(cwd), JSON.stringify({ userDisabled: false, manuallyDisabled: true }));
				await expect(readManualDisableFlagReadonly(cwd)).resolves.toBe(false);

				writeFileSync(profilePath(cwd), JSON.stringify({ manuallyDisabled: true }));
				await expect(readManualDisableFlagReadonly(cwd)).resolves.toBe(true);
			});

			it("reads the main-worktree profile from a linked worktree", async () => {
				execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd, env: GIT_ENV });
				await writeManualDisableFlag(cwd, true);
				const wt = mkdtempSync(join(tmpdir(), "jolli-repoprofile-awt-"));
				try {
					execFileSync("git", ["worktree", "add", "-q", wt, "HEAD"], { cwd });
					await expect(readManualDisableFlagReadonly(wt)).resolves.toBe(true);
				} finally {
					rmSync(wt, { recursive: true, force: true });
				}
			});

			it("falls back to the legacy cwd marker when no profile value is set", async () => {
				mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
				writeFileSync(legacyMarker(cwd), new Date(0).toISOString());
				await expect(readManualDisableFlagReadonly(cwd)).resolves.toBe(true);
			});

			it("treats a corrupt profile as saying nothing rather than throwing", async () => {
				mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
				writeFileSync(profilePath(cwd), "{ not json");
				await expect(readManualDisableFlagReadonly(cwd)).resolves.toBe(false);
			});

			it("never migrates or persists, unlike the async READER it is not", async () => {
				// The reason this exists alongside `readManualDisableFlag`, which is already
				// async: that one persists a `userDisabled` decision for a pre-split profile
				// and for the legacy marker. A question asked on the way to a background task
				// must not write someone's profile as a side effect.
				mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
				writeFileSync(legacyMarker(cwd), new Date(0).toISOString());

				await expect(readManualDisableFlagReadonly(cwd)).resolves.toBe(true);
				expect(existsSync(profilePath(cwd))).toBe(false);

				// The migrating reader, for contrast — same answer, but it writes.
				await expect(readManualDisableFlag(cwd)).resolves.toBe(true);
				expect(existsSync(profilePath(cwd))).toBe(true);
			});
		});
	});
});

describe("three-field disable state (cutover fence)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "jolli-fence-"));
		mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));
	const profilePath = () => join(cwd, ".jolli", "jollimemory", "profile.json");
	const disk = () => JSON.parse(readFileSync(profilePath(), "utf-8")) as Record<string, unknown>;

	it("walks all four combinations of userDisabled x cutoverFence", async () => {
		// neither: everything runs, composite false.
		await writeManualDisableFlag(cwd, false);
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(disk().manuallyDisabled).toBe(false);
		// fence only: THIS runtime keeps working (reader false) while the
		// composite stops every old runtime on disk.
		await writeCutoverFence(cwd, { reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" });
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(disk().manuallyDisabled).toBe(true);
		expect(await readCutoverFence(cwd)).toEqual({ reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" });
		// fence + user disable: everything stops (userDisabled outranks fence).
		await writeManualDisableFlag(cwd, true);
		expect(await readManualDisableFlag(cwd)).toBe(true);
		expect(disk().manuallyDisabled).toBe(true);
		// enable clears ONLY the user's half: the fence survives, so old
		// runtimes stay stopped while this one resumes.
		await writeManualDisableFlag(cwd, false);
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(await readCutoverFence(cwd)).not.toBeNull();
		expect(disk().manuallyDisabled).toBe(true);
		// user disable only (doctor's manual unfence, then disable).
		await writeCutoverFence(cwd, null);
		await writeManualDisableFlag(cwd, true);
		expect(disk().cutoverFence).toBeUndefined();
		expect(disk().manuallyDisabled).toBe(true);
	});

	it("a virgin profile fenced before userDisabled was ever written is not migrated into a permanent user-disable", async () => {
		// Unlike "walks all four combinations" above (which writes userDisabled
		// explicitly via writeManualDisableFlag BEFORE ever fencing), this
		// profile has never had userDisabled touched — the real-world case
		// where cutover fences a repo before any hook has resolved its
		// disable state at all.
		await writeCutoverFence(cwd, { reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" });
		// The fence write itself must resolve and persist userDisabled, so the
		// composite it derives (`manuallyDisabled: true`, for old runtimes)
		// is never later misread as a pre-split legacy disable.
		expect(disk().userDisabled).toBe(false);
		expect(disk().manuallyDisabled).toBe(true);
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(disk().userDisabled).toBe(false);
	});

	it("materializes userDisabled even when the forcing persist loses the lock", async () => {
		// `writeCutoverFence` forces the split by calling `readManualDisableFlag`,
		// but that persist is fire-and-forget: `withStrictProfileLock` returns
		// `{acquired:false}` WITHOUT running fn on a timeout, and the result is
		// ignored. Lose that one write (a concurrent `backfillDismissed` write
		// holding the lock is enough) and the fence lands on a profile with
		// `manuallyDisabled: true` and no `userDisabled` — which the next read
		// takes for a pre-split legacy disable and folds onto `userDisabled:
		// true`, permanently stopping SQLite writes too, on a repo the user
		// never disabled. The fence's own locked write must therefore
		// materialize the field itself.
		failNextProfileLock = true;
		await writeCutoverFence(cwd, { reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" });
		expect(disk().userDisabled).toBe(false);
		expect(disk().manuallyDisabled).toBe(true);
		// The fence is NOT a user disable: this runtime keeps writing SQLite.
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(disk().userDisabled).toBe(false);
	});

	it("does not overwrite a userDisabled value a concurrent writer just persisted", async () => {
		// Absence-only materialization: an explicit disable that landed between
		// the forcing read and the fence's locked write must survive.
		writeFileSync(profilePath(), JSON.stringify({ userDisabled: true, manuallyDisabled: true }));
		await writeCutoverFence(cwd, { reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" });
		expect(disk().userDisabled).toBe(true);
		expect(await readManualDisableFlag(cwd)).toBe(true);
	});

	it("migrates a pre-split composite onto userDisabled", async () => {
		writeFileSync(profilePath(), JSON.stringify({ manuallyDisabled: true }));
		expect(await readManualDisableFlag(cwd)).toBe(true);
		expect(disk().userDisabled).toBe(true);
		expect(disk().manuallyDisabled).toBe(true);
	});

	it("sync reader decides on userDisabled, not the composite", () => {
		// A fence-only profile: the composite is true (for old runtimes) but
		// this runtime must keep going.
		writeFileSync(
			profilePath(),
			JSON.stringify({ userDisabled: false, manuallyDisabled: true, cutoverFence: { reason: "r", at: "t" } }),
		);
		expect(readManualDisableFlagSync(cwd)).toBe(false);
		// Pre-split profile: composite is the migration fallback.
		writeFileSync(profilePath(), JSON.stringify({ manuallyDisabled: true }));
		expect(readManualDisableFlagSync(cwd)).toBe(true);
	});
});
