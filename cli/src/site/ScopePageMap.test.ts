/**
 * Tests for `scopePageMap` — the runtime pageMap filter embedded into the
 * generated `<ScopedNextraLayout>` client component.
 *
 * This filter ships verbatim into the customer's `app/layout.tsx`, so any
 * behaviour change here lands in every customer site on the next CLI build.
 */

import { describe, expect, it } from "vitest";
import { SCOPE_PAGE_MAP_RUNTIME_SOURCE, type ScopePageMapItem, scopePageMap } from "./ScopePageMap.js";

/**
 * Shared fixture builder — produces a pageMap shape that mirrors what
 * Nextra's `getPageMap()` returns after merge-meta. The first item is the
 * `data` block (root `_meta.ts`), followed by file/folder items.
 */
function buildPageMap(opts: {
	dataEntries: Record<string, unknown>;
	folderNames: Array<string>;
	fileNames?: Array<string>;
}): Array<ScopePageMapItem> {
	const items: Array<ScopePageMapItem> = [{ data: opts.dataEntries }];
	for (const name of opts.folderNames) {
		items.push({ name, route: `/${name}`, children: [] } as ScopePageMapItem);
	}
	for (const name of opts.fileNames ?? []) {
		items.push({ name, route: name === "index" ? "/" : `/${name}` } as ScopePageMapItem);
	}
	return items;
}

function getData(result: ReturnType<typeof scopePageMap>): Record<string, unknown> {
	const first = result.scopedPageMap[0];
	if (first && "data" in first && first.data) {
		return first.data as Record<string, unknown>;
	}
	throw new Error("Expected first item to be the data block");
}

function getFolderNames(result: ReturnType<typeof scopePageMap>): Array<string> {
	return result.scopedPageMap
		.filter((i) => "name" in i && typeof (i as { name: string }).name === "string")
		.map((i) => (i as { name: string }).name);
}

describe("scopePageMap — single-spec site", () => {
	const SINGLE_SPEC_PAGEMAP = buildPageMap({
		dataEntries: {
			index: { display: "hidden" },
			"getting-started": "Getting Started",
			__documentation: { title: "Documentation", type: "page", href: "/" },
			"api-petstore": { title: "API Reference", type: "page", href: "/api-petstore" },
		},
		folderNames: ["api-petstore"],
		fileNames: ["index", "getting-started"],
	});

	it("on a docs route, keeps the api-petstore folder and data entry so the navbar tab renders as a link", () => {
		const result = scopePageMap(SINGLE_SPEC_PAGEMAP, "/getting-started");

		// Folder for the spec is preserved in docs scope when its data entry
		// carries an `href` — Nextra renders a navbar tab from a data override
		// only when there's a matching pageMap item to attach it to. Without
		// the folder, the "API Reference" tab silently disappears in docs scope.
		expect(getFolderNames(result)).toContain("api-petstore");
		expect(getFolderNames(result)).toContain("index");
		expect(getFolderNames(result)).toContain("getting-started");

		// Data: api-petstore retained as a link entry so the navbar tab is a
		// link to /api-petstore (not a folder-bound sidebar tab). Documentation
		// also kept.
		const data = getData(result);
		expect(data["api-petstore"]).toEqual({
			title: "API Reference",
			type: "page",
			href: "/api-petstore",
		});
		expect(data.__documentation).toBeDefined();
		expect(data.index).toBeDefined();
	});

	it("on the active spec route, keeps the api-petstore folder and strips href so Nextra folder-binds it", () => {
		const result = scopePageMap(SINGLE_SPEC_PAGEMAP, "/api-petstore/pets/list");

		// Folders: active spec folder is kept. Non-api top-level items (the docs
		// files) pass through unchanged — the wrapper only touches the api-* slot.
		expect(getFolderNames(result)).toContain("api-petstore");
		expect(getFolderNames(result)).toContain("getting-started");

		// Data: active spec entry has href stripped so Nextra binds the folder
		// for sidebar scoping. Title is preserved.
		const data = getData(result);
		expect(data["api-petstore"]).toEqual({ title: "API Reference", type: "page" });
		expect(data.__documentation).toBeDefined();
	});

	it("classifies a single-spec site as not multi-spec (one folder + one data entry = 2 mentions)", () => {
		const result = scopePageMap(SINGLE_SPEC_PAGEMAP, "/");
		expect(result.isMultiSpec).toBe(false);
	});
});

describe("scopePageMap — multi-spec site", () => {
	const MULTI_SPEC_PAGEMAP = buildPageMap({
		dataEntries: {
			index: { display: "hidden" },
			"getting-started": "Getting Started",
			__documentation: { title: "Documentation", type: "page", href: "/" },
			"api-petstore": { title: "Petstore API", type: "page", display: "hidden" },
			"api-users": { title: "Users API", type: "page", display: "hidden" },
			"__api-reference": {
				title: "API Reference",
				type: "menu",
				items: {
					petstore: { title: "Petstore API", href: "/api-petstore" },
					users: { title: "Users API", href: "/api-users" },
				},
			},
		},
		folderNames: ["api-petstore", "api-users"],
		fileNames: ["index", "getting-started"],
	});

	it("on a docs route, drops every api-* folder and every hidden api-* data entry, keeping the dropdown", () => {
		const result = scopePageMap(MULTI_SPEC_PAGEMAP, "/getting-started");

		expect(getFolderNames(result)).not.toContain("api-petstore");
		expect(getFolderNames(result)).not.toContain("api-users");

		const data = getData(result);
		// Hidden per-spec entries (no href) are dropped to keep the data block clean.
		expect(data["api-petstore"]).toBeUndefined();
		expect(data["api-users"]).toBeUndefined();
		// Dropdown menu (key is __api-reference, not api-*) survives.
		expect(data["__api-reference"]).toBeDefined();
		expect(data.__documentation).toBeDefined();
	});

	it("on the active spec route, keeps the active spec folder, drops other api-* folders, and unhides its data entry", () => {
		const result = scopePageMap(MULTI_SPEC_PAGEMAP, "/api-petstore/pets/list");

		// Folders: active spec kept; other api-* folder dropped so its
		// children don't pollute the active sidebar. Non-api top-level items
		// pass through.
		expect(getFolderNames(result)).toContain("api-petstore");
		expect(getFolderNames(result)).not.toContain("api-users");

		const data = getData(result);
		// Active spec: display: hidden stripped so Nextra binds it as a
		// visible folder-bound page-tab and scopes the sidebar to its
		// children. CSS hides the now-visible navbar tab.
		expect(data["api-petstore"]).toEqual({ title: "Petstore API", type: "page" });
		// Other spec: dropped from data so its data entry doesn't fail
		// Nextra's "metaItem references missing folder" validation.
		expect(data["api-users"]).toBeUndefined();
		// Dropdown + Documentation: preserved so the user can navigate elsewhere.
		expect(data["__api-reference"]).toBeDefined();
		expect(data.__documentation).toBeDefined();
	});

	it("classifies multi-spec sites as multi-spec (>2 api-* mentions across folders + data)", () => {
		const result = scopePageMap(MULTI_SPEC_PAGEMAP, "/");
		expect(result.isMultiSpec).toBe(true);
	});
});

describe("scopePageMap — edge cases", () => {
	it("returns an empty pageMap unchanged", () => {
		const result = scopePageMap([], "/");
		expect(result.scopedPageMap).toEqual([]);
		expect(result.isMultiSpec).toBe(false);
	});

	it("treats the bare /api-foo route as API scope (no trailing slash, no children path)", () => {
		const pageMap = buildPageMap({
			dataEntries: {
				"api-foo": { title: "API Reference", type: "page", href: "/api-foo" },
			},
			folderNames: ["api-foo"],
		});
		const result = scopePageMap(pageMap, "/api-foo");

		expect(getFolderNames(result)).toContain("api-foo");
		expect(getData(result)["api-foo"]).toEqual({ title: "API Reference", type: "page" });
	});

	it("does not treat /api as API scope — the regex requires a slug after the api- prefix", () => {
		// The data entry has no href, so the link-form preservation path doesn't
		// fire and the folder is dropped in docs scope.
		const pageMap = buildPageMap({
			dataEntries: {
				"api-foo": { title: "Hidden", type: "page", display: "hidden" },
			},
			folderNames: ["api-foo"],
		});
		// `/api` doesn't match `/api-{slug}`; should fall through to docs scope.
		const result = scopePageMap(pageMap, "/api");
		expect(getFolderNames(result)).not.toContain("api-foo");
	});

	it("keeps a link-form api folder in docs scope so the navbar tab renders", () => {
		// Counterpart to the test above — when the data entry has an href, the
		// folder must be preserved even in docs scope so Nextra has an item to
		// attach the navbar tab to.
		const pageMap = buildPageMap({
			dataEntries: {
				"api-foo": { title: "API Reference", type: "page", href: "/api-foo" },
			},
			folderNames: ["api-foo"],
		});
		const result = scopePageMap(pageMap, "/getting-started");
		expect(getFolderNames(result)).toContain("api-foo");
	});

	it("preserves non-api folders verbatim regardless of scope", () => {
		const pageMap = buildPageMap({
			dataEntries: { docs: "Docs" },
			folderNames: ["docs", "api-foo"],
		});
		const apiResult = scopePageMap(pageMap, "/api-foo");
		expect(getFolderNames(apiResult)).toContain("api-foo");
		// `docs` folder is non-api so it stays.
		expect(getFolderNames(apiResult)).toContain("docs");
	});

	it("keeps non-string-key items (any unrecognized shape) untouched", () => {
		const opaqueItem = { someOtherShape: true } as ScopePageMapItem;
		const pageMap: Array<ScopePageMapItem> = [{ data: { __documentation: { href: "/" } } }, opaqueItem];
		const result = scopePageMap(pageMap, "/");
		expect(result.scopedPageMap).toContain(opaqueItem);
	});

	it("treats string-typed data entries (e.g. {key: 'Label'}) as opaque — no api-* substring matching on the value", () => {
		const pageMap = buildPageMap({
			dataEntries: {
				"some-page": "api-something-in-label",
				__documentation: { title: "Documentation", type: "page", href: "/" },
			},
			folderNames: ["some-page"],
		});
		const result = scopePageMap(pageMap, "/getting-started");
		expect(getData(result)["some-page"]).toBe("api-something-in-label");
	});
});

// ─── Parity: SCOPE_PAGE_MAP_RUNTIME_SOURCE matches the typed function ───────

/**
 * The runtime source string is what actually ships into the customer's
 * Next.js bundle (via `<ScopedNextraLayout>`). The typed `scopePageMap`
 * function above is what the CLI's tests + tooling consume. Both must
 * produce identical output for every input — drift means the customer's
 * site behaves differently from what our tests verify.
 *
 * We materialise the string via `new Function` (no module scope, no
 * imports — exactly the constraints of the customer's pasted file), then
 * run both implementations through a representative fixture set and assert
 * deep equality.
 */
describe("scopePageMap runtime source parity", () => {
	const runtimeScopePageMap = new Function(
		`${SCOPE_PAGE_MAP_RUNTIME_SOURCE}\nreturn scopePageMap;`,
	)() as typeof scopePageMap;

	const FIXTURES: Array<{ name: string; pageMap: Array<ScopePageMapItem>; pathname: string }> = [
		{
			name: "single-spec, docs route",
			pageMap: buildPageMap({
				dataEntries: {
					index: { display: "hidden" },
					"getting-started": "Getting Started",
					__documentation: { title: "Documentation", type: "page", href: "/" },
					"api-petstore": { title: "API Reference", type: "page", href: "/api-petstore" },
				},
				folderNames: ["api-petstore"],
				fileNames: ["index", "getting-started"],
			}),
			pathname: "/getting-started",
		},
		{
			name: "single-spec, active spec route",
			pageMap: buildPageMap({
				dataEntries: {
					"api-petstore": { title: "API Reference", type: "page", href: "/api-petstore" },
				},
				folderNames: ["api-petstore"],
			}),
			pathname: "/api-petstore/pets/list",
		},
		{
			name: "multi-spec, docs route",
			pageMap: buildPageMap({
				dataEntries: {
					"api-petstore": { title: "Petstore", type: "page", display: "hidden" },
					"api-users": { title: "Users", type: "page", display: "hidden" },
					"__api-reference": {
						title: "API Reference",
						type: "menu",
						items: { petstore: { title: "Petstore", href: "/api-petstore" } },
					},
				},
				folderNames: ["api-petstore", "api-users"],
			}),
			pathname: "/",
		},
		{
			name: "multi-spec, active spec route",
			pageMap: buildPageMap({
				dataEntries: {
					"api-petstore": { title: "Petstore", type: "page", display: "hidden" },
					"api-users": { title: "Users", type: "page", display: "hidden" },
				},
				folderNames: ["api-petstore", "api-users"],
			}),
			pathname: "/api-petstore/foo",
		},
		{
			name: "empty pageMap",
			pageMap: [],
			pathname: "/",
		},
		{
			name: "non-api folders only",
			pageMap: buildPageMap({
				dataEntries: { docs: "Docs" },
				folderNames: ["docs"],
			}),
			pathname: "/docs",
		},
	];

	for (const fixture of FIXTURES) {
		it(`runtime source matches typed function: ${fixture.name}`, () => {
			const typed = scopePageMap(fixture.pageMap, fixture.pathname);
			const runtime = runtimeScopePageMap(fixture.pageMap, fixture.pathname);
			expect(runtime).toEqual(typed);
		});
	}
});
