# 272 — `jolli` Menu Skill Content

## Topic Statement

The instruction document of the umbrella menu skill describes a single front door that assembles one unified action menu from two live sources — the standalone Jolli skills plus whatever Jolli MCP tools are registered in the current session — and then routes the user to the matching skill or tool, matching a supplied request directly and presenting the menu only when no request is given.

## Scope

**In scope.** The skill name, the frontmatter field values specific to the menu skill, the body's structural sections (title, purpose paragraph, two numbered steps), the two menu sources and how each is enumerated, the routing contract for a request-supplied versus request-absent invocation, the host-agnostic single-select-versus-text-list presentation fallback, and the explicit non-goals (it never re-implements an action and never re-derives backend menu curation).

**Out of scope.** The file path, the revision-guard logic, frontmatter machinery, the single-target write and the plugin-driven Claude-Code-slot operations, and legacy-directory cleanup — all owned by spec 48 (which installs this skill but explicitly disclaims owning its body). The content of the individual skills this menu routes to — `jolli-recall` (spec 140), `jolli-search` (spec 141). The MCP server's own curated `jolli` **prompt** and its manifest-driven `menu`-metadata curation (spec 148); this on-disk skill is a separate, parallel front door that does not read the manifest. The MCP tool surface the routed choices exercise (spec 148).

## Data Contracts

### Skill name

`jolli`. This value is the skill directory name and the frontmatter `name` field, so the skill surfaces to the user as a bare `/jolli`. A full `jolli enable` writes this document into the single cross-platform agent-skills directory only (see spec 48); it is no longer dual-written into the Claude-Code slot. The Claude-Code slot's bare `/jolli` is instead supplied by a separate, plugin-driven companion menu — see "Plugin-bootstrap companion menu" below.

### Frontmatter values

The frontmatter is spec-compliant only — `name`, `description`, and a nested `metadata` block (version string, content-revision integer, and vendor string). It carries no host-private fields.

| Field | Value |
|---|---|
| `name` | `jolli` |
| `description` | `The Jolli action menu — a single front door that lists the Jolli skills (recall, search, run a workflow local or remote, workflow history) plus the Jolli MCP tools registered in this session, then routes your choice to the right one. Use when the user types /jolli or asks for the Jolli menu.` |
| `metadata.version` | set to the bundled version at write time (spec 48) |
| `metadata.revision` | `6` |
| `metadata.vendor` | `jolli.ai` |

This document's revision is the lower half of a build-asserted ordering invariant: the plugin-bootstrap companion menu (spec 303) claims the same skill name and the same vendor marker, so arbitration between the two is purely by revision, and the companion's revision must stay **strictly greater** than this one's. See spec 48.

### Body structure

The body immediately follows the frontmatter closing delimiter and contains:

1. **Title and purpose paragraph** — frames the skill as the single umbrella action menu that ties together the standalone Jolli skills and the Jolli MCP tools registered this session and routes the user's choice to the right one; states plainly that it is a friendly front door that **never** re-implements an action but only invokes an existing skill or MCP tool, and that the standalone commands (`/jolli-recall`, `/jolli-search`, `/jolli-local-run`, `/jolli-remote-run`) and the MCP-server `jolli` prompt all keep working unchanged — this menu is layered on top of them, not a replacement. Because the **Workflow history** action shells the `jolli` CLI directly, the menu body also carries the shared Windows/Git-Bash shell prerequisite (see spec 48 / the sibling recipes).
2. **Step 1: build the unified menu** — assemble one combined list of actions from the two sources below.
3. **Step 2: route the request** — the request/no-request routing contract.

The body's exact wording is part of the on-disk contract. The **sole** rewrite trigger is the `metadata.revision` integer, not the bundled release version: editing the body without raising that integer ships nothing to any existing install, and the repository guards against that omission at build time (see spec 48).

### Menu source 1 — local Jolli skills and the run-a-workflow action (always present)

The following actions are always listed, each with a one-line description and an instruction to route the choice by invoking the matching skill through the host's skill-invocation mechanism (for example, the Skill tool on Claude Code):

- **jolli-recall** — recall prior development context for the current branch.
- **jolli-search** — search structured commit memories across branches (decisions, topics, files).
- **Run a workflow** — a single action that, when chosen, asks the user **local vs remote**, defaulting to **local**:
  - **local (default)** routes to the `jolli-local-run` skill (the calling agent executes the recipe locally; the writes land in a git-backed Space via a branch + PR). Content owned by spec 273.
  - **remote** routes to the `jolli-remote-run` skill (not the raw `run_remote_workflow` tool), mirroring how the local path routes to `jolli-local-run`. That recipe drives `run_remote_workflow` server-side, monitors the run to completion, reports the outcome, and offers to open its links. Content owned by spec 274.

  The action also notes that a running **remote** run can be canceled with the `cancel_remote_workflow` MCP tool, offered when the user wants to stop an in-flight remote run.
- **Workflow history** — show a workflow's past runs. The user identifies the workflow's numeric id (offered via the `list_workflows` tool when it is registered this session, else asked for), and the action shells `jolli workflow runs <workflowId>` (the run-cli entry script), reading its `{ type: "runs", runs: [...] }` projection — per run: `status`, `timestamp`, and any `workflowUrl` / `runUrl` / `prUrl` / `articleUrls`. An empty `runs` list is the normal "no history yet" outcome, not an error. `workflow runs` is a subcommand of the `@jolli.ai/workflow-cli` plugin; when that plugin is absent the host stub prints a prose install hint on stderr and exits non-zero, so the recipe surfaces the install hint (`npm i -g @jolli.ai/cli @jolli.ai/workflow-cli`) and stops rather than failing opaquely. The action offers to open any listed URL via `jolli open-url <url>`. Surfaces owned by spec 274; the menu only routes to them.

### Menu source 2 — Jolli MCP tools (whatever is registered this session)

The skill instructs the host LLM to surface **every registered memory-server tool** available in the current session — for example the read tools, the PR-description and queue-status tools, and any manifest-driven platform tools (space, article, and the like) — and to route such a choice by calling the matching tool.

**How to find them is explicitly host-dependent**, and the document says so rather than assuming one spelling:

- On Claude Code the tools carry a **prefix**, so matching names that start with `mcp__jollimemory__` is correct there.
- On Codex the same tools are **bare names inside** the `mcp__jollimemory` namespace, so a prefix match finds **nothing** — the instruction is to look for the *namespace* instead.
- That host also loads MCP tools **lazily**, so the document tells the LLM to search its available tools before concluding that none are registered.

Three further constraints are stated explicitly:

- **Do not assume a fixed list.** The LLM must enumerate the Jolli MCP tools that are actually registered right now, not a hard-coded set.
- **Do not fetch or re-derive any backend "menu" curation.** A static skill document cannot read the manifest, so the LLM simply surfaces the Jolli MCP tools present in the session. If no Jolli MCP tools are registered, it presents just the local skills.
- **Exclude specific tools from the raw MCP-tools list.** `list_workflow_definitions` is discovery/plumbing, not a human quick-action, and is never surfaced as a standalone menu item. `run_remote_workflow` and `cancel_remote_workflow` are also not listed as raw tools — they are already covered by the **Run a workflow** action (its *remote* path and its cancellation option), so listing them again would duplicate that action.

### Routing contract (Step 2)

The skill takes one optional free-text argument (the user's request):

- **Argument provided (non-empty):** the LLM matches it to exactly one menu action and invokes that action directly (invoking the skill, or calling the MCP tool). It asks the user to choose **only** when the request is ambiguous or matches no menu action.
- **Argument absent/empty:** the LLM presents the unified menu and lets the user pick, using an interactive single-select tool where the host provides one (for example `AskUserQuestion` on Claude Code); otherwise it lists the options as plain text and asks the user to choose. After the user selects, it invokes the corresponding skill or MCP tool.

The presentation is host-agnostic by design: the interactive-single-select reference is only an example, and the plain-text-list fallback keeps `/jolli` usable on every host that loads skills. This request/no-request contract mirrors the MCP-server `jolli` prompt's steering behavior (spec 148), but this skill is a separate, static execution path — it does not read the manifest and does not curate which platform tools appear.

## Behavior

The following describes what the skill instructs the host LLM to do at runtime, in step order.

### Step 1: Build the unified menu

Assemble one combined list of actions from the two sources. The local skills (jolli-recall, jolli-search), the run-a-workflow action, and the workflow-history action are always included. Then enumerate the currently-registered memory-server tools — by prefix on a prefixing host, by namespace on a host that exposes them bare, and only after actually searching the available tools, since one host loads them lazily — and add each as a menu action, **excluding** `list_workflow_definitions` (plumbing) and the `run_remote_workflow` / `cancel_remote_workflow` tools (already covered by the run-a-workflow action, whose remote path routes through the `jolli-remote-run` recipe that drives `run_remote_workflow`); if none survive, the menu is just the local actions. Do not hard-code the MCP tool list and do not attempt to fetch backend curation.

### Step 2: Route the request

If a request argument was supplied, match it to a single menu action and invoke that action directly — invoking a local skill through the host's skill mechanism, or calling the matching memory-server tool — asking the user only when the intent is ambiguous or unmatched. If no request was supplied, present the menu (single-select tool if the host has one, else a plain-text list), capture the user's choice, and invoke the corresponding action.

## Notable Behavior

- **The menu is assembled live from two sources, not a static list.** The local skills are fixed, but the MCP-tool half is whatever memory-server tools happen to be registered in the session — so the menu grows or shrinks with the host's registered tools and with any manifest-driven platform tools. (Notable.)
- **Tool discovery is host-aware, not a single prefix match.** The document no longer states one rule ("names beginning with the prefix"); it states that the prefix match is correct only on a prefixing host, that another host exposes the same tools as bare names *inside* the namespace where a prefix match finds nothing, and that the LLM must search its available tools before concluding none are registered because that host loads them lazily. The document says outright that a prefix match "finds nothing" on that host — which under the old single-rule wording would have left the MCP half of the menu empty. (Notable; load-bearing.)
- **It is a front door, never a second execution path.** The skill only steers to an already-existing skill or MCP tool; it re-implements no action. The standalone skill commands and the MCP-server `jolli` prompt keep working unchanged. (Notable; load-bearing.)
- **It does not re-derive the backend's curated menu.** A static skill document cannot fetch the tool manifest, so curation of which platform tools belong in the backend menu stays authoritative in the server-side MCP `jolli` prompt (spec 148); this skill just surfaces the Jolli MCP tools present in the session. (Notable.)
- **The skill applies its own hardcoded exclusions because it cannot read curation.** Since the skill cannot consult the backend `menu` metadata, it names the excluded tools explicitly: `list_workflow_definitions` is never surfaced (plumbing), and `run_remote_workflow` / `cancel_remote_workflow` are folded into the single run-a-workflow action rather than listed as raw tools. (Notable; load-bearing — keeps the menu from double-listing the remote-run tools.)
- **Running a workflow is one action that branches local vs remote, defaulting to local — both branches route to a recipe skill.** The menu presents a single "Run a workflow" entry; picking it prompts local vs remote (local → the `jolli-local-run` skill, remote → the `jolli-remote-run` skill, which drives `run_remote_workflow` and monitors/reports the run — not a raw-tool call), and an in-flight remote run can be canceled via `cancel_remote_workflow`. (Notable.)
- **Workflow history is a routed action, not a re-implementation.** The menu's "Workflow history" entry shells the `jolli workflow runs <workflowId>` helper and offers to open any listed URL via `jolli open-url`; it renders the helper's JSON projection but computes nothing itself, and an empty history is a normal outcome. Because `workflow runs` is a `@jolli.ai/workflow-cli` plugin subcommand, a missing plugin makes the host stub print an install hint and exit non-zero, and the recipe surfaces that hint (`npm i -g @jolli.ai/cli @jolli.ai/workflow-cli`) and stops. The behavior of those helpers is owned by spec 274. (Notable.)
- **Request-supplied invocations skip the menu.** A non-empty argument is matched to one action and invoked directly, asking only on ambiguity or no match — the menu is presented only when the user gives no request. (Notable.)
- **Presentation is host-agnostic.** The interactive-single-select tool is an example only; the plain-text-list fallback keeps the skill usable on any host that loads skills. (Notable.)
- **Plugin-bootstrap companion menu.** This standalone document is written by a full `jolli enable` into the cross-platform agent-skills directory. Separately, the Claude Code plugin's reduced repo-hooks-only bootstrap (spec 57) writes a bare `/jolli` menu into the Claude-Code skills slot — necessary because a plugin skill can only ever be invoked as `/jolli:<name>`, so the ecosystem's mandatory bare `/jolli` entry point has to come from a non-plugin project skill written outside the plugin's own bundle. That companion is a **distinct, state-aware variant** (it inspects how Jolli is set up in the repo and guides first-time setup rather than listing the fixed action set this spec documents), not a byte-identical copy of this document. On success the bootstrap also signals a same-session skill reload so the freshly written bare `/jolli` is invocable in the very session that wrote it, rather than only the next one. This spec documents the standalone menu's content; the plugin companion's body is a separate front door, owned by **spec 303** — which also records the other half of the revision-ordering invariant noted under Data Contracts. (Notable.)

## Shared Behavior

- Spec 48 owns the file path(s), the frontmatter schema, the revision-guard, the bundled-version and revision sentinels, the single-target write (the cross-platform agent-skills directory), the plugin-driven Claude-Code-slot operations (the companion bare-umbrella write, the legacy-copy cleanup, and the uninstall removal), and the legacy-directory cleanup — and installs this skill while explicitly disclaiming ownership of its body. This spec owns only the content written inside that file.
- Specs 140 and 141 own the content of the `jolli-recall` and `jolli-search` skills that this menu routes to; the menu carries **no** pull-request action — the PR skill it used to list was retired (spec 211), and PR authoring is reached through the PR-description tool or command-line surface rather than through this menu; spec 273 owns the `jolli-local-run` recipe skill; spec 274 owns the `jolli-remote-run` recipe skill and the `workflow runs` / `open-url` helpers the workflow-history action shells.
- Spec 148 owns the MCP tool surface the routed choices exercise and the server-side `jolli` **prompt** (the manifest-`menu`-metadata-curated counterpart to this skill), including its identical request/no-request steering contract.
- Spec 303 owns the plugin-bootstrap companion bare-`jolli` menu's body — the state-aware variant written into the Claude-Code slot, and the upper half of the revision-ordering invariant this document's revision participates in.
- Worktree-awareness is inherited from spec 48: each worktree has its own copy of this skill document.
