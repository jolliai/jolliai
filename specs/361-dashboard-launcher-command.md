# 361. Dashboard Launcher Command

## Topic Statement

The command a user runs to open the local dashboard, from end to end: the refusals that stop it before it touches anything (the runtime floor, an unusable port option), the schema it pre-creates so a read-only service has something to open, the directory it resolves for that service, the lock-guarded decision to reuse, replace or spawn it, the browser it opens, the separate stop path, and — running last, unable to fail the launch — the history import, whose terminal block stays hidden until a cursor-gated tier proves there was work, whose closing figures are computed only over the repositories actually swept, and whose repositories with no checkout left on disk are reported by a sampled notice of their own.

## Scope

**In scope:**

- The wake sequence and why the write side is last.
- The spawn lock, the reuse-or-replace decision behind bringing the service up, and the stop path.
- The deferred writer: what it holds, when it flushes, and why the header is chosen at reveal time rather than written up front.
- The reveal rule — which progress tiers may put the block on screen, and which is deliberately excluded.
- The progress printer's line rules: the phase labels, the slow-run warning and its narrowing, the resume announcement, the per-tier suppression thresholds, and the quarter-mark counters.
- The closing report: the per-repository failure lines, the migrated-memory tally, the bootstrapped count, and the across-how-many-repositories phrase — all computed over the swept set.
- The unavailable notice: its predicate, its sampling, its wording, and the fact that it bypasses the deferred writer entirely.
- The server-free sibling entry point that runs the same import without touching a port or a browser.
- The never-throws contract on the import half.

**Boundaries (consumed here, owned elsewhere):**

- The read-only service this launcher spawns, probes and opens a browser at — its port selection, its routes, its state record and its health route are defined by the **Local Dashboard HTTP Server** topic (cross-ref 352). Only the contract between the two (the state record, the health probe, the port environment variable) appears here.
- The sweep itself — which repositories it walks, its four cursor keys, its tiers, its per-repository result record and its progress records — is defined by the **Dashboard Database Repository Backfill** topic (cross-ref 350). This spec defines what the caller *says* about those results, which that topic explicitly leaves to the caller.
- The registry of enabled repositories and the identity derived for each are defined by the **Dashboard Repo Registry and Probe** topic (cross-ref 355). This command registers the current directory and never prunes an entry.
- The routing attempt that follows the import (cross-refs 344, 345) and the snapshot pass that ends the launch (cross-ref 349). Both report nothing and neither can throw, so neither can affect this command's output or its exit status.
- The runtime floor that decides whether the database can be opened at all.

## Data Contracts

### Options

| Option | Meaning |
| --- | --- |
| Port | An explicit port. Parsed as a base-10 integer; a non-finite value, a value at or below zero, or one above the maximum port number is refused with an error naming the value, and the command fails |
| No-open | Print the URL instead of opening a browser. The URL is printed either way |
| Stop | Take the stop path and return success without touching the database or the import |
| Directory | The repository directory to register. Defaults to the process's own directory |

### The spawn lock

A single lock file beside the service's state record, in the machine-global configuration directory. It is claimed by an **exclusive create** — never by a blind overwrite — and reclaiming a lock whose recorded owner is dead goes through that same exclusive create, followed by a read-back to confirm the file on disk is this process's.

The overwrite is what made reclaim unsafe: two launchers that both read the same dead owner would both write themselves in and both believe they had the lock, which is exactly the double spawn the lock exists to prevent. With an exclusive create the loser's attempt fails, it falls into the wait-for-the-other-launcher branch, and one service comes up.

An unreadable lock, or one holding a non-numeric owner, counts as stale for the same reason: a launcher killed mid-write must not wedge the dashboard permanently.

**One race is deliberately accepted.** Remove-then-create is two operations, so a second reclaimer whose removal lands after the first has already created *and* read back its own lock still takes it. Closing that needs an atomic compare-and-swap the filesystem does not offer. The consequence is bounded on the other side — the bring-up probes the health route and reuses a live service before spawning at all, and the state record is only ever cleared by the owner it names — so the worst case is one short-lived extra process, not a permanently orphaned service.

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

### Stop

Taken before anything else, and it never opens the database.

1. Read the service's state record. Absent — print that the service is not running and return success.
2. Confirm the record still describes the dashboard: ask the recorded port's health route and require both a healthy answer **and** a reported owner matching the record's. A record can outlive its process (a hard kill, a crash, a reboot) and owner numbers are recycled, so a recorded owner is a claim, not a fact. A health route that answers without an owner also fails the check — this product's own route always reports one, so an ownerless healthy answer is some other service on that port and must not be signalled.
3. Signal it only when that confirmation passed; clear the record either way, conditionally on the owner that was read.
4. Print either that the service was stopped, naming the owner, or that it had already exited and its stale record was cleared.

### The wake sequence

1. **Refuse below the runtime floor**, naming the required runtime and the one in use. The command fails.
2. **Create or upgrade the database schema before anything reads.** The service opens read-only handles, and read-only is the one mode that must not create a schema; nothing else on this path is guaranteed to create the file either, since registration is skipped outside a repository and an import with no registered repositories returns without opening a writable handle. A first run in a non-repository directory otherwise served a plain-text failure on every page, with no scripts on it to ever recover. A failure here is reported and the command fails.
3. **Register the current directory** as a repository when it is one. Outside a repository the dashboard still opens with whatever is already registered; the failure is recorded at information level only.
4. **Validate the port option.**
5. **Resolve the directory the service will run in** — the repository root, and always a real directory. Always real because an invalid directory would make the detached spawn fail asynchronously; the root rather than a subdirectory because the service's telemetry buffer's identity *is* its literal directory, and a subdirectory's buffer is one no other surface drains. A directory outside a repository, or any failure resolving the root, keeps the validated directory as-is.
6. **Bring the service up** (below). A failure here is reported and the command fails.
7. **Open the browser** at the page URL, unless the no-open option was given. A browser failure is a warning, never a failure of the command.
8. **Print the URL**, plus the two reopen/stop hints.
9. **Run the history import** (below) — the write side, last.
10. Attempt the routing conversion, **throttled**, and then the snapshot pass. Both are boundaries; neither prints anything here and neither can throw.

The order exists so the page appears fast: the page renders whatever the database already holds and polls for its model, so history fills in as the import lands rather than blocking the launch.

The browser is opened through a general-purpose opener rather than the product's own URL-opening helper, because that helper enforces an HTTPS-only allowlist which correctly rejects a loopback address, and loosening it for the loopback case would weaken every other caller.

### Bringing the service up

1. Read the state record. If it names a live service (confirmed as in the stop path) and either no port was requested or the requested port matches, **reuse it** and return.
2. If it names a live service on a *different* port than the one requested, **replace** it: signal it, then clear the record conditionally on the owner just read. Both services would otherwise compete for the single state record, so only one of them would ever be findable by a later launcher — and the loser keeps running, invisible, until its idle timeout.
3. If the record was merely stale, clear it the same conditional way.
4. **Claim the spawn lock.** Failing to claim it means another launcher is mid-spawn, so wait for *its* service rather than racing it: poll for a state record whose health route answers, at a quarter-second interval, up to a **ten-second** budget, then fail with a message saying another process started the dashboard but it never became healthy.
5. Holding the lock, spawn the service detached and hidden in the resolved directory, then poll for the record and its health on the same interval and budget. Timing out fails with a message pointing at the debug log. The lock is released either way.

The spawn's own asynchronous failure — a directory that vanished between the resolve and the spawn — is swallowed with a warning rather than left to kill the launcher: a failed spawn means no dashboard, and the health polling already reports that.

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

A second entry point runs the same registration and the same import — and therefore produces exactly the same reporting — without binding a port, spawning anything, or opening a browser. It exists because the sweep is the only production driver of the memory import, so memories just written would otherwise sit outside the database until someone ran the launcher by hand; but wanting that import is no reason to take over the user's browser.

It is **self-gating on the runtime floor**, so its callers cannot forget it: below the floor there is no database to import into, and staying silent beats an error at the end of an otherwise successful setup. It never throws and never touches the process's exit status. It ends with the same routing attempt as the launcher, but **unthrottled** — a fresh import is the one attempt worth making unconditionally, whereas the launcher is a reopen command a user can type many times a day.

## State Transitions

### One launch

| From | Event | To |
| --- | --- | --- |
| Any | Stop option given | Stop path, success, no database touched |
| Any | Runtime below the floor | Error naming the floor, failure |
| Any | Schema cannot be created | Error, failure |
| Any | Port option invalid | Error naming the value, failure |
| Live service, port matches or unrequested | Bring-up | Reused |
| Live service, different port requested | Bring-up | Signalled, record cleared, fresh spawn |
| Stale record | Bring-up | Record cleared, fresh spawn |
| Spawn lock unavailable | Bring-up | Wait for the other launcher's service, or fail after the budget |
| Service healthy | Launch continues | Browser opened (unless suppressed), URL printed, then the import |

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
- **The spawn lock's reclaim race is accepted rather than closed**, because the filesystem offers no atomic compare-and-swap and the consequences are bounded by the health probe and the owner-conditional record clearing: one short-lived extra process at worst. (Notable.)

## Shared Behavior

- The state record, the health route, the port environment variable and the reuse contract are owned by the **Local Dashboard HTTP Server** topic (cross-ref 352), including the rule that the record is only ever cleared conditionally on the owner it names.
- The sweep's repository selection, cursor gates, tiers, progress records and per-repository result records — including the unavailable mode this command's notice renders, and the memory count answered from the database on a converged pass so the tally never reads as data loss — are owned by the **Dashboard Database Repository Backfill** topic (cross-ref 350).
- The repository registry, the identity derived for each entry, the recorded checkout list, and the deliberate non-empty fallback that forces the separate availability predicate are owned by the **Dashboard Repo Registry and Probe** topic (cross-ref 355).
- The routing conversion attempted after the import, throttled here and unthrottled from the server-free entry point, is owned by the cutover topics (cross-refs 344, 345).
- The snapshot pass that ends a launch — one of the two call sites that constitute the whole backup schedule, placed here rather than in the long-lived service because a snapshot needs a writable handle and therefore runs schema migrations — is owned by the **Memory Database Snapshot and Restore** topic (cross-ref 349).
- The session-title resolution the sweep performs per discovered session is owned by the **Session Title Resolution Chain** topic (cross-ref 182).
