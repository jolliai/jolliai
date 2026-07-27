# Shared Site Engine

## Topic Statement

A single per-user directory holding one pre-installed copy of the docs-framework dependencies, into which every project's staged build directory symlinks its node modules so that the dependency install cost is paid once and amortized across every project the user builds.

## Scope

**In scope:**
- The location and shape of the shared engine directory.
- The first-build bootstrap that creates and populates the engine.
- The hash-based freshness check that decides whether the engine needs reinstalling.
- The symlink that connects a project's staged build directory to the engine's installed dependencies.
- Cross-process safety: the lockfile that prevents two parallel builds from both reinstalling.
- Recovery behavior when the engine directory is deleted, corrupted, or its metadata is unreadable.

**Out of scope:**
- The actual list of dependencies the engine installs (defined by the renderer/framework module).
- The build/dev/serve commands that run inside the project (covered by the npm-runner topic).
- The site staging that produces the project directory the symlink lives in.
- The download mechanics of the npm package manager itself.

## Data Contracts

### Engine directory location

A fixed path under the user's home directory: `~/.jolli/site-engine/`. This is the single shared location across all of the user's projects.

### Engine package descriptor

A `package.json` written into the engine directory. Fields:

- **name** (required, fixed string): a constant identifier for the engine ("jolli-site-engine").
- **version** (required, fixed string): a constant version string used only to satisfy the package manager.
- **private** (required, true): prevents accidental publication.
- **dependencies** (required, map): a verbatim copy of the bundled dependency map declared by the renderer module.
- **devDependencies** (required, map): a verbatim copy of the bundled dev-dependency map declared by the renderer module.

### Engine metadata record

A small JSON record persisted as `engine.json` in the engine directory. Fields:

- **deps hash** (required, string): a 16-character truncated SHA-256 of the JSON-serialized union of the dependencies and dev-dependencies maps; used as the freshness key.
- **installed at** (required, ISO timestamp): when the install last completed.

### Lock file

A small file at `.install-lock` in the engine directory whose contents are the millisecond epoch timestamp of the lock acquirer. Existence of the file means an install is (or was) in progress.

### Project symlink

The file `node_modules` in the project's staged build directory, as a symbolic link pointing at the engine's `node_modules` directory. On platforms whose native symlink type for directories differs (notably the `junction` type on Windows), the platform-appropriate type is used.

## Behavior

### Freshness check

An install is needed if any of the following hold:

1. The engine metadata file is missing.
2. The engine's `node_modules` directory is missing.
3. The metadata file exists and parses, but its recorded deps hash differs from the freshly computed deps hash.
4. The metadata file exists but cannot be read or parsed.

If none hold, the engine is considered current and no work is done.

### First-time install / refresh

1. Run the freshness check; return success immediately if the engine is current.
2. Acquire the install lock (see "Locking"). If acquisition fails, wait for the lock; once it releases, re-run the freshness check before doing any work.
3. Create the engine directory if missing.
4. Write the engine package descriptor with the current dependency maps.
5. Run the package manager's install command in the engine directory; capture its combined output.
6. On non-zero exit: return failure with the captured output. Do not write metadata.
7. On success: write the metadata record (fresh deps hash, current ISO timestamp) and return success.
8. Always release the lock on exit (success, failure, or thrown error).

### Project symlink creation

For a given project build directory:

1. Compute the engine directory's `node_modules` path as the link target.
2. If a `node_modules` already exists in the project build directory, remove it — distinguishing between a real directory (recursive remove) and a symlink (single unlink).
3. Ensure the project build directory itself exists.
4. Create the platform-appropriate symbolic link from the project's `node_modules` to the engine's `node_modules`.

This is the only step a project needs after `ensureEngine` has succeeded.

### Locking

The install lock is a single file at a known path inside the engine directory:

1. Acquire by writing the file with exclusive-create semantics — the write fails if the file already exists.
2. The file's contents are the lock acquirer's millisecond timestamp at acquisition time.
3. On release, delete the file. Failures during release are tolerated.
4. Wait-for-lock polls the file every second for up to five minutes:
   - If the file disappears, return "lock available".
   - If the file's recorded timestamp is older than the five-minute timeout, treat the lock as stale: forcibly release it and return "lock available".
   - If the file is unreadable, treat as released and return "lock available".
   - On timeout, force release and return "still locked".

### Deps-hash computation

1. Build a single object whose properties are the union of dependencies and dev-dependencies (dev wins on key collision).
2. JSON-serialize it with default ordering.
3. Take a SHA-256 of the serialization.
4. Hex-encode and truncate to the first 16 characters.

Equal hash means equal dependency surface; any version bump changes the hash and triggers a refresh.

## State Transitions

A given engine directory transitions through:

- **Absent** → **Installing** when the bootstrap acquires the lock.
- **Installing** → **Current** when install succeeds and the metadata is written.
- **Installing** → **Failed** when install exits non-zero; the metadata is not written, so the next freshness check still reports "needs install".
- **Current** → **Stale** when the bundled dependency map changes (computed deps hash diverges from the stored one) or the `node_modules` directory is removed externally.
- **Current/Stale** → **Reset** when the user deletes the entire engine directory; the next build re-enters Installing and rebuilds from scratch.

A given project's `node_modules` symlink transitions through:

- **Absent** → **Linked** on the first project build that runs after the engine is current.
- **Linked** → **Stale-link** if the engine directory is moved or its `node_modules` is deleted; the link still exists but resolves to nothing. The next build replaces the link.
- **Linked** → **Replaced** if the project build runs again; an existing symlink is unlinked and a fresh one is created.

## Notable Behavior

### Single shared install for all projects

Every project the user builds shares the engine's installed dependencies. A project's build directory holds only its own generated source plus a one-entry symlink, so the on-disk cost per project is small even when the dependency tree is large.

### Refresh is automatic and content-addressed

When the bundled dependency map changes (a new release of the CLI ships a different version of one of the framework dependencies), the freshness check observes a hash mismatch and refreshes the engine before the build proceeds. The user takes no action; the cost is paid once, the next build, then amortized.

### Deletion of the engine directory is a supported recovery path

If the engine directory is deleted manually (disk pressure, troubleshooting, etc.), the next build's freshness check sees the metadata as missing and reinstalls from scratch. No state outside the engine directory needs cleaning.

### Failed install does not poison the metadata

If the install command exits non-zero, the metadata file is not written. The next build observes either missing metadata or a stale hash and retries cleanly. There is no half-installed state where the metadata claims success but the dependencies are incomplete.

### Lock-wait re-checks freshness before working

A process that found the lock taken does not assume an install is needed once the lock releases — it re-runs the freshness check. The common case is that the lock-holding process just installed exactly what this caller needed, and the second caller short-circuits with no install at all.

### Stale-lock timeout

A lock older than five minutes is considered abandoned (the holder crashed or was killed). The next caller force-releases and proceeds. This trades a small risk of two installs racing under extreme conditions for guaranteed forward progress when a previous build died holding the lock.

### Symlink type on Windows

The link is created with the directory-junction type rather than the default symbolic link type because that type does not require elevated privileges. Other platforms use the standard directory-symlink type.

### Best-effort lock release on errors

The lock-release call is wrapped so that filesystem errors during release do not propagate; the worst case is a stale lock file that the next caller's timeout handles.

## Shared Behavior

- **Renderer dependency manifest** — the canonical source of the dependency and dev-dependency maps the engine installs.
- **npm runner** — the small wrapper that runs install, build, dev, and serve commands; invokes the engine bootstrap before per-project commands.
- **Project staging** — the upstream pipeline that creates the project build directory the symlink lives inside.
