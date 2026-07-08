/**
 * Shared render helpers for the references layer.
 *
 * `truncate` is the single source of truth for the "…[truncated, N more chars]"
 * cue the LLM sees when a reference body is cut. It lives here — not in
 * ReferenceExtractor or SourceEngine — because both the first-run path
 * (SourceEngine.renderBlock) and the regenerate path (Regenerator, via
 * ReferenceExtractor's re-export) need it, and ReferenceExtractor already
 * imports SourceEngine (a direct import between them would cycle). Keeping the
 * one wire format here means the cue text stays byte-identical across paths.
 */

/**
 * Truncates `s` to `maxChars` and appends a "…[truncated, N more chars]" marker
 * so the LLM sees that data was cut.
 */
export function truncate(s: string, maxChars: number): string {
	if (s.length <= maxChars) return s;
	const remaining = s.length - maxChars;
	return `${s.slice(0, maxChars)}\n…[truncated, ${remaining} more chars]`;
}
