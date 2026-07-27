# 55. Jolli Origin Allowlist Enforcement

## Topic Statement

Refuse to save any Jolli URL whose host is not on a fixed allowlist of approved domains over HTTPS, so a socially-engineered or attacker-controlled URL cannot be persisted as a credential target and later leak the user's session token to an unauthorized host.

## Scope

**In scope:**

- The fixed list of allowlisted host suffixes.
- The HTTPS-only requirement and how it composes with the host check.
- The suffix-boundary host check that prevents `<allowed>.<attacker>` style bypasses.
- The set of save-time call sites that gate persistence on this check.
- The save-time-only doctrine: where this check runs and where it deliberately does not.
- The failure mode (refuse to save, surface a fixed user-facing error) and what it preserves about the trusted state.
- Two implementations (canonical port and JVM IDE port) and their parity gap.

**Out of scope (boundaries):**

- The HTTPS endpoint that the saved URL is later used for (covered by **CLI Authorization Code Exchange**, plus the push and LLM-proxy specs).
- The format of the product API key whose embedded URL is one of the inputs to this check (covered by **Jolli API Key Format and Parsing**).
- The on-disk storage layer that holds the validated URL (covered by **Auth Credential Storage**).
- The browser-launch flow that uses the validated URL to compose the login page URL (covered by **OAuth Browser Login Flow**).

## Data Contracts

### Allowlist

A fixed array of host suffixes:

| Suffix             |
| ------------------ |
| `jolli.ai`         |
| `jolli.dev`        |
| `jolli.cloud`      |
| `jolli-local.me`   |

The allowlist is a compile-time constant in the canonical port. Adding or removing an entry requires a code change.

### Acceptance predicate

For an input URL to be accepted, **all** of the following must hold:

1. The URL parses as a valid URL.
2. Its protocol is exactly `https:`. Plain HTTP is refused even for hosts on the allowlist.
3. Its host is non-empty.
4. Its host (lowercased) either:
   - Equals one of the allowlist entries exactly, **or**
   - Ends with `.` followed by an allowlist entry (the suffix-boundary check).

The host comparison is case-insensitive (input is lowercased before comparison).

### Suffix-boundary semantics

The boundary check requires a literal dot before the allowlist entry. A bare suffix match (i.e. "string ends with `jolli.ai`") would let `jolli.ai.attacker.com` pass — that input is explicitly forbidden. The accepted patterns for `jolli.ai` are:

- `jolli.ai` (exact match)
- `<anything>.jolli.ai` (subdomain)

The forbidden patterns include:

- `jolli.ai.attacker.com` (allowlist entry as a non-suffix substring)
- `evil-jolli.ai` (allowlist entry as a suffix without the boundary dot)
- `JOLLI.AI` only without lowercasing — the implementation lowercases first, so the user-facing behavior is case-insensitive.

### Failure mode

| Failure                  | Outcome                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Unparseable URL          | Throws `Rejected Jolli origin (unparseable): <input>`.                                                        |
| Wrong protocol or host   | Throws `Rejected Jolli origin "<parsed origin>". Only https://*.jolli.ai, https://*.jolli.dev, https://*.jolli.cloud, and https://*.jolli-local.me are permitted.` |

A throw at a save site refuses the save: nothing is persisted, the in-memory pending state (if any) is cleared by the caller, and the previously trusted state on disk is untouched. The trusted state never becomes tainted by an attempted save of an off-allowlist value.

## Behavior

### Save-time call sites

The check is invoked at every place where a Jolli URL is about to enter a trusted boundary:

1. **OAuth callback save.** The browser-login flow validates the configured Jolli URL before composing the outbound login page URL and again before issuing the code-exchange POST. (See **OAuth Browser Login Flow** and **CLI Authorization Code Exchange**.)
2. **`configure --set jolliUrl`.** Before persisting a user-supplied URL via the CLI configuration command. The same command path also runs the API-key validation when `--set jolliApiKey` is used, which itself includes this check on the embedded `u`.
3. **Settings UI save.** Before persisting a URL the user typed into the editor extension's settings panel.
4. **`JOLLI_URL` env var at read time.** When the resolver reads `JOLLI_URL` (or falls back to the default Jolli URL) during a process startup, it runs the check on the resolved value. A long-lived process that started without `JOLLI_URL` set, then had it injected by an attacker into the environment, would still go through the resolver on subsequent reads and fail-closed before any request is built.
5. **API-key save (indirect).** The save-time validator for the product API key decodes the key, then runs this check on the decoded `u`. So pasting an off-allowlist API key is also refused at save.

### Algorithm

Given an input string:

1. Try to parse the string as a URL. If parsing fails, throw the "unparseable" message containing the original input.
2. Lowercase the parsed `hostname`.
3. Compute the predicate:
   - `protocol === "https:"` AND
   - `host !== ""` AND
   - some allowlist entry `e` satisfies `host === e || host.endsWith("." + e)`.
4. If the predicate holds, return without throwing.
5. Otherwise, throw the "rejected" message containing the parsed `origin` (not the original input — using `origin` strips any path / query / fragment that the user might have included by accident or that an attacker might have appended to mislead the message).

### Save-time-only doctrine

This check is invoked only at save time and at env-var read time. Request paths (push, LLM proxy, code exchange) trust the saved value and do not re-run the allowlist on every outbound request.

The exception is the code-exchange entry point, which re-runs the check on its `jolliUrl` argument. This is documented as defense against a long-lived process that holds a stale, off-allowlist value in memory — not because a fresh save could ever produce one.

### Composition with the API key validator

The save-time API-key validator is `decode(key) → assertJolliOriginAllowed(decoded.u)`. So a key whose payload encodes an off-allowlist URL is refused at save with this layer's message — even though the user supplied the key, not the URL directly.

## State Transitions

The persisted "Jolli URL" / "Jolli API key" fields have two relevant states:

- **Trusted.** Currently saved value passed the check at save time.
- **Refused.** A save was attempted and threw before any disk write occurred.

Allowed transitions:

- Trusted → Trusted (replace): a successful save replaces the previous value with a new value that also passed the check.
- Trusted → Trusted (no change): a save attempt that throws leaves the existing trusted value unchanged.
- Initial → Trusted: a first-ever save that passed the check.
- Initial → Initial (refused): a first-ever save attempt that threw.

There is no Trusted → Tainted transition. The allowlist throw runs *before* the persistence layer is invoked, so a refused save cannot partially write a bad value.

## Notable Behavior

- **Suffix-boundary check is mandatory.** A naive `host.endsWith("jolli.ai")` would let `jolli.ai.attacker.com` pass, leaking the user's bearer token to the attacker. The required form is `host === entry || host.endsWith("." + entry)`. (Surprising; required for security.)
- **HTTPS-only, even for trusted hosts.** Plain HTTP to `jolli.ai` is refused. The HTTPS check exists to prevent a network attacker on the path from intercepting a token in flight, even when the host is correct. (Notable.)
- **The error message contains the parsed `origin`, not the raw input.** Using `origin` (scheme + host + port) means a user who pasted a full URL with a path and query string sees a sanitized form of what was rejected, and an attacker cannot inject misleading path or query content into the rendered error message. (Notable, defensive.)
- **Hostname is lowercased before comparison.** This is purely a usability concession (so a user pasting `https://APP.JOLLI.AI` is not refused for casing) — the underlying URL parser already handles case-insensitive host matching at most layers, but the explicit lowercase removes any ambiguity. (Notable.)
- **Save-time validation, not request-time validation.** Re-checking the allowlist on every outbound request would be "defense against a scenario that can't happen" once save is the only entry point. The single exception is the code-exchange call, which re-checks because it accepts a `jolliUrl` argument and a long-lived process could be holding a stale value. (Surprising; intentional.)
- **The allowlist is the entry point's only argument, not a parameter.** The function takes a URL and consults the module-local allowlist constant directly. It cannot be called against a different list. The trust boundary is a code change, not a configuration change. (Notable.)
- **A failed save does not taint the trusted state.** The throw runs before any persistence call, so the in-memory pending state can be cleared by the caller (the browser-login flow does exactly this) and the on-disk trusted value is unaffected. (Notable.)
- **`configure --set jolliApiKey` runs the API-key validator, which calls this check on the decoded `u`.** A key whose payload claims an off-allowlist URL is refused with this layer's message, even though the user only supplied the key. (Notable.)
- **`JOLLI_URL` resolver fail-closes.** The resolver lowercases nothing; it strips trailing slashes, then calls this check. A blank or unset env var falls through to the default URL (which is on the allowlist). A non-blank value pointing off-allowlist throws and the calling command surfaces the error to the user without persisting anything. (Notable.)
- **Two implementations exist with a parity gap.** The canonical port enforces the full predicate (HTTPS, non-empty host, suffix-boundary host check) at every save site listed above. The JVM IDE port currently does *not* run this allowlist check on its `JOLLI_URL` resolver, on its login-URL composition, or on its API-key save path — it accepts whatever the user supplies as long as the URL is parseable. The JVM IDE port also does not have a `configure --set jolliUrl` equivalent. This is a known parity gap, not an intentional difference. (Surprising; documented.)

## Shared Behavior

- The HTTPS endpoint that the validated URL is used to reach for the OAuth code redemption is defined by **CLI Authorization Code Exchange**.
- The product API key whose embedded URL is one of the inputs to this check is defined by **Jolli API Key Format and Parsing**.
- The persistence layer that stores the validated URL on disk and the env-var-override rules at read time are defined by **Auth Credential Storage**.
- The browser-launch flow that uses the validated URL to compose the login page URL and the callback handler is defined by **OAuth Browser Login Flow**.
