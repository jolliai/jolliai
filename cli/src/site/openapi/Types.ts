/**
 * OpenAPI IR types — framework-agnostic.
 *
 * Two layers:
 *   - `OpenApiDocument` is the raw JSON/YAML AST after Phase-1 validation
 *     (must have `openapi` + `info`). Permissive in shape.
 *   - `ParsedSpec` is the analysed form `parseFullSpec` returns: every
 *     operation walked in declaration order, parameters / request body /
 *     responses pre-resolved with `$ref`s followed, security schemes kept
 *     verbatim. Downstream emitters consume this — no emitter touches the
 *     raw document.
 *
 * Component schemas are NOT recursively dereferenced here; they're kept
 * intact so a renderer-side schema component can resolve refs at render
 * time against `componentSchemas`.
 */

// ─── Raw parsed document (Phase 1) ───────────────────────────────────────────

/**
 * Raw parsed OpenAPI document. Guarantees: `openapi` is a string and `info`
 * is a non-null object. Everything else is permissive — fields that the
 * spec defines as optional may be missing, and unknown fields are tolerated.
 */
export interface OpenApiDocument {
	openapi: string;
	info: { title?: string; version?: string; [k: string]: unknown };
	servers?: unknown[];
	paths?: Record<string, unknown>;
	components?: Record<string, unknown>;
	tags?: unknown[];
	security?: unknown[];
	[k: string]: unknown;
}

// ─── Analysed IR (Phase 2) ───────────────────────────────────────────────────

/** HTTP methods we walk. Lowercase to match OpenAPI keys. */
export type OpenApiHttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

/** A `servers[]` entry, on either the spec root or a single operation. */
export interface OpenApiServerEntry {
	url: string;
	description?: string;
}

/**
 * `components.securitySchemes.{name}` entry. Only the fields a renderer-side
 * try-it widget or auth-requirements component actually reads are typed
 * narrowly; the rest pass through as `unknown`.
 */
export interface OpenApiSecurityScheme {
	type: "http" | "apiKey" | "oauth2" | "openIdConnect";
	scheme?: string;
	bearerFormat?: string;
	in?: "header" | "query" | "cookie";
	name?: string;
	description?: string;
	flows?: Record<string, unknown>;
	openIdConnectUrl?: string;
}

/**
 * `tags[]` entry on the spec root. Declared order is preserved so the sidebar
 * groups endpoints in the order the spec author intended.
 */
export interface OpenApiTagEntry {
	name: string;
	description?: string;
}

/** Allowed values for `OpenApiParameter.in`. */
export type OpenApiParameterLocation = "path" | "query" | "header" | "cookie";

/**
 * A single parameter resolved from `parameters` (or `pathItem.parameters`).
 * `$ref` parameters are followed and inlined here when possible.
 */
export interface OpenApiParameter {
	name: string;
	in: OpenApiParameterLocation;
	required: boolean;
	description?: string;
	schema?: unknown;
	example?: unknown;
}

/**
 * Resolved request body for an operation. Only the first content type is
 * surfaced — the try-it widget uses it to drive the request, and the docs
 * page renders its schema. Non-JSON content types still record their
 * `contentType` so we can show a hint on the page.
 */
export interface OpenApiRequestBody {
	required: boolean;
	description?: string;
	contentType: string;
	schema?: unknown;
	example?: unknown;
}

/** Resolved response entry — one per status code (or `default`). */
export interface OpenApiResponse {
	status: string;
	description?: string;
	contentType?: string;
	schema?: unknown;
	example?: unknown;
}

/**
 * A fully resolved operation. `$ref` schemas inside parameters / body /
 * responses are intentionally NOT recursively dereferenced — they're kept
 * intact so a renderer-side schema component can resolve refs at render
 * time using `ParsedSpec.componentSchemas`.
 */
export interface OpenApiOperation {
	operationId: string;
	method: OpenApiHttpMethod;
	path: string;
	tag: string;
	summary: string;
	description: string;
	deprecated: boolean;
	parameters: OpenApiParameter[];
	requestBody?: OpenApiRequestBody;
	responses: OpenApiResponse[];
	security: Array<Record<string, string[]>>;
	servers?: OpenApiServerEntry[];
}

/** Output of `parseFullSpec` — the analysed IR every emitter consumes. */
export interface ParsedSpec {
	info: { title: string; version: string; description: string };
	servers: OpenApiServerEntry[];
	securitySchemes: Record<string, OpenApiSecurityScheme>;
	globalSecurity: Array<Record<string, string[]>>;
	tags: OpenApiTagEntry[];
	operations: OpenApiOperation[];
	componentSchemas: Record<string, unknown>;
}

// ─── Code samples ────────────────────────────────────────────────────────────

/** Per-language code samples for a single operation. */
export interface OpenApiCodeSamples {
	curl: string;
	js: string;
	ts: string;
	python: string;
	go: string;
}

// ─── Pipeline output ─────────────────────────────────────────────────────────

/**
 * Per-operation IR consumed by emitters. Combines the analysed operation
 * with its pre-rendered code samples so emitters do not need to call
 * `generateCodeSamples` themselves.
 */
export interface EndpointDossier {
	operation: OpenApiOperation;
	codeSamples: OpenApiCodeSamples;
}

/** Full output of `buildPipeline`. */
export interface OpenApiPipelineResult {
	spec: ParsedSpec;
	dossiers: EndpointDossier[];
}
