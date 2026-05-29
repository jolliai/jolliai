/**
 * SpecLoader — parses and validates OpenAPI documents from JSON or YAML.
 *
 * Returns the parsed AST when the document is well-formed and has the two
 * top-level fields the OpenAPI spec requires (`openapi` and `info`).
 * Returns `null` for anything that fails to parse or fails the structural
 * check, so callers can sniff arbitrary `.json` / `.yaml` / `.yml` files
 * for OpenAPI-ness without filename conventions.
 */

import { parse as parseYaml } from "yaml";
import type { OpenApiDocument } from "./Types.js";

// ─── tryParseOpenApi ─────────────────────────────────────────────────────────

/**
 * Parses `content` according to `ext` (`.json`, `.yaml`, or `.yml`) and
 * returns the parsed document if it looks like an OpenAPI spec, else `null`.
 *
 * The structural requirement is intentionally minimal — `openapi` must be a
 * string and `info` must be a non-null object. Phase 2's `parseFullSpec`
 * does the deeper walk (operations, refs, collisions).
 *
 * @param content - File contents.
 * @param ext     - File extension including the leading dot (case-insensitive).
 */
export function tryParseOpenApi(content: string, ext: string): OpenApiDocument | null {
	const normalized = ext.toLowerCase();

	let parsed: unknown;
	if (normalized === ".json") {
		try {
			parsed = JSON.parse(content);
		} catch {
			return null;
		}
	} else if (normalized === ".yaml" || normalized === ".yml") {
		try {
			parsed = parseYaml(content);
		} catch {
			return null;
		}
	} else {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}

	const doc = parsed as Record<string, unknown>;
	if (typeof doc.openapi !== "string" || doc.openapi.length === 0) {
		return null;
	}
	if (typeof doc.info !== "object" || doc.info === null || Array.isArray(doc.info)) {
		return null;
	}

	return doc as OpenApiDocument;
}

// ─── isOpenApiExtension ──────────────────────────────────────────────────────

/** Returns `true` if the extension is one we should attempt to sniff. */
export function isOpenApiExtension(ext: string): boolean {
	const e = ext.toLowerCase();
	return e === ".json" || e === ".yaml" || e === ".yml";
}
