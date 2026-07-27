# 246 — Pin Store

## Topic Statement

A per-project store of the items the user has explicitly *pinned* to the top of the Current Branch view, grouped by repository-and-branch, where each pin is a lightweight reference to an existing artifact (a conversation, plan, note, committed memory, or integration reference) that already lives elsewhere in the system — the pin carries only enough identity to reopen that artifact and keep it surfaced.

## Scope

**In scope:**

- The on-disk location of the file relative to a project root, and its grouping key.
- The persisted shape: a version stamp plus a map from group-key to an array of pin entries.
- The five pin kinds and the entry shape for each, including the optional badge field carried for any kind and the two fields carried only for the conversation kind.
- The group-key format (`<repoName>::<branchName>`) and why a pin is scoped to a repo+branch pair.
- The read API: whole-file read with version gate and per-field corruption tolerance, and the per-group list read.
- The write API: an add that is an *upsert* keyed by (kind, id), and a remove that filters by (kind, id).
- The atomic write protocol and its Windows permission-error fallback.
- The error-propagation contract: a failed write **rejects** to the caller (this store does not swallow write failures).
- The in-process per-project serialization chain that prevents concurrent writers from losing an update, and its non-wedging recovery contract.
- The consumer contract: **all three host surfaces share this one store and this one file** — the VS Code sidebar reads and writes it directly, and the IntelliJ pinned panel reads and writes it through the IDE bridge's `pins-read` / `pins-add` / `pins-remove` operations. There is no operator-facing command, but the bridge does surface it.
- The bridge adapter's mapping rules: plural↔singular kind names, the `key`↔`id` field rename, the group resolved server-side from the working directory, and the badge-to-source derivation for conversation pins.

**Out of scope (boundaries — referenced, not duplicated):**

- The sidebar messages that carry pin / unpin gestures and push the pinned list back to the webview — owned by the sidebar message-protocol topic (spec 101).
- The commit-exclusion selection store, whose file/read/write/atomic protocol this store mirrors but whose consumer contract is entirely separate (spec 188).
- The identity schemes the pin's `id` reuses (conversation composite key, plan slug, note id, commit hash, reference map key) — each is owned by the artifact it names.
- The IntelliJ pinned panel's own rendering, hover actions, and open-on-click behavior (spec 220) — that panel is backed by *this* store and this file, but its presentation is its own.
- The rendering of a pinned row (badge, title, hover actions) — a webview concern.

## Data Contracts

### File location

A single JSON file lives at a fixed relative path under the project root, inside the project-local jollimemory state directory (the same directory that holds session metadata, cursors, the queue, and the commit-exclusion file). The file is per-project: two project roots have two independent files and two independent serialization chains. It is gitignored by convention.

### Persisted shape

The file is a JSON object with two fields:

- A version stamp: a fixed integer constant. The current (and only recognized) value is `1`.
- A `groups` map: an object whose keys are group-keys and whose values are arrays of pin entries.

The file is pretty-printed JSON. (This store indents with spaces, unlike the tab-indented commit-exclusion file — a cosmetic divergence with no behavioral effect.)

### Group key

A group-key is the string `<repoName>::<branchName>`. A pin belongs to exactly one repo+branch pair: switching branches (or viewing a different repo) surfaces a different group. The double-colon separator is not disambiguated against colons inside a repo or branch name — the key is used only as an opaque map key, never re-split.

### Pin entry shape

Each entry carries:

- `kind` — one of `conversation`, `plan`, `note`, `memory`, `reference`.
- `id` — the stable identifier of the pinned artifact. Its meaning depends on `kind`: the conversation composite key, the plan slug, the note id, the committed-memory commit hash, or the reference map key. Opaque to this store — never interpreted, normalized, or validated against any registry.
- `title` — a display label captured at pin time.
- `pinnedAt` — an epoch-millisecond timestamp (drives newest-first ordering in the consumer).
- `badge` — optional. A compact display string supplied by a UI host. Unlike `source` / `transcriptPath`, it is persisted for **any** kind, not just conversations.
- `source` — **conversation kind only**: the transcript provider id, so the pin can reopen the right transcript reader.
- `transcriptPath` — **conversation kind only**: the path to the transcript file, so the pin can reopen it.

`source` / `transcriptPath` are absent on every other kind (and are persisted only when non-empty). `badge` is likewise persisted only when supplied.

### Bridge adapter contract (IDE hosts)

An IDE host does not open this file itself; it issues three bridge operations. The adapter layer differs from the persisted shape in four ways, all of which are part of the contract:

- **Kind names are plural at the host boundary, singular on disk.** A host sends `conversations` / `plans` / `notes` / `memories` / `references`; the bridge normalizes each to its singular form before touching the store, and rejects an unrecognized kind with an error naming it. (A host that sends the already-singular form is accepted unchanged.) On read, the host's adapter maps the singular kind back to plural for its own row model.
- **The identity field is named `key` at the host boundary and `id` on disk.**
- **The group is resolved server-side.** The host sends only a working directory; the repository name and current branch are derived there, so the host never constructs the group key and can never write into the wrong group because of a stale cached branch name.
- **`source` is derived from `badge` for conversation pins.** On add, an explicit `source` wins; when absent and the kind is `conversation`, the supplied `badge` is stored as `source` too. This lets a host that only carries a source-derived badge keep populating the transcript-provider field without extra plumbing.
- **A `pinnedAt` is stamped by the bridge at add time.** The host does not supply it.

### Version gate and defensive read coercion

A read is tolerant of a damaged file, degrading to *fully empty* (no groups) in every failure mode:

- The file is missing → empty, no warning.
- The file is unreadable for any other reason → empty, with a warning.
- The content is not valid JSON, or parses to a non-object, or its `groups` field is missing / not an object / null → empty. (A warning is emitted for the unreadable/parse failures; a structurally-wrong-but-parseable object degrades quietly to empty.)
- The version stamp is anything other than `1` → empty, with a warning naming the unexpected version; the file is left untouched on disk.

When the version and top-level shape are valid, each group is coerced independently: a group whose value is not an array becomes an empty array; within a valid array, only *shape-valid* entries survive. An element is dropped when it is not an object, is missing any of the required `kind` / `id` / `title` / `pinnedAt` fields, has a `kind` outside the five recognized kinds, **or carries a `badge`, `source`, or `transcriptPath` that is present but not a string**. That last clause is a tightening: a wrong-typed optional field no longer rides along — the whole entry is dropped on read, and because add and remove rewrite the whole file from the coerced snapshot, the offending entry is **erased from disk** by the next add or remove in that project.

A partially-corrupt group therefore keeps its good entries rather than being discarded wholesale, and a corrupt group never propagates a non-array value that would later break add/remove. This per-field, per-group tolerance mirrors the commit-exclusion store (spec 188).

## Behavior

### List the pins for a group

Read the whole file (applying the version gate and coercion above) and return the array for the requested `<repo>::<branch>` group, or an empty array when the group is absent. This read is *not* serialized against writes — it reflects whatever is currently on disk.

### Add a pin (upsert)

Runs inside the per-project serialization chain:

1. Read the whole file (empty on any failure mode above).
2. In the target group, drop any existing entry with the *same* (kind, id) pair, then append the new entry.
3. Write the whole file atomically.

Because the same-(kind, id) entry is removed first, adding is an **upsert**: re-pinning an already-pinned artifact replaces the prior entry (for example, to refresh its `title`) rather than creating a duplicate. Ordering within the group is not otherwise managed by the store — the appended entry lands last, and newest-first presentation is the consumer's concern via `pinnedAt`.

### Remove a pin

Runs inside the per-project serialization chain:

1. Read the whole file.
2. If the target group does not exist, return without writing (a no-op).
3. Otherwise filter out every entry matching the (kind, id) pair and write the whole file atomically. Removing a (kind, id) that is not present rewrites the group unchanged — still a safe no-op result.

### Atomic write protocol

The whole file is serialized and written via a sibling temp file whose name is unique per call, then renamed over the destination. If the rename fails with a Windows-style permission error (the destination is held open by another process — antivirus, a file watcher, another reader), the write falls back to a direct overwrite of the destination and best-effort removal of the temp file. Any other rename error is rethrown. The state directory is created recursively first if missing.

**Write failures reject.** Unlike the commit-exclusion store — which swallows a secondary cleanup error while still propagating the primary — a failed pin write propagates its error to the caller. The consumer treats a rejected write as "the pin gesture did nothing" and logs it; it never optimistically renders a pin that did not persist.

### Serialization chain

Add and remove share an unlocked read-modify-write cycle, and the consumer dispatches them fire-and-forget in response to rapid pin/unpin clicks. For each project root the store keeps a chain of pending operations:

- Operations on the same project root run strictly serially; two concurrent calls can never both observe the same pre-state and lose one update.
- Operations on different project roots run independently.
- The chain's bookkeeping is double-caught (both success and failure fold to a resolved advance), so a failed operation cannot wedge the chain — the next operation still runs, starting from a fresh disk read. The failure still propagates to the caller that submitted it.

## State Transitions

The file:

- **Absent** — read returns empty; the first add/remove that actually writes creates it at version 1.
- **Present at version 1** — reads and writes round-trip cleanly.
- **Present at an unrecognized version, malformed, or structurally wrong** — read returns empty (with a warning for the parse/version cases) and leaves the file untouched; the next *write* overwrites it with a version-1 payload computed from "empty state plus this change".

An individual pin:

- **Absent** — a future add inserts it; a future remove is a no-op.
- **Present** — persists across editor restarts and branch switches back to its group; a re-add for the same (kind, id) replaces it in place; a remove deletes it.

## Notable Behavior

- **Pins are scoped to repo+branch, not global.** The same conversation can be pinned on two branches independently; each lives in its own group. Reads and writes always resolve the group from the *live* current branch/repo (the consumer resolves branch from the HEAD watcher, which can be fresher than a lagging cached branch name), so a pin written just after a checkout lands in — and is read back from — the correct group.
- **Add is an upsert, not an append.** The same-(kind, id) dedup means the store never accumulates duplicate pins for one artifact and a re-pin can update the stored title. This is the store's only "update" path — there is no separate edit API.
- **The store never validates ids against reality.** A pin whose underlying artifact no longer exists round-trips cleanly; resolving (or degrading) a stale pin is the consumer's job at render/open time.
- **Corruption tolerance is per-group and per-field**, matching spec 188, so a hand-edit or partial write that damages one group or one entry does not wipe the user's other pins.
- **Write failures are surfaced, not swallowed** — the deliberate divergence from the commit-exclusion store's swallow-secondary pattern. Combined with the consumer rendering only from the pushed list (never optimistically), this makes a failed pin visibly do nothing rather than appear to succeed and vanish on reload.
- **All three surfaces share this one store and this one file.** There is no per-host pin store and no per-host format. The VS Code sidebar calls the store directly; the IntelliJ pinned panel calls it through the IDE bridge. A pin made in one and a pin made in the other land in the same group of the same file and are visible to both.
- **There is no operator-facing command, but the store is bridged.** No user-invocable command adds, lists, or removes pins; the IDE bridge's three pin operations are the only non-sidebar entry point.
- **A wrong-typed optional field is destructive on the next write.** The read filter drops such an entry, and because writes rewrite the whole file from the coerced snapshot, the entry is gone from disk the next time anything is pinned or unpinned in that project. Nothing warns about it.

## Shared Behavior

- **Commit-exclusion selection store (spec 188)** — the sibling per-project store whose file/read/version-gate/atomic/serialization-chain protocol this store mirrors, and from which it deliberately diverges on write-error propagation.
- **Sidebar message protocol (spec 101)** — carries the `branch:pin` / `branch:unpin` gestures into this store and the `branch:pinsData` list back out; also defines *when* the list is (re)pushed.
- **IntelliJ pinned panel (spec 220)** — backed by exactly this store and this file, reached through the IDE bridge's three pin operations. Its adapter maps singular kinds to plural, `id` to `key`, derives its display badge as `badge` falling back to `source`, and sorts newest-first client-side. Its rendering is its own; the persistence is shared.
- **Artifact identity schemes** — the conversation composite key, plan slug, note id, commit hash, and reference map key that a pin's `id` reuses verbatim, each owned by its artifact's topic.
