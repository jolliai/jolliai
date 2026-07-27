# 288. IntelliJ CLI Daemon Connection

## Topic Statement

Every command-line bridge call the IntelliJ plugin makes is served, when possible, from a lazily spawned, per-project, long-lived newline-delimited-JSON connection, and otherwise from a one-shot process-per-call spawn. Deciding which is a single choice made per call: resolve a connection for the call's working directory, use it if one exists, and fall back to a spawn on almost any failure — with two deliberate exceptions that must **never** fall back, one because it is the server's real answer and one because falling back would execute a side-effectful operation twice. The connection is gated behind a versioned handshake, respawned when the bundled runtime's version stamp changes, and shut down by closing its input and letting it drain rather than by killing it.

## Scope

**In scope:**
- The single call entry point and its prefer-connection-then-fall-back decision, including the two exception classes that are rethrown rather than retried.
- Project matching for a requested working directory, and the arbitrary-project fallback used by calls that have no project of their own.
- The spawn shape, its environment marker, and the two hard failures that prevent it.
- The handshake gate, its budget, and the exact protocol-string check.
- Version-drift-triggered respawn and the atomicity it depends on.
- Per-connection in-flight scoping, correlation-id allocation, and what happens when a connection's process dies.
- The per-call budget.
- The reader thread's routing rules, and the two grounded dead-letter cases.
- The shutdown sequence and its stated platform rationale.

**Out of scope (boundaries):**
- The served surface itself — the action catalogue, the envelope, the validators, the redaction rules, and the server's own concurrency and shutdown behavior — spec 287.
- The refresh notifications this connection also carries — spec 289.
- Resolving the Node runtime the spawn needs, and the hard gate in front of it — spec 284.
- The bundled runtime artifact, its extraction, and the version stamp's own write contract — spec 128.
- Each action's domain semantics, and each caller's use of it.

## Data Contracts

### Request line

One line per call, newline-terminated:

```
{"jsonrpc":"2.0","id":<positive integer>,"method":<action>,"params":{"cwd":<directory>,"request":<body>}}
```

Correlation ids come from a per-connection counter that starts at 1 and increments per call. A null or blank request body becomes `{}`. A request body that is valid JSON but **not** an object — an array, a string, a number — is rejected **client-side**, before anything is written, so it never reaches the server.

### Per-call budget

300 seconds by default, applied to both transports; callers may pass a shorter value. Nothing in the plugin marshals these calls off the UI thread on their behalf, so **a bridge call made on the UI thread can block for up to five minutes.**

### Failure mapping

| Server outcome | Host result |
|---|---|
| response carrying a top-level `error` object | a **business-error** exception carrying `data.errorName`, the error's `message` (defaulting to `"unknown CLI bridge error"`), and the whole `data` object |
| one-shot spawn exits non-zero with no error envelope | a generic runtime failure naming the exit code |
| no response within the budget on the connection | a distinct **timeout** exception |
| the connection's process dies with calls outstanding | each outstanding call fails with a process-exited error naming the reason and the exit code |
| the connection is disposed with calls outstanding | each outstanding call fails with a disposed error |

The error-envelope mapping is identical for both transports, so a caller cannot tell from the exception which transport served it.

### Environment marker

`JOLLI_IDE_BRIDGE_SERVE=1` is set on the spawned server process purely so it is identifiable in a process listing. Nothing reads it — it is a diagnostic marker, not a behavioral switch.

### Version stamp dependency

The connection records the runtime-artifact version that was on disk when it was spawned, and re-reads the stamp on **every** call. An unreadable stamp reads as the empty string.

## Behavior

### Call routing

For every bridge call, in order:

1. Resolve a connection for the call's working directory. If one is resolved, issue the call over it and return its result.
2. **A business error and a timeout are rethrown as-is.** Neither falls back to a spawn:
   - a business error is the server's actual answer to the request, so retrying it would only produce the same answer at the cost of a process start;
   - **a timeout means the server is still executing the request.** A second spawn would double-execute — a sync round would push twice, a store-summary would write twice. This is the one case where the usual "retry on failure" instinct is actively harmful, and it is why the timeout is a distinct exception type rather than a generic error.
3. **Any other failure** — no matching project, spawn failure, handshake failure, protocol mismatch, write failure, process death — is logged and the call is retried as a one-shot spawn.

### One-shot fallback

Spawn the command-line entry in its one-shot bridge form with the action name and the working directory, redirecting output to a temporary file and discarding the error stream. Write the request body to the child's input and close it. Wait for the budget, force-terminating on expiry. Parse the **last non-blank line** of the captured output; map an `error` object to the business-error exception; treat a non-zero exit with no error envelope as a generic failure; otherwise return the result (or a JSON null when the response carried none).

### Project matching

Canonicalise the requested directory, then walk every open, non-disposed project and test it against **two** candidate roots:

- the project's base path;
- the project's resolved main repository root, but **only if that project's memory service has already been created** — the lookup is deliberately non-forcing, so matching a directory never triggers a heavy service initialisation as a side effect.

A candidate matches on canonical equality **or on prefix containment in either direction** — the requested directory inside the candidate, or the candidate inside the requested directory. No match yields no connection, and so a one-shot fallback. A failure enumerating projects at all also yields no connection.

### Global-scope calls

Some actions have no project of their own: Memory Bank path and identity resolution, repository discovery, Memory Bank metadata operations, and summary-tree analysis. These send **the first non-disposed open project's canonical base path**, falling back to the process working directory when no project is open. So an arbitrary open project's server serves them, and the real target travels in the request body rather than in the working directory. Metadata calls do this deliberately, precisely so the connection fast path can match.

### Spawn and handshake gate

1. Resolve the Node runtime and the bundled entry. Either missing is a hard failure (which the caller then treats as a fall-back-eligible error).
2. Spawn the long-lived server form with the project base path as both the working-directory argument and the process working directory, keeping the error stream separate from the output stream, and setting the process marker.
3. Wait up to **5 seconds** for the handshake notification. A timeout or an execution failure force-terminates the process and fails hard.
4. Read the protocol string from the handshake's **params** (not from the top level of the notification) and compare it **exactly** against the expected identifier. A mismatch force-terminates the process and fails with a message naming both the expected and the received value. There is no negotiation and no tolerance for a differing value.

### Version-drift respawn

A cached connection is reused only when **both** hold: its process is alive, **and** its recorded artifact version still equals the stamp on disk. Either check failing respawns. The check is re-evaluated under the spawn lock, and disposal is re-checked twice inside that lock so a disposal racing a spawn cannot leave an orphaned server process running.

This is why the stamp must be published atomically (spec 128): a reader that observed the empty window of an in-place truncate would read the empty string, judge the connection stale, and tear down every in-flight call on it.

### Per-connection in-flight scoping

Each connection owns its **own** map of outstanding calls, created at spawn time and captured by that connection's reader thread. A predecessor connection that dies late can therefore only fail **its own** outstanding calls — it cannot reach into a successor's map and fail work that has nothing to do with it.

On process death: log it, snapshot and clear only that connection's map, fail each outstanding call with the process-exited error, and clear the cached connection **only if the dying process is still the current one**.

### Reader routing

The connection's reader thread reads one line at a time, skipping blanks, and routes:

- **No `id`, or an `id` of JSON null → treated as a notification** and routed by `method`: the handshake completes the handshake gate if it is not already done; a refresh is handed to the refresh channel (spec 289); anything else is logged as an unaddressed line and dropped.
- **`id` present but not numeric → logged and dropped.** The server accepts string ids on the wire; this client cannot consume them. In practice it only ever sends integers, so this path is defensive.
- **`id` numeric →** the matching outstanding call is completed. An id with no outstanding call is logged at info — late responses are tolerated, not treated as an error.

The error stream is drained on its own thread, each line truncated to 500 characters and logged at info.

### Two grounded dead-letter cases

1. **The server's malformed-line error envelope never reaches any caller.** That envelope carries `id: null` and no `method` (spec 287), so it lands in the notification branch, matches no method, and is logged-and-dropped as unaddressed. **The caller that sent the malformed line then blocks for the full per-call budget** — up to five minutes — before failing with a timeout, even though the server answered immediately. And because a timeout is one of the two non-fallback exception classes, that call is never retried as a spawn either.
2. **A string-id response is dropped the same way.** The two ends disagree about the id type the wire permits; the disagreement is invisible today only because the client never emits a string id.

### Shutdown

Graceful shutdown deliberately avoids the ordinary process terminate:

1. Close the server's **input stream only.** That is end-of-input for the server, which stops its watchers and awaits every in-flight response before exiting (spec 287) — so responses already computed are flushed rather than lost.
2. Wait 2 seconds.
3. Force-terminate.

The stated reason for not terminating first: on Windows the ordinary terminate maps to an immediate process kill, which would race the drain and discard responses that were about to be written.

Disposal marks itself once (so it cannot run twice), then under the spawn lock clears the cached connection, fails every outstanding call with the disposed error, and runs the shutdown sequence above.

## State Transitions

### A per-project connection

```
[none] ── first call whose cwd matches this project ──> [spawning]

[spawning] ── handshake within 5 s and protocol matches ──> [connected]
[spawning] ── handshake timeout / execution failure ──────> force-terminated; hard failure
[spawning] ── protocol mismatch ─────────────────────────> force-terminated; hard failure
             (both hard failures are fall-back-eligible: the call is retried one-shot)

[connected] ── next call, process alive AND stamp unchanged ──> reused
[connected] ── next call, process dead OR stamp changed ─────> [spawning] (respawn)
[connected] ── process exits with calls outstanding ─────────> only THIS connection's
                                                               calls fail; cached slot
                                                               cleared only if still current
[connected] ── dispose ──> input closed → 2 s → force-terminate; all calls fail disposed
```

### A single call

```
resolve connection
    ├─ none                          → one-shot spawn
    └─ found → write line → await response within budget
                 ├─ result                  → returned
                 ├─ error envelope          → business error, RETHROWN (no fallback)
                 ├─ budget elapsed          → timeout,       RETHROWN (no fallback)
                 └─ any other failure       → one-shot spawn
```

## Notable Behavior

- **A timeout must never fall back, and this is the load-bearing rule of the whole design.** The server is still running the request; a second spawn would perform the side effects a second time. Every other failure class is safe to retry precisely because it means the request did *not* run.
- **A business error must not fall back either**, for a cheaper reason: it is the answer. Retrying it burns a process start to receive the same rejection.
- **Project matching is bidirectional prefix containment, not just "is inside".** A call from a nested directory finds its project, *and* a call from an ancestor of a project's base path matches that project. The second direction is what makes an ancestor-rooted call resolve at all, and it is also why two nested projects can both look like a match for the same directory — the first open project that matches wins.
- **The main-repository-root candidate only participates when the project's service already exists.** Matching uses a non-forcing service lookup, so early in a session — before any project's memory service has been created — a worktree can only match on its base path. The same call made a moment later may resolve differently.
- **Global-scope calls are served by an arbitrary project's server.** Which project that is depends on window order, and the answer is nonetheless correct because the real target travels in the request body. But it means a memory-bank metadata call is logged into whichever project's debug log happens to own the serving connection (spec 287).
- **Nothing exists until the first matching call.** The connection is a lazily created per-project service that only the resolution step ever obtains, so neither the server process nor the refresh channel it carries exists until the first bridge call whose working directory matches an open project. The lifecycle call that appears to start the channel does not (specs 124, 289).
- **The version stamp is read on every single call.** A stamp rewrite under a live connection tears that connection down and respawns on the next call — which is correct, and is also why the stamp's write must be atomic: a non-atomic rewrite would present a momentary empty value and destroy every in-flight call for no reason.
- **In-flight scoping is per connection, deliberately.** Without it, a predecessor whose process dies after a successor is already serving would fail the successor's calls. With it, a dying connection's blast radius is exactly its own outstanding work.
- **Shutdown closes input and waits rather than killing.** This is what lets a server flush computed responses; it also means disposal costs up to two seconds per connection.
- **A malformed request line costs the caller the full budget for nothing.** The server answers immediately, the answer is unroutable, and the caller waits out five minutes and then cannot retry. This is the sharpest edge of the id-null notification rule.
- **The handshake check is a hard string equality with no negotiation.** A protocol change on either side is a clean, immediate, loud failure rather than a subtly degraded session — at the cost of every call falling back to one-shot spawns until the two sides match again.

## Shared Behavior

- **CLI IDE-Bridge Command Surface (287)** — the surface this connection speaks to: the envelope, the action catalogue, the server's unbounded concurrency, the malformed-line envelope this client cannot route, and the end-of-input drain that makes the shutdown sequence work.
- **IDE-Bridge Refresh Notification Channel (289)** — the notifications this connection's reader routes by the absence of a correlation id, and the client-side handling that follows.
- **IntelliJ Node.js Runtime Detection and Hard Gate (284)** — produces the runtime every spawn here needs; nothing on this path runs without it.
- **IntelliJ Delegated Hook Installation (128)** — owns the bundled artifact this connection executes and the version stamp it polls, including the atomic publication this connection's staleness check depends on.
- **IntelliJ Project Service Lifecycle (124)** — hosts the per-project service and owns the status refresh that is this connection's most frequent caller.
- **IntelliJ CLI-Delegated Sync Orchestration and UI (219)** — the caller for which the no-retry-on-timeout rule was made concrete: a re-executed sync round would push twice.
