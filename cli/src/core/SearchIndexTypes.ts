/**
 * Shared types + constants for the local full-text search index (JOLLI-1226 P0).
 * Pure module: no runtime behavior, no I/O.
 */

/** Bump when the document shape or Orama schema changes — forces a rebuild. */
export const SEARCH_SCHEMA_VERSION = 2 as const;

/** A single indexed document. Topics and commits share one flat shape. */
export interface SearchDoc {
	/** "topic:<stableSlug>" | "commit:<fullHash>" — also the Orama document id. */
	readonly id: string;
	readonly type: "topic" | "commit";
	readonly title: string;
	/** Full searchable body. */
	readonly content: string;
	/** Joined decision text; "" when none. */
	readonly decisions: string;
	/**
	 * commit: `[branch]`; topic: relatedBranches. An `enum[]` field so a branch
	 * filter is an EXACT-membership match in the index (`containsAll: [want]`),
	 * not a tokenized `where` over a joined string — the latter both leaks across
	 * slash-siblings (shared `feature` token) and, when post-filtered against an
	 * over-fetched top-N, silently drops rare-branch hits that fall outside it.
	 * Mutable element type (not `readonly string[]`) to satisfy Orama's insert
	 * signature for an `enum[]` field.
	 */
	readonly branch: string[];
	/** commit: source kind ("commit"); topic: dominant sourceRef type. */
	readonly category: string;
	/** ISO 8601. commit: commitDate; topic: lastUpdatedAt. */
	readonly commitDate: string;
	/** Topic stableSlug, else "". */
	readonly slug: string;
	/** Commit fullHash, else "". */
	readonly hash: string;
}

/**
 * Orama schema literal. Full-text fields are `"string"` (tokenized + BM25);
 * `branch` is `"enum[]"` so it filters by exact set membership rather than token
 * match (see {@link SearchDoc.branch}).
 */
export const SEARCH_SCHEMA = {
	id: "string",
	type: "string",
	title: "string",
	content: "string",
	decisions: "string",
	branch: "enum[]",
	category: "string",
	commitDate: "string",
	slug: "string",
	hash: "string",
} as const;

/** Sidecar manifest persisted next to the index file. */
export interface IndexManifest {
	readonly schemaVersion: number;
	/** Output of computeSourceSignature() at persist time. */
	readonly sourceSignature: string;
	readonly savedAt: string;
}
