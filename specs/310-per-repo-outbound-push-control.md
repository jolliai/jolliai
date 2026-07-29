# 310. Per-Repo Outbound-Push Control

## Topic Statement

A machine-global store records which repositories have **outbound push to a Jolli Space** turned off. Unlike `manuallyDisabled` (spec 145, which stops *all* capture), this opt-out blocks only outbound sync — memory is still captured and stored locally. The store lives at `~/.jolli/jollimemory/push-control.json` and is keyed by each repo's **canonical identity** (`getCanonicalRepoUrl`), NOT by a working-tree path — so the machine-wide control view (whose rows come from the Memory Bank, which knows repos by identity) and the per-repo gate (which resolves its own canonical URL) share one key, and a repo checked out in several worktrees shares one decision. A single predicate, `isOutboundPushAllowed(cwd)`, composes the durable `manuallyDisabled` flag with this store and is the one gate every outbound push path on every surface consults: the two CLI drains, the CLI manual/MCP push, the VS Code HTTP push client, and (via the IDE bridge) the IntelliJ push sites. The VS Code Settings **Sync to Jolli** tab lists every repo the Memory Bank knows about (plus the current repo) with a per-repo toggle; the CLI and IntelliJ expose a current-repo toggle. New repositories are push-*allowed* by default — a restriction is always an explicit opt-in.

## Scope

**In scope:**
- The `pushDisabled` opt-out, its storage (a machine-global, identity-keyed `push-control.json` — deliberately NOT shared with `manuallyDisabled`), and its semantics versus `manuallyDisabled`.
- The `isOutboundPushAllowed` predicate: what it composes, why it goes through the migrating readers, and the correctness hole that choice closes.
- Every outbound-push gate point across CLI, VS Code, and IntelliJ, and what each one does on the blocked path.
- The three current-repo control surfaces (CLI command, VS Code Settings toggle, IntelliJ bridge-backed toggle) and the shared engine behind them.
- Re-enable catch-up: what a toggle-on triggers.
- The telemetry events emitted on toggle.

**Out of scope:**
- `manuallyDisabled`'s own storage, migration, and capture gate (owned by spec 145).
- The push payload, endpoints, and error taxonomy (owned by specs 94 / 95 / 236 and the client error-mapping specs).
- The personal Memory-Bank **vault sync** (mb-sync) outbound channel (specs 150 / 170 / 174) — a different outbound path, deliberately NOT covered by this flag.
- Server-side repo allowlisting (`repo_not_allowlisted`) — a backend concern; this spec covers only how clients gate their own outbound sends.

## Data Contracts

### The push-control store (`PushControlStore`)

A machine-global JSON file at `~/.jolli/jollimemory/push-control.json` holding only the DISABLED repos, each as a self-describing entry:

```jsonc
{
  "version": 1,
  "disabled": [
    { "repo": "jolli", "identity": "https://github.com/jolliai/jolli", "disabledAt": "<ISO-8601>", "trigger": "cli" }
  ]
}
```

- **Keyed by canonical repo identity** (`getCanonicalRepoUrl` — see spec 232), not a working-tree path. Absent from the list = push allowed. The `identity` field is the only load-bearing one; `repo` (derived from the identity via `deriveRepoNameFromUrl`), `disabledAt`, and `trigger` are **display-only** so a hand-inspection of the file explains itself — `loadDisabledRepos` reads back the identities and nothing else.
- An **empty** `repoIdentity` is refused at the write with a thrown error, not stored. Persisting one would be worse than refusing: the read path skips entries with an empty identity, so the write would land on disk, report success, and read back as "not disabled" — a toggle that silently does nothing. Failing loudly surfaces a caller that passed a blank identity (an unparseable remote, a row from a degraded list) at the write instead of at the next gate read.
- Writes go through `withPushControlLock` (a machine-global lock, distinct from the runtime-registry lock) as a serialized read-modify-write, so a CLI toggle and a VS Code toggle of different repos can't lose-update each other; a lock timeout falls back to a best-effort unlocked write rather than dropping the toggle. The `disabled` array is written in **code-point** order of `identity` — deliberately not `localeCompare`, which would make the on-disk bytes depend on the ambient ICU locale (contrast the *display* sort in `listPushControlRepos`, which pins `"en"`).
- Reads (`loadDisabledRepos` / `isRepoPushDisabled`) treat a **missing** file as the empty set (push allowed — the first-run default), but a present-but-**corrupt/unreadable** file **propagates** so the gate fails CLOSED (see the predicate below) rather than silently allowing every push-disabled repo. A parseable-but-odd shape (non-array `disabled`, or malformed elements with no string `identity`) is tolerated as empty — it is readable, just carries nothing actionable. Enabling a repo (`setRepoPushDisabled(…, false)`) is the one exception: it rebuilds from an empty set on a corrupt file so `jolli push-control --enable` can always recover; disabling stays strict.

The opt-out deliberately does **not** live in the repo's working-tree `profile.json` (contrast `manuallyDisabled`, spec 145) precisely so the identity-keyed list and gate can share one key.

### The outbound-push predicate

`isOutboundPushAllowed(cwd)` returns `true` only when the repository is neither fully disabled nor push-disabled:

- `readManualDisableFlag(cwd)` — migration-aware (honors the legacy `disabled-by-user` per-worktree marker; see spec 145).
- `isRepoPushDisabled(getCanonicalRepoUrl(cwd))` — the store lookup.

Going through the migrating `readManualDisableFlag` (not a raw `readRepoProfile`) closes the hole where a repo disabled solely via the legacy marker would read as push-*allowed*.

### The machine-wide list (`listPushControlRepos`)

Sourced from the Memory Bank: `KBRepoDiscoverer.discoverRepos` yields every mirrored repo with the `remoteUrl` stored in its `<kbRoot>/.jolli/config.json`. Each `remoteUrl` is run through the **same** `normalizeRemoteUrl` the gate uses, so the list key equals the store key — a Memory Bank row recorded as `git@github.com:AcMe/Widgets.git` and a working tree whose `remote.origin.url` is `https://github.com/acme/widgets` collapse onto one row, one key, one decision. Each row carries its live disabled state (from the store), its display name, and an `isCurrentRepo` flag.

The **current** repo is always listed, even when it is not mirrored into the Memory Bank yet and even when it is local-only (no git remote, so its identity is the `file://<worktree>` fallback) — the user must always be able to toggle the repo they are standing in. **Local-only repos are omitted only from the *Memory Bank–sourced* rows**, since the Memory Bank records no `remoteUrl` to key them by; any other machine's local-only repo therefore stays controllable in-repo via `jolli push-control` / that surface's own current-repo toggle rather than from this list.

Enumeration is deliberately defensive — `discoverRepos` swallows its own IO errors and the current-repo identity read is guarded — so the **only** failure that propagates out of `listPushControlRepos` is an unreadable push-control store, i.e. exactly the condition on which the gate fails CLOSED. Callers rely on that narrowness to tell "pushing really is blocked machine-wide" apart from "the list is merely incomplete".

## Behavior

### The outbound-push gate

`isOutboundPushAllowed(cwd)` is consulted at every point that would send memory off the machine. On the blocked path each keeps local state intact and emits nothing:

| Surface | Gate point | Blocked-path behavior |
|---|---|---|
| CLI — post-queue / activation drain | `processPushPending`, beside the existing `syncOnPush` skip | Returns the empty result with a `"push disabled for this repo"` note; **pending entries are kept** so a later re-enable catches up. |
| CLI — pre-push inline drain | `processPrePushInline`, beside its own `syncOnPush` skip | Same note; entries (recorded write-first by the hook) stay pending. The pre-push hook additionally prints a one-line stderr notice so `git push` is not silent — and it reads `readPushDisabledState`, not the boolean, so the two reasons get different advice (see "The unreadable-store notice" below). |
| CLI — manual / MCP push | `pushBranchToJolli`, before any network call | Returns a new `{ type: "push_disabled" }` result; `jolli push` prints it and exits 0 (a deliberate opt-out, not an error), MCP `push_memory` passes the tagged result through. |
| VS Code — every memory-content send | `pushToJolli` / `deleteFromJolli` (the choke for memory content), gated by a `cwd` threaded from the push orchestrator | Rejects with a typed `PushDisabledError` before opening the socket; the orchestrator's callers (Share, Create-PR, Push) surface it. |
| IntelliJ — native manual push sites | the `outbound-push-allowed` IDE-bridge call, which returns `isOutboundPushAllowed` for the project | The push site aborts with a "re-enable to push" message. A bridge reply that is not a definitive `{ allowed: boolean }` — a non-object body, a missing/non-boolean field, or a JSON-RPC `error` — also blocks (fail-closed), but raises `PushGateUnavailableError` ("couldn't verify the setting") instead of the opt-out message. Only a bridge that could not run at all (Node missing, spawn failure, timeout) fails OPEN. |

The CLI drains are the load-bearing gate for **automatic** leaks on *every* surface: git hooks are source-neutral and always run the CLI drains, so a push-disabled repository never auto-syncs regardless of which editor is installed. The VS Code and IntelliJ native gates cover their respective **manual** push actions, which do not go through the CLI drains.

### The control surfaces

All three drive one shared engine (`PushControl`): `isPushDisabled(cwd)` resolves the repo's canonical identity (`getCanonicalRepoUrl`) and reads the opt-out from the **machine-global, identity-keyed push-control store** (see Data Contracts), and `applyPushDisabled(cwd, disabled, trigger)` resolves the same identity, writes the store entry, emits telemetry, and — when re-enabling — triggers the compensation drain. The single source of truth is that one store, **not** the repo's `profile.json` (contrast `manuallyDisabled`, spec 145). The CLI and IntelliJ surfaces toggle the **current repo** — the one they were opened in — while the VS Code Settings tab additionally lists every repo the Memory Bank knows about.

- **CLI** — `jolli push-control` shows the current repo's state; `--disable` / `--enable` toggle the current repo (`--cwd`). `--format json` mirrors the other read commands.
- **VS Code** — a per-repo Push toggle in the Settings webview's **Sync to Jolli** tab, listing every repo the Memory Bank knows about (via `listPushControlRepos`) plus the current workspace repo. **Every row, including the current repo, is written by identity** via `setRepoPushDisabledByIdentity` — the key of the row the user actually clicked. The `isCurrent` flag decides only whether the re-enable drain can run afterwards (that needs a working tree, so it goes through `triggerReenableDrain(workspaceRoot)`); it deliberately does **not** also re-derive the target via `applyPushDisabled(workspaceRoot, …)`, which would give "which repo did they mean" two sources of truth that disagree once the workspace's remote changes after the list was rendered. All three helpers are imported directly from the bundled CLI, and each toggle applies immediately (no "Apply Changes"), with the persisted list re-posted afterwards so a failed write snaps the checkbox back.
- **IntelliJ** — reads the toggle's initial state through the `push-control-get` IDE-bridge method (the pure per-repo flag) and writes through `push-control-set` (which acts on the project's `cwd`); its push sites gate on `outbound-push-allowed` (the composed predicate). All the flag logic lives in the shared `PushControl` core — there is no Kotlin re-implementation, and the machine-global store stays the single source of truth.

### Re-enable catch-up

Toggling a repo back **on** writes `pushDisabled: false` *and* triggers the same detached compensation drain (spec 270) that activation and sign-in use, so memory retained while the repo was disabled syncs without waiting for the next `git push`. Toggling **off** only writes the flag; pending entries are left in place.

### Telemetry

`applyPushDisabled` emits `push_disabled` / `push_enabled` (append-only catalog, spec 205) carrying a `trigger` of `cli` | `vscode` | `intellij`.

## State Transitions

| From | Event | To | Notes |
|---|---|---|---|
| Absent / `false` | Toggle off (any surface) | `true` | Only the flag is written; pending entries left pending. |
| `true` | Toggle on (any surface) | `false` | Flag written, then a compensation drain is triggered. |
| `true` | Any gated outbound path fires | Unchanged | The gate is read-only; the repo keeps capturing locally and keeps refusing to send. |

## Notable Behavior

- **`pushDisabled` and `manuallyDisabled` are independent.** A repo may be push-disabled while fully enabled for capture, and vice versa. They live in **different** stores under **different** locks: `pushDisabled` in the machine-global, identity-keyed `~/.jolli/jollimemory/push-control.json` (this spec), `manuallyDisabled` in the repo-wide working-tree `profile.json` (spec 145). The predicate composes them; nothing shares one file.
- **The predicate goes through the migrating readers on purpose.** Reading a raw profile would miss a legacy-marker-only disable and wrongly allow a manual/MCP push. (Surprising; the reason the predicate is not a two-field struct read.)
- **Automatic leaks are gated CLI-side for every surface; native gates only add the manual paths.** Because git hooks are source-neutral CLI code, gating the two CLI drains already stops auto-sync for VS Code- and IntelliJ-only installs. (Central design point.)
- **The toggle is always read live, keyed by identity.** Each surface reads and writes the flag from the one machine-global, identity-keyed push-control store; a repo checked out in several worktrees therefore shares one decision. There is no per-worktree or cached copy to drift. Live-read is a requirement, not an accident: the VS Code orchestrator's fail-fast check and the per-call check inside `pushToJolli` / `deleteFromJolli` are *both* live, so a push of N attachments performs 1 + N reads rather than caching one decision — a mid-push opt-out takes effect immediately.
- **Only the repo IDENTITY is memoized; neither "don't push" state ever is.** The gate would otherwise spawn `git config --get remote.origin.url` on all 1 + N reads of a single push, so the resolved canonical identity is memoized per-cwd for a few seconds — changing it means editing `git config`, where staleness is harmless. The two states that can say *no* are deliberately excluded: `manuallyDisabled` (spec 145) is the highest-priority stop-ALL opt-out whose writers live in **other** processes (`jolli disable` in a terminal, the VS Code / IntelliJ Disable commands), so an in-process memo could not be invalidated airtight and any TTL would be a window in which a repo the user just disabled keeps pushing — a privacy leak, not a latency trade-off; and the push-control store is excluded by the live-read rule above (a plain file read with no subprocess to save anyway). The identity memo is swept of expired entries once it passes a size cap, so a long-lived host that sees many roots cannot grow it without bound. (Surprising; the reason the gate is not "cache the whole decision".)
- **A local-only repo does NOT share one decision across worktrees.** The shared-decision property comes from the identity: worktrees of the same repo share `.git/config`, so they resolve the same `remote.origin.url`. With no remote, `getCanonicalRepoUrl` falls back to `file://<worktree>` (spec 232) — so each worktree of a remote-less repo is a **separate key** with its own opt-out, and so is any explicitly-passed `--cwd` below the root. Such repos are already absent from the machine-wide list for the same reason; this is the one place the "one decision per repo" rule does not hold. (Surprising; follows from the identity fallback.)
- **An unreadable store reports OFF for every repo, so every surface that reports OFF must say which OFF it means.** `readPushDisabledState(cwd)` returns the fail-closed flag *plus* the error (which names the store's absolute path). Every reporting surface consumes the state form, not the boolean, because attributing a fail-closed read to the user is wrong twice over — they chose nothing, and the condition is machine-wide rather than per-repo:
  - `jolli push-control` show prints the reason and the repair hint; `--format json` adds an `error` field.
  - `getStatus` carries **both** halves (`pushDisabled` + `pushDisabledError`), so `jolli status` prints `Blocked — setting unreadable (<path>)` instead of `Disabled for this repo`.
  - The MCP `status` tool carries both halves **explicitly**. It does not inherit them from `getStatus`: `buildStatusSummary` projects `StatusInfo` into a curated `StatusResult`, so a field that is not named there is dropped. It was, and an AI host whose `push_memory` got refused had no channel at all for learning why.
  - The pre-push hook branches on it too — see below.
  - The VS Code Settings list posts `unreadable` alongside the (stale) rows so the checkboxes are explicitly marked untrustworthy.
  - The IntelliJ Settings checkbox renders the fail-closed case as its existing **unknown** state (disabled box, tooltip naming the store path, and — per the next bullet — pointing at `jolli push-control`, never `--enable`). The `push-control-get` bridge therefore returns the state form; leaving the toggle unwritable is load-bearing rather than merely cautious, since writing "enable" is exactly the recovery that rebuilds the store from empty.

  There is deliberately **no boolean-only shorthand** for the opt-out. One existed (`isPushDisabled`) and was deleted: gates never wanted it (they read `isOutboundPushAllowed`, which also composes in `manuallyDisabled`), and its only caller was the `push-control-get` bridge — a reporting surface, which is precisely where dropping the reason produces the "you turned this repo off" misattribution this bullet exists to forbid.

- **The unreadable-store notice must not recommend `--enable`.** `--enable` is the documented recovery, but on a corrupt store it rebuilds from an empty set and **drops every repo's opt-out**. So the one notice a user cannot miss — the pre-push stderr line, printed on every `git push` — deliberately does *not* offer it when `error` is set; it points at `jolli push-control` (which explains the trade-off in full) instead. Only the genuine user opt-out gets the `--enable` hint. (Surprising: the same condition yields two different notices on purpose, and the destructive-recovery path is reachable only from a surface that first explains what it destroys.)
- **New repos push by default.** Gating treats an absent flag as allowed, so a restriction is always an explicit action.
- **Re-enabling syncs the backlog.** Toggle-on for the CURRENT repo (CLI `--enable` / the current-repo toggle) kicks the compensation drain immediately so retained memory flushes without another push. Re-enabling a DIFFERENT repo by identity (the VS Code list rows) only writes the flag — there is no working tree to drain there — so that repo's backlog syncs on its next activation or `git push`.
- **A mid-run hold must RELEASE the pending entry's claim, not just skip the send.** Every gate that trips *during* a drain (the per-batch and per-commit re-reads in both `processPushPending` and `processPrePushInline`) deliberately records no attempt — no `lastError`, no retry burned — but it must still clear `claimedAt` via an empty patch. Otherwise the re-enable drain above defeats itself: it is a single detached pass, `claimForPush` honours a claim for `CLAIM_STALE_MS` (5 min), and so the entries the user just re-enabled are skipped as "claimed by another process" and wait for an unrelated later trigger. "Leave the entry exactly as claimed" is the wrong instinct here and was the original bug — the correct invariant is "indistinguishable from an entry this drain never reached", which includes being re-claimable. (Surprising: the hold path writes to the pending store precisely in order to look untouched.)
- **The vault sync is a separate channel.** `pushDisabled` governs only per-repo Space push; the personal Memory-Bank vault sync is out of scope and unaffected.
- **The gated choke covers memory content, not every outbound byte.** `pushToJolli` / `deleteFromJolli` are the choke for VS Code pushes of memory *content*, but they are not the extension's only outbound HTTP path: `vscode/src/services/JolliShareService.ts` issues its own `node:http`/`node:https` requests for `createLiveShare` / `updateLiveShare`, and those are deliberately ungated. They carry share metadata (visibility, recipients, a `ref` pointing at already-pushed Space docs) rather than memory content, and every path that reaches them runs a gated push first — so a push-disabled repo aborts before any of them fire. Recorded explicitly because "the single HTTP choke" would invite a future author to add a content-carrying send there and assume the gate covers it, which is the exact omission this feature was built to close. Same shape on the Kotlin side, where the `*-share` bridge operations are excluded from the `jolli-api` gate for the same reason. (Surprising; intentional.)

## Shared Behavior

- The repo-wide profile file, its anchoring, atomic-write, lock, and the `manuallyDisabled` field and its legacy-marker migration are owned by spec 145.
- The push payload / endpoints / binding flow are owned by specs 94, 95, 231, 236, 263.
- The two CLI drains and the pre-push hook are owned by specs 268, 269, 270; this spec owns only the per-repo gate added to them.
- The compensation drain that re-enable triggers is owned by spec 270.
- The telemetry catalog is owned by spec 205.
- The IDE-bridge command surface that carries `outbound-push-allowed` / `push-control-set` is owned by spec 287.
