# 203. Telemetry Consent and Opt-Out

## Topic Statement

Decide whether anonymous usage telemetry may be collected at all, using an opt-out model in which collection is on by default but is silenced whenever the user has declined through any one of three independent channels, with the decision re-evaluated both at the moment an event would be recorded and again at the moment buffered events would be sent.

## Scope

**In scope:**

- The three opt-out channels, the fixed order in which they are consulted, and the named reason each produces.
- The default-on behavior when no channel objects.
- The persisted off-switch and where it lives.
- The cross-channel, cross-surface sharing of the opt-out choice.
- The one-time first-run disclosure: when it is shown, where it is shown, and how it is recorded as shown.
- The flush-time re-gate that drops already-buffered events when the user has since opted out.
- The interactions between turning telemetry off and the event already in flight for the "off" action itself.

**Out of scope (boundaries):**

- The shape, fields, and anonymization of events (covered by **Telemetry Event Catalog**).
- The on-disk buffer, batching, transport, and failure handling of the send path (covered by **Telemetry Event Buffering and Flush**); only the consent re-gate that fronts the send is documented here.
- Where instrumentation points emit events (covered by **Telemetry Startup and Command Instrumentation**).
- The user-facing command that reports and toggles consent (covered by **CLI Telemetry Command**).
- The per-machine anonymous identifier itself, beyond the fact that it is minted unconditionally and is inert while opted out.

## Data Contracts

### The three opt-out channels

Consent is resolved from three inputs, checked in this order of authority. The first one that objects wins and short-circuits the rest:

| Order | Channel | Source | "Opt out" condition | Reason produced |
| -- | -- | -- | -- | -- |
| 1 | Cross-tool platform signal | An environment variable named `DO_NOT_TRACK` | Present, and after trimming whitespace its value is neither the empty string nor `"0"` | `do-not-track` |
| 2 | Host-platform opt-out | A boolean passed in by the host surface | Exactly `true` | `platform-off` |
| 3 | Product off-switch | A persisted config field named `telemetry` | Value equals the string `"off"` | `config-off` |
| — | (none objected) | — | — | `on` (enabled) |

The environment-variable convention is deliberate: any truthy value means opt out, while the literal `"0"` explicitly means "tracking allowed" and does **not** opt out. An unset variable does not opt out.

The host-platform boolean is supplied by each surface, not derived inside the consent logic:

- The command-line surface leaves it unset (there is no host platform to honor).
- The graphical-editor surface passes the negation of the editor's own "telemetry enabled" flag, which already folds in the editor's three-state telemetry-level setting (a level of "off" makes the editor report telemetry disabled).
- The JVM-IDE surface passes the IDE's data-sharing decision: `true` only when the IDE user has **explicitly declined** usage-statistics sharing. The IDE consent is read reflectively and degrades to "not declined" on any error (missing/renamed API, no running application, headless worker), so an unreadable IDE consent leaves the product off-switch in charge rather than wrongly suppressing everything.

### Consent result

Resolving consent yields two values:

| Field | Type | Meaning |
| -- | -- | -- |
| `enabled` | boolean | Whether telemetry may be collected. |
| `reason` | one of `on`, `do-not-track`, `platform-off`, `config-off` | Why it is on or off; surfaced by the status command. |

### Persisted off-switch and notice marker

Two fields live in the machine-global config file (`~/.jolli/jollimemory/config.json`), shared by all three surfaces so that one machine has exactly one opt-out choice and one first-run-notice state:

| Field | Type | Meaning |
| -- | -- | -- |
| `telemetry` | `"on"` / `"off"` / absent | The product off-switch. Absent or `"on"` means default-on; only the literal `"off"` opts out. |
| `telemetryNoticeShown` | boolean / absent | Whether the one-time disclosure has been shown on this machine. Absent is treated as `false`. |

Because the command-line tool co-owns this file with the editor surfaces, the JVM-IDE surface mutates it as a structured-document tree (not a parse-to-map round-trip) so that every other field's exact representation — in particular the integer-valued fields the command-line tool writes — is preserved byte-for-byte rather than widened to floating-point.

### First-run disclosure decision

The disclosure is shown once per machine, and only when telemetry is actually enabled, by this rule:

- If `telemetryNoticeShown` is already `true`, do not show it.
- Otherwise, show it only if consent currently resolves to enabled.

The rationale is that there is no point announcing collection that will not happen — an opted-out machine never sees the notice. The caller persists `telemetryNoticeShown = true` after deciding to show it.

## Behavior

### Resolving consent (the gate)

1. Read the environment variable channel. If it objects, return `{ enabled: false, reason: do-not-track }`.
2. Else, if the host-platform boolean is `true`, return `{ enabled: false, reason: platform-off }`.
3. Else, if the persisted `telemetry` field equals `"off"`, return `{ enabled: false, reason: config-off }`.
4. Else, return `{ enabled: true, reason: on }`.

This gate is consulted whenever telemetry is initialized for a process and whenever the status command is invoked, and a flush re-evaluates the same gate before sending (see "Flush-time re-gate" below).

### Command-line first-run disclosure

On every command-line invocation, before any command runs and before the install-identifier-minting bootstrap:

1. Load config.
2. Apply the first-run-disclosure decision (which itself resolves consent). If it says "do not show", do nothing.
3. Otherwise write a multi-line disclosure to the standard-error stream (chosen so it never pollutes standard output or piped output). The disclosure states that anonymous, content-free usage telemetry is collected, never code/paths/memory content, and how to turn it off (the off command, or the `DO_NOT_TRACK` variable), and points at an inspect command and a documentation URL.
4. Persist `telemetryNoticeShown = true`.

The whole sequence is wrapped so it never throws into startup; on any error it simply reports "did not print".

The command-line enable flow additionally prints a plain-language telemetry-is-on-by-default note in its success output, independent of the once-only banner, so a user who only runs enable still sees the disclosure.

**Notable — the two disclosures use different streams, deliberately.** The once-only banner above goes to the standard-error stream so it never pollutes piped output. The enable flow's note goes to the **standard-output** stream, because there it is one block of a structured success report the user is meant to read as a whole. Neither is a prompt: both are statements, nothing is asked, and no decision is recorded from either. So the enable note is also the one piece of that report no invocation form suppresses — it prints regardless of an assume-yes flag or a non-interactive stream, meaning a user who answers nothing has still been told. The exact wording and per-block conditionality of the enable report are documented by the enable-command topic; only the independence and the stream choice belong here.

### Editor first-run disclosure

On editor activation, after bootstrapping telemetry with the host-platform signal:

1. Load config.
2. If the first-run-disclosure decision (using the host signal) says show:
   - Persist `telemetryNoticeShown = true` first.
   - Show a modal/notification with the disclosure text and two action buttons, "Learn more" and "Turn off".
   - If the user picks "Learn more", open the documentation URL in a browser.
   - If the user picks "Turn off", persist `telemetry = "off"` and immediately tear down the in-process telemetry context so no further events are recorded this session.
3. The whole block is wrapped so it never blocks activation.

### JVM-IDE first-run disclosure

The JVM-IDE bootstrap returns a boolean indicating whether the disclosure should be shown (computed from `telemetryNoticeShown` and the resolved consent, using the IDE data-sharing signal as the host channel). The caller shows the notice and then records it as shown via the shared-config marker.

### Turning telemetry off (in-app)

Setting the off-switch performs three things, in this order, to honor the printed promise that "no events will be collected or sent":

1. Persist `telemetry = "off"`.
2. Tear down the in-process telemetry context immediately, so that even the very command that turned telemetry off does not record its own completion event back into the buffer that is about to be cleared.
3. Clear the current project's buffered events (discard, not send).

Other repositories' already-buffered events are not reachable from this one invocation; they are dropped lazily by the flush-time re-gate the next time any process attempts to flush them (see below).

### Turning telemetry on (in-app)

Setting the off-switch back on persists `telemetry = "on"` and also sets `telemetryNoticeShown = true` (re-enabling implies the user has seen and understood the disclosure, so the banner will not reappear).

### Flush-time re-gate

Before any buffered events are sent, consent is resolved again from the freshly loaded config plus the live host signal — not merely trusted from when the events were recorded:

- If consent now resolves to disabled, the buffer is **deleted** (the events are dropped, never sent).
- Only if consent resolves to enabled does the send proceed.

This guarantees that a user who opts out after events were already buffered — through any channel, including a host-platform toggle that is a runtime value not stored in config — does not have those events uploaded. For this reason the host-platform signal must be threaded into every flush call (the editor passes the live signal on each periodic flush; the JVM IDE re-reads the IDE data-sharing decision at flush time).

## State Transitions

The persisted consent subset of the shared config has these states:

- **Default-on, notice unshown.** `telemetry` absent/`"on"`, `telemetryNoticeShown` absent/`false`. The first enabled run shows the disclosure and moves to notice-shown.
- **Default-on, notice shown.** Steady state for a consenting user.
- **Opted out.** `telemetry = "off"`. Reached via the off action (which also clears the local buffer and the live context). The notice is never shown while in this state, because the disclosure decision requires enabled consent.
- **Re-opted in.** Off action reversed by the on action, which sets both `telemetry = "on"` and `telemetryNoticeShown = true`.

A change to the environment-variable channel or the host-platform channel flips the effective consent without touching the persisted fields — those two channels are evaluated fresh on every gate and re-gate, so they can silence (or, for the variable set to `"0"` / unset, decline to silence) telemetry without a config write. The editor re-bootstraps its context when the host telemetry setting changes mid-session so the toggle takes effect immediately.

## Notable Behavior

- **Order of authority is fixed and short-circuiting.** The environment variable beats the host platform, which beats the product off-switch. The reason reported reflects the *first* channel that objected, even if a later channel would also have objected. (Notable.)
- **`DO_NOT_TRACK="0"` is an explicit opt-in, not an opt-out.** Only the empty string and `"0"` (after trimming) fail to trip the channel; every other present value opts out. (Surprising; intentional — matches the cross-tool convention.)
- **The first-run notice is never shown to an opted-out machine.** Because the show-decision requires consent to currently resolve enabled, a user who is opted out (by any channel) sees no banner. (Notable.)
- **The "off" action discards already-buffered events, not just future ones.** Turning telemetry off clears the local buffer immediately, and the flush-time re-gate drops other repos' buffers when they would next be sent. This is the mechanism that makes the printed "no events will be collected or sent" literally true. (Notable.)
- **Turning telemetry off tears down the live context before clearing the buffer.** Without this, the off command's own auto-emitted completion event would be written back into the buffer being cleared. (Surprising; intentional ordering.)
- **Consent is re-gated at flush, not trusted from record time.** A signed buffer of events is still dropped if the user opted out in the interim. The host-platform signal is a runtime value, so it must be passed into every flush; otherwise events buffered before a host-telemetry-off toggle would still upload. (Notable, defensive.)
- **The JVM-IDE host consent fails open.** If the IDE consent API is absent, renamed, or unavailable (headless worker, no running application), the IDE channel reports "not declined", leaving the product off-switch and the environment variable in charge — the plugin never suppresses everything just because it could not read the IDE setting. (Surprising; intentional.)
- **The off-switch and notice marker are machine-global and cross-surface.** All three surfaces read and write the same fields in the same shared config file, so opting out in one surface opts out in all of them. (Notable.)
- **Re-enabling sets the notice-shown marker too.** Turning telemetry on suppresses the first-run banner forever after, on the assumption that a user who re-enables has already seen the disclosure. (Notable.)

## Shared Behavior

- The events that would be recorded once consent is enabled, and their anonymization, are defined by **Telemetry Event Catalog**.
- The buffer the off action clears, and the send the flush-time re-gate fronts, are defined by **Telemetry Event Buffering and Flush**.
- The bootstrap that resolves consent at process start, and the unconditional minting of the anonymous install identifier (inert while opted out because no flush will send it), are defined by **Telemetry Startup and Command Instrumentation**.
- The status / on / off / inspect verbs the user drives consent with are defined by **CLI Telemetry Command**.
