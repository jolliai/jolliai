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
const NATIVE_ID_TRACKER_SOURCES: ReadonlySet<string> = new Set(["linear", "jira", "github"]);

/** True when a reference label should lead with `<nativeId> — ` before its title. */
export function labelLeadsWithNativeId(source: string): boolean {
	return NATIVE_ID_TRACKER_SOURCES.has(source);
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
