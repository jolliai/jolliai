<!-- GENERATED FILE — do not edit by hand.
     Regenerate with `npm run gen:telemetry-doc` (source: cli/src/core/TelemetryEvents.ts). -->

# Jolli Memory telemetry

Jolli Memory collects **anonymous, opt-out, content-free** usage telemetry to
help us understand whether the memory pipeline works in the wild and how the
tools are adopted. This document is the exact, complete description of what is
collected — generated from the event registry the code actually uses.

## What we collect

- A random per-machine identifier (`installId`) and the surface (`cli`,
  `vscode`, or `intellij`) + version.
- Coarse environment facts: OS, architecture, runtime version, and which Jolli
  environment your client is pointed at (`local` / `dev` / `preview` / `prod`).
- The events listed below, each with a small bag of **bucketed or boolean**
  properties (e.g. a result count as `"1-5"`, not the actual number).

## What we never collect

- No source code, file contents, file paths, repository or branch names, commit
  messages, search queries, or AI prompts.
- Counts are bucketed (`"0"`, `"1-5"`, `"6-20"`, …); any identifier that must
  persist is salted-hashed; query lengths are bucketed (`short`/`medium`/`long`),
  never the text. A client-side scrubber additionally drops anything that looks
  like a path, URL, email, or secret, and bounds nesting depth.

## How to turn it off

Telemetry is on by default, but is silenced when any of these is true:

- The `DO_NOT_TRACK` environment variable is set to anything other than `0`.
- You run `jolli telemetry off` (re-enable with `jolli telemetry on`).
- (VS Code) your editor telemetry is disabled (`telemetry.telemetryLevel`).
- (IntelliJ) the IDE data-sharing consent is declined.

The off switch (`telemetry`) and `installId` live in the machine-global
`~/.jolli/jollimemory/config.json`, so the choice is shared across all three
surfaces. Run `jolli telemetry inspect` to print the exact events buffered on
disk **before** they are sent.

## What identifies you

- `installId` — a random UUID minted once per machine. It is anonymous: it is
  not derived from your name, email, hostname, or any account.
- `accountId` — **never sent by the client**. When you sign in, the backend
  attributes events to your account from your API key; until then every event is
  anonymous (`accountId` is null).

## Events

| Event | Description |
| -- | -- |
| `app_installed` | First run after install; installId minted (once per machine). Props: none — count distinct install_id. |
| `client_activated` | A GUI surface activated (VS Code activate / IntelliJ project open), carrying `surface_version`. First-seen (install_id, surface_version) ≈ new + upgrade installs that launched. GUI-only — CLI new/upgrade is read from any event's surface_version. |
| `surface_enabled` | A surface was enabled in a repo. Props: trigger. |
| `surface_disabled` | A surface was disabled / opted out. Props: trigger, reason. |
| `signin_started` | User initiated OAuth sign-in. Props: trigger. |
| `signin_completed` | jolliApiKey minted — the conversion event. Props: api_key_minted. |
| `signed_out` | User logged out. Props: none. |
| `ai_provider_selected` | User chose jolli vs anthropic for LLM. Props: provider (discriminator). |
| `memory_bank_migrated` | Migrate-to-Memory-Bank run. Props: outcome, repos, entries_bucket. |
| `command_invoked` | Any CLI command ran (auto-emitted). Props: command (discriminator), ok, duration_ms. MCP tool calls carry a `tool` property and are emitted per call (not per session); the session-level `command:"mcp"` event is suppressed. |
| `recall_performed` | A recall was run. Props: hit, result_count_bucket. |
| `search_performed` | A search was run. Props: query_len_bucket, result_count_bucket. |
| `memory_pushed` | Memories pushed to a Space. Props: kind, created, plans_bucket. |
| `export_performed` | Export run. Props: format (discriminator). |
| `ai_source_detected` | A new AI source transcript was detected. Props: source (discriminator: claude/codex/cursor/…). |
| `settings_opened` | Settings UI opened (vscode/intellij). Props: tab (discriminator). |
| `ingest_completed` | A drainIngest run finished. Props: outcome, ingested, idle (no-op when ingested=0), batches, route_calls, reconcile_calls, touched_slugs, topic_failures, duration_ms. Filter idle=true out for real-ingest latency/health metrics. |
| `error_occurred` | A structured error was raised. Content-free schema: { where (stage/subsystem), code (enumerated), source? , retryable? }. Emitted via trackError(); never carries a message/stack/path. |
| `queue_drained` | QueueWorker finished a drain. Props: ops, duration_ms. |
| `sync_completed` | A memory-bank sync round finished. Props: outcome (discriminator), duration_ms. |
| `toolwindow_opened` | The memory tool window was opened. Props: view. |
| `view_switched` | Tool window view switched (current/bank/knowledge). Props: view (discriminator). |
| `memory_committed` | User committed a memory via the Commit button. Props: none. |
| `memory_expanded` | A committed memory's details were expanded. Props: expanded. |
| `memory_item_opened` | An item inside a memory was opened. Props: item_type (discriminator: conversation/file/context/shipped). |
| `session_resumed` | A conversation session was resumed in a terminal. Props: source (discriminator). |
| `recall_prompt_copied` | A recall prompt was copied to the clipboard. Props: none. |
| `memory_pinned` | An item was pinned. Props: kind (discriminator). |
| `memory_unpinned` | An item was unpinned. Props: kind (discriminator). |
| `key_rejected` | The server rejected the API key (401/403). Props: retried, where. |
| `reauth_completed` | Re-authentication after a rejected key finished. Props: outcome. |

---
*Generated from `cli/src/core/TelemetryEvents.ts`. The IntelliJ plugin is an
independent implementation that sends the same event names and envelope.*
