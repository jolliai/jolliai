# 125. IntelliJ Orphan-Branch Ref Monitoring

## Topic Statement

The JVM IDE's project service watches a small set of externally-written files through the IDE platform's own change bus rather than an operating-system watcher, classifies **every** path in each delivered batch into one of three outcomes rather than stopping at the first match, and routes the result onto two independent debounce timers — one of which picks between a heavy and a light refresh under a sticky, one-way escalation.

## Scope

**In scope:**
- The three directories registered as non-recursive watch roots, how each is resolved, and what happens when one does not exist at startup.
- Seeding the platform's virtual file system with each root before registering it.
- The path canonicalisation that makes exact-equality matching work at all.
- The batch classifier: its three outcomes, the exact-path set behind each of the first two, the extension rule behind the third, and why every path in a batch is examined.
- The commit-time debounce timer, its window, and the escalation rule that decides which refresh it runs — stated here in full.
- The note-source debounce timer, its accumulating path set, its enablement gate, and the membership question it asks.
- Lifecycle: start inside service initialization, tear down with the service, including handing the watch roots back.

**Out of scope (boundaries):**
- What either refresh recomputes, and the two disjoint listener lists they wake — spec 124.
- The command-line surface's **own** watchers, which push notifications over the connection and reach the same two refreshes independently — spec 289.
- The canonical statement of the escalation rule — spec 338 (inlined below, as every dependent spec must).
- The packed form of the memory reference: only the loose form is observed, because the writer writes loose references.
- Which files back a working-area note — a decision the command-line side owns; this component only asks.
- The writer whose sequence of object writes is what the debounce window exists to collapse — spec 34.

## Data Contracts

The watcher exposes no data shape of its own. Its only outputs are side effects on the project service: one of two refreshes, and — separately — a working-context refresh when a saved markdown file turns out to back a note.

### Watch roots (three)

All three are registered **non-recursively**, and the platform de-duplicates them, which matters because two of them are frequently the same directory.

| Root | Location | Present when? |
| --- | --- | --- |
| Memory-reference parent | The **leaf parent** of the memory reference file, under the project root's repository directory | Only once a memory has been written; and only when the project root's repository entry is a **directory** |
| Per-project state directory | The product's state directory under the project root | Created by ordinary product use |
| Profile directory | The product's state directory under the **main** checkout, resolved through the repository's shared directory | Once a profile has been written; equals the row above on the main checkout |

The first two are resolved against the **resolved repository root** the service computed during initialization — which is the top level for the project directory, i.e. the current checkout's own root, not its parent's. Only the profile directory is deliberately anchored to the main checkout, so a disable performed from any checkout of the repository is observed from every other one.

Nothing outside the repository is watched. The machine-global agent-plans directory is **not** a root here.

### Target paths (four exact, plus one extension rule)

Change events are not scoped per root or per event kind — the platform delivers every change in the process as a batch, and the listener filters. Four full paths are matched by **exact string equality**, each built by joining a filename onto the canonical form of its root:

| Path | Outcome | Why it is watched |
| --- | --- | --- |
| The memory reference's leaf file under the reference parent | commit-time | The background worker updates it after writing a memory |
| The worker's liveness lock in the state directory | commit-time | Also what keeps the cached worker-busy flag fresh for action-enablement checks that must not touch disk |
| The queue drain's exclusion lock in the state directory | commit-time | Worker lifecycle |
| The repository profile file in the profile directory | commit-time | Carries the repository-wide manual opt-out, which **only** the heavy refresh reads |
| The working-context registry in the state directory | working-area | A plan, note or reference moved |

Any other path whose name ends in the markdown extension — matched **case-insensitively, anywhere on the filesystem** — is collected for the note-source check. Everything else is ignored.

A target path is only live when its root existed at startup; when a root was skipped, the paths built from it are absent and their events fall through to the extension rule (and then to being ignored).

**The profile file is grouped with the commit-time paths on purpose, not by accident of location.** It sits in the same directory as the working-context registry, but the opt-out it carries is read only by the heavy refresh, so routing it to the cheap repaint would leave a disable typed in a terminal — or performed in a sibling editor window — invisible in this IDE.

### Path canonicalisation

Each root's canonical form is taken from the platform's own answer when it accepted the path, and otherwise computed by resolving symbolic links along the whole path and normalising backslashes to forward slashes. The target paths are then built from that form.

Without symlink resolution the comparison silently matches nothing: on hosts that route temporary and system directories through links, the platform reports a path that never string-equals a naively joined one. The presentation of that bug is a watcher that arms cleanly and then never fires.

## Behavior

### Startup

Inside service initialization, after the bridge collaborators are built, startup runs against the resolved repository root. For each of the three roots, in order:

1. Test whether the directory exists; if not, log and skip it — permanently for the session.
2. Ask the platform's local file system to refresh-and-find the path, seeding its virtual file system so events for it are delivered at all (the repository's internal directories are outside project scope by default). A refusal is logged as a warning but does not stop the root being registered.
3. Add the path to the set of roots to register.

The whole set is then registered non-recursively in one call, and the returned registration tokens are kept so they can be handed back on disposal. Finally the listener subscribes to the platform's bulk change bus.

**The subscription is on the application-wide bus, not the project's.** Batches therefore include changes belonging to every other open project, which is why the extension rule can and does see markdown saves from outside this repository — deliberately, since a note references the user's own file wherever it lives, frequently outside the workspace.

A root that did not exist at startup **is not retried**; there is no rescan, so a directory created later is never observed for the rest of the session. If the whole startup call throws, it is logged and no watching occurs at all — the service then relies solely on the IDE's own repository-change events (which fire for working-tree changes but never for a memory reference update) and on the pushed notifications from the command-line side (spec 289). There is no periodic-poll fallback.

### Batch classification

On each delivered batch the listener returns immediately if the service is already disposed. Otherwise it walks **every** path in the batch and, per path, takes the first branch that matches:

1. Equal to the working-context registry → set the **working-area** flag.
2. Present in the commit-time path set → set the **commit-time** flag.
3. Ends with the markdown extension (case-insensitive) → append to the collected saved-markdown list.

**Every path is examined; there is no early return.** The batches the platform delivers are merged, and an agent that commits at the end of its turn writes the working-context registry and the memory reference close enough together to land in one batch. Stopping at whichever appeared first would *drop* the other signal outright rather than demote it — and the escalation below can only merge calls that actually happen. Nothing polls to recover a heavy refresh that was never scheduled. A markdown save sitting behind a matched control file was lost the same way.

The classifier is a pure function of the batch's paths and the resolved target paths, deliberately, because the listener it serves is an anonymous object inside a project-level service that no test can otherwise reach.

### Dispatch

- If **either** flag is set, the commit-time debounce is scheduled **once**, carrying the commit-time flag as its argument. One call, not one per signal: a second call would only restart the timer.
- If the saved-markdown list is non-empty, the note-source check is scheduled with it.

**A batch that set both flags produces one call carrying the commit-time flag** — the working-area repaint is skipped entirely for that batch. That is the intended escalation, and it is also why a subscriber that sits only on the working-area list would be silently skipped by exactly the batch a committing agent produces (spec 124).

### The commit-time debounce, and the escalation rule

Scheduling returns immediately when the service is disposed. Otherwise it records the signal, stops any pending timer, and starts a fresh **500-millisecond non-repeating** interface-thread timer. When the timer elapses it re-checks disposal, **drains** the recorded signal, and only then hops to a background pool, where it runs the heavy refresh when the drain returned true and the light one otherwise.

Because the writer performs its object writes in a tight sequence, the burst of platform events collapses into a single refresh.

The pick between the two refreshes is governed by a shared, sticky, one-way escalation flag with exactly these semantics (canonical treatment: spec 338 — inlined here in full, as that spec requires of its dependents):

- **Recording a commit-time signal sets the flag; recording a working-area signal does nothing at all.** That asymmetry *is* the rule — a light signal is never a demotion.
- **Recording is a bare write of true, never a read-modify-write.** The tidier "flag becomes flag-or-signal" spelling is not atomic, and two concurrent commit-time signals can interleave their read and write phases and lose one of the trues — defeating the escalation in precisely the concurrent case it exists for. A lone write of true cannot be lost, and only draining or teardown ever writes false.
- **Draining is a single indivisible read-and-clear**, not a read followed by an assignment. The pair leaves a window of its own: a commit-time signal landing between the read and the write is overwritten by that write, and the newly-opened window starts without the flag — the same loss, merely relocated. With one indivisible step a concurrent signal either lands inside the window being drained or survives into the next one, never in neither.
- **The drain happens before the hop off the timer thread.** Draining after the hop would leave the flag set across the hop, so a signal arriving mid-dispatch would be consumed by the refresh already in flight instead of opening a fresh window. The drained boolean is carried across the hop as a plain value.
- **Teardown clears the flag rather than draining it**, so that discarding the value reads as intent rather than as a dropped result.
- The flag is safe for concurrent access, which this caller needs: it records from the platform's listener thread and drains on the interface thread.

**Why demoting would be a bug rather than a tuning choice:** an agent that commits at the end of its turn produces a memory-reference update when the summary lands and a working-context registry rewrite moments later. Under last-writer-wins the second demotes the pending heavy refresh, and **nothing polls to recover it** — the memory the user just watched being created simply never appears in the sidebar until some unrelated event arrives. Escalation is one-way by design; being heavier than necessary is the safe way to be wrong.

The identical rule, through the identical shared component, governs the pushed-notification channel's own debounce (spec 289).

### The note-source check

A **separate** 500-millisecond non-repeating timer, deliberately not shared with the one above: a markdown save and a working-context registry write are independent events, and one timer would let a burst of markdown saves keep cancelling a pending status refresh, or the reverse.

Scheduling returns immediately when the service is disposed, when the cached status does not report the product as enabled, or when no repository root is resolved — the enablement check happens **before** the paths are recorded, so nothing accumulates while the product is off.

Otherwise the batch's markdown paths are **added to** a pending set — accumulated, never replaced, because each batch is its own call and replacing would drop a note save that a later unrelated markdown write pushed out of the window. The timer is then restarted.

When it elapses, on a background pool: drain the pending set wholesale, return if it is empty, ask the command-line side for the current note list and test whether any note's backing file is among the drained paths; on a thrown failure log and treat the answer as no. When the answer is yes, run the **working-context** refresh.

**Both sides of the membership test are normalised before comparison**, because they come from producers that only agree on one platform family. The platform reports its paths forward-slashed on every operating system; a note's stored backing path is whatever separator the host that created it used. Case is folded **only where the filesystem is case-insensitive** — the same condition under which two spellings denote one file, so folding cannot match two genuinely distinct notes. A false positive costs one extra repaint and writes nothing, which is the cheap direction to be wrong in.

**This is the one working-area signal that has no second path.** Editing a note's backing file reorders the working-area list through that file's modification time alone, with no write to the working-context registry and no pushed notification anywhere — so when this comparison misses, nothing recovers it and the list simply stops reordering.

### Shutdown

On service disposal, the disposed marker is set first so a batch already in flight refuses to schedule anything. Then: both debounce timers are stopped (cancelling any pending refresh), the escalation flag is cleared, the pending markdown set is emptied, and the registration tokens are handed back to the platform's local file system inside a swallowing catch. The change-bus subscription unhooks itself through the service's own disposal handle; there is no watcher thread to interrupt.

## State Transitions

### The watcher, within one project session

```
[inactive]  ── startup call threw ───────────> stays inactive for the session
                                                (no events observed at all)

[active]        ── all three roots existed at startup
[partly active] ── one or more roots missing at startup
                   (their target paths are absent; no rescan ever restores them)

[any] ── service disposal ──> timers stopped, flag cleared, pending set emptied,
                              watch roots handed back
```

There is no transition from inactive back to active without re-initializing the service.

### One delivered batch

```
[batch of paths]
   → per path, first match wins:
        working-context registry → record WORKING-AREA
        a commit-time path       → record COMMIT-TIME
        ends with .md            → collect for the note-source check
      (every path examined; no early return)
   → if either flag: ONE debounce call carrying the commit-time flag
   → 500 ms interface-thread timer (restarted by each call)
   → drain (indivisible) → hop to pool → heavy refresh if true, else light
   → if markdown collected: accumulate into the pending set,
        500 ms timer → pool → drain set → ask for the note list
        → match ⇒ light refresh
```

## Notable Behavior

- **Matching is exact full-path equality, so a sibling file in a watched directory produces nothing at all.** A queue entry, a progress stream or a cursor file living inside a registered root is ignored — which is the whole point, since one of those directories also carries a log written many times a second.
- **The markdown rule is the exception to that, and it is unbounded.** It matches by extension anywhere on the filesystem, on an application-wide bus, so every markdown save in every open project reaches this listener. The narrowing is done afterwards, by asking the command-line side which files back a note — because that decision lives in a registry this side does not own, and a note's backing file is frequently outside the workspace anyway.
- **Skipping a missing root is permanent for the session.** The very first time hooks are installed and the worker runs, the memory-reference directory may not have existed at startup, so this watcher misses its creation entirely. The IDE's own repository-change event on the underlying commit, and the pushed notification channel, still force a refresh that picks up the new index.
- **On a linked checkout the memory-reference root can never exist**, because the repository entry there is a file rather than a directory, so the joined path is not a directory and the root is skipped every time. Such a checkout observes memory writes only through the other two roots and through the pushed channel. (Notable.)
- **Two of the three roots are usually the same directory**, and the third differs only on a linked checkout. Registration de-duplicates them, so this costs nothing; what it buys is that a disable performed from any checkout is observed from all of them.
- **A batch that mixes the two control signals runs the heavy refresh only.** The working-area repaint is skipped for that batch, by design — and that is exactly the batch a committing agent produces. Nothing lands twice; the light refresh's own subscribers simply do not fire (spec 124).
- **Symlink resolution is load-bearing, not cosmetic.** Comparing an unresolved path against the platform's reported path silently matches nothing, presenting as a watcher that arms cleanly and never fires.
- **The move away from an operating-system watcher was made because that mechanism was unreliable, not merely to prefer a platform API.** The previous implementation silently degraded to roughly ten-second polling on one platform and regularly missed the brief atomic-rename events a repository update produces, so a memory reference update could go unobserved until some unrelated change forced a refresh.
- **Only the loose form of the memory reference is observed.** If the user packs references, the next worker write recreates the loose form, so observation recovers automatically.
- **This watcher runs *in addition to* the command-line surface's own watchers.** Those watch overlapping directories and push notifications that the plugin debounces a second time before calling the same two refreshes (spec 289). The two paths are independent, unsynchronised, and do not share an escalation flag instance — so **a single worker run can drive two refreshes**, each itself a round trip.
- **Events are delivered off the interface thread**; the timers live on it, and each refresh is dispatched onto a background pool, with panels marshalling their own updates back when their callback fires.
- **The note-source check accumulates rather than replaces**, and it drains wholesale. A save that arrives while a check is already scheduled is not lost, but a save that arrives *while the drained check is running* opens a fresh window rather than joining the one in flight.
- **There is no fallback poll that re-reads the reference on a fixed interval.** Invalidation relies entirely on this watcher, the IDE's own repository-change events, or the pushed channel.

## Shared Behavior

- **Refresh Escalation Rule (338)** — the sticky, one-way, atomically-drained flag stated inline above in full; that spec is its canonical treatment and is also inlined by spec 289.
- **IntelliJ Project Service Lifecycle (124)** — owns both refreshes, the two disjoint listener lists they wake, the disposed marker this listener checks, and the watcher's start and stop.
- **IDE-Bridge Refresh Notification Channel (289)** — the second, independent path into the same two refreshes, with its own watch targets, filename gates and debounce; that spec and this one describe two mechanisms with one effect.
- **IntelliJ Native Repository Wrapper (126)** — computes the resolved repository root consumed here.
- **CLI Working-Context Service (337)** — owns the note list this component's membership test asks for, and the rule for which backing files a visible note has.
- **Git Operation Queue Worker (34)** — the writer whose object sequence is what the 500-millisecond window exists to collapse.
