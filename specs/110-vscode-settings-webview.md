# VS Code Settings Webview

## Topic Statement

The settings webview that edits the per-user configuration — Anthropic API key, model alias, max-output tokens, Jolli API key, nine independent agent-integration toggles, AI-summary provider selection (including the local-agent provider and its agent-tool choice), Memory Bank local folder, Memory Bank cloud-sync controls, DCO sign-off, and exclude-pattern globs — and persists them to a single per-user config file with no per-workspace overrides, validating the Jolli API key against an HTTPS-only host allowlist before any disk write. The Memory Bank tab additionally carries a read-only line reporting whether folder-layer writes are actually landing and where.

## Scope

**In scope:**
- The fields the form exposes and the type of input each one uses, organised across five top-level tabs: AI Agents, AI Summary, Sync to Jolli, Memory Bank, Others.
- The save target: a single per-user config location, unconditional. There is no per-workspace alternative.
- API-key masking on display and the rule that an unchanged masked value is treated as "keep the existing key".
- Inline (per-keystroke) validation rules and the persistent error banner for save-time failures.
- The Jolli-API-key origin allowlist that runs on every keystroke and again on save.
- The "at least one integration must be enabled" rule.
- The integration-toggle side effect: enabling or disabling the Claude or Gemini toggle installs or removes the corresponding hook across every worktree of the repository. The other agent toggles (Codex, OpenCode, Cursor, Devin, Copilot, Cline, Antigravity) gate discovery-only integrations and have no per-worktree hook to install.
- The AI Summary provider selection (Anthropic direct, Jolli proxy, or local agent) and the conditional cards rendered for each: an Anthropic card with key / model / max-tokens; a Jolli card with three sub-states (signed-in-with-key, signed-in-but-key-missing, signed-out) and a sign-in button that hands off to the shared auth service; a local-agent card with an agent-tool dropdown and no credential field.
- The Memory Bank tab's read-only effective-state line: its position, its ships-collapsed rule, the hidden-on-missing-payload rule, and its plain-text rendering.
- The Memory Bank sync controls: a "Sync to Personal Space Now" button that triggers an on-demand sync round, an "Auto-sync to Personal Space" toggle, a poll-interval input clamped at the lower bound (lower values clamp up to the floor; values above the upper bound clamp down), an "Include transcripts" toggle (off by default; warns the user that transcripts may include sensitive content), and a warning banner reminding the user that the local-folder must not be shared with iCloud / Dropbox / Syncthing because manual sync still writes there even when auto-sync is off (cross-ref spec 174 for the sync engine).
- The local-folder browse button, the "Migrate to Memory Bank" button, the compile-exclude-folders input, and their per-action feedback strings.
- The "Others" tab: a DCO sign-off toggle that adds `Signed-off-by` to Jolli-driven commit / amend / squash operations, plus the exclude-pattern globs that hide files from the Changes panel and AI commits.
- The dirty-tracking model: Apply Changes is enabled only when the form is dirty *and* free of validation errors.
- Singleton lifecycle: only one settings panel can be open at a time; opening a second time reveals the existing panel.
- The opening-load surface that, after loading, immediately surfaces an invalid-but-saved Jolli API key as a persistent error banner.

**Out of scope:**
- Hook-installer mechanics — what the installer puts on disk, where, and how it resolves dist paths. This spec only covers the toggle-driven syncing as a side effect of saving.
- The specifics of any LLM call that uses these credentials. This spec only covers persistence.
- Status bar icon / sidebar tree-view changes that may follow a save. This spec covers the post-save callback hand-off but not what the receivers do with it.
- The migrate-to-Memory-Bank action's internals — covered by its own command topic.
- Any other webview surface (Summary, Note Editor, Binding Chooser).

## Data Contracts

### Form fields (in display order)

| Tab | Field | Input | Notes |
| --- | --- | --- | --- |
| AI Agents | Claude Code | Slider toggle. | Default on. Toggling installs / removes the Claude Stop + SessionStart hooks across every worktree. |
| AI Agents | Codex | Slider toggle. | Default on. Discovery-only — no hook is installed; the flag gates whether Codex sessions are scanned and surfaced. |
| AI Agents | Gemini | Slider toggle. | Default on. Toggling installs / removes the Gemini AfterAgent hook across every worktree. |
| AI Agents | OpenCode | Slider toggle. | Default on. Discovery-only. |
| AI Agents | Cursor | Slider toggle. | Default on. Discovery-only. Single shared toggle for the Composer IDE store and the command-line agent. |
| AI Agents | Devin | Slider toggle. | Default on. Discovery-only. |
| AI Agents | Copilot | Slider toggle. | Default on. Single shared toggle for both GitHub Copilot CLI (terminal) and VS Code Copilot Chat — flipping it on or off enables / disables discovery of both surfaces at once. Discovery-only. |
| AI Agents | Cline | Slider toggle. | Default on. Discovery-only. Single shared toggle for the Cline CLI and the Cline VS Code extension. |
| AI Agents | Antigravity | Slider toggle. | Default on. Discovery-only. |
| AI Agents | "At least one must be on" | Form-level rule. | At least one of the nine toggles above must be checked, otherwise Apply Changes shows a red feedback string and refuses to send. |
| AI Summary | Provider | Dropdown ("Anthropic", "Jolli", "Local Agent"). | Selects which of the cards renders below. |
| AI Summary | Anthropic API Key | Plain text input. | Anthropic card only. Masked on display; unchanged masked value is "keep". |
| AI Summary | Model | Dropdown ("Haiku — fastest", "Sonnet — balanced (default)", "Opus — most capable"). | Anthropic card only. Default is "sonnet". Saving "sonnet" writes nothing (default elision). |
| AI Summary | Max Output Tokens | Number input. | Anthropic card only. Default placeholder "8192"; empty persists as unset. |
| AI Summary | Sign In to Jolli | Button. | Jolli card, signed-out sub-state only. Hands off to the shared auth service; OAuth completion returns the Jolli API key, which then persists through the normal save path. |
| AI Summary | Jolli API Key | Plain text input (under an "Advanced" disclosure). | Jolli card, signed-in sub-states. Masked on display; validated for shape and origin both inline and at save. |
| AI Summary | Agent tool | Dropdown, one option per supported local-agent tool. | Local-agent card only. The options are **generated from the tool registry**, not hand-written, so a newly-supported tool appears with no edit to this form. **No credential of any kind is collected on this card** — the tool's own login is the credential. |
| Sync to Jolli | Sign In / Sign Out to Jolli | Button. | Two sub-cards (signed-in vs. signed-out) based on the current sign-in state. |
| Memory Bank | Folder Path | Read-only text + Browse button. | Folder picker on Browse; selected path written back via a webview message. |
| Memory Bank | Memory Bank effective state | Read-only single line (icon + text). | Directly beneath the Folder Path row. Populated from the host's verdict, never derived in the webview. See "Memory Bank state line" below. |
| Memory Bank | Compile Exclude Folders | Plain text input. | Comma-separated names; exact match or `*` glob. Skips matching subfolders during multi-repo compile. |
| Memory Bank | Migrate to Memory Bank | Button. | Triggers the rebuild action; status text reports outcome inline. |
| Memory Bank | Sync to Personal Space Now | Button. | On-demand sync round. Disabled while the sync engine is mid-round; outcome surfaces via the status bar (cross-ref spec 174). |
| Memory Bank | Auto-sync to Personal Space | Slider toggle. | When on, reveals the poll-interval input and the sync engine runs rounds on the configured cadence. |
| Memory Bank | Poll interval (minutes) | Number input. | Lower bound enforced by clamping (values below the floor clamp up; values above the ceiling clamp down). Persisted in the saved config. |
| Memory Bank | Include transcripts | Slider toggle. | Off by default. Warns the user that transcripts may contain sensitive content. Applies to both manual and auto-sync rounds. |
| Memory Bank | Shared-folder warning | Static banner. | Tells the user that the local folder must not be shared with iCloud / Dropbox / Syncthing because manual sync still writes to it even when auto-sync is off. |
| Others | Sign commits with DCO | Slider toggle. | When on, Jolli-driven commit / amend / squash operations append a `Signed-off-by` trailer. |
| Others | Exclude Patterns | Plain text input. | Comma-separated list of glob patterns; hides matching files from the Changes panel and AI commits. |

### Local-agent card

Rendered instead of the Anthropic / Jolli cards when the provider dropdown is on the local-agent option. It holds one control and one hint, and nothing else: a label reading `Agent tool`, its dropdown, and the hint line

> `Uses your local agent's own login (subscription/BYOK). Sign in with that tool's CLI if prompted.`

**Each option's visible label is distinct from the identifier persisted for it.** The dropdown's options are built by walking the tool registry, taking each entry's identifier as the option value and its display label as the option text. These routinely differ: the option a user reads as **`Cursor`** persists the identifier **`cursor-agent`**. Nothing in this form ever shows an identifier, and nothing downstream renders one — the same registry maps the stored identifier back to the label wherever the active tool is displayed.

Because the card collects no credential, selecting this provider is the one choice that cannot fail this form's validation for a missing key: neither the Anthropic key-prefix rule nor the Jolli origin rule applies to it.

### Memory Bank state line

A single read-only line on the Memory Bank tab, immediately beneath the Folder Path input and its Browse control: a severity icon glyph followed by one line of text. Four rules govern it:

1. **It is not an echo of the folder input above it.** The two differ routinely, for two independent reasons the configured path literally cannot express: the resolved per-repository subdirectory can carry a numeric suffix the user never chose, and the write boundary can refuse this workspace outright — in which case folder writes silently do not happen at all and the configured path is still displayed above, unchanged and misleading.
2. **It ships collapsed in the panel's initial markup**, so it can never flash a stale verdict before the host answers.
3. **A missing verdict, or one whose text is empty, leaves it hidden** rather than revealing an empty coloured strip — so an older host that sends nothing for this field degrades to "no line" instead of a blank badge.
4. **Its text is injected as plain text, never as markup**, because the payload routinely carries an absolute filesystem path. Long paths wrap inside the line rather than widening the panel.

An unrecognized severity value is coerced to the neutral one. The state model, the three severities, the icon glyphs, and every verbatim text string are owned by **Memory Bank Write Boundary and Effective-State Reporting** (300) — this form is one of that spec's three reporting surfaces and adds no wording of its own.

### Save target

A single per-user config file at the per-user jollimemory configuration location. There is no workspace-scoped variant, no folder-scoped fallback, and no precedence chain — the only place the form reads from and writes to is the per-user file. The save merges fields onto the existing file rather than replacing it wholesale, and absent fields (e.g. the model field while the user has "sonnet" selected) are written as undefined to elide the default.

### API-key masking

A key with a known prefix (`sk-ant-` or `sk-jol-`) is always displayed as the prefix plus `****` plus the last 4 characters, regardless of total length. A key without a known prefix is masked only when longer than 16 characters; shorter keys are shown verbatim. Empty keys render as the empty string.

### Inline validation rules

| Field | Rule applied on every input event |
| --- | --- |
| Anthropic API Key | If non-empty and not the masked sentinel, must start with `sk-ant-` and be at least 20 characters. |
| Jolli API Key | If non-empty and not the masked sentinel, must shape-decode as a `sk-jol-` token whose payload encodes a `u` URL whose origin passes the host allowlist. |
| Max Tokens | If non-empty, must parse as a positive integer. |
| Integrations (nine toggles, collectively) | At least one must be checked. |

The Jolli-API-key validation runs in the webview's own script context (an inline port of the canonical validator) so the user gets a red error label as they type. The same validation runs again on the host side at save time and is authoritative.

### Origin allowlist for the Jolli API Key

The key's payload encodes a URL via base64url-decoded segments. The URL is accepted only if:

- Scheme is HTTPS.
- Hostname matches one of `jolli.ai`, `jolli.dev`, `jolli.cloud`, `jolli-local.me` exactly, or is a sub-domain of one (suffix-boundary check, not substring).

Any deviation rejects with the inline error: `Origin <u> is not on the Jolli allowlist (only *.jolli.ai, *.jolli.dev, *.jolli.cloud, *.jolli-local.me).`. Shape failures emit the dedicated message: `Key cannot be decoded. Paste the key exactly as issued by Jolli.`.

### Apply Changes button

Disabled unless the form is dirty AND has no inline errors. A click runs a final inline validation pass (catches programmatic mutations that bypassed input events) and, if anything is wrong, shows a persistent red feedback string ("Please fix the highlighted fields before saving") at the action bar without sending the message. A clean click sends an `applySettings` message with the field values plus the masked sentinel pair so the host can resolve "the user did not change this key" to the existing value on file.

### Outbound webview messages

| Command | Direction | Purpose |
| --- | --- | --- |
| `loadSettings` | Webview → host | Sent on load. Host responds with `settingsLoaded`. |
| `applySettings` | Webview → host | Sent on Apply. Carries the form values plus the masked sentinels. |
| `browseLocalFolder` | Webview → host | Opens the folder picker. Host responds with `setLocalFolder`. |
| `rebuildKnowledgeBase` | Webview → host | Triggers the migrate action. Host responds with `rebuildKnowledgeBaseDone`. |
| `confirmDirtyMigrate` | Webview → host | Sent when the user clicks Migrate while the form is dirty; host opens a confirm dialog before proceeding. |
| `signIn` | Webview → host | Starts the OAuth sign-in flow via the shared auth service. The card re-renders to the signed-in sub-state on success; the Jolli API key is auto-filled. |
| `signOut` | Webview → host | Clears the persisted Jolli credentials. The card re-renders to the signed-out sub-state. |
| `syncNow` | Webview → host | Triggers an on-demand sync round via the sync engine (cross-ref spec 174). The host owns the in-flight guard; the button stays clickable but a second invocation while one is mid-round is dropped. |
| `settingsLoaded` | Host → webview | Initial population. Also carries the Memory Bank effective-state verdict (severity + text) computed by the host from the configuration it just loaded plus the workspace root. |
| `setLocalFolder` | Host → webview | Picker result. |
| `rebuildKnowledgeBaseDone` | Host → webview | Carries `success` and `message`. |
| `settingsSaved` | Host → webview | Save succeeded. Webview shows a 2-second green feedback. **Also carries a freshly recomputed Memory Bank verdict**, which the webview re-renders the state line from. |
| `settingsError` | Host → webview | Save failed. Webview shows a persistent red feedback that clears only when the user edits a field. |
| `authStateChanged` | Host → webview | Pushed by the auth service whenever sign-in / sign-out lands; the webview re-renders provider and sync cards without a full settings reload. |

### Save-time validation

Before any disk write, the host re-runs the Jolli-API-key validation. A failure emits `settingsError` with the specific message; nothing is persisted, no hook is touched.

### Hook-sync side effect on save

After Jolli-API-key validation passes, the host enumerates every worktree of the repository and installs or removes the Claude and Gemini hooks per the Claude and Gemini toggle states. A failure on any worktree is collected; when the loop ends, if any failure occurred, the host throws with a single concatenated message naming each failure. Any throw aborts the save before the config is written.

**The whole step is skipped in full while the repository is manually disabled** — installs *and* removals, before the worktrees are even enumerated. Installs would silently override the opt-out; removals are unnecessary because disabling already uninstalled the hooks. This panel deliberately stays reachable while disabled (it is the sign-in and Memory Bank entry point), so the skip is what keeps opening it and pressing Apply from re-arming capture. Two consequences: a save can no longer be aborted by a hook-sync failure in that state (there is nothing left in the step that can throw), and the machine-global writes still run normally — the configuration file is written and a global-instructions transition still installs or removes the managed instruction block. See **Zero-Write Contract for a Manually-Disabled Repository** (304), which owns the boundary between the suppressed repo-local writes and the deliberately-unsuppressed machine-global ones.

## Behavior

### Opening the panel

1. If a panel already exists, reveal it in the active editor column (and update the post-save callback if a new one was passed). Return.
2. Otherwise create the panel in the active editor column with the singleton entry pointing at it. The title is "Jolli Memory Settings". The view-type is `jollimemory.settings`.
3. Generate a per-render nonce; build the HTML with a CSP that gates inline styles and scripts on that nonce; set the panel's HTML.
4. Install dispose and message handlers. The dispose handler clears the singleton entry.
5. The webview, on load, sends `loadSettings`.

### Initial load (`loadSettings`)

1. Read the per-user config file.
2. Cache the full Anthropic and Jolli keys (used later to detect "the masked sentinel was returned unchanged").
3. Compute the masked forms.
4. Send `settingsLoaded` with the masked keys, the model alias (defaulting to "sonnet"), the max-tokens value (or null), the nine integration toggle states (defaults true), the agent-tool identifier (defaulting to the registry's default tool), the local-folder path (or empty), the Memory Bank effective-state verdict, and the comma-joined exclude patterns. The verdict is derived through the read-only peek path, so merely opening this panel cannot materialize the folder it reports on.
5. If the cached full Jolli key is non-empty, run validation. On failure, send `settingsError` with `<message> (the key currently on disk is invalid — paste a new one and click Apply)`. This surfaces invalid-but-saved keys at open time so the user does not learn about the problem only when trying to save.

### Save (`applySettings`)

1. Resolve each masked sentinel: if the form's value still equals the sentinel the host last sent, replace it with the cached full key; otherwise treat the form's value as the new key.
2. If the resolved Jolli key is non-empty, run validation. On failure, send `settingsError` with the validator's message and abort.
3. Parse the comma-separated exclude patterns into an array, trimming and dropping empties.
4. Build the partial-config payload: every form field maps to either its value or `undefined` (so defaults elide).
5. Resolve the repository root and run the hook sync — enumerate worktrees, install / remove Claude and Gemini hooks per the toggles, collect failures, throw a single error if any occurred. **Skipped entirely while the repository is manually disabled** (see "Hook-sync side effect on save").
6. Save the partial config to the per-user file.
7. Update the cached full keys to the resolved values.
8. Recompute the Memory Bank effective state and send `settingsSaved` carrying the freshly rendered verdict. The recomputation pairs the folder value **just persisted** with the storage mode read from the configuration loaded at the top of the save — the mode has no editing surface in this panel, so there is nothing newer to read it from. Invoke the post-save callback if one is registered.

### Browse local folder

1. Webview sends `browseLocalFolder`.
2. Host opens a folder picker labelled "Select folder for Push to Local". Select-folders only.
3. On selection, send `setLocalFolder` with the absolute path. The webview writes the path to the read-only field and re-evaluates the dirty state.

### Migrate to Memory Bank

1. Webview disables the button and sets the status text to "Rebuilding…" (the host-side migrate action can be long-running).
2. Webview sends `rebuildKnowledgeBase`.
3. Host invokes the migrate command and awaits its result.
4. Host sends `rebuildKnowledgeBaseDone` with `success` and a `message`.
5. Webview re-enables the button and replaces the status text with `Rebuild complete: <message>` or `Rebuild failed: <message>`.

### Dirty tracking and Apply Changes gating

1. After a fresh load, the webview captures the initial state of every field.
2. Every input or change event re-evaluates dirty (any field differs from its initial state) and re-runs inline validation.
3. The Apply Changes button is enabled only when both dirty is true AND no inline error is present.
4. After a successful save, the initial state is recaptured (so the form starts clean from the new values).

### Save feedback

- Green "Settings saved" toast at the action bar, fading out after 2 seconds.
- Persistent red banner with the validator's message on save failure, cleared only when the user next edits any field.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Closed | User invokes "Open Settings" | Loading |
| Loading | `loadSettings` round-trips | Clean |
| Clean | Any field input | Validating |
| Validating | Form is dirty AND has no errors | Dirty |
| Validating | Form is clean (all fields match initial state) | Clean |
| Validating | Form has errors | Dirty-with-errors |
| Dirty | User clicks Apply Changes | Saving |
| Dirty-with-errors | User clicks Apply Changes | Dirty-with-errors (red feedback shown) |
| Saving | `settingsSaved` from host | Clean (initial state recaptured; green feedback shown briefly) |
| Saving | `settingsError` from host | Dirty (red banner shown) |
| Clean | User triggers Browse / Migrate | Clean (button-local feedback only) |

The browse and migrate buttons run in parallel with the dirty-tracking machine; their outcomes do not change form-level cleanliness except that Browse mutates the local-folder field and therefore re-enters Validating.

## Notable Behavior

- **There is no per-workspace setting.** Settings are a per-user concept. A user with multiple workspaces sees and edits the same configuration regardless of which workspace had the panel open. This avoids the "but it works in my other repo" surprise that per-workspace API keys cause. (Surprising; intentional.)
- **Masking is "always on for known prefixes; only-when-long for unknown prefixes".** A short `sk-ant-…` is masked even though only the prefix is meaningful; a 12-character random string is not, because the user might be looking at a non-secret. The asymmetry is intentional — secrets get blanket coverage; opaque non-prefix values default to readable. (Surprising; intentional.)
- **The masked value is its own sentinel.** Sending the masked string back unchanged is how the webview signals "do not change the key on file". The host compares to the sentinel it sent, not to the current on-file value, so a partially-edited masked string (e.g. the user pastes a new key that happens to start the same way) is correctly treated as a real change. (Notable.)
- **Inline Jolli-API-key validation duplicates the canonical validator.** The webview runs in a pure browser context with no Node imports, so the validator is reimplemented as the webview's inline script. The host-side check at save time is authoritative — the webview check is for live red-text feedback. Both must stay in lock-step with the canonical implementation; a drift is a bug. (Notable.)
- **No "show / reveal" toggle on key fields.** The plain-text inputs stay masked (because the masked sentinel is the displayed value); the user reveals a key by replacing it with a new one. The form does not offer a toggle to flip an input between password and text mode. (Surprising; reality.)
- **Hook syncing runs across every worktree of the repository.** Toggling Claude on while three worktrees exist installs the hook in all three. A failure on any worktree throws a concatenated message and aborts the save before the config is written, so the on-disk state cannot disagree with the toggle state — except while the repository is manually disabled, where the step does not run at all. (Surprising; intentional.)
- **Rejecting a bad save means rejecting the hook sync too.** Hook syncing happens before the config write but after Jolli-API-key validation. If the hook sync fails, the throw bubbles up before any config change is persisted, and the webview shows the concatenated failure message via the persistent error banner. (Notable.)
- **Open-time validation surfaces a saved-but-invalid key.** If the user typed a valid Jolli URL into the API key, then later moved the deployment off the allowlist, the next time they open Settings they see a red banner about the on-disk key without having to click Save. (Surprising; intentional.)
- **The "at least one integration enabled" check happens client-side.** The host does not re-run this rule — the webview is the only enforcer, because all nine toggles being off is not a "destructive" save, just a "the product won't do anything useful for you" save. The check is to prevent accidental footgun, not enforce an invariant. (Notable.)
- **The Memory Bank verdict is sent twice per panel session, and the second time is the point.** It rides `settingsLoaded` on open, and it rides the save acknowledgement as well — because changing the configured folder can flip the write boundary in **either** direction (pointing it inside the working tree starts refusing; pointing it back out resumes), and the save acknowledgement is the only host-to-webview message a save produces. Without the second send, the line would keep asserting the pre-save verdict until the panel was closed and reopened. (Notable.)
- **The agent-tool dropdown is generated, so this form does not know the tool list.** Its options are derived from the tool registry rather than written out here, which is also why the visible label and the persisted identifier can diverge (`Cursor` → `cursor-agent`) without this form having to translate between them. A newly-supported tool appears in the dropdown with no edit to this form and no new option text to agree on. (Notable.)
- **Choosing the local-agent provider saves with no credential at all.** That card collects nothing, so neither the Anthropic prefix rule nor the Jolli origin rule can reject it — the credential is the agent tool's own login, established outside this product. (Notable.)
- **Applying settings while the repository is manually disabled writes the configuration but touches no hooks.** The hook-sync step returns before enumerating worktrees, in both directions. So the toggle states persist and take effect the moment the repository is re-enabled, and in the meantime the on-disk hook state deliberately disagrees with the toggle state — the opposite of the invariant the hook sync normally maintains. (Surprising; intentional. See 304.)
- **Default elision is intentional.** Saving "sonnet" as the model alias writes `undefined` to the field, not the literal string. The motivation is so a future change to the default propagates automatically to anyone who never picked an explicit value. The same applies to empty max-tokens, empty local folder, and an empty exclude list. (Notable.)
- **Migrate button is disabled while running.** The webview disables the button immediately on click, sets a "Rebuilding…" status, and only re-enables it when the host responds. The host's migrate action can take noticeable time on large repos; multiple in-flight migrations would corrupt the orphan-branch indirection. (Notable.)
- **The persistent error banner clears on the next field edit.** Unlike the green save-feedback, which fades on a timer, the red error stays until the user makes any change — telling the user "I see this is wrong; I am editing now" is enough to dismiss it without an explicit close button. (Notable.)
- **The panel is a singleton.** The user cannot have two settings panels open at once; opening "Settings" while one is open reveals the existing panel rather than creating a duplicate. (Notable.)
- **CSP nonce is per-render.** Every full HTML rebuild generates a new nonce and embeds it on every inline `<style>` and `<script>`. The Settings panel only ever rebuilds its HTML once (on construction), so this is effectively per-instance, but the mechanism is identical to the Summary panel's. (Notable.)

## Shared Behavior

- **Per-user config file** — the same file the rest of the product reads (LLM credentials, push action mode, integration toggles).
- **Origin allowlist** — the canonical validator behind this form is shared with the CLI, the IntelliJ plugin, and the inline copy in the settings webview's script. All three implementations must agree.
- **Hook installer** — the toggle-driven sync runs the same per-integration installer the CLI uses.
- **Worktree enumeration** — the same primitive that the standalone install command uses; settings save broadcasts the toggle state to every worktree.
- **Migrate to Memory Bank command** — the rebuild button delegates entirely to the standalone command; the webview only owns the button's enabled/disabled and feedback states.
- **Post-save callback** — registered by the caller that opened the panel, used to refresh status bar and tree views once a save lands.
- **Memory Bank sync engine** — the Sync Now button, the auto-sync toggle, the poll-interval input, and the include-transcripts toggle are the user-facing controls for the sync engine; the engine itself, the round lifecycle, the conflict / offline / failed states, and the personal-space lock semantics are owned by spec 174.
- **Shared auth service** — sign-in / sign-out / `authStateChanged` are owned by the auth service shared with the sidebar onboarding panel; this webview is one of two surfaces the service drives.
- **Memory Bank effective state (spec 300)** — owns the write-boundary decision, the three-armed state, the severity vocabulary, the shared wording table, and the read-only peek guarantee. This form renders that verdict and adds no wording of its own.
- **Local-agent tool registry** — the single source for each supported tool's identifier and display label, shared with the status surfaces that name the active tool; this form only projects it into a dropdown.
- **Manual-disable opt-out (spec 304)** — owns the durable opt-out and the inventory of writes suppressed while it is set, including this form's hook-sync skip and the carve-out that leaves the machine-global configuration and instruction writes running.
