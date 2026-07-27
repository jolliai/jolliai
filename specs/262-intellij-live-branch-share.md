# 262. IntelliJ Live Branch Share

## Topic Statement

The IntelliJ plugin's Share overlay state machine: for a share subject (a whole branch, or a single commit on a branch) it lazily mints **at most one** live, Space-backed link, flips that link's access tier in place across three visibility levels, invites people (which grants them access server-side before it emails them), and removes recipients. It renders as an inline overlay inside the same summary detail webview used for everything else about a memory — there is no separate share window, dialog, or standalone browser. It is a Kotlin port of the VS Code Share popover (234), narrower in a few real, verified ways documented below.

## Scope

**In scope:**

- The overlay's render states and the two entry points that open it.
- The host-driven first-open sequence and why it exists.
- The three visibility tiers (`public`, `org`, `people`) and what each means for who can open the link.
- Lazy link creation: opening the overlay never mints; the first Copy, access change, or Send-invite mints.
- The dead-link rule: a `people` link with nobody invited is auto-revoked (or never minted) — reachable only implicitly.
- The invite flow's ordering — grant access, then email — and that a mail failure never revokes access.
- Reconcile-on-open for a live branch link, gated by a content fingerprint.
- The org-member directory fetch and its (lack of a) cache.
- The wire contract for creating, updating, revoking, and inviting on a live share.
- The verified gaps against the VS Code analog (234): no explicit stop-sharing action, no expiry/liveness check, no directory cache, no description field on the wire payload.

**Out of scope (boundaries):**

- The persisted record and its keying — see **IntelliJ Branch Share Store** (261).
- The content-push mechanics that build the covered doc lists — see **IntelliJ Push Orchestration** (263).
- The overlay's HTML/CSS and the JCEF↔Kotlin message bridge mechanics in general (the summary detail webview itself) — referenced only insofar as the overlay is hosted inside it.
- The binding chooser dialog shown when the repo has no Space binding yet — injected here as a callback; its own UI is out of scope.
- The pre-existing per-memory push (252) and its own Share button — a different feature, sharing no code with this one.
- The VS Code Share popover (234) itself — referenced only to name parity and gaps.

## Data Contracts

### Visibility tiers

| Tier | Who can open | Notes |
| --- | --- | --- |
| `public` | Anyone with the link, no login (bearer URL). | Never carries a recipients allowlist. |
| `org` | Any signed-in member of the share's org, **∪** any invited recipients. | Offered only when the API key carries an org capability (an org slug in its decoded payload). |
| `people` | Invited recipients only. | A `people` link with an empty allowlist is a dead owner-only link. |

### Overlay states

The overlay renders one of:

- **Needs API key** — no credential configured; every action short-circuits to this.
- **Loading** — a labelled spinner (used while opening a fresh branch reconcile, or while an action is in flight).
- **Ready** — the working state, carrying: the subject label (branch name, or "branch · commit `<hash8>`"), a human subtitle (commit message for a commit subject, branch name for a branch subject), the decision (topic) count, whether the org tier is offered, the subject's single link when minted (URL + tier + invited people), the current user as a fixed Owner row, and two suggestion groups — account (org) members and git contributors not already in the account group.
- **Error** — a message; the overlay stays open, with a retry action that re-opens.

There is no "seed defaults" field anywhere in this state — see Notable Behavior (this overlay never offers a stranded prior share's tier/people as pre-fill, because its store has no seed-selection read at all — 261).

### Wire contract (live share endpoints)

All calls carry the same bearer + client-version + tenant/org headers as the ordinary summary push, and resolve their origin from the API key's embedded URL when no explicit base is given.

| Operation | Method + path | Body | Success shape |
| --- | --- | --- | --- |
| Create link | `POST /api/share/branch` | `{ repoUrl, repoName, branch, kind: "branch"\|"commit", visibility, decisionCount, headCommitHash, commitHashes[], branchSlug?, ref, recipients? }` — no content blob; `ref` is the live content reference (261). **No `description` field** — see Notable Behavior. | `{ shareId, shareUrl, expiresAt, visibility, token?, recipients? }`. `token` present only for `public`. Requires `shareId` + a string `shareUrl`, else treated as a malformed response. |
| Update link | `PATCH /api/share/branch/<id>` | Any of `{ visibility?, expiresAt?, ref?, recipients? }`. | May echo only changed fields; any 2xx with a parseable JSON body is accepted. A recipients-only or ref-only PATCH legitimately omits `shareUrl`/`visibility`/etc., and the caller falls back to the prior stored value for anything omitted. |
| Revoke link | `DELETE /api/share/branch/<id>` | none | `200`, `204`, or `404` all count as success (404 = already gone → idempotent). |
| Invite people | `POST /api/share/branch/<id>/invite` | `{ recipients: string[], message? }` | `{ sent: string[], failed: string[] }`. |
| Recipient directory | `GET /api/jolli-memory/org-members` | none | `{ members: [{ email, name }] }` — active users only. Best-effort; any failure yields an empty list. |

A `426` on any of these maps to the plugin-outdated error. Other non-2xx surfaces a combined `<error> — <message> (HTTP <status>)`, with a raw-body tail when the body did not parse as JSON.

## Behavior

### The two entry points and the host-driven first open

Two surfaces open the overlay, and both follow the same two-step sequence: **first** open or focus the memory's detail editor tab, **then** ask that already-open (or newly-opening) editor to reveal its share overlay.

- A sidebar-level **Share** action shares the whole branch: it resolves the newest committed memory on the branch, opens (or focuses) its detail editor, and requests the overlay in branch mode. With no committed memories on the branch, it reports that instead of opening anything.
- A per-commit **Share** icon (a Commits-list row hover action) shares that one commit: it resolves that commit's summary, opens (or focuses) its detail editor, and requests the overlay in commit mode.

The request to reveal the overlay is asynchronous relative to the editor's own page load: the detail webview loads its HTML and JS independently, and only signals "loaded" on its own first paint. The open request is deferred until that signal arrives — if the request arrives before the page has finished loading, it is remembered and replayed the moment loading completes; if the page was already loaded (the editor tab was already open), the request runs immediately. Either way, the actual reveal is done by **the host explicitly invoking the client's open function** after load — the client's own script never calls it on load by itself. This ordering exists specifically to avoid a race against the JS↔Kotlin bridge not yet being wired up when the page first paints.

### Open

1. No API key → **needs-API-key** and stop.
2. If the subject already has a live share whose reference is a **branch collection** (i.e. this is a whole-branch subject with an existing link), post a "Syncing…" loading state and reconcile it (re-push current `base..HEAD` and rebuild the covered list — see 263 for the mechanics). Reconcile is skipped outright for a commit subject (fixed doc list, nothing to reconcile) or when there's no existing link. A reconcile failure is reported but does not block rendering — the overlay falls back to the cached record.
3. Post the **ready** state. Opening **never mints** a link.

Critically, step 2's reconcile check does **not** consult the record's expiry at all — it fires whenever a branch-collection record exists, live or lapsed. See Notable Behavior.

### Ready state assembly

- Read the subject's record (261). There is no separate "seed" read — only the subject's own record exists to render from.
- If the subject has a record with both a non-empty share id and a non-empty URL, and that URL passes the Jolli origin allowlist, render it (URL + tier + recipients); otherwise the link renders as absent. **No expiry check is applied here or anywhere else** — an expired record with a well-formed id/URL still renders as a live, openable link. See Notable Behavior.
- Decision count: use the record's cached count when present; otherwise compute the subject's current count on the fly (free from the open memory for a commit; a `base..HEAD` load for a branch).
- The account-member and git-collaborator suggestion lists, and the owner row, are supplied fresh by the caller on every open (see below) — the overlay itself does not cache them across opens.

### Copy link

- Copying an **existing** live link does not repaint the ready state — it only copies and flashes the button.
- If no live link exists, this is a lazy-mint moment: mint at the requested tier — **except** `people`, which needs an invitee first, so a missing/empty `people` link is reported ("add people first…") and not minted.
- If a live link exists at a **different** tier than requested, flip it in place first, then copy.
- The URL is asserted against the origin allowlist before it reaches the clipboard; an allowlist or clipboard failure reports and returns not-copied.

### Set access tier

- No link yet: `public`/`org` mint immediately (silently); `people` mints nothing (Send-invite will).
- Existing link:
  - Selecting `people` on a link with nobody invited **revokes** the link (a `people` link with no one invited is a dead owner-only link) — this is the only way the underlying share is ever actually revoked from this tier-selection path.
  - Otherwise flip the tier in place if it differs.

### Send invite

1. Normalize recipients (trim, lowercase, dedupe, drop the owner and empties). Empty set → report and re-render.
2. Resolve the target tier — the caller-supplied tier defaults to `people` when omitted.
3. Ensure a link exists at that tier: mint one if none (remembering it was minted for this invite), or flip an existing link's tier first if it differs.
4. Call the invite endpoint. It **grants access server-side first** (merges the emails into the allowlist), **then** emails each recipient. The merged allowlist is mirrored into the local record regardless of per-recipient email outcome.
5. Report sent count (info) and any failed addresses (error) — **a mail failure never revokes access**.
6. **Rollback on invite-call failure:** if the invite call itself throws, and a link was minted purely for this invite, that link is revoked (best-effort; a rollback failure is swallowed). A tier flip that preceded a failed invite is **not** separately reverted — only a fresh mint is rolled back.

### Remove a recipient

- Remove the email from the allowlist. If that empties the allowlist **and** the tier is `people`, the link is **revoked** entirely (dead owner-only link); an `org` link keeps its site-wide access with an empty allowlist.

## Notable Behavior — verified gaps vs. the VS Code analog (234)

These are confirmed by reading the live code, not inferred from absence of a mention:

- **No "stop sharing" user action exists.** There is no entry point that revokes a share as a direct, explicit user intent (no "Stop" button, no equivalent command). A share is revoked only as an *implicit side effect* of another action, at three call sites: selecting `people` access on a link with an empty allowlist; removing the last recipient from a `people` link; and — as a transactional rollback — an invite call that throws after freshly minting a link (this undoes the just-created mint and so can revoke a link at any tier, including `org`). The first two are the "would leave a dead owner-only link" cleanups; the third is failure recovery. Outside these, a `public` or `org` link, once successfully minted, has no path to revocation at all. (Real gap; confirmed by exhaustively finding every call site of the revoke operation — none is a direct, user-facing stop action.)
- **No expiry or liveness check anywhere in this feature.** The `expiresAt` field is faithfully stored on create, echoed back and re-stored on every subsequent update/reconcile — but nothing ever compares it to the current time. The overlay's context object even carries a nullable "now" timestamp field through its construction, but that field is never read by any of the overlay's logic — it is plumbed in and then unused. Concretely: the ready-state link-liveness check tests only "has an id and a URL and passes the origin allowlist," never expiry; and reconcile-on-open fires for any existing branch-collection record regardless of whether its `expiresAt` has passed. A lapsed share therefore keeps rendering, keeps reconciling, and keeps flipping tiers exactly like a fresh one. (Real gap; the unused "now" parameter is a specific, concrete signal that liveness checking was scaffolded for but never wired up.)
- **The org-member directory has no cache.** It is fetched from the backend fresh on every single open of the overlay (every entry-point invocation rebuilds the whole share context, including this call), with no short-TTL memoization, no dedup of overlapping opens, and no distinction between an empty result and a failed one — both just yield an empty suggestion list for that open. (Real gap.)
- **No `description` field on the create/update wire payload.** The VS Code analog sends a one-line blurb (derived from the head commit's recap or subject line) that the share page displays alongside the link and includes in invite emails. This client never populates or sends any such field on either the create or update call. (Real gap.)

## Notable Behavior — other findings

- **Lazy creation.** Opening the overlay mints nothing. The link is born on the first Copy / access change / invite, at the moment content is pushed. (Notable; matches VS Code intent.)
- **A `people` link with nobody invited cannot persist.** It is never minted directly, and is revoked the moment it would otherwise end up with an empty allowlist. (Notable.)
- **Invite grants access, then emails — and a mail failure keeps the grant.** Access is a server-side allowlist merge; the email is a notification. Losing the email does not lose access. (Notable.)
- **Reconcile-on-open is gated by kind and by content fingerprint, but not by expiry.** Only an existing branch-collection record reconciles, and even then only when a content fingerprint shows the shared memory changed — ordinary re-opens of unchanged content don't re-push. But as noted above, an expired record reconciles exactly like a live one. (Notable; partial gate.)
- **Every rendered/copied URL is origin-checked.** A record whose URL fails the Jolli allowlist renders as absent; copy asserts the origin before touching the clipboard. (Notable.)
- **The controller's dependency struct forwards a read-summary callback into every push.** Its injected dependencies gained a read-summary-by-commit-hash passthrough that is plumbed straight into the push context it builds — pure plumbing that enables the push orchestrator's delayed unresolved-orphan resolution (263); the controller itself does nothing else with it. (Footnote.)
- **The org tier is capability-gated by the API key.** It is offered only when the key's decoded payload carries an org slug. (Notable.)
- **The overlay lives inside the memory's own detail webview, never a separate window.** Both the whole-branch and single-commit entry points converge on the same overlay markup and script inside that one webview; there is no standalone share dialog or window in the current codebase (confirmed absent — see 263's Notable Behavior for the full account of what was removed).

## State Transitions

For one subject:

| From | Trigger | To |
| --- | --- | --- |
| any | No API key | Needs-API-key |
| No link | Copy (`public`/`org`) | Mint → link shown |
| No link | Copy (`people`) | Reported "add people first"; no link |
| No link | Set access (`public`/`org`) | Mint → link shown |
| No link | Set access (`people`) | No mint (awaits invite) |
| No link | Send invite | Mint (target tier) → grant → email → link shown |
| Link | Copy (same tier) | Copied + flash (no re-render) |
| Link | Copy / Set access (different tier) | Tier flipped in place |
| Link (`people`) | Set access `people` with empty allowlist | Link revoked |
| Link (`people`) | Remove last recipient | Link revoked |
| Link | Send invite | (flip tier if needed) → grant → email; fresh-mint rollback on failure |
| Live branch-collection link (any expiry) | Open | Reconcile (if content fingerprint changed) then re-render |
| Link | *(no direct "stop" trigger exists)* | — |

## Shared Behavior

- **Persistence, keying, single-slot invariant** — **IntelliJ Branch Share Store** (261); this overlay is its only reader/writer besides the reconcile path.
- **Content push, cross-commit dedup, and covered-list construction** used by every mint/reconcile — **IntelliJ Push Orchestration** (263).
- **Binding chooser** — injected as a callback; opened and its outcome mapped by the same repo-binding surface the ordinary summary push uses.
- **VS Code analog** — **VS Code Live Branch Share** (234); this spec documents where the IntelliJ port narrows or diverges from it.
