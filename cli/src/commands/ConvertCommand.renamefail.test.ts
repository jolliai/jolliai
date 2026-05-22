/**
 * 单独的测试文件，覆盖两条需要精确控制 fs 行为才能命中的路径：
 *
 * 1. `safeCopyOrMove` 中 `rename` 失败时回退到 `copyFile + safeRemove` 的
 *    跨设备分支（ConvertCommand.ts 316-321 行）。
 * 2. `processFile` 中 normal copy/move 阶段 `readFile` 失败时回退到
 *    `safeCopyOrMove` 后的 return（ConvertCommand.ts 276-277 行的 return 语句）。
 *
 * 这两条路径在真实文件系统下都很难凑出来：要么需要跨设备链接，要么需要让
 * `readFile` 失败但 `copyFile` 成功（chmod 000 会同时打挂这两者）。最稳的
 * 办法是 mock `node:fs/promises`，对特定调用注入失败，其他保持原实现以
 * 保证 setup 仍然正常工作。
 *
 * 单独放一个文件，是因为 `vi.mock("node:fs/promises")` 是模块级 mock，
 * 会污染主测试套件里大量的 fs 操作。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock readline，避免 prompt 阻塞 ────────────────────────────────────────

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

// ─── 关键 mock：rename 第一次调用抛错，其他保持原始实现 ─────────────────────

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		rename: vi.fn(original.rename),
		readFile: vi.fn(original.readFile),
	};
});

describe("safeCopyOrMove rename 失败时回退到 copyFile + safeRemove", () => {
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
		// 让 pathMappings 把 sql/ 重映射到 pipelines/sql/，触发文件移动
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

	it("rename 抛错时改用 copyFile + safeRemove 完成文件迁移", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		mkdirSync(join(sourceDir, "sql"), { recursive: true });
		await realFsPromises.writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// image 文件会走 safeCopyOrMove；pathMappings 会把它移到 pipelines/sql/
		const imgSrc = join(sourceDir, "sql", "diagram.png");
		await realFsPromises.writeFile(imgSrc, "fake-png", "utf-8");

		// 让 rename 第一次失败（模拟跨设备 EXDEV），其它调用走原实现
		// — 这样既能进入回退分支，又不影响后续 backup / index.md rename 等逻辑
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
			// 走原实现
			const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
			return original.rename(src, dest);
		});

		const program = new Command();
		registerConvertCommand(program);
		// in-place 模式（无 --output）才会走 rename 分支
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// rename 确实被触发并失败，回退到 copyFile + safeRemove；
		// 最终 diagram.png 应该出现在 pipelines/sql/ 下，原位置消失
		expect(triggered).toBe(true);
		expect(existsSync(join(sourceDir, "pipelines", "sql", "diagram.png"))).toBe(true);
		expect(existsSync(imgSrc)).toBe(false);
	});

	// ── readFile 失败但 safeCopyOrMove 成功（覆盖 276-277 行的 return）

	it("normal copy/move 中 markdown readFile 失败时改用 safeCopyOrMove 后返回", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		mkdirSync(join(sourceDir, "sql"), { recursive: true });
		await realFsPromises.writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// 这个文件路径会被 pathMappings 重映射到 pipelines/sql/query.md
		const targetMd = join(sourceDir, "sql", "query.md");
		await realFsPromises.writeFile(targetMd, "# Query\n", "utf-8");

		// 让对 query.md 的 readFile 抛错，但 copyFile 仍能正常工作
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

		// safeCopyOrMove 用 copyFile 把文件搬过去了，没有内容重写但文件存在
		expect(existsSync(join(outDir, "pipelines", "sql", "query.md"))).toBe(true);
	});
});
