import { describe, expect, it } from "vitest";
import { createSearchTokenizer } from "./SearchTokenizer.js";

describe("createSearchTokenizer", () => {
	const tok = createSearchTokenizer();

	it("emits CJK unigrams and adjacent bigrams", () => {
		const tokens = tok.tokenize("认证超时");
		// unigrams + bigrams for the single run "认证超时"
		expect(tokens).toEqual(expect.arrayContaining(["认", "证", "超", "时", "认证", "证超", "超时"]));
	});

	it("still tokenizes Latin text (lowercased) and folds CJK into the same stream", () => {
		const tokens = tok.tokenize("Auth 认证");
		expect(tokens).toContain("auth"); // default tokenizer lowercases
		expect(tokens).toContain("认证"); // CJK bigram appended
	});

	it("returns base tokens unchanged for Latin-only input (no CJK additions)", () => {
		const tokens = tok.tokenize("hello world");
		expect(tokens).toContain("hello");
		expect(tokens.some((t) => /[一-鿿]/.test(t))).toBe(false);
	});

	it("does not throw on a non-string value (defensive guard)", () => {
		// Orama's own tokenizer tolerates non-string field values; mirror that.
		expect(() => tok.tokenize(42 as unknown as string)).not.toThrow();
	});
});
