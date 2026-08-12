# CLI Back-fill Command

## Topic Statement

The command-line surface for historical back-fill: resolve a candidate list of the local user's own recent commits (or an explicit override subset), run the back-fill engine, and render the outcome — as one-shot text/JSON, as an NDJSON progress stream, or (for `list-candidates`) as a single cold-start-signals JSON line with no engine call at all. Exists so out-of-process hosts (the IntelliJ plugin, which shells out to this command rather than calling the engine in-process like VS Code does) get the same cold-start and progress UX as an in-process caller.

**Not to be confused with the database repository back-fill** (cross-ref 350), an unrelated feature of the same name that reconciles already-existing facts into the local memory database and never calls a model. This command is the one that generates memories for historical commits and therefore spends model budget.

## Scope

**In scope:**
- The flag set, defaults, and validation, including the commit-subset override, stream mode, list-candidates mode, and the since-days/limit bounds used by list-candidates.
- How the candidate commit list is resolved from the flags.
- The three-way run-flow branch (list-candidates short-circuit / normal one-shot / stream) and the empty-candidates behavior in each mode.
- The text render (per-outcome lines, status labels, trailing summary), the pretty-printed JSON render, and the NDJSON stream protocol.

**Out of scope (boundaries):**
- The engine that actually attributes, generates, and stores (owned by **Back-fill Engine Orchestration**, cross-ref 227) — including the per-commit progress callback the stream mode relays verbatim.
- The own-author commit filter internals (owned by **Back-fill Engine Orchestration**, cross-ref 227).
- The cold-start query semantics (has-any-memory / count-missing / list-missing) that back `list-candidates` (owned by **Back-fill Cold-start Signal Queries**, cross-ref 228) — this spec only documents how the CLI shapes and bounds the call, not the query behavior itself.
- The VS Code entry points (owned by **VS Code Cold-start Back-fill Card**).

## Data Contracts

### Flags

| Flag | Form | Default | Effect |
|------|------|---------|--------|
| project directory | path | git repo root | which repo to back-fill |
| last N | positive int | 20 | number of most-recent own commits to consider |
| all | boolean | off | drop the cap — consider every own commit reachable from `HEAD` |
| hashes (commit-subset override) | comma-separated list | (unset) | an explicit commit subset; when non-empty it entirely REPLACES the last/all range rather than adding to it. Parsed by comma-splitting, trimming each entry, and dropping blanks. A blank-only value (e.g. all commas/whitespace) yields an empty list after trimming, which falls back to the last/all range instead of erroring |
| dry-run | boolean | off | attribute and preview without any model call |
| min-confidence | `high`\|`medium`\|`low` | `low` | lowest attribution tier to keep; the parser rejects any other value with an error |
| format | `text`\|`json` | `text` | output format for the one-shot (non-stream) path |
| stream | boolean | off | emit the NDJSON stream protocol (below) instead of a one-shot text/JSON render |
| list-candidates | boolean | off | short-circuit before candidate resolution: emit cold-start signals as a single JSON line and exit, without attribution, transcript scanning, or an LLM call |
| since-days | positive int | (unset) | list-candidates only: keep only commits authored within the last N days; converted to a millisecond window before being passed to the underlying query |
| limit | positive int | (unset) | list-candidates only: caps the number of candidate rows in the emitted line |

The default minimum confidence is the same tier every entry point defaults to (window-collect-all).

### Exit code

Non-zero when there are no candidates to back-fill in the human-text and plain-JSON paths; otherwise the command completes normally. `--list-candidates` always exits zero (it has no candidates concept to fail on — it reports counts, it doesn't require them to be non-zero). The `--stream` path with zero candidates is a carve-out: it exits zero with an empty terminal report instead of failing (see **Exit-code carve-out** below).

## Behavior

### Run flow

The command branches three ways up front, before any candidate resolution:

1. Initialize the log directory for the resolved project directory.
2. **`--list-candidates` short-circuit:** if set, run the list-candidates mode (below) and return. This bypasses hash resolution and the empty-commits guard entirely — it can never trigger the empty-report or error-exit paths described for the other two branches.
3. **Otherwise, resolve candidates:** an explicit `--hashes` subset (when non-empty) entirely replaces the range; otherwise the local user's own recent commits reachable from `HEAD`, newest-first — capped to `last N`, or uncapped when `--all` is given.
4. **Empty guard**, mode-dependent:
   - **Stream:** print an empty terminal report line (`total`/`generated`/`skipped`/`errors` all zero, empty `outcomes`) to stdout and return with a zero exit code — the engine is never called. See **Exit-code carve-out**.
   - **Human text / plain JSON:** write `No commits found to back-fill.` to stderr, set a non-zero exit code, and return without producing a report.
5. Run the engine with the resolved candidates, the dry-run flag, the chosen minimum tier, and — in stream mode — a per-commit progress callback.
6. Render, mode-dependent:
   - **Stream:** the NDJSON stream protocol (below).
   - **json:** print the pretty-printed report object.
   - **text:** print the text render (below).

### NDJSON stream protocol

Active when `--stream` is set (independent of `--format`). Each line is a standalone JSON object (NDJSON), written as the run progresses rather than buffered until completion:

- **One progress line per commit**, as the engine drains: `{"type":"progress", done, total, outcome}`. This is not a new mechanism — it is the engine's existing per-commit progress callback (cross-ref 227) invoked once per processed commit; the CLI's only job is to serialize each callback invocation to a stdout line.
- **Exactly one terminal report line**, printed once after the run (or immediately, in the empty-candidates carve-out): `{"type":"report", total, generated, skipped, errors, outcomes}`.

The report line is **not pretty-printed** — it is compact, single-line JSON with no indentation — which differs from the plain `--format json` (non-stream) render, which pretty-prints the same report shape with two-space indentation. The stream protocol favors one-object-per-line machine parsing over human readability.

### list-candidates mode

Triggered by `--list-candidates`. Emits a single JSON line — `{hasAnyMemory, total, missing, candidates}` — and returns, without any of: hash resolution, the empty-commits guard, LLM calls, attribution, or transcript scanning. Behavior:

1. Query whether the repo has any memory at all (`hasAnyMemory`).
2. Query the missing-summary counts (`total` own commits, `missing` of them lacking a summary).
3. Convert `--since-days` (when given) to a millisecond window and list the missing commits bounded to that window.
4. Apply `--limit` (when given) to cap the candidate rows.
5. Print the single JSON line and return.

This mode returns before hash resolution and the empty-commits guard, so an empty `candidates` list here never triggers the empty-report or error-exit paths described for the other two modes — those paths simply don't run in this branch. The underlying query semantics (has-any-memory, count-missing, list-missing, the own-author filter, the window-anchoring rule) are owned by **Back-fill Cold-start Signal Queries** (cross-ref 228); this command only shapes the since-days-to-milliseconds conversion and the limit cap on top of them.

### Exit-code carve-out

The empty-candidates behavior depends on mode:

- **Human text / plain JSON:** still print the stderr message and exit non-zero (unchanged from the original one-shot behavior).
- **Stream:** with zero resolved candidates, print an empty terminal report (`total`/`generated`/`skipped`/`errors` all zero, empty `outcomes`) to stdout and exit zero. The engine is never invoked in this case.

This is the one flag combination that softens the empty-candidates guard. It exists so an out-of-process machine consumer driving the stream protocol (the IntelliJ plugin) gets a well-formed, parseable terminal report even when there is nothing to back-fill, rather than having to infer "nothing to do" from a bare non-zero exit code and no output.

### Text render

One line per outcome:
`<short-hash>  <status-label>[ [<confidence>/<method>]][ (<N> topics)][ — <message>]`
- Short hash = first 8 characters.
- The `[confidence/method]` bracket appears when a method is present; the `confidence/` prefix appears only when a confidence is present (diff-only outcomes have a method but no confidence, so they render as `[diff-only]`).
- The topics count appears only when present (generated outcomes).
- The message appears only when present (error outcomes).

Then a blank line and a trailing summary line:
`<total> candidate(s): <generated> <verb>, <skipped> skipped, <errors> error(s).`
where `<verb>` is `would generate` in dry-run and `generated` otherwise.

### Status labels

| Status | Label |
|--------|-------|
| generated | `✓ generated` |
| would-generate | `○ would generate` |
| skipped-has-summary | `· already summarized` |
| error | `✗ error` |

## State Transitions

Three independent run shapes, chosen up front by flags and mutually exclusive:

- **list-candidates:** query, print one line, exit. Never touches the engine.
- **One-shot (default):** resolve candidates, invoke the engine once, print the full text/JSON render, exit.
- **Stream:** resolve candidates, invoke the engine once with a progress callback that emits one NDJSON line per commit as it completes, then print one terminal NDJSON report line, exit. Unlike the one-shot path, engine progress is now surfaced incrementally on this surface — one line per processed commit, not just a final summary.

## Notable Behavior

- **`--min-confidence` is validated at parse time** — an out-of-set value fails the command with an explanatory error rather than being silently coerced. (Notable.)
- **`--all` overrides `--last`** by dropping the cap entirely, and **`--hashes` overrides both** by replacing the range outright rather than adding to it. (Notable.)
- **A blank-only `--hashes` value is not an error** — it parses to an empty list, which falls back to the `--last`/`--all` range instead of failing the command. (Notable.)
- **Empty candidates is treated as a (soft) failure only outside stream mode** — the human/text and plain-JSON paths still print a stderr message and exit non-zero with no report; the stream path instead prints an empty, well-formed terminal report and exits zero (see **Exit-code carve-out**). This is the one flag combination that softens the empty-candidates guard. (Notable.)
- **Diff-only outcomes render with a method but no confidence**, so their bracket reads `[diff-only]`. (Notable.)
- **The stream protocol's progress lines are not a new mechanism** — they are the engine's existing per-commit progress callback (cross-ref 227), serialized one line per invocation. (Notable.)
- **The stream report line is not pretty-printed**, unlike the plain-JSON (non-stream) render of the identical report shape. (Notable.)
- **`list-candidates` bypasses hash resolution and the empty-commits guard entirely** — an empty candidate list in this mode is just an empty array in the JSON line, never the stderr/non-zero path. (Notable.)
- **The CLI now streams per-commit progress via `--stream`**, where previously this surface only ever printed a single final report; see **VS Code Cold-start Back-fill Card** for how the VS Code entry point surfaces progress in-process. (Notable.)

## Unreachable / Not-live

None.

## Shared Behavior

- Candidate resolution (own-author recent commits, newest-first) and the whole attribute/generate/store pipeline, including the per-commit progress callback the stream mode relays, are owned by **Back-fill Engine Orchestration** (cross-ref 227).
- The default minimum tier is the shared cross-entry-point default described in **Back-fill Engine Orchestration** (cross-ref 227).
- The cold-start query semantics behind `list-candidates` — has-any-memory, count-missing, list-missing, the own-author filter, and the newest-commit-anchored window rule — are owned by **Back-fill Cold-start Signal Queries** (cross-ref 228); this spec only documents the CLI's flag shaping (since-days → milliseconds, limit) on top of them.
- The IntelliJ plugin is a consumer of `--list-candidates` and `--stream` as an out-of-process alternative to the in-process calls VS Code makes; the plugin's own UI/wiring is out of scope here (see **VS Code Cold-start Back-fill Card** for the in-process shape these flags mirror).
