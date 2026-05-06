import { describe, expect, it } from "vitest";
import { estimateTokens } from "./TokenEstimator.js";

describe("estimateTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("estimates ASCII at ~0.25 tokens/char", () => {
		const text = "hello world!";
		expect(estimateTokens(text)).toBe(Math.ceil(text.length * 0.25));
	});

	it("estimates CJK at ~1.5 tokens/char", () => {
		const text = "你好世界";
		expect(estimateTokens(text)).toBe(Math.ceil(4 * 1.5));
	});

	it("handles mixed scripts additively", () => {
		const text = "hi 你好";
		// 3 ASCII (h, i, space) + 2 CJK
		expect(estimateTokens(text)).toBe(Math.ceil(3 * 0.25 + 2 * 1.5));
	});

	it("counts hiragana / katakana as CJK", () => {
		const text = "こんにちは"; // 5 hiragana
		expect(estimateTokens(text)).toBe(Math.ceil(5 * 1.5));
	});

	it("counts hangul as CJK", () => {
		const text = "안녕하세요"; // 5 hangul
		expect(estimateTokens(text)).toBe(Math.ceil(5 * 1.5));
	});
});
