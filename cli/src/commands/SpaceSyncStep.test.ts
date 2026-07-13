import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSpaceSyncStep } from "./SpaceSyncStep.js";

describe("runSpaceSyncStep (stub)", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	const PRIOR_DEV = process.env.JOLLI_DEV;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		delete process.env.JOLLI_DEV;
	});

	afterEach(() => {
		logSpy.mockRestore();
		if (PRIOR_DEV === undefined) delete process.env.JOLLI_DEV;
		else process.env.JOLLI_DEV = PRIOR_DEV;
	});

	it("stays silent for end users (no JOLLI_DEV) — placeholder must not leak in a release", async () => {
		await runSpaceSyncStep("/repo");
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("prints the dev placeholder when JOLLI_DEV is set", async () => {
		process.env.JOLLI_DEV = "1";
		await runSpaceSyncStep("/repo");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[space-sync]"));
	});
});
