# 369. Session-Statistics Sync Channel

## Topic Statement

A second outbound HTTP channel, alongside the per-repository document push, that uploads rows of the machine-level memory database's **session-activity** tables to the user's Jolli organization. It is **machine-wide and cross-repository**: there is one database per machine, so one request carries whatever is new across every repository on it, the envelope has no repository field at all (each row carries its own repository identity), and no Space binding is involved anywhere — the API key already says which organization the rows belong to. What may leave is fixed by an explicit two-list **partition** over the whole schema rather than by a per-field pick; what has already left is recorded as a per-table keyset cursor in the channel's own machine-level state file, filed under the backend scope it was delivered to; and which repositories are withheld is a **row filter inside the select**, not a gate, because a gate can only answer for the one repository that happened to trigger the run.

## Scope

**In scope:**

- The two lists that decide what leaves the machine, and why the partition — rather than either list on its own — is the enforcement mechanism.
- The columns each synced table sends, the single rewritten column, the single excluded column, and the value-passthrough rule.
- The privacy surface this channel opens, stated as behavior.
- The request envelope, the response the client reads, and the response shapes it refuses.
- The channel state file: where it lives, what it holds, how a scope key is formed, and what every class of damaged file reads as.
- The gates, in order, and precisely which of them a forced run bypasses.
- The per-repository disable filter: where it is applied, why it is fail-closed, and what it costs a re-enabled repository.
- Selection and keyset paging on the per-table write stamp, and the first-run window that applies only while a table has no cursor.
- The batch loop: its per-table limits, its per-run ceiling, its truncation-based termination, the one reconciliation request an empty batch is allowed, and when cursors are persisted.
- Cursor adoption from the server, and the cursor-ahead conflict with its retry ceiling.
- Failure classification by error class, and the per-scope silence it writes.
- Reporting: the once-per-process memo and the one skip that stays silent.
- Concurrency: the absence of any lock, and what the database side does instead.
- Database-rebuild reconciliation.
- The three triggers, and which one forces.

**Boundaries (consumed here, owned elsewhere):**

- The database file, its two-half schema, the write stamps and keyset indices this channel pages on, the stored instance identity, owner-only permissions and the runtime floor that decides whether the file can be opened at all are defined by **Machine-Level Memory Database: Store, Schema and Migration Ladder** (347). Only the tables and columns that reach the wire are stated here.
- How those activity rows come to exist — the event log, the projection, the write stamps' bumping rule — is defined by **Dashboard Database Write Protocol** (354); the bulk reconciliation that rewrites old rows' stamps by **Dashboard Database Repository Backfill** (350).
- The credential, the client and tenant headers, the origin resolution and the request-correlation header this channel shares with the document push are defined by **Summary Push to Jolli Space** (94); the origin/tenant split by **Tenant Resolution Modes** (97).
- The repository registry file, its identity derivation and its remote-less fallback are defined by **Dashboard Repo Registry and Probe** (355) and **Canonical Repo URL and Name Derivation** (232); the disable flag itself by **Repo-Wide Manual Disable Flag** (145).
- The per-repository outbound-push opt-out, which this channel deliberately does **not** consult, is defined by **Per-Repo Outbound-Push Control** (310).
- The configuration key's own validation and command-line surface is defined by **`jolli configure`** (62); the diagnostic flag that forces a run by **`jolli doctor`** (59); the settings form that hosts the machine-wide switch by **Dashboard Settings Apply** (363) and **Local Dashboard Browser Application** (356).
- The resident process whose scheduler asks this channel whether it is due is defined by **Machine-Global Resident Daemon** (365); the drain whose tail fires it by **Git Operation Queue Worker** (34).
- Server-side ingestion, storage and day-bucketing of the uploaded rows are backend concerns.

## Data Contracts

### The partition: what leaves, and what may never

Every table in the schema must appear in **exactly one** of two lists, and that is the mechanism rather than documentation: a new table lands in neither list and fails a test, which is the moment the decision gets made instead of the moment it silently starts uploading or silently does not. The check runs in both directions, so a dropped table cannot leave a name behind pretending to protect something that no longer exists, and the two lists are asserted disjoint. The reverse direction carries one exemption: the internal autoincrement-sequence table, which does not exist until such a row has been inserted, so it is legitimately absent from a database that is otherwise complete.

**Sent** — the session-activity half:

| Table | What it is |
| --- | --- |
| `sessions` | One row per observed conversation. |
| `session_model_usage` | That conversation's tokens and cost split per model. |
| `session_tool_use` | Per tool name and kind: call count, last-call instant, and the MCP server behind it. |
| `session_usage_events` | One narrow row per counted model response. Added after the other three, and the one that makes a per-day figure correct: a session row carries its cumulative total under a single timestamp, so a conversation spanning three days would otherwise put all of its spend on the last one. |

**Never sent**, each for its own reason:

| Reason | Tables |
| --- | --- |
| The conversation text itself | `transcripts`, `transcript_sessions`, `memory_transcripts` |
| The content of uncommitted changes | `worktree_status` |
| Local bookkeeping — machine-local integer ids, ingest cursors, queue and repository state | `events_raw`, `ingest_cursors`, `repo_state`, `repos`, `schema_meta`, `schema_migrations`, `sqlite_sequence` |
| Written locally on every recall, read by nothing on the other side | `recall_receipts` |
| Derived locally and re-derivable there, and the one table that carries a timezone | `stats_daily` |
| The memory half, which travels on the document-push channel with its own binding rules | `memories`, `memory_topics`, `commits`, `commit_files`, `commit_aliases`, `commit_branches`, `branches`, `context`, `context_kinds` |
| Not read by the pages this channel feeds | `plan_progress`, `topic_pages`, `topic_source_refs`, `topic_processed_sources` |

Two exclusions have live consequences worth stating. **No timezone travels on this channel**: every time value on the wire is an epoch-millisecond instant, the envelope carries none, no header carries one, and the single timezone-bearing table is excluded precisely so the server can bucket days on whichever zone the *reader* asks for. And **the recall-receipt table left the channel while keeping its channel-shaped schema**: its write stamp and both of the indices behind this channel's paging remain (they have already been migrated, so they are frozen rather than worth an entry to remove), the stamp is still bumped on every receipt, and nothing reads any of it.

Column coverage is asserted per synced table in both directions, and a blunt second net forbids any sent column whose **name** matches transcript, content, body or text — under any table.

### Columns, and the two departures from verbatim

The payload is `{table: rows}` with the database's own column names verbatim and **values untouched** — millisecond integers stay integers, a JSON-string column stays that string. One name, from local column through JSON field to server column, so a mismatch is a bug rather than a translation table to maintain.

Exactly **one** column is rewritten: the machine-local surrogate `repo_id` becomes `repo_identity`, and it is **joined out in the select** rather than mapped afterwards, so the identity rides on the row — which is what makes one request able to carry several repositories at once. The integer could not be sent: it is an autoincrement, so the same repository is one number here and another there, and the rows would attach to whichever repository happened to hold that number on the server. The identity is taken from the repository table's own column, deliberately not re-derived from the canonical-URL helper: a repository with no usable remote is a `local:` prefix plus a hash of its worktree root in that column, a substitution the schema made on purpose because the helper's own fallback is a `file://` URL carrying an absolute path and a home directory, and that must never reach this wire.

Exactly **one** column is held back: the tool-use table's `metadata_json`, dropped from the schema definition long ago but still present on older databases, with no writer and no reader. It is exempt from the "every sent column must exist" direction of the coverage check for that reason.

### The privacy surface

Stated plainly, because it is the largest change this product has made to what leaves a machine: until this channel, data left only for a repository the user had explicitly bound to a Space. These rows go up for **every** repository the machine has enabled — private projects, client work, repositories never intended to be connected to anything — because the API key alone says where they belong. What that means concretely:

- **Session titles** are sent, and several agent hosts populate a title from the user's own first message.
- **Tool names and MCP server names** are sent.
- **The canonical identity of every repository** whose activity the database holds and which is not withheld — bound to a shared Space or not, and whatever the per-repository push switches say.

Conversation text is not sent, and the partition plus the name net are what enforce that.

### The request and the response

| Property | Value |
| --- | --- |
| Method | `POST` |
| Path | `/api/push/jollimemory/sessions` |
| Origin, credential, client/tenant/org headers, correlation header | The document push's, unchanged (94). |

The body is one JSON object: a protocol `version` (`1` — this channel's only protocol), the installation's own stable `clientId`, a `cursor` map carrying **only** the tables that have one (an absent entry means "first run for this table"), and a `tables` map carrying **only** the tables that have rows.

The response the client reads is an `accepted` count map and a `cursor` map holding, per table, either a cursor object, a bare number, or an explicit `null`. A bare number is accepted and read as that stamp with an empty key — deliberate wire tolerance, since the client and the backend deploy independently: a backend that echoes only a stamp keeps working at the cost of re-delivering one millisecond per pass into an upsert, and what it must not do is push the client back to stamp-only paging.

Two response shapes are refused rather than read. A **non-2xx** is raised by status, with `404` and `412` each carrying their own class (below). And a **2xx whose body does not parse as JSON** is raised as the *same class as a missing endpoint*, because a single-page application answering an unknown route with its index document is otherwise indistinguishable from a deployed endpoint: the defensive parse turns that markup into an empty object, both fields read as empty, the caller falls back to its own high-water mark, and the cursor advances over rows that reached nobody.

### The channel state file

A machine-level JSON file beside the global configuration, written with owner-only permissions into an owner-only directory. Machine-level is a correctness requirement, not tidiness: the run is cross-repository over the one machine-level database, so a per-project file would have three open projects keeping three records of the same progress and each of their triggers pushing the whole machine again. It is deliberately **not** the user's configuration file, so runtime state and settings cannot overwrite each other, and the module holding it imports nothing that reaches the database.

| Field | Role |
| --- | --- |
| `version` | `1`. Anything else reads as absent. |
| `clientId` | This **installation's** stable id, generated once. Not the database's identity, which changes exactly when resuming matters most. |
| `dbInstanceId` | The database's own instance identity as of the last recorded run — the rebuild witness. |
| `lastAttemptAtMs` | The throttle mark. Written on failure too, unlike the cursors. |
| `silencedByScope` | Per-scope expiry instants for the refusals that cannot be retried into success. |
| `byOrigin` | Per-scope, per-table cursors. |

A **scope** is the backend origin plus its optional tenant slug (`https://host[/tenant]`). The tenant is part of the key because one origin serves many and neither a cursor nor a refusal carries across them; the slug is read the same way the request's own tenant header is derived, so the key cannot disagree with the tenant the rows went to. The field name stays `byOrigin` so existing files keep their place: a **bare-origin key written by an earlier build is consulted as a legacy fallback**, and only when the scoped key is **absent**. An entry that exists but holds no cursors blocks the fallback — which is exactly what this scope's database-rebuild reset writes, so a reset scope resumes from the first-run window rather than sliding back onto a legacy position.

A cursor is a **write stamp plus the primary key of the last row sent**, in the key order this build declares. An empty key means the start of that millisecond, which is what lets a bare stamp be a valid position on the same scale without skipping a row.

Damage handling is uniform and one-directional:

| On disk | Read result |
| --- | --- |
| Missing, unreadable, or unparseable | Fresh state |
| `version` not `1`, or `clientId` absent or empty | Fresh state |
| A cursor entry that is junk | **Absent**, not zero — see below |
| A silence entry that is not a finite number | Dropped, i.e. "not silenced" |
| A legacy machine-wide silence field | Read past and **dropped**, never folded onto the scopes |

A junk cursor reading as *absent* rather than as stamp zero is the milder of the two available wrongs: absent means "first run", which applies the window, while zero would mean "deliver everything ever recorded" — a corrupt file would push a machine's whole history. A garbled silence reading as "not silenced" costs one request against a backend that will refuse it and write the mark again, where refusing to run over a malformed bookkeeping value would stop the upload with nothing able to repair it. And dropping a legacy machine-wide silence is what stops the outage it recorded from being carried across the upgrade that fixes it.

**Reads never write.** Only the load a run performs once it has decided to proceed persists a freshly generated installation id, and it does so **before** the run rather than after it succeeds: the server keys its own cursor on that id, so a client minting a new one per failed attempt would look like a new machine every time and be handed an empty cursor for ever.

### The write stamps, the keyset, and the window sources

Selection walks a per-table **write stamp** — bookkeeping for "when did we last write this row", bumped unconditionally to the current wall clock on every write and never to an instant carried on an event. The names are **not uniform**, and the exception is the one that matters: the session table's `updated_at_ms` is already its business clock, and the commit-summary projection deliberately does not bump it when it enriches a partial row into a full one, so a cursor keyed on it would never see the better token split it just wrote. That table therefore stamps `written_at_ms`; the three child tables stamp `updated_at_ms`, which on them is free.

Three of the four are declared non-null with a zero default. The per-response table's stamp is declared non-null with **no** default, because it was part of that table's own creation rather than added to an existing one. Nullability cannot be relaxed anywhere: a comparison against null is null rather than false, so one nullable stamp is a row no cursor can ever select, for ever, with nothing reporting it. And on real databases the three that arrived by **column-addition are permanently nullable** — a database handed those columns by an earlier build has the addition recorded as already-satisfied rather than applied, so neither the non-null declaration nor its backfill ever ran, and the constraint cannot be restored afterwards. A separate **null-backfill** step exists for exactly that: it gives every such stamp a number (zero meaning "written before this was tracked", which the first run sends once), and it is what keeps those rows selectable at all.

| Table | Write stamp | Keyset (tie-break, in key order) | First-run window source |
| --- | --- | --- | --- |
| `sessions` | `written_at_ms` | `event_id` | own — `updated_at_ms` |
| `session_model_usage` | `updated_at_ms` | `session_event_id`, `model` | **parent** — the owning session's clock, via `session_event_id` |
| `session_tool_use` | `updated_at_ms` | `session_event_id`, `tool_name`, `kind` | own — `last_call_at_ms` |
| `session_usage_events` | `updated_at_ms` | `session_event_id`, `dedup_key` | own — `responded_at_ms` |

A stamp alone cannot page a table, and the failure is a **stand-still rather than a slowdown**: rows written together share a stamp by construction (one session's usage events are all stamped with one instant, and a bulk reconciliation projects many sessions inside one millisecond), so when more rows share a millisecond than a batch holds, every pass reads the same first page, the highest stamp it sees equals the cursor it started from, and the table stops syncing for good. The cursor is therefore the tuple, the comparison a row-value comparison, and the ordering **exactly** the tuple in exactly that order — a mismatched ordering does not error, it silently pages over rows. Every keyset column must also be on the wire, because the next cursor is read off the row that was just sent.

The window source is a **two-case union**, and the shape is the invariant: every table has exactly one answer, so "no window at all" cannot be expressed. Two optional maps could express it and did, which is how one table's first run walked the whole table — including children of the very sessions the same window had withheld, leaving the server usage it could file under no session it had been sent.

### Limits

| Limit | Value |
| --- | --- |
| Rows per request, `sessions` / `session_model_usage` / `session_tool_use` | 200 each |
| Rows per request, `session_usage_events` | 500 — one narrow row per model response |
| Batches per run | 10 |
| Consecutive cursor-ahead conflicts tolerated | 2 |
| First-run window | 90 days |
| Minimum gap between attempts | 30 minutes |
| Silence after a refusal, per scope | 24 hours |
| Skip reasons remembered per process | 64 |

The per-request body must stay well under whatever gateway sits in front of the server: a body-size refusal arrives as a status indistinguishable from a transient failure.

## Behaviors (execution order)

### Deciding to run

Four gates, in this order, each answering "skipped" with a reason and never throwing at the caller:

1. **The channel's own configuration switch set to an explicit `false`.** An absent value means **on** — the read tests only for the explicit negative. It is deliberately its own switch and must not be folded into the push-on-sync flag or the per-repository push toggle: those mean "push this repository's memories", and the decision here is precisely that statistics do not follow that rule, so sharing a switch would make the setting describe something it does not control.
2. **No API key.** No credential, nowhere to send.
3. **A runtime that cannot open the database unflagged.** A **version comparison only** — the running runtime's version against the floor, never a probe, so asking the question does not itself emit the experimental warning. Skipped whole, never an error: the rows stay put and the next capable runtime sends them. A machine that never created a database is **not** this gate; it surfaces later as a throw from opening the file, and is caught (below).
4. **The throttle** — one file read, comparing the recorded last-attempt instant against the minimum gap.

A **forced** run bypasses the throttle **and** a silence, and nothing else. It never bypasses the switch, the key or the runtime floor: those three are reasons a run refuses, not conditions a forced run can argue past. The force must cover the silence rather than only the throttle, because a silence is a 24-hour bet that the server's answer will not change, and the moment an operator fixes the server that bet is wrong — without a bypass the only way out was editing the state file by hand.

The throttle answer is deliberately **the throttle only, never the silence**: a silence belongs to one scope, and the scope is not known until the credential's base URL has been resolved, which is the run's own job. Consulting it earlier would have to read the mark scope-blind, which is the machine-wide behaviour the per-scope map exists to remove — and a silenced scope is still bounded by the throttle anyway, so the cost of the split is one configuration read per half hour rather than one per tick.

Anything thrown on the way — a missing database file, which is a normal state on a machine that has never enabled a repository, or a key with no resolvable URL — is caught, reported once, and returned as a skip. The missing-file throw comes from the first open, which is **after** the throttle, **after** the attempt mark and **after** the registry read: such a machine still writes an attempt mark every half hour and still reads its registry, and only then skips.

### Resolving the scope, and marking the attempt

The run resolves its base URL, derives its scope key and the legacy bare-origin key, then **writes the attempt mark immediately** — before the silence check, and whatever happens afterwards. It is a throttle, not progress: a mark that moved only on success would have every trigger retry a request that is going to fail the same way, and a silenced scope that left it alone would be re-resolved on every tick instead of once per window.

Then the silence: a scope whose recorded expiry is still in the future stops the run, with a line naming the hours left and the diagnostic command that forces a retry. A **forced** run through a silence logs unconditionally rather than through the once-per-process memo — an explicit run is something the user just did, so the answer to "why did my forced sync try a backend that was refusing?" has to be in the log for *that* run.

### The disabled-repository row filter

The identities of every registered repository the manual disable flag is set on are collected **once per run**, and become a predicate **inside** the select. It is a filter and not a gate, and that is the only shape that can keep the promise the settings copy makes: a gate can answer only for the repository that triggered the run, while every other repository's rows are in the same batch — so a gate both let a disabled repository's backlog out through any other trigger and, when it did fire, stopped the whole machine over one switched-off repository.

Three properties are load-bearing:

- **The registry read is strict — the one fail-closed read on this channel.** A registry that exists and cannot be trusted — unreadable, or parsed but carrying no repository list — fails the whole run rather than degrading to "nothing is disabled". An **absent** registry is deliberately not a failure: a machine that has registered no repositories has nothing to withhold, so it reads as an empty list. Every other read here fails open because the cost of being wrong is a slower page or a delayed upload; the cost here is shipping statistics from a repository whose owner switched the product off, and no later run can take that back. The throw lands in the run's own catch and becomes a skip with a line in the log.
- **Disabled-ness is asked of every live checkout, through the same predicate the import path uses**, so "which repositories do I import", "which does the database call paused" and "which do I withhold from the wire" cannot be three predicates that disagree. A registry row is one repository *identity* while the flag is per clone, so one clone still enabled means the repository is.
- **The identities come from each repository's own profile, never from the database's disabled column.** That column is a projection only the import writes, so it stays set for a while after a re-enable — and a row skipped during that lag is skipped for ever, because the cursor pages over it.

Only the session table carries the identity directly; the three child tables reach it through their parent session, spelled so that a row is withheld **only when it can be proven** to belong to a disabled repository — a child whose parent session is missing keeps the behaviour it had before, because this predicate is not the place to start dropping rows for a second reason. A synced table carrying neither column would be a privacy decision nobody has made, so it throws rather than send everything, and the caller turns that into a skipped run; **no such table exists today** and the column-coverage assertions are what keep it that way. (Unreachable.)

### Database-rebuild reconciliation

The database's own instance identity is read **without minting one** — the whole path is read-only, and a sync must never be the thing that first writes to the database. Then:

| Recorded | Read | Result |
| --- | --- | --- |
| anything | absent | **Nothing changes.** "Cannot verify" is not "do not bind". |
| absent | present | First sighting: bound, **no reset**. |
| present | different | **This scope's** cursors dropped, the new identity recorded, and a line logged. |

Only the current scope, and the recorded identity moves on the first run that notices — so a scope this machine has not talked to since the rebuild keeps a cursor that may sit above every local row and will never be reset from here. That is deliberate: it self-heals through the server, which is the only party that knows what a given backend actually holds, and the empty-batch reconciliation below guarantees one request per window even with nothing to send. Resetting every scope instead would re-send the whole window to every backend the machine has ever used, on the strength of a rebuild that says nothing about what any of them received.

### Reading one batch

Per table, per pass: a row-value comparison of `(stamp, …keyset) >= (cursor)`, ordered by that same tuple, limited to the table's batch size, with the window and the exclusion **both inside the select**. The comparison is **at or after**, not after: a cursor that steps over a row never revisits it, and re-sending costs nothing because the server upserts — with the key in the tuple that costs exactly one duplicated row per batch, the boundary row, instead of a whole millisecond.

A stored cursor's key is **padded or truncated to this build's width**. A position adopted from a backend that echoed only a stamp has no key at all, and a schema change could alter the width; padding puts the read at the start of that millisecond and truncating is the same trade in the other direction. Neither can skip a row, which is the only outcome that would lose data.

### The first-run window

Applied **only when a table has no stored cursor**, **inside** the select so the limit counts only rows that will actually be sent, and on the table's **business** clock rather than its write stamp. Both placements are the fix for a specific silent wrong:

- Filtered on the **result** instead of inside the select, the window sits on the wrong side of the limit: a table whose oldest page is entirely outside the window comes back with nothing kept, so no stamp is learned, so the cursor never moves, and that table stops syncing **permanently** with only a "skipped N rows" line to show for it. Not a corner case — the migration backfills the session write stamp from the business clock, so stamp order tracks business order, and any machine with more than one batch of old sessions starts there.
- Filtered on the **stamp** instead of the business clock, a bulk reconciliation that rewrote every old row's stamp to "just now" makes the window admit sessions from years ago.

A row whose own clock is null has no date to be judged on and is **kept**. The one table with no clock of its own is windowed through its parent session, which also drops a row whose parent session is missing outright — right for the same reason, since it could not be filed anywhere on arrival.

The run also reports what the window declined: a **whole-table** count of rows outside it, per table, summed across tables and logged on **every batch pass** — a plain information line, outside the once-per-process memo. A table that comes back with zero rows learns no stamp and therefore keeps no cursor, so the window still applies to it on the next pass and the identical figure is logged again, up to the run's ten-batch ceiling. The count is deliberately blind to the disable filter (that is a different question with its own line), and it is a separate query precisely because the window is inside the select, so the rows it excludes never reach the caller to be counted.

### The loop

Up to the per-run ceiling of ten batches:

1. Read every table's slice with the current scope's cursors.
2. If **every** table is empty: stop — unless the cursor is non-empty **and** this run has not already let an empty batch through, in which case exactly **one** request goes out anyway. The guard is a per-run **allowance flag set only when an empty batch is let through**, not a check on whether the run has made a request: a run that already sent several full batches and then reads an empty one still spends its one allowance on it. Reconciliation happens on requests, so a client whose cursor sits above every local row would otherwise never contact the server at all — which is exactly the shape of being pointed at a fresh backend: nothing new to send, so nothing discovers the new backend has none of it. One small request per window closes it.
3. Send. On success: count the rows, adopt a cursor, **persist the state file**, and stop **unless some table filled its limit**.
4. Termination is on **truncation**, not on emptiness and not on the cursor. Because selection is at-or-after, the row sitting exactly on the cursor is re-read on the next pass, so a loop that stopped only when a batch came back empty would re-send that boundary row until the run ceiling. Asking "was anything truncated?" answers the real question directly, and it is safe to loop on only because the cursor is a keyset and therefore advances by at least one row per pass.

Cursors are persisted after **every** successful batch, so partial progress survives a crash or a later failure in the same run. Reaching the ceiling still reports **success**: stopping early is not a failure, and the cursor is exactly the mechanism that makes the rest someone else's turn.

### Adopting a cursor

Per table, in this precedence:

| Server said | Client takes |
| --- | --- |
| A cursor (object, or a bare stamp) | **The server's.** It is the authority on what it holds, and taking its word is what lets a restored-from-backup server pull the client back. |
| An explicit `null` | **Clears** the cursor. "This backend has no record" must read as lower than anything rather than as no opinion, or the client carries on from its own high-water mark and the range below it never reaches that backend. |
| Nothing about that table | The **batch's own last row** on a success, then what the client already held. The fallback is what guarantees the loop advances: a server that echoes no cursor would otherwise leave the same rows selected for ever and burn the whole ceiling re-sending them. |

The next cursor is the **last row of the page**, not the largest stamp seen — different answers, because the ordering *is* the keyset, so the last row is the maximum of the tuple that actually pages the table. Taking the largest stamp is what stood still inside a millisecond.

### The cursor-ahead conflict

A `409` naming a cursor-ahead condition carries the server's own cursor, and the client adopts it **downwards** and re-sends that range: the server is missing a range the client believed delivered, and only lowering re-sends it. The mundane case is switching an install from one backend to another; a wiped, rolled-back or restored server is the same shape. A server with **no** record must answer this rather than a success, because "no opinion" is the one reading that loses data.

The conflict is not counted as a batch. Consecutive conflicts are tolerated twice; a third ends the run as **failed**, because a server whose cursor keeps moving backwards under the client is a spin, not a recovery.

### Failure classification

Every branch dispatches on the error **class**, never on the message text, and every branch logs — the classification is the point of the step rather than a detail of it, because both automatic callers discard the returned outcome, so a scope going quiet with no line anywhere is exactly the failure this channel shipped.

| Class | Silences the scope? | Behavior |
| --- | --- | --- |
| Not authenticated (`401`) | **No** | Warns. A key is re-issued by the user, and the next attempt after they do must go through — so this one will not clear on its own and is logged at warning level rather than silenced. |
| Permission denied (`403`), client outdated (`426`), endpoint missing (`404` **or** a 2xx that did not parse) | Yes, 24 h | Warns, naming the scope. Both ways a deployment says "no such endpoint" share one class because they call for the same answer here. |
| Precondition failed (`412`) | Yes, 24 h | Warns with its **own** wording. Should be unreachable — this channel needs no binding — so if one arrives, the server has made a binding a precondition after all and that disagreement must be findable rather than retried into the ground. (Expected-unreachable.) |
| Anything else | No | Logged at information level and returned as its message. |

Two orderings are load-bearing on the client side. The endpoint-missing and precondition classes are keyed on the **status**, replacing message-text matching that an ordinary gateway body defeated — a body of plain "Not Found" is raised as that prose, matches no status pattern, and was therefore retried every half hour for ever, which is precisely what the silence exists to prevent. And the non-parsing-2xx check raises the **same class as a missing endpoint**, so the caller cannot come to recognise it by a phrase.

**None of these clears the repository-to-Space binding cache** — deliberately unlike the document push, which clears it on the same statuses. There those really are answers about a binding; here they are answers about a scope, and clearing it would make an unrelated, user-visible Space display go briefly degraded over a failure that has nothing to do with Spaces.

A silence write **prunes expired entries** for other scopes on the way through, so a machine that has talked to several backends over its life does not accumulate them.

### Reporting

Skip reasons are logged at information level **once per process**, through a memo. The reasons are conditions that hold for hours — a switch the user turned off, a backend refusing this scope — and every trigger on the machine asks again, so logging each one every time buries the log while logging none of them is what let a 24-hour silence leave no trace anywhere. A long-lived resident process therefore states each reason once; a short-lived hook process states it once per commit.

The memo is capped at 64 keys and **cleared wholesale** on overflow, because one of its keys is not drawn from a fixed set: the catch-all keys on the thrown message, an arbitrary string that in a long-lived process could carry a path, a port or a timestamp and grow without bound. Degrading to "state this reason again" is acceptable; the memo is a nicety, never a correctness matter.

**The throttle skip is the one that stays silent** — it is the normal case, it resolves itself within the half hour, and it is the only skip that cannot be a misconfiguration.

### Concurrency

**There is no lock anywhere on this channel.** The state file is written non-atomically, the throttle is an unsynchronised read-then-write, and three producers can overlap; a run marks its attempt at the start rather than the end, which narrows the window but does not close it. Overlapping runs cost duplicate delivery into an upsert and a last-writer-wins on the cursor map, not corruption. A failed write of the state file is swallowed at debug level, because a bookkeeping file must not fail a caller.

The database side is safe by construction: a **read-only** handle is opened and closed per read — one for the instance identity, one per batch — with no transaction, no write, and no minting of the identity.

### Triggers

- **The resident daemon's scheduled task**, asked every **5 minutes**. Deliberately shorter than the upload's own half-hour period, and equal is the bug that looks like the tidy choice: the due-ness test is at-or-after, so a tick of exactly the period lands on the boundary and any negative jitter answers "throttled" and pushes the real upload out to an hour — presenting as the feature working at half the rate it claims. Asking often and being told no costs one file read.
- **A fire-and-forget call at the tail of every commit-queue drain**, never awaited and with its rejection swallowed. Placed **outside** the drain's "did any summary land" check, because most sessions never produce a commit at all and gating on new summaries would mean a machine only ever syncs the conversations that happened to end in one. Not awaited because everything above it in the worker runs under a five-minute lock and one network round trip inside that window would delay every other worker on the machine.
- **The diagnostic command's explicit sync flag** — the only trigger that forces, and the documented way out of a silence. It prints one of three outcomes: up to date with nothing new; uploaded N rows in M batches; or not uploaded, naming the reason, exiting non-zero only for an outright failure.

The daemon task and the commit-path call are complementary rather than redundant — the commit trigger covers the command-line user who never opens an editor, the daemon covers everyone else — and both go through the same throttle, so having two costs nothing. Neither passes a working directory: the channel is cross-repository, and a machine-level trigger has no single repository to ask about.

## State Transitions

### The channel state file

| From | Event | To |
| --- | --- | --- |
| Absent / unreadable / unparseable / wrong version / no installation id | A run decides to proceed | Fresh state, **persisted immediately** so the installation id exists before the first request |
| Any | A run starts | Attempt mark set to now — on success **and** on failure |
| Any | Refusal by permission, outdated client, missing endpoint, or precondition | That scope silenced for 24 h; other scopes' expired entries pruned |
| Any | Not-authenticated | **Unchanged** apart from the attempt mark |
| Recorded database identity absent | Identity read | Bound, cursors untouched |
| Recorded database identity differs | Identity read | **That scope's** cursors dropped; new identity recorded; persisted by the next write this run performs |
| Recorded database identity present | Identity unreadable | Unchanged |

### One table's cursor

| From | Event | To |
| --- | --- | --- |
| Absent | A run starts | Treated as **first run**: the 90-day window applies to this table only |
| Absent or set | Batch sent, server named a cursor | The server's, verbatim (a bare stamp becomes that stamp with an empty key) |
| Set | Batch sent, server answered `null` | **Cleared** — back to first-run behaviour |
| Set | Batch sent, server silent about this table | The batch's own last row; if the table sent nothing, unchanged |
| Set | Cursor-ahead conflict carrying a lower cursor | Lowered to the server's, and that range re-sent |
| Set | Cursor-ahead conflict a third time | Unchanged; the run fails |
| Set | This scope's database-rebuild reset | Dropped |
| Junk on disk | Read | **Absent** (first run), never stamp zero |

## Notable / Surprising Behavior

- **The partition, not either list, is the enforcement.** Sending tables verbatim inverts the default to "everything new goes up", which is a real hazard this repository has already paid for once elsewhere — so a new table or column fails a test until somebody decides, and a failure must not be answered by widening a list. (Central design point.)
- **A disabled repository's backlog is never uploaded, and re-enabling does not send it.** The exclusion is inside the select, so selection pages **over** an excluded row and the cursor advances past it. The settings copy says exactly this. Sending on re-enable would need a per-repository cursor; holding the cursor back instead would let one switched-off repository's single row block every other repository on the machine. (Surprising; deliberate, and documented in the interface.)
- **The first-run window is not a standing filter.** It applies only while a table has **no** cursor, and disappears entirely once one exists — after which any row whose write stamp sits at or after the cursor is sent regardless of how old its business clock is. Only rows whose stamp sits below the cursor the first page established are genuinely never sent, and a bulk reconciliation that rewrote old rows' stamps puts them above it. (Surprising; the trade is deliberate, its reported figure is not — see below.)
- **The strict registry read is the one fail-closed read on the channel**, and everything else fails open. The asymmetry is the point: a delayed upload is recoverable, a leak from a repository the user switched off is not. (Notable.)
- **A cursor is a tuple because a stamp deadlocks.** More rows can share one millisecond than a batch holds, and then the cursor stands still and that table stops syncing for good. Rows written together share a stamp by construction, so this is the normal case at scale rather than a pathological one. (Surprising; the obvious cursor is the broken one.)
- **The comparison is at-or-after, so the boundary row is re-sent once per batch**, and the loop therefore terminates on **truncation** rather than on emptiness. Both halves are needed: the duplicate is deliberate (the server upserts), and stopping on emptiness would re-send it until the run ceiling. (Notable.)
- **Three concepts of time coexist per table and confusing any two is silently wrong**: the write stamp the cursor walks, the business clock the window filters on, and the wall clock the stamp is bumped to. The stamp names are not uniform for exactly this reason. (Notable.)
- **There is no lock on this channel at all** — non-atomic state writes, an unsynchronised throttle, and three overlapping producers. The database side is protected instead, by opening read-only per read and never minting the instance identity. (Notable.)
- **A rebuild resets only the scope the run is talking to.** Every other scope keeps a possibly-unreachable cursor and is repaired by the server, which is the only party that knows what it holds — which is also why an empty batch is allowed one reconciliation request per window. (Surprising; the narrower behaviour is the correct one.)
- **A 2xx whose body does not parse is a *missing endpoint*, not a success.** Without that check a single-page application answering an unknown route with its index document is indistinguishable from a deployed endpoint, and the code records exactly that outcome: the channel reported success while nothing had ever been ingested. (Notable; this is the check whose absence was the channel's worst failure.)
- **A success body that omits both the accepted counts and the cursor is treated as full success.** The accepted counts are read by nothing at all, and a well-formed JSON body carrying neither field yields two empty maps — so the run counts every row it sent as sent and the cursor advances to the batch's own high-water mark, over rows the server never stored. Only a body that fails to *parse* is caught.
- **A cursor-ahead conflict that omits the corrective cursor cannot be acted on.** The adoption falls back to what the client already held, so the identical batch is re-sent until the retry ceiling and the run reports failure **without silencing** — repeating in full on every later trigger.
- **The declined-rows figure overstates itself.** It is documented as rows the table will never send, and logged as rows being skipped, while the window it reports is gone the moment that table has a cursor — so a row it counted can go out on the very next page of the same run.
- **The withheld-repository line is keyed on a count.** The once-per-process memo key is the *number* of withheld repositories, so switching a different repository off without changing how many are off states nothing new. (Surprising.)
- **A boolean "is this scope silenced" helper exists beside the one that reports the remaining time, and no production path calls it** — every caller needs the expiry in order to say how long is left. (Unreachable from production.)
- **An accessor over the window-source union exists — "this table's own business clock, or nothing" — and no production path calls it either.** The window predicate reads the union's two arms directly, so the accessor's "or nothing" answer is only ever produced for a test. (Unreachable from production.)
- **The channel needs no Space and consults no binding**, which is why a precondition-failed response is classified as an expected-unreachable disagreement rather than routed into the document push's binding flow — and why none of its failures touch the binding cache. (Notable; shared boundary with 94 and 310.)
- **An absent configuration value means on.** The read tests only for an explicit negative, so the largest-footprint outbound channel in the product is opt-**out**. (Notable.)

## Shared Behavior

- The database file, schema, the write stamps and the keyset indices this channel pages on, the stored instance identity and the runtime floor are owned by **Machine-Level Memory Database: Store, Schema and Migration Ladder** (347); the instance identity's other consumer by **Memory Database Deletion Detection** (348).
- The activity rows themselves, their projection and the unconditional stamp bump are owned by **Dashboard Database Write Protocol** (354); the bulk reconciliation that rewrites old rows' stamps by **Dashboard Database Repository Backfill** (350).
- The credential, the client/tenant/org headers, the correlation header, the origin resolution and the sibling document endpoint are owned by **Summary Push to Jolli Space** (94); the origin/tenant split by **Tenant Resolution Modes** (97); credential storage by **Auth Credential Storage** (56).
- The manual disable flag this channel filters on is owned by **Repo-Wide Manual Disable Flag** (145); the registry it reads the identities out of, its identity derivation and the shared disabled-ness predicate by **Dashboard Repo Registry and Probe** (355) and **Canonical Repo URL and Name Derivation** (232).
- The per-repository outbound-push opt-out this channel deliberately does not consult is owned by **Per-Repo Outbound-Push Control** (310).
- The configuration key's validation and command-line surface is owned by **`jolli configure`** (62); the forcing flag by **`jolli doctor`** (59); the machine-wide switch's immediate-apply settings row by **Dashboard Settings Apply** (363) and **Local Dashboard Browser Application** (356).
- The scheduler that asks this channel whether it is due, and the rule that a task owns its own due-ness, are owned by **Machine-Global Resident Daemon** (365); the drain whose tail fires it by **Git Operation Queue Worker** (34).
- The tool-name and MCP-server classification behind the tool-use rows is owned by **Transcript Tool-Call Tally and MCP Classification** (357); session titles by **Session Title Resolution Chain** (182).
- The per-day rollup cache this channel excludes, and the reader-side day bucketing that replaces it on the server, are owned by the dashboard read model (**353**).
