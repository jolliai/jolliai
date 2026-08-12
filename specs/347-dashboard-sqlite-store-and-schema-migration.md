# 347. Machine-Level Memory Database: Store, Schema and Migration Ladder

## Topic Statement

One SQLite database per machine backs every memory and activity surface: this spec covers where that file lives, how a writable open creates and tightens it, the exact schema it carries at the current version, and the append-only ladder that raises an older file to it — including the refusal to touch a file stamped ahead of the running build and the silent no-op every writer becomes on a runtime that cannot load the database module unflagged.

## Scope

**In scope:**

- The database file's location and name, the companion files SQLite creates beside it, and the directory and file permission modes a writable open forces.
- The two ways in — a writable handle and a read-only handle — and everything each applies to the connection: per-connection pragmas, the write-lock wait, and the open-time retry.
- The lifecycle call that creates a missing file *or* brings an existing one's schema forward, and the one condition under which it stays silent.
- The complete schema as a data contract: every table, primary key, unique constraint, check, foreign key and index, split into its two halves.
- The current schema version, the append-only migration ladder, and the transaction discipline each step runs under.
- The refusal to open a database stamped with a newer schema version, and which of the two entry points enforces it.
- The runtime-floor verdict: what the check actually compares, and everything that degrades through it.
- The one table that carries a trigger, and what that trigger prevents.
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

The current version is **5**, recorded as the value of key `schema_version` in `schema_meta`. A database with no `schema_meta` table reads as version **0**.

### `schema_meta` keys

`schema_meta` is a whole-database key/value singleton. Four keys are written:

| Key | Written by | Meaning |
| --- | --- | --- |
| `schema_version` | Each migration step, in the step's own transaction | The version the file has reached |
| `instance-id` | Minted on first ask during a snapshot pass | The database's own identity (348, 349) |
| `last-snapshot-at` | A successful snapshot | Epoch milliseconds of the last verified snapshot (349) |
| `backup-folder-last-used` | A successful snapshot | The folder that snapshot landed in (349) |

Per-repository control state is deliberately *not* here — it lives in a repository-scoped key/value table, because a whole-database singleton cannot answer a per-repository question.

### The activity half

Every table is `STRICT`. This half is a projection of git plus each agent's own storage: losing it costs time, never data.

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
- `UNIQUE (repo_id, source, session_id)`
- Indices: `ix_sessions_repo_time(repo_id, updated_at_ms)`, `ix_sessions_time(updated_at_ms)`, `ix_sessions_source(source)`

**`session_model_usage`** — `PRIMARY KEY (session_event_id, model)`; `session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE`; token columns and `est_cost_usd` as above. Index `ix_smu_model(model)`.

**`session_tool_use`** — `PRIMARY KEY (session_event_id, tool_name, kind)`; `session_event_id … REFERENCES sessions(event_id) ON DELETE CASCADE`; `server TEXT`; `calls INTEGER NOT NULL DEFAULT 0`; `last_call_at_ms INTEGER` (nullable, added at version 5). Indices `ix_stu_kind(kind)`, `ix_stu_server(server)`. The kind is part of the key because a skill and a builtin can share a name.

**`commits`**

- `id INTEGER PRIMARY KEY`, `event_id TEXT NOT NULL UNIQUE`, `repo_id INTEGER NOT NULL REFERENCES repos(id)`
- `hash TEXT NOT NULL`, `branch TEXT`, `message TEXT`, `author_name TEXT`, `author_email TEXT`
- `committed_at_ms INTEGER NOT NULL`, `files_changed INTEGER`, `insertions INTEGER`, `deletions INTEGER`
- `UNIQUE (repo_id, hash)`; indices `ix_commits_repo_time(repo_id, committed_at_ms)`, `ix_commits_branch(branch)`

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
- Index `ix_recall_receipts_repo_at(repo_id, at_ms)`

There is no aggregate table, no provider-usage table, and no code-graph table; every reader aggregates live over the detail rows above.

### The memory half

Also all `STRICT`. Unlike the activity half this is the only copy of its data.

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
- Indices: `ix_mem_root(repo_id, root_hash)`, `ix_mem_branch(repo_id, branch, commit_date_ms)`, `ix_mem_date(repo_id, commit_date_ms)`, `ix_mem_ticket(repo_id, ticket_id)`

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

There are no views and — apart from the one on `repos` — no triggers. Constraints a foreign key or check can express are foreign keys and checks; everything else is the write path's job.

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

Two entry points exist, and the split is enforced by the engine rather than by convention: a writable handle and a read-only handle. Both do the following, in order.

1. **Runtime-floor check first.** If the running runtime is below the floor, the open raises the floor error immediately and never touches the file.
2. Resolve the path (a caller may override it; production paths do not).
3. **Writable opens only:** create the containing directory with mode `0700`, and — because a mode argument applies only when the directory is actually created — re-read the directory's mode and force it to `0700` if it differs. Any failure here is a warning, never fatal.
4. Load the database module dynamically, then attempt the open, retrying up to **four** attempts with a delay of **50 ms doubling per attempt** and **only** for a failure classified as a lock contention; every other failure propagates on the first attempt. A half-open handle is closed before each retry, or each attempt leaks a descriptor and, on one platform, keeps the file locked against the very retry meant to clear it.
5. Apply the per-connection pragmas: a writable connection sets write-ahead journaling and enables foreign keys; a read-only connection enables foreign keys only, because it cannot set the journal mode and the writer already did.
6. Apply the write-lock wait as a busy timeout.
7. **Writable opens only:** force mode `0600` on the database and on each sidecar that is present. This must run *after* the open, because the engine creates the file at the process umask and before the open there is nothing to change. A missing sidecar is the normal case and is silently tolerated; any other failure is a warning.

The writable entry point then reads the stored version, **refuses a database stamped ahead of this build**, migrates, and finally runs the caller's work with the handle still open, closing it afterwards. The read-only entry point runs the caller's work directly.

### Creating the file, or bringing an existing one forward

A single lifecycle call answers "does a current database exist here?" and makes one if not:

1. If the file does not exist, open a writable handle that does nothing — the open itself creates and migrates it.
2. If the file exists, read its version through a **read-only** handle.
   - If that read fails for any reason at all, **return silently.** Corruption, a permission problem and a sidecars-only residue all land here, and none of them is something a migration can fix; the caller's own open produces the real error with a far better message.
   - If the version is at or above this build's, return.
   - Otherwise open a writable handle that does nothing, which migrates it.

Guarding on *existence* alone was not enough: migration only runs from a writable open, so a database left by an older build in a directory where nothing else opens a writable handle was never migrated, and the first query for a table this build expects failed outright. A database *newer* than this build is left strictly alone, because there is no downgrade and the writable open would refuse it anyway.

### The migration ladder

The ladder is append-only. Index 0 takes an empty database to version 1; each later entry takes version N to N+1. A shipped entry is never edited.

| To version | Step |
| --- | --- |
| 1 | The whole activity half, then the delete-refusing trigger on `repos`, then the whole memory half |
| 2 | Create `recall_receipts` and its index |
| 3 | Register `skill` as a fourth context kind |
| 4 | Add the nullable `failed_kind` column to the ingest log |
| 5 | Add the nullable `last_call_at_ms` column to the tool-use table |

Migration proceeds as follows:

1. Read the stored version. If it already meets or exceeds this build's, return without touching anything.
2. Turn foreign keys **off**, outside any transaction — inside one the setting is a silent no-op. The current ladder does not need this, and it applies cleanly at either setting; it is insurance for a future step that rebuilds a table.
3. For each missing version step:
   - Begin an **immediate** transaction.
   - **Re-read the stored version inside the write lock.** Two writers that opened around a version bump both read the old version before either migrated; the loser parks on the immediate transaction until the winner commits, and replaying the winner's step would then die on a duplicate object — an error the lock-contention retry correctly refuses to treat as contention. If the stored version has already advanced past this step, commit and skip it.
   - Run the step's statements, write the new version into `schema_meta` in the **same** transaction, and commit.
   - On any failure, roll back (tolerating a rollback that itself fails, because the engine may already have aborted) and propagate the original error.
4. In a `finally`, turn foreign keys back **on**. A handle left with them off would make every cascading delete in the caller's remaining work silently stop working.

Bundling the version bump with the step is what makes a crash mid-step safe: the version only advances for a step that completed, so the next open retries it. Without that, a crash partway through building the baseline could leave a half-built schema that every later open would skip.

### Refusing a newer schema

A writable open reads the stored version and throws when it is greater than this build's, naming the found version, this build's version, and the two ways out (upgrade, or delete the file and let it be rebuilt). Because every surface that opens this file applies its own version comparison, the first surface to migrate locks every older one out of the machine-global file until it is upgraded too — which is why the version is a cross-surface release event rather than a local edit, and why a step that can be answered by a defensive *read* is preferred over one that needs a version bump.

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
| Version 0–4 | Writable open | Each missing step applied in its own immediate transaction, version stamped per step |
| Current version | Writable open | Untouched; modes re-asserted |
| Newer than this build | Writable open | Refused with a version-naming error; the file is not modified |
| Newer than this build | Read-only open | **Opened and read anyway** — no version check exists on that path |
| Any | Open below the runtime floor | Refused before the file is touched |

## Notable Behavior

- **The runtime-floor error tells the user to do something that cannot work.** Its message offers "upgrade the runtime, or run with the experimental flag" — but the gate that produced it compares the runtime's version string and nothing else, so supplying that flag on a runtime between the module's introduction and the flag-free floor leaves the verdict unchanged and the same error is raised again. The error itself is reachable (the long-lived server process raises it explicitly, and any ungated open would too); it is the *second half of its remedy* that is dead. (Surprising; reality.)
- **The read-only entry point never refuses a newer schema.** Only writable opens compare the version, so a reader on an older build opens a database migrated by a newer one and fails later, per query, on whatever it does not recognise. The surfaces that must not guess (routing, migration-state reporting) each carry their own version comparison rather than relying on the store.
- **The lifecycle call swallows every read failure except a version answer.** Corruption, a permission error and a sidecars-only residue are all indistinguishable "return silently" outcomes there, chosen precisely because none is a migration's job; the caller's own open is where the user finds out. (Notable.)
- **A missing version table is read as version 0, and so is a corrupt one.** The version read swallows every error and answers 0, so a damaged file is taken for an empty one and the first baseline statement is what actually fails — which is deliberate, since that statement's error is far better than one this read could produce. (Notable.)
- **The one surviving trigger refuses to delete a repository row, ever.** Repository rows are never deleted — disabling is an update of a timestamp column — and every other table references them with the default no-action rule, so a stray delete would already error where data exists. The trigger is what covers the zero-data case, and it survives the otherwise-absolute no-triggers rule because it encodes no business rule that can change, has no ordering relationship with any other trigger, and what it prevents is not a wrong value but the irreversible loss of every memory belonging to a repository. (Notable.)
- **Owner-only file modes are re-asserted on every writable open, but the sidecars usually are not covered by them.** The engine creates the sidecars when a write session starts, which is generally after the mode pass has already run, so the enclosing `0700` directory — not the file mode — is the boundary that actually holds. (Notable.)
- **Foreign keys are per-connection and default off.** Every open sets them, because a connection that forgot to would silently break every cascading delete in the schema — pruning a repository would leave orphaned rows behind rather than failing.
- **The editor host is expected to lose write races, and that is the design.** Its 400 ms wait is short enough that a contended write is dropped rather than freezing the interface; the data is re-derivable and its next periodic tick tries again. (Notable.)
- **The write-ahead log table keeps the repository identity string rather than the surrogate id**, and its identity column is deliberately not unique — the log's job is to get the raw event onto disk before anything is interpreted, which must not depend on a registry row already existing. (Notable.)
- **One table in the schema carries no repository column at all** — the commit-to-branch reachability table — and its boundary comes from the branch row instead, at the cost of one extra join. (Notable.)
- **The two halves have opposite loss semantics and are deliberately declared apart.** The activity half can be rescanned from git and each agent's own storage; the memory half is the only copy there is. Confusing the two is how data gets lost. (Notable.)

## Shared Behavior

- The runtime floor here is the same value the shared database-reading helpers for agent session stores enforce, and the same floor the package's declared engine range, the editor extension's declared host range, and the plugin bundles' build targets all encode. A change to one is a change to all of them.
- The classification of a database failure into contention / corruption / permission / schema-drift is shared with those agent-store readers, and is what decides whether an open is retried here.
- The database's identity key in `schema_meta`, the snapshot timestamp key and the last-used-folder key are written and read by the snapshot engine (349) and consumed by the deletion detector (348).
- The repository registry that the surrogate ids are projected from, and the per-repository control rows in the key/value table, are written by the import and cutover paths (344, 345) and read here only as storage.
- Which repositories route through this database at all, and which back-end a given read or write resolves to, are owned by 344 and 346.
