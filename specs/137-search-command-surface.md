# 137. `jolli search` — Search subcommand surface

## Topic Statement

The search subcommand assembles a query (from positional words or from standard input), validates it, runs a single-phase relevance search, and emits the resulting hit list on a stream or a file under a structured or human-readable format.

## Scope

**In scope:** the invocation form of the search subcommand — how positional arguments are assembled into a query string, the standard-input bridge that supplies the query instead, the full set of accepted flags and their validation rules, the query deny-list and the single path on which it is applied, which output stream carries results and errors under each format mode, how file output is handled, and exit-code policy.

**Boundaries:**

- The single-phase search pipeline spec owns the required-query guard, the storage-backend establishment, the index open/cache, and the `{ hits }` response shape.
- The local search index spec owns the ranking algorithm and the index format.
- The search-skill content spec owns the skill-template format that consumes the structured-payload response and drives the standard-input bridge.

## Data Contracts

### Query string

The query is assembled from one of two mutually exclusive sources:

- **Positional words** — the positional arguments are joined with single spaces into a single query string. An empty list of positional words produces an empty query string.
- **Standard input** — when the stdin flag is set, the query is read from standard input instead, and supplying positional words alongside it is rejected.

After assembly from either source, the query must be non-empty after trimming; an empty or whitespace-only query is rejected as an invalid-input error.

### Flag inputs

| Flag | Accepted values | Default | Rejection conditions |
|------|----------------|---------|----------------------|
| Limit | Positive integer | Unset (the engine's own default, documented as 20, applies) | Non-positive or non-finite values are silently treated as unset |
| Branch | Branch name string | Unset | — |
| Kind | One of two enumerated values: topic-kind or commit-kind | Unset | Any other value is rejected by the argument parser before the action runs |
| Format | One of two enumerated values: structured-payload or human-readable plaintext | Structured-payload | Any other value is rejected by the argument parser before the action runs |
| Output path | File path string | Unset | — |
| Standard-input query | Boolean flag | Off | Setting it together with positional words is rejected |
| Working-directory override | Directory path string | Cached project-root resolution (see Behavior) | — |

There is **no** recency flag, **no** token-budget flag, and **no** hash-list flag on this surface.

### Response envelopes (abstract)

- **Success**: a `{ hits }` object whose field details are owned by the single-phase search pipeline spec.
- **Error of any kind**: an error envelope containing a kind discriminator and a human-readable message string.

### Output-path confirmation line

When the output-path flag is set and the write succeeds, a single confirmation line is printed to stdout naming the path that was written.

## Behavior

### Invocation forms

- `jolli search <terms…>` — terms joined by single spaces into the query string, single-phase search.
- `jolli search --arg-stdin` — the query is read from standard input (the path the search skill's here-doc bridge uses); positional words must not be supplied.
- Any form combined with `--limit`, `--branch`, `--type`, `--format`, `--output`, `--cwd`.

### Action order

1. Resolve the working directory (the cached value, or the `--cwd` override for this invocation).
2. Initialize the rolling debug-log facility under the resolved working directory. This is unconditional and happens even when later validation will reject the input.
3. Establish the configured storage backend for the working directory as the process-wide active storage, before any read. This mirrors the in-process tool surface so the command-line fallback indexes the same store as the tool and returns identical results.
4. If the stdin flag is set and positional words were also supplied, raise a mutual-exclusion invalid-input error and stop.
5. Assemble the query — from standard input when the stdin flag is set, otherwise from the joined positional words.
6. If the query is empty or whitespace-only, raise an invalid-input error and stop.
7. Apply the query deny-list **only when the stdin flag is set** (see below).
8. Run the single-phase search and emit the `{ hits }` result.

### Query deny-list validation (stdin path only)

The query deny-list is applied **only on the standard-input path** — the only path where the query is interpolated into a shell here-doc by the consuming skill. Rejected characters are: backslash, backtick, dollar sign, double-quote, and control characters. A direct positional-argument query is **not** deny-listed, because that query never re-enters a shell and flows solely into the in-process index; deny-listing it would reject characters the in-process tool surface accepts and break the documented "command-line fallback === in-process primary" parity. A deny-list hit on the stdin path produces an invalid-input error using the standard error path for the active format.

### Working-directory resolution

The working-directory value used by the action is resolved once at command-registration time — not per invocation. The resolution attempts to locate the enclosing project root; if that resolution fails, it falls back to the process's current working directory at registration time. The `--cwd` override replaces this cached value for the invocation in which it is supplied.

### File output

When the output-path flag is set:

1. If the dirname of the given path is not the current directory, the parent directory hierarchy is created recursively before writing.
2. The full response body (structured-payload or plaintext) is written to the path.
3. A confirmation line naming the written path is printed to stdout.
4. Nothing else is written to stdout.

Failure to create the parent directory or to write the file falls through to the standard error path.

### Plaintext rendering

Under the human-readable plaintext format, the hit list is rendered as one line per hit (hash, branch, date, title). An empty hit list renders as a single placeholder line indicating no hits matched.

### Stream assignment

| Condition | Format | Output stream |
|-----------|--------|---------------|
| Successful response | Structured-payload | Stdout, followed by a trailing newline |
| Successful response | Human-readable plaintext | Stdout, followed by a trailing newline |
| Successful response with output-path set | Either | File (body) + stdout (confirmation line only) |
| Error | Structured-payload | Stdout, as a structured error envelope |
| Error | Human-readable plaintext | Stderr, with an "Error: " prefix surrounded by blank lines |

### Exit-code policy

All error paths signal failure by setting a non-zero value through the process's deferred exit-code mechanism. The action never calls a hard process-terminate. Successful paths leave the exit code untouched.

| Exit code | Condition |
|-----------|-----------|
| `0` | Response produced and written successfully |
| Non-zero | Any invalid-input condition (stdin/positional collision, empty query, deny-list hit on the stdin path, malformed flag value), search error, or file-write failure |

## Notable Behavior

- **Single-phase, no hash-list flag.** This surface has no two-phase catalog/detail round-trip and no `--hashes` flag. It assembles one query and returns one ranked hit list. (Notable.)
- **The deny-list is applied only on the standard-input path.** A positional-argument query is never deny-listed, deliberately, so the command-line surface accepts exactly what the in-process tool surface accepts. The here-doc bridge is the only place a query reaches a shell, so it is the only place the deny-list defends. (Surprising; load-bearing for parity.)
- **Structured-payload errors go to stdout, not stderr.** Consumers that pipe the output as structured data read a single stream and encounter errors in the same envelope format as successes. Switching to human-readable plaintext moves errors to stderr, matching conventional shell expectations. (Notable.)
- **The deferred exit-code mechanism is the only signaling path.** Hard process termination is never used, so wrapper processes and cleanup handlers registered by the host environment run normally. (Notable.)
- **Limit out-of-range values are silently defaulted.** Unlike format or kind violations, a non-positive or non-finite limit does not produce an error; it falls back to unset, letting the engine's own default apply. This tolerates LLM-generated invocations that may pass `0`. (Notable.)
- **Working-directory is cached at registration time, not per invocation.** A long-lived host process holds a single cached project-root value for the entire process lifetime. The `--cwd` override is the intended escape hatch for callers that need to target a different directory without restarting the process. (Notable.)
- **The standard-input bridge and positional words are mutually exclusive.** Supplying both is an invalid-input error, not a silent precedence rule. (Notable.)

## Shared Behavior

- The `--cwd` flag is shared with most other `jolli` subcommands. When omitted, the cached project-root resolution described above applies.
- The structured-payload format flag value is the same enumerated token used by other subcommands that emit machine-readable output, ensuring a consistent flag vocabulary across the CLI surface.
- The standard-input bridge flag is shared with the `jolli recall` subcommand surface, which uses the same here-doc recipe in its skill template.
- The required-query guard, the storage-backend establishment, the index open/cache, and the `{ hits }` shape are owned by the single-phase search pipeline spec.
- The rolling debug-log initialization performed at the start of every action is the same initialization described in the debug-log rotation and leveling spec (131).
