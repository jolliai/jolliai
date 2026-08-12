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
│   ├── hooks/hooks.json                     # one sessionStart bootstrap
│   ├── skills/<name>/SKILL.md               # 6 committed static files (generated)
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

Four builders (`recall`, `search`, `local-run`, `remote-run`) serve the Claude and
Codex bundles as committed files, so editing one is an edit to those two artifacts plus
the installed copy: bump the revision + fingerprint for `.agents/skills/` AND regenerate
both plugins' bundled copies. **This bundle is not among them** — it ships none of those
four (see "The duplicate-entry problem" below); Cursor gets them from `.agents/skills/`
or from the `.cursor/skills/` mirror, both written at runtime from the same builders, so
no regeneration step here.

## What differs from the Codex plugin

| | codex-plugin | cursor-plugin |
|---|---|---|
| Manifest | `.codex-plugin/plugin.json` | `.cursor-plugin/plugin.json` |
| Marketplace | `.agents/plugins/marketplace.json` | `.cursor-plugin/marketplace.json` |
| Marketplace `name` | `jolli-marketplace` | `jolli-cursor-marketplace` (must differ) |
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
| `alwaysApply: true` | reclassifies the skill as a **global rule**, injected into every session. Never set it here — seven long documents in every context. |
| `disable-model-invocation: true` | makes the skill explicit-invocation only. Cursor's own `create-skill` recommends defaulting to it; Jolli's skills deliberately stay model-invocable, since recall/search must trigger from ambient context. |
| `paths` / `globs` | interchangeable — the loader reads `data.paths ?? data.globs` — and scope the skill to matching files. |
| `metadata.*` | genuinely read, not just tolerated, and the mechanism is worth stating exactly because it is tempting to misuse. The frontmatter parser (`qVv`) explicitly handles `metadata.environments` and `metadata.disabledEnvironments`; `q5u(skill, env)` then decides visibility — `disabledEnvironments` containing `env` hides the skill, and a **non-empty** `environments` that does not contain `env` hides it too. **`env` is a RUNTIME mode, not a host**: the only values observed are `"cloud"` and `"auto"` (`q5u(e,"cloud")`), so this cannot express "hide this from Cursor but not from Codex". Declaring `environments` with any value Cursor never uses therefore hides the skill from **every** environment — that is the real mechanism behind "a stray key silently hides a skill", and it is one more reason the generator strips the block. Do not reach for it as a de-duplication trick: the other hosts do not read these keys today, but if any of them starts to, the skill disappears everywhere at once. |

### The duplicate-entry problem, and where the mirror lives

`.agents/skills/` is a **first-class** Cursor skill root. So a repo that ran a full
`jolli enable` already has `/jolli-recall` in Cursor from `.agents/skills/`, and a
bundled copy under the identical name is a **second entry** that `rBg` will not
collapse — the `.agents/` copy has no plugin attribution, so it is pushed
unconditionally. On Codex the same duplication is invisible because the two land under
*different* names (`jolli:recall` vs `jolli-recall`); here they differ only by a brand
icon.

Shipped whole, the overlap was **five** entries, not four: `jolli`, `jolli-recall`,
`jolli-search`, `jolli-local-run`, `jolli-remote-run`. The umbrella is easy to miss —
the CLI writes `.agents/skills/jolli` too.

**Resolution: the bundle ships only what exists nowhere else; the four that can collide
are mirrored per repo; the umbrella is machine-global.**

```
bundle (6)   jolli-init  jolli-login  jolli-logout
             jolli-push  jolli-status  jolli-timeline

mirrored (4) jolli-recall  jolli-search  jolli-local-run  jolli-remote-run
             → <repo>/.cursor/skills/<name>/, written ONLY when no root Cursor
               reads already provides it, and removed again once one does

global (1)   jolli
             → ~/.cursor/skills/jolli/, written every session, repo or not
```

**The umbrella is the exception, and it is the one entry whose duplicate is ACCEPTED.**
It is bound to `buildCursorJolliSkillTemplate`, not to the entry `SKILLS` registers: the
two are not the same document — the host-neutral menu the CLI writes to
`.agents/skills/jolli`, versus the state-aware Cursor variant that reads `status` and
leads a half-configured repo into setup.

It is not mirrored per repo because the surface that most needs a front door — Cursor's
chat-first Agents Window — never names a repository, so a per-repo copy can never reach
it (see "The Agents Window names no repository, ever"). Machine-global it is, and in a
repo that also ran `jolli enable` that means two `/jolli` entries. Deliberate: a
duplicate is two working front doors, while pruning it from both places is a missing
front door with nothing on screen to explain the absence.

### Finding the bundle: `cursor-plugin-root`, and why `dist-paths` cannot answer

The four mirrored skills are symlinks INTO the bundle, so planting one requires knowing
where the bundle is. That question has exactly one authoritative answer — **the running
module's own path, when the code is running from inside the bundle**. esbuild rewrites
`import.meta.url` to the bundle's own file, so the bootstrap resolves
`<bundle>/dist/CursorPluginBootstrapHook.js` up two levels and finds `mirror/` beside
`dist/`. Nothing else on the machine knows.

So the bootstrap **records** it, every session, to
`~/.jolli/jollimemory/cursor-plugin-root` — one absolute path, plain text, the same
shape as the `node-path` sibling. `cursorPluginMirrorDir()` reads that record and
**verifies `<root>/mirror` still exists** before using it.

**`dist-paths/cursor-plugin` was the original source and it is the wrong question.**
That registry slot is keyed by SOURCE TAG ALONE, never by directory — a deliberate
property (see the `wt-dist-path-repair` decision) so that a same-version reinstall at a
new path, such as switching worktrees, still claims the slot instead of leaving hooks
dispatching from a stale directory. What it records is therefore *"the dist of whichever
runtime most recently installed while claiming this tag"*, which is not *"where that
host's bundle is"*. Measured: `/jolli-init` runs
`run-cli enable --repo-hooks-only --source-tag cursor-plugin`, `run-cli` resolves to the
highest-version dist (the CLI wins a version tie via `SOURCE_PREFERENCE_ORDER`), and the
CLI correctly recorded its OWN dist under the `cursor-plugin` key — so
`dirname(distDir)/mirror` came out as `<repo>/cli/mirror`, which does not exist. All four
links dangled and Cursor dropped the skills with no error anywhere. **Do not "fix" this
by making the registry refuse a foreign runtime's write** — that re-introduces the stale
worktree bug the registry was repaired to remove.

Two properties fall out and both are load-bearing:

- **The existence check is what notices an uninstall.** The record lives under
  `~/.jolli/`, which Cursor's plugin manager never touches, so it outlives the bundle.
  Its target vanishing is the signal; a resolver that trusted the recorded path would
  keep planting links into a directory that is gone.
- **The timing works because the bootstrap always precedes `/jolli-init`.**
  `sessionStart` fires before the user can type, so by the time anyone invokes the setup
  skill the record is already there — which is what lets a CLI-dispatched init plant the
  links correctly in the same pass rather than leaving the user to open another chat.

That works only because the generic menu learned to route to whatever skills the
session actually has (`revision` 7). It used to hardcode four actions, so on a host
with a plugin installed it could not route to `jolli-init`, `jolli-status`,
`jolli-push` and the rest even though they were sitting right there. Its own MCP
section had said "whatever is registered this session" all along; the skill list is now
worded the same way. That asymmetry was a defect on Codex and Claude Code too, so
fixing it widened the front door on every host.

**Which roots count as "already provides it".** Read out of the provider
(`extensions/cursor-agent-exec/dist/main.js`), which classifies every discovered
`SKILL.md` by path and matches with `includes` rather than `startsWith` — so the `~`
variants count as much as the repo-level ones:

```
always-on   <repo>/.agents/skills/    ~/.agents/skills/
gated       <repo>/.claude/skills/    ~/.claude/skills/
            <repo>/.codex/skills/     ~/.codex/skills/
```

The gated group is only loaded while `thirdPartyExtensibilityEnabled` is on, so
[`CursorSettings`](../cli/src/install/CursorSettings.ts) reads it — with the toggle off
a copy there is invisible, and treating it as "already provided" would leave the user
with nothing. Checking only `.agents/` left a real hole:
`.claude/skills/jolli-recall` from a pre-upgrade `jolli enable` is cleaned up by
`removeClaudeLegacySkills`, which runs only from the CLAUDE plugin bootstrap — a
Cursor-only user never reaches it. `.claude/plugins/` and `.cursor/plugins/` are
deliberately NOT probed: the Claude plugin's skill directories are bare (`recall`,
`search`, `push`) and never collide with `jolli-recall`, and `.cursor/plugins/` is our
own bundle.

Ownership is not consulted when probing. The goal is one entry per name in a flat menu,
and a user's own `~/.claude/skills/jolli-recall` occupies that name just as completely —
theirs is the one they chose.

[`reconcileCursorRepoSkills`](../cli/src/install/SkillInstaller.ts) runs from the
bootstrap's `install(..., { repoHooksOnly: true })` on every session start.

**Why `.cursor/skills/` and not somewhere else.** Two properties, both load-bearing:

- **Per-repo**, the same granularity as the thing it mirrors. The obvious alternative —
  delete the *bundle's* copy when `.agents/` has one — fails here: the bundle is
  machine-global, so one repo's reconcile would strip the skill from every other repo,
  and two windows open on differently-configured repos would fight over it.
- **Read by no other host.** Writing and deleting it cannot take away the only copy
  Codex, Gemini, OpenCode, Windsurf and Copilot have. That is exactly why the reverse
  direction — de-duplicating by deleting from `.agents/` — stays forbidden, and it is
  the same property that lets the Claude plugin delete `.claude/skills/jolli-*`.

Both directions are ownership-guarded (`vendor: "jolli.ai"`), so a user's own
`.cursor/skills/jolli-recall` is neither overwritten nor deleted. The exclude paths are
registered unconditionally, whether or not the copies are currently written: the set is
merged as a union and an exclude line for an absent path is inert, so the block does not
flap as `.agents/` comes and goes.

**`jolli-init` stays in the bundle, and it is now the ONLY thing standing between a
user and a dead end.** The reconcile runs from the `sessionStart` hook, which is
measured to fail silently and completely (see "The failure mode that actually bit"
below) — and which, even when perfectly healthy, does not fire until the user starts a
new conversation (see the next section). On such an install nothing has been mirrored,
so `/jolli` does not exist either. Typing `jolli` still prefix-matches `jolli-init`,
which is the manual route back: it runs `enable --repo-hooks-only`, which performs the
same reconcile. Removing it from the bundle would leave that user with no reachable
Jolli anything, so its presence is pinned by a test — as is the umbrella's ABSENCE, so
nobody restores the duplicate by adding it back.

### The Agents Window names no repository, ever — and why `/jolli` is machine-global

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

1. **`/jolli` is written machine-global to `~/.cursor/skills/jolli/`**, by
   `ensureCursorGlobalMenu`, on every session with or without a repository. A per-repo
   front door cannot reach the surface that most needs one. The cost is one duplicate
   `/jolli` in a repo that also ran `jolli enable`; the alternative is no front door and
   nothing on screen explaining why, which is exactly the state this whole
   investigation started from.
2. **The bootstrap installs nothing into a repository that has not opted in.** Not
   because it cannot — in a workspace-bound window it could — but because it should not:
   a `workspaceOpen` fires for EVERY repository in the sidebar at startup, so
   auto-install reaches repositories the user only browsed. See the consent gate below.

Pinned by `CursorPluginSkills.test.ts`, `CursorPluginManifest.test.ts`,
`SkillInstaller.test.ts` (`ensureCursorGlobalMenu` needs no repo, is idempotent, spares
a user's own file; the reconcile never plants the umbrella per repo) and
`CursorPluginBootstrapHook.test.ts` (the consent gate's four cases).

### The consent gate — this host does not install on its own

`runCursorPluginBootstrap` gates the whole `install()` call on
`isGitHookInstalled(worktreeRoot)`. An un-opted-in repository gets **nothing**: no git
hooks, no `.cursor/mcp.json`, no mirrored skills, and no briefing either.

**The gate is drawn around the WORKTREE, not around the machine.** Three writes stay
unconditional, and all three are in `~/`: the `/jolli` umbrella, the
`cursor-plugin-root` record, and the runtime registry — the three dispatch scripts plus
`dist-paths/cursor-plugin`, via `reconcileRuntimeRegistry`. Drawing the gate around
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

2. **A logo is required for marketplace submission.** `plugin.json` carries no `logo`
   yet; Cursor's submission checklist wants one committed to the repo and referenced by
   a relative path (`assets/logo.svg`). Add the real brand asset — do not ship a
   placeholder, and add `plugins/jolli/assets/logo.svg` to `PUBLISH_REQUIRED_CONFIG`
   when you do.

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

7. **The marketplace `name` must not collide with the Claude plugin's, and that is now
   load-bearing rather than cosmetic.** Settled for this bundle (`jolli-cursor-marketplace`,
   verified to produce a separate `~/.cursor/plugins/cache/` namespace), and the reasoning
   is under "What differs from the Codex plugin". Listed here because the constraint binds
   any FUTURE host bundle too: Cursor pools every marketplace by manifest name, so a
   fourth plugin reusing `jolli-marketplace` would re-open the same shared-cache bug.

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

A parallel pair covers the skills — `CURSOR_PLUGIN_SKILL_NAMES` and
`PUBLISH_EXPECTED_SKILLS`, an exact set and never a glob — and a second pair covers the
symlink targets: `CURSOR_MIRROR_SKILLS` (in `cli/src/install/SkillInstaller.ts`) and
`PUBLISH_EXPECTED_MIRROR`. **`jolli` belongs to neither.** The umbrella is written
machine-global at runtime by `ensureCursorGlobalMenu`, so adding it back to either list
would ship a second `/jolli` into every repo that opted in.
