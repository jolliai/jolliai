/**
 * Message protocol between the Sidebar webview client and the extension host.
 *
 * Outbound = client → extension. Inbound = extension → client.
 *
 * The generic `command` outbound is used for all inline buttons / right-click
 * menu actions so we don't have to extend the protocol every time a new
 * jollimemory.* command is added.
 */

export type SidebarTab = "kb" | "branch" | "status";
export type KbMode = "folders" | "memories";

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
	readonly activeTab: SidebarTab;
	readonly kbMode: KbMode;
	readonly branchName: string;
	readonly detached: boolean;
	/**
	 * Display name for the repo-root header rendered above the Folders tab
	 * tree (mirrors IntelliJ's `KBExplorerPanel` repo node). The host computes
	 * this with `resolveKbRepoFolderName` — origin URL basename when the repo
	 * has a remote, falling back to `basename(workspaceRoot)` otherwise — so
	 * opening a worktree shows the real repo name (e.g. "jolliai") instead of
	 * the worktree directory name. Empty string degrades to a generic
	 * "Memory Bank" header.
	 */
	readonly kbRepoFolder?: string;
	/**
	 * Set when activate() couldn't complete its normal init (no workspace folder
	 * open, or workspace isn't a git repo). The webview swaps the standard
	 * disabled banner for a reason-specific CTA (Open Folder / Initialize Git).
	 * Undefined in the normal flow.
	 */
	readonly degradedReason?: SidebarDegradedReason;
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
	/** Commits panel only: whether this commit has an associated memory summary. */
	readonly hasMemory?: boolean;
	/**
	 * Commits panel only: structured hover-card data, mirroring the Memories
	 * panel's `MemoryItem.hover` so the webview can drive both rows through
	 * the same `.hover-card` popover. Absent on file rows.
	 */
	readonly hover?: MemoryHover;
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
export type FolderFileKind = "memory" | "plan" | "note" | "other";

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
}

export interface MemoryItem {
	readonly id: string;
	readonly title: string;
	readonly commitHash: string;
	readonly branch: string;
	readonly project: string;
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

export type SidebarOutboundMsg =
	| { readonly type: "ready" }
	| { readonly type: "tab:switched"; readonly tab: SidebarTab }
	| { readonly type: "kb:setMode"; readonly mode: KbMode }
	| { readonly type: "kb:expandFolder"; readonly path: string }
	| { readonly type: "kb:openFile"; readonly path: string }
	| { readonly type: "kb:openMemory"; readonly commitHash: string }
	| { readonly type: "kb:loadMore" }
	| { readonly type: "kb:search"; readonly query: string }
	| { readonly type: "kb:clearSearch" }
	| { readonly type: "branch:openPlan"; readonly planId: string }
	| { readonly type: "branch:openNote"; readonly noteId: string }
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
			 * Inline "discard" button on a Changes row. Mirrors the field set of
			 * `branch:openChange` because `jollimemory.discardFileChanges` expects a
			 * full `FileItem` instance (it reads `item.fileStatus.relativePath /
			 * statusCode`); the host rebuilds a structurally-equivalent shape on
			 * receipt rather than executing the command with a bare id string,
			 * which the command's `if (!item?.fileStatus) return;` guard would
			 * silently drop.
			 */
			readonly type: "branch:discardFile";
			readonly filePath: string;
			readonly relativePath: string;
			readonly statusCode: string;
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
			readonly scope: "kb" | "branch" | "status" | "all";
	  };

export type SidebarInboundMsg =
	| { readonly type: "init"; readonly state: SidebarState }
	| { readonly type: "kb:foldersData"; readonly tree: FolderNode }
	| {
			/**
			 * Tells the client to discard its entire `folderCache` before the next
			 * root listing arrives. Sent by the host after destructive operations
			 * (currently: Migrate to Memory Bank) that may rename the repo folder
			 * or invalidate already-expanded paths. `kbRepoFolder`, when present,
			 * replaces the repo-root header label so the renamed `-N`-suffixed
			 * folder shows up immediately in the tree.
			 */
			readonly type: "kb:foldersReset";
			readonly kbRepoFolder?: string;
	  }
	| {
			readonly type: "kb:memoriesData";
			readonly items: ReadonlyArray<MemoryItem>;
			readonly hasMore: boolean;
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
			readonly type: "status:data";
			readonly entries: ReadonlyArray<SerializedTreeItem>;
	  }
	| { readonly type: "enabled:changed"; readonly enabled: boolean }
	| { readonly type: "auth:changed"; readonly authenticated: boolean }
	| { readonly type: "worker:busy"; readonly busy: boolean };
