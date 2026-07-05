# push-to-jolli + memory-space selection from CLI/MCP — Design

**Date:** 2026-07-03
**Branch:** `jolli-pr-skill-improvement`
**Builds on:** [`2026-07-03-jolli-pr-wait-for-pending-memory-design.md`](2026-07-03-jolli-pr-wait-for-pending-memory-design.md) (Q1), [`2026-06-19-mcp-pr-description-design.md`](2026-06-19-mcp-pr-description-design.md)

## Problem

Pushing JolliMemory to the Jolli cloud, and choosing which **memory space** a
repo's docs land in, is implemented **only in the VS Code extension** today
(`JolliPushService` / `JolliMemoryApiService` / `BindingChooserWebviewPanel`,
triggered by the "Share in Jolli" button). There is **no CLI command and no MCP
tool** for push or space selection, so an agent (Claude Code, etc.) cannot push
a branch's memory or pick a space. When a user asks Claude to "create a PR and
push the memory to Jolli," the space-selection step is unreachable.

## Goal

Expose push + space selection through the CLI and MCP so an agent can drive
them, and wire an optional push step into the `jolli-pr` skill. After creating a
PR, the skill offers to push the branch's memory; if the repo is not yet bound
to a space, the agent lists spaces, the user picks one (or names it), the agent
binds it, and the push proceeds. The binding is remembered server-side per repo,
so subsequent pushes don't re-ask.

## Relation to the VS Code "Create PR → push to Space" feature (post-rebase)

A rebase landed an adjacent VS Code feature (design:
[`2026-07-04-create-pr-push-memories-to-space-design.md`](2026-07-04-create-pr-push-memories-to-space-design.md)):
clicking **Create/Update PR** in the `CreatePrWebviewPanel` now pushes the
branch's memories to the bound Space via a new `LiveShareController.pushBranchMemoriesToSpace(deps, branch)`
+ `assignOwnedAttachments` (cross-commit plan/note dedup) + `BindingResolver.resolveBindingViaChooser`.
It is **VS Code only** — explicitly out of scope: CLI, MCP, IntelliJ. So this
spec (agent/CLI-driven push + space selection) is still needed and is the
parallel surface on the same unchanged wire.

Two consequences for this design:

1. **Better port source.** The CLI `pushBranchToJolli` should mirror
   `pushBranchMemoriesToSpace` (branch `base..HEAD` loop, non-strict attachments,
   fatal-on-binding) and **port `assignOwnedAttachments`** for cross-commit
   plan/note dedup (latest revision wins; carry forward a known
   `jolliPlanDocId`/`jolliNoteDocId` as a seed) — more correct than a naive
   per-summary loop. `pushSummaryWithAttachments` still uses `latestPlanPerName`
   internally for the single-summary (no-`attachments`) path, so that helper is
   still a port dependency.
2. **Resolution order.** Mirror `LiveShareController`, not the panel: `apiKey`
   from config → `baseUrl` via `parseJolliApiKey(apiKey).u` (trailing-slash
   stripped); `repoUrl` resolved **inside** the orchestrator via
   `getCanonicalRepoUrl(cwd)`, not in the command/MCP layer.

The wire contract, endpoints, and error codes below are **unchanged** by the
rebase (verified against current source).

## Wire contract (ground truth — verified against live backend source)

The JM-push binding axis (`repoUrl → jmSpaceId`) is a **separate, current**
contract, orthogonal to the Space content-storage "git-backed paradigm shift"
(which concerns a Space's own DB/git backing, not push routing). Three live
endpoints, authenticated by the saved `jolliApiKey`:

- `GET /api/jolli-memory/spaces` → `{ defaultSpaceId: number | null, spaces: Space[] }`. The
  client reads the `{ id, name, slug }` subset per space. Requires the key's
  `JOLLI_MEMORY_PUSH` scope; server filters to spaces the key's creator can edit.
- `POST /api/jolli-memory/bindings` body `{ repoUrl, repoName, jmSpaceId }` → `201 { binding, repoFolder }`.
  Errors: `400` invalid_repo_url / invalid_repo_name; `404 space_not_found`;
  `400 space_not_jolli_memory`; `409 binding_already_exists`;
  `409 jolli_memory_folder_collision`; `426 client_outdated`. **Note:** the server
  response has no `jmSpaceName` field (the vscode `BindingInfo` type is wrong);
  parse the real `{ binding: { id, orgId, repoUrl, repoName, jmSpaceId, ... }, repoFolder: { id, jrn } }`.
- `POST /api/push/jollimemory` body
  `{ title, content, commitHash, docType: "summary"|"plan"|"note", branch?, docId?, repoUrl?, relativePath?, summaryJson? }`
  → `201`/`200 { url, docId, jrn, created, summaryJsonDocId? }`. **A well-formed
  `x-jolli-client: <kind>/<version>` header is mandatory** — a `repoUrl` push with
  a missing/malformed header hard-fails `400 client_header_required`. Errors:
  `412 binding_required { repoUrl }`; `426 client_outdated`; `400 invalid_repo_url`;
  `403` doc owned by different user; `409` folder collision.

### Idempotency: server natural-key upsert + client docId write-back

Two mechanisms work together. First, the server dedupes by natural key:

- Visible leaf (summary markdown / plan / note): `(spaceId, parentId, slug(title))`,
  where `parentId` = binding → branch → subfolder chain. **`commitHash` and
  `docType` are NOT part of the leaf key.** Same `(branch folder, title-slug)` →
  same doc, updated in place; `docId` is an optional optimization.
- Hidden `summaryJson` sidecar: keyed by `(spaceId, .jolli/summaries folder, commitHash)`.

Second, the CLI **writes the returned `docId` / doc URL back into the stored
summary** (see "Write-back" below), so re-pushes pass `docId` explicitly (belt-
and-suspenders over the natural key) and the pushed state + doc URL are readable
by the PR flow, recall, and the VS Code UI.

**Consequence — the title-stability constraint (load-bearing):** because the
leaf key is title-slug only (no commit hash, no docType) and `relativePath` is a
flat per-branch slug, all of a branch's summaries share one `parentId`.
Uniqueness therefore rests entirely on the push `title`. The CLI MUST derive
`title` / `relativePath` / `repoUrl` **using the same logic as the VS Code
client** (`getCanonicalRepoUrl` / `normalizeRemoteUrl` / `buildBranchRelativePath`
and the per-doc title builders in `JolliPushOrchestrator`), so that (a) re-push
of the same commit updates in place, and (b) a CLI push and a vscode push of the
same commit converge on the same doc.

**Known limitation (shared with the shipped VS Code surface):** because
`buildPushTitle` is the sanitized commit message and the leaf key excludes
`commitHash`, two different commits with an *identical* commit message on the
same branch (`"wip"`, `"fix tests"`, …) collapse into one Space doc. This is a
faithful port of current vscode behavior, so CLI↔vscode still converge; fixing
it CLI-side alone would break the parity constraint. The real fix is a shared
title/server-key change (include `commitHash` or `docType` in the leaf key) —
tracked as a follow-up, out of scope here.

## Decisions (confirmed with Flyer)

1. **Push is a standalone `jolli push` command**, and `jolli-pr` offers to push
   **after** creating the PR (asks first — not automatic).
2. **`jolli push` scope** = current branch `base..HEAD`, all commit summaries +
   each summary's plans/notes; `--base` overrides the base. (Same range as
   `get_pr_description`.)
3. **Three independent MCP tools** (`push_memory`, `list_spaces`, `bind_space`),
   matching the existing per-tool style, not one action-dispatched tool.
4. **Push always sends `repoUrl`** (per-repo binding semantics). An unbound repo
   goes through the space-selection flow; it does **not** silently fall back to
   the org default JM space.
5. **Write back** the pushed doc identity after each push: `jolliDocId` /
   `jolliDocUrl` on the summary, and `jolliPlanDocId`/`jolliPlanDocUrl` /
   `jolliNoteDocId`/`jolliNoteDocUrl` on each pushed plan/note (all fields
   already exist on the types). Pass `docId` on re-push; run the
   `orphanedDocIds` delete-cleanup. This marks pushed state and lets the PR
   flow, recall, and the VS Code UI read the doc URL. Because the summary is
   stored on the shared orphan branch, VS Code renders its clickable "Synced to
   Jolli" link from the same field with **zero VS Code changes**.
6. **PR body is not modified** — `get_pr_description` / the PR markdown builders
   stay as-is. The write-back only *stores* `jolliDocUrl`; it is not injected
   into the PR description in this feature.

## Components (three units within one spec)

### Unit A — `JolliMemoryPushClient` (core HTTP client)

New `cli/src/core/JolliMemoryPushClient.ts`. Reuses the auth/header/base-URL
pattern of [`cli/src/sync/BackendClient.ts`](cli/src/sync/BackendClient.ts)
(`jolliApiKey` via config, `parseJolliApiKey`, `baseUrl ?? keyMeta.u`,
`Authorization: Bearer`, `x-jolli-client` from
[`cli/src/core/ClientHeader.ts`](cli/src/core/ClientHeader.ts), `x-tenant-slug`,
`x-org-slug`, trace header; injectable `fetch` for tests). Methods:

- `listSpaces(): Promise<{ spaces: {id,name,slug}[]; defaultSpaceId: number|null }>`
- `createBinding(args: { repoUrl; repoName; jmSpaceId }): Promise<{ bindingId: number; jmSpaceId: number; repoName: string }>` — parsed from the real `{ binding, repoFolder }` shape.
- `push(payload): Promise<PushResult>` — throws typed errors: `BindingRequiredError(repoUrl)`, `BindingAlreadyExistsError`, `ClientOutdatedError`, `NotAuthenticatedError`, generic.

Repo-identity helpers (`repoUrl` / `repoName` / `relativePath` / per-doc title)
live in a small shared module the CLI push path and any future caller reuse; they
mirror the vscode derivations exactly (see the title-stability constraint).

**Push orchestration + write-back** (new `cli/src/core/JolliMemoryPushOrchestrator.ts`,
ported from vscode `JolliPushOrchestrator.pushSummaryWithAttachments`): for one
summary, push plans → notes → summary(+`summaryJson`) in order (best-effort per
attachment, fatal on `binding_required`/`client_outdated`), then build
`updatedSummary = { ...summary, jolliDocId: result.docId, jolliDocUrl: `${base}/articles?doc=${result.docId}`, plans: applyPlanUrls(...), notes: applyNoteUrls(...) }`
and persist it via `storeSummary(updatedSummary, cwd, /*force*/ true, undefined, storage)`
(the existing update API — acquires the orphan-write lock, dual-writes to the
folder). Then run the `orphanedDocIds` cleanup (`deleteFromJolli` each, drop the
deleted ids, second `storeSummary`). The doc URL is built client-side from
`docId` (not `result.url`), base = `jolliUrl`/`keyMeta.u` with trailing slash
stripped — identical to vscode so both clients converge. Re-push includes `docId`
(summary `jolliDocId`, plan `jolliPlanDocId`, note `jolliNoteDocId`) when present.
Reuse/port `applyPlanUrls` / `applyNoteUrls` / `buildPushTitle` from the vscode
orchestrator verbatim; the vscode copy stays (intentional duplication; a later
consolidation where vscode imports the bundled CLI orchestrator is out of scope).

### Unit B — CLI commands (`cli/src/commands/`)

- `jolli push [--base <branch>] [--space <id|slug>] [--format json]` — registers
  in `Api.ts` under `MEMORY_COMMAND_NAMES`. Builds the branch's push set (reuse
  `loadBranchSummaries` from `PrDescription.ts` / `SummaryStore`), pushes each
  summary's plans → notes → summary(+summaryJson) in order, best-effort per
  attachment (collect failures), fatal on `binding_required` / `client_outdated`.
  On `binding_required` with no `--space`: return
  `{ type: "binding_required", repoUrl, spaces, defaultSpaceId }` (spaces embedded
  — one round-trip). With `--space`: create the binding first, then push.
- `jolli spaces [--format json]` — lists bindable spaces.
- `jolli bind --space <id|slug> [--repo-name <name>]` — binds current repo;
  handles `binding_already_exists`. A `--space` slug is resolved to an id via
  `listSpaces` when not numeric.

All follow the `PrDescriptionCommand` conventions: `--format json` prints the
full result / `{type:"error"|"binding_required", …}`, non-json prints a short
human summary, `process.exitCode = 1` on error.

### Unit C — MCP tools + jolli-pr skill Step 5

- `push_memory { baseBranch?, space? }`, `list_spaces {}`, `bind_space { space }`
  in `McpServer.ts` + handlers in `McpTools.ts`, delegating to the same
  `JolliMemoryPushClient` (CLI↔MCP parity). `push_memory` returns the same
  `binding_required` + embedded spaces shape on 412.
- `jolli-pr` skill (`buildPrSkillTemplate` in `SkillInstaller.ts`) gains **Step 5:
  offer to push to Jolli** after Step 4 (report URL):
  1. Ask the user "Push this branch's memory to Jolli?" — only proceed on yes.
  2. Call `push_memory` (MCP) / `jolli push` (CLI).
  3. On `binding_required`: present the embedded `spaces` via the agent's choice
     UI (or honor a space the user named in their prompt) → `bind_space` /
     `jolli bind` → retry `push_memory`.
  4. On not-signed-in / outdated: relay the guidance and stop.
  5. Report the published doc URL(s) (`<base>/articles?doc=<docId>`).

## Error handling

Structured results everywhere: `{ type: "binding_required", repoUrl, spaces, defaultSpaceId }`,
`{ type: "error", message }`. Not-signed-in (no `jolliApiKey`) → error with
"run `jolli auth login` / sign in via the extension." `426 client_outdated` →
"update the CLI/extension." Per-attachment (plan/note) failures are collected and
reported without aborting the summary push (mirrors vscode); `binding_required` /
`client_outdated` are fatal and propagate.

## Testing

- `JolliMemoryPushClient`: injected-fetch tests for each status branch — 2xx,
  `412 binding_required`, `409 binding_already_exists`, `426 client_outdated`,
  missing-key → NotAuthenticatedError; header construction (Authorization,
  x-jolli-client, tenant/org).
- Repo-identity/title helpers: parity tests asserting the same output as the
  vscode derivations for representative remotes/branches (SSH, https, no-remote,
  case-insensitive hosts).
- Write-back: after a mocked successful push, the stored summary has
  `jolliDocId`/`jolliDocUrl` set (URL built from `docId`, not `result.url`),
  pushed plans/notes carry their `jolliPlan*`/`jolliNote*` ids, `storeSummary`
  is called with `force = true`, re-push passes `docId`, and `orphanedDocIds`
  are deleted then dropped from the persisted summary.
- CLI commands: `push`/`spaces`/`bind` — JSON + human output, binding_required
  path, `--space` auto-bind, error/exit-code paths.
- MCP handlers: parity with CLI shapes; `bind_space` slug→id resolution.
- Skill: Step 5 present after Step 4; mentions `push_memory` / `jolli push` and
  the binding flow; template literal intact (backtick escaping).
- CLI coverage floor 97/96/97/97; `npm run all` once at the end; single signed
  commit; no Claude co-author trailer.

## Intentionally unchanged (scope boundary)

- **No backend changes** — the three endpoints already exist and are current.
- **VS Code push path is untouched** — `JolliPushService` etc. keep working as-is;
  a later consolidation (vscode calling the CLI core) is out of scope. VS Code's
  clickable "Synced to Jolli" link also needs **no change**: it reads `jolliDocUrl`
  off the shared orphan-branch summary, which the CLI write-back now populates.
- **PR body / `get_pr_description` unchanged** — the write-back stores the doc URL
  but does not inject it into the PR description (decision 6).
- **Config gains no `jmSpace` field** — the binding lives server-side keyed by
  `repoUrl`; nothing new persists locally.
- **No IntelliJ parity** for the new commands/tools (follow-up).
- **`get_pr_description` / queue-status (Q1) semantics unchanged** — Step 5 is
  additive after the existing Steps 1–4.
- **API-key parser stays in lockstep** — reuse the canonical `JolliApiUtils`
  helpers; do not fork a fourth copy.

## Out of scope

- Creating / renaming / deleting spaces (jolli.ai web frontend only — the plugin
  and CLI only *bind* an existing space).
- Incremental "push only unpushed" tracking.
- Pushing arbitrary non-summary docs.
