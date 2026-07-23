# Jolli Memory Claude Code plugin — development

How to build, test locally, distribute, and release this plugin. For the
end-user install and the list of what the plugin provides, see
[README.md](README.md).

This is the **consumption + bootstrap** surface. The memory *generation* engine
runs in git hooks (`post-commit` → QueueWorker → LLM), which the Claude Code
plugin model does not cover — so the plugin's `SessionStart` hook shells the
bundled CLI to install those git hooks into the active repo (idempotent).

## Layout

```
claude-plugin/
├── .claude-plugin/marketplace.json     # the marketplace (lists the plugin)
└── plugins/jolli/
    ├── .claude-plugin/plugin.json      # plugin manifest
    ├── .mcp.json                       # jolli MCP server (node dist/Cli.js mcp)
    ├── hooks/hooks.json                # Stop + SessionStart (+ git-hook bootstrap)
    ├── skills/                         # /jolli:recall  /jolli:search  /jolli:push
    ├── commands/                       # /jolli:init  /jolli:status  /jolli:timeline  /jolli:login  /jolli:logout
    ├── agents/                         # jolli:pr-writer subagent
    ├── scripts/build.mjs               # esbuild → dist/ (Cli, Stop/SessionStart hooks, 5 git hooks, 2 workers)
    └── dist/                           # built bundles (gitignored)
```

## Build (bundle the CLI into the plugin)

The plugin is self-contained: `scripts/build.mjs` reuses the same esbuild
approach as `vscode/esbuild.config.mjs` to inline `cli/src/**` into
`plugins/jolli/dist/`.

**Prerequisite — run `npm install` at the repo root first.** The plugin has no
`node_modules` of its own, and neither `build.mjs` nor `publish-local.sh` installs
for you. `esbuild` itself is declared only in the `vscode` workspace and is
**hoisted to the repo-root `node_modules`**; the CLI runtime deps esbuild bundles
(commander, Orama, …) are hoisted there too. On a fresh clone that hasn't been
installed, the very first line of the build — `import … from "esbuild"` — fails
with `Cannot find package 'esbuild'`. So the order is always install → build:

```bash
npm install                                             # repo root, once
node claude-plugin/plugins/jolli/scripts/build.mjs      # emit plugins/jolli/dist/
# or, while iterating:
node claude-plugin/plugins/jolli/scripts/build.mjs --watch
```

(`build.mjs`'s `nodePaths` lists `cli/node_modules` first and the repo root
`node_modules` as fallback — in a hoisted workspace the deps actually resolve from
the root.) The bundle self-identifies on the wire as `claude-plugin/<version>` —
add that client kind to the server allowlist before release, the same way
`vscode-plugin` is handled.

## Local testing

First run `npm install` at the repo root — every path below needs it (see
[Build](#build-bundle-the-cli-into-the-plugin)). Then two independent decisions:
**which plugin tree** Claude Code reads, and **how** you point it there. (For the
direct in-repo options you also build `dist/` yourself; `publish-local.sh` builds
it for you.)

**Which tree — prefer the `publish-local.sh` mirror.** The most faithful local
test exercises the same build → mirror pipeline colleagues install from. Running

```bash
bash claude-plugin/scripts/publish-local.sh
```

builds `dist/` and rsyncs a **clean** copy of the plugin (no dev-only `scripts/`,
no `DEVELOPMENT.md`) into a plain, git-free directory —
`../claude-plugin-marketplace-local` by default — that you then
`/plugin marketplace add`. It's the exact flow of `publish-dev.sh` /
`publish-prod.sh` minus git, so "works locally" matches "works when installed."
Re-run it after each change, then `/plugin marketplace update jolli-marketplace`
in the session. See [Publish scripts](#publish-scripts) for the whole set.

You *can* instead point a loader straight at the in-repo `claude-plugin/`
directory — faster for a tight edit loop, but that tree still carries the dev-only
`scripts/` and docs, and you must have built `dist/` yourself
(`node claude-plugin/plugins/jolli/scripts/build.mjs`, which emits
`plugins/jolli/dist/`). In that case the `/plugin marketplace add` path is the
**in-repo `claude-plugin/` folder** — the marketplace directory that holds
`.claude-plugin/marketplace.json` — as an absolute path, e.g.:

```
/plugin marketplace add /abs/path/to/jolliai/claude-plugin
```

**Not** `claude-plugin/plugins/jolli` — that's the *plugin* directory
(`--plugin-dir` / desktop "Upload plugin" only). `marketplace.json`'s
`"source": "./plugins/jolli"` resolves to the freshly-built `plugins/jolli/` for
you. Fine for quick iteration; use the `publish-local.sh` mirror for a true
pre-push rehearsal.

Whichever tree you use, four loading mechanisms differ in whether you type slash
commands, whether the choice persists, and — importantly — **which directory the
path points at**:

- **marketplace directory** = the tree root holding `.claude-plugin/marketplace.json`
  (in-repo: `claude-plugin/`; mirror: `../claude-plugin-marketplace-local`)
- **plugin directory** = `<tree>/plugins/jolli/` (holds `.claude-plugin/plugin.json`)

Getting these two mixed up is the most common mistake.

### Option 1 — interactive `/plugin` commands

```
# the marketplace dir — in-repo: <repo>/claude-plugin ; mirror: ../claude-plugin-marketplace-local
/plugin marketplace add /abs/path/to/claude-plugin
/plugin install jolli@jolli-marketplace
/reload-plugins          # after rebuilding dist/
```

Use an **absolute path** for `marketplace add` — the app's working directory is
not necessarily the repo root, so a relative `./claude-plugin` may not resolve.
`marketplace add` takes the **marketplace directory**.

### Option 2 — `settings.json` (no slash commands; persists; team-shareable)

Declare the marketplace and enable the plugin in settings, and Claude Code loads
it automatically on startup — no `/plugin` commands. This is the recommended way
for the **desktop app** (a GUI can't take a launch flag). Add to one of:

- `~/.claude/settings.json` — user-level, applies everywhere.
- `<repo>/.claude/settings.json` — project-level, checked in, shared with teammates.
- `<repo>/.claude/settings.local.json` — personal override, normally gitignored —
  **best for local testing without touching the repo.**

```json
{
	"extraKnownMarketplaces": {
		"jolli-marketplace": {
			"source": { "source": "directory", "path": "/abs/path/to/claude-plugin" }
		}
	},
	"enabledPlugins": {
		"jolli@jolli-marketplace": true
	}
}
```

- `source.path` points at the **marketplace directory** — same target as Option
  1's `marketplace add`. In a project-level settings file a repo-relative path
  such as `"./claude-plugin"` also works.
- `enabledPlugins` keys are `<plugin>@<marketplace>` → here `jolli@jolli-marketplace`.
- Settings scope precedence, low → high: user → project → local → managed.
- Restart the session (or `/reload-plugins`) to pick up changes.

### Option 3 — `--plugin-dir` launch flag (terminal `claude` only; single session)

The fastest throwaway side-load. Loads and auto-enables the plugin **for that
session only** — no marketplace, no enable step:

```bash
claude --plugin-dir /abs/path/to/claude-plugin/plugins/jolli
```

- The path here is the **plugin directory** — **not** the marketplace root that
  Options 1 and 2 use.
- Repeatable: `--plugin-dir A --plugin-dir B`.
- Terminal `claude` executable only; the desktop app has no launch flag — use
  Option 2 or 4 there.
- Caveat: the official CLI reference doesn't spell out the plugin-dir vs
  marketplace-dir distinction, but its "load **a plugin** … for this session"
  wording indicates a plugin-level path.

### Option 4 — desktop app GUI buttons

The desktop app exposes **Add marketplace** and **Upload plugin** buttons in its
plugin settings. These are **not covered by the official docs yet**, so treat the
following as inferred-and-verify (confirm the field behavior in the UI):

- **Add marketplace** — GUI equivalent of Option 1. Point it at the **marketplace
  directory** `/abs/path/to/claude-plugin`. Registering the marketplace does not
  enable the plugin — enable **Jolli Memory** afterward under **Manage plugins**.
  Best for iterating: it references the local directory, so rebuild `dist/` and
  reload — no re-packaging.
- **Upload plugin** — a single-plugin side-load (akin to `--plugin-dir`). Point it
  at the **plugin directory** `/abs/path/to/claude-plugin/plugins/jolli` —
  one level deeper than Add marketplace. If it accepts only a `.zip`, the
  archive's top level must be the plugin **folder** `jolli/` (so `plugin.json`
  sits at `jolli/.claude-plugin/plugin.json`), and it must include the built
  `dist/`. A flattened zip with `plugin.json` at the archive root is silently
  rejected. Just run `bash claude-plugin/scripts/publish-zip.sh` — it builds
  `dist/` and produces a correctly-laid-out zip. An uploaded zip is a frozen snapshot —
  you re-zip on every change, so prefer Add marketplace for iteration.

Whichever option you use, the MCP tools, `/jolli:*` skills/commands, and the
hooks are then live.

## Publish scripts

All four scripts live in `claude-plugin/scripts/` and share `_publish-lib.sh`, so
every one **builds `dist/` first and asserts the bundle is complete** — a missing
git-hook or worker script would resolve to `node <missing file>` at commit time
and BLOCK the installing user's commits — before doing anything else. That shared
build+sync core is exactly why a prod release behaves the same as the local and
dev rehearsals that preceded it.

| Script | Produces | Git | Version guard | Reach for it when |
|--------|----------|-----|---------------|-------------------|
| `publish-local.sh` | `../claude-plugin-marketplace-local` (plain dir) | no | no | Local end-to-end test **before any push** — `/plugin marketplace add <dir>`. The recommended local-testing path. |
| `publish-dev.sh` | `../claude-plugin-marketplace` (private repo) | commit + push | yes | **Dry-run** a release into the internal marketplace to rehearse it before it goes public. |
| `publish-prod.sh` | `../jolli-claude-plugin` (public repo) | commit + push | yes | The real **public release** users install with `/plugin marketplace add jolliai/jolli-claude-plugin`. |
| `publish-zip.sh` | `~/Desktop/jolli-plugin.zip` | no | no | A snapshot **zip for the desktop app's "Upload plugin"** button (see Local testing, Option 4). |

Shared knobs:

- **`NO_PUSH=1`** (git scripts) — commit into the target repo but don't push, so you can
  inspect the diff first.
- **`JOLLI_PUBLISH_FORCE=1`** — allow a same-version republish (skips the version guard),
  and bypass the safe-destination check the first time you re-target a directory.
- **Custom target** — pass a path argument, or set `MARKETPLACE_REPO=/path` (`MARKETPLACE_LOCAL`
  for `publish-local.sh`; `publish-zip.sh` takes the output path as its argument).

**`publish-dev.sh` and `publish-prod.sh` are the same flow** (`publish_git_repo` in
`_publish-lib.sh`) and differ *only* in the default target repo, so a prod release can never
behave differently from the dev dry-run that rehearsed it. Both **refuse a same-version
republish**: Claude Code's `/plugin update` compares `plugin.json` `version`, so re-publishing
changed bytes under an unchanged version would leave installed users stuck on "up to date" and
they'd never pull the fix. Bump `version` in
[`plugins/jolli/.claude-plugin/plugin.json`](plugins/jolli/.claude-plugin/plugin.json) before a
dev/prod release (a tripped guard reverts the synced changes back to `HEAD` for you). The two
local artifacts — `publish-local.sh` and `publish-zip.sh` — have no version guard because they're
throwaway.

Typical progression: **`publish-local.sh`** (verify on your machine) → **`publish-dev.sh`**
(rehearse the git release into the private repo) → **`publish-prod.sh`** (ship to the public
marketplace). `publish-zip.sh` is an independent side-channel for the desktop app, not part of
that chain.

## Distribution (npm)

The plugin ships as an npm package (e.g. `@jolli.ai/claude-plugin`) whose tarball
must include **every runtime file the plugin loads**, not just the build output.
There is no publishing `package.json` here yet; when you add one, a
`prepublishOnly` should run `build.mjs`, and the `files` whitelist must list all of:

- `dist/` — bundled `Cli.js`, the Stop/SessionStart hooks, the five git hooks
  (`PostCommitHook.js` / `PostMergeHook.js` / `PostRewriteHook.js` /
  `PrepareMsgHook.js` / `PrePushHook.js`), and the `QueueWorker.js` /
  `PrePushWorker.js` workers. Omitting any git-hook or worker file turns the
  corresponding git hook into `node <missing file>` and BLOCKS the commit.
- `.claude-plugin/plugin.json` — the manifest.
- `.mcp.json` — the MCP server registration; without it the 10 MCP tools never load.
- `hooks/`, `skills/`, `commands/`, `agents/` — the Stop/SessionStart hooks, the
  `/jolli:*` skills and commands, and the `jolli:pr-writer` subagent.

> ⚠️ **`files: ["dist"]` alone ships a broken plugin** — `dist/` is only the bundled
> CLI; the manifest, `.mcp.json`, hooks, skills, commands, and agent all live outside
> it. Two of these are also `.gitignore`-sensitive: `.mcp.json` is caught by the repo
> root's broad `.mcp.json` rule and `skills/**/SKILL.md` by a global `SKILL.md` rule,
> so both are re-included via `!`-exceptions in the repo root `.gitignore`. Keep those
> exceptions, and mirror the **same full set** in the npm `files` whitelist.

The marketplace entry points at it with an `npm` source:

```json
{ "name": "jolli", "source": { "source": "npm", "package": "@jolli.ai/claude-plugin" } }
```

On install, Claude Code runs `npm install` internally to fetch and extract the
package into `~/.claude/plugins/cache/…`. The end user needs neither npm on PATH
nor registry auth for a public package; the bundled `dist/Cli.js` is present
after extraction. (A Node-free install would mean shipping a standalone compiled
binary — Node SEA / bun / pkg — per platform, deliberately out of scope for now;
`node` itself stays a hard requirement, see [`McpRegistration.ts`](../cli/src/install/McpRegistration.ts).)

`git-subdir` distribution was rejected: it serves only committed files, but
`dist/` is a gitignored build artifact (repo policy — the root `.gitignore`
ignores `**/dist/`), so a git-subdir clone would arrive without the bundled
`Cli.js`. npm carries the artifact in the tarball instead.

**Marketplace hosting.** `/plugin marketplace add owner/repo` only looks for
`.claude-plugin/marketplace.json` at the repo **root**, so the catalog cannot
live in this monorepo subdir as-is. It is hosted as a dedicated, single-purpose
marketplace repo that mirrors the `claude-plugin/` tree (manifest at the root,
plugin under `plugins/jolli/`, including the built `dist/`) — never hand-edited,
regenerated on every release. Two such repos exist:

- **Public** — `jolliai/jolli-claude-plugin`, the community-marketplace sync
  source. Users run `/plugin marketplace add jolliai/jolli-claude-plugin`. This
  repo keeps its own root `LICENSE`, which the publish sync preserves.
- **Private / internal** — `../claude-plugin-marketplace`, a dry-run target for
  rehearsing a release before it goes public.

Populate them from this monorepo with the [publish scripts](#publish-scripts):
`publish-prod.sh` targets the public repo, `publish-dev.sh` the private dry-run
repo. Both build `dist/` first, mirror the tree, then commit + push — see that
section for the version guard, the `NO_PUSH` / `JOLLI_PUBLISH_FORCE` knobs, and
why the two share one flow.

## Versioning & releases

The plugin is a **third CLI-bundling surface** alongside the VS Code extension,
and it follows the same rule the repo already applies to VS Code: **bundling
surfaces version and release independently — they are NOT locked to the CLI's
release cadence.**

- **Independent version & release track.** The plugin carries its own semver (in
  `plugin.json` / its npm package) and its own release tag. A CLI hotfix does
  not require a plugin release, and vice versa — exactly as `release-cli-v` and
  `release-vscode-v` are independent today (see `RELEASE.md` / `CLAUDE.md`: "CLI
  and VS Code versions are independent").

- **The only real coupling is a build-time snapshot, not a release lock.**
  `build.mjs` inlines a snapshot of `cli/src/**` frozen at build time (same as
  the VS Code extension). To ship a CLI change to plugin users you rebuild and
  republish the plugin; until you do, the plugin keeps serving its bundled
  snapshot — it lags, it does not break. (`RELEASE.md` already documents this for
  VS Code: rebuild the CLI before packaging because the bundle inlines it.)

- **The plugin soft-prefers its own dist, but competes on version.** The plugin's
  CLI commands (`init`/`login`/`logout`/`recall`/`search`/`status`) set
  `JOLLI_DIST_PREFER_SOURCE=claude-plugin`, so `resolve-dist-path` picks the
  `dist-paths/claude-plugin` entry when it is present, complete, and already at the
  top version — winning a version **tie** ahead of the global cli/vscode/cursor
  order. But a strictly-higher-version vscode/cli dist still wins, and a missing /
  incomplete / older plugin dist falls through to normal cross-source selection
  (never a hard fail — the former `JOLLI_DIST_SOURCE` hard pin is gone; all sources
  compete now). The plugin MCP server launches its own bundle directly; the
  manifest registers only `PluginBootstrapHook`, which installs canonical
  source-neutral Stop/SessionStart hooks through the shared `run-hook`
  dispatcher. The `dist-paths/<source>` core version
  (`__CLI_PKG_VERSION__`, injected by `build.mjs` from `cli/package.json`) drives
  cross-source selection for every surface; the plugin's marketing version is
  irrelevant — no lockstep check between `plugin.json` and `cli/package.json` is
  needed. See the soft prefer in
  [`DispatchScripts.ts`](../cli/src/install/DispatchScripts.ts) and
  [`DistPathWriter.ts`](../cli/src/install/DistPathWriter.ts).

Mental model: *the plugin releases independently like the VS Code extension; it
inlines a build-time snapshot of the CLI core, so republishing the plugin is
what propagates CLI changes — a build step, not a version lock.*

## Open items before shipping

- ~~CLI needs a narrow repo-hook reconciler for PluginBootstrapHook.~~ **Done** —
  `jolli enable --repo-hooks-only` installs the shared runtime, source-neutral
  Git hooks, canonical Claude Stop/SessionStart hooks, and project state while
  skipping MCP/full skills. PluginBootstrapHook calls the same installer directly
  and writes the bare `/jolli` umbrella
  menu into `.claude/skills/jolli/` and git-excludes it — a plugin skill can only
  ever be invoked as `/jolli:<name>`, so the bare `/jolli` front door has to come
  from a non-plugin project skill (the umbrella routes to the plugin's own
  `/jolli:*` skills). It does NOT write `~/.claude/CLAUDE.md`. It DOES delete the
  legacy unnamespaced `.claude/skills/jolli-*` skills a pre-plugin `jolli enable`
  wrote (`removeClaudeLegacySkills`) — the plugin ships those as `/jolli:*`, so the
  CLI copies are duplicates in the `/` menu; deletion is ownership-guarded (a user's
  own same-named skill is left alone) and Claude-Code-scoped (`.agents/skills/` is
  untouched). A full `jolli enable` no longer writes `.claude/skills/` at all (the
  plugin owns it). See `cli/src/install/Installer.ts` (mirror of
  `--integrations-only`), `cli/src/install/SkillInstaller.ts`
  (`installPluginJolliMenu` / `removeClaudeLegacySkills`), and
  `cli/src/commands/EnableCommand.ts`.
- ~~Verify plugin-namespaced MCP tool ids and align the skill bodies.~~
  **Done** — plugin MCP tools are exposed as `mcp__plugin_jolli_jollimemory__<tool>`;
  the skills reference the tool by capability ("the `recall` tool from the
  jollimemory MCP server"), so the namespaced id resolves without hard-coding.
  Skills are invoked as `/jolli:recall` etc. (plugin namespace is mandatory).
- **Register the `claude-plugin` client kind** on the server allowlist.
- **`parseJolliApiKey` lockstep** (CLAUDE.md): this bundle is a 4th consumer of
  `cli/src/core/JolliApiUtils.ts` alongside CLI / VS Code / IntelliJ.
- **npm `files` whitelist must ship the whole plugin, not just `dist/`.** When the
  publishing `package.json` is added, include `dist/`, `.claude-plugin/plugin.json`,
  `.mcp.json`, `hooks/`, `skills/`, `commands/`, `agents/`. `.mcp.json` and
  `skills/**/SKILL.md` are `.gitignore`-re-included at the repo root (see the
  Distribution section) — the published package needs that same full set, or it
  ships without its MCP server and skills. Verify with `npm pack --dry-run` before
  releasing.
