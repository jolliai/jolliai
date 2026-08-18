# 368. Cursor Plugin Package

## Topic Statement

The third agent-host plugin: the Codex plugin's structural twin — its own bundle inlining the command-line sources, its own marketplace, published by script rather than by release workflow — differing from it in five host-contract details that each fail *silently*, and diverging from both siblings on one product decision: it installs nothing into a repository that has not opted in.

## Scope

**In scope:**

- The five host-contract differences from the Codex sibling, and why none may be unified.
- The manifest and marketplace paths, and the manifest's own shape.
- The single session hook, its flat output envelope, and how it finds the project directory.
- Why the process working directory is a trap on this host rather than a fallback.
- The two server-side conditions that can silently void the hook, and what covers that.
- The consent gate: what it withholds, what stays unconditional despite it, and why the gate is drawn around the worktree.
- Skill placement across three scopes — bundled, mirrored per repository, and machine-global — and the ownership guards in both directions.
- Why the front-door skill is machine-global and its duplicate accepted.
- How the mirror's link targets are found, and the registry key that must not be used for it.
- Why this bundle ships no server manifest, and what writes the server registration instead.
- The dist and skill inventories, and the publish pipeline's guards.

**Out of scope (boundaries):**

- The shared repository runtime this bootstrap reconciles — the git hooks, the dispatch scripts, the runtime registry's competition rule (owned by the installation topics). This topic covers only what this host asks for and what it withholds.
- The briefing's content and the shared composer that produces it.
- The skill bodies themselves, and the builders that render them.
- The server's tool surface, and its working-directory refusals.
- The Claude and Codex plugin packages, except where a difference is the point.

## Data Contracts

### Manifest and marketplace paths

The unit manifest lives in a host-specific dotted directory inside the plugin, and the marketplace descriptor in the same-named directory at the tree root. Both names are this host's own and are **not** the Codex sibling's — that host puts its marketplace under a different directory entirely.

### Manifest shape

Name, display name, version, description, author, homepage, repository, licence, keywords, category and tags, plus two pointers: a **skills directory** and a **hooks file**. There is deliberately **no server-manifest pointer** — see below.

### The five host-contract differences

Each of these fails silently rather than loudly, which is why none may be "unified" with the other hosts:

| # | This host | The siblings |
| --- | --- | --- |
| 1 | Manifest and marketplace in this host's own dotted directories | Different directory names, and a different marketplace location |
| 2 | The hook event name is **camelCase** | PascalCase — and a wrong case here is not an error, it is an event that never fires |
| 3 | An event maps **straight to an array of command objects** | An intermediate grouping object wraps the array |
| 4 | The plugin-root variable is this host's own name | The siblings' variable names are **not** aliases here, and an unexpanded variable fails every session |
| 5 | The output envelope is **flat**, with a snake_case additional-context key | A nested host-specific object with a camelCase key |

The fifth is the same class of mistake that shipped on the Codex host in the opposite direction, where every side effect landed and made the install look healthy while no briefing ever reached the model.

### The session hook output envelope

Flat: an optional environment object and an optional additional-context string, at the top level. Nesting the briefing the way either sibling does puts it where this host never looks.

### Skills, across three scopes

| Scope | What lives there | Written by |
| --- | --- | --- |
| The bundle's own skills directory | Only the **host-specific** skills — initialise, sign in, sign out, push, status, timeline. **Not** the front door | Shipped in the package |
| Per repository, in this host's own workspace skills directory | The four **host-neutral** skills, mirrored as links | The bootstrap, every session |
| Machine-global, in this host's user skills directory | The **front-door umbrella** | The bootstrap, unconditionally |

**This host does not namespace plugin skills**, which is what forces the split. The invocation name is the parent directory of the skill file, and plugin skills share **one flat pool** with several workspace and user directories, distinguished only by a brand icon. The de-duplicator keys on the pair of plugin display name and skill name, so it collapses only the *same* plugin's duplicate, while entries with no plugin attribution are admitted unconditionally. Two plugins — or a plugin and the user's own skill — therefore coexist under an identical name with no suffix and no shadowing, which is exactly what a generically-named skill would walk into.

Four further constraints follow from the loader and are each silent when broken: the frontmatter name must be lowercase letters, digits and hyphens, within a length bound, and must **equal its directory** (a mismatch is silent, because the menu invokes the directory name); a description is required and bounded; an always-apply flag would reclassify the skill as an always-injected global rule; and three metadata keys are genuinely *read* by the loader, so a stray key there silently hides the skill — which is why the generator strips that block.

**Why the four neutral skills are mirrored per repository and not machine-global**, and both halves are load-bearing: a workspace skills directory is *per repository*, the same granularity as the thing being mirrored, so mirroring at machine scope would let one repository's reconcile strip a skill from every other and make two windows fight; and that directory is read by **no other host**, so writing and deleting it cannot take away the only copy the other hosts have. De-duplicating in the other direction is therefore forbidden. Both directions are ownership-guarded, so a user's own same-named skill is neither overwritten nor deleted.

**The umbrella is the deliberate exception, and its duplicate is accepted.** This host's chat-first window delivers the session event with an *empty* workspace-roots list and an empty project-directory variable **no matter which repository row started the conversation**, and nothing in that payload recovers the repository — the transcript path is null, and the per-repository transcript mapping is not created until the conversation does work. A per-repository front door therefore cannot reach the surface that most needs one. So the umbrella is machine-global, and a repository that also ran a full enable shows two front-door entries. That is the accepted trade, stated the other way round: shipping a skill in two places degrades to a duplicate, while pruning it from both degrades to a missing skill with nothing to explain why.

Note the **empty string**, not just the empty list: candidates are rejected on trimmed length, and a null-coalescing test would let an empty string through.

## Behavior

### The bootstrap, in order

1. Resolve the project directory from the payload's workspace roots or the host's project-directory variable. **Never from the process working directory** — see below.
2. Write the three unconditional, machine-global things (below), whatever happens next.
3. **The consent gate**: proceed into the repository only when this repository already has the shared git hook installed.
4. For an opted-in repository, reconcile the shared repo runtime with repo-hooks-only host isolation, register this host's repo-scoped server entry, and mirror the four neutral skills.
5. Emit the briefing in the flat envelope.

### The working directory is a trap, not a fallback

Every plugin hook on this host except the stop events runs with **the plugin bundle as its working directory** — measured, with the real workspace named in the payload alongside. A marketplace cache is often a real repository checkout, so trusting the working directory would install this product's git hooks **into the plugin's own repository**.

The resolver therefore reads the payload and the host variable and returns **nothing** rather than accept a plugin-bundle working directory, sharing that predicate with the server's own guard.

### Two server-side conditions can void the hook silently

Plugin-declared hooks are cleared unless **both** a user setting (defaulting on) and a **server-side feature gate** are enabled. A gate being off drops the hooks silently while the plugin's skills still load — which is the Codex failure shape reached through a different door.

That is why the skills' fallback path of shelling the dispatcher, and the initialise skill, **must stay**: they are the only route in when the hook never ran.

**This host does run plugin-declared hooks** when both conditions hold — measured, with four events observed firing — unlike the Codex host, whose plugin hooks never ran at all. So this bootstrap genuinely reaches the user.

### The consent gate, and the three writes that ignore it

**This is the only one of the three hosts that does not install into a repository on its own.** An un-opted-in repository gets no git hooks, no server entry, no mirrored skills and no briefing. The reason is specific to this host: a workspace-open event fires for **every** repository listed in the sidebar at startup, so auto-installing would reach repositories the user merely browsed. Setting one up is the front door routing to the initialise skill, and the gate and the displayed state cannot disagree because both derive from the same hook-installed predicate.

**Maintenance is not opt-in**: an already-installed repository still reconciles every session, because an upgrade moves the version-stamped bundle and the mirrored skills are links into it.

Three writes are unconditional and happen **ahead of any repository**: the machine-global umbrella skill, the record of this bundle's own root, and the runtime registry reconciliation (the dispatch scripts plus this source's dist entry). Registering a runtime asserts "a runtime of this version lives here", not anything about a repository.

**Without that third write every documented route out is a dead end**, which is why it is load-bearing rather than an optimisation. The umbrella's first step finds neither a server tool (this bundle ships no manifest, and the workspace entry is written by the very install being deferred) nor the dispatcher, so it takes its dispatcher-absent branch and tells a user who installed minutes ago that the product is gone, offering to delete the menu; and the initialise skill answers a missing dispatcher by telling them to reload so the session hook runs — this hook, which returned before writing it. Reload forever.

**The gate is drawn around the worktree, never around the machine.** Widening it to the machine-global config directory closes that same loop.

### The mirror's link targets

Planting a link into the bundle requires knowing where the bundle is, and only a process running from inside it can answer. So the bootstrap **records its own root every session**, resolved from its own module location, and the mirror reads that record and **verifies the mirror subdirectory still exists** before using it.

**The dist-path registry must not be used for this**, and the reason is that it answers a different question: its slot is keyed by **source tag alone, never by directory** — deliberately, so that a same-version reinstall at a new path still claims the slot instead of leaving hooks dispatching from a stale directory. It therefore records the dist of whichever runtime most recently installed while claiming that tag. Measured: the initialise path shells the dispatcher, which resolves to the highest-versioned dist (the command-line build winning a tie), that build correctly recorded *its own* dist under this host's tag, and the derived mirror path came out inside the command-line workspace — all four links dangled and the host dropped the skills silently. Do **not** "fix" this by making the registry refuse a foreign runtime's write; that re-opens the stale-directory bug it was repaired to remove.

The existence check is also what notices an uninstall, since the record outlives the bundle — nothing cleans the machine-global directory.

### The git-exclude entries

The mirrored skills are excluded from version control per skill **and** by their containing directory. Git reports an untracked *directory* as a single entry rather than descending into it, so the per-skill entries alone left the whole tree showing as untracked.

### No server manifest, and what writes the registration instead

A plugin-declared server entry would resolve its relative working directory against the **plugin root**, exactly as on the Codex host, so this bundle ships none. But this host's own server configuration is **repo-scoped** — it lives in the workspace — so the ordinary repository registrar is already the right writer, and the Codex host's global-config exception is not needed here. No global host is touched: a plugin install for this host has no business configuring anyone else's.

**That branch made the workspace-config writer a per-session hot path**, so it carries two obligations. It must **return before touching anything when the write would change nothing**, because the file is mostly *other* tools' configuration — an unconditional rewrite makes concurrent sessions last-writer-wins over the whole file, normalises the user's formatting away, churns the host's watcher, and risks truncating their other servers on a torn write. The no-op check compares **content, not bytes**: a byte comparison against disk misses whenever the user's copy differs only in formatting, so the guard would never fire on exactly those installs. And because the write is atomic — replacing the file's inode — it must **read the existing mode back and re-apply it**, or the temporary file's umask-derived mode rides the rename onto a file holding another tool's spawn commands and credential blocks.

### Inventories and publishing

Four lists describe this bundle and must move together, because an incomplete dist is refused registration and a git hook resolving to a missing file **aborts the user's git operation**: the build's entry points and its expected outputs, the publish script's required-dist list, and the shared required-runtime-files list. The bundle deliberately ships hooks this host never installs, precisely because dist completeness is a machine-global contract — a registered runtime that wins the version race has to serve every other host's repo hooks.

The publish list is **one entry shorter** than the Codex sibling's, because this bundle ships no server launcher.

A parallel pair covers the skills: the bundle's skill-name list and the publish script's expected set, asserted **equal as an exact set, never as a glob** — this repository has already lost a skill file to an ignore rule while the add reported success.

Publishing progresses local → dev → production. The production script **refuses any version that is not strictly higher** than the last release when content changed; the dev script skips that guard entirely, so a green dev run does not prove production will accept the version. The local script targets a **single-plugin directory** rather than a marketplace, so it mirrors just the one plugin rather than the whole tree. The mirror ignores any global ignore file, because a developer's own ignore rule matching a skill file has silently dropped skills from a published plugin before.

Two copies of the licence ship — the tree root and the plugin unit — because the unit copy is the one an install actually copies, and both are in the required-config list.

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Any session | Session hook fires | The three machine-global writes land, unconditionally |
| Repository with no shared git hook | Session hook fires | Nothing enters the worktree; the front door routes to the initialise skill |
| Repository already opted in | Session hook fires | Runtime reconciled, workspace server entry written if it would change, neutral skills mirrored, briefing emitted |
| Workspace-config file already correct | Session hook fires | Returns without touching the file — no mtime change, no reformat |
| Chat-first window with no workspace named | Session hook fires | No repository is resolvable; the machine-global umbrella is what the user reaches |
| Plugin-bundle working directory, nothing else resolvable | Session hook fires | Project directory resolves to nothing; no repository is bootstrapped |
| Server feature gate off | Session start | Hooks cleared silently; skills still load; the dispatcher fallback is the only route in |
| Bundle removed, record left behind | Mirror reconcile | Mirror subdirectory missing, so the record is not used — the uninstall is noticed |

## Notable / Surprising Behavior

- **An unrecognised event key in the hooks file silently voids the WHOLE file.** Measured: a probe registering four documented events plus one string that appears in the host's own bundle but is not a hook event had **none** of its five hooks run, with no rejection logged anywhere. The host's reference does not document this, so the test's allowlist — taken from the published documentation — is the only guard. Never add an event name found by grepping the application bundle.
- **A wrong hook-event case is not an error; it is an event that never fires.** The same is true of the plugin-root variable: the siblings' names are not aliases, and an unexpanded variable fails every session.
- **The process working directory is a real repository often enough to be dangerous.** A marketplace cache served over version control is a genuine checkout, which is why the bundle-path check runs *before* any repository test.
- **This host keeps the canonical prefix on its skill directories where the Codex sibling drops it**, because that sibling's host namespaces plugin skills and this one does not.
- **The umbrella's duplicate is accepted deliberately**, and is the one place the per-repository mirroring rule is broken on purpose.
- **The registry key that looks right for finding the bundle is wrong**, and using it produced four dangling links and silently dropped skills. The record the bootstrap writes about itself is the only source that answers the question being asked.
- **The un-opted-in repository is a product divergence from both siblings, not an oversight**, and restoring auto-install here would need re-deciding it for all three.
- **The workspace-config no-op check compares rendered content rather than bytes**, because the byte form would never fire on a checkout with different line endings or indentation — exactly the installs that most need it.
- **An atomic write silently widens a mode** unless the existing mode is read back and re-applied, and the files this writer touches hold other tools' spawn commands and credentials.

## Shared Behavior

- **The shared repository runtime** — the git hooks, the dispatch scripts, the per-source runtime registry and its highest-version-wins competition, and the repo-hooks-only host isolation this bootstrap asks for.
- **The briefing composer**, its switches, and the deadline it runs under.
- **The Codex plugin package**, which this one is structurally a twin of — same bundle shape, same publish-by-script model, same absence of tests and type-checking of its own.
- **The Claude plugin package**, and the shared rule that a bundle's entry-point guard must test the entry file's basename.
- **The server's working-directory refusals**, including the plugin-bundle predicate this bootstrap shares.
- **The skill builders** that render the shared skill bodies, and the transform pair that re-heads a bundled copy.
- **The shell-prerequisite block** the front door and four other skills carry, and the reason it is about the search path rather than about any one command.
- **The durable manual-disable opt-out** this bootstrap respects.
