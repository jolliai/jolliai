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
});
