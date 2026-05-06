/**
 * Tests for NextraRenderer — verifies delegation + the OpenAPI emission
 * loop that writes the Nextra emitter's TemplateFile output to disk.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextraRenderer } from "./NextraRenderer.js";
import type { OpenApiSpecInput } from "./SiteRenderer.js";

// ─── Mock dependencies ──────────────────────────────────────────────────────

vi.mock("../NextraProjectWriter.js", () => ({
	initNextraProject: vi.fn().mockResolvedValue({ isNew: true }),
}));

vi.mock("../MetaGenerator.js", () => ({
	generateMetaFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../NpmRunner.js", () => ({
	runNpmBuild: vi.fn().mockResolvedValue({ success: true, output: "" }),
	runNpmDev: vi.fn().mockResolvedValue({ success: true, output: "" }),
}));

vi.mock("../OutputFilter.js", () => ({
	createOutputFilter: vi.fn().mockReturnValue({ write: vi.fn(), getUrl: vi.fn() }),
}));

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeSpecInput(overrides: Partial<OpenApiSpecInput> = {}): OpenApiSpecInput {
	return {
		specName: "petstore",
		sourceRelPath: "api/petstore.yaml",
		pipeline: {
			spec: {
				info: { title: "Pet Store", version: "1.0.0", description: "Sample API" },
				servers: [{ url: "https://api.example.com" }],
				securitySchemes: {},
				globalSecurity: [],
				tags: [{ name: "pets" }],
				operations: [
					{
						operationId: "listpets",
						method: "get",
						path: "/pets",
						tag: "pets",
						summary: "List pets",
						description: "",
						deprecated: false,
						parameters: [],
						responses: [],
						security: [],
					},
				],
				componentSchemas: {},
			},
			dossiers: [],
		},
		...overrides,
	};
}

// ─── Delegation tests ──────────────────────────────────────────────────────

describe("NextraRenderer", () => {
	it("has name 'nextra'", () => {
		expect(new NextraRenderer().name).toBe("nextra");
	});

	it("initProject delegates to initNextraProject, writes the 9 api components, and emits styles/api.css", async () => {
		const { initNextraProject } = await import("../NextraProjectWriter.js");
		const buildDir = await mkdtemp(join(tmpdir(), "jolli-nextra-init-"));
		try {
			const config = { title: "T", description: "D", nav: [] };
			await new NextraRenderer().initProject(buildDir, config, { staticExport: true });
			expect(initNextraProject).toHaveBeenCalledWith(buildDir, config, { staticExport: true });
			for (const file of [
				"describeType.ts",
				"EndpointMeta.tsx",
				"ParamTable.tsx",
				"SchemaBlock.tsx",
				"ResponseBlock.tsx",
				"AuthRequirements.tsx",
				"TryIt.tsx",
				"CodeSwitcher.tsx",
				"Endpoint.tsx",
			]) {
				expect(existsSync(join(buildDir, "components", "api", file))).toBe(true);
			}
			expect(existsSync(join(buildDir, "styles", "api.css"))).toBe(true);
		} finally {
			await rm(buildDir, { recursive: true, force: true });
		}
	});

	it("api.css uses theme.primaryHue when set, regardless of pack", async () => {
		const buildDir = await mkdtemp(join(tmpdir(), "jolli-nextra-hue-"));
		try {
			const config = {
				title: "T",
				description: "D",
				nav: [],
				theme: { pack: "forge" as const, primaryHue: 145 },
			};
			await new NextraRenderer().initProject(buildDir, config, { staticExport: true });
			const css = await readFile(join(buildDir, "styles", "api.css"), "utf-8");
			expect(css).toContain("hsl(145 84% 50%)");
		} finally {
			await rm(buildDir, { recursive: true, force: true });
		}
	});

	it("api.css falls back to Forge's manifest hue (228) when pack is forge but primaryHue is unset", async () => {
		const buildDir = await mkdtemp(join(tmpdir(), "jolli-nextra-forge-"));
		try {
			const config = { title: "T", description: "D", nav: [], theme: { pack: "forge" as const } };
			await new NextraRenderer().initProject(buildDir, config, { staticExport: true });
			const css = await readFile(join(buildDir, "styles", "api.css"), "utf-8");
			expect(css).toContain("hsl(228 84% 50%)");
		} finally {
			await rm(buildDir, { recursive: true, force: true });
		}
	});

	it("api.css falls back to Atlas's manifest hue (200) when pack is atlas but primaryHue is unset", async () => {
		const buildDir = await mkdtemp(join(tmpdir(), "jolli-nextra-atlas-"));
		try {
			const config = { title: "T", description: "D", nav: [], theme: { pack: "atlas" as const } };
			await new NextraRenderer().initProject(buildDir, config, { staticExport: true });
			const css = await readFile(join(buildDir, "styles", "api.css"), "utf-8");
			expect(css).toContain("hsl(200 84% 50%)");
		} finally {
			await rm(buildDir, { recursive: true, force: true });
		}
	});

	it("api.css uses generateApiCss's internal default (220) when no theme is set", async () => {
		const buildDir = await mkdtemp(join(tmpdir(), "jolli-nextra-default-"));
		try {
			const config = { title: "T", description: "D", nav: [] };
			await new NextraRenderer().initProject(buildDir, config, { staticExport: true });
			const css = await readFile(join(buildDir, "styles", "api.css"), "utf-8");
			expect(css).toContain("hsl(220 84% 50%)");
		} finally {
			await rm(buildDir, { recursive: true, force: true });
		}
	});

	it("getCacheDirs returns .next directory", () => {
		expect(new NextraRenderer().getCacheDirs("/build")).toEqual(["/build/.next"]);
	});

	it("generateNavigation delegates to generateMetaFiles", async () => {
		const { generateMetaFiles } = await import("../MetaGenerator.js");
		const sidebar = { "/": { intro: "Intro" } };
		await new NextraRenderer().generateNavigation("/content", sidebar);
		expect(generateMetaFiles).toHaveBeenCalledWith("/content", sidebar);
	});

	it("getContentRules returns safe import prefixes including nextra and react", () => {
		const rules = new NextraRenderer().getContentRules();
		expect(rules.safeImportPrefixes).toContain("nextra");
		expect(rules.safeImportPrefixes).toContain("react");
		expect(rules.providedComponents.has("Callout")).toBe(true);
		expect(rules.providedComponents.has("Fragment")).toBe(true);
	});

	it("does not advertise swagger-ui-react as a safe import (Phase 3 dropped it)", () => {
		expect(new NextraRenderer().getContentRules().safeImportPrefixes).not.toContain("swagger-ui-react");
	});

	it("runBuild delegates to runNpmBuild", async () => {
		const { runNpmBuild } = await import("../NpmRunner.js");
		await new NextraRenderer().runBuild("/build");
		expect(runNpmBuild).toHaveBeenCalledWith("/build");
	});

	it("runDev delegates to runNpmDev", async () => {
		const { runNpmDev } = await import("../NpmRunner.js");
		await new NextraRenderer().runDev("/build", true);
		expect(runNpmDev).toHaveBeenCalledWith("/build", true);
	});

	it("createOutputFilter delegates to the OutputFilter module", async () => {
		const { createOutputFilter } = await import("../OutputFilter.js");
		new NextraRenderer().createOutputFilter(true);
		expect(createOutputFilter).toHaveBeenCalledWith(true);
	});

	it("extractPageCount parses Next.js static page generation output", () => {
		expect(new NextraRenderer().extractPageCount("Generating static pages (0/10)\n(10/10)")).toBe(10);
	});

	it("extractPageCount returns undefined for non-matching output", () => {
		expect(new NextraRenderer().extractPageCount("Build complete")).toBeUndefined();
	});
});

// ─── renderOpenApiSpecs (writes the emitter's output to disk) ───────────────

describe("NextraRenderer.renderOpenApiSpecs", () => {
	let buildDir: string;
	let contentDir: string;
	let publicDir: string;

	beforeEach(async () => {
		buildDir = await mkdtemp(join(tmpdir(), "jolli-nextra-build-"));
		contentDir = join(buildDir, "content");
		publicDir = join(buildDir, "public");
	});

	afterEach(async () => {
		await rm(buildDir, { recursive: true, force: true });
	});

	it("writes the overview MDX at content/api-{specName}/index.mdx", async () => {
		await new NextraRenderer().renderOpenApiSpecs(contentDir, publicDir, [makeSpecInput()]);

		const mdx = await readFile(join(contentDir, "api-petstore", "index.mdx"), "utf-8");
		expect(mdx).toContain("# Pet Store");
		expect(mdx).toContain("Version: `1.0.0`");
	});

	it("writes the spec-wide _refs.ts file", async () => {
		await new NextraRenderer().renderOpenApiSpecs(contentDir, publicDir, [makeSpecInput()]);
		const refs = await readFile(join(contentDir, "api-petstore", "_refs.ts"), "utf-8");
		expect(refs).toContain("export default REFS");
	});

	it("writes one MDX shim and one JSON sidecar per operation", async () => {
		await new NextraRenderer().renderOpenApiSpecs(contentDir, publicDir, [makeSpecInput()]);

		expect(existsSync(join(contentDir, "api-petstore", "pets", "listpets.mdx"))).toBe(true);
		expect(existsSync(join(contentDir, "api-petstore", "_data", "listpets.json"))).toBe(true);
	});

	it("writes the spec-folder _meta.ts and one _meta.ts per tag folder", async () => {
		await new NextraRenderer().renderOpenApiSpecs(contentDir, publicDir, [makeSpecInput()]);

		const topMeta = await readFile(join(contentDir, "api-petstore", "_meta.ts"), "utf-8");
		expect(topMeta).toContain("index: 'Overview'");
		expect(topMeta).toContain("'pets': 'pets'");

		const tagMeta = await readFile(join(contentDir, "api-petstore", "pets", "_meta.ts"), "utf-8");
		expect(tagMeta).toContain("'listpets':");
	});

	it("does not write components/api/ — those are scaffold written by initProject", async () => {
		await new NextraRenderer().renderOpenApiSpecs(contentDir, publicDir, [makeSpecInput()]);
		expect(existsSync(join(buildDir, "components"))).toBe(false);
	});

	it("writes per-spec output for each input when given multiple specs", async () => {
		await new NextraRenderer().renderOpenApiSpecs(contentDir, publicDir, [
			makeSpecInput({ specName: "petstore" }),
			makeSpecInput({ specName: "users" }),
		]);

		expect(existsSync(join(contentDir, "api-petstore", "index.mdx"))).toBe(true);
		expect(existsSync(join(contentDir, "api-users", "index.mdx"))).toBe(true);
	});

	it("emits no files when given an empty specs array", async () => {
		await new NextraRenderer().renderOpenApiSpecs(contentDir, publicDir, []);

		expect(existsSync(join(buildDir, "content"))).toBe(false);
		expect(existsSync(join(buildDir, "components"))).toBe(false);
	});
});
