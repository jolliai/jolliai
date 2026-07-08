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
 * Metadata for the four built-in sources. Colors match the prior per-file
 * `.mem-ctx-badge--<source>` CSS rules byte-for-byte; letters match the prior
 * per-file switch statements, with one intentional normalization: the
 * hover-card badge previously showed 'GH' for GitHub while every other call
 * site showed 'G' — this table standardizes on 'G' everywhere.
 */
export const SOURCE_META: Record<KnownSourceId, SourceMeta> = {
	linear: { label: "Linear", letter: "L", icon: "issues", color: "#5e6ad2" },
	jira: { label: "Jira", letter: "J", icon: "issues", color: "#0052cc" },
	github: { label: "GitHub", letter: "G", icon: "issues", color: "#6e7681" },
	notion: { label: "Notion", letter: "N", icon: "file-text", color: "#787774" },
};

/** Neutral badge color for a source outside {@link SOURCE_META} (matches the prior `.mem-ctx-badge--reference` fallback hue). */
const NEUTRAL_SOURCE_COLOR = "#6e7681";

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
