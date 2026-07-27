# npm Runner

## Topic Statement

A small wrapper around the npm package manager that runs install, build, dev-server, and static-serve commands inside the staged project build directory and reports back a success flag with the captured output.

## Scope

**In scope:**
- The four operations the wrapper exposes (install, build, dev, serve).
- Where each operation runs (current working directory bound to the build directory).
- Output capture and how it differs between batch operations and long-running server processes.
- The return contract — a success flag, captured output, and (for servers) an extracted localhost URL.
- Platform handling for the package manager's `.cmd`-shaped scripts on Windows.
- The pre-install gate that delegates to the shared site engine instead of running install directly per project.

**Out of scope:**
- The shared site engine itself (covered by its own topic).
- The output filter that surfaces only relevant lines from server processes (covered by its own topic).
- The build artifact layout the build operation produces.
- The npm package manager's own internals.

## Data Contracts

### Run result

A small record returned by every operation:

- **success** (required, boolean): true if the underlying process exited zero (or, for long-running processes, terminated cleanly or was canceled with a null exit code).
- **output** (required, string): the captured combined stdout and stderr for batch operations. For long-running server processes that pipe through a filter, this field is empty (the filter has already routed lines to the parent stdout/stderr).

### Server result

Extends the run result with one additional field:

- **url** (optional, string): the first localhost URL the filter saw on the process's output, captured for display.

### Operation list

The wrapper exposes exactly four operations:

- **install** (`npm install` against the shared engine, plus a project-side symlink).
- **build** (`npm run build`).
- **dev** (`npm run dev`).
- **serve** (`npx serve out`).

## Behavior

### Install

The install operation does not invoke the package manager directly inside the project build directory. Instead it:

1. Delegates to the shared engine bootstrap to install or refresh the user-wide engine directory.
2. If the engine bootstrap reports failure, return failure with the engine's captured output (or a generic message if the engine returned no output).
3. Otherwise create or replace the project's `node_modules` symlink pointing at the engine's installed dependencies.
4. Return success with empty output.

### Needs-install gate

A separate query reports whether the install step would do work:

- True if the shared engine reports itself stale or absent.
- True if the project's `node_modules` does not exist.
- False otherwise.

This lets the caller skip the install operation when nothing is needed.

### Build

1. Run `npm run build` with the working directory set to the build directory. Capture both standard streams.
2. Concatenate standard output and standard error into a single output string (each present stream contributes one block, joined with a newline).
3. Return success-true on exit code zero, success-false on any non-zero exit. The captured output is returned in both cases.

### Dev

1. Spawn `npm run dev` in the build directory as a long-running process with both standard streams piped.
2. Hand each chunk of output to the output filter (default mode unless the verbose flag is set).
3. The filter routes lines to the parent stdout/stderr per its own rules; nothing is buffered in the result's `output` field.
4. The process is allowed to run until it terminates of its own accord.
5. On termination, resolve with success-true if the exit code is zero or null (a null code indicates the process was canceled by signal). Resolve with success-false on any other exit code. Attach the localhost URL the filter extracted, if any.
6. On spawn error, resolve with success-false and the error message in the output field; URL absent.

### Serve

Same shape as Dev, but the spawned command is `npx serve out` (the static-serve runner targeted at the build's static-export output directory).

## Notable Behavior

### Working directory binding

Every operation runs with the spawned process's current working directory set to the build directory the caller passed in. The wrapper never reads or writes outside that directory other than to follow the engine symlink.

### Combined output for batch operations

For install (when the engine bootstrap returns text), build, and any failure path, stdout and stderr are coerced to strings, filtered for emptiness, and joined with a newline so the caller has a single string to print or stash. Empty streams are omitted from the join — a no-stderr build returns just stdout, not stdout-plus-trailing-newline.

### Filtered streaming for long-running processes

Dev and serve run as long-running processes whose output is far too large to buffer. Each output chunk is fed to the output filter as it arrives; the filter is responsible for suppressing framework noise and surfacing only the localhost URL plus error lines. The resulting run result has an empty output string by design — the filter has already done the user-visible work.

### URL extraction is filter-driven

The wrapper does not parse for URLs itself. It asks the filter for the URL it saw after the process closes. The filter pulls the first localhost URL it encounters and remembers it across subsequent chunks; that's what gets attached to the server result.

### Null exit code is success

When a long-running process is terminated by signal (e.g. the user hit `Ctrl-C` to stop the dev server) the platform reports a null exit code. The wrapper treats this as success because the user explicitly ended the run and there is nothing to surface as an error.

### Spawn-error path is distinct from non-zero exit

A failure to spawn the process (binary not on PATH, permission denied, etc.) lands in the spawn-error handler and produces a success-false result with the error's message in the output field. This is distinct from a successfully-spawned process that later exits non-zero, where the output field stays empty (the filter handled it).

### Windows command-shape handling

The package manager and its companion runner ship on Windows as batch scripts (`.cmd`). The hardened child-process API the wrapper uses refuses to run those without a shell wrapper. The wrapper therefore:

- Sets the shell-mode option on every spawn on Windows.
- Joins the command and its arguments into a single string when shell mode is active, leaving the arguments array empty, to sidestep a deprecation warning that fires when both shell mode and a separate arguments array are passed.

On non-Windows platforms the spawn proceeds with the command and arguments separated and shell mode off.

### Capture mode is `pipe`, not inherit

All four operations use piped standard streams so the wrapper retains the option of filtering or transforming the output. Inherited streams would bypass the filter entirely.

## Shared Behavior

- **Shared site engine** — pre-installed dependency directory the install operation hands off to.
- **Output filter** — consumes the long-running processes' streams and decides what reaches the user.
- **Build directory layout** — the staged project the wrapper runs inside; produced by upstream rendering.
- **Static-export output directory** — the directory the build operation populates and the serve operation reads from.
