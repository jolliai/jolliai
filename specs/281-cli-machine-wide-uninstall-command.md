# 281. CLI Machine-Wide Uninstall Command

## Topic Statement

A single command performs machine-wide discovery and selective, confirmed removal of every installation and configuration artifact the product has placed anywhere on the machine — across every detected code editor and IDE, the globally-installed command-line tool, machine-global and per-project state directories, and the current repository's git/agent hooks and repo-scoped MCP registrations — while never touching the user's stored memories.

## Scope

**In scope**
- The set of surfaces scanned: editor extensions (stock editor plus every fork the product installs into), IDE plugins, the globally-installed command-line package and its executable shim, the machine-global configuration/state directory, the current project's local state directory, and the current repository's git hooks plus repo-scoped AI-agent/MCP registrations.
- What is deliberately excluded from every scan and can never be selected for removal: the durable memory store (the shared history record) and the user-facing folder holding readable memory content.
- The inventory presentation, scope filtering (`global` vs `project` vs `all`), interactive item selection, the two-step confirmation gate, dry-run mode, non-interactive refusal, and per-item outcome reporting.
- How editor-extension removal reconciles the host editor's own installed-extensions manifest so a relaunch doesn't show a broken/corrupt-extension warning.
- The follow-on user guidance printed after specific removals (global-config removal breaking other repos' hooks until they're separately disabled/uninstalled; an extension removal needing an editor restart; a self-deleting running executable on one platform).

**Boundaries (out of scope)**
- Removal of stale-but-still-functional runtime data (expired sessions, queue entries, squash-pending markers) — a different command with a different purpose (see the stale-data-cleanup spec): that command never touches installation artifacts, and this command never touches merely-stale runtime data.
- The internal mechanics of the current-repository hook/MCP removal this command dispatches to (marker-aware hook stripping, per-worktree iteration, which MCP host scopes are cleaned) — owned by the hook-installation-orchestration spec and the MCP-client-registration spec. This command is a caller of that mechanism for exactly one inventory item, not a reimplementation of it.
- Detection logic for *installing* any surface (which editors/IDEs are recognized, how the tool is registered into each) — owned by the respective install specs. This command's discovery reuses the same repo-hook status query but independently locates editor/IDE/package artifacts.

## Data Contracts

### Surfaces and their grouping

Six inventory groups, each with a display heading and a scope classification:

| Group | Heading | Scope |
|---|---|---|
| Editor extension folders | "VS Code editors" | global |
| IDE plugin folders | "JetBrains IDEs" | global |
| Globally-installed command-line package + executable shim | "Command-line tool" | global |
| Machine-global configuration/state directory | "Global configuration" | global |
| Current project's local state directory | "Project state (current repo)" | project |
| Current repository's hooks + repo-scoped MCP registration | "Hooks & MCP (current repo)" | project |

### A removable item

Every discovered artifact carries: which group it belongs to, a human-readable label, an absolute filesystem path (or, for the hooks group, the repository directory the removal operates on), a removal kind (plain file, plain directory, or the special "hooks" kind dispatched to the marker-aware remover), and an optional one-line detail (e.g. a version string or editor name).

### The full inventory

A scan produces: the flat list of discovered items across all groups, and a fixed list of human-readable notes describing what is deliberately never included — the durable memory record and the user-facing memory folder's content.

### What is scanned, and how each surface is identified

- **Editor extensions**: every home-directory data folder belonging to the stock editor, its Insiders/remote-server/OSS variants, and each fork the product installs into, is probed for an `extensions` subfolder; any entry whose name starts with the product's fixed publisher-and-name extension-folder prefix is a match. A trailing version suffix on the folder name (if present) becomes the item's detail. Editors/forks not present on the machine are silently skipped.
- **IDE plugins**: the platform-appropriate JetBrains-family configuration root (and, separately, the equivalent root used by the IntelliJ-platform-based Android-focused IDE, which lives under a different vendor namespace and is narrowed to only its own product-name prefix so unrelated apps sharing that vendor root are not probed) is scanned for per-product-version `plugins` subfolders; any plugin folder whose name contains the product's name (case-insensitive) is a match, tolerating future artifact renames.
- **Global command-line package**: every candidate global package-manager root — a live query of the package manager's global root (time-bounded so a hung query cannot stall the command, including in preview mode; a failed or empty query just narrows rather than aborting the scan) unioned with a fixed set of well-known static roots for the current platform — is probed for the package's directory. For each root where the package is found, the corresponding executable-shim path(s) beside that root's install prefix are also probed and included if present (a symlink is detected without following it, since the goal is to remove the link, not its target). Results are de-duplicated by resolved path.
- **Global configuration/state directory**: the single machine-global configuration/state directory is included as one item if it exists as a directory.
- **Project state directory**: the current project's local state directory is included as one item if it exists as a directory.
- **Repository hooks + repo-scoped MCP**: a single combined item is included if the current repository has any of the git hook, the primary AI-agent hook, or the secondary AI-agent hook installed (as reported by the existing installation-status query). If the status query itself fails (e.g. not a git repository), this is treated as "nothing installed" rather than an error.

Every individual surface scan is independently fault-tolerant: a failure scanning one surface never prevents the others from completing, and the overall scan itself never throws.

## Behavior

### Establishing the storage backend before the scan

Before anything else — **before** the scope option is validated, and therefore before any inventory scan — the command establishes the user's **configured** memory-storage backend as the process-wide active backend for the rest of the invocation. The attempt is guarded: any failure (a half-configured or already-partially-torn-down install, or a working directory that is not a repository) is recorded to the diagnostic log only and the command continues, degrading to the same read-only fallback backend the scan would otherwise have used. Nothing about this step can fail the command.

Two reasons this is ordered ahead of the scan:

- The repo-hooks inventory item is discovered via the shared installation-status query, which reads the stored-memory count. Performed without an established backend, that read emitted a *write-oriented* fallback warning into the diagnostic log ("folder-mode users will miss this write") even though the scan only ever reads — misleading noise for anyone debugging an uninstall. Establishing the backend first removes it. (The warning only ever appeared when the durable memory branch already existed, so a repository that had never generated a memory never produced it.)
- The stored-memory count reported by that status query is now read through the **user's actual backend** — dual-write, folder-only, or branch-only — rather than through the branch-only fallback, so a folder-mode user's count is correct.

Because the step precedes scope validation, the backend is still established for an invocation that then rejects an invalid scope value and exits non-zero. The process-wide backend selection is not restored afterward; it stands for the remainder of the invocation.

### Invocation

- Default (no flags): scan, print the full grouped inventory restricted to the requested scope, then prompt interactively for which numbered items to remove (or "all"), then prompt a second time to confirm the actual deletion.
- A dry-run flag: scan and print the inventory and the count that would be removed; never deletes anything and never prompts.
- A "yes"/skip-confirmation flag: scan, print the inventory, and remove every listed item without prompting. Required to do any real removal in a non-interactive context (no controlling terminal on stdin) — without it, a non-interactive invocation refuses to delete anything and exits with a non-zero code, directing the user to the skip-confirmation flag or dry-run.
- A scope-limiting option restricting the inventory to only machine-global surfaces, only current-project/current-repo surfaces, or both (the default). An invalid scope value is rejected immediately, before any scanning occurs, with a non-zero exit.
- A working-directory option, defaulting to the auto-resolved repository root, that determines which repository's project-state and repo-hooks items are scanned.

### Inventory presentation

The inventory is printed with a header, then one section per non-empty group (in the fixed group order above) listing each item's running index, label, optional parenthesized detail, and path on the following indented line. After the groups, a "Preserved (never removed)" section lists the fixed exclusion notes. If the scope-filtered inventory is empty, a single "nothing found" line is printed and the command stops — no prompts, no dry-run message.

### Interactive selection and confirmation

When neither dry-run nor the skip-confirmation flag is given (and a controlling terminal is present):
1. The user is prompted to enter item numbers (comma- or space-separated), the literal "a"/"all" for everything, or blank to cancel. Out-of-range or non-numeric tokens are ignored; if nothing valid remains, the whole answer is treated as invalid — same as blank — and the run is cancelled with nothing removed.
2. If a non-empty valid selection was made, a second prompt asks the user to confirm removing exactly that many items. Only an affirmative "y"/"yes" (case-insensitive, trimmed) proceeds; anything else — including blank — aborts with nothing removed.

The skip-confirmation flag bypasses both prompts and targets every item in the scope-filtered inventory.

### Removal mechanics

Each targeted item is removed independently; a failure on one item does not stop the rest:
- Plain file/directory items are deleted recursively and forcefully (a missing path is not an error).
- After deleting an editor-extension item specifically, the host editor's installed-extensions manifest (a JSON array recording what's installed, sitting alongside the extensions folder) is reconciled: any entry pointing at the just-deleted folder name is dropped and the manifest rewritten. This reconciliation is itself fault-tolerant — a missing manifest, unparseable JSON, a non-array document, or a write failure are all silently tolerated (logged, not surfaced) because the folder deletion is the primary action; a manifest with no matching entry is left byte-for-byte unchanged.
- The repository hooks + repo-scoped-MCP item is not deleted as a file — it is dispatched to the same marker-aware hook-and-registration remover the per-repo disable path uses (see the hook-installation-orchestration and MCP-client-registration specs), which strips only the product's own managed sections/entries across every worktree of the target repository and leaves everything else (including machine-global MCP host entries) untouched.

### Outcome reporting

After attempting every targeted item, the command reports: a per-item success line, or a per-item failure line naming the item and its error; a total-removed count; and, if any items failed, a total-failed count with the list repeated, plus a non-zero exit code. A run where every attempted item fails, or where nothing was selected/targeted, does not count as a successful disable event.

Three conditional follow-up notes are printed based on which groups were actually removed:
- If the global configuration/state directory was removed: a warning that every *other* repository's hooks on the machine will start erroring on their next commit until that repository is separately disabled or uninstalled, because the shared hook entry scripts that all repos' hooks invoke live in that directory.
- If any editor-extension item was removed: a reminder to restart any open window of that editor family, because a still-running editor process may rewrite its own manifest on exit and undo the reconciliation.
- If the global command-line package was removed while running on the platform where a running executable cannot delete its own open files: a note that some files may linger until the current process exits.

## State Transitions

| Surface | Before | After successful removal |
|---|---|---|
| Editor extension folder | present, listed in editor's manifest | folder deleted; manifest entry reconciled away |
| IDE plugin folder | present | folder deleted |
| Global CLI package / shim | present | deleted; on one platform, in-use files may persist until process exit |
| Global config/state directory | present | deleted; every other repo's hooks begin erroring on next commit until separately handled |
| Project state directory | present | deleted |
| Repo hooks + repo-scoped MCP | installed | product-owned hook sections and repo-scoped MCP entries stripped via the shared remover; machine-global MCP entries and non-product hook content untouched |

## Notable Behavior

- **User memory is excluded by construction, not by a removal check.** The durable memory record and the user-facing memory folder are never scanned for and never appear as candidate items — there is no filter step that could be bypassed; the scanners simply never look there.
- **Machine-wide, not repo-scoped.** Unlike the per-repo disable path (which only ever touches the current repository), this command discovers and can remove artifacts belonging to every editor, every IDE, and the global package install, none of which are repo-specific.
- **The current-repo hook/MCP item reuses the disable path's own remover verbatim** rather than re-implementing hook-stripping or MCP-entry removal; this command is strictly an aggregator that adds the removal of everything the disable path never touches.
- **Global-scope MCP host entries are never removed**, even by this broader command — because the repo-hooks item delegates to the same repo-scoped-only removal logic the disable path uses, a machine-wide uninstall still leaves other repositories' MCP registrations for global hosts intact.
- **Removing global configuration knowingly breaks other repositories' hooks** until they are handled individually — this is a deliberate, explained trade-off (the shared hook entry scripts live there) rather than an oversight, and the command warns about it immediately after the fact.
- **Fork/editor data-folder names are not guessed** — they were verified against the real per-fork install location, including at least one fork whose folder name does not match its product name.
- **The IDE-plugin scan narrows one vendor-shared config root by a product-name prefix** to avoid mis-treating unrelated applications sharing that same vendor's configuration root as IDE products.
- **The global command-line package/shim discovery survives a hung or missing package-manager binary** via a hard time bound on the live root query, so the command (including its dry-run/preview mode, which still performs the full scan) cannot hang indefinitely waiting on it.
- **A run where nothing was actually removed does not emit a "surface disabled" telemetry event** — only genuine removals count, distinguishing a no-op/failed run from an actual opt-out.
- **Establishing the storage backend happens before scope validation, and can never fail the run.** A teardown that has already removed part of its own configuration still completes its scan on the read-only fallback backend; the only visible difference is one diagnostic-log line instead of a wrong-shaped warning.
- **Two-step confirmation** (select, then confirm the count) is stricter than the single-prompt confirmation used by the stale-data-cleanup command, reflecting that this command can delete far more — including entire editor extensions and the globally-installed tool itself.

## Shared Behavior

- The non-interactive refusal pattern (no controlling terminal, no skip-confirmation flag ⇒ refuse with a non-zero exit, point at the skip-confirmation and dry-run flags) is the same safety contract used by the stale-data-cleanup command.
- The working-directory resolution flag (defaulting to the auto-resolved repository root) is shared with most other sub-commands.
- The current-repo hook-and-MCP removal this command dispatches to is exactly the reversal described in the hook-installation-orchestration spec, including its per-worktree iteration and its policy of leaving skill files and the global-scope MCP entries untouched.
- The "surface disabled" telemetry event recorded on a successful removal is the same event the per-repo disable command records; both name-tag the event by cause (manual disable vs. this command) but share the same event type.
