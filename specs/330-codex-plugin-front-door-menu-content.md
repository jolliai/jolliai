# 330. Codex Plugin Front-Door Menu Content

## Topic Statement

The instruction document of the Codex plugin's bundled front-door skill describes a state-aware menu that first confirms it has a routing target — accepting either the host's namespaced Jolli tools or the bundled command-line dispatcher, and treating a first-session absence of both as an instruction to trust the plugin's own session hook rather than as breakage — then reads the repository's setup, derives generation and sync capability, and routes to one of the plugin's sibling namespaced skills or to a memory tool looked up by bare name inside the host's tool namespace.

## Scope

**In scope.** The skill's directory name and its frontmatter — which carries only the two fields the host documents as required, with **no** metadata block at all; the body's structural sections (title, purpose paragraph, four numbered steps, the nudge sub-section, the two action sub-sections); the routing precondition, its two accepted targets, its dispatcher-only degraded mode, and its first-session explanation; the status fields the document instructs the agent to read and their conditional-surfacing rules; the two capability derivations; the two branches and the snapshot's state-selected first line, conditional syncing line, and two closing-line variants; the non-blocking sign-in nudge and its rules; the plain-text-only menu presentation and its state-biased ordering; the sibling-skill action list; and the bare-name tool-lookup rule plus the one explicitly recommended tool combination.

**Out of scope.**

- **How this document reaches disk.** It is a committed static file in the plugin's bundle, regenerated from a builder rather than upserted, and pinned byte-exactly by a drift test — owned by **spec 328**, along with the metadata-strip / re-head / sibling-rewrite adaptations applied to *shared* builders (none of which alter this body, which is authored for this host directly).
- **The `status` tool this document reads** — its result shape, its conditional-surfacing implementation, and every other field it returns — owned by **spec 148**, which also owns the other memory tools the menu routes to.
- **The MCP registration this document's precondition depends on**, including why it is written into the host's global configuration rather than shipped as a plugin manifest — owned by **spec 149**, with the reduced install mode that performs it owned by **spec 57**.
- **The session hook the precondition tells the user to trust**, and everything it installs — owned by the plugin session-bootstrap topic and **spec 328**.
- **The content of the sibling skills this menu routes to.** The four host-neutral ones (recall, search, local-run, remote-run) are owned by specs 140, 141, 273 and 274; the host-specific ones are shipped alongside this document in the same bundle.
- **The Claude-plugin companion menu** (spec 303) and **the standalone umbrella menu** (spec 272). This is a third body with a different frontmatter shape, a different precondition and a different tool-lookup rule; the shared rungs it holds in common with spec 303 are noted, not re-derived.
- **The command-line guided front door** (spec 265) whose ladder and wording this document mirrors, and its shared capability predicate (spec 291). This document re-derives both capabilities in prose and performs no local-agent probe.
- **Space binding**, which the document reads for one snapshot line only and is explicitly told not to perform.

## Data Contracts

### Skill directory name and frontmatter

The bundle directory name is `jolli`, and the frontmatter `name` carries the same value. The **namespace** comes from neither: the host prefixes a plugin's skills with the *plugin manifest's* name, so the model sees `<plugin>:<bundle-directory>` — verified by probing a real host install, where an installed plugin's skills render namespaced while a user-global or repository-local skill directory renders bare. The plugin is itself named `jolli`, which is why every sibling this document routes to is written `jolli:<name>`, and why this particular document's own invocation name doubles the word.

The frontmatter carries **exactly two keys** — `name` and `description` — and **no `metadata` block of any kind**: no version, no revision, no vendor marker.

| Field | Value |
|---|---|
| `name` | `jolli` |
| `description` | `State-aware front door for Jolli Memory in Codex — reads how Jolli is set up in this repository, guides first-time setup through jolli:init, reminds the user to sign in when memories cannot sync yet, then routes to recall, search, status, timeline, push, PR, or workflow actions. Use when the user invokes Jolli or asks what Jolli can do.` |

The absence of a metadata block is a structural difference from every document written into a user's repository, not an omission. The metadata block exists solely to drive the on-disk upsert's revision comparison and ownership guard; a bundled copy is never upserted, so there is **no revision integer to bump, no version string to interpolate, and no vendor marker** — and consequently none of the revision-ordering or fingerprint invariants that govern the two menu documents written into repositories apply to this one at all. What replaces them is regeneration plus a byte-exact drift assertion (spec 328).

### The document's own preamble

A purpose paragraph states the three-way summary of what follows — incomplete setup goes to `jolli:init`; memories that are captured but cannot be shared yet get a sign-in reminder; a healthy repository gets a short snapshot and a routed action — and asserts that the document **never re-implements another skill's workflow**: it only reads state and invokes an existing skill or an existing memory tool.

### Status fields the document instructs the agent to read

The document names the memory `status` tool, called with no arguments, and enumerates:

| Field | What the document says it is | Surfacing |
|---|---|---|
| `enabled` | are the git hooks installed in this repository (is memory capture on) | always |
| `account.signedIn` | is the user signed in to Jolli | always |
| `account.jolliApiKeyConfigured` | is a stored Jolli API key present | **only when signed OUT** — a sign-in already implies a Jolli credential |
| `account.anthropicKeyConfigured` | (an Anthropic key) | **only when `account.aiProvider === "anthropic"`**; omitted for every other provider |
| `account.aiProvider` | one of `"local-agent"`, `"jolli"`, `"anthropic"`, `null` | always |
| `account.localAgentTool` | the label of the local agent CLI that generates summaries — the document's example here is **"Codex"** | **only when `aiProvider` is `local-agent`** |
| `account.site` | the Jolli site host, for the snapshot line | always |
| `storedMemories` | how many memories this repository already has | always |
| `space` | the bound Jolli Space (`{ name }`), or `null` when unbound | always (may be `null`) |

Omission in the conditional cases is by **field absence**, not by a false value.

### Fallback read

If the `status` tool is unavailable, the same facts are read from the printed output of the bundled command-line dispatcher:

```bash
"$HOME/.jolli/jollimemory/run-cli" status
```

If neither can be reached, the state-based guidance is skipped and the agent goes straight to the menu, presented **without a snapshot**.

### The two capability derivations

**Can generate memories** — declared **provider-AWARE, NOT a blind OR of every credential**:

| `account.aiProvider` | Can generate memories |
|---|---|
| `local-agent` | **yes** — summaries generate by driving the local agent CLI named by `account.localAgentTool`, described here as *the user's own Codex/ChatGPT login*, with no API key and no Jolli sign-in. Stated to be this plugin's default, so a freshly installed repository can already generate. |
| `jolli` | yes if `account.signedIn` **OR** `account.jolliApiKeyConfigured` |
| `anthropic` | yes **only** if `account.anthropicKeyConfigured`; the document adds that a Jolli sign-in alone does **not** count |
| `null` / unset | yes if `account.signedIn` **OR** `account.jolliApiKeyConfigured` |

**Can sync memories** = `account.signedIn` **OR** `account.jolliApiKeyConfigured`. Declared **provider-independent**: sharing to a Space always needs a *Jolli* credential, so an Anthropic key never satisfies it. Stated to be orthogonal to generation — the default `local-agent` repository generates fine while unable to sync.

**Enabled** is the `enabled` flag as-is.

### The status snapshot block

On the fully-set-up branch the document prints, verbatim:

```
✓ signed in · <account.site> · summaries via <account.localAgentTool>
✓ enabled · <storedMemories> memories
✓ syncing · Space "<space.name>"    (ONLY when `space` is non-null; omit the whole line otherwise)

Jolli is listening — last memory saved.
```

Qualified by the same rules the Claude-plugin companion carries, stated in this document's own words:

- **The first line is state-selected**: signed in → `✓ signed in · <account.site>`, plus the suffix ` · summaries via <account.localAgentTool>` when `aiProvider` is `local-agent`, with the `· <site>` segment dropped when `account.site` is null; not signed in → one of `✓ local agent set (not signed in to Jolli)`, `✓ Jolli API key set (not signed in to Jolli)`, `✓ Anthropic API key set (not signed in to Jolli)` by provider.
- The `✓ syncing · Space "<space.name>"` line renders **only when `space` is non-null** — it means a `git push` auto-publishes this branch's memories to that Space. When `space` is null the whole line is dropped, and the document forbids substituting a "not bound" line because binding is `jolli:init`'s job.
- The closing line has two variants: **`Jolli is listening — last memory saved.`** when `storedMemories` > 0, and **`your next commit is your first memory`** when it is 0.

### The sign-in nudge

Rendered **only when "can sync" is false**, as ONE line under the snapshot:

```
Sign in to Jolli to sync memories to a Space? (jolli:login — memory generation keeps running locally either way)
```

Its rules:

- **Non-blocking** — never withhold the menu waiting for an answer, and never report "not signed in" as broken, because the repository *is* capturing memories.
- **Offered once per invocation**; if declined, dropped for the rest of the session.
- **On acceptance, invoke the `jolli:login` skill** (or `jolli:init` when the user also wants to bind a Space in the same pass). Running the sign-in command directly is forbidden, as is asking for a password, token, or callback URL.
- **Skipped** when "can sync" is true, and inside the not-fully-set-up branch, where `jolli:init` already walks sign-in.

### The action menu

**Sibling skills**, each routed by invoking that skill — the document adds "do not restate its steps here":

- `jolli:init` — finish setup, or change the bound Space.
- `jolli:recall` — recall current-branch context.
- `jolli:search` — search decisions across branches.
- `jolli:status` — inspect installation and queue health.
- `jolli:timeline` — show a decision topic's history.
- `jolli:push` — publish this branch's memories to a Space.
- `jolli:login` — sign in so memories can sync to a Space. **Surfaced whenever "can sync" is false, even if the user did not pick it.**
- `jolli:logout` — clear the stored Jolli credentials.
- `jolli:local-run` / `jolli:remote-run` — run a workflow locally or on the backend.

Every routed target is a **skill**, invoked directly; the document has no slash-command section and never tells the user to type a command themselves.

**Memory tools registered this session** — the document forbids assuming a fixed list and states the host-specific lookup rule (below). One combination is called out explicitly:

- **PR description** — call `queue_status` first, then `get_pr_description`, so the description covers memories that are still being generated.

When no memory tools are registered, only the skills above are presented.

### The bare-name tool-lookup rule

On this host the memory tools are exposed as **bare names inside the `mcp__jollimemory` namespace**, so a `mcp__jollimemory__` prefix match finds **nothing**. The document states the rule twice — once in the precondition and once in the tool section — and instructs the agent to look for the *namespace* and to search its available tools before concluding none are registered. This is the inverse of the substring/prefix match the Claude-plugin companion uses.

## Behavior

The following is what the document instructs the host LLM to do at runtime, in step order.

### Step 0 — confirm this menu can route

The document opens by explaining why the very first session after install is expected to look degraded: the plugin's session-start hook is what installs the command-line dispatcher **and** what registers the memory tool server, and the host reads its tool registrations at session start — so on the first session neither is reachable yet, and the server appears from the **next** session on. The document states plainly that this "is expected, not a fault", and that the hook "has to be trusted".

Before anything else the agent confirms at least one routing target exists:

- one or more memory tools are available — found by namespace, per the bare-name rule; **or**
- the bundled dispatcher exists:

  ```bash
  test -f "$HOME/.jolli/jollimemory/run-cli" && echo present
  ```

**The dispatcher alone is sufficient.** The document states that every step below names a command-line fallback, so a dispatcher-only session runs the whole flow — and instructs the agent to mention **once** that the tools become available in the next session.

If **neither** is reachable, the agent tells the user to start a new session and trust the plugin's session-start hook in the host's hook-review surface, then **stops**. Two things are explicitly forbidden in that state: guessing at install paths, and invoking any sibling `jolli:*` skill — because they share this session's plumbing and would fail the same way.

### Step 1 — read how Jolli is set up

Preferred read is the memory `status` tool with no arguments; the fallback is the dispatcher's status output; an unreachable pair degrades to Step 3's menu without a snapshot. The fields and their surfacing rules are in Data Contracts.

### Step 2 — guide by state

Derive **can generate memories**, **can sync memories**, and **enabled** per Data Contracts, then take exactly one branch:

- **Not fully set up** — `enabled` is false, **OR** memories can't be generated. Lead with **setup**, not the menu: state in one line what is missing, then invoke the `jolli:init` skill, which the document says owns **enable → sign-in → bind a Space**. Hand-rolling those steps is forbidden. One exception: an argument naming a different specific action is honored instead. The sign-in nudge is suppressed on this branch.
- **Fully set up** — enabled **and** generation possible. Print the snapshot; then, only when "can sync" is false, attach the one-line sign-in nudge; then continue to Step 3.

### Step 3 — route the request / present the menu

The skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one action and invoke that action directly **regardless of the Step 2 state** — a specific request wins over the setup nudge. The invoked skill handles its own preconditions (the document's example: `jolli:push` offers to bind a Space when the repository is unbound). The agent asks the user to choose only when the request is ambiguous or matches no action.
- **Argument absent** → after the Step 2 guidance, **list the actions as plain text and ask the user to pick one**. The document gives the reason inline: this host has no interactive single-select. There is no interactive-picker branch to fall back from.

**Menu ordering is biased by state.** When `storedMemories` is 0, `jolli:init` leads as the first option and recall / search are demoted below it, since on a fresh repository both would only return empty. When memories exist, recall / search lead. Either way `jolli:init` stays available for re-running setup or re-binding a Space.

## State Transitions

| Observed state | Outcome |
|---|---|
| No memory tools, no dispatcher | "start a new session and trust the session-start hook" message; stop. No menu, no sibling-skill invocation, no path guessing. |
| Dispatcher present, no memory tools | Full flow runs against the dispatcher, plus a one-time note that the tools arrive next session. |
| Memory tools present | Full flow runs against the tools. |
| Routing target exists, neither status tool nor dispatcher status reachable | Skip state guidance; present the menu with **no** snapshot. |
| `enabled` false, or can't generate | One-line statement of what is missing, then invoke `jolli:init`. No snapshot, no nudge, no menu. |
| Enabled, can generate, can sync | Snapshot, **no** nudge, then the menu. |
| Enabled, can generate, cannot sync | Snapshot **plus** the one-line sign-in nudge, then the menu (never blocked on an answer). |
| Enabled, can generate, `storedMemories` = 0 | Snapshot (closing line: *your next commit is your first memory*), then the menu **led by `jolli:init`**, recall / search demoted. |
| Enabled, can generate, `storedMemories` > 0 | Snapshot (closing line: *Jolli is listening — last memory saved.*), then the menu **led by recall / search**. |
| Signed in, `aiProvider` = `local-agent` | First snapshot line carries the ` · summaries via <tool>` engine suffix. |
| Signed in, `account.site` null | First snapshot line drops the `· <site>` segment. |
| Not signed in (any provider) | First snapshot line becomes that provider's `✓ … set (not signed in to Jolli)` variant. |
| `space` null (any branch that prints a snapshot) | The `✓ syncing · Space "…"` line is dropped entirely; no substitute "not bound" line. |
| Argument supplied naming one action | That action is invoked directly, overriding the setup nudge and the menu. |

## Notable Behavior

- **This body carries no metadata block, so none of the revision machinery reaches it.** There is no revision to bump, no vendor marker, and no version interpolation — the guards that make a body edit fail the build for the two repository-written menus do not exist here, and are replaced by regeneration plus a byte-exact drift assertion. Editing the builder without regenerating leaves the shipped copy silently stale. (Surprising; the inverse of the contract that governs every installed skill. Spec 328 owns the mechanism.)
- **The precondition's failure message is "trust the hook", not "something is broken".** This document ships *inside* the plugin bundle, so it can only ever run when the plugin is installed — the state where nothing is reachable is therefore the first session after install, not an uninstall leftover. It has no stale-leftover branch at all, which is precisely the branch its Claude-plugin counterpart devotes most of its precondition to. (Surprising; load-bearing — the two documents look alike but their preconditions answer opposite questions.)
- **The bundled dispatcher counts as a routing target in its own right, not merely as a diagnostic probe.** Its counterpart runs the identical probe only to choose between two "this menu is stale" messages and then stops; here the same probe *enables the whole flow*, and the document guarantees every step names a fallback that runs through it. (Surprising.)
- **A `mcp__jollimemory__` prefix match finds nothing on this host.** The tools are bare names inside the namespace, so the prefix form every other surface uses returns an empty set — which reads identically to "no tools registered" and would send the agent down the precondition's stop path. The document states the rule twice and additionally warns that the agent must search its available tools before concluding none are registered. (Surprising; load-bearing.)
- **The first session after install has skills but no memory tools, by construction.** The hook that registers them runs at session start, and registrations are read at session start — so the registration written by one session's hook is first visible to the next. The document treats this as expected and covers it with the dispatcher fallback. (Notable.)
- **Every menu entry is a skill, invoked directly.** Unlike the Claude-plugin companion — which has to split its menu into skills it can invoke and slash commands it can only tell the user to type — this host's bundle exposes sign-in, sign-out, status and timeline as skills, so there is no "a skill cannot invoke a command" caveat anywhere in the body. (Notable.)
- **Presentation is plain text only.** The document states the host has no interactive single-select and lists options as text unconditionally; there is no picker branch and therefore no fallback path to get wrong. (Notable.)
- **Generating and sharing are two independent axes, and the default install sits between them.** The plugin's default local-agent provider is "fully set up" for the setup branch while still unable to publish anything — the only state the sign-in nudge renders in. (Surprising; an implementation that ORed the axes would push a working repository into setup it does not need.)
- **The setup skill's step order is stated as enable → sign-in → bind.** The equivalent sentence in the Claude-plugin companion orders it sign-in → enable → bind. Both describe the same target skill. (Notable.)
- **The one recommended tool combination exists to avoid publishing a stale answer.** The PR-description entry pairs the queue-status call ahead of the description call so the description covers memories still being generated; every other tool is left to be enumerated and routed generically. (Notable.)
- **The document promises a "PR" action in its description while shipping no PR skill.** The description line advertises routing to "recall, search, status, timeline, push, PR, or workflow actions"; the skill list contains no PR entry, and the PR capability is reachable only through the memory-tool combination above. (Notable.)

## Shared Behavior

- Spec 328 owns this document's existence as a committed static artifact: the builder it is generated from, the generator that must be re-run after an edit, the byte-exact drift assertion, the exact-set skill inventory it belongs to, and the metadata-strip / re-head / sibling-rewrite adaptations that apply to the *shared* builders shipped beside it.
- Spec 148 owns the `status` tool this document reads and every other memory tool the menu routes to.
- Spec 149 owns the registration that makes those tools reachable at all on this host, and why it lands in the host's global configuration rather than in a plugin manifest; spec 57 owns the reduced install mode that writes it.
- Spec 303 owns the Claude-plugin companion, which shares this document's four-step shape, both capability derivations, and every snapshot and nudge string, while differing in frontmatter, precondition, menu composition and tool lookup. Spec 272 owns the standalone umbrella menu, a passive action list this document is not a variant of.
- Spec 265 owns the command-line guided front door whose ladder, `✓` snapshot, optional sign-in step and `Jolli is listening — …` closer this document mirrors; spec 291 owns that flow's shared capability predicate. This document re-derives both capabilities in prose and performs no local-agent probe.
- Spec 10 owns the credential-source resolution rules that make the provider-aware arms correct.
- The bundled dispatcher this document probes and shells is the same per-user entry point every other surface's recipes use; the runtime it resolves to is chosen by the cross-surface registry.
