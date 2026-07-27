# 273. Local Workflow-Run Orchestration (host side)

## Topic Statement

A calling AI client can run a Jolli **workflow locally**: the client's own agent
executes the workflow's recipe (spending no Jolli LLM budget), while the Jolli
backend supplies the recipe, tracks the run, and derives the write destination.
The workflow's file writes land in a git-backed destination space through an
agent branch that the space-cli tool commits, pushes, and opens as a pull
request on the client's own machine. A workflow is offered as locally-runnable
**only** when its destination is git-backed **and** already cloned on this
machine; before the run starts the developer is told whether the resulting PR
will auto-merge (destination auto-apply on) or open for team review (off).

The `jolli mcp` server is a **stateless** request/response surface — one
dispatch per call, no cross-call session state, no server-initiated push, and no
way to pop an interactive prompt (standard input/output is the JSON-RPC
transport). Therefore "the host drives the flow" means the **calling client's
agent loop** drives an ordered sequence of MCP tool calls plus command-line
(`Bash`) calls, guided by an installed Jolli **recipe skill**. The human sitting
in that client is the review gate; the agent re-calling the progress tool while
the human reviews is the lease heartbeat.

The **eligibility computation itself no longer lives here.** The offer is
produced by the `@jolli.ai/workflow-cli` plugin's `workflow local-run`
subcommand, which the plugin package ships and releases separately. What this
spec governs is everything that is still authored and installed from this
repository plus the contracts those artifacts consume:

- The **`jolli-local-run` recipe body** — written verbatim here and installed on
  the user's machine; it is the thing that steers the calling agent through the
  frozen lifecycle order.
- The **`workflow` stand-in** the host registers when the workflow plugin is
  absent, including the machine-readable needs-input envelope its `local-run`
  branch emits.
- The **sibling Space stand-ins** the recipe depends on when `@jolli.ai/space-cli`
  is absent.
- The **spawn-target convention** the recipe encodes for every command-line call.
- The **consumed contracts**: the offer JSON the recipe parses, the four run-tool
  shapes, the `docs pull` / `docs publish` command shapes, and the branch-integrity
  cross-check shape — frozen here as what the recipe relies on, implemented in the
  plugins and the backend.

## Scope

**In scope:**

- The **`jolli-local-run` recipe skill body** authored and installed by this
  repository: the lifecycle order it steers, the JSON branches it parses, the
  user-facing announcements it makes, and the safety rules it enforces.
- The **host `workflow` stand-in**: one top-level command with a forwarded
  variadic argument, and its two deliberately **asymmetric** absent-plugin
  branches (a machine-readable needs-input object for `local-run`; a prose
  install hint for everything else).
- The **sibling Space stand-in requirement**: `docs pull` / `docs publish` (and
  the `space` command the branch cross-check rides on) must produce a clean,
  actionable install prompt when the space-cli plugin is absent.
- The **spawn-target convention** every command-line call in the recipe encodes.
- The **consumed offer contract**: the JSON shapes the recipe parses from
  `workflow local-run`, and the eligibility rule the offer must satisfy
  (including the meaning of the auto-merge signal that rides with it).
- The **four run-tool contracts** the recipe consumes as generic manifest relays:
  `start_local_run`, `report_local_run_progress`, `complete_local_run`,
  `abandon_local_run` — their arguments and return shapes.
- The **space-cli command seam**: `jolli docs pull --branch <workBranch>` and
  `jolli docs publish`, their required inputs and machine-readable outputs, and
  the rule for who fetches the destination write token.
- The **branch-integrity cross-check** the recipe performs between publish and
  completion, and the machine-readable verdict shape it consumes.
- The **review-gate + heartbeat model** (the human approval before publish, the
  heartbeat cadence around the blocking prompt) and the hard lease-lifetime
  requirement it imposes on the backend.
- The **lifecycle order** of the whole run, and the cancel path.
- The **user-facing messaging**: the auto-merge-vs-review announcement, the
  missing-plugin install prompts, and the degraded (empty) states.

**Boundaries:**

- The **eligibility computation and its inputs** — fetching the candidate
  workflow list, reading the machine's space clone list, applying the rule, and
  emitting the offer JSON — are implemented in the `@jolli.ai/workflow-cli`
  plugin, not in this repository. This spec freezes the offer's **shape** and the
  rule the offer must satisfy, because the recipe's behavior depends on both; it
  defines no host code that computes them.
- The **branch-integrity cross-check command** is a `@jolli.ai/space-cli`
  subcommand (`space verify-publish-branch`), not a host command. Its verdict
  shape and exit-code contract are frozen here as a consumed contract.
- The **manifest-driven platform-tool surface** — how the run tools are
  advertised, the best-effort manifest fetch that degrades to no platform tools,
  the generic executor that forwards arguments verbatim as a JSON body over a
  body-carrying same-origin binding (falling back to the conventional
  `POST /api/mcp/tools/<name>`), the activation gate that switches the whole
  surface on — is owned by **spec 148**. This spec *consumes* those tools; it
  defines **no** host registration or dispatch for them.
- The **backend halves** — the run-tracking store, the lease sweeper and lease
  TTL, the space clone registry, the server-side derivation of the work branch
  and write target, PR auto-merge on destination auto-apply, and the space-cli
  subcommands themselves (`jolli space clones --json`,
  `jolli space verify-publish-branch`, `jolli docs pull` / `jolli docs publish`,
  the write-token endpoint) — live in the backend and the `@jolli.ai/space-cli`
  plugin, not in this repo. The host knows only the top-level command *names*
  through plugin stand-ins (**specs 146 / 147**); there is no typed subcommand
  contract in-repo. This spec freezes the command **shapes** the recipe relies
  on, not their implementation.
- The **`binding_required` needs-input idiom** this feature reuses to signal
  "not eligible", "not cloned", or "install space-cli" is owned as a pattern by
  **specs 148 and 230**; this spec only applies it.
- The **umbrella `/jolli` menu skill** the recipe is listed under is owned by
  **spec 272** (content) and **spec 48** (installation); this spec only states
  that the recipe plugs into it.
- **Workflow-run result reporting, run history, and open-in-browser** are owned by
  **spec 274**; this spec ends at the reporting boundary and notes the seam only.
- **Routing local-run source reads to a local clone** is a separate feature; this
  spec notes it as a seam and defines it not at all.

## Data Contracts

### Eligibility verdict (frozen; computed outside this repo)

Each candidate workflow carries a verdict, whose fields the offer surfaces:

| Field | Meaning |
| --- | --- |
| `id` | The workflow's identifier (used to start the run). The backend emits a **numeric** id; it is carried verbatim (a `string` slug is also accepted). |
| `name` | The workflow's human-readable name (e.g. "Impact Analysis"), echoed for **display only** so the recipe can present a chosen-from list by name rather than by an opaque id. Present only when the backend supplied a non-empty string; **never** an eligibility input. |
| `runnable` | `true` **iff** the destination is git-backed **and** the destination space's clone is present on this machine; else `false`. |
| `autoMerges` | The destination's auto-apply flag, surfaced so the user is told up front whether the PR auto-merges (`true`) or opens for team review (`false`). **Never** an input to `runnable`. |
| `reason` | Present only when `runnable` is `false`; a short human-readable explanation (not git-backed / not cloned). |

**Eligibility rule (frozen).** A workflow is locally-runnable **iff** its
destination's sync protocol is git-backed **AND** the destination space —
identified by its JRN (or the space slug encoded in that JRN) — appears in the
machine's clone list. Spaces are keyed by **JRN**, not a numeric id (the backend
emits no numeric space id here). The destination's auto-apply flag is **not** an
eligibility requirement — it is read only to populate `autoMerges`. The backend
refuses a non-git-backed destination at `start_local_run`; the offer must
therefore **never present** a non-git-backed or non-cloned workflow as runnable.
When either input is unavailable in a degraded way, the offer yields an empty or
install-prompt result — never a crash, never a false `runnable:true`.

**Cross-repo dependency (open):** the machine's clone list is exposed by
`@jolli.ai/space-cli` (a separate package). For a git-backed workflow to be
offerable, that surface must expose the space **JRN** (or the space slug) per
clone; until it does, the eligibility path degrades to "no clones" /
`space_cli_required`. The contract deliberately keys on JRN/slug, never a
numeric id.

### The local-run offer (consumed by the recipe)

`jolli workflow local-run` is a subcommand of the single top-level `workflow`
command provided by the `@jolli.ai/workflow-cli` plugin. The recipe invokes it
through the spawn-target convention below and parses its stdout as JSON. The
shapes it must handle:

- `{ type: "workflows", workflows: [{ id, name?, autoMerges }] }` — the offerable
  set (only `runnable:true`), possibly empty (a normal "nothing to offer" state).
  `name` rides along for display when the backend supplied one (omitted
  otherwise); it never affects what is offered. Exit 0.
- `{ type: "workflow_cli_required", installHint }` — needs-input emitted by the
  **host stand-in** when the `@jolli.ai/workflow-cli` plugin is not installed (so
  the real command does not exist yet); `installHint` is the combined hint
  `npm i -g @jolli.ai/cli @jolli.ai/workflow-cli`. The recipe handles it exactly
  like `space_cli_required` — tell the user to install the plugin and stop. Exit 0
  (not a failure). **This is the one shape in this list produced inside this
  repository.**
- `{ type: "space_cli_required", message, install }` — needs-input (mirrors
  `binding_required`): space-cli must be installed; `install` is the combined
  hint `npm i -g @jolli.ai/cli @jolli.ai/space-cli`. Exit 0 (not a failure).
- `{ type: "error", message }` — an unexpected failure. Exit 1.

An empty offer short-circuits ahead of the clones read, so a `space_cli_required`
prompt is surfaced only when candidates actually exist (the blocker for an empty
list is the absent workflow source, not space-cli).

### Host `workflow` stand-in (frozen)

When the `@jolli.ai/workflow-cli` plugin is absent, the host registers a
stand-in in the real command's place. Its shape is deliberately not the
"one top-level command per subcommand" shape the other plugin stand-ins use:

- **Exactly one** top-level `workflow` command, whose subcommand and flags arrive
  as a **forwarded variadic argument**. Unknown options are tolerated, so a user
  (or a recipe) typing the full real invocation reaches the action rather than a
  parse error. There are no `local-run` / `runs` / `run-status` subcommand
  objects; the action branches on the first forwarded token.
- It is grouped under the "Jolli Workflows" help section, so the feature stays
  discoverable while the plugin is missing.
- **Collision-tolerant**: if the `workflow` name — or an alias of any command
  already registered — is taken, the stand-in declines to register rather than
  letting a duplicate-name error abort registration.

Its two branches are **asymmetric, and the asymmetry is load-bearing** because
the two recipe surfaces detect absence in two different ways:

| Forwarded subcommand | Stream | Output | Exit |
| --- | --- | --- | --- |
| `local-run` | standard **output** | one JSON object `{ "type": "workflow_cli_required", "installHint": "npm i -g @jolli.ai/cli @jolli.ai/workflow-cli" }` | **0** — a needs-input state, not an error |
| anything else (`runs`, `run-status`, an unknown token) **or none at all** | standard **error** | a multi-line prose install hint: the invoked command requires the `@jolli.ai/workflow-cli` plugin, the install command, and a "then re-run" line. With no subcommand the label degrades to bare `workflow`. | **non-zero** (terminates the process) |

The `local-run` branch is JSON-on-stdout-exit-zero precisely because the
local-run recipe parses that command's stdout as JSON and treats the result as
one of several needs-input branches; a prose crash would be unparseable there.
The `runs` / `run-status` branches are prose-on-stderr-exit-non-zero precisely
because their consumers (the remote-run recipe's monitor step and the menu's
history action, spec 274) detect absence by a non-zero exit plus a prose hint.
Neither branch may be "harmonised" with the other without breaking one consumer.

### Recipe skill (`jolli-local-run`)

The installed surface that drives the lifecycle is the `jolli-local-run` recipe
skill, authored in this repository and written to disk by the skill installer
alongside the other four skills in its registry — `jolli-recall`,
`jolli-search`, `jolli-remote-run`, and the umbrella `jolli` menu (installation
machinery, revision guard, and dual-write owned by spec 48). Its body is at
**revision 5**.

Its body is prose that steers the calling client's agent through the frozen
lifecycle order below: run `workflow local-run` and offer only the returned
workflows — presenting each by its human-readable `name` (falling back to the
`id` when no name is supplied) and announcing auto-merge vs team review;
`start_local_run` → `docs pull --branch` (never `--agent`; the write token is
fetched inside `docs pull`, the recipe never handles it) → write files → the
review gate with `report_local_run_progress` heartbeats bracketing the blocking
approval → on approve `docs publish --json` (capture the machine-readable
result) → cross-check the published branch via
`space verify-publish-branch` → `complete_local_run` (surface `willAutoMerge`);
on cancel `abandon_local_run`.

It prefers the `mcp__jollimemory__*` platform tools for the run lifecycle (there
is no CLI mirror for them) and shells the `jolli` CLI for the offer, the `docs`
git operations, and the branch cross-check. Two of its command-line call sites
are **namespaced under a plugin's top-level command**: the offer is
`workflow local-run` (workflow-cli) and the branch cross-check is
`space verify-publish-branch` (space-cli); prose elsewhere in the body refers to
re-checking a run via `workflow run-status <runId>`. The recipe is listed in the
umbrella `/jolli` menu skill's local-skills set (spec 272).

### Run tools (generic manifest relays; arguments forwarded verbatim as a JSON body)

These four tools are advertised by the backend manifest and dispatched by the
spec-148 generic executor. The host defines **no** registration or dispatch for
them; the recipe depends only on their argument and return shapes:

| Tool | Arguments | Return shape (recipe-consumed) |
| --- | --- | --- |
| `start_local_run` | `{ id }` | `{ runId, plan, writeTarget }` where `writeTarget` carries the server-derived `workBranch`, the destination space (by JRN), and the destination folder. |
| `report_local_run_progress` | `{ runId, … }` | A heartbeat that refreshes the backend lease and keeps the run `active`. Return value is informational. |
| `complete_local_run` | `{ runId, { prNumber, prUrl } }` | `{ willAutoMerge, … }` — the backend auto-merges the PR when the destination is auto-apply, else leaves it open for team review; the boolean `willAutoMerge` tells the recipe which happened so it can surface it. (The completion result also carries `workflowUrl`/`runUrl` and, on the auto-apply path, `writtenArticles`; the result-reporting extensions are owned by **spec 274**.) **Do not confuse `willAutoMerge` — the completion-*result* field — with the eligibility-verdict field `autoMerges` above; they are different fields.** |
| `abandon_local_run` | `{ runId }` | Called on cancel; releases the run. |

### `docs pull` contract (frozen)

`jolli docs pull --branch <writeTarget.workBranch>` — **always `--branch`, never
`--agent`.** The `--agent` mode runs a destructive `git clean -fdx` that wipes
untracked files; `--branch` checks out the server-derived agent branch with no
clean. The recipe and this spec enforce `--branch`; the space-cli plugin owns
the mode's implementation.

**Write token (frozen): fetched internally by `jolli docs pull`.** The
destination write token is fetched by `docs pull` **itself**. The recipe never
handles the token and must **not** be instructed to "call a token/backing
function" — an agent driving `Bash` + MCP cannot invoke a library function. No
separate token command is exposed.

### `docs publish` output contract (frozen)

`jolli docs publish` commits the working tree, pushes the agent branch, and
opens the pull request. It **must** emit its result in a machine-readable form
(the `--json` mode the recipe uses) so the recipe can pass the PR reference
verbatim to `complete_local_run`; `--json` prints exactly one JSON object on
stdout with all human-readable progress on stderr, so the recipe never scrapes
the human log for a PR number. The machine-readable output shape is frozen here
as an object exposing `pushed` (boolean), and — when `pushed` is true —
`headBranch` (the branch the PR was actually opened on) plus the PR reference
`prNumber` / `prUrl`. For a **private Jolli-managed destination** the PR
reference is withheld (`prNumber` / `prUrl` omitted, `private: true`) but
**`headBranch` is still emitted**; when nothing was published the result is
`{ pushed: false, reason }`.

**Branch-integrity cross-check (recipe guard).** The published `headBranch`
**must** equal the server-derived `writeTarget.workBranch` from
`start_local_run` — the backend links the run to the PR (and
auto-merges/applies it) only on the server work branch. If the recipe skips
`docs pull --branch <workBranch>`, space-cli falls back to generating its own
`jolli-<hex>` branch and opens the PR there, which silently breaks the run→PR
linkage (nothing merges, articles never publish) even though the run could
otherwise report success. The recipe therefore cross-checks the two branches
**deterministically** after publish — via a command rather than an LLM string
comparison, since a dropped branch is exactly an LLM failure — and on a mismatch
(or a missing `headBranch`) it stops, reports the broken link, and does **not**
call `complete_local_run` as if the run succeeded. The check is skipped only when
`pushed` is false (nothing was published). The load-bearing guarantees
(space-cli honoring `--branch`, the backend linking/merging by the reported
`headBranch` and refusing to report auto-merge when it cannot link a PR) live in
space-cli and the backend.

### Branch-integrity cross-check contract (frozen; consumed)

The cross-check is a **`@jolli.ai/space-cli` subcommand** —
`jolli space verify-publish-branch <expected> <actual>` — taking two branch names
and returning a machine-readable verdict. It is **not** a host command: no host
code implements it, and it is not wired or help-categorized alongside the host's
own thin helper commands. The shape the recipe consumes:

- **Input:** the expected branch (`writeTarget.workBranch`) and the actual branch
  (the `headBranch` that `docs publish --json` reported, or omitted/empty when
  publish reported none).
- **Output:** one JSON object on stdout — `{ match, expected, actual }`. Both
  `expected` and `actual` are echoed back trimmed. `match` is `true` **only**
  when both trimmed values are non-empty **and** identical.
- **Exit code:** `0` when `match` is `true`, else non-zero.
- A missing/empty `actual` branch is a **non-match** — an unverifiable publish is
  treated like a confirmed mismatch, so the recipe stops rather than assuming it
  landed right. An empty `expected` branch is likewise a non-match.

Because the cross-check rides the `space` command, its absent-plugin path is the
host's flat `space` stand-in: a single-package prose install hint on stderr with
a non-zero exit.

### Missing plugin install prompts (frozen)

When a required plugin is absent, every surface that needs it yields a clear,
actionable install prompt rather than a crash or a silent no-op.

- The **combined** install string surfaced by the offer path and the recipe is,
  per plugin: `npm i -g @jolli.ai/cli @jolli.ai/space-cli` and
  `npm i -g @jolli.ai/cli @jolli.ai/workflow-cli`.
- The generic per-command **stand-in** (the `docs` / `space` / `sync` / … fallback,
  spec 146) keeps its existing single-package hint
  (`npm install -g @jolli.ai/space-cli`) for consistency with the other Space
  stand-ins. **This split is intentional** and must not be "fixed" later as a
  false inconsistency: the offer/recipe messaging is where the user is told they
  need both packages; the individual stand-in is a per-command fallback.

## Behavior

### Offer discovery (as the recipe drives it)

1. The recipe invokes `workflow local-run` through the spawn-target convention and
   parses one JSON object off stdout.
2. On `{ type: "workflows", … }` it offers **only** the returned workflows,
   presenting each by `name` (falling back to `id`) and announcing that workflow's
   `autoMerges` outcome. An **empty array** is a normal state: the recipe tells the
   user there are no locally-runnable workflows (a destination must be a
   git-backed, already-cloned space) and stops.
3. On either needs-input shape (`workflow_cli_required`, `space_cli_required`) it
   tells the user to run the supplied install command and stops — no crash, no
   partial run.
4. On `{ type: "error", message }` it reports the message and stops.
5. The user picks one workflow (via the host's interactive single-select tool when
   it has one, else a text list) and the recipe keeps that workflow's `id`,
   passing it to `start_local_run` **exactly as returned** — a numeric id stays an
   unquoted number, a string id/slug stays quoted.

The eligibility rule that decides which workflows appear in step 2, and the
reads that feed it, are the plugin's; the recipe trusts the offer and never
re-derives runnability, never inspects the clone's git remotes to name a
destination, and never presents a `runnable:false` workflow.

### Review gate + heartbeat model

- After the agent writes files, it surfaces the **working-tree diff**. The human
  reviews and optionally edits, and must **explicitly approve** before anything is
  committed or pushed. Nothing is published without approval.
- The heartbeat cannot run *concurrently* with a blocking approval prompt: a
  typical agent turn is blocked while awaiting the human. The frozen model is a
  heartbeat (`report_local_run_progress`) **immediately before asking** and
  **immediately after the answer**, with the run otherwise silent during human
  deliberation.
- **Hard requirement on the backend (which owns run tracking and the lease):**
  the backend lease TTL **MUST exceed** plausible human review time (minutes,
  not seconds), because no heartbeat is sent while the human deliberates. This is
  a firm requirement, not a "tune the cadence later" note. A background timer
  that heartbeats *during* review is possible only in a future deterministic
  (non-agent-driven) command variant — noted as a seam, not built here.

### Lifecycle order (frozen)

1. **Discover eligible** — read the offer; present only what it returned.
2. **Announce** — tell the user, per chosen workflow, whether the PR will
   auto-merge (`autoMerges:true`) or open for team review (`autoMerges:false`).
3. `start_local_run(id)` → capture `{ runId, plan, writeTarget }`. Refer to the
   destination in user-facing prose by its space name / folder only; the backing
   repo and the work branch are internal plumbing, and an empty destination repo
   is normal for a private Jolli-managed destination.
4. `jolli docs pull --branch <writeTarget.workBranch>` (never `--agent`; the
   token is fetched inside `docs pull`).
5. **Agent writes** the workflow's files into the checked-out branch per `plan`.
6. **Local review/edit gate** — surface the diff; heartbeat immediately before
   asking and immediately after the answer; wait for explicit approval.
7. **On approve:** `jolli docs publish --json` (parse the one JSON object) →
   **cross-check the published `headBranch` against `writeTarget.workBranch`** via
   `space verify-publish-branch` and stop (do not complete as success) on a
   mismatch → `complete_local_run(runId, { prNumber, prUrl })`, omitting the PR
   reference entirely when publish withheld it, and releasing the run instead when
   nothing was published → surface the returned `willAutoMerge` (merged vs left
   open for review), judged against each article's actual published state.
8. **On cancel:** `abandon_local_run(runId)`.

### Degraded and error handling

- **Empty offer** (no candidates, or the offer degraded upstream) → no runnable
  offer. This is a normal degraded outcome, not an error.
- **`@jolli.ai/workflow-cli` plugin absent** → the host stand-in for `workflow`
  emits the `{ type: "workflow_cli_required", installHint }` needs-input result
  (stdout, exit 0), which the recipe handles like `space_cli_required` — tell the
  user to install (`npm i -g @jolli.ai/cli @jolli.ai/workflow-cli`) and stop.
  Never a crash.
- **space-cli / clones unavailable** → the offer surfaces the combined-install
  needs-input result (`npm i -g @jolli.ai/cli @jolli.ai/space-cli`), modeled on
  the `binding_required` non-error idiom (specs 148 / 230) — never a crash. A
  direct `docs` / `space` invocation with the plugin absent hits the flat Space
  stand-in's single-package prose hint and non-zero exit instead.
- **Non-git-backed or non-cloned workflow** → never appears in the offer, so the
  backend's `start_local_run` refusal is never reached through this path.
- **Publish landed on the wrong branch** → the cross-check reports `match:false`
  (or exits non-zero); the recipe stops, tells the user the run→PR link is broken
  (naming the actual vs expected branch), and does not complete the run as a
  success.

### Spawn-target convention encoded in the recipe

Every command-line call the recipe makes — the offer (`workflow local-run`), the
git operations (`docs pull`, `docs publish`), and the branch cross-check
(`space verify-publish-branch`) — resolves the binary through the
`~/.jolli/jollimemory/run-cli` entry script that host MCP registration already
writes (spec 148 / the MCP-host registrars), **never** a bare `jolli` on `PATH`.
Under GUI-launched hosts and the editor bundle (which by design needs no global
CLI install), a bare `PATH` spawn misfires and would misreport "plugin missing".
The recipe body encodes this convention literally in every command block, and the
same convention applies to any other code that spawns the CLI to reach a plugin
subcommand.

## State Transitions

A local run observed from the client's agent loop moves through:

1. **Offered** — the workflow was returned by the offer and presented with its
   `autoMerges` signal. No backend run exists yet.
2. **Active** — `start_local_run` returned a `runId`; the agent branch is
   checked out via `docs pull --branch`; the agent is writing. The lease is kept
   alive by heartbeats around the review prompt.
3. **Awaiting approval** — the diff is surfaced; the human is reviewing/editing.
   A heartbeat was sent immediately before the prompt.
4. **Published** — the human approved; `docs publish` opened the PR; the branch
   cross-check passed; `complete_local_run` reported `willAutoMerge`. Terminal
   (success).
5. **Abandoned** — the human cancelled, nothing was published, or the branch
   cross-check failed; `abandon_local_run` released the run. Terminal (cancel).

There is no host-held cross-call session state binding these transitions
together — the ordering is enforced by the recipe skill driving the calling
agent, not by the stateless MCP server.

## Notable Behavior

- **The stand-in's two branches are asymmetric on purpose.** `local-run` emits a
  machine-readable needs-input object on **stdout** and exits **zero**; every other
  subcommand (and the no-subcommand case) prints a prose install hint on
  **stderr** and exits **non-zero**. The two consumers detect absence in those two
  different ways, so "making them consistent" would break one of them.
  (Load-bearing; the most easily-broken invariant in this feature.)
- **The workflow stand-in is one command with a forwarded variadic argument,
  not a family of subcommands.** It deviates from the other plugin stand-ins
  because the real surface is one top-level command with subcommands. Unknown
  options are tolerated so the full real invocation reaches the action, and the
  registration declines rather than throwing when the name (or an alias) is
  already taken. (Notable.)
- **`autoApply` is never an eligibility input.** A git-backed, cloned workflow is
  runnable whether auto-apply is on or off; the flag only decides whether the
  user is told "this PR will auto-merge" or "this opens for team review". Making
  it an eligibility gate would wrongly hide review-first workflows. (Surprising;
  intentional.)
- **An empty offer is a normal state, not a failure.** The feature lights up only
  once the backend serves candidate workflows whose destinations are git-backed
  and cloned locally; until then the recipe's correct behavior is to say so and
  stop. (Notable.)
- **`docs pull` is always `--branch`, never `--agent`.** `--agent` runs a
  destructive `git clean -fdx`; the local-run flow must preserve the developer's
  untracked files, so it checks out the server-derived branch without cleaning.
  (Safety-critical.)
- **The recipe never touches the write token.** The token is fetched inside
  `docs pull` because an agent driving `Bash` + MCP has no way to call a
  space-cli library function; instructing it to "fetch the token" would be
  unexecutable. (Load-bearing.)
- **The branch cross-check is deterministic and delegated, not eyeballed.** A
  dropped or substituted branch is exactly the kind of failure an LLM comparison
  would miss, so the recipe shells a command and reads a boolean verdict. That
  command now lives in space-cli, so the check depends on a *second* plugin being
  installed — its absence surfaces as the flat `space` stand-in's install hint.
  (Notable; a real cross-plugin dependency.)
- **The heartbeat brackets the approval prompt; it does not run during it.** A
  blocking human prompt suspends the agent turn, so the realistic model is
  heartbeat-before-ask and heartbeat-after-answer, which forces the backend lease
  TTL to exceed human review time. (Surprising; imposes a hard backend
  requirement.)
- **Two install strings coexist by design.** The offer/recipe path surfaces the
  combined `npm i -g @jolli.ai/cli @jolli.ai/<plugin>`; the generic per-command
  stand-in keeps its single-package hint. This is deliberate, not drift.
- **The host stands in for `init` / `space` / `source` / `impact` / `sync` /
  `docs` / `agent`.** The `docs` stand-in makes `jolli docs pull` /
  `jolli docs publish` emit the single-package install prompt (not a parser
  error) when the space-cli plugin is absent, exactly like the other Space
  stand-ins.
- **The deliverable here is a recipe, not a monolithic CLI command.** A single
  CLI command has no agent to write the workflow's files; what this repository
  ships is the recipe body, the stand-in surfaces it degrades through, and the
  frozen contracts it consumes. (Load-bearing.)
- **The offer's implementation left this repository; its shape did not.** The
  eligibility rule, the candidate-list read, and the clones read are the
  workflow-cli plugin's code now. They remain specified here because the recipe's
  behavior — and the "never offer a non-runnable workflow" safety property —
  depends on the offer conforming. (Notable; the split is the point.)

## Shared Behavior

- The manifest-driven platform-tool surface (advertisement, best-effort fetch,
  the generic executor's verbatim-body / body-carrying-method / same-origin
  rules and conventional-endpoint fallback, the activation gate, and the
  `binding_required` needs-input envelope) is owned by **spec 148**. The run
  tools are consumed through it with no host registration.
- The `binding_required` / needs-input non-error result idiom this feature reuses
  for "not eligible", "not cloned", and "install a plugin" is owned by
  **specs 148 and 230**.
- The plugin loader and stand-in fallback model (a missing plugin still appears in
  `--help` and prints an install hint on invocation; the host knows only
  top-level command names; the workflow stand-in's single-command deviation and
  its JSON/exit-zero carve-out) is owned by **specs 146 and 147**.
- The umbrella `/jolli` menu skill the recipe is listed under is owned by
  **spec 272** (content) and **spec 48** (skill installation, revision guard,
  dual-write, and the startup self-heal that rewrites stale recipes to the
  namespaced command names).
- **Post-completion reporting** — the enriched per-run read model, the report
  shape, run history, and the open-in-browser command — is owned by **spec 274**,
  which continues from this spec's terminal "Published" state.
- The workflow-cli plugin's offer implementation, the backend run-tracking store,
  lease sweeper and lease TTL, space clone registry, work-branch/write-target
  derivation, PR auto-merge on destination auto-apply, and the space-cli
  subcommands' implementations live outside this repo; this spec freezes only the
  shapes the recipe depends on.
