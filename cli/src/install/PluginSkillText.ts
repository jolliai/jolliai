/**
 * Skill text shared across the surfaces that write SKILL.md files — the installed
 * copies `SkillInstaller` upserts and the STATIC copies the plugin bundles commit
 * (`CodexPluginSkills`, `CursorPluginSkills`).
 *
 * Two kinds of thing live here. The frontmatter transforms are extracted rather
 * than duplicated because both plugin hosts need the identical adaptations and both
 * are covered by a drift test that compares a builder's output against a committed
 * file — so a divergence between two copies would surface as an unexplained diff in
 * one plugin's `SKILL.md` and nowhere else. {@link SHELL_PREREQUISITE_BLOCK} is here
 * for a structural reason instead: `SkillInstaller` imports `CursorPluginSkills` (for
 * the umbrella the Cursor mirror writes), so the block could not live in either of
 * them without closing a cycle. This module imports nothing, which is what makes it
 * a safe home.
 *
 * The transforms are line-based rather than a YAML round-trip: the templates have a
 * fixed generated shape, and re-serializing risks reflowing the long `description`
 * values in ways that fail those drift tests for purely cosmetic reasons.
 */

/**
 * The Windows shell-prerequisite block shared by every shell-backed skill. It
 * pins Git Bash on Windows because the `run-cli` entry script is written via
 * Windows Node's `os.homedir()` to `%USERPROFILE%\\.jolli\\jollimemory\\run-cli`,
 * and only Git Bash's `$HOME` aligns with `%USERPROFILE%` — PowerShell / WSL bash
 * see a different home and won't find the script.
 *
 * **The trigger is shelling `run-cli`, not the here-doc.** Easy to get backwards,
 * because the block was written for the arg-carrying here-doc skills and mentions
 * their security recipe — but the local-run recipe (fixed `run-cli` subcommands, no
 * here-doc) carries it for the same reason, and so do the Cursor plugin's
 * setup/account skills. A skill that only calls MCP tools does not need it; a skill
 * that shells this path does, whatever it passes.
 *
 * PowerShell is the case worth stating, since it looks like it should work: it
 * defines `$HOME` too, so the path expands to something real and the failure is a
 * plain "not recognized" on an extensionless bash script rather than an unset
 * variable.
 */
export const SHELL_PREREQUISITE_BLOCK = `### Shell prerequisite

This block requires a POSIX bash shell. On Linux/macOS the system bash works.
**On Windows, use Git Bash** (the bash bundled with Git for Windows). Other
Windows "bash" options — \`C:\\Windows\\System32\\bash.exe\`, the WindowsApps
alias, or any WSL bash — see a separate Linux home directory and will not
find the Jolli entry script that lives under \`%USERPROFILE%\`.

If Git Bash is not available on Windows, STOP and tell the user:
"Jolli skill needs Git Bash on Windows. Install Git for Windows from
https://git-scm.com/download/win and retry."

Do NOT fall back to \`npm run\`, \`npx\`, \`node\` directly, PowerShell-native
commands, WSL bash, or any workspace-local script — those bypass the
security recipe and the dist resolver and will not produce valid output.`;

/**
 * Append a host's dispatcher-recovery note to a bundled body that does not already
 * answer for this host — the third transform each plugin renderer adds, parameterised
 * because the SHAPE is shared and the remedy is not.
 *
 * The problem is one both bundles inherited by shipping the four host-neutral skills.
 * Those bodies are authored for `.agents/skills/`, where "Jolli not installed — install
 * `@jolli.ai/cli` globally or the Jolli VS Code extension" is the correct answer,
 * because on such a host there is no plugin and installing the product really is the
 * fix. Inside a plugin bundle it is the wrong answer twice over: Jolli IS installed, and
 * the dispatcher those bodies test for is written by a bootstrap hook whose own gate is
 * what has not been passed yet — a full Cursor restart there, a trusted SessionStart
 * hook on Codex. A user who follows the host-neutral advice installs a second copy of
 * the product to fix a plugin that is one step from working.
 *
 * Fixing it in the shared builders was the alternative and is wrong for the same reason
 * their text is right where it lives. The correction belongs to the copy that ships
 * inside a plugin, which is what a renderer produces.
 *
 * Two rules, both load-bearing:
 *
 *  - **`marker` is a phrase the host's OWN bodies already use**, not a skill-name list.
 *    A body that answers for this host in its own words must count as handled, or it
 *    silently collects a second, contradictory section. Each bundle's drift test derives
 *    the expectation from the body for the same reason the `SHELL_PREREQUISITE_BLOCK`
 *    test does: a skill that grows a `run-cli` call later cannot slip past.
 *  - **The trigger is shelling `run-cli`**, since that is the only thing the note is
 *    about. `timeline` and `push` are MCP-only in both bundles and correctly get nothing.
 *
 * Called LAST by each renderer, after any sibling-name rewrite. Codex's rewrite is a
 * plain substring replace over the four prefixed skill names, so appending afterwards
 * keeps the note out of its reach rather than relying on the section never containing
 * one of those strings.
 */
export function appendDispatcherRecovery(
	body: string,
	recovery: { readonly marker: string; readonly section: string },
): string {
	if (!body.includes(RUN_CLI_DISPATCHER_PATH)) return body;
	if (body.includes(recovery.marker)) return body;
	return `${body.replace(/\n+$/u, "")}\n${recovery.section}`;
}

/**
 * The dispatcher path as it appears in every body that shells it.
 *
 * A fragment rather than the full `"$HOME/.jolli/jollimemory/run-cli"` expression: the
 * skills spell the prefix several ways (`$HOME`, `~`, `%USERPROFILE%`), and what the
 * predicate asks is only whether this body reaches the dispatcher at all.
 */
const RUN_CLI_DISPATCHER_PATH = ".jolli/jollimemory/run-cli";

/**
 * Strips the `metadata:` block from a canonical template's frontmatter, leaving
 * `name` and `description` — the two fields both hosts document as required.
 *
 * The block exists for SkillInstaller's on-disk upsert, which compares revisions
 * before overwriting a user's file. Plugin-bundled skills are never upserted, so it
 * is inert here — and its `version` is a build-time define, so committing it would
 * either bake in a stale string or churn these files on every release. Both hosts
 * tolerate extra frontmatter keys, so this is about not shipping meaningless
 * content, not compatibility.
 */
export function stripMetadataBlock(template: string): string {
	const lines = template.split("\n");
	if (lines[0] !== "---") return template;
	const end = lines.indexOf("---", 1);
	if (end === -1) return template;

	const frontmatter: string[] = [];
	let skipping = false;
	for (const line of lines.slice(1, end)) {
		if (line === "metadata:") {
			skipping = true;
			continue;
		}
		// Entries under `metadata:` are indented; the next unindented key ends the block.
		if (skipping && /^\s+\S/u.test(line)) continue;
		skipping = false;
		frontmatter.push(line);
	}
	return ["---", ...frontmatter, "---", ...lines.slice(end + 1)].join("\n");
}

/**
 * Rewrites the frontmatter `name` so it equals the plugin's bundle directory.
 *
 * Kept equal on purpose: both hosts document `name` as required, and which of the
 * two seeds the model-visible invocation name is not specified anywhere we can rely
 * on, so a mismatch would be a guess. A no-op when the template already agrees —
 * which is the normal case for the Cursor bundle, whose directories keep the
 * canonical `jolli-` prefix.
 */
export function setFrontmatterName(template: string, name: string): string {
	const lines = template.split("\n");
	if (lines[0] !== "---") return template;
	const end = lines.indexOf("---", 1);
	if (end === -1) return template;
	const index = lines.findIndex((line, i) => i > 0 && i < end && line.startsWith("name: "));
	if (index === -1) return template;
	lines[index] = `name: ${name}`;
	return lines.join("\n");
}

/**
 * The shared `dashboard` skill body, used verbatim by both plugin bundles.
 *
 * One body rather than a per-host pair, unlike the setup/account skills beside it:
 * this one names no sibling skill and no host-specific plumbing, so a Codex copy and
 * a Cursor copy would differ only in the frontmatter `name` — which each bundle's
 * renderer already rewrites to its own directory name. A second copy would have no
 * lockstep guard of any kind (each drift test compares ONE builder against ONE
 * committed file, so two builders drift together silently), which is the failure the
 * `localAgentLoginList` helpers in both bundles exist to avoid.
 *
 * Frontmatter carries `name` / `description` only. It is bundled, never upserted, so
 * the revision-guarded `metadata:` block would be inert (`stripMetadataBlock` is a
 * no-op on it) — and the Claude plugin's hand-written copy is a fourth, independent
 * document in that bundle's own voice, exactly like its `recall` / `search` / `push`.
 *
 * Two properties of `jolli dashboard` shape the whole recipe and are easy to get
 * wrong from the command's name alone. It is a FOREGROUND server that serves until
 * it is signalled, so an agent that runs it plainly blocks its own tool call until
 * the harness kills it — taking the server with it. And it is MACHINE-level: it
 * aggregates every registered repo and needs no git worktree, so there is nothing to
 * check about the current directory before running it.
 */
export function buildDashboardSkillTemplate(): string {
	return `---
name: jolli-dashboard
description: Open the local Jolli dashboard in a browser — the machine-wide view of memories, agent sessions, token spend and knowledge across every repository Jolli tracks, plus the daily standup page. Use when the user asks for the Jolli dashboard, stats, usage, standup, or wants to browse their memories in a UI.
---

# Jolli Dashboard

Serve the local Jolli dashboard and get the user in front of it.

The dashboard is **machine-level**: it aggregates every repository Jolli has
registered on this machine, so it opens from any directory — including one that is
not a git repository, and one where Jolli Memory is switched off (that repo is
simply absent from the page).

${SHELL_PREREQUISITE_BLOCK}

## Step 1 — read the argument, if there is one

This skill takes one optional free-text argument. Recognise exactly three things in
it and ignore the rest:

- **a port** — only when the argument contains a bare run of digits (e.g. \`3000\`).
  Pass it as \`--port <digits>\`. Never interpolate any other part of the argument
  into the command line.
- **"url only" / "don't open" / "no browser"** — add \`--no-open\`, and report the
  URL instead of opening it. Prefer this whenever you know the host has no desktop
  session.
- **a page name** — \`standup\`, \`memories\`, \`knowledge\` or \`graph\`. This does not
  change the command; it changes which path you report in Step 3.

## Step 2 — start it in the BACKGROUND, then wait for its URL

\`jolli dashboard\` binds a loopback port and then **serves until it is stopped** —
it is not a command that prints something and exits. Run it in the foreground and
your tool call never returns: the harness eventually kills it, and the dashboard
dies with it. So start it detached, and additionally use your host's
"run in background" mode for shell commands when it has one.

Run this as ONE command — it launches the server, then waits for the line the
server prints once it is listening:

\`\`\`bash
LOG=$(mktemp "\${TMPDIR:-/tmp}/jolli-dashboard.XXXXXX")
echo "LOG $LOG"
nohup "$HOME/.jolli/jollimemory/run-cli" dashboard >"$LOG" 2>&1 &
echo "PID $!"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
	URL=$(grep -o 'http://127\\.0\\.0\\.1:[0-9]*/dashboard' "$LOG" | head -1)
	[ -n "$URL" ] && break
	sleep 1
done
if [ -n "$URL" ]; then echo "READY $URL"; else echo "NOT READY"; cat "$LOG"; fi
\`\`\`

Add \`--port <digits>\` and/or \`--no-open\` from Step 1 after \`dashboard\`.

The log file is created fresh per launch by \`mktemp\` rather than at a fixed path.
That is deliberate: a fixed name under a shared \`/tmp\` is both a collision (two
launches truncate and read each other's log, pairing one server's PID with
another's URL) and something another user can pre-create as a symlink for this
shell to write through. Keep the printed \`LOG <path>\` — later steps need it, and it
is not derivable.

Read the URL out of that log rather than assuming a port: the server prefers
**1818**, falls back to **18118**, and then to any free port the OS gives it.

A launch with **no** \`--port\` replaces any dashboard already serving: it reclaims
both preferred ports (**1818** and **18118**) from an older Jolli dashboard before
binding. So do not look for a running one first, and do not clean anything up
afterwards.

\`--port <digits>\` does **not** do that — it narrows the reclaim to that one port. A
dashboard already on 1818 keeps running, and you have started a SECOND long-lived
process against the same database. Two more launches can reach the same state
without \`--port\`: an OS-assigned fallback port (both preferred ports were taken)
cannot be reclaimed either, since there is nothing to probe. So whenever you pass
\`--port\`, or the launch reports it fell back, say in one line that an earlier
dashboard may still be up and give the PID to stop it — or offer to relaunch without
\`--port\` instead. Do not tell the user only one can run at a time.

## Step 3 — report, or diagnose

**\`READY <url>\`** — the dashboard is up. Unless \`--no-open\` was used it has
already opened the user's default browser itself; say so in one line and give the
URL as well, so they can open it by hand if no window appeared. When the user named
a page in Step 1, give them that page's URL instead of the bare one, keeping the
port you just read:

| page | path |
| --- | --- |
| stats (default) | \`/dashboard\` |
| standup | \`/dashboard/standup\` |
| memories | \`/memories\` |
| knowledge | \`/knowledge\` |
| graph | \`/graph\` |

Mention once that it keeps serving in the background after this turn, and that
\`kill <PID>\` (the pid echoed above) stops it.

**\`NOT READY\`** — do NOT re-launch it blind. The log printed with it names the
cause in almost every case:

- \`ERROR: node runtime not found.\` — the dispatcher found neither a \`node\` on
  \`PATH\` nor an IDE-recorded runtime. Report that and stop.
- \`Error: the dashboard needs Node >= 22.13 …\` — the runtime is too old for
  \`node:sqlite\`. Report the version it names and stop; nothing about this skill can
  work around it.
- \`Error: could not create the dashboard database …\` or
  \`could not start the dashboard …\` — report the reason verbatim and stop.
- **an empty log** — it may simply still be starting (a first run migrates the
  database and imports history). Re-run just the wait loop once more — assigning
  \`LOG\` first to the path printed as \`LOG <path>\` above, since every command runs
  in a fresh shell and the name is unique per launch — before concluding anything.

If \`$HOME/.jolli/jollimemory/run-cli\` does not exist at all, the bundled dispatcher
has not been written yet — the plugin's session-start bootstrap is what writes it.
Tell the user to start a fresh session and retry, and stop. On Cursor say instead to
**quit Cursor completely and reopen it**: a freshly installed plugin's hooks are not
registered until then, so a window reload or another chat leaves the dispatcher
unwritten (measured). Either way, do not guess at other paths, and do not run
\`node\` or \`npx\` against a workspace-local file.
`;
}
