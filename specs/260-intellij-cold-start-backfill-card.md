# IntelliJ Cold-start Back-fill Card

## Topic Statement

The IntelliJ plugin's tool-window "build memory from your history" card: the service-side cold-start signal that decides whether to offer it, the card's own state machine (offer → scanning → selectable list → progress → done), the repo-wide dismiss marker shared with the VS Code extension, and the background runner that drives real generation and is shared with the Settings dialog's "Generate Missing Summaries" entry point. Native-Swing analog of the VS Code sidebar cold-start card (spec 229): same signals, same dismiss-marker path, same row/note copy, ported to an out-of-process CLI bridge instead of an in-process call.

## Scope

**In scope:**
- The service-side cold-start signal: how it is computed, on what thread, its variant/count/dismissed fields, and its failure behavior.
- The card's own states and sub-states, and the transitions between them.
- Where and how the card is mounted in the tool window (position, non-accordion nature, visibility rule, defensive construction).
- The dismiss gesture and the repo-wide marker it writes.
- The background runner shared by the card and the Settings dialog entry point: how it drives the engine, reports progress, and what it does with the service state and the marker on completion.
- The out-of-process CLI bridge: how it resolves the CLI it shells out to, and the three call shapes it issues (signals-only, dry-run preview, real streamed run).

**Out of scope (boundaries):**
- The CLI's `backfill` command flags, exit codes, and render/stream formats — owned by **CLI Back-fill Command** (cross-ref 214).
- The engine's attribution, generation, storage, and per-commit outcome semantics — owned by **Back-fill Engine Orchestration** (cross-ref 227).
- The read-only cold-start queries (has-any-memory, list-missing) the CLI's signals mode is built on — owned by **Back-fill Cold-start Signal Queries** (cross-ref 228).
- The VS Code card's own host orchestration and webview copy — owned by **VS Code Cold-start Back-fill Card** (cross-ref 229); this spec calls out only where the IntelliJ port differs.
- The surrounding accordion layout, gear menu, and title-bar actions — owned by **IntelliJ Tool Window Accordion** (cross-ref 118).
- The Settings dialog's tab structure and its other entries — owned by **IntelliJ Settings Dialog** (cross-ref 135); this spec covers only the shared runner it invokes.
- Project-service initialization order and status listeners in general — owned by **IntelliJ Project Service Lifecycle** (cross-ref 124); this spec covers only the startup trigger for the cold-start signal.

## Data Contracts

### Cold-start signal (service-side)

Three fields, held on the project service and read by the card:

| Field | Type | Meaning |
| --- | --- | --- |
| variant | `"empty"` \| `"gaps"` \| none | `empty` when the repo has no memory at all; `gaps` when the repo has memory but recent own commits still lack one; none when there is nothing to offer. |
| recent-missing count | integer | Size of the candidate list backing the `gaps` copy. |
| dismissed | boolean | Whether the repo-wide dismiss marker is present. |

The signal is computed by shelling out to the CLI's signals-only mode (no attribution, no LLM), bounded by a **30-day window** and a **cap of 10** candidate rows. On success, all three fields (has-any-memory-derived variant, count, dismissed) are set together from that single subprocess response. **On subprocess failure** (CLI missing, Node missing, non-zero exit, or malformed output), none of the three fields change — the prior snapshot is retained as-is; the failure is logged and swallowed.

The signal is (re)computed once, on a background pool thread, after the project service finishes initializing (see **IntelliJ Project Service Lifecycle**, spec 124, for the initialization sequence this follows) — never on the UI thread, since it shells out to a subprocess. The card is notified of the result (or of a dismiss, or of a completed back-fill) through a shared listener callback so it can resync without a full tool-window rebuild.

### Dismiss marker

Existence-is-the-boolean marker file, keyed to the repository (not the worktree), at the **same path the VS Code extension uses** for the same repo — so a dismissal from either surface is honored by the other. See spec 229 for the exact location and semantics; the IntelliJ side reads/writes it through the identical contract (present ⇒ dismissed; body is a debug timestamp only).

### Card states

| State | Entered from | Content |
| --- | --- | --- |
| Offer | Initial mount; also the target of every "reset" transition | Benefit copy, a cold-start note (copy driven by variant/count, worded identically to spec 229), a "Build memories from commits" call to action. |
| Loading | Offer → clicked "Build memories from commits" | A short "scanning your recent commits…" message while the candidate scan + preview run in the background. |
| List (populated) | Loading → scan returned ≥ 1 candidate | A checkbox per candidate (all pre-checked), each row showing the candidate's per-commit session/turn meta; a "Build N memories" action gated on ≥ 1 checked; a link to "manage all in Settings" when the total missing exceeds the shown cap. |
| List (empty) | Loading → scan returned 0 candidates, **or** the scan subprocess itself failed | "No commits to build from" — a subprocess failure during the on-demand scan is **indistinguishable in the UI** from a genuine empty result; both fall back to an empty list. |
| Progress | List → "Build N memories" clicked | A determinate progress bar and a "`done` / `total` built" counter, updated per commit as the runner streams progress. |
| Done (success) | Progress → runner completed with ≥ 1 generated | A per-row result list (session/topic meta, or a failure marker for rows that errored) and an "Open your Memory Bank" action that switches the tool window's view and resets the card to Offer. |
| Done (all failed) | Progress → runner completed with 0 generated | A warning message, a per-row failure list, and a "Try again" action that re-enters Loading (re-runs the scan from scratch). |

Every one of the seven rows above is reachable from the live construction path; none is dead. The "reset to Offer" transition is also reached from three other places not listed in the table: a dismiss from any state, a completed run cancellation, and any non-success runner outcome (CLI/Node unavailable, or a non-cancel failure) — all three collapse back to Offer rather than surfacing a dedicated error state in the card itself (a notification balloon carries the explanation instead, except for a user-initiated cancel, which is silent).

## Behavior

### Card placement and defensive construction

The card renders as a **bare bordered card**, not a titled section, at the **top of the tool window's accordion stack** — above all three collapsible sections (see spec 118 for the stack's other members). It carries no header triangle, no gear-menu show/hide entry, and no persisted expand/collapse state: its visibility is entirely **service-driven**.

Because the card's construction can fail independently of the rest of the tool window (a platform API mismatch between the plugin's build target and the running IDE), building it is wrapped so that **any throwable during construction is caught, logged, and the card is simply omitted** — the remaining accordion sections still render normally. This wrapping covers only the one-time construction and initial listener registration; once the card exists, its own event handlers are not additionally guarded.

### Visibility rule

The card is visible unless dismissed, using this precedence: if the repo-wide marker is set, the card is hidden regardless of anything else. Otherwise, if the card is currently in any state **other than** Offer, it stays visible (a signal recomputation mid-flow cannot yank the card out from under an in-progress scan, selection, or run). Only when the card is at rest in Offer does visibility defer to whether the service currently reports a variant. Whenever visibility is recomputed, the accordion stack is revalidated so hiding the card immediately reclaims its space.

### Offer → Loading → List

Clicking the call to action moves the card to Loading and, on a background pool thread, issues the signals-only call again (same 30-day/10-cap window) to get a fresh candidate list, then issues a dry-run preview call against those specific hashes to enrich each row with its session/turn counts (no LLM call either way). If the preview call itself fails, the raw (unenriched, zero-count) candidates are shown rather than an empty list — the same "never contradict the count" guarantee as the initial signals call, just implemented as a fallback rather than a atomic commit. The result — enriched or not, or empty — moves the card to whichever List sub-state applies.

### List → Progress → Done

Checking/unchecking rows toggles the primary action's enabled state and its label (`"Select commits to build"` when nothing is checked, `"Build N memories"` otherwise). Clicking it moves to Progress and hands the checked hashes to the shared background runner (below). Per-commit progress events update both the progress bar's fraction and the `done/total` counter. When the runner finishes, the card moves to whichever Done sub-state applies, or — for cancellation or a runner-level failure to even start — resets directly to Offer.

One copy inconsistency traced in the "all failed" Done sub-state: its header always reads "`<N>` commits couldn't be built" using the runner's reported error count, even in the (currently unreached in normal flow, since only real candidates are ever offered) case where the batch finished with zero generated and zero errors — the count would render as `0` while the message still implies failures.

### Dismiss

The header on **every** state (including both List sub-states) carries a ✕ that: resets the card to Offer, and marks the repo-wide dismiss marker. This is the same handler regardless of which state was active, so a user can dismiss mid-scan, mid-selection, or mid-progress-review — dismissing does not cancel an in-flight run, it only hides the card and blanks its own view back to Offer for next time.

### The shared background runner

One runner is invoked from two entry points: the card's "Build N memories" action, and the Settings dialog's "Generate Missing Summaries" entry (see spec 135) — passing an **empty** hash list, which the CLI bridge treats as full scope (every own commit lacking a summary) rather than the card's specific selection.

The runner drives the engine inside a cancellable background task with a **determinate** progress bar (not a spinner): the indicator's fraction and text are updated from each streamed per-commit progress event, and its cancel affordance is polled so a user-cancelled run kills the underlying subprocess.

On completion:
- **Any outcome** triggers a memory-state refresh notification (so other surfaces showing summary state — e.g. the committed-memories list — pick up newly generated entries).
- **A successful run** (engine completed, regardless of error count) updates the service's cold-start bookkeeping: when at least one memory was generated, the variant and recent-missing count are cleared. **The dismiss marker is NOT cleared.** A run that completed but generated nothing leaves cold-start state untouched.

  This is a change, and it removes the only path that ever cleared the marker: **a dismissed card now stays dismissed even after a successful full back-fill.** Nothing in the plugin clears the marker any more — not this runner, not the Settings dialog's re-entry point, not a signal recomputation. Once a user clicks the ✕, the card is gone for that repository until the marker is removed from disk by hand (or by the other surface, which shares the same marker path).
- **Exactly one of three notifications** is then shown for a completed run: nothing-to-back-fill (zero total candidates — e.g. a repo where none of the commits are the current user's), finished-with-errors (some generated, some errored), or complete (all generated cleanly, some already had a memory).
- A run that could not even start (no runnable Node, no locatable CLI bundle) or that failed outright shows a warning notification with the reason instead of one of the three completion notifications; a user-initiated cancellation shows no notification at all.

### The CLI bridge

Because the plugin has no in-process JS runtime (unlike the VS Code extension, which calls the engine's equivalent functions directly — see spec 229), every call is a subprocess invocation of the CLI's `backfill` mode (spec 214), preferring Node + the CLI copy **bundled inside the plugin itself**, and falling back only as a last resort to a separately-extracted copy under the machine-global state directory. The rationale traced in the source: the extracted copy is refreshed only on a plugin **version** change, so a same-version rebuild, or an upgrade whose bundled CLI gained new flags without a matching re-extract, can leave the extracted copy stale — silently rejecting a flag it doesn't recognize, which manifests as the cold-start card never appearing. Preferring the plugin's own bundled copy sidesteps that because it always matches the flags the plugin itself emits.

Three call shapes back the three bridge operations:
- **Signals** — the CLI's list-candidates mode, bounding the window/cap, returning has-any-memory + total-missing + the candidate rows. No attribution, no LLM.
- **Preview** — a dry-run call against an explicit hash subset, returning the same rows enriched with session/turn counts. No LLM.
- **Run** — a streamed call against either an explicit hash subset (the card's selection) or full scope (`--all`, empty hash list — the Settings entry point), emitting one progress event per commit plus a terminal report; this is the only one of the three that invokes the LLM.

## State Transitions

```
[project startup, service initialized]
  compute cold-start signal on a pooled thread (30-day window, cap 10)
    success → commit variant/count/dismissed together
    failure → retain prior snapshot; log and continue

[tool window built]
  construct the card (wrapped: any throwable → log + omit card, rest of tool window unaffected)
  card mounts in Offer
  visibility = !dismissed && (state != Offer || service reports a variant)

[Offer] --"Build memories from commits"--> [Loading]
[Loading] --scan + preview complete, ≥1 candidate--> [List: populated]
[Loading] --scan complete with 0 candidates, or scan subprocess failed--> [List: empty]
[List: populated] --"Build N memories"--> [Progress]
[Progress] --runner completes, generated ≥ 1--> [Done: success]
[Progress] --runner completes, generated = 0--> [Done: all failed]
[Progress] --cancelled, or runner could not start / failed outright--> [Offer]  (+ notification, except on cancel)
[Done: success] --"Open your Memory Bank"--> [Offer]  (+ tool window switches to the Memory Bank view)
[Done: all failed] --"Try again"--> [Loading]

[any state] --dismiss (✕)--> [Offer], repo-wide marker set, card hidden
                              (terminal for this repo — nothing clears the marker)

[Settings dialog "Generate Missing Summaries" clicked] (independent of the card's own state)
  shared runner invoked with full scope
  on success with ≥1 generated → variant + recent-missing count cleared
                                  dismiss marker NOT cleared
```

## Notable Behavior

- **The recent-window (30 days) and cap (10) are hardcoded at two independent call sites** — the service's own signal computation, and the card's own on-demand rescan when the user clicks "Build memories from commits" — rather than a single shared constant. If one is changed without the other, the Offer copy's stated count (from the service's last computed signal) can drift from what the subsequent on-demand scan actually lists. (Notable — drift risk, mirrors a pattern already called out for the VS Code copy constants in spec 229, but here it is two live call sites rather than one constant plus a stale comment.)
- **The card's clean "nothing to back-fill" path depends on the CLI stream mode's empty-report behavior** (spec 214): the CLI's `--stream` path with zero candidates exits cleanly with an empty terminal report rather than failing, which is what lets the runner render the "nothing to back-fill" notification instead of a generic failure.
- **A subprocess failure during the on-demand rescan is indistinguishable from a genuine empty result** in the List state — both render "No commits to build from." The initial signal computation, by contrast, does distinguish failure (retains the prior snapshot) from a genuine no-signal outcome (clears it) — the two paths through the same underlying subprocess call handle failure differently depending on which caller invoked it.
- **Cancelling a run, and a run that fails to start, both reset the card straight to Offer with no dedicated "cancelled" or "unavailable" view** — the explanation (if any) lives only in a transient notification balloon, not in the card body itself.
- **The CLI bridge's documented third fallback tier is dead code.** Its own resolution order is: the plugin's bundled copy, then an already-extracted copy (if one exists on disk), then — as a documented last resort — re-extracting a fresh copy from the bundle. But the extraction step itself first re-resolves the bundled copy, and if that lookup had succeeded the first tier would already have returned it; the third tier is therefore only ever reached when the bundled-copy lookup has already failed, in which case the re-extraction step's internal lookup fails identically and it also returns nothing. The comment describing it as "a fallback for the rare layout where the bundle can't be found" is not accurate to the code's own control flow: that third branch can never itself produce a runnable CLI path. (Unreachable — see below.)
- **Dismissal is effectively permanent.** No code path clears the repo-wide dismiss marker. The completion bookkeeping used to clear it on a successful run with at least one memory generated — that was the only clearing site anywhere in the plugin, and it is gone. So a user who dismisses the card and later back-fills their whole history (from the card before dismissing, or from the Settings dialog afterwards) never sees the card again for that repository, even on a future fresh-empty transition. The marker is shared with the other host surface, so a removal there is the only in-product way it comes back.
- **The Settings dialog's "manage all in Settings" link (shown in the populated List state when more candidates exist than are displayed) opens the general Settings dialog at whatever tab was last viewed in this IDE session** — it is not a targeted deep link to the Memory Bank tab's back-fill entry (spec 135).

## Unreachable / Not-live

- The CLI bridge's third-tier fallback (re-extracting the bundled CLI when both the bundled-copy lookup and the already-extracted copy have failed) can never succeed, because it depends on the same bundled-copy lookup having already failed moments earlier in the same call. See Notable Behavior above.
- Every card state and sub-state enumerated in Data Contracts was traced to a live, reachable transition; none of the seven is unreachable.

## Shared Behavior

- The dismiss-marker path, the row/note copy formatting, and the overall offer → build → done shape are shared with **VS Code Cold-start Back-fill Card** (spec 229); this spec documents only the IntelliJ-specific port (out-of-process CLI bridge, Swing state machine, defensive construction, non-accordion placement).
- The engine itself (attribution, generation, storage) is owned by **Back-fill Engine Orchestration** (spec 227); this spec's runner is a thin IDE-side wrapper around the CLI surface documented in **CLI Back-fill Command** (spec 214), which in turn is built on the read-only queries in **Back-fill Cold-start Signal Queries** (spec 228).
- The runner is invoked identically (same completion bookkeeping — including the fact that neither entry point clears the dismiss marker — and the same three-notification shape) from the Settings dialog's "Generate Missing Summaries" entry, documented in **IntelliJ Settings Dialog** (spec 135).
- The card's mount position and non-accordion nature are documented from the surrounding-layout side in **IntelliJ Tool Window Accordion** (spec 118).
- The startup trigger that first computes the cold-start signal runs after the sequence documented in **IntelliJ Project Service Lifecycle** (spec 124).
