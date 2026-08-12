# 148. MCP server — tool surface

## Topic Statement

A long-lived server speaks the Model Context Protocol over a standard-input/standard-output transport, advertising a fixed set of named tools over the current working directory's stored memory. Most tools are read-only projections (search, recall, topic timeline, branch catalog, PR description, queue status, installation status); the Jolli Space tools reach the Jolli Space backend (list spaces, bind this repo to a space, push this branch's summaries to the bound space). Every tool returns a JSON-text response.

## Scope

**In scope:** the entry-point command that launches the server (and its one-shot reindex mode); the transport choice; the lifecycle from process start to transport close; the fixed list of advertised tools with each tool's public name, description text, declared argument shape, required-argument flags, and abstract response shape; argument-validation rules done at the tool boundary; how a successful result is wrapped for the client; how a failed call is wrapped; how unknown tool names are handled; how missing-arguments fields are handled; the working-directory binding the server uses to resolve every tool call; the storage-backend initialization done at startup; the per-server search-index cache that makes repeated searches cheap.

**Boundaries:**

- The MCP-client-registration spec (writing per-client configuration files that point a client at this server) owns install-time wiring; this spec only describes what such a client interacts with at runtime.
- The single-phase search pipeline spec owns the algorithm, ranking, and result-envelope details that back the `search` tool; this spec only describes what crosses the tool boundary (the accepted argument shape and the hit-list response shape).
- The `search` tool surface here accepts no recency argument; the search path applies no date filtering at all (see the search-recency-filter spec, which records that the recency filter has been removed from search).
- The PR-description builder that backs the `get_pr_description` tool — the commit-range derivation, the summary aggregation, the body composition, and the missing-summary footnoting — is owned by the PR-description spec; this spec only describes what crosses the tool boundary (the accepted argument shape and the title/body/count response shape).
- The development-context-recall spec owns the compilation, branch-resolution fallback chain, plan and note aggregation, token-budget enforcement, and truncation policy that back the `recall` tool; this spec only describes what crosses the tool boundary.
- The summary-catalog-file spec owns how branch topic titles are aggregated; the `list_branches` tool here only re-emits the catalog as the response.
- The summary-tree-structure / topic-page storage specs own how a topic page is stored and read; this spec describes only the timeline-projection done on top of a successfully loaded page.
- The recall-skill and search-skill content specs own the on-disk markdown templates that an agent loads alongside (but separate from) these tools.
- The reindex flag exposed by the same entry-point command rebuilds the local search index and exits without ever opening the transport; the index-rebuild data flow itself is owned by the search pipeline spec — this spec only documents that the same command has the two mutually exclusive modes and that both modes initialize the storage backend before doing anything else.

## Data Contracts

### Server identity

The server advertises itself to the connecting client with a fixed product name and a version string that matches the host package's version constant. The advertised capability set declares support for the tools facet (always) and the prompts facet (only when a curated `/jolli` menu is active — see "The `/jolli` menu prompt" below); resources and sampling are never declared. With the menu inactive — the default — the capability set is tools-only.

### Tool registry (abstract)

The **built-in** tools are always advertised; the static registry in the table below is the contract. Tool names are part of the wire contract — clients call tools by string name — and are therefore quoted here. Each tool entry consists of a name string, a description string (free-form natural language shown to the client/LLM as guidance), and an argument schema declared as an object-typed JSON-schema fragment with named properties and an optional required-property list. `search`, `recall`, `get_decision_timeline`, `list_branches` and `get_pr_description` are read-only memory projections; `queue_status` reads (and optionally blocks on) local queue/worker state; `status` reads local installation and configuration state; `list_spaces`, `bind_space` and `push_memory` call the Jolli Space backend.

When the platform-tools gate is open (the default), this built-in set is **augmented** at startup with backend-defined *platform tools* fetched from a manifest (see "Backend-defined platform tools" below). The built-in registry itself is never mutated and is always present; platform tools are additive.

| Tool name | Required args | Optional args | Response shape (abstract) |
|---|---|---|---|
| `search` | `query` (string) | `branch` (string), `type` (enumerated: topic-kind or commit-kind), `limit` (number) | An object with a single `hits` array; each hit carries an identifier, a kind discriminator, a title, a snippet, a branch label, a commit-date string, a slug, a hash, and a numeric score |
| `recall` | — | `branch` (string) | A structured recall payload with a kind discriminator, a branch label, a period range (start and end), a commit count, aggregate insertion/deletion/files-changed counters, a commits projection (one hit-like entry per commit), a plan list (each with slug, title, and optional content), a note list (each with id, title, and optional content), an optional user-knowledge list (each with title, source path relative to the memory bank, scope label, optional content), aggregate stats, an estimated-token count, and an optional truncation flag |
| `get_decision_timeline` | `slug` (string) | — | An object with the topic's slug, the topic's title, and a timeline array; each timeline entry has a timestamp string, a branch string (empty when absent on the underlying source reference), a source-type string, and a source-id string |
| `list_branches` | — | — | A branch-catalog object with a kind discriminator, an optional query string, and a branches array; each entry carries a branch name, a commit count, a period (start and end), a commit-message list, and an optional topic-titles list |
| `get_pr_description` | — | `baseBranch` (string), `includeMarkers` (boolean) | A PR-description payload carrying a kind discriminator, the described branch label, the base branch label, a title string, a body string, a commit count, a summary count, and a missing-summary count |
| `queue_status` | — | `wait` (boolean), `timeoutMs` (number, default 120000 when waiting) | The queue-status object (active count, ingest-active count, worker-busy flag, worker-blocking flag, drained flag, stale count) plus an optional waited-milliseconds field when the wait path ran. Behavior owned by spec 218. |
| `status` | — | — | The installation & configuration health report — product version, an enabled flag, the hook block, a data-migration descriptor, the account block, a total session count, the per-integration list (each optionally carrying per-channel scan errors), the stored-memory count, the orphan-branch name, the bound Space (or null), and — only when outbound push is off — a push-disabled flag and, when the OFF verdict came from an unreadable store rather than the user's choice, its reason string. See "The `status` result shape" below. |
| `list_spaces` | — | — | An object with a list of the tenant's Jolli Spaces (each bindable) and the tenant's configured default space id (or null). Behavior owned by the CLI space-push specs (230/231). |
| `bind_space` | `space` (string) | — | A type-tagged union: a `bound` result (carrying the new binding's identifiers and repo name) or an `already_bound` result (carrying a message). An already-existing binding is **not** an error. Behavior owned by the CLI space-push specs (230/231). |
| `push_memory` | — | `baseBranch` (string), `space` (string) | The branch-push result. When the repo is not yet bound to a space, the result is a type-tagged `binding_required` outcome carrying the available spaces — a legitimate "needs input" result, **not** an error; the caller re-invokes with `space` set (or calls `bind_space` first) to bind and push. When the user has opted this repo out of outbound push (spec 310), the result is a type-tagged `push_disabled` outcome carrying an explanatory message — also **not** an error, and not retryable: the push was refused before any network call and memory remains recorded locally. Behavior owned by the CLI space-push specs (230/231). |

### Tool-description text (advertised verbatim)

The description strings are part of the surface because LLM clients select tools based on them. They are:

- For `search`: "Full-text search over this repo's historical decisions and implementations (topics + commits). Use to check how a topic was handled before."
- For `recall`: "Recall the development context for a branch from raw commit summaries (decisions, plans, notes, commits) — the same data the jolli-recall skill uses, NOT the topic KB. Omit `branch` to recall the current branch."
- For `get_decision_timeline`: "Chronological evolution of a topic — its source events ordered oldest-first."
- For `list_branches`: "List all branches that have JolliMemory records, with their topic titles."
- For `get_pr_description`: "Build a GitHub PR title + description from the CURRENT branch's JolliMemory commit summaries — the same memory-rich body the VS Code extension writes. Use before `gh pr create` so the PR embeds the curated memory instead of a diff-derived summary. Always describes the current branch (the commit range is base..HEAD)."
- For `queue_status`: "Report whether this repo's memory-summary generation is still in progress. Call before building a PR (get_pr_description) so freshly-committed summaries are included. Wiki/graph rendering is excluded from the verdict. Pass `{\"wait\": true}` to block until drained (default 120s, override with timeoutMs)."
- For `status`: "Report Jolli Memory's installation & configuration health for this repo: which hooks are installed, the active hook runtime, data-migration state, account / API-key configuration, detected AI integrations with their session counts, the stored-memory count, and the orphan branch. This is the environment health check — pair it with queue_status (generation progress), not list_branches (recorded memory)."
- For `list_spaces`: "List the Jolli Spaces this tenant can bind a repo to, plus the tenant's configured default space."
- For `bind_space`: "Bind this repo to a Jolli Space so `push_memory` can push to it. Idempotent — binding an already-bound repo returns `{type:\"already_bound\"}` rather than erroring."
- For `push_memory`: "Push this branch's JolliMemory commit summaries to the bound Jolli Space as articles. If the repo isn't bound yet, returns `{\"type\":\"binding_required\"}` with the available spaces — call again with `space` set (or use `bind_space` first) to bind and push. If the user has turned outbound push off for this repo, returns `{\"type\":\"push_disabled\"}` — memory is still recorded locally; this is a deliberate setting, so do not retry, and tell the user to re-enable it instead."

### Per-property descriptions

Tool argument properties are advertised with their own short description strings. The `query` property describes itself as a natural-language or keyword query; `branch` (on search) describes itself as an optional restriction to one branch; `type` describes itself as an optional restriction to one of the two result kinds; `limit` describes itself with the implicit default of 20; `branch` (on recall) describes itself as defaulting to the current branch; `slug` describes itself as a topic stable-slug; `baseBranch` (on get_pr_description) describes itself as the base branch for the commit range, defaulting to the repository's default branch (origin/HEAD) and falling back to main; `includeMarkers` (on get_pr_description) describes itself as wrapping the body in update markers for idempotent PR edits, defaulting to true. `wait` (on queue_status) describes itself as blocking until the queue drains or the timeout elapses; `timeoutMs` (on queue_status) describes itself as the max milliseconds to wait when waiting, defaulting to 120000; `baseBranch` (on push_memory) describes itself as the base branch for the commit range, defaulting to the repository's default branch; `space` (on push_memory) describes itself as a Jolli Space id, slug, or name to bind before pushing if not already bound; `space` (on bind_space) describes itself as a Jolli Space id (numeric), slug, or exact name to bind this repo to.

Three tools declare an **empty** property set and therefore advertise no per-property descriptions at all: `list_branches`, `list_spaces`, and `status`. Their schema is an object schema with no properties and no required list, so a client may call them with no arguments key whatsoever.

### The `status` result shape

The `status` tool's result is a curated health report — the structured mirror of the human-readable `jolli status` report (58), but a **different, curated shape**, not that command's raw machine-readable snapshot. It carries:

| Field | Contents |
|---|---|
| Version | The product version string. |
| Enabled flag | True when the git hook is installed. |
| Hooks | A block with: a `summary` string (e.g. `5 Git + 2 Claude + 1 Gemini`, or `none installed`); booleans for the git family, the pre-push hook, the Claude agent hooks, and the Gemini agent hook; and a `runtime` string naming the source and version that wrote the active hooks (e.g. `cli@1.0.0`), or null when no source is registered. |
| Data migration | A one-line descriptor of the schema-migration state — the same wording the CLI report prints. |
| Account | A **provider-contextual** block — see "The account block is provider-contextual" below. Always present: a signed-in boolean, the explicit AI-provider choice (`anthropic`, `jolli`, `local-agent`, or null when unset), the public site host with its scheme stripped (or null), and a site label that reads `Jolli Site` when an on-disk credential backs the URL and `Last signed-in site` otherwise (null when there is no site). Conditionally present: a product-API-key-present boolean, a vendor-API-key-present boolean, and a human-readable local-agent tool label. |
| Sessions | The total active session count across all integrations. |
| Integrations | The per-integration list (below). |
| Stored memories | The count of recorded summaries. |
| Orphan branch | The orphan-branch name used for summary storage. |
| Space | The bound Jolli Space as an object carrying its name, or null when the repo is unbound or the binding is unknown/stale. |
| Push-disabled flag | **Conditionally present.** A boolean carrying only the value `true`, emitted only when this repo's outbound push to a Jolli Space is off. Absent otherwise — the underlying gate treats an absent flag as "allowed", so absence is the honest encoding of "this repo pushes". Without it, a caller whose push was refused has no channel for learning why. |
| Push-disabled reason | **Conditionally present.** A human-readable string, emitted only when the push-disabled flag is emitted **and** the underlying snapshot carries a reason. It is present exactly when the OFF verdict is *not* the user's recorded choice — the push-control store could not be read, which fails closed and reports OFF for every repo on the machine. The boolean alone would misattribute a machine-wide read failure to a per-repo decision the user never made, so the two travel together: both halves, or neither. |

Each **integration entry** carries:

- A product name, verbatim (`Claude`, `Codex`, `Gemini`, `OpenCode`, `Cursor`, `Devin`, `Copilot`, `Cline`, `Antigravity`).
- A detected flag, which is **always true** — undetected integrations are absent from the list entirely rather than present with a false flag.
- A single `status` descriptor string that already embeds the session count with its unit (e.g. `hook installed (15 sessions)`, `detected & enabled`, `detected but disabled`, `hook not installed`, `unavailable — <kind>`), matching the `jolli status` row wording exactly. There is deliberately **no** separate numeric session-count field: a redundant raw number let some renderers show a unit-less count while others showed `(N sessions)`, so the count lives only inside this string.
- An optional per-channel **scan-error list**, present only when at least one channel of a merged dual-variant integration failed to scan. Each entry carries a human channel label, the failure kind, and the failure message. The channel labels are `CLI` / `Chat` for Copilot, `VS Code` / `CLI` for Cline, and `IDE` / `CLI` for Cursor. Single-channel integrations never populate it: their failure is never masked, because it already reads as `unavailable — <kind>` in the descriptor.

The list exists because a merged integration's flat descriptor stays healthy when only **one** of its two channels fails (so the surviving channel's session count is not masked — see 58), which would otherwise make a single-channel failure completely invisible to an MCP caller. It is the structured counterpart of the CLI report's `↳ … scan failed` sub-lines and the VS Code status tree's per-channel warning rows (295).

#### The account block is provider-contextual

Three of the account fields are surfaced **only** in the state where they are meaningful, and omission is by **field absence** — the field is not present in the object at all, rather than present with a `false` or empty value:

| Field | Present when | Absent when |
|---|---|---|
| Product-API-key-present boolean | The caller is signed **out**. | Signed in — a sign-in already implies a product generation credential, so the key's presence is redundant. |
| Vendor-API-key-present boolean | The AI-provider choice is exactly the vendor-direct one. | Every other provider (product-proxy, local-agent, unset), where a vendor key is moot. |
| Local-agent tool label | The AI-provider choice is exactly the local-agent one. It is the tool's human-readable display name (e.g. the display name of Claude Code or of Codex), defaulting to the default tool's name when the tool setting is absent and degrading to a generic label for a tool identifier this build does not recognize. | Every other provider. |

The always-present provider enum is what a caller branches on to know which of the conditional fields to expect.

The motivation is a real misreport: while both credential booleans were unconditionally present, an AI host reading a healthy local-agent user's report saw two `false` credential booleans and concluded that memory generation was disabled — for a configuration that needs no stored credential at all. Absence is unambiguous where `false` was not.

The report never decodes the API key: the site is read from the persisted site URL, and credential presence is exposed as booleans only, so no secret material can reach the result.

The curated result is a **named projection**: it emits only the fields listed above, so any other field the underlying installation snapshot carries is dropped rather than passed through. That is why adding a snapshot field is invisible to an MCP caller until the projection names it. The push-disabled pair above is the counter-example that proves the rule — those two fields reach a caller because the projection was extended to name them, conditionally.

The still-dropped case is the **Memory Bank / folder-layer state**, which the underlying snapshot carries and this projection does not name. An AI host asking for installation health therefore cannot see a degraded folder layer; the gap is recorded as observable in spec 300.

### Tool-result envelope

Every tool call — success or failure — returns a content envelope with a single content block. The block is text-typed and its text is the JSON-serialized form of the inner result.

There are **two** paths that mark the envelope as an error response (both applicable to every tool):

1. **Thrown-error path.** When the handler throws, the inner JSON object is shaped `{ "error": <message-string> }` and the error flag is set. (This is the original path; unknown-tool-name and required-argument-validation failures flow through it.)
2. **Result-shape path (added).** When the handler returns normally, the envelope is **additionally** marked an error response **if and only if** the resolved result is a non-null object whose `type` field is exactly the string `"error"`. This augments — does not replace — the thrown-error path, and unifies the contract across tools that report failure as a structured `{ type: "error" }` result rather than by throwing.

A structured `binding_required` result (from `push_memory` on an unbound repo) is explicitly a legitimate "needs input" outcome and is **not** marked an error — only `type === "error"` triggers the flag. Likewise `already_bound`, `bound`, and `push_disabled` (the per-repo opt-out, spec 310 — the user's own setting, not a failure) are normal results.

### Backend-defined platform tools (on by default, manifest-driven)

Beyond the built-in tools, the server can advertise additional *platform tools* defined by the tenant's backend. This is **on by default** (matching the other `*Enabled` config keys), gated by a CLI-side activation flag (a boolean config key that counts as enabled when unset, with an environment-variable override that force-enables even over an explicit opt-out). When the gate is closed — only when the config flag is explicitly set to `false` and the env override is unset — the server registers no platform tools and makes **no** network call for a manifest; it behaves exactly as a built-in-only server. Because the manifest fetch is best-effort (see below), defaulting on costs a keyless or older-backend install nothing: it degrades silently to the built-in-only surface.

When the gate is open, at startup (once, before the transport connects) the server fetches a tool manifest from the backend over the same authenticated channel the Jolli Space tools use: the long-lived product key, the tenant origin/base URL derived from that key, and the same bearer + tenant/org request headers. Each manifest entry carries a tool name, a description string, and an object-typed JSON-Schema argument shape — the same three fields a built-in registry entry carries — and each surviving entry is spliced into the advertised tool list alongside the built-ins. An entry may also carry a REST `binding` (an HTTP method plus a path) that the generic executor uses to reach the tool's backend endpoint; the binding is internal routing metadata, not part of the tool schema advertised to the client. An entry may additionally carry an optional `menu` block (`{ label, description?, order? }`) that flags the tool for the curated `/jolli` menu prompt (see below); it too is metadata, never part of the advertised tool schema.

The manifest fetch is **best-effort**: any failure — the backend surface being disabled (an empty manifest, or the endpoint absent so the request is refused), the key lacking permission to invoke platform tools, no key configured, a network/timeout/abort error, or a non-JSON body — degrades silently to "no platform tools". A disabled or older backend therefore never breaks server startup; it simply yields the built-in-only surface. An individual manifest entry with a malformed **advertised-schema** field (a missing/blank name, a non-string description, or an argument shape that is not an object schema) is dropped rather than failing the whole manifest. A malformed `binding` or `menu`, by contrast, is internal metadata that is never advertised, so it does **not** drop the tool: it degrades at field granularity (a bad `binding` is discarded and the call falls back to the conventional endpoint; a bad `menu` just omits the menu item), so a partially-rolled-out or buggy backend never loses a working tool. The fetch uses a short timeout so a slow backend cannot stall startup.

**Name collisions:** a built-in tool always wins. A manifest entry whose name matches a built-in tool's name is dropped (with a warning) so the built-in handler stays reachable and its wire contract is never shadowed.

### Platform-tool dispatch (generic executor)

A call to a platform tool is relayed by a single generic executor: it sends the call's arguments, unchanged, to the endpoint the manifest advertised for that tool — the tool's `binding` (an HTTP method plus a path) — and returns the backend's JSON response. When a manifest entry carries no binding — including one whose `binding` was structurally malformed and therefore normalized away to none at parse time — the executor falls back to the conventional `POST /api/mcp/tools/<name>` (name URL-encoded). Two safety checks gate an advertised binding, and either failure falls back to the conventional endpoint: (1) the method must be a **body-carrying** HTTP method (`POST`/`PUT`/`PATCH`/`DELETE`, compared case-insensitively) — `GET` and `HEAD` are deliberately excluded, because the executor always relays the call's arguments as a JSON request body and those methods cannot carry one, so a `GET`/`HEAD`-natured binding falls back to the conventional (`POST`) endpoint rather than advertising a method that would fail before reaching the network; (2) the path is resolved against the tenant origin and honored only when the **resolved** origin equals the tenant origin. The origin is compared *after* full URL normalization — a raw-string prefix check is insufficient because the URL parser rewrites `\` to `/` and strips embedded tab/CR/LF, so inputs like `/\host` or a path with a control character would otherwise smuggle an off-origin host. This ensures a manifest can never redirect the authenticated request (and its bearer token) off-origin. Argument validation is the backend's responsibility (validated against the manifest schema server-side); the executor does not re-validate on the client. The response is wrapped in the identical tool-result envelope the built-in tools use — the same single text block, and the same two error paths: a relayed call that fails (a non-2xx backend response, or an unparseable success body) throws and is wrapped as `{ "error": <message> }` with the error flag set; a normally-returned object whose `type` is exactly `"error"` is flagged an error by the result-shape path; any other returned object (including a "needs input"-style result) is a normal result.

### The `/jolli` menu prompt (opt-in, curated)

Inside the same platform-tools gate, the server can register a single MCP **prompt** named `jolli` (surfaced in Claude Code as `/mcp__jollimemory__jolli`) that presents a curated menu of actions and steers the agent to invoke the corresponding — already-registered — tool. The menu is the union of two sources, both computed only when the gate is open:

- **Platform tools flagged for the menu:** manifest entries carrying a `menu` block. Each contributes a menu item whose label comes from `menu.label`, whose description is `menu.description` (falling back to the tool's own description), and whose sort hint is `menu.order`.
- **A CLI-side local-tools inclusion list:** built-in tool names the host chooses to surface. This list is **initially empty** (an extension point); a name in it that does not match a built-in tool is ignored.

The menu is sorted by `order` ascending (unordered items last), then by label, then by tool name.

**The menu governs whether the prompt exists at all.** If the menu is empty — the gate is closed, the manifest is empty, no entry is menu-flagged, and the local list is empty — the server declares **no** prompts capability and registers **no** prompt handlers; it is byte-identical to a tools-only server. Only a non-empty menu causes the prompts capability to be declared and the `jolli` prompt to be registered. Because absent `menu` metadata simply yields an empty menu, a CLI carrying this feature that runs against an older backend (one that does not yet emit `menu`) degrades silently to no prompt — the menu lights up only once the backend flags tools for it.

A malformed `menu` block degrades at **field granularity**, never dropping the tool: a `menu` that is not an object, or lacks a non-empty string `label`, is discarded entirely (the tool stays a normal, directly-callable tool with no menu item); a valid `label` with a malformed `description`/`order` keeps the label and drops only the offending field.

The prompt declares a single optional free-text argument, `request`. A list-prompts request returns exactly the one `jolli` prompt. A get-prompt request builds a steering **message** (prompts return messages, not a native picker) from the menu items — each item's label, description, and the tool name to call:

- **`request` provided (non-empty):** the message instructs the agent to match `request` to one menu item and invoke that tool directly, asking the user only when the intent is ambiguous or matches nothing.
- **`request` absent/empty:** the message instructs the agent to present the menu using an interactive single-select tool where the host provides one (for example Claude Code's `AskUserQuestion`), otherwise to enumerate the options as text, capture the choice, then invoke the corresponding tool.

The steering message is host-agnostic — the `AskUserQuestion` reference is only an example and the text-list fallback keeps the prompt usable in any MCP host. A get-prompt request for any name other than `jolli` is rejected. Every menu item is one of the tools already advertised in `tools/list`, so the prompt only steers; it is never a second execution path, and it changes no tool name or handler.

### Working-directory binding

The server captures one absolute working-directory string at startup and uses that same value to satisfy every subsequent tool call. That string is **not** the raw process working directory: the entry-point command resolves the enclosing git repository root of the launch directory and binds *that*, falling back to the launch directory when the resolution fails (not inside a git repository, or git is unavailable). An AI host that spawns the server from a subdirectory of the repo therefore still binds the repo root. There is no mechanism to change the binding without restarting the process. The binding is also used as the kb-root argument when initializing storage — i.e. the same path is used for both the project root and the kb-root. The resolution rule itself is owned by the project-state-root-resolution spec (311).

### Reindex-mode output

When the entry-point command is invoked in reindex mode, no transport is opened; instead a single line is written to standard output reporting "Reindexed N document(s)." where N is the document count returned by the rebuild.

## Behavior

### Entry-point command

The entry-point command exposes two mutually exclusive modes. Without a flag, it starts the long-lived server. With the reindex flag, it performs an immediate full rebuild of the local search index and exits without ever opening the transport. The working-directory binding is resolved **once**, at the top of the command action and before the mode branch — the enclosing git repository root of the launch directory, falling back to the launch directory — so both modes share the identical value (see 311). Neither mode re-reads the process working directory afterwards.

### Startup sequence (long-lived mode)

0. **Local-agent child guard (runs first, before storage init).** If the process
   is marked as a descendant of a product-spawned local agent, the entire server
   startup is a **no-op**: it logs and returns immediately. Reentry is detected
   through **either** of two independent channels — an inherited environment
   marker, **or** a marker file inside the bound working directory. The
   working-directory channel exists because this process is spawned by the *host*
   rather than by the product's own child, and a host's environment allowlist can
   strip the marker, whereas the working directory is the one thing every host
   preserves. Both markers and the reason for the split are owned by the
   local-agent CLI provider backend spec (280).

   This prevents a nested agent CLI (which the product spawned to generate a
   summary) from recursively launching a full MCP server rooted at the agent's
   throwaway temporary working directory — which would otherwise claim a spurious
   Memory Bank "repo" named after that temp dir on every summary call.

   What the host observes: the return happens **before storage is bound, before
   any request handler is registered, and before the transport is opened**, so the
   process exits immediately with no protocol negotiation and no advertised tools
   at all. There is no degraded or empty-tool-list server — there is no server.

   **The index-rebuild mode does not consult this guard.** It is reached through
   the same entry-point command, but the guard lives in the long-lived server's
   startup path only, so a reindex invoked from inside a product-spawned agent
   still binds storage and rebuilds.
1. **Diagnostic-log anchoring.** The process-wide diagnostic-log directory is
   pointed at the bound (already repository-root-resolved) working directory.
   This runs immediately after the guard and *before* storage initialization,
   so it is the first thing the surviving process does. The reason is specific
   to this entry point: the server is long-lived and writes a diagnostic line on
   every tool call, so leaving the log directory unset would let a server
   launched from a subdirectory accumulate an entire session's diagnostics in a
   stray state directory under that subdirectory rather than in the repository's
   own. (Spec 131 owns the log-directory contract; 311 owns the resolution rule.)
2. Storage-backend initialization runs next — the first thing after the guard that touches memory state. The configured backend is constructed for the bound working directory (used both as the project root and the kb-root) and is installed as the process-wide active storage. This must happen before any tool handler runs; otherwise reads through the store would silently fall back to the default backend (the orphan-branch fallback), producing wrong results for folder-mode or dual-write configurations and emitting a warning on every read in this otherwise long-lived process.
3. A server instance is created with the advertised name "jollimemory" and the host package version. It declares the tools capability always, and the prompts capability only when the curated `/jolli` menu is non-empty; it declares no other capability.
4. A list-tools handler is registered that, on request, returns the fixed tool-registry array verbatim.
5. A call-tool handler is registered (see below).
6. A standard-input/standard-output transport is constructed and the server is connected to it. The startup function awaits this connect call; it resolves when the transport closes.
7. A single informational log line records that the server is connected over stdio and the working-directory binding it captured.

### Startup sequence (reindex mode)

1. Storage-backend initialization runs first, identical to long-lived mode, and for the same reason — otherwise the reindex would read from the wrong (possibly empty) store and report a misleadingly small document count.
2. A full rebuild of the local search index is invoked, threading the same storage handle so the index is written to the same directory the long-lived server would later read it from.
3. A confirmation line is written to standard output, and the process returns from the action (no transport is ever opened).

### Request dispatch (list-tools)

A list-tools request is satisfied by returning the advertised tool list. With platform tools disabled (an explicit opt-out) this is the fixed built-in registry array, returned verbatim — no mutation, no filtering, no per-client customization. With platform tools enabled it is a locally-built array of the built-in registry followed by the surviving manifest tools, each **projected down to its public schema** (name / description / inputSchema); the tool's internal `binding` and `menu` metadata are deliberately omitted from the advertised entry so they never reach a client (the full entries are retained only for dispatch). The built-in registry array itself is still never mutated (when no platform tools survive, the built-in array is returned directly).

### Request dispatch (call-tool)

For each incoming call-tool request:

1. The tool name and the arguments object are read from the request. If the arguments field is missing entirely, it is treated as an empty object — no error is raised at this stage.
2. The bound working directory, the tool name, and the arguments are routed through a fixed switch on the tool name. Routing is by exact string match.
3. The selected handler runs (see per-tool behavior below). Any value it returns is serialized to JSON and wrapped in a single text-typed content block. The error flag is set on this returned response **only** when the result is a non-null object whose `type` is exactly `"error"` (the result-shape path in the tool-result envelope); otherwise the response carries no error flag — including for a `binding_required` result, which is a normal "needs input" outcome.
4. Any thrown value from the handler is caught. The error message is extracted: an Error-shaped throw yields its message string, any other throw is coerced via string-conversion. The wrapper logs a warning naming the failed tool and the message. The response wraps `{ "error": <message> }` as JSON in a single text-typed content block, with the error flag set true.
5. An unknown tool name throws an error of the form "Unknown tool: <name>", which then flows through the same error-wrapping path above (resulting in a client-visible error response, not a transport-level failure).

### `search` tool behavior

1. The handler rejects an empty or whitespace-only query string with an error whose message reads "`query` is required and must be non-empty".
2. The active storage handle (set at startup) is fetched. The search index is opened through a per-server cache keyed by the resolved index directory, with the storage handle threaded so the index directory resolves to the same location the index was written to (in folder-mode or dual-write configurations this is under the memory-bank kb-root, not the checkout). On a cache hit the cached index instance is reused; on a cache miss the index is restored from disk (or rebuilt) and inserted into the cache. A source-signature check on every call detects staleness so a stale cache entry is transparently reopened.
3. The query, optional branch, optional type, and optional limit are forwarded to the search engine. The hits array returned by the engine is wrapped into the response object as `{ hits: <array> }` with no additional projection.

### `recall` tool behavior

1. If no branch argument is supplied, the current branch of the bound working directory is resolved and used in its place.
2. The branch (explicit or resolved) is passed to the context-compilation pipeline along with the bound working directory.
3. The compiled context is projected into the structured recall payload (the same projection used by `jolli recall --format json`) and returned as the tool response.

### `get_decision_timeline` tool behavior

1. The handler rejects an empty or whitespace-only slug with an error whose message reads "`slug` is required".
2. The topic page for the given slug is loaded from the topic-page store under the bound working directory. If no page exists, the handler throws an error of the form "Topic not found: <slug>" (which the wrapper then surfaces as a structured error response — see Request dispatch).
3. The page's source-reference list is sorted via the canonical chronological comparator (which parses each timestamp to an epoch instant and uses source-type and source-id as deterministic tie-breakers). This is intentionally not a string-wise compare: timestamps with different timezone suffixes (e.g. `…+09:00` versus `…Z`) sort by instant, not lexically. A string compare would order them by suffix and produce the wrong order for the same instant.
4. The sorted list is projected to timeline entries: each entry carries the timestamp string verbatim, the branch label (or the empty string when the underlying reference omits a branch), the source-type discriminator, and the source-id. The response wraps these into `{ slug, title, timeline }` where slug echoes the requested slug and title is the topic-page title.

### `list_branches` tool behavior

The handler returns the branch catalog for the bound working directory verbatim — no filtering, no projection, no query argument. The result is a branch-catalog object as defined in the data contracts.

### `get_pr_description` tool behavior

1. The optional base-branch and include-markers arguments are forwarded to the PR-description builder along with the bound working directory. Both are optional; when absent, the builder applies its own defaults (the repository's default branch for the base, markers-on for the wrapping).
2. The builder always describes the **current** branch — the commit range is from the resolved base to the branch head; there is no argument to describe a branch other than the current one.
3. The builder's result (a kind discriminator, the described and base branch labels, a title, a body, and the three counts) is returned as the tool response. The handler performs no projection of its own.

### `queue_status` tool behavior

1. When the `wait` argument is truthy, the handler runs the bounded wait, forwarding the (optional) `timeoutMs` straight through — including a non-numeric value, which the wait's own input-hardening choke point coerces to its default (see spec 218). The result is the status object plus the waited-milliseconds field.
2. Otherwise the handler takes a one-shot status read and returns the status object (no waited field).
3. The handler performs no projection of its own; the verdict semantics are owned by spec 218.

### `status` tool behavior

1. The tool takes no arguments; any arguments a client sends are ignored.
2. The handler collects the installation status for the bound working directory and the current configuration, then curates them into the result shape above. The hook summary, the hook runtime string, the data-migration descriptor, and every per-integration row are built with the **same** helpers `jolli status` uses, so the two surfaces cannot drift in wording or in the merged-row masking rule.
3. Undetected integrations are dropped, not reported with a false flag. For each surviving integration the handler additionally collects the per-channel scan errors and attaches the list only when it is non-empty.
4. Whether the Claude agent hook counts as active is decided solely by the settings-file probe, on every surface. The Claude Code plugin installs the canonical agent hooks into that same settings file rather than registering its own, so no plugin-specific special case exists.

### `list_spaces` tool behavior

The handler returns the tenant's bindable Jolli Spaces plus the configured default-space id verbatim. No projection; behavior (the backend call) is owned by the CLI space-push specs (230/231).

### `bind_space` tool behavior

1. The handler rejects an empty or whitespace-only `space` argument with an error whose message reads "`space` is required" (thrown-error path).
2. Otherwise it resolves the target space and registers the binding for the current working directory's repo, returning a `bound` result. An already-existing binding is caught and returned as an `already_bound` result rather than thrown — it is not an error. Behavior is owned by the CLI space-push specs (230/231).

### `push_memory` tool behavior

The handler pushes the current branch's commit summaries (over the base..HEAD range, base defaulting to the repository's default branch) to the bound Jolli Space, optionally binding to a space named in the `space` argument first. On an unbound repo it returns a structured `binding_required` result carrying the available spaces (a normal "needs input" result, not an error). A failure reported as a structured `{ type: "error" }` result is flagged an error by the result-shape path (see the tool-result envelope). Behavior is owned by the CLI space-push specs (230/231).

### Platform-tool registration and dispatch (when enabled)

1. After storage initialization and before the transport connects, the server reads the activation gate. If it is closed (an explicit opt-out — the config flag set to `false` with the env override unset), the server skips everything below — no client is constructed and no manifest is fetched.
2. If open, the server fetches the manifest once, drops entries whose name collides with a built-in (built-in wins, with a warning) and drops malformed entries, and builds the advertised tool list as the built-in registry followed by the surviving platform tools. The built-in registry array is never mutated; when no platform tools survive, the built-in array is advertised as-is.
3. The list-tools handler returns this combined list. The call-tool handler routes a name belonging to a platform tool to the generic executor and every other name to the built-in dispatch switch, then wraps the outcome through the identical envelope/error logic used for the built-ins.

### Concurrency

The server does not serialize requests itself; the transport may deliver call-tool requests concurrently and each handler runs as its own asynchronous task. Two notable shared resources guard themselves:

- The active-storage slot is process-global; it is written once at startup and only read by handlers thereafter, so concurrent calls observe the same storage handle.
- The per-server search-index cache is a process-wide map keyed by the resolved index directory; concurrent `search` calls on the same directory may race to populate the same entry, but the recompute is idempotent and the source-signature check detects staleness on every call, so a concurrent loser's work is harmless overwrite.

### Authentication and authorization

The server performs no authentication on its caller. The transport is a local pipe (standard input/standard output of the spawned process) and the client is whoever launched it. Tool responses include whatever data the bound working directory's memory contains; there is no per-tool capability gating.

### Shutdown

There is no explicit shutdown handler. The startup function's awaited connect-promise resolves when the transport closes (i.e. when the connected client closes its side of the standard-input/standard-output pipe, or when the controlling process exits). The active storage handle and the per-server index cache are released only by process termination.

## State Transitions

The server has three observable lifecycle states:

1. **Pre-init** — process started, action entered. Reindex-mode and long-lived-mode share this state.
2. **Storage-bound** — the configured storage backend has been constructed for the working-directory binding and installed as the process-wide active storage. Reindex-mode performs its rebuild and confirmation print, then exits. Long-lived mode proceeds to connect the transport. **This transition is skipped entirely** when the local-agent child guard fires: the process logs and returns before storage is ever bound, so it never reaches Storage-bound.
3. **Connected (long-lived only)** — list-tools and call-tool handlers are registered and the transport is open. The server stays in this state until the transport closes, at which point the startup-function promise resolves and the action returns. There is no intermediate degraded state — a call-tool handler crash never tears down the server; it only produces a client-visible error response.

## Notable Behavior

- **Storage-backend setup is the first memory-touching thing both modes do, deliberately.** (In long-lived mode exactly one step precedes it — anchoring the diagnostic-log directory, which touches no memory state.) Without it, store reads inside the tool handlers would silently fall through to the orphan-branch fallback. For users running in folder-mode or dual-write mode this would return wrong data and would emit a warning on every store read — once per call in an otherwise long-lived process. The same trap motivates threading the storage handle through the search-index open and rebuild calls (so the index directory resolves under the memory-bank kb-root, not the checkout).
- **The chronological comparator on `get_decision_timeline` is not a string compare.** Timestamps with different timezone suffixes are parsed to epoch instants before comparison; otherwise `…+09:00` and `…Z` for the same instant would order by suffix. Source-type and source-id act as deterministic tie-breakers when timestamps collide.
- **A missing branch on a source reference becomes the empty string in the timeline projection**, not omitted, not the sentinel "unknown" — this is the only field whose absent state is normalized this way.
- **An unknown tool name produces an error tool response, not a protocol error.** The wrapper catches the dispatch-time throw and shapes it into the standard `{ "error": "Unknown tool: <name>" }` text-content payload with the error flag set, so a client mistyping a tool name sees the same error envelope as a tool-handler failure.

- **A normally-returned result can still be an error response.** Beyond the thrown-error path, the wrapper marks a returned result as an error response when it is a non-null object whose `type` is exactly `"error"`. This unifies the contract for tools (like `push_memory`) that report failure as a structured result instead of throwing, so a client can treat both the same way. A `binding_required` result is deliberately exempt — it is a "needs input" outcome, not an error — as are the `bound` / `already_bound` results and `push_disabled`, which reports the user's own opt-out (spec 310) and would be actively misleading as an error, since retrying it can never succeed until the user changes the setting.

- **`status` tells a caller why its push was refused, but only when it was.** The push-disabled flag is emitted only in the `true` state, and its reason string only when the OFF verdict came from an unreadable push-control store rather than from the user's own setting. Both halves travel together or not at all, because a bare boolean would read as "you turned this repo off" for a machine-wide read failure the user never chose. This is the channel that lets an AI host whose push tool returned the refusal outcome explain it, since that refusal is deliberately not an error. (Notable.)
- **`status` carries no secrets and never decodes the API key.** Credential state is exposed as presence booleans plus the persisted site host; the key itself is never parsed for the site, so the tool cannot leak decoded key material into a client transcript or a log. (Notable.)
- **A single-channel failure inside a merged integration is invisible in the flat descriptor and travels separately.** Because a merged integration reads `unavailable` only when *both* of its channels fail (so a healthy channel's session count survives), the per-channel scan-error list is the only place an MCP caller can see that one channel is broken. A caller that reads only the descriptor will correctly see a healthy integration — and should read the scan-error list to learn that half of it is not reporting. (Surprising; intentional.)
- **The per-integration entry has no numeric session count.** The count exists only inside the descriptor string, with its unit attached. A caller that wants a number has to parse it out — deliberately, because a parallel raw number previously let renderers disagree about whether to print a unit. (Surprising; intentional.)
- **`bind_space` treats an already-existing binding as success.** A "binding already exists" backend failure is caught and returned as an `already_bound` result (not an error), so re-binding is idempotent from the client's view.
- **A non-Error throw is preserved as a string.** Handlers that reject with a bare string or object (rather than constructing an Error) still produce an error response — the wrapper coerces the value via string-conversion before wrapping. This is a deliberate fallback to ensure no thrown value is lost in serialization.
- **A missing arguments field is tolerated.** A call-tool request whose `arguments` field is absent is treated as if the field were an empty object, so tools that take no arguments (`list_branches`) can be called without any arguments key at all.
- **The bound working directory is fixed at startup, and it is a repository root, not the launch directory.** The one resolution happens in the command action, before the mode branch, and is reused for storage, for the kb-root, and for the diagnostic-log directory. A host that spawns the server from a subdirectory therefore gets the repo's own state rather than a second one rooted at the subdirectory — which for a long-lived, per-tool-call-logging process is the difference between one state directory and one per launch directory. The server has no mechanism to switch to a different repository while running; a client that wants to query a different repo's memory must launch a new server process from inside that repo. (Resolution rule: spec 311.)
- **The advertised description strings are part of the contract.** LLM clients select tools based on these strings; changing them changes which tool an LLM picks for ambiguous queries. The description for `recall` in particular explicitly contrasts the tool's data source ("raw commit summaries — the same data the jolli-recall skill uses") with the topic KB that the `search` tool covers, because the two are easy to confuse.
- **The reindex-mode confirmation line uses the pluralizable noun "document(s)" verbatim** regardless of count — there is no singular/plural agreement. The count is the rebuild's reported document count.
- **The server name is the literal string "jollimemory"** (the product name, not the npm package scope or the GitHub org name). The version is sourced from the host package's version constant — not a hardcoded literal.
- **The `search` tool's description advertises a default limit of 20**, but the actual default is whatever the underlying search engine treats as unset (the surface forwards the limit unchanged, including `undefined`). The "20" in the description is documentation of the engine's default, not a value injected at the tool surface.
- **Platform tools are on by default and fail safe.** With the activation gate closed (an explicit opt-out) the server is built-in-only and never contacts the backend. With it open, a disabled/older/unreachable backend yields an empty manifest and the server still advertises exactly the built-in tools — the manifest fetch never throws. The static built-in registry is never mutated; platform tools are appended to a locally-built list. A manifest tool that collides with a built-in name is dropped so the built-in always wins, and a manifest tool whose name duplicates an earlier platform tool is dropped so the advertised list and the dispatch map agree (first entry per name wins). Manifest entries are validated/normalized to the MCP tool-input-schema contract: `type` must be `"object"`; `properties` is optional and defaulted to `{}` (a valid zero-arg tool is kept, not dropped); `required`, when present, must be an array of strings; other schema keywords are preserved. An entry with a malformed *advertised-schema* field is dropped individually so one bad tool neither poisons the advertised `tools/list` nor removes a valid neighbor. The internal `binding` and `menu` metadata are the exception — because they are never advertised, a malformed one degrades at field granularity (bad `binding` ⇒ discarded, the call falls back to the conventional endpoint; bad `menu` ⇒ no menu item) rather than dropping the tool. Each surviving platform tool is advertised as only its public schema; `binding`/`menu` are projected off the advertised entry and retained only for dispatch/menu-building.
- **The server is inert inside a product-spawned local agent, and it is the only
  entry point that consults the working-directory channel.** It shares the
  re-entrancy predicate with the session-start hook, the stop hook, the
  agent-plugin bootstrap, and the enable command, but those are spawned by the
  product's own child and therefore rely on the inherited environment marker
  alone. This server additionally consults the marker file in the bound working
  directory, because it is spawned by the *host* and the host's environment policy
  can strip the marker. So a host that sanitizes the environment still gets an
  inert server here, while the other entry points would not be protected in that
  same situation. (Notable; the channel rationale is spec 280's.)
- **The guard is not justified by tool denial.** The nested agent is denied all
  tools only under the Claude Code local-agent backend; the others run with a
  read-only sandbox (Codex) or with no tool restriction expressed at all. The
  guard's actual justification is the spurious per-call Memory Bank folder, not an
  assumption that the child could never call a tool. (Notable; a narrower earlier
  justification was wrong for every backend but Claude Code.)
- **The `/jolli` menu prompt is presence-gated by the menu, not just the flag.** The prompts capability and the single `jolli` prompt exist only when the curated menu is non-empty (at least one menu-flagged platform tool or one resolvable local-list tool); an empty menu — the default, and the outcome for a CLI running against a backend that does not yet emit `menu` metadata — leaves the server byte-identical to a tools-only server. A malformed `menu` block never drops its tool: it is discarded at field granularity (no `label` ⇒ no menu item; bad `description`/`order` ⇒ only that field dropped). The prompt only steers the agent to an already-advertised tool; it introduces no new tool, name, or execution path.

## Shared Behavior

- The full-text search pipeline used by the `search` tool — its dispatch, ranking, result envelope, and the local on-disk index format — is owned by the single-phase search pipeline spec.
- The PR-description builder used by the `get_pr_description` tool — its commit-range derivation, summary aggregation, body composition, and missing-summary footnoting — is owned by the PR-description spec.
- The development-context compilation used by the `recall` tool — branch resolution, period derivation, plan and note aggregation, token-budget enforcement and truncation, and user-knowledge inclusion — is owned by the development-context-recall spec.
- The branch catalog returned by `list_branches` and its topic-titles aggregation are owned by the summary-catalog-file spec.
- The topic page loaded by `get_decision_timeline` and the canonical chronological comparator applied to its source references are owned by the topic-page-storage and summary-tree-structure specs.
- The on-disk skill markdown templates that LLM clients may load alongside these tools (advertising their existence and usage) are owned by the recall-skill and search-skill content specs; the MCP server itself does not serve those templates.
- The `queue_status` tool's verdict computation and its bounded-wait semantics (the status fields, the "drained" rule, the wiki/graph ingest exclusion, the poll/timeout/non-overshoot loop and its input hardening) are owned by the **queue-status computation** spec (218). This tool only crosses the accepted-argument and status-plus-waited response shapes.
- The `list_spaces`, `bind_space`, and `push_memory` tools' backend calls (listing spaces, registering a binding, pushing branch summaries, and the binding-required outcome) are owned by the **CLI space-push** specs (230/231); the underlying push mechanism and binding-required flow are further owned by specs 94 and 95. This spec only crosses the accepted-argument and result-union shapes at the tool boundary, including that `bind_space`'s already-bound and `push_memory`'s binding-required and push-disabled results are non-error outcomes. The per-repo outbound-push opt-out that produces `push_disabled` — its store, its gate, and its control surfaces — is owned by spec 310.
- The `status` tool's report mirrors the **CLI status command** spec (58): the hook summary, the data-migration descriptor, the per-integration state strings, and the merged dual-variant masking rule are built by shared helpers, so 58 is the authority on their wording and on the aggregation truth table. The VS Code sidebar status tree (295) renders the same row set with the same rule.
- The two re-entrancy markers the startup guard keys off — the inherited environment marker and the marker file planted in the agent's throwaway working directory — together with the reason two independent channels are needed and the full list of entry points that detect them, are owned by the local-agent CLI provider backend spec (280). This server is one consumer of that contract, and the only one that opts into the working-directory channel.
- The rule that turns the launch directory into the bound working directory — the git-repository-root resolution, its fallback, its caching, and the set of entry points that apply it — is owned by the **project-state-root-resolution** spec (311). This server is one consumer; it applies the rule once and then treats the result as opaque.
- The per-client configuration files that point a client at this server (so the client knows to spawn the entry-point command) are owned by the MCP-client-registration spec.
