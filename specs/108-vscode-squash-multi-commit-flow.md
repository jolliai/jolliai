# VS Code Squash Multi-Commit Flow

## Topic Statement

The Squash Selected action that requires two or more selected commits, warns the user when any of those commits is already on the remote, generates a single squash message via the LLM (with a deterministic mechanical fallback when the LLM is unavailable or fails), and presents two finishing options — Squash, or Squash & Push — with a pre-write hand-off file that lets the post-commit summary worker recognize the operation as a squash and merge the source summaries instead of running the LLM again.

## Scope

**In scope:**
- Pre-flight guards: worker-busy lock, "two or more commits selected".
- The pushed-commit warning modal that fires when any selected commit is already on the remote.
- The two-stage message-generation strategy: LLM call first; on failure, fall back to a mechanical merge of the selected commits' subjects with longest-common-structural-prefix detection and ticket-id deduplication. The merge algorithm is inlined in full below and is shared with the other surfaces — see **Commit-Subject Merge Algorithm** (294).
- The two-action quick-pick (Squash / Squash & Push), its empty-message rejection rule, and its filter-disabled free-form-text behavior.
- The hand-off written before the commit operation begins so the post-commit hook recognizes the next commit as a squash and merges existing summaries instead of running its own LLM call.
- Staged-files preservation around the squash operation: any path the user had staged before invoking the action is unstaged before the squash and re-staged afterwards so it does not silently get rolled into the squash commit.
- Rollback / restoration on every error path.
- Success notification copy that distinguishes "squashed" from "squashed and pushed".

**Out of scope:**
- The LLM squash-message prompt template itself (token budget, role prompt, ticket extraction rules) — owned by the squash-message generation topic.
- The post-commit summary merger that consumes the hand-off file — owned by the queue-worker squash-pending topic.
- The push primitive — Squash & Push delegates to a force-push (with the lease), but the modal-flow Push action is a separate user-facing surface.
- The lock-file mechanics (location, staleness threshold, probe semantics) — owned by the lock-file guard topic.
- Storage of the resulting summary — owned by the orphan-branch storage topic.

## Data Contracts

### Pre-flight inputs

- **Selected commits** — newest-first list of commits the user has checked in the Branch History panel. Each carries a hash, a short hash, a commit message, and an "is this commit already on the remote?" flag.
- **Currently-staged paths** — the set of paths the index considers staged at the moment the user invoked the action. Captured before the squash and re-staged afterwards.

If the selected list has fewer than two entries, the action exits with a warning ("Select at least 2 commits to squash.").

### Pushed-commit warning modal

Fires when any selected commit's "already on remote" flag is set. Contents:

| Field | Content |
| --- | --- |
| Heading | `<N> of the selected commit(s) have already been pushed to remote:` |
| Body | A bullet list of the pushed commits' short hashes and message previews (each clipped to 60 characters). |
| Reason | "Squashing will rewrite history. You will need to force push afterwards." |
| Footer | "This may affect collaborators on the same branch." |
| Affirmative button | "Continue (I know force push is needed)" |
| Implicit Cancel | Standard Cancel / Esc / click-away. |

The modal is **modal**: nothing advances until the user picks one option. Cancel returns the action to idle silently.

### Message generation contract

The action calls the LLM first. The LLM call receives the selected commits' messages, each commit's existing topic titles and triggers (read from any pre-existing summary on the orphan branch), the ticket id pulled from the first selected commit that carries one, and a flag indicating whether this is a "full squash" (all branch commits are being squashed) or a "partial squash" (only some).

If the LLM call throws, the action falls back to a deterministic merge of the selected commits' raw **subjects** (each commit's first message line, nothing else). Blank and whitespace-only subjects are dropped before the merge runs.

The merge is the shared algorithm documented in **Commit-Subject Merge Algorithm** (294), inlined here in full:

- **Zero subjects** → the empty string. **One subject** → that subject verbatim, with no trimming or prefix handling of any kind.
- **Two or more subjects** → three strategies, tried in this order; the first whose precondition holds produces the result.

1. **Longest common structural prefix.** Compute the longest common character prefix across all subjects (exact, case-sensitive), then truncate it back to and including the **last** occurrence within it of either structural separator — a colon-space or a period-space (whichever occurs later). If the common prefix contains neither separator, this strategy produces nothing. Otherwise the result is that prefix (trailing whitespace trimmed), one space, then each subject's remainder — prefix removed, then trimmed — joined with `"; "`. Example: `Part of PROJ-123: A` + `Part of PROJ-123: B` → `Part of PROJ-123: A; B`.
2. **Ticket-id dedup.** Attempted only when strategy 1 produced nothing. Each subject's ticket prefix is everything up to and including a structural separator that **immediately** follows the subject's first ticket identifier (one or more letters, a hyphen, one or more digits, matched case-insensitively); a subject whose identifier is not in that prefix position has no ticket prefix. The strategy applies only when **every** subject has a ticket prefix and all of them carry the **same** identifier (compared upper-cased) — one un-ticketed subject drops the whole merge to strategy 3. The result is the **first** subject's prefix (trailing whitespace trimmed), one space, then each subject's own remainder (its own prefix removed, then trimmed) joined with `"; "`. Example: `Closes PROJ-123: A` + `Part of PROJ-123: B` → `Closes PROJ-123: A; B` — the first subject's verb survives.
3. **Plain join.** Otherwise the subjects are joined verbatim with `"; "`, with no trimming.

The algorithm handles nothing else: no trailers, no comment lines, no blank-line normalization, no subject/body split, no length cap or truncation, and no duplicate-subject collapsing.

If the LLM call returns a string, the action uses that string verbatim; the mechanical merge is the strict fallback for LLM unavailability or failure, not a post-processing step.

**One implementation, every surface.** This is not a VS-Code-local routine: the same implementation backs the CLI's squash-message generation command (used both when no LLM provider resolves and as that command's own LLM-failure fallback), and the JVM plugin's squash action reaches that command out-of-process. All three squash surfaces therefore produce byte-identical fallback messages by construction.

### The hand-off file

A small JSON record written to repository-local jollimemory state **before** the squash commit is created. Its purpose is to carry information that the post-commit hook needs in order to recognize the next commit as a squash and to look up the source commits' summaries:

- The list of source commit hashes (oldest → newest).
- The fork-point hash (the parent of the oldest selected commit).

The hand-off is written before any history-rewriting operation. The post-commit hook later finds it and uses it to skip an LLM call, instead merging the existing summaries of the source commits into the new squash commit's summary.

### The two quick-pick actions

| Item | What it does |
| --- | --- |
| Squash | Reset HEAD to the fork point with the working tree staged, then create a single new commit with the trimmed input. |
| Squash & Push | The same squash, then a force-push (with the lease). |

### Quick-pick UI rules

- The input is pre-filled with the generated message.
- Filtering on label, description, and detail is disabled (same reason as the Commit action — the input is a free-form message, not a filter query).
- Empty-or-whitespace input on accept is rejected for both actions; the quick-pick stays open.
- Dismissing the quick-pick (Escape, click-away) without first accepting cancels the action.

## Behavior

### When the user invokes Squash Selected

1. Run the worker-busy guard. If busy, show the warning toast and return.
2. Read the selected commits. If fewer than two, show the "select at least 2" warning and return.
3. If any selected commit is already pushed, show the pushed-commit warning modal. If the user cancels, return.
4. Show a non-cancellable progress notification ("Generating squash message…") while the LLM call runs:
   - On success, use the returned string as the message.
   - On failure, fall back to the mechanical merge described above and use that as the message instead. The fallback fires silently — the user is not told the LLM was tried first.
   - If both attempts produce no string at all, surface the failure and return.
5. Show the quick-pick pre-filled with the message. On cancel/dismiss, return without writing anything.
6. Capture the currently-staged paths. If there are any, unstage them so the squash commit will not include them. On a snapshot/unstage failure, surface "Could not save current index state. Squash aborted.", attempt to re-stage anything that was already unstaged, and return.
7. Run the chosen action:
   - Mark a "plugin source" indicator so the post-commit hook can attribute the squash to this surface.
   - Compute the fork-point hash (parent of the oldest selected commit).
   - Write the hand-off file with the source commit hashes and the fork-point hash.
   - Reset HEAD softly to the fork point so the squashed range becomes a single staged change.
   - Create the squash commit with the trimmed message.
   - For Squash & Push, follow with a force-push (with the lease).
   On any failure during step 7, surface the failure, re-stage the previously-unstaged paths, and return.
8. Re-stage any path that was staged before the action started (so the user's "I had stuff staged for later" workflow is preserved). If this re-stage fails, show a non-fatal warning toast.
9. Show the success toast — wording differs by action: "<N> commits squashed. post-commit hook is merging summaries in the background." or "<N> commits squashed and pushed. post-commit hook is merging summaries in the background.".
10. Refresh the Branch History panel, the Changes panel, the Status panel, and the status bar.

### Hand-off-then-rewrite ordering

The hand-off file must exist on disk before the soft-reset and squash-commit run. The post-commit hook fires immediately after the squash commit lands; if the hand-off were written after the commit (or only on success of the squash), there would be a window where the hook would see the new commit, fail to find a hand-off, and run the per-commit LLM summarization on a commit whose summary is already implied by the source commits' summaries.

### Pushed-commit warning vs. Push action's own warning

The pushed-commit warning here gates the *squash itself*, not the *push that may follow*. A user who picks Squash (without push) but had pushed commits in the selection still has to acknowledge that history is being rewritten — even if they never push afterwards, anyone who already pulled would now have a divergent history. The Squash & Push variant's force-push is gated by the same lease the Push action uses, but there is no second modal: the squash modal already constituted the user's "I know force push is needed" assent.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Idle | User clicks Squash Selected | Guarded |
| Guarded | Worker busy | Idle (warning toast) |
| Guarded | Fewer than 2 selected | Idle (warning toast) |
| Guarded | 2+ selected, none pushed | Generating |
| Guarded | 2+ selected, some pushed | Confirming pushed |
| Confirming pushed | User cancels | Idle |
| Confirming pushed | User confirms | Generating |
| Generating | LLM succeeds or fallback succeeds | Reviewing |
| Generating | All paths produce no message | Idle (error toast) |
| Reviewing | User dismisses or accepts empty | Idle |
| Reviewing | User accepts | Protecting index |
| Protecting index | Capture or unstage fails | Idle (error toast, partial restore attempted) |
| Protecting index | Capture / unstage succeeds | Squashing |
| Squashing | Hand-off / reset / commit fails | Idle (error toast, staged paths restored) |
| Squashing | Squash succeeds, action is "Squash" | Restoring |
| Squashing | Squash succeeds, action is "Squash & Push" | Force-pushing |
| Force-pushing | Push succeeds | Restoring |
| Force-pushing | Push fails | Idle (error toast, staged paths restored) |
| Restoring | Re-stage of pre-flow staged paths succeeds | Notified |
| Restoring | Re-stage fails | Notified (extra warning toast — non-fatal) |
| Notified | Refresh complete | Idle |

## Notable Behavior

- **The mechanical fallback is ticket-aware on purpose.** Squashing two commits that both reference `PROJ-123` should yield one message that mentions the ticket once. Without the ticket-id dedup pass, a fallback message would read "Closes PROJ-123: X; Part of PROJ-123: Y", which is awkward and noisy. The ticket-id dedup keeps the first verb (the commit history's order is "first commit's intent wins") and joins the descriptions. (Notable.)
- **The fallback fires silently.** The user is not told the LLM was tried first and failed — the squash message that lands in the quick-pick is just there, regardless of which path produced it. This avoids modal toasts that the user can do nothing actionable about. (Notable.)
- **Two or more selected is a hard precondition.** The action does not silently degrade to "amend" when one commit is selected; it warns and exits. This keeps amend semantics in the Commit action where they belong. (Notable.)
- **Pushed-commit warning fires regardless of push intent.** Even Squash (without push) shows the modal when any selected commit is pushed — the rewrite itself is the worry, not the eventual force-push. (Surprising; intentional.)
- **Hand-off is written before history is rewritten.** If the squash commit fails after the hand-off is written, the file is left on disk; the next post-commit run can still find it and act on it. The cost of leaving a stale hand-off is low compared to the cost of the post-commit hook running an LLM-driven summarization on a squash whose source summaries already exist. (Surprising; intentional.)
- **Staged-files protection is in addition to the squash itself.** Without the unstage-then-restage dance, a soft reset followed by `git commit` would commit *everything currently staged* — including paths the user had staged for an unrelated next commit. The action explicitly drains the staging area, runs the squash on just the squashed range, and then re-applies the user's staged paths. (Surprising; intentional.)
- **No automatic length validation on the squash message.** The LLM is instructed to return a single concise line; the fallback joins subjects with `"; "` and can grow long. The user's edit step in the quick-pick is the only safeguard against an oversized commit message. (Notable.)
- **The ticket dedup pass demands unanimity.** One selected commit whose subject carries no ticket prefix — or whose ticket is not immediately followed by a structural separator — drops the whole merge to the plain join, even when every other subject shares the same ticket. A partial strip would silently lose one commit's ticket reference. (Surprising; intentional.)
- **The mechanical merge is shared, not local.** It moved into shared core so this action, the CLI's squash-message command, and the JVM plugin's squash action all execute the identical logic. That move also closed a real gap: the JVM squash action previously ran its own LLM call gated on a directly configured vendor key only (no product proxy, no local agent) and had **no** mechanical fallback at all, so an LLM failure there surfaced an error dialog instead of a merged message. (Notable.)
- **Force-push from Squash & Push uses the same lease semantics as the standalone Push action.** A teammate's pushed commit on the same branch will reject the force-push rather than be silently overwritten. (Notable.)
- **No retry, no second LLM attempt.** A failed LLM call falls straight to the mechanical fallback; the action does not pause, prompt, or retry the LLM with different parameters. (Notable.)
- **Empty input on accept is rejected for both actions.** Squash and Squash & Push both require a non-empty message; an empty input keeps the quick-pick open. (Notable.)
- **Success toast names the count.** The user sees "<N> commits squashed" rather than "commits squashed", which doubles as a sanity check that the right range was squashed. (Notable.)
- **The post-commit summary merging is not part of this action.** The action's responsibility ends at the success toast plus refresh. The hand-off file is the only thing this action does to coordinate with the post-commit summarization. (Notable.)

## Shared Behavior

- **Commit-subject merge algorithm** — the mechanical fallback inlined above is the shared algorithm owned by **Commit-Subject Merge Algorithm** (294), consumed identically by the CLI's squash-message generation command and (through it) by the JVM plugin's squash action.
- **Worker-busy lock guard** — the same probe and warning toast used by Commit and Push gate this action.
- **Quick-pick free-form-text pattern** — the filter-disabled, message-as-input quick-pick UX is shared with the Commit action. Same rationale (typing the message must not filter the action items out of the active set).
- **Index snapshot tooling** — the unstage-then-restage protection draws from the same staging primitives as the Commit action.
- **Push action** — Squash & Push delegates to a force-push with the same lease semantics; the standalone Push action is the user's manual fallback if the user picks plain Squash and later changes their mind.
- **Post-commit queue worker** — the consumer of the hand-off file, which is what makes squash summary merging happen without re-running the LLM. This action's only job is to leave that file on disk before the squash commit lands.
- **Branch History panel** — the source of the selected commits and the destination of the post-success refresh.
