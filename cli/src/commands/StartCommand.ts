/**
 * StartCommand — Registers `jolli start`, `jolli build`, and `jolli dev`.
 *
 * Output is concise by default. Use `--verbose` for detailed logs.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { resolveFavicon } from "../site/AssetResolver.js";
import { applyPathMapping, clearDir, mirrorContent } from "../site/ContentMirror.js";
import {
	applyNavigationContentPlan,
	buildNavigationContentPlan,
	validateNavigationPaths,
} from "../site/ContentPlanner.js";
import type { RootApiSpec, RootInjectionInput } from "../site/MetaGenerator.js";
import { needsInstall, runNpmInstall, runNpmStart } from "../site/NpmRunner.js";
import { buildPipeline } from "../site/openapi/OpenApiPipeline.js";
import { deriveSpecName } from "../site/openapi/SpecName.js";
import { runPagefind } from "../site/PagefindRunner.js";
import { resolveRenderer, type SiteRenderer } from "../site/renderer/index.js";
import type { OpenApiSpecInput } from "../site/renderer/SiteRenderer.js";
import { readSiteJson } from "../site/SiteJsonReader.js";
import { startSourceWatcher } from "../site/SourceWatcher.js";
import { parseNavigation } from "../site/StructureParser.js";
import type { HeaderItem, NavLink, PathMappings } from "../site/Types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getBuildDir(sourceRoot: string): string {
	const absPath = resolve(sourceRoot);
	const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 12);
	return join(homedir(), ".jolli", "sites", hash);
}

/** Logs only when verbose is true. */
function verbose(msg: string, isVerbose: boolean): void {
	if (isVerbose) console.log(msg);
}

interface CmdOpts {
	migrate?: boolean;
	verbose?: boolean;
	theme?: string;
}

/**
 * Builds the per-spec inputs the renderer's `renderOpenApiSpecs` expects.
 * Reuses the documents `ContentMirror` already cached, runs them through
 * `buildPipeline` once each, and tags each entry with a URL slug derived
 * from the source-file basename. Throws on a `specName` collision —
 * silently dropping a spec would result in missing pages.
 */
interface DeclaredOpenApiPage {
	key: string;
	title: string;
	href: string;
	specPath: string;
	specName: string;
}

function normalizeDeclaredOpenApiPath(specPath: string): string {
	return specPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function buildOpenApiSpecInputs(
	mirrorResult: Awaited<ReturnType<typeof mirrorContent>>,
	declaredOpenApiPages?: DeclaredOpenApiPage[],
	pathMappings?: PathMappings,
): OpenApiSpecInput[] {
	const inputs: OpenApiSpecInput[] = [];
	const claimed = new Map<string, string>();
	const selectedSpecs =
		declaredOpenApiPages && declaredOpenApiPages.length > 0
			? declaredOpenApiPages.map((page) => {
					const normalized = normalizeDeclaredOpenApiPath(page.specPath);
					const mapped = applyPathMapping(normalized, pathMappings);
					const sourceRelPath = mirrorResult.openapiDocs[mapped]
						? mapped
						: mirrorResult.openapiDocs[normalized]
							? normalized
							: undefined;
					if (!sourceRelPath) {
						throw new Error(
							`Declared OpenAPI spec "${page.specPath}" for page "${page.title}" was not found or is not a valid OpenAPI file.`,
						);
					}
					return { sourceRelPath, specName: page.specName, displayTitle: page.title };
				})
			: mirrorResult.openapiFiles.map((sourceRelPath) => ({
					sourceRelPath,
					specName: deriveSpecName(sourceRelPath),
					displayTitle: undefined,
				}));

	for (const selected of selectedSpecs) {
		const { sourceRelPath, specName, displayTitle } = selected;
		const doc = mirrorResult.openapiDocs[sourceRelPath];
		if (!doc) {
			continue;
		}
		const existing = claimed.get(specName);
		if (existing) {
			throw new Error(
				`OpenAPI spec name collision: "${existing}" and "${sourceRelPath}" both resolve to ` +
					`spec slug "${specName}". Rename one of the source files so each spec gets a unique URL.`,
			);
		}
		claimed.set(specName, sourceRelPath);
		inputs.push({ specName, sourceRelPath, pipeline: buildPipeline(doc), displayTitle });
	}
	return inputs;
}

// ─── syncContent ─────────────────────────────────────────────────────────────

/**
 * Reads `site.json`, mirrors the source folder into `contentDir`, fixes the
 * sidebar's index key if a file was renamed, regenerates navigation, and
 * re-renders OpenAPI specs. Used by both the initial `prepareContent` and
 * the dev-mode source watcher (which calls it on every settled change so
 * `next dev`'s HMR sees the latest output).
 *
 * Side effects this function does NOT do — they're scaffolding-only and
 * belong to `prepareContent`: `initProject`, clearing the public dir,
 * resolving favicon, npm install.
 */
async function syncContent(
	sourceRoot: string,
	contentDir: string,
	publicDir: string,
	renderer: SiteRenderer,
	opts: CmdOpts,
): Promise<{ success: false } | { success: true; mirrorResult: Awaited<ReturnType<typeof mirrorContent>> }> {
	let siteJsonResult: Awaited<ReturnType<typeof readSiteJson>>;
	try {
		siteJsonResult = await readSiteJson(sourceRoot, { migrate: opts.migrate });
	} catch (err) {
		console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
		return { success: false };
	}

	const mirrorResult = await mirrorContent(
		sourceRoot,
		contentDir,
		siteJsonResult.config.pathMappings,
		publicDir,
		renderer.getContentRules(),
	);
	const parsedNavigation = siteJsonResult.config.navigation
		? parseNavigation(siteJsonResult.config.navigation)
		: undefined;

	if (siteJsonResult.config.navigation) {
		// Validate navigation paths against source files before building
		const mismatches = validateNavigationPaths(siteJsonResult.config.navigation, mirrorResult.markdownFiles);
		if (mismatches.length > 0) {
			console.warn("\n  ⚠ Navigation path mismatches found in site.json:\n");
			for (const m of mismatches) {
				console.warn(`    ✗ "${m.label}" → ${m.expectedPath}`);
				console.warn(`      ${m.suggestion}\n`);
			}
		}

		const plan = buildNavigationContentPlan(siteJsonResult.config.navigation, mirrorResult.markdownFiles);
		try {
			mirrorResult.markdownFiles = await applyNavigationContentPlan(
				sourceRoot,
				contentDir,
				mirrorResult.markdownFiles,
				plan,
				renderer.getContentRules(),
			);
		} catch (err) {
			console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
			return { success: false };
		}
	}

	// Fix sidebar index key if a file was renamed during mirror.
	const sidebar = siteJsonResult.config.sidebar;
	if (mirrorResult.renamedToIndex && sidebar?.["/"]?.[mirrorResult.renamedToIndex]) {
		const label = sidebar["/"][mirrorResult.renamedToIndex];
		delete sidebar["/"][mirrorResult.renamedToIndex];
		sidebar["/"] = { index: label, ...sidebar["/"] };
	}

	let specInputs: OpenApiSpecInput[] | undefined;

	if (mirrorResult.openapiFiles.length > 0) {
		try {
			specInputs = buildOpenApiSpecInputs(
				mirrorResult,
				parsedNavigation?.openapiPages,
				siteJsonResult.config.pathMappings,
			);
		} catch (err) {
			// Spec-name collisions throw with a clear "Rename one of the source
			// files" message. In the dev watcher, an uncaught throw becomes an
			// unhandled promise rejection that crashes the process; in the
			// initial pass it short-circuits before the watcher even starts.
			// Either way, surface the message and let the caller decide whether
			// to retry on the next change.
			console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
			return { success: false };
		}
		await renderer.renderOpenApiSpecs(contentDir, publicDir, specInputs);
	}

	// Navigation generation. Priority: navigation > sidebar (legacy).
	// When neither navigation nor sidebar is set, the sidebar is empty
	// (matches web tool strict-mode behavior).
	const rootInjection = buildRootInjectionInput(
		siteJsonResult.config.header?.items,
		siteJsonResult.config.nav,
		mirrorResult,
		specInputs,
	);

	if (parsedNavigation) {
		if (parsedNavigation.rootPages?.length) {
			rootInjection.structurePages = parsedNavigation.rootPages;
		} else {
			// Simple mode — no pages, suppress type:"page" auto-injection
			rootInjection.simpleMode = true;
		}
		if (parsedNavigation.defaultPageHref) {
			rootInjection.defaultPageHref = parsedNavigation.defaultPageHref;
		}
		await renderer.generateNavigation(contentDir, parsedNavigation.sidebar, rootInjection);
	} else if (sidebar && Object.keys(sidebar).length > 0) {
		// Legacy sidebar overrides
		await renderer.generateNavigation(contentDir, sidebar, rootInjection);
	} else {
		// No navigation, no sidebar — empty sidebar (no filesystem auto-discovery)
		rootInjection.simpleMode = true;
		await renderer.generateNavigation(contentDir, {}, rootInjection);
	}

	return { success: true, mirrorResult };
}

/**
 * Builds the `RootInjectionInput` from header config + detected specs.
 * Used by both initial render and the dev watcher.
 *
 * Falls back to coercing the legacy `nav` shorthand into dropdown-less
 * header items when `header.items` is empty/missing — matches the documented
 * `nav` semantics in `Types.ts` so existing CLI sites with only a flat
 * `nav: [...]` block keep rendering navbar tabs after the move from JSX
 * navbar children to Nextra-native page-tabs.
 */
export function buildRootInjectionInput(
	headerItems: HeaderItem[] | undefined,
	legacyNav: NavLink[] | undefined,
	mirrorResult: Awaited<ReturnType<typeof mirrorContent>>,
	specInputs?: OpenApiSpecInput[],
): RootInjectionInput {
	const apiSpecs: RootApiSpec[] =
		specInputs && specInputs.length > 0
			? specInputs.map((spec) => ({
					specName: spec.specName,
					title:
						typeof spec.displayTitle === "string" && spec.displayTitle.trim().length > 0
							? spec.displayTitle
							: typeof mirrorResult.openapiDocs[spec.sourceRelPath]?.info?.title === "string"
								? mirrorResult.openapiDocs[spec.sourceRelPath]?.info?.title
								: undefined,
				}))
			: mirrorResult.openapiFiles.map((relPath) => {
					const doc = mirrorResult.openapiDocs[relPath];
					const title = typeof doc?.info?.title === "string" ? doc.info.title : undefined;
					return { specName: deriveSpecName(relPath), title };
				});
	const effectiveHeaderItems =
		headerItems && headerItems.length > 0
			? headerItems
			: legacyNav && legacyNav.length > 0
				? legacyNav.map((n) => ({ label: n.label, url: n.href }))
				: undefined;
	return { apiSpecs, headerItems: effectiveHeaderItems };
}

// ─── prepareContent ──────────────────────────────────────────────────────────

async function prepareContent(
	sourceRoot: string,
	buildDir: string,
	contentDir: string,
	publicDir: string,
	staticExport: boolean,
	opts: CmdOpts = {},
): Promise<
	| { success: false }
	| { success: true; mirrorResult: Awaited<ReturnType<typeof mirrorContent>>; renderer: SiteRenderer }
> {
	const v = opts.verbose === true;

	if (!existsSync(sourceRoot)) {
		console.error(`  Error: Source root does not exist: ${sourceRoot}`);
		process.exitCode = 1;
		return { success: false };
	}

	// Read site.json
	verbose("Reading site.json…", v);
	let siteJsonResult: Awaited<ReturnType<typeof readSiteJson>>;
	try {
		siteJsonResult = await readSiteJson(sourceRoot, { migrate: opts.migrate });
	} catch (err) {
		console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
		return { success: false };
	}
	console.log("  ✓ Loaded site config");

	// Resolve renderer from config
	let renderer: SiteRenderer;
	try {
		renderer = resolveRenderer(siteJsonResult.config);
	} catch (err) {
		console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
		return { success: false };
	}

	// Extract navigation data for the layout (before initProject).
	const configAny = siteJsonResult.config as Record<string, unknown>;
	if (siteJsonResult.config.navigation) {
		const parsed = parseNavigation(siteJsonResult.config.navigation);
		if (parsed.rootPages?.length) {
			configAny.structurePages = parsed.rootPages;
		}
		if (parsed.pages?.length && parsed.pages.length >= 2) {
			configAny.navigationPages = parsed.pages;
		}
	}

	// Initialize build directory
	verbose(`Initializing build directory… (${buildDir})`, v);
	await renderer.initProject(buildDir, siteJsonResult.config, {
		staticExport,
		sourceRoot,
		themePath: opts.theme,
	});

	// Clear caches
	await clearDir(publicDir);
	for (const cacheDir of renderer.getCacheDirs(buildDir)) {
		await clearDir(cacheDir);
	}

	// Resolve favicon
	await resolveFavicon(siteJsonResult.config.favicon, sourceRoot, publicDir);

	// Mirror + nav + render OpenAPI specs (shared with the dev watcher).
	verbose("Mirroring content…", v);
	const sync = await syncContent(sourceRoot, contentDir, publicDir, renderer, opts);
	if (!sync.success) {
		process.exitCode = 1;
		return { success: false };
	}
	const { mirrorResult } = sync;

	const total = mirrorResult.markdownFiles.length + mirrorResult.imageFiles.length + mirrorResult.openapiFiles.length;
	const downgraded = mirrorResult.downgradedCount;
	const downgradedSuffix = downgraded > 0 ? ` (${downgraded} downgraded)` : "";
	console.log(`  ✓ Mirrored ${total} files${downgradedSuffix}`);

	if (mirrorResult.markdownFiles.length === 0 && mirrorResult.openapiFiles.length === 0) {
		console.warn("  ⚠ No markdown or OpenAPI files found. Producing an empty site.");
	}

	console.log("  ✓ Generated navigation");

	// Install dependencies
	if (needsInstall(buildDir)) {
		console.log("  Installing dependencies…");
		const installResult = await runNpmInstall(buildDir);
		if (!installResult.success) {
			console.error(v ? installResult.output : "  Error: npm install failed");
			process.exitCode = 1;
			return { success: false };
		}
		console.log("  ✓ Dependencies ready");
	}

	return { success: true, mirrorResult, renderer };
}

// ─── buildAndIndex ───────────────────────────────────────────────────────────

async function buildAndIndex(
	buildDir: string,
	v: boolean,
	renderer: SiteRenderer,
	staticExport = true,
): Promise<{ success: boolean; pagesBuilt?: number }> {
	console.log("  Building site…");
	const buildResult = await renderer.runBuild(buildDir);
	if (!buildResult.success) {
		console.error(v ? buildResult.output : "  Error: Build failed");
		process.exitCode = 1;
		return { success: false };
	}

	// Extract page count from build output
	const pagesBuilt = renderer.extractPageCount(buildResult.output);
	if (pagesBuilt) {
		console.log(`  ✓ Built ${pagesBuilt} pages`);
	} else {
		console.log("  ✓ Built successfully");
	}

	// Pagefind indexes static HTML. For static export it indexes `out/`;
	// for production server mode it indexes `.next/server/app/` (pre-rendered).
	const pagefindSite = staticExport ? "out" : ".next/server/app";
	const pagefindOutput = staticExport ? "out/_pagefind" : "public/_pagefind";
	const pagefindResult = await runPagefind(buildDir, pagefindSite, pagefindOutput);
	if (!pagefindResult.success) {
		console.error(v ? pagefindResult.output : "  Error: Search indexing failed");
		process.exitCode = 1;
		return { success: false };
	}

	const pagesIndexed = pagefindResult.pagesIndexed ?? 0;
	console.log(`  ✓ Indexed ${pagesIndexed} pages for search`);

	return { success: true, pagesBuilt };
}

// ─── Dev-mode search index ──────────────────────────────────────────────────

/**
 * Site path (relative to `buildDir`) that pagefind reads in dev mode. The
 * dev-mode build redirects Next's output to `.next-pagefind/` via the
 * `JOLLI_PAGEFIND_BUILD=1` env flag in `generateNextConfig`, so the rendered
 * pages live one level deeper than the default `.next/server/app`.
 */
const DEV_PAGEFIND_SITE = ".next-pagefind/server/app";

/**
 * Output path (relative to `buildDir`) where pagefind writes the index in dev
 * mode. `next dev` serves the `public/` directory as-is, so writing the index
 * here makes `/_pagefind/pagefind.js` resolve at request time without any
 * webpack involvement.
 */
const DEV_PAGEFIND_OUTPUT = "public/_pagefind";

/**
 * Env passed to the dev-mode `next build` invocation. Read by the generated
 * `next.config.mjs` to redirect the build to `.next-pagefind/` so we never
 * collide with the running dev compiler's `.next/`.
 */
const DEV_PAGEFIND_ENV = { JOLLI_PAGEFIND_BUILD: "1" } as const;

/**
 * Builds the dev-mode search index. Runs a one-shot `next build` into the
 * isolated `.next-pagefind/` directory, then runs pagefind against the
 * resulting HTML and writes the index into `public/_pagefind/`.
 *
 * Both stages can fail without taking the dev server down — search is a
 * nice-to-have in dev, so this function logs and returns a status, never
 * throws.
 */
async function buildDevSearchIndex(
	buildDir: string,
	renderer: SiteRenderer,
	verbose: boolean,
): Promise<{ success: boolean; pagesIndexed?: number; output?: string }> {
	const buildResult = await renderer.runBuild(buildDir, DEV_PAGEFIND_ENV);
	if (!buildResult.success) {
		return { success: false, output: verbose ? buildResult.output : undefined };
	}

	const pagefindResult = await runPagefind(buildDir, DEV_PAGEFIND_SITE, DEV_PAGEFIND_OUTPUT);
	if (!pagefindResult.success) {
		return { success: false, output: verbose ? pagefindResult.output : undefined };
	}

	return { success: true, pagesIndexed: pagefindResult.pagesIndexed ?? 0 };
}

/**
 * Background search-index rebuilder. Mirrors `SourceWatcher`'s drain pattern
 * (`running`/`dirty` flags) so concurrent triggers coalesce into a single
 * follow-up rebuild instead of stacking. The rebuild is fire-and-forget —
 * callers do not await it, which keeps the watcher's `onChange` snappy and
 * stops a stalled build from blocking the next sync.
 */
function createDevIndexer(buildDir: string, renderer: SiteRenderer, verbose: boolean): { trigger(): void } {
	let running = false;
	let dirty = false;

	const drain = async (): Promise<void> => {
		while (dirty) {
			dirty = false;
			try {
				const result = await buildDevSearchIndex(buildDir, renderer, verbose);
				if (result.success) {
					console.log(`  ↻ Rebuilt search index (${result.pagesIndexed ?? 0} pages)`);
				} else {
					console.warn("  ⚠ Search index rebuild failed; existing index is still served");
					if (verbose && result.output) console.error(result.output);
				}
			} catch (err) {
				console.warn(`  ⚠ Search index rebuild error: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		running = false;
	};

	return {
		trigger(): void {
			dirty = true;
			if (running) return;
			running = true;
			// Fire-and-forget — errors are swallowed inside `drain`. Surfacing
			// rejection here would propagate to an unhandled promise rejection
			// and kill the dev process; we'd rather have a stale index than a
			// dead server.
			void drain();
		},
	};
}

// ─── Commands ────────────────────────────────────────────────────────────────

export function registerBuildCommand(program: Command): void {
	program
		.command("build")
		.description("Build a static site with search indexing")
		.argument("[source-root]", "Path to the Content_Folder (default: current directory)")
		.option("--migrate", "Re-detect framework config and regenerate site.json")
		.option("--verbose", "Show detailed build output")
		.option("--theme <path>", "Path to a custom theme pack folder")
		.action(async (sourceRootArg: string | undefined, opts: CmdOpts) => {
			const sourceRoot = resolve(sourceRootArg ?? process.cwd());
			const buildDir = getBuildDir(sourceRoot);
			const contentDir = join(buildDir, "content");
			const publicDir = join(buildDir, "public");

			const result = await prepareContent(sourceRoot, buildDir, contentDir, publicDir, true, opts);
			if (!result.success) return;

			const buildResult = await buildAndIndex(buildDir, opts.verbose === true, result.renderer);
			if (!buildResult.success) return;

			console.log("\n  Run `jolli start` to preview the site.\n");
		});
}

export function registerStartCommand(program: Command): void {
	program
		.command("start")
		.description("Build and serve a production site")
		.argument("[source-root]", "Path to the Content_Folder (default: current directory)")
		.option("--migrate", "Re-detect framework config and regenerate site.json")
		.option("--verbose", "Show detailed build output")
		.option("--theme <path>", "Path to a custom theme pack folder")
		.action(async (sourceRootArg: string | undefined, opts: CmdOpts) => {
			const sourceRoot = resolve(sourceRootArg ?? process.cwd());
			const buildDir = getBuildDir(sourceRoot);
			const contentDir = join(buildDir, "content");
			const publicDir = join(buildDir, "public");

			// Use non-static-export mode so `next start` can serve with
			// proper RSC (React Server Components) support. Static export
			// + `npx serve` breaks client-side hydration because the static
			// server can't handle RSC flight data requests (?_rsc=1).
			const result = await prepareContent(sourceRoot, buildDir, contentDir, publicDir, false, opts);
			if (!result.success) return;

			const buildResult = await buildAndIndex(buildDir, opts.verbose === true, result.renderer, false);
			if (!buildResult.success) return;

			console.log("");
			const serveResult = await runNpmStart(buildDir, opts.verbose === true);
			if (!serveResult.success) {
				if (serveResult.output) console.error(serveResult.output);
				process.exitCode = 1;
			}
		});
}

/**
 * Runs the dev server for a source folder. Exported for reuse by
 * `jolli theme preview` — the command itself delegates here.
 */
export async function runDevServer(
	sourceRoot: string,
	opts: { theme?: string; verbose?: boolean; migrate?: boolean },
): Promise<void> {
	const buildDir = getBuildDir(sourceRoot);
	const contentDir = join(buildDir, "content");
	const publicDir = join(buildDir, "public");

	const result = await prepareContent(sourceRoot, buildDir, contentDir, publicDir, false, opts);
	if (!result.success) return;

	const verbose = opts.verbose === true;

	// Build the initial search index synchronously — the dev server starts a
	// few seconds later, but the search box works the moment the page loads.
	// Failures only print a warning so the dev server still comes up; the
	// `/_pagefind/pagefind.js` 404 is recoverable.
	console.log("  Building search index…");
	const initialIndex = await buildDevSearchIndex(buildDir, result.renderer, verbose);
	if (initialIndex.success) {
		console.log(`  ✓ Indexed ${initialIndex.pagesIndexed ?? 0} pages for search`);
	} else {
		console.warn("  ⚠ Search index build failed; search will be unavailable until the next successful rebuild");
		if (verbose && initialIndex.output) console.error(initialIndex.output);
	}

	// Background rebuilder — content changes trigger a rebuild without
	// blocking the watcher's sync, so the dev page reload stays snappy and
	// the index just catches up a few seconds behind.
	const indexer = createDevIndexer(buildDir, result.renderer, verbose);

	console.log("  Watching source folder for changes…");
	const watcher = startSourceWatcher(sourceRoot, {
		onChange: async () => {
			const sync = await syncContent(sourceRoot, contentDir, publicDir, result.renderer, opts);
			if (sync.success) {
				const total =
					sync.mirrorResult.markdownFiles.length +
					sync.mirrorResult.imageFiles.length +
					sync.mirrorResult.openapiFiles.length;
				const ignored = sync.mirrorResult.ignoredFiles.length;
				const suffix = ignored > 0 ? ` (${ignored} ignored)` : "";
				console.log(`  ↻ Synced ${total} files${suffix}`);
				indexer.trigger();
			}
		},
	});

	console.log("");
	try {
		const devResult = await result.renderer.runDev(buildDir, opts.verbose === true);
		if (!devResult.success) {
			if (devResult.output) console.error(devResult.output);
			process.exitCode = 1;
		}
	} finally {
		await watcher.close();
	}
}

export function registerDevCommand(program: Command): void {
	program
		.command("dev")
		.description("Start a dev server with hot reload")
		.argument("[source-root]", "Path to the Content_Folder (default: current directory)")
		.option("--migrate", "Re-detect framework config and regenerate site.json")
		.option("--verbose", "Show detailed build output")
		.option("--theme <path>", "Path to a custom theme pack folder")
		.action(async (sourceRootArg: string | undefined, opts: CmdOpts) => {
			await runDevServer(resolve(sourceRootArg ?? process.cwd()), opts);
		});
}
