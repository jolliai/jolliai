import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSpaceSyncStep } from "./SpaceSyncStep.js";

describe("runSpaceSyncStep (stub)", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("prints the development placeholder", async () => {
		await runSpaceSyncStep("/repo");
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[space-sync]"));
	});
});
