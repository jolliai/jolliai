import { describe, expect, it } from "vitest";
import type { OpenApiOperation } from "../../openapi/Types.js";
import {
	apiSpecFolderSlug,
	endpointDataImportSpecifier,
	endpointDataPath,
	endpointPagePath,
	endpointRoutePath,
	tagSlug,
} from "./Paths.js";

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
	} as OpenApiOperation;
}

describe("apiSpecFolderSlug", () => {
	it("prefixes the spec name with 'api-'", () => {
		expect(apiSpecFolderSlug("petstore")).toBe("api-petstore");
	});
});

describe("tagSlug", () => {
	it("delegates to slugify", () => {
		expect(tagSlug("Pet Store")).toBe("pet-store");
	});

	it("appends '-doc' to reserved-word tags so module compilation does not break", () => {
		expect(tagSlug("export")).toBe("export-doc");
	});
});

describe("endpointPagePath", () => {
	it("composes the path under content/api-{spec}/{tag}/{opId}.mdx", () => {
		expect(endpointPagePath("petstore", makeOp())).toBe("content/api-petstore/pets/listpets.mdx");
	});

	it("slugifies the tag in the path component", () => {
		expect(endpointPagePath("petstore", makeOp({ tag: "Pet Store" }))).toBe(
			"content/api-petstore/pet-store/listpets.mdx",
		);
	});
});

describe("endpointRoutePath", () => {
	it("composes /api-{spec}/{tag}/{opId}", () => {
		expect(endpointRoutePath("petstore", makeOp())).toBe("/api-petstore/pets/listpets");
	});
});

describe("endpointDataPath", () => {
	it("places the JSON sidecar under content/api-{spec}/_data/", () => {
		expect(endpointDataPath("petstore", makeOp())).toBe("content/api-petstore/_data/listpets.json");
	});

	it("ignores the tag in the sidecar path so all operations share one _data folder", () => {
		expect(endpointDataPath("petstore", makeOp({ tag: "users" }))).toBe("content/api-petstore/_data/listpets.json");
	});
});

describe("endpointDataImportSpecifier", () => {
	it("resolves up one directory from the tag folder into _data/", () => {
		expect(endpointDataImportSpecifier(makeOp())).toBe("../_data/listpets.json");
	});
});
