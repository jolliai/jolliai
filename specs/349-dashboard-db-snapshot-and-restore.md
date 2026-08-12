# 349. Memory Database Snapshot and Restore

## Topic Statement

Taking a verified point-in-time copy of the machine-level memory database into a user-visible folder, ageing those copies under two collectors and two floors, and restoring one back over a missing or damaged database — including exactly what the restore does and does not guarantee.

## Scope

**In scope:**

- The snapshot mechanism, the folder it targets, and the two folder rules that make an attempt fail rather than reroute.
- The daily gate, and the sequence a single snapshot attempt runs through.
- The snapshot filename contract, the temporary name used while writing, and why both carry what they carry.
- Verification, and its position **before** anything old is deleted.
- The two collectors (age, size), the two floors that outrank them, and the separate cap on the retention-exempt class.
- Where age comes from, and the fallback when it cannot be read.
- The opportunistic entry point, the two call sites that constitute the whole schedule, and what it stamps beyond the snapshot itself.
- The health verdict this produces for the diagnostics command, including which state is repairable by a command.
- Save-time validation of the two configuration keys.
- Restore: its refusal, its two verification points, the sidecar removal ordering, the abandoned-temp sweep, and the fixed order of recovery sources it heads.

**Out of scope (boundaries):**

- The database, its schema and its permissions (347), and the identity minted into it (348).
- The command surfaces that print these verdicts and drive recovery (59, 60).
- The mechanics of the two gap-fill steps that follow a restore — how memories are read from a mirror or a frozen ref and upserted — and the protection watermark they apply. This spec states only their order and their non-destructive contract.
- The freeze marker consulted by the last-resort fill (345) and the routing a repository lands in afterwards (344).
- The memory mirror's own layout, and the repository registry's format.

## Data Contracts

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| Snapshot folder | `~/jolli_back` | Where snapshots are written. Deliberately visible in the home directory and outside the product's own state tree |
| Retention days | 20 | Age threshold for the first collector; validated as an integer ≥ 1 |

The memory-mirror root is read too, but only by save-time validation, which refuses a snapshot folder inside it.

### Filenames

| Class | Pattern |
| --- | --- |
| Regular snapshot | `memory-<YYYYMMDDTHHMMSSZ>-<8 lowercase hex>.db` |
| Retention-exempt snapshot | `memory-premigration-<YYYYMMDDTHHMMSSZ>-<8 lowercase hex>.db` |
| Snapshot temp | `.<final name>.<pid>-<8 hex>.tmp`, in the target folder |
| Restore temp | `.<database file name>.restore-<pid>-<8 hex>.tmp`, in the database's own folder |

The stamp is the snapshot instant in UTC with separators removed and milliseconds dropped. The hex suffix is the first eight characters of the database's own identity with its dashes stripped, which is what lets a snapshot found on any drive be matched back to the database it came from (348).

Only names matching the two snapshot patterns are ever deleted or listed. The folder is visible in the user's home directory and users put their own files next to these.

### Retention constants

| Constant | Value |
| --- | --- |
| Minimum regular snapshots kept, regardless of age or size | **2** |
| Retention-exempt snapshots kept | **5** |
| Size-cap floor | **2 GiB** |
| Effective size cap | `max(2 GiB, retention days × live database size)` |
| Daily gate | 24 hours since the last recorded successful snapshot |
| Health escalation threshold | 7 days since the last recorded successful snapshot |
| Abandoned restore-temp age override | 1 hour |

### Snapshot outcome

Three shapes, and the engine **never throws**: `created` with the final path, `skipped` with a reason, or `failed` with a reason.

### Restore outcome

Three shapes, and the engine never throws: `restored` naming the source, `refused` with a reason, or `failed` with a reason.

### Database-recorded state

A successful snapshot records two values in the database's own key/value metadata (347): the snapshot instant in epoch milliseconds, and the folder it landed in. The second is what keeps a previously-configured folder a candidate source after the user re-targets — snapshots are never moved when the setting changes.

## Behavior

### One snapshot attempt

Given an already-open writable handle:

1. **Resolve the folder**: the configured one, else the default.
2. **Folder legality**, checked on every attempt regardless of where the value came from. Any of these is an immediate `failed`, logged at error level, and **never** rerouted to another folder:
   - not an absolute path;
   - anywhere inside the product's own state tree in the home directory — disaster recovery must not share fate with the disaster, since removing that tree would take the database and the snapshots together;
   - the live database's own directory.
3. **Default-folder-only check**: when no folder was configured, probe whether the home directory is inside a git worktree. If it definitively is, answer `failed` with a reason naming the folder and telling the user to configure one outside it — a home directory that is itself a checkout would have every snapshot removed by a clean of untracked files. This probe **fails open**: an inconclusive answer (no git available, a spawn error) is logged at debug level and the attempt proceeds. A folder the user configured explicitly was already validated at save time and is trusted here.
4. **Daily gate**: read the recorded snapshot instant; if it is a finite number and less than 24 hours old, answer `skipped`. (A caller may force past this gate — see the note below.)
5. **Create the folder.** A failure here answers `failed` with the underlying reason, and logs a warning that also states how long ago the last success was, or "never". This is the unplugged-drive case: legal but unreachable, never rerouted, never silent.
6. Mint or read the database's identity and build the final name; build the temp name in the **same** folder, so the final rename is atomic even when the folder is on another filesystem.
7. Remove any pre-existing temp, then: vacuum the database into the temp file, **verify the temp file**, and rename it to the final name. Any failure in that sequence removes the temp and propagates to the outer wrapper, which reports `failed`. A verification failure is raised deliberately: a corrupt live database must not overwrite good snapshots.
8. Record the snapshot instant and the folder in the database's metadata, and log the created path.
9. **Rotate — strictly after a verified new snapshot exists.**

The copy is produced by vacuuming into a new file rather than by copying the database and its sidecars: that yields a single consistent file including committed log frames, whereas copying the three files is not one point in time. The engine's own dedicated backup call is not used, because it arrived one runtime minor above the floor the hook dispatchers can guarantee (347).

### Verification

Verification opens the candidate **file** read-only, runs an integrity check, and requires exactly one result row whose single value is the success sentinel. Any failure to open, or any other result, answers false — "not a database at all" gets the same verdict as a failed check. The same routine is the pre-restore gate.

### Rotation

Rotation lists only files matching the two snapshot patterns, ignoring everything foreign, and sorts them **oldest first** — the deletion order for both collectors.

Age comes from the **UTC stamp in the filename**, with the file's modification time as a fallback when the stamp cannot be parsed. Filename first because synchronising drives rewrite modification times, and an mtime-judged snapshot could be deleted as expired the day it was written. A stamp that is digit-shaped but not a real instant (month 99, hour 30) is rejected rather than rolled over into a wrong-but-finite time.

Then, in order:

1. **Retention-exempt class**: delete oldest-first until only the newest **5** remain. This class is exempt from both the age and the size collector — the schema bug such a snapshot guards against can surface long after the retention window.
2. **Age collector**: among the regular snapshots that are *deletable* — every one except the newest **2** — delete those older than the retention days. The rule is "don't accumulate forever", not "burn on expiry": the floor keeps the last two even when every snapshot is over-age, because a user who committed nothing for a month is exactly the one who needs the old copy.
3. **Size collector**: compute the cap as the larger of 2 GiB and retention-days times the live database's current size, then delete oldest-first from the deletable set until the regular snapshots' total size is under the cap. Following the age collector rather than overriding it means the cap catches abnormal growth instead of silently shortening the user-visible retention promise.
4. If the total is still over the cap because the two-snapshot floor forbids deleting more, log an error stating by how much.

### The opportunistic entry point

This is the only self-contained way a snapshot happens. It:

1. Answers `skipped` when the runtime is below the database floor (347).
2. Loads configuration itself, opens its own short-lived writable handle, runs one snapshot attempt, and mints the database identity in the same handle.
3. **Only when operating on the machine-default database**, stamps that identity into both deletion-detection witnesses (348) — regardless of whether the snapshot itself was created, skipped or failed, because the witness has to exist before an incident.
4. Catches everything: an open that fails (contention, a schema stamped ahead of this build) becomes `failed` with a reason, never an exception.

**There is no daemon; two call sites are the entire schedule:**

- the dashboard launch path, after its routing attempt — placed there rather than in the long-lived server because taking a snapshot needs a writable handle, which runs schema migrations, and the server is the one process whose build can lag;
- the post-commit queue worker, after its drain has committed and only when that drain produced new memories.

A third caller exists but is a repair, not a schedule: the diagnostics command's fixer for a stale-backup verdict.

### The health verdict

Computed for a given instant:

1. Resolve the folder (configured, else default) and apply the same legality rules. An illegal folder is **fail**, message naming the reason, and carries **no** repair.
2. Read the recorded snapshot instant — but only when the runtime is at or above the database floor **and** the database file is present. Any failure to read is a warning and leaves the instant unknown.
3. Compute staleness: a **known** instant more than 7 days old. An unknown instant is never stale — "never snapshotted" is a state every fresh install passes through on the way to its first trigger, and calling it a failure would make an untouched install red.
4. If the folder does not exist: **warn** (or **fail** once stale), message naming the folder as unreachable and stating the age of the last success, or "never".
5. Else if stale: **fail**, naming the age and the seven-day threshold, and marked **repairable**.
6. Else if the instant is unknown: **warn**, "no snapshot taken yet".
7. Else: **ok**, naming the age and the folder.

Only staleness is marked repairable, and that flag is what lets the diagnostics command offer a fix: an unrepairable failure makes the command exit non-zero on an otherwise healthy install with nothing the user can run. An invalid folder or an unreachable drive needs a human — a snapshot attempt would just fail again — so neither offers a repair.

### Save-time validation of the folder

A strict superset of the engine's own rules, run when the value is about to be stored. It rejects, in order: a path that is not absolute or contains an upward-traversal segment in the raw string; anything the engine's rules reject; anything inside the memory-mirror root; anything inside a git worktree — decided by walking up to the **nearest existing ancestor**, because the folder itself may not exist yet; and finally a folder that cannot be created or written.

**The writability probe creates the folder, and does so last** — deliberately on both counts. It is the only way to answer "can I write here?" for a target that does not exist, and running it after every rejecting rule means a refused value never leaves a directory tree behind. It is therefore a commit-time check, not a preview of a path the user is still typing.

Containment tests accept both separators. One earlier version tested only the forward slash for the mirror rule, so a folder inside the mirror passed validation on one platform and was later eligible for the mirror's own pruning.

### Restore

1. Classify the database's files (348). If the state is any *healthy* one and no override was passed, answer **refused**, naming the path and saying an override is required. Recovery is for an absent or damaged database, and running it twice must be safe.
2. Stat the source; a path that is not a regular file answers `failed`, and a path that cannot be stat'd at all propagates its error into a `failed` reason.
3. **Verify the source.** A snapshot that fails the integrity check is refused as a restore source.
4. Create the database's own directory with owner-only permissions — the state this repairs usually means the directory went with the file, and without this the copy below would die on the one path that has to work.
5. **Sweep abandoned restore temps** in that directory: any file matching the restore-temp prefix and suffix whose owning process id is dead, **or** whose modification time is more than an hour old, is removed best-effort. A temp whose process is alive and which is younger than that is another restore in flight and is never touched. An unreadable modification time answers "not old enough", leaving the file to the process-liveness gate. A name whose process id does not parse is swept, since only this format matches the prefix and a non-numeric owner reads as dead.
6. Copy the source to a fresh temp carrying this process's id and a random suffix, then **verify the copy**. The earlier check proved the snapshot was sound, not that it arrived intact — a short write on a full disk does not raise — and installing an unverified file is the one failure this cannot walk back from. A failed copy verification removes the temp and answers `failed`, stating the database was left untouched.
7. **Remove both sidecars, then rename the temp over the database.** The dead database's log must not be replayed over the restored file, and the removal has to come first: a concurrent opener in the gap would otherwise pair the fresh file with the dead log, and a removal failure aborts while the old state is still intact rather than after the swap.

Every failure path answers `failed` with a reason; nothing throws.

The unique temp name is what stops two overlapping restores from interleaving into a partially-copied file renamed over the live database — and the sweep is the flip side of it, because a unique name is never reused and a restore killed between the copy and the rename would otherwise leave a database-sized file behind forever.

### The fixed order of recovery sources

A restore is step ① of three, and the order is fixed:

| Step | Source | Recovers |
| --- | --- | --- |
| ① | A verified snapshot | The whole database — memories **and** activity data |
| ② | Each repository's memory mirror | Memory gaps only |
| ③ | Each fenced repository's frozen reference history | Memory that existed before the freeze |

The order follows from what each source holds. Mirrors carry no activity data at all, so rebuilding everything from them would trade session and git history for memories; the frozen reference history stops at the freeze moment, so it ranks below a mirror that is still being written. Both fill steps are additive by contract — they upsert memory rows, never delete, and never touch the activity layer — which is why running them after a restore cannot make the restore worse.

## State Transitions

For one snapshot attempt:

| From | Trigger | To |
| --- | --- | --- |
| Any | Illegal folder | `failed`, logged at error level; nothing deleted |
| Any | Default folder inside a checkout | `failed`; nothing deleted |
| Last snapshot < 24 h old | Attempt | `skipped`; nothing deleted |
| Folder unreachable | Attempt | `failed`, warning states staleness; nothing deleted |
| Verification fails | Attempt | Temp removed, `failed`; **old snapshots untouched** |
| Verification passes | Attempt | Renamed into place, timestamps recorded, then rotation runs |

For one restore:

| From | Trigger | To |
| --- | --- | --- |
| Any healthy file state | Restore without override | `refused` |
| Any healthy file state | Restore with override | Proceeds |
| Absent, or sidecars-only | Restore | Proceeds |
| Source or copy fails verification | Restore | `failed`; database untouched |

## Notable Behavior

- **A snapshot "failure" is often invisible.** Three distinct conditions — an illegal folder, an unreachable folder, and a default folder that sits inside a checkout — all resolve to a returned status plus a log line, and the two scheduled call sites treat any non-created outcome as nothing at all. A user whose snapshot folder is misconfigured learns about it only from the diagnostics command's backup row. (Surprising; reality.)
- **The retention-exempt class has no producer.** Nothing in the product requests a retention-exempt snapshot, so the filename form, the exemption from both collectors and the separate cap of five all operate over a class of files the product never creates. They are still honoured on read: such files are recognised, listed as candidates and reported as pre-migration by the recovery survey. (**Unreachable** as a write path; notable.)
- **The daily-gate override has no producer either.** Every production call obeys the gate, and no command exists to force a snapshot; the only repair path (the diagnostics fixer) goes through the ordinary gated entry point, which works only because the verdict it repairs requires the last snapshot to be at least seven days old. (**Unreachable**; notable.)
- **A rotation failure is reported as a failed snapshot even though the snapshot landed.** Rotation runs inside the same guarded region as the copy, after the rename and after both timestamps were recorded, so an undeletable old file or an unreadable live-database size turns a successful snapshot into a `failed` result. The new snapshot is on disk and the daily gate has already advanced. (Surprising; reality.)
- **Restore guarantees integrity, not recency.** It proves the file it installs passes an integrity check — twice, source and copy — and nothing more. The daily gate means the newest snapshot may be up to a day older than the lost database, and the two-snapshot floor means the only surviving snapshot may be arbitrarily old, since over-age copies are kept rather than deleted. Steps ② and ③ exist precisely because step ① is expected to be behind. (Notable.)
- **Restore refuses a healthy database and says so.** An override exists and is a separate, explicit act; without it, re-running recovery over a database that already came back is a no-op that reports why. (Notable.)
- **The temp filenames carry a process id and a random suffix because a shared name destroyed data twice, in two different ways.** For snapshots, the identity in the name belongs to the *database*, which is machine-global, so two repositories committing in the same second produced the identical temp path, each removed the other's in-progress file, and the day's backup silently did not happen. For restores, two overlapping runs on one temp path could rename a partially-copied file over the live database with the sidecars already deleted. The **final** names deliberately carry neither: a same-second collision there is two snapshots of the same database, where last-writer-wins is correct. (Notable.)
- **Age is read from the filename, not the file.** Synchronising drives rewrite modification times, which would make fresh snapshots look expired; the modification time survives only as the fallback for an unparsable stamp. (Notable.)
- **Only this format's filenames are ever touched.** The folder is user-visible and users put their own files in it, so both listing and deletion are pattern-scoped. (Notable.)
- **The illegal-folder rules never reroute.** An invalid configured value is a red configuration state, not something to be quietly worked around by writing snapshots somewhere else. (Notable.)
- **The default folder gets a check the configured one does not**, and the configured one gets checks the default never sees. The default was never validated at save time — nobody saved it — so its one destructive precondition is re-checked on every attempt; a configured folder was validated once, at save time, against a strictly larger rule set, and is trusted afterwards. Neither set is re-run for the other. (Notable.)
- **Save-time validation is reachable from exactly one writer.** The configuration-setting command validates both keys before storing them; no other surface writes either key, so the "every settings entry point" discipline currently has one entry point. (Notable.)
- **The health row can read "no snapshot taken yet" on a machine that has taken many.** The recorded instant lives *inside* the database, so a runtime below the floor, a missing database file, or an unreadable one all leave the instant unknown — and unknown reports as a warning rather than a failure. (Notable.)

## Shared Behavior

- The identity stamped into every snapshot filename is the database's own minted identity (347), and it is the same value the deletion detector matches against its two witnesses (348).
- The two witnesses are stamped by this engine's opportunistic entry point, which is the only place either is written (348).
- The owner-only directory creation used before installing a restored file is the same helper every writable database open applies (347).
- The two recorded metadata values — the snapshot instant and the last-used folder — are read back by the health verdict and by the recovery survey respectively (348, 60).
- The diagnostics command renders the health verdict as one row and wires its repairable flag to a fixer that calls the opportunistic entry point (59, 60); the recovery command prints the survey and drives the restore plus the two gap-fill steps (60).
- The folder-shape predicate reused by save-time validation (absolute, no upward-traversal segments) is the same one the memory-mirror root is validated with.
