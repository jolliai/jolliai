# 10 — LLM Credential Priority and aiProvider Selection

## Topic Statement

This spec defines the priority order that determines which LLM credential and provider path is used for an LLM call, given multiple possible sources, with an explicit override that pins the choice.

## Scope

**In scope**

- The full priority list across all credential sources used by the LLM dispatcher.
- The interaction with the explicit `aiProvider` override (when present).
- The fallback behavior when no source can supply a credential.
- How each source is read and what counts as "supplied" vs "absent".

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
| `local-agent`         | The driven agent CLI's own login (no product-held credential is read; see the qualifier below). | Drives a locally-installed agent CLI as a child process. |

The dispatcher does not itself read the config file — it consumes already-loaded values. Config-file loading happens upstream, from the machine-global config file every surface shares. The `local-agent` source carries no stored credential at all — it is selected by an explicit `aiProvider` pin, never by presence.

**"No product-held credential is read" is exactly true; "the agent tool's own subscription" is true for every drivable CLI except OpenCode.** Claude Code, Codex, Cursor and Kimi Code each authenticate against a subscription the tool itself holds — and each of them actively scrubs its vendor API key out of the child environment precisely to force that subscription path. OpenCode authenticates against whichever LLM provider the user configured *inside* it — its own stored provider credentials, or provider API keys left in the environment, which that backend deliberately does **not** scrub. So a `local-agent` pin on OpenCode still involves no jollimemory-held credential, but it can spend the user's own metered provider credit rather than a flat subscription. The dispatcher makes no distinction: the pin is honored identically for every tool.

**Which CLI is driven is a second persisted dimension**, alongside the provider pin: a separate enumerated config field names the tool, with a default when absent, and an optional third field pins an explicit executable path. Neither is consulted by the priority resolution — the pin resolves to `local-agent` regardless of their values — but both are threaded to the execution path with the credentials, so a call site that copies credentials carries them along. What that identifier changes about the run (including which tool's login is actually spent) is owned by spec 280.

### Override field

A field named `aiProvider` may appear on the persisted configuration. Its accepted values are:

- `"jolli"` — pin the Jolli proxy path; if no Jolli credential is available the resolution is "none", never a fall back to an Anthropic source.
- `"anthropic"` — pin the Anthropic-direct path, considering the config field then the environment variable; if neither has a credential the resolution is "none", never a fall back to the Jolli proxy.
- `"local-agent"` — pin the local-agent execution backend. Credential-less: honored the moment it is set, with no presence check, and never reached by the historical default order — only an explicit choice selects it.
- absent / null / unrecognized — defer to the historical default order.

A set `aiProvider` is a **hard pin**: only the matching credential source is
considered, and if it is absent the resolution is `"none"` rather than falling
back to another source — silent cross-provider fallback was the root cause of a
"Settings says one provider, doctor reports another" mismatch.

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

### Priority order when `aiProvider` is set (hard pin)

A recognized `aiProvider` value narrows resolution to that provider's own
sources and never crosses to another provider's:

- `"anthropic"` — `anthropic-config`, then `anthropic-env`, then **None**. The
  Jolli proxy is not considered even when a Jolli key is present.
- `"jolli"` — `jolli-proxy`, then **None**. Neither Anthropic source is considered
  even when a key is present.
- `"local-agent"` — see the subsection below.

An unrecognized value is not a pin at all: it falls through to the historical
default order above.

### Priority order when `aiProvider = "local-agent"`

The `local-agent` source is selected **unconditionally**: no credential-presence
check is performed (the driven CLI authenticates through its own login), no
other source is consulted, and there is no fallback.

### Per-source "supplied" semantics

| Source             | Counts as supplied iff …                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `anthropic-config` | The `apiKey` field is a non-empty string.                                                     |
| `anthropic-env`    | `ANTHROPIC_API_KEY` is present in the environment with a non-empty value.                     |
| `jolli-proxy`      | The `jolliApiKey` field is a non-empty string.                                                |
| `local-agent`      | Always — the source is credential-less; selection is by explicit `aiProvider` only, never by presence. |

Presence is a truthiness check (rejecting the empty string and an absent value). Trimming is not applied to the values themselves before they are used for the call.

### Fallback when no source matches

When all four checks miss, the call fails before any HTTP I/O is attempted, with an error directing the user to either set an Anthropic API key (or `ANTHROPIC_API_KEY`) or configure a Jolli Space API key. The call does not become a no-op; it raises.

A `local-agent` pin never reaches this no-source failure — the source is always
satisfiable (credential-less, unconditionally selected), so this fallback path is
only ever hit by the three credentialed sources.

### Reading each source

- **`apiKey`** is read from the in-memory call options. Upstream loaders read it from the persisted config file (the machine-global config under the user's home Jolli memory directory, shared by every surface). The dispatcher does not perform any I/O to source it.
- **`ANTHROPIC_API_KEY`** is read from the live process environment at call time, via the standard environment-variable accessor for the language runtime. There is no caching; each call rechecks the environment.
- **`jolliApiKey`** is read from the in-memory call options. Upstream loaders read it from the persisted config file. The dispatcher does not perform any I/O to source it.
- **`aiProvider`** is loaded upstream from the persisted config file and passed into the dispatcher alongside the credentials. It is not read from the environment.
- **`authToken`** is loaded by a separate auth helper (env var first, then config file). Not consulted by the LLM dispatcher.

### Diagnostic mirroring

The same priority resolver that the dispatcher uses is also exposed to diagnostic tooling (e.g., a "doctor" command), so reporting which source would be used does not duplicate the priority logic.

## State Transitions

The dispatcher itself is stateless. It resolves a source per call from its inputs (call options + environment + optional override). No source preference is cached, learned, or persisted.

The configuration file does carry persisted state — saving a Jolli API key, Anthropic API key, auth token, or `aiProvider` change persists across runs, but those writes happen elsewhere (auth flows, settings dialogs, configure command). This spec does not mutate the config; it only reads it (indirectly, via inputs already loaded by the caller).

## Notable Behavior

- **Empty-string credentials are treated as absent.** A credential must be a non-empty value; the empty string and an absent field are both "not supplied".
- **Environment beats nothing, never beats the config field.** In the historical / `"anthropic"` order, an `ANTHROPIC_API_KEY` in the environment is only consulted when the config-file `apiKey` is absent.
- **No partial fallback within a single attempt.** Once the dispatcher selects a source, the call is made via that source only. A failure on the chosen path is **not** retried with the next source — the error surfaces to the caller. There is no automatic credential rotation.
- **A set `aiProvider` is a hard pin, with no cross-provider fallback.** When it is set, only that provider's own sources are considered, and resolution is "none" if none of them has a credential. The recognized values are exactly `"jolli"`, `"anthropic"`, and `"local-agent"`; an unrecognized value degrades to the historical default order.
- **`authToken` does not authenticate LLM calls.** Even if `authToken` is set (e.g., from a browser login), the LLM dispatcher will refuse to act on it; only an `sk-jol-…` Jolli API key triggers the proxy path. A "logged-in but no API key" state is a real intermediate state and produces the "no LLM provider available" error if reached.
- **No recognition of other provider names.** Unrecognized `aiProvider` values do not raise; they silently degrade to the historical default order.
- **A `local-agent` pin reads no stored credential — but it does not always bill a flat subscription.** The dispatcher requires no credential to select it; it is always satisfiable the moment `aiProvider` is set to `"local-agent"`. For every drivable CLI except OpenCode the spend lands on that tool's own subscription. For OpenCode it lands on whichever LLM provider the user configured inside that tool — including provider API keys deliberately left in the child's environment — so the pin can still consume metered credit, just not through a product-held key.
- **The interactive surfaces deliberately disagree with this resolver, for `local-agent` only.** A separate shared predicate — "can generation actually run right now?", used by the guided front door and `jolli enable` and defined by spec 291 — additionally **probes the agent CLI** when the provider is `local-agent`, instead of accepting this resolver's unconditional selection. The divergence is intentional and one-directional: dispatch-time resolution must stay cheap and I/O-free per call, so it cannot afford a subprocess probe, while an interactive surface must not promise generation that will fail at the next commit. For all three credentialed sources the two agree exactly. This spec remains the sole owner of dispatch-time selection; the interactive predicate never changes what dispatch resolves.
- **There is now exactly one dispatcher, and the IDE plugin resolves through it out-of-process.** The plugin's own in-process model dispatcher no longer exists: every model-backed action on that surface — the commit message, the squash message, and the memory viewer's generate-test / generate-recap / translate actions — is delegated to the command-line tool, which resolves credentials with the rules in this spec. That surface therefore has no provider semantics of its own, and it gains full `local-agent` support. There is no surface left that reads `aiProvider` with softer, fallback-bearing semantics, and none that fails to recognize `"local-agent"`.

## Shared Behavior

- **First match wins.** There is no scoring, no merging, no "use both"; one source is picked per call.
- **Resolution is per call.** Re-evaluated on every dispatch; a credential added or removed between calls is picked up immediately on the next call.
- **No I/O during resolution.** Aside from reading the live environment, the dispatcher neither reads nor writes any file during priority resolution; all persisted inputs are passed in by upstream loaders.
- **Order is observable.** A diagnostic command can ask which source would be selected without making any LLM call; the same resolver answers both questions.
- **The local-agent execution mechanics are owned elsewhere.** Spawning the agent CLI, environment scrubbing, result parsing, and its error taxonomy are owned by the **local-agent CLI provider backend spec (280)**; this spec owns only *which* provider is chosen, not how the `local-agent` path is executed.
- **The interactive "can generate right now?" predicate is owned elsewhere.** Spec **291** defines that predicate, its deliberate `local-agent` divergence from this resolver, and the repair ladder built on top of it. This spec is still what the runtime uses to dispatch.
