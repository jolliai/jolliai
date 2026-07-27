# 143. VS Code Anthropic API Key Panel

## Topic Statement

A sidebar sub-view captures an Anthropic API key during onboarding for persistence to the machine-global config.

## Scope

**In scope:**

- The conditions under which the key-entry sub-view is visible and hidden.
- The sub-view's layout and interactive controls.
- The single validation rule and the Save button's enabled state.
- The full save flow: outbound command, host-side trimming, storage write, status-store refresh, and the resulting viewport transition.
- Both failure paths: validation rejection and storage error.
- The stale-error guard that drops late-arriving error messages.
- The storage location and its relationship to the machine-global config file.

**Out of scope (boundaries):**

- The onboarding panel that hosts the "Configure API Key" button triggering this sub-view — defined by **VS Code Onboarding Panel** (spec 142).
- The configured-state computation and the viewport transitions that follow a successful save — defined by spec 142.
- The sidebar webview message protocol's envelope shapes — defined by **Sidebar Webview Message Protocol** (spec 101).
- The machine-global config file's overall format, schema versioning, and atomicity guarantees — defined by the auth-credential-storage spec.
- What happens when both an API key and a signed-in cloud-product token are present at LLM-call time — defined by **LLM Credential Priority** (spec 10).
- The full settings webview path for editing the API key after initial setup — defined by the settings-webview spec (spec 110).

## Data Contracts

### Visibility condition

The key-entry sub-view is visible when all of the following are true:

1. The user is unconfigured (`configured = false`, as defined by spec 142).
2. The user has clicked the "Configure API Key" button on the onboarding cards.

The sub-view is hidden at all other times, including immediately after a successful save triggers the `configured:changed` transition.

### Sub-view layout

| Element          | Type             | Properties                                                              |
| ---------------- | ---------------- | ----------------------------------------------------------------------- |
| Label            | Text label       | Content: "API key".                                                     |
| Key input        | Password input   | Placeholder: "sk-ant-…"; autocomplete disabled; spellcheck disabled.    |
| Save button      | Primary button   | Starts disabled; enabled when trimmed input is non-empty.               |
| Back button      | Secondary button | Always enabled; returns to the onboarding cards without state change.   |

### Validation rule

The trimmed input must be a non-empty string. There is no prefix check, no regular-expression constraint, no minimum or maximum length bound. The Save button mirrors this rule: enabled exactly when `input.trim().length > 0`.

### Outbound message (webview → host)

When the user activates Save, the webview sends a generic command message naming the save-anthropic-key command with the raw (untrimmed) key value as the single argument.

### Inbound message (host → webview)

| Message kind       | Payload fields     | Meaning                                                                  |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| `apikey:saveError` | `message: string`  | The host rejected or failed to store the key. The webview renders `message` inline beneath the input under an alert role. |

### Storage write

The host writes a single field (`apiKey`) into the machine-global config file via an atomic merge. No other fields in that file are modified by this operation.

## Behavior

### Save flow

1. The user activates Save (button click or Enter key inside the input).
2. The webview sends the save-anthropic-key outbound command with the raw input value.
3. The host trims whitespace from both ends of the received value.
4. If the trimmed value is empty, the host posts `apikey:saveError` with the message "API key cannot be empty." and stops.
5. If the trimmed value is non-empty, the host writes `apiKey` into the machine-global config file, preserving all other fields.
6. After a successful write, the host triggers a status-store refresh.
7. The refresh re-derives the configured boolean (now `true` because `hasApiKey` is true) and posts `configured:changed` with `configured: true`.
8. The webview reacts to `configured:changed` per spec 142: the key-entry sub-view and onboarding panel are both hidden, the Tab UI is shown, and the one-shot auto-tab-switch to the Status tab fires.

### Back navigation

Clicking the Back button hides the key-entry sub-view and shows the onboarding cards. The input value is not preserved across this navigation. No message is sent to the host.

### Enter-key shortcut

Pressing Enter while focus is inside the key input fires the save flow when the Save button is enabled. When Save is disabled (trimmed input is empty), Enter has no effect.

## State Transitions

The key-entry sub-view has two states:

- **Hidden.** Not rendered or rendered but not visible; no user interaction possible.
- **Visible.** Rendered and interactive; input, Save, and Back controls are reachable.

Allowed transitions:

- Hidden → Visible: the user clicks "Configure API Key" on the onboarding cards while `configured = false`.
- Visible → Hidden (Back): the user clicks Back.
- Visible → Hidden (success): the host posts `configured:changed` with `configured: true` following a successful save.
- Visible → Visible (error): the host posts `apikey:saveError`; the sub-view re-enables Save when input is non-empty and remains open.
- Visible → Hidden (external configure): the user completes configuration via the sign-in path on the onboarding cards while the key-entry sub-view is visible; `configured:changed` fires and hides the sub-view.

## Notable Behavior

- **No prefix check on the saved value.** A key that does not begin with `sk-ant-` is accepted and persisted. The downstream call surface enforces correctness; the key-entry panel is a thin persistence layer. (Surprising; intentional.)
- **Whitespace is trimmed at both ends.** A key pasted with a trailing newline or leading space is stored cleanly. This tolerance is intentional.
- **The stale-error guard drops `apikey:saveError` when the key-entry sub-view is not visible.** A `configured:changed` message and an `apikey:saveError` can race over the message channel; without the guard, an old error bubble would appear beneath the freshly-revealed Tab UI. (Surprising; intentional.)
- **The key is stored as plain JSON in the user's home directory, not in the IDE's secret-storage facility.** This is a deliberate trade-off: it keeps the storage path identical across CLI and IDE surfaces and avoids a dependency on IDE-specific credential APIs. (Notable.)
- **Save bypasses the full settings webview.** This is the zero-friction on-ramp for a brand-new user. The settings webview remains the canonical path for power-user editing after initial setup. (Notable.)
- **The host-side empty-input check duplicates the client-side Save-button guard.** The Save button being disabled prevents the common path from sending an empty key, but the host validates independently because the message channel cannot be assumed to enforce this invariant. (Notable; defensive.)

## Shared Behavior

- The sidebar webview message protocol (spec 101) owns the message envelope shapes; this spec adds `apikey:saveError` and the save-anthropic-key outbound command name to that protocol.
- The machine-global config file's overall format and atomicity guarantees are owned by the auth-credential-storage spec.
- The configured-state computation that drives panel transitions after a successful save is owned by spec 142.
- Cloud-product LLM credential priority — what happens when both an API key and a signed-in product token are present — is owned by spec 10.
