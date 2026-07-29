# 56. Auth Credential Storage

## Topic Statement

Persist the OAuth session token and the product API key together in a single per-user JSON config file using merge-and-rename atomic writes, with environment-variable overrides applied at read time so a process can run against a different identity without modifying the file, and with masking applied whenever the file's contents are surfaced in user-facing output.

## Scope

**In scope:**

- The on-disk location of the config file.
- The set of credential-related fields stored, their meaning, and which are required vs optional.
- The atomic-write behavior used by every save: temp-file write, rename, and the EPERM/EACCES fallback path.
- The merge semantics: a partial update preserves fields not included.
- The env-var fallbacks consulted at read time.
- The save-time validation that gates writing each credential field.
- The masking rule applied whenever the file is displayed to the user.
- The distinct lifetimes of the session token vs. the product API key.
- The two parallel save paths (token-only, token-plus-key) and the symmetric clear path.

**Out of scope (boundaries):**

- The browser-launch / callback-listener flow that produces the values written here (covered by **OAuth Browser Login Flow**).
- The HTTP exchange that mints the values (covered by **CLI Authorization Code Exchange**).
- The structure and parsing of the product API key (covered by **Jolli API Key Format and Parsing**).
- The allowlist check applied during save-time validation (covered by **Jolli Origin Allowlist Enforcement**).
- The session-registry, cursor-registry, plans-registry, queue, and other state files that share the same on-disk directory but encode different concerns.

## Data Contracts

### File location

| Property             | Value                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Directory            | `~/.jolli/jollimemory/` (per-user, host-independent of any individual project working tree).   |
| File name            | `config.json`                                                                                  |
| Format               | JSON object, tab-indented, UTF-8.                                                              |
| Created on demand    | The directory is created (`mkdir -p`) by the save path before any write.                       |

The file is shared with non-credential configuration (model selection, agent toggles, log level, etc.). Save and load operations therefore merge with the existing file rather than overwriting it.

### Credential-related fields

| Field             | Type   | Required | Meaning                                                                                                  |
| ----------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------- |
| `authToken`       | string | optional | OAuth session token from browser login. Presence is the canonical signal that the user is signed in.    |
| `jolliApiKey`     | string | optional | Product API key (`sk-jol-...`). Long-lived in the sense that it is not tied to the session token's expiry and is not rotated by a same-tenant re-auth — but it **is** removed by the clear path (sign-out), and it is removed by a cross-tenant sign-in that brought no replacement. |
| `apiKey`          | string | optional | LLM provider API key (an Anthropic key, used directly when no proxy routing is configured). Stored alongside the auth credentials but represents a distinct credential.  |
| `jolliUrl`        | string | optional | The Jolli tenant URL the credentials belong to. **Persisted** — written by the combined credential save on every successful sign-in, with trailing slashes stripped and the value origin-allowlisted at the persistence boundary. It exists so downstream consumers can recover the tenant when the API key is missing or stale. |
| `aiProvider`      | string | optional | Which engine generates summaries. Not a credential, but the combined credential save writes it (see below), and the clear path conditionally removes it. |

Note that `jolliUrl` is persisted *and* has a read-time environment override: the resolver used to pick a sign-in target reads the environment variable or a compile-time default and never consults the stored field, while consumers that need "which tenant do these credentials belong to" read the stored field. The two coexist deliberately.

The JVM IDE port persists a `space.json` document under `~/.jolli/` that holds a tenant ("space") identifier separately.

### Env-var fallbacks at read time

Read paths consult environment variables before reading the file. The env var **overrides** any value in the file when set and non-empty:

| Field         | Env var            | Read-path behavior                                                                            |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `authToken`   | `JOLLI_AUTH_TOKEN` | If set and non-empty (after trimming), the env value is returned and the file is not read.    |
| `jolliUrl`    | `JOLLI_URL`        | The **sign-in target** resolver does not consult the file at all: if the env var is set and non-empty (after trimming) the env value is used (with trailing slashes stripped), otherwise the compile-time default URL is used, and the result is re-checked against the allowlist before being returned. The stored `jolliUrl` field is read only by consumers asking "which tenant do the stored credentials belong to". |

Other fields (`jolliApiKey`, `apiKey`) have no env-var fallback in the canonical port — they are read straight from the file.

### Atomic write

Every save uses a temp-file + rename pattern:

1. Serialize the merged config as JSON with tab indentation.
2. Write to `<file>.tmp`.
3. Rename `<file>.tmp` → `<file>`.
4. **EPERM / EACCES fallback (Windows-friendly).** If the rename fails with `EPERM` or `EACCES` (e.g. because antivirus or a file-watcher is holding the target open), write the content directly to the target and remove the temp file. Other rename errors propagate.

The rename branch is the atomic path; the fallback is a non-atomic but durable last resort to avoid losing writes on Windows hosts where rename-over-existing-file is unreliable.

### Merge semantics

Save accepts a partial update:

- For each key in the partial, if the value is `undefined`, the key is **removed** from the merged config (because keys whose value is undefined are omitted from the serialized form).
- For each key in the partial whose value is not `undefined`, the partial value replaces any existing value.
- Keys not mentioned in the partial are preserved unchanged.

So a save of `{ authToken: "tok" }` does not touch `jolliApiKey`, and a save of `{ authToken: undefined, jolliApiKey: undefined }` clears both.

### Combined credential save (atomic for the pair)

A dedicated entry point saves a token, a **required** tenant URL, and an optional API key together:

```
saveCredentials({ token, jolliUrl (required), jolliApiKey? }):
  normalizedUrl = strip trailing slashes from jolliUrl
  assert normalizedUrl passes the origin allowlist          -> else refuse the whole write
  update = { authToken: token, jolliUrl: normalizedUrl }

  if stored provider is neither the direct-vendor pin nor the local-agent pin:
      update.provider = product proxy

  if jolliApiKey supplied:
      validate jolliApiKey (decode + allowlist its embedded tenant)   -> else refuse
      if the key's embedded tenant does NOT match normalizedUrl:
          refuse the whole write
      update.jolliApiKey = jolliApiKey
  else if a key is already on disk and its embedded tenant does NOT match normalizedUrl:
      update.jolliApiKey = removed          # clear the cross-tenant leftover

  single merge-and-rename write of `update`
```

Rules the pseudocode encodes:

- **The tenant URL is required and allowlisted.** Every successful sign-in knows the origin it signed into; refusing to write without one keeps the "which tenant do these credentials belong to" field from ever being absent, and the allowlist assertion at this boundary keeps a future caller from persisting an attacker-supplied origin that downstream readers would then trust.
- **Tenant symmetry is enforced, and a mismatch refuses the entire write.** A supplied key must decode *and* its embedded tenant must equal the tenant being persisted. On mismatch nothing is written and the caller receives:
  `Server returned a Jolli API key targeting a different tenant than <jolliUrl>. Refusing to persist — please try signing in again.`
  "Tenant" here is the `(origin, first-path-segment)` pair, not just the origin — comparing only origins would treat two path-based tenants on the same host as identical. Origin comparison is case-insensitive; the path segment is compared **case-sensitively**, because it travels downstream verbatim as the tenant routing header, and a case-variant must fail safe as "different tenant" rather than be kept.
- **An undecodable key is exempt from the symmetry check.** It has no embedded tenant to compare, and dropping a key the user hand-typed would surprise them.
- **A stale cross-tenant key on disk is cleared in the same write.** When no new key arrives but the stored one targets a different tenant, it is removed — otherwise consumers that extract the tenant from the key (rather than from the stored URL) would keep routing traffic to the previous tenant instead of falling back to the new one.
- **The provider preference is written to the product proxy** — clicking "sign in" is read as intent to use the product for summary generation — **unless** the user has already explicitly pinned the direct vendor or a local agent, in which case the pin is left alone. A deliberate provider pick must outlast a sign-in (a user may be signing in only to push memories).

The point of the single write remains: when these fields arrive from the same OAuth callback, they go through one merge-and-rename so a partial failure cannot leave a token without its API key (or vice versa).

### Save-time validation

Save paths validate before writing:

- `jolliApiKey`: decoded as an API key, and the decoded `u` is checked against the origin allowlist. It must additionally target the same tenant as the `jolliUrl` in the same write. Any failure throws and nothing is persisted. (See **Jolli API Key Format and Parsing** and **Jolli Origin Allowlist Enforcement**.)
- `authToken`: persisted without structural validation — the token is opaque to this layer.
- `jolliUrl`: checked against the allowlist both on the env-var read path (before the resolved value is returned) and at the persistence boundary (before the combined save writes it).

### Masking when displayed

The CLI's "show current config" surface masks fields known to contain secrets when rendering the file's contents to the terminal. The masking rule is:

| Length of value | Rendered form                                            |
| --------------- | -------------------------------------------------------- |
| ≤ 10 characters | `***`                                                    |
| > 10 characters | First 6 characters + `…` + last 4 characters (e.g. `sk-jol…ab12`). |

Masked fields are: `apiKey`, `jolliApiKey`, `authToken`. Non-secret fields are rendered verbatim (or comma-joined, for array fields).

The masking is purely presentational. The on-disk file always contains the unmasked value.

### Symmetric clear path

A "clear all credentials" entry point removes `authToken` and `jolliApiKey` in a single atomic write. By the merge semantics, both fields disappear; other config fields are unaffected. Two asymmetries with the combined save are deliberate:

- **The provider preference is removed only when its current value is the product proxy.** This is the exact mirror of the save path (which writes the proxy only when the value is not already pinned to the vendor or a local agent), so "an explicit provider pick survives a sign-in / sign-out round-trip" holds end-to-end. Leaving a proxy preference behind after the credentials are gone would pin generation to an endpoint that can no longer authenticate — a failure that is silent on editor surfaces where the command-line warning copy never reaches the user.
- **The persisted tenant URL is intentionally NOT cleared.** It is not secret material, consumers still need to resolve the tenant after sign-out, and a bare URL grants no access. The next successful sign-in overwrites it (possibly with a different tenant).

## Behavior

### Save (partial)

1. Ensure `~/.jolli/jollimemory/` exists; create it if missing.
2. Read the existing `config.json`. If absent or malformed, start with an empty object (the malformed case is silently treated as "no existing config" — a partial save will overwrite it cleanly).
3. Merge the partial into the existing object. `undefined` values cause key removal because keys whose value is undefined are omitted from the serialized form.
4. Atomic write (temp + rename, EPERM/EACCES fallback).
5. Log the save location.

### Save credentials (combined)

1. Load the existing config (needed for the provider-pin decision and the stale-key check).
2. Strip trailing slashes from the supplied tenant URL and run the origin-allowlist check on it. On rejection, throw — no disk write.
3. Seed the partial with the token and the normalized tenant URL; add the product-proxy provider preference unless an explicit vendor / local-agent pin is already stored.
4. If a `jolliApiKey` was supplied, run the API-key validator, then the tenant-symmetry check. On either rejection, throw — no disk write.
5. If no key was supplied but a stored key targets a different tenant, mark it for removal in the same partial.
6. Delegate to the partial-save path above.

### Resolve which tenant URL a sign-in persists

The tenant URL a sign-in persists is **not** simply the origin the browser was pointed at. It is resolved from an ordered candidate list, and at each step a candidate whose value is off the origin allowlist is **skipped** rather than adopted:

1. The freshly-minted product API key's embedded tenant, when the callback returned a key.
2. Otherwise, the **already-on-disk** key's embedded tenant, read *before* the exchange.
3. Otherwise, the origin the sign-in was launched against.

Rationale, in order:

- The minted key's embedded tenant is authoritative: routing consumers extract the tenant from the key, so persisting anything else would leave the fallback pointing somewhere the account does not live. With no environment override set, the launch origin is a generic sign-in hub, not the user's tenant.
- The on-disk-key step exists for the **idempotent-replay callback**: a backend that scopes key minting per machine label legitimately answers a repeat sign-in with **no** key. Against a generic sign-in hub, the hub origin would then be persisted, the symmetry check in the combined save would compare the still-valid on-disk key against the hub, conclude "different tenant", and **silently clear a working key**. Preferring the existing key's tenant prevents that.
- Precedence is strict: a **freshly minted cross-tenant key still wins** over a stale on-disk one, so an intentional tenant switch is not blocked by the replay protection.
- Because an off-allowlist embedded tenant is skipped at both key steps, a buggy or compromised server cannot steer the persisted tenant off the allowlist; the flow falls through to the launch origin, which was already screened.

The same resolution runs on the code-exchange branch and on the legacy token-in-URL branch, and on all three surfaces.

### Load (full)

1. Read `~/.jolli/jollimemory/config.json` as UTF-8 text.
2. Parse as JSON. On any error (file missing, malformed JSON, permission denied), return an empty config object. The error is logged at debug level.
3. Return the parsed object.

### Load auth token (env-var override)

1. Read `JOLLI_AUTH_TOKEN`. Trim whitespace. If non-empty, return it.
2. Otherwise, load the file and return `config.authToken` (which may itself be undefined).

### Resolve Jolli URL (env-var override + allowlist)

1. Read `JOLLI_URL`. Trim whitespace.
2. If non-empty, take that value; otherwise take the compile-time default Jolli URL.
3. Strip any trailing `/` from the chosen value.
4. Run the allowlist check on the result. If it throws, propagate — the calling command must surface the error and refuse to proceed.
5. Return the validated URL.

### Clear credentials

1. Load the existing config to inspect the stored provider preference.
2. Call partial-save removing `authToken` and `jolliApiKey`, and additionally removing the provider preference **only if** its current value is the product proxy.
3. The merge removes those fields. The persisted tenant URL and all other config (model, agent toggles, etc.) are preserved.

### Display (CLI)

1. Load the config.
2. For each entry, if the key is in the sensitive set and the value is a string, apply the masking rule. Otherwise render the value as-is (arrays are comma-joined; everything else is `String(value)`).
3. Print one key/value line per entry, prefixed with the file location.

## State Transitions

The credential subset of `config.json` has these states:

- **Empty.** Neither `authToken` nor `jolliApiKey` is present.
- **Token-only.** `authToken` present; `jolliApiKey` absent.
- **Key-only.** `authToken` absent; `jolliApiKey` present (e.g. user manually configured a key without signing in).
- **Both.** Both fields present.

Allowed transitions:

- Empty → Token-only: a save of just the token (rare; the OAuth callback typically provides both, but the session token can be saved alone via `configure --set authToken=…`).
- Empty → Both: a successful sign-in flow that requested `generate_api_key=true`.
- Token-only → Both: a successful sign-in on a session that already had `authToken` and now also receives a freshly minted key.
- Key-only → Both: a successful sign-in on a session that had a manually configured key. When that key targets the tenant being signed into, no fresh key is requested and the existing key is preserved.
- Both → Token-only: a sign-in against a **different** tenant that returned no fresh key — the stale cross-tenant key is removed in the same write.
- Both → Empty: explicit clear (sign-out).
- Token-only → Empty: explicit clear.
- Both → Both (refresh): a subsequent sign-in overwrites `authToken` with a fresh value; `jolliApiKey` is overwritten only if a new one was returned.

The token's lifetime is tied to the OAuth session — it can expire and be replaced by signing in again. The product API key is long-lived and survives token rotation; clearing it requires explicit action.

### Resilience to malformed reads

A corrupt `config.json` (e.g. truncated by a host crash mid-write — possible on the EPERM fallback path) is treated as "no existing config" by the load path. The next save will overwrite it cleanly. There is no recovery procedure for a corrupt file beyond the next save.

## Notable Behavior

- **`undefined` is the channel for field removal.** The save layer relies on the JSON serializer omitting keys whose value is undefined to express "remove this key." A caller who passes `null` would actually persist `null` as the value — that is *not* equivalent. The clear path uses `undefined`. (Surprising; intentional.)
- **The combined-save entry point is the only way to atomically write a token + API key pair.** Calling save twice (once for each) would leave a brief window where the file has the new token but the old key. The combined save merges both into one rename. (Notable.)
- **Env-var fallback is read-time, not save-time.** Setting `JOLLI_AUTH_TOKEN` overrides whatever is in the file for the duration of the process. The file itself is not updated; the override is invisible after the env var is unset. This lets a developer run a process against a different identity without modifying the file. (Surprising; intentional.)
- **`JOLLI_URL` is re-validated on every read.** The resolver runs the allowlist check whenever it returns a URL. A long-lived process whose environment was mutated mid-run would fail-closed on the next read, not silently use a stale or attacker-supplied value. (Notable, defensive.)
- **Masking is presentational only.** The on-disk file always holds the unmasked value. Masking applies in the `configure` command's display output and is the only surface where masking is implemented. (Notable.)
- **Short values are masked as `***`, not as a partial reveal.** Values of 10 or fewer characters are too short to safely reveal any prefix/suffix without leaking entropy, so they are replaced wholesale. (Notable.)
- **The 6-on-the-left, 4-on-the-right partial reveal is recognizable.** For a product API key (`sk-jol-...`), this preserves the prefix `sk-jol` and the last 4 characters of the embedded payload — enough to recognize "yes, this is the key I configured" without revealing the secret. (Notable.)
- **Atomic-write fallback is Windows-driven.** `rename` over an existing file can fail on Windows with `EPERM` when antivirus or a file-watcher holds the target. The fallback writes directly and removes the temp file, accepting non-atomicity in exchange for not losing the write. (Surprising; required for the platform.)
- **A malformed `config.json` is silently treated as empty.** This is intentional: a corrupted file should not block the next save, and the next save overwrites it cleanly. The trade-off is that a load of a corrupt file silently loses the previously stored values. (Surprising; intentional.)
- **Validation lives at the save boundary, not at the read boundary.** The save path validates the API key's structure and embedded origin. The load path returns whatever is in the file without revalidating. The save-time-only doctrine applies (see **Jolli Origin Allowlist Enforcement**). (Notable.)
- **The credential file is the same file used for non-credential config.** Storing both in `~/.jolli/jollimemory/config.json` keeps the CLI and the editor extension in sync without a separate secret store. The trade-off is that the file must be merge-saved (never overwritten) to preserve unrelated fields. (Notable.)
- **The editor extension uses this same file, not the host IDE's secret store.** This is deliberate — using the IDE's secret store would split the credential between the CLI and the extension and break the "shared identity" contract. The trade-off is that the credential is only filesystem-protected, not OS-keychain-protected. (Surprising; intentional.)
- **The tenant URL a sign-in persists can differ from the origin the browser was pointed at.** It is resolved from the minted key's embedded tenant, then the on-disk key's embedded tenant, then the launch origin — skipping any candidate that is off the allowlist. The second step is what stops an idempotent-replay callback from wiping a working key. (Surprising; intentional. See "Resolve which tenant URL a sign-in persists".)
- **A cross-tenant sign-in either replaces the key or clears it — it never leaves a key pointed at the old tenant.** Supplying a key for a different tenant than the one being persisted refuses the whole write; supplying none while a different-tenant key sits on disk clears that key. Both outcomes are preferred to silent cross-tenant routing. (Notable, defensive.)
- **The JVM IDE port has no *sign-in* credential-write path of its own any more, but it is not read-only.** What changed: the credentials produced by a sign-in are written by the shared command-line runtime into the shared `config.json`, and the plugin's own config accessor keeps **read** access plus one write of its own — `~/.jolli/space.json`, a separate document holding a tenant ("space") identifier that the canonical port has no equivalent for. What did **not** change:
  - **A sign-out fallback still writes directly.** When the shared runtime is unreachable during sign-out, the plugin clears the token and key against the shared `config.json` itself. That fallback deliberately does **not** touch the provider preference, because it cannot know whether the stored value came from a Jolli sign-in — so a sign-out that falls back can leave a proxy preference behind that the normal path would have removed.
  - **Its settings-Apply path also writes both credential fields directly** to the shared `config.json`: it persists a hand-pasted product API key **without** any decode or allowlist screening, and clearing that field is treated as a sign-out (it nulls the token in the same write, then runs the normal clear afterwards for the provider rollback, listeners, and telemetry).
  - **The signed-in probe is a cached read of the shared file.** It honours the token environment override first, then reads `config.json`, and caches the answer for **5 seconds** — so a sign-in or sign-out performed from a terminal becomes visible within seconds rather than never. The cache is invalidated outright on sign-in success and on sign-out. It is a local read on purpose: the probe runs on UI paint and action-update ticks, where a round-trip per poll would make the UI sluggish. (Notable parity facts.)
- **Two save paths exist with the same atomic-write engine, but only one is live.** A token-only save and a combined save; the clear path mirrors them as a single combined remove. All three funnel through the same merge-and-rename engine and differ only in their partial. The token-only save currently has **no** production caller — every real sign-in goes through the combined save, which is what makes the required tenant URL and the tenant-symmetry check unavoidable in practice. (Notable.)

## Shared Behavior

- The browser-launch and callback handler that produce the values written here are defined by **OAuth Browser Login Flow**.
- The HTTP exchange that mints the values is defined by **CLI Authorization Code Exchange**.
- The structure of the product API key, its prefix, and its decoded payload are defined by **Jolli API Key Format and Parsing**.
- The allowlist applied during save-time validation of the API key (and during the env-var read of `JOLLI_URL`) is defined by **Jolli Origin Allowlist Enforcement**.
