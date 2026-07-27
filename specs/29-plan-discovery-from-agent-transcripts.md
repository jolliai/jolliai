# 29. Plan Discovery from Agent Transcripts

## Topic Statement

Detect references to plan-class markdown files inside an AI agent's append-only transcript and upsert one record per discovered plan into the per-project plans registry, through a source-agnostic shared driver that delegates one concern — recognising "the agent wrote or edited a markdown file" in this producer's transcript format — to a per-producer scanner, while incrementally scanning only the transcript suffix not yet seen, refreshing the updated-at timestamp of known plans without un-archiving them, and never resurrecting plans that the user or commit pipeline has explicitly archived.

## Scope

**In scope:**

- The two-layer architecture: a per-producer transcript scanner that maps raw transcript lines to a flat result shape, plus a single source-agnostic driver that turns that result into registry mutations.
- The per-producer scanner contract: inputs, the result shape (a slug set, an unfiltered external-plans set, and a total-lines count), and the lower- and upper-line bounds the driver passes in.
- The two concrete scanner implementations that exist today: a slug-and-`Write`/`Edit`-tool-use scanner for one producer, and an `apply_patch`-header scanner for the other. Each is named only by the producer it parses.
- The triggers that drive scanner invocations and their position relative to other passes — one trigger per producer, fired from a different host event but funnelled into the **same** shared driver.
- The on-disk cursor that records how far each transcript has been consumed. The cursor is per-transcript and producer-neutral; the host that drives the scan owns persistence.
- The shared external-plan exclusion policy (path segments, basenames, basename-suffix patterns, and scratch-temp roots) that the driver applies uniformly to every producer's external-plans set. The policy is a function of both the candidate path **and** the current workspace root — a temp-root exclusion is waived for files inside the workspace.
- The shape of a single plan-registry record.
- The upsert semantics — new entry, updated-at refresh, archive guard, and content-change override — exercised identically for every producer.
- The interaction between this scan and a separate writer (the source-control commit pipeline) that may stamp registry records with a commit hash.
- The cross-mutation safety against the sibling notes registry (a note source path suppresses plan auto-registration for the same file).

**Out of scope (boundaries):**

- The hosts that fire the trigger:
  - The Claude-agent host (a per-stop hook, fired by the agent each time it completes a response turn) is covered by spec 26.
  - The Codex host (a periodic polling tick that walks transcript rollouts and schedules a scan-with-cap) is covered by the Codex polling-tick spec; its session-discovery layer is covered by spec 18.
- The session-recording writes that may run alongside each scan invocation are owned by the trigger spec, not this one.
- Any model call — this scan does no LLM work.
- The transcript file's own format beyond the line-level signals each producer scanner is contracted to recognise. The per-producer signal grammars are listed below at the level the driver depends on; the full envelope contracts live in spec 153 (for the reference pipeline that uses the same envelope parsing) and in spec 181 (for the Codex apply-patch envelope).
- The reference-extraction scan that runs alongside plan discovery in either trigger path — same driver philosophy, but different per-producer envelope parsers, different registry, different upsert rules (covered by spec 153).
- The promotion of a plan record into a stored summary or a remote document (covered by other specs).
- The user-facing UI that lists or hides plans.
- The plan-progress evaluator that runs at commit time.
- The notes-registry parallel structure (lives in the same file but is not mutated by this scan; only consulted as a suppression filter).

## Data Contracts

### Triggers

The shared driver is invoked by exactly one host per producer:

- **Per-stop trigger** — for one producer the driver is called once per agent-stop event, synchronously inside that host's fire-and-forget hook process, immediately after session recording, against the transcript locator the host received. The host omits the upper-line cap, so the scan reads to end-of-file.
- **Polling-tick trigger** — for the other producer the driver is called once per discovered transcript per tick, by a periodic background tick that walks the producer's session-rollouts directory. The tick supplies an upper-line cap (the same "safe" line it uses as its persisted cursor target) so plan lines beyond an unfetched reference window are not yet processed.

Both triggers route through the **same** driver and the **same** scanner-selection rule; the driver itself is agnostic to which host invoked it.

### Producer-id enumeration

A closed enum of every known transcript producer. Today the two producers with a registered scanner are referred to here as the **slug-and-tool-use producer** (whose transcripts carry plan-mode slug signals and `Write`/`Edit` tool-use entries) and the **apply-patch producer** (whose transcripts carry `apply_patch` custom-tool-call entries with a patch-text body). Several other producers are recognised by the enum but have no registered scanner; the resolution rule below routes them to the slug-and-tool-use scanner as a fallback (whose substring pre-filters then produce no candidates on a non-matching transcript, preserving a "no plans" outcome).

### Per-producer scanner contract

A scanner is the only source-specific code in the pipeline. It exposes one operation:

> Given a transcript path, a working directory, a lower-bound line watermark (exclusive), and an optional upper-bound line cap (inclusive, default unbounded), return:
> - **slugs** — a set of canonical plan-mode slugs (strings, no leading or trailing path) discovered in the window. May be empty.
> - **externalPlans** — a set of absolute paths to candidate plan markdown files discovered in the window. UNFILTERED at the scanner; the shared exclusion policy is applied by the driver.
> - **totalLines** — the 1-based line number of the last line traversed (the cursor target the host may persist). When the upper-bound cap fires, this is the first out-of-range line; when the scan reaches end-of-file, this is the file's line count.

Scanners are **stateless across calls**. They do not persist cursors. They produce result sets in arbitrary order; the driver's upsert is order-insensitive under its unique-slug rule.

### Scanner selection

The driver resolves the scanner by producer tag at call time:

- **Apply-patch producer tag** → the apply-patch scanner (always returns an empty slug set; emits markdown-suffixed paths from `*** Add File:`, `*** Update File:`, and `*** Move to:` header lines under recognised custom-tool-call envelopes).
- **Slug-and-tool-use producer tag** → the slug-and-tool-use scanner (emits slugs from `"slug":"…"` substrings and routes `Write`/`Edit` tool_use entries to either the canonical user-home plans directory under a slug key or to the external-plans set).
- **Anything else** → the slug-and-tool-use scanner. Its substring pre-filters silently produce no candidates on a non-matching transcript, so this fallback is safe.

The boundary contract that each scanner satisfies is detailed only at the level of "what the driver sees" (the result shape above). Full envelope contracts — including JSONL line shapes, prefix and column-position rules, malformed-input tolerance, and per-token semantics — live in their owning specs:

- The apply-patch envelope contract is owned by spec 181.
- The slug-and-tool-use envelope contract is summarised under "Source signals" below at the level the driver depends on; the JSONL line grammar the reference pipeline shares is owned by spec 153.

### Inputs to the driver

- The transcript-file path (from the trigger).
- The project root, as the working directory the scanner resolves relative paths against.
- The lower-bound line watermark (loaded by the trigger from the per-transcript cursor).
- The optional upper-bound line cap (set by the polling-tick trigger; omitted by the per-stop trigger).
- The producer tag.

### Cursor record

A per-transcript cursor stored in a project-local cursors registry. The cursor is producer-neutral and is owned by the **trigger** that drives the scan, not by the driver itself:

- The per-stop trigger persists the cursor under a key derived from the bare transcript path (after migrating any legacy per-scan prefixed keys into the merged key on every invocation). The merged cursor is shared between plan discovery and reference extraction in that trigger's discovery pass.
- The polling-tick trigger persists the cursor under its own key scheme keyed by the bare transcript path. The line it persists is the "reference-safe" line returned by the sibling reference scan in the same tick; that line is also re-passed as the upper-bound cap on the next call so no transcript line is interpreted twice.

The cursor value carries a line-number watermark and a last-scan timestamp. The driver itself does not read or write cursors — it accepts the watermark as the lower bound and returns the total-lines value from the scanner; the trigger persists what it wants.

### Plan-registry record

One record per plan slug. Fields:

- **slug** (string): the plan's identifier, derived either from the producer's slug signal (for slug-signal producers) or from the file's basename minus its `.md` suffix (for producers that emit only external paths). Acts as the primary key. May carry a deterministic eight-hex-character suffix when the base slug is taken by a different source path (see "Slug-collision resolution" below).
- **title** (string): the first markdown heading of the plan source file, or the file's base name as a fallback.
- **source path** (string): the absolute path on disk of the plan source file. Either a canonical user-home location keyed by slug (slug-signal producers) or an arbitrary absolute path under the project (external-plan signals from any producer).
- **added-at** (ISO timestamp): when the plan was first registered.
- **updated-at** (ISO timestamp): when the record was last touched.
- **branch** (optional, string): the source-control branch active when the record was first registered or re-created. Optional: when the current-branch query fails (it resolves to a literal `unknown` sentinel), the field is **omitted entirely** from the record rather than stored as the literal `unknown` — an omitted branch is treated as visible on every branch. The driver never filters on this field; it is persisted only so the IntelliJ plugin, which shares this registry, can branch-scope its context view.
- **commit hash** (string or null): null while the plan is still pending; populated by the commit pipeline once the plan has been associated with a commit.
- **content hash at commit** (optional, string): a hash of the plan source file's content captured at the moment the commit pipeline associated it with a commit. Used as the archive guard.

### Plans-registry envelope

A versioned container holding the plan records keyed by slug, plus an optional sibling map of note records that this scan does not touch. The reader normalizes a missing or partial envelope into a canonical empty shape so callers can always assume the keyed map is present.

### Per-producer source signals

The driver itself recognises no transcript-line content; every signal is recognised by the per-producer scanner. The signal grammars are summarised here only at the level the driver depends on (what populates `slugs`, what populates `externalPlans`):

**Slug-and-tool-use producer:**

1. **Plan-mode slug** — a substring matching `"slug":"<value>"` in any transcript line. The value is added to the scanner's slug set.
2. **Direct `Write`/`Edit` tool_use targeting the canonical user-home plans directory** — a transcript line that combines a tool-use marker with a `Write` or `Edit` tool name and a path matching the canonical-plans-directory pattern with a slug-suffix capture. The captured slug is added to the scanner's slug set. The path pattern is tolerant of both forward-slash and JSON-escaped backslash separators so transcripts produced on either operating system match.
3. **Direct `Write`/`Edit` tool_use targeting any other `.md` path** — runs only when the canonical-plans-directory pattern misses on the same line. The captured path is JSON-string-unescaped (so all of `\\`, `\"`, `\n`, `\uXXXX` etc. decode uniformly) and added to the scanner's external-plans set as an absolute path. The shared external-plan exclusion policy (described below) is **not** applied at the scanner; the driver applies it uniformly.

**Apply-patch producer:**

1. **Slug set is always empty.** This producer has no slug-mode marker and no canonical user-home plans directory.
2. **`apply_patch` custom-tool-call envelope** — a transcript line whose `payload.type` is `custom_tool_call` and whose `payload.name` is `apply_patch` carries a `payload.input` patch text. Inside the patch text, lines starting at column zero with one of three prefixes — `*** Add File:`, `*** Update File:`, `*** Move to:` — produce a target path. The path is the whole segment after the colon (with outer whitespace trimmed; whitespace inside the path is preserved). Targets whose suffix is `.md` (case-insensitive) are resolved against the working-directory input to an absolute path and added to the external-plans set. The full envelope contract is owned by spec 181.

**Other producers (no registered scanner):** fall back to the slug-and-tool-use scanner, whose substring pre-filters produce no candidates on a non-matching transcript.

### Shared external-plan exclusion policy

Applied by the driver, uniformly, to every producer's external-plans set **before** the existence gate. The policy takes **two** inputs — the candidate absolute path and the current workspace root — and is therefore no longer a pure function of the path alone. It drops a candidate when **any** of the following match (evaluated in this order):

1. **Path-segment denylist** (case-insensitive): any path traversing the agent-private directory (e.g. an agent's own private settings directory), a `node_modules` directory, or a source-control configuration directory is dropped.
2. **Scratch-temp-root exclusion**: any path that lives under a known throwaway-scratch root **and** is *not* inside the current workspace root is dropped. The scratch roots are the OS temp directory (covering the platform's own temp location, e.g. a per-user Windows temp dir or the macOS per-session `/var/folders/…` sandbox) plus the POSIX literals `/tmp`, `/private/tmp`, and `/var/tmp` (the macOS scratchpad roots the OS temp lookup does not return). The **workspace caveat is essential**: a project checkout can itself live under a temp root — a test sandbox created via a make-temp-dir call, or a repo cloned into `/tmp` — and files inside such a workspace are real project content, not scratch, so they are kept. A candidate is scratch only when it is under a temp root *and* outside the workspace.
3. **Basename denylist** (case-insensitive, compared on the lowercased basename): common non-plan markdown files — project-meta names like project guidance, agent guidance, README, CHANGELOG, CONTRIBUTING, LICENSE, security, and code-of-conduct.
4. **Basename-suffix-pattern denylist** (applied to the already-lowercased basename): transient agent scratch artifacts whose basename ends in `review.md` or `report.md` when that word is at the start of the basename or preceded by a dash or underscore — so `review.md`, `code-review.md`, `pr320-review.md`, `report.md`, `task-report.md`, and `task_report.md` are all dropped, at **any** directory depth. This complements the exact-basename denylist above; the rationale is that PR-review scratch files and task/status report dumps an agent writes are never plans.

The policy is owned here so that every producer inherits the same exclusions.

### On-disk existence gate

For every survivor of the exclusion policy and for every canonical slug whose source file is checked at the canonical user-home location, the driver requires the file to exist on disk **at scan time**. Survivors whose file is absent are silently dropped. This is the **only** success gate, and it is deliberate: scanners read the **write request** (the producer's tool-use entry or patch-application entry), never the tool result, so they cannot tell whether a given edit actually applied. The existence check is the deliberate stand-in for "the write landed". A failed or undone add leaves no file and is dropped; a failed or undone update against a pre-existing markdown file leaves the file in place and is therefore upserted. The latter is an accepted benign true-ish positive, shared across all producers so they have one and the same success contract.

### Note-source-path suppression

Before each candidate is upserted, the driver consults the sibling notes map in the same registry envelope. Any candidate whose normalized absolute path matches a registered note's source path is dropped. Notes win over plan auto-registration; this prevents a user's explicit "this `.md` is a note" choice from being overridden by an automatic plan registration when the AI later edits the same file. The check applies to both canonical user-home plan paths and external-plan paths.

### Slug-collision resolution

For every accepted candidate (canonical or external), the driver derives a base slug — the producer-emitted slug for slug-signal candidates; the basename minus its case-insensitive `.md` suffix for external candidates — then assigns a unique slug as follows:

1. **Source-path reverse lookup.** If any existing registry entry's source path normalises to the same absolute path as the candidate, that entry's slug is reused (idempotent across upgrades and across runs).
2. **Base slug free.** Otherwise, if no entry already exists at the base slug, the base slug is used.
3. **Hash suffix.** Otherwise, the base slug is suffixed with the first eight hex characters of a hash of the candidate's normalised absolute path. The suffix is deterministic, so the same path always resolves to the same suffixed slug across runs.

Existing entries are never renamed; the rule is backward-compatible across upgrades.

## Behavior

### Execution order

(The driver receives the transcript path, working directory, lower-bound line watermark, optional upper-bound cap, and producer tag. Cursor load and cursor persist sit one level above the driver, in the trigger.)

1. Resolve the scanner by producer tag.
2. Invoke the scanner with the transcript path, lower bound, working directory, and upper-bound cap. The scanner streams the transcript line-by-line, counts lines from `1`, skips lines at or before the lower bound, stops reading after the first line beyond the upper bound (or reaches end-of-file when the cap is unbounded), and returns its three outputs: the slug set, the unfiltered external-plans set, and the total-lines count. Scanner-internal stream errors resolve the scanner result with whatever was accumulated; the driver never sees a thrown error from the scanner itself.
3. Apply the shared external-plan exclusion policy to each path in the scanner's external-plans set, passing the current workspace root as the second input (needed for the scratch-temp-root exclusion's workspace caveat), **before** the early-exit check. Survivors form the filtered external-plans set. (Filtering before the early-exit preserves the long-standing behaviour that scanning a window containing only excluded files skips the registry read entirely.)
4. If both the slug set and the filtered external-plans set are empty, return the total-lines value to the trigger. No registry read, no registry write.
5. Otherwise, read the plans registry (an initial read used to compute the upsert).
6. Build the suppression set from the registry's sibling notes map: every note's normalised source path, regardless of branch.
7. **Canonical slug branch (slug-signal producers only).** For each slug in the scanner's slug set:
   - Construct the canonical user-home plan path for the slug.
   - If the file does not exist on disk, skip the slug.
   - If the path matches any note's source path, skip the slug.
   - Resolve a unique slug via the source-path reverse lookup / base-slug-free / hash-suffix rule (see "Slug-collision resolution"). This prevents a canonical-plan upsert from silently overwriting a previously-registered external entry that already owns the base slug.
   - Upsert under the resolved slug (see "Per-slug upsert" below).
8. **External-plan branch (all producers).** For each absolute path in the filtered external-plans set:
   - If the file does not exist on disk, skip the path.
   - If the path matches any note's source path, skip the path.
   - Derive the base slug from the file's basename minus its case-insensitive `.md` suffix (using a separator-agnostic split so a Windows-style path parsed on a POSIX host yields a clean filename).
   - Resolve a unique slug via the same rule.
   - Upsert under the resolved slug (see "Per-slug upsert" below).
9. **Per-slug upsert** (used by both branches):
   - If a record exists for the resolved slug:
     - **Archive guard active** (the record carries a content-hash-at-commit): hash the current source file's content. If it differs from the recorded content-hash-at-commit, replace the record with a fresh, uncommitted record (commit hash reset to null, added-at and updated-at refreshed). If it matches, leave the record alone.
     - **No archive guard, commit hash is null**: refresh the record's updated-at timestamp.
     - **No archive guard, commit hash is non-null**: leave the record alone.
   - If no record exists: build a fresh record (commit hash null, added-at and updated-at set to now, source path set to the candidate's absolute path, title extracted from the file's first markdown heading or its basename as a fallback).
   - In every "changed" arm above, mark the slug as touched.
10. If no slug was touched, return the total-lines value. No registry write.
11. Otherwise, acquire the plans-registry write lock and **re-read** the registry inside the lock. Build the merged map by starting from the freshly-read registry and overlaying only the touched slugs as follows:
    - If the fresh-read entry exists and has a commit hash that the original-read entry did not have, **take the fresh entry wholesale** — a sibling writer (typically the commit pipeline) transitioned this slug from uncommitted to archived between this scan's load and save, and it wrote both the commit hash AND the content-hash-at-commit as a pair; preserving them as a pair is what keeps the archive guard functional on the next scan.
    - Else, if the fresh-read entry exists or the slug did not exist at the original read, write the touched local entry. (A touched slug whose original-read state was "present" but whose fresh-read state is "absent" was concurrently hard-deleted by a sibling writer; the touched entry is **not** restored, so the explicit delete wins over this scan's auto-registration.)
12. Save the merged registry under the lock, preserving the version field and the sibling notes / references maps from the fresh read. Release the lock.
13. Return the total-lines value to the trigger.

### Branches

(Trigger-level branches — transcript missing, cursor not yet present, etc. — are owned by the trigger, not by the driver. The driver's branches all start from "scanner returned its three outputs".)

- **Scanner returned empty slug set and empty filtered external set** → the driver returns the total-lines value with no registry read and no registry write.
- **Scanner returned candidates, but every candidate file is missing on disk** → no upsert occurs; the driver still completes the read (notes are consulted, slug resolution is attempted) and returns the total-lines value with no registry write.
- **Scanner returned candidates, all surviving paths are claimed by notes** → no upsert; return.
- **Signal for an archived (commit-stamped) plan, file unchanged** → record is left alone (the archive guard remains active).
- **Signal for an archived plan, file content has changed** → the existing record is replaced by a fresh, uncommitted record (commit hash reset to null, content-hash-at-commit dropped). The slug is "resurrected" by virtue of new file content.
- **Signal for a non-archived, no-commit-hash plan** → the existing record's updated-at timestamp is refreshed.
- **Signal for a non-archived plan that already carries a commit hash** → record is left alone.
- **Signal for a brand-new slug** → a new record is created (commit hash null, source path set, title extracted).
- **Concurrent commit stamp between the original read and the in-lock re-read** → the fresh entry is taken wholesale for that slug, preserving the commit-hash / content-hash-at-commit pair the sibling writer wrote.
- **Concurrent hard delete between the original read and the in-lock re-read** → the touched local entry is NOT restored; the delete wins.
- **Base slug owned by a different source path** → the candidate is upserted under `<baseSlug>-<8 hex of hashed normalised path>` instead, deterministic across runs.

### Side effects

- One read of the plans registry when at least one candidate survives.
- One acquisition of the plans-registry write lock and one in-lock re-read when at least one slug was touched.
- One write of the plans registry under the lock when at least one slug was touched.
- Best-effort hash and read of one or more plan source files on disk (the title extraction reads the first markdown heading; the archive-guard arm hashes the file content).
- No cursor reads or writes from the driver itself — the trigger owns the cursor.
- No source-control queries from the driver itself.
- No model call. No transcript writes. No remote requests.

### Errors classified

| Class                              | Trigger                                                                  | Outcome                                                                |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Transcript missing                 | Transcript file does not exist at the recorded path.                     | The trigger short-circuits before calling the driver. No registry write. |
| Transcript stream error            | The per-producer scanner's line stream emits an error mid-scan.          | The scanner resolves with whatever was accumulated; the driver continues against the partial result. |
| Malformed transcript line          | A line fails JSON parsing or fails the envelope check.                   | The scanner silently skips the line; never thrown to the driver.       |
| Plan-source missing                | The candidate file is not on disk at scan time.                          | The candidate is dropped from the upsert; cursor (owned by the trigger) still advances. |
| Plan-source title-read failure     | Reading the candidate file's first heading fails.                        | Title falls back to the file's base name.                              |
| Top-level driver error             | An exception escapes the driver.                                         | Caught by the trigger's outer error handler; logged; the trigger does not propagate. |

## State Transitions

A single plan record, keyed by slug, has the following states relative to this scan:

- **Absent** → **Active (uncommitted)**: first time the slug is discovered with the plan source file present on disk.
- **Active (uncommitted)** → **Active (uncommitted, timestamp refreshed)**: every additional discovered signal for an uncommitted record refreshes its updated-at timestamp.
- **Active (uncommitted)** → **Archived (commit-stamped)**: not driven by this scan; driven by the source-control commit pipeline writing a commit hash and a content-hash-at-commit onto the record.
- **Archived (commit-stamped)** → **Active (replaced)**: this scan detects a discovered signal *and* the plan source file's content hash differs from the commit-stamped hash; a fresh record replaces the prior one (commit hash reset to null, added-at and updated-at refreshed, branch re-queried).
- **Archived (commit-stamped)** → **Archived (still guarded)**: this scan detects a discovered signal but the file content matches; no change.

The cursor key, per transcript path, has the following states (managed by the trigger, not the driver):

- **Absent** → **Present (watermark = 0)**: first scan that observed the transcript and saw at least one line, or had at least one line beyond an absent watermark.
- **Present** → **Present (advanced)**: each successful scan that consumed lines beyond the prior watermark and whose trigger chose to advance.
- **Present** → **Present (held)**: a trigger's policy decision to hold the cursor when a sibling scan in the same pass failed (the per-stop trigger's policy when the sibling reference scan threw). The held watermark is retried on the next invocation; both scans are idempotent so re-scanning is safe.
- **Present** → **Absent**: not driven by this scan; driven by orphan-cursor cleanup when the underlying session is pruned for staleness.

## Notable Behavior

- **Two-layer split is load-bearing.** The driver does not parse a single transcript line. Every "is this a plan signal?" decision lives in the per-producer scanner; every "what does it mean for the registry?" decision lives in the driver. Adding a new producer is exactly one new scanner.
- **Single driver entry point.** Both triggers — the Claude-side per-stop hook and the Codex-side polling tick — call the same driver function with the same five inputs. The driver's branching on producer tag is one switch: scanner selection. Everything after that (exclusion policy, existence gate, note suppression, slug resolution, archive guard, lock-and-merge upsert) is identical across producers. This was not true before the split.
- **Scanner is the only file the driver does not own.** The shared external-plan exclusion policy is applied **in the driver**, not in the scanner. This was a deliberate change: hoisting the exclusion list to the driver is what gives every producer the same README / project-guidance / CHANGELOG filter without duplicating the list per scanner.
- **Incremental scan via a per-transcript cursor owned by the trigger.** Every invocation reads only the transcript suffix beyond the trigger's persisted line watermark. A growing transcript across many trigger fires is consumed in O(new lines), not O(all lines). The driver itself is stateless across calls; the watermark is supplied by the trigger.
- **Upper-bound cap exists for the polling-tick trigger only.** The per-stop trigger passes no cap, so the scanner reads to end-of-file. The polling-tick trigger passes the reference-safe line as the cap so plan candidates beyond the reference window are deferred to a later tick — no transcript line is ever interpreted twice across triggers within a single producer.
- **Existence gate is the sole success contract, shared across producers.** Scanners read the **write request** (a tool-use entry, a patch-application entry), never the tool result, so they cannot tell whether the write actually landed. The existence check is the deliberate stand-in for "the write landed". This admits a benign true-ish positive when an `Update`/`Edit` to a pre-existing markdown file fails — the file remains, so the plan is registered. Accepted because it is uniform across producers and conservative (it never registers a plan whose file is absent).
- **Note-source-path suppression precedes upsert.** A markdown file that any registered note already claims as its source path is silently dropped from plan registration, regardless of which scanner emitted it. Notes are not branch-scoped, so a note's source-path claim wins on every branch. This prevents an automatic plan registration from shadowing a user's explicit "this is a note" choice.
- **Archive guard via content hash.** Once the commit pipeline associates a plan with a commit, it stores a content hash. Subsequent scanner signals for that slug are inert as long as the file content remains identical to that hash. This is what prevents an already-committed plan from "reappearing" as a fresh pending plan.
- **Archive guard is overridden by file-content change.** If the source file is rewritten with new content, the next scan that observes a signal for that slug replaces the record with a fresh uncommitted entry (commit hash reset to null). Edits to a *changed* file surface as a fresh plan; edits to an *unchanged* archived file stay archived.
- **Slug-collision resolution is deterministic and reversible.** A slug whose base name is already taken by a different absolute path is suffixed with `-<first 8 hex chars of sha256(normalised absolute path)>`. The suffix is a function of the path alone, so the same file always resolves to the same slug across runs and across upgrades. Existing entries are never renamed.
- **Source-path reverse lookup is idempotent.** If a registry entry already has the candidate's absolute path as its source path, that entry's slug is reused even if the base slug now points at a different file. This keeps repeat scans of the same file aimed at the same record across schema upgrades.
- **Concurrent commit-stamp is taken wholesale.** The in-lock re-read may discover that a sibling writer (typically the commit pipeline) has just transitioned a slug from uncommitted to archived. In that case, the fresh entry is **taken as a single unit** — both the commit hash and the content-hash-at-commit move together. Picking the commit hash off the fresh entry and copying it onto the touched local entry would drop the content-hash-at-commit (which the sibling writer wrote as a pair), break the archive guard's next scan, and trip downstream snapshot filters that check for `contentHashAtCommit` presence.
- **Concurrent hard delete wins.** If a slug present at the original read is gone at the in-lock re-read, the touched local entry is NOT restored. This preserves explicit "remove this plan" actions from the editor extension against a parallel scan that happened to register the same file.
- **Lock-and-merge upsert is per-slug, not whole-map.** The merge starts from the freshest registry snapshot and layers ONLY the touched slugs onto it. Concurrent writes to other slugs — including the sibling notes and references maps in the same envelope — are preserved.
- **Cursor advance is independent of registry write.** The driver always returns the scanner's total-lines value, even when no slug was touched. The trigger uses that value to advance the cursor whenever the transcript grew, preventing repeated re-scans of a tail that contains no signals. The trigger may choose to **hold** the cursor on errors (e.g. when a sibling scan in the same discovery pass failed), but that policy lives in the trigger, not in the driver.
- **Per-producer scanner is stateless across calls.** No scanner accumulates state between invocations. The slug set and external-plans set are produced per call from the windowed input.
- **Failures are non-fatal at every layer.** Scanner stream errors resolve with partial results; per-iteration upsert errors do not abort the batch; the driver's outer-most error is caught and logged by the trigger.

## Shared Behavior

- The two triggers that drive this scan are owned elsewhere:
  - The Claude per-stop hook trigger (and the merged discovery cursor it shares with reference extraction) is defined by spec 26.
  - The Codex polling-tick trigger (and the reference-safe upper-bound cap it passes) is defined by the Codex polling-tick spec; session discovery for that trigger is defined by spec 18.
- The per-producer apply-patch scanner — its envelope contract, header-prefix grammar, column-zero requirement, markdown filter, path-resolution rule, and error semantics — is defined by spec 181. The driver consumes its output identically to the slug-and-tool-use scanner's.
- The reference-extraction scan that runs alongside plan discovery in each trigger — same two-layer-split philosophy, different per-producer envelope parsers, different registry — is defined by spec 153.
- The session and cursor registries (their on-disk layout, atomic-write rules, and stale-entry pruning) are defined by the **session-tracking** spec.
- The plans-registry envelope, including its sibling notes and references maps, version field, and the canonical normalization a reader applies to malformed content, is defined by the **plans-registry** spec.
- The commit-stamping that turns an active record into an archived one (writing the commit hash and content-hash-at-commit) is defined by the **source-control commit pipeline** specs.
- The session-start briefing that surfaces non-archived records produced by this scan is defined by spec 27.
