/**
 * Zoom meeting built-in source — pure-DSL over the get_meeting_assets result.
 *
 * The payload is a single meeting object (not a list), so wrapperKeys is empty
 * and walkPayload runs extractRef on the top-level object directly. Self-contained:
 * meeting_uuid / topic / summary_doc_url are all in the result, so no normalize
 * and no tool_use.input is needed (contrast zoom-doc).
 *
 * Guard: require a non-empty meeting_summary.summary_markdown — a meeting with no
 * AI summary voids rather than producing an empty-bodied reference.
 * url: prefer the summary doc; fall back to the always-present deep_url.
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const zoomMeetingDefinition: SourceDefinition = {
	id: "zoom-meeting",
	label: "Zoom Meeting",
	icon: "device-camera-video",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Zoom_for_Claude__"], acceptSuffix: "get_meeting_assets" },
	},
	wrapperKeys: [],
	reference: {
		guard: { pipe: [{ op: "path", path: "meeting_summary.summary_markdown" }], require: ".+" },
		nativeId: { pipe: [{ op: "path", path: "meeting_uuid" }], require: "^[\\w-]+$" },
		title: { pipe: [{ op: "path", path: "topic" }], require: ".+" },
		url: {
			pipe: [
				{
					op: "coalesce",
					of: [[{ op: "path", path: "meeting_summary.summary_doc_url" }], [{ op: "path", path: "deep_url" }]],
				},
			],
			require: "^https://",
		},
		description: { pipe: [{ op: "path", path: "meeting_summary.summary_markdown" }], optional: true },
	},
	fields: [
		{ key: "entity-type", label: "Type", icon: "symbol-class", pipe: [{ op: "const", value: "meeting" }] },
		{ key: "started", label: "Started", icon: "calendar", pipe: [{ op: "path", path: "start_time" }] },
		{
			key: "meeting-number",
			label: "Meeting #",
			icon: "symbol-number",
			pipe: [{ op: "path", path: "meeting_number" }],
		},
	],
	storage: { nativeIdPathSafe: true },
	render: {
		wrapperTag: "zoom-meetings",
		itemTag: "meeting",
		bodyTag: "summary",
		maxCharsPerReference: 20000,
		maxTotalChars: 40000,
	},
};
