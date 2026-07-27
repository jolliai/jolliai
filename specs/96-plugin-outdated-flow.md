# 96. Plugin Outdated Flow

## Topic Statement

Surface a "plugin outdated" failure from the Jolli backend when the server rejects a request because the calling product version is below the server-enforced minimum, by mapping `HTTP 426` to a typed error whose user-facing message is the server-supplied explanation, with no automatic retry.

## Scope

**In scope:**

- The HTTP failure shape that triggers the plugin-outdated mapping (`426` from any of the Jolli Memory endpoints the client uses).
- The header by which the server identifies the calling product and version (`x-jolli-client`).
- The fallback message used when the server omits a textual explanation.
- The retry policy on `426` (none) and how the user is expected to recover (upgrade).

**Out of scope (boundaries):**

- The exact wording, version number, or release-channel link inside the server's `message` — that comes from the server response and is surfaced verbatim.
- The minimum-version policy itself (which versions are gated, how the server picks the floor); that is server-side.
- Other status-code mappings on the same endpoints (`412`, `409`, generic non-2xx); see **Summary Push to Jolli Space** and **Binding Required Flow**.
- The mechanism by which the user actually upgrades the product (marketplaces, package managers, CI updaters).
- The `x-jolli-client` header construction itself; see **Summary Push to Jolli Space**.

## Data Contracts

### Trigger: the `426` response

| Property              | Value                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Status                | `426`                                                                                                                                |
| Response body shape   | A JSON object whose `message` field, when present and a string, is the user-facing explanation. Other fields (e.g. `error`) are ignored by this mapping. |
| Surfaces that map it  | The push call (`POST /api/push/jollimemory`), the list-spaces call (`GET /api/jolli-memory/spaces`), and the register-binding call (`POST /api/jolli-memory/bindings`). All three return `426` under the same minimum-version policy and all three are mapped through the same plugin-outdated path. |

The client gates its own product version via the `x-jolli-client: <kind>/<version>` request header. The server is the actor that decides the version is too old; the client's role is the mapping and the user-facing surface.

### Fallback message

When the response body is not a JSON object, or `message` is missing or not a string, the client emits the fallback:

```
Plugin version is outdated. Please update to the latest version.
```

When `message` is present and a string, that value is surfaced verbatim. The server is expected to name the minimum supported version inside `message` (what version is required, optionally how to upgrade); the client does not parse those fields out — the message is treated as opaque human text.

### Typed error

The mapping produces a typed error class so the calling surface (a webview, a status bar, a notification) can branch on it without parsing strings. The error carries the resolved message (server-supplied or fallback). It is distinguishable from generic non-2xx failures and from binding-required failures by name/type alone.

## Behavior

### Map the response

1. Read the full response body.
2. Attempt to parse it as JSON. If parsing fails, emit the typed error with the fallback message. (A `426` whose body does not parse is unusual but not exceptional; the client must still surface "plugin outdated".)
3. If `message` is a string, emit the typed error carrying that exact string.
4. Otherwise, emit the typed error carrying the fallback message.

### Surface to the user

1. The caller catches the typed plugin-outdated error and shows its message to the user.
2. The user is invited to upgrade the product. The mapping does not specify the upgrade UX (marketplace deep-link, dialog button, or plain text); that is the surface's choice. The contract is only the error type and message.
3. The caller does **not** automatically retry. A retry against the same server with the same product version would fail again identically.

## State Transitions

A `426` is terminal for the in-flight call. The single-attempt RPC resolves into the typed plugin-outdated error and is not re-issued. If the user upgrades and re-triggers the operation, the new request is a fresh single-attempt RPC; this spec does not retain any state across attempts.

## Notable Behavior

- **The version gate is server-driven, not client-driven.** The client sends `x-jolli-client: <kind>/<version>` on every request and lets the server decide whether that version is acceptable. The client never compares its own version to anything locally for this purpose. (Notable.)
- **The product portion of `<kind>/<version>` matters.** The server applies the minimum-version policy per product (CLI, editor extension, JVM IDE plugin), so an upgrade of one surface does not unblock another. The mapping uses whichever value the calling product sends. (Notable.)
- **The version on `x-jolli-client` is the build-time product version.** It is not parsed from a runtime command and is not user-configurable. The JVM IDE plugin reads its version from a classpath resource baked in at build time and falls back to `0.0.0` when the resource is missing — which intentionally fails any minimum-version gate so a build/packaging mistake surfaces loudly instead of silently shipping a misleading version string. (Notable; defensive.)
- **No automatic retry.** A retry would fail identically until the user upgrades. The mapping fails fast. (Notable.)
- **`message` is treated as opaque human text.** The client does not parse the minimum supported version out of it; it surfaces the server's wording as-is. This keeps the policy editable on the server without a client release. (Notable.)
- **The same `426` mapping covers three endpoints.** The push call, the list-spaces call, and the register-binding call all funnel `426` through this path. A single user-facing experience covers them. (Notable.)
- **Three implementations exist.** The CLI, the editor extension, and the JVM IDE plugin each carry their own copy of this mapping. They agree on: the `426` trigger; the typed-error shape; the fallback message; the no-retry policy. The JVM IDE port maps `426` only on the push (the LLM-proxy path on that surface routes `426` through its generic non-2xx error path instead of the typed plugin-outdated one). (Notable parity facts.)

## Shared Behavior

- The `x-jolli-client` header (its format `<kind>/<version>` and when it is sent) is defined by **Summary Push to Jolli Space**.
- The `412` binding-required mapping that lives alongside this `426` mapping on the same response handler is defined by **Binding Required Flow**.
- The `409 binding_already_exists` mapping that lives alongside this `426` mapping on the binding endpoints is defined by **Binding Required Flow**.
- The push endpoint, headers, and body that carry the `x-jolli-client` value are defined by **Summary Push to Jolli Space**.
