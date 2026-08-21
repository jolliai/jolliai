/**
 * Which skills the Codex plugin ships, and how their canonical text is adapted for
 * a bundled copy.
 *
 * Lives here rather than beside the plugin so the list sits next to the builders it
 * draws from — and so `CodexPluginSkills.test.ts` can import it without reaching
 * outside the CLI's `rootDir`. The plugin's `scripts/generate-skills.ts` is a thin
 * runner over these exports.
 *
 * Shared skill bodies come from `SkillInstaller` (the four host-neutral ones a full
 * `jolli enable` also writes) and from `PluginSkillText` (`dashboard`, which no
 * `jolli enable` writes — see {@link buildDashboardSkillTemplate} for why it is shared
 * with the Cursor bundle rather than restated per host); Codex-only onboarding and
 * command equivalents live below. The plugin ships static copies (a marketplace
 * publishes a directory tree, not a build product), so the drift test is what keeps
 * every committed `SKILL.md` aligned with these builders.
 */

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
} from "./SkillInstaller.js";

// Re-exported: this module was the original home of both helpers and its drift test
// imports `stripMetadataBlock` from here. They moved to PluginSkillText when the
// Cursor bundle needed the same two transforms.
export { stripMetadataBlock } from "./PluginSkillText.js";

const RUN_CLI = '"$HOME/.jolli/jollimemory/run-cli"';

/**
 * The local-agent logins `auth logout` leaves intact, as an English list.
 *
 * Derived from {@link LOCAL_AGENT_TOOLS} rather than spelled out. A hand-written
 * list here has no lockstep guard of any kind — the skills drift test compares this
 * builder against its committed copy, so both sides stay wrong together — and it did
 * go stale exactly that way: `kimi` shipped as a supported `localAgentTool` while
 * this sentence kept naming four tools, telling a Kimi user their generation would
 * break on logout when it does not.
 *
 * Codex leads the list because this is the Codex plugin's own skill and `codex` is
 * the tool its bootstrap seeds; the rest keep the canonical display order. Labels
 * come from `localAgentToolLabel` so they match every other surface ("Kimi Code",
 * not "Kimi").
 */
function localAgentLoginList(): string {
	const ids = Object.keys(LOCAL_AGENT_TOOLS) as ReadonlyArray<LocalAgentToolId>;
	const labels = ["codex" as LocalAgentToolId, ...ids.filter((id) => id !== "codex")].map(localAgentToolLabel);
	return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

export function buildCodexJolliSkillTemplate(): string {
	return `---
name: jolli
description: State-aware front door for Jolli Memory in Codex — reads how Jolli is set up in this repository, guides first-time setup through jolli:init, reminds the user to sign in when memories cannot sync yet, then routes to recall, search, status, timeline, push, PR, or workflow actions. Use when the user invokes Jolli or asks what Jolli can do.
---

# Jolli Memory

The single front door for Jolli in Codex. Rather than printing a static list, it
reads how Jolli is set up in THIS repository and guides the next step: incomplete
setup goes to \`jolli:init\`; memories that are captured but cannot be shared yet
get a sign-in reminder; a healthy repo gets a short snapshot and a routed action.

It **never** re-implements another skill's workflow — it only reads state and
invokes an existing skill or an existing Jolli Memory tool.

${SHELL_PREREQUISITE_BLOCK}

Getting this wrong is worse here than in the other skills: Step 0 reads a failed
\`test -f\` as "the dispatcher is not installed" and sends the user off to re-trust
a SessionStart hook that was working all along. Run the check in the wrong shell
and that verdict is simply false.

## Step 0 — confirm this menu can route

The plugin's SessionStart hook is what installs the CLI dispatcher AND what
registers the Jolli Memory MCP server, so on the FIRST session after install
neither is reachable yet: the hook has to be trusted, and Codex reads its MCP
registrations at session start, so the server appears from the NEXT session on.
That is expected, not a fault. Confirm at least one routing target exists before
anything else:

- one or more Jolli Memory MCP tools are available. They are BARE names inside the
  \`mcp__jollimemory\` namespace on Codex, so a \`mcp__jollimemory__\` prefix match
  finds nothing — look for the namespace, and search your available tools before
  concluding none are registered; or
- the bundled CLI dispatcher exists:

  \`\`\`bash
  test -f "$HOME/.jolli/jollimemory/run-cli" && echo present
  \`\`\`

The dispatcher alone is enough to run every step below — each one names a CLI
fallback. If ONLY the dispatcher is present, use it and mention once that the MCP
tools become available in the next session.

If neither is reachable, tell the user to start a new Codex session and trust the
Jolli SessionStart hook in \`/hooks\`, then stop. Do not guess at install paths and
do not invoke another \`jolli:*\` skill — they share this session's plumbing.

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
  summaries (e.g. "Codex"). Surfaced ONLY when \`aiProvider\` is \`local-agent\`.
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
    that field names, Codex/ChatGPT on a fresh setup — with no API key and no Jolli
    sign-in. This is the plugin's default, so a freshly installed repo can already
    generate. Report the field, never assume Codex: an agent tool the user had
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
  \`jolli:init\` skill, which owns enable → sign-in → bind a Space. Do not
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
  line here (binding is \`jolli:init\`'s job).

  The closing \`Jolli is listening — …\` line uses **"last memory saved."** when
  \`storedMemories\` > 0, or **"your next commit is your first memory"** when it
  is 0.

### Sign-in nudge — only when **can sync** is false

Generation working does not mean memories are shared. When the user can generate
but **can sync** is false (the normal state of a fresh \`local-agent\` install),
add ONE line under the snapshot, mirroring the CLI front door's optional sign-in
step:

\`\`\`
Sign in to Jolli to sync memories to a Space? (jolli:login — memory generation keeps running locally either way)
\`\`\`

Rules for the nudge:

- It is **non-blocking**. Never withhold the Step 3 menu waiting for an answer,
  and never report "not signed in" as broken — the repository is capturing
  memories.
- Offer it **once** per invocation. If the user declines, drop it for the rest of
  the session.
- If the user accepts, invoke the \`jolli:login\` skill (or \`jolli:init\` when they
  also want to bind a Space in the same pass). Never run \`auth login\` yourself
  here, and never ask for a password, token, or callback URL.
- Skip it when **can sync** is true, and inside the "Not fully set up" branch —
  there \`jolli:init\` already walks sign-in.

## Step 3 — route the request / present the menu

This skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one action below and invoke that
  action directly, regardless of the Step 2 state — a specific request wins over
  the setup nudge. The invoked skill handles its own preconditions (for example
  \`jolli:push\` offers to bind a Space when the repo is unbound). Ask the user to
  choose only when the request is ambiguous or matches no action.
- **Argument absent** → after the Step 2 guidance, list the actions as plain text
  and ask the user to pick one (Codex has no interactive single-select). Bias the
  ordering to the state: when \`storedMemories\` is 0, lead with \`jolli:init\` as
  the FIRST option and demote recall / search below it, since on a fresh repo both
  would only return empty. When memories exist, lead with recall / search. Keep
  \`jolli:init\` available either way for re-running setup or re-binding a Space.

### Jolli skills

- \`jolli:init\` — finish setup, or change the bound Space.
- \`jolli:recall\` — recall current-branch context.
- \`jolli:search\` — search decisions across branches.
- \`jolli:status\` — inspect installation and queue health.
- \`jolli:dashboard\` — open the local dashboard in a browser (machine-wide
  memories, sessions, token spend, knowledge).
- \`jolli:timeline\` — show a decision topic's history.
- \`jolli:push\` — publish this branch's memories to a Space.
- \`jolli:login\` — sign in to Jolli so memories can sync to a Space. Surface this
  whenever **can sync** is false, even if the user did not pick it.
- \`jolli:logout\` — clear the stored Jolli credentials.
- \`jolli:local-run\` / \`jolli:remote-run\` — run a Jolli workflow locally or on
  the Jolli backend.

Route a choice by invoking that skill; do not restate its steps here.

### Jolli Memory tools (whatever is registered this session)

Surface the Jolli Memory MCP tools actually available this session — do not assume
a fixed list, and remember they are bare names inside the \`mcp__jollimemory\`
namespace. Route a choice by calling the matching tool. One combination is worth
offering explicitly:

- **PR description** — call \`queue_status\` first, then \`get_pr_description\`, so
  the description covers memories that are still being generated.

If no Jolli Memory tools are registered, present just the skills above.
`;
}

export function buildCodexInitSkillTemplate(): string {
	return `---
name: init
description: "Set up Jolli Memory for the current repository in Codex: verify the plugin hook, enable memory generation through Codex, sign in to Jolli when sharing is requested, and bind the repo to a Jolli Space. Use for first-time setup, repair, enablement, or Space binding."
---

# Jolli Init

Complete the steps in order. Stop when a required step fails.

${SHELL_PREREQUISITE_BLOCK}

## 1. Inspect state

Call the Jolli Memory \`status\` tool. If unavailable, run \`${RUN_CLI} status\`.
If the dispatcher is missing, ask the user to start a new Codex session, open
\`/hooks\`, trust the Jolli SessionStart hook, and retry.

## 2. Enable local memory generation

Run:

\`\`\`bash
${RUN_CLI} enable --repo-hooks-only --source-tag codex-plugin
\`\`\`

This explicit setup records \`codex\` as the local-agent tool only when none is
configured yet — an agent tool and a paid provider already on disk are both left
exactly as they are. It also registers the Jolli Memory MCP server for
Codex, which Codex picks up at the START of a session — so if the MCP tools were
missing in this session, they appear in the next one. If the command reports that
the repository is manually disabled, explain that an explicit full \`jolli enable\`
is required to clear the opt-out; do not silently override it.

## 3. Decide whether Jolli sign-in is needed

Local memory generation uses the user's Codex/ChatGPT login and needs no Jolli
account. Jolli sign-in is required to bind and share with a Space.

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
  \`localAgentTool\` from \`status\` rather than assuming Codex, since a tool that
  was already configured is left alone;
- Jolli sign-in and bound Space when sharing was configured;
- a normal commit captures memory and \`git push\` publishes to the bound Space;
- when the MCP tools were unavailable this session, that they load on the next one.
`;
}

export function buildCodexLoginSkillTemplate(): string {
	return `---
name: login
description: Sign in to Jolli from Codex so the repository can bind to a Jolli Space and share memories. Use when the user asks to log in, authenticate Jolli, connect an account, or fix missing Jolli credentials.
---

# Jolli Login

${SHELL_PREREQUISITE_BLOCK}

Run and wait for the interactive browser flow:

\`\`\`bash
${RUN_CLI} auth login
\`\`\`

Never ask the user for passwords, API keys, callback URLs, or browser tokens.

On success, say that Jolli credentials were saved and offer \`jolli:init\` to bind
the repository to a Space. Clarify that local memory generation still uses the
configured local agent unless the user explicitly changes providers. On failure,
surface the command's reason and suggest retrying; if the browser did not open,
point out the login URL printed by the command. If the dispatcher does not exist,
ask the user to start a new Codex session, review the Jolli hook in \`/hooks\`,
and retry.
`;
}

export function buildCodexLogoutSkillTemplate(): string {
	return `---
name: logout
description: Sign out of Jolli from Codex by clearing the stored Jolli auth token and Jolli API key while preserving other provider credentials. Use when the user asks to log out, disconnect Jolli, or remove Jolli account credentials.
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

If the dispatcher does not exist, ask the user to start a new Codex session,
review the Jolli hook in \`/hooks\`, and retry.
`;
}

export function buildCodexStatusSkillTemplate(): string {
	return `---
name: status
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
list branch memories; route those requests to \`jolli:recall\` or \`jolli:search\`.

${SHELL_PREREQUISITE_BLOCK}
`;
}

export function buildCodexTimelineSkillTemplate(): string {
	return `---
name: timeline
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

export function buildCodexPushSkillTemplate(): string {
	return `---
name: push
description: Publish the current branch's Jolli memories to a Jolli Space. Use when the user asks to push, publish, share, or sync memories or decisions with a team.
---

# Jolli Push

1. Call \`queue_status\` with waiting enabled so newly committed memories are ready.
2. Call \`push_memory\` for the current branch.
3. If it returns \`binding_required\`, present the returned Spaces, ask the user to
   choose one, then call \`push_memory\` again with that Space. If authentication is
   missing, route to \`jolli:login\` and stop; never request credentials in chat.
4. On success, report the Space and article links. Offer to open links when the host
   provides a browser action.
5. On partial or failed publication, report the exact result and do not claim all
   memories were shared.
`;
}

/** A skill the plugin ships: its bundle directory name plus the canonical builder. */
export interface CodexPluginSkill {
	readonly name: string;
	readonly build: () => string;
}

/**
 * Skills generated from canonical builders, keyed by their directory name.
 *
 * Names are BARE (`recall`, not `jolli-recall`), matching the Claude plugin's
 * `skills/recall/` + `commands/init.md` layout. Codex namespaces a plugin's skills
 * by the plugin's own name, exactly as Claude does: the model sees
 * `jolli:recall` — verified on codex-cli 0.146.0 via `codex debug prompt-input`,
 * where an installed plugin's skills render as `<plugin>:<skill>` (`j:worktree`,
 * `pdf:pdf`) while `~/.codex/skills/` and a repository's `.agents/skills/` render
 * bare. An earlier revision carried a `jolli-` prefix on the belief that plugin
 * skills shared ONE flat namespace with those two directories and that a bare
 * `recall` would collide; the probe disproved it (a repo-local `worktree` and the
 * plugin's `j:worktree` coexist, neither shadowing the other), and the prefix only
 * produced stuttering `jolli:jolli-recall` names.
 *
 * Consequence for {@link renderCodexPluginSkill}: the four shared builders live in
 * `SkillInstaller` and still declare the prefixed CLI names (`.agents/skills/` has
 * no namespace, so `jolli-recall` is right THERE), so the plugin copy has to be
 * re-headed with the bare name and its sibling references re-pointed at
 * `jolli:<name>`.
 */
export const CODEX_PLUGIN_SKILLS: ReadonlyArray<CodexPluginSkill> = [
	{ name: "jolli", build: buildCodexJolliSkillTemplate },
	{ name: "init", build: buildCodexInitSkillTemplate },
	{ name: "login", build: buildCodexLoginSkillTemplate },
	{ name: "logout", build: buildCodexLogoutSkillTemplate },
	{ name: "status", build: buildCodexStatusSkillTemplate },
	{ name: "dashboard", build: buildDashboardSkillTemplate },
	{ name: "timeline", build: buildCodexTimelineSkillTemplate },
	{ name: "push", build: buildCodexPushSkillTemplate },
	{ name: "recall", build: buildRecallSkillTemplate },
	{ name: "search", build: buildSearchSkillTemplate },
	{ name: "local-run", build: buildLocalRunSkillTemplate },
	{ name: "remote-run", build: buildRemoteRunSkillTemplate },
];

/**
 * Complete bundle-directory inventory exposed by the Codex plugin.
 *
 * Two consumers, both treating it as an exact set (never a glob): the drift test
 * asserts it equals the committed `skills/` directories, and
 * `PUBLISH_EXPECTED_SKILLS` in `codex-plugin/scripts/_publish-lib.sh` mirrors it so a
 * `.gitignore` rule cannot silently drop a `SKILL.md`.
 *
 * NOT an install-side removal list. The bootstrap deliberately leaves
 * `.agents/skills/` alone — that directory is cross-platform, so deleting an active
 * skill from it to de-duplicate Codex's picker takes the only copy Cursor, Gemini,
 * OpenCode, Windsurf and Copilot have. See the Codex branch of the repo-hooks-only
 * bootstrap in `Installer.ts` for the full history.
 *
 * Note these are the plugin's BARE names — the model-visible form adds the `jolli:`
 * namespace — so they do not line up with the prefixed names a full `jolli enable`
 * writes into `.agents/skills/` anyway.
 */
export const CODEX_PLUGIN_SKILL_NAMES: ReadonlyArray<string> = CODEX_PLUGIN_SKILLS.map((skill) => skill.name);

/**
 * Canonical CLI skill name → this plugin's model-visible invocation name.
 *
 * Only the four shared builders need an entry: they are authored for
 * `.agents/skills/`, which has no namespace, so their `name:` field and their
 * sibling references both use the prefixed form. The Codex-only templates in this
 * file already write `jolli:<name>` directly, so nothing here matches them.
 */
const SHARED_SKILL_INVOCATION_NAMES: Readonly<Record<string, string>> = {
	"jolli-recall": "jolli:recall",
	"jolli-search": "jolli:search",
	"jolli-local-run": "jolli:local-run",
	"jolli-remote-run": "jolli:remote-run",
};

/**
 * Codex's own answer to a missing dispatcher, and the phrase that marks a body as
 * already carrying it.
 *
 * Four bodies in this file route the user to Codex's `/hooks` panel, in three different
 * sentences ("trust the Jolli SessionStart hook in `/hooks`", "open `/hooks`, trust the
 * Jolli SessionStart hook", "review the Jolli hook in `/hooks`"), so the backticked
 * path is the one token all three share. The backticks matter: a bare `/hooks` would
 * also match a `.git/hooks` mention and silently exempt a body that answers nothing.
 */
export const CODEX_HOOKS_PANEL_MARKER = "`/hooks`";

/**
 * Appended by {@link renderCodexPluginSkill} to a bundled body that shells `run-cli`
 * without already routing to `/hooks` — see {@link appendDispatcherRecovery} for the
 * shape and for why this belongs to the renderer.
 *
 * The remedy is this host's, and it is NOT Cursor's: on Codex the plugin's SessionStart
 * hook has to be TRUSTED before it runs, and Codex reads its MCP registrations at
 * session start, so the first session after an install reaches neither the dispatcher
 * nor the tools. That is the sentence the umbrella's Step 0 and `init` already use;
 * this is the same answer, given to the skills that had none.
 */
export const CODEX_DISPATCHER_RECOVERY_SECTION = `
## If the Jolli CLI dispatcher is missing (Codex)

\`$HOME/.jolli/jollimemory/run-cli\` is written by this plugin's SessionStart hook,
and that hook does not run until it has been trusted. So when that file does not
exist, ask the user to start a new Codex session and trust the Jolli SessionStart
hook in \`/hooks\`, then retry. The Jolli Memory MCP tools arrive the same way, one
session later — Codex reads its registrations at session start.

This REPLACES any instruction above to report Jolli as not installed, or to install
\`@jolli.ai/cli\` globally or the Jolli VS Code extension. You are running inside the
Jolli plugin, so Jolli IS installed, and neither of those is the fix on this host.
`;

/**
 * The exact bytes the plugin's `skills/<name>/SKILL.md` must contain.
 *
 * Four adaptations of the canonical text. Three are consequences of one document
 * serving two hosts: drop the upsert-only `metadata:` block, re-head it with the
 * plugin's bare name, and re-point sibling references at their `jolli:*` invocation
 * names — a bundled copy telling the model to "run jolli-recall" would name a skill
 * that does not exist on a plugin-only install. The fourth is
 * {@link CODEX_DISPATCHER_RECOVERY_SECTION}, and it runs LAST on purpose: the sibling
 * rewrite is a plain substring replace, so appending afterwards keeps the note out of
 * its reach instead of depending on the note never containing one of those four names.
 */
export function renderCodexPluginSkill(skill: CodexPluginSkill): string {
	let rendered = setFrontmatterName(stripMetadataBlock(skill.build()), skill.name);
	for (const [canonical, invocation] of Object.entries(SHARED_SKILL_INVOCATION_NAMES)) {
		rendered = rendered.split(canonical).join(invocation);
	}
	return appendDispatcherRecovery(rendered, {
		marker: CODEX_HOOKS_PANEL_MARKER,
		section: CODEX_DISPATCHER_RECOVERY_SECTION,
	});
}
