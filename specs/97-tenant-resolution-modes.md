# 97. Tenant Resolution Modes

## Topic Statement

Resolve a saved Jolli site URL to the `(origin, tenantSlug)` pair that all backend calls use, by reading the URL's pathname: a non-empty first path segment is the tenant slug (path-based form), and an absent path segment leaves the tenant slug undefined and lets the server resolve the tenant from the host (subdomain-based form).

## Scope

**In scope:**

- The two URL shapes the parser accepts (path-based and subdomain-based) and how each maps to the internal `(origin, tenantSlug)` pair.
- The exact rule for "first path segment" — leading and trailing slashes, multi-segment paths, percent-encoding boundary.
- How the resolved pair drives header emission on outbound calls (`x-tenant-slug` is sent only when `tenantSlug` is defined).
- Behavior on a malformed URL (one that the URL parser refuses).
- Why the same parser produces both forms — so callers don't branch on URL shape themselves.

**Out of scope (boundaries):**

- The HTTPS host allowlist (`jolli.ai`, `jolli.dev`, `jolli.cloud`, `jolli-local.me`); that is **Jolli Origin Allowlist Enforcement**.
- The `x-org-slug` header, which is sourced from the API key payload's `o` field — not from the URL — and is therefore independent of this spec.
- The endpoints that use the resolved pair (`/api/push/jollimemory`, `/api/jolli-memory/spaces`, `/api/jolli-memory/bindings`); see **Summary Push to Jolli Space** and **Binding Required Flow**.
- The product API key parser; see **Jolli API Key Format and Parsing**.
- The OAuth login URL composition, which uses the resolved origin but does not need the tenant slug.

## Data Contracts

### Internal pair

The parser produces a single internal record so callers do not branch on URL shape:

| Field        | Type                | Meaning                                                                                                            |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `origin`     | string              | Scheme + host + port. No path, no query, no fragment. Always present.                                              |
| `tenantSlug` | string \| undefined | The first non-empty path segment of the input URL, if any. `undefined` when the path is empty / `/` / all-slashes. |

### Resolution rule

| Input URL example                    | `origin`                          | `tenantSlug` | Form           |
| ------------------------------------ | --------------------------------- | ------------ | -------------- |
| `https://acme.jolli.ai`              | `https://acme.jolli.ai`           | `undefined`  | Subdomain-based |
| `https://acme.jolli.ai/`             | `https://acme.jolli.ai`           | `undefined`  | Subdomain-based |
| `https://jolli.ai`                   | `https://jolli.ai`                | `undefined`  | Subdomain-based (apex; tenant resolved server-side from key/headers) |
| `https://jolli-local.me/acme`        | `https://jolli-local.me`          | `acme`       | Path-based     |
| `https://jolli-local.me/acme/`       | `https://jolli-local.me`          | `acme`       | Path-based     |
| `https://jolli-local.me/acme/extra`  | `https://jolli-local.me`          | `acme`       | Path-based (only the **first** segment is the slug — extra segments are ignored) |
| `https://jolli-local.me/`            | `https://jolli-local.me`          | `undefined`  | Subdomain-based form (no path segments) |

The two forms produce the same internal pair shape so all callers see one type. Callers do not branch on which form was used; they only branch on whether `tenantSlug` is defined.

### Header emission downstream

| Header          | Sent when                                                                              |
| --------------- | -------------------------------------------------------------------------------------- |
| `x-tenant-slug` | `tenantSlug !== undefined`. The header carries the slug verbatim.                      |
| (omitted)       | `tenantSlug === undefined`. The server resolves the tenant from the request host.      |

### Origin

`origin` is exactly the scheme, host, and (if present) explicit port of the input. The path, query, and fragment are dropped. This is the value used to build absolute endpoint URLs (`<origin>/api/push/jollimemory`, `<origin>/api/jolli-memory/spaces`, etc.).

## Behavior

### Parse the URL

1. Construct a URL object from the input string. If construction throws (malformed URL), the call propagates the parser's error to the caller. There is no "best-effort" recovery — a malformed URL is rejected at the boundary.
2. Read `origin` from the parsed URL. This includes scheme, host, and explicit port. (Default ports for the scheme are not added explicitly to `origin`.)
3. Read the pathname. Trim leading slashes, trim trailing slashes, then split on `/` and drop empty segments. The result is an array of zero or more non-empty path segments.
4. If the array has at least one element, `tenantSlug` is the **first** element. Subsequent elements are ignored — only the first segment is the slug.
5. If the array is empty, `tenantSlug` is `undefined`.

### Use the resolved pair

1. Build absolute endpoint URLs by joining `origin` with the endpoint path (`/api/push/jollimemory`, etc.).
2. Compose request headers. When `tenantSlug` is defined, add `x-tenant-slug: <tenantSlug>`. When undefined, omit the header — the server resolves the tenant from the host.
3. The same `(origin, tenantSlug)` pair drives every backend call from the same saved URL: push, list-spaces, register-binding, deletion.

### Malformed URL

If the URL parser throws when given the input string, no `origin` and no `tenantSlug` are produced. The error is surfaced to the caller as a parsing failure. The caller is responsible for handling the error (e.g. by failing the operation with a user-facing message). This spec does not invent a fallback origin or default tenant.

## State Transitions

This is a stateless transformation. The same input always produces the same output (or the same error). There are no persisted intermediate states.

## Notable Behavior

- **The same parser produces both forms.** Callers receive a uniform `(origin, tenantSlug)` pair regardless of which form the saved URL uses. They never have to branch on URL shape — only on whether the slug is defined. (Notable.)
- **Only the first path segment is the slug.** Multi-segment paths like `/acme/extra` resolve to `tenantSlug = "acme"`; the remaining segments are silently ignored. There is no `tenantPath` or multi-level tenant. (Notable.)
- **Path-based vs subdomain-based is determined entirely by the path component.** A URL whose host has multiple labels (`acme.jolli.ai`) is **not** automatically treated as subdomain-based by the parser — the parser does not inspect the host. The host's role in tenant resolution is a server-side concern; the client only sends `x-tenant-slug` when the path carries one. (Surprising; intentional.)
- **No host allowlist enforcement here.** The allowlist (`jolli.ai`, `jolli.dev`, `jolli.cloud`, `jolli-local.me` and HTTPS-only) is enforced at the save-time of the URL — not by this parser. By the time a saved URL reaches this resolver it has already been screened. The resolver therefore happily parses any well-formed URL, including ones outside the allowlist. (Notable; the security boundary is elsewhere.)
- **`origin` does not include trailing slash and never carries a path.** Endpoint URLs are built by joining `origin` + the absolute endpoint path. (Notable.)
- **Default ports are not added to `origin`.** A URL with no explicit port resolves to an `origin` without one; the URL parser is responsible for canonicalization. (Notable.)
- **A path of `/` resolves to `tenantSlug = undefined`.** Trimming leading and trailing slashes leaves the empty string, which the empty-segment filter drops. The filter is therefore the load-bearing detail that distinguishes "no tenant on the path" from "empty-string tenant on the path". (Notable.)
- **The caller always passes the resolved slug when present.** Even when the bearer is an OAuth token (no API key), `x-tenant-slug` is sourced from the URL and sent. The slug is independent of the bearer. (Notable.)
- **Parity:** The CLI, the editor extension, and the JVM IDE plugin each implement this resolution. They agree on: the URL → `(origin, tenantSlug)` mapping; first-segment-only semantics; trimming both leading and trailing slashes; the malformed-URL throw. The JVM IDE port uses the JVM URI parser (which leaves `origin` synthesised from `<scheme>://<authority>`) where the others use the language URL parser, but the produced pair is byte-equivalent for any URL that the allowlist would accept. (Notable parity facts.)

## Shared Behavior

- The HTTPS host allowlist that screens a saved URL **before** it reaches this resolver is defined by **Jolli Origin Allowlist Enforcement**.
- The product API key payload that contributes the `o` org slug for the `x-org-slug` header (independent of this resolver) is defined by **Jolli API Key Format and Parsing**.
- The endpoints that consume the resolved pair to build absolute URLs are defined by **Summary Push to Jolli Space** and **Binding Required Flow**.
