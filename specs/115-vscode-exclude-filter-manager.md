# VS Code Exclude Filter Manager

## Topic Statement

The glob-pattern filter the KB Folders / Files tab consults to suppress workspace files from its list, with patterns persisted in the per-user configuration as a comma-separated list of globs and edited in the Settings webview, evaluated on every render so the user sees changes the moment they save.

## Scope

**In scope:**
- The input contract: relative paths from the workspace root tested against an array of glob patterns.
- The persistence contract: patterns live in a single field of the per-user configuration file; there is no per-workspace override and no defaults.
- The display string contract: a comma-joined list of patterns, used both in the Settings input field and any "current filter" surfaces.
- The match semantics: the standard glob primitives the project uses everywhere — `*`, `**`, `?`, character classes — plus the surface's specific options (dot-files match, base-name fallback for unanchored patterns).
- The "any pattern matches → excluded" rule: a single hit is sufficient; there is no precedence ordering, no negation, and no later-pattern-wins logic.
- Lifecycle: load once on activation, mutate via Settings save, query synchronously on each render.
- Empty-state behavior: no patterns ⇒ nothing is excluded ⇒ helper predicates (e.g. "any patterns configured?") return false.

**Out of scope:**
- The Settings webview's input field UX (covered in the settings webview spec).
- Where the Files tab itself decides what to render. This spec covers the matcher, not the consumer.
- The agent transcript ignore lists, the source-control file-status filter, or any other "what files do we look at?" gate that lives outside this filter.
- File-size limits, binary detection, or other content-aware filters — none of those are in this filter.
- A defaults set. There are no defaults; an absent or empty patterns field means "match nothing".
- A `.gitignore`-flavored file format. The patterns are a flat array of globs in the config file; no leading-`!` negation, no trailing-`/` directory-only marker, no per-line comments.

## Data Contracts

### Persistence

| Aspect | Value |
| --- | --- |
| Storage | Per-user configuration file (the same one that holds AI keys, integration toggles, etc.). |
| Key | `excludePatterns`. |
| Type | Array of strings. |
| Absent / empty | Treated identically: matcher behaves as "no patterns; match nothing". |
| Per-workspace override | None. Settings are per-user globally. |

### In-memory shape

The matcher holds a single `Array<string>` of patterns. Patterns are loaded once at activation (an asynchronous read of the per-user config) and replaced wholesale on save. There is no live config-file watcher — changes from outside the Settings webview do not propagate until the next activation.

### Public surface

| Operation | Returns / Effect |
| --- | --- |
| Load | Reads the per-user config; replaces in-memory patterns with the persisted array, or empty on any failure (missing file, parse error, permission). |
| Get patterns | Read-only view of the in-memory array. |
| Has patterns | True iff the array is non-empty. |
| Display string | Patterns joined by `, ` (comma + space). |
| Set patterns | Trims each input pattern, drops empty/whitespace-only entries, replaces in-memory state, persists merged with the rest of the config. |
| Is excluded(relativePath) | True iff at least one pattern in the in-memory array matches the path. |

### Match semantics

The matcher accepts paths as workspace-relative (no leading `/`, forward-slash separators on all platforms — the consumer normalizes before calling). Each pattern is evaluated with two options enabled:

- **Dot-files match.** Patterns like `*` match files starting with a dot (e.g. `.env`). The user does not need to special-case dotfiles to exclude them.
- **Base-name fallback.** A pattern with no `/` matches against the file's base name in addition to the full path. For example, `*.log` matches `build/output.log` even though the pattern has no `**/` prefix; the consumer does not need to wrap unanchored extensions.

Glob primitives supported (this is the project's standard glob library, not a custom dialect):

| Token | Meaning |
| --- | --- |
| `*` | Match any sequence of non-`/` characters within one path segment. |
| `**` | Match across path segments (e.g. `dist/**` matches `dist/anything/here.js`). |
| `?` | Match exactly one non-`/` character. |
| `[abc]` / `[a-z]` | Character class, single character. |
| Trailing `/` | Not a directory-only marker. The patterns are flat globs. |
| Leading `!` | Not a negation. The patterns are flat globs; `!foo` would attempt to literal-match a filename that starts with `!`. |
| Comments / blank lines | Not supported in the in-memory array (set-patterns drops blanks; nothing strips a leading `#`). |

### "Excluded" decision

For a given path:

1. If the in-memory array is empty, return false.
2. Otherwise, iterate the patterns. The first pattern that matches the path (with the dot + base-name options) returns true.
3. If no pattern matches, return false.

Order does not matter; precedence does not exist. There is no override, no negation, and no later-wins rule. A pattern is either present (excluding everything it matches) or absent.

## Behavior

### Activation

1. The matcher is constructed empty.
2. The host calls `load()` once, awaiting it before any tab consumes the matcher.
3. `load()` reads the per-user config; on success it copies `excludePatterns` (if present) into the in-memory array; on any failure it leaves the array empty.
4. The matcher is now ready; subsequent `isExcluded` calls are synchronous.

### Editing patterns from Settings

1. The Settings webview saves a `excludePatterns` field as a comma-separated string typed by the user.
2. The host parses that string into an array of trimmed, non-empty strings.
3. The host calls `setPatterns(arr)` on the matcher.
4. `setPatterns` trims each input again (defense in depth), drops any entry that's empty after trim, replaces the in-memory array, and persists the field merged into the per-user config.
5. After the save returns, every subsequent `isExcluded` reflects the new patterns.

### Querying during render

1. The KB Folders / Files tab walks its candidate list.
2. For each file, it asks the matcher whether the workspace-relative path is excluded.
3. The matcher returns true/false synchronously without any I/O.

### Activation failure

1. If the per-user config file is missing or unreadable, `load()` does not throw — it logs and leaves the in-memory array empty.
2. The matcher therefore behaves as "no exclusions", which is the safe default (no files are silently hidden from the user).

## State Transitions

The matcher's state is just the in-memory pattern array. There is no per-file or per-query state.

| From | Trigger | To |
| --- | --- | --- |
| Empty (constructed) | `load()` | Patterns read from config (or still empty on any failure) |
| Any patterns | `setPatterns(newArr)` | New trimmed, non-empty patterns; old patterns discarded |
| Any patterns | `setPatterns([])` (or all-empty input) | Empty |
| Any patterns | Process exit / restart | Same as constructed → empty until next `load()` |

## Notable Behavior

- **No defaults.** A fresh user with no `excludePatterns` field excludes nothing. The brief mentions "defaults (build outputs, node_modules, .git)" — those are not in the matcher; the user has to add them. The Settings input's placeholder shows example patterns (e.g. `**/*.vsix, docs/*.md`) but typing nothing leaves the field empty. (Surprising; reality.)
- **Settings is global per-user.** Two workspaces share the same exclude list. There is no `.jolli/.../config.json` workspace override; the matcher only consults the per-user file. (Notable.)
- **Base-name fallback means short patterns work.** `*.log` matches `deep/nested/file.log` without needing `**/*.log`. This trades precision for ergonomics — the user typing `node_modules` excludes any `node_modules` segment anywhere, not just at the workspace root. (Surprising; intentional.)
- **Dot-files match by default.** `*` excludes `.env`. The user does not need a separate `.*` pattern; the matcher's `dot: true` option is always on. (Surprising; intentional.)
- **No negation, no override, no precedence.** Order in the array is irrelevant; the first match wins by short-circuit, but every match means "exclude". You cannot write `!docs/IMPORTANT.md` to keep one file in. The patterns are a flat union. (Surprising; reality — the brief mentions negation as a possible feature but the matcher does not implement it.)
- **No directory-only marker.** A trailing `/` in a pattern does not constrain the match to directories; it just becomes a literal `/` in the glob. To exclude a directory's contents, write `dir/**`. (Notable.)
- **Failure on load = empty patterns.** A missing or corrupt config file silently turns the matcher into a no-op. The motivation is that the matcher should never accidentally hide everything because of an I/O hiccup; "show too much" is recoverable, "show nothing" is alarming. (Notable.)
- **`setPatterns` trims defensively.** Even though the Settings parser already trims, the matcher trims again before deciding which entries to keep. A whitespace-only entry never reaches the array. (Notable.)
- **No live reload.** Editing the per-user config file by hand outside the Settings webview does not refresh the matcher until the editor restarts. The Settings webview is the only path that updates the in-memory array at runtime. (Notable.)
- **The display string is comma-plus-space.** When the matcher's contents are surfaced as a string (for the Settings field's value, for diagnostic output), the format is `pattern1, pattern2, pattern3`. Parsers that read this string back must split on `,` and trim each token; the surrounding API does that consistently. (Notable.)
- **The matcher does not own the "should we walk this file?" decision.** The Files tab is free to apply additional ignores (e.g. anything VS Code's own search.exclude rejects, or symlinks the tree-builder skips). The matcher only answers "given a path, does it match an exclude pattern in our list?" — composition with other gates is the consumer's responsibility. (Notable.)

## Shared Behavior

- **Per-user configuration file.** The same file the AI configuration, integration toggles, and Memory-Bank folder live in. The matcher is one consumer of one field; the file is read and written by the same atomic-write primitive every other component uses.
- **Glob library.** The same glob implementation powers other "does this path match a pattern" checks in the project (e.g. file-path filters in agents). The dialect is the standard library's; surface options (`dot`, `matchBase`) are this matcher's choice.
- **Settings webview as sole editor.** The Settings panel's "Exclude Patterns" input is the only first-class way to mutate the persisted field; everything else (status bar, sidebar, tabs) is a read-only consumer.
