# VS Code Sidebar Webview Message Protocol

## Topic Statement

A bidirectional, type-tagged message contract between the sidebar webview and the IDE host that drives every tab's data update, every user gesture, and every cross-tab refresh, where the inbound (host → webview) channel pushes serialized snapshots and lifecycle notifications and the outbound (webview → host) channel either dispatches a known command or hands back a structured action to be reconstituted host-side.

## Scope

**In scope:**
- The full set of inbound message types the host can send to the webview and the payload shape of each.
- The full set of outbound message types the webview can post to the host.
- The serialization contract for tree rows shipped over the inbound channel — what fields the webview can rely on, what is intentionally stripped, and why.
- The first-message-on-ready handshake and the lazy-load trigger that fires alongside it.
- The reasons a payload may be stripped or rebuilt at the boundary (circular references, function values, command argument inflation).
- The fallback behavior when an inbound payload's source raises (the webview must always receive *some* answer so it can drop the "Loading…" placeholder).

**Out of scope:**
- The HTML/CSS/JS the webview client renders from these messages — only the protocol is defined here.
- The persistence of the active tab and the per-tab filter state — separate topic.
- The commands that the `command` outbound dispatches to. Their semantics are owned by their own topics; the protocol only carries their identifier and arguments.
- The KB folder tree contents — only how the request and reply flow through the protocol.

## Data Contracts

### Tabs

The sidebar has three top-level tabs, identified by these stable string ids:

| Tab id     | Tab name in the UI       |
| ---------- | ------------------------ |
| `kb`       | Memory Bank / Folders    |
| `branch`   | Branch (Plans + Changes + Commits) |
| `status`   | Status                   |

The KB tab has a sub-mode toggle: `folders` (file-system tree) or `memories` (paginated commit-memory list).

### Initial state

When the host registers the webview, it computes an initial `SidebarState` that is sent on the first inbound message after the webview signals readiness. The state carries:

| Field            | Meaning                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `enabled`        | The webview's **effective** enabled state: the **conjunction** of the install-state signal (the git hook is present) and the absence of the durable manual opt-out. Both halves are required because the install-state signal can legitimately report "enabled" for a repository the user has explicitly opted out of — a hook shared across worktrees, or a hook reinstalled out of band — and without the conjunction such a repository would render the full operable sidebar instead of the disabled panel. The conjunction is computed in **two** places that must agree: the initial-state builder that seeds this field, and the single chokepoint every runtime `enabled:changed` push funnels through. |
| `authenticated`  | Whether the user is signed in (drives the Sign In/Out icon swap on the Status tab toolbar).                    |
| `activeTab`      | One of `kb` / `branch` / `status` — chosen by the host (defaults to `branch` in the normal flow, `status` when degraded). |
| `kbMode`         | `folders` or `memories` — initial KB sub-mode.                                                                |
| `branchName`     | Current branch name, or empty string if not yet known.                                                        |
| `detached`       | Whether HEAD is detached (i.e. branch name is the literal `HEAD`).                                            |
| `currentRepoName` | Optional display name of the workspace's own repo. Left segment of the header breadcrumb and the "home" anchor for the cross-repo dropdown. Undefined during early-init / degraded modes; the webview falls back to "(workspace)". |
| `selectedRepoName` | Optional. The repo the user is currently *viewing* through the breadcrumb. When equal to `currentRepoName` (or undefined), the sidebar is in normal mode. When different, the sidebar enters **foreign-readonly mode** — Plans & Notes and Changes are hidden, and the Memories list drops its checkboxes and the squash/push toolbar buttons. |
| `selectedBranchName` | Optional. The branch being viewed inside the selected repo. Same readonly semantics: when it differs from `branchName` (the workspace's actual HEAD) the sidebar enters foreign-readonly mode even if the repo matches. Undefined means "viewing the workspace branch". |
| `degradedReason` | Set in the no-workspace and no-git activation branches; absent otherwise. The webview swaps the standard disabled banner for a reason-specific call-to-action banner. |
| `configured`     | Optional boolean. Whether the user has a usable credential (`signedIn || hasApiKey`). Undefined is treated by the webview as "not yet known" and defaults to true — the onboarding panel does not show until the host explicitly sends `false`. The first `init` message after the initial-state-readiness barrier resolves is the canonical source of the initial value. |

There is no `kbRepoFolder` field. The Folders tree renders repos as flat top-level nodes (each `FolderNode` with `isRepoRoot`), so there is no separate repo-root header label to seed or replace.

### Serialized tree-item shape

Every row that the host pushes to the webview — Status entries, Plans/Changes/Commits rows, KB folder children, the per-commit file children — uses the same flat record:

| Field              | Notes                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | Stable identifier for the row. The host supplies a strong `idHint` where possible (file absolute path, commit hash, "commit:filepath") so checkbox state survives rebuilds. Fallback is `label[:description]`. |
| `label`            | Plain string the row displays.                                                                                                           |
| `description`      | Optional plain string; rendered as the secondary inline text.                                                                            |
| `iconKey`          | The codicon-style identifier for the row icon (e.g. `git-commit`, `history`).                                                            |
| `iconColor`        | Optional theme color id for the icon glyph.                                                                                              |
| `tooltip`          | Plain-string tooltip — extracted from the underlying TreeItem's tooltip whether it was set as a string or as a markdown object (the host normalizes). |
| `contextValue`     | The original TreeItem context value; the webview uses this for menu gating.                                                              |
| `command`          | A stripped command pointer: `{ command: string }` only — the original `arguments` array is **always dropped** at serialization time (see "Stripping rules"). |
| `collapsibleState` | One of `none` / `collapsed` / `expanded`.                                                                                                |
| `children`         | Optional array of the same shape, used when the host needs to ship a pre-expanded subtree (Commits panel ships per-commit file children inline). |
| `gitStatus`        | Changes-tab and Commits-tab file rows only: a single collapsed status code character (`M` / `A` / `D` / `U` / `R` / `C` / `I`).         |
| `isSelected`       | Changes-tab file rows only: in-memory selection state, surfaced as a flat boolean so the webview does not have to interpret the IDE's tri-state enum. (Commits-tab selection is conveyed through the snapshot's checked-hashes set, not a per-row flag.) |
| `indexStatus`      | Changes-tab file rows only: the raw porcelain v1 index column. `gitStatus` collapses index+worktree into one display letter, but the discard handler needs both raw columns to pick the correct git command (worktree-only restore vs staged-worktree restore vs untracked unlink). |
| `worktreeStatus`   | Changes-tab file rows only: the raw porcelain v1 worktree column (see `indexStatus`).                                                     |
| `originalPath`     | Changes-tab file rows only: source path for rename / copy rows (porcelain `R `/`C `). The discard handler restores both old and new paths from the index. |
| `hasMemory`        | Commits-tab only: whether the commit has an associated AI summary.                                                                       |
| `memoryRefId`      | Commits-tab only, optional: the row's **preformatted** memory reference identifier. Present only for memory rows whose memory has already been synced to a Space; **absent** both for a memory that has never been synced and for a code-only commit (the two are indistinguishable through this field). The webview renders the received string verbatim as a leading badge — it cannot format the identifier itself, because the sidebar script is a bundled string with no module imports. Cross-ref **Memory Reference Identifier and Copy Chip** (301) for the identifier's format, its two variants, and the chip's behaviour. |
| `jolliDocUrl`      | Commits-tab only, optional: the Space article URL once the memory has been pushed/shared. Drives the "Shared in Jolli — open article" vs "Not shared — Share in Jolli" affordance in the expanded row. Absent for commits with no memory or unshared memories. |
| `e2eCount`         | Commits-tab only, optional: the number of E2E-test-guide scenarios attached to the memory. Absent when the summary has no test guide.    |
| `conversationTokens` | Commits-tab only, optional: the tree-aggregated total LLM token usage for the memory, summing amend/rebase children so a consolidated memory reflects the full conversation cost. Absent when the summary carries no token metadata. |
| `hover`            | Commits-tab and Memories-tab only: a structured hover-card payload with display-ready strings (commit message, relative date, commit type, branch, stats line, short hash). |
| `planHover`        | Plans-tab Plan rows only: structured hover-card payload (title, filename, relative date, optional commit hash, slug). Drives the rich popover instead of a markdown-source `title=` tooltip. |
| `noteHover`        | Plans-tab Note rows only: structured hover-card payload (title, filename, relative date, format label, optional content preview, optional commit hash, note id). |
| `referenceHover`   | Plans-tab multi-source reference rows only: structured hover-card payload (title, source id, opaque source-specific `fields` bag, upstream url). The renderer iterates `fields` generically so a new source needs no shape change. |
| `commitFile`       | Commits-tab per-file children only: `{ commitHash, relativePath, statusCode, oldPath? }` — the four fields the host needs to dispatch the open-file action when the user clicks. (See "Stripping rules" for why this lives in a side channel rather than `command.arguments`.) |

### Stripping rules

Two classes of payload are intentionally not transferable across the host/webview boundary:

1. **Circular references.** The IDE's tree-item idiom is to set `command.arguments = [this]` so the command handler receives the row instance. That creates `item.command.arguments[0] === item`, which the structured-clone in the host's `postMessage` treats as a fatal error and silently drops the entire payload — making the panel render its empty state. The serializer strips `command.arguments` outright. The webview reconstructs the arguments it needs from explicit data attributes on the row (Changes file path, commit hash, plan slug, …) and either dispatches via the `command` outbound message or via a typed action message that the host re-inflates server-side.
2. **Live functions and class instances.** The serializer projects only the plain fields above; it does not ship event emitters, change subscriptions, dispose handles, or any object the host hooks elsewhere. The webview is purely a renderer; it never needs to call host-side methods directly.

Where a row needs richer data than fits the shape (the four-field commit-file payload, the structured hover card), a dedicated optional field is added to the shape rather than relying on `command.arguments`.

### Outbound messages (webview → host)

| Type                                | Payload                                                                                                                | Effect                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ready`                             | none                                                                                                                   | Triggers the host's first-load handshake (see "First-load handshake").                  |
| `tab:switched`                      | `{ tab }`                                                                                                              | Webview is now showing this tab; host updates its persisted active-tab state.            |
| `selection:request`                 | `{ repoName?, branchName? }`                                                                                           | Breadcrumb dropdown picked a repo and/or branch. Host repopulates the `branch:*` feeds with the selected repo+branch and replies with a `selection:set` confirmation. Either field undefined = "stay on current". |
| `selection:requestBranchMemories`   | `{ repoName, branchName }`                                                                                             | Foreign-readonly Branch tab can't derive its Memories from the workspace-HEAD-bound commit feed; asks the host for all memories on the picked repo+branch. Host replies with `selection:branchMemories`. |
| `kb:setMode`                        | `{ mode }`                                                                                                             | KB sub-mode toggle. When `memories`, the host pushes a fresh memories snapshot.          |
| `kb:expandFolder`                   | `{ path }`                                                                                                             | Request a directory listing for the given relative path under the KB root. Host replies with `kb:foldersData` (always, even on error). |
| `kb:openFile`                       | `{ path }`                                                                                                             | Open a file from the KB folder tree. The host routes `.md` files through the rich memory file opener and other extensions through the IDE's generic open command. |
| `kb:openMemory`                     | `{ commitHash }`                                                                                                       | Open the rich memory panel for this commit; routed via the dedicated view-memory command. |
| `kb:loadMore`                       | none                                                                                                                   | Paginate the Memories list; routed via the dedicated load-more command.                  |
| `kb:search`                         | `{ query }`                                                                                                            | Set the Memories filter; routed via the dedicated search command.                        |
| `kb:clearSearch`                    | none                                                                                                                   | Clear the Memories filter.                                                              |
| `branch:openPlan`                   | `{ planId }`                                                                                                           | Row-click on a plan: opens the markdown preview (not the editor).                       |
| `branch:openNote`                   | `{ noteId }`                                                                                                           | Row-click on a note: opens the markdown preview (not the editor).                       |
| `branch:openReference`              | `{ mapKey }`                                                                                                           | Row-click on a multi-source reference (Linear / Jira / GitHub / Notion). `mapKey` is `<source>:<nativeId>`. |
| `branch:openReferenceMarkdown`      | `{ mapKey }`                                                                                                           | Open the reference's generated markdown.                                                |
| `branch:openReferencePreview`       | `{ mapKey }`                                                                                                           | Open the reference's markdown preview.                                                  |
| `branch:ignoreReference`            | `{ mapKey }`                                                                                                           | Permanently ignore a reference row.                                                     |
| `branch:openConversation`           | `{ sessionId, source, transcriptPath, title }`                                                                         | Row-click on a CONVERSATIONS row. Host opens a dedicated conversation-details panel keyed by `sessionId`, reading the transcript with the source-specific reader. `title` is the already-fallback-resolved label so the panel title and the row never drift. |
| `branch:openChange`                 | `{ filePath, relativePath, statusCode }`                                                                               | Row-click on a Changes row. Host rebuilds the row's structural shape and dispatches the open-file-change command. |
| `branch:openCommit`                 | `{ hash }`                                                                                                             | Row-click on a Commits row.                                                             |
| `branch:discardFile`                | `{ filePath, relativePath, statusCode, indexStatus, worktreeStatus, originalPath? }`                                  | Inline discard button on a Changes row. `indexStatus` / `worktreeStatus` are **not** optional — the discard routes on the two raw porcelain columns (worktree-only restore vs staged-worktree restore vs untracked unlink); sending only the collapsed `statusCode` mis-routed untracked / added / renamed files. `originalPath` is required for rename rows so both paths get unstaged in one shot. |
| `branch:toggleFileSelection`        | `{ filePath, selected }`                                                                                               | Checkbox toggle on a Changes row. Host applies it to the files store directly (no command roundtrip). |
| `branch:toggleCommitSelection`      | `{ hash, selected }`                                                                                                   | Checkbox toggle on a Commits row. Host applies the range-selection rule to the commits store directly. |
| `branch:toggleConversationSelection`| `{ source, sessionId, selected }`                                                                                     | Checkbox toggle on a CONVERSATIONS row. Drives the commit-exclusion selection store (spec 188) so Commit Memory includes exactly the selected conversations. |
| `branch:togglePlanSelection`        | `{ planId, selected }`                                                                                                 | Checkbox toggle on a Plan row (commit-exclusion selection).                             |
| `branch:toggleNoteSelection`        | `{ noteId, selected }`                                                                                                 | Checkbox toggle on a Note row (commit-exclusion selection).                            |
| `branch:toggleReferenceSelection`   | `{ mapKey, selected }`                                                                                                 | Checkbox toggle on a multi-source reference row. `mapKey` is `<source>:<nativeId>` — identical to the plans-registry reference map key and the commit-exclusion reference key. |
| `branch:dismissAiExclude`           | `{ kind, key }` where `kind` ∈ `plan` / `note` / `reference`                                                          | User veto of one AI soft-exclusion (the "+"/Include gesture on an AI-struck Context row). Host sets that ranking entry's `dismissed` flag in the commit-exclusion store (spec 188) — the AI's original tier + reason are preserved — and re-pushes `context:relevance` to **both** the sidebar and the review panel so the strikethrough clears everywhere. **Posted by both the sidebar itself and the review panel (spec 247)** — either surface can originate the veto. |
| `section:toggle`                    | `{ section, open }`                                                                                                    | Section accordion expand/collapse persisted state.                                       |
| `command`                           | `{ command, args? }`                                                                                                   | Generic escape hatch: dispatch any registered command by id. Used by the inline buttons and the right-click menu items so the protocol does not have to grow per command. |
| `copyText`                          | `{ text }` — a plain string                                                                                            | Write the string to the OS clipboard. Generic by design (it names no artifact), currently posted only by the memory reference-id chip. The host performs the write and **sends nothing back**; the page owns its own confirmation. Cross-ref **301**. |
| `refresh`                           | `{ scope }` where `scope` ∈ `kb` / `branch` / `branch-current` / `branch-commits` / `status` / `all`                    | Toolbar refresh button; expands per-scope into the corresponding store-level refresh commands plus, for `kb`, an explicit folder-tree re-listing. Two Branch-tab sub-scopes were added (see "Refresh scopes"): `branch-current` reloads only the Current Memory block (conversations + context + files + pins); `branch-commits` reloads only the committed-history section (git history + the foreign-readonly memory-cache invalidation). `branch` remains the whole-tab refresh and is what `all` expands into for the Branch tab. |
| `command` (save-Anthropic-key)      | `{ command: <save-key-command-name>, args: [keyValue] }`                                                                 | Webview-initiated save of an Anthropic API key entered in the onboarding inline panel. The host trims the value at both ends before persisting. Sent via the standard `command` outbound envelope. |
| `branch:pin`                        | `{ kind, id, title, source?, transcriptPath? }`                                                                          | Pin an existing artifact to the top of the Current Branch view. `kind` ∈ `conversation` / `plan` / `note` / `memory` / `reference`; `id` is that artifact's stable identifier; `source` / `transcriptPath` are forwarded only for the conversation kind so the pin can reopen. Host upserts into the pin store (spec 246) then re-pushes `branch:pinsData`. |
| `branch:unpin`                      | `{ kind, id }`                                                                                                           | Remove a pin by (kind, id). Host removes from the pin store then re-pushes `branch:pinsData`. |
| `kb:expandMemory`                   | `{ commitHash }`                                                                                                         | Expand a committed-memory row's evidence. Host reads the summary, projects it into `MemoryEvidence`, and replies with `kb:memoryEvidence` (always, even on error — empty groups). |
| `kb:openEvidenceConversation`       | `{ commitHash, sessionId, source, title }`                                                                              | Open a committed memory's CONVERSATION evidence row. Routes to the **archived** transcript snapshot off the orphan branch (by commit + session), rendered read-only — distinct from the live `branch:openConversation`, whose cursor-trimmed unread slice is empty for a committed memory. |
| `kb:openEvidencePlan`               | `{ planId, title, sourceRepoName, sourceRemoteUrl }`                                                                     | Open a FOREIGN-repo committed memory's PLAN evidence row. Routes to a committed-plan preview that reads from the owning repo's folder storage. Local-memory plan rows keep using `branch:openPlan` (prefer-local-draft behavior). |
| `kb:openEvidenceNote`               | `{ noteId, title, sourceRepoName, sourceRemoteUrl }`                                                                     | Open a committed memory's NOTE evidence row. Routes to the orphan-only note preview (the live open path resolves against the active registry where committed notes no longer live); provenance routes foreign reads. |
| `kb:openEvidenceReference`          | `{ archivedKey, source, sourceRepoName, sourceRemoteUrl }`                                                              | Open a committed memory's REFERENCE evidence row. Routes to the archived-snapshot reference preview off the orphan branch (by `archivedKey` + `source`); provenance routes foreign reads. |
| `kb:requestPrStatus`                | `{ branch }`                                                                                                             | Ask for the branch's open GitHub PR. Host replies with `kb:prStatus` (fire-and-forget — see "Failure handling"). |
| `branch:deselectAllCommits`         | none                                                                                                                     | Clear every commit checkbox on the host. Sent when the squash UI enters/exits selection mode so stale pre-checked commits never carry into the next squash session. |

### Inbound messages (host → webview)

| Type                          | Payload                                                                                          | When sent                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `init`                        | `{ state }` (the SidebarState above)                                                             | Once, in reply to `ready`.                                                                             |
| `status:data`                 | `{ entries }`                                                                                    | On every Status store change and as part of the first-load reply.                                      |
| `branch:branchName`           | `{ name, detached }`                                                                             | On every branch change (HEAD watcher) and once at first load.                                          |
| `branch:plansData`            | `{ items }`                                                                                      | On every Plans store change and as part of the first-load reply.                                       |
| `branch:changesData`          | `{ items }`                                                                                      | On every Files store change and as part of the first-load reply.                                       |
| `branch:commitsData`          | `{ items, mode }` where `mode` ∈ `multi` / `single` / `merged` / `empty`                          | On every Commits store change and as part of the first-load reply. Mode is shipped alongside so the webview can render mode-specific affordances (no-checkboxes in single/merged, "merged — read-only history" header in merged). |
| `branch:conversationsData`    | `{ items, failedSources }`                                                                       | On every Active-Conversations aggregator pass. `items` are the active AI conversation rows; `failedSources` lists the transcript sources whose discoverer threw or returned a structured error this pass so the webview can render a partial-data hint. |
| `kb:foldersData`              | `{ tree }` — a `FolderNode` rooted at the requested relative path                                | In reply to every `kb:expandFolder` request, including failures (an empty children list is sent instead of leaving the request unanswered). |
| `kb:markDiverged`             | `{ path }`                                                                                       | Marks a single already-rendered Folders-tab file row as diverged (its trailing ✎ marker appears) without a full re-listing. Sent when the user opens a `.md` whose on-disk sha256 no longer matches the manifest fingerprint. `path` is the repoDir-prefixed relPath. |
| `kb:clearDiverged`           | `{ path }`                                                                                       | Inverse of `kb:markDiverged`: clears one row's ✎ marker in place after the host reverts it to the system version. Sent instead of `kb:foldersReset` so the tree keeps its expansion state. |
| `kb:foldersReset`             | none                                                                                             | After a destructive host-side operation (Migrate to Memory Bank) — tells the webview to drop its entire folder cache before the next root listing arrives. Carries no payload: repos are flat top-level nodes, so there is no separate repo-root header to re-anchor. |
| `kb:memoriesData`             | `{ items, hasMore }`                                                                             | On every Memories store change and as part of the first-load reply.                                    |
| `enabled:changed`             | `{ enabled }`                                                                                    | After enable/disable so the disabled banner shows or hides without an extension reload. The value is the same conjunction the initial state carries (install-state signal AND not manually opted out), applied at the single push chokepoint. |
| `auth:changed`                | `{ authenticated }`                                                                              | After OAuth callback success and after sign-out.                                                       |
| `configured:changed`          | `{ configured }`                                                                                 | Whenever the configured-state derivation (`signedIn || hasApiKey`) flips. Drives the visibility transition between the onboarding panel and the tab UI / disabled panel. |
| `worker:busy`                 | `{ busy }`                                                                                       | Pushed alongside `status:data` so the Branch tab toolbar can react to worker state without parsing entries. |
| `worker:phase`                | `{ phase }`                                                                                      | Worker-phase indicator for the Branch-tab toolbar. Selects a distinct label per ingest sub-phase (`ingest:wiki` → "Building knowledge wiki…", `ingest:graph` → "Building knowledge graph…"); `null` falls back to the default "AI summary in progress…". Lifetime is bound to `worker:busy` on the reader side. |
| `sync:phase`                  | `{ phase }` where `phase` is `{ label, severity }` or `null`                                     | Sync-phase indicator for the Branch-tab toolbar. `null` = idle (indicator hidden); `severity: "info"` renders a spinning loading icon, `severity: "error"` a red error icon for sticky terminal failures. Independent of `worker:busy` — both signals can be active simultaneously. |
| `selection:repos`             | `{ repos }`                                                                                      | Pushes the list of repos discoverable under the Memory Bank parent. Drives the breadcrumb repo dropdown; the webview hides the dropdown when `repos.length <= 1`. |
| `selection:branches`          | `{ repoName, branches }`                                                                         | Pushes the branches available inside the currently selected repo. Re-sent on every repo switch. |
| `selection:set`               | `{ repoName?, branchName? }`                                                                     | Host confirms the breadcrumb selection has been applied. The webview adopts these values and recomputes its readonly chrome. Selection equal to the workspace repo+branch means "back to normal mode". |
| `selection:branchMemories`    | `{ repoName, branchName, items }`                                                                | Response to `selection:requestBranchMemories`. `items` are the raw unfiltered `BranchMemoryItem` projection (includes amend/rebase children the global Memories list collapses out). Used only by the foreign-readonly Branch tab. |
| `selection:invalidateBranchMemories` | none                                                                                      | On toolbar Refresh — tells the webview to drop its session-sticky branch-memories cache and re-trigger the lazy `selection:requestBranchMemories` fetch for the active foreign selection. |
| `apikey:saveError`            | `{ message }`                                                                                    | When a webview-initiated Anthropic API key save fails (validation error or filesystem write error). The webview renders the message inline beneath the API-key input under an alert role. |
| `branch:pinsData`             | `{ items }` — the current branch's pin entries (spec 246)                                        | Pushed on `init`, after every pin/unpin, on branch switch (HEAD change), and on the `branch` / `branch-current` / `all` refresh scopes. **Skipped** while a foreign branch is selected (breadcrumb) and on the `branch-commits` / `kb` / `status` refresh scopes. On any read failure or unresolved workspace/repo, an empty list is posted (never left unanswered). |
| `kb:memoryEvidence`           | `{ commitHash, evidence }` — `evidence` is a `MemoryEvidence` container                          | Reply to every `kb:expandMemory`, including failures (empty groups). Lets a committed-memory row render its backing evidence inline without opening the full detail panel. |
| `branch:tokenStats`           | `{ input, output, cached, total, reporting, memories, scope: "branch" }`                         | Aggregated LLM token usage across the branch's committed summaries. Pushed **alongside every `branch:commitsData`**, INCLUDING a zero-total result (so switching to an empty branch clears a stale bar rather than leaving the previous branch's bar on screen — the webview hides the bar at total 0). **Never** pushed in foreign-readonly mode. See "Token-stats semantics" for the meaning of each field and the `cached` correction. |
| `kb:prStatus`                 | `{ branch, pr }` where `pr` is `{ number, url }` or `null`                                       | Reply to `kb:requestPrStatus`. Fire-and-forget: the host never throws — a missing PR, a lookup error, or an absent PR-lookup dependency all resolve to `pr: null`. |
| `context:relevance`           | `{ items }` where each item is `{ id, autoExclude, reason? }`                                     | AI context-relevance overlay for the Working Memory **Context** rows. Pushed by the review panel's relevance ranking (via the host) so the sidebar strikes through AI soft-excluded items in sync with the panel, and re-pushed after any `branch:dismissAiExclude`. **In-memory only** — it exists while the panel has ranked this session; an **empty `items` list clears the overlay**. `id` is the plan slug / note id / reference map key (the row's `data-id`); the sidebar keys its overlay only off items whose `autoExclude` is true and stashes their `reason` for the hover card. Extra fields the panel includes for its own richer overlay (`tier`, etc.) are ignored by the sidebar. See "Sidebar AI relevance overlay". |
| `status:toggle`               | none                                                                                             | Posted when the native title-bar Status icon is clicked (the icon lives in the editor's view title bar, not in the webview). The webview owns the toggle semantics: open the Status overlay, or collapse back to the Branch view if Status is already showing (see spec 102). |

A `FolderNode` carries `name`, `relPath` (relative to the KB root, "/"-joined; empty string for root), `isDirectory`, optional `children` (undefined = lazy/not loaded, empty array = loaded and empty), per-file metadata (`fileKind` ∈ `memory`/`plan`/`note`/`wiki`/`other`, `fileKey` for the manifest's stable identifier, `fileTitle` for the human-readable display, `fileBranch` for the source branch on memory rows, `isDiverged` when the on-disk `.md` sha256 differs from the manifest fingerprint), and directory-only metadata (`isRepoRoot` when the node is a top-level repo folder under the Memory Bank parent, `isCurrentRepo` when that repo matches the open workspace).

A `MemoryItem` (KB Memories sub-mode) carries `id`, `title`, `commitHash`, `branch`, `repoName` (source repository name — the webview shows a repo badge when visible memories span more than one repo), `timestamp` (ms since epoch), an optional plain-string `tooltip`, and an optional structured `hover` card.

A `BranchMemoryItem` (foreign-readonly Branch-tab Memories section) is a minimal projection carrying `commitHash`, `title`, `branch`, `repoName`, `timestamp`, and an optional `hover`. Unlike `MemoryItem` it does **not** collapse amend/rebase chains — one item per stored summary file.

A `RepoChoice` (breadcrumb repo dropdown) carries `repoName` (display label and selector key), optional `remoteUrl` (forwarded so a cross-repo memory fetch can pin remote-bound queries), and `isCurrent` (flags the workspace's own repo).

A `PinEntry` (`branch:pinsData` payload) carries `kind` (`conversation` / `plan` / `note` / `memory` / `reference`), `id` (the pinned artifact's stable identifier), `title`, `pinnedAt` (ms since epoch), and — conversation kind only — `source` and `transcriptPath`. Its persistence is owned by spec 246.

A `MemoryEvidence` (`kb:memoryEvidence` payload) container carries three arrays of evidence items — `conversations`, `context`, `files` — plus optional provenance `sourceRepoName` / `sourceRemoteUrl` (null = the current workspace; non-null routes previews to the owning repo's storage and gates file-diff opening, since a foreign commit can't be diffed against the workspace git). Each `MemoryEvidenceItem` carries `kind` (`conversation` / `plan` / `note` / `reference` / `file`), `id`, `title`, and kind-specific optionals: `source` (conversation transcript provider, or reference source id needed to read the archived snapshot), `transcriptPath`, `relativePath`, `statusCode`, `oldPath` (for a renamed file), and `messageCount` (archived turn count on a conversation item, shown as the trailing "N msgs"). The **files** group prefers git truth for local memories — the host reads the commit's real per-file status (add/modify/delete/rename + rename source path) so the diff opens correctly — and falls back to the summary's path-only topic file list (status defaulting to "modified") for foreign memories or when the git read fails.

## Behavior

### First-load handshake

1. The webview client posts `ready` as soon as its DOM is mounted.
2. The host replies with `init` carrying the precomputed initial state.
3. The host then **fires the lazy-load trigger** if it has not yet fired in this webview's lifetime — this is the single place the Memories store learns it should perform its first bridge fetch. The trigger is idempotent: collapsing and reopening the sidebar fires `ready` again, but the trigger only acts on the first one.
4. The host pushes a fresh snapshot of every tab's data: status entries (and worker-busy flag), memories, plans, changes, commits, active conversations, and the current branch name. Every tab arrives populated by the time the user starts interacting.

### Outbound dispatch routing

Each outbound message routes through one of three paths:

- **Direct command dispatch.** `command`, `kb:openMemory`, `kb:loadMore`, `kb:search`, `kb:clearSearch`, the row-click messages, and the discard message all eventually call the IDE's command-execution API with a known jollimemory command id and arguments. The webview never names a command id directly except via the generic `command` envelope.
- **Direct store mutation.** Checkbox toggles bypass the command path entirely. The host applies checkbox toggles to the store via direct callbacks plumbed in at activation, so the toggle reaches the store on the very next tick. A command roundtrip would race rapid clicks while the git index is changing.
- **Local handler.** `kb:expandFolder`, `kb:setMode`, `tab:switched`, and `section:toggle` are handled inside the provider without dispatching to a registered command.

### Push channels (host → webview)

Each store registers an `onDidChangeTreeData` subscription on first webview resolve. When the store changes, the corresponding push function runs:

- Status push: sends `status:data` and `worker:busy` together.
- Memories push: sends `kb:memoriesData` with the current `items` and a `hasMore` flag.
- Plans push: sends `branch:plansData`.
- Changes push: sends `branch:changesData`.
- Commits push: walks the tree, serializes top-level commits and their per-file children, and sends `branch:commitsData` with the computed mode tag (`multi` / `single` / `merged` / `empty`).
- Conversations push: sends `branch:conversationsData` with the active conversation rows and the list of `failedSources`. Unlike the other panels this is **not** change-driven — it is driven by a 60-second `setInterval` tick that short-circuits while the sidebar is hidden (a collapsed sidebar pays no aggregator reads; on re-show the `ready` handshake pushes a fresh list anyway). On failure the host still posts an empty-list message so the panel doesn't stick on a stale list.
- Branch watcher: sends `branch:branchName` on every HEAD change.
- Worker-phase / sync-phase: sends `worker:phase` and `sync:phase` independently as the post-commit worker and the background sync advance through their sub-phases.

The Status push is the **only** push that sends two messages (`status:data` + `worker:busy`) back-to-back; the others are single-shot.

### Breadcrumb selection / foreign-readonly mode

The header breadcrumb lets the user view another repo (and branch) discovered under the Memory Bank parent without leaving the workspace:

1. The host pushes `selection:repos` (the dropdown options) and, after a repo pick, `selection:branches` for that repo.
2. The webview posts `selection:request { repoName?, branchName? }`; the host repopulates the `branch:*` feeds for the chosen repo+branch and replies with `selection:set` to confirm.
3. When the confirmed `selectedRepoName` / `selectedBranchName` differ from the workspace's own repo+HEAD, the webview enters **foreign-readonly mode** — it hides Plans & Notes and Changes and drops the Memories checkboxes and squash/push toolbar buttons.
4. In foreign-readonly mode the Memories section can't reuse the workspace-HEAD-bound commit feed, so the webview posts `selection:requestBranchMemories` and the host answers with `selection:branchMemories` (the raw, non-collapsed `BranchMemoryItem` projection). The webview caches this per selection; the toolbar Refresh sends `selection:invalidateBranchMemories` to force a re-fetch.

### Lazy loads, first-visibility

The webview has no built-in `onDidChangeVisibility` event for its panel, so the host cannot piggyback the lazy-load trigger on visibility. Instead, the trigger is plumbed through the outbound `ready` message — it fires the first time the user reveals the sidebar in a window. Cross-panel watchers (the orphan-summary-ref watcher, the worker-lock watcher) gate their Memories refresh on the lazy-load flag so a user who never opens Memories pays no listing cost on every commit.

### Failure handling

Two payload sources can raise:

- **Folder listing.** When `kb:expandFolder` fans out to the file system and the listing throws, the host **still sends** `kb:foldersData` with an empty `children` array for the requested path, plus a warning in the host log. Without that, the webview's renderer stays on "Loading…" forever (it does not retry). With it, the user sees an empty state and can click Refresh.
- **Commit serialization.** Walking each commit's file children fans out to a per-commit git call. If any rejects, the whole commit-list serialize would otherwise reject. The host catches and posts `branch:commitsData` with an empty list and the computed mode anyway, with a warning in the host log.
- **Conversations aggregation.** When the active-conversations aggregator throws, the host posts `branch:conversationsData` with an empty `items` list (and an empty `failedSources`) plus a warning, so the panel falls back to its empty state rather than freezing on the previous list. Per-source failures that don't throw the whole pass are surfaced through `failedSources` instead.

### Programmatic resets

A small set of host-side operations needs the webview to drop a local cache:

- **Auto-migration completes** (or any equivalent KB rewrite). The host sends `kb:foldersReset` (no payload — repos render as flat top-level nodes, so there is no header anchor to re-seed) and immediately follows with a fresh root listing. The renamed `-N`-suffixed folder shows up via that next root listing.
- **Enable / disable.** Pushed as `enabled:changed`; the webview shows or hides the disabled banner without a window reload.
- **OAuth callback success and sign-out.** Pushed as `auth:changed`; the webview swaps the Sign In / Sign Out icon and the saved-state of any auth-gated affordances.

### Refresh scopes

The Branch tab is refreshed in three granularities so a section's own refresh button reloads only that section:

- `branch-current` — the **Current Memory** block: re-fetch plans/context, files, active conversations, and re-push pins. Does *not* touch committed history or the token bar.
- `branch-commits` — the **Committed Memories** block: re-fetch git history (which re-pushes `branch:commitsData` and, with it, `branch:tokenStats`) and invalidate the foreign-readonly branch-memories cache. Does *not* re-push pins.
- `branch` — the whole tab: everything both sub-scopes do. `all` expands into `branch` (plus `kb` and `status`).

### Pins push

`branch:pinsData` is (re)computed and pushed by the host on `init`, on every pin/unpin, on a HEAD change (a checkout changes which per-branch pin group is current), and on the `branch` / `branch-current` / `all` refresh scopes. It is **skipped** while the breadcrumb selects a foreign branch (the pin group tracks the workspace HEAD, not the foreign selection) and on scopes that don't own the Current Memory block (`branch-commits`, `kb`, `status`). The pin group is resolved from the *live* HEAD (which can be fresher than a lagging cached branch name), and any failure to read posts an empty list rather than leaving the request unanswered.

### Committed-memory evidence

`kb:expandMemory` triggers the host to read the commit's summary and project it into a `MemoryEvidence` container (conversations from the archived per-session snapshots, context from the summary's plans/notes/references, files from git truth or the topic path list — see the data-contract note). The reply `kb:memoryEvidence` is always sent, with empty groups on a missing summary or any read error, so the row stays interactive. The three enrichment fields on committed-memory rows (`jolliDocUrl`, `e2eCount`, `conversationTokens`) come from a **per-refresh memoized** summary lookup: each commit's summary is an uncached storage read, and the memo (created fresh per serialize pass, shared across the whole recursive walk) guarantees each hash is read at most once even when the same hash appears more than once in a refresh. A failed lookup leaves all three fields absent (degraded-but-safe).

### Sidebar AI relevance overlay

The sidebar keeps a session-scoped, in-memory AI soft-exclude overlay on its Working Memory **Context** rows (plan / note / reference), driven entirely by the inbound `context:relevance` message. It is an additive display axis independent of the user's own exclusion (which lives on each row's `isSelected` state):

- **Apply.** Each `context:relevance` push **wholesale-replaces** the overlay: the sidebar rebuilds its soft-excluded id set (and per-id reason map) from the pushed items, taking only the entries whose `autoExclude` is true. An empty `items` list therefore clears the overlay.
- **Row rendering.** A row in the soft-exclude set renders struck-through and dimmed — visually identical to a user-excluded row, but on a separate axis. Its hover card gains an **"Excluded"** chip and the AI's ✨ `reason` (the reason moved off a native `title=` tooltip into the hover card so it no longer collides with the card's own popover).
- **Unified exclude toggle.** The row's ✕ / + control is two-axis aware. A row struck by **either** axis (user-excluded *or* AI-excluded) offers **"+"** = add back, whose single click clears **both** axes at once — user intent there is "make this normal again", not "flip one internal layer". Restoring the user axis flips the hidden include checkbox (re-posting the matching `branch:toggle*Selection`); clearing the AI axis drops the id from the local overlay and posts `branch:dismissAiExclude` (the same round-trip the review panel uses). An unstruck row offers **"✕"** = user leave-out (AI exclusion is never *set* from this control).
- **Local invalidation.** The overlay is cleared locally, without waiting for a push, in two cases where the ranking is known stale: (1) a **summary run starts** (`worker:busy` flips true) — the post-commit worker is consuming and clearing the persisted ranking, so its verdicts are spent; and (2) a **file-selection checkbox changes** — the ranking was computed against the old file set. With the review panel open, its debounced re-rank re-pushes a fresh overlay within the debounce window; with the panel closed the overlay simply stays cleared (correct — no ranking exists for the new file set). A window reload also drops it (fresh in-memory state).

### Token-stats semantics

`branch:tokenStats` aggregates LLM token usage across the branch's committed summaries:

- `input` / `output` / `cached` are the coloured segments; `total` is the headline. The headline `total` comes from the per-memory scalar sum (which can exceed `input + output + cached`, because a legacy root may carry the scalar without a per-turn breakdown); the segments are a floor of what is attributable.
- `reporting` / `memories` are counts: how many memories carried token usage out of the total on the branch (most non-Claude sources contribute to `memories` but not `reporting`), used for a "N of M memories report token usage" note.
- **`cached` is cache-CREATION only.** `cache_read` is deliberately excluded because it is a cumulative per-turn running total that would massively overcount. **Known inaccuracy:** a source doc-comment on this message still reads "cache_read + cache_creation" — that comment is stale and wrong; the code (and this contract) is cache-creation only. This matches the per-memory subline basis so the two figures reconcile.

### Archived-evidence conversation mode

`kb:openEvidenceConversation` opens a committed memory's conversation as an **archived, read-only** snapshot rather than a live transcript. The host re-reads the orphan-branch archived sessions for the commit and matches on **(session, source)** — not session id alone — then renders those captured entries verbatim in the conversation-details panel. This mode is forced read-only *even when a project directory exists* (there is no live cursor or edit overlay to anchor against), so a save attempt short-circuits with an error. The archived panel's registry key is suffixed with the commit hash so an archived view and a live view of the same (source, session) can coexist without collapsing into each other. This is distinct from the live `branch:openConversation`, whose cursor-trimmed *unread* slice is empty for a committed memory (its turns were consumed into the summary and now sit before the cursor).

### Section heading: "Context"

The plans/notes/references section rendered on the Branch tab is now headed **"Context"** (formerly "Plans & Notes"). The data feed is unchanged (`branch:plansData`), and the message names retain their `branch:*Plan* / *Note* / *Reference*` shapes; only the visible heading changed. References in this spec to "Plans & Notes" as a hidden-in-foreign-readonly *section* refer to this same Context section.

### Select-all commands

Three select-all gestures are dispatched from the webview through the generic `command` envelope (not typed messages), each writing through the exclusion store's **batch** API (spec 188) so one click lands as a single on-disk transition:

- Select/deselect all conversations.
- Select/deselect all context (plans + notes + references together — the "all selected?" verdict spans the three groups).
- Select/deselect the whole Current Memory block (conversations + context + files).

Each uses a **toggle** rule: only when *every* existing item is currently selected does the click deselect; otherwise it selects. For the combined Current-Memory gesture the "all selected?" verdict is computed **once across all three groups before any mutation**, so a combined click can never desync the groups (firing three per-group toggles would let each flip on its own state, e.g. conversations deselecting while files select). An empty group never blocks the verdict, and a fully-empty Current Memory is a no-op.

## State Transitions

```
                  ready
webview ─────────────────────────────► host
                                          │
                  init                    │
        ◄─────────────────────────────────┤
                                          │
        ◄── status:data + worker:busy ────┤  (first push)
        ◄── kb:memoriesData ──────────────┤
        ◄── branch:plansData ─────────────┤
        ◄── branch:changesData ───────────┤
        ◄── branch:commitsData ───────────┤
        ◄── branch:conversationsData ─────┤
        ◄── branch:branchName ────────────┤
                                          │
                                          │── lazy-load trigger fires (idempotent)
                                          │
        ─── tab:switched / kb:expandFolder / kb:openX / branch:* / refresh / command ─►
        ◄── per-store push messages on every store change ──────────────────────
```

After the first-load reply, every subsequent message in either direction is independent — there is no second round of `init`, and no scheduled cycle of pushes. Pushes are entirely change-driven.

## Notable Behavior

- **The `command` outbound is the escape hatch.** Inline buttons and right-click menu items dispatch through it so the protocol does not need a typed message per command. Typed action messages are reserved for cases that need pre-shaped payloads the host has to reconstitute (the discard payload with its two raw porcelain columns, the file-open structural shape, the typed checkbox toggles, the conversation-open payload).
- **`command.arguments` is always stripped.** Even in cases where the IDE-level TreeItem set it. The webview never relies on it; the host either reconstructs the structural payload from a side-channel field on the row or expects the webview to post one of the typed action messages with the relevant fields.
- **`copyText` is the one outbound message that dispatches no command, and therefore needs no command allowlist.** It carries a plain string and its only effect is a clipboard write, so the gate that decides which command identifiers the webview may ask the host to run does not apply to it. What the host does apply is a **bound on the payload**: it acts only when the value is a string, is non-empty, and is **at most 256 characters**. Anything out of those bounds is discarded in silence — no clipboard write, no telemetry record, no reply, no user-facing warning. (Notable.)
- **That 256-character bound is a blast-radius limit, not a format check.** It validates nothing about the shape of the string — not a prefix, not a character set — and is generous by two orders of magnitude against the only intended payload. Its purpose is that a page-side defect handing over the wrong string (an entire memory body, say) cannot silently replace the user's clipboard contents. A page that shows its confirmation without awaiting a reply can therefore confirm a copy the host discarded. (Notable; see 301.)
- **`enabled` is a conjunction computed twice, and the two computations must agree.** The install-state signal alone is not the answer: it can report "enabled" for a repository whose owner explicitly opted out, so the manual opt-out is ANDed in. Once in the initial-state builder that seeds `init`, and once at the chokepoint every `enabled:changed` push funnels through. If those two ever disagree, the first paint and the first update would disagree about whether the tab UI or the disabled panel is correct. (Notable.)
- **Tooltip extraction is idempotent across plain string and rich markdown objects.** Some IDE runtimes silently wrap a string tooltip in a markdown wrapper; the serializer reads the `value` property when present so the webview's `title` attribute is never empty.
- **The `mode` field on `branch:commitsData` is the webview's only signal for read-only-history mode.** The webview does not query host-side helpers for mode — every commit-list push carries the current mode alongside the items.
- **Folder-listing failures always emit a reply.** This is the difference between a renderer that stays on "Loading…" forever and one that shows an empty state with a Refresh affordance.
- **The webview never speaks command-id strings except through `command`.** All other outbound messages are typed; this keeps the protocol's surface area enumerable even as commands are added.
- **The Memories panel has its own visibility flag, separate from the sidebar's.** Once the user has opened the Memories tab once in the window, every cross-panel watcher will refresh it on relevant events. If they never open it, those watchers stay quiet about Memories. The trigger that flips the flag is the very first `ready` after activation, regardless of which tab the webview is showing on first reveal.
- **Pushes are change-driven, not polled — with one exception.** Every `*:data` push except conversations is emitted only on a store change or an explicit refresh; there is no heartbeat. The Active Conversations panel is the lone polled surface: a 60-second timer re-pushes `branch:conversationsData` (skipping ticks while the sidebar is hidden).
- **`branch:conversationsData` carries a `failedSources` list, not just rows.** When one transcript source's discoverer throws or returns a structured error, the pass still ships whatever the other sources found, plus the failed-source names so the webview can render a partial-data hint rather than presenting a silently-short list as complete.
- **Foreign-readonly mode is webview-derived from the confirmed selection, not a separate flag.** When `selection:set` confirms a repo/branch that differs from the workspace's own repo+HEAD, the webview hides Plans & Notes and Changes and drops the Memories checkboxes and squash/push buttons. The Memories section in this mode is fed by `selection:branchMemories` (un-collapsed) rather than the workspace commit feed.
- **`worker:phase` and `sync:phase` are independent toolbar indicators.** `worker:phase` is bound to `worker:busy`'s lifetime and labels the post-commit worker's ingest sub-phase; `sync:phase` is independent and can render an info spinner or a sticky red error simultaneously.
- **`branch:tokenStats` is pushed even at total 0.** Withholding the zero-total message would leave a stale bar from the previous branch on screen; posting zeros is the self-healing reset (the webview hides the bar at total 0). It is never pushed in foreign-readonly mode.
- **The token-stats `cached` value excludes `cache_read`.** It is cache-creation only. A stale source doc-comment says otherwise ("cache_read + cache_creation") and is a known inaccuracy — the code and this contract are cache-creation only.
- **Pins are skipped on a foreign branch and on non-Current-Memory refresh scopes.** `branch:pinsData` tracks the workspace HEAD's pin group; it is not pushed while viewing a foreign breadcrumb selection, nor on `branch-commits` / `kb` / `status` refreshes.
- **The three committed-memory enrichment fields share one memoized read.** `jolliDocUrl` / `e2eCount` / `conversationTokens` come from a per-refresh memo so each commit's (uncached) summary is read at most once per serialize pass.
- **The AI relevance overlay is a session-scoped, replace-wholesale layer.** Every `context:relevance` push rebuilds the sidebar's soft-exclude set from scratch (empty list clears it); the sidebar keeps only the `autoExclude` items and their reasons and ignores the panel-only `tier` fields. The overlay is cleared locally on a summary-run start (`worker:busy`) or a file-selection change without waiting for a push, because the underlying ranking is stale in both cases.
- **The exclude toggle clears both axes at once.** A Context row can be struck by the user axis (`isSelected`) or the AI axis (the relevance overlay) or both; the "+" affordance on any struck row clears both in one click. Clearing the AI axis posts `branch:dismissAiExclude`, which the host also uses to re-push `context:relevance` to the sibling surface so the other webview's strikethrough clears too.
- **`branch:dismissAiExclude` can originate from either surface.** Both the sidebar and the review panel post it; whichever originates a veto updates itself optimistically, and the host's re-push of `context:relevance` (fanned out) updates the other — so each surface receives exactly one authoritative update and neither is left showing a stale Excluded strikethrough.
- **The same second webview is fed by the broadcast fan-out.** The Working-Memory review panel (spec 247) registers as a broadcast target, so every host→webview push defined here is mirrored to it; its `ready` handshake re-runs the host's first-load path, which is why the sidebar carries a re-init guard (spec 102) so the re-broadcast `init` does not reset the active view.

## Shared Behavior

- **Sidebar tab/filter state** — the persistence of `activeTab` and the per-tab filter strings across webview reloads. Separate topic.
- **The host-side stores** — the producers of every `*:data` push (status, memories, plans, changes, commits, active conversations) and the consumers of every checkbox toggle and refresh.
- **Branch-watcher emitter** — the source of `branch:branchName`, fed by the HEAD watcher.
- **Sign-in / sign-out flow** — the producer of `auth:changed`.
- **Worker-lock watcher** — the producer of the `worker:busy` flag (and the `worker:phase` label).
- **Active-conversations aggregator** — the producer of `branch:conversationsData` and its `failedSources` list.
- **Commit-exclusion selection store (spec 188)** — the consumer of the `branch:toggle{Conversation,Plan,Note,Reference}Selection` toggles, and of `branch:dismissAiExclude` (which sets a ranking entry's `dismissed` flag).
- **AI context-relevance filtering (spec 258)** — the ranker whose per-item verdicts drive the `context:relevance` overlay pushed here; the review panel (spec 247) computes and pushes it.
- **Breadcrumb selection / foreign-readonly mode** — the producer/consumer of the `selection:*` message family.
- **KB-folders service** — the producer of `kb:foldersData` listings and the `kb:markDiverged` / `kb:clearDiverged` single-row marker updates.
- **Sidebar HTML/CSS/JS bundle** — the renderer this protocol talks to. Defined under its own surface; out of scope here.
- **Onboarding panel and viewport states** — when `configured:changed` and `enabled:changed` are acted upon by the webview is owned by spec 142.
- **Inline Anthropic API key entry** — the validation rule and the host-side save flow that emits `apikey:saveError` (or succeeds silently) are owned by spec 143.
- **Auto-enable on activation** — spec 144 and spec 145 govern when `enabled:changed` may be posted before the user takes any explicit enable action.
- **Pin store (spec 246)** — the per-branch store behind `branch:pin` / `branch:unpin` / `branch:pinsData`.
- **Working-Memory review panel (spec 247)** — the second webview that consumes this protocol via broadcast and reuses its selection/open message shapes.
- **Commit-exclusion selection store — batch API (spec 188)** — the target of the three select-all commands.
- **Token usage extraction and cost estimation (spec 243)** — the per-turn breakdown behind `branch:tokenStats`.
- **Native title-bar Status / Settings icons and view-switch buttons (spec 102)** — the source of `status:toggle` and the re-init guard that coexists with the review panel's broadcast handshake.
- **Memory reference identifier and copy chip (spec 301)** — owns the identifier's format and its two variants, which surface uses which, the chip's rendering and activation contract, and the telemetry the host records on a `copyText`. This spec owns only the optional per-row field that carries the preformatted string and the `copyText` envelope with its payload bound.
- **Manual-disable opt-out (spec 145 / 304)** — the durable repo-wide opt-out that this protocol's `enabled` field folds into the install-state signal.
