---
description: Show Jolli Memory's installation & configuration health for this repo.
---

Report Jolli Memory's installation & configuration health for this repo. This is
a quick **environment check**, not a recall — keep the whole thing compact.

1. Call the `status` tool. Render its scalar facts as a compact **Markdown table**
   (two columns — field, value; one fact per row), in this order; omit a row only
   where noted:
   - **Version** — `version`, and whether the extension is enabled (`enabled`)
   - **Hooks** — `hooks.summary`, plus the active runtime `hooks.runtime`
   - **Data migration** — `dataMigration`
   - **Account** — signed in? (`account.signedIn`) · Jolli API key?
     (`account.jolliApiKeyConfigured`) · Anthropic key? (`account.anthropicKeyConfigured`)
   - **AI provider** — `account.aiProvider`: when it is `local-agent`, note that
     memories are generated locally through the user's Claude subscription (**no API
     key or Jolli sign-in required**); `jolli` = Jolli proxy, `anthropic` = Anthropic
     key, `null` = unset (a surface-derived default applies)
   - **Site** — `account.site` (omit this row when null)
   - **Space** — the bound Jolli Space `space.name`, plus "a `git push`
     auto-publishes this branch's memories here" (omit this row entirely when
     `space` is null / the repo isn't bound)
   - **Memory** — the `storedMemories` count, plus the orphan branch `orphanBranch`

   Then, BELOW the table under an **"AI integrations"** heading, list each detected
   integration as its own bullet, rendering the integration's `status` string
   verbatim (that string is the whole value — it already embeds the session count
   with its unit when there are any, e.g. `Claude — hook installed (9 sessions)`, or
   just `Codex — detected & enabled` when there are none; do not add a count
   yourself — there is no separate number field).
2. Call the `queue_status` tool (no wait) and add one line: memory generation is
   **idle** or **still in progress** (mention the active/stale counts only if
   non-zero).
3. Decide whether memory generation can actually run, using the **provider-aware**
   rule — a blind "any key present" check is wrong, because a pinned provider is
   only satisfied by its own credential:
   - `account.aiProvider` is `local-agent` → **can generate** (runs through the
     user's local Claude subscription; no API key or Jolli sign-in needed).
   - `account.aiProvider` is `jolli` → can generate only if
     `account.jolliApiKeyConfigured`.
   - `account.aiProvider` is `anthropic` → can generate only if
     `account.anthropicKeyConfigured`.
   - `account.aiProvider` is `null` / unset → can generate if
     `account.jolliApiKeyConfigured` OR `account.anthropicKeyConfigured`.

   (`account.signedIn` alone does NOT enable generation — an OAuth token is a sync
   credential, not a generation one.)

   **If it can generate**, do not lead with a warning — and when the provider is
   `local-agent`, do not show a not-signed-in warning at all (signing in is only for
   sharing to a Jolli Space). **If it cannot generate**, lead with a prominent
   warning that outranks every other line: memory generation is **disabled** for the
   current provider (`account.aiProvider`), so commits produce no memories. Name the
   missing piece — for example "provider is `anthropic` but no Anthropic key is set",
   "provider is `jolli` but no Jolli API key is set", or "no provider credential at
   all" — then tell the user how to fix it: set the matching key, run `/jolli:login`
   to sign in to Jolli, or switch to the local Claude subscription (no key needed).
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
"$HOME/.jolli/jollimemory/run-cli" status
```
