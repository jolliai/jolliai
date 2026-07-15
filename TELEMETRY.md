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
| `app_installed` | First run after install; installId minted (once per machine). |
| `surface_enabled` | A surface was enabled in a repo. |
| `surface_disabled` | A surface was disabled / opted out. |
| `signin_started` | User initiated OAuth sign-in. |
| `signin_completed` | jolliApiKey minted — the conversion event. |
| `signed_out` | User logged out. |
| `ai_provider_selected` | User chose jolli vs anthropic for LLM. |
| `memory_bank_migrated` | Migrate-to-Memory-Bank run. |
| `command_invoked` | Any CLI command ran (auto-emitted). MCP tool calls carry a `tool` property and are emitted per call (not per session); the session-level `command:"mcp"` event is suppressed. |
| `recall_performed` | A recall was run. |
| `search_performed` | A search was run. |
| `memory_pushed` | Memories pushed. |
| `export_performed` | Export run. |
| `ai_source_detected` | A new AI source transcript was detected. |
| `settings_opened` | Settings UI opened (vscode/intellij). |
| `ingest_completed` | A drainIngest run finished. |
| `error_occurred` | A structured error code was raised. |
| `queue_drained` | QueueWorker finished a drain. |
| `sync_completed` | A memory-bank sync round finished. |
| `toolwindow_opened` | The memory tool window was opened. |
| `view_switched` | Tool window view switched (current/bank/knowledge). |
| `memory_committed` | User committed a memory via the Commit button. |
| `memory_expanded` | A committed memory's details were expanded. |
| `memory_item_opened` | An item inside a memory was opened (conversation/file/context/shipped). |
| `session_resumed` | A conversation session was resumed in a terminal. |
| `recall_prompt_copied` | A recall prompt was copied to the clipboard. |
| `memory_pinned` | An item was pinned. |
| `memory_unpinned` | An item was unpinned. |
| `key_rejected` | The server rejected the API key (401/403). |
| `reauth_completed` | Re-authentication after a rejected key finished. |

---
*Generated from `cli/src/core/TelemetryEvents.ts`. The IntelliJ plugin is an
independent implementation that sends the same event names and envelope.*
