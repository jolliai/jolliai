/**
 * SourceLabels
 *
 * Single source of truth for display labels keyed by `SourceId`. Used in
 * webview HTML (reference row source label), host-side confirm dialogs/toasts,
 * and the sidebar hover card's "Open in <Source>" link.
 *
 * Keep in lockstep with the `SourceId` union in `cli/src/Types.ts`.
 */

import type { SourceId } from "../../../cli/src/Types.js";

/** Display labels per reference source. */
export const SOURCE_TITLES: Record<SourceId, string> = {
	linear: "Linear",
	jira: "Jira",
	github: "GitHub",
	notion: "Notion",
};
