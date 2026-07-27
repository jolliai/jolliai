# 286. Local-Agent Login-Expiry Remediation Guidance

## Topic Statement

When memory generation for a commit fails specifically because the locally-installed agent's login (used to generate summaries without a hosted sign-in) has expired, the product persists an empty placeholder summary marked as auth-expired and surfaces a single, consistent remediation message on two user-facing surfaces: inline right after the failing commit, and as a reminder at the start of the next agent session. Both surfaces share one authored copy so the guidance never drifts.

## Scope

**In scope:**
- The shared remediation copy: the two fix options offered and the clarifying note, and the two framing variants (post-commit inline vs. session-start reminder).
- The condition under which the background worker marks a stored summary as auth-expired.
- How the post-commit inline surface renders the guidance.
- How the session-start reminder surface decides to show the guidance and what governs it (newest-commit-only, branch handling, surface gating, self-clearing).

**Out of scope (boundaries):**
- How a local-login-expiry failure is classified during generation, and the local-agent provider backend itself (owned by the local-agent-provider topic).
- The unified summary-error marker written onto a failed summary and its other consumers (e.g. a webview banner).
- The post-commit capture-progress stream and watcher mechanics (owned by the capture-progress spec); this spec only defines the copy that surface prints.
- The session-start branch briefing and the general "not signed in" login reminder (separate session-start outputs).
- **Pre-commit configuration repair** — the interactive ladder that fixes an unusable local agent, or a provider/key mismatch, *before* anything has been generated (spec 291). The boundary is when the fault is caught: spec 291 repairs the configuration up front, on an interactive terminal, when nothing has failed yet; this spec covers what the product says *after* a real commit's generation has already failed on an expired local login. Neither surface invokes the other, and they never appear in the same moment.

## Data Contracts

### Shared remediation copy

A single authored block, reused verbatim by both surfaces, offering two fix paths:
1. Re-authenticate the local agent's CLI login.
2. Or switch the summary provider to a hosted key / the product's own hosted space.

It also carries a clarifying note that this local login is **separate** from the desktop application's login (the crux of the common confusion — the desktop app stays signed in on its own).

Two framing variants share the fix lines and the note:
- **Post-commit inline variant** — refers to "this commit," indented to sit inside the capture-progress block, and carries **no** self-clearing note (it is a one-shot line for the commit that just happened).
- **Session-start reminder variant** — refers to "a recent commit," is rendered as prose injected into the new session's context, and ends with a note that the message clears automatically once memory generation succeeds again.

### Auth-expired marker on a stored summary

When a commit's summary generation failed due to the local-login-expiry classification, the worker still stores a summary (an empty placeholder so the commit is not silently dropped) and includes an **auth-expired** signal on the stored-milestone event of the capture-progress stream. This is the signal the post-commit inline surface keys on.

## Behavior

### Post-commit inline surface

While tailing a commit's capture progress (see the capture-progress spec), when the `stored` milestone carries the auth-expired signal, the watcher prints the **inline variant** of the remediation copy instead of the success line — because the stored summary is a placeholder, not a real capture.

### Session-start reminder surface

At the start of a new agent session, on the agent-plugin surface only, the product decides whether to show the **reminder variant**:
1. If not on the agent-plugin surface, show nothing (other surfaces have their own failure UI).
2. Determine the current branch; if there is none (detached working tree), show nothing.
3. Load the summary index; find the newest root-level summary on the current branch.
4. If that newest commit's summary is an auth-expiry failure, emit the reminder variant; otherwise emit nothing.

Only the **newest** commit is checked — a later healthy commit means the login is working again, so there is nothing to remind about. Unlike the branch briefing, this reminder deliberately does **not** skip the common trunk branches (`main`/`master`/etc.): a broken local login fails generation on every branch, so a user who only ever commits on `main` must still be warned. This reminder is produced under the same hard wall-clock deadline as the other session-start outputs, and (when present) leads the session-start output ahead of the branch briefing.

## State Transitions

### Auth-expiry reminder (session-start, per branch)

- **Silent** → **Shown** when the newest root commit on the current branch is an auth-expiry failure.
- **Shown** → **Silent** automatically once a newer commit on that branch generates memory successfully (the newest-commit check flips), with no manual dismissal.

## Notable Behavior

- **One authored copy, two surfaces.** The fix options and the "separate from the desktop app" note live in one place so the inline line and the session-start reminder cannot drift apart; only the framing sentence and indentation differ.
- **An auth-expired summary is stored as a placeholder, not dropped.** Storing an empty marked summary keeps the commit visible in history and drives the surfacing, rather than silently losing the commit.
- **Newest-commit-only, self-clearing.** The session-start reminder checks just the newest commit, so a single later success makes it disappear with no user action.
- **Trunk branches are not exempt from this reminder.** A broken local login is machine-wide, so the reminder fires even on `main`/`master`, unlike the branch briefing which skips them.
- **Session-start reminder is agent-plugin-only.** Other surfaces surface generation failures through their own UI, so the reminder is gated to the agent-plugin surface.

## Shared Behavior

- The post-commit capture-progress stream and the watcher that renders the inline variant are defined by the capture-progress spec.
- The queue worker that stores the auth-expired placeholder summary and emits the stored milestone is defined by the Git Operation Queue Worker topic.
- The local-agent provider backend that produces the auth-expiry failure is defined by the local-agent-provider spec (280).
- The interactive pre-commit counterpart — repairing a broken local agent or a provider/key mismatch before any generation is attempted — is defined by spec 291. This spec is strictly post-failure remediation.
