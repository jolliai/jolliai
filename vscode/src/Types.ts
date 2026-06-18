/**
 * VSCode Extension Types
 *
 * Extension-specific types for the JolliMemory VSCode plugin.
 * These complement (not replace) the types from the jollimemory core package.
 */

/** Status of a single file in the working tree, parsed from git status */
export interface FileStatus {
	/** Absolute path to the file */
	readonly absolutePath: string;
	/** Path relative to workspace root */
	readonly relativePath: string;
	/** Primary display status letter: M=modified, A=added, D=deleted, R=renamed, ?=untracked.
	 *  Prefers the index status when meaningful, otherwise the worktree status.
	 *  Kept for backward compatibility — existing consumers use this for display/diff logic. */
	readonly statusCode: string;
	/** Git index (staged) column from porcelain v1: ' '=unchanged, M/A/D/R/C, '?'=untracked */
	readonly indexStatus: string;
	/** Git worktree column from porcelain v1: ' '=unchanged, M/D, '?'=untracked */
	readonly worktreeStatus: string;
	/** Original path before rename/copy (only set when indexStatus is 'R' or 'C') */
	readonly originalPath?: string;
	/** Whether the file is currently selected (checked) in the tree view.
	 *  UI-only state — the git index is not modified until commit time. */
	readonly isSelected: boolean;
}

/** A file changed in a specific commit, parsed from git diff-tree */
export interface CommitFileInfo {
	/** Path relative to workspace root (for renames, this is the new/destination path) */
	readonly relativePath: string;
	/** Git status letter: M=modified, A=added, D=deleted, R=renamed */
	readonly statusCode: string;
	/** Original path before rename (only set when statusCode is "R") */
	readonly oldPath?: string;
}

/** A single commit on the current branch (not in main) */
export interface BranchCommit {
	readonly hash: string;
	/** Short (8-char) hash for display */
	readonly shortHash: string;
	readonly message: string;
	/** Author display name */
	readonly author: string;
	/** Author email address */
	readonly authorEmail: string;
	/** ISO 8601 date string */
	readonly date: string;
	/** Short date for display (e.g. "02-25") */
	readonly shortDate: string;
	/** Number of JolliMemory topics in the summary (0 if no summary exists) */
	readonly topicCount: number;
	/** diff stats (+insertions / -deletions) */
	readonly insertions: number;
	readonly deletions: number;
	/** Number of files changed in this commit */
	readonly filesChanged: number;
	/** Whether this commit has already been pushed to the remote */
	readonly isPushed: boolean;
	/** Whether this commit has a JolliMemory summary in the orphan branch */
	readonly hasSummary: boolean;
	/** How this commit was created — only set when non-default (i.e. not "commit") */
	readonly commitType?: string;
}

/**
 * Whether amending HEAD is safe, used to gate the Amend actions of the
 * "Commit Memory" QuickPick. Amend rewrites HEAD in place — on a branch with
 * no commits of its own, or whose tip was authored by someone else, that
 * silently rewrites a commit shared with the base branch (keeping the original
 * author) and inherits its memory onto the new hash.
 */
export interface AmendSafety {
	/** HEAD has commits beyond the merge-base with the base branch (own work on this branch). */
	readonly hasOwnCommits: boolean;
	/** HEAD commit's author email matches the current git `user.email`. */
	readonly headAuthoredByCurrentUser: boolean;
}

/** Result from listBranchCommits, includes merged-state metadata */
export interface BranchCommitsResult {
	/** The commits found on this branch */
	readonly commits: ReadonlyArray<BranchCommit>;
	/** True when the branch is fully merged into main (read-only history view) */
	readonly isMerged: boolean;
}

/** A Claude Code plan file detected from active session transcripts */
export interface PlanInfo {
	/** Plan slug (e.g. "abstract-jumping-church") — primary key */
	readonly slug: string;
	/** Plan filename (e.g. "abstract-jumping-church.md") */
	readonly filename: string;
	/** Editable file path: uncommitted → ~/.claude/plans/<slug>.md; committed → .jolli/jollimemory/plans/<slug>.md */
	readonly filePath: string;
	/** First # heading from the markdown file */
	readonly title: string;
	/** ISO 8601 — file mtime (uncommitted) or commit date (committed) */
	readonly lastModified: string;
	/** ISO 8601 — when this plan was first discovered */
	readonly addedAt: string;
	/** ISO 8601 — when this plan was last modified */
	readonly updatedAt: string;
	/** Commit hash if plan is associated with a commit, null if unassociated */
	readonly commitHash: string | null;
}

/** Persisted plan entry in plans.json registry */
export interface PlanEntry {
	readonly slug: string;
	readonly title: string;
	readonly sourcePath: string;
	readonly addedAt: string;
	readonly updatedAt: string;
	readonly commitHash: string | null;
	/** SHA-256 hash of the plan file content when associated with a commit. Used as a guard to detect if the file was overwritten with new content. */
	readonly contentHashAtCommit?: string;
}

// ─── Note types ─────────────────────────────────────────────────────────────

// Re-export core note types to avoid duplication
export type { NoteEntry, NoteFormat } from "../../cli/src/Types.js";

// ─── Multi-source reference types ───────────────────────────────────────────

// Re-export core reference types to avoid duplication
export type {
	PlansRegistry,
	Reference,
	ReferenceCommitRef,
	ReferenceEntry,
	ReferenceField,
	SourceId,
} from "../../cli/src/Types.js";

// Import for use in NoteInfo / ReferenceInfo
import type {
	NoteFormat,
	ReferenceField,
	SourceId,
} from "../../cli/src/Types.js";

/** Display-level note metadata for the VSCode tree view */
export interface NoteInfo {
	readonly id: string;
	readonly title: string;
	readonly format: NoteFormat;
	/** ISO 8601 — file mtime (markdown) or updatedAt (snippet) */
	readonly lastModified: string;
	readonly addedAt: string;
	readonly updatedAt: string;
	readonly commitHash: string | null;
	/** Filename (e.g. "my-note.md") */
	readonly filename?: string;
	/** Absolute file path */
	readonly filePath?: string;
}

/**
 * Display-level multi-source reference metadata for the VSCode panel.
 *
 * Extends `ReferenceEntry` (the persisted registry row) with panel-display
 * fields read from the on-disk markdown frontmatter (status / priority /
 * labels / description preview) plus `mapKey` (the registry key,
 * `<source>:<nativeId>`) and a stable `lastModified` field (= updatedAt) for
 * sort consistency with PlanInfo / NoteInfo.
 */
export interface ReferenceInfo {
	readonly kind: "reference";
	readonly source: SourceId;
	/** Stable native id (Linear ticket id, Jira key, owner/repo#number, 32-hex Notion page id). */
	readonly nativeId: string;
	/** plans.json.references map key — `<source>:<nativeId>`. */
	readonly mapKey: string;
	readonly title: string;
	readonly url: string;
	readonly sourcePath: string;
	/** Opaque, source-specific display fields (built by the adapter). */
	readonly fields?: ReadonlyArray<ReferenceField>;
	readonly description?: string;
	readonly addedAt: string;
	readonly updatedAt: string;
	/** ISO 8601 — same as updatedAt for sort consistency with PlanInfo / NoteInfo. */
	readonly lastModified: string;
	readonly sourceToolName: string;
}
