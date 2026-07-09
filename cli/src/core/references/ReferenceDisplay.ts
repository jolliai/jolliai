/**
 * Reference-label display policy — shared by every surface that renders a
 * reference row / bullet (VS Code Plans tree + hover card, committed-memory
 * HTML, PR / clipboard markdown).
 *
 * A label reads `<nativeId> — <title>` ONLY when the nativeId is an identifier
 * a user recognizes at a glance: the issue keys of the ticket trackers
 * (Linear `PROJ-1234`, Jira `KAN-5`, GitHub `owner/repo#42`). Every other
 * source's nativeId is a machine id — a Notion 32-hex page id, a Slack
 * `<channel>-<ts>`, or any phase-2 config-registered source — so its label
 * leads with the title alone. The default is title-only; the three trackers
 * opt in, so a new source needs no change here to render sensibly.
 */
import { getRegistry } from "./SourceDefinitionRegistry.js";

const NATIVE_ID_TRACKER_SOURCES: ReadonlySet<string> = new Set(["linear", "jira", "github"]);

/** True when a reference label should lead with `<nativeId> — ` before its title. */
export function labelLeadsWithNativeId(source: string): boolean {
	return NATIVE_ID_TRACKER_SOURCES.has(source);
}

/**
 * Human display name for a reference source (`Linear`, `GitHub`, …), read from
 * the source's registered {@link SourceDefinition.label} — the single place the
 * name is defined, so built-in and phase-2 config sources both resolve with no
 * per-source code here. Used to prefix the pushed article title so it's
 * recognizable in the Space tree AND its slug lands in a source-scoped
 * namespace (a `reference` never collides with a same-titled plan/note/summary).
 * Falls back to a capitalized `source` only for an unregistered id (defensive —
 * stored references always carry a registered source).
 */
export function referenceSourceLabel(source: string): string {
	const label = getRegistry().byId(source)?.label;
	if (label !== undefined) return label;
	return source ? source.charAt(0).toUpperCase() + source.slice(1) : source;
}

/** The minimal shape {@link referenceDisplayTitle} reads — satisfied by both the cli `Reference`/`ReferenceCommitRef` and the vscode `ReferenceInfo`. */
export interface DisplayableReference {
	readonly source: string;
	readonly nativeId: string;
	readonly title: string;
}

/**
 * The reference's row / bullet / label display title. This is the SINGLE home
 * for both the decision (does the label lead with the nativeId?) AND the
 * composition (`<nativeId> — <title>`), so no display site re-implements
 * either — a caller passes the reference and applies only its own escaping
 * (Markdown / HTML / raw) to the returned string.
 */
export function referenceDisplayTitle(reference: DisplayableReference): string {
	return labelLeadsWithNativeId(reference.source) ? `${reference.nativeId} — ${reference.title}` : reference.title;
}
