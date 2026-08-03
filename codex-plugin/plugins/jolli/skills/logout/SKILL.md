---
name: logout
description: Sign out of Jolli from Codex by clearing the stored Jolli auth token and Jolli API key while preserving other provider credentials. Use when the user asks to log out, disconnect Jolli, or remove Jolli account credentials.
---

# Jolli Logout

Run:

```bash
"$HOME/.jolli/jollimemory/run-cli" auth logout
```

Report the command output, then call the Jolli Memory `status` tool when
available. Explain the provider-aware result:

- Space binding and cloud sharing require a future Jolli sign-in.
- `local-agent` memory generation continues through the configured
  Codex, Claude Code, Cursor, OpenCode, or Kimi Code login.
- `anthropic` generation continues when its preserved Anthropic key exists.
- `jolli` generation stops unless another Jolli API key remains configured.

If the dispatcher does not exist, ask the user to start a new Codex session,
review the Jolli hook in `/hooks`, and retry.
