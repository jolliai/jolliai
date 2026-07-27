# 240. CLI queue-status Command

## Topic Statement

A command-line subcommand that reports — or, with a wait flag, blocks on — the queue-status "drained" verdict for the current worktree, emitting either a stable machine-readable JSON object or a single human-readable one-line message, and always exiting cleanly (non-zero only on failure) rather than throwing.

## Scope

**In scope:**

- The subcommand name and one-line description.
- Every flag it registers and each flag's default.
- How the wait flag selects between a one-shot status read and a bounded wait.
- How the timeout flag (in seconds) is parsed and hardened before being handed to the wait.
- The two output modes (machine JSON and default human one-liner) and exactly what each emits on success.
- The stable JSON success shape, including the always-present discriminator and the always-present waited field.
- The three-way human message selection.
- The error envelope per output mode and the exit-code contract.

**Boundaries:**

- The status/verdict semantics — what "drained" means, the three sampled signals, the ingest exclusion, the wait loop's poll/timeout/non-overshoot behavior and its own input hardening — are owned by **queue-status computation** (spec 218). This command is a thin wrapper that calls that read or that wait and formats the result.
- The PR-building skill that polls this command as a wait-gate fallback (for hosts without the programmatic tool) is owned by the PR-skill content spec; referenced here only as the primary caller.
- The programmatic (MCP) tool that wraps the same status read/wait is a sibling co-consumer owned by spec 148, not by this command.
- The shared project-directory resolution default and log-directory pointing are shared command-line utilities consumed here as black boxes.

## Data Contracts

### Subcommand identity

- Name: `queue-status`.
- One-line description (shown in help): reports whether memory-summary generation is still in progress, intended for skill/agent consumption.

### Flags

| Flag | Argument | Default | Meaning |
| --- | --- | --- | --- |
| Wait toggle | (boolean) | Off | Block until the queue drains or the timeout elapses, instead of returning the current status immediately. |
| Timeout | A number of **seconds** | Unset (the wait then uses its own default of 120 s) | Maximum time to wait when the wait toggle is set. |
| Format | An enumerated value; only `json` is accepted | Unset (= default human mode) | Output-format selector. `json` is the only accepted value; any other value is rejected by the argument parser before the action runs. |
| Project directory | A directory path | The resolved git repository root | The worktree whose queue status is reported. |

### Timeout parsing and hardening

If the timeout flag is present, its value is converted from seconds to milliseconds **only when** it is a finite, non-negative number; otherwise it is dropped to "unset" so the wait applies its own default. (A non-finite value must not reach the wait as a live number — see the hot-spin hazard owned by spec 218. This is a local guard in addition to the wait's own choke-point hardening.) If the timeout flag is absent, no timeout is passed and the wait uses its default.

### Success output — machine JSON mode

A single-line JSON object with a stable, type-tagged shape:

- A `type` discriminator set to the literal `"status"` (mirroring the `"error"` discriminator on the failure payload and the repo's other JSON unions).
- Every field of the status object (spec 218): the active count, the ingest-active count, the worker-busy flag, the worker-blocking flag, the drained flag, and the stale count. (Per spec 218 the worker-blocking flag now always equals worker-busy — both are the raw held state of the summary-drain lock, since topic-KB ingest runs under a separate lock and no longer factors into a "phase" distinction. Both fields are emitted for shape stability.)
- A **waited (ms)** field that is **always present**: the elapsed wait when the wait toggle was set, or **0** when it was not. This makes the field a stable, always-present discriminator so a consumer never has to branch on which flags were passed.

### Success output — default human mode

A single short line (padded with surrounding blank lines), chosen three ways from the status:

| Condition | Message (semantic) |
| --- | --- |
| `drained` is true | Memory generation is idle / the queue is drained. |
| Not drained, but the active count is 0 | The worker is finishing the last memory summary (queue empty but a summary is still being written). |
| Not drained, active count > 0 | N memory summaries are still generating (N = the active count). |

The middle case exists because "active == 0 but not drained" means the worker is blocking-busy wrapping up the final summary — reporting "0 generating" would be misleading.

### Error output

| Mode | Output | Exit code |
| --- | --- | --- |
| JSON | A single-line `{ "type": "error", "message": <text> }` on standard output. | non-zero |
| Human | `Error: <text>` on standard error (padded with blank lines). | non-zero |

Any thrown value is caught inside the action, converted to its message string (an Error yields its message; anything else is string-coerced), emitted in the active output mode, and the process exit code is set non-zero. The action never throws out of itself.

### Exit codes

- Success: exit code left at its default (zero).
- Any failure: exit code set non-zero (regardless of output mode, so pipelines/CI detect it even when JSON was requested).

## Behavior (execution order)

1. Resolve the project-directory option (defaulting to the git repo root) and point logging at it.
2. Parse the timeout flag: if present, convert seconds→milliseconds only when finite and non-negative, else treat as unset.
3. Dispatch:
   - If the wait toggle is set → run the bounded wait (spec 218) with the parsed timeout (or its default), yielding a status-plus-waited result.
   - Otherwise → take a one-shot status read (spec 218), yielding a status with no waited field.
4. Format success:
   - JSON mode → emit the type-tagged status object, filling the waited field from the result when present, else 0.
   - Human mode → emit the one-line message chosen by the drained / active-zero / active-positive three-way above.
5. On any thrown error → emit the error envelope in the active mode and set the exit code non-zero.

## State Transitions

Single-shot and stateless across runs. Within one run the only state is the process exit code, which moves from its default (success) to non-zero on the first failure. With the wait toggle, the run additionally observes the external drained transition over time (owned by spec 218), but persists nothing.

## Notable Behavior

- **The waited field is always present, even without the wait flag.** In a one-shot read it is 0. Consumers key on it unconditionally rather than branching on whether the wait flag was passed. (Notable; contract-stability.)
- **The `type` discriminator is present on both success and failure.** Success carries `"status"`, failure carries `"error"` — a consumer can dispatch on `type` alone. (Notable.)
- **"active == 0 but not drained" gets its own message.** The worker is finishing the last summary; the command deliberately does not say "0 still generating." (Notable; UX.)
- **The command guards the timeout itself and the wait guards it again.** Both layers reject a non-finite/negative value; the command's guard falls back to "unset" so the wait's own default applies. Belt-and-suspenders against the hot-spin hazard. (Notable; defensive.)
- **Only `json` is an accepted format value**; any other value is rejected by the argument parser before the action runs. (Notable.)
- **Every failure sets a non-zero exit code in both output modes** so pipelines and CI detect it regardless of the requested format. (Notable.)
- **The action never throws.** All errors are caught, formatted, and turned into an exit code — the process always exits through the normal path. (Notable.)

## Shared Behavior

- The status object's fields, the "drained" verdict, the ingest exclusion, and the bounded-wait poll/timeout/non-overshoot semantics (including its own input hardening) are owned by **queue-status computation** (spec 218).
- The programmatic (MCP) tool that reports/blocks on the same verdict is owned by spec 148; it is a sibling co-consumer of the same underlying read and wait.
- The PR-building skill that polls this command as a wait-gate fallback is owned by the PR-skill content spec.
- The project-directory resolution default and the log-directory pointing are shared command-line utilities consumed here as black boxes.
