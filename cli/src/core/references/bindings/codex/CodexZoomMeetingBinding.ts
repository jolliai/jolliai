/**
 * CodexZoomMeetingBinding — Zoom `codex_apps` connector normalizer.
 *
 * Reached through `_get_meeting_assets` / `zoom.get_meeting_assets` (match
 * identity lives in the registry). Verified live (2026-07-13 rollout): the
 * business payload is a single meeting object with the SAME shape the Claude
 * `get_meeting_assets` result has — `meeting_uuid`, `topic`, `start_time`,
 * `meeting_number`, `deep_url`, and `meeting_summary.{summary_markdown,
 * summary_doc_url}` — all read directly by the `zoom-meeting` SourceDefinition.
 * No reshaping is required → identity normalize.
 *
 * The connector's `_search_meetings` / `_recordings_list` (enumeration) and
 * `_get_recording_resource` tools are intentionally NOT recognized: a
 * search/list result carries many meetings the user is not working on, and
 * `_get_recording_resource` returns a recording asset, not a meeting object.
 *
 * No `recover`: on long meetings the `function_call_output` copy is often
 * malformed JSON, but the paired `mcp_tool_call_end` event carries a complete,
 * valid payload that already includes the URLs — so the parser's plain fallback
 * suffices (contrast `CodexJiraBinding`, whose event lacks the tenant `webUrl`).
 */

import type { CodexNormalizer } from "./CodexBinding.js";

export const zoomMeetingCodexBinding: CodexNormalizer = {
	id: "zoom-meeting",
	canonicalToolName: "mcp__claude_ai_Zoom_for_Claude__get_meeting_assets",
	normalize: (business) => business,
};
