/**
 * SourceHeadline — the single source of truth for the one-line headline shape
 * the route classifier consumes. The route prompt joins headlines as
 * `[i] …`.join("\n") and maps the ordinal back to the source, so every
 * branch-bearing source type (summary / plan / note) MUST emit the identical
 * `(type, branch, timestamp) title` layout. Centralised here so a future tweak
 * can't drift one call site and silently degrade the route ordinal mapping.
 *
 * (Userfiles use a distinct branchless shape and format their headline inline.)
 */
export function formatSourceHeadline(type: string, branch: string, timestamp: string, title: string): string {
	return `(${type}, ${branch}, ${timestamp}) ${title}`;
}
