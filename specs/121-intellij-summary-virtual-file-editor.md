# IntelliJ Summary Virtual-File Editor

## Topic Statement

A trio of IDE editor wrappers that expose a stored commit memory as if it were a file in the IDE — a virtual file whose name is `<sparkle> <short-hash> — <commit-message>`, an editor provider that claims only that virtual-file class, and a file editor whose body is the embedded HTML summary view. Every surface that opens a memory now goes through **one shared open path** that enforces a hard rule: **at most one memory tab per project**. That path looks for an already-open memory editor and, if it finds one, swaps that tab's content to the newly requested memory and re-activates it; only when there is none does it build a new virtual file and let the IDE open a new tab.

## Scope

**In scope:**
- The user-visible triggers that open a memory in the editor area, and the single shared open path all of them funnel through.
- The one-tab-per-project rule: how an existing memory tab is found, how its content is swapped, and what the user sees instead of a second tab.
- The virtual-file's user-visible properties: tab title (computed from the *currently held* memory), tab icon, read-only status, and the reported path.
- The virtual file's equality contract — **reference identity**, not commit-hash equality — and why that is what makes reuse work rather than defeat it.
- The mutability of the virtual file's held memory and read-only flag, and the deliberate absence of a rename announcement on a swap (plus the stale-title consequence).
- The provider's claim rule: it accepts only the dedicated virtual-file class and rejects all real files and other virtual files.
- The editor type identifier (`jollimemory-summary`) — exposed as part of the IDE's editor-provider contract.
- The editor's "default editor hidden" policy — when this provider claims a file, no other editor opens for the same file.
- Tab title format and the always-clean (never dirty) state.
- The re-open-the-same-memory case, including the one situation where it forces a fresh render rather than doing nothing.
- The in-place read-only flip: one tab handed an editable own-repository memory and then a read-only foreign one, and what changes.
- Lifecycle: ephemeral (no persistence across IDE restart), disposed when the tab is closed.
- The tab's borrow-and-return relationship with the embedded-browser pool: taking a lease when the body is constructed, what a refused lease degrades to, and exactly what the tab must detach before handing the lease back.
- Boundary with the embedded HTML summary view (the editor's body delegates to it, including the content swap).

**Out of scope:**
- The contents of the embedded HTML summary view, and what a content swap does inside it (re-render, identity-generation guards, parked page-load intents) — owned by spec 120.
- The embedded-browser pool's own rules — capacity, standby target, eviction, prewarm, and disposal — owned by spec 302. This spec covers only the lease this tab holds.
- The mechanism by which the memory is read from storage — owned by the storage spec.
- The action toolbar that the editor exposes — currently none beyond the IDE-standard tab actions.
- Persistence of an open memory tab across IDE restarts — explicitly not supported.
- The way memories appear in tool-window rows — owned by the per-section panel specs.

## Data Contracts

### Triggers, and the one path they share

There are **eight** places in the plugin that open a memory in the editor area, and all eight route through the **same shared open path**:

| Entry point | Read-only requested? |
| --- | --- |
| The COMMITS list's own-branch open — one helper reached from the row's hover "view memory" icon, a **single** click on the row body, several rows inside an expanded commit that have nothing of their own to open (a shipping-signal row with no external link — including the test-guide row, which opens the memory whether or not a guide exists — a linked-reference row carrying no URL, a conversation row whose stored content cannot be found, and a plan or note row whose archived body is missing), and the panel-level "open the branch's most recent memory" entry | no |
| The COMMITS list's **foreign-branch** open, which reads the memory straight off the Memory Bank folder | **yes** |
| A double-click (or the "View Commit Memory" context action) on a memory row in the Memory Bank explorer tree | **yes**, when the row belongs to a foreign repository |
| The PINNED section's open action on a memory pin | no |
| The action bar's Share action, which opens the branch's newest memory and then asks that tab to reveal its share overlay | no |
| The "view newest memory" IDE action | no |
| The branch-level pull-request draft's per-memory link (clicking one of the memories the draft was built from) | no |
| The retired all-branches memory list's row open — **unreachable**, the panel has no construction site | no |

The commits list reaches its helper by **single click only** — it has no context menu, no keyboard binding, and no double-click gesture; the row's full click map is owned by spec 123.

No surface constructs a virtual file itself any more — the virtual file is built in exactly one place, inside the shared path, and only on the branch that opens a brand-new tab.

The shared path — which contains no thread hop of its own and asserts nothing about the thread it is entered on:

1. Scan the project's open editors for an existing memory editor.
2. **If one is found** — swap the memory (and the read-only flag) held by that tab's virtual file, swap the same pair into the editor's body, then ask the IDE to open the already-open file, which merely activates its tab. No editor is constructed, no browser lease is taken, and the embedded view keeps its native surface attached.
3. **If none is found** — build a fresh virtual file around the memory and read-only flag and hand it to the IDE's standard "open file" mechanism with focus. The IDE consults the provider and constructs a new editor.

Every caller **but one** resolves the memory asynchronously *before* entering this path, and hops onto the UI thread to enter it with an already-materialized memory in hand. Most resolve it by commit hash through the shared host lookup; the two foreign-source paths (the COMMITS foreign-branch open and the Memory Bank explorer) instead read and parse the memory document out of the Memory Bank folder directly. A resolution that comes back empty shows an informational dialog on the surfaces that have one ("No summary found for `<short-hash>`", wording varying slightly), logs and falls back to opening the plain file on the Memory Bank explorer, and is silently dropped on the COMMITS foreign-branch path — in every case the shared open path is never entered, and an already-open memory tab is left untouched.

**The exception is unguarded, and it is a genuine inconsistency.** The branch-level pull-request draft's per-memory link does neither of those things. It resolves its memory **synchronously**, by picking it out of the list the draft was already built from, and it is dispatched **straight from the embedded browser's message handler** with no hop onto the UI thread and no assertion that it is on one. Its sibling handlers in that same dispatcher hop explicitly, and the surrounding commentary describes that dispatch thread as deliberately *not* the UI thread. The shared open path adds no protection of its own — no hop, no assertion — while manipulating editor state the IDE expects to be touched only on the UI thread. Stated honestly: whether that handler really does run off the UI thread rests on the surrounding code's own comments and on its siblings' defensive hops, not on anything provable from this repository, so the defensible form of the finding is the narrower one — **the code does not enforce the discipline this spec describes.** (Defect; unhandled.)

There is one defensive branch: if an existing memory editor is found but it is not backed by this spec's virtual-file class, the path logs a warning and falls through to opening a new tab. Nothing reachable produces that state.

### Virtual-file shape

The virtual file is a lightweight, in-memory file (no backing path, no real bytes) that **holds a mutable reference** to the memory it is currently presenting, plus a mutable read-only flag. Its user-visible properties:

| Property        | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| `name`          | `"✨ <first-8-chars-of-hash> — <first-50-chars-of-commit-message>"` (sparkle + hash + em-dash + truncated message), **recomputed from the currently held memory on every query** — not frozen at construction |
| reported path   | the same string as `name` (delegated), so a swap cannot leave the two disagreeing      |
| `extension`     | empty string (no extension)                                                            |
| `isWritable`    | `false` — **always**, regardless of the read-only flag's value. A test pins this        |
| equality        | **reference identity** (a virtual file equals only itself); its hash code is its identity hash |

Two consequences of that equality contract:

- **IDE-level dedupe by commit hash is gone.** Two virtual files carrying the same commit hash are *not* equal, so the IDE's editor manager would happily open two tabs for the same memory. It never gets the chance, because the shared open path never builds a second virtual file while one memory editor is alive.
- **Reuse is enforced solely by that single-owner lookup.** Identity equality is what *permits* the swap: hash-based equality would make the IDE treat the post-swap file as a different file, close the tab, and reopen it — exactly the tab teardown the reuse exists to avoid.

The swap deliberately **announces no rename**. Renaming a virtual file emits a filesystem rename event that the IDE's editor manager interprets as "close the editor at the old name and open one at the new name" — which would destroy the tab and defeat the reuse. The cost is a title that can lag: most IDE tab paths re-query the name on refresh and so pick up the new memory's title, but on the paths that do not, the user sees the *previous* memory's title over the *current* memory's content until something else refreshes the tab.

### Editor provider contract

A single registered provider:

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| `editorTypeId`    | `"jollimemory-summary"`                     |
| `accept(file)`    | `true` only when `file` is the dedicated virtual-file class |
| `policy`          | `HIDE_DEFAULT_EDITOR`                       |
| dumb-aware        | yes (the provider is available during indexing) |

The provider does not match any other file. It does not match real files with any extension; it does not match other virtual files. This is what guarantees no other editor tab competes for these memories.

### Editor body

The editor's component is the embedded HTML summary view (its own spec). The editor itself contributes only the IDE wrappers around it:

| Trait               | Value                                              |
| ------------------- | -------------------------------------------------- |
| `name` (display)    | `"Commit Memory"` (used by the IDE for accessibility / breadcrumb roles, not the tab title) |
| `isModified`        | always `false`                                     |
| `isValid`           | always `true`                                      |
| `setState(state)`   | no-op                                              |
| property-change listeners | accepted but never fired                     |
| `getFile()`         | the wrapping virtual file                          |
| content swap        | accepts a new memory + read-only flag and forwards both to the embedded HTML summary view, which re-renders in place |
| reveal-share request| accepts a request to open the embedded share overlay (used by the action bar's Share entry point, which opens the tab and then asks for the overlay) |

Because the same editor instance survives a swap, a caller can open a memory and then, in the same turn, look the editor up again and ask it to reveal its share overlay — the reuse is what keeps that two-step pattern valid.

When the tab is closed, the editor's `dispose()` calls through to dispose the embedded HTML summary view. That teardown does **not** destroy the embedded browser — it **returns** it to the project-scoped browser pool for the next memory tab to reuse (spec 302). What it does release is everything the tab attached to that shared instance: the message-bridge query channel, the navigation-interception and load-completion observers (all three through the lease), and the tab's own size and visibility observers (which the lease does not track and the tab must therefore detach itself). All of it must come off precisely because the shared instance **outlives the tab** — a missed detachment accumulates one stale observer set per open/close cycle instead of being collected with the tab.

## Behavior

### Opening a memory — first tab of the session

1. User clicks a memory row.
2. The row's host fetches the memory asynchronously. On the hash-lookup surfaces that fetch is a **native in-process read**: it consults the local Memory Bank folder first when one is attached and populated, and falls back to the orphan branch (list-and-show against the memory ref) on a miss. Neither route is a call through the storage abstraction; only the alias fallback — resolving a hash that is an alias of another commit's memory — is a cross-process round-trip. (The folder-vs-branch precedence and when the folder route is attached at all belong to the storage spec.) The two foreign-source surfaces skip the lookup and parse the memory document out of the folder themselves.
3. On the UI thread, the host enters the shared open path, which finds no existing memory editor, so it wraps the memory in a fresh virtual file and hands it to the IDE's standard open-file mechanism with focus.
4. The registered provider is consulted; it accepts the file; the IDE constructs a new editor; the editor's body is the embedded HTML summary view bound to the memory.
5. Constructing that body **takes out a lease on an embedded browser from the project-scoped pool** (spec 302) rather than building one of its own: immediate when an idle instance is on standby, otherwise a synchronous construction on the UI thread. The lease is also the only sanctioned attachment point for the tab's message bridge and its navigation/load observers.
   - If the pool **refuses** the checkout — it has been disposed, or the call is off the UI thread, or construction genuinely fails — the refusal is caught along with any other construction failure and the editor's body becomes the pre-existing read-only plain-text rendering of the memory instead (spec 120). No lease is retained, so the tab's later teardown hands nothing back.
6. The tab title is the virtual-file's `name`. The tab is marked read-only (no dirty dot).

This is the only open that pays the cost of attaching a fresh native surface. Every later open in the session reuses it.

### Opening a memory — a tab is already open (the normal case)

The shared open path finds the existing memory editor and, instead of opening anything:

1. Swaps the memory and read-only flag held by that tab's virtual file.
2. Swaps the same pair into the editor, which forwards them to the embedded HTML summary view for an in-place re-render (spec 120 owns what that re-render does).
3. Asks the IDE to open the file that is already open, which only activates its tab.

The user-visible consequence is a hard one: **two memories can no longer be viewed side by side.** Opening memory B while memory A is showing replaces A — A's tab becomes B's tab. There is no second tab and no way to pin one memory while browsing another. The reason is the native-surface cost and the half-rendered first paint a fresh tab reliably produced on macOS; keeping one already-attached surface and changing only its document avoids both.

### Re-opening the memory that is already showing

Requesting the *same* memory with the *same* read-only flag normally changes nothing at all — the tab already shows exactly what was asked for, and re-rendering it would cost a full page reload for no benefit. Sameness here is a deep comparison of the whole memory, not a hash comparison, so any real change (an edited topic, a new plan) takes the swap path instead.

There is one exception, and it is a user-facing rescue. If the tab's very first content load has already been issued but the page never reported completion — the state that leaves a memory tab blank indefinitely — a repeat open of the same memory **forces a fresh render**. So re-clicking an apparently stuck blank memory tab unsticks it, which is exactly what a user in that situation tries.

### Switching between an own memory and a foreign one (read-only flip)

The same tab can be handed an editable memory from the current repository and then a read-only one from a foreign repository or branch (or the reverse), switching modes in place. On the flip:

- Write affordances appear or disappear in the embedded page (topic edit/delete controls, plan actions, share/push, generate/edit/delete of the recap and the test guide, the transcript-management controls, and the whole pull-request card), and the host refuses the corresponding commands even if the page somehow sends them.
- The tab stops or resumes reacting to memory-change notifications: a read-only tab unsubscribes (it would otherwise spend a storage read and a full re-render on every event for a memory it cannot change), and flipping back to editable re-subscribes.

The read-only *flag* never affects writability at the IDE level — the virtual file reports itself unwritable in both modes.

### No-summary path

If the commit hash resolves to no memory, the surface shows an informational dialog before the shared open path is ever entered — wording varies by surface ("No summary found for this commit." / "No summary found for `<short-hash>`." / "No commit memories found on this branch.") — and no tab is opened or swapped. A tab already showing another memory is left untouched.

### Closing a tab

When the tab is closed:

- The editor's `dispose()` is called.
- That disposes the embedded HTML view, which detaches the tab's own size and visibility observers from the shared browser's component **first** (so no next tenant can attach in between), then hands the lease back — which detaches the bridge channel and the navigation/load observers and **returns the browser to the pool**. The browser itself is not destroyed.
- Because the pool's hand-back requires the UI thread while the IDE's disposer can tear an editor down from any thread during project close, the teardown hops to the UI thread when it is not already there. Handing back off the UI thread is the sharp edge the hop avoids: the lease's own cleanup runs and marks itself spent *before* the pool's thread assertion fires, which strands that instance in the checked-out set — stripped of handlers, never re-offered, one slot of the pool's ceiling lost for the rest of the session (spec 302).
- The virtual file is released; the IDE's editor manager forgets it.

### Persistence

Open memory tabs are **not** restored across IDE restarts. The next launch opens with no memory tabs regardless of which were open before. (The IDE's "reopen last editors" mechanism does not roundtrip a memory tab because the virtual file has no real path; the IDE has nothing to re-open against.)

### Concurrent edits

The embedded HTML view inside the tab can edit the underlying memory (topic edits, plan edits, e2e guide changes) — those changes write through to storage, but the editor's `isModified` is always `false` and the tab never shows a dirty dot. The clean state is maintained because, conceptually, the tab is a viewer/editor on top of an external store, not an in-progress buffer.

The write itself is a **cross-process round-trip** to the shared store-a-summary operation; the host does not write the memory itself. The read/write asymmetry is deliberate but worth stating plainly: the body is read natively (folder first, orphan branch as fallback) and written through the shared storage provider, which honors the configured storage mode. So a write can land in more places than the subsequent read consults.

## State Transitions

```
[user clicks a memory row for hash H, on any of the eight surfaces]
  storage lookup async → memory M for H
  (exception: the pull-request draft's per-memory link resolves M synchronously
   from the already-built draft and does not hop to the UI thread at all)

  [M not found]
    show informational dialog; nothing opens, nothing swaps

  [M found] → shared open path (entered on the UI thread by every caller but
              that one; the path itself neither hops nor asserts)
    scan open editors for a memory editor

    [one found]
      [M and read-only flag both identical to what it shows]
        [initial load fired but the page never completed] → force a fresh render (unstick)
        [otherwise]                                       → do nothing
      [different memory and/or different read-only flag]
        swap the virtual file's held memory + read-only flag  (NO rename announced)
        swap the same pair into the editor → embedded view re-renders in place
        [read-only flag flipped] → subscribe/unsubscribe from memory-change events
        ask the IDE to open the already-open file → tab activated only
      (no editor constructed, no lease taken, native surface stays attached)

    [none found]
      construct virtualFile(M, readOnly) — name computed from M, identity equality
      openFile(virtualFile, focus = true)
        provider claims; build embedded HTML view bound to M
          take a browser lease from the project pool
            [idle instance available] → immediate
            [none available]          → synchronous construction on the UI thread
            [refused / construction failed] → plain-text fallback body; no lease held
        new tab opens

[user closes the tab]
  editor.dispose() → embedded HTML view disposed
    detach the tab's own size / visibility observers from the shared component
    hop to the UI thread if the disposer raced us elsewhere
    hand the lease back → bridge channel + navigation/load observers detached
                        → browser returned to the pool (not destroyed)
  the next open starts a brand-new tab again

[IDE restarts]
  no memory tab is restored
```

## Notable Behavior

- **One memory tab per project, and it is a product decision the user feels.** Opening a second memory replaces the first. Side-by-side comparison of two memories is not possible from any surface. The rule exists because opening a new tab forces the embedded view's native surface through a fresh attach, which on macOS reliably produced a half-rendered tab (a white top strip with a small centred dot) for one to three seconds; keeping one attached surface and swapping only its document removes that entirely.
- **Nothing at the IDE level prevents two memory tabs.** The virtual file's equality is reference identity, so the IDE would open a second tab for a second virtual file without complaint — even one carrying the same commit hash. The one-tab rule lives *entirely* in the shared open path's lookup-then-swap logic. Any future surface that builds a virtual file and opens it directly, bypassing that path, produces a second tab that the shared path will never find first and will therefore **permanently ignore on every subsequent swap** — a tab frozen on whichever memory it was born with.
- **Equality became reference identity precisely to make reuse possible.** It used to be commit-hash equality, which gave the IDE hash-based tab dedupe for free. That is now gone, and deliberately: with hash equality, swapping the held memory would make the IDE see the file as having changed identity, close the tab, and reopen it — the exact teardown the reuse avoids.
- **A swap announces no rename, so the tab title can lag the content.** Announcing a rename makes the IDE close and reopen the tab. Instead the name is simply recomputed from whatever memory the file currently holds, and the IDE picks it up only on paths that re-query it. When one of those paths does not run, the user sees the previous memory's title above the current memory's page. Content is always correct; the title is best-effort.
- **The reported path is the display name.** The path is delegated to the name rather than frozen at construction, so a swap cannot leave a path/name pair that disagree — which is what a path-displaying consumer would otherwise show.
- **Writability is unconditional, independent of read-only mode.** The virtual file reports itself unwritable whether the tab is in editable or read-only mode; read-only mode is enforced by hiding page controls and refusing write commands, not by the file's writability. A test pins the unconditional part specifically.
- **Re-clicking a stuck blank tab is a real recovery gesture.** A repeat open of the same memory is normally a no-op, except when the first content load was issued but never completed — then it forces a fresh render. This is the only user-reachable escape from a memory tab that never painted.
- **A latent gap: splitting the editor strands the split copy.** An IDE editor split creates a *second* editor over the *same* virtual file, and the shared open path's lookup takes the **first** match. A swap therefore updates the virtual file (shared) and one editor's body, leaving the other split copy still rendering the previous memory — with a title that, because the virtual file is shared, may now describe the *new* memory. Each split copy also holds its own browser lease. Nothing in the code detects or reconciles this. (Defect; unhandled.)
- **Tab title is part of the contract.** The `✨` sparkle, the 8-character hash, the em-dash, and the 50-character message truncation are all user-visible. Changing any of them is a breaking change to the user-facing surface.
- **The provider claims exactly one type.** No real file, no other virtual file, no extension-based fallback ever opens a memory in this editor. Conversely, this editor never opens anything other than a memory.
- **`HIDE_DEFAULT_EDITOR` is part of the contract.** It guarantees that even if some other provider also accepted the virtual file (it would not, but in principle), this provider's claim suppresses the default editor and prevents an unwanted second tab.
- **The editor is always clean.** Edits made via the embedded HTML view are persisted immediately — through a cross-process store-a-summary round-trip — and the tab never shows a dirty dot, never prompts on close, and never offers "Save". A failed round-trip therefore has no dirty-state fallback: the tab still looks clean.
- **The memory is read natively but written through the shared provider.** The open path reads the memory body in process — the local Memory Bank folder when one is attached and populated, otherwise the orphan branch — while the persist path goes through the shared storage provider and honors the configured storage mode. So a write can land in more places than the read consults.
- **No persistence across IDE restart.** The lack of a backing path makes the IDE's standard "reopen last editor" mechanism a no-op for memory tabs. Closing and re-opening the IDE leaves the editor area empty of memories.
- **The display name `"Commit Memory"` is internal.** It surfaces in accessibility / breadcrumb roles, not in the tab title; the tab title is the virtual-file's `name`.
- **The provider is dumb-aware.** Memory tabs can be opened during project indexing; the editor does not depend on indexes.
- **Opening and closing many memory tabs in a row is safe because of lease-and-return discipline, not per-tab teardown.** The embedded browser is *not* destroyed on tab close — it goes back to a project-scoped pool whose bounded capacity is what stops the population from growing without limit (spec 302). What tab close guarantees is that nothing the tab attached survives on the shared instance: the bridge channel and the navigation/load observers come off through the lease, and the tab's own size and visibility observers — which the lease does not track — come off by the tab itself, before the hand-back. A missed detachment here does not leak with the tab; it accumulates on an instance the *next* tab will receive.
- **The one-tab rule also makes the tab a light pool consumer.** Because browsing through twenty memories reuses one tab, it takes out *one* lease, not twenty — the only lease the memory surface ever needs is the one held for the life of that single tab. (Notable; see spec 302.)
- **Teardown may be raced onto a non-UI thread, so it hops before handing the lease back.** Tab close normally runs on the UI thread, but the IDE's disposer can tear editors down from any thread while a project is closing. The pool's hand-back asserts the UI thread, and failing that assertion is worse than it sounds: the lease has already cleaned up and marked itself spent by then, so the instance is stranded in the checked-out set and one slot of the pool's ceiling is lost for the session. The hop is what makes project close harmless. (Notable; see spec 302.)
- **Eight host paths converge on one open path, and the virtual file is built in exactly one place.** They differ in their no-summary dialog text, in whether they request read-only mode, and — for exactly one of them — in how they get onto the open path at all. One of the eight, the retired all-branches list, is unreachable dead code that was rewired onto the shared opener along with the live surfaces. No surface constructs a virtual file of its own.
- **Nothing enforces the UI thread on the way into the shared open path, and one caller does not observe it.** Seven callers resolve their memory asynchronously and hop onto the UI thread to enter the path; the pull-request draft's per-memory link resolves synchronously from the already-built draft and enters straight off the embedded browser's message-handling thread. The path itself neither hops nor asserts, yet it manipulates editor state the IDE expects to be touched only on the UI thread. The symptom would be intermittent and platform-dependent rather than deterministic, and the off-thread claim itself rests on the surrounding code's comments and its siblings' defensive hops rather than on anything observable from this repository — so the defensible statement is simply that the code does not enforce the discipline the rest of this surface keeps. (Defect; unhandled.)
- **Two surfaces request read-only mode; the rest request editable.** The commits list's foreign-branch open always asks for read-only; the Memory Bank explorer asks for it when the row belongs to a foreign repository. Everything else opens editable. Since it is the same tab either way, a user moving between a foreign memory and one of their own flips that tab's mode back and forth.

## Shared Behavior

- **Embedded HTML summary view** (spec 120) — the editor's body; this topic is the IDE wrapper around it, including the in-place content swap the shared open path drives and the plain-text fallback body a refused browser checkout lands in.
- **Embedded-browser pool** (spec 302) — supplies the browser this editor's body borrows for the life of the tab, defines the lease that is the only sanctioned attachment point for the bridge and the navigation/load observers, and owns the capacity, eviction, and disposal rules that make return-instead-of-destroy safe. Because at most one memory tab exists, this surface borrows at most one instance at a time.
- **Storage** — the source of the memory the virtual file wraps, and the owner of the folder-first / orphan-branch-fallback read precedence the open path inherits.
- **The commits panel, the Memory Bank explorer, the PINNED panel, the action bar, the branch-level pull-request draft, and the retired all-branches memory list** — the surfaces that resolve a memory and hand it to the shared open path.
- **IDE editor manager** — the dispatch layer that looks up provider claims, activates an already-open file, and routes lifecycle calls. It no longer performs any hash-based tab dedupe for memories.
