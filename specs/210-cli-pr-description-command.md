# 210. CLI pr-description Command

## Topic Statement

The `pr-description` command-line subcommand outputs a Jolli-Memory-generated PR title and body for the current branch, accepting an optional base branch through one of two mutually exclusive channels, validating it, and emitting either a machine-readable result or a short human summary with a non-zero exit code on any failure.

## Scope

**In scope:**

- The subcommand name and one-line description.
- Every flag the subcommand registers and each flag's default.
- The two mutually exclusive channels for supplying the base branch (an argument flag and a stdin channel) and the guard that rejects supplying both.
- The base-branch character validation and its allowed-character set.
- The two output modes (machine-readable JSON and the default human summary) and what each emits on success.
- The error envelopes for each failure mode under each output mode.
- The exit-code contract.
- The relationship to the shared generation engine, and to the programmatic PR-description tool as this command's sibling surface (the command is the standalone counterpart for agents and scripts that shell the command line rather than call the tool).

**Out of scope (boundaries):**

- How the title and body are actually computed (commit enumeration, memory loading, title rule, body dispatch, marker wrapping, the empty-summaries error message); see **PR Description Generation** (spec 209). This command is a thin wrapper that calls that engine and formats its result or error.
- The programmatic tool surface that wraps the same engine; that surface is a sibling co-consumer and is owned elsewhere.
- The retired PR skill that used to invoke this command as its fallback; see **jolli-pr Skill Content (Retired)** (spec 211). No installed skill wraps this command today.
- Creating or editing the actual GitHub PR; see **PR Creation and Update via gh** (spec 99).
- The generic stdin-reading channel's byte cap, TTY rejection, and trailing-newline trimming, and the project-directory resolution default; those are shared command-line utilities consumed here as black boxes.

## Data Contracts

### Subcommand identity

- Name: `pr-description`.
- One-line description (shown in help): output a Jolli-Memory PR title + body for the current branch, intended for skill/agent consumption.

### Flags

| Flag | Argument | Default | Meaning |
| --- | --- | --- | --- |
| Base-branch flag | A branch name | Unset (engine then defaults to the repository's default branch) | The base branch to diff the commit range against. |
| Stdin base-branch toggle | (boolean) | Off | Read the base branch from piped stdin instead of from the base-branch flag. Exists for the injection-safe here-doc bridge the Jolli skill recipes use, so a user-supplied base never passes through the shell's argument parser. |
| No-markers toggle | (boolean negation) | Markers **on** | When passed, omit the idempotent update markers that otherwise wrap the body. When absent, the body is marker-wrapped. |
| Format | An enumerated value; only `json` is accepted | Unset (= default human mode) | Output format selector. The only accepted value is `json`; any other value is rejected by the argument parser. |
| Project directory | A directory path | The resolved git repository root | The project directory the engine operates in. |

The no-markers toggle uses the command-line library's negation convention: the underlying marker option defaults to "on" and is flipped to "off" only when the negation flag is present. That on/off boolean is forwarded straight to the engine's include-markers option. (Notable.)

### Base-branch channel exclusivity

The base-branch flag and the stdin toggle name the *same* value through two channels. Supplying **both** is rejected before any work is done, with the message: `--arg-stdin and --base are mutually exclusive. Pass the base branch via stdin OR --base, not both.` This mirrors the same-shaped guard used by the recall and search commands.

Resolution of the base value:

- If the stdin toggle is set: read the piped stdin; if the read yields a non-empty string, that is the base branch; if it yields an empty string, the base branch is treated as unset (the engine then default-resolves it).
- Otherwise: the base branch is whatever the base-branch flag carried (possibly unset).

### Base-branch validation

If a base branch was resolved (from either channel) it must match the safe-argument character set: letters, numbers, spaces/tabs, hyphens, underscores, slashes, and dots. Any other character causes rejection with: `Invalid characters in base branch. Only letters, numbers, hyphens, underscores, slashes, and dots are allowed.` This is defense-in-depth: the value bypassed shell parsing via the here-doc or the argument vector, but it still flows into downstream git operations. (Notable; defensive.)

### Output — success

| Mode | Output |
| --- | --- |
| `--format json` | The full generation result object (spec 209) serialized as a single-line JSON object on standard output. This includes the full multi-line body. |
| Default (human) | A short, terminal-friendly block on standard output: a blank line, the chosen title, a horizontal divider, the base branch, a "Commits:" line of the form `<commitCount> (<summaryCount> with memory[, <missingCount> without])` where the "without" clause appears only when the missing count is positive, then two hint lines — one pointing to `--format json` for the full body, one telling the reader to then open the PR with the GitHub command-line tool, passing the body from a file (`Then open the PR with the GitHub CLI, e.g. gh pr create --body-file <file>.`). The full multi-line body is **deliberately withheld** in human mode so an interactive run does not flood the terminal. (Notable.) |

### Output — error envelopes

Every error path produces output keyed to the output mode and sets a non-zero exit code:

| Failure | `--format json` output | Default output |
| --- | --- | --- |
| Both base channels supplied | `{ "type": "error", "message": "<exclusivity message>" }` on standard output | `Error: <exclusivity message>` on standard error (padded with surrounding blank lines) |
| Invalid base-branch characters | `{ "type": "error", "message": "<invalid-chars message>" }` on standard output | `Error: <invalid-chars message>` on standard error |
| Engine threw (e.g. no summaries on branch) | `{ "type": "error", "message": "<thrown message>" }` on standard output | `Error: <thrown message>` on standard error |

In JSON mode the error envelope is the type-tagged `{ type: "error", message }` shape (the same shape the skill keys on). The engine's no-summaries message text is owned by spec 209.

### Exit codes

- Success: process exit code left at its default (zero).
- Any failure path above: process exit code set to non-zero (1). This is set regardless of output mode so command-line pipelines and CI detect the failure even when the caller asked for JSON. (Notable.)

## Behavior (execution order)

1. Resolve the project directory option (defaulting to the git repo root) and point logging at it.
2. **Exclusivity guard:** if both the stdin toggle and the base-branch flag were supplied, emit the exclusivity error in the active mode, set exit code 1, and return.
3. **Resolve the base value:** if the stdin toggle is set, read piped stdin and use a non-empty read as the base (empty read ⇒ unset); otherwise use the base-branch flag value.
4. **Validate:** if a base value was resolved and it contains a disallowed character, emit the invalid-characters error in the active mode, set exit code 1, and return.
5. **Call the engine** (spec 209) with the project directory, the resolved base (or unset), and the include-markers boolean forwarded from the no-markers toggle.
6. **Format success:** in JSON mode, print the serialized result object; in human mode, print the short summary block.
7. **Catch failures:** any thrown error (including the engine's no-summaries error and any stdin-read error such as a non-piped/TTY stdin or an over-cap payload) is converted to its message, emitted as the error envelope in the active mode, and the exit code is set to 1.

## State Transitions

The command is single-shot and stateless across runs; there are no persisted transitions. Within one run the only state is the process exit code, which moves from its default (success) to 1 on the first failure encountered.

## Notable Behavior

- **Two channels, one value, never both.** The base branch may come from the flag or from stdin but supplying both is a hard error — the here-doc contract the skill recipes rely on must not be silently overridden by an argv flag. (Notable.)
- **The stdin channel exists specifically to keep a user-supplied base branch out of the shell's argv parser**, matching the injection-safe here-doc recipe the other Jolli skills use. (Notable; defensive.)
- **Base-branch character validation runs even though the value bypassed the shell**, because it still reaches git operations downstream. (Notable; defense-in-depth.)
- **The human output never prints the full body.** Only `--format json` emits the multi-line body; the human path prints a compact summary plus the two hint lines. (Notable; UX.)
- **Markers default on; the negation flag turns them off.** The default-on boolean is forwarded directly to the engine's include-markers option. (Notable.)
- **Every failure sets a non-zero exit code in both output modes** so pipelines and CI detect it regardless of the requested format. (Notable.)
- **An empty stdin read is treated as "no base supplied," not as an empty branch name** — the engine then default-resolves the base. (Notable.)
- **Only `json` is an accepted format value**; any other value is rejected by the argument parser before the action runs. (Notable.)

## Shared Behavior

- The title + body computation, the result object's full field set, the marker-wrapping semantics, and the no-summaries error message are owned by **PR Description Generation** (spec 209).
- The retired PR skill that used to call this command as a fallback (and the `error:` / stale-command detection it keyed on) is recorded in **jolli-pr Skill Content (Retired)** (spec 211); no installed skill drives this command today.
- Creating or editing the actual GitHub PR with this command's output is owned by **PR Creation and Update via gh** (spec 99).
- The shared stdin-reading channel (byte cap, TTY rejection, trailing-newline trimming), the safe-argument character pattern, and the project-directory resolution default are shared command-line utilities consumed here.
