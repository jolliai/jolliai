# 47 — Gemini CLI Hook Installation

## Topic Statement

The product's AfterAgent hook entry is inserted into the Gemini CLI per-project settings file as a matcher-group record using the same shape and helpers as the Claude Code installer.

## Scope

**In scope.** The target settings file path, the matcher-group JSON shape, the dispatch-script-indirection command pattern, the unconditional rebuild plus serialized-content comparison that provides idempotency and normalization on one path, the strict canonical detection rule, removal that preserves unrelated entries, and the conditional-install rule (skip the install entirely when Gemini is not detected or the integration is explicitly disabled).

**Out of scope.** What the AfterAgent hook does at runtime (covered by spec 28). Gemini-CLI session discovery and transcript reading (covered by spec 17). The Claude installer (covered by spec 46), even though it shares the underlying matcher-group helpers.

## Data Contracts

### Target file

The hook entry lives in the per-project Gemini settings file at `.gemini/settings.json` relative to the project (or worktree) root. Unlike the Claude installer, there is only one settings file location: Gemini does not have a "local" / "team" split, so no legacy-cleanup pass is needed.

### Matcher-group structure

Gemini CLI uses the same matcher-group shape as Claude Code, with one event sub-key per supported event type. The product registers under the `AfterAgent` event:

```
{
  "hooks": {
    "AfterAgent": [
      { "hooks": [ { "type": "command", "command": "<shell>", "name": "jolli-session-tracker" } ] },
      <other matcher groups added by the user or other tools>
    ]
  },
  <other settings>
}
```

The product matcher group does not specify a `matcher` key (the hook fires on every AfterAgent event).

The hook object includes a non-empty `name` field (`jolli-session-tracker`). Gemini CLI uses this as a human-readable label in diagnostic output; the field is ignored for matching/dispatch.

### Hook command pattern

The command line uses dispatch-script indirection identical to the Claude installer:

`"$HOME/.jolli/jollimemory/run-hook" gemini-after-agent`

`run-hook` is the stable shell entry-point in the user's per-user state directory. See the dispatch-scripts spec.

### Identifier substrings

To detect existing product entries (current OR legacy stale forms), the installer matches the `command` string of each hook against the AfterAgent identifier set:

- `run-hook` (current dispatch indirection)
- `GeminiAfterAgentHook` (predecessor form that hard-coded the script's class name)
- The filename of the IDE plugin's JVM hook-runtime archive (an entry written by the IDE surface in an older release, when that surface wrote hook bodies of its own)

A hook is considered "this product's" if its command string contains any identifier in the set. The set is a single shared set, not a per-surface one: this installer removes and replaces an entry left behind by the old IDE-plugin form just as it does its own predecessor form.

### Outputs

The installer returns a result object with the absolute path of the affected settings file. It does not emit warnings.

## Behavior

### Install — sequence

1. Read and JSON-parse the settings file. **Absence is the only tolerated failure** — a missing file yields an empty object. Any other read or parse failure (malformed JSON, permission denied, a directory in the file's place) **propagates and aborts the install** rather than being replaced with a fresh empty object that would silently discard every other Gemini setting the user has.
2. Locate or create the `hooks` sub-object.
3. Locate or create the `AfterAgent` array under `hooks`.
4. **Remove, unconditionally.** There is no exact-command fast path. Every call filters the array, removing every matcher group hook whose command matches any identifier in the AfterAgent identifier set — including a hook whose command is already exactly canonical. If a matcher group originally had additional non-product hooks alongside a product hook, the product hook is removed but the non-product hooks survive in the matcher group.
5. **Append exactly one canonical group.** Push a new matcher group of the form `{ hooks: [ { type: "command", command: <after-agent command>, name: "jolli-session-tracker" } ] }`. Duplicate owned groups and old JVM-archive-form groups are therefore collapsed to one.
6. Compare the serialized rebuilt settings object against the file's existing bytes. **Identical → no write occurs.** Otherwise, recursively create the `.gemini/` directory and write the whole object back as tab-indented JSON, atomically (a temporary sibling renamed into place).

The consequence of moving the skip decision after the rebuild is that a settings file which already holds the canonical hook **plus** a duplicate owned group is now rewritten, where previously it was a no-op.

### Conditional install

The orchestrator (spec 44) only invokes this installer when:

- A Gemini CLI installation is detected on the system (presence of the agent's per-user state directory), AND
- The Gemini integration toggle in the persistent configuration is *not* explicitly disabled.

If either condition fails, this installer is not called. There is no internal detection short-circuit: when called, the installer always rebuilds the entry, and the only thing that can spare it a write is the serialized-content comparison at the end.

### Detection

A query "is the Gemini hook installed?" is **strict and canonical**, not an identifier match. It reads the settings file and returns true only when all of the following hold:

- exactly **one** matcher group in the `AfterAgent` array is owned by the product;
- that group holds exactly **one** hook object;
- that hook's type is `command`;
- its command string equals the current canonical command **exactly**;
- its `name` field is the expected label.

On absence or parse failure, it returns false.

Three shapes that previously reported installed now report **not** installed: a hook carrying a legacy command form, a duplicated owned group, and a canonical hook sharing its matcher group with a third-party hook. All three are repaired by the next install, since the install path rebuilds unconditionally.

### Removal

1. Read the settings file (return on absence/parse failure).
2. Locate the `hooks` sub-object (return if absent).
3. Locate the `AfterAgent` array (return if absent or contains no product hook).
4. Filter the array to remove product hooks (using the matcher-group filter logic).
5. If the resulting `AfterAgent` array is empty, delete the `AfterAgent` key.
6. If the resulting `hooks` sub-object is empty, delete the `hooks` key.
7. Write the file back atomically.

Other matcher groups (other tools' AfterAgent hooks) are preserved verbatim.

## State Transitions

Per `AfterAgent` array:

- **No product hook present** → install transitions to "product hook present in a fresh matcher group at the end of the array".
- **Exactly one canonical product group, nothing else changed** → the array is rebuilt to the identical shape and the serialized comparison finds no difference, so no write occurs.
- **Product hook with stale command** (including the old JVM-archive form) → install transitions to "product hook with current command".
- **Multiple matcher groups, several with product hooks** → install transitions to "exactly one product matcher group, at the end" — and this now involves a real write even when one of those groups was already canonical.
- **Canonical product hook sharing a matcher group with a third-party hook** → the product hook is removed from that group (the group and its third-party hook survive) and a fresh canonical group is appended; detection reported not-installed before this run and installed after it.

## Notable Behavior

- Tab-indented JSON output mirrors the Claude installer for consistency.
- Unlike the Claude installer, the Gemini installer never has a no-op-but-warn path: there is no legacy file to clean, so removing-when-already-absent is just an early return.
- The installer is run for *every* worktree by the orchestrator. Each worktree has its own `.gemini/settings.json` because Gemini reads project-relative settings, just as Claude does.
- The `name: "jolli-session-tracker"` field is the only structural difference from the Claude Stop hook entry. The Claude Stop entry uses `async: true` instead; the Gemini AfterAgent entry uses neither `async` nor `matcher`.
- **Every surface writes the same entry.** The IDE plugin no longer installs a JVM-invoking AfterAgent command of its own — it delegates to this shared install path, so all surfaces produce byte-identical command strings. The JVM archive filename remains in the identifier set purely so an entry left behind by an older IDE-plugin release is recognised, replaced on install, and removed on uninstall.
- **A malformed settings file fails the install loudly**, and only file absence is tolerated. This is deliberate: treating an unparseable file as empty would rewrite it from scratch and destroy every unrelated Gemini setting in it.

## Shared Behavior

- The matcher-group helpers — the identifier-match predicate and the identifier-removal filter — are shared with the Claude installer (spec 46). The helper's exact-command predicate is a leftover of the retired fast path and is no longer used by either installer.
- The dispatch-script indirection (`"$HOME/.jolli/jollimemory/run-hook" <hook-type>`) is shared with the Claude and git-shell installers. The command builder takes no source identity and emits no environment prefix, so the written command is identical across every install surface.
- The "tab-indented JSON, atomic write" output convention is shared with the Claude installer, and both installers now genuinely write atomically (temporary sibling plus rename) on install and on removal.
- The "rebuild unconditionally, then compare serialized content to decide whether to write" shape is shared with the Claude installer.
- The "drop empty containers" cleanup pattern is shared with the Claude installer.
- The conditional-install rule (skip when not detected, skip when explicitly disabled) is shared with every other AI-agent integration.
