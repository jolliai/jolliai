import { describe, expect, it } from "vitest";
import type { OpenApiOperation, ParsedSpec } from "../../openapi/Types.js";
import { emitOverviewPage } from "./OverviewPageEmitter.js";

function makeSpec(overrides: Partial<ParsedSpec> = {}): ParsedSpec {
	return {
		info: { title: "Pet Store", version: "1.0.0", description: "" },
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

describe("emitOverviewPage", () => {
	it("writes to content/api-{specName}/index.mdx", () => {
		const file = emitOverviewPage("petstore", makeSpec());
		expect(file.path).toBe("content/api-petstore/index.mdx");
	});

	it("emits front matter with the title (YAML-quoted when needed)", () => {
		const file = emitOverviewPage("petstore", makeSpec({ info: { title: "1.0", version: "x", description: "" } }));
		// Title starts with a digit → YAML quotes it.
		expect(file.content).toContain('title: "1.0"');
	});

	it("renders the title as an H1 with MDX-escaped text", () => {
		const file = emitOverviewPage(
			"petstore",
			makeSpec({ info: { title: "API <v2>", version: "1", description: "" } }),
		);
		expect(file.content).toContain("# API \\<v2>");
	});

	it("renders the version inside an inline code span with backticks escaped", () => {
		const file = emitOverviewPage(
			"petstore",
			makeSpec({ info: { title: "Pet", version: "v`1`", description: "" } }),
		);
		expect(file.content).toContain("Version: `v\\`1\\``");
	});

	it("renders the description after the version when present", () => {
		const file = emitOverviewPage(
			"petstore",
			makeSpec({ info: { title: "Pet", version: "1", description: "Some {tokens} and < operators" } }),
		);
		expect(file.content).toContain("Some \\{tokens\\} and \\< operators");
	});

	it("renders a Servers section when servers are declared", () => {
		const file = emitOverviewPage(
			"petstore",
			makeSpec({ servers: [{ url: "https://api.example.com", description: "Prod" }] }),
		);
		expect(file.content).toContain("## Servers");
		expect(file.content).toContain("`https://api.example.com`");
		expect(file.content).toContain("— Prod");
	});

	it("groups operations by tag and renders one table per tag (declaration order)", () => {
		const spec = makeSpec({
			tags: [{ name: "users", description: "User ops" }, { name: "pets" }],
			operations: [
				makeOp({ operationId: "createuser", method: "post", path: "/users", tag: "users", summary: "Create" }),
				makeOp({ operationId: "listpets", method: "get", path: "/pets", tag: "pets", summary: "List pets" }),
			],
		});
		const file = emitOverviewPage("api", spec);
		const usersIdx = file.content.indexOf("### users");
		const petsIdx = file.content.indexOf("### pets");
		expect(usersIdx).toBeGreaterThan(-1);
		expect(petsIdx).toBeGreaterThan(usersIdx);
		expect(file.content).toContain("User ops");
		expect(file.content).toContain("**POST**");
		expect(file.content).toContain("[`/users`](/api-api/users/createuser)");
	});

	it("appends an untagged operation under a synthetic 'default' group (no top-level tag entry)", () => {
		const spec = makeSpec({
			tags: [],
			operations: [makeOp({ tag: "default", summary: "X" })],
		});
		const file = emitOverviewPage("api", spec);
		expect(file.content).toContain("### default");
	});

	it("escapes pipe characters in summary cells so the table layout survives", () => {
		const spec = makeSpec({
			tags: [{ name: "x" }],
			operations: [makeOp({ tag: "x", summary: "a | b" })],
		});
		const file = emitOverviewPage("api", spec);
		expect(file.content).toContain("a \\| b");
	});

	it("skips a tag whose operations array is empty", () => {
		const spec = makeSpec({
			tags: [{ name: "lonely" }, { name: "pets" }],
			operations: [makeOp({ tag: "pets" })],
		});
		const file = emitOverviewPage("api", spec);
		expect(file.content).toContain("### pets");
		expect(file.content).not.toContain("### lonely");
	});
});
