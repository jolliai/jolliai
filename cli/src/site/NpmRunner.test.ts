/**
 * Tests for NpmRunner — runs npm commands inside the Hidden Build Directory.
 *
 * Covers all acceptance criteria from Task 8:
 *   - needsInstall returns true when node_modules/ does not exist
 *   - needsInstall returns false when node_modules/ exists
 *   - runNpmInstall returns { success: true, output } on exit code 0
 *   - runNpmInstall returns { success: false, output } on non-zero exit code
 *   - runNpmBuild returns { success: true, output } on exit code 0
 *   - runNpmBuild returns { success: false, output } on non-zero exit code
 *   - stdout and stderr are combined into the output string
 *   - errors are returned (not thrown) on non-zero exit codes
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockSpawnSync, mockSpawn } = vi.hoisted(() => ({
	mockSpawnSync: vi.fn(),
	mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: mockSpawnSync,
	spawn: mockSpawn,
}));

const { mockExistsSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
}));

const { mockEngineNeedsInstall, mockEnsureEngine, mockLinkEngineModules } = vi.hoisted(() => ({
	mockEngineNeedsInstall: vi.fn(),
	mockEnsureEngine: vi.fn(),
	mockLinkEngineModules: vi.fn(),
}));

vi.mock("./EngineManager.js", () => ({
	engineNeedsInstall: mockEngineNeedsInstall,
	ensureEngine: mockEnsureEngine,
	linkEngineModules: mockLinkEngineModules,
}));

vi.mock("./OutputFilter.js", () => ({
	createOutputFilter: () => ({
		write: vi.fn(),
		getUrl: () => "http://localhost:3000",
	}),
}));

vi.mock("node:fs", () => ({
	existsSync: mockExistsSync,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a mock spawnSync result with the given exit code and output. */
function makeSpawnResult(status: number, stdout = "", stderr = "") {
	return {
		status,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
		pid: 1234,
		output: [],
		signal: null,
	};
}

// ─── needsInstall ─────────────────────────────────────────────────────────────

describe("NpmRunner.needsInstall", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when engine needs install", async () => {
		const { needsInstall } = await import("./NpmRunner.js");
		mockEngineNeedsInstall.mockReturnValue(true);
		mockExistsSync.mockReturnValue(true);

		expect(needsInstall("/build/dir")).toBe(true);
	});

	it("returns true when project node_modules symlink is missing", async () => {
		const { needsInstall } = await import("./NpmRunner.js");
		mockEngineNeedsInstall.mockReturnValue(false);
		mockExistsSync.mockReturnValue(false);

		expect(needsInstall("/build/dir")).toBe(true);
	});

	it("returns false when engine is ready and project has node_modules", async () => {
		const { needsInstall } = await import("./NpmRunner.js");
		mockEngineNeedsInstall.mockReturnValue(false);
		mockExistsSync.mockReturnValue(true);

		expect(needsInstall("/build/dir")).toBe(false);
	});

	it("checks the node_modules path inside buildDir", async () => {
		const { needsInstall } = await import("./NpmRunner.js");
		mockEngineNeedsInstall.mockReturnValue(false);
		mockExistsSync.mockReturnValue(false);

		needsInstall("/my/build/dir");

		expect(mockExistsSync).toHaveBeenCalledWith("/my/build/dir/node_modules");
	});
});

// ─── runNpmInstall ────────────────────────────────────────────────────────────

describe("NpmRunner.runNpmInstall", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnsureEngine.mockResolvedValue({ success: true, output: "" });
		mockLinkEngineModules.mockResolvedValue(undefined);
	});

	it("returns success when engine install and link succeed", async () => {
		const { runNpmInstall } = await import("./NpmRunner.js");

		const result = await runNpmInstall("/build/dir");

		expect(result.success).toBe(true);
	});

	it("calls ensureEngine before linkEngineModules", async () => {
		const { runNpmInstall } = await import("./NpmRunner.js");
		const order: string[] = [];
		mockEnsureEngine.mockImplementation(async () => {
			order.push("ensureEngine");
			return { success: true, output: "" };
		});
		mockLinkEngineModules.mockImplementation(async () => {
			order.push("linkEngineModules");
		});

		await runNpmInstall("/build/dir");

		expect(order).toEqual(["ensureEngine", "linkEngineModules"]);
	});

	it("passes buildDir to linkEngineModules", async () => {
		const { runNpmInstall } = await import("./NpmRunner.js");

		await runNpmInstall("/my/build/dir");

		expect(mockLinkEngineModules).toHaveBeenCalledWith("/my/build/dir");
	});

	it("returns failure when engine install fails", async () => {
		const { runNpmInstall } = await import("./NpmRunner.js");
		mockEnsureEngine.mockResolvedValue({ success: false, output: "npm ERR!" });

		const result = await runNpmInstall("/build/dir");

		expect(result.success).toBe(false);
		expect(result.output).toContain("npm ERR!");
	});

	it("does not call linkEngineModules when engine install fails", async () => {
		const { runNpmInstall } = await import("./NpmRunner.js");
		mockEnsureEngine.mockResolvedValue({ success: false, output: "fail" });

		await runNpmInstall("/build/dir");

		expect(mockLinkEngineModules).not.toHaveBeenCalled();
	});

	it("returns failure message when engine output is empty", async () => {
		const { runNpmInstall } = await import("./NpmRunner.js");
		mockEnsureEngine.mockResolvedValue({ success: false, output: "" });

		const result = await runNpmInstall("/build/dir");

		expect(result.success).toBe(false);
		expect(result.output).toContain("Engine install failed");
	});
});

// ─── runNpmBuild ──────────────────────────────────────────────────────────────

describe("NpmRunner.runNpmBuild", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns { success: true } when npm run build exits with code 0", async () => {
		const { runNpmBuild } = await import("./NpmRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Build successful"));

		const result = await runNpmBuild("/build/dir");

		expect(result.success).toBe(true);
	});

	it("returns { success: false } when npm run build exits with non-zero code", async () => {
		const { runNpmBuild } = await import("./NpmRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "", "Build failed"));

		const result = await runNpmBuild("/build/dir");

		expect(result.success).toBe(false);
	});

	it("includes stdout in output on success", async () => {
		const { runNpmBuild } = await import("./NpmRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0, "Build successful", ""));

		const result = await runNpmBuild("/build/dir");

		expect(result.output).toContain("Build successful");
	});

	it("includes stderr in output on failure", async () => {
		const { runNpmBuild } = await import("./NpmRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "", "Build failed"));

		const result = await runNpmBuild("/build/dir");

		expect(result.output).toContain("Build failed");
	});

	it("combines stdout and stderr into output", async () => {
		const { runNpmBuild } = await import("./NpmRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "partial output", "error details"));

		const result = await runNpmBuild("/build/dir");

		expect(result.output).toContain("partial output");
		expect(result.output).toContain("error details");
	});

	it("does not throw on non-zero exit code", async () => {
		const { runNpmBuild } = await import("./NpmRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(1, "", "fatal build error"));

		await expect(runNpmBuild("/build/dir")).resolves.not.toThrow();
	});

	it("calls spawnSync with npm run build and the correct cwd", async () => {
		const { runNpmBuild } = await import("./NpmRunner.js");
		mockSpawnSync.mockReturnValue(makeSpawnResult(0));

		await runNpmBuild("/my/build/dir");

		expect(mockSpawnSync).toHaveBeenCalledWith(expect.any(String), ["run", "build"], {
			cwd: "/my/build/dir",
			stdio: "pipe",
		});
	});

	it("handles null stdout and stderr gracefully", async () => {
		const { runNpmBuild } = await import("./NpmRunner.js");
		mockSpawnSync.mockReturnValue({
			status: 0,
			stdout: null,
			stderr: null,
			pid: 1234,
			output: [],
			signal: null,
		});

		const result = await runNpmBuild("/build/dir");

		expect(result.success).toBe(true);
		expect(result.output).toBe("");
	});
});

// ─── runNpmDev ───────────────────────────────────────────────────────────────

/** Creates a mock ChildProcess with stdout/stderr streams for pipe mode. */
function makeMockChild() {
	const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
	const streamHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
	const mockStream = {
		on(event: string, handler: (...args: unknown[]) => void) {
			if (!streamHandlers[event]) streamHandlers[event] = [];
			streamHandlers[event].push(handler);
			return this;
		},
	};
	return {
		stdout: mockStream,
		stderr: { on: vi.fn() },
		on(event: string, handler: (...args: unknown[]) => void) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
			return this;
		},
		emit(event: string, ...args: unknown[]) {
			for (const h of handlers[event] ?? []) h(...args);
		},
	};
}

describe("NpmRunner.runNpmDev", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns { success: true } when the dev server exits with code 0", async () => {
		const { runNpmDev } = await import("./NpmRunner.js");
		const child = makeMockChild();
		mockSpawn.mockReturnValue(child);

		const promise = runNpmDev("/build/dir");
		child.emit("close", 0);

		const result = await promise;
		expect(result.success).toBe(true);
	});

	it("returns { success: true } when the dev server exits with null code (SIGINT)", async () => {
		const { runNpmDev } = await import("./NpmRunner.js");
		const child = makeMockChild();
		mockSpawn.mockReturnValue(child);

		const promise = runNpmDev("/build/dir");
		child.emit("close", null);

		const result = await promise;
		expect(result.success).toBe(true);
	});

	it("returns { success: false } when the dev server exits with non-zero code", async () => {
		const { runNpmDev } = await import("./NpmRunner.js");
		const child = makeMockChild();
		mockSpawn.mockReturnValue(child);

		const promise = runNpmDev("/build/dir");
		child.emit("close", 1);

		const result = await promise;
		expect(result.success).toBe(false);
	});

	it("returns { success: false } with error message on spawn error", async () => {
		const { runNpmDev } = await import("./NpmRunner.js");
		const child = makeMockChild();
		mockSpawn.mockReturnValue(child);

		const promise = runNpmDev("/build/dir");
		child.emit("error", new Error("spawn ENOENT"));

		const result = await promise;
		expect(result.success).toBe(false);
		expect(result.output).toContain("spawn ENOENT");
	});

	it("calls spawn with npm run dev and the correct cwd", async () => {
		const { runNpmDev } = await import("./NpmRunner.js");
		const child = makeMockChild();
		mockSpawn.mockReturnValue(child);

		const promise = runNpmDev("/my/build/dir");
		child.emit("close", 0);
		await promise;

		expect(mockSpawn).toHaveBeenCalledWith(expect.any(String), ["run", "dev"], {
			cwd: "/my/build/dir",
			stdio: "pipe",
		});
	});
});
