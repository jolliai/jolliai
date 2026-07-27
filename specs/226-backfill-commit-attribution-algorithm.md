# Back-fill Commit Attribution Algorithm

## Topic Statement

Given the offline transcript signal records (grouped by session, time-ordered) and the offline commit target index, decide which historical commits each transcript slice belongs to, and with what confidence. The algorithm is pure and synchronous — no I/O, no model calls — and produces, per attributed commit, the conversation sessions and turn/entry counts a summarizer will consume plus a confidence tier and method.

## Scope

**In scope:**
- The per-commit attribution window (upper and lower bound).
- The "anchor" concept and how it derives a commit's effective worktree(s) and effective branch.
- The cursor that slices a shared session between neighbouring commits by ownership.
- The three confidence tiers and the minimum-tier filter.
- How a commit's rolled-up confidence is computed and why only conversational turns count.
- Session segmentation (branch change, idle gap).
- The two "unattributed" (skipped) outcomes and their causes.
- The output record per attributed commit.

**Out of scope (boundaries):**
- Producing the signal records (owned by **Back-fill Raw Transcript Scanning**).
- Building the commit index and the lower-bound query (owned by **Back-fill Commit Target Index**).
- Deciding the candidate set, running the model, storing summaries, and the diff-only fallback for unattributed commits (owned by **Back-fill Engine Orchestration**).

## Data Contracts

### Inputs

- **Candidates** — every candidate commit hash. This is a superset of the emitted set: already-summarized or out-of-range neighbours are passed in purely so they act as cursor boundaries.
- **Emit set** — the subset of candidates that should actually receive an attribution result. Defaults to all candidates.
- **Session grouping** — session id → time-ordered signal records.
- **Commit target index** — per-commit author time, real files, and the file/basename lookup maps.
- **Worktree roots** — the repo's worktree roots; each record's working directory is resolved to its longest-matching root as its **worktree identity** (not the transcript directory — a subdir launch must not split one worktree into several). When a working directory matches no root it is its own identity; an absent working directory yields the empty identity.
- **Minimum tier** — the weakest confidence tier to keep. Default **low**.

### Confidence tiers and methods

Weakest → strongest: **low** (time-window), **medium** (branch-match), **high** (file-overlap). Each tier maps to a method label of the same meaning (`time-window` / `branch-match` / `file-overlap`).

### Output

- **Attributed** — map of commit hash → attributed record:

  | Field | Notes |
  |-------|-------|
  | commit hash | |
  | confidence | the rolled-up tier |
  | method | the method label for that tier |
  | branch | the commit's effective branch (may be empty) |
  | sessions | per-session transcripts (only conversational turns), for the summarizer |
  | transcript-entries count | total conversational entries kept |
  | conversation-turns count | count of human-role entries kept |

- **Skipped** — the emitted hashes that earned no confident attribution.

## Behavior

### Per-commit window

For each candidate that is a real code target (present in the index with a non-empty file list):
- Upper bound `hi` = the commit's author time. A commit's conversation can only precede the commit.
- Lower bound `lo` = the target index's lower-bound query for this commit (the last time any of its files was previously committed), capped to a maximum look-back of 7 days.

An in-window entry is one whose numeric timestamp is present and satisfies `lo < t ≤ hi`.

### Session segmentation

Each session's time-ordered entries are split into work segments. A boundary is placed between consecutive entries when **either**:
- Both entries carry a known git branch and the branches differ (an unknown branch on either side does **not** split — early transcripts omit branch on some lines, and treating unknown as a new branch would shred a continuous run), **or**
- Both entries carry a parseable timestamp and the gap between them exceeds 2 hours (idle gap).

### File-touch test (anchor test)

An entry "touches" a commit's files when one of its edited-relative paths or edited-basenames matches one of the commit's files/basenames, comparing both sides through separator/case normalization. On case-insensitive filesystems this merges casing variants of the same file; on case-sensitive filesystems genuinely distinct names stay distinct.

### Phase 1 — effective worktree and effective branch

For every candidate commit:
1. Collect its **anchors**: in-window entries that touch its files. Each anchor's worktree identity is added to the commit's **effective worktree** set.
2. A commit with no anchor has an empty effective worktree and is not attributed (it will become a diff-only commit at the engine).
3. The **effective branch** is the modal git branch of the *anchor* entries (so main-branch chatter cannot out-vote the real feature work). If the anchors carry no branch, fall back to the modal branch of the whole in-window slice **within the effective worktree(s)**.

### Phase 2 — ownership cursor

Within each worktree identity, order the commits (whose effective worktree includes that identity) by author time ascending. An in-window entry located at time `t` is **owned by the earliest such commit whose author time is ≥ `t`**. This slices a long session that spans two commits into contiguous per-commit blocks; an already-summarized or out-of-range neighbour, present only as a candidate, still owns the entries before it and thereby truncates the emitted commit's window.

### Phase 3 — collect and tier (per emitted commit)

For each emitted hash whose effective worktree is non-empty, walk every session segment:
1. First pass over the segment: find the worktree identities that hold an **owned anchor** — an entry that is in-window, touches this commit's files, and whose ownership cursor resolves to *this* commit. (Scoping HIGH per worktree identity prevents a neighbour-owned edit, or an edit in a different worktree the segment spans, from inflating the tier.)
2. Second pass: for each in-window entry whose worktree is in the effective set and whose ownership cursor resolves to this commit, assign a tier:
   - **high** if its worktree had an owned anchor in this segment;
   - else **medium** if the entry's branch is known, the effective branch is known, and they are equal;
   - else **low**.
3. Drop entries below the minimum tier. Keep the rest.
4. While keeping, roll up the commit's confidence over **conversational turns only** (entries that have both role and content): note if any kept conversational turn was medium, or was low.

After the walk:
- If nothing was collected, the commit is **skipped**.
- Build per-session transcripts from the collected entries, keeping only conversational turns (entries lacking both content and role are dropped). If **no** session survives (all collected entries were non-conversational tool calls), the commit is **skipped** — even though it had anchors.
- The rolled-up confidence is the **weakest tier actually kept among conversational turns**: low if any low turn survived, else medium if any medium survived, else high (high is the implicit default when no weaker conversational turn appears).
- Emit the attributed record with that tier, its method label, the effective branch, the surviving sessions, and the entry/turn counts (turns = human-role entries).

### Session building for the summarizer

Collected entries are grouped by session id; only entries with both role and content are kept. Within a session they are ordered by line number, and each becomes a normalized turn `{ role, content, timestamp? }`. The session carries its id, the source tag, and the transcript path of its first surviving entry.

## State Transitions

Pure function: same inputs always produce the same output. No persisted state; the ownership cursor and windows are recomputed from scratch each call.

## Notable Behavior

- **A commit with anchors can still be unattributed** if every collected entry is a non-conversational tool call — anchors prove *where* work happened, but with zero human/assistant turns there is nothing to summarize, so the commit falls through to diff-only. (Surprising; intentional.)
- **Confidence never over-claims.** The commit-level tier is the *weakest* conversational turn kept, so a badge that says "high" means every kept human/assistant turn was file-overlap-anchored. (Notable.)
- **Tool-only entries never inflate the tier.** The roll-up ignores non-conversational entries even though they may be file-overlap anchors. (Notable.)
- **Effective branch is the modal branch of anchors, not of the whole window** — planning chatter on `main` cannot override the feature branch the edits happened on. (Notable.)
- **Unknown branch never splits a segment and never earns medium.** Medium requires both sides to have a known, equal branch. (Notable.)
- **Neighbour commits that are not emitted still truncate windows** via the ownership cursor, which is exactly why the caller passes a candidate superset. (Notable.)
- **Worktree identity is the longest matching root**, so nested worktrees/submodules resolve to the correct enclosing worktree, and a subdirectory launch does not fragment one worktree into many. (Notable.)
- **The window lower bound is capped at 7 days**, so a commit touching a long-dormant file does not vacuum up a week-plus of unrelated conversation. (Notable.)

## Unreachable / Not-live

- The ownership-cursor lookup contains two defensive fall-through returns (an empty result when the worktree has no commit list, and an empty result when no commit's time is at/after the entry) that are **unreachable in practice**: callers only ever query with a worktree that is in some commit's effective set and with an in-window entry, so the owning commit is always present with author time ≥ the entry time. They exist only as guards. (Unreachable.)

## Shared Behavior

- The per-commit lower-bound query and the 7-day look-back cap are shared with **Back-fill Commit Target Index**.
- The normalized turn shape (`{ role, content, timestamp? }`) is the product-wide transcript entry shape consumed by the summarizer.
- Separator/case path normalization is the product-wide convention.
- The engine's diff-only handling of skipped commits, the choice of candidate vs emit sets, and the default minimum tier are owned by **Back-fill Engine Orchestration**.
