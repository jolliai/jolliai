# 212. IntelliJ Session Resume via Terminal

## Topic Statement

A single affordance on a committed memory's conversation rows that opens a new IDE terminal tab rooted at the project's working directory and immediately runs the source-appropriate command to resume that conversation's session, gated at row-construction time by a shared "can this source be resumed" predicate plus a live check that the transcript still exists on disk.

## Scope

**In scope:**

- The shared terminal helper: its inputs, the two command forms it can build, the tab-title defaults, its unsupported-source guard, and its single catch-all error path.
- The shared eligibility predicate and the set of sources that pass it.
- The one surviving call site: where it sits, how it resolves the session identifier, how it gates, and what it forwards.
- The hover model that reveals the affordance, including the fact that it displaces a value shown at rest rather than appearing beside it.
- The working-directory resolution and the silent abandonment when it fails.
- The fact that the feature carries no automated tests.

**Out of scope (boundaries):**

- Everything else on a committed memory's row — the memory row anatomy, the conversation group's structure, the other affordance in the same cluster, and the surface a row click opens.
- The stored conversation record's own shape and how a commit came to carry it.
- How a resumable session identifier is recovered by each producer's discovery, and why one producer deliberately does not use its transcript filename as that identifier.
- What happens inside the terminal after the command is sent. The feature's responsibility ends at the send.
- The live conversations list and the pinned list. **Neither offers this affordance any more** — see specs 192 and 220.

## Data Contracts

### Helper inputs

| Input | Meaning |
| --- | --- |
| Project handle | Locates the terminal tool window's manager and scopes the failure notification. |
| Source | The producer name, matched case-insensitively. Selects the command form and the default tab title. |
| Session identifier | An opaque string, interpolated verbatim into the command. |
| Working directory | An absolute path; the new terminal tab starts here. |
| Tab title | Optional. When omitted, a source-keyed default applies. |

### Eligibility predicate

One predicate decides whether a source can be resumed: the lower-cased source must be one of two values — the two first-party agent CLIs that expose a resume subcommand. Every other producer fails it.

### Command forms

Two forms, chosen from the lower-cased source: one passes the identifier as an argument to a `resume` subcommand, the other as the value of a `--resume` option. The default tab title is likewise one of two source-keyed strings, each of the form "<product> – resume".

**The session identifier is interpolated with no quoting and no escaping in either form.** An identifier containing whitespace or shell metacharacters produces a command the shell will misread. Nothing sanitizes it.

### Unsupported-source guard

A source matching neither form builds no command at all: the helper logs a warning, posts a warning-severity notification reading "Resuming isn't supported for this conversation type." to the IDE's notification bus, and returns without touching the terminal.

**This branch is unreachable from the shipped call site**, which gates on the eligibility predicate before calling. It exists to fail safely for a future caller that bypasses the predicate.

### Eligibility at the call site

The affordance is added to the row's action cluster only when **both** hold:

1. The shared predicate passes for the conversation's recorded source.
2. The conversation's recorded transcript path is present, non-blank, and names a file that exists on disk **at the moment the row is built**.

There is no disabled state — the button is either in the cluster or absent from it. A conversation with no recorded session identifier still passes both gates if its transcript exists, and would send an empty identifier.

## Behavior

### Row construction

Each conversation row under a committed memory is built with a lead badge for its producer, a wrapping title, and a right-hand cluster. The cluster holds a message-count label that is visible at rest, plus one or two action icons that are hidden at rest: an open action always, and the resume action only when the eligibility test above passed.

The cluster's width is measured **twice** — once with the actions visible and the count hidden, once the other way — and the wider of the two is reserved, so the title's wrap width and the row's height stay stable when hover swaps them.

### Hover

Entering the row tints its background, hides the count and reveals the actions. Leaving checks the cursor's screen-space position against the row's screen-space bounds and reverts only when it is genuinely outside, so moving onto an action icon does not flicker the cluster away.

### The resume click

1. Resolve the working directory: the shared repository root first, the project's base path as fallback. If neither resolves, abandon silently — no notification, no log line for the user.
2. Record a resume event tagged with the row's actual lower-cased source, so a resume of one product is distinguishable from the other.
3. Call the helper with the project, the source, the recorded session identifier, and the working directory — **and no tab title**, so the source-keyed default applies.

### Inside the helper

1. Resolve the command form and the default title from the lower-cased source, or take the unsupported-source guard and return.
2. Obtain the terminal tool window's manager for the project.
3. Ask it to create a new shell terminal widget starting in the supplied directory, named with the supplied or default title. **This creation call is made reflectively** rather than directly.
4. Send the resolved command string to that widget's shell input.
5. Return. Nothing waits for the command, checks its result, or observes the tab's lifecycle.

### Error handling

Steps 1–3 sit inside one catch-all. Any throw writes the message to the diagnostic log at warning level and posts a warning-severity notification titled "Resume Session" reading "Could not resume session — terminal unavailable.", scoped to the project. Nothing is refreshed and no dialog is shown.

Neither that notification nor the unsupported-source one carries an action button, so the user is told what failed with no in-notification path to recover.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Row built, source passes predicate, transcript file present | — | Action in the cluster, hidden |
| Row built, either gate fails | — | Action absent from the cluster |
| Action hidden | Cursor enters the row | Action visible, count hidden |
| Action visible | Cursor leaves the row's screen-space bounds | Action hidden, count visible |
| Action visible | Clicked, working directory resolves | Resume event recorded; new terminal tab created; command sent |
| Action visible | Clicked, no working directory | Nothing happens, silently |
| Helper invoked with a source outside the two forms | — | Warning notification; terminal untouched *(unreachable from the shipped call site)* |
| Helper invoked, any step throws | — | Warning log plus "terminal unavailable" notification |

## Notable Behavior

- **There is exactly one call site.** The affordance was removed from the live conversations list and from the pinned list; only a committed memory's conversation rows still offer it. The helper and its predicate remain shared code with one consumer. (Notable — earlier shapes of this feature offered it in three places, each with its own eligibility check.)
- **The feature is source-generic, not tied to one product.** The predicate, the command builder and the default tab title all key off the row's source and currently recognise two producers. Adding a third would need one entry in the predicate and one command branch, not a new eligibility check. (Notable.)
- **No automated tests cover the helper or the call site.** (Notable.)
- **The identifier is never quoted or escaped.** Both command forms are built by direct interpolation, so whitespace or shell metacharacters in an identifier produce a malformed command. (Surprising; reality.)
- **The unsupported-source branch is unreachable today.** The only caller gates on the predicate first, so the branch's warning notification exists purely as a safety net for a future direct caller. (Unreachable.)
- **The transcript-existence gate is a snapshot taken at row-construction time.** A file deleted afterwards leaves the button visible and clickable; a file that appears afterwards does not make the button appear, because the row is not re-evaluated. (Notable.)
- **A conversation with no recorded session identifier still shows the button.** The gates test the source and the transcript file, not the identifier, so an empty identifier is interpolated into the command and sent. (Surprising; reality.)
- **This call site is the only one that takes the source-keyed default tab title**, because it forwards no title of its own. That default is the sole consumer of the helper's title-defaulting logic. (Notable.)
- **The shell widget is created reflectively, as a plugin-verifier workaround.** The only terminal-creation entry point available on the compile baseline is marked internal in newer builds inside the plugin's supported range, so a direct call is flagged by the marketplace verifier. Invoking it reflectively keeps it out of the scanned bytecode while remaining functional, and a signature change or removal throws into the same catch-all and degrades to the "terminal unavailable" notification. (Notable.)
- **The tab is always new.** No attempt is made to reuse a terminal tab from a prior resume of the same session; every click creates another one. (Notable.)
- **A missing working directory abandons the action with no feedback at all** — no notification, no visible change. (Notable.)
- **The resume event is tagged with the row's real source.** It was previously a hard-coded value, which made the two producers indistinguishable in the recorded data. (Notable.)

## Shared Behavior

- **Committed memories surface** — owns the memory rows, the conversation group beneath them, the row anatomy this affordance sits in, and the sibling open action.
- **Project status service** — owns the shared repository-root resolution the working directory is derived from.
- **IDE terminal tool window** — the platform service that creates and owns the widget; this feature reaches its creation entry point reflectively.
- **IDE notification bus** — carries both the unsupported-source and the terminal-unavailable notifications.
- **Per-producer session discovery** — owns how each producer's resumable session identifier is recovered and recorded on a commit's stored conversation record. This feature consumes that identifier as an opaque string.
- **Active conversations panel (spec 192)** and **pinned panel (spec 220)** — both previously carried this affordance and no longer do.
