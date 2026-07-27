# 161. Vault Identity Marker

## Topic Statement
Prove that a given local working tree is the sync engine's own clone of the current personal-space repository before any reconciliation round writes to it.

## Scope

**In scope:**
- The on-disk identity marker document kept inside the local working tree's internal control directory.
- When the marker is created, when it is rewritten, and when it is silently backfilled.
- The two-layer pre-write guard (marker contents plus the live remote URL recorded in the working tree's git configuration) and the verdict produced for each combination of inputs.
- The URL normalization rules used to compare the marker's stored URL, the live remote URL, and the freshly minted credentials' URL.
- The forward-compatible parse rules that distinguish "marker missing or unusable" from "marker present, slightly old format".
- The set of outcomes the guard returns to the reconciliation round and which outcomes the round may auto-recover from.

**Out of scope (boundaries):**
- The reconciliation round that calls the guard, its phase ordering, and how `vault_mismatch` propagates to the status bar (spec 150). Only the contract observed at the call boundary is described here.
- The on-disk layout of the personal-space working tree (spec 151). Only the placement of the marker file is described here; the rest of the layout is opaque.
- The source-repo identity computation used to choose subdirectory names inside the personal space — that uses a similar-but-distinct URL normalization rule for a different purpose and never reads or writes this marker.
- The credential-minting flow that produces the per-round credentials.
- The askpass / token-injection mechanism used to pass authentication into git commands.
- Recovery actions taken after a `vault_mismatch` verdict (reselecting the working-tree folder is user-driven; the engine's only response is to refuse to write).

## Data Contracts

### Marker file placement
A single document at a fixed relative path inside the working tree's internal git control directory (i.e., the directory git uses for refs, config, and metadata — never the visible working tree). Key consequences of this placement:

- The marker is **never** included in any tracked branch, never committed, never pushed, never pulled, and is not affected by pull-rebase, fetch, or push.
- A foreign git repository (a directory the user might select by mistake) will not carry it.
- A working tree that was once a vault and was then deleted and recloned will not carry it until the engine writes it again.

### Marker document shape
A small JSON document with these fields:

- A fixed **kind** string identifying the document as a personal-space identity marker. Any other value (or absence) means "not a marker, treat as missing".
- A **schema version** integer. Only one accepted value at present; any other value means "not a marker, treat as missing".
- A **created-at** timestamp in ISO-8601. Informational only; never used for verification or comparison.
- A **normalized expected remote URL**. This is the only field that gates verification.
- A **canonical user/repo full name** assigned by the backend (e.g. `<vault-org>/<user-slug>`). Informational only.
- A **default branch name** as declared by the backend at write time. Informational only.

When the file is read, the kind and version fields gate acceptance; an empty or absent **normalized expected remote URL** also fails the gate. The three informational fields (created-at, full name, default branch) are coerced to empty strings if missing or non-string — a partial marker written by a future/older variant is still accepted as long as the URL gate holds. The marker file is written with a trailing newline and pretty-printed.

### Freshly minted credentials (input to the guard)
For each reconciliation round the guard receives the just-minted credentials, which include the URL the credentials authorize, the canonical user/repo full name, and the backend-declared default branch. The guard compares only the URL; the other two are echoed into the marker on writes but never participate in verification.

### Live remote URL (input to the guard)
The URL recorded as the working tree's primary remote in its local git configuration, read directly from disk. The value may be `null` (no remote configured at all). The token segment that the engine injects when running git commands may or may not be present in the stored value — comparison must succeed either way.

### Verdicts
The verification predicate returns one of:

- **ok** — the round may proceed to write.
- **ok with "needs rewrite"** — the round may proceed to write **and** must rewrite the marker in its canonical form before the next round.
- **missing marker** — the marker file is absent, malformed, of the wrong kind, of the wrong version, or carries no usable URL. Carries a human-readable message naming the working-tree folder.
- **url mismatch** — the marker's URL or the live remote URL or both fail to equal the credentials' URL after normalization, or no remote is configured at all. Carries a human-readable message naming the disagreeing URLs.

## Behavior

### URL normalization predicate
A pure function that maps any URL string to a canonical comparison form. It is the only operation used to compare two URLs for "same personal-space repository":

1. Trim surrounding whitespace.
2. If the input matches the shape `https://[user-info@]host/path` (case-insensitive on the scheme), continue; otherwise return the trimmed input unchanged. Non-HTTPS forms are out of scope for the personal-space surface; treating them as opaque means the comparison degrades to exact-match equality, which still rejects an unexpected URL safely.
3. Strip any `user[:password]@` segment between scheme and host. The engine routinely injects a synthetic user-info segment when authenticating git commands, so the stored value and the live remote may differ only in that segment.
4. Lowercase the scheme.
5. Lowercase the host (always).
6. If the path ends in `.git` (case-insensitively), strip that suffix.
7. Drop a single trailing slash, if present.
8. If the host is on a fixed allowlist of **case-insensitive-path hosts** (the three common public forges whose owner/repo namespace is case-insensitive at the platform level), lowercase the path component as well. For any other host, preserve the path's case verbatim — self-hosted forges on case-sensitive filesystems exist and a path-rename there should not silently collapse to the same identity.
9. Concatenate scheme + host + path (no trailing slash) and return.

This predicate is idempotent: applying it twice yields the same result as applying it once.

### Writing the marker
The marker write is invoked unconditionally after every successful clone or in-place init, and again whenever the verification path discovers an acceptable-but-older format (see "rewrite for canonicalization" below).

The write:
1. Ensures the working tree's internal git control directory exists (it always should after clone or init; the create is tolerant of "already exists").
2. Constructs the marker document with the fixed kind/version, the current timestamp, the credentials' URL passed through the normalization predicate, and the credentials' canonical full name and default branch verbatim.
3. Writes the document atomically replacing any prior content with a trailing newline.

The write is fully idempotent across rounds: re-writing with the same credentials produces a document that differs only in the informational created-at field. Re-writing is the recovery mechanism — there is no "delete the marker" path the engine exercises.

### Reading the marker
The read predicate returns either a parsed marker or "absent/unusable", treating all of the following as the same outcome:

- The file does not exist.
- Any read error (permission denied, I/O error, etc.).
- The file is not valid JSON.
- The parsed document's kind field is anything other than the fixed kind string.
- The parsed document's version is anything other than the single supported version.
- The parsed document's URL field is missing, non-string, or empty.

When the predicate succeeds, missing or non-string informational fields are coerced to empty strings; only the URL gate is load-bearing.

### Verification predicate (the two-layer guard)
Inputs: the working-tree root, the live remote URL (possibly `null`), and the freshly minted credentials.

1. Read the marker. If it is absent/unusable, return **missing marker** with a message naming the working-tree folder.
2. Otherwise, compute three normalized URLs:
   - The **expected** URL — credentials' URL through the normalization predicate.
   - The **stored** URL — marker's URL through the normalization predicate. (The marker's URL was stored already-normalized; re-normalizing on read tolerates a marker written by an older client whose normalization rules were less strict — without this, every existing install would terminally fail the next round after a normalization rule was tightened.)
   - The **live** URL — the working tree's recorded remote URL through the normalization predicate, computed only if the live URL is not `null`.
3. If the stored URL after re-normalization is not equal to the expected URL, return **url mismatch** with a message naming both URLs ("vault marker remembers X but credentials point at Y").
4. Determine whether the marker needs rewriting: true if and only if the marker's stored URL is not byte-equal to its own re-normalized form (i.e., the stored value used a stale normalization). Otherwise false. This flag tells the round to overwrite the marker once in the canonical form so subsequent rounds take the byte-equality fast path and the legacy form does not re-trigger the same branch on every round.
5. If the live URL is `null`, return **url mismatch** with a message indicating no remote remote is configured ("vault at <folder> has no origin remote configured"). A real personal-space working tree always has a remote; its absence is treated as a strong negative signal, equivalent to a foreign URL.
6. If the live URL (normalized) is not equal to the expected URL, return **url mismatch** with a message naming both URLs ("vault origin remote is X but credentials point at Y").
7. Otherwise return **ok**, with the "needs rewrite" flag attached when set.

Both the stored URL and the live URL must agree with the credentials. Comparing only one would let a stale marker (origin re-pointed after the marker was written) or a copied marker (foreign repo whose owner placed a stray marker file) slip through.

### Caller-side response to verdicts (at the boundary with the reconciliation round)
Documented here only because the recovery branches are part of the marker's contract; the round itself is specified elsewhere.

1. **ok (no rewrite flag)** — proceed to write.
2. **ok (with rewrite flag)** — log an info-level "rewriting in canonical form" line, invoke the marker write once, then proceed.
3. **missing marker, but the live remote URL is present and normalizes equal to the credentials' URL** — this is the legitimate upgrade case where the working tree was bound before the marker mechanism existed. Log an info-level "backfilling missing marker" line, invoke the marker write, then proceed. (The marker write is the only state mutation needed; no fetch, no rewrite of the remote, no re-clone.)
4. **missing marker, live URL absent or disagreeing** — terminal `vault_mismatch`. Do not retry, do not re-mint credentials, do not write. The user must reselect the working-tree folder.
5. **url mismatch (any sub-reason)** — terminal `vault_mismatch`. Same treatment as the above.

### When the marker is written (timeline)
Across the full lifecycle of a working tree, the marker is written exactly at these points:

- After a cold-start clone succeeds (the working tree did not exist before the round).
- After an in-place init succeeds (the working tree existed with content but no internal git directory, so the engine ran a git init plus remote-add plus fetch).
- During a steady-state round, when the verification predicate returns "ok" with the rewrite flag (an older-format marker is being migrated to canonical form).
- During a steady-state round, when the verification predicate returns "missing marker" but the live remote URL matches the credentials (a pre-marker working tree is being backfilled).

The marker is **not** written:
- On every round (only the four cases above).
- On rounds where the verdict is "ok" with no rewrite flag.
- On rounds where the verdict is a mismatch (the round refuses to write at all, including the marker).
- When the engine returns a transient or terminal error before reaching the clone/init/verify points.

### When the verification predicate is called (timeline)
Once per reconciliation round, at the start of the clone-or-fetch phase, **only on the steady-state branch** where the working tree already exists with an internal git directory. The cold-start clone branch and the in-place init branch skip verification (there is nothing to verify against — they write the marker as part of the same step). All four "when written" points above also write the marker at the end of their respective branch.

The verification predicate is **never** re-invoked within the same round after a write; the round trusts the just-written marker and proceeds.

## State Transitions

A working-tree folder is in one of the following states with respect to the marker:

1. **Unbound (no working tree)** → after cold-start clone → **Bound (canonical marker)**.
2. **Pre-existing content, no internal git directory** → after in-place init → **Bound (canonical marker)**.
3. **Bound (canonical marker)** → next round verifies and proceeds → **Bound (canonical marker)**.
4. **Bound (older-format marker), live remote matches credentials** → next round verifies, marker is rewritten in canonical form → **Bound (canonical marker)**.
5. **Bound (no marker, live remote matches credentials)** → next round verifies, marker is backfilled → **Bound (canonical marker)**. (Pre-marker working trees migrate transparently on first round.)
6. **Bound (marker URL or live URL disagrees with credentials)** → next round verifies, returns `vault_mismatch`, no write occurs → **Frozen until user intervention**.

States 3, 4, and 5 are normal steady-state outcomes; the user does not see them. State 6 is the only failure state the user must act on.

## Notable Behavior

- **The marker lives inside the internal git control directory on purpose.** Putting it in the working tree would let it leak into commits, push to the personal-space remote, and pull back to other devices — at which point a marker would no longer prove ownership because every device's vault would carry every other device's marker. The control directory is local-only and never replicated by git itself.

- **The marker is necessary but not sufficient.** A stray marker copied into a foreign repository, or a marker that stayed in place after the user pointed the local remote at a different URL, both pass the marker-presence check. The live-remote-URL crosscheck closes both holes.

- **The live-remote check is necessary but not sufficient.** A user who happens to clone the same personal-space URL by hand (e.g., to inspect it) would have a matching remote URL but no marker; without the marker the engine could write to that out-of-band working tree. The marker-presence check closes that hole.

- **The two-layer combination is intentionally over-strict.** It rejects a small number of legitimate-but-confused setups (a vault folder whose internal git dir was deleted and recreated by hand, a vault whose remote was re-pointed during maintenance) by design. Auto-recovery from a mismatch would defeat the purpose — the whole point is to refuse to write into anything the engine cannot prove is its own clone.

- **Mismatch is terminal, not transient.** A `vault_mismatch` does not retry, does not re-mint credentials, does not back off. Retrying would just keep failing for the same reason. The status surface advertises it as a red "sync failed" state with a stable error code so the user can be told to reselect the working-tree folder.

- **Missing-marker plus matching live URL is the only auto-recovered mismatch.** This branch exists exclusively to upgrade pre-marker installs without forcing a re-clone. It is not a fallback for "marker corrupted on disk" — a corrupt marker reads as absent, the live URL still has to match, and the marker is recreated from the credentials. A corrupt marker plus a non-matching live URL is terminal, the same as any other mismatch.

- **The marker's URL is stored already-normalized, but the verifier re-normalizes on read.** This is asymmetric on purpose: when the normalization rules tighten in a future version (e.g., a new host added to the case-insensitive-path allowlist), every existing canonical-at-write-time marker becomes non-canonical-at-read-time. Re-normalizing on read means those markers continue to verify; the `needsRewrite` flag then causes a one-time migration to the new canonical form. Without re-normalization, every install would terminally fail the next round after every normalization tweak.

- **The "needs rewrite" rewrite happens before the round proceeds, not asynchronously.** A subsequent round failure before the rewrite would leave the legacy form on disk and trigger the same "ok with rewrite" branch again — harmless but wasteful. Performing the rewrite eagerly bounds the migration to a single round per install.

- **Informational fields can drift across rounds.** The created-at timestamp moves on every rewrite/backfill. The full name and default branch reflect whatever the credentials said at the last write, which can change if the backend renames the personal-space repo. Verification does not consult any of these, so drift is harmless.

- **Forward-compatible field tolerance.** The reader tolerates a marker that omits any of the three informational fields (older or alternative writers), as long as the kind, version, and URL gates hold. Unknown future fields would also be tolerated (the reader extracts only the fields it knows). The on-disk schema can therefore grow without bumping the version number, as long as the existing fields remain populated and meaning-preserving.

- **The case-insensitive-path host allowlist is a fixed list, not a heuristic.** Only three public forges are listed. Self-hosted forges (which may run on case-sensitive filesystems) preserve path case, on the conservative assumption that two paths differing only in case are different repositories until proven otherwise.

- **No origin remote is treated as a mismatch, not as a missing-data branch.** A working tree that was once a vault and had its remote deleted is in an inconsistent state the engine cannot safely write into; conflating "no remote" with "wrong remote" simplifies the verdict surface and yields a single terminal outcome.

- **Two distinct URL normalization rules coexist in the wider system.** The one specified here is used to compare a personal-space remote against itself across artifacts (marker, live config, credentials). A separate, similar-but-stricter normalization is used to compute source-repository identities for naming subdirectories within the personal-space (boundary: spec 151). The two never share input or output; the marker's predicate is the only one observable at this topic's boundary.

## Shared Behavior

- **Sync engine reconciliation cycle (spec 150)** — owns the round phase ordering that calls this guard, the `vault_mismatch` terminal error code, and the propagation of the verdict's human-readable message to the status surface. The guard's contract is described here; its placement within the round is described in spec 150.
- **Memory Bank folder layout (spec 151)** — describes the on-disk layout of the personal-space working tree at large. The marker file's placement inside the local-only internal git control directory is owned by this spec; the rest of the working-tree contents are owned by spec 151.
