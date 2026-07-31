# 44 — Hook Installation Orchestration

## Topic Statement

A single idempotent install operation wires up every per-agent hook, every git hook, the dispatch scripts, the per-source dist-path entry, the local state directory, and supporting bookkeeping in one ordered pass.

## Scope

**In scope.** The orchestrator's responsibilities: invocation contexts that trigger it, the options it accepts (including the two mutually exclusive narrowed modes and the automatic/manual-disable options), the up-front validation it performs before any write, the two strict locks that serialize it and their user-facing failure messages, the ordered sequence of install steps, the reduced step matrix in repo-hooks-only mode, the idempotency contract across all installed entries, per-agent presence detection and conditional skip, what is reported back to the caller, the corresponding uninstall path and its options, and worktree-awareness.

**Out of scope.** The contents and on-disk format of each individual artifact (those are covered by the per-installer specs: git shell hooks, Claude Code hook, Gemini hook, skill file, dispatch scripts, dist-path registry). The interactive setup prompt that follows a successful install in CLI contexts. The discovery rules for each AI agent (covered by the respective transcript-reading specs).

## Data Contracts

### Inputs

- A target project directory. When omitted the operation defaults to the current working directory.
- A source-tag hint identifying the surface that initiated the install. The two distinguished values are CLI and VS-Code-family (the latter is further refined by inspecting the caller's runtime location to derive a more specific tag such as a particular editor flavour). A surface that names itself may instead pass its tag verbatim — the IDE plugin and the embedded assistant plugin both do. The tag decides only which slot this surface occupies in the machine-global runtime registry; it never reaches any artifact written into the repository.
- **Integrations-only mode** — restrict the run to the machine-wide integration wiring and skip the repository's own hooks.
- **Repo-hooks-only mode** — restrict the run to the shared runtime, the repository's five git hooks, the Claude agent hooks, and the project-local menu and state. **Mutually exclusive with integrations-only mode**: requesting both fails the whole call before anything is written.
- **Respect-manual-disable** — when set, the run declines to do anything in a project the user has durably marked "leave this project alone", returning success with a message saying the repository remains manually disabled.
- **Clear-manual-disable-on-success** — when set, a successful run clears that durable opt-out (best-effort; a failure to clear it does not fail the run).
- **Automatic** — marks the run as machine-initiated rather than user-initiated. It has two effects: the worktree set is narrowed to the target directory alone instead of every worktree, and every lock acquisition uses a short wait budget instead of the default one, so a background caller defers rather than blocking.

The last three are independent of the mode flags. In particular, honouring the durable opt-out is **not** an intrinsic property of repo-hooks-only mode — it is whatever the caller asked for, and the two callers of that mode ask for opposite things (see **Invocation contexts**).

### Outputs (install result)

The operation returns a structured result containing:

- A success flag.
- A human-readable message.
- A list of warnings accumulated during the run (e.g. "an existing third-party post-commit hook was found; the section was appended").
- The absolute path of each artifact that was written, where applicable: the per-project Claude Code settings file, the post-commit hook script, the post-rewrite hook script, the prepare-commit-msg hook script, the post-merge hook script, the pre-push hook script, and the per-project Gemini settings file (only if Gemini was detected and not disabled).

### Configuration the orchestrator reads

A persistent configuration document holding integration toggles. Each integration has a tri-state flag with values "explicitly enabled", "explicitly disabled", or "not yet decided". The toggles read by the orchestrator cover Claude Code, Codex, Gemini, OpenCode, Devin, Antigravity, a single shared Cursor toggle for the two Cursor surfaces (Composer IDE and cursor-agent CLI), a single shared Cline toggle for the two Cline surfaces (VS Code extension and CLI), and a single shared toggle for the two GitHub Copilot surfaces (terminal CLI and editor chat).

The orchestrator additionally reads the **global-instructions switch** — an independent tri-state field ("enabled" / "disabled" / absent = undecided) that gates whether the machine-global skill-preference block is written into each host's global instruction file (see spec 242 for the switch semantics and spec 241 for the block).

### Per-worktree state directory

A subdirectory under the project root that holds per-worktree runtime state. The orchestrator creates it as part of install and writes the initial sessions registry inside it.

## Behavior

### Invocation contexts

The orchestrator is reached by four gestures:

1. The CLI `enable` command, which calls the orchestrator with source tag "CLI" and then, on success, falls into an interactive setup prompt (out of scope). Its narrowed repo-hooks-only variant is also a CLI gesture, and it neither respects nor preserves the durable manual-disable opt-out — it actively clears it on success.
2. The VS Code extension's first-run path, which calls the orchestrator with source tag "VS Code family" so the registry entry derives a sub-tag from the extension's installed location.
3. The IDE (IntelliJ-family) plugin's enable action, which **shells the bundled CLI's full enable** with its own source tag rather than reimplementing any of it. It no longer installs Claude, Gemini, or any git hook in JVM code, and it no longer writes any hook body of its own; the only surface-specific extra is a `.gitignore` entry for the local state directory, written before the shell-out.
4. The embedded assistant plugin's per-session bootstrap, which calls the orchestrator in **repo-hooks-only + automatic** mode with its own source tag, asking it to **respect** the durable manual-disable opt-out (and never to clear it). Because it is automatic, it operates on the current worktree only and uses short lock budgets so a busy repository defers it instead of stalling the user's session. See the plugin session-bootstrap topic.

### Pre-checks

Before any artifact is written:

1. **Mode mutual-exclusion.** Integrations-only and repo-hooks-only cannot both be requested; asking for both fails the whole call.
2. **Repository check.** The target directory must be inside a git repository. If it is not, the run returns an unsuccessful result immediately and writes **nothing at all** — not even the machine-global artifacts. Product memory attaches to commits, so a directory with no repository has nothing to install for.
3. **Source-identity validation.** The source tag is validated (lowercase alphanumerics and hyphens, beginning with an alphanumeric) **before any write**, and a malformed tag aborts the whole install with a message refusing to install with an unsafe source tag. The check is deliberately up front rather than at the point of use, because the tag becomes a filename inside the machine-global runtime registry.
4. Load the persistent configuration and list the worktrees attached to the target project. The worktree list is always non-empty: it contains the main repository root as its first entry, plus any linked worktrees. In automatic mode it is narrowed to just the target directory.

The durable manual-disable check is deliberately **not** here: it is read after the repository lock has been taken, so that a concurrent disable cannot land between the read and the install (see below).

### Serialization: two strict locks

The run is serialized by two locks, and both are **strict**: when a lock cannot be acquired inside its wait budget, the guarded work does **not** run — the orchestrator never proceeds unlocked and never silently skips ahead.

1. **The machine-global runtime-registry lock**, held across the shared-runtime steps (dispatch scripts, legacy migration, this source's registry entry, and the pruning sweep). If it cannot be acquired, or the guarded work reports failure, the whole operation returns unsuccessful with the message *"Failed to reconcile the shared runtime registry — cannot install hooks that depend on it"*.
2. **The repository hook-lifecycle lock**, shared across every worktree of the same repository, held across the repository-facing phase. If it cannot be acquired, the operation returns unsuccessful with the message *"Another Jolli enable/disable operation is still running; retry shortly"*. The same lock, with the same message, guards uninstall.

The two are acquired **sequentially and never held simultaneously**: the registry phase completes and releases before the repository phase acquires. A user-initiated run uses the default wait budget; an automatic run uses a much shorter one.

The **durable manual-disable check happens immediately after the repository lock is acquired**, not during the pre-checks. When the caller asked to respect the opt-out and the project carries it, the run stops there and reports success with a message saying the repository remains manually disabled. Reading it under the lock is what prevents a concurrent disable from landing between the read and the install and being silently undone.

### Step order (CLI / VS Code path)

Steps run sequentially. Failure of an early prerequisite step (dispatch scripts, dist-path entry) returns an unsuccessful result immediately and leaves later steps unattempted. Failure of a later step records a warning and continues.

Steps 1 through 3 run inside the machine-global runtime-registry lock; step 4 onward runs inside the repository hook-lifecycle lock.

1. **Refresh the dispatch scripts** (`resolve-dist-path`, `run-hook`, `run-cli`) in the global state directory. Hook scripts and the skill file rely on these to locate the active runtime. If this step fails, the operation aborts with a message indicating that the dependent hooks cannot be installed.
2. **Run the legacy dist-path migration** (best-effort; non-fatal). This converts any pre-existing single-file `dist-path` entry into the per-source `dist-paths/<tag>` registry layout and removes the legacy file. Errors are logged as warnings but do not fail install.
3. **Offer the per-source dist-paths entry, then prune stale entries.** The source tag is "CLI" when invoked from the CLI, an explicit tag when the caller supplied one, and otherwise derived by inspecting the caller's runtime location. The entry records this surface's version and the absolute path of the runtime that should service hooks installed by this source. Whether the recorded entry actually changes is decided by the registry's own keep-existing gate (see spec 50). Failure aborts the operation.

   Immediately afterwards, still inside the same lock, **every registry entry whose recorded distribution directory no longer exists is deleted**. This sweep is best-effort and non-fatal: a per-entry deletion failure is logged and skipped. Running it *after* this surface's own write is what guarantees it never prunes the caller.
4. **Per-worktree loop A** (state + skill + git-exclude + agent hooks + MCP registration). For each worktree:
   1. Ensure the per-worktree state directory exists.
   2. Atomically create an empty sessions registry file inside it (exclusive-create flag); skip silently if the file already exists, so concurrent agent stop hooks do not race-overwrite it.
   3. Update or write the recall and search skill files (version-gated; see spec 48). The skill update runs before the Claude-hook gate below so that disabling Claude does not strand the cross-platform skill target unupdated.
   4. Append or refresh the managed block in the per-worktree git local-exclude file with every Jolli-managed path that must not appear in `git status`: the skill directories and the auto-written MCP server descriptor file. The block is resolved through the per-worktree gitdir so linked worktrees and submodules get the correct exclude file; failure to find or update the exclude file logs a warning and continues (the skill and MCP files are still written; only the `git status` cleanup is skipped).
   5. If the Claude integration toggle is explicitly disabled, skip the rest of this loop iteration. Otherwise **reconcile the Claude agent hooks** — a single transaction that brings *both* the Stop and the SessionStart entry to canonical form in one read-modify-write of the per-project local settings file, deciding whether to write at all by comparing the whole rebuilt file against the existing bytes (spec 46). There is no separate SessionStart step, no per-event fast path, and no step here that downgrades a write failure to a warning: a failure in this reconciliation propagates like any other per-step failure.
   6. Register the MCP server entry under a fixed server identifier in the per-project MCP server config file (see spec 149). A failure here logs a warning and continues; it never blocks hook installation. The registration writes a machine-local absolute path, which is why the previous step also adds this file to the local-exclude block — committing it would ship a path that is broken on every other machine.
5. **Register the MCP server in present global-scope hosts** (machine-wide config files shared by every repo — Codex, Gemini, OpenCode, Copilot CLI, Copilot Chat, Cline, Devin, Antigravity). Written once here rather than per-worktree. **Presence-gated, not readability-gated**: each host's MCP predicate asks only whether the host is on disk, deliberately not whether this runtime can read its conversation store — see spec 149's *Presence versus readability*. (Repo-scoped hosts were already handled inside loop A.)
6. **Global skill-preference sync** (machine-global; runs even in integrations-only mode). A *pure apply* of the already-persisted global-instructions tri-state — it never prompts and never persists a decision. Resolve the persisted tri-state and then: write the marker-bracketed skill-preference block into each detected/enabled host's machine-global instruction file when the switch is "enabled"; remove the block when "disabled"; do nothing when undecided (writes nothing, stays undecided). The block is only ever written because the user already opted in elsewhere — spec 242 owns the decision surfaces (VS Code settings toggle, `jolli configure --set globalInstructions=…`). The orchestrator passes its already-computed Codex/Gemini detection in so no detector is re-run. Host gating mirrors the hooks: the Gemini and Codex blocks are detection-gated (never create their file on a machine without them) while the Claude block is gated only on the Claude toggle not being explicitly disabled. Runs once, outside the per-worktree loop, because the files are machine-global. Fail-soft: a broken or read-only global file never fails the install. The block content, target files, and host gating are spec 241; the decision semantics are spec 242.
7. **Install the five git hooks** (post-commit, post-rewrite, prepare-commit-msg, post-merge, pre-push). These live in the shared git hooks directory and are written exactly once (worktree-agnostic). Each records a warning-and-continues if an existing third-party hook of that name was found (the product's section is appended). The pre-push section is written **unconditionally** — the sync-on-push config flag (`syncOnPush`) gates only the hook's runtime behavior, not whether the section is installed. Skipped entirely in integrations-only mode.
8. **Auto-detect AI agents and update integration toggles** for every integration whose toggle is currently "not yet decided". Every decision in this step uses the **readability-gated** probe, never the presence-only one used for MCP registration — so a host that got an MCP entry on a runtime that cannot read its store still does not get its discovery toggle flipped in the same run:
   - Codex: if the agent's CLI is detected on the system, set the toggle to enabled.
   - Gemini: if detected and the toggle is not explicitly disabled, install the AfterAgent hook into every worktree (per-worktree loop B); if the toggle was undecided, set it to enabled.
   - OpenCode: if detected, set the toggle to enabled.
   - Cursor: if either form (Composer IDE or cursor-agent CLI) is detected, set the single shared Cursor toggle to enabled.
   - Cline: if either form (VS Code extension or CLI) is detected, set the single shared Cline toggle to enabled.
   - GitHub Copilot (CLI or editor chat): if either form is detected, set the single shared Copilot toggle to enabled.
   - Devin / Antigravity: discovered passively at post-commit and status time; scanned whenever detected and the toggle is not explicitly disabled (governed by the default-on behavior, not written to enabled on detection the way Cursor/Copilot/Cline are).
9. **Per-worktree configuration migration**. For every worktree, copy any project-local configuration that is missing from the global configuration into the global configuration, then remove only the migrated fields from the project-local file. Fields that exist in both with conflicting values are left in the project-local file but logged as warnings; the global value takes effect.

### Step matrix in repo-hooks-only mode

Repo-hooks-only is a genuine reduction, but a narrower one than its name suggests — it installs everything the repository itself needs, including the Claude agent hooks.

**Runs:**

| Step |
|---|
| The mode mutual-exclusion check, the repository check, the source-identity validation |
| The worktree set (target directory only when automatic, otherwise every worktree) and the short-versus-default lock budget |
| Both strict locks, with the same failure messages |
| The full shared-runtime phase: dispatch scripts, legacy migration, this source's registry entry, and the pruning sweep |
| The respect-manual-disable early exit, when the caller asked for it |
| Per worktree: the state directory, and the exclusive-create of an empty sessions registry |
| Per worktree: write the bare unnamespaced menu skill; sweep the legacy per-assistant skill directories; sweep the **retired** skill directories under every skill root; add the menu's path to the local-exclude block as a **union** (never a replace) |
| Per worktree: reconcile the Claude agent hooks, unless the Claude toggle is explicitly disabled |
| All five git hooks, once, source-neutral |
| The best-effort clear of the durable manual-disable opt-out, when the caller asked for it |

**Skipped:**

| Step |
|---|
| Every host probe, readability-gated and presence-only alike — the mode forces them all to "absent", so nothing gated on either form runs (in particular, no MCP entry is ever written or repaired in this mode) |
| The full cross-platform skill set (the loop short-circuits before the version-gated skill upsert) |
| The replace-semantics rewrite of the managed local-exclude block (superseded by the union above) |
| Repo-scoped MCP registration |
| Global-scoped MCP registration (it is still called, but with every host flag false, so it selects no hosts and does nothing) |
| The machine-global skill-preference sync |
| The Gemini AfterAgent hook (its detector is forced false) |
| Every auto-enable configuration write for every integration |
| The per-worktree configuration migration |
| The schema migration, which in this mode is deliberately deferred to the ordinary session-start path |

### Idempotency contract

Running the orchestrator twice in succession leaves the on-disk state equivalent to running it once — but "idempotent" here means *converges to the canonical shape*, not *rewrites the same bytes*:

- Dispatch scripts are compared against their canonical content and only the differing ones are written; the executable permission is re-asserted on all three either way.
- The dist-paths registry entry is **not** unconditionally overwritten. Identical content is not rewritten at all, and non-identical content may be deliberately **kept** in exactly one case: this surface's own distribution is incomplete while the recorded one is complete (spec 50). Otherwise a re-run does move this surface's recorded runtime path, including to a different directory at an unchanged version.
- The Claude and Gemini hook entries are rebuilt unconditionally — every owned entry removed, exactly one canonical entry appended — and the decision whether to write comes from comparing the whole rebuilt file against the existing bytes. Duplicate owned groups and wrong-shaped owned entries are therefore normalized by an ordinary re-run, not merely tolerated.
- Git hook sections are normalized the same way: every owned section is stripped, one canonical section is re-appended, and the whole file is compared. A byte-identical result skips the write but still re-asserts the executable bit. Existing non-product hook sections are never touched.
- The per-worktree sessions registry is created with exclusive-create semantics; existing files are left alone.
- The skill files are rewritten only when their embedded version differs from the bundled version (or the file is absent).
- Configuration toggles are only flipped when the current state is "not yet decided"; an explicit enable/disable from the user is never overwritten.

### Per-agent presence detection

The orchestrator probes for each AI agent's installation independently of any toggle. A hook for an absent agent is never installed. The Claude integration is treated specially: its hook is installed unconditionally unless the user has explicitly disabled it (Claude is the primary integration, so absence is assumed to mean "Claude will be installed later"). All other integrations require detection AND a non-disabled toggle.

Some hosts are probed **more than once per run, with different questions**, because "is this host readable" and "is this host present" are different decisions:

- The **readability-gated** probe asks whether the host is installed *and* this runtime can read its conversation store. It is the one that decides session discovery, hook installation, and the toggle flips in step 8.
- The **presence-only** probe asks solely whether the host is on disk. It exists for MCP registration, which never reads a conversation store — see spec 149's *Presence versus readability* for the divergence and its consequences.

Five hosts keep their conversations in an embedded database and so have both forms of probe: Cursor, OpenCode, Copilot CLI, Devin, and Antigravity. Only **three** of them are probed both ways inside the install run — Cursor, OpenCode and Copilot CLI, which each also have a toggle to flip. Devin and Antigravity have no toggle-flip step here, so the install run asks only the presence question for them; their readability-gated probe runs in the separate status query instead. Cline is probed a third way: its toggle flip accepts either of its two surfaces (editor extension or standalone CLI), while its MCP probe is narrower still and accepts only the editor extension, evaluated per editor flavor without short-circuiting on the first hit.

Each probe runs at most once per install run — most of them ahead of the per-worktree loop, so the loop reuses their results rather than re-probing per worktree.

### Reported counts (status query)

A separate status operation, run after install or independently, reports per-category state. The orchestrator does not return install counts itself; callers compute them via the status query, which surfaces:

- Whether the git hook is installed. This is a **combined** flag: true only when all four required git-hook sections are present in the shared hooks directory — post-commit AND post-rewrite AND prepare-commit-msg AND post-merge. It is the value of the top-level "enabled" flag (a repo counts as enabled when the git hook is installed, independent of any per-agent integration hook being present or absent).
- Whether the pre-push hook is installed — reported as its **own separate optional boolean**, additive and deliberately **not** folded into the combined required git-hook chain above. Pre-push presence is therefore never required for a repo to count as enabled; a repo with the four required sections but no pre-push section still reports enabled.
- Whether the Claude hook is installed (in the primary worktree). This is a **conjunction over both** canonical agent hooks — Stop *and* SessionStart — each of which must be present in the per-project **local** settings file in strict canonical form: exactly one owned matcher group holding exactly one command hook whose command string matches exactly and whose asynchrony flag has exactly the expected shape. There is no fallback to the predecessor team-shared settings file, and no surface-specific override that reports the hook active on the strength of an embedding alone.
- Whether the Gemini hook is installed (in the primary worktree), under the same kind of strict canonical check.
- The number of worktrees with all required per-worktree hooks (a worktree counts as ready when, for each enabled and detected integration, its per-worktree hook is present).
- Per-source session counts and the active runtime (the registry entry with the highest version whose runtime path still exists). This is the in-process selector, which applies **no** completeness check, so the runtime it names can differ from the one a hook fire would actually resolve to — see spec 50's account of the two selection implementations.

## State Transitions

The configuration toggles transition only one way during install: from "not yet decided" to "enabled" upon agent detection. They are never moved to "disabled" automatically and are never moved back to "not yet decided".

## Notable Behavior

- **A non-git directory is refused up front, not tolerated.** The repository check runs before any write, so the orchestrator does not partially configure a directory with no repository — it writes nothing, including nothing machine-global, and reports failure. Inside a repository, a *failure of the worktree listing* is still tolerated: the list falls back to a single-element list containing the project directory.
- **The two strict locks are the orchestrator's only concurrency story.** There is no partial-progress path on lock contention: a missed lock is a failed run with a specific message, and the caller retries. This is why the automatic mode exists at all — a background caller wants a short budget and a clean deferral, not a long block.
- **Nothing the orchestrator writes into the repository identifies the installing surface.** All five git hook sections and both Claude agent hook entries are byte-identical across the standalone CLI, the editor extension, the IDE plugin, and the embedded assistant plugin. In particular no surface writes a source-preference environment prefix ahead of a dispatch call; the surface identity lives only in the machine-global registry, as a filename. A repository therefore cannot be inspected to learn which surface enabled it, and re-enabling from a different surface rewrites identical bytes.
- An existing third-party hook of any of the five names (post-commit, post-rewrite, prepare-commit-msg, post-merge, pre-push) is preserved: the product appends its marker-delimited section after the existing content. A warning is recorded so the caller can surface it ("an existing hook was found; the section was appended").
- Worktree-awareness is fundamental: per-agent hooks are installed in every worktree because each worktree has its own per-project agent settings file and its own state directory. Git hooks are written once because all worktrees share a single hooks directory.
- Each surface writes its *own* dist-paths registry entry (one per source tag) so that a system with several surfaces installed retains every runtime in the registry. Selection at dispatch time is by version first and then by a fixed source-preference order — **not** by which surface was enabled most recently — so a surface that re-runs the orchestrator does not thereby take over; and when the winning runtime disappears the next eligible one takes over without re-running the orchestrator. See spec 50.
- The IDE plugin's `.gitignore` entry for the local state directory is its only surface-specific artifact; every other artifact it produces comes from this same orchestrator, because that surface shells the bundled CLI's full enable rather than reimplementing any step.
- The configuration migration step is conservative: project-local values only overwrite global values when the global value is absent. This prevents a stale per-project key from silently replacing a newer global key.

### Uninstall

The reverse operation removes everything the orchestrator would create. It takes the same repository hook-lifecycle lock, with the same failure message, and accepts three options of its own:

- **Preserve-menu** — leave the bare unnamespaced menu skill (and its local-exclude lines) in place while removing everything else. Used by the embedded assistant plugin's bootstrap when it finds the project durably disabled: the front-door menu must keep working so the user can re-enable from inside the assistant, even though every hook is being torn out.
- **Repo-lock-already-held** — the caller is already inside the repository hook-lifecycle lock and the uninstall must not try to re-acquire it (the locks are not re-entrant).
- **Persist-manual-disable** — record the durable "leave this project alone" opt-out as part of the teardown. This write happens *before* any hook removal and is not best-effort: if it cannot be recorded, the uninstall fails with the recording error and **no hooks are removed**, so the product is never left half-disabled with no durable record of the user's intent.

The removal set:

1. For every worktree: remove the Claude agent hooks (Stop and SessionStart entries from the per-project local settings file, plus any legacy entries from the shared per-project settings file), the Gemini hook from the per-project Gemini settings file, and the MCP server entry from the **repo-scoped** MCP host config files inside the worktree (Claude Code's and Cursor's). The MCP removal is best-effort — a failure (e.g. a read-only file) logs a warning and continues, so a single failing worktree does not leave the shared git hooks installed while the user believes the product has been uninstalled.
2. Once: remove the post-commit, post-rewrite, prepare-commit-msg, post-merge, and pre-push sections from the shared git hooks directory.
3. Unless preserve-menu was requested: remove the bare unnamespaced menu skill and the local-exclude lines that were added for it.

Uninstall does not remove the per-worktree state directory, the global configuration, the dispatch scripts, the dist-paths registry, the namespaced skill files, the rest of the managed block in the per-worktree local-exclude file, the machine-global skill-preference block in each host's global instruction file (spec 241 — same "never removed on uninstall" policy as global-scope MCP registration), the MCP entries in the **eight** global-scope MCP host config files (Codex, Gemini, OpenCode, Copilot CLI, Copilot Chat, Cline, Devin, Antigravity — machine-wide files shared by every repo, so removing them would break MCP for other repos still using the product; see spec 149), or any agent transcripts. The skill files and exclude block are left behind on purpose so a user who ships their own skills under the same directory roots does not have those wiped, and so re-enabling the product is a no-op for those artifacts; an accompanying warning tells the user how to delete them manually if desired. Reinstalling after an uninstall is a normal idempotent install run.

If the worktree listing fails during uninstall, the operation falls back to operating only on the project directory. Per-installer failures (missing files, etc.) are silently treated as "nothing to remove".

This reversal is invoked both by the per-repo disable command and, for the current repo only, as one item inside the broader machine-wide uninstall command's removal set (see the CLI machine-wide uninstall spec), which additionally removes editor extensions, the global CLI package, and global/project state directories that this orchestration never touches.

## Shared Behavior

- The dispatch-script and dist-paths registry layout is shared across all surfaces; see the dispatch-scripts and dist-path registry specs.
- The marker-delimited section convention used by the five git hooks (post-commit, post-rewrite, prepare-commit-msg, post-merge, pre-push) is shared across them; see spec 45.
- The matcher-group JSON shape used by the Claude and Gemini hook installers is identical and uses the same helper-level identifier-match and identifier-removal primitives; see specs 46 and 47.
- The recall skill file's version-guarded write is a single implementation reached by every surface; see spec 48.
- The two locks that serialize this orchestrator are two of the product's declared locks; their locations, wait budgets, and the strict "not acquired means the guarded work does not run" contract are catalogued in the lock-primitive registry topic, along with the constraint that these two must never be held simultaneously.
- The narrowed repo-hooks-only mode's plugin-side caller, its per-session pre-state snapshots, and its disabled-path teardown belong to the plugin session-bootstrap topic; this spec owns only the installer behavior that mode selects.
- The MCP server registration writes the per-project MCP server config file with a machine-local absolute command path; see spec 149.
- "Worktree-aware" semantics — install in every worktree, but write git hooks only once into the shared hooks directory — are a project-wide convention applied consistently here and in the per-installer modules.
