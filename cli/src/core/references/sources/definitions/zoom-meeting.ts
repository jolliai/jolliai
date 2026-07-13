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
 *
 * Codex: the `codex_apps/zoom` connector's `_get_meeting_assets` returns a payload
 * with the identical shape (verified against a real 2026-07-13 rollout —
 * meeting_uuid / topic / start_time / meeting_number / deep_url /
 * meeting_summary.{summary_markdown,summary_doc_url} all present), so this same
 * DSL reads it verbatim via an identity `CodexZoomMeetingBinding`. Enumeration
 * tools (`_search_meetings`, `_recordings_list`) and `_get_recording_resource`
 * are omitted from the match — allow-list semantics mean they never match. Note
 * that the real `_get_meeting_assets` `function_call_output` is frequently
 * malformed JSON (a bad escape mid-transcript on long meetings); extraction then
 * succeeds through the parser's `mcp_tool_call_end` fallback, whose event carries
 * a complete, valid copy (unlike Jira, it already holds the URL — no `recover`).
 */

import type { SourceDefinition } from "../../SourceDefinition.js";

export const zoomMeetingDefinition: SourceDefinition = {
	id: "zoom-meeting",
	label: "Zoom Meeting",
	icon: "device-camera-video",
	match: {
		claude: { prefixes: ["mcp__claude_ai_Zoom_for_Claude__"], acceptSuffix: "get_meeting_assets" },
		codex: {
			namespaceSuffix: "zoom",
			functionCallNames: ["_get_meeting_assets"],
			invocationTools: ["zoom.get_meeting_assets"],
		},
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
