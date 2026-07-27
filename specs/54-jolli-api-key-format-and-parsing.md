# 54. Jolli API Key Format and Parsing

## Topic Statement

Decode a product API key whose payload encodes the tenant URL, the tenant slug, and an optional organization slug, by stripping a fixed prefix and scanning the dot-delimited segments for the first one that base64url-decodes to a JSON object containing the required string fields.

## Scope

**In scope:**

- The fixed prefix that identifies a key as a product API key.
- The two dot-delimited shapes the payload may take.
- The fields encoded in the payload and which are required.
- The decoding algorithm: base64url-decode, JSON-parse, validate field types.
- The error classification: which inputs return null vs. surface a failure on validation.
- The save-time validation entry point that wraps decoding plus origin-allowlist enforcement.
- The two-implementation parity (canonical port and JVM IDE port) and the one decoding behavior they differ on.

**Out of scope (boundaries):**

- The allowlist that the embedded tenant URL is checked against (covered by **Jolli Origin Allowlist Enforcement**).
- The HTTP exchange that mints a fresh key (covered by **CLI Authorization Code Exchange**).
- The on-disk storage of the saved key (covered by **Auth Credential Storage**).
- The runtime use of a parsed key (Bearer-header construction, tenant-routing headers, LLM proxy URL resolution) — those are downstream consumers that cache the parsed payload returned by this layer.

## Data Contracts

### Prefix

A fixed lowercase string: `sk-jol-`. Inputs that do not start with this prefix are not product API keys and decoding returns null (the call does not surface a failure).

### Payload shapes

After stripping the prefix, the remainder is one or more dot-delimited segments. Three shapes exist:

| Shape       | Pattern                                       | Decoder behavior                                                                                                |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Old (legacy) | `sk-jol-<32 hex chars>` — no dot.             | Decoder returns null. The key is not a "new format" key and carries no embedded metadata.                       |
| Format A     | `sk-jol-<metaB64>.<secretB64>` — one dot.     | Meta is in segment 0. Decoder finds it on the first scanned segment.                                            |
| Format B     | `sk-jol-<headerB64>.<payloadB64>.<sigB64>` — two dots (JWT-shaped). | Meta is in segment 1. Decoder skips segment 0 (which decodes to a JWT header, not the meta object) and finds it on segment 1. |

The decoder does not know in advance which shape it has — it scans segments and returns the first one whose base64url-decoded UTF-8 content parses as a JSON object containing the required string fields. The "no dot" case short-circuits to null without scanning, because there are no segments to inspect after the prefix.

### Payload fields

The decoded JSON object carries:

| Field | Type   | Required | Meaning                                                                                  |
| ----- | ------ | -------- | ---------------------------------------------------------------------------------------- |
| `t`   | string | yes      | Tenant identifier (used downstream as the `x-tenant-slug` header value for path-based tenants). |
| `u`   | string | yes      | Site base URL (e.g. `https://example.jolli.dev` or `https://jolli.ai/acme`). Used downstream to resolve the request origin and tenant slug. |
| `o`   | string | no       | Organization slug (used downstream as the `x-org-slug` header for multi-org routing). Older keys do not include this field. |

Other fields in the JSON object are ignored.

### Decoded result

```
JolliApiKeyMeta {
  t: string,
  u: string,
  o?: string,
}
```

The result is null when the input is not a parseable product API key (wrong prefix, no dot, no segment decoded to a valid meta object).

### Save-time validation contract

A second entry point, used at every save site, combines decoding with origin-allowlist enforcement:

1. Decode the key. If decoding returns null, the call fails with a fixed user-facing error message (no echo of the input).
2. Run the origin-allowlist check on the decoded `u`. A failure surfaces the allowlist's error message.

There are exactly two reasons the save-time validator fails: undecodable key, or decoded key whose embedded URL is not on the allowlist.

## Behavior

### Prefix check

1. If the input does not start with `sk-jol-`, return null.
2. Strip the prefix.

### Old-format short-circuit

3. If the remainder contains no `.`, return null. (The legacy 32-hex format carries no embedded metadata, so there is nothing to decode.)

### Segment scan

4. Split the remainder on `.` into segments.
5. For each segment in order:
   - Attempt to decode it as base64url, then as UTF-8 text, then parse the text as JSON.
   - If the result is an object with both `t: string` and `u: string`, build the meta object (including `o: string` when present and a string), and **return it immediately**.
   - On any decode/parse error or on a successful parse that fails the field-type check, advance to the next segment.
6. If no segment yields a valid meta object, return null.

### Save-time validation

When called from a save path (sign-in callback, `configure --set jolliApiKey`, settings UI):

1. Run the decoder.
2. If the result is null, the call fails with "Rejected Jolli API key: cannot be decoded. Paste the key exactly as issued by Jolli." (Fixed text; no echo of the supplied key.)
3. Run the allowlist check on the decoded `u`. The allowlist check surfaces its own message on rejection.

### One-shot caching

Callers do not re-decode a key on each use. A typical downstream caller (push, LLM proxy) decodes the saved key once at the top of a request handler and reads `t`, `u`, and `o` from the cached result. The decoder is pure (no I/O) and idempotent.

## State Transitions

There is no in-process state. The decoder is a pure function from string input to either a meta object or null. The save-time validator is the same function plus a side-effect-free allowlist check (which itself is a pure function from URL to either return or surface a failure).

A key's lifecycle has two relevant states from this layer's perspective:

- **Undecoded.** The on-disk or in-memory string. The product treats this as opaque until it needs to issue a request.
- **Decoded.** The meta object cached for the duration of an operation. Downstream callers consume this and never re-derive it from the raw string within the same operation.

The transition is one-way and per-operation.

## Notable Behavior

- **Prefix mismatch returns null rather than surfacing a failure.** The decoder is used both at save sites (where a null result is converted to a surfaced user-facing error) and on the request path (where a null result simply means "no embedded metadata, fall back to a separately configured base URL"). Distinguishing these by null vs. surfaced failure lets the same decoder serve both. (Surprising; intentional.)
- **The legacy no-dot format also returns null.** A 32-hex legacy key is a *valid* key the server still accepts — it just has no embedded metadata. The decoder returning null for it lets downstream callers fall back to a separately configured base URL when one is set. (Surprising; intentional.)
- **The decoder scans segments rather than fixing on a specific index.** Format A puts meta in segment 0; format B (JWT-shaped) puts meta in segment 1. Scanning lets one decoder cover both shapes without a version probe. A side effect is that the allowlist check (run by the save-time validator on `u`) applies to *whichever* segment carried the meta, so a key whose claimed `u` is off-allowlist is rejected regardless of which segment the format puts it in. (Notable, defensive.)
- **A segment that is valid base64url but not a JSON object is silently skipped.** This includes the JWT header in format B (which decodes to `{"alg":"HS256","typ":"JWT"}` — no `t`/`u` fields, so the decoder advances to segment 1). Errors during decode/parse never propagate from inside the scan; they only cause the loop to continue. (Notable.)
- **Non-string `t` or `u` fails the type check and falls through.** A JSON object whose `t` is a number does *not* satisfy the contract. The scan continues; if no later segment yields a valid object, the decoder returns null. (Notable, defensive.)
- **`o` is opportunistically lifted.** If the validated meta object has `o: string`, it is included on the result; otherwise the result has no `o` property. Older keys predate this field and decode without it. (Notable.)
- **The save-time error message is fixed and does not echo the input.** "Rejected Jolli API key: cannot be decoded. Paste the key exactly as issued by Jolli." This avoids leaking partial parse state to the user and avoids reflecting attacker-supplied content into the UI. (Notable, defensive.)
- **Two implementations exist.** A canonical port (used by the CLI and editor extension) and a JVM IDE port (used by the JVM IDE plugin). They diverge on one decoding behavior: the canonical port scans **all** dot-delimited segments and returns the first one whose decoded JSON satisfies the contract; the JVM IDE port only inspects the **first** segment and returns null if that segment is not a valid meta. As a consequence, the JVM IDE port supports format A but not format B. The IntelliJ-emitted keys are format A in practice, so this divergence is currently invisible at runtime, but it is a known parity gap. (Surprising; intentional.)
- **The save-time validator is the only place where decoding plus allowlist checking happen together.** Callers that decode a key on the request path (push, LLM proxy) do *not* re-run the allowlist; they trust the save-time check that ran when the key was persisted. (Notable.)
- **Both the decoder and a companion origin/tenant-slug helper are re-exported as part of the plugin-facing API surface.** The decoder (`parseJolliApiKey`-equivalent) gives plugin code access to the decoded `t`, `u`, and (when present) `o` from a saved key without re-implementing the prefix + segment-scan + base64url + JSON + field-type-check sequence. The companion helper takes the decoded `u` (or any saved base URL) and parses it into an HTTPS origin plus the optional path-based tenant slug — i.e. the same `(origin, tenantSlug)` derivation defined by **Tenant Resolution Modes**. Re-exposing both lets a plugin compose a tenant-routed request URL from a saved key alone. The host's save-time allowlist check still applies to every persisted key, so the `u` plugin code reads back is already known-allowlist-valid for the host; plugins with a wider allowlist run their own boundary check. (Notable.)

## Shared Behavior

- The allowlist applied to the decoded `u` (HTTPS-only, suffix-boundary host check, fixed list of permitted hosts) is defined by **Jolli Origin Allowlist Enforcement**.
- The endpoint that mints a fresh key whose payload conforms to this contract is described by **CLI Authorization Code Exchange**.
- The on-disk persistence of a validated key (and the env-var-fallback rules at read time) is defined by **Auth Credential Storage**.
- The browser-side flow that delivers a freshly-minted key to the client is defined by **OAuth Browser Login Flow**.
