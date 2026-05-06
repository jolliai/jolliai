import { describe, expect, it } from "vitest";
import type { OpenApiOperation, ParsedSpec } from "../../openapi/Types.js";
import { emitSidebarMetas } from "./SidebarMetaEmitter.js";

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

describe("emitSidebarMetas", () => {
	it("emits the spec-folder _meta.ts plus one per tag", () => {
		const spec = makeSpec({
			tags: [{ name: "pets" }, { name: "users" }],
			operations: [
				makeOp({ tag: "pets", operationId: "listpets" }),
				makeOp({ tag: "users", operationId: "listusers", path: "/users" }),
			],
		});
		const files = emitSidebarMetas("petstore", spec);
		const paths = files.map((f) => f.path);
		expect(paths).toContain("content/api-petstore/_meta.ts");
		expect(paths).toContain("content/api-petstore/pets/_meta.ts");
		expect(paths).toContain("content/api-petstore/users/_meta.ts");
	});

	it("places `index: 'Overview'` first in the spec-folder _meta.ts", () => {
		const spec = makeSpec({
			tags: [{ name: "pets" }],
			operations: [makeOp({ tag: "pets" })],
		});
		const files = emitSidebarMetas("petstore", spec);
		const top = files.find((f) => f.path === "content/api-petstore/_meta.ts");
		expect(top).toBeDefined();
		const idxOverview = top?.content.indexOf("index: 'Overview'") ?? -1;
		const idxPets = top?.content.indexOf("'pets': 'pets'") ?? -1;
		expect(idxOverview).toBeGreaterThan(-1);
		expect(idxPets).toBeGreaterThan(idxOverview);
	});

	it("emits per-tag entries labelled `METHOD path` in operation declaration order", () => {
		const spec = makeSpec({
			tags: [{ name: "pets" }],
			operations: [
				makeOp({ tag: "pets", operationId: "listpets", method: "get", path: "/pets" }),
				makeOp({ tag: "pets", operationId: "createpet", method: "post", path: "/pets" }),
			],
		});
		const files = emitSidebarMetas("petstore", spec);
		const tag = files.find((f) => f.path === "content/api-petstore/pets/_meta.ts");
		expect(tag).toBeDefined();
		expect(tag?.content).toContain("'listpets': 'GET /pets'");
		expect(tag?.content).toContain("'createpet': 'POST /pets'");
		const idxList = tag?.content.indexOf("'listpets'") ?? -1;
		const idxCreate = tag?.content.indexOf("'createpet'") ?? -1;
		expect(idxList).toBeGreaterThan(-1);
		expect(idxCreate).toBeGreaterThan(idxList);
	});

	it("skips a tag whose operations array is empty", () => {
		const spec = makeSpec({
			tags: [{ name: "lonely" }, { name: "pets" }],
			operations: [makeOp({ tag: "pets" })],
		});
		const files = emitSidebarMetas("petstore", spec);
		const paths = files.map((f) => f.path);
		expect(paths).toContain("content/api-petstore/pets/_meta.ts");
		expect(paths).not.toContain("content/api-petstore/lonely/_meta.ts");
		// Top-level _meta.ts also omits the empty tag.
		const top = files.find((f) => f.path === "content/api-petstore/_meta.ts");
		expect(top?.content).not.toContain("lonely");
	});

	it("appends an untagged operation under a synthetic group when no matching tag is declared", () => {
		// `default` is a JS reserved word, so its slug becomes `default-doc`.
		// The label keeps the original tag string for sidebar display.
		const spec = makeSpec({
			tags: [],
			operations: [makeOp({ tag: "default", operationId: "ping" })],
		});
		const files = emitSidebarMetas("petstore", spec);
		const top = files.find((f) => f.path === "content/api-petstore/_meta.ts");
		expect(top?.content).toContain("'default-doc': 'default'");
		expect(files.some((f) => f.path === "content/api-petstore/default-doc/_meta.ts")).toBe(true);
	});

	it("escapes JS-significant characters in tag and operationId labels", () => {
		const spec = makeSpec({
			tags: [{ name: "tag's" }],
			operations: [makeOp({ tag: "tag's", operationId: "op'name" })],
		});
		const files = emitSidebarMetas("petstore", spec);
		const top = files.find((f) => f.path === "content/api-petstore/_meta.ts");
		// The slug doesn't keep the apostrophe (slugify strips it), but the
		// label literal does — and that label MUST round-trip through single
		// quotes safely.
		expect(top?.content).toContain("'tag\\'s'");
	});
});
