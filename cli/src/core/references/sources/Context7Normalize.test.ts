import { describe, expect, it } from "vitest";
import { normalizeContext7 } from "./Context7Normalize.js";

describe("normalizeContext7", () => {
	it("builds { libraryId, query } from the query-docs arguments", () => {
		expect(normalizeContext7({ libraryId: "/vercel/next.js", query: "middleware" })).toEqual({
			libraryId: "/vercel/next.js",
			query: "middleware",
		});
	});

	it("omits query when absent or empty", () => {
		expect(normalizeContext7({ libraryId: "/vercel/next.js" })).toEqual({ libraryId: "/vercel/next.js" });
		expect(normalizeContext7({ libraryId: "/vercel/next.js", query: "" })).toEqual({
			libraryId: "/vercel/next.js",
		});
	});

	it("returns null when libraryId is missing or non-string", () => {
		expect(normalizeContext7({ query: "middleware" })).toBeNull();
		expect(normalizeContext7({ libraryId: 42 })).toBeNull();
		expect(normalizeContext7("not-an-object")).toBeNull();
		expect(normalizeContext7(undefined)).toBeNull();
	});
});
