# Back-fill Cold-start Signal Queries

## Topic Statement

Provide the cheap, read-only queries a host (the VS Code extension, the Settings panel, or the CLI guided front door's cold-start offer) uses to decide whether to offer back-fill and what to list — without ever scanning transcripts, attributing, or calling the model. Three queries: does the repo have any memory at all, how many own commits lack a memory, and which own commits lack a memory (windowed, newest-first, capped). A third consumer, the IntelliJ plugin, reaches these same queries out-of-process — through the CLI's `--list-candidates` mode (cross-ref 214) and its `--hashes`-plus-dry-run preview flow — rather than the in-process calls VS Code makes.

## Scope

**In scope:**
- The has-any-memory query and why it is deliberately not branch-scoped.
- The count-missing query and its `{missing, total}` shape.
- The list-missing query: the own-author filter, the newest-relative time window, the cap, and the row shape.

**Out of scope (boundaries):**
- Generating any memory or calling the model — these queries never do (that is **Back-fill Engine Orchestration**).
- The own-author filter internals (email OR name, fixed-string) — defined in **Back-fill Engine Orchestration**; used here identically.
- How a host consumes the signals to render a card (owned by **VS Code Cold-start Back-fill Card**) or drive the CLI front door's interactive offer (owned by **Guided Front Door**).

## Data Contracts

### Has-any-memory

A boolean: true when the repo's memory index (the orphan-branch system of record) is non-empty on **any** branch. A single index read; no transcript scan, no model call.

### Count-missing

`{ missing, total }` over all own-authored commits reachable from `HEAD`: `total` is the number of own commits, `missing` is how many of them are absent from the memory index. Index membership only — no transcript scan, no model call.

### Missing-commit row

| Field | Type | Notes |
|-------|------|-------|
| commit hash | string | |
| subject | string | first line of the commit message |
| author time | epoch ms | used for newest-first ordering and relative-date display |

### List-missing parameters

- Optional **window** (a millisecond span): keep only commits authored within the window.
- Optional **limit**: cap to the newest N rows.

## Behavior

### Has-any-memory

Read the memory index and return whether it holds any entry. **Deliberately not branch-scoped:** a returning user on a fresh branch of a repo that already has memories is *not* in cold start, so the query asks about the whole repo, not the current branch.

### Count-missing

List own-authored commits reachable from `HEAD`, read the memory index once, and count how many listed commits are not in the index. Returns both the missing count and the total.

### List-missing

1. List own-authored commits reachable from `HEAD` with their subject and author time (own-author filter = email OR name, fixed-string; no filter when no identity is configured). A commit whose subject contains the field separator cannot corrupt parsing (a NUL separator is used).
2. Determine the **newest** own commit's author time from the listed rows.
3. **Window filter (when a window is given):** keep only rows whose author time is `≥ newest − window`. The window is measured relative to the newest own commit, **not** wall-clock — so the boundary is deterministic and testable without a clock. (The newest row always satisfies any non-negative window, so a non-empty list never windows down to empty.)
4. Drop rows already present in the memory index (index membership only — no transcript scan).
5. **Cap (when a limit > 0 is given):** return the newest `limit` rows (rows are already newest-first).

## State Transitions

All three are pure read queries; they mutate nothing. Their answers change only as a side effect of memories being written elsewhere (e.g. by a back-fill run or the live pipeline).

## Notable Behavior

- **Never generates or calls the model.** All three are git + index reads only — cheap enough to run on every host activation / panel open. (Notable.)
- **Has-any-memory is whole-repo, not branch-scoped** — intentionally, so cold-start is a per-repo notion. (Surprising; intentional.)
- **The list-missing window is anchored to the newest own commit, not wall-clock**, for deterministic, testable boundaries. (Notable.)
- **All three are own-author scoped** (except has-any-memory, which is a pure index read with no commit listing): others' commits never have local transcripts, so counting them as "missing" would be misleading. (Notable.)
- **Count-missing and list-missing can disagree in absolute terms**: count-missing spans all own commits, while the cold-start list-missing call is windowed and capped — the host uses count-missing for the "manage all" total and list-missing for the offered rows.

## Unreachable / Not-live

None.

## Shared Behavior

- The own-author filter (email OR name, fixed-string matching) is defined in **Back-fill Engine Orchestration** and reused unchanged.
- The memory index read is the product-wide index over the orphan-branch system of record.
- The window span and cap the VS Code cold-start card passes are defined in **VS Code Cold-start Back-fill Card**.
