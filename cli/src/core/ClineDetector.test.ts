import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClineStorageDirs, isClineInstalled } from "./ClineDetector.js";

describe("ClineDetector", () => {
	let home: string;
	let prevAppData: string | undefined;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "cline-ext-det-"));
		// On win32, getVscodeUserDataDir resolves via %APPDATA% and ignores the
		// `home` argument, so a real machine's APPDATA would leak in (reading — and
		// in the "true" case writing — the real user profile). Point it inside the
		// temp dir so all three cases stay isolated. No-op on darwin/linux, which
		// honour `home` directly.
		prevAppData = process.env.APPDATA;
		process.env.APPDATA = join(home, "AppData", "Roaming");
	});
	afterEach(async () => {
		if (prevAppData === undefined) delete process.env.APPDATA;
		else process.env.APPDATA = prevAppData;
		await rm(home, { recursive: true, force: true });
	});

	it("returns one storage dir per flavor", () => {
		const dirs = getClineStorageDirs(home);
		expect(dirs.length).toBeGreaterThanOrEqual(5);
		expect(dirs.some((d) => d.includes("saoudrizwan.claude-dev"))).toBe(true);
	});

	it("false when no flavor has taskHistory.json", async () => {
		expect(await isClineInstalled(home)).toBe(false);
	});

	it("true when any flavor has taskHistory.json", async () => {
		// darwin layout: <home>/Library/Application Support/Code/User/globalStorage/<ext>/state/
		const stateDir = join(getClineStorageDirs(home)[0], "state");
		await mkdir(stateDir, { recursive: true });
		await writeFile(join(stateDir, "taskHistory.json"), "[]", "utf8");
		expect(await isClineInstalled(home)).toBe(true);
	});
});
