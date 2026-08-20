---
name: jolli-login
description: Sign in to Jolli from Cursor so the repository can bind to a Jolli Space and share memories. Use when the user asks to log in, authenticate Jolli, connect an account, or fix missing Jolli credentials.
---

# Jolli Login

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

Run and wait for the interactive browser flow:

```bash
JOLLI_INVOKED_VIA=skill:login "$HOME/.jolli/jollimemory/run-cli" auth login
```

Never ask the user for passwords, API keys, callback URLs, or browser tokens.

On success, say that Jolli credentials were saved and offer `/jolli-init` to bind
the repository to a Space. Clarify that local memory generation still uses the
configured local agent unless the user explicitly changes providers. On failure,
surface the command's reason and suggest retrying; if the browser did not open,
point out the login URL printed by the command.

If `$HOME/.jolli/jollimemory/run-cli` does not exist, the plugin's `sessionStart`
hook has not run on this machine yet — that hook is what writes it. Ask the user to
**quit Cursor completely (⌘Q) and reopen it, then start a new chat**, and retry. A
freshly installed plugin's hooks are not registered until the app has been fully
restarted, so **Developer: Reload Window** or another chat is not enough (measured).
