/**
 * SiteRenderer — abstraction over the documentation framework used to
 * build the final site.
 *
 * Each renderer implements framework-specific scaffolding, navigation,
 * OpenAPI rendering, build/dev commands, and output filtering.
 * The pipeline in StartCommand calls these methods instead of
 * framework-specific functions directly.
 */

import type { RootInjectionInput } from "../MetaGenerator.js";
import type { ServerResult } from "../NpmRunner.js";
import type { OutputFilter } from "../OutputFilter.js";
import type { OpenApiPipelineResult } from "../openapi/Types.js";
import type { NpmRunResult, SidebarOverrides, SiteJson } from "../Types.js";

// ─── ContentRules ───────────────────────────────────────────────────────────

/**
 * Renderer-specific content rules used by ContentMirror to decide
 * which imports and components are safe in MDX files.
 */
export interface ContentRules {
	/** Package prefixes that are safe to import (e.g. ["nextra", "react"]) */
	safeImportPrefixes: string[];
	/** Component names provided by the framework that don't need imports */
	providedComponents: Set<string>;
}

// ─── OpenApiSpecInput ───────────────────────────────────────────────────────

/**
 * One OpenAPI spec ready for emission. Built once by StartCommand from the
 * raw documents `ContentMirror` cached, so renderers receive a parsed,
 * walked, sample-augmented IR and never re-parse the source file.
 */
export interface OpenApiSpecInput {
	/**
	 * URL slug used in `/api-{specName}/...` routes and in folder names
	 * under `content/`. Derived from the source file's basename via
	 * `deriveSpecName`.
	 */
	specName: string;
	/**
	 * Source-folder relative path (e.g. `api/petstore.yaml`). Useful for
	 * diagnostics; emitters do not need to read the source file again.
	 */
	sourceRelPath: string;
	/** Pre-built parser + per-operation code samples. */
	pipeline: OpenApiPipelineResult;
}

// ─── SiteRenderer ───────────────────────────────────────────────────────────

export interface SiteRenderer {
	/** Human-readable name (e.g. "nextra") */
	readonly name: string;

	/**
	 * Initialize (or update) the build project scaffold in `buildDir`.
	 * Creates package.json, config files, layout files, etc.
	 */
	initProject(buildDir: string, config: SiteJson, options: { staticExport?: boolean }): Promise<{ isNew: boolean }>;

	/**
	 * Returns paths that should be cleared between runs
	 * (framework caches, e.g. ".next" for Nextra).
	 */
	getCacheDirs(buildDir: string): string[];

	/**
	 * Generate navigation / sidebar files from the content-directory structure
	 * and sidebar overrides. `rootInjection` carries detected OpenAPI specs
	 * and `header.items` from `site.json` so the renderer can materialise
	 * `Documentation` / `API Reference` page tabs and customer header tabs
	 * as native Nextra navbar entries (chevron, hover, mobile drawer).
	 */
	generateNavigation(
		contentDir: string,
		sidebar?: SidebarOverrides,
		rootInjection?: RootInjectionInput,
	): Promise<void>;

	/**
	 * Render OpenAPI specs into framework-appropriate pages. Each input
	 * carries a pre-built pipeline (parsed spec + per-operation code
	 * samples), so this method only emits — it never parses, walks, or
	 * generates samples itself.
	 *
	 * @param contentDir - Absolute path to the framework's content/ root.
	 * @param publicDir  - Absolute path to the framework's public/ root.
	 * @param specs      - One entry per OpenAPI source file detected in
	 *                     the user's docs folder.
	 */
	renderOpenApiSpecs(contentDir: string, publicDir: string, specs: OpenApiSpecInput[]): Promise<void>;

	/**
	 * Content rules for ContentMirror's import/component compatibility checks.
	 */
	getContentRules(): ContentRules;

	/**
	 * Run the production build command.
	 */
	runBuild(buildDir: string): Promise<NpmRunResult>;

	/**
	 * Run the dev server command.
	 */
	runDev(buildDir: string, verbose?: boolean): Promise<ServerResult>;

	/**
	 * Create an output filter for this renderer's build/dev output.
	 */
	createOutputFilter(verbose: boolean): OutputFilter;

	/**
	 * Extract page count from build output (renderer-specific log format).
	 * Returns undefined if not parseable.
	 */
	extractPageCount(buildOutput: string): number | undefined;
}
