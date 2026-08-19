# 371. Claude Multi-Owner Session Ownership Ledger

## Topic Statement

Record, once per machine, every worktree root an agent session **visited or authored into**, together with the transcript line at which that root first appeared — so a commit made in one checkout can be attributed to a session that sat in another, and so the read of that session's transcript starts at the line where this checkout entered the conversation rather than at the top of a conversation that belonged to somebody else.

## Scope

**In scope**

- The machine-global document: where it lives, its version field, its session map, and the per-worktree-root owner edges each session carries.
- What an owner edge asserts, which of its fields are frozen on first sight and which are extended, and the fields it deliberately does not carry.
- The cross-pass union / max-progress merge (and the unconditional within-pass overwrite it is not), the read-inside-the-lock rule, and the durability signal the write returns.
- The session cap, its eviction order, and the absence of any cap on owner roots per session.
- The never-throw read posture (whole document and per session) and the normalisation the lookup key must already have had applied.
- The lock that serialises the read-modify-write, and the one discipline that is new here: the callback learns whether it was acquired.
- How an owner edge is derived from a window of transcript lines: the per-line gate, where the working directory is read from, the two edge classes, the closed set of authoring tools, and the root resolver that answers *nothing* for a directory in no repository.
- The resumption mark this scan rides, and why it advances only on a durable write.
- The two writers — the forward one at session end and the commit-time backfill — the timing argument that motivates the second, and why their ordering does not matter.
- The single environment variable that carries the executing session's id, and the fallback that was refused.
- Which commit-pipeline operations consume the ledger and which deliberately do not, including one consuming arm that is wired but unreachable.
- The per-transcript lower bound the ledger supplies to a first read, and the bound it does not supply.

**Out of scope**

- The after-the-fact repair of a summary that stored no conversation, which is the ledger's second reader. It shares the same lower bound and adds bounds and refusals of its own; that is a separate topic. This spec covers only that the ledger is read there and what it hands over.
- The upper bound of a transcript read (the queue entry's creation instant) and the per-line stop semantics it drives — owned by **Summary Attribution by Transcript Cutoff**.
- The on-disk shape of the per-transcript cursor document, the per-extractor mark mechanism, and the legacy-seeding rule — owned by **Transcript Cursor Resumption**. This spec contributes only that a mark named `owners` exists, is deliberately outside the legacy-covered set, and is advanced under one specific condition.
- The queue entry's own format and lifecycle (**Queue Entry Format**), the drain order (**Git Operation Queue Worker**), and the enqueue decision that writes the executing session's id onto an entry (**Post-Commit Hook Enqueue**).
- The session-end recording hook's other discovery scans — plans, references, skills — which share that hook and that cursor document but not this ledger.
- The containment predicate that decides whether a *recorded working directory* belongs to a worktree (**Session Directory Attribution**). It is not used here: this ledger resolves each directory to its own worktree root and compares roots for equality.
- The general-purpose state-root resolver that echoes a non-repository directory back (**Project State-Root Resolution**). This ledger deliberately uses the variant that answers nothing instead; the two share one memo.

## Data Contracts

### The document

One JSON document, machine-global, at `~/.jolli/jollimemory/claude-owners.json` — beside the machine-global configuration and the hook dispatch scripts, not inside any repository. Serialised with tab indentation and replaced through the shared atomic write (temp file + rename).

Its fields are:

- **`version`** — the literal `1`. Written on every save and **never read**: the reader validates the session map's shape and nothing else, so a document carrying any other version number is consumed exactly as if it carried `1`.
- **`sessions`** — an object keyed by a source-prefixed session id, `claude:<sessionId>`. The prefix is the only source discrimination in the document; nothing else is ever written into it.

### Session record

Per entry in the session map:

- **`sessionId`** — the raw, un-prefixed producer-assigned id, repeated inside the record so a record carries its own identity independently of its key.
- **`transcriptPath`** — the absolute path of the transcript the edges were derived from.
- **`source`** — the literal `claude`. No other producer is represented in this document, and no other producer's hook or discoverer writes to it.
- **`owners`** — an object keyed by **worktree root**, whose values are owner edges. One entry per root this session's transcript proves it visited or authored into.

### Owner edge

One worktree root's participation in one session:

| Field | Meaning |
| --- | --- |
| `firstSeenAt` | The instant of the first transcript line that attributed this root. |
| `firstSeenLine` | The **line index** of that line, counted over the whole transcript file. This is the value that becomes a read's lower bound. |
| `lastSeenAt` | The instant of the most recent line that attributed this root. |
| `firstSeenCwd` (optional) | The directory that *resolved to* this root on that first line — the session's own working directory for a visit edge, the edited file's directory for an authored edge. |
| `lastSeenCwd` (optional) | The same, for the most recent attributing line. |

The edge carries **no last-seen line**, and the session record carries none either. There is therefore no representable per-owner upper bound anywhere in this document — only a lower one. It also carries no count of attributing lines, no branch, and no commit.

### Line-index basis

`firstSeenLine` indexes the transcript's non-blank lines as split from the whole file, and it is absolute — the scan is handed the file's complete line list plus a starting index rather than a pre-sliced window, precisely so the index it reports and the index a future read resumes from cannot mean different things.

### Authoring tools

The closed map from tool name to the input key naming the file it writes:

| Tool name | Path key |
| --- | --- |
| `Edit` | `file_path` |
| `Write` | `file_path` |
| `MultiEdit` | `file_path` |
| `NotebookEdit` | `notebook_path` |

Nothing outside this map authors anything, and there is no second list. The rationale for leaving the read-only and shell tools out — reading a directory, or moving through it, is not authorship, and admitting it would fill the ledger with roots a session only browsed — is exactly that: a rationale, not an entry. **Every** tool outside the map is non-authoring *silently*, by falling off the end of it: the read-only tools, shell invocations, task delegation, web fetches, todo writes, and every external-tool call included. There is no allow-list and no deny-list beyond the map itself.

### The lock

A machine-global advisory file lock, `claude-owners.lock`, in the same directory as the document. A contender polls at **25 ms** for up to **5 000 ms**.

Its discipline is a shape that exists nowhere else in the product: the lock hands its callback **whether it was acquired**, and on a miss the callback still runs — unlocked, best-effort — rather than the write being dropped. Losing an edge is the failure this whole feature exists to prevent, so the miss is reported upward instead of being swallowed: the write propagates the flag as a durability signal, and the scan keys its mark advance off it. Its name is also the one lock name in the product not published for reuse — every other one is — so no second writer can take it: this lock serialises exactly one document's read-modify-write and nothing else.

### Resumption mark

The scan resumes from a mark named `owners`, held per project alongside the plan, reference and skill marks for the same transcript. Two properties are load-bearing and both belong to the mark mechanism rather than to this topic: the mark is **project-scoped**, so the same transcript has a different `owners` mark per worktree that ever scanned it; and `owners` is deliberately **not** in the set of extractors a legacy bare line offset is credited to, so a document written by a build that predates this extractor reads as `0` for it — one full re-scan on upgrade, rather than a silent skip of every line that build advanced past.

## Behavior

### Deriving edges from a window of transcript lines

Given the file's full line list and a starting index (clamped to zero at the bottom), each line from that index to the end is processed in order:

1. Trim the line. Unless it now begins with `{`, skip it.
2. Parse it as JSON. A parse failure skips the line.
3. Read the working directory off the **raw envelope**, never through the conversation-turn parser. This is deliberate: the producer stamps a working directory on records that are not conversation turns at all, and gating on the turn parser discards most of the directories a session ever visited.
4. A missing, non-string, or empty working directory **skips the line entirely** — so such a line contributes no authored edge either, even when it carries a write-tool call.
5. Take the line's own timestamp when it is a non-empty string; otherwise use the current instant.
6. Emit a **visit** edge for the working directory itself.
7. Emit an **authored** edge for each path a write tool named on this line, taken as the *directory* of that path — resolved against the working directory when the path is relative. A tool-use block counts only when the message content is an array, the block is an object whose type is tool-use, its name is in the authoring map, and the named input is a non-empty string.

Each emitted directory is resolved to a worktree root (below). A root that resolves to nothing contributes no edge. Within one pass, the **first** contributor to a root fixes its `firstSeenAt` / `firstSeenLine` / `firstSeenCwd`; later contributors on higher lines only move `lastSeenAt` / `lastSeenCwd`, and that move is an **unconditional overwrite** rather than a maximum — the later line's own instant and directory simply replace whatever was there. Since a line's instant is the one the producer wrote (falling back to the current instant only when there is none), a non-monotonic transcript can therefore leave a pass reporting a `lastSeenAt` *earlier* than the same edge's `firstSeenAt`.

Both directory fields are declared optional on the edge, and this is the only producer of an edge — it always sets both — so no production writer can omit them. (The optionality is unreachable.)

The pass reports the file's total line count as the position reached, unconditionally — the scan always runs to the end of the file and never stops early.

### Root resolution

A directory is resolved to the innermost worktree containing it, and to **nothing** for a directory in no repository — as opposed to echoing the input back, which is what the product's general-purpose state-root resolver does for exactly the same question. That distinction is the whole point of using this variant: echoing would turn a scratch directory, a temporary directory, or the user's home directory into a phantom owner key that no worktree-root lookup can ever match, and the document is machine-global and append-only, so the phantom is permanent. A resolver that throws is treated as answering nothing.

Nothing requires the directory to be absolute, and a **relative** one is resolved against the resolving *process's own* working directory — measured: a lone `.` resolves to exactly that. For the commit-time writer that process is the draining worker, whose working directory is the committing worktree, so a transcript line carrying a relative working directory attributes the committing worktree regardless of what the transcript is actually about. An authored path is not exposed to this directly, because a relative one is joined onto the line's working directory first; it inherits the same resolution whenever *that* is relative.

Roots are memoised twice: once per pass, because a long session stamps the same handful of directories on thousands of lines, and once in the resolver's own process-wide memo, whose value type distinguishes a cached "this is not a repository" from "not resolved yet".

### Merge and write

An **empty** edge map is a durable no-op: nothing is written, and the caller is told the write landed, because there was nothing to lose.

Otherwise, under the lock:

1. Re-read the document **inside** the lock. A snapshot taken before acquisition would merge away a peer's write, which is the exact race the lock exists for.
2. Start from this session's existing owner map, if any.
3. Per incoming root: when no edge exists, install the incoming edge whole. When one exists, keep every first-seen field unchanged, take the **later** of the two `lastSeenAt` values, and take the incoming `lastSeenCwd` whenever it is defined.
4. Install the session record (raw id, transcript path, `claude`, merged owners) and apply the session cap.
5. Replace the whole document atomically.
6. Return whether the lock had been acquired.

Across passes the merge is set-union and max-progress: a later pass extends an edge and never rewinds one, because the first-seen line is the lower bound a future commit will read from and moving it forward would silently skip that owner's earliest turns. The "later of the two" rule is this **cross-pass** step only — within a single pass the same field is overwritten unconditionally (above), so max-progress describes the merge and not the derivation.

### Session cap

Every write caps the session map at **2 000** sessions. The session being written this call is always retained; the remaining slots go to the most recent others, where a session's recency is the **newest `lastSeenAt` across its own owner edges**. Timestamps are compared as ISO strings with ordinary string comparison, never with a locale-aware collation, which would reorder them under some locales.

The cap value is overridable for testing, and nothing in production overrides it — so the eviction is only ever exercised at 2 000. (The override seam is unreachable from production.)

The ceiling exists because the document is read, parsed and linearly scanned on the post-commit path and on every memory-detail render, and is otherwise append-only — one entry per session ever seen on this machine — so without one it grows unbounded and steadily slows both.

There is **no cap on owner roots per session**. A session may accumulate arbitrarily many owner keys, and nothing prunes them.

### Read

- A missing or unparseable document reads as **empty**. This is consulted from the post-commit path, where throwing would take a whole commit's summary down over a state file.
- The document-level guard tests only that the session map is a **non-null object**, and an array satisfies that — so a document whose session map is an array is accepted and walked by index. Every element then faces the per-session guard.
- Per session, a value that is **null, not an object, or an array** is dropped, as is one whose `owners` field is absent, `null`, or an array. Dropped rather than coerced, so every session the read returns is safe to index into.
- The lookup for one worktree root is a linear scan of the session map returning, per matching session, that root's **own** edge and nothing else. A session with several owners is therefore that many independent lookups, one per asking root.
- The read does **not** check that the transcript file still exists. A caller that needs that checks for itself.
- The lookup key must already be the anchored worktree root. The keys were written that way, and an un-anchored working directory — a raw process working directory on a platform where the anchored form differs, `/var/…` against `/private/var/…` — matches nothing while looking entirely reasonable.

### The cursor protocol around a scan

Each scan of one transcript, on either writer:

1. Read the `owners` mark for this transcript in this project. Absent reads as `0`.
2. Read the whole transcript file. When it has no lines past the mark, return without doing anything.
3. Derive edges from the mark onward (above).
4. Write them, and take the returned durability flag.
5. Advance the mark to the file's line count **only when the write was durable**. On a non-durable write the mark is left where it is: a best-effort write may have been clobbered by a peer, and advancing past those lines would strand the dropped edge forever, whereas leaving the mark makes the next pass re-scan and re-emit the same edges idempotently.

The advance is additionally guarded on the reached position exceeding the mark, and **that guard is dead in production**: the pass always reports the file's total line count, and step 2 has already established that the file has lines past the mark. It is kept only to mirror the sibling scans' protocol, where the reported position genuinely can fall short. (Unreachable.)

The scan never throws. Any failure — an unreadable transcript, a vanished file — is logged as a warning and the surrounding hook continues.

### Writer 1 — forward, at session end

The session-end recording hook runs this scan over the transcript it has just been handed, as one more discovery scan alongside the plan, reference and skill scans, with its own mark and its own error containment. Its effect is forward-looking: a session that edits another checkout's files has that checkout recorded as an owner **before it ever commits**, which is what covers a commit a human, or a graphical git client, later makes in that checkout with no agent session in the environment at all.

### Writer 2 — commit-time backfill

The post-commit hook stamps the agent session id it inherited from its environment onto the queue entry it writes. When the detached worker drains that entry, and before it looks up owners, it locates that session's own transcript by id and runs the **same** scan over it, against the committing worktree's own `owners` mark.

The transcript is located by walking the producer's per-project transcript directories and taking the first `<sessionId>.jsonl` that exists — the id alone does not name the directory, since the producer keys it by the launch working directory, but a session id is unique, so the first hit is the one. A transcript that cannot be located is a no-op.

This covers the one case the forward writer structurally cannot: an edit and a commit in a **single turn**, where the commit's worker drains while the turn is still open and the session-end hook has not fired. It depends entirely on the inherited id, so it covers nothing at all on a host that advertises none.

### Ordering between the two writers

That "the worker drains before the session-end hook would have written the edge" is a **race, not a guarantee** — the drain includes a model call, so the hook frequently wins. The design does not depend on which wins, for three reasons: both paths run the same derivation; both merges are idempotent unions, so a doubly-recorded edge is indistinguishable from a singly-recorded one; and the two paths advance **different** `owners` marks for the same transcript, because the marks are project-scoped — the forward writer advances the session's worktree's mark and the backfill advances the committing worktree's. Neither can therefore strand the other by advancing past lines the other has not seen.

### The inherited session id

Exactly **one** environment variable is recognised as carrying the id of the agent session a process is running inside: `CLAUDE_CODE_SESSION_ID`. A blank value is treated as absent rather than returned as an empty id.

One entry is a measured result, not an unfinished list. That variable carries the same id the session registry records, verified against a live session, so a value read from it joins straight onto the session row. The other hosts were checked the only way that settles it — reading a running process's own environment — and publish nothing usable. The one named is Codex: its whole environment carries no session, conversation or thread variable, its only host-specific entry names the front end rather than the session, and its session id exists only inside its own rollout files.

The fallback that would paper over the gap — pick the most recently touched session for this repository — is refused on the record: it is a guess that becomes indistinguishable from a fact once stored, and it would attribute work to a session that never did it in the one direction nobody can audit. An absent id is visible as absent; an invented one is not.

### Which operations consume the ledger

Two consumption sites sit inside the drain's fresh-summary transcript load — the commit-time backfill and the owner lookup — and **both of those** are gated on the Claude integration being enabled. A third reading site — the ledger's other reader, the after-the-fact repair of a summary that stored no conversation — is **not gated at all**: it reads the ledger with no integration check, and is reached from the local dashboard's memory detail, the desktop editor's memory panel, and the diagnostic command's repair form. That third reader is also what the session cap's own rationale rests on — the cap exists because the document is read and linearly scanned on the post-commit path *and on every memory-detail render*, and only this reader produces the second of those.

Per drained operation kind, for the two gated sites:

- **Commit, cherry-pick and revert** thread the entry's executing session id into the transcript load, so both the backfill and the lookup run.
- **Amend** threads it too, through its own parameter — and that arm is unreachable **for any entry the product writes**. Amend entries are written by the post-rewrite hook, which does not stamp the field; the hook that *does* read the environment returns early for an amend, deferring it. So on a product-written entry the value is always absent and the backfill never runs there. It is **not** structurally unreachable: the value is read straight off the queue entry, and an entry is an ordinary JSON file parsed with no schema check, so a crafted one carrying the field reaches this arm — see Notable Behavior, where that is one half of the same delivery route. The lookup still runs either way, because it does not depend on the id.
- **Squash, rebase-squash and rebase-pick** do not thread it and need no fresh attribution: consolidation merges summaries that already exist and a rebase pick migrates hashes.

A squash entry does carry the stamped id — the enqueue stamps it on every entry it writes — and nothing reads it.

A session that only ran a commit without authoring under the committing root records **nothing**, and is correctly attributed to nothing. That is also what contains a foreign or bogus inherited id *as an id*: the backfill will happily scan a foreign transcript, but unless its own lines resolve an edge whose key equals this worktree root, the lookup returns nothing and that conversation cannot be injected here. What that does **not** contain is a supplied id together with control of the file it names — see Notable Behavior, where the same relative-directory rule that makes the resolver convenient also lets authored lines name the committing worktree without knowing its path.

### What a lookup contributes to a commit

For the committing worktree's anchored root, each owned session contributes two things to the fresh-summary transcript load:

1. **A candidate session** — id, transcript path, `claude`, with the edge's `lastSeenAt` as its update instant — merged in **alongside** the local session registry's own sessions rather than replacing them, and de-duplicated against them by source, id and transcript path. The local registry stays the cheap fast path and the fallback for a session the ledger never got (an older build, a wiped machine-global directory).
2. **A lower bound**, keyed by transcript path.

### The lower bound it supplies

The bound is the owner edge's `firstSeenLine`, and the drain's own transcript-load step — not any per-source transcript reader — is what applies it: it seeds the *start* of a read under three conditions, all of which must hold:

- **No saved cursor for that transcript in this worktree.** An established cursor is this owner's own recorded progress and always wins; a seed would rewind it and re-read spent lines.
- **The session's source is Claude**, because no other source is represented in the ledger.
- **The bound is greater than zero**, which is why an owner first seen on the very first line behaves identically to no bound at all.

Without it, a first read of a session this checkout joined late starts at line zero and stops only at the read's upper bound, absorbing every earlier turn — turns belonging to whichever checkout was driving the conversation at the time. The bound applies to every owned transcript, whether or not the local session registry already knew the session.

The upper bound remains the queue entry's creation instant, unchanged and owned elsewhere. There is no per-owner upper bound, because no edge records a last-seen line.

## State Transitions

### The document

- **Absent / unparseable → populated with one session.** Any read failure yields an empty document, and the next write persists that emptied snapshot plus the session it was writing. See Notable Behavior — this is not a benign transition.
- **Populated → populated.** Every write replaces the whole document. Sessions are added; edges are added or extended; nothing is ever removed except by the cap.
- **There is no populated → absent transition.** No uninstall, doctor, or prune path deletes this document, and nothing removes a session whose transcript file has been rotated away — such a session remains until the cap evicts it.

### One owner edge

- **Created** by the first pass that attributes its root, with every field set from that line.
- **Extended** by any later pass, in `lastSeenAt` and `lastSeenCwd` only.
- **Never rewound**, and never removed while its session survives. The first-seen line is a permanent claim.

### The `owners` mark, per project per transcript

- **Absent (reads as 0) → advanced to the file's line count** on a durable write.
- **Held** on a non-durable write and on any thrown failure, so the same window is re-offered next pass.
- Monotonic. Once advanced, the lines below it are never scanned again by that project, and the edges they would have produced are unrecoverable from this mechanism.

## Notable Behavior

- **The ledger is machine-global on purpose, and a per-worktree one would fix nothing.** The question it answers is asked by a worktree that never ran the session: the session was launched in checkout A, the user moved into checkout B mid-conversation, and the commit lands in B. B's own project state holds nothing about that session, because B's session-end hook never fired. One shared document is what lets A's hook record B's edge and B's post-commit read find it.
- **The working directory is read off the raw line, not through the turn parser — and that is a measured choice.** The producer stamps it on records that are not conversation turns (attachments, queue operations), so parsing for a turn first discards most of the directories a session ever visited. (Notable; the sibling session discoverer learned the same lesson against a corpus of real transcripts.)
- **A line with no working directory contributes nothing at all, including no authored edge.** The working-directory check runs before the write-tool inspection, so a write-tool call on such a line is never seen — even when its path is absolute and needs no working directory to resolve. (Surprising.)
- **Authorship is a closed map with no diagnostics.** A tool that writes files under a name not in the map — a new first-party edit tool, an external tool, a delegated sub-agent doing the writing — authors nothing, silently. There is nothing to fail and nothing logged. (Notable.)
- **`version` is written and never read.** The document declares a format version on every save, and the reader validates only the session map's shape. There is no compatibility gate and no migration hook keyed off it. (Notable.)
- **The lock hands its callback the acquired flag, which no other lock in the product does.** Every other best-effort lock here degrades to running unlocked and tells nobody. This one propagates the miss so the caller can decline to advance a monotonic mark past evidence that may have been clobbered — the only thing that actually makes the promised recovery happen. (Surprising; load-bearing.)
- **An empty edge map is reported as a durable write.** Nothing was at risk, so the caller may advance its mark freely — which is what lets a transcript window containing no attributable line be consumed rather than re-offered forever. (Notable.)
- **Session recency is computed from the edges, not from a record-level timestamp.** A session record has no own timestamp; its recency is the newest `lastSeenAt` across its owners. A hand-written session with no edges therefore sorts as the oldest possible entry. (Notable.)
- **In a linked worktree the commit-time backfill is inoperative, and it fabricates phantom owner keys at the same time.** Three grounded facts compose into this. (1) Measured on git 2.50.1: a post-commit hook in a **linked** worktree runs with `GIT_DIR` exported as the absolute path of that worktree's own git directory, while the same hook in the **main** worktree runs with none of `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` set at all. (2) The detached drain inherits the hook's environment, and the root resolver's filesystem fast path declines outright whenever any of those three is set — by design, so that it agrees with the subprocess it is standing in for — so in that process **every** resolution falls through to git. (3) That git call passes no environment of its own, so it inherits the redirect, and git then takes the work tree to be whatever directory it is asked about. Measured with that variable set: a subdirectory two levels below the worktree root resolved **to itself** rather than to the worktree root; a directory in **no repository at all** resolved to itself and exited 0; and an unrelated repository's root resolved to itself. Two consequences follow. The headline case — a file authored under this worktree from another checkout — is recorded under the *file's own directory*, while the lookup key is the *worktree root*, so nothing ever matches and the backfill contributes nothing. And every directory the session merely sat in becomes its own owner key, including directories in no repository, which defeats the nothing-answering resolver in the one process the backfill runs in — with no cap on owner keys per session to bound the growth. The forward session-end writer is unaffected: it is not a git hook and inherits no redirect. The product carries, elsewhere, a **second** named list of git-location variables — the same name, a longer membership — which is *stripped* before asking which repository contains some *other* directory, added after a measured instance of this same failure in which a sibling repository resolved to the current one. This resolver's git call strips nothing. (Surprising; documented as reality.)
- **An unparseable document is silently reduced to one session, unrecoverably.** Any parse failure reads as empty, and the very next write persists that emptied snapshot plus the one session being written — every other session's edges are gone. The same happens per session for a malformed `owners` map: the session is dropped on read and absent from the next write. Recovery is impossible, because the `owners` marks have already advanced past the lines the edges were derived from and they only move forward. The read's own justification — that the next session-end hook rewrites the document anyway — is **wrong**: that hook rewrites only the edges it derives from lines *past* its mark. (Surprising; documented as reality.)
- **A single authored file in an unrelated repository puts one conversation into another repository's memory.** That repository becomes an owner from the line the write appeared on; at its next commit the session is contributed as a candidate, and its transcript is read from the ownership line up to the commit instant with **no per-owner upper bound** — so the entire remainder of the conversation, whatever it later moved on to, enters that repository's summary. There is a concrete in-product instance: the agent's plan mode surfaces as an ordinary `Write` tool call whose `file_path` is a markdown file under the user's home directory, in exactly the block shape this scan parses — so on a machine whose home directory sits inside a worktree (a dotfiles repository being the obvious case), every plan write makes that worktree an owner, and every commit in it then reads that conversation. The product has a named guard for precisely this hazard, because the plan directory is machine-global and holds every project's plans: one predicate decides whether a plan file belongs to the current project, and a second classifies that directory as legitimately-outside-the-worktree rather than foreign. This scan consults neither, and the only reason the case is usually harmless is incidental — a home directory is normally not inside a worktree. (Surprising; documented as reality.)
- **The inherited session id is trimmed but never validated before it is used to build a file path.** It is interpolated as a path segment with the transcript extension **appended, not checked**, and no containment check on the result, so a value carrying traversal segments escapes the producer's transcript directory: the probe joins it under each project directory in turn, path joining normalises the traversal rather than rejecting it, and an over-deep traversal clamps at the filesystem root instead of failing (measured; an *absolute*-looking id, by contrast, does not escape, because joining concatenates rather than restarting). The existence probe asks only that something be there — not that it be readable, and not that it be a regular file — and the scan then reads the whole file. Two delivery routes exist: the inherited environment, and the queue entry, which is an ordinary JSON file in the repository's own state directory that the worker parses without schema validation, so a cloned repository that force-added one fires it on the first commit — and that same absence of validation is what makes the amend arm above reachable, since the field is read straight off the entry. **The containment is narrower than it looks.** Against a supplied *id alone* it holds: the file must itself resolve an edge keyed to this worktree root, and a file that does is a genuine transcript. Against a supplied id *plus* the file it names — the same repository-shipped route delivers both — it does not, because the lines are the attacker's and a relative working directory in them resolves to the draining worker's own working directory, which is the committing worktree. Two residues survive when no edge matches **this** root. The cursor record for the bogus path is created regardless, since a scan that finds nothing still reports a durable write and advances the mark. The session-cap slot is narrower: an empty edge map is written nowhere at all, so an entry under the supplied key — evicting a legitimate session — requires the file to have resolved at least one edge somewhere, just not one keyed here. (Surprising; documented as reality.)
- **The bound protects the first read only.** An established cursor always wins, so a worktree that has already read part of a transcript is never re-floored — which is correct for its own progress, and means the ledger cannot retroactively fix a read that already absorbed somebody else's turns. (Notable.)
- **There are two writers, and the forward one's own account says there is one.** It describes itself as the only writer of the machine-global ledger; the commit-time backfill writes it too, through the same scan and the same merge. (Notable.)
- **Nothing prunes this document but the cap.** A session whose transcript was rotated away by the producer's own retention keeps its entry, and its edges keep contributing candidate sessions to every commit in every worktree it owns, until eviction. The eviction rationale is that an old session's transcript is the first thing the producer prunes, so its edge can no longer be acted on anyway — the entry is dead weight rather than useful history.

## Shared Behavior

- The `owners` resumption mark lives in the same per-project document as the plan, reference and skill marks, and every rule about that document — its shape, the per-extractor map, monotonicity, the legacy-seeding rule that deliberately excludes `owners`, and the lock the mark advance shares with the other writers of that document — is owned by **Transcript Cursor Resumption**.
- The upper bound of every transcript read, the per-line stop rule it drives, and the cursor-advance modes are owned by **Summary Attribution by Transcript Cutoff**. This ledger only moves where a read *starts*.
- The queue entry field that carries the executing session id, and the enqueue decision that stamps it (including the early return for an amend that makes the amend consumption arm unreachable), are owned by **Queue Entry Format** and **Post-Commit Hook Enqueue**.
- The drain that dispatches one entry to a pipeline, and the pipeline set itself, are owned by **Git Operation Queue Worker**.
- The session-end recording hook that drives the forward writer — and the sibling scans it runs in the same pass (plans, references, skills), each with its own mark and error containment — is owned by **Claude Stop Hook — Session Recording**.
- The lock's file location, wait budget, and degrade-to-unlocked posture are catalogued alongside every other advisory lock in **Lock Primitive Registry**. The acquired-flag callback shape is this lock's alone.
- The resolver that answers *nothing* for a directory outside any repository shares its process-wide memo with the general-purpose state-root resolver that echoes such a directory back; both are owned by **Project State-Root Resolution**. Which of the two a caller uses is a decision, not a preference: this ledger's keys must be roots a future commit can actually look up.
- The containment predicate that attributes a *recorded working directory* to a worktree (**Session Directory Attribution**) is **not** used here, and the difference is worth keeping straight: that predicate asks whether a directory lies inside a given root, with an exclusion walk for nested repositories; this ledger resolves every directory to its own innermost worktree root and matches roots exactly, so a nested repository is separated by construction rather than by a walk.
- The after-the-fact repair of a summary that stored no conversation is the ledger's second reader. It takes the same `firstSeenLine` as its lower bound, refuses outright when no owner edge proves the summary's ownership, and adds an upper bound and a transcript-existence check of its own. That is a separate topic.
- The atomic write (temp file + rename, with a direct-overwrite fallback) is the same primitive the session registry, cursor documents, and configuration use.
