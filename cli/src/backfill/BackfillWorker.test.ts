import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("../util/Subprocess.js", () => ({
	spawnHidden: vi.fn().mockReturnValue({ unref: vi.fn(), pid: 4321 }),
}));
vi.mock("./BackfillEngine.js", () => ({
	runBackfill: vi.fn().mockResolvedValue({ total: 0, generated: 0, skipped: 0, errors: 0, outcomes: [] }),
	recentCommitHashes: vi.fn(),
}));
vi.mock("../Logger.js", () => ({
	setLogDir: vi.fn(),
	createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

import { existsSync } from "node:fs";
import { spawnHidden } from "../util/Subprocess.js";
import { recentCommitHashes, runBackfill } from "./BackfillEngine.js";
import { ENABLE_BACKFILL_COUNT, launchBackfillWorker, parseCwd, runWorker } from "./BackfillWorker.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("launchBackfillWorker", () => {
	it("spawns a detached worker when the script exists", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		launchBackfillWorker("e:/repo");
		expect(vi.mocked(spawnHidden)).toHaveBeenCalledTimes(1);
		const [, args] = vi.mocked(spawnHidden).mock.calls[0];
		expect(args).toContain("--worker");
		expect(args).toContain("e:/repo");
	});

	it("does not spawn when the worker script is missing", () => {
		vi.mocked(existsSync).mockReturnValue(false);
		launchBackfillWorker("e:/repo");
		expect(vi.mocked(spawnHidden)).not.toHaveBeenCalled();
	});

	it("tolerates a spawned child with no pid", () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(spawnHidden).mockReturnValueOnce({ unref: vi.fn(), pid: undefined } as never);
		expect(() => launchBackfillWorker("e:/repo")).not.toThrow();
	});
});

describe("runWorker", () => {
	it("back-fills the user's last N commits", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue(["h1", "h2"]);
		await runWorker("e:/repo");
		expect(vi.mocked(recentCommitHashes)).toHaveBeenCalledWith("e:/repo", ENABLE_BACKFILL_COUNT);
		expect(vi.mocked(runBackfill)).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "e:/repo", hashes: ["h1", "h2"] }),
		);
	});

	it("no-ops when there are no commits", async () => {
		vi.mocked(recentCommitHashes).mockResolvedValue([]);
		await runWorker("e:/repo");
		expect(vi.mocked(runBackfill)).not.toHaveBeenCalled();
	});
});

describe("parseCwd", () => {
	it("reads the --cwd value when present", () => {
		expect(parseCwd(["--worker", "--cwd", "e:/x"])).toBe("e:/x");
	});
	it("falls back to process.cwd() when --cwd is absent or dangling", () => {
		expect(parseCwd(["--worker"])).toBe(process.cwd());
		expect(parseCwd(["--cwd"])).toBe(process.cwd());
	});
});
