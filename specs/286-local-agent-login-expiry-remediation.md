# 286. Local-Agent Login-Expiry Remediation Guidance

## Topic Statement

When memory generation for a commit fails specifically because the configured local agent's login has expired or is unavailable, the product persists an empty placeholder summary marked as auth-expired and surfaces provider-aware remediation on two user-facing surfaces: inline right after the failing commit, and as a reminder at the start of the next Claude or Codex plugin session. Both variants are generated from the same tool metadata so Codex failures never instruct users to authenticate Claude (or vice versa).

## Scope

**In scope:**
- The host-aware remediation builder: tool label, tool-specific login command, hosted-provider alternative, and the two framing variants (post-commit inline vs. session-start reminder).
- The condition under which the background worker marks a stored summary as auth-expired.
- How the post-commit inline surface renders the guidance.
- How the session-start reminder surface decides to show the guidance and what governs it (newest-commit-only, branch handling, surface gating, self-clearing).

**Out of scope (boundaries):**
- How a local-login-expiry failure is classified during generation, and the local-agent provider backend itself (owned by the local-agent-provider topic).
- The unified summary-error marker written onto a failed summary and its other consumers (e.g. a webview banner).
- The post-commit capture-progress stream and watcher mechanics (owned by the capture-progress spec); this spec only defines the copy that surface prints.
- **Expiry is no longer the only non-success rendering of a stored summary.** A stored summary that is an empty placeholder for any *other* generation failure — exhausted credit, a server error, a timeout, an unparseable response — is rendered by a sibling branch that prints the failure's own reason instead. That branch, the ordering between the two, and the sanitizing the reason goes through are owned by the capture-progress spec; this spec covers only the branch that fires on the auth classification. The two are mutually exclusive at the source: the auth classification is the one case excluded from the reason-carrying field.
- The session-start branch briefing and the general "not signed in" login reminder (separate session-start outputs).
- **Pre-commit configuration repair** — the interactive ladder that fixes an unusable local agent, or a provider/key mismatch, *before* anything has been generated (spec 291). The boundary is when the fault is caught: spec 291 repairs the configuration up front, on an interactive terminal, when nothing has failed yet; this spec covers what the product says *after* a real commit's generation has already failed on an expired local login. Neither surface invokes the other, and they never appear in the same moment.

## Data Contracts

### Host-aware remediation copy

A single builder consumes the configured local-agent tool id (`claude-code`, `codex`, `cursor-agent`, `opencode`, or `kimi`) and derives its display label and login command from the central tool metadata table. It offers two fix paths:
1. Re-authenticate that exact local agent's CLI login, in that tool's own words — for one tool that is "run the CLI once and sign in to your subscription"; for the others it is a concrete login command (`codex login`, `cursor-agent login`, `opencode auth login`, `kimi login`). The line is the same sign-in hint the diagnostic command shows, so the two cannot drift.
2. Or switch the summary provider to a hosted key / the product's own hosted space.

It also carries a **separate-login clarification** naming that tool's own desktop application: the local CLI credential is independent of the app's, so the app stays signed in while the CLI's token goes stale. This is the crux of the reported confusion — without it, a user looking at a signed-in application reads "authentication expired" as simply false — and it is why the note must follow the tool rather than being authored once: pointing a Codex user at Claude's desktop app is the same class of error as giving them Claude's login command.

The note is **per-tool and optional**, sourced from the same metadata table as the label and login hint. It is present only where the separation is verified (`claude-code` → Claude Desktop, `codex` → the ChatGPT app) and absent otherwise: one supported tool ships no desktop application at all, and the remaining tools' application/CLI credential relationships are unconfirmed. An absent note drops the line entirely rather than substituting a generic one — asserting a separation that may not hold would send the user to check the wrong credential, which is worse than the two fix paths standing alone.

Not every supported tool can actually reach this remediation. **OpenCode and Kimi Code** produce no auth classification at all (see the local-agent-provider spec, 280), so their sign-in failures are stored under the generic generation-failure marker and render through the generic failure UI instead; the classification that triggers this remediation comes from Claude Code, Codex and Cursor, and from no other tool. The builder is nonetheless **total over the tool table** rather than restricted to those three: it renders correct copy for a tool that cannot currently trigger it, so a backend that later gains an auth classification needs no change here, and the copy for one tool can never be silently served to another.

Two framing variants share those generated fix lines and the note when present:
- **Post-commit inline variant** — refers to "this commit," indented to sit inside the capture-progress block, and carries **no** self-clearing note (it is a one-shot line for the commit that just happened).
- **Session-start reminder variant** — refers to "a recent commit," is rendered as prose injected into the new session's context, and ends with a note that the message clears automatically once memory generation succeeds again.

### Auth-expired marker on a stored summary

When a commit's summary generation failed due to the local-login-expiry classification, the worker still stores a summary (an empty placeholder so the commit is not silently dropped) and includes both an **auth-expired** signal and the resolved **local-agent tool id** on the stored-milestone event of the capture-progress stream. This is the data the post-commit inline surface keys on. A legacy event without a tool id falls back to Claude Code.

## Behavior

### Post-commit inline surface

While tailing a commit's capture progress (see the capture-progress spec), when the `stored` milestone carries the auth-expired signal, the watcher prints the **inline variant** of the remediation copy instead of the success line — because the stored summary is a placeholder, not a real capture. It is rendered for the tool identity carried **on the event**, not the currently-configured one, so the message names the backend that actually failed; an event written before that field existed falls back to the default tool.

This branch is checked **ahead of** the sibling branch that prints a raw failure reason, and that ordering is deliberate: the auth classification has already been narrowed to a specific fault with actionable fix steps, so the underlying message would be strictly less useful than this copy. The ordering itself, and the sibling branch, belong to the capture-progress spec.

One environment suppresses this copy rather than printing it: when the commit ran inside a sandbox denying network access, the backend could not have reached its authentication endpoint either, so the expiry classification is a symptom and this guidance would misdirect the user. The capture-progress spec owns that precedence and the notice printed in its place.

### Session-start reminder surface

At the start of a new agent session, on the Claude or Codex plugin surface only, the product decides whether to show the **reminder variant**:
1. If not on `claude-plugin` or `codex-plugin`, show nothing (other surfaces have their own failure UI).
2. Determine the current branch; if there is none (detached working tree), show nothing.
3. Load the summary index; find the newest root-level summary on the current branch.
4. If that newest commit's summary is an auth-expiry failure, load the current config, resolve `localAgentTool` (falling back to the plugin's own default tool), and emit the matching reminder variant; otherwise emit nothing.

Only the **newest** commit is checked — a later healthy commit means the login is working again, so there is nothing to remind about. Unlike the branch briefing, this reminder deliberately does **not** skip the common trunk branches (`main`/`master`/etc.): a broken local login fails generation on every branch, so a user who only ever commits on `main` must still be warned. This reminder is produced under the same hard wall-clock deadline as the other session-start outputs, and (when present) leads the session-start output ahead of the branch briefing.

## State Transitions

### Auth-expiry reminder (session-start, per branch)

- **Silent** → **Shown** when the newest root commit on the current branch is an auth-expiry failure.
- **Shown** → **Silent** automatically once a newer commit on that branch generates memory successfully (the newest-commit check flips), with no manual dismissal.

## Notable Behavior

- **One metadata-driven builder, two surfaces.** The tool label, login hint and separate-login note come from the same central metadata used by status/doctor; only the framing sentence and indentation differ between inline and reminder variants. That table is the single source of truth, so the two surfaces cannot drift apart from each other or from the diagnostic command.
- **The separate-login note is silent rather than generic when unverified.** Only the two tools whose credential separation has been verified carry a note; every other supported tool's message is one line shorter. That is the intended outcome: the note's whole value is naming the specific application the user is looking at, and a hedged version ("your editor may stay signed in") would carry none of that while still costing a line. A tool gains a note when its credential separation is confirmed, not before.
- **OpenCode and Kimi Code can never reach either surface.** Because neither produces an auth classification at all, their expired-login failures are stored under the generic generation-failure marker; neither the inline line nor the session-start reminder ever fires for either. They arrive there from opposite postures — OpenCode keeps the user's provider credentials in the child environment on purpose, Kimi Code scrubs its vendor key precisely to force the subscription login — but the observable result is identical (280).
- **An auth-expired summary is stored as a placeholder, not dropped.** Storing an empty marked summary keeps the commit visible in history and drives the surfacing, rather than silently losing the commit.
- **Newest-commit-only, self-clearing.** The session-start reminder checks just the newest commit, so a single later success makes it disappear with no user action.
- **Trunk branches are not exempt from this reminder.** A broken local login is machine-wide, so the reminder fires even on `main`/`master`, unlike the branch briefing which skips them.
- **Session-start reminder is Claude/Codex-plugin-only.** Other surfaces surface generation failures through their own UI.
- **The progress event carries the tool id.** Inline output reflects the backend that actually failed, even if the current config changes before a later session. The session-start reminder instead uses current config because it is actionable guidance for the next run.

## Shared Behavior

- The post-commit capture-progress stream and the watcher that renders the inline variant are defined by the capture-progress spec.
- The queue worker that stores the auth-expired placeholder summary and emits the stored milestone is defined by the Git Operation Queue Worker topic.
- The local-agent provider backend that produces the auth-expiry failure is defined by the local-agent-provider spec (280).
- The interactive pre-commit counterpart — repairing a broken local agent or a provider/key mismatch before any generation is attempted — is defined by spec 291. This spec is strictly post-failure remediation.
