# 49 — Dispatch Script Generation

## Topic Statement

The product writes three small executable shell scripts under the per-user state directory at `~/.jolli/jollimemory/` that together form a stable indirection layer between the git hook scripts installed in a user's repository and the actual product binaries shipped inside one or more installed product distributions.

## Scope

**In scope:**
- The three scripts (`resolve-dist-path`, `run-hook`, `run-cli`) that are written into the per-user state directory.
- What each script does and the contract it implements toward its callers.
- The two-tier Node-runtime resolution both dispatchers perform, and the asymmetric failure policy when both tiers come up empty.
- Where version-selection logic lives (only in `resolve-dist-path`); the other two delegate to it.
- Why this indirection exists (so an upgrade or rewrite of any installed product version updates only the per-user dist-path registry; the git hook scripts already installed in user repositories continue to call the same three scripts and never need to be rewritten).
- Executable-permission requirement on each of the three files.
- Content layout of each script.
- Idempotency of the writer that produces the three scripts.

**Out of scope:**
- The per-source dist-path registry that `resolve-dist-path` reads, and the semantics of the version-comparison rule and preference order used to pick a winning entry (covered by the per-source dist-path version-selection topic). This topic covers the shell realization of that selection — its stage order, its eligibility gate, and the fact that its behavior is not identical to the in-process implementation of the same rule.
- **Producing** the recorded-runtime record the dispatchers read as their second tier — its writer, the lockstep guarantee that keeps it consistent with the structured detection record, and the path rewriting it applies are owned by the IDE runtime-detection topic (284). This topic covers only the dispatchers' consumption of it.
- The npm postinstall hook that triggers a refresh of these scripts after an upgrade (covered by its own topic).
- The git hook scripts in user repositories that invoke `run-hook` (covered by the hook-install topic).
- The agent-side hook scripts that invoke `run-hook` (covered by their own topics).

## Data Contracts

### The three scripts

All three are written as executable POSIX shell scripts under `~/.jolli/jollimemory/`. Their absolute paths are:

- `~/.jolli/jollimemory/resolve-dist-path`
- `~/.jolli/jollimemory/run-hook`
- `~/.jolli/jollimemory/run-cli`

All three are written with executable permission for the owning user.

### The recorded-runtime record the two dispatchers read

Beside the structured runtime-detection record in the same per-user state directory sits a **plain-text, single-line** record holding one absolute path: the runtime an IDE surface detected and proved. The two dispatcher scripts **read** it; none of the three scripts ever writes it. Its writer, its lockstep guarantee with the structured record, and the path rewriting it applies are owned by the IDE runtime-detection topic (284).

The dispatchers consume it as follows: take the first line, delete any carriage returns from it (a record that round-tripped through a cross-platform file sync or a Windows editor arrives with a trailing one, and without the strip the executable test would fail against a path that is otherwise perfectly good — a silent no-op with no user-visible error), and accept the result only when it is non-empty **and** carries the executable bit. A missing or unreadable record is indistinguishable from an empty one and simply yields nothing.

Plain text rather than the structured record because a POSIX shell has no robust way to parse the structured form — on Windows the path arrives escaped inside it, and the naive line-oriented extraction a shell can manage mangles it.

### `resolve-dist-path` — output contract

A read-only script that takes **one optional argument**: the bare filename of an entry that must exist inside a candidate distribution for that candidate to be considered. When the argument is omitted only the candidate directory's existence is checked. The argument gates eligibility in both of the script's selection passes — the highest-version pass and the preference pass — so a distribution missing that one entry is skipped in both.

On success it prints the absolute path of the chosen distribution directory to standard output and exits with status zero. On failure it prints a single diagnostic line to standard error that names the script's purpose and a recovery hint, and exits with status one. The chosen distribution directory is always an absolute path on the local filesystem.

### `run-hook` — input and output contract

A dispatcher that takes a hook-type token as its first positional argument and forwards all remaining arguments unchanged. The recognized hook-type tokens are:

- `post-commit`
- `post-merge`
- `post-rewrite`
- `prepare-commit-msg`
- `pre-push`
- `stop`
- `session-start`
- `gemini-after-agent`

For each recognized token the script invokes the corresponding hook entry from the chosen distribution directory under a fixed file-name convention (a token-derived basename ending in `.js`, executed with the Node runtime chosen by the two-tier resolution below). The token is mapped to that basename **before** resolution, and the basename is then handed to the resolver as its required-entry-file argument — so a distribution that would otherwise win selection but is missing this particular hook entry is bypassed in favour of one that has it, rather than being resolved and then failing on a nonexistent file. For unrecognized tokens it prints a diagnostic to standard error. On absence of **both** runtime tiers it prints a diagnostic to standard error. On failure to resolve a distribution directory it exits silently. The exit status of the script is always zero — it must not block the caller (git, the agent, etc.) under any condition.

### `run-cli` — input and output contract

A dispatcher that forwards all arguments unchanged to the CLI entry inside the chosen distribution directory, executed with the Node runtime chosen by the two-tier resolution below. It passes the CLI entry's own basename to the resolver as the required-entry-file argument, so a distribution without a CLI entry is never selected here. On absence of **both** runtime tiers it prints a diagnostic to standard error and exits with status one. On failure to resolve a distribution directory it exits with status one. Otherwise it inherits the exit status of the CLI process.

### Two-tier Node-runtime resolution (identical in both dispatchers)

Neither dispatcher assumes a runtime is on the caller's search path. Each resolves one in two tiers, in order:

1. **A runtime found on the caller's own search path.** This is preferred so an interactive shell keeps whatever version-manager choice that shell already made.
2. **Only when the first tier yields nothing** — the absolute path in the plain-text recorded-runtime record described above, accepted only if present and executable.

The recorded path is deliberately **never spawned to ask its version**. One of the dispatched hook types (`prepare-commit-msg`) sits on the blocking commit path, so the dispatchers must not pay an extra process start; the record's writer already proved the binary runs and meets the minimum version before recording it (284), so the executable-bit check is the whole verification here.

The motivating case is a graphical version-control client: it launches with a minimal search path that lacks the version-manager and package-manager locations where a runtime normally lives, so before the second tier existed the dispatched hook printed a diagnostic and did nothing on a machine that plainly had a runtime installed.

The failure policy when **both** tiers come up empty is unchanged and **asymmetric**: the hook dispatcher prints a diagnostic to standard error and still exits **zero**, because a hook must never block the version-control operation; the CLI dispatcher prints a diagnostic to standard error and exits **one**.

## Behavior

### Where version-selection logic lives

Only `resolve-dist-path` enumerates the per-source dist-path registry, applies the version-comparison rule, and selects a winner. The other two scripts are thin wrappers that invoke `resolve-dist-path` once at startup and consume its standard output as a directory path.

The selection *semantics* are owned by the per-source dist-path version-selection topic; this script is their shell **realization**, and the realization is deliberately not identical to the in-process one (that topic enumerates the divergences). What this topic owns is the script's three-stage precedence, in order:

1. **Highest eligible version.** Every registry entry whose recorded directory exists and which satisfies the required-entry-file argument is a candidate; the first candidate is accepted and a later one replaces it only on a strictly greater version, so enumeration order can never decide a tie.
2. **Soft source-preference override.** If an environment variable naming a single source tag is set, and that source's entry is eligible and sits at exactly the already-won version, it wins and the script stops here. This stage short-circuits ahead of the fixed order, never beats a strictly higher version, and never fails hard. No shipped surface sets the variable.
3. **Fixed source-preference order.** Otherwise the earliest source in a fixed order that is eligible at the winning version wins. That order is **generated into the script** from the single declared list the in-process selector also reads, so the two enforcement sites cannot drift apart in content.

This split is deliberate. Future changes to the registry layout, the version-comparison rule, or the introduction of a new distribution kind (for example a non-Node runtime) only need to touch `resolve-dist-path`. The two dispatcher scripts remain stable because their job is mechanical: supply a required entry name, take the path, exec a fixed file inside it.

### Why this indirection exists at all

When a git hook is installed in a user's repository, the hook script that lands in the repository's `.git/hooks/` directory invokes `~/.jolli/jollimemory/run-hook` rather than calling a product binary directly. The same is true for agent-side hooks installed into the agent's per-user configuration: they invoke `~/.jolli/jollimemory/run-hook` and let it pick up the current winner.

The advantage is that an upgrade to any installed product version (for example via package upgrade or IDE extension upgrade) only needs to:

1. Update its own entry in the per-source dist-path registry (so its new version becomes a candidate at selection time).
2. Rewrite the three dispatch scripts in `~/.jolli/jollimemory/` (so any changes to script contents are propagated).

It does **not** need to walk every git repository the user has cloned and rewrite the hook scripts there. Repository-level hooks are stable across product upgrades.

A rollback to an older product version is also safe under this model: the older version's installer rewrites the three dispatch scripts back to its own shape, and rewrites the registry entry under its own format. The dispatch indirection self-heals because the scripts are owned by whichever product version most recently ran an install or refresh.

### `run-hook` exit-status policy

Hooks must never block their callers. `run-hook` therefore exits with status zero in every failure mode that does not reach a successful exec into a hook entry: missing distribution directory, no runtime from **either** tier, unrecognized hook-type token. Diagnostics are written to standard error (visible if the caller logs hook output) but the exit status never propagates failure up to git or the agent.

### `run-cli` exit-status policy

CLI invocations are user-facing and must report real exit codes. `run-cli` exits with status one on missing distribution directory or when neither runtime tier yields a usable runtime, and inherits the exit status of the underlying CLI process otherwise.

### Writer idempotency

The writer that produces the three scripts is idempotent, and specifically **write-if-changed** rather than unconditional overwrite. On every call it ensures the per-user state directory exists and, for each of the three files, compares the file's current content against the canonical content for this product version:

- **Content already matches** — no write occurs at all.
- **Content differs or the file is absent** — the canonical content is written via a temporary sibling file that is then renamed into place.

On **both** paths the executable permission is re-asserted unconditionally, so a file whose executable bit was stripped self-heals on the next refresh even though its content did not change.

Skipping the matching write is deliberate, not merely an optimization: an unconditional truncate-then-write leaves a window in which a concurrently-executing dispatch — for example a `prepare-commit-msg` hook that is executing the hook dispatcher at that instant — could observe an empty or partial script. Write-if-changed plus rename means a concurrent reader always sees either the whole old file or the whole new one.

Running the writer twice in succession is equivalent to running it once. The writer logs a single informational line on success and a warning on filesystem failure. Filesystem failure is non-fatal — the writer returns a boolean indicating success but does not throw.

### Byte-identical content across installation sources

The three scripts are byte-for-byte identical regardless of which installation source (the standalone CLI, an IDE extension, etc.) wrote them. This means whichever source last ran an install or refresh produces the same files; there is no fingerprint or marker tying the scripts to a particular source. The per-source dist-path registry is the only place a source records its identity.

### Recognized hook-type tokens

The set of hook-type tokens accepted by `run-hook` is closed and built into the script's content. Adding a new hook type requires regenerating the dispatch scripts; the registry-level upgrade alone is not sufficient. This is consistent with the principle that the dispatcher is a thin wrapper: it can only forward to file names it knows about.

## State Transitions

The three scripts have no state of their own. Their inputs are the per-source dist-path registry (read by `resolve-dist-path`), the recorded-runtime record (read by the two dispatchers as their second runtime tier), the caller's own search path, and the arguments forwarded to them by their callers. Their outputs are determined entirely by those inputs at the moment of invocation.

Across successive product installs or upgrades the scripts move through these transitions:

- **Absent** (the per-user state directory does not yet contain them) → **Present** (an install or refresh has just run the writer). This is the normal first-time-enable transition.
- **Present, version A** → **Present, version B** (a different product source has just run the writer). Because all sources produce byte-identical content for a given product version, the actual change in script content reflects a product-wide version change rather than a source change.
- **Present** → **Present** (a refresh produced no functional change). No write occurs; only the executable permission is re-asserted.

The scripts are never deleted by any normal flow. Removal is only via uninstall.

## Notable Behavior

### `resolve-dist-path` is a public contract

Although the script is internal in the sense that it lives under a per-user state directory, its standard-output-and-exit-code contract is treated as a public API. The two dispatcher scripts depend on it. The git hook scripts in user repositories depend on the dispatcher scripts. External tools and power users may invoke `resolve-dist-path` directly to discover the current winning distribution directory. The output format (one absolute path, single line, exit zero on success; diagnostic on standard error and exit one on failure) is therefore stable across product versions.

### The dispatcher scripts do not re-implement selection

`run-hook` and `run-cli` invoke `resolve-dist-path` once and take its standard output verbatim. They do not parse the per-source registry, do not compare versions, and do not have any awareness of which source wrote the registry entry. This is a deliberate single-source-of-truth choice: any future change to the selection rule (for example to support a different runtime kind or a richer output format) only needs to touch `resolve-dist-path`.

### Silent exit on `run-hook` resolution failure

If `resolve-dist-path` fails (no winning entry in the registry), `run-hook` exits with status zero without any diagnostic of its own. This is necessary because git and the agents that invoke hooks must not be blocked by a misconfigured product install. The user discovers the problem via the absence of summaries and is expected to run an enable or doctor command to repair the registry.

### Hard error on `run-cli` resolution failure

By contrast, `run-cli` exits with status one on resolution failure because it is invoked by humans and skill files that expect real exit codes. A silent zero would mask configuration drift.

### The Node-runtime probe is at dispatch time, not write time

Both dispatcher scripts resolve a Node runtime each time they are invoked, not at the time the writer produces them. A user who installs the dispatch scripts and only later installs Node will find the scripts work the next time they invoke a hook or CLI command without any rewrite step. The resolution is the two-tier sequence above — a search-path lookup, then a read of the recorded-runtime record — and neither tier is decided at write time.

### The recorded-runtime tier is second, not first

The search-path lookup is deliberately tried first. An interactive shell has already made a version-manager choice, and that choice must win over whatever runtime an IDE happened to detect and record — the recorded path exists only to rescue callers whose environment has no runtime on its search path at all. So the record can never override a working search-path runtime, and a user who switches runtime versions in their shell does not need the record refreshed for the dispatchers to follow along.

### The dispatchers read the recorded-runtime record but never write it

Both dispatchers treat the plain-text record as read-only input. Nothing in the dispatch-script writer creates, refreshes, or removes it. That means the second tier is only available on a machine where an IDE surface has run detection at least once (284); on a machine where only the standalone CLI was ever installed, the second tier is permanently empty and the dispatchers behave exactly as they did before it existed.

### The three scripts may be present without a populated registry

If only the writer has run but no source has yet written a per-source dist-path entry, `resolve-dist-path` exits with status one and the dispatcher scripts behave per their failure-mode contracts. The system is partially configured but functional in the negative direction (it correctly reports that no winner exists). This state is transient under normal usage but can be observed if the registry is manually deleted.

## Shared Behavior

- **Per-user state directory at `~/.jolli/jollimemory/`** — the location where all three scripts live, alongside the per-source dist-path registry they read.
- **Per-source dist-path registry** — read by `resolve-dist-path` to enumerate candidates and pick a winner; covered by its own topic.
- **The recorded-runtime record (`node-path`)** — the plain-text single-line file the two dispatchers read as their second runtime tier. Produced exclusively by the IDE runtime-detection topic (284), which owns its write/delete lockstep with the structured detection record and the shell-executable path rewriting it applies; this topic owns only the consumption side.
- **Hook installation in user repositories** — the consumer that places hook scripts which invoke `~/.jolli/jollimemory/run-hook`; covered by the hook-install topic.
- **Agent-side hook installation** — the consumer that places agent-configuration hooks which invoke `~/.jolli/jollimemory/run-hook`; covered by its own topics.
- **Skill files for the agent** — consumers that invoke `~/.jolli/jollimemory/run-cli` to run product subcommands.
- **Doctor and enable commands** — operations that re-run the writer to repair or initialize the dispatch scripts. Callers run the writer while holding the machine-global registry lock, together with the registry-entry write and the pruning sweep, so the scripts and the registry they read are reconciled as one unit; see the lock-primitive registry topic.
- **Npm postinstall hook** — a trigger that re-runs the writer after a package upgrade; covered by its own topic.
