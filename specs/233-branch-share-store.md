# 233. Branch Share Store

## Topic Statement

The per-repo persisted record of the live shares this machine has created — at most **one** share per share subject (a whole branch, or a single commit on a branch) — stored as a gitignored JSON file that the Share UI reads to re-open a subject to its existing link, flip that link's access tier in place, drive Copy/Stop, and seed a fresh subject's defaults from a stranded prior share. It is a local cache aligned to the backend by share id, not the authoritative record of share lifecycle.

## Scope

**In scope:**

- The subject-keying scheme that lets a whole-branch share and any number of single-commit shares on the same branch coexist without collision.
- The **backend-scoping filter**: every read is passed the current credential's backend key and drops any record minted against a different backend, so a stale cross-environment record never reads back as live and never seeds.
- The single-slot invariant: one record per subject, whatever its access tier; tightening or loosening access flips the same record in place rather than creating a coexisting second link.
- The persisted record shape and the two shapes of the live content reference it may carry (a per-commit branch collection vs. a fixed commit-doc list).
- The one-pass read that returns both a subject's own record and the best prior record to seed a fresh subject's defaults from, and the same-kind seed-selection rule.
- Upsert / read / remove semantics, including idempotent removal.
- Corruption and version tolerance (drop-and-recreate, no migration).
- Per-project write serialization and atomic on-disk replacement.

**Out of scope (boundaries):**

- The Share popover UI, its state machine, lazy link creation, and access-tier flips — see **VS Code Live Branch Share** (234).
- The content-push pipeline that builds the live content reference (`covered` / commit-doc lists) — see **VS Code Push Orchestration** (236).
- The share create / update / revoke / invite wire calls and their auth — see 234 and **Summary Push to Jolli Space** (94). A **third** implementation of that wire protocol now exists in the CLI as well, reachable only through a hidden CLI bridge action family; it has **no live caller anywhere in this repository** and does not read or write this store. See 234.
- The backend's own share records and the account-level cross-repo management surface (the authoritative system of record); this store is a local cache that aligns to it by share id.

## Data Contracts

### Location and ownership

- One file per project, under the project's gitignored per-project state directory. Absent until the first share is created for that project.
- This is a **local cache**, not the system of record. The backend owns share lifecycle; the account-level web dashboard is the authoritative cross-repo surface. Both align on the opaque **share id** each record carries.

### Share subject and its key

A **share subject** is either a whole branch or a single commit on a branch. Its map key is:

| Subject | Key |
| --- | --- |
| Whole-branch share | The bare branch name. |
| Single-commit share | The branch name and the commit hash, joined by a `:` separator. |

The separator is a character that a git ref name can never contain, so the two key namespaces can never collide and the key stays human-readable in the file, logs, and an editor. A commit subject's key therefore embeds its commit hash; a branch subject's key is just the branch name.

### The single-slot invariant

A subject holds **at most one** share record, regardless of the link's access tier. There is never a public link and a member link coexisting for the same subject. Changing access flips that one record's tier in place (the backend re-issues the link for the new tier and the previous link dies), mirroring the backend's single unique index per subject. Upserting a subject overwrites whatever record it held.

### Record shape

| Field | Type | Meaning |
| --- | --- | --- |
| Share id | string | Opaque backend id; the alignment key between this cache, the backend, and the web dashboard. |
| Share URL | string | The link to render / copy / open. This is a **tenant-free base-domain** link (`https://<baseDomain>/share/<token>`), and its origin doubles as the record's **backend identity**: the backend a share was minted against is recovered from this URL's origin at read time (reduced to the registrable domain), so no separate backend field is stored. A record whose share-URL backend does not match the current credential's backend reads as **absent** (see the backend-scoping filter below). |
| Visibility | `public` \| `org` \| `people` | Access tier. `public` = bearer link, anyone with the URL, no login. `org` = auth-gated, any signed-in member of the share's org ∪ any invited recipients. `people` = auth-gated, invited recipients only. A subject has one record; changing access flips this field. |
| Recipients | list of strings, optional | The member link's invited-people allowlist (lowercased emails). Backend-authoritative (written by the invite / audience-change calls, echoed back, gated on the view route); cached here for re-open. Never set on `public`. |
| Live content reference | object, optional | What live Space content the share renders from (see below). |
| Head commit hash | string, optional | The subject's `base..HEAD` tip the share last covered. When present it lets the reconcile-on-open path short-circuit a re-push if the tip is unchanged. A missing value reads as stale. |
| Content hash | string, optional | Fingerprint of the shared content (per-commit topics + recap + plan/note revisions + **reference revisions**) at the last push. The reconcile-on-open path re-pushes only when it differs from the subject's current fingerprint, so a memory edit that does **not** advance git HEAD (topic edit, regenerated summary, plan/note change, or a new/changed reference) is still detected. A missing value reads as stale. |
| Expires at | string (timestamp) | When the link lapses. Consumed by the caller's liveness check. |
| Decision count | number | Topic count for the subject, captured at share/reconcile time. Cached so the popover subtitle need not reload every summary to show "N decisions". |

### Backend scoping

Every read of this store is passed the **current credential's backend key** — the backend the active API key targets, reduced to its **registrable domain** (`acme.jolli.ai` → `https://jolli.ai`; `jolli-local.me` → `https://jolli-local.me`; a dot-less host or bare IP is kept whole; scheme and non-default port are preserved). A record's own backend is recovered the same way from its share-URL origin. A record is only visible to a read when the two backend keys are equal; otherwise it reads as **absent**.

The granularity is deliberately coarser than the per-tenant origin used for the summary/plan/note/reference doc-id reuse gate (see 236): the share URL is tenant-free (built from the backend's base domain, never a tenant host), so a share minted on any tenant of a backend must match a current key targeting that same backend — the tenant subdomain is stripped. The trade-off is that a same-deployment cross-tenant switch is treated as the same backend (an accepted, rare case). A blank/underivable current backend key, or a share URL that doesn't parse, is not trusted (reads as a mismatch).

**Why:** a record's share id belongs to exactly one backend's database. Returning a record from a different backend for re-open, tier-flip, or seeding would send that foreign share id to a server that never minted it, producing a 404 (`share_not_found`). Treating a foreign-backend record as absent instead makes the next Copy/Invite mint a fresh link against the current backend. This mirrors the doc-id URL-origin reuse guard (236), but at backend (registrable-domain) granularity because the share link is tenant-free.

### Live content reference shapes

A share is always **live** — it references current Space documents by id, never a frozen content blob. Two shapes:

- **Branch collection** — a per-commit allowlist. Carries a relative-path identity for the branch and a `covered` list of `{ commit hash, summary doc id, attachment doc ids }`, one entry per commit in the subject's current `base..HEAD`.
- **Commit docs** — a fixed list of summary doc ids plus a flat list of attachment doc ids (a single-commit share).

## Behavior

### Read a subject's record

Return the subject's record, or nothing if absent. The caller passes a commit hash for a commit subject and omits it for a branch subject; keying is derived from that. The caller also passes the **current backend key** (above): a record whose share-URL backend does not match reads as absent, exactly as if the subject held no record.

### Upsert a subject's record

Create-or-replace the subject's single record. Whatever was there is overwritten — a subject holds exactly one link.

### Remove a subject's record

Idempotent: removing an absent subject is a no-op; removing a present one drops the entry entirely (not a tombstone).

### Seed selection for a fresh subject

Alongside a subject's own record, the store can return the best **prior record to seed a fresh subject's defaults from** — used when the subject has no link yet, so the popover can bring back the last-used access tier and invited people instead of starting blank. The seed is:

- The most-recently-minted record (by latest expiry timestamp) of the **same kind** as the subject, **excluding the subject itself**, and **on the current backend** — a candidate whose share-URL backend differs from the current backend key is skipped, because a foreign share id must never seed a subject on the current server.
- **Same-kind is deliberate.** A commit subject seeds only from *other commit* records — the stranded ones. An amend/rebase re-keys a commit share (its key embeds the now-orphaned commit hash), stranding the previous record; the seed brings its tier + people back. A commit subject does **not** seed from the branch share: the branch share is a live sibling of a wider scope, and seeding a commit modal from it (then auto-staging its recipients) would duplicate-grant people who already have branch-wide access.
- A branch subject's key is stable (never re-keyed), so it has no same-kind prior and gets no seed.
- Expiry is **not** filtered during selection (the store has no clock); an unparseable expiry sorts oldest, so a well-formed record always outranks it. On a timestamp tie the later-encountered record wins. The caller applies its own liveness/expiry filter before using the seed, so an intentionally-lapsed grant never seeds people back.

The subject's own record and its seed are returned from a **single read** of the file, so re-opening the popover parses the file once rather than twice.

### Corruption and version tolerance

- The file carries a monotonically increasing version number.
- A file whose version or overall shape does not match the current one is **ignored** (treated as empty) and recreated on the next share. There is no migration — earlier on-disk shapes existed only on unreleased builds, and the version number stays past those so an old file is never mistaken for the current shape.
- **The backend-scoping filter added no on-disk field and did not bump the version.** A record's backend is recovered from its existing share-URL origin, not stored separately, so the file shape/version is unchanged and stays compatible with the sibling IDE plugin that reads/writes the same file. A file written by an older build that also carried a redundant per-record backend field still reads fine — the extra field is ignored.
- A read error other than "file absent" is logged and treated as empty; an unparseable-JSON file is logged and treated as empty. Corruption never aborts a share — it degrades to "no prior shares".

This mirrors the design of the **Commit Exclusion Selection Store** (188): a versioned, drop-on-mismatch, best-effort per-project JSON cache.

### Concurrency and durability

- Writes for one project are funneled through a single read-modify-write chain, so rapid Share/Stop clicks cannot lose an update or collide on a temp filename.
- Each write replaces the file atomically (write-temp-then-rename), with the platform's overwrite fallback for filesystems that reject rename-over-existing.

## Notable Behavior

- **Single-slot, not append.** Tightening access does not leave the looser link behind; the one record flips and the old link dies. This is the store's core guarantee and matches the backend's one-row-per-subject uniqueness. (Notable.)
- **A commit subject seeds from stranded commit records, never from the branch share.** The distinction exists specifically to avoid re-granting branch-wide recipients through a commit modal. (Surprising; intentional.)
- **The store has no clock.** It never expires anything itself; expiry lives on the record and is judged by callers. Seed selection deliberately ignores expiry and leaves the filter to the caller. (Notable.)
- **Corruption is silent and recoverable.** A malformed or stale-version file is treated as "no shares yet" and rebuilt, rather than surfaced as an error — a share must never be blocked by a bad cache. (Notable.)
- **A foreign-backend record is invisible, not deleted.** Switching the active credential to a different backend makes every record minted against the old backend read as absent — for re-open, tier-flip, and seeding alike — so no foreign share id is ever sent to the wrong server (which would 404). The record stays on disk untouched, so switching the credential back makes its still-live link revocable/re-openable again. (Surprising; intentional.)
- **Recipients are cached but backend-authoritative.** The allowlist is written by the backend (invite / audience change) and echoed back; the local copy is a convenience for re-open, never the source of truth. Never present on a `public` record. (Notable.)

## Shared Behavior

- **Versioned drop-on-mismatch per-project JSON cache** — same pattern as the **Commit Exclusion Selection Store** (188), including the single-write-chain serialization and atomic replace.
- **The Share UI** that reads and writes this store — lazy link creation, access-tier flips, invites, reconcile-on-open — is **VS Code Live Branch Share** (234).
- **The content-push pipeline** that produces the live content reference stored here is **VS Code Push Orchestration** (236).
