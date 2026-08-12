# 289. IDE-Bridge Refresh Notification Channel

## Topic Statement

The command-line surface pushes coarse `refresh` notifications at its IDE host whenever one of the directories it watches settles after a debounce window, multiplexed onto the same output stream as bridge responses and distinguished by the **absence** of a correlation id; the host classifies each notification's kind into one of two refreshes, debounces it a second time under a sticky escalation rule, and re-reads from source of truth.

## Scope

**In scope:**
- The watch targets, how each is resolved, their directory-creation asymmetry, and their per-event filename gates.
- The filename-gate rule for an event whose filename the platform withheld.
- Trailing-edge debouncing, non-persistent arming, idempotent arming, and the error handler that tears a watch down.
- The periodic re-arm poll, when it applies, and the quirk that an error *after* successful arming permanently loses that notification kind.
- The notification payload, the one kind that carries a payload, and the difference between an absent payload field and an empty one.
- The declared kind that has no watch target and is never emitted.
- The two coexisting protocol identifiers for the same payload and their divergent handshake parameters.
- Multiplexing over the response stream and the host's route-by-absence-of-id rule.
- The host's pooled-thread hop, its kind classification, its two target refreshes, its second debounce, and the escalation rule that governs the pick.
- The host's mid-session-plan branch, which is the only branch that does work before refreshing.
- The standalone notification-only command, its debounce flag's parsing, its lifecycle — and the fact that no shipped surface spawns it.
- The host-side registry that has degenerated to one hard-wired consumer, and the component's other unreachable paths.

**Out of scope (boundaries):**
- The request/response surface these notifications share a stream with — spec 287.
- The connection that carries them and the reader thread that routes them — spec 288.
- What each triggered refresh actually recomputes, and the two listener fan-outs they drive — spec 124.
- The IDE's **own** native file watcher, which observes overlapping paths in-process and reaches the same two refreshes through a completely separate path — spec 125.
- The registration rules behind the mid-session-plan branch's call (slug derivation, existence, project attribution) — owned by the working-context action of spec 287.
- The queue worker whose writes are what make a watched directory settle — spec 34.

## Data Contracts

### Notification

A JSON-RPC notification — no correlation id:

```
{"jsonrpc":"2.0","method":"refresh","params":{"kind":<kind>,"cwd":<project directory>,"names"?:[<filename>,…]}}
```

`cwd` is the directory the watcher was armed for. The payload is otherwise **deliberately coarse**: no path, no event kind, no hash, no count. It says "something of this kind changed under this project" and leaves the recipient to re-read whatever it needs.

**`names` is present for exactly one kind** — the machine-global agent-plans kind — and absent for every other. It carries the distinct filenames the platform reported during the burst, **sorted**, so the wire is deterministic (the underlying collection iterates in event-delivery order, which varies run to run). Entries are **raw directory entries**, never derived identifiers: turning a filename into a plan identifier is a rule, and rules stay on the command-line side.

**Absent and empty mean different things on the wire.** Absent = "this kind does not carry names". Empty = "this kind does carry names, and the platform reported none" — which is possible because the platform is not obliged to supply a filename with an event. The host collapses both to an empty list, because neither gives it a name to act on, but the distinction is real in the payload.

### Kinds

Six are declared:

| Kind | Emitted? | Signal |
|---|---|---|
| queue | yes | the git-operation queue directory settled |
| orphan-ref | yes | the canonical memory ref's directory settled |
| memory-db | yes | the machine-global memory database (or its write-ahead sibling) settled |
| working-context | yes | the per-project working-context registry was rewritten |
| claude-plans | yes | a markdown file appeared or changed in the machine-global agent-plans directory |
| memory-bank | **never** | — |

**The memory-bank kind is declared and never constructed.** No watch target points at the memory-mirror folder, and nothing anywhere builds a notification with that kind. Changes to that folder produce no notification at all, and any recipient handling for it is unreachable.

### Watch targets (five)

| Kind | Directory | Created if missing? | Per-event filename gate |
|---|---|---|---|
| queue | the project's git-operation queue directory | **yes** — recursively, creation errors swallowed | none |
| orphan-ref | the **leaf parent** of the canonical memory ref file, under the repository's shared git directory | no | none |
| memory-db | the machine-global product state directory | no | filename **starts with** the memory database's base name |
| working-context | the per-project product state directory | **yes** | filename is **exactly** the working-context registry file |
| claude-plans | the machine-global agent-plans directory | no | filename **ends with** the markdown extension |

Three properties of that table are load-bearing:

- **The creation asymmetry is intentional.** The two directories this product owns are created eagerly; the git-owned ref directory and the two directories owned by other software are never conjured — each appears when its owner first writes into it, and the retry poll picks it up then.
- **The orphan-ref target is the leaf parent of the ref file, not the branch prefix one level up.** The underlying watch is non-recursive on at least one platform, and the recursive mode the others offer would also deliver events for unrelated refs; watching one level up would therefore miss every ref update after the very first directory creation. It is resolved through the repository's **shared (common)** git directory rather than the worktree's own, joining a relative answer onto the working directory and falling back to the working directory's git entry when the resolution returns nothing or fails — which is what makes every linked worktree observe the same reference.
- **The memory-db target gates on a directory + filename prefix, not on the database file itself.** Watching a path follows the inode, and the database engine's checkpoint and recovery *replace* these files rather than only appending. The write-ahead sibling is the one that moves per write — the main file's timestamp changes only at checkpoint — so gating on the main file alone would delay the push by an unbounded amount. This target is **machine-global**, so it fires for writes belonging to other repositories too; that is accepted, because the recipient's response is a repository-scoped refresh and over-refreshing is the safe way to be wrong.

**Both memory-writing surfaces are watched because a repository can be on either side of the storage cutover**, and neither watcher can tell which: before it, memories land on the ref and the database is a projection; after it, the ref is frozen and only the database moves. Watching the ref alone left a cut-over repository pushing nothing at all — the sidebar silently stopped updating, with no error anywhere.

### The filename-gate rule for a nameless event

**When a gate is set and the platform reports an event with no filename, the event is dropped.** The gate cannot be honoured without a name, and firing blind on a directory that was only ever watched *because* it is noisy would be worse than missing it — the per-project product state directory also holds a debug log written many times a second. A burst in which **every** event is dropped never arms the debounce timer at all, so a noisy neighbour cannot produce a trigger on its own. Every gated target has an independent fallback path elsewhere.

### Debounce windows

- **Server side, trailing edge.** Each surviving filesystem event clears and restarts the timer; one notification per kind fires once that directory has been quiet for the window. **300 milliseconds** in the request/response server — hard-coded there and not exposed as a flag.
- **Host side.** A second **300-millisecond** non-repeating timer, per project, shared across all kinds.

### Arm-retry cadence

5 seconds.

### Protocol identifiers — two, for the same payload

| Identifier | Emitted by | Handshake parameters |
|---|---|---|
| the request/response identifier | the request/response server, which carries refresh notifications on the **same** output stream as responses | protocol, plugin version, process id |
| the notification-only identifier | a separate, notification-only command that serves no requests | protocol, process id — **no version** |

The `refresh` payload is byte-identical under both. Only the first is ever spawned by a shipped surface.

### The host's kind mirror

The host declares constants for **only two** kinds — the two mid-session ones (`working-context`, `claude-plans`) — and that narrowness is deliberate, not drift. Every other kind, **including any kind the host has never heard of**, falls through to the heavier refresh, which is exactly the handling those kinds want. The protocol treats a new kind as a compatible extension, so an unknown kind must never be an error and must never take the light path.

The kind strings are a cross-language contract: renaming one on the emitting side without mirroring it fails **silently** — the kind stops matching, the light branch never runs, and the panel just goes back to being slow.

## Behavior

### Arming a watch

For each target:

1. If creation is requested, create the directory recursively, swallowing any failure.
2. If the path still does not exist, arming **reports failure** and nothing is attached.
3. Otherwise attach a **non-persistent** directory watch — non-persistent so the watch alone never keeps the process alive — and attach an error handler that **tears the watch down** rather than letting the error propagate out of the event emitter and kill the process.

Arming is **idempotent**: arming an already-armed watcher succeeds immediately without re-attaching, which is what lets the retry poll simply keep calling it.

### Arm-retry poll

When arming reports failure — typical for the ref directory before the first memory is written, and for the agent-plans directory before the user's first plan — a repeating 5-second poll retries and **clears itself on the first success**. Retry timers do not keep the process alive.

### The permanent-loss quirk

The error handler tears the watch down, and the retry poll has already cleared itself once arming first succeeded. Nothing re-arms after that. **So a watcher error occurring *after* successful arming permanently loses that notification kind for the remainder of the process lifetime.** The other kinds keep working, no retry resumes, and nothing reports the loss — the channel becomes partly live and stays that way until whatever spawned the process spawns a new one.

### Emission

On each debounce expiry one notification is serialised and written as a single line, on the same output stream and through the same framing writer that carries every response (spec 287).

### Host routing

The host's reader thread treats **any line with no `id`, or with an `id` of JSON null**, as a notification and routes it by method. A `refresh` is read for its required kind, its working directory (defaulting to empty) and its optional names, then handed off on a **pooled thread** rather than being processed on the reader thread — the reader also carries every request and response line, so any work done there would stall the whole connection. Full routing rules, including what happens to lines that match no method, are in spec 288.

The hand-off reaches a plugin-wide component that, in order:

1. Resets that component's restart backoff value (see the unreachable-paths section — the value is written here and read nowhere reachable).
2. Fires every registered refresh listener, each inside its own catch so one listener's exception cannot stop the others. **The listener list is always empty** (below).
3. Classifies the kind and dispatches.

### Kind classification and the two refreshes

| Kind | Host action |
|---|---|
| `claude-plans` | register the reported filenames, then schedule the **light** refresh |
| `working-context` | schedule the **light** refresh |
| anything else, including unrecognised | schedule the **heavy** refresh |

The heavy refresh is a serialised method wrapping a whole installation-status round trip that then fans out to a wide status listener list, each subscriber of which starts its own reload. The light refresh only repaints the working-area surfaces. The two mid-session kinds cannot change installation state — a plan appearing says nothing about whether hooks are installed — so routing them through the heavy path made the panel wait on a lock and a round trip it had no use for.

### The mid-session-plan branch

For the agent-plans kind only, the host first does work rather than only refreshing. It takes the notification's working directory (falling back to the project's own base path), and if either that is unavailable **or the names list is empty**, it skips straight to the light refresh. Otherwise, on a pooled thread, it hands the **raw filenames** to the command-line surface's registration operation, logs how many were accepted, and then schedules the light refresh.

Two things about this branch:

- **The host contributes only the filenames the platform reported** — which is the one thing it has and the command-line side does not, because the agent-plans directory is machine-global and holds every project's plans ever, so re-listing it cannot answer "what is new?". Every other decision (identifier derivation, existence, already-tracked, project attribution) belongs to the callee.
- **The refresh runs whether or not anything was registered, and whether or not the registration threw.** A failed registration is not fatal: the agent's end-of-turn hook still writes the same rows, which is the behaviour this path exists to *beat* rather than replace.

### The second debounce, on the host

The hand-off resets a per-project non-repeating 300-millisecond interface-thread timer, scheduled with an expiry condition tied to the project's disposal. Any previously pending timer is stopped first, and the whole path bails once the host-side component has been stopped. When the timer elapses, it resolves which of the two refreshes to run and then hops back to a pooled thread to run it.

**The pick between the two refreshes is a sticky, one-way escalation — never last-writer-wins.** One shared timer is correct (the two refreshes are not independent work, and running both would re-read the same registry twice), but which refresh runs is decided by a flag with these exact semantics:

- A heavy signal **sets** the flag; a light signal is a **no-op**, never a demotion. That asymmetry is the rule.
- The flag is read and cleared in **one indivisible step** when the timer fires, so a heavy signal arriving mid-drain either lands in the window being drained or survives into the next one, never neither.
- Recording is a bare write of true, never a read-modify-write, so two concurrent heavy signals cannot interleave and lose one.
- The drain happens **before** the hop to the pooled thread; draining after the hop would leave the flag set across the hop and let a signal arriving mid-dispatch be consumed by the refresh already in flight.
- Teardown clears the flag from whatever thread invoked disposal rather than deferring to the interface thread, because disposal must finish synchronously; that is safe only because the stopped marker is already set and the scheduling path returns early on it.

**Why demoting would be a bug rather than a tuning choice:** an agent that commits at the end of its turn emits a commit-time notification when the summary lands and a working-context one moments later when the end-of-turn hook rewrites the registry. Demoting there drops the heavy refresh, and **nothing polls to recover it** — the memory the user just watched being created simply never appears in the sidebar until some unrelated event arrives. Escalation is one-way by design, and being heavier than necessary is the safe way to be wrong. (Canonical treatment: spec 338. The same rule, and the same shared component, also governs the IDE's own file-system watcher — spec 125.)

**A refresh is therefore debounced twice** — once by the server-side watcher's window and again here — so the latency from the final filesystem write to a visible refresh is the sum of the two windows, and a burst that straddles the first window's expiry can still be coalesced by the second.

### The host-side registry has degenerated, and most of the component around it is unreachable

The host exposes a listener-registration interface for refresh events, but **nothing registers**: the listener list is always empty in production. The only live effect of a notification is the classify-and-refresh path above (plus, for the plans kind, the registration call).

Its lifecycle entry point likewise does nothing: the call the startup activity makes to "start" it only records that it was started — it spawns no process and opens no channel (spec 124). Everything reachable **only** from that absent spawn is dead code in production:

- spawning the notification-only command, and its read loop;
- parsing the handshake, checking its protocol identifier, and the disconnect-on-mismatch path;
- process-exit detection;
- the escalating restart backoff (5 s, doubling, capped at 60 s) and the restart scheduler.

The backoff value is nonetheless **written on every notification** (step 1 of the hand-off) and read only by the restart scheduler, which nothing can reach. The live entry point into the component is the injection call the bridge connection makes; everything above it in the file is reachable only from tests.

### The standalone notification-only command

A separate hidden command emits the same handshake-then-refresh stream over its own protocol identifier and serves **no requests at all**. It differs from the request/response server in four ways:

- It accepts a debounce flag, defaulting to the same 300 milliseconds. Parsing requires a non-negative integer, so a trailing-garbage value fails — but `"0"` is accepted (0 milliseconds, defeating coalescing entirely), an **empty string is also accepted and also yields 0**, and surrounding whitespace is tolerated.
- Its handshake omits the version field.
- It tracks its retry timers in a set rather than a list, specifically so that removing an already-removed timer is a harmless no-op instead of silently corrupting the collection.
- Its lifecycle is: emit the handshake, arm the watchers, then resolve when standard input reaches end **or** closes (guarded by a once-only flag so either signal resolves exactly once), then stop every watcher and clear every retry timer. It also explicitly resumes standard input, because on some hosts standard input begins paused. There is no idle timeout and no signal handling.

**No shipped surface spawns it.** It is reachable only by a person typing the command. Its watch targets, gates, debounce and payload are otherwise identical to the request/response server's, because both build their target list and their payload from the same two shared functions — which is what stops the two from drifting into watching or emitting different things.

One difference is not shared: the request/response server passes through only the agent-plans directory override, not the machine-global product state directory override, so its memory-db target always watches the real machine-global directory.

## State Transitions

### One watch target

```
[unarmed] ── directory exists, or was created ────────────> [armed]
[unarmed] ── directory missing and not created ───────────> [retrying every 5 s]
[retrying] ── first successful retry ────────────────────> [armed]  (poll cleared)
[armed] ── watcher error ───────────────────────────────> [permanently lost]
                                                           (torn down; never re-armed;
                                                            not reported)
[armed] ── input end ──────────────────────────────────> [stopped]
```

### One settle, end to end

```
[filesystem events]
   → filename gate (nameless event dropped when a gate is set)
   → trailing-edge debounce (300 ms, server)
   → one notification on the response stream, names only for the plans kind
   → host reader: no id → notification → route by method
   → pooled-thread handoff → backoff reset → (empty) listener fan-out
   → classify kind
        ├─ plans kind        → register raw filenames → record LIGHT
        ├─ working-context   → record LIGHT
        └─ anything else     → record HEAVY
   → debounce (300 ms, host, interface-thread timer, sticky escalation)
   → drain (indivisible) → pooled thread → heavy or light refresh
```

## Notable Behavior

- **The payload is coarse on purpose, with exactly one exception.** A kind and a directory is all the recipient gets for five of the six kinds, so it always re-reads from scratch rather than applying a delta. The plans kind is the exception because re-reading cannot answer its question: its directory is machine-global and holds every project's plans ever, so the only thing that distinguishes a plan authored seconds ago from one authored last month is the OS event — and that information dies with the event unless it rides along.
- **A declared kind is never emitted.** The memory-mirror kind exists in the type and nothing constructs it; no watcher targets that folder. Changes there produce no notification.
- **Two watch targets are machine-global, so a project receives notifications caused by other repositories.** The memory-database target and the agent-plans target both fire for writes that have nothing to do with the receiving project. That is accepted rather than filtered: the response is a repository-scoped refresh, and for the plans kind attribution is the callee's job, not the watcher's.
- **A filename-gated watcher goes silent rather than firing blind.** On a platform (or for an event) that supplies no filename, a gated target drops the event entirely. That is the correct trade only because the gated directories are noisy — one of them carries a log written many times a second — and because each gated target has an independent fallback elsewhere.
- **The ref directory watched is the leaf parent, not the branch prefix.** Watching one level up looks equivalent and is not: after the very first directory creation, every subsequent ref update would go unobserved.
- **Two protocol identifiers exist for one payload, and only one is live.** The notification-only command's identifier and its version-less handshake are unreachable in practice; the live handshake check in the host is against the request/response identifier.
- **Notifications and responses share one stream, distinguished only by a missing correlation id.** That single rule is what makes the multiplexing work — and it is also what silently swallows the server's malformed-line error envelope, which carries a null id and no method (spec 288).
- **Every refresh is debounced twice.** Two independent 300-millisecond windows sit between the last write and the visible refresh. Neither is configurable in the server that is actually spawned.
- **A light notification can never demote a pending heavy one, and that asymmetry is the whole point.** Nothing polls to recover a dropped status refresh, so demotion is silent and permanent for that event.
- **An unknown kind is deliberately treated as heavy.** The host declares constants for only the two mid-session kinds; a kind added on the emitting side and not mirrored keeps working, just at the cost of a heavier refresh than it needs. The failure mode of a *renamed* kind is the opposite and worse: it silently stops matching the light branch, with no error anywhere.
- **A watcher error after successful arming is unrecoverable for the process lifetime.** The tear-down-on-error handler exists so the error does not propagate out of the emitter and kill the process, but nothing re-arms afterwards and the retry poll is already gone. The channel degrades silently.
- **The watches are non-persistent, so the channel never keeps the process alive.** Shutdown is driven entirely by end of input (spec 287); a server with armed watchers and no work still exits promptly when its input closes.
- **The queue and working-context directories are created eagerly and the other three are not.** So those two kinds arm on the very first attempt in a fresh project, while the ref, database and agent-plans kinds normally spend their early life in the retry poll.
- **The host's registry is empty and its start call is a no-op.** A reader expecting a channel after startup, or expecting registered listeners to receive events, will find neither: the channel comes up with the first bridge call, and the single consumer is hard-wired. The spawn, handshake-check, process-exit and restart-backoff machinery in that same component is unreachable in production — including a backoff value that is written on every single notification and read only from an unreachable path.
- **The notification-only command's debounce flag admits the exact value its validation was meant to prevent.** Both an empty string and `"0"` parse to zero milliseconds, which disables coalescing outright.
- **This channel duplicates the IDE's own native watcher.** The IDE separately watches overlapping paths in-process and reaches the same two refreshes through its own 500-millisecond debounce (spec 125). The two mechanisms are unsynchronised and independently debounced, and they do **not** share a debounce flag instance — so **a single queue-worker run can drive two refreshes**, each of which is itself a bridge round trip (spec 124).

## Shared Behavior

- **Refresh Escalation Rule (338)** — the sticky, one-way, atomically-drained flag that decides which refresh a mixed debounce window runs. Stated inline above in full; that spec is its canonical treatment and is also inlined by spec 125.
- **CLI IDE-Bridge Command Surface (287)** — owns the stream these notifications are multiplexed onto, its single framing writer, the handshake that precedes them, the end-of-input shutdown that stops the watchers, and the registration operation the plans branch calls.
- **IntelliJ CLI Daemon Connection (288)** — owns the connection that carries them, the reader thread's routing rules, and the lazy creation that means this channel does not exist until the first bridge call.
- **IntelliJ Project Service Lifecycle (124)** — owns the two refreshes a notification ultimately triggers, their two separate listener fan-outs, and the lifecycle call to the host-side component that starts nothing.
- **IntelliJ Orphan-Branch Ref Monitoring (125)** — the IDE's own in-process watcher over overlapping paths, which reaches the same two refreshes independently and under the same escalation rule; that spec and this one describe two mechanisms with one effect.
- **Git Operation Queue Worker (34)** — the writer whose blob/tree/commit/ref sequence is what the debounce window exists to collapse.
