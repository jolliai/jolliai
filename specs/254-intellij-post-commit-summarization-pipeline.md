# 254. IntelliJ Post-Commit Summarization Pipeline (Retired)

## Topic Statement

This topic previously described a native per-commit conversational summarization pipeline owned by the IDE plugin — dispatched for each queued plain-commit / cherry-pick / revert operation by the plugin's own drain worker. It discovered AI sessions on demand, read their transcripts against the commit's own change, generated a structured summary via the model, computed and wrote conversation token usage and estimated cost, archived uncommitted plans / notes / references into the committed memory, discarded the working rows the user had unchecked, and stored the result. That pipeline no longer exists on this surface. Both the queue that dispatched it (spec 248, also retired) and the pipeline itself were removed; the IDE surface now has no per-commit capture code of its own.

## Scope

**In scope:**
- Recording that the IDE-native per-commit pipeline — on-demand multi-agent session discovery, per-source first-seen telemetry, the read-every-session/drop-the-unchecked discard rule, own-commit diffing, branch-scoped reference-block assembly, conversation-usage computation and pricing, plan / note / reference archival with progress evaluation, the finalize-after-store guard, and the unchecked-row discard pass — has been removed from the plugin.
- The supersession relationship: an IDE commit is now captured by the command-line surface's own hook, queue worker, and per-commit pipeline, and the fields downstream IDE surfaces display are written there.

**Out of scope:**
- The surviving per-commit pipeline and everything it does — owned by the CLI-side summarization specs (transcript attribution by cutoff, multi-topic summary generation, plan and note archival on commit, and commit-pipeline conversation token attribution).
- The retired IDE queue that dispatched this pipeline — spec 248.
- The install step that delegates hook installation to the command-line surface — spec 128.
- The IDE surfaces that *read* the fields the surviving pipeline writes — specs 123, 120, 251.

## Data Contracts

There is no live data contract for this topic. The plugin defines no session-discovery gate set, no diff-target rule, no early-exit guard set, and no conversation-usage computation. The conversation-usage fields (scalar token total, three-way input/output/cache-write breakdown, per-model buckets, estimated cost, price-table date stamp) are still the single write-time source of truth for every downstream display — but they are written by the command-line pipeline, against its own contract.

## Behavior

### Current reality

A commit made from the IDE fires the command-line surface's `post-commit` hook, which enqueues one entry and spawns the command-line queue worker. That worker runs the command-line per-commit pipeline: it discovers sessions across every supported agent source, reads transcripts against the commit's own change, calls the model, computes and prices conversation usage, archives pending plans / notes / references, stores the summary, and discards the unchecked working rows. The plugin's only contribution to that path is the one-shot marker recording that the commit came from this surface — and that marker is itself written through the command-line surface.

The plugin still *reads* everything the pipeline produced, and the two pre-commit markers the Squash action needs (plugin-source and squash-pending) are written through the command-line surface as well.

### Retired behaviors

The following behaviors this topic used to describe are **no longer present** on this surface:

- The in-plugin dispatch of plain-commit / cherry-pick / revert kinds into a native pipeline.
- Native on-demand session discovery for the hookless sources, and the per-source first-seen telemetry event fired as sessions were read.
- The native "read every session, advance every cursor, drop the unchecked entries" discard rule.
- Native diffing of the operation's own recorded hash (with the empty-tree fallback for a root commit) and the native early-exit guards.
- Native branch-scoped reference-block assembly for the prompt.
- Native conversation-usage aggregation, per-model bucketing, price-table lookup, and the price-stamp-only-when-priced rule.
- Native plan / note / reference archival, the lightweight plan-progress model call, the store-then-finalize ordering, and the updated-at / already-committed re-upsert guards.
- The native discard pass and its per-kind backing-file treatment (external plan file untouched, snippet file deleted, reference markdown deleted).

## State Transitions

None. This topic has no live surface. The conversation and working-item lifecycles it used to describe are now the command-line pipeline's.

## Notable Behavior

- **The behaviors survived; only the second implementation did not.** Every rule this topic described — one-time discard of unchecked conversations, cross-branch archival with a branch-scoped prompt, own-commit diffing, write-time-only usage computation, finalize-after-store — is still the product's behavior. It is now expressed once, in the command-line pipeline, rather than twice.
- **Conversation usage is still computed exactly once, at write time.** No IDE surface recomputes it. A memory generated before that computation existed still carries no usage fields, and IDE displays still treat their absence as "not reported" rather than zero.
- **The retirement of this pipeline is what makes the plugin's read path cost round-trips.** With no native capture code left, the fields the commits panel, the embedded summary viewer, and the branch-level Create-PR banner display are produced entirely outside the JVM and read back over the bridge or natively from the orphan branch.

## Shared Behavior

- **IntelliJ Git-Operation Queue (248, retired)** — the queue that used to dispatch this pipeline; also removed.
- **The surviving per-commit pipeline** — session discovery, transcript attribution by cutoff, structured-summary generation, plan and note archival on commit, and conversation token attribution are owned by their CLI-side specs; the IDE surface now consumes their output only.
- **IntelliJ Delegated Hook Installation (128)** — owns the install step whose delegated hooks route IDE commits into the surviving pipeline.
- **Downstream consumers.** The commits panel (123), the embedded summary viewer's token/cost banner (120), and the branch-level Create-PR banner (251) read and tree-aggregate the conversation-usage fields written by the **command-line** per-commit pipeline; none of them recompute usage themselves.
