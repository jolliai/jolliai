# Per-Source Dist-Path Version Selection

## Topic Statement

The per-user state directory at `~/.jolli/jollimemory/` keeps a small registry of installed product distributions, one file per source (the standalone CLI, each IDE extension, etc.), and at every dispatch the highest-version entry whose distribution directory still exists on disk is selected as the winner that supplies hook and CLI binaries.

## Scope

**In scope:**
- The on-disk layout of the per-source registry under `~/.jolli/jollimemory/dist-paths/`.
- The two-line file format used by each entry.
- How a source tag is derived (whitelist of known IDEs; auto-extraction from a recognizable extension-install path; hash fallback for unrecognized paths; the standalone-CLI tag is fixed).
- The version-comparison rule in full: its two tiers, how each tier is entered, prerelease and build-metadata handling, and the special handling of placeholder versions (`dev`, `unknown`, empty).
- The fact that there are **two** independent selection implementations — the shell dispatch resolver that decides what actually executes, and an in-process selector used for reporting and for one host-configuration writer — the three ways they diverge, and the three (prerelease ordering, build-metadata handling, registry-enumeration order) that both are required to keep aligned.
- The tie-break among sources at an equal winning version: the fixed preference order, the lexicographic-by-tag rule that settles ties no preferred source is part of, and the fact that this only buys determinism and may never carry host semantics.
- The optional required-entry-file argument that gates candidate eligibility in the dispatch resolver.
- The soft source-preference environment override the dispatch resolver consults ahead of the fixed preference order.
- The write-time "keep the existing entry" gate, its ten-file completeness definition, and the fact that it turns on completeness alone — never on a version comparison.
- The **optional explicit distribution directory** a writer may be handed instead of inferring its own location, why it exists, and where it is validated.
- The machine-global lock every registry writer is required to hold, **and the one documented writer that does not hold it**.
- The missing-distribution filter: entries whose recorded directory no longer exists are skipped at selection time, and are additionally pruned (deleted from the registry) by any source's install/enable run.
- The legacy single-file format at `~/.jolli/jollimemory/dist-path` and the one-time migration that converts it to the per-source layout, including the source-tag recovery rule when the legacy file does not name a recognizable source.
- What happens when the registry yields no winner (a non-zero exit and a stderr diagnostic from the resolver script; consumers that expect a zero-status path receive nothing).

**Out of scope:**
- The three dispatch scripts that read this registry (covered by the dispatch-script-generation topic).
- The npm postinstall hook that refreshes a single source's entry (covered by its own topic).
- The first-time enable flow that creates the registry (covered by the enable topic).

## Data Contracts

### Registry directory layout

The registry lives at `~/.jolli/jollimemory/dist-paths/`. It contains zero or more regular files, one per installation source. Each file's name is the source tag (no extension). Examples of valid filenames:

- `cli` — the standalone CLI
- `vscode` — Visual Studio Code extension
- `cursor` — Cursor IDE extension
- `windsurf` — Windsurf IDE extension
- `vscodium` — VSCodium extension
- `positron` — Positron IDE extension
- `trae` — Trae IDE extension
- `antigravity` — Antigravity IDE extension
- `intellij` — IntelliJ-family plugin (per the product's cross-IDE convention)
- An eight-character lowercase hexadecimal hash — for any unrecognized installation path.

### Per-entry file format

Each file is two text lines, both required:

```
<version>
<absolute-path-to-distribution-directory>
```

The first line is the product core version (a numeric semver string in normal cases; prerelease and build-metadata forms are accepted and ordered per the comparison rule below; or one of the placeholder tokens `dev`, `unknown`, or empty for development or unidentified builds). The second line is the absolute path on the local filesystem to the distribution directory that contains the hook entries and the CLI entry. The source tag is **not** repeated inside the file — it is supplied by the filename.

Readers differ slightly on which line they take the distribution directory from: the dispatch resolver reads strictly the second line, while the in-process reader takes the last non-empty line (see **Two selection implementations, and where they diverge**). Writers only ever produce the two-line form, so the difference is observable only on a hand-edited or partially-written entry.

Trailing whitespace and blank trailing lines are tolerated by readers.

### Legacy single-file format

A pre-registry version of the product wrote a single file at `~/.jolli/jollimemory/dist-path` with two lines:

```
source=<tag>@<version>
<absolute-path-to-distribution-directory>
```

Or, in an even older sub-variant, just `source=<tag>` on the first line with no version, in which case the version is treated as `unknown`. This file is migrated once into the per-source layout the first time a current product version runs an install or refresh, and then deleted.

### Resolver output contract

The dispatch script that consumes this registry (the `resolve-dist-path` script under `~/.jolli/jollimemory/`) accepts one optional argument — the bare name of an entry file that must be present inside a candidate distribution for that candidate to be eligible — and outputs a single absolute path on standard output, exiting zero, when a winner is found. When no winner is found it exits with status one and emits a diagnostic on standard error that names the configuration step the user needs to run to repair the registry.

## Behavior

### Source-tag derivation

When a source records itself in the registry, it derives a stable tag from its installation path. The derivation walks a fixed sequence of rules and returns the first that matches:

1. **Whitelist of known IDE markers.** The installation path is checked against an ordered list of substring markers. The first match returns the corresponding canonical tag. The order is significant: more specific markers come before less specific markers (for example a `.vscode-oss/` marker is checked before a `.vscode/` marker so that a VSCodium install is not misidentified as a VS Code install). The current canonical tags exposed by the whitelist are `cursor`, `windsurf`, `antigravity`, `vscodium`, `positron`, `trae`, and `vscode`.
2. **Auto-extracted IDE name.** If no whitelist marker matches, the path is matched against a `~/.<ide-name>/extensions/` pattern, and the IDE name is extracted and lowercased. This rule allows a new IDE to register with a stable tag without a code change to the whitelist.
3. **Hash fallback.** If neither rule matches, the tag is the first eight characters of the hex-encoded SHA-256 of the original path. This guarantees a deterministic tag for any installation path while ensuring that distinct paths from non-standard locations do not collide on the same registry slot.

The standalone-CLI source does not use the path-based derivation. It writes its entry under the fixed tag `cli`.

### Version comparison

One shared comparison rule is used everywhere the product orders two version strings in-process — naming the active runtime for status reporting, deciding whether a registry write should be kept or replaced, and the unrelated published-package freshness check. (The dispatch resolver realizes the same intent in shell, comparing the dotted numeric fields and then the prerelease identifiers itself rather than shelling out to a version-sort utility, and is not identical; see **Two selection implementations, and where they diverge**.)

The rule has **two tiers**, and which tier applies is decided by a purely textual test on the two operands.

**Tier gate.** If either operand contains a hyphen or a plus character, the comparison enters the *semver tier*. Otherwise it uses the *numeric tier*. The gate is a character test on the raw strings, not a structural parse: an operand is routed to the semver tier merely for containing one of those characters, whether or not it is a well-formed version.

**Semver tier.** Each side is normalized independently:

- A fully valid semantic version is kept as-is, with any prerelease and build metadata preserved. A single leading `v` is stripped as part of this normalization.
- Otherwise, a string consisting only of dot-separated decimal integers is coerced to a three-component form: `1` and `1.0` both become `1.0.0`, and a fourth or later component is discarded so `1.2.3.4` becomes `1.2.3`.
- Anything else fails to normalize.

The outcome then depends on how many sides normalized:

- **Both sides normalize** — full semantic-version precedence applies. A prerelease sorts *below* its own release (`1.0.0-rc.1` is older than `1.0.0`) but *above* any lower release (`1.0.0-rc.1` is newer than `0.99.0`). Build metadata is ignored entirely, so `1.0.0+sha.abc` compares **equal** to `1.0.0`.
- **Exactly one side normalizes** — that side wins outright, regardless of magnitude. So a prerelease beats a placeholder (`0.0.1-rc` is newer than `dev`), and a malformed four-component prerelease loses to a plain release (`1.2.3.4-x` is older than `1.0.0`).
- **Neither side normalizes** — the two compare **equal**.

**Numeric tier.** A side is valid in this tier only if it consists of dot-separated decimal integers. Both invalid → equal. Exactly one invalid → the invalid side is the older one. Both valid → component-wise comparison from most significant to least, with missing trailing components treated as implicit zeros (`1.2` equals `1.2.0`) and each component compared numerically rather than lexicographically (`1.10` is newer than `1.9`).

Consequences worth stating explicitly:

- The placeholder tokens `dev`, `unknown`, and the empty string contain neither gate character and are not dotted-numeric, so they land in the numeric tier as invalid operands: they rank strictly below every dotted-numeric version and compare **equal to each other**.
- A leading `v` is handled asymmetrically. `v1.0.0-rc` reaches the semver tier and normalizes to `1.0.0-rc`; a bare `v1.0.0` never reaches that tier and is therefore an invalid numeric-tier operand, ranking below every real version.
- The result is a sign, not a normalized magnitude: in the numeric tier it is the raw arithmetic difference of the first differing component. Every consumer only tests the result against zero, so the magnitude is never observable — but a consumer that assumed a strict `-1` / `0` / `+1` result would be wrong.
- The comparison never raises an error for any pair of inputs.

### Selection at dispatch time

At every dispatch (every git hook fire, every CLI invocation routed through the dispatcher), the resolver script enumerates the registry as follows:

1. Accept an optional **required-entry-file name**. When supplied, it is the bare filename of one entry inside a candidate distribution that must exist for that candidate to be eligible. When omitted, only the candidate directory's existence is checked. This is the resolver's entire notion of "complete": exactly one named file, chosen by the caller — the hook dispatcher passes the specific hook entry it is about to run, and the CLI dispatcher passes the CLI entry.
2. List the regular files under `~/.jolli/jollimemory/dist-paths/`. If that directory does not exist, there are no candidates.
3. For each file, read the version and the distribution directory path.
4. Skip the entry if the version line is empty, if the distribution directory does not currently exist on disk (the **missing-distribution filter**), or if the required entry file is absent from it.
5. Among the surviving entries, pick the one with the highest version, ordered by the platform's version sort (which is close to but not identical to the shared comparison rule above — see the divergence section). The first surviving candidate is accepted unconditionally and a later candidate replaces it only on a **strictly** greater version, so the directory-enumeration order can never decide a tie.
6. If the soft source-preference override is set and names an eligible entry sitting at that same winning version, that entry wins and enumeration stops here (see **Soft source-preference override** below).
7. Otherwise, if any entry in the fixed source-preference order is eligible at the winning version, the earliest such source wins (see **Tie-break preference among sources at the same version** below).
8. Print the winner's distribution directory and exit zero.

If no entry survives, exit one and write a diagnostic to standard error.

The selection is performed at every dispatch. There is no caching across dispatches and no install-time selection.

Because eligibility is re-evaluated per dispatch against a caller-supplied required entry file, one dispatch can legitimately resolve to a different distribution than another: a distribution that is missing a single hook entry loses only the dispatches that need that entry.

### Two selection implementations, and where they diverge

There are **two** independent implementations of the selection above, not one:

- The **dispatch resolver** — the shell script consulted on every hook fire and every dispatched CLI invocation. It is authoritative for what actually executes.
- The **in-process selector** — used by the product's own health/status reporting (to name the active runtime, its version, and every registered source) and by the host-configuration writer that must bake an absolute path to the CLI entry into a machine-local MCP registration on Windows.

The two express the same intent but are not equivalent, and three divergences are observable:

1. **Completeness.** The dispatch resolver rejects a candidate that lacks the caller's required entry file. The in-process selector applies **no** completeness check at all — a candidate qualifies as soon as its recorded directory exists. Status output, and the absolute CLI path baked into a Windows host registration, can therefore name a distribution the dispatch resolver would refuse to use.
2. **Placeholder ordering.** The dispatch resolver folds the placeholder tokens `dev` and `unknown` **to** `0.0.0`, so a literal `0.0.0` registration *ties* with a development build. The in-process rule ranks placeholders strictly *below* `0.0.0`.
3. **Tie matching in the preference override, and entry parsing.** The dispatch resolver's *selection* pass now applies the full comparison, so `0.99` and `0.99.0` rank equal there exactly as they do in-process. Its two **preference** passes — the environment override and the fixed preference order — still decide "same version" by raw string equality, so a preferred source registered as `0.99` does not override a leading `0.99.0`, and the winner falls out of enumeration order instead. The dispatch resolver also reads the distribution directory strictly from the entry's second line, whereas the in-process reader takes the last non-empty line and additionally still understands the legacy `source=<tag>@<version>` first-line form inside a per-source entry file.

The dispatch resolver decides what runs; the in-process selector only reports and, on Windows, records. A divergence therefore surfaces as a status report or a recorded configuration path that disagrees with the distribution a hook actually executed from.

**Prerelease ordering** is a divergence held closed on the resolver's side, and the requirement is that it stays closed in both directions. Both implementations rank a prerelease below its own release, and both order two prereleases of the same release by their dot-separated identifiers — numerically when both identifiers are numeric, by byte order otherwise, with a longer identifier list winning when every shared identifier is equal. Comparing only the numeric fields, and treating everything after the hyphen as decoration, is the shape to avoid: two prereleases then compare *equal* in both directions, and because an equal version never displaces the incumbent, the winner falls out of registry-enumeration order instead of the version — silently routing every hook on the machine to the older of the two.

**Build-metadata handling** is held closed for the same reason and fails the same way. Both implementations ignore build metadata entirely when ordering two versions, as the version grammar requires: it is stripped before anything else, ahead of the prerelease tail it follows. The shape to avoid is letting it survive into the numeric fields — a version's last numeric field then absorbs the metadata's own digits, so a build of one release ranks above that release and level with the next one, and the equal case again hands the decision to registry-enumeration order.

A further divergence — **registry-enumeration order** — is deliberately held closed rather than tolerated, and the requirement is on the in-process side. The dispatch resolver enumerates by expanding a filename pattern, which the shell collation-sorts for it; the in-process selector reads the directory, whose natural order is the filesystem's and therefore neither sorted nor stable across machines. It must sort by source tag to match. This only becomes observable at the last tie-break step — the one that takes the first tied entry in enumeration order — so for a long time it was latent, reachable only between two sources that are both outside the fixed preference order. Adding a second AI-host plugin makes exactly that pairing ordinary, which is why the sort is now stated as part of the contract: without it the resolver and the selector can disagree about the winner while both remain internally consistent, and the resulting mismatch looks precisely like a stale registry.

### Soft source-preference override

An environment variable naming a single source tag acts as a **soft** preference consulted by the dispatch resolver only:

- It is consulted only *after* a winning version has already been established, and only if some entry won at all. If the registry produced no winner, the override is never read.
- It wins only when the named entry exists as a regular registry file, its recorded directory exists, it satisfies the required-entry-file check, **and** its version string is exactly equal to the already-won winning version. The version match is raw string equality, so `0.99` does not match a winner recorded as `0.99.0`.
- When it wins, it short-circuits **ahead of** the fixed source-preference order.
- It can never beat a strictly higher version, and it never fails hard: a missing entry, a vanished directory, an incomplete distribution, or a version below the winner all fall through silently to the fixed preference order.
- It has **no in-process counterpart** — the in-process selector does not read the environment at all.
- **No shipped surface sets it.** The mechanism is live in the generated resolver and honored when a user or an external tool sets it by hand, but no install surface, hook body, skill recipe, or command recipe the product writes ever sets it. An earlier design had one surface soft-prefer its own bundle this way; that was deliberately removed so that all surfaces compete purely on version and then on the fixed preference order.

### Missing-distribution filter

An entry whose recorded distribution directory no longer exists (for example because the corresponding IDE extension was uninstalled, or the standalone CLI was upgraded in place to a different absolute path) is skipped at selection time. The resolver script itself never deletes such an entry — it only filters it out of the candidate set for that one dispatch, so a ghost entry survives across dispatches and would become a candidate again if the directory reappeared.

The registry is **not** left to self-heal on its own, however: every install/enable run actively deletes each entry whose directory is missing (see "Active pruning of missing entries" below). A ghost therefore does not survive the next install or enable by any source. It only becomes a candidate again if its directory reappears before an install/enable sweep removes it.

### Active pruning of missing entries

Every install/enable run — for ANY source (the standalone CLI, any IDE extension, the IntelliJ plugin) — performs a pruning sweep immediately after writing its own live entry:

1. Enumerate every registry entry.
2. For each entry whose recorded distribution directory does not currently exist on disk, delete the entry file.
3. An entry whose directory exists is never touched.

The sweep runs **after** the caller writes its own (live) entry, so it never prunes the caller. It is best-effort: a per-entry deletion failure is logged and skipped (a surviving ghost is harmless because selection-time filtering still excludes it), and the failure does not abort the install.

The motivation is not dispatch selection, which already tolerates ghosts. A ghost that won selection when a host's MCP configuration was last written can leave a now-dead absolute path baked into that configuration once the ghost's directory is removed, and nothing re-resolves it while the ghost still outranks the live sources on disk. Sweeping ghosts on every install/enable keeps both selection and the next re-registration pointed at live distributions, and keeps status output free of phantom rows.

### Writing an entry: the keep-existing gate

A source registering itself does **not** unconditionally overwrite its own entry. The write applies a third, stricter notion of completeness and can deliberately decline to record what the caller asked for:

1. The source tag is validated first (lowercase alphanumerics and hyphens, starting with an alphanumeric). An invalid tag is refused outright and nothing is written.
2. The candidate content is assembled: the caller's version (defaulting to the placeholder `dev` when the build carries no version) on the first line, and the distribution directory on the second — **either the one the caller supplied explicitly, or, when none was supplied, the directory of the bundle that is executing the write** (see below).
3. If no entry exists for that source tag yet, the candidate is written.
4. Otherwise the existing entry is read and classified as **complete** or not. An entry is complete when it has both lines *and* its recorded directory holds the full runtime entry set (see below).
5. **Keep gate.** If the existing entry is complete AND the candidate's own directory is *not* complete, the existing entry is left untouched and the write reports success. Completeness is the gate's only input: the two recorded versions are never compared, so a candidate that is itself complete always wins the slot regardless of whether it is newer, older, or identical in version.
6. Otherwise the candidate is written — but only if its content actually differs from what is already there. Identical content produces no write at all.

A filesystem failure at the write step is a warning and a failure return, not a thrown error.

**Runtime-entry-set completeness.** For this gate, a distribution directory is complete only when it contains *all ten* runtime entries: the CLI entry, the two agent-hook entries (session-stop and session-start), the five git-hook entries (post-commit, post-rewrite, prepare-commit-msg, post-merge, pre-push), and the two detached worker entries (the git-operation queue worker and the pre-push sync worker). A directory missing any one of them is incomplete. This is deliberately much stricter than the dispatch resolver's single-required-file check, because a write is a durable claim about a distribution while a dispatch is a single decision about one entry.

**Consequences of the keep gate:**

- A **same-version re-registration pointing at a different directory moves the entry.** The registry is keyed by source tag alone and never by directory, so every build of one source competes for a single slot; re-registering is treated as an explicit claim on it. This is what makes a rebuild at a new path — a second checkout of the same version, or a global reinstall to a different location — take effect without a version bump.
- A **downgrade is recorded** whenever the incoming distribution is complete. Deliberately installing an older build is an intentional act, and the registry does not second-guess it.
- An **incomplete candidate can never displace a complete existing entry**, even at a strictly higher version. A half-built or partially-extracted distribution cannot take over the slot. This is the gate's entire purpose.
- Because the gate ignores versions, an entry's recorded version is **descriptive, not a claim to the slot**. It still decides cross-source selection at dispatch time; it has no bearing on which distribution a source records for itself.
- Because a same-content write is skipped entirely, a repeated install is not merely idempotent in outcome — it performs no filesystem write at all.

### The recorded directory: inferred by default, injectable by request

By default the writer records **the directory of the bundle that is executing it**. That is correct exactly when the process running the install *is* the distribution being registered — true for the standalone command-line invocation and for the editor extension's in-process call.

It is **not** true for a long-lived server installing on another distribution's behalf. The JVM IDE surface's server is launched preferentially from its own installation tree inside the IDE, which is version-scoped: it disappears on a plugin uninstall and moves on an IDE major upgrade. The distribution that surface actually wants registered is the stable per-user copy it extracts. Getting this wrong is invisible — the shared hook dispatcher exits silently by design so it never blocks source control, so the symptom is capture quietly stopping rather than an error.

The writer therefore accepts an explicit distribution directory, and the surface that needs it sets it centrally so neither of its call sites can forget. Two other pieces of the same call accept an explicit override for related reasons: the recorded version, and the registry root itself (used by the package-manager refresh and by scoped operations).

The receiving end of the cross-process request **validates the injected directory rather than passing it through**: it must be absolute and it must exist, both rejected loudly. A relative path would resolve against whatever working directory a hook happened to run in, and a non-existent one would register a dead entry that fails silently on the blocking source-control path. This is the same reasoning that re-validates the source tag at its own write boundary.

The legacy single-file migration also supplies both an explicit directory and an explicit version — the ones recovered from the legacy file — rather than inferring either.

### The machine-global registry lock

Every writer of this registry — the install/enable path on any surface, and the package-manager post-install refresh — is required to perform its registry work while holding a single machine-global lock kept alongside the registry in the per-user state directory. The lock covers the whole cluster of work that must be consistent together: rewriting the dispatch scripts, running the legacy migration, writing the caller's own entry, and pruning missing entries.

The lock is **strict**: a caller that cannot acquire it within its wait budget does not do the work unlocked. The install path treats a failed acquisition as a hard failure of the whole install ("the shared runtime registry could not be reconciled, so hooks that depend on it cannot be installed"), while the package-manager post-install refresh treats it as a silent, complete skip.

The read-modify-write inside the entry writer itself carries no internal lock — it relies entirely on its callers holding the machine-global lock. A future writer that skips the lock would reintroduce a lost-update window between reading the existing entry and writing the replacement.

Individual entry writes are atomic: content is written to a sibling temporary file and renamed into place, with a direct-overwrite fallback on platforms where the rename is refused. A crash mid-write therefore cannot leave a torn half-entry that readers would reject.

### The one writer that holds no lock and applies no keep-existing gate

A second writer exists and it is **not** the writer described above. The repository's own IDE-sandbox launcher — a developer-facing script run by hand to rebuild the product and start a sandboxed IDE — writes registry entries directly, with its own two-line writer.

What it does, on **every** launch:

- Writes **two** entries: the standalone-command-line tag pointed at this checkout's freshly built distribution, and the JVM-IDE tag pointed at the per-user copy it has just synchronised. Both carry the version read from the checkout's own package metadata.
- **Takes no machine-global lock.** The reasoning recorded in place is that this is a developer-only, interactively-invoked entry point that never fires from hooks, continuous integration, package-manager post-install, or any autonomous flow — and that its write is a **pure overwrite** rather than a read-modify-write, so the only surviving race is last-writer-wins between two developer-initiated writes.
- **Bypasses the keep-existing gate entirely.** It reads no existing entry and makes no keep-or-overwrite decision: the stated contract is that the current checkout's build is the source of truth for this launch, always.
- **Does not snapshot or restore anything on exit**, and registers no exit handler at all.
- Still writes each entry atomically, temporary-file-then-rename, with a dot-prefixed temporary name so a crash between write and rename leaves a hidden file the shell resolver's expansion skips. It falls back to a direct overwrite on the permission errors that platform can raise.

It does apply a completeness check, but not *this* registry's: it carries a **hand-mirrored copy** of the ten-entry runtime set and asserts both candidate directories against it, aborting the whole launch when either is short. The copy is documented in place as manually kept in step, so a growth of the canonical list that is not mirrored lets this script certify a distribution the sanctioned writer would refuse.

**The scope of the effect is machine-global and permanent, and that is deliberate rather than an oversight.** The registry is one shared per-user directory that every hook fire, every dispatched invocation, and every server launch on the machine resolves through. After one sandbox launch, an existing standalone-command-line registration is destroyed in place and **every repository on the machine dispatches through this checkout's build** — because the two would otherwise tie at equal versions and the fixed preference order hands the tie to the standalone tag. The only mitigation is a log line naming what the entry pointed at before the overwrite. Recovery is manual: re-install the standalone package from its own checkout, or let some other writer register a higher version.

The reasoning is recorded in place, including the instruction not to restore, not to lock, and not to narrow the write to the IDE tag alone — and the acknowledgement that a future non-interactive caller would invalidate the whole analysis.

### One-time migration from legacy single-file format

The first time a current product version runs an install or refresh (including the npm postinstall path), it performs a single migration step before any new entry is written:

1. Read the legacy file at `~/.jolli/jollimemory/dist-path` if it exists.
2. Parse its first line as `source=<tag>@<version>` (or `source=<tag>`, in which case version is `unknown`) and its last line as the distribution directory path.
3. Determine the per-source target tag:
   - If the legacy tag is `cli`, the target tag is `cli`.
   - Otherwise (notably for the legacy tag `vscode-extension`), re-derive the tag from the recorded distribution directory using the same source-tag derivation rules. If that derivation lands on the hash-fallback branch (no recognizable IDE marker, no extractable IDE name) the target tag is forced to `vscode`, since the legacy `vscode-extension` tag overwhelmingly originated from VS Code installations.
4. Write the migrated entry to `~/.jolli/jollimemory/dist-paths/<target-tag>` in the new two-line format. This write goes through the same keep-existing gate as any other write, so a migration whose recovered directory is not complete leaves an already-recorded complete entry for that tag alone.
5. Delete the legacy file, swallowing any failure.

The migration is idempotent: if it is run again after the legacy file is gone, it is a no-op. If a future rollback to a pre-registry product version reinstalls, that version's installer will recreate the legacy file and overwrite the dispatch scripts back to their old form, so the legacy format re-emerges naturally without the current product needing to retain dual-read code.

### What happens when no entry resolves

If the migration runs and no current source has yet registered itself, or if every registered source's distribution directory has been deleted, the resolver script exits with status one. Its diagnostic on standard error names the recovery action (`run 'jolli enable' to fix`). Downstream consumers of the resolver behave per their own contracts:

- The hook-dispatcher script exits silently with status zero (hooks must not block git or the agent).
- The CLI-dispatcher script exits with status one (CLI callers expect real exit codes).

The resolver itself is the only place that returns the failure status; consumers translate it into their respective policies.

### No fallback to the legacy single file at dispatch time

The current resolver does **not** fall back to reading the legacy single-file `~/.jolli/jollimemory/dist-path` when no entry under `dist-paths/` resolves. The migration path guarantees that whenever the current dispatch scripts are present on disk, the legacy file has either been migrated and deleted or never existed in the first place. A legacy-fallback tier in the resolver would therefore be unreachable code. Rollback to a pre-registry version remains safe because that older version's installer rewrites the dispatch scripts back to their pre-registry shape.

## State Transitions

The lifecycle of a single registry entry under `~/.jolli/jollimemory/dist-paths/<source>`:

- **Absent** → **Present, available** (a source's installer or refresh wrote the entry; the recorded distribution directory exists on disk).
- **Present, available** → **Present, missing** (the distribution directory was deleted without the entry being deleted; the entry is now a stale slot the resolver skips at selection time).
- **Present, missing** → **Present, available** (the distribution directory reappeared before any install/enable sweep removed the entry, e.g. because the same source reinstalled the same version).
- **Present, available** → **Present, available, different version** (an upgrade rewrote the entry — or a *downgrade* did, since the gate compares no versions; either way the incoming distribution only has to be complete).
- **Present, available, stale path** → **Present, available, new path** (the same source re-registered from a different distribution directory; the entry moves even when the recorded version is unchanged and the old directory is still complete).
- **Present, available** → **unchanged** (a candidate at a strictly higher version was offered, but its distribution directory is missing one or more of the ten runtime entries, so it cannot displace the complete recorded entry).
- **Present, missing** → **Absent** (any source's install/enable run prunes the entry because its recorded directory no longer exists on disk — this is a normal flow that auto-deletes missing entries; the pruning source writes its own live entry first, so it never prunes itself).
- **Present** → **Absent** (the registry was wiped, or the user manually deleted the file). An **available** entry (directory present) is never auto-deleted; only missing entries are pruned.

The registry as a whole transitions through:

- **Empty** (no files under `dist-paths/`, or the directory itself is absent) — the resolver exits one.
- **Populated, no available entries** (every entry's distribution directory is missing) — the resolver exits one.
- **Populated, at least one available entry** — the resolver picks the highest-version available entry.

The legacy single-file format transitions through:

- **Present** (pre-migration) → **Absent** (post-migration); the migration step deletes it.

## Notable Behavior

### "Every writer holds the lock" is no longer universal

The requirement that every registry writer hold the machine-global lock, and that every write pass the keep-existing completeness gate, holds for the sanctioned writer and every path that reaches it. It does **not** hold for the repository's IDE-sandbox launcher, which writes two entries directly on every launch with no lock, no keep-existing gate, and no restore.

Three things about that exception are worth stating plainly, because the reasoning recorded beside it is framed in terms of the sandbox:

- **The write is machine-global, not sandbox-scoped.** There is one registry per user; there is no sandboxed copy of it. The launcher's effect is on every repository on the machine, not on the sandboxed IDE.
- **It is permanent.** Nothing reverts it when the sandbox exits, by explicit design, so the machine keeps dispatching through a developer checkout indefinitely.
- **Overwriting the standalone-command-line slot is the point, not a side effect.** The launcher writes that slot precisely because it would otherwise lose the equal-version tie-break to an installed standalone package.

The lock's absence is defended on the grounds that the write makes no decision, so the residual race is only "which value lands last" between two developer-initiated writes; the keep-existing gate's absence is defended on the grounds that the current build must always win. Both defences are about *this* writer's own correctness, and neither weakens the requirement on any other writer.

### Per-source independence

Each source is responsible for its own entry and only its own entry. There is no central index, no atomic multi-source update, and no coordination protocol between sources. A new source is added simply by writing its file. A source upgrade just rewrites that one file. The registry's correctness rests on the per-dispatch enumeration, not on cross-source bookkeeping.

### The version recorded is the product core version, not the IDE extension version

Every source bundles the same product core. Each source therefore records the core's version, not the source's own release version. This is what makes cross-source comparison meaningful: a `cursor@1.4.0` entry and a `vscode@1.4.0` entry are at the same product version even if the underlying IDE extensions were released separately. A user with multiple IDEs installed will have multiple entries at potentially different versions; the highest one wins.

### Prerelease and build-metadata versions are ordered, not treated as placeholders

A version carrying a prerelease or build tag is **not** demoted to placeholder status. The presence of a hyphen or plus character is precisely what routes the comparison into its semantic-version tier, so `1.4.0-beta` ranks above `dev`, above `0.99.0`, and below `1.4.0`; and `1.4.0+sha.abc` compares **equal** to `1.4.0`, since build metadata is ignored. A source publishing prereleases therefore ranks where semantic-version precedence says it should.

The one place this diverges is the dispatch resolver, whose platform version-sort ranks a prerelease *above* its release rather than below (see **Two selection implementations, and where they diverge**). A source that ships a prerelease alongside a released peer at the same base version will therefore win the dispatch but be reported as the older of the two by status output.

### `dev` and `unknown` rank lowest

Local development builds (where the version string is `dev`) and builds where the version could not be determined (where the version string is `unknown` or empty) are valid registry entries — they are not rejected — but they lose to essentially every real version. This means a developer who has a local checkout running alongside an installed release will see the release win at dispatch time, which is usually the desired behavior. A developer who wants their local build to win must temporarily delete the release's entry.

The one edge is the dispatch resolver's fold of `dev` and `unknown` **to** `0.0.0`: against a literal `0.0.0` registration they tie there rather than lose, and the tie is then settled by the source-preference order. The in-process rule has no such edge — placeholders sit strictly below `0.0.0`.

### Source-tag whitelist precedence

Because the whitelist is checked before the auto-extraction rule, an IDE that ships its extensions under a directory whose name happens to match the whitelist marker will collapse onto the canonical tag. This is intentional: it keeps tags stable across IDE-version dot-releases that change directory naming conventions. A new IDE that wants explicit recognition is added by extending the whitelist; an unknown IDE still gets a usable tag via the auto-extraction rule.

### Hash fallback collisions are extremely unlikely but not impossible

Two distinct installation paths whose first eight hex characters of SHA-256 collide would land on the same registry slot. The eight-character truncation gives a 32-bit space, so a collision is rare but theoretically possible. In practice the same path produces the same tag deterministically, so a single-source-multi-install scenario is the only way to encounter the collision, and it would manifest as one source overwriting the other's entry.

### The migration's `vscode-extension` heuristic is a one-shot heuristic

The legacy `vscode-extension` tag was used by a pre-registry version to mean "any VS Code-derivative IDE". Because the registry needs a more specific tag, the migration re-derives from the recorded distribution directory. The heuristic — fall back to `vscode` if derivation hashes — is a one-time best guess; it is not used outside of migration. After migration, every source records its own tag directly via the path-based derivation rule.

### The registry is intentionally human-readable

Each entry is two lines of plain text. A user investigating dispatch issues can list the directory, open any file, and immediately see which version each source has registered and where its distribution lives. This is a deliberate design choice: the dispatch indirection is rare enough in user-facing terms that a one-shot diagnostic via standard tooling (`ls`, `cat`) is more valuable than a binary or structured format.

### The version-comparison helper has consumers beyond dispatch

The same version-comparison rule used to pick the winning registry entry is also reused outside the dispatch path: the plugin update-check layer compares the running CLI version (and each installed plugin's installed version) against the npm-registry `latest` using the same comparison, so that placeholder versions (`dev`, `unknown`, empty), plain numeric versions, and prerelease/build-metadata versions are ordered consistently across both surfaces. See **Plugin Update Check** for that consumer. Because that consumer, like every other, only tests the comparison against zero, the raw-difference result described above is never observable there either.

### The recorded directory is no longer necessarily the writer's own location

The default — record the directory of the bundle performing the write — is an inference, and it is right only while the process running the install *is* the distribution being registered. A long-lived server installing on another distribution's behalf breaks that, so the directory is injectable, and the surface that needs it injects it at a single choke point rather than at each call site. The failure the injection prevents is invisible by construction: the shared hook dispatcher exits silently so it never blocks source control, so a registry entry pointing at a directory the IDE has since discarded presents as capture quietly stopping, not as an error. The injected value is validated for absoluteness and existence at the process boundary rather than trusted.

### Tie-break preference among sources at the same version

When two or more available entries are tied at the highest version, a fixed source-preference order decides: the standalone CLI (`cli`) wins first, then the canonical VS Code source (`vscode`), then `cursor`. The bundled product core is byte-for-byte identical at equal versions, so the tie-break only makes the winner deterministic; it does not change which behaviors are available. The standalone-CLI tag (`cli`) is the preferred winner whenever it is present and tied at the top, which gives the canonical CLI build precedence over any IDE-embedded copy of the same version.

When **no** tied source appears in that order at all, the winner is the first tied entry in registry-enumeration order, and that order is defined to be **ascending lexicographic by source tag**. Both implementations must enumerate the registry that way; neither may fall back to whatever order the filesystem reports, because the two would then be free to pick different winners for the same registry (see **Two selection implementations, and where they diverge**).

Two consequences are worth stating explicitly:

- This last step is the *operative* rule for the AI-host plugin sources, not a rare edge. Plugin tags are deliberately absent from the fixed preference order, and two plugin bundles carrying the same product version is the normal state for a user who installs more than one host, so lexicographic order is what actually settles those ties.
- It is a **stability** rule, not host isolation. It guarantees only that the choice does not flip between runs; it says nothing about which host's bundle *ought* to win. No behavior may be made conditional on which bundle wins a tie — at equal versions the cores are identical, and a rule that merely orders tags cannot be load-bearing for host semantics.

The order is a **single declared list enforced in two places**: the in-process selector iterates it directly, and the dispatch resolver's tie-break loop is generated from the very same list when the resolver script is written, so the two can never drift apart in content (only in matching semantics — the resolver compares version strings literally, the in-process selector compares them by the full rule).

Sources absent from the order are not second-class in general — they still win outright on a strictly higher version — but they can never win a *tie* against a listed source that is eligible at the top version. The embedded plugin surface (`claude-plugin`) is deliberately **not** in the order for exactly this reason: it competes purely on version, expresses no preference of its own, and loses a same-version tie to `cli`, `vscode`, or `cursor`. It wins a tie only when none of those three is present-and-eligible at the winning version, in which case whichever entry the enumeration accepted first simply stands.

## Shared Behavior

- **Per-user state directory at `~/.jolli/jollimemory/`** — the parent of `dist-paths/` and the location of the legacy single-file format.
- **Dispatch script generation** — the writer of the resolver and dispatcher scripts that read this registry; covered by its own topic.
- **Npm postinstall dist-path refresh** — one of the triggers that writes a per-source entry (specifically the `cli` entry); covered by its own topic.
- **First-time enable flow** — another trigger that initializes the registry and writes the dispatch scripts.
- **IDE extension activation** — for each IDE source, the activation path writes that source's per-source entry on every activation, refreshing both the version and the recorded distribution directory.
- **Lock primitive registry** — the machine-global lock that every registry writer must hold is one of the product's declared locks; its location, wait budget, and strict-failure semantics are catalogued there, along with the record that this registry has one sanctioned unlocked writer.
- **The repository's IDE-sandbox launcher** — a developer-facing script, not a shipped surface, and the only writer of this registry that holds no lock, applies no keep-existing gate, and restores nothing. Its effect is machine-global and permanent; its full behaviour is described above rather than in a topic of its own, because nothing else consumes it.
- **Doctor and uninstall commands** — operations that may inspect, repair, or remove registry entries.
- **Plugin Update Check** — independently reuses this spec's version-comparison helper to decide whether the running CLI or an installed plugin trails the npm registry's `latest`.
