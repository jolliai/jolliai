/**
 * Type-only definitions for the four `.jolli/<aggregate>.json` files and the
 * content-addressed per-commit summary files (JOLLI-1316 §2 schema).
 *
 * The backend's `JolliMemoryAggregateValidator` enforces well-formedness on
 * push; client-side `AggregateMerge` produces values that pass validation.
 * Both ends ship independent implementations of the same schema — keep them
 * in lockstep (see `jolli-1316-aggregate-merge-design.md §6 + §7`).
 *
 * Pure types — no runtime imports — so every consumer (CLI, plugin, future
 * tooling) imports from one source without dragging in a runtime module.
 */

// ── manifest.json ─────────────────────────────────────────────────────────

/**
 * `manifest.json` entry — one row per content file. `fileId` is the primary
 * key; `source.generatedAt` is the merge tiebreaker (§3.1).
 */
export interface ManifestEntry {
	readonly path: string;
	readonly fileId: string;
	readonly type: "commit";
	readonly fingerprint: string;
	readonly title: string;
	readonly source: {
		readonly commitHash: string;
		readonly branch: string;
		readonly generatedAt: string; // ISO8601
	};
}

export interface ManifestEnvelope {
	readonly version: 1;
	readonly files: ReadonlyArray<ManifestEntry>;
}

// ── index.json ────────────────────────────────────────────────────────────

/**
 * `index.json` entry — one row per commit (or amend). Primary key
 * `commitHash`; merge tiebreak uses the 2×2 of `parentCommitHash` × `generatedAt`
 * (§3.2 — null-parent rows always lose to ones with a parent).
 */
export interface IndexEntry {
	readonly commitHash: string;
	readonly parentCommitHash: string | null;
	readonly treeHash: string;
	readonly commitType: "commit" | "amend";
	readonly commitMessage: string;
	readonly commitDate: string; // ISO8601
	readonly branch: string;
	readonly generatedAt: string; // ISO8601
	readonly topicCount?: number;
	readonly diffStats?: {
		readonly filesChanged: number;
		readonly insertions: number;
		readonly deletions: number;
	};
}

export interface IndexEnvelope {
	readonly version: 3;
	readonly entries: ReadonlyArray<IndexEntry>;
}

// ── branches.json ─────────────────────────────────────────────────────────

/**
 * `branches.json` entry — one row per branch → folder mapping. Primary key
 * `branch`; no tiebreak (last-write-wins is fine because the
 * `folder === canonical(branch)` invariant is enforced at write time, so any
 * two valid entries for the same branch are identical save for `createdAt`).
 */
export interface BranchEntry {
	readonly folder: string;
	readonly branch: string;
	readonly createdAt: string; // ISO8601
}

export interface BranchesEnvelope {
	readonly version: 1;
	readonly mappings: ReadonlyArray<BranchEntry>;
}

// ── catalog.json ──────────────────────────────────────────────────────────

/**
 * `catalog.json` entry — long-form recap + topic breakdown per commit.
 * Primary key `commitHash`; no tiebreak (§3.4 — both sides produced the
 * same content for a given commit, so identity suffices).
 */
export interface CatalogTopic {
	readonly title: string;
	readonly decisions: string;
	readonly category: string;
	readonly importance: string;
	readonly filesAffected: ReadonlyArray<string>;
}

export interface CatalogEntry {
	readonly commitHash: string;
	readonly recap: string;
	readonly ticketId: string;
	readonly topics: ReadonlyArray<CatalogTopic>;
}

export interface CatalogEnvelope {
	readonly version: 1;
	readonly entries: ReadonlyArray<CatalogEntry>;
}

// ── summaries/<commitHash>.json ───────────────────────────────────────────

/**
 * Content-addressed per-commit summary. Filename hash MUST equal the embedded
 * `commitHash` (backend validator rejects mismatches). No merge — git default
 * is fine because identical filenames carry identical content.
 *
 * The plugin doesn't dictate the body shape beyond `commitHash`; downstream
 * consumers (web UI, analytics) interpret remaining fields. Keep this loose
 * so summary generators on different branches don't have to agree.
 */
export interface SummaryFile {
	readonly commitHash: string;
	readonly [k: string]: unknown;
}
