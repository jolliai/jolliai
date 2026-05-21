import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasIncompatibleImports, rewriteRelativeImagePaths, stripIncompatibleContent } from "./ContentMirror.js";
import { slugify } from "./openapi/Slug.js";
import type { ContentRules } from "./renderer/SiteRenderer.js";
import type { Navigation, NavigationArticle, NavigationGroup, NavigationPage } from "./Types.js";

export interface PlannedMarkdownPage {
	sourceRelPath: string;
	targetRelPath: string;
	title: string;
}

export interface NavigationContentPlan {
	pages: PlannedMarkdownPage[];
}

function isGroup(node: NavigationGroup | NavigationArticle): node is NavigationGroup {
	return "group" in node;
}

function joinSegments(...segments: string[]): string {
	return segments
		.map((segment) => segment.replace(/^\/+|\/+$/g, ""))
		.filter((segment) => segment.length > 0)
		.join("/");
}

function stripExtension(relPath: string): string {
	return relPath.replace(/\.(md|mdx)$/i, "");
}

function lastSegment(relPath: string): string {
	const normalized = relPath.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? normalized;
}

function hasSourceMarkdown(candidateBase: string, availableMarkdownFiles: string[]): boolean {
	const normalizedBase = candidateBase.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	return (
		availableMarkdownFiles.includes(`${normalizedBase}.md`) ||
		availableMarkdownFiles.includes(`${normalizedBase}.mdx`) ||
		availableMarkdownFiles.includes(joinSegments(normalizedBase, "index.md")) ||
		availableMarkdownFiles.includes(joinSegments(normalizedBase, "index.mdx")) ||
		availableMarkdownFiles.filter(
			(file) =>
				stripExtension(file) === normalizedBase ||
				lastSegment(stripExtension(file)) === lastSegment(normalizedBase),
		).length === 1
	);
}

function hasExplicitSourceMarkdown(source: string, availableMarkdownFiles: string[]): boolean {
	const normalized = source.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	return (
		availableMarkdownFiles.includes(normalized) ||
		availableMarkdownFiles.includes(`${normalized}.md`) ||
		availableMarkdownFiles.includes(`${normalized}.mdx`)
	);
}

function resolveSourceMarkdown(candidateBase: string, availableMarkdownFiles: string[]): string {
	const normalizedBase = candidateBase.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	const exactMd = `${normalizedBase}.md`;
	if (availableMarkdownFiles.includes(exactMd)) return exactMd;
	const exactMdx = `${normalizedBase}.mdx`;
	if (availableMarkdownFiles.includes(exactMdx)) return exactMdx;
	const indexMd = joinSegments(normalizedBase, "index.md");
	if (availableMarkdownFiles.includes(indexMd)) return indexMd;
	const indexMdx = joinSegments(normalizedBase, "index.mdx");
	if (availableMarkdownFiles.includes(indexMdx)) return indexMdx;

	const basename = lastSegment(normalizedBase);
	const matches = availableMarkdownFiles.filter(
		(file) => stripExtension(file) === normalizedBase || lastSegment(stripExtension(file)) === basename,
	);
	if (matches.length === 1) {
		return matches[0];
	}
	if (matches.length > 1) {
		throw new Error(
			`Navigation page "${candidateBase}" is ambiguous. Matching source files: ${matches.join(", ")}`,
		);
	}
	throw new Error(`Navigation page "${candidateBase}" was not found in the source markdown files.`);
}

function resolveExplicitSourceMarkdown(source: string, availableMarkdownFiles: string[]): string {
	const normalized = source.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	if (availableMarkdownFiles.includes(normalized)) {
		return normalized;
	}
	return resolveSourceMarkdown(normalized, availableMarkdownFiles);
}

function addArticlePlan(
	article: NavigationArticle,
	sourceDir: string,
	targetDir: string,
	availableMarkdownFiles: string[],
	pages: PlannedMarkdownPage[],
): void {
	if (article.type === "external") {
		return;
	}

	const href = article.href.replace(/^\/+/, "");
	const sourceBase = article.source
		? article.source
		: article.href.startsWith("/")
			? href
			: joinSegments(sourceDir, href);
	const targetBase = article.href.startsWith("/") ? href : joinSegments(targetDir, href);

	// Articles with children but no corresponding source file are folder-only
	// entries (collapsible sidebar groups). Skip source resolution for these —
	// they don't have a page of their own.
	const hasSourceFile = article.source
		? hasExplicitSourceMarkdown(sourceBase, availableMarkdownFiles)
		: hasSourceMarkdown(sourceBase, availableMarkdownFiles);

	if (hasSourceFile) {
		const sourceRelPath = article.source
			? resolveExplicitSourceMarkdown(sourceBase, availableMarkdownFiles)
			: resolveSourceMarkdown(sourceBase, availableMarkdownFiles);
		const sourceExt = sourceRelPath.endsWith(".mdx") ? ".mdx" : ".md";
		const targetRelPath = `${targetBase}${sourceExt}`;
		pages.push({ sourceRelPath, targetRelPath, title: article.article });
	} else if (!article.articles?.length) {
		// No source file AND no children — likely an auto-generated route
		// (e.g. OpenAPI) or an external link. Skip silently; the route will
		// be handled by the appropriate pipeline or is a sidebar-only entry.
	}

	// Nested articles resolve hrefs relative to the same root as the parent
	// (group root or page root), NOT relative to the parent article's path.
	// Per the spec, href resolution walks up to the nearest ancestor `root`.
	if (article.articles?.length) {
		for (const child of article.articles) {
			addArticlePlan(child, sourceDir, targetDir, availableMarkdownFiles, pages);
		}
	}
}

function addNodesPlan(
	nodes: Array<NavigationGroup | NavigationArticle>,
	sourceDir: string,
	targetDir: string,
	availableMarkdownFiles: string[],
	pages: PlannedMarkdownPage[],
): void {
	for (const node of nodes) {
		if (isGroup(node)) {
			const childSourceDir = node.sourceRoot
				? node.sourceRoot.replace(/^\/+|\/+$/g, "")
				: node.root
					? joinSegments(sourceDir, node.root)
					: sourceDir;
			const childTargetDir = node.root ? joinSegments(targetDir, node.root) : targetDir;
			addNodesPlan(node.content, childSourceDir, childTargetDir, availableMarkdownFiles, pages);
			continue;
		}
		addArticlePlan(node, sourceDir, targetDir, availableMarkdownFiles, pages);
	}
}

function validatePlanConflicts(pages: PlannedMarkdownPage[]): void {
	const targetToSource = new Map<string, string>();
	const sourceToTarget = new Map<string, string>();
	for (const page of pages) {
		const previousSource = targetToSource.get(page.targetRelPath);
		if (previousSource && previousSource !== page.sourceRelPath) {
			throw new Error(
				`Navigation target "${page.targetRelPath}" is claimed by both "${previousSource}" and "${page.sourceRelPath}".`,
			);
		}
		targetToSource.set(page.targetRelPath, page.sourceRelPath);

		const previousTarget = sourceToTarget.get(page.sourceRelPath);
		if (previousTarget && previousTarget !== page.targetRelPath) {
			throw new Error(
				`Navigation source "${page.sourceRelPath}" is mapped to both "${previousTarget}" and "${page.targetRelPath}".`,
			);
		}
		sourceToTarget.set(page.sourceRelPath, page.targetRelPath);
	}
}

// ─── Navigation path validation ────────────────────────────────────────────

export interface NavigationMismatch {
	/** The article/group label from site.json */
	label: string;
	/** The resolved path that was expected */
	expectedPath: string;
	/** What to fix */
	suggestion: string;
}

/**
 * Validates that navigation entries in site.json match actual files on disk.
 * Returns a list of mismatches with suggestions. Call this before
 * `buildNavigationContentPlan` to give users clear diagnostic messages
 * instead of cryptic Nextra `_meta` validation errors.
 */
export function validateNavigationPaths(
	navigation: Navigation,
	availableMarkdownFiles: string[],
): NavigationMismatch[] {
	const mismatches: NavigationMismatch[] = [];
	if (navigation.length === 0) return mismatches;

	const isPageMode = "page" in navigation[0];
	if (isPageMode) {
		for (const page of navigation as NavigationPage[]) {
			if (page.type === "menu" || page.openapi) continue;
			const root = (page.root ?? `/${slugify(page.page)}`).replace(/^\/+/, "");
			if (page.content) {
				checkNodes(page.content, root, availableMarkdownFiles, mismatches);
			}
		}
	} else {
		checkNodes(navigation as (NavigationGroup | NavigationArticle)[], "", availableMarkdownFiles, mismatches);
	}

	return mismatches;
}

function checkNodes(
	nodes: (NavigationGroup | NavigationArticle)[],
	parentRoot: string,
	files: string[],
	mismatches: NavigationMismatch[],
): void {
	for (const node of nodes) {
		if ("group" in node) {
			const groupRoot = node.root ? joinSegments(parentRoot, node.root) : parentRoot;
			for (const article of node.content) {
				checkArticle(article, groupRoot, files, mismatches);
			}
		} else {
			checkArticle(node, parentRoot, files, mismatches);
		}
	}
}

function checkArticle(
	article: NavigationArticle,
	root: string,
	files: string[],
	mismatches: NavigationMismatch[],
): void {
	if (article.type === "external") return;

	const href = article.href.replace(/^\/+/, "");
	const resolved = article.href.startsWith("/") ? href : joinSegments(root, href);

	// Skip if it has children but no file (folder-only entry)
	if (article.articles?.length && !hasSourceMarkdown(resolved, files)) {
		// Still check children
		for (const child of article.articles) {
			checkArticle(child, root, files, mismatches);
		}
		return;
	}

	// Skip if file exists
	if (hasSourceMarkdown(resolved, files)) {
		if (article.articles) {
			for (const child of article.articles) {
				checkArticle(child, root, files, mismatches);
			}
		}
		return;
	}

	// Find closest match for suggestion
	const basename = lastSegment(resolved);
	const candidates = files.filter(
		(f) => lastSegment(stripExtension(f)) === basename || stripExtension(f).endsWith(basename),
	);

	let suggestion: string;
	if (candidates.length === 1) {
		const actual = stripExtension(candidates[0]);
		suggestion = `Found "${candidates[0]}" — change href to "${actual}" or move file to "${resolved}.md"`;
	} else if (candidates.length > 1) {
		suggestion = `Multiple matches: ${candidates.join(", ")}. Specify the correct path.`;
	} else {
		suggestion = `No matching file found. Create "${resolved}.md" or remove this entry from site.json.`;
	}

	mismatches.push({
		label: article.article,
		expectedPath: resolved,
		suggestion,
	});
}

export function buildNavigationContentPlan(
	navigation: Navigation,
	availableMarkdownFiles: string[],
): NavigationContentPlan {
	const pages: PlannedMarkdownPage[] = [];

	if (navigation.length === 0) {
		return { pages };
	}

	const isPageMode = "page" in navigation[0];
	if (!isPageMode) {
		addNodesPlan(navigation as (NavigationGroup | NavigationArticle)[], "", "", availableMarkdownFiles, pages);
		validatePlanConflicts(pages);
		return { pages };
	}

	for (const pg of navigation as NavigationPage[]) {
		if (pg.openapi || !pg.content || pg.type === "menu") {
			continue;
		}
		const pageRoot = (pg.root ?? `/${slugify(pg.page)}`).replace(/^\/+/, "");
		const sourceRoot = pg.sourceRoot ? pg.sourceRoot.replace(/^\/+|\/+$/g, "") : pageRoot;
		addNodesPlan(pg.content, sourceRoot, pageRoot, availableMarkdownFiles, pages);
	}

	validatePlanConflicts(pages);
	return { pages };
}

async function canCompileMdx(content: string): Promise<boolean> {
	try {
		const { compile } = await import("@mdx-js/mdx");
		await compile(content, { development: false });
		return true;
	} catch {
		return false;
	}
}

async function rewritePlannedPage(
	sourceRoot: string,
	contentDir: string,
	page: PlannedMarkdownPage,
	contentRules?: ContentRules,
): Promise<string> {
	// The available-files list may contain names that differ from the source:
	//   - .mdx → .md downgrade (ContentMirror strips incompatible imports)
	//   - slug: / rename (what-is-feldera.md → index.md)
	// Try the planned path first, then fall back to variants on disk.
	let sourcePath = join(sourceRoot, page.sourceRelPath);
	if (!existsSync(sourcePath)) {
		// Try .mdx variant (downgraded name)
		if (page.sourceRelPath.endsWith(".md")) {
			const mdxVariant = join(sourceRoot, page.sourceRelPath.replace(/\.md$/, ".mdx"));
			if (existsSync(mdxVariant)) {
				sourcePath = mdxVariant;
			}
		}
		// If still not found, the file was already placed in contentDir by
		// ContentMirror (e.g. slug:/ rename). Read from there instead.
		if (!existsSync(sourcePath)) {
			const contentDirPath = join(contentDir, page.sourceRelPath);
			if (existsSync(contentDirPath)) {
				sourcePath = contentDirPath;
			}
		}
	}
	const raw = await readFile(sourcePath, "utf-8");

	let finalTargetRelPath = page.targetRelPath;
	let content = raw;

	// Check the actual source file (which may be .mdx even when the planned
	// path says .md — ContentMirror downgrades the name in the available-files
	// list but the source on disk keeps the original extension).
	if (sourcePath.endsWith(".mdx")) {
		if (hasIncompatibleImports(content, contentRules) || !(await canCompileMdx(content))) {
			const stripped = stripIncompatibleContent(content, contentRules);
			content = stripped.content;
			// Only downgrade to .md if no safe JSX remains
			if (!stripped.hasSafeJsx) {
				finalTargetRelPath = finalTargetRelPath.replace(/\.mdx$/i, ".md");
			}
		}
	}

	const rewritten = rewriteRelativeImagePaths(content, page.sourceRelPath, finalTargetRelPath);
	await mkdir(dirname(join(contentDir, finalTargetRelPath)), { recursive: true });
	await writeFile(join(contentDir, finalTargetRelPath), rewritten, "utf-8");
	return finalTargetRelPath;
}

export async function applyNavigationContentPlan(
	sourceRoot: string,
	contentDir: string,
	mirroredMarkdownFiles: string[],
	plan: NavigationContentPlan,
	contentRules?: ContentRules,
): Promise<string[]> {
	const isIndexFile = (relPath: string) => {
		const base = relPath.split("/").pop() ?? relPath;
		return base === "index.md" || base === "index.mdx";
	};
	for (const relPath of mirroredMarkdownFiles) {
		if (isIndexFile(relPath)) {
			continue;
		}
		await rm(join(contentDir, relPath), { force: true });
	}

	const plannedMarkdownFiles: string[] = mirroredMarkdownFiles.filter(isIndexFile);
	for (const page of plan.pages) {
		const writtenRelPath = await rewritePlannedPage(sourceRoot, contentDir, page, contentRules);
		plannedMarkdownFiles.push(writtenRelPath);
	}

	return Array.from(new Set(plannedMarkdownFiles));
}
