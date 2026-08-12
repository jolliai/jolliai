# Spec corpus index

Behavioral specifications reverse-engineered from this repository's actual code — one per topic,
grouped below by theme and ordered by number within each group. The corpus size is deliberately not
stated here: it is a number nobody decides anything on, and one more thing to keep true.

**These specs document reality, not intent.** Every statement in them was derived from — and is meant
to stay verified against — the code as it exists, not from a design doc, a ticket, or a plan. Where a
spec and the code disagree, the code is right and the spec is a bug. Where a spec says a feature does
not exist, that absence is itself the documented behavior.

**Naming convention:** `NN-kebab-case-topic.md`, where `NN` is a stable, never-reused spec number and
the slug names the topic. Numbers are allocated in rough discovery order, not by theme, so a spec's
number carries no meaning beyond identity — use this index or the slug to find things. Each file
opens with a `# NN. Title` heading followed by a `## Topic Statement` that states the one topic the
spec owns, then `## Scope` with explicit in-scope / out-of-scope boundaries.

**Retired topics** keep their row here with the link struck through and marked **(REMOVED)**. The
file is retained because the record of what the product *used to* do — and the explicit statement
that it no longer does — is load-bearing for anyone reading old code, old commits, or another spec's
cross-reference.

`STACK.md` is not a spec. It is the project's stack and verify-gate configuration: workspaces,
toolchain versions, the run loop, the exact gate command, coverage floors, and the conventions that
gate a change.

---

## Storage and the summary model

- [01 — Orphan Branch Summary Storage](01-orphan-branch-summary-storage.md) — persist summaries on a long-lived parallel git ref using object-database plumbing only, never checking out a tree.
- [02 — Folder-Based Summary Storage](02-folder-based-summary-storage.md) — store summaries as plain files in a user-chosen folder with a metadata sidecar tracking AI-generated files and branch mappings.
- [03 — Storage-Mode Selection](03-dual-write-summary-storage.md) — pick ref-only, folder-only, or the dual-write composite from a single config value, with primary-wins conflict semantics.
- [04 — Summary Tree Structure](04-summary-tree-structure.md) — the in-memory commit-summary tree, its per-node fields, aggregation rules, and the schema-version discriminator between two layouts.
- [05 — Summary Index Format](05-summary-index-format.md) — a flat record set enabling lookup, listing, pagination, and cross-branch matching without loading summary payloads.
- [06 — Summary Schema Migration](06-summary-schema-migration.md) — the two-phase idempotent upgrade from the legacy flat-records format to the unified hoist tree, with a 48-hour safety window.
- [136 — Summary Catalog File](136-summary-catalog-file.md) — a denormalized root-only catalog surfacing recap, ticket id, and topic detail without per-summary reads.
- [151 — Memory Bank Folder Layout](151-memory-bank-folder-layout.md) — the multi-repo on-disk mirror with its hidden machine-readable layer, visible human-readable layer, and generated wiki layer.
- [173 — Repo Identity and Folder Naming](173-repo-identity-and-folder-naming.md) — derive a stable repo identity, slugify its name, propose a vault folder, and record the binding in a collision-detecting registry.
- [185 — Transcript UUID Identity (v5) and One-Shot Migration](185-v5-uuid-identity-and-migration.md) — decouple transcript storage keys from commit hashes via opaque UUIDs, upgrading every stored summary in one pass.
- [186 — Stale Child Markdown Cleanup](186-stale-child-markdown-cleanup.md) — delete visible-layer markdown for non-root index entries so the visible folder holds one file per live head.
- [195 — Memory Bank User-Knowledge Scanner](195-memory-bank-scanner.md) — surface user-authored markdown in a repo mirror, filtering system-emitted files and classifying survivors by depth.
- [215 — Memory Bank Migration Engine](215-memory-bank-migration-engine.md) — copy the whole orphan-branch store into the Memory Bank folder resumably and idempotently, then keep the visible layer reconciled.
- [232 — Canonical Repo URL and Name Derivation](232-canonical-repo-url-and-name-derivation.md) — normalize a git remote into one stable key across transports and casing, plus the derived repo name and branch slug.
- [311 — Project State-Root Resolution](311-project-state-root-resolution.md) — anchor an implicitly-supplied working directory to its enclosing worktree root so a subdirectory can never fork a second per-project state store.

## Summary generation and the LLM path

- [08 — Anthropic Message API Call](08-anthropic-message-api-call.md) — issue a completion over HTTPS with API-key auth and a pinned version header, auto-choosing streaming vs non-streaming per call.
- [09 — Jolli Proxy LLM Routing](09-jolli-proxy-llm-routing.md) — route the call through the Jolli backend when only a Space API key exists, letting the backend own prompt, provider, and model.
- [10 — LLM Credential Priority and aiProvider Selection](10-llm-credential-priority-and-aiprovider-selection.md) — the priority order across candidate credentials and provider paths, with a per-surface override that pins the choice.
- [11 — Prompt Template Library](11-prompt-template-library.md) — one source of truth for prompt templates with `{{placeholder}}` substitution, shared by the direct and proxy paths.
- [12 — Multi-Topic Commit Summary Generation](12-multi-topic-commit-summary-generation.md) — one LLM call over conversation, diff, and metadata returning a delimited document of zero or more topic blocks.
- [13 — Squash Consolidation Summary](13-squash-consolidation-summary.md) — consolidate N source summaries into one via an LLM call, falling back to content-preserving mechanical concatenation on failure, and archive the still-active working-area context onto the consolidated commit.
- [14 — AI Commit Message Generation](14-ai-commit-message-generation.md) — generate a 50–72 character imperative subject from the staged diff alone, presented for editing before any commit happens.
- [15 — Recap Paragraph Generation](15-recap-paragraph-generation.md) — the short narrative produced at initial generation, regenerated at squash time, and available as a standalone on-demand call.
- [25 — Plan Progress Evaluation](25-plan-progress-evaluation.md) — classify every plan step as completed / in-progress / not-started against the commit, persisting the result as a sidecar.
- [243 — Token Usage Extraction and Cost Estimation](243-token-usage-extraction-and-cost-estimation.md) — the flat-rate token/cost estimator, its formatters, and the per-model-response de-duplication that stops one billed call being counted once per content block.
- [244 — Conversation Token Totals for the Review Panel](244-conversation-token-totals-for-review-panel.md) — sum real per-conversation token usage across a caller-supplied transcript set, tolerating per-file read failures.
- [245 — Commit-Pipeline Conversation Token Attribution](245-commit-pipeline-conversation-token-attribution.md) — drop excluded conversations and overlay-deleted turns from the stored token total while still advancing every cursor.
- [257 — Multi-Provider Pricing and Cost Estimation](257-multi-provider-pricing-and-cost-estimation.md) — the hand-maintained per-model USD price table keyed by transcript model id, plus the uniform cost formula.
- [258 — AI Context-Relevance Filtering](258-ai-context-relevance-filtering.md) — one batch LLM call, issued for every provider but only on the commit kinds that derive relevance at all, tiers and soft-excludes low-relevance context items; a least-affinity-first pre-ordering decides who the prompt budget is spent on, and any error keeps everything.
- [306 — Conversation Detach Usage Correction](306-conversation-detach-usage-correction.md) — correcting a committed memory's recorded token and cost figures when one conversation is detached: per-node ownership of the persisted share, the unattributable cases it refuses to guess at, and cost re-derived rather than scaled.
- [308 — Local-Agent Tool / Explicit-Path Ownership Invariant](308-local-agent-tool-path-ownership.md) — the persisted agent-binary path records no owning tool, so one write-time rule clears it whenever the tool changes; its exemptions, its writers, and the read-side attribution it underwrites.
- [280 — Local Agent CLI Provider Backend](280-local-agent-cli-provider-backend.md) — a third execution backend that drives a locally-installed agent CLI headlessly, authenticated by its own subscription login.
- [286 — Local-Agent Login-Expiry Remediation Guidance](286-local-agent-login-expiry-remediation.md) — persist an auth-expired placeholder summary and surface one shared remediation message inline and at next session start.
- [291 — Generation Repair Ladder](291-generation-repair-ladder.md) — the shared interactive ladder that diagnoses which of three provider/credential mismatches applies and offers the smallest fix in one prompt.
- [294 — Commit-Subject Merge Algorithm](294-commit-subject-merge-algorithm.md) — fold ordered commit subjects into one line deterministically via structural prefix, then ticket dedupe, then plain join.
- [331 — Local-Agent Optional-Flag Degradation](331-local-agent-optional-flag-degradation.md) — learn after a failed run which isolation flag the installed agent CLI rejects, drop it, retry in the same call, and remember the answer per tool-and-version.
- [333 — Conversation Usage Recomputation from Transcripts](333-conversation-usage-recomputation-from-transcripts.md) — re-derive a memory's token and cost figures per node from the sessions its owned transcripts still hold, replacing the stored figures outright rather than adjusting by a delta.
- [334 — Summary Regeneration Field Contract](334-summary-regeneration-field-contract.md) — which fields an end-to-end regeneration rebuilds from a fresh model call, which it derives afresh, and which it carries over from the stored memory untouched.

## Transcript and session sources

- [16 — Claude Code Transcript Reading](16-claude-code-transcript-reading.md) — read newline-delimited records into the canonical role-tagged form, resuming incrementally via a per-session cursor.
- [17 — Gemini CLI Transcript Reading](17-gemini-cli-transcript-reading.md) — read a single-document JSON transcript into canonical form with the same cursor-based resumption.
- [18 — Codex Session Discovery and Transcript Reading](18-codex-session-discovery.md) — discover recent sessions on disk with no hook event, then normalize their newline-delimited transcripts.
- [19 — OpenCode Transcript Reading](19-opencode-transcript-reading.md) — read from a local embedded structured store behind a feature gate that tolerates a runtime lacking the database module.
- [20 — Cursor Session and Transcript Reading](20-cursor-session-and-transcript-reading.md) — detect and read Cursor IDE sessions, including the workspace anchor that keeps the actively-open conversation in scope.
- [21 — GitHub Copilot CLI Transcript Reading](21-github-copilot-cli-transcript-reading.md) — detect, discover, and read Copilot CLI histories for the current project from its embedded store.
- [22 — GitHub Copilot Chat Transcript Reading](22-github-copilot-chat-transcript-reading.md) — read Copilot Chat sessions for the current workspace, mapping the project path to a Copilot workspace id.
- [23 — Session Registry Pruning](23-session-registry-pruning.md) — keep the observed-session registry self-cleaning by pruning entries past a fixed staleness threshold.
- [24 — Transcript Cursor Resumption](24-transcript-cursor-resumption.md) — a per-(transcript, purpose) bookmark so incremental scans never re-read already-processed lines.
- [26 — Claude Stop Hook — Session Recording](26-claude-stop-hook-session-recording.md) — record session metadata on every response turn and trigger one incremental plan/reference discovery pass, with no LLM call.
- [27 — Claude Session-Start Briefing](27-claude-session-start-briefing.md) — emit a short branch-history briefing on stdout under a hard deadline so the host injects it into the new session.
- [28 — Gemini After-Agent Hook — Session Recording](28-gemini-after-agent-hook-session-recording.md) — record session metadata per turn while satisfying the host's contract to write a JSON object on stdout.
- [29 — Plan Discovery from Agent Transcripts](29-plan-discovery-from-agent-transcripts.md) — the source-agnostic driver that upserts one plan record per discovered markdown file without resurrecting archived plans.
- [155 — Active Session Aggregator](155-active-session-aggregator.md) — one read returns every currently-active conversation across all producers with enough metadata to render a row.
- [181 — Codex Plan Discovery from Apply-Patch](181-codex-plan-discovery-from-apply-patch.md) — recognize patch-application requests targeting markdown and feed the resolved paths into the shared plan upsert.
- [182 — Session Title Resolution Chain](182-session-title-resolution-chain.md) — resolve a session's display title through an ordered source chain, ending at a constant placeholder.
- [253 — Session Directory Attribution](253-session-directory-attribution.md) — the shared containment predicate that decides whether a session's working directory belongs to a given worktree, excluding nested repos and submodules.
- [275 — Cline VS Code Session and Transcript Reading](275-cline-vscode-session-and-transcript-reading.md) — read the extension's globalStorage task-history and per-task replay files into canonical form.
- [276 — Cline CLI Session and Transcript Reading](276-cline-cli-session-and-transcript-reading.md) — read the standalone terminal tool's per-session JSON sidecar and messages file into canonical form.
- [277 — Devin CLI Session and Main-Chain Transcript Reading](277-devin-cli-session-and-transcript-reading.md) — reconstruct the canonical linear conversation from a message forest in one machine-global embedded store.
- [278 — Antigravity Conversation Discovery and Transcript Reading](278-antigravity-session-and-transcript-reading.md) — recover the workspace path from a per-conversation encrypted database, then read the plaintext transcript beside it.
- [279 — Cursor CLI (cursor-agent) Session and Transcript Reading](279-cursor-cli-session-and-transcript-reading.md) — read the terminal `cursor-agent` product's own plain JSON/JSONL layout, unrelated to the Cursor IDE source.
- [339 — Kimi Code CLI Session Discovery and Transcript Reading](339-kimi-code-cli-session-and-transcript-reading.md) — find this host's sessions with no lifecycle hook, recover each one's working directory from a per-session state document, and normalize its wire-event stream into canonical turns.
- [305 — Re-Enable Transcript Discovery Catch-Up](305-re-enable-transcript-discovery-catch-up.md) — re-scan recorded sessions from their frozen watermark when a repository is re-enabled, recovering the window during which discovery was suspended; editor-only, uncapped, and paid inside the enable gesture.

## Working-memory state: overlays, selection, pins

- [183 — Conversation Overlay Store](183-conversation-overlay-store.md) — persist user edits and deletions to an active conversation as a sidecar projected over the transcript by identity matching.
- [184 — Transcript Message Counter With Overlay](184-transcript-message-counter.md) — count visible messages exactly as the detail panel would render them, after applying the user's overlay.
- [188 — Commit Exclusion Selection Store](188-commit-exclusion-selection-store.md) — a sticky per-project file holding the user's manual EXCLUDE set plus the AI-relevance ranking layer for the next pipeline run.
- [189 — Hidden Conversations Store](189-hidden-conversations-store.md) — remember conversations the user removed from the active list, with snapshot-scoped semantics so new activity brings the row back.
- [246 — Pin Store](246-pin-store.md) — per-project, per-repo-and-branch records of artifacts pinned to the top of the Current Branch view, carrying only reopen identity.
- [337 — CLI-Owned Working-Area Context Service](337-cli-working-context-service.md) — the one command-line-owned set of operations over a worktree's uncommitted plans, notes and references, including two deliberately non-interchangeable visibility rules and a load-time normalization that hard-deletes legacy shapes.

## Git hooks and the operation queue

- [30 — Git Operation Type Detection](30-git-operation-type-detection.md) — classify the git operation behind this invocation from environment, reflog, and on-disk markers into one tagged enum.
- [31 — Post-Commit Hook Enqueue](31-post-commit-hook-enqueue.md) — detect the operation kind, decide handle-now vs defer-to-post-rewrite, write one queue entry, and spawn a detached worker.
- [32 — Post-Rewrite Hook Handling](32-post-rewrite-hook-handling.md) — use the authoritative old→new hash map on stdin, group by destination to separate pick from squash, and enqueue per group.
- [33 — Prepare-Commit-Msg Squash Detection](33-prepare-commit-msg-squash-detection.md) — recognize merge-squash and reset-then-commit before finalization and write the pending file post-commit will consume.
- [34 — Git Operation Queue Worker](34-git-operation-queue-worker.md) — the single-writer drain: summary entries in timestamp order under the drain lock, then a separate ingest phase under its own lock.
- [35 — Queue Entry Format](35-queue-entry-format.md) — the on-disk shape and lifecycle of one operation record, removed only after a processing attempt.
- [36 — Summary Attribution by Transcript Cutoff](36-summary-attribution-by-transcript-cutoff.md) — treat the entry's creation timestamp as a read cutoff so post-commit conversation belongs to the next commit, never duplicated.
- [37 — Worker Chain Spawn](37-worker-chain-spawn.md) — re-list the queue after releasing the lock and start a successor process so work enqueued during the drain is never stranded.
- [38 — Squash-Pending Handoff](38-squash-pending-handoff.md) — the short-lived record naming the source hashes being collapsed, written before the squash commit and consumed right after.
- [39 — Amend Summary Migration](39-amend-summary-migration.md) — carry a summary to the new hash on in-place rewrite, recompute only what changed, and consolidate new evidence with the prior narrative.
- [40 — Rebase-Pick Metadata Migration](40-rebase-pick-metadata-migration.md) — a pure metadata hash carry-forward when a rebase rewrites a hash without changing content: no LLM, no transcript reread.
- [41 — Rebase-Squash Consolidation](41-rebase-squash-consolidation.md) — collapse N source summaries into one root keyed by the rewritten hash, sharing the non-rebase squash consolidation pipeline.
- [42 — Plan Archival on Commit](42-plan-archival-on-commit.md) — snapshot uncommitted plans into storage under a slug-and-hash name and rewrite the registry row into an edit-detecting guard.
- [43 — Note Archival on Commit](43-note-archival-on-commit.md) — the same snapshot-and-guard treatment for uncommitted notes, keyed by identifier and hash.
- [218 — Queue-Status Computation](218-queue-status-computation.md) — compose pending summary work, pending ingest work, and worker busy state into one "drained" verdict that deliberately excludes ingest.
- [259 — Ingest Lock and Deferred-Ingest Hand-off](259-ingest-lock-and-deferred-ingest-handoff.md) — a per-worktree lock plus a single-slot deferred flag so an all-or-nothing ingest batch is neither stranded nor run twice.
- [285 — Post-Commit Capture Progress Streaming](285-post-commit-capture-progress-streaming.md) — the worker appends milestones to a per-commit stream and the hook tails it, blocking only in interactive contexts under bounded timeouts.

## Installation, distribution and dispatch

- [44 — Hook Installation Orchestration](44-hook-installation-orchestration.md) — one idempotent pass wires every agent hook, git hook, dispatch script, dist-path entry, and state directory.
- [45 — Git Shell Hook Installation](45-git-shell-hook-installation.md) — install the five git hooks as marker-delimited sections coexisting with third-party content; pre-push is hand-built so it never blocks a push.
- [46 — Claude Code Hook Installation](46-claude-code-hook-installation.md) — insert the Stop and SessionStart entries into the per-project local-settings file with stale-path replacement and legacy cleanup.
- [47 — Gemini CLI Hook Installation](47-gemini-cli-hook-installation.md) — insert the AfterAgent entry into the Gemini per-project settings file using the same shape and helpers.
- [48 — Skill File Installation](48-skill-file-installation.md) — write each registered skill document independently through a shared revision-guarded upsert into the cross-platform skills directory.
- [49 — Dispatch Script Generation](49-dispatch-script-generation.md) — the three shell scripts under `~/.jolli/jollimemory/` that indirect between a repo's git hooks and whichever distribution is installed.
- [50 — Per-Source Dist-Path Version Selection](50-per-source-dist-path-version-selection.md) — one registry file per install source, with the highest-version still-existing distribution winning at every dispatch.
- [51 — Npm Postinstall Dist-Path Refresh](51-npm-postinstall-dist-path-refresh.md) — after a global npm install the postinstall repoints the CLI's registry entry and rewrites the dispatch scripts with no explicit enable.
- [178 — Plugin Update Check](178-plugin-update-check.md) — a one-shot stderr warning when a newer host or plugin version exists, backed by a cache refreshed in a detached background process.
- [297 — Lock Primitive Registry](297-lock-primitive-registry.md) — every advisory file lock in the product, characterised by where its file lives, how long a contender waits, and whether a miss aborts the work or degrades to running unlocked.

## Auth, tenancy and configuration

- [52 — OAuth Browser Login Flow](52-oauth-browser-login-flow.md) — open the browser with a CSRF nonce, listen on a local single-route callback, and exchange the code for a token in one atomic config write.
- [53 — CLI Authorization Code Exchange](53-cli-authorization-code-exchange.md) — one bounded HTTPS POST trades the code for a session token and optional API key, with every failure mapped to user-facing text.
- [54 — Jolli API Key Format and Parsing](54-jolli-api-key-format-and-parsing.md) — strip the fixed prefix and scan dot-delimited segments for the first that base64url-decodes to the required tenant JSON.
- [55 — Jolli Origin Allowlist Enforcement](55-jolli-origin-allowlist-enforcement.md) — refuse to save any Jolli URL outside the fixed HTTPS-only domain allowlist so a hostile URL can never become a credential target.
- [56 — Auth Credential Storage](56-auth-credential-storage.md) — persist token and API key in one per-user file via merge-and-rename, with env overrides at read time and masking in all output.
- [96 — Plugin Outdated Flow](96-plugin-outdated-flow.md) — map HTTP 426 to a typed error carrying the server's explanation, with no automatic retry.
- [97 — Tenant Resolution Modes](97-tenant-resolution-modes.md) — read the saved URL's pathname to choose path-based tenancy (first segment is the slug) or host-based tenancy (server resolves).
- [266 — User Profile (`profile.json`)](266-user-profile.md) — the machine-global store of small non-credential facts, kept strictly separate from the credential file `config.json`.

## CLI command surface

- [57 — `jolli enable`](57-cli-enable-command.md) — first-time project setup: install every hook, then prompt for credentials.
- [58 — `jolli status`](58-cli-status-command.md) — report installed hooks, session count, memory count, and credential state in human or machine-readable form.
- [59 — `jolli doctor`](59-cli-doctor-diagnostics.md) — probe the installation for faults and report each with an ok / warn / fail verdict.
- [60 — `jolli doctor --fix`](60-cli-doctor-fix.md) — run the same probes and then repair every fault that has a known remedy.
- [61 — `jolli clean`](61-cli-clean-stale-data.md) — remove stale sessions, queue entries, and squash-pending files by per-category age threshold.
- [62 — `jolli configure`](62-cli-configure-command.md) — set, remove, list, and show per-user config values with type coercion and per-key save-time validation.
- [63 — `jolli view`](63-cli-view-summaries-command.md) — display a compact recent-commit list or one commit's full detail, optionally to a markdown or JSON file.
- [64 — `jolli export`](64-cli-export-summaries-command.md) — write every stored summary as an individual markdown file under Documents, plus a chronological index.
- [65 — `jolli export-prompt`](65-cli-export-prompt-templates-command.md) — emit the prompt-template library to stdout or as per-template markdown plus a manifest, for review and backend seeding.
- [66 — `jolli migrate`](66-cli-migrate-command.md) — upgrade stored summaries from v1 to the v3 tree format in two phases, retaining legacy data for 48 hours.
- [67 — `jolli new`](67-cli-new-command.md) — scaffold a new documentation content folder from a starter kit, refusing to run if the target exists.
- [68 — `jolli convert`](68-cli-convert-command.md) — rearrange a third-party docs folder into the Jolli content layout, with a timestamped backup for in-place runs.
- [69 — `jolli auth`](69-cli-auth-subcommands.md) — login, logout, and status over the account session and product API key, leaving any Anthropic key alone.
- [137 — `jolli search`](137-search-command-surface.md) — assemble a query from arguments or stdin, run the single-phase relevance search, and emit hits structured or human-readable.
- [190 — CLI Heal-Folder Command](190-cli-heal-folder-command.md) — re-emit visible-layer markdown that the manifest tracks but the filesystem no longer holds, scoped to one project.
- [201 — CLI Graph Export Command](201-cli-graph-command.md) — export the already-built knowledge graph as a single self-contained HTML file, optionally opening it.
- [207 — CLI Telemetry Command](207-cli-telemetry-command.md) — report consent state and identity, toggle the opt-out, and print buffered events, all computed standalone from config.
- [210 — CLI `pr-description` Command](210-cli-pr-description-command.md) — output a generated PR title and body for the current branch, with an optional validated base branch.
- [230 — CLI Space Push / Spaces / Bind Commands](230-cli-space-push-bind-commands.md) — three commands and three tool mirrors over the shared push/binding engine with one discriminated result shape.
- [240 — CLI `queue-status` Command](240-cli-queue-status-command.md) — report or block on the drained verdict, emitting stable JSON or one human line and exiting cleanly.
- [265 — Guided front door (bare `jolli`)](265-guided-front-door.md) — with no subcommand on an interactive terminal, run a status snapshot plus a two-rung fix-what's-missing ladder instead of the help wall.
- [267 — Guided Front-Door Space-Binding Step](267-guided-front-door-space-binding-step.md) — resolve or establish the repo's Space binding in one backend round-trip, warning on unusable bindings, entirely best-effort.
- [281 — CLI Machine-Wide Uninstall Command](281-cli-machine-wide-uninstall-command.md) — discover and selectively remove every install artifact across every editor, directory, and hook — never the user's memories.
- [292 — `jolli generate`](292-cli-generate-bridge-command.md) — a hidden JSON-in/JSON-out bridge exposing five one-shot generation flows to hosts that cannot call the code in-process.
- ~~[293 — `jolli migrate-memory-bank`](293-cli-migrate-memory-bank-command.md)~~ **(REMOVED)** — the dedicated hidden command is gone; IntelliJ now reaches the same migration engine through the ide-bridge `migrate-memory-bank` action (daemon fast path, one-shot spawn fallback), keeping the no-sign-in contract.
- [296 — Moved-Command Notices](296-moved-command-notices.md) — keep three retired flat workflow command names registered as hidden soft-failing notices that name their namespaced replacement.

## Search and recall

- [07 — Development Context Recall](07-development-context-recall.md) — a token-budgeted compilation of a branch's summaries, decisions, plans, and notes, rendered in one of five output modes.
- [138 — Single-Phase Search Pipeline](138-two-phase-search-pipeline.md) — require a non-empty query, open and memoize the relevance index, and return one flat ranked hit list with no model call.
- [139 — Search recency filter via display-date](139-search-recency-filter.md) — records that no recency filter exists: the display-date mechanism survives only as unreachable dead parsing code.
- [177 — Local Full-Text Search Index](177-local-search-index.md) — a disposable on-disk inverted index built lazily, persisted as two sidecars, and restored when a cheap source-signature check still matches.

## References and external sources

- [153 — Transcript Reference Extraction](153-transcript-reference-extraction.md) — scan a transcript for external-entity mentions via per-producer envelope parsers plus declarative source match rules, then dedupe and persist.
- [154 — Built-in external-reference source definitions](154-external-reference-source-adapters.md) — the catalog of built-in sources as data-only definitions, their correctness-sensitive registration order, and their field rules.
- [179 — Reference store markdown persistence](179-reference-store-markdown-persistence.md) — one markdown file per reference under a per-source directory, with frontmatter scalars plus an opaque display-field list.
- [180 — Codex Reference Extraction via Polling](180-codex-reference-extraction-via-polling.md) — extract references from recent Codex transcripts on the host UI's refresh timer, since Codex offers no lifecycle hook.
- [255 — Source-definition DSL and evaluation engine](255-source-definition-dsl-and-engine.md) — a pure engine over declarative extraction pipes, where a definition may only name allow-listed transforms — the security boundary.
- [256 — Slack thread reference capture](256-slack-thread-reference-capture.md) — resolve a thread's shareable link from whatever the transcript offers and void the whole capture when no link can be established.
- [340 — Kimi Artifact Discovery and Reference Extraction](340-kimi-artifact-discovery-and-reference-extraction.md) — the hook-free pass that scans this host's recent sessions from two independent triggers under a per-workspace single-flight with dirty-rerun.
- [342 — MCP Business-Payload Normalization](342-mcp-business-payload-normalization.md) — one shared closed registry coercing an already-parsed tool-result payload into the single-entity shape its source definition expects, defaulting to identity.

## Skill usage capture and reporting

- [319 — Skill Usage Working Record](319-skill-usage-working-record.md) — persist each captured skill as one accumulating markdown file per host-and-skill, the sole dedup ledger, indexed by a registry row that keeps accumulating after a commit freezes it.
- [320 — Claude Skill Invocation Extraction](320-claude-skill-invocation-extraction.md) — recognize both entry paths into a skill from a Claude transcript, discriminated by one field and associated in line order rather than timestamp order.
- [321 — Skill Token Attribution](321-skill-token-attribution.md) — report per-skill spend as either host-attributed or positionally estimated, choosing one path for the whole scan so a single figure never mixes confidences.
- [322 — Skill Usage Commit Archival](322-skill-usage-commit-archival.md) — freeze onto each commit only the portion no earlier commit claimed, copying the working markdown and guarding the row instead of deleting it.
- [323 — Skill-Usage Aggregate Rendering](323-skill-usage-aggregate-rendering.md) — one renderer over a deliberately narrow row contract emits a byte-identical table and summary label on both sides of the commit boundary.
- [324 — VS Code Skills Context Row](324-vscode-skills-context-row.md) — one collapsed "Skills used" row carrying a sentinel id, filtered by the uncommitted delta, with every per-kind decision resolved from one injected table.
- [325 — OpenCode Skill Invocation Capture](325-opencode-skill-invocation-capture.md) — read the host's embedded store for first-class skill-tool rows on a polling tick, with spend that can only ever be an estimate.
- [326 — Codex Skill Inference From File Reads](326-codex-skill-inference-from-file-reads.md) — infer an entry from a shell command that reads a `SKILL.md`, matching the path shape rather than the verb and marking every record heuristic.
- [336 — IntelliJ Skills Bridge Projection](336-intellij-skills-bridge-projection.md) — the JVM host computes and renders nothing about skills itself; one adapter turns every skills question three panels can ask into a single cross-process request.
- [341 — Kimi Skill Invocation Capture](341-kimi-skill-invocation-capture.md) — a first-class skill tool makes this host's records observed rather than heuristic, correlated with their results to learn whether each invocation succeeded.

## Topic knowledge base (wiki)

- [152 — Topic Ingest Pipeline](152-topic-ingest-pipeline.md) — classify each batch of sources to topics in one model call, then reconcile each affected page with a second call per topic.
- [156 — Topic Index and Page Storage](156-topic-index-and-page-storage.md) — persist one routing index plus one canonical document per slug-identified topic through the active storage backend.
- [157 — Source Timeline Ordering](157-source-timeline-ordering.md) — merge four heterogeneous source streams into one deterministic old-to-new list keyed off a stable identity high-water mark.
- [158 — Wiki Markdown Rendering](158-wiki-markdown-rendering.md) — regenerate the human-readable wiki layer from the canonical pages, cross-linking against the sibling visible summary layer.
- [159 — Topic-KB Ingest Trigger and Cooldown](159-ingest-trigger-and-cooldown.md) — enqueue at most one ingest per cooldown window per project, with a merge-event force bypass and no cooldown burn on failed enqueue.
- [160 — Multi-Repo Memory Bank Compile Sweep](160-multi-repo-memory-bank-compile-sweep.md) — compile every discovered repo in one coordinator pass under a single vault lock, isolating per-repo failures.

## Knowledge graph

- [196 — Knowledge Graph Data Model](196-knowledge-graph-data-model.md) — the node/edge/entity shapes, referential-integrity invariants, and deterministic dedupe and rollup rules.
- [197 — Knowledge Graph Construction](197-knowledge-graph-construction.md) — fingerprint topics, then choose among skip, no-model reassemble, full distillation, and incremental diff update before joining and validating.
- [198 — Knowledge Graph LLM Distillation](198-knowledge-graph-llm-distillation.md) — a three-phase model pipeline that sanitizes and backfills on the full path but fails closed on the incremental path.
- [199 — Knowledge Graph Artifact Storage](199-knowledge-graph-artifact-storage.md) — one regenerable JSON file in the hidden canonical layer, written atomically and degrading to a full rebuild on parse failure.
- [200 — Knowledge Graph Interactive Viewer](200-knowledge-graph-interactive-viewer.md) — a two-level pan/zoom board with search, detail panel, and history, packaged as one self-contained file that opens from disk.
- [283 — Web-Embedded Knowledge Graph Host Bridge](283-web-embedded-knowledge-graph-host-bridge.md) — a guest-side adapter that receives model, theme, and control state over an origin-pinned `postMessage` handshake and makes no network requests.

## Telemetry and logging

- [131 — Debug Log Rotation and Leveling](131-debug-log-rotation-and-leveling.md) — one shared append log with size-based archive rotation, per-process and per-module levels, a test-env skip, and silent failure.
- [203 — Telemetry Consent and Opt-Out](203-telemetry-consent-and-opt-out.md) — on by default but silenced by any of three independent decline channels, re-evaluated at record time and again at send time.
- [204 — Telemetry Event Buffering and Flush](204-telemetry-event-buffering-and-flush.md) — a bounded per-project append queue with a never-blocking write path, draining in best-effort batches and removing acked events by identity.
- [205 — Telemetry Event Catalog](205-telemetry-event-catalog.md) — the append-only event allowlist, the fixed envelope, the anonymization rules, and the transparency doc generated from the allowlist itself.
- [206 — Telemetry Startup and Command Instrumentation](206-telemetry-startup-and-command-instrumentation.md) — bootstrap identity, consent, and environment once per process — the environment either self-tagged as a sandbox or derived from the origin host — and emit the catalog's events on every wired surface.
- [208 — Trace Context Correlation](208-trace-context-correlation.md) — a private correlation id tying logs and outbound requests into one grep-able unit, propagated across processes via queue field and env var.
- [312 — Onboarding Funnel Snapshot Event](312-onboarding-funnel-snapshot-event.md) — a content-free six-key snapshot of where one repo sits on the four-checkpoint path to generated memories, deduplicated against an on-disk ledger with a 24-hour heartbeat.

## Sync and the Memory Bank vault

- [150 — Sync Engine Reconciliation Cycle](150-sync-engine-reconciliation.md) — one serialized lock-protected round: mint credentials, refresh refs, replay remote through the conflict pyramid, stage, commit, push, release.
- [161 — Vault Identity Marker](161-vault-identity-marker.md) — prove a working tree really is the sync engine's own clone of the current personal space before any round writes to it.
- [162 — Git Credential Shim](162-git-credential-shim.md) — hand a short-lived credential to a spawned git child over an out-of-band channel that never appears in its argv.
- [163 — Vault Path Allowlist Staging](163-vault-path-allowlist-staging.md) — stage only paths matching a closed catalogue of engine-owned shapes; everything else goes to a no-commit telemetry bucket.
- [164 — Vault Symlink Safety Guard](164-vault-symlink-safety-guard.md) — re-walk the path chain before every write and refuse if any intermediate directory is a symlink.
- [165 — Vault Conflict Resolution](165-vault-conflict-resolution.md) — walk each rebase-pausing path through a fixed tier pyramid, then continue or abort based on whether anything was deferred.
- [166 — Vault Aggregate Deterministic Merge](166-vault-aggregate-deterministic-merge.md) — reduce two row sets for an aggregate file into one order whose serialization is byte-identical regardless of input order.
- [167 — Vault Bootstrap Merge](167-vault-bootstrap-merge.md) — adopt a populated remote into a new vault carrying unborn-HEAD content by stashing, force-checkout, then remote-wins-with-union-fallback replay.
- [168 — Corrupt JSON Quarantine](168-corrupt-json-quarantine.md) — atomically rename syntactically invalid engine-owned JSON into a vault-root quarantine so unparseable bytes never leave the device.
- [169 — Legacy DB-to-Git First-Bind Migration](169-legacy-db-to-git-migration.md) — one-shot import of a personal space from the backend's legacy database into the new git vault, then flip the space's backing.
- [170 — Sync Backend Client](170-sync-backend-client.md) — tenant-scoped requests against the personal-space sync endpoints, mapped into typed successes or a fixed typed-error taxonomy.
- [171 — Vault Write Lock](171-vault-write-lock.md) — serialize writers against one shared working tree by keying a host file lock to the canonicalized vault root path.
- [172 — Global Sync Lock](172-global-sync-lock.md) — the machine-global mutex serializing reconciliation rounds across every checkout, window, and CLI invocation for one OS user.
- [300 — Memory Bank Write Boundary and Effective-State Reporting](300-memory-bank-write-boundary-and-state-reporting.md) — refuse to claim a folder from a working directory that is not a real project, degrade silently to ref-only storage, and report the resulting effective state through one shared wording table.

## Jolli Space, sharing and push

- [94 — Summary Push to Jolli Space](94-summary-push-to-jolli-space.md) — a single-attempt authenticated JSON POST carrying a version header and a document-type discriminator, with first-share vs update affordances.
- [95 — Binding Required Flow](95-binding-required-flow.md) — open a chooser over the org's spaces, register the pick as this repo's binding, retry the push exactly once, abort cleanly on dismissal.
- [231 — Jolli Space Push Article Assembly](231-jolli-space-push-article-assembly.md) — push attachments first, weave their URLs into the summary body, push with prior ids so re-push updates in place, and delete orphans.
- [233 — Branch Share Store](233-branch-share-store.md) — the per-repo record of at most one live share per subject, read by the Share UI to reopen, retier, copy, or stop a link.
- [268 — Git Pre-Push Hook and Detached Sync Worker](268-git-pre-push-hook-and-worker.md) — queue the pushed commits, optimistically publish the budget-eligible ones inline, and never block or fail the push.
- [269 — Push-Pending Queue and Claim-Based Drain Engine](269-push-pending-queue-and-drain-engine.md) — two entry points over one drain core that atomically claims each commit, uploads with bounded concurrency, and tracks a retry budget.
- [270 — Push-Pending Compensation Retry](270-push-pending-compensation-retry.md) — a fire-and-forget catch-up on activation or sign-in that retries every queued commit with no hash filter.
- [301 — Memory Reference Identifier and Copy Chip](301-memory-reference-id-chip.md) — a memory's human-facing identifier, minted only once the backend has one, and the click-to-copy chip that surfaces it — always on detail panels, synced-only in lists, so a chip in a list is itself the "already pushed" signal.
- [310 — Per-Repo Outbound-Push Control](310-per-repo-outbound-push-control.md) — a machine-global, identity-keyed `pushDisabled` store and one `isOutboundPushAllowed` predicate gating every CLI/VS Code/IntelliJ push path, plus a current-repo toggle on each surface.
- [327 — Repo-Wide Push-Refusal Classification](327-repo-wide-push-refusal-classification.md) — one shared error-name set tells a whole-repository refusal from a per-document failure, so every push loop stops instead of firing N doomed requests.
- [335 — Pre-Push Worker Result Handoff](335-pre-push-worker-result-handoff.md) — the file-based request / result / liveness protocol by which the pre-push hook hands one push's commits to a detached worker and then watches it publish a partial outcome after every settled commit.
- [343 — Legacy Skill-Article Migration](343-legacy-skill-article-migration.md) — adopt one previously-shipped per-skill article identifier as the commit's aggregate article and queue every other for deletion, so no published article is left with nothing pointing at it.

## PR authoring

- [98 — PR Description Dual-Marker Embedding](98-pr-description-dual-marker-embedding.md) — embed the summary block between two HTML-comment markers so updates replace it in place and never touch the user's prose.
- [99 — PR Creation and Update via `gh`](99-pr-creation-and-update-via-gh.md) — probe `gh`, look the PR up by the summary's scoped branch in one round-trip, and route every body write through `--body-file`.
- [209 — PR Description Generation](209-pr-description-generation.md) — enumerate the branch's commits, load each memory, pick a title, and assemble the body via one of two markdown builders.
- ~~[211 — jolli-pr Skill Content](211-jolli-pr-skill-content.md)~~ **(REMOVED)** — the dedicated PR skill is no longer shipped; PR authoring lives entirely in the PR-description tool and its CLI counterpart.
- [213 — Create-PR Branch Classification](213-create-pr-branch-classification.md) — two read-only probes distinguish five branch cases, allowing, redirecting, or blocking PR creation, with a lighter submit-time TOCTOU guard.
- [239 — Create-PR Body Markdown Assembly](239-create-pr-body-markdown-assembly.md) — render the PR body to sanitized HTML, escaping every prose line before markdown except a whitelist of structural folding tags.

## Historical back-fill

- [214 — CLI Back-fill Command](214-cli-backfill-command.md) — resolve candidate own-commits, run the engine, and render text / JSON / NDJSON progress, or emit cold-start signals with no engine call.
- [224 — Back-fill Commit Target Index](224-backfill-commit-target-index.md) — one offline pass builds the attributable real-code-commit set and its lookup structures, excluding the product's own bookkeeping commits.
- [225 — Back-fill Raw Transcript Scanning](225-backfill-raw-transcript-scanning.md) — a standalone historical indexer that keeps only in-repo lines and groups the survivors by session chronologically.
- [226 — Back-fill Commit Attribution Algorithm](226-backfill-commit-attribution-algorithm.md) — a pure synchronous decision over signals and the target index producing per-commit sessions, counts, confidence tier, and method.
- [227 — Back-fill Engine Orchestration](227-backfill-engine-orchestration.md) — drop already-covered commits, index, attribute, then generate or preview per commit, isolating every failure and ingesting once at the end.
- [228 — Back-fill Cold-start Signal Queries](228-backfill-cold-start-signal-queries.md) — three cheap read-only queries deciding whether to offer back-fill and what to list, with no scanning, attribution, or model call.

## Plugins, skills and MCP

- [140 — `jolli-recall` Skill Content](140-jolli-recall-skill-content.md) — a one-step context load preferring the in-process tool over a shell here-doc, then a type-tagged dispatch into report, catalog, or error.
- [141 — `jolli-search` Skill Content](141-jolli-search-skill-content.md) — a single-phase lightweight hit-list request rendered under fixed output principles, with the same tool-then-here-doc preference.
- [146 — Plugin Loader](146-plugin-loader.md) — discover, validate, and load optional plugin packages once at startup so each can register commands, with stub fallbacks in help.
- [147 — Plugin API Contract](147-plugin-api-contract.md) — the published boundary: what a plugin exports, what the host passes it, which mutations are allowed, and the lifecycle guarantee.
- [148 — MCP server tool surface](148-mcp-server-tool-surface.md) — a stdio MCP server advertising read-only projections plus three Space-reaching tools, each returning a JSON-text response.
- [149 — MCP Client Registration](149-mcp-client-registration.md) — write or remove the server entry in every detected host's registry, split into repo-scoped (removed per worktree) and global-scoped (never removed).
- [241 — Global Skill-Preference Instructions Install](241-global-skill-preference-instructions-install.md) — upsert a marker-bracketed prefer-this-memory block into each host's machine-global instruction file, routing by intent not skill name.
- [242 — Global-Instructions Tri-State Switch](242-global-instructions-confirm-before-write.md) — a machine-global tri-state gate; the block is written only after explicit opt-in, and install merely applies the persisted decision.
- [272 — `jolli` Menu Skill Content](272-jolli-menu-skill-content.md) — assemble one action menu from the standalone skills plus the session's registered MCP tools, routing a supplied request directly.
- [282 — Claude Code Plugin Package](282-claude-code-plugin-package.md) — package recall, search, PR-writing, and memory bootstrap as one marketplace-distributed plugin needing no separate CLI install.
- [287 — CLI IDE-Bridge Command Surface](287-cli-ide-bridge-command-surface.md) — a hidden JSON-RPC surface, one-shot or long-lived, that lets a non-TypeScript IDE host invoke any core domain operation by name, with credential-redacted error envelopes.
- [288 — IntelliJ CLI Daemon Connection](288-intellij-cli-daemon-connection.md) — serve every bridge call from a lazily spawned per-project connection, falling back to a one-shot spawn — except on two failures that must never retry.
- [289 — IDE-Bridge Refresh Notification Channel](289-ide-bridge-refresh-notification-channel.md) — push coarse queue and orphan-ref change notices to the IDE host, multiplexed onto the response stream and distinguished by having no correlation id.
- [290 — Claude Plugin Session Bootstrap](290-claude-plugin-session-bootstrap-hook.md) — the plugin's single manifest action: a per-session reconciler that restores canonical installation under short-budget locks and never overrides a deliberate disable.
- [303 — Claude Plugin Front-Door Menu Content](303-claude-plugin-front-door-menu-content.md) — the body of the plugin companion's action menu: its revision-ordering invariant over the standalone menu, the status fields it reads, and its provider-aware "can generate memories" derivation.
- [328 — Codex Plugin Package](328-codex-plugin-package.md) — the Claude plugin's structural sibling and the places the two hosts diverge: manifest paths, a strict one-JSON-object hook envelope, no plugin MCP manifest, committed static skills, and tag-driven host isolation.
- [330 — Codex Plugin Front-Door Menu Content](330-codex-plugin-front-door-menu-content.md) — the third front-door body: no frontmatter metadata block, a hook-trust precondition when no routing target answers yet, and memory tools looked up by bare name inside the host's namespace.
- [338 — Refresh Escalation Rule](338-refresh-escalation-rule.md) — one shared sticky flag that a heavy refresh signal can set and a light one can never clear, so a light signal landing on a pending heavy one escalates rather than demotes.

## Workflows

- [273 — Local Workflow-Run Orchestration](273-local-workflow-run-orchestration.md) — the client's own agent executes the recipe at no Jolli LLM cost while the backend supplies it, tracks the run, and derives the write destination.
- [274 — Workflow-Run Result Reporting](274-workflow-run-result-reporting.md) — report outcome and produced-artifact links for remote and local runs, offer to open them, and list a workflow's run history.

## Site generation and documentation publishing

- [70 — Site Configuration File Discovery and Creation](70-site-json-discovery-and-creation.md) — read `site.json` when present, or create it on first use after framework detection and a title prompt.
- [71 — Documentation Framework Detection](71-documentation-framework-detection.md) — identify the source framework by scanning for known marker files in a fixed order.
- [72 — Docusaurus Sidebar Conversion](72-docusaurus-sidebar-conversion.md) — convert a Docusaurus sidebar into sidebar overrides plus folder path mappings so logical navigation can differ from physical layout.
- [73 — Content Mirroring](73-content-mirroring.md) — classify every source file as markdown, image, OpenAPI, or ignored, then copy or transform it into the staged build with folder remappings applied.
- [74 — MDX Downgrade Detection](74-mdx-downgrade-detection.md) — decide whether an `.mdx` file uses unresolvable imports or components and downgrade it to plain `.md` rather than fail the compile.
- [75 — Image Asset Resolution](75-image-asset-resolution.md) — resolve broken image references by searching upward from the source folder, copying under a deduplicated name, or generating a placeholder.
- [76 — Favicon Resolution](76-favicon-resolution.md) — copy the configured favicon into `public/` or generate a default SVG, then wire it into the generated layout's head.
- [77 — Nextra Project Scaffold](77-nextra-project-scaffold.md) — generate the Nextra v4 scaffold (pinned deps, config, App Router layout, MDX map, tsconfig alias, 404 and catch-all routes) with per-theme dispatch.
- [78 — Theme Pack Manifests](78-theme-pack-manifests.md) — named packs bundling layout shape, accent hue, light/dark default, and body font, each field cascading from the manifest onto site config.
- [79 — Meta Sidebar Generation](79-meta-sidebar-generation.md) — walk the staged tree writing one navigation manifest per folder, using declared overrides and falling back to deterministic alphabetical order.
- [80 — Shared Site Engine](80-shared-site-engine.md) — one per-user pre-installed dependency copy that every staged build symlinks into, so install cost is paid once and amortized.
- [81 — npm Runner](81-npm-runner.md) — a thin wrapper running install, build, dev, and serve inside the staged build directory and reporting a success flag with captured output.
- [82 — Source Watcher Debouncing](82-source-watcher-debouncing.md) — coalesce edit bursts into one re-sync via a debounce timer plus a dirty-flag re-entrancy guard so in-flight syncs pick up later edits.
- [83 — Output Filtering](83-output-filtering.md) — filter child-process output line by line, surfacing only the bound localhost URL and error-shaped lines, with a verbose pass-through mode.
- [84 — Pagefind Search Indexing](84-pagefind-search-indexing.md) — run the `pagefind` indexer over the static export, tolerating index failure as a non-fatal warning.
- [85 — Starter Kit Scaffolding](85-starter-kit-scaffolding.md) — write the fixed starter content layout into a target directory, refusing to proceed when it already exists.
- [86 — OpenAPI Spec Detection](86-openapi-spec-detection.md) — sniff arbitrary JSON/YAML files for OpenAPI 3.x structural markers without relying on filename conventions.
- [87 — OpenAPI Spec Parsing and Ref Resolution](87-openapi-spec-parsing-and-ref-resolution.md) — walk paths × methods in declaration order resolving `$ref`s into a renderer-agnostic intermediate representation.
- [88 — OpenAPI Tag/OperationId Collision Detection](88-openapi-tag-operationid-collision-detection.md) — abort the build naming both operations when two would map to the same output page, rather than silently overwrite one.
- [89 — OpenAPI Code Sample Generation](89-openapi-code-sample-generation.md) — hand-roll five per-language request samples per operation from the resolved server, parameters, body, and security scheme.
- [90 — OpenAPI Endpoint MDX Page Emission](90-openapi-endpoint-mdx-page-emission.md) — one small MDX shim per operation importing the shared component and carrying samples as fenced blocks for build-time highlighting.
- [91 — OpenAPI Endpoint JSON Sidecar](91-openapi-endpoint-json-sidecar.md) — one JSON file per operation imported at static-render time, carrying all component data without inflating MDX compile cost.
- [92 — OpenAPI Overview Page Emission](92-openapi-overview-page-emission.md) — one per-spec overview page listing every operation grouped by tag in parsed-spec order so it mirrors the sidebar.
- [93 — OpenAPI Sidebar Tree Emission](93-openapi-sidebar-tree-emission.md) — emit `_meta` files at spec root and per tag so the sidebar shows only the current spec, overview first, operations labelled `METHOD path`.

## The VS Code surface

- [100 — Extension Activation Lifecycle](100-vscode-extension-activation.md) — a fixed-order activation that branches into degraded mode outside a git repo and otherwise wires every store, tab, watcher, command, and context key.
- [101 — Sidebar Webview Message Protocol](101-vscode-sidebar-webview-message-protocol.md) — the bidirectional type-tagged contract: host pushes serialized snapshots, webview dispatches commands or hands back structured actions.
- [102 — Sidebar Tab and Filter State](102-vscode-sidebar-tab-state.md) — active tab, KB sub-mode, per-tab filters, and derived flags that survive a webview reload, restored in one readiness-handshake payload.
- [103 — Changes Tab Per-File Selection](103-vscode-files-checkbox-staging.md) — a UI-only checked-path set kept separate from the git index until the next AI Commit, where it becomes the authoritative staging input.
- [104 — Commits Tab Dual Mode](104-vscode-history-tree-dual-mode.md) — four modes (multi-commit, single, merged-history, empty) computed once per refresh and shipped as one payload.
- [105 — Memories Tab Lazy Load and Pagination](105-vscode-memories-lazy-load.md) — first page loads only on first sidebar reveal, with watchers gated on a has-loaded flag so unopened tabs cost nothing per commit.
- [106 — AI Commit From Checkbox Selection](106-vscode-ai-commit-from-checkbox-selection.md) — snapshot the index, stage exactly the checked files, generate a message, gate the Amend options, and roll back on cancel or error.
- [107 — Push Command With force-with-lease](107-vscode-push-command-with-force-with-lease.md) — detect when a force-push is genuinely required and only proceed after a modal naming the at-risk commit, always with a remote-ref lease.
- [108 — Squash Multi-Commit Flow](108-vscode-squash-multi-commit-flow.md) — require two or more commits, warn on already-pushed ones, generate a message with mechanical fallback, and write the pre-squash hand-off file.
- [109 — Summary Webview Panel](109-vscode-summary-webview-panel.md) — the Commit Memory side panel rendering one summary with in-panel edit, copy, download, push, create-or-update-PR, a per-memory usage meter, and per-conversation detach.
- [110 — Settings Webview](110-vscode-settings-webview.md) — edit the per-user config with no workspace overrides, validating the Jolli API key against the HTTPS host allowlist before any disk write, and gating Apply on a live agent-tool availability check that can hold a save mid-probe.
- [111 — Note Editor Webview](111-vscode-note-editor-webview.md) — two note kinds: inline text snippets authored in a webview, and markdown-file notes linked via picker without copying.
- [112 — Lock File Block During Commit / Squash / Create PR](112-vscode-lock-file-block-during-commit.md) — abort those three actions while the summary-drain lock is live; Push is deliberately ungated and ingest never trips the guard.
- [113 — Cross-Project Plan Attribution](113-vscode-cross-project-plan-attribution.md) — register a new global plan file only if its absolute path appears JSON-escaped in one of this workspace's recent transcripts.
- [114 — Plan and Note Archive Guards](114-vscode-plan-and-note-archive-guards.md) — a content-hash guard hides a committed plan or note but reveals it again the moment its source content changes.
- [115 — Exclude Filter Manager](115-vscode-exclude-filter-manager.md) — a comma-separated glob list in per-user config, edited in Settings and evaluated on every render of the Folders / Files tab.
- [116 — Status Bar Items](116-vscode-status-bar-items.md) — one fixed-priority left-side entry showing enabled state, layering a four-state Memory Bank sync visual once the sync engine takes ownership.
- [117 — Binding Chooser Webview](117-vscode-binding-chooser-webview.md) — a per-repo singleton that lets the user pick a space when a push is rejected unbound, then closes so the push retries automatically.
- [134 — JolliMemory Bridge Data Abstraction](134-vscode-jollimemory-bridge-data-abstraction.md) — one per-workspace object funneling every git, storage, and install operation so no command spawns git or imports a backend itself.
- [142 — Onboarding Panel](142-vscode-onboarding-panel.md) — a full-viewport panel replacing the tabs when unconfigured, offering up to three paths (a detected local agent tool first, then the local key, then sign-in) with exactly one card ever badged.
- [143 — Anthropic API Key Panel](143-vscode-anthropic-api-key-panel.md) — a sidebar sub-view capturing an Anthropic key during onboarding for the machine-global config.
- [144 — Auto-Enable on Activation](144-vscode-auto-enable-on-activation.md) — auto-install hooks on activating a git workspace via the same path the explicit Enable uses, suppressed only by the repo-wide manual-disable flag.
- [145 — Repo-Wide Manual Disable Flag](145-vscode-manual-disable-flag.md) — one canonical boolean in a repo-wide profile file that every hook and worker checks in its own hot path, shared across worktrees and surfaces.
- [174 — IDE Sync Round Orchestrator](174-vscode-sync-orchestrator.md) — schedule background rounds on a slow interval, expose sync-now, mirror phase progress with a locked-wait countdown, and coalesce triggers.
- [175 — Memory Bank Folder Browser](175-vscode-memory-bank-folder-browser.md) — a lazily-expanded tree interleaving discovered repos with user-dropped siblings, enriched with manifest classification, title, branch, and divergence.
- [176 — Memory-File Divergence Decoration](176-vscode-memory-file-divergence-decoration.md) — a single-glyph badge on any memory-bank markdown whose content no longer matches the recorded fingerprint.
- [187 — External References Panel](187-vscode-references-panel.md) — the rows surfacing every active external reference inside the Branch tab's merged Context list.
- [194 — IDE Fork URI Scheme Resolver](194-vscode-ide-uri-scheme-resolver.md) — return the OS-registered deep-link scheme for the running host by matching its application name against a fixed fork table.
- [202 — Editor Knowledge Graph Panel](202-vscode-knowledge-graph-panel.md) — one editor webview tab per repo, loading the built graph data and serving the viewer runtime from packaged assets rather than inlining it.
- [229 — Cold-start Back-fill Card](229-vscode-cold-start-backfill-card.md) — the per-repo cold-start signals, dismiss marker, copy, and run/dismiss/notify orchestration that offer back-fill without spending budget first.
- [234 — Live Branch Share](234-vscode-live-branch-share.md) — mint at most one live link per share subject, flip its tier in place across three levels, invite people, and re-check every URL against the allowlist.
- [235 — Shared Branch Import](235-vscode-shared-branch-import.md) — verify the link origin fail-closed, download the shared memory, and materialize it in one of three modes with every untrusted segment validated.
- [236 — Push Orchestration](236-vscode-push-orchestration.md) — the single UI-agnostic push path shared by Share, live share, and Create-PR, deduping recurring attachments to one Space doc each.
- [237 — Create-PR View](237-vscode-create-pr-view.md) — assemble a branch-scoped draft into a view-model, present it editably, resolve create-vs-update host-side, and rebuild after submit.
- [238 — Create-PR Diff Preview](238-vscode-create-pr-diff-preview.md) — a read-only side-by-side of base vs HEAD served as virtual documents, guarded against workspace escape and rename-aware.
- [247 — Working-Memory Review Panel](247-vscode-next-memory-review-panel.md) — a singleton editor webview mirroring the sidebar's next-commit draft through the same host handler, so the two can never drift.
- [295 — Sidebar Status Tree](295-vscode-status-tree-panel.md) — the STATUS tab's three degenerate render states plus the enabled row set, where each dual-variant integration shows its merged row and an additional standalone warn row.
- [304 — Zero-Write Contract for a Manually-Disabled Repository](304-manually-disabled-zero-write-contract.md) — the in-process suppression flag seeded before the first log line, the full inventory of writes it stops, and the carve-outs that still reach disk.
- [329 — Context Snapshot Markdown Preview](329-vscode-context-snapshot-markdown-preview.md) — a read-only virtual-document scheme serving rendered markdown for snapshots composed in memory, keyed by a self-describing reference in the URI so a tab still renders after the host that built it is gone.

## The IntelliJ surface

- [118 — Tool Window Layout](118-intellij-tool-window-accordion.md) — a three-segment view switch over three collapsible sections sharing one scroll bar, with status, no-git, and onboarding takeovers.
- [119 — First-Run Onboarding Card](119-intellij-onboarding-wizard.md) — a single card offering the Anthropic-key path beside sign-in, flipping back to the accordion the instant either yields a credential.
- [120 — Embedded HTML Summary View](120-intellij-summary-viewer-embedded-html.md) — a self-contained interactive page for one memory, bridging to the host over a base64-tunneled message channel.
- [121 — Summary Virtual-File Editor](121-intellij-summary-virtual-file-editor.md) — one memory tab per project: every open site routes through a shared path that swaps the open tab's content in place rather than stacking a second tab, so two memories can no longer be viewed side by side.
- [122 — Changes Panel](122-intellij-changes-panel.md) — rows from a NUL-separated rename-aware `git status` with checkbox, status badge, muted parent dir, hover discard, and click-to-diff.
- [123 — Commits Panel](123-intellij-commits-panel.md) — one card per commit from HEAD back to the merge-base, expanding into four groups, above a branch token meter; checkboxes exist only inside an opt-in squash-selection mode, and the status chips hide behind an overflow chip.
- [124 — Project Service Lifecycle](124-intellij-project-service-lifecycle.md) — initialize the bridge on project open, watch for `.git` disappearing or returning, and notify panels over one subscription bus.
- [125 — Orphan-Branch Ref Monitoring](125-intellij-orphan-branch-ref-monitoring.md) — watch the orphan ref and worker lock through the platform watcher, debouncing bursts before telling panels to reload.
- [126 — Native Git CLI Wrapper](126-intellij-native-git-cli-wrapper.md) — invoke the system `git` with the user's interactive-shell PATH, a Windows PATH addition, a 15s default timeout, and threaded stdout reads.
- [127 — AI Provider Selector](127-intellij-ai-provider-selector.md) — a reusable form component exposing the chosen provider and resolved credential to the embedding dialog without persisting the choice itself.
- [128 — Delegated Hook Installation](128-intellij-hook-jar-extraction.md) — the surface ships no archive and no JVM entry point: it prepares state, sweeps legacy agent entries, then delegates the whole hook install to the command-line surface.
- ~~[129 — Config File Migration](129-intellij-config-file-migration.md)~~ **(REMOVED)** — there is no per-IDE config file and no migration copy; the surface reads and writes the shared machine-global `config.json`.
- ~~[130 — Memories Panel](130-intellij-memories-panel.md)~~ **(REMOVED)** — the standalone all-branches memories panel is no longer wired up; the list is now the branch-scoped COMMITTED MEMORIES section.
- [132 — PLANS & NOTES Panel](132-intellij-plans-and-notes-panel.md) — one newest-first list merging plans and notes, icon-tagged by kind and committed state, with open-on-double-click and confirmed delete paths.
- [133 — STATUS Panel](133-intellij-status-panel.md) — one row per status field with icon, label, gray description, and multi-line tooltip, rebuilt from scratch on every project-status change.
- [135 — Settings Surface](135-intellij-settings-dialog.md) — an IDE-native five-field page plus a separate five-tab modal, persisting to the same global config but with different fields and apply conventions.
- [191 — Binding Chooser Dialog](191-intellij-binding-chooser-dialog.md) — a modal listing the server's spaces on a binding-required rejection, registering the pick and closing so the caller can retry.
- [192 — Active Conversations Panel](192-intellij-active-conversations-panel.md) — one row per active conversation across all producers, refreshed on a timer, with pin, terminal-resume, and next-commit selection actions.
- [193 — KB Explorer Panel](193-intellij-kb-explorer-panel.md) — the Memory Bank parent folder as a two-level tree: discovered repos at top, each repo's visible content interleaved with user folders below.
- [212 — Claude/Codex Session Resume via Terminal](212-intellij-claude-session-resume-via-terminal.md) — open a project-rooted terminal tab running the source-appropriate resume command, gated by one shared predicate at three call sites.
- [216 — Knowledge-Wiki Build Trigger](216-intellij-knowledge-wiki-build-trigger.md) — exactly one build: a manual all-repos sweep behind a credential-gated toolbar button. This surface performs no ingest of its own, runs no automatic post-commit build, and holds no build lock.
- ~~[217 — Native LLM Seam](217-intellij-wiki-ingest-anthropic-mode.md)~~ **(REMOVED)** — the in-process LLM seam, its credential selector, its direct-vendor client and its alias resolver are all deleted; every model-backed action on this surface now spawns the CLI's generation bridge, and a build gate prevents reintroduction.
- [219 — CLI-Delegated Sync Orchestration and UI](219-intellij-vault-sync-ui.md) — a poll timer and a manual entry point turn each round into one bridge call, mapping the result into a status-bar badge and toolbar label with auto-clearing finished states.
- [220 — PINNED Panel](220-intellij-pinned-panel.md) — a newest-first list of pinned items mirroring each source row's badge and title, with open / resume / unpin hover actions and an empty placeholder.
- [221 — WORKING MEMORY Section Container](221-intellij-working-memory-section-container.md) — a vertical stack of consequence message, AI-summary status, and three input sub-sections above Commit and Review, reporting its natural height.
- [222 — Working Memory Web View Editor](222-intellij-working-memory-web-view-editor.md) — a read-only embedded-browser tab rendering the memory the next commit will save, with one button bridging back to run the AI commit.
- [223 — Conversation Transcript Editor](223-intellij-conversation-transcript-editor.md) — a non-modal tab with inline click-to-edit, per-message delete/restore, bulk delete, and a Save All that persists an identity-based overlay.
- ~~[248 — Git-Operation Queue](248-intellij-gitops-queue.md)~~ **(REMOVED)** — the IDE-native queue and its own hook are gone; every git event is captured and drained by the CLI surface's queue.
- [249 — MCP & Skills Integration](249-intellij-mcp-and-skills-integration.md) — extract the bundled CLI to a machine-global directory and shell out to its integrations-only enable; there is no native MCP registry writer.
- ~~[250 — Transcript Plan Discovery](250-intellij-transcript-plan-discovery.md)~~ **(REMOVED)** — the IDE-side scanner and its hook are gone; plans enter the registry only through the CLI's discovery, and this surface only reads.
- [251 — Create-PR View](251-intellij-create-pr-view.md) — a branch-level tab aggregating every committed memory on the branch into one draft and sharing them in the same submit action, opened in two stages so a cheap draft paints before the expensive one replaces it.
- [307 — Direct Memory-Mirror Read Path](307-intellij-direct-memory-mirror-read.md) — a second, filesystem-direct read source for four single-item memory shapes, attached after migration and gated per read on the out-of-sync marker, whose degradations are invisible and can be outlived by the cache in front of it.
- [309 — PR-Status Cache](309-intellij-pr-status-cache.md) — a project-scoped in-memory cache over the three forge probes, with two freshness windows, join-one-in-flight-probe deduplication, and a retention policy that keeps a genuine negative but discards a failed answer.
- [252 — Share-to-Jolli Core](252-intellij-share-to-jolli.md) — the UI-free core sharing one memory and its plans, persisting returned ids, and cleaning up orphans behind both share entry points.
- ~~[254 — Post-Commit Summarization Pipeline](254-intellij-post-commit-summarization-pipeline.md)~~ **(REMOVED)** — the IDE-native per-commit summarization pipeline no longer exists on this surface; summarization is owned entirely by the CLI queue worker.
- [260 — Cold-start Back-fill Card](260-intellij-cold-start-backfill-card.md) — the Swing analog of the VS Code card: same signals, same dismiss marker, same copy, driven through an out-of-process CLI bridge.
- [261 — Branch Share Store](261-intellij-branch-share-store.md) — a Kotlin port of the single-slot share store, deliberately never seeding a fresh subject's defaults from a stranded prior record.
- [262 — Live Branch Share](262-intellij-live-branch-share.md) — the share state machine rendered as an inline overlay inside the same summary webview; no separate window, dialog, or browser.
- [263 — Push Orchestration](263-intellij-push-orchestration.md) — a second, independent push implementation alongside the per-memory push, backing the live share feature and deliberately not unified with it.
- [264 — Force-Push Gate](264-intellij-force-push-gate.md) — detect non-fast-forward rejections, probe the divergence, and gate a real force-push behind a confirmation built from that probe.
- [271 — Pre-Push Sync Catch-Up](271-intellij-pre-push-sync-catch-up.md) — install the one hook that shells to the Node dispatcher, read the pending queue non-gatingly, and best-effort trigger a drain at a few lifecycle moments.
- [284 — Node.js Runtime Detection and Hard Gate](284-intellij-nodejs-runtime-detection.md) — two-phase detection (gather candidates, then prove each by execution) with a version floor, persisted winner, retry, and a blocking panel on failure.
- [298 — IntelliJ AI Commit Action](298-intellij-ai-commit-action.md) — stage the checked files, obtain a message from the command-line surface, offer a three-way review, then restore prior staging and force the IDE to re-read git state.
- [299 — IntelliJ Squash Action](299-intellij-squash-action.md) — consolidate a selected commit range with a generated message behind a two-step gesture, warning before rewriting pushed history and writing the squash-pending marker before the reset.
- [302 — IntelliJ Embedded-Browser Pool](302-intellij-jcef-browser-pool.md) — a project-scoped pool of reusable embedded-browser instances behind a checkout/hand-back discipline, prewarmed at project open, now shared by the memory tab and the branch-level PR draft, with a trim-on-hand-back population bound that is not admission control.
- [313 — IntelliJ Source Presentation Table](313-intellij-source-presentation-table.md) — one table mapping each reference source to its badge letter, brand hue and label, plus the label-composition policy the five consuming panels share.
- [314 — IntelliJ Native Memory Bank Metadata Read](314-intellij-native-memory-bank-metadata-read.md) — read the per-repo manifest and summary index straight off the hidden layer with no bridge round-trip, failing soft in both directions and carrying no dirty-gate.
- [315 — IntelliJ Memory Bank Heal Pass Gating](315-intellij-memory-bank-heal-pass-gating.md) — delegate the visible-Markdown heal to the command-line surface, throttled per repository by a clean-repo cache and a failure cooldown.
- [316 — IntelliJ Memory Bank Repo-Scope Filter](316-intellij-memory-bank-repo-scope-filter.md) — a synthetic "All repos" breadcrumb entry on its own callback, broadening the explorer through one volatile, never-persisted filter field.
- [317 — IntelliJ Archived Reference Body Read](317-intellij-archived-reference-body-read.md) — derive the command-line surface's archived-reference file stem before either read leg, since the GitHub and context7 sources carry native ids that are not path-safe.
- [318 — IntelliJ Memory Bank Folder Setting Key Migration](318-intellij-memory-bank-folder-setting-key-migration.md) — one field with a legacy-key alias recovers a pre-1.1 folder path on load and rewrites it under the canonical key on the next save.
- [332 — IntelliJ Enable / Disable Surface](332-intellij-enable-disable-surface.md) — the two gestures that turn capture on and off for one repository, the cached verdict and protection window that let the enable repaint before the work finishes, and the one-way projection folding a legacy machine-wide pause onto this repository's own opt-out.
