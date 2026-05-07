import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	readManualDisableFlag,
	writeManualDisableFlag,
} from "./ManualDisableFlag.js";

describe("ManualDisableFlag", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "jolli-disable-flag-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("read returns false when the marker file does not exist", async () => {
		expect(await readManualDisableFlag(cwd)).toBe(false);
	});

	it("write(true) creates the marker (and parent dirs) under .jolli/jollimemory/disabled-by-user", async () => {
		await writeManualDisableFlag(cwd, true);

		const expected = join(cwd, ".jolli", "jollimemory", "disabled-by-user");
		await expect(stat(expected)).resolves.toBeDefined();
		expect(await readManualDisableFlag(cwd)).toBe(true);
	});

	it("write(true) records an ISO timestamp body for human debugging", async () => {
		await writeManualDisableFlag(cwd, true);
		const body = await readFile(
			join(cwd, ".jolli", "jollimemory", "disabled-by-user"),
			"utf-8",
		);
		expect(body.trim()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it("write(false) removes the marker if it exists", async () => {
		await writeManualDisableFlag(cwd, true);
		expect(await readManualDisableFlag(cwd)).toBe(true);

		await writeManualDisableFlag(cwd, false);
		expect(await readManualDisableFlag(cwd)).toBe(false);
	});

	it("write(false) is a no-op when the marker is already absent", async () => {
		await expect(writeManualDisableFlag(cwd, false)).resolves.toBeUndefined();
		expect(await readManualDisableFlag(cwd)).toBe(false);
	});
});
