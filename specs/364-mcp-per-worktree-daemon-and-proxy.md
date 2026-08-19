# 364. MCP Per-Worktree Daemon and Proxy

## Topic Statement

One shared, self-reaping background MCP server per git worktree, reached by every session through a per-session byte-forwarding process that degrades to serving that session by itself whenever the shared server cannot be reached. The host-facing contract is unchanged: an AI host still spawns a plain standard-input/standard-output process per session, and no registration, descriptor or per-host entry envelope moved. What changed is what that process is — a proxy that holds no protocol knowledge and no session state — and where the server it forwards to lives: a detached background process keyed on the worktree root, reachable at a derived address, which greets each arriving proxy, is retired only by a strictly newer bundle, and reaps itself on an idle window, a first-client window, or a retirement request.

## Scope

**In scope:**

- The three modes the entry-point command now has, and the pre-parser shortcut that routes the bare one-word invocation into the proxy without entering the general startup path.
- The hidden subcommand that is the actual server, its two explicit inputs, and how it is spawned.
- The singleton key (the worktree root, not the repository), why the coarser key was rejected, and how an address is derived from that key.
- The address shapes on each platform, the generation mechanism that exists on one of them only, and the two invariants the generation scan carries.
- The handshake: who speaks first, which version travels, the three-way outcome, and why a tie attaches.
- Every terminal that ends in the in-process server, enumerated, plus the environment escape hatch that reaches it without the proxy at all.
- The ordering of the working-directory guards relative to binding and to the explanatory line one of them prints, and the one guard that exists in only one of the two processes.
- The degraded-manifest distinction, the per-connection retry, and exactly what that retry does and does not recover.
- Which timers are held on the event loop and which are released, and why the answer differs between the two processes.
- Byte forwarding, its backpressure requirement, and its end-of-stream asymmetry.
- The rule deciding when a stale address may be deleted.
- The reap windows and the set of stop reasons, all of which exit successfully.
- Everything the shortcut skips by never entering the general startup path — chiefly optional-extension discovery, which is why it exists — and the per-tool telemetry a session loses as a result.

**Boundaries (consumed here, owned elsewhere):**

- The advertised tool set itself — tool names, descriptions, argument shapes, response shapes, the result envelope and its error flag, the curated menu prompt, the manifest's own content rules (validation, name collisions, the routing binding and its origin gate), the working-directory binding every tool derives its repository from, and the index-rebuild data flow.
- The per-host configuration files that point a host at the entry-point command, their per-host entry envelopes, and the presence predicates that decide which hosts get one.
- The rule that turns a launch directory into a worktree root, its subprocess, its per-process cache, and the companion answer reporting whether git named the directory.
- Diagnostic-log placement and the storage backend the server half installs process-globally — including the shared cutover-route re-check that can rebuild that backend mid-life, whose throttle, coalescing and one-way latch are owned by spec 370. This spec records only that the rebuild is per repo-scoped call rather than per connection, and that its reach is the whole process.
- The separate refresh-notification channel that also watches a worktree and pushes at JVM hosts. It is a different transport, a different process, and a different message set; nothing in this topic emits or consumes it.
- The re-entrancy markers that identify a locally-spawned agent's child process.

## Data Contracts

### The three modes of the entry-point command

The one-word `mcp` invocation is the only one an AI host ever writes, and it is now the proxy. Two other modes reach the in-process server or no server at all:

| Mode | Invocation | What runs |
| --- | --- | --- |
| Proxy (default) | `mcp` with no further argument | The byte-forwarding proxy, reached by a pre-parser shortcut that never enters the general startup path. |
| Reindex | `mcp --reindex` | A full rebuild of the local search index, then exit. No transport is ever opened, no proxy, no daemon. |
| Forced in-process | `mcp` with `JOLLI_MCP_NO_DAEMON` set to exactly `1` | The single-process in-process server, exactly as before the daemon existed. |

The shortcut is an **exact match on a single argument**: anything else — the reindex flag, any future flag, any extra token — falls through to normal parsing, where the mode branch is taken after the general startup path has run. Nothing in the shortcut guesses at option semantics.

The escape hatch is an **environment variable tested for one exact value** — `JOLLI_MCP_NO_DAEMON`, and only the string `1`; any other value, including `true` or `0`, leaves the proxy in charge — not a flag. The host registrations all write a fixed argument list, so a flag would require changing every registrar *and* every already-installed host configuration before it could be used; an environment variable is settable at the host level today, which is what makes it usable for bisecting a suspected daemon problem on a real machine. It is honoured in both places that could take the proxy: the shortcut declines when it is set, and the parsed command path checks it again.

### The hidden server subcommand

`mcp-serve` is the daemon. It is hidden from help, never typed by a user, and takes two explicit inputs:

- `--cwd` — the worktree root it answers for. Explicit because the daemon must **not** re-derive it: doing so would shell out to git for an answer the proxy already has, and any disagreement between the two would put the daemon on an address the proxy does not look at.
- `--socket` — the address to bind. Explicit for the same reason.

It **always exits successfully**, whatever its stop reason — including losing the bind race, which is a success from the proxy's point of view because a server for this worktree now exists. Nothing reads the exit code anyway: the process is detached with its standard streams discarded.

The spawn is detached, with standard streams discarded, the working directory set to the worktree root, **no runtime flags before the script**, and the child handle released immediately. Discarding the streams is a correctness requirement rather than tidiness — the daemon must never inherit the proxy's standard output, which carries the host's protocol stream, where one stray line desynchronises the session's framing for good. Omitting runtime flags is the same rule the background summary worker follows: a flag an older runtime does not recognise kills the child before it executes a line, and with streams discarded that death is invisible. The proxy spawns from the script the runtime was actually launched with, so proxy and daemon are guaranteed to be the same build and the version in the handshake means what it says.

### The singleton key and the address

**The key is the git worktree root, not the repository.** Sibling worktrees of one repository get separate daemons. That is not a feasibility limit: sibling worktrees share an orphan branch and a Memory Bank folder, so a per-repository daemon would have been better still — but tool dispatch takes its working directory from the spawning closure, and several of the tools are branch- or worktree-scoped, so collapsing siblings onto one key would answer for the wrong branch, silently. The coarser key was rejected on that, not on cost.

**The address is a hash, not the path.** The root is normalised for comparison — platform-explicitly — and then hashed; the first sixteen hexadecimal characters of that hash are the key. Two reasons, both load-bearing: a real worktree path blows the address-length cap a filesystem socket is subject to, and normalising *before* hashing stops a case-insensitive filesystem handing one worktree two daemons. Case folding follows the **same** platform that selects the address flavour, so one derivation cannot answer two ways depending on the host it runs on — a case-sensitive filesystem genuinely does have two worktrees there.

Address shapes, with `<key>` the sixteen hex characters, `<uid>` the user id, and `<gen>` the generation suffix (`-g<n>` for a non-zero generation, **empty for the first**):

```
unix:     <tmpdir>/.jolli-mcp-<uid>/<key><gen>.sock
windows:  \\.\pipe\jolli-mcp-<key><gen>
```

- **Unix** — a socket file named for the key, inside a per-user directory under the temporary directory. The temporary directory rather than the user's own state directory because a home directory can sit on a network or synced filesystem, neither of which can host a socket, and because a socket is per-boot state that has no business surviving a reboot. The user identity is in the directory **name**, not only its mode bits, because the temporary directory can be shared: without it, the first user to create the directory would own the mode bits for everyone else.
- **Windows** — a named pipe whose name carries the same key. Named pipes live in their own kernel namespace: no directory to create, no mode bits, and no stale entry left behind when a process is killed, because the pipe disappears with its last handle.

**The socket parent directory is created with owner-only permissions unconditionally, before the ownership check.** The order is forced by the check itself, which answers negatively for a directory that does not exist — checking first would send the very first run on every machine down the fallback path, permanently, since nothing would ever create the directory. Creating it ourselves is also what makes the check meaningful: whoever wins that race owns the mode bits. **Observable side effect:** every non-refused invocation creates that directory. On Windows the creation is a no-op.

### Handshake messages

Three message kinds, one newline-terminated JSON object each, over the same connection the protocol traffic later flows on:

| Kind | Direction | Carries |
| --- | --- | --- |
| `hello` | daemon → proxy | the kind, a `protocol` number, the daemon's `version`, its `pid`, and the `cwd` it serves |
| `attach` / `retire` | proxy → daemon | the kind only |
| `retire-deferred` | daemon → proxy | the kind only, and **only** in answer to `retire` |

**The daemon greets first**, the instant a connection is accepted and before any manifest work. The proxy needs the version before it commits to this daemon, and the alternative — proxy announces, daemon judges — would put the retirement decision in the process that has to be retired.

**The version that travels is the core version, never the surface's own release number.** A surface bundle's release number can rank its major above a strictly newer core, which would make an older core retire a newer one. This is the same key the runtime-selection mechanism compares for hook dispatch, so the daemon and the hook dispatcher agree on which bundle is newest.

An unrankable version — the sentinel a non-standard source layout yields — answers negatively in **both** directions, so it ranks equal to a release rather than sorting as zero. Left in the numeric domain it produced the opposite: a released proxy retired a developer's build on sight, repeatedly, since the replacement it spawns is the same build.

**The deferred answer deliberately does not bump the protocol number.** It is only ever written to a proxy that just asked for retirement, and such a proxy from an older bundle stops reading the moment it sends the request — so it cannot be confused by a line it does not know. Silence therefore remains a valid "released" from a daemon predating the deferral, and a bump would instead make every older proxy treat this daemon as unusable outright.

A handshake line is read by a hand-rolled single-line reader on both sides, bounded so a peer that connects and streams without ever sending a newline cannot grow the reader's heap. A timeout, a premature close, an oversized line and a socket error all resolve to the same nothing, because every caller answers all four identically.

### Generations

Only Windows gets more than one address per worktree: a generation count of **four** there, **one** elsewhere. On unix the scan therefore only ever touches the first generation and no suffix is ever emitted.

The reason is a platform difference in what owns an address, not a tuning choice:

- A **filesystem socket's** address is a directory entry held by the listener alone. Closing the listener unlinks the entry synchronously, already-accepted connections neither need it nor notice, and a successor binds the same path while the retiring daemon finishes its last calls — both facts hold at once. Releasing is unilateral and instant.
- A **named pipe** has no path. The NAME is the set of its instances, and every accepted connection is one of them, so a retiring daemon cannot hand the name over while a single client still holds it: the successor's first-instance bind fails. Releasing is collective.

**Reachability is therefore not evidence that an address can be bound.** Connect and bind are equivalent predicates on one platform and not the other, and that is exactly how this shipped: after an upgrade, every new session spawned a server that died on bind, polled it for the full readiness budget, then served in-process — a stall that can outlive a host's initialization timeout.

So the incumbent answers a **deferred** retirement and keeps listening, while the proxy relocates the successor to the next generation. That reproduces the unix outcome rather than evicting anyone: two daemons briefly coexist, the older serving only its existing clients, and it exits when they drain. Four is a bound on how many upgrades can overlap on one worktree, not a capacity — each generation drains on its own and the scan reuses the lowest free one, so the space stays compact.

**Two invariants carry the one-daemon-per-worktree rule that the operating system can no longer enforce.** A second live generation is now a legal state, so nothing else stops there being a third:

1. **Every generation is probed before any spawn.** The first generation going free does not mean nobody is serving — its daemon may have drained while a healthy successor answers one address up — and spawning at the first free address would add a duplicate that no one, including the operating system, can detect.
2. **The spawn takes the lowest free generation.** Always taking the next one up makes the chain creep, abandoning the first generation permanently and reaching the cap after a few upgrades.

**The first generation is spelled exactly as it was before generations existed.** The generation value is falsy-tested, so zero and absent produce the identical pre-generation address. That is a compatibility contract, not tidiness: an already-running daemon from an older bundle is bound to the unsuffixed name and its proxies look nowhere else, so a different spelling would leave an upgraded proxy and a live incumbent on two addresses, each certain it is alone.

**The scan's step budget is the generation count plus three.** Two extra steps cover the ordinary sequence at a single address (one connects or spawns, the next takes over after a retirement); the remaining margin is what bounds a daemon that keeps rebinding at the old version, and **the budget is genuinely consumable rather than defensive slack**. The case that consumes it: an older bundle's proxy is concurrently re-spawning its own daemon at the same address, so every round of ours runs the full sequence — probe, find an older peer, ask it to retire, wait for the address to go quiet, record the generation free, spawn into the lowest free one — and finds the same older version there again. The scan runs every step it has before giving up. Exhausting the budget falls back in-process; it **never** attaches to a daemon known to be superseded, because in-process serving costs memory while a superseded daemon costs correctness.

### The runtime, split in two

The server half is split by lifetime, and one process now builds many server objects:

- **Per process** — the two working-directory guards, the diagnostic-log anchor, installing the storage backend process-globally, and the platform-tool manifest fetch. This is the expensive half, and the whole reason the daemon exists: it is what many sessions must stop paying many times. One item in it is no longer strictly once-per-process: the storage backend can be re-installed mid-life, in place, when a repo-scoped tool call observes that the repository has cut over since startup — see "The degraded-manifest retry" for how that differs from the per-connection retry.
- **Per connection** — one server object per client. Each client runs its own initialization handshake and the protocol library binds one server object to one transport, so this cannot be shared; everything expensive already happened, so it is cheap enough to run per session.

A prepared runtime carries the worktree root, the advertised tool list (handed out by reference and never copied — with no platform tools it *is* the static built-in list), the platform routing map, the curated menu, and one **degraded** bit.

**Degraded means the gate was open and the fetch failed.** A closed gate is a configured choice and is never degraded. An **empty manifest from a healthy fetch** is likewise never degraded: a tenant with no platform tools is a normal, permanent state, and reading it as degraded — which the first version did, having only the list length to go on — turned a bounded retry into a manifest fetch on every single connection, awaited in front of that client's server construction, for the daemon's whole lifetime. Distinguishing a failed fetch from an empty one is new; previously both looked empty.

## Behavior

### Proxy, in execution order

1. **The not-a-worktree line, written first.** When the caller retracted the claim that the working directory is a real worktree root, the proxy writes one explanatory line to **standard error, never standard output** — a stray byte on standard output desynchronises the host's framing for the whole session, which is strictly worse than the empty answers the line exists to explain. It is worth one line per session because the alternative is what kept the defect alive: a server that starts cleanly, reports healthy, and answers every memory tool with nothing, on every editor window, indefinitely. The host's own server log is the only surface that can carry it — a diagnostic-log warning would be anchored to this same unwritable directory, i.e. back to silence.

   **This line is written before either of the other two guards is consulted**, and that ordering is observable: a locally-spawned agent's child runs in a throwaway directory that is normally not a repository at all, so it receives the "not a git repository" line too — even though that case's refusal, and whatever it reports, belongs entirely to the in-process server the fallback runs, and declines for a different reason. The line is therefore not scoped to the terminal it explains.
2. **Working-directory guards.** Three checks, all before the address is even derived, and any one of them sends the session to the in-process server (all three are consulted together, as one combined condition, after the line above). Two are restated from the in-process server purely to avoid spawning a daemon that would immediately refuse — their refusal text, and the decision to print it, stay owned by the in-process server that the fallback runs, so there is exactly one place that decides and one message a user can see. The third exists **only** here.
3. **Derive the address**, create its parent directory owner-only, then ask the ownership question. A directory another local user controls means falling back in-process.
4. **Scan the generations.** For each step the scan decides probe, spawn, or give up from the dense prefix of what has already been observed.
   - **Probe** — one connect attempt, not a wait: either a daemon is already there or one has to be started, and waiting first would only delay the spawn. Nothing usable answering records the generation as free; a peer that greets is negotiated with.
   - **Spawn** — spawn detached, then connect with retry until the readiness budget elapses, then negotiate.
5. **Forward bytes** until the session's socket closes.

The proxy reports one of three outcomes for logs and tests: proxied, fallback-in-process, or refused.

### Negotiation

1. Read the peer's first line. Missing, unparseable, or a foreign protocol number ⇒ serve in-process, and **do not unlink the address**: we have no claim on a socket we did not recognise, and deleting a stranger's endpoint is worse than serving ourselves.
2. Compare the greeting's working directory against ours. A mismatch means a hash collision or a path reused after a rename ⇒ serve in-process, again **without unlinking**.
3. Compare versions. Strictly newer ⇒ send `retire`; not strictly newer (a tie, or we are older) ⇒ send `attach`.

**The working-directory assertion folds through the same normaliser, on the same platform, that the address derivation folds through.** A raw comparison there would not be stricter but *inconsistent*: two spellings of one worktree hash to a single address, so the session reaches the right daemon and is then rejected as a hash collision — stranded on an in-process server for its whole life, with a log line blaming a collision that never happened.

**Ties attach, and that is what makes sharing work.** Were ties to count as newer, two same-version sessions would retire each other in turn and never share anything.

The retirement request is sent **flush-then-close**, not written-and-destroyed: destroying is documented to drop queued write data, and a bare write only completes synchronously when the line happens to fit the kernel buffer — true for a short line on an idle socket, which is exactly why the wrong shape survived testing, and not a guarantee the protocol may rest on. Losing that frame loses the whole upgrade: the incumbent never hears the request, keeps its bind, greets the next round with the same old version, and the proxy burns its steps and serves in-process — the daemon's one job undone at the moment a new bundle ships.

Closing the write half does not stop the proxy **reading**, which matters because the answer decides where the successor goes:

- **Silence, or an unparseable answer, means the address was released.** The proxy waits for the address to go quiet, then lets the scan spawn into it. Reconnecting immediately would land back on the same dying daemon, which greets with the same old version, gets retired again, and burns every step.
- **A deferred answer means advance to the next generation.** On the spawn branch this instead ends the scan and falls back in-process, rather than advancing further.

### Daemon, in execution order

1. **Both working-directory guards run before the socket directory is created and before binding.** A refused directory must leave no socket and no directory behind: a bound-then-refusing daemon would look reachable to every future proxy, which would attach and get nothing — strictly worse than the documented fallback.
2. Create the parent directory, then ask the ownership question. A directory that is not exclusively ours means refusing to bind.
3. Bind. A bind failure is resolved with the errno logged, because the daemon is detached with its streams discarded and this is the only trace it leaves; the two failures that actually happen (a missing parent directory, a hostile one) are indistinguishable without it. An address-already-in-use failure with a live peer means a sibling daemon beat us to this worktree, which is the wanted outcome reached by a different route.
4. On bind, arm the first-client countdown.
5. **Per connection:** register the socket, cancel any armed countdown, write the greeting **immediately**, read the client's greeting.
   - `attach` — resolve the runtime (performing the degraded retry if any), build a server object, and hand it the remainder of the socket. Post-greeting bytes go through a **buffering stream** rather than being pushed back onto the socket: the socket has an active data listener for the duration of the handshake, which puts it in flowing mode, and pushing back onto a flowing stream is a documented no-op-with-loss.
   - `retire` — return the greeting to the caller, which is the only place that knows how many other clients are attached and therefore whether the address can actually be given up. Answering inside the per-connection handler would also make that answer unwritable, which is how a daemon that could not release its address came to report success by saying nothing.
   - Anything else, or no usable line at all — drop that client.
6. **A failed attach drops only that client.** Without the per-client catch the rejection is unhandled, and the runtime's default for that is to terminate the process — killing the server of every *other* session attached to this worktree, from a detached process whose streams are discarded, so the only trace anywhere would be their tools vanishing.

### Answering a retirement request

The requester is still counted among the connections at this point, which is what makes an idle handover work on the platform that needs it: the sole remaining instance of the address is the connection about to close, so the name frees within milliseconds and the successor binds the same generation.

**The answer is written before the retiring guard is consulted**, so a second, even newer proxy arriving mid-deferral gets the same answer. Silence means "released" on this wire, so skipping the answer would send that proxy off to bind an address still being held.

- **Can release** — close silently, mark retiring, unbind **first** so the requesting proxy's immediate re-scan cannot race back onto this dying daemon, then let the drain path decide when to exit. A retiring daemon with no clients left stops at once rather than waiting out an idle window — and the **drain path** is what performs that stop, always: the requester's own close has not been accounted for yet at this point, so this branch's inline attempt to stop immediately never fires (see Notable).
- **Cannot release** — answer deferred and **keep listening**. Unbinding would strand the clients holding the address without freeing it for anyone: the successor cannot bind this name either way, so it moves to the next generation while this daemon serves out the sessions it already has and exits when they drain.

### Releasing the address

Closing the listener is the **only** release, and there is deliberately **no unlink afterwards**. The path is unlinked synchronously at call time, while the close callback waits for every open connection to end — and those two moments are far apart for a retiring daemon, with only the first being a moment at which it still owns the path. An unlink placed after the await deletes the *successor's* socket: the successor stays listening on a path nothing can reach, every later proxy spawns yet another daemon, and the unreachable one holds its runtime until its idle reap. A once-per-daemon guard does not fix that, because the very first release is already the mistimed one.

If a future runtime stops unlinking on close, the leftover entry is the ordinary stale-address case, which the next proxy clears before spawning — recovering there is strictly safer than unlinking a path we may no longer own.

### Reaping

Two windows, sharing one code path so a daemon can never end up with neither armed:

- **Idle: five minutes** with zero clients. Not zero, because a host that restarts its server — a reload, a settings change, a crashed session — reconnects within seconds, and tearing down a warm runtime only to rebuild it moments later is the expensive half of what the daemon removes.
- **First client: sixty seconds** after binding. Much shorter, because a daemon reaching this one was spawned by a proxy that then died (the host gave up, the user closed the window mid-launch): nobody is coming, and there is no warm runtime worth preserving yet.

Stop reasons, all of which exit successfully: refused by a working-directory guard, unsafe socket directory, address already in use, listen failed, idle, no first client, retired.

### The degraded-manifest retry

A degraded runtime is retried **on the next attaching connection, in place, one at a time**, and **only the platform half — never the storage half**. The storage half is a process-global side effect and is the expensive one; re-running it per connection would undo the sharing the daemon exists for. A closed gate is not degraded, so the normal path makes no network call here at all. Concurrent retries are de-duplicated: a host reopening several sessions at once after a network outage would otherwise fire one fetch per connection, all racing to write the same answer. The in-flight marker is cleared either way, so a later connection can try again after a failure.

The retry is deferred until **after** the greeting and only for an **attach**, so the greeting still goes out immediately — that is what lets the proxy judge the version without waiting — and a retirement request, which needs no tools at all, never pays for a fetch that may be exactly what is hanging. A retry that itself throws is swallowed: serving the built-ins beats refusing the connection, and this is already the degraded path.

**Recovery is per-connection, and an already-attached session never sees it.** The server object captured its tool definitions by value, so a session that attached while the runtime was degraded keeps its short tool list for its whole life; only later connections see recovered tools. In a one-shot server a failed fetch cost exactly one session its platform tools; cached in a daemon it would cost every session on the worktree until reap, with nothing in the advertised list to say so.

**"Never the storage half" still holds per connection, but "the storage half is already correct" no longer holds unconditionally.** A daemon that outlives a cutover committed by another surface holds a pre-cutover storage object bound to a ref that is now frozen — reads succeed off it while missing everything written to the database since. The repair for that is a per-**call** re-check ahead of repo-scoped tool calls, not a per-connection one: the reproduction is one connection that spans the cutover, so a check made at attach time would never fire for it. Nothing about a client attaching re-establishes storage, then or now.

**And a storage rebuild's blast radius is the whole process.** The storage half is one process-global object, so when one session's tool call triggers the rebuild, every session attached to this worktree is switched with it — sessions in the middle of a call included. That is the opposite of the platform half, whose recovery an already-attached session never sees at all.

### Byte forwarding

Both directions forward through a piping primitive, and the reason is **backpressure, not brevity**. The hand-rolled read-then-write this replaced discarded the write's return value, so neither direction could ever apply any: a search or recall result is large enough for that to matter, and a host that reads its streams slowly made the process buffer without bound — in the one process whose entire purpose is to stay at the runtime's memory floor.

Anything read behind the greeting line is **written out first**, before either pipe is attached.

**End-of-stream asymmetry**, expressed by the pipe options rather than by hand:

- **Input to socket keeps the default end propagation.** The half-close is wanted: the host closing its input should let the daemon see end-of-input and finish a reply already in flight, rather than lose it to an abrupt destroy. Safe **only** because each session owns its own socket; on a shared connection this would be tearing down other sessions.
- **Socket to output explicitly does not propagate the end.** This process's output must outlive one daemon connection — ending it is not a teardown of the forwarding, it is closing the host's transport from underneath itself.

A session ends on the socket's close or error: both directions are detached, the socket destroyed, and the outcome reported as proxied.

### Address deletion

**Only a definitively absent address permits removing a stale entry** — connection refused, or no such file. Both prove nothing is listening right now, and a leftover socket file is the normal state after a hard kill or a reboot that kept the temporary directory; it makes the daemon's own bind fail, so it has to go before a spawn.

**Our own connect timeout never permits it.** It proves only that a peer was slow. Unlinking there deletes a live daemon's endpoint: it stays listening on a path nothing can reach, every later proxy spawns another daemon, and the stranded one holds its runtime until its idle reap — one leak per occurrence, and the one-daemon-per-worktree invariant quietly gone. The spawn arbitrates instead: a still-bound slow daemon makes the newcomer lose the race and exit on its own, and a dead one loses the path.

On the named-pipe platform the same two errnos prove far less — a daemon that closed its listener while clients still hold its name answers exactly that way — but there is nothing to unlink there, so the deletion is a no-op and the ambiguity is harmless. It is why "free" means "may be spawned into", not "nobody is serving".

**The unreachability probe's own connection is counted as a client by the daemon**, and is destroyed immediately for that reason, so it cannot hold a retiring daemon open past its last real session.

### Timers

- **The proxy's poll timer is deliberately not released from the event loop.** While the proxy waits for a spawned daemon to bind, that timer is the only handle on its event loop: input has not been resumed and no socket is open. A released timer lets the runtime conclude it has nothing left to do and exit — silently, successfully, with no log line, and the host simply sees its server vanish a second after launch. That shipped in the first draft and is invisible to any test that holds the loop open for other reasons. The connect attempt's own timeout is likewise held, so no path through the proxy's wait can drain the loop.
- **The daemon's reap timer is released.** There a listening server handle keeps the process alive, so releasing the reap timer is what stops a retiring daemon — which has already closed its listener — from outliving its window.
- **The handshake read timeout is released on both sides.**

### Every terminal that ends in an in-process server

Ten, plus the escape hatch:

1. The invocation is a locally-spawned agent's child.
2. The working directory is inside an AI host's plugin bundle.
3. The working directory is not a worktree root (one explanatory line on standard error first — written ahead of the two guards above, so it is not exclusive to this terminal).
4. The managed socket directory is not exclusively ours.
5. The peer's first line is missing, unparseable, or a foreign protocol — and this path deliberately does not unlink the address.
6. The greeting's working directory does not match ours (hash collision, or a path reused after a rename) — also not unlinked.
7. A just-spawned daemon never became connectable within the readiness budget.
8. A just-spawned address answers a deferred retirement.
9. Every generation was probed and every one deferred.
10. The step budget was exhausted.

Plus the environment escape hatch, which reaches the in-process server without the proxy at all.

**Notable, and it contradicts the labelling.** The first three are reported as *refused*, but for the not-a-worktree case the proxy prints its line and then **serves normally, with empty answers**. Only the locally-spawned-agent-child and plugin-bundle cases actually decline — the in-process server's own guards return before anything is bound or registered — and for those two the session gets no server at all. So "the proxy can only make the server cheaper, never absent" is false for exactly those two, as it was before this change. And because the not-a-worktree line is written **before** those two guards are consulted, a locally-spawned agent's child in a non-repository directory gets that line as well, describing a repository it was never going to answer for.

### What the shortcut skips

Because the bare invocation never enters the general startup path, **none of that path's startup work runs for it at all** — it registers no command surface and needs no argument parser. What it drops:

- **Optional-extension discovery, and the stub commands that stand in for the absent ones** — and this is the shortcut's **primary motivation**, not one item among several. The general path probes the machine for separately-installed command-line extension packages and registers placeholder commands for whichever ones are missing; loading those packages is the costliest thing on that path, and the reason the shortcut was carved out at all. The other omissions are consequences of having taken it; this one is why it exists.
- The one-time telemetry disclosure.
- The per-command telemetry hook installation.
- The update check.
- The stale-skill refresh.
- The telemetry bootstrap, and the exit-time telemetry flush that drains its buffer.

**The telemetry bootstrap is a behavioral regression worth recording.** The event emitter is inert without a context, and only the bootstrap installs one. So a session served by the **in-process fallback** emits no per-tool invocation events, where previously every invocation bootstrapped telemetry first. The daemon path still emits: the daemon is reached through the general startup path, which bootstraps normally — it only skips the one-time disclosure, deliberately, because its standard error is discarded and showing the notice there would consume the one-time flag on an audience of nobody, never to be offered again on that machine. The forced-in-process and reindex modes also go through the general path and keep their telemetry.

## State Transitions

A daemon, from spawn:

| From | Event | To |
| --- | --- | --- |
| Spawned | a working-directory guard declines | Exited (refused); nothing bound, no directory left behind |
| Spawned | the socket directory is not exclusively ours | Exited (unsafe directory); nothing bound |
| Spawned | bind fails, address already in use with a live peer | Exited (address in use) — the wanted outcome by another route |
| Spawned | bind fails otherwise | Exited (listen failed), errno logged |
| Bound, no client yet | sixty seconds elapse with zero clients | Exited (no first client) |
| Bound | a client attaches | Serving; countdown cancelled |
| Serving | last client closes | Bound, idle countdown armed (five minutes) |
| Bound, idle | five minutes elapse with zero clients | Exited (idle) |
| Serving or idle | a strictly newer proxy asks to retire, and the address can be released | Answer silently, unbind at once, drain, then Exited (retired) |
| Serving | a strictly newer proxy asks to retire, and the address cannot be released | Answer deferred, **keep listening**, drain, then Exited (retired) |
| Retiring | another, even newer proxy asks to retire | Same answer as the first, guard not consulted |

A proxy, per session:

| From | Event | To |
| --- | --- | --- |
| Started | a working-directory guard declines | In-process server (reported as refused); no daemon spawned |
| Started | socket directory not exclusively ours | In-process server |
| Scanning | a compatible daemon of equal-or-newer version greets | Attached; forwarding until close |
| Scanning | a strictly older daemon greets and releases | Wait for quiet, then spawn into the same generation |
| Scanning | a strictly older daemon greets and defers | Record the generation held, advance to the next |
| Scanning | nothing usable answers | Record the generation free (unlinking only on proof of absence), spawn |
| Scanning | every generation held, or the step budget exhausted | In-process server |
| Attached | socket closes or errors | Session over; both directions detached, socket destroyed |

## Known Limitations

These are gaps that remain open. **None of them is a behavior the system performs**, and none of them is a protection the system offers — nothing below should be read as a commitment to close it.

- **Windows has no socket-ownership protection at all.** The shared-temporary-directory gate compiles to a no-op there: the ownership question answers affirmatively unconditionally, and the "is this path in our managed directory" question answers negatively unconditionally, so the gate is never consulted. The pipe namespace is machine-global, bound with the default access-control list, and the first binder wins — so on a multi-user Windows machine (remote desktop, terminal server) another local user can squat a worktree's pipe name and become its protocol server. The exposure is not only reading queries: it is **injecting arbitrary tool results into an agent's context**. The greeting's working-directory field cannot detect it, because computing the pipe name already requires knowing the working directory, so the squatter can always answer correctly. **Nothing mitigates this, and no mitigation is described anywhere.** No per-user element enters the name — it is derived from the hashed worktree root alone, so anyone who knows the working directory can compute it — and the only thing the implementation records about this platform is that both ownership predicates answer constantly there. This is not "no directory to police, so nothing to check": there is a real exposure and no check.
- **The pre-deferral upgrade stall is bounded, not fixed.** An incumbent from a bundle that predates the deferred answer cannot answer a retirement request at all, so the first upgrade past one still costs a full readiness-budget stall plus an in-process server for that session — once per worktree.
- **All real bind-and-connect behavior is untested on the platform the generation mechanism exists for.** Every test group that binds a real listener is skipped by platform — many groups, spread across both the daemon's and the proxy's tests — and continuous integration runs only the other platform, so the entire named-pipe premise (the collective address release the generation mechanism was built for) is asserted nowhere. The groups that only read source text are exempt from the skip and run everywhere. Only the pure decision layer (which generation to probe, where a spawn may go, when to give up, whether an address can be released) is asserted for that platform, by injecting it as an input while still binding a filesystem socket. Exactly **two** of the subjects behind that skip are unix-only anyway: the socket-directory ownership gate, which short-circuits on the other platform, and the on-exit removal of the address's directory entry, which has nothing to remove there. Every other skipped group is testing something the untested platform genuinely needs.

## Notable / Surprising Behavior

- **The entry point no longer serves the protocol.** The process a host spawns speaks nothing and forwards bytes; the long-lived server speaks over a socket or named pipe. Nothing host-facing changed — same per-session standard-input/standard-output process, same registrations, same per-host entry envelopes.
- **A daemon is owned by no session.** It is spawned detached and reaps itself. Parenting it to one session (leader election) would reproduce the failure it exists to fix, since any session can be closed at random.
- **The daemon pays its entire expensive runtime — including a network fetch — before it binds.** The working-directory guards run first, so a refused directory leaves nothing behind; but storage initialisation and the manifest fetch also precede the bind, so a proxy's connect-retry window covers the whole runtime build rather than just process start. "Both guards run before anything binds" is true and is not the whole story.
- **The not-a-worktree guard exists only in the proxy.** The daemon has no such notion — it takes its working directory verbatim, precisely so it cannot disagree with the proxy — so a hand-invoked daemon on an arbitrary directory would bind and serve. **Unreachable in production** only because the proxy never spawns one.
- **The keyed-on-a-fallback-directory failure is what the third guard exists for.** A working directory that came from the non-git fallback has no business keying a daemon whose whole identity is its worktree root: measured on a real machine, an editor host's user-profile registration is spawned with the filesystem root, which normalises to a single key, so every such session on the machine landed on **one** daemon rooted there. Serving those in-process is not a downgrade — it is exactly what each of them got before the daemon existed.
- **Reachability is not bindability, and assuming otherwise is how the stall shipped.** The unreachability wait proves an address is quiet, which is equivalent to bindable on one platform and not the other.
- **A tie attaches; only strictly newer retires.** Same-version sessions therefore share instead of evicting each other in a loop, and two different versions coexisting briefly is what the filesystem-socket platform has always done here.
- **Silence is a valid protocol answer.** The deferred line was added without bumping the protocol number specifically so a daemon that predates it still "answers" by closing.
- **The retirement answer precedes the retiring guard**, so a second newer proxy mid-deferral is not misled into binding a held address.
- **There is no unlink after closing the listener, and adding one back is a bug.** The path is already gone by the time the close callback runs, and by then the successor may own a new entry at the same path.
- **The proxy's poll timer must stay referenced and the daemon's reap timer must not.** The asymmetry is real, not an oversight: the proxy has no other handle on its loop while waiting, the daemon has a listening socket.
- **Forwarding uses a piping primitive for backpressure.** A hand-rolled forwarder that ignores the write's return value makes the cheapest process in the system buffer without bound.
- **An already-attached session never sees recovered platform tools.** Its server object captured the tool list by value; only later connections benefit from the retry.
- **A healed storage half lands for every attached session, unlike a recovered tool list.** The two halves are repaired on opposite granularities and with opposite reach: the platform half is retried per connection and observed only by later ones, while the storage half is re-checked per repo-scoped call and is a single process-global object, so a rebuild one session's call triggers is observed by all of them, mid-call ones included. Per connection would not work for it — the reproduction is one connection that spans the cutover.
- **An empty manifest is no longer a failure.** Treating it as one made the bounded retry unbounded for every tenant that legitimately has no platform tools, awaited in front of each client's server construction.
- **Several unreachable paths are kept deliberately, and they enumerate as follows.** The stop path's loop over remaining connections can never have anything to destroy: every one of its call sites is already guarded on there being no connections — the idle/first-client countdown, the drain that follows a client's close, and the can-release branch of a retirement. The handshake's leftover-bytes handoff is always empty today in **both** directions, because neither side writes anything between its own line and the peer's; it is kept because the invariant belongs to the *other* process, not to the one holding the branch. And the can-release retirement branch's own "stop now if no clients remain" can never fire, for a reason the branch two lines above it depends on: the requester's connection is closed asynchronously, so it is still counted at that moment — which is exactly what makes the address releasable in the first place. What actually stops a client-less retiring daemon is the drain path, when that closing connection is finally accounted for.
- **The escape hatch is an environment variable, not a flag**, because the host registrations write a fixed argument list and a flag would require rewriting every registrar and every already-installed configuration first.
- **A session served by the in-process fallback emits no per-tool telemetry.** The bare invocation skips the general startup path, and the emitter is inert without the context that path installs. The daemon still emits; so do the reindex and forced-in-process modes.

## Shared Behavior

- **The tool surface** — the advertised tools, their arguments and responses, the result envelope, the manifest's content rules and routing gate, the curated menu prompt, and the working-directory binding every tool derives its repository from. This topic owns where that surface runs, not what it is.
- **Host registration** — the per-host configuration files that spawn the entry-point command, their per-host entry envelopes, and the presence predicates behind them. Unchanged by this topic, and that invariance is the point.
- **Worktree-root resolution** — the git-based rule that produces the working directory, its per-process cache, and the companion answer reporting whether git named it. The proxy consumes both halves and re-derives nothing; the daemon is handed the answer explicitly.
- **The re-entrancy markers** that identify a locally-spawned agent's child — one inherited environment marker and one marker file in the working directory. Both guards here consume that predicate.
- **Runtime selection across install sources** — the highest-version-wins rule the handshake's version comparison mirrors, so the daemon and the hook dispatcher agree on which bundle is newest.
- **The separate refresh-notification channel** that also watches a worktree and pushes at JVM hosts: a different transport, a different process, and a different message set. Nothing here emits or consumes it.
- **The handshake primitives themselves are now shared, not owned here** (365). Reading exactly one newline-terminated line with a size cap and a never-raising failure result; serialising one message as that line; parsing the two things a client may say; the strictly-newer version comparison including its unrankable-development-version branch; the shared core version the comparison reads; creating an address's parent directory; the per-user address-directory naming; and the without-following-links ownership gate all moved into a common module when a second, machine-global daemon began using them. **Nothing about this topic's behavior changed in that move**, and the address it derives is byte-identical: the directory naming now takes a *flavour prefix*, and this daemon passes the same prefix its directory name already carried. The prefix exists so one flavour's safety verdict can never be read as the other's.
- **The machine-global resident daemon** (365) is the other user of those primitives. It is a different process with a different singleton unit (the machine-and-user pair rather than the worktree), a fixed address rather than a derived hash, its own independent protocol number, no idle timeout, and no working-directory assertion in its greeting. The two run side by side and neither's lifecycle affects the other; the only thing they must agree on is which bundle is newest, which is why they read the same version.
