/**
 * Standalone test file covering two branches that need precise control over
 * fs behavior to hit:
 *
 * 1. The cross-device fallback in `safeCopyOrMove` where `rename` fails and
 *    we fall back to `copyFile + safeRemove` (ConvertCommand.ts lines 316-321).
 * 2. The fallback in `processFile` where the normal copy/move stage's
 *    `readFile` fails and we return after `safeCopyOrMove`
 *    (the return statement at ConvertCommand.ts lines 276-277).
 *
 * Both paths are hard to reproduce against a real filesystem: one needs a
 * cross-device link, and the other needs `readFile` to fail while `copyFile`
 * still succeeds (chmod 000 breaks both at once). The most reliable approach
 * is to mock `node:fs/promises`, injecting failure into specific calls while
 * leaving the rest as the real implementation so setup keeps working.
 *
 * This lives in a separate file because `vi.mock("node:fs/promises")` is a
 * module-level mock and would contaminate the many fs operations used in the
 * main test suite.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock readline to avoid prompt blocking ─────────────────────────────────

const { mockCreateInterface } = vi.hoisted(() => ({
	mockCreateInterface: vi.fn(),
}));

vi.mock("node:readline", () => ({
	createInterface: mockCreateInterface,
}));

// ─── mock FrameworkDetector / DocusaurusConverter ───────────────────────────

const { mockDetectFramework, mockPromptMigration } = vi.hoisted(() => ({
	mockDetectFramework: vi.fn(),
	mockPromptMigration: vi.fn(),
}));

vi.mock("../site/FrameworkDetector.js", () => ({
	detectFramework: mockDetectFramework,
	promptMigration: mockPromptMigration,
}));

const { mockConvertSidebar, mockExtractFavicon } = vi.hoisted(() => ({
	mockConvertSidebar: vi.fn(),
	mockExtractFavicon: vi.fn(),
}));

vi.mock("../site/DocusaurusConverter.js", () => ({
	convertDocusaurusSidebar: mockConvertSidebar,
	extractFaviconFromConfig: mockExtractFavicon,
}));

// ─── key mock: the first rename call throws, the rest keep the original impl

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		rename: vi.fn(original.rename),
		readFile: vi.fn(original.readFile),
	};
});

describe("safeCopyOrMove falls back to copyFile + safeRemove when rename fails", () => {
	let tempDir: string;
	const originalIsTTY = process.stdin.isTTY;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "jolli-convert-renamefail-"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		// pathMappings remaps sql/ to pipelines/sql/, which triggers a file move
		mockConvertSidebar.mockResolvedValue({
			sidebar: {},
			pathMappings: { sql: "pipelines/sql" },
		});
		mockExtractFavicon.mockReturnValue(undefined);
		mockCreateInterface.mockReturnValue({
			question: (_p: string, cb: (answer: string) => void) => cb("Site"),
			close: vi.fn(),
		});
		process.stdin.isTTY = true;
		vi.mocked(realFsPromises.rename).mockClear();
		vi.mocked(realFsPromises.readFile).mockClear();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		process.stdin.isTTY = originalIsTTY;
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("uses copyFile + safeRemove to complete the move when rename throws", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		mkdirSync(join(sourceDir, "sql"), { recursive: true });
		await realFsPromises.writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// image files go through safeCopyOrMove; pathMappings moves this one to pipelines/sql/
		const imgSrc = join(sourceDir, "sql", "diagram.png");
		await realFsPromises.writeFile(imgSrc, "fake-png", "utf-8");

		// Make the first rename fail (simulating a cross-device EXDEV); other calls
		// use the real implementation — this exercises the fallback branch without
		// breaking the subsequent backup / index.md rename logic.
		const renameMock = vi.mocked(realFsPromises.rename);
		let triggered = false;
		renameMock.mockImplementation(async (src, dest) => {
			const srcStr = src.toString();
			if (!triggered && srcStr.endsWith("diagram.png")) {
				triggered = true;
				const err = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
				err.code = "EXDEV";
				throw err;
			}
			// fall through to the real implementation
			const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return original.rename(src, dest);
		});

		const program = new Command();
		registerConvertCommand(program);
		// only in-place mode (no --output) exercises the rename branch
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// rename was triggered and failed, so we fell back to copyFile + safeRemove;
		// diagram.png should end up in pipelines/sql/ and disappear from its original spot.
		expect(triggered).toBe(true);
		expect(existsSync(join(sourceDir, "pipelines", "sql", "diagram.png"))).toBe(true);
		expect(existsSync(imgSrc)).toBe(false);
	});

	// ── readFile fails but safeCopyOrMove succeeds (covers the return at lines 276-277)

	it("falls back to safeCopyOrMove and returns when markdown readFile fails in normal copy/move", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		mkdirSync(join(sourceDir, "sql"), { recursive: true });
		await realFsPromises.writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// pathMappings remaps this file path to pipelines/sql/query.md
		const targetMd = join(sourceDir, "sql", "query.md");
		await realFsPromises.writeFile(targetMd, "# Query\n", "utf-8");

		// Make readFile throw for query.md while keeping copyFile working.
		const readFileMock = vi.mocked(realFsPromises.readFile);
		const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		readFileMock.mockImplementation(async (path, options) => {
			const pathStr = path.toString();
			if (pathStr.endsWith("sql/query.md")) {
				const err = new Error("simulated EACCES") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return original.readFile(path, options);
		});

		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// safeCopyOrMove moved the file via copyFile; no content rewrite but the file exists
		expect(existsSync(join(outDir, "pipelines", "sql", "query.md"))).toBe(true);
	});
});
