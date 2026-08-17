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

import { setSilentConsole } from "../Logger.js";
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
			// ONE field: the confirmed absence is persisted so hook-path reads stop
			// enumerating every worktree for a legacy marker.
			expect(await readRepoProfile(cwd)).toEqual({ manuallyDisabled: false });
		});

		it("round-trips true/false through profile.json", async () => {
			await writeManualDisableFlag(cwd, true);
			expect(await readManualDisableFlag(cwd)).toBe(true);
			expect(await readRepoProfile(cwd)).toEqual({ manuallyDisabled: true });

			await writeManualDisableFlag(cwd, false);
			expect(await readManualDisableFlag(cwd)).toBe(false);
		});

		it("does not clobber a sibling profile field (backfillDismissed)", async () => {
			await updateRepoProfile(cwd, { backfillDismissed: true });
			await writeManualDisableFlag(cwd, true);
			expect(await readRepoProfile(cwd)).toEqual({
				backfillDismissed: true,
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
				manuallyDisabled: true,
			});
		});

		/**
		 * The trace's unit of information is `(profilePath, decidedBy, value)` per
		 * process — not the call. These cases pin that the two signals the trace
		 * exists for survive the memo (a value CHANGE still emits; writes never
		 * dedupe) while the steady-state repeat does not, because that repeat is
		 * what reached IntelliJ's per-`refreshStatus()` bridge read and turned a
		 * diagnostic into the highest-frequency write this module can produce — in a
		 * repo the user may have disabled, where the Logger's zero-write gate is
		 * inert (only the VS Code extension host ever arms it).
		 *
		 * Asserted on `console.error` because `enqueueLogWrite` short-circuits under
		 * `VITEST`: the disk write is unobservable here, the console call is not.
		 * `setSilentConsole(false)` is what makes it observable at all — the default
		 * is CLI mode, where info never reaches stderr — and it is restored after,
		 * since the flag is process-global.
		 */
		describe("the read trace", () => {
			let spy: ReturnType<typeof vi.spyOn>;
			let emitted: string[];
			beforeEach(() => {
				emitted = [];
				setSilentConsole(false);
				spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
					emitted.push(String(args[0]));
				});
			});
			afterEach(() => {
				spy.mockRestore();
				setSilentConsole(true);
			});
			const linesFor = (op: "read" | "write") => emitted.filter((l) => l.includes(`manual-disable ${op} →`));

			it("emits once per process for a settled value, however often it is read", async () => {
				await writeManualDisableFlag(cwd, true);
				expect(await readManualDisableFlag(cwd)).toBe(true);
				expect(await readManualDisableFlag(cwd)).toBe(true);
				expect(await readManualDisableFlag(cwd)).toBe(true);
				expect(linesFor("read")).toHaveLength(1);
			});

			it("re-emits when the value changes inside one process — the read event worth a line", async () => {
				await writeManualDisableFlag(cwd, true);
				expect(await readManualDisableFlag(cwd)).toBe(true);
				await writeManualDisableFlag(cwd, false);
				expect(await readManualDisableFlag(cwd)).toBe(false);
				expect(linesFor("read")).toHaveLength(2);
			});

			it("re-emits when a different FIELD decided the same value — that is the disagreement it explains", async () => {
				// Fresh repo: the first read decides through the legacy-marker migration
				// and persists `false`; the second is answered by `manuallyDisabled`.
				// Same value, different deciding source, so both lines are kept — the
				// deciding field is exactly what identified the culprit last time.
				expect(await readManualDisableFlag(cwd)).toBe(false);
				expect(await readManualDisableFlag(cwd)).toBe(false);
				const lines = linesFor("read");
				expect(lines).toHaveLength(2);
				expect(lines[0]).toContain("by=migrate:legacy-marker");
				expect(lines[1]).toContain("by=manuallyDisabled");
			});

			it("never dedupes a WRITE — rare, stack-carrying, and the question is who flipped it", async () => {
				await writeManualDisableFlag(cwd, true);
				await writeManualDisableFlag(cwd, true);
				expect(linesFor("write")).toHaveLength(2);
			});

			it("keys on the profile path, so one repo's reads cannot silence another's", async () => {
				const other = mkdtempSync(join(tmpdir(), "jolli-repoprofile-other-"));
				try {
					execFileSync("git", ["init", "-q"], { cwd: other });
					await writeManualDisableFlag(cwd, true);
					await writeManualDisableFlag(other, true);
					expect(await readManualDisableFlag(cwd)).toBe(true);
					expect(await readManualDisableFlag(other)).toBe(true);
					expect(linesFor("read")).toHaveLength(2);
				} finally {
					rmSync(other, { recursive: true, force: true });
				}
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

describe("one disable switch, orthogonal to the cutover fence", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "jolli-fence-"));
		mkdirSync(join(cwd, ".jolli", "jollimemory"), { recursive: true });
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));
	const profilePath = () => join(cwd, ".jolli", "jollimemory", "profile.json");
	const disk = () => JSON.parse(readFileSync(profilePath(), "utf-8")) as Record<string, unknown>;

	it("walks all four combinations of the switch x cutoverFence", async () => {
		// neither: everything runs.
		await writeManualDisableFlag(cwd, false);
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(disk().manuallyDisabled).toBe(false);
		// fence only: the switch stays FALSE, and the fence write does not touch it
		// at all. It used to be folded in, to stop old runtimes writing the frozen
		// branch — but this is the only field they read, and a pre-0.99.11 plugin
		// reads it as "the user disabled this repo" and uninstalls the whole repo's
		// hooks and MCP entries. Old runtimes are left running instead, and
		// probeCutoverDrift catches up whatever they write.
		await writeCutoverFence(cwd, { reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" });
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(disk().manuallyDisabled).toBe(false);
		expect(await readCutoverFence(cwd)).toEqual({ reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" });
		// fence + user disable: everything stops. Only the user can put it here.
		await writeManualDisableFlag(cwd, true);
		expect(await readManualDisableFlag(cwd)).toBe(true);
		expect(disk().manuallyDisabled).toBe(true);
		// enable clears the switch; the fence survives (one-way).
		await writeManualDisableFlag(cwd, false);
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(await readCutoverFence(cwd)).not.toBeNull();
		expect(disk().manuallyDisabled).toBe(false);
		// user disable only (doctor's manual unfence, then disable).
		await writeCutoverFence(cwd, null);
		await writeManualDisableFlag(cwd, true);
		expect(disk().cutoverFence).toBeUndefined();
		expect(disk().manuallyDisabled).toBe(true);
	});

	it("folds a fence-poisoned split profile onto the switch — the dangerous mapping", async () => {
		// Exactly what a repo fenced by 0.99.11–0.99.13 carries: a composite that
		// the FENCE turned true, next to the user's own `false`. Taking the composite
		// here would permanently disable every repo that had cut over, which is why
		// the retired field wins while it is present.
		writeFileSync(
			profilePath(),
			JSON.stringify({ userDisabled: false, manuallyDisabled: true, cutoverFence: { reason: "r", at: "t" } }),
		);
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(disk().manuallyDisabled).toBe(false);
		// The retired key is gone, so no older runtime can read a stale value from it.
		expect(disk()).not.toHaveProperty("userDisabled");
		// The fence itself is untouched — it is one-way, and was never the problem.
		expect(disk().cutoverFence).toEqual({ reason: "r", at: "t" });
	});

	it("folds a real user-disable the same way, and keeps sibling fields", async () => {
		writeFileSync(
			profilePath(),
			JSON.stringify({ userDisabled: true, manuallyDisabled: false, backfillDismissed: true }),
		);
		expect(await readManualDisableFlag(cwd)).toBe(true);
		expect(disk().manuallyDisabled).toBe(true);
		expect(disk()).not.toHaveProperty("userDisabled");
		expect(disk().backfillDismissed).toBe(true);
	});

	it("re-folds a retired key an older runtime wrote back — the migration is not one-shot", async () => {
		// A plugin bundle execs its own dist and never passes through `run-hook`'s
		// version race, so a 0.99.11–0.99.13 writer can reappear after the migration
		// and re-create the split. Every read has to fold it again.
		await writeManualDisableFlag(cwd, false);
		expect(disk()).not.toHaveProperty("userDisabled");
		writeFileSync(profilePath(), JSON.stringify({ userDisabled: true, manuallyDisabled: true }));
		expect(await readManualDisableFlag(cwd)).toBe(true);
		expect(disk()).not.toHaveProperty("userDisabled");
		expect(disk().manuallyDisabled).toBe(true);
	});

	it("a virgin profile fenced before any disable was resolved stays enabled", async () => {
		// The real-world case: cutover fences a repo before any hook has resolved
		// its disable state at all. The fence write touches nothing but the fence,
		// so the switch is still absent afterwards — and absent reads as enabled.
		await writeCutoverFence(cwd, { reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" });
		expect(disk()).not.toHaveProperty("manuallyDisabled");
		expect(await readManualDisableFlag(cwd)).toBe(false);
		expect(disk().manuallyDisabled).toBe(false);
	});

	it("the fence write needs no profile lock dance to settle the switch", async () => {
		// `writeCutoverFence` used to force the split by calling
		// `readManualDisableFlag` first, then materialize the field inside its own
		// locked write, because the composite it wrote was derived FROM the fence and
		// would otherwise mask an unmigrated legacy marker. With one plain switch
		// there is nothing to derive, so a lost lock on some other write cannot leave
		// the disable state half-settled.
		failNextProfileLock = true;
		writeFileSync(profilePath(), JSON.stringify({ manuallyDisabled: true }));
		await expect(
			writeCutoverFence(cwd, { reason: "cutover to sqlite", at: "2026-08-04T00:00:00Z" }),
		).rejects.toThrow(/profile lock/);
		// The switch the user set is untouched by the failed fence write.
		expect(disk().manuallyDisabled).toBe(true);
		expect(await readManualDisableFlag(cwd)).toBe(true);
	});

	it("a concurrent explicit write beats a migration decided before the lock", async () => {
		// The migration reads unlocked, so an explicit disable can land in between.
		// The value is re-derived under the lock, so the explicit one wins.
		writeFileSync(profilePath(), JSON.stringify({ userDisabled: false }));
		const race = readManualDisableFlag(cwd);
		await writeManualDisableFlag(cwd, true);
		await race;
		expect(await readManualDisableFlag(cwd)).toBe(true);
		expect(disk().manuallyDisabled).toBe(true);
	});

	it("adopts a pre-split profile as-is, writing nothing", async () => {
		// (a)-class: written before the fence existed, so the value can only be the
		// user's own. Converged already — no write, and no retired key invented.
		writeFileSync(profilePath(), JSON.stringify({ manuallyDisabled: true }));
		const before = readFileSync(profilePath(), "utf-8");
		expect(await readManualDisableFlag(cwd)).toBe(true);
		expect(readFileSync(profilePath(), "utf-8")).toBe(before);
	});

	it("sync reader honours the retired key first, then the switch", () => {
		// A split profile whose composite is fence-poisoned: the retired field is
		// still the answer, exactly as in the async reader.
		writeFileSync(
			profilePath(),
			JSON.stringify({ userDisabled: false, manuallyDisabled: true, cutoverFence: { reason: "r", at: "t" } }),
		);
		expect(readManualDisableFlagSync(cwd)).toBe(false);
		// Converged profile: the switch alone.
		writeFileSync(profilePath(), JSON.stringify({ manuallyDisabled: true }));
		expect(readManualDisableFlagSync(cwd)).toBe(true);
	});
});

/**
 * Source-shape guard: the SYNC reader must never log.
 *
 * Not expressible as a behavioural test — `enqueueLogWrite` short-circuits on
 * `process.env.VITEST`, so no assertion inside this suite can observe the write
 * that matters. What matters is on the VS Code extension host: `activate()`
 * calls `readManualDisableFlagSync` to seed the Logger's zero-write flag, so a
 * log line emitted INSIDE that call runs while the gate is still open and lands
 * on disk in a repo the user disabled — the one thing the ordering comment at
 * that call site exists to prevent. It is also a hot path (every
 * `StatusStore.refresh()`, plus two file watchers during a live AI session).
 */
describe("readManualDisableFlagSync source shape", () => {
	const source = readFileSync(new URL("./RepoProfile.ts", import.meta.url), "utf-8");
	const body = source.slice(source.indexOf("export function readManualDisableFlagSync"));
	const syncBody = body.slice(0, body.indexOf("\n}\n"));

	// CALLS, not mentions: the body deliberately names `traceDisable` in a comment
	// explaining why it must not call it, and a bare substring match reads that
	// explanation as the violation it forbids.
	it("emits no log line — the zero-write gate is not yet armed when it runs", () => {
		expect(syncBody).not.toContain("traceDisable(");
		expect(syncBody).not.toContain("log.info(");
		expect(syncBody).not.toContain("log.warn(");
	});

	it("the ASYNC reader still traces — the diagnostic has to live somewhere", () => {
		const asyncBody = source.slice(source.indexOf("export async function readManualDisableFlag("));
		expect(asyncBody.slice(0, asyncBody.indexOf("\n}\n"))).toContain("traceDisable(");
	});
});
