# 94. Summary Push to Jolli Space

## Topic Statement

Post a stored commit summary, plan reference, or note reference to the Jolli backend over HTTPS as a single-attempt JSON request that carries a bearer credential, a product-version client header used for server-side compatibility gating, and a typed document discriminator the server uses to route the document to the correct on-server location, surfaced in the UI as a button whose label switches from a first-share affordance to an update affordance once the document has been pushed before. The same client also carries a **second push endpoint, for session statistics**, which reuses this client's credential and header composition and none of its document contract — no title, content, commit hash, document type, repo URL, branch or document id, and no binding relationship at all — and which is neither single-attempt nor user-triggered.

## Scope

**In scope:**

- The endpoint, method, headers, and body of the push call.
- Resolving the target Jolli origin and (optionally) the tenant slug from the saved Jolli site URL or, as a fallback, from the URL embedded in the API key.
- The role of the document-type discriminator on the body and how it differs from the client-kind value sent on the header.
- The shape of the success response and what each field means to the client.
- The retry policy on the document push (none — single attempt), the different one the session endpoint carries, and the deletion path used to remove orphaned documents from the server.
- The general failure modes the caller surfaces to the user (network, malformed response, unmapped non-2xx).
- Parity facts across the three client implementations of this push (CLI, editor extension, JVM IDE plugin).

**Out of scope (boundaries):**

- The 412/binding-required and chooser flow that runs in front of this push (covered by **Binding Required Flow**).
- The 426/plugin-outdated mapping and user message (covered by **Plugin Outdated Flow**).
- How `(origin, tenantSlug)` are derived from the Jolli site URL or API key (covered by **Tenant Resolution Modes**).
- The on-disk storage and shape of the bearer credential and API key (covered by the auth / API-key specs).
- The orphan-branch reads that produce the summary content to push (covered by the storage specs).
- Any local-folder export of the same content; this spec is server-side push only.

## Data Contracts

### Endpoint

| Property | Value                                  |
| -------- | -------------------------------------- |
| Method   | `POST`                                 |
| Path     | `/api/push/jollimemory`                |
| Origin   | The resolved Jolli origin (HTTPS in production; HTTP allowed only against the local-development host). |

### Session-statistics endpoint

The same client carries a second push endpoint, which reuses this client's credential resolution and header composition (below) and none of the body, response or binding contract of the document push:

| Property | Value                                  |
| -------- | -------------------------------------- |
| Method   | `POST`                                 |
| Path     | `/api/push/jollimemory/sessions`       |
| Origin   | The same resolved Jolli origin.        |

Its body is a single JSON object carrying a protocol `version`, the installation's own stable client id, a per-table `cursor` (how far this installation has been delivered), and a per-table batch of rows. It carries **no** `title`, `content`, `commitHash`, `docType`, `repoUrl`, `branch` or `docId`, and no binding relationship at all — the credential already identifies the organization, so there is nothing for it to be bound to.

### Request headers

| Header           | Value                                                                                                          | When sent                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Content-Type`   | `application/json`                                                                                             | Always.                                                                                                                  |
| `Content-Length` | The byte length of the encoded JSON body.                                                                      | Always (computed from the encoded body — not from the input string length).                                              |
| `Authorization`  | `Bearer <bearer>`. On the **command-line client** the bearer is the saved Jolli API key (`sk-jol-...`) and nothing else — there is no OAuth-token fallback on that surface, which is why the session channel simply skips when no API key is configured. On the other surfaces the bearer is either the API key or, when none is configured, the saved OAuth session token; each passes whichever is its effective bearer, and this header carries the same value either way. | Always.                                                                                                                  |
| `x-jolli-client` | `<kind>/<version>` — the product-and-version identity of the calling surface (e.g. `cli/<v>`, `vscode-plugin/<v>`, `intellij-plugin/<v>`). The version is the build-time product version of that surface. **How the JVM plugin's value arrives changed:** its HTTP is now issued by the bundled command-line runtime on its behalf, and that runtime's own baked-in identity is `cli/<bundled-version>`. So the plugin supplies its identity string (`intellij-plugin/<plugin-version>`) **per request** as a field on each bridged call, and the runtime applies it as this header. A network-reaching bridged request that **omits** the field falls back to the bundled runtime's identity — i.e. it identifies as the CLI — and the runtime logs a non-fatal warning naming the operation. The fallback is deliberate, because the runtime's own commands legitimately omit the field. | Always. Used by the server to identify the caller, to decide whether to apply the per-product minimum-version gate, and to route. |
| `x-tenant-slug`  | The first path segment of the saved Jolli site URL.                                                            | Only when the saved URL is path-based (i.e. has a non-empty first path segment). Omitted for subdomain-based URLs.       |
| `x-org-slug`     | The organization slug embedded in the API key.                                                                 | Only when the bearer is an API key whose decoded payload carries an `o` field. Omitted for old-format keys without `o` and for OAuth-token bearers. |
| trace-correlation header | A Jolli-private request-correlation value of the form `<traceId>-<spanId>` (a 32-hex trace id plus a fresh per-request 16-hex span id). Inside an ambient operation scope it carries that operation's id; outside any scope a fresh standalone value is minted rather than omitting the header. | Always — on **every** push, session-statistics, list-spaces, create-binding, and delete call, because every request's headers come from the one shared builder. Lets the backend correlate one logical operation's requests with its log lines. |

### Request body

A single JSON object.

| Field          | Type                              | Required | Meaning                                                                                                                                                   |
| -------------- | --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`        | string                            | yes      | Display title for the document on the server.                                                                                                              |
| `content`      | string                            | yes      | Rendered markdown body of the summary, plan, note, or reference article.                                                                                   |
| `commitHash`   | string                            | yes      | The originating commit hash. For plan, note, and reference pushes, this is the owning commit at which the attachment was archived; for summary pushes, the summary's commit. |
| `docType`      | string                            | yes      | The on-server document-type discriminator. With the flat per-branch path layout the server uses this as the **sole** signal for which document kind it is. A missing value would silently mistag every push, so it is required. `"summary"` is the reserved tag for the memory itself; **every other value is a context kind's tag, supplied by that kind's definition** — today `plan`, `note`, `reference` and `skill`. It is deliberately typed as a plain string rather than a closed set: a union here would have to grow by one member for every new context kind, which is the exact per-kind edit the definition table exists to remove. **The authority on which tags are accepted is the server's supported-docType configuration**, which rejects an unknown one (see the `doctype_not_allowed` row below). `"reference"` is a standalone article synthesized from an archived external reference; `"skill"` is one article covering a commit's whole recorded skill usage — both are defined by **Jolli Space Push Article Assembly**. |
| `branch`       | string                            | no       | Branch the commit lives on at push time. Used by the server to place the document under a per-branch folder.                                              |
| `docId`        | number                            | no       | Pre-existing server-assigned id, sent on a re-push to update an existing document instead of creating a new one. **Only sent when the id was minted against the same backend origin as the current push** (env-key match); a stored id whose recorded article URL points at a different backend is dropped so the server mints a fresh document rather than overwriting a different backend's article. The gate is defined by **Jolli Space Push Article Assembly**. |
| `repoUrl`      | string                            | no       | Canonical, normalized remote URL of the originating repo. Acts as the server's identity key for "which repo did this come from?" and is what the binding flow keys off. |
| `relativePath` | string                            | no       | Folder chain below the repo folder. With the flat layout it is `<branchSlug>` for all document kinds; never carries a leading `/`.                       |
| summary-JSON sidecar | string                      | no       | Serialized structured summary JSON, sent only on `docType: "summary"` pushes. The server stores it as a hidden sidecar keyed by commit hash so the share page can render structure directly instead of re-parsing the markdown. **Byte-capped** at ~1.5 MiB (1,572,864 bytes) client-side and simply **dropped** above the cap (markdown-only push). Old servers strip the unknown field and the push succeeds unchanged. |

> Note on the discriminator: `docType` (on the body) is the **document** kind. `x-jolli-client` (on the header) is the **client** kind. The two are deliberately distinct: a document of type `"summary"` may be pushed by any of the three client surfaces, and the server treats the two values independently.

### Success response (`HTTP 2xx`)

A single JSON object.

| Field     | Type    | Meaning                                                                                       |
| --------- | ------- | --------------------------------------------------------------------------------------------- |
| `url`     | string  | Canonical Jolli URL of the document the server now holds. The caller prefers this value when building the browsable article link (absolute is used verbatim; a relative value is prefixed with the display base URL); only when the server returns no `url` does the caller fall back to the `<displayBase>/articles?doc=<docId>` alias. See **Jolli Space Push Article Assembly**. |
| `docId`   | number  | Server-assigned numeric id. Stored locally and sent back as `docId` on subsequent re-pushes.  |
| `jrn`     | string  | Server-assigned Jolli resource name (stable, opaque identifier).                              |
| `created` | boolean | `true` if the server inserted a new document, `false` if it updated an existing one.          |
| summary-JSON document id | number | Optional. Server id of the hidden summary-JSON sidecar the server upserted (only on summary pushes that carried the sidecar). Purely informational — the server keys the sidecar by commit hash, so the client never has to track or resend this id. |
| `jmSpace`  | `{ id, name }` | Optional. Echoed by newer servers on `repoUrl`-routed pushes only — the Space the push landed in. Field-validated before use; a drifted or absent shape is treated as "not echoed," never as an error. The client persists it as its local Space-binding cache entry. Absent on older servers and on legacy default-space pushes. |

### Error response shape (non-2xx)

A JSON object with at least one of:

| Field     | Type   | Meaning                                                                                                  |
| --------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `error`   | string | Short error code (e.g. `binding_required`, `binding_already_exists`).                                    |
| `message` | string | Human-readable explanation. The client uses this verbatim where available; otherwise it falls back to a default per-status message. |
| `repoUrl` | string | Echoed canonical repo URL on `binding_required` so the chooser knows which repo to bind.                 |

A non-2xx response whose body does not parse as JSON is surfaced as `Invalid JSON response (HTTP <status>): <first 200 chars>`.

### Deletion endpoint

Used by the client to remove a server-side document whose local origin no longer exists (squashed/rebased commits whose summary has been migrated or dropped).

| Property              | Value                                |
| --------------------- | ------------------------------------ |
| Method                | `DELETE`                             |
| Path                  | `/api/push/jollimemory/<docId>`      |
| Headers               | `Authorization`, `x-jolli-client`, and `x-tenant-slug` / `x-org-slug` under the same conditions as the push. No body is sent. |
| Success status codes  | Any `2xx` is treated as success (the server may return `200` or `204`; the client does not distinguish). |
| Failure              | `401`/`403` **both** surface as a not-authenticated error here — deliberately *unlike* the push path, where `403` maps to permission-denied. Any other non-2xx is surfaced as a delete-failed error carrying the `<status>`. |

## Behavior

### Build the request

1. Decode the API key (if the bearer is one) to extract its embedded site URL `u`, tenant `t`, and optional org `o`.
2. Resolve the effective base URL. **This resolution is surface-specific:**
   - **Editor extension / JVM IDE plugin:** explicit override → saved Jolli site URL → URL embedded in the API key. If none is available, fail before sending with `Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again`.
   - **CLI:** only **two** sources — an explicit *test-only* override, or the URL embedded in the API key. The CLI **never** reads the separately-saved Jolli site URL. If neither is available it fails with a not-authenticated error whose message nonetheless tells the user to "set jolliUrl" — a real bug: an API key with no/stale embedded URL cannot push even when a valid Jolli site URL is configured, and the error text points at a knob the CLI push path does not consult. (See Notable Behavior.)
3. Parse the resolved base URL into `(origin, tenantSlug)` as defined by **Tenant Resolution Modes**.
4. Build the absolute push URL by joining `origin` with the path `/api/push/jollimemory`.
5. Encode the body to JSON and measure its byte length.
6. Compose headers per the table above.

### Send the request

1. Open a `POST` to the absolute push URL, sending HTTPS or HTTP based on the resolved origin's scheme. **Transport is surface-specific:**
   - **Editor extension:** a direct raw-socket HTTP/HTTPS request (not a higher-level fetch wrapper). This is what lets self-signed certificates on the local-development host keep working without an extra trust step.
   - **CLI:** the platform `fetch` client. It has **no** self-signed-cert override, so it **cannot** reach a self-signed dev host the way the raw-socket editor client can. It also sets an explicit **30-second per-request timeout** via an abort controller (see Retry Policy) rather than relying on a platform default.
2. Write the JSON body and end the request.
3. Read the entire response body before deciding success or failure.

### Handle the response

1. On `2xx` with parseable JSON, resolve with `{ url, docId, jrn, created }`.
2. On `412` with `error: "binding_required"`, surface the binding-required error with the echoed `repoUrl` (or the request's own `repoUrl` if the server did not echo one). See **Binding Required Flow** for what the caller does with that error.
3. On `412` with `error: "repo_not_allowlisted"`, surface a **permission-denied** error carrying the server's message — **not** binding-required. `412` is deliberately overloaded on this endpoint: the allowlist refusal is emitted as `412`, not `403` (that status is the *bind* path's `space_restricted`), so the discriminator is the body's `error` slug. Both clients map it. The mapping is load-bearing rather than cosmetic — permission-denied is a non-incrementing category in the drain's retry classification (spec 269) and a member of the repo-wide refusal set (spec 327), so mis-mapping it to a generic `HTTP 412` would both hammer the server with doomed retries and turn one repo-wide condition into N per-item failures.
4. On `412` with `error: "doctype_not_allowed"`, surface a **document-type-not-allowed** error carrying the request's own `docType` plus the server's message. The server has no configuration row enabling that document type. This is the **third** slug sharing the `412` status, and it maps to a **distinct error class** on purpose: it is a configuration problem like the allowlist refusal, but it is **not** a permission-denied and **not** a member of the repo-wide refusal set. Reusing permission-denied — the natural-looking choice, since the two arrive with the same status and the same machine-tag shape — would make one unconfigured context kind abort the whole attachment loop and fail the summary push, i.e. one missing configuration row would stop the repo publishing anything at all. Its correct scope is a third tier between "skip one item" and "abort everything": every item of that same kind will fail identically, so the caller short-circuits that kind and keeps pushing the others (see **Jolli Space Push Article Assembly**). It must also not burn a retry budget or mark the commit failed — the summary itself pushes fine.
5. On `426`, surface the plugin-outdated error with the server's `message` (or a default if none). See **Plugin Outdated Flow**.
6. On `409` with `error: "binding_already_exists"`, surface the body verbatim as a binding-already-exists error so the chooser flow can resolve it gracefully. See **Binding Required Flow**. `409` now carries a **second slug**: on the session endpoint, `cursor_ahead` means the server holds less than the cursor the client sent, and it is surfaced as its own error carrying the server's own cursor to fall back to.
7. On `401`, reject with a not-authenticated error (the saved credential is missing or was rejected by the server); the body's message is not used. On `403`, the two statuses **part company** — this is *not* a single "auth failed" bucket on the push path:
   - **CLI:** `401` → not-authenticated, `403` → **permission-denied** carrying the server's message. On the push path a `403` means the credential is valid but the target doc belongs to another user / was not created by Jolli Memory — an ownership/admin problem, not a sign-in one.
   - **Editor extension:** `403` → permission-denied, same rationale and message precedence. It has **no** `401` branch at all, so a `401` falls through to the generic non-2xx path (next step) and surfaces the body's `message` / `error` / a raw-body snippet.
   - The `401 || 403 →` not-authenticated pairing does still exist on the CLI, but only on **other** calls: the guided front-door probe and the delete. Do not generalize it to the push.
8. On any other non-2xx response, reject with the body's human-readable `message` if present, else its `error` code, else `HTTP <status>`.
9. On a `2xx` whose body is empty / non-JSON / missing the required fields, reject rather than resolve: a 2xx with no numeric `docId` and no string `url` would otherwise poison the article link and force a re-create instead of an update on the next push. (CLI wording: `Push returned HTTP <status> but the response was missing a docId/url`.)
10. On a body that does not parse as JSON, reject with `Invalid JSON response (HTTP <status>): <first 200 chars>`. **On the session endpoint a success response whose body does not parse is classified differently:** it raises the *same* class as a missing endpoint (`404`), because a single-page application answering an unknown route with its index document is indistinguishable on the wire from a deployed endpoint that answered.
11. On a transport error before any response is received, reject with `Network error: <message>`.

### Retry policy

There is **no automatic retry** on the **document** push. Every call is a single attempt. The caller decides what to do on failure:

- A `412` triggers the binding-required flow; on success the caller re-invokes the push (one fresh single-attempt call).
- A `409` (during the binding registration that follows a `412`) is resolved by the chooser, which then re-invokes the push.
- Any other failure surfaces to the user; the user retries by triggering the push again.

The deletion endpoint also has no automatic retry.

**The session endpoint is the exception, and it is not single-attempt.** One run issues up to **ten** requests, walking its cursor forward until nothing is left or the ceiling is reached; on a cursor conflict it adopts the server's cursor and re-sends that range up to **two** extra times before giving up until the next run. It is also not user-triggered: a run enforces its own minimum interval of **thirty minutes** from the last attempt, whichever trigger asks, so a request that goes nowhere is retried by the next run rather than by a person.

## State Transitions

A single push is a one-shot RPC: either it resolves with a `JolliPushResult`, or it rejects with one of the five error categories above. The **caller** holds whatever multi-step state machine arises from the chooser flow (see **Binding Required Flow**); this spec's request/response is the leaf RPC.

## Notable Behavior

- **The discriminator is required on the body, and the client no longer constrains it to a closed set.** It is a plain string: `summary` for the memory itself, and each registered context kind's own tag for everything else (`plan`, `note`, `reference`, `skill` today). The authority is the server's supported-docType configuration, not the client's type. Constraining it client-side would mean editing this contract for every new context kind — the exact per-kind edit the kind-definition table exists to remove. With the flat per-branch path layout the server has no other reliable signal for the document kind, so a missing value would silently mistag every push, which is worse than rejecting one. (Surprising; intentional.)
- **Three different slugs arrive on `412`, and one of them must NOT be folded into the others.** `binding_required` is recoverable by the user (run the chooser), `repo_not_allowlisted` is a repo-wide admin action, and `doctype_not_allowed` is neither — it is scoped to one document *kind*. Mapping the third onto the permission-denied class, which is what its identical status-and-machine-tag shape invites, would put it in the repo-wide refusal set and let one missing configuration row stop the repo publishing anything at all. (Surprising; safety-relevant.)
- **A stored document id is only re-sent to the same backend it was minted on.** Each stored id travels with the article URL it was minted with; the id is re-sent as an update target only when that URL's origin matches the current push's resolved backend origin. On a mismatch the id is dropped so the server mints a fresh document instead of overwriting a different backend's article (e.g. a `jolli-local.me` id must never update a `jolli.ai` document). The gate is defined by **Jolli Space Push Article Assembly**. (Surprising; safety-relevant.)
- **A successful push doubles as proof of push rights.** The optional `jmSpace` echo lets the client persist a healthy, confirmed local binding-cache entry as a side effect, at no extra request cost — a successful push proves both the binding and the caller's push right. (Notable.)
- **There is no bulk push endpoint.** A multi-attachment endpoint existed and was withdrawn: its combined-payload cap sat above a typical gateway's body limit, and the resulting rejection was indistinguishable from an ordinary transient failure, so it burned every retry and then aged out silently while the user simply saw memories never arrive. Every document — memory and attachment alike — now goes through the single-document call above, one request group per commit. (Notable; a removed capability, not a missing one.)
- **The article URL prefers the server-returned `url`.** It is no longer always the `?doc=<id>` alias: an absolute server `url` is used verbatim, a relative one is prefixed with the display base, and the `?doc=<id>` alias is only a fallback for when the server returns no `url`. (Notable.)
- **`x-jolli-client` carries product **and** version, not just product.** The server uses the version to gate clients below its minimum supported version, returning `426` on too-old. Sending only the product would lose half the contract. (Notable.)
- **A per-request identity field is a new way for `x-jolli-client` to be wrong.** Because the JVM plugin's requests are issued by the bundled command-line runtime, the plugin's identity is data on each request rather than a property of the running binary. A bridged network call that forgets the field silently identifies as `cli/<bundled-version>` — which would **evade the server's per-surface minimum-version gate** (the plugin could keep working past its own cutoff, or be gated on the wrong one) and **skew per-surface attribution**. Nothing on the wire distinguishes that from a genuine CLI push; the only signal is the runtime's non-fatal warning in its own log, which names the operation that arrived without an identity. Purely local bridged operations are excluded from the warning because they reach no network. (Surprising; a real correctness hazard.)
- **Two distinct kinds rides on two distinct fields.** `docType` is the **document** kind; `x-jolli-client` carries the **client** kind. The two fields move independently and serve different routing decisions on the server. (Surprising.)
- **The document push is a single attempt — no automatic retry.** Document pushes are user-initiated (or hook-initiated post-commit) and idempotency is achieved by sending a known `docId` on re-pushes, not by client-side retry. A transient failure surfaces to the user; the user retries by re-triggering. The session endpoint on the same client does not share this property — it retries within a run and again on its own thirty-minute period (see Retry policy). (Notable.)
- **A success status is not evidence the session endpoint exists.** A single-page application answering an unknown route with `200` and its index document looks exactly like a deployed endpoint, so an unparseable success body there is raised as the *same* class as a `404` rather than as a malformed-response error. Without that check the channel reported success while nothing was ever ingested — the batch looked accepted, the cursor advanced past rows that reached nobody, and every surface said the upload was healthy. (Surprising; this is the one check whose absence loses the data silently.)
- **Transport differs by surface.** The editor extension uses a direct raw-socket HTTP/HTTPS request (not a fetch wrapper) so self-signed certificates on the local-development host need no extra trust step. The CLI uses the platform `fetch` client, which has **no** self-signed-cert override — so the CLI **cannot** reach a self-signed dev host the way the raw-socket editor client can. (Notable; a real per-surface capability gap.)
- **The base URL's resolution sources differ by surface.** The editor extension / JVM plugin resolve explicit override → saved Jolli site URL → URL embedded in the API key. The **CLI has only two**: a test-only override, or the URL embedded in the API key — it never consults the saved Jolli site URL. The embedded fallback is why a freshly issued key can push without a site setting; rotating a key with a new embedded URL changes the push target. (Notable.)
- **CLI push cannot recover from a missing embedded URL — a real bug.** Because the CLI push path ignores the saved Jolli site URL, an API key with no or a stale embedded URL fails to push even when a valid site URL is configured. Worse, the failure message tells the user to "set jolliUrl" — a knob the CLI push path does not read. (Bug; surfaced as behavior.)
- **`412` is overloaded, and the slug is the discriminator.** `binding_required` and `repo_not_allowlisted` arrive on the *same* status; only the body's `error` field separates "you need to bind this repo" (recoverable — run the chooser) from "an administrator has to allowlist this repo" (repo-wide, not recoverable by the user). The allowlist refusal is emitted as `412` rather than the more obvious `403` because `403` is already taken on the *bind* path (`space_restricted`). A client that branches on status alone gets the recovery flow exactly backwards. **The session endpoint is the one place that does branch on the status alone** — a `412` there is classified with **no slug read at all**, since that channel requires no binding and so has no slug it could expect. (Surprising; the status is not the contract.)
- **`401` and `403` are different categories on the push path, but the same one on delete and front-door.** Push maps `403` to permission-denied (valid credential, refused doc — an ownership or admin problem); `deleteDoc` and `frontDoor` still collapse `401 || 403` into not-authenticated. The asymmetry is real and per-call, not per-status. The editor extension goes further and has no `401` branch on push at all. (Surprising; easy to over-generalize.)
- **The permission-denied mapping is load-bearing downstream.** It is a non-incrementing category in the pending-drain's retry classification (spec 269) *and* a member of the shared repo-wide refusal set (spec 327). Leaving `repo_not_allowlisted` as a generic `HTTP 412` would burn the retry budget on doomed pushes and turn one repo-wide condition into N per-attachment failures. (Notable; the mapping is not cosmetic.)
- **`200` and `204` are both treated as delete success.** The server may return either; the client does not distinguish. (Notable.)
- **No `x-tenant-slug` is sent for subdomain-based URLs.** The server resolves the tenant from the subdomain itself in that mode. Sending the header would be redundant and is omitted. (Notable.)
- **`x-org-slug` is only sent when the bearer is an API key whose payload carries an `o` field.** OAuth-token bearers and old-format keys both omit it. (Notable.)
- **The deletion path exists to clean up after squash and rebase.** When a summary is migrated (e.g. squash consolidation) or dropped (e.g. rebase that abandons a commit), the previously-pushed server document is deleted by `docId` so server state matches local state. The deletion is not part of the normal post-commit push path.
- **The user-facing push button label is conditional.** On a summary that has never been pushed (no server-assigned URL recorded locally), the button reads "Share in Jolli"; once a successful push has recorded the server URL on the local summary, subsequent renders show "Update on Jolli" on the same button. The underlying request is identical in either case — the label change is purely a UI affordance that reflects whether a server document already exists for this commit. (Notable.)
- **Three implementations exist.** The CLI, the editor extension, and the JVM IDE plugin each carry their own implementation of this push but share the contract. They agree on endpoint, headers, body shape (including the summary-JSON sidecar and its byte cap — carried by both the CLI and editor extension), response shape (including the summary-JSON document id), status-code mapping, and the no-retry policy. Differences: HTTP client (raw sockets in the editor extension vs the CLI's platform `fetch`); base-URL resolution sources (see above); and timeouts — the CLI imposes an explicit **30-second per-request** timeout via an abort controller, and the editor extension relies on platform defaults. **The JVM IDE plugin no longer owns an HTTP client for this call at all:** it serializes the request and hands it to the bundled command-line runtime, which issues the actual `fetch` — so the CLI's transport, its 30-second per-request timeout, and its status-code mapping are what apply, and the plugin's own bound is the (much larger) ceiling it allows the bridged call. That is also why the plugin must supply its `x-jolli-client` identity per request (see above). The CLI and editor extension **share the same API-key parse / origin-allowlist module** (the CLI's canonical helpers, bundled verbatim into the extension) — it is not an independent port; only the JVM plugin carries a separate Kotlin port. (Notable parity facts.)

## Shared Behavior

- The `(origin, tenantSlug)` derivation from the saved Jolli site URL — including which form is path-based vs subdomain-based and how each maps to headers — is defined by **Tenant Resolution Modes**.
- The `412` mapping to "binding required", the chooser, and the post-binding push retry are defined by **Binding Required Flow**.
- The `426` mapping to "plugin outdated" and the user-facing message are defined by **Plugin Outdated Flow**.
- What callers do with a permission-denied / client-outdated / push-disabled rejection — abort the whole loop rather than collect it per item — is defined by **Repo-Wide Push-Refusal Classification** (327); the retry-budget consequence is defined by spec 269.
- The product API key shape and how `t`, `u`, and `o` are decoded from it are defined by **Jolli API Key Format and Parsing**.
- The HTTPS allowlist that the resolved origin must satisfy is defined by **Jolli Origin Allowlist Enforcement**.
