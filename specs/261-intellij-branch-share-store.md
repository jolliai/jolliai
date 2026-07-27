# 261. IntelliJ Branch Share Store

## Topic Statement

The IntelliJ plugin's per-project persisted record of the live shares this machine has created — at most **one** share per share subject (a whole branch, or a single commit on a branch) — stored as a gitignored JSON file that the Share overlay reads to re-open a subject to its existing link, flip that link's access tier in place, and drive Copy/Invite/Remove. It is a Kotlin port of the VS Code single-slot store (233), with one deliberate omission: it never seeds a fresh subject's defaults from a prior stranded record.

## Scope

**In scope:**

- The subject-keying scheme that lets a whole-branch share and any number of single-commit shares on the same branch coexist without collision.
- The single-slot invariant: one record per subject, whatever its access tier; tightening or loosening access flips the same record in place rather than creating a coexisting second link.
- The persisted record shape and the two shapes of the live content reference it may carry (a per-commit branch collection vs. a fixed commit-doc list).
- Read / upsert / remove semantics, including idempotent removal.
- Corruption and version tolerance (drop-and-recreate, no migration).
- Per-project write serialization and atomic on-disk replacement.
- The explicit divergence from the VS Code analog: no seed-selection read path exists.

**Out of scope (boundaries):**

- The Share overlay UI, its state machine, lazy link creation, and access-tier flips — see **IntelliJ Live Branch Share** (262).
- The content-push pipeline that builds the live content reference (`covered` / commit-doc lists) — see **IntelliJ Push Orchestration** (263).
- The share create / update / revoke / invite wire calls and their auth — see 262.
- The pre-existing per-memory push and its own record-keeping — see **IntelliJ Share-to-Jolli Core** (252), which does not use this store at all.
- The VS Code analog's store and its seed-selection behavior — see **Branch Share Store** (233); referenced only to name the divergence.

## Data Contracts

### Location and ownership

- One file per project, under the project's gitignored per-project state directory (the same directory family used by the plugin's other local caches). Absent until the first share is created for that project.
- This is a **local cache**, not the system of record. The backend owns share lifecycle; the account-level web dashboard is the authoritative cross-repo surface. Both align on the opaque **share id** each record carries.

### Share subject and its key

A **share subject** is either a whole branch or a single commit on a branch. Its map key is:

| Subject | Key |
| --- | --- |
| Whole-branch share | The bare branch name. |
| Single-commit share | The branch name and the commit hash, joined by a `:` separator. |

The separator is a character a git ref name can never contain, so the two key namespaces can never collide and the key stays human-readable in the file, logs, and an editor. A commit subject's key embeds its commit hash; a branch subject's key is just the branch name.

### The single-slot invariant

A subject holds **at most one** share record, regardless of the link's access tier. There is never a public link and a member link coexisting for the same subject. Changing access flips that one record's tier in place (the backend re-issues the link for the new tier and the previous link dies), mirroring the backend's single unique index per subject. Upserting a subject overwrites whatever record it held.

### Record shape

| Field | Type | Meaning |
| --- | --- | --- |
| Share id | string | Opaque backend id; the alignment key between this cache, the backend, and the web dashboard. |
| Share URL | string | The link to render / copy / open. |
| Visibility | `public` \| `org` \| `people` | Access tier. `public` = bearer link, anyone with the URL, no login. `org` = auth-gated, any signed-in member of the share's org ∪ any invited recipients. `people` = auth-gated, invited recipients only. A subject has one record; changing access flips this field. |
| Recipients | list of strings, optional | The member link's invited-people allowlist (lowercased emails). Backend-authoritative (written by the invite / audience-change calls, echoed back, gated on the view route); cached here for re-open. Never set on `public`. |
| Live content reference | object, optional | What live Space content the share renders from (see below). |
| Head commit hash | string, optional | The subject's tip at create/reconcile time. Backs a server NOT-NULL column and its idempotency index. |
| Content hash | string, optional | Fingerprint of the shared content (per-commit topics + recap + plan/note revisions) at the last push. Reconcile re-pushes only when it differs from the subject's current fingerprint, so a memory edit that does not advance git HEAD (topic edit, regenerated summary, plan/note change) is still detected. |
| Expires at | string (timestamp) | When the link lapses, as reported/echoed by the backend. Stored and carried through every read-modify-write, but — see 262 — nothing in this plugin ever compares it to the current time. |
| Decision count | number | Topic count for the subject, captured at share/reconcile time. Cached so the overlay subtitle need not reload every summary to show "N decisions". |

### Live content reference shapes

A share is always **live** — it references current Space documents by id, never a frozen content blob. Two shapes, distinguished by a kind discriminator:

- **Branch collection** — a per-commit allowlist. Carries a relative-path identity for the branch and a `covered` list of `{ commit hash, summary doc id, attachment doc ids }`, one entry per commit in the subject's current `base..HEAD`.
- **Commit docs** — a fixed list of summary doc ids plus a flat list of attachment doc ids (a single-commit share).

## Behavior

### Read a subject's record

Return the subject's record, or nothing if absent. The caller passes a commit hash for a commit subject and omits it for a branch subject; keying is derived from that. This is the **only** read the store exposes — there is no second, "prior record" result alongside it (contrast 233; see Notable Behavior).

### Upsert a subject's record

Create-or-replace the subject's single record. Whatever was there is overwritten — a subject holds exactly one link.

### Remove a subject's record

Idempotent: removing an absent subject is a no-op; removing a present one drops the entry entirely (not a tombstone).

### Corruption and version tolerance

- The file carries a monotonically increasing version number.
- A file whose version does not match the current one, or that fails to parse as JSON, or that fails to read for any other reason, is treated as empty (no shares) and silently recreated on the next share. There is no migration — an older on-disk shape is never mistaken for the current one.
- Corruption never aborts a share — it degrades to "no shares yet".

This mirrors the drop-on-mismatch, versioned, best-effort per-project JSON cache pattern used elsewhere in the plugin's local state (and matches the VS Code store's own tolerance policy, 233).

### Concurrency and durability

- Writes for one project are funneled through a single read-modify-write lock (one lock per project directory), so rapid Share/Copy/Invite clicks — each dispatched on a pooled thread — cannot lose an update or collide on a temp filename.
- Each write replaces the file atomically (write-temp-then-move), with a same-content overwrite fallback for filesystems that reject an atomic move onto an existing path.

## Notable Behavior

- **Single-slot, not append.** Tightening access does not leave the looser link behind; the one record flips and the old link dies. This is the store's core guarantee and matches the backend's one-row-per-subject uniqueness. (Notable.)
- **No seed-selection.** This is the one deliberate structural divergence from the VS Code store (233): the read path returns only the subject's own record, never a second "best prior record" to seed a fresh subject's defaults from. A commit subject that has been re-keyed by an amend/rebase (its key embeds the now-orphaned commit hash) strands its old record with no path back to it — the overlay for the new commit hash starts blank (needs-API-key or no-link state), it does not offer the stranded share's tier/recipients as pre-filled defaults. (Divergence; confirmed by the absence of any seed-lookup entry point in the store or its caller.)
- **Corruption is silent and recoverable.** A malformed or stale-version file is treated as "no shares yet" and rebuilt, rather than surfaced as an error — a share must never be blocked by a bad cache. (Notable.)
- **Recipients are cached but backend-authoritative.** The allowlist is written by the backend (invite / audience change) and echoed back; the local copy is a convenience for re-open, never the source of truth. Never present on a `public` record. (Notable.)
- **Expiry is stored, never evaluated here.** The store carries the field through every write untouched; it performs no liveness check of its own. See 262 for what (if anything) downstream does with it.

## Shared Behavior

- **Versioned drop-on-mismatch per-project JSON cache** — the same tolerance pattern used by the store's VS Code analog (233) and other local per-project caches in this codebase.
- **The Share overlay** that reads and writes this store — lazy link creation, access-tier flips, invites — is **IntelliJ Live Branch Share** (262).
- **The content-push pipeline** that produces the live content reference stored here is **IntelliJ Push Orchestration** (263).
- **VS Code analog** — **Branch Share Store** (233); this port matches its keying, single-slot invariant, and corruption tolerance, but drops seed-selection entirely.
