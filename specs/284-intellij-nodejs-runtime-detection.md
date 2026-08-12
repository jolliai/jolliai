# 284. IntelliJ Node.js Runtime Detection and Hard Gate

## Topic Statement

The IDE plugin locates and verifies a usable Node.js runtime before any plugin logic runs, and blocks the entire plugin behind that check. Because a GUI-launched IDE (Dock, Launchpad, desktop shortcut) inherits a minimal environment whose PATH omits Node installed by version managers and package managers, a naive "spawn `node` and see" would report "missing" on machines that clearly have Node. Detection is therefore two-phase — gather candidate binaries from every plausible channel, then prove each candidate by actually executing it and reading its reported version — with a minimum major.minor version floor, a persisted winner for fast subsequent checks, an interactive retry, and a manual file-chooser fallback. When no usable runtime is found the plugin surfaces a blocking "Node.js required" panel and does nothing else.

## Scope

**In scope:**
- The two-phase detect flow: candidate discovery channels and their order, verify-by-execution, the minimum-version floor, first-match-wins.
- The verified-runtime record (path + reported version) and the rejected-candidate record (ran but too old), and how each is surfaced — including the rule that every version number a message quotes is derived from the floor rather than typed out.
- The persisted detection result, the plain-text sibling record it is kept in lockstep with, the in-process cache (including negative caching), the fast re-verify path, and forced re-probe.
- The manual file-chooser fallback and its identical proof.
- The hard gate: which plugin entry points require a runtime, what happens when none is found, and the retry/manual paths that unblock.
- Shell-based PATH probing hardening (marker extraction, timeouts, shell-family differences).

**Out of scope (boundaries):**
- What the resolved runtime is *used for* — driving the bundled command-line tool's integrations enable/disable (MCP + skills) is owned by the IntelliJ MCP-and-skills integration spec; the full delegated install sequence is owned by the delegated-hook-installation spec (128); the long-lived bridge connection is owned by spec 288.
- Git and AI-agent hook installation, which runs the resolved **Node** runtime — the plugin has no Java entry point of its own, and the hooks it gets installed execute under Node as well (the delegated-hook-installation spec, 128). In particular, the shell dispatch scripts' **consumption** of the plain-text sibling record — the tier order that puts the caller's own search path first, the executable-bit-only acceptance test, the carriage-return strip, and the asymmetric exit policy when no runtime is found — is owned by the dispatch-script topic (49). This spec owns only **producing** the record.
- The per-project service lifecycle and the tool-window construction that host the gate — owned by the lifecycle and tool-window specs; this spec covers only the runtime check they consult.

## Data Contracts

### Verified runtime

A verified runtime is the absolute path to a Node binary plus the version string that binary reported when executed (a `v`-prefixed major.minor.patch). A binary is "verified" only after it actually ran and answered with a parseable version at or above the floor.

### Minimum supported version — `22.13`, compared as major **and** minor

Detection enforces a floor of Node **22.13** (the oldest release the bundled tool can run on, because that is the first one whose built-in SQLite module loads without an experimental command-line flag — and the hook dispatchers that run under it are deliberately flag-free).

The comparison is **major-then-minor, not major alone**: a higher major passes outright, a lower major fails outright, and an equal major falls through to a minor comparison against the floor's minor. So `22.13.0`, `22.22.1` and `24.0.0` are usable while `22.12.9`, `22.5.0` and `20.19.0` are not. The first two of those failures are the ones that matter: a major-only check would have admitted both, and they sit in exactly the range where the built-in SQLite module exists but throws on import.

Both version components are parsed from a **`v`-prefixed** shape. A reported version without that leading `v` does not parse, and an unparseable version is treated as **not supported** rather than as "assume new enough" — so a candidate that answers `22.13.0` with no `v` is skipped. (Notable sharp edge.)

A binary that runs but reports a version below the floor is **not** a successful detection — it is recorded as a rejected candidate, and a newer install found through a later channel can still win.

### Rejected candidate

A candidate that ran and reported a version but fell below the floor is captured as a path + version pair and exposed to the UI, so a machine that has an old Node gets a specific, actionable message (the concrete version and path, plus the floor it is below) instead of a bare "no Node found," which reads as a bug on a machine that clearly has Node. The rejected list is reset at the start of each probe, is empty when detection has never run / succeeded on the fast path / succeeded on the first candidate / no candidate answered at all, and is cleared when a manual pick is adopted.

### Version numbers in user-facing text are derived, not typed

Every runtime message that quotes a version — the blocking panel's install instruction, its "no usable Node.js (`<floor>` or newer) was found" line, its too-old list header, its file-chooser rejection ("that Node.js is `<version>` — version `<floor>` or newer is required"), the project-open notification's too-old and install-instruction branches, and the integrations-unavailable warning — renders the floor from the same constant detection compares against. Raising the floor therefore moves every one of those strings in one edit.

Two things sit outside that guarantee. The **marketplace listing description** is hand-written and hard-codes `Requires Node.js 22.13+` — the one shipping user-facing surface that can drift from the constant. And several "Node.js not found" messages name **no version at all**: the AI-generation and bridge-connection failures, the status row and its tooltip, the historical-backfill notice, and the blocking panel's own generic no-candidate line. A user who reaches one of those learns that Node is missing but not which version to install.

### Persisted detection record

A successful detection is persisted in the machine-global configuration directory as a path, version, source, and timestamp, where the source distinguishes an automatically detected binary from a manually chosen one. Readers ignore the source; it exists so a later re-verify that rewrites the record (e.g. a patch upgrade under a manually chosen binary) preserves the original "manual" tag rather than silently reclassifying it as "auto." A negative outcome deletes any stale record so the fast path cannot resurrect a binary that just failed.

### The plain-text sibling record (`node-path`)

Beside the structured record sits a **plain-text, single-line** sibling holding only the absolute binary path. It exists for a consumer outside this process: the shell dispatch scripts read it as their fallback runtime when the caller's search path has none (spec 49). Plain text rather than the structured record because a POSIX shell has no robust way to parse the structured form — on Windows the path arrives escaped inside it.

**The two records are written and deleted in lockstep**, so they can never disagree:

- A structured-record write that fails **deletes** the sibling and stops. Nothing else is attempted.
- A sibling write that fails **rolls back** the structured record (deletes it) and deletes the sibling too.
- A negative detection outcome deletes **both**.

All deletions are best-effort; a failure to delete is swallowed.

**Path form differs between the two.** The sibling stores a shell-executable rewrite: a drive-letter path becomes a leading-slash lowercase-drive form with separators normalised forward, and a network-share path becomes a double-leading-slash form with separators normalised forward. Any other path — an ordinary absolute POSIX path — is stored **unchanged**, which also keeps the sibling's bytes stable on the platforms where no rewrite is needed. The structured record and the in-process value keep the **native** form, because the JVM-side consumers (the verify step, the version probe) need a path their own process-spawning API accepts.

## Behavior

### Two-phase detection

Detection is synchronized (concurrent callers share one probe) and blocking (shell probes can take seconds on first run), so it runs off the UI thread. It returns the verified runtime or null.

1. **Fast path (unless a forced refresh).** Re-verify the binary recorded by a previous successful detection. If it still verifies, return it — skipping all shell probes. **The record is rewritten only when the reported version differs** from the recorded one; a re-verify that agrees writes nothing at all. When it does rewrite, it preserves the original source tag.
2. **Full probe.** Walk candidate binaries in order, verifying each. Stop at the first that verifies (first-match-wins). Collect too-old hits (de-duplicated by path) into the rejected list. On success, persist the winner (both records); on total failure, log and delete both records.
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

When no automatic channel yields a runtime, the blocking panel offers a file chooser filtered to a Node binary name. A picked file is validated with the **same** execute-and-check-minimum-version proof as automatic detection, so a wrong pick can never unblock the plugin. On acceptance it is recorded (tagged as manually chosen) — through the same writer, so the plain-text sibling is written too — becomes the in-process result, and clears any stale rejected candidates. Rejections report a specific reason: too old (with the version), ran-but-not-Node, or not an executable file.

### The hard gate

A verified runtime is required before any plugin logic runs. Both the per-project service initialization and the project-open startup activity consult detection up front and **stop** when it returns null — no hooks, no memory-bank folder, no watchers, no sync. The tool window mirrors this: when no verified runtime is cached (a non-blocking check safe on the UI thread) it shows a blocking "Node.js required" panel instead of the plugin UI, re-probes in the background (sharing any probe already running so a window opened before the first probe self-heals into the full UI), and offers Retry (forces a fresh probe and, on success, completes the startup sequence the gate skipped), Choose-manually (the file-chooser fallback), and a Download-Node link. When detection failed only because every candidate was too old, the panel and the startup notification name the concrete versions and paths rather than saying "not found."

## State Transitions

```
never detected     → verified (persisted)        (a candidate proves out; both records written)
never detected     → not found                    (no candidate; negative cached; both records deleted)
verified           → verified (fast path)         (recorded binary still proves out; cache hit;
                                                   NO write — see the missing-sibling gap)
verified (drifted) → verified (records rewritten) (version changed; source tag preserved)
not found          → verified                     (Retry after install, or manual pick; startup completes)
too old only       → still blocked, specific msg  (candidates ran but below the floor)
```

## Notable Behavior

- **The detection record now has a consumer outside this process, and that is why the lockstep guarantee exists.** The shell dispatch scripts execute whatever binary the plain-text sibling names, without re-proving it (spec 49). A sibling left behind after a structured-record write failed, or surviving a rollback, would therefore keep those scripts running a runtime this surface no longer trusts — so every write path either lands both records or leaves neither.
- **GAP — a missing sibling is not recreated by a fast-path success.** The fast path rewrites the records only when the re-verified version differs from the recorded one. So if the sibling is deleted or corrupted out from under the plugin (a cleanup script, a partial restore) while the structured record stays valid, every subsequent start takes the fast path, agrees on the version, and writes nothing — the sibling stays missing. It is recreated only by a version drift on the fast path, a forced re-probe, or a manual pick. In that window the plugin itself works normally (it uses the in-process value) while the shell dispatchers silently lose their fallback tier.
- **Detection is two-phase precisely because a GUI-launched IDE's PATH is not the user's shell PATH.** Merely finding an executable file is not proof it runs, and a naive spawn misses version-manager installs; the design gathers candidates broadly and proves them by execution.
- **The minimum-version floor is applied during verification, not after.** A too-old binary never counts as a detection, so a newer install elsewhere can still win — and the too-old finding is surfaced for an actionable message.
- **The floor is a major *and* minor pair, and a version that does not parse is refused rather than assumed good.** Comparing only the major would admit every `22.x` below `22.13`, which is the whole range where the built-in SQLite module exists but throws on import; and an unparseable version string (one missing the leading `v`) is treated as unsupported, so a candidate that reports a perfectly new version in an unexpected shape is skipped rather than adopted. (Surprising; intentional.)
- **Every version number the plugin's own messages quote is rendered from the detector's constant, so raising the floor moves them together.** The hand-written marketplace listing description is the one shipping user-facing surface outside that guarantee — and separately, the "not found" messages quote no version at all, so they cannot drift but also cannot tell the user what to install. (Notable.)
- **Both positive and negative outcomes are cached for the process lifetime**, so the many gate checks stay cheap; only a forced refresh re-probes.
- **The persisted "manual" source tag survives version drift**: a re-verify that rewrites a manually chosen record does not silently reclassify it as auto-detected.
- **Node is now a hard prerequisite for the whole plugin on this surface**, reversing the earlier "Java hooks work without Node" posture. The contrast is stronger than "installs no hooks": the hooks themselves *execute* under Node, so a machine without a usable runtime has **no memory generation at all** — not merely a skipped install. And because every data read the plugin performs beyond native git plumbing is a bridge call spawned under the same runtime, the gate is the precondition for the plugin's **reads** as much as for its writes (cross-reference the MCP-and-skills integration, delegated-hook-installation, bridge-connection, and lifecycle specs).

## Shared Behavior

- The resolved runtime path is consumed by **every** subprocess the plugin spawns, not only the integrations enable/disable: the long-lived per-project bridge server (spec 288), every one-shot bridge call that falls back from it, the AI-generation and Memory Bank migration one-shots, and the pending-push drain worker (spec 271). This spec only produces and gates on the runtime.
- The per-project service lifecycle and tool-window hosting that invoke the gate are owned by the lifecycle and tool-window specs.
- The persisted record lives in the same machine-global configuration directory used by the rest of the plugin's global state, alongside its plain-text sibling and the shell dispatch scripts that read that sibling.
- **Dispatch script generation (49)** — the out-of-process consumer of the plain-text sibling. It reads the record but never writes it, tries the caller's own search path first, and only falls back to the recorded path; that whole consumption contract is owned there.
