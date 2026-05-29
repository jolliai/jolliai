/**
 * SiteJsonValidator (commit 1: shape rules, no position mapping yet).
 *
 * Walks a parsed `site.json` object and returns a list of `ValidationIssue`s
 * describing every shape mistake found. Does not throw — caller decides
 * what to do with the list (CLI prints a friendly error and bails; web
 * tool overlays inline diagnostics in the editor; CI surfaces them as
 * GitHub annotations).
 *
 * Position mapping (turning each `path` into a `{line, column}` against
 * the raw text via `jsonc-parser`) lands in commit 2; pretty formatting
 * with code-frame snippets in commit 3.
 *
 * No I/O. Operates entirely on the JSON.parse output, treated as
 * `unknown` so a malformed site.json can't crash the validator before
 * the validator reports it.
 */

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
