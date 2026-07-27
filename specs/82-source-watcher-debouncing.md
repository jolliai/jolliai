# Source Watcher Debouncing

## Topic Statement

A filesystem watcher used by the dev-server flow that coalesces a burst of edit events into a single re-sync via a debounce timer paired with a dirty-flag re-entrancy guard, so that rapid edits never queue redundant syncs and a sync that is already in flight reliably picks up later edits when it returns.

## Scope

**In scope:**
- The watcher's input contract: source root path, change-handler callback, debounce window, ignore patterns.
- The debounce-and-dirty-flag pattern that decides when to call the handler.
- Re-entrancy: the rule for what happens when more events arrive while a handler is still running.
- Error containment so a thrown handler never tears down the watcher.
- The shutdown handle and the wait-for-in-flight semantics it offers.
- Built-in ignore set and the rule for merging in caller-supplied additions.

**Out of scope:**
- What the change handler actually does (re-staging content, regenerating navigation, etc.).
- The dev-server process the handler triggers.
- Initial-snapshot behavior — only deltas matter to this watcher.
- Any cross-platform peculiarities of the underlying watch primitive beyond noting that one is used.

## Data Contracts

### Watcher options

The starter takes:

- **source root path** (required, string): the directory to observe.
- **change handler** (required, async function returning a promise): called after each settled burst of events; thrown errors are caught and logged.
- **debounce window** (optional, integer, milliseconds): defaults to 100. Time of quiet that must elapse after the last event before the handler fires.
- **ignore patterns** (optional, list of glob patterns): added on top of the built-in ignore set.

### Handle

The starter returns a small handle exposing one operation:

- **close** (async): stops watching and waits for any in-flight handler to finish before resolving.

### Internal state

For the lifetime of one watcher:

- **timer** — at most one outstanding debounce timer at a time; cleared and replaced on each new event.
- **dirty flag** — boolean. Set when the timer fires (handler should run). Re-set whenever new events arrive while a handler is already running.
- **running flag** — boolean. True while a drain pass is executing.
- **closed flag** — boolean. Set on shutdown to abort any pending or future work.
- **in-flight promise** — the currently-executing drain (or a resolved placeholder when idle); shutdown awaits this.

## Behavior

### Setup

1. Resolve the debounce window (default 100 ms).
2. Merge the built-in ignore set with any caller-supplied additions.
3. Open a recursive watch on the source root, with the initial-add events suppressed (only deltas, never the initial snapshot).
4. Subscribe to the three event kinds the watcher responds to: file added, file changed, file removed.
5. Return the handle.

### Per-event trigger

For each of the three subscribed event kinds:

1. If the watcher is already closed, ignore the event.
2. If a debounce timer is pending, clear it.
3. Set a fresh debounce timer for the configured window.
4. When the timer fires:
   a. Clear the timer reference.
   b. Set the dirty flag.
   c. If no drain is currently running, mark a drain as running and start one (capturing its promise as the in-flight promise).

The dirty flag is what bridges from "timer fired" to the actual drain — the drain reads and clears it, picking up any work that was queued during this debounce window.

### Drain pass

A drain pass loops:

1. While the dirty flag is set and the watcher is not closed:
   a. Clear the dirty flag.
   b. Call the change handler and await it.
   c. If the handler throws, catch the error and log it with a prefix ("Error during incremental sync: ..."). Continue the loop.
2. When the loop exits (dirty became false, or the watcher closed), clear the running flag.

This means: at most one handler runs at a time. Any events that arrive while the handler is running set the dirty flag again, and the loop runs the handler one more time after the current one completes — coalescing all of those events into a single follow-up.

### Re-entrancy guard

The combination of "timer fires set dirty + start drain only if not running" plus "drain loops until dirty is clear" enforces:

- A drain in progress will not be re-entered.
- A burst of events during a running drain coalesces into exactly one follow-up handler invocation.
- Bounded loop: between iterations of the drain, the debounce timer can only set the dirty flag once before the next iteration reads it, so the loop terminates after at most two iterations per arriving burst.

### Error containment

The handler is wrapped in try/catch. Any thrown value is normalized to a message string and logged; the loop continues. A failing re-sync (e.g. a temporarily malformed configuration file) does not crash the watcher or block subsequent events.

### Shutdown

On `close`:

1. Set the closed flag so further triggers and drain iterations short-circuit.
2. If a debounce timer is pending, clear it (the pending invocation is dropped).
3. Await the in-flight promise — this returns immediately if no drain is running, otherwise waits for the current drain to settle.
4. Await the underlying watch primitive's own close.

The closed flag is intentionally checked inside the drain loop as well, so a long-running handler's follow-up iteration is skipped if the watcher was closed mid-drain.

## State Transitions

The watcher transitions through:

- **Idle** → **Pending** when the first event arrives and the debounce timer starts.
- **Pending** → **Pending** when a further event arrives during the debounce window (timer is cleared and restarted).
- **Pending** → **Running** when the timer fires; dirty becomes true, drain starts.
- **Running** → **Idle** when the drain loop exits with dirty clear.
- **Running** → **Running-with-followup** when an event arrives mid-handler (dirty is re-armed; the loop will run the handler once more).
- **Any** → **Closed** when shutdown is called; subsequent triggers short-circuit and the loop exits at its next iteration check.

## Notable Behavior

### Default debounce of 100 ms

Short enough that human-perceived latency between save and re-sync is invisible; long enough to coalesce the editor's own multi-event save bursts into one trigger.

### Three event kinds, no rename specifically

The watcher subscribes to add, change, and remove. Renames typically surface as a remove paired with an add and are handled correctly by the dirty-flag coalescing — both events fall into the same debounce window and produce one drain.

### Built-in ignore set

A fixed set of patterns is always ignored regardless of what the caller passes:

- The version-control directory.
- The dependency-install directory.
- The staged build directory.
- The framework's incremental cache directory.
- Common build-output directories (`dist`, `build`, `out`).
- Common editor cruft (OS metadata files, swap files, backup files ending in `~`).

Caller-supplied ignores are appended to this set, never replacing it.

### Initial-add suppression

The watcher suppresses the underlying primitive's initial-add events so the dev-server flow does not run a redundant first sync — the caller is expected to have just run a full sync before starting the watcher.

### Drain's loop is bounded by design

Because only the debounce timer can set the dirty flag (events alone do not), and only one timer can be pending at a time, the dirty flag transitions from clear to set at most once between iterations of the drain loop. So even under a sustained edit storm, the loop runs the handler twice (initial + one follow-up coalescing) before yielding back to the trigger path that re-arms a new timer.

### Logged errors carry a prefix

Errors thrown from the handler are logged with a leading "Error during incremental sync: " so they are recognizable in a noisy dev-server console. The error's message is extracted with a fallback to the value's string form for non-Error throws.

### Close awaits in-flight

A caller that closes during a running handler does not race — the close awaits the in-flight promise, then awaits the underlying primitive's own close. Subsequent events that arrived in flight are not run because the closed flag short-circuits the next loop iteration.

### Factory injection for tests

The watcher accepts an optional override for the underlying watch factory. Tests pass a stub so they do not need to touch the real filesystem; production callers omit the option and get the default.

## Shared Behavior

- **Dev-server orchestrator** — the flow that spins up the watcher with a re-staging change handler and the dev-server process.
- **Site renderer** — the change handler typically calls into renderer code to re-stage content into the build directory.
- **Configuration parser** — handler-level errors (e.g. malformed configuration) are surfaced to the user via the watcher's error containment, not propagated as crashes.
