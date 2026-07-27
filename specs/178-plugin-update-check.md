# 178. Plugin Update Check

## Topic Statement

Surface a one-shot stderr warning at CLI startup when a newer published version of the host CLI or any installed plugin exists on the upstream package registry, using a per-user on-disk cache refreshed asynchronously in a detached background process that never blocks the foreground command.

## Scope

**In scope:**

- The shape and location of the per-user freshness cache file.
- The freshness window (TTL) for that cache, including a shortened retry TTL when the last refresh was incomplete.
- The read-only foreground path: reading and validating the cache, then computing notices from it.
- The trigger for spawning a background refresh (cache stale + debounce not active).
- The cross-process debounce that collapses bursts of near-simultaneous refresh spawns to one.
- The detached background refresh itself: which packages it queries, how it persists results, what it preserves from the prior cache on partial failure.
- The hidden re-entry subcommand the background process invokes on itself.
- How the host CLI's "newer available" comparison is decided.
- How each installed plugin's "newer available" comparison is decided.
- The format and stream of the user-facing upgrade hint.
- Silent degradation when the cache, the registry, the network, the spawn, or the disk fails.

**Out of scope (boundaries):**

- How the local plugin discovery walk produces the per-plugin diagnostic snapshot (installed version, install hint, presence/compatibility state). The update-check consumes that snapshot read-only; see **Plugin Loader**.
- How the host CLI's running version is derived at build time.
- How the per-source dist-path registry chooses which locally-installed surface dispatches the CLI. The update-check deliberately ignores dist-path versions (other surfaces are independent release lines); see **Per-Source Dist-Path Version Selection**.
- The server-side `426 plugin outdated` flow, which is a different signal (the backend rejecting a request) on a different transport (HTTP response, not the package registry); see **Plugin Outdated Flow**.
- Version-comparison semantics (the two-tier rule, treatment of `dev`/`unknown`, treatment of prerelease and build-metadata suffixes); see **Per-Source Dist-Path Version Selection**.
- The mechanism by which the user actually upgrades (the hint is text only).
- The companion editor extension's update path (it is upgraded by its marketplace, not by this check).

## Data Contracts

### Cache file

A single JSON file under the per-user machine-global config directory. Its on-disk shape is an object with:

| Field        | Type                                    | Meaning                                                                                                                                          |
| ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `checkedAt`  | ISO 8601 string                         | Timestamp of the last successful refresh attempt.                                                                                                |
| `ttlHours`   | positive number                         | Freshness window in hours. Once the wall-clock age exceeds this, the foreground considers the cache stale and triggers a background refresh.     |
| `packages`   | object keyed by package name            | One entry per tracked package. Each entry is a sub-object with a single string field `latest` holding the registry's `latest` for that package. |

The cache stores **only the registry `latest`** per package. The locally-installed version of each tracked package is always read live by callers, never from this file — the cache can therefore never disagree with what is actually installed.

### Refresh sentinel file

A second file alongside the cache file in the same per-user config directory. It is a short text file whose body is the ISO timestamp of the most recent background-refresh spawn attempt. Its modification time is the authoritative timestamp consulted by the debounce check; the body is informational.

### Tracked package list

The set of package names whose registry `latest` is cached. It is computed per CLI invocation as the host CLI's package name (always present) plus the package name of every plugin whose diagnostic snapshot reports it as either installed-and-compatible or installed-but-incompatible. Plugins reported as absent are excluded.

### Plugin diagnostic snapshot (consumed read-only)

For each tracked plugin, three fields matter to this topic:

- The plugin's package name (cache key and display name in the hint).
- The plugin's locally-installed version (read live from the plugin's package descriptor by the plugin loader).
- A free-form shell command string the user is told to run to upgrade that plugin.

The state classifier (installed-and-compatible vs installed-but-incompatible vs absent) is used only to decide whether the plugin enters the tracked package list. The compatibility state itself is not surfaced by this topic.

### Hidden re-entry subcommand

A reserved subcommand name on the host CLI that is registered hidden from help. Its sole purpose is to be invoked by the detached refresh process spawned from the foreground. Its argument is the list of package names to refresh; if the list is empty it defaults to just the host CLI's package name. It is never user-invoked.

## Behavior

### Foreground entry: check-version on every invocation

Every CLI startup, after plugin discovery has produced the plugin diagnostic snapshot for this invocation, the update-check runs synchronously to completion **before** the command's action handler. It must not throw and must not block on network. A top-level catch swallows any failure.

The check is fully suppressed when either of the following holds:

1. The host CLI's build-time version is the `dev` placeholder (running from source, not a published build).
2. The current process's argv contains the hidden re-entry subcommand — i.e. this process is itself the detached refresh. This is the re-entrancy guard that prevents a spawn loop.

When the check is suppressed, no cache is read, no refresh is spawned, and no hint is printed.

### Read and validate the cache

The cache file is opened from its fixed location. Every failure is collapsed to "no cache":

- File missing, unreadable, or not parseable as JSON.
- Top-level JSON is not a plain object (e.g. an array, a number).
- `checkedAt` is not a string.
- `ttlHours` is not a number, or is not strictly greater than zero. A non-positive TTL is rejected because it would otherwise make every read look stale and trigger a refresh on essentially every command.
- `packages` is not a plain object.
- Any package entry's `latest` is not a string. (This is a leaf-shape check; the sole downstream consumer of `latest` is a version-comparator that calls a string method on it. A hand-edited or half-written numeric `latest` is treated as "no info" rather than allowed to throw later.)

Validation failure produces no cache (treated as `null`), which makes every subsequent decision behave as if the cache were missing.

### Decide whether the cache is stale

The cache is considered stale when any of the following holds:

- The cache is missing (validation produced `null`).
- The cache's `checkedAt` cannot be parsed as a date.
- The wall-clock age of `checkedAt` (now minus `checkedAt`, in hours) is greater than or equal to the cache's own `ttlHours`.

Note that the TTL is read from the cache itself, not from a global constant. This lets a single refresh round shorten its own next-retry window after a partial failure (see refresh-completeness rule below).

### Trigger a background refresh when stale

When the cache is stale, the check attempts to claim the right to spawn a refresh. The claim is an atomic cross-process check against the refresh sentinel file:

1. The sentinel file's parent directory is created if absent.
2. The check tries to create the sentinel exclusively (`O_EXCL`-style: succeed only if the file does not already exist). On success, it writes the current ISO timestamp and the claim is granted.
3. If exclusive creation fails with "already exists", the sentinel's modification time is read and compared against the debounce window. If the last attempt was less recent than the debounce window, the sentinel is renamed away and recreated with the current timestamp (taking over a stale sentinel); on success the claim is granted. If the rename fails (another process took the sentinel first), the claim is denied.
4. If exclusive creation fails for **any other reason** (read-only filesystem, broken parent, permissions error), the claim is **granted** — a sentinel that can never be written must not permanently suppress refreshing.
5. If the sentinel exists and a stat of it fails (concurrent removal between the exists-check and the stat), the claim is denied — another process is actively managing it.

The debounce window is a fixed duration **substantially longer** than the per-package registry-query timeout (see below), so an in-flight refresh has time to finish and rewrite the cache before the next claim attempt re-evaluates staleness.

When the claim is granted, the foreground spawns a detached child process and immediately unrefs it so the foreground exits without waiting. The child process is the same CLI executable re-invoked with the hidden re-entry subcommand and the full tracked package list as positional arguments. The child's standard streams are routed to a null sink; its working directory and environment are not specially configured beyond the process defaults. Any failure to spawn is logged at debug level only and swallowed; the foreground continues regardless.

When the claim is denied (debounced or lost a race), no spawn occurs; the foreground continues with whatever the cache currently holds.

### Atomicity of the debounce claim — notable

The debounce uses an atomic exclusive-create rather than a "stat then write" pair because the latter is not atomic across processes: every racer in a burst would each see "no recent attempt" and each write the sentinel, defeating the debounce. With the atomic claim:

- **Common absent-sentinel burst:** exactly one of N simultaneous callers wins the exclusive create; the rest get "already exists" and fall through to the freshness check, where the just-written sentinel reads as recent, so they back off.
- **Stale-sentinel takeover:** the rename removes the source, so exactly one stale racer succeeds; the rest get "not found" on rename and back off. A racer that re-creates the sentinel in the sub-millisecond gap between the rename and the rewrite could double-claim; that residual race is intentionally accepted — the only cost is one extra background refresh process, and the burst is still collapsed from N to roughly one.

### Compute the user-facing notices

Independently of whether a refresh was spawned this invocation, the check computes notices from the **current** (possibly stale, possibly absent) cache:

1. **Host CLI notice.** Look up the host CLI's package name in the cache's `packages`. If a `latest` is present and that `latest` is strictly greater than the running version (per the project's shared version-comparison rule), emit a one-line notice naming the package, both versions, and a shell command to upgrade globally. Otherwise emit nothing for the host. When the cache is null or the host's entry is absent, emit nothing — the host is treated as "no info" rather than guessed.
2. **Per-plugin notices.** With the cache null, emit no plugin notices at all. Otherwise iterate each installed plugin's diagnostic snapshot (in the order the plugin loader produced them). Skip any plugin whose cache entry is missing or whose installed version is unknown. When the cached `latest` is strictly greater than the plugin's installed version, emit a one-line notice naming the package, both versions, and the plugin's own install-hint shell command.

### Print the notices

When at least one notice was produced, write a single block to **stderr** consisting of a leading blank line, the literal heading `Warning:` on its own line, then each notice indented by two spaces on its own line, then a trailing blank line. When no notices were produced, nothing is written.

The block goes to stderr deliberately so it does not contaminate any structured stdout the command may produce.

### Detached refresh: the work the spawned child does

When the hidden re-entry subcommand runs (whether spawned by the foreground or, hypothetically, invoked any other way), it performs exactly one round of registry refresh:

1. Build the package list. The list is the positional arguments to the subcommand; if no arguments were given, the list defaults to a single entry — the host CLI's package name.
2. Read the existing cache (best-effort, validation as above). The new cache's `packages` map starts as a shallow copy of the existing one — so a package whose query fails this round keeps its previously-cached `latest` instead of being evicted.
3. For each package in the list, query the upstream package registry **in parallel** for the package's `latest` version. Each query is independent and bounded by its own hard timeout (a small number of seconds). Concurrency is required because serial queries would stack timeouts and could approach the debounce window on a registry outage. The aggregate await tolerates any individual query rejection — a single failed query never discards the rest.
4. For each query result that is a non-empty string, overwrite that package's entry in the in-progress `packages` map with `{ latest: <string> }`. A null or rejected result does nothing (the prior-cached value, if any, survives).
5. Determine refresh **completeness**: complete if and only if every package in the requested list now has an entry in the in-progress `packages` map (either freshly fetched this round, or preserved from the prior cache). A list that contains a package which has never had a cache entry and whose query failed this round is **incomplete**.
6. Decide the new TTL:
   - Complete refresh → the standard freshness window (24 hours).
   - Incomplete refresh → a much shorter retry window (1 hour), but never exceeding the standard window. The shorter window ensures a transient registry failure on a fresh install or a just-added plugin doesn't suppress that package's update notice for a full day; a permanently-unresolvable package therefore costs at most one background refresh per retry window, not one per command.
7. Construct the new cache object with `checkedAt` set to the current time as an ISO string, the chosen `ttlHours`, and the in-progress `packages` map.
8. Persist atomically. The cache directory is created if absent. The new JSON is written to a per-process temp file beside the destination (its name includes the writer's process identifier and current time, so two concurrent writers cannot collide on the temp name). The temp file is then renamed onto the destination. On rename failure the temp is best-effort deleted to avoid leftovers, and the failure is swallowed (logged at debug level only). On any other persistence failure, the computed cache is still returned by the in-memory function but nothing is written.
9. The detached process then exits. Its output streams were discarded by the spawn, so nothing it logs reaches the user's terminal.

### Default registry query

Each individual `latest` query is performed by invoking the host's package manager command-line in `view <pkg> version` mode, with the per-query timeout. The standard output is trimmed; an empty trimmed result, a non-zero exit, or a timeout yields `null` for that package. The implementation defers to the project's shared package-manager runner, which is also responsible for cross-platform shell handling.

### Endpoint not configurable

This topic does not define the registry URL. The registry is whichever upstream the host's package manager is currently configured to use (system or user defaults). No environment variable or flag inside this topic overrides it.

### No opt-out

There is **no user-facing environment variable or flag** to disable the update check at runtime. The only suppression paths are the two re-entrancy/dev guards listed under "Foreground entry" (build is `dev`, or the current process is itself the detached refresh). A user who wants to silence the warning must upgrade.

### Failure mode summary — notable

Every failure path in this topic degrades silently:

- Cache missing, corrupt, partially valid, or written by a different schema → treated as `null`; no host notice, no plugin notices, but a refresh is still triggered next time the foreground runs.
- Sentinel file unwritable → claim is granted; the only cost is no debounce on that machine.
- Sentinel removal race → claim is denied; the next invocation will see the rewritten sentinel and decide afresh.
- Background spawn fails → swallowed; the cache simply does not refresh this round. On the next invocation the cache is still stale and another spawn is attempted (subject to debounce).
- Individual registry query fails → that package's prior-cached `latest` survives; if there was no prior, the refresh records itself as incomplete and the next invocation retries within the shorter retry window.
- All queries fail and there is no prior cache → the persisted cache contains an empty `packages` map and the short retry TTL; no notices are emitted; the next invocation retries soon.
- Atomic write fails (rename collision, mkdir failure, disk full) → swallowed; the in-memory cache exists for the child's own logging but nothing is persisted. The cache stays at its prior state on disk.
- Top-level exception anywhere in the foreground check → swallowed; the command continues normally with no notices.

The contract is: **the version check must never block CLI execution**.

## State Transitions

The cache file's lifecycle, per package entry, is:

1. **Absent.** No file or no entry for this package. → A foreground invocation reads no info, emits no notice, and (subject to debounce) triggers a background refresh.
2. **Recorded (fresh).** Entry exists and `checkedAt` is within `ttlHours`. → Foreground reads the entry, may emit a notice, does **not** trigger a refresh.
3. **Recorded (stale).** Entry exists but `checkedAt` is older than `ttlHours`. → Foreground reads the entry and may emit a notice, **and** (subject to debounce) triggers a refresh.
4. **Recorded with short TTL.** A prior refresh round was incomplete — at least one requested package had no entry at all (no prior, query failed). The whole cache (not just the offending entry) carries the short retry `ttlHours`. → The next invocation will treat the cache as stale much sooner.

The refresh sentinel file's lifecycle is:

1. **Absent.** No prior refresh attempt in living memory.
2. **Fresh (recent stamp).** A refresh was attempted within the debounce window. New refresh claims are denied while in this state.
3. **Stale.** A refresh was attempted longer ago than the debounce window. The next claim attempt takes the sentinel over via atomic rename and the cycle restarts.

The cache file and the sentinel file are independent — a successful refresh updates the cache's `checkedAt`, while the sentinel records only spawn-attempts (whether or not those attempts produced a usable refresh).

## Notable Behavior

- **Foreground reads cache only, never network.** The foreground path never blocks on the registry. The cache is the only data source for the comparison. (Notable.)
- **Detached refresh, not foreground refresh.** The refresh is a re-invocation of this CLI as a detached child process with the hidden re-entry subcommand. The foreground exits without waiting for the child. This mirrors the same fire-and-forget pattern used elsewhere in the product for hook-driven work. (Notable.)
- **Re-entrancy guard via argv.** The detached child is the same executable as the foreground. To prevent it from itself trying to do its own update check (and spawning yet another child), the foreground check examines argv for the hidden re-entry subcommand and short-circuits when found. (Notable defensive.)
- **No opt-out env var.** Unlike the plugin discovery walk (which has its own kill switch), the update check has no user-facing toggle. Only `dev` builds and the re-entrancy guard suppress it. (Notable.)
- **24-hour default freshness; 1-hour incomplete-refresh retry.** A normal cache stays fresh for a day. A refresh that left **any** requested package with no entry at all (not even a prior-cached one) is recorded with the much shorter retry window so the missing data is retried soon rather than suppressed for a day. (Notable.)
- **The short retry TTL is capped by the standard TTL.** A future configuration that lowered the standard TTL below the short retry window would still see the short window honored at no more than the standard. The retry never widens the freshness window. (Notable.)
- **Prior-cache fallback on partial registry failure.** Within a single refresh round, a package whose query fails keeps its previously-cached `latest` instead of being dropped. A transient registry outage must not silently suppress a known update notice. The fallback is per-package: each entry survives or is replaced independently. (Notable.)
- **Atomic JSON write via temp+rename.** Two concurrent detached refreshes (no cross-process lock on the cache file itself, only the sentinel) could otherwise interleave their writes and leave half-written JSON that the next read rejects. The temp file's name embeds the writer's process identifier and current time to avoid name collisions between concurrent writers. (Notable.)
- **Debounce is atomic via exclusive-create + rename.** A naive stat-then-write debounce loses to a burst of simultaneous callers. Exclusive create gives the absent-sentinel burst exactly one winner; rename for stale takeover gives the stale-sentinel race exactly one winner (minus a residual sub-millisecond gap that is accepted). The debounce window is generously longer than the per-query timeout so an in-flight refresh has time to land. (Notable.)
- **Dist-path versions are deliberately ignored.** The CLI and the editor extensions are independent release lines. A surface's locally-recorded dist-path version is **that surface's** release number, not a comparable host-CLI version. Feeding it into this comparison would produce a phantom "newer CLI" notice that actually reported the editor extension's version. The registry is the only authoritative source for the host CLI. (Notable; bug-fix rationale.)
- **No installed-and-compatible filter on plugin notices.** A plugin reported as installed-but-incompatible is still included in the tracked package list and still surfaces an upgrade notice if a newer version exists. (An incompatible plugin is more, not less, deserving of an upgrade hint.) Only plugins reported as fully absent are excluded. (Notable.)
- **Plugin notice requires both a cached `latest` and a known installed version.** A plugin whose package descriptor was unreadable (no installed version) produces no notice even when the cache has a `latest` for it — there is nothing to compare against. (Notable.)
- **Host notice uses a global-install upgrade command; plugin notice uses the per-plugin install hint.** The two install commands are independent strings; the plugin's is whatever the plugin's registry entry declares. (Notable.)
- **Warning to stderr, not stdout.** The block is preceded and followed by blank lines for terminal readability. Structured stdout (JSON output, piped content) is never contaminated. (Notable.)
- **No retry, no acknowledgment.** Once the notice is printed, it is printed; the next CLI invocation prints it again if the cache still says a newer version exists. There is no per-machine "user dismissed" state. The way for the user to silence the notice is to upgrade. (Notable.)
- **Companion editor extension does not use this path.** The editor extension that bundles this CLI gets its own updates via its marketplace; the update-check module is not used in that surface. (Notable parity fact.)
- **Per-query timeout is bounded; aggregate refresh is bounded.** Each individual registry query has a small hard timeout (single-digit seconds). Failed queries do not retry within a round. A worst-case round of many packages on a dead registry completes in roughly the per-query timeout (parallel), not the sum. (Notable.)

## Shared Behavior

- The per-user machine-global config directory that holds the cache file and sentinel file is defined by the convention used throughout the product for machine-global state (auth tokens, dist-path indirection, hook entry scripts). See **Per-Source Dist-Path Version Selection**.
- The plugin diagnostic snapshot consumed by this check (package name, install hint, installed version, presence/compatibility state) is produced by **Plugin Loader**. This topic treats it as an opaque, read-only input.
- The version comparison used by both the host-CLI and per-plugin notices (treatment of `dev`/`unknown`, treatment of prerelease and build-metadata suffixes, ordering) is defined by **Per-Source Dist-Path Version Selection**. Only the sign of that comparison is consulted here; a `latest` carrying build metadata therefore compares equal to the same version without it and produces no notice.
- The server-side `426 plugin outdated` mapping is an unrelated signal on a different channel (HTTP request rejection vs. published-registry freshness) and is defined by **Plugin Outdated Flow**.
- The hidden subcommand reservation pattern (a command registered hidden from help, never user-invoked, used as a re-entry point by a spawned child) follows the same convention as the post-commit-driven queue worker. The detached-spawn-then-unref pattern is the same as that worker's launch. See the queue-worker specs for the canonical description.
