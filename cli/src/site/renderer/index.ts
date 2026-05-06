/**
 * Renderer registry — resolves a SiteRenderer from site.json config.
 */

import type { SiteJson } from "../Types.js";
import { NextraRenderer } from "./NextraRenderer.js";
import type { SiteRenderer } from "./SiteRenderer.js";

export type { ContentRules, SiteRenderer } from "./SiteRenderer.js";

/**
 * Returns the appropriate SiteRenderer for the given config.
 * Defaults to "nextra" when no `renderer` field is set.
 */
export function resolveRenderer(config: SiteJson): SiteRenderer {
	const name = config.renderer ?? "nextra";
	switch (name) {
		case "nextra":
			return new NextraRenderer();
		default:
			throw new Error(`Unknown renderer: "${name}". Supported: nextra`);
	}
}
