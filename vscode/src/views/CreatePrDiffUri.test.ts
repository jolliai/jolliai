import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
	Uri: {
		from: (parts: { scheme: string; path?: string; query?: string }) => ({
			scheme: parts.scheme,
			path: parts.path ?? "",
			query: parts.query ?? "",
		}),
	},
}));

import { buildPrDiffUri, parsePrDiffUri, PR_DIFF_SCHEME } from "./CreatePrDiffUri.js";

describe("CreatePrDiffUri", () => {
	it("builds a jolli-prdiff URI with the path as a segment and ref in the query", () => {
		const uri = buildPrDiffUri("vscode/src/a.ts", "abc123");
		expect(uri.scheme).toBe(PR_DIFF_SCHEME);
		expect(uri.path).toBe("/vscode/src/a.ts");
		expect(uri.query).toBe("ref=abc123");
	});

	it("percent-encodes a ref so query separators can't be injected", () => {
		const uri = buildPrDiffUri("a.ts", "feature/x&evil=1");
		expect(uri.query).toBe("ref=feature%2Fx%26evil%3D1");
	});

	it("round-trips through parsePrDiffUri (leading slash stripped, ref decoded)", () => {
		const uri = buildPrDiffUri("dir/a.ts", "feature/x&evil=1");
		expect(parsePrDiffUri(uri)).toEqual({ relPath: "dir/a.ts", ref: "feature/x&evil=1" });
	});

	it("parses a missing ref as an empty string", () => {
		expect(parsePrDiffUri({ path: "/a.ts", query: "" } as never)).toEqual({ relPath: "a.ts", ref: "" });
	});
});
