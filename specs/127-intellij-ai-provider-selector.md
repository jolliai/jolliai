# IntelliJ AI Provider Selector

## Topic Statement

A reusable form component lets the user pick which AI summarization provider to use — the proxied account-token route or the direct API-key route — and exposes the chosen value plus the resolved credential to the embedding settings dialog without persisting the selection itself.

## Scope

- A self-contained panel containing a labeled dropdown, a conditional API-key entry field shown only for the direct route, and an inline warning line that mirrors the current validation result.
- Loading initial state from the persisted IntelliJ-specific config and choosing a sensible default selection when the persisted value is absent.
- Reporting the canonical lowercase provider value back to the embedder (for persistence) and reporting the effective API key back to the embedder (resolved from masked-display semantics).
- Live validation: emitting a warning whenever the selection is incomplete (no provider chosen, signed-out for the proxy route, or empty/badly-formatted key for the direct route).
- A state-change listener bus that fires on dropdown selection, on auth-status changes, and on every keystroke inside the API-key field.
- An auto-switch behavior: when the user signs in to the Jolli account while the dropdown reads "no provider," the dropdown moves to the proxy choice automatically.

Out of scope: the underlying credential routing during request dispatch (the credential-priority spec covers that); persisting the chosen value (the embedding dialog or onboarding panel does that on its own schedule); the auth flow itself.

## Data Contracts

The component holds three labeled choices, identified by their visible strings:
- "(Select a provider)" — sentinel for "user has not picked yet"; never persisted.
- "Jolli" — chooses the proxy route; persisted as the lowercase token `jolli`.
- "Anthropic" — chooses the direct route; persisted as the lowercase token `anthropic`.

Internal mutable state:
- The fully unmasked saved API key, kept so the component can detect when the user has not edited the masked display.
- The masked rendering of that saved key.
- A suppression flag that disables listener fanout during programmatic updates.

The component reads a configuration object exposing four nullable fields it cares about:
- `apiKey` — the saved API key for the direct route.
- `aiProvider` — a lowercase string holding the user's last persisted provider, or null.
- A live "is signed in to Jolli account" boolean obtained from the auth service at call time.
- (Other config fields are present but unused by this component.)

The component's outputs to its embedder:
- `getProvider()` — `"jolli"`, `"anthropic"`, or null when nothing is selected (callers should treat null as "do not save").
- `getEffectiveAnthropicKey()` — if the typed text equals the masked display, return the previously-saved key unchanged; otherwise return what the user typed verbatim.
- `validateInput()` — null when the current state is valid, otherwise a structured result pointing at either the dropdown or the key field with one of four pre-defined warning strings.
- `isFullyConfigured()` — convenience boolean derived from `validateInput`.

## Behavior

### Initial population

When the embedder calls `loadFromConfig`, the component:
1. Suppresses listener fanout for the duration of the load.
2. Records the unmasked saved key, computes a masked rendering, and writes the masked rendering into the key field.
3. Resolves the dropdown selection by precedence:
   - If `aiProvider` is the lowercase token `jolli`, select the Jolli choice — this honors the user's explicit prior choice even if their session is currently signed out and shows them the relevant warning.
   - If `aiProvider` is the lowercase token `anthropic`, select the Anthropic choice — same logic; if the saved key is now blank, the warning will fire.
   - Otherwise (null or unrecognized), if the user is currently signed in to Jolli, select Jolli.
   - Otherwise, if a saved API key is non-blank, select Anthropic.
   - Otherwise, select the "(Select a provider)" sentinel — cold-start.
4. Applies the resolved selection (which shows or hides the API-key card, see below) and refreshes the warning label.

### Card visibility

The dropdown is paired with a card layout containing two cards: an "Anthropic" card holding the API-key field and an empty card. When the dropdown selection becomes Anthropic, the Anthropic card is shown and the card panel becomes visible. When the dropdown selection becomes Jolli or the sentinel, the empty card is shown and the card panel itself is hidden so the form does not reserve vertical space for an unused field.

### Validation

Validation is recomputed on every input event and exposed via `validateInput`:
- Sentinel selected → warning bound to the dropdown: "Select your AI summarization provider to use Jolli Memory."
- Jolli selected and not signed in → warning bound to the dropdown: "Must be signed into Jolli."
- Anthropic selected and the effective key is blank → warning bound to the key field: "Enter your Anthropic API key."
- Anthropic selected, the user has typed a non-blank value distinct from the masked display, and that typed value does not start with the canonical Anthropic prefix → warning bound to the key field: "Anthropic API Key should start with sk-ant-."
- Anything else → no warning.

The warning label is visible only when validation returns a non-null result. The label renders the message in red HTML.

### State-change events

Three input sources can fire the state-change listeners:
- Dropdown selection changing to a different value (via the platform's combo-box selection event), as long as suppression is not active. Selection changes also re-apply the card-visibility and re-run validation before fanning out.
- Every keystroke in the API-key field (via the standard document-change listener), as long as suppression is not active. Each keystroke re-runs validation and fans out.
- Auth-service notifications — the component subscribes once on construction. When the auth status changes:
  - If the user just signed in and the current selection is the sentinel, the component programmatically switches the selection to Jolli (suppressing fanout during the programmatic write, then immediately re-applying the selection visuals).
  - Validation is re-run and listeners fire on every auth change, even when the selection did not move (a sign-out while Jolli is selected must surface the "must be signed in" warning).

All auth-driven updates marshal to the UI thread first.

### Effective key resolution

The API-key field starts populated with the masked rendering of the saved key. If the user does not touch the field, `getEffectiveAnthropicKey` returns the original unmasked saved key (so the embedder writes back the unchanged value without needing to detect "user kept the placeholder"). If the user types anything that differs from the masked rendering, the typed text is returned verbatim and the embedder stores that.

The masking rule:
- Empty key → empty string.
- Keys starting with one of the recognized prefixes (`sk-ant-`, `sk-jol-`) are always masked, even when short.
- Other keys longer than 16 characters are masked.
- Other shorter keys are returned unchanged (they will not match a typed-back display, so the embedder always sees the user's text).
- Mask form: first 12 characters of the key, four asterisks, last 4 characters.

### Disposal

The component holds a registration with the auth-service listener bus. When disposed, that registration is released. Multiple internal listener lists (the IDE's UI toolkit document and combo-box listeners) are released by the IDE when the panel is unparented; only the auth subscription needs explicit cleanup.

## State Transitions

The dropdown moves through the following observable states; the visible API-key card and the warning text follow deterministically.

- **No provider** — sentinel selected. Card hidden. Warning: "Select your AI summarization provider to use Jolli Memory."
- **Jolli, signed in** — Jolli selected with active auth. Card hidden. No warning.
- **Jolli, signed out** — Jolli selected without auth. Card hidden. Warning: "Must be signed into Jolli."
- **Anthropic, valid key** — Anthropic selected; effective key non-blank; either matches masked display (saved key is honored) or starts with the canonical prefix. Card visible. No warning.
- **Anthropic, blank key** — Anthropic selected; effective key blank. Card visible. Warning: "Enter your Anthropic API key."
- **Anthropic, malformed typed key** — Anthropic selected; user typed something that does not start with the canonical prefix and is not the masked display. Card visible. Warning: "Anthropic API Key should start with sk-ant-."

Auth events can move the state between Jolli-signed-in and Jolli-signed-out without the user touching the dropdown, and can move No-provider to Jolli-signed-in on sign-in. Keystrokes can move between the three Anthropic states.

## Notable Behavior

- The component does not write to disk. The embedder reads `getProvider` and `getEffectiveAnthropicKey` and persists at its own moment (Apply button on a dialog, or immediately after a successful sign-in for the onboarding panel).
- Auto-switch on sign-in fires only when the current selection is the sentinel; if the user has explicitly chosen Anthropic, signing in does not reroute them.
- Auto-switch fires the state-change listeners after the programmatic switch, so embedders that gate their UI on `isFullyConfigured` re-render correctly.
- The masked display always preserves the prefix (when recognized) and the last four characters; intermediate characters are hidden. A user pasting a freshly issued key over the masked display sees their full new key while typing because document changes fire on every keystroke and the typed text is no longer equal to the masked display from that moment on.
- The warning "Anthropic API Key should start with sk-ant-" is only triggered when the user has typed something that diverges from the masked display; an unchanged masked display does not retrigger this warning even if the underlying saved key starts with the older prefix variant.
- Selecting the sentinel programmatically (via `loadFromConfig` for cold-start) is allowed; selecting it through the dropdown later is also valid and will emit the "select a provider" warning.
- The auth-listener subscription is set up in `init`, before `loadFromConfig` is called, so the very first load already reflects the live auth state.

## Shared Behavior

- The auth-service status (signed-in boolean, listener bus) is shared with the sign-in bar, the onboarding panel, and other surfaces.
- The persisted `aiProvider` field, the saved key, and the underlying credential file are described in spec 129 (config migration) and the credential-priority spec.
- The embedder's persistence is dialog-specific: the settings dialog persists on Apply via the global config writer (covered in spec 129); the onboarding panel persists immediately after the relevant sign-in or key entry.
- The masked-display semantics for "saved key vs typed key" is reused across other API-key form components in the IntelliJ surface.
