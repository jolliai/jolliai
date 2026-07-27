# 169. Legacy DB-to-Git First-Bind Migration

## Topic Statement

Perform the one-shot import of a user's personal-space content from the backend's legacy database storage into the user's newly minted git-backed Memory Bank vault, push it as the first commit, then notify the backend to flip the space's backing from database to git.

## Scope

**In scope:**

- Detecting when the round must run the legacy import based on the personal-space binding flag carried on freshly minted credentials.
- Fetching the legacy content payload from the backend.
- Sanitizing each legacy document's vault-relative path and falling back to a slug-derived name when the path is missing.
- Skipping folder rows because folders are implicit in the file paths.
- Rejecting paths that fail the vault allow-list, with a warning, without aborting the round.
- Idempotent on-disk write: skipping a target whose existing content already matches, overwriting when content differs, propagating any non-missing read error.
- Emitting a single migration commit whose summary records the number of imported items.
- Pushing the migration commit through the normal push path with its own at-most-one credential recovery budget.
- Sending the post-push notification that informs the backend the migration HEAD is on the remote so the per-space write lock can be released early.
- Calling the completion endpoint that asks the backend to flip the binding from database to git, including the deferred path when no commit yet exists on the remote default branch.
- The deferred-completion retry that runs after the round's steady-state push lands a first commit on the remote.
- Idempotency on retry: the import endpoint, the completion endpoint, and the local writer all return cleanly on re-entry until the backend has flipped the binding.
- The "already-migrated race" branch where a peer device finished the flip first.
- The "all docs filtered out" branch where the binding still gets flipped to prevent the round from repeating the import every cycle.
- Lock release coordination: the round-level write lock release is deferred whenever completion is deferred, so the next round can complete against backend idempotency rather than re-minting through the held lock.
- Resetting the round's credential-recovery budget at the migration phase boundary so a transient auth failure during migration does not strangle the steady-state push that follows.
- Classification of each failure point as a terminal migration-failed outcome or as a swallowed log-only event.

**Out of scope (boundaries — sent or received but not re-specified here):**

- The credential mint endpoint that returns the binding flag and the write-lock owner token. Migration consumes the parsed credentials; the mint contract belongs to the sync backend client topic.
- The transport-level shape, retry, classification, and auth handling of backend calls. Migration treats each call as a single typed promise.
- The on-disk vault allow-list rules (which paths and which extensions count as owned). Migration consumes the boolean predicate.
- The push step, its retry shapes, its at-most-one credential-recovery semantics, and the post-push backend notification call. Migration invokes the same push step as the steady-state path and learns only whether bytes were transmitted.
- The single-commit message construction. Migration supplies the operation tag and an item-count summary; the message builder belongs to the commit-message topic.
- The vault-bootstrap step that ensures a baseline `.gitignore` exists. Migration invokes it once before writing legacy files and consumes only its completion.
- The staging-with-classifier step that resolves dirty paths to staged content. Migration invokes it with the same options as the steady-state path.
- The reconciliation round's overall orchestration (lock acquisition, identity guard, branch recovery, pull-rebase, conflict pyramid, idle short-circuit, error mapping to UI states). Migration is one sub-flow of that round.
- The bootstrap-merge sub-flow that runs when the local vault has user-authored content predating the first remote commit. Migration is a different sub-flow keyed off a different credential flag, though both can interact via the deferred-completion path.
- The persisted self-lock evidence used to attribute future "vault busy" responses. Migration only clears that evidence on its own release paths.

## Data Contracts

### Credentials flag that triggers migration

A freshly minted credentials envelope carries a boolean indicating whether the personal space is already bound to a git vault. The migration sub-flow runs exactly when this flag is false. The same envelope also carries the per-space write-lock owner token that any release-signalling call must echo back.

### Legacy content fetch response

The fetch returns an envelope with:

- A boolean stating whether the personal space is already migrated to git-backed storage.
- An identifier and a slug for the personal space (informational only at this layer).
- An ordered collection of legacy document rows.

Each legacy document row carries:

- A numeric identifier and an opaque resource name.
- A short slug.
- A vault-relative path string that already includes the filename and extension when well-formed.
- A document-type discriminator ("doc" vs "folder" — only the file value is processed).
- An optional parent identifier (ignored at this layer; tree structure is reconstructed from paths).
- The full document content as a string.
- A content-type string (used only to derive a fallback extension when the path is missing).
- A sort-order integer and ISO8601 created/updated timestamps (carried through, not consulted by the writer).

The writer never inspects soft-delete fields; the backend pre-filters those out.

### Migration completion request

The request to the completion endpoint carries:

- The commit identifier the backend should verify on the remote default branch as proof the migration push landed.
- The lock-owner token previously returned by the mint.

The response indicates whether the personal space is already in the git-bound state. A second call against an already-flipped space returns success with the already-migrated flag set, so the call is safe to repeat.

### Migration writer output

After applying the response on disk the writer reports a single integer: the number of files actually written this invocation (zero if the response was already-migrated, the docs list was empty, every doc was a folder, every path was rejected by the allow-list, or every target already had byte-equal content).

### Migration sub-flow result

The sub-flow returns either:

- A success outcome with a "completion deferred" boolean, or
- A failure outcome with a classified error code, a human-readable message, and a "pushed" boolean indicating whether the migration commit reached the remote before the failure.

A "completion deferred" success means the completion call could not be made yet because no commit exists on the remote default branch — the deferred retry will run later in the same round, after the steady-state push, and the next round will retry if that also fails.

## Behavior

The migration sub-flow runs once per round, just after HEAD has been positioned on the backend-declared default branch and just before the round's auto-reconcile and pull-rebase steps. It runs only when the credentials envelope reports the personal space is not yet bound to a git vault.

### B1. Fetch the legacy payload

The sub-flow calls the legacy-content fetch endpoint. The call returns the whole payload in one round trip — there is no client-driven pagination, and the writer never asks for "another page" because the backend is the authority for the document list size.

If the call throws (network, auth rejection, server error, malformed envelope at the boundary), the sub-flow returns a terminal migration-failed outcome carrying the boundary's error message. The round transitions to offline. No on-disk state has been touched.

### B2. Already-migrated or empty payload short-circuit

If the response's already-migrated flag is true, or its docs collection is empty, the sub-flow skips the entire write-and-push leg and proceeds directly to attempting the completion call (see B6). Even though the on-disk leg is skipped, the completion call still runs because:

- A peer device may have raced ahead and already flipped the binding — confirming it is cheap and idempotent.
- The completion call is the canonical client-side release path for the per-space write lock; skipping it would leave the lock held until the backend's TTL expires.

### B3. Bootstrap the vault's baseline ignore configuration

Before any file is written, the sub-flow invokes the vault-bootstrap step that ensures a baseline ignore configuration is present in the working tree. This ordering matters because the subsequent staging step picks up the freshly written legacy files in the same commit as the bootstrap-introduced configuration, instead of producing two commits.

### B4. Resolve each document's on-disk path and write it

For each legacy document row, in the order the response delivered them:

1. **Skip folder rows.** Rows whose document-type discriminator equals "folder" are skipped entirely. Folders are implicit — parent directories are created on demand when a file row needs them.

2. **Compute the vault-relative target path.** The mapper consumes the document's path string:
   - Split on the forward-slash separator.
   - For each segment, trim surrounding whitespace.
   - Drop any segment that is empty after trimming, equal to a single dot, or equal to two dots. The drop is per-segment; a single composite path containing a traversal segment is sanitized in place, not rejected, so `a/../b/./c.md` becomes `a/b/c.md` and `//a///b//file.md` becomes `a/b/file.md`.
   - Re-join the surviving segments with forward slashes.
   - If the result is non-empty, that is the target path. Notable: the path is used verbatim including the filename and extension that the backend already supplied; no synthetic `<slug>.md` suffix is appended.
   - If the result is empty (malformed row — the backend gave no usable path), fall back to `<slug><extension>` where the extension is `.md` when the content-type string (lowercased) contains the substring "markdown", `.json` when it contains the substring "json", and `.md` for everything else (including the empty string). The slug itself comes through unsanitized; if the slug is empty the literal string `doc` is substituted, producing `doc.md` for that row. The slug fallback never drops a malformed document silently — the doc is preserved at a best-effort path even when its declared filename was missing.

3. **Allow-list filter the target path.** Pass the computed target path through the vault allow-list predicate, parameterized by the round-level "sync transcripts" boolean. If the predicate rejects the path, log a warning that includes the rejected path plus the row's id and move on to the next row. The row is dropped silently from the migration; the round is **not** aborted.

4. **Compute the absolute target path.** Join the configured Memory Bank root with the relative target. The Memory Bank root is the user's chosen vault directory for this round; the writer does not invent or move that root, and there is no separate `legacy/` subdirectory beneath it.

5. **Idempotent skip when content matches.** Attempt to read the existing file at the absolute target. If the read succeeds and the existing bytes are byte-equal to the row's content string, skip the write entirely (this is the re-entry path: a previous round wrote the same file). If the read fails with a "no such file" error, fall through to write. Any other read error — permission denied, the path is a directory, an I/O error — propagates as a thrown exception; the sub-flow catches it at the outer level and returns a terminal migration-failed outcome. Notable: this propagation is intentional; an earlier revision swallowed all read errors and silently clobbered files the migration could not actually read.

6. **Create the parent directory.** Recursively create the directory containing the absolute target so intermediate directories implied by the row's path are materialized.

7. **Write the content.** Write the row's content string to the absolute target, overwriting any existing differing content. Increment the per-invocation write counter.

After every row has been processed, log the count of files written versus the count of rows in the response. The writer returns the count of files written.

If any single row's write throws an unexpected error (for example, a non-missing read error or a write error), the writer's outer catch returns a terminal migration-failed outcome to the sub-flow. The round transitions to offline; partial on-disk progress remains where it landed — the next round's re-entry will re-skip whatever already matches and re-write the rest, which is the idempotency property the writer is designed for.

### B5. Stage, commit, and push the migration content

This step runs only when at least one file was written in B4. When no file was written (every row was a folder row, every path was filtered, or every target already had byte-equal content), the sub-flow skips straight to B6. The binding flip still happens — the round must not keep re-fetching the same dead legacy content forever.

When at least one file was written:

1. **Compose the commit summary.** The summary records the number of files written followed by the literal phrase identifying them as items from the legacy space. The commit-message builder is invoked with the operation tag "migrate"; the actual message construction is handled by the commit-message topic.

2. **Stage the vault's tracked content.** Invoke the round's staging-with-classifier step with the round's "sync transcripts" flag. The classifier enforces that every staged path is on the vault's owned-path catalogue; any path that landed outside that catalogue surfaces on the round's canary bucket without aborting the commit.

3. **Commit** the staged tree with the composed message and the round's commit author identity.

4. **Push** the resulting commit through the round's push step. The push step has its own step-level retry plus an at-most-one credential-recovery budget (re-mint + retry on auth-rejection / repo-not-found). If push fails permanently, the sub-flow returns a terminal failure carrying the push step's classified error code; the "pushed" flag in the failure outcome is false because the bytes did not reach the remote.

5. **Send the post-push backend notification** if and only if the push transmitted bytes (the push step reports whether the remote actually advanced). The notification carries:
   - The current HEAD commit identifier, re-read from the working tree after push (a non-fast-forward retry inside the push step may have rewritten HEAD).
   - The default branch name from the credentials envelope.
   - The lock-owner token from the credentials envelope.

   On notification success: clear the locally persisted self-lock evidence, and record on the round's lock holder that the lock has already been released by the backend so the round's teardown does not attempt to release it a second time.

   On notification failure: swallow the error and log it. The next steady-state push's notification, the eventual completion call, or the backend's TTL will release the lock. The migration commit is already on the remote — losing this notification does not lose data.

   Notable: this notification fires from inside the migration sub-flow because the steady-state push that follows is almost always idempotent ("nothing to push") since nothing has changed on disk between the migration commit and the post-migration moment. Without the migration-time notification, the backend would not learn about the migration HEAD via a notification at all, and the per-space write lock would wait for its TTL — peers would see "vault busy" responses for the full TTL window.

### B6. Complete the migration on the backend

Whether or not B5 ran, the sub-flow attempts the completion call.

1. **Probe whether the completion is safe to attempt.**
   - Check whether HEAD exists locally (an unborn HEAD means no first commit has been made yet — the truly-empty-remote case).
   - If HEAD exists, check whether HEAD is an ancestor of the local view of the remote default branch (the bootstrap-merge case: the round has just committed a fresh-local vault but the steady-state push has not yet uploaded it, so the backend cannot find the commit).

   If either check fails (HEAD unborn, or HEAD born but not yet reachable from `origin/<defaultBranch>`), the completion call **must not** be attempted. The backend would reject an unreachable commit identifier with a fatal error, deadlocking the round (the push step that would upload the commit is gated behind migration completion). Instead:
   - Log that completion is deferred.
   - Clear the lock-release-in-teardown flag on the round's lock holder so the round's teardown does **not** call the lock-release endpoint. The chosen release path for the deferred case is the next round's completion call.
   - Set the sticky "deferred completion" flag on the lock holder. This flag survives a recovery re-mint inside the same round (a re-mint would otherwise re-arm the release-in-teardown flag and undo this clear).
   - Return a success outcome with the "completion deferred" boolean set to true.

2. **Read the commit identifier from the working tree's HEAD.** When the safety probe passed, the current HEAD is the migration HEAD (when B5 ran) or whatever HEAD the clone resolved to (when B5 was skipped because of the already-migrated-or-empty race).

3. **Call the completion endpoint** with the commit identifier and the lock-owner token. The backend verifies that the commit is reachable on the remote default branch, that the lock-owner token still holds the per-space write lock, and on success flips the binding from database to git and releases the write lock.

4. **Process the response.** On success:
   - Clear the locally persisted self-lock evidence.
   - Clear the lock-release-in-teardown flag on the round's lock holder (the backend already released the lock; the round's teardown must not call the release endpoint a second time).
   - Clear the sticky "deferred completion" flag (so a prior defer in the same round, now resolved, does not keep suppressing future releases).
   - Log whether the response's "already migrated" flag is true (informational; both outcomes are success — the flag is true on a re-call against an already-flipped space).
   - Return a success outcome with the "completion deferred" boolean set to false.

5. **On thrown error from the completion call**, return a terminal migration-failed outcome. Notable: an earlier revision swallowed this error, leaving the round reporting "synced" while the backend's binding flag stayed on the database value, so the next round re-ran the full import from scratch with zero user-visible signal that anything was wrong. The current behavior surfaces a red "sync failed" until the backend recovers; the completion endpoint is idempotent so the next round retries cleanly.

### B7. Phase-boundary budget reset

Immediately after a successful completion call (whether deferred or not), the round resets its credential-recovery budget to zero. The migration sub-flow may have consumed the round's one allowed recovery-mint during its push step; resetting the budget here means the round's steady-state push that follows gets its own at-most-one recovery. This is safe because the backend's repo-existence side effect is idempotent on a second mint.

### B8. Deferred-completion retry inside the same round

After the round's main-body steady-state push, if the migration sub-flow returned a "completion deferred" success outcome, the round re-invokes the completion procedure (B6). The steady-state push has just landed HEAD on the remote, so the safety probe now passes.

Outcome handling:

- **Success:** as in B6's success branch (clears persisted self-lock, clears the lock-release-in-teardown flag, clears the sticky deferred flag).
- **Failure:** logged as a warning. The round does **not** transition to offline because of this retry's failure — the migration content is already safely on the remote, and the completion call is idempotent. The next round's mint will return `alreadyVaultBound: false` again (because the backend has not yet flipped the binding), the next round will re-enter the migration sub-flow, will see `alreadyMigrated: true` from the fetch (the docs are already on the remote), and will reach completion through the already-migrated short-circuit. The retry-failure path deliberately does not re-attempt the lock-release endpoint either — the lock-release-in-teardown flag was already cleared upstream the moment defer was first established, and racing the backend with two release attempts is the explicit per-plan decision being avoided here.

### B9. Round-teardown lock release interaction

Whenever the migration sub-flow establishes a deferred-completion path (either at B6 or via B5's notification not yet having released the lock), the round's lock holder is marked so the round's outer teardown does **not** call the lock-release endpoint. Otherwise:

- An unrelated mid-round failure between the migration's defer establishment and the deferred-completion retry would let teardown release the lock against the backend, forcing the next round into a re-mint cycle that loses the completion endpoint's idempotency benefit.
- A recovery re-mint inside the same round would re-arm the teardown-release flag through the credential refresh path; the sticky "deferred completion" flag is what survives that re-mint and keeps the teardown release suppressed.

The fallbacks against permanent lock leakage are the backend's per-space write-lock TTL and the next round's completion call.

## State Transitions

The migration sub-flow operates on three independent state surfaces:

1. **Local vault working tree.** Transitions per row from "missing" → "present with row content" (via write) or from "present with old content" → "present with row content" (via overwrite). A row whose target is byte-equal to its existing content does not move state. A row that is a folder, that is filtered by the allow-list, or that throws a non-missing read error does not advance — the first two skip silently, the third aborts the sub-flow.

2. **Local git history.** When at least one file is written, the working tree is staged and committed in one commit. The commit advances the local HEAD by one. The push step then transitions the remote HEAD from "no migration commit" to "has migration commit" (or is a no-op on a retry where the commit is already on the remote).

3. **Backend personal-space binding.** This is the state the entire sub-flow exists to mutate. Transitions:
   - `db, not bound` → `db, not bound` (initial state of every migration round until completion succeeds; observable as `alreadyVaultBound: false` on the credentials envelope).
   - `db, not bound` → `git, bound` (on completion-call success). Once in this state, subsequent rounds see `alreadyVaultBound: true` on their credentials and skip the migration sub-flow entirely.
   - The intermediate "fetch shows already-migrated" state corresponds to a peer device having already flipped the binding while this device's credentials cache (within the round) still says otherwise — the next round's mint will agree.

4. **Per-space write lock.** Acquired by the credential mint at round start. Released by exactly one of:
   - The migration's post-push notification (B5 step 5).
   - The migration's completion call (B6 step 4).
   - The deferred-completion retry inside the same round (B8 success).
   - The next round's completion call (if this round's completion was deferred and the retry inside the same round did not succeed).
   - The round's teardown release endpoint (only when none of the above ran and the deferred flag was not set).
   - The backend's TTL (the unconditional backstop).

## Notable Behavior

- **The class-level docstring says writes land in a `<memoryBankRoot>/legacy/...` subdirectory; the code writes to `<memoryBankRoot>/<sanitized doc path>` with no `legacy/` prefix.** The tests assert this directly (`Untitled.md`, `new-test/design.md`, `data.json` at the root). Treat the docstring as stale; the on-disk layout mirrors the source personal space's filenames verbatim.

- **The vault-relative path is used as-is including filename and extension.** Earlier revisions treated the path as a directory and appended `<slug>.md`, producing a mirror that did not match the legacy source. The current behavior was a deliberate correction.

- **Path sanitization is per-segment, not whole-path.** Traversal segments are removed in place, so a path like `a/../b/./c.md` becomes `a/b/c.md` rather than being rejected. This is safe only because the allow-list filter runs after sanitization and rejects any path that still resolves outside the catalogue.

- **The slug-fallback path is `doc.md` when both the path and the slug are empty.** This is the explicit "don't drop a malformed document silently" branch. Worst case is a tiny `.md` file with non-prose body; the backend pre-filters binary content so the content is safe to write under a `.md` name.

- **The extension picker only recognizes "markdown" and "json" substrings on the content type.** Anything else — `application/octet-stream`, `text/html`, the empty string — gets `.md`. The rest of the pipeline assumes markdown-ish content; this is the safer default.

- **A non-missing read error on an existing target is fatal.** Permission-denied, is-a-directory, and I/O errors all propagate. Earlier revisions swallowed every read error indiscriminately and let the writer silently clobber a file it could not actually read; the current behavior fails the round so the user sees a real error.

- **Allow-list-rejected rows are dropped silently with a warning, not surfaced to the user.** A misconfigured row that the allow-list refuses is a single skipped doc, not a failed migration. The round still flips the backend binding so the migration does not keep retrying the same dead content forever.

- **The migration commits and pushes even when zero files were written on disk?** No — the commit-and-push leg is gated on a positive write count. The "every doc was filtered" case still flips the binding via the completion call so the next round does not re-import. But it does not create an empty migration commit.

- **The completion endpoint's idempotency is load-bearing.** Three paths re-call it: a same-round deferred retry after the steady-state push lands HEAD, a next-round entry after a swallowed completion failure, and a next-round entry after the "already-migrated" peer-race short-circuit. All three rely on the backend returning `alreadyMigrated: true` rather than an error on a re-call.

- **Migration's post-push notification fires before the round's steady-state notification.** Without it, the per-space write lock would not be released until either the steady-state push transmitted bytes (rare — the migration just committed everything, so the steady-state push is usually a no-op), the completion call ran, or the backend's TTL expired. Peer devices would see the personal space marked busy for the whole TTL window.

- **The deferred-completion sticky bit is necessary because of a recovery re-mint.** A 401 or 404 during the migration's own push triggers an at-most-one recovery mint inside the push step; that recovery path re-arms the round's "release in teardown" flag. Without the sticky bit, the next migration step's defer establishment would be undone by the recovery, the round teardown would release the lock against the backend, and the next round would have to re-mint to acquire a fresh lock — losing the completion endpoint's idempotency benefit.

- **The "already migrated" short-circuit still attempts completion.** It is not a no-op return; the completion call doubles as the canonical client-side lock-release path. Skipping it would force the round to rely on the backend's TTL to release the lock.

- **Reset of the recovery-mint budget at the migration phase boundary is intentional.** Migration push and steady-state push each get their own at-most-one credential recovery; one phase's transient auth failure does not impair the other.

- **The deferred-completion failure inside the same round is a warning, not a terminal outcome.** The migration content is safely on the remote at that point — the completion call is the only thing outstanding, and it is idempotent. Flipping the round to offline for a transient RPC blip on completion would surface a misleading red error while the data is already safe.

- **There is no client-driven pagination on the legacy fetch.** The backend returns the whole document list in one response; the writer trusts that and does not loop.

- **The fetch boundary is the only place where the backend can refuse before any on-disk work happens.** Every later failure (allow-list filter, content-equal skip, read error, write error, push, notification, completion) corresponds to a different failure-handling posture (drop-row, no-op, terminal, terminal, terminal, swallow, terminal-or-swallow).

- **Concurrency between devices is handled by the backend's per-space write lock, not by the client.** The migration sub-flow holds that lock from credential mint through completion or through one of the release paths; two devices cannot both be inside their migration sub-flow against the same personal space.

- **Concurrency between rounds on the same device is handled by the reconciliation round's machine-wide mutex.** The migration sub-flow does not take its own additional lock; it inherits the round's lock.

- **The migration sub-flow does not write to or read from any per-device state file directly.** It mutates only the vault working tree, the per-space backend binding, and the round-level lock-holder flags. Persisted self-lock evidence is cleared (not written) on the two success-release paths.

## Shared Behavior

- **Sync reconciliation cycle (spec 150)** — boundary. The migration sub-flow is invoked as one step of the reconciliation round. The round provides the credentials envelope, the lock holder, the staging-with-classifier step, the push step, the recovery-mint budget, the commit author, the Memory Bank root, the round's "sync transcripts" boolean, and the deferred-completion retry hook. The round consumes only the sub-flow's success-with-deferred or terminal-failed outcome.

- **Sync backend client (spec 170)** — boundary. The migration sub-flow calls the legacy-content fetch endpoint, the migration completion endpoint, and the post-push notification endpoint through the boundary. Each call's wire format, auth, error classification, transport retries, and rate-limit posture belong to that spec.

- **Vault bootstrap merge (spec 167)** — boundary interaction. The bootstrap-merge sub-flow runs on a different trigger (existing local user-authored content meeting a non-empty remote), but its outcome can leave HEAD born locally yet not on the remote default branch — the same precondition that drives the completion call's deferred path here. The migration sub-flow's safety probe at B6 step 1 explicitly covers that bootstrap-merge case.

- **Vault allow-list classification** — shared filter. The migration writer consults the same allow-list predicate as the round's staging step. Allow-list rules and the "sync transcripts" parameterization belong to the allow-list spec.

- **Commit message construction** — shared. The migration commit message is built through the same commit-message builder used elsewhere; the operation tag "migrate" and the items-from-legacy-space summary are the migration-specific inputs.

- **Per-space write-lock release coordination** — shared. The release evidence flags (`releaseInFinally`, `deferredCompletion`), the persisted self-lock evidence, and the three canonical release paths (post-push notify, completion call, teardown endpoint) are shared with the steady-state path and are specified in full by the reconciliation cycle spec; the migration sub-flow's contribution is the two migration-specific release branches (migration notify-push and completion call) and the deferred-completion sticky-bit interaction.
