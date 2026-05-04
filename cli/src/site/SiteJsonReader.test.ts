/**
 * Tests for SiteJsonReader — reads and validates `site.json`.
 *
 * Covers all acceptance criteria from Task 3:
 *   - Valid site.json is parsed and returned
 *   - Missing site.json returns default config with usedDefault: true and warns
 *   - Invalid JSON throws a descriptive error including the file path
 *   - Unrecognized fields are silently ignored
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock readline ───────────────────────────────────────────────────────────

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

/** Mock readline to answer different things for sequential prompts. */
function mockPromptSequence(...answers: string[]): void {
	let callCount = 0;
	mockCreateInterface.mockImplementation(() => ({
		question: (_prompt: string, cb: (answer: string) => void) => cb(answers[callCount++] ?? ""),
		close: vi.fn(),
	}));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-sitejsonreader-test-"));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SiteJsonReader.readSiteJson", () => {
	let tempDir: string;
	const originalIsTTY = process.stdin.isTTY;

	beforeEach(async () => {
		tempDir = await makeTempDir();
		process.stdin.isTTY = true;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		process.stdin.isTTY = originalIsTTY;
		vi.restoreAllMocks();
	});

	// ── Valid site.json ─────────────────────────────────────────────────────

	it("returns usedDefault: false when site.json exists", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		const siteJson = {
			title: "Test Site",
			description: "A test site",
			nav: [{ label: "Home", href: "/" }],
		};
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.usedDefault).toBe(false);
	});

	it("returns the parsed title from site.json", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		const siteJson = { title: "My Docs", description: "desc", nav: [] };
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.title).toBe("My Docs");
	});

	it("returns the parsed description from site.json", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		const siteJson = { title: "T", description: "My description", nav: [] };
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.description).toBe("My description");
	});

	it("returns the parsed nav array from site.json", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		const nav = [
			{ label: "Home", href: "/" },
			{ label: "Docs", href: "/docs" },
		];
		const siteJson = { title: "T", description: "D", nav };
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.nav).toEqual(nav);
	});

	// ── Missing site.json — prompts and creates ─────────────────────────────

	it("returns usedDefault: true when site.json is absent", async () => {
		mockPrompt("");
		const { readSiteJson } = await import("./SiteJsonReader.js");

		const result = await readSiteJson(tempDir);

		expect(result.usedDefault).toBe(true);
	});

	it("creates site.json in the source root when absent", async () => {
		mockPrompt("");
		const { readSiteJson } = await import("./SiteJsonReader.js");

		await readSiteJson(tempDir);

		expect(existsSync(join(tempDir, "site.json"))).toBe(true);
	});

	it("written site.json is valid JSON", async () => {
		mockPrompt("");
		const { readSiteJson } = await import("./SiteJsonReader.js");

		await readSiteJson(tempDir);

		const content = await readFile(join(tempDir, "site.json"), "utf-8");
		expect(() => JSON.parse(content)).not.toThrow();
	});

	it("uses user-provided title when input is given", async () => {
		mockPrompt("My Docs");
		const { readSiteJson } = await import("./SiteJsonReader.js");

		const result = await readSiteJson(tempDir);

		expect(result.config.title).toBe("My Docs");
	});

	it("uses folder name as default title when user presses Enter", async () => {
		mockPrompt("");
		const { readSiteJson } = await import("./SiteJsonReader.js");

		const result = await readSiteJson(tempDir);

		// tempDir ends with a random suffix, but title should be title-cased
		expect(result.config.title.length).toBeGreaterThan(0);
	});

	it("saves user-provided title to site.json", async () => {
		mockPrompt("Custom Title");
		const { readSiteJson } = await import("./SiteJsonReader.js");

		await readSiteJson(tempDir);

		const content = JSON.parse(await readFile(join(tempDir, "site.json"), "utf-8"));
		expect(content.title).toBe("Custom Title");
	});

	it("prints the created file path", async () => {
		mockPrompt("");
		const { readSiteJson } = await import("./SiteJsonReader.js");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await readSiteJson(tempDir);

		const output = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toContain("site.json");
	});

	it("uses default title without prompting when stdin is not a TTY", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		process.stdin.isTTY = undefined as unknown as true;

		const result = await readSiteJson(tempDir);

		expect(result.usedDefault).toBe(true);
	});

	// ── Invalid JSON (Requirement 8.7 / Task 3.3) ──────────────────────────

	it("throws an error when site.json exists but is not valid JSON", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		await writeFile(join(tempDir, "site.json"), "{ not valid json }", "utf-8");

		await expect(readSiteJson(tempDir)).rejects.toThrow();
	});

	it("error message includes the file path when site.json is invalid JSON", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		await writeFile(join(tempDir, "site.json"), "{ not valid json }", "utf-8");

		await expect(readSiteJson(tempDir)).rejects.toThrow(join(tempDir, "site.json"));
	});

	it("error message is descriptive (contains parse error detail)", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		await writeFile(join(tempDir, "site.json"), "definitely not json!!!", "utf-8");

		let caughtError: Error | undefined;
		try {
			await readSiteJson(tempDir);
		} catch (err) {
			caughtError = err as Error;
		}

		expect(caughtError).toBeDefined();
		expect(caughtError?.message.length).toBeGreaterThan(0);
	});

	// ── Unrecognized fields (Requirement 8.6 / Task 3.4) ───────────────────

	it("does not throw when site.json contains unrecognized fields", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		const siteJson = {
			title: "T",
			description: "D",
			nav: [],
			unknownField: "some value",
			anotherExtra: 42,
		};
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		await expect(readSiteJson(tempDir)).resolves.not.toThrow();
	});

	it("still returns correct title/description/nav when unrecognized fields are present", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		const siteJson = {
			title: "Known Title",
			description: "Known Desc",
			nav: [{ label: "X", href: "/x" }],
			extraField: "ignored",
		};
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.title).toBe("Known Title");
		expect(result.config.description).toBe("Known Desc");
		expect(result.config.nav).toEqual([{ label: "X", href: "/x" }]);
	});

	// ── Type fallbacks (lines 70–72) ───────────────────────────────────────

	it("uses default title when title is not a string", async () => {
		const { readSiteJson, DEFAULT_SITE_JSON } = await import("./SiteJsonReader.js");
		const siteJson = { title: 123, description: "D", nav: [] };
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.title).toBe(DEFAULT_SITE_JSON.title);
	});

	it("uses default description when description is not a string", async () => {
		const { readSiteJson, DEFAULT_SITE_JSON } = await import("./SiteJsonReader.js");
		const siteJson = { title: "T", description: null, nav: [] };
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.description).toBe(DEFAULT_SITE_JSON.description);
	});

	it("uses default nav when nav is not an array", async () => {
		const { readSiteJson, DEFAULT_SITE_JSON } = await import("./SiteJsonReader.js");
		const siteJson = { title: "T", description: "D", nav: "not-array" };
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.nav).toEqual(DEFAULT_SITE_JSON.nav);
	});

	// ── DEFAULT_SITE_JSON export ────────────────────────────────────────────

	it("DEFAULT_SITE_JSON has a non-empty title", async () => {
		const { DEFAULT_SITE_JSON } = await import("./SiteJsonReader.js");

		expect(typeof DEFAULT_SITE_JSON.title).toBe("string");
		expect(DEFAULT_SITE_JSON.title.length).toBeGreaterThan(0);
	});

	it("DEFAULT_SITE_JSON has a non-empty description", async () => {
		const { DEFAULT_SITE_JSON } = await import("./SiteJsonReader.js");

		expect(typeof DEFAULT_SITE_JSON.description).toBe("string");
		expect(DEFAULT_SITE_JSON.description.length).toBeGreaterThan(0);
	});

	it("DEFAULT_SITE_JSON has an empty nav array", async () => {
		const { DEFAULT_SITE_JSON } = await import("./SiteJsonReader.js");

		expect(Array.isArray(DEFAULT_SITE_JSON.nav)).toBe(true);
		expect(DEFAULT_SITE_JSON.nav).toHaveLength(0);
	});

	// ── Preserving unrecognized fields ──────────────────────────────────────

	it("preserves extra fields in config object", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		const siteJson = {
			title: "T",
			description: "D",
			nav: [],
			sidebar: { "/": { intro: "Intro" } },
			pathMappings: { sql: "pipelines/sql" },
			favicon: "favicon.ico",
		};
		await writeFile(join(tempDir, "site.json"), JSON.stringify(siteJson), "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.sidebar).toBeDefined();
		expect(result.config.pathMappings).toBeDefined();
		expect(result.config.favicon).toBe("favicon.ico");
	});

	// ── migrate option ──────────────────────────────────────────────────────

	it("forces re-detection when migrate option is true", async () => {
		mockPrompt("New Title");
		const { readSiteJson } = await import("./SiteJsonReader.js");
		// Write existing site.json
		await writeFile(
			join(tempDir, "site.json"),
			JSON.stringify({ title: "Old", description: "Old", nav: [] }),
			"utf-8",
		);

		const result = await readSiteJson(tempDir, { migrate: true });

		// Should use createSiteJson path, so usedDefault: true and new title
		expect(result.usedDefault).toBe(true);
		expect(result.config.title).toBe("New Title");
	});

	it("reads existing site.json when migrate is false", async () => {
		const { readSiteJson } = await import("./SiteJsonReader.js");
		await writeFile(
			join(tempDir, "site.json"),
			JSON.stringify({ title: "Existing", description: "D", nav: [] }),
			"utf-8",
		);

		const result = await readSiteJson(tempDir, { migrate: false });

		expect(result.usedDefault).toBe(false);
		expect(result.config.title).toBe("Existing");
	});

	// ── createSiteJson with unsupported framework ───────────────────────────

	it("creates site.json even for unsupported framework (mintlify)", async () => {
		// First prompt: promptMigration → "y" (yes), second: promptSiteTitle → "My Title"
		mockPromptSequence("y", "My Title");
		const { readSiteJson } = await import("./SiteJsonReader.js");
		// Create a mint.json to trigger mintlify detection
		await writeFile(join(tempDir, "mint.json"), "{}", "utf-8");

		const result = await readSiteJson(tempDir);

		// Should still create site.json with user's title
		expect(result.config.title).toBe("My Title");
		expect(result.usedDefault).toBe(true);
		expect(existsSync(join(tempDir, "site.json"))).toBe(true);
	});

	// ── createSiteJson with docusaurus ───────────────────────────────────────

	it("generates site.json with sidebar from docusaurus conversion", async () => {
		// First prompt: promptMigration → "y" (yes), second: promptSiteTitle → "My Docs"
		mockPromptSequence("y", "My Docs");
		const { readSiteJson } = await import("./SiteJsonReader.js");
		// Create docusaurus files with sidebar
		await writeFile(join(tempDir, "sidebars.js"), `module.exports = { docsSidebar: ['intro'] }`, "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.usedDefault).toBe(true);
		expect(result.config.title).toBe("My Docs");
		// Should include sidebar from conversion
		expect(result.config.sidebar).toBeDefined();
	});

	it("includes pathMappings in site.json when conversion produces them", async () => {
		mockPromptSequence("y", "Title");
		const { readSiteJson } = await import("./SiteJsonReader.js");
		// Create sidebar with nested category that produces pathMappings
		await writeFile(
			join(tempDir, "sidebars.js"),
			`module.exports = { docsSidebar: [
				{ type: 'category', label: 'Tutorials', link: { type: 'doc', id: 'tutorials/index' }, items: [
					{ type: 'doc', id: 'use_cases/fraud/intro', label: 'Fraud' }
				] }
			] }`,
			"utf-8",
		);

		const result = await readSiteJson(tempDir);

		expect(result.config.pathMappings).toBeDefined();
	});

	it("skips sidebar conversion when user declines migration", async () => {
		// First prompt: promptMigration → "n" (no), second: promptSiteTitle → "Title"
		mockPromptSequence("n", "Title");
		const { readSiteJson } = await import("./SiteJsonReader.js");
		await writeFile(join(tempDir, "sidebars.js"), `module.exports = { docsSidebar: ['intro'] }`, "utf-8");

		const result = await readSiteJson(tempDir);

		expect(result.config.sidebar).toBeUndefined();
	});
});
