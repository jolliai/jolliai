/**
 * Message protocol between the Sidebar webview client and the extension host.
 *
 * Outbound = client → extension. Inbound = extension → client.
 *
 * The generic `command` outbound is used for all inline buttons / right-click
 * menu actions so we don't have to extend the protocol every time a new
 * jollimemory.* command is added.
 */

import type { ActiveConversationItem } from "../../../cli/src/core/ActiveSessionAggregator.js";
import type { PinEntry, PinKind } from "../../../cli/src/core/PinStore.js";
import type { ReferenceField, SourceId, TranscriptSource } from "../../../cli/src/Types.js";
import type { WorkerPhase } from "../stores/StatusStore.js";

export type SidebarTab = "kb" | "branch" | "status";
export type KbMode = "folders" | "memories";

/**
 * Which commits the back-fill card / Settings list operates on.
 * `recent-month` = own missing commits from the last 30 days (sidebar cold-start
 * default); `all` = every own missing commit (Settings full scope).
 */
export type BackfillScope = "recent-month" | "all";

/**
 * One selectable row in the back-fill candidate list — the dry-run preview of a
 * commit that lacks a summary. `sessions` / `conversationTurns` come from the
 * offline attribution (0 = no conversation found → "仅代码变更"). No confidence
 * or attribution-method fields are surfaced: users care about "how much real
 * conversation backs this commit", not the internal tier.
 */
export interface BackfillCandidate {
	readonly commitHash: string;
	readonly subject: string;
	/** Author time (epoch ms) — relative-date display + newest-first order. */
	readonly ts: number;
	/** Attributed conversations (`attr.sessions.length`; 0 = diff-only). */
	readonly sessions: number;
	/** User-initiated turns across those sessions (`conversationTurns`; 0 = diff-only). */
	readonly conversationTurns: number;
}

/**
 * One row in the completed back-fill result list (the "done" state the candidate
 * list flips into). `topics` is populated post-generation; `status: "error"`
 * rows are rendered with a failure marker.
 */
export interface BackfillResultRow {
	readonly commitHash: string;
	readonly subject: string;
	readonly sessions: number;
	readonly topics: number;
	readonly status: "generated" | "error";
}

/**
 * Why the sidebar can't run its normal flow. Set by activate() in the
 * pre-workspace / pre-git early-return paths so the webview can render a
 * targeted CTA banner (Open Folder / Initialize Git) instead of an empty view.
 */
export type SidebarDegradedReason = "no-workspace" | "no-git";

export interface SidebarState {
	readonly enabled: boolean;
	/**
	 * Whether the user is signed in to Jolli (i.e. config.json has an authToken).
	 * Drives the Sign In vs Sign Out icon swap on the Status tab toolbar. Pushed
	 * after the OAuth callback completes (signIn) and after signOut clears creds.
	 */
	readonly authenticated: boolean;
	/**
	 * Whether the user has provided enough credentials to actually use AI
	 * features — signed in to Jolli OR has supplied an Anthropic API key. Drives
	 * the onboarding panel vs main tabs split: when `false`, the webview shows
	 * the onboarding panel; when `true`, the normal sidebar UI renders. Pushed
	 * via `configured:changed` whenever auth state or the Anthropic key changes.
	 *
	 * Optional because the consumer (`SidebarScriptBuilder`) treats `undefined`
	 * as "not yet known" via `configured !== false` and the HTML default state
	 * shows the main UI — same behavior the host produces by sending
	 * `configured: true` once `currentConfigured` is hydrated.
	 */
	readonly configured?: boolean;
	readonly activeTab: SidebarTab;
	readonly kbMode: KbMode;
	readonly branchName: string;
	readonly detached: boolean;
	/**
	 * Display name of the workspace's repo. Used as the left segment of the
	 * header breadcrumb and as the "home" anchor for the cross-repo dropdown.
	 * Optional during early-init / degraded modes where extractRepoName has not
	 * yet run; the webview falls back to "(workspace)" when undefined.
	 */
	readonly currentRepoName?: string;
	/**
	 * Which repo the user is currently *viewing* through the breadcrumb. When
	 * equal to currentRepoName (or undefined), the sidebar is in normal mode.
	 * When different, the sidebar is in foreign-readonly mode — Plans & Notes
	 * and Changes are hidden; the Memories list drops its checkboxes and
	 * squash/push toolbar buttons. The host is responsible for refilling the
	 * branch:* data feeds with the selected repo's content; this field is
	 * the renderer's signal to switch to read-only chrome.
	 */
	readonly selectedRepoName?: string;
	/**
	 * Which branch is being viewed inside the selected repo. Same readonly
	 * semantics as selectedRepoName: when this differs from branchName (the
	 * workspace's actual HEAD) the sidebar enters foreign-readonly mode even
	 * if the repo matches. Undefined = "viewing the workspace branch".
	 */
	readonly selectedBranchName?: string;
	/**
	 * Set when activate() couldn't complete its normal init (no workspace folder
	 * open, or workspace isn't a git repo). The webview swaps the standard
	 * disabled banner for a reason-specific CTA (Open Folder / Initialize Git).
	 * Undefined in the normal flow.
	 */
	readonly degradedReason?: SidebarDegradedReason;
	/**
	 * Whether this repo has ANY memory on ANY branch (orphan-branch index
	 * non-empty). `false` = per-repo cold start → the webview shows the
	 * back-fill cold-start card (offer → select → progress → done). `true` /
	 * `undefined` = normal UI (undefined = "not yet known" during early init,
	 * treated as "has memories" so the card never flashes before the count
	 * resolves). Sent only on `init`; the host also updates its in-memory value
	 * once a back-fill generates a memory, so a later sidebar reload reads the
	 * resolved state. Within a live session the card flips itself to its "done"
	 * view via `backfill:done`, not via a state re-push.
	 */
	readonly repoHasMemories?: boolean;
	/**
	 * Whether the user dismissed the cold-start card for this repo (persisted
	 * per-repo marker). When `true` the card is suppressed even in cold start,
	 * until the repo re-enters an empty state. Pushed alongside
	 * `repoHasMemories` so the webview can decide card visibility from state
	 * alone.
	 */
	readonly backfillDismissed?: boolean;
	/**
	 * Which cold-start card variant to show (the webview keys card visibility on
	 * THIS, not `repoHasMemories`):
	 *   - `"empty"` — repo has zero memories on any branch (fresh install).
	 *   - `"gaps"`  — repo HAS memories, but the last ~month has own commits
	 *                 lacking a summary (e.g. a pre-enable backlog). Same card,
	 *                 different copy (see `recentMissingCount`).
	 *   - `null` / `undefined` — no card.
	 * Recomputed on init and re-pushed after enable (`backfill:coldStart`).
	 */
	readonly coldStartVariant?: "empty" | "gaps" | null;
	/**
	 * Count of own commits in the last ~month that lack a summary — the `N` in
	 * the `"gaps"` variant's copy. 0 for the `"empty"` variant.
	 */
	readonly recentMissingCount?: number;
}

export interface SerializedTreeItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly iconKey?: string;
	readonly iconColor?: string;
	readonly tooltip?: string;
	readonly contextValue?: string;
	readonly command?: {
		readonly command: string;
		readonly args?: ReadonlyArray<unknown>;
	};
	readonly collapsibleState?: "none" | "collapsed" | "expanded";
	readonly children?: ReadonlyArray<SerializedTreeItem>;
	/** Changes panel only: M / A / D / U / R / C / I — undefined for non-file rows. */
	readonly gitStatus?: string;
	/** Changes panel only: in-memory selection state. */
	readonly isSelected?: boolean;
	/**
	 * Changes panel only: the two raw porcelain v1 columns. `gitStatus` collapses
	 * them into a single display letter, but `bridge.discardFiles` needs both to
	 * pick the correct git command (worktree-only `restore` vs staged-worktree
	 * `restore --staged --worktree` vs untracked `unlink` etc.). Without these,
	 * the webview-routed discard handler used to silently send a partial
	 * FileStatus to the host and untracked / renamed / added files would fall
	 * into the wrong branch and fail.
	 */
	readonly indexStatus?: string;
	readonly worktreeStatus?: string;
	/**
	 * Changes panel only: source path for rename / copy rows (porcelain "R "/"C ").
	 * `bridge.discardFiles` restores both the old and new paths from the index.
	 */
	readonly originalPath?: string;
	/** Commits panel only: whether this commit has an associated memory summary. */
	readonly hasMemory?: boolean;
	/**
	 * Commits panel only: full URL of the memory article on Jolli Space after
	 * pushing. Present only when the commit has a memory that has been pushed.
	 * Drives the SHIPPED group's share/synced status row in the expanded memory
	 * detail ("Shared in Jolli — open article" + link when present; "Not shared —
	 * Share in Jolli" action when absent). Undefined for commits with no memory
	 * or unshared memories.
	 */
	readonly jolliDocUrl?: string;
	/**
	 * Commits panel only: number of E2E-test-guide scenarios attached to this
	 * memory (`summary.e2eTestGuide.length`). Undefined when the summary has no
	 * test guide or when the commit has no memory.
	 */
	readonly e2eCount?: number;
	/**
	 * Commits panel only: tree-aggregated total LLM token usage for this memory
	 * (`aggregateConversationTokens(summary)`). Sums tokens across amend/rebase
	 * children so consolidated memories reflect the full conversation cost.
	 * Undefined when the summary carries no token metadata.
	 */
	readonly conversationTokens?: number;
	/**
	 * Commits panel only: structured hover-card data, mirroring the Memories
	 * panel's `MemoryItem.hover` so the webview can drive both rows through
	 * the same `.hover-card` popover. Absent on file rows.
	 */
	readonly hover?: MemoryHover;
	/**
	 * Plans & Notes panel only (Plan rows): structured hover-card data, same
	 * popover infrastructure as `hover`/MemoryHover. Set by SidebarSerialize
	 * when the source TreeItem is a PlanItem. Drives the rich tooltip in the
	 * webview panel (codicons + clickable actions) instead of native title=
	 * which would just show MarkdownString source as plain text.
	 */
	readonly planHover?: PlanHover;
	/**
	 * Plans & Notes panel only (Note rows): structured hover-card data.
	 * Parallels `planHover` — set by SidebarSerialize for NoteItem instances.
	 */
	readonly noteHover?: NoteHover;
	/**
	 * Plans & Notes panel only (multi-source reference rows): structured hover-card
	 * data driven through the same popover infrastructure as `hover`/MemoryHover.
	 * Lets reference rows (Linear / Jira / GitHub / Notion) display a rich tooltip
	 * (codicons, status / priority / labels / link) instead of the markdown-source
	 * plain text that would show if we routed `tooltip` through the webview's
	 * textContent fallback. Set by SidebarSerialize when the source TreeItem is
	 * a ReferenceItem.
	 */
	readonly referenceHover?: ReferenceHover;
	/**
	 * Commits panel only: the four fields needed to dispatch
	 * jollimemory.openCommitFileChange from the webview. Set by
	 * HistoryTreeProvider when serializing CommitFileItem children. We can't
	 * rely on `command.arguments` here because the serializer drops it (the
	 * native TreeItem stores `arguments[0] === this`, a circular reference
	 * that breaks postMessage's structured clone).
	 */
	readonly commitFile?: {
		readonly commitHash: string;
		readonly relativePath: string;
		readonly statusCode: string;
		readonly oldPath?: string;
	};
}

/**
 * File-node sub-classification, derived from `manifest.json` (the authoritative
 * KB index). Directories always carry `undefined`. Files that aren't tracked in
 * the manifest (user-dropped notes, etc.) carry `"other"`.
 */
export type FolderFileKind = "memory" | "plan" | "note" | "wiki" | "other";

export interface FolderNode {
	readonly name: string;
	/** Path relative to kbRoot, "/"-joined. Empty string for root. */
	readonly relPath: string;
	readonly isDirectory: boolean;
	/** undefined = not yet loaded (lazy). [] = loaded and empty. */
	readonly children?: ReadonlyArray<FolderNode>;
	/** File-only. Manifest-derived classification used by the sidebar UI. */
	readonly fileKind?: FolderFileKind;
	/**
	 * File-only. Manifest `key` for the entry: full commit hash (memory),
	 * plan slug, or note id. Drives the right-click context menu actions
	 * which all expect this stable identifier.
	 */
	readonly fileKey?: string;
	/**
	 * File-only. Human-readable title (commit message for memories) read from
	 * the manifest. When present, rendered in place of the slug-style filename
	 * so the Folders tab matches the Memories tab's display. Falls back to
	 * the file name when undefined (older entries pre-dating manifest title).
	 */
	readonly fileTitle?: string;
	/**
	 * File-only. Source git branch (memories only). Surfaced in the row
	 * description so the user sees which branch a memory belongs to without
	 * navigating into the file.
	 */
	readonly fileBranch?: string;
	/**
	 * File-only. True when the file is manifest-tracked AND its on-disk sha256
	 * differs from the manifest fingerprint — i.e. the user edited the
	 * visible `.md` outside the system. Drives the trailing ✎ marker in the
	 * KB folders tree, mirroring `MemoryFileDecorationProvider`'s badge on
	 * the native explorer. Computed in `KbFoldersService.listInRepo`;
	 * absent (undefined / false) for directories, untracked files, and
	 * cross-repo nodes from `listParentRoot` that have no manifest context.
	 */
	readonly isDiverged?: boolean;
	/**
	 * Directory-only. True when this node is a top-level repo folder under the
	 * Memory Bank parent (i.e. `<kbParent>/<repoName>/`), as opposed to a
	 * subdirectory inside a repo. Lets the renderer apply repo-level styling
	 * and grouping.
	 */
	readonly isRepoRoot?: boolean;
	/**
	 * Directory-only, repo nodes only. True when this repo matches the
	 * currently opened project. Used to highlight / auto-expand the user's
	 * "home" repo while keeping other repos collapsed by default — same
	 * UX as IntelliJ's Memory Bank tool window.
	 */
	readonly isCurrentRepo?: boolean;
	/**
	 * Directory-only, repo nodes only. The raw `config.repoName` (NOT the
	 * `name` display label, which `repoDisplayName` may suffix with a
	 * `(dirName)` collision marker). Lets the Folders renderer scope to a
	 * single repo using the same `repoName` key the `Showing` repo-filter and
	 * the Memories renderer compares against.
	 */
	readonly repoName?: string;
}

export interface MemoryItem {
	readonly id: string;
	readonly title: string;
	readonly commitHash: string;
	readonly branch: string;
	/**
	 * Source repository name. For entries from the current workspace this
	 * equals the workspace basename; for entries discovered under the
	 * Memory Bank parent that belong to a different repo, this is the
	 * other repo's name. The webview shows a repo badge on the row when
	 * the visible memories span more than one distinct repoName so users
	 * can disambiguate same-named branches across repos.
	 */
	readonly repoName: string;
	/** ms since epoch. */
	readonly timestamp: number;
	/**
	 * Plain-text hover tooltip with full memory metadata (commit message,
	 * branch, hash, time, stats). HTML title attributes don't render
	 * markdown / codicons, so this is a flat string with newlines.
	 */
	readonly tooltip?: string;
	/**
	 * Structured fields used by the webview's custom hover popup, which
	 * replaces the native `title=` tooltip with a markdown-like card that
	 * mirrors the legacy TreeView MarkdownString tooltip 1:1 (codicons +
	 * command links). All strings here are display-ready (already formatted).
	 */
	readonly hover?: MemoryHover;
}

export interface MemoryHover {
	/** Commit message — rendered bold at the top of the card. */
	readonly message: string;
	/** "just now" / "2h ago" / "Apr 28" — paired with a clock icon. */
	readonly relativeDate: string;
	/** "amend" / "interactive" / etc — paired with a tag icon when present. */
	readonly commitType?: string;
	/**
	 * Branch name — paired with a git-branch icon. Memories carry the source
	 * branch they were committed on. Commit rows in the Branch tab omit this
	 * (the entire view already represents one branch — repeating it per row is
	 * noise), so the field is optional and the renderer skips the row when
	 * absent.
	 */
	readonly branch?: string;
	/** "10 topics, 3 files changed, 384 insertions(+), 56 deletions(-)" */
	readonly statsLine?: string;
	/** First 8 chars of commitHash — displayed as monospace. */
	readonly shortHash: string;
}

/**
 * Structured hover-card data for Plan rows in the Plans & Notes section.
 * Same popover infrastructure as MemoryHover and LinearIssueHover — only the
 * renderer (renderPlanHoverCard) and click-action set differ. The shape
 * mirrors what the legacy MarkdownString tooltip carried (filename heading,
 * clock+date row, edit-count row, optional commit-hash + preview/edit links)
 * so users see the same information they did before, but rendered as
 * codicons + structured rows instead of raw markdown source.
 */
export interface PlanHover {
	/** Plan title — rendered bold at the top of the card. */
	readonly title: string;
	/** Filename (e.g. "my-plan.md") — paired with a markdown icon. */
	readonly filename: string;
	/** "just now" / "2h ago" / "Apr 28" — paired with a clock icon. */
	readonly relativeDate: string;
	/**
	 * Full commit hash when this plan is associated with a commit. The card
	 * uses the first 8 chars as the visible link label; the full hash is
	 * passed to jollimemory.copyCommitHash via data-hash.
	 */
	readonly commitHash?: string;
	/**
	 * Plan slug — used as the action target for jollimemory.openPlanForPreview
	 * (both committed and uncommitted plans use the same panel command).
	 */
	readonly slug: string;
}

/**
 * Structured hover-card data for Note rows in the Plans & Notes section.
 * Parallels PlanHover but with note-specific fields (format label, snippet
 * content preview).
 */
export interface NoteHover {
	/** Note title — rendered bold at the top of the card. */
	readonly title: string;
	/** Filename (e.g. "my-note.md") — paired with the format icon. */
	readonly filename: string;
	/** "just now" / "2h ago" / "Apr 28" — paired with a clock icon. */
	readonly relativeDate: string;
	/** "Markdown file" or "Text snippet" — paired with note / comment icon. */
	readonly formatLabel: string;
	/** Format key — selects the leading codicon (note vs comment). */
	readonly format: "markdown" | "snippet";
	/**
	 * Snippet content preview (first 200 chars). Only set for snippet notes;
	 * undefined for markdown notes (the filename is enough context for those).
	 */
	readonly contentPreview?: string;
	/** Full commit hash when committed; first 8 chars are the visible label. */
	readonly commitHash?: string;
	/** Note id — used as the action target for jollimemory.openNoteForPreview. */
	readonly noteId: string;
}

/**
 * Structured hover-card data for multi-source reference rows in the Plans & Notes
 * section. Mirrors `MemoryHover` so the webview can drive reference hover-cards
 * through the same `.hover-card` popover infrastructure (positioning, show
 * delay, hide grace) — only the content renderer differs. Plain-text
 * `tooltip` on the SerializedTreeItem stays as the activity-bar TreeView
 * fallback; this richer field is webview-only.
 *
 * Source-specific data flows entirely through the opaque `fields` bag (built
 * by the adapter, carried verbatim through persistence). The hover-card
 * renderer iterates `fields` generically — it never names a source-specific
 * field, so a new source (Slack / Zoom / …) needs no change here.
 */
export interface ReferenceHover {
	/** "PROJ-1234 — Issue title..." (or just title for Notion) — bold at the top. */
	readonly title: string;
	/** Source provider — drives badge / icon-tint and Open-in-<X> link label. */
	readonly source: SourceId;
	/** Opaque, source-specific display fields — rendered as one row each (icon + value). */
	readonly fields?: ReadonlyArray<ReferenceField>;
	/** Upstream URL — used by the Open-in-<Source> action link. */
	readonly url: string;
}

/**
 * Minimal display shape for a single piece of evidence backing a memory.
 * Carries the information needed to dispatch the appropriate open command
 * when a user clicks the evidence row in the Timeline.
 */
export interface MemoryEvidenceItem {
	readonly kind: "conversation" | "plan" | "note" | "reference" | "file";
	readonly id: string;
	readonly title: string;
	/**
	 * For kind === 'conversation': the transcript provider id.
	 * For kind === 'reference': the reference's `SourceId` (`linear` / `jira` /
	 * `github` / `notion`) — required to read the archived snapshot off the
	 * orphan branch via `readReferenceFromBranch`.
	 */
	readonly source?: string;
	readonly transcriptPath?: string;
	readonly relativePath?: string;
	readonly statusCode?: string;
	/**
	 * For kind === 'file' with statusCode === 'R': the pre-rename path, needed
	 * so `jollimemory.openCommitFileChange` can diff old↔new across the rename.
	 */
	readonly oldPath?: string;
	/**
	 * For kind === 'conversation': the number of archived turns in the session
	 * (`session.entries.length`), shown as the trailing "N msgs" count on the
	 * evidence row. Undefined for non-conversation kinds.
	 */
	readonly messageCount?: number;
}

/**
 * Evidence sources backing a single memory, grouped by category.
 * Used by the Timeline (Memory expansion view) to display per-memory evidence
 * without scrolling through the global source list.
 *
 * `sourceRepoName` / `sourceRemoteUrl` carry the memory's provenance (null =
 * current workspace). They route note/reference previews to the owning repo's
 * FolderStorage and gate file-diff opening (a foreign commit can't be diffed
 * against the workspace git).
 */
export interface MemoryEvidence {
	readonly conversations: ReadonlyArray<MemoryEvidenceItem>;
	readonly context: ReadonlyArray<MemoryEvidenceItem>;
	readonly files: ReadonlyArray<MemoryEvidenceItem>;
	readonly sourceRepoName?: string | null;
	readonly sourceRemoteUrl?: string | null;
}

/**
 * Minimal projection of `SummaryIndexEntry` for the foreign-readonly Branch
 * tab Memories section. Carries just the display fields the webview's
 * commit-row renderer reads, so the wire payload stays small. Does NOT
 * collapse amend/rebase chains — one item per stored summary file.
 */
export interface BranchMemoryItem {
	readonly commitHash: string;
	/** Commit message (first line; rendered as the row's primary label). */
	readonly title: string;
	/** Branch name as stored in the index. */
	readonly branch: string;
	/** Repo name (echoed from the request so the webview can key its cache). */
	readonly repoName: string;
	/** ms since epoch derived from `commitDate` / `generatedAt`. */
	readonly timestamp: number;
	/**
	 * Structured hover-card data — same shape as MemoryItem.hover so the
	 * webview's renderHoverCard / lookupHoverEntry can render foreign-mode
	 * memory rows through the same popover the KB-tab Memories list uses.
	 * Optional because callers built before the Branch-tab foreign hover-card
	 * landed may still pass items without it.
	 */
	readonly hover?: MemoryHover;
}

/**
 * Entry in the breadcrumb repo dropdown. `repoName` is the display label and
 * the selector key; `remoteUrl` is forwarded to the host so a cross-repo
 * memory fetch can pin its remote-bound queries (e.g. `gh pr view --repo
 * <url>`) without re-deriving them. `isCurrent` flags the workspace's own
 * repo so the dropdown can sort / style it specially.
 */
export interface RepoChoice {
	readonly repoName: string;
	readonly remoteUrl?: string;
	readonly isCurrent: boolean;
}

export type SidebarOutboundMsg =
	| { readonly type: "ready" }
	| { readonly type: "tab:switched"; readonly tab: SidebarTab }
	| {
			/**
			 * Webview asks the host to materialize the breadcrumb selection
			 * change. Host responds by repopulating branch:* feeds with the
			 * selected repo+branch and (eventually) by pushing a `selection:set`
			 * confirmation. Either field undefined = "stay on current".
			 */
			readonly type: "selection:request";
			readonly repoName?: string;
			readonly branchName?: string;
	  }
	| {
			/**
			 * Foreign-readonly Branch tab can't derive its Memories section
			 * from `branchData.commits` (workspace-HEAD-bound) — webview asks
			 * the host for all memories on the picked repo+branch instead.
			 * Host responds with `selection:branchMemories`.
			 */
			readonly type: "selection:requestBranchMemories";
			readonly repoName: string;
			readonly branchName: string;
	  }
	| { readonly type: "kb:setMode"; readonly mode: KbMode }
	| { readonly type: "kb:expandFolder"; readonly path: string }
	| { readonly type: "kb:openFile"; readonly path: string }
	| { readonly type: "kb:openMemory"; readonly commitHash: string }
	| { readonly type: "kb:expandMemory"; readonly commitHash: string }
	| { readonly type: "kb:loadMore" }
	| { readonly type: "kb:search"; readonly query: string }
	| { readonly type: "kb:clearSearch" }
	| { readonly type: "branch:openPlan"; readonly planId: string }
	| { readonly type: "branch:openNote"; readonly noteId: string }
	| { readonly type: "branch:openReference"; readonly mapKey: string }
	| { readonly type: "branch:openReferenceMarkdown"; readonly mapKey: string }
	| { readonly type: "branch:openReferencePreview"; readonly mapKey: string }
	| { readonly type: "branch:ignoreReference"; readonly mapKey: string }
	| {
			readonly type: "branch:openChange";
			/** Absolute path (FileItem.resourceUri.fsPath in the native tree). */
			readonly filePath: string;
			/**
			 * Repo-relative path. Mirrors `FileItem.fileStatus.relativePath` —
			 * the diff command uses it for the diff editor title. Required
			 * here because `command.arguments = [this]` gets dropped during
			 * serialization (circular ref through structured clone), so the
			 * webview must hand the field back across the bridge.
			 */
			readonly relativePath: string;
			/** Git status code (M / A / D / R / U / C / I / ?) — drives diff variant. */
			readonly statusCode: string;
	  }
	| { readonly type: "branch:openCommit"; readonly hash: string }
	| {
			/**
			 * User clicked a row in the CONVERSATIONS section. Host opens a
			 * dedicated ConversationDetailsPanel keyed by `sessionId`, reading
			 * the transcript from `transcriptPath` using the source-specific
			 * reader (Claude / Codex / Gemini / OpenCode / Cursor / Copilot).
			 */
			readonly type: "branch:openConversation";
			readonly sessionId: string;
			readonly source: TranscriptSource;
			readonly transcriptPath: string;
			/**
			 * The exact string shown in the CONVERSATIONS row label — already
			 * fallback-resolved on the webview side (`item.title || '(untitled)'`),
			 * so the panel can render it verbatim without re-deriving the
			 * fallback. Keeping the fallback in one place guarantees the panel
			 * tab title and the row label never drift.
			 */
			readonly title: string;
	  }
	| {
			/**
			 * Inline "discard" button on a Changes row. The host rebuilds a full
			 * `FileItem` from these fields rather than running the command with a
			 * bare id (which the command's `if (!item?.fileStatus) return;` guard
			 * would silently drop).
			 *
			 * `indexStatus` / `worktreeStatus` are NOT optional — `bridge.discardFiles`
			 * routes on those two columns (worktree-only restore vs staged-worktree
			 * restore vs untracked unlink etc.). Sending only `statusCode` (the
			 * collapsed display letter) used to land every file in the
			 * `git restore --staged --worktree` branch, which silently failed for
			 * untracked / added / renamed files and left the activity-bar badge
			 * showing the pre-discard count. `originalPath` is required for rename
			 * rows so both the old and new paths get unstaged in one shot.
			 */
			readonly type: "branch:discardFile";
			readonly filePath: string;
			readonly relativePath: string;
			readonly statusCode: string;
			readonly indexStatus: string;
			readonly worktreeStatus: string;
			readonly originalPath?: string;
	  }
	| {
			readonly type: "branch:toggleFileSelection";
			readonly filePath: string;
			readonly selected: boolean;
	  }
	| {
			readonly type: "branch:toggleCommitSelection";
			readonly hash: string;
			readonly selected: boolean;
	  }
	| {
			// Clear every commit selection on the host. Sent when the squash UI
			// enters or exits selection mode so stale isSelected flags never
			// carry over into the next squash session.
			readonly type: "branch:deselectAllCommits";
	  }
	| {
			readonly type: "branch:toggleConversationSelection";
			readonly source: TranscriptSource;
			readonly sessionId: string;
			readonly selected: boolean;
	  }
	| {
			readonly type: "branch:togglePlanSelection";
			readonly planId: string;
			readonly selected: boolean;
	  }
	| {
			/**
			 * Multi-source reference row checkbox toggle. `mapKey` is `<source>:<nativeId>`
			 * — identical to the plans.json.references map key and the
			 * `commit-selection.json` references exclusion key.
			 */
			readonly type: "branch:toggleReferenceSelection";
			readonly mapKey: string;
			readonly selected: boolean;
	  }
	| {
			readonly type: "branch:toggleNoteSelection";
			readonly noteId: string;
			readonly selected: boolean;
	  }
	| {
			readonly type: "section:toggle";
			readonly section: string;
			readonly open: boolean;
	  }
	| {
			readonly type: "command";
			readonly command: string;
			readonly args?: ReadonlyArray<unknown>;
	  }
	| {
			readonly type: "refresh";
			// "branch-current" refreshes only the Current Memory block
			// (conversations + context + files); "branch-commits" refreshes only
			// the Committed Memories section. "branch" stays as the whole-tab
			// refresh (used by "all").
			readonly scope:
				| "kb"
				| "branch"
				| "branch-current"
				| "branch-commits"
				| "status"
				| "all";
	  }
	| {
			readonly type: "branch:pin";
			readonly kind: PinKind;
			readonly id: string;
			readonly title: string;
			/** Populated only for kind === 'conversation'. Forwarded to PinEntry so the pin can reopen. */
			readonly source?: string;
			/** Populated only for kind === 'conversation'. Forwarded to PinEntry so the pin can reopen. */
			readonly transcriptPath?: string;
	  }
	| { readonly type: "branch:unpin"; readonly kind: PinKind; readonly id: string }
	| {
			/**
			 * Open a FOREIGN-repo committed memory's PLAN evidence row. Routes to
			 * `jollimemory.previewCommittedPlan`, which reads the plan body from the
			 * owning repo's FolderStorage (NOT the live `openPlanForPreview`, which
			 * resolves against the current workspace's plans.json + workspace orphan
			 * branch and so can't see a foreign repo's plan). Only emitted when the
			 * memory carries provenance — local-memory plan rows keep using
			 * `branch:openPlan` so they get the "prefer local draft" behavior.
			 */
			readonly type: "kb:openEvidencePlan";
			readonly planId: string;
			readonly title: string;
			readonly sourceRepoName: string;
			readonly sourceRemoteUrl: string | null;
	  }
	| {
			/**
			 * Open a committed memory's NOTE evidence row. Routes to the orphan-only
			 * `jollimemory.previewNote` (NOT the live `openNoteForPreview`, which
			 * resolves against the active plans.json registry where committed notes
			 * no longer live). `sourceRepoName` / `sourceRemoteUrl` come from the
			 * memory's provenance so a foreign-repo note reads from the right storage.
			 */
			readonly type: "kb:openEvidenceNote";
			readonly noteId: string;
			readonly title: string;
			readonly sourceRepoName: string | null;
			readonly sourceRemoteUrl: string | null;
	  }
	| {
			/**
			 * Open a committed memory's REFERENCE evidence row. Routes to
			 * `jollimemory.previewCommittedReference`, which reads the archived
			 * snapshot off the orphan branch by `archivedKey` + `source` (NOT the
			 * live `openReferenceForPreview`, which matches plans.json by `mapKey`
			 * and is empty post-commit). Provenance routes foreign reads.
			 */
			readonly type: "kb:openEvidenceReference";
			readonly archivedKey: string;
			readonly source: string;
			readonly sourceRepoName: string | null;
			readonly sourceRemoteUrl: string | null;
	  }
	| {
			/**
			 * Open a committed memory's CONVERSATION evidence row. Unlike the live
			 * `branch:openConversation` (which reopens the cursor-trimmed *unread*
			 * slice of the live transcript file — empty for a committed memory,
			 * whose turns were all consumed into the commit summary and now sit
			 * before the cursor), this routes the host to re-read the ARCHIVED
			 * transcript snapshot off the orphan branch by `commitHash` +
			 * `sessionId` and render its full `entries` in a read-only panel —
			 * the same archived content the memory-details "Manage" view shows.
			 */
			readonly type: "kb:openEvidenceConversation";
			readonly commitHash: string;
			readonly sessionId: string;
			readonly source: TranscriptSource;
			readonly title: string;
	  }
	| {
			/**
			 * Webview requests the open GitHub PR status for a branch.
			 * Host responds with `kb:prStatus` carrying the PR number + URL
			 * (or null when no open PR exists). Fire-and-forget: the host
			 * never throws — errors resolve to pr: null.
			 */
			readonly type: "kb:requestPrStatus";
			readonly branch: string;
	  }
	| {
			/**
			 * Cold-start card asks the host for the back-fillable commit list.
			 * `scope: "recent-month"` → own missing commits authored in the last
			 * 30 days (sidebar default); `"all"` → every own missing commit
			 * (Settings full scope). Host runs a dry-run attribution (no LLM) and
			 * replies with `backfill:candidates` (each row carries session + turn
			 * counts). Cheap for recent-month; may take a moment for `all`.
			 */
			readonly type: "backfill:requestCandidates";
			readonly scope: BackfillScope;
	  }
	| {
			/**
			 * User confirmed the selection — generate summaries for exactly these
			 * commit hashes. Host runs the real back-fill (LLM), streaming
			 * `backfill:progress` and finishing with `backfill:done`. An empty
			 * array is a no-op (host guards it).
			 */
			readonly type: "backfill:run";
			readonly hashes: ReadonlyArray<string>;
	  }
	| {
			/**
			 * User dismissed the cold-start card. Host persists a per-repo marker
			 * so the card stays hidden until the repo re-enters an empty state.
			 */
			readonly type: "backfill:dismiss";
	  }
	| {
			/**
			 * "Manage all in Settings" affordance on the cold-start card — opens the
			 * Settings panel (the full-scope back-fill entry point). The panel's
			 * "Generate Missing Summaries" control lives under its Memory Bank area.
			 */
			readonly type: "backfill:openSettings";
	  };

export type SidebarInboundMsg =
	| { readonly type: "init"; readonly state: SidebarState }
	| { readonly type: "kb:foldersData"; readonly tree: FolderNode }
	| {
			/**
			 * Marks a single already-rendered Folders-tab file row as diverged
			 * (edited on disk, system view unavailable) so its trailing ✎ marker
			 * appears without a full re-listing. Sent by the host when the user
			 * opens a `.md` whose on-disk sha256 no longer matches the manifest
			 * fingerprint — the open-file path is the one place divergence is
			 * checked outside of `KbFoldersService.listInRepo`, so this keeps the
			 * tree's marker in sync with `MemoryFileDecorationProvider`'s badge.
			 * `path` is the repoDir-prefixed relPath used as the client's
			 * `folderCache` key / `data-path`, identical to `kb:openFile`'s path.
			 */
			readonly type: "kb:markDiverged";
			readonly path: string;
	  }
	| {
			/**
			 * Inverse of `kb:markDiverged`: clears a single already-rendered file
			 * row's ✎ marker in place after the host successfully reverts it to the
			 * system version. Sent instead of `kb:foldersReset` so the surrounding
			 * tree keeps its expansion state — a content revert touches one file,
			 * not the tree's shape, so wiping `folderCache` (collapsing every open
			 * branch directory) is the wrong tool. `path` is the repoDir-prefixed
			 * relPath used as the client's `folderCache` key / `data-path`.
			 */
			readonly type: "kb:clearDiverged";
			readonly path: string;
	  }
	| {
			/**
			 * Tells the client to discard its entire `folderCache` before the next
			 * root listing arrives. Sent by the host after destructive operations
			 * (currently: Migrate to Memory Bank) that may rename the repo folder
			 * or invalidate already-expanded paths. The renamed `-N`-suffixed
			 * folder shows up via the next root listing — repos are now flat
			 * top-level nodes, so there's no separate header to update.
			 */
			readonly type: "kb:foldersReset";
	  }
	| {
			readonly type: "kb:memoriesData";
			readonly items: ReadonlyArray<MemoryItem>;
			readonly hasMore: boolean;
	  }
	| {
			readonly type: "kb:memoryEvidence";
			readonly commitHash: string;
			readonly evidence: MemoryEvidence;
	  }
	| {
			readonly type: "branch:branchName";
			readonly name: string;
			readonly detached: boolean;
	  }
	| {
			readonly type: "branch:plansData";
			readonly items: ReadonlyArray<SerializedTreeItem>;
	  }
	| {
			readonly type: "branch:changesData";
			readonly items: ReadonlyArray<SerializedTreeItem>;
	  }
	| {
			readonly type: "branch:commitsData";
			readonly items: ReadonlyArray<SerializedTreeItem>;
			readonly mode: "multi" | "single" | "merged" | "empty";
	  }
	| {
			readonly type: "branch:conversationsData";
			readonly items: readonly ActiveConversationItem[];
			/**
			 * TranscriptSource keys whose discoverer failed (threw or returned a
			 * structured `r.error`) during this aggregator pass. The webview
			 * renders a partial-data hint when this list is non-empty so the
			 * user knows the list is incomplete rather than truly small.
			 * Typed against the closed enum so a renderer's icon/label lookup
			 * is exhaustive — matches the outbound `branch:openConversation`
			 * shape rather than widening back to bare `string`.
			 */
			readonly failedSources: ReadonlyArray<TranscriptSource>;
	  }
	| {
			readonly type: "status:data";
			readonly entries: ReadonlyArray<SerializedTreeItem>;
	  }
	| { readonly type: "enabled:changed"; readonly enabled: boolean }
	| { readonly type: "auth:changed"; readonly authenticated: boolean }
	| { readonly type: "configured:changed"; readonly configured: boolean }
	| {
			readonly type: "worker:busy";
			readonly busy: boolean;
			/**
			 * Workspace HEAD short hash while busy — names the commit being
			 * summarized in the Working Memory "Summarizing <hash>…" row.
			 * Omitted when idle or when the host can't resolve HEAD.
			 */
			readonly commit?: string;
	  }
	| {
			/**
			 * Worker-phase indicator for the Branch-tab toolbar. Selects a
			 * distinct label per ingest sub-phase: `"ingest:wiki"` → "Building
			 * knowledge wiki…", `"ingest:graph"` → "Building knowledge graph…"
			 * (the legacy bare `"ingest"` falls back to the wiki label). `null`
			 * falls back to the default "AI summary in progress…". Lifetime is
			 * bound to `worker:busy` on the reader side.
			 */
			readonly type: "worker:phase";
			readonly phase: WorkerPhase;
	  }
	| {
			/**
			 * Sync-phase indicator for the Branch-tab toolbar. `phase: null`
			 * → idle (sidebar hides the indicator). Non-null → render the
			 * label with a spinning loading icon (`severity: "info"`) or a
			 * red error icon (`severity: "error"`, used for sticky terminal
			 * failures that name the phase that broke).
			 *
			 * Independent of `worker:busy`; both signals can be active at
			 * the same time without one clobbering the other.
			 */
			readonly type: "sync:phase";
			readonly phase: {
				readonly label: string;
				readonly severity: "info" | "error";
			} | null;
	  }
	| {
			/**
			 * Push the list of repos discoverable under the Memory Bank parent.
			 * Drives the breadcrumb repo dropdown. When `repos.length <= 1`, the
			 * webview hides the dropdown affordance entirely (no point offering
			 * a switcher with one option).
			 */
			readonly type: "selection:repos";
			readonly repos: ReadonlyArray<RepoChoice>;
	  }
	| {
			/**
			 * Push the list of branches available inside the currently selected
			 * repo. Re-sent whenever the user switches repos.
			 */
			readonly type: "selection:branches";
			readonly repoName: string;
			readonly branches: ReadonlyArray<string>;
	  }
	| {
			/**
			 * Host confirms the breadcrumb selection has been applied. The
			 * webview adopts these values and recomputes its readonly chrome.
			 * `repoName === currentRepoName && branchName === workspace branch`
			 * means "back to normal mode".
			 */
			readonly type: "selection:set";
			readonly repoName?: string;
			readonly branchName?: string;
	  }
	| {
			/**
			 * Response to `selection:requestBranchMemories`. Items are the raw
			 * unfiltered SummaryIndexEntry projection for the requested
			 * repo+branch — includes amend/rebase children that the global
			 * KB Memories list collapses out. Used only by the foreign-readonly
			 * Branch tab Memories section.
			 */
			readonly type: "selection:branchMemories";
			readonly repoName: string;
			readonly branchName: string;
			readonly items: ReadonlyArray<BranchMemoryItem>;
	  }
	| {
			/**
			 * Host tells the webview to drop its `branchMemoriesCache` (and any
			 * in-flight `branchMemoriesPending` marker) and re-trigger the lazy
			 * `selection:requestBranchMemories` fetch for the active foreign
			 * selection. Sent on toolbar Refresh — without this signal the
			 * session-sticky cache would never re-fetch, leaving the Memories
			 * panel pinned to whatever the first selection load returned.
			 */
			readonly type: "selection:invalidateBranchMemories";
	  }
	| {
			/**
			 * Posted only on the failure path of the inline onboarding API key
			 * save (jollimemory.saveAnthropicApiKey). The success path is
			 * implicit: a successful save flips `configured` true via
			 * statusStore, which triggers the existing `configured:changed`
			 * channel and retires the apikey-panel through `applyConfigured(true)`.
			 */
			readonly type: "apikey:saveError";
			readonly message: string;
	  }
	| {
			/**
			 * Toggle the Status overlay. Posted by the native view-title Status
			 * icon (`jollimemory.toggleStatus`), which lives in the editor's
			 * "JOLLI MEMORY" title bar now instead of inside the webview. The
			 * webview owns the toggle semantics: open the Status overlay, or
			 * collapse back to the Branch view if Status is already showing.
			 */
			readonly type: "status:toggle";
	  }
	| {
			/**
			 * Host pushes the current branch's pinned items. Sent on init, after
			 * each pin/unpin, on branch switch, and on branch/all refresh.
			 */
			readonly type: "branch:pinsData";
			readonly items: ReadonlyArray<PinEntry>;
	  }
	| {
			/**
			 * Aggregated LLM token usage across all committed summaries on the current
			 * branch. Posted alongside `branch:commitsData` when at least one summary
			 * carries token metadata. Drives the horizontal token-usage bar rendered
			 * at the top of the Committed Memories section body (non-foreign only).
			 * `scope: "branch"` is reserved for future per-commit / per-session scopes.
			 */
			readonly type: "branch:tokenStats";
			readonly input: number;
			readonly output: number;
			/** Prompt-cache tokens (cache_read + cache_creation) summed across summaries. */
			readonly cached: number;
			readonly total: number;
			/**
			 * How many committed memories on this branch carried token usage
			 * (`reporting`) out of the total memory count (`memories`). Sources that
			 * don't report usage (most non-Claude agents) contribute to `memories`
			 * but not `reporting`, so the bar's total is a floor — the tooltip uses
			 * these two counts to say "N of M memories report token usage".
			 */
			readonly reporting: number;
			readonly memories: number;
			readonly scope: "branch";
	  }
	| {
			/**
			 * Response to `kb:requestPrStatus`. Carries the open PR for the
			 * branch (number + URL), or null when no open PR exists or the
			 * lookup failed. The webview uses this to render "PR #N — open"
			 * in the SHIPPED group.
			 */
			readonly type: "kb:prStatus";
			readonly branch: string;
			readonly pr: { readonly number: number; readonly url: string } | null;
	  }
	| {
			/**
			 * Response to `backfill:requestCandidates`. `items` are the selectable
			 * rows (dry-run preview); `totalMissing` is the full-scope missing
			 * count (so the recent-month card can say "更早还有 N 条"). `scope`
			 * echoes the request so the client can ignore a stale reply.
			 */
			readonly type: "backfill:candidates";
			readonly scope: BackfillScope;
			readonly items: ReadonlyArray<BackfillCandidate>;
			readonly totalMissing: number;
	  }
	| {
			/**
			 * Streamed once per commit while a back-fill runs. Drives the card's
			 * inline progress bar / count. `subject` names the commit just
			 * processed; `failed` flags a per-commit error (the batch continues).
			 */
			readonly type: "backfill:progress";
			readonly done: number;
			readonly total: number;
			readonly subject: string;
			readonly failed: boolean;
	  }
	| {
			/**
			 * Terminal back-fill result — the card flips the candidate list into
			 * a result list. `rows` are the generated (and any errored) commits;
			 * the count fields summarize the batch.
			 */
			readonly type: "backfill:done";
			readonly rows: ReadonlyArray<BackfillResultRow>;
			readonly generated: number;
			readonly skipped: number;
			readonly errors: number;
	  }
	| {
			/**
			 * Live re-push of the cold-start signals (host → webview), sent after
			 * `enableJolliMemory` so the card can appear WITHOUT a window reload.
			 * The webview updates its signals and re-asserts card visibility — but
			 * only when the card is not mid-flow (offer state), so an in-progress
			 * back-fill / done view is never clobbered.
			 */
			readonly type: "backfill:coldStart";
			readonly coldStartVariant: "empty" | "gaps" | null;
			readonly recentMissingCount: number;
			readonly repoHasMemories: boolean;
			readonly backfillDismissed: boolean;
	  };
