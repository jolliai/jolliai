/**
 * Tests for `quarantineCorruptJson` — plan §I9. Real filesystem fixtures
 * keep the behaviour honest (the production callers depend on fs side
 * effects of `rename` / `mkdir`, which a pure mock would lie about).
 */

import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUARANTINE_CORRUPT_DIR, quarantineCorruptJson } from "./CorruptJsonQuarantine.js";

const skipOnWindows = platform() === "win32";

describe.skipIf(skipOnWindows)("quarantineCorruptJson", () => {
	let vault: string;

	beforeEach(async () => {
		vault = await mkdtemp(join(tmpdir(), "corrupt-json-"));
	});

	afterEach(async () => {
		await rm(vault, { recursive: true, force: true });
	});

	it("returns zero-counts when no paths are validatable JSON", async () => {
		// Paths outside `.jolli/`, non-JSON, and empty input all bypass.
		const report = await quarantineCorruptJson(vault, []);
		expect(report.quarantined).toBe(0);

		await mkdir(join(vault, "notes"), { recursive: true });
		await writeFile(join(vault, "notes", "user.md"), "{ not validated }");
		await writeFile(join(vault, "loose.json"), "garbage but outside .jolli/");
		const report2 = await quarantineCorruptJson(vault, ["notes/user.md", "loose.json"]);
		expect(report2.quarantined).toBe(0);
	});

	it("leaves a parseable .jolli JSON file in place", async () => {
		await mkdir(join(vault, ".jolli", "summaries"), { recursive: true });
		await writeFile(join(vault, ".jolli", "summaries", "abc.json"), JSON.stringify({ ok: true }));
		const report = await quarantineCorruptJson(vault, [".jolli/summaries/abc.json"]);
		expect(report.quarantined).toBe(0);
		// Original file still present, no quarantine dir created.
		await expect(lstat(join(vault, ".jolli", "summaries", "abc.json"))).resolves.toBeDefined();
		await expect(lstat(join(vault, QUARANTINE_CORRUPT_DIR))).rejects.toBeDefined();
	});

	it("quarantines an unparseable .jolli JSON file with a path-encoded safe name", async () => {
		// Mid-write hazard: editor flushed half the bytes. Round must
		// move it aside so stageAll doesn't push it to the orphan branch.
		await mkdir(join(vault, ".jolli", "summaries"), { recursive: true });
		const rel = ".jolli/summaries/half-written.json";
		await writeFile(join(vault, rel), '{"truncated":');
		const report = await quarantineCorruptJson(vault, [rel]);
		expect(report.quarantined).toBe(1);
		expect(report.paths).toEqual([rel]);
		// Source file is gone (renamed), quarantine entry is present
		// under the slash-encoded safe name.
		await expect(lstat(join(vault, rel))).rejects.toBeDefined();
		const safeName = rel.replace(/[\\/]/g, "-");
		const dst = await lstat(join(vault, QUARANTINE_CORRUPT_DIR, safeName));
		expect(dst.isFile()).toBe(true);
	});

	it("quarantines an empty .jolli/index.json — zero bytes IS a corruption mode (truncated write)", async () => {
		await mkdir(join(vault, ".jolli"), { recursive: true });
		await writeFile(join(vault, ".jolli", "index.json"), "");
		const report = await quarantineCorruptJson(vault, [".jolli/index.json"]);
		expect(report.quarantined).toBe(1);
	});

	it("skips files listed as dirty but missing from disk (uncommitted deletion)", async () => {
		// Porcelain `-z` returns ` D path` entries for files deleted
		// from the worktree but still tracked. We're called with their
		// relative paths and must not throw.
		const report = await quarantineCorruptJson(vault, [".jolli/summaries/gone.json"]);
		expect(report.quarantined).toBe(0);
	});

	it("ignores .jolli paths that aren't .json (subdir folders, .md, .txt)", async () => {
		await mkdir(join(vault, ".jolli", "summaries"), { recursive: true });
		await writeFile(join(vault, ".jolli", "summaries", "note.md"), "not json");
		const report = await quarantineCorruptJson(vault, [".jolli/summaries", ".jolli/summaries/note.md"]);
		expect(report.quarantined).toBe(0);
	});

	it("ignores non-`.jolli` JSON files even if their path matches `*.json`", async () => {
		// User-authored JSON outside `.jolli/` (e.g. a `package.json` they
		// dropped into the vault) is none of our business — only the
		// engine-owned aggregate tree gets validated.
		await writeFile(join(vault, "package.json"), "not real json");
		const report = await quarantineCorruptJson(vault, ["package.json"]);
		expect(report.quarantined).toBe(0);
		await expect(lstat(join(vault, "package.json"))).resolves.toBeDefined();
	});

	it("processes multiple files in one call and reports all quarantined paths", async () => {
		await mkdir(join(vault, ".jolli", "summaries"), { recursive: true });
		await mkdir(join(vault, ".jolli", "transcripts"), { recursive: true });
		await writeFile(join(vault, ".jolli", "summaries", "a.json"), "{}");
		await writeFile(join(vault, ".jolli", "summaries", "b.json"), "{broken");
		await writeFile(join(vault, ".jolli", "transcripts", "c.json"), "still broken");
		const report = await quarantineCorruptJson(vault, [
			".jolli/summaries/a.json",
			".jolli/summaries/b.json",
			".jolli/transcripts/c.json",
		]);
		expect(report.quarantined).toBe(2);
		expect([...report.paths].sort()).toEqual([".jolli/summaries/b.json", ".jolli/transcripts/c.json"]);
		// Clean file still in place.
		await expect(lstat(join(vault, ".jolli", "summaries", "a.json"))).resolves.toBeDefined();
	});

	it("overwrites a previously-quarantined entry with the same safe name so recurring corrupt writes don't accumulate", async () => {
		// Idempotency: a flaky writer that produces a corrupt file every
		// round should leave ONE entry in quarantine, not N.
		await mkdir(join(vault, ".jolli", "summaries"), { recursive: true });
		await writeFile(join(vault, ".jolli", "summaries", "flaky.json"), "{broken-1");

		const r1 = await quarantineCorruptJson(vault, [".jolli/summaries/flaky.json"]);
		expect(r1.quarantined).toBe(1);

		// Second corrupt write to the same logical path.
		await writeFile(join(vault, ".jolli", "summaries", "flaky.json"), "{broken-2");
		const r2 = await quarantineCorruptJson(vault, [".jolli/summaries/flaky.json"]);
		expect(r2.quarantined).toBe(1);
		// Latest content survives in quarantine.
		const stat = await lstat(join(vault, QUARANTINE_CORRUPT_DIR, ".jolli-summaries-flaky.json"));
		expect(stat.isFile()).toBe(true);
	});

	it("treats an existing symlink at the quarantine path as hostile and replaces it with a real dir", async () => {
		// Mirrors `SymlinkSweep.ensureQuarantineDir` — a pre-existing
		// hostile symlink at `<vault>/.jolli-quarantine-corrupt/` must
		// not be followed (rename would land the corrupt file in a
		// host-system directory).
		const outside = await mkdtemp(join(tmpdir(), "outside-"));
		try {
			await symlink(outside, join(vault, QUARANTINE_CORRUPT_DIR));
			await mkdir(join(vault, ".jolli", "summaries"), { recursive: true });
			await writeFile(join(vault, ".jolli", "summaries", "x.json"), "{broken");
			const report = await quarantineCorruptJson(vault, [".jolli/summaries/x.json"]);
			expect(report.quarantined).toBe(1);
			// Quarantine dir is now a real directory, not a symlink.
			const stat = await lstat(join(vault, QUARANTINE_CORRUPT_DIR));
			expect(stat.isSymbolicLink()).toBe(false);
			expect(stat.isDirectory()).toBe(true);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("refuses to quarantine when the quarantine path is occupied by a non-symlink non-directory", async () => {
		// Don't clobber unknown user data sitting at the quarantine path.
		// Return 0 and leave corrupt files in place — the caller
		// (auto-reconcile) will WARN about the unusable quarantine but
		// still proceed to stageAll, accepting the risk this round; next
		// round can recover once the user clears the blocker.
		await writeFile(join(vault, QUARANTINE_CORRUPT_DIR), "blocker");
		await mkdir(join(vault, ".jolli", "summaries"), { recursive: true });
		await writeFile(join(vault, ".jolli", "summaries", "y.json"), "{broken");
		const report = await quarantineCorruptJson(vault, [".jolli/summaries/y.json"]);
		expect(report.quarantined).toBe(0);
		// Corrupt file was NOT moved.
		await expect(lstat(join(vault, ".jolli", "summaries", "y.json"))).resolves.toBeDefined();
	});
});
