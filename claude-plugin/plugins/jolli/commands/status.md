---
description: Show Jolli Memory's installation & configuration health for this repo.
---

Report Jolli Memory's installation & configuration health for this repo. This is
a quick **environment check**, not a recall — keep the whole thing compact.

1. Call the `status` tool. Render what it returns as a short panel:
   - version and whether the extension is enabled
   - hooks (`hooks.summary`) and the active hook runtime (`hooks.runtime`)
   - data-migration state (`dataMigration`)
   - account: signed in?, Jolli API key?, Anthropic key?, and the site if present
   - detected AI integrations — one line each with its status and session count
   - stored-memory count and the orphan branch
2. Call the `queue_status` tool (no wait) and add one line: memory generation is
   **idle** or **still in progress** (mention the active/stale counts only if
   non-zero).
3. **If `account.signedIn` is false AND both `account.jolliApiKeyConfigured` and
   `account.anthropicKeyConfigured` are false**, lead with a prominent warning:
   memory generation is **disabled** (no credential), so commits produce no
   memories — tell the user to run `/jolli:login` to sign in to Jolli (no
   Anthropic API key needed). This outranks every other line.
4. Close with a one-line health verdict — call out anything missing (not signed
   in / no key, hook not installed, migration pending), otherwise say it looks
   healthy.

Do **not** list branches, topics, or commit summaries — that is what
`/jolli:recall` and `/jolli:search` are for; point the user there if they want
the recorded memory itself.

If the `status` MCP tool is unavailable (an older Jolli that predates it), fall
back to running the bundled CLI through its stable dispatch script (a plugin-only
user has no global `jolli` on PATH), then summarise its output:

```bash
JOLLI_DIST_PREFER_SOURCE=claude-plugin "$HOME/.jolli/jollimemory/run-cli" status
```
