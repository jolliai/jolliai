# 170. Sync Backend Client

## Topic Statement

Issue tenant-scoped HTTP requests against the backend's personal-space sync endpoints, mapping every response into either typed success values or a fixed taxonomy of typed errors the sync engine can pattern-match.

## Scope

**In scope:**

- The four sync-engine-facing endpoints exposed by the client surface: credential mint, push notification, legacy-content fetch, and migration completion. (The same client also exposes a per-round lock-release endpoint that shares the request pipeline; it is described inline because it travels the same auth and error paths.)
- The shared per-request pipeline: API-key resolution, tenant-base-URL derivation, header assembly, body serialization, abort-based timeout, and response classification.
- The mapping from saved API key to the backend origin the request is sent to, including how a key whose payload encodes a per-tenant URL routes every request to that tenant's subdomain rather than a generic origin.
- The five typed exception categories (generic non-2xx, unauthorized, vault-locked, web-flush-pending, network failure) and the exact conditions that produce each.
- The mint-response validation policy (which fields are required, which schema shapes are rejected as a 502-class server bug, which scheme is enforced on the returned clone URL).
- The body-shape contract sent to each endpoint and the body-shape contract expected back, including idempotency markers and "already migrated / already bound" semantics.
- Test-seam knobs: injectable HTTP transport, injectable API-key provider, base-URL override, and per-request timeout override.

**Out of scope (boundaries — what is sent/received but not re-specified here):**

- The full reconciliation round that calls these endpoints, including how it sequences mint → fetch → push → notify, how it interprets each typed error (retry, re-mint, degrade to offline, surface conflict), and how it manages the per-space write-lock lifecycle on the engine side (separate spec — the sync engine reconciliation cycle).
- The legacy database-to-git migration's content-merge and push logic that consumes the legacy-content payload and ultimately calls the migration-completion endpoint (separate spec — the legacy DB-to-git migration). Only the endpoint contract is described here.
- The structural rules of the saved API key itself — the format that allows the tenant URL to be encoded inside it, the prefix shape, and the segment-scanning decoder that produces the typed metadata (separate spec — Jolli API key parsing). The client consumes the parsed metadata as an opaque record.
- The host allowlist enforced when the saved key is first written to disk (separate spec — origin allowlist). The client assumes a key it can decode is already on the allowlist; it does not re-check.
- The persistent on-disk credential store that the default API-key provider reads (separate spec — auth credential storage). The client either gets a non-empty string back or treats the absence as an unauthorized condition.
- The LLM proxy that routes assistant traffic through a different backend surface (separate spec — Jolli proxy LLM routing). Different endpoints, different lifecycle; not reachable through this client.
- The backend's server-side schema validation, business logic, write-lock semantics, GitHub repo provisioning, and read-mirror fetcher. The client observes only HTTP status codes and JSON bodies at the boundary.

## Data Contracts

### Inputs (per request)

- A **saved API key** string sourced from a per-process provider. When the provider yields nothing (e.g., the user is signed out), the request short-circuits before any network call.
- **Decoded API-key metadata** containing at minimum a base site URL string and optionally an organization slug. The base URL may carry a single path segment that designates a tenant slug.
- **Optional base-URL override** supplied at client construction; when present, takes precedence over the URL encoded in the key for the purpose of choosing the origin.
- **Optional timeout** in milliseconds (default: ten seconds) applied uniformly to every request.

### Per-endpoint request bodies

- **Credential mint**: an empty JSON object.
- **Push notification**: a JSON object carrying a commit hash, a branch name, and a write-lock owner token.
- **Lock release**: a JSON object carrying only the write-lock owner token (no other fields; the server rejects unexpected extras with a generic client-error status).
- **Legacy-content fetch**: no body.
- **Migration completion**: a JSON object carrying a commit hash and a write-lock owner token.

### Per-endpoint response shapes

- **Credential mint** returns the freshly minted credentials object: a short-lived bearer token, an expiry (either an integer epoch in milliseconds or an ISO-8601 timestamp string — both accepted; otherwise rejected), a clone URL (must parse and be HTTPS — otherwise rejected), a canonical owner/repo full name, a backend-declared default branch, a boolean indicating whether the GitHub repo was just provisioned (informational), a boolean indicating whether the personal space is already bound to its git backing, and a write-lock owner token. Any missing required field or any invalid value yields a typed "bad-gateway-class" error.
- **Push notification** returns either an empty 2xx body or a small JSON body that the client discards (the void return value is the contract).
- **Lock release** returns a small JSON body that the client discards (the void return value is the contract).
- **Legacy-content fetch** returns a payload describing the personal space's identifier and slug, a boolean idempotency flag indicating whether the space has already flipped to its git backing, and an array of legacy documents (each carrying identity, slug, path, type, parent linkage, content body, content type, sort order, and timestamps). When the idempotency flag is set, the array is empty.
- **Migration completion** returns a small JSON payload from which the client extracts a single boolean indicating whether the flip had already been performed; any other fields are discarded.

### Typed error taxonomy

A small fixed set of exception categories that callers pattern-match by category, not by status code:

- **Unauthorized** — carries status 401 (and is also raised for 403 responses, for absent API keys, and for unparseable API keys). Signals "saved token is invalid or unusable; clear cache and re-mint once".
- **Vault locked** — carries status 423 with a user-facing message phrased in product terminology (no internal jargon). Signals "another device is currently syncing the same personal space".
- **Web flush pending** — carries status 503 only when the response body identifies itself as the cooperative back-off code; also carries a positive retry-after value in seconds (defaulted when the field is missing, non-numeric, non-finite, or non-positive).
- **Network unreachable** — carries a wrapped underlying transport failure (DNS, connection refused, connection reset, timeout/abort, etc.). Distinct from any HTTP-level error because the engine treats it as "transient, drop to offline state".
- **Generic backend error** — every other non-2xx status, plus three synthetic 502-class cases: a 2xx body that is not JSON, a 2xx body missing mint-response required fields, and a 2xx mint body whose clone URL is unparseable or non-HTTPS.

Every category exposes the HTTP status (where applicable) and the response body text for diagnostic logging.

## Behavior

### Endpoint paths (wire contract)

The four sync-engine endpoints are routed at fixed relative paths under a shared prefix that callers cannot configure:

- `POST /api/mb-sync/credentials` — credential mint.
- `POST /api/mb-sync/notify-push` — push notification.
- `GET /api/mb-sync/legacy-content` — legacy content fetch.
- `POST /api/mb-sync/complete-migration` — migration completion.

A companion `POST /api/mb-sync/release-lock` shares the same pipeline and is documented inline for completeness; the per-request behavior below describes all five uniformly.

### Per-request pipeline (executed in this order for every endpoint)

1. **Resolve the API key.** Call the configured provider.
   - If the result is empty (absent or empty string), throw the **unauthorized** error with a synthetic body identifying the missing-key condition. No network call is made.
   - If the result is non-empty, attempt to decode the key into the typed metadata record. A failure to decode (does not match the expected key shape) throws the **unauthorized** error with a synthetic body identifying the malformed-key condition. No network call is made.

2. **Choose the base URL.**
   - If a construction-time base-URL override is configured, use it.
   - Otherwise, use the base URL field from the decoded key metadata.

3. **Parse the base URL into origin and tenant slug.** Stripping leading and trailing slashes, the first non-empty path segment (if any) is treated as the tenant slug. Subsequent path segments are discarded for header assembly. The origin (scheme plus host plus optional port) is used as the request's base.

4. **Build the final URL.** Resolve the endpoint's relative path against the parsed origin. The resulting URL is always `<origin>/api/mb-sync/<endpoint>`; any tenant slug that appeared in the base URL is **dropped from the path** at this step — it survives only in a header (see next step).

5. **Assemble headers.**
   - `Authorization: Bearer <saved API key>` — the saved API key itself, **not** any short-lived token previously minted by this client. (Every request authenticates with the long-lived saved key; the minted token is a downstream artifact consumed elsewhere.)
   - `x-jolli-client: <client-kind>/<client-version>` — a build-time-injected identifier (e.g. `cli/<cli-version>` for the CLI binary, `vscode-plugin/<extension-version>` for the IDE extension; the same code path runs in both surfaces and self-identifies accordingly). A bare-build-without-defines fallback is reachable only in unbundled execution.
   - For `POST` requests, `Content-Type: application/json`. For `GET` requests, this header is **not** sent.
   - `x-tenant-slug: <slug>` — present only when the parsed base URL exposed a tenant slug in its first path segment.
   - `x-org-slug: <slug>` — present only when the decoded key metadata carries an organization slug.

   Notable consequence: tenant-subdomain routing is achieved by the base URL field encoded inside the saved API key. A key whose embedded URL points at `https://<tenant>.<root-domain>/...` routes every request to that subdomain; sending to the bare root domain instead would cause the backend's tenant middleware to reject the request before any handler runs.

6. **Build the body.**
   - For `POST` requests, JSON-serialize the supplied payload object. If the payload is nullish (a defensive case unreachable from current callers), serialize an empty object instead.
   - For `GET` requests, no body is sent.

7. **Issue the request with a timeout.**
   - Create an abort signal.
   - Schedule an abort to fire after the configured timeout (default ten seconds).
   - Invoke the configured HTTP transport with the URL, method, headers, body, and signal.
   - Clear the timeout regardless of outcome (success, error, or timeout abort).
   - **Any thrown error from the transport** (DNS failure, connection refused, connection reset, abort, etc.) is wrapped as the **network-unreachable** error category and rethrown. The original error is retained as the wrapped cause for logging.

8. **Read the response body as text** unconditionally (even for empty 2xx and error responses; the text is needed for typed-error payloads).

9. **Classify by status.** Branches are evaluated in this exact order:
   1. **Status 401 or 403** → throw **unauthorized** with the body text. Forbidden responses are merged into the same category because both indicate "the saved key is no longer accepted; clear cache and re-mint once".
   2. **Status 423** → throw **vault-locked** with the body text.
   3. **Status 503** → try to parse the body as JSON. If the parse succeeds, the parsed value is an object, the object's `error` field equals the cooperative back-off code (the literal `"pending_flush_failed"`), then extract a retry-after value:
      - If the body's retry-after field is a finite positive number, use it.
      - Otherwise, default to **30 seconds**.
      Throw **web-flush-pending** with the body text and the retry-after value.
      Any 503 response that does **not** match this exact shape falls through to the generic-error branch below — real backend availability problems must not be mis-classified as cooperative back-off.
   4. **Any other non-2xx status** (i.e., `response.ok` is false) → throw the **generic backend error** with the status, a synthetic message naming the status, and the body text.
   5. **2xx with an empty body** → return an empty object cast to the caller's expected response type. (This is the contract for `POST /notify-push`, `POST /release-lock`, and any future void-returning endpoint.)
   6. **2xx with a non-empty body** → JSON-parse the text. If parsing fails, throw the **generic backend error** with synthetic status 502, the message "Sync backend returned non-JSON 2xx body", and the **first 1024 characters** of the body (the truncation guards log output against arbitrarily large HTML/error pages).
   7. **2xx with a JSON-parseable body** → return the parsed value cast to the caller's expected response type. No structural validation is performed at this layer; endpoint-specific validation (see below) is applied by the calling method, not the pipeline.

### Endpoint-specific behaviors (after the shared pipeline)

#### Credential mint (`POST /credentials`)

After the pipeline returns a parsed JSON object:

1. **Required-field check.** A list of required fields is built from the response: bearer token, expiry, clone URL, owner/repo full name, default branch, vault-bound boolean, and write-lock owner token. The boolean field must be of boolean type — a string like `"yes"` is treated as missing. If any field is missing, throw a **generic backend error** with synthetic status 502, a message naming the missing fields (joined as a comma-separated list), and a body that is the full JSON-serialized response.
2. **Clone-URL parse.** Attempt to parse the clone URL as an absolute URL. On failure, throw a **generic backend error** with synthetic status 502, a message naming the unparseable URL, and the same full JSON-serialized response body.
3. **Clone-URL scheme guard.** The parsed URL's scheme **must be `https:`**. Any other scheme (including `http:`) throws a **generic backend error** with synthetic status 502, a message naming the non-HTTPS scheme, and the same full body. Rationale (captured from the source): downstream credential injection attaches a bearer token to the clone URL when invoking git; a non-HTTPS URL would send that token over cleartext, so this is treated as a hard server bug rather than a recoverable value.
4. **Expiry coercion.** The expiry field may arrive as either a number (already epoch milliseconds) or a string. If a string, parse it as an ISO-8601 date and convert to epoch milliseconds. If the result is not a finite number, throw a **generic backend error** with synthetic status 502, a message naming the invalid expiry value, and the same full body.
5. **Field projection.** Build and return the typed credentials object. Notable mappings:
   - The clone URL field is **also** exposed under a second name (an alias used by the rest of the engine). Both names carry the same string.
   - The vault-bound boolean is forwarded verbatim.
   - The repo-just-created flag is forwarded; if absent in the backend response, it defaults to `false`. (In practice the backend always sends it; the default is defensive against older backend versions.)
   - The write-lock owner token is forwarded.

#### Push notification (`POST /notify-push`)

Pipeline result is discarded; the method returns void. The body shape sent is exactly `{ commitSha, branch, lockOwnerToken }` — no other fields. Any non-2xx response surfaces via the typed-error taxonomy. A 400 response indicates a client-side bug (missing or malformed lock-owner token); the engine surfaces this as a generic backend error and logs it, but does not retry.

#### Lock release (`POST /release-lock`)

Pipeline result is discarded; the method returns void. The body shape sent is exactly `{ lockOwnerToken }` — **no commit hash and no branch**. The backend's success response is a 202 with a small JSON acknowledgement; the client discards the body. Idempotency expectations:
- A 404 response (token never held, or backend write-lock TTL already expired) is the expected idempotent failure shape; the caller is responsible for swallowing it.
- A 400 response indicates a malformed lock-owner token (client bug); the caller is expected to log it.
- Other 4xx/5xx responses follow the generic-error path.
The endpoint is rate-limited at the backend; callers must invoke at most once per round teardown.

#### Legacy-content fetch (`GET /legacy-content`)

The pipeline returns the parsed JSON payload verbatim. No structural validation at this layer; the document array is forwarded as-is to the caller. The idempotency flag distinguishes "space still on the legacy backing, here are the docs" from "space already migrated, docs array is empty".

#### Migration completion (`POST /complete-migration`)

The pipeline returns a parsed JSON object. The client extracts only the idempotency boolean by coercing whatever value the backend returns under that field name to a strict boolean (any truthy value becomes `true`; any falsy or missing value becomes `false`). All other fields in the response are discarded. The body shape sent is exactly `{ commitSha, lockOwnerToken }`; an empty body would be rejected by the server's schema with a 400, which the client surfaces as a generic backend error.

### API-key accessor

The client exposes a read-only accessor that yields the same value the configured provider returns (or undefined when signed out). This is used by callers that need to scope persisted state by a hash of the active key (so an account switch invalidates the entry) without performing any network call.

### Test seams

At construction time, three pipeline inputs may be overridden:
- The HTTP transport function (defaults to the host environment's built-in fetch).
- The API-key provider (defaults to a lazy import of the persistent credential store).
- The base URL (defaults to the URL field encoded in the saved key; an override is useful for local mocks or non-standard origins).
- The timeout in milliseconds (defaults to ten seconds).

## State Transitions

The client is stateless across requests. The only persistent state it consults is the saved API key on disk (read on every request via the configured provider). No values are cached between calls — every request reads the API key, decodes its metadata, and resolves the origin afresh. This guarantees that an account switch (where the saved key is replaced) takes effect on the very next request without restart, and that a deleted key produces an immediate unauthorized result.

## Notable Behavior

- **Authentication identity inversion.** Every sync-engine request authenticates with the long-lived saved API key (via `Authorization: Bearer`), even the very request whose response is itself a freshly minted short-lived bearer token. The two tokens are independent: the saved key authorizes the API call, and the minted token is consumed downstream (by the git transport) as a separate credential.
- **Tenant routing comes from the saved key, not from the request.** The base URL encoded inside the API key determines which subdomain the client talks to. There is no global "backend origin" configuration; every device with a key for a given tenant routes to that tenant's subdomain automatically.
- **The tenant slug is conveyed twice but redundantly.** When the base URL exposes a first path segment, that segment is dropped from the eventual request path and re-attached as a header. The path-form of the slug never appears on the wire; only the header form does. (For a base URL with no path segment, the header is omitted entirely and the slug travels solely via the subdomain.)
- **Forbidden status is treated as unauthorized.** The pipeline maps both 401 and 403 to the same typed-error category. This conflates "credential rejected" and "credential valid but lacks permission" at this layer; callers cannot distinguish them without inspecting the body string.
- **The cooperative 503 path is narrow.** Only a 503 whose JSON body's `error` field equals the exact literal cooperative back-off code produces the **web-flush-pending** typed error. A 503 with any other JSON body, no JSON body at all, or an unparseable body falls through to the generic-error path. This is intentional: real backend outages must not be mis-classified as "wait a bit and retry".
- **2xx-with-bad-JSON yields 502.** A successful HTTP response whose body is not parseable as JSON does not propagate as a transport error; it becomes a synthetic 502 in the generic-error category. This treats the backend as misbehaving (returning HTML or empty 2xx) rather than the network as unreachable.
- **Mint validation is heuristic and order-sensitive.** Required-field check runs first (and lists every missing field at once), followed by clone-URL parse, then scheme check, then expiry coercion. A mint response that is missing the clone URL **and** has an invalid expiry will only mention the missing clone URL in the error message — the second issue is not reached.
- **Clone-URL non-HTTPS is non-recoverable, not retried.** The scheme guard treats any non-HTTPS URL as a permanent server bug and throws a 502-class error. The reasoning (captured from source) is that downstream code injects a bearer token into the URL when running git, and surfacing a non-HTTPS URL would leak that token in cleartext; refusing loudly at the boundary is preferred over silent acceptance.
- **Non-JSON 2xx bodies are truncated to 1024 characters in the error payload.** This bounds log output when the backend accidentally returns a large HTML error page with a 200 status.
- **The timeout is per-request, not per-call.** Each method invocation creates its own abort controller and its own timer; there is no shared budget across multiple invocations of the same client.
- **Network and HTTP errors are disjoint.** A transport-layer failure (DNS, connection refused, abort) becomes the **network-unreachable** category; an HTTP-layer non-2xx becomes one of the other four categories. A caller cannot encounter both for the same request.
- **`alreadyMigrated` is coerced strictly.** The migration-completion handler runs the response field through a boolean coercion, so a missing field, `null`, the empty string, or any other falsy value becomes `false`, while any truthy value (including a non-empty string or non-zero number) becomes `true`. This deliberately accepts loose backend responses.
- **`githubRepoCreated` has a defensive default of `false`.** Newer backends always emit the field; the default protects against older deployments. The field is informational only and does not branch any client logic.
- **The lock-release endpoint shares the same auth pipeline as the four sync endpoints** but is invoked from a different control flow (round teardown safety net rather than steady-state reconciliation steps). Its 404 response is the only place in the surface where a backend status code is expected to be benign on the happy path — the caller is responsible for swallowing it.
- **Vault-locked carries a user-facing message.** The typed error's message string is intended to flow into the status bar / tooltip without rephrasing; it uses the product label "Personal Space" rather than internal "vault" / "lock" terminology. The body text is preserved separately for diagnostics.
- **The API-key accessor never throws.** It returns the same value the provider returns (or undefined), with no decoding or validation, so a caller using it solely to derive a hash for state-scoping does not need to handle exceptions.

## Shared Behavior

- **Saved API key shape and tenant URL extraction** — see the Jolli API key parsing spec. This client consumes the decoded metadata as an opaque record.
- **Host allowlist enforcement on the saved key** — see the origin allowlist spec. The client trusts that any key the parser accepts has already passed the allowlist gate at save time.
- **Persistent credential store** that the default API-key provider reads — see the auth credential storage spec.
- **Sync engine reconciliation cycle** — see that spec for how each typed error category maps to retry, re-mint, conflict, and offline UI states, and for the per-space write-lock lifecycle.
- **Legacy DB-to-git migration** — see that spec for how the legacy-content payload is merged and pushed before the migration-completion call is issued.
