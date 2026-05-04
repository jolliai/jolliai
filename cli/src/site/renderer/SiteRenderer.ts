/**
 * SiteRenderer — abstraction over the documentation framework used to
 * build the final site.
 *
 * Each renderer implements framework-specific scaffolding, navigation,
 * OpenAPI rendering, build/dev commands, and output filtering.
 * The pipeline in StartCommand calls these methods instead of
 * framework-specific functions directly.
 */

import type { ServerResult } from "../NpmRunner.js";
import type { OutputFilter } from "../OutputFilter.js";
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
	 * Generate navigation/sidebar files from the content directory
	 * structure and sidebar overrides.
	 */
	generateNavigation(contentDir: string, sidebar?: SidebarOverrides): Promise<void>;

	/**
	 * Render OpenAPI spec files into framework-appropriate pages.
	 */
	renderOpenApiFiles(
		sourceRoot: string,
		contentDir: string,
		openapiFiles: string[],
		publicDir?: string,
	): Promise<void>;

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
