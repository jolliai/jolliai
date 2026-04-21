import { describe, expect, it } from "vitest";
import { fillTemplate, findUnfilledPlaceholders, TEMPLATES } from "./PromptTemplates.js";

describe("PromptTemplates", () => {
	describe("fillTemplate", () => {
		it("substitutes matching placeholders", () => {
			expect(fillTemplate("Hello {{name}} from {{ place }}", { name: "Ada", place: "Jolli" })).toBe(
				"Hello Ada from Jolli",
			);
		});

		it("leaves unmatched placeholders as-is", () => {
			expect(fillTemplate("Hello {{name}} from {{place}}", { name: "Ada" })).toBe("Hello Ada from {{place}}");
		});
	});

	describe("findUnfilledPlaceholders", () => {
		it("returns missing keys", () => {
			expect(findUnfilledPlaceholders("{{a}} {{ b }} {{c}} {{a}}", { a: "1" })).toEqual(["b", "c"]);
		});

		it("returns an empty array when all placeholders are filled", () => {
			expect(findUnfilledPlaceholders("{{a}} {{b}}", { a: "1", b: "2" })).toEqual([]);
		});
	});

	it("exports all expected templates", () => {
		expect([...TEMPLATES.keys()]).toEqual([
			"summarize:small",
			"summarize:medium",
			"summarize:large",
			"commit-message",
			"squash-message",
			"e2e-test",
			"plan-progress",
			"translate",
		]);
	});

	it("does not leak JS interpolation syntax into templates", () => {
		for (const template of TEMPLATES.values()) {
			expect(template).not.toContain("${");
		}
	});

	it("keeps all template text ASCII-only", () => {
		for (const [key, template] of TEMPLATES) {
			for (const ch of template) {
				expect(ch.charCodeAt(0), `non-ASCII character in ${key}: ${JSON.stringify(ch)}`).toBeLessThanOrEqual(
					0x7f,
				);
			}
		}
	});
});
