# IntelliJ Embedded HTML Summary View

## Topic Statement

A self-contained interactive HTML view that renders a single commit memory (or a tree of children that have been squashed into one) as a structured page — header property table, recap, plans, pull-request controls, end-to-end test guide, source-commit roll-up, and one card per extracted memory topic — communicating with the host through a base64-tunneled bidirectional message bridge so the user can edit, regenerate, push, copy, and translate without leaving the IDE.

## Scope

**In scope:**
- The structural layout of the rendered page: which sections appear, in which order, and which conditions hide each one.
- The data shape consumed (a single commit memory, optionally with a tree of child memories that contribute aggregated stats and topics).
- The complete set of inbound commands the embedded page can send to the host, and the outbound events the host can post back.
- Per-topic interactive affordances: collapsible card, edit-in-place, delete with confirm.
- Per-plan interactive affordances: preview, edit-in-place, remove from commit, translate-to-English.
- The "All Conversations" private-zone block and its modal for inspecting / editing / deleting captured AI transcripts.
- The pull-request status flow visible in the page (checking, no-PR, has-PR, multiple-commits, unavailable) and the create / update form embedded in the page, including the force-push confirmation gate the create/update flow now runs through on a push rejection (cross-referenced to spec 264, not re-documented here) and the silent-failure gap in how its outcome reaches the page.
- The header's restructured layout (title, meta-strip, Details toggle, Share-link button, Export split-menu) and the ship bar that now hosts the PR card and the relocated push/update button.
- The token/cost usage banner and its three rendering states.
- The read-only save-as-markdown-file export command.
- The end-to-end test guide section's three modes: not-yet-generated, generating, populated.
- The light/dark theming contract: both the page background and the light/dark palette are derived from one sample of the IDE's live editor background colour and baked into the rendered page, and that colour is applied to the host surface and the pre-content blank page before the first content load.
- When the page's content is first loaded — the readiness conditions the load waits for, the last-resort timeout, and the one-shot repaint nudge afterwards.
- Deferred hydration: which data sets are gathered after the page opens and applied by message rather than by a second load.
- In-document hover hints, because the embedded browser surfaces no native tooltips.
- The fallback rendering path when the embedded HTML view cannot be created in this environment.

**Out of scope:**
- The on-disk shape of a commit memory or a transcript — owned by the storage spec.
- The actual cloud push / cloud delete network protocol — owned by the cloud-API spec.
- The pull-request creation network call — owned by the PR service spec.
- The generation call that produces an end-to-end test guide, a recap, or a plan translated to English — this host cannot run generation in process and delegates each one over the one-shot generation bridge (spec 292), which owns the request/response contract, provider routing, and prompt assembly.
- The memory reference identifier's format and the copy chip's own behaviour (clipboard payload, confirmation banner, keyboard activation, accessible name, read-only-mode exemption) — owned by spec 301.
- The IDE-level virtual-file wrapper that lets this view open as an editor tab — owned by the virtual-file spec.
- The git-status discovery that lists changed files for the host — owned by the changes-panel spec.

## Data Contracts

### Input

A single commit-memory object. Its tree may carry child memories (when several commits were squashed); the view aggregates statistics and topics across the tree but presents the input as one logical "page". Each topic carries a stable index that survives edits and serves as the operation key for edit/delete commands. Plans are deduplicated across the tree by slug, with the most recently updated copy winning.

The view also receives two pre-computed sets:

| Set                  | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `transcriptHashSet`  | The set of transcript identifiers this memory actually has stored transcripts for. It is the shared transcript-identifier resolution for the memory — the version-5 transcript-identifier list carried on the memory itself, falling back to walking the tree's children for legacy commit-hash-named transcripts on older data — **intersected** with the set of transcripts genuinely present in storage. So an identifier the memory claims but storage does not hold is not in this set. |
| `planTranslateSet`   | The set of plan slugs whose body or title contains CJK characters, qualifying them for translation.  |

Neither set is available when the page is first built. Both are gathered afterwards and applied by message — see *Deferred hydration* below.

### Page structure

The header and the Pull Request section have both been restructured since an earlier description of this page (which had the header as "the commit message as page title, two header buttons — Copy Markdown, Push to Jolli/Update on Jolli — and a properties table," with the Pull Request section as its own independent top-level section). Top-to-bottom, the page now contains:

1. **All Conversations private-zone block** — present always. **Both** the zero-state paragraph and the populated variant (a "Manage" button, a description line, a stats line, and a privacy reassurance line) are always emitted; whichever does not apply is hidden. This is what lets the deferred hydration reveal the populated variant in place — see *Deferred hydration*.
2. **Header** — the commit message as page title, prefixed by a clickable **memory reference chip** (its identifier format, always-present fallback variant, hover hint, keyboard activation, clipboard payload, and confirmation banner are owned by spec 301; this page owns only the chip's position — leading, on the title line, immediately before the escaped commit message); a compact meta-strip (short hash · branch · relative date); a "Details" toggle that expands/collapses a properties table (the previous always-visible properties table, now collapsed by default); a share-link button; and an export split-menu offering "Copy Markdown" and "Save as Markdown File". The push/update button no longer lives in the header — it moved to the ship bar (below).
3. **Token/cost banner** — new section directly below the header; see below.
4. **Ship bar** — new section replacing the old standalone Pull Request section: two cards side by side — a PR card (wrapping the same PR sub-page/state machine the old standalone section had) and a Jolli card (a synced/not-shared status chip plus the relocated push/update button, now labeled "Share in Jolli" when nothing has been pushed yet, "Update on Jolli" once it has).
5. **Plans section** — list of associated plan files, plus an "Associate Plan" button.
6. **End-to-End Test section** — a placeholder + Generate button when none, otherwise a list of collapsible scenarios with edit/regenerate/delete controls.
7. **Source Commits section** — only when the tree has more than one source commit; renders a compact row per source.
8. **Memories section** — header line with title, count, and an "Expand All / Collapse All" button; body is either a flat list of cards (one per topic) or a date-grouped timeline (when the squash spans more than one calendar day).
9. **Footer** — a "Generated by JolliMemory · {timestamp}" attribution line.

The properties table's row set and order (Commit / Branch / Author / Date / Duration / Changes / Conversations) is unchanged, with one exception: the "Jolli Memory (link + plans)" row that used to appear conditionally in the properties table has moved — its content (the pushed URL and any pushed-plan links) now renders unconditionally inside the ship bar's Jolli card instead of as a conditional properties-table row.

### Properties table

Collapsed by default behind the header's "Details" toggle. The properties table renders, in this fixed order:

| Row                         | Condition                                                            |
| --------------------------- | -------------------------------------------------------------------- |
| Commit (short hash + copy)  | always                                                               |
| Branch (pill)               | always                                                               |
| Author                      | always                                                               |
| Date (relative + absolute)  | always                                                               |
| Duration                    | always                                                               |
| Changes (files / +ins / −del) | always                                                             |
| Conversations (turns)       | only when total turns > 0                                            |

A "Jolli Memory (link + plans)" row used to appear here, conditionally, once a cloud document had been pushed. That row's content now renders unconditionally in the ship bar's Jolli card instead (see Page structure) — the properties table no longer carries it.

The "Date" cell carries both a relative phrase ("3 hours ago") and a parenthesized absolute string. The hash row carries a copy-to-clipboard glyph that confirms inline by switching to a checkmark for ~1.5 s.

### Token/cost banner (NEW)

A new section, rendered between the header and the ship bar, showing the AI coding-session usage the memory recorded — tree-aggregated across the whole consolidation tree the same way the properties table's stats are, so a squash/amend/rebase memory reports its folded children's usage rather than an empty root. It has three states:

| State | Condition | Rendering |
| ----- | --------- | --------- |
| Breakdown | A per-segment token breakdown is available | The bold token total, an estimated-cost figure, a three-segment colored bar (input / output / cached — green / grey / blue respectively), and a legend labeling each segment's value. |
| Tokens-only | A nonzero token total exists but no per-segment breakdown | The bold token total and cost figure, with a single full-width bar segment and no legend. |
| Zero | No usage at all was recorded | The literal text "Task usage not reported" (no bar, no cost). |

Cost follows the same rule used elsewhere: prefer the memory's stored per-model cost estimate (tree-aggregated, a pure sum); when absent, fall back to a rough estimate priced at fixed list rates from the aggregated breakdown. When the resulting figure is still zero, the banner shows the literal text "cost N/A" rather than a dollar amount. An info affordance next to the total explains the figure is a lower bound (unreporting sources and pre-capture memories are excluded).

This banner and the branch-level Create-PR view's own token/cost banner (spec 251) follow the same coloring and cost-fallback convention, though each is rendered independently rather than through a shared component.

### Inbound commands (page → host)

Sent as JSON, base64-encoded, over a single host-bridge channel:

| Command                | Payload                                                          | Purpose                                      |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| `copyMarkdown`         | (none)                                                           | Build a markdown rendering of the memory and place on the system clipboard. |
| `downloadMarkdown`     | (none)                                                           | Build the same markdown rendering and write it to a user-chosen path via a native save dialog. A read-only export — not gated behind the write-command permission check the mutating commands below share, so it works even on a stale or foreign (read-only) memory. |
| `pushToJolli`          | (none)                                                           | Push (or update) the memory and its plans to the cloud. |
| `editTopic`            | `{ topicIndex, updates: { title, trigger, response, decisions, todo, filesAffected } }` | Apply a topic edit, persist, and re-render that topic in place. |
| `deleteTopic`          | `{ topicIndex, title }`                                          | Confirm and delete the topic from the tree. |
| `generateE2eTest`      | (none)                                                           | Run the LLM to produce a test guide.        |
| `editE2eTest`          | `{ scenarios: [...] }`                                           | Persist a hand-edited test guide.           |
| `deleteE2eTest`        | (none)                                                           | Confirm and clear the test guide.           |
| `loadPlanContent`      | `{ slug }`                                                       | Read the named plan's markdown.             |
| `savePlan`             | `{ slug, content }`                                              | Write the named plan's markdown.            |
| `removePlan`           | `{ slug, title }`                                                | Confirm and disassociate the plan from this commit. |
| `translatePlan`        | `{ slug }`                                                       | Run the LLM to translate the plan to English. |
| `associatePlan`        | (none)                                                           | Open a chooser of available unassociated plans. |
| `checkPrStatus`        | (none)                                                           | Re-evaluate PR state for the current branch. |
| `createPr`             | `{ title, body }`                                                | Push the branch and create a pull request.  |
| `prepareUpdatePr`      | (none)                                                           | Fetch the current PR and pre-fill the edit form. |
| `updatePr`             | `{ title, body }`                                                | Apply title/body edits to the existing PR.  |
| `loadTranscriptStats`  | (none)                                                           | Compute totals (turns, sessions per source) for the conversations modal. |
| `loadAllTranscripts`   | (none)                                                           | Stream all transcript entries into the modal. |
| `saveAllTranscripts`   | `{ entries: [...] }`                                             | Replace stored transcripts with the modal's edited list. |
| `deleteAllTranscripts` | (none)                                                           | Clear all transcripts associated with this tree. |

### Outbound events (host → page)

Sent over a custom event channel. The page listens on a single event name and dispatches by the `command` field:

| Command                  | Triggered by                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `pushStarted` / `pushSuccess` / `pushFailed` | Ship-bar Jolli-card button feedback and the dynamic link-block/synced-chip update on success. |
| `topicUpdated` / `topicUpdateError`           | Re-render a single topic card after an edit.                |
| `topicDeleted` / `topicDeleteError`           | Remove a topic card.                                         |
| `e2eTestGenerating` / `e2eTestUpdated` / `e2eTestError` | Replace the test section's body.                              |
| `planContentLoaded` / `planSaved` / `planTranslating` / `planTranslated` / `planTranslateError` | Plan-card lifecycle. |
| `prStatus` (with `status` ∈ `multipleCommits` / `unavailable` / `noPr` / `ready`) | Drive the PR section's view.            |
| `prCreating` / `prCreated` / `prCreateError` / `prUpdating` / `prUpdated` / `prUpdateError` / `prShowUpdateForm` | PR action lifecycle. |
| `transcriptStatsLoaded` / `transcriptsLoading` / `allTranscriptsLoaded` / `transcriptsSaved` / `transcriptsDeleted` | Conversations modal lifecycle. |
| `transcriptsAvailable` (carries a count) | Deferred hydration: rewrite the private drawer's session-count badge and flip the All-Conversations block between its zero-state and populated variants in place. When the count goes from zero to non-zero the page also issues `loadTranscriptStats`, which the initial render deliberately skipped. |
| `planTranslateAvailable` (carries a list of plan slugs) | Deferred hydration: un-hide the translate control on each named plan. |
| `error`                  | Generic error surface.                                       |

### Theming

Theme detection is a one-shot read at page-build time, and the **source is the IDE's live editor background colour** — not the widget theme's "is this a bright theme" flag. Two things are derived from that single colour:

- The page's background variable is set to that exact colour, so the page matches whatever the user's editor looks like rather than a hard-coded near-black or near-white.
- The light-vs-dark palette (foreground / accent / border variable set) is chosen from that colour's **perceived luminance**.

Driving both from one colour is the point: the widget theme and the editor colour scheme are independent settings, and a light widget theme paired with a dark editor scheme previously produced a dark page painted with the light palette — effectively invisible text. Palette and background can no longer disagree.

The resulting CSS variables are baked into the embedded `<style>` block. The page does not subscribe to runtime theme-change events; switching the IDE theme requires re-rendering the page.

**The colour is applied before any content is loaded.** The same colour is set on the hosting component *and* on the embedded browser's initial blank page before the first content load is issued, and the page's own root element is painted with it. The embedded browser keeps the previous document visible until the new one commits its first frame, so a themed blank page is what covers the entire parse-plus-layout-plus-first-paint window of a full memory page. The result is that the first painted frame, any overscroll region, and any sliver the native surface leaves around itself are all theme-coloured, and the blank-to-content navigation never shows white. Before this, that window showed the browser's default white — reported by users as a white border, or a white "L" around the content, lasting on the order of a second.

**Floating elements do not use the page's surface tokens.** The page's ordinary surface variables are very-low-alpha translucent (a few percent). That is correct for an element *stacked* on a known background — a card inside a panel — and wrong for an element *floating* over arbitrary scrollable content, where the page shows straight through and the element's own text collides with whatever scrolled underneath. Anything floating therefore uses opaque tokens instead: a theme-matched opaque surface for the copy-confirmation banner and the export dropdown, and a separate opaque bubble token set for hover hints — because a hint is a different job from a surface. On a light page that bubble is deliberately **inverted** (a dark bubble with light text) for contrast; on a dark page it coincides with the opaque-surface colour. The criterion is "does this element sit on a known background, or on unknown content?". Two absolutely-positioned timeline decorations — the timeline's vertical spine and its per-group dot — were moved off the translucent border and tertiary-text variables onto opaque equivalents defined for both themes for the same reason.

## Behavior

### Bridge encoding

Both directions of the bridge are base64-encoded UTF-8 JSON. This is necessary because the IPC layer between the embedded page's script and the IDE's host is byte-oriented and would otherwise corrupt multi-byte characters (CJK, emojis, en-dashes, bullets) into Latin-1.

The page's send helper encodes its outbound message as UTF-8 bytes, then to a binary string, then to base64. The host's receive handler reverses that. The host's post-to-page helper does the same in reverse: JSON → UTF-8 bytes → base64 → embedded in a script expression where the page decodes the base64-encoded UTF-8 byte sequence into a text string before injecting it into the DOM.

Page-to-host sends are **best-effort**: an encoding or channel failure inside the send helper is swallowed rather than thrown back into the handler that called it. Previously a send that failed took the surrounding interaction handler down with it, so one unencodable payload could abort the rest of a click's work.

### First content load

The page's content is not loaded as soon as the view is constructed. The constructor's caller only attaches the view to its parent *after* construction returns, and the IDE then takes several further turns to mount the editor into the tab hierarchy — so loading immediately meant the embedded browser began painting against a zero-sized surface, and the visible symptom was content scrunched into the top-left corner of an otherwise blank tab, slowly catching up over a second or two.

The load therefore waits until the hosting surface is **both attached to a shown ancestor and non-zero-sized**. Both conditions are required: mounting flips "shown" first, while width and height are still zero, and lays out later. Three triggers race to satisfy them and all three are idempotent (only the first wins):

1. A size-change notification on the hosting surface.
2. A shown-state-change notification on the hosting surface. This is the one a *reused* surface hits — a surface handed back at the same size never reports a size change at all.
3. An immediate check at construction time, for the fast path where a reused surface arrives already sized and already shown.

A last-resort timer fires **1500 ms** later. It is deliberately not a "load anyway" fallback: if real bounds have arrived by then it loads cleanly, and if the surface is *still* zero-sized it **does not load** — it logs a warning and installs a post-load size watcher instead, leaving the readiness path armed so the first genuine size change loads normally. Loading into a zero-sized surface is worse than waiting, because the browser does not re-render on its own when the surface later becomes non-zero, which would strand the tab permanently blank.

Once the first load has gone through, a size watcher stays installed and forwards every later size change down to the embedded browser, so a background tab that is mounted long after construction, or a tool window the user resizes, still learns its true viewport.

A **full re-render that is requested before the first load has completed is latched rather than issued**, and fired once on load-completion. Issuing it immediately meant a second navigation arriving while the browser was still parsing the first page: the first load was aborted and restarted, and the user saw the tab flash through blank → partial → blank → rendered.

Immediately after the first load completes, the host fires a **one-shot viewport-changed notification** — the same signal a real resize sends — plus a layout revalidate and repaint. This exists because a freshly built embedded browser does not reliably fill its whole component area on its first paint: the native view's visible rect can lag the real component size, leaving the top strip of the tab showing the wrapper's background until some later layout event forces a repaint. The earlier workaround for this was to perform a **second full content load** once the deferred data arrived, which did force the repaint but cost a visible 300–400 ms flash. The notification replaces that load; the flash is gone.

### Deferred hydration

Two of the page's inputs — the stored-transcript set and the plan-translate set — drive only cosmetic extras (the conversations drawer's count and controls, and the per-plan translate control). Gathering them is I/O-shaped and was previously done inline on the UI thread during construction, once per tab open. They are now gathered on a background thread **after** the page has been built and its load scheduled, and applied **by message** (the two events above), never by a second content load.

That is why the rendered page ships **both** variants of the All-Conversations block with the inapplicable one hidden, and always emits the per-plan translate control (hidden when the plan is not eligible): hydration only has to flip hidden state in place. Two earlier statements — that the "Manage" button is present *only* when transcripts exist, and that the translate control is present *only* when the plan qualifies — describe the old markup and are corrected below.

Nothing is sent at all when both sets come back empty.

Two parking rules govern when a hydration is actually delivered:

- **Arriving mid-load:** if the page's first load has not completed yet, the hydration is parked and drained on load-completion, on the same transition that drains a parked refresh.
- **Arriving while the user has unsaved edits:** the hydration is held, not dropped. The page reports its unsaved-edit state to the host, and while that flag is set the hydration waits; it is drained on the next persisted-save acknowledgement, so a user who started typing before the background scan returned still gets the transcript and translate controls revealed as soon as their next save lands.

### In-document hover hints

The embedded browser surfaces **no native tooltips**, so a hint attached to an element the ordinary way shows nothing. Hints are therefore drawn inside the document, by a single delegated hover handler that covers every hinted control on the page (including content inserted by later in-place section updates):

- The bubble appears after a **350 ms** hover dwell and is removed on hover-out.
- It is placed **below** the hovered element, offset slightly, and clamped horizontally so it never runs off either edge of the viewport.
- On an element's **first** hover, its native hint text is moved into a private attribute and the native attribute is removed, so no system tooltip can compete. A live native hint always wins over the cached copy, which is what keeps hints that are rewritten at runtime (the regenerate control, the delete/restore toggle, plan links) correct instead of pinned to their first-hover text.
- **Invariant:** because of that migration, page code must **not** read an element's native hint attribute at runtime — after the first hover it is gone. A reader must consult the private attribute, falling back to the native one.

### External link interception

The embedded page may render links into properties (the cloud-doc URL, the published-plan URLs, the PR URL). Clicks on any `http://` or `https://` link are intercepted at the host's request layer and re-routed through the IDE's external-browser opener. The embedded page never navigates internally — it has no session/cookies and would render a broken page if it tried.

### Topic interactions

A topic card has a clickable header that toggles its body (callouts for "Why this change", "Decisions behind the code", "What was implemented", "Future enhancements", "Files"). The right side of the header carries a pencil (edit) and a trash (delete) action. Clicking either action does **not** also toggle the body — the page checks for an action click and skips the toggle.

The "Expand All / Collapse All" button at the top of the Memories section flips every card.

Edit-in-place opens an inline form with prefilled values from the topic's data attribute (the original topic JSON is embedded in `data-topic` so the form does not need a host roundtrip to populate). Saving sends `editTopic`; the host persists, re-renders the card, and posts `topicUpdated` so the page swaps the card body in place. The display index used for numbering is recomputed by the host on every edit and may differ from the operation index — the operation index is what the host uses to find the topic in the tree.

Delete prompts a host-level Yes/No dialog (via the host, not in-page) and on confirm sends `deleteTopic`.

### Plan interactions

A plan row shows the plan title (clickable, opens a preview), a metadata sub-line (`<slug>.md · edited N times`), and a row of action buttons:

- A globe (translate) button is **always** emitted for every plan, and is hidden unless the plan slug is in `planTranslateSet`. It is therefore initially hidden on every plan (the set is not known at build time) and revealed in place by the `planTranslateAvailable` hydration.
- A pencil (edit) button toggles an inline textarea pre-loaded by `loadPlanContent` and saves via `savePlan`.
- A trash (remove) button confirms and disassociates via `removePlan`.

Below the plan list, an "+ Associate Plan" button sends `associatePlan`; the host opens a chooser of available unassociated plans. The page does not maintain its own list of plans — the host re-renders the plans block on completion.

After save or translate, the host rewrites the plan's title from the markdown's first `#` heading and re-renders the plans section.

### Pull-request flow

The PR section starts in a "Checking PR status..." state. The page sends `checkPrStatus` on mount; the host replies with one of:

| Status            | Page renders                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `multipleCommits` | Informational message: PR creation is disabled because the branch carries N > 1 commits. |
| `unavailable`     | Informational message: gh is missing or unauthenticated.                                  |
| `noPr`            | "Create PR" button; clicking opens the embedded form.                                     |
| `ready`           | The PR's link, title, and an "Edit PR" button.                                            |

The embedded form has Title and Body fields and Cancel / Submit buttons. On Submit, the page sends `createPr` (no-PR state) or `updatePr` (ready state).

This used to be described simply as "the host runs the operation and posts back `prCreated`/`prUpdated` or `prCreateError`/`prUpdateError` (surfaces an IDE error dialog)" — that undersells what actually happens on a push rejection; see the failure path below, which now runs *before* the operation.

**Create-PR failure path (force-push gate).** Before the host reaches the actual PR create/update call, it first pushes the branch. If that push is rejected as a non-fast-forward, the host runs a divergence check and shows a force-push confirmation gate to the user; the outcome is one of blocked, declined, or confirmed-then-force-pushed. Only after this gate resolves (or the push otherwise succeeded) does the flow proceed to the PR create/update call. The full mechanics of the divergence check and the confirmation gate are owned by the force-push-gate spec (264) — this view is one of the gate's call sites, not where the gate itself is defined.

**Notable silent-failure gap:** whatever outcome the gate produces — blocked, declined, or a genuine push/PR-API failure — the host posts a `prCreateError` (or `prUpdateError`) event carrying a human-readable message. The page's handler for that event does **not** render that message anywhere on the page — it only re-enables the submit button and re-enables Cancel. There is no toast, banner, or inline error text for a blocked/declined/failed push in the embedded form. The only path that surfaces a real, visible IDE error dialog is an *uncaught exception* elsewhere in the same operation (e.g. the PR-lookup or PR-API call itself throwing) — that outer catch both posts the `prCreateError`/`prUpdateError` event **and** shows a modal IDE error dialog. So a blocked force-push, a declined force-push, or any non-fast-forward push failure is effectively silent in this embedded form: the user sees only a reset submit button, with the actual reason available solely in the log.

For the update path, the page first sends `prepareUpdatePr`; the host fetches the current PR's title and body, splices a freshly built memory-markdown block into the body using a fenced marker, and posts `prShowUpdateForm` with the prefilled title and the spliced body.

### End-to-End Test section

The section has three states:

| State                  | Rendering                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Not yet generated      | Placeholder paragraph + "Generate" button.                                             |
| Generating             | The Generate button is replaced by a loading state (driven by `e2eTestGenerating`).    |
| Populated              | One collapsible card per scenario, plus three top-row actions: Edit, Regenerate, Delete. |

Edit opens an inline form for hand-editing the scenarios (title, preconditions, steps, expected results) and saves via `editE2eTest`. Delete confirms via host dialog and clears.

### All-Conversations private zone

Always present; layout is identical regardless of whether transcripts exist. Every element below is always emitted, and the ones that do not apply to the current transcript count are hidden rather than absent — so the deferred hydration can flip between the two appearances in place:

- A "PRIVATE" watermark (a visual element making the zone visually distinct).
- A zero-state paragraph — visible only while the transcript count is zero.
- A "Manage" button, a description line, a stats line (populated by `loadTranscriptStats`), and a privacy reassurance line — visible only while the transcript count is non-zero.

Because the transcript set is not known when the page is built, a tab always opens showing the zero-state and switches to the populated appearance when the hydration lands. The stats request is issued only once the count is known to be non-zero.

The Manage button opens a modal that calls `loadAllTranscripts`, displays a tabbed view per session, lets the user delete entries inline, and posts the result via `saveAllTranscripts` (Save All) or `deleteAllTranscripts` (Mark All as Deleted).

### Push button

The button now lives in the ship bar's Jolli card, not the header. Its label is `"Share in Jolli"` when no cloud doc has been pushed yet, and `"Update on Jolli"` when one has (previously labeled `"Push to Jolli"` in the unpushed state). Click sends `pushToJolli`; the page transitions through `pushStarted` (button: "Pushing...", disabled), `pushSuccess` (button: "Pushed ✓" for 2 s, then back to "Update on Jolli"), and `pushFailed` (button: "Push Failed" briefly, then back to "Share in Jolli").

On `pushSuccess` with a returned URL, the page no longer inserts a new properties-table row (that row no longer exists — see Page structure); instead it updates the Jolli card in place: it inserts (or replaces) a link block carrying the returned URL and any pushed-plan URLs, flips the card's status chip from "Not shared" to "Synced", and removes the card's "lives only on your machine" subtitle.

### Fallback rendering

If the embedded HTML view cannot be instantiated, the host falls back to a read-only plain-text component that displays the same memory rendered as markdown. None of the interactive commands are available in the fallback. This covers an environment with no embedded-browser capability at all *and* every way the embedded-browser pool can refuse a checkout (spec 302); all of them are indistinguishable to the user.

## State Transitions

```
[view constructed with summary S]
  Read the live editor background colour once
    → theme the host surface, the pre-content blank page, and the page's --bg
    → pick the light/dark palette from that colour's luminance
  Build the page HTML (both transcript variants emitted; every plan's translate control emitted, hidden)
  Hold the content load until the host surface is attached-and-shown AND non-zero-sized
    [size change | shown change | already ready at construction] → load (first wins)
    [1500 ms elapsed, bounds now real]  → load, logged as a forced fire
    [1500 ms elapsed, still zero-sized] → DO NOT load; warn; arm the size watcher
  Start gathering the transcript set and the plan-translate set on a background thread

[page load completes]
  Drain a parked refresh, if any
  Drain a parked deferred hydration, if any
  Fire the one-shot viewport-changed notification + revalidate/repaint
  Install/keep the size watcher that forwards later size changes to the browser

[page loaded with summary S]
  Render structure (Conversations zone, Header [reference chip + title], Token/cost banner,
                    Ship bar [PR card + Jolli card], Plans, E2E, Source Commits, Memories, Footer)
  Send checkPrStatus

[background gather returns]
  [both sets empty]        → send nothing
  [page not loaded yet]    → park; drain on load-completion
  [unsaved edits pending]  → hold; drain on the next persisted-save acknowledgement
  [otherwise]              → transcriptsAvailable(count) and/or planTranslateAvailable(slugs)
                             → flip hidden state in place; if count 0→N, send loadTranscriptStats

[user clicks topic header (not on action)]
  Toggle topic body collapsed/expanded

[user clicks Expand All / Collapse All]
  Flip every topic body

[user edits a topic, clicks Save]
  Send editTopic
  Receive topicUpdated → swap card body in place

[user clicks topic delete, confirms in host dialog]
  Send deleteTopic
  Receive topicDeleted → remove card

[user clicks Generate on E2E section]
  Send generateE2eTest
  Receive e2eTestGenerating → show loading
  Receive e2eTestUpdated → replace section body

[user clicks Share/Update in Jolli (ship bar)]
  Send pushToJolli
  Receive pushStarted → button: "Pushing...", disabled
  Receive pushSuccess → button: "Pushed ✓"; update Jolli card (link block, synced chip, drop subtitle)
  Receive pushFailed → button: "Push Failed"

[user clicks Manage in Conversations zone]
  Open modal
  Send loadAllTranscripts
  Receive allTranscriptsLoaded → render tabs and entries

[user edits transcripts, clicks Save All]
  Send saveAllTranscripts(entries)
  Receive transcriptsSaved → close modal, refresh page
```

## Notable Behavior

- **The page is rendered, not bound.** The host builds the entire HTML on every refresh and reloads the page. Single-topic and single-section updates are exceptions — the host ships back rendered HTML fragments, and the page swaps them in place rather than rebuilding the whole document.
- **The bridge is base64 in both directions.** This is not optional. Without it, multi-byte characters (CJK, emojis, en-dashes) are silently corrupted by the IPC layer.
- **The header no longer carries the push/update button.** It moved into the ship bar, alongside a new PR card, so the header's remaining actions are Details / Share link / Export (Copy Markdown, Save as Markdown File) — read-oriented and metadata actions, not the mutating push action. (Notable; header restructure.)
- **The token/cost banner is tree-aggregated, like the properties table's stats.** A squash/amend/rebase memory's usage lives on its folded children; the banner walks the whole tree rather than reading a scalar off the root, so it never under-reports a consolidated memory's usage.
- **Saving as a Markdown file is a read-only export, unlike every other inbound command with a similar name.** It bypasses the write-command gate entirely, so it works on a stale or foreign (read-only) memory where mutating commands would be refused.
- **A blocked or declined force-push during Create-PR is effectively silent in this embedded form.** The host posts an error event with a real message, but the page's handler only resets the submit button — no visible text appears on the page. Only an uncaught exception elsewhere in the same flow produces a real IDE error dialog. (Notable; see the Pull-request flow behavior above and the force-push-gate spec, 264, for the gate's own mechanics.)
- **Theme is one-shot.** A switch from light to dark in the IDE during the page's lifetime does not restyle the page; it requires re-opening the view.
- **Palette and background come from the same colour, on purpose.** The light/dark palette is chosen from the perceived luminance of the live editor background rather than from the widget theme's brightness flag. The two settings are independent, and the old pairing produced a dark page rendered with the light palette — unreadable text — for anyone running a light widget theme with a dark editor scheme. (Notable; fixes a real unreadable state.)
- **The pre-content blank page is theme-coloured, and that is what removes the white flash.** The embedded browser keeps the old document painted until the new one commits a frame, so theming the *blank* page (and the host surface, and the page's root element) is what covers the whole parse-and-first-paint window. Theming only the finished page would leave the default white visible for exactly as long as the page takes to render. (Notable.)
- **Floating elements deliberately do not use the page's surface tokens.** Those are a few percent alpha, which reads correctly on a known background and fails over arbitrary scrolled content. Floating elements use opaque theme-matched tokens instead, and hover hints use their own opaque bubble token set — deliberately inverted on a light page — rather than a surface at all. Two absolutely-positioned timeline decorations were moved onto opaque equivalents for the same reason. (Notable.)
- **The content load waits for real bounds, and the timeout deliberately refuses to load without them.** Loading into a zero-sized surface produced a permanently blank tab, because the browser does not re-render on its own when the surface later becomes non-zero. So the last-resort timer loads only if bounds have arrived; otherwise it warns, installs the size watcher, and leaves the readiness path armed. The failure mode this replaced was content scrunched into the top-left corner of an otherwise blank tab. (Surprising; intentional.)
- **A viewport-changed notification replaced a second full page load.** The first paint of a freshly built embedded browser does not reliably fill the component, and the old fix was to load the whole page again once the deferred data arrived — which worked, at the cost of a visible 300–400 ms flash. The notification (plus a layout revalidate/repaint) achieves the same repaint with no navigation and no flash. (Notable; the flash is gone, which is why the page now ships both hidden variants instead.)
- **The page always opens claiming zero transcripts and no translatable plans.** Both sets are gathered after the page opens, so the first frame of every tab shows the conversations zero-state and no translate controls, and they appear a moment later. That is the price of getting two I/O-shaped reads off the UI thread on every tab open. (Surprising; intentional.)
- **A hydration that arrives while the user is typing is held, not dropped.** It waits for the next persisted-save acknowledgement and is delivered then, so the controls still appear rather than being lost until the next full render. (Notable.)
- **Hover hints are drawn in the document because the embedded browser has no native tooltips**, and the first hover of an element *moves* its native hint into a private attribute. The consequence is an invariant: page code must never read the native hint attribute at runtime, because after the first hover it no longer exists. A live native hint always wins over the cached copy, which is what keeps hints rewritten at runtime from being pinned to their first-hover text. (Notable; a latent trap for future page code.)
- **Page-to-host sends are best-effort.** A send failure is swallowed inside the send helper instead of propagating into the interaction handler that called it, so one unencodable payload can no longer abort the rest of a click's work. (Notable.)
- **External URLs always leave the panel.** Clicks on `http(s)` links are intercepted at the host layer and routed to the system browser.
- **The operation index outlives the display index.** When topics are sorted by date or major-before-minor, the displayed numbering may differ from the index used for edit/delete; the page must round-trip the operation index through the data attribute, never the position in the rendered list.
- **Plan dedup picks the most recent.** When the same plan slug appears in multiple child memories of a squashed tree, the copy with the latest `updatedAt` wins; older copies are dropped silently.
- **The Conversations zone is always visible, but its privacy line is not.** The zone itself — watermark, title, and a zero-state paragraph — renders whether or not transcripts exist, unlike "no plans" or "no E2E test" which collapse to a placeholder inside their section. The privacy reassurance line, however, belongs to the populated variant and is hidden while the transcript count is zero, so the privacy guarantee is advertised only once there is captured data to guarantee it for. (Corrects an earlier claim that the zero-state stub carries the privacy line.)
- **The Properties row "Conversations" hides when zero turns.** Other rows always render even with zero/unknown values; this one alone collapses when not applicable.
- **The push-success link block is added dynamically on first successful push, now inside the ship bar's Jolli card rather than the properties table.** It is not pre-rendered and is constructed by the page's JS on `pushSuccess`, which also flips the card's status chip to "Synced" and drops its "not shared" subtitle. Subsequent full renders persist all three because the underlying memory now carries the cloud URL. (Updated from the prior properties-table-row description — see Page structure.)
- **The PR section is the only section with three orthogonal failure modes** (multiple commits / unavailable / no-PR-yet) — the page handles all three by replacing the action area's contents with the right informational text or the right action button.
- **End-to-end test scenarios round-trip as fully-formed objects.** Hand-edits in the form are sent back as a complete `scenarios` array, not as deltas — the host replaces the array.
- **Topic data is embedded inline.** The topic JSON is in a `data-topic` attribute on the card, so opening the edit form does not require a host roundtrip to populate fields.
- **The fallback path is plain text.** When the embedded HTML view cannot start, the host shows a markdown rendering as plain text — none of the inbound commands work there.
- **The transcript and topic host actions are cross-process round-trips.** Loading all transcripts and replacing/clearing them resolve through the shared summary-store's transcript read and batched transcript write; topic edit and topic delete resolve through the shared summary-tree's topic-update and topic-delete operations. None of the four is computed in the host process any more, so each one costs a subprocess or daemon round-trip and can fail as a transport error rather than a storage error. The page's command names, payloads, and event lifecycle are unchanged.
- **A leaf memory no longer has a Source Commits section.** The source-commit list this page renders is derived from the shared tree helper, whose rule is "leaf nodes only, root excluded". A plain single-commit memory is its own root and has no leaves, so it yields **zero** source commits — where the retired host-side rule (any node carrying its own topics, root included) yielded one. The section, which renders only when the tree has more than one source commit, was already hidden for such a memory; what changed is the count the rest of the page derives from the same list. (See the summary-tree spec for the rule and the behavior change.)
- **Push triggers an asynchronous orphan-doc cleanup.** When a memory carries `orphanedDocIds` (cloud documents that the user previously pushed and that are now superseded), the host deletes them after the main push succeeds and rewrites the memory to drop the cleared IDs. The page does not see this directly — it only sees the updated ship-bar Jolli card. This orphan cleanup, along with the plan-then-summary push ordering, now lives in the extracted share core (share-to-Jolli spec) — the seam moved out of the viewer with no change to the page's observable behavior.

## Shared Behavior

- **Storage** — the source of the input memory and the destination for every persisted edit (topic, plan, e2e guide, transcript). Transcript reads/writes and topic update/delete reach it over the shared summary-store and summary-tree operations rather than through host-local code.
- **Summary tree structure** — owns the source-node rule this page's Source Commits section and drill-down depend on, including the change that a leaf memory now yields zero source commits.
- **Share-to-Jolli core** — the `pushToJolli` action delegates to the reusable share core (push plans, fold plan URLs into the summary, push the summary, persist, and run the orphaned-doc cleanup, emit telemetry). The implementation seam moved out of the viewer into that shared core so the branch-level Create-PR view can reuse it verbatim; the viewer's own event lifecycle (`pushStarted`/`pushSuccess`/`pushFailed`) is unchanged even though the button's location and labels have since moved to the ship bar (see Page structure / Push button). Binding-required, re-auth, and plugin-outdated recovery UI stays viewer-side. See the share-to-Jolli spec.
- **PR service** — handles `checkPrStatus`, `createPr`, `prepareUpdatePr`, `updatePr`.
- **Force-push gate** — the divergence check and confirmation dialog invoked by the Create-PR failure path when a push is rejected as non-fast-forward; its own mechanics (safety inspection, gate outcomes, the actual force-push) are owned by that spec (264), not documented here.
- **Plan service** — owns the available-plans chooser and the associate / unassociate flows.
- **One-shot generation bridge (spec 292)** — the seam `generateE2eTest`, the recap generation, and `translatePlan` are delegated over, because this host cannot run generation in process. It owns the request/response contract, provider routing, and prompt assembly; this view only serializes the inputs and renders the result.
- **Virtual-file editor wrapper** — the surface that this view becomes the body of (spec 121). It is also the party that borrows the embedded browser this page is loaded into and hands it back on tab close.
- **Embedded-browser pool (spec 302)** — supplies the reused embedded-browser instance this page loads into, and defines the lease through which the message bridge and the navigation/load observers must be attached. A refused lease is one of the ways the plain-text fallback below is reached.
- **Memory reference identifier and copy chip (spec 301)** — owns the identifier the header chip renders (here the always-present variant, so a never-pushed memory still shows a reference), and everything the chip does when activated. This page owns only its position in the title.
- **System clipboard / external browser** — destinations for `copyMarkdown`, `downloadMarkdown`, and external link clicks.
- **Native file-save dialog** — the destination `downloadMarkdown` hands off to (an IDE-native chooser, not a page-rendered affordance).
