/**
 * CreatePrDiffContentProvider
 *
 * Serves the two sides of the Create-PR per-file diff. Each URI (see
 * {@link buildPrDiffUri}) encodes a git ref + repo-relative path; the content
 * is `git show <ref>:<path>` resolved through the injected reader, which
 * returns "" when the path did not exist at that ref (added file → empty base
 * side, deleted file → empty HEAD side).
 *
 * The documents are read-only: the scheme has no `FileSystemProvider`, so VS
 * Code renders them non-editable — correct for a `base..HEAD` PR diff that
 * mirrors committed history rather than the working tree.
 */

import type * as vscode from "vscode";
import { parsePrDiffUri } from "./CreatePrDiffUri.js";

export class CreatePrDiffContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly readFileAtRef: (ref: string, relPath: string) => Promise<string>) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const { relPath, ref } = parsePrDiffUri(uri);
		// A malformed URI (missing ref or path) yields an empty document rather
		// than a git invocation on garbage input.
		if (!ref || !relPath) return "";
		return this.readFileAtRef(ref, relPath);
	}
}
