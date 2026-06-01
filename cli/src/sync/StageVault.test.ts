import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitClient } from "./GitClient.js";
import type { PorcelainEntry } from "./PorcelainParser.js";
import { stageVault } from "./StageVault.js";

/**
 * StageVault tests use a real (temp-dir) vault for the on-disk lstat
 * checks, but a mocked `GitClient.statusPorcelainZ` / `stageAddPaths` /
 * `stageRemovePaths` so we can deterministically inject porcelain
 * fixtures and assert what got passed to git. The classifier + symlink
 * guard run against the real disk so the integration between filter +
 * stage-side calls is exercised end-to-end.
 */

const HASH40 = "abc1234567890abcdef1234567890abcdef12345";
const HASH8 = "1a2b3c4d";

function makeClient(entries: PorcelainEntry[]): {
	client: Pick<
		GitClient,
		"statusPorcelainZ" | "stageAddPaths" | "stageRemovePaths" | "unstagePaths" | "resetPathsToHead"
	>;
	stageAdd: ReturnType<typeof vi.fn>;
	stageRm: ReturnType<typeof vi.fn>;
	unstage: ReturnType<typeof vi.fn>;
	reset: ReturnType<typeof vi.fn>;
} {
	const stageAdd = vi.fn().mockResolvedValue(undefined);
	const stageRm = vi.fn().mockResolvedValue(undefined);
	const unstage = vi.fn().mockResolvedValue(undefined);
	const reset = vi.fn().mockResolvedValue(undefined);
	return {
		client: {
			statusPorcelainZ: vi.fn().mockResolvedValue(entries),
			stageAddPaths: stageAdd,
			stageRemovePaths: stageRm,
			unstagePaths: unstage,
			resetPathsToHead: reset,
		},
		stageAdd,
		stageRm,
		unstage,
		reset,
	};
}

function entry(over: Partial<PorcelainEntry> & Pick<PorcelainEntry, "path">): PorcelainEntry {
	return {
		indexStatus: "?",
		worktreeStatus: "?",
		...over,
	};
}

describe("stageVault — basic flow", () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "stagevault-"));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("stages classifier-owned additions and skips unowned paths", async () => {
		mkdirSync(join(vault, "myrepo", ".jolli", "summaries"), { recursive: true });
		mkdirSync(join(vault, "myrepo", "main"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "summaries", `${HASH40}.json`), "{}");
		writeFileSync(join(vault, "myrepo", "main", `foo-${HASH8}.md`), "# foo");
		writeFileSync(join(vault, "myrepo", ".DS_Store"), ""); // unowned

		const { client, stageAdd, stageRm } = makeClient([
			entry({ path: `myrepo/.jolli/summaries/${HASH40}.json` }),
			entry({ path: `myrepo/main/foo-${HASH8}.md` }),
			entry({ path: "myrepo/.DS_Store" }), // classifier returns null
		]);

		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.added).toBe(2);
		expect(report.removed).toBe(0);
		expect(report.unowned).toEqual(["myrepo/.DS_Store"]);
		expect(stageAdd).toHaveBeenCalledTimes(1);
		expect(stageAdd.mock.calls[0]?.[0]).toEqual([
			`myrepo/.jolli/summaries/${HASH40}.json`,
			`myrepo/main/foo-${HASH8}.md`,
		]);
		expect(stageRm).not.toHaveBeenCalled();
	});

	it("does NOT print the unowned canary to the console (info-level, file-only)", async () => {
		// Regression guard: `unowned` routinely holds intentionally-unstaged
		// engine content (e.g. `.jolli-bootstrap-stash/…` survivors), so the
		// canary must not surface on the CLI as a warning during
		// `jolli sync-memory-bank`. It is logged at `info`, which the Logger
		// suppresses from the console under the default silent-console mode.
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			mkdirSync(join(vault, "myrepo", ".jolli-bootstrap-stash", "myrepo", ".jolli"), {
				recursive: true,
			});
			writeFileSync(join(vault, "myrepo", ".jolli-bootstrap-stash", "myrepo", ".jolli", "migration.json"), "{}");

			const { client } = makeClient([
				// Leading-dot segment → classifier returns null → unowned.
				entry({ path: "myrepo/.jolli-bootstrap-stash/myrepo/.jolli/migration.json" }),
			]);

			const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });

			// Still bucketed as unowned for the file log / telemetry…
			expect(report.unowned).toEqual(["myrepo/.jolli-bootstrap-stash/myrepo/.jolli/migration.json"]);
			// …but nothing reached the terminal.
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("resets already-staged paths that classifier now rejects (`git reset HEAD --`, NOT `git rm --cached`)", async () => {
		// Scenario: a path the classifier doesn't recognise is somehow
		// already in the index — could be classifier drift, a foreign
		// writer, a prior round before the deny-all `.gitignore` landed,
		// or legacy-tracked content from an older engine layout.
		// `git reset HEAD --` reverts the index entry to its HEAD blob
		// (or drops it, if HEAD has none for an `A`-only staged add) so
		// the upcoming `commit()` carries nothing for this path. NOT
		// `git rm --cached`: that would stage a deletion against any
		// HEAD blob and the round's push would propagate the deletion to
		// peers, silently erasing the file from the shared vault.
		mkdirSync(join(vault, "myrepo", ".jolli", "transcripts"), { recursive: true });
		mkdirSync(join(vault, "myrepo", ".hidden"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".hidden", "junk.txt"), "x"); // unowned (leading-dot segment)
		writeFileSync(join(vault, "myrepo", ".jolli", "transcripts", `${HASH40}.json`), "{}"); // transcripts-off

		const { client, unstage, reset } = makeClient([
			// Pre-staged unowned file (leading-dot segment is rejected by
			// `SAFE_SEGMENT_RE` so it stays out of the `user-content`
			// fallthrough). Plain `<repo>/junk.txt` is now `user-content`
			// — this test specifically guards the unowned path; pick a
			// shape the classifier still refuses.
			entry({ indexStatus: "A", worktreeStatus: " ", path: "myrepo/.hidden/junk.txt" }),
			// Pre-staged transcript while syncTranscripts=false.
			entry({
				indexStatus: "M",
				worktreeStatus: " ",
				path: `myrepo/.jolli/transcripts/${HASH40}.json`,
			}),
		]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: false });
		// `git rm --cached` MUST NOT be called from stageVault — see the
		// dedicated regression-guard test below.
		expect(unstage).not.toHaveBeenCalled();
		// Both rejected paths went through `git reset HEAD --` (a single
		// batched call for the two paths).
		expect(reset).toHaveBeenCalledTimes(1);
		expect(reset.mock.calls[0]?.[0]).toEqual([
			"myrepo/.hidden/junk.txt",
			`myrepo/.jolli/transcripts/${HASH40}.json`,
		]);
		expect(report.unowned).toEqual(["myrepo/.hidden/junk.txt"]);
		expect(report.skipped).toBe(1);
	});

	it("does NOT unstage tracked transcripts when syncTranscripts=false (Model 2: OFF is passive, not retractive)", async () => {
		// Regression guard for the Model 2 contract. A transcript that's
		// already on the remote (and therefore in the local index) MUST
		// survive a sync round with syncTranscripts=false untouched.
		// Pre-fix, stageVault routed any staged transcript into toUnstage
		// → `git rm --cached` → staged deletion → committed and pushed.
		mkdirSync(join(vault, "myrepo", ".jolli", "transcripts"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "transcripts", `${HASH40}.json`), '{"new":1}');
		const { client, stageAdd, stageRm, unstage, reset } = makeClient([
			// Tracked-on-remote transcript modified locally — indexStatus=" "
			// (index matches HEAD), worktreeStatus="M" (working tree
			// differs). Under the refined `staged` predicate this is NOT
			// considered staged (a space-status path has no index change
			// against HEAD, so the upcoming commit wouldn't pick it up
			// anyway). No `git reset HEAD --` needed.
			entry({
				indexStatus: " ",
				worktreeStatus: "M",
				path: `myrepo/.jolli/transcripts/${HASH40}.json`,
			}),
		]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: false });
		expect(stageAdd).not.toHaveBeenCalled();
		expect(stageRm).not.toHaveBeenCalled();
		expect(unstage).not.toHaveBeenCalled();
		expect(reset).not.toHaveBeenCalled();
		expect(report.skipped).toBe(1);
	});

	it("resets tracked transcripts with a STAGED change when syncTranscripts=false (P1#4)", async () => {
		// A staged A/M/D against HEAD (from a prior ON-state, external
		// `git add`, or interrupted prior round) would otherwise be
		// committed by the no-pathspec `commit()` in SyncEngine and
		// pushed to the remote — violating the OFF privacy contract.
		// `git reset HEAD --` reverts the index entry to its HEAD blob
		// (or removes it, for an `A` with no HEAD blob) without staging
		// a deletion. `git rm --cached` would push a deletion of any
		// tracked-on-remote transcript — exactly the Model 2 violation
		// the OFF toggle exists to prevent.
		mkdirSync(join(vault, "myrepo", ".jolli", "transcripts"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "transcripts", `${HASH40}.json`), '{"new":1}');
		const { client, stageAdd, stageRm, unstage, reset } = makeClient([
			entry({
				indexStatus: "M",
				worktreeStatus: " ",
				path: `myrepo/.jolli/transcripts/${HASH40}.json`,
			}),
		]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: false });
		expect(stageAdd).not.toHaveBeenCalled();
		expect(stageRm).not.toHaveBeenCalled();
		expect(unstage).not.toHaveBeenCalled();
		expect(reset).toHaveBeenCalledTimes(1);
		expect(reset.mock.calls[0]?.[0]).toEqual([`myrepo/.jolli/transcripts/${HASH40}.json`]);
		expect(report.skipped).toBe(1);
	});

	it("NEVER calls `unstagePaths` (`git rm --cached`) from stageVault — regression guard for the push-deletion data-loss path", async () => {
		// Historical bug: stageVault routed any classifier-rejected
		// (`unowned`) path with a staged index entry through
		// `client.unstagePaths`. For HEAD-tracked content the new
		// classifier didn't recognise (older engine layouts, leading-dot
		// config dirs, root-level files, legacy summaries without the
		// strict `<slug>-<hex8>.md` shape), `git rm --cached` staged a
		// deletion that the round's commit + push propagated to every
		// peer — silently erasing files from the shared vault.
		//
		// Invariant going forward: `stageVault` MUST use
		// `resetPathsToHead` (`git reset HEAD --`) for ALL classifier-
		// reject branches (unowned / transcript-off / symlink-blocked),
		// because `resetPathsToHead` preserves the HEAD blob and only
		// drops the local staged change. Any future code that
		// reintroduces `unstagePaths` in stageVault must explicitly
		// rewrite this test.
		mkdirSync(join(vault, "myrepo", ".jolli", "transcripts"), { recursive: true });
		mkdirSync(join(vault, "myrepo", ".legacy"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".legacy", "config.json"), "{}");
		writeFileSync(join(vault, "myrepo", ".jolli", "transcripts", `${HASH40}.json`), "{}");
		const { client, unstage, reset } = makeClient([
			// Unowned HEAD-tracked path with a staged modification — the
			// exact shape that triggered the regression. Leading-dot
			// segment defeats `SAFE_SEGMENT_RE`, so the fallthrough
			// classifier returns null.
			entry({ indexStatus: "M", worktreeStatus: " ", path: "myrepo/.legacy/config.json" }),
			// Transcript-off staged path.
			entry({
				indexStatus: "M",
				worktreeStatus: " ",
				path: `myrepo/.jolli/transcripts/${HASH40}.json`,
			}),
		]);
		await stageVault(client as GitClient, vault, { syncTranscripts: false });
		expect(unstage).not.toHaveBeenCalled();
		// Both rejected paths went through reset instead.
		expect(reset).toHaveBeenCalledTimes(1);
		expect(reset.mock.calls[0]?.[0]).toEqual([
			"myrepo/.legacy/config.json",
			`myrepo/.jolli/transcripts/${HASH40}.json`,
		]);
	});

	it("does NOT unstage untracked/ignored entries (`??` / `!!` — nothing in the index to remove)", async () => {
		// New file appearing as `??` or `!!` has no index entry; calling
		// `git rm --cached` on it would be a wasted batch and `--ignore-
		// unmatch` would silently succeed but we'd still pay the spawn.
		// Skip those entirely.
		mkdirSync(join(vault, "myrepo"), { recursive: true });
		writeFileSync(join(vault, "myrepo", "junk.txt"), "x");
		const { client, unstage } = makeClient([
			entry({ indexStatus: "?", worktreeStatus: "?", path: "myrepo/junk.txt" }),
			entry({ indexStatus: "!", worktreeStatus: "!", path: "myrepo/.DS_Store" }),
		]);
		await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(unstage).not.toHaveBeenCalled();
	});

	it("decomposes deletions to `git rm` (per-entry `D` status)", async () => {
		const { client, stageAdd, stageRm } = makeClient([
			entry({ indexStatus: "D", worktreeStatus: " ", path: "myrepo/.jolli/index.json" }),
		]);

		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.removed).toBe(1);
		expect(report.added).toBe(0);
		expect(stageRm).toHaveBeenCalledWith(["myrepo/.jolli/index.json"]);
		expect(stageAdd).not.toHaveBeenCalled();
	});

	it("treats copy (`C`) as add-only — source is NOT removed (source still exists in worktree)", async () => {
		// Parser sets `oldPath` for both R and C. Conflating them would
		// `git rm` a live source file on copy. Regression guard.
		mkdirSync(join(vault, "myrepo", ".jolli"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "catalog.json"), "{}");
		const { client, stageAdd, stageRm } = makeClient([
			entry({
				indexStatus: "C",
				worktreeStatus: " ",
				path: "myrepo/.jolli/catalog.json",
				oldPath: "myrepo/.jolli/index.json",
			}),
		]);

		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.added).toBe(1);
		expect(report.removed).toBe(0);
		expect(stageAdd).toHaveBeenCalledWith(["myrepo/.jolli/catalog.json"]);
		expect(stageRm).not.toHaveBeenCalled();
	});

	it("stages ignored (`!!`) entries — deny-all .gitignore template surfaces new files as ignored, not untracked", async () => {
		// The post-allowlist `.gitignore` is `* + !.gitignore`. A brand-new
		// owned file (e.g. `<repo>/.jolli/summaries/<hash>.json`) matches
		// `*` → ignored. statusPorcelainZ runs with `--ignored=matching`
		// so these surface with `!!`; the decomposer treats them as plain
		// adds and the classifier admits them via `-f` staging.
		mkdirSync(join(vault, "myrepo", ".jolli", "summaries"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "summaries", `${HASH40}.json`), "{}");
		const { client, stageAdd } = makeClient([
			entry({ indexStatus: "!", worktreeStatus: "!", path: `myrepo/.jolli/summaries/${HASH40}.json` }),
		]);

		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.added).toBe(1);
		expect(stageAdd).toHaveBeenCalledWith([`myrepo/.jolli/summaries/${HASH40}.json`]);
	});

	it("decomposes renames into del(old) + add(new), both classified independently", async () => {
		// Rename: oldPath classifies as `repo-index`, newPath as
		// `repo-catalog`. Both should land — one in add, one in rm.
		mkdirSync(join(vault, "myrepo", ".jolli"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "catalog.json"), "{}");
		const { client, stageAdd, stageRm } = makeClient([
			entry({
				indexStatus: "R",
				worktreeStatus: " ",
				path: "myrepo/.jolli/catalog.json",
				oldPath: "myrepo/.jolli/index.json",
			}),
		]);

		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.removed).toBe(1);
		expect(report.added).toBe(1);
		expect(stageRm).toHaveBeenCalledWith(["myrepo/.jolli/index.json"]);
		expect(stageAdd).toHaveBeenCalledWith(["myrepo/.jolli/catalog.json"]);
	});

	it("filters transcripts when syncTranscripts is false", async () => {
		mkdirSync(join(vault, "myrepo", ".jolli", "transcripts"), { recursive: true });
		mkdirSync(join(vault, "myrepo", ".jolli", "summaries"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "transcripts", `${HASH40}.json`), "{}");
		writeFileSync(join(vault, "myrepo", ".jolli", "summaries", `${HASH40}.json`), "{}");

		const { client, stageAdd } = makeClient([
			entry({ path: `myrepo/.jolli/transcripts/${HASH40}.json` }),
			entry({ path: `myrepo/.jolli/summaries/${HASH40}.json` }),
		]);

		const report = await stageVault(client as GitClient, vault, { syncTranscripts: false });
		expect(report.skipped).toBe(1);
		expect(report.added).toBe(1);
		expect(stageAdd).toHaveBeenCalledWith([`myrepo/.jolli/summaries/${HASH40}.json`]);
	});

	it("syncs transcripts when syncTranscripts is true", async () => {
		mkdirSync(join(vault, "myrepo", ".jolli", "transcripts"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "transcripts", `${HASH40}.json`), "{}");

		const { client, stageAdd } = makeClient([entry({ path: `myrepo/.jolli/transcripts/${HASH40}.json` })]);

		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.added).toBe(1);
		expect(report.skipped).toBe(0);
		expect(stageAdd).toHaveBeenCalledWith([`myrepo/.jolli/transcripts/${HASH40}.json`]);
	});
});

describe("stageVault — symlink defence (R10)", () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "stagevault-symlink-"));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("refuses to stage a path whose LEAF is a symlink (hostile placement at owned location)", async () => {
		// Attacker writes a symlink at <vault>/myrepo/.jolli/index.json →
		// /etc/passwd. Classifier says `repo-index` (owned), so without the
		// leaf check we'd `git add` it — leaking the target path string
		// to peers on push. The leaf check refuses + canary warns.
		mkdirSync(join(vault, "myrepo", ".jolli"), { recursive: true });
		writeFileSync(join(vault, "leaktarget"), "secret");
		symlinkSync(join(vault, "leaktarget"), join(vault, "myrepo", ".jolli", "index.json"), "file");

		const { client, stageAdd } = makeClient([entry({ path: "myrepo/.jolli/index.json" })]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.added).toBe(0);
		expect(report.symlinked).toEqual(["myrepo/.jolli/index.json"]);
		expect(stageAdd).not.toHaveBeenCalled();
	});

	it("refuses to stage when an INTERMEDIATE path segment is a symlink (parent-segment traversal)", async () => {
		// <vault>/myrepo/.jolli → /etc/. The classifier still says
		// `repo-config` for myrepo/.jolli/config.json BUT staging it
		// would let `git add` traverse the symlink. assertNoSymlinksInPath
		// catches this.
		mkdirSync(join(vault, "myrepo"), { recursive: true });
		const escapeTarget = mkdtempSync(join(tmpdir(), "escape-"));
		try {
			writeFileSync(join(escapeTarget, "config.json"), "{}");
			symlinkSync(escapeTarget, join(vault, "myrepo", ".jolli"), "dir");

			const { client, stageAdd } = makeClient([entry({ path: "myrepo/.jolli/config.json" })]);
			const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
			expect(report.symlinked).toContain("myrepo/.jolli/config.json");
			expect(stageAdd).not.toHaveBeenCalled();
		} finally {
			rmSync(escapeTarget, { recursive: true, force: true });
		}
	});

	it("deletion of an owned path with a symlinked leaf still passes through (we're removing, not following)", async () => {
		// `git rm` doesn't dereference; it just removes the index entry +
		// the file. No symlink traversal risk on the rm path, so the
		// symlink check applies only to ADDs.
		const { client, stageRm } = makeClient([
			entry({ indexStatus: "D", worktreeStatus: " ", path: "myrepo/.jolli/index.json" }),
		]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.removed).toBe(1);
		expect(stageRm).toHaveBeenCalledWith(["myrepo/.jolli/index.json"]);
	});
});

describe("stageVault — edge cases", () => {
	let vault: string;

	beforeEach(() => {
		vault = mkdtempSync(join(tmpdir(), "stagevault-edge-"));
	});

	afterEach(() => {
		rmSync(vault, { recursive: true, force: true });
	});

	it("empty status → no-op (no git calls)", async () => {
		const { client, stageAdd, stageRm } = makeClient([]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.added).toBe(0);
		expect(report.removed).toBe(0);
		expect(stageAdd).not.toHaveBeenCalled();
		expect(stageRm).not.toHaveBeenCalled();
	});

	it("drops unmerged entries (`U`) with a warn (caller should have run conflict resolver)", async () => {
		const { client, stageAdd, stageRm } = makeClient([
			entry({ indexStatus: "U", worktreeStatus: "U", path: "myrepo/.jolli/index.json" }),
		]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		// Dropped → contributes nothing to add/rm or even unowned (it
		// never reached the classifier).
		expect(report.added).toBe(0);
		expect(report.removed).toBe(0);
		expect(stageAdd).not.toHaveBeenCalled();
		expect(stageRm).not.toHaveBeenCalled();
	});

	it("drops asymmetric unmerged combos (`UD`, `AU`, `DU`, `UA`) — single-side `U` is enough", async () => {
		// Git surfaces unmerged paths with several XY combinations besides
		// `UU` — e.g. `UD` (modified-by-us, deleted-by-them) and `AU`
		// (added-by-us, unmerged-by-them). The `||` guard in decomposeOps
		// is supposed to catch every one of them; this test pins that
		// branch so a refactor to `&&` (or to checking only one side)
		// would let a conflict-marker payload leak into a real commit.
		mkdirSync(join(vault, "myrepo", ".jolli"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "index.json"), "{}");
		const { client, stageAdd, stageRm } = makeClient([
			entry({ indexStatus: "U", worktreeStatus: "D", path: "myrepo/.jolli/index.json" }),
			entry({ indexStatus: "A", worktreeStatus: "U", path: "myrepo/.jolli/index.json" }),
			entry({ indexStatus: "D", worktreeStatus: "U", path: "myrepo/.jolli/index.json" }),
			entry({ indexStatus: "U", worktreeStatus: "A", path: "myrepo/.jolli/index.json" }),
		]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.added).toBe(0);
		expect(report.removed).toBe(0);
		expect(report.unowned).toEqual([]);
		expect(stageAdd).not.toHaveBeenCalled();
		expect(stageRm).not.toHaveBeenCalled();
	});

	it("populates byKind for telemetry consumption", async () => {
		mkdirSync(join(vault, "myrepo", ".jolli"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".jolli", "index.json"), "{}");
		writeFileSync(join(vault, "myrepo", ".jolli", "manifest.json"), "{}");
		mkdirSync(join(vault, "myrepo", ".hidden"), { recursive: true });
		writeFileSync(join(vault, "myrepo", ".hidden", "junk.txt"), "x");
		const { client } = makeClient([
			entry({ path: "myrepo/.jolli/index.json" }),
			entry({ path: "myrepo/.jolli/manifest.json" }),
			// Leading-dot segment is the canonical unowned shape post-
			// relaxation: `<repo>/foo.swp` is now `user-content`, so we
			// need a path that still fails `SAFE_SEGMENT_RE` to exercise
			// the `unowned` bucket here.
			entry({ path: "myrepo/.hidden/junk.txt" }),
		]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		expect(report.byKind.get("repo-index")).toBe(1);
		expect(report.byKind.get("repo-manifest")).toBe(1);
		expect(report.byKind.get("unowned")).toBe(1);
	});

	it("missing file (status said present, lstat ENOENT) → blocked from staging (not added)", async () => {
		// Race: between `git status` snapshot and stageVault's lstat, the
		// file disappeared. Skip silently — `git add` would have failed
		// ENOENT too, and the disappearance recovers next round.
		const { client, stageAdd } = makeClient([entry({ path: "myrepo/.jolli/index.json" })]);
		const report = await stageVault(client as GitClient, vault, { syncTranscripts: true });
		// The path classifies as `repo-index` but lstat fails → symlinked
		// path takes it. (We could split a separate `disappeared` bucket
		// in future; for now grouping into symlinked-blocked is OK
		// because the response is identical: don't stage, surface in
		// canary.)
		expect(report.added).toBe(0);
		expect(stageAdd).not.toHaveBeenCalled();
		expect(report.symlinked.length).toBeGreaterThan(0);
	});
});
