---
description: Sign out of Jolli — clears the stored Jolli auth token and API key. Any Anthropic API key on disk is preserved.
---

# Jolli Logout

Clear the user's stored Jolli credentials by running the Jolli CLI through its
stable dispatch script:

```bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" auth logout
```

## Report the outcome

Show what the CLI prints. Then make the consequence clear:

- The Jolli auth token and Jolli API Key are removed from local config.
- **Memory generation stops** until the user signs in again with `/jolli:login`,
  **unless** an Anthropic API key is configured — logout preserves it, and the
  CLI will say so when one is present.
