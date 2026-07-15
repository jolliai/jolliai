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
describe("BackfillDismissFlag", () => {
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
