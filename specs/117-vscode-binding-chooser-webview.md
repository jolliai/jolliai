# VS Code Binding Chooser Webview

## Topic Statement

The per-repo singleton webview that opens when a Jolli push is rejected because the repo has no Memory space binding yet, lets the user pick one of the existing spaces returned by the backend, registers the binding, and on success closes itself so the originating push can be retried automatically — with a graceful resolution path for the case where a teammate just bound the same repo to a different space.

## Scope

**In scope:**
- The trigger: the binding-required error surfaced from a Jolli push call (the server's 412 binding_required response).
- The chooser's title (`Choose a Memory space`), document title (`Save this repo's memory`), heading copy, subtitle, and explicit deferral to jolli.ai for any space-management UI beyond first bind.
- The space list contract: fetched from the backend on open, displayed as radio buttons with name and slug, no search filter.
- The pre-selection rule: only the server-designated default space is pre-selected; if the server names no default, every radio is left unchecked and the user must explicitly pick.
- The action bar: Cancel and "Bind and push" buttons; the latter is disabled until at least one space is loaded.
- The repo-URL display and the local-only-binding hint shown when the workspace has no git remote.
- The three discriminated outcomes the chooser resolves to: `selected` (registered + closed), `cancelled` (user dismissed), `anotherOpen` (a chooser for the same repo URL is already open in another panel — that one wins).
- The race-loser banner: when the binding registration returns 409 because a teammate just bound the repo to a different space, the form is replaced with a banner naming that space and an "OK, push now" button that adopts the winning binding.
- The empty-list copy: when the backend returns no spaces, the list area shows "No Memory spaces available. Create one on jolli.ai, then try Push again."
- The per-repo singleton model: at most one chooser per repo URL is open at a time; opening a second time in the same window reveals the existing chooser and tells the second caller to wait.
- The CSP nonce model: per-render nonce gating both inline `<style>` and `<script>` tags.

**Out of scope:**
- The push pipeline that throws the binding-required error and runs the retry. The chooser only resolves to an outcome; the caller decides whether to retry.
- The Jolli API endpoints (list spaces, create binding) at the wire level. This spec covers what the chooser does with the responses, not their HTTP shapes.
- Settings, Summary, Note Editor, or any other webview surface.
- Space creation, editing, deletion, or listing all bindings — the plugin deliberately does NOT expose these; they live on the jolli.ai web frontend.
- The `BindingRequiredError` type's exact structure (covered by the Jolli push service spec).

## Data Contracts

### Trigger

A push attempt to a Jolli backend returns a binding-required error. The push handler catches it, derives the repo URL and a suggested repo name (parsed from the remote URL), and opens the chooser with these inputs:

| Input | Source |
| --- | --- |
| Extension URI | The extension's installation URI (used as the only allowed local resource root). |
| Backend base URL | The configured Jolli base URL. |
| API key | The configured Jolli API key. |
| Repo URL | The canonical, normalized git remote URL of this repo (or a `file://` workspace path if there is no remote). |
| Suggested repo name | Derived from the repo URL; included in the binding-create call as a default. |

### Webview lifecycle

| Aspect | Value |
| --- | --- |
| View type | `jollimemory.bindingChooser` |
| Document title | `Save this repo's memory` (browser tab title) |
| Panel title | `Choose a Memory space` (VS Code editor tab title) |
| View column | Active editor column |
| Scripts enabled | Yes |
| Local resource roots | The extension URI only |
| Retain context when hidden | Yes |
| CSP | `default-src 'none'; style-src 'nonce-<…>'; script-src 'nonce-<…>'` |

### Singleton model

The chooser keeps a per-process `Map<repoUrl, ChooserInstance>`. When `openAndAwait` is called:

| Existing instance for `repoUrl`? | Behavior |
| --- | --- |
| No | Create a new chooser, register it under `repoUrl`, return its outcome promise. |
| Yes | Reveal the existing chooser in the active editor column. Resolve the new caller immediately with `{ kind: "anotherOpen" }`. The existing chooser keeps running. |

A different `repoUrl` always opens its own chooser independently — multi-root workspaces with several repos can have a chooser open per repo concurrently.

### Page structure

The chooser's body has three regions, top to bottom:

1. **Header** — title `Choose a Memory space`, subtitle `Bind this repo to an existing space. Create or manage spaces on jolli.ai.`
2. **Repo meta** — the repo URL display, with a hint message `No git remote configured — this binding is local to this workspace path.` shown only when the URL begins with `file://`.
3. **Spaces list** — a vertical radio-button list, scrollable inside its own bordered area; each row shows the space name (bold) and the space slug (faded, prefixed with `/`).

The action bar is fixed to the bottom of the panel with two buttons: `Cancel` (secondary) and `Bind and push` (primary).

A banner area sits between the repo meta and the spaces list; it is hidden in the normal state and revealed when the race-loser path fires (see below).

### List contents

| State | Display |
| --- | --- |
| Loading (between open and `init` arriving) | A single italic line `Loading…` in the list area. |
| Loaded with ≥ 1 space | One radio row per space; one row pre-selected if the server's `defaultSpaceId` matches a row's id. |
| Loaded with 0 spaces | A single italic line `No Memory spaces available. Create one on jolli.ai, then try Push again.` The primary button stays disabled. |
| Failed to load | Empty list shown with the same empty-state line above; a general-error banner under the list shows `Failed to load Memory spaces: <error message>` (or a fallback when the error has no message). |

### Pre-selection rule

The list pre-selects the server-designated `defaultSpaceId`, and only that id. Specifically:

- If the server returned a numeric `defaultSpaceId` AND a row with matching id is rendered, that row is pre-checked.
- Otherwise, no row is pre-checked.

The chooser does not auto-pick "the first space" or "the most recent space"; the list endpoint does not guarantee an order, so silently binding to whatever came first would be a footgun.

### Validation

When the user clicks `Bind and push`:

1. Inline check: at least one space must be selected. If not, the inline error under the list shows `Please pick a Memory space.` and the message is not sent.
2. If selection passes, the chooser disables every radio + both buttons, sends `confirm` with the chosen `jmSpaceId` to the host.

### Outcomes

The chooser resolves with exactly one of:

| `kind` | Meaning | Caller's typical response |
| --- | --- | --- |
| `selected` | The server registered a binding successfully. The result includes the binding's `id`, `jmSpaceId`, `jmSpaceName`, and `repoName`. | Retry the push that triggered the chooser. |
| `cancelled` | The user dismissed the panel (clicked Cancel, closed the editor tab, or any other close path). | Show "Push cancelled — no Memory space chosen for this repo. Click the Jolli push button again when you're ready." |
| `anotherOpen` | A chooser for this `repoUrl` was already open. | Show "A Memory space chooser is already open for this repo. Finish there, then click the Jolli push button again." Do NOT retry the push. |

The discrimination between `cancelled` and `anotherOpen` matters: a second concurrent push from the same repo would otherwise see "Push cancelled" without the user ever cancelling anything.

### Race-loser path (409 binding_already_exists)

If `confirm`'s registration call returns 409 with a binding-already-exists body, the binding has been claimed (by the user, by a teammate, by a different editor window — the server is the single source of truth). The chooser:

1. Hides the spaces list.
2. Hides the primary `Bind and push` button.
3. Shows the banner with `Another teammate just bound this repo to <strong><winner.jmSpaceName></strong>. Using that one.`
4. Shows the banner's `OK, push now` button.

When the user clicks `OK, push now`, the chooser sends an `acceptWinner` message to the host with the winner body. The host validates the body's required fields and, on success, resolves the chooser with `{ kind: "selected", result: <winner> }` and disposes the panel. If the body is missing fields the host sends an inline error: `Server returned an incomplete binding for the conflict. Please retry the push.`

### Webview ↔ host messages

| Command | Direction | Purpose |
| --- | --- | --- |
| `ready` | Webview → host | Sent on script load. Tells the host to fetch the spaces list and reply with `init`. |
| `init` | Host → webview | Carries `repoUrl`, `suggestedRepoName`, `spaces[]`, `defaultSpaceId`. |
| `cancel` | Webview → host | User clicked Cancel. Host resolves `cancelled` and disposes. |
| `confirm` | Webview → host | User clicked `Bind and push`. Carries the chosen `jmSpaceId`. |
| `acceptWinner` | Webview → host | User clicked `OK, push now` after the race-loser banner. Carries the winner body. |
| `error` | Host → webview | Carries a `message` to display in the general-error area; re-enables radios and buttons. |
| `winnerOnRace` | Host → webview | Carries the winner body; triggers the race-loser banner. |
| `done` | Host → webview | Reserved for completeness; the host disposes the panel directly, so the webview takes no action. |

## Behavior

### Open

1. Caller invokes `openAndAwait` with the params.
2. If a chooser for the same `repoUrl` is already in the registry, the existing chooser is revealed and the caller resolves immediately with `{ kind: "anotherOpen" }`.
3. Otherwise the chooser is constructed: a webview panel is created in the active editor column, the per-render nonce is generated, the HTML (with embedded CSS and script, both nonce-gated) is set, and the dispose + message handlers are wired.
4. The webview script runs and posts `ready`.
5. The host calls the backend's list-spaces endpoint and posts `init` with the spaces, the default-space id, the repo URL, and the suggested repo name. On a list-spaces failure the host still posts `init` (with an empty spaces array and null default) so the empty-state copy can render, then posts `error` with a `Failed to load Memory spaces: <message>` line.

### User picks and confirms

1. The user clicks a radio. The general-error and inline-error areas clear.
2. The user clicks `Bind and push`. The script validates the selection.
3. If valid, the script disables every input + both buttons and posts `confirm` with the chosen `jmSpaceId`.
4. The host calls the backend's create-binding endpoint with the repo URL, the suggested repo name, and the chosen `jmSpaceId`.
5. On success, the host resolves the chooser with `{ kind: "selected", result: { id, jmSpaceId, jmSpaceName, repoName } }` and disposes the panel.
6. On a 409 binding-already-exists, the host posts `winnerOnRace` with the winner body. The script transitions to the race-loser layout (banner + "OK, push now" button).
7. On any other backend error, the host posts `error` with the message; the script re-enables inputs and shows the message in the general-error area.

### Race-loser adoption

1. The user clicks `OK, push now` in the banner.
2. The script posts `acceptWinner` with the winner body.
3. The host validates the body has the required `id`, `jmSpaceId`, `jmSpaceName`, and `repoName`. On success, the chooser resolves `selected` with the winner data and disposes. On failure, the host posts `error` with the incomplete-binding message.

### Cancel and external dispose

1. The user clicks Cancel, or closes the editor tab, or otherwise disposes the panel.
2. The dispose handler clears the registry entry for `repoUrl` and resolves the chooser with `{ kind: "cancelled" }`.
3. The cancellation is idempotent: a `selected` resolution that has already fired cannot be overwritten by a subsequent dispose.

### Caller retry on `selected`

1. The originating push code, on `{ kind: "selected" }`, retries the push exactly once with a `retried` flag set, so a second binding-required would not loop into another chooser.
2. On the retry, the originating push uses whatever credentials and headers it had originally; nothing about the chooser persists into the push call beyond the side effect of having registered a binding on the server.

## State Transitions

For one chooser instance:

| From | Trigger | To |
| --- | --- | --- |
| Not constructed | `openAndAwait` (no existing instance for `repoUrl`) | Loading |
| Not constructed | `openAndAwait` (existing instance for `repoUrl`) | Resolved `anotherOpen`; existing instance unchanged |
| Loading | `init` arrives, ≥ 1 space | Idle (default-space pre-checked if any) |
| Loading | `init` arrives, 0 spaces | Empty (primary button disabled, empty-state line) |
| Loading | `init` arrives + `error` posted | Empty + general-error visible |
| Idle | User selects a different radio | Idle (errors cleared) |
| Idle | User clicks `Bind and push` (selection valid) | Submitting |
| Idle | User clicks `Bind and push` (no selection) | Idle + inline error |
| Submitting | Backend success | Resolved `selected`; panel disposed |
| Submitting | 409 binding-already-exists | Race-loser |
| Submitting | Any other error | Idle + general-error |
| Race-loser | User clicks `OK, push now` (body valid) | Resolved `selected`; panel disposed |
| Race-loser | User clicks `OK, push now` (body incomplete) | Race-loser + general-error |
| Any state | User clicks Cancel / closes panel | Resolved `cancelled`; panel disposed |

## Notable Behavior

- **No search filter.** Despite the brief mentioning a search filter, the chooser renders a flat radio list with no search input. Users with many spaces scroll. The list area is bounded in height with overflow scroll. (Surprising; reality.)
- **Per-repo singleton, NOT per-window.** The registry is keyed by `repoUrl`; opening a chooser for a *different* repo from the same window opens a second chooser concurrently. The "already open" guard is about the binding decision being a server-wide truth for one repo, not a UX limit. (Surprising; intentional.)
- **`anotherOpen` is a distinct outcome from `cancelled`.** This was added because two summary panels for the same repo can both hit the binding-required error simultaneously; without the distinction, the second push gets a misleading "Push cancelled" message. (Notable.)
- **Pre-selection happens only for the server's default.** The chooser does not auto-pick the first space, the most-recent space, or the user's most-recently-used space. If the server names a default, that one is pre-checked; otherwise the user must explicitly pick. The reasoning: the list endpoint does not guarantee order, so silently binding to "whichever came first" would silently couple the repo's identity to whatever the server happened to return. (Surprising; intentional.)
- **The chooser does not create spaces.** Empty state explicitly tells the user to create a space on jolli.ai. There is no "+ New Space" button, no inline form, no rename / delete affordance. Everything beyond first bind happens on the web frontend. (Surprising; intentional.)
- **The race-loser banner adopts a binding the user did not pick.** When 409 fires, the chooser does not return the user to the radio list to re-pick. The winning binding is the only valid choice (the server enforces uniqueness), so the chooser presents it as a fait accompli with one button: `OK, push now`. (Surprising; intentional.)
- **`file://` repo URLs get a hint, not an error.** A workspace without a git remote can still bind, but the binding is local to the workspace path. The chooser shows `No git remote configured — this binding is local to this workspace path.` so the user understands the binding will not transfer to teammates. (Notable.)
- **Spaces-list failure does not block the chooser.** The host still sends `init` with an empty list so the empty-state copy can render, then sends `error` with the failure message. The user sees both: a clear "no spaces" empty state AND the specific reason loading failed. (Notable.)
- **Cancel handlers must run before dispose.** The dispose handler resolves the outcome promise; the in-script `cancel` handler sends a `cancel` message and the host disposes the panel. The `resolved` flag prevents double-resolution if the user clicks Cancel and then closes the tab in quick succession. (Notable.)
- **The CSP nonce gates both inline styles AND inline scripts.** Both `<style nonce="…">` and `<script nonce="…">` are required; nothing else may execute in the panel. The nonce is regenerated on every panel construction (which, given the singleton, is at most once per repo per session). (Notable.)
- **The `done` host→webview message is reserved.** The chooser script handles it as a no-op. The host disposes the panel directly on success rather than asking the webview to clean up first; this guarantees the panel goes away even if the script is unreachable. (Notable.)
- **The chooser does not refresh its space list.** Once `init` arrives, the list is static for the chooser's lifetime. A user who creates a new space on jolli.ai while the chooser is open must close and re-trigger the chooser to see it. (Notable.)
- **Suggested repo name flows into the binding-create call.** The chooser does not show or let the user edit a "name this binding" field. The push handler derives a name from the repo URL and posts it as part of `confirm`; the server uses it as the binding's display name. (Notable.)

## Shared Behavior

- **Webview composition.** Same builder pattern as the Settings, Summary, and Note Editor panels: an HTML builder embeds a CSS builder's output and a script builder's output, with a per-render CSP nonce gating both inline `<style>` and `<script>` tags.
- **VS Code theme variables.** The chooser's CSS reads from `--vscode-*` variables (font, colors, button backgrounds, panel borders) so it visually matches the editor's chrome regardless of the user's theme.
- **Per-render nonce.** The same nonce-generation primitive used by every Jolli webview panel.
- **Push pipeline.** The chooser only resolves outcomes; the originating push is responsible for triggering, retrying, and reporting. The relationship is one-shot — a `selected` resolution leads to exactly one retry; a second `binding-required` on retry surfaces as a normal error.
- **Jolli API authentication.** The list-spaces and create-binding calls use the same Jolli API key the rest of the product authenticates with — the chooser inherits the credentials from the configuration that the push call also uses.
