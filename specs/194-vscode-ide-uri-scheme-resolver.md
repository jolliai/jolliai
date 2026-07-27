# 194. VS Code IDE Fork URI Scheme Resolver

## Topic Statement

For the host editor in which the extension is running, return the OS-registered URI scheme that the operating system has bound to that editor's deep-link handler, by inspecting the editor's user-facing application name and matching it against a fixed table of known forks of the underlying editor.

## Scope

**In scope:**

- The fixed mapping from human-readable application-name substrings to OS-registered URI schemes for every fork the resolver knows about.
- The order in which the fork patterns are tested, including the explicit rule that the "insiders" pattern is tested **last**.
- Case-insensitive matching of the application name against the patterns.
- Substring matching (the pattern is looked for anywhere inside the application name, not as a prefix or as an exact match).
- The default fallback used when none of the patterns match.
- The resolver's lone consumer relationship: producing the scheme half of a deep-link callback target whose other half is a publisher-qualified extension identifier and a fixed callback path.
- The intentional reliance on application name rather than the editor host's own self-reported URI-scheme API, including the rationale.

**Out of scope (boundaries):**

- The OAuth browser sign-in flow that consumes the resolved scheme to build its callback target — including how the callback URL is composed, what query parameters are appended, how the deep-link is received by the host editor, and how the received callback is validated. (See OAuth browser login flow spec, cross-ref 52.)
- The Jolli origin allowlist that determines which back-end the sign-in URL is constructed against. The resolver does not consult this allowlist; it only produces a scheme string. (See origin allowlist spec, cross-ref 55.)
- The back-end allowlist of permitted `cli_callback` URL prefixes. A fork whose scheme is returned by this resolver but is not on the back-end's allowlist will be rejected by the sign-in server, not by the resolver.
- How each fork registers its URI scheme with the operating system at install time. The resolver assumes the registration exists; it does not verify it.
- Other surfaces that historically consumed the resolver (a former chat-deep-link path is no longer wired up; only the OAuth flow uses it today).
- The publisher-qualified extension identifier constant the resolver exports alongside the scheme function. That identifier is consumed by the OAuth flow and by the host editor's URL handler registration; this spec only notes its existence as a stable companion export.

## Data Contracts

### Input

The resolver takes no parameters. It implicitly consumes a single piece of ambient host state: the editor's user-facing application name as exposed by the host editor's runtime API. The application name is a free-form string that each fork rebrands to its own product name. Examples observed in the wild:

| Host editor                         | Application name as observed              |
| ----------------------------------- | ----------------------------------------- |
| Stable upstream editor              | `Visual Studio Code`                      |
| Insiders / preview build of upstream | `Visual Studio Code - Insiders`           |
| Fork A (AI-assisted)                | `Cursor`                                  |
| Fork B (AI-assisted)                | `Windsurf`                                |
| Open-source rebuild                 | `VSCodium`                                |
| Fork C (cloud-IDE)                  | `Kiro`                                    |
| Fork D (AI-assisted)                | `Antigravity`                             |

The resolver does not validate or sanitize this string; it consumes whatever the host editor reports.

### Output

A single short lowercase string: the URI scheme to use when constructing a deep-link back to this host editor. Possible values:

| Scheme              | Returned when the application name (lowercased) contains the substring … |
| ------------------- | ------------------------------------------------------------------------ |
| `cursor`            | `cursor`                                                                 |
| `windsurf`          | `windsurf`                                                               |
| `vscodium`          | `vscodium`                                                               |
| `kiro`              | `kiro`                                                                   |
| `antigravity`       | `antigravity`                                                            |
| `vscode-insiders`   | `insiders` (tested last; see Behavior)                                   |
| `vscode`            | none of the above match (default fallback)                               |

The output is always one of these seven literal values; the resolver returns no errors, throws nothing, and has no null/empty path.

### Companion constant

Alongside the scheme function, the module exports a fixed publisher-qualified extension identifier constant. The identifier is consumed by the OAuth flow when composing the deep-link target (`<scheme>://<extension-id>/<path>`) and by the host editor's URL handler when validating which extension should receive an incoming deep-link. The constant is not parameterized; it is a literal that must match the publisher and name declared in the extension's manifest. The resolver itself does not consume the constant; the two are exported from the same module because they form the two halves of the deep-link target shape.

## Behavior

The resolver runs a single pass over a fixed sequence of substring tests against the lowercased application name. The order is significant.

1. **Read the application name.** Obtain the host editor's user-facing application name from ambient runtime state.

2. **Lowercase.** Apply a Unicode-naive lowercase transform to the entire string. All subsequent comparisons are case-insensitive because of this step.

3. **Test fork patterns in order.** For each of the patterns below, in this exact order, check whether the lowercased application name contains the pattern as a substring. On the first match, return the corresponding scheme:

   1. `cursor` → `cursor`
   2. `windsurf` → `windsurf`
   3. `vscodium` → `vscodium`
   4. `kiro` → `kiro`
   5. `antigravity` → `antigravity`
   6. `insiders` → `vscode-insiders`

4. **Default fallback.** If none of the patterns matched, return `vscode`.

The function is total: every possible application-name string maps to exactly one output, and the function returns synchronously without I/O or side effects.

### Why application name and not the host editor's URI-scheme API

The host editor's runtime exposes a self-reported URI-scheme API, but it returns the upstream default (`vscode`) in most forks because forks inherit upstream's value for that API without overriding it. The OS-level scheme registration is, however, usually correct in those forks. The application name is the stable signal because forks consistently rebrand it (they surface it in window titles and About dialogs). The resolver therefore uses the application name as a proxy for "which fork am I in" and returns the scheme the OS has registered for that fork.

### Why "insiders" is tested last

The pre-release / preview build of the upstream stable editor reports an application name that contains **both** `visual studio code` and `insiders`. The resolver does not test for `visual studio code` at all (the stable build falls through to the default), so the actual collision is between the "insiders" pattern and the default fallback. Testing `insiders` after every fork pattern guarantees that:

- A fork whose own brand name coincidentally contains the word "insiders" still wins (no current fork does, but the ordering is defensive).
- The "Visual Studio Code - Insiders" application name reliably resolves to `vscode-insiders` rather than to the default `vscode`.

In effect: the more specific match wins because the more specific match is tested **after** the less specific match would have, and because the default fallback is reached only when no pattern matched at all.

### Matching style

- **Substring**, not prefix and not exact. An application name like `My Custom Cursor Build` would resolve to `cursor`.
- **Case-insensitive.** The whole application name is lowercased once before any pattern is tested. Patterns are all written in lowercase.
- **No Unicode normalization.** A fork that uses styled characters in its application name (full-width letters, combining marks, etc.) would not match unless its lowercased form contains the literal lowercase ASCII pattern.
- **No whitespace handling.** Patterns are matched against the raw lowercased string; embedded whitespace, punctuation, version suffixes, and surrounding text do not affect the match.

### Pattern-collision policy among fork patterns

The fork patterns themselves do not collide with each other (no two known fork brand names share a substring with one another). If a future fork's name did contain another fork's pattern as a substring, the earlier pattern in the order above would win. The current order is alphabetical-ish but is not a contract — the only ordering contract is **"insiders" runs after every fork pattern**.

### Consumer contract

The single live consumer (the OAuth deep-link flow) composes its callback URI as `<scheme>://<publisher-qualified-extension-id>/<callback-path>`, substituting the resolver's return value for `<scheme>`. The consumer does not validate the returned scheme against any allowlist before sending it to the back-end sign-in URL; back-end validation is the source of truth for which schemes are permitted.

## State Transitions

None. The resolver is stateless, pure, and synchronous. It opens no resources, holds no caches, performs no I/O, and triggers no side effects. Every call reads the host editor's application name afresh from ambient runtime state, so the resolver's output tracks any runtime-time change to that name (in practice the application name is fixed for the lifetime of the host process).

## Notable Behavior

- **The host editor's own URI-scheme API is deliberately not consulted.** It returns the upstream default in most forks and would silently produce the wrong scheme. The resolver chooses to trust the application name (which forks consistently rebrand) over the self-reported scheme API (which forks consistently fail to override). Rationale: preserved.

- **"insiders" is tested last on purpose.** The preview build of the upstream editor reports an application name where the generic "code" terminology coexists with the more specific "insiders" terminology. Testing "insiders" last guarantees the more specific match wins. The current code does not actually test the generic terminology at all (the default fallback handles it), but the ordering is preserved against any future change that adds a generic pattern earlier in the chain.

- **Substring matching, not exact.** An application name that merely contains a fork's brand name as a substring will match that fork. This is a deliberate looseness because forks sometimes append version suffixes, edition tags, or environment labels to their displayed product name. The cost is that a maliciously crafted application name could force any scheme — but the host editor controls the application name, so the trust boundary is at the editor, not at the resolver.

- **Unknown forks silently fall back to `vscode`.** A brand-new fork that the resolver hasn't been taught about gets the default scheme. The OAuth deep-link will then arrive at whichever editor the OS has registered as the `vscode://` handler — which may or may not be the editor that initiated the sign-in. Adding a new fork requires both an entry here **and** a matching entry in the back-end's `cli_callback` URL prefix allowlist; the back-end is what actually permits the round-trip to complete.

- **Case sensitivity is one-shot.** The application name is lowercased once at entry; every pattern is then tested against the lowercased form. A pattern written in mixed case would never match because patterns are not lowercased again — but every pattern in the table is already lowercase, so this only matters if a future contributor adds a non-lowercase pattern.

- **The resolver has no error path.** It cannot fail, cannot throw, cannot return null. The default fallback is a guarantee, not a degradation.

- **The companion extension-identifier constant is part of the public contract.** It is exported from the same module as the resolver and is consumed both by the OAuth callback composition and by the host editor's URL handler (which validates incoming deep-links against this identifier). Renaming the publisher or extension name in the manifest without updating this constant would break sign-in: the back-end-issued deep-link would reach the host editor but be rejected by the URL handler's identifier check.

- **A historical second consumer is gone.** The resolver once also drove chat-style deep-links emitted from a search command, but the host chat surface filters non-HTTP(S) link clicks, so that path was abandoned. The OAuth flow is the only remaining live consumer; the resolver was kept as a focused module specifically because that single consumer is load-bearing and the appName→scheme contract benefits from being locked behind a dedicated test surface.

- **No fork-version awareness.** The resolver does not distinguish between major versions of any fork; the scheme returned is the one each fork has historically registered. A fork that re-registers under a new scheme in a future release would silently break sign-in for users of that version until the resolver and the back-end allowlist are both updated.

## Shared Behavior

- The OAuth browser login flow (cross-ref 52) consumes the resolver's output to build the editor-deep-link variant of its `cli_callback` URL. That spec defines how the URL is composed, signed, returned, validated, and used. The resolver only contributes the scheme half of the host-editor target component.
- The Jolli origin allowlist (cross-ref 55) governs which back-end the sign-in URL is targeted at; it is independent of which deep-link scheme is used for the return trip. The two allowlists (front-end origin, back-end `cli_callback`) are separate mechanisms.
- New forks must be added in **both** this resolver and the back-end `cli_callback` URL prefix allowlist. The resolver alone cannot enable sign-in for a new fork; the back-end will refuse to issue a deep-link to a scheme it has not been told to permit.
