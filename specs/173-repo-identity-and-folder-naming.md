# 173. Repo Identity And Folder Naming

## Topic Statement
Derive a stable repository identity string from a source working tree, slugify its display name, propose a default vault-subdirectory folder for it, and record the resulting identity-to-folder binding in a cross-device registry that detects but never silently resolves collisions.

## Scope

**In scope:**
- The two-layer fallback that derives the canonical identity string from a source working tree: normalized remote-origin URL first, working-tree basename second.
- The normalization rules applied to the remote-origin URL so that trivially different forms of "the same remote" — including SSH transport variants and HTTPS clones of the same repository — collapse to one identity.
- The slug rules applied to the human-readable repository name to produce the human-readable half of the proposed folder name.
- The shape and read-time validation policy of the cross-device identity-to-folder registry document stored under the vault's hidden namespace.
- The allocation function that resolves the vault folder for a given identity in three cases: identity absent from the registry, identity present and agreeing with the caller's authoritative folder, identity present but disagreeing with the caller's authoritative folder.
- The per-file canonicalization pass that re-normalizes all stored `repoIdentity` values in an existing registry through the same URL normalization rule, collapsing any duplicate rows created by clients that predated SSH-to-HTTPS transport folding.
- The merge function that reconciles two copies of the registry from two devices and reports the set of folder-collision conflicts back to the caller.
- The stand-alone introspection function that returns the same conflict set for an already-merged registry.
- The branch-name-to-folder-name encoding used for the per-branch visible-layer directories (kept here because it is part of the same naming/identity helper surface).
- The cross-device portability and identity-stability properties (e.g. what happens when a remote URL is re-pointed, when a working-tree directory is renamed, when a slug is empty).
- The short hash-suffix helper exported for callers that need to deterministically disambiguate two repositories that would otherwise share the same slug.

**Out of scope (boundaries):**
- The on-disk layout of the vault parent folder, the per-repository hidden layer, the visible per-branch layer, and the wiki layer (covered by the memory-bank folder-layout spec).
- The local-disk folder allocation that picks the actual on-disk per-repository folder name (including any numeric collision suffix); the registry only records what the local allocator decided. The on-disk allocator is covered by the memory-bank folder-layout spec.
- The discovery pass that enumerates which subdirectories under the vault parent are repositories (covered by the memory-bank folder-layout spec). The registry is only consulted to attach identity labels to subdirectories that have been independently identified as repositories.
- The vault identity marker (the document that proves which remote a particular vault belongs to). That is a separate document with a different purpose; covered by the vault-identity-marker spec.
- The sync engine round that calls the registry-resolve function, writes the updated registry to the working tree, and stages/commits/pushes it (covered by the sync-engine reconciliation spec). This spec describes the pure functions only.
- The conflict UI that surfaces a detected folder collision to the user (covered by host-specific UI specs).
- The git remote shape, transport, credentials, or any pre-condition for actually reading the remote-origin URL — only the boolean "is one set?" matters here.
- The on-disk extraction of the human-readable repository name (the three-layer worktree-aware name resolution); that input is provided by an upstream helper and only the slug-of-name step is in scope.

## Data Contracts

### Source working tree (input)
An absolute filesystem path that a user has opened. The identity derivation reads two things from it:
- The remote-origin URL string, if one is configured. Otherwise the value is absent.
- The basename of the path (a fallback used when no remote is configured).
- The "extracted repo name" — a human-readable name derived upstream by the worktree-aware three-layer resolver (out of scope here).

### Repository identity tuple (output of derivation)
A pair:
- **`repoIdentity`** — the canonical string. Used as the registry key. Either the normalized remote URL or the working-tree basename, per the fallback chain below.
- **`slug`** — the human-readable, filesystem-safe transcoding of the extracted repository name, lowercase, restricted to `[a-z0-9-]`, with no leading/trailing/repeated hyphens. Used as the human-readable half of the proposed folder name.

### Cross-device identity-to-folder registry
A single document stored at a fixed path under the vault parent's hidden namespace (e.g. `<vault>/<dot-namespace>/repos.json`).

**Document shape:**
- `version` — integer; the literal `1`. Any other value invalidates the document.
- `mappings` — array of rows, each carrying:
  - `repoIdentity` — non-empty string.
  - `folder` — non-empty string.

**Read-time validation policy:**
- A missing file is treated as an empty registry (`{ version: 1, mappings: [] }`).
- A file that does not parse as JSON is treated as an empty registry.
- A document whose `version` is not `1` is treated as an empty registry.
- A document whose `mappings` is missing or not an array is treated as an empty registry.
- A row whose `repoIdentity` is not a string invalidates the **entire document** (treated as an empty registry).
- A row whose `folder` is not a string invalidates the **entire document**.
- (Note: a single bad row poisons the whole registry rather than being silently dropped — see Notable Behavior.)

**Serialization:**
- Two-space-indented JSON, followed by a single trailing newline character.
- Mappings are emitted sorted ascending by `repoIdentity` after a merge, so the on-disk byte sequence is stable across devices.

### Proposed default folder name (output of folder-name helper)
For a given identity tuple `{ repoIdentity, slug }`, the bare `slug` is returned as the proposed folder name. Collision handling does not happen in this helper; it happens in the upstream on-disk allocator and is recorded in the registry by the registry-resolve function.

### Authoritative folder name (input to registry-resolve)
A string supplied by the caller. Represents the folder name the local on-disk allocator has already committed to (it has chosen any local numeric collision suffix already). The registry function records that decision verbatim; it never overrides the caller's choice.

### Folder-collision conflict descriptor (output of merge / introspection)
A row per folder name claimed by two or more distinct `repoIdentity` values:
- `folder` — the colliding folder name.
- `identities` — array of the colliding identity strings, sorted lexicographically.

## Behavior

### Deriving the repository identity from a working tree
1. Attempt to read the remote-origin URL for the working tree.
2. If a URL is present and non-empty after trimming whitespace: produce the canonical identity by **URL normalization** (below). The canonical identity is the resulting string.
3. Otherwise: produce the canonical identity from the path's basename. No normalization is applied to a basename.
4. Independently derive the slug from the upstream extracted repository name by **slug normalization** (below).
5. Return the pair `{ repoIdentity, slug }`.

The canonical identity and the slug are derived independently. The identity is always either the normalized URL or the path basename; the slug is always derived from the upstream extracted name. The two strings are not required to agree (e.g. identity may be `https://github.com/foo/bar`, slug may be `bar`).

### URL normalization
Applied only when the input came from the remote-origin URL. Performed in this exact order:

1. Trim leading and trailing whitespace.
2. **Fold SSH and git transport forms to HTTPS.** Any URL whose transport is not already `https://` (or `http://`) is rewritten:
   - `ssh://[user@]host[:port]/path` and `git+ssh://[user@]host[:port]/path` → `https://host[:port]/path`. The SSH default port 22 is dropped; any other port is preserved.
   - `git://host[:port]/path` → `https://host[:port]/path`. The git default port 9418 is dropped; any other port is preserved.
   - SCP form `user@host:path` (requires the `user@` prefix) → `https://host/path`. A bare `host:path` without a `user@` is not folded (to avoid mangling Windows drive paths like `C:/repos/foo` or bare Linux basenames that legally contain `:`). The path segment of the SCP form is appended directly after the host; an absolute SCP path (`host:/srv/repo`) becomes `https://host//srv/repo`.
   - `https://`, `http://`, `file://`, and all other scheme-prefixed URLs pass through this step unchanged.
3. **Strip HTTPS user-info.** If the result after step 2 matches the pattern `http[s]://<user-info>@<host-and-path>` where `<user-info>` has no `/` or `@` characters, drop the `<user-info>@` segment. Match is anchored at the start of the string.
4. **Strip trailing `.git` and any subsequent slashes.** A case-insensitive trailing `.git` followed by zero or more slashes is removed.
5. **Strip remaining trailing slashes** (after the previous step has stripped the `.git[/...]` suffix, this step also handles URLs that never had `.git`).
6. **Lowercase the scheme and the authority** (host:port) for any URL that matches `<scheme>://<authority>...`. This also lowercases the host portion of URLs that were folded from SSH or SCP form in step 2.
7. **Lowercase the path component, but only for known case-insensitive-path hosts.** The hosts `github.com`, `gitlab.com`, and `bitbucket.org` route their owner/repo namespace case-insensitively at the platform level; for those hosts the path is fully lowercased. For every other host the path is preserved verbatim, including case — self-hosted forges may run on case-sensitive filesystems, and a path-rename there should produce a distinct vault subdirectory.

The combined effect is that the same repository reached via SSH (`git@github.com:Foo/Bar`) and via HTTPS (`https://github.com/foo/bar`) produces a single canonical identity string. Two different clients that cloned the same repository with different transports will not create duplicate rows in the registry.

### Slug normalization
Applied to the upstream-extracted repository name. Performed in this exact order:

1. Apply Unicode compatibility decomposition (NFKD).
2. Lowercase.
3. Drop the Unicode combining-marks range (`U+0300`-`U+036F`).
4. Replace every run of characters that are not in `[a-z0-9-]` with a single hyphen.
5. Collapse runs of hyphens to a single hyphen.
6. Strip leading and trailing hyphens.
7. If the result is the empty string, replace with the literal `repo`.

The slug is intentionally lossy: it discards every character outside `[a-z0-9-]`, including those that would survive standard URL-safe escaping. Two distinct upstream names can produce the same slug, which is normal and is the reason the registry distinguishes identities by their full `repoIdentity` string, not by `slug`.

### Proposing a default folder name
For an identity tuple, return the bare `slug`. No suffix is appended at this layer. Collision disambiguation is the upstream on-disk allocator's responsibility, and the registry records the allocator's pick.

### Resolving or assigning a registry mapping
Inputs: the current loaded registry, plus a caller-supplied pair `{ repoIdentity, authoritativeFolder }`.

Output: a pair `{ folder, updatedMapping }` where:
- `folder` is the folder the caller should treat as authoritative for this identity going forward.
- `updatedMapping` is either the new registry (when a write is required) or the literal "no update needed" marker (when the registry is already correct).

Resolution proceeds in three cases:

1. **`repoIdentity` is not present in the registry.** Append a new row `{ repoIdentity, folder: authoritativeFolder }` to the registry. Return `{ folder: authoritativeFolder, updatedMapping: <new registry> }`.

2. **`repoIdentity` is present and its stored `folder` equals `authoritativeFolder`.** No write is required. Return `{ folder: <stored folder>, updatedMapping: null }`.

3. **`repoIdentity` is present but its stored `folder` differs from `authoritativeFolder`.** Rewrite the existing row's `folder` to `authoritativeFolder`. Every other row in the registry is preserved as-is. Return `{ folder: authoritativeFolder, updatedMapping: <rewritten registry> }`.

The caller-supplied `authoritativeFolder` is always honored. The registry never proposes its own disambiguation suffix. It never rejects the caller's pick on the grounds that another identity already claims the same folder (such collisions are detected by the merge function and reported, not silently resolved — see Notable Behavior).

The two inputs are passed together as a single named pair (`{ repoIdentity, authoritativeFolder }`) by deliberate contract; an earlier signature that accepted two positional strings allowed callers to keep an old "suggest, then auto-hash-resolve" calling convention while the semantics had changed underneath. The named-pair shape forces every consumer to update at the call site when the contract changes.

### Re-normalizing a stored identity
A gated pass that applies the same URL normalization to an already-persisted `repoIdentity` string. It is used to heal rows written by clients that predated SSH-to-HTTPS transport folding.

1. Test whether the input looks like a remote URL: a scheme-prefixed string (matches `[A-Za-z][A-Za-z0-9+.-]*://`) or an SCP-form string (matches `[^@/:]+@[^/:]+:.+`).
2. If neither pattern matches, return the input unchanged. Bare fallback identities (folder basenames from the no-remote path, e.g. `myrepo`) never went through URL normalization at compute time; re-normalizing them would desynchronize the stored row from the live value (a no-remote repo named `foo.git` computes identity `foo.git`, but the normalizer would strip the `.git` suffix and produce `foo`).
3. If either pattern matches, apply the full URL normalization rule (as described in "URL normalization" above) and return the result.

### Re-normalizing all rows in an existing registry (canonicalization pass)
A batch operation that runs every row in a registry through the per-identity re-normalization gate and collapses any rows that fold to the same canonical identity.

1. Walk all rows. For each row, run its `repoIdentity` through the per-identity re-normalization gate.
2. Key each row by the canonical form. When two rows fold to the same key, the later row in file order wins (arbitrary but deterministic; the affected repo's own next sync round rewrites the row to the authoritative pick anyway).
3. If no row's identity changed and no duplication was detected, return the original registry object unchanged and report `changed: false` — callers may skip the write on no-op rounds.
4. Otherwise emit the deduplicated registry with rows sorted ascending by `repoIdentity`, and report `changed: true`.

The sync engine runs this pass immediately after loading the registry, before the reconcile-additive pass and before resolving the current round's repo. This ordering ensures the live identity (already in canonical HTTPS form) correctly matches any pre-existing row regardless of which transport that row was written with.

### Merging two registries from two devices
Inputs: two registries (`local` and `remote`).
Output: `{ merged, conflicts }`.

Steps:

1. **First pass — union by canonical `repoIdentity`, last-write-wins favoring the remote side.**
   - Walk `local.mappings` first, then `remote.mappings` second. For each row, run its `repoIdentity` through the canonicalization gate (described in "Re-normalizing a stored identity" below) before using it as the map key. If the canonicalized form differs from the stored form, store the canonical form in the row so the registry is always written in normalized shape.
   - The result is a map of canonical `repoIdentity` → entry where remote entries shadow local entries for the same canonical key. An SSH-form row from an older client and an HTTPS-form row from a newer client that address the same repository collapse to one entry at this step.
2. **Second pass — detect folder collisions across identities.**
   - Group the surviving entries by `folder`.
   - Any folder claimed by two or more distinct identities is recorded as a conflict descriptor `{ folder, identities }`. The identities list is sorted lexicographically.
3. **Emit the merged registry.**
   - Sort the surviving entries ascending by `repoIdentity` to keep the JSON byte-stable across devices.
   - Wrap as `{ version: 1, mappings: <sorted entries> }`.
4. **Return `{ merged, conflicts }`.** Even when conflicts are non-empty, the merged registry contains both colliding rows unmodified (no auto-rename). Callers are expected to surface the conflicts for manual disambiguation.

### Introspecting an already-merged registry for conflicts
Inputs: a single registry.
Output: array of conflict descriptors.

1. Group the rows by `folder`.
2. For each folder claimed by two or more distinct identities, emit a conflict descriptor `{ folder, identities }` with `identities` sorted lexicographically.
3. Return all such descriptors (the empty array when every identity claims a distinct folder).

This function is the stand-alone equivalent of the merge function's conflict-detection second pass. It exists so that consumers holding a registry that has already been written through (for example after a sync-engine pull-rebase has already integrated the merge) can still ask "which folders are claimed by more than one identity right now?" without re-running a merge.

### Computing the deterministic 6-hex short-suffix
Inputs: a `repoIdentity` string.
Output: a 6-character lowercase-hexadecimal string.

1. SHA-256 the UTF-8 encoding of the input string.
2. Hex-encode the digest.
3. Take the first 6 characters.

This helper exists for callers that need a stable, short, deterministic disambiguator (24 bits of digest space, sufficient for the "10s of repos per personal vault" scale this is designed for). It is **not** automatically applied by the proposing helper or by the registry-resolve function; both of those return the bare slug or the caller's authoritative folder respectively. The helper is provided for callers that decide their own collision-resolution policy. (See Notable Behavior — earlier iterations applied this suffix automatically and that behavior was removed.)

### Encoding a branch name as a folder-segment-safe string
Inputs: a branch name (potentially containing `/`).
Output: a folder-segment-safe string.

1. Replace every `/` character in the input with `^`.
2. Return the result.

### Decoding a folder-segment-safe branch name back to its original
Inputs: an encoded folder segment.
Output: the original branch name.

1. Replace every `^` character in the input with `/`.
2. Return the result.

The pair is a bijection on the set of legal git branch names because git's reference-name rules forbid `^` in branch names: the encoded form can never collide with a real branch name.

### Loading the registry from disk
1. Compute the registry path: `<vault root>/<dot-namespace>/repos.json`.
2. Attempt to read the file as UTF-8.
3. On any read error (including "file does not exist"): return an empty registry.
4. On read success: feed the raw string to the parse function. If parse returns the "invalid" verdict, return an empty registry. Otherwise return the parsed registry.

### Saving the registry to disk
1. Compute the registry path: `<vault root>/<dot-namespace>/repos.json`.
2. Ensure the parent directory (the dot-namespace directory under the vault root) exists, creating it recursively if necessary.
3. Serialize the registry (two-space-indented JSON, trailing newline) and write to the path. Write is non-atomic at this layer (the upstream sync engine handles atomicity if needed).

## State Transitions

The registry has three observable states:
- **Absent** — the file does not exist on disk; reads return an empty registry.
- **Empty** — the file exists but contains no mappings (`{ version: 1, mappings: [] }`).
- **Populated** — the file contains one or more rows.

Transitions:
- **Absent → Empty / Populated**: the first save after a resolve-or-assign call returned an updated registry.
- **Populated → Populated** (row added): a new identity that wasn't in the registry was resolved through resolve-or-assign; a new row was appended.
- **Populated → Populated** (row rewritten in place): an existing identity's authoritative folder changed (cross-device divergence); the row's `folder` was rewritten in place. The row's position in the mappings list is preserved by the resolve function; the merge function then re-sorts by `repoIdentity` on the next merge.
- **Populated → Populated** (merge): a remote registry was loaded and merged with the local one. Identical-key rows are deduplicated (remote shadows local). Different-key rows are unioned. Conflicts are surfaced but no row is auto-renamed.

A row's state is purely "stored folder" — there is no separate "claimed/unclaimed" sub-state. The registry never holds reservations; it only records "this identity went to this folder on at least one device".

## Notable Behavior

- **A single malformed row poisons the whole document.** Parse rejects the registry if any row has a non-string `repoIdentity` or non-string `folder` (a missing `folder` field is also non-string). The poison-the-whole-doc policy is at odds with the row-shape "silently dropped" wording elsewhere in the layout spec — what actually happens is the entire registry is treated as empty, not "the bad row is dropped while the rest survive". This is documenting code reality.
- **SSH and SCP transports fold to HTTPS.** `git@github.com:owner/repo`, `ssh://git@github.com/owner/repo`, and `https://github.com/owner/repo` all normalize to `https://github.com/owner/repo`. A repository cloned via SSH on one device and HTTPS on another therefore shares one registry row. This is a deliberate change from earlier behavior (see "Legacy SCP rows are healed" below).
- **Path case is preserved for unknown hosts, lowercased for known case-insensitive hosts.** For `github.com`, `gitlab.com`, and `bitbucket.org`, the path component is fully lowercased after transport folding, because those platforms treat `Owner/Repo` and `owner/repo` as the same repository. For every other host the path is kept verbatim — self-hosted forges may be case-sensitive.
- **HTTPS user-info is stripped before any other rewriting.** `https://user:pass@github.com/foo/bar.git` collapses to `https://github.com/foo/bar`, so credential leaks (a token accidentally committed into a remote URL) cannot escape into the registry on the next sync round.
- **Legacy SCP rows are healed on the next sync round.** Clients that predated SSH-to-HTTPS transport folding wrote `git@github.com:owner/repo`-style identities directly into the registry. The canonicalization pass re-normalizes every row on load; if it finds that an SCP-form identity folds to an HTTPS-form identity already present (or after folding collapses two rows to the same canonical form), the duplicate is removed. The `changed: true` signal from the canonicalization pass causes the corrected registry to be persisted on the same sync round, so later rounds take the fast path.
- **The SCP "gate" protects bare fallback names.** The per-identity re-normalization gate only rewrites strings that match a scheme-prefixed or SCP-like pattern. A bare name like `myrepo` or `foo.git` is returned unchanged. This prevents the normalizer from accidentally stripping a `.git` suffix from a no-remote repo name (changing `foo.git` → `foo`) and creating a phantom duplicate row.
- **The slug is lossy by design.** All non-`[a-z0-9-]` characters are replaced with hyphens; runs of hyphens are collapsed; leading and trailing hyphens are stripped; an entirely-symbolic input becomes the literal `repo`. The intent is to produce a directory name a human can recognize when browsing the vault; the canonical disambiguator is the registry's `repoIdentity` field, not the slug.
- **The default folder helper returns the bare slug — collision handling is deferred.** Two distinct identities that slug to the same string (e.g. `github.com/foo/bar` and `gitlab.com/foo/bar`) both propose the folder name `bar`. The on-disk allocator decides locally how to disambiguate (typically with a `-N` suffix it picks itself); the registry's job is then to record what the allocator decided. The registry never auto-applies a hash suffix.
- **An exported 6-hex helper exists but is currently unused for collision resolution.** A deterministic 6-character SHA-256 prefix of the `repoIdentity` is computable, but the current code does not invoke it anywhere. It is preserved for callers that want to opt into deterministic disambiguation. (Notable; earlier iterations applied it automatically inside both the proposing helper and the registry-merge function — both call sites have since been removed because there is no on-disk content mover at this layer, so an auto-applied suffix would point at an empty directory while real content stayed at the bare name.)
- **Resolve-or-assign honors the caller's authoritative folder unconditionally.** Even when another identity already claims the same folder in the registry, the resolve function will append a second row with the same folder. The collision is left for the merge function (and the stand-alone introspection function) to detect and surface to the user. This is documenting code reality.
- **Cross-device divergence triggers an in-place row rewrite.** When the registry already records identity → `<X>` but the caller has locally committed to `<X-N>` (because the on-disk allocator picked a numeric suffix locally), the resolve function rewrites the row to `<X-N>` and returns it. The reverse policy ("return the registry's `<X>`") was an earlier bug that left disk and registry pointing at different folders; one of the same-folder collision detection paths now catches that class.
- **Merge is last-write-wins favoring the remote side.** For a `repoIdentity` present on both sides with different folders, the remote's row wins. There is no clock or vector — the assumption is that the sync engine has already pulled the latest remote state before calling merge, so "remote" is in effect "the more authoritative side".
- **Merge does not auto-rename collisions.** Two distinct identities claiming the same folder both keep their original `folder` field in the merged output; the conflict is reported back to the caller in a separate list. Auto-renaming was the old behavior and it produced "renamed mapping points at an empty directory" bugs because nothing at this layer moves content on disk. The replacement is "report the conflict, let the user disambiguate by renaming a working-tree directory locally".
- **Merge emits stable byte order.** The merged mappings are sorted ascending by `repoIdentity` so the same input registries from two different devices produce the same on-disk bytes. This matters because the upstream sync engine commits the registry, and unstable ordering would produce a churn of "rewrite-only" commits.
- **Identity stability across `git remote set-url` is a non-property — except for transport changes.** Re-pointing the remote to a genuinely different host or path (e.g. moving from GitHub to GitLab) yields a different normalized URL and therefore a different `repoIdentity`. The vault layer treats the post-rename remote as a distinct repository: a new identity row will be appended on the next sync round, and the old folder will stay associated with the old identity (now orphaned but not deleted). Users who deliberately change their remote URL need to either accept the new folder or manually edit the registry. **Exception:** switching between `git@github.com:owner/repo` (SSH/SCP) and `https://github.com/owner/repo` (HTTPS) for the same remote produces the same canonical identity after normalization — the transport switch is invisible to the registry. This is documenting code reality.
- **Identity stability across working-tree directory renames is conditional.** If the working tree has a remote configured, renaming the working-tree directory does not change the identity (the remote URL is the canonical input). If the working tree has no remote configured, renaming the working-tree directory **does** change the identity (the basename fallback is the canonical input).
- **Branch encoding is bijective by construction.** The `/` → `^` substitution is reversible because git's branch-naming rules forbid `^`, so `^` characters can never appear in a legal branch name's pre-encoded form. The decoder's `^` → `/` substitution is guaranteed to land on a legal branch name.
- **Branch encoding leaves single-segment branch names unchanged.** A branch named `main` encodes to `main` and decodes back to `main`. Only nested-segment branches (`feature/foo`) round-trip through a different encoded representation (`feature^foo`).
- **The registry is a label source, not a discovery source.** The discovery pass that enumerates repositories under the vault root does so by filesystem inspection (looking for a hidden-layer index document); the registry is consulted **after** discovery to attach identity labels to discovered folders. A folder for a repository that has never been synced will appear without a label. (This boundary is enforced because the registry is by construction incomplete for local-only repositories.)

## Shared Behavior

- The cross-repository identity registry's role in the larger on-disk layout (where it sits, how it relates to the per-repository hidden layer, how it interacts with the local-disk on-disk allocator) is defined by the memory-bank folder-layout spec.
- The upstream three-layer worktree-aware repository name extractor (whose output feeds the slug derivation) is defined by the memory-bank folder-layout spec.
- The sync-engine reconciliation round that calls the registry-resolve function, integrates the merge function during pull-rebase, surfaces the conflict descriptors to the UI, and writes the updated registry into the working tree is defined by the sync-engine reconciliation spec.
- The vault identity marker — a separate document that proves which remote a particular vault belongs to — is defined by the vault-identity-marker spec. It is distinct from the cross-repository identity registry described here.
- The host-specific UI surfaces that display the discovered repositories and badge cross-device folder-collision conflicts are defined by the respective UI specs.
