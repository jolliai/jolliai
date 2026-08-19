# 347. Machine-Level Memory Database: Store, Schema and Migration Ladder

## Topic Statement

One SQLite database per machine backs every memory and activity surface: this spec covers where that file lives, how a writable open creates and tightens it, the exact schema it carries at the current version, and the append-only ladder that raises an older file to it — a ladder whose entries are identified by name rather than by position, which records every touch in a log inside the database itself, which compares that log against the build reading it and only ever *warns*, and which deliberately contains **no compatibility gate at all**: a file stamped ahead of the running build is opened and written normally. It also covers the silent no-op every writer becomes on a runtime that cannot load the database module unflagged.

## Scope

**In scope:**

- The database file's location and name, the companion files SQLite creates beside it, and the directory and file permission modes a writable open forces.
- The ways in — a writable handle and a read-only handle, plus the repair handle that must never migrate — and everything each applies to the connection: per-connection pragmas, the write-lock wait, and the open-time retry.
- The lifecycle call that creates a missing file *or* brings an existing one's schema forward, and the one condition under which it stays silent.
- The complete schema as a data contract: every table, primary key, unique constraint, check, foreign key and index, split into its two halves plus the derived cache declared apart from both.
- The current schema version, what it is derived from, and the append-only migration ladder — its name-based identity, its execution order, and the transaction discipline each step runs under.
- The log the ladder writes inside the database, its outcomes, and the one case whose rows are inference rather than observation.
- Drift verification: what is compared, when it runs, the deliberate silences and the one state that is a warning rather than a silence, and why the answer is a warning and never a refusal.
- **The deliberate absence of a compatibility gate** — no version floor, no "the file is newer than me" error — the one log line that replaces it, the reasons a gate was implemented and removed, and the one derived-data maintainer that nonetheless declines to write while the stamp is ahead.
- The one repair that remains for a state a name key cannot fix alone.
- The runtime-floor verdict: what the check actually compares, and everything that degrades through it.
- The trigger the baseline installs, the entry that drops it again, and what still protects a repository's rows without it.
- The transaction helper's deliberate absence of an application-level retry.

**Out of scope (boundaries):**

- What the memory half's rows *mean* — how a memory tree is written, reassembled, regenerated or remounted, and how context, plan-progress and topic rows are produced. This spec captures their shape as a storage contract only.
- The routing that decides whether a repository reads and writes through this database at all (344, 346), and the freeze protocol that precedes it (345).
- The projection pipeline behind the write-ahead log table (which producers emit events, how rows are claimed, projected, retried and pruned) and the historical import/backfill that first fills the tables.
- The local HTTP service and the query layer that read these tables, and the browser pages they serve.
- Snapshots, rotation and restore (349), and the deletion detector (348) — both consume this store but are separate topics.
- The repository registry file that lives beside this database, and the working-context registry that does not.

## Data Contracts

### The file and its companions

| Item | Value |
| --- | --- |
| Database | `~/.jolli/jollimemory/jollimemory.db` |
| Write-ahead log sidecar | `~/.jolli/jollimemory/jollimemory.db-wal` |
| Shared-memory sidecar | `~/.jolli/jollimemory/jollimemory.db-shm` |
| Directory mode | `0700` |
| Database and sidecar mode | `0600` |

The name is deliberately not scoped to any one page: this file holds the memory system of record, not a read model for a single surface. One database serves every repository on the machine; every table is repository-scoped by a surrogate id rather than by a separate file per repository.

Both sidecars are created by the engine itself, under the process umask, whenever a write session is open, and a cleanly closed database legitimately has neither. That is why the `0700` directory — not the file mode — is what actually keeps another local user out.

### Schema version

The current version is **8**, recorded as the value of key `schema_version` in `schema_meta`. A database with no `schema_meta` table reads as version **0**.

The number is a hand-maintained constant that **must equal the number of entries in the ladder** — appending a migration means raising it by one — and a test pins the two together, so two branches that each append one collide loudly in continuous integration rather than silently on disk. It cannot be written as a reference to the ladder's own length, because the ladder is declared after it.

**Raising it is no longer a cross-surface release event**, and that is the one thing worth knowing about it: nothing refuses a database over this number (see *No compatibility gate*), so an appended entry costs an upgrade to nobody.

### `schema_meta` keys

`schema_meta` is a whole-database key/value singleton. The keys written:

| Key | Written by | Meaning |
| --- | --- | --- |
| `schema_version` | Each migration step, in the step's own transaction | The version the file has reached |
| `instance-id` | Minted on first ask during a snapshot pass | The database's own identity (348, 349) |
| `last-snapshot-at` | A successful snapshot | Epoch milliseconds of the last verified snapshot (349) |
| `backup-folder-last-used` | A successful snapshot | The folder that snapshot landed in (349) |

Per-repository control state is deliberately *not* here — it lives in a repository-scoped key/value table, because a whole-database singleton cannot answer a per-repository question.

### The activity half

Every table is `STRICT`. This half is a projection of git plus each agent's own storage: losing it costs time, never data. One further table is also cheap to lose, but for a different reason, and is declared apart from both halves — see *The derived cache*.

**`schema_meta`** — `(key TEXT PRIMARY KEY, value TEXT)`.

**`repos`** — the registry every other table references.

- `id INTEGER PRIMARY KEY` (surrogate key)
- `repo_identity TEXT NOT NULL UNIQUE`, `repo_name TEXT NOT NULL`, `worktree_root TEXT NOT NULL`, `remote_url TEXT`
- `enabled_at TEXT NOT NULL`, `disabled_at TEXT`, `last_ingested_at TEXT`, `bootstrap_state TEXT NOT NULL DEFAULT 'pending'`
- Trigger `repos_no_delete BEFORE DELETE ON repos`, which aborts unconditionally.

**`sessions`**

- `event_id TEXT PRIMARY KEY` (the producer's idempotency key, which embeds identity + source + session id)
- `repo_id INTEGER NOT NULL REFERENCES repos(id)`, `source TEXT NOT NULL`, `session_id TEXT NOT NULL`, `title TEXT`
- `started_at_ms INTEGER`, `updated_at_ms INTEGER NOT NULL`, `message_count INTEGER`, `duration_ms INTEGER`, `model TEXT`
- `input_tokens`, `output_tokens`, `cached_tokens` — `INTEGER NOT NULL DEFAULT 0`; `est_cost_usd REAL`
- `token_coverage TEXT NOT NULL DEFAULT 'sessions-only'`, `prices_as_of TEXT`
- `written_at_ms INTEGER NOT NULL DEFAULT 0` — the row's write stamp (added at version 8)
- `UNIQUE (repo_id, source, session_id)`
- Indices: `ix_sessions_repo_time(repo_id, updated_at_ms)`, `ix_sessions_time(updated_at_ms)`, `ix_sessions_source(source)`, `ix_sessions_written(written_at_ms)`, `ix_sessions_keyset(written_at_ms, event_id)`

**`session_model_usage`** — `PRIMARY KEY (session_event_id, model)`; `session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE`; token columns and `est_cost_usd` as above; `updated_at_ms INTEGER NOT NULL DEFAULT 0` (the row's write stamp, added at version 8). Indices `ix_smu_model(model)`, `ix_smu_sync(updated_at_ms)`, `ix_smu_keyset(updated_at_ms, session_event_id, model)`.

**`session_usage_events`** — one row per counted model response, the per-response detail behind the per-model aggregate above. `STRICT, WITHOUT ROWID`.

- `PRIMARY KEY (session_event_id, dedup_key)`; `session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE`; `dedup_key TEXT NOT NULL`
- `responded_at_ms INTEGER NOT NULL`
- `model TEXT NOT NULL` — the empty string when the transcript named none
- `input_tokens`, `output_tokens`, `cached_tokens` — `INTEGER NOT NULL DEFAULT 0`
- `est_cost_usd REAL` — nullable
- `updated_at_ms INTEGER NOT NULL` — the row's write stamp; unlike the stamps added to the tables that already existed, it carries **no default**, so the writer must supply it
- Indices `ix_sue_at(responded_at_ms)`, `ix_sue_sync(updated_at_ms)`

The commit-summary projection writes no rows here, so a session seeded from a commit summary has an empty per-response set even though its per-model aggregate is populated.

**`session_tool_use`** — `PRIMARY KEY (session_event_id, tool_name, kind)`; `session_event_id … REFERENCES sessions(event_id) ON DELETE CASCADE`; `server TEXT`; `calls INTEGER NOT NULL DEFAULT 0`; `last_call_at_ms INTEGER` (nullable, added at version 5); `updated_at_ms INTEGER NOT NULL DEFAULT 0` (the row's write stamp, added at version 8). Indices `ix_stu_kind(kind)`, `ix_stu_server(server)`, `ix_stu_sync(updated_at_ms)`, `ix_stu_keyset(updated_at_ms, session_event_id, tool_name, kind)`. The kind is part of the key because a skill and a builtin can share a name.

**`commits`**

- `id INTEGER PRIMARY KEY`, `event_id TEXT NOT NULL UNIQUE`, `repo_id INTEGER NOT NULL REFERENCES repos(id)`
- `hash TEXT NOT NULL`, `branch TEXT`, `message TEXT`, `author_name TEXT`, `author_email TEXT`
- `committed_at_ms INTEGER NOT NULL`, `files_changed INTEGER`, `insertions INTEGER`, `deletions INTEGER`
- `written_at_ms INTEGER NOT NULL DEFAULT 0` — the row's write stamp (added at version 8)
- `UNIQUE (repo_id, hash)`; indices `ix_commits_repo_time(repo_id, committed_at_ms)`, `ix_commits_branch(branch)`, `ix_commits_written(written_at_ms)`

**`branches`** — `id INTEGER PRIMARY KEY`, `repo_id INTEGER NOT NULL REFERENCES repos(id)`, `name TEXT NOT NULL`, `UNIQUE (repo_id, name)`.

**`commit_branches`** — `PRIMARY KEY (commit_id, branch_id)`, both columns `NOT NULL` with `ON DELETE CASCADE` to `commits(id)` and `branches(id)`; declared `STRICT, WITHOUT ROWID`. Index `ix_cb_branch(branch_id, commit_id)`. This is the **only** table with no repository column — the boundary arrives through the branch row.

**`commit_files`** — `PRIMARY KEY (commit_id, path)`, `commit_id … ON DELETE CASCADE`, `insertions INTEGER`, `deletions INTEGER`; `STRICT, WITHOUT ROWID`. Index `ix_commit_files_path(path)`.

**`worktree_status`** — `PRIMARY KEY (repo_id, branch_key)`; `branch_key TEXT NOT NULL DEFAULT ''` (a detached head stores the empty-string sentinel so the key stays usable), `branch TEXT`, `files_changed`, `insertions`, `deletions`, `observed_at_ms INTEGER NOT NULL`.

**`events_raw`** — the durable ingest log.

- `seq INTEGER PRIMARY KEY AUTOINCREMENT`
- `event_id TEXT` — deliberately **not** unique; the same event may be logged repeatedly and idempotency lives in the projection tables
- `repo_identity TEXT` — the one table that keeps the identity string rather than the surrogate id, so the raw event can land before any registry row exists
- `type TEXT NOT NULL`, `schema_version INTEGER NOT NULL`, `producer_kind TEXT`, `producer_version TEXT`
- `occurred_at TEXT`, `received_at TEXT NOT NULL`, `data_json TEXT NOT NULL`
- `projection_status TEXT NOT NULL DEFAULT 'pending'`, `claimed_at_ms INTEGER`, `attempts INTEGER NOT NULL DEFAULT 0`
- `failed_kind TEXT` (nullable, added at version 4)
- One index only: `ix_events_pending(projection_status, seq)`

**`ingest_cursors`** — `PRIMARY KEY (repo_id, source)`, `cursor TEXT NOT NULL`, `updated_at_ms INTEGER NOT NULL`.

**`recall_receipts`** (added at version 2)

- `receipt_id TEXT PRIMARY KEY` (the producer's own idempotency key)
- `repo_id INTEGER NOT NULL REFERENCES repos(id)`, `at_ms INTEGER NOT NULL`
- `surface TEXT NOT NULL`, `session_id TEXT` (null when the call belonged to no agent session)
- `hit INTEGER NOT NULL`, `commit_count INTEGER NOT NULL DEFAULT 0`, `commits_json TEXT`
- `updated_at_ms INTEGER NOT NULL DEFAULT 0` — a write stamp (added at version 8) that is written on every receipt and read by nothing; see *Notable Behavior*
- Indices `ix_recall_receipts_repo_at(repo_id, at_ms)`, `ix_recall_receipts_sync(updated_at_ms)`, `ix_recall_receipts_keyset(updated_at_ms, receipt_id)`

The write stamps added at version 8 are deliberately **not** uniformly named: the session table and the commit table carry `written_at_ms`, while the three child tables — per-model usage, tool use and receipts — carry `updated_at_ms`. Note the session table already carries an `updated_at_ms` of its own, which is the session's activity time and not a write stamp.

There is now one aggregate table, and it is declared apart from this half (see *The derived cache*) because it is a derived cache rather than a maintained total: every row is a whole-day replacement, so it is safe to delete outright and the read path recomputes a missing or stale day live. There is still no provider-usage table and no code-graph table, and readers otherwise aggregate live over the detail rows above.

### The memory half

Also all `STRICT`. Unlike either of the other two groups this is the only copy of its data.

**`repo_state`** — `PRIMARY KEY (repo_id, key)`, `value TEXT NOT NULL`. A per-repository key/value table, so adding a marker is an insert rather than a schema change.

**`memories`** — identity, topology and content in one row.

- `repo_id INTEGER NOT NULL REFERENCES repos(id)`, `commit_hash TEXT NOT NULL`
- Topology: `parent_hash TEXT`, `child_pos INTEGER`, `root_hash TEXT NOT NULL`, `depth INTEGER NOT NULL DEFAULT 0`
- Content: `summary_json TEXT NOT NULL`, `tree_hash TEXT`, `index_diff_stats_json TEXT`
- Times: `first_seen_ms INTEGER NOT NULL`, `written_at_ms INTEGER NOT NULL`, `commit_date_ms INTEGER NOT NULL`
- **Stored** generated columns, all `TEXT`, all extracted from `summary_json`: `branch`, `commit_message`, `commit_type`
- **Virtual** generated columns from `summary_json`: `commit_date`, `commit_author`, `generated_at`, `recap`, `ticket_id`, `jolli_doc_id` (all `TEXT`); `turns`, `tokens`, `files_changed`, `insertions`, `deletions` (`INTEGER`) and `est_cost_usd` (`REAL`), each guarded by a JSON type test so an off-type value degrades to null instead of returning the wrong type from a typed column
- `PRIMARY KEY (repo_id, commit_hash)`; `UNIQUE (repo_id, parent_hash, child_pos)`
- `CHECK ((parent_hash IS NULL) = (child_pos IS NULL))`, `CHECK (child_pos IS NULL OR child_pos >= 0)`, `CHECK (child_pos IS NULL OR child_pos < 2000000)`
- Self-referencing `FOREIGN KEY (repo_id, parent_hash) REFERENCES memories(repo_id, commit_hash) ON DELETE CASCADE`
- Indices: `ix_mem_root(repo_id, root_hash)`, `ix_mem_branch(repo_id, branch, commit_date_ms)`, `ix_mem_date(repo_id, commit_date_ms)`, `ix_mem_ticket(repo_id, ticket_id)`, `ix_mem_written(written_at_ms)` — the last added at version 8 over a column the baseline already carried

Stored generated columns are restricted to `TEXT`: a strict table rejects the whole row when a stored generated value has the wrong type, and a rejected row is a permanently lost memory.

**`memory_topics`** — `PRIMARY KEY (repo_id, commit_hash, pos)`, `CHECK (pos >= 0)`, `category TEXT`, `importance TEXT`, `title TEXT NOT NULL`, foreign key to `memories` with `ON DELETE CASCADE`. Index `ix_mtopic_category(repo_id, category)`.

**`commit_aliases`** — `PRIMARY KEY (repo_id, old_hash)`, `target_hash TEXT NOT NULL`, `created_ms INTEGER NOT NULL`, `FOREIGN KEY (repo_id, target_hash) REFERENCES memories(repo_id, commit_hash) ON DELETE CASCADE`.

**`transcripts`** — `PRIMARY KEY (repo_id, transcript_id)`, `repo_id … REFERENCES repos(id)`, `sessions_blob BLOB NOT NULL` (compressed JSON, stored and fetched whole), `written_at_ms INTEGER NOT NULL`.

**`memory_transcripts`** — `PRIMARY KEY (repo_id, commit_hash, transcript_id)`, cascading foreign keys to both `memories` and `transcripts`. Index `ix_mt_transcript(repo_id, transcript_id)`. No array position is stored; order lives in the summary payload.

**`transcript_sessions`** — `PRIMARY KEY (repo_id, transcript_id, session_id)`, `source TEXT` (legitimately null on older data), foreign key to `transcripts` with cascade. Index `ix_ts_session(repo_id, session_id, source)`.

**`context_kinds`** — `(kind TEXT PRIMARY KEY)`, seeded with `plan`, `note`, `reference`; `skill` is added by a later migration step rather than by editing the seed.

**`context`** — plans, notes, references and skills in one table.

- `id INTEGER PRIMARY KEY`, `repo_id INTEGER NOT NULL REFERENCES repos(id)`, `kind TEXT NOT NULL REFERENCES context_kinds(kind)`, `context_key TEXT NOT NULL`
- `source`, `native_id`, `tool_name`, `referenced_at`, `original_slug`, `branch`, `title`, `url` — all nullable `TEXT`
- `body_md TEXT NOT NULL` (exactly the file body, frontmatter included), `created_at_ms INTEGER NOT NULL`, `updated_at_ms INTEGER`
- `plan_key TEXT` — a **stored** generated column that equals `context_key` for a plan and null otherwise
- `UNIQUE (repo_id, kind, context_key)`, `UNIQUE (repo_id, plan_key)`
- Checks: `source`, `native_id` and `referenced_at` are each non-null **exactly when** the kind is `reference`; `tool_name` and `url` are null unless the kind is `reference`; `original_slug` is null unless the kind is `plan`; `branch` is null unless the kind is `plan` or `note`
- No indices — every read is served by the two unique constraints

**`plan_progress`** — `PRIMARY KEY (repo_id, plan_slug)`, `artifact_json TEXT NOT NULL`, `updated_at_ms INTEGER NOT NULL`, `FOREIGN KEY (repo_id, plan_slug) REFERENCES context(repo_id, plan_key) ON UPDATE CASCADE ON DELETE CASCADE`. The update cascade is load-bearing: plan slugs get renamed in place.

**`topic_pages`** — `PRIMARY KEY (repo_id, stable_slug)`, `repo_id … REFERENCES repos(id)`, `title TEXT NOT NULL`, `summary TEXT`, `content_md TEXT NOT NULL`, `related_branches_json TEXT NOT NULL DEFAULT '[]'`, `last_updated_at TEXT NOT NULL`, `payload_version INTEGER NOT NULL DEFAULT 1`.

**`topic_source_refs`** — `PRIMARY KEY (repo_id, stable_slug, ref_type, ref_id)`, `UNIQUE (repo_id, stable_slug, pos)`, `CHECK (pos >= 0)`, `ref_type` checked against `summary` / `plan` / `note` / `userfile`, `ts TEXT NOT NULL`, `branch TEXT`, foreign key to `topic_pages` with cascade. Index `ix_tsr_ref(repo_id, ref_type, ref_id)`.

**`topic_processed_sources`** — `PRIMARY KEY (repo_id, source_type, source_id)`, `source_type` checked against the same four values, `repo_id … REFERENCES repos(id)`.

There are no views and, at the current version, no triggers at all: the one the baseline installs on `repos` is dropped again by a later ladder entry. Constraints a foreign key or check can express are foreign keys and checks; everything else is the write path's job.

### The derived cache

A third group, declared apart from both halves because its loss semantics are a third thing: it is neither rescannable from git nor the only copy of anything. Every row is re-derivable from the other two halves **inside this same file**, so deleting it costs page latency and nothing else.

**`stats_daily`** — the per-day rollup cache. `STRICT, WITHOUT ROWID`.

- `PRIMARY KEY (repo_id, tz, day, kind, series_key)` — and **deliberately no foreign key**; the sentinel row below carries a `repo_id` no registry row has
- `repo_id INTEGER NOT NULL` — a real repository id, or `0` on the sentinel row that records the build
- `tz TEXT NOT NULL` — an IANA zone name, and part of the key
- `day TEXT NOT NULL` — `YYYY-MM-DD`
- `kind TEXT NOT NULL`, `series_key TEXT NOT NULL`
- `value REAL NOT NULL` — **fractional, not integral**: two of the series axes apportion one response across several members
- `cost_usd REAL NOT NULL DEFAULT 0`
- `built_at_ms INTEGER NOT NULL`, `updated_at_ms INTEGER NOT NULL`
- Index `ix_stats_daily_day(tz, day)`

The `kind` namespace is one entry per series dimension — `model`, `agent`, `project`, `branch`, `ticket`, `category` — plus `tokens`, whose `series_key` is one of `input`, `output`, `cached`, plus the `built` sentinel.

Rows are replaced a **whole day at a time**: settling a day deletes that day's rows and re-inserts them. That is what makes the table safe to delete — a missing or stale day is recomputed live by the read path — and it is why nothing here is a maintained running total.

### The write-lock wait, by writer role

The wait applied to a connection is a property of *who is writing*, and the role travels with the write as a stored value in the ingest log's `producer_kind` column:

| Role | Wait |
| --- | --- |
| Post-commit queue worker | 15 s |
| Historical bootstrap | 15 s |
| Recovery | 15 s |
| Agent stop hook | 5 s |
| Command-line invocation | 5 s |
| Editor extension host | 400 ms |
| Anything not named above | 2 s (the default) |

A detached background writer has nobody waiting on it and should tolerate contention; the editor-host writer runs on the thread that draws the interface with a synchronous interface, so it gives up quickly and lets its next periodic tick try again.

## Behavior

### Opening a handle

Two entry points serve ordinary work, and the split between them is enforced by the engine rather than by convention: a writable handle and a read-only handle. (A third, for the recovery path, is below.) Both do the following, in order.

1. **Runtime-floor check first.** If the running runtime is below the floor, the open raises the floor error immediately and never touches the file.
2. Resolve the path (a caller may override it; production paths do not).
3. **Writable opens only:** create the containing directory with mode `0700`, and — because a mode argument applies only when the directory is actually created — re-read the directory's mode and force it to `0700` if it differs. Any failure here is a warning, never fatal.
4. Load the database module dynamically, then attempt the open, retrying up to **four** attempts with a delay of **50 ms doubling per attempt** and **only** for a failure classified as a lock contention; every other failure propagates on the first attempt. A half-open handle is closed before each retry, or each attempt leaks a descriptor and, on one platform, keeps the file locked against the very retry meant to clear it.
5. Apply the per-connection pragmas: a writable connection sets write-ahead journaling and enables foreign keys; a read-only connection enables foreign keys only, because it cannot set the journal mode and the writer already did.
6. Apply the write-lock wait as a busy timeout.
7. **Writable opens only:** force mode `0600` on the database and on each sidecar that is present. This must run *after* the open, because the engine creates the file at the process umask and before the open there is nothing to change. A missing sidecar is the normal case and is silently tolerated; any other failure is a warning.

The writable entry point then reads the stored version, **warns once per process if the file's format is ahead of this build and proceeds anyway**, verifies the migration log for drift, migrates, and finally runs the caller's work with the handle still open, closing it afterwards. The read-only entry point runs the caller's work directly.

A separate **repair** entry point exists for the recovery path and must never migrate — it opens a writable handle over a database whose schema state is exactly what is in question.

### Creating the file, or bringing an existing one forward

A single lifecycle call answers "does a current database exist here?" and makes one if not:

1. If the file does not exist, open a writable handle that does nothing — the open itself creates and migrates it.
2. If the file exists, read its version through a **read-only** handle.
   - If that read fails for any reason at all, **return silently.** Corruption, a permission problem and a sidecars-only residue all land here, and none of them is something a migration can fix; the caller's own open produces the real error with a far better message.
   - If the version is at or above this build's, return.
   - Otherwise open a writable handle that does nothing, which migrates it.

Guarding on *existence* alone was not enough: migration only runs from a writable open, so a database left by an older build in a directory where nothing else opens a writable handle was never migrated, and the first query for a table this build expects failed outright. A database *newer* than this build is left alone by this call because there is nothing for it to do — not because anything would refuse it; a writable open on such a file succeeds.

The short-circuit asks "has this file reached at least this build's version?", which is deliberately not the same question as "is it exactly this build's version": a file ahead of this build needs no work here either.

### The migration ladder

The ladder is append-only. The first entry takes an empty database to version 1; each later entry takes version N to N+1. A shipped entry is never edited.

**Identity is the entry's NAME, not its position.** The loop applies whichever names the file's own log does not already carry. That is what makes two branches each appending an entry a non-event after a merge — both are in the list, so both get applied — where position-as-identity let the second-merged one be skipped forever with the file stamped as complete. Consequences, all three load-bearing:

- A name may be **added**, but never changed and never removed. Renaming one makes every existing database read it as never applied, re-run it, and fail on a duplicate object. A test pins the list, in order.
- **Order is still execution order, and is protected only socially**: append, never insert into the middle and never reorder. An entry placed ahead of ones a database has already applied would run out of order — a column added before its table exists.
- Because an entry can now be applied to a file already past it, the version stamp is raised to the **greater** of the stored value and this entry's target, never set to the target outright. Stamping it down would re-run everything after it.

| To version | Step |
| --- | --- |
| 1 | The whole activity half, then the delete-refusing trigger on the repository table, then the whole memory half |
| 2 | Create the recall-receipts table and its index |
| 3 | Register the skill kind as a fourth context kind |
| 4 | Add the nullable parked-event-kind column to the ingest log |
| 5 | Add the nullable per-call timestamp column to the tool-use table |
| 6 | **Create the migration log table and its name index** |
| 7 | **Drop the delete-refusing trigger the first entry installed** |
| 8 | The session-statistics sync: write stamps on the session, per-model-usage, tool-use, receipt and commit tables, the new per-response usage table, the per-day rollup cache, thirteen indices, and two backfill passes over the stamps |

Entries 6 and 7 are what this topic's own bookkeeping rests on, and the ordering has one awkward consequence stated under *The log* below: on a fresh database the first five entries run before the table that records them exists.

Entry 7 is appended rather than edited out of the first entry, because a shipped entry's bytes are frozen and every existing database has already applied that one. So the baseline still creates the trigger, still carries its original argument for it, and this entry supersedes it.

Migration proceeds as follows:

1. Read the stored version **and the log**, and build the set of names already done — every row whose outcome is `applied` or `baseline`. Entries whose names are in that set are not re-run.
2. Turn foreign keys **off**, outside any transaction — inside one the setting is a silent no-op. The current ladder does not need this, and it applies cleanly at either setting; it is insurance for a future step that rebuilds a table.
3. For each missing version step:
   - Begin an **immediate** transaction.
   - **Re-read the stored version inside the write lock.** Two writers that opened around a version bump both read the old version before either migrated; the loser parks on the immediate transaction until the winner commits, and replaying the winner's step would then die on a duplicate object — an error the lock-contention retry correctly refuses to treat as contention. If the stored version has already advanced past this step, commit and skip it.
   - Run the step's statements, record an `applied` row, write the new version into `schema_meta` in the **same** transaction, and commit.
   - On any failure, roll back (tolerating a rollback that itself fails, because the engine may already have aborted), record a `failed` row, and propagate the original error. Recording the failure is best-effort and must never mask the failure itself — the log table may not exist yet.
4. In a `finally`, turn foreign keys back **on**. A handle left with them off would make every cascading delete in the caller's remaining work silently stop working.

Bundling the version bump with the step is what makes a crash mid-step safe: the version only advances for a step that completed, so the next open retries it. Without that, a crash partway through building the baseline could leave a half-built schema that every later open would skip.

### The log

Every touch of every entry is appended as one row inside the database, carrying: a monotonic sequence number; the array position the entry ran at (**diagnostic only** — nothing decides anything from it, and it is kept because "slot 5" is what a bug report says out loud); the entry's name; an outcome; the identity of the surface that did it, as a client kind and version pair — the thing a user would go and upgrade; the instant; the duration; and **the full text of the statements that ran**.

Outcomes, none interchangeable:

| Outcome | Meaning |
| --- | --- |
| `applied` | This pass watched the entry run |
| `failed` | This pass attempted it and it raised |
| `skipped` | The fence found the file already past this entry, so nothing ran |
| `baseline` | **Inference, not observation** — see below |

**A reading of the log has three answers, and they are not interchangeable either**: rows; no log table at all; or a table that is present and cannot be read. The third is never folded into the second.

**One kind of row is inference rather than observation, and the log says which.** A database that predates the log has no rows, so the version stamp is the only evidence of what ran, and the names are taken from *this build's* list at those positions — a guess, and wrong in exactly the case a position key was wrong. Those rows are marked `baseline` rather than `applied` for that reason. A log that is present but **unreadable** gets no seed rows at all: writing inference into a table whose shape this build cannot read is how a half-written log gets manufactured.

**The entry that creates the log table cannot record the entries that ran before it.** On a fresh database the earlier entries run before there is anywhere to put their rows, so those rows are held and written by the creating entry — inside its transaction, ahead of its own row, so sequence order still reads as history. They stay `applied`, because this pass did watch them run. If the creating entry then fails, the held rows go with it, and that is recoverable rather than lost: the file is left at a version with no log table, which the next pass reads as a pre-log database and seeds from the stamp. The only cost is that those rows come back as inference — which is the honest description of what is then known.

**Only the most recent `failed` row per name is kept.** A persistently broken database is re-opened on every commit, and appending per open grew the log without bound — each failed row stores the entry's full statement text, which for the baseline is tens of kilobytes, and both the drift check and the migration loop re-read the whole table on every open. A failed row is diagnostic and is not evidence any later pass reads, so the newest attempt is all that is useful.

### Drift verification

On **every** writable open — including the ones that migrate nothing, because drift is precisely the state where the version stamp says "finished" and the content disagrees — each logged entry's stored statement text is compared **byte for byte** against what this build carries under that name. A disagreement is logged, at most once per name per process, naming the entry, its position, the surface that applied it, the date, and this build's identity. A logged name this build does not carry at all is also warned about: it means another build — very likely from an unmerged branch — has touched this file, which is the most useful clue available.

**The answer is always a warning. Nothing here refuses, and turning it back into a refusal is a mistake with a measured cost:** the comparison is byte-exact while the majority of the baseline entry's text is comments, so re-wrapping a single comment would make every existing database refuse writes. A test catches the same disagreement on the author's machine, before it ships, where the fix is free.

Two deliberate silences, and a third state that is deliberately not one:

- **No log table at all** → nothing to check. The entry that creates that table is itself in the ladder, so the first run on any existing database reaches this before the table exists.
- **A name with no `applied` row anywhere** → pass. Databases that predate the log have rows for nothing, so the check cannot reach backwards, only forwards. Seeded `baseline` rows are skipped too — they are a guess by construction, so comparing against them would report drift that was never observed. Note the test is "no `applied` row *anywhere*", not "the newest row is not `applied`": a later `skipped` or `failed` row must not bury an earlier observation.
- **A table that is present and unreadable** → not a silence but its own warning, once per process, because every comparison below it would be vacuous rather than passing.

### No compatibility gate

**This layer does not decide whether a database may be used.** There is no compatibility floor, no version gate, and no "the file is newer than me" error: a writable open succeeds whatever the file says. Additive columns read back as their defaults and unknown tables are never touched. The single trace is one log line, emitted **once per process**, when the file's format number is ahead of this build — so that "this surface could not see everything" is at least visible afterwards.

**One derived-data maintainer does branch on the stamp, and it refuses nothing.** The daily rollup builder logs one line and declines to *settle* a day when the file's version is greater than this build's — a build blind to a newly stamped source table would otherwise settle a day it can only see part of. Everything else proceeds: the file is opened, read and written normally, and the only consequence is that the cache has no row for that day, which costs a live recomputation on the read path. That is an exception in kind — a derived cache declining to write *itself* — and not a softening of the rule below: nothing here refuses to open, read or write a file stamped ahead of the build, and re-adding an actual version gate remains a mistake.

A gate existed and was removed. Three reasons, in the order they were learned:

- **The format number cannot answer the question.** It moves only with schema changes, so it misses the change that actually corrupts data — a newly required field inside a stored payload, a re-encoded text column — while faithfully blocking the additive upgrades that are harmless. Wrong in both directions.
- **Refusing costs more than it protects.** Most of the processes that open this file are long-lived, and they are: one tool server per agent-host session, the machine-global editor bridge, the per-project bridge, the dashboard's own server, and the editor extension host. Short-lived command-line and hook invocations are the remainder. A version gate stopped every long-lived one on every additive bump — measured: five tool servers plus the dashboard plus the extension host all reporting the same error, for a change that added two tables and five nullable columns.
- **Compatibility is a relationship between the shipped artifacts.** The command line and the plugins are built from one source tree and released on one version line, and the backend already gates per surface on its product version. A hard incompatibility belongs there — stated in the numbers a user installed and can update — not in a number only this file knows.

Two floor keys and a per-entry "breaking" flag were each implemented and removed. A floor that is not zero makes a purely additive migration *reduce* compatibility, and the format number cannot see a semantic change that touches no schema at all.

### The one repair that remains

A diagnostic command can record a single named entry as applied, carrying **this** build's statement text. It is what clears a drift warning, and what adopts an entry applied by other means — the state a name key cannot fix alone, where the log lost a row while that entry's column still exists, so a normal open would re-run it into a duplicate-object failure.

It **appends** rather than updating, because the log is the evidence: the row that disagreed stays visible, and the newest `applied` row is what the check reads. It returns a failure for a name this build does not carry, since there is no statement text to accept. Without it the only way out of a false positive would be deleting the database — and what that costs is why the escape hatch exists at all: other processes may hold the file open, and the memory half is the only copy there is.

### Transactions

The transaction helper begins an immediate transaction, runs the caller's work, commits, and on failure rolls back (tolerating a failed rollback) and propagates.

There is deliberately **no application-level retry around acquiring the transaction.** The busy timeout already covers acquisition — a second writer blocks for the full timeout before reporting a lock failure, and fails instantly when the timeout is zero — and the engine does that waiting efficiently, so a retry loop on top would only add spinning to a wait that already happened. The knob that matters is the per-role timeout. Once the transaction has begun, nothing is retried either: the caller's work may have consumed state that cannot be replayed, so a mid-transaction failure rolls back and propagates, and retrying the whole unit of work is left to callers that can wait asynchronously.

### The runtime floor, and what degrades through it

The floor is **major 22, minor 13** — the first runtime version where the built-in database module loads without an experimental flag. Two surfaces can never be given such a flag: the editor extension host, whose runtime is launched by the editor application rather than by the product, and the git-hook dispatchers, which are deliberately flag-free so an old runtime cannot die on an unknown option before running any code.

**The check parses the runtime's own reported version string and compares major and minor. It never probes, never imports the module, and never inspects the process's flags** — deliberately, because a probe would itself emit the module's experimental warning in every process that merely reaches this code.

The verdict is treated as a *verdict*, not an error, by everything on a hot path. Below the floor:

- Four live producer writes share one guard that logs a debug line and reports "did not write": the agent stop hook's session record, the post-commit worker's commit records, the editor host's periodic session sweep, and recall receipts. The memory-row refresh after a stored summary carries its own gate, which returns silently and reports nothing.
- The snapshot pass answers "skipped", with the runtime as the reason (349).
- The backup health row cannot read the last-snapshot stamp, so it reports as if none had ever been taken (349).
- The historical import — and the automatic cutover attempt that follows it — return immediately.
- The interactive enable flow does not offer the dashboard, and the guided front door's dashboard step returns.
- The routing resolution answers "unavailable" for every repository, naming the runtime (344).
- The migration-state report for a repository answers "unavailable", naming the runtime.
- The recovery survey skips the database-recorded snapshot folder, keeping only the configured-or-default one and any folder the caller passed explicitly (349).
- The dashboard launcher prints an error naming the required version and the running one, and exits non-zero; the long-lived server process refuses to start with the floor error rather than serving broken pages.

## State Transitions

For the database file, as seen by a writable open:

| From | Trigger | To |
| --- | --- | --- |
| Absent | Writable open | Created at the process umask, then tightened to `0600` inside a `0700` directory, then migrated to the current version |
| Behind this build | Writable open | Every entry whose name the log does not already carry is applied, each in its own immediate transaction, the version stamped per entry |
| Behind this build, with no log table | Writable open | The log's rows are seeded from the version stamp as `baseline` inference, then the remaining entries apply |
| Behind this build, log present but unreadable | Writable open | Warned once per process; **no** seed rows written; migration proceeds from the version stamp alone |
| Current version | Writable open | No entry runs; modes re-asserted; drift still verified |
| **Newer than this build** | Writable open | **Opened and written normally.** One warning per process that the format is ahead; the file is not otherwise modified |
| Newer than this build | Read-only open | Opened and read |
| A logged entry whose text disagrees with this build's | Writable open | Warned once per name per process; **nothing is refused and nothing is re-run** |
| A logged entry this build does not carry | Writable open | Warned once per name per process |
| An entry that raises | Writable open | Rolled back, the most recent failed row for that name replaced, the original error propagated |
| Any | Open below the runtime floor | Refused before the file is touched |

## Notable Behavior

- **The runtime-floor error tells the user to do something that cannot work.** Its message offers "upgrade the runtime, or run with the experimental flag" — but the gate that produced it compares the runtime's version string and nothing else, so supplying that flag on a runtime between the module's introduction and the flag-free floor leaves the verdict unchanged and the same error is raised again. The error itself is reachable (the long-lived server process raises it explicitly, and any ungated open would too); it is the *second half of its remedy* that is dead. (Surprising; reality.)
- **Neither entry point refuses a newer schema, and that is now the whole rule rather than an asymmetry.** A reader *or* a writer on an older build opens a database migrated by a newer one and may fail later, per query, on whatever it does not recognise — with one warning per process as the only trace. This replaced a writable-only refusal; the surfaces that must not guess each carry their own comparison rather than relying on this layer, and re-adding a gate in any of them is a regression.
- **The lifecycle call swallows every read failure except a version answer.** Corruption, a permission error and a sidecars-only residue are all indistinguishable "return silently" outcomes there, chosen precisely because none is a migration's job; the caller's own open is where the user finds out. (Notable.)
- **A missing version table is read as version 0, and so is a corrupt one.** The version read swallows every error and answers 0, so a damaged file is taken for an empty one and the first baseline statement is what actually fails — which is deliberate, since that statement's error is far better than one this read could produce. (Notable.)
- **Entry 8 is seven development steps concatenated under one name, and it runs in one transaction like any other entry.** So its statements — the stamp columns, the new tables, the indices and the backfill passes — all commit or all roll back together, and the first statement to raise aborts the rest of the entry. One consequence is live and harmless: the rollup cache's day index is created twice inside the entry, once inline with the table and once standalone; both are guarded on non-existence, so the second does nothing. (Notable.)
- **A database that ran an *unreleased* build of entry 8's work re-runs the entry and fails on a duplicate column.** The entry ships under a name no intermediate build logged, so such a file reads it as never applied; its first statement is an unguarded column addition, which raises. The entry rolls back, a `failed` row is recorded, and the error propagates out of every writable open — the repair is the diagnostic command that records the entry as applied by name. This is reachable only where an unreleased build ran: a database that has only ever seen released builds has no name to disagree about. (Notable.)
- **The receipts table's write stamp and both of its new indices are written on every receipt and read by nothing.** That table is excluded from the sync set and has no stamp-column mapping, so the column advances and the two indices are maintained for a reader that does not exist. (Surprising.)
- **The schema now carries no triggers at all, and the one that used to be the exception is created and then dropped by the same ladder.** The first entry installs a trigger refusing any delete of a repository row, and entry 7 drops it — so a database built from scratch passes through a state where it exists. Its original argument is still in the baseline's own text and is now historical.

  What still protects a repository's rows is not a trigger: every child table references the repository table with the default no-action rule and foreign keys are enabled on **both** the writable and the read-only connection, so deleting a repository that owns any row still fails with a constraint error. The zero-data case — the one the trigger uniquely covered — is now deletable, which is what a removal path addressing a repository by identity needs. Disabling remains an update of a timestamp column and is a different operation from removal. (Notable; the reversal is deliberate.)
- **Owner-only file modes are re-asserted on every writable open, but the sidecars usually are not covered by them.** The engine creates the sidecars when a write session starts, which is generally after the mode pass has already run, so the enclosing `0700` directory — not the file mode — is the boundary that actually holds. (Notable.)
- **Foreign keys are per-connection and default off.** Every open sets them, because a connection that forgot to would silently break every cascading delete in the schema — pruning a repository would leave orphaned rows behind rather than failing.
- **The editor host is expected to lose write races, and that is the design.** Its 400 ms wait is short enough that a contended write is dropped rather than freezing the interface; the data is re-derivable and its next periodic tick tries again. (Notable.)
- **The write-ahead log table keeps the repository identity string rather than the surrogate id**, and its identity column is deliberately not unique — the log's job is to get the raw event onto disk before anything is interpreted, which must not depend on a registry row already existing. (Notable.)
- **One table in the schema carries no repository column at all** — the commit-to-branch reachability table — and its boundary comes from the branch row instead, at the cost of one extra join. (Notable.)
- **The three declared groups have different loss semantics and are deliberately declared apart.** The activity half can be rescanned from git and each agent's own storage; the memory half is the only copy there is; the derived cache is re-derivable from the other two inside this same file, so losing it costs only page latency. Confusing the first two is how data gets lost. (Notable.)

## Shared Behavior

- The runtime floor here is the same value the shared database-reading helpers for agent session stores enforce, and the same floor the package's declared engine range, the editor extension's declared host range, and the plugin bundles' build targets all encode. A change to one is a change to all of them.
- The classification of a database failure into contention / corruption / permission / schema-drift is shared with those agent-store readers, and is what decides whether an open is retried here.
- The database's identity key in `schema_meta`, the snapshot timestamp key and the last-used-folder key are written and read by the snapshot engine (349) and consumed by the deletion detector (348).
- **A memory write path that deletes, re-grounds or re-aliases a memory row must name the cached rollup days it invalidated.** None of those three touches a column carrying a write stamp, so a scan for staleness cannot notice them and the cache would go on serving a day its rows no longer support — the invalidation has to be stated by the writer. What this topic owns is the cache that cannot see those operations and the stamps that do not move for them; the write protocol itself is owned by 354.
- The repository registry that the surrogate ids are projected from, and the per-repository control rows in the key/value table, are written by the import and cutover paths (344, 345) and read here only as storage.
- Which repositories route through this database at all, and which back-end a given read or write resolves to, are owned by 344 and 346.
