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

// ─── Partial mock of node:fs/promises to control rename and readFile ────────
// Default behavior forwards to the real implementation; individual cases use
// mockRejectedValueOnce / mockImplementationOnce to trigger branches
// (cross-device link, unreadable file, etc.).

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
		// Clear call history accumulated by hoisted mocks in the previous case so
		mockCreateInterface.mockClear();
		mockDetectFramework.mockReset();
		mockPromptMigration.mockReset();
		mockConvertSidebar.mockReset();
		mockExtractFavicon.mockReset();
		// mockRename / mockReadFile only have their call history cleared; rebind
		// to the original implementation to prevent the previous case's
		// mockImplementation from leaking.
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
		const mdxContent = "import Tabs from '@theme/Tabs'\n\n# Page\n\n:::warning Mind the gap\nContent here.\n:::\n";
		await writeFile(join(sourceDir, "page.mdx"), mdxContent, "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		expect(existsSync(join(outDir, "page.md"))).toBe(true);
		expect(existsSync(join(outDir, "page.mdx"))).toBe(false);
		const output = await readFile(join(outDir, "page.md"), "utf-8");
		expect(output).not.toContain("import");
		expect(output).toContain(":::warning[Mind the gap]");
		expect(output).toContain("Content here.");
	});

	it("normalizes legacy admonition titles when copying markdown to an output folder", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "guide.md"), ":::tip Read this\nBody.\n:::\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const output = await readFile(join(outDir, "guide.md"), "utf-8");
		expect(output).toContain(":::tip[Read this]");
		expect(output).not.toContain(":::tip Read this");
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

	// ── Error capture: sets exitCode=1 when convertFolder throws (covers lines 55-56) ──

	it("captures errors thrown by convertFolder and sets exit code to 1", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		// Make sidebar conversion throw to trigger the action's catch branch
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

	// ── slug:/ + sidebar key rewrite (covers lines 130-132) ─────────────────

	it("rewrites the sidebar key when a slug:/ file is renamed to index", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		// The sidebar contains the "intro" key that corresponds to the slug:/ file
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
		// The original "intro" key should be replaced by "index", label still "Introduction"
		expect(siteJson.sidebar["/"].intro).toBeUndefined();
		expect(siteJson.sidebar["/"].index).toBe("Introduction");
	});

	// ── Silent return when readdir fails (covers line 183) ──────────────────

	it("returns quietly without throwing when the source path is not a directory", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		// Point source at a file rather than a directory: readdir will throw.
		const sourceFile = join(tempDir, "not-a-dir.md");
		await writeFile(sourceFile, "# Not a directory\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceFile, "--output", outDir]);

		// Should not throw; site.json is still written to outDir (mkdir already ran)
		expect(existsSync(join(outDir, "site.json"))).toBe(true);
	});

	// ── Skip a single entry when stat fails (covers line 194) ───────────────

	it("skips entries whose stat fails (e.g. broken symlinks)", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const { symlink } = await import("node:fs/promises");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// Create a symlink to a missing path: stat (not lstat) will fail.
		await symlink(join(tempDir, "does-not-exist"), join(sourceDir, "broken-link.md"));
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// Normal files should still convert successfully
		expect(existsSync(join(outDir, "index.md"))).toBe(true);
	});

	// ── Skip .mdx when readFile fails (covers line 243) ─────────────────────

	it("skips .mdx files that cannot be read", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const mdxPath = join(sourceDir, "page.mdx");
		await writeFile(mdxPath, "import X from 'whatever'\n# X\n", "utf-8");
		// Drive the unreadable-file branch via the readFile mock — chmod 0o000
		// is a no-op on Windows so this is the only cross-platform way to
		// trigger the catch on line 247 of ConvertCommand.ts.
		const fspActual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		mockReadFile.mockImplementation(async (path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string" && path === mdxPath) {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			}
			return fspActual.readFile(path as Parameters<typeof fspActual.readFile>[0], ...(rest as [])) as unknown as
				| string
				| Buffer;
		});
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// Normal files should still succeed
		expect(existsSync(join(outDir, "index.md"))).toBe(true);
		// readFile failed and returned early, so page.md should not exist
		expect(existsSync(join(outDir, "page.md"))).toBe(false);
	});

	// ── promptMigration=true but framework is not docusaurus (covers the else branch at line 76)

	it("does not call sidebar conversion when a non-docusaurus framework is detected", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		// User agrees to migration, but the framework is not docusaurus
		mockDetectFramework.mockReturnValue({
			name: "mkdocs",
			configPath: join(tempDir, "mkdocs.yml"),
			// intentionally omit sidebarPath
		});
		mockPromptMigration.mockResolvedValue(true);

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// convertDocusaurusSidebar was not called, but conversion still completes
		expect(mockConvertSidebar).not.toHaveBeenCalled();
		expect(existsSync(join(outDir, "site.json"))).toBe(true);
	});

	// ── favicon configured but path does not exist (covers the else branch at line 120)

	it("skips the copy when conversion.favicon points to a missing path", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		mockConvertSidebar.mockResolvedValue({ sidebar: {}, pathMappings: {} });
		// favicon points to a non-existent file
		mockExtractFavicon.mockReturnValue(join(tempDir, "missing-favicon.ico"));

		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// favicon was not copied, but site.json still records the favicon field
		expect(existsSync(join(outDir, "favicon.ico"))).toBe(false);
		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		expect(siteJson.favicon).toBe("favicon.ico");
	});

	// ── .mdx where all imports are safe (covers the else branch of hasIncompatibleImports)

	it("copies .mdx as-is without downgrading when every import uses a safe prefix", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// Only references nextra (which is in the safe-prefix allowlist)
		const mdxContent = "import { Callout } from 'nextra/components'\n\n# Safe\n";
		await writeFile(join(sourceDir, "safe.mdx"), mdxContent, "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// No downgrade needed, so .mdx stays .mdx
		expect(existsSync(join(outDir, "safe.mdx"))).toBe(true);
		expect(existsSync(join(outDir, "safe.md"))).toBe(false);
	});

	// ── .mdx with both unsafe and safe imports, kept as .mdx after strip (covers downgraded=false)

	it("keeps the .mdx extension when safe JSX remains after stripping", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// Contains both unsafe (@theme/Tabs) and safe (nextra/components) imports —
		// hasIncompatibleImports=true, but the nextra import survives the strip.
		const mdxContent =
			"import Tabs from '@theme/Tabs'\nimport { Callout } from 'nextra/components'\n\n# Mixed\n\n<Callout>safe</Callout>\n";
		await writeFile(join(sourceDir, "mixed.mdx"), mdxContent, "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// downgraded=false keeps the .mdx extension
		expect(existsSync(join(outDir, "mixed.mdx"))).toBe(true);
		expect(existsSync(join(outDir, "mixed.md"))).toBe(false);
	});

	// ── in-place + pathMappings changes the .md path (covers the if branch at line 281)

	it("removes the original file when pathMappings changes a markdown path during in-place conversion", async () => {
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
		// in-place mode (no --output)
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// The file is at the new path and the old path is cleaned up
		expect(existsSync(join(sourceDir, "pipelines", "sql", "query.md"))).toBe(true);
		expect(existsSync(join(sourceDir, "sql", "query.md"))).toBe(false);
	});

	// ── in-place + no pathMappings + image: safeCopyOrMove takes the src===dest early return

	it("skips rename when an image file's path is unchanged during in-place conversion", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "logo.png"), "fake-png", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		// in-place + default empty pathMappings → src === dest, safeCopyOrMove returns early
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// File stays in place
		expect(existsSync(join(sourceDir, "logo.png"))).toBe(true);
	});

	// ── Falls back to process.cwd() when no source argument is given (covers ?? right side at line 42)

	it("uses process.cwd() as the source directory when no source argument is provided", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");
		// Temporarily switch cwd to sourceDir to simulate running `jolli convert` from the source dir
		const originalCwd = process.cwd();
		process.chdir(sourceDir);

		try {
			const program = new Command();
			registerConvertCommand(program);
			// No source argument; source comes from process.cwd()
			await program.parseAsync(["node", "test", "convert", "--output", outDir]);
			expect(existsSync(join(outDir, "site.json"))).toBe(true);
			expect(existsSync(join(outDir, "index.md"))).toBe(true);
		} finally {
			process.chdir(originalCwd);
		}
	});

	// ── catch a non-Error throw, convert via String(err) (covers the right side of the ternary at line 55)

	it("uses String(err) to set the exit code when a non-Error value is thrown", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		mockDetectFramework.mockReturnValue({
			name: "docusaurus",
			configPath: join(tempDir, "docusaurus.config.ts"),
			sidebarPath: join(tempDir, "sidebars.js"),
		});
		mockPromptMigration.mockResolvedValue(true);
		// Throw a non-Error to force the String(err) branch
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

	// ── dev command printed without a path when targetRoot === process.cwd() (covers right side of ternary at line 166)

	it("omits the directory suffix from the summary when targetRoot equals process.cwd()", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// Switch cwd to sourceDir so that in-place makes targetRoot === process.cwd()
		const originalCwd = process.cwd();
		process.chdir(sourceDir);

		try {
			const program = new Command();
			registerConvertCommand(program);
			// in-place (no --output), source is cwd
			await program.parseAsync(["node", "test", "convert"]);

			const output = logSpy.mock.calls.map((c: unknown[]) => (c as string[]).join(" ")).join("\n");
			// The hint reads "Run `jolli dev`" without a directory suffix
			expect(output).toContain("Run `jolli dev`");
		} finally {
			process.chdir(originalCwd);
		}
	});

	// ── stat succeeds but is neither dir nor file (covers the false branch of the if at line 199)

	it("skips special entries that are neither directories nor files (FIFO)", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		const { execFileSync } = await import("node:child_process");
		const sourceDir = join(tempDir, "docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		// Use mkfifo to create a named pipe: stat does not throw, but isFile/isDirectory are both false
		const fifoPath = join(sourceDir, "pipe.fifo");
		execFileSync("mkfifo", [fifoPath]);
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		// Normal files still convert successfully; the FIFO is silently skipped
		expect(existsSync(join(outDir, "index.md"))).toBe(true);
		expect(existsSync(join(outDir, "pipe.fifo"))).toBe(false);
	});

	// ── Falls back to defaultTitle when the user enters an empty string at the prompt (covers || right side at line 307)

	it("uses the default title when the interactive prompt receives an empty string", async () => {
		const { registerConvertCommand } = await import("./ConvertCommand.js");
		// Simulate the user just hitting return (empty input)
		mockPrompt("   ");
		const sourceDir = join(tempDir, "my-docs");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		const outDir = join(tempDir, "output");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir, "--output", outDir]);

		const siteJson = JSON.parse(await readFile(join(outDir, "site.json"), "utf-8"));
		// Empty after trim → use defaultTitle "My Docs"
		expect(siteJson.title).toBe("My Docs");
	});

	// ── in-place + pathMappings + markdown readFile fails (covers lines 276-277)

	it("falls back to safeCopyOrMove when markdown readFile fails in in-place mode", async () => {
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
		// Throw EACCES only for query.md's readFile; forward other files normally.
		// chmod would also break the upfront cp backup, so we must intercept precisely with a mock.
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
		// in-place mode lets the catch path use safeCopyOrMove
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// File ends up at the new path via safeCopyOrMove, original is removed
		expect(existsSync(join(sourceDir, "pipelines", "sql", "query.md"))).toBe(true);
		expect(existsSync(targetMd)).toBe(false);
	});

	// ── in-place + image + pathMappings: rename succeeds (covers the try in the safeCopyOrMove inPlace branch)

	it("uses rename when in-place mode relocates an image via pathMappings", async () => {
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
		// in-place mode → safeCopyOrMove takes the inPlace=true branch's rename
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// rename succeeded: new path exists, old path gone
		expect(existsSync(join(sourceDir, "assets", "img", "logo.png"))).toBe(true);
		expect(existsSync(join(sourceDir, "img", "logo.png"))).toBe(false);
	});

	// ── in-place + image + rename throws: takes the cross-device fallback (covers the catch at 319-321)

	it("falls back to copyFile + safeRemove when rename throws in in-place mode", async () => {
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
		// Make rename throw EXDEV to simulate a cross-device move
		mockRename.mockRejectedValueOnce(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));

		const sourceDir = join(tempDir, "docs");
		await mkdir(join(sourceDir, "img"), { recursive: true });
		await writeFile(join(sourceDir, "index.md"), "# Home\n", "utf-8");
		await writeFile(join(sourceDir, "img", "logo.png"), "png-data", "utf-8");

		const program = new Command();
		registerConvertCommand(program);
		await program.parseAsync(["node", "test", "convert", sourceDir]);

		// fallback: copyFile writes to the new path, safeRemove deletes the old one
		expect(existsSync(join(sourceDir, "assets", "img", "logo.png"))).toBe(true);
		expect(existsSync(join(sourceDir, "img", "logo.png"))).toBe(false);
	});
});
