# 206. Telemetry Startup and Command Instrumentation

## Topic Statement

Bootstrap the telemetry context once per process by resolving the anonymous identity, the consent state, and the reporting environment, and emit the catalog's events at the lifecycle and feature points across all three surfaces — including an automatic per-command event — with each event carrying only bucketed or boolean properties.

## Scope

**In scope:**

- The one-call startup bootstrap: what it resolves (config, install identifier, reporting origin/environment), the once-per-machine install event, and its never-throw guarantee.
- The per-surface startup wiring (command-line, editor, JVM IDE) and the periodic/lifecycle flush hooks they install.
- Minting and sharing of the per-machine anonymous install identifier, including the race-free first-run arbitration.
- The reporting-origin resolution precedence and its mapping to the environment label.
- The automatic per-command instrumentation: what fires it, what it records, and why a failing command does not fire it.
- The per-event property contracts for every emission site in the catalog (which bucket/boolean each carries).
- The first-machine-only deduplication of the AI-source-detected event.
- Mid-session re-evaluation of the environment and consent after sign-in or a host-setting change.

**Out of scope (boundaries):**

- The consent gate and opt-out channels themselves (covered by **Telemetry Consent and Opt-Out**); this spec only notes that bootstrap feeds them and that the install identifier is minted unconditionally.
- The buffer and the send transport (covered by **Telemetry Event Buffering and Flush**).
- The envelope shape, the anonymization toolkit, and the registry of names (covered by **Telemetry Event Catalog**).
- The user-facing telemetry command (covered by **CLI Telemetry Command**).

## Data Contracts

### Bootstrap inputs and resolved context

The bootstrap resolves and caches a process-level context for the recording choke point:

| Resolved value | Source |
| -- | -- |
| Consent (enabled + reason) | The consent gate, fed the loaded config, the environment, and the host-platform opt-out signal. |
| Project directory | Passed in by the caller; the buffer for this project lives under it. |
| Install identifier | Minted-once-per-machine anonymous UUID. |
| Session identifier | The current AI/editor session id, when known. |
| Surface + version | Derived from the client-identification string. |
| Environment label | Derived from the resolved reporting origin via the origin allowlist. |

Bootstrapping is idempotent — a later bootstrap replaces the cached context (used to pick up a changed origin after sign-in or a changed host signal mid-session).

### Install identifier minting (race-free, once per machine)

The install identifier is a random UUID stored in the machine-global config, shared by all surfaces:

- If the config already carries an identifier, it is returned with "not created".
- Otherwise the mint is arbitrated by an OS-atomic **exclusive create** of a sentinel file: exactly one concurrent first-run (e.g. the post-commit worker and the editor activating at the same time) wins the create and reports "created"; losers read the winner's identifier from the sentinel and report "not created". The identifier is then persisted to config if not already equal.
- "Created" is true only on the single minting run, which is the signal to fire the once-per-machine install event.

Minting is always safe to do, even while opted out: the identifier is inert (a local random value) until a flush would send it, and the consent gate blocks that flush when opted out.

### Reporting-origin resolution precedence

The reporting origin (which maps to the environment label) is resolved in this order:

1. If a product API key is configured and decodes, its embedded tenant origin.
2. Else, a configured product URL if present.
3. Else, the default resolved product URL — unless that throws (off-allowlist or unset with no default), in which case the origin is undefined and the environment label becomes `unknown`.

The environment label is derived from the origin's host against the allowlist: a `local`/`dev`/`preview`/`prod` host maps to the matching label; anything else (or no origin) is `unknown`. (The exact host-to-label mapping is owned by **Telemetry Event Catalog** / the origin allowlist.)

### Per-command instrumentation

A single pair of lifecycle hooks is registered once on the root command program, so every command — present, future, and plugin-contributed — is auto-tracked with no per-command code:

- A pre-action hook stamps a start time for the about-to-run command.
- A post-action hook (which the command framework runs only on the **success** path) emits `command_invoked` with:
  - the command path (the space-joined command name excluding the root program, e.g. `recall` or `auth login`) under a property literally named `command`,
  - a millisecond duration computed from the stamped start, and
  - a boolean success flag (true).

The property is `command`, not `name`, because the backend scrubber treats a property literally called `name` as PII and drops it; `command` survives. The command path is always a fixed identifier from the product's own surface, never user input.

A command that throws does not fire the post-action hook (the framework skips it on failure), so the command-line top-level catch emits `command_invoked` itself with the same command path, the measured duration, and `ok: false` — every command produces exactly one completion event (`ok: true` on success, `ok: false` on failure). The `mcp` command is the exception: neither the success nor the failure path emits `command_invoked` for it, because the MCP server records a per-tool-call event instead.

### Event property contracts (all emission sites)

Every event ships only bucketed or boolean properties:

| Event | Properties |
| -- | -- |
| `app_installed` | (none) — fired only on the install-identifier minting run. |
| `command_invoked` | `command` (command path), `duration_ms`, `ok` (boolean — true on success, false when the command threw). |
| `signin_started` | `trigger` (the originating surface, e.g. `cli` / `intellij`). |
| `signin_completed` | `api_key_minted` (boolean — whether a key was returned). |
| `signed_out` | (none). |
| `ai_provider_selected` | `provider` (the chosen provider). |
| `surface_enabled` | `trigger` (e.g. `cli`). |
| `surface_disabled` | `reason` (e.g. `manual`). |
| `recall_performed` | `result_count_bucket` (bucketed result count), `hit` (boolean — any results). |
| `search_performed` | `result_count_bucket` (bucketed hit count), `query_len_bucket` (`short`/`medium`/`long`). |
| `memory_pushed` | `kind` (e.g. `summary`). |
| `export_performed` | `format` (e.g. `markdown`). |
| `ai_source_detected` | `source` (the AI source kind). |
| `settings_opened` | `tab` (e.g. `general`). |
| `memory_bank_migrated` | `repos` (count), `outcome` (`completed`/`partial`), `entries_bucket` (bucketed migrated count). |
| `onboarding_progressed` | `in_git_repo`, `repo_enabled`, `capture_configured`, `memories_generated` (booleans), `capture_method` (`local-agent`/`anthropic`/`jolli`/`none`), `memories_bucket` (bucketed stored-memory count). |
| `ingest_completed` | `outcome` (terminal code), `duration_ms`, `batches`, `ingested`, `touched_slugs`, `route_calls`, `reconcile_calls`, `topic_failures` (count). |
| `error_occurred` | `code` (the structured error/outcome code), `where` (the subsystem — `ingest`, `push`, or `signin`). |
| `queue_drained` | `ops` (count of processed ops), `duration_ms`. |
| `sync_completed` | `outcome` (the new state, or `failed`), `duration_ms`. |

The search query is never sent — only its length bucket. Counts are bucketed where noted; the raw integer counts in the ingest event are pipeline-health metrics, not content. All property bags are additionally run through the property scrubber before recording (see **Telemetry Event Catalog**).

## Behavior

### Command-line startup

On every command-line invocation, in order, before command dispatch:

1. Show the once-per-machine first-run disclosure (see **Telemetry Consent and Opt-Out**) — placed first so a single-command user sees it before the first install event is buffered.
2. Bootstrap telemetry for the **resolved repository root** of the launch directory — not the raw process working directory (see spec 311) — which loads config, mints-or-reads the install identifier, resolves the origin/environment, primes the context, and — if this run minted the identifier — emits `app_installed`. This is the same value every command's `--cwd` option defaults to, which is what keeps the buffer this bootstrap writes to and the buffer the commands write to a single file (spec 204).
3. Register the per-command auto-emit hooks on the root program.
4. Dispatch the command. The post-action hook emits `command_invoked` on success.
5. On process exit (after the command completes on either path), flush the shared telemetry buffer once with a short bounded timeout, addressed by the **same resolved repository root** the bootstrap used, unless the resolved command is in the telemetry group or the run explicitly opted out. On the failure path the `command_invoked { ok: false }` event is recorded before the flush. The skip keys off the parsed command, not an argv position.

The bootstrap is wrapped so a telemetry error never blocks startup; the auto-emit hooks are harmless when telemetry was never bootstrapped (the choke point is a no-op until then).

### Worker startup and flush

The long-lived post-commit worker bootstraps telemetry first (so ingest-path events emit in the worker process), then drains its work, then flushes the buffer once on completion — the natural send point for events that short-lived hook invocations only buffered. The whole chain is best-effort and never blocks exit on a telemetry error.

### Editor startup and flush

On activation the editor bootstraps telemetry with the host opt-out signal, shows the first-run notice once (see **Telemetry Consent and Opt-Out**), and subscribes to the host telemetry-setting change so a mid-session toggle re-bootstraps with the new signal. A flush runs on activation and on a 60-second extension-level interval regardless of panel visibility, threading the live host opt-out signal each time; the visibility-gated sidebar-tick flush remains as an additional path.

### JVM-IDE startup and flush

The plugin bootstrap mints-or-reads the install identifier (firing the install event once), primes the context with the plugin version as the surface version and the IDE data-sharing decision as the host signal, and returns whether to show the first-run notice. After a sign-in saves a new key the plugin refreshes only the cached environment from the new tenant origin (preserving identity and consent), so the conversion event carries the new tenant's environment rather than the startup origin's. A lifecycle flush hook flushes once on project open and re-reads the IDE data-sharing decision at flush time; in addition, a 60-second background flush is scheduled off the UI thread and tied to the project lifecycle (cancelled on project close), so the buffer drains even while the tool window is closed, and this recurring flush also re-reads the IDE data-sharing decision at flush time.

### Sign-in / sign-out instrumentation

- The sign-in initiation emits `signin_started` with the originating surface as `trigger`.
- A completed sign-in emits `signin_completed` with `api_key_minted` reflecting whether a key was returned — the conversion event. The JVM IDE refreshes the environment immediately before this so the event carries the right tenant environment.
- **A failed sign-in on the JVM IDE surface emits `error_occurred` with `where: signin`.** The `code` preserves the callback's own classified failure code (`invalid_callback`, `failed_to_get_token`, `access_denied`, a server-supplied code, …) so the sign-in funnel keeps the specific reason instead of collapsing every rejected callback into one opaque bucket; it falls back to `server_error` only when no classification was available (the shared runtime was unreachable, timed out, or answered unreadably). A reported success whose payload carried **no token** is a distinct failure mode and gets its own code, `no_token`, rather than reusing the generic bucket. The error event is emitted **before** the UI failure callback, so it is buffered even if the caller tears the sign-in listener down synchronously. The conversion event is deliberately *not* emitted by the shared runtime for this surface — doing it in both places would double-count.
- Logging out emits `signed_out`.

### AI-source-detected deduplication

When a transcript-processing pass encounters a session source, it fires `ai_source_detected { source }` only the **first time that machine ever** processes that source, using a machine-global first-seen ledger in the shared config that records each source once. This is additionally gated on telemetry being currently enabled, so an opted-out or un-bootstrapped run never even writes the ledger entry (keeping it out of tests and preventing a later opt-in from missing the event, while never skewing the source-mix view by re-firing).

### Onboarding-funnel emission sites

`onboarding_progressed` has no single choke point — it is emitted from **six** trigger sites, each of which already holds (or can cheaply obtain) a repo context. The dedup ledger, the state signature, the daily heartbeat, and the per-path serialization that make repeated triggers cheap are owned by spec 312; what belongs here is only *where and when* each emit is attempted:

- **The enable command's report tail** — after the enable report is printed, on **both** the success and the error branch, so the "installed but never got into a git repo" drop-off is visible rather than silent. Config is **re-loaded** at this point rather than reused, because the interactive provider setup that may have run earlier in the same invocation can have just added the capture credential the snapshot reports on. The `--repo-hooks-only` mode never reaches this tail (it returns from the action before the report); `--integrations-only` does.
- **The guided front door's non-git dead end** — emitted just before the exit code is set. This is the only trigger in the product that ever fires outside a git working tree, so `in_git_repo: false` is observable at all only because of it.
- **The guided front door's entry past the git gate** — emitted for every path that clears the git gate, including the user who then declines to enable, using the front door's own lightweight status rather than the heavy installation probe.
- **The status command** — emitted from the status object it has already computed, so it costs no extra git work. This is the periodic snapshot for an already-active user. It sits *after* the `--json` early return, so the machine-readable mode is silent (see spec 58).
- **The ingest run store's append path** — emitted only when a drain actually ingested something (see spec 152). Idle drains and the credential-missing record do not emit.
- **The two editor surfaces' status refresh** — the editor extension's status store and the JVM IDE's project service both emit from the status they just computed, on every refresh.

One property of this event is a deliberate departure from the model used everywhere else in this spec, where call sites emit unconditionally and the shared recording choke point is what gates on consent: `onboarding_progressed` is the **first** emitter that reads the consent context *itself*. Its entry point short-circuits on "telemetry context absent or not enabled" **before** any git query, any installation probe, and before it takes its ledger lock. The reason is that this snapshot is not free — it can cost a `getStatus()` — and the ledger is a repo-local file write. Gating at the choke point alone would have made an opted-out user pay the probe and acquire a ledger file for an event that could never be sent. As specified, an opted-out user pays nothing and **no ledger is ever written**.

### Pipeline-health instrumentation

- Each ingest drain run flows through one choke point that emits `ingest_completed` with the run's health metrics, and — only when the terminal outcome is a genuine failure (not the normal "ok" or "nothing pending" states) — additionally emits `error_occurred { code, where: ingest }`.
- `error_occurred` has **three** emitters today, not one: the ingest choke point above (`where: ingest`); the JVM IDE push path, on an **unclassified** push failure only (`where: push, code: push_failed`) — the classified push outcomes (binding-required, plugin-outdated, key-rejected) are handled by their own flows and do not raise it; and the JVM IDE sign-in path (`where: signin`, see below).
- The post-commit worker emits `queue_drained` with the processed-op count and duration when a drain finishes.
- A sync round emits `sync_completed` with the resulting state and duration on the success path, and emits it again with `outcome: failed` on the failure path so the sync-health view sees failures, not only successes.

## State Transitions

- **Uninitialized → initialized.** The first bootstrap of a process resolves and caches the context; the choke point goes from no-op to recording (subject to consent).
- **Initialized → re-initialized.** A later bootstrap (post-sign-in origin change, or a host-setting toggle) replaces the cached context; the JVM IDE has a lighter path that refreshes only the environment.
- **Install identifier: absent → minted.** Exactly one first-run mints it (race-arbitrated) and fires the install event; all subsequent runs and all other surfaces read the same identifier and do not re-fire.
- **AI source: unseen → seen.** The first enabled processing of each source records it in the machine-global ledger and fires the detection event; later runs find it seen and do not re-fire.

## Notable Behavior

- **One pair of hooks instruments every command, including future and plugin ones.** Per-command telemetry needs no per-command code. (Notable.)
- **A failing command still emits a completion event, with `ok: false`.** The success-only post-action hook cannot record failures, so the command-line top-level catch emits `command_invoked { ok: false }` itself — every command produces exactly one completion event either way, alongside the dedicated error event at the failure's error choke point. (Notable.)
- **The command-line process flushes telemetry on exit.** After the command completes on either path, a bounded-timeout flush drains the shared buffer, skipping the telemetry command group and any explicit opt-out. (Notable.)
- **The completion event's property is `command`, not `name`.** A property literally named `name` is dropped by the backend scrubber as PII, which would silently lose the command; `command` survives. (Surprising; intentional sharp edge.)
- **The install identifier is minted unconditionally, even while opted out.** It is inert until a flush, which the consent gate blocks when opted out, so minting carries no privacy cost and keeps the identity stable if the user later opts in. (Notable.)
- **First-run minting is race-arbitrated by an exclusive-create sentinel.** Concurrent first-runs (worker plus editor activation) converge on one identifier and fire the install event exactly once, instead of each minting its own and clobbering config. (Notable.)
- **The AI-source event fires once per source per machine and only while enabled.** The machine-global ledger dedupes across runs and surfaces; gating the ledger write on enabled consent keeps an opted-out run from recording it. (Notable.)
- **The environment is re-resolved after sign-in.** A signed-in key's tenant origin overrides the startup origin, so the conversion event reports the right environment. (Notable.)
- **The reporting origin falls back to `unknown` rather than failing.** If no origin can be resolved (off-allowlist, unset, no default), the environment label is `unknown` and telemetry still functions. (Notable.)
- **The sync failure path emits the same completion event with a failure outcome.** Without it the sync-health view would see only successes. (Notable.)
- **The disclosure is printed before the install event is buffered.** Ordering ensures a single-command user sees the disclosure before any event is recorded. (Notable.)

## Shared Behavior

- The consent gate the bootstrap feeds, the opt-out channels, and the first-run disclosure are defined by **Telemetry Consent and Opt-Out**.
- The buffer each event lands in and the flush the worker/tick/lifecycle hooks invoke are defined by **Telemetry Event Buffering and Flush**.
- The envelope each event is wrapped in, the registry of names, the environment-label mapping, and the bucketing/scrubbing applied to every property bag are defined by **Telemetry Event Catalog**.
- The user-facing reporting and toggling of telemetry is defined by **CLI Telemetry Command**.
- The API-key parsing and origin allowlist used to resolve the reporting origin are owned by the auth/origin specs and referenced here only as boundaries.
