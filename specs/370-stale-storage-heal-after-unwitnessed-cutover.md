# 370. Stale Storage Heal After an Unwitnessed Cutover

## Topic Statement

A process that resolved its storage backend once at startup and then holds it for its whole life re-probes the repository's route on its own call paths and rebuilds that backend in place, so a cutover some other surface committed stops it serving a frozen ref — without a restart, and without turning a readable-but-stale read into a hard failure.

## Scope

**In scope:**

- The two symptoms a held pre-cutover backend produces, and the single reason nothing downstream re-asks.
- The shared gate: the state it holds, the order in which it asks its questions, the probe throttle, and its two never-raising failure exits.
- The shared route predicate: which routing states it answers true for, and why each of the others answers false.
- Both hosts' trigger sites, their materially different apply semantics, and the two structurally different latches.
- The typed refusal both hosts catch on a write, and the single retry each performs against it.
- What survives every failure of this mechanism (stale-but-readable storage), and the three places that guarantee does not hold.
- What an un-cut-over repository pays per call, and the bounded read-staleness window the throttle buys.

**Out of scope (boundaries):**

- The freeze marker, what its presence changes, the locked swap that writes it, and the drift probe — covered by **Orphan Branch Cutover Fence and Compare-and-Swap** (345). This spec states only that the write path's refusals are typed and what a catching host does with them.
- The routing states themselves, their two witnesses, and the closed set of conditions that make the database unanswerable — covered by **Cutover Routing State Table** (344).
- The difference between resolving the system of record and resolving read storage, and the three-second route memo one of them keeps — covered by **System-of-Record versus Read Storage Resolution** (346). This spec states only that one host's apply drops that memo.
- The conditions under which the ref-backed write batch refuses at all — defined by **Orphan Branch Summary Storage**.
- The internals of any backend a rebuild produces, and the dual-write composite's read/write fan-out.
- The tool server's own lifecycle, addressing, and per-worktree singleton rule (364).

## Data Contracts

### The gate

One shared state machine holds everything except the apply. Its state:

| Piece | Meaning |
| --- | --- |
| In-flight probe | The promise of a probe currently running, or nothing. Concurrent callers join it rather than starting a second one. |
| Next-probe instant | A wall-clock instant before which no new probe may start. |

Its host-supplied inputs:

| Input | Meaning |
| --- | --- |
| Working directory | The repository this gate probes for. |
| Already-healed predicate | Answers "does this host's storage already read the current source of truth?". Consulted **twice** — before probing, and again after probing but before applying. |
| Apply | Rebuilds this host's storage for a route that has moved off the ref-backed branch. May throw. |
| Probe-failure hook | Optional. |
| Apply-failure hook | Optional. |
| Throttle override | Optional; otherwise the constant below. |

**The probe throttle is five seconds.** It is the only tuning number in the mechanism, and it bounds two things at once: what an un-cut-over repository pays per call, and how long a cut-over repository can keep serving stale reads (see *Bounded staleness*).

### The route predicate

A shared predicate over the routing state, answering "has the system of record moved off the freezable ref?". It is true for exactly the **cut-over** and **legacy-fenced** states. The **un-cut-over** state answers false because the ref-backed branch is still authoritative there, and the **blocked** state answers false because rebuilding when the database cannot be reached would turn readable-but-stale reads into a hard throw.

This is a **product rule, not a host detail**, and its being shared is the point: both hosts route through the one predicate, so the state set is stated once and a further routing state cannot change one host's behavior without changing the other's.

### The typed refusal

The ref-backed write batch's refusals are raised as a distinct error type, so a dispatcher recognises the condition without matching message text. Both refusal sites raise the same type because both mean one thing to a caller: rebuild against the database.

The two sites word themselves differently, and **only one of them gives restart advice**. The freeze-marker site says the process holds a pre-cutover storage object and to restart it, which is correct for every surface *except* the two that implement this heal. The committed-cutover site says only that writes route to the database and to re-run the operation from an up-to-date surface — no restart advice, and correct everywhere.

### Per-host wiring

| | Tool server | Editor host |
| --- | --- | --- |
| Latch | **Derived** — asks whether the currently installed storage still reads from the ref-backed branch | **Stored** — a plain boolean on the bridge instance |
| Latch scope | Per process **and** per working directory (for a per-worktree server, effectively per worktree) | Per workspace root |
| Apply | Awaits the rebuild, **then** installs it as the process-global storage | Sets the latch and drops its caches; the **triggering accessor** then rebuilds, inside its own await |
| Trigger | Once per call, ahead of dispatch | Inside both storage accessors |
| Retry on the typed refusal | Around dispatch, once | Around each orphan-ref writer, once |
| Failure hooks | Probe failure at debug, apply failure at warning, and a successful rebuild logged at info | **None** |

## Behavior

### The failure being healed

Routing decides a backend **only at construction**, and a long-lived process installs or caches one object at startup. The process-global override (and each cached handle) short-circuits both storage resolutions ahead of the system-of-record fallback, so nothing downstream ever re-asks. Two symptoms follow from the same cause, and they are not equally visible:

- **Reads went stale, successfully.** The dual-write composite serves reads from its primary, which before a cutover is the ref-backed backend. After another surface commits the switch, that ref is frozen but still perfectly readable, so every read answered from it — silently missing every memory written to the database since the freeze — with no error anywhere. This is the worse of the two, and the cutover contract already names stale-but-successful as worse than no data at all.
- **One write threw.** The ref-backed write batch re-reads the freeze marker immediately before doing any work, so it refuses. On a *read* path the reachable writer is the lazy catalog rebuild behind search and recall, whose failure is not swallowed at that layer, so the refusal reaches the caller.

### The gate's question order

Each call asks, in order:

1. **Already healed?** Return immediately — no route lookup at all. Cutover is one-way, so storage that reads the system of record never regresses.
2. **A probe already in flight?** Join it. This is what collapses a burst of concurrent calls onto one probe.
3. **Inside the back-off window?** Return.
4. Otherwise **probe** the route, recording the resulting promise as in-flight until it settles.

After the probe:

- If the route predicate answers false — **including a probe that failed**, whose rejection is folded onto the same arm — back off and return. Nothing is swapped and nothing is dropped.
- Otherwise ask the already-healed predicate a second time, because a racing heal may have landed while this one was probing, and return if it has.
- Otherwise apply. A throw from the apply is reported through the apply-failure hook and backed off; it never escapes.

The gate itself never throws, and it carries **no logging of its own** — every log line in this mechanism comes from a host hook or from the route resolution underneath it.

### The tool server's trigger

**Per call, not per connection, and only ahead of built-ins that require a repository.** The heal is awaited before dispatch, gated on that requirement, which excludes three groups: the backend-defined platform tools (they take nothing from the working directory, so they can neither go stale nor hit the refusal), the one built-in whose question is about the tenant rather than this repository, and any name the registry does not match — an unknown tool falls through to the dispatch table's own error rather than paying for a heal.

Per-connection would not work. The reproduction is **one connection that spans the cutover**, so an attach-time check would never fire.

Dispatch is then wrapped in a **typed** retry. Only the refusal type is caught; anything else propagates unchanged. On catching it, the host clears the probe back-off, re-heals — now unthrottled, so it rebuilds against the database — and re-dispatches **once**.

### The editor host's trigger

**On storage resolution, read and write alike.** The signal that drops the cached backends is the route probe itself, not a filesystem event: both storage accessors await the probe before touching their cached handle. Awaiting it in both is also what stops an operation that resolves read *and* write storage from probing twice.

Because the await comes **first** and the cache check second, the rebuild is not deferred to some later accessor: the accessor that triggered the heal finds its handle nulled and rebuilds it on the spot, within the same call. So a failing rebuild throws into whatever operation triggered the heal (see *Where the guarantee does not hold*). The two sites that genuinely defer are the frozen-write retry and the background alias scan below, both of which apply the heal and then re-run — or decline to re-run — the operation themselves.

Applying drops the write handle, the read handle, the cached root listing, the repository-discovery cache, **and** the system-of-record route memo — whose own three-second lifetime would otherwise leave the same staleness one layer down, because this host never installs a process-global override and so resolves every in-process store call through that memo.

Every writer that can reach the ref-backed branch is additionally wrapped in a frozen-retry of its own: storing a summary, storing plans, storing notes, storing external references, saving transcripts in batch, the index-format migration, and the two archive-on-commit paths. Each catches only the refusal type, clears the back-off, re-heals, and re-runs its operation once.

One further site is a **background cross-branch alias scan**, fired and forgotten from a panel read. Its rejection handler treats the refusal as expected: it clears the back-off and re-probes so later operations rebuild, but deliberately does **not** retry its write — a best-effort cross-branch match is not worth failing the panel over — and swallows it rather than logging. Before this mechanism existed that scan had no rejection handler at all, so wiring it also removed an unhandled promise rejection.

The storage users left unwrapped are all reads, or deletes the composite routes to the mirror alone; none of them can reach the refusing write path.

### The two latches, and how the derived one can lie

The tool server's latch is **derived, not stored**: it asks whether the installed storage still reads from the ref-backed branch, which covers both the bare ref-backed backend and the dual-write composite whose primary is that backend. Its trigger also has a **gate-free fast path** — when nothing installed is ref-backed it returns before a gate is even created, so a machine already past its cutover allocates none. The editor host cannot derive its latch the same way: it threads storage explicitly rather than installing a global, so it has no single object to interrogate and keeps a plain boolean instead.

**Three states make the derived latch read "healed" when nothing was healed**, and all three are benign as wired:

- **No storage installed at all.** Only reachable outside a repository, and there every repository-requiring tool is already refused.
- **A bare database-backed object**, which is what a cut-over project produces when the Memory Bank side is refused. It genuinely needs no heal.
- **A bare folder-backed object.** The multi-repository compile sweep installs one per repository as the process global while it works, restoring the previous value afterwards, and such an object reads no ref at all. Benign here because that sweep is not reachable from any of this server's own dispatch paths.

**The predicate does not cover one further declared backend kind** — the read-only backend pinned to a single immutable commit. That is safe only for two reasons that are both properties of that backend rather than of this predicate: its write path throws by design, and it is never installed as the process global (every construction threads it explicitly to one caller). Were one ever installed, this predicate would report "healed" and no heal would ever run against it. (Notable.)

### Failure posture, and what survives it

A probe rejection is caught to nothing. That outcome, an un-cut-over route and a blocked route all take the **same exit**: back off and return, leaving the storage exactly as it was. An apply failure is caught, reported through the optional hook, and backed off.

Stale-but-readable therefore survives every one of them, on both hosts:

| Condition | What happens to the held storage |
| --- | --- |
| Probe failed | Untouched. Nothing swapped, nothing dropped. |
| Route is blocked | Untouched. |
| Route is un-cut-over | Untouched. |
| Route moved, rebuild threw (tool server) | **Untouched** — the apply awaits the rebuild before assigning, so the old object stays installed. |
| Route moved, rebuild threw (editor host) | Already gone, and the throw lands in the operation that triggered the heal — see below. |

### Where the guarantee does not hold

Three places, all as behavior:

1. **Retry exhausted.** If the single re-dispatch also raises the refusal, it is surfaced to the caller as an error result. The in-code claim that the caller never sees the frozen error is therefore an overstatement, and the surfacing case is pinned by its own test. (Surprising.)
2. **One memory-push tool can never take the retry at all.** That path converts *any* throw into a tagged error **value** rather than propagating it, so the dispatcher's type check never runs and no re-dispatch is possible for it. The containment is real, though: the one ref-backed write that path can reach is its own local write-back after a successful publish, and that failure is already caught where it happens and re-reported as its own tagged result (naming the stranded article and warning that a re-push would create a second one), so a retry could not have double-published even if it fired. (Surprising.)
3. **The editor host sets its one-way latch BEFORE the rebuild is known to work, and never clears it.** The apply flips the boolean and drops the caches synchronously, and the accessor that triggered it then rebuilds inside the same call. If the database is unavailable at that moment, storage resolution throws into that very operation, every panel read fails, and the latch guarantees no later probe will run — where before, the user kept getting stale-but-rendered data. Nothing restores the previous object; recovery requires the database to become reachable again. **The two hosts' applies are equivalent only in success.** (Surprising; notable.)

### What an un-cut-over repository pays

Per call on the tool server: the already-healed predicate **twice** — once by the trigger's own gate-free fast path and again as the gate's first question — plus a map lookup and a clock comparison. Beyond that, **one full route probe per five seconds per working directory, forever** — a freeze-marker file read plus a read-only database open, with the repository-identity resolution inside it memoised per process. There is no state in which an un-cut-over repository stops paying that, because the latch can only ever close on a repository that has cut over.

### Bounded staleness

The read-staleness window after an unwitnessed cutover is **at most one probe window**, and it is reads only. Writes are not exposed to it at all: the ref-backed write batch re-reads the freeze marker at the plumbing layer regardless of what any consumer cached, so the worst outcome for a write is the typed refusal — which is what the retries above are for. The window is therefore a display gap, never a data gap.

## State Transitions

Per gate:

- **Cold → probing** — a call arrived with the latch open, no probe in flight, and the back-off window expired.
- **Probing → cold** — the probe settled and the route had not moved (or the probe failed); the back-off window is armed.
- **Probing → latched** — the route had moved and the apply succeeded. One-way: the already-healed predicate now short-circuits every later call, and for the editor host the boolean is never cleared under any condition.
- **Probing → cold, after a failed apply** — reported through the hook and backed off; a later call retries. Reachable on the tool server with its storage intact, and on the editor host with its caches already dropped.
- **Backed off → cold, explicitly** — a caught refusal cleared the window so the very next call re-probes instead of trusting it.
- **Backed off → cleared → backed off again** — see below.

## Notable Behavior

- **Clearing the back-off is silently swallowed whenever a probe is already in flight, and that probe then re-arms the window it just cleared.** The clear only rewrites the next-probe instant; a caller that clears and then re-heals is handed the in-flight promise instead of a fresh probe, and a probe that *started before the freeze* resolves "route has not moved" and backs off again. The retry then runs against un-healed storage and the refusal surfaces — exactly the outcome clearing the back-off exists to prevent — and it repeats for the whole window. This needs no exotic timing: both hosts dispatch concurrently, so a burst of calls routinely has one probe in flight while another call catches the refusal. (Surprising.)
- **The editor host supplies neither failure hook, so a repeatedly failing probe in the product's longest-lived process is entirely silent.** It keeps serving the frozen ref with nothing in the log, while the other host logs the identical condition at debug level. There is no other signal either, because the reads themselves succeed. (Surprising.)
- **The storage swap is process-global and can straddle an in-flight call from a different session on the same server.** The tool server holds one process per worktree and serves several concurrent connections through it, so a call already in flight can have one sub-read resolve the pre-swap backend and the next resolve the post-swap one, and the composed result is returned as a success. The mechanism is grounded; whether any specific list-then-read pair actually produces visible corruption is **unverified** — no such pair was traced. (Surprising.)
- **This is a third distinct treatment of the blocked state in the product.** The two storage resolutions throw on it; the queue drain defers with a terminal error event per queued commit; this gate silently keeps the stale object and backs off. Each is right for its own caller, and the set of three is worth knowing before adding a fourth. (Notable.)
- **The route predicate is stated once, as a product rule**, precisely so a new routing state cannot be honoured in one host and missed in the other: both hosts read the same answer rather than each restating the state set. (Notable.)
- **The already-healed predicate is asked twice per probe, and the second ask is not redundant.** It is the racing re-check: with several calls in flight, one can apply while another is still probing, and re-asking is what stops the second from rebuilding over a fresh object. On the tool server that makes three evaluations on a call that probes, since the trigger asks once more ahead of the gate. (Notable.)
- **One of the two refusal messages is now wrong for the two hosts that catch it.** The freeze-marker one instructs the reader to restart the process; on these two hosts a restart is exactly what the heal removes. The text is unchanged because every other surface still needs it — and the committed-cutover message never gave that advice, so it needs nothing. (Notable.)
- **One reset helper exists on the tool-server side with no production caller** — it drops every gate so a case reusing a working directory starts clean, clearing both the back-off and any in-flight probe together. It is a test seam only. (Unreachable.)

## Shared Behavior

- The freeze marker, the ref-backed write batch's two typed refusals, the locked compare-and-swap that raises them, and the drift probe that catches a writer which bypassed the freeze are defined by **Orphan Branch Cutover Fence and Compare-and-Swap** (345).
- The routing states this mechanism's predicate reads, their two witnesses, and the closed set of conditions that make the database unanswerable are defined by **Cutover Routing State Table** (344).
- The difference between resolving the system of record and resolving read storage, the three-second route memo the editor host's apply drops, and the process-global override that short-circuits both resolutions are defined by **System-of-Record versus Read Storage Resolution** (346).
- The ref-backed backend's plumbing, and the conditions under which its write batch refuses at all, are defined by **Orphan Branch Summary Storage**.
- The dual-write composite whose primary decides whether a held object is pre- or post-cutover, and whose reads are pinned to that primary, are defined by **Dual-Write Summary Storage**.
- The tool server's per-worktree singleton rule, its concurrent connections, and the in-process fallback it degrades to are defined by **MCP Per-Worktree Daemon and Proxy** (364).
