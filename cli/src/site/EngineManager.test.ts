/**
 * Tests for EngineManager — shared site engine lifecycle.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock homedir to use temp directory ─────────────────────────────────────

let tempDir: string;

const { mockHomeDir } = vi.hoisted(() => ({
	mockHomeDir: { value: "" },
}));

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: () => mockHomeDir.value,
	};
});

// ─── Mock child_process ─────────────────────────────────────────────────────

const { mockSpawnSync } = vi.hoisted(() => ({
	mockSpawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: mockSpawnSync,
}));

// ─── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "jolli-engine-test-"));
	mockHomeDir.value = tempDir;
	mockSpawnSync.mockReturnValue({
		status: 0,
		stdout: Buffer.from("installed"),
		stderr: Buffer.from(""),
	});
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// ─── computeDepsHash ────────────────────────────────────────────────────────

describe("EngineManager.computeDepsHash", () => {
	it("returns a non-empty string", async () => {
		const { computeDepsHash } = await import("./EngineManager.js");
		expect(computeDepsHash().length).toBeGreaterThan(0);
	});

	it("returns the same hash on repeated calls", async () => {
		const { computeDepsHash } = await import("./EngineManager.js");
		expect(computeDepsHash()).toBe(computeDepsHash());
	});
});

// ─── engineNeedsInstall ─────────────────────────────────────────────────────

describe("EngineManager.engineNeedsInstall", () => {
	it("returns true when engine.json does not exist", async () => {
		const { engineNeedsInstall } = await import("./EngineManager.js");
		expect(engineNeedsInstall()).toBe(true);
	});

	it("returns true when node_modules does not exist", async () => {
		const { engineNeedsInstall, getEngineDir, computeDepsHash } = await import("./EngineManager.js");
		const engineDir = getEngineDir();
		await mkdir(engineDir, { recursive: true });
		await writeFile(
			join(engineDir, "engine.json"),
			JSON.stringify({ depsHash: computeDepsHash(), installedAt: new Date().toISOString() }),
		);

		expect(engineNeedsInstall()).toBe(true);
	});

	it("returns true when depsHash does not match", async () => {
		const { engineNeedsInstall, getEngineDir } = await import("./EngineManager.js");
		const engineDir = getEngineDir();
		await mkdir(join(engineDir, "node_modules"), { recursive: true });
		await writeFile(
			join(engineDir, "engine.json"),
			JSON.stringify({ depsHash: "stale-hash", installedAt: new Date().toISOString() }),
		);

		expect(engineNeedsInstall()).toBe(true);
	});

	it("returns false when engine is up to date", async () => {
		const { engineNeedsInstall, getEngineDir, computeDepsHash } = await import("./EngineManager.js");
		const engineDir = getEngineDir();
		await mkdir(join(engineDir, "node_modules"), { recursive: true });
		await writeFile(
			join(engineDir, "engine.json"),
			JSON.stringify({ depsHash: computeDepsHash(), installedAt: new Date().toISOString() }),
		);

		expect(engineNeedsInstall()).toBe(false);
	});

	it("returns true when engine.json is invalid JSON", async () => {
		const { engineNeedsInstall, getEngineDir } = await import("./EngineManager.js");
		const engineDir = getEngineDir();
		await mkdir(join(engineDir, "node_modules"), { recursive: true });
		await writeFile(join(engineDir, "engine.json"), "not json");

		expect(engineNeedsInstall()).toBe(true);
	});
});

// ─── ensureEngine ───────────────────────────────────────────────────────────

describe("EngineManager.ensureEngine", () => {
	it("creates engine directory and writes package.json", async () => {
		const { ensureEngine, getEngineDir } = await import("./EngineManager.js");

		const result = await ensureEngine();

		expect(result.success).toBe(true);
		expect(existsSync(join(getEngineDir(), "package.json"))).toBe(true);
	});

	it("writes engine.json after successful install", async () => {
		const { ensureEngine, getEngineDir } = await import("./EngineManager.js");

		await ensureEngine();

		const engineDir = getEngineDir();
		expect(existsSync(join(engineDir, "engine.json"))).toBe(true);
		const meta = JSON.parse(readFileSync(join(engineDir, "engine.json"), "utf-8"));
		expect(meta.depsHash).toBeDefined();
		expect(meta.installedAt).toBeDefined();
	});

	it("calls npm install in the engine directory", async () => {
		const { ensureEngine } = await import("./EngineManager.js");

		await ensureEngine();

		const call = mockSpawnSync.mock.calls[0];
		const invocation = `${call[0]} ${(call[1] ?? []).join(" ")}`;
		expect(invocation).toContain("npm");
		expect(invocation).toContain("install");
		expect(call[2].cwd).toContain(".jolli");
		expect(call[2].cwd).toContain("site-engine");
		expect(call[2].stdio).toBe("pipe");
	});

	it("returns failure when npm install fails", async () => {
		const { ensureEngine } = await import("./EngineManager.js");
		mockSpawnSync.mockReturnValue({
			status: 1,
			stdout: Buffer.from(""),
			stderr: Buffer.from("npm ERR!"),
		});

		const result = await ensureEngine();

		expect(result.success).toBe(false);
		expect(result.output).toContain("npm ERR!");
	});

	it("skips install when engine is already up to date", async () => {
		const { ensureEngine, getEngineDir, computeDepsHash } = await import("./EngineManager.js");
		const engineDir = getEngineDir();
		await mkdir(join(engineDir, "node_modules"), { recursive: true });
		await writeFile(join(engineDir, "package.json"), "{}");
		await writeFile(
			join(engineDir, "engine.json"),
			JSON.stringify({ depsHash: computeDepsHash(), installedAt: new Date().toISOString() }),
		);
		mockSpawnSync.mockClear();

		const result = await ensureEngine();

		expect(result.success).toBe(true);
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});
});

// ─── linkEngineModules ──────────────────────────────────────────────────────

describe("EngineManager.linkEngineModules", () => {
	it("creates a symlink from buildDir/node_modules to engine", async () => {
		const { linkEngineModules, getEngineDir } = await import("./EngineManager.js");
		const buildDir = join(tempDir, "project");
		await mkdir(buildDir, { recursive: true });
		await mkdir(join(getEngineDir(), "node_modules"), { recursive: true });

		await linkEngineModules(buildDir);

		const linkPath = join(buildDir, "node_modules");
		expect(existsSync(linkPath)).toBe(true);
		expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
	});

	it("replaces existing node_modules directory with symlink", async () => {
		const { linkEngineModules, getEngineDir } = await import("./EngineManager.js");
		const buildDir = join(tempDir, "project");
		await mkdir(join(buildDir, "node_modules", "some-pkg"), { recursive: true });
		await mkdir(join(getEngineDir(), "node_modules"), { recursive: true });

		await linkEngineModules(buildDir);

		expect(lstatSync(join(buildDir, "node_modules")).isSymbolicLink()).toBe(true);
	});

	it("creates buildDir if it does not exist", async () => {
		const { linkEngineModules, getEngineDir } = await import("./EngineManager.js");
		const buildDir = join(tempDir, "nonexistent", "project");
		await mkdir(join(getEngineDir(), "node_modules"), { recursive: true });

		await linkEngineModules(buildDir);

		expect(existsSync(buildDir)).toBe(true);
	});

	it("replaces existing symlink with new one", async () => {
		const { linkEngineModules, getEngineDir } = await import("./EngineManager.js");
		const buildDir = join(tempDir, "project");
		await mkdir(buildDir, { recursive: true });
		const engineDir = getEngineDir();
		await mkdir(join(engineDir, "node_modules"), { recursive: true });

		// Create initial symlink
		await linkEngineModules(buildDir);
		// Replace it
		await linkEngineModules(buildDir);

		expect(lstatSync(join(buildDir, "node_modules")).isSymbolicLink()).toBe(true);
	});
});

// ─── ensureEngine lock handling ─────────────────────────────────────────────

describe("EngineManager.ensureEngine lock handling", () => {
	it("does not fail when lock file already exists but is stale", async () => {
		const { ensureEngine, getEngineDir } = await import("./EngineManager.js");
		const engineDir = getEngineDir();
		await mkdir(engineDir, { recursive: true });
		// Create a stale lock (timestamp in the past)
		await writeFile(join(engineDir, ".install-lock"), String(Date.now() - 10 * 60 * 1000));

		const result = await ensureEngine();

		expect(result.success).toBe(true);
	});

	it("cleans up lock file after successful install", async () => {
		const { ensureEngine, getEngineDir } = await import("./EngineManager.js");

		await ensureEngine();

		expect(existsSync(join(getEngineDir(), ".install-lock"))).toBe(false);
	});

	it("cleans up lock file even when install fails", async () => {
		const { ensureEngine, getEngineDir } = await import("./EngineManager.js");
		mockSpawnSync.mockReturnValue({
			status: 1,
			stdout: Buffer.from(""),
			stderr: Buffer.from("fail"),
		});

		await ensureEngine();

		expect(existsSync(join(getEngineDir(), ".install-lock"))).toBe(false);
	});

	it("handles null stdout and stderr from spawnSync", async () => {
		const { ensureEngine } = await import("./EngineManager.js");
		mockSpawnSync.mockReturnValue({
			status: 0,
			stdout: null,
			stderr: null,
		});

		const result = await ensureEngine();

		expect(result.success).toBe(true);
	});
});

// ─── getEngineDir ───────────────────────────────────────────────────────────

describe("EngineManager.getEngineDir", () => {
	it("returns path under homedir/.jolli/site-engine", async () => {
		const { getEngineDir } = await import("./EngineManager.js");

		expect(getEngineDir()).toBe(join(tempDir, ".jolli", "site-engine"));
	});
});

// ─── computeDepsHash stability ──────────────────────────────────────────────

describe("EngineManager.computeDepsHash stability", () => {
	it("returns a 16-character hex string", async () => {
		const { computeDepsHash } = await import("./EngineManager.js");
		expect(computeDepsHash()).toMatch(/^[0-9a-f]{16}$/);
	});
});

// ─── ensureEngine early return path ─────────────────────────────────────────

describe("EngineManager.ensureEngine lock contention early return", () => {
	it("returns success when engine becomes ready while waiting for lock", async () => {
		const { ensureEngine, getEngineDir, computeDepsHash } = await import("./EngineManager.js");
		const engineDir = getEngineDir();
		// Create a fresh lock (not stale) to simulate another process installing
		await mkdir(engineDir, { recursive: true });
		await writeFile(join(engineDir, ".install-lock"), String(Date.now()));
		// Also create a valid engine so that after "waiting", engineNeedsInstall returns false
		await mkdir(join(engineDir, "node_modules"), { recursive: true });
		await writeFile(
			join(engineDir, "engine.json"),
			JSON.stringify({ depsHash: computeDepsHash(), installedAt: new Date().toISOString() }),
		);

		const result = await ensureEngine();

		// Should detect engine is ready without running npm install
		expect(result.success).toBe(true);
	});
});
