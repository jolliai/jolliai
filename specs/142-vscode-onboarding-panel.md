# 142. VS Code Onboarding Panel

## Topic Statement

A full-viewport sidebar panel replaces the tab UI when the user is unconfigured, offering up to three ways to set summarization up — driving a locally-installed agent tool, supplying an Anthropic API key, or signing in to Jolli — where the local-agent path is offered (and recommended) only when such a tool was found on this machine, with sibling panels for the disabled state and the loading state.

## Scope

**In scope:**

- The four mutually-exclusive sidebar viewport states and the rules that govern which one is visible at any time.
- The configured boolean: how it is derived (three independent arms), what makes it true, and why it is recomputed independently of the enabled boolean.
- The loading state and the single message that permanently dismisses it.
- The onboarding panel's up-to-three configuration-path cards, the two shapes the panel takes, and each card's outbound trigger.
- The detected-local-agent-tool list: when it is swept, when it is deliberately left empty, when it is refreshed, and what an empty list does to the panel.
- The local-agent selection round-trip: the in-flight control states, the three failure wordings, and the retirement of the panel on success.
- The invariant that exactly one card carries the RECOMMENDED badge in every state.
- The disabled panel's single affordance and its outbound command trigger.
- The inbound messages that drive transitions between the four viewport states.
- The one-shot auto-tab-switch that fires on the first configured false→true flip.

**Out of scope (boundaries):**

- The API-key capture sub-view triggered by the API-key card's button — that is defined by **VS Code Anthropic API Key Panel** (spec 143).
- Whether a given agent tool is present on disk, and whether it actually runs — both predicates are owned by **Local Agent CLI Provider Backend** (spec 280). This spec owns only which predicate each surface is allowed to pay for, and when.
- The sidebar webview message protocol's envelope shapes — those are defined by **Sidebar Webview Message Protocol** (spec 101).
- The activation lifecycle and the initial-state-readiness barrier that gates the loading→panel transition — defined by **VS Code Extension Activation Lifecycle** (spec 100).
- The auto-installation of git hooks on first activation — defined by **Auto-Enable on Activation** (spec 144).
- The configured-state computation side-effects on the machine-global config load path (why the config is loaded unconditionally) are a consequence of this spec's requirement but the config-load behavior itself is defined by the auth-credential-storage spec.

## Data Contracts

### Configured boolean

The host computes a single boolean, **configured**, that is true when any one of three independent conditions holds: the user holds a cloud-product session, a non-empty vendor API key is on file, or the recorded summarization provider is the local agent tool.

| Source field     | Type    | Meaning                                                                  |
| ---------------- | ------- | ------------------------------------------------------------------------ |
| `signedIn`       | boolean | Derived from the status snapshot; true when the user holds a valid cloud-product session. |
| `hasApiKey`      | boolean | Derived from the status snapshot; true when a non-empty Anthropic API key is present in the machine-global config. |
| `usesLocalAgent` | boolean | Derived from the status snapshot; true when the recorded summarization provider is the local-agent one. |

Any one arm being true makes `configured` true. Several may be true simultaneously; none has priority over the others for this boolean.

The third arm exists because a local-agent provider holds no jollimemory credential at all — the agent tool's own login is the credential — so a user who has picked it is finished with setup and must not be shown onboarding.

**It keys on the recorded *choice*, never on whether that tool is currently installed or runnable.** Neither the presence sweep nor the capability probe feeds this boolean. If the user later uninstalls the agent, the choice stands: silently dropping them back into onboarding would discard a decision they made deliberately, and would present the onboarding cards as if nothing had ever been configured. That failure mode is instead reported by the diagnostic command and at summarization time, where it can be named and repaired.

The derived local-agent arm has exactly one consumer — this onboarding gate. The Status tab's own summarization-provider row reads the recorded provider directly rather than through this signal, so adding the arm changed no status row.

### Detected local-agent tools

An ordered list of the locally-installed agent tools the host found, each entry carrying the identifier that would be persisted and the display label shown to the user. It is carried on the initial-state payload and refreshed by its own inbound message. An absent or empty list means no local-agent card is offered.

The list is **deliberately empty for a user who is already configured** — the sweep is skipped for them, because they never see the card.

### Inbound messages (host → webview)

| Message kind          | Payload fields                              | Effect on viewport                                                         |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `init`                | `enabled: boolean`, `configured: boolean`, `localAgents?: [{ id, label }]`, `degradedReason?: string`, … | Dismisses the loading state permanently; seeds the state machine, including the initial shape of the onboarding panel. |
| `enabled:changed`     | `enabled: boolean`                          | Updates the enabled boolean; re-evaluates the active panel.                |
| `auth:changed`        | `authenticated: boolean`                    | Updates the authenticated boolean (informational for status-bar paths; does not directly re-evaluate configured). |
| `configured:changed`  | `configured: boolean`                       | Updates the configured boolean; re-evaluates the active panel; triggers the one-shot tab-switch when configured flips false→true for the first time. |
| `localAgents:changed` | `localAgents: [{ id, label }]`              | Replaces the detected-tool list and re-shapes the onboarding panel (card shown or hidden, dropdown repopulated, badge relocated). Arrives **before** the `configured:changed` that re-raises the panel, so the first paint is already correct. |
| `localAgent:selectError` | `message: string`                        | Renders the message on the local-agent card's inline error line and restores its controls. **Ignored when the onboarding cards are not on screen** (see the stuck-control defect under Notable Behavior). An empty or non-string message falls back to "Could not use that tool." |

A `degradedReason` field on the `init` payload causes the legacy degraded banner inside the tab UI to appear (no-workspace, no-git cases). The degraded banner is distinct from the onboarding or disabled panels and is not affected by the configured boolean.

### Outbound messages (webview → host)

| Button                  | Effect                                                          | Panel          |
| ----------------------- | --------------------------------------------------------------- | -------------- |
| "Use Local Agent Tool"  | Local-agent adoption command, carrying the dropdown's currently selected tool identifier. | Onboarding |
| "Configure API Key"     | **No outbound message** — switches to the API-key entry sub-view within the same viewport (spec 143). | Onboarding |
| "Sign In / Sign Up"     | Sign-in command                                                 | Onboarding     |
| "Enable Jolli Memory"   | Enable command                                                  | Disabled       |

The three that reach the host are sent as generic outbound command messages; the actual command identifiers are resolved by the host.

## Behavior

### Loading state

The loading placeholder is visible from first paint. It is hidden permanently when the host posts an `init` message. No subsequent message restores the loading placeholder.

### Panel selection after init

On receipt of `init` (and on each subsequent `enabled:changed` or `configured:changed`), the host-driven state machine selects exactly one of the following:

1. `configured = false` → **Onboarding** panel is visible; Tab UI and Disabled panel are hidden.
2. `configured = true` and `enabled = false` → **Disabled** panel is visible; Tab UI and Onboarding panel are hidden.
3. `configured = true` and `enabled = true` → **Tab UI** is visible; Onboarding and Disabled panels are hidden. (A `degradedReason` may additionally show the legacy degraded banner inside the Tab UI.)

### Detected-tool list lifecycle

- **At activation**, before the initial-state-readiness barrier releases, the host performs a presence-only sweep for locally-installed agent tools and carries the result on the initial-state payload. The sweep touches the filesystem only and launches **no subprocess**, which is what lets it sit on the activation path at all.
- **The sweep is skipped for a user who is already configured**, so their list stays empty. This is a cost optimization, not a one-shot.
- **On any configured true→false flip** — signing out, clearing the key, or moving the recorded provider off the local agent — the host re-runs the sweep and pushes the refreshed list **before** flipping the configured flag. The re-raised panel therefore paints from a current sweep rather than from the empty startup snapshot.
- **Nothing watches the filesystem.** Installing an agent tool while the panel is already on screen does not make its card appear; that needs a fresh webview (collapsing and re-revealing the sidebar, or a window reload).
- The sweep never fails the panel: any error leaves the list empty, which renders Shape B.
- The sweep is run **without** an explicit-executable-path override. A tool that exists only at an explicitly configured path is therefore reported **absent** here and gets no card — even though the capability probe run after a selection would honour that path for its own tool.

### Onboarding panel layout (top to bottom)

The panel takes one of two shapes, decided entirely by whether the detected-tool list is non-empty.

**Header, in both shapes:**

1. A sparkle icon, the title "Get started with Jolli Memory", and the subtitle "Jolli Memory automatically captures your work context and surfaces relevant memories as you code. Choose how you'd like to set it up."
2. A horizontal divider.

**Shape A — at least one local agent tool detected.** The local-agent path comes first and carries the badge:

3. A card containing a terminal icon, the single "RECOMMENDED" badge, the title "Use your local agent tool", the description "Use your local agent tool for AI summarization. Memories are stored locally only.", the hint "Make sure you're signed in to the tool.", a label reading "Agent tool", and a dropdown listing the detected tools in the product's fixed display order with the **first entry pre-selected**.
4. An inline error line, hidden unless a selection attempt failed.
5. A primary button labeled "Use Local Agent Tool".
6. An OR divider.
7. A card containing a key icon, the title "Use your Anthropic API key", and the description "Connect your own Anthropic API key for AI summarization. Memories are stored locally only." — **no badge**.
8. A secondary button labeled "Configure API Key".
9. An OR divider.
10. A card containing a cloud icon, the title "Sign in to Jolli", and the description "Use your Jolli account for AI summarization. Memories are stored locally, with the option to push to Jolli cloud."
11. A secondary button labeled "Sign In / Sign Up".

**Shape B — no local agent tool detected.** The entire local-agent block (its card, its error line, its button, and its OR divider) is absent, and the badge sits on the Anthropic API-key card instead. The panel therefore reads exactly as it did before this option existed, with one difference: the "Configure API Key" button is now **secondary** rather than primary, matching "Sign In / Sign Up". Items 7–11 above, with the badge on item 7.

**The badge is one node, physically moved between the two cards — never duplicated, never merely hidden.** Exactly one card carries the badge in every rendered state; there is no state with two badges and no state with none.

The *recommended* styling that accompanies it is less disciplined than the badge itself: the local-agent card carries that styling from birth and never has it removed, so when no tool is detected the styling sits on two cards at once — the visible key-entry card and the hidden local-agent card. Only one of them is on screen, so the reader never sees a contradiction, and the badge node remains the single source of truth for which path is being recommended.

### Choosing a local agent tool

1. The user picks a tool from the dropdown (or leaves the pre-selected first entry) and activates "Use Local Agent Tool". A click with no tool selected does nothing.
2. The button and the dropdown are both disabled and the button's label becomes "Checking…". Any previous inline error is cleared. The chosen identifier is sent to the host.
3. The host re-validates the identifier against the supported-tool registry — the webview's value is untrusted input — and then runs the **expensive per-tool capability probe** for that one tool. This is the only place the panel pays that cost: the activation-time sweep is presence-only, precisely so the probe is paid once, for the tool the user actually chose.
4. **On success** the host writes only two fields to the machine-global configuration — the summarization provider and the chosen tool — and refreshes status. That flips the configured boolean, which retires the panel through the ordinary configured false→true transition. There is **no separate confirmation message**: the panel disappearing is the confirmation.
5. **On failure** the host sends the selection-error message; the panel restores the button label and re-enables both controls, and shows the reason on the inline error line.

Three failure wordings exist:

| Cause | Message |
| ----- | ------- |
| The identifier is not one the registry recognizes | "Unknown local agent tool." |
| The tool is installed but the capability probe rejected it | "Found `<label>`, but it didn't respond as expected. Try another tool." |
| Any other underlying reason (configuration read or write failure, unexpected error) | The underlying reason's own message, or "Failed to select `<label>`." when it carries none. |

An explicitly configured executable path reaches the probe only when it belongs to the tool being selected; a path recorded for a different tool is ignored rather than borrowed.

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
- Disabled → Onboarding: `configured:changed` arrives with `configured: false` — which now requires **all three** arms to be false (no session, no API key, and the recorded provider is not the local agent). Preceded by a `localAgents:changed` push.
- Disabled → Active or Active Degraded: `enabled:changed` arrives with `enabled: true`.
- Active → Disabled: `enabled:changed` arrives with `enabled: false`.
- Active → Onboarding: reachable and ordinary — signing out, clearing the API key, or moving the recorded provider off the local agent drops the last true arm while the project stays enabled. Also preceded by a `localAgents:changed` push.
- Active ↔ Active Degraded: driven by `degradedReason` presence changes within the Tab UI; not driven by configured or enabled.

## Notable Behavior

- **The host-supplied enabled boolean already folds in the manual opt-out, so a disabled repository whose hook is still installed now reaches the Disabled panel.** The host does not send the raw install-state signal; it sends the conjunction of that signal and the absence of the durable opt-out (spec 101). This closed a defect: a repository the user had explicitly opted out of, but whose git hook was still on disk — a hook path shared across worktrees, or a hook reinstalled out of band by an upgrade — arrived here with the install-state signal true and rendered the **full operable tab UI**, offering every write affordance in a repository that must not be written to, and with no Enable button anywhere because the panel believed it was already enabled. The conjunction is applied both in the initial-state seed and at the runtime update chokepoint, so the first paint and every later push agree. (Surprising; the fixed defect is the reason the field is a conjunction.)
- **A configured user who disables the project sees the Disabled panel, not the Onboarding panel.** The configured boolean is evaluated independently of enabled, so a deliberate disable does not trap the user behind an onboarding flow they already completed. (Surprising; intentional.)
- **The machine-global config is loaded unconditionally, not only when the project is enabled.** Without this, disabling would clear the cached configured value and show the Onboarding panel in place of the Disabled panel, removing the only "Enable" affordance the user has. (Surprising; intentional.)
- **The one-shot tab-switch is keyed to webview lifetime, not session lifetime.** Closing and reopening the sidebar creates a new webview instance whose one-shot flag resets — but the user is already in the Active state at that point, so `configured` never flips false→true again in the new instance. In practice the auto-switch fires exactly once per project-activation event. (Notable.)
- **The loading placeholder is visible at first paint before any host message arrives.** This prevents a blank white flash while the host resolves its initial-state-readiness barrier. (Notable.)
- **The Disabled panel and the auto-enable behavior were introduced together.** They jointly replace the prior first-run flow where the user had to manually click Enable from within the onboarding surface. (Notable.)
- **The local-agent arm of the configured boolean keys on the recorded choice, not on the tool still being there.** Uninstalling the agent leaves the user configured. The alternative — re-deriving from live detection — would silently discard a deliberate choice and drop the user back into onboarding with no explanation; the missing tool is instead named by the diagnostic command and at summarization time. (Surprising; intentional.)
- **Two detection questions, deliberately split by cost, and the panel pays only the cheap one up front.** "Which tools are on disk?" is filesystem-only and runs for all tools during activation; "does this tool actually run?" launches a subprocess and runs once, for the single tool the user picked. Sweeping the runnability question across every tool at activation would stall the whole extension host, which is single-threaded and shared with every other extension. (Notable.)
- **The presence sweep ignores an explicitly configured executable path, so such a tool is invisible in onboarding.** The recorded path names exactly one tool's binary and cannot be applied to a multi-tool sweep without reporting every tool as present at that one file, so the sweep is run with no override at all. The consequence is real: a tool installed only at a hand-configured path gets no card here, while the same path *is* honoured by the probe once that tool is selected. (Surprising; consequence of a correctness choice elsewhere.)
- **The refreshed tool list is pushed before the configured flag flips, not after.** Because the host skips detection while the user is configured, the list riding the original initial state is stale (empty) for anyone who signs out mid-window. Pushing the list first means the re-raised panel is right on its first paint instead of one message late. (Notable.)
- **Exactly one card is badged, and the badge is moved rather than copied.** The recommendation is a single node relocated between the local-agent card and the API-key card as the detected-tool list becomes non-empty or empty. There is no state in which two cards claim to be recommended, and none in which the panel recommends nothing. (Notable.)
- **A successful local-agent selection produces no acknowledgement of its own.** It writes the provider fields, status re-derives the configured boolean, and the ordinary configured transition retires the panel — the same hand-off the inline API-key save uses. (Notable.)
- **DEFECT: the local-agent controls can be left permanently disabled, and nothing inside the panel ever restores them.** They are disabled on click and the **only** thing that re-enables them is the selection-error handler, which is itself gated on the onboarding cards being visible. Nothing re-initializes them when the cards are re-shown — in deliberate contrast to the API-key entry sub-view, which resets its own input, error line and button every single time it is opened. Two reachable dead ends:
  1. Activate "Use Local Agent Tool", then step into the API-key entry sub-view before the probe answers. The error arrives while the cards are hidden, is dropped, and pressing "Back" returns to a panel whose local-agent button is disabled and permanently reads "Checking…".
  2. After a **successful** selection the controls are left disabled behind the retiring panel. If configured later returns to false — which requires the recorded provider to be moved off the local agent with no session and no key on file, reachable through the Settings panel or an out-of-band configuration change — the re-raised panel offers a dead local-agent button, and the refreshed-tool-list push repopulates the dropdown's options without re-enabling it.

  In both cases the other two paths remain fully usable: "Configure API Key" and "Sign In / Sign Up" are never disabled, so the user is never stuck without a way forward. Only a fresh webview clears it — collapsing and re-revealing the sidebar, or reloading the window. (Defect.)

## Shared Behavior

- The sidebar webview message protocol (spec 101) owns the message envelope shapes; this spec adds `configured:changed`, `localAgents:changed`, `localAgent:selectError`, the `localAgents` initial-state field, and the local-agent adoption outbound to that protocol.
- **Local Agent CLI Provider Backend (spec 280)** owns both detection predicates this panel consumes — "is this tool present on disk" and "does this tool actually run" — including how each tool is discovered, what the capability probe accepts, and how an explicit executable path is scoped to its owning tool. This spec restates none of that; it owns only which predicate is paid for at which moment, and what the user sees as a result.
- The Settings webview (spec 110) offers the same provider and tool choice with its own availability reporting, and is one route by which the configured boolean can return to false after a local-agent selection.
- The auto-enable on activation (spec 144) is independent; auto-enable can succeed before the user becomes configured, in which case the Onboarding panel still shows.
- The Anthropic API key capture sub-view is owned by spec 143.
- The activation lifecycle (spec 100) owns the initial-state-readiness barrier that gates the loading→panel transition.
- The Tab UI's tab bar, toolbar, and degraded banner rendering are out of scope for this spec.
