# 274. Workflow-Run Result Reporting (remote + local), Open-in-Browser, and Run History

## Topic Statement

When a developer runs a Jolli **workflow** from the host CLI — a **remote manual
run** (the backend executes it server-side; the trigger tool returns only a run
id) or a **local run** (the calling client's own agent executes the recipe, then
completes the run through the MCP tools) — the outcome must be reported and
**links to what was produced** surfaced, with an offer to open any of those links
in the developer's browser. A workflow's **run history** must be listable with the
same per-run links.

The per-run **result read model** consumed here is enriched at the platform-tool
surface: each run carries a typed article-write manifest, a typed pull-request
reference (deliberately withheld for private Jolli-managed destinations),
absolute per-tenant deep-links to the workflow and the run, and cancel
attribution (who cancelled, when). **No URL is ever constructed** — every URL and
every manifest entry is read straight off the payload, and exactly what the
payload carried is what gets opened.

The `jolli mcp` server is **stateless** — one dispatch per call, no cross-call
session state, no server-initiated push, no way to pop an interactive prompt
(standard input/output is the JSON-RPC transport, spec 148). Therefore "report
the result and offer to open links" means the **calling client's agent loop**
drives an ordered sequence of MCP tool calls plus `jolli` (`Bash`) helper calls,
guided by an installed **recipe skill**; the "offer to open" is the agent using
its host's own interactive tool and then shelling `jolli open-url <url>`.

The work splits across two packages, and the split moved once already:

- **Still owned end-to-end here:** the `jolli open-url` command and its
  browser-open primitive, including the three-tier origin allowlist; and the
  recipe/menu prose that renders the report, offers to open each URL, and probes
  for the monitor's presence before spending run budget.
- **Now owned by the `@jolli.ai/workflow-cli` plugin:** the run-status read, the
  poll-to-terminal monitor, the report shaper, and the run-history list. Their
  **shapes** are frozen below as contracts the locally-authored recipes parse; no
  host code implements them.

This spec fills the **workflow-run history / open-in-browser** seam that spec 273
explicitly deferred.

## Scope

**In scope:**

- The **enriched per-run read model** the recipes' report surfaces expose — the
  exact field shapes, the run-status vocabulary and which values are terminal,
  and the openability rules (active-only article URLs, withheld PR).
- The **report shape** (`RunReport`) the recipes parse, including its
  wire-status-to-report-status mapping and its openable-URL composition rules.
- The **local-run reporting additions**: after completing a local run, report the
  article URLs (auto-apply on) or the PR URL (auto-apply off) plus the workflow
  URL, reusing the same read-model fields.
- The **open-in-browser command and primitive** — open a single backend-supplied
  `https` URL in the default browser, or print it (headless / no browser / launch
  failure / off-allowlist origin) — never throw, never block — plus its
  three-tier origin allowlist and its JSON/exit-code contract.
- The **run-history projection** (`RunHistoryEntry`) the menu's history action
  consumes: per run, its status, timestamp, workflow/run deep-links, the PR URL
  when present, and the still-active article URLs.
- The **surface split** across the three commands the recipes shell — one host
  builtin and two plugin subcommands — and how each one's absence is detected.
- The **recipe/menu wiring** that drives the interactive report-and-open,
  including the **pre-trigger presence probe** that protects a budget-spending
  remote run from being started with no monitor installed.
- The **degraded behavior** at each surface.

**Boundaries:**

- The **run-status read, the poll-to-terminal monitor, the report shaper, and the
  history list are implemented in the `@jolli.ai/workflow-cli` plugin**, not in
  this repository. This spec freezes the shapes and the observable command
  contracts the recipes depend on; it defines no host code for them, and their
  internal retry/backoff/triage policies are the plugin's.
- The **manifest-driven platform-tool surface** — how the run tools are
  advertised, the best-effort manifest fetch that degrades to no platform tools,
  the generic executor that forwards arguments verbatim as a JSON body over a
  body-carrying same-origin binding (falling back to `POST /api/mcp/tools/<name>`),
  and the activation gate — is owned by **spec 148**. This spec *consumes* those
  tools; it defines **no** host registration or dispatch for them.
- The **backend halves** — run tracking, the derivation of the read-model fields,
  the auto-merge decision, the article-share-URL and deep-link construction, and
  the private-destination redaction — live in the backend, not in this repo. This
  spec freezes the **wire shapes** relied upon, not their implementation.
- The **local-run lifecycle up to completion** (the offer, `start_local_run`,
  `docs pull`/`docs publish`, the branch cross-check, the review-gate + heartbeat
  model, the cancel path) is owned by **spec 273**. This spec adds only what
  happens **after** `complete_local_run` returns: reporting its result and
  offering to open links.
- The **`/jolli` menu skill** (content) is owned by **spec 272** and its
  installation by **spec 48**; this spec states only how the menu's remote path
  and its history action route into the surfaces defined here.
- The **existing browser-launch precedent** (the sign-in flow) is owned by
  **spec 52**; this spec factors a reusable open-or-print primitive and states its
  stricter scheme guard.
- **Routing local-run source reads to a local clone** is a separate feature; this
  spec notes it as a seam and defines it not at all.

## Data Contracts

### The run tools consumed (arguments + top-level return)

All are generic manifest relays (spec 148), invoked by the plugin's report
surfaces (and, for the trigger and cancel tools, directly by the recipes).

| Tool | Arguments | Top-level return |
| --- | --- | --- |
| `run_remote_workflow` | `id` (numeric workflow id), optional `templateVariables` | `{ runId }` |
| `cancel_remote_workflow` | `id` (numeric workflow id) | `{ runId }` (the cancelled run's id) |
| `get_run_status` | `runId` (string) | `{ run: WorkflowRun }` — **an envelope**; the run object is under `run` |
| `list_workflow_runs` | `id` (numeric workflow id), optional `limit` (1–200), optional keyset `beforeCreatedAt` + `beforeId` (supply both together) | `{ runs: WorkflowRun[] }` — **an envelope**; the array is under `runs`, newest first |

**Frozen:** `run_remote_workflow` and `cancel_remote_workflow` take the workflow's
numeric `id`; `get_run_status` takes a string `runId`; `list_workflow_runs` takes
the workflow's numeric `id` (not a `workflowId` key). Both status tools return an
**envelope** (`{ run }` / `{ runs }`), never a bare object/array — the consumer
must unwrap it. The trigger and cancel tools return a bare `{ runId }`.

### `WorkflowRun` — the enriched per-run read model

Both `get_run_status` and `list_workflow_runs` return this identical shape (the
list is not a reduced subset). The reporting surfaces consume these fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | the run id |
| `workflowId` | `number` | the parent workflow's numeric id |
| `createdAt` | `string` (ISO) | run creation time — the history timestamp |
| `status` | `JobStatus` | see the status vocabulary below |
| `triggeredBy` | `"manual" \| "schedule" \| "event"` | what initiated the run |
| `executionMode` | `"server" \| "local"` (optional) | absent legacy value surfaces as `"server"` |
| `startedAt` / `completedAt` | `string` (ISO, optional) | lifecycle timestamps |
| `error` | `string` (optional) | **failure only**; format `code=<code>: <detail>` — the troubleshooting narrative for a failed run |
| `completionInfo` | `{ message: string, … }` (optional) | **success only**; `message` is the success narrative. **Not** populated on failure |
| `outputSummary` | `string` (optional) | **declared but never populated** on this wire — do **not** read it for the outcome narrative |
| `stats` | object (optional) | run stats; `prNumber`/`prUrl` here are stripped for private destinations (see withholding) |
| `writtenArticles` | `WorkflowRunWrittenArticle[]` (optional) | the article-write manifest (below) |
| `pullRequest` | `WorkflowRunPullRequest` (optional) | present only for a git-backed, non-private run with a verified PR (below) |
| `workflowUrl` | `string` (optional) | absolute per-tenant deep-link to the workflow; **omitted when the destination space is unresolvable** |
| `runUrl` | `string` (optional) | absolute per-tenant deep-link to this run; omitted with `workflowUrl` |
| `canceledBy` | `string` (optional) | resolved display name (`name ?? email`) of the canceller; best-effort, absent unless a user cancelled |
| `canceledAt` | `string` (ISO, optional) | when the run was cancelled |

**`WorkflowRunWrittenArticle`** — one entry per file the run wrote:

| Field | Type | Notes |
| --- | --- | --- |
| `operation` | `"created" \| "edited" \| "deleted"` | the changeset op |
| `docId` | `number` (optional) | the document row id, present only when resolved |
| `title` | `string` (optional) | cosmetic |
| `path` | `string` | always present (server/repo-relative) |
| `url` | `string \| null` | **the share URL, populated only for a still-active, docId-bearing article** |
| `active` | `boolean` | whether the article currently exists |

**Article-URL openability (frozen).** An article is openable **iff**
`active === true && url != null`. A **freshly-created** article resolves to
`active:false, url:null` until the backend reindexes and materializes its document
row (a later status read fills the URL in). A **deleted** article is
`active:false, url:null`. A `null` URL means "not yet openable" and a URL must
**never** be fabricated.

**`WorkflowRunPullRequest`** — `{ number: number, url: string, state: "open" | "merged" | "closed" }`.
Present only for a git-backed run that opened a verified PR whose destination is
**not** a private Jolli-managed repo.

### Run-status vocabulary (frozen)

`status` is a `JobStatus`, one of exactly:

```
"queued" | "active" | "completed" | "failed" | "cancelled"
```

- **In-progress (non-terminal):** `queued`, `active`.
- **Terminal:** `completed`, `failed`, `cancelled`.

**The success value is `completed`, not `succeeded`.** A monitor polls until the
wire status is one of the three terminal values.

### Private "Jolli-managed" destination withholding (load-bearing)

For a private Jolli-managed destination (the backend flags it when the destination
space's backing is a legacy `jolli-git` space, or a git space whose backing repo
kind is `jolli` — a Jolli-employee-only repo), the read model **omits** the
`pullRequest` field entirely and strips `prNumber`/`prUrl` from `stats`, while the
`writtenArticles` manifest (the customer-accessible share links) is left intact.
An **absent PR is therefore normal, not an error**; a repo/PR link that is not in
the payload must **never** be surfaced; and the article URLs must still be
surfaced. Absence of `pullRequest` is indistinguishable from "no PR opened" —
both mean "no PR link to show", which is the correct behavior.

### `RunReport` — the report shape (frozen; consumed)

The report is the JSON the plugin's `workflow run-status` subcommand prints and
the recipes parse. It is derived purely from one `WorkflowRun` payload: no
fetching, no spawning, and a well-formed-but-sparse payload simply yields fewer
openable URLs rather than an error.

```
RunReport = {
  status: "succeeded" | "failed" | "cancelled" | "running",
  openableUrls: Array<{ kind: "workflow" | "run" | "article" | "pr", url: string, label?: string }>,
  cancel?: { by?: string, at?: string },
  troubleshooting?: string,
  timedOut?: boolean,
}
```

**Wire-status → report-status mapping (frozen):**

| Wire `status` | Report `status` |
| --- | --- |
| `completed` | `succeeded` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `queued`, `active` | `running` |

**openableUrls composition rules:**

- Include `{ kind: "workflow", url: workflowUrl }` and `{ kind: "run", url: runUrl }`
  each only when present on the payload.
- Include one `{ kind: "article", url }` per `writtenArticles` entry **only** when
  `active === true && url != null` (using `title`/`path` as the optional `label`).
- Include `{ kind: "pr", url: pullRequest.url }` **only** when `pullRequest` is
  present (never fabricated for a withheld/no-PR run).

**cancel** is populated (`{ by: canceledBy, at: canceledAt }`) when either is
present. **troubleshooting** is the `error` string for a `failed` run (the
`code=<code>: <detail>` narrative); `outputSummary` is never read. **timedOut** is
set when a monitor gave up polling while the run was still non-terminal (see the
consumed monitor contract below).

### `complete_local_run` result (freezes the completion field name)

`complete_local_run` (spec 273 owns the lifecycle up to this call) returns, on
success:

```
{
  prNumber?: number,        // omitted for a private Jolli-managed destination
  willAutoMerge: boolean,   // the auto-apply signal — FROZEN as `willAutoMerge`
  prUrl?: string,           // omitted when withheld (private) or not supplied
  workflowUrl: string,      // always present on success
  runUrl: string,           // always present on success
  writtenArticles?: WorkflowRunWrittenArticle[], // present only on the auto-apply path
}
```

**Frozen: the completion result's auto-apply field is `willAutoMerge`** (a
boolean), which is what the installed local-run recipe already reads. Spec 273's
eligibility-verdict field `autoMerges` (mapped from the destination's auto-apply
flag) is a **different** field; this spec is authoritative for the completion
result.

- **`willAutoMerge: true` (auto-apply on):** the PR is set to auto-merge, so the
  **articles are the artifact** — `writtenArticles` is populated; report the
  active article URLs + `workflowUrl`. `true` is the destination's *intent*, not a
  confirmation the merge already completed.
- **`willAutoMerge: false` (auto-apply off / review-first):** the open **PR is the
  artifact** — `writtenArticles` is omitted; report `prUrl` + `workflowUrl`.
- **Private Jolli-managed destination:** completion returns no `prNumber`/`prUrl`;
  report **article URLs only** (never a repo/PR link), plus `workflowUrl`.

### Command surfaces (JSON to stdout, one object per line)

Three thin commands, split across two packages:

- **`open-url` is a host builtin.** It is registered by the host and categorized
  under the "Jolli Memory" help group; the help-categorization regression test
  fails if a builtin is left ungrouped.
- **`workflow run-status` and `workflow runs` are plugin subcommands.** They are
  **not** host builtins and are not in the host's help-group name list; they are
  two subcommands of the single `workflow` command provided by the
  `@jolli.ai/workflow-cli` plugin, grouped under **"Jolli Workflows"**. When the
  plugin is absent, the host's `workflow` stand-in answers instead: for
  `run-status` / `runs` it prints a **prose install hint on stderr and exits
  non-zero** (the `local-run` branch instead emits machine-readable JSON on stdout
  and exits zero — that asymmetry is spec 273's contract).

| Command | Surface | Argument | Success stdout | Failure |
| --- | --- | --- | --- | --- |
| `jolli open-url <url>` | host builtin (Jolli Memory) | one `https` URL | `{ opened: boolean, url }`, exit 0 (an off-allowlist origin adds `refused: true, reason: "origin-not-allowlisted"` — printed, never launched) | non-`https` / missing URL → `{ type: "error", message }`, exit 1 |
| `jolli workflow run-status <runId>` | `@jolli.ai/workflow-cli` plugin (Jolli Workflows) | a run id | the `RunReport` JSON (including `timedOut?`), exit 0 | unexpected failure → `{ type: "error", message }`, exit 1; **plugin absent** → host stand-in prints a prose install hint on stderr, exits non-zero |
| `jolli workflow runs <workflowId>` | `@jolli.ai/workflow-cli` plugin (Jolli Workflows) | a workflow id | `{ type: "runs", runs: RunHistoryEntry[] }`, exit 0 | list unavailable → degrade to `{ type: "runs", runs: [] }` (or `{ type: "error", message }`, exit 1); **plugin absent** → host stand-in prints a prose install hint on stderr, exits non-zero |

`RunHistoryEntry = { runId, status, timestamp, workflowUrl?, runUrl?, prUrl?, articleUrls: string[] }`
— each entry projected from the same read model (the report `status`, `runUrl`/
`workflowUrl`/PR mapped through, `articleUrls` = the active article URLs).
`timestamp` is the run's `createdAt`. `prUrl` appears only when the payload carried
a `pullRequest`.

## Behavior

### Consumed monitor and history contracts (plugin-implemented)

The recipes depend on these observable behaviors of the two plugin subcommands;
their retry, backoff, and failure-triage policies are the plugin's own.

- **`workflow run-status <runId>`** polls the run until its wire status is
  terminal (`completed` / `failed` / `cancelled`), then prints the shaped
  `RunReport` on stdout and exits 0. It **never hangs**: when its own attempt or
  wall-clock budget is exhausted while the run is still `queued`/`active`, it
  prints a still-running report — `{ status: "running", timedOut: true,
  openableUrls: [workflowUrl and/or runUrl, each only when present] }` — so the
  user can watch the in-progress run and the recipe can re-invoke the command
  later to pick it up again. The budget is expected to fit inside a typical agent
  shell-tool timeout, so the graceful `timedOut` report reaches the agent rather
  than the shell tool timing out first. An unrecoverable failure is surfaced as a
  **reported** `{ type: "error", message }` with a non-zero exit, never an
  uncaught crash.
- **`workflow runs <workflowId>`** prints `{ type: "runs", runs: [...] }` newest
  first, degrading to an **empty list** rather than failing when the history read
  is unavailable.
- Neither command opens a browser itself; opening is `jolli open-url`, offered by
  the recipe.

### Browser-open primitive

The host's open-or-print primitive resolves a single URL to
`{ opened: boolean, url, refused?: boolean, reason?: string }`, reusing the
already-declared browser-launch dependency through the lazy-import + detached
(unreferenced) child pattern the sign-in flow established:

- **`https:`-only** — any other scheme is rejected with a typed error
  (defense-in-depth: every backend-supplied URL is `https`; the editor
  extension's own link sink is laxer, and the loopback sign-in-callback exception
  of spec 52 is out of scope here).
- **Origin-allowlisted** — the origin must pass the gate below, else the URL is
  **refused-and-printed, never launched** (`{ opened: false, url, refused: true,
  reason: "origin-not-allowlisted" }`, exit 0).
- **Headless detection** → skip the launch and print the URL (Linux with no
  display-server environment variable, or a CI environment marker).
- On any launch failure → print the URL. **Never throw, never block.**
- The URL is opened **verbatim** — nothing is constructed.

`jolli open-url <url>` is thin wiring around that primitive: one JSON line
`{ opened, url }` (plus `refused`/`reason` on an off-allowlist refusal); bad input
prints `{ type: "error", message }` and sets a non-zero exit-code property — the
same thin-command pattern every other host helper command follows.

### Origin-allowlist gate (open-url)

Before launching, the primitive checks the URL's origin against a **two-tier
allowlist** (plus an opt-in third tier, empty by default) so a buggy or compromised
backend payload can never turn `open-url` into an arbitrary-launch / open-redirect
primitive. A disallowed origin is **refused (not launched) and printed** — the same
safe fallback as headless — so the URL still reaches the user but is never
auto-opened.

- **Tier 1 — jolli origins.** The canonical product-origin assertion is reused
  **verbatim** (https-only + suffix-boundary matching against the product's own
  hosts). That assertion is a critical-rules lockstep artifact across the CLI, the
  editor extension, and the JVM port — this gate only *calls* it, never forks or
  edits it. Workflow / run / article deep-links are jolli origins ⇒ allowed.
- **Tier 2 — known git hosts.** PR URLs point at an external git host, not a jolli
  origin, and are withheld entirely for private Jolli-managed destinations. A small
  named set local to this gate (**not** added to the canonical product-origin
  list) — `github.com`, `gitlab.com`, `bitbucket.org` — matched with the same
  https + suffix-boundary rule. A self-hosted git PR URL (e.g. an enterprise
  install on a custom domain) falls outside the set and degrades to print-only.
- **Tier 3 — opt-in dev origins (empty by default).** A **local-development
  affordance** for tunnel/dev deployments, where the backend renders deep-links from
  its configured public base URL (e.g. a tunnel host) that is neither a jolli origin
  nor a known git host — so tiers 1–2 correctly refuse them. A dev opts in via
  **two merged sources**: the persisted config key `openUrlAllowedOrigins` (an array
  in the machine-global configuration) **and** the
  `JOLLI_OPEN_URL_ALLOWED_ORIGINS` environment variable (comma-separated). The two
  are **unioned — the environment adds to config, it does not replace it** — so a dev
  can keep a persistent config entry and add session-specific origins via the
  environment. Each entry is a bare host or a full `https://…` origin, normalized to
  a host, matched with the same https + suffix-boundary rule as tiers 1–2. **Both
  empty (the default) ⇒ no dev origins**, so the gate is byte-identical to the
  two-tier default and production / normal users are unaffected. The tier lives with
  this gate (the canonical product-origin list stays jolli-only and unforked); the
  command loads the config key and passes it in, mirroring how other gates take an
  injected configuration rather than reading the file themselves. The URL being
  opened is still `https`-only regardless of this tier, and a malformed entry is
  dropped, never thrown.

Anything outside all tiers is refused-and-printed (exit 0). The gate precedes the
headless check — an off-allowlist URL is refused regardless of display. The
`https:`-only guard still fails (exit 1) for a non-`https`/unparseable URL; the gate
is a separate origin check on an already-valid `https` URL.

### Recipe / menu wiring (interactive report-and-open)

- **Local run** — the `jolli-local-run` recipe (spec 273), after
  `complete_local_run`, reads the completion result and: auto-apply on → present
  the created/edited **article URLs** + workflow URL; auto-apply off → present the
  **PR URL** + workflow URL; private destination → present **article URLs only**;
  then offers to open each via `open-url`, invoked through the `run-cli` entry
  script (spec 273's spawn-target convention).
- **Remote run** — the `jolli-remote-run` recipe **preflights the monitor's
  availability before triggering the run**, then drives `run_remote_workflow` →
  captures `{ runId }` → shells `workflow run-status <runId>` to monitor to
  terminal → renders failed / cancelled / succeeded → offers `open-url` for each
  URL → notes that an in-flight run can be cancelled via `cancel_remote_workflow`.
  The preflight matters because `run_remote_workflow` is a backend platform tool
  that creates a real, **budget-spending** run even when the plugin monitor
  (`workflow run-status`) is absent — triggering without the monitor would leave
  the run orphaned (running server-side with no way for the recipe to report its
  outcome). So the recipe first runs `workflow local-run` purely as a
  **plugin-presence probe**: if it returns `{ "type": "workflow_cli_required" }`
  the recipe tells the user to install `@jolli.ai/workflow-cli` and **stops without
  triggering the run**; any other result (only the stand-in emits
  `workflow_cli_required`) means the plugin is present, so it proceeds. The
  post-trigger detection — the monitor command printing a prose install hint and
  exiting non-zero — is kept as a backstop.
- **`/jolli` menu** (spec 272) — the "Run a workflow" **remote** path routes to the
  `jolli-remote-run` recipe (not the raw tool), mirroring how local routes to
  `jolli-local-run`; a **"Workflow history"** action shells `workflow runs
  <workflowId>` and offers to open any listed URL. Both the remote-run recipe's
  monitor path and the menu's history path also surface the install hint when
  `workflow run-status` / `workflow runs` hit the absent-plugin stand-in. The menu
  stays a thin front door — it routes, never re-implements — and keeps the raw-tool
  exclusions (`run_remote_workflow`, `cancel_remote_workflow`,
  `list_workflow_definitions`).

The run tools have **no CLI mirror** — the recipes prefer the `mcp__jollimemory__*`
tools for triggering/cancelling/completing runs and shell the CLI only for the
deterministic monitor, history, and open-url helpers.

### Degraded behavior

- **Platform tools off / a run tool absent from the manifest / transport failure:**
  the plugin's monitor surfaces a **reported** error (`{ type: "error" }`, non-zero
  exit) rather than hanging or crashing, and its history surface degrades to an
  **empty list** so a genuine fault does not look like a crash — while still
  remaining diagnosable in the debug log rather than being indistinguishable from a
  truly empty history. How the plugin distinguishes a permanent tool-absent
  condition from a transient blip is its own concern.
- **Plugin absent:** `workflow run-status` / `workflow runs` hit the host
  stand-in's prose install hint on stderr with a non-zero exit; the recipes detect
  exactly that and tell the user to install the plugin. For the budget-spending
  remote path this is a backstop only — the pre-trigger probe is the primary
  defense.
- **Sparse payload** (missing optional fields — no `pullRequest`, `url:null`
  articles, absent `workflowUrl`): the report simply carries fewer openable URLs
  and is never an error.
- **Headless / no browser / launch failure:** `open-url` prints the URL and returns
  `{ opened: false, url }` with exit 0.
- **Off-allowlist origin:** `open-url` refuses to launch and prints the URL,
  returning `{ opened: false, url, refused: true, reason: "origin-not-allowlisted" }`
  with exit 0 — a safe outcome, not an error; the recipe surfaces the URL for the
  user to open manually.

## State Transitions

A **remote** run observed through the monitor surface:

1. **Triggered** — `run_remote_workflow` returned `{ runId }`. No report yet.
2. **Polling** — the run is `queued`/`active`; the monitor keeps polling.
3. **Reported (terminal)** — status reached `completed`/`failed`/`cancelled`; the
   shaped report (succeeded / failed / cancelled) is printed. Terminal.
4. **Timed out** — the monitor's budget was exhausted while still non-terminal; a
   `running`+`timedOut` report is printed, carrying **both** the workflow and the
   run deep-links (each only when present), so the user can watch the
   still-in-progress run (the run continues server-side) and the recipe can
   re-invoke the monitor later.

A **local** run continues from spec 273's terminal "Published" state: after
`complete_local_run` returns, the recipe reports the article/PR URLs and offers to
open them. There is no host-held cross-call state binding these transitions — the
ordering is enforced by the recipe driving the calling agent, not by the stateless
MCP server.

## Notable Behavior

- **The success status on the wire is `completed`, not `succeeded`.** The report
  maps `completed → succeeded` for presentation, but a monitor's terminal check
  keys off the wire value `completed`. Assuming `succeeded` would silently never
  terminate. (Surprising; frozen against the backend source.)
- **Both status tools return an envelope.** `get_run_status` → `{ run }` and
  `list_workflow_runs` → `{ runs }`; the consumer must unwrap. A parser expecting a
  bare object/array would read nothing — the same class of drift that once made a
  workflow-list parser silently drop every entry. (Load-bearing.)
- **The completion field is `willAutoMerge`.** Not `autoMerges` (that is spec 273's
  eligibility-verdict field). The installed recipe reads `willAutoMerge`. (Notable.)
- **`writtenArticles` presence on completion mirrors the artifact.** It is
  populated only on the auto-apply path (articles are the artifact); on the
  review-first path it is omitted and the open PR is the artifact. This lines up
  exactly with "auto-apply on ⇒ article URLs, auto-apply off ⇒ PR URL". (Notable.)
- **A `null` article URL is a not-yet state, not an error.** A just-created article
  has no share URL until reindex; it is shown as unopenable and a later status read
  fills it in. Fabricating a URL is forbidden. (Safety.)
- **Withheld PR is normal.** Private Jolli-managed destinations omit `pullRequest`
  and strip `prNumber`/`prUrl` from `stats` while keeping article URLs; an absent
  PR is never an error and a repo/PR link the payload did not carry is never
  surfaced. (Load-bearing; not an edge case.)
- **The failed-run narrative comes from `error`, not `outputSummary`.**
  `outputSummary` is declared on the wire but never populated; a failed run's
  troubleshooting text is the `error` string (`code=<code>: <detail>`), and a
  succeeded run's narrative is `completionInfo.message`. (Surprising.)
- **The monitor must report rather than hang.** Its budget is expected to fit
  inside an agent shell-tool timeout so a still-running run comes back as a
  graceful `timedOut` report the agent can render (and re-poll later), instead of
  the shell tool timing out first. The recipes depend on that behavior even though
  the polling itself is the plugin's. (Load-bearing.)
- **Open-in-browser is a standalone command, not a `--open` flag.** The "offer to
  open" is interactive (the agent asks which URL), so the primitive is a
  `jolli open-url <url>` the recipe shells per chosen URL — matching the
  stateless-MCP / recipe-driven model (report commands print JSON; the agent
  renders and offers). (Load-bearing.)
- **Every URL is read verbatim off the payload.** No workflow, run, article, or PR
  URL is ever constructed — exactly what the backend supplied is what is opened.
  (Core invariant.)
- **`open-url` launches only allowlisted origins.** A two-tier gate (jolli origins
  via the reused-verbatim product-origin assertion, plus a known git-host set for
  PR links) — plus an opt-in dev-origins third tier that is **empty by default**
  (the `openUrlAllowedOrigins` config key merged with the
  `JOLLI_OPEN_URL_ALLOWED_ORIGINS` environment variable, a local-dev affordance for
  tunnel deep-links) — runs before the launch; any other origin is
  refused-and-printed, never launched, so a crafted payload cannot weaponize
  `open-url` into an arbitrary launch. A refusal is exit 0 (a safe outcome),
  distinguished from a headless print only by `refused: true`. (Safety.)
- **The pre-trigger presence probe protects real budget.** The remote-run recipe
  probes for the plugin with a non-spending command *before* calling the trigger
  tool, because triggering without a monitor creates a real server-side run the
  recipe could never report on. The probe leans on the stand-in's
  needs-input-on-stdout branch being the **only** producer of
  `workflow_cli_required`, so "any other result" is a sound presence signal.
  (Load-bearing; ordering matters.)
- **The report-and-monitor surfaces moved out; their shapes did not.** The
  run-status read, the poll loop, the shaper, and the history list are the
  workflow-cli plugin's code. They stay specified here because the locally-authored
  recipes parse their output and because the read model, the report shape, and the
  history projection are the contract that keeps both sides interoperable.
  (Notable; the split is the point.)

## Shared Behavior

- The manifest-driven platform-tool surface (advertisement, best-effort fetch, the
  generic executor's verbatim-body / body-carrying-method / same-origin rules and
  conventional-endpoint fallback, the activation gate, and the `binding_required`
  needs-input envelope) is owned by **spec 148**. The run tools are consumed
  through it with no host registration.
- The local-run lifecycle up to `complete_local_run` — the offer contract, the
  workflow stand-in's asymmetric branches, `docs pull` / `docs publish`, the
  branch cross-check, the review-gate + heartbeat model, the `run-cli`
  spawn-target convention, and the cancel path — is owned by **spec 273**. This
  spec extends only the post-completion reporting.
- The `/jolli` menu skill content is owned by **spec 272** and its installation
  (revision guard, git-exclude, startup self-heal) by **spec 48**; the recipe
  skills' installation follows the same model.
- The browser-launch precedent (detached, unreferenced child; print the URL as a
  fallback) is owned by **spec 52**; this spec factors a reusable open-or-print
  primitive with a stricter `https`-only guard.
- The jolli-origin allowlist is owned by **spec 55** (Jolli Origin Allowlist
  Enforcement) and kept in lockstep across its CLI / editor-extension / JVM
  implementations; `open-url`'s origin gate **reuses it verbatim** (no fork) and
  layers a local git-host set (plus an opt-in dev-origins tier) on top.
- The thin-command pattern (a registration function wiring a core function, one
  JSON line to stdout, `{ type: "error", message }` plus a non-zero exit-code
  property on failure) is shared with every other CLI helper command. The
  help-group categorization gate applies to the **host builtin `open-url`** only;
  `workflow run-status` / `workflow runs` are plugin subcommands grouped under
  "Jolli Workflows" by the plugin (or by its host stand-in when absent), not by the
  host's builtin name list.
- The plugin loader and stand-in fallback model — including the workflow
  stand-in's single-command shape and its stdout-JSON/exit-zero carve-out — is
  owned by **specs 146 and 147**.
