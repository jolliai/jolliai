# 60. `jolli doctor --fix` — Auto-repair faults

## Topic Statement

The `jolli doctor --fix` command runs the same diagnostic probes as `jolli doctor` and then attempts to repair every fault that has a known remedy.

## Scope

This spec covers the `--fix` mode of `jolli doctor`: which probes have an attached repair, what each repair does, the output produced after the diagnostic report, prompting behavior, idempotency, and the exit code policy. The diagnostic-only mode (`jolli doctor` without `--fix`) is specified separately.

## Data Contracts (output)

A multi-line report written to stdout, in three sections:

1. **Diagnostic report** — identical to `jolli doctor`'s diagnostic output (the `Jolli Memory Doctor` header, the separator, one icon-prefixed line per probe). This is printed before any repair runs.
2. **Fixes section** — printed only when at least one probe has an attached fixer. Begins with `Applying fixes...` and contains one line per fixer:
   - `✓ <probe name>: <result message>` on success — the result message is whatever the fixer reports (e.g. `reinstalled`, `released`, `removed stale entry`).
   - `✗ <probe name>: fix failed — <error>` on failure.
   When fixers fail, a final line reports the count: `<n> fix[es] failed.`
3. **Hint** — when in `--fix` mode the "Run with --fix to auto-repair issues." hint from the diagnostic mode is suppressed regardless of outcome.

Errors from fixers are reported in the fixes section, not via stderr.

## Behavior

### Invocation forms

- `jolli doctor --fix` — run all probes, then attempt every available repair.
- `jolli doctor --fix --cwd <dir>` — same, scoped to `<dir>`.

The command never prompts the user for confirmation before applying a repair. `--fix` is the explicit consent — there is no second `[y/N]` gate.

**One flag changes what `--fix` means entirely.** When the recovery flag is also passed, the command takes a completely different path: no probe runs, no repair loop runs, and `--fix` degrades to a single boolean — "overwrite a healthy database". See "Recovery mode" below.

### Per-probe repair

Repairs are attempted in the same order the probes ran. A probe contributes to the fix loop only if it has a fixer attached; probes that are purely informational or whose fault has no automated remedy are skipped.

| Probe | Fault verdict | Repair |
|-------|---------------|--------|
| Git hooks | `ok` "manually disabled" (repo-wide opt-out set, spec 145) | No fixer. `--fix` never reinstalls hooks while the opt-out holds — the user must run `jolli enable` explicitly. |
| Git hooks | `fail` "not installed" | Re-runs the same install action that `jolli enable` would, but asks it to **honour** the repo-wide manual-disable opt-out (spec 145) rather than override it. The fixer reports `reinstalled` on success, or throws the installer's error message on failure. |
| Local agent CLI | `fail` (resolver could not find a usable agent CLI) | No fixer. Installing, upgrading, or signing in to a local agent CLI requires user action; the interactive repair ladder (spec 291) is the surface that offers it. The diagnostic line carries a tool-specific sign-in instruction and, when an explicit executable path is configured, a second clause naming that configuration key and the command that removes it (spec 59) — so the message now spells out **two** remedies, both of which are user actions this table records as unfixable. Neither grew a fixer: `--fix` will not sign a user in, and it will not delete a configuration value the user deliberately set. |
| Claude hook | `warn` "not installed (optional)" | No fixer. Missing optional hooks are not auto-installed. |
| Gemini hook | `warn` "not installed (optional)" | No fixer. |
| Orphan branch | `warn` "not yet created" | No fixer. The orphan branch is created lazily on the first commit; nothing to do. |
| Lock file | `fail` "stuck" | Releases the worker lock. Reports `released`. |
| Sessions | `ok` informational | No fixer. |
| Git queue | `warn` "high" | No fixer. A high active count is a symptom (e.g. of a stuck worker), not a fault that can be auto-fixed; the user must investigate. |
| Config | `warn` "no credentials" | No fixer. Credentials require explicit user action (`jolli auth login` or `jolli configure --set apiKey=…`). |
| dist-paths/`<source>` | `warn` "(MISSING)" | Removes the stale per-source registry entry. Reports `removed stale entry`. |
| dist-paths registry empty | `fail` "no sources registered" | No fixer. The user must run `jolli enable`. |
| System of record | `fail` "unavailable" | No fixer. A repository whose truth has nowhere to live needs recovery mode below, not an unattended repair. |
| Database backup | `fail` staleness **only** (spec 59) | Takes one snapshot through the ordinary opportunistic path (spec 349). Reports `snapshot written to <path>` on success, or `snapshot not taken: <reason>` otherwise — **without throwing in either case**. |
| Database backup | `fail` invalid folder, or unreachable folder | No fixer. Both need a human; a snapshot attempt would fail the same way. |

### Recovery mode (`--recover`)

A separate mode of the same command, selected before any probe runs and returning without running one. It answers "the memory database is missing or damaged — what can I restore from?" and, when told which file to use, performs the restore.

**Invocation forms:**

- `jolli doctor --recover` — survey and list only; never writes.
- `jolli doctor --recover --from <snapshot path>` — survey, then restore from that file.
- `jolli doctor --recover --from <snapshot path> --fix` — the same, with `--fix` carrying the **only** meaning it has in this mode: consent to overwrite a healthy database.

**The survey, printed first in every form:**

1. The database's path, and its file state — which of the healthy combinations it is in, or that it is absent, or the alarming state where its write-ahead sidecars survive without it (spec 348).
2. **Only when the database is absent**: the identity verdict (fresh install / deleted / ambiguous residue) and both raw identity witnesses, each printed as `(none)` when unrecorded.
3. Every snapshot candidate, newest first, one line each: its timestamp (or a marker when the filename's stamp cannot be parsed), the identity fragment from its filename, a pre-migration marker where applicable, and its path. When there are none, the list is replaced by a line naming every folder that was scanned.

The folders scanned are the configured-or-default snapshot folder, the directory of the `--from` file when one was given, and the folder recorded inside the database as last used — the last of which is reachable only while the database still opens, which is exactly what may be gone.

With no `--from`, the command ends by printing how to invoke the restore, and returns.

**With `--from`, the fixed three-step recovery order runs** (spec 349 owns the ordering rationale; the two fill steps' mechanics are owned elsewhere):

| Step | What runs | Output |
| --- | --- | --- |
| ① Restore | The snapshot becomes the database — refused over a healthy one without `--fix`, integrity-checked before and after copying | `Restored from <path>.` |
| ② Mirror fill | Every registered repository's memory mirror fills memory gaps only; additive, never deleting, never touching activity data | one line with nodes, repositories and skipped counts |
| ③ Frozen-branch fill | Only repositories carrying a freeze marker; recovers what existed before the freeze | one line, **printed only when at least one repository was touched**, telling the user to finish each one's cutover |

The run ends by telling the user to re-run the diagnostics. Steps ② and ③ run **only after a successful restore** — a refusal or a failure prints the reason to stderr and stops there.

**A refusal is not a failure of the restore, but it is reported like one:** both a refusal (a healthy database, no `--fix`) and an outright failure print `Restore <status>: <reason>` to stderr and set a non-zero exit.

### Behavior on read-only repos

The fixers that perform writes (hook re-install, lock release, registry-entry removal) propagate underlying I/O errors. If the project directory or the global Jolli state directory is not writable, the affected fixer fails with the OS error message wrapped in the `✗ <probe name>: fix failed — <error>` line. The diagnostic verdict remains `fail` (or `warn`) for that probe.

### Idempotency

Re-running `jolli doctor --fix` is safe. Successfully applied fixers are no-ops on the second run because the fault no longer exists. Fixers that failed will be retried.

## Exit Codes

The exit code is decided independently of the original diagnostic verdicts:

| Code | Condition |
|------|-----------|
| `0`  | Every fixer that ran succeeded **and** every remaining `fail` verdict has an attached fixer (i.e. every fault was repaired). Warnings do not affect the exit code. |
| `1`  | Either at least one fixer threw, **or** at least one probe with a `fail` verdict has no fixer (an unfixable failure). |

In recovery mode the probes never run, so neither rule applies:

| Code | Condition |
|------|-----------|
| `0`  | The survey was printed (with or without candidates), or the restore succeeded. |
| `1`  | The restore was refused or failed. |

The invariant is: a `0` exit from `--fix` means a subsequent `jolli doctor` would also return `0`. CI relies on this.

## Notable Behavior

- **No interactive prompt before repairs.** The command applies every available repair without asking. Users who want to review faults first should run `jolli doctor` (without `--fix`).
- **Faults the user must resolve manually.** Missing credentials (`Config` probe), high active queue (`Git queue` probe), and an empty dist-paths registry all require user action and are deliberately not auto-fixed. They will continue to appear on subsequent `doctor` runs until resolved.
- **A successfully applied fixer is assumed to have repaired its fault.** The doctor does not re-run the probe after the fix; the exit-code computation trusts that a returned-without-throwing fixer succeeded.
- **The hook re-install fixer is the same install action as `jolli enable`.** It is the only fixer that performs more than one filesystem mutation; on partial success the underlying installer's error message is what surfaces.
- **A failing OAuth or `--fix` over a read-only filesystem yields exit `1`.** Since the affected fixer threw, the failure is counted.
- **A manual disable makes the Git-hooks probe report `ok`, not `fail`.** `--fix` treats an active repo-wide opt-out (spec 145) as healthy.
- **The reinstall fixer honours the opt-out too, which makes one narrow outcome possible: a reported success that installed nothing.** In normal operation the probe already returns `ok`-with-no-fixer whenever the opt-out is set, so the fixer never runs against a disabled repository. But if the flag is flipped between the probe's read and the fixer's run, the install returns *success* with a message saying the repository remains manually disabled — so the fixer does not throw and `--fix` prints `✓ Git hooks: reinstalled` while nothing was actually installed. This is a deliberate belt-and-braces guard against a concurrent disable, not a routine gate.
- **Neither of the two credential-shaped faults has a fixer, and that boundary is intentional.** Missing credentials and an unusable local agent CLI both require choosing a provider, typing a key, or clearing a setting — which an unattended repair pass must not do on the user's behalf. The interactive repair ladder (spec 291) is the counterpart surface that repairs exactly these two faults, and it is never invoked from `doctor`.
- **A richer remedy message did not move the no-fixer boundary.** The local-agent diagnostic line now names up to two concrete user actions (sign in; clear the explicit-path setting), and `--fix` still performs neither. Removing a value the user explicitly configured is exactly the class of decision `--fix` is not allowed to make, so the growth in *advice* is deliberately not matched by growth in *automation*. The consequence recorded above still holds unchanged: an unusable local agent CLI is a `fail` with no fixer, so it forces exit `1` and cannot be cleared by re-running `--fix`.

- **The backup fixer reports success even when it took no snapshot.** It returns a message either way — "written to …" or "not taken: `<reason>`" — and returns rather than throwing, so the fixes section prints a tick and the exit-code rule counts the fault as repaired. A user whose snapshot folder became unreachable between the probe and the repair sees a green line and exit `0` with the same fault still present on the next run. (Surprising; the same "a fixer that returns is assumed to have worked" rule as above, with a message that quietly says otherwise.)
- **The one fault this command can genuinely create is also the only one it repairs.** Backup staleness appears because snapshots ride two event-driven call sites and nothing schedules them, so a week of not committing is enough to fail the report — and the repair is simply to run the pass by hand. (Notable.)
- **`--fix` means something entirely different in recovery mode.** There it is not "apply every repair" but a single consent to overwrite a healthy database — and because the recovery flag short-circuits before the probes, `jolli doctor --recover --fix` repairs *nothing else*: no hooks are reinstalled, no lock is released, no stale registry entry is removed. (Surprising.)
- **A refusal exits non-zero.** Restoring over a healthy database without consent is the safe, expected outcome of re-running recovery, and it still reports as a failure on stderr with a non-zero exit. (Notable.)
- **The two gap-fill steps run unconditionally after a successful restore, and one of them prints nothing when it does nothing.** The mirror line is always printed, including as all-zeros; the frozen-branch line appears only when at least one fenced repository was touched. (Notable.)
- **The most useful folder in the survey is the one most likely to be unavailable.** The previously-configured snapshot folder is recorded inside the database, so after a re-target it stays a candidate source — but only while the database still opens, which is precisely the situation recovery exists for. (Surprising.)

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- The probes, their order, the verdict labels, and the diagnostic-line format are all identical to the diagnostic-only mode (spec 59).
- The `--fix` flag does not affect which probes run; it only controls whether the fix loop runs after them — except in recovery mode, where no probe runs at all.
- The snapshot engine the backup fixer invokes, the restore it performs, the verification and sidecar-removal ordering inside that restore, and the rationale for the three-step recovery order are all owned by spec 349. The file-state and identity verdicts the survey prints are owned by spec 348, and the database they describe by spec 347.
- The backup health verdict that decides whether the fixer is attached at all — including that staleness is its only repairable outcome — is owned by spec 59.
