# 113. Cross-Project Attribution of a Newly-Appeared Plan File

## Topic Statement

The transcript-affinity predicate that decides whether a plan markdown file appearing in the machine-global agent plan directory belongs to *this* project, so that a plan an agent wrote for one project is not registered into every other project open on the machine — together with the two host routes that feed it and the guards each route runs before it.

## Scope

**In scope:**

- Why the question exists: the agent's plan directory is one machine-global directory, and every open project observes every write to it.
- The affinity predicate itself: its inputs, its escaping rule, its short-circuit, and its failure tolerance.
- The two host routes that reach it — one host calling it in process, the other reaching the whole decide-and-register chain through a single command-line operation — and the one behavioural asymmetry between them.
- The filters that run **before** the predicate on the command-line route, in order, and why their order is load-bearing.
- The two-part disable gate on registration, and the specific reader it must use.
- What registration writes, and what it deliberately refuses to overwrite.
- Serialization of a burst on both routes.
- The change-notification payload that carries filenames rather than identifiers, and why.

**Out of scope (boundaries):**

- The full command-line-owned working-area service and its whole operation set (spec 337). This spec covers the attribution decision and the registration it gates.
- Discovery of plans by scanning an agent transcript at the end of a turn (spec 29) — the other, independent writer of the same rows.
- The visibility gates that decide whether a registered plan is listed, and the archive guard (spec 114).
- The change-notification channel's own framing, debouncing and escalation rules.
- The session registry whose entries name the transcripts this predicate reads.
- Note attribution — notes are never discovered from the agent plan directory.

## Data Contracts

### Why attribution is needed at all

The agent writes its plan-mode markdown into **one directory under the user's home**, shared by every project on the machine. Any mechanism that watches that directory therefore observes plans belonging to every project, including ones whose repositories the observer has never seen. Without a per-project decision, one agent's plan would land in every open project's working-area registry at once.

### The affinity predicate

| Input | Source |
| --- | --- |
| The plan file's absolute path | The name the operating system reported, joined onto the agent plan directory. |
| This project's known agent sessions | This project's own session registry. |

The plan is attributed to this project **if and only if** its absolute path appears as a substring of at least one of this project's session transcripts, in the form the agent writes such paths into its transcripts.

Escaping rule: the needle is the absolute path with every backslash doubled. Forward-slash paths are therefore searched verbatim; Windows paths are searched in the doubled form the agent's JSON-escaped transcript records. No other normalization is applied — no drive-letter casing fold, no universal-naming-convention handling.

Failure and edge behaviour:

| Case | Outcome |
| --- | --- |
| The project has no known sessions | Not attributed. The predicate returns before reading anything. |
| A transcript is missing or unreadable | That transcript is skipped; the scan continues. |
| Any transcript matches | Attributed; the scan short-circuits. |
| No transcript matches | Not attributed. |

The search is plain text over the raw transcript bytes — the transcript's own line structure is never parsed, and a match anywhere in the file counts, including inside an unrelated value. This is deliberate: the agent's own transcript writer is the only thing that emits these absolute paths, and a false positive would need user-typed prose containing the absolute plan path verbatim.

### The registration a positive answer gates

Registration inserts a **fresh unclaimed row** keyed by the plan's slug — the file's name with its markdown extension removed — carrying the title extracted from the file's first heading (falling back to the file name), the absolute source path, added-at and updated-at set to now, and a null commit hash.

It inserts **only if the slug is not already present**. An existing row is left exactly as it is, so a claimed row keeps its commit hash and its archive guard rather than being reset to unclaimed.

### The disable gate on registration

Registration returns immediately, before touching anything, if **either** of two conditions holds:

1. The in-process disabled mirror is set.
2. The durable on-disk disable state for this project says disabled.

**Both halves are required.** The in-process mirror is inert inside a long-lived server process, which never goes through the activation that sets it; the durable state is the only signal that survives a process boundary.

The durable check must use the **read-only** probe of that state. The other reader of the same state migrates a profile written before the disable flags were split apart and *persists* the migrated value — performing exactly the write into a disabled project that this gate exists to prevent.

### The notification payload

The change-notification channel carries, for this one event kind, the raw **directory entry names** the operating system reported. Names, not slugs: deriving a slug, skipping non-markdown entries and deciding project affinity are rules, and a host-side restatement of them is the drift the command-line service exists to remove. The host contributes only the one thing it has and the service does not — what the operating system said changed.

The watcher on that directory is gated to markdown entry names. An event the platform reports **with no filename** is dropped rather than forwarded blind, because the gate cannot be honoured for it. The directory is never auto-created: it is not the product's, and it appears the first time the agent writes a plan.

## Behavior

### Route one — the host that calls the predicate in process

A watcher is subscribed to markdown files in the agent plan directory.

1. On a **create** event: schedule the panel's debounced refresh, and enqueue a registration task.
2. The task is chained onto a per-window queue, so a burst from one agent turn cannot interleave read-modify-write cycles over the registry.
3. When the task runs, it drops the name unless it ends in the markdown extension, derives the slug, asks the affinity predicate, and — only on a positive answer — calls registration.
4. A failure is logged and swallowed; the queue continues.

On a **change** or **delete** event: only the debounced refresh runs. No attribution, no registration.

The watcher receives no events for files already present when it started, so historical plans never reach this route.

### Route two — the host that reaches the chain over the command line

The host forwards the burst of raw entry names it was notified about. The service runs the same three steps in the same order, and the host contributes no rule of its own.

1. **Short-circuit on an empty burst**, before any input/output at all.
2. Read the registry once, purely as a fast path: collect the set of slugs this project already tracks.
3. For each name in the burst, in order:
   - Drop it unless it is a bare directory entry name — no path component — ending in the markdown extension, and unless the remaining stem is non-empty. Anything else is a caller bug or an attempt to escape the directory.
   - **Drop it if the stem is already tracked.** This check sits deliberately *before* the affinity scan: the scan reads every active transcript in full, transcripts routinely run to tens of megabytes, and the underlying event source cannot distinguish a create from a content edit — so a user iterating on one plan would otherwise re-scan every transcript on every save, in every open project, because the directory is machine-global. Registration would no-op on a tracked slug anyway, so attribution has nothing left to decide.
   - Drop it if the file does not exist. A delete arrives indistinguishably from a create.
   - Drop it if the affinity predicate says the plan belongs to another project.
   - Register it, then add the stem to the in-burst tracked set so a duplicated event name costs no second lock acquisition.
4. Return the list of names that passed every filter and were handed to registration.

The return value is **accepted, not registered**: registration re-reads under the lock and may find the slug already present, so claiming a write happened would be a guess. The caller re-reads the registry either way.

Registration is serial across the burst rather than concurrent, because each call is a load-modify-save under one lock and concurrent calls would queue on it anyway.

The host refreshes its working-area panels whether or not anything was accepted — a name it correctly ignored does not rule out a concurrent write landing in the same window from the end-of-turn transcript scan.

### The asymmetry between the two routes

One host wires this to **create events only**; the other is fed by a watcher that **cannot tell a create from a content edit**, so an edit to an existing plan file reaches its registration path and does not reach the first host's.

This is invisible for a tracked slug (the fast path drops it) and for a foreign one (attribution says no). It is visible in exactly one case: **a plan the user explicitly removed.** Removal leaves no tombstone, so the slug is untracked again — and the agent's next write to that file passes the tracked check, passes the existence check, passes attribution, and re-registers the plan. The user's removal is undone by an edit they may not have made themselves.

The other host reaches the same end state through the end-of-turn transcript scan, which also re-registers the file; the difference is only *when*. The revival is a consequence of the working-area contract's deliberate absence of tombstones, not of this route.

## State Transitions

| Registry state for a slug | Trigger | New state |
| --- | --- | --- |
| Absent | Event + file exists + attributed | Fresh unclaimed row |
| Absent | Event + not attributed | Absent |
| Absent | Event + file already gone | Absent |
| Absent | Event while the project is disabled (either half of the gate) | Absent |
| Present, any state | Event + attributed | **Unchanged** — registration refuses to overwrite |
| Present, any state | Event + not attributed | Unchanged |
| Present, any state | Change or delete event on the first route | Unchanged; the panel re-reads |
| Removed by the user, then edited | Event on the second route | Fresh unclaimed row — the plan is revived |

## Notable Behavior

- **The agent's plan directory is machine-global, and every open project sees every write to it.** Without attribution, a plan written for one project would be registered into every project open on the machine. (Surprising; reality.)
- **The attribution decision is a rule, so it lives in the command-line service and not in either host.** One host imports it in process; the other reaches the entire decide-and-register chain through a single operation and supplies only the filenames the operating system reported. A host-side restatement of "which plans are mine" is exactly the drift the service exists to prevent. (Notable.)
- **A create and an edit are indistinguishable on the second route, and that revives a removed plan.** The underlying watcher fires on content edits too. Because removal leaves no tombstone, the slug is untracked, and an edit therefore re-registers a plan the user deliberately removed. Verified against the live path: the tracked-slug fast path misses, the file exists, attribution succeeds, and a fresh unclaimed row is written. (Surprising; reality.)
- **The already-tracked check must stay ahead of the affinity scan.** The scan reads every active transcript in full, and the event source fires on every save. Reordering these two would make each keystroke-driven save re-read tens of megabytes per open project. (Notable.)
- **The fast path has a known, deliberately unclosed limit.** It only covers slugs *this* project has registered, so every edit to a plan owned by another project does reach the full scan. It is bounded rather than unbounded: the session list prunes stale entries, so a project with no live session returns nothing and the predicate exits before reading anything. (Notable.)
- **The disable gate is two checks, and the durable one must be the read-only probe.** The in-process mirror is inert inside a long-lived server process, so it alone cannot protect a disabled project. The other reader of the durable state migrates a legacy profile and *persists* the result — using it inside a gate whose whole purpose is "write nothing here" would perform the write it exists to prevent. (Notable.)
- **The wire carries filenames, never slugs.** Deriving a slug, skipping non-markdown, and deciding affinity are all rules; the host contributes only what it alone has. (Notable.)
- **A nameless watch event is dropped, not forwarded.** Some platforms omit the filename; the directory gate cannot be honoured without it, so the channel stays silent rather than firing blind. (Notable.)
- **A path that is not a bare entry name is refused, not joined.** Anything carrying a path component is treated as a caller bug or an escape attempt. (Notable.)
- **The substring search never parses the transcript.** A match anywhere in the file counts, including inside an unrelated value. The absolute path is the needle precisely because only the agent's own writer emits it. (Notable.)
- **Backslash doubling is the only platform accommodation.** No drive-letter casing fold, no universal-naming-convention handling — byte equality after doubling is the whole rule. (Notable.)
- **A relative mention never attributes.** The needle is the absolute path, so a transcript that names the plan only relatively — for instance inside user prose — does not count. (Notable.)
- **An unreadable transcript is not an error.** A rotated, deleted or permission-restricted transcript is skipped and the scan continues. (Notable.)
- **A project with no recorded sessions attributes nothing**, including its own future agent runs, until something records the first session. (Notable.)
- **Registration never overwrites.** An already-present slug is left untouched, so a claimed row keeps its commit hash and archive guard rather than being reset to unclaimed. (Notable.)
- **The answer is "accepted", not "registered".** Registration re-reads under the lock and may find the slug already there, so the operation reports what it handed on rather than what it wrote. (Notable.)
- **There is no user override.** No setting says "claim every plan" or "claim none"; the affinity rule is the only rule and it is always on. (Notable.)

## Shared Behavior

- The registry this writes into, its atomic-write primitive, and the lock that serializes read-modify-write cycles over it are shared with the end-of-turn transcript scan, the commit-time pipeline and both IDE hosts.
- The session registry naming this project's transcripts is the same list the rest of the product consumes for development-context recall and session-status reporting.
- The first-heading-else-filename title extraction is the same rule used everywhere a markdown file needs a display title.
- The slug is the file name minus its markdown extension, the same slug used for the archived key in summary storage.
- The end-of-turn transcript scan (spec 29) registers the same rows by a different mechanism and is the fallback whenever this path declines or fails; it is no longer the only mid-session writer, precisely because this registration operation exists.
- The change-notification channel that delivers the burst, and the debounce and escalation rules its clients apply, are owned elsewhere.
- The two-part disable gate and the read-only-probe requirement are stated identically in spec 337, which owns the operation.
