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
import { clearDir, mirrorContent } from "../site/ContentMirror.js";
import type { RootApiSpec, RootInjectionInput } from "../site/MetaGenerator.js";
import { needsInstall, runNpmInstall, runServe } from "../site/NpmRunner.js";
import { buildPipeline } from "../site/openapi/OpenApiPipeline.js";
import { deriveSpecName } from "../site/openapi/SpecName.js";
import { runPagefind } from "../site/PagefindRunner.js";
import { resolveRenderer, type SiteRenderer } from "../site/renderer/index.js";
import type { OpenApiSpecInput } from "../site/renderer/SiteRenderer.js";
import { readSiteJson } from "../site/SiteJsonReader.js";
import { startSourceWatcher } from "../site/SourceWatcher.js";
import type { HeaderItem, NavLink } from "../site/Types.js";

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
}

/**
 * Builds the per-spec inputs the renderer's `renderOpenApiSpecs` expects.
 * Reuses the documents `ContentMirror` already cached, runs them through
 * `buildPipeline` once each, and tags each entry with a URL slug derived
 * from the source-file basename. Throws on a `specName` collision —
 * silently dropping a spec would result in missing pages.
 */
function buildOpenApiSpecInputs(mirrorResult: Awaited<ReturnType<typeof mirrorContent>>): OpenApiSpecInput[] {
	const inputs: OpenApiSpecInput[] = [];
	const claimed = new Map<string, string>();
	for (const sourceRelPath of mirrorResult.openapiFiles) {
		const doc = mirrorResult.openapiDocs[sourceRelPath];
		if (!doc) {
			continue;
		}
		const specName = deriveSpecName(sourceRelPath);
		const existing = claimed.get(specName);
		if (existing) {
			throw new Error(
				`OpenAPI spec name collision: "${existing}" and "${sourceRelPath}" both resolve to ` +
					`spec slug "${specName}". Rename one of the source files so each spec gets a unique URL.`,
			);
		}
		claimed.set(specName, sourceRelPath);
		inputs.push({ specName, sourceRelPath, pipeline: buildPipeline(doc) });
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

	// Fix sidebar index key if a file was renamed during mirror.
	const sidebar = siteJsonResult.config.sidebar;
	if (mirrorResult.renamedToIndex && sidebar?.["/"]?.[mirrorResult.renamedToIndex]) {
		const label = sidebar["/"][mirrorResult.renamedToIndex];
		delete sidebar["/"][mirrorResult.renamedToIndex];
		sidebar["/"] = { index: label, ...sidebar["/"] };
	}

	if (mirrorResult.openapiFiles.length > 0) {
		const specInputs = buildOpenApiSpecInputs(mirrorResult);
		await renderer.renderOpenApiSpecs(contentDir, publicDir, specInputs);
	}

	// Build the root-_meta.js injection payload. The renderer turns these
	// into native Nextra page tabs (chevron / hover / mobile drawer) by
	// writing them to the root `content/_meta.js` — no JSX nav-children
	// rendering in `<Navbar>`.
	const rootInjection = buildRootInjectionInput(
		siteJsonResult.config.header?.items,
		siteJsonResult.config.nav,
		mirrorResult,
	);

	await renderer.generateNavigation(contentDir, sidebar, rootInjection);

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
): RootInjectionInput {
	const apiSpecs: RootApiSpec[] = mirrorResult.openapiFiles.map((relPath) => {
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

	// Initialize build directory
	verbose(`Initializing build directory… (${buildDir})`, v);
	await renderer.initProject(buildDir, siteJsonResult.config, { staticExport });

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

	const pagefindResult = await runPagefind(buildDir);
	if (!pagefindResult.success) {
		console.error(v ? pagefindResult.output : "  Error: Search indexing failed");
		process.exitCode = 1;
		return { success: false };
	}

	const pagesIndexed = pagefindResult.pagesIndexed ?? 0;
	console.log(`  ✓ Indexed ${pagesIndexed} pages for search`);

	return { success: true, pagesBuilt };
}

// ─── Commands ────────────────────────────────────────────────────────────────

export function registerBuildCommand(program: Command): void {
	program
		.command("build")
		.description("Build a static site with search indexing")
		.argument("[source-root]", "Path to the Content_Folder (default: current directory)")
		.option("--migrate", "Re-detect framework config and regenerate site.json")
		.option("--verbose", "Show detailed build output")
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
		.description("Build a static site with search indexing, then serve it")
		.argument("[source-root]", "Path to the Content_Folder (default: current directory)")
		.option("--migrate", "Re-detect framework config and regenerate site.json")
		.option("--verbose", "Show detailed build output")
		.action(async (sourceRootArg: string | undefined, opts: CmdOpts) => {
			const sourceRoot = resolve(sourceRootArg ?? process.cwd());
			const buildDir = getBuildDir(sourceRoot);
			const contentDir = join(buildDir, "content");
			const publicDir = join(buildDir, "public");

			const result = await prepareContent(sourceRoot, buildDir, contentDir, publicDir, true, opts);
			if (!result.success) return;

			const buildResult = await buildAndIndex(buildDir, opts.verbose === true, result.renderer);
			if (!buildResult.success) return;

			console.log("");
			const serveResult = await runServe(buildDir, opts.verbose === true);
			if (!serveResult.success) {
				if (serveResult.output) console.error(serveResult.output);
				process.exitCode = 1;
			}
		});
}

export function registerDevCommand(program: Command): void {
	program
		.command("dev")
		.description("Start a dev server with hot reload")
		.argument("[source-root]", "Path to the Content_Folder (default: current directory)")
		.option("--migrate", "Re-detect framework config and regenerate site.json")
		.option("--verbose", "Show detailed build output")
		.action(async (sourceRootArg: string | undefined, opts: CmdOpts) => {
			const sourceRoot = resolve(sourceRootArg ?? process.cwd());
			const buildDir = getBuildDir(sourceRoot);
			const contentDir = join(buildDir, "content");
			const publicDir = join(buildDir, "public");

			const result = await prepareContent(sourceRoot, buildDir, contentDir, publicDir, false, opts);
			if (!result.success) return;

			// Watch the source folder so edits trigger an incremental re-mirror
			// + re-render of OpenAPI specs while the dev server is running.
			// Next.js's HMR picks up the writes to <buildDir>/content/.
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
		});
}
