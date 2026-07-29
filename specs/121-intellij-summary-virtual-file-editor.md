# IntelliJ Summary Virtual-File Editor

## Topic Statement

A trio of IDE editor wrappers that expose a stored commit memory as if it were a file in the IDE — a virtual file whose name is `<sparkle> <short-hash> — <commit-message>`, an editor provider that claims only that virtual-file class, and a read-only file editor whose body is the embedded HTML summary view — so a single-click on a memory row in the tool window opens it as an editor tab using the IDE's standard "open file" path.

## Scope

**In scope:**
- The user-visible trigger that opens a memory in the editor area (a single click on a memory row in the tool window).
- The virtual-file's user-visible properties: tab title, tab icon, read-only status.
- The provider's claim rule: it accepts only the dedicated virtual-file class and rejects all real files and other virtual files.
- The editor type identifier (`jollimemory-summary`) — exposed as part of the IDE's editor-provider contract.
- The editor's "default editor hidden" policy — when this provider claims a file, no other editor opens for the same file.
- Tab title format and the always-clean (never dirty) state.
- Tab reuse: clicking the same memory twice surfaces the existing tab instead of opening a duplicate.
- Lifecycle: ephemeral (no persistence across IDE restart), disposed when the tab is closed.
- The tab's borrow-and-return relationship with the embedded-browser pool: taking a lease when the body is constructed, what a refused lease degrades to, and exactly what the tab must detach before handing the lease back.
- Boundary with the embedded HTML summary view (the editor's body delegates to it).

**Out of scope:**
- The contents of the embedded HTML summary view — owned by its own spec.
- The embedded-browser pool's own rules — capacity, standby target, eviction, prewarm, and disposal — owned by spec 302. This spec covers only the lease this tab holds.
- The mechanism by which the memory is read from storage — owned by the storage spec.
- The action toolbar that the editor exposes — currently none beyond the IDE-standard tab actions.
- Persistence of an open memory tab across IDE restarts — explicitly not supported.
- The way memories appear in tool-window rows — owned by the per-section panel specs.

## Data Contracts

### Trigger

A single left-click on any memory row in the MEMORIES section of the tool window opens the memory in the editor area. The same is true for the eye-icon click in the COMMITS section and the double-click on a commits row when a summary exists.

In every case, the row's host:

1. Resolves the commit hash to a stored memory (asynchronously).
2. Wraps the memory in a virtual file.
3. Hands it to the IDE's standard "open file" mechanism with focus.

If the commit hash has no stored memory, the host shows an informational dialog ("No summary found for `<short-hash>`") and does not open a tab.

### Virtual-file shape

The virtual file is a lightweight, in-memory file (no backing path, no real bytes) that carries the memory object as a field. Its user-visible properties:

| Property        | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| `name`          | `"✨ <first-8-chars-of-hash> — <first-50-chars-of-commit-message>"` (sparkle + hash + em-dash + truncated message) |
| `extension`     | empty string (no extension)                                                            |
| `isWritable`    | `false`                                                                                |
| `equality key`  | the full commit hash                                                                   |

The equality contract — two virtual files are "equal" iff their commit hashes match — is what makes tab reuse work. The IDE's editor manager uses equality to decide whether to surface an existing tab or open a new one.

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

When the tab is closed, the editor's `dispose()` calls through to dispose the embedded HTML summary view. That teardown does **not** destroy the embedded browser — it **returns** it to the project-scoped browser pool for the next memory tab to reuse (spec 302). What it does release is everything the tab attached to that shared instance: the message-bridge query channel, the navigation-interception and load-completion observers (all three through the lease), and the tab's own size and visibility observers (which the lease does not track and the tab must therefore detach itself). All of it must come off precisely because the shared instance **outlives the tab** — a missed detachment accumulates one stale observer set per open/close cycle instead of being collected with the tab.

## Behavior

### Opening a memory

1. User clicks a memory row.
2. The row's host fetches the memory asynchronously. That fetch is a **native in-process read of the orphan branch** (list-and-show against the memory ref), not a call through the storage abstraction; only its alias fallback — resolving a hash that is an alias of another commit's memory — is a cross-process round-trip. So the memory body always comes from the orphan branch regardless of which storage mode is configured.
3. On the UI thread, the host wraps the memory in a virtual file and calls the IDE's `openFile(virtualFile, focus = true)`.
4. The IDE's editor manager looks up an existing tab with an equal virtual file:
   - If found, the existing tab is brought to front.
   - If not, the registered provider is consulted; it accepts the file; the IDE constructs a new editor; the editor's body is the embedded HTML summary view bound to the memory.
5. Constructing that body **takes out a lease on an embedded browser from the project-scoped pool** (spec 302) rather than building one of its own: immediate when an idle instance is on standby, otherwise a synchronous construction on the UI thread. The lease is also the only sanctioned attachment point for the tab's message bridge and its navigation/load observers.
   - If the pool **refuses** the checkout — it has been disposed, or the call is off the UI thread, or construction genuinely fails — the refusal is caught along with any other construction failure and the editor's body becomes the pre-existing read-only plain-text rendering of the memory instead (spec 120). No lease is retained, so the tab's later teardown hands nothing back.
6. The tab title is the virtual-file's `name`. The tab is marked read-only (no dirty dot).

### Tab reuse

Two virtual files referring to the same commit hash are equal. Clicking a second memory row that resolves to the same hash surfaces the original tab — no duplicate is opened, no second editor is constructed.

### No-summary path

If the commit hash resolves to no memory:

- For MEMORIES rows the host shows a warning ("No summary found for this commit.") via the IDE's standard message dialog.
- For COMMITS rows the same dialog is shown with the short hash interpolated.

No tab is opened in either case.

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

The write itself is a **cross-process round-trip** to the shared store-a-summary operation; the host does not write the memory itself. The read/write asymmetry is deliberate but worth stating plainly: the body is read natively from the orphan branch and written through the shared storage provider, which honors the configured storage mode. So a write can land in more places than the subsequent read consults.

## State Transitions

```
[user clicks a memory row for hash H]
  storage lookup async → memory M for H

  [M found]
    construct virtualFile(M) — name = "✨ <H8> — <msg50>", read-only
    openFile(virtualFile, focus = true)
      [tab with same H already exists]
        bring to front
      [no such tab]
        provider claims; build embedded HTML view bound to M
          take a browser lease from the project pool
            [idle instance available] → immediate
            [none available]          → synchronous construction on the UI thread
            [refused / construction failed] → plain-text fallback body; no lease held
        new tab opens

  [M not found]
    show warning dialog; no tab opens

[user closes the tab]
  editor.dispose() → embedded HTML view disposed
    detach the tab's own size / visibility observers from the shared component
    hop to the UI thread if the disposer raced us elsewhere
    hand the lease back → bridge channel + navigation/load observers detached
                        → browser returned to the pool (not destroyed)

[IDE restarts]
  no memory tab is restored
```

## Notable Behavior

- **Tab title is part of the contract.** The `✨` sparkle, the 8-character hash, the em-dash, and the 50-character message truncation are all user-visible. Changing any of them is a breaking change to the user-facing surface.
- **The provider claims exactly one type.** No real file, no other virtual file, no extension-based fallback ever opens a memory in this editor. Conversely, this editor never opens anything other than a memory.
- **`HIDE_DEFAULT_EDITOR` is part of the contract.** It guarantees that even if some other provider also accepted the virtual file (it would not, but in principle), this provider's claim suppresses the default editor and prevents an unwanted second tab.
- **Equality drives tab reuse, not the title.** Two virtual files with the same commit hash but different cached commit messages still collapse to one tab; the IDE's lookup uses equality.
- **The editor is always clean.** Edits made via the embedded HTML view are persisted immediately — through a cross-process store-a-summary round-trip — and the tab never shows a dirty dot, never prompts on close, and never offers "Save". A failed round-trip therefore has no dirty-state fallback: the tab still looks clean.
- **The memory is read natively but written through the shared provider.** The open path reads the memory body directly off the orphan branch in process; the persist path goes through the shared storage provider and honors the configured storage mode. A memory written in a folder-only configuration would not be visible to this editor's read path.
- **No persistence across IDE restart.** The lack of a backing path makes the IDE's standard "reopen last editor" mechanism a no-op for memory tabs. Closing and re-opening the IDE leaves the editor area empty of memories.
- **The display name `"Commit Memory"` is internal.** It surfaces in accessibility / breadcrumb roles, not in the tab title; the tab title is the virtual-file's `name`.
- **The provider is dumb-aware.** Memory tabs can be opened during project indexing; the editor does not depend on indexes.
- **Opening and closing many memory tabs in a row is safe because of lease-and-return discipline, not per-tab teardown.** The embedded browser is *not* destroyed on tab close — it goes back to a project-scoped pool whose bounded capacity is what stops the population from growing without limit (spec 302). What tab close guarantees is that nothing the tab attached survives on the shared instance: the bridge channel and the navigation/load observers come off through the lease, and the tab's own size and visibility observers — which the lease does not track — come off by the tab itself, before the hand-back. A missed detachment here does not leak with the tab; it accumulates on an instance the *next* tab will receive.
- **Teardown may be raced onto a non-UI thread, so it hops before handing the lease back.** Tab close normally runs on the UI thread, but the IDE's disposer can tear editors down from any thread while a project is closing. The pool's hand-back asserts the UI thread, and failing that assertion is worse than it sounds: the lease has already cleaned up and marked itself spent by then, so the instance is stranded in the checked-out set and one slot of the pool's ceiling is lost for the session. The hop is what makes project close harmless. (Notable; see spec 302.)
- **Three host paths converge on the same virtual file.** The MEMORIES single-click, the COMMITS eye-icon click, and the COMMITS double-click all build the same kind of virtual file via the same constructor. They differ only in their no-summary fallback dialog text.

## Shared Behavior

- **Embedded HTML summary view** (spec 120) — the editor's body; this topic is the IDE wrapper around it, including the plain-text fallback body a refused browser checkout lands in.
- **Embedded-browser pool** (spec 302) — supplies the browser this editor's body borrows for the life of the tab, defines the lease that is the only sanctioned attachment point for the bridge and the navigation/load observers, and owns the capacity, eviction, and disposal rules that make return-instead-of-destroy safe.
- **Storage** — the source of the memory the virtual file wraps.
- **MEMORIES panel and COMMITS panel** — the two surfaces that build virtual files and call the IDE's open-file mechanism.
- **IDE editor manager** — the dispatch layer that looks up provider claims, performs equality-based tab reuse, and routes lifecycle calls.
