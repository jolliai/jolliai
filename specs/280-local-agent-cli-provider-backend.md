# 280. Local Agent CLI Provider Backend — Executing an LLM Completion by Driving a Locally-Installed Agent CLI

## Topic Statement

This spec defines a third LLM execution backend, selected when the configured provider is the local-agent value: instead of calling a hosted LLM API directly or via a proxy, the system drives a locally-installed agent CLI (initially a single supported tool) as a headless child process, feeding it the same template-filled prompt and normalizing its output into the shared LLM-call result. The tool authenticates via its own subscription login, so no jollimemory-held credential is involved. This spec owns *how* the local agent executes; it does not own *which* provider is chosen (credential/provider selection) nor *whether* a run should happen locally (workflow-run orchestration).

## Scope

**In scope**

- Backend selection at dispatch time (the local-agent provider value) and the two auxiliary config fields that parameterize it (which tool to drive; an optional explicit executable path).
- A pluggable backend registry keyed by tool id, with one backend registered today and an extension point for future tools.
- Discovering and capability-verifying the tool's executable, including candidate enumeration, the capability probe, newest-capable selection, per-key result caching, and platform-specific discovery rules.
- Building the child-process invocation: the headless single-shot arguments, the prompt delivered on standard input, the fixed system prompt, the tool-denial and non-interactive settings, the isolated temporary working directory, and the environment scrubbing.
- Running the child: standard-output capture, standard-error tail retention, the wall-clock timeout with graceful-then-forceful termination, and the exit-code interpretation rules.
- Parsing the tool's result envelope into a normalized outcome (text, token counts, cost, stop reason) and classifying failures into a three-way error taxonomy.
- Mapping the outcome into the shared LLM-call result and cleaning up the temporary working directory.
- Fan-out serialization under this provider.
- Mapping an auth failure into a distinct summary-error marker; the no-fallback guarantee.
- The re-entrancy marker the backend sets on the child, and the set of entry points that detect it and no-op.
- A health probe of the executable exposed by the diagnostic command, and the non-throwing liveness predicate over the same resolution that the interactive setup and repair surfaces consume.

**Boundaries**

- Provider/credential selection priority — which of the three backends is chosen, and the credential-source resolution — is owned by the LLM-credential-priority spec. This spec begins once the local-agent path has already been selected.
- The prompt template library and the model-id resolution are shared with the direct backend and owned elsewhere; this spec consumes them.
- The direct hosted-API call and the proxy-routed call are the sibling backends (their own specs); this spec never falls back to either.
- Whether a workflow run should execute locally at all (the local-run offer / workflow-run orchestration) is owned by the workflow-run specs; this spec only defines execution once the local path is taken.
- How a summary-generation failure marker is subsequently acted upon (retry policy, placeholder writes, the "regenerate" affordance) is owned by the queue-worker / summary-error specs; this spec only defines which marker a failure produces.
- The MCP server's own no-op-in-child behavior is described in the MCP tool-surface spec; this spec owns the marker contract it keys off.

## Data Contracts

### Selection inputs

The backend is reached only when the resolved credential source is the local-agent value (an explicit provider choice). Two further persisted fields parameterize it, both ignored unless the local-agent provider is active:

- **Which tool to drive** — an enumerated identifier; exactly one value is supported today (the initial agent CLI). An unrecognized value is rejected at config-set time with a message listing the valid values.
- **An optional explicit executable path** — overrides automatic discovery. When set, only that path is considered.

Both fields are threaded through the credential-field extraction helper alongside the provider choice, so a call site that copies credentials cannot silently drop them.

### Resolved executable

A discovered executable is represented by its filesystem path and a version string. It is "resolved" only after a capability probe confirms it accepts the exact arguments a real run passes.

### Completion request

A single request carries the template-filled prompt text, a resolved model identifier, and a fixed system prompt. There is deliberately **no** output-token cap: the driven CLI exposes no per-call max-output-tokens control, so the API path's max-tokens budget (and its truncation stop-reason) do not apply here.

### Normalized outcome

Parsing the tool's result yields: the completion text, input-token count, output-token count, a combined cached-token count (cache-read plus cache-creation), a cost figure in the local currency unit, and a stop reason (or none). This is mapped into the shared LLM-call result, which additionally records the provider source label; the cost figure has no field in that shared result and is surfaced only in a diagnostic log line, since local-agent spend bills the tool's own subscription rather than a metered key.

### Error taxonomy

Three failure classes are distinguished:

- **Setup error** — the executable is missing, too old, not a working CLI, unparseable output, or a nonzero exit with no output. Not recoverable by retry.
- **Auth error** — the tool's login has expired or is not signed in; the user must sign in.
- **Transient error** — a timeout, rate-limit, or overloaded condition. Labeled for the diagnostic message only; it does **not** today drive a distinct retry-later path (the queue treats every LLM failure uniformly).

### Re-entrancy child marker

An environment-variable marker is set on the spawned child and, by inheritance, on every process that child transitively spawns. Its presence means "this process descends from a jollimemory-spawned local agent and must not re-enter jollimemory."

## Behavior

### Backend registry

Backends are registered under a string tool id in a process-wide registry; one is registered at module load. Looking up an unknown id raises a setup error naming the available ids. The registry is the sole extension point for future tools.

### Executable resolution

1. If an explicit path is configured, it is the only candidate. Otherwise candidates are enumerated platform-specifically: on POSIX, the results of a PATH-lookup for the tool plus known per-user install locations; on the other platform, the native PATH-lookup plus known install locations, filtered to real executable images only (launcher shims and extensionless shims are intentionally excluded — they cannot be spawned without a shell, and routing dynamic prompt arguments through a shell would open an injection surface; such a setup requires pointing the explicit-path field at a real executable).
2. Each candidate is capability-probed by invoking it with the **actual** non-interactive flags a real run passes plus a version query — so a CLI too old to accept the non-interactive setting is correctly classified incapable rather than falsely accepted by a bare version check.
3. Among capable candidates, the **newest version wins**; discovery order is only a tie-break.
4. A successful resolution is cached with a time-to-live, keyed by the override path (empty for default discovery) so a long-lived worker sweeping multiple repos with different configured paths never serves one repo's binary to another. Failures are never cached, so a fresh install or upgrade is picked up on the next call.
5. If no capable candidate is found, a setup error is raised — worded to distinguish "your configured path is not a working CLI" from "no compatible CLI found; install/upgrade it or switch provider."

### Invocation construction

The invocation is built as:

- **Arguments** requesting headless, single-shot operation with machine-readable (JSON) output, the resolved model pinned, the fixed system prompt supplied, an **empty tool allow-list** (which matches no real tool, denying all tool use), a non-interactive permission mode (so even an attempted tool call never prompts), and session persistence disabled. This is a pure text completion; the agent must not touch the filesystem or shell.
- **Prompt** delivered on the child's standard input.
- **Working directory**: a freshly created empty temporary directory. This isolates the run from the current repository — the tool auto-discovers a project-instruction file from its working directory and folds it into its system prompt, so running in the repo would pollute the completion and burn tokens. The directory is removed after the run.
- **Environment**: the parent environment, minus a scrub-list of variables that would misroute or break the child (a hosted-API key or auth token would bill the API instead of the subscription; a base-URL override would route to a third-party gateway with no credentials; a stale OAuth token or an "already inside an agent session" marker would break the spawn), plus the re-entrancy child marker set.

### Running the child

The child is spawned hidden with piped standard streams; the prompt is written to its input, which is then closed.

- Standard output is accumulated as raw bytes and decoded once at the end (so a multi-byte character split across chunks is not corrupted). Standard error is kept as a rolling tail of the last few kilobytes, decoded incrementally.
- A wall-clock timeout (defaulting to the same absolute cap as the direct streaming path, i.e. minutes-scale, because a local agentic turn is routinely multi-minute) fires a graceful termination signal, then a forceful kill after a short grace period, and rejects with a **transient** error.
- On exit: a clean exit resolves the captured output. A **nonzero** exit that nonetheless produced output **also resolves** it — because the driven CLI reports auth/API failures as an error envelope on standard output while exiting nonzero, and only the backend's parser can interpret that envelope; discarding it would strip an expired-login failure down to an opaque exit code. Only a nonzero exit with **no** output is a true opaque failure and rejects with a **setup** error carrying the exit code and standard-error tail.
- A spawn failure (the executable could not be launched) rejects with a **setup** error.
- A broken-pipe error on the input stream (the child closed input before consuming the whole prompt, e.g. on a fast auth failure) is swallowed with a warning; the real outcome is still carried by the exit handler, and leaving it unhandled would crash a detached background worker.

### Result parsing and failure classification

The captured output is parsed as the tool's JSON result envelope:

- Unparseable output → **setup** error (with a truncated preview).
- An error envelope → classified: an unauthorized/forbidden status → **auth** error; a rate-limit or server-error status → **transient** error; otherwise, if the detail text matches stable "not signed in / log in / unauthorized / invalid key / authenticate" phrasings → **auth** error (a not-signed-in failure sometimes arrives with no HTTP status); otherwise → **setup** error. Both auth and setup are non-retryable, so a misclassification only degrades the message, never the retry decision.
- A success envelope → the normalized outcome (text, token counts, combined cached tokens, cost, stop reason).

### Dispatch and result mapping

Once selected, the local-agent path mirrors the direct path's preamble: it resolves the template for the requested action (raising on an unknown action), warns on any unfilled placeholder, fills the prompt, and resolves the model id. It does **not** thread an output-token cap (unsupported by the tool). It then discovers the executable (honoring the configured tool id and optional path), builds the invocation, runs it, parses the outcome, logs a completion line including the parsed cost and token counts, and returns the shared result with the provider source label attached. **On any failure it throws** — it never falls back to another provider, so the user is never silently billed on a hosted-API key. The temporary working directory is removed in a cleanup step, but **only** if it is under the system temp directory and carries the backend's temp-directory prefix (guarding against deleting an unrelated directory when a test injects an arbitrary working directory).

### Fan-out serialization

Any LLM fan-out that would run N-wide under a hosted provider is serialized to **one** under the local-agent provider: each call spawns a full CLI agent turn (a real multi-minute process with a large built-in system prompt), so N concurrent spawns would trip the subscription's rate limit or bury the machine.

### Failure-marker mapping

When a summary-generation failure is classified for storage, an auth failure (detected by the error's stable name, not by object identity — because the bundling process can produce two copies of the error class where identity checks fail) is recorded as a distinct **auth** summary-error marker so surfaces can show sign-in guidance; every other failure is recorded as the generic LLM-failure marker.

### Re-entrancy guard

The backend sets the child marker on the spawned tool. Because most users also have the product's own integration with the same tool installed (hooks, an enable path, an MCP server), the nested tool would otherwise re-trigger the product against the throwaway temporary working directory — recording sessions, running enable, and rooting storage there, which historically claimed a spurious Memory Bank "repo" named after the temp directory on every summary call. To cut this at the source, each entry point that a nested tool could re-trigger checks the inherited marker and **no-ops**:

- the agent session-start hook,
- the agent stop hook,
- the enable command,
- the MCP server startup.

The guard is independent of whether the temp directory happens to be a git repo and of which hook modes a future tool version fires.

### Diagnostic probe

The diagnostic ("doctor") command, when the active provider is local-agent, does not stop at "provider selected": because the "credential" here is an executable rather than a stored key, it additionally runs the executable resolver (cheap, and it verifies the flags are accepted) and reports the resolved path and version, or a failing check if the CLI is missing or off the worker's PATH — so it never reports healthy while every commit silently fails with a setup error (spec 59).

### Liveness predicate for interactive callers

The same executable resolution is additionally exposed as a **non-throwing boolean liveness predicate**: "is a usable agent CLI present right now?", taking the same optional explicit-path override. It is a plain success/failure wrapper — it performs the identical candidate enumeration and real-flags capability probe, and simply reports `false` instead of raising the setup error.

Two interactive surfaces consume it, and both would otherwise have to catch an error to ask a yes/no question:

- the fresh-configuration auto-detect in the first-time provider setup wizard (spec 57), which selects the local-agent provider without asking when the answer is yes;
- the shared "can generate right now" predicate (spec 291), which is why that predicate deliberately diverges from dispatch-time provider selection (spec 10) for this provider only.

**The caching asymmetry is operative here, not incidental.** Because a resolution is cached only *after* it succeeds, a **success** is served from the time-bounded per-override-path cache while a **failure is never cached at all**. That is precisely what makes the repair ladder's single one-shot re-probe meaningful: a user who installs, upgrades, or signs in to the agent CLI in another terminal and then answers "retry" gets a genuinely fresh answer rather than a replayed failure. Conversely, a user whose agent CLI *stops* working within the cache window can still be told it is usable.

## State Transitions

The backend is stateless per call except for the module-level executable-resolution cache (TTL-bounded, keyed by override path, success-only). A call proceeds: select → resolve executable (cache hit or probe) → build invocation (create temp dir, scrub env, set child marker) → run child → parse → map result → cleanup temp dir. A failure at any stage throws the appropriate taxonomy error and still runs cleanup. No provider preference is learned or persisted.

## Notable Behavior

- **No output-token cap exists on this path**, so the truncation stop-reason that the hosted path can emit never appears here.
- **A nonzero exit is not automatically a failure** — an error envelope on standard output is authoritative over the exit code, and the parser (not the runner) decides.
- **Auth failures are pattern-matched as a fallback** when no HTTP status is present, because a local not-signed-in condition can surface without one.
- **The provider never falls back.** A local-agent failure surfaces as an error; it is never retried on a hosted API key or the proxy.
- **Fan-out is forced to serial** under this provider.
- **Cost is observable only in logs**, since the shared result has no cost field and the spend is on the tool's own subscription.
- **The temp working directory is deleted only when it matches the backend's own prefix under the system temp dir**, never blindly.
- **Newest capable executable wins**, with discovery order as a tie-break; the capability probe uses the real run flags so an old CLI is rejected.
- **Successes are cached, failures never are** — so a broken setup is re-probed on every ask (which is what makes a one-shot interactive "retry" worth offering), while a working setup does not pay for a subprocess on every call. The trade-off is that a CLI which breaks inside the cache window is still reported usable until the entry expires.
- **On the shim-restricted platform, only real executable images are auto-discovered**; launcher/extensionless shims require an explicit configured path, by security design.
- **The re-entrancy marker is inherited transitively**, so the guard holds regardless of how many processes deep the nested tool spawns.

## Shared Behavior

- Which provider (this backend vs. the direct hosted API vs. the proxy) is selected, and the credential-source priority, are owned by the LLM-credential-priority spec (10).
- The interactive surfaces that consume the liveness predicate are owned elsewhere: the first-time provider setup wizard and its fresh-configuration auto-detect by spec 57, and the shared can-generate predicate plus the repair ladder's one-shot re-probe by spec 291.
- The prompt template library and the model-id resolution are shared with the direct backend.
- The summary-error marker's downstream handling (retry policy, placeholder writes, regenerate affordance) is owned by the queue-worker / summary-error specs.
- The MCP server's own no-op-in-child behavior is described in the MCP tool-surface spec; the marker it keys off is defined here.
- Whether to run a workflow locally at all is owned by the workflow-run / local-run-offer specs.
