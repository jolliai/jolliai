/**
 * ContextKindRegistry — loads, validates, and answers field access for the
 * built-in {@link AnyContextKind} definitions.
 *
 * Two jobs, both deliberately confined to this module:
 *
 *  1. **Validation at load time**, mirroring `SourceDefinitionRegistry`: a
 *     malformed or duplicate definition throws on first use rather than silently
 *     pushing nothing. A definition is data, so a typo in `field` is otherwise
 *     invisible — `selectItems` would just return an empty array forever.
 *  2. **Field access by name.** The generic push loop has to read and write
 *     properties whose names come from a definition string. All of that
 *     `Record<string, unknown>` narrowing lives here so no caller has to do it,
 *     and so `noExplicitAny` is satisfied with `unknown` throughout.
 */

import type { CommitSummary } from "../../Types.js";
import { REF_HASH_SUFFIX } from "../RefMerge.js";
import {
	type AnyContextKind,
	type ContextBaseKeySpec,
	DEFAULT_DOC_ID_FIELD,
	DEFAULT_DOC_URL_FIELD,
} from "./ContextKindDefinition.js";
import { CONTEXT_KIND_DEFINITIONS } from "./kinds/index.js";

/** Lazily validated registry — see {@link getContextKinds}. */
let validated: ReadonlyArray<AnyContextKind> | undefined;

/**
 * Every registered context kind, in registration order.
 *
 * Order is user-visible: it decides the order attachments are pushed within one
 * summary, so it is preserved from `CONTEXT_KIND_DEFINITIONS` rather than sorted.
 */
export function getContextKinds(): ReadonlyArray<AnyContextKind> {
	if (validated === undefined) {
		validated = validateDefinitions(CONTEXT_KIND_DEFINITIONS);
	}
	return validated;
}

/** Test seam: re-runs validation against a caller-supplied list. Never used in production. */
export function validateContextKindsForTest(definitions: ReadonlyArray<AnyContextKind>): ReadonlyArray<AnyContextKind> {
	return validateDefinitions(definitions);
}

function validateDefinitions(definitions: ReadonlyArray<AnyContextKind>): ReadonlyArray<AnyContextKind> {
	const seen = new Set<string>();
	// Batch clientKeys are `<prefix>-<index>` with the index restarting per kind, so
	// two kinds sharing a prefix would emit the same key twice in one request — the
	// server would map both to one attachment and one URL placeholder would resolve to
	// the wrong article. docType uniqueness alone stopped covering this once the prefix
	// became overridable.
	const seenPrefixes = new Set<string>();
	for (const kind of definitions) {
		const label = kind.docType === "" ? "<empty docType>" : kind.docType;
		if (kind.docType === "") throw new Error("ContextKindDefinition: docType must be a non-empty string");
		if (seen.has(kind.docType)) {
			throw new Error(`ContextKindDefinition: duplicate docType ${JSON.stringify(kind.docType)}`);
		}
		seen.add(kind.docType);
		if (kind.field === "") throw new Error(`ContextKindDefinition ${label}: field must be a non-empty string`);
		if (kind.entryKey === "")
			throw new Error(`ContextKindDefinition ${label}: entryKey must be a non-empty string`);
		if (kind.recency === "") throw new Error(`ContextKindDefinition ${label}: recency must be a non-empty string`);
		if (kind.baseKey.fields.length === 0) {
			throw new Error(`ContextKindDefinition ${label}: baseKey.fields must not be empty`);
		}
		if (kind.clientKeyPrefix === "") {
			throw new Error(`ContextKindDefinition ${label}: clientKeyPrefix must be a non-empty string when set`);
		}
		if (kind.docScope === "summary" && (kind.docIdField === undefined || kind.docUrlField === undefined)) {
			// The defaults are `CommitSummary.jolliDocId` / `jolliDocUrl` — the memory
			// article's OWN fields — so a summary-scoped kind that inherits them would
			// overwrite the memory's published identity with its attachment's. The
			// authoring type already requires both; this covers the erased form.
			throw new Error(
				`ContextKindDefinition ${label}: a summary-scoped kind must override both docIdField and docUrlField`,
			);
		}
		const prefix = clientKeyPrefixOf(kind);
		if (seenPrefixes.has(prefix)) {
			throw new Error(`ContextKindDefinition ${label}: duplicate clientKeyPrefix ${JSON.stringify(prefix)}`);
		}
		seenPrefixes.add(prefix);
	}
	return definitions;
}

/** Batch clientKey prefix, applying the docType default. */
export function clientKeyPrefixOf(kind: AnyContextKind): string {
	return kind.clientKeyPrefix ?? kind.docType;
}

/** Resolved push-state field names, applying the uniform defaults. */
export function docIdFieldOf(kind: AnyContextKind): string {
	return kind.docIdField ?? DEFAULT_DOC_ID_FIELD;
}

export function docUrlFieldOf(kind: AnyContextKind): string {
	return kind.docUrlField ?? DEFAULT_DOC_URL_FIELD;
}

/** True when this kind's published id/URL live on the `CommitSummary` rather than on each item. */
export function isSummaryScoped(kind: AnyContextKind): boolean {
	return kind.docScope === "summary";
}

/**
 * The id/URL a prior push recorded for `item`, read from whichever carrier the
 * kind's `docScope` names.
 *
 * The one accessor every push path uses, so the scope decision is made once. Reading
 * `docIdOf(kind, item)` directly is correct ONLY where the carrier really is the item
 * (the cross-commit winner rule, which a summary-scoped kind does not participate in).
 */
export function storedDocOf(
	kind: AnyContextKind,
	summary: CommitSummary,
	item: unknown,
): { docId?: number; docUrl?: string } {
	const carrier = isSummaryScoped(kind) ? summary : item;
	return { docId: docIdOf(kind, carrier), docUrl: docUrlOf(kind, carrier) };
}

/** Returns a copy of `summary` carrying a summary-scoped kind's published id + URL. */
export function withSummaryDoc(
	kind: AnyContextKind,
	summary: CommitSummary,
	url: string,
	docId: number | undefined,
): CommitSummary {
	return {
		...summary,
		[docUrlFieldOf(kind)]: url,
		// A batch push weaves a placeholder URL before the server has minted an id, so
		// the id stays absent rather than being written as the placeholder string.
		...(docId !== undefined && { [docIdFieldOf(kind)]: docId }),
	} as CommitSummary;
}

/** Whether the summary markdown links these items — drives batch placeholder minting. */
export function linksInMarkdown(kind: AnyContextKind): boolean {
	return kind.linksInMarkdown ?? true;
}

// ─── Field access ────────────────────────────────────────────────────────────

/**
 * Reads one string property off an item, or `""` when absent/non-string.
 *
 * Falling back to `""` rather than throwing is deliberate: these values come from
 * stored JSON that may predate a field (a legacy summary with no `referencedAt`),
 * and an empty string sorts as the oldest under the string comparison the winner
 * rule uses — i.e. "unknown recency loses", which is the conservative outcome.
 */
function readString(item: unknown, field: string): string {
	if (typeof item !== "object" || item === null) return "";
	const value = (item as Record<string, unknown>)[field];
	return typeof value === "string" ? value : "";
}

function readNumber(item: unknown, field: string): number | undefined {
	if (typeof item !== "object" || item === null) return undefined;
	const value = (item as Record<string, unknown>)[field];
	return typeof value === "number" ? value : undefined;
}

/** The item's per-commit entry identity (the URL write-back key). */
export function entryKeyOf(kind: AnyContextKind, item: unknown): string {
	return readString(item, kind.entryKey);
}

/** The item's cross-commit identity — fields joined by `:`, optionally archive-stamp-stripped. */
export function baseKeyOfItem(kind: AnyContextKind, item: unknown): string {
	return joinBaseKey(kind.baseKey, (field) => readString(item, field));
}

function joinBaseKey(spec: ContextBaseKeySpec, read: (field: string) => string): string {
	const parts = spec.fields.map(read);
	const joined = parts.join(":");
	return spec.stripArchiveSuffix === true ? joined.replace(REF_HASH_SUFFIX, "") : joined;
}

/** The item's recency value, compared as a string (newest wins). */
export function recencyOf(kind: AnyContextKind, item: unknown): string {
	return readString(item, kind.recency);
}

/** The item's stored document id from a prior push, if any. */
export function docIdOf(kind: AnyContextKind, item: unknown): number | undefined {
	return readNumber(item, docIdFieldOf(kind));
}

/** The article URL a stored document id was minted with — its origin keys the reuse gate. */
export function docUrlOf(kind: AnyContextKind, item: unknown): string | undefined {
	if (typeof item !== "object" || item === null) return undefined;
	const value = (item as Record<string, unknown>)[docUrlFieldOf(kind)];
	return typeof value === "string" ? value : undefined;
}

/** Returns a copy of `item` carrying the given published document id + URL. */
export function withDoc(kind: AnyContextKind, item: unknown, url: string, docId: number): unknown {
	return { ...(item as Record<string, unknown>), [docUrlFieldOf(kind)]: url, [docIdFieldOf(kind)]: docId };
}

/** Returns a copy of `item` carrying only a document URL (batch placeholder weaving). */
export function withDocUrl(kind: AnyContextKind, item: unknown, url: string): unknown {
	return { ...(item as Record<string, unknown>), [docUrlFieldOf(kind)]: url };
}

/**
 * Returns a copy of `item` carrying the given id/URL pair, used for seed
 * propagation. Kept separate from {@link withDoc} only for readability at the
 * call site; `url` may legitimately be undefined for a legacy id with no
 * recorded minting URL.
 */
export function withSeedDoc(kind: AnyContextKind, item: unknown, docId: number, url: string | undefined): unknown {
	return {
		...(item as Record<string, unknown>),
		[docIdFieldOf(kind)]: docId,
		[docUrlFieldOf(kind)]: url,
	};
}

// ─── Summary array access ────────────────────────────────────────────────────

/** The summary's own items for this kind. Empty when the field is absent or not an array. */
export function selectItems(kind: AnyContextKind, summary: CommitSummary): ReadonlyArray<unknown> {
	const value = (summary as unknown as Record<string, unknown>)[kind.field];
	return Array.isArray(value) ? (value as ReadonlyArray<unknown>) : [];
}

/** True when the summary actually carries this kind's field (distinguishes absent from empty). */
export function hasField(kind: AnyContextKind, summary: CommitSummary): boolean {
	const value = (summary as unknown as Record<string, unknown>)[kind.field];
	return Array.isArray(value);
}

/** Returns a copy of `summary` with this kind's array replaced. */
export function replaceItems(
	kind: AnyContextKind,
	summary: CommitSummary,
	items: ReadonlyArray<unknown>,
): CommitSummary {
	return { ...summary, [kind.field]: items } as CommitSummary;
}
