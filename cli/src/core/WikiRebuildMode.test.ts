import { describe, expect, it } from "vitest";
import { wikiRebuildIsAuto } from "./WikiRebuildMode.js";

describe("wikiRebuildIsAuto", () => {
	it("is false when the key is absent (default = manual)", () => {
		expect(wikiRebuildIsAuto({})).toBe(false);
		expect(wikiRebuildIsAuto({ wikiRebuild: undefined })).toBe(false);
	});

	it("is false when explicitly manual", () => {
		expect(wikiRebuildIsAuto({ wikiRebuild: "manual" })).toBe(false);
	});

	it("is true only when explicitly auto", () => {
		expect(wikiRebuildIsAuto({ wikiRebuild: "auto" })).toBe(true);
	});
});
