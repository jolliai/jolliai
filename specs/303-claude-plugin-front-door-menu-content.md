# 303. Claude Plugin Front-Door Menu Content

## Topic Statement

The instruction document of the Claude-plugin bootstrap companion menu describes a **state-aware** bare `/jolli` front door: before doing anything it confirms it still has a routing target in this session, then it reads the repository's Jolli setup from the `status` MCP tool, derives two independent capabilities — "can generate memories" (provider-aware) and "can sync memories" (Jolli-credential-only) — and takes exactly one of two branches: steer the user into `/jolli:init` when setup is incomplete, or print a short `✓` snapshot, optionally attach a one-line sign-in nudge, and present an action menu whose ordering is biased by how many memories the repository holds. It never re-implements an action; it only reads status and invokes an existing skill, names a slash command, or calls an MCP tool.

## Scope

**In scope.** The skill name; the frontmatter field values specific to this companion; the content revision integer and the ordering invariant that binds it to the standalone umbrella menu's; the body's structural sections (title, purpose paragraph, four numbered steps, the nudge sub-section, the three action sub-sections); the routing precondition and its two-case stale-leftover messaging; the status fields the document instructs the agent to read and the conditional-surfacing rules those fields obey; the two capability derivations, arm by arm; the two branches (steer into setup vs. print the snapshot); the snapshot's state-selected first line, its conditional syncing line, and both closing-line variants; the non-blocking sign-in nudge and its rules; the state-biased menu ordering; the three action sources (the plugin's namespaced skills, the plugin's slash commands, and whatever Jolli MCP tools are registered); and the repository-level guard that pins each body to its declared revision.

**Out of scope.**

- **The write of this document** — when it happens, where it lands, the ownership-marker guard that refuses to clobber a same-named user file, the before/after canonicality comparison, and the same-session skill-reload signal — is owned by spec 290 (the plugin session-bootstrap hook), which explicitly disclaims owning this body. Spec 48 owns the shared revision-guard mechanics (disk revision greater than ours → skip; equal → skip; lower → write) and the frontmatter schema.
- **The `status` tool this document reads** — its result shape, the conditional-surfacing rules' implementation, and every other field it returns (version, hook rows, integration rows, session count, migration wording, orphan branch, site label) — is owned by spec 148.
- **The command-line front door** (spec 265) and its shared "can generate right now" capability predicate (spec 291). This document *mirrors* that flow's shape — capability ladder, `✓` snapshot, optional sign-in step, `Jolli is listening — …` closer — but it **re-derives** both capabilities from status fields in prose rather than sharing the command-line predicate's code. In particular it does no local-agent CLI probe: the command-line predicate actually executes the agent binary, while this document trusts the provider field alone.
- **The content of the standalone umbrella menu** (spec 272) — a passive, action-listing document written into the cross-platform agent-skills slot. This companion is a distinct variant, not a copy.
- **The Codex plugin's bundled front-door menu** (spec 330) — a third body, shaped like this one but carrying no frontmatter metadata block, a different precondition, and a different tool-lookup rule.
- **The content of the skills and commands this menu routes to**, and the plugin package that ships them namespaced (spec 282), which twice defers this document's body to "its own spec". Spec 282 is also the authority on which of the routed targets is shipped as a skill and which as a command.
- **Space binding.** The document reads a bound-Space name for one snapshot line only and is explicitly told not to (re)bind; binding stays `/jolli:init`'s and `/jolli:push`'s job.

## Data Contracts

### Skill name

`jolli`. The value is both the skill directory name and the frontmatter `name`, so it surfaces as a bare `/jolli`. That bare form is the entire reason this companion exists: a plugin skill can only ever be invoked as `/jolli:<name>`, so the ecosystem's mandatory bare entry point has to come from a project skill written outside the plugin's own bundle (spec 290).

### Frontmatter values

Spec-compliant only — `name`, `description`, and a nested `metadata` block. No host-private fields (notably no `argument-hint` and no `user-invocable`).

| Field | Value |
|---|---|
| `name` | `jolli` |
| `description` | `The Jolli front door — checks how Jolli is set up in this repo, guides first-time setup through /jolli:init when something's missing, reminds you to sign in when memories can't sync yet, and otherwise shows a status snapshot and routes you to the right Jolli skill or MCP tool. Use when the user types /jolli or asks for Jolli / the Jolli menu.` |
| `metadata.version` | the bundled release version at write time (spec 48) |
| `metadata.revision` | `8` |
| `metadata.vendor` | `jolli.ai` |

### Content revision and the ordering invariant

This companion's `metadata.revision` is **8**. The standalone umbrella menu's (spec 272) is **6**.

The invariant is that this companion's revision must stay **strictly greater** than the standalone umbrella's. Both documents claim the same skill name and both carry `vendor: "jolli.ai"`, so the ownership guard cannot tell them apart — arbitration between them is purely by revision. A pre-upgrade install may still have the *standalone* menu sitting in the Claude-Code skills slot, routing to unnamespaced sibling skills that the plugin's bootstrap deletes; this companion must outrank it so the bootstrap **reclaims that slot in place** rather than leaving a menu that points at nothing. The bare `jolli` directory is deliberately the one directory the legacy sweep never deletes, precisely because it is overwritten in place instead.

A repository-level guard enforces both halves: one assertion pins each shipped body to a stable fingerprint alongside its declared revision, and a separate assertion asserts this companion's revision is strictly greater than the standalone's. The fingerprint deliberately strips the frontmatter's release-version line, so a routine release bump does not churn it — it fires only on a *body* edit. Because the write guard treats an equal on-disk revision as "skip", editing a body without bumping its revision would otherwise ship nothing at all: every existing install would silently keep the old text. The guard converts that silent no-op into a build failure.

### The document's own preamble

The body opens with a purpose paragraph that names **eight** namespaced entry points as continuing to work unchanged — `/jolli:init`, `/jolli:recall`, `/jolli:search`, `/jolli:push`, `/jolli:login`, `/jolli:logout`, `/jolli:status`, `/jolli:timeline` — and states that this menu is layered on top of them, never a replacement. It also states the three-way summary of what follows: incomplete setup walks into `/jolli:init`; capture-without-sharing gets a sign-in reminder; a fully wired repo gets a snapshot and a routed action.

### Status fields the document instructs the agent to read

The document names the `status` MCP tool (on Claude Code, `mcp__jollimemory__status`), called with no arguments, and enumerates these fields:

| Field | What the document says it is | Surfacing |
|---|---|---|
| `enabled` | are the git hooks installed in this repo (is memory generation on) | always |
| `account.signedIn` | is the user signed in to Jolli | always |
| `account.jolliApiKeyConfigured` | is a stored Jolli API key present | **only when signed OUT** — a sign-in already implies a Jolli credential, so the field is omitted once `account.signedIn` is true |
| `account.anthropicKeyConfigured` | is an Anthropic key present | **only when `account.aiProvider === "anthropic"`**; omitted for every other provider |
| `account.aiProvider` | one of `"local-agent"`, `"jolli"`, `"anthropic"`, `null` — drives the provider-aware generation check | always |
| `account.localAgentTool` | the label of the local agent CLI that generates summaries (the document's example: "Claude Code"); feeds the snapshot's engine suffix | **only when `account.aiProvider === "local-agent"`** |
| `account.site` | the Jolli site host, for the snapshot line | always |
| `storedMemories` | how many memories this repo already has | always |
| `space` | the bound Jolli Space (`{ name }`) this repo's memories sync to, or `null` when unbound; drives the syncing snapshot line | always (may be `null`) |

Every field the derivations depend on is in this list — the provider selector and the local-agent tool label are both enumerated here, each with its own surfacing rule, so an agent that reads only this list can still take every arm of Step 2.

In every conditional case above, omission is **by field absence** — the key is simply not present — not by the field carrying a false value. A consumer that tests truthiness on an absent key happens to land on the same answer; a consumer that distinguishes "absent" from "false" must treat absent as "moot for this provider", not as "no".

The document also states that `space` is **display-only**: it names the bound Space for the snapshot but does not confirm push health, and full binding management stays `/jolli:init`'s and `/jolli:push`'s job.

### Fallback read

If the `status` MCP tool is unavailable (an older Jolli), the document instructs the agent to read the same facts from the printed output of the bundled CLI, invoked through its stable dispatch script:

```bash
"$HOME/.jolli/jollimemory/run-cli" status
```

If neither the tool nor the CLI can be reached at all, the state-based guidance is skipped entirely and the agent goes straight to the action menu, presenting it **without a snapshot**.

### The two capability derivations

**Can generate memories** — the document is explicit that this is **provider-AWARE, NOT a blind OR of every field**. It reads `account.aiProvider` and takes one arm:

| `account.aiProvider` | Can generate memories |
|---|---|
| `local-agent` | **yes**, unconditionally — generation runs through the user's local agent CLI named by `account.localAgentTool`, needing no API key and no Jolli sign-in. The document notes this is the plugin's default, so a freshly-installed plugin repo can already generate. |
| `jolli` | yes if `account.signedIn` **OR** `account.jolliApiKeyConfigured` |
| `anthropic` | yes **only** if `account.anthropicKeyConfigured` |
| `null` / unset | yes if `account.signedIn` **OR** `account.jolliApiKeyConfigured` |

The document then states the asymmetry outright: for the Jolli proxy a sign-in **does** carry a generation credential — signing in mints a Jolli API key, which is why `jolliApiKeyConfigured` is omitted once signed in — while for the `anthropic` provider **sign-in alone does NOT count**.

**Can sync memories** = `account.signedIn` **OR** `account.jolliApiKeyConfigured`. Declared **provider-independent**: sharing to a Jolli Space always needs a *Jolli* credential, so an Anthropic key never satisfies it. The document states outright that this axis is orthogonal to generation — a default `local-agent` repo generates fine while unable to sync, and that exact state is what the sign-in nudge exists for.

**Enabled** is the `enabled` flag as-is.

### The status snapshot block

On the fully-set-up branch the document prints, verbatim:

```
✓ signed in · <account.site> · summaries via <account.localAgentTool>
✓ enabled · <storedMemories> memories
✓ syncing · Space "<space.name>"    (ONLY when `space` is non-null; omit the whole line otherwise)

Jolli is listening — last memory saved.
```

Four rules qualify it:

- **The first line is selected by state**, and the document says it mirrors the command-line front door's wording exactly:
  - signed in → `✓ signed in · <account.site>`, **plus** the suffix ` · summaries via <account.localAgentTool>` when `account.aiProvider` is `local-agent`. The `· <site>` segment is **dropped** when `account.site` is null.
  - not signed in, `local-agent` → `✓ local agent set (not signed in to Jolli)`
  - not signed in, `jolli` → `✓ Jolli API key set (not signed in to Jolli)`
  - not signed in, `anthropic` → `✓ Anthropic API key set (not signed in to Jolli)`
- The `✓ syncing · Space "<space.name>"` line renders **only when `space` is non-null** — it means a `git push` auto-publishes this branch's memories to that Space via the pre-push hook. When `space` is null the whole line is dropped; the document forbids printing a "not bound" line in its place, because binding is `/jolli:init`'s job.
- The closing line mirrors the command-line front door and has exactly two variants: **`Jolli is listening — last memory saved.`** when `storedMemories` > 0, and **`your next commit is your first memory`** when `storedMemories` is 0.
- When `storedMemories` is 0 the menu is still shown, but the ordering rule below applies.

### The sign-in nudge

Rendered **only when "can sync" is false**, as ONE line under the snapshot, mirroring the command-line front door's optional sign-in step:

```
Sign in to Jolli to sync memories to a Space? (/jolli:login — memory generation keeps running locally either way)
```

Its rules, as the document states them:

- **Non-blocking.** The Step 3 menu is never withheld waiting for an answer, and "not signed in" is never to be treated as broken — the repo *is* capturing memories.
- **Offered once per invocation.** If the user declines, it is dropped for the rest of the session and not repeated after later actions.
- **On acceptance, hand off.** Tell the user to run `/jolli:login` — the document notes a skill cannot invoke a slash command for them — or invoke `jolli:init` when they also want to bind a Space in the same pass. Running the sign-in command directly from here is forbidden; `/jolli:login` owns that flow.
- **Skipped entirely** when "can sync" is true, and inside the not-fully-set-up branch (where `/jolli:init` already walks sign-in).

### The action menu

Three sources, each routed by invoking or naming rather than re-implementing.

**The plugin's namespaced skills** — listed only if confirmed available by the routing precondition, each routed by invoking that skill through the host's Skill tool:

- **`/jolli:init`** — set up Jolli for this repo: sign in if needed, enable memory generation, and bind the repo to a Jolli Space.
- **`/jolli:recall`** — recall prior development context for the current branch.
- **`/jolli:search`** — search structured commit memories across branches (decisions, topics, files).
- **`/jolli:push`** — publish this branch's memories to a Jolli Space.

**The plugin's slash commands** — a separate section, introduced with the rule that *a skill cannot invoke a command*, so a choice here is routed either by telling the user to run it (one line, command spelled out) or by calling the equivalent MCP tool where one exists:

- **`/jolli:login`** — sign in so this repo can bind a Space and share memories. **Surfaced whenever "can sync" is false, even if the user did not pick it.** The document adds that generation is unaffected by signing in.
- **`/jolli:logout`** — clear the stored Jolli credentials.
- **`/jolli:status`** — full installation / queue health; prefer the `status` MCP tool when it is registered.
- **`/jolli:timeline`** — how one decision topic evolved; prefer the `get_decision_timeline` MCP tool when it is registered.

**Jolli MCP tools registered this session** — every tool whose name **contains** `jollimemory`, examples given being `recall`, `search`, `get_pr_description`, `queue_status`, `status`, and the Space tools (`list_spaces`, `bind_space`, `push_memory`). The document forbids assuming a fixed list and says that when no Jolli MCP tools are registered, only the plugin skills are presented.

There is no `/jolli:pr` entry — the plugin ships no such target and the menu must not route to one.

Unlike the standalone menu (spec 272), this companion carries **no workflow actions** (no run-a-workflow branch, no workflow-history recipe), **no exclusion list**, and **no host-specific tool-discovery guidance** — and therefore no shell-prerequisite block for a workflow recipe.

## Behavior

The following is what the document instructs the host LLM to do at runtime, in step order.

### Step 0 — confirm this menu can route

The document opens by explaining its own fragility: it is a project skill written **outside** the plugin (a plugin skill could only ever be `/jolli:<name>`, never a bare `/jolli`), so it can linger in `.claude/skills/jolli/` after the plugin has been uninstalled. It can only route to targets that exist in this session, so before anything else the agent confirms at least one routing target is available. The menu can route if **either**:

- one or more MCP tools whose name contains `jollimemory` are registered, **or**
- the plugin's own namespaced skills (`jolli:init` / `jolli:recall` / `jolli:search` / `jolli:push`) are invocable this session.

If **either** holds, proceed to Step 1.

If **neither** holds, the agent must not build the menu and must not invoke any `/jolli:*` skill — it is not registered and the call will fail. But the document insists this alone does **not** mean Jolli is gone: the CLI installs a memory pipeline (git hooks that generate memories on every commit) that runs independently of the plugin. So the agent distinguishes two cases by probing for the bundled CLI dispatch:

```bash
test -f "$HOME/.jolli/jollimemory/run-cli" && echo present
```

- **CLI present** → Jolli still works; only the plugin's interactive menu is not loaded in this session. Tell the user plainly: the plugin menu isn't loaded here, but the CLI is still installed — commits still generate memories, and `jolli recall` / `jolli search` can be run directly. This `/jolli` file is a leftover from a previous plugin install; it can be removed with `rm -rf .claude/skills/jolli`, and reinstalling the plugin brings the menu back.
- **CLI absent** → Jolli is no longer installed at all. Tell the user this `/jolli` menu is a stale leftover, removable with `rm -rf .claude/skills/jolli`, and that (re)installing Jolli brings it back.

Either way the agent then **stops** — it does not continue to Step 1.

### Step 1 — read how Jolli is set up

Read the current state so the front door can guide rather than guess. The preferred read is the `status` MCP tool with no arguments; the fallback is the bundled CLI's `status` through its dispatch script; an unreachable pair degrades to Step 3's menu without a snapshot. The fields read and their conditional-surfacing rules are in Data Contracts.

### Step 2 — guide by state

Derive **can generate memories** (provider-aware), **can sync memories** (Jolli-credential-only), and **enabled** (the flag as-is) per the tables in Data Contracts, then take exactly one branch:

- **Not fully set up** — `enabled` is false, **OR** memories can't be generated. Memory generation isn't wired yet, so the agent leads with **setup**, not the action menu: state in one line what's missing (the document's own example: *"not signed in, and memory generation is off for this repo"*), then invoke the `jolli:init` skill through the Skill tool, which walks sign-in → enable → bind a Space in one guided pass. The agent must not hand-roll those steps. One exception: an argument that clearly names a different action is honored instead (see Step 3). The sign-in nudge is suppressed on this branch.
- **Fully set up** — enabled **and** generation possible. Print the snapshot block; then, **only when "can sync" is false**, attach the one-line sign-in nudge; then continue to Step 3.

When `storedMemories` is 0 the menu is still shown, but Step 3 leads it with `/jolli:init`, because on a fresh repo recall and search would only return empty and so must not be the default action.

### Step 3 — route the request / present the menu

The skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one action and invoke that action directly (invoke the skill, name the command, or call the Jolli MCP tool) **regardless of the Step 2 state** — a specific request wins over the setup nudge. The invoked skill handles its own preconditions (the document's example: `/jolli:push` will offer to bind a Space if the repo isn't bound). The agent asks the user to choose only when the request is ambiguous or matches no action.
- **Argument absent** → after the Step 2 guidance, present the action menu and let the user pick, using an interactive single-select tool where the host provides one (AskUserQuestion on Claude Code is given as an example only); otherwise list the options as plain text and ask. Then invoke the corresponding skill or MCP tool, or name the corresponding command.

**Menu ordering is biased by state.** When `storedMemories` is 0, `/jolli:init` is the **first (default)** option — finish setup / bind a Space, or just make the first commit — and recall / search are demoted below it, since on a fresh repo both would only return empty. When memories exist, recall / search lead instead. Either way `/jolli:init` stays available for re-running setup or re-binding a Space.

## State Transitions

The document's own decision tree, from observed state to outcome:

| Observed state | Outcome |
|---|---|
| No routing target this session, bundled CLI dispatch **present** | "plugin menu not loaded, CLI still works" message + self-removal hint; stop. No menu, no skill invocation. |
| No routing target this session, bundled CLI dispatch **absent** | "stale leftover, Jolli not installed" message + self-removal hint; stop. |
| Routing target exists, neither status tool nor CLI reachable | Skip state guidance; present the action menu with **no** snapshot. |
| `enabled` false, or can't generate | One-line statement of what's missing, then invoke `jolli:init`. No snapshot, no nudge, no menu. |
| Enabled, can generate, can sync | Snapshot, **no** nudge, then the menu. |
| Enabled, can generate, cannot sync | Snapshot **plus** the one-line sign-in nudge, then the menu (never blocked on an answer). |
| Enabled, can generate, `storedMemories` = 0 | Snapshot (closing line: *your next commit is your first memory*), then the menu **led by `/jolli:init`** with recall / search demoted. |
| Enabled, can generate, `storedMemories` > 0 | Snapshot (closing line: *Jolli is listening — last memory saved.*), then the menu **led by recall / search**. |
| Signed in, `aiProvider` = `local-agent` | First snapshot line carries the ` · summaries via <tool>` engine suffix. |
| Signed in, `account.site` null | First snapshot line drops the `· <site>` segment. |
| Not signed in (any provider) | First snapshot line becomes that provider's `✓ … set (not signed in to Jolli)` variant. |
| `space` null (any branch that prints a snapshot) | The `✓ syncing · Space "…"` line is dropped entirely; no substitute "not bound" line. |
| Any of the above, but an argument was supplied naming one action | That action is invoked directly, overriding the setup nudge and the menu. |

## Notable Behavior

- **This is a state-aware front door, not a static action list.** That is the whole difference from the standalone umbrella menu (spec 272): it reads the repository's actual setup and either steers into setup or reports a snapshot before it will show a menu at all. (Notable; load-bearing.)
- **It is still a front door, never a second execution path.** It only reads status and invokes an existing skill, names an existing command, or calls an existing MCP tool; it re-implements no action, and the namespaced `/jolli:*` entry points keep working unchanged. (Notable.)
- **Generating and sharing are two independent axes, and the default install sits between them.** "Can generate" is provider-aware while "can sync" needs a Jolli credential regardless of provider — so the plugin's default `local-agent` repo is *fully set up* for the purposes of the setup branch while still unable to publish anything. That exact gap is the only state the sign-in nudge renders in. (Surprising; load-bearing — an implementation that ORed the two axes into one would push a working repo into setup it does not need.)
- **The sign-in nudge is a nudge, never a gate.** It is one line, offered once per invocation, never blocks the menu, and explicitly forbids treating "not signed in" as broken. There is nowhere for a static document to persist a "don't ask again" answer, so declining it holds only for the session. (Notable.)
- **Step 0 exists because this document outlives the plugin that caused it to be written.** It lives in the user's repo, not in the plugin bundle, so a plugin uninstall never reaches it. Without the precondition it would confidently invoke `/jolli:*` targets that no longer exist. (Notable; load-bearing.)
- **The two stale-leftover messages are deliberately distinct, and the CLI probe is what separates them.** Reporting "Jolli is uninstalled" when only the plugin's menu is unloaded would be a false claim — the git-hook memory pipeline is independent of the plugin, so a working CLI must never be mis-reported as gone. (Notable; load-bearing.)
- **The capability derivation is provider-aware, and a sign-in's meaning depends on the provider.** For the Jolli proxy a sign-in *is* a generation credential (it mints a Jolli API key); for the Anthropic provider it is not. (Notable; load-bearing.)
- **Conditional status fields are omitted by absence, not falsified.** The stored-product-key field appears only when signed out, the vendor-key field only under the vendor provider, and the local-agent tool label only under the local-agent provider — each simply missing otherwise. The document's own field enumeration restates each rule inline, so the contract is legible from the document alone. (Notable.)
- **The snapshot's first line has four mutually exclusive forms plus two independent modifiers.** Signed-in selects one form; the local-agent provider then appends an engine suffix to it; a null site removes a segment from it. The three not-signed-in forms differ only by provider and all carry the same parenthetical. A reader who treats the printed block as a fixed template gets the signed-in form for everyone. (Surprising.)
- **`/jolli:init` is presented as a skill and routed through the Skill tool, while the plugin ships it as a slash command.** The routing precondition also counts `jolli:init` among "the plugin's own namespaced skills", and the not-fully-set-up branch instructs the agent to invoke it through the Skill tool — yet the same document's command section states that a skill cannot invoke a command, and the plugin's own asset inventory (spec 282) carries `init` alongside `login` / `logout` / `status` / `timeline` as a command, not among its skills. The setup branch is therefore instructed to reach its target by a mechanism that does not apply to it. (Surprising; recorded as reality.)
- **Bound-Space state is display-only and never gated on.** The setup branch keys off `enabled` and generation capability alone; an unbound repo that can generate is still "fully set up" for this document's purposes, and binding is left to `/jolli:init` and `/jolli:push`. That matches the status projection, which reports a bound Space but says nothing about push health. (Notable.)
- **The zero-memory ordering rule is a correctness rule, not cosmetics.** Leading a fresh repo's menu with recall or search would default the user into an action that can only return empty. (Notable.)
- **A supplied argument overrides the setup nudge.** The state guidance is the no-argument path; an explicit request is matched and invoked directly, and the invoked target is trusted to handle its own preconditions. (Notable.)
- **Presentation is host-agnostic.** The interactive single-select reference is an example only; the plain-text-list fallback keeps the bare `/jolli` usable on any host that loads skills. (Notable.)
- **A body edit without a revision bump is a build failure, not a silent no-op.** Because the write guard skips on an equal on-disk revision, changing this document's text without bumping `metadata.revision` would ship nothing while every install kept the old text and every surface reported success. A fingerprint assertion — release-version line stripped so a version bump alone does not trip it — catches the missing bump at build time. Bump the revision and update the fingerprint in the same change. (Notable; load-bearing.)
- **This companion carries no workflow actions and no exclusion list.** The standalone menu's run-a-workflow branch, workflow-history recipe, shell prerequisite, and hardcoded tool exclusions are all absent here; this document's MCP half is an unfiltered substring match on `jollimemory`. (Notable.)

## Shared Behavior

- Spec 290 owns the write: the trigger, the target, the ownership-marker guard that leaves a same-named user file untouched, the byte-comparison used to detect that this body changed, and the same-session skill-reload signal derived from it — and it explicitly disclaims owning this body.
- Spec 48 owns the shared revision-guard mechanics (greater → skip, equal → skip, lower → write), the ownership markers, the frontmatter schema, the bundled-version interpolation, the legacy-directory sweep that deliberately spares the bare `jolli` slot, and the uninstall removal.
- Spec 272 owns the standalone umbrella menu's content — the other half of the revision-ordering invariant recorded here.
- Spec 330 owns the Codex plugin's bundled front door, which mirrors this document's four-step shape and both capability derivations while differing in its frontmatter, its precondition, and its tool-lookup rule.
- Spec 282 owns the plugin package that ships the namespaced targets this menu routes to, and twice defers this document's body here; it is the authority on which targets are skills and which are commands.
- Spec 148 owns the `status` MCP tool this document reads — its result shape, its conditional-surfacing implementation, and every field beyond the ones listed here — plus the other Jolli MCP tools the menu routes to.
- Spec 265 owns the command-line guided front door whose ladder, `✓` snapshot, optional sign-in step, and `Jolli is listening — …` closer this document mirrors; spec 291 owns that flow's shared "can generate right now" predicate. This document re-derives both capabilities in prose from status fields rather than sharing that code, and notably performs no local-agent CLI probe.
- Spec 10 owns the underlying credential-source resolution rules that make the provider-aware arms correct.
- Worktree-awareness is inherited from spec 48 and spec 290: each worktree gets its own copy of this document.
