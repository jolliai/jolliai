import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBackfillDismissFlag, writeBackfillDismissFlag } from "./BackfillDismissFlag.js";

// These wrappers now forward to the shared RepoProfile (profile.json). The
// exhaustive path-resolution / migration / worktree-sharing coverage lives in
// cli/src/core/RepoProfile.test.ts; here we only assert the boolean forwarding
// and the new storage location.
//
// Direct sibling of ManualDisableFlag.test.ts: both wrap the same RepoProfile
// helpers and spawn a real `git init` in beforeEach plus real git reads/writes
// via `git rev-parse --git-common-dir`. Under v8 coverage instrumentation plus
// a large parallel suite, that subprocess can occasionally take longer than
// Vitest's 5s default, which is a load signal, not a correctness one. Give the
// whole suite a generous timeout so it stays robust under load without hiding
// an actual hang (45s is far beyond any real subprocess latency).
describe("BackfillDismissFlag", { timeout: 45_000 }, () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "jolli-bf-dismiss-"));
		execFileSync("git", ["init", "-q"], { cwd });
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reads false when nothing is set", async () => {
		expect(await readBackfillDismissFlag(cwd)).toBe(false);
	});

	it("writes to <main-root>/.jolli/jollimemory/profile.json and reads back true", async () => {
		await writeBackfillDismissFlag(cwd, true);
		expect(await readBackfillDismissFlag(cwd)).toBe(true);
		// New repo-wide location: the shared RepoProfile, not the old .git marker.
		expect(existsSync(join(cwd, ".jolli", "jollimemory", "profile.json"))).toBe(true);
		expect(existsSync(join(cwd, ".git", "jollimemory", "backfill-card-dismissed"))).toBe(false);
	});

	it("clears back to false", async () => {
		await writeBackfillDismissFlag(cwd, true);
		await writeBackfillDismissFlag(cwd, false);
		expect(await readBackfillDismissFlag(cwd)).toBe(false);
	});
});
