# Repo-Wide Manual Disable Flag

## Topic Statement

A single boolean field inside a machine-local, repo-wide profile file records the user's explicit "memory capture is off for this repository" decision. The field is written and read by a canonical module that both the CLI commands and the VS Code extension call into, so the opt-out is a single source of truth across every worktree of the repository and across both surfaces. The field is not only an install-time signal: every source-control hook, both agent hooks that carry the gate, and both background workers read it at the top of their own hot path and return early, so an opted-out repository captures nothing even while its hooks remain installed and wired on disk.

## Scope

**In scope:**
- The profile file's location and repo-wide anchoring (shared across worktrees).
- The boolean field's semantics, and its priority relative to every other install/repair path.
- Which commands and activation paths write, clear, or read the field, and the ordering/error-handling guarantees around each.
- The **runtime capture gate**: which hook and worker entry points read the field on every invocation, where in each entry point's own sequence that read sits, and what each one therefore never does on the disabled path.
- The **process-local in-memory mirror** of the durable field: what it exists for, which process sets it and at which three moments, and the scope limit that makes it inert in every other process.
- The **two readers** of the durable field — an asynchronous one that may persist a verdict, and a synchronous read-only one that never does — and why some consumers must use the read-only one.
- The per-invocation cost the runtime read adds, and the two documented performance budgets it lands inside.
- The one-time migration from the legacy per-worktree marker file that predates this field, including what the first read persists and what it does not delete.
- The effects and non-effects on doctor, the agent-plugin session bootstrap, the settings surface's hook sync, the startup skill reconciliation, the rebuild-the-knowledge-base action, and the version-upgrade / new-worktree auto-repair paths.

**Out of scope:**
- The general shape, atomic-write mechanics, and locking of the repo-wide profile file for OTHER fields it holds (the back-fill dismiss field).
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

### Field

| Field | Type | Meaning |
|---|---|---|
| `manuallyDisabled` | boolean (optional) | `true` = the user explicitly turned capture off for this repository. `false` = explicitly turned back on. Absent = no decision recorded yet (subject to legacy-marker migration). |

The file is shared with an unrelated back-fill-dismiss field written and read independently; both fields' writers use the same locked read-modify-write path so one field's write can never clobber the other.

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

Once `true`, nothing except an explicit re-enable clears it — not a version upgrade, not a window/IDE reload, not the doctor auto-repair, not the agent-plugin's per-session bootstrap. Because the runtime gate is placed ahead of every other opt-out, configuration read, and input-validity check in the entry points that carry it, a `true` flag also *masks* those checks: nothing downstream of the gate is ever consulted, so no other setting can override, soften, or re-enable the opt-out.

The third role has deliberate carve-outs — things a disabled repository still does:

- **Explicit-gesture funnel telemetry still writes the repository-local event buffer.** Suppression of telemetry lives at individual call sites, not inside the recording primitive, and the user-gesture call sites carry no suppression. See spec 203.
- **Machine-global configuration writes still happen**, and so do the machine-global agent-instruction block writes a settings save triggers. The gate protects the repository's own state, not the user's machine-wide preferences.
- **Separate command-line processes are unaffected**, per the scope limit above.

## Behavior

### Writing true (explicit disable)

Both the CLI disable command and the VS Code Disable command write `manuallyDisabled: true` BEFORE running the asynchronous uninstall (hook removal), so the user's intent survives even if uninstall throws partway. If the write itself fails, the command ABORTS WITHOUT UNINSTALLING: no hooks removed, an error surfaced (CLI: stderr + non-zero exit; VS Code: an error notification), the repo left in its previous coherent state. This deliberate asymmetry avoids a deceptive "hooks removed but flag unset" half-state that a later upgrade or activation could silently re-enable.

Two distinct conditions produce that write failure: an unwritable state directory, and a **failure to acquire the shared profile lock within its wait budget**. The write path is strict about the lock — on a timeout it rejects with a lock-timeout error rather than proceeding unlocked — so lock contention is a first-class disable-failure mode, surfaced to the user as an uninstall failure naming the lock timeout, with the repository still fully enabled.

**Ordering in the editor host:** the durable write comes first, then the in-process mirror is set, then the uninstall runs. The mirror sits between the two so that nothing the uninstall itself does — and nothing in the panel-refresh chain that follows it — reaches disk on behalf of a repository the user has just turned off.

### Clearing to false (explicit enable)

The CLI enable command (default full mode, not integrations-only), the CLI guided front-door's enable path, and the VS Code Enable command all clear the flag by writing `manuallyDisabled: false` AFTER install succeeds. A failed clear here is NON-FATAL: hooks are already installed, so the command prints/logs a warning telling the user to run enable again to clear the opt-out, rather than failing the whole command. This is safe because nothing auto-retries the clear — the agent-plugin's per-session bootstrap only READS the flag, never writes it, so a stuck `true` keeps blocking reinstalls until an explicit enable succeeds.

**Ordering in the editor host is the mirror image of disable:** the install runs first; then, on success, the in-process mirror is RELEASED *before* the durable clear is attempted; only then does the initialization catch-up run. Both orderings are load-bearing:

- Releasing the mirror before the durable clear means a failed clear still yields a fully functional session — the user's current window works, and only later windows would re-read the stuck opt-out.
- Releasing the mirror before the catch-up means the catch-up's own writes actually land. Were the release to come after, every gate inside the catch-up would short-circuit and the whole recovery pass would silently do nothing while reporting success.

Integrations-only enable/disable (the IntelliJ MCP-only setup/teardown path) does not touch the flag at all.

### Reading — general contract

Every consumer, install-time or runtime, treats any error (missing file, invalid JSON, non-object value, unresolvable repository root) as if the field were absent, then falls through to the legacy-migration check below. The read is total: it never throws, so no consumer needs to guard it. A read that cannot reach a verdict at all degrades to "not disabled", which is the direction that keeps capture working rather than silently killing it.

Two readers of the durable field exist, and they deliberately differ in their side effects:

| | Asynchronous reader | Synchronous read-only reader |
|---|---|---|
| Repository anchoring | Asynchronous source-control query for the shared root | Synchronous source-control query for the shared root — still anchored to the main worktree, so a linked worktree of a disabled repository does not read itself as enabled |
| Field present | Returned | Returned |
| Field absent | Legacy marker checked in **every** worktree | Legacy marker checked in the **current worktree only** |
| Still no verdict | Not disabled | Not disabled |
| Persists a verdict | Yes — see the migration section; a confirmed absence is written as `false` | **Never.** It neither migrates nor writes anything |

The read-only reader's refusal to persist is the whole reason it exists: it is chosen precisely by callers that are themselves gating a write and must not perform one in the act of deciding not to. The asynchronous reader's persisted absence would be exactly such a write.

### Reading — install-time and repair consumers

All of these skip, or report-and-skip, when the flag is `true`:

- The CLI doctor source-control-hooks probe — reports ok ("manually disabled — run enable to re-enable") instead of failing "not installed", and attaches no re-install fixer, so the doctor auto-fix never reinstalls against the opt-out.
- The agent-plugin's per-session repo-hook reconciliation (the narrowed install mode that writes only the repo-local hooks, agent hooks, and menu state) — silently returns without reinstalling, and never clears the flag. Note this respect is a property of *that* invocation, not of the narrowed mode itself; an explicitly-invoked narrowed enable is an explicit enable and behaves as one.
- The VS Code activation sequence — reads the durable field once (asynchronously) alongside install status and reuses that single read to gate both the new-worktree reinstall path and the first-run auto-enable substep.
- The VS Code version-upgrade hook-path refresh — **doubly gated**. The activation call site now checks the in-process mirror and does not invoke the refresh at all when it is set, substituting a synthesized "no version mismatch" so the whole downstream chain still runs against untouched hooks (see spec 100). The refresh itself independently retains its own durable read at its entry point and returns immediately when set, which is what protects any other caller. Both layers matter: the call-site skip is what avoids the refresh's own reads and log lines in a disabled session, and the callee gate is what makes the refusal a property of the operation rather than of one caller.
- The settings surface's per-worktree agent-hook sync — the Settings panel stays reachable while the project is disabled (it is the sign-in and Memory Bank entry point), so a settings save must not silently reinstall agent hooks across every worktree. The hook-sync step is skipped on the mirror; the surrounding save is not (see the carve-outs under Priority). Removals are skipped too — the disable already uninstalled them.
- The "rebuild the knowledge base" / migrate-to-Memory-Bank action — refuses outright with a user-facing "enable it first" message. The refusal is not merely a skip: the action's identity-archive step *is* gated but its folder-creation and configuration-repoint steps are not, so a single click on a disabled project would de-identify the previous folder while migrating nothing into the new one.
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

### Runtime cost

Each gated invocation costs at minimum one source-control query to resolve the repository's shared root plus one small file read. The **first** invocation in a repository whose profile has no decision recorded costs additionally: an enumeration of every worktree (the legacy-marker migration scan) and one locked read-modify-write to persist the resulting decision. Two entry points carry a documented budget this lands inside:

- The post-commit hook's "a few milliseconds" budget — the added query plus read fits inside it in the steady state; the once-per-repository first invocation is the outlier.
- The session-start handler's hard composition deadline — the gate sits **outside** the deadline race, so the deadline does not bound it.

### Migration from the legacy per-worktree marker

Before this repo-wide field existed, the VS Code extension recorded the same intent as a marker file at `<worktree-root>/.jolli/jollimemory/disabled-by-user` — its mere existence was the boolean. Nothing writes that file anymore, but a read still honors it for repos that predate migration:

1. If the profile file already has a `manuallyDisabled` field of EITHER value, that value wins outright and the read returns immediately — no worktree enumeration, no lock, no write.
2. Otherwise every worktree of the repository (enumerated via the worktree list, falling back to just the current directory if enumeration fails) is checked for the legacy marker. If ANY worktree still has it, the repo is treated as disabled. Checking every worktree makes the migration correct for a repo disabled in one worktree before upgrading.
3. The resulting verdict is then persisted back into the profile file under the shared lock — **including a confirmed absence, which is persisted as `false`**. The write re-reads the profile inside the lock, so a concurrent explicit enable/disable that landed in the meantime wins and is returned instead of the migration verdict.
4. If the lock cannot be acquired, nothing is persisted. The migration verdict is still returned, and the whole migration path is re-attempted on the next read.

Persisting a confirmed absence exists purely so the runtime capture gate stops paying for worktree enumeration on every hook invocation. Its user-visible consequence is that **the very first hook invocation in a fresh repository creates the profile file and takes the profile lock**, even though the user has made no decision at all. Every subsequent read short-circuits at step 1.

The profile file's other field (the back-fill dismiss flag) has its own, separate legacy-marker migration, and that one does **delete** its legacy marker after the persist lands — the ordering is load-bearing, so a failed persist leaves the marker intact for the next read to re-migrate. This field's legacy per-worktree markers are deliberately **not** deleted: they are simply never consulted again once the field is present.

### Concurrency

All writes go through a shared lock file in the same anchored location, so a CLI write in one worktree and a VS Code write in a sibling worktree — or a back-fill-dismiss write racing a `manuallyDisabled` write — can't lose-update each other. The guarded section is a small read-modify-write, and the file is written via temp-file-plus-rename so a lost race can't corrupt it.

The lock is **strict, not best-effort**: if it cannot be acquired within its wait budget, the guarded work does not run at all.

- **Write path** — rejects with a lock-timeout error. The value is not written. Callers that treat that rejection as fatal (the explicit disable) abort; callers that swallow it (the back-fill dismiss writers) silently lose the write.
- **Read path** — persists nothing and returns the un-persisted verdict it derived from the legacy-marker scan. The read itself never fails on lock contention; it just does not memoize.

Nothing ever proceeds unlocked.

## State Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Absent | Legacy marker present in any worktree, on first read, lock acquired | `true` (persisted) | The migrated value is durable; subsequent reads short-circuit on it. |
| Absent | Legacy marker present in any worktree, on first read, lock busy | Unchanged (absent) | `true` is still *returned*; nothing is persisted; the migration is re-attempted on the next read. |
| Absent | **No legacy marker in any worktree**, on first read, lock acquired | `false` (persisted) | A confirmed absence is recorded so the runtime gate stops enumerating worktrees. This is what makes the first hook invocation in a fresh repository create the profile file and take the lock. |
| Absent | First read, lock acquired, but a concurrent explicit decision landed inside the lock | That concurrent value | The locked write re-reads, so an explicit enable/disable always beats a migration verdict. |
| Absent | First read **through the read-only reader** | Unchanged (absent) | The read-only reader neither migrates nor persists, so the state stays ABSENT no matter how many times it is consulted. This is the deliberate contrast to the asynchronous reader, whose first read is itself a write. A repository whose only readers are read-only ones therefore never gains the field at all. |
| Absent or `false` | Explicit disable, write succeeds | `true` | Uninstall proceeds only after this write lands. |
| Absent or `false` | Explicit disable, write fails (unwritable directory **or** lock timeout) | Unchanged | Uninstall does not run; command reports an error naming the failure. |
| `true` | Explicit enable, full mode, install + write succeed | `false` | All consumers resume normal auto-repair, and every gated hook resumes capture, on their next read. |
| `true` | Explicit enable, install succeeds but write fails | `true` (retry needed) | Enable still reports overall success; a warning names the stuck opt-out. Capture stays off. |
| Any | Integrations-only enable or disable | Unchanged | This mode never touches hook installation. |
| Any | Doctor, agent-plugin session bootstrap, sign-in/out, config edits, status refresh | Unchanged | Read-only or unrelated paths. |
| `true` | Any gated hook or worker fires | Unchanged | The gate is read-only. A disabled repository's hooks keep firing and keep returning early forever; nothing self-heals and nothing accumulates. |

## Notable Behavior

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
- **There are two readers of the same field, and they disagree about side effects on purpose.** The asynchronous one persists a confirmed absence; the synchronous one persists nothing, ever. Callers that are themselves deciding whether to write choose the read-only one, because the other reader's persist would be exactly the write they are trying to avoid. Choosing the wrong reader on such a path is a silent contract violation — the code would still return the right answer while breaching the guarantee. (Surprising; intentional.)
- **The in-process mirror is a statement about one editor session, not about the repository.** It is set only by the editor host, so every mirror-based gate is inert in command-line invocations, hook scripts, the background worker and the bridge daemon. Those processes are covered instead by their own durable read at their own entry. (Surprising; intentional — see the scope limit above.)
- **The disable gesture's own telemetry event is a repository-local write a disabled repository still receives.** It is recorded *after* the opt-out has durably landed and after the mirror has been set, and it still reaches the repository's local event buffer — because telemetry suppression is placed per call site, and the user-gesture call sites carry none. The same holds for every other explicit-gesture event still reachable while disabled (opening settings, signing in or out, changing the model provider). Only the automatic per-activation event and every flush are suppressed. See spec 203. (Surprising; the carve-out is deliberate.)
- **The carve-out is per-event, not per-gesture.** Manual sync rounds and the manual commit-generation command are both refused outright while disabled (with a user-facing message in the latter case), even though they are explicit user gestures — while the enable and disable gestures themselves are allowed to record telemetry. "Explicit gesture" is therefore not the dividing line; each individual effect was decided on its own. (Surprising.)

## Shared Behavior

- The auto-enable substep consumes this flag as one of its preconditions; this spec owns the flag's storage, migration, priority, and error-handling, not what auto-enable does with the result.
- The gated entry points each own their own remaining behavior; this spec owns only the gate, its position, and what the position rules out. They are: post-commit enqueue (spec 31), post-rewrite handling (spec 32), prepare-commit-msg squash detection (spec 33), the source-control operation queue worker (spec 34), the Claude agent stop hook (spec 26), the Claude agent session-start briefing (spec 27), the pre-push hook (spec 268), the push-pending compensation worker (spec 270), and the post-merge ingest trigger. The interactive capture feedback the post-commit gate makes unreachable is owned by the capture-progress streaming spec.
- The Gemini after-agent hook (spec 28) records its non-participation in this gate.
- The repo-wide profile file's other field (the back-fill dismiss flag) lives in the same file under the same lock.
- A related opt-out, `pushDisabled`, records a narrower restriction — outbound push to a Jolli Space only, with local capture left running. It does **not** live in this `profile.json`: it is stored in a separate machine-global, identity-keyed `~/.jolli/jollimemory/push-control.json` under its own lock. It composes with `manuallyDisabled` in the shared `isOutboundPushAllowed` predicate; its storage, gate points, and per-surface current-repo control are owned by spec 310.
- The machine-global user profile file has the same filename but a different, machine-wide location and unrelated fields; the two files are unrelated aside from the naming coincidence.
- CLI hook installation orchestration and the bridge-level enable/disable paths are what the flag gates.
- `specs/304-manually-disabled-zero-write-contract.md` owns the in-process write gate's mechanism and the full inventory of writes it suppresses. This spec owns the flag itself, its two readers, the mirror's lifecycle, and the per-surface consequences recorded here.
- `specs/305-re-enable-transcript-discovery-catch-up.md` owns the catch-up drain the enable path runs after releasing the mirror. This spec owns only its position in the enable ordering.
