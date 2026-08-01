# 250. IntelliJ Transcript Plan Discovery (Retired)

## Topic Statement

This topic previously described an IDE-side transcript scanner that, as a Claude session ran, discovered plan-mode slugs and markdown write/edit paths from new transcript lines and upserted them into the plan registry — driven from the IDE's own Claude stop hook, sharing a per-transcript cursor with reference discovery. **That scanner and the hook that drove it are gone from this surface.** Plans now enter the registry only through the command-line surface's own transcript discovery (spec 29). The IntelliJ surface **reads** the registry and renders it; it never writes a discovered plan row.

## Scope

**In scope:**
- Recording that no IDE code path discovers plans, scans transcripts for plan signals, or upserts plan rows.
- The surviving IDE relationship to the registry: a delegated read of the plans registry, plus a delegated read of the notes directory, both round-trips to the command-line surface.
- The historical supersession chain, kept as context: a directory scan of the on-disk plans folder was replaced by transcript discovery, and transcript discovery on this surface was in turn replaced by delegation.

**Out of scope:**
- The live plan-discovery semantics — signal classes, the incremental scan window, the external-candidate exclusion policy, note-ownership skip, archived-guard revive, unique-slug resolution, and the load-merge-save-under-lock persistence — owned by spec 29.
- Reference discovery's extraction and upsert — spec 153.
- Commit-time plan archival and progress evaluation, now owned entirely by the command-line post-commit pipeline.
- The plans-and-notes panel that renders the registry rows — spec 132.
- The registry file format and the cross-process lock primitive — owned by the session/registry storage topic.

## Data Contracts

There is no live discovery data contract on this surface. The IDE consumes the registry as a whole record and the notes directory as a path; neither is produced by IDE code.

The registry file and the plans lock are unchanged on disk — they are simply written by a different surface now. When the IDE does perform its own read-modify-write of the registry (a user editing or deleting a plan row from the panel), it acquires the same cross-process plans lock through the command-line surface, so it serializes against the command-line writers. A failed acquire is treated as "write without the lock".

## Behavior

### Current reality

- No transcript is scanned by IDE code for plan signals. There is no IDE-side Claude stop hook: the agent hooks installed in the user's repository are the command-line surface's, and they run under the command-line runtime.
- The plans registry is obtained by a delegated load; the notes directory by a delegated lookup. Archived plan and note bodies are still read natively from the orphan branch at display time.
- The panel therefore shows exactly the rows the command-line discovery wrote, plus whatever the user creates or edits through the panel itself.

### Retired behaviors

The following behaviors this topic used to describe are **no longer present** on this surface:

- Scanning transcript lines for plan-mode slug tokens and for Write/Edit markdown paths, and the JSON-decoding of the captured path.
- The incremental scan window (start line exclusive to end-of-file) and the furthest-line return value.
- The external-candidate exclusion policy (excluded path segments, non-plan basenames).
- The note-ownership skip, the archived-plan content-hash revive guard, and unique-slug resolution for basename collisions.
- The per-slug merge on save (sibling-archived wins whole, concurrent hard-delete wins).
- The stop-hook driver that ran plan and reference discovery from one shared cursor and advanced it to the maximum of the two furthest lines.

## State Transitions

None owned by this topic. Plan-row transitions are owned by spec 29.

## Notable Behavior

- **Two supersessions, not one.** The original design enumerated the on-disk plans folder and auto-registered every file found; that was replaced by transcript-driven discovery so a plan entered the registry only when a tracked session actually created or edited it. Transcript-driven discovery on *this* surface was then replaced by delegation — the rule survives, the IDE implementation does not.
- **The IDE is a pure consumer of discovered plans.** A plan appears in the IDE panel only after the command-line discovery has written it. Nothing the IDE does during a live session adds a plan row.
- **Reference discovery does not share a cursor or a branch-stamp rule on this surface.** The transcript reference-discovery and envelope-parsing source has been **removed** from this surface — it had no caller, and the source has now caught up with the behavior. What remains of the IDE's reference layer is the reference **types** (the source-id enum and its wire-name/path-key helpers), the source presentation table, and a per-reference markdown reader used to populate a hover popup (spec 179); nothing extracts a reference from a transcript here. The shared-cursor and branch-stamp behaviors are real, but only on the command-line surface (specs 29 and 153); asserting them as IDE behavior would be wrong.

## Shared Behavior

- Plan discovery, including the branch-stamp-omitted-on-unknown rule and all upsert semantics, is owned by spec 29.
- Reference discovery is owned by spec 153.
- The plans-and-notes panel that renders the registry, and the delegated registry/notes-directory reads it performs, are owned by spec 132.
- The registry file format and the cross-process plans lock are owned by the session/registry storage topic; the IDE takes that lock through the command-line surface for its own panel-driven writes.
