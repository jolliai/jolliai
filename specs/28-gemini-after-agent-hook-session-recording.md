# 28. Gemini After-Agent Hook — Session Recording

## Topic Statement

Record one entry into the local session registry every time the Gemini agent completes a response turn, by reading a small JSON payload from the hook's standard input and persisting only metadata, while satisfying the host's contractual requirement to write a JSON object on standard output and never invoke a language model.

## Scope

**In scope:**

- The contract between the Gemini agent's "after-agent" hook event and this handler.
- The shape of the payload received over standard input.
- The fields written into the session registry record.
- The unconditional standard-output response the host requires.
- The set of conditions that cause the handler to do nothing on disk (early-exit and skip cases) — while still writing the standard-output response.
- Parity and the deliberate differences between this handler and its sibling for the other supported agent, including this handler's **non-participation in the repo-wide manual-disable runtime gate**.

**Out of scope (boundaries):**

- Reading the agent transcript itself.
- Any call to a language model.
- Plan-discovery work (this handler does not run a plan scan).
- Briefing generation (only the other supported agent has a session-start briefing path).
- The session-registry file format and its stale-entry pruning rules (covered by the session-tracking spec).
- The sibling per-stop recording handler for the other supported agent (covered by spec 26).

## Data Contracts

### Triggering event

Fired by the Gemini agent after each agent response turn (the host calls this its "after-agent" event). The host invokes a configured external program and consumes the program's standard output as a structured response.

### Standard-input payload (JSON object)

The payload uses the same shape as the sibling agent's payload. Fields consumed:

| Field             | Type   | Required by handler | Notes                                                                          |
| ----------------- | ------ | ------------------- | ------------------------------------------------------------------------------ |
| `session_id`      | string | yes                 | Stable identifier of the current agent session. Used as the registry key.      |
| `transcript_path` | string | yes                 | Absolute path to the per-session transcript file maintained by the host agent. |
| `cwd`             | string | optional            | The host agent's working directory at the time of the event.                   |

Other top-level fields on the payload are ignored.

### Standard-output response (JSON object)

The host requires a JSON object on standard output. This handler always emits the empty object `{}` followed by a newline. The output is unconditional: it is written even when the handler skipped persisting any registry record.

### Project-directory resolution

The directory used as the project root is selected in two steps: pick a candidate, then anchor it.

**Pick a candidate**, in order:

1. The value of an environment variable that the host agent sets to its project directory, when present.
2. Otherwise, the value of the cross-agent project-directory environment variable used by the sibling agent, when present.
3. Otherwise, the `cwd` field from the payload — or, when the payload omits it, the runtime's current working directory. (The field is typed non-optional but arrives from JSON, so the guard is explicit in code rather than assumed; it matches the session-start handler's.)

**Anchor the candidate.** Whichever source won is resolved to the git worktree root that encloses it, falling back to that value verbatim when no worktree encloses it. The anchoring applies on **every** branch: the two environment variables are anchored at the moment the first present one is read — before it is used to configure the diagnostic log directory — and the payload branch is anchored where it is resolved.

Anchoring exists because any of the three sources can name a subdirectory of the project, and the session-registry write below is addressed relative to the resolved root; an unanchored subdirectory forks a second, stray per-project state directory inside the checkout. The resolution rule itself is owned by spec 311.

### Session-registry record

A single record written to (and upserted into) the per-project session registry under the project root, containing:

- The session identifier (verbatim from the payload).
- The transcript-file locator (verbatim from the payload).
- A timestamp of when this record was written, formatted as an ISO-8601 instant.
- A source tag identifying which agent recorded this session; for this handler the tag value is the literal identifying the Gemini agent.

The handler does not read the transcript file at this stage; it only stores the locator.

## Behavior

### Execution order

1. Take the Gemini-specific project-directory environment variable, or the cross-agent one when it is unset. If either was present, anchor it to its enclosing worktree root and configure the diagnostic log directory under the **anchored** path.
2. Read all bytes from standard input as text. If the read fails, log the failure, write the standard-output response, and return.
3. If the resulting string is empty (after trimming whitespace), log a warning, write the standard-output response, and return.
4. Parse the string as JSON. If parsing fails, log the failure, write the standard-output response, and return.
5. Resolve the project directory using the rule above. If neither environment variable was set, configure the diagnostic log directory now from the resolved value.
6. If either the session identifier or the transcript-file path is missing or empty in the payload, log a warning, write the standard-output response, and return.
7. Build the session-registry record with the source tag set to the Gemini identifier and the timestamp set to "now".
8. Save the record into the session registry. Log success on completion. On failure, log the error message and continue.
9. Always write the standard-output response before returning, regardless of which branch was taken.

### Branches

- **All inputs valid** → record is upserted into the session registry; standard-output response is written.
- **Standard input read fails** → no registry write; standard-output response is written; logged error.
- **Empty standard input** → no registry write; standard-output response is written; logged warning.
- **Malformed JSON on standard input** → no registry write; standard-output response is written; logged error.
- **Missing `session_id` or `transcript_path`** → no registry write; standard-output response is written; logged warning.
- **Registry-write failure** → the failure is logged; standard-output response is still written.

### Required standard-output write

The standard-output response is the host's required JSON return value for the hook. It must be written exactly once on every code path, including the early-exit paths above. The handler never elides it: it writes the response inline at every early-exit and at the natural end, rather than relying on a single cleanup clause around the whole body.

### No repo-wide manual-disable gate

Eight source-control and agent hook entry points, plus both background workers, read the repo-wide manual-disable flag at the top of their sequence and return early when it is set. **This handler does not.** On a repository the user has explicitly disabled, it still resolves the project directory, still upserts a session-registry record, and still writes its standard-output response. The disabled repository's registry therefore keeps accumulating Gemini sessions; nothing downstream consumes them, because every path that would (the source-control hooks and the queue worker) is itself gated. Whether the omission is deliberate is not recorded anywhere; the behavior is documented here as it is.

### Side effects

- One upsert into the session registry under the resolved project root (success path only).
- One log directory configuration (idempotent, may run twice — once before and once after parsing standard input).
- Exactly one write of `{}\n` to standard output, on every code path.
- No transcript reads. No model calls. No plan-discovery scan.

### Errors classified

| Class                       | Trigger                                            | Outcome                                                                                       |
| --------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Input I/O failure           | Standard input cannot be read.                     | Logged; standard-output response is still written; no registry write.                         |
| Empty input                 | Standard input is whitespace-only.                 | Logged warning; standard-output response is written; no registry write.                       |
| Malformed JSON              | Standard input is not valid JSON.                  | Logged; standard-output response is written; no registry write.                               |
| Missing required fields     | `session_id` or `transcript_path` empty/absent.    | Logged warning; standard-output response is written; no registry write.                       |
| Registry write failure      | Filesystem error while persisting the record.     | Logged; standard-output response is written.                                                  |
| Unhandled top-level error   | Any error escaping the main function.              | Caught at the script entry point in the canonical port; a static message only (never the error value or anything derived from it) is written to standard error; exit code `1`. |

## State Transitions

The session registry, keyed by session identifier, has these per-session states from this handler's perspective:

- **Absent** → **Active**: first time a given session identifier appears in a payload that passes all checks.
- **Active** → **Active (refreshed)**: subsequent successful invocations for the same session identifier overwrite the existing record's transcript locator (if changed) and bump the record's timestamp.

This handler never deletes a session record itself.

## Notable Behavior

- **Mandatory JSON response on standard output.** The Gemini host requires a JSON object back from the hook; missing or invalid output is treated as a malformed hook by the host. This handler unconditionally emits `{}\n` even when it could not persist anything. (Surprising: the equivalent sibling handler for the other supported agent writes nothing to standard output at all because that host runs the hook in a "non-blocking" mode.)
- **Source tag is fixed.** This handler always writes the Gemini source tag. The session registry uses that tag downstream to dispatch to the correct transcript parser when a commit pipeline later reads transcripts.
- **Same payload shape as the sibling.** The payload uses the same fields (`session_id`, `transcript_path`, `cwd`) as the sibling agent's payload, allowing the same registry record format to apply unchanged.
- **Same session registry as the sibling.** Records from this handler and from the sibling coexist in the same per-project registry, distinguished only by the source tag. This is intentional: the registry is the union of all agents' active sessions.
- **No configuration gate at the hook level.** Unlike the sibling, this handler does not consult a "gemini integration disabled" boolean before persisting. Gating happens later, when the registry is consumed and filtered by enabled-integrations rules.
- **Two project-directory environment variables consulted.** A Gemini-specific variable and a cross-agent variable are both honored, in that order, before falling back to the payload's `cwd`. This lets users running both agents share a single project-directory configuration.
- **Whichever source wins is anchored, not used verbatim.** All three candidates — both environment variables and the payload's working directory — are resolved up to the enclosing git worktree root before anything is written, so a value naming a subdirectory of the project no longer wins as a subdirectory and no longer forks a stray per-project state directory inside the checkout. A path no worktree encloses still resolves to itself, so a non-repository working directory behaves exactly as before. (Surprising; a real regression-closer — see spec 311.)
- **No plan-discovery scan.** Unlike the sibling for the other agent, this handler does not run an incremental plan scan after persisting. Plan discovery is currently specific to the other agent's transcript format.
- **This is the one agent hook with no repo-wide manual-disable gate.** Its sibling for the other agent gates on that flag before doing anything, as do every source-control hook and both background workers. This handler does not read the flag at all, so a manually-disabled repository still gets Gemini session records written on every agent turn. (Surprising; a notable asymmetry across the hook set, and the only gap in what is otherwise a uniform runtime capture gate.)
- **One implementation.** This handler is the single implementation of the after-agent contract for every surface. An earlier JVM-based port — which wrote the required response from a cleanup clause wrapping the whole body, returned early when the project directory could not be determined, and logged less — no longer exists.
- **Auto-execute guard.** The handler script auto-runs only when invoked as the main script, not when imported by another module (used by tests).
- **No model call ever.** This handler never contacts any language-model provider. Like the sibling handler for the other agent, all model interactions for this product happen in the source-control commit pipeline, not in agent hooks.
- **Top-level error logging is secret-safe.** The entry-point catch writes a fixed message and never the caught error to standard error, because the error can carry a product API key in request headers.

## Shared Behavior

- The session registry's storage layout, atomic-write semantics, and stale-entry pruning rules are defined by the **session-tracking** spec.
- The sibling per-stop recording handler for the other supported agent (which differs in source tag, in standard-output behavior, in the configuration gate, in the post-recording plan-discovery scan, and in carrying the repo-wide manual-disable gate) is defined by spec 26.
- The repo-wide manual-disable flag this handler deliberately does not read, and the full list of entry points that do, are owned by the manual-disable spec, which records this handler as the one documented exception.
- The resolution of a candidate project directory to its enclosing worktree root, applied here to both environment variables and to the payload's working directory, is owned by spec 311.
- The downstream consumer that actually reads the transcript locators stored here is the **source-control commit pipeline**.
- The session-source filtering rule that uses the source tag this handler writes is defined by the **session-tracking** spec under enabled-integration filtering.
