/**
 * ContentMirror — mirrors the Content_Folder into the Nextra content directory.
 *
 * Classifies files by extension (and content for OpenAPI), then copies
 * markdown and image files to the corresponding paths inside the content directory.
 * Skips the `.jolli-site/` directory to avoid infinite recursion.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { copyExternalAsset, resolveExternalImage } from "./AssetResolver.js";
import { tryParseOpenApi } from "./openapi/SpecLoader.js";
import type { ContentRules } from "./renderer/SiteRenderer.js";
import type { FileType, MirrorResult, PathMappings } from "./Types.js";

// ─── rewriteRelativeImagePaths ────────────────────────────────────────────────

const IMAGE_EXT = /\.(png|jpg|jpeg|gif|svg|webp|ico|bmp)$/i;

/**
 * Rewrites relative image paths in markdown when a file has been remapped.
 *
 * For each relative image reference, resolves it against the ORIGINAL
 * directory to get the absolute image path, then computes a new relative
 * path from the NEW directory.
 *
 * Example:
 *   originalRelPath: "connectors/completion-tokens.md"
 *   newRelPath:      "pipelines/connectors/completion-tokens.md"
 *   Image ref:       "../pipelines/pipeline_architecture.png"
 *   Resolved:        "pipelines/pipeline_architecture.png" (absolute from root)
 *   New relative:    "../../pipelines/pipeline_architecture.png" (from pipelines/connectors/)
 */
export function rewriteRelativeImagePaths(
	content: string,
	originalRelPath: string,
	newRelPath: string,
	pathMappings?: PathMappings,
): string {
	const originalDir = dirOf(originalRelPath);
	const newDir = dirOf(newRelPath);

	if (originalDir === newDir) return content;

	// Rewrite markdown images: ![alt](path)
	let result = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt: string, src: string) => {
		if (!IMAGE_EXT.test(src)) return match;
		if (src.startsWith("/") || src.startsWith("http")) return match;
		const newSrc = remapRelativePath(src, originalDir, newDir, pathMappings);
		return `![${alt}](${newSrc})`;
	});

	// Rewrite HTML img: <img src="path">
	result = result.replace(/<img\s([^>]*?)src=["']([^"']+)["']/g, (match, attrs: string, src: string) => {
		if (!IMAGE_EXT.test(src)) return match;
		if (src.startsWith("/") || src.startsWith("http")) return match;
		const newSrc = remapRelativePath(src, originalDir, newDir, pathMappings);
		return `<img ${attrs}src="${newSrc}"`;
	});

	return result;
}

/** Gets the directory part of a relative path. */
function dirOf(relPath: string): string {
	const i = relPath.lastIndexOf("/");
	return i === -1 ? "" : relPath.slice(0, i);
}

/**
 * Resolves a relative path from `originalDir`, then computes a new relative
 * path from `newDir`.
 */
function remapRelativePath(src: string, originalDir: string, newDir: string, pathMappings?: PathMappings): string {
	// Resolve to absolute path (relative to source root)
	const absolute = resolvePath(originalDir, src);

	// Apply pathMapping to the image path too (it may have been moved)
	const mapped = applyPathMapping(absolute, pathMappings);

	// Compute relative from new dir
	return computeRelative(newDir, mapped);
}

/** Resolves a relative path against a directory. "a/b" + "../c.png" → "c.png" */
function resolvePath(dir: string, rel: string): string {
	const parts = dir ? dir.split("/") : [];
	for (const seg of rel.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

/** Computes a relative path from `from` directory to `to` path. */
function computeRelative(from: string, to: string): string {
	const fromParts = from ? from.split("/") : [];
	const toParts = to.split("/");

	// Find common prefix length
	let common = 0;
	while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
		common++;
	}

	const ups = fromParts.length - common;
	const rest = toParts.slice(common);

	const prefix = ups > 0 ? "../".repeat(ups) : "./";
	return prefix + rest.join("/");
}

// ─── applyPathMapping ────────────────────────────────────────────────────────

/**
 * Applies path mappings to a relative file path.
 * Mappings are folder-level: `{ "sql": "pipelines/sql" }` means any file
 * under `sql/...` gets remapped to `pipelines/sql/...`.
 *
 * Uses forward slashes for matching regardless of platform.
 */
export function applyPathMapping(relPath: string, pathMappings?: PathMappings): string {
	const normalized = relPath.replace(/\\/g, "/");
	if (!pathMappings) return normalized;

	for (const [source, target] of Object.entries(pathMappings)) {
		if (normalized === source || normalized.startsWith(`${source}/`)) {
			return target + normalized.slice(source.length);
		}
	}

	return normalized;
}

// ─── classifyFile ─────────────────────────────────────────────────────────────

/**
 * Classifies a file by its extension and, for JSON/YAML files, by its content.
 *
 * - `.md`, `.mdx`                                  → `"markdown"`
 * - `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`,
 *   `.webp`, `.ico`                                → `"image"`
 * - `.json`, `.yaml`, `.yml` with `openapi` field
 *   and `info` object in content                   → `"openapi"`
 * - everything else                                → `"ignored"`
 */
export function classifyFile(filePath: string, content?: string): FileType {
	const ext = extname(filePath).toLowerCase();

	// 4.2 — Markdown
	if (ext === ".md" || ext === ".mdx") {
		return "markdown";
	}

	// 4.3 — Images
	if (
		ext === ".png" ||
		ext === ".jpg" ||
		ext === ".jpeg" ||
		ext === ".gif" ||
		ext === ".svg" ||
		ext === ".webp" ||
		ext === ".ico"
	) {
		return "image";
	}

	// 4.4 — OpenAPI (JSON or YAML with openapi + info fields)
	if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
		if (content !== undefined && tryParseOpenApi(content, ext) !== null) {
			return "openapi";
		}
		return "ignored";
	}

	// 4.5 — Everything else
	return "ignored";
}

// ─── hasIncompatibleImports (internal helper) ────────────────────────────────

/**
 * Default package prefixes that are known to be safe.
 * Used as fallback when no ContentRules are provided.
 */
const DEFAULT_SAFE_IMPORT_PREFIXES = [
	"nextra",
	"nextra-theme-docs",
	"next/",
	"next-themes",
	"react",
	"swagger-ui-react",
];

/**
 * Default components provided by the framework that don't need explicit imports.
 * Used as fallback when no ContentRules are provided.
 */
const DEFAULT_PROVIDED_COMPONENTS = new Set([
	"Fragment",
	"Callout",
	"Cards",
	"Card",
	"FileTree",
	"Steps",
	"Tabs",
	"Tab",
]);

/**
 * Matches ES module import statements: `import ... from '...'`
 * Captures the module specifier (the part inside quotes).
 */
const IMPORT_PATTERN = /import\s+.*?from\s+['"](.*?)['"]/g;

/**
 * Returns `true` if the MDX content contains imports that can't be resolved
 * in the target framework. Relative imports (`./`, `../`) are always allowed.
 * Package imports are only allowed if they match a known safe prefix.
 *
 * @param rules - Renderer-specific content rules. Falls back to Nextra defaults if omitted.
 */
export function hasIncompatibleImports(content: string, rules?: ContentRules): boolean {
	const safePrefixes = rules?.safeImportPrefixes ?? DEFAULT_SAFE_IMPORT_PREFIXES;
	const providedComponents = rules?.providedComponents ?? DEFAULT_PROVIDED_COMPONENTS;

	for (const match of content.matchAll(IMPORT_PATTERN)) {
		const specifier = match[1];
		// Relative imports are always safe
		if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
		// Check against safe prefixes
		if (safePrefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) continue;
		// Unknown package import — incompatible
		return true;
	}

	// Check for JSX components that aren't standard HTML and aren't imported.
	// These are typically injected via framework-specific MDX providers
	// (e.g. Docusaurus global components like <LiteYouTubeEmbed />).
	const importedComponents = new Set<string>();
	for (const match of content.matchAll(/import\s+(\w+)/g)) {
		importedComponents.add(match[1]);
	}
	for (const match of content.matchAll(/import\s+\{([^}]+)\}/g)) {
		for (const name of match[1].split(",")) {
			const trimmed = name
				.trim()
				.split(/\s+as\s+/)
				.pop()
				?.trim();
			if (trimmed) importedComponents.add(trimmed);
		}
	}

	// Match JSX tags that start with uppercase (custom components, not HTML)
	const jsxComponentPattern = /<([A-Z]\w+)[\s/>]/g;
	for (const match of content.matchAll(jsxComponentPattern)) {
		const componentName = match[1];
		if (!importedComponents.has(componentName) && !providedComponents.has(componentName)) {
			return true;
		}
	}

	return false;
}

// ─── stripIncompatibleContent (internal helper) ──────────────────────────────

/**
 * Strips incompatible MDX content to produce plain markdown:
 *   1. Removes all `import` and `export` statements
 *   2. Removes ALL JSX component tags (uppercase): `<Foo ... />` and `<Foo>...</Foo>`
 *   3. Removes Docusaurus admonition syntax (`:::tip`, `:::warning`, etc.)
 *   4. Preserves code blocks, headings, paragraphs, lists, links, images, etc.
 *
 * Since the file is being downgraded to `.md`, no JSX components will work —
 * so we strip them all, keeping only the text content inside open/close pairs.
 */
export function stripIncompatibleContent(content: string): string {
	let result = content;

	// Remove import/export lines
	result = result.replace(/^(import|export)\s+.*$/gm, "");

	// Remove self-closing JSX tags: <ComponentName ... />
	result = result.replace(/<[A-Z]\w+\s[^>]*?\/>/g, "");
	result = result.replace(/<[A-Z]\w+\s*\/>/g, "");

	// Remove JSX open/close tags but KEEP their children content.
	// This preserves text/code inside <Tabs><TabItem>...</TabItem></Tabs>.
	// Process iteratively since tags may be nested.
	let prev = "";
	while (prev !== result) {
		prev = result;
		// Remove opening tags: <ComponentName ...> or <ComponentName>
		result = result.replace(/<[A-Z]\w+(?:\s[^>]*)?>[ \t]*/g, "");
		// Remove closing tags: </ComponentName>
		result = result.replace(/[ \t]*<\/[A-Z]\w+>/g, "");
	}

	// Convert JSX style={{ ... }} to HTML style="..."
	result = result.replace(/style=\{\{([^}]*)\}\}/g, (_match, inner: string) => {
		const css = inner
			.split(",")
			.map((pair: string) => {
				const [key, ...valParts] = pair.split(":");
				if (!key || valParts.length === 0) return "";
				const cssKey = key
					.trim()
					.replace(/([A-Z])/g, "-$1")
					.toLowerCase(); // camelCase → kebab-case
				const cssVal = valParts
					.join(":")
					.trim()
					.replace(/^['"]|['"]$/g, "");
				return `${cssKey}: ${cssVal}`;
			})
			.filter(Boolean)
			.join("; ");
		return `style="${css}"`;
	});

	// Remove Docusaurus admonition fences (:::tip, :::warning, etc.)
	result = result.replace(/^:::.*$/gm, "");

	// Clean up excessive blank lines left by removals
	result = result.replace(/\n{3,}/g, "\n\n");

	return `${result.trim()}\n`;
}

// ─── canCompileMdx (internal helper) ─────────────────────────────────────────

/**
 * Attempts to compile MDX content using `@mdx-js/mdx`. Returns `true` if
 * the content compiles without errors, `false` otherwise.
 *
 * This is the second-layer check: only called on files already flagged by
 * the fast regex scan. It avoids false positives by confirming the content
 * truly can't be compiled.
 */
async function canCompileMdx(content: string): Promise<boolean> {
	try {
		const { compile } = await import("@mdx-js/mdx");
		await compile(content, { development: false });
		return true;
	} catch {
		return false;
	}
}

// ─── downgradeMdx (internal helper) ──────────────────────────────────────────

/**
 * Downgrades an incompatible `.mdx` file to `.md`: strips imports and
 * unsupported JSX, writes the cleaned content, and records it in the result.
 */
async function downgradeMdx(
	relPath: string,
	mdxContent: string,
	contentDir: string,
	result: MirrorResult,
): Promise<void> {
	const cleaned = stripIncompatibleContent(mdxContent);
	const mdRelPath = relPath.replace(/\.mdx$/, ".md");
	const destPath = join(contentDir, mdRelPath);
	await ensureDir(destPath);
	await writeFile(destPath, cleaned, "utf-8");
	result.markdownFiles.push(mdRelPath);
	result.downgradedCount++;
}

// ─── clearDir ────────────────────────────────────────────────────────────────

/**
 * Removes all contents inside `dir` but keeps the directory itself.
 * Used to clear stale content from a previous run before mirroring.
 */
export async function clearDir(dir: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	await Promise.all(entries.map((entry) => rm(join(dir, entry), { recursive: true, force: true })));
}

// ─── mirrorContent ────────────────────────────────────────────────────────────

/**
 * Clears stale content from `contentDir`, then recursively walks `sourceRoot`,
 * classifies every file, and copies markdown and image files to the
 * corresponding relative path inside the content directory.
 *
 * Skips the `.jolli-site/` directory to avoid infinite recursion (4.7).
 *
 * Returns a `MirrorResult` with the relative paths of all classified files.
 */
export async function mirrorContent(
	sourceRoot: string,
	contentDir: string,
	pathMappings?: PathMappings,
	publicDir?: string,
	contentRules?: ContentRules,
): Promise<MirrorResult> {
	// Clear stale content from previous runs
	await clearDir(contentDir);

	const result: MirrorResult = {
		markdownFiles: [],
		openapiFiles: [],
		openapiDocs: {},
		imageFiles: [],
		ignoredFiles: [],
		downgradedCount: 0,
	};

	await walkDir(sourceRoot, sourceRoot, contentDir, result, pathMappings, contentRules, publicDir);

	// If no index.md exists at root, look for a file with `slug: /` frontmatter
	// (common in Docusaurus projects) and rename it to index.md
	result.renamedToIndex = await ensureIndexPage(contentDir, result);

	// Resolve missing images: check all markdown image references,
	// generate placeholders for images that don't exist in contentDir
	if (publicDir) {
		const pendingAssets: PendingAsset[] = [];
		await resolveMissingImages(sourceRoot, contentDir, publicDir, result, pendingAssets);
	}

	return result;
}

// ─── resolveMissingImages ─────────────────────────────────────────────────────

type PendingAsset = { asset: Awaited<ReturnType<typeof resolveExternalImage>>; publicDir: string };

/**
 * Scans all mirrored markdown files for image references. If a referenced
 * image doesn't exist in contentDir, tries to find it externally or
 * generates a placeholder SVG.
 *
 * Modifies the markdown file in-place to point to the resolved image.
 */
async function resolveMissingImages(
	sourceRoot: string,
	contentDir: string,
	publicDir: string,
	result: MirrorResult,
	pendingAssets: PendingAsset[],
): Promise<void> {
	for (const mdRelPath of result.markdownFiles) {
		const mdAbsPath = join(contentDir, mdRelPath);
		let content: string;
		try {
			content = await readFile(mdAbsPath, "utf-8");
		} catch {
			continue;
		}

		const mdDir = dirname(mdAbsPath);
		let modified = false;
		const originalMdDir = join(sourceRoot, dirname(mdRelPath));

		/** Resolves a single image src. Returns new src or original if OK. */
		const resolveImage = (src: string): string | null => {
			if (!IMAGE_EXT.test(src)) return null;
			if (src.startsWith("http")) return null;

			if (src.startsWith("/")) {
				// Absolute path (e.g. /img/foo.png) — Docusaurus serves from static/
				// Try to find in sourceRoot's parent static/ dir
				const asset = resolveExternalImage(src.slice(1), dirname(sourceRoot), sourceRoot);
				pendingAssets.push({ asset, publicDir });
				modified = true;
				return `/${asset.publicPath}`;
			}

			const resolvedPath = resolve(mdDir, src);
			if (existsSync(resolvedPath)) return null; // Exists, no action

			// Missing relative image — try external resolution
			const asset = resolveExternalImage(src, originalMdDir, sourceRoot);
			pendingAssets.push({ asset, publicDir });
			modified = true;
			return `/${asset.publicPath}`;
		};

		// Check markdown images: ![alt](path)
		let newContent = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt: string, src: string) => {
			const newSrc = resolveImage(src);
			return newSrc ? `![${alt}](${newSrc})` : match;
		});

		// Check HTML images: <img src="path">
		newContent = newContent.replace(/<img\s([^>]*?)src=["']([^"']+)["']/g, (match, attrs: string, src: string) => {
			const newSrc = resolveImage(src);
			return newSrc ? `<img ${attrs}src="${newSrc}"` : match;
		});

		if (modified) {
			await writeFile(mdAbsPath, newContent, "utf-8");
		}
	}

	// Copy all pending external assets / generate placeholders
	for (const { asset, publicDir: pd } of pendingAssets) {
		await copyExternalAsset(asset, pd);
	}
}

// ─── ensureIndexPage (internal helper) ───────────────────────────────────────

/**
 * If `contentDir` has no `index.md` or `index.mdx`, scans mirrored markdown
 * files for one with `slug: /` in its frontmatter and copies it as
 * `index.md` in the content root. This handles Docusaurus projects that use
 * `slug: /` to designate the homepage instead of an `index.md` file.
 */
/**
 * Returns the old filename (without extension) that was renamed to index.md,
 * or `undefined` if no rename occurred.
 */
async function ensureIndexPage(contentDir: string, result: MirrorResult): Promise<string | undefined> {
	const hasIndex = result.markdownFiles.some((f) => f === "index.md" || f === "index.mdx");
	if (hasIndex) return undefined;

	// Only check root-level markdown files
	const rootFiles = result.markdownFiles.filter((f) => !f.includes("/") && !f.includes("\\"));
	for (const relPath of rootFiles) {
		try {
			const content = await readFile(join(contentDir, relPath), "utf-8");
			if (/^slug:\s*\/\s*$/m.test(content)) {
				await rename(join(contentDir, relPath), join(contentDir, "index.md"));
				const oldKey = relPath.replace(/\.(md|mdx)$/, "");
				// Replace the original entry with index.md. relPath is always
				// in markdownFiles because walkDir pushed it before this runs.
				const idx = result.markdownFiles.indexOf(relPath);
				result.markdownFiles[idx] = "index.md";
				return oldKey;
			}
		} catch {}
	}
	return undefined;
}

// ─── walkDir (internal recursive helper) ─────────────────────────────────────

async function walkDir(
	currentDir: string,
	sourceRoot: string,
	contentDir: string,
	result: MirrorResult,
	pathMappings?: PathMappings,
	contentRules?: ContentRules,
	publicDir?: string,
): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(currentDir);
	} catch {
		// If we can't read a directory, skip it silently
		return;
	}

	for (const entry of entries) {
		const fullPath = join(currentDir, entry);

		// 4.7 — Skip .jolli-site/ to avoid infinite recursion
		if (entry === ".jolli-site") {
			continue;
		}

		let entryStat: Awaited<ReturnType<typeof stat>>;
		try {
			entryStat = await stat(fullPath);
		} catch {
			continue;
		}

		if (entryStat.isDirectory()) {
			await walkDir(fullPath, sourceRoot, contentDir, result, pathMappings, contentRules, publicDir);
		} else if (entryStat.isFile()) {
			await processFile(fullPath, sourceRoot, contentDir, result, pathMappings, contentRules, publicDir);
		}
	}
}

// ─── processFile (internal helper) ───────────────────────────────────────────

async function processFile(
	fullPath: string,
	sourceRoot: string,
	contentDir: string,
	result: MirrorResult,
	pathMappings?: PathMappings,
	contentRules?: ContentRules,
	publicDir?: string,
): Promise<void> {
	const originalRelPath = relative(sourceRoot, fullPath);
	const relPath = applyPathMapping(originalRelPath, pathMappings);
	const ext = extname(fullPath).toLowerCase();

	// For potential OpenAPI files, parse once and cache the AST so the
	// rich-renderer pipeline can consume the parsed document without
	// re-reading or re-parsing the source. Files that fail the OpenAPI
	// structural check fall through to "ignored" — we never copy raw
	// JSON/YAML into the content directory.
	if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
		let content: string;
		try {
			content = await readFile(fullPath, "utf-8");
		} catch {
			result.ignoredFiles.push(relPath);
			return;
		}
		const doc = tryParseOpenApi(content, ext);
		if (doc !== null) {
			result.openapiFiles.push(relPath);
			result.openapiDocs[relPath] = doc;
		} else {
			result.ignoredFiles.push(relPath);
		}
		return;
	}

	const fileType = classifyFile(fullPath);

	switch (fileType) {
		case "markdown": {
			if (ext === ".mdx") {
				let mdxContent: string;
				try {
					mdxContent = await readFile(fullPath, "utf-8");
				} catch {
					result.ignoredFiles.push(relPath);
					return;
				}

				// Layer 1: fast regex check for incompatible imports / unknown JSX
				// Catches missing modules that webpack would fail on.
				if (hasIncompatibleImports(mdxContent, contentRules)) {
					await downgradeMdx(relPath, mdxContent, contentDir, result);
					return;
				}

				// Layer 2: MDX compiler check for syntax errors the regex can't detect
				// (e.g. malformed JSX, invalid expressions). Only runs on files
				// that passed the regex check.
				if (!(await canCompileMdx(mdxContent))) {
					await downgradeMdx(relPath, mdxContent, contentDir, result);
					return;
				}
			}
			result.markdownFiles.push(relPath);
			const destPath = join(contentDir, relPath);
			await ensureDir(destPath);

			// If the file was remapped, rewrite relative image paths
			// to account for the new directory location.
			if (originalRelPath !== relPath) {
				let mdContent: string;
				try {
					mdContent = await readFile(fullPath, "utf-8");
				} catch {
					await copyFile(fullPath, destPath);
					break;
				}
				const rewritten = rewriteRelativeImagePaths(mdContent, originalRelPath, relPath, pathMappings);
				await writeFile(destPath, rewritten, "utf-8");
			} else {
				await copyFile(fullPath, destPath);
			}
			break;
		}
		case "image": {
			// Copy images to contentDir at the mapped path (same mapping as markdown).
			// Nextra's staticImage resolves relative imports via webpack,
			// so images must be next to the markdown files that reference them.
			result.imageFiles.push(relPath);
			const destPath = join(contentDir, relPath);
			await ensureDir(destPath);
			await copyFile(fullPath, destPath);
			// Also mirror into publicDir at the *original* relative path so any
			// browser-absolute references (e.g. `/favicon.svg`,
			// `/assets/logo.svg` from site.json or hand-written markdown) resolve
			// against Next.js's public/ root. Original (non-pathMapped) path is
			// used because absolute refs in site.json are written against the
			// source folder layout, not the post-mapping layout.
			if (publicDir) {
				const publicDest = join(publicDir, originalRelPath);
				await ensureDir(publicDest);
				await copyFile(fullPath, publicDest);
			}
			break;
		}
		/* v8 ignore next 5 -- unreachable: OpenAPI files are handled in the early-return branch above. */
		case "openapi": {
			// classifyFile() called without content for non-JSON/YAML extensions
			// returns "ignored", never "openapi", so this case can't be reached.
			break;
		}
		case "ignored": {
			result.ignoredFiles.push(relPath);
			break;
		}
	}
}

// ─── ensureDir (internal helper) ─────────────────────────────────────────────

/** Ensures the parent directory of `filePath` exists. */
async function ensureDir(filePath: string): Promise<void> {
	// `dirname()` always returns a non-empty string ("." for bare filenames),
	// so no empty-dir guard is needed.
	await mkdir(dirname(filePath), { recursive: true });
}
