# 09 — Jolli Proxy LLM Routing

## Topic Statement

This spec defines how an LLM call is routed to the Jolli backend proxy when the user has only a Jolli Space API key, with the backend owning the prompt template, the LLM provider choice, and the model selection.

## Scope

**In scope**

- The conditions under which the proxy path is taken instead of a direct LLM-provider call.
- The proxy endpoint origin, path, method, and headers.
- The request payload shape (action key + parameters, no built prompt).
- The response shape consumed by the caller.
- Authentication on the proxy call.
- Tenant / org routing headers derived from the API key and base URL.
- Error mapping at the proxy boundary.
- The "backend owns the template" contract: what the client sends, what it does not.

**Out of scope**

- The full credential-source priority across all sources (see spec 10).
- The direct provider call (see spec 08).
- Prompt-template content and the export pipeline (see spec 11).
- Validation rules for the API key origin allowlist (covered in upstream save-time validation; this spec only references the URL extraction).

## Data Contracts

### Activation

The proxy path activates for a single LLM call when, at dispatch time:

- No Anthropic-direct credential is available, AND
- A Jolli Space API key (the `sk-jol-…` shape) is supplied to the call.

Full priority resolution across all sources is in spec 10.

### Endpoint resolution

The endpoint is built per call from the Jolli Space API key:

1. Decode the API key's embedded metadata to recover the base URL.
2. Parse the base URL into:
   - **Origin**: `<scheme>://<authority>` of the URL (always `https` for production hosts on the allowlist; the dev path-based form may use `http://localhost:<port>`).
   - **Tenant slug** (optional): the first non-empty path segment of the base URL, present in the path-based dev form.
3. The proxy URL is `<origin>/api/push/llm/complete`.

The path is fixed; tenant routing is conveyed via headers, not via path interpolation.

If the API key does not yield a base URL (cannot be decoded, or the decoded metadata lacks a URL), the call fails before any HTTP I/O with an error instructing the user to regenerate the API key.

### Request

- Method: `POST`
- URL: `<origin>/api/push/llm/complete`
- Headers:

| Header             | Value                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `Content-Type`     | `application/json`                                                                                |
| `Authorization`    | `Bearer <jolliApiKey>` — the Jolli Space API key, sent verbatim.                                  |
| `x-jolli-client`   | `<surface-kind>/<surface-version>` — identifies the calling surface and its version.              |
| `x-tenant-slug`    | The tenant slug, if one was extracted from the base URL path or recovered from API-key metadata.  |
| `x-org-slug`       | The org slug from the API key's metadata, if present.                                             |
| `x-jolli-trace`    | The ambient trace context value. Always present: if no trace scope is active, a fresh standalone value is minted for this call. |

`x-tenant-slug` and `x-org-slug` are emitted only when their respective values are non-empty. The client header pair is built at compile time from the surface's own kind and version, so a hook installed by one surface (e.g., the editor extension) self-identifies as that surface, not as the embedded library.

- Body (JSON):

| Field      | Type                                  | Required | Notes                                                                                              |
| ---------- | ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `action`   | string                                | yes      | The template action key (e.g., `summarize`, `commit-message`, …); see spec 11 for the full list.    |
| `params`   | object of string-keyed values         | yes      | The placeholder values that the backend will substitute into the template it owns.                  |
| `version`  | integer                               | no       | A specific template revision to pin. See "Version selection" below.                                 |

The body **does not** carry a built prompt, a system prompt, a `messages` array, a `model` identifier, a `max_tokens` value, or a temperature. None of those are the client's concern on this path.

### Version selection

The `version` field on the payload is resolved at call time as follows:

1. If the caller explicitly passed a `version`, use it.
2. Otherwise, look up the action in the client's bundled template registry; if found, send the registry's pinned `version` for that action.
3. If neither is available (action unknown to the client's registry), omit the `version` field entirely. The backend then falls back to its own selection logic (its max-revision lookup).

### Response

On a 2xx response, the body is a JSON object. The caller consumes:

| Field          | Type            | Notes                                                                          |
| -------------- | --------------- | ------------------------------------------------------------------------------ |
| `text`         | string or absent| The completion text. Surfaced as-is to the caller (no client-side trimming).   |
| `inputTokens`  | integer         | Token count for input. Treated as `0` when absent or non-numeric.              |
| `outputTokens` | integer         | Token count for output. Treated as `0` when absent or non-numeric.             |

The result returned upstream from this layer also carries a measured `apiLatencyMs`. It does **not** carry a `model`, a `stopReason`, or any other LLM-provider-shaped metadata — those fields are explicitly absent on the proxy result, since the backend, not the client, owns the model selection.

### Timeouts

A single end-to-end request timeout of **180 seconds** is enforced via an abort signal. The timeout covers connect, TLS, headers, and full body transfer. There is no separate connect-vs-read split at this boundary.

There is no retry at this layer.

## Behavior

### Execution order

1. Receive call options carrying `action`, `params`, optional `version`, and the Jolli API key.
2. Decode the API key and parse its embedded base URL into origin + optional tenant slug; recover any org slug from the key metadata.
3. If no usable base URL is available, raise an error and stop.
4. Resolve the version field per the rules above.
5. Build the JSON body containing `action`, `params`, and the resolved `version` (when defined).
6. Issue `POST <origin>/api/push/llm/complete` with the headers above.
7. Wait for the response under the 180-second timeout.
8. On 2xx: parse the JSON and return `{ text, inputTokens, outputTokens, apiLatencyMs }`.
9. On non-2xx: read the response body as text, log a truncated copy with the status code, and raise an error containing the status code and a truncated body excerpt.

### Branches enumerated

- **API key cannot be decoded** → error before any HTTP I/O, instructing the user to regenerate the key.
- **2xx response, valid JSON** → success path; token counts default to `0` if absent.
- **Non-2xx response** → error carrying the status code and a truncated body excerpt; no retry, no per-status remapping.
- **Transport-layer failure** (DNS, TLS, connect refusal, reset, abort due to timeout) → the error name, message, flattened cause chain (name, message, code, errno, syscall, hostname, address, port — recursively across nested causes), elapsed milliseconds, request body character count, and action are logged; the original error is rethrown unchanged.

### Errors classified

| Class                | Trigger                                                                  | Outcome                                                                            |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Misconfigured key    | API key cannot yield a base URL.                                         | Pre-flight error: regenerate the API key.                                          |
| HTTP error           | Non-2xx response status.                                                 | Error embedding the numeric status code and a truncated response-body excerpt.     |
| Transport failure    | DNS / TLS / connect / reset / timeout abort before an HTTP status lands. | Original error rethrown; error name, cause chain, elapsed ms, and body size logged. |

There is no narrower remapping of HTTP statuses (e.g., 401 vs 426 vs 5xx) at this layer; all non-2xx outcomes flow through the single HTTP-error class.

## State Transitions

This call mutates no client-side state. The Jolli backend may persist its own state for billing and observability, but that is not visible at this boundary.

Tenant, org, and version selection are derived per call from inputs already present (the API key, the action registry, the caller-supplied version override). No cursor or session is maintained.

## Notable Behavior

- **Backend owns the template**: the client sends an `action` key plus `params`; the backend looks up the template, performs substitution, chooses the LLM provider, picks a model, sets `max_tokens`, and returns text + token counts. Bumping the prompt content does not require a client release; bumping the **shape** of the contract (action / params / version / response keys) does.
- **Backend owns the model**: the response carries no model identifier and no stop reason, intentionally. The client cannot pin a specific provider model on this path.
- **Version pinning is best-effort**: the client auto-injects the bundled template's `version` when known, and the backend falls back to its max-revision behavior when no version is sent.
- **Tenant routing via headers, not path**: the path is always `/api/push/llm/complete`. Tenant and org are dispatched via `x-tenant-slug` and `x-org-slug`. The path-based dev form (where the base URL has a leading path segment) sets the tenant header from that segment; subdomain-based production forms set the tenant header from the API key metadata when present.
- **Bearer authentication**: the proxy call uses `Authorization: Bearer <jolliApiKey>`. The direct provider path uses an entirely different header (`x-api-key`); the two are not interchangeable.
- **Surface self-identification**: the `x-jolli-client` header carries `<surface-kind>/<surface-version>` so the backend can apply per-surface minimum-version gates.
- **No streaming**: the proxy call is a single request/response; no streaming of partial text is supported at this boundary.
- **Single timeout covers everything**: the 180-second timeout is end-to-end. There is no separate read-after-headers idle timeout exposed at this boundary.

## Shared Behavior

- **HTTPS for production hosts**: the allowlist enforced upstream restricts production base URLs to `https`. The path-based dev form may resolve to a non-HTTPS localhost origin, but only because the API key origin allowlist permits this shape during development.
- **No client-side prompt building**: unlike the direct path, no template substitution happens client-side for the proxy call. The client carries the templates only to: (a) report a `version` to the backend, and (b) serve the direct path when an Anthropic credential is available.
- **No retry**: a single attempt per call, regardless of error class.
- **Same call interface**: the caller invokes the same dispatch entry as the direct path (`action`, `params`, optional `version`); the dispatcher chooses the path based on credentials. The caller cannot force the proxy path other than by withholding direct credentials (or, on the IntelliJ surface, by setting the explicit `aiProvider` override — see spec 10).
