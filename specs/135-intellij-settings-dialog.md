# IntelliJ Settings Surface

## Topic Statement

Two surfaces that together let an IntelliJ user edit their Jolli Memory configuration: an IDE-native settings page anchored at `Preferences > Tools > Jolli Memory` (a slim five-field form) and a separate modal dialog titled `Jolli Memory Settings` opened from the tool window's gear icon (a five-**tab** dialog covering agent selection, AI summarization, cloud sync, the Memory Bank folder, and everything else). Both persist to the same global config directory but expose different field sets and follow different apply-vs-OK conventions. Each surface builds its own sign-in affordance and its own provider-selection UI inline, rather than sharing a single reusable component.

## Scope

**In scope:**
- The IDE-native settings page at `Preferences > Tools > Jolli Memory` and its five rows: a privacy notice link, a sign-in account row, an Anthropic API key field, a model field, and a Jolli API key field.
- The modal dialog opened from the tool window gear icon: its title `Jolli Memory Settings`, its OK button text `Apply Changes`, its fixed preferred size, its last-selected-tab memory, and its five tabs — **AI Agents**, **AI Summary**, **Sync to Jolli**, **Memory Bank**, **Others** — and everything each tab edits.
- The Memory Bank tab's **Historical memory** entry point ("Generate Missing Summaries"): what it runs, how it relates to the tool-window cold-start card's dismiss marker, and how it differs from the tab's separate "Migrate to Memory Bank" action.
- The AI Summary tab's provider-dependent card switching (Anthropic / Jolli-signed-in / Jolli-signed-in-no-key / Jolli-signed-out) and its "Advanced" disclosure for the Jolli API key field.
- The Sync tab's own provider-independent card switching (signed-out / signed-in-no-key / signed-in) and its per-repo outbound-push toggle.
- The `Sync transcripts` checkbox on the Memory Bank tab, and the two config fields (`autoSyncEnabled`, `syncPollIntervalSec`) that are **round-tripped without any control** on any tab.
- The shared save target: a single global config directory; both surfaces read from and write to the same file.
- The validation rules surfaced via the dialog's continuous validation (provider-specific requirements; max-tokens must be a positive integer when set; at least one of the six platform checkboxes must stay enabled).
- The apply-vs-OK semantics: the IDE-native page exposes Apply (no dialog dismissal) plus OK (apply + close); the gear-icon dialog only has OK (relabeled `Apply Changes`) and Cancel, and defers its heaviest work (hook install/uninstall, Memory Bank init + migration, and re-pointing the session's memory-mirror read source) to a background task that runs **after** the dialog has already closed.
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
| Signed in     | `Signed in`    | `Sign Out`   | Calls the auth service's sign-out and returns immediately; the row is **not** refreshed inline. The re-render arrives via the authentication listener (below). |
| Signed out    | `Not signed in`| `Sign In`    | Fire-and-forget: starts the OAuth login flow and returns. The button is left in its enabled `Sign In` state throughout. On success it reloads the form from disk, refreshes the row, and dispatches the pending-push drain; on failure it shows an error dialog titled `Jolli Sign In` and nothing else. |

There is **no in-flight button state on this surface.** Neither direction disables the button or relabels it — the sign-in click does not become a "signing in" placeholder, and the sign-out click does not either. Both gestures are fire-and-forget and the button's label is a pure function of the sign-in state the row was last rendered from.

### Authentication listener (IDE page)

The IDE-native page **registers its own authentication listener** when its component is built and disposes it when the framework tears the page down. Every notification re-reads the saved configuration and re-renders the account row on the interface thread.

The listener is what makes the row correct at all, because **sign-out is now asynchronous**: it dispatches off the interface thread and returns before the state has actually changed. An inline re-render immediately after the click would therefore read a still-signed-in value — and would read it from a **cached** sign-in check whose value is held for 5 seconds, so even a slightly later inline read would report the stale answer. Deferring the re-render to the listener, which fires only once the sign-out has landed, is the fix. The other surfaces in this IDE that show sign-in state — the gear-icon dialog, the tool-window sign-in banner, and the onboarding card — already worked this way; this page was the last one re-rendering inline.

### Gear-icon dialog: five tabs

The dialog's center panel is a tabbed pane. Selecting a tab is remembered (a process-lifetime, not disk-persisted, "last selected tab" index) so reopening the dialog later in the same IDE session returns to the tab the user was last on. The dialog's preferred size is fixed; the OK button reads `Apply Changes`.

| # | Tab              | Contents                                                                                                          |
| - | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1 | **AI Agents**     | A gray explainer line, then six enable/disable checkboxes (see Platform checkboxes below), all default checked.  |
| 2 | **AI Summary**    | A `Provider:` dropdown (`Anthropic` / `Jolli`) driving a four-card panel (see AI Summary provider cards below), plus a collapsible "Advanced" Jolli-API-key field below the card. |
| 3 | **Sync to Jolli** | A three-card sign-in panel (see Sync tab cards below), a separator, then the **Push to Jolli Space (this repository)** section: a bold heading, the `Push this repository's memories to Jolli` checkbox, and a gray explainer. |
| 4 | **Memory Bank**   | A folder-path picker, a sort-order dropdown, a `Migrate to Memory Bank` button, then `Sync transcripts` (default off) with a gray explainer, and (below a spacer) the **Historical memory** section: a heading, an explainer, and a `Generate Missing Summaries` button. |
| 5 | **Others**        | An `Exclude Patterns` heading + comma-separated globs field, a `Pause Jolli Memory` checkbox, and a `Privacy` heading with a telemetry opt-in checkbox and a hyperlink to telemetry details. |

### Platform checkboxes (AI Agents tab)

Six checkboxes, all default checked, each labeled with its detection mechanism:

| Checkbox | Label |
| --- | --- |
| Claude Code | `Claude Code — Session tracking via Stop hook` |
| Codex | `Codex — Session discovery via filesystem scan` |
| Gemini | `Gemini — Session tracking via AfterAgent hook` |
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

**Divergence from the desktop-editor settings panel.** That surface's provider dropdown now labels this option simply `Local Agent` (without the parenthetical), and its agent-tool dropdown is generated from the tool registry and offers all four supported tools. This dialog keeps the older parenthesised label and still offers only the default tool. The consequence is no longer cosmetic: because this dialog writes the default tool identifier on every Apply **regardless of what its dropdown shows** (see Field persistence semantics), applying settings from here **overwrites a non-default agent tool the user selected on the other surface**, silently reverting them to the default. That was harmless while no other tool could be chosen anywhere; it is a real cross-surface clobber now that one can.

Below all four cards, an `Advanced` toggle link reveals/hides a Jolli-API-key text field (tooltip: auto-filled on sign-in, or paste a new one). The link and panel are force-hidden under the Anthropic card and under the signed-out card; they are shown collapsed (link visible, panel hidden until clicked) under the has-key card; they are force-expanded (link hidden, panel already open) under the no-key card, since that is precisely the field the user needs to fill in.

### Sync tab cards

A separate three-card panel, independent of the AI Summary tab's provider selection (a user can be on the Anthropic summarization provider while still using the Jolli sign-in to sync):

| Card | Shown when | Content |
| --- | --- | --- |
| Signed out | Not signed in | An explainer plus a `Sign In to Jolli` button. |
| Signed in, no key | Signed in but no Jolli API key saved | A warning line, a `Sign Out & Re-login` button, and its own `Advanced` toggle revealing its own Jolli-API-key field. |
| Signed in, has key | Signed in and a Jolli API key exists | A green-check "ready to push memories" line and a `Sign Out` button. |

Below the card, after a separator, the **Push to Jolli Space (this repository)** section: a bold heading, a `Push this repository's memories to Jolli` checkbox, and a gray explainer ("Off = keep recording this repository's memory locally but never push it to its Jolli Space (auto or manual). Re-enabling syncs the backlog."). This is the IntelliJ face of the per-repo outbound-push control (spec 306) — it is **not** a config-file field: it is read via the `push-control-get` IDE bridge and written via `push-control-set`, against the machine-global push-control store.

The checkbox starts **disabled** and is enabled only once the async read lands, so the dialog never asserts a state it does not have. A read that fails — or answers with a malformed reply — leaves it disabled with an explanatory tooltip and leaves the row marked *not loaded*, which suppresses the write in `doOKAction` entirely; the state is re-read next time Settings opens. The write fires only when the value actually changed, so re-saving Settings never re-triggers the re-enable drain, and a failed write raises a warning notification rather than being swallowed (the dialog has already closed by then).

`Auto-sync to Personal Space` and its paired `Poll interval (seconds):` field are **no longer surfaced** on any tab (not yet actionable); `Sync transcripts` moved to the **Memory Bank** tab, next to the other content-scope controls. See the field map below for how the two unsurfaced values are preserved.

### Memory Bank tab: folder controls

A folder-path field (with a browse button scoped to folder selection), a sort-order dropdown (`date` / `name`), and a `Migrate to Memory Bank` button that re-runs migration from the orphan branch into a (possibly new) Memory Bank folder — archiving any existing folders for this repo first so migration lands back on the canonical (non-suffixed) folder name. The migration itself is a **one-shot invocation of the command-line surface's migration command**, not an in-process engine.

The button **runs on a background task with progress text**, not on the UI thread — it is still immediate (not deferred to the dialog's background apply task) and still independent of OK/Cancel, but it no longer blocks the IDE for the duration of the migration. Success or failure is reported via a message dialog when it finishes.

This flow — and **only** this flow — probes first: before archiving anything it asks whether storage already exists for this repo (through the shared storage-backend selection for the configured storage mode, rather than by asking the orphan-branch backend specifically), and on "no storage" it reports "nothing to migrate" in a message dialog and stops without archiving, resolving, or invoking the migration command. The dialog's deferred apply has no such probe.

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
| Jolli API key                            | `jolliApiKey`. Read from whichever tab's Advanced/Jolli-key field was actually made visible during this dialog session (Sync tab takes precedence over AI Summary tab when both were opened); if **neither** Advanced panel was ever opened, the existing saved value is kept untouched. If the resolved value is blank while a key previously existed, the key is cleared **and** the user is signed out. |
| Session token (sign-out side effect)     | The token field is nulled **inside the same single configuration write that clears the key** — not by a separate asynchronous sign-out. The asynchronous sign-out is still fired, but only after every write this Apply performs on the interface thread has landed; by then the token and key are already absent on disk, so its own credential clearing is idempotent and its remaining jobs are the telemetry event, notifying the authentication listeners, and rolling the provider field back off the proxy choice. |
| Six platform checkboxes                  | `claudeEnabled` / `codexEnabled` / `geminiEnabled` / `openCodeEnabled` / `cursorEnabled` / `copilotEnabled` booleans. |
| Excluded patterns                        | `excludePatterns` array, comma-split/trim/drop-empty (null when no entries).                          |
| Memory Bank folder path                  | `knowledgeBasePath` (defaults to the standard Memory Bank parent directory when left blank).           |
| Memory Bank sort order                   | `knowledgeBaseSort` (`date` or `name`).                                                                |
| Pause                                    | `paused` (true, or null when unchecked — not `false`).                                                |
| *(no control)*                           | `autoSyncEnabled` — **round-tripped verbatim**: `populateFields` snapshots the loaded value and `doOKAction` writes exactly that back. |
| Sync transcripts *(Memory Bank tab)*     | `syncTranscripts` (true, or null when unchecked).                                                      |
| *(no control)*                           | `syncPollIntervalSec` — **round-tripped verbatim**, same as `autoSyncEnabled`.                          |
| Push this repository's memories to Jolli | **Not a config field.** Read/written through the `push-control-get` / `push-control-set` IDE bridge against the machine-global push-control store (spec 306); written only when changed, and only once the async read has landed. |
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

The dialog and the IDE-native page do not run origin-allowlist or Jolli-key-format validation themselves. The only enforcement that covers a key entered here is in the **sign-in flow**, which asserts the origin when a key is minted. There is **no request-time enforcement on this IDE's side**: every backend call now dispatches through the bundled command-line surface's bridge rather than an in-process HTTP client, so nothing in this codebase validates an origin before a request. The one key-parsing helper kept in this IDE is a pure parse with no allowlist assertion, and this IDE's own copy of the validating helper has no production caller at all. A hand-pasted key whose embedded origin is off the allowlist is therefore accepted and saved by these surfaces without complaint; whatever rejection follows comes from the bridge, not from here.

The settings surfaces themselves only enforce the Anthropic prefix `sk-ant-` (live) and, on the dialog's provider dropdown, that Jolli requires an active sign-in.

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

- When signed in: calls the auth service's sign-out, which dispatches off the interface thread and returns immediately. The handler does nothing else — no inline re-render. The registered authentication listener re-reads configuration and re-renders the row once the sign-out has actually landed.
- When signed out: starts the OAuth login flow and returns; the button is not disabled and not relabelled. On success, on the UI thread, reloads the form from disk and re-syncs the row — **and additionally dispatches a fire-and-forget pending-push drain off the EDT** (resolving the repo root via the JolliMemory service, falling back to the project base path), draining any commits left in the pending-push queue by pushes made while signed out (owned by spec 271; mirrors the VS Code post-login retry). On failure, on the UI thread, shows an error dialog titled `Jolli Sign In` — there is no button state to restore.

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

1. Resolves the provider (`"anthropic"` / `"local-agent"` / `"jolli"`), the effective Anthropic key, parsed max-tokens, and the split/trimmed excluded-patterns list.
2. Resolves the Jolli API key per the precedence in Field persistence semantics above, and records whether that resolution *clears* a previously-existing key. **No sign-out is dispatched at this point.**
3. Resolves the Memory Bank folder path (falling back to the standard default when blank) and sort order.
4. Builds the merged config from all of the above plus the six platform booleans, pause, sync-transcripts, and the two round-tripped values (`autoSyncEnabled`, `syncPollIntervalSec`, written back exactly as they were loaded — no control edits them) — **and, when the key was cleared, a nulled session token in the same record** — and saves it.
5. Applies the telemetry opt-in/out choice immediately to the live telemetry context (not deferred to restart) and records a provider-selection event.
6. **Only now**, after every interface-thread write has landed, fires the asynchronous sign-out if the key was cleared.
7. Computes the auto-disable decision (see below).
8. Closes the dialog **immediately** — the remaining work runs in a background task, not before dismissal, so the IDE is never blocked on it:
   - If credentials are now absent, or the user just checked Pause: uninstalls hooks.
   - Else if the user just unchecked Pause (was paused, now isn't): initializes the service if needed and installs hooks.
   - If a project path is available: initializes the Memory Bank folder for the resolved path and then migrates into it **unconditionally** — this flow performs no existence probe of its own. Whether there is anything to migrate is decided inside the one-shot migration command (which no-ops when there is no orphan-branch data and runs its idempotent reconcile once migration has already completed), so this branch has no "nothing to migrate" outcome to report. (The existence probe, and the message dialog that goes with it, belong to the Memory Bank tab's Migrate button instead.)
   - **Then, in the same branch and immediately after that migration, asks the JolliMemory service to re-point its direct memory-mirror read source at the newly configured folder and storage mode.** This step is what makes the two Memory Bank settings this dialog owns — the folder path, and (via the storage mode) whether a mirror is read at all — actually take effect in the running session. Without it, both changes appear to apply and do not: the service's initialization is single-shot, so the read source stays attached to the folder resolved at project open, and every memory, plan, and note read keeps coming from that previous folder (or keeps coming from the mirror after the mode stopped writing one) for the rest of the session. The re-attach itself is fail-soft — a failure leaves the previous attachment in place — and resolving to *no* read source is a normal outcome that simply sends reads back to the orphan branch. Owned by specs 124 (the hook) and 307 (the read source).
   - Synchronizes the global agent instructions, by running the command-line surface's integrations-only enable rather than an in-process installer.
   - Persists the per-repo outbound-push toggle through the `push-control-set` bridge — **only** when the async read had landed *and* the value actually changed, so merely re-saving Settings never re-triggers the re-enable drain. A failure here surfaces as a warning notification (the dialog is already closed, so silence would leave the user believing it saved).
   - Refreshes status once, after all of the above has settled.

Cancel discards all edits with no I/O; it does not undo a `Migrate to Memory Bank` or `Generate Missing Summaries` run already triggered earlier in the same dialog session, since those are independent immediate actions.

### Auto-disable decision ("are credentials now absent?")

The background task's first branch uninstalls hooks when credentials are absent. That verdict **branches on the selected provider** rather than OR-ing the presence of every credential the dialog knows about, so it mirrors what a summary run could actually route with:

| Selected provider | Verdict |
| --- | --- |
| Local Agent | Credentials are **always** considered present — the tool's own login is the credential and this dialog can neither see it nor supply it. |
| Jolli | Present only when a Jolli API key survives this Apply (i.e. one is resolved and it was not cleared). |
| Anthropic | Present when either the Anthropic key just persisted, or the vendor environment variable, is non-blank. A lone Jolli key does **not** satisfy it — the generation path would fail at call time. |

Two things the previous any-credential OR-check got wrong and this fixes: it accepted a lone Jolli key under the Anthropic provider, and it read the Anthropic key from the field that this Apply deliberately nulls (Anthropic credentials live only in the shared configuration now), so it always saw that key as absent and uninstalled hooks from users who had one.

The provider is resolved to exactly one of the three values above, so a fourth "no provider selected" arm — which would fall back to the old any-of-three test — exists in the decision but cannot be reached from this dialog.

### Sign-in flow from either surface

Clicking any of this surface's several sign-in buttons (the IDE-native page's account-row button, the AI Summary tab's, or the Sync tab's):

1. Calls the auth service's login routine, which runs the OAuth flow (separate spec) and returns as soon as the browser has been handed the request. **The button is not disabled and its label is not changed** — there is no in-flight state on any of the three buttons.
2. On success, on the UI thread, re-syncs whichever card(s) depend on sign-in state.
3. On failure, on the UI thread, surfaces the error (an IDE notification from the tool window's own sign-in paths; an inline notification from the dialog). No button state is restored, because none was taken away.

The dialog's two buttons no longer receive the clicked button as an argument at all — the handler is button-agnostic, which is what removing the per-button in-flight state made possible.

### Disposal

On dialog close, the auth-listener subscription registered at construction is disposed so it does not outlive the dialog.

The IDE-native page **does** own a live authentication-listener subscription: it is registered when the framework builds the page's component and disposed when the framework tears the page's UI resources down. Any pre-existing subscription is disposed before a new one is registered, so re-opening the settings page does not accumulate listeners.

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
  login(onSuccess, onError)              // fire-and-forget; button untouched
  on success → reload form from disk; sync account row;
               dispatch off-EDT pending-push drain (271)  [IDE-native page only]
  on error → error dialog "Jolli Sign In"

[user clicks Sign Out on the IDE-native page account row]
  signOut()                              // async; returns before state changes
  (no inline re-render — a cached signed-in read would still say "Signed in")

[auth listener fires (IDE-native page, registered at component build)]
  reload form from disk; sync account row

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
  probe whether storage exists for this repo → if not: "nothing to migrate" dialog, stop
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
  resolve Jolli API key per Advanced-panel precedence; note whether it was cleared
  resolve Memory Bank path + sort
  save merged config (session token nulled in the SAME record when key cleared)
  apply telemetry choice live
  fire async sign-out — only now, after every EDT write has landed
  compute auto-disable verdict from the SELECTED provider
  close dialog
  → background task (non-cancellable):
      enable/disable hooks per credential + pause-transition state
      init Memory Bank folder; migrate unconditionally (no probe — the migration
        command itself decides whether there is anything to do)
      re-point the session's memory-mirror read source at the new folder + mode
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
- **This dialog's save is the only in-session trigger that re-points where memories are read from.** After the deferred background apply runs the migration, it re-points the session's direct memory-mirror read source at the newly configured folder and storage mode. That step is load-bearing rather than tidy-up: the service's initialization is single-shot, so without it a changed Memory Bank path or a storage mode switched to ref-only would appear to take effect while reads carried on being served from the previously attached folder for the rest of the session. A storage-mode or folder change made from the command line or the desktop editor instead is *not* observed by this IDE until the next project open. (Notable; specs 124, 307.)
- **The dialog closes before its heaviest work runs.** Applying settings snapshots everything it needs off the UI thread, dismisses the dialog immediately, and only then runs hook install/uninstall and Memory Bank init/migration in one ordered background task — so the IDE is never blocked, and the enable/disable step is guaranteed to run before the migration step within that task.
- **The Jolli API key's save value depends on dialog interaction, not just field contents.** If the user never opens either tab's Advanced disclosure, the field's displayed (pre-populated) value is ignored entirely and the existing saved key is kept — only opening the disclosure marks that tab's field as authoritative for save purposes.
- **Generate Missing Summaries ignores the cold-start dismiss marker on the way in and does NOT clear it on the way out.** It always runs full scope regardless of whether the tool-window card was dismissed for this repo — but a successful run, even one that generates many summaries, leaves the dismiss marker in place. There is now **no** path that clears a dismissed cold-start card: once dismissed, it stays dismissed for the life of the marker (spec 260). (Corrected: the shared runner used to clear the marker on a successful run; it no longer does.)
- **Provider is a three-way choice and only two of the three are validated.** Anthropic requires a well-formed typed key; Jolli requires an active sign-in; Local Agent requires nothing, because its credential is the agent's own subscription login. A user can therefore save the Local Agent provider with no credential of any kind configured in this dialog. This surface no longer punishes them for it: its own auto-disable decision branches on the selected provider and treats Local Agent as always-credentialed, so applying settings under that provider no longer uninstalls the hooks.
- **This dialog silently reverts a non-default agent tool chosen elsewhere.** Its own dropdown offers only the default tool, and it writes the default tool identifier on every Apply regardless of the dropdown — so one Apply here overwrites a different tool selected in the desktop-editor settings panel. That write predates the other surface gaining more than one option; it was a no-op then and is a cross-surface clobber now. (Surprising; a real gap.)
- **The sign-out that a cleared Jolli key implies is written, not dispatched.** The session token is nulled inside the same single configuration write that clears the key, and the asynchronous sign-out fires only after every interface-thread write of the Apply has landed. Previously the two ran concurrently against the same file, each doing its own load-modify-write, which produced two nondeterministic failures: users who cleared their key stayed signed in, and a stale in-flight snapshot clobbered settings the Apply had just saved. (Surprising; the ordering is the fix.)
- **There is no in-flight sign-in state anywhere on this surface.** None of the three sign-in buttons is disabled or relabelled while the OAuth flow runs; all three are fire-and-forget and re-render from the authentication listener instead. Sign-out is asynchronous too, which is why the IDE-native page had to grow its own listener — an inline re-render right after the click reads a sign-in check whose answer is cached for 5 seconds and would repaint "Signed in". (Notable.)
- **The auto-disable decision used to uninstall hooks from users who had an Anthropic key.** It read the key from the field this Apply deliberately nulls (Anthropic credentials live only in the shared configuration), so it always saw "no key" — and it also accepted a lone Jolli key under the Anthropic provider, where generation would have failed at call time. Branching on the selected provider fixes both directions. (Notable.)
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
- **Origin allowlist enforcement is not in this surface, and no longer anywhere on this IDE's request path either.** It runs in the sign-in flow, at key-mint time. The claim that it also runs "in the Jolli API client at request time" was never true of this IDE — that client never asserted an origin — and is now definitively false, because the client makes no requests at all: it delegates every backend call to the bundled command-line surface's bridge. This IDE's own validating key helper has no production caller; only the non-asserting parser does. The settings surfaces therefore assume any saved Jolli API key is valid, and a bad one surfaces as a bridge-side failure rather than an edit-time error. (Surprising; a corrected claim.)
- **The privacy notice on the IDE-native page is a copyable link label.** The link target is the static privacy-policy URL.
- **Only the IDE-native page's sign-in drains pending pushes.** On a successful sign-in the IDE-native page dispatches a fire-and-forget, off-EDT pending-push drain (271) to sync commits pushed while signed out; the gear-icon dialog's two sign-in buttons (AI Summary tab, Sync tab) do not. A user who signs in from the dialog instead relies on the next drain trigger (plugin startup, or the post-commit worker) to catch up those pushes. (Notable; an intentional asymmetry between the two surfaces.)
- **The last-selected-tab memory is process-lifetime only.** It is held in a static value inside the dialog's own code, not persisted to the config file or disk — it resets to the first tab on IDE restart, but survives across repeated dialog open/close within one running IDE session.

## Unreachable / Not-live

- **A reusable sign-in-banner component and a reusable "AI summarization provider" picker component both exist in the plugin's source but are never instantiated anywhere in the live UI** (not by the dialog, not by the tool window, not by the onboarding surface). Every live sign-in and provider-selection affordance across the plugin — the dialog's two tabs, the tool window's onboarding card, and other panels with their own sign-in buttons — implements its own bespoke version instead. The provider-picker component's static key-masking helper is the one piece of it still reused (by the dialog, for display formatting); the interactive widget itself is dead.

## Shared Behavior

- **Global config directory** — the canonical save target for both surfaces, shared with the command-line surface and the VS Code extension; load-merge-save preserves untouched fields. The file identity, the delegated load/save, and the four-write Apply sequence are owned by the configuration-file spec (129).
- **One-shot migration command** — what the Memory Bank tab's Migrate button actually invokes; this surface only launches it on a background task and reports its outcome.
- **Memory-mirror read source** — the read source the background apply re-points after migrating. Its attach hook and threading contract are owned by **IntelliJ Project Service Lifecycle** (124); its read shapes, eligibility rules, and decline conditions by **IntelliJ Direct Memory-Mirror Read Path** (307). This surface only calls the hook, at one point in one ordered task.
- **Auth service** — the OAuth flow's entry point and the source of sign-in state. Every sign-in affordance across both surfaces subscribes to its listener or calls it directly.
- **Pending-push drain** — the off-EDT pending-push retry the IDE-native page fires on successful sign-in is owned by **IntelliJ Pre-Push Sync Catch-Up** (271); this surface only dispatches it and never waits on it.
- **OAuth flow** — runs the browser launch, callback server, and token exchange (separate spec); writes the Jolli API key into the global config.
- **The shared back-fill runner** — invoked identically by the Memory Bank tab's `Generate Missing Summaries` button (full scope) and by the tool-window cold-start card (a specific selection); its progress reporting, completion notifications, and cold-start bookkeeping are owned by **IntelliJ Cold-start Back-fill Card** (spec 260).
- **JolliMemory service** — the dialog passes it through both to the shared back-fill runner and to resolve the project's repo root; the IDE-native page reads the same repo-root resolution solely for backwards-compatible config-load behavior.
- **Tool window gear icon** — the surface that constructs the dialog (one entry point per click).
- **Status panel** — co-resident in the same tool window; holds no edit affordance for these fields itself. Settings edits are exclusively through these two surfaces.
