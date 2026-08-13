# 282. Claude Code Plugin Package

## Topic Statement

Package the product's context-recall, decision-search, PR-description-writing, and memory-generation bootstrap capabilities as a single installable extension for a specific third-party AI coding assistant's plugin ecosystem — distributed through that ecosystem's marketplace-catalog mechanism — so a user gets the full experience by installing one plugin, with no separate command-line tool install required.

## Scope

**In scope:**
- The marketplace-catalog entry and the plugin manifest it points at.
- The bundled MCP server registration this plugin contributes.
- The single session-lifecycle hook this plugin's manifest registers, and the build-time guard that keeps it the only one.
- The slash commands and natural-language-triggered skills this plugin registers.
- The self-contained build step that produces the plugin's runtime bundle.
- The multi-target publish/distribution pipeline for this plugin (informal local test directory, private dry-run repository, public repository, single-file archive) and the safety checks it performs before ever committing a release.
- The plugin's own independent versioning and release model.
- How the shared product core detects that it is running inside this specific embedding, and the two behavioral differences that detection produces (outbound self-identification; disabling an unrelated discovery mechanism the embedding never needs).
- The narrowed environment-setup mode this plugin's own session-start bootstrap selects to install the underlying automation hooks, and how the plugin participates in cross-surface version selection when more than one install surface is present on the same machine.

**Out of scope (boundaries):**
- The full behavior of the underlying automation hooks themselves (session recording, git-operation queueing, memory generation) — covered by their own specs; this spec covers only that this plugin installs and launches them.
- The behavior of the session bootstrap the manifest's one hook launches — its pre-state snapshots, its two lock-guarded phases, its disabled-path teardown, its first-session metadata write, its briefing-suppression rule, and its structured output — covered by the plugin session-bootstrap topic. This spec owns only the fact that the manifest registers exactly one action pointing at it.
- The full tool set exposed by the bundled MCP server and the read/search/recall resolution logic behind it — covered by the MCP server and recall/search specs; this spec covers only that this plugin registers exactly one such server.
- The session-start briefing text composition, the "not signed in" reminder, the local-agent default-provider seeding, and the auth-failure reminder — these are behaviors of the shared session-start context layer (partly gated to this embedding), requested by the plugin's session bootstrap, and a distinct topic from the plugin *package*.
- The unrelated, general-purpose CLI plugin-discovery/loader mechanism (runtime-loaded optional command-line extensions for the standalone tool) — covered elsewhere. This plugin is a fixed, closed command surface, never a plugin *host*.
- The bare, unnamespaced menu skill that a companion install step writes outside this plugin's own bundle to work around the ecosystem's mandatory command-namespacing — its content is owned by **spec 303**; this spec notes only that it exists as context for why this plugin's own skills/commands are namespaced.
- Cross-surface dist-path version-selection algorithm details (tie-break order, per-file completeness checks) — covered elsewhere; this spec covers only that this plugin's bundle registers itself as one ordinary candidate in that selection and expresses no preference of its own.
- A prospective package-manager-hosted distribution channel — documented as a plan, not yet implemented; excluded as it is not present reality.

## Data Contracts

### Marketplace catalog

A catalog document naming the marketplace itself (name, description, an owning identity) and listing one or more plugin entries. Each entry carries: a plugin name, a relative source location, a one-line description, a category tag, and a set of keyword tags used for discovery inside the marketplace UI. Exactly one plugin entry exists today.

### Plugin manifest

A per-plugin document, separate from the marketplace catalog, carrying: an internal name (used as the command/skill namespace prefix), a human-readable display name, a semantic version, a description, author identity, a homepage URL, a license identifier, and keyword tags.

### MCP server registration

A single stdio-transport server entry, keyed by a server name, whose launch command is a runtime interpreter invoking the plugin's own bundled command-line entry point in a fixed "MCP server" mode. There is exactly one server entry; it exposes the product's full read/write MCP tool surface (recall, search, decision timeline, PR-description assembly, generation-queue status, environment status, and the remote-space tools) to the assistant.

### Session hook

**Exactly one** lifecycle event is registered, with **exactly one** action under it:

- **Session-start event** — one command action launching the bundled session-bootstrap entry point. No matcher/filter is declared, so it fires for every occurrence of the session-start event the host reports (fresh start, resume, context-compaction, etc.), not just a first-time "new session" case. No asynchrony flag is declared either, so the host waits for it — which is what allows it to return structured output for the session.

There is deliberately **no session-end action and no second session-start action**. An earlier revision of this manifest registered the product's session-recording hook and its briefing hook directly, plus an environment-setup command action alongside them. All of that is now reached *indirectly*: the one bootstrap action installs the product's canonical session-recording and session-start hooks into the assistant's per-project local settings file, through the same shared dispatch indirection every other install surface uses, so the manifest itself carries no business hooks at all.

The build step enforces this shape: it fails unless the manifest registers exactly one event, exactly one command action under it, and that action's command names the bootstrap entry point. Adding a business hook back into the manifest therefore breaks the build rather than shipping.

Everything the bootstrap does once launched — including that indirect hook installation — is the plugin session-bootstrap topic's subject, not this one's.

### Commands

Five slash-invocable commands, each accepting an optional free-text argument where noted:

- **Setup** (optional argument: a target-workspace identifier) — a one-shot sequence: check whether the user is already able to authenticate; if not, run the sign-in flow; enable memory generation for the current project (idempotent); then bind the current project to a remote collaborative workspace (picking the supplied identifier directly, or presenting an interactive choice, or offering a previously-configured default) unless it is already bound.
- **Sign-in** — runs the interactive browser-based sign-in flow and reports success/failure; explicitly does not gate memory generation itself (a separate no-credential local-generation path exists), only remote-workspace binding/sharing.
- **Sign-out** — clears stored remote credentials only; leaves any separately-configured direct model credential untouched; reports that generation stops unless a direct model credential remains.
- **Health status** — a compact report of install/config health: version and enablement, hook install state and active runtime, data-migration state, account/credential state per possible generation mode, the bound remote workspace (if any), the recorded-memory count, and a per-integration detected/enabled listing; ends with a single-line health verdict. Explicitly not a content-recall surface.
- **Decision timeline** — given a topic identifier, renders that topic's recorded history oldest-first as a narrative; if the identifier is unrecognized, falls back to search to help the user find the right one.

### Skills

Three natural-language-triggered skills, each with a dual execution path:

- **Recall** — given an optional branch reference (or none, meaning the current branch), retrieves that branch's structured development context (commits, distilled topics, decisions, associated plans/notes) and synthesizes an answer. Prefers calling the assistant's native tool integration when available; otherwise falls back to invoking the bundled command-line entry point directly, passing the user-supplied argument through a randomly-generated, per-invocation delimited block (never interpolated into a shell argument or quoted string) specifically so that a pre-computed malicious payload embedded in prior context cannot forge a matching delimiter and smuggle shell content.
- **Search** — same dual-path pattern, full-text search over historical decisions across all branches, returning lightweight results (title, snippet, branch, short identifier) and pointing to Recall for depth.
- **Push** — publishes the current branch's recorded memories to a remote collaborative workspace as shareable content. Requires the user to already be authenticated for the remote-workspace path (not for generation itself). First waits for any in-flight memory generation to finish so freshly-committed work is included, then publishes; on "not yet bound to a workspace," surfaces the available choices and either binds first or binds-and-publishes in one call.

### What the plugin does *not* ship

The plugin's command surface is fixed and closed, and its exact composition is asserted at publish time: five slash commands, three skills, one MCP server entry, one session-start hook action — and **no subagents**. There is no subagent directory in the bundle, no subagent metadata in the manifest, and no publish-time assertion for one. An earlier revision shipped a single pull-request-description subagent; it was removed along with its publish assertion, and the PR-description capability now lives entirely in the MCP tool surface and the skills that call it.

## Behavior

### Installation and activation

A user adds the marketplace source (by repository reference or local directory path) and installs the single plugin from it. Once installed and enabled, its MCP server, its one session-start hook, all commands, and all skills are live for that user's assistant sessions — no separate command-line install, and (per the plugin manifest) no dependency at runtime on anything except a general-purpose script runtime being present on the machine. The product's own session-recording and session-start hooks become live one step later: the first session's bootstrap installs them into the project.

### Self-contained bundling

The plugin ships its own copy of the product's entire relevant command-line logic, pre-bundled into its own output directory at build time, rather than depending on a separately, globally installed copy. The bundle must include not only the entry points the plugin launches directly (the MCP/CLI entry and the session-bootstrap entry) but also a fixed, complete set of lower-level entries — the product's own session-stop and session-start hook entries, all five git-operation hook entries, and both detached background-worker entries — because the plugin's narrowed environment-setup mode installs hooks into the user's project that, at each subsequent session or git operation, resolve back to files inside *this same* bundle. Omitting any one of them does not degrade gracefully: the corresponding operation would attempt to run a nonexistent file, and for a git hook that aborts the git operation outright.

The build step asserts the exact expected set of bundled entries — the CLI/MCP entry, the session-bootstrap entry, the two agent-hook entries, the five git-hook entries, the two worker entries, and a local dashboard-server entry — and fails if any is missing or empty. The same list, plus the dashboard's static asset files (copied in after bundling rather than produced as entries), is asserted again at publish time on every publish target — all four share one required-file list, so the archive target cannot drift from the git-committing ones — so an incomplete bundle cannot be released. (Being a build product, the bundle is not itself version-controlled; only these assertions guarantee its shape.) The build step also first clears any previously-built output so a renamed or removed entry point cannot leave a stale file behind, and its build-time bundling additionally lets the bundled code detect at runtime that it is running as this specific embedding (see below).

The dashboard's assets are asserted **file by file, not by their template alone**, because the server reads the template, the stylesheet and every one of its page scripts at request time: a repository-local exclusion rule matching a script directory or a stylesheet would otherwise pass a template-only check and produce a server error on the first dashboard launch. The asserted asset files are the template, the stylesheet, and the page scripts named `format`, `charts`, `shell`, `stats`, `standup`, `repositories`, `memories` and `main`.

**That asset list is one file short of what the server actually requires.** The server's own door check additionally demands a `settings` page script — which the shipped page template loads and the served page inlines — and that script is absent from the publish assertion. A bundle that lost exactly that file therefore passes both publish checks (on disk and in the destination's git index) and then fails the server's asset probe at run time, which is the scriptless-error-page outcome the file-by-file listing exists to prevent. So the failure mode the paragraph above claims to close is open for exactly one file. (Notable; real at this revision, and identical in the sibling Codex plugin's inventory. Spec 328.)

A strict subset of those entries — the CLI entry, the two agent-hook entries, the five git-hook entries and the two worker entries — is exactly the set the cross-surface runtime registry treats as a "complete" distribution, so a bundle that passes these assertions is one the registry will accept as a candidate. The session-bootstrap entry and the dashboard-server entry are the plugin's own additions on top of that set, and are deliberately outside it: promoting either would make every already-installed bundle fail the completeness check and de-register itself.

### Publish pipeline

Four independent output targets share one build → verify → sync core:

1. **Local test directory** — a plain, non-version-controlled directory the user points their assistant at directly, for pre-push end-to-end testing.
2. **Private dry-run repository** — commits and pushes into an internal repository, letting a release be rehearsed before it is public.
3. **Public repository** — the real release target end users add as their marketplace source. It shares one flow with the dry-run target but is **not** identical to it: the two pass different destinations, different marketplace source references — which are resolved into each target's own mirrored README, so the two published artifacts genuinely differ — and different target kinds, and that third argument is what makes the version guard run here and only here.
4. **Single-file archive** — a zip whose top-level entry is the plugin's own directory (not its flattened contents), suitable for a manual "upload a plugin file" install path.

Every path rebuilds the bundle first and asserts it is complete (every required bundle file present and non-empty) before doing anything else, since an incomplete bundle silently ships a plugin that blocks the installing user's git operations rather than merely degrading. The two git-committing targets additionally: refuse to mirror into a destination directory unless it is either an existing checkout of this same marketplace or empty (guarding against accidentally wiping an unrelated directory with a destructive mirror-and-delete sync); resolve a placeholder token in the mirrored README into the target's own marketplace source reference, failing if the token is absent or survives the rewrite; stage the mirrored tree with the operator's machine-global exclusion file neutralized (the destination repository's *own* exclusion rules are still honoured); skip committing entirely when that staging produced no change; and then, only once a commit is certain, assert that the built bundle files, the exact expected count of skill files and of command files, and a fixed list of singleton configuration files are all actually staged for commit (catching a stray ignore rule silently dropping one of them).

**That singleton list carries the licence twice, and both entries are load-bearing.** The bundle redistributes Apache-2.0-licensed code, and two different units are distributed: the mirrored tree's root licence file, which is what a reader of the marketplace page receives, and a second copy inside the shipped plugin directory, which is the only unit the ecosystem's install command and the single-file archive actually copy — a root-only copy never reaches an installed plugin. The rest of the list is the bundled MCP server registration, the hook manifest and the plugin manifest; the mirrored README is deliberately *not* on it, so the placeholder-resolution step above is the only thing that would notice a README going missing.

**The mirror no longer excludes the licence**, which makes this repository the single source of the licence text for every target, the archive included. The exclusion that used to exist was there to preserve a hand-created root copy in the public destination from the delete-extraneous sync — but while it stood, the dry-run destination, which was never created with a licence of its own, mirrored an Apache-2.0 plugin carrying no licence text at all, and no copy could ever reach the archive. Dropping it overwrites the public destination's existing file with a byte-identical one, and puts the licence in front of the dry-run and archive audiences for the first time.

**The version guard runs on the public target only.** Each git-committing target declares its kind, and the private dry-run target passes a marker that **skips the guard entirely**, printing two lines that say so and warning testers to remove and re-add the plugin rather than update it. On the public target the guard refuses to commit changed content unless the version identifier is **strictly greater** than the last published one — equality is rejected, and both the candidate and the baseline must match a three-numeric-component shape in full or the comparison answers "not greater" rather than padding or truncating — so a malformed version *blocks* the release instead of being guessed at. Components that do match are compared left to right as integers, base ten, so a leading zero carries no octal trap. The baseline is recovered by stripping a fixed release-subject prefix from the destination's most recent commit subject; when that prefix does not strip the guard deliberately falls through, which is what lets a first publish into an empty or unrelated checkout proceed. The reason for the guard at all is that the assistant's own "check for plugin updates" mechanism compares only the version field, so shipping a fix without bumping it would leave every already-installed user believing they are up to date.

A single override variable bypasses both the version guard and the safe-destination refusal, covering a deliberate same-version republish and a first-time re-target of a destination; a separate variable commits without pushing. Because the dry-run target skips the guard rather than overriding it, a green rehearsal proves the inventories but says nothing about whether the public target will accept the version.

### Versioning model

The plugin carries its own semantic version and release cadence, entirely independent of the release cadence of the product's other install surfaces (the standalone command-line tool, an editor extension, an IDE plugin). The only coupling is that the plugin's bundle is a frozen snapshot of the shared product logic taken at build time: a change to that shared logic does not reach an already-installed plugin user until the plugin itself is rebuilt and republished — it lags, it does not break.

### Host-side self-detection

The shared product logic that this plugin bundles is able to detect, at runtime, that it is running inside this specific embedding (as opposed to the standalone tool, an editor extension, or an IDE plugin), and changes two behaviors as a result:

1. **Outbound self-identification.** Every backend request this bundle makes identifies its origin using a value distinct from every other embedding's, so server-side version-gating and telemetry can distinguish this surface from the others rather than misattributing its traffic to the standalone tool.
2. **Disabling unrelated optional-extension discovery.** The shared logic normally probes the installing machine for a small, fixed set of unrelated optional command-line extensions (documentation-site generation, a proprietary collaboration extension) at every invocation. Inside this embedding that probe is unconditionally skipped, with the identical effect to the general opt-out switch that already exists for that mechanism — because this embedding is a fixed, closed command surface, and leaving the probe live would scan the installing user's machine and risk emitting confusing compatibility warnings or upgrade notices for extensions this embedding never uses and could not act on anyway.

### Interaction with the shared environment-setup bootstrap

The plugin reaches the product's shared environment-setup orchestrator in two places: from its own session bootstrap (automatically, every session) and from its setup command's recipe (explicitly, when the user runs it). Both select the same narrowed **repo-hooks-only** mode. What that mode installs is the orchestrator's business; what matters here is the plugin-specific framing:

- The mode is mutually exclusive with a different narrowed mode meant for a different purpose — requesting both fails the call.
- It installs more than its name suggests: besides the repository's git hooks, it installs the product's **canonical session-stop and session-start agent hooks** into the assistant's per-project local settings file, writes the bare unnamespaced menu skill, sweeps retired and legacy skill directories, and creates the per-project state. This is precisely why the plugin manifest no longer needs business hooks of its own.
- The two callers make **opposite** choices about the user's durable "leave this project alone" preference. The automatic session bootstrap asks the orchestrator to **respect** it, so a user who deliberately disabled the product for a project does not have hooks silently reinstalled every session. The setup command's recipe does not — an explicit user-run setup both ignores and **clears** the opt-out, which is the intended meaning of a user deliberately asking to set the project up again.
- It passes an identity tag naming this plugin. The tag's **only** effect is to select which slot this bundle occupies in the machine-global runtime registry — one registry entry per source, named by the tag. It is **not** stamped onto any hook the mode installs: every git hook line and every agent hook entry written into the project is byte-identical across all install surfaces and carries no surface identity at all.
- The same-session "reload skill definitions" request is **not** an option of this call. It is produced by the plugin's own session bootstrap, from its own before/after observation of the bare unnamespaced menu skill, and returned as part of the bootstrap's structured output — so that companion skill (the ecosystem's mandatory bare entry point, which a plugin's own namespaced skills structurally cannot provide) becomes usable in the very session that just installed it, rather than requiring a restart.

### How the plugin competes for the active runtime

The plugin's bundle is one ordinary candidate in the machine-global runtime registry, registered under its own source tag by the environment-setup call above, carrying the same product core version the standalone CLI would carry and containing the full complete-distribution entry set.

It **expresses no preference for itself.** It sets no selection override — none of its command or skill recipes, and none of the hooks it installs, carries one — and its tag is deliberately absent from the fixed cross-surface preference order. The consequences are exact:

- The plugin's bundle wins only by carrying a **strictly higher** version than every other eligible candidate.
- At an equal version it **loses** to the standalone CLI, and to the editor-extension and Cursor sources, because those are the fixed preference order and it is not in it.
- At an equal version it wins only when none of those three is present-and-eligible, in which case it simply remains the incumbent.

An earlier revision did opt in: every one of the plugin's command recipes prefixed its invocations with a selection override naming this plugin, so the plugin's own bundle won ties. That was deliberately removed, so an equal-versioned standalone CLI now wins — the reasoning being that a user who has both installed expects the canonical CLI build to service their hooks, and that a plugin bundle is a frozen snapshot which should never displace a live install of the same version.

## Notable Behavior

- **A fixed, closed command surface, not a plugin host.** This bundle exists to run exactly the MCP server, the narrowed bootstrap, and the hook scripts — it never itself discovers or loads any further optional extension, and the shared logic it bundles is explicitly told to behave as if that separate discovery mechanism does not exist.
- **Zero global command-line dependency by design.** The product goal driving the self-contained bundling is that a user can get the full experience from installing only this plugin — no separately-installed command-line tool, and (per its declared requirement) no package-manager runtime on the installing machine either, only a general-purpose script runtime.
- **The release-guard reverts on trip.** When a version-bump was forgotten before a real release attempt, the guard does not merely refuse — it names both versions, states the exact three-component shape requirement, and then hard-resets the destination checkout to its last commit and removes untracked files on the way out, since the sync step that ran immediately before had already left it modified-but-uncommitted. The rationale stated in place is that this marketplace checkout is a generated artifact that is never hand-edited. **The sibling Codex plugin's twin does the opposite**: it leaves the mirrored build in place and prints a hint naming the two commands that would discard it, on the reasoning that its mirror may hold deliberate local edits. An operator who learned one plugin's behavior will find the other's destination in the opposite state. (Spec 328.)
- **The version guard exists only on the public path.** The dry-run target skips it outright and announces the skip, rather than overriding it — so the rehearsal cannot rehearse the one check most likely to stop a release, and the two destinations' version histories are free to diverge. Every other publish assertion still runs on the dry-run path. (Surprising.)
- **A mistyped target kind publishes unguarded, while announcing that the guard was skipped.** The kind is tested against the literal release word, and *anything else* takes the other branch — which prints the rehearsal's two reassuring lines and proceeds with no version check at all. The stated rationale for the argument's default is that a call site which forgets it gets the stricter behavior; that holds for **omission** (an absent argument defaults to the release kind) and not for a typo, which lands on the public destination with the version check silently off. (Surprising.)
- **The version guard is skipped whenever the destination's newest commit is not a release commit.** The baseline is that commit's subject with a fixed release-subject prefix stripped; when the prefix does not strip, the subject and the "baseline" are the same string and the guard deliberately falls through. That fall-through is what lets a first publish into an empty or unrelated checkout proceed — but it is not scoped to that case: **any** commit whose subject lacks the prefix, however it got there (a hand-applied edit, a merged change from elsewhere), disarms the guard for the next publish, which is the one occasion the silent downgrade it exists to prevent could occur. So whether the guard is armed at any moment is a property of the destination checkout's own newest commit, not of the pipeline — and only the public destination is exposed to this at all, since the guard is release-kind-only and the rehearsal destination never runs it. (Surprising; the exposure is conditional, not standing.)
- **The single-file archive is ungated on configuration.** It checks the bundle inventory — the same list the git-committing targets use — but never reads the singleton configuration list at all, and after packing confirms only that one single bundle entry survived into the archive. A missing in-unit licence copy therefore ships silently in the archive — and the archive distributes precisely the unit that second copy exists for. The local test directory asserts nothing about configuration either. **The sibling Codex plugin gates both of those paths** on its own source-tree inventory. (Notable. Spec 328.)
- **An ignore rule in the destination that swallows only the licence produces a green no-op.** The sync writes the file; the staging step honours the destination repository's own exclusion rules and skips it; the change check then finds nothing staged and the run exits reporting the target already up to date — *before* the configuration assertion is ever reached, since that assertion runs only once a commit is certain. Ignore rules do not affect an already-tracked file, so the case this bites is precisely a destination that has never carried a licence copy — which is the case the two licence entries were added for. The sibling Codex plugin's pipeline exits the same way. (Surprising; the silent-shipping case the required list is claimed to catch is the one it cannot see. Spec 328.)
- **Exact-count assertions, not just presence checks.** The publish safety checks assert the *exact* expected number of skill files and command files staged, not merely "at least one," specifically to catch a partial loss (one file silently dropped by an unrelated ignore rule) that a simple non-empty check would miss. There is no corresponding subagent assertion, because there are no subagents to assert.
- **A build-time guard on the manifest, not just a convention.** The single-hook shape of the manifest is enforced by the build, which refuses to produce a bundle if the manifest gained a second event, a second action, or an action pointing anywhere other than the bootstrap entry. This is the mechanism that keeps "the plugin registers no business hooks" true rather than merely intended.
- **The plugin expresses no runtime preference and can lose to an equal-versioned peer.** It competes purely on version, and the fixed cross-surface preference order — which does not contain this plugin — settles ties against it. Two earlier designs were both retired: a hard pin to this plugin's bundle (resolve to it or fail), and then a soft override that made it win ties. Neither remains, so an incomplete or stale plugin bundle can never block resolution to a healthier surface, and a live equal-versioned standalone CLI install is preferred over the plugin's frozen snapshot.

## Shared Behavior

- The underlying git-operation hooks, their detached background workers, the two agent session hooks, and the memory-generation pipeline they drive are shared verbatim with every other install surface; this plugin's build step bundles the identical code, and its narrowed environment-setup mode installs byte-identical hooks into the user's project.
- The session bootstrap the manifest's one action launches has its own topic; this spec owns only the manifest registration and the build guard around it.
- The MCP tool surface this plugin's server exposes is the same tool surface described by the MCP server spec; this plugin contributes only the registration entry, not the tool implementations.
- The recall/search resolution logic invoked by this plugin's skills (whether via the assistant's native tool call or via the command-line fallback) is the identical resolution logic used by every other surface that offers recall/search.
- The cross-surface version-selection mechanism this plugin's bundle competes in is shared with every other install surface. The plugin contributes one registry entry named by its identity tag and nothing else — no preference, no override, and no marker anywhere in the repository.
- The companion bare, unnamespaced menu skill referenced above is owned by **spec 303**; this plugin only creates the conditions (namespaced skills that need a front door, plus the same-session reload signal) that make it necessary. That spec's action list is the authority on which of this plugin's namespaced skills the companion menu routes to.
