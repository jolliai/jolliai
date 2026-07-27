# IntelliJ Settings Surface

## Topic Statement

Two surfaces that together let an IntelliJ user edit their Jolli Memory configuration: an IDE-native settings page anchored at `Preferences > Tools > Jolli Memory` (a slim five-field form) and a separate modal dialog titled `Jolli Memory Settings` opened from the tool window's gear icon (a five-**tab** dialog covering agent selection, AI summarization, cloud sync, the Memory Bank folder, and everything else). Both persist to the same global config directory but expose different field sets and follow different apply-vs-OK conventions. Each surface builds its own sign-in affordance and its own provider-selection UI inline, rather than sharing a single reusable component.

## Scope

**In scope:**
- The IDE-native settings page at `Preferences > Tools > Jolli Memory` and its five rows: a privacy notice link, a sign-in account row, an Anthropic API key field, a model field, and a Jolli API key field.
- The modal dialog opened from the tool window gear icon: its title `Jolli Memory Settings`, its OK button text `Apply Changes`, its fixed preferred size, its last-selected-tab memory, and its five tabs — **AI Agents**, **AI Summary**, **Sync to Jolli**, **Memory Bank**, **Others** — and everything each tab edits.
- The Memory Bank tab's **Historical memory** entry point ("Generate Missing Summaries"): what it runs, how it relates to the tool-window cold-start card's dismiss marker, and how it differs from the tab's separate "Migrate to Memory Bank" action.
- The AI Summary tab's provider-dependent card switching (Anthropic / Jolli-signed-in / Jolli-signed-in-no-key / Jolli-signed-out) and its "Advanced" disclosure for the Jolli API key field.
- The Sync tab's own provider-independent card switching (signed-out / signed-in-no-key / signed-in) and its auto-sync / transcript / poll-interval fields.
- The shared save target: a single global config directory; both surfaces read from and write to the same file.
- The validation rules surfaced via the dialog's continuous validation (provider-specific requirements; max-tokens must be a positive integer when set; at least one of the six platform checkboxes must stay enabled).
- The apply-vs-OK semantics: the IDE-native page exposes Apply (no dialog dismissal) plus OK (apply + close); the gear-icon dialog only has OK (relabeled `Apply Changes`) and Cancel, and defers its heaviest work (hook install/uninstall, Memory Bank init + migration) to a background task that runs **after** the dialog has already closed.
- The privacy notice on the IDE-native page (an HTML label with a link to the privacy policy, marked copyable).

**Out of scope:**
- The OAuth flow itself (browser launch, callback server, token exchange) — separate spec.
- The Jolli API key parser / origin allowlist enforcement — separate spec.
- The Anthropic API request that consumes the key — separate spec.
- The status bar / sidebar tool window contents — these surfaces only host the gear-icon entry point.
- The cloud sync / push-to-space flow that uses the Jolli API key.
- Per-project (vs. per-user) configuration — this spec covers the global config only; the IntelliJ surface does not edit project-local config files.
- The shared back-fill runner's internals (progress reporting, completion notifications, the cold-start card it also drives) — owned by **IntelliJ Cold-start Back-fill Card** (cross-ref 260); this spec covers only the Memory Bank tab's entry point into it.
- The Memory Bank folder's own initialization/migration engine internals — separate spec.
- The plan / note / hook flows.

## Data Contracts

### Two surfaces

| Surface                      | Anchor                                                | Footprint                                                              |
| ----------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| IDE settings page            | `Preferences > Tools > Jolli Memory`                  | Form embedded in the IDE settings tree; five rows, no tabs.            |
| Gear-icon dialog             | Modal opened from the JolliMemory tool window's gear  | Standalone dialog, five tabs, OK button labeled `Apply Changes`.        |

Both surfaces persist to the same global config directory and read from the same file.

### Save target

Both surfaces write to a single canonical global config file under the user's home state directory — the **same** file the command-line surface and the VS Code extension use. Every read and every write is delegated to the shared configuration loader/saver rather than performed in process; only the state-directory path itself is resolved locally. Writes go through a load-merge-save cycle:

1. Read the existing config from the global config directory.
2. Copy it with the user's edits applied to the affected fields.
3. Write the merged result back to the same directory.

Fields the user did not edit are preserved unchanged. Tokens persisted by the OAuth flow (sign-in credentials) are written by the OAuth callback handler, not by these surfaces — both surfaces leave those fields alone.

**A dialog Apply is four such writes, not one.** Five fields — the Anthropic key, the provider, the agent tool, the agent path, and the DCO sign-off flag — are deliberately excluded from the main merged write (written as explicit nulls) and then restored by follow-up partial writes: one for the provider-routing group, one for the sign-off flag, and one more for the telemetry choice. The sequence is not atomic and can be observed mid-way by another surface. Its full mechanics and consequences (including that the agent **path** is nulled and never actually restored) are owned by the configuration-file spec.

### IDE-native page fields

The settings page composes a vertical form with these rows, top to bottom:

| Position | Element                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 1        | Privacy notice HTML label with a link to the privacy policy. Marked copyable.                          |
| 2        | Account row: a sign-in status label and a Sign In / Sign Out button. Tooltip: `Sign in with your Jolli account for Personal Space sync`. |
| 3        | `Anthropic API Key:` masked password field. Tooltip: `Required for AI commit summaries. Get yours at console.anthropic.com`. |
| 4        | `Model:` plain text field. Tooltip: `Alias (haiku, sonnet, opus) or full model ID. Default: sonnet`.    |
| 5        | `Jolli API Key:` masked password field, **whose label changes to** `Jolli API Key (optional — auto-managed via account):` when the user is signed in. Tooltip on the field also adjusts. |

A vertical stretch panel pads the bottom so the form anchors to the top of the settings page.

### Account row (IDE page)

| Sign-in state | Status label   | Button text  | Button action                                                     |
| ------------- | -------------- | ------------ | ----------------------------------------------------------------- |
| Signed in     | `Signed in`    | `Sign Out`   | Calls the auth service `signOut()`; refreshes the row in place.    |
| Signed out    | `Not signed in`| `Sign In`    | Disables the button, sets text to `Signing in...`, runs the OAuth login flow; on success reloads the form from disk and refreshes the row; on failure shows an error dialog titled `Jolli Sign In`. |

### Gear-icon dialog: five tabs

The dialog's center panel is a tabbed pane. Selecting a tab is remembered (a process-lifetime, not disk-persisted, "last selected tab" index) so reopening the dialog later in the same IDE session returns to the tab the user was last on. The dialog's preferred size is fixed; the OK button reads `Apply Changes`.

| # | Tab              | Contents                                                                                                          |
| - | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1 | **AI Agents**     | A gray explainer line, then six enable/disable checkboxes (see Platform checkboxes below), all default checked.  |
| 2 | **AI Summary**    | A `Provider:` dropdown (`Anthropic` / `Jolli`) driving a four-card panel (see AI Summary provider cards below), plus a collapsible "Advanced" Jolli-API-key field below the card. |
| 3 | **Sync to Jolli** | A three-card sign-in panel (see Sync tab cards below), a separator, then `Auto-sync to Personal Space` (default on), `Sync transcripts` (default off), and a poll-interval field. |
| 4 | **Memory Bank**   | A folder-path picker, a sort-order dropdown, a `Migrate to Memory Bank` button, and (below a spacer) the **Historical memory** section: a heading, an explainer, and a `Generate Missing Summaries` button. |
| 5 | **Others**        | An `Exclude Patterns` heading + comma-separated globs field, a `Pause Jolli Memory` checkbox, and a `Privacy` heading with a telemetry opt-in checkbox and a hyperlink to telemetry details. |

### Platform checkboxes (AI Agents tab)

Six checkboxes, all default checked, each labeled with its detection mechanism:

| Checkbox | Label |
| --- | --- |
| Claude Code | `Claude Code — Session tracking via Stop hook` |
| Codex CLI | `Codex CLI — Session discovery via filesystem scan` |
| Gemini CLI | `Gemini CLI — Session tracking via AfterAgent hook` |
| OpenCode | `OpenCode — Session discovery via SQLite database scan` |
| Cursor IDE | `Cursor IDE — Composer session discovery via SQLite database scan` |
| GitHub Copilot | `GitHub Copilot — CLI session-store scan + VS Code Chat workspace storage` |

At least one must remain checked to save (see Validation).

### AI Summary provider cards

The `Provider:` dropdown offers exactly three options: `Anthropic`, `Jolli`, and `Local Agent (subscription)` (no "unset" option on this tab — the dialog defaults the selection from existing config, or from sign-in state when no provider is saved). Beneath it, one of five cards is shown:

| Card | Shown when | Content |
| --- | --- | --- |
| Anthropic | Provider = Anthropic | A warning line (visible only while no key is present, from either the field or the `ANTHROPIC_API_KEY` environment variable), an explainer, the masked API-key field, a Model dropdown (`haiku` / `sonnet — balanced (default)` / `opus`), and a Max Output Tokens field. |
| Jolli — signed in, has key | Provider = Jolli, a Jolli API key already exists | A green-check line naming the signed-in site (or a generic "using Jolli" line when no site could be parsed from the key). |
| Jolli — signed in, no key | Provider = Jolli, signed in but no Jolli API key saved | A warning line plus a `Sign Out & Re-login` button. |
| Jolli — signed out | Provider = Jolli, not signed in | An explainer plus a `Sign In to Jolli` button. |
| Local Agent | Provider = Local Agent (subscription) | An `Agent tool:` dropdown whose only option is `Claude Code`, with the tooltip "Uses your local Claude Code login (subscription). Sign in with the `claude` CLI if prompted." **No API key is collected** — the agent's own subscription sign-in is the credential. |

The Local Agent card collects no credential of its own, so this provider has no validation rule (unlike Anthropic's key-prefix check and Jolli's must-be-signed-in check). The agent-tool dropdown is single-valued, so it cannot be set to anything but the one supported tool.

Below all four cards, an `Advanced` toggle link reveals/hides a Jolli-API-key text field (tooltip: auto-filled on sign-in, or paste a new one). The link and panel are force-hidden under the Anthropic card and under the signed-out card; they are shown collapsed (link visible, panel hidden until clicked) under the has-key card; they are force-expanded (link hidden, panel already open) under the no-key card, since that is precisely the field the user needs to fill in.

### Sync tab cards

A separate three-card panel, independent of the AI Summary tab's provider selection (a user can be on the Anthropic summarization provider while still using the Jolli sign-in to sync):

| Card | Shown when | Content |
| --- | --- | --- |
| Signed out | Not signed in | An explainer plus a `Sign In to Jolli` button. |
| Signed in, no key | Signed in but no Jolli API key saved | A warning line, a `Sign Out & Re-login` button, and its own `Advanced` toggle revealing its own Jolli-API-key field. |
| Signed in, has key | Signed in and a Jolli API key exists | A green-check "ready to push memories" line and a `Sign Out` button. |

Below the card: `Auto-sync to Personal Space` (checked by default), `Sync transcripts` (unchecked by default), and a `Poll interval (seconds):` field (tooltip: blank defaults to 90 minutes; shorter values are raised to the 90-minute floor).

### Memory Bank tab: folder controls

A folder-path field (with a browse button scoped to folder selection), a sort-order dropdown (`date` / `name`), and a `Migrate to Memory Bank` button that re-runs migration from the orphan branch into a (possibly new) Memory Bank folder — archiving any existing folders for this repo first so migration lands back on the canonical (non-suffixed) folder name. The migration itself is a **one-shot invocation of the command-line surface's migration command**, not an in-process engine.

The button **runs on a background task with progress text**, not on the UI thread — it is still immediate (not deferred to the dialog's background apply task) and still independent of OK/Cancel, but it no longer blocks the IDE for the duration of the migration. Success or failure is reported via a message dialog when it finishes.

### Memory Bank tab: Historical memory

Below the folder controls, a **Historical memory** section with a `Generate Missing Summaries` button. This is a **re-entry point into the same shared back-fill runner** used by the tool window's cold-start card (spec 260): clicking it runs a **full-scope** back-fill (every own commit lacking a summary — an empty hash selection, which the underlying CLI bridge treats as "all") regardless of whether the cold-start card has been dismissed for this repo. The button disables itself for the duration of the run and re-enables on completion. It does not live inside the dialog's Apply/OK flow — it fires its background task immediately on click, independent of whether the dialog is later confirmed or cancelled.

### Others tab fields

| Element | Detail |
| --- | --- |
| `Exclude Patterns` | Comma-separated glob field; hides files from the Changes panel and AI commits. |
| **`Commits` section** | A bold section heading introducing one checkbox. |
| **DCO sign-off checkbox** | Label: "Add Signed-off-by (DCO) trailer to commits made by Jolli Memory (commit / amend / squash)". Unchecked by default. Tooltip: "Adds a Signed-off-by trailer (`git commit -s`) to commits Jolli makes. Required by many open-source projects' CI. Shared with the VS Code extension via `config.json`." |
| `Pause Jolli Memory` checkbox | "temporarily disable hooks without losing configuration"; tooltip clarifies hooks are uninstalled while settings are preserved. |
| `Privacy` telemetry checkbox | "Send anonymous usage telemetry (content-free — never code, paths, or memory content)", default on. |
| Telemetry hyperlink | Links to the telemetry details page. |

### Field persistence semantics

| Source / Field                          | Where it lives in the merged config                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Anthropic API key                        | `apiKey` (null when blank); the effective value is the saved key when the field still shows its masked form, otherwise exactly what was typed. |
| Model (alias or full ID)                 | `model` (null when the dropdown's alias resolves to the implicit default `sonnet`).                  |
| Max tokens                               | `maxTokens` integer (null when blank).                                                                |
| Provider                                 | `aiProvider` set to `"anthropic"`, `"local-agent"`, or — for anything else — `"jolli"`. |
| Agent tool (Local Agent card)            | `localAgentTool`, always written as the single supported tool identifier regardless of the dropdown, since the dropdown has one option. |
| DCO sign-off                             | `dcoSignoff` boolean.                                                                                  |
| Jolli API key                            | `jolliApiKey`. Read from whichever tab's Advanced/Jolli-key field was actually made visible during this dialog session (Sync tab takes precedence over AI Summary tab when both were opened); if **neither** Advanced panel was ever opened, the existing saved value is kept untouched. If the resolved value is blank while a key previously existed, the key is cleared **and** the user is signed out as a side effect. |
| Six platform checkboxes                  | `claudeEnabled` / `codexEnabled` / `geminiEnabled` / `openCodeEnabled` / `cursorEnabled` / `copilotEnabled` booleans. |
| Excluded patterns                        | `excludePatterns` array, comma-split/trim/drop-empty (null when no entries).                          |
| Memory Bank folder path                  | `knowledgeBasePath` (defaults to the standard Memory Bank parent directory when left blank).           |
| Memory Bank sort order                   | `knowledgeBaseSort` (`date` or `name`).                                                                |
| Pause                                    | `paused` (true, or null when unchecked — not `false`).                                                |
| Auto-sync                                | `autoSyncEnabled` (null when checked — the "on" default — or `false` when unchecked).                 |
| Sync transcripts                         | `syncTranscripts` (true, or null when unchecked).                                                      |
| Poll interval                            | `syncPollIntervalSec` (parsed integer, or null when blank).                                            |
| Telemetry opt-in/out                     | Written to the shared telemetry flag immediately (not through the config load-merge-save cycle), and applied live to the running telemetry context in the same click — not deferred to IDE restart. |

The IDE-native page edits only `apiKey`, `model`, and `jolliApiKey` — it does not touch provider, max-tokens, excluded patterns, platform toggles, Memory Bank fields, pause, or sync fields; those exist only in the gear-icon dialog.

### Validation (dialog)

Runs continuously as the framework re-validates on input change and on OK click:

1. If the provider is Anthropic and a newly-typed key does not start with `sk-ant-`, reject bound to the Anthropic key field. (A saved key whose masked display is left untouched is never re-validated against this prefix.)
2. If the provider is Jolli and the user is not signed in, reject bound to the provider dropdown.
3. If max-tokens is a non-empty string that does not parse to a positive integer, reject bound to the max-tokens field.
4. If all six platform checkboxes are unchecked, reject with `At least one platform must be enabled` bound to the Claude checkbox.

A non-null result blocks the OK action and displays the message inline.

### Origin / key-format checks

The dialog and the IDE-native page do not run origin-allowlist or Jolli-key-format validation themselves. Those checks live in the OAuth flow (origin assertion at sign-in time) and the Jolli API client (parse/validate at request time). The settings surfaces only enforce the Anthropic prefix `sk-ant-` (live) and, on the dialog's provider dropdown, that Jolli requires an active sign-in.

## Behavior

### Opening the IDE-native page

When the user navigates to `Preferences > Tools > Jolli Memory`:

1. The page is constructed lazily by the IDE settings framework.
2. The sign-in row, key fields, and labels are built.
3. The saved config is read and populates the masked Anthropic key, the model field, and the masked Jolli API key.
4. The account row is synced to the current sign-in state.

### Editing on the IDE-native page

- Modification tracking compares the three editable fields against their last-saved values.
- Applying reads the global config, copies it with the new `apiKey`, `model`, and `jolliApiKey` (each null when blank), saves the merged config, and updates the saved-value cache.
- Resetting re-reads the saved config, discarding pending edits.
- The IDE renders the standard Apply, OK, Cancel buttons; OK applies then closes; Apply applies and stays open.

### Sign-in / sign-out from the IDE-native page

Clicking the account row's button:

- When signed in: calls the auth service's sign-out synchronously, then re-syncs the account row.
- When signed out: disables the button, sets its text to `Signing in...`, runs the OAuth login flow (asynchronous). On success, on the UI thread, reloads the form from disk and re-syncs the row — **and additionally dispatches a fire-and-forget pending-push drain off the EDT** (resolving the repo root via the JolliMemory service, falling back to the project base path), draining any commits left in the pending-push queue by pushes made while signed out (owned by spec 271; mirrors the VS Code post-login retry). On failure, on the UI thread, re-syncs the row and shows an error dialog titled `Jolli Sign In`.

This off-EDT drain was added **only** to the IDE-native page's sign-in button. The gear-icon dialog's sign-in buttons (AI Summary tab, Sync tab) did **not** gain it.

### Opening the gear-icon dialog

When the user clicks the gear icon on the JolliMemory tool window:

1. A new dialog instance is constructed with the project and the JolliMemory service; an auth-listener subscription is registered (disposed with the dialog).
2. The tabbed pane is built (AI Agents, AI Summary, Sync to Jolli, Memory Bank, Others) and the previously-remembered tab index is restored.
3. The saved global config is loaded and routed into every field across all five tabs.
4. The AI Summary provider card and the Sync tab card are each synced to their current state.

### Editing in the gear-icon dialog

- Changing the AI Summary tab's provider dropdown re-syncs its four-card panel and the Advanced-panel visibility rule described above.
- Typing in the Anthropic key field toggles the "API key is empty" warning live.
- Any auth-state change (sign-in / sign-out, from any surface) re-syncs both the AI Summary card and the Sync tab card.
- Validation runs continuously as described above; a failing state blocks OK but does not otherwise change tab contents.
- The `Migrate to Memory Bank` and `Generate Missing Summaries` buttons are independent, immediate actions — they do not wait for OK and are not undone by Cancel.

### `Apply Changes` action

Clicking the OK button (`Apply Changes`):

1. Resolves the provider (`"jolli"` / `"anthropic"`), the effective Anthropic key, parsed max-tokens, and the split/trimmed excluded-patterns list.
2. Resolves the Jolli API key per the precedence in Field persistence semantics above; if the resolution clears a previously-existing key, signs the user out as a side effect before re-reading the config.
3. Resolves the Memory Bank folder path (falling back to the standard default when blank) and sort order.
4. Builds the merged config from all of the above plus the six platform booleans, pause, auto-sync, sync-transcripts, and poll-interval, and saves it.
5. Applies the telemetry opt-in/out choice immediately to the live telemetry context (not deferred to restart) and records a provider-selection event.
6. Closes the dialog **immediately** — the remaining work runs in a background task, not before dismissal, so the IDE is never blocked on it:
   - If credentials are now absent, or the user just checked Pause: uninstalls hooks.
   - Else if the user just unchecked Pause (was paused, now isn't): initializes the service if needed and installs hooks.
   - If a project path is available: initializes the Memory Bank folder for the resolved path, and — if storage already exists for this repo (probed through the shared storage factory for the configured storage mode, rather than by asking the orphan-branch backend specifically) — migrates its entries into the folder.
   - Synchronizes the global agent instructions, by running the command-line surface's integrations-only enable rather than an in-process installer.
   - Refreshes status once, after all of the above has settled.

Cancel discards all edits with no I/O; it does not undo a `Migrate to Memory Bank` or `Generate Missing Summaries` run already triggered earlier in the same dialog session, since those are independent immediate actions.

### Sign-in flow from either surface

Clicking any of this surface's several sign-in buttons (the IDE-native page's account-row button, the AI Summary tab's, or the Sync tab's):

1. Disables the button and sets its text to `Signing in...` (or `Signing in...` variants per button).
2. Calls the auth service's login routine, which runs the OAuth flow (separate spec).
3. On success, on the UI thread, re-enables the button, restores its label, and re-syncs whichever card(s) depend on sign-in state.
4. On failure, on the UI thread, re-enables the button, restores its label, and surfaces the error (an IDE notification from the tool window's own sign-in paths; an inline notification from the dialog).

### Disposal

On dialog close, the auth-listener subscription registered at construction is disposed so it does not outlive the dialog.

The IDE-native page is reset by the framework's lifecycle; it owns no live auth-listener subscription — its account-row updates run on click and on the dialog's own post-login callback, not on a persistent subscription.

## State Transitions

```
[user opens Preferences > Tools > Jolli Memory]
  build form (privacy notice, account row, three fields)
  load saved config → populate masked Anthropic key, model, masked Jolli key
  sync account row

[user edits a field on the IDE-native page]
  modification tracking recomputes on framework demand

[user clicks Apply or OK on the IDE-native page]
  read global config; copy with apiKey/model/jolliApiKey (null when blank); save
  update saved-value cache

[user clicks Sign In on the IDE-native page account row]
  button.disable; button.text = "Signing in..."
  login(onSuccess, onError)
  on success → reload form from disk; sync account row;
               dispatch off-EDT pending-push drain (271)  [IDE-native page only]
  on error → sync account row; error dialog "Jolli Sign In"

[user clicks tool window gear → dialog opened]
  build 5 tabs; restore last-selected tab index
  load saved config into every tab's fields
  sync AI Summary provider card + Sync tab card
  register auth-listener (disposed on dialog close)

[user changes the AI Summary provider dropdown]
  re-sync the 4-card panel; re-sync Advanced-panel visibility

[user opens either tab's Advanced disclosure]
  reveal that tab's Jolli-API-key field (marks it as "user interacted" for save purposes)

[auth state changes (any source, while dialog is open)]
  re-sync AI Summary card; re-sync Sync tab card

[user clicks Migrate to Memory Bank]
  archive existing repo folders → resolve/init the (now-free) canonical folder
  run migration from the orphan branch → success/failure message dialog
  (independent of OK/Cancel)

[user clicks Generate Missing Summaries]
  disable button
  shared runner: full scope (empty hash selection), regardless of dismiss marker
  on completion → re-enable button
  (independent of OK/Cancel; on ≥1 generated, clears the cold-start dismiss marker — see spec 260)

[user clicks Apply Changes]
  resolve provider, Anthropic key, max-tokens, excluded patterns
  resolve Jolli API key per Advanced-panel precedence; sign out if cleared
  resolve Memory Bank path + sort
  save merged config; apply telemetry choice live
  close dialog
  → background task (non-cancellable):
      enable/disable hooks per credential + pause-transition state
      init Memory Bank folder; migrate from orphan branch if present
      refresh status

[user clicks Cancel]
  dialog disposed; no I/O (actions already triggered independently, e.g. Migrate/Generate, are unaffected)

[dialog closed, by any path]
  dispose the auth-listener subscription
```

## Notable Behavior

- **Two surfaces, one config file — shared with two other products.** The IDE-native page and the gear-icon dialog write to the same global config file, and so do the command-line surface and the VS Code extension. Saving from any of them is observed by all the others on their next read. There is no IDE-private configuration file. They edit different field sets, but the load-merge-save cycle preserves untouched fields.
- **The dialog's Apply is four non-atomic writes to that shared file.** Five fields are nulled by the first write and restored by later ones, so a concurrent reader on any surface — including a background summary worker — can observe the provider choice and API key as absent. See the configuration-file spec.
- **The IDE-native page does not edit provider, max-tokens, excluded patterns, platform toggles, Memory Bank fields, pause, or sync fields.** Those exist only in the gear-icon dialog. The IDE-native page is the slim surface (Anthropic key, model, Jolli API key) anchored at the standard IDE settings location.
- **The gear-icon dialog builds its own sign-in and provider-selection UI inline, on each of two tabs, rather than reusing a single shared component.** A reusable sign-in-banner component and a reusable provider-picker component both exist elsewhere in the plugin's source, but neither is instantiated by the dialog (or by anything else in the live UI) — the dialog's AI Summary and Sync tabs each implement their own bespoke card-switching instead. (Notable / partially dead code — see Unreachable below.)
- **Migrate to Memory Bank no longer blocks the UI thread.** It runs on a background task with progress text and delegates the migration itself to the command-line surface's one-shot migration command. It is still immediate and still not undone by Cancel; what changed is that the IDE stays responsive while it runs.
- **The dialog closes before its heaviest work runs.** Applying settings snapshots everything it needs off the UI thread, dismisses the dialog immediately, and only then runs hook install/uninstall and Memory Bank init/migration in one ordered background task — so the IDE is never blocked, and the enable/disable step is guaranteed to run before the migration step within that task.
- **The Jolli API key's save value depends on dialog interaction, not just field contents.** If the user never opens either tab's Advanced disclosure, the field's displayed (pre-populated) value is ignored entirely and the existing saved key is kept — only opening the disclosure marks that tab's field as authoritative for save purposes.
- **Generate Missing Summaries ignores the cold-start dismiss marker on the way in and does NOT clear it on the way out.** It always runs full scope regardless of whether the tool-window card was dismissed for this repo — but a successful run, even one that generates many summaries, leaves the dismiss marker in place. There is now **no** path that clears a dismissed cold-start card: once dismissed, it stays dismissed for the life of the marker (spec 260). (Corrected: the shared runner used to clear the marker on a successful run; it no longer does.)
- **Provider is a three-way choice and only two of the three are validated.** Anthropic requires a well-formed typed key; Jolli requires an active sign-in; Local Agent requires nothing, because its credential is the agent's own subscription login. A user can therefore save the Local Agent provider with no credential of any kind configured in this dialog — and some surfaces that gate on "has an API key" will then refuse to run even though the delegated generation path would work.
- **The DCO sign-off flag is explicitly cross-surface.** Its own tooltip says so. It is one of the five fields the Apply sequence nulls and then restores in a separate write.
- **The DCO sign-off checkbox has no effect on commits made by this IDE.** It is persisted to the shared configuration and honoured by the VS Code extension's commit, amend, and squash paths — but nothing on this surface reads it, and none of this IDE's own commit / amend / squash invocations adds a sign-off flag. The checkbox label names "commit / amend / squash" and the tooltip names the shared file, so the setting reads as effective here while in fact only the other surface acts on it. (Notable; a real gap, not a design choice we could find stated anywhere.)
- **Migrate to Memory Bank archives before it resolves.** Every existing folder for this repo (including the canonical, non-suffixed one) is moved into a hidden archive location first, so migration always lands back on the canonical folder name instead of climbing to an ever-higher suffixed one.
- **The OK button text is overridden in the gear-icon dialog.** It reads `Apply Changes`, not the default `OK`. The Cancel button is unchanged.
- **Apply on the IDE-native page does not close the page.** Standard IDE settings semantics.
- **Saved-key masking is one-way for the user.** When a field still shows the masked form, saving persists the original unchanged. When the user types over the masked form, the typed value replaces the saved key wholesale — there is no partial edit.
- **The Anthropic prefix check applies only to newly-typed keys.** A saved key whose mask is unchanged is never re-validated. A typed value is validated only when it does not exactly equal the masked display.
- **Max-tokens is a positive-integer-or-blank field.** Zero, negative, and non-numeric strings reject. Blank means "use default" (`null` saved).
- **At least one of the six platforms must stay enabled.** A user cannot save with every checkbox unchecked — the dialog rejects.
- **Pause is stored as `true` or absent, never explicit `false`.** Unpausing clears the field rather than writing a negative value.
- **Telemetry opt-in/out takes effect immediately**, live in the running process, rather than requiring an IDE restart — matching the first-run notification's own "Turn off" affordance.
- **Origin allowlist enforcement is not in this surface.** It runs in the OAuth callback handler and in the Jolli API client at request time. The settings surfaces assume any saved Jolli API key is valid; broken/stale keys surface as request failures, not as edit-time errors.
- **The privacy notice on the IDE-native page is a copyable link label.** The link target is the static privacy-policy URL.
- **Only the IDE-native page's sign-in drains pending pushes.** On a successful sign-in the IDE-native page dispatches a fire-and-forget, off-EDT pending-push drain (271) to sync commits pushed while signed out; the gear-icon dialog's two sign-in buttons (AI Summary tab, Sync tab) do not. A user who signs in from the dialog instead relies on the next drain trigger (plugin startup, or the post-commit worker) to catch up those pushes. (Notable; an intentional asymmetry between the two surfaces.)
- **The last-selected-tab memory is process-lifetime only.** It is held in a static value inside the dialog's own code, not persisted to the config file or disk — it resets to the first tab on IDE restart, but survives across repeated dialog open/close within one running IDE session.

## Unreachable / Not-live

- **A reusable sign-in-banner component and a reusable "AI summarization provider" picker component both exist in the plugin's source but are never instantiated anywhere in the live UI** (not by the dialog, not by the tool window, not by the onboarding surface). Every live sign-in and provider-selection affordance across the plugin — the dialog's two tabs, the tool window's onboarding card, and other panels with their own sign-in buttons — implements its own bespoke version instead. The provider-picker component's static key-masking helper is the one piece of it still reused (by the dialog, for display formatting); the interactive widget itself is dead.

## Shared Behavior

- **Global config directory** — the canonical save target for both surfaces, shared with the command-line surface and the VS Code extension; load-merge-save preserves untouched fields. The file identity, the delegated load/save, and the four-write Apply sequence are owned by the configuration-file spec (129).
- **One-shot migration command** — what the Memory Bank tab's Migrate button actually invokes; this surface only launches it on a background task and reports its outcome.
- **Auth service** — the OAuth flow's entry point and the source of sign-in state. Every sign-in affordance across both surfaces subscribes to its listener or calls it directly.
- **Pending-push drain** — the off-EDT pending-push retry the IDE-native page fires on successful sign-in is owned by **IntelliJ Pre-Push Sync Catch-Up** (271); this surface only dispatches it and never waits on it.
- **OAuth flow** — runs the browser launch, callback server, and token exchange (separate spec); writes the Jolli API key into the global config.
- **The shared back-fill runner** — invoked identically by the Memory Bank tab's `Generate Missing Summaries` button (full scope) and by the tool-window cold-start card (a specific selection); its progress reporting, completion notifications, and cold-start bookkeeping are owned by **IntelliJ Cold-start Back-fill Card** (spec 260).
- **JolliMemory service** — the dialog passes it through both to the shared back-fill runner and to resolve the project's repo root; the IDE-native page reads the same repo-root resolution solely for backwards-compatible config-load behavior.
- **Tool window gear icon** — the surface that constructs the dialog (one entry point per click).
- **Status panel** — co-resident in the same tool window; holds no edit affordance for these fields itself. Settings edits are exclusively through these two surfaces.
