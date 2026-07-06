/**
 * CreatePrDiffUri
 *
 * URI helpers for the Create-PR per-file diff. A row in the "Files changed"
 * list opens a `vscode.diff` of the file at the branch delta base (left) vs
 * HEAD (right); neither side is a file on disk, so both are served by
 * {@link CreatePrDiffContentProvider} under a custom scheme.
 */

import * as vscode from "vscode";

/** Scheme served by CreatePrDiffContentProvider. */
export const PR_DIFF_SCHEME = "jolli-prdiff";

/**
 * Builds a virtual document URI whose content is `<relPath>` as it existed at
 * `<ref>`.
 *
 * The ref rides in the **query**, not the path, on purpose: VS Code caches
 * provided content per-URI, so the base and HEAD documents for the same file
 * must differ by more than a side flag or they'd collapse into one cached
 * document (and both diff panes would show identical text). The repo-relative
 * path stays the last path segment so the diff editor derives a sensible file
 * label and language mode from the extension.
 */
export function buildPrDiffUri(relPath: string, ref: string): vscode.Uri {
	return vscode.Uri.from({
		scheme: PR_DIFF_SCHEME,
		path: `/${relPath}`,
		query: `ref=${encodeURIComponent(ref)}`,
	});
}

/**
 * Decodes a {@link buildPrDiffUri} URI back into its `{ relPath, ref }`. The
 * leading slash added by `buildPrDiffUri` is stripped so the result is the
 * repo-relative path git expects in a `<ref>:<path>` spec.
 */
export function parsePrDiffUri(uri: vscode.Uri): { relPath: string; ref: string } {
	const ref = new URLSearchParams(uri.query).get("ref") ?? "";
	return { relPath: uri.path.replace(/^\/+/, ""), ref };
}
