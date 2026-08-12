# 310. Per-Repo Outbound-Push Control

## Topic Statement

A machine-global store records which repositories have **outbound push to a Jolli Space** turned off. Unlike the repo-wide manual disable flag, which stops *all* capture, this opt-out blocks only outbound sync — memory is still captured and stored locally. The store is keyed by each repository's **canonical identity**, not by a working-tree path, so the machine-wide control view (whose rows come from the Memory Bank, which knows repositories by identity) and the per-repo gate (which resolves its own canonical URL) share one key, and a repository checked out in several worktrees shares one decision. A single predicate composes the manual-disable flag with this store, and it is the one gate every outbound path on every surface consults. New repositories are push-*allowed* by default — a restriction is always an explicit opt-in.

## Scope

**In scope:**

- The opt-out's storage — machine-global, identity-keyed, deliberately not the repository's own profile file — and its semantics versus the manual-disable flag.
- The store's entry shape, its on-disk ordering rule, the refusal to store an empty identity, and what a read does with each class of damaged file.
- The schema-version guard and why it is not folded into "corrupt".
- Corrupt-store recovery on the enable path, the preserved copy it leaves behind, and the surfaces that must report it.
- The store's own machine-global lock and the one best-effort fallback layered on it.
- The composed outbound predicate, why it goes through the migrating manual-disable reader, and its fail-closed rule.
- The reporting read that carries the *reason* alongside the flag, and the absence of a boolean-only shorthand.
- What is memoized between gate reads and — precisely — what is not.
- The machine-wide repository list: its source, its key, the always-present current row, and the one failure it is allowed to propagate.
- Every outbound-push gate point across the command line, the desktop editor, and the JVM host, and what each does on the blocked path.
- The mid-run holds inside a running drain and the claim-release rule that makes a held entry immediately re-drainable.
- The current-repo control surfaces (command line, desktop-editor settings, JVM settings) and the shared engine behind them.
- Re-enable catch-up: what a toggle-on triggers, and when it cannot.
- The telemetry emitted on toggle.

**Boundaries (consumed here, owned elsewhere):**

- The repo-wide manual disable flag's own storage, anchoring, and legacy-marker migration are defined by **Repo-Wide Manual Disable Flag** (145).
- Canonical repository identity, its normalization, and its remote-less fallback are defined by **Canonical Repo URL and Name Derivation** (232).
- The push payload, endpoints and error taxonomy are defined by **Summary Push to Jolli Space** (94), **Binding Required Flow** (95) and **Jolli Space Push Article Assembly** (231).
- The drains and the pre-push hook this gate is added to are defined by **Git Pre-Push Hook and Detached Sync Worker** (268), **Push-Pending Queue and Claim-Based Drain Engine** (269) and **Push-Pending Compensation Retry** (270); this topic owns only the per-repo gate they consult.
- The shared classifier that makes the push-disabled refusal abort a whole attachment loop rather than be collected per item is defined by **Repo-Wide Push-Refusal Classification** (327); this topic owns only the flag that raises it.
- The lock-primitive catalogue this store's lock joins is defined by **Lock Primitive Registry** (297).
- The bridge operations that carry the gate and the toggle to the JVM host are defined by **CLI IDE-Bridge Command Surface** (287); the command's own option surface and rendering by **CLI Space Push / Spaces / Bind Commands** (230).
- The telemetry catalogue is defined by **Telemetry Event Catalog** (205).
- The personal Memory-Bank vault sync is a different outbound channel, deliberately **not** covered by this flag; it is defined by **Sync Engine Reconciliation Cycle** (150), **Sync Backend Client** (170) and **IDE Sync Round Orchestrator** (174).
- Server-side repository allowlisting is a backend concern; this topic covers only how clients gate their own outbound sends.

## Data Contracts

### The store

A JSON file in the machine-global configuration directory holding a schema version (currently `1`) and only the DISABLED repositories, each as a self-describing entry:

| Field | Role |
| --- | --- |
| `identity` | The canonical repository identity — the store key and the toggle target. The only load-bearing field. |
| `repo` | Human-readable name derived from the identity. Display only. |
| `disabledAt` | Timestamp of the last disable. Display only. |
| `trigger` | Which surface flipped it. Display only. |

Absent from the list = push allowed. The three display fields exist so a hand-inspection of the file explains itself; the gate reads back the identities and nothing else. A malformed entry that still carries a non-empty string identity is repaired on read — the name is re-derived from the identity and the two other fields default to empty.

**An empty identity is refused at the write with a thrown error**, never stored. Persisting one would be worse than refusing: the read path skips entries whose identity is empty, so the write would land on disk, report success, and read back as "not disabled" — a toggle that silently does nothing. Failing loudly surfaces a caller that passed a blank identity (an unparseable remote, a row from a degraded list) at the write instead of at the next gate read.

The `disabled` array is written in **code-point** order of `identity`. This is the on-disk byte order, so it must not depend on the ambient locale — deliberately unlike the *display* sort of the machine-wide list, which pins a fixed locale. Identities are also case-sensitive keys, so a base-sensitivity collator would call two distinct identities equal and leave their order unstable. The comparator's equal-identity branch is **unreachable today** (the working set is a map keyed by identity, so two entries cannot share one) and is kept only so the comparator stays self-consistent if duplicates ever become possible.

The opt-out deliberately does **not** live in the repository's working-tree profile file (contrast the manual-disable flag) precisely so the identity-keyed list and the gate can share one key.

### What a read does with a damaged store

| On disk | Read result |
| --- | --- |
| Missing | Empty set — push allowed. The first-run default. |
| Present but unreadable (permissions, I/O) | **Propagates** an error naming the store's absolute path and the underlying reason. |
| Present but unparseable | **Propagates** an error naming the absolute path and stating the file is corrupt. |
| Parseable, schema version newer than this build | **Propagates** the distinct too-new error (below). |
| Parseable but odd — non-array `disabled`, or elements that are not objects or carry no string identity | Tolerated as empty. It is readable, it just carries nothing actionable. |

Propagation is what lets the composed gate fail **closed** on an unreadable store, rather than silently treating every push-disabled repository as allowed and leaking memory outbound.

### The schema-version guard

A store whose recorded version is a number greater than this build's is a **distinct** condition from "corrupt", carrying the store path and the found version and naming an upgrade as the fix. The recoveries differ:

- An unparseable file is garbage, so the enable path may rebuild it.
- A newer-version file is *valid data this build cannot interpret*. Rebuilding it would destroy real opt-outs, and reading it with current rules could silently drop the entries whose shape changed — a fail-OPEN leak in the one module that is fail-closed everywhere else.

The enable-path rebuild therefore **rethrows** this error ahead of its recovery, so re-enabling refuses rather than resetting the machine. An older or absent version is fine — the current format is the only one shipped, and a missing field simply predates the check.

### The write result, and the corrupt-store recovery it reports

Every write answers with the flag it wrote, a `recoveredFromCorrupt` marker, and — when one was made — the absolute path of a preserved copy.

`recoveredFromCorrupt` is true **only** on the enable path when the store could not be parsed, so the write rebuilt it from an empty set and **every other repository's opt-out was dropped**. Enabling must succeed even on a corrupt store, because it is the documented recovery; disabling stays strict and fails rather than blowing away other repositories' opt-outs while ADDING a restriction.

Because that rebuild is one checkbox click away, the unreadable file is not overwritten: it is renamed aside next to the store with a suffix carrying the current epoch, and that absolute path is returned. A rename failure is best-effort — the rebuild still proceeds, since the user asked to enable — and only the evidence is lost, with a warning logged.

**This must never be silent.** A bare "Enabled ✓" printed over a machine-wide settings reset is the one outcome this store must not produce, so it is reported on the command line (an appended note plus the preserved path), in the desktop editor's settings status line (the success string is replaced by the same warning), across the bridge (the two fields ride along in the reply, omitted when false), and in the JVM host (a warning-level notification balloon raised from those fields).

### The store's lock

Writes are serialized by a **machine-global** lock beside the store — deliberately its own file rather than reusing the runtime-registry lock, so the two never contend. Budget **5 s**, polled at **25 ms**. The primitive is **strict** (it runs nothing when the budget expires), but the single call site adds a best-effort fallback: it re-runs the same read-modify-write unlocked when the lock was not acquired, because silently dropping a toggle the user just clicked would be worse than the residual lost-update window (the guarded section is a sub-millisecond read-modify-write ending in an atomic write).

### The outbound predicate

The single "may this repository push memory outbound?" answer is true only when the repository is neither fully disabled nor push-disabled:

- the **manual disable flag**, read through the migration-aware reader (which honours the legacy per-worktree marker), and
- the store lookup on the repository's canonical identity.

Going through the migrating reader closes the hole where a repository disabled solely via the legacy marker would read as push-*allowed*.

**It fails CLOSED.** A *missing* store means "nothing disabled" (allowed), but any error reading the state — an unreadable store, a failed identity read, a failed flag read — blocks. A silent fail-open would let the automatic drains leak memory the moment the store went bad.

### The reporting read

Reporting surfaces read a two-part state: the flag, plus an `error` set **only** when the flag is a fail-closed fallback rather than the user's recorded choice. The error carries the store's absolute path, so a surface can explain an otherwise inexplicable "OFF" — without it, every repository on the machine reports OFF with no way to learn that one file is corrupt.

There is deliberately **no boolean-only shorthand** for the opt-out. One existed and was removed: gates never wanted it (they read the composed predicate, which also folds in the manual-disable flag), and its only caller was the JVM settings toggle's bridge read — a reporting surface, which is precisely where dropping the reason produces the "you turned this repository off" misattribution.

### What is memoized

Only the resolved canonical **identity** is memoized, per working directory, for **5 s**. A summary push asks the gate once up front and then once inside each attachment's send, and each ask would otherwise spawn a git subprocess to re-derive one value that cannot change during the push. Changing the identity means editing git configuration, where a few seconds of staleness costs nothing.

The memo is swept of expired entries once it reaches a size cap (64), and the sweep runs **before** the new entry is inserted so the fresh entry is never its own sweep candidate. Without a sweep the memo only ever *replaces* an entry on re-access of the same directory, so a long-lived host that sees many roots would grow it without bound.

Neither state that can say *no* is memoized, and both exclusions are load-bearing:

- The manual-disable flag is the highest-priority stop-ALL opt-out and its writers live in **other** processes, so an in-process memo could not be invalidated airtight and any lifetime would be a window in which a repository the user just disabled keeps pushing — a privacy leak, not a latency trade-off.
- The store is excluded because the opt-out must be read LIVE so a mid-push toggle takes effect immediately (and it is a plain file read with no subprocess to save anyway).

**This halves the burst; it does not remove it.** The manual-disable read resolves the main-worktree root through its own git subprocess and is deliberately not memoized, so a ten-attachment push still pays roughly one git spawn per gate read rather than two.

### The machine-wide repository list

Sourced from the Memory Bank: every mirrored repository that records a remote URL. Each remote URL is run through the **same** normalization the gate uses, so the list key equals the store key — a Memory Bank row recorded in one remote spelling and a working tree whose remote is written in another collapse onto one row, one key, one decision. Each row carries its live disabled state, its display name, its identity, and a current-repository flag. Rows are sorted current-first, then by name using a **pinned** locale so the display order is stable across machines.

The **current** repository is always listed, even when it is not mirrored into the Memory Bank yet and even when it is remote-less (so its identity is the working-tree fallback) — the user must always be able to toggle the repository they are standing in. **Remote-less repositories are omitted only from the Memory-Bank-sourced rows**, since the Memory Bank records no remote URL to key them by; any other machine's remote-less repository therefore stays controllable in-repo rather than from this list.

Enumeration is deliberately defensive — the Memory Bank walk swallows its own I/O errors and the current-repository identity read is guarded — so the **only** failure that propagates out of the list is an unreadable store, i.e. exactly the condition on which the gate fails closed. Callers rely on that narrowness to tell "pushing really is blocked machine-wide" apart from "the list is merely incomplete".

## Behavior

### The outbound gate, per surface

The composed predicate is consulted at every point that would send memory off the machine. On the blocked path each keeps local state intact and emits nothing.

| Surface | Gate point | Blocked-path behavior |
| --- | --- | --- |
| Command line — every drain (post-queue, activation, pre-push worker) | the shared drain engine's entry gate, beside the existing sync-on-push skip | Returns the empty result with a "push disabled for this repo" note; **pending entries are kept** so a later re-enable catches up. There is one drain function and one entry gate — the pre-push path differs only in the options it passes, so it inherits this gate rather than carrying its own. |
| Command line — pre-push hook | its own read of the push-disabled **state**, after the queue write and before the worker spawn | Nothing is spawned; entries (recorded write-first) stay pending, and the hook prints a one-line notice to standard error so the push is not silent. It reads the state form, not the boolean, so the two reasons get different advice (below). The notice exists because the worker's drain gates on the same flag and its empty result would print nothing. |
| Command line — manual and MCP push | before any network call | Returns a tagged push-disabled result; the command prints it and exits **0** (a deliberate opt-out, not an error), and the MCP tool passes the tagged result through with a documented instruction not to retry. |
| Desktop editor — every memory-content send | the push and delete calls (the choke for memory content), gated on a working directory threaded from the push orchestrator | Rejects with the typed push-disabled refusal before opening the socket; the orchestrator's callers surface it. The orchestrator additionally fails fast at its own entry gate before any attachment is attempted. |
| JVM host — native manual push sites | a bridge call answering the composed predicate | The push site aborts with a "re-enable to push" message. A bridge reply that is not a definitive boolean answer — a non-object body, a missing or non-boolean field, or a JSON-RPC error — also blocks (fail-closed), but raises the distinct gate-unavailable verdict ("couldn't verify the setting") instead of the opt-out message. Only a bridge that could not run at all (no runtime, spawn failure, timeout) fails OPEN. |
| Desktop editor + JVM host — live-share **reconcile** | the ordinary push gate, reached through the shared push funnel | **Swallowed, not surfaced.** Both reconcile paths catch the refusal and return quietly, leaving the cached share record intact. Reconcile is a best-effort background pass the share modal runs on every view, so a push-disabled repository just means "nothing to sync outbound"; letting the refusal escape would render the user's own opt-out as the modal's "couldn't refresh the shared content" error. The **mint** path through the same funnel does *not* swallow it: there the user asked for a link, so the refusal must be reported. |

The command-line drains are the load-bearing gate for **automatic** leaks on *every* surface: git hooks are source-neutral and always run those drains, so a push-disabled repository never auto-syncs regardless of which editor is installed. The editor and JVM gates cover their respective **manual** push actions, which do not go through the drains.

### Mid-run holds inside a drain

The drain's entry gate runs once, before its loop. The opt-out can still trip after it, and both places that can trip produce a **hold** — an outcome that is neither pushed nor failed:

- the **per-commit re-read** at the top of each commit's push, so a user who disables push mid-drain stops the REMAINING commits; and
- the **push-disabled refusal raised between one commit's own sends**, by the live re-check the push orchestrator performs before every attachment and again before the summary send, which the drain catches and converts rather than routing through its retry classifier.

A hold deliberately records **no attempt** — no error text, no retry burned — but it must still **release the entry's claim** by writing an empty patch. Otherwise the re-enable drain defeats itself: it is a single detached pass, a claim is honoured for its full staleness window, and the entries the user just re-enabled would be skipped as "claimed by another process" until an unrelated later trigger. "Leave the entry exactly as claimed" is the wrong instinct — the correct invariant is "indistinguishable from an entry this drain never reached", which includes being re-claimable.

The manual and MCP push path has the same shape one level up: its entry gate returns the tagged push-disabled result before any network call, and a refusal raised mid-run — after that gate passed — is converted to the **same** tagged result rather than a generic error, so a deliberate user setting is never reported as a failure. Summaries already pushed in that run stay pushed.

### The control surfaces

All three drive one shared engine. Reading resolves the repository's canonical identity and consults the machine-global store; writing resolves the same identity, writes the entry, emits telemetry, and — when re-enabling for the current repository — triggers the compensation drain. The single source of truth is that one store, **not** the repository's profile file. The command line and the JVM host toggle the **current** repository; the desktop editor's settings additionally lists every repository the Memory Bank knows about.

- **Command line** — one command shows the current repository's state and toggles it, with a machine-readable output mode that mirrors the other read commands. **The enable and disable options are mutually exclusive**: passing both errors out and does nothing, checked *before* either branch so an ambiguous invocation can never fall through to the destructive enable path.
- **Desktop editor** — a per-repository toggle in the settings view's sync tab, listing every repository the Memory Bank knows about plus the current workspace's. **Every row, including the current one, is written by identity** — the key of the row the user actually clicked. The current-repository flag decides only whether the re-enable drain can run afterwards (that needs a working tree); it deliberately does *not* also re-derive the target from the workspace path, which would give "which repository did they mean" two sources of truth that disagree once the workspace's remote changes after the list was rendered. Each toggle applies immediately, with the persisted list re-posted afterwards so a failed write snaps the checkbox back to reality. The Memory Bank root is read **separately** from the store and degrades to "none" on failure, so a configuration read error is never reported as an unreadable store — a machine-wide "pushing is blocked" alarm for a condition that blocks nothing.
- **JVM host** — reads the toggle's initial state through a bridge operation returning the pure per-repo **state** (not the composed predicate) and writes through a second one that acts on the project's working directory. All the flag logic lives in the shared engine; there is no host-side re-implementation. The write operation **validates rather than coerces** its request field: a non-boolean is rejected outright. A truthiness test would make a missing or mistyped field silently mean ENABLE — and enabling is the one direction that rebuilds an unreadable store from empty. A malformed request must never take that path.

### Re-enable catch-up

Toggling a repository back **on** writes the flag *and*, when the surface has a working tree for it, triggers the same detached compensation drain that activation and sign-in use, so memory retained while the repository was disabled syncs without waiting for the next push. Toggling **off** only writes the flag; pending entries are left in place.

Re-enabling a **different** repository by identity (a non-current row in the machine-wide list) only writes the flag — there is no working tree to drain — so that repository's backlog syncs on its own next activation or push.

### Telemetry

A toggle emits a disable or enable event carrying the surface that triggered it.

## State Transitions

| From | Event | To | Notes |
| --- | --- | --- | --- |
| Absent / allowed | Toggle off (any surface) | Disabled | Only the flag is written; pending entries left pending. |
| Disabled | Toggle on, current repository | Allowed | Flag written, then a compensation drain is triggered. |
| Disabled | Toggle on, a row that is not the current repository | Allowed | Flag written only; that repository drains on its own next activation or push. |
| Disabled | Any gated outbound path fires | Unchanged | The gate is read-only; the repository keeps capturing locally and keeps refusing to send. |
| Store unparseable | Toggle on | Rebuilt from empty | Every other repository's opt-out is dropped; the old file is preserved beside the store and the fact is reported on every surface. |
| Store unparseable | Toggle off | Unchanged | The write refuses rather than destroying other repositories' opt-outs while adding a restriction. |
| Store version newer than this build | Toggle either way | Unchanged | Refused with the upgrade-required error; the enable path's rebuild explicitly does not apply. |

## Notable Behavior

- **The push opt-out and the manual disable flag are independent.** A repository may be push-disabled while fully enabled for capture, and vice versa. They live in **different** stores under **different** locks — this one machine-global and identity-keyed, the other repo-wide inside the working tree. The predicate composes them; nothing shares one file.
- **The predicate goes through the migrating reader on purpose.** Reading a raw profile would miss a legacy-marker-only disable and wrongly allow a manual push. (Surprising; the reason the predicate is not a two-field struct read.)
- **Automatic leaks are gated on the command-line side for every surface; the native gates only add the manual paths.** Because git hooks are source-neutral command-line code, gating the drains already stops auto-sync for editor-only and JVM-only installs. (Central design point.)
- **The toggle is always read live, keyed by identity, on every surface.** There is no per-worktree or cached copy to drift. The desktop editor's orchestrator entry check and the per-call check inside its send/delete choke are *both* live, so a push of N attachments performs one plus N reads rather than caching one decision; the command-line loop re-reads before **every** attachment send from inside its one kind-generic loop — so every registered context kind, present and future, inherits it without a per-kind call site — *and* before the summary send, which is the last outbound call of the group and can be many seconds after the loop began; and the JVM bridge's outbound calls re-check, with the command line's mid-call refusal remapped back into the host's own type so it lands on the panels' quiet "re-enable to push" handling rather than the generic failure path. A mid-push opt-out therefore takes effect immediately everywhere.
- **Only the repository IDENTITY is memoized; neither state that can say "don't push" ever is** — and the memo halves the per-read subprocess cost rather than removing it, because the manual-disable read resolves its own root through a git subprocess every time. (Surprising; the reason the gate is not "cache the whole decision".)
- **A remote-less repository does NOT share one decision across worktrees.** The shared-decision property comes from the identity: worktrees of the same repository share one git configuration and so resolve the same remote. With no remote, the identity falls back to the worktree path — so each worktree of a remote-less repository is a **separate key** with its own opt-out, and so is any explicitly-passed working directory below the root. Such repositories are already absent from the machine-wide list for the same reason; this is the one place the "one decision per repository" rule does not hold. (Surprising; follows from the identity fallback.)
- **An unreadable store reports OFF for every repository, so every surface that reports OFF must say which OFF it means.** Attributing a fail-closed read to the user is wrong twice over — they chose nothing, and the condition is machine-wide rather than per-repository — so every reporting surface consumes the state form, not the boolean:
  - The command-line show prints the reason and a repair hint; its machine-readable mode adds an error field.
  - The installation-health report carries **both** halves, so the health output prints an outbound-push row only when push is off and branches on the error: a "blocked — setting unreadable" line naming the whole error string instead of "disabled for this repo". Because that string already reads "the store at `<path>` could not be read / is corrupt and could not be parsed: `<reason>`", the rendered row names the file *and* the reason, at the cost of nesting one sentence inside another.
  - The MCP health tool carries **both** halves, and carries them **conditionally**. Its projection is curated — a field not named there is dropped — so both are named explicitly: the flag is emitted only when true, and the error only when the flag is true *and* an error was recorded. Absent therefore means "this repository pushes", which is the honest encoding given the gate treats an absent flag as allowed, and no host can mistake a fail-closed machine-wide read failure for a per-repository decision the user made. This is the surface that cannot ask a human why its push was refused.
  - The pre-push notice branches on it too (below).
  - The desktop editor's settings list posts an unreadable marker alongside the last-known (stale) rows, so the checkboxes are explicitly marked untrustworthy rather than silently showing every repository as pushing while every push is in fact blocked.
  - The JVM settings checkbox renders the fail-closed case as its **unknown** state — box disabled, state not marked loaded (so the dialog's write is skipped), tooltip naming the store path. Leaving the toggle unwritable is load-bearing rather than merely cautious, since writing "enable" is exactly the recovery that rebuilds the store from empty. That host treats a failed read, a malformed reply, and a reply carrying the error as the same unknown, and never defaults to "push is on".
- **The unreadable-store notice must not recommend enabling.** Re-enabling is the documented recovery, but on a corrupt store it rebuilds from an empty set and **drops every repository's opt-out**. So the one notice a user cannot miss — the pre-push line, printed on every push — deliberately does *not* offer it when an error is set; it points at the plain command, which explains the trade-off in full. Only the genuine user opt-out gets the re-enable hint. The JVM tooltip follows the same rule. (Surprising: the same condition yields two different notices on purpose, and the destructive recovery is reachable only from a surface that first explains what it destroys.)
- **New repositories push by default.** The gate treats an absent flag as allowed, so a restriction is always an explicit action.
- **The opt-out never burns retry budget, and it is protected twice.** The hold branch above intercepts the refusal and records no attempt at all. The drain's retry classifier *also* gives the refusal its own non-incrementing category, alongside not-signed-in, permission-denied, binding-required and client-outdated — but that entry is **unreachable from the only production caller**, because the hold branch is tested first and returns. It is a redundant second line of defence, not the mechanism. Retrying cannot succeed until the user changes the setting, so counting it against the ceiling would quietly retire entries the re-enable drain is supposed to flush. (Notable; one of the two guards never runs.)
- **A mid-run hold writes to the pending store precisely in order to look untouched.** It records no attempt but must clear the claim, or the re-enable drain skips the very entries it was launched to flush. (Surprising; the original bug was to leave the entry exactly as claimed.)
- **The gated choke covers memory content, not every outbound byte.** The desktop editor's push and delete calls are the choke for memory *content*, but they are not the extension's only outbound HTTP path: its share service issues its own requests to create and update a live share, and those are deliberately ungated. They carry share metadata (visibility, recipients, a reference pointing at already-pushed documents) rather than memory content, and every path that reaches them runs a gated push first — so a push-disabled repository aborts before any of them fire. Recorded explicitly because "the single HTTP choke" would invite a future author to add a content-carrying send there and assume the gate covers it, which is the exact omission this feature was built to close. Same shape on the JVM side, where the share bridge operations are excluded from the gated wrapper for the same reason. (Surprising; intentional.)
- **The vault sync is a separate channel.** This flag governs only per-repository Space push; the personal Memory-Bank vault sync is unaffected.

## Shared Behavior

- The repo-wide profile file, its anchoring, atomic write, lock, and the manual-disable field with its legacy-marker migration are defined by **Repo-Wide Manual Disable Flag** (145).
- Canonical repository identity, its normalization and its remote-less fallback are defined by **Canonical Repo URL and Name Derivation** (232).
- The push payload, endpoints and binding flow are defined by **Summary Push to Jolli Space** (94), **Binding Required Flow** (95), **Jolli Space Push Article Assembly** (231) and **IntelliJ Push Orchestration** (263).
- The drains and the pre-push hook are defined by **Git Pre-Push Hook and Detached Sync Worker** (268), **Push-Pending Queue and Claim-Based Drain Engine** (269) and **Push-Pending Compensation Retry** (270), which also owns the compensation drain that re-enabling triggers and the retry classification the push-disabled category joins.
- The telemetry catalogue is defined by **Telemetry Event Catalog** (205).
- The bridge operations carrying the gate and the toggle are defined by **CLI IDE-Bridge Command Surface** (287).
- The lock-primitive catalogue this store's lock joins (budgets, strict-versus-best-effort discipline) is defined by **Lock Primitive Registry** (297).
- The shared classifier that makes the push-disabled refusal abort a whole attachment or summary loop instead of being collected per item is defined by **Repo-Wide Push-Refusal Classification** (327).
- The command's own option surface and rendering is defined by **CLI Space Push / Spaces / Bind Commands** (230).
- The installation-health report and the MCP health tool that carry the state are defined by **CLI status command** (58) and **MCP server — tool surface** (148).
