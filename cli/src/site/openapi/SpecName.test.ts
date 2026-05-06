import { describe, expect, it } from "vitest";
import { deriveSpecName } from "./SpecName.js";

describe("deriveSpecName", () => {
	it("uses the basename without extension", () => {
		expect(deriveSpecName("petstore.yaml")).toBe("petstore");
		expect(deriveSpecName("openapi.json")).toBe("openapi");
	});

	it("strips containing directories", () => {
		expect(deriveSpecName("api/petstore.yaml")).toBe("petstore");
		expect(deriveSpecName("v1/spec.yml")).toBe("spec");
	});

	it("slugifies camel-case basenames (lowercases)", () => {
		expect(deriveSpecName("PetStore.yaml")).toBe("petstore");
	});

	it("slugifies basenames with spaces / punctuation", () => {
		expect(deriveSpecName("My API (v2).yaml")).toBe("my-api-v2");
	});

	it("appends '-doc' when the basename collides with a JS reserved word", () => {
		expect(deriveSpecName("export.yaml")).toBe("export-doc");
	});

	it("treats a file consisting of only an extension as its bare name", () => {
		// `path.extname(".yaml")` returns "" (Node treats it as a hidden file
		// with no extension), so basename(".yaml", "") = ".yaml", which slugify
		// reduces to "yaml" after stripping the leading dot.
		expect(deriveSpecName(".yaml")).toBe("yaml");
	});
});
