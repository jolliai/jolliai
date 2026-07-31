# 309. IntelliJ PR-Status Cache

## Topic Statement

A project-scoped, in-memory cache in front of the three forge-tool probes that decide what every pull-request affordance in the JVM IDE renders — is the tool installed, is the user signed in to it, and does this branch already have an open pull request. Three surfaces ask the same three questions about the same branch within seconds of each other, and each answer used to cost a cold subprocess fork of roughly a tenth to half a second; the cache collapses that to one probe per question per freshness window, and makes concurrent askers **join a single in-flight probe** instead of each starting their own. Its two load-bearing design choices are the split into two freshness windows (a short one for the pull-request verdict, a long one for tool state) and the retention policy that keeps a genuine negative answer but throws away a failed one.

## Scope

**In scope:**

- The cache's lifetime and identity: one per open project, no persistence of any kind.
- The **two key spaces** — the pull-request verdict keyed by working directory *and* branch; tool presence and sign-in state each keyed by working directory alone — and why they differ.
- The **two freshness windows** and the reasoning that sets each one.
- Query deduplication: concurrent askers of one key join one probe, and the probe runs outside any lock.
- The **retention policy** for each probe outcome, including the zero-lifetime treatment of a reported error and of a raised probe.
- The soft cap on the verdict key space, the sweep that enforces it, and the deliberate absence of a cap on the two directory-keyed spaces.
- Per-branch invalidation: which surfaces must perform it, and why its ordering relative to the rebuild that follows is load-bearing.
- The clear-everything operation, which has no production caller.
- The known gaps: the events that no surface invalidates on, and the submit paths that deliberately bypass the cache.

**Out of scope (boundaries):**

- How each probe is actually performed — the forge command-line invocations for tool presence, sign-in state, pull-request lookup, create, and update, and the shapes of the verdicts they return. Owned by the PR service, and consumed here as three opaque probes.
- What each consuming surface renders from a verdict, and its own staleness handling: the branch-level pull-request draft (**251. IntelliJ Create-PR View**), the branch commit list (**123. IntelliJ Commits Panel**), and the per-memory detail view (**120. IntelliJ Embedded HTML Summary View**).
- The pull-request body content, marker merging, and the create-versus-update decision — none of which read this cache.
- Every other cache in the plugin. This one holds forge state only.

## Data Contracts

### Identity and lifetime

| Property | Value |
| --- | --- |
| Scope | One cache per open project, created on first use by any consuming surface. |
| Persistence | **None.** No disk tier, no session file, no folder layer. Every entry dies with the IDE session, by explicit design — the forge remains the source of truth and a cached verdict must never survive into a session where it could be arbitrarily old. |
| State held | Three key→entry maps, described below. |

### The two key spaces

| Question | Key | Why that key |
| --- | --- | --- |
| Does this branch have an open pull request? | working directory **plus** branch | The answer is per branch; one project can be asked about many branches in one session. |
| Is the forge command-line tool present? | working directory alone | A property of the machine and the resolved environment, not of any branch. |
| Is that tool signed in? | working directory alone | Same — one answer serves every branch in the project. |

Every key is a plain string; nothing about a project object is retained, which is why the cache is testable without an IDE surface.

### The two freshness windows

| Entries | Window | Reason |
| --- | --- | --- |
| Pull-request verdict | **~1 minute** | A pull request can change on the forge at any moment (opened, merged, closed) with no local event to observe. Long enough to absorb the burst of reads that happens when the user opens or switches memory tabs; short enough that a badge does not feel stale. |
| Tool presence, sign-in state | **~5 minutes** | These change only when the user installs the tool or logs in — an explicit, rare, user-initiated act. This window is what removes the large majority of duplicated forks. |

### Entry states

An entry is one of three things, and the distinction is what makes joining safe:

| State | Treated as | Read by a caller as |
| --- | --- | --- |
| Probe still running | **Fresh** — joined, never replaced | The caller blocks on the shared probe and receives its result. |
| Completed with a value inside its window | Fresh | That value. |
| Completed with a value whose lifetime is zero or already lapsed | Expired | Replaced by a new probe on the next read. |

### Retention policy

This is the subtle part. Retention is decided per outcome, not per probe:

| Outcome | Retained for |
| --- | --- |
| A pull request was found for the branch | The full short window. |
| **No** pull request exists for the branch | The full short window — a genuine negative is a correct answer. |
| The lookup reported a **lookup error** | **Zero.** Served to the caller that ran it (so the surface can render "unavailable"), then evicted. |
| The lookup **raised** | **Zero.** The caller is told nothing is known, and the entry is evicted. |
| Tool present, or tool absent — either genuine answer | The full long window. |
| Tool present / sign-in probe **raised** | **Zero.** Served as "not available", then evicted. |

The asymmetry is deliberate and cuts both ways. A transient network flake or a momentarily-missing binary must not pin a badge to "unavailable" for a whole window, so a failed answer is retired the instant it has been handed to its caller and the very next read retries. A real "this branch has no pull request" answer, by contrast, *is* the right answer; re-querying it every read would reinstate exactly the fork storm the cache exists to remove.

### Soft cap on the verdict key space

| Property | Value |
| --- | --- |
| Cap | **~256** distinct working-directory-plus-branch entries. |
| Enforced | Only on a read that had to start a new probe (a miss), and only after that probe has settled. |
| What the sweep removes | **Only** entries that are expired or hold no value. A still-running probe counts as live and is kept. |
| What the sweep never removes | A warm entry. |
| Consequence | When every entry is still warm the sweep frees nothing and the cap is **briefly exceeded** until the next miss. |

The two directory-keyed spaces carry **no cap at all**: they hold at most one entry per open project root, so there is nothing to bound.

### The caller's obligation

The verdict probe is only meaningful once the tool is known to be present *and* signed in — asked of a signed-out tool it reports a lookup error, which under the retention policy above is discarded rather than cached. Callers must therefore read presence and sign-in first and skip the verdict read when either is false. Every consuming surface does.

## Behavior

### Reading a cached answer

Every one of the three reads follows the same shape:

1. Take the current time once, and prepare an empty shared result slot of the caller's own.
2. Consult the map for the key **just long enough** to decide one thing: reuse the slot already recorded there (because it is fresh, including still-running), or record mine. No probe runs during that decision.
3. If the existing slot was reused, wait on it and return its value — the caller has joined someone else's probe and will spawn nothing.
4. If mine was recorded, run the probe **now, outside the map entirely**, then publish the result into my slot so every joiner is released.
5. Publication is unconditional: the slot is always completed, even when the probe fails in a way the cache does not classify. This is the only thing standing between a hard failure inside a probe and a set of joining threads waiting forever on a slot nobody will ever fill.
6. If the published value is not retainable (zero lifetime, or nothing at all), remove the entry immediately — after publication, so the current caller and its joiners still see the answer while the next reader retries.
7. On the verdict read only, if the map is now over its cap, run the sweep.

Because the probe runs outside the map decision, a slow probe on one key cannot stall readers of unrelated keys that merely hash to the same bucket — the failure mode the earlier lock-inside-the-map shape had.

### Invalidating one branch

Any surface that creates or updates a pull request **must** drop the cached verdict for that branch, or a negative answer cached moments earlier keeps every badge in the IDE claiming there is no pull request for up to the full short window. Three call sites do this today: the branch-level draft's submit, and the per-memory detail view's create and its update.

**The ordering is load-bearing in two directions.**

*Invalidate before the rebuild that follows.* The submit path immediately rebuilds its draft from fresh data, and that rebuild reads this cache. Invalidating afterwards would let the rebuild hit the stale negative, so the view would render create wording and no pull-request link straight after publishing a pull request. The cross-surface notification that fires next usually self-corrects this — but only while the user has not started typing, because the draft's unsaved-edit guard drops that refresh outright; once it does, the wrong label sticks for the rest of the window.

*Invalidate the branch captured at submit entry, not the one the rebuild reports.* The submit window is a one-to-three second network operation, and the user can check out a different branch inside it. The rebuild would then report the *new* branch, and invalidating that key would leave the published branch's stale negative verdict alive for its full window — the exact failure the invalidation exists to prevent, now aimed at the wrong branch. The branch is therefore snapshotted before the publish and used as the invalidation key.

### Clearing everything

A drop-all-three-maps operation exists, intended for a wholesale credential change such as signing the forge tool out. **It has no production caller** — nothing in the plugin invokes it, and no surface observes a sign-out except by waiting out the long window. Recorded here as an unreachable path, exercised only by tests.

### What nothing invalidates

Two categories of change are simply not observed, and self-correct only when the short window lapses:

- **A push or a pull-request creation that did not go through an IDE surface** — a hook-driven or command-line-driven push, or a pull request opened in a browser or terminal. No invalidation runs, so a branch whose verdict was cached as negative keeps reading negative for up to the window.
- **A pull request merged or closed on the forge.** Nothing local happens, so a found verdict keeps reading found for up to the window.

### What deliberately bypasses the cache

Every path that is about to *act* on a pull request — the submit that decides create-versus-update, and the detail view's prepare-update and update paths — resolves the pull request directly rather than through this cache. A stale label on a button is a cosmetic wrong; a stale verdict driving the action would attempt a duplicate create or update a pull request that no longer exists. The read paths are cached; the write paths are not.

## Notable Behavior

- **A genuine negative is cached; a failure is not.** "No pull request on this branch" is retained for the full window, while a reported lookup error and a raised probe are handed to the current caller and then evicted. Both halves matter: caching the failure would pin a badge to "unavailable" through a one-second network flake, and *not* caching the negative would reinstate the per-tab fork storm the cache was built to remove.
- **A zero-lifetime answer is still served once.** The evicted-immediately entries are published before removal, so the caller that triggered the probe — and anyone who joined it — renders the real outcome. Only the *next* read retries. A failure is therefore visible to the user exactly once per occurrence rather than swallowed.
- **A still-running probe counts as fresh.** That single rule is what turns the cache into a deduplicator rather than merely a memo: the second and later askers find a live slot, join it, and start nothing. Without it, three surfaces asking within the same second would each fork the tool.
- **The probe runs outside the map decision, on purpose.** The map is touched only to choose between joining and installing. An earlier shape that held the probe inside that decision let one slow forge call block readers of completely unrelated keys that shared a hash bucket.
- **Publication is unconditional so joiners can never hang.** A probe failing in a way the cache does not classify still completes the shared slot (with "nothing known" for the verdict, "not available" for the tool probes) before the failure propagates to the thread that ran it. Skipping that would strand every joining thread for the life of the session.
- **The cap is a sweep, not an eviction order.** It removes only expired-or-empty entries and never a warm one, so it can fail to shrink the map and the cap can be briefly exceeded. That only happens while the user is genuinely working across 256-plus branches inside one short window — self-limiting, not a leak. The two directory-keyed spaces are uncapped because they cannot grow.
- **The sweep also removes an entry whose probe settled abnormally — a path nothing reaches.** Publication is always a normal completion, so no entry can ever be in that state; the branch is defensive.
- **Invalidation must precede the rebuild, and must name the branch captured at submit entry.** Doing it after the rebuild re-reads the stale negative and renders create wording over a pull request that now exists; naming the post-rebuild branch invalidates whatever branch the user checked out mid-submit and leaves the published branch's stale verdict alive. Both are ordering bugs the current code is written specifically to avoid.
- **The cross-surface notification is not a substitute for invalidation.** It refreshes the other surfaces, but the branch-level draft drops any refresh that arrives while the user has unsaved edits — so a missing invalidation becomes a label that stays wrong for the full window rather than one that self-corrects.
- **A failed verdict read means different things to different surfaces.** The cache returns "nothing known" for a probe that raised. The branch-level draft treats that as "no pull request" and renders create wording; the per-memory detail view substitutes an explicit lookup-failure verdict and renders "unavailable". Same input, two renderings — deliberate, since only one of the two has a distinct unavailable state to show.
- **Presence and sign-in cache their negative answers too.** A machine without the tool installed, or a signed-out tool, is probed once per long window rather than once per read — which is what stops a fork storm on exactly the machines where every fork is wasted.
- **Nothing here is persisted, and the accompanying change description is wrong about that.** The commit that introduced this cache describes it as a "two-tier in-memory + folder cache". There is no folder tier and no disk tier of any kind; all state is in-memory maps that die with the project, and the implementation states the never-persist rule explicitly. The "folder" half of that description belongs to an unrelated direct-JSON reader added in the same change.
- **The clear-everything operation is unreachable.** It exists and works, but no production path calls it, so a forge sign-out is observed only when the long window lapses.
- **Externally-driven changes are invisible for up to a window.** A push from a hook or a terminal, a pull request opened outside the IDE, and a pull request merged on the forge all leave the cache holding a verdict that is now wrong until the short window lapses. This is an accepted gap, not a tracked defect — the short window exists to bound exactly it.

## Shared Behavior

- **The PR service** performs all three probes and owns their verdict shapes, the create/update operations, and the marker helpers. This topic owns only what is remembered about the probe results and for how long.
- **251. IntelliJ Create-PR View** — reads presence, sign-in, and the branch verdict while assembling its branch-level draft (which is why its verdict is almost always warm by the time the user clicks), invalidates the branch on submit, and resolves the pull request directly on the submit path.
- **123. IntelliJ Commits Panel** — reads presence, sign-in, and the branch verdict once per sidebar refresh, and is the surface that most often populates the cache first.
- **120. IntelliJ Embedded HTML Summary View** — reads all three for its per-memory pull-request badge, and invalidates the branch after its own create and update.
- **The IDE's project-service machinery** — creates one cache per open project and discards it with the project. The cache contributes no disposal step of its own, because it holds nothing that needs releasing.
