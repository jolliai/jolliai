---
name: jolli
description: State-aware front door for Jolli Memory in Cursor — reads how Jolli is set up in this repository, guides first-time setup through jolli-init, reminds the user to sign in when memories cannot sync yet, then routes to recall, search, status, timeline, push, PR, or workflow actions. Use when the user invokes Jolli or asks what Jolli can do.
---

# Jolli Memory

The single front door for Jolli in Cursor. Rather than printing a static list, it
reads how Jolli is set up in THIS repository and guides the next step: incomplete
setup goes to `/jolli-init`; memories that are captured but cannot be shared yet
get a sign-in reminder; a healthy repo gets a short snapshot and a routed action.

It **never** re-implements another skill's workflow — it only reads state and
invokes an existing skill or an existing Jolli Memory tool.

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

Getting this wrong is worse here than in the other skills: Step 0 reads a failed
`test -f` as "the sessionStart hook has not run yet" and sends the user off to
restart Cursor. Run the check in the wrong shell and that advice is simply wrong.

## Step 0 — confirm this menu can route

This menu ships WITH the Jolli plugin, so it is available the moment the plugin is
installed — in every window, including Cursor's chat-first window, which starts
conversations without naming a workspace. Its presence therefore says the plugin is
installed; it says nothing about whether this session can reach Jolli's plumbing.
That is what this step checks. The menu can route if **either** holds:

- one or more Jolli Memory MCP tools are available this session, **or**
- the bundled CLI dispatcher exists:

  ```bash
  test -f "$HOME/.jolli/jollimemory/run-cli" && echo present
  ```

If **either** holds, proceed to Step 1.

The dispatcher alone is enough to run every step below — each one names a CLI
fallback. If ONLY the dispatcher is present, use it and mention once that the MCP
tools appear after the user enables the `jollimemory` server in **Customize**:
Cursor notices `.cursor/mcp.json` within a second of it being written, but a newly
discovered project server stays disconnected until it is switched on.
That is expected, not a fault.

If **neither** holds, do **not** build the menu and do **not** invoke any
`/jolli-*` skill — they share this session's plumbing and the call will fail. There
is only ONE state here, and it follows from the test above: the dispatcher is half of
that test, so neither holding means the dispatcher is absent.

That means the plugin's `sessionStart` hook has not run yet on this machine — that
hook is what writes the dispatcher. A FRESHLY INSTALLED plugin's hooks are not
registered until Cursor is fully restarted; reloading the window or starting another
chat is not enough (measured). Tell the user to **quit Cursor completely (⌘Q) and
reopen it, then start a new chat**. Do NOT tell them Jolli is uninstalled or missing:
you are reading this menu, and this menu ships with the plugin, so the plugin is
installed. Do not suggest deleting anything, and do not offer to install the CLI or
the VS Code extension — neither is the fix on this host.

Then stop — do not continue to Step 1. Do not guess at install paths.

## Step 1 — read how Jolli is set up

**Preferred (MCP):** call the Jolli Memory `status` tool with no arguments and
read:

- `enabled` — are Jolli's git hooks installed in this repository (is memory
  capture on)?
- `account.signedIn` — is the user signed in to Jolli?
- `account.jolliApiKeyConfigured` — is a stored Jolli API key present? Surfaced
  ONLY when signed OUT (a sign-in already implies a Jolli credential).
- `account.anthropicKeyConfigured` — surfaced ONLY when
  `account.aiProvider === "anthropic"`; omitted for every other provider.
- `account.aiProvider` — `"local-agent"` | `"jolli"` | `"anthropic"` | `null`.
- `account.localAgentTool` — label of the local agent CLI that generates
  summaries (e.g. "Cursor"). Surfaced ONLY when `aiProvider` is `local-agent`.
- `account.site` — the Jolli site host, for the snapshot line.
- `storedMemories` — how many memories this repository already has.
- `space` — the bound Jolli Space (`{ name }`), or `null` when unbound.

**Fallback (CLI):** if the `status` tool is unavailable, read the same facts from

```bash
JOLLI_INVOKED_VIA=skill:jolli "$HOME/.jolli/jollimemory/run-cli" status
```

If neither can be reached, skip the state-based guidance and go straight to
Step 3's menu, presented without a snapshot.

## Step 2 — guide by state (the front door)

Derive three things, mirroring the CLI's guided front door:

- **can generate memories** — provider-AWARE, NOT a blind OR of every credential:
  - `local-agent` → **yes**; summaries generate by driving the local agent CLI
    named by `account.localAgentTool` — the user's own login for whatever agent
    that field names, Cursor's on a fresh setup — with no API key and no Jolli
    sign-in. This is the plugin's default, so a freshly installed repo can already
    generate. Report the field, never assume Cursor: an agent tool the user had
    already configured is kept as-is.
  - `jolli` → yes if `account.signedIn` OR `account.jolliApiKeyConfigured`.
  - `anthropic` → yes only if `account.anthropicKeyConfigured`; a Jolli sign-in
    alone does NOT count.
  - `null` / unset → yes if `account.signedIn` OR `account.jolliApiKeyConfigured`.
- **can sync memories** = `account.signedIn` OR `account.jolliApiKeyConfigured`.
  Provider-independent: sharing to a Jolli Space always needs a **Jolli**
  credential, so an Anthropic key never satisfies it. Orthogonal to generation —
  the default `local-agent` repo generates fine while unable to sync.
- **enabled** = the `enabled` flag.

Then take exactly one branch:

- **Not fully set up** — `enabled` is false, OR memories can't be generated: lead
  with SETUP, not the menu. State in one line what is missing, then invoke the
  `jolli-init` skill, which owns enable → sign-in → bind a Space. Do not
  hand-roll those steps here. (Exception: if the user named a different specific
  action, honor that instead — see Step 3.)

- **Fully set up** — enabled AND generation possible: print a short snapshot, then
  continue to Step 3.

  ```
  ✓ signed in · <account.site> · summaries via <account.localAgentTool>
  ✓ enabled · <storedMemories> memories
  ✓ syncing · Space "<space.name>"    (ONLY when `space` is non-null; omit the whole line otherwise)

  Jolli is listening — last memory saved.
  ```

  Pick the FIRST line by state, mirroring the CLI front door's wording exactly:

  - signed in → `✓ signed in · <account.site>`, plus ` · summaries via
    <account.localAgentTool>` when `aiProvider` is `local-agent`. Drop the
    `· <site>` segment when `account.site` is null.
  - not signed in, `local-agent` → `✓ local agent set (not signed in to Jolli)`.
  - not signed in, `jolli` → `✓ Jolli API key set (not signed in to Jolli)`.
  - not signed in, `anthropic` → `✓ Anthropic API key set (not signed in to Jolli)`.

  Render the `✓ syncing · Space "<space.name>"` line **only when `space` is
  non-null**; it means a `git push` auto-publishes this branch's memories to that
  Space. When `space` is null, drop the line entirely — do not print a "not bound"
  line here (binding is `jolli-init`'s job).

  The closing `Jolli is listening — …` line uses **"last memory saved."** when
  `storedMemories` > 0, or **"your next commit is your first memory"** when it
  is 0.

### Sign-in nudge — only when **can sync** is false

Generation working does not mean memories are shared. When the user can generate
but **can sync** is false (the normal state of a fresh `local-agent` install),
add ONE line under the snapshot, mirroring the CLI front door's optional sign-in
step:

```
Sign in to Jolli to sync memories to a Space? (/jolli-login — memory generation keeps running locally either way)
```

Rules for the nudge:

- It is **non-blocking**. Never withhold the Step 3 menu waiting for an answer,
  and never report "not signed in" as broken — the repository is capturing
  memories.
- Offer it **once** per invocation. If the user declines, drop it for the rest of
  the session.
- If the user accepts, invoke the `jolli-login` skill (or `jolli-init` when they
  also want to bind a Space in the same pass). Never run `auth login` yourself
  here, and never ask for a password, token, or callback URL.
- Skip it when **can sync** is true, and inside the "Not fully set up" branch —
  there `jolli-init` already walks sign-in.

## Step 3 — route the request / present the menu

This skill takes one optional free-text argument.

- **Argument provided** → match it to exactly one action below and invoke that
  action directly, regardless of the Step 2 state — a specific request wins over
  the setup nudge. The invoked skill handles its own preconditions (for example
  `jolli-push` offers to bind a Space when the repo is unbound). Ask the user to
  choose only when the request is ambiguous or matches no action.
- **Argument absent** → after the Step 2 guidance, list the actions as plain text
  and ask the user to pick one. Bias the ordering to the state: when
  `storedMemories` is 0, lead with `jolli-init` as the FIRST option and demote
  recall / search below it, since on a fresh repo both would only return empty.
  When memories exist, lead with recall / search. Keep `jolli-init` available
  either way for re-running setup or re-binding a Space.

### Jolli skills

- `/jolli-init` — finish setup, or change the bound Space.
- `/jolli-recall` — recall current-branch context.
- `/jolli-search` — search decisions across branches.
- `/jolli-status` — inspect installation and queue health.
- `/jolli-dashboard` — open the local dashboard in a browser (machine-wide
  memories, sessions, token spend, knowledge).
- `/jolli-timeline` — show a decision topic's history.
- `/jolli-push` — publish this branch's memories to a Space.
- `/jolli-login` — sign in to Jolli so memories can sync to a Space. Surface this
  whenever **can sync** is false, even if the user did not pick it.
- `/jolli-logout` — clear the stored Jolli credentials.
- `/jolli-local-run` / `/jolli-remote-run` — run a Jolli workflow locally or on
  the Jolli backend.

Route a choice by invoking that skill; do not restate its steps here.

**Every skill above ships with this plugin**, this menu included — so none of them
can be missing while you are reading it, and `/jolli-init` neither places nor
repairs them. If one is genuinely not offered, the plugin's skills did not load for
this session at all: say that in one line and use the CLI fallback, rather than
routing to setup.

**If a `/jolli-*` skill appears TWICE**, both entries are the same skill. Four of
them (`/jolli-recall`, `/jolli-search`, `/jolli-local-run`,
`/jolli-remote-run`) are also written into `.agents/skills/` by a full
`jolli enable`, which Cursor reads as its own skills root; nothing collapses the
pair and neither shadows the other. Invoke either one and do not report a conflict.

### Jolli Memory tools (whatever is registered this session)

Surface the Jolli Memory MCP tools actually available this session — do not assume
a fixed list. Route a choice by calling the matching tool. One combination is worth
offering explicitly:

- **PR description** — call `queue_status` first, then `get_pr_description`, so
  the description covers memories that are still being generated.

If no Jolli Memory tools are registered, present just the skills above.
