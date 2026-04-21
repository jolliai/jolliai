import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
	stat: vi.fn(),
}));

vi.mock("node:os", () => ({
	homedir: vi.fn(),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isClaudeInstalled } from "./ClaudeDetector.js";

describe("ClaudeDetector", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(homedir).mockReturnValue("/home/testuser");
	});

	describe("isClaudeInstalled", () => {
		it("should return true when ~/.claude/ exists and is a directory", async () => {
			vi.mocked(stat).mockResolvedValueOnce({ isDirectory: () => true } as never);

			const result = await isClaudeInstalled();

			expect(result).toBe(true);
			expect(stat).toHaveBeenCalledWith(expect.stringContaining(".claude"));
		});

		it("should return false when ~/.claude/ does not exist (stat throws)", async () => {
			vi.mocked(stat).mockRejectedValueOnce(new Error("ENOENT: no such file or directory"));

			const result = await isClaudeInstalled();

			expect(result).toBe(false);
		});

		it("should return false when ~/.claude/ exists but is a file, not a directory", async () => {
			vi.mocked(stat).mockResolvedValueOnce({ isDirectory: () => false } as never);

			const result = await isClaudeInstalled();

			expect(result).toBe(false);
		});
	});
});
