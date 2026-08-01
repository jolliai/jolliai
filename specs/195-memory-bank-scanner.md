# 195. Memory Bank User-Knowledge Scanner

## Topic Statement

Surface user-authored Markdown files in a per-repository memory mirror by enumerating fixed-depth directories, filtering out every entry recognized as system-emitted, then classifying each survivor by its directory depth as global, repository, or branch.

## Scope

**In scope:**

- The set of entry points exposed for "scan with a known branch" and "scan every branch present on disk", and their cwd-resolving siblings.
- Resolution of the memory-mirror root from the caller's bound working directory: when present, the configured user-pickable parent folder; the host repository's name; the host repository's remote-origin URL.
- The write-boundary consultation that precedes root resolution, its unconditional application, and what the scanner returns when it refuses — but not the predicate itself.
- Handling of a refused, absent, or unresolvable memory-mirror root.
- The three scoped directories searched, in the order they are searched, and the depth limit applied to each (top-level entries only — no recursion).
- The exclusion rules used to drop system-generated entries: a registry-driven exclusion, a hash-suffix-named-file exclusion, and a prefix-named-file exclusion.
- The degraded-mode behavior used when the per-repository file registry cannot be read or parsed.
- The branch-folder resolution rule used when a known branch is supplied: a registry-driven mapping with a deterministic transcoding fallback.
- The branch-folder reverse-resolution rule used when "scan every branch on disk" is invoked: registry-driven label, falling back to the folder's basename.
- The fixed set of subdirectory names reserved by the system and skipped during the "scan every branch on disk" sweep.
- Per-entry filtering: dot-suffix gate, file-vs-directory gate, registry-membership check (per scope), and content-read gate.
- The per-result record shape: relative path, absolute path, scope, optional branch label, content fingerprint, content body, modification timestamp.
- The fingerprint algorithm and its load-bearing equality with the per-repository file registry's fingerprint.
- The modification-timestamp's promoted role as the chronological ordering key for downstream timeline consumers.
- Silent skip and warn-then-skip behavior under per-file errors and per-directory errors.

**Boundaries (out of scope):**

- The on-disk layout of the user-pickable parent folder, the per-repository subdirectories, the hidden machine-readable layer, and the visible per-branch layer (defined by the memory-bank folder layout spec).
- The shape and mutation semantics of the per-repository file registry, the per-repository branch-mapping registry, and the per-repository configuration document (defined by the folder-based summary storage spec and the memory-bank folder layout spec).
- The naming rules for the system-generated visible files this scanner excludes — specifically the `-<8-hex>.md` suffix shape and the `plan--` / `note--` / `topic--` prefix shape (defined by the folder-based summary storage spec); this scanner only describes the recognition patterns it applies.
- The validation and selection of the user-pickable parent folder itself (defined by the memory-bank folder layout spec).
- The write boundary this scanner consults before resolving its root: the conditions under which a working directory is refused, the vocabulary of refusal reasons, their evaluation order, and the separately-reported effective Memory Bank state derived from the same predicate (defined by the memory-bank write-boundary and effective-state-reporting spec). This spec states only where the consultation sits, that it is unconditional, and what the scanner returns on a refusal.
- The three-layer fallback used to compute the host repository's basename (defined by the memory-bank folder layout spec).
- The deterministic transcoding rule applied to a branch name when no registry mapping exists, and the reverse folder-to-branch lookup (defined by the folder-based summary storage spec); this scanner consumes both as primitives.
- The downstream ingestion pipeline that consumes the scanner's output, including how user files are merged into the topic-page timeline, how their fingerprint is used for cache invalidation, and how their modification timestamp is folded into the source-of-truth ordering (defined by the topic ingest pipeline and source timeline specs).
- Multi-repository sweeps that invoke this scanner once per discovered repository (defined by the multi-repo compile sweep spec).
- The UI surfaces that visualize the per-repository folder, including the per-repository folder browser and the divergence decoration (defined by their respective specs).
- The wiki layer's regenerable nature, which the scanner relies on only insofar as it skips the wiki layer's reserved directory name (defined by the memory-bank folder layout spec).
- The sync engine's allowlist classifier, which classifies files for upload separately from this scanner's classification for ingest (defined by the sync engine spec).

## Data Contracts

### Inputs

The "scan with a known branch" entry point accepts:
- A bound working-directory path of a host repository.
- An optional branch name string.

The "scan every branch on disk" entry point accepts:
- A bound working-directory path of a host repository.

A pair of explicit-root sibling entry points accept the absolute memory-mirror root directly, plus (for the known-branch variant) an optional branch name. These are used by callers that do not have a host repository at the supplied working directory (e.g. multi-repository sweeps).

### Memory-mirror root resolution

Given a bound working-directory path, the scanner resolves a per-repository memory-mirror root in two stages.

**Stage 1 — the write boundary.** Having read the configured parent folder, the scanner consults the Memory Bank write boundary for the bound working directory *before* deriving anything else. On a refusal it yields **"no root"**: it emits a single debug-level log line naming the working directory, emits **no warning**, and creates nothing on disk. The predicate and its refusal reasons are defined by the memory-bank write-boundary spec (see Boundaries).

This stage exists because stage 2 does not merely *look up* the root — it **claims** it, creating the directory and writing the repository's identity. Ungated, a scan started from a working directory that is not a real project therefore *created* the root it then found empty, and reported "no user knowledge" about a mirror it had just brought into existence. The gate makes the scan's read-only intent true in fact.

The boundary is consulted **unconditionally**: the scanner never reads the storage-mode configuration, so the gate applies identically whether or not the user has a folder layer configured at all.

**Stage 2 — resolution.** The scanner combines three inputs (see Boundaries above for who owns each input's derivation):
- A configured user-pickable parent folder, if any (else a fallback determined by the parent-folder layout spec).
- The host repository's name.
- The host repository's remote-origin URL, if any.

The result is an absolute path naming a single per-repository subdirectory beneath the parent folder, ordinarily claimed on return. When any input resolution throws, the scanner returns an empty result without warning (treated as "no memory mirror configured here").

When the root does not exist on disk, the scanner returns an empty result with a debug-level log entry. (This is the normal "fresh install" / "reconfigured root not yet created" path for the explicit-root entry points, which accept a root nobody has claimed.)

### Per-repository file registry

A per-repository document (under the resolved root's hidden machine-readable layer) records every file the system has emitted into the visible or wiki layer. The scanner reads it solely to extract the set of repository-root-relative paths it carries. The document's full shape is defined elsewhere; the scanner consumes only `files[].path`.

A missing, empty, or malformed registry degrades the scanner to a secondary-rule-only identification mode, with a warning. "Malformed" here covers any condition where the path-set extraction throws (e.g. the document parses to an object that does not carry the expected `files` array).

### Per-repository branch-mapping registry

A per-repository document records branch-name → on-disk-folder-name mappings. The scanner consumes two operations on it:
- `mapping for branch B` — used in the known-branch variant. Returns the registered folder; falls back to the deterministic transcoding of `B` when no mapping exists. Failures (missing or unparseable document) silently fall through to the transcoding fallback.
- `branch label for folder F` — used in the "scan every branch on disk" variant. Returns the registered branch; falls back to the folder name itself when no mapping exists.

### System-generated naming patterns

Two filename patterns recognize system-emitted files at scan time:

- **Hash-suffix pattern** — basenames ending in `-<exactly 8 lowercase hexadecimal characters>.md`. This matches the visible layer's per-summary filename shape **and**, without any change to the pattern, its per-commit skill-usage aggregate `skills--<hash8>.md`.
- **Prefix pattern** — basenames beginning with `plan--`, `note--`, or `topic--`. This matches the visible layer's per-plan, per-note, and topic-page filename shapes.

Both patterns are exclusion-only: a file matching **either** is treated as system-generated. The two patterns together cover the union of system-emitted visible filenames; neither alone is sufficient (a `plan--<slug>.md` filename carries no hex suffix; a hand-written user file named `summary.md` and recorded in the registry carries no recognizable suffix or prefix).

**No pattern was added for the skill aggregate, and that is worth stating explicitly.** It is excluded by *both* existing gates independently: it is registered in the per-repository file registry (under a namespaced identifier, but at its real path), so the registry-membership gate catches it in normal operation; and its `--<8-hex>.md` tail satisfies the hash-suffix pattern, so the generated-name gate catches it in degraded mode. The consequence is a coupling that is easy to miss: renaming the aggregate away from that tail — to `skills.md`, or to a `skills--<slug>` form — would leave the primary gate intact but silently break the secondary one, so on any repository whose registry is missing or unparseable the table would surface as user-authored knowledge and be folded into derived topic pages. A rename would need a matching prefix entry (`skills--` alongside `plan--` / `note--` / `topic--`).

### System-reserved subdirectories

Two subdirectory names are reserved at the memory-mirror root level and are never scanned as branch folders during the "scan every branch on disk" sweep:
- The hidden machine-readable layer's dot-prefixed name.
- The wiki layer's name.

### Output record shape

Each surviving file emits one record with the following fields:

| Field | Meaning |
| --- | --- |
| relative path | The file's path relative to the user-pickable parent folder (one level above the memory-mirror root), expressed with forward-slash separators irrespective of host OS. |
| absolute path | The file's absolute on-disk path. |
| scope | One of three discriminators: a global-scope discriminator, a repository-scope discriminator, or a branch-scope discriminator. |
| branch | Present only when scope is the branch-scope discriminator. The branch label this file belongs to (resolved per the rules below). Omitted for the other two scopes. |
| fingerprint | The content fingerprint, computed with the same cryptographic-strength content-hash algorithm used to populate the per-repository file registry's fingerprint column. Hex-encoded. |
| content | The file's full UTF-8 text content. |
| modification timestamp | The file's last-modified time, formatted as an ISO-8601 string. |

The output is a list; the scanner does not deduplicate across scopes (a file under the branch directory is reported once, under the branch scope; a file at the per-repository root is reported once, under the repository scope; the three scope-directory sets do not overlap by construction). Order within the list follows the directory-iteration order returned by the host OS — no sort step is applied.

The relative path field's anchor — one level **above** the memory-mirror root, i.e. the user-pickable parent folder — is deliberate: a downstream consumer reading the relative path can tell from the leading segment whether the file is parent-wide (`<basename>.md`), per-repository (`<repo>/<basename>.md`), or per-branch (`<repo>/<branch-folder>/<basename>.md`).

The fingerprint's algorithmic equality with the per-repository file registry's fingerprint is load-bearing: downstream consumers compare a user file's fingerprint to the registry's fingerprint to decide whether the user file is hand-authored novel content or a copy of a system-emitted file under a different name. A drift between the two algorithms would silently break that comparison.

The modification timestamp's role is to serve as the chronological ordering key for user-authored files when they are folded into the source-of-truth timeline consumed by ingest. (Not for cache-invalidation; that is the fingerprint's job.)

## Behavior

### Entry point: scan with a known branch (cwd-resolving)

1. Attempt memory-mirror root resolution from the bound working directory. If the write boundary refuses that directory, if resolution throws, or if resolution yields a path that does not exist on disk, return an empty result.
2. Delegate to the explicit-root sibling (below) with the resolved root and the optional branch name.

### Entry point: scan with a known branch (explicit root)

1. If the supplied root does not exist on disk, return an empty result.
2. Compute the parent folder as the immediate parent of the supplied root.
3. Read the per-repository file registry through the hidden machine-readable layer at the root, into a path-set. On read or extract failure, the path-set is empty and a warning is emitted.
4. Initialize an empty result list.
5. **Global-scope pass:** invoke the per-directory collector against the parent folder, with scope = global-scope discriminator.
6. **Repository-scope pass:** invoke the per-directory collector against the supplied root, with scope = repository-scope discriminator.
7. **Branch-scope pass** (only if a branch name was supplied):
   - Resolve the branch's on-disk folder name: try the branch-mapping registry's `mapping for branch B` operation; on failure or absence, fall back to the deterministic transcoding of `B`.
   - If `<root>/<branch-folder>` does not exist on disk, skip this pass. (No warning — a branch that has never had user content is normal.)
   - Otherwise invoke the per-directory collector against `<root>/<branch-folder>` with scope = branch-scope discriminator and the branch label attached.
8. Return the accumulated result list.

### Entry point: scan every branch present on disk (explicit root)

1. If the supplied root does not exist on disk, return an empty result.
2. Compute the parent folder as the immediate parent of the supplied root.
3. Read the per-repository file registry into a path-set, with the same degraded-mode warning behavior as above.
4. Initialize an empty result list.
5. **Global-scope pass** against the parent folder.
6. **Repository-scope pass** against the supplied root.
7. **Multi-branch sweep:**
   - Enumerate the supplied root's direct subdirectories. If enumeration throws, return the partial result accumulated so far (the global and repository passes' contributions).
   - For each entry that is a directory and whose name is **not** in the system-reserved subdirectory set:
     - Resolve a branch label for the entry via the branch-mapping registry's `branch label for folder F` operation; on absence or failure, fall back to the entry's name verbatim.
     - Invoke the per-directory collector against `<root>/<entry>` with scope = branch-scope discriminator and the resolved branch label attached.
8. Return the accumulated result list.

### Entry point: scan every branch present on disk (cwd-resolving)

1. Attempt memory-mirror root resolution from the bound working directory. If the write boundary refuses that directory, if resolution throws, or if resolution yields a path that does not exist on disk, return an empty result.
2. Delegate to the explicit-root sibling (above) with the resolved root.

### Per-directory collector

Given a target directory, a scope, the memory-mirror root, the parent folder, the registry path-set, an output list, and an optional branch label:

1. Enumerate the target directory's direct entries (basenames only — no recursion). If enumeration throws, return without modifying the output. (Defensive silent skip — a per-directory unreadable error is treated like an empty directory.)
2. For each entry name:
   1. **Markdown-extension gate:** skip unless the basename ends in `.md`.
   2. **Generated-name gate:** skip if the basename matches the hash-suffix pattern OR the prefix pattern.
   3. Compose the absolute path `<target>/<entry>`.
   4. **Stat gate:** call stat on the absolute path; on stat failure, skip silently. (Defensive — covers race conditions where the entry vanishes between enumeration and stat.)
   5. **File-vs-directory gate:** skip if stat reports the entry is not a regular file. (A directory whose name happens to end `.md` is enumerated but filtered out here.)
   6. **Registry-membership gate** (applies only when scope is repository-scope or branch-scope; explicitly **skipped** for global-scope because files at the parent folder cannot appear in any per-repository registry by construction):
      - Compute the file's repository-relative path: the absolute path minus the memory-mirror root, expressed with forward-slash separators.
      - If that path is in the registry path-set, skip.
   7. **Read gate:** read the file as UTF-8 text. On read failure, emit a warning (file basename and error message) and skip.
   8. Compute the content fingerprint from the read content.
   9. Compute the parent-folder-relative path: the absolute path minus the parent folder, expressed with forward-slash separators.
   10. Append a record to the output with:
       - the parent-folder-relative path as the relative-path field,
       - the absolute path,
       - the supplied scope discriminator,
       - the branch label, only when one was supplied (omitted for global-scope and repository-scope passes; present for both branch-scope passes),
       - the fingerprint,
       - the read content,
       - the stat's modification time formatted as ISO-8601.

### Registry-membership rule fine print

The registry-membership gate compares against repository-root-relative paths (matching how the registry itself stores `files[].path`). This means a system-emitted file in a branch folder is recorded in the registry under `<branch-folder>/<basename>.md`, not under `<parent>/<repo>/<branch-folder>/<basename>.md`. The scanner's relative-path-anchor difference between input (registry-relative) and output (parent-folder-relative) is deliberate.

The global-scope pass cannot perform this gate because a global-scope file's anchor is the parent folder, which is at a higher level than the per-repository registry. Consequently the global-scope pass relies exclusively on the generated-name gate (hash-suffix and prefix patterns) for exclusion.

### Degraded mode: missing or unparseable registry

When the per-repository file registry cannot be read or its path-set cannot be extracted:

1. A warning is emitted naming the memory-mirror root and the underlying error message.
2. The path-set is empty.
3. All three scope passes proceed normally. The generated-name gate (hash-suffix and prefix patterns) is the sole exclusion mechanism for the repository-scope and branch-scope passes during the degraded mode.

The two-pattern union is **load-bearing** during degraded mode. A hash-suffix-only exclusion would let `plan--<slug>.md`, `note--<id>.md`, and `topic--<slug>.md` files leak through as user-authored content (those system-emitted filenames carry no hex suffix). Downstream consumers would then double-fold the same plan, note, or topic-page content into derived topic pages.

A pathological case the degraded mode cannot catch: a system-emitted file whose name matches neither pattern (would require an out-of-spec writer or a manual rename). Such a file would surface as user-authored content under the degraded mode; this is documented as an accepted limitation of fall-back-only identification.

### Symlink and special-file handling

The scanner uses the platform's regular stat (no special lstat path). Consequences:

- A regular file is processed normally.
- A symlink **to a regular file** stats as a regular file; its content is read by following the symlink, and its modification timestamp is the link target's mtime. The fingerprint is the target's content fingerprint.
- A symlink **to a directory** stats as a directory and is filtered out by the file-vs-directory gate.
- A directory whose name ends in `.md` is enumerated but filtered out by the file-vs-directory gate.

The scanner does **not** apply the vault-aware symlink-refusal protection used by system-driven writes (defined elsewhere). That guard is for the write path; the scanner is a read path and treats symlinks as transparent.

### Error containment summary

| Failure mode | Behavior |
| --- | --- |
| Memory-mirror root refused by the write boundary | Empty result; debug log; no warning; **nothing created on disk**. Reached before any repository-name or remote-URL derivation. |
| Memory-mirror root resolution throws | Empty result; debug log; no warning. |
| Memory-mirror root does not exist on disk | Empty result; debug log; no warning. |
| Per-repository file registry missing | Degraded mode (empty path-set); warning emitted. |
| Per-repository file registry unparseable | Degraded mode (empty path-set); warning emitted. |
| Branch-mapping registry missing or unparseable (known-branch variant) | Silent fall-through to deterministic transcoding. |
| Branch-mapping registry missing or unparseable (multi-branch sweep) | Silent fall-through to folder-name-as-branch-label. |
| Per-directory enumeration throws (collector) | Silent skip of that directory; other scopes unaffected. |
| Per-directory enumeration throws (multi-branch sweep root listing) | Return the partial result accumulated so far. |
| Per-file stat throws | Silent skip of that file. |
| Per-file content read throws | Warn (file path, error message); skip that file. |

### Iteration ordering

The scanner does not impose any sort. Within a single scope-pass, files appear in the order the host directory listing returns them (host-OS dependent: typically filesystem-insertion order on ext4/APFS, alphabetical on NTFS with default settings). Across scope-passes, the order is fixed: global-scope first, then repository-scope, then either the single branch-scope pass (known-branch variant) or the multi-branch sweep in the order the root's directory listing returns each branch folder. Downstream consumers that require deterministic ordering must sort themselves.

## State Transitions

The scanner is stateless across invocations. Each call resolves the memory-mirror root, opens the registries, performs the passes, and returns. No on-disk state is mutated. The two registries are read each call (no caching layer in the scanner); a caller invoking the scanner twice in succession will see registry changes made between the two calls.

The output record set is a function of:
- The configured user-pickable parent folder's contents at call time.
- The per-repository file registry's `files[].path` set at call time.
- The per-repository branch-mapping registry's contents at call time.
- (For the known-branch variant) the branch argument.
- The host OS's directory iteration order at call time.

Two invocations interleaved with a system-driven write or an ingest can produce different outputs by registry-membership changes alone, with no user-side file edits. This is intentional: a file the system has just claimed (added to the registry) immediately stops surfacing as user-authored content.

## Notable Behavior

- **Two exclusion patterns together, not just one.** The hash-suffix pattern (matching `-<8-hex>.md`) and the prefix pattern (matching `plan--` / `note--` / `topic--`) are both required to fully exclude system-emitted files when the per-repository registry is missing or unparseable. The hash-suffix pattern alone would let prefix-named files leak through; the prefix-pattern alone would let summary-visible files (which use the hex suffix) leak through. (Notable; intentional belt-and-suspenders during degraded mode.)
- **Generated-name patterns are duplicated with the writer.** The writer that emits visible-layer files uses the same hash-suffix and prefix conventions, by a separate code path. Changing the convention in one place without updating the scanner would either let generated files surface as user-authored content (double-folding their content into ingest) or hide newly-renamed system files. The duplication is acknowledged at both ends. (Notable.)
- **The per-commit skill aggregate is excluded by both existing gates, with no pattern of its own.** It is registry-registered (primary gate) and its `--<8-hex>.md` tail matches the hash-suffix pattern (secondary gate). Nothing was added for it — which means the *secondary* gate's coverage is an accident of the filename, not a decision recorded anywhere in this scanner. Renaming the aggregate away from that tail would keep it excluded in normal operation and silently leak it as user knowledge in degraded mode, where it would be double-folded into derived topic pages. (Surprising; a latent coupling worth naming precisely because there is no code here to notice it.)
- **Registry membership skipped for the global-scope pass.** Files at the user-pickable parent folder's top level cannot appear in any per-repository registry by construction (per-repository registries record per-repository-rooted paths). The scanner consequently skips the registry-membership gate for that pass, relying solely on the generated-name gate. (Notable; load-bearing optimization.)
- **Relative path is parent-folder-anchored, registry path is repository-anchored.** The output's relative-path field is anchored at the user-pickable parent folder (one level above the per-repository root). The registry-membership check, however, derives a path anchored at the per-repository root before checking membership. The two anchors differ by one segment. Consumers reading the output's relative path can identify the scope from the leading segments (`<file>.md` is global, `<repo>/<file>.md` is repository, `<repo>/<branch-folder>/<file>.md` is branch). (Notable; intentional.)
- **System-reserved subdirectory list is small and fixed.** Only the hidden machine-readable layer's name and the wiki layer's name are skipped during the multi-branch sweep. Any other directory at the per-repository root is interpreted as a branch folder, even if it is one the user created manually (e.g. a misnamed leftover). The scanner attempts to reverse-map it via the branch-mapping registry; failure falls back to using the directory name verbatim as the branch label. (Notable.)
- **Branch-mapping registry reverse-lookup is best-effort.** The multi-branch sweep's `branch label for folder F` reverse-lookup falls back to the folder name itself on absence. A folder name that does not round-trip through the deterministic transcoding (e.g. a folder created manually rather than by the system) is reported with its name as the branch label, which downstream consumers may then fail to associate with any real branch. (Notable; data-preservation choice — surfacing the file with an imperfect label beats hiding it.)
- **Per-directory enumeration failure during the multi-branch sweep returns partial results.** When the root subdirectory listing fails partway through, the scanner returns the accumulated global-scope and repository-scope contributions; it does not throw, does not retry, and does not include any branch-scope contributions. The same primitive (per-directory enumeration) used inside the per-directory collector silently skips on failure. The asymmetric treatment is deliberate: a failure to list the root is qualitatively different from a failure to list one branch folder. (Notable.)
- **Symlink handling is platform-default.** The scanner uses stat (not lstat), so symlinks to regular files are followed transparently for content read and fingerprinting. Symlink-refusal protection applies only to system-driven writes elsewhere in the system; the scanner does not duplicate it for reads. (Notable.)
- **Stat-fails-on-vanished-file is silent.** A file that disappears between directory enumeration and the stat call is silently skipped with no warning — by contrast, a file that exists at stat time but fails to read **does** emit a warning. The asymmetry encodes the assumption that vanishing-between-enumeration-and-stat is a benign race, while read-after-stat-failure is a permission or filesystem problem worth surfacing. (Notable.)
- **Scanning never creates the mirror it scans.** The write boundary is consulted before the root is resolved, precisely because resolving it *claims* it. A scan from a working directory the boundary refuses therefore reports "no user knowledge" without having produced a per-repository subdirectory to be empty about — where previously it produced one on every scan. This makes the scanner read-only in fact and not merely in intent, and it is the reason the boundary sits ahead of resolution rather than around it. (Notable; intentional regression-closer.)
- **The gate is unconditional, and the claim behind it is not.** The scanner never consults the storage-mode configuration, so the boundary is evaluated on every scan regardless of whether a folder layer is configured — and when the boundary *allows*, resolution still claims the root. A user whose configuration selects the version-controlled-ref layer only, and who therefore expects no per-repository subdirectory to exist at all, can still have one claimed by a knowledge scan. (Surprising.)
- **Configuration-failure path returns empty without warning.** When the bound-working-directory-based resolution of the memory-mirror root throws (e.g. configuration unloadable, repository basename unresolvable), the scanner emits a debug-level log and returns empty. This deliberately keeps the scanner non-fatal for hosts where memory-mirror configuration is not present. (Notable.)
- **Empty branch directory triggers no warning.** A branch name that resolves to a folder that does not exist on disk is treated as "no user content for this branch yet" and silently skipped in the known-branch variant. The same scenario in the multi-branch sweep cannot arise (the sweep enumerates folders that exist on disk by definition). (Notable.)
- **Modification timestamp serves as a downstream ordering key.** Beyond identifying a file, the modification timestamp is promoted by downstream consumers to the chronological position of the file in the source-of-truth timeline that ingest reads. This means a user editing a file shifts its position in the timeline; this is intentional. The fingerprint, not the timestamp, drives cache invalidation. (Notable.)
- **No deduplication across scopes.** A file placed at `<root>/foo.md` and a separately-authored file at `<root>/<branch-folder>/foo.md` are both surfaced (under repository-scope and branch-scope respectively). The two are different files at different paths; no merge or rename inference is performed. (Notable.)
- **Result ordering is host-OS dependent.** Within a scope-pass the scanner does not sort; the order is whatever the host directory iteration returns. Across passes the order is fixed (global, then repository, then branch / branches). Two consumers running on different OSes against the same input data may receive the same records in different intra-pass orders. (Notable; downstream consumers must sort if they need determinism.)
- **The per-repository file registry's `files[].path` field is the sole identifier consumed.** No other registry column (file ID, fingerprint, file type, source commit hash) is read by the scanner. This means a registry row whose path is correct but whose fingerprint is stale still excludes the file — exclusion is purely path-membership-based, not content-based. (Notable; a user wanting to recover a hand-edit cannot do so by editing the file alone, because the path-based exclusion still hides it; recovery requires a separate registry-clearing step.)
- **The cwd-resolving entry points and the explicit-root entry points share their core logic.** The cwd-resolving variants are thin wrappers that resolve the memory-mirror root and then delegate. A caller without a host repository at the bound working directory (e.g. a multi-repository sweep iterating discovered repositories) calls the explicit-root variants directly. Both variants produce identical output for the same root. (Notable.)

## Shared Behavior

- The full layout and reserved-name semantics of the per-repository memory mirror, including how the global / repository / branch scopes correspond to fixed directory depths and how the system-reserved subdirectory names are chosen, are defined by the memory-bank folder layout spec.
- The write-boundary predicate this scanner's root resolution consults, its refusal reasons, the other two consumers that consult it, and the effective-state report that makes a refusal visible to the user are defined by the memory-bank write-boundary and effective-state-reporting spec. The claiming behavior of the root resolution the boundary guards is defined by the memory-bank folder layout spec.
- The shape and mutation semantics of the per-repository file registry, the per-repository branch-mapping registry, and the fingerprint algorithm used to populate the registry's fingerprint column are defined by the folder-based summary storage spec.
- The naming conventions for system-emitted visible files (the hash-suffix shape and the `plan--` / `note--` / `topic--` prefixes) are defined by the folder-based summary storage spec; this scanner consumes the patterns as exclusion rules.
- The deterministic transcoding rule used as the branch-name → folder-name fallback, and the reverse folder-name → branch-name lookup, are defined by the folder-based summary storage spec.
- The downstream timeline pipeline that consumes this scanner's output, including how user files are merged with system-emitted artifacts by modification timestamp, is defined by the source timeline ordering spec.
- The topic ingest pipeline that consumes this scanner's output as raw compile input for derived topic pages is defined by the topic ingest pipeline spec.
- The multi-repository compile sweep that invokes the explicit-root entry points once per discovered repository is defined by the multi-repo memory-bank compile sweep spec.
- The per-repository folder browser UI that visualizes this scanner's classification visually is defined by the per-repository memory-bank folder browser spec.
