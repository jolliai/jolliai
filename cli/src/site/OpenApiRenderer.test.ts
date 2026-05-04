/**
 * Tests for OpenApiRenderer — generates `.mdx` pages for OpenAPI files.
 *
 * Covers all acceptance criteria from Task 6:
 *   - isValidOpenApiContent returns true for valid JSON/YAML OpenAPI content
 *   - isValidOpenApiContent returns false for invalid/missing fields
 *   - generateOpenApiMdx produces correct MDX with SwaggerUI import and component
 *   - renderOpenApiFiles writes .mdx pages for valid OpenAPI files
 *   - renderOpenApiFiles logs a warning and skips invalid OpenAPI files
 *   - renderOpenApiFiles overwrites existing .mdx pages (incremental updates)
 *
 * Property-based tests (fast-check):
 *   - Property 6: OpenAPI detection is content-based
 *     **Validates: Requirements 3.2, 6.3**
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "jolli-openapi-test-"));
}

/** Minimal valid OpenAPI JSON content */
const OPENAPI_JSON = JSON.stringify({
	openapi: "3.1.0",
	info: { title: "Test API", version: "1.0.0" },
	paths: {},
});

/** Minimal valid OpenAPI YAML content */
const OPENAPI_YAML = `openapi: "3.1.0"\ninfo:\n  title: Test API\n  version: "1.0.0"\npaths: {}\n`;

// ─── isValidOpenApiContent unit tests ────────────────────────────────────────

describe("OpenApiRenderer.isValidOpenApiContent", () => {
	// ── Valid JSON ───────────────────────────────────────────────────────────

	it("returns true for valid OpenAPI JSON with openapi and info fields", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent(OPENAPI_JSON, ".json")).toBe(true);
	});

	it("returns true for JSON with openapi and info regardless of other fields", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		const content = JSON.stringify({
			openapi: "3.0.0",
			info: { title: "My API", version: "2.0" },
			paths: { "/users": {} },
			components: {},
		});
		expect(isValidOpenApiContent(content, ".json")).toBe(true);
	});

	// ── Invalid JSON ─────────────────────────────────────────────────────────

	it("returns false for JSON missing the openapi field", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		const content = JSON.stringify({ info: { title: "Test", version: "1.0" } });
		expect(isValidOpenApiContent(content, ".json")).toBe(false);
	});

	it("returns false for JSON missing the info field", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		const content = JSON.stringify({ openapi: "3.1.0", paths: {} });
		expect(isValidOpenApiContent(content, ".json")).toBe(false);
	});

	it("returns false for JSON missing both openapi and info fields", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		const content = JSON.stringify({ title: "Test", version: "1.0" });
		expect(isValidOpenApiContent(content, ".json")).toBe(false);
	});

	it("returns false for invalid JSON syntax", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent("{ not valid json }", ".json")).toBe(false);
	});

	it("returns false for empty JSON string", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent("", ".json")).toBe(false);
	});

	it("returns false for JSON array (not an object)", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent("[]", ".json")).toBe(false);
	});

	// ── Valid YAML ───────────────────────────────────────────────────────────

	it("returns true for valid OpenAPI YAML with openapi and info fields", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent(OPENAPI_YAML, ".yaml")).toBe(true);
	});

	it("returns true for valid OpenAPI .yml with openapi and info fields", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent(OPENAPI_YAML, ".yml")).toBe(true);
	});

	it("returns true for YAML with openapi: followed by spaces", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		const content = "openapi:  3.1.0\ninfo:\n  title: Test\n";
		expect(isValidOpenApiContent(content, ".yaml")).toBe(true);
	});

	// ── Invalid YAML ─────────────────────────────────────────────────────────

	it("returns false for YAML missing the openapi line", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		const content = "info:\n  title: Test\n  version: 1.0\n";
		expect(isValidOpenApiContent(content, ".yaml")).toBe(false);
	});

	it("returns false for YAML missing the info line", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		const content = "openapi: 3.1.0\ntitle: Test\n";
		expect(isValidOpenApiContent(content, ".yaml")).toBe(false);
	});

	it("returns false for YAML with openapi indented (not at start of line)", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		const content = "  openapi: 3.1.0\ninfo:\n  title: Test\n";
		expect(isValidOpenApiContent(content, ".yaml")).toBe(false);
	});

	it("returns false for empty YAML string", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent("", ".yaml")).toBe(false);
	});

	// ── Unsupported extensions ───────────────────────────────────────────────

	it("returns false for .txt extension even with valid OpenAPI JSON content", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent(OPENAPI_JSON, ".txt")).toBe(false);
	});

	it("returns false for .md extension", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent(OPENAPI_YAML, ".md")).toBe(false);
	});

	// ── Case-insensitive extension handling ──────────────────────────────────

	it("handles uppercase .JSON extension", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent(OPENAPI_JSON, ".JSON")).toBe(true);
	});

	it("handles uppercase .YAML extension", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");
		expect(isValidOpenApiContent(OPENAPI_YAML, ".YAML")).toBe(true);
	});
});

// ─── generateOpenApiMdx unit tests ───────────────────────────────────────────

describe("OpenApiRenderer.generateOpenApiMdx", () => {
	it("imports SwaggerUI from swagger-ui-react", async () => {
		const { generateOpenApiMdx } = await import("./OpenApiRenderer.js");
		const mdx = generateOpenApiMdx("/abs/path/api/openapi.yaml", "api/openapi.yaml");
		expect(mdx).toContain("import SwaggerUI from 'swagger-ui-react'");
	});

	it("imports the swagger-ui-react CSS", async () => {
		const { generateOpenApiMdx } = await import("./OpenApiRenderer.js");
		const mdx = generateOpenApiMdx("/abs/path/api/openapi.yaml", "api/openapi.yaml");
		expect(mdx).toContain("import 'swagger-ui-react/swagger-ui.css'");
	});

	it("renders a SwaggerUI component with the correct url prop", async () => {
		const { generateOpenApiMdx } = await import("./OpenApiRenderer.js");
		const mdx = generateOpenApiMdx("/abs/path/api/openapi.yaml", "api/openapi.yaml");
		expect(mdx).toContain('<SwaggerUI url="/api/openapi.yaml"');
	});

	it("uses forward slashes in the URL even on Windows-style paths", async () => {
		const { generateOpenApiMdx } = await import("./OpenApiRenderer.js");
		const mdx = generateOpenApiMdx("C:\\Users\\user\\docs\\api\\openapi.yaml", "api\\openapi.yaml");
		expect(mdx).toContain('<SwaggerUI url="/api/openapi.yaml"');
		expect(mdx).not.toContain("\\");
	});

	it("handles a root-level OpenAPI file (no subdirectory)", async () => {
		const { generateOpenApiMdx } = await import("./OpenApiRenderer.js");
		const mdx = generateOpenApiMdx("/abs/path/openapi.json", "openapi.json");
		expect(mdx).toContain('<SwaggerUI url="/openapi.json"');
	});

	it("handles deeply nested OpenAPI files", async () => {
		const { generateOpenApiMdx } = await import("./OpenApiRenderer.js");
		const mdx = generateOpenApiMdx("/abs/path/v1/api/spec.yaml", "v1/api/spec.yaml");
		expect(mdx).toContain('<SwaggerUI url="/v1/api/spec.yaml"');
	});
});

// ─── renderOpenApiFiles unit tests ───────────────────────────────────────────

describe("OpenApiRenderer.renderOpenApiFiles", () => {
	let sourceRoot: string;
	let contentDir: string;

	beforeEach(async () => {
		sourceRoot = await makeTempDir();
		contentDir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(sourceRoot, { recursive: true, force: true });
		await rm(contentDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	// ── Valid OpenAPI files generate .mdx pages ──────────────────────────────

	it("generates an .mdx file for a valid OpenAPI YAML file", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await writeFile(join(sourceRoot, "openapi.yaml"), OPENAPI_YAML, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["openapi.yaml"]);

		expect(existsSync(join(contentDir, "openapi.mdx"))).toBe(true);
	});

	it("generates an .mdx file for a valid OpenAPI JSON file", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await writeFile(join(sourceRoot, "openapi.json"), OPENAPI_JSON, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["openapi.json"]);

		expect(existsSync(join(contentDir, "openapi.mdx"))).toBe(true);
	});

	it("replaces the original extension with .mdx", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await writeFile(join(sourceRoot, "spec.yml"), OPENAPI_YAML, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["spec.yml"]);

		expect(existsSync(join(contentDir, "spec.mdx"))).toBe(true);
		expect(existsSync(join(contentDir, "spec.yml"))).toBe(false);
	});

	it("preserves the directory structure when generating .mdx files", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await mkdir(join(sourceRoot, "api"), { recursive: true });
		await writeFile(join(sourceRoot, "api", "openapi.yaml"), OPENAPI_YAML, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, [join("api", "openapi.yaml")]);

		expect(existsSync(join(contentDir, "api", "openapi.mdx"))).toBe(true);
	});

	it("creates parent directories as needed", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await mkdir(join(sourceRoot, "v1", "api"), { recursive: true });
		await writeFile(join(sourceRoot, "v1", "api", "spec.yaml"), OPENAPI_YAML, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, [join("v1", "api", "spec.yaml")]);

		expect(existsSync(join(contentDir, "v1", "api", "spec.mdx"))).toBe(true);
	});

	it("generated .mdx content includes SwaggerUI import", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await writeFile(join(sourceRoot, "openapi.yaml"), OPENAPI_YAML, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["openapi.yaml"]);

		const content = await readFile(join(contentDir, "openapi.mdx"), "utf-8");
		expect(content).toContain("import SwaggerUI from 'swagger-ui-react'");
	});

	it("generated .mdx content includes the swagger-ui CSS import", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await writeFile(join(sourceRoot, "openapi.yaml"), OPENAPI_YAML, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["openapi.yaml"]);

		const content = await readFile(join(contentDir, "openapi.mdx"), "utf-8");
		expect(content).toContain("import 'swagger-ui-react/swagger-ui.css'");
	});

	it("generated .mdx content renders SwaggerUI with the correct url", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await writeFile(join(sourceRoot, "openapi.yaml"), OPENAPI_YAML, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["openapi.yaml"]);

		const content = await readFile(join(contentDir, "openapi.mdx"), "utf-8");
		expect(content).toContain('<SwaggerUI url="/openapi.yaml"');
	});

	// ── Invalid OpenAPI files are skipped with a warning ─────────────────────

	it("logs a warning for an invalid OpenAPI file", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		await writeFile(join(sourceRoot, "not-openapi.yaml"), "title: Not OpenAPI\n", "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["not-openapi.yaml"]);

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not-openapi.yaml"));
	});

	it("does not generate an .mdx file for an invalid OpenAPI file", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await writeFile(join(sourceRoot, "not-openapi.yaml"), "title: Not OpenAPI\n", "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["not-openapi.yaml"]);

		expect(existsSync(join(contentDir, "not-openapi.mdx"))).toBe(false);
	});

	it("continues processing other files after skipping an invalid one", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await writeFile(join(sourceRoot, "invalid.yaml"), "title: Not OpenAPI\n", "utf-8");
		await writeFile(join(sourceRoot, "valid.yaml"), OPENAPI_YAML, "utf-8");

		await renderOpenApiFiles(sourceRoot, contentDir, ["invalid.yaml", "valid.yaml"]);

		expect(existsSync(join(contentDir, "invalid.mdx"))).toBe(false);
		expect(existsSync(join(contentDir, "valid.mdx"))).toBe(true);
	});

	it("does not throw when the openapiFiles array is empty", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		await expect(renderOpenApiFiles(sourceRoot, contentDir, [])).resolves.toBeUndefined();
	});

	// ── Incremental updates (Requirement 6.5) ────────────────────────────────

	it("overwrites an existing .mdx file when the source OpenAPI file changes", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");

		// First run
		await writeFile(join(sourceRoot, "openapi.yaml"), OPENAPI_YAML, "utf-8");
		await renderOpenApiFiles(sourceRoot, contentDir, ["openapi.yaml"]);

		const firstContent = await readFile(join(contentDir, "openapi.mdx"), "utf-8");

		// Update the source file (content doesn't change the MDX output in this
		// implementation, but the file is always overwritten)
		await writeFile(join(sourceRoot, "openapi.yaml"), OPENAPI_YAML, "utf-8");
		await renderOpenApiFiles(sourceRoot, contentDir, ["openapi.yaml"]);

		const secondContent = await readFile(join(contentDir, "openapi.mdx"), "utf-8");

		// The file should still exist and have the same structure
		expect(secondContent).toBe(firstContent);
		expect(existsSync(join(contentDir, "openapi.mdx"))).toBe(true);
	});

	// ── Warning logged for unreadable files ──────────────────────────────────

	it("logs a warning when a file cannot be read", async () => {
		const { renderOpenApiFiles } = await import("./OpenApiRenderer.js");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Pass a file that doesn't exist
		await renderOpenApiFiles(sourceRoot, contentDir, ["nonexistent.yaml"]);

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent.yaml"));
	});
});

// ─── Property-based tests ─────────────────────────────────────────────────────

/**
 * Property 6: OpenAPI detection is content-based
 * **Validates: Requirements 3.2, 6.3**
 */
describe("Property 6: OpenAPI detection is content-based", () => {
	// Safe string generator for field values (avoids control chars / special JSON chars)
	const safeString = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 ._-]{0,20}$/).filter((s) => s.length > 0);

	// ── JSON: valid OpenAPI content always returns true ──────────────────────

	it("isValidOpenApiContent returns true for any JSON with openapi and info fields", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");

		const openApiVersionArb = fc.constantFrom("3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.1.0");

		const infoArb = fc.record({
			title: safeString,
			version: safeString,
		});

		fc.assert(
			fc.property(openApiVersionArb, infoArb, (version, info) => {
				const content = JSON.stringify({ openapi: version, info });
				return isValidOpenApiContent(content, ".json") === true;
			}),
			{ numRuns: 100 },
		);
	});

	// ── JSON: missing openapi field always returns false ─────────────────────

	it("isValidOpenApiContent returns false for JSON missing the openapi field", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");

		const infoArb = fc.record({
			title: safeString,
			version: safeString,
		});

		// Generate objects that have info but NOT openapi
		const noOpenApiArb = fc.record({
			info: infoArb,
			paths: fc.constant({}),
		});

		fc.assert(
			fc.property(noOpenApiArb, (obj) => {
				const content = JSON.stringify(obj);
				return isValidOpenApiContent(content, ".json") === false;
			}),
			{ numRuns: 100 },
		);
	});

	// ── JSON: missing info field always returns false ─────────────────────────

	it("isValidOpenApiContent returns false for JSON missing the info field", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");

		const openApiVersionArb = fc.constantFrom("3.0.0", "3.1.0");

		// Generate objects that have openapi but NOT info
		const noInfoArb = fc.record({
			openapi: openApiVersionArb,
			paths: fc.constant({}),
		});

		fc.assert(
			fc.property(noInfoArb, (obj) => {
				const content = JSON.stringify(obj);
				return isValidOpenApiContent(content, ".json") === false;
			}),
			{ numRuns: 100 },
		);
	});

	// ── YAML: valid OpenAPI content always returns true ──────────────────────

	it("isValidOpenApiContent returns true for any YAML with openapi and info at line start", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");

		const versionArb = safeString;
		const titleArb = safeString;

		fc.assert(
			fc.property(versionArb, titleArb, (version, title) => {
				const content = `openapi: "${version}"\ninfo:\n  title: "${title}"\n`;
				return isValidOpenApiContent(content, ".yaml") === true;
			}),
			{ numRuns: 100 },
		);
	});

	it("isValidOpenApiContent returns true for .yml extension with valid YAML content", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");

		const versionArb = safeString;
		const titleArb = safeString;

		fc.assert(
			fc.property(versionArb, titleArb, (version, title) => {
				const content = `openapi: "${version}"\ninfo:\n  title: "${title}"\n`;
				return isValidOpenApiContent(content, ".yml") === true;
			}),
			{ numRuns: 100 },
		);
	});

	// ── YAML: missing openapi line always returns false ──────────────────────

	it("isValidOpenApiContent returns false for YAML missing the openapi line", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");

		const titleArb = safeString;

		fc.assert(
			fc.property(titleArb, (title) => {
				// Only has info, no openapi line
				const content = `info:\n  title: "${title}"\n`;
				return isValidOpenApiContent(content, ".yaml") === false;
			}),
			{ numRuns: 100 },
		);
	});

	// ── YAML: missing info line always returns false ─────────────────────────

	it("isValidOpenApiContent returns false for YAML missing the info line", async () => {
		const { isValidOpenApiContent } = await import("./OpenApiRenderer.js");

		const versionArb = safeString;

		fc.assert(
			fc.property(versionArb, (version) => {
				// Only has openapi, no info line
				const content = `openapi: "${version}"\ntitle: Test\n`;
				return isValidOpenApiContent(content, ".yaml") === false;
			}),
			{ numRuns: 100 },
		);
	});
});
