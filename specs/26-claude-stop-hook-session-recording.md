# 26. Claude Stop Hook — Session Recording

## Topic Statement

Record one entry into the local session registry every time the Claude Code agent completes a response turn, by reading a small JSON payload from the hook's standard input and persisting only metadata, then trigger a single incremental discovery pass that runs the shared plan and reference scanners against the same transcript suffix — all without any language-model call.

## Scope

**In scope:**

- The contract between Claude Code's "agent stopped" hook event and this handler.
- The shape of the payload received over standard input.
- The fields written into the session registry record.
- The ordering and decision points before, during, and after the registry write.
- The local-agent-child gate evaluated before anything else, which detection channel it consults, and why that is the right channel here.
- The repo-wide manual-disable gate read before the configuration load, and what returning on it rules out.
- The fire-and-forget execution contract that lets the agent return control immediately.
- The set of conditions that cause the handler to do nothing (early-exit and skip cases).
- The relationship between this handler and a separate plan-discovery scan that runs immediately after session recording.
- The relationship between this handler and a separate reference-extraction scan that runs after plan discovery against the same transcript suffix.
- The **single-owner gate** that decides whether *this* invocation performs the discovery pass at all, when the same repository has two possible runners of it.
- The shared single-cursor coordination that lets both scans advance in lockstep across invocations.
- The opportunistic telemetry-buffer flush performed at the end of the handler.

**Out of scope (boundaries):**

- Reading the agent transcript itself for the purpose of model input (deferred until the user's next source-control commit). The transcript-suffix reads performed by plan discovery and reference extraction are themselves out-of-scope mechanics, owned by spec 29 and spec 153 respectively.
- Any call to a language model.
- Detecting plan-mode slugs or plan file edits inside the transcript (covered by spec 29). What this handler contributes is **only** the trigger — selecting the transcript source tag (Claude), passing the resolved project directory and transcript locator, and orchestrating the cursor write that both scans share.
- Detecting external-entity references (Linear / Jira / GitHub / Notion items) inside the transcript (covered by spec 153). What this handler contributes is the same trigger as for plan discovery.
- The per-source scanner contracts and the shared upsert drivers (a transcript-line-to-plan-candidates contract for plan discovery, an envelope-parser contract for references). The drivers and the per-source implementations are shared with the Codex polling path and are owned by their canonical specs (spec 29 for plans, spec 153 for references). The Claude-specific concerns that remain here are: (a) the host-invoked Stop event as the trigger, and (b) the Claude transcript format as the input both scans see.
- Generating any briefing or summary (covered by spec 27).
- The shape and behavior of the parallel handler for the other supported agent (covered by spec 28).
- The session-registry file format itself, pruning of stale entries, and orphaned-cursor cleanup (covered by the session-tracking spec).

## Data Contracts

### Triggering event

Fired by the host agent when an agent response turn completes. The host agent invokes a configured external program, with the hook running in a "non-blocking" mode so the program is launched and its result is not awaited.

### Standard-input payload (JSON object)

Fields consumed by this handler:

| Field             | Type   | Required by handler | Notes                                                                          |
| ----------------- | ------ | ------------------- | ------------------------------------------------------------------------------ |
| `session_id`      | string | yes                 | Stable identifier of the current agent session. Used as the registry key.      |
| `transcript_path` | string | yes                 | Absolute path to the per-session transcript file maintained by the host agent. |
| `cwd`             | string | optional            | The host agent's working directory at the time of the event.                   |
| `hook_event_name` | string | unused              | Present in the payload but not consumed.                                       |

Other top-level fields on the payload are ignored.

### Project-directory resolution

The directory used as the project root for all on-disk effects is selected as follows, in order:

1. The value of an environment variable that the host agent sets to the active project directory, when present.
2. Otherwise, the `cwd` field from the payload.

If neither is available, the handler proceeds against the runtime's current working directory.

### Session-registry record

A single record written to (and upserted into) the per-project session registry under the project root, containing:

- The session identifier (verbatim from the payload).
- The transcript-file locator (verbatim from the payload).
- A timestamp of when this record was written, formatted as an ISO-8601 instant.
- A source tag identifying which agent recorded this session; for this handler the tag value is the literal identifying the Claude Code agent.

The handler does not read the transcript file at this stage; it only stores the locator.

## Behavior

### Execution order

**Evaluated first, ahead of the numbered sequence below — the local-agent-child gate.** Before reading standard input, before configuring the diagnostic log directory, and before any other work, the handler checks whether this process descends from a generation invocation the product itself made against a locally-installed agent CLI. If it does, it logs an informational line and returns, doing nothing at all — no registry write, no discovery pass, no cursor write, no telemetry flush, and standard input is never even read. Recording a session for the throwaway temporary working directory such an invocation runs in is pure self-recursion noise.

This site consults the **inherited-environment channel only**; it passes no working directory and therefore never consults the working-directory marker. That is the correct channel here because this handler is a direct descendant of the product's own child: the product sets the marker on the agent CLI it spawns, and the hooks that CLI in turn spawns inherit the environment reliably. The marker-file channel exists for the one entry point that is launched by a *host* rather than by the product's own child, where the environment can be sanitized away. Both channels, and the reason the marker-file probe is opt-in per call site rather than always on, are owned by spec 280.

Then, in order:

1. If the project-directory environment variable is set, configure the diagnostic log directory under that path before any other work.
2. Read all bytes from standard input as text. If the read fails, log the failure and return without writing anything.
3. If the resulting string is empty (after trimming whitespace), log a warning and return.
4. Parse the string as JSON. If parsing fails, log the failure and return.
5. Resolve the project directory using the rule above. If the project-directory environment variable was absent, configure the diagnostic log directory now from the resolved value, and log that the handler was invoked.
6. **Repo-wide manual-disable gate.** Read the repository's manual-disable flag. If it is set, log that the repository is manually disabled and return. The position is load-bearing: this gate sits **before** the configuration load in step 7 (and therefore before the unrelated per-integration Claude opt-out that step consults) and **before** the required-field check in step 8. On the disabled path nothing at all happens — no session-registry write, no discovery pass, no cursor write, and no telemetry flush — and the payload's validity is never examined, so a manually-disabled repository cannot even produce the "missing required fields" warning. The flag's storage, priority, and migration are owned by the manual-disable spec.
7. Load the global Jolli Memory configuration. If a Boolean field that explicitly disables the Claude Code integration is set to `false`, log an informational line and return.
8. If either the session identifier or the transcript-file path is missing or empty in the payload, log a warning and return.
9. Build the session-registry record with the source tag set to the Claude identifier and the timestamp set to "now".
10. Save the record into the session registry. Log success on completion. On failure, log the error message, error code, and stack trace separately, then continue.
11. Evaluate the **single-owner gate** (below). If it says another runner owns discovery, skip step 12 entirely and go to step 14.
12. Run a single incremental discovery pass against the same transcript path. The pass first migrates any legacy per-scan cursors into one merged discovery cursor, then loads that cursor's line watermark, then runs the two scans in fixed order against the same starting line:
    1. **Plan discovery** — invoke the shared plan-discovery driver with the Claude source tag and no upper-line cap (so it scans to end-of-file). Wrap the call in a try/catch and log on failure.
    2. **Reference extraction** — invoke the shared reference-extraction driver with the Claude source tag against the same starting line. Wrap the call in a try/catch and log on failure. Capture the line number it reports as having traversed.
    
    After both scans, **only if the plan scan completed without throwing and the reference scan reported progress beyond the starting line**, persist the merged discovery cursor at the reference scan's reported line. Otherwise leave the cursor at its prior value.
13. Treat any thrown error from either scan as a logged failure that must not propagate; the handler still returns success to its caller.
14. Await an opportunistic flush of the shared telemetry buffer, bounded by a short per-batch timeout. This runs on **every** non-disabled invocation, including the ones that skipped the discovery pass on the single-owner gate, because the stop event fires far more often than a commit does and is the only reliable flush occasion for a user who works with the agent without committing. The flush re-checks consent itself, no-ops on an empty buffer, and never throws. It is awaited rather than fired-and-forgotten so the short-lived handler process does not exit mid-request; the short timeout keeps a slow network from holding the process open.

### Single-owner gate for the discovery pass

The same repository can have two installed runners of this handler: the canonical one registered in the repository's own agent-settings file, and one supplied by the agent-plugin package. Both would otherwise perform the discovery pass, and because the merged discovery cursor only ever moves **forward**, whichever runner is older can advance it past transcript lines it does not know how to interpret — permanently stranding whatever those lines contained. The gate exists to make exactly one runner the owner.

This invocation **defers** the discovery pass if and only if **all three** of the following hold:

1. The invocation is a plugin invocation — identified by a truthy plugin-root environment marker the agent host sets for a plugin-supplied hook's process. The check is for truthiness, not mere presence, so an empty value is never mistaken for a plugin invocation. The gate's discriminating power rests on that marker being scoped to plugin-hook processes only; that is a property of the host environment, not something this product sets or can enforce. If the scoping ever failed, both runners would perform the pass — which is safe, per the fail-safe note below.
2. The shared machine-global hook launcher — the single entry script every canonical-install variant of this hook shells out through — is present on disk. This condition exists because a settings entry can outlive the launcher it invokes (product uninstalled, state folder wiped); deferring to a runner that cannot actually run would leave *nobody* performing discovery.
3. **Both** canonical agent hooks — the stop hook *and* the session-start hook — are registered in the repository-local agent-settings file. Three precisions matter here, because each narrows the gate further than a casual reading suggests:
   - Only the repository-**local** settings file is consulted. A repository whose product hooks live in the older shared settings file never satisfies this condition.
   - The verdict requires an **exact** match on the canonical launcher command plus the exact expected asynchronous-execution shape, in exactly one owned matcher group holding exactly one hook definition. A legacy-form command that merely *contains* a recognized product marker does **not** satisfy it — the marker set is used only to decide which matcher groups this product owns, not to accept them.
   - **Both** hooks are required. A repository with a healthy stop hook but a missing or non-canonical session-start hook does not defer; the plugin invocation runs discovery itself.

Otherwise the discovery pass runs. The conditions are evaluated cheapest-first (environment marker, then the on-disk launcher probe, then the settings read), so a non-plugin invocation pays nothing.

Session recording (step 10) and the telemetry flush (step 14) are **surface-independent and always run** on a non-disabled repository; only the discovery pass is gated.

The gate is fail-safe in one direction only. Running when it could have deferred is harmless — both scans are idempotent and dedupe on re-scan, so a redundant pass costs work, not correctness. Deferring when the other runner cannot actually run would be harmful, which is why condition 2 exists. The gate therefore removes wasted work and the cross-version cursor race; it is not the only thing preventing corruption.

### Branches

- **All inputs valid** → record is upserted into the session registry, then the discovery pass runs (plan first, references second), then the merged cursor is advanced, then the telemetry buffer is flushed.
- **Running inside a product-spawned local agent** → nothing at all happens; standard input is never read, so no payload check, no manual-disable read, no configuration load, no registry write, no discovery pass, no cursor write, and no telemetry flush; logged informational message.
- **Standard input read fails** → no registry write, no discovery pass, no error propagation; only a logged error.
- **Empty standard input** → no registry write, no discovery pass; logged warning.
- **Malformed JSON on standard input** → no registry write, no discovery pass; logged error.
- **Repository manually disabled** → no registry write, no discovery pass, no cursor write, no telemetry flush; the configuration is never loaded and the payload's required fields are never checked; logged informational message.
- **Integration explicitly disabled in config** → no registry write, no discovery pass; logged informational message.
- **Missing `session_id` or `transcript_path`** → no registry write, no discovery pass; logged warning.
- **Single-owner gate defers** (plugin invocation, launcher present on disk, and both canonical hooks registered repo-locally) → registry write happens, the discovery pass is skipped entirely, the merged cursor is not written, the telemetry flush still happens; logged informational message.
- **Registry-write failure** → the failure is logged with code and stack but does not abort the handler; the discovery pass still runs.
- **Plan scan throws, reference scan completes** → both failures are logged; the merged cursor is **held** at the prior watermark so the unscanned plan window is retried on the next invocation (the reference re-scan on retry is idempotent).
- **Plan scan completes, reference scan throws** → the merged cursor is **held** at the prior watermark (the reference scan's reported line is whatever it had reached when it threw, which is at most the starting line because the captured value is initialized to the starting line and only overwritten by a successful scan; with no progress the cursor is not advanced).
- **Both scans throw** → both failures are logged; the merged cursor is held; the handler returns success.
- **Both scans complete, reference scan reports the same line as the start** → no cursor write; nothing to advance.

### Async / fire-and-forget contract

This handler is registered with the host agent in a mode that makes the host launch the external program and immediately resume its own work without awaiting the program's exit. As a consequence:

- The host agent never observes this handler's exit code.
- The host agent does not surface any standard-output or standard-error content of this handler to the user.
- The handler's wall-clock cost (filesystem I/O for the registry write, then the plan-discovery scan, then the reference-extraction scan, then at most one cursor write) is paid out-of-band and never adds latency to the agent's next turn.
- Failures here cannot block, slow, or cancel the agent. Errors are logged for the user's later inspection only.

This is the property that makes it acceptable to run the handler on every single agent stop, including the trailing stop after every short tool-using exchange.

### Side effects

- One upsert into the session registry under the resolved project root.
- One log directory configuration (idempotent, may run twice — once before and once after parsing standard input).
- One read of the repo-wide manual-disable flag, which on the very first invocation in a repository may itself create the repository profile file (owned by the manual-disable spec).
- One opportunistic, consent-gated, short-timeout flush of the shared telemetry buffer at the end of the handler, on every non-disabled invocation.
- One idempotent fold of legacy per-scan cursors (plan-prefixed, reference-prefixed) into the single merged discovery-cursor entry keyed by the bare transcript path. Runs unconditionally before either scan.
- Possibly one or more plan-discovery side effects (covered by spec 29).
- Possibly one or more reference-extraction side effects (covered by spec 153).
- At most one write of the merged discovery cursor at the end of the pass, gated as described in Step 10. The recording step itself does not read the transcript or call any model; transcript reads, if any, happen inside the two scans.

### Errors classified

| Class                       | Trigger                                           | Outcome                                                            |
| --------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Running inside a product-spawned local agent | The inherited environment marks this process a descendant of a product-made agent-CLI generation invocation. | Logged info; handler returns before reading standard input — nothing is read and nothing is written. Not an error condition. |
| Input I/O failure           | Standard input cannot be read.                    | Logged; handler returns without writing.                           |
| Empty input                 | Standard input is whitespace-only.                | Logged warning; handler returns.                                   |
| Malformed JSON              | Standard input is not valid JSON.                 | Logged; handler returns.                                           |
| Repository manually disabled | The repo-wide manual-disable flag is set.        | Logged info; handler returns before loading configuration and before checking required fields — no registry write, no discovery, no telemetry flush. |
| Disabled by configuration   | Claude integration explicitly disabled.           | Logged info; handler returns.                                      |
| Missing required fields     | `session_id` or `transcript_path` empty/absent.   | Logged warning; handler returns.                                   |
| Registry write failure      | Filesystem error while persisting the record.    | Logged with error code and stack; the discovery pass still runs.   |
| Plan-discovery failure      | Any error thrown during the post-recording plan scan. | Logged; reference extraction still runs; cursor is held at the prior watermark. |
| Reference-extraction failure | Any error thrown during the post-recording reference scan. | Logged; cursor is held at the prior watermark.                     |
| Discovery deferred to another runner | Plugin invocation, shared launcher present on disk, and both canonical agent hooks registered in the repository-local settings file. | Logged info; registry write and telemetry flush still happen; no discovery pass and no cursor write. Not an error condition. |
| Telemetry-flush failure     | Any error inside the opportunistic buffer flush.   | Absorbed by the flush itself, which never throws and re-checks consent; the handler is unaffected. |
| Unhandled top-level error   | Any error escaping the main function.             | Caught at the script entry point; a static message only (never the error value or anything derived from it) is written to standard error; exit code `1`. |

## State Transitions

The session registry, keyed by session identifier, has these per-session states from this handler's perspective:

- **Absent** → **Active**: first time a given session identifier appears in a payload that passes all checks.
- **Active** → **Active (refreshed)**: subsequent successful invocations for the same session identifier overwrite the existing record's transcript locator (if changed) and bump the record's timestamp.
- **Active** → **Stale**: not driven by this handler; it is driven by an age-based pruning rule applied by the registry layer at write time.

This handler never deletes a session record itself. It can only insert or refresh one.

## Notable Behavior

- **Idempotent on repeat invocations.** Calling the handler twice for the same session identifier is harmless: the second call simply refreshes the timestamp.
- **Source tag is fixed.** This handler always writes the Claude source tag. It never inspects which agent actually invoked it; the choice is structural (a sibling handler exists for the other agent).
- **No standard-output writes.** Unlike the parallel handler for the other supported agent, this handler writes nothing to standard output. The host agent's "non-blocking" mode does not require a response.
- **`cwd` is a fallback only.** The environment variable wins over the payload field when both are present, even if they disagree.
- **Empty source tag is impossible.** The source tag is always populated; backwards-compatibility logic elsewhere in the codebase treats absent source tags as Claude, but this handler never produces such records.
- **Registry-write failure is non-fatal.** A failure logs the error code (e.g. permission denied) and the stack, then the handler proceeds to the discovery pass anyway. The session-registry write and the discovery-pass writes are independent.
- **One merged cursor for both scans.** Plan discovery and reference extraction share a single per-transcript discovery cursor keyed by the bare transcript path. Both scans read the same starting line and both read to end-of-file, so the reference scan's reported line is the authoritative cursor target. Legacy per-scan cursors (one prefixed for plans, one prefixed for references) from earlier versions are migrated into this merged key on every invocation before either scan runs; the migration is idempotent.
- **Cursor advance gated on plan-scan completion, not on reference-scan success alone.** If the reference scan reaches end-of-file but the plan scan threw, the cursor is held at the prior watermark. Advancing past the unscanned plan window would lose those lines forever. Both scans are idempotent, so re-scanning on retry is safe.
- **Plan scan runs first; reference scan runs second.** The order is fixed. The two scans are independent — each swallows its own errors and does not short-circuit the other — but the cursor-advance decision uses the plan scan's completion as the gate.
- **Log directory is set twice in some paths.** First from the environment variable (if present), then from the resolved project directory after parsing. Subsequent setLogDir calls are idempotent.
- **No transcript read for the session-recording write itself.** The recording step only stores the transcript-file path; it never reads the file. The plan-discovery and reference-extraction scans that run afterwards do read the transcript suffix beyond the merged cursor, but each scan reads only the new lines (the incremental cursor keeps the per-stop cost flat regardless of total transcript length). Reading the transcript for the purpose of model input (summary generation) is still deferred to a downstream consumer (the source-control commit pipeline).
- **No model call at this stage.** The handler never contacts any language-model provider. The plan-discovery and reference-extraction scans are pure local processing — file reads, set operations, registry mutations. All model interactions for this product happen in the source-control commit pipeline, not in agent hooks.
- **One implementation.** This handler is the single implementation of the stop-hook contract for every surface, including the agent-plugin surface, which invokes this same handler rather than carrying its own port. An earlier JVM-based port — which omitted the discovery pass entirely and treated the payload's working directory as required — no longer exists.
- **The local-agent-child gate outranks even the manual-disable gate, and is environment-only.** It is the very first thing the handler evaluates — ahead of the log-directory setup, the payload read, and the manual-disable read — so a nested generation session produces exactly one log line and no disk effect of any kind. It deliberately consults only the inherited environment and not the working-directory marker, for two reasons that hold specifically here: this handler is spawned by the product's own child and so inherits the environment reliably, and keeping the marker-file probe opt-in per call site means this gate cannot be flipped by unrelated stubbing of filesystem checks. (Notable; channel rationale owned by spec 280.)
- **The manual-disable gate outranks the per-integration opt-out, and masks it.** The repo-wide flag is read before the configuration is loaded, so on a disabled repository the per-integration Claude flag is never consulted at all. It also masks the required-field check: a disabled repository never warns about a malformed payload. (Surprising; intentional — the repo-wide opt-out is the highest-priority signal and must not be reachable-around.)
- **Discovery has exactly one owner, decided per invocation by three independent conditions.** The gate is deliberately narrow: it needs a plugin-process marker, the shared launcher actually present on disk, *and* both canonical agent hooks registered in the repository-**local** settings file with an exact command and asynchronous-execution match. A legacy-form command that merely contains a recognized product marker, a repository using the older shared settings file, or a healthy stop hook alongside a missing session-start hook all fail the gate — and failing it means this invocation runs discovery itself. Erring toward running is the safe direction; erring toward deferring could leave nobody running it. (Surprising; intentional.)
- **The cursor's forward-only nature is what makes the single-owner gate necessary.** Two runners of different vintages sharing one merged cursor means the older one can advance it past transcript lines it cannot interpret, and those lines are then never re-read. Serializing which runner owns the pass is cheaper and more robust than making the cursor reversible. (Notable; the design rationale.)
- **Session recording and the telemetry flush are surface-independent.** Both happen on every non-disabled invocation regardless of the single-owner gate's verdict. Only the discovery pass is ever skipped by it. (Notable.)
- **The stop event doubles as the telemetry flush occasion.** It fires far more often than a commit, so it is the only reliable flush point for a user who works with the agent without committing. The flush is awaited rather than detached — the handler process is short-lived and would otherwise exit mid-request — but bounded by a short timeout so a slow network cannot keep it alive. (Notable.)
- **Configuration gate is global, not per-project.** The "Claude integration disabled" flag is read from the user-global configuration directory, not from the project's local configuration. Disabling the integration affects every project on the machine.
- **Auto-execute guard.** The handler script auto-runs only when invoked as the main script, not when imported by another module (used by tests).
- **Top-level error logging is secret-safe.** The entry-point catch writes a fixed, static message to standard error — never the caught error or anything derived from it — because an error escaping the flush/sync chain can carry a product API key (e.g. in request headers). The trade-off is that diagnostic detail for a fatal entry-point error is not captured at this boundary.

## Shared Behavior

- The session registry's storage layout, atomic-write semantics, and stale-entry pruning rules are defined by the **session-tracking** spec.
- The local-agent-child gate evaluated ahead of everything else — the backend that sets the markers, the two detection channels, which entry points opt into the working-directory channel and which stay environment-only, and the write-boundary backstop behind both — is owned by spec 280. This spec records only that this handler carries the gate and that it is one of the environment-only sites.
- The repo-wide manual-disable flag read before the configuration load — its storage, repo-wide anchoring, priority, migration, and the fact that eight other hook and worker entry points carry the same gate — is owned by the manual-disable spec.
- The registration of the two canonical agent hooks whose exact shape the single-owner gate tests, and the per-hook health contract it consumes, are owned by the agent-hook installation spec. The shared machine-global launcher whose presence the gate probes is owned by the dispatch-script spec.
- The telemetry buffer, its consent gate, and its flush semantics are owned by the telemetry specs; this handler is only one of the occasions that triggers a flush.
- The parallel handler for the other supported agent (which differs in source tag, in the requirement to write a JSON response on standard output, in not running any post-recording scans, and in **not** carrying the repo-wide manual-disable gate) is defined by spec 28.
- The plan-discovery scan that runs first in this handler's discovery pass — including the per-source scanner contract, the Claude slug-and-Write/Edit signal interpretation, the shared external-plan exclusion policy, the on-disk existence gate, the slug-collision resolution, and the locked re-read upsert — is defined by spec 29. The Codex sibling source-specific scanner for the same shared driver is defined by spec 181.
- The reference-extraction scan that runs second in this handler's discovery pass — including the per-producer envelope-parser contract, the source-agnostic extraction pipeline, the dedup-and-upsert into the reference registry, and the Claude tool_use/tool_result block-pairing envelope — is defined by spec 153.
- The downstream consumer that actually reads the transcript locator stored here is the **source-control commit pipeline**.
