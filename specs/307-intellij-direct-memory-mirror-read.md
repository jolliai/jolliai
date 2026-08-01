# 307. IntelliJ Direct Memory-Mirror Read Path

## Topic Statement

A second, independent read source for this IDE's memory data: a per-project accessor bound once to one repository's on-disk memory mirror that answers a fixed set of read shapes straight off the local filesystem — a per-commit memory document as a parsed record, the same document as raw bytes, an archived plan body, an archived note body, and an archived external-reference body — and declines on any doubt so the caller falls back to the canonical version-controlled ref. It never writes and never enumerates, and it re-reads the mirror's per-device out-of-sync marker before every single read; the host that owns it, however, memoizes single-memory reads in a bounded map that is consulted ahead of the accessor and can therefore outlive that check.

## Scope

**In scope:**
- The read shapes this accessor serves, and the read families that have no shape here and therefore always go to the ref.
- The preconditions that decide whether the accessor exists at all, and the order they are evaluated in.
- Where in project initialization the accessor is attached, why it is attached *after* the migration step, and what a declined attach costs.
- The re-attach hook that lets a settings save re-point the read source without an IDE restart, and its threading and failure contract.
- Per-read gating on the mirror's per-device out-of-sync marker, and the presence-only nature of that contract.
- The path-containment guard applied to every caller-supplied key.
- Failure handling: what declines, what is logged, what is silent, and the fact that every failure resolves to a fallback that no user-facing surface reports.
- The host-side bounded memoization of single-memory reads, its wholesale invalidation, and the degradation window it opens.
- The cost of *locating* the mirror root, and the fact that it is neither local nor side-effect-free.
- The divergences between this accessor's eligibility rules and the canonical read-side storage resolution the other hosts use.
- The precise cross-language lockstep obligation this accessor creates on the writer, including which parts of the mirror it does **not** consume and are therefore free to evolve.

**Out of scope (boundaries):**
- The mirror's on-disk layout — the parent folder, the per-repository subdirectory, the hidden machine-readable layer, the visible human-readable layer, the reserved names, and the out-of-sync marker's own write contract (covered by the Memory Bank folder-layout spec, 151).
- The mechanics of writing that mirror, and the dual-write orchestration that sets and clears the out-of-sync marker (covered by the folder-based and dual-write storage specs, 02 and 03).
- The storage-mode configuration value, its accepted values, and the canonical read-side and write-side resolutions built on it (covered by 03). This spec states only how *this* accessor's eligibility test differs from them.
- The write boundary that can refuse to claim a per-repository subdirectory, and the effective-state record derived from it (covered by 300).
- The schemas of the documents read here (covered by their own schema specs).
- The canonical version-controlled ref this accessor falls back to, and the native git subprocess wrapper that performs that fallback read (covered by 01 and 126).
- The project-service lifecycle that performs the attach, and the settings surface that triggers the re-attach — this spec owns the read source, those specs own the call sites (124 and 135).
- The cross-process bridge connection used to locate the mirror root (covered by 288).
- Every UI surface that consumes a memory read; none of them knows this accessor exists.

## Data Contracts

### What the accessor is bound to

One accessor instance is bound to a single already-resolved per-repository mirror root. The binding is immutable for the accessor's life: re-pointing it at a different root means constructing a new accessor and handing it to the read path in place of the old one. Only one accessor is in effect per project at a time, and the read path tolerates having none.

Relative to that root, the accessor derives and holds these locations: the directory of per-commit memory documents, the directory of archived plan bodies, the directory of archived note bodies, the directory of archived external-reference bodies, and the per-device out-of-sync marker file. Nothing else under the root is referenced.

### The read shapes

| Shape | Caller-supplied key | Returned |
|---|---|---|
| Per-commit memory document, parsed | commit identifier | a decoded memory record, or nothing |
| Per-commit memory document, raw | commit identifier | the document's exact bytes as text, or nothing |
| Archived plan body | plan slug | the body's exact bytes as text, or nothing |
| Archived note body | note identifier | the body's exact bytes as text, or nothing |
| Archived external-reference body | source id **plus** the reference's archived key | the body's exact bytes as text, or nothing |

The reference shape is the only one whose key is a pair rather than a single string, and the only one whose file **stem is derived** rather than used verbatim: the source id selects a per-source subdirectory, the archived key has that source's wire-name prefix stripped, and the remainder is put through the writer's sanitize rule to produce the stem. That derivation is a lockstep contract of its own and is owned by spec 317; this spec owns only the gating and containment mechanics it shares with the other shapes.

Every shape is a single-item lookup by a key the caller already holds. There is no enumeration, no prefix scan, no listing, and no discovery: the accessor cannot answer "which documents exist" and is never asked to.

### Attach inputs

Attaching takes two values: a resolved per-repository mirror root path (which may be absent or blank) and the configured storage-mode value (which may be absent). Nothing else is consulted — not the write boundary, not the mirror's aggregate index, not the ref.

### Out-of-sync marker contract

The marker's **presence** is the entire contract. The accessor tests only whether the marker exists as a regular file; it never opens, parses, or validates its body. A marker whose contents are empty, malformed, or claim "not dirty" gates reads exactly as strongly as a well-formed one.

### Host-side memoization of single-memory reads

The project service memoizes the parsed-record shape only (never the raw-bytes, plan, note, or reference shapes):

- Capped at 128 entries, access-ordered, evicting the least-recently-used entry once the cap is exceeded; wrapped for concurrent access.
- Keyed by the commit identifier the caller asked for. When the lookup only succeeded after following a commit alias to a different underlying record, the record is stored under **both** the requested identifier and the resolved one.
- Invalidated **wholesale** — the whole map is emptied — never per key. Two triggers: any memory-state change notification, and an explicit invalidation call used by in-panel edit handlers that update themselves locally and must not provoke a full listener refresh.
- Consulted **before** the read source. A cache hit returns without touching the accessor, the ref, or any of the accessor's own degradation checks.

## Behavior

### Attach preconditions, in order

An attach attempt either produces a live accessor or produces none. The checks are evaluated in this order and the first match declines:

1. The resolved mirror root path is absent or blank.
2. The configured storage-mode value is **exactly** the ref-only value.
3. The root path does not exist, or exists but is not a directory.
4. The directory of per-commit memory documents under that root does not exist, or is not a directory.

Otherwise a live accessor is produced.

Check 2 is an exact match against one value, not a positive test for the two folder-writing modes. **Any other storage-mode value yields a live accessor** — unset, either folder-writing value, or an unrecognised string such as a typo. A test pins the decline on the ref-only value and three of the live outcomes (unset and the two folder-writing values); **the unrecognised-value case has no assertion**, so the typo tolerance is established by inspection of the exact-match check, not by test.

Check 4 is what makes the attach's *position* load-bearing. Initializing a mirror folder for a repository writes only the hidden layer's aggregate identity documents; it does not create the per-commit document directory. That directory comes into existence when the first document is written into it — by the migration pass, or by a later commit.

### Where the attach happens

The attach is the last action of the project service's guarded mirror-initialization step, which in order: resolves the repository's identity, resolves and initializes the mirror folder, runs the migration, and then attaches. It records one line in the initialization log stating whether the accessor attached or was unavailable — and that log line is the only place either outcome is written down.

**Attaching after migration is deliberate and required.** On a fresh install the mirror folder exists (identity has just been written) but holds no memory documents until migration copies them across, so an attach attempted before migration would fail check 4 and leave the whole session with no accessor — precisely the sessions that would benefit most.

A declined attach is a **supported** outcome, not an error: the read path keeps its previous accessor (or none), every read goes to the canonical ref, and nothing else changes. The whole mirror-initialization step is wrapped so that a thrown failure anywhere inside it — including in the attach — is recorded in the initialization log and does not abort initialization.

### Locating the mirror root is not itself local

Before an attach can happen, four values must be obtained, and each is a cross-process bridge call: the repository name, the repository's remote URL, the configuration record, and finally the resolved per-repository mirror root. So the "direct" read path becomes direct only after several cross-process round-trips.

Two consequences follow from *which* resolution is used:

- The root is resolved through the **claiming** resolution, not the pure-read one. Resolving can therefore create a per-repository subdirectory and write a repository-identity document into it, and can allocate a suffixed sibling when the natural name belongs to another repository. (That claiming write is itself suppressed for a repository carrying the durable manual-disable opt-out.) Locating the mirror is a mutation, not a lookup.
- The bridge calls involved carry no project of their own: the target repository travels in the request body rather than in the call's working directory, which is why they can be served by an arbitrary open project's connection (288). The values they return do not depend on which one serves them.

### Re-attaching after a configuration change

A re-attach hook re-runs the identity resolution, the configuration load, the root resolution, and the attach, replacing whatever accessor was in effect. Two callers exist: project initialization itself, and the settings surface's deferred background apply, immediately after that apply has re-run the migration.

- It **no-ops** when there is no resolved repository root and no project base path, and when no read path has been constructed yet (i.e. before initialization has got that far).
- It performs filesystem **and** cross-process I/O, so it must not run on the interface thread; both existing callers are off it.
- Any thrown failure is logged at warning and swallowed. The previous attachment stays in place, so a failed re-attach degrades to "still pointing at the old root", not to "no read source".
- Producing no accessor is a normal result (the newly configured root is unpopulated, or the mode is now ref-only), and it detaches the previous one.

The settings-surface call is what makes a Memory Bank path change or a storage-mode change take effect within the session. Without it, initialization's single-shot guard means the attach never re-runs and reads keep coming from the previously attached folder.

### Every read, step by step

Every shape follows the same sequence:

1. **Test the out-of-sync marker.** If present, decline immediately — no path is built and no file is touched.
2. Build the target path from the caller-supplied key inside the shape's own directory.
3. **Apply the containment guard** (below). Decline if it refuses.
4. Require the target to be a regular file. Decline otherwise.
5. Read it.

Then, per shape:

- **Parsed record.** Decode the text into a memory record. Decline when the decode yields nothing at all, and decline when the decoded record's identifying commit field is blank. The second check is not redundant: the decoder can populate a record by bypassing construction, so a structurally-empty document decodes "successfully" into a record whose required fields are absent at runtime — an outcome that would otherwise be handed to callers as a valid answer and would shadow the ref. An explicitly empty identifier is the same failure one transformation upstream. Any thrown failure during this step is logged at **debug** (naming a truncated form of the key) and declines.
- **Raw bytes, plan body, note body, reference body.** Return the file's exact text with **no schema check of any kind**. Any thrown failure declines with **no log line at all**.

The reference shape differs from the other shapes only in steps 2 and 3. Step 2 is two-level — a per-source subdirectory under the references directory, then the derived stem inside it — and step 3 is correspondingly **doubled**: the source subdirectory is required to be contained within the references directory, *and* the target file is required to be contained within that subdirectory. The first of those two checks is defence-in-depth against a hostile or malformed source name reaching disk; the sanitize that produces the stem already strips path separators, so neither check is expected to fire on real input.

Every decline reaches the caller as "no answer", and the caller reads the same item from the canonical ref instead. **Nothing surfaces to the user on any of these paths** — not a missing file, not an unreadable file, not a missing root, not a missing configuration record, not a mid-session mode flip. Every one of them is a silent fallback.

### The marker is re-read per read, not per attach

The marker test is a fresh filesystem probe on every call. A marker that appears mid-session therefore takes effect on the very next read, and one that is cleared re-enables the mirror on the next read — both directions are pinned by a test that toggles the marker under a live accessor.

This is deliberately stricter than the eligibility checks: mode and root are evaluated once per attach, the marker on every read.

### Containment guard

Before any read, the target path and its intended parent directory are both canonicalized, and the target is required to begin with the parent plus a path separator. Any thrown failure during canonicalization refuses.

The guard exists because every shape builds its path from a caller-supplied name, and a name carrying parent-directory traversal or an absolute-path form would otherwise compose a path outside the intended directory. Because canonicalization resolves symbolic links, a link *inside* the directory that points outside it is refused as well. Refusing costs nothing, because the ref fallback can serve the same item and is not reachable by path composition.

**No test exercises this guard.** Its correctness rests on inspection only.

### Reads that never use the mirror

Three read families have no shape here and always resolve against the canonical ref:

- Enumerating the repository's memory documents (the memory list).
- Reading a stored transcript.
- Rendering a committed conversation from a stored transcript.

The writer side's own lockstep note names the same coupled set this accessor implements: the per-commit memory documents, the plan bodies, the note bodies, the archived external-reference bodies, and the out-of-sync marker. (Corrected: that note omitted the archived external-reference path until the reference shape landed.)

### The lockstep obligation, stated precisely

Because this accessor parses the writer's on-disk documents in a different language, the writer cannot change them unilaterally. What is coupled is exactly what is consumed:

- The read locations (their folder names and file-naming rules), including the reference shape's two-level layout and the stem-derivation rule that produces its filename — the strongest of these couplings, because it is a *computed* name rather than a caller-supplied one, and a drift in the sanitize rule silently returns nothing for every archived reference rather than failing loudly (spec 317).
- The out-of-sync marker's location and its presence-means-degraded semantics.
- The schema of the one document shape that is parsed (the per-commit memory document). The byte-returning shapes are opaque to this accessor and carry no schema coupling.

**The mirror's hidden aggregate index is not consumed here.** This accessor has no discovery path at all — every read arrives with a key the caller already obtained elsewhere — so the index's schema may evolve without touching this reader. That absence is what makes the obligation precise rather than "the whole hidden layer": the coupling covers the consumed paths, folder names, marker semantics, and the one parsed schema, and nothing else. It also means the obligation grows the moment any read path here starts consuming the index or gains a key-enumeration helper.

### Divergences from the canonical read-side resolution

The other hosts pick a read backend through a shared resolution that this accessor deliberately does not reuse. Five differences, all observable:

| Aspect | Canonical read-side resolution | This accessor |
|---|---|---|
| Readiness probe | a successful read of the mirror's aggregate index | the per-commit document **directory exists** |
| Unrecognised storage-mode value | degrades to ref-only, so a configuration typo cannot split the storage layer | treated as mirror-eligible; only the exact ref-only value declines |
| Write boundary | consulted, degrading to ref-only when the working directory may not claim a folder | not consulted at all |
| Out-of-sync marker | evaluated once, when the backend is resolved | evaluated on **every read** (stricter) |
| When mode and root are re-evaluated | on each resolution, with the host caching the result and dropping that cache on a settings save | once per attach; a mode or root change made anywhere other than this IDE's own settings surface is not observed until the next attach |

There is **no sixth difference in which configuration value names the mirror's parent folder** — that divergence is closed. This spec previously recorded that this IDE resolved the root from its own Memory Bank folder setting while the canonical write path resolved the same folder from a different key, so re-targeting the folder here moved where the mirror was read from without moving where it was written. The IDE's configuration record now declares the canonical key as the field's name with the IDE's older key accepted as an alias, and both of this IDE's root resolutions (the initialization attach and the re-attach hook) read the canonical field. All three surfaces resolve the mirror's parent folder from one key. The alias is a read-side migration shim only, and it carries a last-key-wins hazard of its own; both are owned by spec 318.

### The accessor never writes

Its entire filesystem vocabulary is directory-existence probes, regular-file probes, path canonicalization, and whole-file text reads. It creates nothing, updates nothing, and deletes nothing — including the out-of-sync marker, which it only observes. Keeping the mirror consistent stays entirely with the writer, so there is no second implementation of the write decisions to keep in step.

## Notable Behavior

- **A cached memory read can outlive every degradation check this accessor makes.** The host consults its bounded map before the read source, so while an entry is cached the mirror is not consulted at all — neither its marker test nor its file probes. A mirror that goes out of sync mid-session can keep being served from cache until the next wholesale invalidation. The 128-entry access-ordered cap and the fact that invalidation is total rather than per key are what keep the window small, not any freshness check.
- **Invalidation is deliberately total, not targeted.** The call sites that change a memory often cannot say which identifiers are affected, and a targeted removal would strand the sibling entry written under a resolved alias identifier. Over-invalidation costs one lazy re-read.
- **Nothing tells the user that reads have degraded.** Both the readiness state and the out-of-sync state are exposed as queryable predicates, and no production code outside the accessor calls either. The only record that an attach declined is one line in the initialization log; a marker appearing mid-session is recorded nowhere. From the user's side a degraded mirror and a healthy one are indistinguishable — reads just get slower.
- **Every shape but the parsed-record one fails completely silently.** Only the parsed-record shape logs (at debug) when a read throws. An unreadable plan body, note body, reference body, or raw document leaves no trace anywhere.
- **The reference shape's key is the only one the accessor transforms before use.** The other shapes interpolate the caller's key verbatim; this one strips a prefix and runs a sanitize. That makes it the only shape where the accessor can look in the *wrong place* while behaving correctly — and because a miss is indistinguishable from an absent file, a stem-rule drift degrades every archived reference to the ref fallback with no signal at all (spec 317).
- **An unrecognised storage-mode value is treated as mirror-eligible here and as ref-only everywhere else.** A configuration typo therefore has opposite effects on the two surfaces: the canonical resolution refuses to touch the mirror, while this accessor happily reads it. The gate is an exact match against one string. **This divergence is asserted nowhere**: the test covering the gate pins the ref-only decline plus the unset and the two folder-writing values, and stops there — the unrecognised-value outcome, which is the divergence itself, rests on inspection of the exact-match check alone.
- **The stated motivation for this path names the cross-process bridge, but the path it actually replaces is a local git subprocess.** The reads it serves fall back to reading a blob out of the canonical ref through the plugin's own native git wrapper (126) — a process fork, not a bridge round-trip. Only the *attach* touches the bridge, and it adds calls rather than removing them.
- **Attaching after the migration step is not incidental ordering.** The readiness probe tests a directory that folder initialization does not create, so an attach placed before migration would decline on every fresh install and stick for the session.
- **The eligibility gate is evaluated once per attach, so a change made outside this IDE goes unobserved.** Flipping the storage mode from the command line, or re-targeting the folder from another surface, does not re-point this accessor. Only this IDE's own settings save (and the next initialization) re-attach.
- **The containment guard has no test.** Every other decline path in the accessor is pinned by a test; the traversal and symlink-escape refusals are not.
- **Locating the read source mutates the filesystem.** The claiming root resolution can create and claim a per-repository folder, so the act of setting up a read-only fast path is itself a write — one performed by the resolver, not by this accessor.
- **The marker's presence is the whole contract, and that is a defence, not a shortcut.** The body is never parsed, so a truncated or corrupt marker still gates reads. The failure it guards against is a suppressed mirror write leaving the mirror behind the ref, where serving the mirror would return a pre-write document for the rest of the session with no warning anywhere.

## Unreachable Paths

- **The readiness and out-of-sync predicates are publicly exposed but have no production caller outside the accessor.** Readiness is consulted only by the accessor's own construction path, and the marker test only by its own reads. Both are reachable from tests, and neither is reachable from any surface that could report degradation to the user — which is the mechanism by which the degradation stays invisible.

## Shared Behavior

- **Memory Bank Folder Layout (151)** — owns the mirror's parent folder, its per-repository subdirectory, the hidden machine-readable layer this accessor reads from, and the out-of-sync marker's own definition and write contract.
- **Folder-Based Summary Storage (02)** — owns the writer whose on-disk output this accessor parses, and therefore the other half of the lockstep obligation stated above.
- **Storage-Mode Selection (03)** — owns the storage-mode configuration value, the three accepted configurations, the dirty-flag protocol, and both the canonical write-side and read-side resolutions this accessor's eligibility rules diverge from.
- **Memory Bank Write Boundary and Effective-State Reporting (300)** — owns the boundary this accessor does not consult, and the separately-reported effective state that exists because such degradations leave no trace on disk.
- **Orphan Branch Summary Storage (01)** and **IntelliJ Native Git CLI Wrapper (126)** — own the canonical ref and the subprocess wrapper that every decline here falls back to.
- **IntelliJ Project Service Lifecycle (124)** — performs the attach at the documented position, exposes the re-attach hook, and owns the bounded single-memory cache and its invalidation triggers.
- **IntelliJ Settings Surface (135)** — the one surface whose save re-points this read source, from its deferred background apply after re-running migration.
- **IntelliJ CLI Daemon Connection (288)** — carries the identity, configuration, and root-resolution calls the attach depends on, including the arbitrary-project routing that makes them safe to serve from any open project.
- **IntelliJ Archived-Reference Body Read (317)** — owns the reference shape's key pair, its wire-name prefix strip, its per-source subdirectory layout, and the stem-derivation rule that is the strongest of this accessor's lockstep couplings. This spec owns only the marker gate, the containment guard, and the silent-decline contract that shape shares with the other shapes.
- **IntelliJ Memory Bank Folder Setting Key Migration (318)** — owns the configuration-key alias that closed what this spec previously recorded as a sixth divergence, and the last-key-wins hazard that alias introduces.
