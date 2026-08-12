# 338. Refresh Escalation Rule

## Topic Statement

One shared sticky flag decides which of two non-interchangeable refreshes a debounce window owes — settable only by a heavy signal, never clearable by a light one — so that a window mixing both escalates rather than demotes.

## Scope

**In scope:**
- The two-valued question the flag answers, and why it exists rather than being derived per-signal.
- The three operations on it, their exact semantics, and the asymmetry that *is* the rule.
- The atomicity guarantees: why recording is set-only, why draining is read-and-clear in one step, and what each protects against.
- The ordering obligation the flag places on its callers (drain before leaving the timer thread).
- The teardown operation and why it is deliberately not the drain.
- The grounded failure this exists to prevent.

**Out of scope (boundaries):**
- The two debouncers that use it, their windows, and what feeds them — the push channel is spec 289, the IDE's own file-system watcher is spec 125.
- What either refresh actually recomputes, and the two listener fan-outs they wake — spec 124.
- The classification step upstream of it that decides which signal a given change is — owned by whichever debouncer produced the signal.

## Data Contracts

### The flag

One boolean per debouncer instance, initially false. It answers exactly one question:

> **Does the debounce window that is currently open owe a status recompute (the heavy refresh), rather than only a working-context repaint (the light one)?**

There is no third state and no per-signal record. The flag is not a count, not a queue, and not a set of kinds — the two refreshes are strictly either/or, so one bit is the whole contract.

### The three operations

| Operation | Semantics |
|---|---|
| **Record one signal** | A heavy signal sets the flag. A light signal **does nothing at all** — it is never a demotion. |
| **Drain the window** | Read and clear in **one indivisible step**, returning what the window that just ended owed and opening the next window clean. |
| **Clear** | Set the flag false, discarding the answer. Teardown only. |

The recording asymmetry — set on heavy, no-op on light — **is** the escalation rule. Everything else in this spec exists to keep that asymmetry from being defeated by concurrency or by ordering.

### Concurrency contract

The flag is safe for concurrent access from any thread. That is deliberately stricter than one of its two users needs (which confines every access to the interface thread); the other records from a file-system-listener thread and drains on the interface thread. Writing it for the stricter caller means no caller can be wrong by using it.

## Behavior

### Recording a signal

A heavy signal writes `true`. A light signal writes nothing.

**Recording is a bare write, never a read-modify-write.** The obvious spelling — "flag becomes flag-or-this-signal" — is not atomic: two concurrent heavy signals can interleave their read and write phases and lose one of the `true`s, which defeats the escalation in precisely the concurrent case it exists for. A lone write of `true` cannot be lost, and only draining or clearing ever writes `false`.

### Draining a window

When a debouncer's timer fires it drains, and dispatches the heavy refresh when the drain returned true and the light one otherwise.

**The drain must be a single indivisible read-and-clear**, not a read followed by an assignment. The pair leaves a real, if narrow, window of its own: a heavy signal landing between the read and the write is overwritten by that write, and the newly opened window starts without the flag — the exact loss the stickiness exists to prevent, merely relocated. With one indivisible step, a concurrent heavy signal either lands inside the window being drained or survives into the next one, and never in neither.

### The ordering obligation on callers

**A caller must drain before it hands off to another thread.** Both debouncers hop off their timer thread to run the refresh itself; draining after the hop would leave the flag set across the hop, so a signal arriving mid-dispatch would be consumed by the refresh already in flight instead of opening a fresh window. Both callers therefore drain on the timer thread and carry the resulting boolean across the hop as a plain value.

### Teardown

Teardown clears the flag rather than draining it, so that a caller discarding the value reads as intent rather than as a dropped result. Both callers clear from whatever thread invoked disposal rather than hopping to the interface thread — disposal has to finish synchronously — which is safe only because each one's own "disposed" marker is set *before* the clear and its scheduling path returns early on that marker, so no later write can race it. The worst case is a timer callback already queued on the interface thread draining a cleared flag and skipping a refresh for a component being torn down. **Wrapping that teardown clear in a deferred interface-thread hop would be wrong**: it would let disposal return before the flag is cleared.

## State Transitions

### One debounce window

```
[window open, owes light]  ── light signal ──> [window open, owes light]   (no-op)
[window open, owes light]  ── heavy signal ──> [window open, owes HEAVY]
[window open, owes HEAVY]  ── light signal ──> [window open, owes HEAVY]   (never demoted)
[window open, owes HEAVY]  ── heavy signal ──> [window open, owes HEAVY]

[any]  ── timer fires: drain ──> heavy or light refresh dispatched,
                                 next window opens owing light
[any]  ── teardown: clear ─────> next window (if any) opens owing light
```

## Notable Behavior

- **The collision this prevents is routine, not hypothetical.** An agent that commits at the end of its turn produces a commit-time signal when the summary lands, and a working-area signal moments later when the end-of-turn hook rewrites the working-context registry. Under last-writer-wins, that second signal demotes the pending heavy refresh — and **nothing polls to recover it.** The memory the user just watched being created simply never appears in the sidebar until some unrelated event happens to arrive. This is the entire reason the rule exists.
- **Escalation is one-way on purpose.** Being heavier than necessary costs one extra round trip and one extra listener fan-out. Being lighter than necessary costs a refresh that never happens and that nothing retries. The two errors are not symmetric, so the rule is not symmetric.
- **The flag cannot express "both".** The heavy refresh is deliberately **not** a superset of the light one — it wakes a different listener list — so escalating a mixed window genuinely skips the light refresh's own subscribers. That is a known, tolerated consequence: it is only harmless while every light-refresh subscriber is also on the heavy refresh's list, and nothing enforces that (spec 124). (Notable.)
- **The rule became a shared component because two hand-written copies of it had already drifted apart in review terms** — each one's comments told the other to stay in step, and neither could be tested, because both were private state behind a timer and a thread hop with no seam to drive. Extracting it made the lockstep mechanical and the cases reachable.
- **Both dangerous spellings look tidier than the correct one.** "Flag becomes flag-or-signal" for recording, and "read the flag, then set it false" for draining, are each the natural way to write the step, and each reintroduces exactly the loss the component exists to prevent — in the recording case for concurrent heavy signals, in the draining case for a heavy signal that arrives mid-drain.
## Shared Behavior

This rule is **inlined in full** by both of its users; neither may restate it in its own terms:

- **IDE-Bridge Refresh Notification Channel (289)** — the pushed-notification debouncer. Its classification step sends only the two working-area notification kinds to light; every other declared kind, and anything unrecognised, is heavy.
- **IntelliJ Orphan-Branch Ref Monitoring (125)** — the IDE's own file-system-watcher debouncer. Its classification step examines every path in a delivered batch (rather than stopping at the first match) precisely so that a mixed batch produces *both* calls into this component, since this component can only merge calls that actually happen.
- **IntelliJ Project Service Lifecycle (124)** — owns the two refreshes the drained boolean selects between, and the two separate listener lists that make them non-interchangeable.
