import { describe, expect, it } from "vitest";
import type { OpenApiOperation, ParsedSpec } from "../../openapi/Types.js";
import { emitEndpointData } from "./EndpointDataEmitter.js";

function makeSpec(overrides: Partial<ParsedSpec> = {}): ParsedSpec {
	return {
		info: { title: "x", version: "1", description: "" },
		servers: [],
		securitySchemes: {},
		globalSecurity: [],
		tags: [],
		operations: [],
		componentSchemas: {},
		...overrides,
	};
}

function makeOp(overrides: Partial<OpenApiOperation> = {}): OpenApiOperation {
	return {
		operationId: "listpets",
		method: "get",
		path: "/pets",
		tag: "pets",
		summary: "",
		description: "",
		deprecated: false,
		parameters: [],
		responses: [],
		security: [],
		...overrides,
	};
}

function decode(content: string): Record<string, unknown> {
	return JSON.parse(content) as Record<string, unknown>;
}

describe("emitEndpointData", () => {
	it("writes the JSON sidecar at content/api-{spec}/_data/{operationId}.json", () => {
		const file = emitEndpointData("petstore", makeOp(), makeSpec());
		expect(file.path).toBe("content/api-petstore/_data/listpets.json");
	});

	it("falls back to METHOD path when the operation has no summary", () => {
		const file = emitEndpointData("petstore", makeOp({ summary: "" }), makeSpec());
		const data = decode(file.content);
		expect(data.title).toBe("GET /pets");
	});

	it("uses the spec's summary when present", () => {
		const file = emitEndpointData("petstore", makeOp({ summary: "List pets" }), makeSpec());
		expect(decode(file.content).title).toBe("List pets");
	});

	it("filters the synthetic 'default' tag out of the tags array", () => {
		const file = emitEndpointData("petstore", makeOp({ tag: "default" }), makeSpec());
		expect(decode(file.content).tags).toEqual([]);
	});

	it("groups parameters by location into the parameters block", () => {
		const op = makeOp({
			parameters: [
				{ name: "id", in: "path", required: true },
				{ name: "limit", in: "query", required: false, description: "max" },
				{ name: "X-Trace", in: "header", required: false, schema: { type: "string" } },
				{ name: "session", in: "cookie", required: false },
			],
		});
		const data = decode(emitEndpointData("petstore", op, makeSpec()).content) as {
			parameters: Record<string, unknown[]>;
		};
		expect(data.parameters.path).toHaveLength(1);
		expect(data.parameters.query).toHaveLength(1);
		expect(data.parameters.header).toHaveLength(1);
		expect(data.parameters.cookie).toHaveLength(1);
	});

	it("includes tryItParameters with name + in + required + description", () => {
		const op = makeOp({
			parameters: [{ name: "id", in: "path", required: true, description: "ID" }],
		});
		const data = decode(emitEndpointData("petstore", op, makeSpec()).content) as {
			tryItParameters: Array<Record<string, unknown>>;
		};
		expect(data.tryItParameters).toEqual([{ name: "id", in: "path", required: true, description: "ID" }]);
	});

	it("inlines the request body's example when present", () => {
		const op = makeOp({
			requestBody: { required: true, contentType: "application/json", example: { name: "Rex" } },
		});
		const data = decode(emitEndpointData("petstore", op, makeSpec()).content) as {
			requestBody: Record<string, unknown>;
		};
		expect(data.requestBody.example).toEqual({ name: "Rex" });
		expect(data.requestBody.contentType).toBe("application/json");
	});

	it("synthesises a request body example from schema when no literal example is supplied", () => {
		const op = makeOp({
			requestBody: {
				required: true,
				contentType: "application/json",
				schema: { type: "object", properties: { name: { type: "string" } } },
			},
		});
		const data = decode(emitEndpointData("petstore", op, makeSpec()).content) as {
			requestBody: Record<string, unknown>;
		};
		expect(data.requestBody.example).toEqual({ name: "string" });
	});

	it("resolves operation security against the spec's securitySchemes", () => {
		const spec = makeSpec({
			securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
		});
		const op = makeOp({ security: [{ bearerAuth: ["read"] }] });
		const data = decode(emitEndpointData("petstore", op, spec).content) as {
			authSchemes: Array<{ name: string; scheme: Record<string, unknown>; scopes: string[] }>;
		};
		expect(data.authSchemes).toHaveLength(1);
		expect(data.authSchemes[0].name).toBe("bearerAuth");
		expect(data.authSchemes[0].scheme.type).toBe("http");
		expect(data.authSchemes[0].scheme.scheme).toBe("bearer");
		expect(data.authSchemes[0].scopes).toEqual(["read"]);
	});

	it("drops auth requirements that don't match a known security scheme", () => {
		const op = makeOp({ security: [{ ghost: [] }] });
		const data = decode(emitEndpointData("petstore", op, makeSpec()).content) as {
			authSchemes: unknown[];
		};
		expect(data.authSchemes).toEqual([]);
	});

	it("deduplicates auth schemes that appear in multiple security requirements", () => {
		const spec = makeSpec({
			securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
		});
		const op = makeOp({ security: [{ bearerAuth: [] }, { bearerAuth: [] }] });
		const data = decode(emitEndpointData("petstore", op, spec).content) as { authSchemes: unknown[] };
		expect(data.authSchemes).toHaveLength(1);
	});

	it("inherits the spec-level servers when the operation has none", () => {
		const spec = makeSpec({ servers: [{ url: "https://api.example.com" }] });
		const op = makeOp();
		const data = decode(emitEndpointData("petstore", op, spec).content) as {
			servers: Array<{ url: string }>;
		};
		expect(data.servers).toEqual([{ url: "https://api.example.com" }]);
	});

	it("uses operation-level servers when present", () => {
		const spec = makeSpec({ servers: [{ url: "https://default.example.com" }] });
		const op = makeOp({ servers: [{ url: "https://override.example.com" }] });
		const data = decode(emitEndpointData("petstore", op, spec).content) as {
			servers: Array<{ url: string }>;
		};
		expect(data.servers).toEqual([{ url: "https://override.example.com" }]);
	});

	it("preserves apiKey scheme `in` / `name` / `description` when resolving auth schemes", () => {
		const spec = makeSpec({
			securitySchemes: {
				apiKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "site key" },
			},
		});
		const op = makeOp({ security: [{ apiKey: [] }] });
		const data = decode(emitEndpointData("petstore", op, spec).content) as {
			authSchemes: Array<{ scheme: Record<string, unknown> }>;
		};
		expect(data.authSchemes[0].scheme).toEqual({
			type: "apiKey",
			in: "header",
			name: "X-API-Key",
			description: "site key",
		});
	});

	it("treats malformed scopes (non-array) as an empty scopes list", () => {
		const spec = makeSpec({
			securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
		});
		const op = makeOp({
			// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
			security: [{ bearerAuth: "not-an-array" as any }],
		});
		const data = decode(emitEndpointData("petstore", op, spec).content) as {
			authSchemes: Array<{ scopes: unknown }>;
		};
		expect(data.authSchemes[0].scopes).toEqual([]);
	});

	it("drops parameters with an unknown `in` location", () => {
		const op = makeOp({
			parameters: [
				{ name: "id", in: "path", required: true },
				// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed location
				{ name: "bad", in: "body" as any, required: false },
			],
		});
		const data = decode(emitEndpointData("petstore", op, makeSpec()).content) as {
			parameters: { path: unknown[]; query: unknown[]; header: unknown[]; cookie: unknown[] };
		};
		expect(data.parameters.path).toHaveLength(1);
		expect(data.parameters.query).toHaveLength(0);
		expect(data.parameters.header).toHaveLength(0);
		expect(data.parameters.cookie).toHaveLength(0);
	});

	it("flattens responses preserving status / description / contentType / schema", () => {
		const op = makeOp({
			responses: [
				{ status: "200", description: "ok", contentType: "application/json", schema: { type: "object" } },
				{ status: "404", description: "missing" },
			],
		});
		const data = decode(emitEndpointData("petstore", op, makeSpec()).content) as {
			responses: Array<Record<string, unknown>>;
		};
		expect(data.responses).toHaveLength(2);
		expect(data.responses[0].status).toBe("200");
		expect(data.responses[0].schema).toEqual({ type: "object" });
		expect(data.responses[1].status).toBe("404");
	});
});
