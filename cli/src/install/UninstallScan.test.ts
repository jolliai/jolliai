/**
 * UninstallScan tests.
 *
 * Uses real temp directories for the filesystem-facing scanners (VS Code,
 * IntelliJ, CLI-global, config dirs) so readdir/stat/lstat branches are
 * exercised end-to-end. Only three seams are mocked: `getStatus` (repo-hooks
 * probe), `getGlobalConfigDir` (redirected into a temp dir), and
 * `execFileAsyncHidden` (the `npm root -g` spawn).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockGetStatus, mockExecFile } = vi.hoisted(() => ({
	mockGetStatus: vi.fn(),
	mockExecFile: vi.fn(),
}));

let mockGlobalConfigDir = "/nonexistent/global/config";

vi.mock("./Installer.js", () => ({
	getStatus: mockGetStatus,
}));

vi.mock("../core/SessionTracker.js", () => ({
	getGlobalConfigDir: () => mockGlobalConfigDir,
}));

vi.mock("../util/Subprocess.js", () => ({
	execFileAsyncHidden: mockExecFile,
}));

import {
	getJetBrainsRoot,
	pruneVscodeExtensionManifest,
	resolveNpmGlobalRoots,
	scanCliGlobal,
	scanGlobalConfig,
	scanIntellijPlugins,
	scanProjectConfig,
	scanRepoHooks,
	scanUninstallInventory,
	scanVscodeExtensions,
	staticNpmGlobalRoots,
} from "./UninstallScan.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "jolli-uninstall-scan-"));
	mockGlobalConfigDir = "/nonexistent/global/config";
	vi.clearAllMocks();
	mockGetStatus.mockResolvedValue({
		gitHookInstalled: false,
		claudeHookInstalled: false,
		geminiHookInstalled: false,
	});
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// ─── scanVscodeExtensions ─────────────────────────────────────────────────────

describe("scanVscodeExtensions", () => {
	it("finds the extension across editors and forks and parses the version", async () => {
		mkdirSync(join(tempDir, ".vscode", "extensions", "jolli.jollimemory-vscode-0.99.7"), { recursive: true });
		mkdirSync(join(tempDir, ".vscode", "extensions", "ms-python.python-2024.1"), { recursive: true });
		mkdirSync(join(tempDir, ".cursor", "extensions", "jolli.jollimemory-vscode-1.0.0"), { recursive: true });
		// Antigravity's real data dir is `.antigravity-ide`, not `.antigravity`.
		mkdirSync(join(tempDir, ".antigravity-ide", "extensions", "jolli.jollimemory-vscode-1.0.0"), {
			recursive: true,
		});
		mkdirSync(join(tempDir, ".kiro", "extensions", "jolli.jollimemory-vscode-1.0.0"), { recursive: true });
		mkdirSync(join(tempDir, ".devin", "extensions", "jolli.jollimemory-vscode-1.0.0"), { recursive: true });

		const items = await scanVscodeExtensions(tempDir);

		expect(items).toHaveLength(5);
		const vscode = items.find((i) => i.label.includes("VS Code"));
		expect(vscode?.detail).toBe("v0.99.7");
		expect(vscode?.kind).toBe("dir");
		expect(items.some((i) => i.label.includes("Cursor") && i.detail === "v1.0.0")).toBe(true);
		expect(items.some((i) => i.label.includes("Antigravity"))).toBe(true);
		expect(items.some((i) => i.label.includes("Kiro"))).toBe(true);
		expect(items.some((i) => i.label.includes("Devin"))).toBe(true);
	});

	it("leaves detail undefined when the folder has no version suffix", async () => {
		mkdirSync(join(tempDir, ".vscode", "extensions", "jolli.jollimemory-vscode"), { recursive: true });

		const items = await scanVscodeExtensions(tempDir);

		expect(items).toHaveLength(1);
		expect(items[0].detail).toBeUndefined();
	});

	it("returns nothing when no editor extensions dir exists", async () => {
		const items = await scanVscodeExtensions(tempDir);
		expect(items).toEqual([]);
	});
});

// ─── pruneVscodeExtensionManifest ─────────────────────────────────────────────

describe("pruneVscodeExtensionManifest", () => {
	/** Writes an extensions.json in `extDir` and returns its path. */
	function writeManifest(extDir: string, entries: unknown[]): string {
		mkdirSync(extDir, { recursive: true });
		const p = join(extDir, "extensions.json");
		writeFileSync(p, JSON.stringify(entries));
		return p;
	}

	it("removes the entry whose relativeLocation matches the deleted folder", async () => {
		const extDir = join(tempDir, "extensions");
		const manifest = writeManifest(extDir, [
			{ identifier: { id: "jolli.jollimemory-vscode" }, relativeLocation: "jolli.jollimemory-vscode-1.0.0" },
			{ identifier: { id: "ms-python.python" }, relativeLocation: "ms-python.python-2024.1" },
		]);

		await pruneVscodeExtensionManifest(join(extDir, "jolli.jollimemory-vscode-1.0.0"));

		const remaining = JSON.parse(readFileSync(manifest, "utf8")) as Array<{ relativeLocation: string }>;
		expect(remaining).toHaveLength(1);
		expect(remaining[0].relativeLocation).toBe("ms-python.python-2024.1");
	});

	it("leaves the manifest untouched when nothing matches", async () => {
		const extDir = join(tempDir, "extensions");
		const entries = [{ relativeLocation: "other.ext-1.0.0" }];
		const manifest = writeManifest(extDir, entries);
		const before = readFileSync(manifest, "utf8");

		await pruneVscodeExtensionManifest(join(extDir, "jolli.jollimemory-vscode-1.0.0"));

		expect(readFileSync(manifest, "utf8")).toBe(before);
	});

	it("does nothing when the manifest is absent", async () => {
		// No extensions.json created — must not throw.
		await expect(
			pruneVscodeExtensionManifest(join(tempDir, "extensions", "jolli.jollimemory-vscode-1.0.0")),
		).resolves.toBeUndefined();
	});

	it("swallows a malformed manifest", async () => {
		const extDir = join(tempDir, "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "extensions.json"), "{ not json");

		await expect(
			pruneVscodeExtensionManifest(join(extDir, "jolli.jollimemory-vscode-1.0.0")),
		).resolves.toBeUndefined();
	});

	it("ignores a manifest that is not a JSON array", async () => {
		const extDir = join(tempDir, "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "extensions.json"), JSON.stringify({ not: "an array" }));

		await expect(
			pruneVscodeExtensionManifest(join(extDir, "jolli.jollimemory-vscode-1.0.0")),
		).resolves.toBeUndefined();
	});
});

// ─── getJetBrainsRoot ─────────────────────────────────────────────────────────

describe("getJetBrainsRoot", () => {
	it("resolves the macOS path", () => {
		expect(getJetBrainsRoot("/home/u", "darwin")).toBe("/home/u/Library/Application Support/JetBrains");
	});

	it("resolves the Linux path", () => {
		expect(getJetBrainsRoot("/home/u", "linux")).toBe("/home/u/.local/share/JetBrains");
	});

	it("resolves the Windows path from APPDATA", () => {
		vi.stubEnv("APPDATA", "C:\\Users\\u\\AppData\\Roaming");
		expect(getJetBrainsRoot("C:\\Users\\u", "win32")).toContain("JetBrains");
	});

	it("falls back to a home-relative path on Windows without APPDATA", () => {
		vi.stubEnv("APPDATA", undefined);
		const result = getJetBrainsRoot("C:\\Users\\u", "win32");
		expect(result).toContain("JetBrains");
	});
});

// ─── scanIntellijPlugins ──────────────────────────────────────────────────────

describe("scanIntellijPlugins", () => {
	function jetbrainsBase(home: string): string {
		return join(home, ".local", "share", "JetBrains");
	}

	it("finds jolli plugins across product dirs and skips non-jolli ones", async () => {
		const base = jetbrainsBase(tempDir);
		mkdirSync(join(base, "IntelliJIdea2024.1", "plugins", "jollimemory-intellij"), { recursive: true });
		mkdirSync(join(base, "IntelliJIdea2024.1", "plugins", "some-other-plugin"), { recursive: true });
		mkdirSync(join(base, "WebStorm2023.3", "plugins", "jollimemory-intellij"), { recursive: true });

		const items = await scanIntellijPlugins(tempDir, "linux");

		expect(items).toHaveLength(2);
		expect(items.every((i) => i.surface === "intellij-plugin")).toBe(true);
		expect(items.some((i) => i.label.includes("WebStorm2023.3"))).toBe(true);
	});

	it("returns nothing when the JetBrains root is absent", async () => {
		const items = await scanIntellijPlugins(tempDir, "linux");
		expect(items).toEqual([]);
	});

	it("skips product entries that have no plugins subdirectory", async () => {
		const base = jetbrainsBase(tempDir);
		mkdirSync(base, { recursive: true });
		writeFileSync(join(base, "stray-file"), "x");

		const items = await scanIntellijPlugins(tempDir, "linux");
		expect(items).toEqual([]);
	});

	it("finds Android Studio under Google, ignoring unrelated Google apps", async () => {
		const googleBase = join(tempDir, ".local", "share", "Google");
		mkdirSync(join(googleBase, "AndroidStudio2024.1", "plugins", "jollimemory-intellij"), { recursive: true });
		// A non-AndroidStudio app under Google/ must be skipped even if it somehow
		// contains a jolli-named folder — the productPrefix filter excludes it.
		mkdirSync(join(googleBase, "Chrome", "plugins", "jollimemory-intellij"), { recursive: true });

		const items = await scanIntellijPlugins(tempDir, "linux");

		expect(items).toHaveLength(1);
		expect(items[0].surface).toBe("intellij-plugin");
		expect(items[0].label).toContain("AndroidStudio2024.1");
	});
});

// ─── resolveNpmGlobalRoots ────────────────────────────────────────────────────

describe("resolveNpmGlobalRoots", () => {
	it("returns the trimmed root from `npm root -g`, passing a timeout", async () => {
		mockExecFile.mockResolvedValueOnce({ stdout: "/usr/local/lib/node_modules\n", stderr: "" });
		expect(await resolveNpmGlobalRoots()).toEqual(["/usr/local/lib/node_modules"]);
		expect(mockExecFile).toHaveBeenCalledWith("npm", ["root", "-g"], { timeout: 5000 });
	});

	it("returns [] when npm prints empty output", async () => {
		mockExecFile.mockResolvedValueOnce({ stdout: "  \n", stderr: "" });
		expect(await resolveNpmGlobalRoots()).toEqual([]);
	});

	it("returns [] when npm is missing or errors", async () => {
		mockExecFile.mockRejectedValueOnce(new Error("spawn npm ENOENT"));
		expect(await resolveNpmGlobalRoots()).toEqual([]);
	});
});

// ─── staticNpmGlobalRoots ─────────────────────────────────────────────────────

describe("staticNpmGlobalRoots", () => {
	it("includes the Homebrew path on darwin", () => {
		const roots = staticNpmGlobalRoots("/Users/u", "darwin");
		expect(roots).toContain("/opt/homebrew/lib/node_modules");
		expect(roots).toContain("/usr/local/lib/node_modules");
	});

	it("omits the Homebrew path on plain linux", () => {
		const roots = staticNpmGlobalRoots("/home/u", "linux");
		expect(roots).not.toContain("/opt/homebrew/lib/node_modules");
	});

	it("returns the APPDATA npm path on win32", () => {
		vi.stubEnv("APPDATA", "C:\\Users\\u\\AppData\\Roaming");
		const roots = staticNpmGlobalRoots("C:\\Users\\u", "win32");
		expect(roots.some((r) => r.includes("npm"))).toBe(true);
	});

	it("falls back to a home-relative npm path on win32 without APPDATA", () => {
		vi.stubEnv("APPDATA", undefined);
		const roots = staticNpmGlobalRoots("C:\\Users\\u", "win32");
		expect(roots).toHaveLength(1);
	});
});

// ─── scanCliGlobal ────────────────────────────────────────────────────────────

describe("scanCliGlobal", () => {
	it("finds the package dir and the POSIX bin shim, de-duplicating roots", async () => {
		const root = join(tempDir, "lib", "node_modules");
		mkdirSync(join(root, "@jolli.ai", "cli"), { recursive: true });
		mkdirSync(join(tempDir, "bin"), { recursive: true });
		symlinkSync(join(root, "@jolli.ai", "cli", "dist", "Cli.js"), join(tempDir, "bin", "jolli"));

		// Pass the same root twice to exercise de-duplication.
		const items = await scanCliGlobal(tempDir, "linux", [root, root]);

		expect(items.filter((i) => i.kind === "dir")).toHaveLength(1);
		expect(items.filter((i) => i.kind === "file")).toHaveLength(1);
		expect(items[0].surface).toBe("cli-global");
	});

	it("returns only the package dir when no bin shim exists", async () => {
		const root = join(tempDir, "lib", "node_modules");
		mkdirSync(join(root, "@jolli.ai", "cli"), { recursive: true });

		const items = await scanCliGlobal(tempDir, "linux", [root]);

		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("dir");
	});

	it("returns nothing when the package is not installed at any root", async () => {
		const items = await scanCliGlobal(tempDir, "linux", [join(tempDir, "empty")]);
		expect(items).toEqual([]);
	});

	it("handles a global root that does not end in node_modules", async () => {
		const root = join(tempDir, "globalroot");
		mkdirSync(join(root, "@jolli.ai", "cli"), { recursive: true });
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(root, "bin", "jolli"), "#!/bin/sh");

		const items = await scanCliGlobal(tempDir, "linux", [root]);

		expect(items.filter((i) => i.kind === "dir")).toHaveLength(1);
		expect(items.filter((i) => i.kind === "file")).toHaveLength(1);
	});

	it("de-duplicates a bin shim shared by two roots with the same prefix", async () => {
		const libRoot = join(tempDir, "lib", "node_modules");
		const plainRoot = join(tempDir, "node_modules");
		mkdirSync(join(libRoot, "@jolli.ai", "cli"), { recursive: true });
		mkdirSync(join(plainRoot, "@jolli.ai", "cli"), { recursive: true });
		mkdirSync(join(tempDir, "bin"), { recursive: true });
		writeFileSync(join(tempDir, "bin", "jolli"), "#!/bin/sh");

		const items = await scanCliGlobal(tempDir, "linux", [libRoot, plainRoot]);

		// Two distinct package dirs, but the shared bin shim is listed once.
		expect(items.filter((i) => i.kind === "dir")).toHaveLength(2);
		expect(items.filter((i) => i.kind === "file")).toHaveLength(1);
	});

	it("locates the Windows shim beside the prefix", async () => {
		const root = join(tempDir, "npm", "node_modules");
		mkdirSync(join(root, "@jolli.ai", "cli"), { recursive: true });
		writeFileSync(join(tempDir, "npm", "jolli.cmd"), "@echo off");

		const items = await scanCliGlobal(tempDir, "win32", [root]);

		expect(items.some((i) => i.kind === "file" && i.path.endsWith("jolli.cmd"))).toBe(true);
	});
});

// ─── scanGlobalConfig ─────────────────────────────────────────────────────────

describe("scanGlobalConfig", () => {
	it("returns the dir item when the global config dir exists", async () => {
		mockGlobalConfigDir = join(tempDir, "globalcfg");
		mkdirSync(mockGlobalConfigDir, { recursive: true });

		const items = await scanGlobalConfig();
		expect(items).toHaveLength(1);
		expect(items[0].surface).toBe("global-config");
	});

	it("returns nothing when the dir is missing", async () => {
		mockGlobalConfigDir = join(tempDir, "missing");
		expect(await scanGlobalConfig()).toEqual([]);
	});

	it("returns nothing when the path is a file, not a dir", async () => {
		mockGlobalConfigDir = join(tempDir, "cfgfile");
		writeFileSync(mockGlobalConfigDir, "x");
		expect(await scanGlobalConfig()).toEqual([]);
	});
});

// ─── scanProjectConfig ────────────────────────────────────────────────────────

describe("scanProjectConfig", () => {
	it("returns the dir item when the project state dir exists", async () => {
		mkdirSync(join(tempDir, ".jolli", "jollimemory"), { recursive: true });

		const items = await scanProjectConfig(tempDir);
		expect(items).toHaveLength(1);
		expect(items[0].surface).toBe("project-config");
	});

	it("returns nothing when the project state dir is missing", async () => {
		expect(await scanProjectConfig(tempDir)).toEqual([]);
	});

	it("returns nothing when the state path is a file", async () => {
		mkdirSync(join(tempDir, ".jolli"), { recursive: true });
		writeFileSync(join(tempDir, ".jolli", "jollimemory"), "x");
		expect(await scanProjectConfig(tempDir)).toEqual([]);
	});
});

// ─── scanRepoHooks ────────────────────────────────────────────────────────────

describe("scanRepoHooks", () => {
	it("emits a hooks pseudo-item when any hook is installed", async () => {
		mockGetStatus.mockResolvedValueOnce({
			gitHookInstalled: true,
			claudeHookInstalled: false,
			geminiHookInstalled: false,
		});

		const items = await scanRepoHooks(tempDir);
		expect(items).toHaveLength(1);
		expect(items[0].kind).toBe("hooks");
		expect(items[0].surface).toBe("repo-hooks");
	});

	it("returns nothing when no hooks are installed", async () => {
		const items = await scanRepoHooks(tempDir);
		expect(items).toEqual([]);
	});

	it("returns nothing (non-fatal) when getStatus throws", async () => {
		mockGetStatus.mockRejectedValueOnce(new Error("not a git repo"));
		const items = await scanRepoHooks(tempDir);
		expect(items).toEqual([]);
	});
});

// ─── scanUninstallInventory ───────────────────────────────────────────────────

describe("scanUninstallInventory", () => {
	it("aggregates every surface and lists preserved notes", async () => {
		// VS Code extension
		mkdirSync(join(tempDir, ".vscode", "extensions", "jolli.jollimemory-vscode-0.99.7"), { recursive: true });
		// IntelliJ plugin
		mkdirSync(join(tempDir, ".local", "share", "JetBrains", "IdeaIC2024.1", "plugins", "jollimemory-intellij"), {
			recursive: true,
		});
		// Global CLI
		const npmRoot = join(tempDir, "lib", "node_modules");
		mkdirSync(join(npmRoot, "@jolli.ai", "cli"), { recursive: true });
		// Global config
		mockGlobalConfigDir = join(tempDir, "globalcfg");
		mkdirSync(mockGlobalConfigDir, { recursive: true });
		// Project config
		const projectDir = join(tempDir, "proj");
		mkdirSync(join(projectDir, ".jolli", "jollimemory"), { recursive: true });
		// Repo hooks
		mockGetStatus.mockResolvedValue({
			gitHookInstalled: true,
			claudeHookInstalled: false,
			geminiHookInstalled: false,
		});

		const inventory = await scanUninstallInventory({
			home: tempDir,
			platform: "linux",
			projectDir,
			npmGlobalRoots: [npmRoot],
		});

		const surfaces = new Set(inventory.items.map((i) => i.surface));
		expect(surfaces).toEqual(
			new Set([
				"vscode-extension",
				"intellij-plugin",
				"cli-global",
				"global-config",
				"project-config",
				"repo-hooks",
			]),
		);
		expect(inventory.preserved.length).toBeGreaterThanOrEqual(2);
		expect(inventory.preserved.join(" ")).toMatch(/orphan branch/i);
	});

	it("falls back to npm root -g and process defaults when options are omitted", async () => {
		mockExecFile.mockResolvedValue({ stdout: "", stderr: "" });

		const inventory = await scanUninstallInventory();

		expect(mockExecFile).toHaveBeenCalledWith("npm", ["root", "-g"], { timeout: 5000 });
		expect(Array.isArray(inventory.items)).toBe(true);
		expect(inventory.preserved).toHaveLength(2);
	});
});
