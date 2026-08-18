# 27. Claude Session-Start Briefing

## Topic Statement

Produce a short, human-readable text briefing about the current branch's recent development history at the moment a new Claude Code session begins, by reading already-stored summary data and a local plans registry under a hard wall-clock deadline, and emit it on standard output so the host agent injects it into the new session's context.

## Scope

**In scope:**

- The triggering event and how the handler receives its inputs.
- The set of read sources consulted to compose the briefing.
- The conditions under which the handler emits nothing (skip rules).
- The shape and rough size of the emitted briefing text.
- The cache that prevents redundant work across rapid successive session starts.
- The hard deadline that bounds the composition, and what the deadline does **not** bound.
- The graceful-degradation behavior on any error or timeout.
- The repo-wide manual-disable gate read before composition.
- The **shared composition seam** this handler drives, its two independent inclusion switches, and the settings-installed handler's fixed choice of both.

**Out of scope (boundaries):**

- The schema of summary payloads, the index format, and the storage backend (covered by other specs).
- The on-disk shape of the plans registry (covered by spec 29 and the plans-registry spec).
- Generation of summary content (covered by the commit pipeline).
- The per-agent-stop session-recording handler (covered by spec 26).
- Any model call (this handler never invokes a model).
- Pushing summaries to a remote (covered by the publish/push specs).
- **The two plugin-surface reminders** (a "not signed in" reminder and a local-agent login-expiry reminder) and **the one-time plugin provider default**. Both used to be emitted/seeded by this handler; neither is any more. They are now driven exclusively by the agent-plugin's session bootstrap, which owns them and drives the same shared composer with the reminder switch turned on. This spec records only that the settings-installed handler structurally cannot produce them (see "Shared composition seam"). The reminders' own copy and detection logic remain owned by spec 286 and the credential-model specs.
- **When the briefing is emitted by the plugin bootstrap instead of by this handler.** The bootstrap suppresses the briefing whenever both canonical agent hooks were already healthy at its entry, precisely so this handler owns it in the steady state and the two paths never double-emit. That suppression rule is the bootstrap's, not this handler's.
- The credential-priority / `aiProvider` selection model that decides what counts as "credentialed" and the meaning of the `local-agent` provider (covered by spec 10 and spec 280).

## Data Contracts

### Triggering event

Fired by the host agent at the start of every new agent session. The host runs a configured external program; whatever the program writes to its standard output is consumed by the host as additional in-context content shown to the user and injected into the new session's prompt.

### Standard-input payload (JSON object)

The handler reads only one field from the payload:

| Field | Type   | Required | Notes                                    |
| ----- | ------ | -------- | ---------------------------------------- |
| `cwd` | string | optional | The host agent's working directory.      |

Other fields on the payload are ignored.

### Effective project root

The directory used as the project root is `cwd` from the payload when present, otherwise the runtime's current working directory — **anchored** to the git worktree root that encloses it, falling back to that value verbatim when no worktree encloses it (not a repository, or the version-control binary is unavailable).

Anchoring matters more here than on any other hook, because this handler joins the resolved root with the per-project state directory at three separate sites and one of them **creates** that directory: the login-reminder dismiss marker it probes, the plans registry it reads, and the briefing cache it reads and writes. The cache write creates the state directory recursively if it is absent, so before anchoring a session started in a subdirectory did not merely read from the wrong place — it materialized a real stray per-project store inside the checkout. The resolution rule itself, including its memoization and its silent tolerance of a non-repository path, is owned by spec 311.

### Inputs read while composing the briefing

- The current source-control branch name of the project root.
- The current source-control HEAD commit hash of the project root (used as the cache key).
- The summary-store index, filtered to entries on the current branch whose parent reference is null or absent (i.e. root-level entries only).
- Per the latest such root entry: its full summary payload, loaded directly from the summary store by commit hash.
- The local plans registry file under the project root.

### Briefing-cache record

A small per-project cache file, **single-slot per project**, keyed by:

- The branch name.
- The HEAD commit hash at the time the briefing was generated.
- **The identity of the agent-host surface that generated it.**

Plus the cached briefing text and an ISO timestamp of when it was generated.

The cache hit rule is exact equality on **all three**. The host identity is part of the key because the briefing ends with a host-specific hint naming how to ask for a fuller recall, and each host's form is inert in the others: keyed on branch and commit alone, whichever host started first would hand every other host a command it cannot run until the next commit rolled the key. A record written before this component existed carries no value for it, matches no live host, and therefore reads as a miss — one regenerated briefing per project, and no migration.

**The slot is single, so in a project used from two hosts they take turns evicting each other** rather than each keeping an entry. The host check makes that a miss-and-regenerate — correct but slower — instead of a hit on the wrong syntax.

**The write goes through a temporary file and a rename in the same directory**, because there are now **two** writers: this handler, and a warming pass the post-commit worker runs after a drain that produced new memories. That pass runs detached and can therefore land mid-read of a session starting at the same moment. A torn read degrades safely — the parse fails and the reader treats it as a miss — but "safely" there means silently doing the slow thing on exactly the commit that just warmed the cache, which is the case the warming exists for.

### Output

A plain-text payload written to standard output, intended to fit roughly within 300–500 model tokens. The host agent both displays this text to the user and injects it into the agent's system context for the new session.

For **this** handler the payload is the branch briefing and nothing else. The shared composer it calls can in principle prepend up to two reminder blocks, but this handler disables them (see "Shared composition seam"), so no other surface's output can appear here.

When the briefing is skipped, times out, or errors, the handler writes nothing to standard output.

### Skip-branch list

A fixed set of branch names treated as non-feature branches and skipped: `main`, `master`, `develop`, `development`, `staging`, `production`. Comparison is exact-string.

### Hard deadline

A wall-clock bound on the briefing-composition step, set to 500 milliseconds. The composer races the composition against this deadline and yields nothing if the deadline wins. The bound covers the composition only — work the handler performs **before** entering the composer is outside it (see "Execution order" step 4).

## Behavior

### Shared composition seam

Composing session-start output is a shared routine, not this handler's private code. The routine takes three inputs:

- A **surface identity** naming which surface is asking.
- An **include-briefing** switch.
- An **include-plugin-reminders** switch.

The two switches are independent, so a caller can ask for briefing-only, reminders-only, both, or neither. This handler — the one installed into the repository's agent-settings file — always calls it with the briefing switch **on**, the reminder switch **off**, and a surface identity of the neutral shared value.

That combination makes the reminders **structurally unreachable from this handler**, in two independent ways: the reminder switch replaces each reminder read with an immediate empty result, and even if the switch were on, the neutral surface identity fails each reminder's own internal plugin-surface guard. The provider-default seed is likewise not performed here at all — it is not part of this handler's sequence.

The agent-plugin's session bootstrap is the other caller of the same routine. It passes the plugin surface identity, turns the reminder switch **on**, and decides the briefing switch dynamically. Everything the reminder switch enables — the reminders themselves, their ordering ahead of the briefing, and the provider seed that precedes them — is that caller's behavior and is owned by the bootstrap spec.

Passing the surface identity as a parameter rather than reading a build stamp is what keeps both callers' paths testable regardless of how the running build is stamped.

### Execution order

1. **Local-agent-child guard.** If the handler detects it is running inside a session Jolli's own local-agent backend spawned, it returns immediately and emits nothing — composing a briefing there would re-enter Jolli against a throwaway temporary working directory (and, under the local-agent backend, recurse into another spawn). The check runs before standard input is read, so the payload is never parsed on this path.

   This site consults the **inherited-environment channel only**; it passes no working directory and therefore never consults the working-directory marker. The environment is the reliable channel here because this handler is spawned by the agent CLI Jolli itself launched — Jolli's own direct child, with the environment Jolli set — so the marker is always inherited. The marker-file channel exists for the one entry point launched by a *host* rather than by Jolli's own child, where the host's environment policy can strip the marker. Both channels and the reason the marker-file probe is opt-in per call site are owned by spec 280.
2. Read all bytes from standard input as text and parse them as JSON. Extract `cwd` if present.
3. Resolve the project directory (candidate, then anchored to its enclosing worktree root), configure the diagnostic log directory under the anchored value, and log that the handler was invoked.
4. **Repo-wide manual-disable gate.** Read the repository's manual-disable flag. If it is set, log that the repository is manually disabled and return, emitting nothing. This read sits **outside** the composition deadline race in step 5 — see the note under "Hard deadline" and the Notable entry below. The flag's storage, priority, and migration are owned by the manual-disable spec.
5. Invoke the shared composition seam with the briefing switch on, the reminder switch off, and the neutral surface identity. The composition is raced against the 500-millisecond deadline; the reminder reads are replaced by immediate empty results and cost nothing.
6. If the seam produced non-empty text, write it to standard output. Otherwise log that no briefing was generated (skipped or timed out) and write nothing.
7. Catch any error escaping the top-level routine; log it; emit nothing.

### Composition routine

1. Determine the current branch name. If the branch cannot be determined, return "no briefing".
2. If the branch name appears in the skip-branch list, return "no briefing".
3. Consult the briefing cache for a record whose branch matches the current branch and whose stored HEAD hash matches the current HEAD hash. If found, return the cached briefing text.
4. Load the summary index from storage. If the index is absent, return "no briefing".
5. Filter the index entries to those whose branch matches the current branch and whose parent reference is null or absent (root entries only). If none remain, return "no briefing".
6. Sort the filtered entries by a "display date" rule (the most recent of the entry's commit-date and generated-at timestamps), descending. The first entry is the "latest", the last is the "oldest".
7. If the filtered set has exactly one entry and that entry's display date falls on today's calendar date, return "no briefing" (single commit made today is too thin to brief on).
8. Load the latest entry's full summary payload directly from the summary store by commit hash. Extract:
   - The most-recent topic's title (the last topic in the topic walk; null if there are no topics).
   - The non-empty "decisions" text from each topic, in topic order, as a list.
9. Read the local plans registry. Collect titles of plan entries that are unarchived (no associated commit hash), not user-hidden, on the current branch, and have a non-empty title.
10. Aggregate cached diff statistics across all filtered index entries (sum of files-changed, insertions, deletions). Skip entries that lack cached stats; if no entry has them, the aggregate is absent.
11. Build the briefing text (see "Briefing text shape" below).
12. Persist the briefing in the cache under (branch, current HEAD hash). Cache write failures are silently ignored.
13. Return the briefing text.

### Briefing text shape

The briefing is a fixed line-by-line layout:

- Line 1 — header with branch name in a recognizable bracketed format.
- Line 2 — count of commits on the branch followed by a date range from oldest to latest display-date; appended with the aggregated diff-stat summary if available.
- Line 3 — the latest topic's title (or, if no topic title was extracted, the latest entry's commit message), followed by the latest display-date.
- Line 4 (optional) — a semicolon-separated list of "decisions", each individually trimmed of trailing punctuation and the whole list bounded to roughly 200 characters by an early stop or a per-decision hard cap of 200 characters with an ellipsis.
- Line 5 (optional) — a semicolon-separated list of associated plan titles for the current branch.
- Line 6 (optional) — a recall hint based on time since the latest commit:
  - More than 3 days: a warning and a suggestion to invoke the recall command for full context.
  - 1 to 3 days: a one-line tip suggesting the recall command.
  - Same day: no recall line.

### Branches

- **Running inside a Jolli-spawned local agent** → emit nothing; nothing is read.
- **Repository manually disabled** → emit nothing; the composer is never entered.
- **Branch is in the skip list** → emit nothing.
- **Cache hit** → emit the cached briefing text without consulting any other source.
- **Cache miss, no index** → emit nothing.
- **Cache miss, no root entries on this branch** → emit nothing.
- **Single-entry, today** → emit nothing.
- **Cache miss, otherwise** → compose the full briefing, cache it, emit it.
- **Composition exceeds the deadline** → emit nothing.
- **Top-level error** → emit nothing; the failure is logged.

### Branch / HEAD detection

Both facts are read **straight off the filesystem first**, and the source-control subprocess is kept only as the fallback.

- A repository layout is resolved from the working directory by walking to the directory that holds the version-control metadata entry, yielding that worktree's own metadata directory and the shared one (equal in a plain checkout, different in a linked worktree).
- The branch name is read from the reference the worktree's own HEAD file points at; the HEAD hash from that reference, or from the HEAD file directly when it holds a hash rather than a pointer.
- **Every one of these answers null rather than guessing**, and each caller keeps its subprocess path for exactly those cases: a layout the reader does not recognise, a reference format it does not parse, and — the important one — **any environment that redirects where version control looks**. Version control exports such redirection for every hook process, and a detached child inherits it, so the repository a subprocess would resolve is then *not* the one containing the working directory. Since the whole point of the filesystem reader is to agree with the subprocess it replaces, it declines outright whenever such a redirection is present.

This is a latency change, not a behavioral one: the fallback produces the same answers. **Why it matters here** is that this is the handler a human waits on before the agent host shows a prompt, and roughly nine tenths of its in-process time used to be version-control subprocesses — each around ten to fifteen milliseconds of process creation, on a path whose entire useful work is reading two files and a cached record. Three of those spawns were the *same* shared-metadata-directory query, because three separate modules each memoized it privately. On one platform each additional spawn also inflates the *next* process launch, so the spawns cost more than the sum of their own durations.

The reader is deliberately not a version-control implementation and must not become one; a caller that reads a non-null layout as "this is a repository" is entitled to that, because the reader confirms it rather than merely matching the shape.

### Cache invalidation

The cache is invalidated implicitly: any change that advances HEAD on the current branch produces a different cache key, as does switching branches, and as does starting the session from a different agent-host surface. The cache file therefore does not need explicit deletion; new entries simply do not match it. Because the slot is single, a non-matching entry is overwritten rather than accumulated.

A cache record is also discarded by the reader (treated as a miss) if:

- The current HEAD hash query returns null.
- The cache file is corrupt or fails to parse.

The cache file itself is not garbage-collected by this handler.

### Side effects

- One write to standard output (the briefing) on the success path. Otherwise no write.
- One write to a per-project briefing-cache file on a cache miss that produced a briefing.
- One read of the repo-wide manual-disable flag, which on the very first invocation in a repository may itself create the repository profile file (owned by the manual-disable spec).
- Diagnostic log lines.
- No config writes, no dismiss-marker writes or removals, no model calls, no source-control mutations, no remote requests. The config seed and the marker cleanup that used to happen here belong to the plugin bootstrap now.

### Errors classified

| Class                              | Trigger                                                          | Outcome                                                       |
| ---------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| Top-level failure                  | Any error escaping the main routine.                             | Logged; nothing emitted.                                      |
| Repository manually disabled       | The repo-wide manual-disable flag is set.                        | Logged; the composer is never entered; nothing emitted.       |
| Manual-disable read is slow        | The repository's profile has not yet converged, so the read also enumerates worktrees for a legacy marker and takes a lock to persist the migrated decision. Once converged it is one file read, and its path resolution no longer spawns a subprocess. | **Not bounded by the deadline** — the read sits outside the race, so on that first migrating run it can push session start past the 500-millisecond contract. |
| Composition timeout                | Composition exceeds the hard 500-millisecond deadline.           | Composition's partial work is discarded; nothing emitted.     |
| Branch / HEAD lookup failure       | The filesystem reader declined or answered null **and** the fallback source-control query returned non-zero or empty. | Treated as missing data; "no briefing" path. A declining filesystem reader on its own is not a failure — it is the fallback's cue. |
| Index load failure                 | The index payload is missing or fails to parse.                  | "No briefing" path.                                           |
| Summary load failure               | The latest summary payload fails to load or parse.               | Treated as "no topic title, no decisions"; briefing still composed using only index data. |
| Plans-registry load failure        | The plans file is missing or fails to parse.                     | Treated as no plan titles; briefing still composed.           |
| Cache load failure                 | The cache file is missing or fails to parse.                     | Treated as miss; full composition proceeds.                   |
| Cache write failure                | The cache file cannot be written.                                | Silently ignored; the briefing is still emitted.              |

## State Transitions

The briefing cache, per project root, has these states:

- **Absent** → **Present**: first successful composition writes a record.
- **Present (matching)** → **Present (matching)**: subsequent invocations on the same branch with the same HEAD hash return the cached text without recomposing.
- **Present (matching)** → **Present (replaced)**: any invocation that misses the cache and successfully composes overwrites the prior record.
- **Present** → **Absent**: not driven by this handler.

The summary store and plans registry are read-only inputs from this handler's perspective. It never mutates them.

## Notable Behavior

- **Standard output is the contract.** The host agent reads the handler's standard output and uses it both as user-visible context and as additional system-context for the new session. A JSON-shaped "hookSpecificOutput" alternative was considered and rejected because it would be invisible to the user.
- **Per-HEAD cache, not per-commit-summary cache.** The cache key is the working tree's HEAD hash, not the latest summarized commit hash. HEAD can be ahead of the latest summarized commit during active development; using HEAD ensures that uncommitted-but-imminent re-runs (e.g. rapid session restarts immediately after a commit) hit the cache.
- **Hard deadline takes precedence over completeness.** The handler will emit nothing if the deadline wins, even if a slightly more relaxed budget would have produced a useful briefing. This protects new session startup from being slowed by an unhealthy summary store.
- **Skip-branch list is fixed and exact-match.** Branches like `main` and `master` always produce no briefing. Custom names (e.g. `trunk`) are not skipped.
- **Single-commit-today guard.** A branch with exactly one root entry whose display date falls on today is skipped. This avoids briefing the user on the very commit they just made before any meaningful history accrued.
- **Display-date ordering, not insertion order.** Latest and oldest are determined by a "display date" convention (the more recent of commit-date and generated-at), so amended/regenerated entries can move within the ordering.
- **Decisions list is character-bounded.** Decisions are joined with `; ` separators, and the joined output is capped at roughly 200 characters by either stopping early or eliding individual decisions that exceed the cap.
- **Latest-topic title falls back to commit message.** If the latest summary payload has no topics or topic title is empty, the briefing uses the index entry's commit message instead.
- **Plan filter is strict.** Only plan entries that are explicitly on the current branch, are not associated with a commit hash, are not user-hidden, and have a non-empty title appear in the briefing's plans line.
- **Recall hint thresholds.** The "more than 3 days" warning and the "today vs. 1–3 days" tip are computed from absolute calendar-day differences between the latest display-date and "now"; the same-day case suppresses the line entirely.
- **No model call ever.** Even on a full cache miss with healthy inputs, this handler reads only what was already written by the commit pipeline. It does not summarize anything in real time.
- **Aggregated diff stats are best-effort.** If even one index entry has cached diff stats, they are aggregated; entries without cached stats are skipped silently. A branch whose entries entirely lack cached stats produces a briefing without a diff-stat suffix on line 2 — partial data is preferred to none.
- **Briefing-cache write is non-fatal.** A failure to persist the cache is silently swallowed; the next invocation will simply recompose.
- **This handler emits the branch briefing and nothing else.** The reminders and the provider seed it used to carry now belong entirely to the agent-plugin's session bootstrap. Because this handler both turns the reminder switch off *and* passes a neutral surface identity that fails each reminder's own plugin guard, the reminders are unreachable here in two independent ways — a defence-in-depth arrangement, not redundancy by accident. (Notable; a moved responsibility.)
- **The composer is shared but its two inclusion switches are independent.** The same routine serves this handler (briefing only) and the plugin bootstrap (reminders always, briefing conditionally). Surface identity is passed in rather than read from a build stamp, so neither caller's path depends on how the running build is stamped. (Notable.)
- **The 500 ms ceiling still covers the composition rather than the whole handler, but what leaks past it is now a first-run cost rather than a per-invocation one.** The manual-disable read runs before the deadline race is set up, and it has two regimes. Once the repository's profile has converged — the switch present and the retired key gone — the read is one path resolution plus one file read, and the path resolution is now answered from the filesystem rather than by a subprocess. While the profile has *not* converged, the same read still enumerates the repository's worktrees for a legacy marker and takes a lock to persist the migrated decision, and that work is still outside the race. So the hole is real but bounded: it is paid once per repository, on the first run that migrates it, not on every session start. (Narrowed; previously a per-invocation hole.)
- **The manual-disable gate precedes composition, so a disabled repository emits nothing and reads nothing.** No index load, no summary load, no plans-registry read, no cache read or write. (Notable.)
- **The project root is anchored to the enclosing worktree, and this is the handler where that mattered most.** The payload's working directory (or the runtime's) is resolved up to the worktree root before anything joins the per-project state directory onto it. Three sites do that join — the dismiss marker, the plans registry, and the briefing cache — and the cache write *creates* the directory, so an unanchored subdirectory session did not just read the wrong plans file, it left a real stray state directory behind inside the checkout. A path no worktree encloses still resolves to itself, so a non-repository working directory behaves exactly as before. (Surprising; a real regression-closer — see spec 311.)
- **The local-agent-child guard is environment-only, and is the first thing evaluated.** It runs ahead of the standard-input read, the log-directory setup, and the manual-disable gate, so a nested generation session costs one log line and nothing else. It deliberately consults only the inherited environment and not the working-directory marker, for two reasons that hold specifically here: this handler is launched by the agent CLI Jolli itself spawned, so the environment always carries the marker, and keeping the marker-file probe opt-in per call site means the guard cannot be flipped by unrelated stubbing of filesystem checks. (Notable; channel rationale owned by spec 280.)

## Shared Behavior

- The summary index format, root-vs-descendant semantics, and the display-date convention used for ordering are defined by **Summary Index Format**.
- The summary payload structure that yields topic titles and decisions text is defined by **Summary Tree Structure**.
- The plans registry layout that yields the plan titles consulted here is defined by spec 29 and the plans-registry spec.
- The orphan-branch storage that this handler reads via "load summary by commit hash" is defined by **Orphan Branch Summary Storage**.
- The per-agent-stop recording counterpart that produces the session-tracking signal but never emits any output is defined by spec 26.
- The repo-wide manual-disable flag read before composition — its storage, repo-wide anchoring, priority, migration, and the fact that its cost is *not* covered by this handler's deadline — is owned by the manual-disable spec.
- The resolution of the payload's working directory to its enclosing worktree root, which every on-disk path in this handler is built from, is owned by spec 311.
- The **agent-plugin session bootstrap** is the other caller of the shared composition seam. It owns: the two reminders and their ordering ahead of the briefing, the one-time provider default that precedes them, the stale not-signed-in dismiss-marker cleanup, and the rule that suppresses the briefing on its own path whenever both canonical agent hooks were already healthy at its entry (so this handler owns the briefing in the steady state and the two never double-emit).
- The exact copy and detection of the local-agent login-expiry reminder is owned by spec 286; this handler is no longer a surface that emits it.
- What counts as an LLM credential (including why the `local-agent` provider counts) and the `aiProvider` selection model are owned by spec 10; the local-agent backend that provider drives is owned by spec 280. That spec also owns the re-entrancy guard this handler evaluates first — its two detection channels, which entry points opt into the working-directory channel and which stay environment-only, and the write-boundary backstop behind both. This spec records only that this handler carries the guard and is one of the environment-only sites.
- The Claude Code plugin package, and the narrowed repo-hook install mode that writes this handler's registration into the repository's agent-settings file, are owned by spec 282 and spec 57; the plugin's own single manifest hook is the session bootstrap, not this handler.
