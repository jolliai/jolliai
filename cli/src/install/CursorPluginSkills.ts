/**
 * Which skills the Cursor plugin ships, and how their canonical text is adapted for
 * a bundled copy.
 *
 * Sibling of {@link file://./CodexPluginSkills.ts}. Lives here rather than beside the
 * plugin so the list sits next to the builders it draws from — and so
 * `CursorPluginSkills.test.ts` can import it without reaching outside the CLI's
 * `rootDir`. The plugin's `scripts/generate-skills.ts` is a thin runner over these
 * exports.
 *
 * **Directory names keep the canonical `jolli-` prefix**, and that is the one place
 * this bundle deliberately diverges from the Codex one. Codex namespaces a plugin's
 * skills as `<plugin>:<skill>`, so a prefix there produced stuttering
 * `jolli:jolli-recall` and was dropped once a probe confirmed bare names cannot
 * collide. **Cursor does the opposite, and it is measured, not assumed** — read out of
 * Cursor 3.14.7's own `workbench.desktop.main.js`:
 *
 *   - The invocation name is the **parent directory of `SKILL.md`**, full stop
 *     (`iBg(path, filename)` returns `split("/").at(-2)`), and the docs require
 *     frontmatter `name` to match that folder. No plugin segment is prepended
 *     anywhere.
 *   - Plugin skills land in the SAME flat pool as `.cursor/skills/`,
 *     `.agents/skills/`, `.claude/skills/`, `.codex/skills/` and their `~` variants.
 *     A plugin's only distinguishing mark is `pluginAttribution` — a brand ICON in
 *     the slash menu, not part of the name.
 *   - The slash-menu de-duplicator (`rBg`) keys on
 *     `(pluginDisplayName, skillName)`, so it collapses only the SAME plugin's
 *     same-named skill (e.g. installed from two marketplaces). Entries with no
 *     plugin attribution are pushed unconditionally. Two different plugins — or a
 *     plugin and the user's own `.cursor/skills/` — therefore coexist as two
 *     identically-named entries, with no suffix and no shadowing.
 *   - The agent-facing skill object carries `fullPath`, `description`, `globs`,
 *     `environments` and `disableModelInvocation` — and **no name field at all**, so
 *     the model identifies a skill by path + description too.
 *
 * So a bare `init` / `status` / `push` in this bundle would sit in one namespace
 * against every other plugin's and every user's same-named skill, indistinguishable
 * except by icon. The prefix is what makes each one unambiguous.
 *
 * That same flat pool is why this bundle ships only Cursor-SPECIFIC skills. The four
 * host-neutral ones would collide by name with the `.agents/skills/` copies a full
 * `jolli enable` writes, and nothing would collapse the pair; they are placed per-repo
 * in `.cursor/skills/` on demand instead (`reconcileCursorRepoSkills`). What remains
 * here needs no re-heading or substring rewriting either way — these builders are
 * authored for this host and already declare their own names.
 *
 * Two hard limits come from the same reading, both asserted by the drift test:
 * `name` is lowercase letters/digits/hyphens, max 64 chars, and must equal the
 * directory; `description` is capped at 1024 by the docs and hard-truncated to 1536
 * by `kt()` before the model ever sees it.
 */

import { LOCAL_AGENT_TOOLS, localAgentToolLabel } from "../core/localagent/ToolMeta.js";
import type { LocalAgentToolId } from "../Types.js";
import { SHELL_PREREQUISITE_BLOCK, setFrontmatterName, stripMetadataBlock } from "./PluginSkillText.js";

const RUN_CLI = '"$HOME/.jolli/jollimemory/run-cli"';

/**
 * Same expression as `SkillInstaller`'s, deliberately restated rather than imported.
 *
 * `SkillInstaller` imports THIS module (for the umbrella the Cursor mirror writes), so
 * importing back would close a cycle. Both read the identical compile-time define, so
 * there is no value to drift — only the expression is duplicated, never a literal.
 */
const SKILL_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";

/**
 * The local-agent logins `auth logout` leaves intact, as an English list.
 *
 * Derived from {@link LOCAL_AGENT_TOOLS} rather than spelled out — a hand-written
 * list here has no lockstep guard of any kind, and the Codex copy went stale exactly
 * that way when `kimi` shipped. Cursor leads the list because this is the Cursor
 * plugin's own skill and `cursor-agent` is the tool its bootstrap seeds.
 *
 * `cursor-agent` is REORDERED, never appended: prepending it unconditionally would
 * reintroduce the very staleness this function exists to prevent, naming a tool that
 * had been dropped from the table while every other name stayed correct.
 */
function localAgentLoginList(): string {
	const ids = Object.keys(LOCAL_AGENT_TOOLS) as ReadonlyArray<LocalAgentToolId>;
	const lead = ids.filter((id) => id === "cursor-agent");
	const labels = [...lead, ...ids.filter((id) => id !== "cursor-agent")].map(localAgentToolLabel);
	return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

/**
 * The Cursor front door.
 *
 * Carries the `metadata:` block even though the other builders in this file do not,
 * because this one is no longer bundled — `reconcileCursorRepoSkills` writes it into
 * `<repo>/.cursor/skills/jolli`, where the block does real work in both directions:
 * `upsertSkill` compares `revision` before overwriting a user's file, and
 * `removeJolliOwnedSkillDir` requires the `vendor` marker before deleting anything.
 * Without it the mirror could not be removed at all — uninstall would silently treat
 * it as user-authored and leave a stale front door behind in a repo the user believes
 * they have disabled.
 */
export function buildCursorJolliSkillTemplate(): string {
	return `---
name: jolli
description: State-aware front door for Jolli Memory in Cursor — reads how Jolli is set up in this repository, guides first-time setup through jolli-init, reminds the user to sign in when memories cannot sync yet, then routes to recall, search, status, timeline, push, PR, or workflow actions. Use when the user invokes Jolli or asks what Jolli can do.
metadata:
  version: "${SKILL_VERSION}"
  revision: 3
  vendor: "jolli.ai"
---

# Jolli Memory

The single front door for Jolli in Cursor. Rather than printing a static list, it
reads how Jolli is set up in THIS repository and guides the next step: incomplete
setup goes to \`/jolli-init\`; memories that are captured but cannot be shared yet
get a sign-in reminder; a healthy repo gets a short snapshot and a routed action.

It **never** re-implements another skill's workflow — it only reads state and
invokes an existing skill or an existing Jolli Memory tool.

${SHELL_PREREQUISITE_BLOCK}

Getting this wrong is worse here than in the other skills: Step 0 reads a failed
\`test -f\` as "Jolli is not installed on this machine" and offers to delete this
menu. Run the check in the wrong shell and that verdict is simply false.

## Step 0 — confirm this menu can route

This menu lives in \`~/.cursor/skills/jolli/\`, OUTSIDE the Jolli plugin, so that it
is reachable from Cursor's chat-first window — which starts conversations without
naming a workspace, and therefore cannot be given a per-repository copy. Being
outside the plugin, it can also linger after the plugin has been uninstalled. It can
only route to targets that exist in THIS session, so before doing anything else
confirm at least one is available. The menu can route if **either** holds:

- one or more Jolli Memory MCP tools are available this session, **or**
- the bundled CLI dispatcher exists:

  \`\`\`bash
  test -f "$HOME/.jolli/jollimemory/run-cli" && echo present
  \`\`\`

If **either** holds, proceed to Step 1.

The dispatcher alone is enough to run every step below — each one names a CLI
fallback. If ONLY the dispatcher is present, use it and mention once that the MCP
tools appear after the user enables the \`jollimemory\` server in **Customize**:
Cursor notices \`.cursor/mcp.json\` within a second of it being written, but a newly
discovered project server stays disconnected until it is switched on.
That is expected, not a fault.

If **neither** holds, do **not** build the menu and do **not** invoke any
\`/jolli-*\` skill — they share this session's plumbing and the call will fail. This
alone does NOT mean Jolli is gone: the Jolli CLI installs a memory pipeline that runs
independently of this plugin (git hooks that generate memories on every commit). The
dispatcher check above already tells the two apart:

- **dispatcher present** → Jolli still works; only this session's plumbing is
  missing. Tell the user plainly: commits still generate memories, and they can run
  \`jolli recall\` / \`jolli search\` directly. Reloading the window and starting a new
  chat re-runs the Jolli \`sessionStart\` hook, which restores it.
- **dispatcher absent** → Jolli is no longer installed on this machine, and this
  \`/jolli\` is a stale leftover from a previous plugin install. They can remove it
  with \`rm -rf ~/.cursor/skills/jolli\`, and reinstall the Jolli plugin to bring the
  menu back.

Either way, then stop — do not continue to Step 1. Do not guess at install paths.

## Step 1 — read how Jolli is set up

**Preferred (MCP):** call the Jolli Memory \`status\` tool with no arguments and
read:

- \`enabled\` — are Jolli's git hooks installed in this repository (is memory
  capture on)?
- \`account.signedIn\` — is the user signed in to Jolli?
- \`account.jolliApiKeyConfigured\` — is a stored Jolli API key present? Surfaced
  ONLY when signed OUT (a sign-in already implies a Jolli credential).
- \`account.anthropicKeyConfigured\` — surfaced ONLY when
  \`account.aiProvider === "anthropic"\`; omitted for every other provider.
- \`account.aiProvider\` — \`"local-agent"\` | \`"jolli"\` | \`"anthropic"\` | \`null\`.
- \`account.localAgentTool\` — label of the local agent CLI that generates
  summaries (e.g. "Cursor"). Surfaced ONLY when \`aiProvider\` is \`local-agent\`.
- \`account.site\` — the Jolli site host, for the snapshot line.
- \`storedMemories\` — how many memories this repository already has.
- \`space\` — the bound Jolli Space (\`{ name }\`), or \`null\` when unbound.

**Fallback (CLI):** if the \`status\` tool is unavailable, read the same facts from

\`\`\`bash
${RUN_CLI} status
\`\`\`

If neither can be reached, skip the state-based guidance and go straight to
Step 3's menu, presented without a snapshot.

## Step 2 — guide by state (the front door)

Derive three things, mirroring the CLI's guided front door:

- **can generate memories** — provider-AWARE, NOT a blind OR of every credential:
  - \`local-agent\` → **yes**; summaries generate by driving the local agent CLI
    named by \`account.localAgentTool\` — the user's own login for whatever agent
    that field names, Cursor's on a fresh setup — with no API key and no Jolli
    sign-in. This is the plugin's default, so a freshly installed repo can already
    generate. Report the field, never assume Cursor: an agent tool the user had
    already configured is kept as-is.
  - \`jolli\` → yes if \`account.signedIn\` OR \`account.jolliApiKeyConfigured\`.
  - \`anthropic\` → yes only if \`account.anthropicKeyConfigured\`; a Jolli sign-in
    alone does NOT count.
  - \`null\` / unset → yes if \`account.signedIn\` OR \`account.jolliApiKeyConfigured\`.
- **can sync memories** = \`account.signedIn\` OR \`account.jolliApiKeyConfigured\`.
  Provider-independent: sharing to a Jolli Space always needs a **Jolli**
  credential, so an Anthropic key never satisfies it. Orthogonal to generation —
  the default \`local-agent\` repo generates fine while unable to sync.
- **enabled** = the \`enabled\` flag.

Then take exactly one branch:

- **Not fully set up** — \`enabled\` is false, OR memories can't be generated: lead
  with SETUP, not the menu. State in one line what is missing, then invoke the
  \`jolli-init\` skill, which owns enable → sign-in → bind a Space. Do not
  hand-roll those steps here. (Exception: if the user named a different specific
  action, honor that instead — see Step 3.)

- **Fully set up** — enabled AND generation possible: print a short snapshot, then
  continue to Step 3.

  \`\`\`
  ✓ signed in · <account.site> · summaries via <account.localAgentTool>
  ✓ enabled · <storedMemories> memories
  ✓ syncing · Space "<space.name>"    (ONLY when \`space\` is non-null; omit the whole line otherwise)

  Jolli is listening — last memory saved.
  \`\`\`

  Pick the FIRST line by state, mirroring the CLI front door's wording exactly:

  - signed in → \`✓ signed in · <account.site>\`, plus \` · summaries via
    <account.localAgentTool>\` when \`aiProvider\` is \`local-agent\`. Drop the
    \`· <site>\` segment when \`account.site\` is null.
  - not signed in, \`local-agent\` → \`✓ local agent set (not signed in to Jolli)\`.
  - not signed in, \`jolli\` → \`✓ Jolli API key set (not signed in to Jolli)\`.
  - not signed in, \`anthropic\` → \`✓ Anthropic API key set (not signed in to Jolli)\`.

  Render the \`✓ syncing · Space "<space.name>"\` line **only when \`space\` is
  non-null**; it means a \`git push\` auto-publishes this branch's memories to that
  Space. When \`space\` is null, drop the line entirely — do not print a "not bound"
  line here (binding is \`jolli-init\`'s job).

  The closing \`Jolli is listening — …\` line uses **"last memory saved."** when
  \`storedMemories\` > 0, or **"your next commit is your first memory"** when it
  is 0.

### Sign-in nudge — only when **can sync** is false

Generation working does not mean memories are shared. When the user can generate
but **can sync** is false (the normal state of a fresh \`local-agent\` install),
add ONE line under the snapshot, mirroring the CLI front door's optional sign-in
step:

\`\`\`
Sign in to Jolli to sync memories to a Space? (/jolli-login — memory generation keeps running locally either way)
\`\`\`

Rules for the nudge:

- It is **non-blocking**. Never withhold the Step 3 menu waiting for an answer,
  and never report "not signed in" as broken — the repository is capturing
  memories.
- Offer it **once** per invocation. If the user declines, drop it for the rest of
  the session.
- If the user accepts, invoke the \`jolli-login\` skill (or \`jolli-init\` when they
  also want to bind a Space in the same pass). Never run \`auth login\` yourself
  here, and never ask for a password, token, or callback URL.
- Skip it when **can sync** is true, and inside the "Not fully set up" branch —
  there \`jolli-init\` already walks sign-in.

## Step 3 — route the request / present the menu

This skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one action below and invoke that
  action directly, regardless of the Step 2 state — a specific request wins over
  the setup nudge. The invoked skill handles its own preconditions (for example
  \`jolli-push\` offers to bind a Space when the repo is unbound). Ask the user to
  choose only when the request is ambiguous or matches no action.
- **Argument absent** → after the Step 2 guidance, list the actions as plain text
  and ask the user to pick one. Bias the ordering to the state: when
  \`storedMemories\` is 0, lead with \`jolli-init\` as the FIRST option and demote
  recall / search below it, since on a fresh repo both would only return empty.
  When memories exist, lead with recall / search. Keep \`jolli-init\` available
  either way for re-running setup or re-binding a Space.

### Jolli skills

- \`/jolli-init\` — finish setup, or change the bound Space.
- \`/jolli-recall\` — recall current-branch context.
- \`/jolli-search\` — search decisions across branches.
- \`/jolli-status\` — inspect installation and queue health.
- \`/jolli-timeline\` — show a decision topic's history.
- \`/jolli-push\` — publish this branch's memories to a Space.
- \`/jolli-login\` — sign in to Jolli so memories can sync to a Space. Surface this
  whenever **can sync** is false, even if the user did not pick it.
- \`/jolli-logout\` — clear the stored Jolli credentials.
- \`/jolli-local-run\` / \`/jolli-remote-run\` — run a Jolli workflow locally or on
  the Jolli backend.

Route a choice by invoking that skill; do not restate its steps here.

**If \`/jolli-recall\`, \`/jolli-search\`, \`/jolli-local-run\` or \`/jolli-remote-run\`
is not offered this session**, it is not missing — those four live in the repository
rather than in the plugin (so they appear exactly once instead of twice), and this
repository has not had them placed yet. That happens on the first session after the
plugin is installed; if the session hook did not run, \`/jolli-init\` places them.
Say so in one line and offer \`/jolli-init\`, rather than reporting the skill as
unavailable. The CLI fallback below works either way.

### Jolli Memory tools (whatever is registered this session)

Surface the Jolli Memory MCP tools actually available this session — do not assume
a fixed list. Route a choice by calling the matching tool. One combination is worth
offering explicitly:

- **PR description** — call \`queue_status\` first, then \`get_pr_description\`, so
  the description covers memories that are still being generated.

If no Jolli Memory tools are registered, present just the skills above.
`;
}

export function buildCursorInitSkillTemplate(): string {
	return `---
name: jolli-init
description: "Set up Jolli Memory for the current repository in Cursor: verify the plugin hook, enable memory generation through Cursor, sign in to Jolli when sharing is requested, and bind the repo to a Jolli Space. Use for first-time setup, repair, enablement, or Space binding."
---

# Jolli Init

Complete the steps in order. Stop when a required step fails.

${SHELL_PREREQUISITE_BLOCK}

## 1. Inspect state

Call the Jolli Memory \`status\` tool. If unavailable, run \`${RUN_CLI} status\`.
If the dispatcher is missing, ask the user to run **Developer: Reload Window** and
start a new chat so the Jolli \`sessionStart\` hook runs, then retry.

## 2. Enable local memory generation

Run:

\`\`\`bash
${RUN_CLI} enable --repo-hooks-only --source-tag cursor-plugin
\`\`\`

This explicit setup records \`cursor-agent\` as the local-agent tool only when none
is configured yet — an agent tool and a paid provider already on disk are both left
exactly as they are. It also writes this workspace's
\`.cursor/mcp.json\`, and places \`/jolli-recall\`, \`/jolli-search\`,
\`/jolli-local-run\` and \`/jolli-remote-run\` into this repository — those four are
not bundled with the plugin, so that they appear once in the menu rather than twice
in a repository that also ran a full \`jolli enable\`. If they were already present
this step changes nothing. Cursor notices that file within a second — no reload needed —
but registers the server **disconnected**, so tell the user to open **Customize** in
the sidebar and enable \`jollimemory\` to get the MCP tools. Everything below works
without them either way. If the command reports that the repository is manually
disabled, explain that an explicit full \`jolli enable\` is required to clear the
opt-out; do not silently override it.

## 3. Decide whether Jolli sign-in is needed

Local memory generation uses the user's Cursor login and needs no Jolli account.
Jolli sign-in is required to bind and share with a Space.

If the user only wants local memory, skip to Step 5. Otherwise, when status shows
neither a Jolli sign-in nor a Jolli API key, run and wait for:

\`\`\`bash
${RUN_CLI} auth login
\`\`\`

The command opens the browser and waits for a loopback callback. Never ask for a
password, token, or callback URL.

## 4. Bind a Space

Call \`list_spaces\`. Match a Space named by the user by id, slug, or exact name.
Otherwise present the available Spaces and ask them to choose, offering the default
first when one exists. Call \`bind_space\` with the selected value. Treat
\`already_bound\` as success.

If the Space tools are unavailable, run \`${RUN_CLI} spaces --format json\`,
present only the returned Spaces, then bind the selected id or slug with
\`${RUN_CLI} bind --space <id-or-slug> --format json\`. Never put free-typed
user text directly into this command.

## 5. Verify and report

Call \`status\` again (or \`${RUN_CLI} status\` when the tool is not registered yet).
Report:

- memory generation enabled or the exact remaining problem;
- which agent generates summaries when provider is \`local-agent\` — name
  \`localAgentTool\` from \`status\` rather than assuming Cursor, since a tool that
  was already configured is left alone;
- Jolli sign-in and bound Space when sharing was configured;
- a normal commit captures memory and \`git push\` publishes to the bound Space;
- when the MCP tools were unavailable, that enabling \`jollimemory\` in **Customize**
  turns them on (a reload is not required).
`;
}

export function buildCursorLoginSkillTemplate(): string {
	return `---
name: jolli-login
description: Sign in to Jolli from Cursor so the repository can bind to a Jolli Space and share memories. Use when the user asks to log in, authenticate Jolli, connect an account, or fix missing Jolli credentials.
---

# Jolli Login

${SHELL_PREREQUISITE_BLOCK}

Run and wait for the interactive browser flow:

\`\`\`bash
${RUN_CLI} auth login
\`\`\`

Never ask the user for passwords, API keys, callback URLs, or browser tokens.

On success, say that Jolli credentials were saved and offer \`/jolli-init\` to bind
the repository to a Space. Clarify that local memory generation still uses the
configured local agent unless the user explicitly changes providers. On failure,
surface the command's reason and suggest retrying; if the browser did not open,
point out the login URL printed by the command. If the dispatcher does not exist,
ask the user to run **Developer: Reload Window**, start a new chat so the Jolli
\`sessionStart\` hook runs, and retry.
`;
}

export function buildCursorLogoutSkillTemplate(): string {
	return `---
name: jolli-logout
description: Sign out of Jolli from Cursor by clearing the stored Jolli auth token and Jolli API key while preserving other provider credentials. Use when the user asks to log out, disconnect Jolli, or remove Jolli account credentials.
---

# Jolli Logout

${SHELL_PREREQUISITE_BLOCK}

Run:

\`\`\`bash
${RUN_CLI} auth logout
\`\`\`

Report the command output, then call the Jolli Memory \`status\` tool when
available. Explain the provider-aware result:

- Space binding and cloud sharing require a future Jolli sign-in.
- \`local-agent\` memory generation continues through the configured
  ${localAgentLoginList()} login.
- \`anthropic\` generation continues when its preserved Anthropic key exists.
- \`jolli\` generation stops unless another Jolli API key remains configured.

If the dispatcher does not exist, ask the user to run **Developer: Reload Window**,
start a new chat so the Jolli \`sessionStart\` hook runs, and retry.
`;
}

export function buildCursorStatusSkillTemplate(): string {
	return `---
name: jolli-status
description: Diagnose Jolli Memory installation, provider, account, hooks, queue, integrations, stored memories, and Space binding for the current repository. Use for status, health checks, missing or stale memories, setup verification, or troubleshooting.
---

# Jolli Status

1. Call the Jolli Memory \`status\` tool.
2. Call \`queue_status\` without waiting.
3. Render a compact Markdown table containing version/enabled, hooks/runtime,
   migration, provider/local agent, account credentials, bound Space, and stored
   memories. Omit unavailable optional fields.
4. List detected AI integrations below the table using their returned status text.
5. State whether memory generation is idle or still running.
6. Give a provider-aware verdict:
   - \`local-agent\`: ready when its tool is configured; if an auth failure is
     reported, use that tool's login remedy.
   - \`jolli\`: requires Jolli sign-in or a Jolli API key.
   - \`anthropic\`: requires an Anthropic API key.
   - unset: requires a usable provider credential.

If \`status\` is unavailable, run \`${RUN_CLI} status\` and summarize it. Do not
list branch memories; route those requests to \`/jolli-recall\` or \`/jolli-search\`.

${SHELL_PREREQUISITE_BLOCK}
`;
}

export function buildCursorTimelineSkillTemplate(): string {
	return `---
name: jolli-timeline
description: Show the chronological evolution of a Jolli Memory decision topic. Use when the user asks for a topic timeline, how a decision changed over time, or provides a Jolli topic slug.
---

# Jolli Decision Timeline

Obtain the topic slug from the request. If it is missing or ambiguous, call the
Jolli Memory \`search\` tool and let the user choose the matching topic.

Call \`get_decision_timeline\` with the selected slug. Render source events
oldest-first as a concise chronological narrative, grounding each transition in
the returned commit or source metadata. If the slug is unknown, search again
instead of inventing a timeline.
`;
}

export function buildCursorPushSkillTemplate(): string {
	return `---
name: jolli-push
description: Publish the current branch's Jolli memories to a Jolli Space. Use when the user asks to push, publish, share, or sync memories or decisions with a team.
---

# Jolli Push

1. Call \`queue_status\` with waiting enabled so newly committed memories are ready.
2. Call \`push_memory\` for the current branch.
3. If it returns \`binding_required\`, present the returned Spaces, ask the user to
   choose one, then call \`push_memory\` again with that Space. If authentication is
   missing, route to \`/jolli-login\` and stop; never request credentials in chat.
4. On success, report the Space and article links. Offer to open links when the host
   provides a browser action.
5. On partial or failed publication, report the exact result and do not claim all
   memories were shared.
`;
}

/** A skill the plugin ships: its bundle directory name plus the canonical builder. */
export interface CursorPluginSkill {
	readonly name: string;
	readonly build: () => string;
}

/**
 * What the bundle ships: **only skills that exist nowhere else**.
 *
 * Names keep the canonical `jolli-` prefix — see the module header for why this host
 * takes the opposite choice from the Codex bundle.
 *
 * Five names are deliberately ABSENT: the four host-neutral skills (`jolli-recall`,
 * `jolli-search`, `jolli-local-run`, `jolli-remote-run`) and the `jolli` umbrella.
 * Cursor pools a plugin bundle's `skills/` with `.agents/skills/` and the rest into one
 * flat, un-namespaced menu and collapses neither, so shipping any of them here produced
 * a second, identically-named entry in every repo that had run a full `jolli enable`.
 *
 * They are placed elsewhere, and the two groups land at DIFFERENT SCOPES — worth
 * keeping straight, because "all five are mirrored per-repo" was written here once and
 * was wrong. The four go per-repo into `.cursor/skills/` via
 * `reconcileCursorRepoSkills`, and only when no root Cursor reads has already supplied
 * them — see that function for the whole rule, including why the mirror cannot live in
 * this (machine-global) bundle. The umbrella goes MACHINE-GLOBAL into
 * `~/.cursor/skills/jolli` via `ensureCursorGlobalMenu`, because Cursor's chat-first
 * Agents Window delivers no workspace at all and a per-repo front door cannot be
 * planted from it; the cost is one accepted duplicate `/jolli` in a repo that also ran
 * a full `jolli enable`.
 *
 * `buildCursorJolliSkillTemplate` therefore still exists and is still the umbrella a
 * plugin-only user receives; it is simply written on demand rather than shipped.
 * Dropping it from this list without wiring it into that global write would leave such
 * a user with no front door at all.
 *
 * `jolli-init` MUST stay here, and it is now the ONLY thing standing between a user
 * and a dead end: the reconcile runs from the `sessionStart` bootstrap, and Cursor
 * drops every plugin hook silently whenever its plugins provider times out (measured —
 * see cursor-plugin/DEVELOPMENT.md). When that happens nothing has been mirrored, so
 * `/jolli` does not exist either; typing `jolli` still prefix-matches this skill, which
 * is the manual route back.
 */
export const CURSOR_PLUGIN_SKILLS: ReadonlyArray<CursorPluginSkill> = [
	{ name: "jolli-init", build: buildCursorInitSkillTemplate },
	{ name: "jolli-login", build: buildCursorLoginSkillTemplate },
	{ name: "jolli-logout", build: buildCursorLogoutSkillTemplate },
	{ name: "jolli-status", build: buildCursorStatusSkillTemplate },
	{ name: "jolli-timeline", build: buildCursorTimelineSkillTemplate },
	{ name: "jolli-push", build: buildCursorPushSkillTemplate },
];

/**
 * Complete bundle-directory inventory exposed by the Cursor plugin.
 *
 * Two consumers, both treating it as an exact set (never a glob): the drift test
 * asserts it equals the committed `skills/` directories, and
 * `PUBLISH_EXPECTED_SKILLS` in `cursor-plugin/scripts/_publish-lib.sh` mirrors it so
 * a `.gitignore` rule cannot silently drop a `SKILL.md`.
 *
 * NOT an install-side removal list. The bootstrap deliberately leaves
 * `.agents/skills/` alone — that directory is cross-platform (Cursor 2.4+ reads it,
 * and so do Codex, Gemini, OpenCode, Windsurf and Copilot), so deleting an active
 * skill from it to de-duplicate one host's picker takes the only copy the others
 * have.
 */
export const CURSOR_PLUGIN_SKILL_NAMES: ReadonlyArray<string> = CURSOR_PLUGIN_SKILLS.map((skill) => skill.name);

/**
 * The exact bytes the plugin's `skills/<name>/SKILL.md` must contain.
 *
 * Only two adaptations, both consequences of one document serving several hosts:
 * drop the upsert-only `metadata:` block, and keep the frontmatter `name` equal to
 * the bundle directory. There is deliberately no sibling-reference rewrite here (the
 * Codex renderer's third step): the shared builders already name their siblings
 * `jolli-recall` / `jolli-search` / …, which is exactly what this bundle exposes.
 */
export function renderCursorPluginSkill(skill: CursorPluginSkill): string {
	return setFrontmatterName(stripMetadataBlock(skill.build()), skill.name);
}
