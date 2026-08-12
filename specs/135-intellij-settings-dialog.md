# 135. IntelliJ Settings Dialog

## Topic Statement

The IntelliJ plugin's own modal settings dialog — a tabbed form over the machine-global configuration whose OK button is a multi-step, partly-blocking apply — plus the IDE-native preferences page that is now nothing but a stateless bridge to it.

## Scope

**In scope:**

- The IDE-native preferences page: what it renders, and the fact that it holds, compares and persists nothing.
- Every way the dialog is opened.
- Each tab and every control on it, including which controls are only a place to hold a value that is round-tripped untouched.
- The card-switching that swaps one region of two tabs between mutually exclusive states.
- The full validation set, what each rule blocks, and which controls are validated by nothing.
- The local-agent tool picker: the two-tier list, the availability probe, its threading, its stale-reply and same-tool guards, its three rendered states, and the two separate places it can refuse a save.
- The classification of an out-of-date command-line surface, which is done by matching a substring of a propagated error message.
- The apply sequence in execution order — the part that runs before the dialog closes and the ordered background task that runs after.
- Every error and status surface the dialog can produce, and precisely what does and does not block the apply.
- The one migration action that is not part of the apply at all.
- Where this surface diverges from the desktop-editor settings panel.

**Out of scope (boundaries):**

- The configuration file's own format, its merge semantics and the transport that reads and writes it.
- The install / uninstall lifecycle the apply invokes, the manual-disable state it consults, and the status surface that owns the disable affordance.
- The Memory Bank migration engine, the folder-layout resolver and the historical-backfill runner — the dialog only starts them.
- The per-repository outbound push store's own persistence and its corrupt-store recovery; the dialog reads and writes one flag through it and relays what it reports.
- The sign-in flow and the token/key issuance behind it.
- The tool catalogue the picker mirrors, and the availability probe's own detection rules.
- The desktop editor's settings panel (spec 110).

## Data Contracts

### The IDE-native preferences page

Registered as a project-level page under the IDE's tools group. It renders exactly two things: a paragraph saying that settings live in the tool window and pointing at both this page's button and the tool window's gear, and a single button that opens the real dialog.

It is a **stateless bridge**:

- It reports itself as never modified, so the preferences window's own OK and Apply buttons stay inert for this page.
- Its apply is an explicit no-op.
- It does not override reset at all.

Nothing on this page holds a value, so there is nothing to compare and nothing to persist.

### Ways in

Four construction sites exist: this page's button, the tool window's title-bar gear, a button on the historical-backfill surface, and a standalone action class that is **registered nowhere and referenced by nothing** — dead, and carrying a description of sections that do not exist on either surface.

### Tabs

Five, in this order: **AI Agents**, **AI Summary**, **Sync to Jolli**, **Memory Bank**, **Others**. Each tab's content is top-anchored rather than stretched.

The selected tab index is remembered in a **process-global** field — it survives closing and re-opening the dialog, is shared across every project in the IDE session, and is not persisted to disk. The "settings opened" event recorded on every open reports a **hard-coded tab name** regardless of which tab actually restores.

### Agent-source toggles (AI Agents tab)

Ten checkboxes, each labelled with the product name plus a one-line description of how that product's sessions are found. In render order: Claude Code, Codex, Gemini, OpenCode, Cursor IDE, Devin, GitHub Copilot, Cline, Antigravity, Kimi Code.

Every one loads as "on unless the stored value is explicitly false", so an absent value renders checked. Every one is written back verbatim as a boolean.

A separate eleventh checkbox on the same tab, under its own heading, controls whether the product's skills are advertised in the user's global agent-instruction files. It is **not** one of the source toggles, and it is backed by a **tri-state** value rather than a boolean: enabled, explicitly disabled, or undecided. Both "explicitly disabled" and "undecided" render unchecked.

### AI Summary tab

Above a card region: a **provider** picker with three choices — a direct-to-vendor provider, the product's own hosted proxy, and a local agent CLI. Its initial value is the stored provider, or, when nothing is stored, the proxy if the user is signed in and the direct provider otherwise.

The card region shows exactly one of five states:

| Card | Shown when | Contents |
| --- | --- | --- |
| Direct vendor | Provider is the direct vendor | An empty-key warning strip (live-updated as the user types, and additionally satisfied by an environment variable), a masked API-key field, a three-choice model picker, and a maximum-output-tokens field |
| Proxy, healthy | Provider is the proxy and a proxy key is on disk | A confirmation line naming the tenant site when the key decodes one |
| Proxy, key missing | Provider is the proxy, signed in, no key on disk | A warning plus a sign-out-and-re-login button |
| Proxy, signed out | Provider is the proxy, not signed in | A prompt plus a sign-in button |
| Local agent | Provider is the local agent | A tool picker and a status line — **and no key field at all** |

Below the card region, outside it, sits an **Advanced** disclosure holding a proxy-API-key field. Its visibility is not cosmetic — see the apply sequence.

The model picker persists the chosen alias, except that the middle (default) choice is persisted as **absent** rather than as its own name. The API-key field is shown **masked**; on read-back, a value still equal to the mask it was shown is replaced by the real stored key, so leaving the field alone never destroys the key.

### Sync to Jolli tab

An upper card region with three states — signed out, signed in but no key, and signed in with a key — each carrying the corresponding sign-in, re-login or sign-out button, and the no-key state carrying its **own** Advanced disclosure with a second proxy-API-key field.

Below a separator, a per-repository outbound-push checkbox with an explanatory line. **It starts disabled** and is enabled only when an asynchronous read of the current state lands successfully.

### Memory Bank tab

A freely-typeable folder path with a browse button (blank materialises the default at apply time), a two-choice sort-order picker, a migrate button, an include-transcripts checkbox, and — under its own heading — a button that generates memories for past commits that have none.

Two further values live conceptually on this tab and have **no control at all**: an auto-sync flag and a poll interval. They are held as plain values rather than as unparented widgets, deliberately — an unparented widget still looks live to every reader of the surrounding code and silently rots. Both are loaded verbatim and written back verbatim.

### Others tab

An exclude-patterns text field (comma-separated, split and trimmed on save, written as absent when empty), a commit sign-off checkbox, a telemetry checkbox that defaults on, and a link to the telemetry documentation.

### There is no pause control

The dialog renders **no pause or disable checkbox**. The stored paused value is never read to populate anything and never edited; the apply reads it from disk **solely so it can be written straight back**. Disabling is now driven by the repository's own manual-disable state, surfaced on the status header and its disabled card, not here.

### One setting was dropped, not moved

A messaging-workspace origin used by one reference source has a field on neither this surface nor the desktop editor's. It survives every apply untouched, because the apply copies the loaded configuration and never names it, and it remains settable only from the command line.

## Behavior

### On open

Set the title and rename the OK button to "Apply Changes"; record the open event; build the tabs; populate every field from a fresh read of the configuration; start the asynchronous push-control read; refresh the tool picker; and subscribe to sign-in changes so the proxy fields and both card regions re-evaluate when authentication changes underneath the dialog.

### The local-agent tool picker

**Two tiers.** The picker's model is built synchronously from a **hand-maintained baseline list** compiled into the plugin, and the saved selection is applied against that baseline **before** any asynchronous work — so a saved non-default tool never briefly renders as forgotten while a slow fetch is in flight. A background fetch of the authoritative list then replaces both the model and the parallel identifier list, re-applies the same selection, and, when the provider is already the local agent, fires an explicit probe (because re-assigning the same index is a no-op for the change listener).

**Any failure of that fetch degrades to the full baseline, never to a single entry** — a transport error, an unparseable reply, a missing collection, or a collection that parses to nothing all yield the baseline. Individual malformed rows are dropped silently.

The list carries a per-tool login hint that this surface **never renders**.

**The probe.** Selecting the local-agent provider, changing the tool while that provider is selected, or the fetch landing while it is selected each fire an availability probe.

1. **Same-tool coalescing**: a probe is skipped when the tool it would ask about is the one already in flight *or* the one that already has a verdict. A different tool always re-probes. Without this, opening the dialog on a saved local-agent configuration fired the same probe two or three times within milliseconds, each potentially a cold runtime start.
2. The working directory is resolved **before any UI change**, so a project with no path cannot leave the status line stuck on "checking".
3. The tool is pinned, the verdict is cleared, the in-flight flag is set, the status line reads "Checking…" in the default colour, and validation is re-run so the new state does not inherit a stale message.
4. The question is asked **on a background pool, never the UI thread** — the fast path is a few tens of milliseconds against a long-lived process, but the cold fallback can exceed the IDE's slow-UI-thread threshold.
5. The reply is dropped entirely if the dialog has been closed, or if the pinned tool no longer matches — the **stale-reply guard**.
6. The verdict is written **before** the in-flight flag is cleared. Both fields are volatile, and the waiter polls the flag first and then reads the verdict, so reversing those two writes would open a window where a reader sees a settled probe and a stale verdict.

**Three rendered states, from a tri-state verdict:**

| Verdict | Status line | Blocks apply? |
| --- | --- | --- |
| In flight | "Checking…", default colour | No, but the OK path waits |
| Confirmed usable, **or** no evidence | A single blank space, default colour | No |
| Confirmed unavailable | A red line naming the tool and telling the user to install it or pick another | Yes |

Collapsing "confirmed usable" and "no evidence" onto the same blank line is deliberate: painting red for "we could not find out" would be a factual claim the dialog cannot support.

**Old-CLI classification is a substring match on a propagated error message.** When the probe's request fails, the failure is classified by testing the exception's message for two literal phrases:

- The phrase the command-line surface emits for an unrecognised request name → treated as **no evidence** (permissive), logged at informational level. The reasoning is that the probe request shipped in the same change as this caller, so a user on an older globally-installed command-line surface that outranks the plugin's own bundle reaches this path — and telling them the tool is "not found on this machine" would misdirect them, since the tool may be perfectly installed and the older surface simply cannot answer.
- The phrase emitted for an unrecognised tool identifier → also **no evidence**, but logged at error level with the exception, because it means this surface's hand-maintained baseline has run ahead of the command-line surface's catalogue. That is a caller defect worth shouting about, but it is not a fact about the user's machine, so it stays permissive.
- Anything else → **confirmed unavailable**, logged as a warning, preserving the "unknown means not usable" contract.

A cancellation exception is re-thrown rather than swallowed, per the platform's contract.

### Validation

The validator returns at most one message; every message is anchored to a control, which disables the OK button. In evaluation order:

1. **Provider-scoped**, three mutually exclusive branches: a direct-vendor key that was actually retyped and does not carry the vendor's prefix is rejected (a field still showing its mask is exempt); selecting the proxy while signed out is rejected; selecting the local agent while the verdict is **confirmed unavailable** is rejected.
2. **Maximum output tokens**, when non-blank, must parse as a positive integer.
3. **At least one agent source must remain checked.**

**The at-least-one guard covers all ten source toggles.** Each of the ten is named in the test individually, including the most recently added source. The skill-preference checkbox is deliberately excluded, because it is a preference and not a source.

**Nothing else is validated.** There is no check on the folder path's existence or writability, none on the sort order, none on the exclude patterns' syntax, none on the push checkbox, none on the sign-off or telemetry toggles — and, notably, **no format check at all on either proxy-API-key field**, even though the direct-vendor key gets one.

### The apply — before the dialog closes

1. **The local-agent gate.** When the provider is the local agent and the verdict is still "no evidence", the OK path enters a **bounded, cancellable wait**. If that wait does not settle, the dialog **stays open**, a red line reads that the tool could not be verified and that nothing was saved, and **not one write happens**. If the wait settles on "confirmed unavailable", the dialog likewise stays open and nothing is written.

   The wait itself has two permissive fast paths: no valid tool selection, and **no probe actually in flight**. Both return immediately, because the "no evidence" verdict has three sources and two of them — the probe never fired, and the probe landed on permissive-unknown — leave nothing to wait for, so waiting could only ever burn the whole budget and strand the user. The wait **does not launch a probe**; the already-running background task's reply pumps while the modal progress is up. Its budget is deliberately the same as the desktop editor's equivalent hold, and its poll interval is a fixed short tick.

2. Map the provider label to its stored value.
3. Resolve the direct-vendor key through the mask rule — **always**, even when another provider is selected, so switching back later does not find the key gone.
4. Parse the token limit and the exclude patterns; materialise the folder path's default when blank.
5. **Read the configuration from disk** (this happens **twice in a row**, with no write in between).
6. **Gate the proxy key on the Advanced disclosures' visibility.** A hidden disclosure's field still holds the value that populated it, so a hidden panel's contents are read as empty. When either disclosure is visible, the **Sync tab's field wins** over the AI Summary tab's, and a resulting blank value counts as an explicit clear only when a key was previously stored.
7. **Write the main configuration** as a copy of what was just read, with several fields deliberately force-cleared because a later write restores them: the direct-vendor key, the provider, the tool identifier, the tool path override and the sign-off flag. The paused value is copied through untouched, as are the two invisible sync values.
8. **Write the shared provider block** — provider, key and **the selected tool identifier, on every apply regardless of which provider is selected**. The tool path override is never touched here.
9. **Write the sign-off flag** as a narrow partial update rather than a whole-object write, so a concurrent writer from another surface is not clobbered.
10. **Re-read and write the telemetry flag**, then start or shut down telemetry to match, and record a provider-selection event.
11. If the proxy key was explicitly cleared, sign out — **after** every write. Running the sign-out concurrently with the save produced two nondeterministic defects, because both perform a read-modify-write on the same file: users staying signed in when clearing the key, and a stale snapshot clobbering just-saved folder, model and sync settings.
12. Compute whether credentials now exist and whether they existed before, under **one shared rule** mirroring how the summary path resolves a credential source, so an unchanged "still has credentials" apply is a no-op.
13. Snapshot everything the background task needs — the project path, the folder override, the push-control state and whether its read had landed, the two hook-relevant toggles and their prior values, and the resolved skill-preference decision — so nothing reads a UI control off the UI thread.
14. **Close the dialog.**

The skill-preference decision is resolved as a tri-state: checked becomes enabled; unchecked becomes explicitly disabled **only when it was previously enabled**; otherwise it is left alone — so merely opening the dialog never silently opts a fresh user out.

All four of the writes above happen **on the UI thread**, each a round trip through the command-line surface.

### The apply — the ordered background task

One non-cancellable, indeterminate background task, so that the enable/disable step and the migration cannot race.

**Step 1 — enable or disable by credentials.** No credentials → uninstall and record a disable event. Credentials present where they previously were not → initialize if needed, install, and record an enable event. Note the asymmetry: the **disable arm is unconditional** on credential-lessness, while the enable arm fires only on the transition. The install performed here deliberately clears the user's manual opt-out.

**Step 2 — Memory Bank initialization and migration.** Resolve the repository identity and the folder root, initialize the folder, then start the migration **fire-and-forget on a background thread, with no completion callback of any kind**. Nothing is awaited and nothing is re-attached afterwards: the reads that would have needed re-pointing now resolve the folder per call, so the stale-attachment failure mode that once required a re-attach no longer exists. The configuration was persisted before this step, so the migration reads the fresh folder value.

**Step 2b — agent hook synchronisation.** Gated on **three** conditions, all required:

1. A project path exists.
2. This same apply did **not** take step 1's disable arm. The predicate mirrors that arm *exactly* — credential-lessness, unconditional — and not the narrower credential-removal transition, because step 1 disables on every credential-less apply including one where credentials were already absent, and gating on the transition let precisely that case fall through to the balloon this gate exists to prevent.
3. **An agent-toggle transition occurred** — specifically, the Claude or the Gemini toggle changed value. The other eight source toggles never reach here, because those sources are discovered by scanning rather than by a hook.

That third gate is the fix for a real defect: without it, *any* apply in a manually-disabled repository fired the re-enable balloon, indistinguishable from a save failure and lobbying the user to undo the opt-out they had just set. Hook drift on unrelated saves is already healed at every window open.

When it runs, it brings **every worktree** into sync in one request, and the reply is validated fail-loud on all three of its fields — a missing or wrongly-typed field throws, because a missing disabled flag collapsing to false would suppress the balloon invisibly. Three outcomes:

| Outcome | Surface |
| --- | --- |
| The repository is manually disabled | An **informational** balloon: the toggles were saved, but the hooks will not install until the user re-enables — **carrying a single-use "re-enable" action** that initializes and installs off the UI thread and records an enable event tagged to this notification |
| One or more per-worktree operations failed | A **warning** balloon naming the failure count and listing each failure as an *integration-at-worktree* pair with its message, and warning that session tracking may not activate until the next apply or IDE restart |
| The request itself threw | A **warning** balloon saying settings were saved but the on-disk hook state was not updated, naming the error, and pointing at re-applying or restarting so the startup self-heal can retry |

The first two are mutually exclusive — a manually-disabled reply suppresses any failure balloon. Nothing here re-throws, so the startup recovery path stays open. All three balloons are posted directly from the background thread.

**Step 2c — skill-preference propagation.** Fires **only on an actual transition** — a fresh decision exists *and* it differs from what was stored. It persists the tri-state value and then runs an integrations-only enable, which reads the just-persisted value, never prompts, treats "undecided" as a no-op and heals stale blocks on "disabled". Gating this on a transition is what avoids paying a cold runtime spawn on every apply; registration and skill drift are healed separately at startup.

Its failure is caught into an **entirely empty handler** — the only fully silent failure in the whole apply — and the operation's own result value, which distinguishes "no runtime available, cleanly skipped" from success, is discarded.

**Step 2d — the outbound-push flag.** Three gates: the asynchronous read must have landed, the value must actually have changed, and a project path must exist. Only-when-changed is what stops a plain re-save from re-triggering the re-enable drain. Two things it surfaces that the older behaviour swallowed:

- If the reply says the store was **unreadable and rebuilt**, a warning balloon explains that every *other* repository's opt-out was reset to on and that they must be re-applied, naming where the unreadable file was preserved when the reply says.
- If the request fails, a warning balloon says the setting was not saved and will be re-read next time — because the dialog has already closed, so a silent swallow would leave the user believing the toggle saved.

**Step 3** — refresh the status surface once, after everything has settled.

### The push-control read

Fired at open. With no working directory it sets an explanatory tooltip and does no asynchronous work at all, leaving the checkbox permanently disabled. Otherwise it reads on a background thread and lands in one of three states:

| Landing | Result |
| --- | --- |
| The reply reports a store-level error | Checkbox stays disabled and unloaded; tooltip explains the machine-wide setting is unreadable and names the repair command |
| The reply is malformed or the request threw | Checkbox stays disabled and unloaded; tooltip says to reopen settings to retry |
| A boolean landed | Value cached, marked loaded, checkbox set and enabled, tooltip cleared |

The fail-closed orientation is load-bearing. The previous behaviour defaulted to "push enabled" *and* marked the state loaded, which both mis-reported an actually-disabled repository as syncing and made the toggle **un-writable** — the apply only writes when the new value differs from the cached one, and a checked box against a cached "not disabled" never differs. The repair tooltip deliberately names the neutral repair path and never the enable path, because enabling is the one direction that rebuilds an unreadable store from empty and drops every other repository's opt-out.

### The migrate button

Entirely separate from the apply. It disables itself and relabels, then, on a background thread under the migration lock: bail with an informational dialog if there is no existing storage; **archive every existing folder for this repository including the canonical base slot**, so the migration lands back on the base name instead of climbing to a suffixed one; re-resolve and initialize; run the migration with a long timeout; and report the outcome in a modal dialog — a completion message naming the migrated count and the root, an error dialog naming the finished status and the processed proportion, or an error dialog naming the exception. The button is always restored in a finally. There is deliberately no progress indicator; the result dialog is the feedback.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Closed | Any of the three live entry points | Open on the process-global remembered tab, fields populated, push read in flight |
| Local-agent verdict absent | Provider or tool selected | Probe in flight, status "Checking…", OK path will wait |
| Probe in flight | Reply for the pinned tool | Verdict written, then flag cleared; status blank or red; validation re-run |
| Probe in flight | Reply for a different tool, or dialog closed | Reply discarded entirely |
| Probe in flight | OK pressed | Bounded cancellable modal wait |
| Bounded wait | Settles usable or permissive | Apply proceeds |
| Bounded wait | Budget exhausted or user cancels | **Nothing written**, dialog stays open, red "nothing was saved" line |
| Verdict confirmed unavailable | OK pressed | **Nothing written**, dialog stays open |
| Any | Validation message present | OK disabled |
| Open | OK with all gates passed | Four writes on the UI thread, dialog closes, ordered background task runs |

## Notable Behavior

- **The IDE-native preferences page persists nothing and can never be modified.** It reports itself unmodified, its apply is an explicit no-op, and it does not implement reset. It is one paragraph and one button. (Notable — earlier shapes of this page carried an editable form.)
- **There is no pause control anywhere in the dialog, and the stored paused value is read only to be written back.** It is never rendered and never edited. Disabling moved to the repository's own manual-disable state, surfaced on the status header. (Notable — every table row and branch about "just unchecked pause" describes a control that no longer exists.)
- **The dialog probes local-agent availability, and the probe is not cosmetic.** It runs off the UI thread, drops replies for a tool the user has moved off, coalesces repeat probes for the same tool, renders a distinct checking state, disables OK on a confirmed-unavailable verdict, and holds the OK path behind a bounded cancellable wait that refuses to persist anything on watchdog or cancel. (Notable — an earlier description of this dialog as probe-free was wrong in every particular.)
- **Two of the three "no evidence" cases leave nothing to wait for, and the waiter knows it.** A probe that never fired and a probe that landed permissive both leave the in-flight flag clear, so the wait returns immediately rather than burning its whole budget. (Notable.)
- **An out-of-date command-line surface is recognised by matching a substring of a propagated error message.** Rewording that error on the producing side silently reclassifies "old surface, be permissive" into "confirmed not found on this machine" — turning a save that should succeed into a disabled OK button with a factually wrong red line. Nothing enforces the match. (Surprising; brittle cross-language string coupling.)
- **The verdict must be written before the in-flight flag is cleared.** Both are volatile and the waiter reads the flag first, so reversing the two writes opens a window where a settled probe is paired with a stale verdict. (Notable.)
- **The at-least-one-source guard is complete: it names all ten source toggles individually, including the most recently added one.** (Notable — a suspicion that the newest source was omitted does not hold at this revision.)
- **Neither proxy-API-key field is format-validated, while the direct-vendor key is.** The desktop editor renders per-field error slots for exactly that check. (Surprising; asymmetric.)
- **A hidden Advanced disclosure makes its field read as empty at save time, and the two disclosures are not equals.** When either is open, the Sync tab's field wins over the AI Summary tab's. A blank value counts as an explicit key-clear only when a key was previously stored — and that clear triggers a sign-out. (Notable; a visibility flag with persistence consequences.)
- **Migration is fire-and-forget with no completion callback at all.** Nothing is awaited, nothing is re-attached, and no reader is re-pointed afterwards — the reads that once needed re-pointing now resolve the folder per call, so the stale-attachment failure mode was retired rather than handled. (Notable — this is neither the blocking form nor the re-attaching form an earlier description assumed.)
- **Hook synchronisation is gated on a per-agent toggle transition and on this apply not having auto-disabled.** Without the transition gate, every unrelated save in a paused repository fired a balloon lobbying the user to undo their own opt-out. The disable gate mirrors the disable arm's predicate *exactly* rather than the narrower transition, because gating on the transition let a repeated credential-less save fall through to that same balloon. (Notable; both gates were bug fixes.)
- **Only two of the ten source toggles can ever trigger hook synchronisation.** The other eight are discovered by scanning and have no hook to install. (Notable.)
- **A manually-disabled reply suppresses the failure balloon.** The two outcomes are mutually exclusive branches, so a paused repository whose worktree operations also failed sees only the paused balloon. (Notable.)
- **The hook-sync reply is validated fail-loud on every field.** A missing disabled flag collapsing to false would suppress the re-enable balloon invisibly, which is exactly the failure the balloon exists to prevent. (Notable.)
- **The skill-preference propagation's failure handler is completely empty, and its result value is discarded.** It is the only fully silent failure in the whole apply, and it swallows the "no runtime available" answer along with everything else. (Surprising.)
- **The skill-preference decision is tri-state, and unchecking is an opt-out only from a previously-enabled state.** Merely opening the dialog and applying never moves an undecided user to explicitly disabled. (Notable.)
- **The tool identifier is written on every apply regardless of the selected provider**, so the picker's value persists even while another provider is in use. (Notable.)
- **The configuration is read from disk twice in a row with no write in between**, and four separate writes then happen on the UI thread, each a round trip. A fifth write happens later, off the UI thread, in the skill-preference step. (Notable.)
- **There is no dirty tracking.** OK is always live, so applying without changing anything still performs every write and runs the whole background task. The desktop editor disables its apply until something is dirty. (Notable.)
- **The push-control checkbox fails closed, and that is what makes it writable.** Defaulting to "enabled and loaded" both misreported a disabled repository and made the toggle a no-op, because the apply writes only on a difference. (Notable; the safe-looking default was the defect.)
- **The push-control repair tooltip deliberately names the neutral repair path and never the enable path**, because enabling rebuilds an unreadable store from empty and drops every other repository's opt-out. (Notable.)
- **Migration archives the canonical base slot too.** Without that, each migration would land on a new suffixed folder name instead of returning to the base. (Notable.)
- **A great many things do not block OK.** A failed push-control read, a failed hook sync, a failed migration, a failed skill-preference propagation, and a missing runtime all leave the apply successful from the user's point of view. Only a validation message and the two local-agent refusals stop it. (Notable.)
- **The remembered tab is process-global and the recorded open event names a fixed tab.** The remembered index is shared across every project in the session, and the telemetry never reflects which tab actually opened. (Notable.)
- **One entry point is dead.** A standalone action class exists, is registered nowhere, is referenced by nothing, and describes sections that exist on neither surface. (Unreachable.)
- **A per-tool login hint is fetched and parsed but never displayed here.** (Notable.)
- **The class's own description of itself is stale**, naming four tabs, omitting the sources tab entirely and calling the last tab by a name it no longer carries. (Notable.)

## Divergence from the desktop-editor settings panel

The two surfaces now agree on far more than they once did: the same five tabs in the same order, the same ten source toggles in the same order followed by the same skill-preference toggle, the same dialog title, and the same apply-button wording. What still differs:

- **Sort order is this surface only.** The desktop editor omits it deliberately. (Pause is now omitted from *both*, so the desktop editor's own note about omitting it is only half current.)
- **The telemetry checkbox and its documentation link are this surface only**, added for the plugin marketplace's own guidelines.
- **Outbound push scope.** This surface shows one checkbox for the current repository, applied at apply time. The desktop editor lists **every tracked repository on the machine**, each toggle applying immediately with no apply step.
- **The Memory Bank tab is much richer on the desktop editor**, which additionally carries a compile-exclude field, a state line, a sync-now button, a visible auto-sync group, and a live count of commits lacking a memory next to the generate button. This surface holds two of those values invisibly, and its generate button starts enabled rather than waiting on a count.
- **The folder field is freely typeable here and read-only-plus-browse there.**
- **The tool list is statically compiled in on the desktop editor** — which cannot fail, and cannot go stale relative to the running command-line surface either. This surface must mirror it by hand and treat the runtime fetch as an enhancement.
- **The apply hold is implemented differently but budgeted and worded identically** — a cancellable modal here, a timer there.
- **The desktop editor tracks dirtiness and chains follow-up actions onto an apply**; this surface does neither, and its migrate button is fully independent of the apply path.
- **Hook-sync failure is reported differently.** The desktop editor throws so its panel reports a failed save; this surface does not throw and posts a warning balloon naming the failed integration-and-worktree pairs.
- **The Advanced-disclosure mechanism has no counterpart on the desktop editor**, which renders its key fields unconditionally with per-field error slots.

## Shared Behavior

- **Configuration storage and its transport** — owns the file's shape, its merge semantics and the round trip every read and write here goes through.
- **Install / uninstall lifecycle and manual-disable state** — owns what the apply's first step does, and the opt-out its install deliberately clears.
- **Memory Bank migration engine and folder-layout resolver** — own the migration this dialog starts and the archiving the migrate button performs around it.
- **Historical-backfill runner** — owns what the generate button starts.
- **Per-repository outbound push store (spec 306)** — owns the flag, its machine-wide file, and the corrupt-store recovery this dialog relays.
- **The local-agent tool catalogue and the availability probe** — own the authoritative list this surface mirrors and the detection the probe performs. The mirror obligation is pinned by a test on this side.
- **Skill-preference propagation into global instruction files** — owns what the integrations-only enable actually writes and removes.
- **Sign-in flow** — owns the token and key issuance the proxy cards react to.
- **The desktop-editor settings panel (spec 110)** — the sibling surface over the same configuration.
