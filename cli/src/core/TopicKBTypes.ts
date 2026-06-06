/**
 * Topic KB — shared type declarations for the topic-centric knowledge base
 * (sub-project 1). Pure type module: no runtime behavior.
 */

/** The four source streams folded into the knowledge base. */
export type SourceType = "summary" | "plan" | "note" | "userfile";

/** A single ingestable source, identified stably and timestamped for ordering. */
export interface SourceRef {
	readonly type: SourceType;
	/** Stable identity: commit hash / plan slug / note id / `path@fingerprint`. */
	readonly id: string;
	/** ISO 8601; used for chronological ordering (parsed to epoch, may carry tz offset). */
	readonly timestamp: string;
	/**
	 * Originating branch for branch-scoped sources (summary / plan / note). The
	 * authoritative input to a topic page's `relatedBranches` — the LLM's
	 * `---RELATEDBRANCHES---` echo is advisory only. Absent for userfiles (repo /
	 * global knowledge, not branch-scoped) and for refs deserialized from pages
	 * written before this field existed.
	 */
	readonly branch?: string;
}

/** High-water mark = the set of already-ingested source IDs, grouped by type. */
export interface ProcessedSet {
	readonly schemaVersion: 1;
	readonly processed: Record<SourceType, string[]>;
}

/** One entry in `topics/index.json`. Drives index-driven routing (sub-project 2). */
export interface TopicIndexEntry {
	readonly stableSlug: string;
	readonly title: string;
	readonly summary: string;
	readonly relatedBranches: string[];
	readonly sourceRefs: SourceRef[];
	readonly lastUpdatedAt: string;
}

/** `topics/index.json` shape. */
export interface TopicIndex {
	readonly schemaVersion: 1;
	readonly topics: TopicIndexEntry[];
}

/** Canonical topic page (`topics/<stableSlug>.json`). Content filled by sub-project 2. */
export interface TopicPage {
	readonly schemaVersion: 1;
	readonly stableSlug: string;
	readonly title: string;
	readonly content: string;
	readonly relatedBranches: string[];
	readonly sourceRefs: SourceRef[];
	readonly lastUpdatedAt: string;
}
