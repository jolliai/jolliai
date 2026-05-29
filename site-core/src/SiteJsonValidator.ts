/**
 * SiteJsonValidator (commits 1+2: shape rules + line/column resolution).
 *
 * Walks a parsed `site.json` object and returns a list of `ValidationIssue`s
 * describing every shape mistake found. Does not throw — caller decides
 * what to do with the list (CLI prints a friendly error and bails; web
 * tool overlays inline diagnostics in the editor; CI surfaces them as
 * GitHub annotations).
 *
 * `locateIssues(rawText, issues)` turns each JSONPath into a
 * `{line, column, endLine, endColumn}` against the raw source via
 * `jsonc-parser`'s AST; pretty formatting with code-frame snippets
 * lands in commit 3.
 *
 * No I/O. Operates entirely on the JSON.parse output (treated as
 * `unknown` so a malformed site.json can't crash the validator before
 * the validator reports it) and the raw source text (a `string`).
 */

import { findNodeAtLocation, type Node, parseTree } from "jsonc-parser";

// ─── Public types ────────────────────────────────────────────────────────────

export interface ValidationIssue {
	severity: "error" | "warning";
	/** Stable identifier, e.g. `"article-without-href"`. Safe to match in CI. */
	code: string;
	/**
	 * JSONPath to the offending node, e.g. `["navigation", 10, "href"]`.
	 * Numeric segments are array indices, string segments are object keys.
	 * Empty array means "the whole document".
	 */
	path: (string | number)[];
	/** Human-readable description (no ANSI colors, no code frame). */
	message: string;
	/** Optional remediation suggestion. */
	hint?: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Walks a parsed site.json and returns every shape problem detected.
 * Empty array = the document is structurally valid (semantics may still
 * be wrong; that's `validateNavigationPaths`'s job).
 *
 * Errors are surfaced in document order (top-level → nested) so that a
 * caller printing them sequentially walks the source from top to bottom.
 */
export function validateSiteJsonShape(parsed: unknown): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	if (!isObject(parsed)) {
		issues.push({
			severity: "error",
			code: "root-not-object",
			path: [],
			message: `site.json must be a JSON object at the top level, got ${describeType(parsed)}.`,
		});
		return issues;
	}

	validateTitle(parsed, issues);

	if (parsed.navigation !== undefined) {
		validateNavigation(parsed.navigation, ["navigation"], issues);
	}

	return issues;
}

// ─── Top-level rules ─────────────────────────────────────────────────────────

function validateTitle(root: Record<string, unknown>, issues: ValidationIssue[]): void {
	if (root.title === undefined) {
		issues.push({
			severity: "error",
			code: "missing-title",
			path: ["title"],
			message: "site.json is missing the required `title` field.",
			hint: 'Add `"title": "Your Site Name"` at the top of site.json.',
		});
		return;
	}
	if (typeof root.title !== "string") {
		issues.push({
			severity: "error",
			code: "title-not-string",
			path: ["title"],
			message: `\`title\` must be a string, got ${describeType(root.title)}.`,
		});
	}
}

// ─── Navigation walking ──────────────────────────────────────────────────────

function validateNavigation(nav: unknown, path: (string | number)[], issues: ValidationIssue[]): void {
	if (!Array.isArray(nav)) {
		issues.push({
			severity: "error",
			code: "navigation-not-array",
			path,
			message: `\`navigation\` must be an array, got ${describeType(nav)}.`,
		});
		return;
	}
	if (nav.length === 0) {
		// Empty navigation is structurally valid (renders an empty sidebar).
		return;
	}

	// Mixed-mode detection: page entries cannot coexist with group/article
	// entries at the same level. The runtime parser picks a mode based on
	// the first entry and then crashes on the wrong-shape sibling — anchor
	// the diagnostic on every page entry so the user sees exactly which
	// items don't belong.
	const pageIndices: number[] = [];
	const simpleIndices: number[] = [];
	for (let i = 0; i < nav.length; i++) {
		const node = nav[i];
		if (!isObject(node)) continue;
		if ("page" in node) pageIndices.push(i);
		else if ("group" in node || "article" in node) simpleIndices.push(i);
	}
	if (pageIndices.length > 0 && simpleIndices.length > 0) {
		// Report on every page entry. One anchor per offending item beats
		// a single "somewhere in this array" message that the user has to
		// hunt through.
		for (const idx of pageIndices) {
			issues.push({
				severity: "error",
				code: "navigation-mixed-mode",
				path: [...path, idx],
				message:
					"Cannot mix page-mode entries with group/article entries at the top level of `navigation`. " +
					"Pick one shape for the whole array.",
				hint:
					'Either wrap every simple-mode entry inside a single `{ "page": "Docs", "root": "/", "content": [...] }` ' +
					"so the whole array is in page mode, or remove this `page` entry.",
			});
		}
	}

	for (let i = 0; i < nav.length; i++) {
		validateNavEntry(nav[i], [...path, i], issues);
	}
}

function validateNavEntry(entry: unknown, path: (string | number)[], issues: ValidationIssue[]): void {
	if (!isObject(entry)) {
		issues.push({
			severity: "error",
			code: "nav-entry-not-object",
			path,
			message: `Navigation entries must be objects, got ${describeType(entry)}.`,
		});
		return;
	}

	const hasArticle = "article" in entry;
	const hasGroup = "group" in entry;
	const hasPage = "page" in entry;
	const discriminatorCount = (hasArticle ? 1 : 0) + (hasGroup ? 1 : 0) + (hasPage ? 1 : 0);

	if (discriminatorCount === 0) {
		issues.push({
			severity: "error",
			code: "unrecognized-nav-entry",
			path,
			message:
				"Navigation entry must have exactly one of `article`, `group`, or `page` as its discriminator key.",
			hint: 'Add one of: `"article": "Title"`, `"group": "Section"`, or `"page": "TabName"`.',
		});
		return;
	}
	if (discriminatorCount > 1) {
		issues.push({
			severity: "error",
			code: "nav-entry-multiple-discriminators",
			path,
			message: "Navigation entry has more than one of `article` / `group` / `page` — pick exactly one.",
		});
		// Fall through so the user also sees what's wrong inside the entry.
	}

	if (hasArticle) {
		validateArticle(entry, path, issues);
	} else if (hasGroup) {
		validateGroup(entry, path, issues);
	} else if (hasPage) {
		validatePage(entry, path, issues);
	}
}

function validateArticle(article: Record<string, unknown>, path: (string | number)[], issues: ValidationIssue[]): void {
	// Rule: article-with-openapi
	if ("openapi" in article) {
		issues.push({
			severity: "error",
			code: "article-with-openapi",
			path,
			message:
				'`openapi` is only valid on a NavigationPage (entry with `"page": ...`), not on a NavigationArticle.',
			hint:
				'Either change this entry to a page (`{ "page": "REST API", "openapi": "/api/openapi.yaml" }`), ' +
				"or remove the `openapi` field and give the article a real `href`.",
		});
	}

	// Rule: article-without-href (skipped for external links with a real URL)
	const isExternal = article.type === "external";
	const href = article.href;
	const hrefMissing = typeof href !== "string" || href.length === 0;
	if (hrefMissing && !isExternal) {
		issues.push({
			severity: "error",
			code: "article-without-href",
			path: [...path, "href"],
			message: "Article is missing a required `href` field.",
			hint:
				'Add `"href": "page-name"` (relative to the inherited root), ' +
				'or make it an external link with `"href": "https://..."` + `"type": "external"`.',
		});
	}

	// Recurse into nested `articles[]` (NavigationArticle children).
	if (Array.isArray(article.articles)) {
		for (let i = 0; i < article.articles.length; i++) {
			validateNavEntry(article.articles[i], [...path, "articles", i], issues);
		}
	}
}

function validateGroup(group: Record<string, unknown>, path: (string | number)[], issues: ValidationIssue[]): void {
	if (!Array.isArray(group.content)) {
		// Groups must have a `content` array. Missing or wrong-type lands as
		// an error since the rest of the parser unconditionally iterates it.
		issues.push({
			severity: "error",
			code: "group-missing-content",
			path,
			message: "Group is missing a required `content` array.",
			hint: 'Add `"content": [ { "article": "...", "href": "..." }, ... ]`.',
		});
		return;
	}
	for (let i = 0; i < group.content.length; i++) {
		validateNavEntry(group.content[i], [...path, "content", i], issues);
	}
}

function validatePage(page: Record<string, unknown>, path: (string | number)[], issues: ValidationIssue[]): void {
	// A page with `content` recurses into it. Other page-only checks
	// (openapi vs content mutual exclusion, missing both, menu-page items
	// shape) are deferred to commit 3.
	if (Array.isArray(page.content)) {
		for (let i = 0; i < page.content.length; i++) {
			validateNavEntry(page.content[i], [...path, "content", i], issues);
		}
	}
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeType(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

// ─── Location mapping ────────────────────────────────────────────────────────

/**
 * A `ValidationIssue` annotated with the line/column span of the offending
 * node in the original source text. Lines and columns are 1-indexed (matches
 * editor + CI conventions). `endLine` / `endColumn` cover the end of the
 * span so a downstream code-frame formatter can underline the full range.
 */
export interface ValidationIssueLocated extends ValidationIssue {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}

/**
 * Annotates each issue's `path` with the line/column it points at in
 * `rawText`. Useful for consumers that have the original site.json source
 * and want to show users exactly where the problem is.
 *
 * When a path doesn't resolve to a node in the source (e.g. an
 * `article-without-href` issue whose `path` includes a key that doesn't
 * exist), the function walks UP the path until it finds a parent that
 * does exist, and anchors there. Worst case (no part of the path is
 * found) anchors at the document root. Never throws.
 */
export function locateIssues(rawText: string, issues: ValidationIssue[]): ValidationIssueLocated[] {
	const root = parseTree(rawText);
	const lineStarts = buildLineStartIndex(rawText);
	return issues.map((issue) => ({
		...issue,
		...resolveIssuePosition(root, lineStarts, issue.path),
	}));
}

// ─── Location helpers ────────────────────────────────────────────────────────

interface Position {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}

const DEFAULT_POSITION: Position = { line: 1, column: 1, endLine: 1, endColumn: 1 };

function resolveIssuePosition(
	root: Node | undefined,
	lineStarts: readonly number[],
	path: (string | number)[],
): Position {
	if (!root) return DEFAULT_POSITION;

	// Walk the path. If the full path doesn't resolve (e.g. the missing
	// field the validator is complaining about), trim one segment at a
	// time until we hit a node that exists. That node — the deepest valid
	// ancestor — anchors the diagnostic.
	for (let len = path.length; len >= 0; len--) {
		const candidate = path.slice(0, len);
		const node = candidate.length === 0 ? root : findNodeAtLocation(root, candidate);
		if (node) return nodeSpan(node, lineStarts);
	}
	return DEFAULT_POSITION;
}

function nodeSpan(node: Node, lineStarts: readonly number[]): Position {
	const start = offsetToPosition(lineStarts, node.offset);
	const end = offsetToPosition(lineStarts, node.offset + node.length);
	return { line: start.line, column: start.column, endLine: end.line, endColumn: end.column };
}

function buildLineStartIndex(text: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			starts.push(i + 1);
		}
	}
	return starts;
}

/**
 * Converts a byte offset into a 1-indexed {line, column}. Uses the
 * pre-built line-start index so each call is O(log L) — the index lives
 * for the duration of one `locateIssues` call and is reused across all
 * issues in that batch.
 */
function offsetToPosition(starts: readonly number[], offset: number): { line: number; column: number } {
	// Binary search for the largest start <= offset.
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo + 1, column: offset - starts[lo] + 1 };
}
