# 207. CLI Telemetry Command

## Topic Statement

Provide a command-line command group that reports the current telemetry consent state and identity, toggles the persisted opt-out switch on or off, and prints the exact buffered events that would be sent — computing every reported value standalone from config rather than from any in-process telemetry context so its output is truthful even when telemetry was never bootstrapped.

## Scope

**In scope:**

- The four verbs of the command group: a default status report, an opt-in, an opt-out, and a plaintext inspect.
- What each verb reads, writes, prints, and the side effects it has on the live context and the on-disk buffer.
- The project-directory option that selects which project's buffer is read or cleared.
- The standalone computation of consent, identity, and environment directly from config.

**Out of scope (boundaries):**

- The consent resolution rules and the meaning of each reason (covered by **Telemetry Consent and Opt-Out**); this command only displays the resolved result and flips the persisted switch.
- The buffer's format, caps, and how the off path's clear works internally (covered by **Telemetry Event Buffering and Flush**); this command only reads and clears it.
- The minting of the install identifier and the resolution of the reporting origin/environment (covered by **Telemetry Startup and Command Instrumentation**); this command reuses those resolvers.
- The auto-emitted per-command completion event that wraps every command, including this one (covered by **Telemetry Startup and Command Instrumentation**) — except for the off verb's deliberate suppression of its own such event.
- The envelope/anonymization of the events the inspect verb prints (covered by **Telemetry Event Catalog**).

## Data Contracts

### Command group and verbs

A `telemetry` command group with four subcommands:

| Verb | Default | Purpose |
| -- | -- | -- |
| `status` | yes (runs when no subcommand is given) | Report whether telemetry is on, the reason, the install identifier, the environment, and the buffered count. |
| `on` | — | Opt in: clear the off-switch and mark the disclosure as seen. |
| `off` | — | Opt out: set the off-switch, stop the live context, and discard the buffer. |
| `inspect` | — | Print the exact buffered events that would be sent, as plaintext. |

### Project-directory option

`status`, `off`, and `inspect` accept a `--cwd <dir>` option selecting the project whose buffer is read or cleared; it defaults to the resolved project (git repo root). The `on` verb takes no such option (it only writes the machine-global switch and has no buffer interaction).

### Standalone computation

Every reported value is computed directly from config, not from the running telemetry context, so the command tells the truth even in a process where telemetry was never bootstrapped (and so it is unit-testable):

| Reported value | How it is computed |
| -- | -- |
| On/off + reason | Resolve consent from the loaded config (no host-platform signal is supplied here, so only the environment-variable and config channels are reflected). |
| Install identifier | Mint-or-read the per-machine install identifier. |
| Environment | Derive from the reporting origin resolved from config. |
| Buffered count | The number of events currently in the selected project's buffer. |

## Behavior

### Status (default)

1. Load config.
2. Resolve consent from config (on/off + reason).
3. Mint-or-read the install identifier.
4. Resolve the reporting origin from config and derive the environment label.
5. Read the selected project's buffer and count the events.
6. Print: the on/off state with the reason in parentheses; the install identifier; the environment; the buffered-event count; a line pointing at the inspect verb; and a line stating how to turn telemetry off (the off verb or the environment variable).

### Opt in (on)

1. Persist `telemetry = "on"` **and** `telemetryNoticeShown = true` (re-enabling implies the disclosure has been seen, so the first-run banner will not reappear).
2. Print a confirmation that telemetry is on and how to turn it off again.

### Opt out (off)

1. Persist `telemetry = "off"`.
2. Tear down the live in-process telemetry context immediately — so that this very command's own auto-emitted completion event becomes a no-op instead of writing one event back into the buffer that is about to be cleared.
3. Clear the selected project's buffer (discard, not send) — honoring the printed promise. Other projects' buffers are dropped lazily by the flush-time consent re-gate the next time they would be sent (see **Telemetry Event Buffering and Flush**).
4. Print a confirmation that telemetry is off and that no events will be collected or sent.

### Inspect

1. Read the selected project's buffer.
2. If empty, print that no events are buffered.
3. Otherwise print the count and a pretty-printed JSON dump of the exact buffered events — verbatim, the precise payloads that would be sent — so the user can see what would leave the machine **before** anything is sent.

## State Transitions

This command drives the persisted consent subset of the shared config (full transition model in **Telemetry Consent and Opt-Out**):

- `on` → sets `telemetry = "on"`, `telemetryNoticeShown = true`.
- `off` → sets `telemetry = "off"`, tears down the live context, clears this project's buffer.
- `status` / `inspect` → read-only with respect to consent (status may, as a side effect of mint-or-read, persist a freshly minted install identifier on a machine that never had one).

## Notable Behavior

- **The command reports from config, not from the live context.** It resolves consent, identity, and environment standalone, so its output is correct even when invoked in a process where telemetry was never bootstrapped. (Notable.)
- **Status does not supply a host-platform opt-out signal.** Its consent result reflects only the environment-variable and config channels — it does not know about an editor/IDE host opt-out, because it runs as a plain command-line invocation. (Notable.)
- **The off verb tears down the live context before clearing the buffer.** This stops the off command's own auto-emitted completion event from being written back into the buffer it is clearing. (Surprising; intentional ordering.)
- **The off verb discards already-buffered events.** It clears this project's buffer immediately rather than only stopping future writes, making "no events will be collected or sent" literally true for the current project; other projects are handled by the flush-time re-gate. (Notable.)
- **The on verb also marks the disclosure as seen.** Re-enabling suppresses the first-run banner on the assumption the user has seen the disclosure. (Notable.)
- **Inspect prints the exact wire payloads.** The pretty-printed dump is the precise buffered envelopes, fulfilling the privacy promise that the user can audit what would be sent beforehand. (Notable.)
- **Status's identity read can mint an identifier as a side effect.** On a machine that never ran telemetry, asking for status mints-and-persists the install identifier (the mint is inert until a flush). (Notable.)

## Shared Behavior

- The consent resolution and the meaning of each reason the status verb prints, and the off/on switch semantics, are defined by **Telemetry Consent and Opt-Out**.
- The buffer the inspect verb reads and the off verb clears is defined by **Telemetry Event Buffering and Flush**.
- The install-identifier mint-or-read and the reporting-origin/environment resolution the command reuses are defined by **Telemetry Startup and Command Instrumentation**.
- The envelope shape and anonymization of the events inspect prints are defined by **Telemetry Event Catalog**.
- The auto-emitted per-command completion event that the off verb deliberately suppresses for itself is defined by **Telemetry Startup and Command Instrumentation**.
