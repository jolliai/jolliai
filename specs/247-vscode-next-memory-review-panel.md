# 247 — VS Code Working-Memory Review Panel

## Topic Statement

A singleton editor-area webview that lets the user review — and edit — exactly the memory their next commit will save, mirroring the sidebar's next-commit draft selection and rendering a live, debounced, section-scoped preview (proposed title, diffstat, token meter, detected ticket) alongside the conversation / context / file rows. It is **not** a second selection state: every toggle and command it emits is routed through the same host handler the sidebar uses, so both surfaces mutate the identical underlying stores and can never drift.

## Scope

**In scope:**

- The singleton lifecycle: create-or-reveal, the ready handshake, re-show, and disposal cleanup.
- Registration as a broadcast target so the host's sidebar data pushes fan out to this panel too.
- The four independently-derived preview sections and the data each is computed from.
- The mapping from each selection-toggle type to the minimal set of sections to recompute.
- The debounce that coalesces a burst of toggles into one refresh, accumulating the union of pending sections.
- The full-refresh triggers (ready handshake, re-show) versus the section-scoped refresh (a toggle).
- Independent settling of the sections so one section's failure never blocks the others.
- The token meter's exact-percentage three-segment bar and its "not reported" degradation.
- The two distinct per-row affordances: a reversible exclude toggle (posts the same selection messages the sidebar posts) and a separate destructive remove/discard affordance.
- The AI context-relevance overlay: the pre-commit ranking against the selected-file change set, its persistence (the full per-item verdict list + change fingerprint) for post-commit reuse, the per-row tier chips / "Excluded" badge / ✨ reason line / rank-sorted ordering / "Analyzing…" placeholder, the Include/dismiss affordance (a `dismissed` flag, not a deletion), the mirroring of the same overlay to the sidebar on every outcome, the memoization and monotonic-generation guard against stale overwrites, the empty-file-set short-circuit, and the fail-open contract.
- The footer commit affordance and its enablement rule.

**Out of scope (boundaries — referenced, not duplicated):**

- The relevance-ranking algorithm, its LLM call, the change-fingerprint derivation, and its fail-open contract — invoked here, owned by [258 — AI Context-Relevance Filtering].
- Persistence of the full AI relevance verdict list + change fingerprint, the cross-process file lock all writes serialize under, and the dismiss/clear operations — owned by [188 — Commit Exclusion Selection Store]. This panel writes through those APIs.
- The LLM commit-title generation algorithm and the working-tree diffstat computation — invoked here, owned elsewhere.
- The selection stores this panel writes through: the commit-exclusion store for conversation/plan/note/reference/file inclusion (spec 188) and the files selection store.
- The token breakdown extraction (per-turn input / output / cache-creation) and cost model (spec 243).
- Transcript-cutoff attribution, which the exclusion pass feeds (spec 36).
- The sidebar message protocol whose message shapes this panel reuses verbatim (spec 101).
- The webview's exact CSS/layout.

## Data Contracts

### Preview sections

The preview has five independently-derived sections:

| Section    | Derived from                                                                        |
| ---------- | ----------------------------------------------------------------------------------- |
| `title`    | An LLM-generated commit message over the *selected* files.                          |
| `diffstat` | Working-tree diff statistics over the *selected* files.                             |
| `tokens`   | Aggregated token usage over the *selected* conversations.                           |
| `ticket`   | An issue key detected from the *selected* context (reference) rows.                 |
| `context`  | The AI context-relevance overlay: per-item tier + reason + soft-exclude, ranked against the *selected* files' change set. |

"Selected" throughout means the item is currently *included* in the next memory — i.e. not excluded in the selection stores.

### Toggle → sections mapping

A selection change recomputes only the sections it actually feeds:

| Toggle                     | Sections recomputed          | Rationale                                                                                          |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| File selection             | `title` + `diffstat` + `context` | Files feed the title, the diffstat, and the change signal the relevance ranker scores context against. |
| Conversation selection     | `tokens` only                | Conversations feed only the token meter — never the title, so the LLM title is **not** re-run.     |
| Reference selection        | `ticket` only                | Only a reference row carries the detected ticket; recomputed via a cheap lookup, not the LLM.      |
| Plan / note selection      | *(none)*                     | Nothing derived keys off plan/note selection.                                                      |

The full refresh (ready handshake and re-show) recomputes `title` + `diffstat` + `tokens` + `context`.

### Preview push messages (host → panel)

The panel receives, in addition to the sidebar data feeds it shares (conversation / context / file rows, worker-busy):

- A **title** message carrying the proposed title, optionally the target branch (for the "commit next on `<branch>`" line), and optionally the detected ticket inline; or, on failure, an error string.
- A **ticket** message carrying just the detected ticket (or nothing, to clear the line). The client merges it into the last-rendered title.
- A **diffstat** message carrying the diff statistics and optionally the branch.
- A **token-stats** message carrying the aggregated breakdown (input / output / cache-creation), a total, and how many of the selected conversations actually reported usage.
- A **relevance** message carrying, per context item, its id, its tier (`high` / `mid` / `low`), its one-line reason, and whether it is soft-excluded. An empty list clears the overlay. The identical payload is also mirrored to the sidebar (spec 101) on every ranking outcome; the sidebar consumes only the id / soft-exclude / reason fields.
- An **analyzing** message (boolean) that toggles a header "Analyzing…" placeholder while a pre-commit ranking is in flight.

And, panel → host, a **dismiss-AI-exclude** message carrying a context kind + key, emitted by the Include affordance on a soft-excluded row.

## Behavior

### Singleton lifecycle

- **Create-or-reveal.** Showing the panel reveals the existing instance if one is open; otherwise it creates the single instance. The instance is module-scoped — there is at most one review panel per window.
- **Ready handshake.** A freshly created panel does not receive any preview push until its client signals readiness; on that signal the host runs a **full refresh** (title + diffstat + tokens + context) and also forwards the readiness signal into the shared sidebar-broadcast machinery so the sidebar data feeds (conversation / context / file rows) are delivered to this panel too. Gating on readiness avoids the race where a push sent before the client's listener is attached is silently dropped.
- **Re-show.** Revealing an already-mounted panel does not re-fire readiness, so the host pushes a full refresh directly on re-show (the listener already exists — no race).
- **Broadcast registration.** On open the panel registers itself as a broadcast target so every host→sidebar data push is mirrored to it; on disposal it unregisters, cancels any pending debounce, and clears the accumulated pending-section set. Cleanup is safe under double-disposal and only clears the singleton pointer if it still refers to this panel.
- **Disposal must use a webview reference captured at open time — not the live accessor.** The panel's live webview accessor throws once the panel is torn down, and disposal fires *exactly* at teardown. If the disposal cleanup re-read the live accessor, that read would throw and abort the callback **before** it cleared the singleton pointer — leaving a disposed panel lingering as the singleton, so the next open would reveal a dead webview and silently do nothing. The cleanup therefore unregisters the broadcast target using a webview value **captured once when the panel opened**, so it never touches the throwing accessor. (This panel is the only one whose disposal callback must reference the webview at all — it is the only one that registers a broadcast target — which is why only it needs this care.)

### Selection routing (no second state)

Every gesture the panel emits is handed to the **same** host outbound handler the sidebar's own webview uses, in the same extension-host process:

- A selection toggle (file / conversation / plan / note / reference) posts the *identical* message shape the sidebar posts, so it flows into the same selection stores (spec 188) and both surfaces re-render from the resulting data push.
- The reused commit / add-plan / add-note / add-snippet command dispatches, and plan/reference actions, are handled identically to the sidebar.
- A toggle additionally triggers a section-scoped preview refresh (below); non-derived gestures do not.

Because there is no panel-private selection state, toggling a row here and toggling the same row in the sidebar always agree.

### Debounced, section-scoped refresh

When a toggle changes a derived input:

1. The toggle is forwarded to the host handler first (so the stores update).
2. The sections it invalidates (per the mapping above) are added to a pending set.
3. A single timer (~400 ms) is (re)armed. A burst of toggles therefore accumulates the **union** of their pending sections rather than only the last toggle's — toggling a file then a conversation refreshes title + diffstat ∪ tokens.
4. When the timer fires, the pending set is drained and exactly those sections are recomputed and pushed.

This coalescing exists so rapid checkbox clicks do not fire an LLM title call per click.

### Independent section settling

A refresh computes its due sections concurrently and lets each settle independently: one section failing (a git error in the diffstat, a flaky title generation, a token-read failure) leaves the others unaffected — each pushes its own message on success and simply leaves its section empty/absent on failure. The branch is resolved once per refresh and threaded into the title and diffstat display lines (the title generator resolves the branch again internally for its own use; the value passed in is display-only). Every push targets this specific panel's webview so it is a safe no-op after disposal.

### Selected-files derivation

The title and diffstat are computed over the repo-*relative* paths of the currently-included files (not absolute paths), matching how the files store keys its selection — so the paths handed to the LLM and to git are the same ones a file-row toggle mutates, and no absolute workspace path leaks into the model prompt.

### Token meter

The token meter renders a three-segment horizontal bar (input · output · cache) at **exact** percentages:

- The denominator is the *breakdown sum* (input + output + cache-creation), not the reported scalar total (which can exceed the breakdown when a session reports only a scalar count), so the three segments fill the bar exactly. The cache segment absorbs the rounding remainder so the widths always sum to 100.
- When there is a scalar total but no per-segment breakdown, the bar degrades to a single full-width input segment rather than fabricating a split.
- When nothing was reported for the selection, the meter shows an honest "token usage not reported" note (or nothing at all when the selection is empty) rather than a zero bar.
- Only conversations from sources that actually carry per-turn usage contribute to the "reporting" count; the headline total uses the reported scalar. See spec 243 for the extraction and cost model, and spec 36 for how the exclusion pass scopes which turns are in play.

### Per-row affordances (two distinct controls)

Each conversation, context, and file row exposes hover actions:

- **Exclude toggle (reversible).** A ✕ / + control that flips the row's *inclusion* in the next memory. It posts the **same** selection-toggle message the sidebar posts (routing through the exclusion store, spec 188), so it is fully reversible and shared across both surfaces. It is present on every row kind.
- **Destructive remove/discard (context + file rows only).** A separate trash/discard control that is *not* an inclusion toggle:
  - On a **context** row it dispatches the pre-existing remove-plan / remove-note / ignore-reference command (with the command's own host-side confirm), the same delete path the sidebar's inline trash uses.
  - On a **file** row it dispatches the discard-file message carrying the raw porcelain status columns the discard handler routes on (not just the collapsed status letter).

These are two independent affordances: excluding an item leaves it in the working area for a later commit; removing/discarding it deletes the underlying plan/note/reference row or reverts the file change.

On a **soft-excluded** context row the destructive trash control is replaced by an **Include** affordance (see the overlay below) — removing an item the AI already dropped from the summary would change nothing, so the useful action there is to bring it back, not to delete it.

### AI context-relevance overlay

The panel decorates each context (plan / note / reference) row with an AI relevance overlay. It is an **additive display layer** on top of the user's own selection, not a second selection state.

**Ranking and persistence.** When the selected-file set changes (and on full refresh), the panel builds a change signal from the currently-*included* files (repo-relative paths, no commit message) and asks the relevance ranker to score every user-kept context item (see [258]). This is the authoritative-style path: it reads full registry content (like the post-commit worker) and **persists the FULL per-item verdict list** — every ranked item, kept *and* excluded — plus a file-based change fingerprint to the exclusion store (spec 188). Each persisted entry carries: the item's kind, its key, its relevance tier (`high` / `mid` / `low`), the one-line reason, and the AI's **original exclude decision** (written once by the ranking, never rewritten). The single full list is what lets the post-commit worker's fingerprint-reuse path rebuild **both** the effective exclude set **and** the kept items' tier + reason (recorded on the summary's context-relevance field) without re-running the LLM. Because the fingerprint is keyed on the file set only, the worker reuses this exact ranking verbatim when its fingerprint matches — one ranking, panel result == final. Nevertheless the **pre-commit rank is non-authoritative**: the post-commit worker always recomputes on a fingerprint miss, and its recompute is the authoritative result; the worker also **clears this AI layer** after consuming it.

The persisted list is filtered to entries that have a **non-empty reason OR are auto-excluded** — a fresh ranking's excluded (tier `low`) items must persist their exclusion even when the model gave no reason, or the reuse path would silently keep an item the fresh path drops. Entries with an empty reason that are *not* excluded are the fail-open keep-all placeholders (tier `mid`, reason `""`); they are dropped so the reuse path never stamps a fabricated tier onto the artifact.

**Cross-process serialization.** All writes to the exclusion file — the panel's persist, the user dismiss, and the worker's post-consume clear — serialize under a dedicated **cross-process file lock** (spec 188). This is new: the worker previously only *read* this file and never wrote it. The lock exists precisely because the pre-commit panel and the post-commit worker are separate processes that both mutate the AI layer, and a lost update would either strand a stale ranking or drop the user's dismiss.

**Empty file set.** With no included files there is no change signal, so the panel posts an empty overlay (to both the panel and the sidebar) and ranks nothing (ranking against an empty signal would spuriously exclude everything). A transient empty snapshot does **not** clear the memoized ranking — same files later hit the cache again rather than re-flashing "Analyzing…".

**Per-row rendering.** Each row gains a second meta line, but **only when the item carries a real verdict** — a non-empty reason, or a soft-exclude. The meta line holds:

- A **tier chip** — High / Med / Low — reflecting the item's relevance band; or, when the item is soft-excluded, an **"Excluded"** badge in place of the tier chip.
- A **✨ reason line** carrying the ranker's one-line explanation (rendered only when a reason is present).

A fail-open keep-all result carries a tier (`mid`) but an **empty reason**, so its row renders no chip and no reason line — painting a chip there would stamp a bogus "Med" on every row after any ranking failure. This mirrors the summary panel and the sidebar, which gate their chips on a non-empty reason identically, so all surfaces fail-open the same way: keep everything, label nothing.

Rows are **sorted by rank**: High → Med → Low/unscored → Excluded, so the most relevant read first and soft-excluded items sink to the bottom. A soft-excluded row shows an **Include** button (instead of the trash) whose click dismisses the AI's suggestion.

**Analyzing placeholder.** While a ranking call is in flight the panel shows a ✨ "Analyzing…" placeholder in the panel header (not a list row). It is **display-only**: it does **not** gate the commit button (which stays governed only by included-file count and worker-busy), because the pre-commit ranking is a decorative preview and gating the commit on it could block for up to the rank timeout.

**Include / dismiss.** Clicking Include on a soft-excluded row:

- Optimistically flips the row back to non-excluded in the panel (falling back to its normal tier + reason — the dismiss vetoes only the exclude *action*, not the AI's judgment, so nothing the AI concluded is lost), and
- Posts the dismiss message to the host, which sets the **`dismissed` flag** on that one entry in the persisted list (spec 188). The AI's original exclude decision, tier, and reason are left intact; the *effective* exclude decision becomes (`excluded` AND NOT `dismissed`), so the post-commit worker's fingerprint reuse honours the veto while the item still lands in the summary carrying its original verdict. The host also reflects the dismiss in the memoized ranking in place (rather than invalidating it), so reopening keeps the item included without a re-rank / "Analyzing…" flash.

There is no persistent "kept" state: a dismiss is a per-change flag on the ranking that clears on the next full re-rank (a re-rank writes a fresh list with no vetoes).

**Cross-surface mirroring.** The overlay is not panel-exclusive. On **every** ranking outcome — empty file set, cache hit, successful rank, and setup/rank failure — the panel both posts the overlay to its own webview **and** mirrors it to the sidebar's Working Memory Context rows (spec 101), so the two surfaces' strikethroughs stay in lockstep. The mirror is a direct push to the sidebar view, *not* the broadcast fan-out (which would echo back to this panel). A dismiss (from either surface) is mirrored differently: the originating surface updates itself optimistically, and the host re-pushes the post-dismiss overlay so the *other* surface's stale Excluded strikethrough clears too — each surface thus receives exactly one authoritative update.

**Memoization + stale-overwrite guard.** The ranking is memoized keyed by the change fingerprint plus the (order-independent) candidate item-key set. A cache hit replays the previous overlay and skips the LLM entirely (no "Analyzing…" flash on reopen or tab-switch). A file toggle or a user hard-exclude toggle moves one of those keys, so the next refresh re-ranks naturally. The **live** override — the Include/dismiss — changes neither key, so it edits the cached entry **in place** (flips the dismissed item to non-excluded), preserving the dismiss without a re-rank. (A separate cache-invalidation hook exists for a hypothetical "Keep" override that would flip the decision without moving a key; it has **no live caller today** — dormant extension point.) Each ranking additionally claims a value from a **monotonic generation counter**; because several refreshes can be in flight and a rank can take up to the call timeout, a ranking only writes the cache / posts the overlay / persists its result **if it is still the latest generation**. This turns "last writer by completion time" into "by start order", so a slow earlier call can never clobber a faster later one across the async yield points (registry read, the LLM call, the persist).

**Fail-open.** Any setup or ranking *failure* (config load error, registry read throw, etc.) posts an empty overlay — to both the panel webview and the sidebar — so the panel simply shows no decoration and persists nothing. This is distinct from the ranker's own **keep-all fallback** (an LLM error inside the ranker): that returns real result entries with tier `mid` and empty reasons, which the per-row rendering leaves undecorated and the persist step drops (see above). Both are fail-open; the panel's catch handles the outer failure, the ranker's keep-all handles the inner one (see [258]).

### Row-open

Clicking a row (away from its hover actions) opens the underlying artifact via the same open messages the sidebar posts — a conversation transcript, a plan/note preview, a reference preview, or a file's working-tree diff. Conversation rows with no messages do not open.

### Footer commit

The footer's commit control dispatches the same commit command the sidebar's commit button dispatches (one commit path). It is enabled only when **both**: at least one file is currently included, and no blocking worker run is in progress. Excluding or discarding every file empties the included set and disables the button. Enablement is re-evaluated on the initial render, on every worker-busy update, and on every file-list update.

## State Transitions

```
[show] ──► panel exists? ──yes──► reveal + full refresh (title+diffstat+tokens+context)
                          │
                          no ──► create singleton, register broadcast target
                                    │
[client ready] ─────────────────────► full refresh + forward ready to sidebar broadcast
                                       (sidebar data feeds now fan out here too)

[selection toggle] ─► forward to shared host handler ─► add invalidated sections to pending set
                                                       ─► (re)arm ~400ms timer
[timer fires] ─────► drain pending set ─► recompute those sections concurrently ─► push each

[file toggle] ─────► (in the debounced refresh) rank context vs. selected files
                     ─► claim a generation ─► cache hit? replay overlay
                                            ─► miss? "Analyzing…" ─► rank ─► if still latest:
                                                 persist full verdict list + fingerprint, cache, post overlay
                                                 (to panel + sidebar), under the cross-process lock
[Include on excluded row] ─► optimistic un-exclude in panel ─► host sets the entry's `dismissed` flag
                                                              ─► dismiss reflected in cache (no re-rank)
                                                              ─► host re-pushes overlay to the OTHER surface

[host sidebar push] ─► mirrored to this panel (broadcast) ─► re-render shared rows
[worker:busy] ─────► re-evaluate commit-button enablement
[dispose] ─────────► cancel timer, clear pending set, unregister broadcast target
                     (via the webview captured at open time, never the throwing live accessor),
                     clear singleton
```

## Notable Behavior

- **It is a mirror, not a fork.** No preview-panel-private selection exists; all mutation flows through the sidebar's host handler into shared stores. The panel's only private state is the debounce timer and the accumulated pending-section set.
- **A conversation toggle never re-runs the LLM title.** Conversations feed only the token meter; regenerating the non-deterministic title over an unchanged file set would flip the "proposed title" for no reason. Only file toggles (and the full refresh) invoke the title generator.
- **The debounce accumulates a union, not a last-write.** A file-then-conversation burst refreshes title + diffstat *and* tokens, because pending sections accumulate across the window and are drained together.
- **Sections fail independently.** The refresh settles each section on its own; a diffstat git error does not blank the title or the token meter.
- **Two affordances per context/file row.** The reversible ✕/+ exclude toggle and the destructive trash/discard are distinct controls with distinct consequences; only context and file rows carry the destructive one.
- **The commit button needs both an included file and an idle worker.** Either an empty/all-excluded/all-discarded file set or a busy worker disables it. The AI "Analyzing…" state does **not** disable it — the pre-commit ranking is decorative.
- **The AI overlay is additive and non-authoritative.** Tiers, reasons, the Excluded badge, and rank ordering decorate rows on top of the user's own selection; they never become a second selection state. The pre-commit rank is superseded by the post-commit worker's recompute (or by the worker reusing this panel's persisted ranking on a fingerprint match).
- **A dismiss is a flag, honoured across processes.** Clicking Include sets the `dismissed` flag on the entry (never erasing the AI's tier / reason / original exclude decision); the effective exclude decision is (`excluded` AND NOT `dismissed`), so the post-commit worker's fingerprint reuse lands the item normally while it still carries its original verdict. It is reflected in the memoized cache in place so reopening doesn't re-rank or re-exclude it, and the host re-pushes the overlay so the sidebar's copy clears too.
- **The overlay is mirrored to the sidebar on every outcome.** The panel is not the only surface: empty file set, cache hit, success, and failure each mirror the same overlay to the sidebar's Working Memory Context rows (via a direct sidebar push, not the broadcast fan-out), so a strikethrough shown in one surface shows in both.
- **Persistence writes the full ranking, not just exclusions.** The panel persists every ranked item's tier + reason + exclude decision as one list (filtered to real verdicts), which is what lets the worker rebuild both the kept-item relevance and the effective exclude set on a fingerprint match — one LLM call, reused verbatim. All writes (panel persist, dismiss, worker clear) serialize under a cross-process file lock.
- **The disposal cleanup must not read the live webview accessor.** It uses the webview captured at open time; re-reading the accessor (which throws once disposed, and disposal fires exactly then) would abort cleanup before the singleton pointer is cleared, stranding a dead panel as the singleton.
- **The generation guard makes ranking order-of-start authoritative.** A slow earlier ranking that finishes after a newer one cannot clobber the newer overlay/cache/persisted fingerprint — only the latest generation may write.

## Shared Behavior

- **Sidebar message protocol (spec 101)** — the selection-toggle, open, and command message shapes this panel reuses verbatim, and the data feeds it receives via broadcast; also the interaction with the sidebar's re-init guard (a re-broadcast init triggered by this panel's ready handshake must not yank the sidebar back to its default view — see spec 102).
- **Commit-exclusion selection store (spec 188)** — the store every inclusion toggle writes through, and the store this panel writes the full AI relevance verdict list + change fingerprint into (and sets one entry's `dismissed` flag on). All writes to the AI layer — panel persist, dismiss, and the worker's post-consume clear — serialize under that store's cross-process file lock.
- **Sidebar AI relevance overlay (spec 101)** — the sibling surface the panel mirrors its overlay onto (via a direct sidebar push, not broadcast) on every ranking outcome, and which can itself originate a dismiss.
- **AI context-relevance filtering (spec 258)** — the ranker this panel invokes for the overlay; the panel run is non-authoritative and is reused verbatim (fingerprint match) or superseded (recompute) by the post-commit worker.
- **Token usage extraction and cost estimation (spec 243)** — the source of the per-turn breakdown the token meter renders.
- **Summary attribution by transcript cutoff (spec 36)** — governs which conversation turns are in scope once the exclusion pass runs.
- **Sidebar tab/state (spec 102)** — owns the re-init guard that coexists with this panel's broadcast-reusing ready handshake.
