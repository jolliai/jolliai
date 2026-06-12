import { beforeEach, describe, expect, it, vi } from "vitest";

const { stat, readFile } = vi.hoisted(() => ({
	stat: vi.fn(),
	readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	stat,
	readFile,
}));

import { isWorkerBlockingBusy, isWorkerBusy } from "./LockUtils.js";

describe("isWorkerBusy", () => {
	beforeEach(() => {
		stat.mockReset();
		vi.useRealTimers();
	});

	it("returns true when the lock file is fresh", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T00:05:00.000Z"));
		stat.mockResolvedValue({
			mtimeMs: new Date("2026-03-30T00:01:00.000Z").getTime(),
		});

		await expect(isWorkerBusy("/repo")).resolves.toBe(true);
	});

	it("returns false when the lock file is stale or missing", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T00:10:00.000Z"));
		stat.mockResolvedValueOnce({
			mtimeMs: new Date("2026-03-30T00:00:00.000Z").getTime(),
		});
		stat.mockRejectedValueOnce(new Error("ENOENT"));

		await expect(isWorkerBusy("/repo")).resolves.toBe(false);
		await expect(isWorkerBusy("/repo")).resolves.toBe(false);
	});
});

describe("isWorkerBlockingBusy", () => {
	beforeEach(() => {
		stat.mockReset();
		readFile.mockReset();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T00:05:00.000Z"));
		// Fresh lock by default — individual tests override.
		stat.mockResolvedValue({
			mtimeMs: new Date("2026-03-30T00:04:00.000Z").getTime(),
		});
	});

	it("returns false when the worker is not busy at all", async () => {
		stat.mockRejectedValue(new Error("ENOENT"));

		await expect(isWorkerBlockingBusy("/repo")).resolves.toBe(false);
		expect(readFile).not.toHaveBeenCalled();
	});

	it("returns true when busy with the default summary phase (no marker)", async () => {
		readFile.mockRejectedValue(new Error("ENOENT"));

		await expect(isWorkerBlockingBusy("/repo")).resolves.toBe(true);
	});

	it("returns false when busy with the ingest phase", async () => {
		readFile.mockResolvedValue("ingest");

		await expect(isWorkerBlockingBusy("/repo")).resolves.toBe(false);
		expect(readFile).toHaveBeenCalledWith(
			expect.stringContaining("worker-phase"),
			"utf-8",
		);
	});

	it("trims whitespace around the phase marker content", async () => {
		readFile.mockResolvedValue("ingest\n");

		await expect(isWorkerBlockingBusy("/repo")).resolves.toBe(false);
	});

	it("treats an unknown phase as blocking", async () => {
		readFile.mockResolvedValue("something-else");

		await expect(isWorkerBlockingBusy("/repo")).resolves.toBe(true);
	});
});
