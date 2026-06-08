import { describe, expect, it } from "vitest";
import { isObject, normalizeEntities } from "./shared.js";

describe("bindings/shared primitives", () => {
	describe("isObject", () => {
		it("accepts plain objects, rejects null/array/primitive", () => {
			expect(isObject({})).toBe(true);
			expect(isObject({ a: 1 })).toBe(true);
			expect(isObject(null)).toBe(false);
			expect(isObject([])).toBe(false);
			expect(isObject(7)).toBe(false);
			expect(isObject("x")).toBe(false);
			expect(isObject(undefined)).toBe(false);
		});
	});

	describe("normalizeEntities", () => {
		const tag = (raw: unknown) => (isObject(raw) ? { ...raw, normalized: true } : raw);

		it("maps each element of a collection under a wrapper key, keeping the wrapper", () => {
			const out = normalizeEntities({ issues: [{ a: 1 }, { a: 2 }], meta: "x" }, ["issues"], tag) as {
				issues: Array<{ normalized: boolean }>;
				meta: string;
			};
			expect(out.issues.every((e) => e.normalized)).toBe(true);
			expect(out.meta).toBe("x");
		});

		it("normalizes a single entity when no collection key is present", () => {
			expect(normalizeEntities({ a: 1 }, ["issues"], tag)).toEqual({ a: 1, normalized: true });
		});

		it("falls through to single-entity when a collection key exists but is not an array", () => {
			// e.g. Jira's `{issues:{nodes:[…]}}` — the wrapper value is an object, not an array.
			const out = normalizeEntities({ issues: { nodes: [] } }, ["issues"], tag) as { normalized: boolean };
			expect(out.normalized).toBe(true);
		});

		it("handles an empty collection array (wrapper kept, nothing mapped)", () => {
			expect(normalizeEntities({ issues: [] }, ["issues"], tag)).toEqual({ issues: [] });
		});

		it("returns non-object input as-is", () => {
			expect(normalizeEntities(123, ["issues"], tag)).toBe(123);
			expect(normalizeEntities(null, ["issues"], tag)).toBe(null);
		});
	});
});
