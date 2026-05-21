/**
 * Tests for StarterKit — scaffolds a new Content_Folder.
 *
 * Covers all acceptance criteria from Task 2:
 *   - All expected files are written
 *   - site.json is valid JSON with required fields
 *   - Nested subfolder structure is created
 *   - Returns error (non-zero) if target directory already exists
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a real temporary directory for each test and cleans it up after. */
async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-starterkit-test-"));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StarterKit.scaffoldProject", () => {
	let tempBase: string;

	beforeEach(async () => {
		tempBase = await makeTempDir();
	});

	afterEach(async () => {
		await rm(tempBase, { recursive: true, force: true });
	});

	// ── Success path ────────────────────────────────────────────────────────

	it("returns success: true when the target directory does not exist", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		const result = await scaffoldProject(targetDir);

		expect(result.success).toBe(true);
		expect(result.targetDir).toBe(targetDir);
	});

	it("creates the target directory", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		expect(existsSync(targetDir)).toBe(true);
	});

	// ── site.json (Requirement 2) ───────────────────────────────────────────

	it("writes site.json at the root of the target directory", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		expect(existsSync(join(targetDir, "site.json"))).toBe(true);
	});

	it("site.json is valid JSON", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		const raw = await readFile(join(targetDir, "site.json"), "utf-8");
		expect(() => JSON.parse(raw)).not.toThrow();
	});

	it("site.json contains a non-empty title field", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		const raw = await readFile(join(targetDir, "site.json"), "utf-8");
		const parsed = JSON.parse(raw) as { title?: unknown };
		expect(typeof parsed.title).toBe("string");
		expect((parsed.title as string).length).toBeGreaterThan(0);
	});

	it("site.json contains a non-empty description field", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		const raw = await readFile(join(targetDir, "site.json"), "utf-8");
		const parsed = JSON.parse(raw) as { description?: unknown };
		expect(typeof parsed.description).toBe("string");
		expect((parsed.description as string).length).toBeGreaterThan(0);
	});

	it("site.json contains navigation pages with Documentation and API Reference", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		const raw = await readFile(join(targetDir, "site.json"), "utf-8");
		const parsed = JSON.parse(raw) as { navigation?: unknown };
		expect(parsed.navigation).toBeDefined();
		expect(Array.isArray(parsed.navigation)).toBe(true);

		const pages = parsed.navigation as Array<{ page: string }>;
		const pageNames = pages.map((p) => p.page);
		expect(pageNames).toContain("Documentation");
		expect(pageNames).toContain("API Reference");
	});

	it("site.json includes a $schema URL for editor autocompletion", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		const raw = await readFile(join(targetDir, "site.json"), "utf-8");
		const parsed = JSON.parse(raw) as { $schema?: unknown };
		expect(parsed.$schema).toBe("https://jolli.ai/schemas/site-config.json");
	});

	it("site.json includes theme.pack: 'forge' so new sites explicitly request the Forge theme", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		const raw = await readFile(join(targetDir, "site.json"), "utf-8");
		const parsed = JSON.parse(raw) as { theme?: { pack?: string } };
		expect(parsed.theme?.pack).toBe("forge");
	});

	// ── Markdown files (Requirement 1.4) ───────────────────────────────────

	it("writes index.md at the root", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		expect(existsSync(join(targetDir, "index.md"))).toBe(true);
	});

	it("writes docs/getting-started.md under the docs folder", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		expect(existsSync(join(targetDir, "docs", "getting-started.md"))).toBe(true);
	});

	// ── OpenAPI file (Requirement 1.5) ─────────────────────────────────────

	it("writes api/openapi.yaml", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		expect(existsSync(join(targetDir, "api", "openapi.yaml"))).toBe(true);
	});

	it("api/openapi.yaml contains an openapi version field", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		const content = await readFile(join(targetDir, "api", "openapi.yaml"), "utf-8");
		expect(content).toMatch(/^openapi:/m);
	});

	it("api/openapi.yaml contains an info object", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		const content = await readFile(join(targetDir, "api", "openapi.yaml"), "utf-8");
		expect(content).toMatch(/^info:/m);
	});

	// ── Nested subfolder (Requirement 1.6) ─────────────────────────────────

	it("creates a docs/guides/ subfolder with introduction.md", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "my-docs");

		await scaffoldProject(targetDir);

		expect(existsSync(join(targetDir, "docs", "guides", "introduction.md"))).toBe(true);
	});

	// ── Error: target already exists (Requirement 1.2 / Task 2.7) ──────────

	it("returns success: false when the target directory already exists", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		// tempBase itself already exists
		const result = await scaffoldProject(tempBase);

		expect(result.success).toBe(false);
		expect(result.targetDir).toBe(tempBase);
	});

	it("includes a descriptive message when the target directory already exists", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const result = await scaffoldProject(tempBase);

		expect(result.message).toBeTruthy();
		expect(result.message).toContain(tempBase);
	});

	it("does not modify the existing directory when it already exists", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		// tempBase is empty — after the failed scaffold it should still be empty
		await scaffoldProject(tempBase);

		expect(existsSync(join(tempBase, "site.json"))).toBe(false);
		expect(existsSync(join(tempBase, "index.md"))).toBe(false);
	});

	// ── Result shape ────────────────────────────────────────────────────────

	it("result.targetDir matches the argument passed in", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "result-shape-test");

		const result = await scaffoldProject(targetDir);

		expect(result.targetDir).toBe(targetDir);
	});

	it("result.message is set on success", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		const targetDir = join(tempBase, "message-test");

		const result = await scaffoldProject(targetDir);

		expect(result.message).toBeTruthy();
	});

	// ── Filesystem error handling ───────────────────────────────────────────

	it("returns success: false when a filesystem error occurs", async () => {
		const { scaffoldProject } = await import("./StarterKit.js");
		// Use a path that cannot be created (null byte in name is invalid on all OSes)
		const invalidDir = join(tempBase, "bad\0name");

		const result = await scaffoldProject(invalidDir);

		expect(result.success).toBe(false);
		expect(result.message).toBeTruthy();
	});
});
