# IntelliJ First-Run Onboarding Card

## Topic Statement

A single-screen card that takes over the JolliMemory tool window whenever the user has no usable AI-provider configuration at all, presenting three parallel options — "Use a local agent CLI", "Use your Anthropic API key" and "Sign in to Jolli" — and flipping back to the main accordion the instant any path produces one.

## Scope

**In scope:**
- The trigger condition that decides whether the onboarding card or the main accordion is visible.
- The card's three-option layout and the textual contract of each option's title and description.
- The three interactive paths: a local-agent tool picker, inline API-key entry with format validation, and an external sign-in flow.
- The button states across each path and the textual labels at each state.
- The persistence consequence of each successful path: which configuration fields are written, and how the parent surface flips back to the main view.
- The local-agent path's additional side effects: clearing the paused flag, running initialization and the install, and emitting a surface-enabled telemetry event.
- The error surfacing for the sign-in path (an IDE notification banner) versus the API-key path (an inline red message under the field) — and the local-agent path's complete absence of any error surface.
- The fact that the card has no per-step "Next/Back" sequence — all three options are visible simultaneously.
- The divergence between this card's local-agent option and the sibling desktop-editor onboarding card's, which the change that introduced it described as parity.

**Out of scope:**
- The mechanics of the OAuth-style sign-in flow itself (browser handoff, callback wiring, token exchange) — owned by the auth service spec.
- The cloud-side validation of the saved Jolli token — owned by the auth service spec.
- The format of the local config file or the directory it lives in — owned by the configuration spec.
- The main accordion's internal layout — owned by the accordion spec.
- The hook installer's own mechanics. The card exposes no UI for installing hooks, and the two credential paths never install them — but the local-agent path **does** invoke the install (see Behavior); this spec records only that it does so, not what the install performs.
- The status indicator and its colored dot. Those belong to the main accordion view.

## Data Contracts

### Trigger condition

The parent surface (the tool window factory) decides between the onboarding card and the main accordion every time auth or config state changes. It re-reads the machine-global configuration record from disk on every evaluation and short-circuits on the **first** clause that holds, in this exact order:

```
isConfigured =
     savedConfig.paused == true                      // deliberately paused counts as configured
  OR savedConfig.aiProvider == "local-agent"          // a local agent needs no key at all
  OR savedConfig.apiKey is non-blank                  // saved LLM provider key
  OR env ANTHROPIC_API_KEY is non-blank               // ambient provider key
  OR savedConfig.jolliApiKey is non-blank             // cloud credential

show(onboarding) when isConfigured is false
show(accordion)  when isConfigured is true
```

(Corrected: this spec previously stated the predicate as "signed in to the cloud service OR a saved API key", read from the auth service. Four of the five clauses above were already true when that was written — the paused clause, the environment-variable clause, and the fact that the cloud clause is a **field on the saved configuration record**, not a query against the auth service. Only the local-agent clause is new.)

The local-agent clause exists because a local agent CLI drives its own subscription login, so this product holds no credential for it — there is nothing for any of the other clauses to observe. It mirrors the command-line surface's own credential resolution, which likewise reports the local-agent source whenever the provider is selected, with no presence or capability check. Without this clause the local-agent button would write its configuration and the view would never flip.

The flip is bi-directional: if the user later signs out, clears their key, and moves off the local-agent provider, the parent re-shows the onboarding card without restarting the IDE.

### Card body

The card is a vertically stacked group of regions, in this order:

1. **Header.** A logo + an H1-equivalent line ("Get started with Jolli Memory") + a one-paragraph gray subtitle.
2. **Divider.** A thin horizontal rule.
3. **"Use a local agent CLI" option card** — rendered **first**, above both credential paths.
4. **"OR" separator.** A centered "OR" between two horizontal rules.
5. **"Use your Anthropic API key" option card.**
6. **"OR" separator.**
7. **"Sign in to Jolli" option card.**

Each option card contains an icon, a bold title line, a one-line gray description, and a single primary blue button beneath it. The local-agent card carries two extra elements between the description and its button: an `Agent tool:` label with a dropdown beneath it, and a gray hint line reading "Make sure you're signed in to the tool."

### Option titles and descriptions

The exact text is part of the contract:

| Option        | Title                            | Description                                                                                                  | Button (idle)            |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Local agent   | "Use a local agent CLI"          | "Drive a local agent CLI (Claude Code, Codex, Cursor, OpenCode, Kimi) with its own login — no API key needed. Memories are stored locally only." | "Use Local Agent Tool" |
| API key       | "Use your Anthropic API key"     | "Connect your own Anthropic API key for AI summarization. Memories are stored locally only."                 | "Configure API Key"      |
| Sign-in       | "Sign in to Jolli"               | "Use your Jolli account for AI summarization. Memories are stored locally, with the option to push to Jolli cloud." | "Sign In / Sign Up"      |

### Local-agent tool dropdown

The dropdown's model is the plugin's **static Kotlin tool list** and nothing else — the same hand-maintained mirror of the command-line surface's tool registry that the settings dialog uses as its baseline (spec 135). Every supported tool is listed, in registry order, by its human label.

Unlike the settings dialog, this card performs **no** delegated fetch of the live tool list and **no** presence sweep of the machine — there is no asynchronous refresh, no override, and no filtering. The list is fixed at build time and identical on every machine. The selected row's index is mapped back to that same static list to recover the tool's command-line identifier at click time; an out-of-range index is coerced to the first entry.

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

### Local-agent path

1. The user picks a tool from the dropdown (or leaves the first one selected) and clicks "Use Local Agent Tool".
2. The button is **disabled** and relabelled to "Setting up...".
3. The machine-global configuration record is loaded, copied with three fields changed, and saved back as a whole record:
   - `aiProvider` ← `local-agent`.
   - `localAgentTool` ← the selected tool's command-line identifier (not its label).
   - `paused` ← cleared.
4. The remainder runs off the interface thread, in order:
   1. Initialize the project service if it is not already initialized.
   2. Run the **install** — the same hook/integration install the enable action performs.
   3. Emit a surface-enabled telemetry event carrying the trigger `onboarding`.
   4. Refresh the project status.
5. Back on the interface thread: the button is re-enabled and relabelled to "Use Local Agent Tool", and the card fires the same `onApiKeySaved` callback the API-key path uses. The parent surface turns that into a view re-evaluation and flips to the main accordion.

**No verification happens anywhere in this path.** The tool is not probed, its binary is not looked for, and nothing checks that the user is signed in to it. Step 3 writes unconditionally, and step 5 flips the view unconditionally. There is no error surface on this path at all — not inline, not as a notification. A failure inside step 4 is whatever those calls do on their own; the button still restores and the view still flips.

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
  not paused, aiProvider ≠ "local-agent", apiKey blank,
  ANTHROPIC_API_KEY blank, jolliApiKey blank

[user picks a tool and clicks "Use Local Agent Tool"]
  button disabled, label ← "Setting up..."
  config.aiProvider    ← "local-agent"
  config.localAgentTool ← selected tool id
  config.paused        ← cleared
  off-thread: initialize (if needed) → install → telemetry("surface_enabled", trigger=onboarding) → refresh status
  button restored
  → parent flips view → main accordion   (unconditionally; no probe, no error path)

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

- **All three options are simultaneously visible.** There is no wizard-style "Step 1 / Step 2" sequence. The user picks a path on a single screen. The local-agent option is rendered first, so the credential-free path is the one a new user meets before either credential path.
- **The local-agent path offers every tool unconditionally and verifies none of them.** The dropdown is the static build-time list, not a detection result, so every tool is offered on every machine regardless of what is installed. Nothing probes the selected tool before writing, and the write and the view flip both happen unconditionally. A user can therefore select a tool they do not have, land on the fully-configured main accordion, and only discover the problem when a memory generation later fails. (Surprising.)
- **The sibling desktop-editor onboarding does the opposite on both counts, and the change that added this one described the two as parity.** That surface's local-agent card lists **only tools its presence sweep actually detected**, and its selection command **capability-probes** the chosen tool before writing anything — on a failed probe it writes no configuration, leaves the provider unchanged, and surfaces an inline error naming the tool. This card has neither the sweep nor the probe. It also does two things the sibling command does not: it **clears the paused flag**, and it **runs an install**. The claim of parity is not borne out by the code. (Surprising; a real divergence recorded as observed behavior.)
- **The API-key path validates only on click of "Save", never as the user types.** The warning is hidden after a successful save attempt and re-shown only on the next failed save.
- **The two credential paths never install hooks.** Hook installation lives on the project status surface and is orthogonal to credentialing — the user can be fully signed in or have a saved API key with no hooks installed. The local-agent path is the exception and installs eagerly.
- **The view flip is owned by the parent.** The card itself only writes config and fires a callback; whether that flips the visible card is decided by the parent re-running `isConfigured`.
- **Any one of the three paths is sufficient.** The user does not have to do more than one. After completing one, the other two option cards simply disappear with the rest of the onboarding view. Note that only two of the three produce a *credential* at all — the local-agent path produces a provider selection and no credential, which is precisely why the trigger predicate needed its own clause for it.
- **The card never installs hooks — except on the local-agent path.** The out-of-scope note that "the onboarding card never installs hooks" held for the two credential paths and still does; the local-agent button breaks it deliberately, running initialization and the install itself so the user does not need a separate enable step. (Corrected: the previously stated invariant is now path-specific.)
- **The sign-in path errors via IDE notification, not inline.** The API-key path errors inline in red beneath the field. This split is intentional: the API-key path's failures are about format and only meaningful inline; the sign-in path's failures often reference an external browser flow and are surfaced as a higher-level alert.
- **The sign-in button has no in-flight state, so there is nothing to recover.** The click handler neither disables nor relabels it; the external flow runs with the button sitting enabled and reading "Sign In / Sign Up". The card's auth-service listener still assigns those exact values, but the button never left them — a closed browser window strands nothing, and a repeat click is the whole recovery path. (Surprising; intentional.)
- **Anthropic prefix is the only client-side check on the key.** The key is not test-pinged against the LLM provider before saving — saving fails only on prefix mismatch or empty input. Wrong-but-prefixed keys are accepted here and surface as a runtime failure later, on the first LLM call.
- **Sign-in does not overwrite an existing Anthropic API key.** If the user already has an `apiKey` saved and then signs in to the cloud, only `aiProvider` is updated. The Anthropic key remains in place.
- **Anthropic-key save sets `aiProvider` to `anthropic`.** Even if the previous value was `jolli`, the API-key path forces the provider field to `anthropic` because the user just deliberately chose this path.
- **There is no "Skip" or "Do this later".** The card persists as the only visible content of the tool window until one of the two paths produces a credential.

## Shared Behavior

- **Tool window factory** — the parent surface that owns the onboarding-vs-accordion view flip and re-evaluates `isConfigured`.
- **Auth service** — owns the external sign-in flow and the auth-listener channel the card subscribes to.
- **Local config storage** — the destination for `apiKey`, `aiProvider`, `localAgentTool` and the paused-flag writes.
- **Local-agent tool registry** (spec 135) — owns the static Kotlin tool list this card's dropdown renders, its lockstep obligation against the command-line registry, and the two-tier baseline/override behaviour the settings dialog adds on top. This card consumes the static tier only.
- **Project service** — the target of the local-agent path's initialize, install, and status-refresh calls.
- **Telemetry** — the destination of the local-agent path's surface-enabled event.
- **Project status surface** — refreshed after each successful path so downstream consumers (the status dot, the per-section panels) pick up the new state.
- **IDE notification bus** — the channel the sign-in error path raises through.
