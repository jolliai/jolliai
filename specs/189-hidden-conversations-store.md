# 189 — Hidden Conversations Store

## Topic Statement

Persist a per-project set of AI conversation identities the user has chosen to remove from the active-conversations list, with snapshot-scoped semantics so the row only stays gone until the conversation accumulates new activity.

## Scope

### In scope

- The shape and location of the persisted set.
- The composite identity used as the set's key.
- Loading, with tolerance for absent, malformed, and version-mismatched stored state.
- Recording a hide, including idempotency and concurrent-writer safety.
- The "still hidden?" predicate that gates filtering on a per-snapshot basis using a stored hide timestamp vs. the conversation's most-recent-activity timestamp.
- Atomic-write and advisory-lock protocol that protects the file against partial writes and racing writers.
- Lock-acquisition wait, stale-lock reclaim, and timeout behavior.
- Failure observability (which conditions produce a log, at what severity, and which stay silent).

### Boundaries (out of scope)

- How conversations are aggregated, sourced, or sorted for display. Cross-reference: active-conversations aggregator spec. The aggregator consumes the loaded state via the "still hidden?" predicate; this store does not call the aggregator.
- How a panel UI presents a single conversation, edits its entries, or detects the empty-after-save condition that triggers hiding. Cross-reference: conversation-overlay store spec. This store receives an externally-decided "hide this identity now" signal; it does not inspect transcripts or overlays.
- Per-entry overlay edits (deletes, replacements) on a single conversation. Cross-reference: conversation-overlay store spec. That store is keyed per conversation; this store is a single list-level index — they are independent persistence surfaces.
- Commit-selection persistence (visually similar but semantically different: that is a per-snapshot UI checkbox set, not a hide list). Cross-reference: commit-exclusion store spec.
- The mechanism for re-showing a hidden conversation by direct user action; the only re-surfacing path this store implements is timestamp-driven (new activity past the hide moment). No explicit "unhide" entry-point exists.
- The exact composition of source identifiers; this store only requires that a source string contains no colon character.

## Data Contracts

### Composite identity (the key)

A flat string formed by joining two components with a single colon:

1. Source — an opaque short identifier for the originating AI agent/tool that produced the conversation.
2. Conversation identifier — opaque string assigned by that source.

Invariant relied on: the source component never contains a colon, so the first colon in the composite is the unambiguous separator. (This is a project-wide convention; the store does not validate it.)

### Persisted state

A single document per project containing:

- A schema version marker (current value: 1).
- A map from composite identity → hide-record.

Each hide-record contains exactly one field:

- A hide-moment timestamp formatted as an ISO-8601 instant string.

Storage location: under the per-project state directory used by the product for non-summary local state. One file per project. The store does not maintain or expose any other files (no per-conversation hide files).

### Map semantics

- The map's key set is the canonical set of currently-hidden identities.
- Iteration order is not part of the contract.
- Keys whose string equals reserved object-property names (e.g. names that would otherwise be inherited from a default object's prototype) MUST be storable and lookupable as ordinary entries without colliding with inherited properties. Implementations may not use property-presence checks that consult an inherited prototype.

### In-memory loaded state

The state surfaced to callers after loading has the same shape as the persisted document. The empty state is the version marker plus a map with no entries; this is the value returned for every failure-to-load condition.

### "Still hidden?" inputs

A separate read-time predicate takes:

- A loaded state.
- A composite identity (source + conversation identifier).
- A conversation last-updated timestamp string (the most-recent-activity moment as the data source reports it).

It returns a boolean.

## Behavior

Behaviors below are listed in the order they execute at runtime.

### B1. Load

1. Attempt to read the project's hidden-conversations document.
2. If the read fails because the document does not exist, return the empty state silently (no log).
3. If the read fails for any other reason (e.g. the path exists but is not a regular file, or is unreadable), log a warning and return the empty state.
4. If the read succeeds, attempt to parse the contents as the persisted document shape.
5. If parsing throws, log a warning and return the empty state.
6. If the parsed schema-version marker is missing or not equal to the current value, log a warning and return the empty state. (No migration is performed.)
7. If the parsed entries field is missing, or is not an object value, log a warning and return the empty state.
8. Otherwise iterate the parsed entries. For each entry whose value is a non-null object with a string-typed hide-moment field, copy that entry into a new entries map built on a no-prototype object. Entries failing this check are silently dropped from the returned state; they are not logged individually.
9. Return a state combining the current version marker with the cleaned entries map.

Notable: the warning-vs-silent split is intentional — file-absent is the legitimate "user has never hidden anything" case and must not produce noise; every other failure leaves the user with no visible hidden set and the warn-level log is the only operator signal that the document was lost.

### B2. Per-entry hide check (low-level)

Predicate "is this identity present in the set?":

1. Form the composite identity.
2. Return whether that key is a (direct, non-inherited) member of the entries map.

This predicate is exposed but is NOT what the aggregator uses to filter; see B3.

### B3. "Still hidden?" predicate (the filter the aggregator calls)

Inputs as defined in Data Contracts.

1. Form the composite identity.
2. If the key is not present in the entries map, return false.
3. Parse the stored hide-moment timestamp string into a numeric epoch.
4. Parse the supplied conversation last-updated timestamp string into a numeric epoch.
5. If the hide-moment parse yields not-a-number, return true. Rationale: a corrupt stored timestamp must not silently un-hide a row the user chose to dismiss.
6. If the supplied last-updated parse yields not-a-number, return true. Rationale: lack of parseable evidence of activity past the hide cannot be treated as evidence of such activity.
7. Otherwise return whether the last-updated epoch is less than OR equal to the hide-moment epoch.

Equality returns true (still hidden). This implements "hide is a per-snapshot dismiss, not a permanent block": the row stays gone until the source reports a strictly newer activity moment, at which point it re-surfaces as a new active conversation. Equal timestamps are treated as the same snapshot the user just dismissed.

### B4. Record a hide

1. Ensure the per-project state directory exists, creating intermediates as needed.
2. Acquire the advisory lock (see B5).
3. Inside the critical section:
   a. Run a fresh Load (B1) of the current state. (The locked region observes the latest on-disk state, not a stale in-memory snapshot.)
   b. Form the composite identity.
   c. Build a new entries map by shallow-merging the current entries with a single new (or replacement) entry for that identity whose hide-moment field is the current wall-clock instant as an ISO-8601 string. The new entries map is constructed on a no-prototype object.
   d. Serialize the new state as pretty-printed JSON (two-space indent).
   e. Write the serialized bytes to a sibling temporary file (path = final path + a fixed temporary suffix).
   f. Atomically rename the temporary file over the final path.
   g. Return the in-memory new state (the value just persisted).
4. Release the lock (see B5, release rules).

Notable:
- Re-hiding an identity is idempotent in terms of set membership but DOES refresh the stored hide-moment to the current instant. Callers depending on the original hide-moment being preserved on re-hide will be surprised.
- A crash between B4.3.e and B4.3.f leaves the previous final file intact; the half-written temporary file is orphaned but does not corrupt the loaded state on next start.
- The return value is the new state including this hide and every previously-hidden identity preserved by step B4.3.a.

### B5. Advisory lock protocol

#### B5.1 Acquire

A sibling lock file (final path + a fixed lock suffix) is used as the exclusion token. The acquire loop:

1. Attempt to create the lock file in exclusive-create mode, with the current process identifier written as its content.
2. If creation succeeds, the lock is held; return.
3. If creation fails with the "already exists" error code, proceed to the stale-check; for any other error code, propagate the error to the caller (the calling Record-a-hide therefore fails loudly rather than silently dropping the hide).
4. Stat the lock file. If statting fails for any reason, immediately retry the loop (yielding to the poll-delay step below). Rationale: the stat may have raced with the holder releasing the lock; the next create-attempt will resolve it.
5. If the lock file's modification time is older than the stale threshold, attempt to unlink it and immediately retry the loop. Errors from this unlink are swallowed; another reclaimer may already have unlinked it, and the next create-attempt will resolve it.
6. If neither stale nor returned, check whether the total elapsed wait has exceeded the acquire-timeout. If so, throw a contention-timeout error that names the lock path and the timeout window.
7. Otherwise sleep for the poll-delay and return to step 1.

Tunable thresholds with these current values:
- Acquire-timeout window: 2 seconds.
- Stale-lock age threshold: 10 seconds.
- Poll-delay between attempts: 25 milliseconds.

#### B5.2 Release

After the critical section finishes (success path) or throws (failure path), unlink the lock file:

1. If unlink succeeds, the lock is released; done.
2. If unlink fails with the "not found" error code, swallow silently. Rationale: this is the legitimate race with a stale-recovery reclaim by another waiter; logging would spam normal contention.
3. If unlink fails with any other error code (e.g. permission denied or platform-specific busy errors), log at debug level naming the lock path and the error message. The hide already landed on disk before this step; only the orphaned lock file lingers. The next hide will wait up to the stale threshold to reclaim it.

Notable: release happens unconditionally even if the inner work threw — both success and failure paths run the release step.

### B6. Error path from acquire timeout

If acquire (B5.1 step 6) throws a contention-timeout error, the in-flight Record-a-hide rejects with that error. No partial state has been written (no temporary file, no rename). The caller is responsible for surfacing the failure to the user; this store's contract is to fail loudly rather than silently lose the hide.

## State Transitions

### State of a single composite identity

- Absent: identity is not a key in the persisted map.
- Hidden-as-of-T: identity is a key whose hide-record stores hide-moment T.

Transitions:

- Absent → Hidden-as-of-now: triggered by Record-a-hide (B4).
- Hidden-as-of-T → Hidden-as-of-now (T' > T): triggered by Record-a-hide on an already-hidden identity. Set membership unchanged; hide-moment refreshed.
- Hidden-as-of-T → (functionally) Visible from the filter's perspective: triggered indirectly when the data source begins reporting a last-updated moment strictly greater than T (no state mutation occurs in this store; the "still hidden?" predicate simply returns false). The map entry remains present.
- Hidden-as-of-T → Hidden-as-of-now via the data source reporting a still ≤ T last-updated moment: the entry is dormant but resurfacing requires a strictly newer activity moment.

There is no transition out of Hidden in the persisted state itself. The persisted map only grows; entries are not pruned by any in-store behavior. (Implication: garbage of long-deleted conversations accumulates in the map. This is acceptable because the entries are tiny and the predicate filter handles re-surfacing without consulting the entries' liveness.)

### State of the on-disk document

- Absent: no document file. Load returns empty state silently.
- Present-and-valid: document conforms to the persisted shape. Load returns its cleaned entries.
- Present-but-corrupt (unreadable / unparseable / wrong schema version / wrong entries shape): Load returns empty state and logs a warning. All prior hides effectively cleared from the user's perspective until a successful Record-a-hide re-creates a valid document.
- Present-with-mixed-entries (valid wrapper, some entries well-formed, some malformed): Load returns the well-formed entries only; malformed entries silently dropped (no per-entry logging).

### Lock file state

- Absent: store is idle (or contention is resolving).
- Present-with-recent-mtime (< stale threshold): a holder owns the critical section; new acquirers poll.
- Present-with-old-mtime (≥ stale threshold): treated as crash-orphaned; the next acquirer reclaims by unlinking and immediately retrying.

## Notable Behavior

- **Schema version is fail-closed, not migrating.** A wrong version marker is treated identically to a corrupt file: empty state returned. There is no upgrade path baked in; the version is the kill switch for forward compatibility.
- **Hides are sticky against time-source corruption.** Both an unparseable stored hide-moment and an unparseable supplied last-updated moment yield "still hidden = true". The store never silently surfaces a row the user dismissed because a timestamp was garbled.
- **Equality means hidden, not re-surfaced.** The strict-newer comparison treats `updatedAt == hiddenAt` as "the same snapshot the user just dismissed". A data source that pins a static updated-at across renders will keep the row suppressed forever; only a strictly-newer moment re-surfaces it.
- **Re-hiding refreshes the timestamp.** This is intentional: a user who re-confirms a hide (e.g. because the row briefly reappeared due to a noop activity bump and they're dismissing it again) wants the hide-moment moved forward, not preserved.
- **The persisted set is append-only in practice.** No path in this store removes entries from the map. The "still hidden?" predicate provides functional un-hiding without state mutation.
- **Hides survive an in-store contention timeout cleanly.** Atomic temp-write-then-rename means a failure to acquire the lock prior to write leaves the prior state file untouched. The caller sees the rejection; no half-state lands.
- **Concurrent hides do not drop entries.** Without the lock, two writers racing on load→modify→write would both load the same baseline and the last writer would silently overwrite the other's addition. The lock + freshly-loaded baseline inside the critical section closes that race.
- **Object-prototype safety is part of the contract.** A conversation identifier equal to a name that would otherwise be inherited from a default object's prototype (e.g. names like `__proto__` or `toString`) must be treatable as an ordinary entry. The implementation uses a no-prototype map for entries; any reimplementation must enforce the equivalent invariant or accept that those identifier values would falsely test as present even when absent.
- **Stale-lock reclaim races are tolerated.** Two waiters can each conclude the lock is stale at almost the same instant. One will succeed the unlink-then-exclusive-create; the other's unlink will fail (swallowed) and its next exclusive-create will fail (re-entered into stale check). Eventually one of them wins. The acquire-timeout caps the total wait.
- **Lock-release ENOENT is silent on purpose.** It signals the legitimate race where a concurrent waiter performed stale-recovery on this caller's lock while the caller was inside the critical section. Logging would produce spurious warnings under routine contention.
- **The Load warn-log distinguishes "entries absent" from "entries present-but-malformed".** Both fall back to empty state, but a missing entries field is logged (the document was valid JSON with the right version but missing the expected field) — only a parse error or non-object entries value bypasses the entry-iteration path.

## Shared Behavior

- Composite-identity convention (`<source>:<conversationId>` with colon as a reserved separator) is shared with the panel that triggers hides and with the active-conversations aggregator. The colon-never-in-source invariant is a project-wide convention referenced by but not enforced in this store.
- The "where is per-project local state stored" convention is shared across the product's local-state stores. This store places its single document in that same per-project directory; resolution of that directory is shared infrastructure.
- The atomic temp-write-then-rename pattern is shared with other local-state stores in the product. The lock-suffix advisory protocol is similar in shape but is local to this store (each store owns its own sibling lock; locks are not shared across stores).
- The active-conversations aggregator (cross-reference: active-conversations aggregator spec) is the sole production reader of the "still hidden?" predicate. It supplies the conversation's last-updated moment from its own data sources. This store's contract to the aggregator is: given a loaded state + identity + updated-at, return whether the row should be filtered out.
- The conversation-overlay store (cross-reference: conversation-overlay store spec) is a separate, per-conversation persistence surface for entry-level edits. The two stores never read each other's files. The signal "post-edit transcript is now empty" originates in the overlay/panel and is communicated to this store by a single Record-a-hide call; the panel's decision logic is not part of this store's contract.
- The commit-exclusion store (cross-reference: commit-exclusion store spec) is a separate, semantically distinct store (per-snapshot UI selection vs. persistent hide). They share no state and are explicitly noted in source as not interchangeable.
