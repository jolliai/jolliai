/**
 * Pure pageMap-filtering logic shared between the CLI generator (which embeds
 * the function source into the emitted `<ScopedNextraLayout>` client
 * component) and the unit tests (which test the function directly).
 *
 * Ported verbatim from the SaaS `tools/nextra-generator/src/utils/ScopePageMap.ts`
 * (post-1392). The actual emitted component is built by
 * `NextraProjectWriter.writeScopedNextraLayoutComponent`, which inlines this
 * function via `scopePageMap.toString()`. Keeping the logic here means there
 * is one source of truth — change behaviour here and both the generated
 * client and the tests pick it up.
 *
 * IMPORTANT: do NOT import anything in this module that the generated client
 * cannot resolve (no Node-only APIs, no Nextra runtime imports). The function
 * gets stringified and pasted into the customer's Next.js app, where its
 * only ambient dependencies are JS built-ins.
 */

/** Item shape mirrors Nextra's PageMapItem just enough for filtering. */
export type ScopeMetaValue = unknown;
export interface ScopeDataItem {
	data: Record<string, ScopeMetaValue>;
}
export interface ScopeNamedItem {
	name: string;
	[k: string]: unknown;
}
export type ScopePageMapItem = ScopeDataItem | ScopeNamedItem | Record<string, unknown>;

export interface ScopeResult {
	scopedPageMap: Array<ScopePageMapItem>;
	isMultiSpec: boolean;
}

const API_PREFIX = "api-";

/** Counts api-* mentions across folders and data entries in one pass. */
function countApiMentions(pageMap: ReadonlyArray<ScopePageMapItem>): number {
	let total = 0;
	for (const item of pageMap) {
		if ("name" in item && typeof item.name === "string" && item.name.startsWith(API_PREFIX)) {
			total += 1;
		}
		if ("data" in item && item.data) {
			for (const key of Object.keys(item.data)) {
				if (key.startsWith(API_PREFIX)) {
					total += 1;
				}
			}
		}
	}
	return total;
}

/**
 * Strips `href` and `display` from an active spec's data entry so Nextra
 * folder-binds it instead of treating it as a link or hiding it. Non-object
 * values (rare — e.g. a string title) pass through unchanged.
 */
function unhideActiveSpec(val: unknown): unknown {
	if (val === null || typeof val !== "object") {
		return val;
	}
	const rest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(val)) {
		if (k === "href" || k === "display") {
			continue;
		}
		rest[k] = v;
	}
	return rest;
}

/** Decides whether to keep an `api-*` data entry in the current scope, and
 *  what shape to keep it in. Returns `undefined` to drop. */
function scopedApiDataEntry(
	key: string,
	val: unknown,
	isApiScope: boolean,
	activeSpecKey: string | undefined,
): unknown {
	if (isApiScope) {
		if (key !== activeSpecKey) {
			return;
		}
		return unhideActiveSpec(val);
	}
	// Docs scope: keep link-form entries, drop hidden ones.
	if (val !== null && typeof val === "object" && "href" in val) {
		return val;
	}
	return;
}

function scopeDataBlock(
	data: Record<string, unknown>,
	isApiScope: boolean,
	activeSpecKey: string | undefined,
): Record<string, unknown> {
	const newData: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(data)) {
		if (!key.startsWith(API_PREFIX)) {
			newData[key] = val;
			continue;
		}
		const scoped = scopedApiDataEntry(key, val, isApiScope, activeSpecKey);
		if (scoped !== undefined) {
			newData[key] = scoped;
		}
	}
	return newData;
}

/**
 * Collect the set of `api-*` data-entry keys that carry an `href` (single-spec
 * navbar link form). Nextra renders a navbar tab from a data override only
 * when there is a corresponding folder in the pageMap to attach it to — so
 * when we drop the folder, the tab disappears too. We keep folders for these
 * link-form entries even in docs scope so the navbar tab survives.
 */
function collectLinkFormApiKeys(pageMap: ReadonlyArray<ScopePageMapItem>): Set<string> {
	const out = new Set<string>();
	for (const item of pageMap) {
		if (!("data" in item) || !item.data) {
			continue;
		}
		for (const [key, val] of Object.entries(item.data)) {
			if (!key.startsWith(API_PREFIX)) {
				continue;
			}
			if (val !== null && typeof val === "object" && "href" in val) {
				out.add(key);
			}
		}
	}
	return out;
}

/**
 * Filters the pageMap to the active scope:
 *   - In API scope (URL under `/api-{slug}`): keep only that spec's folder
 *     plus non-api data entries (`__documentation`, `__api-reference`),
 *     and unhide the active spec's data entry so Nextra binds it for
 *     sidebar scoping (drops `href` for the single-spec case and
 *     `display: 'hidden'` for the multi-spec case).
 *   - In docs scope (anywhere else): keep folders for link-form entries
 *     (single-spec sites whose data entry has `href`) so Nextra still
 *     renders the navbar tab; drop everything else. Keep `api-*` data
 *     entries that carry an `href` (so the navbar tab is a link, not a
 *     folder-bound page); drop the rest.
 *
 * Counts api-* entries before filtering so multi-spec sites can set the
 * `data-jolli-multi-spec` attribute used by pack CSS to hide the per-spec
 * navbar tab in API scope (the dropdown takes its place).
 */
export function scopePageMap(pageMap: ReadonlyArray<ScopePageMapItem>, pathname: string): ScopeResult {
	const apiMatch = /^\/(api-[^/]+)/.exec(pathname);
	const isApiScope = apiMatch !== null;
	const activeSpecKey = apiMatch?.[1];
	// Folder + data-entry counts can double-count the same spec (one folder +
	// one data entry per spec). `isMultiSpec` only drives a CSS toggle, so
	// erring on the side of "single" when in doubt is fine.
	const isMultiSpec = countApiMentions(pageMap) > 2;

	const linkFormKeys = collectLinkFormApiKeys(pageMap);

	const scoped: Array<ScopePageMapItem> = [];
	for (const item of pageMap) {
		if ("data" in item && item.data) {
			const newData = scopeDataBlock(item.data as Record<string, unknown>, isApiScope, activeSpecKey);
			// biome-ignore lint/suspicious/noExplicitAny: Nextra's PageMap union widens unsafely on spread; cast at the boundary.
			scoped.push({ ...(item as any), data: newData });
			continue;
		}
		if ("name" in item && typeof item.name === "string") {
			const name = item.name;
			const isApiFolder = name.startsWith(API_PREFIX);
			const keepFolder =
				!isApiFolder ||
				(isApiScope && name === activeSpecKey) ||
				// Docs scope: keep the folder when a link-form data entry exists for
				// it, otherwise Nextra has no underlying item to render the navbar
				// tab against and the "API Reference" link silently disappears.
				(!isApiScope && linkFormKeys.has(name));
			if (keepFolder) {
				scoped.push(item);
			}
			continue;
		}
		scoped.push(item);
	}

	return { scopedPageMap: scoped, isMultiSpec };
}

/**
 * Bundles the runtime source of `scopePageMap` and every helper it relies
 * on into a single string ready to be inlined into the generated React
 * component. The generator just inserts this verbatim — no need to know
 * which helpers exist or how they are wired together. If we add a new
 * helper, append its `.toString()` here and it ships automatically.
 */
export const SCOPE_PAGE_MAP_RUNTIME_SOURCE = [
	`const API_PREFIX = ${JSON.stringify(API_PREFIX)};`,
	countApiMentions.toString(),
	unhideActiveSpec.toString(),
	scopedApiDataEntry.toString(),
	scopeDataBlock.toString(),
	collectLinkFormApiKeys.toString(),
	scopePageMap.toString(),
].join("\n\n");
