/**
 * SpecName — derives the URL slug used in `/api-{specName}/...` routes
 * from an OpenAPI source file's relative path.
 *
 * Strategy: take the basename without extension, slugify it. Two specs
 * whose basenames slugify to the same value would collide on disk and on
 * the URL. Disambiguation by containing folder is intentionally not done
 * here — emitters that walk an array of inputs should detect collisions
 * up front and surface them with an actionable error.
 */

import { basename, extname } from "node:path";
import { slugify } from "./Slug.js";

export function deriveSpecName(relPath: string): string {
	const ext = extname(relPath);
	const base = basename(relPath, ext);
	return slugify(base);
}
