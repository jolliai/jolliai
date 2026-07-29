# 48 — Skill File Installation

## Topic Statement

The skill-installer machinery writes every registered skill's instruction document independently through a shared, revision-guarded upsert primitive, targeting the single cross-platform Agent Skills directory.

## Scope

**In scope.** The registry of skills, the single shipped target directory (the cross-platform Agent Skills standard) and the retained-but-dormant gating machinery, the per-skill upsert primitive, the target-path layout, the shared frontmatter contract (the fields that apply to every registered skill), the revision-guard semantics that decide whether to overwrite each skill independently, the ownership marker that protects a user's own same-named skill, the legacy-directory removal pass, the retired-skill sweep and its two trigger points, the two write modes (replace vs. union) that act on the managed local-exclude block, the separate Claude-Code-slot operations driven by the reduced repo-hooks-only plugin bootstrap (writing the bare umbrella menu, removing legacy unnamespaced copies) and by uninstall, the startup auto-refresh trigger that re-runs the upsert for CLI-only users on a version change — including the manual-disable opt-out that suppresses it — (and the paired hidden moved-command notices), idempotent re-runs, and tolerance of write failures.

**Out of scope.** Each skill's body content — the specific instructions written into each skill document are owned by their respective per-skill specs (spec 140 for `jolli-recall`; spec 141 for `jolli-search`; spec 273 for `jolli-local-run`; spec 274 for `jolli-remote-run`; spec 272 for the standalone `jolli` umbrella-menu skill's body; spec 303 for the plugin-bootstrap companion bare-`jolli` menu's body). The retired PR skill's former body — spec 211, kept only as a historical record. The recall flow at runtime (spec 7). The underlying CLI command behavior invoked by the skills (specs 137 and 138). MCP client registration into each host (spec 149).

## Data Contracts

### Target directory family

A full `jolli enable` writes each registered skill's `SKILL.md` into exactly **one** target-directory family under the project (or worktree) root:

- **Agent Skills standard** — `.agents/skills/<skill-name>/SKILL.md`, the cross-platform layout picked up by Codex CLI, Cursor, Windsurf, OpenCode, Gemini CLI, and GitHub Copilot. This family is **unconditional** — it is always written, regardless of any per-host detector. The rationale is that gating it behind a per-host detector list would miss hosts a user has but the installer did not detect, and the cost is only small documents that `.git/info/exclude` keeps out of `git status`.

**Claude Code (`.claude/skills/`) is no longer a full-`enable` write target.** The Claude Code plugin ships Jolli's skills as namespaced `/jolli:*`, so writing unnamespaced `.claude/skills/jolli-*` copies here would only duplicate them in the Claude `/` menu. A full `jolli enable` therefore skips that directory entirely. The `.claude/skills/` slot is now touched only by the separate, plugin-driven operations described below (the bare-umbrella write, the legacy-copy cleanup, and the uninstall removal) — not by the per-skill upsert loop.

The target-family machinery still carries a per-family `enabled` gate, but with a single always-on family shipped today that gate never short-circuits; it is retained purely as an extension point for a future re-gated target. Because there is one family, the previous "Claude Code first, then Agent Skills" iteration ordering no longer applies — only the registry order (below) is observable.

### Target path pattern

Within each enabled family, each skill is written to `<family-dir>/<skill-name>/SKILL.md`. Each skill occupies its own directory containing exactly one document named `SKILL.md`. The per-skill name segment is defined by the skill's own content spec; the containing directory and file name are dictated by each host's per-project skill-discovery contract.

### Skill registry

The installer iterates a fixed, ordered registry of skills. Each registry entry pairs a skill name (the directory-name segment used in the target path) with a content emitter (an opaque callable that returns the full rendered document). The full registry is iterated once for the single enabled target family. Registry order determines install order on first run. Adding a new skill is an append-only operation; removing a skill from the registry does not by itself remove its on-disk directory — that requires adding its name to the retired list below. As of this writing the registry holds five skills — `jolli-recall`, `jolli-search`, `jolli-local-run`, `jolli-remote-run`, and the `jolli` umbrella-menu skill — in that order.

### Legacy directory names

Predecessor versions of the product wrote skills under different directory names. These only ever lived under the Claude Code family (`.claude/skills/`) — the Agent Skills family is a newer target with no legacy names to clean up. The installer removes any directories matching the legacy names before processing any registered skill:

- `jollimemory-recall` — an early form of the product name, used during the v1 era.
- `jolli-memory-recall` — an intermediate hyphenated form, used during the v2 era.

Removal is a recursive remove of the legacy directory. Failures are tolerated silently (the directory may not exist, or the user may have it open in another tool).

### Retired skill names

Distinct from the legacy *directory names* above, the installer also carries a short list of skill **names the product used to ship and no longer does**. As of this writing that list holds exactly one name — `jolli-pr`, the retired PR skill (spec 211, kept as a historical record only). PR authoring moved off a dedicated skill; the programmatic PR-description tool and its command-line counterpart that backed the skill both remain, so only the skill document was retired, not the capability.

A retired name is no longer emitted by anything — it is absent from the registry — and is additionally **swept off disk** on every reconciliation, so an upgrade never strands a dead skill in the user's repository where every host that reads the cross-platform directory would keep offering it.

### Frontmatter contract

Every registered skill's document begins with a YAML-style frontmatter block delimited by `---` lines. The frontmatter is **spec-compliant only** — it carries no host-private fields — so the same byte-identical document validates under the cross-platform Agent Skills standard and runs on every host (Claude Code, Codex, Cursor, Windsurf, OpenCode, Gemini CLI, GitHub Copilot). The following fields are present in every skill document; their per-skill values are defined by the respective content specs:

- `name` — the skill identifier; used by the host's skill-dispatch machinery.
- `description` — a one-line summary displayed when the host lists available skills.
- `metadata` — a nested block (two-space-indented) carrying product metadata:
  - `version` — a display/bundled version string derived from the packaging tool at build time. Informational only; it is **not** the idempotency key (see `revision`).
  - `revision` — a monotonic integer that is the skill's content revision and the sole key the write guard uses. It is **decoupled** from any tool's release version and is *intended* to be bumped in lockstep across the command-line, editor-extension, and JetBrains-plugin surfaces whenever a skill's body changes. Each skill carries its own revision literal baked into its rendered template. **The lockstep is an intent, not an enforced invariant, and it is currently violated** — see the observed divergence recorded under Notable Behavior.
  - `vendor` — the constant `"jolli.ai"`, identifying the skill's origin and serving as the ownership marker.

No host-private fields are emitted. In particular the Claude-specific keys `argument-hint`, `user-invocable`, and `disable-model-invocation` are deliberately **absent**. Their omission is what keeps the document portable across every skill host rather than Claude-only.

### Ownership marker

A skill document is recognised as Jolli-written (as opposed to a user's own hand-authored skill of the same name) when it carries **either** the modern `vendor: "jolli.ai"` metadata **or** a legacy top-level `jolli-skill-version:` frontmatter key. A file carrying neither marker is treated as user-owned and is **never** overwritten, even when its (absent) revision would otherwise make it a candidate for upgrade. The legacy `jolli-skill-version:` marker is honoured so a one-time migration of a pre-revision Jolli file still reaches existing installs.

### Bundled version and content revision

The installer carries an embedded version string derived from the bundling tool's package version at build time; in test and development contexts where no package version is set, the string is `dev`. This string is substituted into each rendered document's `metadata.version` field at write time, but it does not participate in the write decision.

The write decision is driven entirely by `metadata.revision`. The guard reads the revision from the rendered template ("our revision", the literal the current build ships for that skill) and from the on-disk document, and compares the two integers. A document whose `revision` cannot be parsed — an absent revision line, or a legacy pre-revision file — is assigned a sentinel revision lower than any real revision, so it is upgraded exactly once (after which it carries a revision and converges).

## Behavior

### Install / update sequence

1. **Legacy cleanup.** For each name in the legacy-directory list, recursively remove the corresponding directory under `.claude/skills/<legacy-name>/`. Run this pass once for the whole installer, before processing any registered skill. Failures are silently tolerated.
2. **Per-skill upsert loop.** For the single enabled target family, and within it for each registered skill in registry order, execute the upsert sequence (steps 3–5) independently. A revision match on one skill does not skip the others; each skill is checked and written without regard to the outcome of any other skill.
3. **Ownership + revision guard.** Compute the current target path for the skill and attempt to read the existing document.
   - If the file does not exist, fall through to the write step.
   - If the file exists but carries **no** Jolli ownership marker (neither `vendor: "jolli.ai"` nor the legacy `jolli-skill-version:`), it is the user's own skill — return without writing (never overwrite it).
   - If the file exists and is Jolli-owned, parse its `metadata.revision` (an absent/unparseable revision is treated as the low sentinel) and compare it to our revision:
     - **disk revision ≥ our revision** → return without writing. (Equal means identical content by the lockstep contract; greater means a newer tool wrote it — never downgrade.)
     - **disk revision < our revision** → fall through to the write step (we are newer).
4. **Render and write.** Invoke the registered content emitter to produce the full document text. Recursively create the skill's parent directory. Write the rendered document to the target path. Record an info-level log entry including the revision and the absolute path written.
5. **Failure handling.** If directory creation or file write fails, log a warning at warning level. Do **not** propagate the error to the caller — skill installation is a strict enhancement and a failure here must not block the rest of the install pipeline.

### Retired-skill sweep

Alongside the legacy cleanup, every reconciliation removes each **retired skill name** (see Data Contracts) from disk, so an upgrade actively deletes a skill the product no longer ships rather than leaving it discoverable.

- **Coverage.** The sweep walks every directory in the target-directory family — today the single cross-platform Agent Skills directory — and, for each retired name, targets `<family-dir>/<retired-name>/`.
- **Unconditional.** Unlike the per-skill upsert loop, the sweep does **not** consult the per-family `enabled` gate. A retired skill must be removed from a directory regardless of whether new skills would be written there.
- **Ownership-guarded.** The retired directory's `SKILL.md` is read first. A document carrying **no** Jolli ownership marker is a user's own hand-authored skill that merely shares the name, and is **kept** (the decision is recorded at info level). Only a Jolli-owned document's directory is recursively removed. An absent directory or document is a silent no-op.
- **Fail-soft.** A removal failure is logged at **warning** level and swallowed, never propagated — the same enhancement-not-requirement posture the per-skill write step takes.
- **Two independent trigger points.**
  1. The full reconciliation runs the sweep **once**, after the legacy-directory cleanup and **before** the per-skill upsert loop.
  2. The reduced repo-hooks-only bootstrap runs the sweep **directly, per worktree**, alongside its Claude-Code-slot legacy cleanup. That mode returns before it ever reaches the per-skill upsert loop, so without this second trigger a plugin-only upgrade left the retired skill's directory in place for the cross-platform hosts — the Claude-slot legacy cleanup covers only the Claude-Code directory, not the cross-platform one.

### Revision comparison is directional

The revision guard is a "greater-than" comparison, not equality: a lower on-disk revision is upgraded, an equal one is skipped, and a **higher** one is never downgraded. This is what lets multiple tools (CLI, VS Code, IntelliJ) co-manage the same `SKILL.md` without endlessly rewriting each other's file — the highest revision wins and everything converges. A content hash was rejected because it would make churn-freedom depend on byte-identical content across tools, so one stray byte would reignite the rewrite war.

### Idempotency

A re-run with no revision change is a no-op for each skill whose on-disk revision is greater than or equal to ours (the guard short-circuits before any directory creation or write). A re-run after a revision bump rewrites each affected skill's document. A re-run never duplicates; there is exactly one target path per registered skill in the single family.

### Claude-Code-slot operations (plugin-driven, separate from the upsert loop)

The `.claude/skills/` directory is not part of the per-skill upsert loop above, but three separate operations act on it:

- **Bare umbrella write.** The Claude Code plugin's reduced repo-hooks-only bootstrap writes **only** the bare `/jolli` umbrella menu into `.claude/skills/jolli/SKILL.md` (a plugin skill can only ever be invoked as `/jolli:<name>`, so the bare `/jolli` front door must come from a non-plugin project skill). This writes just the umbrella, not the unnamespaced `jolli-recall|search` siblings, and it goes through the same ownership-and-revision upsert primitive — so a pre-existing user-owned `.claude/skills/jolli/` is left untouched, and a stale earlier umbrella is reclaimed by revision. The umbrella variant written into this slot ships a higher revision than the standalone menu so the bootstrap reclaims a legacy standalone menu that a pre-upgrade `enable` may have left there; that ordering is asserted at build time and the actual integers are recorded under Notable Behavior. Its body is owned by spec 303.
- **Legacy unnamespaced cleanup.** The same bootstrap deletes the pre-plugin unnamespaced Jolli skills from `.claude/skills/` — the registered skill names minus the bare `jolli`, **plus** the retired skill names, **plus** the ancient legacy names — because the plugin now ships them as namespaced `/jolli:*`. Only a directory whose `SKILL.md` carries a Jolli ownership marker is removed; a user's own same-named skill is kept. This pass covers the Claude-Code slot only, which is why the retired-skill sweep is invoked separately for the cross-platform directory.
- **Uninstall removal.** Uninstall removes the bare `/jolli` umbrella from both the `.claude/skills/jolli/` slot and the Agent Skills `.agents/skills/jolli/` slot, again only when the on-disk `SKILL.md` carries the `vendor: "jolli.ai"` marker. The `jolli-*` sibling skills are deliberately left behind (see "What is not removed by uninstall").

### Managed local-exclude entries: replace vs. union

The skill documents written under the project root are recorded in the repository's managed local-exclude block so they never pollute `git status`. Two different write modes act on that one block, and the difference is load-bearing:

- **A full enable REPLACES the managed block** with the complete entry set it owns — one entry per registered skill per target family. Replace semantics are what make an entry the current build no longer owns disappear automatically: a name dropped from the registry, or a stale Claude-Code-slot entry that a pre-upgrade enable wrote before that slot stopped being a write target.
- **The reduced repo-hooks-only bootstrap UNIONS a single entry** into the same block — the one covering the bare `/jolli` umbrella it writes into the Claude-Code slot. Every entry already present is preserved and only genuinely-new entries are appended, in the order given, so a re-run that changes nothing performs no write at all.

The asymmetry follows from the two surfaces owning different path sets. The bootstrap re-runs on every session start and knows only its own single entry; replacing the block from there would **shrink** a block a prior full enable had populated — un-hiding those paths in `git status` and rewriting the file every session. Both modes are fail-soft: a non-repository directory, an unavailable version-control binary, or any read/write error is logged and reported as a failed update rather than thrown.

### What is not removed by uninstall

The per-skill `jolli-*` directories are not part of the orchestrator's uninstall sequence. Once written, they persist across `enable` / `disable` cycles; a user can remove them manually, but the standard uninstall flow leaves them in place. The **one exception** is the bare `/jolli` umbrella: uninstall removes it from both the `.claude/skills/jolli/` and `.agents/skills/jolli/` slots (only when the on-disk `SKILL.md` carries the `vendor: "jolli.ai"` marker), because the umbrella is written outside the Claude Code plugin's own bundle and would otherwise linger as a broken menu routing to `/jolli:*` skills that no longer exist.

### Startup auto-refresh (CLI self-heal)

`jolli enable` and IDE activation are no longer the only triggers that reconcile the on-disk skill recipes. A staleness check runs from the command-line entry point on **every** invocation, except the three skill-lifecycle commands `enable` / `disable` / `uninstall`, which own skill state themselves and would either double-write what `enable` already reconciles or re-add skills an `uninstall` is about to remove. It re-runs the same revision-keyed upsert described above, so the write decision for each skill still obeys the ownership + revision guard — the startup path only changes *when* the upsert runs, never *how* it decides.

**Rationale.** Before this trigger, `updateSkillsIfNeeded` ran only from `jolli enable` and IDE activation. A CLI-only user who upgraded the global package (`npm i -g @jolli.ai/cli`) **without** re-running `jolli enable` kept whatever recipe revisions were on disk at their last enable. When a release renamed or relocated a command a recipe shells — e.g. the workflow-run surface moving to the `@jolli.ai/workflow-cli` plugin (`local-run-workflows` → `workflow local-run`) — those stale recipes called a name the upgraded host no longer provided and broke, with no re-enable in sight. The startup refresh closes that gap; the existing `enable` / IDE-activation refresh is unchanged, this is an **additional** trigger.

The refresh is guarded so it stays a near-free no-op on the hot path and never acts where it shouldn't. **All** of the following must hold, else it is a no-op:

- **Dev-guard.** When the running version is `"dev"` (unset package version, i.e. `tsx` / test / unbuilt runs), it returns immediately — mirroring `checkVersionMismatch`, so a dev build never rewrites skills (developers iterate via `jolli enable`). Unit tests drive the real path by injecting a concrete version.
- **Enabled-repo-only.** It walks **up** from the invocation cwd for the nearest ancestor directory that already has an installed Jolli skill, probing `<dir>/.agents/skills/jolli-recall/SKILL.md` (`jolli-recall` is the first registry entry and is always written on enable). The probe is purely the presence of that document — **no** repository check is performed, so any ancestor carrying it qualifies as the root to reconcile. If no such ancestor is found before the filesystem root, it is a no-op — it never **creates** skills in an un-enabled repo. A repository set up only through the reduced repo-hooks-only bootstrap therefore never acquires the probe document and this refresh is a permanent no-op there.
- **Version guard.** It reads a per-repo marker `<worktreeRoot>/.jolli/jollimemory/skills-refresh.json` (`{ "version": "<cli version>" }`); if that already records the running version, it skips. This keeps the common (already-current) path to a single small file read, comparable to the existing `checkVersionMismatch` startup read.
- **Not-manually-disabled.** After the version guard has already decided a refresh is warranted, the repository's durable manual-disable opt-out is read; when it is set, the refresh returns without writing anything. Two details are load-bearing:
  - **This flag is the real gate, not the ancestor probe.** Disabling deliberately leaves the installed skill documents on disk (conservative cleanup), so the enabled-repo probe above still matches a disabled repository. Without this fourth guard a version-bumped tool would happily rewrite skills in a repository the user explicitly turned off, violating the zero-write contract that disable promises (spec 304).
  - **The read must be a read-only, synchronous probe.** The ordinary asynchronous reader of the same flag *migrates* the legacy per-worktree disable marker into the shared repository profile — a disk write, which would itself break the zero-write contract on this path. The refresh therefore uses the non-migrating variant, which anchors to the shared main-worktree profile, falls back to the legacy marker in the probed root, and reports `false` on any failure.

  The check is deliberately placed **after** the version guard so it costs nothing on the common already-current path, which stays a single marker read.

Only when all four pass does it run `updateSkillsIfNeeded` and then stamp the marker with the running version (atomic write). Any error is **swallowed** and logged at debug level — a refresh problem must never break the command the user actually ran (fail-soft).

On the manually-disabled path the version marker is **not** stamped, so the flag is re-read on every subsequent invocation at that version rather than being remembered as "reconciled". A re-enable therefore lets the very next invocation perform the deferred refresh, with no marker to clear first.

**Paired moved-command notices.** A registration pass over the command surface, run from the same entry point, complements the auto-refresh. The three flat workflow-run command names removed when that surface moved to the `@jolli.ai/workflow-cli` plugin — `local-run-workflows` (→ `workflow local-run`), `workflow-run-status` (→ `workflow run-status`), and `workflow-runs` (→ `workflow runs`) — are re-registered as **hidden** host commands that print a "this command has moved to `workflow <sub>`; your skills were just refreshed; re-run your request" notice and exit non-zero. This replaces the command parser's bare "unknown command" error when a stale recipe shells an old flat name; because the auto-refresh has already rewritten that recipe to the new name in the same invocation, the re-run resolves on the next agent step. Registration is **unconditional** (the old flat name does not exist even when the plugin is installed, which uses the namespaced `workflow <sub>` form) and **collision-tolerant** — a real command already owning the name always wins, and the notice is skipped for it. These are a bounded migration aid, safe to remove once pre-migration recipe revisions are out of circulation.

## State Transitions

Per registered skill, in the single target family, per project/worktree:

- **No skill document present, no legacy directories** → install transitions to "Jolli skill document present at current revision".
- **Legacy directory only** → install transitions to "Jolli skill document present at current revision" (legacy directory removed in the cleanup pass; skill then written fresh).
- **Jolli skill document whose revision ≥ ours** → install is a no-op for this skill (never downgraded).
- **Jolli skill document whose revision < ours** → install transitions to "Jolli skill document present at current revision" (document rewritten/upgraded).
- **Jolli skill document with no recognisable revision** (absent or legacy pre-revision) → install upgrades it exactly once (the low sentinel is below any real revision), then it converges.
- **Document present but carrying no Jolli ownership marker** → install is a no-op (user-owned; never overwritten regardless of revision).

Per retired skill name, in each target-family directory:

- **Retired skill's directory present, its document Jolli-owned** → the sweep removes the directory (independently of every registered skill's outcome, and independently of the family's `enabled` gate).
- **Retired skill's directory present, its document carrying no Jolli ownership marker** → kept (user-owned).
- **Retired skill's directory absent** → no-op.

## Notable Behavior

- The legacy cleanup pass runs before the per-skill upsert loop, not as a per-skill fallthrough. A project that has only a legacy directory will have the legacy directory removed and then all registered skills installed fresh on the same run.
- The guard tolerates an unreadable existing document: any error encountered while reading the existing skill is caught and the upsert falls through to the write step. A corrupt Jolli-owned document is silently overwritten — a corrupt skill document is worse than no skill document. (A readable but unmarked document is still protected as user-owned.)
- **Revision, not release version, drives writes.** Because the guard keys on the decoupled `metadata.revision` integer rather than the package version, a plain product release that does not touch any skill body triggers **no** rewrite — the revision is unchanged. This is a deliberate change from the older behaviour where every version bump rewrote every skill. A skill is rewritten only when its `revision` literal is bumped (intended to happen in lockstep across all three surfaces — see the observed divergence below).
- The registry is processed entry-by-entry, so adding a new skill never blocks on an existing skill's revision match — the new skill installs independently on the next run.
- **Cross-tool convergence, no ping-pong.** On a project last touched by any surface, a subsequent run by another surface sees an equal (or higher) revision and is a no-op — the comparable revision integer is what stops the three tools from endlessly rewriting each other's `SKILL.md`. Convergence holds regardless of whether the three surfaces agree on a skill's revision, because the rule is "highest wins, never downgrade".
- **Observed divergence: the JetBrains plugin is a revision behind on two recipes.** The stated lockstep rule above is not what currently ships. The recall and search recipes were revised and bumped from revision `1` to revision `2` on the command-line surface (and therefore on the editor extension, which bundles that surface's templates verbatim). The JetBrains plugin ships its own bundled copies of exactly those two recipes and they are still at revision `1`, carrying the pre-change bodies. Consequences, all grounded in the directional guard above: convergence is unharmed (an install touched by the command line reaches revision `2` and the JetBrains plugin's revision-`1` template is then correctly declined as a downgrade), but an installation reached **only** by the JetBrains plugin keeps the older body **indefinitely** — nothing on that path will ever raise it. This is recorded as an observed state of the code, not as the rule. (Notable; a real divergence from the stated lockstep.)
- **A body edit without a revision bump is a build failure, not a silent no-op.** Because the guard skips on an equal on-disk revision, editing a rendered body without bumping its revision literal would ship *nothing* — every existing install would keep the old text while every surface reported success, and neither a rebuild nor a disable/enable cycle would change that. A repository-level guard closes the trap: each shipped body is pinned to a stable fingerprint alongside its declared revision, so a body edit that forgets the bump fails the build instead of shipping dead. The fingerprint deliberately excludes the frontmatter's release-version line, so a routine release bump does not churn it. Bump the revision **and** update the fingerprint in the same change. (Notable; load-bearing.)
- **A companion assertion pins the plugin umbrella above the standalone umbrella.** Both bare-`jolli` variants claim the same skill name and both carry the same vendor marker, so the ownership guard cannot tell them apart and arbitration between them is purely by revision. A separate repository-level assertion therefore requires the plugin-bootstrap companion's revision to be **strictly greater** than the standalone umbrella menu's, which is what lets the bootstrap reclaim a pre-upgrade standalone menu left in the Claude-Code slot rather than stranding a menu that routes at nothing. The prose note carried alongside the templates states this invariant correctly in kind but cites **stale integers**: it claims the companion "is therefore revision 6 (above the standalone's current revision 5)". The true shipped values are **7** for the companion and **6** for the standalone. The invariant still holds (7 > 6) and the assertion enforces it, so the drift is documentation-only — but a reader trusting the note would believe a bump to 6 is safe when it would in fact tie the standalone and strand the pre-upgrade menu. (Notable; the note should be corrected in place. Spec 303 records the same finding.)
- **User-owned skills are sacrosanct.** A `SKILL.md` lacking any Jolli ownership marker is never overwritten, even when it has no revision line (which would otherwise read as the low sentinel and invite an upgrade). The realistic collision this protects is a user's own hand-authored bare `.claude/skills/jolli/`. The same marker gates *deletion* in the retired-skill sweep and the legacy-copy cleanup, so a user's own same-named skill survives a retirement.
- **A retired skill is actively deleted, not merely no longer written.** Dropping a name from the registry stops emitting it but leaves the old directory on disk, where every cross-platform host would keep offering a dead skill. The retired-name list closes that gap: the sweep is unconditional (it ignores the per-family `enabled` gate), marker-guarded, fail-soft on removal, and fires from **two** independent trigger points — once before the full reconciliation's upsert loop, and separately in the reduced repo-hooks-only bootstrap, which never reaches that loop.
- **The managed local-exclude block has two write modes on purpose.** A full enable replaces it (so entries the build no longer owns vanish); the reduced repo-hooks-only bootstrap unions its single umbrella entry (so a per-session run cannot shrink what a full enable populated).
- **`.claude/skills/` is plugin territory now.** A full `jolli enable` no longer writes there; the only writes into that slot are the plugin bootstrap's bare `/jolli` umbrella and the legacy-copy cleanup, plus the uninstall removal. This is why a fresh install shows a single clean `/jolli` in the Claude `/` menu alongside the plugin's `/jolli:*`, with no duplicated unnamespaced entries.
- **`enable` is no longer the only refresh trigger.** The startup auto-refresh (`autoRefreshSkillsIfStale`) re-runs the same revision-keyed upsert on every CLI invocation, so a CLI-only user who upgrades the global package without re-running `jolli enable` still gets self-healed recipes. The trigger is deliberately narrow: version-guarded (a single marker read on the already-current path, and a `dev`-build no-op), enabled-repo-only (it never creates skills where Jolli isn't already installed), **disable-respecting** (a repository carrying the durable manual-disable opt-out is skipped, and its version marker is left unstamped so the decision is re-read rather than remembered), lifecycle-command-exempt (skips `enable` / `disable` / `uninstall`), and fail-soft (any error is swallowed at debug level and never breaks the command the user ran). It changes only *when* the upsert runs, not the per-skill ownership + revision write decision.

## Shared Behavior

- The "skill is a directory containing `SKILL.md`" layout is dictated by the host skill-discovery contracts, not by the product. The cross-platform Agent Skills standard (`.agents/skills/`) and Claude Code (`.claude/skills/`) share this same directory-per-skill format, which is why one byte-identical document serves the Agent Skills target and the plugin's bare umbrella slot alike.
- The full-`enable` skill write is unconditional and no longer gated on `claudeEnabled` — the sole shipped target (`.agents/skills/`) is always written. Skills for Claude Code specifically are supplied by the Claude Code plugin as namespaced `/jolli:*` (see spec 282), and the only unnamespaced Claude-slot writes are the plugin bootstrap's bare umbrella plus its legacy-copy cleanup, driven by the reduced repo-hooks-only bootstrap (spec 57), not by this installer's per-skill loop.
- The dispatch entry-point pattern used inside skill documents (`"$HOME/.jolli/jollimemory/run-cli" …`) is shared with every other CLI invocation emitted by skills or other prompts. The per-user dispatch entry point and the per-user hook entry point are siblings in the user-global state directory; both consult the same dist-paths registry.
- The "log a warning, do not propagate" failure mode is shared with the Claude `SessionStart` installer (spec 46) — both treat skill/hook installation as a strict enhancement relative to the rest of the install pipeline.
- Worktree-awareness: this installer is invoked once per worktree by the orchestrator (spec 44), so each worktree receives its own independent copy of each registered skill's document.
- Per-skill body content and per-skill frontmatter values are owned by the respective content specs: spec 140 (`jolli-recall`), spec 141 (`jolli-search`), spec 273 (`jolli-local-run`), spec 274 (`jolli-remote-run`), spec 272 (the standalone `jolli` umbrella-menu skill's body), and spec 303 (the plugin-bootstrap companion bare-`jolli` menu's body, the other half of the revision-ordering invariant recorded above). This spec owns only the shared frontmatter fields common to every skill. Spec 211 records the retired PR skill's former body and is historical only — no registry entry corresponds to it; its name appears solely on the retired-name list this spec's sweep consumes.
