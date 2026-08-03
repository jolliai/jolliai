# 285. Post-Commit Capture Progress Streaming

## Topic Statement

Give an interactive caller (a terminal user, or an AI-agent session) a live, milestone-by-milestone view of the background memory-capture pipeline for a just-created commit, by having the background worker append lifecycle events to a per-commit progress stream and having the post-commit hook tail that stream and print each milestone — blocking the commit only in interactive contexts, under bounded timeouts, and with a liveness probe that exits early if the worker was force-killed. Non-interactive commits keep the original fast, silent, non-blocking path. The background worker does the real work regardless; the watcher is a pure observer, so an interrupted or timed-out watch never loses the summary.

## Scope

**In scope:**
- The per-commit progress stream: its per-hash newline-delimited-JSON file, the milestone events the worker appends, and the tolerance for a torn or corrupt trailing line.
- The per-hash liveness lock the worker writes (carrying its process id) and the watcher probes to detect a force-killed worker.
- The gate that decides whether the post-commit hook prints feedback at all: the config setting, its environment override, and the "auto" default keyed on interactive context.
- The interactive-context definition: a real terminal, or an AI-agent session identified by a fixed set of environment markers.
- The tail-and-print loop: delivery order, replay of events written before the watch began, and the three ways the watch ends (terminal event, timeout, worker-dead).
- The two distinct timeout ceilings (agent vs. terminal) and why they differ.
- The rendering of each milestone to a human-readable line, including which milestones print nothing.
- The accurate closing line chosen from how the watch ended, including the network-denied-sandbox diagnosis that supersedes it.
- The expired-local-login special case on the stored milestone.
- Opportunistic pruning of aged progress and lock files.

**Out of scope (boundaries):**
- The worker's drain loop, dispatch table, and the summary-drain lock protocol (owned by the queue-worker spec); this spec only covers the progress stream and per-hash lock the worker maintains per commit-typed entry.
- The commit summarization pipeline's internal stages (owned by the per-commit summarization and squash-consolidation specs); this spec only names the milestones those stages emit.
- The shared remediation copy shown for an expired local login, and the session-start reminder surface (owned by the local-agent login-expiry remediation spec); this spec only covers how the post-commit watcher surfaces it.
- The post-commit hook's enqueue and worker-spawn behavior (owned by the post-commit-hook-enqueue spec).

## Data Contracts

### Per-commit progress stream

A newline-delimited JSON file keyed by the commit hash, living in a dedicated `capture-progress` subdirectory of the per-project state directory. The worker appends one event per line as it advances; a reader parses every well-formed line and silently skips a trailing line that is torn (append not yet flushed) or corrupt.

Each event carries:
- a **step** (milestone) label;
- the commit hash;
- a millisecond timestamp;
- an optional **terminal** flag — when set, a watcher stops after delivering this event;
- an optional structured **data** payload (all fields optional): files-changed / insertions / deletions counts; a list of linked-context tags (plan slugs and external-reference native ids); a notes count; a topics count; and an **auth-expired** boolean.

### Milestone (step) set

- **start** — capture began for this commit.
- **diff** — diff measured; carries file/insertion/deletion counts.
- **references** — linked context resolved; carries the tag list and notes count.
- **analyzing** — the semantic-intent model call is running.
- **plan-progress** — plan-progress evaluation is running.
- **stored** — a summary was persisted (may carry a topics count and/or the auth-expired flag).
- **skipped** — nothing to capture (empty diff and no transcript, or a no-op consolidation/migration).
- **failed** — capture could not complete (unknown entry kind, or a hard error before any stored/skipped milestone).
- **end** — always emitted last, in a `finally`, marked terminal.

`skipped` is emitted terminal; `stored` is not (it is followed by the terminal `end`); `failed` is followed by the terminal `end`. A watcher therefore always ends on a terminal event unless it times out or detects a dead worker first.

### Per-hash liveness lock

A lock file keyed by a hash of the commit hash, in the same `capture-progress` subdirectory, whose body is the worker's process id. The worker writes it at the start of processing a commit-typed entry and removes it in the terminal `finally` — but only when the recorded process id still matches its own, so a successor worker's fresh lock is never deleted by a stale release. A watcher reads the recorded process id and probes whether that process is alive:
- **present and its process is not alive** → the worker was force-killed mid-capture and can never emit its terminal event; the watcher stops early.
- **absent** (worker not started yet, or finished and released) → **not** dead.
- **present and alive** → still working.

### Feedback gate

Resolved from three sources, in precedence order:
1. An environment override (`on` / `off` / `auto`; any other value ignored).
2. A persisted config setting (`on` / `off` / `auto`).
3. The default, `auto`.

Resolution:
- `on` → always print.
- `off` → never print.
- `auto` → print only where a human will see standard output: a real terminal, **or** an AI-agent session.

### Interactive-context markers

An AI-agent session is recognized by the presence of any one of a fixed set of environment markers (covering the major coding agents). A marker counts as present only when it is defined, non-empty, not `"0"`, and not `"false"` (case-insensitive). A real terminal is recognized from the standard-output stream being a TTY.

No agent gives the command a TTY, so for an agent session the marker is the only thing that opens the gate. Each host's marker must therefore be one that is present however that host runs a command, and scoped to the command-execution environment — a variable that also appears where the host runs its own lifecycle hooks, or that a non-agent invocation of the host's tooling sets, would make a hook or a plain sandboxed command mistake itself for an agent session. A sandbox-state variable is specifically not such a marker: it is absent when the host runs unsandboxed and present when the host's sandbox is used without any agent behind it.

### Timeouts and poll cadence

- **Terminal (human) ceiling:** 90 seconds — the user watches live progress and can voluntarily wait.
- **AI-agent ceiling:** 15 seconds — the watch blocks the commit and an agent cannot walk away, so a long silence is unacceptable; the background worker keeps running regardless and the watcher simply prints the "continues in the background" closing line earlier.
- **Poll interval:** ~300 milliseconds.
- **Progress/lock artifact max age:** 60 minutes (used for opportunistic pruning).

The agent-vs-terminal ceiling is chosen from whether the session is an agent session (the marker set only — a plain TTY human still gets the longer ceiling). An explicitly supplied timeout overrides both.

## Behavior

### Worker side (emission)

For each commit-typed queue entry, the worker: prunes aged progress and lock artifacts; writes its process id into the per-hash lock; emits `start`; emits the pipeline milestones as it advances (`diff` with counts, `references` with tags/notes, `analyzing`, `plan-progress`, then `stored` or `skipped`); on an unknown entry kind emits `failed`; on a hard error before any outcome emits `failed` and rethrows; and, always in a `finally`, emits the terminal `end` and releases the per-hash lock if still owned. Every emission and lock operation is best-effort — a failure is swallowed so the pipeline is never affected. The rebase-pick migration and squash/rebase-squash consolidation handlers participate in the same bracket.

### Gate resolution (hook side)

Before watching, the hook loads the config setting (a load failure is treated as "unset"), then resolves the gate as above. If the gate says no, the hook returns without watching.

### Tail-and-print loop

When the gate says yes, the hook tails the commit's progress file:
1. Each poll re-reads the file from the beginning and delivers every event not yet delivered, in order — so any events written before the watch began are still delivered (nothing early is lost).
2. Each delivered event is rendered to a line and printed (some milestones render to nothing).
3. If a delivered event is terminal, the watch ends as **terminal**.
4. Otherwise, if the elapsed time has reached the timeout, the watch ends as **timeout**.
5. Otherwise, if the worker is probed dead (per the liveness lock), the watch ends as **worker-dead**.
6. Otherwise, sleep one poll interval and repeat.

### Milestone rendering

- **start** → a header line naming the product and the short (7-char) commit hash.
- **diff** → an indented "indexing N file(s) changed (+X −Y)" line; nothing if no files changed; the delta suffix appears only when there is a non-zero delta.
- **references** → an indented "found links to: #tag, #tag" line (each tag prefixed with `#` if not already); nothing if there are no tags.
- **analyzing** → an indented "analyzing semantic intent of the change…".
- **plan-progress** → an indented "evaluating plan progress…".
- **stored** → the success line, **unless** the auth-expired flag is set, in which case the shared login-expiry remediation copy is printed instead (see the local-agent login-expiry remediation spec), because an auth-expired "stored" summary is an empty placeholder, not a real capture.
- **skipped** → an indented "(no changes to capture)".
- **failed** → a warning line pointing at the local debug log.
- **end** → nothing.

### Closing line (accurate to how the watch ended)

After the loop, the closing line is chosen so the user is never left on a dangling "capturing…" nor wrongly told work continues:
- if a `stored` or `skipped` milestone was seen, it already printed its own outcome line → print nothing more (with one exception: an auth-expired `stored` under a network-denied sandbox is not treated as an outcome, and prints neither its own line nor nothing — see below);
- else if the environment identifies a **network-denied sandbox** (see below), print the sandbox notice — it replaces, and is never printed alongside, any of the three endings below;
- else if a `failed` milestone was seen, it already printed its own warning line → print nothing more;
- else if the watch ended **worker-dead**, print a warning that capture was interrupted before finishing (pointing at the debug log);
- else (timeout with the worker still alive) print "analysis continues in the background…".

### Network-denied sandbox

An agent that runs the commit inside a sandbox denying network access traps the entire pipeline with it: the hook, the detached worker it spawns, and the local-agent subprocess that worker spawns all inherit the sandbox, so the model call can never complete. Detaching does not escape it. The sandbox is identified from a single environment marker, distinct from the interactive-context markers above and never used as one.

Both the `failed` line and the "continues in the background" line are wrong in this state — the first invites a retry that must fail identically, the second promises work that provably cannot happen — and the queue entry is discarded regardless of outcome, so no later drain recovers the commit. The notice therefore states that this commit has no memory and will not be retried, and points at the sandbox's network-access setting plus the option of committing outside the agent.

A real `stored` or `skipped` outcome disproves the diagnosis and wins over it. An **auth-expired** `stored` does not: with no network the backend cannot reach its own authentication endpoint either, so that classification is a symptom of the sandbox rather than a stale login, and its sign-in guidance would send the user to fix the wrong thing. In that combination the sandbox notice replaces the expired-login remediation. Outside a blocking sandbox the expired-login remediation is unchanged.

### Pruning

At the start of processing each commit-typed entry the worker opportunistically deletes both progress files and lock files older than the max-age threshold (by modified time). A live lock is refreshed well within the threshold, so only genuinely abandoned artifacts (e.g. from a force-killed worker) age out.

## State Transitions

### Per-hash liveness lock

- **Absent** → **Present (this worker's PID)** when the worker starts a commit-typed entry.
- **Present (this worker's PID)** → **Absent** in the terminal `finally`, PID-checked so only the owner removes it.
- **Present (a dead PID)** → observed by a watcher as **worker-dead**; removed later by age-based pruning.

### Watch outcome

- **Watching** → **terminal** on a terminal event.
- **Watching** → **timeout** when the ceiling elapses with the worker still alive.
- **Watching** → **worker-dead** when the liveness probe finds the recorded PID gone.

## Notable Behavior

- **The watcher is a pure observer; the worker is unconditionally detached.** Timing out, interrupting, or skipping the watch never affects summary generation — the background worker does the work either way. The watch only reads the progress file and probes the lock.
- **Emission and locking are always best-effort.** An unwritable directory, a full disk, or a lock-write failure degrades only the interactive fidelity (fewer milestones, weaker dead-worker detection); it never breaks the pipeline.
- **Non-interactive commits keep the original fast, silent path.** A graphical git client sets neither a TTY nor an agent marker, so under the `auto` default it never watches or blocks.
- **Agent sessions get a much shorter ceiling than terminals.** An agent blocks the commit and cannot choose to wait, so 15 seconds; a human at a terminal sees live progress and gets 90 seconds. The worker is unaffected by which ceiling applies.
- **Events written before the watch began are still delivered.** Each poll re-reads from the start and skips already-delivered lines, so a watch that attaches slightly after the worker's first emissions still shows them in order.
- **A force-killed worker is detected via the PID lock, not by waiting out the timeout.** Only a present-but-orphaned lock is "dead"; an absent lock is treated as "not started or already finished," never dead. This turns the worst case from a full-timeout block into a prompt, accurate "interrupted" message.
- **The closing line distinguishes done / interrupted / still-running.** A resolved capture prints its own outcome; a dead worker prints an interrupted notice; a live-but-slow worker past the timeout prints "continues in the background." The user is never misinformed.
- **A doomed capture is reported as doomed, not as pending.** Where the environment proves the pipeline cannot succeed — a sandbox denying the network to the worker as much as to the watch — the closing line says the memory does not exist and will not be retried, instead of the generic wording that would imply a retry or ongoing background work. This is the one case where the watcher speaks for the worker's fate rather than only for its own observation, and it is sound precisely because both inherit the same environment.
- **An auth-expired `stored` is surfaced as a failure, not a success.** Because the stored summary is an empty placeholder when the local login expired, the watcher prints remediation guidance instead of the success line (see the local-agent login-expiry remediation spec).
- **The gate is env-override → config → auto.** An explicit environment value beats the persisted setting, which beats the interactive-context default.

## Shared Behavior

- The worker that emits the stream, holds the summary-drain lock, and drains the queue is defined by the Git Operation Queue Worker topic.
- The post-commit hook that enqueues, spawns the worker, and then (in an interactive context) runs this watch is defined by the Post-Commit Hook Enqueue topic.
- The shared login-expiry remediation copy surfaced on an auth-expired `stored` milestone, and the parallel session-start reminder surface, are defined by the local-agent login-expiry remediation spec.
