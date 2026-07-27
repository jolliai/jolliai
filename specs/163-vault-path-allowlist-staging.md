# 163. Vault Path Allowlist Staging

## Topic Statement

Stage exactly the vault paths whose lexical shape matches a closed catalogue of engine-owned content, with every other dirty path routed to a no-commit telemetry bucket so that nothing the catalogue does not recognize is ever committed or deleted from the shared remote.

## Scope

**In scope:**

- The per-path classification pass that maps every dirty vault path to one of a fixed kind-catalogue or to `null`.
- The per-kind staging policy: which kinds are added, which kinds are removed, which kind is gated by the transcript opt-in, which kinds are treated as canaries.
- The decomposition of porcelain status entries (additions, modifications, deletions, renames, copies, untracked, ignored, unmerged) into independent per-side operations before classification.
- The user-facing transcript opt-in flag and its consequence for both pre-existing tracked transcripts and brand-new ones.
- The on-disk symlink defence that runs only on the add side and refuses to stage when either the leaf or any parent segment is a symlink.
- The strict rule that classifier-rejected paths with a pre-existing staged change against HEAD are reverted in the index — not unstaged with a deletion — so the round commits nothing for that path without erasing it from peers.
- The two-tier canary surface: a quieter "unowned" log channel for paths that fail the catalogue, a louder "symlinked" log channel for security-relevant placements.
- The per-round structured report consumed by the sync engine as telemetry, including per-kind counts and capped path samples.
- The handling of the catch-all "user-content" fallthrough kind for paths that pass per-segment safety but match no specific catalogue entry.
- The defensive drop of unmerged entries with a warning and the rationale (caller-side conflict resolution must run first).

**Out of scope (boundaries — what is sent/received but not re-specified here):**

- The end-to-end sync reconciliation round that owns the four invocation sites at which this staging step runs (covered by spec 150 — sync engine reconciliation cycle). This spec describes only the staging step itself.
- The on-disk folder layout that determines which lexical shapes the catalogue recognizes — the parent folder, per-repository hidden layer, per-branch visible layer (covered by spec 151 — memory bank folder layout). This spec consumes that layout; it does not define it.
- The write-time symlink guard that protects the file-writer side of the same vault from creating files under a symlinked ancestor (covered by spec 164 — vault symlink safety guard). This spec covers staging-time detection only; spec 164 covers the parallel write-time check that uses the same path-chain primitive.
- The conflict-resolution pipeline that runs before this staging step and resolves any unmerged entries (covered by the sync engine reconciliation cycle).
- The corrupt-JSON quarantine that may move malformed payloads into a quarantine subdirectory before the round reaches the staging step (the quarantine subdirectory is one of the intentionally-unowned shapes documented inline here).
- The bootstrap-merge stash directory whose surviving entries are the most common content of the "unowned" canary bucket (covered by the bootstrap-merge spec). This spec only references it as an example of legitimately-unowned content.
- The legacy migration import that drops user content at root paths the catalogue intentionally classifies as the catch-all "user-content" kind (covered by the legacy migration spec).
- The transcript opt-in setting's storage, UI, and runtime read path (the round invocation supplies the boolean as a parameter; how the user toggled it is owned by the configuration spec).
- The deny-all `.gitignore` template that determines whether brand-new owned files surface as "ignored" or "untracked" in the porcelain output (covered by the memory bank folder layout). This spec consumes both shapes equivalently.
- The structured-log channel routing (info vs. warn vs. console suppression) is a property of the platform logger; this spec describes only the severity each canary signal is emitted at.
- The downstream consumer of the per-round report — the sync engine folds it into a per-round canary surface bounded by a path-list cap (covered by spec 150).

## Data Contracts

### Per-round input

The staging step consumes:

- A bound git client for the vault working tree.
- An absolute path to the vault working tree root.
- A single boolean: **"sync transcripts"**.

The boolean is the only round-level configuration. Everything else the staging step needs (the porcelain snapshot, the classification rules) is derived from the bound client and from the closed catalogue.

### Porcelain snapshot

The staging step takes a fresh snapshot of the vault working tree at entry: every record from the standard porcelain output, including ignored entries. Each record carries:

- An index-side status code (one of: added, modified, deleted, renamed, copied, untracked, ignored, unmerged, type-changed, or a space meaning "no index-side change").
- A worktree-side status code from the same closed set.
- The reported path (the destination path for rename / copy entries).
- For rename / copy entries only, a separate source path (the "from" side of the move or copy).

Records the caller has not normalized (length too short, status bytes the parser does not recognize) are silently dropped — the staging step does not crash a round on an unfamiliar shape.

### Closed catalogue of kinds

The classifier returns exactly one of these tags for any path it recognizes, or null:

**Root-level (exactly two):**

- Root-level gitignore document.
- Root-level repository-identity registry.

**Per-repository hidden-layer aggregates (one tag per file):**

- Per-repo configuration (identity).
- Per-repo content index.
- Per-repo manifest.
- Per-repo branches list.
- Per-repo catalog.
- Per-repo migration state.

**Per-repository hidden-layer content directories (one tag per directory):**

- Per-repo summaries (filename grammar: 7–64 hex-character content hash with the `.json` extension).
- Per-repo transcripts (same hash grammar; gated by the transcript opt-in).
- Per-repo plans (slug grammar with the `.md` extension).
- Per-repo plan progress (same slug grammar with `.json`).
- Per-repo notes (same slug grammar with `.md`).
- Per-repo knowledge-graph data (a single regenerable file at `graph/graph.json`; only that exact leaf name classifies — any other leaf under the graph directory stays null so the canary keeps its strictness). The allow-list permits exactly `.jolli/graph/graph.json`.

**Per-repository visible-layer (per-branch markdown):**

- Visible summary (filename ends with a dash-separated 8-character hex prefix and `.md`).
- Visible plan (filename starts with the literal "plan--" prefix and ends with `.md`).
- Visible note (filename starts with the literal "note--" prefix and ends with `.md`).

**Catch-all:**

- User content — any path that passes every structural and per-segment safety check but does not match any of the shapes above.

### Per-segment safety policy

Every variable segment (repository folder, branch folder, plan / note id) is required to:

- Be non-empty.
- Not start with `.` (no hidden files / directories).
- Not start with `-` (so the name cannot be mis-interpreted as a CLI flag downstream).
- Not start with whitespace.
- Not contain a `..` substring (path-traversal defence, redundant with the explicit structural reject below for defence-in-depth).
- Not contain ASCII control characters (0x00–0x1F or 0x7F).
- Not contain a forward slash (the segment splitter) or backslash (POSIX-only contract).
- Be no longer than 200 characters.
- Not end with `.`, `-`, or whitespace.

This is intentionally permissive on non-ASCII letters and on punctuation real branch / remote names regularly contain (spaces, parens, plus signs, hashes, ampersands, quotes). A pre-relaxation strict-ASCII grammar produced false-positive canaries for such names and masked real security signals.

### Structural rejects (apply to every path before the catalogue)

- Empty string.
- Leading `/` or leading `./`.
- Contains `..`.
- Contains a backslash.

Any of these conditions short-circuits the classifier to `null` before any per-segment check runs.

### Special-cased reject (defence-in-depth)

The leaf filename `shadow-status.json` is classified as `null` regardless of where it appears, even when the path otherwise passes every other check. The catalogue intentionally omits a kind for this filename: it is per-device dirty-write recovery state and must never reach the shared remote.

### Per-round output report

The staging step returns one structured record:

- A count of paths actually staged for addition.
- A count of paths actually staged for removal.
- A count of paths skipped because the kind was transcript and the opt-in was off.
- An ordered list of paths the classifier returned `null` for (the "unowned" canary list).
- An ordered list of paths blocked from staging because of a symlink at the leaf or in the path chain (the "symlinked" canary list).
- A per-kind count map keyed by every kind plus three pseudo-kinds: `unowned`, `skipped` (transcript-off), and `symlink-blocked`. The pseudo-kinds are present so totals reconcile against the number of decomposed operations.

The two list fields carry the full per-round contents (not a cap); a downstream consumer that wants to bound them imposes its own cap.

## Behavior

### Entry: snapshot then decompose

The staging step takes a fresh porcelain snapshot of the vault working tree (including ignored entries) and decomposes it into a flat per-operation stream before doing any classification or staging. The decomposition rules:

1. **Unmerged on either side** (the unmerged status appearing in the index slot OR the worktree slot, including asymmetric combinations like deleted-by-us / unmerged-by-them and added-by-us / unmerged-by-them) — drop the entry with a warning. The decomposition asserts that the caller's conflict resolver ran first; a defensive drop is safer than committing a conflict-marker payload.
2. **Rename** — emit two independent operations: a deletion for the source path (with `staged = true`, because rename presupposes the source was tracked) and an addition for the destination path. Each side is classified independently, so a rename from an owned location to an unowned one stages the deletion but skips the addition, and vice versa.
3. **Copy** — emit only an addition for the destination path. The source remains live in the working tree (this is the definition of copy versus rename); emitting a deletion for it would `git rm` a still-present file. The source either remains tracked-and-unchanged (no porcelain entry) or surfaces as its own independent entry in this same snapshot.
4. **Pure deletion** (deleted on either side, no rename pairing) — emit one deletion operation.
5. **Everything else** (added, modified, untracked, ignored, type-changed) — emit one addition operation.

Each operation carries a per-op `staged` flag: true when the index-side status is one of added / modified / deleted / renamed / copied; false otherwise (space, untracked, ignored). The flag drives whether a classifier-reject schedules an index revert (see below).

### Per-operation classification

For each decomposed operation, the staging step calls the pure classifier on the operation's path. The classifier:

1. Applies the structural rejects. Any match → return `null` immediately.
2. Tries the strict catalogue: root-level aggregates, then per-repository hidden-layer aggregates and content directories, then per-repository visible-layer markdown. Each shape is matched against an exact lexical grammar — generic length / extension matches are intentionally not used. A loose match would degrade the canary into noise.
3. Falls through to the catch-all: if every segment passes the per-segment safety policy and the path is not specifically rejected (no `shadow-status.json` leaf), return the catch-all "user content" kind.

The classifier is a pure function. It does not touch disk and is not parameterized by any storage instance; this is a load-bearing property because the storage layer's construction has side effects (creates directories, writes a stub configuration) that must not run during round setup.

### Per-kind routing

Each decomposed operation, after classification, follows one of these routes:

1. **Classifier returned `null` (`unowned`):**
   - Record the path in the per-round `unowned` list.
   - Increment the `unowned` bucket in the per-kind counts.
   - If the operation's `staged` flag is true, schedule the path for an **index-to-HEAD revert** (so the upcoming commit carries nothing for this path, but no deletion is staged for HEAD-tracked content). Do **not** schedule a `--cached` removal. (See "Notable Behavior" — this routing decision is load-bearing.)
   - Continue to the next operation.

2. **Kind is transcript AND the round's "sync transcripts" boolean is false:**
   - Increment the `skipped` bucket in the per-kind counts and the top-level skipped count.
   - If the operation's `staged` flag is true, schedule the path for an index-to-HEAD revert (so a transcript with a staged change against HEAD from a prior on-state, an external `git add`, or an interrupted prior round does not slip into the round's commit).
   - Continue to the next operation.

3. **Operation kind is "del" (a pure or rename-source deletion):**
   - Add the path to the deletions batch.
   - Increment the classified-kind bucket in the per-kind counts.
   - Continue to the next operation. (No symlink check applies to deletions — `git rm` does not dereference; it only removes the index entry and the file, so there is no traversal risk on the rm path.)

4. **Operation kind is "add" (any addition, including rename-destination):**
   - Run the **add-side symlink check** (see next subsection).
   - If the check fails, record the path in the per-round `symlinked` list, increment the `symlink-blocked` bucket, schedule the path for an index-to-HEAD revert if `staged` is true, and continue.
   - If the check passes, add the path to the additions batch and increment the classified-kind bucket.

### Add-side symlink check

For every add-side operation whose classification is non-null and (for transcripts) gated by an on opt-in, the staging step verifies both the leaf and the path chain are symlink-free before staging:

1. **Leaf check** — stat the absolute path (the vault root joined with the relative path) without following symlinks. If the leaf is a symbolic link, the check fails.
2. **Path-chain check** — walk every intermediate segment from the vault root down to the leaf's parent, statting each without following symlinks. If any intermediate is a symbolic link, the check fails.

Both halves run on every add operation that reaches them. The check fails open (returns "not safe") on any thrown error from the path checks, with one inlined sub-case:

- **The path no longer exists** (the stat returns the no-such-file errno) — treat as "not safe" without surfacing a warning. The file disappeared between the porcelain snapshot and the symlink check; staging it would fail anyway, and the disappearance is recoverable on the next round if the file reappears.
- **Any other stat error** (permission denied, I/O failure, etc.) — warn-log the failure and treat as "not safe". A stat permission failure is interpreted as "cannot verify safety, refuse to stage" rather than risking a hostile placement.

The symlink check is intentionally not applied to:

- Pure deletions / rename-source deletions (the rm path does not dereference).
- Classifier-rejected adds (they are routed to the unowned canary before the symlink check would even run).
- Transcript-off skipped adds (same — the route returns before the check).

### Batched git calls at the end

After every operation has been routed, the staging step issues at most three batched git calls — in this order, each one conditional on its batch being non-empty:

1. **Force-add the additions batch.** The `-f` flag overrides the post-allowlist `.gitignore`'s catch-all deny rule; the classifier is the staging authority, not gitignore.
2. **Remove the deletions batch.** The remove call uses an "ignore unmatched paths" mode so a path the snapshot reported as deleted but that vanished between snapshot and the call does not fail the round.
3. **Revert the index-revert batch to HEAD.** This routes every classifier-rejected, transcript-skipped, and symlink-blocked already-staged path through an "index-revert-to-HEAD" git call — which restores the HEAD blob in the index for HEAD-tracked paths and drops the index entry entirely for index-only adds. The round's subsequent commit (which has no pathspec and commits the whole index) therefore carries nothing for these paths, and no deletion is staged or pushed.

The staging step explicitly does **not** use `--cached`-style index removal from this code path. (See "Notable Behavior" — this is a load-bearing invariant; a regression test specifically pins it.)

### Per-round logging

After all batched calls succeed, the staging step emits structured logs in this order:

1. **Unowned canary line** (only if the unowned list is non-empty) — at the quieter `info` severity. Names the path count and the first five sample paths. This severity is load-bearing: the line lands in the platform's persistent log for grep-based drift watching but stays off the user-facing terminal under the default silent-console mode. The unowned bucket legitimately fills with engine-internal content that is intentionally never staged (bootstrap-merge stash survivors, quarantine subdirectories, pre-allowlist legacy files), so surfacing it on the terminal would print "drift or foreign writer" during every routine sync round.

2. **Symlinked canary line** (only if the symlinked list is non-empty) — at the louder `warn` severity. Names the path count and the first five sample paths and explicitly flags the placement as potentially hostile. This severity is also load-bearing: a symbolic link at a classifier-matching location may be a hostile placement (e.g. a link at the per-repo identity file pointing to the user's cloud credentials), and the operator must see it on the terminal immediately rather than only in the log file.

3. **Telemetry line** at the quieter severity — names the added / removed / reverted / skipped / unowned / symlinked counts.

### Per-round return

The staging step returns the structured report (counts plus the two canary path lists plus the per-kind count map). The step throws only on:

- A propagated failure from the porcelain snapshot call.
- A propagated failure from one of the three batched git calls (these are real bugs — the classifier said the path is owned and on disk, but git rejected the stage).

A classifier mismatch, a symlink, or a missing file never throws. They route into the appropriate canary or skip path.

## State Transitions

The staging step is stateless across calls. Each call:

- Reads a fresh porcelain snapshot of the vault working tree.
- Reads the current on-disk state of each add-side operation's leaf and ancestors via per-operation stats.
- Mutates the git index via at most three batched calls.
- Returns one report record.
- Holds no in-memory state between calls.

The within-call state is the four accumulators (additions batch, deletions batch, index-revert batch, two canary lists) plus the per-kind count map. All are scoped to one invocation and discarded on return.

The downstream sync round folds the per-round report into a per-round canary surface that survives the round; the staging step itself does not.

## Notable Behavior

- **The staging step replaces the previous `git add --all` regime entirely.** A pre-refactor implementation passed every dirty path through to git; the current step funnels every path through the closed catalogue first. The catalogue is the authority; gitignore is the second line of defence (and the `-f` flag on the additions batch deliberately overrides it).

- **The classifier is a pure function and not a method on the storage layer.** Putting it on the storage interface would force the round to construct a storage instance during context build, and the storage layer's construction has side effects (creates directories, writes a stub configuration). The pure-function form sidesteps that ordering trap.

- **Classifier-rejected paths with a staged change against HEAD are reverted in the index, never `--cached`-unstaged.** This is the load-bearing invariant of the whole staging step. A previous implementation routed unowned-with-staged paths through `--cached` removal — which for HEAD-tracked paths stages a deletion that the round's commit-then-push propagates to every peer. This silently erased from the shared remote any legacy-tracked file the new catalogue did not recognize (older engine layouts, leading-dot configuration directories, root-level files). The index-revert-to-HEAD route preserves the HEAD blob for tracked content and drops the index entry only for index-only adds; either way the round commits nothing for the path and nothing reaches the remote. A regression test specifically pins this — any future code that reintroduces `--cached`-style unstaging from this step must explicitly rewrite that test. (Surprising; load-bearing; data-loss avoidance.)

- **The transcript opt-in is passive when off.** Off means "this device does not upload new transcripts"; it does NOT mean "delete what other devices already uploaded". A transcript that is already on the remote (and therefore tracked locally) must survive a round with transcripts off untouched, and a transcript with a staged change against HEAD from a prior on-state must be reverted in the index — not staged as a deletion. The two behaviors together preserve the round's privacy contract: turning the opt-in off privatises future writes but never withdraws prior peer uploads. (Surprising; load-bearing.)

- **The symlink defence applies to add operations only, not deletions.** Deletions go through the `git rm` path, which removes the index entry and the file without dereferencing the working-tree symlink. There is no traversal risk on the rm path, so the symlink check there would be pure overhead.

- **Both the leaf and the path chain are checked.** A symlink at the leaf is the "hostile file replacement" pattern (e.g. a link at the per-repo identity file pointing to the user's credentials). A symlink in the path chain is the "hostile intermediate directory" pattern (e.g. the per-repo hidden directory linked to a system directory). Either is enough to refuse the stage.

- **Permission errors on the symlink check refuse-to-stage (fail closed).** A stat returning permission-denied is treated as "cannot verify safety, refuse to stage" rather than "cannot tell, allow". The opposite policy would let an attacker who can deny the engine read permission to a directory cause it to stage through a symlink.

- **Missing files between snapshot and check are skipped silently.** The no-such-file errno is the only stat error the symlink check treats as routine; it does not warn-log or escalate, because the file disappeared between the porcelain snapshot and the stat, the upcoming `git add` would fail anyway, and the file may reappear on the next round.

- **The unowned canary lands in the persistent log at info severity, not warn.** This is load-bearing for the user experience: warn-severity reaches the user-facing terminal under the platform logger's default silent-console policy, and the unowned bucket legitimately fills with engine-internal content (bootstrap-merge stash survivors, quarantine subdirectories, pre-allowlist legacy files). Printing a "classifier drift or foreign writer" warning on every routine sync round would read as an error to end users. The info severity keeps the line searchable in the log file for drift-watching but off the terminal. (Surprising; intentional.)

- **The symlinked canary lands at warn severity, always reaching the terminal.** A symbolic link at a catalogue-matching location is potentially hostile; the operator must see it immediately. This is the canary signal the user-facing severity is reserved for.

- **The closed catalogue is by exact lexical shape, not by extension or directory.** A `.json` file in the per-repo summaries directory whose stem is not 7–64 hex characters classifies as `null`, not `summary`. Loose patterns turn the canary into noise; tight patterns make drift loud.

- **The catch-all "user content" kind is intentionally permissive.** Any path that passes structural rejects and per-segment safety but does not match a specific catalogue shape classifies as user content and is staged. This covers (a) user-authored markdown the engine did not write under a repository subdirectory, (b) legacy migration content the backend hands the engine at root paths, and (c) anything a peer device committed that this device has not seen before. The strict `unowned` canary is reserved for paths that fail safety (path traversal, backslash, leading dot or dash, control characters) — those still surface as drift signals.

- **The `shadow-status.json` leaf is rejected even at "safe" placements.** Per-device dirty-write recovery state must never reach the remote regardless of where it lands. The catalogue's `shadow-status.json` reject works in tandem with a separate untrack-on-rounds cleanup that catches legacy committed copies; the redundancy is deliberate. The catch-all "user content" path also explicitly re-checks the leaf name so a future relaxation of the per-segment policy that allowed leading dots would not accidentally start syncing this state.

- **Per-segment safety rejects leading whitespace, leading dash, and leading dot, but accepts non-ASCII letters and most punctuation.** Real git remote and branch names regularly contain spaces, parens, plus signs, hashes, and ampersands; pre-relaxation a strict ASCII-only grammar fired false-positive `unowned` canaries for such names and masked real security signals. Names that the OS subsequently rejects (very long, reserved Windows names) fail loudly on the `git add` call — the classifier deliberately does not second-guess the filesystem.

- **The catalogue includes ordinary "user content" but the round-completion canary surface clamps the two canary lists at a small cap.** Both the unowned list and the symlinked list returned from this step are uncapped; the sync engine round driver applies a small cap when folding them into the per-round result so the eventual round-result log lines stay small. (See the sync engine reconciliation spec for the cap value.)

- **Renames split independently.** A rename from an owned location to an unowned location emits a real deletion for the owned source and an `unowned` canary entry for the destination — both surface in this round. A rename from unowned to owned emits an `unowned` canary entry for the source (the source classifies null) and a real addition for the destination. The asymmetry is intentional: the source side is what was tracked, the destination side is what is on disk now, and both must be classified by their own location.

- **Copies do not emit a deletion for the source.** A copy preserves the source in the working tree by definition; emitting a deletion would `git rm` a live file. The source either remains tracked-and-unchanged (no porcelain entry) or surfaces as its own independent entry in the same snapshot.

- **Unmerged entries are dropped defensively with a warning.** The caller's conflict-resolution pipeline is contractually responsible for resolving them before this staging step runs. The defensive drop covers the case where one slipped through; committing a conflict-marker payload would be worse than the drop. The drop catches every asymmetric combination of the unmerged status, not just the symmetric one — a single-side unmerged is enough.

- **The `staged` predicate uses the strict set of "real mutation" index statuses.** A path whose index-side status is space (tracked-unchanged, worktree differs) is NOT considered staged for the purposes of routing, because committing this path with no index entry change would produce no diff anyway. This is load-bearing for the transcript-off path: a remote-tracked transcript that is modified locally surfaces with a space index status and a modified worktree status, and skipping it has no privacy consequence; only the `A`/`M`/`D` index-status case needs the explicit index-revert.

- **Brand-new owned files surface as ignored, not untracked.** The deny-all gitignore template the round writes (`* + !.gitignore`) matches every new file, so the porcelain snapshot taken with the "include ignored" flag reports them as ignored. The decomposition treats ignored entries as plain additions and the classifier admits them on the force-add call. A pre-refactor implementation that ran the porcelain snapshot without the "include ignored" flag would have made every brand-new owned file invisible.

- **Untracked and ignored entries have no index entry to revert.** A new file appearing as untracked or ignored has the `staged` flag false; the unowned / transcript-off / symlinked routing paths will not schedule a revert call for them, so the index-revert batch only ever contains paths with real prior index entries.

- **The per-kind count map's totals reconcile against the decomposed-operations count.** Every operation increments exactly one bucket — a kind, `unowned`, `skipped` (transcript-off), or `symlink-blocked`. The map is intentionally exhaustive so downstream telemetry can sanity-check its arithmetic.

- **The staging step is called from four distinct sites in the round** (auto-reconcile, steady-state, migration, branch-switch preservation — see spec 150). Each site invokes it with the same single-boolean configuration and consumes the same report. The step itself does not branch on which site invoked it.

- **The empty-input fast path is implicit, not explicit.** An empty porcelain snapshot decomposes to no operations, every batch ends empty, every batched call is gated on non-empty, and no log lines are emitted. The return report is all-zero. There is no explicit early-return for clean trees.

## Shared Behavior

- The reconciliation round that owns the four invocation sites at which this staging step runs is defined by spec 150 — sync engine reconciliation cycle. The round folds the per-round canary lists from this step into a per-round canary surface bounded by a path-list cap (defined there).
- The on-disk folder layout that this step's closed catalogue mirrors — the parent folder, the per-repository hidden layer, the per-branch visible layer, the per-repository content directories — is defined by spec 151 — memory bank folder layout.
- The write-time symlink guard that protects the file-writer side of the same vault from creating files under a symlinked ancestor is defined by spec 164 — vault symlink safety guard. The two specs share the path-chain primitive (a from-root no-dereference walk over the ancestors); this spec describes the staging-time use, spec 164 describes the write-time use.
- The conflict-resolution pipeline that resolves unmerged entries before this staging step runs is defined by the sync engine reconciliation cycle (spec 150).
- The transcript opt-in setting's storage, UI surface, and runtime read path are owned by the configuration spec; this step consumes the boolean as a per-round parameter and applies the routing rules described above.
- The deny-all gitignore template that determines whether brand-new owned files surface as ignored or untracked is owned by the memory bank folder layout (spec 151); this step consumes both shapes equivalently.
- The downstream consumer of the per-round report — the sync engine that folds the two canary lists into the round result — is defined by spec 150.
