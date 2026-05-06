/**
 * Tests for the Nextra emitter orchestrator. End-to-end: build a synthetic
 * pipeline result, invoke `emitNextraOpenApiFiles`, assert the expected set
 * of TemplateFile paths is produced.
 */

import { describe, expect, it } from "vitest";
import type { OpenApiOperation, OpenApiPipelineResult, ParsedSpec } from "../../openapi/Types.js";
import type { OpenApiSpecInput } from "../SiteRenderer.js";
import { emitNextraOpenApiFiles, emitNextraOpenApiForSpec } from "./index.js";

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

function makeSpec(overrides: Partial<ParsedSpec> = {}): ParsedSpec {
	return {
		info: { title: "Pet Store", version: "1.0.0", description: "" },
		servers: [{ url: "https://api.example.com" }],
		securitySchemes: {},
		globalSecurity: [],
		tags: [{ name: "pets" }],
		operations: [makeOp()],
		componentSchemas: {},
		...overrides,
	};
}

function makeInput(overrides: Partial<OpenApiSpecInput> = {}): OpenApiSpecInput {
	const spec = makeSpec(overrides.pipeline?.spec ?? {});
	const pipeline: OpenApiPipelineResult = overrides.pipeline ?? { spec, dossiers: [] };
	return {
		specName: overrides.specName ?? "petstore",
		sourceRelPath: overrides.sourceRelPath ?? "api/petstore.yaml",
		pipeline,
	};
}

// ─── emitNextraOpenApiForSpec ──────────────────────────────────────────────

describe("emitNextraOpenApiForSpec", () => {
	it("emits overview, _refs, per-operation MDX + JSON, and sidebar metas", () => {
		const input = makeInput();
		const files = emitNextraOpenApiForSpec(input.specName, input.pipeline);
		const paths = new Set(files.map((f) => f.path));
		expect(paths.has("content/api-petstore/index.mdx")).toBe(true);
		expect(paths.has("content/api-petstore/_refs.ts")).toBe(true);
		expect(paths.has("content/api-petstore/_meta.ts")).toBe(true);
		expect(paths.has("content/api-petstore/pets/_meta.ts")).toBe(true);
		expect(paths.has("content/api-petstore/pets/listpets.mdx")).toBe(true);
		expect(paths.has("content/api-petstore/_data/listpets.json")).toBe(true);
	});

	it("synthesises per-operation code samples when the pipeline has no dossiers", () => {
		// dossiers: [] forces the orchestrator to call generateCodeSamples
		// inline. We confirm the sample appears inside the MDX shim.
		const input = makeInput();
		const files = emitNextraOpenApiForSpec(input.specName, input.pipeline);
		const mdx = files.find((f) => f.path === "content/api-petstore/pets/listpets.mdx");
		expect(mdx?.content).toContain("curl -X GET");
	});

	it("uses pre-built code samples from the dossiers when present", () => {
		const op = makeOp();
		const spec = makeSpec({ operations: [op] });
		const input = makeInput({
			pipeline: {
				spec,
				dossiers: [
					{
						operation: op,
						codeSamples: {
							curl: "PRE-BUILT-CURL",
							js: "PRE-BUILT-JS",
							ts: "PRE-BUILT-TS",
							python: "PRE-BUILT-PY",
							go: "PRE-BUILT-GO",
						},
					},
				],
			},
		});
		const files = emitNextraOpenApiForSpec(input.specName, input.pipeline);
		const mdx = files.find((f) => f.path === "content/api-petstore/pets/listpets.mdx");
		expect(mdx?.content).toContain("PRE-BUILT-CURL");
		expect(mdx?.content).not.toContain("curl -X GET");
	});

	it("returns an empty array if the spec has no operations (just overview, refs, top-level _meta)", () => {
		const input = makeInput({
			pipeline: { spec: makeSpec({ operations: [], tags: [] }), dossiers: [] },
		});
		const files = emitNextraOpenApiForSpec(input.specName, input.pipeline);
		const paths = files.map((f) => f.path);
		expect(paths).toContain("content/api-petstore/index.mdx");
		expect(paths).toContain("content/api-petstore/_refs.ts");
		expect(paths.filter((p) => p.endsWith(".json"))).toEqual([]);
	});
});

// ─── emitNextraOpenApiFiles ──────────────────────────────────────────────

describe("emitNextraOpenApiFiles", () => {
	it("emits per-spec output but no components (those are scaffold, written by initProject)", () => {
		const files = emitNextraOpenApiFiles([makeInput()]);
		const componentPaths = files.filter((f) => f.path.startsWith("components/api/"));
		expect(componentPaths).toHaveLength(0);
		expect(files.some((f) => f.path === "content/api-petstore/index.mdx")).toBe(true);
	});

	it("emits per-spec output for each input when given multiple specs", () => {
		const files = emitNextraOpenApiFiles([makeInput({ specName: "petstore" }), makeInput({ specName: "users" })]);
		expect(files.some((f) => f.path === "content/api-petstore/index.mdx")).toBe(true);
		expect(files.some((f) => f.path === "content/api-users/index.mdx")).toBe(true);
	});

	it("returns an empty array when no specs are provided", () => {
		expect(emitNextraOpenApiFiles([])).toEqual([]);
	});
});
