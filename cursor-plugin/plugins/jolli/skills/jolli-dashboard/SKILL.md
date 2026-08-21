---
name: jolli-dashboard
description: Open the local Jolli dashboard in a browser — the machine-wide view of memories, agent sessions, token spend and knowledge across every repository Jolli tracks, plus the daily standup page. Use when the user asks for the Jolli dashboard, stats, usage, standup, or wants to browse their memories in a UI.
---

# Jolli Dashboard

Serve the local Jolli dashboard and get the user in front of it.

The dashboard is **machine-level**: it aggregates every repository Jolli has
registered on this machine, so it opens from any directory — including one that is
not a git repository, and one where Jolli Memory is switched off (that repo is
simply absent from the page).

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

## Step 1 — read the argument, if there is one

This skill takes one optional free-text argument. Recognise exactly three things in
it and ignore the rest:

- **a port** — only when the argument contains a bare run of digits (e.g. `3000`).
  Pass it as `--port <digits>`. Never interpolate any other part of the argument
  into the command line.
- **"url only" / "don't open" / "no browser"** — add `--no-open`, and report the
  URL instead of opening it. Prefer this whenever you know the host has no desktop
  session.
- **a page name** — `standup`, `memories`, `knowledge` or `graph`. This does not
  change the command; it changes which path you report in Step 3.

## Step 2 — start it in the BACKGROUND, then wait for its URL

`jolli dashboard` binds a loopback port and then **serves until it is stopped** —
it is not a command that prints something and exits. Run it in the foreground and
your tool call never returns: the harness eventually kills it, and the dashboard
dies with it. So start it detached, and additionally use your host's
"run in background" mode for shell commands when it has one.

Run this as ONE command — it launches the server, then waits for the line the
server prints once it is listening:

```bash
LOG=$(mktemp "${TMPDIR:-/tmp}/jolli-dashboard.XXXXXX")
echo "LOG $LOG"
JOLLI_INVOKED_VIA=skill:dashboard nohup "$HOME/.jolli/jollimemory/run-cli" dashboard >"$LOG" 2>&1 &
echo "PID $!"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
	URL=$(grep -o 'http://127\.0\.0\.1:[0-9]*/dashboard' "$LOG" | head -1)
	[ -n "$URL" ] && break
	sleep 1
done
if [ -n "$URL" ]; then echo "READY $URL"; else echo "NOT READY"; cat "$LOG"; fi
```

Add `--port <digits>` and/or `--no-open` from Step 1 after `dashboard`.

The log file is created fresh per launch by `mktemp` rather than at a fixed path.
That is deliberate: a fixed name under a shared `/tmp` is both a collision (two
launches truncate and read each other's log, pairing one server's PID with
another's URL) and something another user can pre-create as a symlink for this
shell to write through. Keep the printed `LOG <path>` — later steps need it, and it
is not derivable.

Read the URL out of that log rather than assuming a port: the server prefers
**1818**, falls back to **18118**, and then to any free port the OS gives it.

A launch with **no** `--port` replaces any dashboard already serving: it reclaims
both preferred ports (**1818** and **18118**) from an older Jolli dashboard before
binding. So do not look for a running one first, and do not clean anything up
afterwards.

`--port <digits>` does **not** do that — it narrows the reclaim to that one port. A
dashboard already on 1818 keeps running, and you have started a SECOND long-lived
process against the same database. Two more launches can reach the same state
without `--port`: an OS-assigned fallback port (both preferred ports were taken)
cannot be reclaimed either, since there is nothing to probe. So whenever you pass
`--port`, or the launch reports it fell back, say in one line that an earlier
dashboard may still be up and give the PID to stop it — or offer to relaunch without
`--port` instead. Do not tell the user only one can run at a time.

## Step 3 — report, or diagnose

**`READY <url>`** — the dashboard is up. Unless `--no-open` was used it has
already opened the user's default browser itself; say so in one line and give the
URL as well, so they can open it by hand if no window appeared. When the user named
a page in Step 1, give them that page's URL instead of the bare one, keeping the
port you just read:

| page | path |
| --- | --- |
| stats (default) | `/dashboard` |
| standup | `/dashboard/standup` |
| memories | `/memories` |
| knowledge | `/knowledge` |
| graph | `/graph` |

Mention once that it keeps serving in the background after this turn, and that
`kill <PID>` (the pid echoed above) stops it.

**`NOT READY`** — do NOT re-launch it blind. The log printed with it names the
cause in almost every case:

- `ERROR: node runtime not found.` — the dispatcher found neither a `node` on
  `PATH` nor an IDE-recorded runtime. Report that and stop.
- `Error: the dashboard needs Node >= 22.13 …` — the runtime is too old for
  `node:sqlite`. Report the version it names and stop; nothing about this skill can
  work around it.
- `Error: could not create the dashboard database …` or
  `could not start the dashboard …` — report the reason verbatim and stop.
- **an empty log** — it may simply still be starting (a first run migrates the
  database and imports history). Re-run just the wait loop once more — assigning
  `LOG` first to the path printed as `LOG <path>` above, since every command runs
  in a fresh shell and the name is unique per launch — before concluding anything.

If `$HOME/.jolli/jollimemory/run-cli` does not exist at all, the bundled dispatcher
has not been written yet — the plugin's session-start bootstrap is what writes it.
Tell the user to start a fresh session and retry, and stop. On Cursor say instead to
**quit Cursor completely and reopen it**: a freshly installed plugin's hooks are not
registered until then, so a window reload or another chat leaves the dispatcher
unwritten (measured). Either way, do not guess at other paths, and do not run
`node` or `npx` against a workspace-local file.
