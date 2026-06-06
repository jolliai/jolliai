import { describe, expect, it } from "vitest";
import { unwrap } from "./TestHelpers.js";

describe("unwrap", () => {
	it("returns the value unchanged when it is non-null", () => {
		const value = { id: "REF-1" };
		expect(unwrap(value)).toBe(value);
	});

	it("returns falsy-but-defined values unchanged (0, empty string, false)", () => {
		expect(unwrap(0)).toBe(0);
		expect(unwrap("")).toBe("");
		expect(unwrap(false)).toBe(false);
	});

	it("throws the default message when the value is null", () => {
		expect(() => unwrap(null)).toThrow("expected non-null value");
	});

	it("throws the default message when the value is undefined", () => {
		expect(() => unwrap(undefined)).toThrow("expected non-null value");
	});

	it("throws a custom message when provided", () => {
		expect(() => unwrap(null, "adapter returned no reference")).toThrow("adapter returned no reference");
	});
});
