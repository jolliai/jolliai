# 332. IntelliJ Enable / Disable Surface

## Topic Statement

How the JVM IDE surface turns memory capture on and off for one repository: the two gestures that drive it, the cached verdict and time-boxed protection window that let the enable gesture repaint before the work finishes, the roll-backs that undo that when it fails, the overlay collapse that must happen before the view routes away, and the one-way projection that folds a legacy machine-wide "paused" preference onto this repository's own opt-out.

## Scope

**In scope:**

- The two gestures — the disable action in the status overlay's header, and the enable button on the dedicated disabled card — and what each one calls.
- The deliberate asymmetry: enable flips the interface optimistically and rolls back; disable does not flip until the work has actually succeeded.
- The **two independent optimistic flips** on enable (one in the tool window, one in the project service) and each one's roll-back.
- The install-protection window: what it suppresses, why it is opened before the work rather than after, and why success **shortens** it.
- The cached verdict: where it is held, when it is refreshed, its two read modes, and the ordering rule that it is refreshed before the status probe.
- The two install flags that are **mutually exclusive**, which gesture sends which, and what sending both would mean.
- The overlay collapse performed before routing to the disabled card, and its second, listener-driven copy.
- The routing predicate for the disabled card, and the state it does **not** cover.
- The legacy machine-global paused-preference projection: its trigger, its tri-state gate, its one-way direction, and its fallback.
- What this surface deliberately does **not** write.

**Out of scope (boundaries):**

- The durable opt-out's own storage, three-field split, anchoring, migrations, locking, and read precedence — spec 145.
- The complete inventory of writes a disabled repository refuses, and the in-process mirror the editor host uses for its half of that — spec 304.
- The tool window's card frame, view switch, accordion, and title-bar strip — spec 118.
- The status overlay's header layout and its row list — spec 133.
- The install/teardown work itself: what the delegated enable writes and what the delegated disable removes — the install-orchestration topic and spec 128.
- The version stamp a successful delegated install writes, and the outcome set the delegation returns — specs 128 and 249.
- The settings dialog's own re-enable entry point and the onboarding card's setup paths.
- Which lifecycle events construct the service and schedule the automatic startup repair — spec 124.

## Data Contracts

### The cached verdict

A single volatile boolean per project service, **false until the first refresh completes**. It answers "does this repository carry the durable opt-out?" for every consumer inside the IDE process, so no consumer pays a bridge round trip to ask.

It is refreshed **first and unconditionally** at the top of every status refresh, ahead of the main status probe. That ordering is load-bearing: the probe can fail (the bridge is down, the runtime hiccups) and the refresh used to sit inside the same failure handling, so a probe failure silently skipped the opt-out read and left the automatic repair looking at a repository it believed was enabled.

Two read modes exist:

| Mode | Used by | Behavior |
| --- | --- | --- |
| Bridge-first | Every off-thread caller (the default) | Asks the runtime, falling back to reading the profile from disk on any transport failure **or on a reply carrying no usable verdict field**. |
| Disk-only | The service's own initialization, which runs synchronously on the interface thread | Reads the profile directly, and honours the legacy per-worktree marker. |

The disk-only mode exists because initialization already pays one cold bridge call for the status probe, and a second one on the interface thread would double that. It is sound rather than degraded for this particular question: the profile is written temp-file-then-rename, so a direct read can never observe a torn write, and what the gate downstream wants is exactly the on-disk truth.

### The install-protection window

A timestamp, per project service. While *now* is before it, two suppressions apply:

- The verdict refresh will not move the cache from **not-disabled to disabled**. The opposite direction always applies immediately.
- The status refresh will not move the reported state from **enabled to not-enabled**.

Both exist because writing the hooks directory raises repository-change events that momentarily read stale hook state, and because the durable opt-out is cleared by the delegated install at its very *end* — so a refresh landing mid-install reads a value that is true but about to stop being true.

### The routing predicate for the disabled card

The tool window routes to the dedicated disabled card only when the cached verdict is set **and** the user is *configured*. Configured means any one of: the local-agent provider is selected, an assistant API key is saved, that key's environment variable is set, or a product API key is saved.

**A repository that is disabled but not configured therefore does not get the disabled card** — it gets the onboarding card. Being disabled wins over being configured, but not over being unconfigured.

### The two install flags

An enable request carries **exactly one** of two flags, selected by a branch, so both can never be on the wire together:

| Flag | Meaning | Sent by |
| --- | --- | --- |
| *Respect the opt-out* | Refuse the whole install, writing nothing, if the repository carries the opt-out | The automatic startup repair — the only automatic install path on this surface |
| *Clear the opt-out on success* | A successful install wipes the durable opt-out | Every explicit user gesture: this surface's enable button, the onboarding paths, and the settings re-enable |

Sending both would ask the runtime to honour the opt-out and then erase it. That is contradictory on its face, and it was reachable: a stale cached verdict was enough to let an automatic install run against a disabled repository, and every such IDE start then wrote a no-op value into the profile file that this surface's own file watcher is watching, burning a refresh for nothing.

The explicit gestures must leave *respect* off, or the button becomes a silent no-op that reports success — which is exactly what the refusal outcome is designed to be.

## Behavior

### Disable

The gesture is an icon in the status overlay's header. Its tooltip — which names the consequence, that hooks are removed and the sidebar will show a card to turn it back on — **is the only warning: there is no confirmation dialog.**

1. The whole sequence runs off the interface thread.
2. **Guard.** If neither a resolved repository root nor a project base path is available, log a warning, show an error notification titled for a failed disable, and abort.
3. Run the surface's teardown, which delegates the **full** disable — front-door menu preserved, durable opt-out persisted.
4. **On failure:** log the recorded error and show an error notification whose body names it and states plainly that **nothing was changed**. Then return. **No interface flip happens at all** — the view stays on the enabled card.
5. **On success**, back on the interface thread: set the tool window's own disabled mirror, **collapse the status overlay**, then re-route the view. Only then record a usage event tagged with a trigger naming this button.

**Disable has no optimistic flip, deliberately.** The durable opt-out is written by the teardown *before* any hook is removed, so the surface has nothing of its own to persist and nothing to undo; the flip fires only when the whole transaction returned success. The cost is the half-second-to-two-second wait before the view changes, accepted in exchange for eliminating a second write of the same fact from this surface.

**This surface issues no profile write on either gesture.** The opt-out is set by the teardown and cleared by the install; the only place this surface writes it at all is the legacy projection below.

### Enable

The gesture is a button on the disabled card. The card itself is stateless — it renders and reports the click; all sequencing lives in the tool window. There is no confirmation.

**Two independent optimistic flips fire before any work starts.**

*In the tool window:* the local disabled mirror is cleared and the view re-routed immediately, so the sidebar appears at once. Its roll-back is a failure callback that sets the mirror back and re-routes.

*In the project service:* the previous cached verdict is remembered, the cache is cleared, and the protection window is opened — **before** the install work, not after. Both halves are needed for the same reason: the delegated install clears the durable opt-out at its *end*, so a status refresh firing mid-install would read the still-set flag, keep the cache set, and — through the tool window's listener, which compares the service's answer against its own mirror — undo the flip the user just saw.

Then:

1. If no working directory can be resolved, log a warning and invoke the failure callback. **No notification is shown on this branch** — the roll-back is silent. (Notable.)
2. Initialize the service if it has not been initialized.
3. Run the install with *respect the opt-out* left **off**, so the click lifts the opt-out rather than being refused by it.
4. **On failure:** show an error notification titled for a failed enable and pointing at the logs, then invoke the failure callback. The service independently restores the previous cached verdict and **releases the protection window**, so a genuine disable arriving from elsewhere is not held off and the follow-up refresh re-reads disk immediately.
5. **On success:** re-base the protection window to **3 s measured from now**, kick a status refresh off as fire-and-forget, and record a usage event tagged with a trigger naming the disabled card. Nothing repaints — the view was already flipped.

**Success normally shortens the window rather than extending it.** The pre-install ceiling is **10 s**, generous because a cold runtime extraction can spike; a normal install returns in half a second to two seconds, so re-basing to 3 s from that point lands earlier than the original ceiling. Once the install has actually returned, holding the cache against reality for the remainder buys nothing and only delays a real disable arriving from another surface. The re-base is unconditional, so an install slower than seven seconds would extend the window instead — the shortening is the normal case, not an invariant.

**The refusal outcome is deliberately kept out of the error state.** When an install comes back refused-because-disabled, the service records *no* error, because the recorded error is what the tool window paints in red — telling someone who deliberately turned the product off that something broke. The install still reports failure, because nothing was written. That branch is unreachable from this button, which never asks the runtime to respect the opt-out; it belongs to the automatic startup repair.

### Collapsing the overlay before routing

The status overlay lives above the entire normal sidebar layout as its own card, and the card that carries it survives underneath the disabled card. So an overlay left open would still be open when the user clicks Enable — and the click would land the user back on the status page instead of the sidebar.

It is collapsed in **two** places, and the second is not redundant:

- **Inline, in the disable success callback**, before re-routing. This is the path the header's own button takes, and doing it inline means it does not wait for the asynchronous refresh.
- **In the status-card synchronisation step**, which collapses the overlay and returns whenever the cached verdict is set. This is deliberately *not* a plain early return: it is what covers every route into the disabled state that this surface did not initiate — a disable typed in a terminal, a disable performed in another window, or the settings dialog auto-disabling after the last credential is removed.

The same synchronisation step is what force-shows the overlay whenever the status probe reports **not enabled** (and hides it again on recovery) — but only on the not-disabled arm, since the disabled arm collapses and returns before that check. Switching the view switch also collapses it.

### The legacy paused-preference projection

A machine-global configuration file carries a legacy boolean meaning "paused". It predates the per-repository opt-out and has no user-facing control any more.

The projection runs **once per service initialization**, and only under all three of the following:

1. The machine-global paused preference is set.
2. A repository root is resolvable.
3. **This repository's own authored decision is undecided** — read through the tri-state probe, which reports *disabled* / *not disabled* / *no decision recorded*, rather than through the plain boolean read.

When all three hold, the repository's own opt-out is written as set, and the cached verdict is set to match.

Four properties are load-bearing:

- **The direction is one-way.** The machine-global preference is read; the per-repository opt-out is written. Nothing anywhere writes the machine-global preference *from* a disable or an enable.
- **The machine-global preference is never cleared.** The mapping is not injective — one machine-wide flag stands for every repository on the machine — so clearing it on behalf of one repository would silently un-pause all the others.
- **The tri-state gate is what makes an explicit re-enable stick.** A plain boolean read collapses "the user re-enabled this repository" and "no decision has been recorded" into the same answer, so the projection would fire again on every restart and undo the re-enable forever. The tri-state probe is also the reason this one read goes to the profile directly rather than over the bridge: the bridge's read has already collapsed exactly that distinction. It reads the authored field first and the derived composite only as the pre-split migration fallback, so a repository carrying only the structural marker is never mistaken for one the user paused.
- **The whole block is gated on the paused preference being set first**, and that gate is what keeps the tri-state probe off the interface-thread initialization path. The probe forks a subprocess to locate the profile and then reads it; the machine-global preference is unset for every user who never touched the retired control, so gating on it means those users pay nothing. Skipping the probe cannot change the outcome, because the downstream condition is false anyway once the preference is unset.

**If the projection's write throws**, a separate derived condition (paused is set *and* this repository is still undecided) still suppresses the automatic startup repair for that session, so a failed projection degrades to "install nothing" rather than to "install against the user's pause".

The machine-global preference is otherwise only *cleared* by unrelated onboarding paths — completing local-agent setup, saving an assistant key, or signing in — and round-tripped unchanged by the settings save. Neither gesture in this spec touches it.

## State Transitions

The tool window's mirror and the service's cached verdict, for one repository:

| From | Event | Tool-window mirror | Service cache | View |
| --- | --- | --- | --- | --- |
| Enabled | Disable clicked, teardown fails | unchanged | unchanged | unchanged (error notification) |
| Enabled | Disable clicked, teardown succeeds | set | picked up by the follow-up refresh | overlay collapsed, then disabled card |
| Disabled | Enable clicked | cleared **immediately** | cleared immediately; protection window opened | sidebar, immediately |
| Disabled | …install then fails | rolled back to set | rolled back; protection window released | back to the disabled card (error notification) |
| Disabled | …no working directory resolvable | rolled back to set | untouched | back to the disabled card, **silently** |
| Disabled | …install succeeds | stays cleared | stays cleared; window re-based shorter | stays on the sidebar |
| Any | A disable performed in a terminal or another window | updated from the service on the next status fire | refreshed from disk or bridge | overlay collapsed, then disabled card |
| Undecided, machine paused | Service initialization | set | set | disabled card (if configured) |
| Decided either way, machine paused | Service initialization | unchanged | unchanged | unchanged — the projection does not fire |

## Notable Behavior

- **Enable is optimistic and disable is not, and both choices are deliberate.** Enable repaints first and rolls back on failure, because the durable clear happens at the *end* of the install and the user should not watch a spinner for it. Disable waits for success, because the durable write happens at the *start* of the teardown and this surface would otherwise be writing the same fact twice. (Notable.)
- **There are two optimistic flips, not one, and they protect against different things.** The tool window's mirror is what the user sees; the service's cached verdict is what a mid-install refresh would otherwise read and use to undo that. Rolling back only one of them would leave the two disagreeing.
- **Success normally shortens the protection window.** The 10 s pre-install ceiling has to cover a cold runtime extraction, but once the install has returned, holding the cache against reality for the remainder only delays a genuine disable arriving from somewhere else — hence the unconditional re-base to 3 s from that moment, which shortens the window for every install faster than seven seconds and lengthens it for one slower.
- **The verdict refresh runs ahead of the status probe, and that ordering is the fix for a real defect.** With the read inside the probe's failure handling, any bridge hiccup skipped it and silently left repositories reading as not-disabled to the automatic repair.
- **A reply that carries no usable verdict falls through to disk, exactly like a thrown transport error.** Reading an absence of an answer as "not disabled" would hand the automatic repair — which asks for the opt-out to be cleared on success — a green light to un-disable the repository.
- **The two install flags are mutually exclusive and exactly one is always sent.** The branch that selects them is the enforcement; nothing rejects the combination downstream. An explicit gesture that sent *respect* would turn its own button into a no-op that reports success.
- **Neither gesture has a confirmation dialog.** Disable's tooltip is the only warning, and it performs a full teardown of every hook.
- **The header icons that carry these gestures are not gated on the mouse button.** The interface dispatches a click event for secondary and middle buttons too, so a right-click on the disable glyph runs the entire uninstall transaction, and a right-click on the sign-out glyph signs the user out. The row list one layer down inside the same overlay *is* gated for precisely this reason (spec 133); the fix was never applied to the header. (Surprising; reality.)
- **One enable failure branch is completely silent.** When no working directory can be resolved, the view rolls back to the disabled card with no notification of any kind, so the button appears to do nothing. Every other failure branch shows one. (Surprising; observable gap.)
- **The overlay collapse exists twice, and the second copy is not belt-and-braces for the first.** The inline collapse covers this surface's own button; the synchronisation step covers every disable that arrives from outside this window. Without the second, a terminal-side disable would route to the disabled card with the status page still stacked underneath it.
- **The disabled card is gated on being configured as well as disabled.** A user who disabled the repository and then removed every credential does not see the disabled card at all — they see onboarding, with no visible statement that the repository is opted out. (Notable.)
- **The legacy paused projection is one-way and permanent in one direction only.** It reads a machine-wide preference and writes a per-repository opt-out; it never writes the machine-wide preference and never clears it, because one flag stands for every repository on the machine.
- **The tri-state read is what stops the projection from being an infinite loop.** Collapsing "no decision recorded" into "not disabled" would re-project on every single IDE start and permanently defeat an explicit re-enable. It is also why this one read bypasses the bridge, whose answer has already lost the distinction.
- **A refusal is never rendered as an error.** The service explicitly declines to record it, because the recorded error is painted in red — and reporting a fault to a user who deliberately turned the product off is the wrong message. It still counts as a failed install, because nothing was written.
- **This surface writes the durable opt-out in exactly one place, and it is not either gesture.** Both gestures let the delegated install and teardown own that write; the only direct write is the legacy projection.

## Shared Behavior

- **The durable opt-out (145)** — owns the profile file, the three-field split, the main-worktree anchoring, the read precedence including the tri-state probe this spec consumes, the migrations, and the locking. This spec owns only the gestures, the cache, and the projection.
- **The zero-write contract (304)** — owns everything a disabled repository refuses, including the runtime's own bridge-level write refusals that cover a server this surface already had running before the disable.
- **Delegated hook installation (128)** — owns the request each gesture ultimately sends, the runtime directory injected into it, and the stamp a successful install writes.
- **The delegated run's outcome set (249)** — owns the refusal outcome this spec keeps out of the error state, and the fact that it stamps nothing and warns about nothing.
- **The tool window frame (118)** — owns the card routing this spec's flips drive, the title-bar strip, and the overlay's placement above the whole normal layout.
- **The status overlay (133)** — owns the header that carries the disable action, the row list beneath it, and the primary-button gate the header itself lacks.
- **The project service lifecycle (124)** — owns service initialization (where the projection runs), the listener fan-out the status refresh drives, and the automatic startup repair that is the sole sender of the *respect the opt-out* flag.
- **The install-orchestration topic** — owns the ordering guarantee this surface depends on: the teardown persists the opt-out before removing anything, and the install clears it only after everything is written.
