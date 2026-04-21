import { beforeEach, describe, expect, it, vi } from "vitest";

const { stat } = vi.hoisted(() => ({
	stat: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	stat,
}));

import { isWorkerBusy } from "./LockUtils.js";

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
