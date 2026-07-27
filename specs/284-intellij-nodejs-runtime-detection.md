# 284. IntelliJ Node.js Runtime Detection and Hard Gate

## Topic Statement

The IDE plugin locates and verifies a usable Node.js runtime before any plugin logic runs, and blocks the entire plugin behind that check. Because a GUI-launched IDE (Dock, Launchpad, desktop shortcut) inherits a minimal environment whose PATH omits Node installed by version managers and package managers, a naive "spawn `node` and see" would report "missing" on machines that clearly have Node. Detection is therefore two-phase — gather candidate binaries from every plausible channel, then prove each candidate by actually executing it and reading its reported version — with a minimum major-version floor, a persisted winner for fast subsequent checks, an interactive retry, and a manual file-chooser fallback. When no usable runtime is found the plugin surfaces a blocking "Node.js required" panel and does nothing else.

## Scope

**In scope:**
- The two-phase detect flow: candidate discovery channels and their order, verify-by-execution, the minimum-version floor, first-match-wins.
- The verified-runtime record (path + reported version) and the rejected-candidate record (ran but too old), and how each is surfaced.
- The persisted detection result, the in-process cache (including negative caching), the fast re-verify path, and forced re-probe.
- The manual file-chooser fallback and its identical proof.
- The hard gate: which plugin entry points require a runtime, what happens when none is found, and the retry/manual paths that unblock.
- Shell-based PATH probing hardening (marker extraction, timeouts, shell-family differences).

**Out of scope (boundaries):**
- What the resolved runtime is *used for* — driving the bundled command-line tool's integrations enable/disable (MCP + skills) is owned by the IntelliJ MCP-and-skills integration spec; the full delegated install sequence is owned by the delegated-hook-installation spec (128); the long-lived bridge connection is owned by spec 288.
- Git and AI-agent hook installation, which runs the resolved **Node** runtime — the plugin has no Java entry point of its own, and the hooks it gets installed execute under Node as well (the delegated-hook-installation spec, 128).
- The per-project service lifecycle and the tool-window construction that host the gate — owned by the lifecycle and tool-window specs; this spec covers only the runtime check they consult.

## Data Contracts

### Verified runtime

A verified runtime is the absolute path to a Node binary plus the version string that binary reported when executed (e.g. a `v`-prefixed major.minor.patch). A binary is "verified" only after it actually ran and answered with a parseable version at or above the minimum supported major.

### Minimum supported major

Detection enforces a minimum Node major version (the oldest major the bundled tool can run on). A binary that runs but reports an older major is **not** a successful detection — it is recorded as a rejected candidate, and a newer install found through a later channel can still win.

### Rejected candidate

A candidate that ran and reported a version but fell below the minimum is captured as a path + version pair and exposed to the UI, so a machine that has an old Node gets a specific, actionable message ("v14 at /path — too old, install 18+") instead of a bare "no Node found," which reads as a bug on a machine that clearly has Node. The rejected list is reset at the start of each probe, is empty when detection has never run / succeeded on the fast path / succeeded on the first candidate / no candidate answered at all, and is cleared when a manual pick is adopted.

### Persisted detection record

A successful detection is persisted in the machine-global configuration directory as a path, version, source, and timestamp, where the source distinguishes an automatically detected binary from a manually chosen one. Readers ignore the source; it exists so a later re-verify that rewrites the record (e.g. a patch upgrade under a manually chosen binary) preserves the original "manual" tag rather than silently reclassifying it as "auto." A negative outcome deletes any stale record so the fast path cannot resurrect a binary that just failed.

## Behavior

### Two-phase detection

Detection is synchronized (concurrent callers share one probe) and blocking (shell probes can take seconds on first run), so it runs off the UI thread. It returns the verified runtime or null.

1. **Fast path (unless a forced refresh).** Re-verify the binary recorded by a previous successful detection. If it still verifies, return it — skipping all shell probes. If its reported version drifted, rewrite the record but preserve its original source tag.
2. **Full probe.** Walk candidate binaries in order, verifying each. Stop at the first that verifies (first-match-wins). Collect too-old hits (de-duplicated by path) into the rejected list. On success, persist the winner; on total failure, log and delete any stale record.
3. Cache the outcome (positive or negative) for the process lifetime so repeated gate checks are cheap. A forced refresh re-runs the full probe (used by the Retry entry point after the user installs Node).

### Candidate discovery channels (in order)

1. The binary from the persisted record (fast path).
2. The IDE process PATH (correct when the IDE was launched from a terminal).
3. The login-shell PATH (loads the profile where package-manager installs live).
4. The interactive login-shell PATH (additionally loads the interactive rc file, the default home of the most common version manager's init line).
5. On the platform lacking a login shell: the official installer's registry record — which, unlike the process PATH snapshot taken at IDE launch, reflects an install performed *after* the IDE started (the Retry-button scenario).
6. Well-known install locations of the common distribution channels (system package dir, the two common package-manager prefixes, MacPorts, and the version managers nvm / nvm-fish / fnm / volta / asdf / mise / nodenv / n; on the other platform: Program Files locations, scoop, chocolatey, Volta, and the Windows version manager), with version-manager roots scanned newest-version-first.

Candidates are de-duplicated and filtered to files that exist and are executable before verification.

### Verify-by-execution

A candidate is proven by executing it to print its version. Existence or an executable bit alone is insufficient (broken symlink targets, wrong-architecture binaries). The outcome is one of: **usable** (verifies at or above the floor — wins), **too old** (runs but below the floor — recorded as rejected, does not win), or **not usable** (does not run or prints no version — silently skipped). Version probing enforces a hard timeout with a wait-then-read-then-force-kill order so a hanging process cannot wedge detection.

### Shell PATH probing hardening

Shell probes wrap the printed PATH in sentinel markers so rc-file noise (echoes, warnings, prompts) cannot corrupt the extracted value; the extractor takes the last start marker and the first end marker after it. Probes close the child's input so an interactive shell cannot wait for input, and enforce a hard timeout with force-kill. They use the correct syntax for the user's shell family (the list-valued PATH of one shell family versus the colon-string of POSIX shells), and fall back to a shell that actually exists on the host when the user's shell is unset or unusable. Shell families that reject the flag combination print no marker and degrade cleanly to the well-known-directory channel.

### Manual selection fallback

When no automatic channel yields a runtime, the blocking panel offers a file chooser filtered to a Node binary name. A picked file is validated with the **same** execute-and-check-minimum-version proof as automatic detection, so a wrong pick can never unblock the plugin. On acceptance it is recorded (tagged as manually chosen), becomes the in-process result, and clears any stale rejected candidates. Rejections report a specific reason: too old (with the version), ran-but-not-Node, or not an executable file.

### The hard gate

A verified runtime is required before any plugin logic runs. Both the per-project service initialization and the project-open startup activity consult detection up front and **stop** when it returns null — no hooks, no memory-bank folder, no watchers, no sync. The tool window mirrors this: when no verified runtime is cached (a non-blocking check safe on the UI thread) it shows a blocking "Node.js required" panel instead of the plugin UI, re-probes in the background (sharing any probe already running so a window opened before the first probe self-heals into the full UI), and offers Retry (forces a fresh probe and, on success, completes the startup sequence the gate skipped), Choose-manually (the file-chooser fallback), and a Download-Node link. When detection failed only because every candidate was too old, the panel and the startup notification name the concrete versions and paths rather than saying "not found."

## State Transitions

```
never detected     → verified (persisted)        (a candidate proves out)
never detected     → not found                    (no candidate; negative cached; stale record deleted)
verified           → verified (fast path)         (recorded binary still proves out; cache hit)
verified (drifted) → verified (record rewritten)  (version changed; source tag preserved)
not found          → verified                     (Retry after install, or manual pick; startup completes)
too old only       → still blocked, specific msg  (candidates ran but below the floor)
```

## Notable Behavior

- **Detection is two-phase precisely because a GUI-launched IDE's PATH is not the user's shell PATH.** Merely finding an executable file is not proof it runs, and a naive spawn misses version-manager installs; the design gathers candidates broadly and proves them by execution.
- **The minimum-version floor is applied during verification, not after.** A too-old binary never counts as a detection, so a newer install elsewhere can still win — and the too-old finding is surfaced for an actionable message.
- **Both positive and negative outcomes are cached for the process lifetime**, so the many gate checks stay cheap; only a forced refresh re-probes.
- **The persisted "manual" source tag survives version drift**: a re-verify that rewrites a manually chosen record does not silently reclassify it as auto-detected.
- **Node is now a hard prerequisite for the whole plugin on this surface**, reversing the earlier "Java hooks work without Node" posture. The contrast is stronger than "installs no hooks": the hooks themselves *execute* under Node, so a machine without a usable runtime has **no memory generation at all** — not merely a skipped install. And because every data read the plugin performs beyond native git plumbing is a bridge call spawned under the same runtime, the gate is the precondition for the plugin's **reads** as much as for its writes (cross-reference the MCP-and-skills integration, delegated-hook-installation, bridge-connection, and lifecycle specs).

## Shared Behavior

- The resolved runtime path is consumed by **every** subprocess the plugin spawns, not only the integrations enable/disable: the long-lived per-project bridge server (spec 288), every one-shot bridge call that falls back from it, the AI-generation and Memory Bank migration one-shots, and the pending-push drain worker (spec 271). This spec only produces and gates on the runtime.
- The per-project service lifecycle and tool-window hosting that invoke the gate are owned by the lifecycle and tool-window specs.
- The persisted record lives in the same machine-global configuration directory used by the rest of the plugin's global state.
