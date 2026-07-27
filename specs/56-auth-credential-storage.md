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
| `jolliApiKey`     | string | optional | Product API key (`sk-jol-...`). Long-lived; survives sign-in / sign-out cycles unless explicitly cleared. |
| `apiKey`          | string | optional | LLM provider API key (an Anthropic key, used directly when no proxy routing is configured). Stored alongside the auth credentials but represents a distinct credential.  |

A separate top-level non-credential string field, `jolliUrl`, is *not* present in the persisted config in the canonical port: the URL is resolved at read time from the `JOLLI_URL` env var or a compile-time default, then re-validated against the allowlist before being returned. The JVM IDE port persists a `space.json` document under `~/.jolli/` that holds a tenant identifier separately.

### Env-var fallbacks at read time

Read paths consult environment variables before reading the file. The env var **overrides** any value in the file when set and non-empty:

| Field         | Env var            | Read-path behavior                                                                            |
| ------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `authToken`   | `JOLLI_AUTH_TOKEN` | If set and non-empty (after trimming), the env value is returned and the file is not read.    |
| `jolliUrl`    | `JOLLI_URL`        | If set and non-empty (after trimming), the env value is used (with trailing slashes stripped); otherwise the compile-time default URL is used. The resolved value is then re-checked against the allowlist before being returned. |

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

A dedicated entry point saves a token and an optional API key together:

```
saveAuthCredentials({ token, jolliApiKey? }):
  validate jolliApiKey if present
  save({ authToken: token, ...(jolliApiKey ? { jolliApiKey } : {}) })
```

The point is: when both fields arrive from the same OAuth callback, they go through a single merge-and-rename so a partial failure cannot leave a token without its API key (or vice versa).

### Save-time validation

Save paths validate before writing:

- `jolliApiKey`: decoded as an API key, and the decoded `u` is checked against the origin allowlist. Any failure throws and nothing is persisted. (See **Jolli API Key Format and Parsing** and **Jolli Origin Allowlist Enforcement**.)
- `authToken`: persisted without structural validation — the token is opaque to this layer.
- `jolliUrl` (env-var path only): resolved value is checked against the allowlist before being returned.

### Masking when displayed

The CLI's "show current config" surface masks fields known to contain secrets when rendering the file's contents to the terminal. The masking rule is:

| Length of value | Rendered form                                            |
| --------------- | -------------------------------------------------------- |
| ≤ 10 characters | `***`                                                    |
| > 10 characters | First 6 characters + `…` + last 4 characters (e.g. `sk-jol…ab12`). |

Masked fields are: `apiKey`, `jolliApiKey`, `authToken`. Non-secret fields are rendered verbatim (or comma-joined, for array fields).

The masking is purely presentational. The on-disk file always contains the unmasked value.

### Symmetric clear path

A "clear all credentials" entry point performs `save({ authToken: undefined, jolliApiKey: undefined })`. By the merge semantics, both fields are removed in a single atomic write. Other config fields are unaffected.

## Behavior

### Save (partial)

1. Ensure `~/.jolli/jollimemory/` exists; create it if missing.
2. Read the existing `config.json`. If absent or malformed, start with an empty object (the malformed case is silently treated as "no existing config" — a partial save will overwrite it cleanly).
3. Merge the partial into the existing object. `undefined` values cause key removal because keys whose value is undefined are omitted from the serialized form.
4. Atomic write (temp + rename, EPERM/EACCES fallback).
5. Log the save location.

### Save credentials (combined)

1. If a `jolliApiKey` was supplied, run the API-key validator. On rejection, throw — no disk write.
2. Build the partial `{ authToken: token, jolliApiKey?: jolliApiKey }`.
3. Delegate to the partial-save path above.

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

1. Call partial-save with `{ authToken: undefined, jolliApiKey: undefined }`.
2. The merge removes both fields. Other config (model, agent toggles, etc.) is preserved.

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
- Token-only → Both: a successful sign-in on a session that already had `authToken` and now also receives a freshly minted key. (Not common; the conditional `generate_api_key=true` flag in the login URL prevents this when a key already exists.)
- Key-only → Both: a successful sign-in on a session that had a manually configured key. The conditional flag in the login URL means no fresh key is requested in this case, so the existing key is preserved.
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
- **The JVM IDE port adds `~/.jolli/space.json`.** The JVM IDE plugin persists a tenant identifier ("space") to a separate file alongside its `config.json`. The canonical port has no equivalent — the tenant identifier is recovered from the API key's payload at request time. (Notable parity fact.)
- **Two save paths exist with the same atomic-write engine.** A token-only save (`saveAuthToken`) and a combined save (`saveAuthCredentials`). The clear path mirrors them as a single combined remove. All three paths funnel through the same merge-and-rename engine; they differ only in their partial. (Notable.)

## Shared Behavior

- The browser-launch and callback handler that produce the values written here are defined by **OAuth Browser Login Flow**.
- The HTTP exchange that mints the values is defined by **CLI Authorization Code Exchange**.
- The structure of the product API key, its prefix, and its decoded payload are defined by **Jolli API Key Format and Parsing**.
- The allowlist applied during save-time validation of the API key (and during the env-var read of `JOLLI_URL`) is defined by **Jolli Origin Allowlist Enforcement**.
