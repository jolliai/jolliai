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
 * That same flat pool means a name this bundle ships can ALSO be supplied by
 * `.agents/skills/` (which a full `jolli enable` writes, and which Cursor reads), with
 * nothing collapsing the pair. The bundle ships the complete set anyway and accepts the
 * duplicate — see {@link CURSOR_PLUGIN_SKILLS} for why optimising the other way left
 * Cursor-only users with no recall or search at all. Nothing here needs re-heading or
 * substring rewriting: every builder already declares the name of its own directory,
 * and the shared builders already name their siblings with this bundle's exact names.
 *
 * Two hard limits come from the same reading, both asserted by the drift test:
 * `name` is lowercase letters/digits/hyphens, max 64 chars, and must equal the
 * directory; `description` is capped at 1024 by the docs and hard-truncated to 1536
 * by `kt()` before the model ever sees it.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { LOCAL_AGENT_TOOLS, localAgentToolLabel } from "../core/localagent/ToolMeta.js";
import type { LocalAgentToolId } from "../Types.js";
import {
	appendDispatcherRecovery,
	buildDashboardSkillTemplate,
	SHELL_PREREQUISITE_BLOCK,
	setFrontmatterName,
	stripMetadataBlock,
} from "./PluginSkillText.js";
import {
	buildLocalRunSkillTemplate,
	buildRecallSkillTemplate,
	buildRemoteRunSkillTemplate,
	buildSearchSkillTemplate,
	removeJolliOwnedSkillDir,
} from "./SkillInstaller.js";

const RUN_CLI = '"$HOME/.jolli/jollimemory/run-cli"';

/**
 * What to tell the user when `run-cli` is absent — restated by every skill that
 * shells it, from one constant so the three cannot drift.
 *
 * The remedy is a FULL restart, and never `Developer: Reload Window`. A freshly
 * installed plugin's hooks are not registered until Cursor has been quit and
 * reopened (measured on 3.16.29: a window reload plus a new chat both left the
 * `sessionStart` hook unrun and `~/.jolli/jollimemory/` untouched), and that hook is
 * what writes the dispatcher. Three skills used to say "reload the window", which
 * reads as an actionable fix and is not one — the user retries it, sees the same
 * failure, and never gets past setup. The umbrella's Step 0 already draws this
 * distinction; these are the skills that reach the same state one step later.
 */
export const CURSOR_DISPATCHER_MISSING_BLOCK = `If \`$HOME/.jolli/jollimemory/run-cli\` does not exist, the plugin's \`sessionStart\`
hook has not run on this machine yet — that hook is what writes it. Ask the user to
**quit Cursor completely (⌘Q) and reopen it, then start a new chat**, and retry. A
freshly installed plugin's hooks are not registered until the app has been fully
restarted, so **Developer: Reload Window** or another chat is not enough (measured).`;

/**
 * Same expression as `SkillInstaller`'s, deliberately restated rather than imported.
 *
 * The cycle this avoided is gone — the dependency is now one-way, THIS module imports
 * `SkillInstaller` — but the restatement stays because `SkillInstaller` does not export
 * it, and both read the identical compile-time define, so there is no value to drift:
 * only the expression is duplicated, never a literal.
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
 * The Cursor front door, shipped in the bundle like every other skill here.
 *
 * It still carries a `metadata:` block, which {@link renderCursorPluginSkill} strips on
 * the way into `skills/jolli/SKILL.md` — so the block is inert for the bundled copy and
 * kept for one reason: earlier versions wrote this same document MACHINE-GLOBAL to
 * `~/.cursor/skills/jolli/`, and the `vendor` marker in it is what
 * {@link removeCursorGlobalMenu} matches before deleting that leftover. Dropping the
 * block would not change what ships; it would make the old copy unrecognisable and so
 * un-removable.
 *
 * This document is NOT the host-neutral `buildJolliMenuSkillTemplate` that a full
 * `jolli enable` writes to `.agents/skills/jolli`. Both are called `jolli` and both are
 * front doors, but only this one is state-aware (it reads `status` and leads a
 * half-configured repo into setup) and carries the Cursor-only notes about enabling the
 * MCP server in Customize. A repo that ran both shows two `/jolli` entries — the same
 * accepted duplication as the other four shared names.
 */
export function buildCursorJolliSkillTemplate(): string {
	return `---
name: jolli
description: State-aware front door for Jolli Memory in Cursor — reads how Jolli is set up in this repository, guides first-time setup through jolli-init, reminds the user to sign in when memories cannot sync yet, then routes to recall, search, status, timeline, push, PR, or workflow actions. Use when the user invokes Jolli or asks what Jolli can do.
metadata:
  version: "${SKILL_VERSION}"
  revision: 4
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
\`test -f\` as "the sessionStart hook has not run yet" and sends the user off to
restart Cursor. Run the check in the wrong shell and that advice is simply wrong.

## Step 0 — confirm this menu can route

This menu ships WITH the Jolli plugin, so it is available the moment the plugin is
installed — in every window, including Cursor's chat-first window, which starts
conversations without naming a workspace. Its presence therefore says the plugin is
installed; it says nothing about whether this session can reach Jolli's plumbing.
That is what this step checks. The menu can route if **either** holds:

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
\`/jolli-*\` skill — they share this session's plumbing and the call will fail. There
is only ONE state here, and it follows from the test above: the dispatcher is half of
that test, so neither holding means the dispatcher is absent.

That means the plugin's \`sessionStart\` hook has not run yet on this machine — that
hook is what writes the dispatcher. A FRESHLY INSTALLED plugin's hooks are not
registered until Cursor is fully restarted; reloading the window or starting another
chat is not enough (measured). Tell the user to **quit Cursor completely (⌘Q) and
reopen it, then start a new chat**. Do NOT tell them Jolli is uninstalled or missing:
you are reading this menu, and this menu ships with the plugin, so the plugin is
installed. Do not suggest deleting anything, and do not offer to install the CLI or
the VS Code extension — neither is the fix on this host.

Then stop — do not continue to Step 1. Do not guess at install paths.

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
- \`/jolli-dashboard\` — open the local dashboard in a browser (machine-wide
  memories, sessions, token spend, knowledge).
- \`/jolli-timeline\` — show a decision topic's history.
- \`/jolli-push\` — publish this branch's memories to a Space.
- \`/jolli-login\` — sign in to Jolli so memories can sync to a Space. Surface this
  whenever **can sync** is false, even if the user did not pick it.
- \`/jolli-logout\` — clear the stored Jolli credentials.
- \`/jolli-local-run\` / \`/jolli-remote-run\` — run a Jolli workflow locally or on
  the Jolli backend.

Route a choice by invoking that skill; do not restate its steps here.

**Every skill above ships with this plugin**, this menu included — so none of them
can be missing while you are reading it, and \`/jolli-init\` neither places nor
repairs them. If one is genuinely not offered, the plugin's skills did not load for
this session at all: say that in one line and use the CLI fallback, rather than
routing to setup.

**If a \`/jolli-*\` skill appears TWICE**, both entries are the same skill. Four of
them (\`/jolli-recall\`, \`/jolli-search\`, \`/jolli-local-run\`,
\`/jolli-remote-run\`) are also written into \`.agents/skills/\` by a full
\`jolli enable\`, which Cursor reads as its own skills root; nothing collapses the
pair and neither shadows the other. Invoke either one and do not report a conflict.

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

${CURSOR_DISPATCHER_MISSING_BLOCK}

## 2. Enable local memory generation

Run:

\`\`\`bash
${RUN_CLI} enable --repo-hooks-only --source-tag cursor-plugin
\`\`\`

This explicit setup records \`cursor-agent\` as the local-agent tool only when none
is configured yet — an agent tool and a paid provider already on disk are both left
exactly as they are. What it writes is this repository's git hooks and this
workspace's \`.cursor/mcp.json\`. It writes **no skills**: every Jolli skill ships
with the plugin, so there is nothing here to place or repair — do not report
skill files as an outcome of this step.

Cursor notices \`.cursor/mcp.json\` within a second — no reload needed —
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
point out the login URL printed by the command.

${CURSOR_DISPATCHER_MISSING_BLOCK}
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

${CURSOR_DISPATCHER_MISSING_BLOCK}
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
 * What the bundle ships: **every skill a Cursor user needs, in one place**.
 *
 * Names keep the canonical `jolli-` prefix — see the module header for why this host
 * takes the opposite choice from the Codex bundle.
 *
 * **This list is deliberately complete, and duplication is the accepted cost.** An
 * earlier design shipped only the Cursor-specific skills and mirrored the four
 * host-neutral ones per-repo into `.cursor/skills/`, so that Cursor's flat,
 * un-namespaced menu would show exactly one entry per name even in a repo that had
 * also run a full `jolli enable` (which writes `.agents/skills/`, a root Cursor reads).
 * That optimised the wrong user. A **Cursor-only** user — the one this bundle exists
 * for — got no `jolli-recall` and no `jolli-search` at all: the mirror was planted by
 * the `sessionStart` bootstrap, whose opt-in gate (`isGitHookInstalled`) is false in a
 * repo that has not been set up, so the plugin's core capability was missing from its
 * store page and missing from the menu until the user happened to find `/jolli-init`.
 *
 * So the four are shipped here now, and a user who ALSO runs Claude or Codex sees two
 * identically-named entries differing only by a brand icon. That is cosmetic, it is
 * paid only by multi-host users, and it replaces five silent failure modes — see
 * {@link CURSOR_RETIRED_MIRROR_SKILLS} for the full list and why each one bit.
 *
 * Nothing needs re-heading or substring rewriting: every builder already declares the
 * name of its own directory, and the shared four already name their siblings
 * `jolli-recall` / `jolli-search` / … — exactly what this bundle exposes. That is why
 * {@link renderCursorPluginSkill} has two transforms where the Codex renderer has three.
 *
 * **The `jolli` umbrella is in this list too, and that was the last thing to move
 * here.** It used to be written MACHINE-GLOBAL to `~/.cursor/skills/jolli/` by an
 * `ensureCursorGlobalMenu` call in the bootstrap, on the theory that Cursor's chat-first
 * Agents Window (which reports `workspace_roots: []`) could not be given a bundled front
 * door. Measured on 3.16.29, that theory was simply wrong: reading Cursor's own
 * slash-menu cache (`agentData.…slashMenuItems.v6.local.glass.<ctx>`), all eleven
 * bundled skills appear in BOTH no-repository contexts — the `empty-window` one and the
 * Agents Window's repo-less `Home` project — and `cursor.plugins.installedIds` records
 * the install under a `no-workspace` key, so its per-workspace sharding is a warm-up
 * cache and not a load gate.
 *
 * Bundling it fixes a first-install hole the machine-global copy could not: the
 * bootstrap that wrote it is a `sessionStart` hook, and a freshly installed plugin's
 * hooks are NOT registered until Cursor is fully restarted (measured — a window reload
 * and a new chat both left the hook unrun, `debug.log` untouched). So every new install
 * had a window with eleven working skills and no front door, while `/jolli`'s own Step 0
 * diagnosed the missing dispatcher as "Jolli is no longer installed" and offered to
 * `rm -rf` itself. A bundled umbrella is present the instant the plugin is.
 *
 * The accepted cost, stated plainly: `.cursor/plugins/` is gated behind
 * `thirdPartyExtensibilityEnabled` plus the server-side `enable_cc_plugin_import`, while
 * `~/.cursor/skills/` is always loaded — so with a gate off, the umbrella now disappears
 * along with the other eleven instead of surviving as a last entry point. That trade was
 * taken deliberately: the first-install hole affects every new user, while the gate-off
 * case is one where MCP, hooks and every skill are gone anyway.
 *
 * `jolli-init` MUST stay in this list for the same reason it always did: Cursor drops
 * plugin hooks silently when a gate is off or its plugins provider times out, and
 * nothing else is a manual route back into setup.
 */
export const CURSOR_PLUGIN_SKILLS: ReadonlyArray<CursorPluginSkill> = [
	{ name: "jolli", build: buildCursorJolliSkillTemplate },
	{ name: "jolli-init", build: buildCursorInitSkillTemplate },
	{ name: "jolli-login", build: buildCursorLoginSkillTemplate },
	{ name: "jolli-logout", build: buildCursorLogoutSkillTemplate },
	{ name: "jolli-status", build: buildCursorStatusSkillTemplate },
	{ name: "jolli-dashboard", build: buildDashboardSkillTemplate },
	{ name: "jolli-timeline", build: buildCursorTimelineSkillTemplate },
	{ name: "jolli-push", build: buildCursorPushSkillTemplate },
	{ name: "jolli-recall", build: buildRecallSkillTemplate },
	{ name: "jolli-search", build: buildSearchSkillTemplate },
	{ name: "jolli-local-run", build: buildLocalRunSkillTemplate },
	{ name: "jolli-remote-run", build: buildRemoteRunSkillTemplate },
];

/**
 * Where earlier versions wrote the `/jolli` umbrella: `~/.cursor/skills/`, Cursor's
 * MACHINE-GLOBAL skill root.
 *
 * Retained only so {@link removeCursorGlobalMenu} can find that leftover. The umbrella
 * is bundled now — see {@link CURSOR_PLUGIN_SKILLS} for the measurements that retired
 * the machine-global placement.
 *
 * What the root itself is remains true and was measured on Cursor 3.15.19: a
 * doubled-star glob for `.cursor/skills` is in the skill-scan list (that prefix matches
 * any parent, `$HOME` included) and `~/.cursor` is in the external-watcher list; the
 * NEGATED entries for the same path belong to the WORKSPACE FILE INDEX exclusions
 * alongside the one for `.cursor/worktrees` — a different list for a different purpose.
 * It is in Cursor's always-loaded group, which is the one property a bundled copy does
 * NOT have, and therefore the whole cost of bundling the umbrella.
 *
 * Note this is the same relative path as `SkillInstaller`'s `CURSOR_SKILLS_DIR` and a
 * different anchor: that one is joined to a project dir, this one to `homedir()`.
 */
export const CURSOR_GLOBAL_SKILLS_DIR: ReadonlyArray<string> = [".cursor", "skills"];

/**
 * Remove the machine-global `/jolli` umbrella an earlier version planted.
 *
 * A one-way migration, called from the Cursor bootstrap where `ensureCursorGlobalMenu`
 * used to be. Leaving it would be the duplication this bundle accepts everywhere else —
 * except here it is avoidable at zero cost, because both copies are the SAME document
 * and one of them now ships with the plugin. The bundled copy is also the better one to
 * keep: it appears the instant the plugin is installed, and it disappears with it.
 *
 * Ownership-guarded through `removeJolliOwnedSkillDir`, so a `~/.cursor/skills/jolli/`
 * the user wrote themselves is left alone. That guard is why
 * {@link buildCursorJolliSkillTemplate} keeps its `metadata:` block even though the
 * bundled render strips it: the `vendor` marker in the OLD file is what makes it
 * recognisable as ours.
 *
 * `jolli uninstall` also reaches this path through `scanCursorGlobalMenu`, for the
 * machine where the bootstrap never runs again (plugin removed through Cursor's UI, or
 * its hooks dropped by a gate).
 */
export async function removeCursorGlobalMenu(home: string = homedir()): Promise<void> {
	await removeJolliOwnedSkillDir(join(home, ...CURSOR_GLOBAL_SKILLS_DIR, "jolli"), "cursor global menu");
}

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
 * Three adaptations. Two are consequences of one document serving several hosts: drop
 * the upsert-only `metadata:` block, and keep the frontmatter `name` equal to the bundle
 * directory. There is deliberately no sibling-reference rewrite (the Codex renderer's
 * third step): the shared builders already name their siblings `jolli-recall` /
 * `jolli-search` / …, which is exactly what this bundle exposes. The third is this
 * bundle's own — {@link appendCursorDispatcherRecovery}.
 */
export function renderCursorPluginSkill(skill: CursorPluginSkill): string {
	return appendCursorDispatcherRecovery(setFrontmatterName(stripMetadataBlock(skill.build()), skill.name));
}

/**
 * The phrase every Cursor-aware body uses for the one remedy that works here.
 *
 * Doubles as the predicate {@link appendCursorDispatcherRecovery} tests, which is why
 * it is a constant rather than three spellings: the shared dashboard body says "quit
 * Cursor completely and reopen it" inside a host-neutral sentence, the umbrella's Step 0
 * and {@link CURSOR_DISPATCHER_MISSING_BLOCK} say it with the ⌘Q, and all three have to
 * count as "already handled".
 */
export const CURSOR_RESTART_PHRASE = "quit Cursor completely";

export const CURSOR_DISPATCHER_RECOVERY_SECTION = `
## If the Jolli CLI dispatcher is missing (Cursor)

\`$HOME/.jolli/jollimemory/run-cli\` is written by this plugin's \`sessionStart\` hook,
and a freshly installed plugin's hooks are not registered until Cursor has been fully
restarted — a window reload or another chat is not enough (measured). So when that file
does not exist, the fix is to **${CURSOR_RESTART_PHRASE} (⌘Q) and reopen it, then start
a new chat**, and retry.

This REPLACES any instruction above to report Jolli as not installed, or to install
\`@jolli.ai/cli\` globally or the Jolli VS Code extension. You are running inside the
Jolli plugin, so Jolli IS installed, and neither of those is the fix on this host.
`;

/**
 * The recovery note appended to every bundled body that shells `run-cli` without
 * already saying what a Cursor user should do when it is absent.
 *
 * Bundling the four host-neutral skills made this necessary, and it is the same
 * first-install window the umbrella was bundled for: the plugin's skills are present
 * the instant it is installed, while its `sessionStart` hook — the thing that writes
 * `run-cli` — does not run until Cursor has been fully restarted. So the FIRST session
 * after an install has `/jolli-recall` and `/jolli-search` visible, no MCP server (this
 * bundle ships no `mcp.json`, and `.cursor/mcp.json` is written by the very install
 * being deferred), and no dispatcher.
 *
 * What those two bodies then say is host-neutral and, here, actively wrong: "Jolli not
 * installed. Please install via `npm install -g @jolli.ai/cli && jolli enable` or
 * install the Jolli VS Code extension." A Cursor-only user follows it and installs a
 * second copy of the product to fix a plugin that is already installed and one restart
 * away from working. `local-run` / `remote-run` have no dispatcher branch at all, so
 * they fail with whatever the shell says.
 *
 * The shape, and why the correction belongs to the renderer rather than to the shared
 * builders, is {@link appendDispatcherRecovery}'s. What is Cursor's own is the remedy:
 * a full quit-and-reopen, which is this host's equivalent of Codex's "trust the
 * SessionStart hook in `/hooks`".
 */
export function appendCursorDispatcherRecovery(body: string): string {
	return appendDispatcherRecovery(body, {
		marker: CURSOR_RESTART_PHRASE,
		section: CURSOR_DISPATCHER_RECOVERY_SECTION,
	});
}

/**
 * Appended by {@link appendCursorDispatcherRecovery}. A trailing section rather than a
 * rewrite of the host-neutral sentence: the four shared bodies word their
 * dispatcher-missing branch differently (recall states it in prose, search as a bullet,
 * the two run skills not at all), so a substring replace would hit three shapes and
 * silently miss the fourth. An override that names what it overrides works on all four.
 */
