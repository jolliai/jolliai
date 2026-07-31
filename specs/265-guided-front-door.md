# 265. Guided front door (bare `jolli` on an interactive terminal)

## Topic Statement

When `jolli` is invoked with **no subcommand and no arguments** on a fully interactive terminal, it runs a short guided setup flow — a repository gate, then a fixed sequence of "fix what's missing" steps, then a status snapshot and a closing orientation block — instead of printing the grouped help wall.

## Scope

In scope: the TTY gate that selects this flow, the git-work-tree gate that precedes everything, the lightweight status it reads, the auth/repair/sign-in/enable sequence it walks in its fixed order, the cold-start back-fill offer step, the closing status and "listening" lines, and the closing next-steps block. Also in scope: the exact prompt wording and menu choices, and how each answer changes stored state.

Boundaries:
- The credential setup wizard reused when the user has **no credential at all** is owned by spec 57 (`jolli enable` first-time setup); this spec only records where it is invoked and what it can change.
- The **provider/engine repair ladder** run as this flow's first repair step is owned by spec 291 — its rungs, exact menus, defaults, key-entry rules, and the shared "can generate right now" predicate. This spec records only where it is invoked, what gates it, and what is recomputed afterward.
- The credential-source resolution rules (how the provider setting plus the available keys decide whether generation is possible) are owned by spec 10; inlined here only as far as this flow depends on them.
- The Space-binding / sync step and the push-backlog compensation retry that run at the end are owned by their own specs (Space binding flow; push-pending compensation retry) — this spec records only that they are invoked, in order, after credentials settle.
- The full multi-host status probe (`jolli status`) is explicitly **not** used here; this flow reads a deliberately cheaper subset.
- The cold-start SIGNAL detection (has-any-memory, count-missing, list-missing) is owned by spec 228 (Back-fill Cold-start Signal Queries), and the back-fill ENGINE run (attribution, generation, storage, report shape, cooperative cancellation) is owned by spec 227 (Back-fill Engine Orchestration); this spec records only how the front door invokes them, the offer/prompt UX, and the outcome messaging.

## Selection gate

The front door replaces the default help output only when **all** of these hold at process start:
- there are **zero** user-supplied arguments (no subcommand, no flags), and
- standard input is an interactive TTY, and
- standard output is an interactive TTY.

If any of these fails — a subcommand or flag is present, or either stream is piped/redirected (e.g. `jolli | cat`), or the process runs in CI — control falls through to normal command parsing, which prints the grouped help and never blocks or prompts. The gate never blocks on a non-interactive stream.

## Repository gate (runs before everything else)

The very first thing the flow does — **before** storage is initialized, before any config or token is read, and before anything else is printed — is confirm that the working directory is inside a git **work tree**. Jolli attaches memory to commits, so a directory with no commits to attach to is a dead end by design (there is no offer to initialize a repository).

The check asks git whether this is inside a work tree and tests git's **printed answer**, not its exit status. That distinction is load-bearing: a **bare** repository, and the metadata directory of a normal repository, both answer "no" while exiting successfully, so both are correctly classified as *not* a work tree. Any failure to run git at all also counts as "no", and git's own diagnostic text is captured rather than leaked to the user.

**On failure** the flow prints the header, a one-line verdict, an explanation, and a copy-pasteable fix, then sets exit code `1` and returns:

```
Jolli guided setup
Checking directory <cwd> ..... not a git repository
Jolli attaches memory to your commits, so it must run inside a git repository.
Change into a repo and run `jolli` again:
  % cd ~/code/your-repo
  % jolli
```

**On success** it prints the same header plus a positive confirmation, so the framing is identical either way:

```
Jolli guided setup
✓ Git repository <cwd>
```

## Lightweight status (opening read, not the printed line)

Only after the repository gate passes, the flow initializes the active storage for the current repository the same way every memory-reading command does, so folder-mode repositories read from their Memory Bank rather than a fallback. It then reads only two facts — deliberately avoiding the full status command, which probes every AI host, scans agent sessions, and enumerates worktrees:

- **enabled** — whether the git hook is installed in this repository.
- **summary count** — how many memories exist, read straight from the active storage. A repository with no index reports `0`, so a fresh repo and a folder-only repo that has memories but no orphan branch are both handled without gating on the orphan branch.

Both values are read here but the **status line derived from them is printed later**, after the enable step, so that `✓ enabled` is always truthful. Both are re-read after a successful enable and after a back-fill build.

## Capabilities tracked

Two orthogonal capabilities drive the sequence; a third value only shapes wording:

- **can generate** — the shared "can generate right now" predicate of spec 291. This is **not** pure credential resolution: for the local-agent provider it actually **probes the configured agent tool** (honouring an explicitly configured executable path when that path belongs to the same tool), so a broken or missing agent binary is caught here in front of the user rather than silently at commit time. For every other provider it falls back to dispatch-time credential resolution (spec 10). The predicate deliberately disagrees with that resolver for the local-agent provider only.
- **can sync** — any credential exists that can push memories to a Space: an OAuth sign-in token **or** a stored Jolli API key.
- **signed in** — an OAuth token is present. It never gates control flow; it selects which branch of the printed status line is taken. The remaining branches are selected by "can generate", so the status line is a function of both.

"Has some credential" (used to decide whether to run first-time setup and whether the repair step is eligible) is broader than either capability: it is true if any of an OAuth token, a Jolli API key, an Anthropic config key, the `ANTHROPIC_API_KEY` environment variable, or an explicit local-agent provider choice is present.

Both capabilities are recomputed from freshly re-read config after **every** interactive step that could have changed them.

## Behavior (execution order)

The order below is fixed and identical across states — a given run only shows the steps its state still needs. Notably, the printed status line comes **after** the enable step, and the sign-in offer comes **before** it.

### 1. Auth axis — first-time setup when there is no credential at all

If "has some credential" is false, the flow runs the first-time provider setup wizard (spec 57), reusing that command's implementation so the wording cannot drift. Two outcomes matter here:

- when no Anthropic credential is available and **exactly one** agent tool is installed and passes its capability probe, the wizard auto-selects the local-agent provider pinned to that tool and prints a confirmation — **no menu is shown at all**;
- when **two or more** agent tools are installed, the wizard shows the agent-tool picker *before* the provider menu, and only falls back to the provider menu if every detected tool fails its probe;
- otherwise it prints the four-option provider menu (browser sign-in `[recommended]` / Anthropic key / use a local agent CLI / skip). Every choice is terminal, and any unrecognized answer — including an empty line — takes the browser-sign-in branch. The local-agent choice leads to the same agent-tool picker, which probes a pick before saving it. Manual entry of a Jolli API key is not offered by this wizard.

Afterward the flow re-reads the token and config so the rest of the flow sees whatever the wizard established. When any credential already exists, this step is skipped entirely.

### 2. Repair a broken provider or engine (blocking)

Runs only when generation is **not** possible **and** "has some credential" is true. (The freshly-set-up user who just skipped setup has nothing to repair, so this does not re-ask them.)

This step exists because a configured provider can be unusable while the fix is one keystroke away — a key for the *other* provider sitting in config (the resolver deliberately does not silently cross over, spec 10), or a local agent CLI that simply needs installing or signing in. The whole prompt is the shared **generation repair ladder of spec 291**: one round-trip that offers a provider crossover, a key entry for the configured provider, or — when the configured provider is the local agent and its CLI is not usable — a one-shot retry of the probe, a switch to Jolli via browser sign-in, an Anthropic key, or skip. The ladder's exact headlines, menus, defaults, unmatched-input rule, and asymmetric key-entry validation are owned there.

Afterward the token and config are re-read and **both** capabilities recomputed. The ladder's own verdict is deliberately ignored: switching to Jolli only actually restores generation if a Jolli API key now exists, so only the recomputed predicate is trusted.

### 3. Sign-in nudge (non-blocking) — offered before the enable step

Runs only when generation **is** possible but "can sync" is false (memories can be generated but can't leave the machine). The machine-global user profile (spec 266) is read lazily here — only at this point. If its sign-in-declined flag is set, the nudge is suppressed entirely, with **no output at all**. Otherwise it prompts, verbatim:

```
Sign in to Jolli to sync memories to a Space?  [Y] yes  [n] not now  [d] don't ask again:
```

The answer is parsed three ways (case-insensitive, trimmed):

- empty / `y` / `yes` → **sign in.** Runs the browser OAuth login against the configured Jolli site. On success prints `✓ signed in — memories will sync to your Space.`. On failure prints `Login failed: <message>` to stderr plus `You can try again with \`jolli auth login\`.`; a login failure is **not** a decline — nothing is persisted.
- `d` / `dont` / `don't` / `never` → **don't ask again.** Best-effort persists the decline flag in the profile, wrapped so a write failure never aborts the flow (a failed write only means the nudge returns next run — see spec 266), then prints `Got it — I won't ask again. Run \`jolli auth login\` anytime.`
- **everything else, including `n` / `no` and any typo** → **not now.** Prints `You can sign in anytime with \`jolli auth login\`.` and **persists nothing**, so the offer returns on the next run.

Afterward the token and config are re-read and both capabilities recomputed: signing in can flip an unset provider to Jolli, and if no Jolli API key was minted generation is no longer possible — so the closing "listening" promise stays honest.

### 4. Enable axis — offer to install hooks when not enabled

If the repository is not enabled, the flow prompts, where `<repoName>` is the base name of the working directory:

```
Enable Jolli Memory in <repoName>? [Y/n]
```

The default (empty input) is **yes**; `y`/`yes` (case-insensitive, trimmed) also affirm.

- **Declined** → prints `Not enabled. Run \`jolli\` or \`jolli enable\` anytime.` and returns. Nothing further runs, and the exit code stays `0` — a decline is a valid choice, not an error.
- **Affirmed** → sets up the per-project log directory and runs the install for the `cli` surface, asking the installer to **clear the durable repo-wide manual-disable opt-out on success** (spec 145). The flow no longer writes that flag itself and no longer prints a warning about it — clearing is the installer's job. On install failure it prints the error (and any warnings) to stderr, sets exit code `1`, and returns. On success it records a `surface_enabled` telemetry event tagged with trigger `cli`, prints any warnings, then a concise confirmation (the full per-path hook list stays in `jolli enable`):

  ```
  ✓ Git hooks added (post-commit, post-rewrite, prepare-commit-msg)
  ✓ Agent hooks + MCP server added
  ✓ Jolli Memory enabled in <repoName>.
  Restart your AI agent session so it records that session too.
  ```

  The restart reminder is there because git hooks record commits immediately while the AI-agent session hooks only attach on a fresh session. The enabled flag becomes true and the summary count is re-read directly.

When the repository is already enabled, this step is skipped.

### 5. Status line (printed after the enable step, so it is always truthful)

Two lines are printed. The first is chosen by the sign-in state, then by generation capability:

- **signed in** → `✓ signed in · <host>` when a host parses from the saved Jolli site URL, else `✓ signed in`. Either form gains the suffix ` · summaries via <tool display name>` when generation is possible **and** the provider is the local agent. The tool name is **derived from the configured agent tool**, falling back to the default tool's display name when that setting is absent, and degrading to a generic label for a tool identifier this build does not recognize — the same registry that supplies the setup picker's list and the diagnostic command's labels (specs 57, 59, 62).
- not signed in, generation possible, provider is the local agent → `✓ local agent set (not signed in to Jolli)`
- not signed in, generation possible otherwise → `✓ <Jolli API key|Anthropic API key> set (not signed in to Jolli)`. The label names the key that would **actually** be used, derived from dispatch-time credential resolution rather than from whichever key happens to be present — a Jolli key sitting alongside an Anthropic provider pin still generates via Anthropic.
- neither → `✗ not signed in — run \`jolli auth login\` to start generating memories`

The second line always reports enablement and the memory count: `✓ enabled · <n> memory` / `memories` (singular only when the count is exactly 1). It is unconditional because by this point the flow is always enabled — the enable step returned early on both decline and failure.

### 6. Cloud side-effects (after credentials settle)

Only after the repair step and the sign-in offer have settled all credentials — so a sign-in or key established above is picked up this same run — the flow, in order:
1. runs the Space-binding / sync step for the repository (owned by the Space binding spec), then
2. fires the push-pending compensation retry for the repository (owned by the push-compensation spec), which is idempotent and no-ops when not signed in.

By this point the repository is always enabled — the enable axis either enabled it or returned early.

### 7. Cold-start back-fill offer (only when generation is possible)

Runs only inside the branch where generation is possible, after the repair/sign-in steps, the enable step, and the cloud side-effects. Never throws into the front door — every internal failure degrades to silently skipping the offer.

1. **Fresh credential re-check** — re-reads config (not the caller's snapshot); none → return silently.
2. **Sticky dismiss check** — reads the repo-wide "don't ask again" flag shared with the VS Code cold-start card; a read failure counts as not-dismissed; if dismissed, return silently — the offer never reappears until the flag is explicitly cleared.
3. **Cold-start detection** — lists the local user's own commits authored in the last 30 days lacking a memory, newest-first, capped at 10 (the shared window and cap); if none, return; otherwise checks whether the repo has any memory at all to pick wording. Any detection failure is treated as "skip the offer", never a front-door error.
4. **Print the offer** — headline is "no memories yet" when the repo has none at all, or "N commits from the last month don't have a memory yet" when it has some; then the list, one row per commit (short commit hash and its subject truncated to 100 chars); a capped list adds a line noting more history is available via the stand-alone back-fill command.
5. **Three-way prompt** — `Build them now? [Y] yes  [n] not now  [d] don't ask again`:
   - empty/`y`/`yes` → build now.
   - `d`/`dont`/`don't`/`never` → persists the sticky dismiss flag (best-effort) and prints a permanent-opt-out confirmation.
   - anything else (including "no" or a typo) → "not now": prints that the next run will ask again, persists nothing.
6. **Build (on yes)** — runs the back-fill engine synchronously against the listed commits, printing one permanent progress line per commit right as its generation starts (so the first slow commit doesn't freeze the screen). A SIGINT handler makes the run cooperatively cancellable: the first Ctrl-C requests cancellation (honored at the next commit boundary — the in-flight commit always finishes and is saved) and prints "stopping"; a second Ctrl-C force-exits. The handler is always removed when the build finishes, aborts, or errors.
7. **Outcome messaging** (mutually exclusive):
   - engine throws → generic "couldn't build right now, run the back-fill command to try again".
   - cancelled → reports how many were built/saved before stopping and that re-running picks up the rest.
   - all failed → "couldn't build — all N failed", pointing at the stand-alone command.
   - some failed → success count + failure count in one line.
   - all succeeded → a plain built-count success line.
8. After the step the front door re-reads the memory count directly so a build in the same run is reflected in the closing line.

### 8. Closing "listening" confirmation

Runs after the cold-start back-fill offer step, and re-reads the memory count so a build during the offer is reflected here. Printed **only when generation is possible**:
- summary count is `0` → `Jolli is listening — your next commit is your first memory`
- otherwise → `Jolli is listening — last memory saved.`

When generation is still impossible (the repair step left it broken, or the user skipped setup), no listening line is printed — the flow never promises to capture memories it has no engine to build.

### 9. Closing next-steps block

Printed on **every** path that reaches the end of the flow — new and returning users alike, and whether or not generation is configured. Unlike the listening line it makes no claim that could be false, so it is not gated on generation capability:

```
Next steps
  1. Keep working in your agent — every commit becomes a memory, automatically.
  2. Reach back: jolli recall · jolli search · jolli compile · jolli graph · jolli mcp
  3. In your editor: add the VS Code extension or IntelliJ plugin.
  4. See all commands: jolli help
```

There are exactly **three** dead ends that never reach this block, all of them earlier early-returns:

1. not a git work tree → returned with exit code `1`,
2. the enable prompt was declined → returned with exit code `0` (a valid choice),
3. the install failed → returned with exit code `1`.

## Notable Behavior

- **A non-work-tree directory is a hard dead end, and it is the very first thing checked.** The gate runs before storage is initialized so a non-repository never resolves a bogus Memory Bank path off the working directory, and it deliberately offers no "initialize a repository for you" path. Because it reads git's printed answer rather than its exit status, a bare repository and a repository's own metadata directory are both correctly rejected.
- **The full status command is deliberately avoided.** The opening read is only hook-installed + memory count; it never probes AI hosts or worktrees, keeping bare `jolli` fast.
- **The status line is printed after the enable step, not before it.** That ordering is what makes `✓ enabled` unconditionally truthful.
- **The signed-in status line's engine suffix names the tool that will actually run.** It is derived from the configured agent tool rather than being a fixed string, so a user who pinned Codex, Cursor, or OpenCode is told their summaries come via that tool. The suffix appears only on the signed-in branch and only when generation is possible and the provider is the local agent; the "not signed in" local-agent branch names no tool at all, so the tool identity is visible on one of the two branches only.
- **"Can generate" is not just credential resolution.** For the local-agent provider it probes the agent CLI, so this flow catches a broken local agent that dispatch-time resolution would have accepted (spec 291, spec 10).
- **Being signed in never controls flow.** It selects which branch of the status line is taken; sync capability is what gates the sign-in offer, and generation capability is what gates the repair step, the back-fill offer, and the listening line.
- **The provider is only ever changed by an explicit choice** — the repair ladder's switch option, a key entry that pins its own provider, the post-sign-in write in the ladder's local-agent rung, or the setup wizard's single-tool auto-detect. The flow itself never silently reassigns the provider.
- **Declining the sign-in nudge is only sticky when the user says so.** The prompt is three-way: "not now" (and any typo, and a plain `n`/`no`) persists **nothing** and the offer returns next run; only the explicit "don't ask again" choice persists the flag. A failed login persists nothing either — a failure is not a decline.
- **The sign-in offer precedes the enable offer.** Identity and provider are settled first so the enable confirmation and the cloud side-effects can act on a fully-settled credential state in the same run.
- **The first-time setup wizard and the enable install are skipped independently** — an already-credentialed but not-enabled repo skips step 1 but still runs step 4, and vice versa.
- **The cold-start offer's "not now" persists nothing** — only "don't ask again" is sticky, and that sticky flag is shared storage with the VS Code cold-start card, so dismissing from one surface silences the other's card in the same repo.
- **The cold-start offer's cancellation is cooperative and resumable** — Ctrl-C stops only between commits, and a re-run resumes with just the still-missing commits.
- **Partial vs total back-fill failure get distinct closing messages, and neither auto-retries.**
