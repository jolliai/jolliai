# OpenAPI Tag/OperationId Collision Detection

## Topic Statement

Detect during the spec walk that two operations would map to the same `(slugified-tag, operationId)` slot — and therefore the same per-endpoint output page — and abort the build with an error naming both colliding operations rather than silently overwrite one of them.

## Scope

In scope: maintaining a per-walk reservation table keyed by `(slugified-tag, operationId)`; rejecting the second insertion under an already-claimed slot with a hard error that names both colliding operations' methods and paths and the conflicting tag and operationId; treating untagged operations as belonging to a synthetic default tag bucket so their slots are still reservation-checked.

Out of scope: any kind of "fuzzy" deduplication (operations whose summaries happen to match); cross-spec collision detection (two specs in the same content tree may legitimately use the same tag/operationId pair because each spec lives in its own folder); offering an opt-in "first-wins" or "last-wins" mode; auto-renaming colliding operationIds.

## Data Contracts

The reservation key is the string `"{slugified-tag}/{operationId}"`. The slugifier is the same one used to derive folder names downstream, so the key matches the eventual filesystem layout exactly: two operations whose tags differ only by case or punctuation can still collide if they slugify to the same value.

The reservation value records the first claimant: `{ method, path }`. When a collision is detected, the error message includes:
- The first operation's method (uppercased) and path.
- The second operation's method (uppercased) and path.
- The conflicting tag (the original tag string, not the slugified form).
- The conflicting operationId.
- A remediation hint: "Disambiguate by giving each operation a unique operationId or by assigning them to different tags."

The synthetic default tag for untagged operations is the string `default`. Operations explicitly tagged `"default"` and operations with no tags share the same bucket — they will collide if their operationIds match.

## Behavior

Collision detection runs inline with the operation walk. As each operation is built, the parser computes its primary tag (first entry of the `tags` array, or `default` when none is declared) and its operationId (supplied or synthesized). The pair is slugified into the reservation key and looked up in the table.

When the slot is unclaimed, the operation is recorded as the claimant and emission proceeds.

When the slot is already claimed, the parser throws an error. The error message names both operations with method-uppercased path strings, restates the conflicting tag and operationId, and suggests the two ways to disambiguate. The walk does not continue — the rest of the spec is unparsed for the build.

The reservation table is local to a single spec's parse — distinct specs have independent reservation tables, so two specs in the same content tree can each have an operation tagged `Pets` with operationId `listPets` without colliding.

## State Transitions

Per-spec reservation table lifecycle:
- **Empty** — at the start of `walkOperations`.
- **Populated** — after each successful operation insertion.
- **Aborted** — after the first collision (error thrown, no further insertions).
- **Returned** — after the last operation is inserted with no collisions; the table is discarded once the operations array is returned.

The table is in-memory only and never persisted between builds.

## Notable Behavior

The collision is considered a hard error rather than a warning because the alternative — silently overwriting the per-endpoint output of one operation with another — produces a build that looks successful but quietly ships an incomplete reference. A loud abort is judged the safer default; the spec author can fix it once and move on.

Slug-collision is what is actually checked, not raw-string collision. Two tags whose original strings differ but slugify to the same value (e.g. `User Management` and `user-management`) are treated as the same bucket — this matches how the renderer addresses them on disk and in URLs, and a "false positive" here is in fact a real on-disk collision.

Untagged operations all land in the same `default` bucket. If a spec has two untagged operations with the same operationId, this is reported as a `(tag="default", operationId="…")` collision in the error. The remediation is the same as for any other collision: tag them differently or rename one operationId.

The error message includes both colliding operations' method+path so the spec author does not need to grep — the build output is enough to locate both. The conflicting tag is reported in its original string form (not the slugified form) so the message reads naturally even when slugification was the cause of the collision.

The slugifier used here is the same one used by every downstream emitter for folder names, route segments, and `_meta` keys. If the slugifier changes, the collision rule shifts with it — by design.

## Shared Behavior

Collision detection is part of the spec parser stage; it runs only after detection has accepted the document and only as operations are walked.

The renderer relies on the post-parse invariant that every operation has a unique `(slugified-tag, operationId)` pair — both the per-endpoint MDX shim path and the per-operation JSON sidecar path are derived from this pair. Without the collision check, the renderer would either overwrite files or produce non-deterministic output depending on filesystem and walk order.

The synthetic `default` group is the same fallback used by the overview page emitter and the sidebar `_meta` emitter — one untagged group across all three.
