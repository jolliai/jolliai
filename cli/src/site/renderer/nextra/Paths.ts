/**
 * Path conventions for the Nextra OpenAPI emitter.
 *
 * Each spec lives in its own top-level folder `content/api-{specName}/...`
 * so Nextra binds it as a folder-scoped page-tab — when the user is on
 * `/api-{spec}/...` the sidebar shows ONLY that spec's tree (not a merged
 * list of every spec). Switching specs happens via the navbar dropdown.
 *
 * Per-endpoint MDX shims live two levels deep so the relative import to
 * `components/api/...` is `../../../`. The previous (deeper) layout broke
 * Vercel builds with "Module not found" outside the project root.
 */

import { slugify } from "../../openapi/Slug.js";
import type { OpenApiOperation } from "../../openapi/Types.js";

// ─── apiSpecFolderSlug ───────────────────────────────────────────────────────

/**
 * Folder slug for one spec's tree. The `api-` prefix avoids collisions with
 * regular doc article slugs and also drives Nextra's per-spec page-tab
 * binding.
 */
export function apiSpecFolderSlug(specName: string): string {
	return `api-${specName}`;
}

// ─── tagSlug ─────────────────────────────────────────────────────────────────

/**
 * Slugifies a tag name. Sidebar generation, the overview-page table links,
 * and per-tag `_meta.ts` filenames must all agree on the slug.
 */
export function tagSlug(tag: string): string {
	return slugify(tag);
}

// ─── endpointPagePath ────────────────────────────────────────────────────────

/**
 * Project-root-relative path for an endpoint's MDX shim.
 * `content/api-{spec}/{tag-slug}/{operationId}.mdx`.
 */
export function endpointPagePath(specName: string, operation: OpenApiOperation): string {
	return `content/${apiSpecFolderSlug(specName)}/${tagSlug(operation.tag)}/${operation.operationId}.mdx`;
}

// ─── endpointRoutePath ───────────────────────────────────────────────────────

/**
 * Public route an endpoint's MDX page is served at. Used for sidebar hrefs
 * and intra-spec cross-links.
 */
export function endpointRoutePath(specName: string, operation: OpenApiOperation): string {
	return `/${apiSpecFolderSlug(specName)}/${tagSlug(operation.tag)}/${operation.operationId}`;
}

// ─── endpointDataPath ────────────────────────────────────────────────────────

/**
 * Project-root-relative path for an operation's JSON sidecar. The leading
 * underscore on `_data` matches Nextra's convention for directories that
 * should be importable from MDX but skipped from the page-tree walk (same
 * as `_meta.ts` and `_refs.ts`).
 */
export function endpointDataPath(specName: string, operation: OpenApiOperation): string {
	return `content/${apiSpecFolderSlug(specName)}/_data/${operation.operationId}.json`;
}

// ─── endpointDataImportSpecifier ─────────────────────────────────────────────

/**
 * Specifier used inside the MDX shim's `import data from '...'` statement.
 * The shim lives at `content/api-{spec}/{tag-slug}/{operationId}.mdx` (two
 * levels deep under the spec folder), so the relative import resolves up
 * one directory and into `_data/`.
 */
export function endpointDataImportSpecifier(operation: OpenApiOperation): string {
	return `../_data/${operation.operationId}.json`;
}
