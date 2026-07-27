# 150. Sync Engine Reconciliation Cycle

## Topic Statement

Reconcile a local Memory Bank vault working tree with the user's backend personal-space remote in a single serialized lock-protected round that mints fresh credentials, refreshes refs, replays remote changes through a tiered conflict pyramid, classifies and stages owned local content, commits and pushes, then releases the backend write lock.

## Scope

**In scope:**

- The end-to-end execution order of a single reconciliation round, from entry to terminal state emission.
- Acquiring, refreshing, and releasing the machine-wide reconciliation mutex.
- Per-round credential minting against the backend (no cross-round token cache), including the per-round and per-phase recovery-mint budget.
- The backend's per-personal-space write-lock lifecycle (acquired by the mint, released by one of three success calls or by a failure-path safety net), the locally persisted self-lock evidence, and the deferred-completion sticky bit.
- The vault working-tree identity guard (marker file plus origin URL crosscheck) that refuses to write to any folder the engine cannot prove is the correct personal-space clone.
- Self-healing for stale paused-rebase state and orphaned per-file `.lock` files left behind by a prior killed round.
- The clone-or-fetch decision (cold start vs. existing remote-only directory vs. existing local git repo), each with step-level retry and at-most-one recovery mint on auth/missing-repo errors.
- The branch-recovery state machine that ensures HEAD sits on the backend-declared default branch before any commit (unborn-HEAD adoption, missing-local-ref recreation, ancestor fast-forward of stranded commits, divergent terminal refusal).
- Auto-reconcile of user-edited vault state into a "reconcile" commit before integration with the remote.
- Pre-stage validation of dirty engine-owned JSON files (corrupt-JSON quarantine).
- Integrating remote changes via rebase-style replay held under a per-vault write lock that spans both the replay and conflict resolution.
- The tiered conflict pyramid (deterministic aggregate-file merge → newest-timestamp pick for a regenerable artifact → safe deterministic heuristics → AI-mediated merge → policy- or prompt-driven binary pick → skip).
- Resolving and persisting the per-repo identity ↔ vault subdirectory mapping, including detection of cross-device folder collisions.
- Allowlist-based staging that classifies every dirty path and routes owned content to `add`, transcripts conditionally to `add` or unstaging-to-HEAD, unknown/symlinked content to a canary bucket without touching the remote.
- The idle-round short-circuit that skips the commit/push leg when local and remote heads match and no owned content is dirty.
- The push step with step-level retry across three recoverable shapes (non-fast-forward retry-after-pull, auth recovery via re-mint, missing-repo recovery via re-mint) and terminal classification of every other failure (server rejection, network, terminal).
- Backend notification of the pushed HEAD as the primary release path for the backend write lock.
- The first-bind migration sub-flow that runs once per personal space to import legacy backend content, push it, and flip the backing — including the deferred-completion path when no commit yet exists on the remote default branch.
- The transient 423 / 503 "wait" retry schedule, the self-vs-peer-lock attribution, and the wait-phase progress notification.
- A cross-repo "pending workers" wakeup registry the round drains on completion so peer workers that timed out waiting for the per-vault write lock get re-spawned.
- The exact mapping from round outcome to the four UI states (`syncing`, `synced`, `conflicts`, `offline`) plus the round-result trust caveats.

**Out of scope (boundaries — what is sent/received but not re-specified here):**

- The on-disk shape, schema, and merge semantics of the orphan-branch summary storage that backs the **source repo's** local summary content (separate spec). The reconciliation round reads and writes a separate git working tree (the vault) that mirrors processed content; it does not touch the source repo's orphan branch.
- The folder-based per-repo Memory Bank file layout (separate spec). The reconciliation round operates on whatever the storage layer wrote into the vault working tree; it does not produce or interpret the content.
- The bootstrap merge that runs only when the local vault has user-authored unborn-HEAD content that must be merged onto a non-empty remote (separate spec — referenced only as a side branch of the branch-recovery state machine).
- The legacy db→git import payload format (separate spec — referenced only as a single "fetch and apply" boundary call).
- The conflict UI implementation in each surface (CLI prints, IDE prompt webview). The round invokes a `promptBinaryPick` boundary and consumes whichever of `mine` / `theirs` / `skip` / `viewDiff` comes back.
- The CLI command, IDE auto-poll scheduler, and post-commit-hook callers that invoke the round. The round is invoked with a small caller-supplied options object; how the caller decided to invoke it is separate.
- The auth credential store, API key parse, and tenant-origin resolution that turn a saved API key into a backend base URL (separate specs). The round consumes a typed credentials object plus a saved API key.
- The on-host shared lock primitive (file-based PID + mtime) used by all per-user locks (referenced inline as "the standard lock primitive" — the same primitive is used by the worker lock and the orphan-write lock).
- Per-source-repo queue workers that produce vault writes between rounds. The round coordinates with them only through the per-vault write lock and the pending-workers registry.
- The "legacy summary push to the backend space" path (separate spec — different endpoint, different lifecycle; this reconciliation cycle is its replacement/coexisting sibling).
- The "binding required" and "plugin outdated" flows that gate the legacy push (separate specs).

## Data Contracts

### Round invocation options

The caller supplies, per round:

- A source working directory (the repo whose post-commit content the round is reconciling — used as the cwd for the cross-repo wakeup registry and the round-complete callback).
- A reason discriminator from a fixed set ("post-commit", "poll", "manual", "first-bind"). Only used for logging and telemetry — does not branch behavior.
- A boolean "include transcripts" flag.

### Round context (resolved once at round start)

- An absolute vault working-tree root path.
- A repo-folder name (subdirectory of the vault root holding this source repo's content; may be overridden by the persisted repo mapping).
- A canonical repo identity string (typically the normalized git remote URL of the source repo; falls back to the source workspace basename) used as the primary key in the mapping file.
- An author identity `{ name, email }` used on every engine-produced git commit and rebase replay.

### Credentials (minted per round from the backend)

- A git clone URL over HTTPS (a non-HTTPS scheme is rejected at the boundary).
- A short-lived bearer token plus expiry timestamp.
- A canonical "user/repo" full name and a backend-declared default branch name.
- A boolean indicating whether the personal space is already bound to its git backing (false on the first bind ever; true thereafter).
- A backend-issued "lock owner token" identifying the per-space write lock the mint acquired on the backend.

### Persisted self-lock evidence

A single small JSON record at a fixed machine-global path, used by the round driver to distinguish "the backend lock is held by **this** device's previous attempt" from "held by another device":

- A schema version.
- A hash of the active API key (key-derivation-function output, truncated; rebuilds whenever the API key changes so an account switch invalidates the entry automatically).
- The most-recently-minted lock owner token.
- The wall-clock time of that mint.

Written every time a mint succeeds (overwriting any prior entry); cleared whenever the backend has confirmed lock release; treated as stale (logically absent) when older than a grace window equal to the backend lock TTL.

### Repo identity → folder mapping (vault-resident)

A single JSON file at a fixed location inside the vault tree:

- A schema version.
- An array of `{ repoIdentity, folder }` rows.

Merged across devices on rebase by deduping on `repoIdentity`. Folder collisions across different identities are detected but never auto-renamed (auto-renaming would produce a mapping that disagrees with the on-disk layout because content is never moved).

### Vault identity marker

A single JSON file inside the vault's internal git directory (never committed, never pushed, never pulled). Carries:

- A fixed kind string ("memory bank vault") and a schema version.
- A normalized expected remote URL.
- The canonical user/repo full name and default branch at the time it was written (informational, not used for verification).

Both the marker's stored URL and the live origin URL must normalize to the freshly minted credentials' URL or the round refuses to write.

### Cross-repo pending-workers registry

A directory next to the per-vault write lock containing one file per source-repo cwd that recently observed a per-vault write-lock timeout. Each file's name is a hash of the cwd, and its content is the absolute cwd path verbatim. Producers (workers that timed out) record entries; the round consumes and deletes entries on completion, then invokes the caller-supplied "launch worker for cwd" callback for each consumed entry.

### Round result

A read-only structure returned to the caller:

- A new UI state (one of: `syncing`, `synced`, `conflicts`, `offline`).
- Booleans `fetched`, `pulled`, `pushed` (load-bearing only on a normal return; in the catch-all "round threw" branch these are stubbed to false even when partial progress occurred).
- An array of unresolved conflict records `{ path, tier, detectedAt }`.
- A `lastError` (only on the `offline` outcome) carrying a stable error code, a human-readable message, and, on the `vault_locked` code only, a boolean indicating whether the lock is self-held.
- A "canary" object with two arrays — `symlinked` (paths that classified as owned but had a symlink in the leaf or path chain — strong hostile-placement signal) and `unowned` (paths the classifier didn't recognize — weak drift signal). Both are capped to a small number of paths per round.

### Round-phase progress event

The round emits one of `downloading`, `merging`, `resolving`, `uploading`, `waiting` to a caller-supplied callback at the start of the matching coarse phase. Coarser than the engine's internal step list — fast/reliable steps don't emit; the last-emitted phase remains visible while they run.

### Wait notification

When a mint observes a transient "wait" condition (a 423 "personal space busy" backend reply or a 503 "pending web flush" backend reply), the round emits before each backoff sleep:

- The 1-indexed attempt number and the total attempt budget.
- The wait duration in milliseconds before the next retry.
- The backend's human-readable message.
- A boolean indicating self-vs-peer attribution (derived from persisted self-lock evidence).

### Stable terminal/transient error codes

A closed string union with one transient code (`network`) and a fixed set of terminal codes (`mint_failed`, `vault_locked`, `vault_mismatch`, `localfolder_invalid`, `push_rejected`, `git_missing`, `clone_failed`, `fetch_failed`, `pull_failed`, `migration_failed`, `sync_failed_after_retries`). The status surface renders the transient code as a neutral "offline" and every terminal code as a red "sync failed" with the code as the tooltip key.

### Aggregate file shape (for the deterministic-merge tier)

Four engine-managed JSON files per vault and one per repo subdirectory. Each has a versioned envelope wrapping an array keyed by a stable primary key. Merge is deterministic: dedupe by primary key, apply a per-file tiebreak (newer timestamp wins, ties prefer the first occurrence; for one file a non-null parent commit hash outranks a null parent regardless of timestamps), then sort by primary key for byte-stable output across devices.

### Commit message format

Every engine-produced vault commit uses a single-line prefix `[product-tag] <op>: <summary>`, where `<op>` is one of `add`, `delete`, `merge`, `pick`, `migrate`, `bootstrap`, `aggregate-merge`. Per-file detail can append `(<path>)` after the op and `[model=<name>]` as a trailer.

## Behavior

### Phase 0: Round entry and serialization

1. Record the caller's options (cwd, reason, transcripts flag) and reset a per-round canary accumulator to two empty arrays.
2. Attempt to acquire the **machine-wide reconciliation mutex** with a caller-configurable timeout (defaulting to 10 seconds). The mutex is implemented as a single file at a fixed per-user path; acquisition uses the standard host PID-plus-mtime lock primitive shared with the other per-user engine locks.
3. **Miss path:** If acquisition times out, the round returns immediately with new state `syncing` (the round was skipped because another round is in flight). The caller may interpret this as "this round had no effect" and try again later.
4. **Hit path:** Start a periodic heartbeat that bumps the mutex's mtime (default cadence: every 60 seconds) so a long-running round cannot be stolen by the stale-reclaim watcher of the standard lock primitive.
5. Create a per-round **lock-disposition holder** with three fields: the most-recently-minted backend lock owner token, a "release in finally" boolean, and a "deferred completion" sticky boolean (all initially null/false). The holder outlives the inner work so the outer finally can decide whether the backend lock still needs to be released.
6. Resolve the round context once (one call to a caller-supplied resolver). All subsequent work uses the same context.
7. Invoke the inner round body in a try/catch/finally that:
   - On a normal return, propagates the result unchanged.
   - On an unexpected throw, logs the stack and converts to an `offline` outcome — `vault_locked_busy`-style sentinels (raised when the per-vault write lock cannot be acquired in time) are mapped to the transient `network` code; everything else is mapped to terminal `sync_failed_after_retries`.
   - On every exit (normal or thrown), the **finally** block:
     - Stops the heartbeat timer.
     - If the holder shows a held backend lock with "release in finally" true and **not** "deferred completion", invokes the backend's release-lock endpoint. Release failure is swallowed (the backend's TTL is the fallback); on success it also clears the persisted self-lock evidence. The release is intentionally performed **before** the reconciliation mutex is released, so the next round's mint doesn't race a still-in-flight release.
     - Releases the reconciliation mutex.
     - Invokes the caller's "round complete" callback (if any) with the source cwd, swallowing any throw — this is the chain-spawn hook the caller uses to wake any timed-out workers on the same cwd.

### Phase 1: Mint credentials (with transient-wait retry schedule)

8. Read the persisted self-lock evidence once and freeze it for this whole mint loop (a mid-loop write from another concurrent process must not flip the classification). The frozen value drives the self-vs-peer attribution on every wait notification this loop emits.
9. Attempt to mint credentials. The mint loop has a total attempt budget equal to a backoff schedule plus one (initial attempt + one retry per schedule entry). The default schedule is three retries at 60 s → 120 s → 180 s (4 total attempts, 6 minutes total wall-clock budget). The schedule is overridable for tests.
10. On a successful mint:
    - **Before** any local persistence, update the lock-disposition holder: write the token, set "release in finally" true. (Persisting after this would risk the backend lock being unreleasable if persistence threw.)
    - Persist the self-lock evidence (overwriting any prior entry; account-scoped via the API-key hash).
    - Return the credentials to the caller.
11. On a 423 "vault locked" failure with attempts remaining:
    - Emit the `waiting` phase event.
    - Emit a wait notification carrying the frozen self-vs-peer flag and the next backoff duration.
    - Sleep the schedule entry, then continue the loop.
12. On a 423 failure on the final attempt: return a terminal `vault_locked` error with the frozen self-vs-peer flag attached.
13. On a 503 "pending flush" failure (the backend's "the web tier still has unsent edits, do not let the client clone now and overwrite them" signal): identical handling to 423 except the sleep duration is server-suggested (clamped to a one-second minimum, defaulting to 30 s if missing) and the final-attempt outcome is the transient `network` code rather than terminal.
14. On a network-error mint failure: return transient `network`.
15. On a 401/403 unauthorized: return terminal `mint_failed`.
16. On any other 4xx/5xx or shape-error: return terminal `mint_failed` with the backend's body included in the message.
17. **Initial mint failure** propagates upward as the round's outcome (`offline` with the typed code; the round result's `fetched`/`pulled`/`pushed` are false).

### Phase 2: Environment probes and self-healing

18. Construct a vault git client bound to the credentials and vault root.
19. Probe `git --version`. If the binary is unavailable, return `offline` with terminal `git_missing`.
20. **Self-heal paused rebase.** Probe for a `.git/rebase-merge` or `.git/rebase-apply` directory. If present, run `rebase --abort`. The vault is engine-owned, so any paused rebase is one this engine started and failed to finish (sigkill, laptop sleep, crash). Abort failure is logged and ignored — the next pull will surface a real error if the abort didn't take. Missing `.git/` (cold start) is silently tolerated.
21. **Self-heal stale per-file locks.** Sweep the vault's internal git directory for `.lock` files older than a 5-minute TTL (covers `index.lock`, `HEAD.lock`, `refs/**.lock`, `packed-refs.lock`, `config.lock`). The 5-minute TTL deliberately tolerates an out-of-band manual git operation by the user up to that window; above the window an orphaned lock from a sigkilled prior round is reliably swept. Sweep failures are logged and ignored.

### Phase 3: Clone-or-fetch with step-level retry

22. Emit the `downloading` phase event.
23. Enter a per-step retry loop (default budget: 3 attempts). On each attempt:
    - Probe whether the vault root exists and whether it contains a `.git/`. Three branches:
      - **`.git/` present (existing local clone, steady state):** First verify vault identity — read the live origin URL via the git client and run the marker verification. Three outcomes:
        - Marker present and stored URL matches credentials → proceed. If the marker matches only after re-normalization (older marker format), rewrite it in the canonical form.
        - Marker absent **but** live origin URL matches credentials → backfill the marker (legitimate upgrade from a pre-marker install) and proceed.
        - Anything else (marker absent and URL doesn't match, marker present but URL disagrees, no origin remote configured) → return terminal `vault_mismatch`. **Never retry, never re-mint, never write.** The user must reselect the vault folder.
      - Then run `git fetch origin`. On success, record `cloned: false` and exit the loop with success.
      - **Vault root exists but no `.git/` (first-bind into an existing folder, e.g. a pre-existing local content directory):** Record a forensic top-level audit (entry count + total bytes) to the debug log. Then `git init` with the credentials-declared default branch, add the origin remote (or update its URL if already present), `git fetch origin`, persist the vault identity marker. Record `cloned: true` and exit the loop with success.
      - **Vault root doesn't exist (cold start):** `git clone` the credentials URL into the vault root. Persist the vault identity marker. Record `cloned: true` and exit the loop with success.
24. On any throw during the above, classify the error message:
    - "Auth failed / 401" → call **recovery re-mint** (Phase 7 below); on re-mint success, continue the loop with new credentials and a new git client; on re-mint failure, terminate with the re-mint's typed error code.
    - "Repository not found / 404" → same as above (re-mint triggers backend re-provisioning of the repo idempotently).
    - Network-shaped → return the transient `network` code with the step name in the message.
    - Anything else → return `clone_failed` (clone or init step) or `fetch_failed` (fetch step) terminal.
25. After a successful clone or init the round records `isFirstBind = cloned`. This drives the commit-message variant later (initial-bootstrap vs steady-state add).

### Phase 4: Branch-recovery state machine

26. Goal: HEAD must point at the credentials-declared default branch by the end of this phase.
27. Read the current branch (or "HEAD" if detached/unborn).
28. **Already on default branch:** Most rounds. But still handle the unborn-default case:
    - If HEAD is unborn:
      - If the remote-tracking ref `origin/<default>` exists:
        - If the working tree has any uncommitted or ignored-but-present content (the deny-all `.gitignore` regime — see Phase 5 — makes every engine-written file ignored, so a plain "porcelain" check would miss them; an "include ignored" check is required):
          - Decide whether to run the **bootstrap merge** sub-flow (separate spec) based on strict gates (no local branches present, no stash present, and this exact unborn-with-content shape). On a positive verdict, run the sub-flow. On failure, fall through to the unborn-HEAD defer path below.
          - On a negative verdict, defer to the auto-reconcile + pull-rebase path of Phase 6 (the user's content will become the initial commit and rebase onto remote).
        - Otherwise (clean working tree) → adopt the remote-tracking ref directly.
      - Otherwise (truly empty remote) → leave HEAD unborn; the round's first commit will be born from this branch.
    - Return success.
29. **HEAD is on a different branch:**
    - If the working tree is dirty (using the "include ignored" check) — stage classifier-owned content (see Phase 8) and commit a single "reconcile: preserve work from `<side>` before switching to `<default>`" commit on the current side branch. This preserves work via the reflog after the upcoming checkout.
    - If the local default-branch ref doesn't exist (shallow clone, pruned) → recreate it tracking `origin/<default>` and return success. Side-branch commits remain on the side ref locally (reflog recovery).
    - If HEAD is an ancestor of default → plain `git checkout <default>`; default already contains everything HEAD has.
    - If default is an ancestor of HEAD (the "stranded commits on side branch" shape — a buggy earlier round left content on a side branch while default never advanced) → fast-forward default to HEAD's tip via `git checkout -B <default> <head>`. The round's push will then carry the previously-stranded commits.
    - **Diverged** (both sides have commits the other doesn't) → return terminal `vault_mismatch` with a message asking the user to merge or rebase manually. Auto-merging risks silent data loss.
30. On any exception in this phase, return terminal `vault_mismatch`.

### Phase 5: First-bind migration (one-time per personal space)

31. Skipped when the credentials report `alreadyVaultBound: true` (the steady-state).
32. When `alreadyVaultBound: false`:
    - Call the backend's `legacy-content` endpoint to fetch every alive document in the user's legacy database backing.
    - **If the response carries `alreadyMigrated: true` or an empty docs array** (a peer device beat us to the flip): call `complete-migration` (Phase 5b below) and return.
    - Otherwise: ensure the bootstrap (`.gitignore` template, per-device JSON untrack) is written, apply the legacy content to the working tree via the legacy-migration boundary helper.
    - If the apply wrote any files: stage via the allowlist staging (Phase 8), commit with the `migrate` op message "N items from legacy space", push via the retry-aware push step (Phase 9), and on a transmitted push call the backend's `notify-push` (which both records the migration HEAD and releases the backend lock). On notify-push success: clear the persisted self-lock evidence and clear "release in finally" on the holder. On notify-push failure: log and swallow — the failure-path safety net in the round's finally will call release-lock against the same token.
    - Call **try-complete-migration** (Phase 5b).
    - Reset the per-round re-mint budget to zero (a phase boundary; the steady-state push that follows gets its own at-most-one recovery).
    - If the legacy apply wrote zero files (every doc rejected by the allowlist), still flip the backing (proceed straight to Phase 5b) so the next round doesn't keep fetching dead legacy content.
33. If the migration push fails: return `offline` with `migration_failed`.

#### Phase 5b: try-complete-migration

34. Probe whether HEAD is born; if born, probe whether it is reachable from `origin/<default>`. (Two separate probes — born and on-remote — collapse into one gate.)
35. If HEAD is **not** on the remote default branch (either unborn or born locally but unpushed):
    - Set the holder's "release in finally" false and the "deferred completion" sticky true (the next round's complete-migration call is the chosen release path; calling release-lock here would force the next round into a wasteful re-mint cycle).
    - Return `{ ok: true, deferred: true }`. The caller will retry after the steady-state push.
36. Otherwise: call the backend's `complete-migration` with the current HEAD sha and the lock owner token. On success:
    - Clear the persisted self-lock evidence.
    - Clear "release in finally" and **also** clear "deferred completion" (so a defer-then-success in the same round doesn't keep suppressing future releases).
    - Return `{ ok: true, deferred: false }`.
37. On exception: return terminal `migration_failed`. (The backend's complete-migration is idempotent, so the next round retries cleanly.)

### Phase 6: Pull-rebase under the vault write lock

38. Emit the `merging` phase event.
39. **Auto-reconcile** any locally edited owned content first (pre-pull). Use the classifier-aware "is there anything owned that is dirty?" probe (the plain `git status --porcelain` check would miss brand-new owned files because the deny-all `.gitignore` regime marks them as ignored). If positive:
    - List dirty paths.
    - Run the **corrupt-JSON quarantine** pass over them (validate that every dirty `.jolli/**/*.json` parses; move unparseable ones into a vault-root quarantine directory `.jolli-quarantine-corrupt/` and append a per-clone exclude line so neither this nor the bootstrap-written gitignore can stage them).
    - Stage via allowlist staging (Phase 8) and commit with the `reconcile` op message.
    - Auto-reconcile failures are logged but NOT fatal (the pull below will surface a clear error if the dirty state genuinely blocks rebase).
40. Probe whether `origin/<default>` exists. If it doesn't (empty-remote first-bind), skip the pull entirely (the round's commit + push will create the branch). Note this case as `remoteHasDefault = false`.
41. Otherwise:
    - **Acquire the per-vault write lock** with a 10-second wait budget. On miss, throw the polite "vault busy" sentinel — the outer catch maps it to transient `network` so the next round retries.
    - Hold the lock across **both** the rebase replay **and** any subsequent conflict resolution. Start a heartbeat (60-second cadence) that refreshes the lock's mtime so a long Tier 2 AI merge or open-ended Tier 3 prompt doesn't lose the lock to the stale-reclaim watcher.
    - Run `git pull --rebase origin <default>`. Two outcomes:
      - **Clean** (no conflicts): record whether the rebase fast-forwarded (worked-tree-changed-by-pull flag); release the lock.
      - **Paused with conflicts**: drive the conflict pyramid (Phase 7); record whether the rebase ultimately advanced; release the lock.
42. On any exception during pull or resolution:
    - If it's the "vault busy" sentinel, re-throw (outer catch handles it).
    - Otherwise classify the message: network-shaped → transient `network`; anything else → terminal `pull_failed`. Return `offline` with the typed code.
43. If conflicts resolved with the rebase **not** advancing (skipped paths only), return new state `conflicts` with the unresolved conflict records.

### Phase 7: Conflict pyramid (driven only inside Phase 6 when rebase paused)

For each conflicting path, in order, the **first tier that resolves** wins:

44. **Tier 1.5 — deterministic aggregate-file merge.** When the path matches one of the engine-managed aggregate-file shapes (the per-vault repo-mapping file, or the per-repo manifest / index / branches / catalog files):
    - Read the three stages (base/ours/theirs) from the index.
    - Replace any null stage with the matching empty envelope shape so an add/delete conflict (one device modified, one regenerated) still merges by accepting the peer's content instead of asking the user to "use my edit / use remote version" on a file they didn't author.
    - Parse both sides as JSON. If either fails (genuinely corrupt JSON), fall through to Tier 2.7 — losing the file would be worse than asking the user.
    - Dispatch on the basename to the matching deterministic merger (dedupe by primary key, apply per-file tiebreak, sort for byte-stable output). Write the merged content, stage the path, mark resolved. Skip remaining tiers for this path.
44a. **Tier 1.6 — newest-timestamp pick for the regenerable graph artifact.** When the path is the per-repo regenerable knowledge-graph data file (`graph/graph.json`, or the bare root-level form):
    - Read both sides' embedded generated-at timestamp from file **content** (not the committer date — an implicit reconcile commit must not skew the pick) and keep the newer side; on a tie, keep the local side.
    - When one side is missing (an add/delete conflict) or unparseable, the other (present/parseable) side wins.
    - Record the pick in a dedicated regenerable-picked list, mark resolved, and skip remaining tiers for this path.
    - This tier runs BEFORE the AI-merge and prompt tiers so a machine-authored artifact never burns an AI-merge call or asks the user to pick.
    - When BOTH sides are missing or unparseable, fall through to the later tiers.
45. **Tier 2.7 — safe deterministic heuristics.** In order, first hit wins:
    - **Empty-side rule:** If one side is whitespace-only and the other has real content, take the non-empty side.
    - **Identical-after-normalize:** If both sides match after normalizing line endings and trailing whitespace, take the local side (avoids churning line endings unnecessarily).
    - **Base-aware delete-vs-modify:** When one side is null:
      - Base matches the non-null side → respect the delete (remove the path from the working tree + index).
      - Base is null (file is brand new on the present side) → accept the new content.
      - Otherwise → genuine conflict, fall through.
    - **Memory Bank append-only markdown union:** Paths matching the append-only convention `<repo>/<branch>/<file>.md` (excluding paths under `.jolli/`) are unioned with an explicit "synced from another device" separator. Lossless. Idempotent (no re-append when one side already contains the other verbatim).
46. **Tier 2 — AI merge.** Only when a provider is wired AND both sides have non-null content. Per round, the provider is re-resolved on demand so a settings change takes effect on the very next merge.
    - Call the merge provider with `{ path, base, ours, theirs, fileKind: "md" or "json" }`.
    - Validate the response against four guards: confidence above a minimum (default 0.6), no conflict markers leak in the output, merged length is within `[0.5×, 4×]` of `max(|ours|, |theirs|)`, and the result parses as JSON when the file is JSON. On failure of any guard, fall through.
    - On success, write the merged blob, stage the path, record `{ path, model }`.
47. **Tier 3 — policy-driven fallback.** Three branches keyed on the round's conflict policy (which is surfaced from a config flag; defaults to `"prompt"`):
    - `"mine"` or `"theirs"` → unconditional pick; never call the UI.
    - `"prompt"` → loop calling the caller-supplied `promptBinaryPick` until the user returns a non-`viewDiff` answer. `viewDiff` invokes the UI's diff viewer (if any) and re-prompts; there is no cap on the prompt loop.
48. For a `mine`/`theirs` resolution, invoke the git-client's checkout-ours / checkout-theirs helper (which inverts the raw git flag because in a rebase the roles are inverted — "use my edit" maps to `git checkout --theirs`), then stage. Record `{ path, pick }`.
49. For `skip`, append the path to the skipped list and continue with remaining paths.
50. After processing all paths:
    - If any path was skipped → `git rebase --abort` and report `rebaseAdvanced: false`. Caller transitions to the `conflicts` UI state.
    - Otherwise → `git rebase --continue` (with author identity injected so the rebased commit's committer matches the round author, and with editor suppression injected so a configured `$EDITOR` cannot block the hidden child). Report `rebaseAdvanced: true`.

### Phase 8: Resolve the repo-folder mapping and write the bootstrap template

51. Load the vault-resident mapping file (treating missing/unparseable as empty).
52. Run a folder-collision scan (folders claimed by two or more identities). For each collision, log a warning and invoke the caller-supplied `onRepoMappingConflict` callback. Folders are **not** auto-renamed (auto-rename would produce a mapping that disagrees with the on-disk layout because no code moves the content).
53. Resolve the current `repoIdentity` against the mapping. Three cases:
    - No entry → record a new entry with the caller-supplied authoritative folder.
    - Entry exists and matches → no write.
    - Entry exists but points at a different folder than the local pick → **rewrite the entry in place** to the authoritative folder so the mapping reflects what this device will actually push. (Earlier behavior silently honored the stored value and produced a mapping/disk-layout split.)
54. If the mapping changed on this round, persist it to the vault working tree (so it stages with the rest of the round's content).
55. Run the **bootstrap step** (separate concern): write/refresh the deny-all `.gitignore` template, untrack any per-device JSON globs whose committed copies are now considered legacy (an unconditional `git rm --cached` against a fixed pattern set every round, so legacy committed entries become staged deletions that the round's commit captures).
56. **Idle-round short-circuit.** When **all** of the following hold, return new state `synced` immediately and skip the commit/push leg:
    - Remote has the default branch (don't short-circuit on empty-remote first-bind).
    - The pull did NOT change the working tree (neither fast-forwarded nor resolved a conflict — see "worked-tree-changed-by-pull" flag from Phase 6; when peer content landed, the round must continue to re-run staging so the per-stage symlink/canary defence still fires).
    - Local HEAD equals the remote-default OID.
    - The classifier-aware "is there any owned dirt?" probe returns false. (Using the plain "porcelain" probe here would let a freshly-onboarded repo flip to `synced` without ever pushing — every new owned file lands as ignored under the deny-all gitignore.)
    - Probe failures fall through to the normal stage/commit/push path; that path is its own self-check (commit's "nothing to commit" branch + push's "everything up-to-date" branch).

### Phase 9: Allowlist staging, commit, and push

57. **Compute the commit summary.** If this is the first-bind round (Phase 3 reported `cloned: true`), use a `migrate` op with summary "initial bootstrap from local folder"; otherwise use an `add` op with summary "memory bank changes".
58. **Allowlist staging.**
    - Snapshot `git status --porcelain -z --untracked-files=all --ignored=matching`. The `--ignored=matching` flag is required because the deny-all gitignore makes every owned path appear as ignored, not untracked.
    - Decompose every porcelain entry into discrete ops:
      - Renames split into a `del(oldPath) + add(newPath)` pair so each side classifies independently.
      - Copies emit only `add(newPath)` (the source is still present in the working tree).
      - Plain deletions emit one `del`.
      - Unmerged entries are dropped with a warning (the conflict resolver should have handled them).
      - Other entries emit one `add`.
      - Each op carries a "this path already has a staged change against HEAD" boolean.
    - For each op, classify the path against the **owned-path classifier** (Phase 8a below). Five outcomes:
      - Classifier returned null → the path is **unowned**. Add to the canary unowned list. If the op was already staged, route it to `git reset HEAD -- <path>` (restores the HEAD blob in the index without staging a deletion). **Never** `git rm --cached` it; that would stage a deletion of any HEAD-tracked legacy content the new classifier doesn't recognize and erase it from every peer's vault on the next push.
      - Classifier returned `transcript` AND the round's transcripts flag is false → skip (count as skipped). If the op was already staged, route to `git reset HEAD --`. The "off is passive" semantic: this device doesn't upload new transcripts, but doesn't delete what other devices have already uploaded either.
      - Op kind is `del` → route to the `toRm` list (for `git rm --ignore-unmatch --quiet`).
      - Op kind is `add` → first check the path-symlink safety: lstat the leaf (reject if a symlink) and walk the path chain from the vault root checking each intermediate segment is a real directory and not a symlink (reject if any segment is a symlink). On any rejection, add the path to the canary symlinked list. If the op was already staged, route to `git reset HEAD --` (preserve HEAD blob, do not push a deletion). Otherwise, route to the `toAdd` list.
    - Execute the three batches: `git add -f -- <toAdd>` (the `-f` is required because the deny-all gitignore would otherwise reject), `git rm --ignore-unmatch --quiet -- <toRm>`, `git reset --quiet HEAD -- <toReset>`. Each batch is chunked at a 16 KB argv budget for Windows compatibility.
    - Fold the canary buckets into the round-result canary (capped at a small per-round number of paths).
59. **Commit.** Run `git commit -m <message> --author=<author>`. If git reports "nothing to commit" (non-zero exit, characteristic stdout), record the current HEAD and proceed — no error.
60. Emit the `uploading` phase event.
61. **Push with step-level retry.** Enter a retry loop (default budget 3 attempts):
    - Run `git push origin HEAD:refs/heads/<default>` (the explicit `HEAD:refs/heads/<branch>` refspec pushes whatever HEAD points at; the round has already asserted HEAD is on default but the refspec is belt-and-suspenders).
    - On success, record whether the push transmitted bytes (detected by absence of "everything up-to-date" in stdout/stderr — defaults to transmitted on unrecognized output, so the only failure mode is one redundant notify rather than a missed one). Exit the loop.
    - On failure, classify the message:
      - **Unauthorized or repo-missing** → call recovery re-mint; on success continue the loop with new credentials and client; on failure terminate the loop.
      - **Non-fast-forward** → run pull-rebase under the per-vault write lock (same lock acquisition as Phase 6 but only across the pull, since this recovery path doesn't drive resolution). If the pull paused with conflicts, the recovery path aborts the rebase (otherwise the paused rebase state stays in `.git/rebase-merge/` and the next round wedges) and terminates with `sync_failed_after_retries`. Otherwise loop and retry the push. Lock-busy on the recovery pull is mapped to transient `network`.
      - **Other** → classify in order: server rejection (pre-receive declined / protected branch / payload-size limit) → terminal `push_rejected`; network-shaped → transient `network`; else terminal `sync_failed_after_retries`. **Server rejection must be checked before network** because server rejection often presents as "remote end hung up" / "early EOF" (the server closes the sideband socket after refusing) and would otherwise be misrouted to transient retry forever.
    - Loop exhausted → terminal `sync_failed_after_retries`.
62. **Deferred-completion retry** (only when Phase 5b returned `deferred: true`). The steady-state push just produced a HEAD on the remote, so retry the complete-migration call now. Failure is logged and dropped (the next round will re-enter the first-bind path because the backend hasn't flipped backing yet).
63. **Notify-push** (only when the push actually transmitted bytes — re-notifying the same SHA every idle poll tick is pure noise and pollutes per-user rate-limit signal):
    - Re-read HEAD after the push (a non-fast-forward retry may have rewritten local HEAD on its way to success).
    - Call the backend's `notify-push` with the post-push HEAD, the default branch, and the current lock owner token. On success, clear the persisted self-lock evidence and clear "release in finally" on the holder. On failure, log and swallow — the failure-path safety net in the round's finally will call release-lock against the same token.
64. Return new state `synced` with `fetched: true`, `pulled` as recorded, `pushed: true`, empty conflicts.

#### Phase 8a: Owned-path classifier

The classifier is a **pure function** of the relative POSIX path. It returns one of a closed enum of "owned kinds" or null. The function never touches disk (an instance-method form would force the engine to construct storage before clone/init and corrupt the round's identity).

Reject upfront: empty path, leading `/` or `./`, any `..`, any backslash.

Match in order:
- Root-level: exactly `.gitignore` → `root-gitignore`; exactly `.jolli/repos.json` → `root-repos`. (These are the only two root-level recognized files; other safe root-level paths fall through to `user-content`.)
- Under `<repoFolder>/.jolli/` (3 segments): a fixed-name file table maps `config.json`, `index.json`, `manifest.json`, `branches.json`, `catalog.json`, `migration.json` to their per-repo aggregate kinds. The file `shadow-status.json` is explicitly mapped to **null** so it never syncs (per-device dirty-write recovery state).
- Under `<repoFolder>/.jolli/<dir>/` (4 segments): `summaries/<hash>.json`, `transcripts/<hash>.json`, `plans/<slug>.md`, `plan-progress/<slug>.json`, `notes/<id>.md`. Each requires its variable segment to match the documented grammar (lowercase hex of 7–64 chars for hashes; constrained slug/id grammar for plans/notes).
- Under `<repoFolder>/<branch>/` (3 segments): `plan--<slug>.md`, `note--<id>.md`, and the bare-summary form `<slug>-<8-hex>.md`. Each requires the variable parts to match the documented grammar.
- Deeper nesting under `.jolli/` is not recognized (returns null → canary).
- The repoFolder and branch segments are validated against a "safe segment" pattern: no path separator, no NUL/control, no leading dot/dash/whitespace, no `..` substring, no trailing dot/dash/whitespace, length 1–200. This is permissive enough for real branch names that contain spaces, plus signs, unicode letters, etc., but rejects path-escape shapes.

**Fallthrough rule:** Any path that survives the structural rejects AND has every segment passing the safe-segment pattern AND is not the explicit denylist (`shadow-status.json` leaf) classifies as `user-content`. The strict `unowned` bucket is reserved for paths that fail the structural rejects.

### Phase 10: Recovery re-mint (called from Phase 3 and Phase 9 retry loops)

65. Guard: refuse if the per-phase recovery budget is spent (cap of one re-mint per phase). A second 401/404 in the same phase returns terminal `sync_failed_after_retries` with the cause name in the message.
66. Call the mint subroutine again (which updates the holder's token field and overwrites the persisted self-lock evidence). On failure, propagate the typed error.
67. On success, swap the round's working credentials and **rebuild the git client** with the new credentials (the bearer token is baked into the spawned git process's environment via the askpass step at client construction; recovery needs a new client).
68. Increment the per-round re-mint counter. The counter is reset to zero at one explicit phase boundary: the end of a successful first-bind migration (Phase 5 success). All other phases share one budget.
69. Recovery re-mint deliberately does **not** touch the holder's "deferred completion" sticky bit — a recovery re-mint after a defer must not re-arm "release in finally" and override the defer choice (the defer means "next round's complete-migration is the chosen release path; do not release here").

### Phase 11: Backend-lock release safety net (in the round's finally)

70. As described in Phase 0 step 7: in the round's `finally`, if the holder shows `token !== null && releaseInFinally && !deferredCompletion`, call the backend's release-lock endpoint with the token.
71. On success, also clear the persisted self-lock evidence (so the next round's mint attribution is accurate).
72. On failure, **do not** clear the persisted entry (an uncleared entry drives the next round to attribute its 423 to self rather than peer, surfacing "Personal Space busy — last round failed" which is the correct status).
73. The signal/hard-crash caveat: no signal handler is installed, so SIGINT / SIGKILL / power loss bypass this path entirely. The backend's TTL (≤ the wait schedule's total) is the only release mechanism for those cases.

### Phase 12: Round-complete chain-spawn (in the round's finally, after locks)

74. Drain the cross-repo pending-workers registry (one read + delete per cwd entry) and invoke the caller-supplied "launch worker for cwd" callback for each. This wakes any worker that previously hit the per-vault write-lock timeout and exited without draining its queue.
75. Invoke the caller-supplied "round complete" callback (if any) with the round's source cwd, swallowing any throw. This is the chain-spawn hook the caller uses to wake any worker bound to this same source cwd. Always fires AFTER both locks are released so the worker spawn doesn't immediately re-collide with this round's just-released mutex.

## State Transitions

The round's outcome maps to one of four UI states the caller surfaces:

- **`syncing`** — Only returned when the reconciliation mutex was held by another process and the timeout elapsed (the round was effectively a no-op). Round result has `fetched: false`, `pulled: false`, `pushed: false`, empty conflicts.
- **`synced`** — A normal completion. Two sub-cases: (a) the idle-round short-circuit fired and nothing changed; (b) the full pipeline completed and pushed any new content. The result's booleans reflect what actually happened.
- **`conflicts`** — The pull-rebase paused, the conflict pyramid drove the resolver, and at least one path returned `skip`. The rebase was aborted; the conflict records list every unresolved path with its tier marker. The round does not push in this state.
- **`offline`** — Any terminal or transient failure. The result carries a `lastError` with the typed code. On `vault_locked` the result also carries the self-vs-peer boolean.

**Per-round backend-lock holder state machine** (single instance per round, threaded through every mint/release transition):

| Trigger                                                 | `token`         | `releaseInFinally` | `deferredCompletion` |
|---------------------------------------------------------|-----------------|--------------------|----------------------|
| Round entry                                             | null            | false              | false                |
| Mint success (initial or recovery)                      | new token       | true               | unchanged            |
| `notify-push` success (steady-state push)                | unchanged       | false              | unchanged            |
| `notify-push` success (migration push)                  | unchanged       | false              | unchanged            |
| `complete-migration` success (non-deferred)             | unchanged       | false              | false                |
| `complete-migration` defer (HEAD unborn or unpushed)    | unchanged       | false              | true                 |
| Recovery re-mint after defer                            | new token       | true               | **unchanged (true)** |
| Round finally                                           | (release iff `token !== null && releaseInFinally && !deferredCompletion`) | — | — |

The third gate `!deferredCompletion` is the single point that honors the defer choice across recovery re-mints. The recovery re-mint deliberately does NOT touch `deferredCompletion`, and the finally consults both fields.

**Per-round mutable round-state** (separate from the holder):

| Field             | Initial value                           | Mutated by                                                |
|-------------------|-----------------------------------------|-----------------------------------------------------------|
| `creds`           | initial mint response                   | recovery re-mint (overwrites)                             |
| `client`          | constructed from initial creds          | recovery re-mint (rebuilds from new creds)                |
| `remintsUsed`     | 0                                       | recovery re-mint (+1); reset to 0 after first-bind migration success |
| `ctx`             | resolved once at round start            | never                                                     |

## Notable Behavior

- **No cross-round credential cache.** Every round mints fresh credentials from the backend. The previous design's cross-round token cache was removed precisely to make the per-round backend-lock semantics correct.
- **One reconciliation mutex per machine per user.** The mutex serializes rounds across all source repos and all surfaces (CLI command, IDE auto-poll tick, manual IDE button). The post-commit hook does NOT take this mutex — the auto post-commit sync was dropped from the product specifically to keep `git commit` snappy.
- **Vault write lock has asymmetric scope across its two acquirers.** The round holds it only across the pull-rebase + conflict resolution window; the queue worker holds it across an entire drain. The reason is a UX tradeoff: a user committing during a sync round would otherwise wait the whole round (~30–90s) before their summary appears. Releasing between pull and stage accepts that a concurrent worker can produce a partial commit, which the next round picks up.
- **The round refuses to write to a vault folder it cannot prove is its own.** Both layers — vault marker file inside `.git/` and a normalized origin-URL crosscheck — must agree with the freshly minted credentials. A missing marker is silently backfilled only when the origin URL matches; everything else is terminal `vault_mismatch` with no auto-retry.
- **Idle short-circuit uses a classifier-aware probe, not plain porcelain.** Under the deny-all `.gitignore` template, every brand-new owned file is reported by git as ignored (not untracked). The plain check would let a freshly-onboarded repo flip to `synced` without ever pushing.
- **Allowlist staging never `git rm --cached`s unrecognized content.** That used to silently delete legacy-tracked files from every peer's vault on the next push (a data-loss incident). The replacement routes unrecognized-but-staged content to `git reset HEAD --`, which preserves the HEAD blob and only drops local staged changes.
- **Transcripts-off is passive, not active.** Turning transcripts off prevents this device from uploading new transcripts; it does not delete transcripts other devices uploaded. A transcript with a pre-existing staged change is routed to `git reset HEAD --`, not `git rm --cached`.
- **Symlinks at owned-path locations are surfaced loudly.** Path-chain symlinks (intermediate-segment exploits) and leaf-level symlinks both bucket into a high-severity canary array on the round result. The round still completes; the path is excluded from the commit but the canary is emitted at warn-level log.
- **The conflict pyramid's `viewDiff` loop has no cap.** A previous 8-attempt cap was removed; "silent skip after the eighth view" was losing user picks.
- **The `"newest"` conflict policy was removed.** An engine-issued "reconcile" commit a few milliseconds before pull-rebase made the local timestamp effectively `Date.now()`, so "newest" always degenerated to "mine" while reading as semantically different. Older configs with `"newest"` are narrowed back to `"prompt"` at config-load time.
- **The aggregate-merge result must be byte-stable across devices.** Two devices merging the same `(local, remote)` pair must produce identical bytes; otherwise the next pull-rebase re-conflicts forever. Locale-independent code-unit ordering is required (not locale-aware string compare).
- **Repo-folder collisions are detected, never auto-renamed.** Auto-renaming would produce a mapping that disagrees with the actual on-disk content. The engine logs the collision and invokes a caller-supplied callback; users must manually disambiguate one side.
- **`pending-lock.json` is intentionally NOT cleared on release-lock failure.** Leaving it persisted drives the next round's 423-attribution to "self-locked", surfacing "Personal Space busy — last round failed" instead of attributing the lock to a peer.
- **The `complete-migration` 409 deadlock is broken via the defer path.** A born-but-unpushed HEAD that called `complete-migration` would get a 409 (the backend can't find that commit in the remote). The defer path routes both "HEAD unborn" and "HEAD born but not on remote" through the same retry mechanism: push first, then retry against a HEAD the remote actually has.
- **Recovery re-mint preserves defer.** A recovery re-mint mutates the holder's token and "release in finally" but never touches "deferred completion". Without this property, a 401/404 recovery push after a defer would re-arm "release in finally" and the round's finally would release the lock the defer choice was preserving for the next round.
- **The round-result booleans `fetched`/`pulled`/`pushed` are NOT trustworthy on a "round threw" outcome.** The catch-all branch synthesizes them as all-false even when partial progress occurred. Consumers that need an "anything might have changed on disk" signal must fire on every round-finish rather than gating on the booleans.
- **The 423/503 retry schedule was tightened from 9 min to 6 min.** The dominant failure mode in the field was self-induced (a previous round mid-push left the backend lock dangling for its TTL), not peer-induced. The shorter schedule trims worst-case "stare at busy banner" experience while still exceeding the typical lock TTL.
- **The push refspec is explicit (`HEAD:refs/heads/<default>`), not shorthand.** Shorthand `push origin <default>` is interpreted as `<default>:<default>` and silently reports "Everything up-to-date" when an external actor left the local default ref stale while commits piled up on HEAD's side branch. The explicit refspec pushes whatever HEAD points at.
- **Server rejection is detected BEFORE network classification on push failure.** A pre-receive declined / protected-branch rejection often closes the sideband socket and presents as "remote end hung up" / "early EOF" which look identical to network errors. Classifying network first would route these to transient retry forever (a known prior bug).
- **Editor and credential-helper env hardening on every git invocation.** Every spawned git call injects `-c core.editor=true`, `-c core.symlinks=false`, `-c credential.helper=` (empty list), `-c credential.modalprompt=false`, plus `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=Never` in the spawned environment. The bearer token reaches the git child only via the askpass shim's environment variable (never via argv). The child env is built from a curated allowlist of pass-through variables (PATH, HOME, locale, SSH agent, proxy, TLS/CA, user identity, EDITOR fallback, `GIT_*` prefix with `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` denied) — host secrets like `ANTHROPIC_API_KEY` / `GITHUB_TOKEN` are deliberately not inherited.
- **`core.symlinks=false` is both injected per-call and persisted into the cloned repo.** The persistence covers manual `git` invocations the user might run in the vault folder. Incoming hostile `mode-120000` blobs materialize as plain text files containing the link target as text, not as real symlinks.
- **Empty-remote first-bind skips the pull-rebase.** When `origin/<default>` doesn't exist, the round skips the pull entirely (otherwise `git pull --rebase` errors with "couldn't find remote ref" and the round flips to `pull_failed` before any first commit can be produced). The commit + push below creates the remote branch.
- **The auto-reconcile commit's message label is `reconcile`, not `sync`.** Using the classifier-aware probe (not the plain porcelain check) for the auto-reconcile gate restores this labeling for the case where the only local change is a brand-new owned file (which the plain check would miss because it lands as ignored under the deny-all gitignore).
- **The corrupt-JSON quarantine is a pre-stage pass, not a recovery path.** Files that fail to parse are moved to a vault-root dot-prefixed directory (gitignored, append-line in the per-clone exclude file for the pre-bootstrap window) BEFORE the auto-reconcile stage so the corruption never reaches the orphan history where peers would pull it and crash on parse.
- **An empty mint phase that exits the retry loop without returning throws "unreachable".** The 423 retry loop's structure guarantees every iteration either returns or sleeps + continues. Throwing rather than fabricating a default keeps a future-refactor bug loud instead of silently papering over with a `vault_locked` outcome that misleads the operator.
- **A round that begins after a previously-killed round walks straight into self-heal.** Stale paused-rebase abort and stale `.git/*.lock` sweep both run unconditionally at round start, so a user whose IDE was force-killed mid-round doesn't need to know about `cd`-ing into the vault and running `git rebase --abort` by hand.
- **The regenerable graph artifact is resolved by newest content-timestamp, never merged, AI-merged, or prompted.** Local wins ties; the present side wins when the other is missing or corrupt. Reading the timestamp from file content (not the committer date) keeps the implicit reconcile commit from skewing the pick.

## Shared Behavior

- **Standard host lock primitive** (file with PID + mtime, polling acquisition with timeout, stale-reclaim watcher, PID-checked release). Used by the reconciliation mutex, the per-vault write lock, and the source-repo queue worker locks. Acquisition is non-blocking on miss when `timeoutMs: 0`; otherwise it polls. Release only succeeds when the holder's PID matches.
- **Async heartbeat to defeat the stale-reclaim watcher on long holds.** Both the reconciliation mutex and the per-vault write lock are bumped on a 60-second cadence whenever held across a slow operation (well below the 5-minute reclaim threshold).
- **Owned-path classifier** — see Phase 8a above. Other surfaces (the queue worker that produces vault writes; the storage layer) may consult this classifier; it has no instance state.
- **Aggregate-file deterministic merge** — see Phase 7 Tier 1.5 and Data Contracts. The same merge functions are referenced by the bootstrap-merge sub-flow (separate spec) but the merge itself is shared.
- **API key parsing and tenant origin resolution** — see the auth and tenant-resolution specs. The reconciliation round consumes the resolved base URL via a backend client boundary.
- **Vault marker write/verify** — used by both the reconciliation round and the bootstrap-merge sub-flow. The verification predicate (URL normalization rules, case-folded hosts, `.git` suffix trim, user-info strip) is shared.
- **Commit message format** — `[product-tag] <op>: <summary>` is parsed identically by the backend mirror that reads the orphan history; format changes require a coordinated change on the backend.
- **Per-clone exclude file** — append-once semantics, used by both the corrupt-JSON quarantine and any future engine-owned ephemeral directories.
- **The cross-repo pending-workers registry** — produced by source-repo queue workers that timed out waiting for the per-vault write lock; consumed (drained + re-spawn callback) by the reconciliation round on completion.
