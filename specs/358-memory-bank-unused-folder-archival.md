# 358. Memory Bank Unused-Folder Archival Sweep

## Topic Statement

Archive every discovered Memory Bank folder that provably holds nothing, on a user-initiated folder-tree Refresh, under the per-vault write lock — which makes that Refresh the first one that mutates disk rather than merely re-reading it.

## Scope

**In scope:**
- The trigger: the desktop editor host's folder-tree Refresh, at the Memory Bank scope and at the everything scope, and the sweep's position ahead of the re-listing that makes the archived rows vanish on the same click.
- The candidate set: every folder the repository-discovery pass surfaces under the vault parent, and why folders it cannot see are out of reach by construction.
- The "provably empty" predicate, evaluated in order, and its keep-unless-proven-empty polarity at every step.
- The exemption for operating-system noise, its exact membership, and what it therefore fails to exempt.
- The two-part current-repository guard, what it protects, and the cross-project consequence it produces.
- The archive destination: where it sits, how it is named, why it is a move and never a deletion.
- The notification: when it appears, what it claims, and the reveal-in-file-browser action it offers.
- The per-vault write lock hold, its short wait budget, and the silently-skip-on-busy discipline — including the release-time obligation this holder does not discharge.
- The clean-repository memo invalidation performed only when at least one folder was archived.
- What the sweep deliberately does not consult: the manual-disable state, the folder's provenance, and the folder's name.
- The reach of the sweep across hosts.

**Out of scope (boundaries):**
- The duplicate-folder consolidation that runs immediately after this sweep on the same Refresh — a modal-confirmed merge of several folders that hold one repository into a single survivor. It shares this sweep's lock and its archive destination but is a different operation with the opposite busy discipline; it is covered by the Memory Bank duplicate-folder consolidation spec.
- The folder-tree listing itself: the relative-path protocol, lazy expansion, manifest-derived file classification, title derivation, and the divergence flag (covered by the editor Memory Bank folder-browser spec).
- The repository-discovery pass that decides which subdirectories under the vault parent are repositories, and how the current-repository flag is assigned (covered by the Memory Bank folder-layout spec).
- The layout of a repository folder's hidden metadata directory and the schemas of the documents inside it (covered by the Memory Bank folder-layout spec and the folder-based summary-storage spec).
- The per-vault write lock's own primitive: its ownership record, staleness ceiling, heartbeat, and release check (covered by the vault write-lock spec and the lock-primitive registry).
- The vault synchronization round that observes the archived folder's removal and propagates it to peers, and the path classifier that refuses to stage anything under the archive directory (covered by the sync-engine specs).
- The reconcile-and-heal pre-pass that runs on a listing inside a repository folder, and the per-session clean-repository memo it maintains. This sweep only drops the memo; it does not run the pre-pass.
- The folder-resolution path that claimed these folders in the first place, and the write boundary that now refuses to claim new ones (covered by the folder-layout and write-boundary specs).

## Data Contracts

### Candidate set

Every repository the discovery pass returns for the configured vault parent, each carrying its on-disk root, its recorded repository name, and a current-repository flag.

Discovery only yields a folder whose per-repository identity document is present and parseable. A user-dropped folder or file under the vault parent therefore never enters the candidate set, and neither does a folder whose identity document is missing or corrupt — the sweep cannot reach any of them, which is what keeps the user's own dropped content out of scope without a separate rule.

### Provable emptiness

A folder is provably empty only on positive evidence. Every step below resolves to "keep" when it cannot answer, so an unreadable directory, an unparseable document, or any name this predicate does not recognise preserves the folder.

The four conditions, all of which must hold:

1. **No top-level entry other than the hidden metadata directory.** A visible per-branch directory, a Markdown file, or an unrecognised dot-prefixed entry (a version-control directory the user initialised there, an editor workspace file) is content. Operating-system noise is exempt (below).
2. **Nothing inside the hidden metadata directory outside the inert allowlist.** The allowlist is two groups, not one: the three documents that seeding a fresh hidden layer writes — the per-repository identity document, the branch registry and the manifest — plus the two bookkeeping documents a claim can leave behind, the projected index and the migration-progress record. Neither of those last two is ever seeded, so "what seeding produces" is not the rule; it is the smaller half of it. Any other entry — a content subdirectory, a topic page, a quarantine directory, the per-device dirty marker — is content. Operating-system noise is exempt here too.
3. **Zero entries recorded in the projected index.**
4. **Zero rows recorded in the manifest.**

Two asymmetries inside those last two conditions are load-bearing and are not the same rule:

- A **missing or unparseable index reads as zero** — the permissive direction. It is only safe because a folder holding real memories also holds a content subdirectory for them, which condition 2 has already rejected; a corrupt index alone can therefore never make a populated folder look empty.
- A **manifest that exists but cannot be read or parsed yields a distinguishing sentinel** rather than zero, so the "exactly zero rows" test fails and the folder is kept. A manifest that is simply absent is a genuine zero (nothing was ever written).

**The per-device dirty marker counts as content and pins the folder.** That marker is written only from the failure path of a mirror write, so its presence means a write meant to land in this folder did not — which is precisely not the inert-empty shape this sweep targets.

### Operating-system noise

Exactly two names are exempted, matched case-insensitively at both the top level and inside the hidden metadata directory: the macOS per-directory metadata file and the Windows thumbnail cache. The rationale is that a single visit from a graphical file browser would otherwise pin a junk folder in the tree permanently, because the hidden-layer allowlist in condition 2 is strict.

The list is a literal pair, not a class of file. Every other piece of platform detritus — cloud-sync placeholder files, other desktop-metadata files, resource-fork stubs, and the index directories some search and sync tools drop into any folder they touch — is unrecognised, therefore content, therefore a permanent pin on a folder that holds no memories.

### Current-repository guard

Two independent tests, either of which keeps a folder:

1. The discovery pass's current-repository flag is set for it.
2. The host reports a current repository name and the folder's **recorded repository name** (its directory name when it records none) equals it.

The second test is **not** what covers a transport or host-alias difference, though a stale comment in this area says so. The discovery flag's own matcher already folds every SSH, git-protocol and SCP-form remote to its HTTPS form and passes the host token through the user's alias configuration, and it falls back to a name comparison whenever *either* side records no remote — so the shape that spawned the duplicate empty folder in the first place is already matched by test 1.

What test 2 still covers is narrower: both sides record a remote, the two do **not** fold equal — alias resolution unavailable on this machine, a fork, a remote re-pointed since the folder was claimed — and the recorded name nevertheless matches. Keeping those folders is what stops the sweep from archiving something this session might be about to write into.

Neither test consults the recorded remote of a *non*-current project. A folder is either the current project's or a candidate.

### Archive destination

A directory **nested inside the vault parent's own dot-prefixed hidden directory**, not a sibling of it. Each archived folder lands in its own child directory named for the folder's basename plus a millisecond timestamp; a collision counter is appended when two archives of the same name land in the same millisecond.

The move is a filesystem rename — the entire tree moves at once — and is never a deletion. Placement under the vault parent means archives travel with a re-pointed vault location and stay on one filesystem so the rename is atomic. The dot-prefixed ancestor segment is what hides the archive from both editor folder views and from the vault sync classifier.

A folder that does not exist, or whose rename fails, yields no destination; the sweep records nothing for it and continues.

### Result

The list of folder paths that were archived. An empty list means either that nothing was provably empty **or** that the vault was busy — the two are indistinguishable to the caller.

## Behavior

### Trigger and ordering

1. The user clicks Refresh on the folder tree, at the Memory Bank scope or the everything scope.
2. The sweep runs first, so one click both trims the tree and re-reads it.
3. The duplicate-folder consolidation runs next (boundary).
4. The root listing is re-fetched, which is what makes the archived rows disappear on that same click.
5. The repository and branch pickers are re-pushed, so an archived repository stops being offered — selecting one would otherwise resolve to nothing and silently do nothing until the window is reloaded.

Any error thrown by the sweep is logged and swallowed: the sweep is best-effort and recoverable, so a locked directory or a permission denial must not cost the user the re-listing they actually asked for.

### The sweep

Held for its whole duration under the per-vault write lock keyed on the canonical vault parent (see below).

1. Run the repository-discovery pass for the configured vault parent with the current project's identity.
2. For each discovered repository, in discovery order:
   - Skip it if either half of the current-repository guard matches.
   - Skip it if it is not provably empty.
   - Otherwise move it into the archive directory. Record it only when the move produced a destination.
3. If at least one folder was archived, clear the whole per-session clean-repository memo, so the next listing re-arms the reconcile-and-heal pre-pass for every repository rather than short-circuiting past it.
4. Return the recorded list.

### Lock hold and busy discipline

The vault parent is also the vault's own version-controlled working tree, so each rename is simultaneously an unlocked working-tree mutation and an implicit staged removal of the folder's tracked aggregate documents. Two consequences are handled here rather than left implicit:

- **It must not race a concurrent vault writer** — a queue worker mid-drain, a synchronization round that has already snapshotted the working tree's status, a compile pass. The whole sweep therefore runs under the same per-vault write lock, keyed on the same canonical vault parent, that those writers take.
- **The staged removal propagates to peers, and that is correct rather than data loss.** A synchronized vault holds identical content on every peer, so a folder empty here is empty there too, and the folder-resolution path re-claims it on the next write on whichever device the repository becomes active again.

The lock is taken with the **short** wait budget — ten seconds, the same one a synchronization round uses when it wants to yield to a busy writer rather than wait through a whole model-bearing drain — and polled at a fixed short interval. While the lock is held its modification time is heartbeated so the staleness reclaimer cannot steal it.

**When the lock is busy for the whole budget the sweep is silently skipped and reports nothing archived.** No message reaches the user; the next Refresh retries. This is deliberately the opposite discipline from the consolidation that follows on the same click, which surfaces a busy vault to the user because the user explicitly asked for that merge.

### Notification

Shown only when at least one folder was archived. A Refresh that found nothing must not nag.

The message states the count, that the folders held no memories, and that the move is recoverable, with singular and plural wording chosen from the count. It offers one action, to reveal the archive directory in the operating system's file browser — so "recoverable" is an action the user can take rather than a claim about a hidden directory they would never find. The action is offered only when the archive location is available to the notification builder; by the time the notification fires the directory certainly exists, because the sweep just moved a folder into it.

## State Transitions

For any single discovered Memory Bank folder, across one Refresh:

| From | Condition | To |
| --- | --- | --- |
| Live | Current-repository guard matches (either half) | Live (skipped) |
| Live | Not provably empty | Live (skipped) |
| Live | Any emptiness step cannot answer (unreadable directory, unparseable manifest) | Live (kept on the conservative branch) |
| Live | Provably empty, not the current repository, move succeeds | Archived (recoverable) |
| Live | Provably empty, move fails or the folder vanished mid-scan | Live (nothing recorded, sweep continues) |
| Live | Vault lock busy for the whole budget | Live (whole sweep skipped, silently) |
| Archived | The repository becomes active again and a write lands | A folder at the same path is re-claimed from scratch; the archived copy stays where it is |

The sweep holds no state of its own between Refreshes. Its only durable effects are the moved directories and, when at least one moved, the cleared clean-repository memo.

## Notable Behavior

- **This Refresh now mutates disk.** Before this sweep existed, the folder-tree Refresh was a pure re-read: it discovered, listed, and enriched, and the worst it could do was regenerate a visible file from its own hidden source. It now moves directories. Anyone reasoning about the Refresh button as a safe read is reasoning about a previous behavior. (Notable; the single most important thing to know about the surface.)
- **Emptiness is the whole test, and that is a deliberate refusal to guess from names.** The folders this sweep exists to clear were claimed by processes running outside a real project and are named after whatever working directory those processes happened to have — a system directory, a temporary directory, an agent's scratch directory, a document title a model-run used as its working directory. Classifying junk by *name* would eventually archive somebody's legitimately-named repository, and a populated folder named after a system directory means the user really does keep memories for a project by that name. Emptiness cannot lose memories: archiving is a move, and an empty folder has nothing to move. (Notable.)
- **The dirty marker pins a folder here, and the consolidation merge never carries it over.** Treating the marker as content is the conservative choice at this seam — its presence means a write that was meant to land in this folder failed. But the sibling consolidation operation, which runs on the same click and folds several folders into one, excludes that same marker from both its file copy and its metadata union, so a marker in a folder being drained is simply dropped. The two halves of one Refresh treat the same file oppositely. (Surprising; documented as the behavior, not reconciled.)
- **The operating-system-noise exemption covers two literal filenames, so most platform detritus permanently pins a junk folder.** The hidden-layer allowlist is strict by design, and anything it does not recognise is content — which means a cloud-sync placeholder, a resource-fork stub, another desktop-metadata file, or a search-index directory dropped by a background tool is enough to keep an empty folder in the tree forever, on every Refresh, with nothing anywhere reporting why. The exemption pair was chosen from the two names observed in practice, not derived from a class. (Surprising.)
- **A provably-empty folder belonging to a different project open in another window is archived out from under it.** The guard protects only the *current* project's folders. A second editor window on a different repository — one freshly enabled, or one whose first commit has not landed yet — has a legitimately empty folder, and this sweep archives it. The other project is not broken by this: its folder-resolution path re-claims a folder at the same path on its next write. But the row disappears from that window's tree until then, and nothing tells either window what happened. (Surprising; the direct consequence of scoping the guard to one project.)
- **The second half of the current-repository guard covers much less than the transport-and-alias story attached to it.** The discovery flag's matcher already folds every SSH, git-protocol and SCP-form remote to HTTPS and resolves the host token through the user's alias configuration, and it already name-matches whenever either side records no remote — so a folder spelling the current remote through an alias is caught by the flag, not by the name test. The name test's residual coverage is the case where both remotes are present and do not fold equal (alias resolution unavailable, a fork, a re-pointed remote) while the recorded names happen to match. Its cost is unchanged: a genuinely unrelated repository's folder is kept whenever the two share a name. (Notable; the rationale carried in the code comment predates the alias folding and is no longer the reason.)
- **The sweep does not consult the manual-disable state.** Sibling operations on the very same surface do: the reconcile-and-heal pre-pass on a listing is suppressed for a repository the user turned off, and the migrate action is refused outright. This sweep is not gated at all, so a Refresh in a disabled project still archives folders and still writes into the archive directory. (Surprising; an ungated write on a surface whose neighbours are gated.)
- **The sweep has no notion of provenance.** It cannot distinguish a folder a past defect claimed from one the user created legitimately moments ago by opening an unrelated checkout once. Both are provably empty and both are archived. The intended reading is that an empty folder is pure noise either way and returns the moment it earns content — but it means a folder can disappear on the first Refresh after the user did nothing wrong. (Notable.)
- **A busy vault and an empty vault are the same answer to the caller.** The sweep returns an empty list for both "nothing was provably empty" and "the lock was held for the whole budget", and the notification is suppressed on an empty list, so a skipped sweep is indistinguishable from a clean one from outside. This is what makes the skip silent. (Notable.)
- **The busy discipline is deliberately opposite to the consolidation's.** Both run on one click and take the same lock with the same budget. The sweep skips silently because the user asked for a Refresh, not for a sweep; the consolidation reports the busy vault and tells the user to click Refresh again shortly, because a merge the user explicitly confirmed must not look like it did nothing. One lock, one budget, two disciplines. (Notable.)
- **This holder does not discharge the lock's release-time obligation.** Three holders pass the release-time hook that drains the cross-repository pending-worker registry when the lock frees, so a queue worker that timed out waiting for the vault and recorded itself there is re-spawned: the queue worker's per-write ingest guard, the single-target compile, and the multi-repository compile sweep. This sweep passes none, and neither does the consolidation, so a worker stranded in that registry stays stranded across both of them until its own repository's next commit spawns a fresh worker. Note that "every other holder drains on release" is *not* the right contrast: the queue worker's own summary drain never uses the body-style helper and drains the registry itself immediately after releasing, and the reconciliation round supplies nothing to this lock and drains at the end of a round rather than at lock release. (Surprising; the gap is an omitted argument, not a decision recorded anywhere.)
- **Only the desktop editor host performs this sweep.** The other IDE integration's Memory Bank explorer has neither this sweep nor the consolidation, so a user of that host sees the junk folders accumulate with no way to clear them from inside the product. Its Memory Bank refresh is **not** read-only, though: it reconciles the current repository's manifest against disk (writing it when a recorded path has moved) and its tree build regenerates missing human-readable copies. Neither of those moves or merges a folder. (Notable.)
- **Folders without a readable identity document are unreachable, not exempt.** They never enter the candidate set because discovery does not surface them, which happens to be the right outcome for user-dropped content — but it also means a repository folder whose identity document became corrupt is invisible to this sweep no matter how empty it is. (Notable.)
- **A failed move is not distinguished from a folder that never needed moving.** Both produce no recorded entry and no message. A folder held open by another process is simply retried on the next Refresh, indefinitely. (Notable.)
- **Clearing the clean-repository memo is conditional on having archived something.** A sweep that archived nothing leaves the memo intact, so a repository previously observed clean still short-circuits past the reconcile-and-heal pre-pass on the following listing. The memo is dropped separately by the broader refresh triggers; this step only covers the case where the sweep itself changed the directory. (Notable.)

## Shared Behavior

- **The per-vault write lock** — its identity derived from a canonicalization of the vault root, its acquisition modes and wait budgets, its modification-time heartbeat, its ownership-checked release, and the cross-repository pending-worker registry drained on release — is defined by the vault write-lock spec, and its position in the product's lock catalogue by the lock-primitive registry. This spec owns only which budget this holder asks for, its busy discipline, and the release hook it omits.
- **Repository discovery under the vault parent**, the identity document that makes a subdirectory a repository, the current-repository flag's matcher — remote-preferring, but transport- and alias-folding, and falling back to a name comparison whenever either side records no remote — and the numeric-suffix ladder that produced the duplicate folders in the first place are defined by the Memory Bank folder-layout spec and the repository-identity-and-folder-naming spec.
- **The hidden metadata directory's layout** — which aggregate documents a fresh hidden layer is seeded with, the content subdirectories, the quarantine directories, and the per-device dirty marker's meaning — is defined by the Memory Bank folder-layout spec. This spec owns only which of those names the emptiness predicate treats as inert.
- **The manifest's and projected index's schemas**, and the read semantics that distinguish an absent document from an unreadable one, are defined by the folder-based summary-storage spec.
- **The archive directory** — its location inside the vault parent, its timestamped naming, its collision counter, and why archiving is a move rather than an identity rewrite — is shared with the migration engine's rebuild path, which archives every folder for a repository before re-migrating. Defined by the Memory Bank migration-engine spec.
- **The duplicate-folder consolidation** that runs immediately after this sweep on the same Refresh is defined by the Memory Bank duplicate-folder consolidation spec.
- **The folder-tree listing, the relative-path protocol, and the per-session clean-repository memo** this sweep invalidates are defined by the editor Memory Bank folder-browser spec.
- **The vault synchronization round** that observes the archived folder's removal, the path classifier that refuses to stage anything under a dot-prefixed segment, and the conflict resolution that bounds an unpushed peer write are defined by the sync-engine specs.
- **The manual-disable state** this sweep does not consult is defined by the durable repository opt-out spec and the zero-write contract spec.
