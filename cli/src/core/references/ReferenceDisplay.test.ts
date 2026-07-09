import { describe, expect, it } from "vitest";
import { labelLeadsWithNativeId, referenceDisplayTitle } from "./ReferenceDisplay.js";

describe("labelLeadsWithNativeId", () => {
	it("leads with the nativeId for the issue trackers (recognizable keys)", () => {
		for (const s of ["linear", "jira", "github"]) expect(labelLeadsWithNativeId(s)).toBe(true);
	});
	it("is title-only for machine-id sources (notion, slack) and any unknown/phase-2 source", () => {
		for (const s of ["notion", "slack", "zoom", "phase2-custom", ""]) expect(labelLeadsWithNativeId(s)).toBe(false);
	});
});

describe("referenceDisplayTitle", () => {
	it("composes `<nativeId> — <title>` for the issue trackers", () => {
		expect(referenceDisplayTitle({ source: "linear", nativeId: "ENG-1", title: "Fix" })).toBe("ENG-1 — Fix");
		expect(referenceDisplayTitle({ source: "github", nativeId: "o/r#4", title: "Bug" })).toBe("o/r#4 — Bug");
	});
	it("returns the title alone for machine-id and unknown sources", () => {
		expect(referenceDisplayTitle({ source: "slack", nativeId: "C1-1700000000.1", title: "Thread" })).toBe("Thread");
		expect(referenceDisplayTitle({ source: "notion", nativeId: "abcdef12", title: "Page" })).toBe("Page");
		expect(referenceDisplayTitle({ source: "zoom", nativeId: "z1", title: "Recording" })).toBe("Recording");
	});
});
