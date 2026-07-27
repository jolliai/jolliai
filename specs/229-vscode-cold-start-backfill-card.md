# VS Code Cold-start Back-fill Card

## Topic Statement

The VS Code extension's cold-start back-fill card: how the host decides whether to offer back-fill (per-repo cold-start signals), the repo-wide dismiss marker, the human-readable row/note copy, and the run/dismiss/notify orchestration that ties the card to the back-fill engine. The card offers a returning-or-new user a chance to build memories from their recent commits without spending model budget until they opt in.

## Scope

**In scope:**
- The repo-wide dismiss marker: location, semantics, and contrast with the per-worktree manual-disable marker.
- The cold-start window and cap constants, and the row/note copy formatting.
- The dual-form copy (real functions + emitted webview source string kept in sync).
- The host orchestration: computing cold-start signals, the run job with its progress notification, the sidebar run/dismiss hooks, and the notify-cold-start push on enable.

**Out of scope (boundaries):**
- The back-fill engine (attribution, generation, storage, post-batch ingest) — owned by **Back-fill Engine Orchestration**.
- The read-only signal queries (has-any-memory, list-missing, count-missing) — owned by **Back-fill Cold-start Signal Queries**.
- The sidebar webview's HTML/CSS/DOM rendering — only the copy text and the host-side orchestration are covered here.

## Data Contracts

### Dismiss marker (repo-wide, sticky)

A flag whose value is the boolean: true ⇒ the user dismissed the cold-start card (or the CLI guided front door's cold-start offer) in this repository.
- Location: a field in the shared `profile.json`, anchored at the **main worktree root** — the same file shared with the CLI guided front door's cold-start offer, and living alongside the manual-disable flag. Deliberately **repo-wide**, not per-worktree: the cold-start decision itself is repo-wide (has-any-memory reads the shared orphan branch), so dismissing from either surface, in any worktree, must suppress the card/offer in every worktree of the same repo.
- Old location (deprecated): the per-repo marker file under the repository's shared git common dir is **no longer written or read** for this decision — it survives only as a one-time **migration source**, so a pre-existing dismissal on disk is carried forward into `profile.json` rather than silently lost.
- **Sticky lifecycle:** once set, the flag is never auto-cleared by a back-fill run (VS Code-driven or CLI-driven) — only an explicit un-dismiss clears it. This is a change from the prior behavior, where a successful generation cleared the marker.
- Read: return the flag's current boolean value; a read failure is treated as not-dismissed.
- Write true (dismiss): best-effort persist the flag set.
- Write false (un-dismiss): best-effort persist the flag cleared; this is the only way the card/offer reappears once dismissed.

### Cold-start scope constants

- Window: **30 days**.
- Cap: **10** (the maximum commits the card lists; the rest are reached via the card's "manage all in Settings" link).

### Row / note copy

- Candidate-row meta: `"<N> session(s) · <M> turn(s)"` where turns is the conversation-turn (human-role) count — **not** transcript-entry count. A diff-only commit (zero sessions) shows `"Code change only"`.
- Result-row meta: `"<N> session(s) · <K> topic(s)"`; a diff-only result shows just `"<K> topic(s)"`.
- Cold-start note, by variant:
  - `empty` (repo has zero memories): a "no memories yet — build them or keep coding" message.
  - `gaps` (repo has memories but recent own commits lack one): a "you are set up, N recent commits from the last month lack a memory" message; when the count reached the cap, the wording switches to "the <cap> most recent … manage all in Settings."
  - The copy states scope explicitly ("last month", "up to <cap>") so a user with a large backlog understands why only some commits are offered.

### Cold-start card state (pushed to the webview)

Four fields: the variant (`empty` | `gaps` | `null`), the recent-missing count, whether the repo has memories, and whether the card was dismissed. The webview keys card **visibility on the variant** (`null` ⇒ no card); the other fields carry context and copy.

## Behavior

### Computing cold-start signals

Best-effort and atomic — signals are computed into locals across all awaits and committed together only on full success, so a mid-way failure leaves the prior consistent snapshot (never a mixed new-has-memory + stale-variant):
1. Read has-any-memory.
2. If the repo has **no** memory ⇒ variant `empty`, count 0.
3. Else list the missing commits within the 30-day window capped at 10; count = list length; variant = `gaps` when count > 0, else `null`. (The list scan is only paid for when the repo is non-empty.)
4. Read the dismiss marker.
5. On full success, commit the snapshot (has-memory, variant, count, dismissed) atomically.

This runs under the initial-load barrier (so the first webview `init` carries correct card visibility with no flash) and again on enable.

### Run job (shared by the card and the Settings "generate missing" button)

Both entry points funnel through one runner:
1. Resolve candidate hashes — the passed-in selection (cold-start selection) or, when omitted, the full own-missing scope.
2. If no candidates, return a no-op result.
3. Run the engine inside a progress **notification** (a bottom-right toast, non-cancellable): each per-commit progress event updates the toast with `done/total — <subject-or-hash>` (subject truncated; only failures flagged) and forwards to the caller's inline-bar callback when supplied.
4. Refresh dependent caches/stores and the Memory Bank folders tree (newly back-filled memories also land in the visible folder layer).
5. **Cold-start bookkeeping on success:** when the batch generated ≥ 1 memory, mark the repo as having memories and clear the card variant and recent count in host memory (so the user is not re-nagged this session). The dismiss flag itself is **not** touched here — it is sticky, so a successful generation no longer clears it; only an explicit un-dismiss does. Doing this in the shared runner keeps both entry points leaving cold-start consistently.
6. Build the result rows from only the acted-on outcomes (generated / errored) — already-summarized neighbours are not interesting rows.

### Sidebar hooks

- **list-candidates(scope):** a dry-run preview — list the missing commits for the scope (`recent-month` = the 30-day window + cap 10, matching the offer's count; `all` = full scope) plus the full missing total, then enrich each row with per-commit session/turn counts from a dry-run engine call. If the dry-run itself fails, still show the commits with 0/0 counts rather than an empty list — the list must never contradict the offer's count.
- **run(hashes, onProgress):** invoke the shared run job for the selected hashes and return the result rows and counts.
- **dismiss():** set the in-memory dismissed flag **and** persist the dismiss flag to the shared `profile.json`, so a webview recreate (collapse/reopen) in the same session — and the CLI guided front door's cold-start offer in the same repo — do not re-show.

### Notify on enable

Enabling the product does **not** run back-fill (see **Back-fill Engine Orchestration**). Instead, on successful enable the host recomputes the cold-start signals and pushes them to the sidebar so the card can appear **without a reload** when the repo is empty or the last month has own commits lacking a memory.

## State Transitions

- Card visibility: `variant = empty|gaps` (and not dismissed, from the webview's perspective) ⇒ card shown; `variant = null` ⇒ no card.
- A successful back-fill (≥ 1 generated) flips host state to has-memories and clears the variant to `null`; the dismiss flag is untouched (sticky — no longer auto-cleared by generation).
- Dismiss persists the flag to `profile.json` (and the in-memory flag) so the card stays suppressed across recreates, across worktrees, and across the CLI front door's offer in the same repo, until the flag is explicitly cleared.

## Notable Behavior

- **The dismiss marker is repo-wide, the manual-disable marker is per-worktree.** They mean different things: disable is a per-workspace on/off switch; dismiss acknowledges a repo-wide backlog. The per-worktree choice for disable is a pre-existing storage decision left as-is. (Notable.)
- **The dismiss flag is now sticky, not auto-cleared.** A successful back-fill used to clear the dismiss marker so a later return to empty (memories wiped) would re-show the card; that auto-clear is gone. Once dismissed, the card (and the CLI front door's offer) stays suppressed until the flag is explicitly cleared. (Notable; behavior change.)
- **The dismiss flag is shared, cross-surface storage.** It lives in `profile.json` anchored at the main worktree root, alongside the manual-disable flag, and is read/written by both the VS Code card and the CLI guided front door's cold-start offer — dismissing from either surface silences the other in the same repo. The old per-repo git-common-dir marker is retained only as a one-time migration source. (Notable.)
- **Signal computation is atomic** — a partial failure never leaves a mixed snapshot. (Notable.)
- **The list preview never contradicts the count:** a failed dry-run still lists the commits with zero counts. (Notable.)
- **The card and the Settings button share one runner**, so both leave cold-start state consistently. (Notable.)
- **STALE comment — cap is 10, not 1.** The cold-start-cap constant's own source comment claims it was "temporarily lowered to 1 for manual testing — restore to 10 for release," but the **live value is 10**. The comment is stale and contradicts the code; the offered-list cap and all copy use 10. Treat the "lowered to 1" note as **not live.**
- **Copy exists in two hand-synced forms:** real functions (used by the host and unit tests) and an emitted JavaScript **source string** embedded into the webview script (there is no runtime module import in the webview). The two are kept in sync by hand — a wording change must touch both, or the sidebar and Settings copy diverge. (Surprising; intentional constraint.)

## Unreachable / Not-live

- The "temporarily lowered to 1" cap comment is **not live** — the effective cap is 10 (see Notable Behavior).
- Back-fill on enable is **not live** — enabling only recomputes and pushes signals (see **Back-fill Engine Orchestration**).

## Shared Behavior

- The read-only signals (has-any-memory, list-missing, count-missing) are owned by **Back-fill Cold-start Signal Queries**.
- The actual generation, storage, and post-batch ingest are owned by **Back-fill Engine Orchestration**.
- The window (30 days) and cap (10) constants are shared between the host's signal computation / list scope and the note copy, so the offered count and the listed rows can never drift.
- The sticky dismiss flag is shared, cross-surface storage (`profile.json` at the main worktree root) with the CLI guided front door's cold-start offer (owned by **Guided Front Door**) — dismissing from either surface silences the other in the same repo.
