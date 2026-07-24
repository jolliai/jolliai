---
description: Sign in to Jolli to share this repo's memories to a Space. Opens your browser to complete login. (Memory generation itself runs locally and needs no sign-in.)
---

# Jolli Login

Sign the user in to Jolli. Signing in saves the credentials Jolli needs to **bind
this repo to a Space and share memories** with teammates (a `git push` then
auto-publishes the branch's memories to the bound Space).

**Memory generation does not require signing in.** By default the Claude Code
plugin generates memories locally through your existing Claude subscription (the
`local-agent` provider) — no Anthropic API key and no Jolli account needed.
Signing in is about sharing to a Space, and it does **not** change that: after
login, summaries still run locally.

## Step 1: Run the login flow

Run the Jolli CLI through its stable dispatch script (resolves the installed
Jolli automatically — no path guessing). It opens the system browser to the
Jolli login page and waits on a local loopback callback while the user completes
sign-in:

```bash
"$HOME/.jolli/jollimemory/run-cli" auth login
```

This is interactive and can take up to a minute. Wait for it to return — do not
background it. Sign-in happens entirely in the user's browser; never ask the
user for passwords, tokens, or callback URLs.

If the command is not found, the plugin's session bootstrap has not run yet —
ask the user to fully restart the app (Cmd+Q) so the plugin installs its hooks,
then try `/jolli:login` again.

## Step 2: Report the outcome

- **Success** — the CLI prints `Signed in successfully!` with `Auth token: saved`
  and `Jolli API Key: saved`. Tell the user they can now bind this repo to a Jolli
  Space (`/jolli:init`) and share memories on push. Note that memory generation
  keeps running locally through their Claude subscription — logging in did not
  change the summary engine.
- **Failure** — the CLI prints `Login failed: <reason>`. Surface the reason and
  suggest retrying `/jolli:login`. If the browser did not open, tell the user the
  CLI also printed a login URL they can open manually.

## Note: no key required to generate memories

Memory generation works out of the box via the local Claude subscription — no
Anthropic API key, no Jolli sign-in. Sign in only when you want to share memories
to a Jolli Space, or bring your own Anthropic / Jolli key if you'd rather not use
the local subscription for summaries.
