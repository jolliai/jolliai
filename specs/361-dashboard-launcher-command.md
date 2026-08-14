# 361. Dashboard Command

## Topic Statement

The command a user runs to open the local dashboard, from end to end: the refusals that stop it before it touches anything (the runtime floor, an unusable port option), the schema it creates before anything reads, the directory it resolves for the server it binds **in its own process**, the browser it opens, the signal it then waits on until the user stops it, and — running between the bind and that wait, unable to fail the launch — the history import, whose terminal block stays hidden until a cursor-gated tier proves there was work, whose closing figures are computed only over the repositories actually swept, and whose repositories with no checkout left on disk are reported by a sampled notice of their own.

## Scope

**In scope:**

- The launch sequence, why the write side comes after the bind, and why the command does not return.
- Reclaiming the preferred port from a dashboard already on it: what is asked, what is signalled, and what is deliberately left alone.
- The split between binding/opening the browser and waiting for the signal, and the one other caller that needs the first half without the second.
- The deferred writer: what it holds, when it flushes, and why the header is chosen at reveal time rather than written up front.
- The reveal rule — which progress tiers may put the block on screen, and which is deliberately excluded.
- The progress printer's line rules: the phase labels, the slow-run warning and its narrowing, the resume announcement, the per-tier suppression thresholds, and the quarter-mark counters.
- The closing report: the per-repository failure lines, the migrated-memory tally, the bootstrapped count, and the across-how-many-repositories phrase — all computed over the swept set.
- The unavailable notice: its predicate, its sampling, its wording, and the fact that it bypasses the deferred writer entirely.
- The server-free sibling entry point that runs the same import without touching a port or a browser.
- The never-throws contract on the import half.

**Boundaries (consumed here, owned elsewhere):**

- The service this command binds and opens a browser at — its port candidates, its routes and its security model are defined by the **Local Dashboard HTTP Server** topic (cross-ref 352). Only the contract between the two (the bind call, the port it may request, and the fallback flag it gets back) appears here.
- The sweep itself — which repositories it walks, its four cursor keys, its tiers, its per-repository result record and its progress records — is defined by the **Dashboard Database Repository Backfill** topic (cross-ref 350). This spec defines what the caller *says* about those results, which that topic explicitly leaves to the caller.
- The registry of enabled repositories and the identity derived for each are defined by the **Dashboard Repo Registry and Probe** topic (cross-ref 355). This command registers the current directory and never prunes an entry.
- The routing attempt that follows the import (cross-refs 344, 345) and the snapshot pass after it (cross-ref 349) — the last two things that happen before the command settles into serving. Both report nothing and neither can throw, so neither can affect this command's output or its exit status.
- The runtime floor that decides whether the database can be opened at all.

## Data Contracts

### Options

| Option | Meaning |
| --- | --- |
| Port | An explicit port. Parsed as a base-10 integer; a non-finite value, a value at or below zero, or one above the maximum port number is refused with an error naming the value, and the command fails |
| No-open | Print the URL instead of opening a browser. The URL is printed either way |
| Directory | The repository directory to register, and the root the server answers for. Defaults to the process's own directory |

**There is no stop option**, because there is nothing to stop but this command. It used to exist, alongside a detached service, a pid/port state record, a spawn lock that stopped two invocations racing into two services, and a two-hour idle self-shutdown. All of that is removed.

### Reclaiming the preferred port

Every launch serves from a fresh process, so a dashboard already on the port this one wants is **stopped first**. The step runs before the bind:

1. Ask the preferred port — the explicit port option when given, otherwise the first candidate — for the liveness route (cross-ref 352).
2. No answer, or an answer that is not one of ours, or our own process id: do nothing. Something else holding that port is a stranger, and the bind falls through to the next candidate exactly as it would have.
3. Otherwise signal the process id it reported, then poll until the port stops answering, up to a **two-second** budget. Timing out is not an error — the bind simply moves on.
4. A delivered signal is announced on its own line, because a dashboard someone was looking at just went dead.

Only the PREFERRED port is reclaimed. A dashboard on the fallback port is left alone: nothing is competing for it, and killing it would be gratuitous.

**This is discovery to REPLACE, never to attach**, which is the whole difference from the launcher that preceded it. Nothing here can serve a page from a build older than this one, so none of the reuse constraints come back with it — see 352 for why the process id it acts on cannot be stale, unlike the one the state file used to record.

### The deferred writer

A line writer that holds everything until the caller says the block has earned its place on screen. It exposes two operations: write a line (printed if revealed, held otherwise), and reveal (flush everything held, print directly from then on).

- **The header is a reveal argument, not a line written up front.** *Which* tier turned out to have work is discovered inside the run, and the header names it, so it cannot be chosen before the run starts.
- **The first reveal wins.** A later one cannot retitle a block already on screen.
- **Ordering survives the delay.** Held lines flush in the order they were written, ahead of the header's own line and ahead of anything printed after the reveal.
- Reveal is idempotent.

**An elapsed-time reveal was tried and removed.** It cannot separate the two cases it needs to: a converged pass is not instantaneous — one tier re-projects the discoverable session set unconditionally by design — and its duration is the same order as the wait that would justify narrating a slow run. Any threshold therefore either fires on every launch, which is the complaint the deferral exists to fix, or is long enough to leave a real first sweep silent for most of it. The progress records' own tier field answers the question directly and deterministically instead.

### The two headers

Two separate strings, because they describe different work:

| Header | Chosen by |
| --- | --- |
| "Indexing your git history" | The commits tier having work |
| "Migrating your memories to the database" | The memories tier having work; also used to frame a per-repository failure line and the "something landed" closing line |

Naming a git-history scan as a memory migration is what made a routine commit sweep read as "it re-migrates everything on every launch" — the memory tier had converged and said so on the very next line.

### Terminal output shapes

Everything printed is a plain line; there is no carriage-return redraw and no spinner, because nothing else in this command line has one and a rewritten line is invisible in a piped log.

## Behaviors (execution order)

### The launch sequence

1. **Refuse below the runtime floor**, naming the required runtime and the one in use. The command fails.
2. **Create or upgrade the database schema before anything reads.** Every render opens a read-only handle, and read-only is the one mode that must not create a schema; nothing else on this path is guaranteed to create the file either, since registration is skipped outside a repository and an import with no registered repositories returns without opening a writable handle. A first run in a non-repository directory otherwise served a plain-text failure on every page, with no scripts on it to ever recover. This step is also what makes the schema **this build's** before anything serves, which is why the server's registry projection needs no version gate of its own. A failure here is reported and the command fails.
3. **Register the current directory** as a repository when it is one. Outside a repository the dashboard still opens with whatever is already registered; the failure is recorded at information level only.
4. **Validate the port option.**
5. **Start the server** (below), which reclaims the preferred port first. A failure here is reported and the command fails.
6. **Run the history import** (below) — the write side, after the page is already up.
7. Attempt the routing conversion, **throttled**, and then the snapshot pass. Both are boundaries; neither prints anything here and neither can throw.
8. **Wait for the stop signal.** The command does not return until then.

The order exists so the page appears fast: the page renders whatever the database already holds and polls for its model, so history fills in as the import lands rather than blocking the launch. The import shares this process's event loop now, so a first full sweep makes the page slower while it runs — still better than a blank browser for the minutes it takes.

### Starting the server

Two halves, returned separately, because one caller needs the first without the second:

1. **Resolve the directory the server answers for** — the repository root, and always a real directory. Always real because the Settings page reads that path per request, so a bogus one would surface once per render instead of once at launch; the root rather than a subdirectory because the Settings page's per-repository displays and repo-scoped actions would otherwise answer for a subdirectory. A directory outside a repository, or any failure resolving the root, keeps the validated directory as-is.
2. **Reclaim the preferred port** (above). Before the flusher, so a launch that never binds does not leave a timer nothing stops.
3. **Arm the periodic telemetry flush.** This process serves for as long as the user leaves the tab open, and it is the process the page's telemetry beacon posts into, so the one flush the command runtime does at exit is not enough. Priming is *not* done here — the CLI runtime already primed the context, with the project directory that every flusher for this project must agree on.
4. **Bind**, passing the explicit port when one was given.
5. **Open the browser** at the page URL, unless the no-open option was given. A browser failure is a warning, never a failure of the command.
6. **Print** the fallback line when the bind reports one, then the URL, then the stop hint.
7. **Return the bound port and an unresolved wait**, which the caller invokes when it has nothing left to do.

The browser is opened through a general-purpose opener rather than the product's own URL-opening helper, because that helper enforces an HTTPS-only allowlist which correctly rejects a loopback address, and loosening it for the loopback case would weaken every other caller.

### Waiting for the stop signal

Registers `SIGINT` and `SIGTERM`; on either, removes both handlers, closes open connections, closes the listener, does one final telemetry flush and resolves. Both are registered although only `SIGINT` is ever delivered on Windows, so one code path covers every platform.

**It deliberately does not exit the process.** The detached entry this replaces had to, because nothing ran after it; here the stack unwinds back into the command runtime, whose tail flushes telemetry a final time and triggers the machine-global daemon. Exiting here would skip both — the daemon trigger silently, which is the kind of loss nothing reports.

### The history import

Wrapped so it **never throws**: any escaping failure is printed as a one-line warning that the memory migration failed. A failed import is not a failed launch and not a failed enable.

1. **List the active repositories.** Zero of them stays completely silent, header included: there is no work, and announcing none is worse than saying nothing. The sweep is still invoked — an empty sweep is a no-op, and skipping it would make this function's behaviour depend on the registry, which its callers rely on it not doing.
2. **Create a deferred writer and a progress printer over it**, then run the sweep with a progress handler that (a) reveals a header when the tier warrants it and (b) forwards every record to the printer.
3. **The reveal rule: only the two cursor-gated tiers may put the block on screen.** A commits record exists only when a checkout's fingerprint moved; a memories record only when the memory source's tip moved. So seeing either means there is genuinely something to report, and seeing neither means every gate held.

   The sessions tier is excluded **on purpose**, and it is the whole reason a "did any progress happen" rule is not enough: that tier re-projects the discoverable set on every pass by design, because a session can be updated out of order, so its batches report real per-item progress on a run where nothing changed. The stored-memory indexing tier is excluded for symmetry — its phase marker now fires only inside its own gate, so it cannot reach the handler ungated anyway.
4. **Partition the results.** Repositories the sweep answered as unavailable are separated from the ones that were **worked**. Every figure below is computed over the worked set only.
5. **Print the unavailable notice** (below), if any — directly, and before the rest.
6. **Return early** when there were no registered repositories, or when nothing was worked. With every entry dead there is nothing more to say, for the same reason zero registered repositories says nothing: announcing work on repositories that were not touched is worse than silence.
7. **Print a failure line per worked repository the sweep threw on**, each naming the repository and the error, worded as the migration having failed. Revealing the migration header first, so a failure is shown in context — which repository, under which heading. Such a repository previously reached the log and nothing else, which on screen made it indistinguishable from one that had nothing to do.
8. **Print the closing line.** Two shapes:
   - Something landed — at least one repository completed a first sweep, or at least one memory's row actually changed. Reveal the migration header (so the progress that produced it belongs on screen, including on runs too fast to have shown any) and print the migrated-memory tally, pluralised, with the across-repositories phrase.
   - Nothing landed. Print that all of that many memories were already migrated. **This branch used to print nothing, which is the defect that motivated the whole block:** a converged re-run looked identical to a run that never happened.

The tally is **memories, not events**. The events count is the activity tier and a steady-state pass still applies plenty of them — sessions and worktree state are re-projected every time by design, as idempotent upserts — so printing that count unconditionally read as a large import on a run that changed nothing. The line is about the thing the user was told was being migrated.

The across-repositories phrase appears only when more than one repository was worked, and its number is the count of repositories that completed a first sweep, falling back to the worked count when none did.

### The unavailable notice

**One line for the whole run, naming the repositories.** A repository with no checkout on disk is dropped by the sweep before it is swept and answered as unavailable, and the only other trace is a debug-level log line the command-line runtime suppresses from the terminal and its default file threshold drops as well — so this line is the sole carrier.

Silence is not the fix, and neither is the sweep's own warnings-per-repository-per-pass that this replaced. "No checkout on disk" is also what a network share or an external drive looks like while it is unmounted, and in that case the user is still expecting those memories to arrive. So the wording says what was observed and what follows from it: **skipped**, with the reason "deleted, or on a drive that is not mounted", and the reassurance that the entries are still registered and resume on their own. Never "failed" — that word belongs to the sweep-threw lines above.

**A sample of distinct names, never the whole list.** The registry is append-only in practice — nothing prunes it, and deregistration has to run from inside the directory it removes, which a deleted directory makes impossible — so dead entries accumulate and the count only grows. An unbounded list buried the closing result under it. The notice therefore prints:

- the total number of unavailable repositories;
- up to **three** distinct names, comma-joined;
- a "plus N more" remainder when there are more distinct names than that.

Distinct because a list reading "repo, repo, repo" identifies nothing; the count carries the scale and the sample carries "which kind of thing is this".

**Printed directly rather than through the deferred writer, and without revealing a header.** Nothing was migrated for these repositories, so putting the migration header on screen because one of them is unmounted would reintroduce — inside the very block that exists to avoid it — exactly the claim the reveal rule prevents.

### The progress printer

Stateful, because two of its rules need history: the quarter marks need to know which ones have been passed, and the small-run suppression needs the denominator, which arrives only with the first record.

**Repository change.** When a record names a different repository than the last one, every counter resets, and the repository is announced with its position and the total — but only when more than one repository is being swept.

**The scan tiers** (everything except the memory migration). This is where the wall clock actually goes, so they are named as they *start*, and the commit sweep — the big one — also carries a count.

- A **phase-start record** (no items done yet) prints the tier's label, qualified in parentheses when the record names which checkout is being scanned. The label plus that qualifier is the de-duplication key, so a repeat with a new qualifier is a new line rather than a duplicate.
- The **slow-run warning** — that scanning the whole history can take a few minutes, and that interrupting is safe because progress is saved and the next run resumes — is emitted once, and only with the *first* commit phase-start record that carries the first-run flag. It belongs to the slow thing, not to the command: a steady-state re-run skips the git scan entirely, so printing the warning up front was wrong on exactly the runs where it was most visible. The first-run flag narrows it further, and has to: a sweep triggered by a moved branch tip re-reads the commit list but skips the per-file statistics for everything already stored, so it is not a minutes-long operation either; only a genuine first sweep can be, and only a first sweep sets the flag.
- **Counts are printed for the commit sweep only**, and only when the record carries a denominator at or above the suppression threshold below. The other scan tiers are short, and a line each would bury the phase names.
- The commit sweep's counter fires on each new **quarter** of the denominator, **including the last one** — unlike the memory counter. The sweep is followed by a silent prune, so suppressing the final line left a visible gap right where the user had been told nothing more was coming.

**The memory migration tier.**

- **No denominator** (the memory index could not be read): fall back to a plain count every **five hundred** memories, so a long run still visibly moves.
- **Resumption is announced once.** A run that started partway through picked up a cursor, so if the first record is already past the first item, say so and seed the quarter counter from it — it explains why the first number is not near zero.
- **Below the suppression threshold, nothing is printed** between the header and the closing line: a handful of progress lines for a handful of memories is noise, not information.
- Otherwise the counter fires on each new quarter, **excluding the last one**, which the closing line already covers.

The suppression threshold, shared by both counters, is **two hundred** items.

### The server-free sibling

A second entry point runs the same registration and the same import — and therefore produces exactly the same reporting — without binding a port or opening a browser. It exists because the sweep is the only production driver of the memory import, so memories just written would otherwise sit outside the database until someone ran the command by hand; but wanting that import is no reason to take over the user's browser, and now also no reason to take over their terminal.

It is **self-gating on the runtime floor**, so its callers cannot forget it: below the floor there is no database to import into, and staying silent beats an error at the end of an otherwise successful setup. It never throws and never touches the process's exit status. It ends with the same routing attempt, but **unthrottled** — a fresh import is the one attempt worth making unconditionally, whereas the full command is a reopen a user can type many times a day.

Both of its callers are setup paths, and the guided front door needs **both** halves of this topic: this entry point where the old blocking call used to be, and the bind/browser half separately at the very end.

## State Transitions

### One launch

| From | Event | To |
| --- | --- | --- |
| Any | Runtime below the floor | Error naming the floor, failure |
| Any | Schema cannot be created | Error, failure |
| Any | Port option invalid | Error naming the value, failure |
| Any | Bind fails on every candidate | Error, failure — no import, no routing attempt, no snapshot, no wait |
| Bound on the preferred port | Launch continues | Browser opened (unless suppressed), URL printed |
| Bound on a later candidate | Launch continues | Fallback line printed first, then as above |
| Serving | Import, routing attempt and snapshot complete | Waiting on the stop signal — the command does not return |
| Waiting | `SIGINT` / `SIGTERM` | Connections and listener closed, final telemetry flush, command returns success |

### The terminal block

| From | Event | To |
| --- | --- | --- |
| Held | No registered repositories | Never revealed; nothing printed at all |
| Held | A commits progress record | Revealed under the git-history header |
| Held | A memories progress record | Revealed under the migration header |
| Held | A sessions or memory-indexing record | **Still held** — those tiers cannot reveal |
| Held | A worked repository threw | Revealed under the migration header, then its failure line |
| Held | Something landed | Revealed under the migration header, then the migrated tally |
| Held | Nothing landed, something was worked | **Never revealed**; only the "already migrated" line prints |
| Revealed | Any later reveal | Ignored — the header cannot be retitled |

## Notable Behavior

- **Every closing figure is computed over the repositories that were actually worked, never over the registry.** A repository the sweep never touched because none of its checkouts exists is excluded from the migrated tally, from the first-sweep count and from the across-repositories denominator. Before that filter, a registry in which *every* repository's checkout had vanished reported that all zero memories were already migrated — a fully confident, fully wrong statement, produced by summing an empty set and printing it as a result. (Notable; the sweep's result record distinguishes "not here" from "failed" precisely so this caller can.)
- **The unavailable notice is the only place the user ever learns a repository stopped being imported.** The sweep's own explanation is debug-level, which this runtime suppresses from the terminal and, at its default file threshold, does not write to the log file either. If this line is not printed, nothing is. (Notable; the caller is load-bearing, and the topic that owns the sweep says so.)
- **"No checkout on disk" is a plainer predicate than the liveness question asked elsewhere, and deliberately so.** It tests whether any recorded path for the repository exists, over the recorded list in its stored order. The sweep's other helper — the one that answers "which checkouts should I walk?" — falls back to the recorded primary path when none exists, and reverses the list besides, so a repository whose every path is gone looks identical through it to one with a single live checkout. Reading availability off that helper's answer is therefore impossible, which is why a second, simpler predicate exists. (Surprising; the obvious reuse is the broken one.)
- **An unavailable repository is dropped before the sweep, answered as unavailable, never deregistered, and appended after the swept results.** Not deregistered because the same evidence covers "temporarily unmounted" — a network share, an external drive, a checkout being recreated — and forgetting a registration on that evidence would throw it away for a directory that comes back. Appended rather than prepended so a caller reading the list in order sees the repositories that were worked first; these carry no per-repository detail to interleave with them. (Notable.)
- **The notice samples, because the registry never shrinks.** Nothing prunes it, and deregistration cannot run from inside a directory that no longer exists, so dead entries accumulate for the life of the machine and are re-tested on every launch. Printing them all buried the result the block exists to deliver. (Notable.)
- **The block's header is chosen after the run has started, and the sessions tier is barred from choosing it.** That tier reports genuine per-item progress on a run where nothing changed, so any rule keyed on "was there progress" would reveal the block on every launch. Only the two cursor-gated tiers can honestly say there was work. (Notable.)
- **A migration header can appear with no migration behind it — for a failure.** A worked repository that threw reveals the migration header purely so its failure line has a heading to sit under. That is the one reveal not backed by a tier having done work. (Surprising; deliberate, and the reason the unavailable notice pointedly does *not* do the same thing.)
- **The "already migrated" closing line prints without ever revealing the header**, so a converged run produces exactly one line of output about the import. It exists because the alternative was printing nothing, which made a converged re-run indistinguishable from a run that never happened. (Notable.)
- **The elapsed-time reveal was implemented and then removed.** A converged pass takes the same order of time as the wait that would justify narrating a slow one, because one tier runs unconditionally, so no threshold separates the two cases. The tier field does it deterministically instead. (Notable; a removed mechanism, not a missing one.)
- **The slow-run warning is gated on the first-sweep flag, not on the tier alone.** A sweep triggered by a moved branch tip re-reads the commit list but skips the per-file statistics for every commit already stored, so warning that it can take minutes is simply false there. (Notable.)
- **This is a command process, not a request path.** Its reads of session titles happen inside the sweep, once per discovered session, and they are unrelated to the request-time re-read of live transcripts that the dashboard's read model removed — that removal narrowed what the *service* does while answering a page, and says nothing about this command. Every write the import performs happens here, in a process the user is already waiting on. (Notable; the two are easy to confuse because they call the same title resolution.)
- **The import half cannot fail the command.** It is wrapped in a catch that prints one warning line, and the two boundary steps that follow it report nothing and cannot throw — so a launch either fails at the runtime floor, the schema, the port option or the bring-up, or it succeeds. (Verified.)
- **The command does not return, and both of its in-process callers had to be restructured for that.** The guided front door used to open the dashboard mid-function, with its closing orientation printed afterwards; a blocking serve there would have swallowed that orientation and hung every invocation, including the routine status-check run. It now takes the import half in place and serves the other half at the very end, gated on this being a first-time setup **and** an interactive terminal. (Notable; both gates are load-bearing, for different reasons — see that topic.)
- **Moving it after the closing orientation is what removed a confirmation prompt, not what needed one.** A `[Y/n]` briefly guarded the blocking serve there, and its only job was stopping it from swallowing the lines printed after it. Once nothing is printed after it, declining the question and pressing Ctrl+C cost the same single keystroke — and only one of them leaves the user with the dashboard that finishing setup was for. The two gates are what protect the cases that actually cannot block; the question protected nothing they do not. (Notable; a removed mechanism, not a missing one.)
- **The editor host stopped calling this command altogether, and that is the load-bearing consequence.** The VS Code toolbar button used to invoke it in-process, injecting a spawner for the detached server. There is no Ctrl+C in an extension host, so an in-process call would never return *and* would put the HTTP listener inside the editor's own process for the session. The button now runs `jolli dashboard` as a child process, reads the bound port off the URL line this command prints — the only place it exists once the state record is gone — and owns the child's lifetime, which is what a terminal was providing for free. Re-importing `executeDashboard` into a GUI host is the regression to watch for; it type-checks and hangs. (Notable.)
- **A second `jolli dashboard` stops the first one rather than sitting beside it.** That is a deliberate reversal of the shape this replaced, where a second launch REUSED the incumbent. The cost lands on whoever was looking at the first dashboard — a second editor window, or a terminal someone left running — and their page goes dead with only the new launch's own line to explain it. What it buys is the one thing the state file used to buy and nothing else does: a dashboard whose parent died has something that stops it, now that the idle timeout is gone. (Notable; the alternative considered was arming an idle timeout only when there is no terminal.)
- **A stranger on the port is never signalled.** Reclaiming acts only on a process that answers the liveness route, so an unrelated local service on 1818 survives untouched and the bind falls through to 18118 exactly as before. Killing by port alone would have made this command a hazard to anything else sharing the machine. (Notable.)

## Shared Behavior

- The port candidates, the fallback flag, the route surface and the security model are owned by the **Local Dashboard HTTP Server** topic (cross-ref 352) — including the removal of its state record, its health route and its idle shutdown, and the version gate that removal took with it.
- The editor button that runs this command as a child process — its remote-window gate, its progress notification, its one-at-a-time guard, how it recovers the URL from this command's output, and how it stops the child on `deactivate` — belongs to the VS Code extension. The contract between the two is small and entirely one-directional: this command prints a loopback URL on a line of its own and keeps serving until it is signalled.
- The sweep's repository selection, cursor gates, tiers, progress records and per-repository result records — including the unavailable mode this command's notice renders, and the memory count answered from the database on a converged pass so the tally never reads as data loss — are owned by the **Dashboard Database Repository Backfill** topic (cross-ref 350).
- The repository registry, the identity derived for each entry, the recorded checkout list, and the deliberate non-empty fallback that forces the separate availability predicate are owned by the **Dashboard Repo Registry and Probe** topic (cross-ref 355).
- The routing conversion attempted after the import, throttled here and unthrottled from the server-free entry point, is owned by the cutover topics (cross-refs 344, 345).
- The snapshot pass that ends a launch — one of the two call sites that constitute the whole backup schedule, placed here rather than in the long-lived service because a snapshot needs a writable handle and therefore runs schema migrations — is owned by the **Memory Database Snapshot and Restore** topic (cross-ref 349).
- The session-title resolution the sweep performs per discovered session is owned by the **Session Title Resolution Chain** topic (cross-ref 182).
