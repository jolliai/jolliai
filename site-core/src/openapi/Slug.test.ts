/**
 * Tests for Slug — URL-safe slug generation with reserved-word fallback.
 */

import { describe, expect, it } from "vitest";
import { slugify } from "./Slug.js";

describe("slugify", () => {
	it("lowercases and hyphenates spaces", () => {
		expect(slugify("Hello World")).toBe("hello-world");
	});

	it("strips special characters", () => {
		expect(slugify("List Users (v2)!")).toBe("list-users-v2");
	});

	it("collapses runs of hyphens", () => {
		expect(slugify("a -- b")).toBe("a-b");
	});

	it("trims leading and trailing hyphens", () => {
		expect(slugify(" -hello- ")).toBe("hello");
	});

	it("returns 'untitled' for the empty string", () => {
		expect(slugify("")).toBe("untitled");
	});

	it("returns 'untitled' for whitespace / punctuation-only inputs", () => {
		expect(slugify("   ")).toBe("untitled");
		expect(slugify("!!!")).toBe("untitled");
	});

	it("appends '-doc' to slugs that collide with JS reserved words", () => {
		expect(slugify("export")).toBe("export-doc");
		expect(slugify("class")).toBe("class-doc");
		expect(slugify("default")).toBe("default-doc");
	});

	it("appends '-doc' to slugs that collide with TS keywords", () => {
		expect(slugify("type")).toBe("type-doc");
		expect(slugify("namespace")).toBe("namespace-doc");
	});

	it("appends '-doc' to the Nextra-reserved 'index' slug", () => {
		expect(slugify("index")).toBe("index-doc");
	});

	it("preserves non-reserved underscores and digits", () => {
		expect(slugify("get_user_v2")).toBe("get_user_v2");
	});
});
