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

### Per-probe repair

Repairs are attempted in the same order the probes ran. A probe contributes to the fix loop only if it has a fixer attached; probes that are purely informational or whose fault has no automated remedy are skipped.

| Probe | Fault verdict | Repair |
|-------|---------------|--------|
| Git hooks | `ok` "manually disabled" (repo-wide opt-out set, spec 145) | No fixer. `--fix` never reinstalls hooks while the opt-out holds — the user must run `jolli enable` explicitly. |
| Git hooks | `fail` "not installed" | Re-runs the same install action that `jolli enable` would, but asks it to **honour** the repo-wide manual-disable opt-out (spec 145) rather than override it. The fixer reports `reinstalled` on success, or throws the installer's error message on failure. |
| Local agent CLI | `fail` (resolver could not find a usable agent CLI) | No fixer. Installing, upgrading, or signing in to a local agent CLI requires user action; the interactive repair ladder (spec 291) is the surface that offers it. The diagnostic line itself now carries a tool-specific sign-in instruction (spec 59) — which is precisely the user action this table records as unfixable, so the message tells the user what `--fix` deliberately will not do for them. No fixer is attached on the strength of that hint. |
| Claude hook | `warn` "not installed (optional)" | No fixer. Missing optional hooks are not auto-installed. |
| Gemini hook | `warn` "not installed (optional)" | No fixer. |
| Orphan branch | `warn` "not yet created" | No fixer. The orphan branch is created lazily on the first commit; nothing to do. |
| Lock file | `fail` "stuck" | Releases the worker lock. Reports `released`. |
| Sessions | `ok` informational | No fixer. |
| Git queue | `warn` "high" | No fixer. A high active count is a symptom (e.g. of a stuck worker), not a fault that can be auto-fixed; the user must investigate. |
| Config | `warn` "no credentials" | No fixer. Credentials require explicit user action (`jolli auth login` or `jolli configure --set apiKey=…`). |
| dist-paths/`<source>` | `warn` "(MISSING)" | Removes the stale per-source registry entry. Reports `removed stale entry`. |
| dist-paths registry empty | `fail` "no sources registered" | No fixer. The user must run `jolli enable`. |

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

The invariant is: a `0` exit from `--fix` means a subsequent `jolli doctor` would also return `0`. CI relies on this.

## Notable Behavior

- **No interactive prompt before repairs.** The command applies every available repair without asking. Users who want to review faults first should run `jolli doctor` (without `--fix`).
- **Faults the user must resolve manually.** Missing credentials (`Config` probe), high active queue (`Git queue` probe), and an empty dist-paths registry all require user action and are deliberately not auto-fixed. They will continue to appear on subsequent `doctor` runs until resolved.
- **A successfully applied fixer is assumed to have repaired its fault.** The doctor does not re-run the probe after the fix; the exit-code computation trusts that a returned-without-throwing fixer succeeded.
- **The hook re-install fixer is the same install action as `jolli enable`.** It is the only fixer that performs more than one filesystem mutation; on partial success the underlying installer's error message is what surfaces.
- **A failing OAuth or `--fix` over a read-only filesystem yields exit `1`.** Since the affected fixer threw, the failure is counted.
- **A manual disable makes the Git-hooks probe report `ok`, not `fail`.** `--fix` treats an active repo-wide opt-out (spec 145) as healthy.
- **The reinstall fixer honours the opt-out too, which makes one narrow outcome possible: a reported success that installed nothing.** In normal operation the probe already returns `ok`-with-no-fixer whenever the opt-out is set, so the fixer never runs against a disabled repository. But if the flag is flipped between the probe's read and the fixer's run, the install returns *success* with a message saying the repository remains manually disabled — so the fixer does not throw and `--fix` prints `✓ Git hooks: reinstalled` while nothing was actually installed. This is a deliberate belt-and-braces guard against a concurrent disable, not a routine gate.
- **Neither of the two credential-shaped faults has a fixer, and that boundary is intentional.** Missing credentials and an unusable local agent CLI both require choosing a provider or typing a key — which an unattended repair pass must not do on the user's behalf. The interactive repair ladder (spec 291) is the counterpart surface that repairs exactly these two faults, and it is never invoked from `doctor`.

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- The probes, their order, the verdict labels, and the diagnostic-line format are all identical to the diagnostic-only mode (spec 59).
- The `--fix` flag does not affect which probes run; it only controls whether the fix loop runs after them.
