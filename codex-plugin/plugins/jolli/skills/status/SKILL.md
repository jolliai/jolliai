---
name: status
description: Diagnose Jolli Memory installation, provider, account, hooks, queue, integrations, stored memories, and Space binding for the current repository. Use for status, health checks, missing or stale memories, setup verification, or troubleshooting.
---

# Jolli Status

1. Call the Jolli Memory `status` tool.
2. Call `queue_status` without waiting.
3. Render a compact Markdown table containing version/enabled, hooks/runtime,
   migration, provider/local agent, account credentials, bound Space, and stored
   memories. Omit unavailable optional fields.
4. List detected AI integrations below the table using their returned status text.
5. State whether memory generation is idle or still running.
6. Give a provider-aware verdict:
   - `local-agent`: ready when its tool is configured; if an auth failure is
     reported, use that tool's login remedy.
   - `jolli`: requires Jolli sign-in or a Jolli API key.
   - `anthropic`: requires an Anthropic API key.
   - unset: requires a usable provider credential.

If `status` is unavailable, run `"$HOME/.jolli/jollimemory/run-cli" status` and summarize it. Do not
list branch memories; route those requests to `jolli:recall` or `jolli:search`.
