import { describe, expect, it } from "vitest";
import { extractRef, renderBlock } from "../../SourceEngine.js";
import { zoomMeetingDefinition as def } from "./zoom-meeting.js";

// Trimmed from the real 2026-07-08 get_meeting_assets payload (design spec §6).
const REAL_PAYLOAD = {
	meeting_summary: {
		summary_markdown: "## Quick recap\nFlyer and Joe updated a GitHub app slug.\n## Next steps\n- Verify dev.",
		summary_plain_text: "Quick recap ...",
		has_permission: true,
		has_summary: true,
		summary_doc_url: "https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA",
	},
	meeting_transcript: {
		transcript_items: [{ start: "00:00:50.000", text: "hi", end: "00:00:52.000" }],
		primary_language: "en",
	},
	my_notes: { has_my_notes: false },
	meeting_number: 4456640966,
	deep_url: "https://jolli.zoom.us/launch/edl?muid=1764e7b0-e935-4084-8e29-ce48ab11ab1c",
	start_time: "2026-06-16T02:19:12Z",
	end_time: "2026-06-16T02:26:41Z",
	meeting_uuid: "25955010-93C3-48E7-9F25-9D98CE6B69F7",
	topic: "Flyer Li's Personal Meeting Room",
	meeting_category: "history",
};
const TOOL = "mcp__claude_ai_Zoom_for_Claude__get_meeting_assets";
const AT = "2026-07-08T00:00:00Z";

describe("zoom-meeting definition", () => {
	it("extracts a Reference from a real get_meeting_assets payload", () => {
		const ref = extractRef(def, REAL_PAYLOAD, TOOL, AT);
		expect(ref).not.toBeNull();
		expect(ref?.source).toBe("zoom-meeting");
		expect(ref?.nativeId).toBe("25955010-93C3-48E7-9F25-9D98CE6B69F7");
		expect(ref?.mapKey).toBe("zoom-meeting:25955010-93C3-48E7-9F25-9D98CE6B69F7");
		expect(ref?.title).toBe("Flyer Li's Personal Meeting Room");
		expect(ref?.url).toBe("https://docs.zoom.us/doc/y_sTD3ZsQv-o-f2pw3IQCA");
		expect(ref?.description).toContain("Quick recap");
		expect(ref?.fields).toEqual([
			{ key: "entity-type", label: "Type", icon: "symbol-class", value: "meeting" },
			{ key: "started", label: "Started", icon: "calendar", value: "2026-06-16T02:19:12Z" },
			{ key: "meeting-number", label: "Meeting #", icon: "symbol-number", value: "4456640966" },
		]);
	});

	it("falls back to deep_url when summary_doc_url is absent", () => {
		const p = { ...REAL_PAYLOAD, meeting_summary: { ...REAL_PAYLOAD.meeting_summary, summary_doc_url: undefined } };
		expect(extractRef(def, p, TOOL, AT)?.url).toBe(REAL_PAYLOAD.deep_url);
	});

	it("voids a meeting with no summary body (guard)", () => {
		const p = { ...REAL_PAYLOAD, meeting_summary: { has_permission: true, has_summary: false } };
		expect(extractRef(def, p, TOOL, AT)).toBeNull();
	});

	it("renders a <zoom-meetings> block", () => {
		const ref = extractRef(def, REAL_PAYLOAD, TOOL, AT);
		if (ref === null) throw new Error("expected ref");
		const xml = renderBlock(def, [ref]);
		expect(xml).toContain("<zoom-meetings>");
		expect(xml).toContain('<meeting id="25955010-93C3-48E7-9F25-9D98CE6B69F7"');
		expect(xml).toContain("<summary>");
		expect(xml).toContain("</zoom-meetings>");
	});
});
