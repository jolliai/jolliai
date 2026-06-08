import { describe, expect, it } from "vitest";
import type { Reference, SourceId } from "../../../Types.js";
import type { SourceAdapter } from "./SourceAdapter.js";

describe("SourceAdapter type contract", () => {
	it("requires id, wrapperKeys, maxCharsPerReference, extractRef, renderPromptBlock", () => {
		const dummy: SourceAdapter = {
			id: "linear" satisfies SourceId,
			wrapperKeys: [],
			maxCharsPerReference: 100,
			extractRef: () => null,
			renderPromptBlock: () => "",
		};
		expect(dummy.id).toBe("linear");
		expect(dummy.wrapperKeys).toEqual([]);
		expect(dummy.maxCharsPerReference).toBe(100);
		expect(dummy.extractRef({}, "tool", "2026-05-26T00:00:00Z")).toBeNull();
		expect(dummy.renderPromptBlock([])).toBe("");
	});

	it("Reference requires mapKey, source, nativeId, title, url, toolName, referencedAt", () => {
		const ref: Reference = {
			mapKey: "linear:PROJ-1",
			source: "linear",
			nativeId: "PROJ-1",
			title: "Sample",
			url: "https://linear.app/x/issue/PROJ-1",
			toolName: "mcp__linear__get_issue",
			referencedAt: "2026-05-26T00:00:00Z",
		};
		expect(ref.mapKey).toBe("linear:PROJ-1");
		expect(ref.source).toBe("linear");
	});

	it("SourceId admits the four known sources", () => {
		const sources: ReadonlyArray<SourceId> = ["linear", "jira", "github", "notion"];
		expect(sources).toHaveLength(4);
	});
});
