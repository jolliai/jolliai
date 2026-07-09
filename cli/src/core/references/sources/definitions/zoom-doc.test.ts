import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { zoomDocDefinition as def } from "./zoom-doc.js";

// The definition runs over the POST-normalize canonical shape (Task 5 output).
const CANONICAL = {
	fileId: "y_sTD3ZsQv-o-f2pw3IQCA",
	title: "Flyer Li's Personal Meeting Room",
	content: "## Quick recap\n...",
	url: "https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA",
};
const TOOL = "mcp__claude_ai_Zoom_for_Claude__hub_get_file_content";
const AT = "2026-07-08T00:00:00Z";

describe("zoom-doc definition", () => {
	it("extracts a Reference from the canonical shape", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		expect(ref?.source).toBe("zoom-doc");
		expect(ref?.nativeId).toBe("y_sTD3ZsQv-o-f2pw3IQCA");
		expect(ref?.title).toBe("Flyer Li's Personal Meeting Room");
		expect(ref?.url).toBe("https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA");
		expect(ref?.description).toContain("Quick recap");
		expect(ref?.fields).toEqual([{ key: "entity-type", label: "Type", icon: "symbol-class", value: "doc" }]);
	});

	it("voids when fileId (nativeId) is missing", () => {
		expect(extractRef(def, { ...CANONICAL, fileId: undefined, url: undefined }, TOOL, AT)).toBeNull();
	});

	it("renders a <zoom-docs> block", () => {
		const ref = extractRef(def, CANONICAL, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		expect(renderBlock(def, [ref])).toContain("<zoom-docs>");
		expect(renderBlock(def, [ref])).toContain("<content>");
	});
});
