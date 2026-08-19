# 365. Machine-Global Resident Daemon

## Topic Statement

One resident background process per machine per user, owned by no session and spawned detached, whose purpose is to run maintenance work at moments when nobody is asking for it — and which is reached by every entry point through a short, never-throwing handshake that either accepts the incumbent, retires it in favour of a strictly newer build, or starts one.

## Scope

**In scope:**

- The singleton unit, why it is the machine-and-user pair rather than anything finer, and how an address is derived from it on each platform.
- The greeting the resident process speaks first, what travels in it, and the version comparison that decides between accepting and retiring.
- The two questions a trigger asks, why they are given different time budgets, and why exceeding the second one means doing nothing at all.
- The commands that must never bring the process up, and the runtime floor that also suppresses it.
- Every surface that triggers it, the one comparable surface that does not, and the detached helper that keeps a trigger's own latency independent of the handshake.
- How the process locates the program to spawn, and why the obvious source for that is a trap.
- The directory-ownership refusal, and the single connection failure that is allowed to remove a leftover address.
- The scheduling model: what the interval means, why the scheduler holds no durable state, and the three properties that fall out of that.
- The work it performs — three items, asked every hour, every five minutes and every half minute — why the two furthest apart being two orders of magnitude apart is not an inconsistency, and why the middle one follows a different rule entirely.
- Its exit reasons, the absence of an idle timeout, and the teardown path that asks it to stand down.
- The diagnostic row that reports it.

**Out of scope (boundaries):**

- The snapshot mechanism itself — its folder rules, daily gate, retention collectors, verification and restore (owned by the snapshot topic). This topic owns only *that it is asked on a clock*, and how often.
- The re-scan's own comparison of a conversation against what was already imported, and everything it writes (owned by the import topics).
- The session-statistics upload channel itself — its state file, its gates, its backend scope keys, its silences, its per-table cursors, its first-run window, its per-repository row filter, its batching and its wire manifest (owned by the upload topic). This topic owns only *that it is asked on a clock*, and how often.
- The machine-level database's schema, migration ladder and open discipline. This topic consults only the runtime floor that decides whether the database can be used at all.
- The per-worktree background server that serves editor and agent tool traffic. It is a different process with a different singleton key, a different address family and a different lifecycle; the two run side by side and share only the handshake primitives (see **Shared Behavior**).
- The per-project editor bridge process, which is a third resident process with a third purpose.
- The content and cadence of anything the diagnostic command reports other than this process's own row.

## Data Contracts

### The singleton unit

The machine-and-user pair, and nothing finer. This is not a choice between comparable options: the file this process exists to maintain is the machine-level memory database, of which there is exactly one per user, so a process whose job is that file has no reason to be more granular than the file. The per-worktree server keys on the worktree precisely because most of what *it* answers is branch-scoped; nothing here is.

### The address

A **fixed** name, not a derived hash. The per-worktree server hashes its key because a real worktree path exceeds the length a filesystem socket name may occupy; there is no path to encode here.

The two platforms identify "this user" differently, and deliberately:

| Platform | Address | Per-user component |
| --- | --- | --- |
| Filesystem-socket platforms | A socket file with a fixed name, inside a per-user directory under the system temporary directory | The numeric user id, present in the **directory name** as well as in its mode bits |
| The named-pipe platform | A pipe in the kernel's flat namespace | A truncated hash of the **home directory**, case-folded before hashing |

The temporary directory rather than the user's configuration directory, because a home directory may sit on a network or synchronised filesystem that cannot host a socket at all, and because an address is per-boot state with no business surviving a reboot. The user id appears in the directory *name* and not only in its permissions because one platform's temporary directory is shared between users: without it, the first user to create the directory would own the mode bits for everyone else.

The home directory rather than the login name on the named-pipe platform, for three reasons: home is exactly what this process maintains, so the singleton unit and the key agree; a home path sidesteps login names a pipe name cannot carry verbatim; and two shells configured with different home directories stay on separate processes instead of one of them quietly ceasing to be maintained. It is hashed because a pipe name is a flat string with no room for a path, and case-folded first because that platform's paths are case-insensitive — two spellings of one home must not become two processes.

**The version never appears in the address.** Baking it in would let two installed bundles keep two resident processes indefinitely; keeping it in the greeting instead means the newer trigger retires the incumbent and everything converges on one.

### The greeting, and the two things a client may say

The resident process speaks **first**, the instant a connection is accepted, for the same reason the per-worktree server does: the trigger needs the version before it can decide, and the alternative would place the retirement decision inside the process that has to be retired.

The greeting carries: a message tag, a protocol number, the bundle's **core** version, the process id, and the epoch instant at which the address was bound.

- The version is the shared core release number, **never a surface's own release number**. Editor and agent-host bundles carry their own, higher, product versions; comparing those would rank a surface above a strictly newer core. This is the same number the runtime-dispatch competition compares, so the resident process and the hook dispatcher agree on which bundle is newest.
- The bound instant replaces the per-worktree server's working-directory assertion: a machine-global process has no working directory to assert, and uptime is what the diagnostic row wants.
- The protocol number is **independent** of the per-worktree server's. Adding an optional field to the greeting is a compatible change and must not bump it — an older trigger ignores what it does not read — because a trigger that sees an unknown protocol treats the process as unusable, which is safe but forfeits the version convergence the greeting exists for.

A client then says exactly one of two things: **attach** (carry on) or **retire** (stand down). Anything else — an unparseable line, a foreign protocol, a timeout, or a client that connected only to learn something is listening and hung up — means carry on. A probe closing its connection is the **common** case, not an error.

### Two questions, two budgets

| Question | Answered by | Budget | What exceeding it means |
| --- | --- | --- | --- |
| Does one exist? | The kernel | Bounded connect timeout | Nothing is listening; proceed to start one |
| Which build is it? | The resident process's own event loop | A much shorter budget, a fraction of a second | **Do nothing.** Not retry, and emphatically not "assume dead" |

The asymmetry is the whole design. A successful connect is answered by the kernel and is therefore bounded: a leftover address with nobody bound refuses immediately, and a live process accepts even while busy. Reading the greeting is answered by the process's event loop, which is **not** bounded — the snapshot work runs through a synchronous database interface and so answers nothing for its duration (measured: over half a second on a large database, plus a further fraction for the verifying integrity check, both scaling with size).

So a successful connect already proved a listener exists; the greeting only refines that into *which build*, and losing that refinement costs only the version convergence. Four of the surfaces that ask are on a version-control or agent critical path where a longer wait is a visibly slower commit or session start.

### The exclusion list

Commands that must never bring the process up, resolved from the **parsed** command rather than from an argument position — a global option placed before the subcommand silently breaks the positional form:

- The resident command itself and its detached helper, which would trigger themselves.
- The three commands that own their standard output as a protocol stream and are cold-start sensitive: the tool-server entry point, its hidden server subcommand, and the editor bridge.
- **The teardown pair** — the removal command and the disable command. This is the semantic one, and the one that gets missed: without it, tearing Jolli down spawns a resident process on the way out and leaves an orphan behind.

Independently of the list, the trigger also declines when the runtime is below the floor at which the database module loads without an experimental flag: a resident process that cannot do the one thing it exists for is worse than no process.

### The name of the command that is spawned

The resident process is a hidden subcommand, and the string naming it is declared **alongside the handshake protocol** rather than alongside the resident process's own implementation. A caller that needs nothing but that string would otherwise pull the networking layer, the snapshot path, the re-scan task and the scheduler in behind every one of its call sites.

The command-line entry keeps its own pinned copy of the same literal, because the check that routes on it runs before the argument parser exists. A source-shape test holds the two spellings together.

### Where it writes, and what it logs

A detached process inherits its spawner's working directory, and the log location falls back to that directory. Left alone, this process would write its log inside whichever repository happened to trigger it first — a different one across reboots. It therefore anchors its log location to the **home** directory at startup, and is spawned with the home directory as its working directory so that every directory-derived path inside it agrees with that anchor.

It then applies the **configured** log level, best-effort. Nothing used to: the default file threshold is above debug, so every debug line in this process — including the scheduler's per-item result line — was dropped, and configuring a debug level had no effect on the one process a user cannot watch directly. A missing or unreadable configuration must still let it come up, so failure there is a warning and the default level stands.

## Behavior

### A trigger, in execution order

1. If the parsed command is on the exclusion list, do nothing.
2. If the runtime is below the database floor, do nothing.
3. Connect to the derived address, under the connect budget. Every failure resolves a result rather than raising.
4. **On failure to connect**: if and only if the failure was the kernel's "nothing is listening" refusal, remove the leftover address; then start the resident process, detached, and return. Any other failure — a timeout, a resource error — removes nothing (see the note below) but still starts one.
5. **On success**: read the greeting under the short budget.
   - No greeting, an unparseable one, or a foreign protocol → accept the incumbent.
   - A greeting whose version is not strictly older than this bundle's → accept the incumbent. **A tie attaches**, which is what makes same-version sessions share one process instead of evicting each other in a loop.
   - A strictly older version → send the retirement request, log it, and **return without starting a replacement**.
6. Close the connection. Every failure anywhere in the above is caught, logged, and answered as a failure outcome; nothing here ever raises into its caller.

### Why retiring does not start the replacement

The retired process still holds the address when the request is delivered, and may hold it for the remainder of an in-flight snapshot. Because the trigger deliberately does not wait for its own spawn, a replacement started immediately would die of an address collision with nobody watching — so an upgrade would silently *remove* the resident process rather than replace it. Leaving the restart to the **next** trigger is bounded and self-healing: triggers are frequent while a user works, and a retirement only follows an upgrade, which is itself a trigger-dense moment.

### Only one connection failure may remove an address

The kernel's "nothing is listening" refusal is the sole proof of a leftover address with nobody bound — the killed-process or unclean-shutdown case, which would otherwise make every future bind fail forever, since one platform sweeps its temporary directory on an idle timer rather than at boot.

A timeout, or any other error, proves **nothing** about the address: a live process wedged behind a full accept backlog answers exactly like a timeout, and removing the address on that evidence would let the spawn bind a *fresh* address at the same name while the incumbent still holds the old one — the one way in this whole design to get two processes running a snapshot against the same database at once.

### The detached helper

Short-lived callers do not run the handshake themselves. They start a detached helper — its own hidden subcommand — and return immediately, so their latency never inherits even the bounded connect-and-greet wait. The helper performs the sequence above.

### Locating the program to spawn

Both spawns resolve the program **beside the caller's own loaded module**, never from the path the runtime was launched with.

That launch path names the command-line entry point only when the caller happens to *be* the command line, and four of the five triggers are hook entry points instead. Spawning the launch path there re-runs *that hook* — its own entry guard matches — against the home directory, which reaches the trigger again, which spawns again: an unbounded chain of detached processes while the process that was asked for never starts. Where the home directory is itself a repository, one of those hooks would also install Jolli into it.

The sibling lookup is correct under every bundler this product ships, because each one emits the command-line entry into the same directory as the module doing the lookup, and that entry is on the list of files a runtime must carry to be registered at all. A source-mode development run has no such entry; the resolution answers "none" and the caller logs that rather than spawning a path that does not exist, with a fallback to the source entry plus the current loader arguments so detached development runs keep working.

No runtime flags are placed before the program: a flag an older runtime does not recognise kills the child before it runs a line of code, and with output discarded that death is invisible.

### The resident process, in execution order

1. Anchor the log location to the home directory; apply the configured log level, best-effort.
2. Ensure the address's parent directory exists. Unconditional, and separate from the ownership gate below, because every bind needs the directory while only a bind into the derived location can be judged.
3. **The ownership gate.** If the address lies directly in the derived per-user directory and that directory is not exclusively this user's, refuse to bind and exit. The gate follows the **path**, not who chose it: production always lands in the shared-temporary-directory location the gate exists to police, while a scratch path elsewhere is the caller's own choice and is not second-guessed. The check reads the directory entry **without following links** — a link is never our directory, and following one answers the question about a path an attacker chose. It rejects on any permission granted to group or other, and on a differing owner.
4. Bind. An address collision exits with that reason; any other listen failure exits with its own. **Losing the bind race is the success case** from the caller's point of view: a process for this user exists, which is all anyone wanted.
5. Once bound, start the scheduler.
6. For each accepted connection: write the greeting immediately, then read one line under a several-second budget. A retirement request ends the connection and exits the process; everything else ends the connection and carries on.

### The scheduling model

The scheduler holds **no durable state**, and that falls out of a property the work already has rather than from minimalism. The snapshot gates itself on the recorded instant of its last success, which is already persisted and already shared across processes; the re-scan compares each conversation against what was already stored; the upload gates itself on the recorded instant of its last **attempt**. A scheduler recording its own last-run instant would become a *second owner* of the same fact, with nothing to say which to believe when they disagreed.

That third mark is written **on failure as well as on success**, and the asymmetry with the snapshot's — which gates on its last *success* — is deliberate: it is a throttle, not a progress record. Recording only successes would leave every trigger retrying a request that is going to fail in exactly the same way, for as long as the cause lasts. The item's actual progress is recorded separately, in the same file, as per-table cursors that move only on success.

So an interval is **how often to ask** whether the work is due — not how often it acts. The snapshot is asked hourly and answers "already done today" on twenty-three of every twenty-four asks; the upload is asked every five minutes and answers "throttled" on five of every six, and that skip is deliberately the one the run logs nothing for.

Three properties come free from that shape:

- **Catch-up needs no code.** Every item is asked once at startup, so a machine that was off for three days snapshots on the first ask. There is no missed run to model.
- **Retirement needs no handover.** A fresh process inherits nothing and self-aligns on its first ask.
- **No scheduling vocabulary.** "A day since the last success" is already expressed inside the work; restating it here would be the second owner again.

Two further rules:

- **An item that raises is reported and its schedule continues.** Snapshot failure already has an independent, result-oriented signal on the diagnostic command, so a second one here would be noise — and stopping the schedule would turn one bad day into a permanently dead timer. The upload **never raises**, so it never reaches that path at all: a failed upload comes back as a returned result string, which is logged below this process's default file threshold, and what actually makes such a failure visible is the run's own warning lines.
- **An item never overlaps itself.** The snapshot can outlive a short interval, and two concurrent snapshots would race on the same temporary file. The in-flight marker is per item — **and per process**: it says nothing about a second process running the same work. The upload has two other producers outside this one, so two concurrent uploads are possible, and the only thing between them is the recorded attempt instant, which is itself an unsynchronised read-then-write.

The timers are **released** from holding the process alive; the listening address keeps it alive on its own, which is what lets "address closed, process exits" work. This is the **opposite** of the per-worktree proxy's retry timer, which must be held because there it is the only thing keeping its loop alive.

### The work, and its three cadences

| Work | Asked every | Acts when |
| --- | --- | --- |
| The machine-level database snapshot | An hour | A day has passed since the last recorded success |
| The session-statistics upload | Five minutes | Thirty minutes have passed since the last recorded attempt |
| A re-scan noticing an agent conversation has grown since it was last imported | Half a minute | A conversation's instant differs from the one already stored |

Every other trigger is opportunistic, and the sets are **not the same for all three**. For the snapshot and the re-scan they are the dashboard launcher, the post-commit worker and the diagnostic command's repair. For the upload they are the post-commit worker and the diagnostic command's explicit sync flag, and nothing else — **the dashboard launcher does not trigger it at all.** Whichever set applies, it covers the user who commits regularly and abandons the user who does not: exactly the user whose snapshot is oldest, whose afternoon of agent work is least likely to have been recorded, and whose statistics are least likely to have been sent.

**The outer two cadences differ by two orders of magnitude and that is not an inconsistency.** An hourly question is right for work whose answer changes once a day, and a half-minute one is right for work whose answer changes while the user is typing. What makes the fast one affordable is that a converged ask performs no import work at all — it compares each watched conversation's own instant against the one already stored and stops there, so the steady state costs a scan and nothing else.

**The middle cadence is set by a different rule, and it is the load-bearing one: a tick must be strictly shorter than any period the task enforces for itself.** The upload's own due-check is an at-or-after comparison against a thirty-minute floor, so a tick *equal* to that period lands every tick exactly on the boundary, and any negative jitter — timer drift, a busy loop, a tick the previous run overlapped — answers "throttled" and pushes the real upload out to sixty minutes. What that presents as is the feature working at half its stated rate, with nothing anywhere reporting a half. Five minutes against a thirty-minute floor is therefore the first cadence in this topic chosen as a **floor** rather than as a match to how fast the answer changes.

**They may overlap, and nothing stops them.** The in-flight marker is per item, so the snapshot can begin while a re-scan waits on disk. That is safe rather than merely unlikely: the snapshot reads the database and writes a separate file, the re-scan's own write is a short transaction at the very end, and the database's write-ahead journal lets those coexist. The upload's case is stronger still — its database access is **read-only**, and it never writes the database at all, only its own state file. A cross-item mutex would mean giving the scheduler shared state, which is the one thing it must not have.

### No idle timeout

Its only exits are a retirement from a newer bundle, a lost bind race, a refused directory, and the machine going down. This inverts the per-worktree server, which reaps itself when its last client leaves **because** it exists to serve clients — whereas this one exists to be awake when there is nobody to serve.

### Teardown

The removal command sends a retirement request, and is itself on the exclusion list, so nothing in that process brings it back. **It sends it only when the run actually removed something machine-global**, and that condition is the opposite of what "the process is machine-global, not this repository's" would suggest: precisely *because* it is machine-global, a repository-scoped removal has no standing to stop it. Every piece of work it runs is machine-wide, and after a retirement nothing restarts it until an unrelated trigger happens to fire somewhere else. A run in which every removal failed is the same case — nothing was taken away, so the bundle it runs from is still there and still the right one.

Removing a machine-global surface is different: the global command-line install, the global configuration directory holding the shared hook entry scripts, or an editor integration may be the very bundle this process is running out of, so it has to go.

**Do not re-derive that condition from how many items of work there are.** It held when the snapshot was the only one and it holds now, for a reason that is the work's *scope* rather than its number.

### The diagnostic row

A read-only probe reads the greeting without changing anything, and is given a **several-second** budget — an order of magnitude longer than the trigger's, though still short of the shared handshake constant: nothing on a version-control critical path calls it, and a diagnostic reporting "not running" because the process was busy snapshotting would be worse than a slow diagnostic.

| Probe result | Verdict | Message |
| --- | --- | --- |
| A greeting | Healthy | Running, naming the process id, the version, and whole hours of uptime |
| Nothing | Warning | Not running — scheduled work falls back to commit-time triggers |

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| No process | A trigger connects and is refused | Leftover address removed; one started, detached |
| No process | A trigger's connect times out | One started, detached; **no** address removed |
| Running | A trigger reads an equal or newer greeting | Unchanged; the trigger accepts it |
| Running | A trigger reads a strictly older greeting | Retirement requested; the process exits; **no replacement started** |
| Retired, address still held | The next trigger connects and is refused | Leftover address removed; a fresh one started |
| Running | A removal that took away a machine-global surface | Retirement requested; the process exits |
| Running | A removal scoped to one repository, or one where every removal failed | Unchanged |
| Binding | The derived directory is not exclusively this user's | Refuses to bind and exits; nothing is created |
| Binding | The address is already bound | Exits; the incumbent continues serving |

## Notable / Surprising Behavior

- **Losing the bind race is a success, not an error.** The whole point of the trigger is that a process exists; which process it is does not matter.
- **A greeting timeout is treated as a healthy incumbent, not a dead one.** The single most likely reason the process cannot answer within the short budget is that it is doing exactly the work it exists for, through a synchronous interface that stops its event loop. Treating silence as death would make a long snapshot cause a retirement storm.
- **An upgrade removes the resident process and does not replace it until the next trigger.** This is deliberate and is the only way to avoid a replacement dying on the incumbent's still-held address, unwatched. (Surprising; reality.)
- **The retirement request is honoured without any version check.** The teardown path reads and discards the greeting purely so the process's own write completes before answering — the version is irrelevant when the answer is always "stand down".
- **A connection-error handler is kept for the connection's whole life, not just for the connect.** Every caller goes on to write and close, so a peer that retired in between would raise an error on a listener-less connection, which the runtime re-raises as a fatal exception — and four of the five triggers are hooks, so that would kill a session-start or bootstrap process *before* it wrote the output envelope its host is waiting for, in a way the surrounding error handling cannot see.
- **Nothing in the trigger writes to standard output.** One of its callers validates its own standard output as exactly one structured object, so a stray line there fails that host's hook outright while every side effect still lands — making the install look healthy while nothing reaches the model.
- **One comparable surface does not trigger it.** Of the plugin bootstraps, the two older ones trigger it and the most recently added one does not. Its sessions therefore rely on some other surface having brought the process up.
- **The exclusion list keys on the parsed command, never on an argument position.** A global option placed before the subcommand silently defeats the positional form.
- **The bare tool-server invocation never reaches the trigger at all**, because it takes an earlier fast path — but two of its sibling invocations do, which is why they are on the exclusion list rather than being assumed unreachable.
- **The ownership gate is unreachable on the named-pipe platform, and that is a limitation rather than a decision.** That namespace is machine-global, bound with a default access policy, and first-binder-wins, so another local user who can derive the name can squat it. The per-user hash buys *separation*, not protection. (Known limitation.)
- **The log level of the one process a user cannot watch was silently fixed at the default** until it began reading the configured level. Every debug line it emitted, including its own per-item results, was discarded.
- **One cadence is a floor rather than a match.** Every other interval here answers "how fast does the answer change"; the five-minute one answers "what is strictly shorter than the thirty-minute period this work enforces for itself". A tick equal to that period would sit on the boundary every time, and any negative jitter would degrade it to sixty minutes — the feature running at half its stated rate, with nothing reporting a half. (Surprising; the obvious "tick at the period" is the broken choice.)
- **One item's gate is its last attempt, not its last success**, and the snapshot's is the opposite. The newer mark is a throttle rather than a progress record, so it is stamped even when the attempt failed; recording only successes would have every trigger re-issuing a request that fails the same way. That item's real progress lives beside it as cursors that move only on success.
- **The most recently added item carries none of the source-shape protection the item before it was deliberately given.** That protection exists because a unit test cannot observe a task that was never registered at all, and it also pins the item's period to a named constant rather than a literal at the registration. Neither is pinned for the newest item. (Known gap.)
- **Source comments still describe the work as a single item.** Three are scheduled, and there are at least two such comments; both predate the items they undercount, and neither's argument depends on the count.

## Shared Behavior

- **The handshake primitives** — reading exactly one newline-terminated line with a size cap and a total, never-raising failure result; serialising one message as that line; the strictly-newer version comparison in which a tie is *not* newer and an unrankable development version ranks equal to everything; creating an address's parent directory; the per-user address directory naming; and the without-following-links ownership check. These are shared verbatim with the per-worktree tool server, whose flavour prefix keeps one flavour's safety verdict from ever being read as the other's.
- **The core version this bundle carries**, and the rule that it is the shared release number rather than any surface's own — the same number the highest-version-wins runtime dispatch compares, so this handshake and that dispatcher cannot disagree about which bundle is newest.
- **The runtime floor** below which the machine-level database module cannot be loaded without an experimental flag, and the two surfaces that can never be given such a flag. Consulted here as a reason to decline entirely.
- **The snapshot**, its folder rules, its daily gate, its retention floors and its verification. Asked on a clock here; owned elsewhere.
- **The session-statistics upload** — its state file, its gates, its backend scope keys, its silences, its per-table cursors, its first-run window, its per-repository row filter, its batching and its wire manifest. Asked on a clock here; owned elsewhere.
- **The conversation re-scan**, its per-conversation comparison and everything it writes.
- **The parsed-root-command accessor** the exclusion list consults, shared with every other caller that needs to know which command the user actually invoked.
- **The detached-spawn helper** that hides a child process and discards its output.
- **The diagnostic command's row format** — a name, a verdict of healthy, warning or failure, and a message — plus the rule that a repairable verdict offers a repair and an unrepairable one does not.
