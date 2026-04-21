import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHomeDir, mockPlatform } = vi.hoisted(() => ({
	mockHomeDir: vi.fn<() => string>(),
	mockPlatform: vi.fn<() => string>(),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => mockHomeDir(), platform: () => mockPlatform() };
});

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		createReadStream: vi.fn(() => {
			throw new Error("boom");
		}),
	};
});

// Suppress console noise in the error-path test
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { discoverCodexSessions } from "./CodexSessionDiscoverer.js";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(realTmpdir(), "codex-discover-read-error-"));
	mockHomeDir.mockReturnValue(tempDir);
	mockPlatform.mockReturnValue("darwin");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("discoverCodexSessions read errors", () => {
	it("skips jsonl files when reading the first line throws", async () => {
		const now = new Date();
		const year = String(now.getFullYear());
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const day = String(now.getDate()).padStart(2, "0");
		const dayDir = join(tempDir, ".codex", "sessions", year, month, day);

		await mkdir(dayDir, { recursive: true });
		const filePath = join(dayDir, "rollout-read-error.jsonl");
		const meta = JSON.stringify({
			timestamp: now.toISOString(),
			type: "session_meta",
			payload: { id: "sess-read-error", cwd: "/my/project" },
		});
		await writeFile(filePath, `${meta}\n`, "utf-8");

		const sessions = await discoverCodexSessions("/my/project");
		expect(sessions).toEqual([]);
	});
});
