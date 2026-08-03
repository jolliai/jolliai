---
name: login
description: Sign in to Jolli from Codex so the repository can bind to a Jolli Space and share memories. Use when the user asks to log in, authenticate Jolli, connect an account, or fix missing Jolli credentials.
---

# Jolli Login

Run and wait for the interactive browser flow:

```bash
"$HOME/.jolli/jollimemory/run-cli" auth login
```

Never ask the user for passwords, API keys, callback URLs, or browser tokens.

On success, say that Jolli credentials were saved and offer `jolli:init` to bind
the repository to a Space. Clarify that local memory generation still uses the
configured local agent unless the user explicitly changes providers. On failure,
surface the command's reason and suggest retrying; if the browser did not open,
point out the login URL printed by the command. If the dispatcher does not exist,
ask the user to start a new Codex session, review the Jolli hook in `/hooks`,
and retry.
