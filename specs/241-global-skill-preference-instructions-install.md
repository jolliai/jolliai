# 241 — Global Skill-Preference Instructions Install

## Topic Statement

A marker-bracketed "prefer this memory by default" block is upserted into each detected AI host's **machine-global** instruction file, so the host's LLM reaches for the product's recall and search capabilities proactively — routing by intent rather than by a fixed skill name — instead of leaving that choice to chance.

## Scope

**In scope.** The three machine-global target files (one per host), the exact block content and its literal marker strings, the upsert resolution order (marked block → unmarked adopted section → append), the byte-for-byte no-op guarantee, per-file fail-soft error handling, host gating on install (asymmetric with the ungated removal path), the removal path's block-stripping rules, and the "never removed on uninstall" policy.

**Out of scope.** The decision of *whether* to write the block at all — the tri-state switch, the confirm prompt, the settings toggle, and the VS Code activation notification are spec 242. Per-repository skill files (a different upsert with a different guard) — spec 48; the contrast is drawn under Notable Behavior. The individual skills' body content and triggers. The broader install ordering — spec 44.

## Data Contracts

### Target files (home-relative destinations)

The block is written into exactly three files, each relative to the user's home directory:

| Host | Destination |
|------|-------------|
| Claude Code | `~/.claude/CLAUDE.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` |
| Codex | `~/.codex/AGENTS.md` |

These are machine-global files (one per host, shared by every repository on the machine), distinct from any project-root instruction file. **Rationale for exactly these three:** a global `AGENTS.md` is read only by Codex; the other hosts that consume `AGENTS.md` (Cursor, OpenCode, Copilot) read it from the *project root*, not the home directory, and so are deliberately out of reach of this global writer. There is no fourth target.

Missing parent directories are created on write. The file itself is created if absent (install path only); the removal path never creates a file.

### Literal marker strings and block content

The managed block is bracketed by two HTML-comment marker lines (HTML comments so the markers render invisibly in Markdown):

- Start marker: `<!-- >>> jolli memory instructions >>> -->`
- End marker: `<!-- <<< jolli memory instructions <<< -->`

The block also leads with a managed Markdown heading immediately after the start marker:

- Managed heading: `## Jolli Memory`

The full rendered block, in order, is these lines joined with a plain newline (`\n`, never the platform EOL, so a team sharing dotfiles across operating systems sees an identical file) plus a single trailing newline:

```
<!-- >>> jolli memory instructions >>> -->
## Jolli Memory

This repository may have **Jolli Memory** enabled — a durable record of past
development the current code cannot show: why choices were made, how a topic was
handled before, what was already tried, and where work stopped. Treat it as a
first-class source and reach for it **proactively — before answering or guessing,
and even when the user never names Jolli** — whenever a request is memory-shaped
(about intent, history, or prior work). Its reads are read-only and cheap, so
lean toward consulting memory rather than guessing: a hit often changes the
answer, and a miss costs little.

Two capabilities are available; invoke whichever recall / search skill or tool is
registered in this session — the exact name varies by host (a plugin skill, a
project skill, or e.g. an `mcp__jollimemory__*` MCP tool), so route by intent, not
by a fixed name:

- **Recall** — deep context for one branch (the current branch by default): its
  decisions, a recap, and where work left off.
- **Search** — full-text lookup across *all* branches: decisions, topics, files.

Consult memory FIRST, before answering from your own assumptions, when the request
is memory-shaped:

- **Why / intent** — "why is this like this", "why X and not Y", "what was the
  reasoning", or anything where the code shows *what* but not *why*. → Search (or
  Recall when it's about the current branch).
- **How it works / design** — "how does X work", "how is X built/designed", "how
  would I implement X", or walking through / extending an existing feature or
  subsystem in this repo. The code shows the mechanism; memory holds why it is
  shaped that way and what was already tried. → Search (or Recall for the current
  branch). A quick lookup here is cheap and often surfaces rationale and pitfalls
  the code comments don't — so search even though the ask starts with "how".
- **Prior art** — "have we done/hit this before", "how was <topic> handled", "is
  there a pattern for this", "where else do we do X", or a bug that may have been
  seen before. → Search (decisions / topics / files across ALL branches).
- **Resume** — "where were we", "pick up where I left off", "what's left on this
  branch", or returning to work after a break. → Recall (current-branch decisions
  + recap + where work stopped).
- **Before non-trivial edits** — before refactoring, changing, or deleting code
  whose intent isn't obvious from the code itself, search memory first; a past
  decision may constrain the change, and skipping this risks re-breaking what a
  prior fix already addressed.

Routing: current-branch history or resume → Recall; cross-branch or "has this
come up before" → Search. When unsure whether memory helps, run a quick search
first before answering from your own assumptions.

Do NOT reach for memory on narrow, current-state facts you can read straight from
the code — one function's behavior, a type or signature, running a command, a
rename, formatting, or a literal text lookup — answer those from the code directly.
That exclusion is for single-symbol lookups only; do not let it swallow a
whole-feature "how does it work / how is it designed" question — that is
design-shaped, so search memory first (per the How it works / design rule above).

Treat any concrete fact memory states as of-its-time: use it for why / intent /
prior context, but verify names, paths, and code shape against the current code
before relying on them. If no Jolli memory capability is registered here (Jolli
Memory not enabled in this repo), fall back to normal behavior.
<!-- <<< jolli memory instructions <<< -->
```

The body names **two capabilities by intent — Recall and Search — and deliberately no skill or tool names.** Instead of routing each trigger to a fixed skill name, it instructs the host to invoke whichever recall / search skill *or tool* is registered in the current session, stating explicitly that the registered name varies by host (a plugin skill, a project skill, or a namespaced tool) and that the host must therefore **route by intent, not by a fixed name**. There is no pull-request bullet: PR authoring no longer has a skill to route to (spec 211).

Around those two capabilities the body carries: an opening framing paragraph establishing memory as a first-class source to be consulted **proactively** — before answering or guessing, and even when the user never names the product — on the grounds that reads are cheap and read-only; a "consult memory FIRST" list of five memory-shaped request categories (why/intent, how-it-works/design, prior art, resume, and before-non-trivial-edits) each routed to Recall or Search; a one-line routing summary (current-branch history or resume → Recall; cross-branch or "has this come up before" → Search); an explicit **negative** rule excluding narrow current-state lookups (one function's behavior, a signature, a command, a rename, formatting, a literal text search) with a carve-out forbidding that exclusion from swallowing whole-feature design questions; and a closing pair of caveats — treat any concrete fact memory states as of-its-time and verify names and paths against current code, and **if no Jolli memory capability is registered here, fall back to normal behavior.**

### Host gating flags (install only)

Install consults a per-host boolean set — one flag each for Claude, Gemini, and Codex. A target file is written only when its host's flag is true. See Behavior → Host gating for how each flag is derived.

## Behavior

### Upsert into one file

For a single target file, the block is merged into the existing content (or empty string when the file is absent) by the following resolution order. All content outside the region touched is preserved verbatim.

1. **Existing marker pair → replace in place.** If both the start marker line and the end marker line are present as whole lines (line-oriented exact match, so a stray marker substring buried inside prose never confuses the parser), and the end marker appears after the start marker, everything from the start marker through the end marker (inclusive) is replaced by the new block. The **first** matching pair wins.
2. **No markers, but an unmarked managed heading exists → adopt in place.** Older documentation told users to paste the `## Jolli Memory` section by hand. If a whole line exactly equal to the managed heading is found, the entire section it introduces is replaced by the marked block — never duplicated. The section runs from the heading line up to (but not including) the next line that is a Markdown heading of equal-or-higher level (a line beginning with `#` or `##` followed by a space), or to end-of-file if there is none. Deeper subsections (`###` and beyond) stay inside the adopted section. A single newline separator is inserted before the block only when there is content preceding the replaced section; the block's own trailing newline separates it from any content that followed the section.
3. **Neither → append.** The block is appended to the existing content. Exactly one newline separates the prior content from the block: when the existing content already ends in a newline the block follows immediately on the next line (no blank line is inserted); when it does not, one newline is inserted first. An empty file yields the block alone.

### Byte-for-byte no-op

After computing the merged content, if it is identical to what was already on disk, no write occurs. Re-running install when the block is already current and unchanged touches nothing.

### Per-file fail-soft

Each file is handled independently and can never throw:

- **Read.** A missing file (does-not-exist) is treated as empty content and proceeds to the upsert. Any other read error (permission denied, path is a directory, …) is logged and the file is skipped — no write is attempted.
- **Write.** Directory creation and file write failures (read-only filesystem, permission denied) are logged and swallowed.

A broken, read-only, or otherwise unwritable global file therefore never fails the enable operation; at worst that one host's block is skipped.

### Host gating (install)

The install pass iterates the three targets and writes each only when its host flag is true. The flags are derived asymmetrically:

- **Claude** — gated purely on the enable toggle: written whenever Claude is not explicitly disabled. There is no filesystem detector for Claude (it is treated as the primary host), so `~/.claude/CLAUDE.md` is created even on a machine where no Claude installation is detected, as long as the user has not explicitly disabled Claude.
- **Gemini** — gated on detection AND its enable toggle: written only when a Gemini installation is detected and Gemini is not explicitly disabled. Never creates `~/.gemini/GEMINI.md` on a machine without Gemini.
- **Codex** — gated on detection AND its enable toggle: written only when a Codex installation is detected and Codex is not explicitly disabled. Never creates `~/.codex/AGENTS.md` on a machine without Codex.

### Removal

The removal pass strips the block from a file:

- Locate the first whole-line start-marker / end-marker pair (same line-oriented match as the upsert). If no valid pair is present, the content is returned unchanged (idempotent no-op).
- Remove everything from the start marker through the end marker inclusive. Additionally, if the line immediately before the start marker is blank, that one blank line is removed too — so a block that was appended after a separator does not leave a dangling empty line behind.
- Read/write failures are fail-soft exactly as on the install path; a missing file is a no-op and is never created.

**Removal is UNGATED across all three hosts.** Unlike install, removal does not consult the per-host flags: it runs on all three files unconditionally. A user who opts out must have the block erased everywhere it might have been written — including a host they have since disabled or that is no longer detected.

### When it runs

The install-side sync of this block runs **once** during the install operation, outside the per-worktree loop, because these files are machine-global. It runs even in integrations-only mode (the block is an integration/skill-preference, not a hook). Its position in the overall install sequence — after global MCP registration, before git-hook install — and the tri-state decision that precedes it are covered by specs 44 and 242.

## State Transitions

Per target file:

- **No file / empty file**, host gated in → block written alone (or created).
- **File without markers and without the managed heading**, gated in → block appended.
- **File with an unmarked hand-pasted `## Jolli Memory` section**, gated in → that section replaced by the marked block (adopted, not duplicated).
- **File already carrying the current block**, gated in → no-op (byte-for-byte identical).
- **File carrying a stale/older block**, gated in → block replaced in place.
- **Any state, removal** → first marker pair (and one preceding blank line) stripped; no markers → unchanged.

## Notable Behavior

- **The block names no skills and no tools — it routes by intent.** It describes exactly two capabilities (Recall and Search) and tells the host to invoke whichever recall / search skill or tool is registered in the current session, because the registered name legitimately differs per host (a plugin skill, a project skill, or a namespaced tool). This is what keeps one machine-global file correct across hosts that expose the same capability under different names, and what keeps the block from going stale whenever a skill is renamed or retired. (Load-bearing.)
- **The block asks for proactive use, not merely preference.** It instructs the host to consult memory **before answering or guessing, and even when the user never names the product**, on the stated grounds that reads are read-only and cheap — a hit often changes the answer and a miss costs little. It pairs that with an explicit negative rule (do not reach for memory on narrow current-state lookups) and a carve-out preventing that exclusion from swallowing whole-feature design questions, so "proactive" does not degrade into "on every request".
- **The closing fallback no longer assumes a *skill*.** It is conditioned on no Jolli memory *capability* being registered, which is what makes the block correct on a host where the capability arrives only as a tool and no skill document exists at all.
- The "first marker pair wins" and whole-line matching mean a user can safely quote the marker text inside their own prose without corrupting the parser.
- Because gating is applied only on the install path and not the removal path, the two are deliberately asymmetric: the product may decline to *write* a host's block (host absent/disabled) yet still *remove* it from that same host later.
- Machine-global scope drives the uninstall policy: **uninstall does NOT touch these files.** This mirrors the "global-scope MCP registration is never removed on uninstall" policy — a single-repo uninstall must not strip a machine-wide preference that other repos still rely on. Removal happens only through an explicit opt-out decision (spec 242), never through the standard uninstall flow.
- The newline-join is fixed to `\n` regardless of platform, by design, so dotfile-syncing teams see identical bytes across operating systems.

## Shared Behavior

- The marker-bracketed managed-block upsert strategy (preserve everything outside the markers, replace what's inside) is the same convention used for the git local-exclude block and the git-hook sections.
- **Contrast with per-repo skill files (spec 48).** Both write skill-related instruction files, but the mechanisms differ: this spec upserts a *marker-bracketed block into a machine-global file shared by every repo*, keyed on marker presence with no version comparison; spec 48 writes a *whole per-repository file* guarded by an embedded template-version sentinel. This global block is never removed on uninstall (like global MCP); per-repo skill files are also left on uninstall but for a different reason (avoiding deletion of user-authored skills under the same roots).
- The decision of whether this install-side sync writes, removes, or does nothing — and the confirm/notification/toggle surfaces that drive it — is spec 242.
