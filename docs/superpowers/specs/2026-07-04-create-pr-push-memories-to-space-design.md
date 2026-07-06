# Create PR → push memories to Jolli Space — design

**Date:** 2026-07-04
**Status:** Approved (pending spec review)

## Problem

The Create PR pane (`CreatePrWebviewPanel`) renders a share notice that already
**promises** a behavior it does not deliver:

> "Signed in: creating this PR also shares the included memories to your Jolli Space."

In reality `handleCreatePr` / `handleUpdatePrWithPush`
([`PrCommentService.ts`](../../../vscode/src/services/PrCommentService.ts)) only
`git push` the branch and run `gh pr create` / `gh pr edit`. No memory is ever
pushed to the Jolli Space. This spec makes the promised behavior real: when a
signed-in user clicks **Create PR** (or **Update PR**), after the PR is created
or updated, the branch's memories are pushed to the bound Jolli Space as
articles.

## Decisions (locked)

1. **Push semantics = content only.** Push every memory covered by the PR draft
   (`base..HEAD`, incl. its plans/notes) as Space **articles**, reusing
   `pushSummaryWithAttachments` with cross-commit plan/note **dedup**. Do **not**
   mint a live-share link and do **not** collect a visibility choice. This
   matches the notice wording ("shares the included memories").
2. **Unbound Space → open the binding chooser, then push.** If the repo has no
   bound Space, the server returns `412 binding_required` on the first article
   push. Open the **binding chooser** (`BindingChooserWebviewPanel`) and, once
   the user selects/creates a Space, the orchestrator retries the push
   automatically — **identical to the single-memory "push to Jolli" logic**
   (`SummaryWebviewPanel.runJolliPush`). If the user cancels the chooser (or
   another chooser is already open, or it fails), surface the same
   `ShareBindingError`-outcome messaging `runJolliPush` uses. The PR is already
   created/updated regardless of the chooser outcome.
3. **Both Create and Update paths push.** Any signed-in submit — a fresh Create
   PR or an Update of an existing open PR — triggers the memory push. Re-pushing
   is safe: `pushToJolli` upserts by `jolliDocId`, so an Update path refreshes
   the same Space docs in place (no duplicates).

## Invariants

- The memory push runs **after** the PR create/update fully succeeds
  ("在创建PR后再push"). A push failure **never** rolls back or fails the PR.
- Not signed in → no push at all; the pane behaves exactly as today.
- The binding chooser (`BindingChooserWebviewPanel`) is wired into the Create PR
  pane's `resolveBinding`, mirroring `SummaryWebviewPanel.runJolliPush`.

## Architecture

Orchestration lives in the **panel layer** (`CreatePrWebviewPanel`), mirroring
`SummaryWebviewPanel.runJolliPush`: apiKey resolution, the injected
`resolveBinding`, and result toasts stay in the panel; the pure push engine is
`JolliPushOrchestrator`. Branch-wide dedup lives in `LiveShareController`
alongside the existing live-share dedup it is factored out of.

```
CreatePrWebviewPanel.handle("createPr")
  └─ handleCreatePr / handleUpdatePrWithPush  → "succeeded" | "failed"   (PrCommentService)
       (on "succeeded" && signedIn)
  └─ this.pushMemoriesToSpace()               (panel: apiKey + resolveBinding + toasts)
       └─ pushBranchMemoriesToSpace(deps, branch)   (LiveShareController)
            ├─ loadSubjectSummaries(base..HEAD)
            ├─ assignOwnedAttachments(summaries)     ← extracted, shared with live share
            └─ for each summary: pushSummaryWithAttachments(non-strict)   (JolliPushOrchestrator)
```

## Components & changes

### 1. `LiveShareController.ts` — new branch content-push + shared dedup helper

Extract the plan/note winner + owner-assignment block currently inline in
`pushSubjectAndBuildRef` into a private helper:

```ts
/** Per-commit owned attachment lists after cross-commit dedup (latest revision wins). */
function assignOwnedAttachments(subjectSummaries: ReadonlyArray<CommitSummary>): {
  ownedPlans: Map<string, PlanReference[]>;
  ownedNotes: Map<string, NoteReference[]>;
};
```

`pushSubjectAndBuildRef` is refactored to call it (behavior unchanged — same
winner selection, same seed-docId injection). This keeps the live-share path and
the new Create-PR path on one dedup implementation.

New exported function:

```ts
export interface PushBranchMemoriesResult {
  readonly pushedCount: number;      // summaries successfully pushed
  readonly attachmentCount: number;  // plans + notes successfully pushed
  readonly attachmentFailures: ReadonlyArray<PushAttachmentFailure>;
}

/**
 * Pushes all of a branch's memories (base..HEAD) to the bound Space as articles,
 * without creating a share link. Reuses the same cross-commit plan/note dedup as
 * generateLiveShare. Best-effort on attachments (non-strict): a single unreadable
 * plan/note is collected into `attachmentFailures`, not thrown. Fatal binding /
 * plugin errors propagate (BindingRequiredError → ShareBindingError via the
 * injected resolveBinding).
 */
export async function pushBranchMemoriesToSpace(
  deps: LiveShareDeps,
  branch: string,
): Promise<PushBranchMemoriesResult>;
```

- Uses `withSubjectLock(workspaceRoot, branch, …)` so it can't race a concurrent
  reconcile/generate for the same subject (they PATCH `covered`; this doesn't,
  but shares the summary push path and jolliDocId writes).
- `resolveBaseUrl` + `getCanonicalRepoUrl` + `buildPushContext` exactly as the
  live-share path.
- Loops summaries oldest→newest, calling `pushSummaryWithAttachments(summary,
  ctx, ownedFor(summary))` with **`strictAttachments` omitted** (best-effort).
- Returns the aggregate counts + collected failures. Does **not** build a
  `LiveRef` and does **not** call `createLiveShare` / `putBranchShare`.

### 2. `PrCommentService.ts` — handlers return a success signal

Change the return type of both submit handlers from `Promise<void>` to a
discriminated outcome:

```ts
export type PrSubmitOutcome = "succeeded" | "failed";
```

- `handleCreatePr(...): Promise<PrSubmitOutcome>`
- `handleUpdatePrWithPush(...): Promise<PrSubmitOutcome>`

`"succeeded"` is returned at **every** success return point — including the
create→update fallback (existing PR found at submit time) in `handleCreatePr`
and the update→create fallback (PR vanished) in `handleUpdatePrWithPush`.
`"failed"` is returned at every early-abort / block / cancel / catch return
(worker-busy, cross-branch block, lookupError, push cancelled, thrown error).

`SummaryWebviewPanel` calls `handleCreatePr` inside `catchAndShow(...)` and
ignores the return value — unaffected. Its own PR section keeps its current
behavior (no memory push there; that pane is out of scope).

### 3. `CreatePrWebviewPanel.ts` — panel orchestration

- Store `bridge: JolliMemoryBridge` and `signedIn: boolean` on the instance
  (both already flow into `show()`; today only `panel` / `workspaceRoot` /
  `extensionUri` are retained). Keep `signedIn` in sync with the existing
  `authChanged` message so a mid-session sign-in is honored.
- In the `createPr` case, capture the handler outcome and, on success + signed
  in, run the push **inside the existing `try`** (so `prActionInFlight` stays
  held across the push and a re-click can't double-fire):

```ts
const outcome = this.vm.existingPr
  ? await handleUpdatePrWithPush(title, body, this.workspaceRoot, post, this.vm.branch)
  : await handleCreatePr(title, body, this.workspaceRoot, post, this.vm.branch);
if (outcome === "succeeded" && this.signedIn) {
  await this.pushMemoriesToSpace();
}
```

- New private method `pushMemoriesToSpace()`:
  - `loadGlobalConfig()` → `jolliApiKey`; if missing, warn ("configure your
    Jolli API Key first") and return (defensive — `signedIn` should imply a key).
  - Derive `baseUrl` from `parseJolliApiKey(apiKey)?.u` (trimmed); if it can't be
    resolved, warn (regenerate API key) and return — same guard as `runJolliPush`.
  - Build `LiveShareDeps { bridge, workspaceRoot, apiKey, resolveBinding }` where
    `resolveBinding` opens `BindingChooserWebviewPanel.openAndAwait({ extensionUri,
    baseUrl, apiKey, repoUrl, suggestedRepoName })` and maps its outcome to
    `{ status: "bound" | "anotherOpen" | "cancelled" }` — **byte-for-byte the
    `resolveBinding` used in `runJolliPush`** (decision 2). On `bound` the
    orchestrator retries the push automatically.
  - `await pushBranchMemoriesToSpace(deps, this.vm.branch)` and toast per the
    table below.

## Failure semantics / toasts (PR already created; push never rolls it back)

| Situation | Feedback |
|---|---|
| Success, no attachment failures | info: `Shared {n} memor{y/ies} to your Jolli Space.` |
| Success, partial attachment failures | warning **modal** listing each `• {label}: {message}` (reuse `runJolliPush` wording) |
| Unbound Space | open `BindingChooserWebviewPanel`; on select/create, push retries automatically |
| `ShareBindingError("anotherOpen")` | info: a chooser is already open for this repo — finish there, then retry (reuse `runJolliPush` wording) |
| `ShareBindingError("cancelled")` | error: push cancelled — no Memory Space chosen; retry when ready (reuse `runJolliPush` wording) |
| `ShareBindingError("failed")` | error: could not bind a Memory Space for this repo (reuse `runJolliPush` wording) |
| `PluginOutdatedError` | warning modal: plugin outdated, please update |
| Any other push error | warning: `PR is ready, but sharing memories to Jolli Space failed: {msg}` |
| Not signed in | no push, no toast |

The `ShareBindingError` outcome handling reuses the exact branches in
`runJolliPush` so the Create PR pane and the per-memory push give identical
binding-chooser feedback.

## Testing

- **`LiveShareController.test.ts`**
  - `pushBranchMemoriesToSpace` pushes every summary and dedupes a plan/note that
    recurs across commits to one Space doc (asserts `pushSummaryWithAttachments`
    call count / owned-attachment shape).
  - Non-strict: an unreadable attachment is collected into `attachmentFailures`,
    the summary push still counts as pushed, no throw.
  - `BindingRequiredError` on the first push + a `cancelled` `resolveBinding`
    surfaces as `ShareBindingError("cancelled")`; no further summaries pushed.
  - `assignOwnedAttachments` extraction does not change live-share `ref` output
    (existing `generateLiveShare` tests must still pass unchanged).
- **`CreatePrWebviewPanel.test.ts`**
  - signed-in + `"succeeded"` → `pushBranchMemoriesToSpace` invoked with the
    vm's branch.
  - signed-out + `"succeeded"` → push **not** invoked.
  - `"failed"` outcome → push **not** invoked (create and update paths).
  - Toast/flow branches: success / partial-failure modal / generic error /
    missing-apiKey guard / unresolvable-baseUrl guard.
  - Binding chooser: `resolveBinding` opens `BindingChooserWebviewPanel`; a
    `bound` outcome lets the push proceed; `cancelled` / `anotherOpen` / `failed`
    surface the matching `runJolliPush`-style message. (Chooser panel mocked.)
  - `prActionInFlight` remains held across the push (a second `createPr` during
    the push hits the guard).
- **`PrCommentService.test.ts`** (existing)
  - Assert the new return value at each branch: fresh create success, create→update
    fallback success, update success, update→create success, and each
    failure/abort/block/cancel path returns `"failed"`.

## Out of scope

- The `SummaryWebviewPanel` embedded PR section (its own create/update path).
- Any live-share link / visibility UI in the Create PR pane.
- IntelliJ parity (this is a VS Code pane).
