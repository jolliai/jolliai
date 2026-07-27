# 235. VS Code Shared Branch Import

## Topic Statement

Opening a Jolli share deep link in the editor: verify the link's origin against the Jolli allowlist (fail-closed), download the shared branch's structured memory over an API-key-authenticated export call that self-routes to the share's tenant, and materialize it locally in one of three modes — really ingesting it into the currently-open repo so recall/search find it, filling plan/note gaps into a foreign repo's Memory Bank for display, or dropping it into an isolated sandbox — with every untrusted slug/id/hash validated as a single safe filesystem segment before it touches a write path.

## Scope

**In scope:**

- The share deep-link entry point: required token and required, allowlist-checked origin; fail-closed on a missing or rejected origin; the sign-in gate.
- Downloading the shared branch export (auth, tenant self-routing, cross-deployment miss).
- The export payload shape and its per-commit structured summary + attachment bodies.
- The three materialization modes, how the recipient's position relative to the share's repo selects one, and what each writes and renders.
- The path-injection trust boundary: validating every untrusted segment before any write.
- Repo-identity gating (currently-open vs. foreign) and the local-authoritative-first precedence for the displayed head summary.
- The degradation to display-only when the currently-open repo has no folder layer.

**Out of scope (boundaries):**

- Server-side sanitization of the export payload (assumed hostile; re-validated here).
- The exact repo-identity match algorithm — it lives in shared CLI core and is referenced, not re-authored.
- The Summary panel that renders the result (writable vs. read-only foreign view) — see **VS Code Summary Webview Panel** (109).
- The sharer-side creation of the share and the export endpoint's server implementation.
- Other deep-link paths handled by the same URI handler (only the share path is in scope).
- Storage primitives (orphan branch / Memory Bank folder read-write) — owned by the storage specs.

## Data Contracts

### Share deep link

A URI with:

| Param | Required | Rule |
| --- | --- | --- |
| `token` | yes | Opaque share code. Missing → an info message, no load. |
| `origin` | yes | Web origin the link came from. Missing → **refused** (fail-closed) with an error message. Present but not on the Jolli origin allowlist → refused with an error message. |

Origin is required and allowlist-checked even though the export request itself goes to the user's own tenant — skipping the check on a missing param would let a crafted `?token=…` link through. A valid web share page always includes the origin.

Loading also requires a configured API key; without one the user is told to sign in.

### Export payload

Downloaded via an API-key-authenticated `GET /api/share/branch/<token>/export`. The request targets the **caller's own tenant** (from the API key's embedded URL); the token self-routes to the share's tenant within the same deployment. A token for a **different deployment** (a Jolli instance the user isn't signed into) resolves to a not-found and surfaces as a normal error.

| Field | Type | Meaning |
| --- | --- | --- |
| `branch` | string | The shared branch name. |
| `repoName` | string | The share's repo name. |
| `repoUrl` | string \| null | Remote URL; **null on a public-tier share** (withheld from non-member callers). |
| `kind` | `branch` \| `commit` | Whole-branch or single-commit share. |
| `headCommitHash` | string | The head commit to render. |
| `commits` | array | Per-commit entries (below). |

Each commit entry: `{ commitHash, summaryJson (string|null), attachments: [{ title, body }] }`. The response is accepted only when `commits` is an array **and** `repoName` / `branch` / `headCommitHash` are all strings — a truncated 2xx body missing them is rejected with a clean error rather than throwing later.

### Return of a materialization

- The storage the panel reads fold bodies from.
- The head summary to render.
- How many commits carried a usable structured summary.
- Whether it was **ingested into the currently-open repo** (true → render a normal writable local panel; false → render a read-only foreign/sandbox view).
- Nothing (null) when no commit carried a usable structured summary — surfaced to the user as "the shared branch has no structured memory to display".

## Behavior

### Entry (deep link)

1. Require `token`; missing → info message, stop.
2. Require `origin`; missing → refuse (error), stop. Present but off-allowlist → refuse (error), stop.
3. Require an API key; missing → prompt sign-in, stop.
4. Download the export (self-routing to the share's tenant). On failure, show the error.
5. Materialize it. If nothing usable was found, inform the user and stop.
6. Open the head summary in the Summary panel — a **writable local** panel when it was ingested into the currently-open repo, otherwise a **read-only** view carrying the share's repo name + URL so the panel knows it is foreign.

### Parse a commit's structured summary (per commit)

Each commit's summary JSON is parsed and accepted only when: its envelope `commitHash` is a **safe segment** (below); the body is present, parses, and is a non-array object; and the body's own `commitHash` **equals** the envelope hash the backend routed by. Any failure logs and drops that commit. This is required because the hash keys the local index, the panel's map, and (in the sandbox) the summary file name, so an absent/hostile hash would index under `undefined` or traverse the write path, and a mismatch is rejected outright.

### Choosing a materialization mode

The recipient's position relative to the share's repo selects the mode:

1. **Foreign local repo, already discovered (not the open one)** — a discovered Memory Bank for a *different* repo exists. recall/search are scoped to the active repo, so ingesting here would buy nothing; treat as **display-only**: fill plan/note fold-body gaps into that bank's folder and render read-only foreign.
2. **Currently-open, identity-matching repo** — the foreign lookup deliberately excludes the open repo, so a share of the open repo falls here; it proceeds only when the share's identity matches the open repo's. **Really ingest** each commit the recipient lacks (see below), then render a normal writable local panel.
3. **No local repo (pure external recipient)** — a dedicated **sandbox** directory under the extension's global storage, **outside** the Memory-Bank discovery namespace (so it never masquerades as a real repo and stays invisible to recall/search). Write plan/note bodies **and** the raw summary JSON, overwriting freely, so the directory is a self-contained, re-openable copy. Render read-only.

Repo-identity gating (open vs. foreign) uses the shared repo-identity match (repo name + remote URL) from CLI core.

### Mode: ingest into the currently-open repo

- For each parsed commit, store the summary **without forcing overwrite** — the commit-hash duplicate guard keeps the recipient's own copy (under whatever branch) instead of clobbering it with the lossy export. Storing writes the summary + index + catalog on the orphan branch (system of record) + folder, which is what makes `recall <branch>` / `search` surface the shared content.
- A missing root diff-stat is zero-filled before storing so the ingest skips a `git diff` on a commit the recipient's checkout may not even have; a per-node tree-hash lookup degrades gracefully (a commit absent from the object store is simply indexed without a tree hash).
- Fill plan/note fold bodies into the repo's folder **gap-only** (never overwrite the recipient's existing files).
- Render the local-authoritative head summary (below).

**Documented degradation:** obtaining the current repo's writable folder requires the folder storage layer. Under an orphan-branch-only storage mode there is no folder, so an orphan-only user opening a share of their **own** repo silently falls through to the sandbox mode and the share is never indexed for recall/search. This is a known capability gap (fold bodies need the folder), not a repo-identity decision.

### Modes: display-only (foreign bank or sandbox)

- No ingest. Write plan/note fold bodies into the target storage; for the sandbox only, also write the raw summary JSON so the directory is self-contained.
- **Foreign bank fills gaps only** — a local authoritative file always wins; the sandbox overwrites freely so a re-visit stays fresh.
- Render the local-authoritative head summary (below).

### Reconstructing attachment bodies

The export ships attachment bodies keyed by **title** (the doc's first heading); the structured summary carries plan slugs / note ids. Match a body to its plan/note by title, and write it as `plans/<slug>.md` / `notes/<id>.md` in the doc's original shape (a heading + body). Because a commit can carry two docs sharing a title, bodies for one title are consumed as an **in-order queue** (so a second same-titled doc doesn't steal the first's body). A snippet note carries its body inline and needs no file. Files land in a path-keyed map with the head commit processed **last**, so the head's body wins any slug shared across commits.

### Head-summary precedence (local-authoritative-first)

The head summary to render is, in order: the target bank's **own** stored copy of the head commit (a superset of the lossy export), else the just-parsed export head, else the first parsed commit. A pre-existing local summary **always** beats the export copy.

### Path-injection trust boundary

The backend that produces `slug` / `note id` / `commitHash` lives in a separate repo, so **plugin-side validation is the trust boundary**. Before any value from the export reaches a write path it must be a **single safe filesystem segment**: a non-empty `[A-Za-z0-9._-]` string that is neither `.` nor `..` (both would otherwise pass the character class). A value failing this is skipped (logged). `plans` / `notes` that aren't arrays are coerced to empty. The fallback sandbox directory's name is derived by sanitizing the repo name (collapsing unsafe runs, stripping leading/trailing dots) so a name of `.` / `..` can't survive as a directory segment.

**Crucially, the Memory Bank folder's symlink/containment guard does not backstop this:** its containment check is anchored at the Memory-Bank root (the parent of the per-repo folder), so a `..` that stays inside the bank but escapes the current repo's subtree sails through and could clobber a *sibling* repo's bank. Validating each segment here is what keeps a hostile value out. The check also covers the visible generated Markdown layer, whose slug is re-derived from the write path.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Idle | Share deep link, missing token | Info message; no load |
| Idle | Share deep link, missing/rejected origin | Refused (fail-closed) |
| Idle | Share deep link, no API key | Prompt sign-in |
| Idle | Valid link + key | Download export |
| Download | Failure / cross-deployment miss | Error toast |
| Download | Success, no usable summary | "No structured memory to display" |
| Download | Success, open repo identity-matches | Ingest → writable local panel |
| Download | Success, foreign bank discovered | Fill gaps → read-only foreign panel |
| Download | Success, no local repo | Sandbox → read-only panel |
| Download | Success, own repo but orphan-only storage | Falls through to sandbox (degradation) |

## Notable Behavior

- **Origin is mandatory and fail-closed.** A link with no origin, or an off-allowlist origin, is refused before any network call — even though the export goes to the user's own tenant. (Surprising; intentional.)
- **The export self-routes by token.** The request always hits the caller's own tenant; the token finds the share's tenant within the same deployment. A cross-deployment token is a clean not-found, not a crash. (Notable.)
- **Public-tier shares withhold the remote URL.** `repoUrl` is null for a non-member caller, which the mode selection and display tolerate. (Notable.)
- **Ingest never clobbers the recipient's own memory.** Storing is non-forcing; the commit-hash duplicate guard preserves any copy the recipient already has under any branch. The export is treated as lossy. (Notable.)
- **A pre-existing local head summary always wins the display.** The bank's own copy is a superset of the export's, so it is preferred for rendering in every mode. (Notable.)
- **Plugin-side segment validation is the real trust boundary — the folder symlink guard is not.** A `..` that stays inside the Memory Bank but escapes the current repo's subtree defeats the containment guard; per-segment validation is what stops it clobbering a sibling repo. (Surprising; intentional.)
- **The inner commit hash must equal the routed envelope hash.** A summary whose own `commitHash` disagrees with the commit it was delivered under is rejected — it would otherwise index/render under the wrong key. (Notable.)
- **Attachment bodies are matched by title with an in-order queue.** Two docs sharing a title on one commit don't cross-assign bodies. (Notable.)
- **Orphan-only storage silently downgrades a self-share to sandbox.** Opening a share of your own repo without the folder layer lands in the read-only sandbox and is never indexed for recall/search — a known gap. (Surprising; reality.)

## Shared Behavior

- **Jolli origin allowlist** — the same HTTPS-only, suffix-boundary allowlist enforced across the product; here it vets the deep link's origin.
- **Repo-identity match** — the shared CLI-core algorithm (repo name + remote URL) that also decides current-vs-foreign elsewhere; referenced, not re-authored.
- **Live-share export wire call** — the same HTTP client family as the share create/update calls in **VS Code Live Branch Share** (234).
- **Summary panel rendering** — the writable-local vs. read-only-foreign view is **VS Code Summary Webview Panel** (109); read-only foreign mode is signalled by passing the share's repo name + URL.
- **Memory Bank folder layers** and the orphan-branch system of record — owned by the storage specs; this importer writes through their storage interface.
