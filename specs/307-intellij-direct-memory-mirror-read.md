# 307. IntelliJ Direct Memory-Mirror Read Path (Retired)

> **Retired — this topic describes a read source that no longer exists.** The JVM host's second, filesystem-direct read source over the memory mirror's hidden layer was deleted, together with its per-read out-of-sync gate, its attach and re-attach lifecycle, and its path-containment guard. Every data read that host performs now goes through the cross-process bridge. **Nothing below the "Historical record" divider describes live behavior.** That record is retained deliberately: several other specs still cite this number, and the deleted accessor is still referenced from comments in surviving code.

## Topic Statement

This topic previously described a second, independent read source for the JVM host's memory data: a per-project accessor bound once to one repository's on-disk memory mirror, answering five single-item read shapes straight off the local filesystem — a per-commit memory document as a parsed record, the same document as raw bytes, an archived plan body, an archived note body, and an archived external-reference body — declining on any doubt so that the caller fell back to the canonical version-controlled ref, and re-reading the mirror's per-device out-of-sync marker before every single read.

**No such accessor exists.** No production code on that host constructs one, no read path consults the mirror's hidden layer for any of those shapes, and the per-device out-of-sync marker is not read anywhere on that host at all. The host's reader is built over the command-line surface's storage provider instead, and every one of its data reads is a bridge call.

## Scope

**In scope:**
- Recording that the accessor is gone, along with everything that was distinctive about it: the attach preconditions, the position of the attach relative to the migration step, the settings-triggered re-attach, the per-read out-of-sync gate, the path-containment guard, and the silent-decline-to-ref fallback.
- The surviving relationship between that host and the mirror's data: every data read is a bridge round trip, with list-then-read flows batched into one.
- The distinct sibling native reader that **survives**, and the fact that it is a different accessor answering different questions.
- The historical record of what this topic used to describe, retained for readers of older code and of the specs that still cross-reference this number.

**Out of scope:**
- Which backend the bridge's storage action actually serves — that is a routing decision on the command-line side, owned by the storage-routing spec (344). This spec records only that the host inherits whatever it routes to rather than resolving a backend of its own.
- The surviving sibling reader's own contract — its two read entry points, its error policy, and the reasoning behind its deliberate absence of an out-of-sync gate — owned by spec 314.
- The bridge transport that now carries every one of these reads (specs 287 and 288), and the reader that consumes them (spec 126 for the plumbing it still uses on other paths).
- The mirror's on-disk layout, which is unchanged and still written (specs 02 and 151). What changed is who reads it, not what is written.

## Current reality

- **There is no second read source.** The host's memory reader is constructed with the bridge-backed storage provider and holds nothing else. There is no attach step in project initialization, no re-attach hook on a settings save, and no per-project field holding a filesystem-direct accessor.
- **Every data read is a bridge call.** The memory list, a single memory document (parsed or raw), an archived plan body, an archived note body, an archived external-reference body, a stored transcript, and a rendered committed conversation all resolve through the bridge's storage action. Where a flow lists and then reads (the memory list; the transcripts a commit's memory names), the reads are issued as **one batched request** rather than one call per file.
- **The out-of-sync marker is not consulted on that host.** No production code there probes it, so the read switch the marker used to double as no longer exists on that side. The marker is still written and still means what it meant (spec 151); nothing on this host reads it.
- **One read shape kept a defensive check, and it is not the retired guard.** The archived-reference read still derives its file stem from a source identity plus an archived key and rejects a derived stem containing traversal or separator characters before issuing the read. That is a check on the *derived stem*, performed before a bridge call — not the canonicalization-based containment guard the retired accessor applied to a composed filesystem path.
- **The host resolves no backend of its own.** It inherits whichever backend the command-line surface routes to, which is precisely the property the retirement was for: a surviving direct read would keep answering from the mirror after the source of truth moved, and plausible stale data is worse than none.

## The sibling reader is a different accessor, and it survives

Retiring this one does **not** retire the host's other native, bridge-free reader. That one is still live, still reads the mirror's hidden layer directly off disk, and is a different accessor answering a different question: it deserializes exactly two aggregate documents — the per-repository manifest and the summary index — for the Memory Bank tree's per-repository hot path, where a bridge call per repository per refresh was the cost being avoided. It is read-only, it takes an already-resolved root and resolves nothing itself, and it carries **no** out-of-sync gate. Its contract is owned by spec 314.

The two are easy to conflate and should not be: the retired accessor read *content* (memory documents and archived bodies) for one repository and gated every read on the marker; the survivor reads *metadata aggregates* across many repositories and never gated on anything.

---

## Historical record — what this topic used to describe

> Every sub-section under this heading is the retired accessor's behavior as it stood before deletion. **None of it is live.** It is kept because other specs cite it and because comments in surviving code still name the deleted accessor. The Shared Behavior section that follows it is current.

### What the accessor was bound to

One accessor instance was bound to a single already-resolved per-repository mirror root. The binding was immutable for the accessor's life: re-pointing it at a different root meant constructing a new accessor and handing it to the read path in place of the old one. Only one accessor was in effect per project at a time, and the read path tolerated having none.

Relative to that root, the accessor derived and held these locations: the directory of per-commit memory documents, the directory of archived plan bodies, the directory of archived note bodies, the directory of archived external-reference bodies, and the per-device out-of-sync marker file. Nothing else under the root was referenced.

### The read shapes

| Shape | Caller-supplied key | Returned |
|---|---|---|
| Per-commit memory document, parsed | commit identifier | a decoded memory record, or nothing |
| Per-commit memory document, raw | commit identifier | the document's exact bytes as text, or nothing |
| Archived plan body | plan slug | the body's exact bytes as text, or nothing |
| Archived note body | note identifier | the body's exact bytes as text, or nothing |
| Archived external-reference body | source id **plus** the reference's archived key | the body's exact bytes as text, or nothing |

The reference shape was the only one whose key was a pair rather than a single string, and the only one whose file **stem was derived** rather than used verbatim: the source id selected a per-source subdirectory, the archived key had that source's wire-name prefix stripped, and the remainder was put through the writer's sanitize rule to produce the stem. That derivation was a lockstep contract of its own and was owned by spec 317; this spec owned only the gating and containment mechanics it shared with the other shapes.

Every shape was a single-item lookup by a key the caller already held. There was no enumeration, no prefix scan, no listing, and no discovery: the accessor could not answer "which documents exist" and was never asked to.

### Attach inputs

Attaching took two values: a resolved per-repository mirror root path (which could be absent or blank) and the configured storage-mode value (which could be absent). Nothing else was consulted — not the write boundary, not the mirror's aggregate index, not the ref.

### Out-of-sync marker contract

The marker's **presence** was the entire contract. The accessor tested only whether the marker existed as a regular file; it never opened, parsed, or validated its body. A marker whose contents were empty, malformed, or claimed "not dirty" gated reads exactly as strongly as a well-formed one.

### Host-side memoization of single-memory reads

The project service memoized the parsed-record shape only (never the raw-bytes, plan, note, or reference shapes):

- Capped at 128 entries, access-ordered, evicting the least-recently-used entry once the cap was exceeded; wrapped for concurrent access.
- Keyed by the commit identifier the caller asked for. When the lookup only succeeded after following a commit alias to a different underlying record, the record was stored under **both** the requested identifier and the resolved one.
- Invalidated **wholesale** — the whole map emptied — never per key. Two triggers: any memory-state change notification, and an explicit invalidation call used by in-panel edit handlers that update themselves locally and must not provoke a full listener refresh.
- Consulted **before** the read source. A cache hit returned without touching the accessor, the ref, or any of the accessor's own degradation checks.

(This memoization is the one part of the arrangement that outlived the accessor: the bounded, access-ordered, wholesale-invalidated map still sits in front of the parsed-record read. It is owned by spec 124.)

### Attach preconditions, in order

An attach attempt either produced a live accessor or produced none. The checks were evaluated in this order and the first match declined:

1. The resolved mirror root path was absent or blank.
2. The configured storage-mode value was **exactly** the ref-only value.
3. The root path did not exist, or existed but was not a directory.
4. The directory of per-commit memory documents under that root did not exist, or was not a directory.

Otherwise a live accessor was produced.

Check 2 was an exact match against one value, not a positive test for the two folder-writing modes. **Any other storage-mode value yielded a live accessor** — unset, either folder-writing value, or an unrecognised string such as a typo. A test pinned the decline on the ref-only value and three of the live outcomes; the unrecognised-value case had no assertion, so the typo tolerance rested on inspection of the exact-match check.

Check 4 was what made the attach's *position* load-bearing. Initializing a mirror folder for a repository writes only the hidden layer's aggregate identity documents; it does not create the per-commit document directory. That directory comes into existence when the first document is written into it — by the migration pass, or by a later commit.

### Where the attach happened

The attach was the last action of the project service's guarded mirror-initialization step, which in order: resolved the repository's identity, resolved and initialized the mirror folder, ran the migration, and then attached. It recorded one line in the initialization log stating whether the accessor attached or was unavailable — and that log line was the only place either outcome was written down.

**Attaching after migration was deliberate and required.** On a fresh install the mirror folder exists (identity has just been written) but holds no memory documents until migration copies them across, so an attach attempted before migration would fail check 4 and leave the whole session with no accessor — precisely the sessions that would benefit most.

A declined attach was a **supported** outcome, not an error: the read path kept its previous accessor (or none), every read went to the canonical ref, and nothing else changed. The whole mirror-initialization step was wrapped so that a thrown failure anywhere inside it — including in the attach — was recorded in the initialization log and did not abort initialization.

### Locating the mirror root was not itself local

Before an attach could happen, four values had to be obtained, and each was a cross-process bridge call: the repository name, the repository's remote URL, the configuration record, and finally the resolved per-repository mirror root. So the "direct" read path became direct only after several cross-process round-trips.

Two consequences followed from *which* resolution was used:

- The root was resolved through the **claiming** resolution, not the pure-read one. Resolving could therefore create a per-repository subdirectory and write a repository-identity document into it, and could allocate a suffixed sibling when the natural name belonged to another repository. (That claiming write was itself suppressed for a repository carrying the durable manual-disable opt-out.) Locating the mirror was a mutation, not a lookup.
- The bridge calls involved carried no project of their own: the target repository travelled in the request body rather than in the call's working directory, which is why they could be served by an arbitrary open project's connection (288). The values they returned did not depend on which one served them.

### Re-attaching after a configuration change

A re-attach hook re-ran the identity resolution, the configuration load, the root resolution, and the attach, replacing whatever accessor was in effect. Two callers existed: project initialization itself, and the settings surface's deferred background apply, immediately after that apply had re-run the migration.

- It **no-opped** when there was no resolved repository root and no project base path, and when no read path had been constructed yet (i.e. before initialization had got that far).
- It performed filesystem **and** cross-process I/O, so it could not run on the interface thread; both callers were off it.
- Any thrown failure was logged at warning and swallowed. The previous attachment stayed in place, so a failed re-attach degraded to "still pointing at the old root", not to "no read source".
- Producing no accessor was a normal result (the newly configured root unpopulated, or the mode now ref-only), and it detached the previous one.

The settings-surface call was what made a Memory Bank path change or a storage-mode change take effect within the session. Without it, initialization's single-shot guard meant the attach never re-ran and reads kept coming from the previously attached folder.

### Every read, step by step

Every shape followed the same sequence:

1. **Test the out-of-sync marker.** If present, decline immediately — no path built and no file touched.
2. Build the target path from the caller-supplied key inside the shape's own directory.
3. **Apply the containment guard** (below). Decline if it refused.
4. Require the target to be a regular file. Decline otherwise.
5. Read it.

Then, per shape:

- **Parsed record.** Decode the text into a memory record. Decline when the decode yielded nothing at all, and decline when the decoded record's identifying commit field was blank. The second check was not redundant: the decoder can populate a record by bypassing construction, so a structurally-empty document decoded "successfully" into a record whose required fields were absent at runtime — an outcome that would otherwise have been handed to callers as a valid answer and would have shadowed the ref. An explicitly empty identifier was the same failure one transformation upstream. Any thrown failure during this step was logged at **debug** (naming a truncated form of the key) and declined.
- **Raw bytes, plan body, note body, reference body.** Returned the file's exact text with **no schema check of any kind**. Any thrown failure declined with **no log line at all**.

The reference shape differed from the other shapes only in steps 2 and 3. Step 2 was two-level — a per-source subdirectory under the references directory, then the derived stem inside it — and step 3 was correspondingly **doubled**: the source subdirectory had to be contained within the references directory, *and* the target file had to be contained within that subdirectory. The first of those two checks was defence-in-depth against a hostile or malformed source name reaching disk; the sanitize that produced the stem already stripped path separators, so neither check was expected to fire on real input.

Every decline reached the caller as "no answer", and the caller read the same item from the canonical ref instead. **Nothing surfaced to the user on any of these paths** — not a missing file, not an unreadable file, not a missing root, not a missing configuration record, not a mid-session mode flip. Every one of them was a silent fallback.

### The marker was re-read per read, not per attach

The marker test was a fresh filesystem probe on every call. A marker that appeared mid-session therefore took effect on the very next read, and one that was cleared re-enabled the mirror on the next read — both directions pinned by a test that toggled the marker under a live accessor.

This was deliberately stricter than the eligibility checks: mode and root were evaluated once per attach, the marker on every read.

### Containment guard

Before any read, the target path and its intended parent directory were both canonicalized, and the target was required to begin with the parent plus a path separator. Any thrown failure during canonicalization refused.

The guard existed because every shape built its path from a caller-supplied name, and a name carrying parent-directory traversal or an absolute-path form would otherwise compose a path outside the intended directory. Because canonicalization resolves symbolic links, a link *inside* the directory that pointed outside it was refused as well. Refusing cost nothing, because the ref fallback could serve the same item and was not reachable by path composition.

**No test exercised this guard.** Its correctness rested on inspection only.

### Reads that never used the mirror

Three read families had no shape here and always resolved against the canonical ref:

- Enumerating the repository's memory documents (the memory list).
- Reading a stored transcript.
- Rendering a committed conversation from a stored transcript.

The writer side's own lockstep note named the same coupled set this accessor implemented: the per-commit memory documents, the plan bodies, the note bodies, the archived external-reference bodies, and the out-of-sync marker.

### The lockstep obligation, as it stood

Because this accessor parsed the writer's on-disk documents in a different language, the writer could not change them unilaterally. What was coupled was exactly what was consumed:

- The read locations (their folder names and file-naming rules), including the reference shape's two-level layout and the stem-derivation rule that produced its filename — the strongest of these couplings, because it was a *computed* name rather than a caller-supplied one, and a drift in the sanitize rule silently returned nothing for every archived reference rather than failing loudly (spec 317).
- The out-of-sync marker's location and its presence-means-degraded semantics.
- The schema of the one document shape that was parsed (the per-commit memory document). The byte-returning shapes were opaque to this accessor and carried no schema coupling.

**The mirror's hidden aggregate index was not consumed here.** This accessor had no discovery path at all — every read arrived with a key the caller had obtained elsewhere — so the index's schema could evolve without touching this reader.

### Divergences from the canonical read-side resolution

The other hosts pick a read backend through a shared resolution that this accessor deliberately did not reuse. Five differences, all observable at the time:

| Aspect | Canonical read-side resolution | This accessor |
|---|---|---|
| Readiness probe | a successful read of the mirror's aggregate index | the per-commit document **directory exists** |
| Unrecognised storage-mode value | degraded to ref-only, so a configuration typo could not split the storage layer | treated as mirror-eligible; only the exact ref-only value declined |
| Write boundary | consulted, degrading to ref-only when the working directory may not claim a folder | not consulted at all |
| Out-of-sync marker | evaluated once, when the backend was resolved | evaluated on **every read** (stricter) |
| When mode and root were re-evaluated | on each resolution, with the host caching the result and dropping that cache on a settings save | once per attach; a mode or root change made anywhere other than this IDE's own settings surface was not observed until the next attach |

A sixth difference — this IDE resolving the mirror's parent folder from its own configuration key while the canonical write path used another — had already been closed before the retirement, by the key alias owned by spec 318.

### Notable behavior (as it stood)

- **A cached memory read could outlive every degradation check the accessor made.** The host consulted its bounded map before the read source, so while an entry was cached the mirror was not consulted at all — neither its marker test nor its file probes. A mirror that went out of sync mid-session could keep being served from cache until the next wholesale invalidation.
- **Invalidation was deliberately total, not targeted.** The call sites that change a memory often cannot say which identifiers are affected, and a targeted removal would have stranded the sibling entry written under a resolved alias identifier. Over-invalidation cost one lazy re-read.
- **Nothing told the user that reads had degraded.** Both the readiness state and the out-of-sync state were exposed as queryable predicates, and no production code outside the accessor called either. The only record that an attach declined was one line in the initialization log; a marker appearing mid-session was recorded nowhere.
- **Every shape but the parsed-record one failed completely silently.** Only the parsed-record shape logged (at debug) when a read threw.
- **The reference shape's key was the only one the accessor transformed before use.** That made it the only shape where the accessor could look in the *wrong place* while behaving correctly — and because a miss was indistinguishable from an absent file, a stem-rule drift degraded every archived reference to the ref fallback with no signal at all (spec 317).
- **An unrecognised storage-mode value was treated as mirror-eligible here and as ref-only everywhere else.** A configuration typo therefore had opposite effects on the two surfaces. This divergence was asserted nowhere.
- **The stated motivation for this path named the cross-process bridge, but the path it actually replaced was a local git subprocess.** The reads it served fell back to reading a blob out of the canonical ref through the plugin's own native git wrapper (126) — a process fork, not a bridge round-trip. Only the *attach* touched the bridge, and it added calls rather than removing them.
- **Attaching after the migration step was not incidental ordering.** The readiness probe tested a directory that folder initialization does not create, so an attach placed before migration would have declined on every fresh install and stuck for the session.
- **The eligibility gate was evaluated once per attach, so a change made outside this IDE went unobserved.**
- **The containment guard had no test.**
- **Locating the read source mutated the filesystem.** The claiming root resolution could create and claim a per-repository folder, so the act of setting up a read-only fast path was itself a write.
- **The marker's presence was the whole contract, and that was a defence, not a shortcut.** The body was never parsed, so a truncated or corrupt marker still gated reads.

### Unreachable paths (as they stood)

- The readiness and out-of-sync predicates were publicly exposed but had no production caller outside the accessor. Both were reachable from tests, and neither from any surface that could report degradation to the user — which was the mechanism by which the degradation stayed invisible.

## Shared Behavior

- **IntelliJ Native Memory Bank Metadata Read (314)** — the sibling native reader that **survives** this retirement. Different accessor, different question: two aggregate documents for the Memory Bank tree's hot path, read-only, with no out-of-sync gate. Do not read this retirement as covering it.
- **CLI IDE-Bridge Command Surface (287)** and **IntelliJ CLI Daemon Connection (288)** — the action dispatch and the connection that now carry every one of the reads this accessor used to serve, including the batched list-then-read flows.
- **Storage routing (344)** — decides which backend the bridge's storage action serves. The host resolves nothing itself; it inherits that answer.
- **Memory Bank Folder Layout (151)** and **Folder-Based Summary Storage (02)** — still write the hidden layer exactly as before. What this retirement removed is a reader, not a writer, so the layout's two-language obligation inverted: it now covers the surviving sibling's two aggregate documents rather than the content directories and the marker. One coupling survived the move — the archived-reference stem rule is still re-implemented on that host, composing a bridge request path instead of a filesystem path.
- **Orphan Branch Summary Storage (01)** and **IntelliJ Native Git CLI Wrapper (126)** — owned the ref and the subprocess wrapper every decline here used to fall back to.
- **IntelliJ Project Service Lifecycle (124)** — performed the attach and owned the bounded single-memory cache. The attach is gone; the cache remains and is owned there.
- **IntelliJ Settings Surface (135)** — the one surface whose save re-pointed this read source. That re-attach no longer exists.
- **IntelliJ Archived-Reference Body Read (317)** — the reference shape's key pair, its wire-name prefix strip, its per-source subdirectory layout, and its stem-derivation rule. The read itself now goes through the bridge like every other shape.
- **IntelliJ Memory Bank Folder Setting Key Migration (318)** — owns the configuration-key alias that closed what this spec once recorded as a sixth divergence.
