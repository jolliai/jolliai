# 372. Transcript Repair and the Empty-Conversation Verdict

## Topic Statement

Rebuilding one memory's missing conversation capture from the transcript history still on this machine, and the four-state verdict that answers "why does this memory show no conversations" for every surface that renders one.

## Scope

**In scope:**

- The four verdicts, the fixed order they are derived in, and why the last step is a *dry run of the real repair* rather than a looser guess.
- The engine's per-memory outcome record: the commit it is about, whether it repaired, the reason, and the entry count.
- The two bounds a repair insists on — an upper bound derived from the memory's own timestamps, and a per-owner lower bound taken from the ownership ledger — and what each one refuses when it is missing.
- Every reason the engine returns, and the order in which its checks run.
- The single optional field a successful repair stamps on the memory, and the two jobs that one field does.
- The consumers: the diagnostic command's repair form (the only one that ever applies a repair), the desktop-editor host's memory panel, the local dashboard's memory detail, and the JVM host over its bridge action.
- The three sentences an empty conversations block can print, and which verdicts select which.
- What decides whether that empty block appears at all — and the fact that the verdict is not it.
- The repair form's list-then-act shape, its per-candidate error isolation, and the storage routing it performs before running.

**Out of scope (referenced, not duplicated):**

- The ownership ledger itself — where an owner edge comes from, what counts as a visited worktree root, how its first-seen line is numbered, and the ledger's own cap and eviction rule. Owned by the Claude ownership topic; this topic only *asks* it which sessions a root owns.
- Per-line transcript reading and the "stop at the first entry past the upper bound" rule, including how an entry with no timestamp of its own is treated. Owned by the summary-attribution-by-transcript-cutoff topic.
- The session-title resolution ladder whose answer a repair archives.
- How a stored transcript becomes the conversation rows a user sees — owned by the archived-conversation grouping topic. This topic only decides whether a memory has a stored transcript at all.
- The summary write itself: the must-land write lock it takes, the storage backend it routes to, the atomicity of the summary-plus-transcript pair.
- Every other check and fixer of the diagnostic command.
- The surrounding layout, message protocol and read-only rules of the three memory surfaces that print the sentence — owned by the editor-panel, embedded-viewer and dashboard topics respectively.
- The bridge action's request envelope, field validation and error shape.

## Data Contracts

### The verdict

One of four values. It says what a surface is allowed to claim about a memory's conversations, and nothing else:

| Verdict | Meaning |
| --- | --- |
| `present` | The memory names at least one stored transcript. Render the conversations. |
| `repaired` | The capture was refilled from local transcript history after the fact, not captured live. |
| `repairable` | The memory names no transcript, and a real repair run **would succeed**. |
| `unrepairable` | The memory names no transcript, and nothing local can rebuild it. |

The last two are the whole reason the verdict exists: a single "no conversations linked yet" line reads as *not yet*, which is a lie about a capture that already failed and will never complete on its own.

### Derivation order

Fixed, and the order is load-bearing:

1. A memory carrying the repair stamp is `repaired` — **checked before** the transcript test, so a repaired memory reports as repaired rather than as merely present, even though the repair gave it a transcript identifier.
2. A memory naming any transcript identifier is `present`.
3. Otherwise the engine is asked for a **dry run** of the real repair: it would repair → `repairable`, it refuses → `unrepairable`.

Step 3 is deliberately the same code path as the repair, so a surface's sentence cannot promise something the engine then refuses. `repairable` means literally "a real run would succeed" — not "some owned transcript exists". The two looser predicates that were rejected are exactly the two cases the engine still refuses: a window with no upper bound to close it, and an owner window that holds no turns.

Only step 3 costs anything. Steps 1 and 2 are field reads, so a memory that already has a transcript never pays for the engine.

### The engine's outcome

| Field | Meaning |
| --- | --- |
| commit hash | The memory the outcome is about. |
| repaired | True when a repair happened — **and true under a dry run when one would have happened.** |
| reason | One of the reasons below. |
| entry count | The total turns assembled across every contributing session. Present only when `repaired` is true. |

The reasons are `repaired`, `already-present`, `no-owner-proof`, `transcript-missing`, `no-entries-in-window` and `no-upper-bound`. `repaired` is the reason for both a dry run and an applied run; every other reason pairs with `repaired: false`.

### The two bounds

Both are mandatory. Neither has a default, and the absence of either is a refusal rather than a widened window.

- **Upper bound** — the memory's own generation instant, falling back to its commit date only when that is absent; absent altogether refuses with `no-upper-bound`. The generation instant is preferred because capture can run well after the commit (queued, retried, or produced by a later back-fill), so the commit's own timestamp can *precede* the turns that produced it and would then truncate them away.
- **Lower bound** — per contributing owner, that owner's **first-seen line** in the ownership ledger, exactly as the live read path seeds a first read. Never zero-by-default: a memory whose owner cannot be proven is refused outright rather than read from the top of a transcript that may hold turns belonging to a *different* worktree that happened to share the same agent session.

### Persistence: the repair stamp

A successful repair writes one new optional root field on the memory — an instant. It is purely additive and carries no schema-version bump, so an older reader simply does not see it.

It does two jobs:

- **Idempotency key.** A memory carrying it is never a candidate again, so a repeated run cannot mint a second artifact from the same evidence window.
- **Provenance.** It is what lets a surface say "repaired from local transcript history" instead of implying the conversation was captured live.

Alongside it, the write replaces the memory's transcript list with a single freshly-minted identifier, and stores the assembled sessions as that identifier's transcript payload — overwriting any summary already stored for the commit.

### The three sentences

A closed set within this topic. Each surface holds its own copy of all three (see Notable Behavior):

| Verdict | Sentence |
| --- | --- |
| `repairable` | *Conversation capture is missing but repair may still be possible* |
| `repaired` | *Conversation capture was repaired from local transcript history* |
| `present`, `unrepairable`, an unrecognised value, or nothing received yet | *No conversations were captured for this memory* |

The plainest sentence is the default in every direction. `repairable` is the one wrong direction to guess in — it invites a repair with nothing to work from — so it is never reached by a fallback, only by a verdict that actually said so.

## Behavior

### One memory's repair, in order

The engine works on an already-fetched memory. When entered by commit hash instead, the memory is fetched first and a **missing** memory returns `no-owner-proof`.

1. **Already-present guard.** The repair stamp is set, or the memory names any transcript identifier → `already-present`, nothing read, nothing written.
2. **Upper bound.** Resolve the generation instant, else the commit date. Absent → `no-upper-bound`.
3. **Owner lookup.** Ask the machine-global ownership ledger which sessions the memory's repository root owns. Empty → `no-owner-proof`.
4. **Liveness filter.** Keep only owners whose transcript file still exists on disk. Empty → `transcript-missing`.
5. **Per-owner read.** For each surviving owner, read its transcript bounded **below** by that owner's first-seen line and **above** by the upper bound. A read that throws is logged at debug and that owner is skipped; a read that yields zero entries is dropped. For each owner that yielded entries, a display title is resolved and attached when one resolved — archived deliberately rather than left for a later reader, because the file this read from is machine-local and pruned on the agent's own schedule, so re-deriving a title later is the one thing a repair cannot promise will work.
6. **Emptiness check.** No contributing session survived → `no-entries-in-window`.
7. **Dry run stops here** and reports `repaired: true`, reason `repaired`, with the assembled entry count. Everything above has already run, which is what makes the dry run's answer the real run's answer.
8. **Apply.** Mint a fresh transcript identifier, and write the memory with that single identifier plus the repair stamp, carrying the assembled sessions as the transcript payload.
9. Report `repaired: true`, reason `repaired`, with the entry count.

Refusal is the default posture throughout: a false negative leaves the memory looking exactly as it does today, while a false positive staples someone else's conversation onto a commit — strictly worse than the gap it would be papering over.

### The repair form

The diagnostic command's `--repair-transcripts` flag is list-then-act:

1. Route the active storage first, the way every other memory-reading command does, so a repository whose system of record has moved is read (and, on apply, written) on the backend it actually uses rather than on the frozen one.
2. List every stored memory and filter to candidates by **exactly** the engine's own already-present test — no stamp and no transcript identifier — so the printed list and the engine's per-memory verdicts can never disagree about what is in scope. No candidates prints one line and returns.
3. For each candidate in turn, ask the engine. A candidate that would repair (or did) prints `would repair` / `repaired` with its entry count; a refusal prints `skipped — <reason>`.
4. A throw from any candidate is caught, printed inline, and counted separately from both repaired and skipped. It is deliberately **not** a seventh reason — the reason vocabulary stays the engine's. The loop must survive it because it runs across every candidate in the repository. There is exactly **one live throw**, and it exists only under `--fix`: contention for the must-land write lock with a concurrently draining commit worker. A corrupt on-disk memory or ledger is *not* one — both are caught where they are read and arrive as the `no-owner-proof` reason instead, so the bare reporting form is throw-free end to end. The code's own account of this claims the second throw as well.
5. A closing line reports the counts, and — without `--fix` — that re-running with `--fix` applies.

The bare flag reports; `--fix` applies. That split exists because a repair rewrites a stored memory from transcript history that may be days old and is pruned on the agent's own schedule, which is not something a diagnostic command does on its own initiative.

### Where each surface gets its verdict

| Consumer | How | When |
| --- | --- | --- |
| Diagnostic command's repair form | Calls the **engine**, not the verdict, and is the only consumer that ever applies. | On `--repair-transcripts`. |
| Desktop-editor memory panel | Calls the predicate **in process** — this host bundles the command-line code. | On every conversations load, riding the same reply as the rows. |
| Local dashboard memory detail | Server-side, inside the page request, threaded into the page payload as the memories model's only asynchronous input. (The request awaits other reads too — reachability sets, the local author identity, the settings / knowledge / graph models — so it is not the page's only asynchronous part.) | Only for the memories view, and only when a memory is actually selected — a tree render with no selection has no detail pane to word. |
| JVM host's memory viewer | One `transcript-repair-state` bridge round trip, off the thread the first paint waits on. | On the deferred pass after the page opens; the served page carries the plainest sentence until it lands. |

Three properties hold across these consumers:

- **The rule stays command-line-owned.** The bridge action exists for no other reason than that the JVM host cannot import the predicate; without it the whole distinction would be silently editor-only, with nothing failing to say so.
- **On the three rendering surfaces, every failure answers the mildest verdict and none propagates.** A memory that cannot be looked up, a bridge that is down, an unparseable response, an absent field — all resolve to `unrepairable` (or, on the dashboard, to no verdict at all, which renders the same sentence). The rows are what the user opened the panel for; a wording detail must not cost them the list or fail the page. Two qualifications. Those catches are **defensive rather than load-bearing** on the dry-run path, which is throw-free end to end — an unreadable ledger, for instance, does not reach them at all; it reads as empty and arrives as the `no-owner-proof` reason, which the verdict renders as `unrepairable` on its own. And the **diagnostic form is not one of the three**: it calls the engine rather than the verdict, so a failure there produces no verdict at all — it is counted as an error and printed on its own line (see step 4 above, and Notable Behavior).
- **Each repository is judged by its own root.** The dashboard passes the *memory's own* recorded worktree root, because the dashboard is machine-global and its own working directory names the wrong repository for every row but one. The JVM host passes the project's main repository root. The editor panel passes the current workspace root — see Notable Behavior for what that costs a memory read out of another repository's shared folder.

### What decides whether the empty block shows

**The conversation set being empty, and never the verdict.** Two surfaces gate on their own grouped conversation rows being empty; the third gates on the memory's stored transcript-identifier set **intersected with the transcripts actually present on the memory ref** being empty. The verdict only picks *which sentence* the block carries.

That separation is deliberate: `present` is not proof of renderable conversations. A pre-migration memory — one carrying no explicit transcript list — has its identifiers derived by walking its own commit tree, which always yields at least its own commit hash, so such a memory reads as `present` unconditionally whether or not a transcript file exists behind it. The intersection on the third surface is what makes that gate load-bearing rather than cosmetic there: such a memory's derived identifiers can intersect to nothing, so the block appears and is worded, where a gate on the raw set would have hidden it behind a set that is never empty.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Memory names transcripts | — | `present`; engine never consulted |
| Memory names none, ledger holds a live owner with turns in the window | Verdict asked | `repairable`; nothing written |
| Memory names none, any bound or owner check fails | Verdict asked | `unrepairable`; nothing written |
| `repairable` | Repair applied | `repaired` — one transcript identifier, one stamp; no longer a candidate |
| `repairable` | Verdict asked again | `repairable` again — the dry run writes nothing and memoises nothing |
| `repaired` | Repair form run again | Not a candidate; the engine would answer `already-present` if asked |
| `unrepairable` | The owning agent prunes the transcript file | Still `unrepairable`, now for the `transcript-missing` reason instead |

The one-way step is `repairable → repaired`. Because the stamp is the idempotency key and it is written in the same operation as the transcript, a repair that lands cannot be re-attempted, and a repair that did not land leaves the memory a candidate.

## Notable Behavior

- **`repairable` is a dry run of the real engine, not a cheaper approximation.** Both entry points share one code path, and the dry run performs every step except the final write, so the sentence and the behaviour cannot drift apart. (Surprising; intentional — and the reason the read path costs what it does, below.)
- **The upper bound prefers the generation instant over the commit date.** Capture can run long after the commit, so the commit's own timestamp can precede the turns that produced it. Using it when a generation instant exists would truncate the very window the repair is trying to recover. (Surprising; intentional.)
- **A missing memory and an empty ownership ledger report the same reason.** Both answer `no-owner-proof`, so the repair form's per-candidate line cannot distinguish "this commit has no stored memory" from "this machine has no owner edge for this repository". (Notable.)
- **The repair form does not consult the dry-run flag.** The diagnostic command has a `--dry-run` option, and the repair branch reads only `--fix`. Pairing the two therefore still rewrites every candidate — and because the repair stamps its own idempotency key in the same write, that write is not re-attemptable afterwards. (Defect.)
- **The per-session lower bound is a constant, independent of which commit is being repaired.** It is the owner edge's first-seen line, which is the same value for every commit in that repository. So repairing several empty memories in one run gives each a window **nested inside** the next: the latest-bounded memory contains every earlier one's turns. Repairing one late commit on its own attaches the whole session from its first-seen line, including turns already archived to earlier commits. There is no cross-commit lower bound and no de-duplication against turns a sibling memory already holds. (Defect.)
- **The editor panel answers the verdict against *this* repository's ledger even for a memory read out of another repository's shared folder.** It passes the current workspace root, as every other read in it does, so a foreign memory is judged by the owned-session ledger of the repository the user is standing in — and can display *repair may still be possible* for a commit whose repair could never run from there. The panel's own documentation states the opposite, claiming such a memory falls to the mildest verdict. The JVM host does not have this: its lookup resolves the memory in the current repository, misses, and answers the mildest verdict. So the two editor surfaces can word the same memory differently, which is the divergence the shared predicate was introduced to prevent. (Defect.)
- **The read-only verdict performs the entire repair's input reading, with no memoisation.** For a memory with no transcript and no stamp it reads the ledger, stats every transcript it names, reads each live one over the bounded window, **and resolves a display title per contributing owner** — then discards all of it and returns one word. The editor pays that on every conversations load; the dashboard pays it inside the page request for every selected memory whose transcript set is empty. Nothing caches the answer between calls. (Notable; a memory that already has a transcript pays none of it.)
- **Three independent copies of the three sentences exist — two in webview script, one in the JVM host — each pinned only by its own surface's tests.** There is no cross-surface lockstep check of the kind this repository uses for other cross-language constants, so a reworded sentence on one surface fails nothing anywhere. A comment on the JVM copy asserts the sentences are identical on **four** surfaces; there are three. (Defect; the wording is currently in step.)
- **Two branches in the JVM host are written around an absent verdict meaning "not fetched yet, so post nothing", and the fetch never answers absent** — every failure path yields the mildest verdict instead. The hydrate builder's null-in-null-out arm and the `verdict is absent` term in the deferred pass's early-return conjunction are therefore both dead on the path that arms the hydrate, since the verdict is written immediately before the flag is set. (Unreachable paths. A null can still reach the hydrate builder by a different route — the memory-swap path clears the verdict without clearing a parked hydrate — but not for the reason the branches are written for.)
- **A pre-migration memory reads as `present` unconditionally.** With no explicit transcript list, identifiers are derived by walking the memory's own commit tree, which always includes its own commit hash. That is precisely why no surface decides *whether* to show the empty block from the verdict. (Surprising; intentional.)
- **The stamp is checked before the transcript list, so `repaired` outranks `present`.** A repaired memory has a transcript identifier and would otherwise report as captured-live; the ordering is what preserves the provenance the stamp exists to record. (Notable.)
- **The repair form routes storage before it runs.** Without that, on a repository whose system of record has moved it would read — and under `--fix` try to write — the frozen backend, silently. (Notable.)
- **Per-candidate errors are counted, never converted into a reason, and never into a verdict either.** The reason vocabulary belongs to the engine; write-lock contention is not a verdict about the memory. This is the one consumer where a failure does not land on the mildest verdict, because this consumer produces no verdict at all. (Notable.)
- **The dashboard's verdict and its conversation rows are resolved through one shared memory-selection rule.** A short hash can prefix-match, and the all-repositories view can match one hash in two clones, so the two lookups share their predicate, ordering and tie-break — otherwise the page could print one memory's conversations under another memory's verdict. (Notable.)

## Shared Behavior

- **The ownership ledger** — the machine-global record of which worktree roots an agent session visited and the line each was first seen on. It is what makes a repair possible from a repository whose own session state holds nothing about the conversation, and its first-seen line is this topic's lower bound. Owned by the ownership topic; this topic only queries it and never writes it.
- **Transcript reading with an upper bound** — the per-line read, the stop-at-first-later-entry rule, the treatment of entries with no timestamp of their own, and the cursor shape the read is seeded with. Owned by the summary-attribution-by-transcript-cutoff topic. This topic supplies the two bounds; that one decides what a bounded read returns. Note the repair passes a synthetic seed built from the owner edge rather than a persisted cursor, and does not advance any cursor.
- **Session title resolution** — the ladder that answers what a conversation is called, and the archive-the-answer contract every stored-session writer follows. A repair resolves and archives one per contributing session, and never fails over it.
- **Summary storage** — the write that carries the memory, the new transcript payload and the stamp together, the must-land write lock it takes, and the backend it routes to.
- **Archived-conversation grouping** — what a stored transcript becomes once it exists: which sessions are conversations, how slices across commits merge, and how many rows a memory has. That rule decides whether the conversations list is empty; this one decides what the empty state says.
- **The three rendering surfaces** — the desktop-editor memory panel, the JVM host's embedded memory viewer, and the local dashboard's memory detail each own their own conversations block: how it is laid out, when it is rebuilt, and (for the editor) that the verdict is latched from the last conversations reply rather than re-asked when a detach empties the list.
- **The bridge command surface** — the action's request fields, its "missing hash is not an error" rule, and the envelope a throw from the predicate becomes.
- **The diagnostic command** — every other check it performs, its `--fix` semantics elsewhere, and the report it prints around this form.
