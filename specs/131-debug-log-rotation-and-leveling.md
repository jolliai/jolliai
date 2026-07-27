# Debug Log Rotation and Leveling

## Topic Statement

A persistent debug log under the per-user state directory that every Jolli Memory process writes to in shared sequential order, with size-based archive rotation that preserves history across a bounded number of timestamped archive files, an `info`/`debug`/`warn`/`error` level model whose threshold is configurable per process and per module, a hard skip when running under a known test environment variable, a level-conditional mirror to the standard error stream, and silent failure on any permission or filesystem error.

## Scope

**In scope:**
- The on-disk log file path under the per-project state directory and its name.
- The one-line-per-record text format (ISO-8601 timestamp, fixed-width level tag, bracketed module name, message body) and the printf-style placeholder substitution (`%s`, `%d`, `%j`).
- The four-level model (`debug`, `info`, `warn`, `error`) and its numeric priorities.
- The two-tier filter: a process-wide global level plus an optional per-module override map.
- The 2 MB rotation rule and the archive-and-restart behavior that renames the live file to a timestamped archive and starts a fresh `debug.log`.
- The archive naming scheme (`debug_<UTC-timestamp>.log`), same-second collision handling, and the maximum-10-archives pruning rule.
- The serialization that guarantees every record appended by the same process lands in the file in submission order.
- The test-mode skip: when running under a recognised test runner's environment variable, no file write happens at all.
- The `console.error` / `console.warn` mirror behavior that depends on the level and the silent-console flag.
- The fail-silent guarantee: missing directory, permission errors, disk-full, etc. never throw and never crash the calling process.
- The "do not auto-create the state directory" rule: log writes are skipped when the state directory is absent.

**Out of scope:**
- The state directory's own creation policy (owned by the install / enable spec).
- Cross-process ordering when two different processes write at the same instant (each process serializes its own writes; interleaving between processes is not specified).
- Log forwarding to any remote sink — this spec is local-only.
- Specific module names that callers pass in.
- Archive content — what is stored inside each rotated archive file is out of scope (each archive is the full prior `debug.log`).
- The exact disk layout of archive files beyond the naming and pruning rules documented here.

## Data Contracts

### Log file location

The log file lives at:

```
<project-state-dir>/debug.log
```

`<project-state-dir>` resolves to `<cwd>/.jolli/jollimemory`, where `<cwd>` is the working directory the process configured at startup (entry points pass the resolved project root explicitly; otherwise it falls back to the OS-level current working directory).

If `<project-state-dir>` does not exist on disk, the log writes are skipped — the directory is **not** created just for logging. The directory is created by the install/enable flow when the project is first enabled.

### Record format

Each log record is exactly one line:

```
[<ISO-8601 timestamp>] <LEVEL> [<module>][trace=<id>] <message>
```

The `[trace=<id>]` segment is present only when an ambient trace identifier is set in the calling process; it is omitted entirely when there is no active trace. The format with no trace is:

```
[<ISO-8601 timestamp>] <LEVEL> [<module>] <message>
```

Where:

| Token | Source |
| --- | --- |
| `<ISO-8601 timestamp>` | UTC timestamp at the moment the record was formatted, with millisecond precision. |
| `<LEVEL>` | Uppercase level name padded to 5 characters: `DEBUG`, `INFO `, `WARN `, `ERROR`. |
| `<module>` | The module tag the calling logger was created with, surrounded by square brackets. |
| `[trace=<id>]` | Optional. Present when a W3C trace identifier is active at record-formation time; omitted otherwise. Appears immediately after the module tag with a leading space. |
| `<message>` | The caller's message string with `%s`, `%d`, `%j` placeholders substituted from the variadic arguments (`%d` coerces to a number; `%j` JSON-stringifies; `%s` calls `String(arg)`). Unsubstituted placeholders are left intact. |

A trailing newline is always appended on write. The record never contains an embedded newline (callers are expected to emit one record per call).

### Level model

Four levels with these numeric priorities:

| Level   | Priority |
| ------- | -------- |
| `debug` | 0        |
| `info`  | 1        |
| `warn`  | 2        |
| `error` | 3        |

A record is written to the file only when its level's priority is greater than or equal to the threshold. Threshold is:

1. The per-module override for the record's module, if one is set, **otherwise**
2. The process-wide global level.

Default global level is `info`. Default per-module overrides is the empty map.

### Test-mode skip

When either the environment variable `VITEST` or `JOLLI_DISABLE_LOG_FILE` is set (truthy) in the calling process, `debug.log` writes are skipped entirely. This applies to the file write only — the level filter and the standard-error mirror still run.

`VITEST` covers test runs driven by the test runner. `JOLLI_DISABLE_LOG_FILE` is for non-test-runner contexts (for example, a subprocess that imports the built bundle as a probe) where the caller still needs to suppress file output. Either variable alone is sufficient; both are checked.

### Silent-console flag

A process-wide boolean (default `true`) controls whether `info` and `debug` records are mirrored to standard error. `warn` and `error` are always mirrored regardless of this flag. The flag exists so the CLI can stay quiet on stdout/stderr while still writing the full record to the file.

Mirror destinations:

| Level   | When silent-console is true | When silent-console is false |
| ------- | --------------------------- | ---------------------------- |
| `debug` | not mirrored                | written to `console.error`   |
| `info`  | not mirrored                | written to `console.error`   |
| `warn`  | written to `console.warn`   | written to `console.warn`    |
| `error` | written to `console.error`  | written to `console.error`   |

The mirror runs the formatted record through the standard-error stream verbatim — the same string that goes to the file.

### Rotation rule

Before each append, the current file size is checked. If the file is larger than **2 MB** (`2 * 1024 * 1024` bytes), the live `debug.log` is renamed to a timestamped archive file and `appendFile` then recreates a fresh `debug.log` starting with the new record. The previous content is fully preserved in the archive — nothing is truncated or dropped.

#### Archive naming

The archive name has the form:

```
debug_YYYY-MM-DD_HH-mm-ss.log
```

The timestamp is UTC (matching the timestamps in log lines). Colons and dots are avoided so the name is valid on all platforms. The fixed-width format means a plain lexical sort is chronological.

On same-second collision (two rotations within the same UTC second), a `_<N>` integer suffix is appended to make the name unique, for example `debug_2025-01-15_09-24-32_1.log`. The underscore (`_`) sorts after `.` in the archive name, so a suffixed archive always sorts after its base, preserving the lexical-is-chronological property.

#### Archive pruning

After each rotation, the archive directory is scanned. If more than **10** archives exist, the oldest ones (by lexical sort) are deleted until exactly 10 remain. A pruning failure is swallowed — pruning retries on the next rotation.

#### Best-effort guarantees

Rotation is best-effort:

- A failed rename (for example, another process already rotated the same second) is swallowed; `appendFile` still recreates `debug.log`.
- There is no cross-process lock. Two processes rotating within the same second may collide on the archive name; one rename may overwrite the other's archive. This race is accepted — losing one rotated archive never affects correctness of the live log.

## Behavior

### Logger creation

A caller creates a logger by passing in a module name. The returned logger exposes `debug`, `info`, `warn`, and `error` methods. Each method takes a message string and an optional list of variadic arguments for `%s`/`%d`/`%j` substitution.

### Per-record flow

For every method call, this sequence runs synchronously up to the file enqueue:

1. The arguments are formatted into a single record line using the format above.
2. The standard-error mirror runs (level-conditional, silent-console-conditional).
3. The level filter is applied with the module's effective threshold. If the record fails the filter, the file write is skipped — but the standard-error mirror has already happened.
4. If the record passes the filter, it is enqueued for sequential file writing.

### Sequential write queue

The process maintains a single in-flight promise chain. Each enqueued record waits for the previous record's write to complete before its own append begins. This guarantees that records appended by the same process land in the file in the exact order their methods were called, even when callers fire records in tight loops or from different async contexts.

The chain never rejects to its caller — write failures are caught inside the queue. The loggers' methods do not return promises and have no way to surface a write failure.

### Rotation execution

Inside the queued write:

1. The file's current size is sampled. If the file does not exist, no rotation runs and the append creates a new file.
2. If the size exceeds 2 MB, the live `debug.log` is renamed to a timestamped archive file. The archive naming and pruning rules described in the Data Contracts section apply. A failed rename is swallowed; the append step below will recreate `debug.log`.
3. The new record is then appended. This append (re)creates `debug.log` when the rename succeeded or when the file did not previously exist.

After rotation the live `debug.log` begins fresh with the triggering record as its first line; the full prior content is in the archive.

### Test-mode short-circuit

When either `VITEST` or `JOLLI_DISABLE_LOG_FILE` is truthy in the process environment, the file enqueue is bypassed entirely — the queue chain is not extended, no stat runs, and no append runs. Standard-error mirroring still runs because it sits earlier in the per-record flow.

### Fail-silent guarantee

Inside the queued write, the entire body is wrapped so any thrown error is swallowed:

- `stat` on the state directory: if it throws (e.g. directory missing), the write is skipped silently.
- `stat` on the log file: if it throws (e.g. file missing), no rotation runs; the append falls through and creates the file.
- `rename` (rotation): if it throws, the rotation is skipped; the append below still (re)creates `debug.log`.
- Archive pruning: if the directory scan or any archive deletion throws, the error is swallowed silently.
- `appendFile`: if it throws, the error is swallowed silently.

The contract is that calling a logger method must never propagate an error to the caller. Logging is best-effort.

### Configuration injection

Two process-wide setters control the filter:

| Setter | Effect |
| ------ | ------ |
| Global level | Sets the new floor for records whose module has no override. |
| Module overrides | Replaces the entire per-module override map (not merged). |

Both are set once by entry points after they load the project's saved config. There is no per-call level override.

A third setter controls the silent-console flag. Entry points configure it once depending on whether they expect to print to a terminal (`false` for the interactive CLI; `true` for hooks and background scripts).

### Working-directory injection

A fourth setter sets the global working directory the log file path resolves against. Entry points set this once at startup after resolving the project root from arguments, env, or stdin. If unset, the path resolves against the OS-level current working directory of the process.

## State Transitions

```
[process starts]
  global level = "info"
  module overrides = {}
  silent-console = true
  log dir cwd = unset (falls back to process.cwd())
  write queue = empty resolved promise

[entry point runs]
  setLogDir(resolved project root)
  loadConfig() → setLogLevel(level, overrides)
  setSilentConsole(false) for CLI; (true) for hooks

[caller calls logger.<level>(message, ...args)]
  format record
  if level allows mirror → write to console.error / console.warn
  if level passes filter for module:
    if VITEST or JOLLI_DISABLE_LOG_FILE → skip file write
    else → append to write queue chain

[write queue runs an entry]
  stat(state-dir) — if throws, return silently
  stat(log-file) — if size > 2 MB → rename to debug_<UTC-timestamp>.log, prune old archives
  appendFile(record + "\n") — if throws, return silently

[entry point exits]
  in-flight queue entries continue to drain in the background
```

## Notable Behavior

- **Logging never creates the state directory.** A process that runs in a project where Jolli Memory is not enabled produces no log file. This is intentional: it prevents logger calls from leaving traces in arbitrary repositories.
- **Rotation archives the previous content entirely.** The live `debug.log` is renamed to a timestamped archive; no content is dropped. The 2 MB ceiling triggers the rename; up to 10 archives are kept on disk (oldest pruned). Disk usage for a single project's log is therefore bounded at roughly 10 × 2 MB = 20 MB plus the current live file.
- **Per-module overrides are absolute, not additive.** A module override fully replaces the global level for that module — a module can be made noisier or quieter than the global default.
- **The standard-error mirror runs before the level filter.** A `warn` is always written to standard error even if the global level is set to `error` (the filter only suppresses the file write, not the mirror). Conversely, a `debug` with silent-console true and global level `info` is suppressed everywhere — neither the mirror nor the file gets it.
- **The per-process write queue does not coordinate with other processes.** Two processes writing concurrently to the same log file rely on the operating system's append-mode semantics. Same-process ordering is guaranteed; cross-process interleaving is not.
- **`console.error` is the default mirror channel.** Even `info` and `debug` records (when silent-console is false) go to standard error, not standard out — this keeps standard out clean for command output, JSON, etc.
- **The IntelliJ surface uses a daemon thread instead of a promise chain.** The contract is identical (sequential ordering, fail-silent, 2 MB archive rotation, no directory auto-create, ISO timestamp, padded level tag, module brackets, printf placeholders) — the implementation difference is invisible to consumers of the log file.
- **The format-string placeholders are intentionally limited to three.** `%s`, `%d`, `%j` cover stringification, numeric coercion, and JSON serialization. There is no `%o`, no width specifier, no precision specifier. An unsubstituted placeholder is left as-is.
- **Calling a logger method on a freshly imported module is safe.** Defaults (`info`, no overrides, silent console, fallback cwd) make every method usable before any setter has been called.

## Shared Behavior

- **State directory creation** — owned by the install / enable flow; logging never auto-creates it.
- **Project working-directory resolution** — owned by each entry point; logging only stores the resolved value.
- **Saved config (level + overrides)** — read by entry points at startup; logging only applies the values they pass in.
- **Standard-error stream** — the destination for every mirror, level-conditional via silent-console.
- **Test runner detection** — owned by the test-runner's own environment variable (`VITEST`) and the explicit suppression flag (`JOLLI_DISABLE_LOG_FILE`); logging checks both.
