# 249. IntelliJ MCP & Skills Integration

## Topic Statement

The JVM IDE surface lights up the tool server and the recall/search skills by driving the command-line runtime it bundles — over the long-lived host bridge — and classifying that run into one of **five** outcomes, one of which is a refusal that must be treated as neither a success nor a failure; the install path runs the runtime's **full** enable, and the narrowed integrations-only mode exists solely for the version-gated upgrade catch-up.

## Scope

**In scope:**

- The outcome set of an enable or disable run, what each outcome means, and the shared warning copy derived from it — including the refusal outcome that produces no warning at all.
- Which mode each caller runs (full enable on install, integrations-only only for the upgrade catch-up, full disable from the disable gesture), and the source tag every run carries.
- The success-only version stamp, the version gate it drives, its second consumer, and the atomic-publish requirement that second consumer imposes.
- The self-heal trigger for a registration that has gone dead through an environment change rather than a version change.
- The two strategies for locating the plugin's own installation tree.
- The three callers and what each does with the outcome.
- Why the disable is asymmetric with the enable, and what that dictates about the disable gesture's form.

**Out of scope (boundaries):**

- The bundled runtime copy, its fingerprint cache, its completeness condition, its lock, the request each direction sends, and the injected runtime directory — spec 128.
- The tool-server implementation and the per-host registry writers themselves — this surface implements none of them; it consumes the shared registration mechanism (spec 149) and the tool surface (spec 148).
- The *content* of the git and assistant hook writes — owned by the hook-installation topics. The boundary matters: those hooks are installed by the very same delegated full enable this spec's run drives, and this surface writes no hook body at all.
- The runtime detection subsystem and the hard gate in front of it — spec 284.
- The row that surfaces this readiness to the user — spec 133.
- The gestures that trigger an enable or a disable, and their optimistic interface flips — spec 332.
- The skill templates' contents and the tool definitions — specs 48 and 148.

## Data Contracts

### The outcome set — five outcomes

| Outcome | Meaning |
| --- | --- |
| **ok** | Integrations set up successfully, or torn down successfully on a disable. |
| **runtime-missing** | No verified external runtime. A clean skip, not an error. In the normal flow this is effectively unreachable: the upstream hard gate (spec 284) blocks initialisation before any of this is called, so no hooks are installed either. The branch survives as a defensive check. |
| **bundle-missing** | The bundled runtime could not be located inside the plugin — a packaging fault. |
| **refused-because-manually-disabled** | The runtime declined the whole install because the repository carries the durable opt-out and this run asked it to respect that. |
| **failed** | The run happened but timed out or reported failure. |

**The refusal outcome is neither of its neighbours, and every property of it follows from that.**

- It is **not ok**: nothing was written, so no success side effect may fire — in particular **no version stamp**, because stamping would tell the version gate that the current plugin version is fully enabled and permanently suppress every later catch-up for that version.
- It is **not failed**: refusing to touch a repository the user turned off is the designed outcome, so it must not raise an error notification and must not be parked in the state the tool window paints red.
- It **arrives carrying success** from the runtime's side of the boundary (spec 304), so it must be classified **before** the success branch or it is indistinguishable from a real install.
- It is reachable **only from an automatic path**; every explicit user gesture asks the runtime *not* to respect the opt-out, precisely so the click can lift it.

### Warning copy

A single helper maps each outcome to user-facing warning text, and this copy is shared verbatim by the failure notification and the status row so the two always read identically.

**Two outcomes map to no warning: ok, and the refusal.** The refusal's `null` is not an oversight sharing a branch with success — it is stated in place that a deliberately disabled repository has nothing to warn about, and that the caller decides what to do with the state. The runtime-missing text quotes the minimum version from the detector's own floor rather than a hand-typed number, so it can never name a version the detector already accepts or already rejects.

Because the shared helper answers nothing for the refusal, the surface that consumes it supplies **its own** message for that case — otherwise the fallback path would report the generic "enable failed", which is both wrong and alarming for a repository the user chose to disable.

### Version stamp (success-only)

A single stamp file in the extracted runtime directory records the plugin version, written **only after** a delegated run reports a real success. The version gate considers integrations up to date only when the extracted entry file exists **and** the stamp exists **and** the stamp equals the current plugin version.

**The stamp has a second consumer.** The long-lived bridge connection re-reads it on **every** call and compares it against the version the connected process was started from. A difference means the extracted runtime was replaced underneath a live connection, so the connection is torn down and re-established against the new one. An unreadable stamp reads as an empty version, which never matches and therefore forces a respawn.

**Consequently the stamp write must be atomic** — a sibling temporary file moved into place, with a non-atomic replacing move only where the filesystem refuses an atomic one. A plain truncate-then-write would leave a window in which the second consumer reads an empty version, concludes the connection is stale, and fails every request already in flight on it. Atomicity is required specifically because of that reader; the version gate itself only runs at startup and install time.

## Behavior

### Enable — two modes, one shape

Both modes share one sequence:

1. Resolve the external runtime; if absent, return runtime-missing without touching anything else.
2. Refresh the bundled runtime copy; if the bundle cannot be located, return bundle-missing.
3. Send the enable as a **bridge action** against the long-lived server bound to this project — falling back to a one-shot child process only when no server is bound or the call fails locally — tagged with this surface's own source identifier so its entry in the machine-global runtime registry coexists with any other surface's, with the project directory as the working directory, under a bounded budget.
4. Classify the reply: **refusal first**, then success, then everything else.
5. On success, write the version stamp. On failure or a thrown error, **delete** it so the next startup retries. On a refusal, leave it exactly as it was.

What differs is the mode requested and which caller requests it:

- **Full enable — the install path.** What runs when the surface sets a project up. Beyond the integrations it installs the **git and assistant hooks**: that is how those hooks come to exist here, and this surface writes no hook body itself.
- **Integrations-only enable — the upgrade catch-up only.** Narrowed to the dispatch scripts, the registry entry, host registration and skills, and explicitly **not** the git or assistant hooks. Appropriate precisely because this mode runs only when hooks are already installed, so there is nothing for it to repair on the hook side.

### Disable — always full

The disable gesture runs the runtime's **full** disable — deliberately not the integrations-only form — after the same runtime-missing and bundle-missing short-circuits and under the same bounded budget. It is best-effort: a failure is reported but never fatal, and it never touches the version stamp.

The full form is required by the enable/disable asymmetry: an integrations-only disable removes only the registration and would leave every installed hook in place, so disabling from the IDE would not actually stop memory generation. What the full disable tears down, and what it deliberately leaves behind under the runtime's conservative teardown policy, is owned by the hook-orchestration and uninstall topics.

### Self-heal: a dead registration

Independently of the version gate, the surface detects a **stale registration**: the project's server config registers this server at a baked absolute path to an entry file that no longer exists on disk. That happens when the distribution which won registry selection at registration time was later removed — for example another surface was uninstalled. It is an **environment** change, not a plugin-version change, so the version stamp stays current and the gate alone would never re-register.

When detected, the startup catch-up forces a re-enable; one healing run re-resolves the registration to a live distribution. The check is pure file inspection — no external runtime needed — and fires only on the baked-absolute-path form; the indirection form re-resolves at spawn time and never goes stale, so it is skipped. That baked form is written only for one host platform's invocation shape, so on every other platform this trigger never fires and the version gate is the sole catch-up condition. It reports "not stale" when there is no config, no entry for this server, an entry that is not the baked form, or a referenced file that still exists.

### Locating the plugin's installation tree

1. From the loading class's code-source location, climb to the plugin root.
2. **Fallback:** parse a bundled resource's address back to the containing archive or unpacked directory and climb to the plugin root. This exists because on newer IDE classloaders the code-source location is null for plugin classes, which broke the code-source-only lookup.

### Callers

- **Every install** runs the **full** enable and threads any resulting warning into its own result. Because one delegated run covers integrations *and* hooks, install is a single delegated call rather than a native hook-writing step plus an integrations call.
- **Startup catch-up** runs on activation once hooks are already installed: if integrations are not up to date **or** the registration is stale, it runs the **integrations-only** enable off the interface thread. Version-gated, so it is a no-op once current — this is what makes a plugin upgrade activate the tools and skills without a manual re-enable, and it is the only path that uses the narrowed mode.
- **Failure notification** is a best-effort, non-fatal heads-up shown once when a run returns a non-ok outcome. Because the shared copy answers nothing for the refusal, a refused run raises no notification at all; the durable surface is the status row.

## State Transitions

```
absent               → extracted (no stamp)      (an enable begins)
extracted, no stamp  → enabled (stamp = version) (the run reports success)
extracted, no stamp  → extracted, no stamp       (the run fails; stamp cleared → retried next startup)
any state            → UNCHANGED                 (the run is REFUSED: no stamp written, none cleared)
enabled              → enabled                   (catch-up: version current, registration live → no-op)
enabled              → re-enabled                (registration stale despite a current version → forced re-enable)
plugin upgraded      → extracted → enabled       (stamp ≠ new version → catch-up re-runs an enable)
enabled              → connection respawned      (stamp ≠ the live connection's recorded version)
```

## Notable Behavior

- **There is a fifth outcome, and it is the one that breaks the usual two-valued reading.** A run refused because the repository is manually disabled writes nothing, stamps nothing, warns about nothing, and is deliberately kept out of the error state — while arriving from the runtime carrying *success*. Reading it as ok stamped the version, which made the gate permanently satisfied for that plugin version so the catch-up never ran again; reading it as failed put a red error in front of a user who had just turned the product off on purpose. (Surprising; the outcome that means "nothing happened" is the one most easily mistaken for both of its neighbours.)
- **The refusal is unreachable from any explicit gesture.** Every user-initiated enable asks the runtime *not* to respect the opt-out, because the whole intent of the click is to lift it; only the automatic startup repair can produce this outcome.
- **This surface performs real host registration today** by driving the bundled runtime. It still has **no independent registry writer** — it delegates entirely to the shared mechanism (spec 149).
- **The version stamp means "an enable ran green", never "the files were copied".** That decoupling is what fixed a stale-artifact regression: previously "extracted" could be mistaken for "done", so a *failed* enable looked complete, startup never retried, and the status row falsely showed active.
- **The version stamp is read on a hot path, not just at startup.** Its second consumer checks it on every bridge call, which makes the stamp's *write* a concurrency concern: it must land atomically or a reader catching the write mid-flight would see an empty version, judge the connection stale, and fail every request in flight on it. The stamp therefore serves two roles at once — the enable-succeeded gate and the connection-freshness signal.
- **The self-heal is an environment-change trigger, not a version-change trigger.** A live registration can rot when an unrelated surface's distribution is removed; the version stamp cannot catch that, so a separate dead-path check forces one healing re-enable. It is also platform-conditional: on every platform whose registration uses the indirection form, this trigger can never fire.
- **This surface writes no hooks itself — the delegated enable does.** Hook installation used to be native work that never touched the command-line runtime. That is no longer true in either direction: the full enable is the *only* thing that writes a hook here, and the installed hooks then execute under the external runtime too. The consequence is that this delegation is on the critical path for memory generation, not merely for tools and skills. (Load-bearing; the fact most likely to be remembered wrongly.)
- **The external runtime is required for the entire plugin, not just for tools and skills.** A verified runtime is a hard gate ahead of service initialisation and hook install (spec 284), so a machine without one gets a blocking panel and no hooks at all — they cannot be *installed* without it and could not *run* without it either. The runtime-missing outcome and its shared copy still exist for this layer, but that branch is not reached under the hard gate.
- **The narrowed mode is a catch-up detail, not the surface's install model.** Integrations-only is easy to mistake for "how this plugin enables the product". It is only the version-gated (or stale-registration) upgrade path; a first install, and any repair of a project's hooks, goes through the full enable.
- **The disable is asymmetric with the enable, and that asymmetry dictates the disable gesture's form.** An integrations-only enable wires the tools, skills and dispatch scaffolding, but an integrations-only *disable* removes only the registration and leaves hooks, skills and registry entries behind. Because leaving the hooks would mean a "disabled" project still generating memory, the gesture runs the **full** disable instead.
- **The surface still contains a native skill writer, and it is unreachable.** A complete skill-writing implementation survives in this surface's source tree, with its own bundled templates and the same ownership-marker and revision-guard precedence as the shared implementation. It has **no production caller**: every skill document here is written by the delegated enable. Treat it as dead code, not a second live writer — in particular, its bundled templates are not what lands on disk. (Notable; a reader tracing "where do this surface's skills come from" will otherwise stop at the wrong implementation.)
- **Locating the plugin's own tree has a second strategy purely to survive newer IDE classloaders**, where the code-source location is null for plugin classes.

## Shared Behavior

- **IntelliJ Delegated Hook Installation (128)** — owns the native install steps, the bundled runtime copy and its fingerprint cache, the request shape each direction sends, the injected runtime directory, and the bounded budget. This spec owns the outcome set, the shared copy, the version gate and the catch-up.
- **IntelliJ Enable / Disable Surface (332)** — owns the gestures that reach these runs, and the requirement that the refusal outcome stay out of the error state the tool window renders.
- **The zero-write contract (304)** — owns the reading that a refusal is spelled *success* on the runtime's side of the boundary, and everything else a disabled repository refuses.
- **The registration mechanism and per-host registry writers (149)** — this surface only invokes them via the delegated run.
- **The tool surface (148)** — which tools the server exposes.
- **The hook-installation topics** — own the hook bodies, markers, per-worktree reconciliation and detection that the delegated enable writes; this surface contributes none of them.
- **IntelliJ Node.js Runtime Detection and Hard Gate (284)** — owns the runtime every run needs and the floor the runtime-missing copy quotes.
- **IntelliJ CLI Daemon Connection (288)** — owns the long-lived server these runs prefer, and reads the version stamp on every call.
- **The status row (133)** — renders this readiness using the same shared warning copy.
