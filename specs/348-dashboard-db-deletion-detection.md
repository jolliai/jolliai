# 348. Memory Database Deletion Detection

## Topic Statement

Deciding whether the machine-level memory database is still the file a process thinks it is — and, when the database is gone, telling a genuinely fresh install apart from a deletion and from unrelated stale residue — using an inode-level liveness test, a table over which of the three on-disk files are present, and a minted identity stamped into two independent witnesses.

## Scope

**In scope:**

- The inode-level liveness test that decides whether an open handle still names what the path names.
- The file-combination table: every state it distinguishes, including the one alarming combination, and why an incomplete file set is normally *not* an alarm.
- The identity verdict table for an absent database, and the exact rule that separates a fresh install from a deletion from ambiguous residue.
- The two identity witnesses — where each is stamped, when, and what a read of each answers when it cannot be read.
- Every consumer of the file-combination answer, and the deliberately different meaning two of them assign to the same "nothing is there" state.

**Out of scope (boundaries):**

- The database itself, its schema, its permissions and its migration ladder (347).
- Snapshots, their retention, and the restore that repairs a detected deletion (349) — this spec ends where the verdict is produced.
- The command surfaces that print the verdict and drive recovery (59, 60).
- Routing a repository to a storage back-end, which consumes one of these answers but decides on far more (344, 346).
- The repository registry's own format, locking and write path, and the memory mirror's layout, beyond the single identity field each carries.

## Data Contracts

### The three files

The classification looks at exactly three paths: the database file, and the two sidecars the engine appends `-wal` and `-shm` to its name for. Presence is decided per path; any failure to stat a path counts as absent.

### File-combination states

| Database | `-wal` | `-shm` | State | Meaning |
| --- | --- | --- | --- | --- |
| present | present | present | `healthy-active` | Live connections |
| present | present | absent | `healthy-recoverable` | Crashed; the next open replays the log |
| present | absent | either | `healthy-clean` | Cleanly closed |
| absent | either, at least one present | | `alarm-sidecars-only` | The main file was deleted out from under a live database |
| absent | absent | absent | `absent` | Nothing here — go ask the identity witnesses |

A cleanly closed database legitimately has **no** sidecars, so an incomplete set is never on its own an alarm. The single alarming combination is sidecars **without** the database.

A database present together with a `-shm` but no `-wal` reads as cleanly closed: the shared-memory file is inert without a log and the next open ignores it.

### Identity verdicts (only meaningful when the database is absent)

The inputs are two independently-stored copies of the database's own identity: one from the machine-global repository registry, one from a repository mirror. Either may be absent.

| Registry id | Mirror id | Verdict | Meaning |
| --- | --- | --- | --- |
| absent | absent | `fresh-install` | No identity was ever recorded — build normally |
| present | present, **different** | `ambiguous-residue` | Two artifacts each claim a different database |
| every present id agrees (one or both sides) | | `deleted` | The database these artifacts belonged to existed here and is gone |

The rule is **identity matching, not "something exists"**. Registry and mirror remnants survive independently — a moved folder, a restored configuration — so "something exists, therefore refuse to create a database" would jam every new machine, while treating residue as proof of deletion would raise a false alarm on one.

### The two witnesses

| Witness | Where | Shape |
| --- | --- | --- |
| Registry stamp | An optional field on the machine-global repository registry document that sits beside the database | The identity string |
| Mirror witness | A small document in each registered repository's **hidden mirror layer**, one per repository | A single-field JSON object carrying the identity string, pretty-printed with a tab indent and a trailing newline |

The identity itself is minted once, on first ask, into the database's own key/value metadata table and reused forever after (347).

## Behavior

### Classifying the files

Stat each of the three paths, treating any error as "absent", and answer from the table above. This is a pure filesystem question: nothing is opened, and no database module is loaded, so it is safe on any runtime.

### Testing whether an open handle is still live

Given a handle a caller obtained on the database file itself:

1. If the handle's link count is zero, the file was deleted and the process is writing into a nameless inode — **detached**.
2. Otherwise stat the path. If the path no longer resolves at all — **detached**.
3. Otherwise compare inode and device numbers. Different on either — **detached** (the file was swapped underneath).

A convenience form opens the path read-only, runs the same check, and closes; a path that cannot be opened at all answers detached.

This matters because a process holding an open handle keeps writing successfully after the file is deleted, so every self-check the process performs passes until it restarts. **Both forms are unreachable in production** — nothing in the shipped product calls either; they exist only as tested capability. The consequence is that the deletion of a database out from under a live writer is *not* detected mid-run by anything; it is caught only by the next classification of the files on disk, or by the identity comparison after the fact.

### Classifying identity

Read both witnesses, then apply the verdict table. When both are present and disagree, a warning naming both ids is logged and the verdict is `ambiguous-residue` — neither silently rebuilding an empty database nor permanently refusing is right for that state, so it is surfaced and pointed at the recovery command instead.

### Stamping the witnesses

Both witnesses are stamped from a single place: the opportunistic snapshot pass (349), after it has obtained a writable handle and taken (or skipped) its snapshot. Two properties are load-bearing:

- **Both are stamped whatever the snapshot's own outcome was** — the identity is minted and the witnesses written even when the snapshot was skipped by the daily gate or failed outright, because the witness has to be in place *before* any incident, not after one.
- **Only for the machine-default database.** When a caller directed the pass at some other database path, neither witness is written, so a test or temporary database can never claim the machine-global witnesses.

The registry stamp is written under the registry's own lock, re-reading the registry strictly first, and does nothing when the stored id already matches. Every other registry writer preserves the field through its read-modify-write.

The mirror witness is written for **each registered repository whose hidden mirror layer already exists**; a repository with no mirror is simply not a witness, and the pass never creates one. A mirror whose file already contains exactly the intended content is skipped. The whole pass never throws — a failure is a warning.

### Reading the witnesses

- The registry id is whatever field the registry carries, or none. That read is **fail-open**: a registry that cannot be read or parsed is treated as empty, so it answers "no id recorded".
- The mirror id is the first parsed identity string found while walking the registered repositories in order; a mirror whose document is missing, unreadable or malformed is skipped and the walk continues. A failure to read the registry at all is a warning and answers "none".

### Who consumes the file-combination answer

| Consumer | On `alarm-sidecars-only` | On `absent` |
| --- | --- | --- |
| Migration-state reporting for a repository (58) | Cannot answer; the reason names the missing file with the surviving sidecars and points at the recovery command | **"Never migrated"** — a certain answer the user can act on |
| Storage routing for a repository (344) | Cannot answer; same reason and pointer | **Cannot answer** — reason: the database file does not exist |
| Snapshot restore (349) | Proceeds (this is exactly the damaged state restore repairs) | Proceeds |
| The recovery survey (60) | Reported verbatim as the file state | Reported, **and** the identity verdict plus both raw ids are reported alongside |

The first two rows deliberately disagree about the same state. "No database file" is a certain answer to "has this repository been migrated yet?" and the user can act on it; it is *not* an acceptable answer to "has this repository been cut over?", where reading absence as "no" would tell a fenced repository that its frozen source is still authoritative.

Restore consults the classification for the opposite purpose: any state whose name begins with *healthy* is a database it refuses to overwrite without explicit consent (349).

## State Transitions

| Situation on disk | Classification | Identity verdict | What it means |
| --- | --- | --- | --- |
| First run on a new machine | `absent` | `fresh-install` | Build normally |
| Database deleted, registry and/or mirror survive with matching ids | `absent` | `deleted` | Alarm; offer recovery |
| Registry and mirror carry different ids | `absent` | `ambiguous-residue` | Warn; recovery decides |
| Database deleted while a writer holds it open | `alarm-sidecars-only` | (not consulted) | The one alarming file combination |
| Writer crashed | `healthy-recoverable` | (not consulted) | Normal; the next open replays |

## Notable Behavior

- **The inode-liveness test ships unused.** Both forms are complete and tested, and no production path calls either — so the failure mode they were written for (a live writer that keeps succeeding into a deleted inode until it restarts) is not detected while it is happening. (**Unreachable**; notable.)
- **An unreadable registry silently downgrades a deletion to a fresh install.** The identity read fails open to "no id recorded", so if the mirror carries no witness either, a genuinely deleted database classifies as `fresh-install` and the alarm never fires. This is the same damage a registry writer would do by dropping the field, which is why every registry writer re-reads strictly and preserves it. (Surprising; reality.)
- **The witnesses exist only after a snapshot pass has run at least once.** Nothing else mints or stamps the identity, so a database created and then deleted before any snapshot pass reaches it leaves no witness at all and classifies as a fresh install. (Notable.)
- **A repository with no mirror on disk is not a witness, and the pass will not make it one.** The stamping walk resolves each repository's mirror location with a non-claiming lookup and skips one that does not exist, so asking about identity can never bring a mirror folder into existence. (Notable.)
- **"Sidecars without a database" is the only file combination that alarms.** Every incomplete set that still has the database is a normal state of a healthy install — including a database with a stray shared-memory file and no log. (Notable.)
- **A mismatch between the two witnesses is deliberately not resolved here.** Neither side is preferred, no id is treated as more authoritative, and the verdict is handed on rather than acted upon. (Notable.)
- **The mirror read answers with the first repository that carries a witness**, in registry order, rather than reconciling all of them — so a machine whose mirrors disagree among themselves produces an answer that depends on registry ordering. (Notable.)

## Shared Behavior

- The identity read here is the same identity minted into the database's metadata table and stamped into every snapshot filename (349), which is what lets a snapshot found on any drive be matched back to the database it came from.
- The file classification is called by the routing resolution (344) and by the per-repository migration-state report (58) as their first check, before either loads a database module.
- The machine-global repository registry, its lock, its atomic owner-only write and its strict-versus-fail-open read pair are owned elsewhere; this spec covers only the single identity field it carries.
- Each repository's mirror location is resolved with the same non-claiming lookup the read-only status surfaces use, so nothing here creates or claims a mirror folder.
