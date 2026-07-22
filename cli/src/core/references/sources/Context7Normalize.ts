/**
 * context7 is an arguments-derived source: the referenced library (`libraryId`,
 * e.g. `/vercel/next.js`) and the topic (`query`) live in the `query-docs` tool
 * ARGUMENTS. The result is markdown prose and is ignored. This reshaper turns the
 * tool input into the flat object the `context7Definition` reads via `path` ops,
 * and is shared by both the Claude context-normalizer and the Codex binding.
 */
import { isObject } from "../guards.js";

function readString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Build the context7 reference shape from the query-docs arguments. Returns null
 *  (voiding the reference) when `libraryId` is absent/non-string. A malformed-but-
 *  present id is left for the definition's `require` regex to void. */
export function normalizeContext7(toolInput: unknown): { libraryId: string; query?: string } | null {
	if (!isObject(toolInput)) return null;
	const libraryId = readString(toolInput.libraryId);
	if (libraryId === undefined) return null;
	const query = readString(toolInput.query);
	return { libraryId, ...(query !== undefined ? { query } : {}) };
}
