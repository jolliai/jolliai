# 346. System-of-Record versus Read Storage Resolution

## Topic Statement

Two separate resolutions answer two different questions about the same repository — which backend holds the truth, versus which backend to read from — deliberately disagreeing before a cutover, so a caller that needs authoritative data must never reuse the one that answers the display question.

## Scope

**In scope:**

- The two questions, the backend each resolution returns per routing state, and the one state in which they disagree.
- The two shapes the system-of-record resolution is exported in — throwing and diagnostic — and which kind of caller takes which.
- The short-lived per-process route memo one of the two keeps: why it exists, why it is time-bounded rather than permanent, and who drops it explicitly.
- The working-directory threading rule that distinguishes the value handed to the backend from the value used for routing and identity.
- The untargeted fallback shared by the store layer: what it resolves to, the asymmetric warning between its write and read entry points, and the single degradation that turns a hard-refused state into ref-backed reads.
- The concrete damage each substitution causes, in both directions.

**Out of scope (boundaries):**

- The routing state table itself, its two witnesses, and the conditions that make the database unanswerable — covered by **Cutover Routing State Table** (344).
- What the freeze marker means and the protocol that writes it — covered by **Orphan Branch Cutover Fence and Compare-and-Swap** (345).
- The internals of any backend either resolution returns.
- The Memory Bank write boundary that gates the folder-mirror construction inside the read resolution (spec 300).
- The process-global storage override that both entry points of the store-layer fallback consult first, and the write paths that thread an explicit backend instead.

## Data Contracts

### The two questions

| Resolution | Question | Failure policy |
| --- | --- | --- |
| System of record | Which backend holds the truth for this repository? | Two exported shapes — one throws on the unroutable state, one returns it as data. |
| Read storage | Which backend should I read from, so that I see what the user sees? | Throws on the unroutable state. |

### System-of-record answer shapes

- **Throwing shape**: returns a backend, or throws when the repository is `blocked`. For write paths and for any read whose job is authoritative data.
- **Diagnostic shape**: returns either `{ ok: true }` carrying the routing state (`uncutover`, `legacy-fenced`, or `cutover`) and the backend, or `{ ok: false }` carrying a reason. Any unexpected failure in resolution or construction degrades to the reason arm rather than propagating. For diagnostics — a health-check command that throws is useless at exactly the moment it is needed.

### Backend per state

| Routing state | System of record | Read storage |
| --- | --- | --- |
| `uncutover` | The ref-backed backend | The folder mirror, with two documented fallbacks to the ref-backed backend, plus a retired-key dispatch — see 344 |
| `legacy-fenced` | The database-backed backend | The database-backed backend |
| `cutover` | The database-backed backend | The database-backed backend |
| `blocked` | Throws (or `{ ok: false }`) | Throws |

**They disagree in exactly one state, and it is the common one.** Un-cutover, the truth is the ref-backed backend while the read resolution answers the folder mirror, because the mirror is the view every surface shows the user. The two frozen states collapse onto the same backend, which is what makes the distinction easy to lose.

## Behavior

### Resolving the system of record

1. Take the caller's working directory, defaulting to the process working directory when absent.
2. Resolve the routing state through the memo below.
3. On `blocked`, either throw — with a message naming the reason, stating that the frozen ref cannot be fallen back to, and pointing at the recovery command or a surface upgrade — or return the reason arm, depending on which shape was called.
4. On either frozen state, resolve the repository identity from the routing target and construct the database-backed backend over it.
5. Otherwise construct the ref-backed backend.

**The warning carried by an `uncutover` state is deliberately not re-logged here.** The routing decision already warned at the point that knew the reason, and repeating it would fire on the read path — where "no database yet" is the ordinary state of every un-cutover repository, and a warning on healthy behavior is the one people learn to scroll past.

### Working-directory threading

The caller's working directory is threaded to the **ref-backed** backend exactly as given, including when it is absent, while the defaulted value is what routing and identity resolution use. The two are not interchangeable: a ref-backed backend built with no working directory lets each version-control invocation pick up the process working directory at call time, whereas baking the defaulted value in would freeze it at resolution time — an observable difference for anything that changes directory mid-process, and a change to every read the backend performs.

### The route memo

The routing decision opens the database on every call (its row read runs even when no freeze marker is present) and memoizes only the repository identity. The system-of-record resolution sits under the store layer's dozens of call sites, several of them inside per-summary loops, so an unmemoized resolver would turn a field read into a database open.

It therefore keeps a per-process memo keyed by working directory, holding the resolved routing state with a **three-second** time-to-live.

The time bound is the point, not a detail: permanence is the bug this memo exists to remove. The routing decision's own contract is that the answer is per-call, so a long-lived editor host or bridge server that memoized forever would keep serving the pre-cutover backend after the freeze lands — silently, which is the failure mode being swept up. The window is closed immediately by an explicit drop, available with or without a working directory (no argument clears every entry). Two production callers drop it:

- The cutover protocol, at both of its transitions (just after the marker lands, and just after the swap is recorded).
- The editor host's storage reload, which drops the memo alongside its own cached write- and read-storage handles. It runs on settings-save, after a first-run Memory Bank migration, after a folder sweep that actually deleted something, and on a cutover heal — fired from either of that host's two storage accessors and from its retry of a write the frozen ref refused. The heal is the one of those four that is not a change this process made itself: it is driven by a lazy route probe, so the reload happens on a transition another surface committed. That host is the longest-lived process in the product and never installs a process-global storage override, so every in-process store call resolves through this memo; leaving it hot after a storage reload is the same staleness one layer down.

### Resolving read storage

Resolves the routing state (no memo of its own — the caller is responsible for caching), throws on `blocked`, returns the database-backed backend for both frozen states, and otherwise dispatches on the retired configuration key with the Memory Bank write boundary ahead of it. The full `uncutover` dispatch, including the folder-readiness and dirty-marker fallbacks, is defined by 344.

It performs a fresh configuration load — and, on the default dispatch, a fresh folder-index probe and dirty-marker check — on every call. One-shot command-line callers exit after a single read pass and need no cache; the editor bridge memoizes the resolved backend and invalidates it on settings-save, on a user-initiated refresh (so a folder repopulated by an external sync becomes visible without a window reload), and on the cutover heal, which drops both of its storage caches together.

### The untargeted store-layer fallback

Every store operation takes an optional explicit backend and consults a process-global override; when neither is present it falls back to **the system of record** — the diagnostic shape, so that no fallback can itself throw.

- When the diagnostic shape answers `{ ok: false }` — which is only the `blocked` state, or an unexpected construction failure — the fallback logs a warning and returns the **ref-backed backend anyway**. This is the single place in the product where `blocked` degrades instead of failing loudly. (Notable.)
- The **write** entry point additionally warns that the caller threaded no backend, because reaching the fallback on a write bypasses the dual-write composite and the Memory Bank side silently loses that write.
- The **read** entry point is the identical fallback with **no** warning, because reads coming from the system of record are the documented model, not a defect — and a warning that fires on healthy behavior is the one people learn to scroll past. Silencing reads cannot hide a write: every write resolves its own backend at its own call site and still warns there.

### Why neither substitutes for the other

**Reading storage where the system of record is meant** is the dangerous direction, because it is silent and it is wrong only before a cutover:

- Fed to the Memory Bank migration, whose destination *is* the folder mirror, it turns the run into folder-to-folder — migrating the destination onto itself.
- Fed to a "does this repository have any memories" probe, or to a hook reading one summary straight through, it answers from a mirror that may not exist yet on a fresh install, so a session briefing goes vague or empty with no state a user would notice.

**The system of record where read storage is meant** costs the display guarantee: the compile and recall paths must work from the same snapshot the user can see in their Memory Bank folder, or downstream fingerprints drift between surfaces.

**And hard-coding the ref-backed backend instead of either** is the substitution both resolutions were introduced to remove. Past a cutover it rebuilds from a frozen ref — every memory written since the freeze silently absent — and in a clone made after the cutover, which has no parallel ref at all, it reports "nothing to migrate" and produces an empty Memory Bank, both while reporting success.

## State Transitions

Neither resolution holds state beyond the route memo. Its transitions are:

- **Cold → warm** — a resolution for a working directory not currently memoized.
- **Warm → cold, by age** — three seconds after the entry was stored. The next call re-resolves.
- **Warm → cold, explicitly** — the cutover protocol at each of its two transitions, or the editor bridge's storage reload, including a heal-driven reload.
- **Warm but wrong** — the window between a state change caused by another process and this process's next re-resolution. Bounded by the time-to-live for any process that only re-resolves on age. The editor host also closes it on a change it did not cause: its storage reload is invoked by a lazy route probe, so the memo is dropped on a route transition another surface committed, bounded there by the five-second probe throttle rather than by the three-second time-to-live alone. The cutover protocol's own drops still close only the transitions it performed itself.

## Notable Behavior

- **The two resolutions disagree in the un-cutover state, which is the state most repositories are in.** That is the entire reason they are separate, and the entire reason a substitution goes unnoticed: past a cutover the two return the same backend, so a wrong call site tests clean on a cut-over machine. (Surprising; central.)
- **A resolution that throws and a resolution that reports are both needed for the same question.** A write path must fail loudly when there is no safe backend; a health-check command exists to *report* that state, and one that throws is useless precisely when it is needed. (Notable.)
- **The one place the unroutable state does not fail loudly is the store layer's untargeted fallback**, which degrades to ref-backed reads with a warning. (Surprising.)
- **The same fallback warns on the write side and stays silent on the read side.** The asymmetry is deliberate: the identical event is a defect for a write and the documented model for a read, and a warning that fires on healthy behavior is worse than no warning at all. (Notable.)
- **The memo is deliberately short-lived rather than permanent.** Permanence would make the longest-lived hosts keep writing a frozen ref after the freeze, silently. Three seconds bounds that window; the explicit drops close it sooner — the cutover protocol's for the transitions it performed itself, and the editor host's for a transition it merely noticed, since its reload is now also triggered by a lazy route probe. (Notable.)
- **The memo caches the routing state, never the backend.** A backend is reconstructed on every call even on a memo hit. (Notable.)
- **An absent working directory is threaded through unchanged to the ref-backed backend.** Defaulting it at resolution time would freeze the directory that every subsequent version-control call resolves against. (Notable.)
- **The read resolution has no memo of its own and re-probes the folder on every call.** Caching is each caller's responsibility, and the two hosts that need it invalidate on different signals — settings-save and the cutover heal for both, plus a user-initiated refresh for the read side alone. (Notable.)

## Shared Behavior

- The routing state table, its two witnesses, the closed set of conditions that make the database unanswerable, and the full `uncutover` read-side dispatch (including the retired configuration key and the folder-readiness and dirty-marker fallbacks) are defined by **Cutover Routing State Table** (344).
- The freeze marker, everything its presence changes, and the locked compare-and-swap that drops this memo at both of its transitions are defined by **Orphan Branch Cutover Fence and Compare-and-Swap** (345).
- The lazy route probe that drives the editor host's heal-triggered reload — its five-second throttle, its one-way latch, and the frozen-write retry that also fires it — is defined by **Stale Storage Heal After an Unwitnessed Cutover**.
- The Memory Bank write boundary consulted inside the read resolution's folder-bearing branches is defined by **Memory Bank Write Boundary and Effective-State Reporting** (300).
- The dual-write composite that the untargeted write fallback bypasses is defined by **Dual-Write Summary Storage**.
- The ref-backed backend's plumbing and its write-time refusals are defined by **Orphan Branch Summary Storage**.
