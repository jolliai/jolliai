# 10 — LLM Credential Priority and aiProvider Selection

## Topic Statement

This spec defines the priority order that determines which LLM credential and provider path is used for an LLM call, given multiple possible sources, with an explicit per-surface override that pins the choice.

## Scope

**In scope**

- The full priority list across all credential sources used by the LLM dispatcher.
- The interaction with the explicit `aiProvider` override (when present).
- The fallback behavior when no source can supply a credential.
- How each source is read and what counts as "supplied" vs "absent".
- Differences between the two implementations of the dispatcher (the per-surface variants).

**Out of scope**

- The mechanics of the direct LLM-provider call (see spec 08).
- The mechanics of the Jolli proxy call (see spec 09).
- The save-time validation of the Jolli API key origin allowlist.
- Loading config-file fields beyond the credentials and the provider override (covered only where it directly affects priority resolution).

## Data Contracts

### Credential sources recognized

| Source label         | Where it lives                                                                          | Provider path it selects                  |
| -------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| `anthropic-config`   | The `apiKey` field on the LLM-call options (already loaded from the config file).       | Direct call to the Anthropic LLM provider.|
| `anthropic-env`      | The `ANTHROPIC_API_KEY` process environment variable.                                   | Direct call to the Anthropic LLM provider.|
| `jolli-proxy`        | The `jolliApiKey` field on the LLM-call options (already loaded from the config file).  | Routed call via the Jolli backend proxy.  |
| `local-agent`         | The local agent CLI's own subscription login (no product-held credential is read).      | Drives a locally-installed agent CLI as a child process. |

The dispatcher does not itself read the config file — it consumes already-loaded values. Config-file loading happens upstream and is shared across surfaces (each surface persists its config under its respective config file). The `local-agent` source carries no stored credential at all — it is selected by an explicit `aiProvider` pin, never by presence.

### Override field

A field named `aiProvider` may appear on the persisted configuration. Its accepted values are:

- `"jolli"` — prefer the Jolli proxy path; if no Jolli credential is available, fall back to Anthropic-config, then to Anthropic-env.
- `"anthropic"` — prefer the Anthropic-direct path; if neither Anthropic source has a credential, fall back to the Jolli proxy.
- `"local-agent"` — pin the local-agent execution backend (npm-shipped surface only). Credential-less: honored the moment it is set, with no presence check, and never reached by the historical default order — only an explicit choice selects it.
- absent / null / unrecognized — defer to the historical default order.

Both dispatchers read `aiProvider`, but with different semantics. The
npm-shipped dispatcher (CLI + the editor extension that bundles it) treats a set
`aiProvider` as a **hard pin**: only the matching credential source is
considered, and if it is absent the resolution is `"none"` rather than falling
back to another source — silent cross-provider fallback was the root cause of a
"Settings says one provider, doctor reports another" mismatch. The JVM-shipped
dispatcher honors `aiProvider` as a softer preference **with** fallback (see
below). Only the npm dispatcher recognizes `"local-agent"`; the JVM surface does
not recognize this value.

**How much of the JVM surface the JVM dispatcher still decides.** Every statement
below about the JVM-shipped dispatcher remains accurate, but its *reachable
scope* is now narrow: it governs only **three read-path actions in the IDE
plugin's memory viewer** — generating an end-to-end test guide, generating a
recap, and translating a rendered memory to English. Every other LLM-backed
action on that surface, including the AI commit message and the squash message,
now resolves credentials through the **npm-shipped** dispatcher because the
plugin delegates those to the command-line tool. So on a single machine the same
user can be subject to soft-preference-with-fallback semantics (and no
`local-agent` support) for those three viewer actions while getting hard-pin
semantics (and full `local-agent` support) for everything else.

### Auth-token field

A separate field, `authToken`, stores the OAuth session token from a browser sign-in. The auth token is **not** a credential consumed directly by the LLM dispatcher; it is used elsewhere (for non-LLM API calls and for credential management). It is loaded from:

1. The `JOLLI_AUTH_TOKEN` environment variable (when set and non-empty after trimming).
2. Otherwise, the `authToken` field of the loaded global config file.

The auth token does **not** add a third proxy path: an `authToken` alone, without an `sk-jol-…` Jolli API key, cannot drive an LLM call.

## Behavior

### Default priority order (historical / no override)

When no `aiProvider` override is in effect, sources are checked in this order, and the first hit wins:

1. **`anthropic-config`** — the call's `apiKey` field is a non-empty string.
2. **`anthropic-env`** — `process.env.ANTHROPIC_API_KEY` is set and non-empty.
3. **`jolli-proxy`** — the call's `jolliApiKey` field is a non-empty string.
4. **None** — no source matched.

### Priority order when `aiProvider = "anthropic"`

(JVM-shipped surface only; behaves identically to the historical default.)

1. `anthropic-config`
2. `anthropic-env`
3. `jolli-proxy`
4. None

### Priority order when `aiProvider = "jolli"`

(JVM-shipped surface only.)

1. `jolli-proxy`
2. `anthropic-config`
3. `anthropic-env`
4. None

### Priority order when `aiProvider` has an unrecognized value

(JVM-shipped surface only.) Treated as the historical default order:

1. `anthropic-config`
2. `anthropic-env`
3. `jolli-proxy`
4. None

### Priority order when `aiProvider = "local-agent"` (npm-shipped surface)

The `local-agent` source is selected **unconditionally**: no credential-presence
check is performed (the tool authenticates via its own subscription login), no
other source is consulted, and there is no fallback. (The JVM-shipped surface
does not recognize this value.)

### Per-source "supplied" semantics

| Source             | Counts as supplied iff …                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `anthropic-config` | The `apiKey` field is a non-empty string.                                                     |
| `anthropic-env`    | `ANTHROPIC_API_KEY` is present in the environment with a non-empty value.                     |
| `jolli-proxy`      | The `jolliApiKey` field is a non-empty string.                                                |
| `local-agent`      | Always — the source is credential-less; selection is by explicit `aiProvider` only, never by presence. |

The JVM-shipped surface uses an "is null or blank" check (rejecting whitespace-only values). The npm-shipped surfaces use a truthiness check (rejecting empty string and undefined). Trimming is not applied to the values themselves before they are used for the call.

### Fallback when no source matches

When all four checks miss, the call fails before any HTTP I/O is attempted, with an error directing the user to either set an Anthropic API key (or `ANTHROPIC_API_KEY`) or configure a Jolli Space API key. The call does not become a no-op; it raises.

A `local-agent` pin never reaches this no-source failure — the source is always
satisfiable (credential-less, unconditionally selected), so this fallback path is
only ever hit by the three credentialed sources.

### Reading each source

- **`apiKey`** is read from the in-memory call options. Upstream loaders read it from the persisted config file (the per-surface config under the user's home Jolli memory directory). The dispatcher does not perform any I/O to source it.
- **`ANTHROPIC_API_KEY`** is read from the live process environment at call time, via the standard environment-variable accessor for the language runtime. There is no caching; each call rechecks the environment.
- **`jolliApiKey`** is read from the in-memory call options. Upstream loaders read it from the persisted config file. The dispatcher does not perform any I/O to source it.
- **`aiProvider`** (JVM-shipped surface only) is loaded upstream from the persisted config file and passed into the dispatcher alongside the credentials. It is not read from the environment.
- **`authToken`** is loaded by a separate auth helper (env var first, then config file). Not consulted by the LLM dispatcher.

### Diagnostic mirroring

The same priority resolver that the dispatcher uses is also exposed to diagnostic tooling (e.g., a "doctor" command), so reporting which source would be used does not duplicate the priority logic.

## State Transitions

The dispatcher itself is stateless. It resolves a source per call from its inputs (call options + environment + optional override). No source preference is cached, learned, or persisted.

The configuration file does carry persisted state — saving a Jolli API key, Anthropic API key, auth token, or `aiProvider` change persists across runs, but those writes happen elsewhere (auth flows, settings dialogs, configure command). This spec does not mutate the config; it only reads it (indirectly, via inputs already loaded by the caller).

## Notable Behavior

- **Empty-string credentials are treated as absent.** Both implementations require non-empty / non-blank values; whitespace-only values are rejected on the JVM-shipped surface and rejected as falsy on the npm-shipped surfaces.
- **Environment beats nothing, never beats the config field.** In the historical / `"anthropic"` order, an `ANTHROPIC_API_KEY` in the environment is only consulted when the config-file `apiKey` is absent.
- **No partial fallback within a single attempt.** Once the dispatcher selects a source, the call is made via that source only. A failure on the chosen path is **not** retried with the next source — the error surfaces to the caller. There is no automatic credential rotation.
- **Both implementations now read `aiProvider`, but with different fallback semantics.** The npm-shipped dispatcher **hard-pins** to the matching credential source when `aiProvider` is set — no cross-provider fallback, resolving to "none" if the matching source is absent. The JVM-shipped dispatcher applies fallback ordering (its chosen primary falls back through the remaining sources before giving up). The recognized values are now `"jolli"`, `"anthropic"`, and — npm-shipped only — `"local-agent"`; unrecognized values still degrade to the historical default order on both surfaces.
- **`authToken` does not authenticate LLM calls.** Even if `authToken` is set (e.g., from a browser login), the LLM dispatcher will refuse to act on it; only an `sk-jol-…` Jolli API key triggers the proxy path. A "logged-in but no API key" state is a real intermediate state on the npm-shipped surfaces and produces the "no LLM provider available" error if reached.
- **`aiProvider` set to `"jolli"` still falls back — on the JVM-shipped surface.** There it expresses a preference, not a hard pin: when the chosen primary has no credential, the dispatcher walks the remaining sources in their per-override fallback order before giving up. On the npm-shipped surface, by contrast, a set `aiProvider` is a hard pin with no fallback (see above).
- **No recognition of other provider names.** Unrecognized `aiProvider` values do not raise; they silently degrade to the historical default. The recognized strings are exactly `"jolli"`, `"anthropic"`, and (npm-shipped surface only) `"local-agent"`.
- **A `local-agent` pin bills the agent tool's own subscription, not a metered key.** The dispatcher requires no stored credential to select it — it is always satisfiable the moment `aiProvider` is set to `"local-agent"`.
- **The interactive surfaces deliberately disagree with this resolver, for `local-agent` only.** A separate shared predicate — "can generation actually run right now?", used by the guided front door and `jolli enable` and defined by spec 291 — additionally **probes the agent CLI** when the provider is `local-agent`, instead of accepting this resolver's unconditional selection. The divergence is intentional and one-directional: dispatch-time resolution must stay cheap and I/O-free per call, so it cannot afford a subprocess probe, while an interactive surface must not promise generation that will fail at the next commit. For all three credentialed sources the two agree exactly. This spec remains the sole owner of dispatch-time selection; the interactive predicate never changes what dispatch resolves.
- **The JVM dispatcher's semantics now cover only a sliver of the JVM surface.** Its soft-preference-with-fallback behaviour and its non-recognition of `local-agent` are still real, but reach only the three viewer read-path actions listed above; the plugin's commit-message and squash-message paths get npm hard-pin semantics via delegation.

## Shared Behavior

- **First match wins.** There is no scoring, no merging, no "use both"; one source is picked per call.
- **Resolution is per call.** Re-evaluated on every dispatch; a credential added or removed between calls is picked up immediately on the next call.
- **No I/O during resolution.** Aside from reading the live environment, the dispatcher neither reads nor writes any file during priority resolution; all persisted inputs are passed in by upstream loaders.
- **Order is observable.** A diagnostic command can ask which source would be selected without making any LLM call; the same resolver answers both questions.
- **The local-agent execution mechanics are owned elsewhere.** Spawning the agent CLI, environment scrubbing, result parsing, and its error taxonomy are owned by the **local-agent CLI provider backend spec (280)**; this spec owns only *which* provider is chosen, not how the `local-agent` path is executed.
- **The interactive "can generate right now?" predicate is owned elsewhere.** Spec **291** defines that predicate, its deliberate `local-agent` divergence from this resolver, and the repair ladder built on top of it. This spec is still what the runtime uses to dispatch.
