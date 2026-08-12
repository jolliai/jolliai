# Repo-Wide Manual Disable Flag

## Topic Statement

A machine-local, repo-wide profile file records the user's explicit "memory capture is off for this repository" decision in an **authored** boolean field, and carries alongside it a **derived composite** that folds the authored decision together with a separate structural marker so that older, already-shipped runtimes — which only understand the composite — keep stopping. The authored field is written and read by a canonical module that the CLI commands, the editor extension and (over the host bridge) the JVM IDE plugin all call into, so the opt-out is a single source of truth across every worktree of the repository and across every surface. It is not only an install-time signal: every source-control hook, both agent hooks that carry the gate, both background workers, and the long-lived host-bridge server's write actions read it at the top of their own hot path and return early, so an opted-out repository captures nothing even while its hooks remain installed and wired on disk.

## Scope

**In scope:**
- The profile file's location and repo-wide anchoring (shared across worktrees).
- The three fields the disable decision spans — the authored opt-out, the structural marker, and the derived composite — the rule that recomputes the composite, and the read precedence every consumer applies.
- The authored field's semantics, and its priority relative to every other install/repair path.
- Which commands and activation paths write, clear, or read the field, and the ordering/error-handling guarantees around each — including the JVM IDE host's bridge-first read and write with its direct-from-disk fallback.
- The **runtime capture gate**: which hook and worker entry points read the field on every invocation, where in each entry point's own sequence that read sits, and what each one therefore never does on the disabled path.
- The **process-local in-memory mirror** of the durable field: what it exists for, which process sets it and at which three moments, and the scope limit that makes it inert in every other process.
- The **two readers** of the durable field — an asynchronous one that may persist a verdict, and a synchronous read-only one that never does — and why some consumers must use the read-only one.
- The per-invocation cost the runtime read adds, and the two documented performance budgets it lands inside.
- The one-time migration from the legacy per-worktree marker file that predates this field, including what the first read persists and what it does not delete.
- The effects and non-effects on doctor, the agent-plugin session bootstrap, the settings surface's hook sync, the startup skill reconciliation, the rebuild-the-knowledge-base action, and the version-upgrade / new-worktree auto-repair paths.

**Out of scope:**
- **What the structural marker MEANS** — why a repository acquires one, what it freezes, what routes differently once it is present, and who is allowed to remove it. All of that is defined by **Orphan Branch Cutover Fence and Compare-and-Swap** (345). This spec records only how its presence participates in the composite and therefore in the disable decision, and stops there.
- The general shape, atomic-write mechanics, and locking of the repo-wide profile file for OTHER fields it holds (the back-fill dismiss field, and the marker's own attempt-throttle timestamp).
- The auto-enable substep's other preconditions and its state updates on success (owned by the auto-enable spec).
- The machine-global user profile file of the same filename at a different location (owned by the user-profile spec) — the two are unrelated files that happen to share a filename.
- The internal steps of the bridge-level enable and disable paths (owned by the hook-installation and enable-command specs).
- The sidebar disabled panel and onboarding panel rendering.
- The full inventory of in-process writes the mirror-based gate suppresses, and the mechanism by which each suppression point is placed — owned by `specs/304-manually-disabled-zero-write-contract.md`. This spec records only the per-surface consequences.
- The catch-up drain the enable path runs to recover work missed during the disabled window — owned by `specs/305-re-enable-transcript-discovery-catch-up.md`.
- Security controls; the flag is a UX preference only.

## Data Contracts

### Location and anchoring

The flag lives in a JSON profile file resolved once per read/write:
- Find the repository's shared common git directory.
- The file lives at `<parent-of-common-dir>/.jolli/jollimemory/profile.json` — anchored to the MAIN worktree root, not the current worktree. Every linked worktree resolves to the same path, because every worktree's common-dir points at the same shared location.
- If the current directory is not inside a git repository, the file falls back to a directory relative to the current directory (inert in practice — the disable/enable commands and activation only operate inside git repos).
- Inside a git submodule, resolution lands inside the parent superproject's git metadata directory, shared by every submodule checkout of that superproject — a known, low-severity edge case: disabling in one submodule silently disables every sibling submodule of the same superproject.

### Fields — the decision is three fields, not one

| Field | Type | Role |
|---|---|---|
| **authored opt-out** | boolean (optional) | **The user's own decision.** `true` = the user explicitly turned capture off for this repository. `false` = explicitly turned back on. Absent = no decision recorded yet (subject to the migrations below). The disable command sets it, the enable command clears it, and nothing else authors it. |
| **structural marker** | record (optional) | A separate, non-user-initiated marker whose *meaning* is out of scope here. Only two things about it belong to this topic: its **presence** feeds the composite, and the enable path must never clear it. |
| **derived composite** | boolean (optional) | Equals *authored opt-out is `true`* **OR** *structural marker is present*. It exists **solely for already-shipped older runtimes**, which know this one field name and stop when it is `true`. |

Three rules bind them, and each is load-bearing:

1. **The composite is recomputed, never authored.** Every write of either source recomputes it in the same locked write. No path hand-writes it, and no path writes one source without recomputing it.
2. **New-code decisions read the authored field, never the composite.** Reading the composite for a decision would make a repository that carries only the structural marker — a state the user never asked for — read back as "the user turned this off": the current runtime would stop capturing, the JVM host would paint its disabled card, and automatic repair would stand down, for a repository nobody disabled. The composite is consulted by current code in exactly one place: as the **pre-split migration fallback** described under Reading.
3. **Clearing is asymmetric.** The enable path clears the authored field and leaves the structural marker alone. So a repository that carries the marker keeps a `true` composite (and therefore keeps stopping older runtimes) even after the user re-enables — while the current runtime, reading the authored field, resumes.

One further ordering rule protects the migration fallback: whenever the structural marker is written, the authored field is first resolved to a real boolean and materialized **in the same locked write** as the marker. Without that, a profile that had never recorded an authored decision would end up with a `true` composite produced by the marker alone, and a later read — finding no authored field and falling back to the composite — would fold the marker's `true` onto the authored field and permanently record a user opt-out the user never made.

The file is shared with an unrelated back-fill-dismiss field written and read independently; all writers use the same locked read-modify-write path so one field's write can never clobber another's.

### Second representation: the process-local in-memory mirror

The same decision also exists as a plain in-memory boolean, held per operating-system process. It is a **mirror**, never a source of truth: the durable field on disk is what any process ultimately re-derives it from.

It exists because the durable reader is asynchronous and pays, on every call, a source-control query to locate the shared repository root plus a file read and parse. That is unaffordable on the synchronous hot paths that need the answer — most notably the per-log-line write path, which runs inside sub-5-millisecond hooks and cannot `await` anything. A mirror check is one boolean read.

**Who sets it, and when.** The editor host is the *only* surface that sets it, at exactly three moments:

1. **Once at activation**, seeded from a synchronous read of the durable field, placed before the logger is pointed at the project (see spec 100 for the ordering consequence).
2. **Cleared to false at the start of a successful enable** — before the durable clear and before the initialization catch-up.
3. **Set to true immediately after a disable's durable write has landed** — and before the uninstall runs.

**Scope limit (load-bearing).** Because nothing else ever sets it, the mirror stays `false` in every other process: command-line invocations, source-control and agent hook scripts, the background operation worker, and the long-lived bridge daemon all start with it unset and never seed it. Every gate that reads the mirror is therefore **inert** in those processes.

For the capture path this is by design and fully covered: the nine hook and worker entry points below each carry their own gate on the durable, disk-backed field, and that is the read that governs them. Coverage is *not* uniform outside that set — the mirror-only gates get no equivalent durable backstop in a spawned process, so a code path whose only gate is a mirror read is unprotected there. (The migration engine is the documented case; see spec 215.) The consequence to hold onto is that "the mirror is set" is a statement about *one editor session*, never about the repository.

### Priority

The flag has three roles, and it is the HIGHEST-priority signal in all three:

- **Install-time** — it decides whether hooks should be installed, refreshed, or auto-repaired at all.
- **Runtime (durable read)** — it decides whether an already-installed hook or worker does any work when it fires. A repository can therefore be fully wired (source-control hooks on disk, agent hooks registered, integrations present) and still capture nothing.
- **In-process write gate (mirror read)** — inside the editor session that set the mirror, it decides whether a broad set of ordinary write paths do anything at all, independently of whether any hook is involved. The inventory of those paths is owned by spec 304.

Once the authored field is `true`, nothing except an explicit re-enable clears it — not a version upgrade, not a window/IDE reload, not the doctor auto-repair, not the agent-plugin's per-session bootstrap. Because the runtime gate is placed ahead of every other opt-out, configuration read, and input-validity check in the entry points that carry it, a `true` flag also *masks* those checks: nothing downstream of the gate is ever consulted, so no other setting can override, soften, or re-enable the opt-out.

The third role has deliberate carve-outs — things a disabled repository still does:

- **Explicit-gesture funnel telemetry still writes the repository-local event buffer.** Suppression of telemetry lives at individual call sites, not inside the recording primitive, and the user-gesture call sites carry no suppression. See spec 203.
- **Machine-global configuration writes still happen**, and so do the machine-global agent-instruction block writes a settings save triggers. The gate protects the repository's own state, not the user's machine-wide preferences.
- **Separate command-line processes are unaffected**, per the scope limit above.

## Behavior

### Writing true (explicit disable)

Both the CLI disable command and the editor Disable command write the authored opt-out as `true` (recomputing the composite in the same write) BEFORE running the asynchronous uninstall (hook removal), so the user's intent survives even if uninstall throws partway. If the write itself fails, the command ABORTS WITHOUT UNINSTALLING: no hooks removed, an error surfaced (CLI: stderr + non-zero exit; VS Code: an error notification), the repo left in its previous coherent state. This deliberate asymmetry avoids a deceptive "hooks removed but flag unset" half-state that a later upgrade or activation could silently re-enable.

Two distinct conditions produce that write failure: an unwritable state directory, and a **failure to acquire the shared profile lock within its wait budget**. The write path is strict about the lock — on a timeout it rejects with a lock-timeout error rather than proceeding unlocked — so lock contention is a first-class disable-failure mode, surfaced to the user as an uninstall failure naming the lock timeout, with the repository still fully enabled.

**Ordering in the editor host:** the durable write comes first, then the in-process mirror is set, then the uninstall runs. The mirror sits between the two so that nothing the uninstall itself does — and nothing in the panel-refresh chain that follows it — reaches disk on behalf of a repository the user has just turned off.

### Clearing to false (explicit enable)

The CLI enable command (default full mode, not integrations-only), the CLI guided front-door's enable path, and the editor Enable command all clear the flag by writing the authored opt-out as `false` AFTER install succeeds — leaving the structural marker untouched, so a marked repository's composite stays `true` for older runtimes even as this one resumes. A failed clear here is NON-FATAL: hooks are already installed, so the command prints/logs a warning telling the user to run enable again to clear the opt-out, rather than failing the whole command. This is safe because nothing auto-retries the clear — the agent-plugin's per-session bootstrap only READS the flag, never writes it, so a stuck `true` keeps blocking reinstalls until an explicit enable succeeds.

**Ordering in the editor host is the mirror image of disable:** the install runs first; then, on success, the in-process mirror is RELEASED *before* the durable clear is attempted; only then does the initialization catch-up run. Both orderings are load-bearing:

- Releasing the mirror before the durable clear means a failed clear still yields a fully functional session — the user's current window works, and only later windows would re-read the stuck opt-out.
- Releasing the mirror before the catch-up means the catch-up's own writes actually land. Were the release to come after, every gate inside the catch-up would short-circuit and the whole recovery pass would silently do nothing while reporting success.

Integrations-only enable/disable (the IntelliJ MCP-only setup/teardown path) does not touch the flag at all.

### Reading — precedence

Every reader applies the same three-step precedence, and the order is the whole point:

1. **Authored opt-out present** — that value is the answer, outright. Nothing else is consulted.
2. **Authored opt-out absent, composite present** — the composite is the answer, and *only* as a **pre-split migration fallback**. A profile that carries a composite but no authored field can only have been written before the split existed, and at that time the only thing that could have set it was the user — so folding it onto the authored axis is correct. This is the one sanctioned read of the composite in current code; it *is* the migration.
3. **Neither present** — fall through to the legacy per-worktree marker described below.

Because step 1 short-circuits, a repository whose authored field has been materialized can never have the structural marker leak into its disable verdict, no matter what the composite says.

### Reading — general contract

Every consumer, install-time or runtime, treats any error (missing file, invalid JSON, non-object value, unresolvable repository root) as if the fields were absent, then falls through to the legacy-migration check below. The read is total: it never throws, so no consumer needs to guard it. A read that cannot reach a verdict at all degrades to "not disabled", which is the direction that keeps capture working rather than silently killing it.

Two readers of the durable state exist, and they deliberately differ in their side effects:

| | Asynchronous reader | Synchronous read-only reader |
|---|---|---|
| Repository anchoring | Asynchronous source-control query for the shared root, on every call | Synchronous source-control query for the shared root — still anchored to the main worktree, so a linked worktree of a disabled repository does not read itself as enabled. **The resolved root is memoized per input directory** (see below) |
| Precedence | The three steps above | The three steps above |
| Legacy marker (step 3) | Checked in **every** worktree | Checked in the **current worktree only** |
| Still no verdict | Not disabled | Not disabled |
| Persists a verdict | Yes — see the migration section; a migrated composite is written onto the authored field, and a confirmed absence is written as `false` | **Never.** It neither migrates nor writes anything |

The read-only reader's refusal to persist is the whole reason it exists: it is chosen precisely by callers that are themselves gating a write and must not perform one in the act of deciding not to. The asynchronous reader's persisted verdict would be exactly such a write.

**The memo, and why it does not stale the answer.** The read-only reader is no longer a once-per-process seed: it now runs on a repeatedly-fired path (see the second caller below), where an unmemoized source-control query per call would put a subprocess spawn on an event loop many times a second. Only the *repository-root resolution* is memoized, keyed by the input directory; the "not a repository" answer is memoized too, being equally stable and the case that pays the full subprocess cost. The profile read that carries the actual verdict is **not** cached, so every enable and every disable is still observed on the very next call.

**Both of the read-only reader's call sites must stay on the read-only variant, and this is a correctness constraint rather than a performance one.**

- The editor host's activation seed: the asynchronous reader cannot be awaited that early, and a stray early log line must not touch disk in a disabled repository.
- The onboarding-funnel gate: it is the disk-backed truth that command-line processes need, since they never set the in-memory mirror. Switching it to the asynchronous reader would make the gate perform the legacy-marker migration **write** — precisely the write the gate exists to prevent, into the repository the user asked to be left alone.

### Reading — install-time and repair consumers

All of these skip, or report-and-skip, when the flag is `true`:

- The CLI doctor source-control-hooks probe — reports ok ("manually disabled — run enable to re-enable") instead of failing "not installed", and attaches no re-install fixer, so the doctor auto-fix never reinstalls against the opt-out.
- The agent-plugin's per-session repo-hook reconciliation (the narrowed install mode that writes only the repo-local hooks, agent hooks, and menu state) — silently returns without reinstalling, and never clears the flag. Note this respect is a property of *that* invocation, not of the narrowed mode itself; an explicitly-invoked narrowed enable is an explicit enable and behaves as one.
- The VS Code activation sequence — reads the durable field once (asynchronously) alongside install status and reuses that single read to gate both the new-worktree reinstall path and the first-run auto-enable substep.
- The VS Code version-upgrade hook-path refresh — **doubly gated**. The activation call site now checks the in-process mirror and does not invoke the refresh at all when it is set, substituting a synthesized "no version mismatch" so the whole downstream chain still runs against untouched hooks (see spec 100). The refresh itself independently retains its own durable read at its entry point and returns immediately when set, which is what protects any other caller. Both layers matter: the call-site skip is what avoids the refresh's own reads and log lines in a disabled session, and the callee gate is what makes the refusal a property of the operation rather than of one caller.
- The settings surface's per-worktree agent-hook sync — the Settings panel stays reachable while the project is disabled (it is the sign-in and Memory Bank entry point), so a settings save must not silently reinstall agent hooks across every worktree. The hook-sync step is skipped on the mirror; the surrounding save is not (see the carve-outs under Priority). Removals are skipped too — the disable already uninstalled them.
- The "rebuild the knowledge base" / migrate-to-Memory-Bank action — refuses outright with a user-facing "enable it first" message. The refusal is not merely a skip: the action's identity-archive step *is* gated but its folder-creation and configuration-repoint steps are not, so a single click on a disabled project would de-identify the previous folder while migrating nothing into the new one.
- The JVM IDE plugin's automatic startup repair — the one automatic install path on that surface. It gates on its own cached copy of the verdict AND hands the check to the install operation as well, so the decision is re-made from the profile under the profile lock. That belt-and-braces is deliberate: the automatic install also asks for the opt-out to be cleared on success, so a single stale cached `false` would not merely reinstall hooks, it would erase the record of the user's intent.
- The long-lived host-bridge server's data-write actions — the memory/transcript/plan/reference writes and the raw container write. They are refused with an explicit failure carrying a manually-disabled marker (see spec 304 for the inventory and the reasoning); this is the only enforcement point that covers a server the JVM host already had running before the disable.
- The command-line startup skill reconciliation that self-heals stale on-disk agent recipes after a version upgrade — uses the **read-only** reader, precisely because the asynchronous reader's legacy-marker persist would itself be a write on a path whose whole purpose is not to write. It returns **before** stamping its own version marker, so the reconciliation is re-attempted (and re-refused) on every later invocation until the repository is re-enabled, rather than recording the running version as "reconciled". A disable also deliberately leaves the skill files on disk, so the probe that decides "this repository has skills" still matches — this read is the only thing keeping a version-bumped tool from rewriting them.

### Reading — the runtime capture gate

Nine entry points read the flag on **every** invocation and return early when it is `true`. In each case the gate's *position* within that entry point's own sequence is load-bearing, because it determines which of that entry point's other effects, checks, and I/O never happen:

| Entry point | Gate position | Consequence on the disabled path |
|---|---|---|
| Post-commit hook | Step zero — before operation-kind detection, before any queue write, before the worker spawn | No queue entry, no worker spawned, and — because the hook returns before it would start the interactive capture-progress watch — no capture feedback is printed at all, regardless of terminal/agent context or the feedback setting |
| Post-merge hook | Before the merge-reflog read | No merge inspected, no topic-knowledge ingest operation enqueued |
| Post-rewrite hook | **Before** reading the piped old-to-new rewrite mapping | The mapping supplied on standard input is **not drained**; no amend or rebase entries enqueued, no worker spawned |
| Prepare-commit-msg hook | Before all squash detection (both the tool-driven merge-squash branch and the reset-squash detector) | No squash pending-state file is written, so no squash queue entry can ever be enqueued for a disabled repository |
| Pre-push hook | **Before** configuration is loaded, and therefore before the unrelated sync-on-push opt-out gate | No push-pending queue write, no inline sync, no signed-out memory preview; the push still proceeds and still exits success |
| Push-pending compensation worker | First statement of the worker entry point, before the drain engine is called | The compensation drain is a clean no-op, so every surface's spawn of it is inert on a disabled repository |
| Source-control operation queue worker | After the log directory is set, but **before** the per-vault write lock, before the startup banner, and before storage construction | Neither the banner nor any lock activity is logged; no storage backend is constructed or registered; no entries are drained and no successor is spawned |
| Claude agent stop hook | After the "hook triggered" log line, **before** the Claude-integration configuration gate and **before** the required-field check | No session-registry write, no transcript-discovery pass, no telemetry flush; the payload's validity is never examined |
| Claude agent session-start hook | After the log directory is set, before context composition — and **outside** the composition deadline race | Nothing on standard output, no index/summary/plans/cache reads; and the gate's own cost is not covered by the composition deadline |

The one omission is the Gemini after-agent hook: it is the only agent hook that does **not** carry the runtime gate. On a manually-disabled repository it still records a session-registry entry and still writes its required standard-output response. Nothing downstream consumes those records, because every path that would is itself gated. Whether the omission is intentional is not recorded anywhere.

### Reading and writing from the JVM IDE host

The flag is no longer editor-extension-only. The JVM IDE plugin both reads and writes it, and does so **bridge-first with a direct-from-disk fallback**:

- **Write** — always over the host bridge, never by touching the file. The bridge write goes through the same canonical writer under the same lock, so a concurrent command-line disable in a terminal, or an editor-extension write in a sibling worktree, cannot be clobbered. A transport failure is surfaced to the caller as an abort signal: the caller must not proceed with the rest of the disable, or on-disk state and user intent would diverge.
- **Read** — the bridge is tried first. On any transport failure the host falls back to reading the profile itself, applying the same anchoring (main worktree), the same three-step precedence, and the same legacy per-worktree marker fallback as the read-only reader. Two properties of this fallback are load-bearing:
  - **A reply that carries no usable verdict field falls through to disk, exactly like a thrown transport error.** Answering "not disabled" there would be reading an *absence of an answer* as an answer — and the automatic startup repair, which asks for the opt-out to be cleared on success, would then silently un-disable the repository.
  - **The fallback honours the legacy per-worktree marker.** Without it, a bridge outage in a repository disabled by an old editor-extension version (marker present, no profile field yet) would read as not-disabled and hand the automatic repair a green light.
- **A third, tri-state read** exists for one narrow consumer: it reports *authored `true`* / *authored `false`* / **undecided**, rather than collapsing "undecided" to "not disabled". It reads the profile directly, because the bridge's read has already collapsed the distinction it exists to report. Its consumer is the legacy machine-global pause projection (spec 332); a plain boolean there let an explicit re-enable be undone on every restart.

The host also keeps a cached copy of the verdict, refreshed on the same fan-out as the rest of its status. That cache, its optimistic flips, and its roll-backs belong to spec 332.

### Runtime cost

Each gated invocation costs at minimum one source-control query to resolve the repository's shared root plus one small file read. The **first** invocation in a repository whose profile has no decision recorded costs additionally: an enumeration of every worktree (the legacy-marker migration scan) and one locked read-modify-write to persist the resulting decision. Two entry points carry a documented budget this lands inside:

- The post-commit hook's "a few milliseconds" budget — the added query plus read fits inside it in the steady state; the once-per-repository first invocation is the outlier.
- The session-start handler's hard composition deadline — the gate sits **outside** the deadline race, so the deadline does not bound it.

### Two migrations, in order

**A. Pre-split profiles.** A profile written before the field split carries only the composite. The asynchronous reader folds it onto the authored field under the shared lock (step 2 of the precedence). See the persist rule below — it applies to both migrations.

**B. The legacy per-worktree marker.** Before this repo-wide field existed, the editor extension recorded the same intent as a marker file at `<worktree-root>/.jolli/jollimemory/disabled-by-user` — its mere existence was the boolean. Nothing writes that file anymore, but a read still honors it for repos that predate migration:

1. If the profile already answers at precedence step 1 or 2, that answer wins outright and the read returns immediately — no worktree enumeration.
2. Otherwise every worktree of the repository (enumerated via the worktree list, falling back to just the current directory if enumeration fails) is checked for the legacy marker. If ANY worktree still has it, the repo is treated as disabled. Checking every worktree makes the migration correct for a repo disabled in one worktree before upgrading.
3. The resulting verdict is persisted (see below) — **including a confirmed absence, which is persisted as `false`**.

**The persist rule, shared by both migrations, and the value it returns.** The write happens under the shared lock, and inside the lock the profile is re-read. If a concurrent explicit enable/disable landed in the meantime, that value is kept **and returned to the caller** — the caller is not told the value it proposed. That distinction is not cosmetic: the migration derives its proposal from an *unlocked* read, so an explicit disable can land in between; returning the proposal would have made the hook gate answer "not disabled" against a profile that says otherwise, capturing the very commit the user had just opted out of.

If the lock cannot be acquired, or the guarded write throws, nothing is persisted and the **proposed** value stands — there is no winner to prefer — and the whole migration path is re-attempted on the next read. Either way, the composite is recomputed as part of any write that lands.

Persisting a confirmed absence exists purely so the runtime capture gate stops paying for worktree enumeration on every hook invocation. Its user-visible consequence is that **the very first hook invocation in a fresh repository creates the profile file and takes the profile lock**, even though the user has made no decision at all. Every subsequent read short-circuits at precedence step 1.

The profile file's other field (the back-fill dismiss flag) has its own, separate legacy-marker migration, and that one does **delete** its legacy marker after the persist lands — the ordering is load-bearing, so a failed persist leaves the marker intact for the next read to re-migrate. This field's legacy per-worktree markers are deliberately **not** deleted: they are simply never consulted again once the field is present.

### Concurrency

All writes go through a shared lock file in the same anchored location, so a CLI write in one worktree and a VS Code write in a sibling worktree — or a back-fill-dismiss write racing a `manuallyDisabled` write — can't lose-update each other. The guarded section is a small read-modify-write, and the file is written via temp-file-plus-rename so a lost race can't corrupt it.

The lock is **strict, not best-effort**: if it cannot be acquired within its wait budget, the guarded work does not run at all.

- **Write path** — rejects with a lock-timeout error. The value is not written. Callers that treat that rejection as fatal (the explicit disable) abort; callers that swallow it (the back-fill dismiss writers) silently lose the write.
- **Read path** — persists nothing and returns the un-persisted verdict it derived from the legacy-marker scan. The read itself never fails on lock contention; it just does not memoize.

Nothing ever proceeds unlocked.

## State Transitions

States below are of the **authored** field; every landing write also recomputes the composite.

| From | Event | To | Notes |
|---|---|---|---|
| Absent, composite present | Any asynchronous read, lock acquired | The composite's value (persisted onto the authored field) | The pre-split migration. Only reachable on a profile written before the split. |
| Absent, no composite | Legacy marker present in any worktree, on first read, lock acquired | `true` (persisted) | The migrated value is durable; subsequent reads short-circuit on it. |
| Absent, no composite | Legacy marker present in any worktree, on first read, lock busy | Unchanged (absent) | `true` is still *returned*; nothing is persisted; the migration is re-attempted on the next read. |
| Absent, no composite | **No legacy marker in any worktree**, on first read, lock acquired | `false` (persisted) | A confirmed absence is recorded so the runtime gate stops enumerating worktrees. This is what makes the first hook invocation in a fresh repository create the profile file and take the lock. |
| Absent | Any migrating read, lock acquired, but a concurrent explicit decision landed inside the lock | That concurrent value, **and that value is what the reader returns** | The locked write re-reads, so an explicit enable/disable always beats a migration verdict — in the stored value and in the answer. |
| Absent | First read **through the read-only reader** | Unchanged (absent) | The read-only reader neither migrates nor persists, so the state stays ABSENT no matter how many times it is consulted. This is the deliberate contrast to the asynchronous reader, whose first read is itself a write. A repository whose only readers are read-only ones therefore never gains the field at all. |
| Absent | The structural marker is written | Resolved to a real boolean and materialized in the same locked write | Absence-only: a value a concurrent explicit enable/disable just persisted wins. This is what stops the marker's `true` composite from later being folded onto the authored axis. |
| Absent or `false` | Explicit disable, write succeeds | `true` | Uninstall proceeds only after this write lands. |
| Absent or `false` | Explicit disable, write fails (unwritable directory **or** lock timeout) | Unchanged | Uninstall does not run; command reports an error naming the failure. |
| `true` | Explicit enable, full mode, install + write succeed | `false` | All consumers resume normal auto-repair, and every gated hook resumes capture, on their next read. The structural marker, if present, is untouched — so the composite stays `true` and older runtimes stay stopped. |
| `true` | Explicit enable, install succeeds but write fails | `true` (retry needed) | Enable still reports overall success; a warning names the stuck opt-out. Capture stays off. |
| `true` | Automatic install that asked to respect the opt-out | Unchanged | The install is refused as a **zero-write success** carrying a manually-disabled marker; no hooks are written and the opt-out is not cleared. See spec 44. |
| Any | Integrations-only enable or disable | Unchanged | This mode never touches hook installation. |
| Any | Doctor, agent-plugin session bootstrap, sign-in/out, config edits, status refresh | Unchanged | Read-only or unrelated paths. |
| `true` | Any gated hook, worker, or bridge write action fires | Unchanged | The gate is read-only. A disabled repository's hooks keep firing and keep returning early forever; nothing self-heals and nothing accumulates. |

## Notable Behavior

- **The decision is three fields, and only one of them is authored.** The composite exists purely so that runtimes shipped before the split — which know that one name and nothing else — keep stopping. It is recomputed on every write of its sources and is never hand-written. (Surprising; the field with the most obvious-sounding name is the derived one.)
- **Reading the composite for a decision is the bug the split exists to prevent.** A repository carrying only the structural marker would read back as "the user turned this off": capture would stop on the current runtime, the JVM host would paint its disabled card, and automatic repair would stand down — for a repository nobody disabled. Current code reads the composite in exactly one place, as the pre-split migration fallback. (Surprising; central.)
- **Enable clears the authored field and deliberately leaves the structural marker.** A re-enabled repository can therefore still carry a `true` composite forever, which is the intended outcome for older runtimes and invisible to this one.
- **Writing the structural marker also materializes the authored field.** Otherwise the marker alone would produce a `true` composite on a profile with no authored decision, and the very next migrating read would fold that onto the authored axis — permanently recording an opt-out the user never made. (Surprising; a write of one field exists to protect a *read* of another.)
- **The synchronous read-only reader is now on a repeatedly-fired path, and its main-worktree resolution is memoized per input directory.** Only the root resolution is cached; the profile read that carries the verdict is not, so enable and disable are still observed on the next call. Its two call sites must both stay on this variant — the asynchronous reader performs a migration **write**, which is exactly what one of those gates exists to prevent. (Load-bearing; swapping the reader would compile and pass, and silently write into a repository the user asked to be left alone.)
- **The opt-out is repo-wide, not per-worktree.** Disabling from any worktree (or from the CLI) holds for every worktree of the repository, because all resolve to the same anchored file. The previous "two worktrees, two independent opt-outs" behavior no longer holds.
- **Disabling does not require uninstalling.** The flag is a runtime gate as well as an install-time one, so a repository whose hooks are still fully installed captures nothing while it is set. Conversely, an uninstall that removed the hooks but failed to persist the flag is the dangerous half-state the write ordering exists to prevent. (Surprising; central design choice.)
- **Gate placement is behavior, not style.** Each gated entry point puts the read ahead of a *specific* effect it must not have: ahead of draining the piped rewrite mapping, ahead of loading configuration (and therefore ahead of an unrelated opt-out that would otherwise be consulted), ahead of acquiring a write lock and emitting a startup banner, ahead of a required-field check, and ahead of the interactive feedback watch. Moving any one of them later would change observable behavior on a disabled repository. (Surprising; intentional.)
- **A disabled repository consumes nothing that was handed to it.** Most notably the post-rewrite hook returns before reading the rewrite mapping the tool piped to it. The pre-push hook is the deliberate contrast: it reads its standard input at its entry point, before the gated body runs, so its pipe is always drained. (Surprising; the two hooks differ on purpose.)
- **One agent hook has no runtime gate.** The Gemini after-agent hook still records sessions on a disabled repository. Whether that is intentional or an omission is not recorded anywhere; the behavior is documented here as-is. (Surprising.)
- **The first read in a fresh repository is a write.** A confirmed *absence* of any decision is persisted as `false`, so the very first hook invocation creates the profile file and takes the profile lock even though the user has decided nothing. This exists solely to keep the runtime gate cheap on every later invocation. (Surprising; intentional.)
- **A failed disable-write blocks the disable; a failed enable-write does not block the enable.** A silently-failed disable would leave a deceptive half-state a later upgrade could re-enable; a failed enable-clear leaves hooks installed and working — worth a warning, not a failure.
- **Lock contention is a real failure mode, not a soft one.** The lock is strict: a timeout means the guarded work does not happen. The write path rejects; the read path returns its verdict without memoizing it. Nothing proceeds unlocked. (Surprising; this is the opposite of the older best-effort locking it replaced.)
- **The agent-plugin's per-session bootstrap never clears the flag** — only an explicit enable does; a stuck failed-clear keeps blocking every session's bootstrap until enable succeeds.
- **doctor --fix treats a manual disable as healthy, not a fault** — missing hooks under an active opt-out report ok, with no re-install fixer.
- **Migration only moves the legacy marker's intent forward, never back** — once the field is set, the legacy per-worktree file is never consulted again for that repo, and it is never deleted either. (The profile's *other* field takes the opposite approach: it retires its legacy marker by deleting it, ordered after the persist so a failed persist leaves the marker intact.)
- **The flag's storage file is shared with an unrelated dismiss field but the two are read/written independently** (shared physical file, lock, and atomic-write mechanics only).
- **The JVM IDE host is a first-class reader and writer now, and its read fails CLOSED.** Writes go over the host bridge so they take the same lock as every other surface; reads try the bridge and fall back to the profile on disk. A bridge reply that carries no usable verdict field is treated exactly like a transport error and falls through to disk — an absence of an answer is not an answer of "not disabled", and the automatic startup repair that consumes it would otherwise clear the opt-out. The disk fallback also honours the legacy per-worktree marker for the same reason. (Surprising; the safe direction here is the opposite of the general "degrade to not disabled" rule, because this consumer's success path erases the flag.)
- **There are two readers of the same field, and they disagree about side effects on purpose.** The asynchronous one persists a confirmed absence; the synchronous one persists nothing, ever. Callers that are themselves deciding whether to write choose the read-only one, because the other reader's persist would be exactly the write they are trying to avoid. Choosing the wrong reader on such a path is a silent contract violation — the code would still return the right answer while breaching the guarantee. (Surprising; intentional.)
- **The in-process mirror is a statement about one editor session, not about the repository.** It is set only by the editor host, so every mirror-based gate is inert in command-line invocations, hook scripts, the background worker and the bridge daemon. Those processes are covered instead by their own durable read at their own entry. (Surprising; intentional — see the scope limit above.)
- **The disable gesture's own telemetry event is a repository-local write a disabled repository still receives.** It is recorded *after* the opt-out has durably landed and after the mirror has been set, and it still reaches the repository's local event buffer — because telemetry suppression is placed per call site, and the user-gesture call sites carry none. The same holds for every other explicit-gesture event still reachable while disabled (opening settings, signing in or out, changing the model provider). Only the automatic per-activation event and every flush are suppressed. See spec 203. (Surprising; the carve-out is deliberate.)
- **The carve-out is per-event, not per-gesture.** Manual sync rounds and the manual commit-generation command are both refused outright while disabled (with a user-facing message in the latter case), even though they are explicit user gestures — while the enable and disable gestures themselves are allowed to record telemetry. "Explicit gesture" is therefore not the dividing line; each individual effect was decided on its own. (Surprising.)

## Shared Behavior

- The auto-enable substep consumes this flag as one of its preconditions; this spec owns the flag's storage, migration, priority, and error-handling, not what auto-enable does with the result.
- The gated entry points each own their own remaining behavior; this spec owns only the gate, its position, and what the position rules out. They are: post-commit enqueue (spec 31), post-rewrite handling (spec 32), prepare-commit-msg squash detection (spec 33), the source-control operation queue worker (spec 34), the Claude agent stop hook (spec 26), the Claude agent session-start briefing (spec 27), the pre-push hook (spec 268), the push-pending compensation worker (spec 270), and the post-merge ingest trigger. The interactive capture feedback the post-commit gate makes unreachable is owned by the capture-progress streaming spec.
- The Gemini after-agent hook (spec 28) records its non-participation in this gate.
- The repo-wide profile file's other fields (the back-fill dismiss flag, and the structural marker's attempt-throttle timestamp) live in the same file under the same lock.
- **The structural marker's own meaning** — why a repository acquires one, what it changes about where memories go, and who may remove it — is defined by **Orphan Branch Cutover Fence and Compare-and-Swap** (345). This spec owns only its participation in the composite, the enable path's refusal to clear it, and the ordering rule that materializes the authored field alongside it.
- `specs/332-intellij-enable-disable-surface.md` owns the JVM IDE host's enable/disable lifecycle: which gestures call which operation, the cached verdict, the optimistic UI flip and its roll-back, and the legacy machine-global paused-setting projection that consumes the tri-state read described here.
- The onboarding-funnel snapshot's gate on this flag, and the trade-off that gate accepts, are owned by spec 312.
- A related opt-out, `pushDisabled`, records a narrower restriction — outbound push to a Jolli Space only, with local capture left running. It does **not** live in this `profile.json`: it is stored in a separate machine-global, identity-keyed `~/.jolli/jollimemory/push-control.json` under its own lock. It composes with `manuallyDisabled` in the shared `isOutboundPushAllowed` predicate; its storage, gate points, and per-surface current-repo control are owned by spec 310.
- The machine-global user profile file has the same filename but a different, machine-wide location and unrelated fields; the two files are unrelated aside from the naming coincidence.
- CLI hook installation orchestration and the bridge-level enable/disable paths are what the flag gates.
- `specs/304-manually-disabled-zero-write-contract.md` owns the in-process write gate's mechanism and the full inventory of writes it suppresses. This spec owns the flag itself, its two readers, the mirror's lifecycle, and the per-surface consequences recorded here.
- `specs/305-re-enable-transcript-discovery-catch-up.md` owns the catch-up drain the enable path runs after releasing the mirror. This spec owns only its position in the enable ordering.
