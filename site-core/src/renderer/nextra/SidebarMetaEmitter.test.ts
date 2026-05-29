import type { OpenApiOperation, OpenApiPipelineResult, ParsedSpec } from "@jolli.ai/site-core";
import { describe, expect, it } from "vitest";
import { buildApiSidebarOverrides } from "./SidebarMetaEmitter.js";

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
		summary: "List pets",
		description: "",
		deprecated: false,
		parameters: [],
		responses: [],
		security: [],
		...overrides,
	};
}

function makeInput(specName: string, spec: ParsedSpec): { specName: string; pipeline: OpenApiPipelineResult } {
	return { specName, pipeline: { spec, dossiers: [] } };
}

describe("buildApiSidebarOverrides", () => {
	it("keys overrides by per-tag folder path and labels each operation by summary", () => {
		const spec = makeSpec({
			tags: [{ name: "pets" }, { name: "users" }],
			operations: [
				makeOp({ tag: "pets", operationId: "listpets", summary: "List pets" }),
				makeOp({ tag: "users", operationId: "listusers", path: "/users", summary: "List users" }),
			],
		});
		const overrides = buildApiSidebarOverrides([makeInput("petstore", spec)]);
		expect(overrides["/api-petstore/pets"]).toEqual({ listpets: "List pets" });
		expect(overrides["/api-petstore/users"]).toEqual({ listusers: "List users" });
	});

	it("emits a top-level /api-{spec} override listing tag groups in spec declaration order", () => {
		const spec = makeSpec({
			// Declared order is users, then pets — the reverse of alphabetical.
			tags: [{ name: "users" }, { name: "pets" }],
			operations: [
				makeOp({ tag: "pets", operationId: "listpets" }),
				makeOp({ tag: "users", operationId: "listusers", path: "/users" }),
			],
		});
		const overrides = buildApiSidebarOverrides([makeInput("petstore", spec)]);
		// Spec order (users, pets), not alphabetical (pets, users).
		expect(Object.keys(overrides["/api-petstore"])).toEqual(["users", "pets"]);
	});

	it("title-cases tag-group labels so only the order changes, not the displayed label", () => {
		const spec = makeSpec({
			tags: [{ name: "user management" }],
			operations: [makeOp({ tag: "user management" })],
		});
		const overrides = buildApiSidebarOverrides([makeInput("petstore", spec)]);
		expect(overrides["/api-petstore"]).toEqual({ "user-management": "User Management" });
	});

	it("omits `index` from the top-level override (Overview stays MetaGenerator-managed)", () => {
		const spec = makeSpec({ tags: [{ name: "pets" }], operations: [makeOp({ tag: "pets" })] });
		const overrides = buildApiSidebarOverrides([makeInput("petstore", spec)]);
		expect(overrides["/api-petstore"].index).toBeUndefined();
	});

	it("preserves operation declaration order within a tag", () => {
		const spec = makeSpec({
			tags: [{ name: "pets" }],
			operations: [
				makeOp({ tag: "pets", operationId: "listpets", summary: "List pets" }),
				makeOp({ tag: "pets", operationId: "createpet", method: "post", summary: "Create a pet" }),
			],
		});
		const overrides = buildApiSidebarOverrides([makeInput("petstore", spec)]);
		expect(Object.keys(overrides["/api-petstore/pets"])).toEqual(["listpets", "createpet"]);
	});

	it("uses the synthesised METHOD-path summary when the spec omits a summary", () => {
		// SpecParser sets `summary` to `METHOD /path` when the spec has none.
		const spec = makeSpec({
			tags: [{ name: "pets" }],
			operations: [makeOp({ tag: "pets", operationId: "createpet", method: "post", summary: "POST /pets" })],
		});
		const overrides = buildApiSidebarOverrides([makeInput("petstore", spec)]);
		expect(overrides["/api-petstore/pets"].createpet).toBe("POST /pets");
	});

	it("skips a tag whose operations array is empty", () => {
		const spec = makeSpec({
			tags: [{ name: "lonely" }, { name: "pets" }],
			operations: [makeOp({ tag: "pets" })],
		});
		const overrides = buildApiSidebarOverrides([makeInput("petstore", spec)]);
		expect(overrides["/api-petstore/pets"]).toBeDefined();
		expect(overrides["/api-petstore/lonely"]).toBeUndefined();
	});

	it("slugifies the tag in the path key (e.g. reserved 'default' → 'default-doc')", () => {
		const spec = makeSpec({ tags: [], operations: [makeOp({ tag: "default", operationId: "ping" })] });
		const overrides = buildApiSidebarOverrides([makeInput("petstore", spec)]);
		expect(overrides["/api-petstore/default-doc"]).toEqual({ ping: "List pets" });
	});

	it("merges multiple specs under their own folder slugs", () => {
		const a = makeSpec({
			tags: [{ name: "pets" }],
			operations: [makeOp({ tag: "pets", operationId: "listpets" })],
		});
		const b = makeSpec({
			tags: [{ name: "cars" }],
			operations: [makeOp({ tag: "cars", operationId: "listcars" })],
		});
		const overrides = buildApiSidebarOverrides([makeInput("petstore", a), makeInput("garage", b)]);
		expect(overrides["/api-petstore/pets"]).toBeDefined();
		expect(overrides["/api-garage/cars"]).toBeDefined();
	});
});
