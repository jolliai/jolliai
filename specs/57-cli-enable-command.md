# 57. `jolli enable` — First-time setup command

## Topic Statement

The `jolli enable` command performs first-time setup of Jolli Memory in the current project by installing all hooks and then prompting the user for credentials.

## Scope

This spec covers the user-facing behavior of `jolli enable`: invocation forms, the install-then-credentials sequence, what is printed to the terminal, exit codes, idempotency, and how the command behaves when Jolli Memory has already been enabled. It does not cover the underlying hook installation steps (those are specified separately) or the OAuth browser flow internals (also separate).

Two prompts this command runs are shared with the bare-`jolli` guided front door (spec 265) and are owned elsewhere; this spec records only where they are invoked and what gates them:

- the **generation repair ladder** — the one-round-trip fix for a configured-but-broken provider — is owned by spec 291,
- the **optional sign-in nudge** and its persisted "don't ask again" flag are owned by specs 265 and 266.

The first-time provider setup wizard *is* owned here, and the guided front door reuses it.

## Data Contracts (output)

The command writes a free-form, multi-line, human-readable report to stdout. It is not designed to be machine-parsed; the `--json` flag belongs to `jolli status`, not `jolli enable`. Errors **and warnings** are written to stderr, on both the success and the failure branch.

The credential setup section, when run interactively, **may** present a numbered menu of four choices and read a single line from stdin — and one of those choices leads to a second numbered menu (the local-agent tool picker). On a fresh configuration where a usable local agent CLI is detected the provider is auto-selected and no menu is printed at all (see the sequence below). Menus, headers, and confirmations are written to stdout; the prompt lines themselves are written to **stderr**.

## Behavior

### Invocation forms

- `jolli enable` — install all hooks, then run the interactive credential phase (setup wizard, repair ladder, sign-in nudge).
- `jolli enable --yes` (alias `-y`) — install all hooks, then **skip** the entire interactive credential phase and instead print a manual configuration guide pointing at the global config file.
- `jolli enable --cwd <dir>` — operate against `<dir>` instead of the auto-resolved git repository root. Default value is the resolved project directory.
- `jolli enable --integrations-only` — set up the node-side integrations only (MCP registration, skill files, dispatch scripts / dist-paths, and the machine-global skill-preference step) and install **no** git or agent hooks. Intended for a surface that needs to refresh MCP/skills/dispatch scaffolding without touching hooks the same command already owns — the live consumer is the IntelliJ plugin's *upgrade catch-up*, which runs on project open when its recorded integrations version is stale or its MCP registration has gone stale, and deliberately leaves the hook set (installed by an earlier full enable) alone. On success the report replaces the header and hook-path list with a single line — `Jolli Memory integrations enabled (MCP + skills; no hooks installed).` — and omits the restart reminder. The warnings block, the `jolli doctor` verification hint, and the three-line telemetry disclosure all still print.
- `jolli enable --source-tag <tag>` — override the dist-paths **source tag** stamped for this install (e.g. `intellij`) so the install coexists with other surfaces' entries in the per-source dist-paths registry rather than overwriting the default `cli` entry. When omitted, the CLI stamps `cli`. The tag is validated before use (it becomes a dist-paths filename segment): it must be lowercase alphanumerics and hyphens only. A tag failing this check aborts the command with an error on stderr and exit code `1`, before any install work runs. The IntelliJ plugin's full enable is the primary user of this flag.
- `jolli enable --repo-hooks-only` — run a reduced install covering the shared runtime, the source-neutral git hooks, the Claude agent hooks, and the project-local `/jolli` menu, while skipping MCP registration, the full skill set, the machine-global instructions block, and the deferred state migrations. **Silent on success** — see the dedicated behavior section below. Mutually exclusive with `--integrations-only`.
- `jolli enable --automatic` — a **hidden** flag (absent from `--help`) used by automatic, per-session callers rather than by a person. It has two effects: the install honours the repo-wide manual-disable opt-out instead of overriding it, and the install operates on the current worktree only with a short lock budget rather than sweeping every worktree.

**Two flags that no longer exist.** Earlier versions accepted `--git-hooks-only` (a narrower reduced mode, superseded by `--repo-hooks-only`, whose scope is *not* the same — see below) and `--reload-skills` (which emitted a same-session skill-reload request on standard output). `--reload-skills` has **no replacement on this command**: the same-session reload request is now produced by the Claude Code plugin's own session-start bootstrap as part of that hook's structured output, not by `jolli enable`.

If stdin is not a TTY, the command behaves as if `--yes` were passed (the credentials wizard, the repair ladder, and the sign-in nudge are all skipped) regardless of whether the flag was supplied. Interactivity is decided on the **input stream alone** — whether standard output is a TTY is not consulted here (unlike the bare-`jolli` guided front door, which requires both).

If the command detects it is running inside a Jolli-spawned local-agent child process (a throwaway agent session Jolli itself launched, whose host in turn fires the plugin's session-start bootstrap), it returns immediately without installing anything — installing hooks or claiming a Memory Bank repo against the agent's temporary working directory would be pure self-recursion.

### Sequence

1. **Hook installation** runs first, unconditionally. On success the command prints the header `Jolli Memory enabled successfully!`, then `Hooks installed:`, then a bullet list of every hook path that was installed:
   - the git post-commit hook path,
   - the git post-rewrite hook path,
   - the git prepare-commit-msg hook path,
   - the git post-merge hook path,
   - the git pre-push hook path,
   - the Claude Code hook settings path,
   - the Gemini hook settings path, printed as `- Gemini hook (<path>)` (only printed if Gemini was detected and a hook was written).

   Any warnings produced during installation are printed afterward, each on its own line, prefixed with `Warning:`, and written to **stderr** rather than stdout. This warnings block prints on the success branch in **both** modes — after the hook list (or after the single integrations line) and before the closing report below.

   **Global-instructions step (apply-only, silent).** During installation the command applies whatever machine-global skill-preference decision is already persisted (spec 242): if the `globalInstructions` switch is `enabled` it (re-)writes the block, if `disabled` it removes any stale block, and if undecided (the fresh-install default) it does nothing. `jolli enable` **never prompts** for this and **never persists** a decision — the switch is set only through the VS Code Settings toggle or `jolli configure --set globalInstructions=…`. There is no `[Y/n]` confirm, and this step produces no terminal output regardless of `--yes` or TTY state.

2. **Closing report** — three blocks, printed in this order on every successful run:

   **Restart reminder — one line, and only outside integrations-only mode:**

   ```
   IMPORTANT: Restart your AI agent session for the hooks to take effect.
   ```

   **Verification hint — one line, printed unconditionally**, including in integrations-only mode (which installs no hooks but still touched MCP, skills, and the dispatch scaffolding worth verifying):

   ```
   Run 'jolli doctor' to verify installation.
   ```

   **Telemetry disclosure — three lines, printed unconditionally** (both modes), verbatim:

   ```
   Telemetry: anonymous, content-free usage data is on by default to improve
   Jolli Memory (never your code, paths, or memory content). Turn it off with
   'jolli telemetry off' (or DO_NOT_TRACK=1) · https://www.jolli.ai/telemetry
   ```

   The disclosure is an **onboarding disclosure, not a prompt**: telemetry is opt-out, so `jolli enable` states the fact plainly and names the two ways to turn it off, without asking anything and without recording a decision. It prints regardless of `--yes` or TTY state, and it always precedes the interactive credential phase below — so a user who never answers a single prompt has still been told. The consent model **and** the separate once-only first-run banner are both owned by spec 203, which also records this enable-time note as a deliberate second channel so that a user who only ever runs `enable` still sees the disclosure. The `jolli telemetry off` command the text names is owned by spec 207. The two disclosures deliberately use different streams: the once-only banner goes to **stderr** so it never pollutes piped output, whereas this one is part of `enable`'s stdout report.

3. **Interactive credential phase** runs only if stdin is a TTY and `--yes` was not passed. It has three ordered parts — the setup wizard, the generation repair ladder, and the sign-in nudge — and the first two are mutually exclusive by design.

   **3a. Wizard-suppression gate.** Before any prompt is shown, the command reads the global config and auth token and evaluates two facts: whether *any* credential exists (an OAuth token, a Jolli API key, an Anthropic config key, the `ANTHROPIC_API_KEY` environment variable, or an explicit local-agent provider choice), and whether generation can actually run right now (the shared predicate of spec 291, which for the local-agent provider **probes** an agent CLI rather than trusting the provider setting — specifically the *default* tool's, whichever tool is configured). The setup wizard is **skipped exactly when a credential exists but generation is broken** — that state goes straight to the repair ladder, so the user sees **one** menu (the fix), not two. Every other state runs the wizard, including an already-working configuration (which is how a user adds a second key).

   **3b. Setup wizard.** If a Jolli API key is already stored in the global config, the wizard prints `Jolli API Key:     configured ✓` and skips directly to the Anthropic-key step (step 4) — this is the wizard's **only** path to that step.

   Otherwise, the wizard first checks whether the configuration is **fresh**: no stored Anthropic key, no `ANTHROPIC_API_KEY` in the environment, and no provider setting at all. (An OAuth token does **not** disqualify a configuration from being fresh.)

   - **Fresh-configuration local-agent probe.** Only on a fresh configuration, the wizard probes for **one specific** agent tool — the default one, Claude Code — and no other. It is not a "which agent CLI is installed?" sweep: a machine with Codex, Cursor, or OpenCode installed but no Claude Code fails this probe and falls through to the menu. If the probe succeeds, the provider is auto-selected — the local-agent provider is persisted, **pinned to that one tool** — the interactive tool picker is bypassed entirely, and the wizard **prints no menu and returns**, having printed:

     ```
     ✓ Detected Claude Code — using your subscription to generate summaries (claude -p), no API key.
     Summaries run through your local `claude` login.
     Change this anytime: 'jolli auth login', or 'jolli configure --set aiProvider=jolli'.
     ```

     followed by `Configuration saved to <absolute config path>`. This is the zero-friction default: no key, no sign-in, no question asked. The probe is deliberately restricted to a fresh configuration so an existing key or a deliberate provider choice is never second-guessed and an already-configured re-run never pays for the subprocess probe.

   - **Provider menu.** Otherwise the wizard prints a **four**-option numbered menu under a **single, unconditional** header:

     ```
     How would you like to generate summaries?
     ```

     ```
     1. Sign up / Sign in to Jolli (browser login)   [recommended]
     2. Enter Anthropic API key (sk-ant-...)
     3. Use a local agent CLI — no API key needed
     4. Skip for now (configure later)
     ```

     **There is no longer a second header.** The alternate header that used to print when the fresh-configuration probe ran and came back empty is gone: a failed probe no longer means "no local agent is available", because the menu now offers a local agent CLI unconditionally and its picker lists all four tools — so a "no local agent CLI found" claim would be actively wrong for a user who has one of the other three.

     The prompt is `Choice [1]:` and the default (empty input) is `1`.

     **Every choice is terminal — there is no fall-through to a further prompt** (option `3` leads to its own sub-menu and still returns from there), and unrecognized input is **not** treated as skip:

     - `2` — prompts for an Anthropic API key. A supplied key is saved without validation, the provider is pinned to Anthropic, and `Anthropic API Key: saved ✓` plus the config path are printed. Empty input prints **nothing at all** — no "skipped" line.
     - `3` — runs the local-agent tool picker below.
     - `4` — prints `Skipped. Configure later with 'jolli auth login' or 'jolli configure'.` and the absolute config path. Skipping now requires typing exactly `4`.
     - **Anything else, including `1`, an empty line, and any typo** — opens the browser-based OAuth flow against the configured Jolli site. On success it prints `Authenticated successfully ✓` and, if the callback also saved a Jolli API key, `Jolli API Key:     saved ✓`. On failure it prints `Login failed: <message>` to stderr plus a retry hint pointing at `jolli auth login`, and the phase continues (a failed login is not fatal).

     **Manual entry of a Jolli API key is no longer offered by this command.** A user who holds one sets it with `jolli configure`.

   - **Local-agent tool picker (option `3`).** A second numbered menu under its own header:

     ```
     Which local agent CLI would you like to use?
     ```

     The options are the four supported agent tools' display names, numbered from `1`, in a fixed order — drawn from the same source that supplies the accepted values of the agent-tool configuration key (spec 62), so the offered list and the settable values cannot drift:

     ```
     1. Claude Code
     2. Codex
     3. Cursor
     4. OpenCode
     ```

     The prompt is `Choice [1]:` and the default (empty input) is `1` — the first tool. Input is read as a **number** (leniently: a leading numeric prefix is accepted and the rest ignored) and **clamped to the first entry**: an out-of-range number (`0`, `5` and above, a negative) and any input with no leading number at all all select the first tool. There is no "invalid choice" message and no re-prompt.

     The chosen tool is persisted together with the local-agent provider, and the wizard prints three lines followed by the configuration path:

     ```
     AI provider:       Local Agent (<tool display name>) ✓
     No API key needed — summaries run through your local <tool display name> login.
     Run 'jolli doctor' to verify the tool is installed and signed in.
     ```

     followed by `Configuration saved to <absolute config path>`. This choice is **terminal**: the picker does not fall through to the Anthropic-key step, and no probe of the chosen tool's executable happens here — verification is deferred to `jolli doctor` (spec 59).

   **3c. Generation repair ladder.** After the wizard (or in place of it, per the suppression gate), the config and token are re-read and the predicate re-evaluated. If generation still cannot run **and** some credential exists, the shared repair ladder of **spec 291** runs — one prompt round-trip offering a provider crossover, a key entry, or a retry of the local agent probe, depending on which mismatch applies. The ladder's own return value is discarded; this command re-reads the config and re-derives the answer afterward. A fresh user who just chose "Skip for now" has no credential and is deliberately not offered the ladder.

   **3d. Optional sign-in nudge.** Finally, if generation *is* possible but nothing can push memories to a Space (no OAuth token and no Jolli API key), the shared optional sign-in nudge runs — the same three-way `[Y] yes  [n] not now  [d] don't ask again` prompt the guided front door uses, suppressed entirely if the user previously chose "don't ask again" (specs 265, 266). Only the explicit "don't ask again" choice is persisted. This step is deliberately inside the interactive guard, so `--yes`, piped stdin, and CI never open a browser login.

4. **Anthropic-key step** runs **only** on the "a Jolli API key is already stored" path of step 3b. If an Anthropic API key is already in the config or in the `ANTHROPIC_API_KEY` environment variable, the wizard prints `Anthropic API Key: configured ✓` and returns. Otherwise it prompts for an Anthropic API key (empty input means skip, printing only a blank line). If a key is supplied, it is saved to the config without further validation, the provider setting is left untouched, and the wizard prints `Anthropic API Key: saved ✓` and the absolute config path. No "no API keys configured" warning is printed on this path — by construction a Jolli key is already present, so summaries can already be generated.

### Non-interactive path (`--yes` or no TTY)

The credentials wizard, the repair ladder, and the sign-in nudge are all skipped entirely — no prompt, and in particular no browser login. Instead the command prints a short manual-configuration guide: `Configure a provider to enable summarization:`, the absolute path of the global config file, and the three ways to satisfy it — set `apiKey` (Anthropic) and/or `jolliApiKey` (Jolli Space), or set the provider to the local-agent value to drive a locally-installed agent CLI with no key at all.

### Repo-hooks-only mode

`--repo-hooks-only` runs a reduced install. Its handling differs from a normal `enable`:

1. **Mutual exclusion.** Supplying both `--integrations-only` and `--repo-hooks-only` is rejected up front: the command prints an error to stderr, sets exit code `1`, and does no work.
2. **Reduced install scope.** What runs: the shared machine-global runtime (dispatch scripts and the dist-path registry entry for this source tag), the per-worktree state directory, all five source-neutral git hooks, the **Claude agent hooks**, the project-local bare `/jolli` menu, the legacy- and retired-skill sweeps, and the union merge of the menu's git-exclude entry. What is skipped: MCP registration (repo- and global-scoped), the full agent skill set, the machine-global instructions block, every per-host auto-enable config write, the per-worktree config migration, and the deferred state-schema migration.
3. **The manual-disable opt-out is NOT gated by this flag.** Honouring the durable repo-wide opt-out is driven by the separate hidden `--automatic` flag, not by the reduced mode. Consequently a **plain `jolli enable --repo-hooks-only`** — the form a person or a shipped setup recipe types — both **ignores** the opt-out (the install proceeds) **and clears** it (a successful install wipes the durable marker), exactly as a full `jolli enable` does. Only a caller that also passes `--automatic` respects the opt-out and returns a success result reporting that the repository remains manually disabled, without installing anything. Any claim that "the reduced mode honours the opt-out" is false of the flag itself.
4. **Silent on success.** The command does not print the success header, the hook-path list, the restart reminder, or any credential prompt. It also skips the short telemetry exit-flush so it adds no latency to a host's synchronous startup path. Successful outcomes are recorded only to the diagnostic log. This silence is deliberate: an automatic per-session caller may inject this command's standard output into an agent's context, so a chatty success would pollute every session.
5. **Failure surfacing.** If the underlying install reports failure, a one-line error is written to stderr and the exit code is set to `1`.
6. **No structured output.** This mode emits nothing machine-readable. The same-session skill-reload request that an earlier `--reload-skills` flag produced here is now emitted by the Claude Code plugin's own session-start bootstrap hook instead.

### Failure path

If hook installation itself fails (the underlying installer reports `success: false`):

- the error message is printed to stderr,
- any installer warnings are printed (also to stderr),
- none of the interactive credential phase runs — no wizard, no repair ladder, no sign-in nudge,
- the process exit code is set to `1`.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | Hook installation succeeded. The outcome of the interactive credential phase (wizard skipped, OAuth failed, key entry skipped, repair ladder skipped, sign-in nudge declined, no keys configured at all) does not affect this code. |
| `1`  | Hook installation failed, **or** `--integrations-only` and `--repo-hooks-only` were combined, **or** a supplied `--source-tag` failed the lowercase-alphanumeric-and-hyphen check, **or** a `--repo-hooks-only` install reported failure. |

Exit code `0` is therefore returned even when the user finishes with no provider configured at all — the hooks are installed and every skip path prints its own hint pointing at how to configure later.

## Notable Behavior

- **Idempotent for hooks, but not silent for credentials**: re-running `jolli enable` on an already-enabled project re-installs the same hooks (the installer treats existing hooks as upgrades, not errors) and re-prints the full success report. Re-running on a project that already has a Jolli API key short-circuits the provider menu and only re-checks the Anthropic key. But re-running on **any other already-configured project — including a perfectly working local-agent or Anthropic-key user — shows the provider menu again**, because the fresh-configuration probe only runs on a truly fresh config: such a user is not fresh, so no probe runs, the menu prints, and the default answer is browser login. The menu is not suppressed by "already configured"; it is suppressed only by a stored Jolli key, or by the ladder-eligibility gate when generation is broken.
- **A fresh configuration with a working default agent CLI is configured without asking anything.** The zero-friction default selects the local-agent provider on the strength of a real probe of **one** tool (Claude Code) and prints a confirmation instead of a question. This is the only path where `jolli enable` changes the provider without a user choice, and it is confined to a truly fresh configuration. A fresh machine that has one of the other three agent tools but not Claude Code gets the menu, not the auto-select.
- **The setup wizard and the repair ladder are mutually exclusive, by design.** A user who has a credential but broken generation is shown exactly one menu — the repair (spec 291) — never the provider menu followed by the repair menu.
- **Credentials are stored globally, not per-project.** The interactive phase always reads from and writes to the global configuration directory regardless of the `--cwd` value.
- **Browser-login failure is non-fatal.** A failed OAuth attempt does not abort the phase and does not change the exit code.
- **The default answer to the provider menu is `1`, and every unrecognized answer is also treated as `1`.** Pressing Enter, or typing anything the menu does not list, launches the browser login flow. Skipping requires typing exactly `4`; the local-agent picker requires exactly `3`; entering an Anthropic key requires exactly `2`. There is no "invalid choice" message.
- **The provider menu has exactly one header now.** The old alternate header (`No local agent CLI found. …`) no longer exists in any state, because the menu itself offers a local agent CLI unconditionally — the fresh-configuration probe's outcome changes nothing about what is printed, only whether the menu is reached at all.
- **Picking a non-default agent tool is immediately followed by a repair prompt naming the default one.** The picker persists the chosen tool without probing it, and the interactive phase then re-evaluates the "can generate right now" predicate — which, for the local-agent provider, probes **only the default tool's executable** regardless of which tool was just pinned (spec 291). Because an explicit local-agent provider choice satisfies "a credential exists", the ladder is eligible, so a user who picks Codex, Cursor, or OpenCode on a machine without Claude Code installed is told, seconds later, that no usable default agent was found — naming a tool they deliberately did not choose. The remedies the ladder then offers (retry the probe, switch provider, enter a key) do not include "use the tool I picked". (Surprising; a real mismatch, not a wording problem.)
- **`jolli enable` clears the durable opt-out but performs no discovery catch-up.** A successful full enable wipes the repo-wide manual-disable marker, but nothing re-reads the transcript backlog that accumulated while the repository was opted out. A repository re-enabled from the command line therefore keeps its frozen-window backlog: still-active sessions recover on their next turn, while quiet sessions lose whatever was authored during the window once they age out of the session registry. This is an asymmetry with the desktop editor's enable, which does run the catch-up drain — see spec 305, which owns both the drain and this omission.
- **Prompts go to stderr, menus to stdout.** Every prompt line the interactive phase reads is written to standard error while the menus, headers, and confirmations go to standard output — so redirecting stdout still shows the questions.
- **Interactivity is decided on stdin alone.** This command consults only whether standard input is a TTY; a piped or redirected stdout does not suppress the interactive phase.
- **`--integrations-only` skips all git and agent hooks** and runs only the integration steps (MCP registration, skill files, dispatch scripts / dist-paths, and the machine-global skill-preference sync). It prints the single integrations line instead of the hook-path list and omits the restart reminder — but **not** the rest of the closing report: the warnings block, the `jolli doctor` hint, and the telemetry disclosure all still print. The restart reminder is the *only* piece of output this mode suppresses. The global-instructions apply-step still runs in this mode (it is an integration, not a hook).
- **The telemetry disclosure is unconditional and unskippable on a successful run.** It prints in both modes, under `--yes`, and with no TTY — the one piece of the report that no invocation form can suppress. It is a statement, never a question: nothing is asked and no decision is recorded.
- **`--source-tag <tag>` only changes which dist-paths source entry this install stamps.** It lets a non-CLI surface (e.g. IntelliJ) drive a CLI-backed install without overwriting the `cli` entry, so multiple surfaces' runtimes coexist in the registry.
- **`--repo-hooks-only` and `--integrations-only` are opposite halves and cannot be combined.** One installs the repo-level hooks and menu (and skips MCP and the full skill set); the other installs only the integrations (and skips all hooks). Requesting both is a usage error (exit `1`).
- **`--repo-hooks-only` is deliberately quiet.** It prints nothing on success and skips the telemetry exit-flush to keep an automatic caller's startup fast. Only failures reach stderr. This is the one mode where a successful `enable` produces no terminal output.
- **The reduced mode still installs the Claude agent hooks and the project `/jolli` menu.** It is not "git hooks only": the agent Stop / session-start entries, the bare menu skill, and the legacy/retired skill sweeps are all part of the mode. What it actually omits is MCP registration, the full agent skill set, the machine-global instructions block, and the deferred migrations.
- **Neither reduced mode honours the manual-disable opt-out on its own.** The opt-out gate is driven by the hidden `--automatic` flag. A plain `jolli enable --repo-hooks-only` ignores the durable opt-out *and clears it on success*, so it is not a safe form for a per-session automatic caller to use — such callers must also pass `--automatic`.
- **The same-session skill-reload signal is no longer this command's job.** The retired `--reload-skills` flag has no replacement here; the reload request is produced by the Claude Code plugin's session-start bootstrap as part of that hook's own structured output.
- **A Jolli-spawned local-agent child never installs.** When `enable` detects it is running inside a throwaway agent session Jolli itself launched, it returns immediately — this prevents the plugin's session-start bootstrap from recursively re-enabling against the agent's temporary working directory.
- **`jolli enable` only applies the persisted global-instructions decision — it never opts the user in.** The machine-global skill-preference block is written only when the user has already set the switch to `enabled` through the VS Code Settings toggle or `jolli configure --set globalInstructions=enabled`. On a fresh install the switch is undecided and this step is a no-op. There is no confirm prompt in `jolli enable`. See spec 242 for the tri-state switch and spec 241 for the block written.
- **`jolli enable` is no longer the sole trigger for on-disk skill reconciliation.** A version-guarded startup auto-refresh (owned by spec 48) re-runs the same skill reconciliation on any non-lifecycle `jolli` CLI invocation when the running CLI version differs from the per-repo marker, so a CLI-only user who upgrades the global package without re-running `enable` still gets stale recipes refreshed. It is deliberately **skipped** for `enable` / `disable` / `uninstall` — `enable` already reconciles skills this same invocation, and skipping avoids double-work or fighting an in-progress uninstall.

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- All Jolli sub-commands set up the per-project log directory under `<cwd>/.jolli/jollimemory/` before doing any work; messages logged by `enable` land there in addition to whatever is printed to the terminal.
- The provider setup wizard specified here is the same implementation the guided front door runs as its onboarding step (spec 265), so the auto-detect copy, the four-option provider menu, and the local-agent tool picker are identical on both surfaces.
- The four selectable agent tools, their display names, and the executable discovery / capability probe that decides whether one is usable are owned by spec 280. The picker reads the same tool registry that `jolli configure --set localAgentTool=…` validates against (spec 62), so the offered list and the accepted values cannot diverge.
- The "can generate right now" predicate that gates the wizard-suppression rule, the repair ladder, and the sign-in nudge is the shared predicate defined in spec 291 — including its deliberate divergence from dispatch-time credential selection (spec 10) for the local-agent provider.
- The repair ladder and the sign-in nudge run in the same relative order here as in the guided front door (repair, then nudge), so a user meeting either surface sees the same sequence.
