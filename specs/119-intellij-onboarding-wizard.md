# IntelliJ First-Run Onboarding Card

## Topic Statement

A single-screen card that takes over the JolliMemory tool window whenever the user has neither signed in to the cloud service nor saved a local LLM API key, presenting two parallel options — "Use your Anthropic API key" and "Sign in to Jolli" — and flipping back to the main accordion the instant either path produces a credential.

## Scope

**In scope:**
- The trigger condition that decides whether the onboarding card or the main accordion is visible.
- The card's two-option layout and the textual contract of each option's title and description.
- The two interactive paths: inline API-key entry with format validation, and an external sign-in flow.
- The button states across each path and the textual labels at each state.
- The persistence consequence of each successful path: which configuration field is written, and how the parent surface flips back to the main view.
- The error surfacing for the sign-in path (an IDE notification banner) versus the API-key path (an inline red message under the field).
- The fact that the card has no per-step "Next/Back" sequence — both options are visible simultaneously.

**Out of scope:**
- The mechanics of the OAuth-style sign-in flow itself (browser handoff, callback wiring, token exchange) — owned by the auth service spec.
- The cloud-side validation of the saved Jolli token — owned by the auth service spec.
- The format of the local config file or the directory it lives in — owned by the configuration spec.
- The main accordion's internal layout — owned by the accordion spec.
- The hook installer or any UI for installing AI-agent hooks. The onboarding card never installs hooks.
- The status indicator and its colored dot. Those belong to the main accordion view.

## Data Contracts

### Trigger condition

The parent surface (the tool window factory) decides between the onboarding card and the main accordion every time auth or config state changes:

```
isConfigured = signedInToJolli OR (savedConfig.apiKey is non-blank)
show(onboarding) when isConfigured is false
show(accordion)  when isConfigured is true
```

`signedInToJolli` is read from the auth service. `savedConfig.apiKey` is the user's locally saved LLM provider key. Either one, on its own, satisfies `isConfigured`.

The flip is bi-directional: if the user later signs out and clears their key, the parent re-shows the onboarding card without restarting the IDE.

### Card body

The card is a vertically stacked group of regions, in this order:

1. **Header.** A logo + an H1-equivalent line ("Get started with Jolli Memory") + a one-paragraph gray subtitle.
2. **Divider.** A thin horizontal rule.
3. **"Use your Anthropic API key" option card.**
4. **"OR" separator.** A centered "OR" between two horizontal rules.
5. **"Sign in to Jolli" option card.**

Each option card contains an icon, a bold title line, a one-line gray description, and a single primary blue button beneath it.

### Option titles and descriptions

The exact text is part of the contract:

| Option        | Title                            | Description                                                                                                  | Button (idle)            |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------ |
| API key       | "Use your Anthropic API key"     | "Connect your own Anthropic API key for AI summarization. Memories are stored locally only."                 | "Configure API Key"      |
| Sign-in       | "Sign in to Jolli"               | "Use your Jolli account for AI summarization. Memories are stored locally, with the option to push to Jolli cloud." | "Sign In / Sign Up"      |

### API-key inline form

When the API-key button is clicked, the button is hidden and an inline panel takes its place:

- A "Anthropic API Key:" label.
- A masked password-style input field.
- A "Save" button beneath the field.
- An initially hidden warning message slot.

The format-validation rule is exactly two checks, in order:

| Check                                  | Warning message                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| Trimmed key is empty                   | "Enter your Anthropic API key"                                                   |
| Key does not start with `sk-ant-`      | "Anthropic API Key should start with sk-ant-"                                    |

Both warnings render in red beneath the field. The keystroke field never validates live — only "Save" triggers the checks.

### Sign-in button states

The sign-in button has exactly one textual state:

| State        | Label                | Enabled |
| ------------ | -------------------- | ------- |
| Idle         | "Sign In / Sign Up"  | yes     |

The click handler does not disable the button and does not relabel it, so there is **no in-flight state**: the button reads "Sign In / Sign Up" and stays clickable for the whole duration of the external flow. The card still subscribes to the auth service's listener and that listener still assigns the idle label and enabled state, but since the button never leaves idle, the assignment is a no-op restatement rather than a recovery.

## Behavior

### API-key path

1. The user clicks "Configure API Key". The button is hidden; the inline form is shown; focus moves to the field.
2. The user types a key and clicks "Save".
3. Validation runs (empty? `sk-ant-` prefix?). On failure, the warning slot becomes visible with the matching message and the path stops.
4. On success, the warning slot is hidden. The local config is updated:
   - `apiKey` is set to the trimmed key.
   - `aiProvider` is set to `anthropic`.
5. The project status is asked to refresh.
6. The card calls back to the parent surface, which re-evaluates `isConfigured` and flips to the main accordion.

The inline form remains visible until the parent surface flips the view away — there is no separate "thank you" screen.

### Sign-in path

1. The user clicks "Sign In / Sign Up". The click is fire-and-forget — the button is not disabled and not relabelled.
2. The auth service's external sign-in flow begins. The card itself does not hold any UI for that flow — it is handed off to the auth service.
3. On success, the card writes a follow-up config update:
   - If `aiProvider` is currently empty or `anthropic`, it is set to `jolli`.
   - The existing `apiKey` (if any) is left untouched.
4. The project status is asked to refresh.
5. The parent surface's own auth listener flips the view from onboarding to the main accordion.

If the sign-in fails, the card's onError callback is invoked and an IDE-level notification banner is raised with the failure message. Nothing about the button changes — there is no state to restore. The card itself does not show an inline error for the sign-in path — only for the API-key path.

A user who closes the browser window mid-flow therefore needs no recovery: the button was never taken away from them, so they can simply click it again.

### Mid-flow exit

There is no formal "cancel" affordance. The user can close the tool window or switch projects at any time. Because the card's only persisted side effect is writing config / triggering the auth flow, an exit before either completes leaves no residue.

If the user closes the IDE while the sign-in is in flight, the next launch evaluates `isConfigured` afresh and either shows the onboarding card again (if no token landed) or the main accordion (if it did).

### View flip

The flip from onboarding card → main accordion is owned by the parent surface, not by this card. The card's only obligation is to fire its `onApiKeySaved` callback (API-key path) or trigger an auth-service listener (sign-in path); the parent surface re-runs `isConfigured` and swaps the card.

## State Transitions

```
[onboarding shown]
  signedIn = false, apiKey = blank

[user clicks "Configure API Key"]
  show inline form, hide button
  → state: API-key entry

[API-key entry: user types, clicks "Save", key is blank]
  → warning: "Enter your Anthropic API key"
  stay on API-key entry

[API-key entry: user types, clicks "Save", key does not start with sk-ant-]
  → warning: "Anthropic API Key should start with sk-ant-"
  stay on API-key entry

[API-key entry: user types, clicks "Save", key is valid]
  config.apiKey ← trimmed key
  config.aiProvider ← "anthropic"
  refresh project status
  → parent flips view → main accordion

[user clicks "Sign In / Sign Up"]
  hand off to auth service (button untouched — stays idle and clickable)
  → state: signing in

[signing in: auth service success]
  if aiProvider is blank or "anthropic": aiProvider ← "jolli"
  refresh project status
  → parent flips view → main accordion

[signing in: auth service error]
  raise IDE notification with error message
  stay on onboarding (signed-in path)

[after success: user later signs out and clears apiKey]
  → parent flips view → onboarding
```

## Notable Behavior

- **Both options are simultaneously visible.** There is no wizard-style "Step 1 / Step 2" sequence. The user picks a path on a single screen.
- **The API-key path validates only on click of "Save", never as the user types.** The warning is hidden after a successful save attempt and re-shown only on the next failed save.
- **The card never installs hooks.** Hook installation lives on the project status surface and is orthogonal to credentialing — the user can be fully signed in or have a saved API key with no hooks installed.
- **The view flip is owned by the parent.** The card itself only writes config and fires a callback; whether that flips the visible card is decided by the parent re-running `isConfigured`.
- **Either credential path is sufficient.** The user does not have to do both. After completing one, the other option's card simply disappears with the rest of the onboarding view.
- **The sign-in path errors via IDE notification, not inline.** The API-key path errors inline in red beneath the field. This split is intentional: the API-key path's failures are about format and only meaningful inline; the sign-in path's failures often reference an external browser flow and are surfaced as a higher-level alert.
- **The sign-in button has no in-flight state, so there is nothing to recover.** The click handler neither disables nor relabels it; the external flow runs with the button sitting enabled and reading "Sign In / Sign Up". The card's auth-service listener still assigns those exact values, but the button never left them — a closed browser window strands nothing, and a repeat click is the whole recovery path. (Surprising; intentional.)
- **Anthropic prefix is the only client-side check on the key.** The key is not test-pinged against the LLM provider before saving — saving fails only on prefix mismatch or empty input. Wrong-but-prefixed keys are accepted here and surface as a runtime failure later, on the first LLM call.
- **Sign-in does not overwrite an existing Anthropic API key.** If the user already has an `apiKey` saved and then signs in to the cloud, only `aiProvider` is updated. The Anthropic key remains in place.
- **Anthropic-key save sets `aiProvider` to `anthropic`.** Even if the previous value was `jolli`, the API-key path forces the provider field to `anthropic` because the user just deliberately chose this path.
- **There is no "Skip" or "Do this later".** The card persists as the only visible content of the tool window until one of the two paths produces a credential.

## Shared Behavior

- **Tool window factory** — the parent surface that owns the onboarding-vs-accordion view flip and re-evaluates `isConfigured`.
- **Auth service** — owns the external sign-in flow and the auth-listener channel the card subscribes to.
- **Local config storage** — the destination for `apiKey` and `aiProvider` writes.
- **Project status surface** — refreshed after each successful path so downstream consumers (the status dot, the per-section panels) pick up the new state.
- **IDE notification bus** — the channel the sign-in error path raises through.
