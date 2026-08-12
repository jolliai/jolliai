# Global CLI daemon — design

**Date:** 2026-08-12
**Scope:** one machine-global resident process that runs unattended periodic work. This slice ships the process, its singleton discipline, its trigger points, and a scheduler carrying exactly one task (the daily database backup). The session-data upload is the next slice and is deliberately not built here.
**Depends on:** the `per-worktree-mcp-server` branch (JOLLI-2160). This design extracts the reusable half of `McpDaemonProtocol.ts` into a shared handshake module, so it must be branched off that work rather than off `main`.

---

## 1. Why a resident process at all

Two jobs need to happen on a clock rather than in response to a user action:

- **The daily snapshot of `jollimemory.db`.** After the orphan-branch cutover this file is the only disaster recovery there is (see `Backup.ts`). Today the snapshot fires opportunistically from three processes that happen to be running anyway — `jolli dashboard`'s launcher, the post-commit `QueueWorker`, and `jolli doctor`. That works while the user commits regularly and stops working when they don't, which is exactly the user who most needs an old snapshot.
- **Periodic upload of session activity** (the coaching design's Axis 3). Its own spec is explicit that the trigger must be a periodic flush and never a push, because a session may never commit. Collection into the local database is `local dashboard`'s job and is out of scope here; this design only has to guarantee a process exists that can run such a timer.

Both are "must happen even when nobody is working", which is precisely what no existing surface provides.

### 1.1 Relationship to the two daemons that already exist

Neither is a candidate to absorb this work.

`jolli daemon` (`DaemonCommand.ts`) is **per project** — an stdio bridge that pushes refresh notifications to an IDE host. It is owned by the host that spawned it and dies with it.

`jolli mcp-serve` (`McpDaemon.ts`, JOLLI-2160) is **per worktree**, and its singleton key is deliberately the worktree root because five of the ten MCP tools are branch-scoped. It reaps itself when idle, because it exists to serve clients.

This daemon is **per machine per user**, and the key is not a choice: `jollimemory.db` lives at `~/.jolli/jollimemory/` and there is one per machine (`getDashboardDbPath`). A process whose only job is to maintain that file has no reason to be finer-grained than the file.

### 1.2 Why it does not replace `jolli dashboard`'s server

`DashboardServer` is also long-lived, also detached, also machine-global, and also reused after a liveness probe — so the question is a fair one. It is still the wrong process to merge into, for three reasons in descending order of weight:

1. **Port lifetime.** The dashboard server is on-demand: the user runs `jolli dashboard`, looks, and is done. Merging would leave a loopback HTTP port open 24/7 to save one process. A permanently-listening port is a strictly larger attack surface than one that is open only while someone is looking at it.
2. **Blast radius.** The HTTP server has external input (browser requests, routing, token checks); a backup timer has none. Merging lets a crash in the former take out the latter.
3. **Inverted database roles.** `DashboardServer` is read-only and is under a standing prohibition on migrating the schema; `opportunisticSnapshot` opens a **writable** handle, which runs migrations. This is not hypothetical: the module header records that the daily snapshot *used to* fire from `startDashboardServer` and was moved out for exactly this reason.

There is a real follow-up hiding in reason 3, and it should be recorded rather than acted on here. The prohibition exists because `DashboardServer` is "the one long-lived process whose build can lag" — a launcher reuses whatever is already running after probing `/health`, and `/health` reports `{ok, pid, schemaVersion}` with **no bundle version**. This design solves that exact problem for its own process, by putting the version in the handshake and retiring anything older. Teaching `/health` to report the CLI core version and letting the dashboard launcher apply the same `isCoreVersionNewer` rule would dissolve the premise of the prohibition. That is a separate ticket: it changes the dashboard's startup semantics and must not ride along here.

---

## 2. Process model

### 2.1 Command

`jolli global-daemon`, hidden from `--help`. The unqualified name `daemon` is already taken by the per-project IDE bridge, and the two will be running side by side.

### 2.2 Address

- POSIX: `$TMPDIR/.jolli-global-<uid>/daemon.sock`
- Windows: `\\.\pipe\jolli-global-<homeHash>`

The two identify "this user" differently because Windows has no uid to read: `process.getuid` is undefined there, so a uid-keyed pipe name collapses every account on the machine onto `jolli-global-0`. `<homeHash>` is a truncated SHA-256 of the case-folded `homedir()` — keyed on home rather than on the login name because home is exactly what this daemon maintains (`<homedir>/.jolli/jollimemory/jollimemory.db`), and because a pipe name cannot carry every legal username verbatim. It buys separation, not protection: `\\.\pipe\` is a machine-global namespace bound with the default DACL, the same squatting exposure `McpDaemonProtocol` documents.

Under `tmpdir()` rather than `~`, for the reasons `McpDaemonProtocol` documents: a home directory can sit on NFS or a synced folder, neither of which can host a unix socket, and a socket is per-boot state that has no business surviving a reboot. Losing it on reboot is a feature — the next trigger re-spawns.

No path hash. `McpDaemon` hashes because a worktree path blows the 104-byte `sun_path` cap; there is no path to encode here, so a fixed filename is correct and more legible.

The uid is in the directory **name**, not only in its mode bits, because `/tmp` is shared on Linux. The existing `isManagedSocketDirSafe` gate applies unchanged: refuse to bind inside a directory this user does not exclusively own.

### 2.3 Handshake

Same four-line shape as JOLLI-2160 — daemon speaks first so the client can judge it before committing:

```
daemon → client   {"t":"hello","protocol":1,"version":"0.99.3","pid":123,"startedAt":1754... }
client → daemon   {"t":"attach"}  |  {"t":"retire"}
```

`startedAt` replaces `McpDaemonHello`'s `cwd`: a machine-global daemon has no cwd to assert, and the field is useful for the doctor line in §5.

Version comparison reuses `isCoreVersionNewer` verbatim, including its two deviations from `ExecutableResolver.isNewer`: a **tie attaches rather than retires** (or two same-version triggers would evict each other forever), and an unrankable sentinel like `"dev"` ranks equal in both directions (so a released build does not repeatedly retire a developer's dev daemon).

### 2.4 Lifetime

The daemon runs until retired or until the machine goes down. It has **no idle timeout** — this is the deliberate inversion of `McpDaemon`, whose five-minute idle exit is correct precisely because it has clients. This process exists to be awake when nobody is around; an idle timer would remove its reason to exist.

Consequently the only convergence mechanism is retire-on-newer, which is why the version has to be in the handshake.

**Known coverage gap: a reboot with no subsequent activity.** The socket does not survive a reboot and nothing re-spawns the daemon until a trigger fires. So the daemon covers *machine on, user idle* — which is the case it was built for — but not *machine rebooted, user absent for days*. Boot Monday night, do not touch Jolli until Friday, and Tuesday through Thursday have no snapshot.

This is accepted rather than solved, for two reasons. The exposure is bounded by the retention floor: `Backup.ts` never deletes below `MIN_SNAPSHOTS_KEPT` verified snapshots regardless of age, precisely so that a user who has been away is not left with nothing. And closing it properly means an OS-level launch agent (`launchd` / `systemd` / Task Scheduler) — three platform implementations plus install/uninstall registration, which is a larger surface than the gap justifies. If it later proves to matter, that is the fix; it composes with this design rather than replacing it, since a launch agent would simply become a fifth trigger.

### 2.5 The shared handshake module

`McpDaemonProtocol.ts` currently mixes two concerns: the MCP-specific address derivation and message shapes, and a generic "one daemon per key, newest build wins" toolkit. The generic half moves to `cli/src/core/DaemonHandshake.ts`:

- `cliCoreVersion()`, `isCoreVersionNewer()`
- `encodeHandshakeLine()`, `readHandshakeLine()`
- `ensureSocketParentDir()`, `isManagedSocketDirSafe()`, `isInManagedSocketDir()` — generalised over the socket directory name

What stays MCP-specific: `mcpSocketPath` (the worktree hash), `McpDaemonHello`/`McpClientGreeting` (the `cwd` field), `MCP_DAEMON_PROTOCOL`. Each daemon keeps its own protocol constant; they version independently.

---

## 3. Scheduler

### 3.1 The scheduler holds no persistent state

This falls out of a property the backup task already has. `maybeSnapshot` gates itself:

```ts
const last = db.prepare("SELECT value FROM schema_meta WHERE key = 'last-snapshot-at'").get();
if (!opts.force && Number.isFinite(lastMs) && opts.nowMs - lastMs < DAY_MS) {
    return { status: "skipped", reason: "daily snapshot already taken" };
}
```

The task therefore already knows whether it is due, and that knowledge is already persisted **in the database**, already shared across processes. A scheduler that recorded its own `lastRun` would create a second owner of the same fact, and nothing would say which to believe when they disagree.

So the scheduler is a dumb ticker:

```ts
interface DaemonTask {
    readonly name: string;
    /** How often to ASK this task whether it is due — not its execution period. */
    readonly tickIntervalMs: number;
    /** The task decides whether to act. The returned string is for logging only. */
    run(): Promise<string>;
}
```

and this slice registers exactly one:

```ts
{ name: "backup", tickIntervalMs: HOUR, run: () => opportunisticSnapshot() }
```

Asked hourly, the task answers "already done today" 23 times and acts once.

Four properties come for free from this shape:

- **Catch-up needs no code.** The daemon ticks once at startup. After three days powered off, the first tick finds `now - last > DAY_MS` and snapshots immediately. There is no such thing as a "missed run" to model.
- **Retire and restart need no handover.** A fresh daemon inherits nothing and self-aligns on its first tick.
- **No contention with the existing opportunistic callers.** `jolli dashboard`, the post-commit `QueueWorker` and `jolli doctor` all still call `opportunisticSnapshot`; whoever arrives first acts and the rest see the timestamp. The daemon is one more caller, distinguished only by asking when nobody is working.
- **No cron expressions.** "24 hours since the last success" is already expressed in the task. The scheduler must not restate it.

### 3.2 Failure policy

A throwing `run()` is logged and the schedule continues. It never stops the ticker and never exits the process. Backup already has an independent, result-oriented health signal (`backupHealthCheck`, wired into `jolli doctor`) — the daemon should not invent a second one.

### 3.3 Timers are `unref`'d

The listening handle keeps the process alive on its own, so `unref`ing the tick timer is what lets "socket closed → process exits" work. Note this is the **opposite** of `McpProxy`'s deliberately non-`unref`'d retry timer, where the timer is the only handle during the spawn wait.

---

## 4. Triggers

One shared helper, `ensureGlobalDaemon()`, called fire-and-forget from four entry points. It never throws, never blocks its caller, and logs on every failure path.

### 4.1 Flow, and why the timeout branch does nothing

```
connect(socket)
  ├─ ok   → read hello, budget 300ms
  │          ├─ received → newer than me? → send retire, disconnect, DO NOT spawn
  │          │                            → otherwise, disconnect
  │          └─ timed out → assume alive, do nothing, disconnect
  └─ fail → remove stale socket file → detached spawn → return immediately
```

**A retiring trigger does not spawn the replacement.** This looks like an omission and is the opposite: the retired daemon still holds the socket at the moment `retire` is delivered — and, per §5.3, may hold it for the rest of an in-flight `VACUUM` — so a replacement spawned immediately dies with `address-in-use`. Because the trigger deliberately does not wait for its spawn (§4.2), that death would be entirely silent: the upgrade would remove the daemon and nothing would report it.

Waiting for the old socket to become unreachable before spawning (what `McpProxy.waitUntilUnreachable` does) is the wrong fix here, because it puts an unbounded wait back on a git-hook path to solve a problem that resolves itself. Leaving the respawn to the **next** trigger is bounded, self-healing, and needs no code: triggers are frequent while the user is working, and a retire only happens immediately after an upgrade — which is itself a trigger-dense moment (`jolli enable`, the plugin bootstrap, the next commit). The cost is a gap with no daemon between the retire and the next trigger, during which backups fall back to the opportunistic callers that already exist.

This also keeps `uninstall` correct for free: it sends `retire` and is on the exclusion list, so nothing respawns.

Two things here are not arbitrary.

**The 300ms budget replaces `HANDSHAKE_TIMEOUT_MS = 10_000`.** Ten seconds is right for an IDE bringing up an MCP session; on the `post-commit` path, whose budget is under 5 ms, it is not.

**On timeout the answer is "do nothing", not "retry" or "assume dead".** The two halves of the handshake answer different questions with different bounds. `connect()` answers *does one exist* and is answered by the kernel, so it is bounded. Reading `hello` answers *which build is it* and is answered by the daemon's event loop, which is **not** bounded — the daemon runs `VACUUM INTO` through `node:sqlite`'s synchronous API, so it stops answering anything for the duration. Measured on a 143 MB database: 547 ms for the VACUUM plus 196 ms for the `PRAGMA integrity_check` that verifies the snapshot, and both scale with database size.

A successful `connect()` already proves a process is listening, which is all the trigger needs. The version check is an optional refinement, so it gets a short budget and no recovery. This bounds the worst case a trigger can inherit at 300 ms without giving up the single-mechanism simplicity of doing the handshake everywhere.

The window is small — roughly 0.75 s of blocking per day — so this is a tail risk, not a common one. It is bounded here because bounding it costs one timeout branch.

### 4.2 Spawn

Detached, `stdio: "ignore"`, `cwd: homedir()`, entry resolved from `process.argv[1]`.

`argv[1]` rather than `import.meta.url`, exactly as `McpProxy.spawnDetachedDaemon` documents: under the CLI's multi-entry Vite build this module is a shared chunk, so `import.meta.url` names the chunk instead of an executable entry. `argv[1]` is the dist entry Node was actually launched with, which guarantees trigger and daemon are the same build — without which the version in the handshake would not mean what it says.

No Node flags before the script: a flag an older Node does not recognise kills the child before it runs a line of code, and with `stdio: "ignore"` that death is invisible.

Unlike `McpProxy`, the trigger **does not wait for the spawned daemon to bind**. The proxy has to wait because it must forward traffic over that connection; this helper only has to ensure one exists. `connectWithRetry` and the three-round retry loop are therefore not needed. (`waitUntilUnreachable` is not needed either, but for a different reason — see the retire discussion in §4.1.)

### 4.3 The exclusion list

| Command | Reason |
|---|---|
| `global-daemon` | would trigger itself — infinite recursion |
| `mcp`, `mcp-serve` | stdout carries the MCP stream; also the cold-start-sensitive path |
| `daemon` | stdio bridge, stdout equally sensitive |
| `uninstall`, `disable` | tearing down must not start things |

The first three are mechanical. The fourth is semantic and is the one that gets missed: without it, `jolli uninstall` spawns a resident process on its way out and leaves an orphan behind. The converse also holds — `uninstall` should actively send `retire`.

The check keys off the commander-parsed command, not an argv position, mirroring `shouldSkipExitFlush()` in `Cli.ts`, whose comment records why: an argv-position test silently breaks the first time a global option is added before the subcommand.

### 4.4 The Node floor gate

The daemon's only job writes the dashboard database, and `node:sqlite` throws on import below Node 22.13 (the five-place lockstep in `AGENTS.md`). `ensureGlobalDaemon` therefore consults `canUseDashboardDb()` — a string comparison against `process.versions.node`, no probe — and **does not spawn** when it is false. A resident process that cannot do the only thing it exists for is worse than no process.

### 4.5 Call sites

| Entry | Location | Note |
|---|---|---|
| Any CLI command | `Cli.ts`, tail, next to `flushTelemetryNow` | subject to §4.3 |
| post-commit | `PostCommitHook.ts`, beside the existing detached `QueueWorker` spawn | already a fire-and-forget region |
| session start | `SessionStartHook.ts` `main()`, after session metadata is written | |
| plugin setup | `PluginBootstrapHook.ts`, `CodexPluginBootstrapHook.ts` | see below |

The Codex bootstrap's stdout must remain exactly one JSON object in the `hookSpecificOutput` envelope. This is a recorded incident, not caution: `SessionStartHook` lacked its basename guard, self-ran inside both plugin bundles, and wrote plain text ahead of the JSON — Codex rejected the whole hook and the briefing silently never reached the model. The helper shares all four entry points, so it inherits the constraint: **nothing it does may write to stdout.**

---

## 5. Failure semantics and observability

### 5.1 Logging destination

A detached process inherits its spawner's cwd, and `getJolliMemoryDir()` falls back to `process.cwd()` when `setLogDir` has not been called. Left alone, the daemon would write `debug.log` into whichever repository happened to trigger it first — a different one across reboots.

The daemon calls `setLogDir(homedir())` at startup, which lands the log at `~/.jolli/jollimemory/debug.log` because `getGlobalConfigDir()` is `join(homedir(), ".jolli", "jollimemory")` and the two coincide. The spawn also passes `cwd: homedir()` so that every cwd-derived path in the process agrees.

### 5.2 Report the outcome, not the process

`jolli doctor` already reports how long ago the last successful snapshot was, via `backupHealthCheck`. That stays the primary signal, and the daemon's line is an addition, not a replacement:

```
global daemon: running (pid 12345, v0.99.3, up 3h)
backup:        last successful snapshot 6h ago
```

The ordering matters. A daemon that is running but has never successfully snapshotted is a worse state than no daemon at all with backups landing opportunistically from `QueueWorker` — so the state of the process must never be presented as evidence that the work is getting done.

### 5.3 Retire, and why "finish the current job first" is free

Retire here means: stop the scheduler, close the socket, exit. There are no clients to drain, so `McpDaemon`'s "stop accepting, let existing clients finish" is not needed.

If a retire arrives mid-backup, the synchronous `VACUUM` means the message is not read until the snapshot completes — so "finish what you are doing, then exit" holds without any mechanism implementing it. This is worth stating explicitly because it is a property of the synchronous API: anyone later moving the backup to a worker thread or child process must re-establish it deliberately.

### 5.4 Stale sockets

A `kill -9` leaves the socket file behind. The next trigger's `connect()` gets `ECONNREFUSED`, removes the file, and spawns. Same treatment as `McpProxy.removeStaleSocket`.

---

## 6. Testing

The CLI floor is 97/96/97/97 and this must not lower it.

- **Pure functions** — handshake encode/decode, version comparison, exclusion-list predicate, socket path derivation. The bulk of the coverage, plain unit tests.
- **Scheduler** — injected clock and fake tasks. Assert: ticks at the interval; a throwing `run()` does not stop the schedule; startup ticks once immediately.
- **Daemon lifecycle** — mirrors `McpDaemon.test.ts`: a scratch socket path plus an `onListening` callback to await binding rather than polling. Real bind, real connect, real retire. That file is 464 lines and is not in `SLOW_TEST_FILES`, so the shape is fast enough for the inner loop.
- **Real spawn** — the handful of lines that spawn a live process are wrapped in `/* v8 ignore start */` … `/* v8 ignore stop */` with an injected `spawnDaemon` seam for tests, exactly as `McpProxy` does. Single-line `v8 ignore next` does not work in this repo; only the block form does.

The backup task itself is not re-tested — it has its own suite, and the scheduler's contract with it is only "call it hourly".

---

## 7. Out of scope

- **Session-data upload.** The next slice. It becomes one more `DaemonTask` registration plus an upload implementation; no scheduler change is anticipated.
- **Session-data collection into the local database.** Owned by local dashboard.
- **Merging or supervising `DashboardServer`.** See §1.2.
- **Teaching `/health` to report the CLI core version** so the dashboard launcher can apply the same retire rule. Follows naturally from §1.2 but changes the dashboard's startup semantics and belongs in its own ticket.
