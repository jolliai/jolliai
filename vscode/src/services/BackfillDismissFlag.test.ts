import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJolliMemoryDir } from "../../../cli/src/Logger.js";
import { readBackfillDismissFlag, writeBackfillDismissFlag } from "./BackfillDismissFlag.js";

describe("BackfillDismissFlag", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "jolli-bf-dismiss-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reads false when no marker exists", async () => {
		expect(await readBackfillDismissFlag(cwd)).toBe(false);
	});

	it("writes the marker (creating the dir) and reads back true", async () => {
		await writeBackfillDismissFlag(cwd, true);
		expect(await readBackfillDismissFlag(cwd)).toBe(true);
		// Body is an ISO timestamp (human-debug only) — existence is the boolean.
		const body = readFileSync(join(getJolliMemoryDir(cwd), "backfill-card-dismissed"), "utf8");
		expect(body.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("clears the marker and reads back false", async () => {
		await writeBackfillDismissFlag(cwd, true);
		await writeBackfillDismissFlag(cwd, false);
		expect(await readBackfillDismissFlag(cwd)).toBe(false);
	});

	it("clearing an already-absent marker is a no-op (no throw)", async () => {
		await expect(writeBackfillDismissFlag(cwd, false)).resolves.toBeUndefined();
		expect(await readBackfillDismissFlag(cwd)).toBe(false);
	});
});
