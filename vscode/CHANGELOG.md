# Changelog

<!-- Last synced commit: ff796b6a5 | 2026-04-13 -->

## 0.98.0

- **Sign in with Jolli** — one-click browser-based OAuth sign-in / sign-out from the sidebar STATUS panel, bringing the unified Jolli account flow (shared with the new `jolli auth` CLI commands) into the extension — no more copy-pasting API keys to get started
- **Push to local folder** — new Local Memories section in Settings saves memory Markdown files to a folder you pick; choose "Push to Jolli only" or "Push to Jolli & Local" as the default Push action
- **Live Plans panel** — plans refresh automatically as they're added, updated, or completed — no reload needed
- **Worktree-aware branch tracking** — HEAD changes are detected reliably across git worktrees, so the current branch and its memories stay accurate when you switch checkouts
- **Clearer installer + doctor output** — the installer is split into focused modules and `doctor` now reports a more actionable health summary
- **Cleaner install / enable** — `sessions.json` is bootstrapped on install, the legacy onboarding-state flag is gone, and multi-IDE hook conflicts across Claude / Codex / Gemini are resolved
- Bug fixes

## 0.97.3

- **Memories panel** — a new sidebar panel that lists every stored memory with instant search and filter, plus a "Load More" button for long branches
- **Export to Documents** — memory Markdown files now save to `~/Documents/jollimemory/` so they're easier to find and share
- **Simpler Settings** — the Project/Global scope switch is gone; your API key, model, and filters are always global and shared across every project
- **Smoother install** — enabling/disabling is more reliable; clearer STATUS messages when hooks are in a half-installed state
- Bug fixes

## 0.97.2

- Minor text changes

## 0.97.1

- **Notes support** — add a new Notes system for storing Markdown notes and inline snippets, with commit association and archive support
- **Unified Plans + Notes view** — the Summary panel now shows plans and notes together, with a single add menu and inline snippet creation flow
- **Push notes to Jolli** — each note (Markdown file or text snippet) uploads as a separate article to your Jolli Space
- Bug fixes

## 0.96.1

- **Agent workflow skills** — added `jolli-memory-recall` skill for recalling prior development context in agent-assisted workflows

## 0.96.0

- **Settings panel** — API key, model selection, Jolli API key, and exclude filter are now consolidated into a single Settings page accessible from the sidebar gear icon
- **Scope switching** — toggle between Project and Global scope in the Settings panel; Apply Changes is enabled immediately after switching scope
- **Integration management** — enable or disable Claude, Codex, and Gemini integrations from Settings; hooks are automatically installed or removed on save
- **Accurate session count** — STATUS panel now only counts sessions from enabled integrations and includes Codex sessions discovered on-demand
- **Simplified menus** — removed separate commands for "Set API Key", "Select Model", "Set Jolli API Key", and "Edit Exclude Filter" in favor of the unified Settings panel
- Bug fixes

## 0.95.2

- **Multi-scope installation** — choose between Global and Project scope when enabling; smart default based on existing configuration
- **Worktree auto-install** — new worktrees automatically get hooks installed, no manual enable needed
- **Shared API keys** — API keys configured globally are now visible across all projects and scopes
- **Scope indicator** — STATUS panel shows the current installation scope
- Bug fixes

## 0.95.1

- **No CLI subprocess** — `enable`, `disable`, and `status` now call Installer functions directly instead of spawning a `node dist/Cli.js` subprocess, eliminating spawn failures on restrictive environments and reducing activation latency
- **StopHook diagnostics** — logs received `session_id` and `transcript_path` on each stop event; on `sessions.json` write failure, logs the error code (e.g. `EACCES`, `ENOENT`) and full stack trace for easier debugging

## 0.95.0

- **Smaller package** — JS minification reduces VSIX size from ~600KB to ~480KB
- **Marketplace ready** — added keywords, PNG icon, license, homepage
- **Removed legacy config** — cleaned up deprecated `allowInsecureTls` and `jolliBaseUrl` fields

## 0.94.3

- **Gemini CLI integration** — session tracking via `AfterAgent` hook, transcript parsing, cross-platform support
- **PR body streamlining** — simplified PR description with auto-truncation for GitHub's body size limit
- **Push/Delete security** — API key ownership enforcement on server-side routes

## 0.94.2

- **Plan translation** — 🌐 button translates non-English plans to English via LLM
- **Transcript storage** — raw AI conversation fragments saved to orphan branch alongside summaries
- **README & docs update** — updated to reflect Claude + Codex + Gemini support

## 0.94.1

- **All Conversations** — new "Private Zone" at the top of the WebView with session stats and privacy notice
- **Transcript modal** — tab-based session switching, Markdown rendering, per-entry and per-session delete/restore
- **Conversation management** — browse, edit, and manage raw AI transcripts across Claude, Codex, and Gemini sessions

## 0.93

- **Read-only plan preview** — clicking a committed plan opens a rendered markdown preview (VSCode native)
- **WebView inline plan editing** — Edit button expands a textarea; Save writes directly to orphan branch without local cache
- **Plan title link** — plan titles in the summary WebView are clickable links that open the preview

## 0.92

- **docId-based push** — replaced JRN upsert with server-side `docId` for direct article update; stable across squash/rebase
- **Orphaned article cleanup** — superseded article IDs tracked automatically; cleaned up on next push
- **Plugin version gate** — server rejects outdated plugins with 426 status and modal error dialog

## 0.91

- **Push plans to Jolli** — plans uploaded as separate articles in a "Plans" subfolder; URLs shown under Jolli Memory row
- **Codex CLI integration** — session discovery from `~/.codex/sessions/`, Codex-specific transcript parsing, `codexEnabled` config

## 0.90

- **Plan hoist** — plans are promoted to the top-level summary during squash, rebase, and amend operations
- **Plan archive guard** — detects when Claude Code overwrites a plan file (hash comparison) and creates a new uncommitted entry
- **Branch-aware filtering** — committed plans from other branches are hidden; stale entries auto-reset on branch switch

## 0.89

- **Section renames** — "Memories" → "Summaries", "E2E Test Guide" → "E2E Test", "CREATE & UPDATE PR" → "Pull Request"
- **HEAD watcher** — switching branches now refreshes all four panels
- **UI polish** — Create PR gray with 🔗, Generate gray with ✨, committed plans show 🔒 icon, consistent count badges

## 0.88

- **Plan-commit association** — plans automatically linked to commits; archived with unique slug so the original file can be reused
- **Plan detection** — `PlanService` scans session transcripts for plan slugs and manages the plans.json registry

## 0.87

- **Plans panel** — new sidebar panel between STATUS and CHANGES that detects Claude Code plan files from active session transcripts


## 0.86

- **LLM-generated squash commit messages** — the Squash button now calls Claude to generate a unified commit message from all selected summaries
- **Rebase no longer triggers summarization** — the post-commit hook detects rebases and skips worker spawning, preventing lock conflicts
- **Logger safety** — log writes now check for `.jolli` directory existence first, preventing accidental folder creation in unmanaged repos

## 0.85

- **CLI labels match UI** — CLI output now uses "Why" / "Decisions" / "What" labels consistent with the WebView headings
- **Preamble parsing fix** — the delimited text parser now correctly skips the preamble section, preventing phantom "Topic 1" entries
- **UPPERCASE field markers** — the AI summarizer prompt now uses `---TITLE---`, `---DECISIONS---` etc. to reduce LLM hallucination

## 0.84

- **E2E guides survive squash** — when commits are squashed, E2E test guides from individual commits are automatically merged
- **Fixed E2E toggle** — expanding/collapsing E2E test scenarios now works reliably on first load
- **Create & Update PR section** — check if a PR exists, create one with the summary embedded, or update an existing PR description

## 0.83

- **E2E Test Guide** — AI-generated step-by-step testing instructions for PR reviewers, with multi-scenario support
- **Edit, regenerate, and delete E2E guides** — edit scenarios in a Markdown textarea, regenerate with one click, or delete entirely
- **Smart scenario limits** — small changes (≤ 3 summaries) produce up to 5 scenarios; larger changes allow up to 10

## 0.82

- **WebView modular refactor** — `SummaryWebviewPanel.ts` split into five focused modules for maintainability
- **Structured panel title** — summary tab and Jolli push title now show `date · ticket · hash · author` format
- **Placeholder topics filtered** — topics with empty or stub decisions are now automatically excluded

## 0.81

- **Progressive disclosure layout** — trigger and decisions expanded by default; response, to-do, files collapsed with gray background
- **Field reorder** — fields now appear in reading order: trigger → decisions → response → to-do → files
- **Conversation-first summarization** — AI treats conversation transcript as PRIMARY source and diff as secondary

## 0.80

- **No more "Jolli Memory is disabled" flash** — the panel no longer briefly shows the disabled message when reloading VSCode
- **Pluralised "Memory" label** — the sidebar label now correctly reads "Memories" (plural)
- **Tighter decisions format** — decisions always render as a bulleted list with bold labels; max 5 bullets / 120 words

## 0.75

- **COMMITS panel auto-refresh on Windows** — the Commits panel now reliably refreshes after deleting a lock file, fixing an issue where the panel could appear stale on Windows

## 0.74

- **ESC to exit editing** — press Escape to quickly discard changes and leave edit mode

## 0.73

- **Save button feedback** — clicking Save now shows "Saving..." with a disabled button state, so you know the operation is in progress

## 0.72

- **Delete confirmation shows title** — the delete dialog now displays the memory's title (e.g., `Delete "Fix login timeout"?`) so you can confirm you're removing the right one

## 0.71

- **Faster save** — saving a memory edit now updates only the edited card instead of re-rendering the entire page, preserving your scroll position and collapse state

## 0.70

- **Empty branch handling** — switching to a branch with no commits no longer shows a stale summary from the previous branch

## 0.69

- **Renamed "Topics" to "Memories"** — section header, timeline counts, action buttons, and Markdown export now consistently use "Memories" to align with the Jolli Memory brand

## 0.68

- **Inline title editing** — the memory title input is now embedded directly in the header for a more streamlined editing experience, no separate form field needed

## 0.67

- Edit and delete buttons on each memory are now **always visible** instead of appearing only on hover, making them easier to discover and access

## 0.66

- **Delete memory** — remove individual memories from a summary with a confirmation dialog; the change is persisted immediately

## 0.65

- **Edit memory** — edit any memory's title, trigger, response, decisions, and to-do fields directly in the summary viewer without leaving VSCode

## 0.64

- **Improved summary reliability** — the AI summarizer now uses a structured text format instead of raw JSON, reducing parse failures caused by special characters in code diffs

## 0.63

- **Exclude filter** now reloads from `config.json` before opening the editor, so manual edits to the config file are reflected immediately without restarting VSCode

## 0.62

- **Jolli Site URL** in the STATUS panel now correctly updates when you set a new API key — previously it could show a stale URL from a prior configuration
- Setting a new-format Jolli API key now automatically clears any outdated `jolliBaseUrl`, preventing confusion between old and new site URLs

## 0.61

- **Push to Jolli** no longer skips TLS certificate verification by default — for local development with self-signed certificates, enable the new `allowInsecureTls` option in your Jolli Memory config

## 0.60

- Source Commits in the summary viewer are now sorted **newest-first** so the most recent work appears at the top

## 0.59

- Removed the **Commit Type** row from the summary properties section to reduce visual noise

## 0.58

- **Conversation turns** now display as a styled pill badge with a 💬 icon for quick visual scanning in both the summary header and per-commit rows

## 0.57

- **Colored diff stats** in the summary viewer — insertions shown in green, deletions in red, and conversation turns in a purple accent, making commit impact visible at a glance

## 0.56

- Commit, Squash, and Push buttons now show as **grayed out** (disabled) while AI summarization is running, instead of disappearing entirely

## 0.55

- **Source Commits** heading in the summary viewer and Markdown export now shows the commit count (e.g., "Source Commits (5)") for squash summaries with 2 or more source commits

## 0.54

- Ticket detection in commit messages now supports **any Jira-style project prefix** (e.g., PROJ-123, FEAT-42, BUG-7) — no longer limited to a specific project name

## 0.53

- **Commit**, **Squash**, and **Push** buttons are now automatically disabled while AI summarization is running in the background, preventing accidental conflicts with in-progress summary generation

## 0.52

- Summaries now use a **tree structure** internally — improves storage efficiency and enables faster lookups for large repositories
- When upgrading from older summary formats, a **migration progress indicator** appears in all three panels so you know what's happening

## 0.51

- The **View Memory** icon on each commit now appears automatically within seconds of a summary being generated — no manual refresh needed
- Clicking the Commits panel refresh button also updates all memory icons instantly
- Faster commit panel loading — summary lookup now reads only the lightweight index instead of loading individual summary files

## 0.50

- STATUS panel redesigned: **Hooks**, **Claude Code Sessions**, and **Stored Memories** each show a **tooltip** with detailed breakdown on hover (e.g., "1 Claude Code hook + 3 Git hooks")
- **Stored Memories** now displays branch-specific and total counts (e.g., "12 / 124") so you can see how many commits on your current branch have memories

## 0.49

- The **COMMITS** panel title now dynamically updates to show "COMMITS (merged into main)" when your branch has been merged, making the read-only state immediately visible

## 0.48

- **Jolli API Key** now embeds your site URL and tenant info — just paste the key and the plugin auto-connects to your Jolli Space, no separate URL configuration needed
- Removed the "Set Jolli Site URL" command — it's no longer necessary

## 0.47

- **Push to Jolli Space** — send commit summaries directly to your team's Jolli documentation site with one click from the summary viewer
- Button label changes to "Update on Jolli" when the summary has already been pushed, so you can keep it in sync
- Configure **Jolli API Key** from the STATUS panel — no config file editing needed

## 0.46

- After a branch is merged into main, the Commits panel switches to **merged mode** — a read-only history of your commits on that branch, so you can still browse summaries after merge
- Merged mode uses git reflog to locate the branch creation point and filters commits by author

## 0.45

- Multi-day squash summaries now display a **date-grouped timeline** — topics are organized under collapsible date headers with a vertical timeline connector
- Duration label now correctly counts calendar days across multi-day squash summaries

## 0.44

- Markdown export now preserves **list formatting** inside callouts — bullet lists no longer collapse into a single line
- Dates in exported Markdown show **absolute time** instead of "4 minutes ago" which becomes meaningless once copied
- Commit metadata in Markdown export changed from table to **bullet list** for better compatibility across Markdown viewers
- Footer now includes the **generation timestamp** in both the summary viewer and Markdown export

## 0.43

- Callout sections now display **emoji labels** (⚡ Trigger, ✅ Response, 💡 Decisions, 📋 To-Do) for quick visual identification
- Removed colored dot indicators from callouts — emoji labels provide clearer differentiation
- Bullet lists inside callout text now **render as proper HTML lists** instead of raw `- item` text; **bold** text is also supported

## 0.42

- Colored **category pills** next to each topic title (feature, bugfix, refactor, docs, etc.) for quick visual scanning
- **Expand All / Collapse All** button to toggle all topic sections at once
- Each topic now shows its **list of affected files**
- Summary header displays **commit type** (amend, squash, etc.) and **source** (plugin/CLI) when applicable
- **Conversation turns** count shown in summary header and per-record in squash views
- Topics sorted **newest-first**, with major topics before minor; minor topics are visually dimmed
- Multi-record (squash) summaries show the original commit date on each topic

## 0.41

- Summaries now record **commit type** (commit/amend/squash/cherry-pick/revert), **source** (plugin/CLI), and **conversation turns**
- Each topic includes **affected files**, **category** (feature/bugfix/refactor/etc.), and **importance** (major/minor) classification

## 0.40

- Amending an already-pushed commit now shows a **warning notification** about needing force push
- Removed "Commit & Push" option — use the dedicated Push button for safer push with force-push protection

## 0.39

- Amending a commit now **merges** the old and new commit messages instead of replacing the old one
- Default AI model changed from Haiku to **Sonnet** for better summary quality
- Model upgrades happen automatically — no need to reconfigure when new Claude versions are released

## 0.38

- Commit messages **automatically detect ticket numbers** from any branch naming convention (e.g., `feature/PROJ-123-foo`, `fix/42-login`), no longer limited to a specific project prefix
- File list stays **stable** when staging/unstaging — no more visual jumping (reorders only on manual Refresh)

## 0.37

- Commit message generation is **significantly faster** — now uses only the staged diff instead of the full conversation transcript
- Custom **Jolli Memory icon** in status bar instead of a generic checkmark
- Simplified status bar — removed redundant branch name and staged file count already shown by VSCode's built-in Source Control
- Fixed excluded files briefly flashing on first load

## 0.36

- Clicking a file in the Changes panel now opens a **diff view** (HEAD vs Working Tree for unstaged files, HEAD vs Staged for staged files), just like VSCode's built-in Source Control
- New and untracked files open directly as a normal editor tab; deleted files show the last committed version read-only
- The Changes panel now **auto-refreshes** when you create, edit, or delete files — no more clicking the Refresh button after every save
- Moved "Edit Exclude Filter" from the title bar into the `...` overflow menu, reducing visual clutter

## 0.35

- Fixed an issue where running `git commit --amend -m "message"` directly from the terminal (not through the VSCode extension) would silently fail to merge the original commit's summary with the amended one — the amend was committed but the summary history was lost

## 0.34

- Added a guided onboarding flow after enabling Jolli Memory — instead of jumping straight to the status panel, you now see step-by-step instructions to reload the window and start your first Claude session
- You can now set your Anthropic API key directly from the STATUS panel — click the warning item or use the "Set API Key" action in the panel's "..." menu, no config file editing required
- You can now switch between Claude models (e.g. claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5) from the STATUS panel without leaving the editor
- Fixed summary parse failures caused by AI responses containing Windows file paths (e.g. `C:\Users\`) or regex patterns — these no longer produce "bad escaped character" errors and lost summaries
- Refreshed the activity bar icon with a clean stacked-cards design that renders more clearly at small sizes
- Cleaned up the STATUS panel: title simplified from "JolliMemory Status" to "STATUS", descriptions made consistent, and the redundant top-level "Status: Enabled" item removed

## 0.33

- Fixed an issue where `jollimemory summarize` would silently skip re-generating a summary if one already existed — it now correctly overwrites the old summary

## 0.32

- `git commit --amend -m "message"` from the command line now correctly captures and preserves the summary from the original commit alongside the new one

## 0.31

- Redesigned the summary viewer with a clean, Notion-style layout using collapsible callout blocks for each topic section
- Activity bar icon now shows a badge with the number of summaries on the current branch
- Push to remote now works for newly created branches (automatically sets upstream)

## 0.30

- Running `git reset --soft HEAD~N && git commit` from the command line now automatically detects the squash and merges all affected summaries — no VSCode extension required
- Fixed an issue where the VSCode Squash button could produce broken summary merges

## 0.29

- The Commits panel now correctly identifies the base of your branch even when your local ref is behind the remote

## 0.28

- Improved reliability of amend detection by moving it earlier in the git hook pipeline, fixing edge cases where amend summaries could be lost

## 0.27

- The AI now adjusts how many topics it generates based on the size of the commit — small changes get 1–2 topics, medium changes get 2–4, and large changes get 3–6

## 0.26

- Amending a commit now correctly keeps both the original and new summaries as separate records, so no context is lost when you amend

## 0.25

- Added **Commit & Push** — commit and push in a single action from the commit dialog
- Added **Commit (Amend)** — rewrite the last commit message without leaving the editor
- Squash now warns you if any of the selected commits have already been pushed

## 0.24

- Commit tooltips now show the author's GitHub avatar image

## 0.23

- Hovering on any commit in the Commits panel now shows a detailed tooltip with hash, author, date, and summary excerpt
- Added **Export as Markdown** — right-click the Commits panel header to export your full branch history as a Markdown document

## 0.22

- Added file exclusion filter to the Changes panel — define glob patterns (e.g. `*.lock`, `dist/**`) to hide files you never want to stage
- Excluded files are automatically unstaged if they were staged before

## 0.21

- Fixed an issue where pressing Enter in the commit message input could submit the dialog prematurely

## 0.20

- **Introducing the Jolli Memory VSCode Extension** — a three-panel sidebar that surfaces your AI-generated commit documentation directly in the editor
- **Status** panel shows hook installation state and stored summary count, with a toggle to enable or disable hooks
- **Changes** panel displays all changed files with checkboxes to stage or unstage instantly
- **Commits** panel lists every commit on the current branch not yet in main — click the eye icon to read the full AI summary
- **AI Commit** — click the sparkle button to generate a commit message from your staged diff and Claude Code session context
- **Squash** — select commits and merge them into one, with summaries automatically combined

## 0.10

- Summaries now support multiple records per commit — when viewing a squashed commit, each original session's context is preserved separately
- Added `jollimemory migrate` command to upgrade summaries from older formats to the latest structure
- Removed placeholder "None" values from the Todo section

## 0.9

- Summaries are now preserved when you amend a commit — the original summary is migrated to the new commit hash
- Summaries are automatically migrated during `git rebase`
- When you squash or fixup commits (via rebase), all affected summaries are merged into one
- Each summary now includes metadata about the AI call: model used, token count, and latency

## 0.8

- Jolli Memory can now be installed via `npm install`
- Claude Code hooks are now stored in `settings.local.json` (git-ignored) instead of `settings.json`, keeping your shared config clean
- Existing hooks are automatically migrated to the new location

## 0.7

- Summary fields renamed from "What / Why / Open Items" to **Trigger / Response / Decisions / Todo** for clearer, more actionable documentation

## 0.6

- Summaries are now organized into multiple topics — each independent problem or goal worked on gets its own section with title, description, decisions, and open items
- When viewing an older single-topic summary, it displays seamlessly alongside the new format

## 0.5

- Cleaner transcripts: system-generated messages, streaming duplicates, and IDE noise are now filtered out before the AI sees them
- Consecutive assistant messages are merged into one, producing more coherent summaries

## 0.4

- Added support for multiple concurrent Claude Code sessions — each session's transcript is tracked independently and merged at commit time
- Stale sessions older than 24 hours are automatically cleaned up

## 0.3

- Improved storage performance: summary and index are now written in a single atomic commit instead of two, reducing git operations by 29%

## 0.2

- Improved transcript parsing reliability with defensive handling of unexpected JSONL entry types
- No more flashing CMD windows on Windows during hook execution
- Added per-step timing in debug logs for easier troubleshooting

## 0.1

- **Initial release of Jolli Memory** — every commit deserves a Memory
- After each `git commit`, Jolli Memory reads your AI coding session transcript and the code diff, calls Claude to produce a structured summary, and stores it alongside the commit
- Summaries are stored in a git orphan branch (`jollimemory/summaries/v1`) — zero impact on your working tree or commit history
- CLI commands: `jollimemory enable`, `disable`, `status`, `view`, and `summarize`
- Summaries are stored locally alongside your project. The original AI conversation is never stored — only the distilled summary
