# Npm Postinstall Dist-Path Refresh

## Topic Statement

After a global install, update, or upgrade of the standalone CLI package via npm, a postinstall step refreshes the standalone-CLI's per-source registry entry to point at the newly installed distribution directory and rewrites the three dispatch scripts so that the per-user state directory at `~/.jolli/jollimemory/` immediately reflects the new package without requiring the user to run any explicit enable command.

## Scope

**In scope:**
- When the postinstall step runs (the npm postinstall lifecycle event of the standalone CLI package, fired after `npm install -g`, `npm update -g`, and equivalent upgrade flows).
- What it does (rewrites the three dispatch scripts; runs the one-time legacy-to-per-source migration; offers the standalone-CLI's per-source registry entry under the fixed source tag `cli`, with the new version and the new distribution directory, subject to the registry's keep-existing gate).
- Skip conditions:
  - The user has not previously enabled the product (the per-source registry directory does not exist and no legacy single-file is present) — silent skip.
  - The install is project-local (the package was installed under a project's `node_modules/` rather than globally) — silent skip.
  - The machine-global registry lock could not be acquired — silent skip of the entire refresh sequence.
- Failure mode (every operation is wrapped so that any error is silently swallowed; npm install is never blocked).
- The absence of any removal logic in this step (the postinstall does not enumerate or delete other sources' entries, does not validate the registry as a whole, and does not modify the dispatch scripts beyond rewriting them in place).

**Out of scope:**
- The dispatch scripts themselves (covered by the dispatch-script-generation topic).
- The per-source registry layout, version-comparison rule, and one-time migration mechanics (covered by the per-source dist-path version-selection topic).
- The first-time enable command that initially populates the per-user state directory (covered by the enable topic).
- IDE extension activation, which is the analogous refresh path for non-CLI sources.

## Data Contracts

### Inputs

The postinstall step takes no explicit arguments. It derives its inputs from its own runtime context:

- The absolute path of its own distribution directory — the directory containing the package's compiled entry points after npm extracted the package into the global install location. This becomes the value written into the standalone-CLI's per-source registry entry.
- The version of the standalone CLI package — the product core version baked into the package at build time. This becomes the version line in the per-source registry entry.
- The current working directory at the time of invocation — used solely to detect a project-local install.
- The user's home directory — used to resolve the per-user state directory at `~/.jolli/jollimemory/`.

### Outputs

The postinstall step produces no standard-output text under any circumstance and is permitted to write only to standard error (and only via the underlying writers' diagnostics, which themselves are warnings on filesystem failure). It is silent on the npm install console.

The persistent outputs on the filesystem are:

- The three dispatch scripts under `~/.jolli/jollimemory/` (brought to their canonical content for this product version; a file already matching is not rewritten, but its executable permission is re-asserted).
- The standalone-CLI registry entry at `~/.jolli/jollimemory/dist-paths/cli` — **offered** the new version and the new distribution directory. Whether the entry actually moves is decided by the registry's keep-existing gate, not by this step (see below).
- Possibly the deletion of the legacy single-file `~/.jolli/jollimemory/dist-path` if it was present and the migration step processed it.

### Skip-detection inputs

To decide whether to skip, the postinstall reads:

- Whether `~/.jolli/jollimemory/dist-paths/` exists as a directory.
- Whether `~/.jolli/jollimemory/dist-path` exists as a file (the legacy single-file format).
- Whether its own distribution directory is a descendant of `<cwd>/node_modules/`.
- Whether the machine-global registry lock, held in the same per-user state directory, can be acquired within its wait budget.

## Behavior

### When the postinstall runs

The postinstall is the npm-defined postinstall lifecycle script of the standalone CLI package. Npm fires it automatically after the package's files have been extracted and linked into the install location. The flows that trigger it include:

- Global install (`npm install -g`) of the standalone CLI package.
- Global update (`npm update -g`) of the standalone CLI package.
- Equivalent upgrade flows handled by alternate package managers that honor the npm postinstall hook.

The postinstall is also fired during a project-local install (`npm install --save-dev` or similar). The skip logic below ensures it is a no-op in that case.

### Skip condition: not yet enabled

The postinstall first checks for any sign that the user has previously opted in to the product:

1. Does `~/.jolli/jollimemory/dist-paths/` exist?
2. Does `~/.jolli/jollimemory/dist-path` (the legacy single-file) exist?

If neither check succeeds, the postinstall returns silently without creating any state. A first-time user installs the package, the postinstall does nothing, and the user later runs the explicit enable command to opt in. This avoids surprising side effects on the user's home directory at install time.

### Skip condition: project-local install

If the postinstall's own distribution directory is a descendant of `<cwd>/node_modules/`, the install is project-local rather than global, and the postinstall returns silently. A project-local install must not affect the user-global registry. Detection is by absolute-path prefix comparison (the distribution directory's absolute path begins with `<cwd>/node_modules/`, on either Unix or Windows path separators).

This rule also incidentally skips development environments where the parent project consumes the CLI as a workspace dependency, since those environments' compiled distribution lands inside a sub-`node_modules/` of the workspace root.

### Skip condition: registry lock unavailable

The three refresh steps below are not independent — a rewritten dispatch script, a migrated legacy entry, and a fresh `cli` entry must land as one consistent picture of the shared runtime registry. The whole sequence therefore runs while holding the **machine-global registry lock** in the per-user state directory, the same lock every other registry writer on the machine holds.

The lock is strict: if it cannot be acquired within its wait budget, **none** of the three steps runs. The postinstall does not fall back to doing the work unlocked and does not retry. It stays silent and still exits successfully, so the outcome from npm's point of view is indistinguishable from the other two skips. The user's registry keeps whatever the surface holding the lock leaves behind, and the next explicit enable (or the next upgrade) performs the refresh.

### Refresh sequence

When no skip condition fires and the registry lock is held, the postinstall executes three steps in order:

1. **Refresh the three dispatch scripts.** Run the dispatch-script writer, which brings the three executable shell scripts under `~/.jolli/jollimemory/` to their canonical content for this product version — writing only those whose content differs, and re-asserting the executable permission on all three regardless. This step runs **before** the per-source entry is written so that even if the per-source write later fails, the dispatch scripts already match this version's expected behavior — a partial success is preferable to leaving the scripts stale.

2. **Run the one-time legacy migration.** If a legacy single-file `~/.jolli/jollimemory/dist-path` exists, migrate it into the per-source layout under the appropriate target tag (per the migration rules covered by the per-source dist-path version-selection topic) and delete the legacy file. If no legacy file exists, this step is a no-op. Without this step an `npm update` would leave the legacy file as a dead artifact, since the new dispatch scripts no longer read it.

3. **Offer the standalone-CLI's per-source entry.** Present `~/.jolli/jollimemory/dist-paths/cli` with the new version and the new distribution directory. The fixed source tag for the standalone CLI is `cli`. The write is **not** an unconditional overwrite: the registry's keep-existing gate decides. If the currently recorded `cli` distribution still holds the complete runtime entry set **and** its recorded version is greater than or equal to the newly installed package's, the recorded entry is left pointing at the **old** distribution and the postinstall still reports success. Identical content is likewise never rewritten.

   Two consequences follow directly. A **same-version reinstall to a different global path** does not move the `cli` entry — the old path stays recorded as long as it is still complete on disk. And a **downgrade** (installing an older package over a newer one) does not move the entry either, so dispatch keeps resolving to the newer distribution until that distribution is removed from disk or its entry is pruned.

### Failure mode

Every step in the refresh sequence is wrapped at its own writer level so that any filesystem failure is logged at most as a warning and surfaces upward as a boolean failure indicator. The top-level postinstall additionally wraps its entire execution in a final catch that swallows any thrown error. A failure to acquire the machine-global registry lock is not an error at all — it is a clean, silent skip of the whole sequence. The net effect is that the postinstall **cannot** propagate a non-zero exit status to npm: any kind of failure (permissions, full disk, missing parent directory, race with another process) produces a silent skip rather than a failed `npm install`.

This is a deliberate trade-off. A failed `npm install` would be highly visible and disruptive for an opt-in product feature; a missed dist-path refresh is recoverable by running the explicit enable command later. The postinstall therefore prioritizes never blocking npm.

### No removal, no validation, no cross-source action

The postinstall scope is intentionally narrow:

- It does **not** enumerate other sources' per-source entries, does **not** check whether they still point at valid distributions, does **not** resolve the current winner, and does **not** delete stale entries.
- It does **not** validate that the dispatch scripts already on disk are well-formed; it simply compares them against the canonical content for this version and replaces the ones that differ.
- It does **not** create the per-user state directory if it does not already exist (by virtue of the not-yet-enabled skip), so installing the package without enabling never has any side effect on the user's home directory.

The single-source-of-truth principle is preserved by relying on the dispatch scripts (rewritten in step 1) to perform the per-dispatch enumeration and selection at runtime. The postinstall only refreshes the standalone CLI's contribution.

## State Transitions

For the standalone-CLI's per-source registry entry, the postinstall drives this transition:

- **Absent** (user has previously enabled but no `cli` entry exists, e.g. they originally enabled via an IDE extension only and have just installed the standalone CLI globally for the first time) → **Present, version V1, distribution D1** (after a successful refresh).
- **Present, version V0, distribution D0** → **Present, version V1, distribution D1** (after a global upgrade, where V1 is newer than V0 — or where D0 is no longer a complete distribution on disk).
- **Present, version V0, distribution D0** → **unchanged** (the keep gate declined: D0 still holds the complete runtime entry set and V0 is greater than or equal to the newly installed version). This covers a same-version reinstall at a new global path and any downgrade.
- **Present, version V0, distribution D0** → **Absent** (npm uninstall removes the package; the postinstall has no role here).

For the dispatch scripts under `~/.jolli/jollimemory/`, the postinstall drives:

- **Stale (pre-upgrade content)** → **Refreshed (current-version content)** — only the files whose content actually differs are rewritten; all three have their executable permission re-asserted either way.
- **Current content, executable bit stripped** → **Current content, executable** — no content write, permission restored.

For the legacy single-file `~/.jolli/jollimemory/dist-path`:

- **Present** → **Absent** (the migration step processes it on first refresh after upgrade and deletes it).

## Notable Behavior

### The refresh is opt-in-respecting

The not-yet-enabled skip means a user who installs the standalone CLI globally without ever running the enable command has no `~/.jolli/jollimemory/` directory created. The product remains entirely invisible until the user explicitly opts in. This is consistent with the product's general posture of not silently modifying the user's environment.

### Project-local installs share the package binary but not the registry

A `npm install --save-dev @jolli.ai/cli` inside a user's project produces a working `jolli` binary under that project's `node_modules/.bin/`, which the user can invoke directly. The postinstall's project-local skip prevents that install from rewriting the user-global registry — the user-global `cli` entry continues to point at the previously-installed global package (if any). A user who wants the project-local install to be the global winner must install it globally instead.

### A failed refresh is silently recoverable

If the postinstall fails (permissions, full disk, race), the user's `npm install` succeeds and the package binary is functional. The user can re-trigger the refresh at any time by running the enable command, which performs the same writes plus additional first-time-setup work. There is no error message at install time pointing at the recovery action; it is documented but not surfaced.

### A refresh does not guarantee the entry moves

The postinstall's job is to *offer* the newly installed distribution, not to force it. When the recorded `cli` distribution is still complete on disk and at least as new, the registry keeps it and the postinstall reports success. This is what makes reinstalling the same version at a new global path a no-op for dispatch, and it is why "I reinstalled and it still runs the old copy" is expected behavior rather than a fault: the old copy is still complete, still recorded, and still at least as new. Removing the old distribution directory (or letting the next install/enable sweep prune it) is what releases the slot.

### Dispatch scripts are rewritten before the per-source entry

The order matters: dispatch scripts first, per-source entry second. If only the per-source entry were updated and the dispatch scripts were not, a registry entry might be picked up at runtime by old scripts that expect a different format or call into different binary names. The reverse order — scripts first, entry second — guarantees that even a partial postinstall that fails after step 1 leaves the system on the new dispatch logic, which can correctly read entries written by other sources at the new format. The new `cli` entry follows but is not strictly required for correctness if other sources are already registered.

### The migration is run on every postinstall, not only on first

The migration step is idempotent: after the legacy file is deleted, subsequent runs see no legacy file and return immediately. There is no separate "have I migrated?" flag. This keeps the postinstall stateless and self-correcting in the rare scenario where an older product version somehow recreates the legacy file between two upgrades of the current version.

### Postinstall and IDE-extension activation are symmetric

The postinstall is, for the standalone CLI, what IDE-extension activation is for an IDE source: a refresh path that writes that source's per-source entry on every invocation. The two paths share the same writers and produce the same kind of registry entries; the only differences are the trigger (npm lifecycle vs. extension activation) and the source tag (`cli` vs. an IDE-derived tag). The independence of sources is preserved: neither path knows about the other.

### No console output is produced

The postinstall produces no standard-output text under any condition. Npm install logs therefore remain clean. Diagnostics from the underlying writers (warnings on filesystem failure) go to standard error and are visible in npm verbose mode but absent in normal install output.

### No removal in postinstall implies stale entries persist across uninstall

Because the postinstall has no removal logic and npm uninstall does not invoke a corresponding pre-uninstall step in this product, uninstalling the standalone CLI globally leaves the `cli` entry on disk pointing at a now-absent distribution directory. The runtime missing-distribution filter (covered by the per-source dist-path version-selection topic) handles this correctly: such an entry is skipped at dispatch time. The registry self-heals at read time rather than at uninstall time.

## Shared Behavior

- **Per-user state directory at `~/.jolli/jollimemory/`** — the location of the dispatch scripts, the per-source registry, and the legacy single-file.
- **Dispatch script generation** — the writer invoked in step 1; covered by its own topic.
- **Per-source dist-path version selection** — the registry layout and migration rules invoked in steps 2 and 3; covered by its own topic.
- **Lock primitive registry** — the machine-global registry lock this step must hold, and the strict "not acquired means the guarded work does not run" semantics that turn contention into a silent skip here.
- **Enable command** — the explicit opt-in path that creates the per-user state directory and is the recovery mechanism after a silent postinstall failure or a lock-contention skip.
- **IDE-extension activation** — the analogous refresh path for non-CLI sources, sharing the same writers but driven by IDE lifecycle events.
- **Doctor command** — the diagnostic surface that can re-run refresh and migration on demand if the user suspects registry drift.
