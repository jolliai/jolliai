import { describe, expect, it } from "vitest";
import type { OpenApiCodeSamples, OpenApiOperation, ParsedSpec } from "../../openapi/Types.js";
import { emitEndpointPage, emitRefsFile } from "./EndpointPageEmitter.js";

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

const EMPTY_SAMPLES: OpenApiCodeSamples = {
	curl: "curl -X GET https://api.example.com/pets",
	js: "const r = await fetch('https://api.example.com/pets')",
	ts: "const r: Response = await fetch('https://api.example.com/pets')",
	python: "import requests\nrequests.request('get', 'https://api.example.com/pets')",
	go: "package main",
};

// ─── emitRefsFile ──────────────────────────────────────────────────────────

describe("emitRefsFile", () => {
	it("writes to content/api-{specName}/_refs.ts", () => {
		const file = emitRefsFile("petstore", makeSpec());
		expect(file.path).toBe("content/api-petstore/_refs.ts");
	});

	it("inlines componentSchemas as a default-exported REFS map", () => {
		const spec = makeSpec({
			componentSchemas: { User: { type: "object", properties: { id: { type: "string" } } } },
		});
		const file = emitRefsFile("petstore", spec);
		expect(file.content).toContain("const REFS: Record<string, unknown>");
		expect(file.content).toContain('"User"');
		expect(file.content).toContain("export default REFS;");
	});
});

// ─── emitEndpointPage ──────────────────────────────────────────────────────

describe("emitEndpointPage", () => {
	it("writes to content/api-{spec}/{tag}/{operationId}.mdx", () => {
		const file = emitEndpointPage("petstore", makeOp(), EMPTY_SAMPLES);
		expect(file.path).toBe("content/api-petstore/pets/listpets.mdx");
	});

	it("front matter contains the YAML-quoted summary, theme.toc:false, and layout:full", () => {
		const file = emitEndpointPage("petstore", makeOp({ summary: "List Pets" }), EMPTY_SAMPLES);
		expect(file.content).toContain("title: List Pets");
		expect(file.content).toContain("toc: false");
		expect(file.content).toContain("layout: full");
	});

	it("falls back to METHOD path in front matter when summary is empty", () => {
		const file = emitEndpointPage("petstore", makeOp({ summary: "" }), EMPTY_SAMPLES);
		expect(file.content).toContain("title: GET /pets");
	});

	it("imports Endpoint, EndpointDescription, EndpointSamples, CodeSwitcher, REFS, and the data sidecar via the @/* alias", () => {
		const file = emitEndpointPage("petstore", makeOp(), EMPTY_SAMPLES);
		expect(file.content).toContain("import Endpoint, { EndpointDescription, EndpointSamples }");
		expect(file.content).toContain('"@/components/api/Endpoint"');
		expect(file.content).toContain('"@/components/api/CodeSwitcher"');
		expect(file.content).toContain('import REFS from "../_refs"');
		expect(file.content).toContain('import data from "../_data/listpets.json"');
	});

	it("renders an EndpointDescription block when the operation has a description", () => {
		const file = emitEndpointPage(
			"petstore",
			makeOp({ description: "Lists all pets owned by the user." }),
			EMPTY_SAMPLES,
		);
		expect(file.content).toContain('<EndpointDescription data-slot="description">');
		expect(file.content).toContain("Lists all pets owned by the user.");
	});

	it("escapes MDX-significant characters inside the description", () => {
		const file = emitEndpointPage("petstore", makeOp({ description: "Use {id} when value < 10." }), EMPTY_SAMPLES);
		expect(file.content).toContain("Use \\{id\\} when value \\< 10.");
	});

	it("omits the description block entirely when the operation has none", () => {
		const file = emitEndpointPage("petstore", makeOp({ description: "" }), EMPTY_SAMPLES);
		expect(file.content).not.toContain("<EndpointDescription");
	});

	it("emits a CodeSwitcher with five panes (curl/js/ts/python/go)", () => {
		const file = emitEndpointPage("petstore", makeOp(), EMPTY_SAMPLES);
		expect(file.content).toContain('<CodeSwitcher label={"Request"}');
		// The options literal should mention each language label.
		expect(file.content).toContain('"label":"cURL"');
		expect(file.content).toContain('"label":"JavaScript"');
		expect(file.content).toContain('"label":"TypeScript"');
		expect(file.content).toContain('"label":"Python"');
		expect(file.content).toContain('"label":"Go"');
	});

	it("uses an extra-long fence when a code sample contains a triple-backtick run", () => {
		const samples = { ...EMPTY_SAMPLES, curl: "echo '```' # tricky" };
		const file = emitEndpointPage("petstore", makeOp(), samples);
		// 3 backticks inside → fence must be ≥ 4. We assert a 4+ fence appears
		// somewhere in the cURL pane.
		expect(file.content).toMatch(/````bash/);
	});

	it("emits a Response switcher when at least one response has an example or schema", () => {
		const op = makeOp({
			responses: [{ status: "200", description: "ok", schema: { type: "object" } }],
		});
		const file = emitEndpointPage("petstore", op, EMPTY_SAMPLES);
		expect(file.content).toContain('<CodeSwitcher label={"Response"}');
		expect(file.content).toContain('"value":"200"');
	});

	it("skips the Response switcher entirely when no response has a body", () => {
		const op = makeOp({ responses: [{ status: "204", description: "no content" }] });
		const file = emitEndpointPage("petstore", op, EMPTY_SAMPLES);
		expect(file.content).not.toContain('label={"Response"}');
	});

	it("response pane labels include the description suffix when present", () => {
		const op = makeOp({
			responses: [{ status: "200", description: "ok", schema: { type: "object" } }],
		});
		const file = emitEndpointPage("petstore", op, EMPTY_SAMPLES);
		expect(file.content).toContain('"label":"200 — ok"');
	});

	it("uses the literal example when the response provides one (skipping schema synthesis)", () => {
		const op = makeOp({
			responses: [{ status: "200", example: { id: 1, name: "Rex" } }],
		});
		const file = emitEndpointPage("petstore", op, EMPTY_SAMPLES);
		expect(file.content).toContain('"name": "Rex"');
	});
});
