import { describe, expect, it } from "vitest";
import { buildContextMenuGuardScript } from "./ContextMenuGuard.js";

describe("buildContextMenuGuardScript", () => {
	const snippet = buildContextMenuGuardScript();

	it("registers a document-level contextmenu listener", () => {
		expect(snippet).toContain("document.addEventListener('contextmenu'");
	});

	it("calls preventDefault when the target is non-editable", () => {
		expect(snippet).toMatch(
			/if \(!isEditable\(e\.target\)\) e\.preventDefault\(\)/,
		);
	});

	it("recognizes textarea and contenteditable as editable", () => {
		expect(snippet).toContain("TEXTAREA");
		expect(snippet).toContain("isContentEditable");
	});

	it("permits the common text-bearing input types", () => {
		for (const type of [
			"text",
			"number",
			"search",
			"email",
			"url",
			"tel",
			"password",
		]) {
			expect(snippet).toContain(`type === '${type}'`);
		}
	});

	it("does not list non-text input types in the editable carve-out", () => {
		// These types should fall through and have their default menu prevented.
		for (const type of ["checkbox", "radio", "button", "submit", "file"]) {
			expect(snippet).not.toContain(`type === '${type}'`);
		}
	});

	it("returns a self-contained IIFE so callers can inline it without leaking names", () => {
		expect(snippet.trim().startsWith("(function ()")).toBe(true);
		expect(snippet.trim().endsWith("})();")).toBe(true);
	});
});
