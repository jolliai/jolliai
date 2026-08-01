# 234. VS Code Live Branch Share

## Topic Statement

The Share popover's state machine: for a share subject (a whole branch, or a single commit on a branch) it lazily mints **at most one** live, Space-backed link, flips that link's access tier in place across three visibility levels, invites people (which grants them access server-side before it emails them), and keeps a branch link's rendered content current by reconciling on open. Every rendered or copied URL is re-checked against the Jolli origin allowlist.

## Scope

**In scope:**

- The popover entry points and the state each computes: open, copy link, set access tier, send invite, remove a recipient, stop the link.
- The three visibility tiers (`public`, `org`, `people`), what each means for who can open the link, and the org-tier capability gate.
- Lazy link creation: opening the popover never mints; the first Copy, access change, or Send-invite mints.
- The dead-link rule: a `people` link with nobody invited is auto-revoked (or never minted).
- The invite flow's ordering — grant access, then email — and that a mail failure never revokes access.
- What "live" means: the link references current Space docs (a covered doc-id allowlist), never a frozen blob.
- Reconcile-on-open for an unexpired branch link, gated by a content fingerprint.
- Rollback of a link minted (or a tier flipped) purely to carry an invite when the invite then fails.
- The access-change race guard (trust the requested tier, not the server echo).
- Origin-allowlist enforcement on every rendered/copied URL.
- The recipient-suggestion directory (org members) with its bounded, short-TTL, non-empty-only cache.
- Seeding a fresh subject's default tier + people from a stranded prior record.
- The wire contract for creating, updating, revoking, and inviting on a live share.

**Out of scope (boundaries):**

- The persisted record and its keying/seed-selection — see **Branch Share Store** (233).
- The content-push mechanics that build the covered doc lists — see **VS Code Push Orchestration** (236).
- The popover's DOM, CSS, and host↔webview message plumbing — see **VS Code Summary Webview Panel** (109).
- The binding chooser UI that appears when the repo has no Space binding — see **VS Code Binding Chooser Webview** (117); this layer only injects a callback.
- The `426`/plugin-outdated mapping — see **Plugin Outdated Flow** (96).
- The single-document push/delete RPC — see **Summary Push to Jolli Space** (94).

## Data Contracts

### Visibility tiers

| Tier | Who can open | Notes |
| --- | --- | --- |
| `public` | Anyone with the link, no login (bearer URL). | Never carries a recipients allowlist. |
| `org` | Any signed-in member of the share's org, **∪** any invited recipients (grants union). | Offered only when the API key carries an org capability (an org slug in its decoded payload). Auth-gated view route; no bearer token. |
| `people` | Invited recipients only. | Auth-gated view route. A `people` link with an empty allowlist is a dead owner-only link. |

### Popover states

The popover renders one of:

- **Needs API key** — no credential configured; every action short-circuits to this.
- **Loading** — a labelled spinner (e.g. while reconciling), used only where the card is meant to swap to a spinner.
- **Ready** — the working state, carrying: the subject label (branch name, or "branch · commit `<hash8>`"), a human subtitle (commit message for a commit subject, branch name for a branch subject), the decision (topic) count, whether the org tier is offered, the subject's single link when minted (URL + tier + invited people), optional **seed defaults** (last-used tier + people) for a subject with no link yet, the current user as a fixed Owner row, and two suggestion groups — org members ("from your account") and git collaborators.
- **Error** — a message; the popover stays open.

### Wire contract (live share endpoints)

All calls are HTTPS (HTTP tolerated only against the local-development host), carry the same bearer + client-version + tenant/org headers as the summary push (see 94), and resolve their origin from the API key's embedded URL when no explicit base is given.

| Operation | Method + path | Body | Success shape |
| --- | --- | --- | --- |
| Create link | `POST /api/share/branch` | `{ repoUrl, repoName, branch, kind: "branch"\|"commit", visibility, decisionCount, headCommitHash, commitHashes[], branchSlug?, description?, ref, recipients? }` — no content blob; `ref` is the live content reference (233). | `{ shareId, shareUrl, expiresAt, visibility, token?, recipients? }`. `token` present only for `public`. Requires `shareId` + a string `shareUrl`, else treated as a malformed response. |
| Update link | `PATCH /api/share/branch/<id>` | Any of `{ visibility?, expiresAt?, ref?, description?, recipients? }`. | May echo only changed fields; any 2xx with a body is accepted. A recipients-only or ref-only PATCH legitimately omits `shareUrl`/`visibility`/etc. |
| Revoke link | `DELETE /api/share/branch/<id>` | none | `200`, `204`, **or `404`** all count as success (404 = already gone → idempotent). |
| Invite people | `POST /api/share/branch/<id>/invite` | `{ recipients: string[], message? }` | `{ sent: string[], failed: string[] }`. A 2xx with no per-recipient breakdown (e.g. accepted-for-async) is treated as "all requested sent" — but a non-JSON body (a misrouted SPA HTML page) is **not** accepted as success. |
| Recipient directory | `GET /api/jolli-memory/org-members` | none | `{ members: [{ email, name }] }` — active users only. Best-effort; any failure yields an empty list. |

A `426` on any of these maps to plugin-outdated (see 96). Other non-2xx surfaces `<error> — <message> (HTTP <status>)`, with a raw-body tail when the body did not parse.

#### Implementations of this wire contract

There are now **three** independent implementations of the five calls above: this editor-extension client, the JVM plugin's client (which backs the JVM live-share surface, 262), and — newly — a CLI-side client reachable only through a hidden CLI bridge action family (one action per call: create, update, revoke, invite, list org members).

**The CLI implementation has zero live callers in this repository.** No shipped surface invokes those bridge actions: the editor extension calls its own client directly and the JVM plugin still calls the backend directly through its own client. The CLI implementation is real, reachable-in-principle, and covered by its own tests, but nothing in the product drives it today — so a reader must not assume a share performed by any surface goes through it, and must not treat it as the canonical implementation.

Where it can be compared, it agrees with this contract: same five endpoints, same bodies, same bearer + client-version + tenant/org headers, the same origin resolution from the API key's embedded URL, the same `410`-or-revoked → revoked mapping, the same `426` → plugin-outdated mapping, and the same idempotent treatment of `404` on revoke. Two behaviors are worth recording because they are narrower than this spec's editor-extension contract: its update call accepts a `2xx` only when a JSON body is present (a bodiless `2xx` is treated as a failure rather than as "nothing changed"), and its org-member directory read never throws — any failure or malformed row degrades to an empty list. It carries no retry logic, and it does not re-assert the origin allowlist at request time (matching the product-wide save-time validation posture).

The description is a one-line blurb (head commit's recap, else its subject line, whitespace-collapsed, capped ~200 chars) shown on the share page and in the invite email; omitted when the head summary yields no text.

## Behavior

### Open

1. No API key → **needs-API-key** and stop.
2. If the subject already has a **live, unexpired branch** link that references a branch collection, swap to a "Syncing…" loading state and **reconcile** it (re-push current `base..HEAD` and rebuild the covered list — see 236 for the mechanics). Reconcile is skipped for commit links (fixed doc list) and for expired links (reconciling a dead link would re-push everything and could resurrect it). A reconcile failure is best-effort: report it and fall back to the cached record — **except a push-disabled refusal, which is skipped silently** (see below).
3. Post the **ready** state (below). Opening **never mints** a link.

### Ready state assembly

- Read the subject's record **and** its seed record in one pass (233). Both reads are **backend-scoped**: the store is passed the current credential's backend key (its registrable domain), and a record whose share-URL backend differs reads as absent, so a share minted against a different backend never resurfaces for re-open or seeding (see 233). This scoping applies to every share-store read in this pipeline and in the share controller/modal.
- Filter both by liveness: a record is live only if it has an id + URL, is unexpired, and its URL passes the origin allowlist; anything else renders as absent. (Unknown clock / unparseable expiry is treated as live.)
- If the subject has a live link, render it (URL + tier + recipients). Otherwise, if the seed is live, offer its tier + people as **seed defaults** (UI hint only — nothing is granted until the user acts).
- Decision count: use the record's cached count; before the first share, compute the subject's current count (free from the open memory for a commit; one `base..HEAD` load for a branch).

### Copy link

- Copying an **existing** live link must not repaint the card — it only copies + flashes.
- If no live link exists, this is a lazy-mint moment: mint at the requested tier and re-render — **except** `people`, which needs an invitee, so a missing/empty `people` link is reported ("no one is invited yet…") and not minted.
- If a live link exists at a **different** tier than requested, flip it in place first (again refusing an empty `people` flip), then copy.
- The URL is asserted against the origin allowlist before it reaches the clipboard; a clipboard or allowlist failure reports and returns not-copied.

### Set access tier

- No link yet: `public`/`org` mint immediately (silently, so the dropdown keeps the user's choice); `people` mints nothing (Send-invite will).
- Existing link:
  - Selecting `people` with nobody invited **stops** the link (a `people` link with no one invited is a dead owner-only link) and informs the user.
  - Otherwise flip the tier in place if it differs.
- Flipping to `public` drops the recipients allowlist (the backend does too).

### Send invite

1. Normalize recipients (trim, lowercase, dedupe, drop the owner and empties). Empty set → report and re-render.
2. Resolve the target tier: `org` keeps site-wide access with invitees layered on (grants union); anything else (including `public`, which cannot hold an allowlist) resolves to `people`.
3. Ensure a link exists at that tier: mint one if none (remembering it was minted for this invite), or flip an existing link's tier if it differs (remembering the prior tier). A public link is flipped to `people` here so the invite actually tightens access rather than leaving it world-open.
4. Call the invite endpoint. It **grants access server-side first** (merges the emails into the allowlist), **then** emails each recipient. Mirror the merged allowlist locally.
5. Report `sent` (info) and `failed` (error: "access granted, but the email couldn't be sent to…"). **A mail failure never revokes access** — mail is notification, not permission.
6. **Rollback on invite failure:** if the invite call itself throws, revoke the link if it was minted purely for this invite, or revert the tier flip that preceded it; report if that rollback also fails.

Because the webview optimistically closes the popover on Send, invite errors are surfaced via a toast (the real reason — binding / nothing-to-share / HTTP), since the hidden error pane would be invisible.

### Remove a recipient

- Remove the email from the allowlist. If that empties the allowlist **and** the tier is `people`, stop the link entirely (dead owner-only link); an `org` link keeps its site-wide access with an empty allowlist.

### Lazy mint failures

When a mint (link creation via the push pipeline) fails, the specific reason is posted into the error pane **and** returned so a caller whose pane is already closed can toast it. The message distinguishes: a Space-binding problem (chooser already open elsewhere / user cancelled / couldn't be set up), "nothing to share yet on this branch", or a generic create failure.

### The per-repo outbound opt-out: mint aborts, reconcile skips quietly

Both paths run through the same push funnel, which raises `PushDisabledError` at the orchestrator's entry gate when the repo's outbound push is off (spec 310). They treat it differently on purpose:

- **Mint** (Copy / tier flip / invite) propagates it. The user just asked for a link and nothing was published, so the refusal must be reported.
- **Reconcile** catches it and `return`s, leaving the cached record untouched (`vscode/src/services/LiveShareController.ts:550-559`). Reconcile is a best-effort background pass the modal runs on **every** view, so a push-disabled repo simply means "nothing to sync outbound". Letting it escape would render the user's own setting as the modal's red "Couldn't refresh the shared content" toast on every open. Mirrors IntelliJ's reconcile branch (262).

The **whole-branch** share loop has its own repo-wide stop test on top of this — see 236.

## State Transitions

For one subject:

| From | Trigger | To |
| --- | --- | --- |
| any | No API key | Needs-API-key |
| No link | Copy (`public`/`org`) | Mint → link shown |
| No link | Copy (`people`) | Reported "no one invited"; no link |
| No link | Set access (`public`/`org`) | Mint → link shown |
| No link | Set access (`people`) | No mint (awaits invite) |
| No link | Send invite | Mint (target tier) → grant → email → link shown |
| Link | Copy (same tier) | Copied + flash (no re-render) |
| Link | Copy / Set access (different tier) | Tier flipped in place |
| Link (`people`) | Set access `people` with empty allowlist | Link stopped |
| Link (`people`) | Remove last recipient | Link stopped |
| Link | Send invite | (flip tier if needed) → grant → email; rollback on failure |
| Live branch link | Open | Reconcile (if content changed) then re-render |
| Link | Stop | Link revoked; record cleared |

## Notable Behavior

- **Lazy creation.** Opening the popover mints nothing. The link is born on the first Copy / access change / invite, at the moment content is pushed. (Surprising; intentional.)
- **A `people` link with nobody invited cannot exist.** It would be openable only by its owner, so it is never minted (or is stopped when it becomes empty). (Surprising; intentional.)
- **Invite grants access, then emails — and a mail failure keeps the grant.** Access is a server-side allowlist merge; the email is a notification. Losing the email does not lose access. (Notable.)
- **The access flip trusts the request, not the echo.** After a successful PATCH the tier is taken from what was asked for; a stale or omitted server echo previously reverted the tier silently (e.g. a flip to public rendered back as org). Echo and existing value are only fallbacks. (Surprising; intentional.)
- **Reconcile-on-open is gated twice.** Only a live, unexpired **branch** link reconciles, and even then only when a content fingerprint shows the shared memory changed — so ordinary re-opens don't re-push. The fingerprint hashes each summary's topics, recap, plan/note revisions, **and its references** (each reference's stamp bumps on a new/changed reference), so adding or updating a shared reference triggers a reconcile even when git HEAD hasn't moved. Commit links never reconcile. (Notable.)
- **A push-disabled repo makes reconcile a silent no-op, but still blocks a mint loudly.** The same refusal from the same funnel is reported on the path the user initiated and swallowed on the path the modal initiates for them. Surfacing a user's own opt-out as a red "couldn't refresh" toast on every popover open would be noise about a setting they chose. (Surprising; intentional asymmetry — spec 310.)
- **Rollback undoes a mint/flip done only to carry an invite.** If the invite fails, a link that existed solely to invite is revoked, or a tier bump is reverted, so a failed invite doesn't leave a stray or over-open link. (Notable.)
- **Every URL is origin-checked before it's shown or copied.** A record whose URL fails the Jolli allowlist renders as absent, and copy asserts the origin before touching the clipboard — a defense against a tampered cache. (Notable.)
- **The org tier is capability-gated by the API key.** It is offered only when the key's decoded payload carries an org; keys without one never see the org option. (Notable.)
- **The recipient directory cache is deliberately timid.** Org members are capped, cached per credential for a few minutes, and **only a non-empty result is cached** — a transient failure or an empty read never sticks, so the next open re-fetches. (Notable.)
- **Seed defaults resurrect a stranded commit share's audience.** After an amend/rebase re-keys a commit share, opening the modal on the new commit offers the prior tier + people as pre-filled defaults (never a live grant), filtered so an intentionally-lapsed grant doesn't reappear. (Notable.)
- **Copying an existing link doesn't repaint.** Only a mint or a tier flip re-renders; a plain copy just flashes the button, matching the mock's "copy + flash" behavior. (Notable.)
- **A third, unused implementation of the wire contract exists in the CLI.** It is not an extraction from the summary-push client (that client has never contained any share code) and it is not wired into any surface — no shipped host calls its bridge actions. Documented so a reader does not assume the share protocol has been consolidated: it has not, and the count of live implementations is still two. (Surprising.)

## Shared Behavior

- **Origin allowlist** — the same HTTPS-only, suffix-boundary Jolli allowlist enforced everywhere (see 94's shared-behavior references); applied here to every rendered/copied share URL.
- **Persistence, keying, single-slot invariant, and seed selection** — **Branch Share Store** (233).
- **Content push, cross-commit dedup, and covered-list construction** used by every mint/reconcile — **VS Code Push Orchestration** (236); its repo-wide fatal set is **Repo-Wide Push-Refusal Classification** (327).
- **The per-repo outbound-push opt-out** that raises the refusal both paths see — **Per-Repo Outbound-Push Control** (310).
- **Binding chooser** — injected as a callback; the chooser webview and its outcomes are **VS Code Binding Chooser Webview** (117).
- **Plugin-outdated mapping** on a `426` — **Plugin Outdated Flow** (96).
- **Popover DOM/CSS and host↔webview messaging** — **VS Code Summary Webview Panel** (109).
