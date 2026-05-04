/**
 * Tests for DocusaurusConverter — converts Docusaurus sidebars.js to SidebarOverrides.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-docusaurus-test-"));
}

describe("DocusaurusConverter.convertDocusaurusSidebar", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("converts a simple sidebar with string items", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(sidebarPath, `module.exports = { docsSidebar: ['intro', 'getting-started'] }`, "utf-8");

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"]).toBeDefined();
		expect(Object.keys(result.sidebar["/"])).toContain("intro");
		expect(Object.keys(result.sidebar["/"])).toContain("getting-started");
	});

	it("preserves declaration order", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(sidebarPath, `module.exports = { docsSidebar: ['zebra', 'alpha', 'middle'] }`, "utf-8");

		const result = await convertDocusaurusSidebar(sidebarPath);

		const keys = Object.keys(result.sidebar["/"]);
		expect(keys).toEqual(["zebra", "alpha", "middle"]);
	});

	it("converts category items with custom labels", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'category', label: 'Install Feldera', link: { type: 'doc', id: 'get-started/index' }, items: ['get-started/docker'] }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"]["get-started"]).toBe("Install Feldera");
		expect(result.sidebar["/get-started"]).toBeDefined();
		expect(result.sidebar["/get-started"].docker).toBe("Docker");
	});

	it("converts doc items with custom labels", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'doc', id: 'pipelines/configuration', label: 'Settings' }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"].configuration).toBe("Settings");
	});

	it("converts link items to objects with href", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'link', label: 'Python SDK', href: 'pathname:///python/' }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		const entry = result.sidebar["/"]["python-sdk"];
		expect(entry).toBeDefined();
		expect(typeof entry).toBe("object");
		if (typeof entry === "object") {
			expect(entry.title).toBe("Python SDK");
			expect(entry.href).toBe("/python/");
		}
	});

	it("returns empty object for invalid sidebar file", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(sidebarPath, "this is not valid js }{}{", "utf-8");

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar).toEqual({});
		expect(result.pathMappings).toEqual({});
	});

	it("handles nested categories", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'category', label: 'SQL', link: { type: 'doc', id: 'sql/index' }, items: [
					'sql/grammar',
					{ type: 'category', label: 'Operations', link: { type: 'doc', id: 'sql/operations/index' }, items: [
						'sql/operations/select'
					] }
				] }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"]).toBeDefined();
		expect(result.sidebar["/sql"]).toBeDefined();
		expect(result.sidebar["/sql"].grammar).toBe("Grammar");
		expect(result.sidebar["/sql"].operations).toBe("Operations");
		expect(result.sidebar["/sql/operations"]).toBeDefined();
		expect(result.sidebar["/sql/operations"].select).toBe("Select");
	});

	it("generates pathMappings when doc is outside logical dir", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'category', label: 'Tutorials', link: { type: 'doc', id: 'tutorials/index' }, items: [
					{ type: 'doc', id: 'use_cases/fraud/intro', label: 'Fraud Detection' }
				] }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(Object.keys(result.pathMappings).length).toBeGreaterThan(0);
	});

	it("flattens virtual groupings when category dir matches parent", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		// Virtual grouping: "Overview" category within sql/ whose items are also in sql/
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'category', label: 'SQL', link: { type: 'doc', id: 'sql/index' }, items: [
					{ type: 'category', label: 'Overview', items: ['sql/intro', 'sql/syntax'] }
				] }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		// Virtual grouping should be flattened — items should be in /sql, not /sql/overview
		expect(result.sidebar["/sql"]).toBeDefined();
		expect(result.sidebar["/sql"].intro).toBeDefined();
	});

	it("handles category without link.id using first item path", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'category', label: 'Guides', items: ['guides/install', 'guides/config'] }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"]).toBeDefined();
		expect(result.sidebar["/"].guides).toBe("Guides");
	});

	it("does not duplicate sidebar entries", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(sidebarPath, `module.exports = { docsSidebar: ['intro', 'intro'] }`, "utf-8");

		const result = await convertDocusaurusSidebar(sidebarPath);

		const introEntries = Object.entries(result.sidebar["/"]).filter(([k]) => k === "intro");
		expect(introEntries.length).toBe(1);
	});

	it("handles nonexistent sidebar file gracefully", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");

		const result = await convertDocusaurusSidebar(join(tempDir, "nonexistent.js"));

		expect(result.sidebar).toEqual({});
		expect(result.pathMappings).toEqual({});
	});
});

// ─── extractFaviconFromConfig ────────────────────────────────────────────────

describe("DocusaurusConverter.extractFaviconFromConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("extracts favicon path from config file", async () => {
		const { extractFaviconFromConfig } = await import("./DocusaurusConverter.js");
		const configPath = join(tempDir, "docusaurus.config.ts");
		await writeFile(configPath, `export default { favicon: 'img/favicon.ico' }`, "utf-8");

		const result = extractFaviconFromConfig(configPath);

		expect(result).toBeDefined();
		expect(result).toContain("static");
		expect(result).toContain("favicon.ico");
	});

	it("extracts favicon with double quotes", async () => {
		const { extractFaviconFromConfig } = await import("./DocusaurusConverter.js");
		const configPath = join(tempDir, "docusaurus.config.ts");
		await writeFile(configPath, `export default { favicon: "img/favicon.ico" }`, "utf-8");

		const result = extractFaviconFromConfig(configPath);

		expect(result).toBeDefined();
		expect(result).toContain("favicon.ico");
	});

	it("returns undefined when no favicon in config", async () => {
		const { extractFaviconFromConfig } = await import("./DocusaurusConverter.js");
		const configPath = join(tempDir, "docusaurus.config.ts");
		await writeFile(configPath, `export default { title: 'My Site' }`, "utf-8");

		const result = extractFaviconFromConfig(configPath);

		expect(result).toBeUndefined();
	});

	it("returns undefined for nonexistent config file", async () => {
		const { extractFaviconFromConfig } = await import("./DocusaurusConverter.js");

		const result = extractFaviconFromConfig(join(tempDir, "nonexistent.ts"));

		expect(result).toBeUndefined();
	});
});

// ─── Additional branch coverage tests ────────────────────────────────────────

describe("DocusaurusConverter branch coverage", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("handles doc item without custom label", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [{ type: 'doc', id: 'getting-started' }] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"]["getting-started"]).toBe("Getting Started");
	});

	it("handles category with doc item containing nested path", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'doc', id: 'guides/installation', label: 'Install' }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"].installation).toBe("Install");
	});

	it("handles category resolved by first doc item", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'category', label: 'Tutorials', items: [
					{ type: 'doc', id: 'tutorials/basics' }
				] }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"].tutorials).toBe("Tutorials");
	});

	it("handles category with label-only fallback when no items have paths", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'category', label: 'My Category', items: [
					{ type: 'link', label: 'External', href: 'https://example.com' }
				] }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"]["my-category"]).toBe("My Category");
	});

	it("handles index doc IDs in lastSegment", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(sidebarPath, `module.exports = { docsSidebar: ['guides/index'] }`, "utf-8");

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar["/"].guides).toBeDefined();
	});

	it("handles link items with pathname prefix", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(
			sidebarPath,
			`module.exports = { docsSidebar: [
				{ type: 'link', label: 'API Docs', href: 'pathname:///api/reference' }
			] }`,
			"utf-8",
		);

		const result = await convertDocusaurusSidebar(sidebarPath);

		const entry = result.sidebar["/"]["api-docs"];
		expect(typeof entry).toBe("object");
		if (typeof entry === "object") {
			expect(entry.href).toBe("/api/reference");
		}
	});

	it("handles sidebar with no array values", async () => {
		const { convertDocusaurusSidebar } = await import("./DocusaurusConverter.js");
		const sidebarPath = join(tempDir, "sidebars.js");
		await writeFile(sidebarPath, `module.exports = { docs: 'auto' }`, "utf-8");

		const result = await convertDocusaurusSidebar(sidebarPath);

		expect(result.sidebar).toEqual({});
	});
});
