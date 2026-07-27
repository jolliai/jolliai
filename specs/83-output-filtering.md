# Output Filtering

## Topic Statement

A streaming filter that consumes child-process output line by line and, in default mode, suppresses framework noise while surfacing only the localhost URL the server bound to and any error-shaped lines, with a verbose pass-through mode that disables the suppression entirely.

## Scope

**In scope:**
- The two modes (default filter mode versus verbose pass-through mode) and how the caller selects between them.
- The suppression list — the patterns that are unconditionally hidden in default mode.
- The error list — the patterns that get printed to the parent's standard error in default mode.
- URL extraction from the first line that contains a localhost URL, and the once-per-process display rule.
- Line splitting, ANSI-escape stripping prior to matching, and blank-line handling.
- The output destinations: parent stdout for the URL banner, parent stderr for matched errors.

**Out of scope:**
- The processes whose streams feed the filter (covered by the npm-runner topic).
- Any framework-specific build/dev semantics — patterns are matched by surface text, not parsed structurally.
- Logging frameworks beyond the simple stdout/stderr writes the filter performs.
- Localization of error or URL strings — patterns are English-only, matching the underlying tools' default output.

## Data Contracts

### Construction input

The filter is built from a single boolean:

- **verbose flag** (required, boolean): true selects pass-through mode, false selects default filter mode.

### Filter handle

The factory returns a small handle exposing two operations:

- **write** (synchronous): accepts a chunk of output (a string or buffer that has been coerced to a string upstream) and processes its contained lines. Returns true.
- **getUrl**: returns the localhost URL the filter has captured so far, or `undefined` if none has been seen.

### Per-instance state

Across a single filter's lifetime:

- **url** — the first localhost URL the filter ever saw, persisted for reporting.
- **url printed flag** — true after the URL banner has been written, so it is never written twice.

### Suppression patterns

A fixed set of regular expressions matching lines that are unconditionally hidden in default mode. The set covers:

- Configuration-property deprecation messages from the underlying framework.
- Framework type-checking notices and tsconfig adjustment notes ("We detected TypeScript", "noEmit was set", "include was updated", etc.).
- Package-manager warnings, notices, audit-fix suggestions, funding banners, vulnerability counts.
- Compilation lifecycle lines ("Compiling /...", "Compiled /...", "Starting...", "Ready in ...").
- Version-stamp lines from the underlying framework.
- Hot-reload internals and fast-refresh status messages.
- Dependency-resolution noise (peer-dependency conflicts, override notices).
- Bare path mentions of the dependency-install directory.
- Empty / whitespace-only lines.

### Error patterns

A small fixed set of regular expressions whose matches are printed to the parent's stderr in default mode. The set includes:

- The framework's red-cross failure glyph.
- HTTP 500 markers in request log lines.
- Module-not-found errors.
- "Build error" markers.
- A generic "Error:" prefix.
- "Failed to compile" markers.

### URL pattern

A single regular expression matching a localhost URL with optional port and optional protocol scheme — used to extract the address the dev or serve process is listening on.

## Behavior

### Per-write processing

For each call to write:

1. Coerce the input to a string and split on newlines into candidate lines.
2. For each line:
   a. Strip ANSI escape sequences from the line and trim whitespace; this is the matching surface ("trimmed").
   b. If the trimmed line is empty, skip the rest of the per-line steps for this line.
   c. Run the URL extractor against the trimmed line. If it matches and no URL has been printed yet:
      - Stash the matched URL in the per-instance state.
      - In default mode only, print a one-line banner to the parent's stdout: two leading spaces, the literal text "Server running at ", the matched URL, and a newline.
      - Set the URL-printed flag so this banner is never written again, even if the URL appears on subsequent lines.
   d. If the verbose flag is set, write the original (un-trimmed, ANSI-bearing) line to the parent's stdout with a trailing newline, and continue to the next line.
   e. Otherwise (default mode):
      - If any suppression pattern matches the trimmed line, drop the line silently.
      - Otherwise if any error pattern matches the trimmed line, write two leading spaces plus the trimmed line to the parent's stderr with a trailing newline.
      - Otherwise drop the line silently — only matched errors and the once-emitted URL banner are surfaced in default mode.
3. Return true.

### URL retrieval

The handle's `getUrl` method returns whatever URL the filter has captured to date. The npm runner uses this after the spawned process closes to attach the URL to its result so the caller can present it in a final summary.

## State Transitions

The URL-print flag transitions exactly once per filter lifetime:

- **Not yet seen** → **Seen + printed (default mode) / Seen but not printed (verbose mode)** when the first localhost-matching line arrives.

In verbose mode the URL is captured but no banner is printed because the original line is already in the verbose pass-through.

## Notable Behavior

### Suppression precedes error matching

A line that would match an error pattern but also matches a suppression pattern is suppressed. The suppression list is consulted first; only lines that survive it are evaluated against the error list. This is intentional — some framework-internal warnings include the word "Error" but are noise, not actual errors.

### Verbose mode is a complete bypass

In verbose mode, no suppression and no error matching runs. Every non-empty input line, including ANSI escape sequences, is written verbatim to the parent's stdout. The only filter-mode behavior preserved in verbose mode is URL capture into the per-instance state — but the banner is not emitted because the original "ready" line is already passing through.

### URL banner format

The banner is written exactly once per filter lifetime to the parent's stdout, with two leading spaces and the form `  Server running at <url>`. This matches the indentation convention used by the surrounding CLI for status lines.

### Errors go to stderr, banner goes to stdout

Errors are written to the parent's standard error with two leading spaces and a newline; the URL banner is written to the parent's standard output. This separation means an automation that pipes the wrapper's stdout into a log and stderr into an alert still sees the right things on the right streams.

### ANSI escape stripping is matching-only

The matching surface for both suppression and error patterns is the ANSI-stripped, trimmed line. The original line, with its escapes intact, is what verbose mode emits. Default-mode error output uses the trimmed (ANSI-stripped) form to avoid leaking control sequences into the indented error rendering.

### Empty-line handling

Lines that are empty after ANSI-strip and trim are dropped before any pattern matching runs, so the suppression list does not need to match the empty-string explicitly (although it does, defensively, as a redundancy guard).

### URL match looks for `localhost`

The URL pattern matches `http://localhost` or `https://localhost` with optional port. URLs bound to a non-loopback address (the user has explicitly configured a host binding) are not captured. This matches the dev-server's typical default of localhost-only binding.

### Once-per-instance URL capture

Once the URL has been captured, subsequent localhost mentions are not re-captured and do not re-print the banner. A dev-server that re-prints its address (e.g. on rebuild) does not produce duplicate banners.

### Pattern lists are not user-extensible

The suppression and error patterns are baked into the filter at construction time. Callers do not pass additional patterns; the verbose flag is the only knob that changes filtering behavior.

## Shared Behavior

- **npm runner** — feeds output chunks into the filter for dev and serve operations and reads the captured URL after the process closes.
- **Build output directory** — populated by build operations whose output bypasses the filter (build is a batch operation that returns full output, not a streamed long-running process).
- **CLI status reporting** — the URL banner format mirrors other status lines emitted around the same operation.
