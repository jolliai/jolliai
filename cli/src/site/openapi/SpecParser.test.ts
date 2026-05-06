/**
 * Tests for SpecParser.parseFullSpec.
 *
 * Focus areas:
 *   - Walks paths × methods in declaration order
 *   - Resolves $ref pointers (parameters, request bodies, responses,
 *     security schemes); RFC 6901 escape correctness (`~1` → `/`, `~0` → `~`)
 *   - Synthesises a stable operationId when the spec author omits one
 *   - Throws on (tag, operationId) collisions with a clear message
 *   - Merges path-level + operation-level parameters with operation-level
 *     overriding on the `(name, in)` key
 *   - Picks the JSON content-type when multiple are declared
 *   - Carries `componentSchemas` through unchanged (no recursive expansion)
 *   - Tolerates malformed input (drops bad parameter entries, missing
 *     servers / tags / security)
 */

import { describe, expect, it } from "vitest";
import { parseFullSpec } from "./SpecParser.js";
import type { OpenApiDocument } from "./Types.js";

function makeDoc(overrides: Partial<OpenApiDocument> = {}): OpenApiDocument {
	return {
		openapi: "3.1.0",
		info: { title: "Test API", version: "1.0.0" },
		...overrides,
	} as OpenApiDocument;
}

// ─── Walking & operation construction ────────────────────────────────────────

describe("parseFullSpec — operation walking", () => {
	it("walks paths × HTTP methods in declaration order", () => {
		const doc = makeDoc({
			paths: {
				"/b": { get: { operationId: "bget" }, post: { operationId: "bpost" } },
				"/a": { get: { operationId: "aget" } },
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations.map((o) => o.operationId)).toEqual(["bget", "bpost", "aget"]);
	});

	it("emits one operation per declared HTTP method, ignoring unsupported keys", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					summary: "ignored",
					parameters: [],
					trace: { operationId: "tracedTrace" },
					get: { operationId: "xget" },
					post: { operationId: "xpost" },
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations).toHaveLength(2);
		expect(spec.operations.map((o) => o.method)).toEqual(["get", "post"]);
	});

	it("synthesises a stable operationId from method + path when none is supplied", () => {
		const doc = makeDoc({ paths: { "/users/{id}/posts": { get: {} } } });
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].operationId).toBe("get-users-id-posts");
	});

	it("uses 'root' as the path component when synthesising for the bare /", () => {
		const doc = makeDoc({ paths: { "/": { get: {} } } });
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].operationId).toBe("get-root");
	});

	it("slugifies a supplied operationId so the URL slug is deterministic", () => {
		const doc = makeDoc({ paths: { "/x": { get: { operationId: "List Users (v2)!" } } } });
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].operationId).toBe("list-users-v2");
	});

	it("groups untagged operations under the synthetic 'default' tag", () => {
		const doc = makeDoc({ paths: { "/x": { get: {} } } });
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].tag).toBe("default");
		expect(spec.tags.find((t) => t.name === "default")).toBeDefined();
	});

	it("uses the first tag when an operation declares multiple", () => {
		const doc = makeDoc({ paths: { "/x": { get: { tags: ["users", "admin"] } } } });
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].tag).toBe("users");
	});

	it("appends untagged-but-used tag names that aren't in the spec's top-level tags", () => {
		const doc = makeDoc({
			tags: [{ name: "users", description: "user ops" }],
			paths: {
				"/u": { get: { tags: ["users"] } },
				"/r": { get: { tags: ["reports"] } },
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.tags.map((t) => t.name)).toEqual(["users", "reports"]);
	});

	it("falls back to a synthesised summary when the operation has none", () => {
		const doc = makeDoc({ paths: { "/users": { get: {} } } });
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].summary).toBe("GET /users");
	});

	it("preserves the deprecated flag", () => {
		const doc = makeDoc({ paths: { "/x": { get: { deprecated: true } } } });
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].deprecated).toBe(true);
	});
});

// ─── Collision detection ─────────────────────────────────────────────────────

describe("parseFullSpec — collision detection", () => {
	it("throws when two operations would generate the same (tag, operationId) slot", () => {
		const doc = makeDoc({
			paths: {
				"/a": { get: { operationId: "list", tags: ["users"] } },
				"/b": { get: { operationId: "list", tags: ["users"] } },
			},
		});
		expect(() => parseFullSpec(doc)).toThrow(/OpenAPI spec collision/);
	});

	it("includes both colliding paths and the offending tag/operationId in the error", () => {
		const doc = makeDoc({
			paths: {
				"/a": { get: { operationId: "list", tags: ["users"] } },
				"/b": { post: { operationId: "list", tags: ["users"] } },
			},
		});
		try {
			parseFullSpec(doc);
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("/a");
			expect(message).toContain("/b");
			expect(message).toContain('tag="users"');
			expect(message).toContain('operationId="list"');
			return;
		}
		throw new Error("Expected parseFullSpec to throw");
	});

	it("does NOT throw when same operationId lives under different tags", () => {
		const doc = makeDoc({
			paths: {
				"/u": { get: { operationId: "list", tags: ["users"] } },
				"/p": { get: { operationId: "list", tags: ["posts"] } },
			},
		});
		expect(() => parseFullSpec(doc)).not.toThrow();
	});
});

// ─── $ref resolution ─────────────────────────────────────────────────────────

describe("parseFullSpec — $ref resolution", () => {
	it("follows $ref on parameters and inlines the resolved entry", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					get: {
						parameters: [{ $ref: "#/components/parameters/Limit" }],
					},
				},
			},
			components: {
				parameters: {
					Limit: { name: "limit", in: "query", required: false, description: "max rows" },
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].parameters).toEqual([
			{ name: "limit", in: "query", required: false, description: "max rows" },
		]);
	});

	it("decodes RFC 6901 escapes in $ref tokens (~1 → /, ~0 → ~)", () => {
		// Construct a path key with `/` and `~` that the ref encodes.
		const doc = makeDoc({
			paths: {
				"/items/{id}": { get: { operationId: "getItem" } },
			},
			components: {
				responses: {
					"~weird~name": {
						description: "ok",
						content: { "application/json": { schema: { type: "object" } } },
					},
				},
			},
		});
		// Refs use ~0 to encode the literal `~`. Per RFC 6901, ~1 is
		// processed before ~0 so the encoding round-trips.
		const docWithRef = makeDoc({
			paths: {
				"/x": {
					get: {
						operationId: "x",
						responses: {
							"200": { $ref: "#/components/responses/~0weird~0name" },
						},
					},
				},
			},
			components: doc.components,
		});
		const spec = parseFullSpec(docWithRef);
		expect(spec.operations[0].responses[0].description).toBe("ok");
	});

	it("returns the operation with a missing parameter when the ref can't be resolved", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					get: { parameters: [{ $ref: "#/components/parameters/Missing" }] },
				},
			},
			components: { parameters: {} },
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].parameters).toEqual([]);
	});

	it("ignores external-file refs (anything not starting with #/)", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					get: { parameters: [{ $ref: "external.yaml#/parameters/Limit" }] },
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].parameters).toEqual([]);
	});

	it("resolves $ref on the request body", () => {
		const doc = makeDoc({
			paths: {
				"/x": { post: { requestBody: { $ref: "#/components/requestBodies/CreateX" } } },
			},
			components: {
				requestBodies: {
					CreateX: {
						required: true,
						content: { "application/json": { schema: { type: "object" } } },
					},
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].requestBody?.required).toBe(true);
		expect(spec.operations[0].requestBody?.contentType).toBe("application/json");
	});
});

// ─── Parameter merging & shape ───────────────────────────────────────────────

describe("parseFullSpec — parameter merging", () => {
	it("merges path-level + operation-level parameters", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					parameters: [{ name: "trace", in: "header", required: false }],
					get: {
						parameters: [{ name: "limit", in: "query", required: false }],
					},
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].parameters.map((p) => `${p.name}::${p.in}`).sort()).toEqual([
			"limit::query",
			"trace::header",
		]);
	});

	it("operation-level parameters override path-level on the (name, in) key", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					parameters: [{ name: "limit", in: "query", required: false, description: "from path" }],
					get: {
						parameters: [{ name: "limit", in: "query", required: true, description: "from op" }],
					},
				},
			},
		});
		const spec = parseFullSpec(doc);
		const limit = spec.operations[0].parameters.find((p) => p.name === "limit");
		expect(limit?.required).toBe(true);
		expect(limit?.description).toBe("from op");
	});

	it("forces required=true for path parameters even when the spec omits the flag", () => {
		const doc = makeDoc({
			paths: { "/items/{id}": { get: { parameters: [{ name: "id", in: "path" }] } } },
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].parameters[0].required).toBe(true);
	});

	it("drops parameter entries with an unknown `in` location", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					get: {
						parameters: [
							{ name: "good", in: "query" },
							{ name: "bad", in: "body" },
						],
					},
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].parameters.map((p) => p.name)).toEqual(["good"]);
	});

	it("drops parameter entries missing the name", () => {
		const doc = makeDoc({
			paths: { "/x": { get: { parameters: [{ in: "query" }] } } },
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].parameters).toEqual([]);
	});
});

// ─── Body / response media-type handling ─────────────────────────────────────

describe("parseFullSpec — media types", () => {
	it("prefers application/json when multiple content types are declared", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					post: {
						requestBody: {
							required: true,
							content: {
								"text/plain": { schema: { type: "string" } },
								"application/json": { schema: { type: "object" } },
							},
						},
					},
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].requestBody?.contentType).toBe("application/json");
	});

	it("falls back to the first content type when no JSON variant is declared", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					post: {
						requestBody: {
							content: {
								"text/plain": { schema: { type: "string" } },
							},
						},
					},
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].requestBody?.contentType).toBe("text/plain");
	});

	it("returns no requestBody when content map is empty", () => {
		const doc = makeDoc({ paths: { "/x": { post: { requestBody: { content: {} } } } } });
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].requestBody).toBeUndefined();
	});

	it("flattens responses into an ordered array preserving declaration order", () => {
		const doc = makeDoc({
			paths: {
				"/x": {
					get: {
						responses: {
							"200": { description: "ok" },
							"404": { description: "missing" },
							default: { description: "fallback" },
						},
					},
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].responses.map((r) => r.status)).toEqual(["200", "404", "default"]);
	});
});

// ─── Top-level extraction ────────────────────────────────────────────────────

describe("parseFullSpec — top-level extraction", () => {
	it("preserves servers in declaration order, dropping malformed entries", () => {
		const doc = makeDoc({
			servers: [
				{ url: "https://prod.example.com", description: "prod" },
				{ description: "no url" },
				{ url: "https://staging.example.com" },
			],
		});
		const spec = parseFullSpec(doc);
		expect(spec.servers).toEqual([
			{ url: "https://prod.example.com", description: "prod" },
			{ url: "https://staging.example.com" },
		]);
	});

	it("returns an empty servers array when the spec declares none", () => {
		const spec = parseFullSpec(makeDoc({}));
		expect(spec.servers).toEqual([]);
	});

	it("preserves operation-level servers override", () => {
		const doc = makeDoc({
			servers: [{ url: "https://default.example.com" }],
			paths: { "/x": { get: { servers: [{ url: "https://override.example.com" }] } } },
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].servers).toEqual([{ url: "https://override.example.com" }]);
	});

	it("ignores operation-level servers when the array is empty after filtering", () => {
		const doc = makeDoc({
			paths: { "/x": { get: { servers: [{ description: "no url" }] } } },
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].servers).toBeUndefined();
	});

	it("extracts security schemes verbatim, dropping schemes without a type", () => {
		const doc = makeDoc({
			components: {
				securitySchemes: {
					bearerAuth: { type: "http", scheme: "bearer" },
					broken: { description: "no type field" },
				},
			},
		});
		const spec = parseFullSpec(doc);
		expect(spec.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
		expect(spec.securitySchemes.broken).toBeUndefined();
	});

	it("uses globalSecurity when the operation does not declare its own", () => {
		const doc = makeDoc({
			security: [{ bearerAuth: [] }],
			paths: { "/x": { get: {} } },
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].security).toEqual([{ bearerAuth: [] }]);
	});

	it("operation-level security overrides globalSecurity when present", () => {
		const doc = makeDoc({
			security: [{ globalKey: [] }],
			paths: { "/x": { get: { security: [{ opKey: [] }] } } },
		});
		const spec = parseFullSpec(doc);
		expect(spec.operations[0].security).toEqual([{ opKey: [] }]);
	});

	it("passes componentSchemas through unchanged (no recursive expansion)", () => {
		const userSchema = { type: "object", properties: { id: { type: "integer" } } };
		const doc = makeDoc({ components: { schemas: { User: userSchema } } });
		const spec = parseFullSpec(doc);
		expect(spec.componentSchemas.User).toBe(userSchema);
	});

	it("supplies sensible defaults for missing info fields", () => {
		const doc = makeDoc({ info: {} });
		const spec = parseFullSpec(doc);
		expect(spec.info.title).toBe("API Reference");
		expect(spec.info.version).toBe("1.0.0");
		expect(spec.info.description).toBe("");
	});

	it("preserves info.title / version / description when the spec supplies them", () => {
		const doc = makeDoc({ info: { title: "Pet Store", version: "2.3.1", description: "the store" } });
		const spec = parseFullSpec(doc);
		expect(spec.info).toEqual({ title: "Pet Store", version: "2.3.1", description: "the store" });
	});
});

// ─── Robustness ──────────────────────────────────────────────────────────────

describe("parseFullSpec — robustness", () => {
	it("returns no operations when paths is missing", () => {
		const spec = parseFullSpec(makeDoc({}));
		expect(spec.operations).toEqual([]);
	});

	it("ignores non-object path items", () => {
		const doc = makeDoc({ paths: { "/x": null as unknown as Record<string, unknown> } });
		const spec = parseFullSpec(doc);
		expect(spec.operations).toEqual([]);
	});

	it("drops malformed top-level tag entries (missing or non-string name)", () => {
		const doc = makeDoc({
			tags: [{ name: "good" }, { description: "no name" }, "string-not-object"] as unknown[],
		});
		const spec = parseFullSpec(doc);
		expect(spec.tags.map((t) => t.name)).toEqual(["good"]);
	});
});
