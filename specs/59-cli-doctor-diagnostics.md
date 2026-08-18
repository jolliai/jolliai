# 59. `jolli doctor` — Health diagnostics (without `--fix`)

## Topic Statement

The `jolli doctor` command (without `--fix`) probes the Jolli Memory installation for faults that would impair functionality and reports each one with an `ok`, `warn`, or `fail` verdict.

## Scope

This spec covers the diagnostic mode of `jolli doctor`: the probes performed, their order, the per-probe verdict and message, the overall output format, and the exit code policy. The repair mode (`--fix`) is specified separately. Stale-data cleanup (handled by `jolli clean`) is explicitly out of scope here.

The boundary between `doctor` and `clean` is rigid:

- `doctor` reports **faults** — conditions that break or impair Jolli Memory.
- `clean` removes **redundant data** — entries that have aged out but never break anything.

The two commands have no overlapping checks.

## Data Contracts (output)

A multi-line report written to stdout. Lines are aligned with two-space leading indentation. The report contains:

1. A header line `Jolli Memory Doctor`.
2. A horizontal-rule separator.
3. One line per probe, formatted as `<icon> <name padded to 16 cols> <message>`. Icons are:
   - `✓` for `ok`,
   - `⚠` for `warn`,
   - `✗` for `fail`.
4. If any probe reported `fail`, a final hint line: `Run with --fix to auto-repair issues.`

The message portion may itself span multiple lines (the dist-paths probe uses an embedded newline + indented `Version:` and `Path:` sub-lines).

## Behavior

### Invocation forms

- `jolli doctor` — run all probes in diagnostic mode. Faults are reported but not changed.
- `jolli doctor --cwd <dir>` — operate against `<dir>` instead of the auto-resolved git repository root.
- `jolli doctor --schema-log` — print the machine-level database's migration log: who ran what, when, and how it went, plus the names whose recorded statement text disagrees with this build's (spec 347). A report, not a repair.
- `jolli doctor --mark-migration <name>` — record one named migration as applied by other means, carrying this build's own statement text. The one repair that remains for a state the log's name key cannot fix alone; the mechanics, the four reasons it can decline, and why it appends rather than updates are owned by spec 347. **The repair implies the report**, so this form also prints the log — otherwise a user who ran it would reasonably conclude it had done nothing.

### Probes (in execution order)

Each probe produces exactly one line, with three exceptions: the dist-paths probe emits one line per registered source, the plugin probe emits one line per installed plugin (and none when none are installed), and the local-agent probe emits a line only when the local-agent provider is the resolved credential source.

1. **Git hooks** — first checks the repo-wide manual-disable opt-out (spec 145):
   - `ok` "manually disabled — run `jolli enable` to re-enable" if the opt-out is set (no further check runs).
   - Otherwise checks whether the project's git hooks are installed:
     - `ok` "installed" if present.
     - `fail` "not installed — run `jolli enable` to install" otherwise.

2. **Claude hook** — checks whether the Claude Code agent hook is installed in the user's Claude settings.
   - `ok` "installed" if present.
   - `warn` "not installed (optional)" otherwise. Treated as a warning because Claude Code is not required for Jolli Memory to function.

3. **Gemini hook** — same shape as Claude hook, for Gemini.
   - `ok` "installed" or `warn` "not installed (optional)".

4. **System of record** — which back-end holds this repository's truth, and whether it is reachable. It calls the diagnostic-shaped resolution (spec 346) precisely so a health check can *report* the unroutable state instead of throwing on it.
   - `ok` naming the orphan branch when the repository has not cut over, or `SQLite (<routing state>)` when it has.
   - `fail` "unavailable — `<reason>`" otherwise.

5. **Orphan branch** — informational only; **always `ok`**, with four possible messages selected by whether the branch exists and whether the repository has cut over: present-but-frozen, exists, absent-and-expected, or not yet created. It never warns: past a cutover the branch is frozen (or was never cloned) precisely because the database took over, so warning about its absence sends the user looking for a fault that does not exist. The data question is the probe above. A repository the previous probe reported as unavailable counts as cut over for this wording, because that reason is only produced for a repository that *is* fenced.

6. **Lock file** — checks whether the queue worker's lock file is held but stale (older than 5 minutes implies the worker crashed without releasing it).
   - `ok` "not stuck" if absent or fresh.
   - `fail` "stuck (older than 5 min — Worker probably crashed) — use --fix to release" otherwise.

7. **Sessions** — informational only, never fails.
   - `ok` "<n> active". Stale sessions are not flagged here — they are handled by `jolli clean`.

8. **Git queue** — checks the count of *active* (non-stale) entries in the git-operation queue.
   - `ok` "empty" when zero.
   - `ok` "<n> entries" when between 1 and 10 inclusive.
   - `warn` "<n> entries (high — Worker may be stuck)" when greater than 10. (Stale entries older than 7 days are *not* counted here — they are handled by `jolli clean`.)

9. **Config** — checks LLM credential availability using the same precedence rules the runtime uses to dispatch LLM calls, so the doctor never disagrees with what the live system would accept.
   - `ok` "credentials found — <label>", where `<label>` is one of `Anthropic API key (config)`, `Anthropic API key (ANTHROPIC_API_KEY env)`, `Jolli proxy key`, or `local agent (<tool display name>)`.
   - `warn` "no credentials — summaries will not be generated" otherwise.

   The local-agent label **names the configured tool** rather than a fixed string: it reads `local agent (Claude Code)`, `local agent (Codex)`, `local agent (Cursor)`, `local agent (OpenCode)`, or `local agent (Kimi Code)`, defaulting to the default tool's name when the tool setting is absent and degrading to a generic label for a tool identifier this build does not recognize. It previously always claimed the default tool's subscription, which was wrong for every other selectable tool.

10. **Local agent CLI** — a **conditional** probe: it is emitted only when the Config probe above resolved the local-agent source. It exists because for that provider the "credential" is an executable rather than a stored key, so a green Config line only means the provider is *selected*. This probe therefore runs the same executable resolver the runtime would use (honouring the configured agent tool and any explicitly configured executable path — mechanics owned by spec 280) so the doctor can never report healthy while every commit silently fails to find the binary.
   - `ok` with the **full launch command** and the resolved version — `<launch command> (v<version>)`. The launch command is the interpreter plus the script when the tool resolves through a launcher shim, not the bare interpreter path. Reporting the bare path was actively misleading: for a shim-resolved tool it named a generic interpreter, reading as though the doctor had picked the wrong program entirely.
   - `fail` with the resolver's own error message **followed by a tool-specific sign-in instruction**, in the form `<resolver error message> — <hint>`. The hints are:
     - Claude Code → ``Run `claude` once and sign in to your subscription.``
     - Codex → ``Run `codex login` to sign in with your ChatGPT plan.``
     - Cursor → ``Run `cursor-agent login` to sign in to Cursor.``
     - OpenCode → ``Run `opencode auth login` to connect a provider.``
     - Kimi Code → ``Run `kimi login` to sign in to your Moonshot account.``
     - a tool identifier this build does not recognize → `Sign in to your local agent CLI.`

   - **The `fail` message gains one further clause, and only when an explicit executable path is configured**, appended after the sign-in hint:

     ```
     Discovery was skipped because localAgentPath is set — clear it with `jolli configure --remove localAgentPath` to auto-discover instead.
     ```

     It is present only in that case, and the remedy it names is real: the explicit-path key is a settable/removable configuration key, and removing it restores automatic discovery (spec 62). The clause exists because an explicit path **short-circuits enumeration entirely** (spec 280) — so when the probe fails with one set, that path is the single likeliest cause, and nothing else in the report tells the user that discovery never ran. The `ok` line carries no such clause.

     The clause is worded around a specific drift this probe cannot detect. It hands the stored path to the configured tool's resolver **as a bare value, without checking which tool the path was recorded for** — the persisted configuration records no owner for it. A path left behind by a previous tool is therefore indistinguishable here from one deliberately chosen for the current tool, and the probe dutifully resolves the current tool at the old tool's binary. A write-time invariant now prevents that state from being created (spec 308), but a configuration that drifted before it existed only heals on the next tool switch, never on its own — hence a message that names the escape hatch rather than a diagnosis.

   **The probe checks discovery and capability only — it never probes login state.** It resolves candidates, runs a capability probe, and reports the newest capable one; nothing asks the tool whether it is authenticated. An installed-but-signed-out agent CLI therefore reports `ok` here and fails at commit time instead. The sign-in hint is attached to the *failure* message unconditionally, so it is offered for a purely-missing binary as readily as for an auth problem — it is guidance, not a diagnosis.

   This probe has **no fixer** (spec 60). Installing, upgrading, or signing in to the agent CLI is user action; the interactive repair ladder (spec 291) is the surface that offers it, and it is never reached from `doctor`.

11. **dist-paths** — checks the per-source registry that hooks consult at runtime to find the bundled CLI artifact.
   - If the registry is empty: a single `fail` line "no sources registered — run `jolli enable`".
   - Otherwise, one line per registered source, named `dist-paths/<source>`:
     - `ok` with the source's recorded version and absolute dist directory if the directory currently resolves on disk.
     - `warn` with the same fields but the path suffixed `(MISSING)` if the directory is gone (a stale registry entry).

12. **Installed plugins** — one line per *non-absent* known plugin package, named `plugin <package name>`. A plugin that is not installed emits no line at all.
   - `ok` "v`<version>` (installed, compatible)" when the installed version declares no peer requirement or one the running CLI satisfies.
   - `warn` naming the required CLI range, the running CLI version, and both remedies (upgrade the CLI, or reinstall a compatible plugin) when the declared peer range is unsatisfied.

   This is a **no-load** probe: `ok` means "installed and version-compatible", **not** "loaded successfully". A plugin whose entry point is broken, whose import throws, or whose registration throws is still version-compatible and reads `ok` here — the loader rejects it separately and warns at load time. The row wording says "installed, compatible" rather than "working" precisely to avoid overstating what was verified. This probe has no fixer.

13. **Global daemon** — whether the machine-global resident process is up (spec 365). Two outcomes and no fixer: healthy, naming the process id, its version and whole hours of uptime; or `warn` "not running — scheduled work falls back to commit-time triggers". It is **context for the backup row below, never a substitute for it**: the process being up says nothing about whether any snapshot succeeded, and the probe is given a several-second budget precisely because a busy process is the likeliest reason it cannot answer quickly.

14. **Database backup** — the health of the machine-level memory database's snapshots (spec 349). Six outcomes, and only one of them carries a fixer:

    | Condition | Verdict | Message | Fixer |
    | --- | --- | --- | --- |
    | The configured (or default) snapshot folder is illegal | `fail` | `backupFolder invalid: <reason>` | none |
    | The folder does not exist, last success ≤ 7 days or never | `warn` | folder unreachable, plus the age of the last success (or "never") | none |
    | The folder does not exist, last success > 7 days | `fail` | the same message | none |
    | Last success > 7 days | `fail` | the age, naming the seven-day threshold | **yes** |
    | No snapshot has ever been recorded | `warn` | "no snapshot taken yet" | none |
    | Otherwise | `ok` | the age and the folder | none |

    The three illegal-folder reasons, the seven-day escalation and the age wording are owned by spec 349. Two properties are worth stating here:

    - **"Never snapshotted" cannot escalate.** Escalation needs a past success to measure from, and every fresh install passes through the never state on the way to its first snapshot, so that state warns rather than fails.
    - **The last-success timestamp lives inside the database**, so a runtime below the database floor (spec 347), a missing database file, or one that cannot be read all leave it unknown — which reads as `warn` "no snapshot taken yet" on a machine that may have taken many.

    Staleness is the only one of these a command can repair by itself, which is exactly why it is the only one marked fixable: an unrepairable `fail` makes the whole command exit non-zero on an otherwise healthy install — a week without a commit is enough — with nothing the user can run to change it. An invalid folder or an unreachable drive needs a human, and a snapshot attempt would simply fail again.

15. **Repo registry** — entries naming a checkout that is no longer on disk. A `warn`, never a `fail`, and that distinction is this command's own contract: this command reports *faults*, and a stale entry breaks nothing — it costs every sweep a pass and puts a dead row in the dashboard's repository picker, which is worth saying and is not worth a non-zero exit on an otherwise healthy machine. The message lists **every** entry, uncapped, because this is a diagnostic the user ran on purpose, the repair is irreversible, and the list is the only thing they have to decide with; it shrinks to nothing after the first repair. A registry that cannot be read at all is its own row.

16. **Parked events** — ingest-log entries that never projected.

**The roster is not fixed, and the backup row is no longer last.** Rows have been appended after it, so nothing downstream should assume a terminal position; what is stable is that each probe contributes its own row and that the summary line follows all of them.

**The alarming database-file combination is not a probe here.** The state where the database is gone but its write-ahead sidecars remain (spec 348) is detected by other surfaces — it is one of the reasons the status command's memory-database row reports as unavailable, and it is what the recovery listing prints as the database's file state (spec 60) — but no `doctor` probe reads it, and no verdict in this report changes because of it. A user in that state sees the System-of-record probe fail with the reason **only if this repository is fenced**; an un-fenced repository is still authoritatively backed by its orphan branch, so that probe reads `ok` and the whole report is silent about the missing database.

### Final summary line

After all probes, if at least one probe was `fail`, the command prints `Run with --fix to auto-repair issues.` This line is omitted when no failures were reported.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | All probes returned `ok` or `warn`. (Warnings do not fail the exit code.) |
| `1`  | At least one probe returned `fail`. |

Exit code `0` therefore means "Jolli Memory is functional", but does not promise everything is optimal — warnings can still indicate missing optional integrations or empty state.

## Notable Behavior

- **Faults vs. redundant data** — `doctor` deliberately ignores stale sessions, stale queue entries (older than 7 days), and stale squash-pending markers, even though these would be visible to the same code path. They are cleanup concerns, not faults, and belong to `jolli clean`.
- **The "high queue" threshold is 10 active entries.** It is a heuristic for "the worker is stuck and entries are piling up faster than they're being drained". A queue of exactly 10 is still `ok`.
- **The lock-file staleness threshold is 5 minutes.** A normal active worker holds the lock for less than 5 minutes; anything older is presumed crashed.
- **Optional-hook warnings do not affect exit code.** Missing Claude or Gemini hooks emit `warn`, which is treated the same as `ok` for exit-code purposes.
- **Empty dist-paths registry is `fail`, not `warn`.** Without it the runtime cannot locate the bundle, so this is a hard failure. Stale individual registry entries are `warn` because the other entries may still cover the active install.
- **The Config probe alone is not sufficient for the local-agent provider.** Because that provider is selected unconditionally with no presence check (spec 10), Config reports `ok` for a machine with no agent CLI at all. The dedicated Local-agent-CLI probe is what makes that state visible, and it is the only probe here that actually spawns a subprocess.
- **A green Local-agent-CLI line does not mean "signed in".** The probe verifies that an executable exists and answers a capability probe; it never asks the tool about its authentication state. An installed but logged-out agent CLI passes this probe and fails at the next commit — which is also why the *failure* message carries a sign-in hint even when the actual fault was a missing binary. (Surprising.)
- **The Config probe's local-agent label names the configured tool.** With multiple selectable tools, a fixed label would misattribute generation to the default one; the label follows the setting and degrades to a generic string for an identifier this build does not know (which is reachable, because the setting is shared across surfaces and versions). (Notable.)
- **An explicitly configured executable path changes the failure message but not the verdict.** The extra clause naming that key and how to remove it is appended only when the path is set, and only to the `fail` line. The probe still reports `fail`, still has no fixer, and still cannot tell whether the path was recorded for the tool it is now being applied to. (Surprising: the most actionable remedy this probe ever prints is "delete the setting you added".)
- **Backup staleness is the one failure in this report that exists because a command was not run.** Every other `fail` here describes something broken or missing; this one can appear on a completely healthy install that simply had no commits for a week, because snapshots are taken only by two event-driven call sites and there is no scheduler. That is why it is the only backup outcome that carries a fixer. (Surprising.)
- **The backup row can say "no snapshot taken yet" on a machine full of snapshots.** The last-success timestamp is stored inside the database itself, so anything that makes the database unreadable — a runtime below the floor, a deleted file — silently turns the row into the never-snapshotted warning rather than into an error. (Surprising; reality.)
- **The report never names the one alarming database-file state.** Sidecars present with the database gone is detected elsewhere and is not a probe here; the closest this report comes is a System-of-record failure, and only for a fenced repository. (Notable.)
- **The Orphan-branch probe cannot fail or warn any more.** It reports one of four informational messages and is always `ok`, because after a cutover the branch's absence is the expected state and warning about it sent users hunting a fault that does not exist. (Notable.)
- **A plugin line's `ok` verdict says "compatible", not "working".** Version compatibility is all this probe checks; load failures surface separately at load time, so a green plugin line does not promise the plugin's commands will run.

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- The credential-precedence order used by the Config probe is the same one used by every other place in the CLI that decides which LLM endpoint to call.
- The dist-paths registry probed here is the same one written by `jolli enable`'s installer.
- The executable resolution behind the Local-agent-CLI probe (candidate enumeration, capability probe, newest-capable selection, success-only caching, and the short-circuit an explicit path performs) is owned by spec 280. The interactive counterpart that *repairs* an unusable agent CLI or a provider/key mismatch is spec 291; `doctor` only reports these faults and never prompts. The per-tool sign-in instructions — one per registered tool — are the same strings that ladder renders and that the setup picker prints on a successful pick (specs 291, 57).
- The configuration keys this probe reads and the one its failure message tells the user to remove are owned by spec 62; the write-time rule that keeps the explicit path from outliving its tool is spec 308.
- The backup health verdict, its folder rules, its seven-day escalation, the repairable flag it sets, and the snapshot pass its fixer invokes are all owned by spec 349. The two configuration keys behind it are validated at save time, not here.
- The back-end resolution behind the System-of-record probe — including its diagnostic shape, which exists so this command can report the unroutable state instead of throwing — is owned by spec 346, and the routing states it names by spec 344.
- The recovery mode of this same command (`--recover`), which surveys snapshots and restores one, is owned by spec 60.
