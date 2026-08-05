/**
 * Field-access tests for `ContextKindRegistry`.
 *
 * The registry reads and writes item properties by NAME, from strings a definition
 * supplies, so every accessor has to tolerate data that does not match the shape
 * the definition claims — a legacy summary missing a field it predates, or a
 * corrupt/hand-edited array holding a non-object. These paths are unreachable
 * through the three built-in kinds (their items are always well-formed objects
 * from stored JSON), which is exactly why they are exercised directly here rather
 * than left as untested defensive code.
 */

import { describe, expect, it } from "vitest";
import { defineContextKind } from "./ContextKindDefinition.js";
import {
	baseKeyOfItem,
	docIdFieldOf,
	docIdOf,
	docUrlFieldOf,
	docUrlOf,
	entryKeyOf,
	linksInMarkdown,
	recencyOf,
} from "./ContextKindRegistry.js";

/**
 * Carries BOTH field sets so one interface can back the uniform and the legacy kind
 * below: a definition's declared field names are checked against its item type, so
 * `legacyDocId`/`legacyDocUrl` have to exist here to be declarable there.
 */
interface Item {
	readonly key?: string;
	readonly at?: string;
	readonly jolliDocId?: number;
	readonly jolliDocUrl?: string;
	readonly legacyDocId?: number;
	readonly legacyDocUrl?: string;
}

/** Uniform-field kind: exercises the DEFAULT doc-state field names. */
const uniform = defineContextKind<Item>({
	docType: "uniform",
	field: "items",
	entryKey: "key",
	baseKey: { fields: ["key"] },
	recency: "at",
	title: () => "t",
	body: async () => "b",
});

/** Legacy-shaped kind: overrides the doc-state field names and strips the archive stamp. */
const legacy = defineContextKind<Item>({
	docType: "legacy",
	field: "items",
	entryKey: "key",
	baseKey: { fields: ["key"], stripArchiveSuffix: true },
	recency: "at",
	docIdField: "legacyDocId",
	docUrlField: "legacyDocUrl",
	linksInMarkdown: false,
	title: () => "t",
	body: async () => "b",
});

describe("resolved field names", () => {
	it("falls back to the uniform defaults when a kind declares none", () => {
		expect(docIdFieldOf(uniform)).toBe("jolliDocId");
		expect(docUrlFieldOf(uniform)).toBe("jolliDocUrl");
		expect(linksInMarkdown(uniform)).toBe(true);
	});

	it("honours a kind's overrides", () => {
		expect(docIdFieldOf(legacy)).toBe("legacyDocId");
		expect(docUrlFieldOf(legacy)).toBe("legacyDocUrl");
		expect(linksInMarkdown(legacy)).toBe(false);
	});
});

describe("string field access", () => {
	it("reads present string fields", () => {
		expect(entryKeyOf(uniform, { key: "k1" })).toBe("k1");
		expect(recencyOf(uniform, { at: "2026-01-01" })).toBe("2026-01-01");
	});

	it("returns '' for an absent field, so an unknown recency loses the winner comparison", () => {
		expect(recencyOf(uniform, {})).toBe("");
		expect(recencyOf(uniform, { at: 42 })).toBe("");
	});

	it("returns '' for a non-object or null item rather than throwing", () => {
		expect(entryKeyOf(uniform, null)).toBe("");
		expect(entryKeyOf(uniform, "not-an-object")).toBe("");
	});
});

describe("baseKeyOfItem", () => {
	it("joins the declared fields with ':'", () => {
		const twoField = defineContextKind<{ a: string; b: string }>({
			docType: "two",
			field: "items",
			entryKey: "a",
			baseKey: { fields: ["a", "b"] },
			recency: "a",
			title: () => "t",
			body: async () => "b",
		});
		expect(baseKeyOfItem(twoField, { a: "linear", b: "ENG-1" })).toBe("linear:ENG-1");
	});

	it("strips a trailing archive stamp only when the kind asks for it", () => {
		expect(baseKeyOfItem(legacy, { key: "refactor-auth-a1b2c3d4" })).toBe("refactor-auth");
		expect(baseKeyOfItem(uniform, { key: "refactor-auth-a1b2c3d4" })).toBe("refactor-auth-a1b2c3d4");
	});
});

describe("doc-state field access", () => {
	it("reads a numeric docId and a string docUrl", () => {
		expect(docIdOf(uniform, { jolliDocId: 7 })).toBe(7);
		expect(docUrlOf(uniform, { jolliDocUrl: "https://x/y" })).toBe("https://x/y");
	});

	it("returns undefined for absent or wrongly-typed values", () => {
		expect(docIdOf(uniform, {})).toBeUndefined();
		expect(docIdOf(uniform, { jolliDocId: "7" })).toBeUndefined();
		expect(docUrlOf(uniform, {})).toBeUndefined();
		expect(docUrlOf(uniform, { jolliDocUrl: 7 })).toBeUndefined();
	});

	it("returns undefined for a non-object or null item rather than throwing", () => {
		expect(docIdOf(uniform, null)).toBeUndefined();
		expect(docIdOf(uniform, 5)).toBeUndefined();
		expect(docUrlOf(uniform, null)).toBeUndefined();
		expect(docUrlOf(uniform, 5)).toBeUndefined();
	});
});
