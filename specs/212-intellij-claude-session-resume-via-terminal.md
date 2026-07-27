# 212. IntelliJ Claude/Codex Session Resume via Terminal

## Topic Statement

A cross-panel affordance that opens a new IDE terminal tab rooted at the project's working directory and immediately runs the source-appropriate command to resume a previously started Claude or Codex session. The action is available in three panels — Active Conversations, Committed Memories (Conversations group), and Pinned — and is gated at each panel's row-construction point (or, for Active Conversations, inside its click handler) by one shared "can this source be resumed" predicate used identically at all three call sites. The mechanism is source-generic by construction: a fourth resumable source would only need an entry in the shared predicate and an additional command branch, not a fourth independent eligibility check.

## Scope

**In scope:**

- The shared terminal helper: its inputs, the terminal lifecycle, the two command forms it can build (one per resumable source), its unsupported-source guard, and its error path.
- The shared eligibility predicate and its use identically at all three call sites.
- The three call sites: how each panel resolves the session identifier, how each evaluates eligibility, and how each obtains the working directory.
- The hover-reveal model common to all three panels (the resume button appears only on hover; it is hidden at rest).
- The key format used to store and later reconstruct the session identifier in the Pinned panel.
- The fact that no tests exist for this feature.

**Out of scope (boundaries):**

- The active-session aggregator that produces the `ActiveConversationItem` envelope consumed by the Active Conversations panel — covered by a separate spec.
- The pin storage format, read/write semantics, and the full set of kinds a pinned entry can carry — those are owned by the pin store spec.
- The conversation-row hover model beyond its interaction with the resume button — covered by the Active Conversations panel spec.
- The committed-memory conversation rows beyond the resume affordance — covered by the Commits panel spec.
- What happens inside the terminal after the resume command runs; the feature's responsibility ends when the command is sent to the shell widget.

## Data Contracts

### Terminal helper inputs

| Field | Meaning |
| --- | --- |
| Project handle | The IDE-level project reference; used to locate the terminal tool-window manager and to scope the error notification. |
| Source | The producer name (case-insensitive), e.g. `"claude"` or `"codex"`; selects which command form is built and the default tab title. |
| Session identifier | An opaque string passed verbatim as the argument to the resume command. |
| Working directory | An absolute path on disk; the terminal tab is opened with this as its starting directory. |
| Tab title | An optional human-readable label for the new terminal tab. Defaults to `"Claude – resume"` or `"Codex – resume"` (chosen by source) when not provided. |

### Shared eligibility predicate

One function decides whether a source's session can be resumed from the terminal: the (lowercased) source must be either `"claude"` or `"codex"`. All three call sites (Active Conversations, Committed Memories, Pinned) call this same predicate — there are no longer three independently-written `== "claude"` checks. Any other source (`gemini`, `opencode`, `cursor`, `copilot`, `copilot-chat`, or an unrecognized future producer) fails the predicate.

### Command produced

The terminal helper selects the command form from the (lowercased) source:

```
codex  → codex resume <sessionId>
claude → claude --resume <sessionId>
```

The session identifier is interpolated without quoting or escaping in both forms. If the session identifier contains spaces or special shell characters, the command will be misinterpreted by the shell. No sanitization is performed.

**Unsupported-source guard:** if the source matches neither `"codex"` nor `"claude"`, the helper does not build a command. It logs a warning and posts a `WARNING`-severity notification ("Resuming isn't supported for this conversation type.") to the IDE notification bus, then returns without touching the terminal. This branch exists purely as a defensive guard — every current caller filters through the shared eligibility predicate before calling the helper, so as of this writing the branch is not reachable from any of the three panels; it would only fire if a future caller invoked the helper directly, bypassing the predicate.

### Session identifier sources by panel

| Panel | Source of session identifier | Source of working directory |
| --- | --- | --- |
| Active Conversations | `sessionId` field of `ActiveConversationItem` directly. | Service main-repo root, with project base path as fallback. |
| Committed Memories (Conversations group) | `sessionId` field of `ConversationBrief` (stored in the committed memory; defaults to the empty string when not recorded). | Service main-repo root, with project base path as fallback. |
| Pinned | Derived by splitting the stored pin key on the first `:` separator and taking the suffix. The key format is `<sourceName>:<sessionId>` — so the prefix (source name) is discarded and the remainder is the session identifier. | Service main-repo root, with project base path as fallback. |

For a Codex row, this stored session identifier is not the rollout filename — it is the id recorded in the session's own session-meta record (falling back to an alternate id field), as produced by discovery. See spec 18 for exactly how that id is read and why the filename is deliberately not used; that lookup is what makes `codex resume <id>` actually resume the right session.

### Eligibility gating by panel

Each panel evaluates eligibility using the shared predicate above; the resume button is either included in the row's action set or entirely omitted — there is no disabled state.

| Panel | Eligibility condition | Where evaluated |
| --- | --- | --- |
| Active Conversations | The shared predicate applied to the item's source name (`claude` or `codex` both pass). No filesystem check is performed. | `onResume` handler in the panel; if the predicate fails, the handler returns immediately without calling the terminal helper. The resume button is always rendered and revealed on hover regardless of source — the guard is inside the click handler, not at construction time. |
| Committed Memories | The shared predicate applied to the conversation's `source` string **and** the `transcriptPath` field must be non-null, non-blank, and point to a file that exists on disk at construction time. Both conditions must hold; failure of either means no resume button is added to the row's action list. | Computed at row-construction time with a local `canResume` boolean. |
| Pinned | The pin entry's `kind` must equal `"conversations"` **and** the shared predicate applied to the `badge` field. | Computed at row-construction time with a local `canResume` boolean. |

**Notable divergence:** Active Conversations is the only panel that does not gate at construction time. Every conversation row in that panel receives a resume button regardless of source. The predicate check happens inside the click handler. For rows whose source fails the predicate (Gemini, OpenCode, Cursor, Copilot, Copilot Chat), the button is visually present on hover but clicking it silently no-ops.

## Behavior

### Terminal tab creation

When the resume action fires:

1. Resolve the command and default tab title from the (lowercased) source. If the source is neither `"codex"` nor `"claude"`, skip straight to the unsupported-source guard (log + warning notification) and return — steps 2–4 never run.
2. Locate the IDE terminal tool-window manager for the project.
3. Ask it to create a new shell-terminal widget starting in the supplied working directory, with the supplied (or default) tab title as the widget's name. This creation call is made **reflectively** rather than as a direct API call (see Notable): the manager's shell-widget-creation method is looked up and invoked by reflection.
4. Send the resolved resume command string (`codex resume <id>` or `claude --resume <id>`) to the widget's shell input.
5. Return. The panel does not wait for the command to complete, does not check for errors from the command, and does not install any listener on the terminal tab's lifecycle.

### Error handling

All of steps 1–3 are wrapped in a single catch-all exception handler. If any step throws:

- The exception message is written to the plugin's diagnostic log at `WARN` level.
- A notification is posted to the IDE's notification bus under the `JolliMemory` group, titled **"Resume Session"**, with the message **"Could not resume session — terminal unavailable."**, at `WARNING` severity, scoped to the project.
- No further action is taken. The panel is not refreshed; no dialog is shown.

### Working-directory resolution (all three panels)

All three panels resolve the working directory the same way: prefer the service's main-repo root; if that is null, fall back to the project's base path. If both are null, the action is abandoned silently before the terminal helper is called. There is no error notification in the null-working-directory case.

### Active Conversations panel — resume button lifecycle

The resume button is part of the hover-action cluster alongside the pin, open (eye), and selection-toggle icons. All four are hidden at rest and become visible together when the cursor enters the row's bounds. Leaving the row's outer bounds (checked via screen-space coordinates to avoid flicker when crossing sub-component boundaries) hides all four again. The resume button's click handler fires `onResume(item)` on the owning panel, which then applies the shared eligibility predicate and, if it passes, calls the terminal helper with the item's source, the item's session identifier, the resolved working directory, and the item's own title as the tab title (`item.title`), so the terminal helper's source-keyed default title (`"Claude – resume"` / `"Codex – resume"`) is not exercised at this call site. This call site does not record telemetry for the resume action.

### Committed Memories panel — resume button lifecycle

Conversation rows under a committed memory are constructed with a `canResume` boolean (the shared predicate applied to the conversation's `source`, ANDed with the transcript-file existence check below). If `canResume` is false, the row's east action cluster contains only the open-conversation button. If `canResume` is true, a resume button is appended after the open button. The east cluster also contains a message-count label that is visible at rest; on hover, the count label is hidden and the action buttons are revealed. The resume button's click handler records `session_resumed` telemetry with the actual (lowercased) source, then calls the panel-local resume method with the conversation's `source` and the `sessionId` field of the `ConversationBrief`. No title is forwarded, so the terminal helper falls back to its source-keyed default (`"Claude – resume"` or `"Codex – resume"`).

**Notable behavior:** the `canResume` test includes a real-time filesystem existence check (`File(transcriptPath).exists()`) evaluated at row-construction time. If the file disappears after construction, the button remains visible and clickable (the existence check is not re-evaluated on click). If the session identifier is the empty string (absent from the stored memory), `canResume` is false regardless of the file existence check, and no resume button is shown.

### Pinned panel — resume button lifecycle

Pin rows are constructed with a `canResume` boolean derived from `kind == "conversations" && <shared predicate>(badge)`. When true, the row's hover-action cluster is `[open, resume, unpin]`; when false it is `[open, unpin]`. All actions are hidden at rest and revealed together on hover using the same screen-space-bounds exit check as the other panels.

The session identifier is reconstructed from the stored key by discarding the prefix up to and including the first `:` character. If the key does not contain a `:` character, `substringAfter(":")` returns the entire key (unchanged), which is then used as the session identifier. If the result is blank, the terminal helper is not called and the action silently no-ops. When the identifier is non-blank, the click handler records `session_resumed` telemetry with the actual (lowercased) badge/source before calling the terminal helper with the pin's `badge` as source and the entry's title as tab title.

## State Transitions

```
[row constructed — Active Conversations]
  resume button created, always added to hover cluster
  state: hidden

[row constructed — Committed Memories]
  canResume ← canResumeSource(source) && transcriptPath != null && File(transcriptPath).exists()
  if canResume: resume button added to action cluster
  else: resume button absent
  state: hidden (if present)

[row constructed — Pinned]
  canResume ← kind == "conversations" && canResumeSource(badge)
  if canResume: resume button added to action cluster
  else: resume button absent
  state: hidden (if present)

[cursor enters row]
  → resume button (and sibling actions) become visible

[cursor exits row (screen-space check confirms exit)]
  → resume button (and sibling actions) become hidden

[resume button clicked]
  consume mouse event (prevents propagation to row-body click handler)
  resolve cwd ← service.mainRepoRoot ?? project.basePath
  if cwd == null → no-op, return
  [Active Conversations only] if !canResumeSource(item.source) → return
  [Pinned only] sessionId ← entry.key.substringAfter(":")
                if sessionId.isBlank() → return
  [Committed Memories, Pinned only] track telemetry "session_resumed" { source: <actual source>.lowercase() }
  call terminal helper(project, source, sessionId, cwd, title)

[terminal helper — command resolution]
  src ← source.lowercase()
  if src == "codex" → command = "codex resume <sessionId>", default title = "Codex – resume"
  else if src == "claude" → command = "claude --resume <sessionId>", default title = "Claude – resume"
  else → log.warn(...); notify IDE bus "Resuming isn't supported for this conversation type." (WARNING); return
         (dead in practice — every caller already filtered via canResumeSource)

[terminal helper — success path]
  reflectively invoke terminal-manager shell-widget creation (cwd, title ?? default title, …)
  send resolved command to the widget
  return

[terminal helper — exception path]
  log.warn(message, exception)
  notify IDE bus: "Could not resume session — terminal unavailable." (WARNING)
  return
```

## Notable Behavior

- **No tests exist.** There are no unit or integration tests covering `TerminalUtils` or any of the three call sites' resume paths. The feature shipped without a test suite.
- **Active Conversations always renders the button, regardless of source.** The construction path does not filter by source. The eligibility predicate lives inside the click handler and silently returns for rows whose source fails it. Every conversation row therefore shows a resume button on hover — including Gemini, OpenCode, Cursor, Copilot, and Copilot Chat rows — but clicking it does nothing for them; only Claude and Codex rows actually resume.
- **Resume is now source-generic, not Claude-only.** The eligibility predicate, the command builder, and the tab-title default all key off the row's source and currently recognize two values (`claude`, `codex`). This replaced three independently-written `== "claude"` checks with one shared predicate called from all three panels — a prior version of this spec described the feature as Claude-only; that is no longer accurate.
- **Session identifier is not quoted or escaped in either command form.** Both `"claude --resume $sessionId"` and `"codex resume $sessionId"` are built by direct string interpolation. A session identifier containing spaces, semicolons, or other shell metacharacters will produce a malformed command.
- **The unsupported-source branch is a defensive guard, not a live path.** `TerminalUtils.resumeSession`'s `else` branch (warn-log + "Resuming isn't supported for this conversation type." notification) only runs for a source that is neither `claude` nor `codex`. Because all three call sites gate on the same eligibility predicate before ever calling the helper, this branch is not reachable from any of today's panels — it exists to fail safely if a future caller invokes the helper directly.
- **Telemetry now records the actual resumed source, not a hardcoded value.** The Committed Memories and Pinned call sites each emit `session_resumed` with `source` set to the row's actual (lowercased) source/badge — so a Codex resume is now distinguishable from a Claude resume in telemetry. Active Conversations does not emit `session_resumed` telemetry at all; that gap predates and is unrelated to the Claude→Codex broadening.
- **The Committed Memories resume path uses the source-keyed default tab title.** Unlike Active Conversations (which passes the row's own `item.title` as the tab title verbatim) and Pinned (which passes `entry.title`), the Committed Memories call uses the no-title-argument overload, so the tab is labeled `"Claude – resume"` or `"Codex – resume"` depending on the conversation's source.
- **The transcript-file existence check in Committed Memories is snapshot-at-construction-time.** If the file is deleted after the row is built, the button stays visible. If the file appears after the row is built, the button does not appear retroactively (the row is not re-evaluated). This check is ANDed onto the eligibility predicate regardless of which of the two supported sources the row is.
- **A blank session identifier from the Pinned panel is silently discarded.** The guard `if (sessionId.isNotBlank())` prevents calling the terminal helper with an empty string, but there is no user-visible feedback that the button click did nothing.
- **No `:` in a Pinned key produces the full key as the session identifier.** `substringAfter(":")` returns the receiver unchanged when the delimiter is absent. A malformed key would therefore pass the blank-check and be sent to the terminal as the session identifier.
- **The terminal tab is always new.** There is no attempt to reuse an existing terminal tab from a prior resume of the same session. Each click creates a fresh tab.
- **The shell widget is created reflectively, as a Marketplace-verifier workaround.** The only terminal-creation entry point available on the compile baseline is marked internal API in newer builds within the plugin's supported range, so a direct call is flagged by the Marketplace plugin verifier. Invoking it by reflection keeps the call out of the scanned bytecode while remaining functional. The previously-used direct creation method (which the earlier version of this spec named) no longer exists on the baseline. A signature change or removal of the reflected method throws, which is caught by the same catch-all and degrades gracefully to the "terminal unavailable" notification fallback.
- **The error notification uses no action buttons.** Neither the "terminal unavailable" `WARNING` notification nor the unsupported-source `WARNING` notification attaches a "retry" or "open terminal manually" action. The user receives the message but has no in-notification path to recover.

## Shared Behavior

- **Active session aggregator** — supplies the `ActiveConversationItem` envelope (including `sessionId` and `source`) consumed by the Active Conversations panel. This spec only uses the envelope's `sessionId` and `source` fields.
- **Project status service** — owns the `mainRepoRoot` resolution; all three panels call it to obtain the working directory.
- **Pin store** — owns the key format (`<sourceName>:<sessionId>`) that the Pinned panel reconstructs the session identifier from. The `badge` field carries the source name used for the eligibility check.
- **IDE terminal tool-window manager** — the platform service that creates and owns the terminal widget. This feature invokes its shell-widget-creation entry point **reflectively** (see Notable); the older direct creation method it previously called is gone.
- **IDE notification bus** — the platform channel through which the resume-error and unsupported-source notifications are posted.
- **Codex session discovery (spec 18)** — owns how a Codex session's resumable id is read from its session-meta record (id field, falling back to an alternate id field, never the rollout filename) and how discovery scopes sessions to the current project directory. This spec only consumes the resulting `sessionId` as an opaque string.
