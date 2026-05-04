/**
 * NextraRenderer — SiteRenderer implementation for Nextra v4.
 *
 * Thin wrapper that delegates to the existing site modules:
 * NextraProjectWriter, MetaGenerator, OpenApiRenderer, NpmRunner, OutputFilter.
 */

import { join } from "node:path";
import { generateMetaFiles } from "../MetaGenerator.js";
import { initNextraProject } from "../NextraProjectWriter.js";
import { runNpmBuild, runNpmDev, type ServerResult } from "../NpmRunner.js";
import { renderOpenApiFiles as renderOpenApi } from "../OpenApiRenderer.js";
import type { OutputFilter } from "../OutputFilter.js";
import { createOutputFilter as createFilter } from "../OutputFilter.js";
import type { NpmRunResult, SidebarOverrides, SiteJson } from "../Types.js";
import type { ContentRules, SiteRenderer } from "./SiteRenderer.js";

// ─── Nextra-specific constants ──────────────────────────────────────────────

const SAFE_IMPORT_PREFIXES = ["nextra", "nextra-theme-docs", "next/", "next-themes", "react", "swagger-ui-react"];

const PROVIDED_COMPONENTS = new Set(["Fragment", "Callout", "Cards", "Card", "FileTree", "Steps", "Tabs", "Tab"]);

const PAGE_COUNT_PATTERN = /Generating static pages.*?(\d+)\/(\d+)/s;

// ─── NextraRenderer ─────────────────────────────────────────────────────────

export class NextraRenderer implements SiteRenderer {
	readonly name = "nextra";

	async initProject(
		buildDir: string,
		config: SiteJson,
		options: { staticExport?: boolean },
	): Promise<{ isNew: boolean }> {
		return initNextraProject(buildDir, config, options);
	}

	getCacheDirs(buildDir: string): string[] {
		return [join(buildDir, ".next")];
	}

	async generateNavigation(contentDir: string, sidebar?: SidebarOverrides): Promise<void> {
		await generateMetaFiles(contentDir, sidebar);
	}

	async renderOpenApiFiles(
		sourceRoot: string,
		contentDir: string,
		openapiFiles: string[],
		publicDir?: string,
	): Promise<void> {
		await renderOpenApi(sourceRoot, contentDir, openapiFiles, publicDir);
	}

	getContentRules(): ContentRules {
		return {
			safeImportPrefixes: SAFE_IMPORT_PREFIXES,
			providedComponents: PROVIDED_COMPONENTS,
		};
	}

	async runBuild(buildDir: string): Promise<NpmRunResult> {
		return runNpmBuild(buildDir);
	}

	async runDev(buildDir: string, verbose?: boolean): Promise<ServerResult> {
		return runNpmDev(buildDir, verbose);
	}

	createOutputFilter(verbose: boolean): OutputFilter {
		return createFilter(verbose);
	}

	extractPageCount(buildOutput: string): number | undefined {
		const match = buildOutput.match(PAGE_COUNT_PATTERN);
		return match ? Number.parseInt(match[2], 10) : undefined;
	}
}
