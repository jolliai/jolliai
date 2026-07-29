# VS Code Cross-Project Plan Attribution

## Topic Statement

The watcher-driven gate that decides whether a newly-appearing plan markdown file in the global Claude Code plans directory belongs to the current workspace, by checking that the plan file's absolute path appears as a JSON-escaped substring in at least one of the workspace's recent agent transcripts before the plan is registered into this workspace's plan registry.

## Scope

**In scope:**
- The trigger: the OS-level file-create event for any `*.md` file appearing in the global Claude Code plans directory (`~/.claude/plans/`), delivered to every editor window with a workspace open.
- The attribution check: search the current workspace's recent agent transcripts for the plan path, in the JSON-escaped form Claude Code records under `"file_path"` in tool-use entries.
- The two-way outcome: register-into-this-workspace or silently ignore (sibling-window's plan).
- Why it matters: the plans directory is global across all editor windows; without the check, every plan would appear in every workspace.
- Post-registration change tracking: once a plan is registered, subsequent change events on the same file only refresh the per-workspace registry view; the registration step is a no-op for already-registered plans.
- Serialization: file-create bursts must not interleave registry reads/writes, so the registration calls are queued behind one another per editor window.
- The auxiliary path: a plan can also be registered from outside the watcher (e.g. by the agent's stop-hook scanning transcripts at turn end) — the watcher path is only one of two routes and must agree with that path's attribution semantics.

**Out of scope:**
- The plan markdown's own format / content. This spec is purely about which workspace claims a plan, not what is inside it.
- The agent stop-hook's incremental transcript scan that writes the registry from the CLI side. This spec only covers the watcher-driven registration that runs in the editor.
- Archive guards (the snapshot-on-commit hash that hides committed plans whose source file is unchanged). Covered in the plan-and-note archive guards spec.
- The sidebar's render rules that decide which registered plans actually display (archive guards, missing source files). Covered in the plan-and-note archive guards spec.
- Note attribution. Notes are not discovered from the global plans directory.
- The note editor flow that creates new note files inside the workspace.

## Data Contracts

### Trigger

A file-system watcher subscribed to `~/.claude/plans/*.md` fires its create callback for each `*.md` file that appears under that directory after the watcher was started. The OS delivers this event to every subscriber — meaning every editor window with the watcher attached — exactly once per file.

The watcher does NOT receive create events for files that were already in the directory when it started. Historical plans are therefore invisible to this code path; they only enter a registry through the agent stop-hook's transcript scan.

### Attribution check input

| Input | Source |
| --- | --- |
| Plan absolute path | The created file's full path (under the global plans directory). |
| Current workspace's recent transcripts | The list of agent sessions known to belong to this workspace, looked up from this workspace's per-repo session registry. |

### Attribution rule

The plan is attributed to this workspace if and only if the plan's absolute path appears as a JSON-escaped substring in at least one of the workspace's recent transcript files.

JSON escaping rules used for the substring search:

- POSIX paths (forward-slash `/`) are searched verbatim — JSON does not require slashes to be escaped.
- Windows paths (backslash `\`) are searched with each backslash doubled (`\` → `\\`). This matches how the agent records `"file_path":"<absPath>"` entries in its JSON-Lines transcripts.

The substring search is plain text — no parsing of the JSON-Lines lines, no key-aware lookup. A substring match anywhere in the file (even inside an unrelated value) counts. This is intentional: the agent's transcript writer is the single source of truth that emits these absolute paths; false positives would require user-typed prose that happens to contain the absolute plan path verbatim.

### Two-way outcome

| Outcome | Side effect |
| --- | --- |
| Match found in any transcript | Register the plan into this workspace's plan registry as a fresh uncommitted entry (if not already present). |
| No match in any transcript | No-op. The plan belongs to a sibling editor window's workspace. |
| Workspace has no recent transcripts at all | Treat as no match → ignore. |
| Any individual transcript is unreadable (rotated, permission denied) | Skip that transcript and continue. The check still succeeds if any other transcript matches. |

### Registration outcome (when match is found)

The registration step writes a registry entry keyed by the plan's slug (its filename without `.md`). The entry shape (relevant fields):

| Field | Value at registration time |
| --- | --- |
| slug | filename without `.md` |
| title | extracted from the plan markdown's first `#` heading, falling back to the filename |
| sourcePath | absolute path to the plan file in the global plans directory |
| addedAt | now (ISO 8601), or preserved from any previous entry |
| updatedAt | now |
| commitHash | null (uncommitted) |

If the slug is already in the workspace's registry, registration is a strict no-op — even if the previous entry was marked ignored. This preserves the user's explicit "I don't want to see this plan" state across re-creates of the same filename.

### Change tracking after registration

The watcher also subscribes to file-change and file-delete events for `*.md` in the global plans directory. Those events trigger a debounced refresh of the panel from the registry; they do not register-or-attribute. Neither this path nor any other writer on this surface keeps a per-plan edit tally — the watcher is purely a "did the registry need re-read" trigger for the panel, and any edit-count value found on a row is purged when the registry is read.

## Behavior

### Plan file appears in the global plans directory

1. The OS emits a create event to every editor window watching the directory.
2. Each window enqueues a registration task behind any in-flight registration (so back-to-back creates from a single agent turn cannot interleave registry reads and writes).
3. When the task runs, it loads the workspace's known agent sessions.
4. If there are no sessions, the task ends — no registration.
5. Otherwise it builds the JSON-escaped form of the plan's absolute path.
6. It reads each transcript file in turn. The first file containing the substring causes the loop to short-circuit with "matched"; unreadable files are skipped silently.
7. If no file matched, the task ends — no registration.
8. If matched, the task delegates to the registry-add path: load the registry, look up the slug, and either return immediately (slug already present, including ignored) or write a fresh uncommitted entry for the slug.

### Plan file changes (not creates) in the global plans directory

1. The OS emits a change event.
2. The watcher debounces this with the same panel-refresh debounce that batches all `~/.claude/plans/`, `<workspace>/.jolli/jollimemory/plans.json`, and `<workspace>/.jolli/jollimemory/notes/*.md` events.
3. After the debounce, the panel re-reads from the registry. No attribution check runs on change events; only creates are gated.

### Plan file is deleted from the global plans directory

1. The OS emits a delete event.
2. Same debounced refresh as for change events. The panel re-reads from the registry; whether the entry stays visible depends on the registry's archive-guard logic, not on the deletion event itself.

## State Transitions

| Registry state for slug | Trigger | New state |
| --- | --- | --- |
| Not present | Create event + matched transcript | Fresh uncommitted entry (commitHash=null) |
| Not present | Create event + no transcript match | Not present (no-op) |
| Present (any state, including ignored) | Create event + matched transcript | Unchanged — registration is a strict no-op |
| Present (any state) | Create event + no transcript match | Unchanged — no-op |
| Present (any state) | Change/delete event | Unchanged by attribution; panel re-reads registry |

## Notable Behavior

- **The plans directory is global across all editor windows.** A single physical directory under the user's home is watched by every editor window with the extension enabled. Without the attribution check, every plan an agent writes anywhere on the user's machine would land in every open workspace's panel. (Surprising; reality.)
- **Substring match, not JSON parsing.** The check reads the transcript file as raw text and uses `String.includes`. The agent transcripts are JSON-Lines, but we never parse them — parsing would be slower and more brittle, and the absolute path is unique enough as a needle that a substring hit is good evidence. (Notable.)
- **Backslash doubling is the only Windows accommodation.** No drive-letter casing normalization, no UNC handling. The transcript and the watcher both report the same absolute path string the agent's tool-use entry records, so byte-for-byte equality (after backslash doubling) is enough. (Notable.)
- **Already-present slugs are never re-registered.** Even if the user has explicitly hidden a plan via the panel and the agent re-emits the same filename, the watcher path will not unhide it. The user's intent persists across file re-creates. The only way to bring back an ignored plan is the explicit Add Plan flow inside the panel, which deliberately clears the ignored flag. (Surprising; intentional.)
- **Two registration routes, one attribution rule.** The agent stop-hook also discovers plans, but it does so by scanning the workspace's transcripts directly — it never sees plans that were not produced by sessions in this workspace. The watcher path emulates that affinity by checking transcripts after the OS event. (Notable.)
- **Registrations are serialized per editor window.** A single agent turn can produce multiple plan files in close succession; these arrive as multiple create events. To keep registry writes correct, the registration calls are chained on a per-window queue, so each one sees the previous one's changes. (Notable.)
- **Empty session list silently ignores all events.** A new editor window opened on a repo where no agent has ever run sees zero recent sessions and therefore attributes nothing — including its own future agent runs, until the agent stop-hook writes the first session record. The watcher path catches up after that. (Notable.)
- **The substring is the absolute path; relative paths in transcripts do not match.** Because the agent records the absolute `file_path` value in tool-use entries, the watcher's needle is the absolute path of the plan file. A transcript that only mentions the plan by relative path (e.g. as part of a user's prompt text) does not count as attribution. (Notable.)
- **Unreadable transcripts are not errors.** A rotated, deleted, or permission-restricted transcript is skipped during the loop. The check still succeeds if any other transcript matches. (Notable.)
- **No per-workspace user override exists.** There is no setting to "always claim every plan that appears" or "never claim any plan from the watcher". The attribution rule is the only rule, and it is always on. (Notable.)

## Shared Behavior

- **Per-repo plan registry.** The watcher writes into the same registry the agent stop-hook writes into and the panel reads from; the file format is shared across CLI, IntelliJ, and VS Code surfaces.
- **Per-repo session registry.** The list of "recent transcripts for this workspace" is the same list the rest of the product consumes for development-context recall and session-status reporting.
- **Title extraction.** The first-`#`-heading-or-filename rule used here is the same rule the note service uses for note titles and the panel uses everywhere a markdown file's display title is needed.
- **Slug = filename minus extension.** The slug used as the registry key is the same slug used for orphan-branch storage paths and the agent's per-plan file naming.
