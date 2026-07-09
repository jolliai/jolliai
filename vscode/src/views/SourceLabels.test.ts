import { describe, expect, it } from "vitest";
import { getSourceMeta, SOURCE_META } from "./SourceLabels";

describe("SOURCE_META", () => {
	it("has slack metadata", () => {
		expect(SOURCE_META.slack).toEqual({ label: "Slack", letter: "S", icon: "comment-discussion", color: "#4a154b" });
		expect(getSourceMeta("slack").label).toBe("Slack");
	});
});

describe("getSourceMeta", () => {
	it("returns the table entry for a known source id", () => {
		const meta = getSourceMeta("github");
		expect(meta.letter).toBe("G");
		expect(meta.icon).toBe("issues");
		expect(meta.color).toBe("#6e7681");
	});

	it("falls back to a derived letter/neutral icon/color for an unknown id", () => {
		const meta = getSourceMeta("someUnknownSource");
		expect(meta.letter).toBe("S");
		expect(meta.icon).toBe("link");
		expect(meta.color).toBe("#6e7681");
	});

	it("treats prototype-chain keys as unknown sources, not inherited members", () => {
		// With `SourceId` widened to `string`, ids like "toString"/"constructor"
		// must not resolve to `Object.prototype` members and be returned as a
		// bogus SourceMeta with `label`/`letter` undefined.
		for (const id of ["toString", "constructor", "hasOwnProperty"]) {
			const meta = getSourceMeta(id);
			expect(meta.label).toBe(id);
			expect(meta.letter).toBe(id.slice(0, 1).toUpperCase());
			expect(meta.icon).toBe("link");
		}
	});

	it("has bespoke Zoom Meeting badge metadata", () => {
		const m = getSourceMeta("zoom-meeting");
		expect(m).toEqual({ label: "Zoom Meeting", letter: "Z", icon: "device-camera-video", color: "#2D8CFF" });
	});

	it("has bespoke Zoom Doc badge metadata", () => {
		const m = getSourceMeta("zoom-doc");
		expect(m).toEqual({ label: "Zoom Doc", letter: "Z", icon: "file", color: "#2D8CFF" });
	});
});
