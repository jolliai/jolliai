# 217. IntelliJ Native LLM Seam (Retired)

## Topic Statement

This topic previously described an **in-process model seam** owned by the IDE plugin: a three-source credential selector (a configured direct-vendor key, the same key from the environment, or the product's platform key) with a provider-preference override and a fixed fallback order; a fail-loud guard when direct mode was selected without a pre-built prompt; a direct-to-vendor HTTP call with a streaming / non-streaming split, per-mode request timeouts, and two stream-rejection conditions; a model alias-to-id resolver; and a platform-proxy leg. It was reachable from exactly three read-path actions on the summary viewer, alongside several generators that already had no caller.

**None of that survives on this surface.** The whole in-process model stack was deleted: the seam, the direct-vendor client, the credential selector, the alias resolver, the proxy leg, and the already-unreachable generators (multi-topic summary, commit message, squash message, squash consolidation) together with the recap / end-to-end-test / translate prompt builders and response parsers. The three summary-viewer actions that were the seam's only live callers now spawn the command-line surface's generation subcommand instead. The plugin performs no model call of its own.

An earlier framing of this same topic — the IDE driving the knowledge-wiki ingest with a direct-vendor key, rendering route and reconcile prompts locally, and resolving plan/note source identifiers — had already stopped being live behavior before this. Its **source** outlived the behavior, and is now gone too: the local route and reconcile prompt templates, the route-plan response parser, the compiled-topic-page parser, and the reconciled-page assembler were all deleted in the same sweep. Each was already unreachable — nothing outside that cluster called any of them — so removing them changed source, not behavior. The IDE runs no ingest; wiki ingest is owned by the command-line surface and triggered from the IDE only as a delegated build.

The same is now true one step further downstream: the plugin's own **visible-wiki markdown renderer** — the Kotlin builder that turned a compiled topic into the browsable wiki page — was likewise already unreachable and has now been deleted, together with its test. The source finally caught up with the behavior here too; no live behavior changed, because nothing on this surface had called it since the ingest moved. The renderer that actually produces wiki markdown is the command-line surface's (spec 158), which is untouched by this and still live.

## Scope

**In scope:**
- Recording that the in-process model seam and everything it comprised — credential-source selection with its preference override and fallback order, the direct-mode prompt guard, the direct-vendor HTTP call with its streaming threshold and per-mode timeouts, streamed-event accumulation with its mid-stream-error and missing-terminal-event rejections, the model alias resolver, and the platform-proxy leg — has been removed from the plugin.
- Recording that the generators that shared that seam (multi-topic summary, commit message, squash message, squash consolidation) and the recap / end-to-end-test / translate prompt builders and parsers were removed with it, and that all four generators were already unreachable when they were removed.
- Recording that the ingest-era leftovers this topic's earliest framing described — the local route and reconcile prompt templates, the route-plan parser, the compiled-topic-page parser, and the reconciled-page assembler — were deleted in the same sweep, and were also already unreachable.
- Recording that the plugin's own visible-wiki markdown renderer was deleted for the same reason (already unreachable), and that the command-line surface's renderer (spec 158) is unaffected and remains the live one.
- The supersession relationship: the three summary-viewer actions that used this seam — generate an end-to-end test guide, regenerate the quick recap, and translate a document to English — now spawn the command-line surface's generation subcommand and use its three corresponding actions.
- Recording that a build gate now scans production sources on this surface and fails the build if a direct model-vendor call is reintroduced.

**Out of scope (boundaries):**
- The generation subcommand the three actions now spawn — its invocation form, per-action request and response shapes, error envelope, and exit-code contract — spec 292.
- Credential resolution and provider precedence as a product concept, now resolved entirely on the command-line side — spec 10.
- The wiki ingest itself (batching, route-then-reconcile orchestration, per-topic concurrency, the high-water mark, processed-source marking, outcome codes) — spec 152. The IDE does not run it.
- The IDE's wiki-build trigger, a delegated call to the command-line surface — spec 216.
- The platform-proxy request/response protocol — spec 9.
- The visible-wiki renderer — spec 158.
- The summary viewer page that hosts the three actions — spec 120.

## Data Contracts

There is no live data contract for this topic. The plugin defines no credential-source enumeration, no provider-preference input, no model-call input record, and no model-call result record. The credential sources, the provider preference, the model identifier, the output-token ceiling, and the resolved-model / token-count / latency / stop-reason result fields are all resolved and produced on the command-line side now, against its own contracts.

## Behavior

### Current reality

Each of the three summary-viewer actions serializes the inputs it holds — the stored memory's topic list, its commit message, the commit's own change, or the document text — and spawns the command-line surface's generation subcommand with the matching action name. The subcommand loads the shared configuration itself, resolves credentials and the provider by its own rules, builds the prompt, makes the call, and returns one result line. The plugin reads that line, persists the derived text onto the stored memory, and re-renders. It holds no credential ordering rule, no prompt, and no transport of its own.

The same subcommand is what the plugin's commit-message and squash-message actions already used, so all five of the product's generation flows now run in one place.

### Retired behaviors

The following behaviors this topic used to describe are **no longer present** on this surface:

- Selecting a credential source in-process from three candidates, in an order dictated by a configured provider preference, and throwing a no-credentials error when none was present.
- The fail-loud direct-mode guard that converted a missing prompt into an explicit, action-named failure instead of a null dereference.
- The direct-to-vendor HTTP call: its request shape, its fixed zero temperature, its streaming-vs-non-streaming threshold on the output-token ceiling, and its two different request timeouts.
- Accumulating a line-oriented event stream, and its two rejection conditions — a mid-stream error event, and a stream that ended without its terminal stop event.
- Resolving a model alias to a concrete vendor model id before each call.
- The platform-proxy leg of the seam, including its always-null stop reason.
- The four generators that shared the seam (multi-topic summary, commit message, squash message, squash consolidation) and the prompt builders and response parsers behind the three viewer actions.

## State Transitions

None. This topic has no live surface. Both diagrams it used to carry — the per-call credential-mode resolution, and the streamed-call terminal state — describe code that no longer exists.

## Notable Behavior

- **The two divergences this topic recorded are resolved, not relocated.** It used to record that the recap action ignored the configured provider preference (two of the three callers forwarded it, the recap caller did not), and that the seam recognized no local-agent provider at all, so a user holding only a local-agent subscription got a no-credentials error from all three actions. Both are gone: each of the three actions now spawns the subcommand with no provider argument, the subcommand loads the shared configuration itself, and the local-agent provider is one of the sources it resolves. All three actions now behave identically with respect to the configured provider, and a local-agent user can drive all three.
- **A build gate prevents reintroduction.** The build scans this surface's production sources for a direct model-vendor endpoint, and for the runtime's built-in HTTP transport the deleted stack was built on, and fails when a match appears outside a short allowlist of the remaining non-model network traffic. The gate is two-sided: an allowlist entry that no longer matches also fails, so the list cannot bloat past what is genuinely in use. Unlike the surface's other source gate it carries no ratcheting baseline — a hit is a defect to fix, not something to record — and it runs as part of the normal test invocation rather than as a separate pipeline step, so a second model stack cannot reappear here unnoticed.
- **Most of what was deleted was already dead, so most of this change is source-only.** The four generators and every ingest-era leftover had no caller on this surface before removal; deleting them changed no behavior. Only the seam itself and the three viewer actions' prompt builders and parsers were live, and those were replaced in the same change rather than dropped. Read the deletion list as "the source finally caught up with the behavior", not "a capability was lost".
- **The streaming client this topic documented never ran.** All three live callers requested the same moderate output-token ceiling, which sat below the streaming threshold, so every in-process call this surface ever made on the live path was non-streaming. The streaming transport, its longer timeout, and both stream-rejection conditions were code with no live entry point at the time they were deleted.
- **No correlation scope survives around a model call.** The seam opened a correlation scope for each call so every log line of one model operation shared an identifier. That scope lived in the deleted code and was not re-established around the subcommand spawn — see spec 292 for the consequence on the calling side.

## Shared Behavior

- **`jolli generate` — the generation bridge (292)** — the subcommand the three summary-viewer actions now spawn, and the owner of the request/response and error contracts they depend on. It also owns the caller-side reachability record for all five actions.
- **Credential priority (10)** — the credential sources and their precedence, now resolved wholly on the command-line side. This spec no longer grounds any "JVM-surface" statement in that spec; the surface holds no credential ordering rule of its own.
- **The platform-proxy request protocol (9)** — the proxy leg this seam used to hold is gone; the proxy is now reached only from the command-line side.
- **Wiki ingest (152) and its IDE trigger (216)** — the ingest the earliest framing of this topic described. It runs only on the command-line surface, and the IDE's only involvement is the delegated build trigger.
- **The summary viewer (120)** — the page that hosts the three actions and renders their results.
- **IntelliJ Post-Commit Summarization Pipeline (254, retired)** — the sibling retirement; the deleted multi-topic generator was that pipeline's model call.
