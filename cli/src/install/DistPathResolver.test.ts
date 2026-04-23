import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	compareSemver,
	deriveSourceTag,
	migrateLegacyDistPath,
	pickBestDistPath,
	readDistPathInfo,
	resolveDistPath,
	traverseDistPaths,
} from "./DistPathResolver.js";

// Mock DistPathWriter.installDistPath to capture writes from migrateLegacyDistPath.
// DistPathResolver imports installDistPath from DistPathWriter, so mocking the
// writer module intercepts the call cleanly without same-module ESM limitations.
const mockInstallDistPath = vi.fn().mockResolvedValue(true);
vi.mock("./DistPathWriter.js", () => ({
	installDistPath: (...args: unknown[]) => mockInstallDistPath(...args),
}));

// Mock homedir() so migrateLegacyDistPath reads from our temp dir.
const mockHomedir = vi.fn();
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => mockHomedir() };
});

vi.stubGlobal("__PKG_VERSION__", "1.0.0");

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});

describe("DistPathResolver", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "jm-resolver-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ── readDistPathInfo ─────────────────────────────────────────────────

	describe("readDistPathInfo", () => {
		it("should parse legacy format with version", async () => {
			const file = join(tempDir, "dist-path");
			await writeFile(file, "source=cli@1.2.3\n/path/to/dist", "utf-8");

			const info = readDistPathInfo(file);
			expect(info).toEqual({
				source: "cli",
				version: "1.2.3",
				distDir: "/path/to/dist",
			});
		});

		it("should parse legacy format without version", async () => {
			const file = join(tempDir, "dist-path");
			await writeFile(file, "source=vscode-extension\n/old/path/to/dist", "utf-8");

			const info = readDistPathInfo(file);
			expect(info).toEqual({
				source: "vscode-extension",
				version: "unknown",
				distDir: "/old/path/to/dist",
			});
		});

		it("should parse new 2-line format (no source= prefix)", async () => {
			const file = join(tempDir, "dist-paths", "vscode");
			await mkdir(join(tempDir, "dist-paths"), { recursive: true });
			await writeFile(file, "0.97.5\n/some/dist", "utf-8");

			const info = readDistPathInfo(file);
			// source comes from filename in this format, so reader returns ""
			expect(info).toEqual({
				source: "",
				version: "0.97.5",
				distDir: "/some/dist",
			});
		});

		it("should return null for non-existent file", () => {
			expect(readDistPathInfo(join(tempDir, "nonexistent"))).toBeNull();
		});

		it("should return null for empty file", async () => {
			const file = join(tempDir, "dist-path");
			await writeFile(file, "", "utf-8");
			expect(readDistPathInfo(file)).toBeNull();
		});

		it("should return null for single-line file", async () => {
			const file = join(tempDir, "dist-path");
			await writeFile(file, "source=cli@1.0.0", "utf-8");
			expect(readDistPathInfo(file)).toBeNull();
		});

		it("should return null when last line is whitespace-only (empty distDir)", async () => {
			const file = join(tempDir, "dist-path");
			// After trim on each line, the second line becomes "" (falsy)
			await writeFile(file, "1.0.0\n  ", "utf-8");
			expect(readDistPathInfo(file)).toBeNull();
		});

		it("should handle Windows-style line endings", async () => {
			const file = join(tempDir, "dist-path");
			await writeFile(file, "source=cli@2.0.0\r\n/path/to/dist\r\n", "utf-8");

			const info = readDistPathInfo(file);
			expect(info?.source).toBe("cli");
			expect(info?.version).toBe("2.0.0");
		});
	});

	// ── compareSemver ───────────────────────────────────────────────────

	describe("compareSemver", () => {
		it("should return positive when a > b", () => {
			expect(compareSemver("1.1.0", "1.0.0")).toBeGreaterThan(0);
		});

		it("should return negative when a < b", () => {
			expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
		});

		it("should return 0 when equal", () => {
			expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
		});

		it("should treat 'unknown' as lowest version", () => {
			expect(compareSemver("0.0.1", "unknown")).toBeGreaterThan(0);
			expect(compareSemver("unknown", "0.0.1")).toBeLessThan(0);
		});

		it("should treat 'dev' as lowest version", () => {
			expect(compareSemver("0.0.1", "dev")).toBeGreaterThan(0);
			expect(compareSemver("dev", "0.0.1")).toBeLessThan(0);
		});

		it("should return 0 when both are invalid", () => {
			expect(compareSemver("unknown", "dev")).toBe(0);
		});

		it("should fill missing parts with 0", () => {
			expect(compareSemver("1.0", "1.0.0")).toBe(0);
			expect(compareSemver("1.0.1", "1.0")).toBeGreaterThan(0);
			expect(compareSemver("1.0", "1.0.1")).toBeLessThan(0);
		});
	});

	// ── deriveSourceTag ──────────────────────────────────────────────────

	describe("deriveSourceTag", () => {
		it("should return 'vscode' for ~/.vscode/extensions/ paths", () => {
			expect(deriveSourceTag("/Users/x/.vscode/extensions/jolli.foo/dist")).toBe("vscode");
		});

		it("should return 'cursor' for ~/.cursor/extensions/ paths", () => {
			expect(deriveSourceTag("/Users/x/.cursor/extensions/jolli.foo/dist")).toBe("cursor");
		});

		it("should return 'windsurf' for ~/.windsurf/extensions/ paths", () => {
			expect(deriveSourceTag("/Users/x/.windsurf/extensions/jolli.foo/dist")).toBe("windsurf");
		});

		it("should return 'antigravity' for ~/.antigravity/extensions/ paths", () => {
			expect(deriveSourceTag("/Users/x/.antigravity/extensions/jolli.foo/dist")).toBe("antigravity");
		});

		it("should return 'vscodium' for .vscode-oss paths (before .vscode match)", () => {
			expect(deriveSourceTag("/Users/x/.vscode-oss/extensions/jolli.foo/dist")).toBe("vscodium");
		});

		it("should auto-extract IDE name from non-whitelisted ~/.<name>/extensions/ paths", () => {
			expect(deriveSourceTag("/Users/x/.newide/extensions/jolli.foo/dist")).toBe("newide");
		});

		it("should fall back to a hex hash for non-standard paths", () => {
			const tag = deriveSourceTag("/opt/custom/jollimemory/dist");
			expect(tag).toMatch(/^[a-f0-9]{8}$/);
		});

		it("should normalize Windows-style backslash paths", () => {
			expect(deriveSourceTag("C:\\Users\\x\\.cursor\\extensions\\jolli.foo\\dist")).toBe("cursor");
		});
	});

	// ── traverseDistPaths ────────────────────────────────────────────────

	describe("traverseDistPaths", () => {
		it("should return [] when dist-paths/ directory does not exist", () => {
			expect(traverseDistPaths(tempDir)).toEqual([]);
		});

		it("should enumerate per-source files with availability flag", async () => {
			const distPaths = join(tempDir, "dist-paths");
			await mkdir(distPaths, { recursive: true });

			// Available source: dist dir exists
			const cliDist = join(tempDir, "cli-dist");
			await mkdir(cliDist, { recursive: true });
			await writeFile(join(distPaths, "cli"), `0.97.5\n${cliDist}`, "utf-8");

			// Unavailable source: dist dir is missing
			await writeFile(join(distPaths, "cursor"), "0.96.0\n/nonexistent/path", "utf-8");

			const entries = traverseDistPaths(tempDir);
			expect(entries).toHaveLength(2);
			const cli = entries.find((e) => e.source === "cli");
			const cursor = entries.find((e) => e.source === "cursor");
			expect(cli).toEqual({ source: "cli", version: "0.97.5", distDir: cliDist, available: true });
			expect(cursor).toEqual({
				source: "cursor",
				version: "0.96.0",
				distDir: "/nonexistent/path",
				available: false,
			});
		});

		it("should skip unparseable files", async () => {
			const distPaths = join(tempDir, "dist-paths");
			await mkdir(distPaths, { recursive: true });
			await writeFile(join(distPaths, "broken"), "single-line", "utf-8");

			expect(traverseDistPaths(tempDir)).toEqual([]);
		});
	});

	// ── pickBestDistPath ─────────────────────────────────────────────────

	describe("pickBestDistPath", () => {
		it("should return undefined when list is empty", () => {
			expect(pickBestDistPath([])).toBeUndefined();
		});

		it("should return undefined when no entries are available", () => {
			expect(
				pickBestDistPath([{ source: "cli", version: "1.0.0", distDir: "/x", available: false }]),
			).toBeUndefined();
		});

		it("should pick the highest version among available entries", () => {
			const best = pickBestDistPath([
				{ source: "cli", version: "0.97.5", distDir: "/a", available: true },
				{ source: "vscode", version: "0.98.0", distDir: "/b", available: true },
				{ source: "cursor", version: "0.96.0", distDir: "/c", available: true },
			]);
			expect(best?.source).toBe("vscode");
		});

		it("should ignore unavailable higher-version entries", () => {
			const best = pickBestDistPath([
				{ source: "cli", version: "0.97.5", distDir: "/a", available: true },
				{ source: "vscode", version: "0.98.0", distDir: "/b", available: false },
			]);
			expect(best?.source).toBe("cli");
		});
	});

	// ── resolveDistPath (simplified shim) ────────────────────────────────

	describe("resolveDistPath", () => {
		it("should return caller info without candidate collection", async () => {
			const result = await resolveDistPath(tempDir, "/some/dist", "cli");
			expect(result).toEqual({
				distDir: "/some/dist",
				version: "1.0.0",
				source: "cli",
			});
		});
	});

	// ── migrateLegacyDistPath ────────────────────────────────────────────

	describe("migrateLegacyDistPath", () => {
		beforeEach(() => {
			mockInstallDistPath.mockClear();
			mockHomedir.mockReturnValue(tempDir);
		});

		it("should return false when no legacy dist-path file exists", async () => {
			const migrated = await migrateLegacyDistPath();
			expect(migrated).toBe(false);
			expect(mockInstallDistPath).not.toHaveBeenCalled();
		});

		it("should migrate cli source as-is", async () => {
			const dir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "dist-path"), "source=cli@0.97.5\n/usr/local/lib/cli/dist", "utf-8");

			const migrated = await migrateLegacyDistPath();
			expect(migrated).toBe(true);
			expect(mockInstallDistPath).toHaveBeenCalledWith("cli", "/usr/local/lib/cli/dist", "0.97.5");
		});

		it("should derive vscode tag from path for vscode-extension source", async () => {
			const dir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "dist-path"),
				"source=vscode-extension@0.97.3\n/Users/x/.vscode/extensions/jolli.foo/dist",
				"utf-8",
			);

			const migrated = await migrateLegacyDistPath();
			expect(migrated).toBe(true);
			expect(mockInstallDistPath).toHaveBeenCalledWith(
				"vscode",
				"/Users/x/.vscode/extensions/jolli.foo/dist",
				"0.97.3",
			);
		});

		it("should derive cursor tag for ~/.cursor/ paths", async () => {
			const dir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "dist-path"),
				"source=vscode-extension@0.96.0\n/Users/x/.cursor/extensions/jolli.foo/dist",
				"utf-8",
			);

			await migrateLegacyDistPath();
			expect(mockInstallDistPath).toHaveBeenCalledWith(
				"cursor",
				"/Users/x/.cursor/extensions/jolli.foo/dist",
				"0.96.0",
			);
		});

		it("should fall back to vscode tag when path cannot be IDE-classified (hash result)", async () => {
			const dir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "dist-path"),
				"source=vscode-extension@0.95.0\n/opt/custom/jollimemory/dist",
				"utf-8",
			);

			await migrateLegacyDistPath();
			// deriveSourceTag returns a hash for non-IDE paths; migrateLegacyDistPath
			// falls back to "vscode" (most likely origin for vscode-extension).
			expect(mockInstallDistPath).toHaveBeenCalledWith("vscode", "/opt/custom/jollimemory/dist", "0.95.0");
		});

		it("should never write dist-paths/vscode-extension (fallback maps it to vscode)", async () => {
			// If deriveSourceTag somehow returned "vscode-extension" (it can't, but defensively),
			// the migration must still avoid creating a `vscode-extension` bucket.
			const dir = join(tempDir, ".jolli", "jollimemory");
			await mkdir(dir, { recursive: true });
			// `.vscode/` in the path → derive returns "vscode", never "vscode-extension"
			await writeFile(
				join(dir, "dist-path"),
				"source=vscode-extension@0.97.3\n/Users/x/.vscode/extensions/foo/dist",
				"utf-8",
			);

			await migrateLegacyDistPath();
			const callTag = mockInstallDistPath.mock.calls[0][0];
			expect(callTag).not.toBe("vscode-extension");
		});

		it("should delete the legacy dist-path file after successful migration", async () => {
			const { existsSync } = await import("node:fs");
			const dir = join(tempDir, ".jolli", "jollimemory");
			const legacyPath = join(dir, "dist-path");
			await mkdir(dir, { recursive: true });
			await writeFile(legacyPath, "source=cli@0.97.5\n/usr/local/lib/cli/dist", "utf-8");

			expect(existsSync(legacyPath)).toBe(true);
			await migrateLegacyDistPath();
			expect(existsSync(legacyPath)).toBe(false);

			// A second call finds no legacy file and is a no-op.
			mockInstallDistPath.mockClear();
			const secondMigration = await migrateLegacyDistPath();
			expect(secondMigration).toBe(false);
			expect(mockInstallDistPath).not.toHaveBeenCalled();
		});
	});
});
