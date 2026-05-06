/**
 * SpecParser — analyses a raw `OpenApiDocument` into the IR every emitter
 * consumes (`ParsedSpec`).
 *
 * Walks `paths × HTTP_METHODS` in declaration order so the sidebar matches
 * the spec author's intent. Resolves `$ref` parameters / request bodies /
 * responses inline. Detects `(tag, operationId)` collisions that would
 * silently overwrite the same per-endpoint output and throws with a clear
 * message. Component schemas are passed through untouched — emitters look
 * them up at render time via `ParsedSpec.componentSchemas`.
 */

import { slugify } from "./Slug.js";
import type {
	OpenApiDocument,
	OpenApiHttpMethod,
	OpenApiOperation,
	OpenApiParameter,
	OpenApiRequestBody,
	OpenApiResponse,
	OpenApiSecurityScheme,
	OpenApiServerEntry,
	OpenApiTagEntry,
	ParsedSpec,
} from "./Types.js";

const HTTP_METHODS: ReadonlyArray<OpenApiHttpMethod> = ["get", "post", "put", "patch", "delete", "head", "options"];

const DEFAULT_TAG = "default";

// ─── $ref resolution ─────────────────────────────────────────────────────────

interface RefObject {
	$ref: string;
}

function isRef(value: unknown): value is RefObject {
	return typeof value === "object" && value !== null && typeof (value as RefObject).$ref === "string";
}

/**
 * Walks a `$ref` like `#/components/schemas/User` against the root spec.
 * Returns `undefined` for refs we can't resolve (external files, malformed
 * paths) — callers fall back to leaving the ref in place so a renderer-side
 * schema component can still display the bare ref text.
 *
 * Per RFC 6901, JSON-Pointer tokens encode `/` as `~1` and `~` as `~0`;
 * `~1` MUST be unescaped before `~0` so an encoded `~1` literal in a key
 * doesn't get re-decoded. Real-world OpenAPI specs almost never have
 * those characters in component names, but specs that ref operations off
 * `paths` (e.g. `#/paths/~1users~1{id}/get`) rely on the correct order.
 */
function resolveRef(spec: Record<string, unknown>, ref: string): unknown {
	if (!ref.startsWith("#/")) {
		return;
	}
	const parts = ref
		.slice(2)
		.split("/")
		.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
	let cursor: unknown = spec;
	for (const part of parts) {
		if (typeof cursor !== "object" || cursor === null) {
			return;
		}
		cursor = (cursor as Record<string, unknown>)[part];
	}
	return cursor;
}

/** If `value` is a `$ref`, resolve it. Otherwise return as-is. */
function deref<T>(spec: Record<string, unknown>, value: unknown): T | undefined {
	if (isRef(value)) {
		return resolveRef(spec, value.$ref) as T | undefined;
	}
	return value as T | undefined;
}

// ─── Media-type / parameter / body / response normalisers ────────────────────

/**
 * Extracts the schema + first content-type pair from an OpenAPI mediaType
 * object. Prefers JSON when present so the try-it widget defaults to a JSON
 * editor; falls back to whatever's first in declaration order.
 */
function pickFirstMediaType(
	content: Record<string, { schema?: unknown; example?: unknown }> | undefined,
): { contentType: string; schema?: unknown; example?: unknown } | undefined {
	if (!content) {
		return;
	}
	const keys = Object.keys(content);
	if (keys.length === 0) {
		return;
	}
	const preferred = keys.find((k) => k.includes("json")) ?? keys[0];
	const entry = content[preferred];
	const result: { contentType: string; schema?: unknown; example?: unknown } = { contentType: preferred };
	if (entry.schema !== undefined) {
		result.schema = entry.schema;
	}
	if (entry.example !== undefined) {
		result.example = entry.example;
	}
	return result;
}

/**
 * Resolves a single `parameters[]` entry, following `$ref` if present, and
 * normalises the shape. Skips entries we can't make sense of.
 */
function normalizeParameter(spec: Record<string, unknown>, raw: unknown): OpenApiParameter | undefined {
	const param = deref<Record<string, unknown>>(spec, raw);
	if (!param || typeof param !== "object") {
		return;
	}
	const name = typeof param.name === "string" ? param.name : "";
	const location = typeof param.in === "string" ? param.in : "";
	if (!name || !["path", "query", "header", "cookie"].includes(location)) {
		return;
	}
	const result: OpenApiParameter = {
		name,
		in: location as OpenApiParameter["in"],
		required: param.required === true || location === "path",
	};
	if (typeof param.description === "string") {
		result.description = param.description;
	}
	if (param.schema !== undefined) {
		result.schema = param.schema;
	}
	if (param.example !== undefined) {
		result.example = param.example;
	}
	return result;
}

/** Resolves an operation's request body, following `$ref` if present. */
function normalizeRequestBody(spec: Record<string, unknown>, raw: unknown): OpenApiRequestBody | undefined {
	const body = deref<Record<string, unknown>>(spec, raw);
	if (!body || typeof body !== "object") {
		return;
	}
	const media = pickFirstMediaType(
		body.content as Record<string, { schema?: unknown; example?: unknown }> | undefined,
	);
	if (!media) {
		return;
	}
	const result: OpenApiRequestBody = {
		required: body.required === true,
		contentType: media.contentType,
	};
	if (typeof body.description === "string") {
		result.description = body.description;
	}
	if (media.schema !== undefined) {
		result.schema = media.schema;
	}
	if (media.example !== undefined) {
		result.example = media.example;
	}
	return result;
}

/**
 * Resolves the `responses` map for an operation into a flat array of
 * `{ status, description, schema }` entries — keeping declaration order so
 * the rendered docs page matches the spec author's intent.
 */
function normalizeResponses(spec: Record<string, unknown>, raw: unknown): OpenApiResponse[] {
	if (!raw || typeof raw !== "object") {
		return [];
	}
	const out: OpenApiResponse[] = [];
	for (const [status, value] of Object.entries(raw as Record<string, unknown>)) {
		const resp = deref<Record<string, unknown>>(spec, value);
		if (!resp) {
			continue;
		}
		const media = pickFirstMediaType(
			resp.content as Record<string, { schema?: unknown; example?: unknown }> | undefined,
		);
		const entry: OpenApiResponse = { status };
		if (typeof resp.description === "string") {
			entry.description = resp.description;
		}
		if (media) {
			entry.contentType = media.contentType;
			if (media.schema !== undefined) {
				entry.schema = media.schema;
			}
			if (media.example !== undefined) {
				entry.example = media.example;
			}
		}
		out.push(entry);
	}
	return out;
}

// ─── Operation-id / tag / parameter helpers ──────────────────────────────────

/**
 * Synthesises a stable operationId when the spec author didn't supply one.
 * Used as the route slug so URLs are deterministic across rebuilds.
 */
function makeOperationId(method: string, path: string, supplied?: string): string {
	if (supplied && typeof supplied === "string" && supplied.trim().length > 0) {
		return slugify(supplied);
	}
	const cleanedPath = path
		.replace(/[{}]/g, "")
		.replace(/\//g, "-")
		.replace(/^-+|-+$/g, "");
	return slugify(`${method}-${cleanedPath || "root"}`);
}

/**
 * Picks the primary tag for an operation. The spec allows multiple tags;
 * for sidebar grouping we use the first one (or the synthetic `default`
 * group when none are declared).
 */
function pickPrimaryTag(operationTags: unknown): string {
	if (Array.isArray(operationTags) && operationTags.length > 0 && typeof operationTags[0] === "string") {
		return operationTags[0];
	}
	return DEFAULT_TAG;
}

/**
 * Merges path-level parameters with operation-level parameters. Operation
 * params override path params with the same `(name, in)` key.
 */
function mergeParameters(pathParams: OpenApiParameter[], operationParams: OpenApiParameter[]): OpenApiParameter[] {
	const merged = new Map<string, OpenApiParameter>();
	for (const p of pathParams) {
		merged.set(`${p.name}::${p.in}`, p);
	}
	for (const p of operationParams) {
		merged.set(`${p.name}::${p.in}`, p);
	}
	return Array.from(merged.values());
}

/** Resolves a parameters array (typed `unknown[]` so we survive malformed input). */
function resolveParameters(root: Record<string, unknown>, raw: unknown): OpenApiParameter[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return (raw as unknown[])
		.map((p) => normalizeParameter(root, p))
		.filter((p): p is OpenApiParameter => p !== undefined);
}

// ─── Top-level extractors ────────────────────────────────────────────────────

/** Reads the spec's top-level `servers` array, dropping malformed entries. */
function extractServers(spec: OpenApiDocument): OpenApiServerEntry[] {
	const raw = spec.servers;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.filter((s): s is OpenApiServerEntry => typeof (s as OpenApiServerEntry)?.url === "string")
		.map((s) => ({
			url: s.url,
			...(s.description !== undefined ? { description: s.description } : {}),
		}));
}

/**
 * Resolves all `components.securitySchemes` entries against the root spec,
 * dereferencing any `$ref` pointers. Schemes without a `type` field are
 * dropped because the try-it widget can't render them.
 */
function extractSecuritySchemes(
	root: Record<string, unknown>,
	components: Record<string, unknown>,
): Record<string, OpenApiSecurityScheme> {
	const out: Record<string, OpenApiSecurityScheme> = {};
	const raw = (components.securitySchemes ?? {}) as Record<string, unknown>;
	for (const [name, value] of Object.entries(raw)) {
		const scheme = deref<Record<string, unknown>>(root, value);
		if (scheme && typeof scheme === "object" && typeof scheme.type === "string") {
			out[name] = scheme as unknown as OpenApiSecurityScheme;
		}
	}
	return out;
}

/**
 * Reads the spec's top-level `tags` array. Untagged-but-used names get
 * appended later as operations are walked.
 */
function extractTags(root: Record<string, unknown>): OpenApiTagEntry[] {
	const raw = Array.isArray(root.tags) ? (root.tags as unknown[]) : [];
	const out: OpenApiTagEntry[] = [];
	for (const t of raw) {
		if (t && typeof t === "object" && typeof (t as { name?: string }).name === "string") {
			const tagObj = t as { name: string; description?: string };
			out.push({
				name: tagObj.name,
				...(tagObj.description !== undefined ? { description: tagObj.description } : {}),
			});
		}
	}
	return out;
}

/** Reads an operation's per-operation `servers` override, if present. */
function extractOperationServers(operation: Record<string, unknown>): OpenApiServerEntry[] | undefined {
	if (!Array.isArray(operation.servers)) {
		return;
	}
	const result = (operation.servers as OpenApiServerEntry[])
		.filter((s) => typeof s?.url === "string")
		.map((s) => ({
			url: s.url,
			...(s.description !== undefined ? { description: s.description } : {}),
		}));
	return result.length > 0 ? result : undefined;
}

// ─── Per-operation builder + path walker ─────────────────────────────────────

/**
 * Builds a single OpenApiOperation from a path/method pair. Pulled out of
 * `walkOperations` so the latter stays readable — this function does ~80%
 * of the per-operation work.
 */
function buildOperationEntry(
	root: Record<string, unknown>,
	pathKey: string,
	method: OpenApiHttpMethod,
	operation: Record<string, unknown>,
	pathLevelParams: OpenApiParameter[],
	globalSecurity: Array<Record<string, string[]>>,
): OpenApiOperation {
	const operationParams = resolveParameters(root, operation.parameters);
	const requestBody = normalizeRequestBody(root, operation.requestBody);
	const responses = normalizeResponses(root, operation.responses);
	const security = Array.isArray(operation.security)
		? (operation.security as Array<Record<string, string[]>>)
		: globalSecurity;
	const operationServers = extractOperationServers(operation);
	const summary = typeof operation.summary === "string" ? operation.summary : `${method.toUpperCase()} ${pathKey}`;

	const entry: OpenApiOperation = {
		operationId: makeOperationId(
			method,
			pathKey,
			typeof operation.operationId === "string" ? operation.operationId : undefined,
		),
		method,
		path: pathKey,
		tag: pickPrimaryTag(operation.tags),
		summary,
		description: typeof operation.description === "string" ? operation.description : "",
		deprecated: operation.deprecated === true,
		parameters: mergeParameters(pathLevelParams, operationParams),
		responses,
		security,
	};
	if (requestBody) {
		entry.requestBody = requestBody;
	}
	if (operationServers) {
		entry.servers = operationServers;
	}
	return entry;
}

/**
 * Walks every (path, method) pair in the spec and emits operation entries
 * in declaration order. Also extends `tags` with any untagged-but-used tag
 * names (the synthetic `default` group, or names that appear only on
 * operations).
 *
 * Throws on `(slugified-tag, operationId)` collisions — each pair maps 1:1
 * to a per-endpoint output file, so a collision would silently drop one
 * endpoint from the generated site.
 */
function walkOperations(
	root: Record<string, unknown>,
	spec: OpenApiDocument,
	tags: OpenApiTagEntry[],
	globalSecurity: Array<Record<string, string[]>>,
): OpenApiOperation[] {
	const operations: OpenApiOperation[] = [];
	const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
	const seenTags = new Set<string>(tags.map((t) => t.name));
	const claimedSlots = new Map<string, { method: string; path: string }>();

	for (const [pathKey, pathItem] of Object.entries(paths)) {
		if (!pathItem || typeof pathItem !== "object") {
			continue;
		}
		const pathLevelParams = resolveParameters(root, pathItem.parameters);

		for (const method of HTTP_METHODS) {
			const op = pathItem[method];
			if (!op || typeof op !== "object") {
				continue;
			}
			const entry = buildOperationEntry(
				root,
				pathKey,
				method,
				op as Record<string, unknown>,
				pathLevelParams,
				globalSecurity,
			);
			const slotKey = `${slugify(entry.tag)}/${entry.operationId}`;
			const existing = claimedSlots.get(slotKey);
			if (existing) {
				throw new Error(
					`OpenAPI spec collision: operations ${existing.method.toUpperCase()} ${existing.path} and ` +
						`${method.toUpperCase()} ${pathKey} would generate the same MDX page ` +
						`(tag="${entry.tag}", operationId="${entry.operationId}"). ` +
						`Disambiguate by giving each operation a unique \`operationId\` or by ` +
						`assigning them to different tags.`,
				);
			}
			claimedSlots.set(slotKey, { method, path: pathKey });
			if (!seenTags.has(entry.tag)) {
				tags.push({ name: entry.tag });
				seenTags.add(entry.tag);
			}
			operations.push(entry);
		}
	}
	return operations;
}

// ─── parseFullSpec ───────────────────────────────────────────────────────────

/**
 * Parses an OpenAPI 3.x document into the structure every emitter consumes.
 * Operations carry resolved parameters / request body / responses; tags
 * preserve declaration order for the sidebar; security schemes are kept
 * verbatim for the try-it widget. Component schemas are NOT recursively
 * expanded — they're passed through so a renderer-side schema component
 * can resolve `$ref` at render time.
 */
export function parseFullSpec(doc: OpenApiDocument): ParsedSpec {
	const root = doc as unknown as Record<string, unknown>;
	const info = (doc.info ?? {}) as Record<string, string | undefined>;
	const components = (root.components ?? {}) as Record<string, unknown>;

	const servers = extractServers(doc);
	const securitySchemes = extractSecuritySchemes(root, components);
	const componentSchemas = (components.schemas ?? {}) as Record<string, unknown>;
	const tags = extractTags(root);
	const globalSecurity = Array.isArray(root.security) ? (root.security as Array<Record<string, string[]>>) : [];

	const operations = walkOperations(root, doc, tags, globalSecurity);

	return {
		info: {
			title: info.title ?? "API Reference",
			version: info.version ?? "1.0.0",
			description: info.description ?? "",
		},
		servers,
		securitySchemes,
		globalSecurity,
		tags,
		operations,
		componentSchemas,
	};
}
