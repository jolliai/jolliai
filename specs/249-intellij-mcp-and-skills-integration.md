# 249. IntelliJ MCP & Skills Integration

## Topic Statement

The IDE plugin lights up the MCP tool server and the recall/search skills by extracting the plugin-bundled self-contained command-line tool to a machine-global directory and shelling out to its enable/disable. The install path runs the tool's **full** enable; the narrowed integrations-only mode is used **only** for the version-gated upgrade catch-up. Because a verified Node runtime is now a hard prerequisite for the whole plugin (see spec 284, IntelliJ Node.js Runtime Detection and Hard Gate), this enable always runs with Node present — the historical "Java-hook-only, Node-optional" install no longer exists on this surface. The plugin performs **real MCP registration** by driving the bundled tool as a subprocess — it has no MCP registry writer of its own, and, on the same delegation, **no hook writer of its own either**.

## Scope

**In scope:**
- Bundling and extraction of the command-line tool's distribution, and the deliberate absence of a version stamp at extraction time.
- The enable/disable subprocess: **which mode each caller runs** (full enable on install, integrations-only only for the upgrade catch-up, full disable from the Disable action), its source tag, its timeout, and its output/exit handling.
- The success-only version stamp, the version gate it drives (including the regression it fixes: extracted-but-not-enabled is not "up to date"), its second consumer, and the atomic-write requirement that second consumer imposes.
- The self-heal re-enable trigger for a dead MCP registration entry pointing at a removed distribution.
- The two plugin-directory resolution strategies. (Node executable resolution is owned by spec 284, IntelliJ Node.js Runtime Detection and Hard Gate.)
- The three callers (every install, an idempotent startup catch-up on upgrade, and the best-effort failure notification) and the result type with centralized warning copy.

**Out of scope (boundaries):**
- The MCP server implementation and the per-host registry writers themselves — the plugin does not implement them; it consumes the shared registration mechanism (spec 149) and the MCP tool surface (spec 148).
- The *content* of the git and AI-agent hook writes — owned by the hook-installation topics. Note the boundary has moved: those hooks are **not** installed by native IDE code any more, they are installed as part of the very same delegated full enable this spec's subprocess drives (see Behavior → Enable). This surface writes no hook body at all.
- The status row that surfaces the integration state to the user — spec 133.
- The skill templates' contents and the MCP tool definitions — the skill-installer (spec 48) and MCP-server topics.

## Data Contracts

### Bundled distribution

The plugin package embeds the command-line tool's distribution — its bundled entry file plus the per-hook entry scripts, but **not** the editor-extension entry — as a resource inside the plugin's installation tree.

### Extraction target

A fixed machine-global directory under the user's home holds the extracted distribution. Extraction copies the bundled distribution files there, unconditionally overwriting. **Extraction writes no version stamp** — the stamp means "enable succeeded", not "files copied".

### Version stamp (success-only)

A single stamp file in the extraction directory records the plugin version, and is written **only after** the enable subprocess exits cleanly. The version gate considers integrations up to date only when the extracted entry file exists **and** the stamp exists **and** the stamp equals the current plugin version.

**The stamp now has a second consumer.** The plugin's long-lived command-line-tool connection reads this same stamp on **every** call it makes and compares it against the version the connected process was started from. A difference means the extracted distribution was replaced underneath a live connection, so the connection is torn down and re-established against the new distribution — the stamp doubles as the freshness signal for that respawn decision, not just as the enable-succeeded gate. An unreadable stamp reads as an empty version, which never matches and therefore forces a respawn.

**Consequently the stamp write must be atomic.** It is written to a sibling temporary file and then moved into place atomically, falling back to a non-atomic replacing move only on a filesystem that cannot do atomic moves. A plain truncate-then-write would leave a window in which the second consumer reads an empty version, concludes the connection is stale, and tears it down — failing every request already in flight on it. Atomicity is required specifically because of that reader, not for the version gate, which only ever runs at startup and install time.

### Result type

The enable/disable operation returns one of four outcomes:

| Outcome | Meaning |
| --- | --- |
| ok | Integrations set up successfully (or torn down successfully on disable). |
| node-missing | No Node runtime on PATH — a clean skip, not an error. In the normal install flow this outcome is effectively unreachable: the upstream hard Node gate (spec 284) blocks plugin initialization before enable is ever called, so no hooks are installed either. The branch remains only as a defensive check. |
| bundle-missing | The bundled distribution could not be located in the plugin (a packaging fault). |
| failed | The subprocess ran but timed out or exited non-zero. |

A single helper maps each non-ok outcome to user-facing warning copy (and ok → no warning). This copy is shared verbatim by the failure notification and the status row, so both always read identically.

### Node executable resolution

The Node executable this enable spawns is chosen by the plugin's dedicated Node runtime-detection subsystem (multi-channel, verify-by-execution, minimum-version floor — see spec 284, IntelliJ Node.js Runtime Detection and Hard Gate). This spec consumes that resolved path; it does not scan PATH itself.

## Behavior

### Extraction

Extraction resolves the plugin directory, locates the bundled distribution within it, copies **every** file of that distribution into the machine-global target with overwrite enabled, and returns the target — **without stamping a version**. Failure to locate the bundle returns bundle-missing; failure to copy returns an extraction failure.

**It is invoked unconditionally on every enable and every disable.** Extraction is a step of the shared subprocess runner, ahead of the spawn, and that runner backs all four entry points — full enable, integrations-only enable, full disable, integrations-only disable. There is **no** up-to-date check inside it. The only version gate on this surface sits at the upgrade-catch-up *caller*, which decides whether to run an enable at all; once any enable or disable is running, the whole distribution is re-copied. Because the install path runs the full enable, it re-extracts too — so this is **not** off the hot path.

**The deliberate absence of a version stamp on the extraction is what makes that unconditional overwrite the freshness mechanism.** Nothing records which plugin version produced the extracted copy — the stamp means "enable succeeded", never "files copied" — so there is no cheap way to ask whether the copy is current. Rewriting it wholesale every time is the answer: it guarantees a newly-installed plugin's runtime has replaced its predecessor's *before* the subprocess that will use it is spawned. Read as an efficiency question the repeated copy looks wasteful; read as a correctness question it is the design point, because the failure it prevents is spawning a stale runtime in preference to the one the installed plugin actually ships.

**The copy is serialised by a lock held across the whole extraction.** Two projects opening at once share the one machine-global target and would otherwise interleave their copies; an overwriting copy is not atomic, so an interleaved write can leave a partially-written entry file that then breaks the very process that ran the copy. Under the lock a second project waits and then observes a complete distribution.

The spawn paths *other* than enable/disable (interactive generation, the migration run, and general entry-point resolution) reach extraction only as a **fallback**: they use the already-extracted copy when it is present and extract solely when it is missing entirely. Those paths are presence-gated; enable and disable are not.

### Enable (two modes, same subprocess shape)

Both modes share one sequence:

1. Resolve the Node executable; if absent, return node-missing (no extraction, no subprocess).
2. Extract the bundled distribution; if the bundle is missing, return bundle-missing.
3. Run the bundled tool's **enable**, tagged with a source identifier for this surface (so its dispatch-path entry coexists with any command-line or editor-extension install), in the project directory, capturing combined output, under a bounded timeout.
4. On timeout, forcibly terminate and return failed.
5. On clean exit (zero): **write the success-only version stamp** and return ok.
6. On non-zero exit or an exception: **clear the version stamp** (so the next startup retries) and return failed.

What differs is the mode requested in step 3, and which caller requests it:

- **Full enable — the install path.** This is what runs when the plugin sets a project up. Beyond the integrations, it installs the **git and AI-agent hooks**. That is how those hooks come to exist on this surface: the plugin asks for them by running the full enable and writes no hook body itself. It also answers non-interactively (no prompts) and carries the same source identifier.
- **Integrations-only enable — the upgrade catch-up only.** Narrowed to the dispatch scripts, dispatch-path indirection, MCP registration, and skills, and explicitly **not** the git or AI-agent hooks. That is appropriate precisely because this mode runs only when hooks are already installed (see Callers), so there is nothing for it to repair on the hook side.

### Disable (full)

The Disable action runs the bundled tool's **full** disable — deliberately not the integrations-only form — after the same node-missing / bundle-missing short-circuits and under the same bounded timeout. Best-effort: a failure is logged, never fatal.

The full form is required because of the enable/disable asymmetry: an integrations-only disable removes only the MCP registration and would leave every installed hook in place, so disabling from the IDE would not actually stop memory generation. Exactly what the full disable tears down, and what it deliberately leaves behind under the tool's conservative uninstall policy (skill documents, machine-global registrations), is owned by the hook-orchestration and uninstall topics.

### Self-heal: dead MCP registration

Independently of the version gate, the plugin detects a **stale MCP registration**: the project's MCP config registers this server at a baked absolute path to the bundled entry file that no longer exists on disk. This happens when the distribution that won dispatch-path selection at registration time was later removed (for example, another surface was uninstalled) — an *environment* change, not a plugin-version change, so the version stamp stays current and the gate alone would never re-register. When detected, the startup catch-up forces a re-enable; one healing enable re-resolves the registration to a live distribution. The check is pure file I/O (no Node) and only fires on the baked-absolute-path form; the indirection form re-resolves at spawn time and never goes stale, so it is skipped. That baked form is written only for one host platform's invocation shape, so on every other platform this trigger never fires and the version gate is the sole catch-up condition. It returns "not stale" when there is no MCP config, no entry for this server, the entry is not the baked-path form, or the referenced file still exists.

### Plugin-directory resolution (two strategies)

1. From the loading class's code-source location, climb to the plugin root.
2. **Fallback:** parse a bundled resource's URL to the containing archive or unpacked directory and climb to the plugin root. This exists because on newer IDE classloaders the code-source location is null for plugin classes, which broke the code-source-only lookup.

### Callers

- **Every install** runs the **full** enable and threads any resulting warning into the install result. Because that one subprocess covers integrations *and* hooks, install is a single delegated call rather than a native hook-writing step plus an integrations shell-out.
- **Startup catch-up** runs on plugin activation once hooks are already installed (so install itself does not re-run): if integrations are not up to date **or** the MCP registration is stale, it runs the **integrations-only** enable off the UI thread. Version-gated, so it is a no-op once current — this is what makes a plugin upgrade activate MCP/skills without a manual re-enable, and it is the only path that uses the narrowed mode.
- **Failure notification** is a best-effort, non-fatal heads-up shown once when enable returns a non-ok outcome; the durable surface is the status row.

## State Transitions

### Integration readiness

```
absent            → extracted (no stamp)         (enable begins)
extracted-no-stamp→ enabled (stamp = version)    (subprocess exits 0)
extracted-no-stamp→ extracted-no-stamp           (subprocess fails; stamp cleared → retried next startup)
enabled           → enabled                      (startup catch-up, version current, registration live → no-op)
enabled           → re-enabled                   (registration stale despite current version → forced re-enable)
plugin upgraded   → extracted → enabled          (stamp ≠ new version → catch-up re-runs enable)
enabled           → connection respawned         (stamp ≠ the live connection's recorded version → torn down and re-established)
```

## Notable Behavior

- **IntelliJ MCP registration is LIVE today.** The plugin performs real registration by driving the bundled command-line tool as a subprocess. This contradicts an older note that IntelliJ registers no MCP — that is no longer true. The plugin still has **no independent MCP registry writer**; it delegates entirely to the shared registration mechanism (spec 149).
- **Extraction and enable are decoupled by design.** Extraction copies files but never stamps. The stamp is written only after a confirmed clean enable. This fixes a stale-artifact regression: previously "extracted" could be mistaken for "done", so a *failed* enable (skills/MCP never written) looked complete, startup never retried, and the status row falsely showed active.
- **Re-extracting on every enable and disable is the freshness mechanism, not an oversight.** The same decoupling that makes the stamp trustworthy leaves the extracted copy with **no** version record of its own, so there is nothing to compare against and no way to skip the copy safely. Rewriting it wholesale on every enable and every disable is therefore deliberate: it guarantees the runtime about to be spawned is the one the installed plugin ships. The cost is bounded (a small file set, once per enable or disable, serialised by a lock); the alternative is a correctness failure, not a slower one. Note this applies to the install path as well, since that path runs the full enable — the version gate that *does* exist guards only whether the upgrade catch-up runs an enable at all, never whether a running enable re-extracts.
- **The version stamp is read on a hot path, not just at startup.** Its second consumer — the long-lived command-line-tool connection — checks it on every call, so the stamp's *write* is a concurrency concern: it must land atomically or a reader catching the write mid-flight would see an empty version, judge the connection stale, and fail every request in flight on it. The stamp therefore serves two roles at once: the enable-succeeded gate and the connection-freshness signal.
- **The self-heal is an environment-change trigger, not a version-change trigger.** A live registration can rot when an unrelated surface's distribution is removed; the version stamp cannot catch that, so a separate dead-path check forces one healing re-enable.
- **This surface writes no hooks itself — the delegated enable does.** Hook installation used to be native IDE-side work that never touched the command-line tool. That is no longer true in either direction: the tool's full enable is the *only* thing that writes a hook on this surface, and the installed hooks then execute under Node as well. The consequence is that this spec's subprocess is on the critical path for memory generation, not merely for MCP and skills. (Load-bearing; this is the fact most likely to be remembered wrongly.)
- **Node is now required for the entire plugin, not just for MCP/skills.** A verified Node runtime is a hard gate ahead of service init and hook install (spec 284), so a machine without Node gets a blocking "Node.js required" panel and no hooks at all — the hooks cannot be *installed* without it (they are written by a Node subprocess) and could not *run* without it either. The four-outcome enable result and shared warning copy still exist for the integrations layer, but its node-missing branch is not reached under the hard gate.
- **The narrowed mode is a catch-up detail, not the surface's install model.** Integrations-only is easy to mistake for "how this plugin enables Jolli". It is only the version-gated (or stale-registration) upgrade path; a first install, and any repair of a project's hooks, goes through the full enable.
- **The disable is asymmetric with enable — and that asymmetry dictates the Disable action's form.** An integrations-only enable wires MCP + skills + dispatch scaffolding, but an integrations-only *disable* removes only the MCP registration and leaves hooks, skills, and dispatch-path entries behind (conservative uninstall). Because leaving the hooks would mean a "disabled" project still generating memory, the Disable action runs the **full** disable instead.
- **The surface still contains a native skill installer, and it is unreachable.** A native skill-writing implementation remains in this surface's source tree, complete with its own bundled recall/search templates, the same ownership-marker and revision-guard precedence as the shared implementation, and the same retired-name sweep. It has **no production caller**: every skill document on this surface is written by the delegated enable. Treat it as dead code, not as a second live writer — in particular, its bundled templates are not what lands on disk. (Notable; a reader tracing "where do this surface's skills come from" will otherwise stop at the wrong implementation.)
- **Node discovery is delegated to the plugin's Node runtime-detection subsystem** (multi-channel probe + verify-by-execution + minimum-version floor), which exists to survive GUI-launched IDEs whose inherited PATH omits version-manager/package-manager Node installs — see spec 284, IntelliJ Node.js Runtime Detection and Hard Gate.
- **Plugin-directory resolution has a second strategy purely to survive newer IDE classloaders** where the code-source location is null.

## Shared Behavior

- The MCP registration mechanism and per-host registry writers are owned by spec 149; this spec only invokes them via the bundled tool.
- The MCP tool surface (which tools the server exposes) is spec 148.
- Git and AI-agent hook installation route through the command-line tool on this surface, as part of the same full enable this spec drives; the hook writes themselves (bodies, markers, per-worktree reconciliation, detection) are owned by the hook-installation topics. This surface contributes no hook body of its own.
- The status row that renders the four-outcome readiness (with the shared warning copy) is spec 133.
