# VS Code Summary Webview Panel

## Topic Statement

The Commit Memory side panel that opens beside the editor and renders one summary at a time — properties header, task-usage meter, quick recap, plans and notes, e2e test guide, source commits (when the summary was assembled from a tree of children), topic cards (collapsible), and a footer — and offers in-panel actions to edit topics, detach a single conversation from the memory, copy or download the markdown, push to Jolli Cloud and (optionally) a local folder, and create or update a pull request whose body aggregates every reachable branch summary into one document.

## Scope

**In scope:**
- The two static slots the panel uses: one slot for summaries opened from the Memories tree, and one map keyed by commit hash for summaries opened from the Branch History tree.
- The opening behavior in each slot — single-instance for memory, one-tab-per-commit for commits — and what happens when the user clicks the same item twice.
- The view column the panel opens in and the panel title, "Commit Memory".
- Light/dark theme adaptation tied to the editor's CSS variables.
- The static section layout: optional top-of-page error banner, all-conversations section, properties header, task-usage meter, quick recap, pull-request panel, plans & notes, e2e test guide, source commits, topics list, footer.
- The task-usage (token) meter: its three render states, the tree-wide aggregation it reads, its bar-width denominator, and its help tooltip.
- The inbound message types the panel accepts from the webview, what each one mutates on the persisted summary, and which messages produce a partial in-place rewrite vs. a full re-render.
- The per-conversation detach action offered on each conversations row, its acknowledgement, and the in-place meter swap that rides on it.
- Which stored conversation records the conversations list and the per-source count chips deliberately hide.
- The collapsible behavior on topic cards and the "expand / collapse all" toggle.
- The AI context-relevance display layer inside the Context panel: a tier chip (High / Med / Low) + one-line reason under each *kept* plan / note / reference row (sourced from the summary's `contextRelevance` record), and each *soft-excluded* item rendered as an inline dimmed, struck-through row with an "Excluded" chip, an optional reason, and a single delete affordance (sourced from the summary's `excludedContext` record). Fail-open (empty-reason) verdicts render no chip/reason.
- The `removeExcludedContext` action: dropping one soft-excluded entry from *this commit's* `excludedContext` and re-persisting, without touching the working plan/note/reference registry, behind the same stale-commit + confirm-modal guards as remove-plan / remove-note.
- Reference-row ordering by the full built-in source registry (every registered source renders, in registry order), with sources absent from the registry dropped and never emitted into the DOM.
- The tree-of-children rendering (a single summary may contain a tree of source-summaries; all reachable topics are flattened and sorted, and the source-commits section enumerates each child node).
- The push action: Jolli Cloud always runs; local folder runs concurrently when the per-user push mode is "both"; both sides report independently.
- The conditional push-button label: "Share in Jolli" when the displayed summary has never been published to Jolli Cloud (no Jolli article URL), and "Update on Jolli" once a Jolli article URL is stored on the summary. The label and its accompanying subtitle text are recomputed on every full re-render so a successful first push immediately flips the button (cross-ref spec 94 for the push pipeline).
- The PR action: Create PR and Update PR both build a PR body that aggregates every reachable branch summary into one document when the current branch has at least two summaries reachable from HEAD.
- The summary-error banner that surfaces when the last LLM call for this summary failed and the persisted summary either has empty topics or was assembled mechanically: a warning icon, a short explanatory message, and a "Regenerate" call-to-action button. The banner is suppressed for healthy summaries. In read-only modes the call-to-action button and its "Click Regenerate" instruction are dropped because the user cannot act on them there.
- The read-only panel mode that is in effect when the displayed summary is sourced from another repo's Memory Bank ("foreign-repo") or when this commit has been rewritten by amend / squash / rebase and the on-screen summary is the now-stale pre-rewrite version ("stale rewritten"). In read-only mode, edit / delete / save / push affordances are hidden via CSS, the Regenerate buttons (in both the error banner and the conversations card) are not emitted, and inbound webview messages that would mutate the summary are silently dropped.
- The conversations card's "Manage" / "View" affordance: "Manage" in normal mode opens a transcript-entries detail panel (modal overlay) listing every saved transcript for the commit grouped by source, with per-entry edit / mark-deleted controls and a single Save All / Delete All footer; "View" in foreign-readonly mode opens the same overlay but with every destructive control hidden so the user can browse transcripts read-only. The close button stays clickable in both modes. The overlay's payload semantics — per-entry edits, deletes, and the empty-after-save hide signal — are owned by spec 183 (Conversation Overlay Store).
- The push-cancellation guard that prevents a re-click while a push is in flight.
- Worker-busy interaction on PR-related actions: the same warning toast as Commit / Push / Squash, and a state-refresh that resets the "Loading…" button so the user can retry.

**Out of scope:**
- The actual storage primitives for summaries (orphan branch read/write, plumbing) — owned by the orphan-branch storage topic.
- The LLM call internals for recap generation, e2e test generation, and translation — owned by their own topics.
- The PR comment-marker contract that wraps body text — owned by the PR comment topic.
- The binding chooser webview that opens when Jolli Cloud reports `412 binding_required` — that is a separate webview with its own topic.
- The lock-file probe semantics — owned by the lock-file guard topic.
- The token/cost arithmetic behind the meter: segment semantics, the flat-rate estimator and its formatters (spec 243), the per-model price table and the per-node / per-bucket preference rules and tooltip wordings (spec 257), and the tree-aggregation helpers (spec 04).
- What a detach does to the persisted figures — ownership resolution, subtraction, cost re-derivation, write ordering, and the permanent-failure outcome and its notification gate (spec 306). This spec owns only the row's UI contract.
- The settings webview, note editor webview, and any other webview surface.

## Data Contracts

### Panel slots and identity

| Slot | Identity | Behavior on second open |
| --- | --- | --- |
| Memory slot (single) | The single most recently opened memory panel. | The previous memory panel is disposed; a fresh panel is created. |
| Commit slot (per hash) | Indexed by commit hash. | The existing panel is revealed (focus stays on the sidebar); the rendered HTML is rebuilt only when any of summary content, transcript-availability set, plan-translation-need set, note-translation-need set, or push-action mode changed. |
| KB slot (per hash) | The same map as Commit slot, but the panel opens in the active editor column and the `reveal` switches focus. | Same as the Commit slot but with focus-grab on reveal. |

The two slot lifetimes are independent — opening a panel in one slot never disposes a panel in the other. When the panel is disposed, it cleans up only the slot entry that still points at it (a stale dispose handler from a replaced panel must not null out a live reference).

### Panel-level configuration

| Property | Source | Behavior |
| --- | --- | --- |
| Panel title | Derived from the summary (commit subject + short hash). | Updated on every full re-render. |
| View column | Memory and Commit slots open beside the active editor. KB slot opens in the editor's first column. | The reveal that follows a click on the same item passes no view-column argument so the panel does not jiggle between columns when the editor's "active" column changes. |
| `enableScripts` | Always true. | The webview hosts an inline script with a per-render nonce. |
| `retainContextWhenHidden` | Always true. | The user can click away to a different tab and back without losing scroll position or any in-progress edits. |
| Content security policy | Per-render nonce on every `<style>` and `<script>`. | A fresh nonce is generated on every full re-render. |

### Sections rendered, in order

1. **Summary-error banner** (only when the persisted summary carries the LLM-failure marker; suppressed for healthy summaries). One row with a warning icon, a short status sentence ("Summary generation failed during the last attempt. …"), and — in normal mode only — a Regenerate button. In read-only modes the call-to-action text is shortened and the button is omitted, so the banner still tells the user the summary is degraded but does not promise an action they cannot take.
2. **All conversations** (only when transcripts exist for any commit in the tree).
3. **Header / properties** — its first element is the memory's **reference chip**, prefixing the commit message on the same line. This surface uses the always-present variant, so the chip is there for every memory: the backend-minted identifier once the memory has been pushed to a Space, and the commit-hash fallback form until then. The chip's format, rendered text, accessible name, hover hint, keyboard activation, clipboard payload, and confirmation are owned by **Memory Reference Identifier and Copy Chip** (301). After it: commit message, commit hash, branch, author, date, duration, files changed and ±lines, optional turn count, optional Jolli Memory article URL plus published plan / note URLs, and the push button whose label is "Share in Jolli" or "Update on Jolli" depending on whether a Jolli article URL is stored on the summary.
4. **Task-usage meter** — sits between the header's title line and its property rows. Three states, and no other:
   - **Segmented**: the tree carries per-segment data → a compact total, a compact cost figure, a three-part bar (input / output / cached) and a legend naming each segment's count.
   - **Total-only degrade**: the tree carries a positive total but no segment data anywhere → the same head line with a single full-width bar. A split is never fabricated.
   - **Empty**: the tree's aggregated total is not positive → a "task usage not reported" line with **no bar and no dollar figure at all**, plus a help tooltip saying there is nothing to total. The absence is stated, never priced at zero.

   Both the total and the cost are aggregated over the **whole consolidation tree**, not the root's own values: a squash / amend / rebase memory carries its tokens on its folded children, so reading only the root would show "not reported" for a memory the sidebar reports a large figure for. The bar's segment widths are denominated by the **breakdown's own** sum rather than the headline total — the headline can legitimately exceed it when some folded conversations report only a scalar count — and the last segment absorbs the rounding remainder so the widths always sum to a full bar. The head line carries a help affordance whose tooltip explains that cache reads are excluded because they double-count, plus one of three cost caveats naming which sources fed the figure (owned by spec 257).

   Segment widths travel as data attributes and are applied by the client script rather than as inline styles, because the panel's content policy admits no inline styles.
5. **Horizontal separator.**
6. **Quick recap** (only when the summary has a recap; placeholder with a Generate button when not).
7. **Pull-request panel** — Create / Update / Check status buttons, dynamically populated.
8. **Context** — plans, notes, and references, in one panel with a header count chip and an "add" affordance. Rendered unconditionally: the panel and its header always appear, even when the summary has zero plans, notes, and references, in which case the body shows an empty state instead of the section being omitted. Kept rows are ordered plans → notes → references; reference rows within that block are ordered by the built-in source registry (see "Reference ordering"). Each kept row carries a second meta line — an AI relevance tier chip + one-line reason — when the summary records a verdict for it. AI soft-excluded items render *after* the kept rows as inline dimmed, struck-through "Excluded" rows (see "AI context-relevance display"), replacing the earlier collapsed "AI excluded N" disclosure.
9. **E2E test guide** (only when the summary has one).
10. **Source commits** (only when the summary aggregates more than one source — i.e. it is a squash or branch-aggregate).
11. **Topics** — every topic in the tree, sorted, each in its own collapsible card. Header shows `<emoji> Topic / Topics <count>` and an "Expand All / Collapse All" button.
12. **Footer.**

### Topic flattening

A summary is a tree: a root summary with optional children, each of which can have its own children. Topic rendering walks the entire tree, collects every topic, and sorts the flat list before emitting cards. Topics retain a stable `treeIndex` that identifies them across the tree so partial-update messages can target a single topic without an O(n) re-walk.

### Context chip count

The Context panel's header carries a count chip (plans + notes + references) that sits outside the plans/notes/references body it sits above. One shared formula computes this count from the summary; both the initial full render and the partial in-place refresh described below call that same formula, so the two can never disagree about the number for a given summary. Because the chip lives outside the body that the partial refresh replaces, the refresh message that rebuilds the body also carries a `count` field holding the freshly computed number; the webview reads `count` and updates the chip's displayed text directly, independent of (and without recomputing from) the replaced body markup.

### AI context-relevance display

The Context panel decorates its rows from two per-commit records on the summary (both optional; a summary generated without a relevance ranking carries neither and every row renders as a plain title):

- **Kept-item verdicts** — one entry per *kept* plan / note / reference, each carrying a `kind` (`plan` / `note` / `reference`), a `key` (plan slug / note id / reference `<source>:<native-id>` map key), a relevance `tier` (`high` / `mid` / `low`), and a one-line `reason`. Each kept row gains a second meta line under its title: a tier chip labelled **High** / **Med** / **Low** and the AI's `reason` prefixed with a ✨ glyph. **The chip + reason are suppressed when the `reason` is the empty string** — that is the shape a fail-open (keep-all) ranking produces, and painting a chip for it would stamp a fabricated tier on every row after any ranking failure. Verdict lookup tries the row's working-area key first, then the same key with a trailing `-<hash8>` archive suffix stripped (committed plan slugs / note ids carry that suffix; the verdict keys are the pre-archive identities).
- **Soft-excluded items** — one entry per item the ranker judged unrelated and kept out of the summary, each carrying `kind`, `key`, a `title`, an optional `reason`, and an always-`low` `tier`. Each renders as an inline row *after* the kept rows: a source badge, the title struck through and dimmed (full opacity on hover), an **"Excluded"** chip (always shown, even with no reason), the ✨ reason when present, and a single trash button. The trash button is the row's only action — a soft-excluded item was never archived into this commit, so there is no snapshot to preview or edit.

### Reference ordering

Reference rows are ordered by the **built-in source registry**, which doubles as the render allowlist: the panel iterates the registry in its canonical order (linear → jira → github → notion → slack → zoom-meeting → zoom-doc → asana → …) and emits each source's references in that order, preserving within-source order. A reference whose `source` is **not** a registered built-in — e.g. a crafted value from a tampered orphan branch or a shared Memory Bank — is dropped and never rendered into the webview DOM. This replaced an earlier hand-maintained five-source allowlist (linear / jira / github / notion only), which silently dropped every other registered source; deriving the order from the registry means a newly-registered source appears with no further edit while keeping the drop-unknown-sources security property.

### Conversations list membership

The conversations rows and the per-source count chips are both built from the
stored conversation records of every commit in the tree, collapsed to one row per
producer-and-id pair (a conversation split across several commits has its turns
merged, and the row keeps the first-seen owning commit). Two membership rules
matter:

- **A turn-less usage carrier is hidden.** The commit pipeline persists a
  record with no turns for a conversation that spent tokens without producing a
  readable turn, purely so a later detach has a subtrahend (see spec 245). Such a
  record would otherwise render as an empty conversation row, so it is filtered out
  of the list and never increments a count chip.
- **The predicate is narrow, and that narrowness is load-bearing.** A record is
  treated as a carrier only when it has **no turns AND records a usage share**. A
  record with no turns and **no** share is older or malformed data — a real
  conversation — and is deliberately still listed, with a turn count of zero.
- **"Records a usage share" means specifically the per-segment breakdown**, not a
  share of any kind. The write side gates the breakdown and the per-model split
  independently (see spec 245), so a record can carry the per-model split alone —
  and this filter would not recognise such a record as a carrier. No reachable write
  path produces that shape *together with* zero turns today, since a turn-less
  carrier is minted only for a conversation whose segments sum above zero, so the
  mismatch is latent rather than live; it is the same missing cross-check that costs
  a detach its subtrahend.

Two further details follow from the merged view:

- The filter is applied to the **merged** turns, not per record: a conversation
  that is turn-less in one commit's records and real in another must still appear.
  For the count chips, which avoid a second grouping pass, this means a
  carrier-shaped record does not mark its conversation as seen, so a later record
  carrying the real turns still counts it.
- The detach action reads the stored records **directly and unfiltered**, so a
  hidden carrier record remains subtractable.

### Inbound webview messages

The webview posts these messages to the extension host. Each lists the persistence target and the response back to the webview.

| Message | Persistence | Response |
| --- | --- | --- |
| `copyMarkdown` | None. | Markdown of the current summary written to the OS clipboard; "Copied as Markdown." toast. |
| reference-chip copy notification | **None.** Telemetry only — the clipboard write already happened inside the page, and the host neither reads nor writes anything on receipt. | **No response.** The page has already shown its own confirmation. |
| `downloadMarkdown` | A file the user picks via a Save dialog. | Markdown written to that file; success toast names the path. |
| `push` | Jolli Cloud doc + (optional) local file. | Two independent result messages back to the webview: one for Jolli, one for local. |
| `editTopic` | Persisted summary updated, in-place rewrite of the single card. | `topicUpdated` with the new card's HTML; on error, `topicUpdateError` with the message. |
| `deleteTopic` | Persisted summary updated, full re-render. | Confirmation dialog first; `topicDeleted` after persistence. |
| `editRecap` | Persisted summary's recap field updated; empty input clears the recap. | `recapUpdated` with the new recap section's HTML (empty when cleared). |
| `generateRecap` | LLM call; persisted summary updated. | `recapGenerating` first; `recapUpdated` with the new HTML; on no-major-topics no-op, `recapUpdateError` plus an info toast. |
| `generateE2eTest` | LLM call; persisted summary updated. | `e2eTestGenerating` first; `e2eTestUpdated` with the new section's HTML; on no-major-topics no-op, `e2eTestError` plus an info toast. |
| `editE2eTest`, `editE2eScenario`, `deleteE2eTest`, `deleteE2eScenario` | Persisted summary updated, partial or full section rewrite depending on which one. | Per-scenario edit emits a per-scenario rewrite; deletion fires after a confirmation modal. |
| `editPlan`, `previewPlan` | None — delegated to the standalone plan-edit command. | Opens the plan editor. |
| `loadPlanContent`, `savePlan`, `removePlan`, `addPlan`, `translatePlan` | Persisted plan content / association / title; `removePlan` requires a confirmation modal and marks the plan as ignored so it doesn't reappear in the sidebar. | Various `planContentLoaded`, `planSaved`, `planTranslating`, `planTranslated` messages. |
| `addMarkdownNote`, `saveSnippet`, `loadNoteContent`, `saveNote`, `previewNote`, `removeNote`, `translateNote` | Persisted note content / association / title; `removeNote` requires a confirmation modal and marks the note as ignored. | Various `noteContentLoaded`, `noteSaved`, `noteTranslating`, `noteTranslated`, `snippetSaved` messages. |
| `removeExcludedContext` (`{ kind, key, title }`) | Drops the matching entry from *this commit's* `excludedContext` and re-persists the summary; the working plan/note/reference registry is **untouched**. Behind the same stale-commit guard + confirmation modal as `removePlan` / `removeNote`. A key already absent (stale DOM) is a silent no-op — no modal, no write. | Partial in-place Context refresh. |
| `loadTranscriptStats`, `loadAllTranscripts`, `saveAllTranscripts`, `deleteAllTranscripts` | None / persisted transcript map updates. | Stats summary, full transcript dump, save / delete confirmations. |
| `loadConversations`, `openConversation` | **None** — both are reads. The first fills the conversations rows (titles resolved through the same helper the sidebar uses, so the two surfaces show identical labels); the second opens one row's archived turns in a separate read-only panel. | Conversations data for the rows; a new read-only panel. Both are permitted in foreign-readonly mode. |
| per-conversation detach request (identifies the memory plus the conversation's **producer-and-id pair**) | Removes that one conversation (matched on the pair, not the bare id) from every stored conversation record of this memory's tree — rewriting records that still hold conversations, deleting those left empty — then performs **one** summary write carrying both the transcript-id removal and the corrected token/cost figures (spec 306 owns that correction). Behind the stale-commit guard, and excluded from both the foreign-readonly and the regenerate-in-flight allow-lists, since it writes storage. | A detach acknowledgement naming the row, carrying a rebuilt token-meter fragment **only when the figures actually changed**. A no-match (already detached / stale row) still acknowledges so the row is cleared rather than left stuck. A failed record write surfaces an error toast and no acknowledgement. A failed summary write always acknowledges the row, but only *warns* the user when the figures had actually been corrected — when nothing was attributable, the write that carried only the id removal fails silently, with a log line and no notification. |
| `checkPrStatus`, `prepareCreatePr`, `createPr`, `prepareUpdatePr`, `updatePr` | Pull-request side-effects on the forge. | Per-step messages back: status, title and body for the form, success or error after submission. |

### Push behavior

The Push button's per-user mode determines what runs:

- `jolli` — only the Jolli Cloud upload runs.
- `both` — Jolli Cloud and a local folder write run concurrently. Each completes independently; one's failure does not abort the other. Each posts a separate result message to the webview.

A push currently in flight rejects re-clicks: a re-entrancy flag stays set until both sides have settled.

When Jolli Cloud rejects with `binding_required` (HTTP 412), the panel opens the binding chooser and, if the user selects or creates a space, retries the Jolli push exactly once. A second 412 surfaces as an error rather than recursing.

### PR body aggregation

When the user clicks Create PR or Update PR for a summary on a branch where two or more reachable summaries exist (the current branch's summaries, walked from HEAD back to the merge base with the configured main branch), an aggregate builder assembles one PR body from the entire reachable set:

- A leading **Commits in this PR** directory enumerates every reachable summary in branch order, with the commit subject, the abbreviated hash, and an optional inline link to the per-commit memory when that summary has a Jolli article URL. The directory header counts present-of-total (e.g. "Commits in this PR (3 of 5)") when some commits in the range have no summary.
- A merged **Context** block deduplicates across all reachable summaries by published URL (when present) or by an unpublished identity prefix (so two reachable commits that touch the same plan or note collapse to one row). External references are deduplicated by their `<source>:<native-id>` pair so the same external ticket / issue / page referenced across multiple commits collapses to a single bullet.
- A per-commit **Quick recap (N)** section, where N is the count of reachable commits that have a recap, with each commit's recap under a subheading naming the commit's position-of-total, subject, and abbreviated hash.
- An aggregated **E2E Test (N)** section listing every scenario from every reachable summary, each wrapped in a foldable details disclosure prefixed with `[shortHash]` so the source commit is visible without expanding.
- An aggregated **Topics (N)** section listing every topic from every reachable summary in the same flattened-and-sorted order the topics card uses, each wrapped in a foldable details disclosure prefixed with a positional index and `[shortHash]`.
- A `> Note: K commit(s) without summary were skipped.` footnote when some commits in the range have no summary.
- A trailing footer line common to every Jolli-generated PR body.

The title defaults to the most-recent reachable commit's message.

The aggregate builder enforces soft per-section byte budgets so the assembled markdown stays comfortably below the forge's PR-body size cap: separate budgets cover the recap region, the E2E region, and the topics region, plus a slightly tighter global cap that backstops the final result. When a section runs over its budget the builder stops emitting further blocks in that section and appends a per-section "⚠ K more … omitted due to GitHub PR body size limit." footnote so the reviewer sees that the body is truncated rather than missing arbitrarily. The truncation order is bottom-up within each section (later commits / scenarios / topics drop first).

When the current commit is *not* reachable from HEAD (cross-branch — the user is viewing a summary that is not on the current branch), the body is the single-summary markdown for the displayed commit, and the title defaults to that commit's message. Aggregation never crosses branches.

When the user clicks Create or Update PR while the worker holds the lock, the panel shows the warning toast and re-runs `checkPrStatus` so the click-time "Loading…" button reverts to its pre-click state.

## Behavior

### Opening a summary

1. Read the per-user push action mode.
2. If the source is `commit` or `kb` and a panel for this commit hash exists:
   - Update the existing panel's push-action mode and refresh its three caches (transcript availability, plan translation need, note translation need).
   - If summary content, push action mode, or any of the three caches changed, rebuild the HTML.
   - Reveal the existing panel — focus stays on the sidebar for `commit`, switches to the panel for `kb`.
3. If the source is `memory` and a memory panel exists, dispose it.
4. Create the panel in the right view column with the right view-type, install message and dispose handlers, populate the three caches, and write the initial HTML.

### Disposal

The dispose callback clears the slot entry only when it still points at this instance — preventing a stale dispose handler from nulling out a live reference taken over by a newer instance for the same commit hash.

### Webview message dispatch

Every inbound message routes through a single dispatcher that catches rejections, surfaces a notification, and optionally posts a typed error message back to the webview so the relevant button can reset its loading state.

### Partial vs. full re-render

| Mutation | Re-render scope |
| --- | --- |
| Topic edit | Single topic card replaced in place. |
| Recap edit / generate | Single recap section replaced in place (empty HTML deletes the section). |
| Per-scenario E2E edit | Single scenario row replaced in place. |
| Per-scenario E2E delete | Whole E2E section replaced (indices shift after removal). |
| Topic delete | Full re-render (topic indices and counts change). |
| Plan / note / reference add, remove, save, translate, or `removeExcludedContext` | Partial in-place refresh, not a full re-render: the Context section (plans, notes, references, kept-row relevance chips, and inline soft-excluded rows) is rebuilt and swapped in place — this is also how a translation is reflected, since the translate-needed state feeds the same rebuild — paired with a row-update of the properties-header's published-link list. The refresh message also carries the recomputed Context count so the out-of-section count chip stays in sync (see Context chip count above). |
| Conversation detach | **Two surgical in-place edits, no full re-render.** The acknowledged row is removed by matching the producer-and-id pair (a bare-id match could remove the wrong row, since two producers can mint the same raw id), the conversations count chip is decremented to the surviving row count, and an empty list is replaced by an empty-state line. When the acknowledgement carries a rebuilt meter fragment, the existing meter element is replaced by it and the meter's help affordance is re-initialised **scoped to the replaced element only** — re-scanning the whole page would bind a second listener to every other pinnable popover, making each click toggle twice. When no fragment is carried (nothing was attributable), the meter is left showing its current value. A full re-render is deliberately avoided so a single-row change does not collapse scroll position and expanded sections. |
| Push success | Full re-render so PR section picks up the published Jolli URL and plan/note URLs. |

### Push orchestration

1. If a push is already in flight, reject the click silently.
2. Read the per-user push mode.
3. Run the Jolli Cloud upload — plans first, then notes, then the summary itself, then orphan-doc cleanup. Before uploading plans, collapse same-named plan snapshots to one per name (the latest; see below). Each plan and note upload is individually wrapped: a per-attachment failure is collected rather than thrown, so one failed plan does not abort the remaining attachments or the summary push. Fatal errors (`binding_required`, plugin-outdated) still propagate and abort the whole push. If `binding_required` fires, open the binding chooser and retry once on selection.
4. If the push mode is `both`, also run the local folder write concurrently (resolving the folder via a folder picker if none has been remembered). Each side captures its own outcome.
5. After both sides settle, post a Jolli result message and (when applicable) a local result message back to the webview. If all attachments succeeded, show an info toast naming the verb ("Pushed" / "Updated") and the attachment count. If any attachment failed, show a modal warning naming the verb and listing each failure so the user is not left with a "Synced" state that hides a partial failure.
6. On a successful Jolli Cloud upload, persist the new article URL and per-plan / per-note URLs into the summary, then full-re-render.

### PR creation and update

1. Run the worker-busy guard. If busy, show the warning toast, re-run `checkPrStatus`, return.
2. Decide whether the current commit is reachable from HEAD. If not, fall back to single-summary markdown.
3. Otherwise, walk the branch's summaries from HEAD back to the merge base with the configured main branch. If two or more summaries are reachable, build aggregated markdown. Otherwise, fall back to single-summary markdown plus the missing-summaries footnote.
4. Wrap the markdown in the PR comment markers (so a later Update can find and replace just the wrapped section).
5. Post the prepared title and wrapped body to the webview, which then displays the PR form. The user reviews, edits, and clicks Create or Update.
6. Submit the PR, post the result message back to the webview.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Closed | User selects a summary in Memories tree | Memory panel open (single slot) |
| Closed | User clicks a commit in Branch History | Commit panel open (per-hash slot) |
| Memory panel open | User selects a different memory | Previous memory panel disposed; new memory panel open |
| Memory panel open | User clicks a commit in Branch History | Both panels coexist; sidebar focus stays on the source tree |
| Commit panel open | User clicks the same commit again | Same panel revealed; HTML rebuilt only if render inputs changed |
| Commit panel open | User clicks a different commit | Existing panel stays; new commit panel opens |
| Any panel open | Background mutation persists summary | Panel re-renders in place (partial or full per the mutation's scope) |
| Any panel open | User closes the tab | Panel disposed; slot entry cleared if it still points at this instance |

The push lifecycle has its own micro-state: idle → pushing (re-entrancy flag set) → posting result messages → idle.

## Notable Behavior

- **Memory panel is "navigation-style"; commit panels are "tab-style".** A user clicking around in the Memories tree gets one panel that swaps content; a user clicking commits in the Branch History gets a tab per commit. The two paradigms coexist because they suit how each tree is used. (Surprising; intentional.)
- **Render-input change detection is wider than summary-equal.** Two commits' summaries can be identical-by-JSON while the orphan branch's transcript availability, plan-translation-needed set, or note-translation-needed set has changed. The panel re-fetches all three caches and compares to its previous values before deciding whether a full rebuild is needed. (Surprising; intentional.)
- **`reveal` is called without a view-column argument on the same-tab path.** Passing a column would let the editor recompute "beside" against the active editor at call time, which destroys and recreates the iframe and leaves the webview blank. The intentional bare `reveal` keeps the panel where it already is. (Surprising; intentional.)
- **A stale dispose handler must not clear a live slot.** The slot-clear logic checks identity (`is the slot still pointing at me?`) before clearing — if a newer instance has taken the slot, the stale dispose handler is a no-op. (Notable.)
- **Push is two independent operations under one button.** The Jolli side and the local side use `Promise.allSettled` so a Jolli failure does not abort the local write and vice versa. Each side posts its own result message; the webview shows two independent status indicators. (Notable.)
- **`binding_required` retries exactly once.** If the chooser flow ends in a selection, the push is retried once. A second `binding_required` after a successful binding registration would indicate a server-side bug, so the panel does not recurse — it surfaces the error. (Notable.)
- **Cross-branch viewing falls back to single-summary markdown.** If the user opens a summary whose commit is not reachable from HEAD (e.g., they're viewing a memory from a different branch), Create / Update PR build the body from just that one summary — branch aggregation is gated on reachability so the PR does not silently include commits the user did not intend. (Notable.)
- **PR body aggregation appends a footnote when summaries are partial.** If a branch has 5 commits but only 3 have summaries, the body shows the 3 aggregated and a `> Note: 2 commit(s) without summary were skipped.` footnote so reviewers know the body is partial coverage rather than a 3-commit branch. (Notable.)
- **Recap and E2E generation are no-ops without "major" topics.** Both actions short-circuit when the summary has no major-importance topic; the user sees an info toast ("nothing to recap" / "nothing to test") and the existing recap/guide is preserved (never silently destroyed). (Surprising; intentional.)
- **Re-entrancy guard on Push.** A second click while the first push is in flight is silently dropped. The guard clears in a `finally` so it always lifts even on failure. (Notable.)
- **Plan push deduplicates same-named snapshots.** After a squash, the same logical plan appears once per source commit — same title, different slug (the slug embeds the commit hash). Before uploading, the plan list is collapsed to one entry per base name (the latest snapshot, by last-updated timestamp). If an older snapshot was previously pushed and carries a server-assigned id, the latest snapshot inherits that id so the push updates the existing document rather than creating a duplicate that the server would reject. (Notable; dedup applies to both the upload set and the pushed article's Context link list — the local summary still stores all snapshots.)
- **Per-attachment plan and note failures are collected, not thrown.** Each plan and note upload is independently wrapped so a single failure (e.g. a server error on one plan) does not abort the remaining uploads or the summary push. Failures are gathered and surfaced as a modal warning after the push completes — not a transient toast, because the panel re-renders to "Synced" and a toast would disappear before the user sees it. Only fatal errors (`binding_required`, plugin-outdated) still propagate and abort the whole push. (Notable.)
- **The task-usage meter aggregates the whole tree, and its bar is denominated by the breakdown rather than the headline.** Reading the root's own values alone would show "not reported" for any consolidated memory (its tokens live on the folded children), and dividing the bar's widths by the headline total would under-fill the bar whenever some folded conversation reported only a scalar count. Two different denominators for two different questions. (Surprising; intentional.)
- **The meter's empty state shows no dollar figure at all.** A memory with no reported usage says so in words rather than displaying a priced zero, which would read as a measurement. (Notable.)
- **A detach is a surgical DOM edit, not a re-render — and the meter is only swapped when the figures really changed.** Omitting the swap is the honest rendering of "the removed conversation's share could not be attributed", so the meter keeps its previous value rather than being replaced by a guess. (Notable; the correction itself is spec 306.)
- **Row identity for the detach is the producer-and-id pair, on both sides.** The host matches stored records that way and the webview removes the row that way; a bare-id match could detach or remove the wrong conversation, because two producers can mint the same raw conversation id. (Notable.)
- **A detach that matches nothing still acknowledges the row.** An already-detached or stale row would otherwise stay on screen forever inviting a retry that can never succeed. (Notable.)
- **A detach whose summary write fails is reported to the user only when a correction was lost with it.** When the removed conversation's share was attributable, the conversation really is gone from the stored records while the memory's figures still include it, permanently — and the panel shows a warning rather than leaving a silently-wrong number behind a log line. When nothing was attributable, the failing write carried only the transcript-id removal, and the user is shown nothing at all: a log line is the whole report, and the memory keeps a dangling id plus figures that stay wrong. (Surprising; the silent branch is a reporting gap, not a designed exemption. The permanence is explained in spec 306.)
- **Turn-less usage carrier records are hidden from the conversations list and the count chips, but stay subtractable.** A record with no turns *and* a recorded per-segment usage share exists only so a detach has a subtrahend; a record with no turns and no such share is real (older) data and is still listed with a turn count of zero. The narrow predicate is what keeps legacy conversations visible — and it keys on the per-segment share alone, so a record carrying only a per-model split would slip through it (latent today, since nothing mints that shape turn-less). (Surprising; intentional. See spec 245.)
- **Transcript history is not filtered by per-source enable flags.** Both the lightweight stats load and the full Manage-modal transcript load include every session archived at commit time, regardless of whether the session's source (e.g. Cursor, Codex) is currently enabled in settings. The enable flags govern future capture only; filtering already-archived history by them under-counted sessions in the stats display and — paired with Save All — caused sessions from disabled sources to be silently deleted on save. (Notable.)
- **Translation removes its trigger immediately.** Once a plan or note is translated, the panel removes it from the translate-button-needed set so the button doesn't flash back on the next render — even before the cache refresh has run. (Notable.)
- **Worker-busy interaction on PR actions re-runs the status check.** The user clicked a button that flipped to "Loading…"; if the action is rejected by the lock guard, the panel re-fires `checkPrStatus` so the button rebuilds itself in its true pre-click state instead of staying stuck on "Loading…". (Notable.)
- **`retainContextWhenHidden` is on.** The webview keeps its DOM, scroll position, and any open form data when the user clicks away to another tab and back. This matters for the per-topic edit forms and the PR body editor; without it, every tab switch would lose work. (Notable.)
- **A per-render nonce gates all inline styles and scripts.** Each full re-render generates a fresh nonce that the CSP requires for any `<style>` and `<script>` to execute. This guards against any accidental injection through summary content (which is HTML-escaped at render time anyway). (Notable.)
- **The summary-error banner is suppressed for healthy summaries.** The banner is rendered only when the persisted summary carries the LLM-failure marker. Callers can splice the banner's HTML into the page unconditionally — for healthy summaries it returns the empty string, so there is no "Generation failed" affordance left in the DOM that could mislead users via DevTools. (Notable.)
- **Read-only mode is two distinct causes with one visual treatment.** The same CSS rule hides every editing affordance when the panel is showing a foreign-repo summary (sourced from another repo's Memory Bank) OR a stale-rewritten summary (the commit has been amended / squashed / rebased and the on-screen version is the now-superseded one). Both share the same "no Regenerate, no edit, no delete, no push" affordance set. The error banner's Regenerate button and the conversations card's Regenerate button are dropped from the emitted markup entirely (not just CSS-hidden), so DevTools cannot reveal them either. (Surprising; intentional.)
- **The reference chip's copy notification is explicitly permitted through both message-level gates.** The panel has two allow-lists that let a message past a blocked state — one for the foreign-repository mode, one for the window while a regeneration is in flight — and the notification is named in both. The grounds differ per gate and are both recorded: it reads no version control and writes no storage, so it cannot act on the wrong project when the summary came from another repository; and it persists nothing, so it cannot race the in-flight regeneration's own persist. The chip itself survives the read-only affordance-hiding for a separate reason (see 301) — the two mechanisms are independent, and the notification needed the explicit exemption because the gates match by message name, not by effect. (Notable.)
- **Read-only mode also gates inbound webview messages.** Messages that would mutate the summary (topic edit, recap edit, push, etc.) are dropped silently by the dispatcher when the panel is read-only. The webview never sees an error for sending them, which is correct because in read-only mode the webview should never emit them in the first place; the host-side check is a defence in depth. (Notable.)
- **The push-button label is recomputed from `jolliDocUrl`-presence on every full re-render.** The first successful Jolli Cloud push persists the new article URL onto the summary; the subsequent re-render reads `jolliDocUrl` and switches the label from "Share in Jolli" to "Update on Jolli" with no extra state to track. (Notable.)
- **The conversations modal stays exit-able in foreign-readonly mode.** The same CSS rule that hides every editing button inside the modal carves out an exception for the close button (which is tagged so the rule does not match it). Without this carve-out, opening the modal in foreign-readonly mode would trap the user with no visible exit (ESC and overlay-click still work but are not discoverable). The footer Save / Delete / Cancel buttons stay hidden so the user cannot reach a destructive action by accident. (Notable.)
- **Topics flatten across the whole summary tree.** A squash summary that gathered five commits' topics shows all of them in one sorted list; the source-commits section enumerates the underlying commits separately. This presents the squash as a coherent unit rather than five concatenated reports. (Notable.)
- **The AI relevance layer is two records, two treatments.** Kept-item verdicts (`contextRelevance`) add a tier chip + ✨ reason under a row's title; soft-excluded items (`excludedContext`) render as inline struck-through "Excluded" rows after the kept rows. A fail-open ranking leaves an empty `reason`, so the chip is suppressed rather than fabricating a tier — every surface (this panel, the sidebar hover card, the review panel) gates its chip on a non-empty reason so a ranking failure decorates nothing. (Surprising; intentional.)
- **The Regenerate confirmation's provider attribution names the specific local agent tool.** The dialog's detail body ends with a duration estimate plus a `via <provider>` clause describing the provider a call started *now* would use (the clause is omitted entirely when no provider resolves, rather than promising one that would throw). Under the local-agent provider that clause used to read the bare generic phrase; it now appends the configured tool's display label, so the preview cannot disagree with the status surfaces about which tool is about to run. (Notable.)
- **`removeExcludedContext` edits the commit's audit trail, not the working set.** Deleting a soft-excluded row drops that one entry from *this commit's* `excludedContext` and re-persists — it does **not** touch the working plan/note/reference registry, because a soft-excluded item was never archived into the commit (there is no snapshot to delete) and the underlying item should stay available for future commits. It trips the same stale-commit guard + confirm modal as `removePlan` / `removeNote`, and re-checks the guard after the modal in case an amend landed while it was open. (Notable.)
- **Reference rows render the whole registry, not a five-source subset.** Ordering (and the render allowlist) comes from the built-in source registry, so every registered source (Confluence, Zoom, Asana, Slack, …) renders in registry order; an earlier hardcoded linear/jira/github/notion list silently dropped the rest. A `source` outside the registry is still dropped — the registry both orders and gate-keeps, preserving the "never render an untrusted crafted source into the DOM" property. (Notable.)
- **Theme adaptation is via the editor's CSS variables.** The panel does not read or persist a "light vs. dark" setting; CSS variables tracked by the editor itself drive the colors. This matches whatever the user has set globally without any extra wiring. (Notable.)

## Shared Behavior

- **Worker-busy lock guard** — the same probe and warning toast used by Commit, Push, and Squash also gate this panel's PR actions.
- **Markdown builders** — the clipboard markdown, the local-folder file, and the PR body all derive from the same per-summary markdown builder, with the PR body further specialized to wrap the content in PR comment markers and (when aggregating) emit per-summary blocks. The **clipboard / local-folder** markdown renders the Context block with external references included **and** the AI relevance layer inlined (kept rows carry their tier + reason, soft-excluded items are listed with their reason) so "what you copy matches what the panel showed". The **PR body** deliberately stays relevance-free — its own builders omit the tier chips and excluded-item rows.
- **Branch summary loader** — the loader that walks from HEAD back to the configured main branch's merge base also feeds the source-commits section's content.
- **Binding chooser webview** — the panel that appears when Jolli Cloud demands a space binding; this panel awaits its outcome before retrying the push once.
- **Plans, notes, and transcripts** — read from the orphan branch on every panel render to compute the three render-input caches; written via the same primitives when the user edits in the panel.
- **Push to local folder** — uses the same satellite-file (plans + notes) gathering logic as the Jolli Cloud push to keep the two outputs consistent.
- **Settings webview** — the source of the per-user push action mode and the local-folder root path that drive Push behavior.
- **Push to Jolli Cloud** — the publish pipeline that the "Share in Jolli" / "Update on Jolli" button drives; persisting the returned article URL on the summary is what flips the button's label on the next re-render. See spec 94.
- **Conversation overlay store** — the per-session sidecar of user-authored edits and deletions that the conversations modal reads and writes; the modal is the UI surface, the overlay store is the data layer. See spec 183.
- **Memory reference identifier and copy chip** — the chip that prefixes this panel's title, its two format variants, its activation and clipboard contract, its confirmation, and its telemetry are owned by spec 301. This spec owns only the chip's position in the header and the copy notification's exemption from the two message-level gates.
- **Task-usage meter arithmetic** — the token segments and their formatters come from spec 243, the per-model price table and the per-node / per-bucket cost preference (and the three tooltip wordings) from spec 257, and the tree-aggregation helpers the meter walks from spec 04. This spec owns only the meter's placement, its three render states, and its in-place replacement on a detach.
- **Conversation detach correction** — subtracting a detached conversation's persisted share from the owning node, re-deriving the cost, the records-before-summary write ordering, and the permanent-failure outcome are owned by spec 306; the share it consumes is written by spec 245. This spec owns the row's action, its acknowledgement, and the DOM edit.
- **Summary-error marker** — the persistent flag on the summary that the error banner uses to decide whether to render itself; the marker is written by the post-commit / amend / squash pipeline whenever the LLM call fails and the resulting summary is empty-topics or mechanically assembled.
