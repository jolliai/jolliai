/**
 * Tests for ConvertCommand — converts documentation folders to Nextra-compatible structure.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock readline ──────────────────────────────────────────────────────────

const { mockCreateInterface } = vi.hoisted(() => ({
	mockCreateInterface: vi.fn(),
}));

vi.mock("node:readline", () => ({
	createInterface: mockCreateInterface,
}));

function mockPrompt(answer: string): void {
	mockCreateInterface.mockReturnValue({
		question: (_prompt: string, cb: (answer: string) => void) => cb(answer),
		close: vi.fn(),
	});
}

// ─── Mock FrameworkDetector ─────────────────────────────────────────────────

const { mockDetectFramework, mockPromptMigration } = vi.hoisted(() => ({
	mockDetectFramework: vi.fn(),
	mockPromptMigration: vi.fn(),
}));

vi.mock("../site/FrameworkDetector.js", () => ({
	detectFramework: mockDetectFramework,
	promptMigration: mockPromptMigration,
}));

// ─── Mock DocusaurusConverter ───────────────────────────────────────────────

const { mockConvertSidebar, mockExtractFavicon } = vi.hoisted(() => ({
	mockConvertSidebar: vi.fn(),
	mockExtractFavicon: vi.fn(),
}));

vi.mock("../site/DocusaurusConverter.js", () => ({
	convertDocusaurusSidebar: mockConvertSidebar,
	extractFaviconFromConfig: mockExtractFavicon,
}));

// ─── 部分 mock node:fs/promises 用于控制 rename 与 readFile ────────────────────
// 默认转发给真实实现；个别 case 用 mockRejectedValueOnce / mockImplementationOnce
// 触发分支（跨设备、不可读等）

const { mockRename, mockReadFile } = vi.hoisted(() => ({
	mockRename: vi.fn(),
	mockReadFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	mockRename.mockImplementation((src: string, dest: string) => actual.rename(src, dest));
	mockReadFile.mockImplementation((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args));
	return { ...actual, rename: mockRename, readFile: mockReadFile };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-convertcmd-test-"));
}

describe("ConvertCommand", () => {
	let tempDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	const originalIsTTY = process.stdin.isTTY;

	beforeEach(async () => {
		tempDir = await makeTempDir();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// 清掉 hoisted mock 上次 case 累积的调用记录，避免 not.toHaveBeenCalled 误伤
		mockCreateInterface.mockClear();
		mockDetectFramework.mockReset();
		mockPromptMigration.mockReset();
		mockConvertSidebar.mockReset();
		mockExtractFavicon.mockReset();
		// mockRename / mockReadFile 只清调用记录；重新绑定到原始函数实现，
		// 防止上一个 case 的 mockImplementation 泄漏
		mockRename.mockClear();
		mockReadFile.mockClear();
		const fspActual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		mockRename.mockImplementation((src: string, dest: string) => fspActual.rename(src, dest));
		mockReadFile.mockImplementation((...args: Parameters<typeof fspActual.readFile>) =>
			fspActual.readFile(...args),
		);
		mockDetectFramework.mockReturnValue(null);
		mockPromptMigration.mockResolvedValue(false);
		mockConvertSidebar.mockResolvedValue({ sidebar: {}, pathMappings: {} });
		mockExtractFavicon.mockReturnValue(undefined);
		mockPrompt("Test Site");
		process.stdin.isTTY = true;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		process.stdin.isTTY = originalIsTTY;
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	// ── Registration ────────────────────────────────────────────────────────

	it("registers convert command on program", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const program = new Command();

		registerConvertCommand(program);

		const cmd = program.commands.find((c) => c.name() === "convert");
		expect(cmd).toBeDefined();
	});

	// ── Basic conversion ────────────────────────────────────────────────────

	it("converts a folder with markdown files", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "guide.md"), "# Guide\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "index.md"))).toBe(true);
		expect(existsSync(join(outDir, "guide.md"))).toBe(true);
		expect(existsSync(join(outDir, "site.json"))).toBe(true);
	});

	it("writes valid site.json with title from prompt", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		expect(siteJson.title).toBe("Test Site");
		expect(siteJson.description).toContain("Test Site");
	});

	it("uses default title without prompting when stdin is not a TTY", async () => {
		process.stdin.isTTY = undefined as unknown as true;
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "my-docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		expect(siteJson.title).toBe("My Docs");
	});

	it("site.json does not contain pathMappings", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		expect(siteJson.pathMappings).toBeUndefined();
	});

	// ── Error handling ──────────────────────────────────────────────────────

	it("sets exit code 1 when source folder does not exist", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const program = new Command();
		registerConvertCommand(program);

		await program.parseAsync(["node", "test", "convert", join(tempDir, "nonexistent")]);

		expect(process.exitCode).toBe(1);
	});

	// ── In-place conversion ─────────────────────────────────────────────────

	it("creates timestamped backup for in-place conversion", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		// No --output means in-place
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// Check backup was created
		const parentEntries = await readdir(tempDir);
		const backups = parentEntries.filter((e) => e.includes(".backup-"));
		expect(backups.length).toBe(1);
	});

	// ── Framework file skipping ─────────────────────────────────────────────

	it("skips framework config files during conversion", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "package.json"), "{}", "utf-8");
		await writeFile(join(sourceDir, "sidebars.js"), "module.exports = {}", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "package.json"))).toBe(false);
		expect(existsSync(join(outDir, "sidebars.js"))).toBe(false);
	});

	// ── Image files ─────────────────────────────────────────────────────────

	it("copies image files to output", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "logo.png"), "fake-png", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "logo.png"))).toBe(true);
	});

	// ── MDX downgrading ─────────────────────────────────────────────────────

	it("downgrades MDX with incompatible imports to .md", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const mdxContent = "import Tabs from '@theme/Tabs'\n\n# Page\n\nContent here.\n";
		await writeFile(join(sourceDir, "page.mdx"), mdxContent, "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "page.md"))).toBe(true);
		expect(existsSync(join(outDir, "page.mdx"))).toBe(false);
		const output = await readFile(join(outDir, "page.md"), "utf-8");
		expect(output).not.toContain("import");
		expect(output).toContain("Content here.");
	});

	// ── slug: / handling ────────────────────────────────────────────────────

	it("renames file with slug: / to index.md", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "intro.md"), "---\nslug: /\n---\n# Intro\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "index.md"))).toBe(true);
	});

	// ── Nested directories ──────────────────────────────────────────────────

	it("preserves nested directory structure", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(join(sourceDir, "guides"), { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "guides", "intro.md"), "# Intro\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "guides", "intro.md"))).toBe(true);
	});

	// ── Summary output ──────────────────────────────────────────────────────

	it("prints conversion summary", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const output = logSpy.mock.calls.map((c: unknown[]) => (c as string[]).join(" ")).join("\n");
		expect(output).toContain("Converted");
		expect(output).toContain("site.json");
	});

	// ── Cleanup framework files ─────────────────────────────────────────────

	it("removes sidebars.js from output after conversion", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// Note: sidebars.js is skipped by isFrameworkFile during processFile,
		// but cleanupFrameworkFiles also removes it from target if somehow present.
		// The file won't actually be in the output due to isFrameworkFile.
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "sidebars.js"))).toBe(false);
	});

	// ── Docusaurus conversion with sidebar ──────────────────────────────────

	it("includes sidebar in site.json when Docusaurus conversion succeeds", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({
			sidebar: { "/": { intro: "Introduction" } },
			pathMappings: {},
		});

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		expect(siteJson.sidebar).toBeDefined();
		expect(siteJson.sidebar["/"]).toBeDefined();
	});

	// ── OpenAPI files ───────────────────────────────────────────────────────

	it("copies OpenAPI files to output", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		const apiDir = join(sourceDir, "api");
		await mkdir(apiDir, { recursive: true });
		const openapiContent = JSON.stringify({ openapi: "3.1.0", info: { title: "API", version: "1.0" } });
		await writeFile(join(apiDir, "spec.json"), openapiContent, "utf-8");
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "api", "spec.json"))).toBe(true);
	});

	// ── In-place MDX downgrade ──────────────────────────────────────────────

	it("removes original .mdx when downgrading in-place", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const mdxContent = "import Tabs from '@theme/Tabs'\n\n# Page\n\nContent.\n";
		await writeFile(join(sourceDir, "page.mdx"), mdxContent, "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		// In-place conversion (no --output)
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		expect(existsSync(join(sourceDir, "page.md"))).toBe(true);
		expect(existsSync(join(sourceDir, "page.mdx"))).toBe(false);
	});

	// ── Path mapping ────────────────────────────────────────────────────────

	it("rewrites image paths when file is remapped via pathMappings", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({
			sidebar: { "/": { sql: "SQL Reference" }, "/sql": { query: "Query" } },
			pathMappings: { sql: "pipelines/sql" },
		});

		const sourceDir = join(tempDir, "docs");
		await mkdir(join(sourceDir, "sql"), { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "sql", "query.md"), "# Query\n\n![diagram](../img/d.png)\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "pipelines", "sql", "query.md"))).toBe(true);
	});

	// ── Ignored files ───────────────────────────────────────────────────────

	it("does not count ignored files in total", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "notes.txt"), "ignored", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const output = logSpy.mock.calls.map((c: unknown[]) => (c as string[]).join(" ")).join("\n");
		expect(output).toContain("Converted 1 files");
	});

	// ── In-place normal markdown copy ───────────────────────────────────────

	it("leaves in-place markdown files unchanged when path doesn't change", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "guide.md"), "# Guide\n", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		const content = await readFile(join(sourceDir, "guide.md"), "utf-8");
		expect(content).toBe("# Guide\n");
	});

	// ── In-place with .backup skip ──────────────────────────────────────────

	it("skips .backup directories during traversal", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		const backupDir = join(sourceDir, ".backup-old");
		await mkdir(backupDir, { recursive: true });
		await writeFile(join(backupDir, "old.md"), "old content", "utf-8");
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "old.md"))).toBe(false);
	});

	// ── Print moved folders ─────────────────────────────────────────────────

	it("prints moved folders when pathMappings exist", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({
			sidebar: {},
			pathMappings: { sql: "pipelines/sql" },
		});

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const output = logSpy.mock.calls.map((c: unknown[]) => (c as string[]).join(" ")).join("\n");
		expect(output).toContain("Moved");
		expect(output).toContain("sql → pipelines/sql");
	});

	// ── Favicon handling ────────────────────────────────────────────────────

	it("copies favicon when conversion provides one", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const faviconPath = join(tempDir, "static", "img", "favicon.ico");
		await mkdir(join(tempDir, "static", "img"), { recursive: true });
		await writeFile(faviconPath, "favicon-data", "utf-8");

		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({
			sidebar: {},
			pathMappings: {},
		});
		mockExtractFavicon.mockReturnValue(faviconPath);

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "favicon.ico"))).toBe(true);
		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		expect(siteJson.favicon).toBe("favicon.ico");
	});

	// ── Read errors during conversion ───────────────────────────────────────

	it("skips files that cannot be read for classification", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const { chmod } = await import("node:fs/promises");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const yamlPath = join(sourceDir, "spec.yaml");
		await writeFile(yamlPath, "openapi: 3.0.0\ninfo:\n  title: T", "utf-8");
		await chmod(yamlPath, 0o000);
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		await chmod(yamlPath, 0o644);
		// Should complete without error
		expect(existsSync(join(outDir, "index.md"))).toBe(true);
	});

	// ── Cleanup: removes sidebars.js from output ────────────────────────────

	it("removes sidebars.js that ends up in the output directory", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");
		await mkdir(outDir, { recursive: true });
		// Pre-create a sidebars.js in the output (as if it leaked through)
		await writeFile(join(outDir, "sidebars.js"), "module.exports = {}", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "sidebars.js"))).toBe(false);
	});

	it("removes sidebars.ts from output if present", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");
		await mkdir(outDir, { recursive: true });
		await writeFile(join(outDir, "sidebars.ts"), "export default {}", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "sidebars.ts"))).toBe(false);
	});

	// ── In-place: src === dest path ─────────────────────────────────────────

	it("handles in-place conversion where source equals dest", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(join(sourceDir, "guides"), { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "guides", "intro.md"), "# Intro\n", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// Files should still be in place
		expect(existsSync(join(sourceDir, "index.md"))).toBe(true);
		expect(existsSync(join(sourceDir, "guides", "intro.md"))).toBe(true);
	});

	// ── 错误捕获：convertFolder 抛错时设置 exitCode=1（覆盖 55-56 行）────────

	it("捕获 convertFolder 抛出的错误并设置 exit code 为 1", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		// 让 sidebar 转换抛错，触发 action 的 catch 分支
		mockConvertSidebar.mockRejectedValue(new Error("sidebar conversion failed"));

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(process.exitCode).toBe(1);
	});

	// ── slug:/ + sidebar 键重写（覆盖 130-132 行）──────────────────────────

	it("当 slug:/ 文件被重命名为 index 时同步重写 sidebar 键", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		// sidebar 里有 intro 这个键，对应那个 slug:/ 文件
		mockConvertSidebar.mockResolvedValue({
			sidebar: { "/": { intro: "Introduction", guides: "Guides" } },
			pathMappings: {},
		});

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "intro.md"), "---\nslug: /\n---\n# Intro\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		// 原来的 intro 键应该被替换为 index，且标签仍是 "Introduction"
		expect(siteJson.sidebar["/"].intro).toBeUndefined();
		expect(siteJson.sidebar["/"].index).toBe("Introduction");
	});

	// ── readdir 失败时静默返回（覆盖 183 行）────────────────────────────────

	it("当 source 路径不是目录时安静返回不抛错", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		// 把 source 指向一个文件而不是目录：readdir 会抛错
		const sourceFile = join(tempDir, "not-a-dir.md");
		await writeFile(sourceFile, "# Not a directory\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceFile, "--output", outDir]);

		// 不应抛错；site.json 仍然被写到 outDir（mkdir 已建立）
		expect(existsSync(join(outDir, "site.json"))).toBe(true);
	});

	// ── stat 失败时跳过单个 entry（覆盖 194 行）────────────────────────────

	it("跳过 stat 失败的 entry（例如 broken symlink）", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const { symlink } = await import("node:fs/promises");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// 建一个指向不存在路径的 symlink；stat（非 lstat）会失败
		await symlink(join(tempDir, "does-not-exist"), join(sourceDir, "broken-link.md"));
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// 正常文件仍应成功转换
		expect(existsSync(join(outDir, "index.md"))).toBe(true);
	});

	// ── .mdx readFile 失败时跳过（覆盖 243 行）─────────────────────────────

	it("跳过无法读取的 .mdx 文件", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const { chmod } = await import("node:fs/promises");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const mdxPath = join(sourceDir, "page.mdx");
		await writeFile(mdxPath, "import X from 'whatever'\n# X\n", "utf-8");
		// 把 mdx 文件设为不可读，readFile 会失败
		await chmod(mdxPath, 0o000);
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// 恢复权限以便 afterEach 能清理
		await chmod(mdxPath, 0o644);
		// 普通文件仍应成功
		expect(existsSync(join(outDir, "index.md"))).toBe(true);
		// 由于 readFile 失败提前 return，page.md 不应存在
		expect(existsSync(join(outDir, "page.md"))).toBe(false);
	});

	// ── promptMigration=true 但 framework 不是 docusaurus（覆盖 76 行的 else 分支）

	it("detect 到非 docusaurus 框架时不调用 sidebar 转换", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		// 用户同意迁移但 framework 不满足 docusaurus 条件
		mockDetectFramework.mockReturnValue({
			name: "mkdocs",
			configPath: join(tempDir, "mkdocs.yml"),
			// 故意不提供 sidebarPath
		});
		mockPromptMigration.mockResolvedValue(true);

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// 没有调用 convertDocusaurusSidebar，但仍然成功完成转换
		expect(mockConvertSidebar).not.toHaveBeenCalled();
		expect(existsSync(join(outDir, "site.json"))).toBe(true);
	});

	// ── favicon 配置存在但路径不存在（覆盖 120 行的 else 分支）─────────────

	it("conversion.favicon 路径不存在时跳过拷贝", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({ sidebar: {}, pathMappings: {} });
		// favicon 指向一个不存在的文件
		mockExtractFavicon.mockReturnValue(join(tempDir, "missing-favicon.ico"));

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// favicon 没有被拷贝过去，但 site.json 中仍记录 favicon 字段
		expect(existsSync(join(outDir, "favicon.ico"))).toBe(false);
		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		expect(siteJson.favicon).toBe("favicon.ico");
	});

	// ── .mdx 但 imports 全部安全（覆盖 hasIncompatibleImports 的 else 分支）

	it("imports 全部为安全前缀的 .mdx 文件按原样拷贝不降级", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// 只引用 nextra（在安全前缀列表里）
		const mdxContent = "import { Callout } from 'nextra/components'\n\n# Safe\n";
		await writeFile(join(sourceDir, "safe.mdx"), mdxContent, "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// 因为不需要降级，.mdx 仍然是 .mdx
		expect(existsSync(join(outDir, "safe.mdx"))).toBe(true);
		expect(existsSync(join(outDir, "safe.md"))).toBe(false);
	});

	// ── .mdx 同时含 unsafe 与 safe imports，strip 后保留为 .mdx（覆盖 downgraded=false 分支）

	it("strip 后保留 safe JSX 时维持 .mdx 后缀不降级", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// 同时含 unsafe（@theme/Tabs）和 safe（nextra/components）import
		// 触发 hasIncompatibleImports=true，但 strip 后 nextra 的 import 仍保留
		const mdxContent =
			"import Tabs from '@theme/Tabs'\nimport { Callout } from 'nextra/components'\n\n# Mixed\n\n<Callout>safe</Callout>\n";
		await writeFile(join(sourceDir, "mixed.mdx"), mdxContent, "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// downgraded=false 时保留 .mdx 后缀
		expect(existsSync(join(outDir, "mixed.mdx"))).toBe(true);
		expect(existsSync(join(outDir, "mixed.md"))).toBe(false);
	});

	// ── in-place + pathMappings 让 .md 路径变化（覆盖 281 行的 if 分支）─────

	it("in-place 时若 pathMappings 改变了 markdown 路径，删除原文件", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({
			sidebar: {},
			pathMappings: { sql: "pipelines/sql" },
		});

		const sourceDir = join(tempDir, "docs");
		await mkdir(join(sourceDir, "sql"), { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "sql", "query.md"), "# Query\n", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		// in-place 模式（无 --output）
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// 新路径有文件，旧路径被清理掉
		expect(existsSync(join(sourceDir, "pipelines", "sql", "query.md"))).toBe(true);
		expect(existsSync(join(sourceDir, "sql", "query.md"))).toBe(false);
	});

	// ── in-place + 无 pathMappings + image：safeCopyOrMove 走 src===dest 早返回

	it("in-place 模式下 image 文件路径不变时跳过 rename", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "logo.png"), "fake-png", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		// in-place + 默认 pathMappings 为空 → src === dest，safeCopyOrMove 早返回
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// 文件原地保留
		expect(existsSync(join(sourceDir, "logo.png"))).toBe(true);
	});

	// ── 不传 source 参数时回退到 process.cwd()（覆盖 42 行 ?? 右侧分支）────────

	it("未传 source 参数时使用 process.cwd() 作为源目录", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");
		// 临时把 cwd 改成 sourceDir，模拟用户在源目录下运行 jolli convert
		const originalCwd = process.cwd();
		process.chdir(sourceDir);

		try {
			const program = new Command();
			registerConvertCommand(program);
			// 不传 source 参数；source 由 process.cwd() 决定
			await program.parseAsync(["node", "test", "convert", "--output", outDir]);
			expect(existsSync(join(outDir, "site.json"))).toBe(true);
			expect(existsSync(join(outDir, "index.md"))).toBe(true);
		} finally {
			process.chdir(originalCwd);
		}
	});

	// ── catch 非 Error 异常时用 String(err) 转换（覆盖 55 行三元右侧）─────────

	it("捕获非 Error 抛出对象时使用 String(err) 设置 exit code", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		// 抛出非 Error 实例，强制走 String(err) 分支
		mockConvertSidebar.mockRejectedValue("not-an-error-string");

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(process.exitCode).toBe(1);
	});

	// ── targetRoot === process.cwd() 时打印的 dev 命令不带路径（覆盖 166 行三元右侧）

	it("当 targetRoot 等于 process.cwd() 时摘要里不显示目录后缀", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// 把 cwd 切到 sourceDir，让 in-place 时 targetRoot === process.cwd()
		const originalCwd = process.cwd();
		process.chdir(sourceDir);

		try {
			const program = new Command();
			registerConvertCommand(program);
			// in-place（无 --output），且 source 是 cwd
			await program.parseAsync(["node", "test", "convert"]);

			const output = logSpy.mock.calls.map((c: unknown[]) => (c as string[]).join(" ")).join("\n");
			// 提示是 "Run `jolli dev`"，不带目录
			expect(output).toContain("Run `jolli dev`");
		} finally {
			process.chdir(originalCwd);
		}
	});

	// ── stat 成功但不是 dir 也不是 file（覆盖 199 行 if 假分支）──────────────

	it("跳过既不是目录也不是文件的特殊条目（FIFO）", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const { execFileSync } = await import("node:child_process");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// 用 mkfifo 创建一个命名管道：stat 不抛错，但 isFile/isDirectory 都为 false
		const fifoPath = join(sourceDir, "pipe.fifo");
		execFileSync("mkfifo", [fifoPath]);
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// 正常文件仍应成功转换；FIFO 被静默跳过
		expect(existsSync(join(outDir, "index.md"))).toBe(true);
		expect(existsSync(join(outDir, "pipe.fifo"))).toBe(false);
	});

	// ── 用户在 prompt 输入空字符串时回退到 defaultTitle（覆盖 307 行 || 右侧）

	it("交互输入空字符串时使用默认标题", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		// 模拟用户回车（输入空字符串）
		mockPrompt("   ");
		const sourceDir = join(tempDir, "my-docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		// trim 后为空 → 用 defaultTitle "My Docs"
		expect(siteJson.title).toBe("My Docs");
	});

	// ── in-place + pathMappings + markdown readFile 失败（覆盖 276-277 行）────

	it("in-place 模式 markdown 因 readFile 失败时回退到 safeCopyOrMove", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({
			sidebar: {},
			pathMappings: { sql: "pipelines/sql" },
		});

		const sourceDir = join(tempDir, "docs");
		await mkdir(join(sourceDir, "sql"), { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const targetMd = join(sourceDir, "sql", "query.md");
		await writeFile(targetMd, "# Query\n", "utf-8");
		// 仅让对 query.md 的 readFile 抛 EACCES，其他文件正常 forward；
		// 用 chmod 会让前置的 cp backup 一起失败，必须用 mock 精确拦截
		const fspActual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		mockReadFile.mockImplementation(async (path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string" && path === targetMd) {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			}
			return fspActual.readFile(path as Parameters<typeof fspActual.readFile>[0], ...(rest as [])) as unknown as
				| string
				| Buffer;
		});

		const program = new Command();
		registerConvertCommand(program);
		// in-place 模式，让 catch 走 safeCopyOrMove
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// 文件应被 safeCopyOrMove 搬到新路径，且原位置已被删除
		expect(existsSync(join(sourceDir, "pipelines", "sql", "query.md"))).toBe(true);
		expect(existsSync(targetMd)).toBe(false);
	});

	// ── in-place + image + pathMappings：rename 成功（覆盖 safeCopyOrMove inPlace 分支 try）

	it("in-place 模式 image 通过 pathMappings 重定位时使用 rename", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({
			sidebar: {},
			pathMappings: { img: "assets/img" },
		});

		const sourceDir = join(tempDir, "docs");
		await mkdir(join(sourceDir, "img"), { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "img", "logo.png"), "png-data", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		// in-place 模式 → safeCopyOrMove 走 inPlace=true 分支的 rename
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// rename 成功，新路径存在，旧路径消失
		expect(existsSync(join(sourceDir, "assets", "img", "logo.png"))).toBe(true);
		expect(existsSync(join(sourceDir, "img", "logo.png"))).toBe(false);
	});

	// ── in-place + image + rename 抛错：走跨设备 fallback（覆盖 319-321 catch 分支）

	it("in-place 模式 rename 抛错时回退到 copyFile + safeRemove", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({
			sidebar: {},
			pathMappings: { img: "assets/img" },
		});
		// 让 rename 抛 EXDEV，模拟跨设备情况
		mockRename.mockRejectedValueOnce(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));

		const sourceDir = join(tempDir, "docs");
		await mkdir(join(sourceDir, "img"), { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "img", "logo.png"), "png-data", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// fallback：copyFile 写到新路径，safeRemove 删掉旧路径
		expect(existsSync(join(sourceDir, "assets", "img", "logo.png"))).toBe(true);
		expect(existsSync(join(sourceDir, "img", "logo.png"))).toBe(false);
	});
});
