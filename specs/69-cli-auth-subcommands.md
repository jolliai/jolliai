# 69. `jolli auth` — Login, logout, and status subcommands

## Topic Statement

The `jolli auth` namespace provides three subcommands — `login`, `logout`, and `status` — that together manage the user's Jolli account session and the product API key used to power AI summary generation, while leaving any separately configured Anthropic API key alone.

## Scope

This spec covers the user-facing behavior of the three subcommands: invocation forms, what each prints to stdout/stderr, what each does to the persisted credentials, the masking and display rules for `status`, and exit codes. It does not cover the OAuth browser-callback flow itself (covered by the browser-login topic), the Jolli origin allowlist that governs which servers a key may belong to (covered separately), or the global config file format (covered separately).

## Data Contracts (output)

All three subcommands write free-form, multi-line, human-readable text to stdout. None of them produce machine-parseable output — there is no `--json` flag in this namespace.

Errors are written to stderr.

The persisted credentials live in the global config file at `~/.jolli/jollimemory/config.json`. Three fields are relevant:

- `authToken` — the OAuth session token saved by `login` and cleared by `logout`.
- `jolliApiKey` — the product API key for AI summary generation; saved during `login` (when the OAuth callback issues one) and cleared by `logout`.
- `apiKey` — an optional separately configured Anthropic API key. **Not** touched by any of these subcommands.

## Behavior

### `jolli auth` (parent command)

Running `jolli auth` with no subcommand prints the help / usage block for the namespace. The parent command's description is `Sign in to Jolli to generate AI summaries without an Anthropic API key`.

### `jolli auth login`

Opens the user's browser to the configured Jolli login page and starts a local callback listener; on a successful OAuth round-trip, persists the resulting auth token (and, when the server issued one, a freshly generated product API key) to the global config.

The Jolli server URL is taken from the `JOLLI_URL` environment variable (with trailing slashes stripped) if set, otherwise a built-in default. The URL is validated against the Jolli origin allowlist before the browser is opened — a malicious `JOLLI_URL` cannot redirect the OAuth flow to an attacker-controlled host.

After a successful login, the command prints:

```
  Signed in successfully!
  Auth token:        saved ✓
  Jolli API Key:     saved ✓     (only when the OAuth callback issued an API key)
```

On failure (browser flow aborted, the callback arrived with neither a code nor a token, the nonce did not match, the code exchange timed out — it is bounded at 20 seconds — or the exchange was rejected, etc.), the command prints to stderr:

```
  Login failed: <error message>
  You can try again with 'jolli auth login'.
```

and sets the exit code to `1`. The previously persisted credentials (if any) are not touched on failure.

The command takes no flags.

### `jolli auth logout`

Clears both the auth token and the product API key from the global config in a single atomic write. **Preserves** any separately configured Anthropic API key.

After logout, the command always prints:

```
  Logged out.
  Auth token and Jolli API Key have been removed from local config.
```

If an Anthropic API key is still present (either saved in the config or supplied via the `ANTHROPIC_API_KEY` environment variable), the command additionally prints:

```
  Your Anthropic API Key is still saved and will continue to work:
    - Anthropic API Key  (remove with `jolli configure --remove apiKey`)
```

The command takes no flags. It is idempotent — running it when no credentials are stored simply produces the same "Logged out" output.

### `jolli auth status`

Prints the current authentication state for both the Jolli account session and the product API key. No network call is made — the status is read from the persisted config plus the `JOLLI_AUTH_TOKEN` environment variable (which, when set, takes priority over the saved token for the purpose of the "signed in" check).

Output layout:

```
  Jolli Auth Status
  ──────────────────────────────────────
  Jolli Account:  Signed in       (or `Not signed in`)
  Jolli API Key:  Configured      (or `Not configured`)
```

When **neither** an auth token nor a product API key is present, an additional hint is printed:

```
  No credentials configured. Run `jolli auth login` to get started.
```

The product API key is reported as a binary "Configured" / "Not configured" — the command does not print the key itself, masked or otherwise.

The command takes no flags.

## Exit Codes

| Subcommand | Code | Condition |
|------------|------|-----------|
| `login`    | `0`  | Browser flow completed successfully; credentials saved. |
| `login`    | `1`  | Browser flow failed (any error during the OAuth round-trip). |
| `logout`   | `0`  | Credentials cleared (always — no failure mode is surfaced as a non-zero exit). |
| `status`   | `0`  | Status was reported (always — including the "no credentials" case). |

## Notable Behavior

- **Anthropic key is preserved across logout.** The user's separately configured Anthropic API key is treated as an independent credential — `logout` only removes the Jolli session and the Jolli-issued product key. To remove the Anthropic key, the user is told to use `jolli configure --remove apiKey`.
- **`login` is the only subcommand that can write a Jolli API Key.** The OAuth callback is the only path where the server may issue a product API key; `status` and `logout` cannot create one. (Manual entry of a product API key is provided by other commands such as `jolli enable` and `jolli configure`, not by this namespace.)
- **`JOLLI_AUTH_TOKEN` overrides the saved token at status-check time.** A user who exports `JOLLI_AUTH_TOKEN=…` in their shell will see `Signed in` from `status` even if no token has been saved to disk. This is how CI environments and short-lived sessions can sign in without persisting state. Other surfaces honor the same precedence.
- **`JOLLI_URL` is validated.** A `JOLLI_URL` value outside the Jolli origin allowlist is rejected before the browser is opened, so the OAuth credentials cannot be socially engineered into being sent to an attacker.
- **The product API key is never displayed.** `status` reports only its presence as a boolean. There is no flag to print or unmask the key — to inspect it, the user reads the config file directly.
- **`logout` is idempotent.** Running it on a system that has no credentials produces the same output as running it after `login`. This makes scripted teardown safe.
- **`login` failures do not corrupt existing credentials.** If a user re-runs `login` after a successful prior login and the new attempt fails, the previously saved token and key remain valid.
- **There is no login-window timeout on this surface.** The local callback listener has no expiry timer: if the user never completes the browser flow, `jolli auth login` simply keeps waiting and the user aborts the command themselves. The only timeout in the flow is the 20-second bound on the code-exchange request, which surfaces as a timed-out sign-in message. (Notable; a common wrong assumption.)

## Shared Behavior

- The browser-based OAuth callback flow is shared with `jolli enable`'s credentials wizard (choice 1) and with the IDE-extension login flow.
- The Jolli origin allowlist applied to `JOLLI_URL` is the same allowlist applied to manually entered product API keys elsewhere in the CLI.
- The global config file at `~/.jolli/jollimemory/config.json` is shared with `jolli configure`, `jolli enable`, and the IDE extensions, all of which read and write the same fields.
- The "no credentials" hint that `status` prints points back at `jolli auth login`, which is the canonical entry point for both first-time and repeat sign-ins.
