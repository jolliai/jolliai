# 280. Local Agent CLI Provider Backend — Executing an LLM Completion by Driving a Locally-Installed Agent CLI

## Topic Statement

This spec defines a third LLM execution backend, selected when the configured provider is the local-agent value: instead of calling a hosted LLM API directly or via a proxy, the system drives a locally-installed agent CLI (one of four supported tools, chosen by a persisted setting) as a headless child process, feeding it the same template-filled prompt and normalizing its output into the shared LLM-call result. Each tool authenticates through its own login rather than a jollimemory-held credential — for three of the four that login is the tool's own subscription; the fourth authenticates against whichever LLM provider the user configured inside it, so its runs can consume the user's own provider credit. This spec owns *how* the local agent executes; it does not own *which* provider is chosen (credential/provider selection) nor *whether* a run should happen locally (workflow-run orchestration).

## Scope

**In scope**

- Backend selection at dispatch time (the local-agent provider value) and the two auxiliary config fields that parameterize it (which tool to drive; an optional explicit executable path).
- A pluggable backend registry keyed by tool id, with four backends registered at module load and an extension point for future tools.
- Discovering and capability-verifying each tool's executable through one shared, per-tool-parameterized procedure: candidate enumeration, the search-path augmentation, the capability probe, launcher-shim resolution, newest-capable selection, per-tool result caching, and the discovery diagnostics.
- Per-tool display-name and sign-in-guidance metadata, and its degradation on an unrecognized tool identifier.
- Building the child-process invocation: the shared parts (headless single-shot operation, tool denial where expressible, the isolated temporary working directory, the re-entrancy markers) and the per-tool differences (prompt delivery channel, system-prompt handling, tool-specific flags, environment posture).
- Running the child: the argument sanitization and working-directory environment pinning applied at the single spawn boundary, standard-output capture, standard-error tail retention, the wall-clock timeout with graceful-then-forceful termination, and the exit-code interpretation rules.
- Parsing each tool's result into a normalized outcome (text, token counts, cost, stop reason) and classifying failures into a three-way error taxonomy.
- Mapping the outcome into the shared LLM-call result, the model attribution rule, the failure log line, and cleaning up the temporary working directory.
- Fan-out serialization under this provider.
- Mapping an auth failure into a distinct summary-error marker; the no-fallback guarantee.
- The two re-entrancy markers the backend plants, and the set of entry points that detect them and no-op.
- A health probe of the executable exposed by the diagnostic command, and the non-throwing liveness predicate that the interactive setup and repair surfaces consume.

**Boundaries**

- Provider/credential selection priority — which of the three backends is chosen, and the credential-source resolution — is owned by the LLM-credential-priority spec. This spec begins once the local-agent path has already been selected.
- The prompt template library and the model-id resolution are shared with the direct backend and owned elsewhere; this spec consumes them.
- The direct hosted-API call and the proxy-routed call are the sibling backends (their own specs); this spec never falls back to either.
- Whether a workflow run should execute locally at all (the local-run offer / workflow-run orchestration) is owned by the workflow-run specs; this spec only defines execution once the local path is taken.
- How a summary-generation failure marker is subsequently acted upon (retry policy, placeholder writes, the "regenerate" affordance) is owned by the queue-worker / summary-error specs; this spec only defines which marker a failure produces.
- The MCP server's own no-op-in-child behavior is described in the MCP tool-surface spec; this spec owns the marker contract it keys off.
- The storage-layer write boundary that independently refuses to claim a non-project directory is owned by spec 300; this spec only records that it is a backstop to the re-entrancy guard.

## Data Contracts

### Selection inputs

The backend is reached only when the resolved credential source is the local-agent value (an explicit provider choice). Two further persisted fields parameterize it, both ignored unless the local-agent provider is active:

- **Which tool to drive** — an enumerated identifier with exactly four accepted values: `"claude-code"`, `"codex"`, `"cursor-agent"`, and `"opencode"`. When the field is absent the default is `"claude-code"`. An unrecognized value is rejected at config-set time with a message listing the valid values, which are themselves derived from the per-tool metadata table so the two cannot drift.
- **An optional explicit executable path** — overrides automatic discovery. When set, no discovered candidate is considered.

Both fields are threaded through the credential-field extraction helper alongside the provider choice, so a call site that copies credentials cannot silently drop them.

There is no per-tool model setting. The single global model setting is the only model input, and only one tool actually receives it (see *Model attribution*).

### Resolved executable

A discovered executable is represented by its filesystem path, a version string, and an optional list of **leading launcher arguments** that must precede the tool's own flags. The launcher arguments are empty for a self-contained binary and populated when the discovered launch target is an interpreter running a script. A resolution is "resolved" only after a capability probe confirms the launch command runs.

### Per-tool metadata

One table maps each tool identifier to a short display label and an actionable sign-in hint. Both lookups degrade to generic copy on an identifier outside the table rather than failing: the identifier arrives from the machine-global config (shared across surfaces *and across versions*) and from persisted summary metadata, so a value written by a newer build and read by an older one — or a hand-edited config — is reachable, and an unguarded lookup there would hard-crash the status, diagnostic, and footer surfaces.

### Completion request

A single request carries the template-filled prompt text, a model identifier (possibly empty), and a fixed system prompt. There is deliberately **no** output-token cap: no driven CLI exposes a per-call max-output-tokens control, so the API path's max-tokens budget (and its truncation stop-reason) do not apply here.

### Normalized outcome

Parsing a tool's result yields: the completion text, input-token count, output-token count, a combined cached-token count, a cost figure in the local currency unit, and a stop reason (or none). Only one tool reports a cost at all; for the other three the figure is always zero, and two of them report no stop reason. This is mapped into the shared LLM-call result, which additionally records the provider source label and the tool identifier; the cost figure has no field in that shared result and is surfaced only in a diagnostic log line, since local-agent spend bills the tool's own account rather than a metered key.

### Error taxonomy

Three failure classes are distinguished:

- **Setup error** — the executable is missing, too old, not a working CLI, unparseable/absent output, or a nonzero exit with no output. Not recoverable by retry.
- **Auth error** — the tool's login has expired or is not signed in; the user must sign in. Three of the four tools can produce this class; the fourth never does (see *Result parsing*).
- **Transient error** — a timeout, rate-limit, or overloaded condition. Labeled for the diagnostic message only; it does **not** today drive a distinct retry-later path (the queue treats every LLM failure uniformly).

### Re-entrancy child markers

Two independent markers mark a run as jollimemory-spawned:

- **An environment marker** set on the spawned child and, by inheritance, on every process that child transitively spawns.
- **A marker file** planted inside the throwaway working directory, named with a leading dot.

Presence of either means "this process descends from a jollimemory-spawned local agent and must not re-enter jollimemory."

## Behavior

### Backend registry

Backends are registered under a string tool id in a process-wide registry; all four are registered at module load. Looking up an unknown id raises a setup error naming the available ids. The registry is the extension point for future tools; the user-facing tool lists are derived from the per-tool metadata table instead.

### Executable resolution

All four tools resolve through **one shared procedure** parameterized per tool by: the binary name, the well-known install locations to stat directly, the capability-probe arguments, and an optional rule for resolving a launcher shim to a native launch target.

1. **Candidate enumeration.** If an explicit path is configured it supplies the candidates (see *Explicit override*). Otherwise the platform's native path-lookup utility is run for the binary name — asking for *all* matches on POSIX, the single native match on the other platform — and its results are unioned with the tool's well-known install locations that actually exist. Duplicates are collapsed. A lookup that errors is not fatal: it is logged with the reason (so "the lookup failed" is distinguishable from "the lookup found nothing") and enumeration falls through to the known locations.

2. **Search-path augmentation (POSIX only).** The lookup is not run against the bare inherited search path but against that path unioned with a fixed list of well-known install directories: the user's `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `/opt/homebrew/sbin`, the user's `~/.npm-global/bin`, and the resources directory inside the ChatGPT desktop application bundle (where one of the tools ships). Inherited entries are kept first, since path order is the lookup's own precedence. The reason is measured, not theoretical: an editor launched from a desktop launcher rather than a shell inherits a minimal search path with no package-manager or per-user bin directories, so a bare lookup reports a perfectly good install as absent. On the other platform the path is passed through **unchanged** — discovery there relies on the native lookup plus the tool's own known locations. The augmented path is used **only for the lookup**: the capability probe and the real child both run with the inherited search path, so a tool found only via an augmented directory is still launched by its absolute path. Before the augmented value is handed to the lookup, every case-variant of the path key is removed from its environment so it cannot be shadowed.

3. **Launcher-shim resolution (non-POSIX only).** A native executable image is a launch target as-is. Anything else — a batch launcher, a script, an extensionless stub — is **never spawned**: a batch launcher cannot be handed to the process spawner without routing through a shell, and routing a multi-kilobyte dynamic prompt through a shell's metacharacter parsing is a command-injection surface, since three of the four tools pass the prompt as a positional argument. But such a file *is* proof of an install and a map to the real binary, so each one is handed to the tool's resolution rule, which returns zero or more native launch targets. Two tools define such a rule and two do not:
   - The Cursor tool's rule walks the sibling per-version directories of the launcher, offering, for every version directory that holds both the bundled interpreter and the entry script, **two** candidates over that interpreter — one with the system-certificate-store option and one without — so the probe rather than a guess decides which the bundled interpreter accepts. Version directories are offered newest-first (their names are date-stamped, so descending lexicographic order is chronological), which does not change which candidate wins but makes the diagnostics read in the order a human expects.
   - The OpenCode tool's rule maps a package-manager shim to the package's own native binary one level down, with no launcher arguments.
   - Claude Code and Codex define **no** rule, so a non-executable-image path discovered for them resolves to nothing and is dropped.
   Every resolved target goes through the same capability probe as a natively-discovered one, so a wrong guess is rejected rather than trusted. Identical launch commands are collapsed — sibling shims routinely converge on one binary — keyed on the whole command (target plus launcher arguments) so one tool's two argument shapes over the same interpreter stay distinct. Natively-discovered images are ordered ahead of shim-resolved ones.

4. **Capability probe — deliberately asymmetric.** Each candidate is invoked directly (never through a shell), with its launcher arguments followed by the tool's probe arguments, under a bounded per-candidate timeout. **Only Claude Code is probed with the real non-interactive run flags plus a version query**, so a CLI too old to accept the non-interactive setting is correctly classified incapable. The other three are probed with a **bare version query only**. The consequence is real and unmitigated: for those three, an installed-but-too-old CLI passes discovery and fails at the first actual generation instead, surfacing as a run-time setup failure rather than a discovery failure. The reported version is the first whitespace-delimited token of the probe output; empty output fails the probe, and a token that is not dotted-numeric ranks as zero, so among such candidates discovery order alone decides.

5. **Selection.** Among capable candidates, the **newest version wins**; discovery order is only a tie-break, which is how the Cursor rule expresses its preference for the system-certificate-store argument shape and how natively-discovered images outrank shim-resolved ones.

6. **Failure.** If no capable candidate survives, an actionable warning is logged separating "nothing was discovered at all" from "a binary was found but failed the probe", and a setup error is raised — worded to distinguish "your configured path is not a working CLI" from "no compatible CLI found; install/upgrade it or switch provider."

### Explicit override

A configured explicit path replaces enumeration entirely. On the non-POSIX platform it gets the **same shim resolution** as auto-discovery unless it already names a native executable image: for some tools no native image exists to point at (a real install is a batch launcher plus a script at the top level and an interpreter plus an entry script one level down), so taking the override verbatim would leave the escape hatch — the thing a user reaches for precisely *because* auto-discovery failed — with no working value on that platform. Resolution is best-effort: when it yields nothing, the verbatim path is used as the single candidate so the probe still runs and the resulting error names what the user actually configured. A tailored platform hint ("this must be a real executable image; a launcher cannot be run directly") is appended to that error only when resolution was attempted and produced nothing — it is suppressed once resolution succeeded (there the launcher was fine and the real binary behind it is what failed) and on POSIX, where the constraint does not exist.

### Resolution cache

A successful resolution is cached with a time-to-live in a **single most-recent slot**, keyed by the tool's binary name *and* the override path (empty for default discovery). Including the tool in the key is what stops one tool's binary from being served for another; because there is only one slot, alternating between two tools simply misses the cache and re-probes each time. Failures are never cached, so a fresh install or upgrade is picked up on the next call.

### Discovery diagnostics

Each discovery emits exactly one diagnostic line naming the tool, the number of candidates and each one **rendered the way it will actually be spawned** (launcher arguments included — a bare target path is actively misleading for a shim-resolved tool, since it reads as the wrong binary having been picked), which discovered paths were treated as launcher shims, which well-known install locations were present, and **the number of search-path entries**. The search path's *contents* are deliberately never logged: the value is an inventory of the machine (account name, every installed tool) and users paste diagnostics into bug reports. The count still makes the failure obvious — a launcher-inherited minimal path is a handful of entries where a shell path has dozens. A line listing shims alongside zero candidates is the signature of "installed, but the launcher could not be resolved", the one case that was otherwise indistinguishable from "not installed at all".

### Invocation construction — shared

Every backend builds its invocation the same way in these respects:

- **Leading launcher arguments** from the resolution are spread ahead of the tool's own flags. The capability probe, all four invocations, and every human-readable rendering of a launch command honour them.
- **Working directory**: a freshly created empty temporary directory, obtained from one shared creation step that also plants the marker file. This isolates the run from the current repository — agent CLIs auto-discover a project-instruction file from their working directory and fold it into their system prompt, so running in the repo would pollute the completion and burn tokens. The directory is removed after the run.
- **Environment**: a copy of the parent environment with the re-entrancy environment marker added, and with a per-tool scrub list removed (see the per-tool subsections).
- **Model**: the tool's model flag is emitted only when the model identifier is non-empty (see *Model attribution*).
- **No output-token cap** is expressible on any of the four.

### Invocation construction — Claude Code

- Prompt delivered on the child's **standard input**.
- The fixed system prompt is passed through the tool's **own dedicated system-prompt flag**.
- Headless single-shot operation with machine-readable output; the resolved model pinned; an **empty tool allow-list** (which matches no real tool, denying all tool use); a non-interactive permission mode, so even an attempted tool call never prompts; and session persistence disabled. This is a pure text completion; the agent must not touch the filesystem or shell.
- Environment scrub: a hosted-API key, a hosted auth token, a base-URL override, a stale parent OAuth token, and the "already inside an agent session" marker are all removed — the key or token would bill the API instead of the subscription, the base-URL override would route to a third-party gateway with no credentials, and either of the last two breaks the spawn outright.

### Invocation construction — Codex

- Prompt delivered as a **trailing positional argument**.
- The tool exposes **no** system-prompt flag, so the fixed system prompt is **prepended to the prompt text**.
- Flags: non-interactive execution, event-stream output, the repository-check skip (the working directory is not a repo), a read-only sandbox, and the working directory passed **explicitly as a flag** in addition to being set on the child, because this tool resolves relative paths and repository context from its working directory.
- Environment scrub: the hosted provider's API key and base-URL override.

### Invocation construction — Cursor

- Prompt delivered as a **trailing positional argument**.
- No system-prompt flag; the fixed system prompt is **prepended to the prompt text**.
- Flags: print (headless) mode, machine-readable output, and **workspace trust pre-granted**. The trust flag is the one that suppresses the trust gate over an unfamiliar directory — deliberately not the command-approval/auto-run flag, which governs something else entirely; the freshly-created temporary working directory trips the trust gate without it.
- Environment scrub: the tool's own API key, so a leaked key can never proxy the run away from the subscription login.

### Invocation construction — OpenCode

- Prompt delivered as a **trailing positional argument**.
- No system-prompt flag; the fixed system prompt is **prepended to the prompt text**.
- Flags: the bare run subcommand. There is no structured-output option to request.
- Environment: **nothing is scrubbed.** This tool authenticates against whichever LLM provider the user configured inside it, either from its own stored credentials or from provider keys supplied through the environment; scrubbing would break the environment-key logins. The consequence is that a run under this tool can spend the **user's own provider credit** rather than a flat subscription.

### Running the child

The child is spawned hidden with piped standard streams; the prompt (empty for three of the four tools) is written to its input, which is then closed.

Two normalizations are applied at this **single spawn boundary**, so they cover every backend at once:

- **Null bytes are stripped from every argument.** The platform rejects an argument containing a null byte outright, before the child starts; three of the four tools pass the prompt as an argument, and the content being summarized (binary diffs, transcripts) can carry stray null bytes. The standard-input prompt is deliberately **not** sanitized — it is a byte stream with no such restriction.
- **The working-directory environment variable is pinned to the chosen throwaway directory, and the two sibling variables that leak the parent's location are removed.** Setting the child's working directory alone does not isolate it: agent CLIs commonly resolve their working directory from that environment variable instead of the kernel's, and every backend copies the parent environment wholesale — so a hook or worker whose value points at the user's repository silently drags the agent back into it. This is measured, not defensive: one tool spawned with the temporary working directory but the inherited variable still naming the repo bound its session to the repo, read its sources, and wrote a file there.

Then:

- Standard output is accumulated as raw bytes and decoded once at the end (so a multi-byte character split across chunks is not corrupted). Standard error is kept as a rolling tail of the last few kilobytes, decoded incrementally with partial code points carried across chunks and flushed at close.
- A wall-clock timeout (defaulting to the same absolute cap as the direct streaming path, i.e. minutes-scale, because a local agentic turn is routinely multi-minute) fires a graceful termination signal, then a forceful kill after a short grace period, and rejects with a **transient** error.
- On exit: a clean exit resolves the captured output. A **nonzero** exit that nonetheless produced output **also resolves** it — because a driven CLI can report auth/API failures as an error envelope on standard output while exiting nonzero, and only the backend's parser can interpret that envelope; discarding it would strip an expired-login failure down to an opaque exit code. Only a nonzero exit with **no** output is a true opaque failure and rejects with a **setup** error carrying the exit code and standard-error tail.
- A spawn failure (the executable could not be launched) rejects with a **setup** error.
- A broken-pipe error on the input stream (the child closed input before consuming the whole prompt, e.g. on a fast auth failure) is swallowed with a warning; the real outcome is still carried by the exit handler, and leaving it unhandled would crash a detached background worker.

### Result parsing and failure classification

Each backend parses its own output shape.

**Claude Code** — a single machine-readable result envelope:

- Unparseable output → **setup** error (with a truncated preview).
- An error envelope → classified: an unauthorized/forbidden status → **auth** error; a rate-limit or server-error status → **transient** error; otherwise, if the detail text matches stable "not signed in / log in / unauthorized / invalid key / authenticate" phrasings → **auth** error (a not-signed-in failure sometimes arrives with no HTTP status); otherwise → **setup** error.
- A success envelope → the normalized outcome, including a real cost figure, a combined cached-token count from both cache-read and cache-creation counts, and the reported stop reason.

**Codex** — a per-line event stream, parsed line by line with unparseable lines skipped:

- The final assistant-message completion event supplies the text; an event of that shape carrying no text deliberately cannot blank text already captured from an earlier one.
- The turn-completed event supplies the token counts, including a cached-input count.
- Any event whose type or message contains **both** error vocabulary and sign-in vocabulary → **auth** error.
- **No parseable event at all** → **setup** error (with a truncated preview).
- Cost is always zero and no stop reason is reported.

**Cursor** — a single result envelope whose usage fields are camel-cased (distinct from Claude Code's):

- Unparseable output → **setup** error (with a truncated preview).
- An error envelope → **auth** error when the detail text or the envelope subtype matches the sign-in vocabulary, otherwise **setup** error.
- A success envelope → text, camel-cased token counts (cache-read plus cache-write as the combined cached count), zero cost, and **the envelope's subtype used as the stop reason**.

**OpenCode** — no envelope at all: the trimmed standard output *is* the completion text, with all token counts and the cost zeroed and no stop reason.

- Its **only** detectable parse failure is **empty output**, raised as a **setup** error. This tool therefore never produces an auth classification: a real provider/auth failure surfaces on standard error with empty standard output, which the runner has already rejected as a setup error before the parser runs. An earlier attempt to sniff auth vocabulary out of its plain text was removed because against real output it could only false-positive on a summary that happens to mention signing in, never match a true failure.

Both auth and setup are non-retryable, so a misclassification only degrades the message, never the retry decision.

### Dispatch and result mapping

Once selected, the local-agent path mirrors the direct path's preamble: it resolves the template for the requested action (raising on an unknown action), warns on any unfilled placeholder, fills the prompt, and resolves the model id. It does **not** thread an output-token cap (unsupported by every tool). It then reads the configured tool (defaulting to Claude Code), looks up its backend, discovers the executable (honoring the optional configured path), builds the invocation, runs it, parses the outcome, logs a completion line including the parsed cost, the tool, and the token counts, and returns the shared result with the provider source label and the tool identifier attached.

**Model attribution.** Only Claude Code is handed the resolved model identifier. The other three receive an **empty** model, which makes each of them omit its model flag entirely, so they run whatever model the user configured *inside* that tool. Nothing reads that model back. The completion result nevertheless still reports the model identifier resolved under Claude-Code semantics, so persisted summary metadata records a model alias that did not produce the text for three of the four tools.

**On any failure it throws** — it never falls back to another provider, so the user is never silently billed on a hosted-API key. A failure that happens *after* a successful resolve is first logged as one line carrying the action, the tool, the launch command rendered with its launcher arguments, the elapsed time, the error class name (so the classification is readable without decoding the message), and the message; the error is then rethrown unchanged. Discovery failures throw earlier and are logged by the resolution step instead.

The temporary working directory is removed in a cleanup step that runs on success, failure and timeout alike, but **only** if it is under the system temp directory and its name carries the backend's reserved prefix (guarding against deleting an unrelated directory when a test injects an arbitrary working directory).

### Fan-out serialization

Any LLM fan-out that would run N-wide under a hosted provider is serialized to **one** under the local-agent provider: each call spawns a full CLI agent turn (a real multi-minute process with a large built-in system prompt), so N concurrent spawns would trip the account's rate limit or bury the machine. Every LLM fan-out site now routes its concurrency through this provider-aware limit — the per-topic unit calls, the per-category edge calls, and the topic-reconcile calls — so none of them can fan out under this provider.

### Failure-marker mapping

When a summary-generation failure is classified for storage, an auth failure (detected by the error's stable name, not by object identity — because the bundling process can produce two copies of the error class where identity checks fail) is recorded as a distinct **auth** summary-error marker so surfaces can show sign-in guidance; every other failure is recorded as the generic LLM-failure marker. Since OpenCode never produces the auth class, a sign-in failure under that tool is always recorded as the generic marker.

### Re-entrancy guard

Most users also have the product's own integration installed for the very tools this backend drives (hooks, an enable path, an MCP server registered machine-wide). Without a guard the nested tool re-triggers the product against the throwaway temporary working directory — recording sessions, running enable, and rooting storage there, which claimed a spurious Memory Bank "repo" named after the temp directory on every summary call. The guard therefore uses **two independent channels**:

- **The inherited environment marker** covers everything the agent CLI spawns *itself*, since hooks inherit the environment.
- **A marker file inside the throwaway working directory** covers the case the environment channel cannot: a host that spawns its MCP servers under a fixed environment allowlist strips the marker outright. That is a measured failure, not a hypothetical — with the environment-only guard already in place it leaked one permanent Memory Bank folder per generation call, accumulating well over a hundred of them for one user. The working directory is the one thing every host preserves (one host is even handed it explicitly), so any future host with its own environment policy is covered without a new special case.

All four backends obtain the working directory from **one shared creation step** that always plants the marker file, so a future fifth backend cannot create a working directory that forgets it — the failure mode that silently leaks a permanent folder per call. The marker is a **dotfile deliberately**: agent CLIs fold a working-directory instruction file into their system prompt, and the working directory is kept otherwise empty for exactly that reason, so an inert dotted name is the only safe shape.

Each entry point a nested tool could re-trigger checks the guard and **no-ops**:

- the agent session-start hook,
- the agent stop hook,
- the plugin bootstrap hook,
- the enable command,
- the MCP server startup.

The file probe is **opt-in per call site**, and the split is deliberate: the hooks, the bootstrap and the enable command are spawned by the agent CLI itself — our own direct child, with the environment we set — so they pass no working directory and stay environment-only. Only the long-lived MCP server, which is spawned by the *host* rather than by our child, supplies a working directory and consults the marker file. Keeping the probe opt-in also means the guard cannot be flipped by a caller that stubs filesystem existence checks for unrelated reasons. The probe checks the given directory itself and deliberately **does not walk up to a parent**: a stray marker higher in the tree would otherwise silently disable the product for every repo nested beneath it.

The marker file's **only** removal path is the recursive deletion of the whole working directory in the call's cleanup step. **No sweep exists**: a hard kill of the parent (or a crash before cleanup) leaks that directory permanently, with its marker still in place. Conversely, a directory carrying the reserved prefix but **missing** the marker is **not** treated as re-entrant — only the marker's presence counts, never the name.

The guard is independent of whether the temporary directory happens to be a git repo and of which hook modes a future tool version fires. Independently of it, a storage-layer write boundary now refuses to claim a non-project directory at all; that is a backstop, not part of this guard — see spec 300.

### Diagnostic probe

The diagnostic ("doctor") command, when the active provider is local-agent, does not stop at "provider selected": because the "credential" here is an executable rather than a stored key, it labels the provider with the configured tool's display name and additionally runs the executable resolution for that tool (cheap, and it verifies the flags are accepted). On success it reports the launch command **rendered with its launcher arguments** — a bare target path would read as the wrong binary having been picked for a shim-resolved tool — plus the version. On failure it reports a failing check carrying the resolution error *and* that tool's sign-in hint, so it never reports healthy while every commit silently fails with a setup error (spec 59). This is the only surface that consumes the per-tool sign-in hints.

### Liveness predicate for interactive callers

The executable resolution is additionally exposed as a **non-throwing boolean liveness predicate**: "is a usable agent CLI present right now?", taking the same optional explicit-path override. It is a plain success/failure wrapper — it performs the identical candidate enumeration and capability probe, and simply reports `false` instead of raising the setup error.

**It is hard-wired to Claude Code's discovery and probe rules and does not consult the configured tool identifier.** So for a user who selected any of the other three tools, the predicate answers a question about a CLI the run will not drive: it can report "cannot generate" while the configured tool works, and "can generate" while the configured tool is absent. Only the diagnostic command probes the tool that will actually run.

Two interactive surfaces consume it, and both would otherwise have to catch an error to ask a yes/no question:

- the fresh-configuration auto-detect in the first-time provider setup wizard (spec 57), which selects the local-agent provider without asking when the answer is yes — and which is the one place where the Claude-only wiring is exactly right, since that auto-detect is specifically choosing Claude Code;
- the shared "can generate right now" predicate (spec 291), which is why that predicate deliberately diverges from dispatch-time provider selection (spec 10) for this provider only.

**The caching asymmetry is operative here, not incidental.** Because a resolution is cached only *after* it succeeds, a **success** is served from the time-bounded most-recent slot while a **failure is never cached at all**. That is precisely what makes the repair ladder's single one-shot re-probe meaningful: a user who installs, upgrades, or signs in to the agent CLI in another terminal and then answers "retry" gets a genuinely fresh answer rather than a replayed failure. Conversely, a user whose agent CLI *stops* working within the cache window can still be told it is usable.

## State Transitions

The backend is stateless per call except for the module-level executable-resolution cache (TTL-bounded, single most-recent slot keyed by tool plus override path, success-only). A call proceeds: select → look up the tool's backend → resolve executable (cache hit or probe) → build invocation (create temp working directory with its marker, scrub env per tool, set the env marker) → run child (sanitize arguments, pin the working-directory variable) → parse → map result → cleanup working directory. A failure at any stage throws the appropriate taxonomy error and still runs cleanup. No provider preference is learned or persisted.

## Notable Behavior

- **No output-token cap exists on this path**, so the truncation stop-reason that the hosted path can emit never appears here.
- **A nonzero exit is not automatically a failure** — an error envelope on standard output is authoritative over the exit code, and the parser (not the runner) decides.
- **Auth failures are pattern-matched against sign-in vocabulary**, because a local not-signed-in condition routinely arrives with no HTTP status. For Claude Code that matching is a fallback behind the status codes; for Codex and Cursor it is the only mechanism there is.
- **The capability probe is asymmetric by tool.** Only Claude Code is probed with the flags a real run passes; the other three get a bare version query, so for them an installed-but-too-old CLI passes discovery and fails at the first real generation instead.
- **On the shim-restricted platform, launcher shims are resolved rather than excluded.** A shim is still **never spawned** — that constraint is preserved precisely because a dynamic prompt must never be routed through a shell — but two of the four tools carry a rule that maps a discovered shim to native launch target(s), and an explicit configured path is resolved the same way with a verbatim fallback. Every resolved target is capability-probed like any other, natively-discovered images are ordered ahead of resolved ones, and identical launch commands are collapsed. For the two tools with no such rule, a *discovered* non-executable-image path is dropped entirely; an override pointing at one falls through to the verbatim path and simply fails the probe, with the platform hint appended.
- **Only one tool is told which model to use.** The other three are handed an empty model and omit their model flag, running whatever the user configured inside the tool — and there is no per-tool model setting to change that. The completion result still reports the model alias resolved under the first tool's semantics, so persisted metadata attributes a model that did not produce the text.
- **One tool deliberately keeps provider credentials in the child's environment**, because it authenticates against whichever provider the user configured inside it and scrubbing would break environment-key logins. A run under it can therefore spend the user's own provider credit rather than a flat subscription.
- **That same tool has no auth classification at all.** Its only detectable parse failure is empty output, raised as a setup failure, so no sign-in-specific surface can ever fire for it.
- **The provider never falls back.** A local-agent failure surfaces as an error; it is never retried on a hosted API key or the proxy. It is logged once (action, tool, rendered launch command, elapsed, error class, message) and rethrown unchanged.
- **Fan-out is forced to serial** under this provider, at every LLM fan-out site.
- **Cost is observable only in logs**, since the shared result has no cost field and the spend is on the tool's own account — and only one of the four tools reports a cost at all.
- **The temp working directory is deleted only when it matches the backend's own prefix under the system temp dir**, never blindly.
- **Newest capable executable wins**, with discovery order as a tie-break.
- **Successes are cached, failures never are** — and the cache is a single most-recent slot keyed by tool plus override path, so alternating between two tools always re-probes. The trade-off is that a CLI which breaks inside the cache window is still reported usable until the entry expires.
- **Null bytes are stripped from arguments but not from the standard-input prompt**, at the one spawn boundary that owns the constraint.
- **The working-directory environment variable is pinned and its two parent-location siblings removed**, because a tool that resolves its session directory from that variable otherwise binds to the user's repository, reads its sources, and writes into it.
- **The re-entrancy guard has two channels because one is not enough.** The environment marker is inherited transitively but is stripped by a host that spawns MCP servers under a fixed environment allowlist; the working-directory marker file survives that hop.
- **A leaked working directory is permanent.** The marker file is only ever removed by deleting the whole directory in the call's cleanup step, and no sweep exists — a hard kill leaks one directory per interrupted call, forever. A directory with the reserved prefix but no marker is not treated as re-entrant.
- **The search path's contents are never logged, only its entry count**, because the value inventories the machine and users paste diagnostics into bug reports.
- **Unknown tool identifiers degrade rather than crash** in the display-name and sign-in-hint lookups, because the identifier arrives from a machine-global config shared across surfaces *and versions* and from persisted metadata, so a newer build's value read by an older build is reachable.
- **The liveness predicate ignores the configured tool.** It always probes Claude Code, so for the other three tools it can disagree in both directions with what a real run would do; only the diagnostic command probes the tool that will actually run.

## Shared Behavior

- Which provider (this backend vs. the direct hosted API vs. the proxy) is selected, and the credential-source priority, are owned by the LLM-credential-priority spec (10).
- The interactive surfaces that consume the liveness predicate are owned elsewhere: the first-time provider setup wizard and its fresh-configuration auto-detect by spec 57, and the shared can-generate predicate plus the repair ladder's one-shot re-probe by spec 291.
- The prompt template library and the model-id resolution are shared with the direct backend.
- The summary-error marker's downstream handling (retry policy, placeholder writes, regenerate affordance) is owned by the queue-worker / summary-error specs. The remediation copy shown for an auth marker is owned by spec 286 — including the fact that it is authored for one tool only.
- The MCP server's own no-op-in-child behavior is described in the MCP tool-surface spec; the markers it keys off are defined here.
- The storage-layer write boundary that independently refuses to claim a non-project directory — the backstop behind this guard — is owned by spec 300.
- Whether to run a workflow locally at all is owned by the workflow-run / local-run-offer specs.
