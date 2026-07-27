# 95. Binding Required Flow

## Topic Statement

Surface a "binding required" failure from the Jolli backend by opening a per-repository chooser that lists the existing memory spaces under the user's organization, registers the picked space as the binding for this repository, then retries the original push exactly once — and abort cleanly if the user dismisses the chooser.

## Scope

**In scope:**

- The HTTP failure shape that triggers the chooser (`412 binding_required` from the push call).
- The two backend calls the chooser uses: list-spaces and register-binding.
- The chooser's lifecycle, including the "one chooser per repo URL" guarantee.
- The race-resolution path when two clients try to bind the same repository at the same time (`409 binding_already_exists`).
- The transition back to the original push after a successful binding.
- The cancel and "another chooser already open" outcomes that abort or defer the retry.

**Out of scope (boundaries):**

- The push itself — endpoint, headers, body, success response — is defined by **Summary Push to Jolli Space**.
- The **proactive** front-door binding-discovery variant. This spec is the *reactive* flow: a binding chooser opened only **after** a push has already failed with `412 binding_required`. A separate, third variant of Space-binding UX runs *before* any push — a step of the bare-`jolli` guided front door that resolves binding state up front via `POST /api/jolli-memory/front-door` and prompts to bind proactively. That is covered by **Guided Front-Door Space-Binding Step**; do not conflate the two. (The front-door endpoint even *auto-binds* server-side when exactly one Space is bindable, so it often never surfaces a prompt at all — the opposite of this spec's after-the-failure trigger.)
- The `426` plugin-outdated mapping (covered by **Plugin Outdated Flow**).
- How the bearer credential is built and how the tenant slug is derived (covered by **Tenant Resolution Modes**).
- The web-frontend space-management UI (creating, renaming, moving, deleting spaces); the IDE chooser deliberately does not expose those affordances.
- The on-disk shape of the binding info; the chooser's binding info is transient and never persisted by the client.

## Data Contracts

### Trigger: the `412` response

The push call returns this shape on `HTTP 412`:

| Field     | Type   | Meaning                                                                                          |
| --------- | ------ | ------------------------------------------------------------------------------------------------ |
| `error`   | string | Always `"binding_required"`.                                                                     |
| `message` | string | Optional human-readable reason; surfaced verbatim on the chooser's banner when present.          |
| `repoUrl` | string | Canonical repo URL the server is asking the client to bind. Echoed from the request when the client sent one; otherwise filled in by the server. |

The client surfaces this as a typed "binding-required" rejection that carries `repoUrl` and `message`. `repoUrl` falls back to the request's own `repoUrl` if the server did not echo one.

### List-spaces endpoint

| Property | Value                                  |
| -------- | -------------------------------------- |
| Method   | `GET`                                  |
| Path     | `/api/jolli-memory/spaces`             |
| Headers  | Authorization, `x-jolli-client`, plus `x-tenant-slug` / `x-org-slug` under the same conditions as the push. |
| Body     | None.                                  |

The response body is one of two shapes (the chooser handles both):

1. **Envelope:** `{ spaces: JmSpaceSummary[], defaultSpaceId?: number | null }`.
2. **Flat array:** `JmSpaceSummary[]` (legacy / pre-default envelopes; equivalent to `defaultSpaceId === null`).

Each `JmSpaceSummary` carries `id` (number), `name` (string), and `slug` (string).

When the envelope is present but `defaultSpaceId` is missing or not a number, the chooser treats it as `null` and **leaves every radio unchecked**. There is no `spaces[0]` fallback — the user is forced to make an explicit pick.

### Register-binding endpoint

| Property | Value                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| Method   | `POST`                                                                                                          |
| Path     | `/api/jolli-memory/bindings`                                                                                    |
| Headers  | Authorization, `Content-Type: application/json`, `Content-Length`, `x-jolli-client`, plus `x-tenant-slug` / `x-org-slug` under the same conditions as the push. |
| Body     | `{ repoUrl: string, repoName: string, jmSpaceId: number }`.                                                     |

| Response                                | Meaning                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `HTTP 2xx`                              | The binding was created. **The real server body is `{ binding: { id, jmSpaceId, repoName }, repoFolder }`** — the binding fields are nested under `binding`, and there is **no** top-level space-**name**. (See the data-contract caveat below.) |
| `HTTP 409` with `error: "binding_already_exists"` | Another client (or another panel of this client) bound the same repo first. The body carries the existing winner's binding — including the space id it is already bound to, which callers requesting a specific space use to detect a wrong-space mismatch. |
| `HTTP 426`                              | Client/plugin outdated — surfaced through the same outdated-client path as the push call (see **Plugin Outdated Flow**). |
| Any other non-2xx                       | Surfaced verbatim with `error`/`message` or `HTTP <status>`.                                                     |

> **Data-contract caveat (two observed shapes).** The editor extension's binding-info type models the create-binding response as **flat** fields including a `jmSpaceName`. The CLI/tool client instead parses the **actual** server shape — binding fields **nested under `binding`**, with **no** space-name (`{ binding: { id, jmSpaceId, repoName }, repoFolder }`) — for both the `2xx` and the `409` bodies (it reads the already-bound space id from `binding.jmSpaceId`). The nested-under-`binding`, no-space-name shape is the one grounded in a real server response; the flat editor type may be inaccurate. The client therefore reports the bound space by **id**, not name.

### Chooser instance

| Property         | Value                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Identity         | One open chooser per `repoUrl`. Multiple repos in one workspace can each have their own chooser open simultaneously. |
| Title            | `Choose a Memory space`.                                                                                            |
| Inputs           | `extensionUri`, saved `baseUrl`, saved `apiKey`, the repo's canonical URL, a suggested repo name (used to pre-fill on the form). |
| Returns          | A discriminated outcome (see below).                                                                                |

### Chooser outcomes

| Outcome        | Meaning                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `selected`     | The user picked a space and the server accepted (or the chooser resolved a `409` race). Carries `{ id, jmSpaceId, jmSpaceName, repoName }`. |
| `cancelled`    | The user dismissed the chooser without picking. The push is **not** retried.                                                       |
| `anotherOpen`  | A chooser for the same `repoUrl` is already open (e.g. two summary panels for the same repo both hit `412`). The existing chooser is revealed in front of the user; the second caller is told to wait. The push is **not** retried — the user finishes the existing chooser first and re-triggers the push. |

The distinction between `cancelled` and `anotherOpen` exists so the caller can pick the right user message. A true cancel reads as "Push cancelled"; a concurrent chooser for the same repo reads as "the chooser is already open elsewhere — finish there, then click the Jolli push button again". Without this distinction the second concurrent push from the same repo gets a misleading "Push cancelled" even though the user never cancelled anything.

## Behavior

### When the push fails with `412`

1. The push leaf-RPC rejects with the typed binding-required error carrying `repoUrl` and `message`.
2. The caller invokes the chooser's "open and await" entry point with `(extensionUri, baseUrl, apiKey, repoUrl, suggestedRepoName)`.

### Chooser open

1. If a chooser already exists for the same `repoUrl`, reveal it (bring its panel to the front in the active editor column) and resolve immediately with `anotherOpen`. Do not open a second panel.
2. Otherwise, create a new webview panel titled `Choose a Memory space`, register it under `repoUrl`, render the chooser HTML, and wait for the panel to either send a result message or be disposed.

### Initial space load

1. When the webview signals it is `ready`, call the list-spaces endpoint.
2. On success, post `init` to the webview with `{ repoUrl, suggestedRepoName, spaces, defaultSpaceId }`.
3. On failure, post `init` with an empty list (`spaces: [], defaultSpaceId: null`) so the UI can explain the web-first space-creation flow instead of leaving a blank chooser, and additionally post an `error` message carrying the failure text. The chooser stays open; it does not auto-close on a list-spaces failure.

### User confirms a pick

1. The webview sends `{ command: "confirm", jmSpaceId }`.
2. The chooser calls the register-binding endpoint with `{ repoUrl, repoName: suggestedRepoName, jmSpaceId }`.
3. On `2xx`, settle the chooser with `selected` carrying the returned `BindingInfo`, then dispose the panel.
4. On `409 binding_already_exists`, post `winnerOnRace` to the webview with the body's binding info; the UI shows a banner inviting the user to accept the winner, and clicking that banner sends `{ command: "acceptWinner", winner }`. The chooser then settles with `selected` carrying the winner — or, if any of `id`, `jmSpaceId`, `jmSpaceName`, or `repoName` is missing or wrong-type on the winner body, posts an `error` message inviting the user to retry the push instead of settling.
5. On any other failure, post an `error` message to the webview and leave the panel open so the user can retry or cancel.

### User cancels

1. The webview sends `{ command: "cancel" }` (or the user closes the panel — `onDidDispose` fires the same path).
2. Settle the chooser with `cancelled`.
3. Dispose the panel (idempotent; double-settle is guarded).
4. The caller does **not** retry the push.

### Successful binding → retry the push

1. The caller, on receiving `selected`, re-invokes the original push exactly **once** with the same payload.
2. The retried push is a fresh single-attempt RPC subject to the same status-code mapping. If it returns `412` again (e.g. the chosen space was deleted between bind and retry), the caller may surface a generic failure rather than re-opening the chooser; this is implementation-defined and not part of this spec's contract.

## State Transitions

States held by a chooser instance, keyed by `repoUrl`:

- **Idle.** No instance registered for this `repoUrl`.
- **Open.** A panel exists, the webview has been told to load, and a result has not yet been settled.
- **Settled.** A discriminated outcome has been emitted exactly once. The instance entry is removed from the per-`repoUrl` registry.

Allowed transitions:

- Idle → Open: caller invoked "open and await" and no instance was already registered.
- Idle → (returns immediately with `anotherOpen`): caller invoked "open and await" and an instance was already registered.
- Open → Settled (`selected`): a confirm path completed (`2xx` from register-binding) **or** the user accepted a `409` winner.
- Open → Settled (`cancelled`): the user pressed cancel **or** disposed the panel.
- Open → (still Open): a list-spaces or register-binding failure that the chooser handles by posting an error to the webview without settling.

`settle` is single-shot: the second call is a no-op so a panel that auto-disposes after `selected` does not also fire `cancelled` from `onDidDispose`.

## Notable Behavior

- **Push has no automatic retry on `412`. The chooser is the retry.** The leaf push fails fast; the caller is responsible for running the chooser and then re-pushing. This separation keeps the push RPC pure.
- **`409 binding_already_exists` is not a hard failure — it is a race-resolution.** The body carries the winning binding so the chooser can ask the user to accept it instead of forcing a re-pick. Without this graceful path, two parallel pushes from the same repo would surface a confusing "already bound" error to whichever client lost the race.
- **`anotherOpen` exists specifically because a true cancel and a concurrent chooser look identical from the second caller's point of view.** Without distinguishing them, the second push gets a misleading "Push cancelled" even though the user never cancelled anything. (Surprising; intentional.)
- **`defaultSpaceId` falsy means leave every radio unchecked.** There is no implicit `spaces[0]` fallback. The list endpoint does not guarantee order, so picking the first space silently could bind the wrong space. Forcing an explicit pick is safer. (Surprising; intentional.)
- **The chooser deliberately does not let the user create / rename / move / delete a space.** All such governance flows live on the web frontend. The IDE only binds the current repo to an existing space. (Notable.)
- **Multiple repos can each have their own chooser open simultaneously.** The "one chooser per `repoUrl`" rule is per-URL, not global. A multi-root workspace can have a chooser open for each repo at once. (Notable.)
- **The chooser persists transient `BindingInfo` only.** Nothing is written to disk by the chooser path; the binding's authoritative state lives on the server, and the client treats every push as the source of truth for "is this still bound?"
- **`onDidDispose` settles as `cancelled` if no other outcome has been emitted yet.** Pressing cancel and closing the panel converge on the same state via the single-shot settle. (Notable.)
- **The list-spaces endpoint accepts both an envelope and a flat-array body.** This tolerates pre-default backends without breaking the chooser; older servers report `defaultSpaceId === null` automatically. (Notable.)
- **`acceptWinner` validates the winner body field-by-field.** If any of `id`, `jmSpaceId`, `jmSpaceName`, or `repoName` is missing or wrong-type, the chooser surfaces an actionable error and does **not** settle, so the user is not stranded with a half-formed binding. (Notable; defensive.)

## CLI / MCP Non-Interactive Analogue

The command-line and tool surfaces implement the **same server contract** as the editor chooser, but with a non-interactive shape (no webview, no radio list):

- **No chooser — a returned outcome instead.** On a binding-required response from any push in the batch, the CLI/tool path does **not** open a picker. It best-effort enriches the failure with the available spaces (and the tenant default) and returns a `binding_required` **result**. The caller must **re-invoke** with a space selected (or bind first). There is **no auto-retry** — exactly like the editor path fails the push fast, but here the "retry" is a second command/tool invocation by the user, not a chooser.
- **Best-effort space enrichment.** If listing spaces fails while enriching the binding-required result, the result still comes back as `binding_required` (with an empty space list) — the affordance to re-run with a space is never downgraded to a generic error.
- **Proactive pre-bind with fail-closed race handling.** When a space is supplied up front, the repo is bound before any push. If the binding already exists (a lost race), the path is **fail-closed**: it proceeds only when the existing binding's space id is *confirmed equal* to the requested one, and errors out when it cannot confirm (including the race where the server withholds the existing space id). This is the non-interactive analogue of the chooser's `409` race-resolution — but instead of asking the user to accept the winner, it refuses to push to a space it can't confirm. (Detailed in **CLI Space Push / Spaces / Bind Commands**.)
- **Bind treats already-exists as success.** An explicit bind against an already-bound repo is reported as a non-error "already bound" outcome, not surfaced as a failure — the same spirit as the chooser resolving a `409` gracefully.
- **Auth-failure mapping is uneven across the client's four calls.** The command/tool client maps `HTTP 401`/`403` to a *typed* not-authenticated error on its **push** call and its **delete** call (and on the proactive front-door call — see **Guided Front-Door Space-Binding Step**). Its **list-spaces** and **register-binding** calls do **not** special-case `401`/`403`: those statuses fall through to the generic "any other non-2xx" path and surface as `HTTP 401` / `HTTP 403` (or the body's `error`/`message`). So an expired credential reads as a clean "not authenticated" when caught on push/delete, but as a raw HTTP-status error when caught while listing spaces or registering a binding. (Notable; asymmetric.)

## Shared Behavior

- The leaf push RPC's request, response, and `412` mapping are defined by **Summary Push to Jolli Space**.
- The non-interactive command/tool surface, its `binding_required` / `error` result union, the shared space-resolution rule, and the fail-closed pre-bind are defined by **CLI Space Push / Spaces / Bind Commands**.
- The proactive, before-any-push binding-discovery variant (the bare-`jolli` guided front-door step, its single `POST /api/jolli-memory/front-door` round-trip, and its server-side auto-bind of a sole Space) is defined by **Guided Front-Door Space-Binding Step**.
- The `426` plugin-outdated mapping is defined by **Plugin Outdated Flow**.
- The `(origin, tenantSlug)` derivation that the chooser endpoints use to compose URLs and headers is defined by **Tenant Resolution Modes**.
- The product API key shape that supplies the bearer and any embedded `o` org slug is defined by **Jolli API Key Format and Parsing**.
- The HTTPS allowlist that the resolved origin must satisfy is defined by **Jolli Origin Allowlist Enforcement**.
