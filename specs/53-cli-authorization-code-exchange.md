# 53. CLI Authorization Code Exchange

## Topic Statement

Trade a single-use authorization code for a fresh OAuth session token (and an optional newly-minted product API key) by issuing one bounded HTTPS POST to the Jolli backend, mapping every failure mode to a user-facing error message so the caller can surface it directly.

## Scope

**In scope:**

- The HTTP endpoint, method, headers, and request body used for the exchange.
- The expected response body shape.
- The end-to-end timeout, what it covers, and how it surfaces.
- The mapping from network and HTTP failure modes to user-facing error messages.
- The single-use guarantee that the code is destroyed by the server side after redemption.
- Pre-request re-validation of the Jolli origin against the allowlist.
- Tenant-routing behavior for path-based vs subdomain-based tenant URLs.

**Out of scope (boundaries):**

- How the authorization code is generated, transported to the user's machine, or shaped (those concerns live in the calling browser-login flow and on the server).
- The browser-launch and callback-listening half of the OAuth flow (covered by **OAuth Browser Login Flow**).
- The structure and parsing of the product API key that may appear in the response (covered by **Jolli API Key Format and Parsing**).
- The allowlist itself (covered by **Jolli Origin Allowlist Enforcement**) — only the call to the allowlist check at the entry point is described here.
- The on-disk save of the returned credentials (covered by **Auth Credential Storage**).

## Data Contracts

### Endpoint

| Property        | Value                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Method          | `POST`                                                                                                                           |
| Path            | `/api/auth/cli-exchange`                                                                                                         |
| Mounted on      | The origin (host + port + scheme), regardless of whether the saved Jolli URL has a tenant path prefix.                           |
| Scheme          | `https://` only — guaranteed by the allowlist check that runs on the input URL before the request is built.                      |

### Request headers

| Header           | Value                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `content-type`   | `application/json`                                                                                               |
| `x-tenant-slug`  | The first path segment of the input Jolli URL, when present. Omitted when the URL is subdomain-based.            |

### Request body (JSON)

A single field:

| Field   | Type   | Notes                                                                                          |
| ------- | ------ | ---------------------------------------------------------------------------------------------- |
| `code`  | string | The single-use authorization code received on the OAuth callback (a 32-byte hex value in practice). |

### Response body (JSON)

Returned on a `2xx` status. Fields:

| Field          | Type   | Required | Notes                                                                                                |
| -------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `token`        | string | yes      | Non-empty session token. Absence or non-string value is a failure.                                   |
| `jolliApiKey`  | string | no       | Newly-minted product API key, present only when the login URL had requested one. Empty string is treated as absent. |
| `space`        | string | no       | Space identifier the user is signed into. Empty string is treated as absent.                         |

Any unrecognized fields are ignored.

### Timeout

| Property | Value     |
| -------- | --------- |
| Bound    | 20 seconds end-to-end on the entire POST. |
| Source   | An abort signal armed at request build time. |

The timeout exists because the backend's role is just to read a single-use code from a short-lived store and return the issued token; without a bound, a half-open socket would leave the calling thread hung indefinitely with no user-facing way to abort.

### Error-mapping table

Every failure mode is converted to an `Error` with a user-facing message so callers can surface it without having to map status codes themselves:

| Failure mode                                                                  | User-facing message                                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Abort due to the 20-second timeout                                            | "Sign-in timed out after 20s waiting for Jolli. Please try again."                            |
| Any other transport-level failure (DNS, connection refused, TLS, etc.)        | "Couldn't reach Jolli to complete sign-in: `<underlying message>`"                            |
| HTTP `404`                                                                    | "Sign-in code expired or already used. Please try signing in again."                          |
| Any other non-2xx status                                                      | "Sign-in failed (HTTP `<status>`). Please try again."                                         |
| Response body is not valid JSON                                               | "Sign-in failed: server returned malformed response (`<underlying message>`)."                |
| `token` field missing, non-string, or empty                                   | "Sign-in failed: server response did not include a token."                                    |

### Result

The function returns:

```
{
  token:        <non-empty string>,
  jolliApiKey?: <non-empty string>,
  space?:       <non-empty string>,
}
```

Optional fields are present only when the server returned a non-empty string for them.

## Behavior

### Pre-request guards

1. Run the origin-allowlist check against the supplied Jolli URL. A mismatch throws synchronously and the request is never issued. (A long-lived process could otherwise hold a stale, off-allowlist value.)
2. Parse the URL into origin and optional tenant slug.

### URL and headers

3. Build the target URL by joining the parsed origin with `/api/auth/cli-exchange`. The tenant path prefix (if any) is *not* repeated in the URL — the route is mounted at the origin.
4. Compose headers: always `content-type: application/json`; include `x-tenant-slug: <slug>` only when the parsed URL had a path segment that yielded a tenant slug.

### Request issue

5. Build the JSON body `{ "code": "<code>" }`.
6. Issue the POST with the abort signal armed at 20 seconds.
7. **Network-error branch.** If the fetch fails, classify:
   - If the failure is a timeout-class failure (the abort signal fired), surface the timeout-specific message.
   - Otherwise, wrap the underlying message into the "couldn't reach Jolli" prefix and surface it.

### Response handling

8. **HTTP 404.** Throw "Sign-in code expired or already used. Please try signing in again." This single status maps to that message because the backend deletes the code on first read; a second read sees no record and returns `404`.
9. **Any other non-OK status.** Throw "Sign-in failed (HTTP `<status>`). Please try again." This includes 4xx other than 404 (typically because the backend rejected something other than the code's existence) and any 5xx.
10. **2xx parsing.** Read the response body as JSON. A JSON-parse error is wrapped as the malformed-response message.
11. **Token presence.** Reject if `token` is absent, not a string, or empty. The error message is fixed (does not echo any partial server output).
12. **Field selection.** Project the response to `{ token, jolliApiKey?, space? }`, including `jolliApiKey` only when the server returned a non-empty string, and similarly for `space`.

### Single-use guarantee

The single-use property is a server-side invariant: the backend deletes the code from its short-lived store on first read. Two consequences are visible to the client:

- A successful exchange cannot be retried. A second POST with the same code returns `404` and surfaces "Sign-in code expired or already used."
- A failed exchange (network error before the server processed the request) may be retryable; an exchange whose response was lost in transit is not.

Clients do not retry automatically. The user retries the entire sign-in flow.

### Tenant routing

Two forms of tenant URL are supported:

- **Subdomain-based** (e.g. `https://app.jolli.ai`). The path is empty; no `x-tenant-slug` header is sent. The backend identifies the tenant from the subdomain.
- **Path-based** (e.g. `https://jolli-local.me/dev`). The first path segment becomes the `x-tenant-slug` header value. The path itself is *not* preserved in the request URL — the route is mounted at the origin.

This pattern is shared with other Jolli HTTP routes (push and LLM proxy).

## State Transitions

This is a single request-reply with no client-side state to track. From the server's perspective:

- **Code present in store** → **Code consumed**: triggered by a successful read on this endpoint. The code is removed from the store before the response is returned, so the same code can never be redeemed twice.
- **Code consumed** (or never present) → **Code consumed**: subsequent reads observe absence and return `404`.

There is no idle / pending / resolved client state — the function either returns the credentials or throws. The caller is responsible for any retry decision.

## Notable Behavior

- **The 20-second timeout is end-to-end, not per-leg.** A long TLS handshake, a slow server response, and the JSON read all share the budget. The timeout is generous because the backend's job is just a store lookup; the bound exists to prevent indefinitely hung sockets, not to enforce strict latency. (Notable.)
- **HTTP 404 has its own message.** All other non-2xx statuses share a single generic message; only `404` gets the "expired or already used" wording, because that status uniquely identifies a redeemed-or-missing code on this endpoint. (Surprising.)
- **The origin allowlist is re-checked at the entry point of this function.** The save-time check prevents an off-allowlist URL from being persisted, but a long-lived process could be holding an in-memory URL that was valid at save time and has since been mutated. Re-checking here closes that gap. (Notable, defensive.)
- **Tenant slug travels in a header, not in the path.** Even when the saved URL is path-based, the exchange request URL is `<origin>/api/auth/cli-exchange` (not `<origin>/<slug>/api/auth/cli-exchange`). The slug rides as `x-tenant-slug`. This matches the convention used by the other Jolli HTTP routes. (Notable.)
- **Empty strings on optional fields are treated as absent.** A response of `{ token: "tok", jolliApiKey: "" }` returns `{ token: "tok" }` with no `jolliApiKey` set. Callers therefore cannot distinguish "server returned empty" from "server omitted the field" — and no caller has reason to. (Notable.)
- **Every failure surfaces a failure with a user-facing message.** No status codes, no surfaced HTTP failures, no opaque error codes. Callers (the loopback callback handler and the deep-link URI handler) propagate the message into the rendered error page or surfaced UI dialog without further mapping. (Notable.)
- **Error messages do not echo server output.** Status-mapped messages and the missing-token message are fixed strings; only the malformed-JSON message and the network-error message embed the underlying `<message>`. This bounds the surface for an attacker-controlled origin to inject text into the user's UI. (Notable, defensive.)
- **One implementation exists.** The exchange routine is the implementation shared by the CLI loopback callback and the editor-extension deep-link URI handler. There is no JVM port — the JVM IDE plugin uses the legacy token-in-URL callback shape and therefore never reaches this endpoint. (Notable parity fact.)

## Shared Behavior

- The browser-launch and callback-listener that produce the authorization code given to this routine are defined by **OAuth Browser Login Flow**.
- The shape and parsing of the `jolliApiKey` field that may appear in the response are defined by **Jolli API Key Format and Parsing**.
- The allowlist that gates the input Jolli URL is defined by **Jolli Origin Allowlist Enforcement**.
- The atomic save of the returned `{ token, jolliApiKey? }` is defined by **Auth Credential Storage**.
