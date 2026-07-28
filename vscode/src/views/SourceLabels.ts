/**
 * SourceLabels
 *
 * Single source of truth for display metadata keyed by `KnownSourceId`
 * (label, badge letter, tree/hover codicon, badge color). Consolidates what
 * used to be four independently hard-coded letter switches / icon branches /
 * CSS color rules scattered across the sidebar, Next Memory panel, committed-
 * memory HTML, and the Plans tree — adding a fifth source is now a single
 * entry in `SOURCE_META` instead of a multi-file hunt.
 *
 * Used in webview HTML (reference row source label/badge), host-side confirm
 * dialogs/toasts, the sidebar hover card's "Open in <Source>" link, and the
 * Plans tree's per-reference codicon.
 *
 * Keep in lockstep with the `KnownSourceId` union in `cli/src/Types.ts`. A
 * `SourceId` outside this table (phase-2 config-registered source) falls back
 * to {@link getSourceMeta}'s neutral defaults rather than being an error.
 */

import type { KnownSourceId, SourceId } from "../../../cli/src/Types.js";

/** Display metadata for one reference source: label, badge letter, codicon id, badge color. */
export interface SourceMeta {
	readonly label: string;
	readonly letter: string;
	readonly icon: string;
	readonly color: string;
}

/**
 * Metadata for the seven built-in sources. Colors match the prior per-file
 * `.mem-ctx-badge--<source>` CSS rules byte-for-byte; letters match the prior
 * per-file switch statements, with one intentional normalization: the
 * hover-card badge previously showed 'GH' for GitHub while every other call
 * site showed 'G' — this table standardizes on 'G' everywhere. `slack`'s
 * color is Slack's official aubergine brand hue; the icon mirrors the
 * `comment-discussion` codicon used by the CLI's `slackDefinition.icon`
 * (references/sources/definitions/slack.ts) so the two stay in visual lockstep.
 */
export const SOURCE_META: Record<KnownSourceId, SourceMeta> = {
	linear: { label: "Linear", letter: "L", icon: "issues", color: "#5e6ad2" },
	confluence: { label: "Confluence", letter: "C", icon: "book", color: "#1868DB" },
	jira: { label: "Jira", letter: "J", icon: "issues", color: "#0052cc" },
	github: { label: "GitHub", letter: "G", icon: "issues", color: "#6e7681" },
	notion: { label: "Notion", letter: "N", icon: "file-text", color: "#787774" },
	slack: { label: "Slack", letter: "S", icon: "comment-discussion", color: "#4a154b" },
	"zoom-meeting": { label: "Zoom Meeting", letter: "Z", icon: "device-camera-video", color: "#2D8CFF" },
	"zoom-doc": { label: "Zoom Doc", letter: "Z", icon: "file", color: "#2D8CFF" },
	asana: { label: "Asana", letter: "A", icon: "checklist", color: "#f06a6a" },
	monday: { label: "monday.com", letter: "M", icon: "table", color: "#ff3d57" },
	context7: { label: "Context7", letter: "7", icon: "book", color: "#0b7285" },
	// Jolli's own memory — `#9B5CFF` is the primary from `vscode/assets/icon.svg`. The
	// letter collides with Jira's, as zoom-meeting/zoom-doc already collide on Z; the
	// badge colors differ, and Jolli is the first-party brand here.
	jollimemory: { label: "Jolli Memory", letter: "J", icon: "history", color: "#9B5CFF" },
};

/**
 * Neutral badge color for a source outside {@link SOURCE_META}.
 *
 * Exported because it must be the SAME hue in three places, and the agreement
 * used to rest on a comment: this constant (used by {@link getSourceMeta}'s
 * fallback), and the `.mem-ctx-badge--reference` rule in both
 * `SidebarCssBuilder` and `NextMemoryCssBuilder`. Both webviews' `ctxBadge`
 * routes an unknown source to that CSS class — its per-source siblings are
 * generated from `SOURCE_META`, so an unknown id matches no rule — which makes
 * this the actual rendered fallback color. Import it rather than re-typing the
 * literal so the three stay locked together.
 */
export const NEUTRAL_SOURCE_COLOR = "#6e7681";

/**
 * The per-source CSS class token for a source id: `src-<id>`, with every byte
 * outside `[A-Za-z0-9_-]` collapsed to `-`.
 *
 * A source id is a plain string from disk, not a closed enum, so it can in
 * principle carry a byte that is not a legal CSS identifier — a space would end the
 * token and inject a second class, a `.` or `#` would break the generated selector.
 * The generated rules and every consumer both go through here, so a sanitized id
 * still lands on its own rule and an id with no rule keeps the kind marker's
 * neutral hue (which is the correct outcome for an unknown source anyway).
 */
export function sourceClassToken(id: string): string {
	return `src-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * Resolves display metadata for any `SourceId`, falling back to a derived
 * letter/neutral icon/color for ids not in {@link SOURCE_META} (a phase-2
 * config-registered source not yet given bespoke metadata).
 */
export function getSourceMeta(id: SourceId): SourceMeta {
	// `Object.hasOwn`, not a truthy lookup: with `SourceId` widened to `string`,
	// an id like `"toString"`/`"constructor"` would otherwise resolve to an
	// inherited `Object.prototype` member and be returned as a bogus SourceMeta
	// (label/letter `undefined`). Own-property check keeps the fallback exhaustive.
	if (Object.hasOwn(SOURCE_META, id)) return (SOURCE_META as Record<string, SourceMeta>)[id];
	return { label: id, letter: id.slice(0, 1).toUpperCase(), icon: "link", color: NEUTRAL_SOURCE_COLOR };
}

/**
 * Display labels per reference source, derived from {@link SOURCE_META} for
 * back-compat with existing call sites. Typed `Record<SourceId, string>`
 * (`SourceId` = `string`) rather than `Record<KnownSourceId, string>` so
 * indexing with an arbitrary `SourceId` value (e.g. `SOURCE_TITLES[e.source]`)
 * still type-checks without a cast; unknown ids simply index to `undefined`.
 */
export const SOURCE_TITLES: Record<SourceId, string> = Object.fromEntries(
	Object.entries(SOURCE_META).map(([id, meta]) => [id, meta.label]),
);
