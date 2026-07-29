# 290. Claude Plugin Session Bootstrap

## Topic Statement

The single action the embedded assistant plugin's manifest registers is a per-session reconciler: at every session start it snapshots the project's current installation state, brings the project-local front-door skill and then the product's full repository-facing installation to canonical form under short-budget locks, and returns a structured session-start payload asking the assistant to reload its skill definitions and/or presenting the branch briefing — while never failing, never blocking, and never overriding a project the user deliberately disabled.

## Scope

**In scope:**

- The trigger and the input the host supplies.
- The bail conditions that produce no output at all, including which detection channel the nested-generation guard consults.
- The two pre-mutation snapshots taken before anything is written, and what each is later used to decide.
- The first lock-guarded phase (front-door skill, legacy-skill sweep, exclude entry, disable check, first-session metadata) and its behaviour when the project is disabled.
- The un-locked reconciliation step between the two phases, and why it is outside both.
- The second lock-guarded phase (default-provider seeding and session context composition) and the rule that suppresses the briefing.
- The structured output contract and when nothing is emitted.
- The failure discipline: what is swallowed, what is warned, what is deferred, and why the process always reports success.

**Out of scope (boundaries):**

- The plugin *package* — its marketplace entry, manifest, bundle assertions, publish pipeline, command and skill inventory, and the build-time guard that keeps this action the only registered hook. Covered by the plugin-package topic, which owns "the manifest registers exactly one session-start action pointing here" and delegates everything below to this topic.
- What the narrowed repository-hook installation mode actually installs, its own locks, and its own failure messages — covered by the hook-installation-orchestration topic. This topic covers only that the bootstrap calls it, with which options, and what it does with the outcome.
- The composition of the session-start briefing text and of the plugin-specific reminders, and the semantics of the default generation provider being seeded — those belong to the session-start briefing topic. This topic owns only *whether* the briefing is requested.
- The content of the bare unnamespaced front-door menu skill — its own topic. This topic owns only the byte-comparison used to detect that it changed, and the reload signal that follows.
- The durable per-project "leave this project alone" preference itself (where it lives, how it is written, its lock) — its own topic.
- Every other session-lifecycle behaviour of the product (session recording at agent stop, transcript discovery, reference extraction). The bootstrap deliberately does none of it beyond the one first-session metadata write described below.

## Data Contracts

### Trigger

The host's session-start event, with no matcher declared, so the action fires on **every** session start the host reports — a fresh session, a resumed session, a session continued after context compaction. It is not a first-run hook, and nothing about its behaviour is gated on being the first session.

No asynchrony flag is declared, so the host waits for the action to finish, which is what makes its structured output usable for that session.

### Input

The host supplies, on standard input, a payload naming:

- the project directory the session is running in,
- the session's identifier,
- the location of the session's transcript.

Every field is optional in practice. Empty or unparseable input is treated as an empty payload. When the project directory is absent, the process's own working directory is used instead.

### Pre-state snapshot

Two observations are taken **before any mutation**, and both are used later to make decisions that would be wrong if taken afterwards:

1. **Front-door canonicality** — whether the project's bare unnamespaced menu skill is byte-identical to the canonical template this plugin ships.
2. **Agent-hook health** — the per-event health of the product's canonical session-stop and session-start hook entries in the project's assistant settings, each judged by the strict canonical rule the hook-installation topic defines.

### Output

Either nothing at all, or one object addressed to the session-start event carrying one or both of:

- a request that the assistant **reload its skill definitions** for the current session;
- **additional context** text to inject into the session.

When neither applies, nothing is written to standard output. The process's exit status is always success, regardless of what happened.

## Behavior

### Entry and bail conditions

1. If the bootstrap detects it is running as a child of a local-agent generation invocation — that is, the product itself invoked the assistant to generate a memory, and that nested session is now firing its own session-start event — it logs and returns with **no output**. Without this guard, memory generation would recursively bootstrap. The check runs before the input payload is read, so nothing is parsed and no working-tree root is resolved on this path.

   This site consults the **inherited-environment channel only**; it passes no working directory and therefore never consults the working-directory marker. The environment is the reliable channel here because the bootstrap is launched by the assistant CLI the product itself spawned — the product's own direct child, carrying the environment the product set — so the marker is always inherited. The marker-file channel exists for the one entry point launched by a *host* rather than by the product's own child, where the host's environment policy can strip the marker. Both channels, and why the marker-file probe is opt-in per call site rather than always on, are owned by the local-agent provider-backend topic.
2. The input payload is read and parsed; anything unusable becomes an empty payload.
3. The project directory must be inside a git repository, and the repository's working-tree root must be resolvable. If either check fails, the bootstrap returns with **no output** and writes nothing. The resolved working-tree root — not the directory the host reported — is the target for everything that follows, and is also where diagnostics are logged.

### Phase one: front door, sweeps, and the disable decision

This phase runs inside the repository hook-lifecycle lock, requested with a deliberately **short** wait budget (a fraction of a second) rather than the default one.

Inside the lock, in order:

1. **Write the bare unnamespaced front-door menu skill** into the project. Only the bare umbrella is written here — none of the plugin's namespaced skills, which the plugin already ships itself. An existing file that does not carry the product's ownership marker is left untouched, so a user's own skill under that name is never clobbered.
2. **Sweep the legacy assistant-scoped skill directories** — earlier releases' per-assistant skill folders and the retired ones — deleting only those that carry the product's ownership marker and leaving user-owned files in place.
3. **Add the front-door skill's path to the repository's local-exclude list as a union**, merging one entry into whatever is already there. This is deliberately *not* the replace-the-managed-block behaviour a full install uses: the bootstrap contributes one path and must not rewrite the rest of the block.
4. **Read the durable "leave this project alone" preference.**
5. **If the project is disabled: tear the installation down, preserving the front door.** Every product hook is removed — both assistant session hooks, the repository-scoped MCP registration, and all five git hooks — while the bare front-door skill and its exclude entry are kept. The teardown is told that the repository lock is already held so it does not try to take it again. The phase then ends.

   This runs **every session**, not once. A user who disabled the project and then re-enables the product from some other surface will have it torn out again at their next session start, which is the intended reading of a durable opt-out. Keeping the front door is what makes that state recoverable: the user can still invoke the menu and re-enable from inside the assistant.
6. **Otherwise, record the session's metadata** — but only when the assistant integration is not explicitly disabled in configuration *and* both a session identifier and a transcript location were supplied. The write is to the project's session registry and is **metadata only**: no transcript reading, no plan or reference discovery pass, none of the work the product's own session-stop hook performs. A failure here is warned about, not thrown.

   This exists so that the very first session in a freshly-installed project is recorded even though the product's own canonical hooks are not installed yet at that moment. From the second session onward the canonical hooks own this, and the bootstrap's write is redundant but harmless.

### When the first phase cannot take the lock

If the short budget expires, **nothing in phase one runs**, and the bootstrap does not fall back to running it unlocked. It logs the deferral and then re-observes the front-door skill: if it was not canonical at entry but is canonical now, a concurrent peer wrote it during the wait, and the reload request is emitted on that basis alone. No installation and no session context are produced. The next session start retries from scratch.

### Deriving the reload request

The reload request is emitted when, and only when, the front-door skill was **not** canonical at entry and **is** canonical now. It is derived from that before/after observation, not from any installer's return value — which is what makes it correct whether this bootstrap wrote the file or a concurrent peer did.

If the project is disabled, the bootstrap returns here with the reload request as its only possible content.

### Between the phases: repository-hook reconciliation

With the phase-one lock **released**, the bootstrap calls the product's shared environment-setup orchestrator in its narrowed repository-hooks-only mode, marked automatic, tagged with this plugin's source identity, and asking it to **respect** the durable disable preference. Because the lock was released first, the orchestrator acquires it itself — the locks are not re-entrant, so overlapping the two would deadlock the bootstrap against itself.

This is the step that installs the product's canonical session-stop and session-start hook entries into the project's assistant settings, through the same dispatch indirection every other install surface uses. It is why the plugin manifest carries no business hooks of its own.

A failure is warned about and ends the bootstrap, which returns with the reload request as its only possible content. The session is never failed over an installation problem.

### Phase two: provider seeding and session context

This phase takes the repository hook-lifecycle lock a second time, again with the short budget.

Inside the lock, in order:

1. Re-read the durable disable preference and stop if it is now set — a peer may have disabled the project while the reconciliation was running.
2. Re-load configuration and stop if the assistant integration is now explicitly disabled.
3. **Seed this embedding's default generation provider**, but only when no provider has been chosen yet. An existing choice — including an explicit one the user made — is never overwritten, and a failure to persist the seed is swallowed.
4. **Compose the session context** for this embedding. The plugin-specific reminders (the not-signed-in reminder and the authentication-failure reminder) are always requested here; each remains internally gated on actually running inside this embedding.

   The **branch briefing is requested only when the canonical hook pair was not already healthy at the snapshot taken at entry** — that is, both the session-stop and the session-start entry were in strict canonical form before this session did anything. This is the anti-double-emission rule: once the canonical session-start hook is installed and healthy, *it* owns the briefing, and the bootstrap must not emit a second copy in the same session. The briefing therefore appears from the bootstrap only on a first session in a project, or on a session that found a broken installation and repaired it.

   Because the decision uses the **entry** snapshot rather than a fresh reading, the very session in which the reconciliation installs the hooks still gets its briefing from the bootstrap — the freshly installed hook did not run for this session.

If the second lock acquisition times out, the bootstrap logs the deferral and produces no session context. The reload request, if any, is still emitted.

### Assembling the output

The output object is emitted only if at least one of its two elements is present. When neither the reload request nor session context was produced, nothing is written to standard output at all — an ordinary, healthy, steady-state session therefore produces silence from the bootstrap.

### Failure discipline

- Any error escaping the whole bootstrap is logged at an informational level and swallowed.
- The process reports success **even on a fatal error**. A plugin whose session-start action failed would degrade the user's session for a reason the user cannot act on, so the bootstrap is unconditionally fail-open.
- Lock contention is not an error: it is a deferral to the next session start.
- The only two failures that end the bootstrap early with partial output are a phase-one lock miss and a reconciliation failure; both still emit the reload request when it was earned.

## State Transitions

Per project, across successive session starts:

1. **Fresh install** — no front door, no canonical hooks. The bootstrap writes the front door (so it emits the reload request), records the first session's metadata itself, installs the canonical hooks, and emits the briefing because the hooks were unhealthy at entry.
2. **Steady state** — front door canonical, both canonical hooks healthy. The bootstrap rewrites nothing, emits no reload request, and suppresses the briefing (the installed session-start hook emits it). Output is empty; the canonical hooks own session recording.
3. **Repaired install** — the front door and/or a canonical hook was removed or edited externally. The reconciliation restores it; the reload request is emitted if the front door changed, and the briefing is emitted because the pair was unhealthy at entry. The next session returns to steady state.
4. **Disabled project** — the durable preference is set. Every session tears the installation out again, keeps the front door, and produces at most the reload request. No context, no session recording, no reconciliation.
5. **Contended session** — a lock could not be taken inside the short budget. Nothing was installed and no context produced; the state is unchanged and the next session start retries. If a peer wrote the front door during the wait, the reload request is still emitted.
6. **Not a repository / nested generation session** — no output, no writes, no state.

## Notable Behavior

- **Every session, not first-run.** The bootstrap is a reconciler, not an installer. Its correctness argument is that running it a thousand times is indistinguishable from running it once in a healthy project, and that any drift it finds is repaired on the next session start without a user gesture.
- **Two snapshots, taken before anything is written.** Both decisions the bootstrap makes — whether to ask for a skill reload, and whether to emit the briefing — depend on state that the bootstrap itself is about to change. Sampling after the fact would suppress the reload signal it just earned and duplicate the briefing it just made redundant.
- **The two lock phases are separate on purpose, and the installer sits between them.** The reconciliation must acquire the same lock itself, so the bootstrap releases it in between rather than passing a "already held" signal through. The cost is a small window in which a peer can interleave, which is exactly why both phases re-read the disable preference.
- **The disabled path preserves the menu.** A teardown that removed the front door too would leave a disabled project with no in-assistant way back, since the plugin's own commands are namespaced and the ecosystem requires a bare entry point for the front door.
- **Short lock budgets are a deferral mechanism.** The bootstrap runs on the user's critical path at session start, so it asks for a fraction of the normal wait budget and accepts losing. Because the lock is strict, losing means doing nothing rather than doing something unlocked.
- **Automatic mode means "respect the user's opt-out".** The bootstrap is the caller of the narrowed install mode that asks for the durable disable preference to be honoured and never cleared. The explicitly user-run setup command asks for the opposite. The mode itself is neutral; the choice belongs to the caller, and the two callers choose oppositely on purpose.
- **The first-session metadata write is deliberately minimal.** It records that a session exists and where its transcript is, and nothing else. Doing the product's session-stop work here would duplicate it from the second session onward and would put transcript reading on the session-start critical path.
- **The nested-generation guard is environment-only, and is evaluated before anything is read.** It is the very first check, ahead of the payload read and the repository resolution, so a nested generation session costs one log line and nothing else. It deliberately consults only the inherited environment and not the working-directory marker, for two reasons that hold specifically here: the bootstrap is launched by the assistant CLI the product itself spawned, so the environment always carries the marker, and keeping the marker-file probe opt-in per call site means the guard cannot be flipped by unrelated stubbing of filesystem checks.
- **Fail-open, including on a fatal.** The exit status is success unconditionally. This is the strongest instance of the product's general rule that hooks must never degrade the tool they are embedded in.

## Shared Behavior

- **The plugin package** owns the manifest registration that launches this bootstrap and the build-time guard that keeps it the only registered hook; it delegates all behaviour here.
- **Hook installation orchestration** owns the narrowed repository-hooks-only mode this bootstrap invokes, the options it passes, and the teardown options (preserve-the-front-door, lock-already-held) the disabled path uses.
- **Claude Code hook installation** owns the strict per-event health contract this bootstrap samples, and is the installer the reconciliation reaches to write the canonical hook pair.
- **The session-start briefing topic** owns the composition of the briefing text, the plugin-specific reminders, and the default-provider seeding; this topic owns only whether the briefing is requested and the suppression rule that prevents a double emission.
- **The Claude session-recording topic** owns the session registry this bootstrap writes one metadata entry into, and owns every session from the second onward.
- **The lock primitive registry** owns the repository hook-lifecycle lock this bootstrap takes twice, its strict discipline, its shared-across-worktrees location, and the non-re-entrancy rule that forces the release between the two phases.
- **The bare unnamespaced menu skill topic** owns the file whose canonicality this bootstrap compares and whose installation triggers the reload request.
- **The durable manual-disable topic** owns the preference this bootstrap reads three times per session (once per phase plus the installer's own read).
- **The local-agent provider-backend topic** (spec 280) owns the re-entrancy guard this bootstrap evaluates first: the backend that marks its nested invocations, the two detection channels, which entry points opt into the working-directory channel and which stay environment-only, and the write-boundary backstop behind both. This topic records only that the bootstrap carries the guard and is one of the environment-only sites.
