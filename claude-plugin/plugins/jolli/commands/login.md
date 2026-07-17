---
description: Sign in to Jolli so memory generation works without an Anthropic API key. Opens your browser to complete login.
---

# Jolli Login

Sign the user in to Jolli. Logging in saves a **Jolli API Key** that powers AI
summary generation through Jolli's backend — so the user does **not** need an
Anthropic API key. This is the recommended way to enable memory generation for
a Claude Code plugin install.

## Step 1: Run the login flow

Run the Jolli CLI through its stable dispatch script (resolves the installed
Jolli automatically — no path guessing). It opens the system browser to the
Jolli login page and waits on a local loopback callback while the user completes
sign-in:

```bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" auth login
```

This is interactive and can take up to a minute. Wait for it to return — do not
background it. Sign-in happens entirely in the user's browser; never ask the
user for passwords, tokens, or callback URLs.

If the command is not found, the plugin's session bootstrap has not run yet —
ask the user to fully restart the app (Cmd+Q) so the plugin installs its hooks,
then try `/jolli:login` again.

## Step 2: Report the outcome

- **Success** — the CLI prints `Signed in successfully!` with `Auth token: saved`
  and `Jolli API Key: saved`. Tell the user memory generation is now enabled and
  that no Anthropic API key is needed. New commits will start producing memories.
- **Failure** — the CLI prints `Login failed: <reason>`. Surface the reason and
  suggest retrying `/jolli:login`. If the browser did not open, tell the user the
  CLI also printed a login URL they can open manually.

## Note: no Anthropic key required

Jolli login is the default path. An Anthropic API key is only an alternative for
users who do not want a Jolli account — it is not needed once signed in to Jolli.
