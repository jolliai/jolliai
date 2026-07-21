import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readManualDisableFlag, writeManualDisableFlag } from "./ManualDisableFlag.js";

// The flag is CLI-owned (RepoProfile / profile.json) and repo-wide; this module
// is a thin re-export. `git init` makes each temp dir a real repo so we exercise
// RepoProfile's git-common-dir anchoring (the actual VS Code path) and don't
// accidentally resolve to an enclosing repo if TMPDIR happens to sit inside one.
describe("ManualDisableFlag (repo-wide, profile.json backed)", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "jolli-disable-flag-"));
		execFileSync("git", ["init", "-q"], { cwd });
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("read returns false when nothing is set", async () => {
		expect(await readManualDisableFlag(cwd)).toBe(false);
	});

	it("write(true) persists to profile.json and read returns true", async () => {
		await writeManualDisableFlag(cwd, true);
		expect(await readManualDisableFlag(cwd)).toBe(true);
		const body = await readFile(join(cwd, ".jolli", "jollimemory", "profile.json"), "utf-8");
		expect(JSON.parse(body)).toMatchObject({ manuallyDisabled: true });
	});

	it("write(false) clears the opt-out", async () => {
		await writeManualDisableFlag(cwd, true);
		expect(await readManualDisableFlag(cwd)).toBe(true);
		await writeManualDisableFlag(cwd, false);
		expect(await readManualDisableFlag(cwd)).toBe(false);
	});

	it("migrates a legacy per-worktree disabled-by-user marker on read", async () => {
		await mkdir(join(cwd, ".jolli", "jollimemory"), { recursive: true });
		await writeFile(join(cwd, ".jolli", "jollimemory", "disabled-by-user"), new Date(0).toISOString());
		expect(await readManualDisableFlag(cwd)).toBe(true);
	});
});
