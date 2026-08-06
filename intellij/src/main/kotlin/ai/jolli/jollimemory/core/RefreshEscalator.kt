package ai.jolli.jollimemory.core

import java.util.concurrent.atomic.AtomicBoolean

/**
 * The sticky "this debounce window owes a status refresh" flag, shared by the two
 * places that debounce refreshes.
 *
 * ## What it protects
 *
 * Both debouncers collapse a burst of signals onto ONE timer and then have to pick
 * ONE refresh to run when it fires. The two refreshes are not interchangeable:
 * `refreshWorkingContext` repaints the working-area panels, while `refreshStatus`
 * additionally re-runs an `ide-bridge status` round-trip and wakes the fourteen
 * status listeners the commits and memories panels sit on. So the pick must not be
 * last-writer-wins — a light signal landing on top of a pending heavy one must
 * ESCALATE, never demote.
 *
 * That collision is routine, not hypothetical. An agent that commits at the end of
 * its turn emits an orphan-ref signal when the summary lands and a working-context
 * one when the StopHook rewrites `plans.json` moments later. Demote there and the
 * status refresh is simply dropped, with nothing polling to recover it: the memory
 * the user just watched being created never appears in the sidebar. Escalation is
 * one-way by design, and being heavier than necessary is the safe way to be wrong.
 *
 * ## Why it is a type
 *
 * The rule used to be two hand-written `pendingStatusRecompute` fields — one in
 * `DaemonNotificationClient` for the push channel, one in `JolliMemoryService` for
 * the VFS fallback — whose doc comments told each other to "keep the two in step".
 * Neither had a test, because both were private state behind a Swing `Timer` and an
 * EDT hop with no seam to drive. One type with the rule in it makes the lockstep
 * mechanical instead of social, and makes the cases below reachable — the same move
 * that made `classifyVfsBatch` testable.
 *
 * ## Thread safety
 *
 * Deliberately stricter than either caller needs. `DaemonNotificationClient`
 * confines every access to the EDT; `JolliMemoryService` records from the VFS
 * listener thread and drains on the EDT. Written for the second, so a caller can
 * never be wrong by using it.
 *
 * [record] is set-only and never read-modify-write: `x = x || flag` is not atomic,
 * so two concurrent commit-time signals could interleave and lose the `true` —
 * defeating the escalation in exactly the concurrent case it exists for. A lone
 * write of `true` cannot be lost, and only [drain] and [clear] clear it.
 */
internal class RefreshEscalator {

    private val pending = AtomicBoolean(false)

    /**
     * Records one signal in the current window. A `true` is sticky for the life of
     * the window; a `false` is a no-op rather than a demotion — that asymmetry IS
     * the escalation rule.
     */
    fun record(statusRecompute: Boolean) {
        if (statusRecompute) pending.set(true)
    }

    /**
     * Reads and clears in one step: returns whether the window that just ended owes
     * a status recompute, and opens the next window clean.
     *
     * Atomic rather than the read-then-assign pair this replaces, which left a real
     * (if narrow) window of its own: a `record(true)` landing between the read and
     * the write was clobbered by the write, and the newly-opened window started
     * without the flag — the exact loss the stickiness exists to prevent, just
     * moved. `getAndSet` closes it, so a concurrent `record(true)` either lands in
     * the window being drained or survives into the next one, never neither.
     *
     * Call this BEFORE hopping off the timer thread. Draining after the hop would
     * leave the flag set across the hop, so a signal arriving mid-dispatch would be
     * consumed by the refresh already in flight instead of opening a fresh window.
     */
    fun drain(): Boolean = pending.getAndSet(false)

    /**
     * Teardown. Separate from [drain] so a caller discarding the value reads as
     * intent rather than as a dropped result.
     */
    fun clear() {
        pending.set(false)
    }
}
