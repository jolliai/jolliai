---
name: jolli-logout
description: Sign out of Jolli from Cursor by clearing the stored Jolli auth token and Jolli API key while preserving other provider credentials. Use when the user asks to log out, disconnect Jolli, or remove Jolli account credentials.
---

# Jolli Logout

### Shell prerequisite

This block requires a POSIX bash shell. On Linux/macOS the system bash works.
**On Windows, use Git Bash** (the bash bundled with Git for Windows). Other
Windows "bash" options — `C:\Windows\System32\bash.exe`, the WindowsApps
alias, or any WSL bash — see a separate Linux home directory and will not
find the Jolli entry script that lives under `%USERPROFILE%`.

If Git Bash is not available on Windows, STOP and tell the user:
"Jolli skill needs Git Bash on Windows. Install Git for Windows from
https://git-scm.com/download/win and retry."

Do NOT fall back to `npm run`, `npx`, `node` directly, PowerShell-native
commands, WSL bash, or any workspace-local script — those bypass the
security recipe and the dist resolver and will not produce valid output.

Run:

```bash
JOLLI_INVOKED_VIA=skill:logout "$HOME/.jolli/jollimemory/run-cli" auth logout
```

Report the command output, then call the Jolli Memory `status` tool when
available. Explain the provider-aware result:

- Space binding and cloud sharing require a future Jolli sign-in.
- `local-agent` memory generation continues through the configured
  Cursor, Claude Code, Codex, OpenCode, or Kimi Code login.
- `anthropic` generation continues when its preserved Anthropic key exists.
- `jolli` generation stops unless another Jolli API key remains configured.

If `$HOME/.jolli/jollimemory/run-cli` does not exist, the plugin's `sessionStart`
hook has not run on this machine yet — that hook is what writes it. Ask the user to
**quit Cursor completely (⌘Q) and reopen it, then start a new chat**, and retry. A
freshly installed plugin's hooks are not registered until the app has been fully
restarted, so **Developer: Reload Window** or another chat is not enough (measured).
