/**
 * Emits `components/apiNavMethods.ts` — a static route → HTTP-method lookup
 * the sidebar badge client component (`ApiNavMethodBadges.tsx`) reads to stamp
 * a `data-api-method` attribute onto each API endpoint's sidebar link. The
 * theme's CSS turns that attribute into the visible method chip.
 *
 * Nextra v4 has no sidebar `titleComponent` hook and its page-map titles are
 * plain strings, so a method badge can't be injected through the navigation
 * data itself — hence the client-side stamping driven by this map.
 *
 * `initProject` writes `EMPTY_API_NAV_METHODS` once so the layout's import
 * always resolves (even for a site with no specs); a build with specs then
 * overwrites it with the populated map.
 */

import type { OpenApiSpecInput } from "../../openapi/Types.js";
import { endpointRoutePath } from "./Paths.js";
import type { TemplateFile } from "./Types.js";

const MAP_PATH = "components/apiNavMethods.ts";

/** Empty map module — written at init so the layout import always resolves. */
export const EMPTY_API_NAV_METHODS: TemplateFile = {
	path: MAP_PATH,
	content: "export const API_NAV_METHODS: Record<string, string> = {};\n",
};

/**
 * Builds the route → uppercase-method map for every operation across the
 * supplied specs and serialises it as a typed ES module.
 */
export function emitApiNavMethods(specs: ReadonlyArray<OpenApiSpecInput>): TemplateFile {
	const map: Record<string, string> = {};
	for (const { specName, pipeline } of specs) {
		for (const op of pipeline.spec.operations) {
			map[endpointRoutePath(specName, op)] = op.method.toUpperCase();
		}
	}
	return {
		path: MAP_PATH,
		content: `export const API_NAV_METHODS: Record<string, string> = ${JSON.stringify(map, null, 2)};\n`,
	};
}
