# 142. VS Code Onboarding Panel

## Topic Statement

A full-viewport sidebar panel replaces the tab UI when the user is unconfigured, presenting a local-key path as the recommended option above a sign-in option, with sibling panels for the disabled state and the loading state.

## Scope

**In scope:**

- The four mutually-exclusive sidebar viewport states and the rules that govern which one is visible at any time.
- The configured boolean: how it is derived, what makes it true, and why it is recomputed independently of the enabled boolean.
- The loading state and the single message that permanently dismisses it.
- The onboarding panel's two configuration-path cards and their outbound command triggers.
- The disabled panel's single affordance and its outbound command trigger.
- The inbound messages that drive transitions between the four viewport states.
- The one-shot auto-tab-switch that fires on the first configured false→true flip.

**Out of scope (boundaries):**

- The API-key capture sub-view triggered by the recommended card's button — that is defined by **VS Code Anthropic API Key Panel** (spec 143).
- The sidebar webview message protocol's envelope shapes — those are defined by **Sidebar Webview Message Protocol** (spec 101).
- The activation lifecycle and the initial-state-readiness barrier that gates the loading→panel transition — defined by **VS Code Extension Activation Lifecycle** (spec 100).
- The auto-installation of git hooks on first activation — defined by **Auto-Enable on Activation** (spec 145).
- The configured-state computation side-effects on the machine-global config load path (why the config is loaded unconditionally) are a consequence of this spec's requirement but the config-load behavior itself is defined by the auth-credential-storage spec.

## Data Contracts

### Configured boolean

The host computes a single boolean: `configured = signedIn || hasApiKey`.

| Source field     | Type    | Meaning                                                                  |
| ---------------- | ------- | ------------------------------------------------------------------------ |
| `signedIn`       | boolean | Derived from the status snapshot; true when the user holds a valid cloud-product session. |
| `hasApiKey`      | boolean | Derived from the status snapshot; true when a non-empty Anthropic API key is present in the machine-global config. |

Either field being true makes `configured` true. Both may be true simultaneously; neither has priority over the other for this boolean.

### Inbound messages (host → webview)

| Message kind        | Payload fields                              | Effect on viewport                                                         |
| ------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `init`              | `enabled: boolean`, `configured: boolean`, `degradedReason?: string`, … | Dismisses the loading state permanently; seeds the state machine. |
| `enabled:changed`   | `enabled: boolean`                          | Updates the enabled boolean; re-evaluates the active panel.                |
| `auth:changed`      | `authenticated: boolean`                    | Updates the authenticated boolean (informational for status-bar paths; does not directly re-evaluate configured). |
| `configured:changed`| `configured: boolean`                       | Updates the configured boolean; re-evaluates the active panel; triggers the one-shot tab-switch when configured flips false→true for the first time. |

A `degradedReason` field on the `init` payload causes the legacy degraded banner inside the tab UI to appear (no-workspace, no-git cases). The degraded banner is distinct from the onboarding or disabled panels and is not affected by the configured boolean.

### Outbound messages (webview → host)

| Button                  | Command name forwarded | Panel          |
| ----------------------- | ---------------------- | -------------- |
| "Configure API Key"     | open-settings command  | Onboarding     |
| "Sign In / Sign Up"     | sign-in command        | Onboarding     |
| "Enable Jolli Memory"   | enable command         | Disabled       |

All three are sent as generic outbound command messages; the actual command identifiers are resolved by the host.

## Behavior

### Loading state

The loading placeholder is visible from first paint. It is hidden permanently when the host posts an `init` message. No subsequent message restores the loading placeholder.

### Panel selection after init

On receipt of `init` (and on each subsequent `enabled:changed` or `configured:changed`), the host-driven state machine selects exactly one of the following:

1. `configured = false` → **Onboarding** panel is visible; Tab UI and Disabled panel are hidden.
2. `configured = true` and `enabled = false` → **Disabled** panel is visible; Tab UI and Onboarding panel are hidden.
3. `configured = true` and `enabled = true` → **Tab UI** is visible; Onboarding and Disabled panels are hidden. (A `degradedReason` may additionally show the legacy degraded banner inside the Tab UI.)

### Onboarding panel layout (top to bottom)

1. Header: a sparkle icon, the title "Get started with Jolli Memory", and a subtitle line.
2. A horizontal divider.
3. A recommended card containing a key icon, a "RECOMMENDED" badge, the label "Use your Anthropic API key", and a hint "Memories stored locally only".
4. A primary button labeled "Configure API Key" — sends the open-settings command.
5. An OR divider.
6. A secondary card containing a cloud icon and the label "Sign in to Jolli".
7. A secondary button labeled "Sign In / Sign Up" — sends the sign-in command.

### Disabled panel layout

1. The same header copy as the onboarding panel (sparkle icon, title, subtitle).
2. A single primary button labeled "Enable Jolli Memory" — sends the enable command.

No option cards and no OR divider appear in the disabled panel.

### One-shot auto-tab-switch

On the first transition of `configured` from `false` to `true`, the webview programmatically activates the Status tab. This trigger fires at most once per webview lifetime. Subsequent flips of `configured` — including a true→false→true round-trip — do not re-trigger the switch.

## State Transitions

The sidebar viewport has five states; four are stable:

- **Pre-init.** The loading placeholder is visible. No other panel is shown.
- **Onboarding.** `configured = false`; the onboarding panel is visible.
- **Disabled.** `configured = true`, `enabled = false`; the disabled panel is visible.
- **Active (Tab UI).** `configured = true`, `enabled = true`; the tab bar, toolbar, and tab content are visible.
- **Active Degraded.** `configured = true`, `enabled = true`, `degradedReason` present; the tab UI is visible and the legacy degraded banner is shown inside it.

Allowed transitions:

- Pre-init → any stable state: first `init` message resolves the loading state.
- Onboarding → Disabled: `configured:changed` arrives with `configured: true` while `enabled = false`.
- Onboarding → Active or Active Degraded: `configured:changed` arrives with `configured: true` while `enabled = true`.
- Disabled → Onboarding: `configured:changed` arrives with `configured: false` (e.g. API key removed and user signed out simultaneously).
- Disabled → Active or Active Degraded: `enabled:changed` arrives with `enabled: true`.
- Active → Disabled: `enabled:changed` arrives with `enabled: false`.
- Active → Onboarding: not a normal path (configured cannot become false once configured without also disabling); the state machine handles it defensively.
- Active ↔ Active Degraded: driven by `degradedReason` presence changes within the Tab UI; not driven by configured or enabled.

## Notable Behavior

- **A configured user who disables the project sees the Disabled panel, not the Onboarding panel.** The configured boolean is evaluated independently of enabled, so a deliberate disable does not trap the user behind an onboarding flow they already completed. (Surprising; intentional.)
- **The machine-global config is loaded unconditionally, not only when the project is enabled.** Without this, disabling would clear the cached configured value and show the Onboarding panel in place of the Disabled panel, removing the only "Enable" affordance the user has. (Surprising; intentional.)
- **The one-shot tab-switch is keyed to webview lifetime, not session lifetime.** Closing and reopening the sidebar creates a new webview instance whose one-shot flag resets — but the user is already in the Active state at that point, so `configured` never flips false→true again in the new instance. In practice the auto-switch fires exactly once per project-activation event. (Notable.)
- **The loading placeholder is visible at first paint before any host message arrives.** This prevents a blank white flash while the host resolves its initial-state-readiness barrier. (Notable.)
- **The Disabled panel and the auto-enable behavior were introduced together.** They jointly replace the prior first-run flow where the user had to manually click Enable from within the onboarding surface. (Notable.)

## Shared Behavior

- The sidebar webview message protocol (spec 101) owns the message envelope shapes; this spec adds `configured:changed` to that protocol.
- The auto-enable on activation (spec 145) is independent; auto-enable can succeed before the user becomes configured, in which case the Onboarding panel still shows.
- The Anthropic API key capture sub-view is owned by spec 143.
- The activation lifecycle (spec 100) owns the initial-state-readiness barrier that gates the loading→panel transition.
- The Tab UI's tab bar, toolbar, and degraded banner rendering are out of scope for this spec.
