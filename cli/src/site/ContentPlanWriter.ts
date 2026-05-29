/**
 * ContentPlanWriter — I/O half of the content-planning pipeline.
 *
 * Consumes a `NavigationContentPlan` produced by site-core's pure
 * `buildNavigationContentPlan`, then materializes it on disk: reads the
 * source markdown for each page, rewrites relative image paths against
 * the new target path, strips MDX content the Nextra runtime can't
 * compile, and writes the result to `<contentDir>/<targetRelPath>`.
 *
 * The pure half (`buildNavigationContentPlan`, `validateNavigationPaths`,
 * type definitions) lives in `@jolli.ai/site-core` and never touches the
 * filesystem.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NavigationContentPlan, PlannedMarkdownPage } from "@jolli.ai/site-core";
import { hasIncompatibleImports, rewriteRelativeImagePaths, stripIncompatibleContent } from "./ContentMirror.js";
import type { ContentRules } from "./renderer/SiteRenderer.js";

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
	// When the planner re-homed a non-index source (e.g. `guides/deployment.mdx`)
	// to `<folder>/index.<ext>` because the article has nested children, mark the
	// rewritten file with `asIndexPage: true`. Nextra v4 reads this frontmatter
	// flag and treats the index as the folder's representative page — the folder
	// header in the sidebar becomes a clickable link to the index instead of a
	// non-clickable expand toggle, and Nextra suppresses the duplicate
	// auto-discovered index entry from the folder's children list.
	const sourceIsIndex = /(^|\/)index\.(md|mdx)$/i.test(page.sourceRelPath);
	const targetIsIndex = /(^|\/)index\.(md|mdx)$/i.test(finalTargetRelPath);
	const finalContent = targetIsIndex && !sourceIsIndex ? injectAsIndexPageFrontmatter(rewritten) : rewritten;
	await mkdir(dirname(join(contentDir, finalTargetRelPath)), { recursive: true });
	await writeFile(join(contentDir, finalTargetRelPath), finalContent, "utf-8");
	return finalTargetRelPath;
}

/**
 * Adds `asIndexPage: true` to the YAML frontmatter of a markdown/MDX file. If
 * the file has no frontmatter, prepends a new block. If the frontmatter
 * already declares `asIndexPage` at the top level, leaves it as authored.
 *
 * The "already declared" check is anchored to column 0 so a nested YAML key
 * (e.g. `things:\n  asIndexPage: true`) doesn't falsely register as a
 * top-level declaration — in that case Nextra would never see the flag and
 * fall back to its layout-conflict behaviour.
 */
function injectAsIndexPageFrontmatter(content: string): string {
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!fmMatch) {
		return `---\nasIndexPage: true\n---\n${content}`;
	}
	const body = fmMatch[1];
	if (/^asIndexPage\s*:/m.test(body)) {
		return content;
	}
	const newFm = `---\n${body}\nasIndexPage: true\n---\n`;
	return newFm + content.slice(fmMatch[0].length);
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
