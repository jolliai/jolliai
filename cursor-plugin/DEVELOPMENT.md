# Developing the Cursor plugin

Structural sibling of [`codex-plugin/`](../codex-plugin/DEVELOPMENT.md): own `dist/`
bundling `cli/src/**`, own marketplace tree, publish-by-bash-script, no npm package
and no release workflow. Read that document first — everything it says about dist
completeness, the source-neutral repo hooks, and `dist-paths/` version competition
applies here verbatim. This file covers only what is different, plus the open
questions that must be closed before a public release.

## Layout

```
cursor-plugin/
├── .cursor-plugin/marketplace.json          # multi-plugin marketplace index
├── README.md                                # shipped to users (carries <marketplace-source>)
├── DEVELOPMENT.md                           # this file — NOT shipped
├── LICENSE                                  # Apache-2.0, mirrored into every release
├── plugins/jolli/
│   ├── .cursor-plugin/plugin.json           # the plugin manifest
│   ├── LICENSE                              # same text again — this dir is the installed unit
│   ├── assets/logo.svg                      # brand mark, named by plugin.json "logo"
│   ├── hooks/hooks.json                     # one sessionStart bootstrap
│   ├── skills/<name>/SKILL.md               # 7 committed static files (generated)
│   ├── scripts/build.mjs                    # esbuild → dist/  (NOT shipped)
│   ├── scripts/generate-skills.ts           # skill generator  (NOT shipped)
│   └── dist/                                # build product, gitignored
└── scripts/                                 # publish-{local,dev,prod,zip}.sh (NOT shipped)
```

Cursor discovers components from their default directories, so `plugin.json` only
declares `skills` and `hooks` for explicitness. There is **no `mcp.json`** — see
"MCP" below.

## Build and iterate

```bash
npm run build:cli && npm run build:cursor-plugin
```

The CLI build must come first: `build.mjs` copies `cli/dist/dashboard-assets` into the
plugin dist and hard-fails if it is absent. Root `npm run build` chains both.

Install it into Cursor for testing:

```bash
bash cursor-plugin/scripts/publish-local.sh
```

That mirrors `plugins/jolli/` into `~/.cursor/plugins/local/jolli/` — Cursor's local
plugin directory needs no install step. Then reload and **start a NEW chat** — the
bootstrap runs on `sessionStart`, which does not fire on a folder open or on `/` in an
existing conversation, so a test that skips this step observes an untouched repo and
looks like a bug in the plugin. Reload is ⌘⇧P → `Developer: Reload Window` (it is not
in the menu bar), but prefer a full quit: a window reload has been observed NOT to
re-scan `~/.cursor/plugins/local/`, leaving the previous bundle live while its files on
disk are already new. For a tighter loop, symlink instead (`ln -s "$PWD/cursor-plugin/plugins/jolli"
~/.cursor/plugins/local/jolli`); the trade-off is that a symlink exposes `scripts/`,
so it no longer proves the plugin works from what a consumer receives.

### Testing through a real marketplace, and why one of the two routes is dead

`publish-local.sh` bypasses the marketplace layer entirely (`~/.cursor/plugins/local/`
holds a single plugin, and no `marketplace.json` is even copied there). To exercise the
path a real user takes, add a marketplace under **Customize → Add Marketplace**, which
offers **Create New**, **Import from Github** and **Import from Disk**. The last two are
not two spellings of one mechanism, and the difference was measured on Cursor 3.15.6
rather than reasoned about:

**Import from Github resolves through Cursor's backend.** `parseGitHubRepoForPlugins`
branches on the server-side gate `enable_local_3p_plugin_imports`; only when it is ON
does it call `parseGitHubRepoForPluginsLocally` and persist the result. Otherwise the
plugin list comes from a *shared marketplace snapshot* fetched from the dashboard and
keyed by `getTeamId() ?? "no-team"`. On a free account with no team, importing a PUBLIC
repository produced: an entry in the marketplace filter, **zero plugins**, nothing under
`~/.cursor/plugins/marketplaces/`, and not one line in any log. The giveaway is the
entry's TITLE — it read `Jolli Plugin Dev Jolli Cursor Plugin`, derived from the repo
slug, where a parsed manifest would have shown `Jolli Cursor Marketplace`. So the
manifest was never read at all. Which of the two server-side variables (the gate, or
team membership) is the operative one was not isolated — both are server-side and
neither is visible to the client.

**Import from Disk is local and needs neither.** It lands under a pseudo-host `_` with
the absolute path as segments — `~/.cursor/plugins/marketplaces/_/users/<you>/<sha>/` —
alongside the `github.com/<owner>/<repo>/<sha>/` form. Point it at the **dev checkout**
(`../jolli-cursor-plugin-dev`), not at `cursor-plugin/`: the checkout is `publish_sync`'s
output, so `scripts/` is gone and the README's source placeholder is resolved, which is
what a consumer actually receives.

**That import is a SHALLOW CLONE, not a reference to your directory** (its `.git` carries
`shallow` and `FETCH_HEAD`). Editing the source tree changes nothing in Cursor. Each
iteration is therefore: `publish-dev.sh`, then remove and re-import in Cursor. The
version number does not move on a dev republish, but the commit sha does, and the sha is
what the cache directory is keyed on — so watch the sha, not the version, to confirm you
are running the new build.

After editing a skill body, regenerate the committed copies:

```bash
npx tsx cursor-plugin/plugins/jolli/scripts/generate-skills.ts
```

This is the Codex plugin's trap repeated: the skills are **committed static files**,
so an edit to a builder in `cli/src` ships nothing until the generator runs.
`CursorPluginSkills.test.ts` fails on drift, and `publish_assert_skills` re-checks it
with `--check` because the publish scripts cannot rely on a test that only runs in CI.

Four builders (`recall`, `search`, `local-run`, `remote-run`) serve the Claude, Codex
AND Cursor bundles as committed files, so editing one is an edit to **three** artifacts
plus the installed copy: bump the revision + fingerprint for `.agents/skills/` AND
regenerate all three plugins' bundled copies. This bundle joined that set when the
per-repo mirror was retired (see "The duplicate-entry problem" below) — before that it
shipped none of the four and needed no regeneration step.

A fifth shared body reaches this bundle the same way: `jolli-dashboard`, built by
`buildDashboardSkillTemplate` in `cli/src/install/PluginSkillText.ts`. It is shared with
the Codex bundle rather than restated per host (the two copies differ only in the
frontmatter `name`, which each renderer rewrites). Unlike the four it has no
`.agents/skills/` counterpart at all — no `jolli enable` writes that name anywhere — so
it is the one shared body Cursor's flat menu cannot show twice. Editing it means
regenerating **both** plugin bundles, and hand-updating the
Claude plugin's independent copy at
`claude-plugin/plugins/jolli/skills/dashboard/SKILL.md`, which — like every skill in
that bundle — no drift test pins. It carries no `metadata.revision`, since nothing
upserts it.

## What differs from the Codex plugin

| | codex-plugin | cursor-plugin |
|---|---|---|
| Manifest | `.codex-plugin/plugin.json` | `.cursor-plugin/plugin.json` |
| Marketplace | `.agents/plugins/marketplace.json` | `.cursor-plugin/marketplace.json` |
| Marketplace `name` | `jolli-marketplace` | `jolli-cursor` (must differ — see below) |
| Hook event | `SessionStart` (PascalCase) | `sessionStart` (camelCase) |
| `hooks.json` shape | nested `[{ hooks: [{ type, command }] }]` | flat `[{ command }]` |
| Plugin-root variable | `${PLUGIN_ROOT}` | `${CURSOR_PLUGIN_ROOT}` |
| Hook output envelope | `{ hookSpecificOutput: { hookEventName, additionalContext } }` | flat `{ additional_context }` |
| Project dir in hook input | `cwd` | `workspace_roots[]` / `$CURSOR_PROJECT_DIR` |
| MCP registration | global `~/.codex/config.toml` (+ `McpLauncher.js`) | repo `.cursor/mcp.json`, no launcher |
| Skill directory names | bare (`recall`) | `jolli-` prefixed (`jolli-recall`) |
| dist entries | 13 | 12 (no `McpLauncher`) |
| Local test target | a marketplace directory | a single-plugin directory |

Four of those are load-bearing enough to restate:

**The marketplace `name` must NOT match the Claude plugin's, and "they are different
files on different hosts" is not protection.** Cursor resolves a marketplace manifest
from `[".cursor-plugin/marketplace.json", ".claude-plugin/marketplace.json"]` — the
Claude repo is a perfectly valid Cursor marketplace, and adding it is how the Claude
bundle reaches Cursor in the first place. Both can therefore be registered at once, and
the manifest `name` — not the repository — is the namespace key on disk:
`getCacheDir` resolves `~/.cursor/plugins/cache/<marketplace-name>/<plugin-id>/<version>`.
Both plugins are named `jolli`, so a shared marketplace name puts two different
repositories' builds in ONE directory, and three things follow, all read out of Cursor
3.15.6's own provider rather than inferred:

- `removeAllVersions` deletes `cache/<marketplace>/<plugin>/` **wholesale** (the same
  path with the version segment omitted), so cleaning up one plugin takes the other's
  cache with it.
- `listCachedVersions` `readdir`s that directory and returns every subdirectory as a
  version *of one plugin*, so the two repositories' commits enumerate as versions of
  each other.
- The Claude-marketplace importer skips on name, not on source:
  `if (existingUserMarketplaceNames.has(m.name)) → {kind:"skipped-existing"}`. A
  same-named user marketplace therefore suppresses the Claude import silently
  (`cc-marketplace-import.skippedExistingUserMarketplace`, nothing in the UI).

That last one happens to suppress the wrongly-imported Claude server described under
**MCP** below — do not mistake that for a fix. It is decided by which marketplace was
added first, and it is the reason a name collision reads as working.

Only the marketplace name is disambiguated; the plugin stays `jolli`. The pair is what
collides, `<plugin>@<marketplace>` is already unique once one side differs, and renaming
the plugin would move the skill directories, `${CURSOR_PLUGIN_ROOT}` and
`~/.cursor/plugins/local/jolli` for nothing.

The remaining three:

**The `hooks.json` shape is flatter.** Cursor maps an event name straight to an array
of `{ command, type?, timeout?, loop_limit?, failClosed?, matcher? }`. Reusing
Claude's/Codex's intermediate `{ hooks: [...] }` group would parse as an entry with no
`command`. `build.mjs` asserts the shape, the event name, and the presence of
`${CURSOR_PLUGIN_ROOT}` — an unexpanded plugin-root variable produces a command that
fails silently on every session.

**The output envelope is flat and snake_case.** `sessionStart` returns
`{ env?, additional_context? }` at the top level. This is precisely the mistake that
shipped on the Codex side in the opposite direction (a flat `{ additionalContext }`
where a nested envelope was required), and it failed in the worst way: the bootstrap's
side effects all landed, so the install looked healthy while no briefing ever reached
the model. Verify a real session, don't verify that hooks got installed.

**Cursor's command hooks are fail-open.** A nonzero exit or unparseable stdout lets the
action proceed; `failClosed: true` is opt-in, and exit code `2` means "block". That
matches Jolli's rule that a hook must never break the user's session, so the bootstrap
swallows its own errors rather than relying on the default.

## MCP

The plugin ships **no `mcp.json`**, for the same reason the Codex plugin ships none: a
plugin-declared MCP entry resolves its relative `cwd` against the plugin root, and
every memory tool derives the repository it serves from its cwd — so such a server
answers `recall` / `search` / `status` for the plugin's own cache directory with
empty-but-successful results. `startMcpServer` refuses a cwd under `**/.cursor/plugins/`
as the backstop.

Cursor's MCP config is **repo-scoped** (`<worktree>/.cursor/mcp.json`), which makes
this easier than on Codex: the ordinary `cursorRegistrar` in
[`HostRegistrars.ts`](../cli/src/install/mcp/HostRegistrars.ts) is already the right
writer, and `Installer`'s `pluginHost === "cursor"` branch calls
`registerRepoMcpHosts` plus the matching git-exclude entry. No exception to the
global-host skip is needed.

**Writing that file is not the same as the server running, and the gap has a measured
shape.** Cursor materialises the servers it will actually spawn under
`~/.cursor/projects/<slug>/mcps/`, and a newly discovered project server is registered
**disconnected** — the user has to switch it on in Customize. On a machine where
`jolli enable` had written `.cursor/mcp.json` months earlier, that directory held only
`cursor-app-control`, `cursor-ide-browser` and `plugin-jolli-jollimemory`: the
repo-scoped entry was never materialised, and the **imported Claude plugin's** server
occupied the entire tool surface with all 32 tools — rooted at the user's HOME, logging
`Not a claimable project … /Users/samli` on every start while the UI showed a green
"Connected". So a Cursor user can have a correct `.cursor/mcp.json`, a connected
`jollimemory`, and still be asking an empty repository. Check
`~/.cursor/projects/<slug>/mcps/` before concluding that MCP is wired up, and expect to
tell users to enable the project server in Customize once.

## Skill namespacing — settled, with citations

**Cursor does not namespace plugin skills.** Read out of Cursor's own
`workbench.desktop.main.js` and `extensions/cursor-agent-exec/dist/main.js`, plus
`cursor.com/docs/skills`. First read on 3.14.7 and re-asserted function-by-function on
3.15.6 after an auto-update, so these are not one build's accident:

- **The invocation name is the parent directory of `SKILL.md`.** `iBg(path, filename)`
  returns `path.split("/").at(-2)`, falling back to the filename minus `.md`. The
  slash-menu entry is built as `{ name: frontmatter.name || derived, commandName:
  derived, searchAliases: [derived, …] }` — no plugin segment anywhere. The docs
  independently require `name` to *match the parent folder name*.
- **One flat pool, eight roots.** The workbench accepts `SKILL.md` under
  `.cursor/skills/`, `.cursor/skills-cursor/`, `.cursor/cloud-skills/`,
  `.cursor/plugins/`, `.claude/skills/`, `.claude/plugins/`, `.codex/skills/` and
  `.agents/skills/`. A plugin's only distinguishing mark is `pluginAttribution`,
  which becomes a brand **icon** — never part of the name.
- **De-duplication does not disambiguate across plugins.** `rBg` keys on
  `(pluginDisplayName, skillName)` and only keeps the higher-scoring of a collision
  (score = published-by-Cursor 4 + server-safe-sync 2 + has-logo 1). Entries with no
  plugin attribution are pushed unconditionally. So two different plugins — or a
  plugin and a user's own `.cursor/skills/` — coexist as two entries with the
  identical name, no suffix, neither shadowing the other.
- **The model sees no name either.** The agent-side skill object carries `fullPath`,
  `content`, `description`, `globs`, `environments`, `disabledEnvironments`,
  `scopedTo` and `disableModelInvocation` — there is no name field, so discovery is
  by description and identity is the path.

That is why this bundle keeps the canonical `jolli-` prefix where the Codex bundle
drops it: a bare `/init` or `/status` would be indistinguishable from anyone else's.
`CursorPluginSkills.test.ts` pins the prefix and the constraints below.

### Constraints the plugin reference doesn't state

Worth knowing before editing a skill body, all from the same reading:

| | |
|---|---|
| `name` | lowercase letters/digits/hyphens, ≤64 chars, **must equal the directory**. A mismatch is not an error — the menu invokes the *directory* name and `name` degrades to a label. |
| `description` | required (a skill without one is loaded with `parseError: "Description is required"`); ≤1024 by the docs, hard-truncated to **1536** by `kt()` before the model sees it. |
| `alwaysApply: true` | reclassifies the skill as a **global rule**, injected into every session. Never set it here — eleven long documents in every context. |
| `disable-model-invocation: true` | makes the skill explicit-invocation only. Cursor's own `create-skill` recommends defaulting to it; Jolli's skills deliberately stay model-invocable, since recall/search must trigger from ambient context. |
| `paths` / `globs` | interchangeable — the loader reads `data.paths ?? data.globs` — and scope the skill to matching files. |
| `metadata.*` | genuinely read, not just tolerated, and the mechanism is worth stating exactly because it is tempting to misuse. The frontmatter parser (`qVv`) explicitly handles `metadata.environments` and `metadata.disabledEnvironments`; `q5u(skill, env)` then decides visibility — `disabledEnvironments` containing `env` hides the skill, and a **non-empty** `environments` that does not contain `env` hides it too. **`env` is a RUNTIME mode, not a host**: the only values observed are `"cloud"` and `"auto"` (`q5u(e,"cloud")`), so this cannot express "hide this from Cursor but not from Codex". Declaring `environments` with any value Cursor never uses therefore hides the skill from **every** environment — that is the real mechanism behind "a stray key silently hides a skill", and it is one more reason the generator strips the block. Do not reach for it as a de-duplication trick: the other hosts do not read these keys today, but if any of them starts to, the skill disappears everywhere at once. |

### The duplicate-entry problem, and why the bundle ships everything anyway

`.agents/skills/` is a **first-class** Cursor skill root. So a repo that ran a full
`jolli enable` already has `/jolli-recall` in Cursor from `.agents/skills/`, and a
bundled copy under the identical name is a **second entry** that `rBg` will not
collapse — the `.agents/` copy has no plugin attribution, so it is pushed
unconditionally. On Codex the same duplication is invisible because the two land under
*different* names (`jolli:recall` vs `jolli-recall`); here they differ only by a brand
icon.

Shipped whole, the overlap is **five** entries: `jolli`, `jolli-recall`, `jolli-search`,
`jolli-local-run`, `jolli-remote-run`. The umbrella is easy to miss — the CLI writes
`.agents/skills/jolli` too.

**Resolution: the bundle ships everything and the duplicate is ACCEPTED.**

```
bundle (12)  jolli
             jolli-init  jolli-login  jolli-logout  jolli-status
             jolli-dashboard  jolli-timeline  jolli-push
             jolli-recall  jolli-search  jolli-local-run  jolli-remote-run
```

Nothing is written outside the bundle any more. Two placements were retired to get
here, in that order — the per-repo mirror of the four shared skills, then the
machine-global umbrella.

#### What was tried instead, and why it was wrong

The four overlapping skills were once withheld from the bundle and **mirrored per repo**
into `<repo>/.cursor/skills/<name>/` — as symlinks into the bundle, written only when no
root Cursor reads already supplied the name, and removed again once one did. It kept the
menu at one entry per name. It also optimised for the wrong user, and the cost was not
cosmetic:

- **A Cursor-only user got no `recall` and no `search` at all.** The mirror was planted
  by the `sessionStart` bootstrap, and this host's consent gate (`isGitHookInstalled`,
  see below) is false in a repo that has not been set up. So the plugin's core
  capability was missing from its store page *and* missing from the slash menu until the
  user happened to find `/jolli-init`. For the audience this bundle exists for — someone
  who runs Cursor and nothing else — that is the whole product, absent.
- **The symlink targets needed a second record to locate.** `dist-paths/cursor-plugin`
  cannot answer "where is this host's bundle" (it is keyed by source tag alone, so it
  holds whichever runtime last installed under that tag — measured: `/jolli-init`
  dispatches through `run-cli`, the CLI wins the version tie, and
  `dirname(distDir)/mirror` came out as `<repo>/cli/mirror`, so all four links dangled
  silently). The fix was a `~/.jolli/jollimemory/cursor-plugin-root` record written by
  the bootstrap from its own `import.meta.url` — one more piece of machine-global state,
  invalidated by every marketplace upgrade until the next Cursor session.
- **A host-neutral reconcile read another app's private SQLite.** Deciding "is this name
  already supplied" meant asking whether `.claude/skills/` was visible to Cursor, which
  meant opening `state.vscdb` for `thirdPartyExtensibilityEnabled` — from every Claude
  and Codex session start, since the reconcile had to be host-neutral to survive a
  plugin removed through Cursor's UI.
- **It needed `.git/info/exclude` upkeep**, and got it wrong once already: git reports an
  untracked directory as a single `?? .cursor/` line rather than descending, so the
  per-skill entries alone left the whole tree in `git status`.
- **The machine-global `/jolli` was collateral.** The reconcile inferred "the plugin is
  gone" from a stale bundle record and deleted the umbrella — which also fires during the
  window a marketplace upgrade leaves while moving the version-stamped bundle, so any
  OTHER runtime reconciling in that window took the front door away from a plugin that
  was very much installed.

A duplicate entry paid only by multi-host users beats all five. What remains is a
one-way sweep: `removeCursorRepoSkills` plus
`removeGitExcludePaths(CURSOR_RETIRED_SKILL_GIT_EXCLUDE_PATHS)`, on every install path
and still host-neutral, because a leftover symlink is now a duplicate of something the
bundle supplies — and a *dangling* one after an upgrade. Both are ownership-guarded, so a
`.cursor/skills/jolli-recall` the user wrote themselves is left alone.

**Two rules survive the retirement and are not up for revisiting.** De-duplicating in
the `.agents/` direction stays forbidden: it is the only copy Codex, Gemini, OpenCode,
Windsurf and Copilot have. And `jolli-init` stays in the bundle — Cursor drops every
plugin hook silently when its provider times out or either extensibility gate is off, and
it is the only manual route back into setup. Its presence is pinned by a test, as is the
umbrella's absence from the bundle, so neither moves by accident.

### The Agents Window names no repository, ever — and why the front door is BUNDLED

**Measured 2026-08-13 with a throwaway probe plugin on Cursor 3.15.19**, after a day
spent misdiagnosing it twice. This is the finding that sets this host's whole install
model, so the evidence is written out rather than summarised.

Cursor's chat-first window — the one whose sidebar lists **Repositories**, labelled
`CURSOR_WORKSPACE_LABEL=Agents Window` — delivers `sessionStart` like this:

```json
{ "hook_event_name": "sessionStart", "workspace_roots": [], "transcript_path": null,
  "conversation_id": "…", "composer_mode": "agent", "cursor_version": "3.15.19" }
```

with `CURSOR_PROJECT_DIR=""` in the environment. **Starting the conversation from a
repository's own `+` button changes nothing** — both that and the top-level "New Chat"
produced `workspace_roots: []`. Two earlier readings that looked like counter-evidence
were not: `workspaceOpen` fires with a correct root, and so does a `sessionStart` — but
both land in a *workspace-bound* window (`CURSOR_WORKSPACE_LABEL` is the repo name, and
the hook log is `cursor.hooks.workspaceId-<hash>.log` rather than
`…-empty-window.log`). Attribute every repo-bearing event to its window before
concluding anything.

Nothing recovers the repository from inside that payload:

- `CURSOR_PROJECT_DIR` is the EMPTY STRING, not unset. `resolveCursorProjectDir`'s
  `candidate.trim().length === 0` guard is what makes that harmless — a `??` would pass
  `""` straight through. Load-bearing, and not obviously so.
- `transcript_path` is null.
- `~/.cursor/projects/<encoded-repo>/agent-transcripts/<conversation_id>` DOES map a
  conversation to a repository, but it is created when the conversation first does
  work, not at `sessionStart`. A probe conversation that sent no message appeared
  nowhere. Chicken-and-egg; do not build on it.

The agent's own shell, by contrast, runs **inside** the repository (`pwd` and
`git rev-parse --show-toplevel` both answered `cursor-plugin-demo`). So a SKILL can act
on the repo in that window even though the HOOK cannot name it.

Two consequences, and they are the design:

1. **A PER-REPO front door is impossible on this surface**, so `/jolli` is shipped in the
   bundle. For a while it was written machine-global to `~/.cursor/skills/jolli/` instead,
   which reached the surface but was the wrong fix twice over — see the follow-up
   measurement below.
2. **The bootstrap installs nothing into a repository that has not opted in.** Not
   because it cannot — in a workspace-bound window it could — but because it should not:
   a `workspaceOpen` fires for EVERY repository in the sidebar at startup, so
   auto-install reaches repositories the user only browsed. See the consent gate below.

#### Follow-up, measured 2026-08-21 on Cursor 3.16.29: bundle it, don't plant it

The machine-global placement rested on an untested inference — that a *bundled* skill
would be as unreachable from this window as a per-repo one. It is not. Read out of
Cursor's own slash-menu cache
(`ItemTable` key `agentData.cacheStorage.agentEnvironment.slashMenuItems.v6.local.glass.<ctx>`
in `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`):

- all bundled skills appear in **both** no-repository contexts — the `empty-window` one
  and the Agents Window's repo-less `Home` project (`glass.additionalProjects` lists it
  with a `workspaceIdentifier` but no `uri`);
- entry ids carry their origin, which is what makes this readable at all:
  `skill-cache/<marketplace>/<plugin>/<sha>/skills/<name>/SKILL.md` for a bundled skill
  versus a bare `skill-<name>/SKILL.md` for one from a skills root;
- `cursor.plugins.installedIds.no-team|no-workspace` recorded the install, so that
  store's per-workspace sharding (`KHg(teamId, folders)`, `folders.length === 0` →
  `"no-workspace"`) is a warm-up cache — its only consumer is
  `_maybeWarmMarketplacePluginsForCurrentContext` — and **not** a load gate.

And the machine-global copy could not survive its own first install: **a freshly
installed plugin's hooks are not registered until Cursor is FULLY restarted.** Measured
in sequence — install, then a new chat: 11 bundled skills appeared in the menu while
`~/.jolli/jollimemory/debug.log` gained not one line, `~/.cursor/skills/` stayed empty
and `dist-paths/cursor-plugin` was never written. After ⌘Q and a new chat, the hook ran
and wrote all three within 4 ms. So on every new install the old design shipped every
skill except the front door, and `/jolli`'s Step 0 read the missing dispatcher as "Jolli
is no longer installed on this machine" and offered to `rm -rf` itself.

The cost of bundling it, so nobody re-litigates it by accident: `~/.cursor/skills/` is in
Cursor's always-loaded group while `.cursor/plugins/` is gated behind
`thirdPartyExtensibilityEnabled` (measured `'true'` on this machine) plus the server-side
`enable_cc_plugin_import` — so with a gate off the umbrella now goes with the other
eleven instead of surviving alone. Taken deliberately: the first-install hole affects
every new user, the gate-off case is one where MCP, hooks and every skill are gone too.

What survives of the old placement is a one-way sweep — the bootstrap calls
`removeCursorGlobalMenu` where it used to call `ensureCursorGlobalMenu`, and
`UninstallScan`'s `scanCursorGlobalMenu` is the second route for a machine whose
bootstrap never runs again. `buildCursorJolliSkillTemplate` keeps its `metadata:` block
(stripped from the bundled render) because the `vendor` marker in it is what makes that
leftover recognisable as ours.

Pinned by `CursorPluginSkills.test.ts` (the umbrella is in the bundle; the sweep removes
only a marked leftover), `CursorPluginManifest.test.ts` (`skills/jolli/SKILL.md` exists
on disk) and `CursorPluginBootstrapHook.test.ts` (the consent gate's four cases, and the
sweep running with no workspace).

### The consent gate — this host does not install on its own

`runCursorPluginBootstrap` gates the whole `install()` call on
`isGitHookInstalled(worktreeRoot)`. An un-opted-in repository gets no git hooks, no
`.cursor/mcp.json` and no briefing.

What it DOES get is every skill, because they are bundled rather than written into the
repo — which is the point of retiring the mirror. The capability no longer depends on a
gate a fresh repository cannot pass; only the repo-side plumbing does.

**The gate is drawn around the WORKTREE, not around the machine.** Two writes stay
unconditional, and both are in `~/`: the `/jolli` umbrella, and the runtime registry —
the three dispatch scripts plus `dist-paths/cursor-plugin`, via
`reconcileRuntimeRegistry`. Drawing the gate around
those too was measured as a **closed loop** on a plugin-only machine, because
everything the front door falls back to is `run-cli`:

- `/jolli` Step 0 finds no MCP tool (this bundle ships no `mcp.json`, and
  `.cursor/mcp.json` is written by the install being deferred) and no dispatcher, so it
  takes its "dispatcher absent" branch — *"Jolli is no longer installed on this
  machine… remove it with `rm -rf ~/.cursor/skills/jolli`"* — to a user who installed
  the plugin minutes ago.
- `/jolli-init` shells `run-cli` at every step, and its remedy for a missing dispatcher
  is "reload the window so the `sessionStart` hook runs". That hook is this one, which
  returned before writing it. Reloading repeats the same early return forever.

Registering a runtime is not a claim about any repository — it says "a runtime of this
version lives here", the same claim `recordCursorPluginRoot` makes one line earlier, and
it is what every other surface's install writes byte-identically. What the gate protects
is `.git/hooks/*` and `.cursor/` in a repository the user only browsed; that is
untouched.

This is a deliberate divergence from the Claude and Codex bootstraps, which install
into whatever repository the session names, every session. Three reasons it is right
here and was not obviously wrong there:

- Writing `.git/hooks/*` into a repository is a change to someone's working copy. On
  Cursor the set of "repositories the session names" includes every row in the sidebar,
  which is not the same as "repositories the user wants Jolli in".
- The front door is now unconditional and machine-global, so an un-set-up repo is not a
  dead end: `/jolli`'s Step 2 already branches on `enabled` (which `getStatus` derives
  from the same `isGitHookInstalled`) and hands off to `jolli-init`. The guided setup
  existed before this change; it just never got reached. That argument holds only
  because the runtime registry is unconditional too — see the paragraph above; a front
  door with no `run-cli` behind it is a dead end that misreports itself as an uninstall.
- A late opt-in loses nothing permanent — `run-cli backfill --all` writes memories for
  history that is already there, and Cursor's own transcripts stay on disk for
  attribution.

`isGitHookInstalled` is the predicate rather than a flag of our own precisely because
`getStatus` already derives `enabled` from it: the gate and the state `/jolli` reads
cannot disagree.

**Maintenance is not opt-in.** An already-installed repo still reconciles on every
session, and must: an upgrade moves the version-stamped bundle, and the mirrored skills
are symlinks into it.

## Hook execution — settled by a live probe

**Cursor DOES execute plugin-declared hooks**, unlike codex-cli 0.146.0, which never
ran them and left a fresh Codex install inert until `/jolli:init` was invoked by hand.
Verified by installing a throwaway plugin under `~/.cursor/plugins/local/` whose hooks
appended their environment and stdin to a file — not by checking that side effects
landed, which the `/jolli-init` fallback also produces. Captured on **Cursor 3.15.6**:

| event | fired | process cwd | notes |
|---|---|---|---|
| `workspaceOpen` | yes, ~7 s after launch | plugin root | fires **again** on every window reload / folder change — 4 firings across two restarts |
| `sessionStart` | yes, on new composer conversation | plugin root | `transcript_path: null`, `CURSOR_TRANSCRIPT_PATH` unset |
| `beforeSubmitPrompt` | yes, same instant as `sessionStart` on the first send | plugin root | carries `prompt` + `attachments`, which included `{type:"rule",file_path:"CLAUDE.md"}` and `AGENTS.md` |
| `stop` | yes, ~5 s later | **workspace root** | `transcript_path` populated |

Three things that capture settles:

- **`${CURSOR_PLUGIN_ROOT}` is expanded.** The probe script ran at all, which is the
  proof — an unexpanded path does not exist. Both `CURSOR_PLUGIN_ROOT` and
  `CLAUDE_PLUGIN_ROOT` are also exported into the hook's environment. Internally every
  plugin hook is tagged `source: "claude-plugin"` regardless of format, and that tag is
  what gates the expansion; it is a legacy name, not a filter on Claude plugins.
- **The cwd is the PLUGIN DIRECTORY, not the workspace** — except for `stop` and
  `subagentStop`, which get `workspace.folders[0]`. This is why
  `resolveCursorProjectDir` reads `workspace_roots` / `CURSOR_PROJECT_DIR` and refuses a
  plugin-bundle cwd instead of falling back to it: a marketplace cache is often a real
  git checkout, so `rev-parse --show-toplevel` would succeed inside the bundle and jolli
  would install git hooks into the plugin's own repository.
- **Two gates, one of them server-side — and both are inspectable.**
  `loadPluginHooks()` clears every plugin hook unless `thirdPartyExtensibilityEnabled`
  (a user setting, defaults **true** — `nh(!0)`) AND the feature gate
  `enable_cc_plugin_import` are both on. Both were on for the account tested, and a
  gate that stops it SAYS SO: `Claude Code hooks disabled (thirdPartyExtensibilityEnabled
  off)` reaches the hooks log. So an empty hook list with no such line means the gates
  passed and something further down returned nothing — which is the next section, and
  is a far more likely failure than either gate.

### The failure mode that actually bit: a silent provider timeout

**Measured 2026-08-12, and operationally the most important thing in this file.** The
same plugin that executed its bootstrap the day before stopped executing it, with its
files unchanged, and nothing anywhere reported a problem.

| | 2026-08-11 | 2026-08-12, after a full restart |
|---|---|---|
| hooks registered for `sessionStart` | **4** | **0** |
| jolli bootstrap | ran twice — 238 ms / 290 ms, exit 0 | never invoked |
| skills in the slash menu | present | present |
| MCP server | connected | connected |

The path, read out of 3.15.6's bundle:

```js
loadPluginHooks(){
  if(!this.isClaudeCodeHooksEnabled()){ /* clear */ return }        // gate 1 — logs when it stops
  if(!this.experimentService.checkFeatureGate("enable_cc_plugin_import")){ /* clear */ return }
  const e = await this.pluginsProviderService.getPluginHooks()      // ← the real risk
  ...
}
_callWithTimeout(e,t,n){
  const r = await Fv(ab(this._pluginsProvider), T2t, ...)
  if(!r) return n;   // n = {hooks:[], errors:[]} — NO LOG ON THIS PATH
  ...
}
```

`getPluginHooks()`'s default value is `{hooks: [], errors: []}`. When the plugins
provider cannot be obtained, **every plugin hook silently ceases to exist** — no error,
no warning, nothing in `cursor.hooks.*.log`. The hook log just shows the configuration
reload completing with no plugin hooks in it, which is indistinguishable from "this
plugin declares no hooks at all".

**The only visible symptom lives in an unrelated log.** `MCPService` uses the same
provider and *does* report its failure, once a minute for as long as it lasts:

```
[MCPService] Error creating client: Timeout waiting for EverythingProvider with command 'mcp.createClient'
```

Two things that look like the cause and are not:

- **`cursor.plugins.installedIds.<team>|<workspace>` being `[]`** for every workspace.
  It reads as "no plugin is installed", but it is the same provider answering — a
  symptom, not a diagnosis.
- **Skills and MCP still working.** They arrive by different paths, so the plugin looks
  entirely healthy: skills in the menu, MCP connected with its full tool set. Only the
  hook is gone.

On the machine observed, eight workbench instances (`window1_wb0` … `wb7`) were
repeatedly registering and unregistering providers (`ExtHostCursorExplorerProviderService
Main thread provider unregistration failed Canceled`) — the likeliest trigger, since the
main thread never let the provider settle. Recovery was a full quit (`pkill -f Cursor`)
rather than a window reload.

**Diagnosing it.** The bootstrap's dist-path registration is machine-global, so it moves
whenever the hook actually runs — a stale version there means the hook did not run:

```bash
cat ~/.jolli/jollimemory/dist-paths/cursor-plugin
```

Cursor's own record is what distinguishes "never invoked" from "invoked and failed":

```bash
grep -r "CursorPluginBootstrapHook" ~/Library/Application\ Support/Cursor/logs/ | tail
```

**What this means for the product.** `/jolli-init` and the skills' `run-cli` fallback
are not a safety net for an edge case — they are a **co-equal primary path**, because
the hook channel can disappear without notice on a machine where everything else about
the plugin looks fine. So no capability may depend on the bootstrap having run as its
only route: not skill completeness, not MCP registration, not git-hook installation. The
`/jolli` umbrella stays in the bundle for the same reason — when the hook never fires,
it is the only thing left that can tell the user what happened and what to run.

One side finding came out of the same probe and is **fixed**: `enable_cc_plugin_import`
also makes Cursor import **Claude** plugins wholesale, including their `.mcp.json`. On
the test machine that produced a second, plugin-launched jolli MCP server rooted at the
user's HOME (`WARN [StorageFactory] Not a claimable project … /Users/samli — using
orphan-only storage`), answering `recall` / `search` / `status` empty-but-successfully
while logging "Successfully connected". Cursor spawns MCP servers from a shared process
*before any workspace folder is known* (`WARN No workspace folders found` in
`mcpprocess.log`), so the child inherits the host's cwd and nothing in that launch can
recover the workspace — not even an env var, since `CURSOR_WORKSPACE_LABEL` goes to the
extension host only. `startMcpServer` now refuses any cwd that is not inside a git
worktree, which is the general form of its existing plugin-bundle guard; see the rule in
`AGENTS.md`. The affected surface is the already-published **Claude** plugin, so the fix
ships with the next CLI/plugin build rather than being specific to this bundle.

## End-to-end install — verified

`publish-local.sh` → new Cursor window on a fresh git repo → `Cmd+L`. Everything the
bootstrap owns landed, and the trace is in the repo's own `debug.log`:

- `dist-paths/cursor-plugin` = `0.99.10` + `~/.cursor/plugins/local/jolli/dist`. Note
  the version is the **CLI core** (`__CLI_PKG_VERSION__`), not `plugin.json`'s `1.0.0`
  — so a plugin does not outrank a same-core CLI just by carrying a 1.x manifest.
- all five git hooks installed, source-neutral (`run-hook`, no
  `JOLLI_DIST_PREFER_SOURCE`);
- `.cursor/mcp.json` written with the `run-cli` dispatcher and **no `cwd` key**, plus
  `/.cursor/mcp.json` merged into `.git/info/exclude`;
- machine-global config untouched — `aiProvider` / `localAgentTool` already had values
  and the first-wins seed correctly left them alone;
- the mirrored tree contains no `scripts/`, `.gitignore` or `DEVELOPMENT.md`, so the
  install is what a consumer actually receives.

**MCP needs one click the first time, and this is the measured answer to what used to
be open question #1.** Cursor noticed the freshly written `.cursor/mcp.json` **within
the same second** it was written — `Lease change event … project-0-e2e-repo-jollimemory`
at 19:06:24.741 against a write at 19:06:24.524, no reload involved — but registered it
`none → disconnected` and never spawned it (`mcpprocess.log` has no entry for it). So
discovery is live; *connection* waits for the user to enable `jollimemory` in
**Customize**. A second `sessionStart` (a new chat) does not connect it either — the
only state transition ever recorded was that first one. The README and the `jolli` /
`jolli-init` skills say exactly that now; the earlier "reload the window" wording was
wrong in both directions.

That also sharpens how bad the imported-Claude-plugin MCP server is. Because the correct
repo-scoped server sits disconnected, the imported one is the *only* materialised server
for the project — `~/.cursor/projects/<slug>/mcps/` held just
`plugin-jolli-jollimemory/` with all 32 tool definitions. So a Cursor user with the
Claude plugin installed got a complete jolli tool set answering for the wrong directory,
not a broken extra alongside a working one. `startMcpServer`'s new worktree guard is what
stops that.

**Re-running the bootstrap is idempotent, with one fix needed to make it so.** The second
session logged no `Git * hook installed` lines — the five hooks were recognised as
current and left alone. `.cursor/mcp.json`, though, was rewritten every session:
`upsertJsonMcpServer` had no content comparison, unlike its `config.toml` sibling, and
this branch is the first caller to reach it per-session. It now compares the rendered
file and writes atomically, so the steady state touches nothing.

One environment note, not a defect: the bootstrap's briefing phase logged
`WARN [CutoverRouter] database unavailable for un-cutover repo (database schema v5 is
newer than this build's v3 — upgrade this surface) — orphan remains authoritative`.
That is the designed degradation when a bundle built from an older CLI meets a database
a newer surface wrote — here a dev worktree at 0.99.10 against a machine whose
`claude-plugin` is 0.99.11. It costs the briefing its database reads and nothing else.

## Open questions — close these before a public release

1. **Is `cursor-agent` the right `localAgentTool` to seed?** `PLUGIN_HOSTS` maps
   `cursor-plugin` → `cursor-agent`, on the theory that it shares the IDE's login. That
   relationship is explicitly recorded as unverified in
   [`ToolMeta.ts`](../cli/src/core/localagent/ToolMeta.ts) (`separateDesktopApp` is
   deliberately unset for `cursor-agent`). If the IDE and CLI credentials turn out to
   be separate stores, a fresh install would seed a provider that cannot authenticate.

   Narrower than it was: `/jolli-init` used to *overwrite* `localAgentTool` on every
   run, so a user configured on another agent was moved onto `cursor-agent` per
   repository — measured, with a Codex user, and the reason the write is now
   first-wins on both fields (`applyPluginInitLocalAgentTool`). What is left is only
   the genuinely-empty config, where some tool has to be picked and this host's is
   the best available guess. Verifying the credential store still closes it.

2. ~~A logo is required for marketplace submission.~~ **Closed.** `plugin.json`
   declares `"logo": "./assets/logo.svg"`, the asset is committed at
   `plugins/jolli/assets/logo.svg`, and `PUBLISH_REQUIRED_CONFIG` lists it so a
   publish refuses if it ever goes missing. It is the same graph mark as
   `vscode/assets/icon.svg` — same geometry, same node fills — carrying the light
   variant's paler `#D9D5F8` edge, and translated into a square viewBox with ~10%
   margin since that master is 61x56 and every host renders a logo in a square. That
   edge/fill pairing exists in no other surface's icon, so this file is the vector
   record the Codex plugin's PNGs are exported from as well.

   The path is never read off disk, which is why the publish gate is the only local
   check possible. Measured on 3.15.x: a `logo` starting with `http` is used verbatim,
   and anything else is rewritten to
   `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<gitPath>/<logo>` — gitPath
   being the marketplace entry's `source` with its leading `./` stripped — then fetched
   at render time. Two consequences. The asset has to be committed to the PUBLISHED
   marketplace repo (`raw` serves `.svg` as `image/svg+xml`, so an `<img>` renders it);
   and a `publish-local.sh` install shows no logo at all, because a local directory has
   no git URL to resolve against — that is the expected result there, not a regression.
   The marketplace entry accepts a `logo` too, but the resolver prefers the manifest's
   and both resolve against the same gitPath, so a second copy would be a duplicated
   string with no path that reads it.

3. **Server-side client kind.** The bundle self-identifies as `cursor-plugin/<version>`
   via `__JOLLI_CLIENT_KIND__`. Add that kind to the server's allowlist before release,
   the same way `claude-plugin` and `codex-plugin` were.

4. ~~The README presents `/jolli-init` as repair rather than as step one.~~ **Closed.**
   Overtaken by the consent model: setting a repository up is now a normal, expected
   user action rather than a repair, `/jolli` is available from the first chat in any
   window, and the README's install section leads with it.

5. **How often does the provider timeout actually happen?** One machine, one day, no
   second data point yet. It does not block release — the design already assumes the
   hook may never run — but it decides whether this deserves a troubleshooting entry of
   its own in the README.

6. **Who can actually add this marketplace from GitHub?** Measured above: on a free
   account with no team, importing the public dev repository registered an entry and
   returned zero plugins, silently. If that is the general case for team-less users,
   then the README's headline instruction — add the repository as a marketplace — is
   dead for exactly the audience most likely to try the plugin first, and the real front
   door is Cursor's official marketplace listing (which needs the manual submission in
   item 2 anyway). The README now names the symptom and offers Import from Disk as the
   fallback, but a second account — one WITH a team — is what turns that from a hedge
   into a documented requirement. Test before release; it may change what the Install
   section leads with.

7. **The marketplace `name` must not collide with the Claude plugin's, and that is
   load-bearing rather than cosmetic.** Cursor pools every marketplace by manifest name
   into `~/.cursor/plugins/cache/<name>/` — and it also IMPORTS Claude plugins, caching
   them under THEIR marketplace's name in the same tree. Measured: a Claude plugin install
   produced `~/.cursor/plugins/cache/jolli-marketplace/jolli/1.0.3/`, right beside this
   bundle's namespace. Reusing `jolli-marketplace` here would put two different bundles in
   one directory. Now `jolli-cursor` (was `jolli-cursor-marketplace`, shortened because
   Cursor title-cases this name into the Customize section header, which read "Jolli
   Cursor Marketplace"). It keeps the word **Cursor**: both bundles' plugin cards read
   "Jolli Memory", so this header is the only thing distinguishing them, and installing
   the Claude one here yields skills and an MCP server that look healthy and capture
   nothing. **No longer an open question — `CursorPluginManifest.test.ts` pins it**,
   both directions (≠ the Claude and Codex names, and a lowercase slug so it is safe as a
   directory name). The prose above could not fail; the rename happened once with nothing
   checking it had not landed on the Claude name. The constraint still binds any FUTURE
   host bundle.

   One consequence for an existing install: the name IS the cache namespace and the
   identity Cursor lists the marketplace under, so a rename does not migrate. A 1.0.0
   install keeps pointing at the old identity and is simply told it is up to date — it
   never sees 1.0.1 or the twelve bundled skills. **That has to be user-visible, not just
   recorded here**, so the README carries an "Upgrading from 1.0.0" section with the only
   fix there is: remove the old marketplace in Customize and re-add it. The stale
   `~/.cursor/plugins/cache/jolli-cursor-marketplace/` directory is then orphaned and can
   be deleted.

   The rename was taken WITH that cost rather than reverted, on timing: 1.0.0 shipped on
   2026-08-15, so the install base is the smallest it will ever be, and if the shorter
   header is wanted at all this is the cheapest moment to pay for it. Sweeping the stale
   cache directory from the bootstrap was considered and rejected — it is a machine-global
   delete inside another product's cache, to save a step the README can just name. Do not
   rename this again without re-reading both halves: after this release the same change
   costs every install a manual re-add, with no signal that anything is wrong.

8. **An unrecognised key in `hooks.json` silently voids the WHOLE file.** Measured: a
   probe registering four documented events plus `activeBranchChange` — a string that
   appears in Cursor's bundle but is not a hook event — had **none** of its five hooks
   executed, and the plugin was simply absent from the executed-hooks log with no
   rejection message anywhere. The official reference does not say what happens for an
   invalid identifier, so the only guard is the allowlist in
   `CursorPluginManifest.test.ts`, taken from <https://cursor.com/docs/hooks>. Never add
   an event name from grepping the app bundle — that is exactly what produced the bad
   one. Left open because the allowlist is hand-maintained and Cursor may add events.

9. **Does the consent model belong on the other two hosts?** Cursor was changed alone,
   deliberately (it is unreleased, and its `workspaceOpen`-per-sidebar-repo behaviour
   makes auto-install reach the most repositories). But the underlying objection — that
   a session hook writes `.git/hooks/*` into whatever repository is open, unasked —
   applies to the Claude and Codex bootstraps unchanged. Worth a decision rather than
   drift; if they stay as they are, that should be a recorded choice.

## Publish

Same progression as the other two plugins, and `publish-prod.sh` pushes to a public
repository, so never run it speculatively.

```bash
bash cursor-plugin/scripts/publish-local.sh   # ~/.cursor/plugins/local/jolli
bash cursor-plugin/scripts/publish-dev.sh     # jolli-plugin-dev/jolli-cursor-plugin (no version guard)
bash cursor-plugin/scripts/publish-prod.sh    # jolliai/jolli-cursor-plugin
bash cursor-plugin/scripts/publish-zip.sh     # offline archive
```

Neither git target clones for you — `publish_git_repo` refuses a destination that is not
already a checkout, and its error prints the exact command. The two remotes:

```bash
git clone git@github.com:jolli-plugin-dev/jolli-cursor-plugin.git jolli-cursor-plugin-dev
git clone git@github.com:jolliai/jolli-cursor-plugin.git          jolli-cursor-plugin
```

Both live beside the monorepo, and the `-dev` suffix is on the DIRECTORY only: dev and
prod are the same repository name in two different orgs, so they cannot share a path.
That near-collision is what `publish_assert_origin` exists for. `publish_assert_safe_dest`
validates only the destination's *shape*, and after one mirror both checkouts look
identical to it — so a swapped positional argument or a stale `MARKETPLACE_REPO` used to
pass every check and push a rehearsal to the **public** release repo, while the README
(whose slug is passed in rather than derived) still named the intended target. The origin
check runs before the build, so a wrong target costs nothing and leaves the destination
untouched. A checkout with no origin at all passes deliberately — it cannot be the wrong
repository, and a local `git init` destination is a legitimate `NO_PUSH=1` dry run.

The SSH URL is derived from the slug (`publish_clone_url`), not stored next to it: the
slug already has to be right because `publish_readme_source` ships it to users, and a
second literal per target would be one more pair to keep in lockstep.

**The version guard applies to `publish-prod.sh` only**, and it is the reversed habit
worth knowing: a prod publish whose content changed stops unless `plugin.json`'s
version is **strictly higher** than the last release in that repository (bump it
first — the opposite of a local verdaccio rehearsal, where you republish the same
version). Strictly higher, not merely different: an equal version strands installed
users on "up to date", and a lower one does the same while still reading as a release.
`publish_version_gt` compares numeric components, so `1.0.10` correctly beats `1.0.9`,
and both operands must be exactly three numeric components — any other shape answers
"not greater" rather than being padded or truncated into a comparison it cannot make.

**`publish-dev.sh` skips it deliberately**, by passing `dev` as the third argument to
`publish_git_repo` (the only behavioural difference between the two scripts, and it is
printed, never silent). A rehearsal republishes the same build repeatedly, and bumping
per rehearsal is how the Claude dev marketplace ran to 1.0.5 while prod was on 1.0.1 —
after which the guard began refusing legitimate releases on the rehearsal target. The
cost: a same-version dev republish leaves the version-stamped copy in Cursor's
marketplace cache untouched, so testers must remove + re-add rather than update; and a
green dev run no longer proves prod will accept the version.

`JOLLI_PUBLISH_FORCE=1` overrides the safe-destination and version guards; use it only
for an intentional operation.

Both `LICENSE` copies are in `PUBLISH_REQUIRED_CONFIG`, so a mirror that drops one
fails the publish instead of shipping a bundle with no license text. They are listed
twice because two different units are distributed: the tree root (what a marketplace
reader receives) and `plugins/jolli/` (all that an install actually copies).

Cursor's **official** marketplace additionally requires a manual submission at
`cursor.com/marketplace/publish` and reviews every update, so `publish-prod.sh` makes
the repository ready for review rather than shipping to users itself. A Cursor **team**
marketplace points straight at a repository and updates as soon as the push lands.

The mirror runs `git -c core.excludesFile=/dev/null` deliberately: a developer's global
gitignore matching `SKILL.md` has silently dropped skills from a published plugin
before.

## Lockstep lists

Three lists describe `dist/` and must move together, or the failure is a **blocked
user commit** rather than a missing feature (a git hook resolving to
`node <missing file>` aborts the git operation):

- `entryPoints` / `EXPECTED_ENTRY_OUTS` in `plugins/jolli/scripts/build.mjs`
- `PUBLISH_REQUIRED_DIST` in `scripts/_publish-lib.sh`
- `REQUIRED_RUNTIME_FILES` in `cli/src/install/DistPathWriter.ts` (the 10 shared ones)

A third pair covers the branding asset: the `logo` in `plugins/jolli/.cursor-plugin/plugin.json`
and its `PUBLISH_REQUIRED_CONFIG` entry. `CursorPluginManifest.test.ts` derives the
second from the first rather than restating it, so the manifest owns the path and the
publish gate owns existence — a renamed or added asset cannot ship unchecked.

A parallel pair covers the skills — `CURSOR_PLUGIN_SKILL_NAMES` and
`PUBLISH_EXPECTED_SKILLS`, an exact set and never a glob, **twelve** entries. `jolli` is
one of them: nothing this plugin offers is written outside the bundle any more, so these
two lists are the complete inventory of what a user gets.

Two retired placements each left a list behind, and neither is a publish inventory:

- `CURSOR_RETIRED_MIRROR_SKILLS` (in `cli/src/install/SkillInstaller.ts`) — the four
  names the per-repo mirror used to plant, kept as the sweep's list of what to remove.
  Its old publish pair, `PUBLISH_EXPECTED_MIRROR`, is gone.
- `CURSOR_GLOBAL_SKILLS_DIR` (in `cli/src/install/CursorPluginSkills.ts`) — where the
  machine-global umbrella used to go, kept so `removeCursorGlobalMenu` can find that
  leftover.

A third pair covers the marketplace name: the `name` in `.cursor-plugin/marketplace.json`
is asserted to differ from the Claude and Codex bundles' (read from their own manifests,
not hard-coded) and to be a lowercase slug. That name is simultaneously the cache
namespace under `~/.cursor/plugins/cache/` and the source of the title-cased header
Cursor renders in Customize, so a collision or a stray capital fails silently in two
different ways.


## Detailed rationale (moved from AGENTS.md)

The full, measured version of the `AGENTS.md` Cursor-plugin critical rule (stop-hook source resolution, the two readers, the `allSessions` dedup, and the host-contract measurements). `AGENTS.md` keeps the enforceable summary.

### Cursor plugin host contract — full rules

- **The Cursor plugin is the Codex plugin's structural twin, and its host contract differs in five load-bearing ways.** `cursor-plugin/` ([`DEVELOPMENT.md`](DEVELOPMENT.md) carries the full table) is the same shape — own `dist/` bundling `cli/src/**`, own marketplace, publish-by-bash-script, no tests of its own — but the five differences below are each the kind that fails *silently*, so none may be "unified" with the other hosts: the manifest is `.cursor-plugin/plugin.json` and the marketplace `.cursor-plugin/marketplace.json`; the hook event is **camelCase** `sessionStart` (a PascalCase key is not an error, it is an event that never fires); `hooks.json` maps an event **straight to an array of `{command}`** with no intermediate `{hooks:[…]}` group; the plugin-root variable is `${CURSOR_PLUGIN_ROOT}` (Claude's and Codex's names are not aliases here, and an unexpanded variable fails every session); and the hook output envelope is **flat snake_case `{additional_context}`**, not `hookSpecificOutput.additionalContext` — the same class of mistake that shipped on Codex in the opposite direction, where every side effect landed and made the install look healthy while no briefing reached the model. `CursorPluginManifest.test.ts` pins all five.

  **Cursor DOES run plugin-declared hooks (measured), and the hook's cwd is the PLUGIN DIRECTORY.** A throwaway probe plugin on Cursor 3.15.6 saw `workspaceOpen`, `sessionStart`, `beforeSubmitPrompt` and `stop` all fire — so unlike codex-cli 0.146.0, whose plugin hooks never ran, this bootstrap actually reaches the user. Two consequences. First, `process.cwd()` is a **trap**, not a fallback: every plugin hook except `stop`/`subagentStop` runs with the bundle as its cwd (`pwd=~/.cursor/plugins/local/<plugin>` while `workspace_roots` named the real workspace), and a marketplace cache is often a real git checkout — so trusting cwd would install jolli's git hooks into the plugin's own repository. `resolveCursorProjectDir` therefore reads `workspace_roots` / `CURSOR_PROJECT_DIR` and returns **null** rather than accept a plugin-bundle cwd, sharing the predicate with the MCP server's guard via [`PluginBundlePaths.ts`](../cli/src/core/PluginBundlePaths.ts). Second, plugin hooks are cleared unless BOTH `thirdPartyExtensibilityEnabled` (user setting, defaults true) and the **server-side feature gate `enable_cc_plugin_import`** are on — a gate being off drops the hooks silently while the plugin's skills still load, which is the Codex failure shape through a different door. That is why the skills' `run-cli` fallback and `/jolli-init` must stay. Two further asymmetries are deliberate: this bundle keeps the canonical **`jolli-` prefix** on its skill directories where Codex drops it, and it ships **no `McpLauncher`** because its MCP entry is repo-scoped rather than a global `config.toml` write.

  **The prefix is measured, not a hedge — Cursor does NOT namespace plugin skills.** Read out of Cursor 3.14.7's own bundle: the invocation name is the **parent directory of `SKILL.md`** (`iBg` returns `split("/").at(-2)`), and the docs require frontmatter `name` to equal that folder; plugin skills share ONE flat pool with `.cursor/skills/`, `.agents/skills/`, `.claude/skills/`, `.codex/skills/` and their `~` variants, distinguished only by a brand **icon**; and the slash-menu de-duplicator keys on `(pluginDisplayName, skillName)`, so it collapses only the *same* plugin's duplicate while entries without plugin attribution are pushed unconditionally. Two plugins — or a plugin and the user's own skill — therefore coexist under the identical name with no suffix and no shadowing, which is exactly what a bare `/init` or `/status` would walk into. The agent-facing object carries no name field at all, so the model discovers a skill by description and identifies it by path. Four constraints follow and are pinned by `CursorPluginSkills.test.ts`: `name` is lowercase/digits/hyphens ≤64 and must equal the directory (a mismatch is silent — the menu invokes the *directory* name); `description` is required, ≤1024 per the docs and hard-truncated at 1536; `alwaysApply: true` would reclassify a skill as an always-injected **global rule**; and `metadata.surfaces` / `metadata.environments` / `metadata.scopedTo` are genuinely *read* by the loader, so a stray key there silently hides a skill — one more reason the generator strips the block. One consequence looks like it should drive what the bundle may contain, and the conclusion it once drove was WRONG: `.agents/skills/` is a **first-class** Cursor root, so a repo that also ran a full `jolli enable` gets a second, identically-named entry for every skill shipped under both — invisible on Codex, where the two land under different names, but distinguishable only by icon here. **That duplicate is now ACCEPTED and the bundle ships the COMPLETE set** — all twelve, the four host-neutral skills and the `jolli` umbrella included ([`CURSOR_PLUGIN_SKILLS`](../cli/src/install/CursorPluginSkills.ts)). Avoiding the duplicate was tried, as a per-repo mirror into `.cursor/skills/` written only when no other root supplied the name, and it optimised for the wrong user: the mirror was planted by the `sessionStart` bootstrap, whose opt-in gate (`isGitHookInstalled`) is false in a repo that has not been set up, so a **Cursor-only** user — this bundle's whole audience — got no `jolli-recall` and no `jolli-search` at all, absent from the store page and absent from the menu, until they happened to find `/jolli-init`. Four more silent failure modes came with it: symlinks resolved through a `cursor-plugin-root` record that a marketplace upgrade invalidates, a host-neutral reconcile that opened Cursor's private `state.vscdb` from every Claude and Codex session, `.git/info/exclude` upkeep for the planted paths, and a machine-global `/jolli` that any OTHER runtime would delete during that same upgrade window. A cosmetic duplicate paid only by multi-host users beats a functional hole for the single-host ones. **De-duplicating in the `.agents/` direction stays forbidden** for the unchanged reason: it is the only copy Codex, Gemini, OpenCode, Windsurf and Copilot have. What remains of the retired mechanism is a one-way sweep — [`removeCursorRepoSkills`](../cli/src/install/SkillInstaller.ts) plus `removeGitExcludePaths(CURSOR_RETIRED_SKILL_GIT_EXCLUDE_PATHS)`, on every install path and host-neutral, because a leftover symlink is a duplicate the bundle already supplies and a dangling one after an upgrade. It is ownership-guarded, so a user's own `.cursor/skills/jolli-recall` is neither overwritten nor deleted. The `/jolli` umbrella was the last name to join it — see the next paragraph for the measurements that retired its machine-global placement.

  **The umbrella is bundled too — the machine-global placement is RETIRED, and re-adding it is a review blocker.** Cursor's chat-first Agents Window delivers `sessionStart` with `workspace_roots: []` and `CURSOR_PROJECT_DIR: ""` **no matter which repository row started the conversation** (measured on 3.15.19), and nothing in that payload recovers the repo — `transcript_path` is null, and the `~/.cursor/projects/<repo>/agent-transcripts/<conversation_id>` mapping is not created until the conversation does work. That is why a PER-REPO front door is impossible, and for a while it was taken as a reason to write `jolli` MACHINE-GLOBAL to `~/.cursor/skills/jolli/` from the bootstrap. **Measured on 3.16.29, that inference was wrong twice over.** First, a bundled skill reaches that surface perfectly well: reading Cursor's own slash-menu cache (`agentData.cacheStorage.agentEnvironment.slashMenuItems.v6.local.glass.<ctx>`), all bundled skills appear in BOTH no-repository contexts — the `empty-window` one and the Agents Window's repo-less `Home` project — and `cursor.plugins.installedIds` recorded the install under its `no-workspace` key, so that store's per-workspace sharding is a warm-up cache (`_hydrateInstalledPluginIdsFromStorage` → `_maybeWarmMarketplacePluginsForCurrentContext`) and not a load gate. Second, the machine-global copy could not survive its own first install: **a freshly installed plugin's hooks are not registered until Cursor is FULLY restarted** — a window reload plus a new chat both left the hook unrun and `~/.jolli/jollimemory/debug.log` untouched — so every new install had every other skill and no front door, while `/jolli`'s Step 0 read the missing `run-cli` as "Jolli is no longer installed on this machine" and offered to `rm -rf` itself. The accepted cost of bundling it: `~/.cursor/skills/` is in Cursor's always-loaded group while `.cursor/plugins/` is gated behind `thirdPartyExtensibilityEnabled` plus the server-side `enable_cc_plugin_import`, so with a gate off the umbrella now goes with the other eleven instead of surviving alone — a state where MCP, hooks and every skill are gone anyway. What remains of the old placement is a one-way sweep: the bootstrap calls `removeCursorGlobalMenu` where it used to call `ensureCursorGlobalMenu`, and `UninstallScan`'s `scanCursorGlobalMenu` is the second route for a machine whose bootstrap never runs again. `buildCursorJolliSkillTemplate` keeps its `metadata:` block — stripped from the bundled render — solely because the `vendor` marker in it is what makes that leftover recognisable. Note the empty STRING: `resolveCursorProjectDir` rejects candidates by `trim().length === 0`, and a `??` there would pass `""` through. `publish-local.sh` also targets a *single-plugin* directory (`~/.cursor/plugins/local/jolli/`), not a marketplace, so it mirrors `plugins/jolli/` rather than the whole tree.

  **This host does NOT install into a repository on its own — the only one of the three that doesn't.** `runCursorPluginBootstrap` gates the whole `install()` call on `isGitHookInstalled(worktreeRoot)`; an un-opted-in repo gets no git hooks, no `.cursor/mcp.json` and no briefing. Note what it DOES still get, and why that matters: every skill, because they are bundled rather than written into the repo. That is the whole point of retiring the mirror — the capability no longer depends on a gate the fresh-repo case cannot pass. The reason is specific to Cursor: a `workspaceOpen` fires for EVERY repository listed in the sidebar at startup, so auto-install reaches repositories the user only browsed. Setting one up is `/jolli` → `jolli-init`, which the umbrella's Step 2 already routes to because `getStatus` derives `enabled` from the same `isGitHookInstalled` — gate and displayed state cannot disagree. **Maintenance is not opt-in**: an already-installed repo still reconciles every session, because an upgrade moves the version-stamped bundle and the git hooks, MCP entry and runtime registration all have to keep pointing at it. Do not "restore" auto-install here to match Claude and Codex without re-deciding it for all three (`cursor-plugin/DEVELOPMENT.md` open question 9). **And the gate is drawn around the WORKTREE, never around the machine** — widening it to `~/.jolli/` closes the loop this host's whole design rests on. Two actions stay unconditional, in `main()` ahead of any repository: the `removeCursorGlobalMenu` sweep of the retired machine-global umbrella, and `reconcileRuntimeRegistry` (the three dispatch scripts plus `dist-paths/cursor-plugin`, extracted from `install()` so the two callers cannot drift). A third, `cursor-plugin-root`, was retired with the mirror it existed to locate. Registering a runtime asserts "a runtime of this version lives here", not anything about a repository. Without it a plugin-only machine has no `run-cli`, and every documented route out is a fallback that shells it. That failure is REAL on a fresh install and not merely hypothetical, because this hook does not run at all until Cursor has been fully restarted once (measured): `/jolli` Step 0 finds neither an MCP tool (this bundle ships no `mcp.json`, and `.cursor/mcp.json` is written by the very install being deferred) nor the dispatcher. Its "dispatcher absent" branch therefore had to stop claiming Jolli was uninstalled — it now says to quit Cursor completely and reopen, which is the actual fix — and `/jolli-init`'s "reload so the sessionStart hook runs" is wrong for the same reason: a reload is not enough.

  **`dist-paths/<tag>` records a RUNTIME, not a host's bundle — do not reach for it to locate one.** Its slot is keyed by **source tag alone, never by directory**, deliberately, so a same-version reinstall at a new path (switching worktrees) still claims the slot instead of leaving hooks dispatching from a stale directory. So it records *the dist of whichever runtime most recently installed while claiming that tag*, which is not the same as "where that host's bundle is". The retired Cursor mirror learned this the hard way and needed a whole second record to work around it (`cursor-plugin-root`, written by the bootstrap from its own `import.meta.url`): measured, `/jolli-init` runs `run-cli enable --source-tag cursor-plugin`, `run-cli` resolves to the highest-version dist (cli wins a tie), the CLI correctly recorded its OWN dist under the `cursor-plugin` key, and `dirname(distDir)/mirror` came out as `<repo>/cli/mirror` — all four symlinks dangled and Cursor dropped the skills silently. Both the mirror and that record are gone; the lesson is not. Do NOT "fix" the registry by making it refuse a foreign runtime's write, which would re-open the stale-worktree bug it was repaired to remove — and do not re-introduce a bundle-location record without re-reading why the first one existed. One detail of the retired mechanism survives in `CURSOR_RETIRED_SKILL_GIT_EXCLUDE_PATHS`, which must keep its `/.cursor/skills/` entry alongside the per-skill ones: git reports an untracked DIRECTORY as one `?? .cursor/` line rather than descending, so an install that planted the mirror wrote both shapes and the sweep has to remove both.

  **An unrecognised event key in `hooks.json` silently voids the WHOLE file.** Measured: a probe registering four documented events plus `activeBranchChange` — a string that appears in Cursor's bundle but is not a hook event — had **none** of its five hooks run, with no rejection logged anywhere. Cursor's reference does not document the behaviour, so the allowlist in `CursorPluginManifest.test.ts` (taken from <https://cursor.com/docs/hooks>) is the only guard. Never add an event name from grepping the app bundle.

  **The `stop` hook is a capture path, and the ONE thing it must not get wrong is WHICH source.** [`CursorStopHook`](../cli/src/hooks/CursorStopHook.ts) does what Claude's `StopHook` does — `saveSession`, `recordSessionFromHook`, `discoverCursorConversations` — through those same functions, contributing no extraction logic of its own. Five real captures (IDE 3.16.29 ×3, cursor-agent 2026.08.11 ×2) settled what a probe was built to ask: `conversation_id` and `session_id` are both present, IDENTICAL, and equal the transcript UUID that BOTH discoverers index on; `transcript_path` is in the payload (and in `CURSOR_TRANSCRIPT_PATH`), so the bucket-probing locator is not needed on this path at all; and `workspace_roots[0]` / `CURSOR_PROJECT_DIR` / cwd were all the real workspace, 5/5. **cursor-agent DOES fire it** — only `cursor-agent -p` does not, which is why the scan paths stay. The hazard is that `cursor` and `cursor-cli` write the SAME transcript but are indexed by two DISJOINT discoverers (measured: 4 IDE + 6 CLI, zero overlap), and every downstream identity is `(source, sessionId)` — so a cursor-agent conversation recorded as `cursor` does not overwrite the discoverer's row, it sits BESIDE it, doubling that conversation's tokens and tool calls with nothing to flag it. `resolveCursorSource` therefore takes `CURSOR_INVOKED_AS === "cursor-agent"` first (race-free — nothing need be on disk yet) and falls back to probing `~/.cursor/chats/<hash>/<uuid>/`, the same index the CLI discoverer walks, so the two cannot disagree. It also honours `isGitHookInstalled`, for the reason the bootstrap does: a Cursor window opens for every repository in the sidebar, so chatting in a browsed-but-not-enabled repo must not create `.jolli/jollimemory/` in it. And it deliberately IGNORES the payload's `input_tokens`/`output_tokens`/`model`, which are per-GENERATION (one measured at 199,933 input, i.e. the whole context) while `session_model_usage` and `session_tool_use` are replaced WHOLESALE per session — a turn's numbers would overwrite the session's totals, and summing them would multiply the context by the turn count.

  **Two Cursor readers, chosen by PATH SHAPE, and a bare `readCursorTranscript` call is a review blocker.** `upgradeToJsonlTranscripts` points an IDE composer at its `agent-transcripts` JSONL whenever one exists (measured: 4 of 4 composers on a real machine), and that path has no `#composerId`, so the composer-store reader's `parseSyntheticPath` THROWS on it. Both call sites that bypassed `readTranscriptForSource`'s dispatch swallowed that throw into a silent nothing — `QueueWorker` logged "Skipping Cursor session" and dropped the conversation from the commit summary, `TranscriptLoader` degraded to an empty transcript for IntelliJ's detail pane. Neither can simply CALL `readTranscriptForSource` (it takes no `beforeTimestamp`, and the per-commit cutoff is what decides which turns belong to this commit), so they share its predicate — `isCursorJsonlTranscript` — instead of restating the rule.

  **`allSessions` in `QueueWorker` is deduped on `(source, sessionId)`, and removing that is a review blocker.** Everything feeding it is a plain concat — the hook-written registry plus one array per discoverer — which was safe only while no source could arrive by two routes at once. A hook-poor source that gains a lifecycle hook has exactly that shape, and reading a conversation twice is never a partial error: `readAllTranscripts` re-reads from the SAME on-disk cursor (the new positions are `pendingCursors`, persisted only after the store), so `perSessionTokens` accumulates the identical slice and the overlay reconciliation cannot notice because its pre/post counts double together.
