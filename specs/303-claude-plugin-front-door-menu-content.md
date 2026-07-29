# 303. Claude Plugin Front-Door Menu Content

## Topic Statement

The instruction document of the Claude-plugin bootstrap companion menu describes a **state-aware** bare `/jolli` front door: before doing anything it confirms it still has a routing target in this session, then it reads the repository's Jolli setup from the `status` MCP tool, derives a provider-aware "can generate memories" capability, and takes exactly one of two branches — steer the user into `/jolli:init` when setup is incomplete, or print a short `✓` snapshot and then present an action menu whose ordering is biased by how many memories the repository holds. It never re-implements an action; it only reads status and invokes an existing skill or MCP tool.

## Scope

**In scope.** The skill name; the frontmatter field values specific to this companion; the content revision integer and the ordering invariant that binds it to the standalone umbrella menu's; the body's structural sections (title, purpose paragraph, four numbered steps); the routing precondition and its two-case stale-leftover messaging; the status fields the document instructs the agent to read and the conditional-surfacing rules those fields obey; the provider-aware "can generate memories" derivation, arm by arm; the two branches (steer into setup vs. print the snapshot) and the snapshot's exact lines including its conditional line and both closing-line variants; the state-biased menu ordering; the action list (the plugin's four namespaced skills plus whatever Jolli MCP tools are registered); and the repository-level guard that pins each body to its declared revision.

**Out of scope.**

- **The write of this document** — when it happens, where it lands, the ownership-marker guard that refuses to clobber a same-named user file, the before/after canonicality comparison, and the same-session skill-reload signal — is owned by spec 290 (the plugin session-bootstrap hook), which explicitly disclaims owning this body. Spec 48 owns the shared revision-guard mechanics (disk revision greater than ours → skip; equal → skip; lower → write) and the frontmatter schema.
- **The `status` tool this document reads** — its result shape, the conditional-surfacing rules' implementation, and every other field it returns (version, hook rows, integration rows, session count, migration wording, orphan branch, site label) — is owned by spec 148.
- **The command-line front door** (spec 265) and its shared "can generate right now" capability predicate (spec 291). This document *mirrors* that flow's shape — capability ladder, `✓` snapshot, `Jolli is listening — …` closer — but it **re-derives** the capability from status fields in prose rather than sharing the command-line predicate's code. In particular it does no local-agent CLI probe: the command-line predicate actually executes the agent binary, while this document trusts the provider field alone.
- **The content of the standalone umbrella menu** (spec 272) — a passive, action-listing document written into the cross-platform agent-skills slot. This companion is a distinct variant, not a copy.
- **The content of the skills this menu routes to**, and the plugin package that ships them namespaced (spec 282), which twice defers this document's body to "its own spec".
- **Space binding.** The document reads a bound-Space name for one snapshot line only and is explicitly told not to (re)bind; binding stays `/jolli:init`'s and `/jolli:push`'s job.

## Data Contracts

### Skill name

`jolli`. The value is both the skill directory name and the frontmatter `name`, so it surfaces as a bare `/jolli`. That bare form is the entire reason this companion exists: a plugin skill can only ever be invoked as `/jolli:<name>`, so the ecosystem's mandatory bare entry point has to come from a project skill written outside the plugin's own bundle (spec 290).

### Frontmatter values

Spec-compliant only — `name`, `description`, and a nested `metadata` block. No host-private fields (notably no `argument-hint` and no `user-invocable`).

| Field | Value |
|---|---|
| `name` | `jolli` |
| `description` | `The Jolli front door — checks how Jolli is set up in this repo, guides first-time setup through /jolli:init when something's missing, and otherwise shows a status snapshot and routes you to the right Jolli skill or MCP tool. Use when the user types /jolli or asks for Jolli / the Jolli menu.` |
| `metadata.version` | the bundled release version at write time (spec 48) |
| `metadata.revision` | `7` |
| `metadata.vendor` | `jolli.ai` |

### Content revision and the ordering invariant

This companion's `metadata.revision` is **7**. The standalone umbrella menu's (spec 272) is **6**.

The invariant is that this companion's revision must stay **strictly greater** than the standalone umbrella's. Both documents claim the same skill name and both carry `vendor: "jolli.ai"`, so the ownership guard cannot tell them apart — arbitration between them is purely by revision. A pre-upgrade install may still have the *standalone* menu sitting in the Claude-Code skills slot, routing to unnamespaced sibling skills that the plugin's bootstrap deletes; this companion must outrank it so the bootstrap **reclaims that slot in place** rather than leaving a menu that points at nothing. The bare `jolli` directory is deliberately the one directory the legacy sweep never deletes, precisely because it is overwritten in place instead.

A repository-level guard enforces both halves: one assertion pins each shipped body to a stable fingerprint alongside its declared revision, and a separate assertion asserts this companion's revision is strictly greater than the standalone's. The fingerprint deliberately strips the frontmatter's release-version line, so a routine release bump does not churn it — it fires only on a *body* edit. Because the write guard treats an equal on-disk revision as "skip", editing a body without bumping its revision would otherwise ship nothing at all: every existing install would silently keep the old text. The guard converts that silent no-op into a build failure.

### Status fields the document instructs the agent to read

The document names the `status` MCP tool (on Claude Code, `mcp__jollimemory__status`), called with no arguments, and enumerates these fields:

| Field | What the document says it is | Surfacing |
|---|---|---|
| `enabled` | are the git hooks installed in this repo (is memory generation on) | always |
| `account.signedIn` | is the user signed in to Jolli | always |
| `account.jolliApiKeyConfigured` | is a stored Jolli API key present | **only when signed OUT** — a sign-in already implies a Jolli credential, so the field is omitted once `account.signedIn` is true |
| `account.anthropicKeyConfigured` | is an Anthropic key present | **only when `account.aiProvider === "anthropic"`**; omitted for every other provider |
| `account.site` | the Jolli site host, for the snapshot line | always |
| `storedMemories` | how many memories this repo already has | always |
| `space` | the bound Jolli Space (`{ name }`) this repo's memories sync to, or `null` when unbound | always (may be `null`) |

Two further fields are read in the capability derivation but are **not** in this enumerated list: `account.aiProvider` (the provider arm selector) and `account.localAgentTool` (the local agent CLI's human-readable name, referenced only inside the local-agent arm as the tool that generation runs through).

In every conditional case above, omission is **by field absence** — the key is simply not present — not by the field carrying a false value. A consumer that tests truthiness on an absent key happens to land on the same answer; a consumer that distinguishes "absent" from "false" must treat absent as "moot for this provider", not as "no".

`account.localAgentTool` obeys the same rule: it is present only under the local-agent provider, which is exactly the one arm of the derivation that references it, so the document never reads a field in a branch where it could be missing.

The document also states that `space` is **display-only**: it names the bound Space for the snapshot but does not confirm push health, and full binding management stays `/jolli:init`'s and `/jolli:push`'s job.

### Fallback read

If the `status` MCP tool is unavailable (an older Jolli), the document instructs the agent to read the same facts from the printed output of the bundled CLI, invoked through its stable dispatch script:

```bash
"$HOME/.jolli/jollimemory/run-cli" status
```

If neither the tool nor the CLI can be reached at all, the state-based guidance is skipped entirely and the agent goes straight to the action menu, presenting it **without a snapshot**.

### The "can generate memories" derivation

The document is explicit that this is **provider-AWARE, NOT a blind OR of every field**. It reads `account.aiProvider` and takes one arm:

| `account.aiProvider` | Can generate memories |
|---|---|
| `local-agent` | **yes**, unconditionally — generation runs through the user's local agent CLI named by `account.localAgentTool`, needing no API key and no Jolli sign-in. The document notes this is the plugin's default, so a freshly-installed plugin repo can already generate. |
| `jolli` | yes if `account.signedIn` **OR** `account.jolliApiKeyConfigured` |
| `anthropic` | yes **only** if `account.anthropicKeyConfigured` |
| `null` / unset | yes if `account.signedIn` **OR** `account.jolliApiKeyConfigured` |

The document then states the asymmetry outright: for the Jolli proxy a sign-in **does** carry a generation credential — signing in mints a Jolli API key, which is why `jolliApiKeyConfigured` is omitted once signed in — while for the `anthropic` provider **sign-in alone does NOT count**.

This asymmetric statement replaced an earlier **blanket** claim that `account.signedIn` alone never counts (an OAuth token being a sync credential only). Under that earlier text a signed-in user on the Jolli proxy was reported as unable to generate; the local-agent arm was likewise narrower and a freshly-installed plugin repo — which can already generate through its default local agent — was pushed into setup it did not need.

### The status snapshot block

On the fully-set-up branch the document prints, verbatim:

```
✓ signed in · <account.site>        (or "✓ Jolli key set" / "✓ Anthropic key set" when not signed in)
✓ enabled · <storedMemories> memories
✓ syncing · Space "<space.name>"    (ONLY when `space` is non-null; omit the whole line otherwise)

Jolli is listening — last memory saved.
```

Three rules qualify it:

- The `✓ syncing · Space "<space.name>"` line renders **only when `space` is non-null** — it means a `git push` auto-publishes this branch's memories to that Space via the pre-push hook. When `space` is null the whole line is dropped; the document forbids printing a "not bound" line in its place, because binding is `/jolli:init`'s job.
- The closing line mirrors the command-line front door and has exactly two variants: **`Jolli is listening — last memory saved.`** when `storedMemories` > 0, and **`your next commit is your first memory`** when `storedMemories` is 0.
- The first line's parenthetical is the not-signed-in alternative set, `✓ Jolli key set` / `✓ Anthropic key set`.

### The action menu

Two sources, each routed by invoking rather than re-implementing.

**The plugin's namespaced skills** — listed only if confirmed available by the routing precondition:

- **`/jolli:init`** — set up Jolli for this repo: sign in if needed, enable memory generation, and bind the repo to a Jolli Space.
- **`/jolli:recall`** — recall prior development context for the current branch.
- **`/jolli:search`** — search structured commit memories across branches (decisions, topics, files).
- **`/jolli:push`** — publish this branch's memories to a Jolli Space.

Each is routed by invoking that skill through the host's Skill tool. There is no `/jolli:pr` entry — the plugin ships no such skill and the menu must not route to one.

**Jolli MCP tools registered this session** — every tool whose name **contains** `jollimemory`, examples given being `recall`, `search`, `get_pr_description`, `queue_status`, `status`, and the Space tools (`list_spaces`, `bind_space`, `push_memory`). The document forbids assuming a fixed list and says that when no Jolli MCP tools are registered, only the plugin skills are presented.

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

Derive **can generate memories** (provider-aware, per the table in Data Contracts) and **enabled** (the flag as-is), then take exactly one branch:

- **Not fully set up** — `enabled` is false, **OR** memories can't be generated. Memory generation isn't wired yet, so the agent leads with **setup**, not the action menu: state in one line what's missing (the document's own example: *"not signed in, and memory generation is off for this repo"*), then invoke the `jolli:init` skill through the Skill tool, which walks sign-in → enable → bind a Space in one guided pass. The agent must not hand-roll those steps. One exception: an argument that clearly names a different action is honored instead (see Step 3).
- **Fully set up** — enabled **and** a credential present. Print the snapshot block, then continue to Step 3.

When `storedMemories` is 0 the menu is still shown, but Step 3 leads it with `/jolli:init`, because on a fresh repo recall and search would only return empty and so must not be the default action.

### Step 3 — route the request / present the menu

The skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one action and invoke that action directly (invoke the skill, or call the Jolli MCP tool) **regardless of the Step 2 state** — a specific request wins over the setup nudge. The invoked skill handles its own preconditions (the document's example: `/jolli:push` will offer to bind a Space if the repo isn't bound). The agent asks the user to choose only when the request is ambiguous or matches no action.
- **Argument absent** → after the Step 2 guidance, present the action menu and let the user pick, using an interactive single-select tool where the host provides one (AskUserQuestion on Claude Code is given as an example only); otherwise list the options as plain text and ask. Then invoke the corresponding skill or MCP tool.

**Menu ordering is biased by state.** When `storedMemories` is 0, `/jolli:init` is the **first (default)** option — finish setup / bind a Space, or just make the first commit — and recall / search are demoted below it, since on a fresh repo both would only return empty. When memories exist, recall / search lead instead. Either way `/jolli:init` stays available for re-running setup or re-binding a Space.

## State Transitions

The document's own decision tree, from observed state to outcome:

| Observed state | Outcome |
|---|---|
| No routing target this session, bundled CLI dispatch **present** | "plugin menu not loaded, CLI still works" message + self-removal hint; stop. No menu, no skill invocation. |
| No routing target this session, bundled CLI dispatch **absent** | "stale leftover, Jolli not installed" message + self-removal hint; stop. |
| Routing target exists, neither status tool nor CLI reachable | Skip state guidance; present the action menu with **no** snapshot. |
| `enabled` false, or can't generate | One-line statement of what's missing, then invoke `jolli:init`. No snapshot, no menu. |
| Enabled, can generate, `storedMemories` = 0 | Snapshot (closing line: *your next commit is your first memory*), then the menu **led by `/jolli:init`** with recall / search demoted. |
| Enabled, can generate, `storedMemories` > 0 | Snapshot (closing line: *Jolli is listening — last memory saved.*), then the menu **led by recall / search**. |
| Any of the above, but an argument was supplied naming one action | That action is invoked directly, overriding the setup nudge and the menu. |
| `space` null (any branch that prints a snapshot) | The `✓ syncing · Space "…"` line is dropped entirely; no substitute "not bound" line. |

## Notable Behavior

- **This is a state-aware front door, not a static action list.** That is the whole difference from the standalone umbrella menu (spec 272): it reads the repository's actual setup and either steers into setup or reports a snapshot before it will show a menu at all. (Notable; load-bearing.)
- **It is still a front door, never a second execution path.** It only reads status and invokes an existing skill or MCP tool; it re-implements no action, and the namespaced `/jolli:*` commands keep working unchanged. (Notable.)
- **Step 0 exists because this document outlives the plugin that caused it to be written.** It lives in the user's repo, not in the plugin bundle, so a plugin uninstall never reaches it. Without the precondition it would confidently invoke `/jolli:*` skills that no longer exist. (Notable; load-bearing.)
- **The two stale-leftover messages are deliberately distinct, and the CLI probe is what separates them.** Reporting "Jolli is uninstalled" when only the plugin's menu is unloaded would be a false claim — the git-hook memory pipeline is independent of the plugin, so a working CLI must never be mis-reported as gone. (Notable; load-bearing.)
- **The capability derivation is provider-aware, and a sign-in's meaning depends on the provider.** For the Jolli proxy a sign-in *is* a generation credential (it mints a Jolli API key); for the Anthropic provider it is not. This replaced a blanket "a sign-in never counts" claim that both mis-reported signed-in proxy users and shoved a freshly-installed local-agent repo into setup it did not need. (Notable; load-bearing.)
- **Conditional status fields are omitted by absence, not falsified.** The stored-product-key field appears only when signed out, the vendor-key field only under the vendor provider, and the local-agent tool name only under the local-agent provider — each simply missing otherwise. The document's own field enumeration restates the first two rules inline, so the contract is legible from the document alone. (Notable.)
- **The provider selector and the local-agent tool name are read but not enumerated.** Step 1's field list omits both `account.aiProvider` and `account.localAgentTool`, yet Step 2's derivation depends on the first and cites the second. An agent that reads only the enumerated list cannot take the derivation's arms. (Notable.)
- **Bound-Space state is display-only and never gated on.** The setup branch keys off `enabled` and generation capability alone; an unbound repo that can generate is still "fully set up" for this document's purposes, and binding is left to `/jolli:init` and `/jolli:push`. That matches the status projection, which reports a bound Space but says nothing about push health. (Notable.)
- **The zero-memory ordering rule is a correctness rule, not cosmetics.** Leading a fresh repo's menu with recall or search would default the user into an action that can only return empty. (Notable.)
- **A supplied argument overrides the setup nudge.** The state guidance is the no-argument path; an explicit request is matched and invoked directly, and the invoked skill is trusted to handle its own preconditions. (Notable.)
- **Presentation is host-agnostic.** The interactive single-select reference is an example only; the plain-text-list fallback keeps the bare `/jolli` usable on any host that loads skills. (Notable.)
- **The revision-ordering note carried in the source is stale.** It asserts the invariant correctly in kind — this companion must stay strictly above the standalone menu — but cites the wrong integers: it says this variant "is therefore revision **6** (above the standalone's current revision 5, and above the ≤5 any legacy copy carries)". The true values are **7** for this companion and **6** for the standalone. The invariant still holds (7 > 6) and an automated assertion enforces it, so the drift is documentation-only; but a reader trusting the note would believe a bump to 6 is safe when it would in fact tie the standalone and strand the pre-upgrade menu. Both integers should be corrected in place. (Notable.)
- **A body edit without a revision bump is a build failure, not a silent no-op.** Because the write guard skips on an equal on-disk revision, changing this document's text without bumping `metadata.revision` would ship nothing while every install kept the old text and every surface reported success. A fingerprint assertion — release-version line stripped so a version bump alone does not trip it — catches the missing bump at build time. Bump the revision and update the fingerprint in the same change. (Notable; load-bearing.)
- **This companion carries no workflow actions and no exclusion list.** The standalone menu's run-a-workflow branch, workflow-history recipe, shell prerequisite, and hardcoded tool exclusions are all absent here; this document's MCP half is an unfiltered substring match on `jollimemory`. (Notable.)

## Shared Behavior

- Spec 290 owns the write: the trigger, the target, the ownership-marker guard that leaves a same-named user file untouched, the byte-comparison used to detect that this body changed, and the same-session skill-reload signal derived from it — and it explicitly disclaims owning this body.
- Spec 48 owns the shared revision-guard mechanics (greater → skip, equal → skip, lower → write), the ownership markers, the frontmatter schema, the bundled-version interpolation, the legacy-directory sweep that deliberately spares the bare `jolli` slot, and the uninstall removal.
- Spec 272 owns the standalone umbrella menu's content — the other half of the revision-ordering invariant recorded here.
- Spec 282 owns the plugin package that ships the namespaced skills this menu routes to, and twice defers this document's body here.
- Spec 148 owns the `status` MCP tool this document reads — its result shape, its conditional-surfacing implementation, and every field beyond the ones listed here — plus the other Jolli MCP tools the menu routes to.
- Spec 265 owns the command-line guided front door whose ladder, `✓` snapshot, and `Jolli is listening — …` closer this document mirrors; spec 291 owns that flow's shared "can generate right now" predicate. This document re-derives the capability in prose from status fields rather than sharing that code, and notably performs no local-agent CLI probe.
- Spec 10 owns the underlying credential-source resolution rules that make the provider-aware arms correct.
- Worktree-awareness is inherited from spec 48 and spec 290: each worktree gets its own copy of this document.
