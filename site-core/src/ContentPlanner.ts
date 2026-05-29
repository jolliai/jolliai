/**
 * ContentPlanner (pure half).
 *
 * Computes the source → target file plan for a `navigation` declaration,
 * plus validates that referenced source files actually exist (returning
 * diagnostic mismatches). All inputs are passed in by value — the caller
 * supplies `availableMarkdownFiles` as a `string[]` so this module never
 * touches the filesystem.
 *
 * The I/O half (writing the plan to disk by reading source markdown,
 * rewriting image paths, downgrading .mdx → .md, injecting frontmatter)
 * lives in `cli/src/site/ContentPlanWriter.ts` and consumes the plan
 * produced here.
 */

import { slugify } from "./openapi/Slug.js";
import { normalizeHrefSegments } from "./StructureParser.js";
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
	inheritedRootSegs: ReadonlyArray<string>,
	availableMarkdownFiles: string[],
	pages: PlannedMarkdownPage[],
): void {
	if (article.type === "external") {
		return;
	}

	// Normalize the href against the inherited root: leading-slash is
	// equivalent to no slash, and any prefix duplicating the end of the
	// inherited root is stripped. Removes the source/target double-pathing
	// that occurred when an author repeated the group's root inside `href`.
	const hrefSegs = normalizeHrefSegments(article.href, inheritedRootSegs);
	const href = hrefSegs.join("/");
	const sourceBase = article.source ? article.source : joinSegments(sourceDir, href);
	const targetBase = joinSegments(targetDir, href);

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
		// When the article has nested children, write the parent page as
		// `<targetBase>/index.<ext>` so the child files can live under
		// `<targetBase>/`. Writing `<targetBase>.<ext>` next to a `<targetBase>/`
		// folder is a Nextra v4 layout conflict: the folder shadows the file,
		// the sidebar entry collapses to a non-clickable expandable group, and
		// the child routes become unreachable.
		const targetRelPath = article.articles?.length
			? `${targetBase}/index${sourceExt}`
			: `${targetBase}${sourceExt}`;
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
			addArticlePlan(child, sourceDir, targetDir, inheritedRootSegs, availableMarkdownFiles, pages);
		}
	}
}

function addNodesPlan(
	nodes: Array<NavigationGroup | NavigationArticle>,
	sourceDir: string,
	targetDir: string,
	inheritedRootSegs: ReadonlyArray<string>,
	availableMarkdownFiles: string[],
	pages: PlannedMarkdownPage[],
): void {
	for (const node of nodes) {
		if (isGroup(node)) {
			// `group.root` (or `group.sourceRoot`) tells the planner where to
			// FIND the article sources. It does NOT contribute to the target
			// path: the schema treats a group as a sidebar separator, and the
			// generated build tree is flattened so Nextra renders the articles
			// at the parent level without a stray `<group.root>` folder.
			//
			// `node.root` IS however extended onto `inheritedRootSegs` so an
			// author who repeats it inside an article's `href`
			// (e.g. `href: "guides/intro"` inside `group{root: "guides"}`)
			// gets the redundant prefix stripped instead of producing a
			// double-pathed source lookup.
			const childSourceDir = node.sourceRoot
				? node.sourceRoot.replace(/^\/+|\/+$/g, "")
				: node.root
					? joinSegments(sourceDir, node.root)
					: sourceDir;
			const groupRootSegs = (node.root ?? "").split("/").filter(Boolean);
			const childInheritedRootSegs = [...inheritedRootSegs, ...groupRootSegs];
			addNodesPlan(
				node.content,
				childSourceDir,
				targetDir,
				childInheritedRootSegs,
				availableMarkdownFiles,
				pages,
			);
			continue;
		}
		addArticlePlan(node, sourceDir, targetDir, inheritedRootSegs, availableMarkdownFiles, pages);
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
				const pageRootSegs = root.split("/").filter(Boolean);
				checkNodes(page.content, root, pageRootSegs, availableMarkdownFiles, mismatches);
			}
		}
	} else {
		checkNodes(navigation as (NavigationGroup | NavigationArticle)[], "", [], availableMarkdownFiles, mismatches);
	}

	return mismatches;
}

function checkNodes(
	nodes: (NavigationGroup | NavigationArticle)[],
	parentRoot: string,
	inheritedRootSegs: ReadonlyArray<string>,
	files: string[],
	mismatches: NavigationMismatch[],
): void {
	for (const node of nodes) {
		if ("group" in node) {
			const groupRoot = node.root ? joinSegments(parentRoot, node.root) : parentRoot;
			const groupRootSegs = (node.root ?? "").split("/").filter(Boolean);
			const childInheritedRootSegs = [...inheritedRootSegs, ...groupRootSegs];
			for (const article of node.content) {
				checkArticle(article, groupRoot, childInheritedRootSegs, files, mismatches);
			}
		} else {
			checkArticle(node, parentRoot, inheritedRootSegs, files, mismatches);
		}
	}
}

function checkArticle(
	article: NavigationArticle,
	root: string,
	inheritedRootSegs: ReadonlyArray<string>,
	files: string[],
	mismatches: NavigationMismatch[],
): void {
	if (article.type === "external") return;

	const hrefSegs = normalizeHrefSegments(article.href, inheritedRootSegs);
	const href = hrefSegs.join("/");
	const resolved = joinSegments(root, href);

	// Skip if it has children but no file (folder-only entry)
	if (article.articles?.length && !hasSourceMarkdown(resolved, files)) {
		// Still check children
		for (const child of article.articles) {
			checkArticle(child, root, inheritedRootSegs, files, mismatches);
		}
		return;
	}

	// Skip if file exists
	if (hasSourceMarkdown(resolved, files)) {
		if (article.articles) {
			for (const child of article.articles) {
				checkArticle(child, root, inheritedRootSegs, files, mismatches);
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
		addNodesPlan(navigation as (NavigationGroup | NavigationArticle)[], "", "", [], availableMarkdownFiles, pages);
		validatePlanConflicts(pages);
		return { pages };
	}

	for (const pg of navigation as NavigationPage[]) {
		if (pg.openapi || !pg.content || pg.type === "menu") {
			continue;
		}
		const pageRoot = (pg.root ?? `/${slugify(pg.page)}`).replace(/^\/+/, "");
		const sourceRoot = pg.sourceRoot ? pg.sourceRoot.replace(/^\/+|\/+$/g, "") : pageRoot;
		const pageRootSegs = pageRoot.split("/").filter(Boolean);
		addNodesPlan(pg.content, sourceRoot, pageRoot, pageRootSegs, availableMarkdownFiles, pages);
	}

	validatePlanConflicts(pages);
	return { pages };
}
