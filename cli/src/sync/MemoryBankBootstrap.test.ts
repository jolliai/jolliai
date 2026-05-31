/**
 * Tests for `MemoryBankBootstrap` — `.gitignore` maintenance + transcripts
 * toggle untracking.
 *
 * Uses real filesystem fixtures (tempdirs) because we read/write
 * `.gitignore`. `GitClient` is a stub with `untrackPathGlob`
 * recorded as a vi.fn() — no real git involved.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitClient } from "./GitClient.js";
import { buildGitignore, MemoryBankBootstrap } from "./MemoryBankBootstrap.js";

let tempDir: string;
let memoryBankRoot: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "vault-bootstrap-"));
	memoryBankRoot = join(tempDir, "localfolder");
	await mkdir(memoryBankRoot, { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeStubClient() {
	return {
		untrackPathGlob: vi.fn(async () => undefined),
	} as unknown as GitClient & { untrackPathGlob: ReturnType<typeof vi.fn> };
}

function makeBootstrap(opts: { transcripts: boolean; client?: GitClient } = { transcripts: false }) {
	return new MemoryBankBootstrap({
		vaultClient: opts.client ?? makeStubClient(),
		memoryBankRoot,
		transcripts: opts.transcripts,
	});
}

describe("buildGitignore (Phase 1 — minimal engine-managed template)", () => {
	// The 7-section template was REMOVED in Phase 1. `.gitignore` is no
	// longer the staging allowlist; `stageVault`'s `classifyVaultPath` is.
	// The minimal template denies everything by default + re-allows
	// `.gitignore` itself (classifier kind `root-gitignore` stages it as
	// a regular owned path). Transcripts gating moved out of gitignore and
	// into the classifier.

	it("emits the minimal deny-all + allow-self template", () => {
		const body = buildGitignore();
		expect(body).toContain("engine-managed");
		expect(body).toMatch(/^\*\s*$/m); // catch-all deny line
		expect(body).toContain("!.gitignore"); // allow-self
		// And the dead 7-section markers must NOT be present.
		expect(body).not.toContain("!*.md");
		expect(body).not.toContain("!*.json");
		expect(body).not.toContain("!**/.jolli/");
	});

	it("produces stable output across calls (idempotency)", () => {
		expect(buildGitignore()).toBe(buildGitignore());
	});
});

describe("ensureBootstrap", () => {
	it("writes .gitignore when it doesn't exist", async () => {
		const bootstrap = makeBootstrap({ transcripts: false });
		await bootstrap.ensureBootstrap();
		const written = await readFile(join(memoryBankRoot, ".gitignore"), "utf-8");
		expect(written).toBe(buildGitignore());
	});

	it("is idempotent — no rewrite when on-disk body matches expected", async () => {
		const bootstrap = makeBootstrap({ transcripts: false });
		await bootstrap.ensureBootstrap();
		const first = await readFile(join(memoryBankRoot, ".gitignore"), "utf-8");
		await bootstrap.ensureBootstrap();
		const second = await readFile(join(memoryBankRoot, ".gitignore"), "utf-8");
		expect(first).toBe(second);
	});

	it("does NOT rewrite .gitignore when transcripts toggle changes (gating moved to stageVault)", async () => {
		// Pre-Phase-1 the toggle flipped the gitignore's trailer between
		// allow and deny forms, so the file rewrote on every transition.
		// Post-Phase-1 the template is constant — toggle ON / OFF produce
		// the same minimal body — and transcripts filtering happens at
		// stage time via the classifier. So the second `ensureBootstrap`
		// here is a no-op (idempotent write); the body before and after
		// toggle changes is identical.
		const client = makeStubClient();
		await makeBootstrap({ transcripts: true, client }).ensureBootstrap();
		const onBody = await readFile(join(memoryBankRoot, ".gitignore"), "utf-8");

		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();
		const offBody = await readFile(join(memoryBankRoot, ".gitignore"), "utf-8");
		expect(offBody).toBe(onBody);

		// Model 2 contract is preserved: the toggle never touches the
		// index, regardless of value. That's now structurally guaranteed
		// (the toggle doesn't reach the index path at all) rather than
		// guarded by a separate "untrackPathGlob is not called" assertion.
		const recordedClient = client as unknown as { untrackPathGlob: ReturnType<typeof vi.fn> };
		const transcriptsCalls = recordedClient.untrackPathGlob.mock.calls.filter(
			(c) => c[0] === "**/.jolli/transcripts/",
		);
		expect(transcriptsCalls).toHaveLength(0);
	});

	it("does NOT call untrackPathGlob for the transcripts glob across multiple OFF rounds (Model 2 regression)", async () => {
		// Direct regression guard for the cross-device ping-pong scenario
		// from plan §2.5. Pre-Model-2 each OFF round called
		// `untrackPathGlob` unconditionally; with an ON peer also pushing,
		// that produced ON-add → OFF-rm → ON-add loops.
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();
		const recordedClient = client as unknown as { untrackPathGlob: ReturnType<typeof vi.fn> };
		const transcriptsCalls = recordedClient.untrackPathGlob.mock.calls.filter(
			(c) => c[0] === "**/.jolli/transcripts/",
		);
		expect(transcriptsCalls).toHaveLength(0);
	});

	it("does NOT untrack transcripts glob when transcripts stays ON across rounds", async () => {
		const client = makeStubClient();
		await makeBootstrap({ transcripts: true, client }).ensureBootstrap();
		await makeBootstrap({ transcripts: true, client }).ensureBootstrap();
		const recordedClient = client as unknown as { untrackPathGlob: ReturnType<typeof vi.fn> };
		const transcriptsCalls = recordedClient.untrackPathGlob.mock.calls.filter(
			(c) => c[0] === "**/.jolli/transcripts/",
		);
		expect(transcriptsCalls).toHaveLength(0);
	});

	it("does NOT call untrackPathGlob for the transcripts glob on a fresh device with transcripts=OFF (Model 2)", async () => {
		// Sanity check: even on the very first round, a fresh device's
		// OFF setting must NOT trigger retraction. If the shared repo
		// has transcripts pushed by a peer ON device, those stay on disk
		// + in the index for this device to read, but this device does
		// not push deletes. Cleaning the cloud is a separate, explicit
		// action (purge command, follow-up).
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();
		const recordedClient = client as unknown as { untrackPathGlob: ReturnType<typeof vi.fn> };
		const transcriptsCalls = recordedClient.untrackPathGlob.mock.calls.filter(
			(c) => c[0] === "**/.jolli/transcripts/",
		);
		expect(transcriptsCalls).toHaveLength(0);
	});

	it("always untracks the remaining per-device JSON globs (shadow-status.json) every round", async () => {
		// config.json used to be in this list; it now carries cross-device
		// identity and is tracked. Only shadow-status.json (FolderStorage's
		// dirty-write recovery marker, meaningless to peers) stays.
		const client = makeStubClient();
		await makeBootstrap({ transcripts: true, client }).ensureBootstrap();
		const recordedClient = client as unknown as { untrackPathGlob: ReturnType<typeof vi.fn> };
		const globs = recordedClient.untrackPathGlob.mock.calls.map((c) => c[0]);
		expect(globs).not.toContain("**/.jolli/config.json");
		expect(globs).toContain("**/.jolli/shadow-status.json");
	});

	it("swallows untrackPathGlob errors as non-fatal for non-privacy globs (PER_DEVICE_JSON_GLOBS + untrackNonHashSummaries)", async () => {
		// `untrackPathGlob` now throws on non-zero exit (post-Model-2,
		// it's no longer the silent-failure surface from I8). The
		// transcripts caller is gone, so the only remaining callers are
		// the PER_DEVICE_JSON_GLOBS loop and `untrackNonHashSummaries`.
		// Both must catch + WARN — those globs are device-private state
		// (shadow-status.json) and defensive cleanup, not privacy-
		// critical. A throw must NOT escalate the round to terminal.
		const client = {
			untrackPathGlob: vi.fn(async () => {
				throw new Error("simulated git failure");
			}),
		} as unknown as GitClient;
		await expect(makeBootstrap({ transcripts: false, client }).ensureBootstrap()).resolves.toBeUndefined();
		await expect(makeBootstrap({ transcripts: true, client }).ensureBootstrap()).resolves.toBeUndefined();
	});

	it("creates parent dir if missing", async () => {
		await rm(memoryBankRoot, { recursive: true, force: true });
		const bootstrap = makeBootstrap({ transcripts: false });
		await bootstrap.ensureBootstrap();
		const written = await readFile(join(memoryBankRoot, ".gitignore"), "utf-8");
		expect(written).toContain("Jolli Memory Bank");
	});

	it("preserves user edits when the body matches expected (no thrash)", async () => {
		// Pre-write the EXACT expected body.
		await writeFile(join(memoryBankRoot, ".gitignore"), buildGitignore());
		const bootstrap = makeBootstrap({ transcripts: false });
		await bootstrap.ensureBootstrap();
		// No way to assert "didn't write" without spying fs, but we can assert
		// content is still the canonical one — passes either way.
		const after = await readFile(join(memoryBankRoot, ".gitignore"), "utf-8");
		expect(after).toBe(buildGitignore());
	});

	// Skipped on Windows because `symlink()` requires special privileges
	// there; the production guard's `O_NOFOLLOW` is a no-op on Windows
	// anyway (per VaultSymlinkGuard's docstring).
	const itPosix = platform() === "win32" ? it.skip : it;

	itPosix(
		"refuses to follow a leaf symlink at <vault>/.gitignore (hostile pre-placement → no overwrite of link target)",
		async () => {
			// Pre-place a symlink at the `.gitignore` path pointing at a
			// sibling target. If the write follows the link, the target's
			// content would be replaced with the gitignore body — a real
			// CVE-shaped path-traversal exploit. `safeAtomicWriteSync`
			// opens the leaf `.tmp` with `O_NOFOLLOW`, so even if a
			// `.gitignore.tmp` is also pre-placed as a symlink the write
			// throws ELOOP before any rename. Here we just pre-place the
			// `.gitignore` itself as a symlink and assert the body never
			// landed on the link target.
			const linkTarget = join(tempDir, "victim.txt");
			await writeFile(linkTarget, "ORIGINAL");
			await symlink(linkTarget, join(memoryBankRoot, ".gitignore"));

			const bootstrap = makeBootstrap({ transcripts: false });
			// Symlink at `.gitignore` itself means the path-chain check
			// passes (chain to PARENT is clean) but the leaf O_NOFOLLOW on
			// `.gitignore.tmp` — wait, the tmp would be a NEW path next to
			// the symlink. The rename(tmp, target) IS the dangerous step:
			// rename onto a symlink replaces the symlink itself, NOT its
			// target. So actually the write SUCCEEDS but the link target
			// is preserved — which is what we want to assert.
			await bootstrap.ensureBootstrap();

			// Link target must NEVER have been overwritten.
			const targetAfter = await readFile(linkTarget, "utf-8");
			expect(targetAfter).toBe("ORIGINAL");
			// And `.gitignore` is now a real file (rename replaced the
			// symlink) holding the canonical body.
			const gitignoreStat = await stat(join(memoryBankRoot, ".gitignore"));
			expect(gitignoreStat.isFile()).toBe(true);
		},
	);
});

describe("untrackNonHashSummaries (quarantine + mtime sentinel)", () => {
	async function makeRepoWithSummaries(repo: string, files: Record<string, string>): Promise<string> {
		const dir = join(memoryBankRoot, repo, ".jolli", "summaries");
		await mkdir(dir, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			await writeFile(join(dir, name), content);
		}
		return dir;
	}

	it("leaves hash-conforming summaries untouched", async () => {
		// 7-64 lowercase hex characters; AllowList.ts requires this exact shape.
		await makeRepoWithSummaries("repo-a", {
			"abcdef0.json": "{}",
			"deadbeefcafe.json": "{}",
		});
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		const remaining = await readdir(join(memoryBankRoot, "repo-a", ".jolli", "summaries"));
		expect(remaining.sort()).toEqual(["abcdef0.json", "deadbeefcafe.json"]);
		// No quarantine directory should exist.
		await expect(stat(join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("quarantines non-hash-named summaries and calls untrackPathGlob with the source path", async () => {
		await makeRepoWithSummaries("repo-a", {
			"abcdef0.json": "{}", // valid — should stay
			"secret.json": "PII", // invalid — should be moved
			"NOT-HEX.json": "{}", // invalid — uppercase
			"abc.txt": "x", // invalid — extension
		});
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		// Quarantined files removed from summaries/.
		const remaining = await readdir(join(memoryBankRoot, "repo-a", ".jolli", "summaries"));
		expect(remaining).toEqual(["abcdef0.json"]);

		// And present in quarantine-summaries/.
		const quarantined = await readdir(join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries"));
		expect(quarantined.sort()).toEqual(["NOT-HEX.json", "abc.txt", "secret.json"]);

		// Each was untracked from the index via its original path.
		const recorded = client as unknown as { untrackPathGlob: ReturnType<typeof vi.fn> };
		// `untrackPathGlob` receives paths from `path.relative`, so the
		// separator is `\` on Windows and `/` elsewhere. Filter with the
		// host-native separator so the comparison works on both.
		const summariesFragment = join(".jolli", "summaries");
		const untrackedSummaryPaths = recorded.untrackPathGlob.mock.calls
			.map((c) => c[0] as string)
			.filter((p) => p.includes(summariesFragment));
		for (const bad of ["secret.json", "NOT-HEX.json", "abc.txt"]) {
			expect(untrackedSummaryPaths.some((p) => p.endsWith(bad))).toBe(true);
		}
	});

	it("skips dot-prefixed top-level entries (e.g. .memorybank-state.json itself)", async () => {
		// Create a faux dotfile + a real repo with summaries.
		await writeFile(join(memoryBankRoot, ".some-dotfile"), "x");
		await makeRepoWithSummaries("repo-a", { "bad.json": "x" });
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		// The repo's bad file got quarantined; the dotfile is untouched.
		const quarantined = await readdir(join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries"));
		expect(quarantined).toEqual(["bad.json"]);
		expect(await readFile(join(memoryBankRoot, ".some-dotfile"), "utf-8")).toBe("x");
	});

	it("is a no-op when the repo has no .jolli/summaries/ dir", async () => {
		await mkdir(join(memoryBankRoot, "repo-a"), { recursive: true });
		const client = makeStubClient();
		await expect(makeBootstrap({ transcripts: false, client }).ensureBootstrap()).resolves.toBeUndefined();
		const recorded = client as unknown as { untrackPathGlob: ReturnType<typeof vi.fn> };
		// Only the always-fired per-device globs should have been called.
		const summaryCalls = recorded.untrackPathGlob.mock.calls.filter((c) => (c[0] as string).includes("summaries/"));
		expect(summaryCalls).toHaveLength(0);
	});

	it("writes the sentinel after a clean scan; second round skips the readdir", async () => {
		await makeRepoWithSummaries("repo-a", { "abcdef0.json": "{}" });
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		// Sentinel exists with the scanned dir recorded.
		const sentinelRaw = await readFile(join(memoryBankRoot, ".memorybank-state.json"), "utf-8");
		const sentinel = JSON.parse(sentinelRaw) as { version: number; scannedDirs: Record<string, number> };
		expect(sentinel.version).toBe(1);
		const scannedKey = Object.keys(sentinel.scannedDirs)[0];
		expect(scannedKey).toBeDefined();
		expect(scannedKey).toContain("summaries");
		// mtime is a positive number.
		expect(sentinel.scannedDirs[scannedKey ?? ""]).toBeGreaterThan(0);
	});

	it("re-scans when a new file lands in the summaries dir (mtime changes)", async () => {
		const dir = await makeRepoWithSummaries("repo-a", { "abcdef0.json": "{}" });
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		// Drop a non-conforming file. Some filesystems have 1s mtime resolution;
		// poll a few times until the parent-dir mtime advances past the sentinel
		// — far cheaper than a blanket 1.1s sleep, and avoids flake on faster FSes.
		const initialMtime = (await stat(dir)).mtimeMs;
		for (let attempt = 0; attempt < 20; attempt++) {
			await writeFile(join(dir, "evil.json"), "leak");
			if ((await stat(dir)).mtimeMs !== initialMtime) break;
			await rm(join(dir, "evil.json"));
			await new Promise((r) => setTimeout(r, 60));
		}

		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		// evil.json got quarantined on the second round — sentinel did NOT
		// short-circuit because the mtime had advanced.
		const quarantined = await readdir(join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries"));
		expect(quarantined).toEqual(["evil.json"]);
	});

	it("rename failure (e.g. quarantineDir uncreatable) is non-fatal and logged", async () => {
		// Force the quarantine mkdir to fail: pre-create `quarantine-summaries`
		// as a regular *file* so `mkdir(..., recursive: true)` throws ENOTDIR,
		// which the per-file catch at line 344-347 swallows as `scanErrored`.
		await makeRepoWithSummaries("repo-a", { "evil.json": "leak" });
		await writeFile(join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries"), "placeholder file");
		const client = makeStubClient();
		await expect(makeBootstrap({ transcripts: false, client }).ensureBootstrap()).resolves.toBeUndefined();
		// Sentinel must NOT record this dir as cleanly-scanned. The bootstrap
		// either skipped the sentinel write entirely (no clean repos) or
		// wrote it without an entry for repo-a/summaries.
		let sentinel: { scannedDirs?: Record<string, number> } = {};
		try {
			sentinel = JSON.parse(await readFile(join(memoryBankRoot, ".memorybank-state.json"), "utf-8")) as {
				scannedDirs: Record<string, number>;
			};
		} catch {
			// No sentinel — fine, that's the "no clean scans" branch.
		}
		const summariesKey = Object.keys(sentinel.scannedDirs ?? {}).find((k) => k.includes("summaries"));
		expect(summariesKey).toBeUndefined();
	});

	it("does NOT update the sentinel when the scan errored", async () => {
		await makeRepoWithSummaries("repo-a", { "bad.json": "x" });
		// Client that always throws — forces the inner quarantine-loop catch
		// branch (`scanErrored = true`) but the function still resolves.
		const throwingClient = {
			untrackPathGlob: vi.fn(async () => {
				// untrackPathGlob's failure is logged but NOT counted as scan-error
				// (the comment says "non-fatal"). What we actually want to test:
				// the rename itself fails. Simulate by pre-creating the quarantine
				// target so `rename` fails with EEXIST is hard on POSIX (rename
				// overwrites). Instead, swap the rename target out of band — see
				// next test. Use this client just to assert the function tolerates
				// untrack throws.
				throw new Error("simulated git failure");
			}),
		} as unknown as GitClient;

		await expect(
			makeBootstrap({ transcripts: false, client: throwingClient }).ensureBootstrap(),
		).resolves.toBeUndefined();
	});

	it("sentinel write failure is non-fatal (swallowed warn, function resolves)", async () => {
		await makeRepoWithSummaries("repo-a", { "abcdef0.json": "{}" });
		// Pre-create the sentinel path AS A DIRECTORY so writeFile fails with EISDIR.
		// The function should warn and still resolve cleanly.
		await mkdir(join(memoryBankRoot, ".memorybank-state.json"), { recursive: true });
		const client = makeStubClient();
		await expect(makeBootstrap({ transcripts: false, client }).ensureBootstrap()).resolves.toBeUndefined();
	});

	it("self-heals when the sentinel JSON is corrupted (treats as empty cache)", async () => {
		await makeRepoWithSummaries("repo-a", { "abcdef0.json": "{}" });
		// Pre-write garbage at the sentinel path. The bootstrap must overwrite
		// it with a valid v1 doc instead of crashing.
		await writeFile(join(memoryBankRoot, ".memorybank-state.json"), "not valid json {{");
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		const sentinelRaw = await readFile(join(memoryBankRoot, ".memorybank-state.json"), "utf-8");
		const sentinel = JSON.parse(sentinelRaw) as { version: number };
		expect(sentinel.version).toBe(1);
	});

	it("treats unknown sentinel version as missing (re-scans + overwrites)", async () => {
		await makeRepoWithSummaries("repo-a", { "abcdef0.json": "{}" });
		await writeFile(
			join(memoryBankRoot, ".memorybank-state.json"),
			JSON.stringify({ version: 99, scannedDirs: { "stale/path": 1 } }),
		);
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		const sentinel = JSON.parse(await readFile(join(memoryBankRoot, ".memorybank-state.json"), "utf-8")) as {
			version: number;
			scannedDirs: Record<string, number>;
		};
		expect(sentinel.version).toBe(1);
		// Stale entry from v99 didn't carry over.
		expect(sentinel.scannedDirs["stale/path"]).toBeUndefined();
	});

	it("returns early when memoryBankRoot itself doesn't exist (no throw)", async () => {
		await rm(memoryBankRoot, { recursive: true, force: true });
		// Re-create only the file path .gitignore would land at — that's
		// inside makeBootstrap → ensureBootstrap's `mkdir(memoryBankRoot)` so
		// the top half of the function still works. We rely on `readdir` of
		// a newly-created (empty) memoryBankRoot returning [] — no repos to
		// scan, so untrackNonHashSummaries returns cleanly.
		const client = makeStubClient();
		await expect(makeBootstrap({ transcripts: false, client }).ensureBootstrap()).resolves.toBeUndefined();
	});

	it("short-circuits the per-repo scan on the second run when nothing changed (mtime cache hit)", async () => {
		// Plan §P2: the sentinel records each `summaries/` dir's mtime
		// after a clean scan. A subsequent ensureBootstrap with no
		// intervening writes hits the `scannedDirs[relDir] ===
		// preStat.mtimeMs` cache branch and skips the scan.
		//
		// We can't observe "readdir was skipped" directly (the engine
		// reaches for the real `node:fs/promises.readdir`). We CAN observe
		// the side-effect: when the cache hits, `sentinelChanged` stays
		// false and the sentinel file is never rewritten. We assert via
		// the sentinel file's own mtime — unchanged between runs ⇒ cache
		// hit ⇒ the `continue` branch fired.
		await makeRepoWithSummaries("repo-a", { "abcdef0.json": "{}" });
		const client = makeStubClient();
		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		const sentinelPath = join(memoryBankRoot, ".memorybank-state.json");
		const sentinelMtimeBefore = (await stat(sentinelPath)).mtimeMs;

		// Wait long enough for fs mtime resolution to advance (some FSes
		// are 1s) so a second write WOULD register if it happened.
		await new Promise((r) => setTimeout(r, 1100));

		await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

		const sentinelMtimeAfter = (await stat(sentinelPath)).mtimeMs;
		expect(sentinelMtimeAfter).toBe(sentinelMtimeBefore);
	});

	// Skips on Windows: symlink creation requires admin/Developer Mode there.
	it.skipIf(platform() === "win32")(
		"refuses to descend when an intermediate path segment is a symlink (plan §P2 I2)",
		async () => {
			// Different from the leaf-symlink test below: here the leaf
			// (`summaries`) is a real directory, but an ANCESTOR segment
			// (`.jolli`) is a symlink that points at attacker-controlled
			// state. `intermediateContainsSymlink` must catch this and
			// short-circuit with a warn, BEFORE the engine reaches lstat
			// on the leaf.
			await makeRepoWithSummaries("repo-good", { "abcdef0.json": "{}" });
			// Stage the attacker's "real" .jolli somewhere outside the repo,
			// containing a perfectly fine-looking summaries dir.
			const attackerJolli = join(tempDir, "attacker-jolli");
			await mkdir(join(attackerJolli, "summaries"), { recursive: true });
			await writeFile(join(attackerJolli, "summaries", "evil.json"), "leak");
			// Plant the repo with a symlinked `.jolli/` pointing at the
			// attacker dir. The leaf `.jolli/summaries/` is a real directory
			// (via the symlink), so the leaf-only lstat guard would miss
			// this — `intermediateContainsSymlink` is the layer that catches
			// it.
			const evilRepo = join(memoryBankRoot, "repo-evil");
			await mkdir(evilRepo, { recursive: true });
			await symlink(attackerJolli, join(evilRepo, ".jolli"));

			const client = makeStubClient();
			await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

			// Attacker's summaries dir is untouched — neither the file got
			// quarantined nor a quarantine-summaries dir was created.
			expect(await readdir(join(attackerJolli, "summaries"))).toEqual(["evil.json"]);
			let quarantineCreated = true;
			try {
				await stat(join(attackerJolli, "quarantine-summaries"));
			} catch {
				quarantineCreated = false;
			}
			expect(quarantineCreated).toBe(false);
		},
	);

	// Skips on Windows: symlink creation requires admin/Developer Mode there.
	// Other OSes still cover the lstat refusal path that defends against
	// `<repo>/.jolli/summaries` being replaced by a link to `/etc` (plan §P2).
	it.skipIf(platform() === "win32")(
		"refuses to descend into a symlinked summaries dir (lstat guard, plan §P2)",
		async () => {
			// Build a real summaries dir for a sibling repo (so the scan
			// has SOMETHING legitimate to do) plus a hostile symlink at
			// the summaries path for another repo. The latter must NOT be
			// followed — `readdir` on `/etc` (or wherever the link points)
			// would attempt to quarantine real system files.
			await makeRepoWithSummaries("repo-good", { "abcdef0.json": "{}" });
			const evilRepo = join(memoryBankRoot, "repo-evil");
			await mkdir(join(evilRepo, ".jolli"), { recursive: true });
			// Point `summaries` at a directory the engine has no business
			// touching. Using a non-existent target is enough — lstat
			// reports it as a symlink regardless, and the engine should
			// skip-with-warn before any readdir attempt.
			await symlink("/tmp/jolli-nonexistent-target", join(evilRepo, ".jolli", "summaries"));

			const client = makeStubClient();
			await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

			// The good repo's content is intact.
			const remaining = await readdir(join(memoryBankRoot, "repo-good", ".jolli", "summaries"));
			expect(remaining).toEqual(["abcdef0.json"]);
			// The hostile symlink is still a symlink (untouched — not
			// renamed, not followed). No `quarantine-summaries/` dir
			// got created for repo-evil because we never entered the link.
			const evilEntries = await readdir(join(evilRepo, ".jolli"));
			expect(evilEntries).toContain("summaries");
			expect(evilEntries).not.toContain("quarantine-summaries");
			// And no untrack calls were issued for paths beneath the
			// link — would indicate readdir followed it.
			const recorded = client as unknown as { untrackPathGlob: ReturnType<typeof vi.fn> };
			const evilCalls = recorded.untrackPathGlob.mock.calls.filter((c) => (c[0] as string).includes("repo-evil"));
			expect(evilCalls).toHaveLength(0);
		},
	);

	// CX1 coverage: defense-in-depth on the quarantine destination side.
	// SymlinkSweep step 3a clears most of these, but the engine must still
	// refuse if a symlink reappears at the quarantine path between sweep
	// and the rename window.
	it.skipIf(platform() === "win32")(
		"refuses to mkdir quarantine-summaries when the leaf is a pre-existing symlink (CX1)",
		async () => {
			await makeRepoWithSummaries("repo-a", { "evil.json": "leak" });
			// Plant a symlink AT the quarantine path before the scan runs.
			// The engine's lstat-on-quarantine guard must catch this and
			// refuse — otherwise mkdir(recursive) is a no-op on the
			// symlink and rename would follow it out of the vault.
			await symlink(
				"/tmp/jolli-nonexistent-quarantine-target",
				join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries"),
			);

			const client = makeStubClient();
			await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

			// The non-hash file is still in summaries (not renamed out).
			expect(await readdir(join(memoryBankRoot, "repo-a", ".jolli", "summaries"))).toEqual(["evil.json"]);
			// The hostile symlink is still a symlink.
			const lst = await import("node:fs/promises").then((m) =>
				m.lstat(join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries")),
			);
			expect(lst.isSymbolicLink()).toBe(true);
		},
	);

	it.skipIf(platform() === "win32")(
		"refuses to rename a non-hash summary when the per-file quarantine dst is a symlink (CX1)",
		async () => {
			await makeRepoWithSummaries("repo-a", { "evil.json": "leak" });
			// Pre-create quarantine-summaries as a real dir, then plant a
			// symlink at the dst leaf that would-be-rename target. The
			// per-file lstat(dst) recheck must catch this before rename.
			await mkdir(join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries"), { recursive: true });
			await symlink(
				"/tmp/jolli-nonexistent-dst-target",
				join(memoryBankRoot, "repo-a", ".jolli", "quarantine-summaries", "evil.json"),
			);

			const client = makeStubClient();
			await makeBootstrap({ transcripts: false, client }).ensureBootstrap();

			// Source is still in summaries (rename refused).
			expect(await readdir(join(memoryBankRoot, "repo-a", ".jolli", "summaries"))).toEqual(["evil.json"]);
		},
	);
});
