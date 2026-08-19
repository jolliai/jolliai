# 355. Dashboard Repo Registry and Probe

## Topic Statement

How a repository becomes known to this machine: the durable, machine-global list of enabled repositories, the identity derived for each, the paths that create or extend an entry, and the read-only probe that answers what picking a candidate folder would mean — a question no shipped surface asks any more, since the folder-browser add flow it was written for was deleted.

## Scope

**In scope:**

- The registry file: where it lives, why it is machine-global and outside the database, its shape, and its permissions.
- Identity derivation — a normalized remote first, a hashed main-worktree path second — and the display name derived alongside it.
- The two read policies (forgiving and strict) and why every writer must use the strict one.
- The write discipline: whole-file rewrite, atomic, under a machine-global best-effort lock, re-read inside the lock.
- The three mutations — full registration, worktree-list extension, and disable — and exactly which fields each is allowed to touch.
- The two checkout-list readers and how their answers differ for a repository whose every checkout is gone.
- The one repository-scoped database table a removal has to delete by hand, because the schema-derived child list cannot reach it.
- The database identity stamp carried in the same file.
- The callers that make a repository known, including the hook-side gap fill and its retry rule.
- The pre-registration folder probe: what it checks, what it reports, what it deliberately does not answer, and the fact that nothing in the browser reaches it.
- The direction of the relationship between this file and the database's repository table, and the one case where the table gets ahead of the file.
- The configuration-derived and hook-installation reads that exist for a settings surface but are **unreachable** at HEAD.

**Boundaries (consumed here, owned elsewhere):**

- The canonical remote-URL normalization (transport folding, port rules, host case-folding) — the Canonical Repo URL and Name Derivation topic. Only its outputs and its no-remote fallback matter here.
- The dashboard database, its repository table, the bootstrap/recovery import that reads this file, and the placeholder-row insert on the producer write path.
- The HTTP routes that expose the probe and drive registration — the Local Dashboard HTTP Server topic.
- The install / uninstall functions that lay down hooks alongside a registration.
- The per-checkout user opt-out flag and the repository profile it lives in.
- The cutover fence, and the fence lookup that also reads this file.
- The commit-summary backfill engine that supplies the probe's counts.

## Data Contracts

### The registry file

Path: **`~/.jolli/jollimemory/dashboard-repos.json`** (the machine-global configuration directory — the same directory as the dashboard database, which is what makes "the registry lives beside the database" a real invariant rather than a coincidence). Written with owner-only permissions (`0600`), pretty-printed with a trailing newline.

```json
{
  "version": 1,
  "instanceId": "…",
  "repos": [
    {
      "repoIdentity": "https://github.com/owner/name",
      "repoName": "name",
      "worktreeRoot": "/abs/path/to/newest/clone",
      "worktrees": ["/abs/path/to/older/clone", "/abs/path/to/newest/clone"],
      "remoteUrl": "https://github.com/owner/name",
      "enabledAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Field semantics:

- **`repoIdentity`** — the key. One entry per identity, so two clones of one remote share a single row.
- **`repoName`** — the display name.
- **`worktreeRoot`** — the *most recently registered* main-worktree path; the one shown in a UI. Never the only place to collect from.
- **`worktrees`** — every main-worktree path ever registered for this identity, **newest last**. Absent on entries written before the field existed; readers fall back to `[worktreeRoot]`. It is kept here rather than in the database because rebuilding a deleted database needs to know where the checkouts are, and that list cannot live only inside the thing being rebuilt.
- **`remoteUrl`** — present only on the remote-derived branch of identity resolution.
- **`enabledAt`** — set once, on first registration, and preserved by every later re-registration.
- **No disable state.** This file records membership, never whether the user has Jolli switched on. That switch is the repository's own `profile.json` (`manuallyDisabled`), and asking it is what "listing" below does. The registry carried a `disabledAt` for one release: stamped by ONE writer (the `disable` command) and cleared by EVERY registration, so it drifted one way — a repository disabled from an IDE never got the stamp, and a background enable or a page open wiped one that had been set, which is how switched-off repositories kept being re-imported. Rows are still **never deleted**, so history stays queryable and re-enabling does not have to re-import.
- **`instanceId`** — the dashboard database's own identity stamp, kept here so that an *absent* database can be classified: a stamp matching the mirror's proves deletion, a mismatch is residue. Its presence alone proves nothing, since this file survives the database independently.

**This file is the source; the database's repository table is the projection of it — never the reverse.** The database is a derived read model that bootstrap, gap recovery, or a user may throw away, and rebuilding it for every repository needs a durable answer to "which repositories are enabled, and where are their checkouts". It is machine-global rather than per-repository for the same reason no single repository's memory-bank folder can own the list of all the others — and because that folder is user-retargetable while this list must not move with it.

That one-way rule covers the **repositories**. The identity stamp beside them runs the other way by design: it is the database's own value, copied out to this file so it survives the database's deletion.

### The lock

Every write is a read-modify-write serialised by a machine-global lock file, **`repo-registry.lock`**, in the same directory. It is **best-effort**: a **5-second** acquisition budget with a **25 ms** poll, and on timeout the section runs **unlocked** rather than dropping the registration. Acquisition failure is logged.

## Behavior

### Deriving an identity

Given a main-worktree root:

1. Ask for the repository's canonical remote. When it yields a value that is **not** a `file:`-scheme URL, that value is both the identity **and** the recorded remote URL.
2. Otherwise — no remote configured (the canonical form falls back to a `file:` URL of the path), or the git call threw (git missing, not a repository) — the identity is `local:` followed by the **first 32 hex characters of the SHA-256 of the forward-slashed root path**, and no remote URL is recorded.

The `file:` fallback is detected and rejected as an identity deliberately: it would embed the absolute worktree path — and the user's home directory — as a primary key echoed into every table. Hashing is what makes the fallback a fixed-width opaque key like the remote-derived one.

**Known limitation, accepted in place:** moving a local-only repository's directory changes its identity. Existence filtering plus set reconciliation converge on that rather than pretending it cannot happen.

Callers that start from an arbitrary working directory rather than a known root must resolve the main-worktree root **first**: hashing a raw working directory produces a *different* identity for a linked worktree, or for any subdirectory passed straight through, than the one registration wrote — and the two then disagree about what is registered.

### Deriving a display name

With a remote URL, take the name derived from it, unless that derivation is empty. Otherwise take the last non-empty segment of the forward-slashed root path (trailing slashes stripped), falling back to the whole root path when even that is empty.

### Reading

Two reads, with opposite failure policies:

- **Forgiving** — returns an empty registry (`version: 1`, no repositories) when the file is unparseable, has no repositories array, or cannot be read, logging a warning. A corrupt registry must not brick every read surface; the file is rebuildable by re-enabling. A **missing** file is not one of those cases and warns nothing: absence is absorbed by the strict read below and never reaches the forgiving one's handler.
- **Strict** — throws on anything it could not read. **Absent is not a failure**: a file that does not exist yet is genuinely empty, and that is the case the forgiving contract was written for.

**Every writer uses the strict read**, and that is load-bearing. A writer's read is the first half of a read-modify-write, so failing open there is not a graceful degradation — it is a delete: one transient permission error, file-handle exhaustion, virus-scanner hold, or truncated file, and the next registration writes back a registry containing only the repository it happens to be handling, dropping every other repository **and** the database identity stamp. The damage is silent and lands where it hurts most — a genuinely deleted database then classifies as a fresh install and the alarm is suppressed, while recovery iterates none of the lost repositories.

The strict read also **preserves the identity stamp explicitly** when rebuilding the returned value, because every rewrite goes through this path and dropping it would erase the deletion detector's witness on the next registration.

### Writing

The whole file is rewritten each time, **temp-then-rename**, with owner-only permissions. Atomicity matters more here than elsewhere: a torn write reads back as corrupt JSON, and the very next writer's read-modify-write would cement that loss.

### Registering a repository

Given any directory inside a repository:

1. Resolve it to the **main** worktree root, so enabling from a linked worktree updates the existing entry rather than minting a second identity for the same repository.
2. Derive the identity and remote URL.
3. Under the lock, **re-read** the registry (a concurrent registrar's write between the git resolution and here must not be lost), then:
   - Take the existing entry's checkout list (or `[worktreeRoot]` when the field is absent, or an empty list when there is no entry), remove this root from it, and append this root at the end — a **union**, never a replacement, because two clones of one remote share the entry and overwriting would leave the other clone's commits uncollected with nothing to show it had been dropped.
   - Rebuild the entry with the derived name, this root as `worktreeRoot`, the unioned checkout list, the remote URL when there is one, and the **existing `enabledAt` if there was one** — otherwise now.
   - Replace the entry for that identity and write.

The entry is **rebuilt rather than merged**, but it records membership only, so a registration carries no opinion about whether the user has Jolli switched on — it cannot re-enable anything. That is what makes it safe on the incidental paths (a background enable, a dashboard page open) that used to undo a disable by running it.

### Extending the checkout list only

A second mutation adds this working directory's main-worktree root to its identity's checkout list and touches **nothing else** — a pure union, where registration rebuilds the row. It returns the existing (or updated) entry, or **null** when the identity is not in the registry at all, since building a full row is registration's job. A checkout already on the list is returned unchanged, with no write at all.

This exists because "the identity is already registered" says nothing about whether *this* checkout is listed, and a checkout the list never learns is structurally invisible to a source enumeration that has to visit every clone. Union-only is still the right shape for a stray hook — it cannot restate a name or reorder the newest checkout — though it is no longer what protects an explicit disable, since nothing in this file can undo one.

### Reading a repository's checkouts

Two readers over the same list, with deliberately different answers:

- **Live checkouts, newest first** — take the checkout list (falling back to `[worktreeRoot]` when absent or empty), reverse it, drop paths that no longer exist. **When that leaves nothing, return `[worktreeRoot]` anyway**: a caller that would otherwise sweep zero checkouts is better off trying the recorded path and failing loudly in git.
- **Is anything still backed by disk** — the same source list, unreversed, asked whether *any* path exists. This is the companion the non-empty fallback makes necessary: a repository whose every path is gone looks identical, through the first reader, to one with a single live checkout.

The registry **used to be append-only in practice**, and the reason was not a missing cleanup pass: every entry point resolved its target from the working directory, so a checkout that no longer exists could never be *named*. Entries for deleted directories, renamed local-only repositories and throwaway fixture checkouts therefore accumulated with no code path able to reach them, kept being shipped to the browser in every page payload, and kept costing every sweep a pass.

**Removal now exists, and it addresses an entry by IDENTITY** — which is the only addressing that can reach a checkout whose directory is gone. Three callers reach it: the picker row's own control, an unattended prune of *disposable* entries, and the diagnostics command's repair.

**The database side of a removal is only partly derived.** Every table carrying a foreign key to the repository row is deleted from a list the schema derives, so a table added later shows up as a visible edit rather than as rows nobody removed. That guarantee is exactly as wide as the foreign keys: a repository-scoped table with **no** foreign key is invisible to the derivation, and nothing then refuses the parent delete — so it fails *silently* rather than loudly. One such table exists today, the per-day statistics cache (a rebuilt cache that deliberately cascades from nothing), and it is deleted **by hand**; any future one has to be added there the same way. Leaving it behind is not a stale cache but wrong numbers: a cached day is invalidated by source rows being *written* and a delete writes nothing, the settled sentinel is stored once per day rather than per repository, and the all-repositories scope emits no repository filter at all — so a forgotten repository's spend keeps counting there, on days that get no further writes to rebuild them. Those rows are deliberately **excluded from the child-rows-deleted count**, which the transport reads as "was there anything to remove"; a derived row must not be able to answer that on its own.

A disable still does not touch this file, and that separation is deliberate: **a disabled repository is still a repository the machine has**, and the switch lives in each checkout's own profile rather than here.

### Listing

"Active" repositories are every entry the user has not switched off, decided from each **clone's own** `profile.json` rather than from anything in this file, over the forgiving read.

The load-bearing details:

- **Every clone, not any clone.** An entry is one repository IDENTITY while the switch is per clone, so an entry counts as switched off only when EVERY recorded checkout is — otherwise disabling one checkout would silently stop collecting the other's memories.
- **The non-migrating reader.** The synchronous reader is used deliberately: its asynchronous counterpart persists what it decides, and asking "should I sweep you?" must not write a profile into someone else's repository.
- **Unreadable means enabled.** A missing or corrupt profile answers "not switched off", so a checkout on an unmounted drive is never mistaken for an opt-out; the live-checkout reader above is what classifies that case.

The importer that consumes this list is handed the **whole** roster instead, not the active subset, because it is also the only writer of the database's own paused column: it skips a switched-off repository's import while still projecting its paused state, and filtering those rows out earlier would leave that column empty forever.

**A further consumer asks the same predicate from outside this file's own surfaces.** The machine-wide session-statistics upload builds its set of *excluded* identities from it — deliberately the same per-clone question, so "which repositories do I import", "which repositories does the database call paused" and "which repositories do I withhold from the wire" cannot be three predicates that disagree. It too asks every recorded checkout, for the same reason: a row is one repository identity while the switch is per clone. None of that changes what this file holds — **the registry still records no disable state**, and that consumer reads the profiles rather than this file for exactly the reason listing does.

### The database identity stamp

Stamping is a lock-guarded read-modify-write that **no-ops when the stored value already equals the new one**. Reading it goes through the forgiving read and answers `null` on a registry that predates the field.

### The ways a repository becomes known

These, plus one caller that re-registers something already known:

1. **The launcher command.** Before doing anything else it registers the current directory, ignoring the failure when the directory is not a repository — outside a repository the dashboard still opens with whatever is already registered. **The guided first-run setup arrives here**, not at the import path below.
2. **The enable command**, directly, on the directory being enabled.
3. **The import-only entry point**, which registers the given directory (again tolerating a non-repository) and then runs the history import. Its one caller is the enable command, and only on an interactive run that did not opt out — so an interactive enable registers twice, harmlessly, since registration is idempotent apart from re-stamping the checkout list.
4. **The HTTP enable route**, which resolves the submitted path to a repository root, installs, then registers. It is routed and token-gated but has **no caller in the shipped page** — the folder-browser add flow that posted to it was deleted — so in practice this path is reachable only by a token-bearing local caller.
5. **The producer write path** (the hooks and the editor tick), which registers as a *side effect* of resolving an identity. This is what makes the dashboard see repositories that were enabled before the registry existed; without it the list would only ever grow on a fresh enable, leaving every already-enabled repository invisible while its hooks were actively writing to the same database.

The **HTTP resume route** also calls full registration, but it cannot introduce a repository: it refuses an identity the registry does not already hold. It is there purely for the side effect described above — rebuilding the entry is what clears the disable stamp.

The last of the five is deliberately narrower than the others:

- It **only fills a gap**. When the identity is already known it never re-registers: a stray hook has no business restating a display name or reordering the newest checkout. When the identity is known but *this* checkout is not in its list, it uses the extension mutation instead.
- Its per-process memo of directory → identity is populated **only after registration has settled**. Caching the identity first would short-circuit every later call in the process, so a registration that failed on a transient error would never be retried — permanently, in a long-lived editor host. The identity resolution is the cheap half; the registration is the part worth another attempt.
- A failed registration is a debug note, not an error: the database write that follows still works, because the writer seeds a placeholder repository row from the identity alone.

### Where the table can get ahead of the file

The projection direction is file → table, with one exception: the database writer will **insert a placeholder repository row** for an identity it has never seen, using the identity as the display name, an **empty worktree path**, and the epoch as the enabled instant. It is not a special case in one place — it is a shared step every projection that needs a repository row runs first, because a foreign key would otherwise fail the whole projection for a hook that wrote before its enable was projected. So data is never lost for want of a registry entry, and only the multi-repository rebuild story degrades. Downstream readers must treat an empty worktree path as "no path known" and skip anything that would run a subprocess in it.

Registry state reaches the table two ways: the full import reads the active list and projects each entry, and the HTTP mutation routes project the single entry they just changed (gated on the schema already matching that build). Until a registry change is projected it is invisible in both directions — an enabled repository with no row has no data and every gated page redirects, while a disabled repository whose row is not yet stamped keeps counting in every total.

### The pre-registration folder probe

Answers "what would picking this folder mean" without committing to anything — no registration, no hook installation, no model call.

**Nothing reaches it from the browser.** It was written for a folder-browser add flow on the dashboard's Repositories page; that flow was deleted along with the directory-listing endpoint it walked (which now answers not-found) when the settings folder control became a validated text field. The probe's own route survives, still token-gated, and so does the enable action it fed — but the shipped page asks neither, and there is no user interface anywhere behind which "before it is added" happens. Read every rule below as the behaviour a token-bearing local caller gets, not as something a reader can trigger.

1. If **`<path>/.git` does not exist**, answer `{ isGitRepo: false, alreadyAdded: false }` and stop. (This is an existence check, so a linked worktree — where that entry is a file — passes.)
2. Derive the identity from the **path as given**, and read the active repository list; `alreadyAdded` is whether any active entry shares that identity.
3. Concurrently read the current branch (any failure → omitted) and the commit/missing-summary counts (any failure → both zero).
4. Answer:

```json
{
  "isGitRepo": true,
  "name": "…",
  "remote": "https://…",
  "branch": "…",
  "commits": 1234,
  "withoutMemoryYet": 56,
  "alreadyAdded": false
}
```

`remote` is omitted for a repository with no usable remote — the raw `file:`-scheme form is withheld here for the same reason it is rejected as an identity, so a local path never becomes a display value.

**`withoutMemoryYet` is deliberately not "commits with an AI session that could be summarized."** Answering that needs a transcript attribution scan, far too expensive to run for every folder a user hovers over. The cheaper, honest question — commits that have no memory yet — is what the backfill count actually bounds.

### Unreachable at HEAD

Three functions form a complete settings-payload path that **nothing in production reaches**: a configuration read that would report the summarizer provider (mapping the stored provider to one of `local` / `apikey` / `account`, with anything unrecognized *and* anything unset alike becoming `none`), which local agent tools are present on this machine, and whether an API key and a sign-in key are on file; a per-repository hook probe that would report, for each entry, whether the git hook, the Claude agent hook and the Gemini agent hook are installed and whether the repository's own MCP configuration carries this product's server entry; and the assembler that would combine the two into a settings model. The settings payload the shipped page actually receives is built by a different, configuration-only path.

These are described here only because they read registry-adjacent state; **no behavior of the running product depends on them.**

## State Transitions

### One registry entry

| From | Event | To |
| --- | --- | --- |
| absent | registration from any of the paths enumerated above | present, `enabledAt` = now, checkout list = `[this root]` |
| present, enabled | registration from another checkout of the same identity | same entry, `worktreeRoot` = this root, checkout list unioned (this root last), `enabledAt` preserved |
| present | disable | **unchanged** — the switch is written to the repository's own profile, never here |
| present | registration (explicit enable / resume) | entry rebuilt; membership only, so nothing about the switch changes |
| present | producer write path observes a switched-off repository | **unchanged** — never resurrected, and listing keeps excluding it |
| present | this checkout missing from the list, producer write path | checkout appended; nothing else touched |
| present | every recorded path deleted from disk | **still present** unless something removes it by identity — live-checkout reads answer "none alive" while the newest-first reader still yields the recorded path. The picker marks such a row rather than hiding it, and offers to forget it precisely because it can now say the entry is dead |

### The file as a whole

| From | Event | To |
| --- | --- | --- |
| absent | any read | reads as empty (both policies) |
| absent | any write | created with owner-only permissions |
| unparseable | forgiving read | empty registry + warning |
| unparseable | strict read (every writer) | **throws** — the write is abandoned rather than rewriting a one-entry file |
| present | identity stamp written | stamp added or replaced; no-op when already equal |

## Notable Behavior

- **The registry is deliberately outside the database, and for repositories the direction is one-way.** The table is a projection of this file; deleting the database must stay recoverable, so the list of "which repositories, and where are their checkouts" cannot live only inside the thing being rebuilt. The identity stamp is the deliberate exception, flowing the other way for exactly the same reason. (Notable; load-bearing.)
- **Writers read strictly and readers read forgivingly, and swapping them would be a silent data-loss bug.** A failed read inside a read-modify-write is a delete of every other repository plus the identity stamp. (Notable.)
- **A registration clears a disable, because the entry is rebuilt rather than merged.** That is right for an explicit enable and wrong for a hook, which is exactly why the hook path never calls it for a known identity. (Notable.)
- **The producer path memoises the identity only after registration settles**, so a transient write failure is retried on the next call instead of being locked in for the life of a long-running host. (Surprising; the obvious ordering is the broken one.)
- **The `file:`-scheme canonical remote is detected and rejected as an identity.** Accepting it would make the user's absolute path — home directory included — a primary key echoed into every table, and a display value in the probe. (Notable.)
- **The probe hashes the path it was handed, while registration hashes the resolved main-worktree root.** For a repository with **no usable remote**, probing a linked worktree therefore produces a different identity than the one registration wrote, so `alreadyAdded` reads **false** for a repository that is in fact registered. Remote-backed repositories are unaffected, since their identity does not depend on the path. (Surprising; a real divergence at HEAD — though no user can currently see it, since nothing reaches the probe from the browser.)
- **The probe and the HTTP enable route have no caller in the shipped page.** Both existed for one folder-browser add flow, deleted with the directory-listing endpoint it walked. Both still route and still act for a token-bearing local caller; the "before it is added" framing describes an interface that no longer exists, and re-adding one means building a front end against endpoints that are already there. (Unreachable from the shipped page; live over the wire.)
- **The live-checkout reader never returns an empty list**, so "every checkout is gone" and "one checkout, alive" are indistinguishable through it — which is precisely why the second, plain-existence reader exists. Picking the wrong one makes a sweep act on a path that is not there. (Notable.)
- **Removal exists and is addressed by identity, never by working directory.** That is the whole reason dead entries used to be unreachable rather than merely un-pruned: resolving a target from the working directory cannot name a checkout that is gone.
- **Two orderings inside a removal are load-bearing.** Database rows are deleted **before** the registry entry: the other way round, a registry write that lands while the row deletion fails leaves a row the page still renders and that no later sweep can ever see, because the registry no longer lists it and nothing will retry. Failing in the correct order costs at most one un-swept pass — the entry is still listed, and the next prune tries again. And **unprojected events must go with the rows**, because a placeholder row is inserted from an event's identity alone, so a single pending or revivable event resurrects the repository on the next drain and deleting the rows without them is a no-op with a delay.
- **A repository-scoped database table with no foreign key has to be named by hand in a removal.** The derived child-table list is exactly as wide as the foreign keys, and nothing refuses the parent delete for a table outside it, so the omission fails silently. There is one — the per-day statistics cache — and leaving its rows behind is wrong numbers rather than a stale cache, because a delete leaves no write stamp to invalidate a cached day and the all-repositories scope filters by nothing. It is also kept out of the child-rows-deleted count on purpose, so a derived row cannot claim on its own that there was something to remove. (Notable; a new table without a foreign key is how this breaks next.)
- **The unattended prune only removes a *disposable* entry, and the predicate is deliberately narrow.** Every path the entry claims must lie under a temporary root; unless the identity is a local-only one, every claimed path must additionally look like a fixture path; and **no claimed path may still exist on disk**. The claimed set is de-duplicated first, because the path reader falls back to the single recorded root for an entry with no checkout list and the union would otherwise repeat it. An ordinary repository the user merely deleted is therefore never swept automatically — it is marked in the picker and removed only when the user says so.
- **A disable is still not recorded here.** It lives in the checkout's own profile, so a paused repository stays listed and keeps counting in the aggregates. (Notable.)
- **The lock is best-effort: on a 5-second timeout the read-modify-write proceeds unlocked**, trading a lost-update window for never dropping a registration outright. (Notable.)
- **The database can hold a repository row the registry has never heard of** — a placeholder with the identity as its name, an empty worktree path and an epoch timestamp, inserted by the producer write path so data is never lost for want of a registry entry. The empty path is a value downstream readers must special-case. (Surprising.)
- **A configuration/hook-status settings path exists in full and is reached by nothing.** The shipped settings payload comes from a different, configuration-only assembly. (Unreachable at HEAD.)

## Shared Behavior

- Canonical remote normalization — transport folding, port handling, host case-folding, and the no-remote `file:` fallback this module detects — is the Canonical Repo URL and Name Derivation topic; the repository-name derivation from a URL is shared with it.
- The dashboard database, its repository table, the placeholder-row insert, the bootstrap/recovery import that reads the active list, and the single-entry projection are owned by the dashboard database and import topics. The per-day statistics cache a removal must delete by hand — what a cached day holds and how one is invalidated — is its own neighbouring topic; the machine-wide session-statistics upload that reuses the disabled-set predicate is another.
- The HTTP routes that expose the probe and drive registration, and the schema-version gate on their projection, are the Local Dashboard HTTP Server topic.
- The install/uninstall functions that accompany a registration, and the per-checkout user opt-out flag they set and clear, are the hook-installation and repository-profile topics.
- The commit total and missing-summary count the probe reports are produced by the backfill engine.
- The cutover fence lookup that walks this file's checkout list, newest-first, is the cutover topic.
