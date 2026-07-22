import { describe, expect, it } from "vitest";
import { extractRef } from "../../SourceEngine.js";
import { context7Definition } from "./context7.js";

const AT = "2026-07-22T08:00:00.000Z";

describe("context7Definition", () => {
	it("is track-only and arguments-derived", () => {
		expect(context7Definition.trackOnly).toBe(true);
		expect(context7Definition.argumentsDerived).toBe(true);
	});

	it("extracts a per-library reference from the normalized arguments payload", () => {
		const ref = extractRef(
			context7Definition,
			{ libraryId: "/vercel/next.js", query: "how does middleware work" },
			"mcp__context7__query-docs",
			AT,
		);
		expect(ref).not.toBeNull();
		expect(ref?.source).toBe("context7");
		expect(ref?.nativeId).toBe("/vercel/next.js");
		expect(ref?.title).toBe("vercel/next.js");
		expect(ref?.url).toBe("https://context7.com/vercel/next.js");
		expect(ref?.description).toBe("how does middleware work");
		expect(ref?.mapKey).toBe("context7:/vercel/next.js");
	});

	it("voids the reference when libraryId is not org/project shaped", () => {
		expect(extractRef(context7Definition, { libraryId: "next.js" }, "mcp__context7__query-docs", AT)).toBeNull();
		expect(extractRef(context7Definition, { libraryId: "/vercel" }, "mcp__context7__query-docs", AT)).toBeNull();
	});

	it("keeps the reference when query is absent (description optional)", () => {
		const ref = extractRef(context7Definition, { libraryId: "/mongodb/docs" }, "mcp__context7__query-docs", AT);
		expect(ref?.nativeId).toBe("/mongodb/docs");
		expect(ref?.description).toBeUndefined();
	});
});
