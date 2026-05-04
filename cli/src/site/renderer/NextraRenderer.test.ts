/**
 * Tests for NextraRenderer — verifies delegation to existing site modules.
 */

import { describe, expect, it, vi } from "vitest";
import { NextraRenderer } from "./NextraRenderer.js";

// ─── Mock dependencies ──────────────────────────────────────────────────────

vi.mock("../NextraProjectWriter.js", () => ({
	initNextraProject: vi.fn().mockResolvedValue({ isNew: true }),
}));

vi.mock("../MetaGenerator.js", () => ({
	generateMetaFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../OpenApiRenderer.js", () => ({
	renderOpenApiFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../NpmRunner.js", () => ({
	runNpmBuild: vi.fn().mockResolvedValue({ success: true, output: "" }),
	runNpmDev: vi.fn().mockResolvedValue({ success: true, output: "" }),
}));

vi.mock("../OutputFilter.js", () => ({
	createOutputFilter: vi.fn().mockReturnValue({ write: vi.fn(), getUrl: vi.fn() }),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("NextraRenderer", () => {
	it("has name 'nextra'", () => {
		const renderer = new NextraRenderer();
		expect(renderer.name).toBe("nextra");
	});

	it("initProject delegates to initNextraProject", async () => {
		const { initNextraProject } = await import("../NextraProjectWriter.js");
		const renderer = new NextraRenderer();
		const config = { title: "T", description: "D", nav: [] };

		await renderer.initProject("/build", config, { staticExport: true });

		expect(initNextraProject).toHaveBeenCalledWith("/build", config, { staticExport: true });
	});

	it("getCacheDirs returns .next directory", () => {
		const renderer = new NextraRenderer();

		const dirs = renderer.getCacheDirs("/build");

		expect(dirs).toEqual(["/build/.next"]);
	});

	it("generateNavigation delegates to generateMetaFiles", async () => {
		const { generateMetaFiles } = await import("../MetaGenerator.js");
		const renderer = new NextraRenderer();
		const sidebar = { "/": { intro: "Intro" } };

		await renderer.generateNavigation("/content", sidebar);

		expect(generateMetaFiles).toHaveBeenCalledWith("/content", sidebar);
	});

	it("renderOpenApiFiles delegates to the OpenApiRenderer module", async () => {
		const { renderOpenApiFiles } = await import("../OpenApiRenderer.js");
		const renderer = new NextraRenderer();

		await renderer.renderOpenApiFiles("/source", "/content", ["api.yaml"], "/public");

		expect(renderOpenApiFiles).toHaveBeenCalledWith("/source", "/content", ["api.yaml"], "/public");
	});

	it("getContentRules returns safe import prefixes including nextra", () => {
		const renderer = new NextraRenderer();

		const rules = renderer.getContentRules();

		expect(rules.safeImportPrefixes).toContain("nextra");
		expect(rules.safeImportPrefixes).toContain("react");
		expect(rules.providedComponents.has("Callout")).toBe(true);
		expect(rules.providedComponents.has("Fragment")).toBe(true);
	});

	it("runBuild delegates to runNpmBuild", async () => {
		const { runNpmBuild } = await import("../NpmRunner.js");
		const renderer = new NextraRenderer();

		await renderer.runBuild("/build");

		expect(runNpmBuild).toHaveBeenCalledWith("/build");
	});

	it("runDev delegates to runNpmDev", async () => {
		const { runNpmDev } = await import("../NpmRunner.js");
		const renderer = new NextraRenderer();

		await renderer.runDev("/build", true);

		expect(runNpmDev).toHaveBeenCalledWith("/build", true);
	});

	it("createOutputFilter delegates to the OutputFilter module", async () => {
		const { createOutputFilter } = await import("../OutputFilter.js");
		const renderer = new NextraRenderer();

		renderer.createOutputFilter(true);

		expect(createOutputFilter).toHaveBeenCalledWith(true);
	});

	it("extractPageCount parses Next.js static page generation output", () => {
		const renderer = new NextraRenderer();

		expect(renderer.extractPageCount("Generating static pages (0/10)\n(10/10)")).toBe(10);
	});

	it("extractPageCount returns undefined for non-matching output", () => {
		const renderer = new NextraRenderer();

		expect(renderer.extractPageCount("Build complete")).toBeUndefined();
	});
});
