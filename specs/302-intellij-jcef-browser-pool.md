# 302. IntelliJ Embedded-Browser Pool

## Topic Statement

A project-scoped pool of reusable embedded-browser instances that backs the two web-view editor tabs — the memory-summary tab and the branch-level pull-request draft: one instance is prewarmed near the end of project-service initialization, each tab checks one out for the life of the tab and hands it back (rather than destroying it) on close, and the pool caps the total in flight while keeping one warm instance on standby — so the second and every later tab avoids the construction cost the pool exists to hide (recorded in the implementation as roughly 700 ms of user-visible latency). Instances are the IDE's bundled Chromium embedding (JCEF, see `STACK.md`), which is why construction is both expensive and constrained to the UI thread.

## Scope

**In scope:**
- The pool's lifetime and identity: one pool per open project, disposed with the project.
- The prewarm request issued during project-service initialization, and what a failure there costs.
- The two live consumers, and the fact that they trade one warm instance between them.
- Checkout: how an instance is chosen, in what order, and what happens when none is available.
- The per-checkout label a consumer supplies, and the fact that it only ever reaches the log.
- The checkout handle (the "lease") as the only sanctioned attachment point for a message bridge and for navigation / load-completion observers, and exactly what handing the lease back detaches.
- Capacity: the hard ceiling on total instances, the standby idle target, and the eviction decision taken when a hand-back would exceed the ceiling.
- Background top-up scheduling and its coalescing.
- The threading invariant (which entry points demand the UI thread and which do not), and how a refusal surfaces to the tab.
- Disposal on project close, and the idempotence that lets a late hand-back race it safely.
- The per-instance monotonic sequence number and the fact that it gates nothing.

**Out of scope:**
- The page rendered into a pooled instance and the host↔page message protocol, including the plain-text fallback that a refused checkout lands in — owned by **120. IntelliJ Embedded HTML Summary View**.
- The tab wrapper's own lifecycle (what opens a memory as an editor tab, the one-tab-per-project rule, tab titles) — owned by **121. IntelliJ Summary Virtual-File Editor**.
- What triggers project-service initialization and everything else initialization does — owned by **124. IntelliJ Project Service Lifecycle**; this topic owns only the prewarm request it makes.
- The **working-memory review tab** (**222**) — the one remaining embedded-browser view that still constructs its own instance directly, outside the pool, and destroys it itself. It is deliberately not pooled, is not counted against the pool's ceiling, and is not assigned a sequence number. (The branch-level pull-request draft, **251**, used to be in this category and no longer is — it is now a pool consumer; see below.)
- The tab's own UI-component observers (size / visibility watchers used to time the first content load). Those are attached straight to the shared instance's UI component, are **not** tracked by the lease, and are detached by the tab itself; see the note under *Handing an instance back*.

## Data Contracts

### Pool identity and capacity

| Property | Value |
| --- | --- |
| Scope | One pool per open project (a project-scoped service); participates in project disposal. |
| Hard ceiling on total instances | **5** (idle + checked-out combined). |
| Standby idle target | **1** idle instance. |
| Idle ordering | A two-ended ordered list. Newest hand-back at the fresh end, oldest at the stale end. Checkout takes from the fresh end; eviction takes from the stale end. |
| Priming load | **None.** A newly constructed instance is handed out pristine, with no document loaded. |

### The two consumers

| Consumer | Checkout label it supplies | Hand-back |
| --- | --- | --- |
| The memory-summary tab | identifies itself plus the short commit hash it is opening | On tab close, after detaching its own UI-component observers; hops to the UI thread first |
| The branch-level pull-request draft | identifies itself plus a truncated branch name | On tab close; hops to the UI thread first. It attaches no UI-component observers of its own, so its teardown is the lease hand-back alone |

The label is a diagnostic only: it is interpolated into the pool's log lines for the checkout and the top-up it schedules, and nothing branches on it.

The two consumers **trade one warm instance**. A user who opens a memory, closes it, and then opens the pull-request draft gets the very instance the memory tab returned — the renderer stays alive across the switch, and what the user sees on the second open is the previous page being replaced rather than a white surface being filled in.

### The checkout handle (lease)

A checkout returns a handle that exposes the borrowed instance, the instance's sequence number, and three attachment operations. Attaching through the handle is the contract — anything attached directly to the instance instead is invisible to the hand-back cleanup and outlives the tab.

| Capability offered by the handle | Cleaned up on hand-back |
| --- | --- |
| Create a page↔host message-bridge channel bound to this instance | Yes — every channel created through the handle is disposed. |
| Register a navigation-interception observer | Yes — detached from the instance's client. |
| Register a load-completion observer | Yes — detached from the instance's client. |

All three attachment operations refuse (throw) once the handle has been handed back. No live caller can reach that state: each consumer performs its attachments during its own construction, while the handle is fresh. (The pull-request draft attaches only two of the three — a message channel and a navigation observer; it registers no load-completion observer.)

Hand-back is guarded by a plain boolean flag, not an atomic one — it is a check-then-set. Idempotence therefore holds only under the handle's UI-thread-only contract; two genuinely concurrent hand-backs could both proceed.

### Sequence number

Every instance the **pool** constructs is stamped with a number from an application-wide monotonic counter (shared across all open projects and their pools, not per pool), and the stamping is logged together with an elapsed-milliseconds offset measured from the counter's own first use — not from IDE start.

The number is a diagnostic label only. It is carried on the instance, re-exposed by the checkout handle, and copied into a field by the memory tab **which never reads it back**; the pull-request draft does not even copy it. It gates no branch, is compared against no threshold, and is consulted by no behavior anywhere. Its only observable effect is the text of log lines.

## Behavior

### Prewarm (project open)

Project-service initialization, near its end — after it has dispatched the pending-push catch-up and the read-path warm-up, and immediately **before** it marks itself initialized and then subscribes to repository changes, starts its file watchers, and writes its diagnostics log — asks the project's pool to prewarm.

The request is wrapped in a catch that logs a non-fatal warning, so nothing about the pool can fail initialization. Initialization itself runs off the UI thread, and the prewarm request constructs nothing on the calling thread: it only schedules one top-up (below). Consequently a prewarm that fails — for any reason, including a construction failure discovered later on the UI thread — costs exactly one thing: whichever of the two consumers opens first pays construction itself on the slow path.

### Checking an instance out (tab open)

1. Assert the UI thread; refuse otherwise.
2. Refuse if the pool has been disposed.
3. Under the pool's lock, take the **freshest** idle instance (most recently handed back) and move it to the checked-out set.
4. If one was taken: log the reuse, schedule a background top-up so the next open is also instant, and return a handle wrapping it.
5. If none was available: construct one **synchronously on the UI thread** — the slow path the pool exists to avoid — record it as checked out, and return a handle wrapping it. No top-up is scheduled on this path, and **the ceiling is not consulted**: checkout is not admission-controlled.

### Constructing an instance

Construction asserts the UI thread, builds the instance, stamps it with the next sequence number, and logs the elapsed build time.

It deliberately performs **no priming load**. An earlier version loaded a themed blank page here to warm the native surface; that set the instance's address to a fake sentinel, after which the real content load never replaced the document — load-completion fired against the still-primed page. The instance is therefore returned pristine and the tab performs exactly one content load. (The tab's load-completion handling relies on this: it treats the very first load-completion event as the real page's, with no sentinel to filter out.)

### Background top-up

A top-up request:

1. Returns immediately if the pool or the project is disposed.
2. Returns immediately if a top-up is already pending — this is the coalescing that stops concurrent requests from stacking construction work.
3. Otherwise schedules **one** turn of UI-thread work.

In that turn, in order: clear the pending flag (so a request arriving later re-arms), re-check pool/project disposal, then decide under the lock whether to build — required only when the idle count is **below the standby target** *and* idle + checked-out is **below the ceiling**. If a build is required it happens in this same turn; a construction failure is logged as non-fatal and abandoned. After a successful build, disposal is re-checked under the lock: if the pool was disposed in the meantime the fresh instance is destroyed instead of filed.

At most one construction happens per scheduled turn, so two constructions are never chained within a single dispatch turn.

### Handing an instance back (tab close)

The memory tab's teardown detaches its own UI-component observers first — those sit on the shared instance's UI component and are not the lease's responsibility — and only then hands the lease back, so no next tenant can attach in between. (The pull-request draft has no such observers, so its teardown is the hand-back alone.) Because the pool's hand-back asserts the UI thread while a tab can be torn down from any thread during project close, both consumers hop to the UI thread when they are not already there.

The handle's side of hand-back:

1. If already handed back, no-op.
2. Mark handed back.
3. Dispose every message-bridge channel created through this handle, each inside its own swallow.
4. Detach every load-completion observer, each inside its own swallow.
5. Detach every navigation-interception observer, each inside its own swallow.
6. Give the instance back to the pool.

Every step of the cleanup is best-effort precisely because the instance **outlives the tab**: teardown throwing must not stop the remaining detachments, or the shared instance would carry a previous tenant's handlers into the next tab.

The pool's side, under the lock after removing the instance from the checked-out set:

- **Pool disposed** → the returned instance is destroyed.
- **Would exceed the ceiling** (idle + checked-out + this one > 5) → evict the **oldest idle** instance, file the returned one at the fresh end (so the returned, warmest instance keeps a slot), and destroy the evicted one. Only when there is **no other idle instance** is the instance being returned the one destroyed.
- **Otherwise** → file it at the fresh end.

Destruction happens outside the lock.

### Refusals

Two refusals exist, both raised as exceptions to the caller:

- A call from a thread other than the UI thread (checkout, hand-back to the pool, and construction all assert).
- A checkout against a disposed pool.

Prewarm asserts nothing — it is called off the UI thread by design and only schedules work.

Both refusals reach a consumer through its construction path, which catches them along with any genuine construction failure and substitutes that view's own no-embedded-browser fallback — the memory tab's read-only plain-text rendering of the memory (owned by spec 120), or the pull-request draft's equivalent (spec 251). No handle is retained in that case, so the tab's later teardown hands nothing back.

An off-UI-thread hand-back is the sharp edge: the handle's own cleanup runs and the handle is marked handed back **before** the pool's assertion throws. The instance is left in the checked-out set permanently, stripped of its handlers and unreachable for reuse — one slot of the ceiling is lost for the rest of the project session. This is exactly what the tab's UI-thread hop prevents.

### Disposal (project close)

1. The first caller wins; a second disposal is a no-op.
2. Under the lock, snapshot idle + checked-out, then clear both sets.
3. Destroy every snapshotted instance outside the lock.

Each instance destroys at most once (guarded by its own one-shot flag) and swallows a destruction failure, because teardown of the underlying browser process is known to throw. This is what makes the race safe: pool disposal walks the checked-out set eagerly while a tab's deferred teardown can arrive afterwards; the late hand-back sees the disposed pool, asks for the same instance to be destroyed, and the second destroy is a no-op.

## State Transitions

```
[project open — service initialization, just before it marks itself initialized]
  prewarm requested (off the UI thread, fire-and-forget, failures logged only)
    → top-up scheduled → 1 idle instance (pristine, no document)

[tab open — memory tab or pull-request draft]  (UI thread required)
  consumer supplies a diagnostic label (logged, never branched on)
  [pool disposed]           → refuse → consumer renders plain-text fallback
  [not the UI thread]       → refuse → consumer renders plain-text fallback
  [idle available]          → take freshest idle → checked out
                              → schedule top-up (refills toward 1 idle, capped at 5 total)
  [no idle]                 → construct on the UI thread (slow path) → checked out
                              → no top-up scheduled

[memory tab: a different memory is selected]
  no checkout at all — the same borrowed instance stays, only its document changes

[tab close]  (hops to the UI thread if teardown was raced elsewhere)
  memory tab only: detaches its own UI-component observers first
  handle detaches: message-bridge channels, load observers, navigation observers
                   (each best-effort; instance outlives the tab)
  hand back to pool
    [pool disposed]                        → destroy returned instance
    [total after return > 5, other idle]   → evict + destroy OLDEST idle;
                                             returned instance takes its slot
    [total after return > 5, no other idle]→ destroy the returned instance
    [otherwise]                            → file at the fresh end of idle

[off-UI-thread hand back]
  handle cleaned + marked handed back, then the pool refuses
    → instance stranded in the checked-out set for the session

[project close]
  destroy every idle and every checked-out instance (each at most once)
  later straggling hand-back → sees disposed pool → destroy → no-op
```

## Notable Behavior

- **The ceiling is a hand-back constraint, not admission control.** Checkout never consults it and never refuses for capacity, so N simultaneously open consumer tabs hold N instances even when N exceeds 5. The population is trimmed back toward the ceiling only as tabs close, one destroy per over-capacity hand-back. With only two consumers and at most one memory tab, reaching the ceiling in normal use is now essentially impossible.
- **Eviction prefers the coldest instance, not the returning one.** A hand-back over the ceiling destroys the oldest idle instance and gives the returning (warmest) instance its slot. Only an empty idle set forces the returning instance to be the casualty.
- **Checkout is newest-first, eviction is oldest-first.** The same two-ended list serves both ends: the most recently returned instance is the most likely to still be warm, and the least recently used is the cheapest to lose.
- **A cold checkout does not schedule a replacement.** Top-up is scheduled only when a checkout hit an idle instance (or by prewarm). Open a memory tab and a pull-request draft in a row from an empty pool and both pay synchronous construction on the UI thread; the standby spare is only re-established once a tab closes or a later hit-checkout schedules one.
- **The top-up's construction cost still lands on the UI thread**, just in a later dispatch turn than the tab that triggered it. Pooling moves the cost off the tab-open path; it does not move it off the UI thread.
- **No priming load, on purpose.** Priming with a themed blank page left the instance's address at a sentinel and the subsequent real content load never replaced the document — load-completion fired against the primed page. Instances are handed out pristine and the consumer performs exactly one load. Reintroducing a priming load would silently re-break first render.
- **Everything the lease tracks is embedded-browser-layer only.** Message-bridge channels and the two observer kinds are detached on hand-back; UI-component observers attached directly to the shared instance's component are not, and are the tab's own responsibility. Because the instance is reused, a missed detachment there accumulates one stale observer set per open/close cycle rather than being collected with the tab.
- **Hand-back cleanup is deliberately failure-tolerant.** Each channel disposal and each observer detachment is individually swallowed so a throwing teardown cannot leave later handlers attached to an instance that a different tab is about to receive.
- **An off-UI-thread hand-back strands a slot.** Cleanup completes and the handle is marked spent before the pool's UI-thread assertion fires, so the instance is never filed as idle and never re-offered. The consumer avoids this only by hopping to the UI thread first.
- **Both pool refusals are indistinguishable from a genuinely unavailable embedded browser.** A disposed pool, a wrong-thread call, and an environment without the embedded-browser capability all surface identically: the consumer shows its read-only plain-text fallback, logged as the browser being unavailable.
- **Destruction is idempotent by design, not by accident.** Project close walks checked-out instances eagerly while tab teardown can arrive later; the one-shot destroy flag plus the swallowed failure is what makes that overlap harmless.
- **Top-ups coalesce, but the pending flag clears before the build.** A request arriving after the scheduled turn begins re-arms the flag and schedules another turn, so consecutive turns can each build one instance — the standby target and the ceiling are what actually bound this, not the coalescing flag.
- **The sequence number decides nothing.** It is assigned, logged with an elapsed offset, exposed on the handle, and copied into a field by the memory tab that never reads it — a write-only diagnostic. No control flow anywhere depends on it.
- **Only pool-constructed instances are numbered.** The working-memory review tab constructs its own instance directly and is never stamped, so the numbering is a count of *pooled* instances, not of embedded browsers in the session — and the elapsed offset is measured from the counter's first use, so it is an inter-instance spacing signal, not a time-since-startup one.
- **The counter is application-wide while pools are per project.** Numbers from two open projects interleave in the log.
- **The pool has two live consumers, and they trade one warm instance.** The memory-summary tab and the branch-level pull-request draft both check out and hand back. The pull-request draft used to build and destroy its own instance outside the pool; it no longer does. In practice the two never want an instance at the same moment for long, so the standby spare is usually enough for both, and a switch between them replaces one page with another rather than showing a white surface.
- **The memory tab now borrows far fewer instances than it used to.** At most one memory tab exists per project (spec 121), and switching memories reuses that tab's already-borrowed instance and only changes what it displays. Browsing twenty memories takes out one lease, not twenty — so the churn the pool was sized for barely happens on that surface any more. (The one way to exceed it is an IDE editor split of the memory tab, which creates a second editor over the same file and therefore a second lease; see the split defect in spec 121.)
- **A legacy standalone-dialog wrapper around the memory view still exists and would also check out an instance, but nothing constructs it.** It is unreachable. (Unreachable path.)

## Shared Behavior

- **120. IntelliJ Embedded HTML Summary View** — the page loaded into a pooled instance, the bridge protocol carried over the lease's message channel, and the plain-text fallback that every pool refusal lands in.
- **121. IntelliJ Summary Virtual-File Editor** — the tab wrapper whose construction checks an instance out and whose disposal hands it back; also the owner of the one-tab-per-project rule that reduced this surface to a single lease per session-of-browsing, and of the editor-split defect that can produce a second one.
- **124. IntelliJ Project Service Lifecycle** — issues the prewarm request near the end of initialization and swallows its failure; owns everything else about that sequence.
- **251. IntelliJ Create-PR View** — the pool's second consumer: it checks an instance out on construction and hands the lease back on close, hopping to the UI thread first. It attaches a message channel and a navigation observer through the lease and no load-completion observer, and registers no UI-component observers of its own.
- **222. IntelliJ Working Memory Web View Editor** — the one embedded-browser view still deliberately outside the pool: it constructs and destroys its own instance and is neither counted against the ceiling nor numbered.
- **The IDE's project-service and disposal machinery** — creates one pool per project and drives its disposal on project close; the pool contributes only the destroy-everything step.
