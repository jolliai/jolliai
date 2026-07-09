import { describe, expect, it } from "vitest";
import { normalizeZoomDoc } from "./ZoomDocNormalize.js";

// Real 2026-07-08 hub_get_file_content result (design spec §6): fileId is NOT in the result.
const RESULT = { file_name: "Flyer Li's Personal Meeting Room", file_content: "## Quick recap\n..." };
const CTX = { fileId: "y_sTD3ZsQv-o-f2pw3IQCA" };

describe("normalizeZoomDoc", () => {
	it("merges fileId from ctx and builds the doc url", () => {
		expect(normalizeZoomDoc(RESULT, CTX)).toEqual({
			fileId: "y_sTD3ZsQv-o-f2pw3IQCA",
			title: "Flyer Li's Personal Meeting Room",
			content: "## Quick recap\n...",
			url: "https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA",
		});
	});

	it("returns null when file_name is missing", () => {
		expect(normalizeZoomDoc({ file_content: "body" }, CTX)).toBeNull();
	});

	it("returns null when file_name is empty", () => {
		expect(normalizeZoomDoc({ file_name: "", file_content: "body" }, CTX)).toBeNull();
	});

	it("omits content when file_content is absent", () => {
		expect(normalizeZoomDoc({ file_name: "Title only" }, CTX)).toEqual({
			fileId: "y_sTD3ZsQv-o-f2pw3IQCA",
			title: "Title only",
			url: "https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA",
		});
	});

	it("does not throw on non-object rawResult", () => {
		expect(() => normalizeZoomDoc(null, CTX)).not.toThrow();
		expect(() => normalizeZoomDoc("oops", CTX)).not.toThrow();
		expect(normalizeZoomDoc(null, CTX)).toBeNull();
		expect(normalizeZoomDoc("oops", CTX)).toBeNull();
	});
});
