# IntelliJ Binding Chooser Dialog

## Topic Statement

The modal dialog opened in the IDE when a push to the Jolli backend is rejected with a "binding required" verdict — listing the existing Memory spaces returned by the server, registering the picked space against this repository, then closing on success so the originating push can be retried by its caller.

## Scope

**In scope:**

- The trigger: the push pipeline catching the typed "binding required" rejection raised by the push leaf-RPC and dispatching to a binding-required handler that prepares the chooser's inputs.
- The pre-open guard: the at-most-one-chooser-per-repo registry and the short-circuit message shown when a chooser for the same repository URL is already on screen.
- The dialog's structural regions: title bar, fixed-size content panel with header / banner area / spaces list / inline-error area, and footer with a primary "Bind and Push" button plus a "Cancel" button.
- The pre-population rule: only the server-designated default space is pre-selected; if the server names no default, every row is left unselected and the primary button stays disabled until the user clicks one.
- The empty-list copy and behavior when the backend returns zero spaces.
- The synchronous-looking but actually asynchronous "Bind and Push" path: the dialog stays open while the binding-create call runs on a background thread, with the primary button text changing to a busy state and both the list and the button disabled for the duration.
- The race-loser path when the binding-create call returns the "already exists" verdict: the spaces list is hidden, a banner announces that someone else bound the repo first (without naming the space), the primary button is relabelled to a single-confirm action that adopts the winning binding on click.
- The error path: any non-race, non-success error response surfaces a red inline message under the list and re-enables the controls for the user to retry or cancel.
- The dialog's outcome contract: a discriminated value the caller reads after the dialog closes, telling it whether the user committed to a space (with the new binding's details), whether the user cancelled, or whether a chooser was already open.
- The post-close handoff: when the outcome is "space committed," the caller re-runs the originating push exactly once with a retry flag; when the outcome is "cancelled" or "already open," the caller surfaces an explanatory message and does not retry.
- The list-spaces step that the dispatcher runs before opening the dialog, including the case where listing fails outright (no dialog is shown, an error message is surfaced, the push is marked failed).
- The suggested repository name derived from the repository URL and forwarded into the binding-create request as the binding's display name.

**Out of scope (boundaries):**

- The push RPC itself — its endpoint, payload, headers, response shape, and the conditions under which it produces the "binding required" verdict (covered by the binding-required-flow spec).
- The list-spaces and create-binding HTTP transports at the wire level — request bodies, response bodies, tenant header derivation, plugin-outdated mapping (covered by the binding-required-flow spec and shared transport specs).
- The construction of the Jolli API key, the base URL, and the bearer credential.
- The web frontend's space-management UI (creating, renaming, moving, deleting spaces); the chooser deliberately exposes none of these.
- The sibling chooser implementation in the other IDE surface, which uses a webview instead of a modal dialog (covered by its own spec).
- The post-binding push retry's own behavior (covered by the originating push spec); this spec ends at the moment the caller invokes the retry.

## Data Contracts

### Trigger

The push pipeline running on a background thread catches a typed "binding required" rejection that carries:

| Field | Meaning |
| --- | --- |
| Repository URL | The canonical URL the server is asking the client to bind. |

The handler:

1. Calls the list-spaces endpoint on the **same** background thread.
2. Derives a suggested repository name from the repository URL; if the derivation yields an empty string, uses a single-word fallback.
3. Switches to the UI thread to evaluate the singleton guard and, if free, open the dialog.

If the list-spaces call fails, the handler does not open the dialog. It posts a "push failed" message back to the panel that initiated the push and surfaces a modal error reading `Failed to load Memory spaces: <message>`.

### Inputs to the dialog

| Input | Source |
| --- | --- |
| Owning project handle | The IDE project from which the push was triggered. |
| Repository URL | The canonical URL surfaced by the trigger. |
| Suggested repository name | Derived from the URL (or fallback). |
| Spaces list | The list-spaces response, possibly empty. |
| Default space id | The server-designated default if any; otherwise null. |
| Backend base URL | The currently-configured Jolli base URL. |
| API key | The currently-configured Jolli API key. |

### Space summary shape

Each row in the list carries:

| Field | Meaning |
| --- | --- |
| Numeric id | Identifier used in the binding-create call. |
| Name | Display label. |
| Slug | URL-style suffix shown next to the name in muted styling. |

### Outcome shape (read after the dialog closes)

The caller reads exactly one discriminated value:

| Variant | Payload | Meaning |
| --- | --- | --- |
| Space committed | `{ binding id, space id, space name, repository name }` | The server accepted a binding, either freshly created or adopted via the race-loser banner. The space-name slot exists in the shape but is **always empty** on this surface — the create-binding response carries no space name on either the accepted or the "already exists" status — so nothing user-facing may depend on it. On the race-loser path the binding id is also `0` for the same reason (only the existing space id is recoverable). |
| Cancelled | (none) | The user dismissed the dialog without committing. The outcome is also "cancelled" if a list-spaces error path was taken **before** the dialog was constructed — though in that path the caller never reads the dialog outcome, since no dialog exists. |
| Already open | (none) | A chooser variant declared at the dialog's outcome type but **never actually produced by the dialog itself**. The caller's pre-open check raises this case before constructing a dialog, so the caller's branch that handles it is reachable only via that pre-check; reading the outcome from a closed dialog will never return this variant. |

The dialog initializes its outcome to "cancelled" and only transitions out of it via either a successful binding-create response or a user-confirmed race-loser adoption.

### Singleton registry

The dialog type maintains a process-wide map keyed by repository URL pointing to the currently-open dialog instance (if any). Two query primitives operate on it:

| Primitive | Behavior |
| --- | --- |
| Pre-open check | Returns true if and only if a dialog is registered for the URL **and** that dialog is currently being displayed. |
| Open | Constructs a new dialog, registers it under the URL (overwriting any stale entry), and returns it for the caller to display. The dialog itself is not yet shown. |

The dialog's dispose hook unregisters the URL from the map.

### Dialog layout regions, top to bottom

1. **Title bar** — `Choose a Memory Space`.
2. **Header** — bold heading `Choose a Memory space`, muted subtitle `Bind this repo to an existing space. Create or manage spaces on jolli.ai.`, and a line displaying the bolded label `Repo:` followed by the repository URL.
3. **Race-loser banner** — initially hidden; bordered area used during the race-loser path only.
4. **Spaces list** — a single-selection scrollable list. Each row shows the space name in bold followed by `/<slug>` in muted styling. When the list is empty, the list area is hidden and a muted message reads `No Memory spaces available. Create one on jolli.ai, then try Push again.`
5. **Inline-error label** — initially hidden; revealed in a red-orange tint when the binding-create call returns an unrecoverable error.

The content area has a fixed preferred size large enough for several rows with vertical room for the banner and the error label.

### Footer buttons

The IDE's modal dialog frame provides:

| Button | Initial label | Initial state |
| --- | --- | --- |
| Primary (OK) | `Bind and Push` | Disabled until a space is selected. |
| Secondary (Cancel) | `Cancel` | Always enabled. |

The primary button's label and enabled state are mutated at runtime by the busy and race-loser transitions described below.

## Behavior

### Pre-open dispatch (handler-side, not dialog-side)

1. The push handler catches the typed "binding required" rejection.
2. Still on the background thread, the handler calls list-spaces. On failure, it surfaces a modal error and marks the push failed. No dialog is opened.
3. On success, the handler derives the suggested repository name from the URL (falling back to a single word if the derivation is empty).
4. Switch to the UI thread.
5. Consult the singleton registry. If a dialog for this repository URL is already showing, surface a modal info message reading `A binding chooser is already open for this repo. Finish there, then push again.`, mark the push failed, and stop. **Do not** open a second dialog.
6. Otherwise, construct a new dialog with the inputs above, register it under the URL, and display it modally.
7. After the dialog closes (the display call returns), read the outcome and dispatch.

### Dialog construction

1. Set the title `Choose a Memory Space`.
2. Set the primary button text to `Bind and Push`.
3. Set the cancel button text to `Cancel`.
4. Disable the primary button.
5. Populate the spaces list from the input list. If the list is empty, hide the list area and reveal the "no spaces" copy.
6. If a default space id was provided, iterate the populated list and, on the first matching row, select it and enable the primary button. If no default was provided, **no row is selected**.

### User interactions in the steady state

- Selecting any row enables the primary button. Deselecting all rows (e.g. via keyboard navigation) disables it again.
- Clicking the cancel button (or closing the dialog via the window controls) sets the outcome to "cancelled" and dismisses the dialog. The dispose hook removes the URL from the singleton registry.

### Primary action

The primary button has two semantic modes, distinguished by the dialog's outcome:

- **Submit mode** (outcome still "cancelled"): the click triggers the binding-create flow described below.
- **Confirm-winner mode** (outcome already a committed binding, set by the race-loser path): the click closes the dialog with the existing outcome.

#### Submit mode

1. Verify a row is selected. If not, do nothing.
2. Enter busy state: disable the primary button, disable the spaces list, relabel the primary button to `Binding…`, and hide the inline-error label.
3. Spawn a background task to call the create-binding endpoint with the repository URL, the suggested repository name, and the selected row's numeric id. The dialog stays open while this runs.
4. When the task completes:
   - **Success.** Schedule a UI-thread action that sets the outcome to "space committed" with the returned binding details and closes the dialog with an OK exit code.
   - **Race-loser verdict.** Schedule a UI-thread action that transitions the dialog to the race-loser layout (described below) and exits the busy state.
   - **Any other error.** Schedule a UI-thread action that reveals the inline-error label with the failure message (or the literal `Failed to register binding.` if no message is present) and exits the busy state. The dialog stays open so the user can pick another row, retry, or cancel.

#### Race-loser layout

When the race-loser verdict fires:

1. Set the dialog outcome immediately to "space committed" with the winner's details.
2. Hide the spaces list region.
3. Hide the inline-error label.
4. Reveal the race-loser banner with the text `Another teammate just bound this repo. Using that one.` framed in a bordered area. The banner deliberately **does not** name the winning space: the create-binding response — on both the accepted and the "already exists" status — carries only the raw binding row and has no space-name field, so there is no name to interpolate. (It previously interpolated one, which rendered as an empty bolded gap.) The subsequent push still settles on the winning binding, keyed by the winner's **space id**.
5. Relabel the primary button to `OK, Push Now`.
6. Enable the primary button (no row selection is required).

The user's only way out of this state, other than cancel, is the primary button. Clicking it enters confirm-winner mode (described above) and closes the dialog with the already-set committed-outcome.

### Cancel during busy state

The cancel button remains active during the busy state. Pressing it closes the dialog before the background call completes; the outcome stays "cancelled". The background call's eventual UI-thread continuation finds the dialog already disposed; the continuation's only effect is to attempt to mutate widgets that no longer matter. The committed outcome is never written because the busy-state continuation that would write it runs only on the success and race-loser branches, both of which schedule **before** the dispose handler runs in normal usage; a true late-arriving success after a cancel would still try to write the outcome and close, but the close call on a disposed dialog is a no-op.

### Post-close caller dispatch

After the modal closes, the caller reads the outcome:

| Outcome | Caller action |
| --- | --- |
| Space committed | Re-invoke the originating push exactly once with a retry flag set so a recurring binding-required would not loop into another chooser. |
| Cancelled | Post a "push failed" message back to the originating panel and surface a modal info reading `Push cancelled — no Memory space was selected.` |
| Already open | (unreachable in practice — see Notable Behavior) Post a "push failed" message and surface a modal info reading `A binding chooser is already open for this repo. Finish there, then push again.` |

## State Transitions

For a single dialog instance:

| From | Trigger | To |
| --- | --- | --- |
| Not constructed | Pre-open check finds an instance already showing for this URL | (handler short-circuit; no dialog instance enters any state) |
| Not constructed | List-spaces succeeds and no other instance is showing | Idle |
| Idle | Default-space-id matched a row at construction | Idle with that row selected and primary enabled |
| Idle | User clicks a row | Idle with that row selected and primary enabled |
| Idle | User clears selection | Idle with no selection and primary disabled |
| Idle (selection present) | User clicks the primary button | Busy |
| Busy | Background binding-create returns success | Settled-space-committed → dialog closes |
| Busy | Background binding-create returns race-loser verdict | Race-loser layout (outcome already set to space-committed) |
| Busy | Background binding-create returns any other error | Idle with inline-error visible |
| Race-loser layout | User clicks the primary button | Settled-space-committed → dialog closes |
| Any state with the dialog visible | User clicks cancel or closes the window | Settled-cancelled → dialog closes |

The outcome variable is single-shot in effect: it starts at "cancelled" and is overwritten only by the success and race-loser branches; cancel paths do not re-overwrite it (it is already "cancelled").

## Notable Behavior

- **Pre-open guard lives in the caller, not the dialog.** The "already open" outcome variant is part of the dialog's outcome type, but the dialog itself never produces it; the caller checks the singleton registry before constructing a dialog and short-circuits with the "already open" message at that point. As a result, the caller's `when`-branch on the "already open" outcome variant is reachable only via the pre-open path, never via a closed dialog's outcome. (Surprising; intentional.)
- **The dialog is a strict picker, not a manager.** It cannot create, rename, move, or delete spaces. The empty-state and the subtitle both explicitly redirect the user to the web frontend for any such action. (Notable.)
- **Pre-selection requires an explicit server-designated default.** No "first row" fallback. If the server did not name a default, every row stays unselected and the user must explicitly click a row before the primary button enables. The reasoning, captured at the call site: silently binding to "whichever row came back first" would silently couple the repository's identity to an unstable order. (Surprising; intentional.)
- **The primary button has three labels across the dialog's lifecycle.** Idle: `Bind and Push`. Busy: `Binding…`. Race-loser: `OK, Push Now`. The button's semantics also change accordingly — in race-loser mode the click closes immediately without re-issuing the binding-create call. (Notable.)
- **The "Bind and Push" name is a UX promise, not a behavior.** The dialog itself does not push. It only registers the binding and closes; the caller then re-invokes the push exactly once. The label communicates the user's *intent* (after this, the push will go through), not what the dialog *does*. (Notable.)
- **The dialog stays open during the binding-create call.** The IDE's standard modal-dialog OK behavior is intercepted so the modal does not auto-close on click; instead a background task runs and the dialog only closes when the task resolves to success or the race-loser confirm-winner path fires. The list and primary button are disabled for the duration; the cancel button stays active. (Notable.)
- **The race-loser banner adopts a space the user did not pick.** The dialog does not return the user to the row list to re-pick. The server has decided uniqueness; the winning binding is presented as a fait accompli with a single `OK, Push Now` confirmation. (Surprising; intentional.)
- **The race-loser path sets the committed outcome *before* the user confirms.** When the banner is revealed, the dialog's outcome is already "space committed" with the winner's details. The user clicking the primary button just closes the dialog with that pre-set outcome; cancelling instead would close it with the still-the-default "cancelled" outcome — meaning a 409 race verdict that the user cancels through is treated as "user did not bind". (Subtle.)
- **List-spaces failure aborts before the dialog opens.** A failure to fetch the spaces list is surfaced as a modal error message; no dialog is ever shown. This differs from the sibling implementation in the other surface, which opens the chooser anyway with empty contents and an inline error banner. (Divergence; intentional.)
- **Background-thread completions schedule UI work with the "any modality" hint.** The post-binding UI actions are guaranteed to run even though the dialog is itself modal — the scheduling hint instructs the IDE's UI thread that these continuations may run regardless of the current modality stack. (Notable.)
- **Repository URL is HTML-escaped before display in the header.** The dialog uses HTML labels to bold portions of the header and the banner; the user-controlled strings it still interpolates (repository URL, error message) are passed through an HTML-escape that handles ampersand, less-than, greater-than, and double-quote so that a hostile remote URL or server message cannot inject markup. The race-loser banner interpolates nothing at all now, so it has no escaping concern. (Notable; defensive.)
- **The race-loser banner names no space, by data contract.** The server's create-binding response has no space-name field on either status, so the banner is authored to work without one and the adopted binding is identified only by its space id. Any future copy that wants to name the space needs a server-side contract change first, not a client-side lookup. (Notable; grounded in the response shape.)
- **The suggested repository name is derived once at handler time and not re-confirmed in the dialog.** The dialog has no "name this binding" affordance. Whatever name the URL-derivation produced is sent to the server as part of the binding-create call, and shows up later as the binding's display name on the server side. (Notable.)
- **The dialog displays the repository URL verbatim from the trigger.** When the URL is a `file://` path (repository without a configured remote), the dialog still opens and the URL is shown as-is; there is no special hint or warning copy distinguishing remote-backed and local-only bindings. (Divergence from the sibling surface, which does call this out explicitly.)
- **The "already open" pre-check is not equivalent to "registry contains an entry."** The check requires that the registered dialog also be currently showing; a stale entry left by a disposed dialog (in the gap between disposal and the registry-removal hook) does not block a fresh open. The registry's `open` primitive also overwrites any prior entry unconditionally, so the worst stale-state outcome is an orphan reference that is replaced on next open. (Notable.)
- **The cancel handler does not interrupt an in-flight binding-create call.** Cancelling during the busy state simply closes the dialog; the background thread's HTTP call continues to completion and its UI-thread continuation, when it runs, operates on a disposed dialog. The committed outcome can therefore in principle be written to a disposed instance, but reading the outcome from a disposed instance has no effect because the caller has already moved on with the original (cancelled) outcome it read after the close call returned. The server-side binding is still created in this case. (Subtle; race window.)
- **List-spaces accepts two response shapes.** A flat array (legacy) and an envelope with `defaultSpaceId`. The flat array path yields a null default, which combined with the pre-selection rule means "no row pre-selected" for legacy backends. (Notable.)

## Shared Behavior

- The push leaf-RPC's `412`-mapping, the list-spaces and create-binding endpoints, the `409` race-loser body, and the cross-IDE chooser outcome semantics are defined by the binding-required-flow spec.
- The product-wide tenant-and-org header derivation used by both list-spaces and create-binding is defined by the tenant resolution spec.
- The product API key shape that supplies the bearer credential is defined by the API-key parsing spec.
- The `426 plugin outdated` mapping that both list-spaces and create-binding raise on stale clients is defined by the plugin-outdated-flow spec.
- The sibling chooser in the other IDE surface (a webview rather than a modal) implements the same outcome contract with divergent UX details (race-loser layout, list-failure handling, `file://` hint, in-flight cancel semantics).
