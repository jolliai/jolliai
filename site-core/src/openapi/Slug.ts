/**
 * Slug — small utility for converting human strings into URL-safe slugs.
 *
 * The same slug function is used by `SpecParser` (operationId / tag slugs)
 * and by future emitters (URL path construction). Keeping it in its own
 * tiny module avoids dragging in unrelated content-pipeline helpers.
 */

import { isReservedSlug } from "./ReservedWords.js";

/**
 * Generates a base slug from text without any safety checks.
 * Internal helper — `slugify` wraps it to apply the reserved-word fallback.
 */
function generateBaseSlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Converts a title to a URL-safe slug.
 *
 * - Empty / whitespace-only inputs become `"untitled"`.
 * - Slugs that happen to collide with JS / TS reserved words get a `-doc`
 *   suffix (e.g. `"export"` → `"export-doc"`) to prevent build failures
 *   when the slug is compiled into a JS module path.
 */
export function slugify(text: string): string {
	const base = generateBaseSlug(text);
	if (!base) {
		return "untitled";
	}
	return isReservedSlug(base) ? `${base}-doc` : base;
}
