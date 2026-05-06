/**
 * Tests for SchemaExample — synthesises example payloads from OpenAPI schemas.
 *
 * Ported from JOLLI-1392's nextra-generator with no behavioural changes.
 * These also document the function's intentional gaps (no $ref, no oneOf /
 * anyOf / allOf, no enum / default / nullable handling) so we don't quietly
 * regress.
 */

import { describe, expect, it } from "vitest";
import { exampleFromSchema } from "./SchemaExample.js";

describe("exampleFromSchema — primitives", () => {
	it("returns 'string' for type: string", () => {
		expect(exampleFromSchema({ type: "string" })).toBe("string");
	});

	it("returns the date-time placeholder for format: date-time", () => {
		expect(exampleFromSchema({ type: "string", format: "date-time" })).toBe("2024-01-01T00:00:00Z");
	});

	it("returns 'string' for unrecognized formats (uuid, email, etc) — only date-time has a special case today", () => {
		expect(exampleFromSchema({ type: "string", format: "uuid" })).toBe("string");
		expect(exampleFromSchema({ type: "string", format: "email" })).toBe("string");
	});

	it("returns 0 for type: integer and type: number", () => {
		expect(exampleFromSchema({ type: "integer" })).toBe(0);
		expect(exampleFromSchema({ type: "number" })).toBe(0);
	});

	it("returns false for type: boolean", () => {
		expect(exampleFromSchema({ type: "boolean" })).toBe(false);
	});
});

describe("exampleFromSchema — explicit example wins", () => {
	it("returns schema.example verbatim regardless of type", () => {
		const schema = { type: "string", example: "explicit-value" };
		expect(exampleFromSchema(schema)).toBe("explicit-value");
	});

	it("treats false / 0 / empty-string examples as valid (not as 'missing')", () => {
		expect(exampleFromSchema({ type: "boolean", example: false })).toBe(false);
		expect(exampleFromSchema({ type: "integer", example: 0 })).toBe(0);
		expect(exampleFromSchema({ type: "string", example: "" })).toBe("");
	});

	it("returns object/array examples verbatim instead of synthesizing", () => {
		const obj = { name: "Rex", age: 4 };
		expect(exampleFromSchema({ type: "object", example: obj })).toBe(obj);
		const arr = [1, 2, 3];
		expect(exampleFromSchema({ type: "array", example: arr })).toBe(arr);
	});
});

describe("exampleFromSchema — objects", () => {
	it("recurses into properties to build a synthetic body", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "integer" },
				active: { type: "boolean" },
			},
		};
		expect(exampleFromSchema(schema)).toEqual({ name: "string", age: 0, active: false });
	});

	it("treats schemas with properties but no explicit type as objects", () => {
		const schema = { properties: { name: { type: "string" } } };
		expect(exampleFromSchema(schema)).toEqual({ name: "string" });
	});

	it("returns an empty object when type: object has no properties", () => {
		expect(exampleFromSchema({ type: "object" })).toEqual({});
	});

	it("nests objects inside objects", () => {
		const schema = {
			type: "object",
			properties: {
				owner: {
					type: "object",
					properties: {
						name: { type: "string" },
						email: { type: "string" },
					},
				},
			},
		};
		expect(exampleFromSchema(schema)).toEqual({
			owner: { name: "string", email: "string" },
		});
	});

	it("omits properties whose schema synthesizes undefined", () => {
		const schema = {
			type: "object",
			properties: {
				known: { type: "string" },
				mystery: {},
			},
		};
		expect(exampleFromSchema(schema)).toEqual({ known: "string" });
	});
});

describe("exampleFromSchema — arrays", () => {
	it("returns a single-element array of the synthesized item", () => {
		expect(exampleFromSchema({ type: "array", items: { type: "string" } })).toEqual(["string"]);
	});

	it("returns an empty array when items has no concrete fallback", () => {
		expect(exampleFromSchema({ type: "array", items: {} })).toEqual([]);
	});

	it("returns an empty array when items is missing entirely", () => {
		expect(exampleFromSchema({ type: "array" })).toEqual([]);
	});

	it("nests arrays inside objects and produces a non-trivial sample body", () => {
		const schema = {
			type: "object",
			properties: {
				tags: { type: "array", items: { type: "string" } },
				count: { type: "integer" },
			},
		};
		expect(exampleFromSchema(schema)).toEqual({ tags: ["string"], count: 0 });
	});

	it("nests objects inside arrays", () => {
		const schema = {
			type: "array",
			items: {
				type: "object",
				properties: { id: { type: "integer" }, name: { type: "string" } },
			},
		};
		expect(exampleFromSchema(schema)).toEqual([{ id: 0, name: "string" }]);
	});
});

describe("exampleFromSchema — recursion depth", () => {
	it("stops recursing past depth 4 to avoid infinite loops on cyclic schemas", () => {
		// biome-ignore lint/suspicious/noExplicitAny: intentional cycle for the depth-limit test
		const schema: any = { type: "object", properties: {} };
		schema.properties.a = schema;

		const result = exampleFromSchema(schema) as Record<string, unknown>;
		expect(result).toEqual({ a: { a: { a: { a: {} } } } });
	});
});

describe("exampleFromSchema — invalid input", () => {
	it("returns undefined for null / undefined / primitive inputs", () => {
		expect(exampleFromSchema(null)).toBeUndefined();
		expect(exampleFromSchema(undefined)).toBeUndefined();
		expect(exampleFromSchema("not a schema")).toBeUndefined();
		expect(exampleFromSchema(42)).toBeUndefined();
	});

	it("returns undefined for an empty schema (no type, no properties, no items, no example)", () => {
		expect(exampleFromSchema({})).toBeUndefined();
	});

	it("returns undefined for unknown types — synthesizing a guess could mislead readers", () => {
		expect(exampleFromSchema({ type: "bigint" })).toBeUndefined();
		expect(exampleFromSchema({ type: "geography" })).toBeUndefined();
	});
});

describe("exampleFromSchema — known gaps (intentional, documented so we don't quietly regress)", () => {
	it("does not currently follow $ref pointers — returns undefined for ref-only schemas", () => {
		expect(exampleFromSchema({ $ref: "#/components/schemas/Pet" })).toBeUndefined();
	});

	it("does not currently understand oneOf / anyOf / allOf composition", () => {
		expect(exampleFromSchema({ oneOf: [{ type: "string" }, { type: "integer" }] })).toBeUndefined();
		expect(exampleFromSchema({ anyOf: [{ type: "string" }] })).toBeUndefined();
		expect(
			exampleFromSchema({
				allOf: [
					{ type: "object", properties: { a: { type: "string" } } },
					{ type: "object", properties: { b: { type: "integer" } } },
				],
			}),
		).toBeUndefined();
	});

	it("does not currently honor `enum` — emits the type's default placeholder instead of a real enum value", () => {
		expect(exampleFromSchema({ type: "string", enum: ["red", "green", "blue"] })).toBe("string");
	});

	it("does not currently honor `default` — emits the type's placeholder instead of the spec's default", () => {
		expect(exampleFromSchema({ type: "string", default: "hello" })).toBe("string");
		expect(exampleFromSchema({ type: "integer", default: 42 })).toBe(0);
	});

	it("does not currently honor `nullable: true` — emits the placeholder instead of null", () => {
		expect(exampleFromSchema({ type: "string", nullable: true })).toBe("string");
	});
});
