# 46 — Claude Code Hook Installation

## Topic Statement

The product's Stop and SessionStart hook entries are inserted into the Claude Code per-project local-settings file as matcher-group records, with stale-path replacement and one-time legacy cleanup from a previously used settings file location.

## Scope

**In scope.** The target settings file path, the matcher-group JSON shape Claude Code expects, the dispatch-script-indirection command pattern, the single reconciler that brings both the Stop and the SessionStart entry to canonical form in one transaction (with any additional hook types future revisions add through the shared matcher-group builder used by both this installer and the Gemini installer), the strict per-event health contract and the composite installed-state query built from it, removal that preserves unrelated entries, and the legacy-cleanup pass that strips this product's entries from a predecessor settings file.

**Out of scope.** What the Stop and SessionStart hooks do at runtime (covered by specs 26 and 27). The Gemini installer (covered by spec 47), even though it shares the same matcher-group helper module described under **Shared Behavior**. The orchestration that calls this installer (covered by spec 44).

## Data Contracts

### Target file

The hook entries live in the per-project Claude Code local-settings file at `.claude/settings.local.json` relative to the project (or worktree) root. The "local" suffix is meaningful: this is the per-user, per-project file that is excluded from version control by Claude Code's own conventions, so writing the product's hook entries here does not pollute the team-shared settings.

### Legacy file

A predecessor version of the product wrote hook entries into the team-shared file at `.claude/settings.json`. The current installer never writes there but it does perform a cleanup pass that removes any product-authored entries from this legacy location.

### Matcher-group structure

Claude Code's settings format groups hooks under a top-level `hooks` key, with one sub-key per event (here: `Stop` and `SessionStart`). Each event's value is an array of "matcher groups", and each matcher group is an object whose `hooks` field is an array of individual hook objects. Each hook object has at minimum a `type` field with the value `command` and a `command` field whose string value is the shell command line that Claude Code will execute when the event fires.

Schematically (using JSON syntax solely as a data-contract notation):

```
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "<shell>", "async": true } ] },
      <other matcher groups added by the user or other tools>
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "<shell>" } ] }
    ]
  },
  <other settings>
}
```

The product's matcher group does not specify a `matcher` key (no event-name regex restriction); the hook fires on every Stop / SessionStart event.

### Hook command pattern

Both event commands use dispatch-script indirection so the on-disk command line does not bake in a runtime path that would break across product upgrades.

- Stop hook command: `"$HOME/.jolli/jollimemory/run-hook" stop`
- SessionStart hook command: `"$HOME/.jolli/jollimemory/run-hook" session-start`

`run-hook` is the stable shell entry-point in the user's per-user state directory (a config-driven path, not a source-code path); it consults the dist-paths registry and execs the per-hook script. See the dispatch-scripts spec for resolver semantics.

### Identifier substrings

To detect existing product entries (current OR legacy), the installer matches the `command` string of each hook against an event-specific identifier set.

- Stop event: `run-hook` (matches the current dispatch indirection), OR `StopHook` (matches the predecessor form that hard-coded the script's class name into the path), OR the filename of the IDE plugin's JVM hook-runtime archive (matches an entry written by the IDE surface in an older release, when that surface wrote hook bodies of its own).
- SessionStart event: `run-hook` OR `SessionStartHook`. This set deliberately does **not** include the JVM archive filename, so a SessionStart entry written by the old IDE surface is not recognised as the product's and is neither replaced on install nor removed on uninstall.

A hook is considered "this product's" if its command string contains *any* identifier in the relevant set. This is broader than an exact-command match because the installer wants to recognise stale forms during upgrade — a command line whose path is out of date must still be detectable so it can be removed and replaced. Detection of *health*, by contrast, is an exact match (see **Detection**).

### Async flag

The Stop hook is recorded with `async: true`; this signals to Claude Code that the hook may run independently of the main loop and need not block the user. The SessionStart hook does not specify the async flag; it runs in the foreground because its output is meant to be shown to the user.

### Outputs

The installer returns a result object with the absolute path of the affected settings file (so the caller can mention it in the success report). No warnings are emitted by the Claude installer.

## Behavior

### Reconciling both hook entries — one transaction

Both event entries are produced by a **single reconciler** in one read-modify-write pass. There is no separate per-event installer, no per-event exact-command fast path, and no way for one event to be installed without the other.

1. Run a legacy-cleanup pass on the predecessor settings file.
2. Read and JSON-parse the local settings file. **Absence is the only tolerated failure** — a missing file yields an empty object. Any other read or parse failure (malformed JSON, permission denied, a directory in the file's place) **propagates** and aborts the install, rather than being silently replaced with a fresh empty object that would discard everything else the user has in that file.
3. Locate or create the `hooks` sub-object.
4. **Stop event.** Remove *every* owned matcher group entry (any hook whose command matches any Stop identifier), then append exactly one canonical matcher group: `{ hooks: [ { type: "command", command: <stop command>, async: true } ] }`.
5. **SessionStart event.** The same, using the SessionStart identifier set, appending exactly one canonical group with **no** `async` flag.
6. Serialize the whole settings object as tab-indented JSON and compare it against the file's existing bytes:
   - **Identical** — no write occurs; the reconciler reports success.
   - **Different** — create `.claude/` recursively if needed and write the file atomically (a temporary sibling renamed into place).

Properties of this shape that matter:

- **Both events are always brought to canonical form together**, in one write. A run cannot leave one installed and the other not.
- **Removal is unconditional and global**, so a settings file holding a duplicate owned group, or a canonical group alongside a stale one, is normalized in the same pass — even though the canonical entry was already present. The skip decision comes from the whole-file comparison *after* the rebuild, not from spotting the canonical command beforehand.
- **A write failure propagates for both events.** Neither event is optional and neither is a "strict enhancement": there is no path on which a failure to record the SessionStart entry is downgraded to a logged warning.
- **Non-product matcher groups are preserved verbatim** and keep their relative positions. Where a matcher group held a product hook alongside third-party hooks, only the product hook is removed and the group survives.

### Legacy-cleanup pass

Run before the Stop install, and unconditionally as the first step of removal:

1. Read and JSON-parse the legacy settings file at `.claude/settings.json`. If absent or unparseable, return immediately.
2. Locate the `hooks` sub-object (return if absent).
3. Locate the `Stop` array (default to empty).
4. If the array contains no hook matching the Stop identifier set, return without modification.
5. Filter the array to remove product hooks (using the same matcher-group filter logic as the install step).
6. If the filtered array is empty, delete the `Stop` key entirely; otherwise assign the filtered array back.
7. If the resulting `hooks` sub-object is empty, delete the `hooks` key.
8. Write the legacy file back.

This pass *only* touches the product's own entries. Other tools' Stop hooks in the legacy file are preserved.

### Detection

Detection is **strict and canonical**, and reads the **local settings file only**. There is no fallback to the predecessor team-shared file: entries found only there are cleaned up on install and uninstall, but they never make the product report as installed.

A per-event health check reports one event as healthy only when all of the following hold in the local settings file:

- exactly **one** matcher group in that event's array is owned by the product;
- that group holds exactly **one** hook object;
- that hook's type is `command`;
- its command string equals the current canonical command **exactly** — an identifier-substring match is not sufficient;
- its async flag has exactly the expected shape for that event: present and true for Stop, absent for SessionStart.

The composite query "is the Claude hook installed?" is the **conjunction** of the two per-event checks — **both** Stop and SessionStart must be healthy. A settings file carrying only a healthy Stop entry reports not installed.

Everything the strict check rejects — a stale command, a duplicated owned group, an owned hook sharing a matcher group with a third-party hook, the wrong async shape, a legacy-only entry — is repaired by the next reconciliation, because the reconciler rebuilds both events unconditionally rather than trusting the detection result.

### Per-event health as a consumed contract

The two per-event health results are a contract in their own right, not merely an internal step of the composite check. The embedded assistant plugin's session bootstrap samples both of them **before** it performs any installation work in a session, and uses the sampled pair to decide whether it must compose and emit the session-start briefing itself: it does so only when the canonical pair was *not* already healthy at that moment, leaving the briefing to the settings-installed SessionStart entry otherwise. See the plugin session-bootstrap topic for that rule.

### Removal

1. Run the legacy-cleanup pass.
2. Read the local settings file (return on absence/parse failure).
3. Filter the `Stop` array to remove product hooks.
4. Filter the `SessionStart` array to remove hooks matching the SessionStart identifier set (using the same matcher-group filter logic).
5. Drop empty event arrays from the `hooks` sub-object; drop the `hooks` sub-object if empty.
6. Write the file back atomically.

Other matcher groups (other tools' hooks, the user's own hooks) are preserved verbatim.

## State Transitions

The reconciler's unit of transition is the whole settings file, since both event arrays are rebuilt in one pass. Per event array (`Stop` or `SessionStart`), the resulting shape is:

- **No product hook present** → one canonical matcher group is appended at the end of the array.
- **Exactly one canonical product group already present** → that array is rebuilt to the identical shape. Whether a *write* happens is decided by the whole-file comparison, so if the other event array also needed nothing, the file is untouched.
- **Product hook with a stale command** → replaced by one canonical group at the end; non-product hooks that shared the stale hook's matcher group are preserved.
- **Multiple matcher groups holding product hooks** → consolidated to exactly one canonical group at the end, even if one of them was already canonical.
- **Product hook with the wrong async shape** (for example a Stop entry missing the async flag) → treated as owned, removed, and replaced by the canonical form.

Composite installed-state transitions:

- **Neither event healthy** → **both healthy** (one reconciliation).
- **Exactly one event healthy** → **both healthy**. This is never an intermediate state the reconciler produces itself; it can only arise from external editing or from an older release.
- **Both healthy** → **both healthy**, with no filesystem write.

For the legacy file, removal is monotonic: once cleaned, subsequent runs find nothing to remove and exit early.

## Notable Behavior

- Tab indentation in the JSON output is intentional: it matches Claude Code's own pretty-printing convention so the file remains diff-friendly when both the user and the installer write to it alternately.
- **The write-skip decision comes after the rebuild, not before it.** The installer runs in every worktree on every enable, so avoiding needless writes matters — but it earns that by serializing the rebuilt object and comparing whole-file bytes, not by short-circuiting on the presence of the canonical command. The cost is one extra serialization per call; the benefit is that normalization (deduplication, async-shape repair, consolidation) happens on the same code path as idempotency, so there is no "already correct" state that quietly skips repair.
- The replacement filter does *not* guarantee preservation of the matcher group's own ordering relative to other matcher groups: stale product matcher groups are removed and a new one is appended, so the product entry always ends up *last* in the array. Other tools' matcher groups stay in their original positions. (Claude Code does not promise hook ordering, so this is acceptable.)
- **A malformed settings file fails the install loudly.** Only file absence is tolerated on read. This is deliberate: the alternative — treating an unparseable file as empty — would rewrite it from scratch and silently destroy every unrelated setting the user had in it.
- The legacy-cleanup pass runs even on uninstall. This means a user who uninstalls before ever running a current-version install will still have any predecessor entries in the team-shared settings file removed (a hygiene win, since the user almost certainly does not want those orphaned commands lingering).
- **Every surface writes these same two entries.** The standalone CLI, the editor extension, the IDE plugin, and the embedded assistant plugin all reach this one reconciler; none of them writes hook entries of its own shape. The IDE plugin no longer installs a JVM-invoking Stop command — it delegates to the shared install path — which is why the Stop identifier set still recognises the JVM archive filename (to clean up entries left by older releases) while nothing writes that form any more. The embedded assistant plugin reaches this reconciler through its narrowed repo-hook install mode, which is why its own manifest carries no session-lifecycle business hooks of its own: the canonical pair lives in the project's local settings file like every other surface's.

## Shared Behavior

- The matcher-group helper module (carrying the "does any matcher group hold a hook matching this identifier?" and "return matcher groups with hooks matching this identifier removed, dropping any group whose hook list becomes empty" operations, plus the dispatch-indirection command builder and the per-event identifier sets) is a single shared module used by both this Claude installer and the Gemini installer (spec 47). The two installers are written against the same iteration semantics and identifier-substring conventions so a future hook event added in one place is wired through the same helper for the other surface. The helper's "does any matcher group hold a hook with this exact command?" predicate is a leftover of the retired per-event fast path and is no longer consulted by either installer.
- The command builder takes no source identity and emits no environment prefix, so the command strings written here are byte-identical across every install surface — the same property the git shell hooks have (spec 45).
- The dispatch-script indirection (`"$HOME/.jolli/jollimemory/run-hook" <hook-type>`) is shared with the Gemini and git-shell installers.
- The "tab-indented JSON, atomic write" output convention is shared with the Gemini installer.
- The "drop empty containers" cleanup pattern (drop the event array when empty, drop the `hooks` sub-object when empty) is shared with the Gemini installer.
