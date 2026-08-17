import { describe, expect, it } from "vitest";
import { getSourceMeta, NEUTRAL_SOURCE_COLOR, SOURCE_META, SOURCE_TITLES, sourceClassToken } from "./SourceLabels.js";

describe("SOURCE_META", () => {
	it("has slack metadata", () => {
		expect(SOURCE_META.slack).toEqual({
			label: "Slack",
			letter: "S",
			icon: "comment-discussion",
			color: "#4a154b",
		});
		expect(getSourceMeta("slack").label).toBe("Slack");
	});

	it("carries an icon matching each source definition's own codicon", () => {
		// The visual-lockstep rule the table's docstring records: the `icon` here
		// is the same codicon id the CLI's SourceDefinition declares, so the tree
		// and the badge cannot describe one source two ways.
		expect(SOURCE_META.linear.icon).toBe("issues");
		expect(SOURCE_META.vercel.icon).toBe("rocket");
		expect(SOURCE_META.figma.icon).toBe("symbol-color");
		expect(SOURCE_META.sentry.icon).toBe("bug");
	});

	it("never colours a badge pure black", () => {
		// `#000000` is the one hue that can render a chip invisible against a
		// black panel, leaving a bare floating letter — see the `vercel` note.
		for (const [id, meta] of Object.entries(SOURCE_META)) {
			expect(meta.color.toLowerCase(), `${id} must not be pure black`).not.toBe("#000000");
		}
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
		expect(meta.color).toBe(NEUTRAL_SOURCE_COLOR);
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

describe("sourceClassToken", () => {
	it("prefixes the id and keeps legal identifier bytes", () => {
		expect(sourceClassToken("linear")).toBe("src-linear");
		expect(sourceClassToken("zoom-meeting")).toBe("src-zoom-meeting");
	});

	it("collapses every byte that would break the generated selector", () => {
		// A space would end the token and inject a second class; `.` / `#` would
		// break the rule the CSS generators emit for this id.
		expect(sourceClassToken("my source")).toBe("src-my-source");
		expect(sourceClassToken("a.b#c")).toBe("src-a-b-c");
	});
});

describe("SOURCE_TITLES", () => {
	it("derives one label per table entry", () => {
		expect(Object.keys(SOURCE_TITLES).sort()).toEqual(Object.keys(SOURCE_META).sort());
		expect(SOURCE_TITLES.monday).toBe("monday.com");
	});
});
