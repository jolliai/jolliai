import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoProfile, updateRepoProfile } from "./RepoProfile.js";

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

	it("migrates the legacy backfill-card-dismissed marker on read and persists it (read-once)", async () => {
		// Legacy location: <git-common-dir>/jollimemory/backfill-card-dismissed.
		const legacyMarker = join(cwd, ".git", "jollimemory", "backfill-card-dismissed");
		mkdirSync(join(cwd, ".git", "jollimemory"), { recursive: true });
		writeFileSync(legacyMarker, new Date(0).toISOString());

		expect(await readRepoProfile(cwd)).toEqual({ backfillDismissed: true });
		expect(existsSync(profilePath(cwd))).toBe(true);

		// Prove the value was PERSISTED, not merely re-derived: remove the legacy
		// marker and read again — the dismiss must survive from profile.json alone.
		rmSync(legacyMarker);
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
});
