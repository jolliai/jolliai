import { describe, expect, it } from "vitest";
import { adfToText } from "./AdfToText.js";

describe("adfToText", () => {
	it("renders a whole document: headings, paragraphs, lists and quotes", () => {
		const doc = {
			type: "doc",
			content: [
				{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Design" }] },
				{
					type: "paragraph",
					content: [
						{ type: "text", text: "We chose " },
						{ type: "text", text: "A" },
					],
				},
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
						},
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
						},
					],
				},
				{
					type: "orderedList",
					content: [
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }],
						},
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }],
						},
					],
				},
				{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "cited" }] }] },
				{ type: "codeBlock", content: [{ type: "text", text: "npm run all" }] },
			],
		};
		expect(adfToText(doc)).toBe(
			["## Design", "We chose A", "- one\n- two", "1. first\n2. second", "> cited", "npm run all"].join("\n\n"),
		);
	});

	it("clamps the heading level into the 1-6 markdown range", () => {
		const heading = (level: unknown) => ({
			type: "heading",
			attrs: { level },
			content: [{ type: "text", text: "H" }],
		});
		expect(adfToText(heading(0))).toBe("# H");
		expect(adfToText(heading(9))).toBe("###### H");
		// A missing / non-numeric level falls back to h1 rather than producing "undefined".
		expect(adfToText(heading("2"))).toBe("# H");
		expect(adfToText({ type: "heading", content: [{ type: "text", text: "H" }] })).toBe("# H");
	});

	it("concatenates the children of an unknown node type", () => {
		const node = {
			type: "panel",
			content: [{ type: "text", text: "a" }, { type: "emoji" }, { type: "text", text: "b" }],
		};
		expect(adfToText(node)).toBe("ab");
	});

	it("returns an empty string for anything that is not an ADF node", () => {
		for (const input of [null, undefined, "plain", 42, []]) {
			expect(adfToText(input)).toBe("");
		}
	});

	it("returns an empty string for a text node whose `text` is missing or not a string", () => {
		expect(adfToText({ type: "text" })).toBe("");
		expect(adfToText({ type: "text", text: 42 })).toBe("");
	});

	it("treats a node whose `content` is absent or not an array as having no children", () => {
		expect(adfToText({ type: "paragraph" })).toBe("");
		expect(adfToText({ type: "paragraph", content: "not an array" })).toBe("");
		expect(adfToText({ type: "doc", content: {} })).toBe("");
	});
});
