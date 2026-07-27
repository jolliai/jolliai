# 289. IDE-Bridge Refresh Notification Channel

## Topic Statement

The command-line surface pushes coarse `refresh` notifications to its IDE host whenever a project's git-operation queue directory or its orphan-branch ref directory settles after a debounce window. The notifications are multiplexed onto the same output stream as bridge responses, and the host distinguishes them by the **absence** of a correlation id. The payload is deliberately minimal — a kind and a working directory, nothing more — and the host debounces it a second time before asking its project service to refresh, so one filesystem settle is debounced twice before anything becomes visible.

## Scope

**In scope:**
- The two watch targets, how each is resolved, and their asymmetric directory-creation behavior.
- Trailing-edge debouncing, non-persistent arming, idempotent arming, and the error handler that tears a watch down.
- The periodic re-arm poll, when it applies, and the grounded quirk that an error *after* successful arming permanently loses that notification kind.
- The notification payload and its deliberate coarseness.
- The third declared kind that is never emitted.
- The two coexisting protocol identifiers for the same payload and their divergent handshake parameters.
- Multiplexing over the response stream and the host's route-by-absence-of-id rule.
- The host's pooled-thread hop and its second debounce.
- The standalone notification-only command, its debounce flag's parsing, its lifecycle — and the fact that no shipped surface spawns it.
- The host-side registry that has degenerated to one hard-wired consumer.

**Out of scope (boundaries):**
- The request/response surface these notifications share a stream with — spec 287.
- The connection that carries them and the reader thread that routes them — spec 288.
- What the triggered refresh actually recomputes, and the listener fan-out it drives — spec 124.
- The IDE's **own** native file watcher, which observes overlapping paths inside the IDE process and drives the same refresh through a completely separate path — spec 125.
- The queue worker whose writes are what make a watched directory settle — spec 34.

## Data Contracts

### Notification

A JSON-RPC notification — no correlation id:

```
{"jsonrpc":"2.0","method":"refresh","params":{"kind":<kind>,"cwd":<project directory>}}
```

`cwd` is the directory the watcher was armed for. The payload is **deliberately coarse**: no path, no event kind, no hash, no count. It says only "something of this kind changed under this project" and leaves the recipient to re-read whatever it needs.

### Kinds

Three are declared: `queue`, `orphan-ref`, `memory-bank`.

**Only two are ever produced.** `memory-bank` is declared in the type and named in the surface's own description of what it watches, but **no code path constructs it** — no watch target points at the Memory Bank folder. It is never emitted, and any recipient handling for it is unreachable.

### Watch targets (two)

| Kind | Directory | Created if missing? |
|---|---|---|
| `queue` | `<project>/.jolli/jollimemory/git-op-queue` | **Yes** — created recursively, with creation errors swallowed |
| `orphan-ref` | `<shared git directory>/refs/heads/jollimemory/summaries` | **No** |

The asymmetry is intentional: the queue directory belongs to this product and can be created eagerly, while the ref directory belongs to git and must not be conjured — it comes into existence when the first memory is written.

The orphan-ref directory is resolved through the repository's **shared (common) git directory** rather than the worktree's own, joining a relative answer onto the working directory and falling back to the working directory's `.git` when the resolution returns nothing or fails. **This is what makes every linked worktree observe the same reference** — a per-worktree git directory would have no orphan ref in it at all.

### Debounce windows

- **Server side, trailing edge.** Each raw filesystem event clears and restarts the timer; one notification fires once the directory has been quiet for the window. **300 milliseconds** in the request/response server — hard-coded there and not exposed as a flag.
- **Host side.** A second **300-millisecond** non-repeating timer, per project.

### Arm-retry cadence

5 seconds.

### Protocol identifiers — two, for the same payload

| Identifier | Emitted by | Handshake parameters |
|---|---|---|
| `jolli-ide-bridge-jsonrpc-v1` | the request/response server, which carries refresh notifications on the **same** output stream as responses | `protocol`, `pluginVersion`, `pid` |
| `jolli-daemon-notify-v1` | a separate, notification-only command that serves no requests | `protocol`, `pid` — **no version** |

The `refresh` payload is byte-identical under both. Only the first is ever spawned by a shipped surface.

## Behavior

### Arming a watch

For each target:

1. If creation is requested, create the directory recursively, swallowing any failure.
2. If the path still does not exist, arming **reports failure** and nothing is attached.
3. Otherwise attach a **non-persistent** directory watch — non-persistent so the watch alone never keeps the process alive — and attach an error handler that **tears the watch down** rather than letting the error propagate out of the event emitter.

Arming is **idempotent**: arming an already-armed watcher succeeds immediately without re-attaching.

### Arm-retry poll

When arming reports failure — typically for the orphan-ref directory, which does not exist until the first memory is written — a repeating 5-second poll retries and **clears itself on the first success**. Retry timers do not keep the process alive.

### The permanent-loss quirk

The error handler tears the watch down, and the retry poll has already cleared itself once arming first succeeded. Nothing re-arms after that. **So a watcher error occurring *after* successful arming permanently loses that notification kind for the remainder of the process lifetime.** The other kind keeps working, no retry resumes, and nothing reports the loss — the channel simply becomes half-live and stays that way until whatever spawned the process spawns a new one.

### Emission

On each debounce expiry one notification is serialised and written as a single line, on the same output stream and through the same framing writer that carries every response (spec 287).

### Host routing

The host's reader thread treats **any line with no `id`, or with an `id` of JSON null**, as a notification and routes it by `method`. A `refresh` is read for its required `kind` and its `cwd` (defaulting to empty), and then handed off on a **pooled thread** rather than being processed on the reader thread — the reader also carries every request and response line, so any work done there would stall the whole connection. Full routing rules, including what happens to lines that match no method, are in spec 288.

### The second debounce, on the host

The handoff resets a per-project non-repeating 300-millisecond UI-thread timer, scheduled with an expiry condition tied to the project's disposal. Any previously pending timer is stopped first. When it elapses, it hops back to a pooled thread and calls the project service's status refresh. The whole path also bails once the host-side client has been stopped.

**A refresh is therefore debounced twice** — once by the server-side watcher's window and again here — so the latency from the final filesystem write to a visible refresh is the sum of the two windows, and a burst that straddles the first window's expiry can still be coalesced by the second.

### The host-side registry has degenerated

The host exposes a listener-registration API for refresh events, but **nothing registers**: the listener list is always empty. The only live effect of a refresh is the status refresh described above.

Its lifecycle entry point likewise does nothing: the call the startup activity makes to "start" it only records that it was started — it spawns no process and opens no channel (spec 124). Everything else the component declares is unreachable: spawning the notification-only command, its read loop, its own protocol check and mismatch-disconnect path, its process-exit handling, and its escalating restart backoff all have **no caller**. A backoff value is written on every refresh and read by nothing.

### The standalone notification-only command

A separate hidden command emits the same handshake-then-refresh stream over its own protocol identifier and serves **no requests at all**. It differs from the request/response server in three ways:

- It accepts a debounce flag, defaulting to the same 300 milliseconds. Parsing requires an integer and rejects a negative value, so a trailing-garbage value fails — but `"0"` is accepted (0 milliseconds, defeating coalescing entirely), an empty string is accepted and also yields 0, and surrounding whitespace is tolerated.
- Its handshake omits the version field.
- Its lifecycle is: emit the handshake, arm the watchers, then resolve when standard input reaches end **or** closes (guarded by a once-only flag so either signal resolves exactly once), then stop every watcher and clear every retry timer. It also explicitly resumes standard input, because on some hosts standard input begins paused. There is no idle timeout and no signal handling.

**No shipped surface spawns it.** It is reachable only by a person typing the command. Its watch targets, debounce, and payload are otherwise identical to the request/response server's.

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
   → trailing-edge debounce (300 ms, server)
   → one notification on the response stream
   → host reader: no id → notification → route by method
   → pooled-thread handoff
   → debounce (300 ms, host, UI-thread timer)
   → pooled thread → project status refresh
```

## Notable Behavior

- **The payload is coarse on purpose.** A kind and a directory is all the recipient gets, so the recipient always re-reads from scratch rather than trying to apply a delta. This keeps the wire trivially stable — the payload has never needed to change shape — at the cost of a full status recomputation per notification.
- **A declared kind is never emitted.** `memory-bank` exists in the type and in the surface's own description of what it watches, but nothing constructs it and no watcher targets that folder. Memory Bank folder changes produce **no** notification.
- **Two protocol identifiers exist for one payload, and only one is live.** The notification-only command's identifier and its version-less handshake are unreachable in practice; the live handshake check in the host is against the request/response identifier.
- **Notifications and responses share one stream, distinguished only by a missing correlation id.** That single rule is what makes the multiplexing work — and it is also what silently swallows the server's malformed-line error envelope, which carries a null id and no method (spec 288).
- **Every refresh is debounced twice.** Two independent 300-millisecond windows sit between the last write and the visible refresh. Neither is configurable in the server that is actually spawned.
- **A watcher error after successful arming is unrecoverable for the process lifetime.** The tear-down-on-error handler exists so the error does not propagate out of the emitter, but nothing re-arms afterwards and the retry poll is already gone. The channel degrades silently to a single kind.
- **The watches are non-persistent, so the channel never keeps the process alive.** Shutdown is driven entirely by end of input (spec 287); a server with armed watchers and no work still exits promptly when its input closes.
- **The queue directory is created eagerly and the ref directory is not.** As a result the queue kind arms on the very first attempt in a fresh project, while the orphan-ref kind normally spends its early life in the retry poll.
- **The host's registry is empty and its start call is a no-op.** A reader expecting a channel after startup, or expecting registered listeners to receive events, will find neither: the channel comes up with the first bridge call, and the single consumer is hard-wired.
- **The notification-only command's debounce flag admits the exact value its validation was meant to prevent.** Both an empty string and `"0"` parse to zero milliseconds, which disables coalescing outright.
- **This channel duplicates the IDE's own native watcher.** The IDE separately watches overlapping paths in-process and drives the same status refresh through its own 500-millisecond debounce (spec 125). The two mechanisms are unsynchronised and independently debounced, so **a single queue-worker run can drive two status refreshes** — and each refresh is itself a bridge round-trip (spec 124).

## Shared Behavior

- **CLI IDE-Bridge Command Surface (287)** — owns the stream these notifications are multiplexed onto, its single framing writer, the handshake that precedes them, and the end-of-input shutdown that stops the watchers.
- **IntelliJ CLI Daemon Connection (288)** — owns the connection that carries them, the reader thread's routing rules, and the lazy creation that means this channel does not exist until the first bridge call.
- **IntelliJ Project Service Lifecycle (124)** — owns the status refresh a notification ultimately triggers, its listener fan-out, and the lifecycle call to the host-side client that starts nothing.
- **IntelliJ Orphan-Branch Ref Monitoring (125)** — the IDE's own in-process watcher over overlapping paths, which reaches the same refresh independently; that spec and this one describe two mechanisms with one effect.
- **Git Operation Queue Worker (34)** — the writer whose blob/tree/commit/ref sequence is what the debounce window exists to collapse.
