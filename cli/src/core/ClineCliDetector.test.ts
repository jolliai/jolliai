import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClineCliDataDir, getClineCliSessionsDir, isClineCliInstalled } from "./ClineCliDetector.js";

describe("ClineCliDetector", () => {
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "cline-cli-det-"));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("derives data + sessions dirs from home", () => {
		expect(getClineCliDataDir(home)).toBe(join(home, ".cline", "data"));
		expect(getClineCliSessionsDir(home)).toBe(join(home, ".cline", "data", "sessions"));
	});

	it("returns false when sessions dir is absent", async () => {
		expect(await isClineCliInstalled(home)).toBe(false);
	});

	it("returns true once sessions dir exists", async () => {
		await mkdir(getClineCliSessionsDir(home), { recursive: true });
		expect(await isClineCliInstalled(home)).toBe(true);
	});
});
