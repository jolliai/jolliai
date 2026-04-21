import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Suppress console output during tests
beforeAll(() => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

// Mock os.homedir to point to a temp directory
const mockHomeDir = vi.fn<() => string>();
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => mockHomeDir() };
});

import { isGeminiInstalled } from "./GeminiSessionDetector.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(realTmpdir(), "gemini-detect-test-"));
	mockHomeDir.mockReturnValue(tempDir);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("isGeminiInstalled", () => {
	it("should return true when ~/.gemini/ directory exists", async () => {
		await mkdir(join(tempDir, ".gemini"), { recursive: true });
		expect(await isGeminiInstalled()).toBe(true);
	});

	it("should return false when ~/.gemini/ directory does not exist", async () => {
		expect(await isGeminiInstalled()).toBe(false);
	});

	it("should return false when ~/.gemini is a file, not a directory", async () => {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(tempDir, ".gemini"), "not a directory", "utf-8");
		expect(await isGeminiInstalled()).toBe(false);
	});
});
