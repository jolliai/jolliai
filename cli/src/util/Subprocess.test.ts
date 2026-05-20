import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.fn().mockReturnValue(Buffer.from("ok"));
const mockSpawn = vi.fn().mockReturnValue({ pid: 1, unref: vi.fn() });
const mockSpawnSync = vi
	.fn()
	.mockReturnValue({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), pid: 1, output: [] });
const mockExecFile = vi
	.fn()
	.mockImplementation(
		(
			_file: string,
			_args: ReadonlyArray<string>,
			_options: unknown,
			callback: (err: null, result: { stdout: string; stderr: string }) => void,
		) => {
			callback(null, { stdout: "", stderr: "" });
		},
	);

vi.mock("node:child_process", () => ({
	execFileSync: mockExecFileSync,
	spawn: mockSpawn,
	spawnSync: mockSpawnSync,
	execFile: mockExecFile,
}));

describe("Subprocess", () => {
	beforeEach(() => {
		mockExecFileSync.mockClear();
		mockSpawn.mockClear();
		mockSpawnSync.mockClear();
		mockExecFile.mockClear();
	});

	describe("execFileSyncHidden", () => {
		it("injects windowsHide:true when no options given", async () => {
			const { execFileSyncHidden } = await import("./Subprocess.js");
			execFileSyncHidden("git", ["status"]);
			expect(mockExecFileSync).toHaveBeenCalledWith(
				"git",
				["status"],
				expect.objectContaining({ windowsHide: true }),
			);
		});

		it("preserves user options and adds windowsHide:true", async () => {
			const { execFileSyncHidden } = await import("./Subprocess.js");
			execFileSyncHidden("git", ["status"], { cwd: "/tmp", encoding: "utf-8" });
			expect(mockExecFileSync).toHaveBeenCalledWith(
				"git",
				["status"],
				expect.objectContaining({ cwd: "/tmp", encoding: "utf-8", windowsHide: true }),
			);
		});

		it("lets caller override windowsHide:false explicitly", async () => {
			const { execFileSyncHidden } = await import("./Subprocess.js");
			execFileSyncHidden("git", ["status"], { windowsHide: false });
			expect(mockExecFileSync).toHaveBeenCalledWith(
				"git",
				["status"],
				expect.objectContaining({ windowsHide: false }),
			);
		});

		it("supports calling without args array", async () => {
			const { execFileSyncHidden } = await import("./Subprocess.js");
			execFileSyncHidden("git");
			expect(mockExecFileSync).toHaveBeenCalledWith(
				"git",
				undefined,
				expect.objectContaining({ windowsHide: true }),
			);
		});
	});

	describe("spawnHidden", () => {
		it("injects windowsHide:true when no options given", async () => {
			const { spawnHidden } = await import("./Subprocess.js");
			spawnHidden("git", ["status"]);
			expect(mockSpawn).toHaveBeenCalledWith("git", ["status"], expect.objectContaining({ windowsHide: true }));
		});

		it("preserves user options and adds windowsHide:true", async () => {
			const { spawnHidden } = await import("./Subprocess.js");
			spawnHidden("node", ["script.js"], { detached: true, stdio: "ignore", cwd: "/tmp" });
			expect(mockSpawn).toHaveBeenCalledWith(
				"node",
				["script.js"],
				expect.objectContaining({ detached: true, stdio: "ignore", cwd: "/tmp", windowsHide: true }),
			);
		});

		it("lets caller override windowsHide:false explicitly", async () => {
			const { spawnHidden } = await import("./Subprocess.js");
			spawnHidden("git", ["status"], { windowsHide: false });
			expect(mockSpawn).toHaveBeenCalledWith("git", ["status"], expect.objectContaining({ windowsHide: false }));
		});

		it("supports 2-arg form: spawn(command, options) without args array", async () => {
			const { spawnHidden } = await import("./Subprocess.js");
			// TypeScript: the 2-arg `spawn(command, options)` overload exists at runtime;
			// the wrapper detects via Array.isArray and forwards through the args-less spawn call.
			(spawnHidden as (cmd: string, opts: object) => unknown)("node", { detached: true, stdio: "ignore" });
			expect(mockSpawn).toHaveBeenCalledWith(
				"node",
				expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
			);
		});

		it("treats a missing 2nd arg as no options (still injects windowsHide:true)", async () => {
			const { spawnHidden } = await import("./Subprocess.js");
			(spawnHidden as (cmd: string) => unknown)("node");
			expect(mockSpawn).toHaveBeenCalledWith("node", expect.objectContaining({ windowsHide: true }));
		});
	});

	describe("spawnSyncHidden", () => {
		it("injects windowsHide:true when no options given", async () => {
			const { spawnSyncHidden } = await import("./Subprocess.js");
			spawnSyncHidden("git", ["status"]);
			expect(mockSpawnSync).toHaveBeenCalledWith(
				"git",
				["status"],
				expect.objectContaining({ windowsHide: true }),
			);
		});

		it("preserves user options and adds windowsHide:true", async () => {
			const { spawnSyncHidden } = await import("./Subprocess.js");
			spawnSyncHidden("attrib", ["+h", "C:/tmp/file"], { timeout: 2000 });
			expect(mockSpawnSync).toHaveBeenCalledWith(
				"attrib",
				["+h", "C:/tmp/file"],
				expect.objectContaining({ timeout: 2000, windowsHide: true }),
			);
		});

		it("lets caller override windowsHide:false explicitly", async () => {
			const { spawnSyncHidden } = await import("./Subprocess.js");
			spawnSyncHidden("git", ["status"], { windowsHide: false });
			expect(mockSpawnSync).toHaveBeenCalledWith(
				"git",
				["status"],
				expect.objectContaining({ windowsHide: false }),
			);
		});
	});

	describe("execFileAsyncHidden", () => {
		it("injects windowsHide:true when no options given", async () => {
			const { execFileAsyncHidden } = await import("./Subprocess.js");
			await execFileAsyncHidden("git", ["status"]);
			expect(mockExecFile).toHaveBeenCalledWith(
				"git",
				["status"],
				expect.objectContaining({ windowsHide: true }),
				expect.any(Function),
			);
		});

		it("preserves user options and adds windowsHide:true", async () => {
			const { execFileAsyncHidden } = await import("./Subprocess.js");
			await execFileAsyncHidden("git", ["status"], { cwd: "/tmp", encoding: "utf-8" });
			expect(mockExecFile).toHaveBeenCalledWith(
				"git",
				["status"],
				expect.objectContaining({ cwd: "/tmp", encoding: "utf-8", windowsHide: true }),
				expect.any(Function),
			);
		});

		it("lets caller override windowsHide:false explicitly", async () => {
			const { execFileAsyncHidden } = await import("./Subprocess.js");
			await execFileAsyncHidden("git", ["status"], { windowsHide: false });
			expect(mockExecFile).toHaveBeenCalledWith(
				"git",
				["status"],
				expect.objectContaining({ windowsHide: false }),
				expect.any(Function),
			);
		});

		it("resolves with stdout/stderr from execFile callback", async () => {
			mockExecFile.mockImplementationOnce(
				(
					_file: string,
					_args: ReadonlyArray<string>,
					_options: unknown,
					callback: (err: null, result: { stdout: string; stderr: string }) => void,
				) => {
					callback(null, { stdout: "main\n", stderr: "" });
				},
			);
			const { execFileAsyncHidden } = await import("./Subprocess.js");
			const result = await execFileAsyncHidden("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
			expect(result).toEqual({ stdout: "main\n", stderr: "" });
		});

		it("rejects when execFile callback yields an error", async () => {
			const err = new Error("boom");
			mockExecFile.mockImplementationOnce(
				(_file: string, _args: ReadonlyArray<string>, _options: unknown, callback: (err: Error) => void) => {
					callback(err);
				},
			);
			const { execFileAsyncHidden } = await import("./Subprocess.js");
			await expect(execFileAsyncHidden("git", ["bogus"])).rejects.toBe(err);
		});
	});
});
