/**
 * OpenApiRenderer — generates `.mdx` pages for OpenAPI files.
 *
 * Validates OpenAPI content by checking for the `openapi` version field and
 * `info` object, then generates MDX pages that embed a Swagger UI React
 * component for interactive API documentation rendering.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

// ─── isValidOpenApiContent ────────────────────────────────────────────────────

/**
 * Returns `true` if the given content looks like a valid OpenAPI document.
 *
 * For JSON: parses and checks for top-level `openapi` and `info` keys.
 * For YAML: uses a simple line-based check for `openapi:` and `info:` at the
 *           start of a line (no full YAML parser required).
 *
 * @param content - The raw file content as a string.
 * @param ext     - The file extension including the dot (e.g. `.yaml`, `.json`).
 */
export function isValidOpenApiContent(content: string, ext: string): boolean {
	const normalizedExt = ext.toLowerCase();

	if (normalizedExt === ".json") {
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			return typeof parsed === "object" && parsed !== null && "openapi" in parsed && "info" in parsed;
		} catch {
			return false;
		}
	}

	// YAML / YML — simple line-based check
	if (normalizedExt === ".yaml" || normalizedExt === ".yml") {
		const hasOpenapi = /^openapi\s*:/m.test(content);
		const hasInfo = /^info\s*:/m.test(content);
		return hasOpenapi && hasInfo;
	}

	return false;
}

// ─── generateOpenApiMdx ───────────────────────────────────────────────────────

/**
 * Generates the content of an MDX page that embeds a Swagger UI component
 * pointing at the given OpenAPI file.
 *
 * The generated page:
 * - Imports `SwaggerUI` from `swagger-ui-react`
 * - Imports the Swagger UI CSS
 * - Renders `<SwaggerUI url="<relPath>" />` so the browser fetches the spec
 *
 * @param openapiFilePath - Absolute path to the source OpenAPI file (unused in
 *                          the MDX body but kept for future use / logging).
 * @param relPath         - Relative path from the source root, used to build
 *                          the URL passed to SwaggerUI (e.g. `api/openapi.yaml`).
 */
export function generateOpenApiMdx(openapiFilePath: string, relPath: string): string {
	// Normalise to forward slashes for URLs regardless of OS path separator
	const urlPath = relPath.replace(/\\/g, "/");

	// Suppress unused-variable lint warning — openapiFilePath is part of the
	// public API signature and may be used by callers for logging.
	void openapiFilePath;

	return `import SwaggerUI from 'swagger-ui-react'
import 'swagger-ui-react/swagger-ui.css'

<SwaggerUI url="/${urlPath}" />
`;
}

// ─── renderOpenApiFiles ───────────────────────────────────────────────────────

/**
 * For each OpenAPI file in `openapiFiles` (relative paths from `sourceRoot`):
 *
 * 1. Reads the file content from `sourceRoot`.
 * 2. Validates it with `isValidOpenApiContent`.
 * 3. If invalid: logs a warning with `console.warn` and skips the file.
 * 4. If valid: generates an MDX page and writes it to `contentDir` at the same
 *    relative path but with the `.mdx` extension (replacing the original ext).
 *
 * Always overwrites an existing `.mdx` file so that re-running `jolli start`
 * picks up changes to the source OpenAPI file (Requirement 6.5).
 *
 * @param sourceRoot   - Absolute path to the Content_Folder root.
 * @param contentDir     - Absolute path to the Nextra `content/` directory.
 * @param openapiFiles - Relative paths (from `sourceRoot`) of OpenAPI files.
 * @param publicDir    - Absolute path to the `public/` directory where raw
 *                       OpenAPI files are copied so SwaggerUI can fetch them.
 */
export async function renderOpenApiFiles(
	sourceRoot: string,
	contentDir: string,
	openapiFiles: string[],
	publicDir?: string,
): Promise<void> {
	for (const relPath of openapiFiles) {
		const absolutePath = join(sourceRoot, relPath);
		const ext = extname(relPath);

		// Read the source file
		let content: string;
		try {
			content = await readFile(absolutePath, "utf-8");
		} catch (err) {
			console.warn(`[jolli] Warning: could not read OpenAPI file "${relPath}": ${String(err)}`);
			continue;
		}

		// Validate the content
		if (!isValidOpenApiContent(content, ext)) {
			console.warn(
				`[jolli] Warning: "${relPath}" does not appear to be a valid OpenAPI file (missing "openapi" version field or "info" object). Skipping.`,
			);
			continue;
		}

		// Derive the .mdx output path (replace original extension with .mdx)
		const mdxRelPath = `${relPath.slice(0, relPath.length - ext.length)}.mdx`;
		const mdxAbsPath = join(contentDir, mdxRelPath);

		// Ensure the parent directory exists
		const mdxDir = dirname(mdxAbsPath);
		await mkdir(mdxDir, { recursive: true });

		// Generate and write the MDX page (always overwrite for incremental updates)
		const mdxContent = generateOpenApiMdx(absolutePath, relPath);
		await writeFile(mdxAbsPath, mdxContent, "utf-8");

		// Copy the raw OpenAPI file to public/ so SwaggerUI can fetch it at runtime
		if (publicDir) {
			const publicPath = join(publicDir, relPath);
			const publicFileDir = dirname(publicPath);
			await mkdir(publicFileDir, { recursive: true });
			await copyFile(absolutePath, publicPath);
		}
	}
}
