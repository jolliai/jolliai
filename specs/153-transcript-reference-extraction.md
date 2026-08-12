# 153. Transcript Reference Extraction

## Topic Statement

Scan an AI agent's conversation transcript for mentions of referenceable entities — issues, wiki and document pages, chat threads, meeting assets, board items, deployments, documentation lookups, and Jolli Memory's own lookups (every registered source is an external system except the last, which records a consultation of Jolli's own memory; spec 154 owns the catalog) — through a source-agnostic shared pipeline that delegates one concern (recognising "a tool call and its returned payload" in this agent's transcript format) to a per-producer envelope parser, then deduplicates and persists each discovered entity as a reference attached to the project's reference registry. Source recognition (which tool call belongs to which source) is resolved by matching the tool identity against the declarative match rules carried by each source definition, not by a hand-written per-producer recognition table.

## Scope

**In scope:**

- The shared extraction pipeline that is identical across every supported producer (Claude, Codex, future agents).
- The per-producer envelope-parser contract: what one parser exposes to the shared pipeline.
- The recognition model: source recognition (which producer-side tool talks to which external source) is resolved by a registry `match` over the declarative match rules on each source definition (per producer agent, tool name, and optional namespace); a per-producer "binding" retains only the residual transform work the declarative definition cannot express (payload reshaping, malformed-output recovery, the synthetic canonical tool name) plus the cheap substring pre-filter constants.
- The envelope variants currently supported, enumerated: Claude's `tool_use`/`tool_result` block pairing; Codex's `function_call`/`function_call_output`/`mcp_tool_call_end` triple; the wire-event correlation variant (a call event and a result event carrying a shared call id, used by the Kimi Code CLI producer); and a shared shell-CLI fallback that the first two — and **only** the first two — can route to.
- The shared MCP business-payload normalizer that two of those parsers call once a payload is decoded, its closed membership, its identity default, and the asymmetry in *when* each parser calls it.
- The shape of an extracted reference and how it is stored, deduped, upserted, and removed.
- The shared cursor mechanism that lets each transcript be re-scanned cheaply on every trigger without re-emitting refs already seen.
- How the trigger differs by producer (commit-time vs polling-tick) and what consequences that has for the parser.
- Failure handling: malformed lines, malformed payloads, in-flight requests whose result row hasn't been written yet, partial salvage when one of two redundant copies of a payload is corrupt.

**Out of scope (boundaries):**

- How the producer-side conversation transcript is laid out on disk, opened, and read line-by-line. The extractor consumes a path; the act of reading the file as JSONL is shared infrastructure (see transcript reader specs, spec 16 and siblings).
- The per-source payload interpretation — how to recognise a Linear-issue payload vs a Jira-issue payload, what fields each source emits, how each source renders itself into the prompt the LLM later sees. That is the **source-definition** concern: the DSL and engine are spec 255; the built-in catalog is spec 154.
- The session registry that records "this transcript exists at this path for this commit" (see spec 26 for the Claude path; the Codex equivalent, and the two triggers that drive it, live elsewhere).
- The mechanism that drives the polling tick on the sidebar (see sidebar specs 100–117).
- The orphan-branch summary that an extracted reference is eventually snapshotted into — references live in a local registry until the commit they relate to lands.
- The UI surface that displays references (sidebar panel, detail panel, open-in-browser action).
- Authentication, rate-limiting, or network calls to the external sources themselves. Extraction is a pure read of what the agent already received.

## Data Contracts

### Reference shape (in-memory)

One discovered entity, ready to persist:

| Field           | Type                | Notes                                                                                       |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `mapKey`        | string              | `<source>:<nativeId>`. The registry key. Stable across re-extractions of the same entity.   |
| `source`        | source-id string    | A source id. The registered built-ins are catalogued by spec 154; this pipeline never enumerates them. |
| `nativeId`      | string              | Identifier native to that source (issue id, page id, `<owner>/<repo>#<number>`, …).         |
| `title`         | string              | Human-readable.                                                                             |
| `url`           | string (optional)   | Canonical external URL when present; re-validated at any "open in browser" sink. A required `url` field-spec voids the reference when the payload lacks one — Slack does exactly this. The record shape models `url` as optional, and one built-in now exercises that: `jollimemory` declares **no url field-spec at all**, because the lookup it records has no external destination. That is deliberately distinct from a url spec that fails to resolve — see spec 256, which scopes the two cases. |
| `description`   | string (optional)   | Markdown body; the human-browsable description.                                             |
| `fields`        | list (optional)     | Source-specific display attributes: `{key, label, value, icon?}`. Opaque to this pipeline.  |
| `toolName`      | string              | Stable tool name persisted as `sourceToolName`; see "Canonical tool name" below.            |
| `referencedAt`  | string (ISO 8601)   | Timestamp of the result line that produced this reference; empty string when none present.  |

### Source-id model

A source id is a plain **string**, not a closed enum. The built-in definitions registered today are catalogued by spec 154, which owns that inventory. The id space is open so a future config-registered source can be added without touching a central union (spec 255's registry seam). Identity resolution and path guards therefore ask the registry "is this id registered?" rather than testing membership in a fixed set (spec 179 documents the lenient-read vs strict-path-guard split).

### Producer-id enumeration

A closed enum of every known transcript producer. Three of its members have an envelope parser wired for reference extraction — Claude, Codex, and Kimi Code CLI; every other member (Gemini, Cursor and its CLI, both Copilot surfaces, OpenCode, both Cline surfaces, Devin, Antigravity) has none, and falls through to the Claude parser, whose substring pre-filter trivially produces no results on a transcript of another shape. An unwired producer therefore yields "no references" rather than crashing the extractor.

### Per-producer envelope-parser contract

A producer's envelope parser is the only source-specific code in the pipeline. It exposes one operation:

> Given an array of transcript lines, a starting line index, an optional cutoff timestamp, and an optional configured Slack workspace URL, return:
>
> 1. an ordered list of **normalised tool results**, each carrying:
>    - the source definition the registry `match` resolved this tool call to (spec 255 defines the definition; spec 154 catalogs the built-ins),
>    - the canonical tool name to persist with the reference,
>    - the already-JSON-parsed payload object (envelope stripped),
>    - the 1-based line number where the result was found,
>    - the result's timestamp (empty string when absent);
> 2. the 1-based index of the last line the parser **traversed** (not just the last that produced a result) — used as the next-scan starting line.

Required parser behaviour:

- Traverse lines in transcript order; emit results in transcript order.
- Drop results whose timestamp is past the optional cutoff.
- On any unparseable line, log and continue — never abort the scan.
- Honour the in-flight rule (below) when computing the returned "last traversed" line.
- Honour the **arguments-derived allowance** (below) when the result payload cannot be parsed.

### Arguments-derived allowance (every wired producer)

The ordinary rule is that a result payload which fails to parse as JSON is logged and dropped. A source definition may declare itself **arguments-derived** (spec 255), meaning its reference is built entirely from the tool call's *arguments* and its returned payload is never read at all. For such a definition the parser must instead supply an **empty payload object** to the source's normaliser and continue, since the normaliser needs nothing from the payload.

- Every wired producer implements this as exactly one guarded branch per pairing loop, gated on the flag being exactly `true`; every other definition keeps the warn-and-drop behaviour byte-for-byte.
- On the Claude side the branch sits inside the payload-parse failure handler and runs only **after** oversized-tool-result offload recovery has declined (below), so a genuinely offloaded payload is still recovered in preference to being replaced with an empty object.
- On the Codex side both the primary and the fallback pairing loops carry the branch independently.
- On the wire-event side the branch sits in the single result-handling path; either way the pending call has been answered, so it is removed and the cursor is free to advance past it.
- Four built-ins declare the flag today (Context7, Jolli Memory, Figma and Sentry — spec 154). It is also the reason a Context7 call whose documentation response is unparseable still produces a reference, and why a `recall` whose result was too large to keep inline still produces one.

#### Raw-result-text hand-off (Claude only)

An arguments-derived source's result is the one text this pipeline would otherwise discard entirely, and for one source it carries facts worth displaying: Sentry answers with markdown prose naming the issue's short id, project and culprit (spec 154). The Claude parser therefore passes the **unparsed result text** to the context-normaliser alongside the empty payload.

- **Supplied only when the resolved definition is arguments-derived.** For every other source that text is the JSON already in the parsed payload, and handing it over would invite a normaliser to regex what it should be reading structurally. The gate is what keeps the field meaning exactly one thing.
- **Optional and display-only, by contract.** A producer that has not wired it omits it — the Kimi parser does, and the Codex parser has no equivalent — and the reference is still complete either way, because identity, dedupe and the url come from the arguments alone. Only a display value degrades (Sentry's title falls back to `Issue <id>`). **Nothing that decides identity may read it**: a best-effort parse that succeeds only sometimes would split one entity across two native ids.
- **It is the raw transcript text, not a recovered payload.** When offload recovery declines because the offloaded file is prose rather than JSON, the text handed over is the *pointer* sentence the transcript holds, so an oversized prose result harvests nothing and the display value takes its documented fallback. No wrong value is ever produced by this path.

### Normalised tool result

The handshake between a producer envelope parser and the shared pipeline. Fields above. The parser's job is to bridge "this producer's wire format" → "one flat call-and-payload pair". The pipeline does not see anything else about the transcript. For an arguments-derived source the "payload" it carries may be an empty object supplied by the allowance above rather than anything read off the wire.

### Canonical tool name

A stable string persisted on the reference so the LLM later sees a producer-neutral marker. Two policies:

- **Pass-through (Claude MCP path)**: the producer-side tool name is already vendor-specific and stable; persist it verbatim.
- **Synthetic (Codex MCP path, all CLI paths)**: the connector's own tool name is mapped through the producer's binding to a stable synthetic name shared across producers (e.g. a `gh` CLI invocation discovered through either Claude's `Bash` tool or Codex's `shell_command` resolves to the same canonical name).

  The synthetic name is normally a fixed string per binding, but a binding whose source matches **several** tools of one server may instead declare a **per-call resolver** that maps the raw tool name the envelope carried. The purpose is host-independence, which is the whole point of the field: one producer reports the tools by their bare names while the other reports them namespaced, so the resolver maps the bare name back onto the other producer's namespaced spelling and the same lookup persists the same string whichever agent captured it. A single fixed string could not do that — it would collapse several distinct tools to one value on one producer while the other kept them distinct. Every read of the field goes through one resolution helper, so the two forms are invisible to the parser's call sites.

### Identity resolution (registry match)

Recognition — "which source does this tool call belong to?" — is answered by a single registry `match` over the declarative match rules each source definition carries (spec 255). The match takes a producer agent, a tool name, and an optional namespace, and returns the first matching source definition (built-ins are consulted in fixed registration order — spec 154), or nothing:

- **Claude (MCP-by-prefix, with optional exact and suffix gates):** the first definition whose Claude prefix list has a prefix the tool name starts with, subject to three optional per-definition gates evaluated in this order:
  - an **exact tool-name allow-list**: if declared, the tool name must **equal** one of its entries, else it is not a match. This gate is evaluated **before** both suffix gates, because it is strictly stronger — a name outside the allow-list cannot be rescued by any suffix outcome, so no suffix rule needs to run.

    It exists because prefix matching is a *starts-with* test, and a namespace that hosts several wanted tools **and** an unwanted tool whose name *extends* a wanted one cannot be expressed with prefixes and suffixes at all: a prefix ending at the wanted tool's name also captures the longer sibling, and no single accept-suffix covers several differently-named wanted tools. A deny-suffix list could enumerate today's unwanted siblings, but a deny-list silently begins mis-capturing the day a new sibling ships; an allow-list cannot drift that way. Only a source that does not own its whole namespace declares this gate; every source that does own its whole namespace omits it.
  - an **accept-suffix**: if declared, the tool name must also end with it, else it is not a match. The accept-suffix generalises the old "tool-level business scope" gate: it scopes the Notion connector to its single-page-fetch tool (a prefix match with the wrong suffix is not a match at all), the Slack connector to its read-thread tool, the Confluence connector to its page-fetch tool, the two Zoom sources (which share one prefix) to their respective meeting-assets / doc-content tools, and the Asana connector to its get-task tool.
  - a **deny-suffix list**: if declared, a tool name ending with any listed suffix is **rejected** even after a prefix (and exact / accept-suffix) match. This excludes enumeration tools — e.g. Linear's issue list/search tools — whose result arrays would otherwise bulk-capture one reference per element and flood the LLM's context. Only Linear declares deny suffixes today.

  A definition with neither suffix gate accepts any tool under its prefix (e.g. Jira and GitHub accept every tool, and the payload shape gate decides whether a reference results). **Registration order is correctness-sensitive at the Claude layer, not merely preserved:** Confluence and Jira share the same Atlassian tool prefix and Jira's rule is a prefix-only catch-all, so the first array hit wins — Confluence's narrower accept-suffix definition must be registered *before* Jira or every Confluence page fetch would resolve to Jira and void (spec 154 owns the built-in order).
- **Codex with a namespace (function-call path):** the first definition whose Codex namespace-suffix equals the namespace AND whose function-call-name list includes the tool name (so a short name shared across sources — e.g. a generic `_fetch` — is disambiguated by namespace).
- **Codex without a namespace (invocation-tool path):** the first definition whose Codex invocation-tool list includes the tool name, subject to one optional per-definition gate:
  - a **server pin**: if declared, the MCP server the producer's result event reported must **equal** it, else it is not a match. The lookup takes the reported server as an extra input, read **only** on this path (the namespaced path ignores it entirely).

    It is needed the moment a definition registers **bare**, un-namespaced tool names: this lookup is one flat scan across every registered definition with no other qualifier, so a generic bare name would otherwise match any locally-registered server's identically-named tool and persist a foreign lookup under this source. Every connector-app source instead registers server-qualified entries, which are self-scoping, so those declare no pin.

    Two properties are load-bearing. The pin can only ever **reject**, never widen: a definition that demands a server never matches a lookup carrying none, and a definition without a pin behaves exactly as before. And it **fails closed** — an event reporting no server matches no pinned definition at all, on the judgement that mis-attributing a foreign server's identically-named tool is worse than missing a capture.

### Producer binding (residual, per producer)

After the registry resolves the source, a small per-producer binding supplies only what the declarative definition cannot express:

1. How to reshape the connector's raw payload before the engine reads it — identity for direct vendor-MCP payloads; a normaliser that handles "single entity vs collection-of-entities" for search/list payloads (Codex path). A binding may also read the tool call's parsed request arguments to gate its output (monday's `itemIds` fetch-vs-browse gate) and may read a parse-scoped context object built once per scan (the pasted-permalink map plus the configured workspace url), used only by Slack.
2. The synthetic canonical tool name to persist (Codex MCP + all CLI paths).
3. An optional malformed-output recovery hook (Codex only; see Salvage path).

The Claude MCP binding is thinner still — its payloads are already the canonical shape, so the reshape is identity and the tool name is passed through verbatim. The Claude binding module now carries only the two substring pre-filter constants (the MCP prefixes, derived from the registry, and the shell tool names). Tool-level scoping (Notion single-page-fetch, Slack read-thread) is no longer a binding concern — it is the accept-suffix in the definition's match rule.

The CLI-by-command binding is producer-neutral: it matches a shell command string. Both Claude (`Bash`) and Codex (`shell_command`) extract the command from their respective envelopes and consult the same CLI binding registry, so adding one CLI fallback covers both producers. The resolved CLI binding names a source id, which is looked up in the registry to obtain the source definition.

### Source definition (payload interpretation)

Per-source **data** (not code) that the shared engine (spec 255) evaluates to turn one already-normalised payload object into either a reference or nothing. A definition:

- describes the payload shape for its source as declarative extraction pipes,
- describes the canonical URL constraint,
- declares which "wrapper" keys (e.g. `items`, `issues`, `nodes`) the shared payload walker should descend into when the payload itself isn't a leaf entity,
- never sees the producer-side tool name and never reasons about which producer surfaced the payload.

The definition catalog belongs to spec 154 and the evaluation engine to spec 255; for the extractor a definition is a black box the engine evaluates.

### Discovery cursor (shared with plan discovery)

The pipeline does not own the cursor — the caller does. The cursor records, per transcript path: "we have scanned through line N; resume from there." The same cursor row is shared with the markdown-plan discovery scan that walks the same transcripts; one merged advance per pass.

### Reference registry row

Persisted in the per-project `plans.json` (the same file that holds plan and note rows). One row per discovered reference:

- `source`, `nativeId`, `title`, `url`,
- `sourcePath`: absolute path to the per-reference markdown file on disk,
- `addedAt`, `updatedAt`,
- `sourceToolName`: the canonical tool name from the discovery.

There is **no branch field on the row.** Working-area context — references, plans, notes — is worktree-scoped rather than branch-scoped: it follows the worktree across branch switches and is associated with a branch only at commit time, where the branch is recorded on the commit summary instead. A `branch` key persisted by an older writer is not merely ignored but **actively purged** from the row on every registry load, so it never survives a load→save cycle.

Keyed by `<source>:<nativeId>`. Rows live until the commit they relate to lands, at which point they are removed from this registry (a value-snapshot is taken into the commit summary by a downstream layer).

### Per-reference markdown file

`<jolliMemoryDir>/references/<source>/<sanitised-key>.md`. YAML-style frontmatter with JSON-encoded scalars (`source`, `nativeId`, `title`, `url`, `referencedAt`, `sourceToolName`) plus an opaque `fields:` list (`{key, label, value, icon?}` objects), followed by the markdown body (the `description`). The frontmatter is the machine-parseable face; the body is for human browsing.

### File-stem sanitisation per source

Driven by each source definition's declared path-safety flag (spec 255's `storage.nativeIdPathSafe`), resolved through the registry (full contract in spec 179):

- Path-safe sources (every built-in except `github` **and** `context7`): identity — their native ids are filesystem-safe and globally unique within the source. (Identity is load-bearing for the archive-form round-trip used by spec 154.) A defence-in-depth guard rejects any incoming id containing `..`, `/`, or `\` so a malformed registry can never escape the per-source directory.
- `github` and `context7` (not path-safe): **two** built-ins now take the hashed branch. GitHub's ids are `<owner>/<repo>#<n>` — both `/` and `#` are unsafe and the bare number can collide across repos. Context7's ids are library ids that begin with `/` and contain at least one more `/`. For either, replace non-`[\w.-]` bytes with `-` and append an 8-hex `sha256(nativeId)` suffix so distinct ids never collide on disk. The identity branch's traversal guard does not apply to them, since the hashed form is safe for any input.
- An id **not registered** in the registry is treated conservatively as not-path-safe (the hash-suffix form), since its native-id shape is unknown.

## Behavior

### Extraction pipeline (shared)

For one transcript path (the source definitions are resolved internally via the registry, not passed in):

1. Read the transcript file at the supplied path as UTF-8. On any read error, log at debug and return zero references with a "scanned 0 lines" cursor — a missing transcript is not an error worth surfacing.
2. Split on `\n`; drop the trailing empty element a final newline produces.
3. Resolve the per-producer envelope parser by the requested producer id; default to the Claude parser when none is given. An unknown producer id falls back to the Claude parser, whose substring pre-filter trivially produces no results on a non-Claude transcript — preserving the pre-source-agnostic behaviour of returning zero references.
4. Read the user's configured Slack workspace URL once (a single best-effort async config read here, since the parser is synchronous); tolerate a failure by leaving it undefined. Thread it, the cutoff, and the from-line into the parser (a caller-supplied workspace URL overrides the config read). Receive back the normalised tool results and the "last line traversed" cursor target. Each result already carries its resolved source definition (the parser called the registry `match` internally).
5. For each normalised tool result, walk its payload tree against the resolved source definition (evaluated by the shared engine, spec 255):
   - evaluate the definition against the current object;
   - if it yields a reference, push it and stop descending into this subtree. For an **accumulate-body** definition (spec 255) the reference is first passed through the body **lift** below;
   - otherwise descend into each of the definition's declared wrapper keys, recursing into arrays element-by-element and into single objects directly.

   **Body lift (accumulate-body sources only).** The record's body is rewritten into a single **timestamped entry line** at this point, and only here. This is the one place where both the body text and the call's timestamp are in hand: the timestamp lives on the reference record and never appears anywhere in the tool payload, so no declarative pipe can produce that line. Lifting here rather than at either later merge point is what lets both merge points treat their two inputs as the same shape — every accumulating record downstream (deduped, stored, rendered, parsed back) already carries the entry-line form, so neither has to work out whether it was handed a raw body or an already-merged list.

   Two consequences follow from the entry format (owned by spec 179):
   - Internal whitespace in the body is **collapsed**, because an entry must occupy exactly one line — a pasted multi-line body would otherwise break both the rendered format and the parse back.
   - A body that is absent, or whitespace only, records **nothing**: the record's description is *cleared* rather than passed through, since there is no act to record and both merge points would discard it a step later anyway.
6. Wrap each per-result walk in a try/catch. A pathologically deep payload that would otherwise blow the stack (RangeError) is contained to one dropped result, logged with the offending line number and tool name, and the rest of the transcript still extracts.
7. Deduplicate the collected references by `mapKey`, keeping the entry with the latest `referencedAt`; on a tie the later-seen entry wins (which is why the parser must emit in transcript order and the pipeline must not reorder).

   **Accumulate-body exception.** For a definition declaring that flag (spec 255), two records sharing a `mapKey` are **merged** rather than one discarded: their bodies are combined by the shared merge rule (spec 179). This is because such a source's identity is an act, not an entity — two recorded acts under one key are two distinct facts, and keeping only the newer would discard the record. Everything *except* the body still follows latest-wins: the title, the link, and the tool name all describe whichever of the two calls is newer — subject only to the title-fallback exception below.

   **Title-fallback exception.** For a definition declaring a title-fallback pattern (spec 255), the winning record's **title, url, display fields and body** are replaced by the superseded record's when the winner's title matches that pattern and the superseded one's does not — i.e. when the newer call recovered *less* than the older one did. All four move together because all four are fed by the one out-of-band lookup the fallback title reports as missed; the body is exempt for an accumulate-body source, where it is merged rather than replaced. This applies to both branches above and is deliberately independent of accumulate-body: title recovery has nothing to do with body accumulation, and the two flags are declared in different combinations. It is the same predicate the write path applies against the file already on disk (spec 154), sharing one implementation so the two collapse points cannot drift. Both are needed: this one is the only cover for two calls in the *same* scan, where no file exists yet on a first capture. Ordering is by recency rather than argument position, so a transcript with backwards timestamps is covered in both directions.
8. Return the deduped list and the cursor target.

### Claude envelope variant

Claude transcripts are JSONL lines, one per message; each message has a role and a `content` array of typed blocks. The Claude parser:

1. Builds a set of substring needles once: each MCP tool-name prefix from the Claude binding, plus the shell-tool exact names (quoted to avoid matching e.g. `BashOutput` when the needle is `Bash`).
2. For each line from the cursor onward:
   - skip empty lines;
   - skip lines that contain neither a needle nor the `tool_use_id` marker;
   - else `JSON.parse` the line — on failure, log and continue;
   - read `message.role`, `message.content`, and the optional `timestamp`.
3. **Assistant role** → iterate content blocks; for each `tool_use` block:
   - apply the cutoff to the assistant-message timestamp;
   - resolve the source via the registry `match` for the Claude agent and this tool name (prefix, then the optional exact allow-list, then the optional suffix gates). Failing that, for shell tools parse the command string from the block's `input`, consult the producer-neutral CLI registry, and look up the resolved source id in the registry. If neither resolves, drop;
   - record the pending entry by the block's `id`, along with the 0-based index of the line it was found on (used by the tail-rewind rule below), carrying the resolved source definition, the canonical tool name (verbatim for MCP; the binding's synthetic name for CLI), the reshape/normaliser (identity for MCP), and the message timestamp. Shell entries are flagged "require success". For any source whose id is in the **context-normaliser registry** (below — `slack`, `zoom-doc`, `confluence`, `monday`, `context7`, `jollimemory`), the `tool_use` `input` is retained on the pending entry, so its normaliser can read out-of-payload context (Slack's channel id + message timestamp, zoom-doc's file id, monday's `itemIds`, Context7's library id + query, and `jollimemory`'s per-tool argument — the branch, query, or slug the lookup was made with); every other source's normaliser is identity and never reads it (Confluence's normaliser is registered but ignores the input — see below).
4. **User role** → iterate content blocks; for each `tool_result` block:
   - apply the cutoff to the user-message timestamp;
   - look up the pending entry by `tool_use_id`; drop if absent;
   - if the entry is "require success" and the result is flagged `is_error: true`, drop without parsing (a failed shell command whose stdout happens to be valid issue JSON must not be ingested);
   - extract the payload text: either the `content` string directly, or the joined text of every `{type:"text", text:…}` element in a `content` array;
   - `JSON.parse` the payload text. On failure, first attempt **oversized-tool-result offload recovery** (below); if that recovery declines and the resolved definition is **arguments-derived**, substitute an empty payload object and continue (see "Arguments-derived allowance"); only if neither applies does the parser log with a preview and drop;
   - if the source's id is registered in the **context-normaliser registry** (`slack`, `zoom-doc`, `confluence`, `monday`, `context7`, `jollimemory`), run its context normaliser over the parsed payload plus the retained `tool_use` input plus the parse-scoped environment (the permalink map, the workspace url, and this call's own tool name); a `null` return drops the result. Otherwise the payload is passed through the entry's reshape (identity for MCP; the command-aware CLI normaliser for shell).
   - emit a normalised tool result, record this line as the most recent line that paired a result (used by the tail-rewind rule below), and remove the pending entry.
5. Return the collected results and the index of the last line traversed.

The **context-normaliser registry** no longer belongs to the Claude binding: it was extracted into a shared module that **both** the block-pairing parser and the wire-event parser call, so a second copy of the machinery cannot drift into existence. Spec 342 owns it; the rule it enforces, restated here in full because both parsers depend on it:

> Given the resolved definition, the tool name, the tool call's retained arguments, the decoded payload, and a parse-scoped environment (the pasted-permalink map plus the caller's extraction options), test the definition's id for **own-key** membership in a closed registry. On a miss return the payload unchanged — the identity path, and the common case. On a hit invoke the member with the payload, the arguments, and the environment **plus the per-call tool name spread in**, and return whatever it returns, including `null`. A `null` return means one thing only: the normaliser voided the reference, and the caller drops the result and removes the pending call. The identity path can never return `null`. The entry point itself never inspects the payload, never inspects the tool name, and never fails.

The set of registry keys is also exported as a value in its own right, and the block-pairing parser consults it at the moment it records a pending tool call to decide whether that call's arguments must be **retained** until the result lands; a call whose source is not a member has its arguments dropped, because no normaliser would read them.

The two parsers call the entry point at different moments, and the asymmetry is structural rather than incidental. The block-pairing parser calls it **only for a member**, because a non-member there goes through its own per-entry reshape hook — identity for a plain MCP call, and a *command-aware* normaliser for a shell-command call, which needs the originating command string, a value this shared entry point has no parameter for. The wire-event parser calls it **unconditionally** and lets the identity default handle a non-member, because it has no shell-command path at all.

Its membership is exactly the sources whose canonical shape the default identity path cannot produce — either because the shape needs out-of-payload context (Slack's channel id + message ts and a resolved permalink; zoom-doc's file id, which lives only in the originating `tool_use` input; monday's `itemIds`, read from the originating tool call's input to gate a targeted fetch from a whole-board browse), OR because it needs a payload-internal reshape the declarative engine cannot express (Confluence's Atlassian-Document-Format body must be flattened to a plain-text string, and the two envelope shapes — Claude's wrapped page-node vs Codex's flat page-node — reconciled). monday needs **both**: the out-of-payload `itemIds` gate AND a payload-internal reshape (flattening each item's Quill-delta body). The documentation-lookup member reads the retained tool-call input **exclusively** — its normaliser takes the library id and the query off the call's arguments and ignores the payload entirely, which is the arguments-derived contract in practice. `jollimemory` reads the input exclusively too, plus one thing no other member needs: the **per-call tool name**, carried on the parse-scoped environment alongside the permalink map and the workspace url. It is threaded rather than inferred because a source matching several tools of one server cannot always recover which one fired from the arguments alone — two of the tools it matches legitimately take no arguments at all, so their inputs are byte-identical and duck-typing cannot tell a captured tool from an ignored one. Unlike the rest of that environment, which is built once per scan, the tool name is spread on per call. Membership is checked over the registry's own keys only, so a prototype-chain id (`toString`, `constructor`) can never resolve a normaliser — the same closed-registry boundary the transform registry uses (spec 255). Adding a source that needs out-of-payload context is one entry here, not a per-source `if def.id === …` branch. Slack's specifics are **spec 256**; the Confluence normalisation and its Codex-only display-field gap, the monday.com item normalisation, and the two arguments normalisations (Context7 and Jolli Memory) are catalogued in **spec 154**.

The permalink map the Slack branch consumes is scanned once up front from the user text lines; the workspace-URL fallback used when no permalink was pasted is threaded in from config (both are spec 256's concern).

#### Oversized-tool-result offload recovery (Claude) — notable / security-relevant

When a tool result's JSON body exceeds Claude Code's tool-output cap, the payload is **not in the transcript at all** — the agent host offloads it to a file on disk and leaves only a human-readable pointer string in the `tool_result` block. Some sources routinely blow the cap (a Zoom meeting-assets bundle, a large Zoom doc), so the parser, upon a `JSON.parse` failure of the payload text, attempts to read the real payload back before falling through to the warn-and-drop:

1. Detect the pointer. Two distinct host wordings are accepted, each exposing the file path as its trailing capture up to end-of-line: an oversized-error form (`…exceeds maximum allowed tokens. Output has been saved to <path>`) and a large-persisted form (`Output too large (…). Full output saved to: <path>`). If neither matches, recovery declines and the caller drops.
2. Normalise the captured path: take only the first line, trim, and strip a single trailing `.` (the pointer ends a sentence).
3. **Containment guards — the config/transcript is not trusted with an arbitrary file read.** Every one of these must hold or recovery declines:
   - the path must be **absolute**;
   - the path must not contain `..` (no traversal);
   - the path's **immediate parent directory** must be literally named `tool-results` (requiring it as the immediate parent, not merely a segment somewhere in the path, stops a crafted pointer from walking into an unrelated tree that happens to contain a `tool-results` component);
   - the on-disk entry, inspected without following links, must be a **regular file** (a symlink is rejected outright — the real offload file the host writes is always a plain file);
   - the file size must be at most **10 MB** (bounds a pathological read; generous against observed bundle sizes).
4. Read the file as UTF-8 and `JSON.parse` it. On success the recovered object becomes the payload (logged at info with the recovered path); any read/parse error is swallowed and recovery declines.

This recovery runs *before* the context-normaliser dispatch, so an offloaded Zoom-doc / Confluence / Slack payload is recovered first and then handed to its context normaliser exactly as an inline payload would be.

#### Tail rewind of the returned cursor (Claude) — affects every Claude source

The Claude parser's returned "last line traversed" value is not unconditionally the end of the window. After the scan completes, the parser rewinds it when a matched tool call was left unanswered at the tail of the window. The rule:

1. While scanning, the parser records for each matched pending entry the 0-based index of the line its tool call was found on, and separately tracks the most recent line index that successfully paired a result. The paired-line tracker starts one below the window's start line, so in a window where nothing paired at all, **any** pending entry qualifies.
2. After the scan, if any still-pending entry sits **strictly after** the last paired line, the returned cursor is rewound to the **earliest** such line index.
3. The rewind target is evaluated per-entry against the last paired line. An earlier abandoned call that already sits before a later successful pairing therefore cannot drag the target backwards and suppress a rewind that a genuinely newer unanswered call needs.

Why it exists: for a source whose reference is built from the call's arguments, those arguments live **only** on the tool-call line. If the cursor advanced past that line before the result arrived, the arguments would be gone from every future window and the reference would be stranded permanently — the shared discovery cursor only ever moves forward.

Consequences, all observable:

- **The returned value is a 0-based line index, whereas the ordinary path returns a 1-based count.** These are consistent because the caller consumes the value as the next window's start line, and the scan treats its start line as 0-based.
- **A rewind to the window's own start line simply holds the cursor**, because the caller only persists a cursor that moved strictly forward.
- **A matched tool call that never receives a result and is the last matched call in the window pins the cursor at its line indefinitely.** Every re-scan re-registers it as pending with no later pairing, so the cursor cannot advance. It self-heals only once some later result pairs, pushing the last-paired line past it.
- **Re-scanning the held window is idempotent** — the pipeline dedupes by registry key and the persistence step upserts by the same key — so the cost of a pinned cursor is repeated work, never duplicated references.

### Codex envelope variant

Codex rollouts encode each MCP call across up to three lines, correlated by a `call_id`:

- `function_call` — the request: connector namespace, short tool name, call id, JSON-string arguments. For MCP calls the namespace identifies the connector (e.g. `mcp__codex_apps__linear`). For shell CLI calls the name is the fixed string `shell_command` with no namespace, and the command is embedded as a JSON-encoded string inside the `arguments` field.
- `function_call_output` — the **primary** result: call id plus a single `output` string. For MCP calls the output is prefixed with `Wall time: …\nOutput:\n` followed by the JSON body; for shell calls it is prefixed with `Exit code: N\nWall time: …\nOutput:\n`. The richest payload — for some sources, the only place a usable tenant URL appears.
- `mcp_tool_call_end` — a redundant event the parser uses **only as fallback** for call ids whose `function_call_output` is missing or unparseable. There is no `mcp_tool_call_end` for shell CLI calls.

The Codex parser:

1. Pre-filters lines on four substrings: the shared Codex-apps namespace prefix, the event marker, the output marker, and the shell-call marker. Lines containing none of these are skipped.
2. Builds four indexes as it walks:
   - **calls**: call id → (namespace, short name, line index of the request).
   - **shellCalls**: call id → (matched CLI binding, line index of the request) — for `shell_command` requests whose arguments parse and whose command matches the CLI registry.
   - **outputs**: call id → (output string, line number, timestamp) — gated by the cutoff.
   - **events**: a list of tool-call-end rows — gated by the cutoff.
3. Records a separate "result was seen for this call id" set the moment any result line lands, **before** the cutoff or parse gates. This drives the in-flight rule (below); a result that was cutoff-dropped or failed to parse has still answered its request and must not pin the cursor.
4. **Primary pairing** (MCP): for each (call, output) pair, resolve the source definition via the registry `match` for the Codex agent from `(namespace-suffix, name)` (the shared `mcp__codex_apps__` prefix is stripped from the namespace before matching); then look up the Codex normaliser by the resolved definition's id. **If no normaliser exists for that id, the pair is dropped** — today this is a purely defensive guard, since every Codex-matched definition has a registered normaliser (an earlier revision lacked a Codex Slack normaliser; that gap is closed). Otherwise parse the output (stripping the `Wall time:` / `Exit code:` prefix when present); unwrap the MCP text envelope — two shapes are handled: the older bare-array form `[{type:"text", text:"<json>"}]` and the newer full-CallToolResult form `{content:[{type:"text", text:"<json>"}, …], …}` where the payload is in `content[0].text`; if the payload cannot be parsed and the resolved definition is **arguments-derived**, substitute an empty payload object instead of dropping the pair (see "Arguments-derived allowance"); apply the normaliser. A normaliser that returns `null` (a void — Slack's unresolvable url, or monday's board-browse gate) is skipped **without** marking the call id emitted, so a paired end-of-call event can recover it on the fallback pass; only a non-null normalize marks the call emitted, and only then is a normalised result emitted with the normaliser's canonical tool name.
5. **Primary pairing** (CLI): for each (shell call, output) pair, parse the exit code from the output's `Exit code:` prefix and require exactly `0` (a non-zero or absent exit drops the result — the conservative choice for a false-positive guard); then proceed as for MCP. CLI call ids never overlap MCP call ids and have no event fallback.
6. **Fallback pairing**: for each event, if its call id was already emitted, skip; else resolve the source definition via the registry `match` for the Codex agent from the invocation tool name (no-namespace path), then look up the Codex normaliser by the resolved id (no normaliser → drop, today a purely defensive guard — see step 4); parse the event's text payload, applying the same arguments-derived empty-payload substitution on a parse failure as the primary loop does. The fallback threads the tool call's arguments into the normaliser — preferring the event's own invocation arguments, falling back to the paired request's arguments when the event carries none of its own — plus the same parse-scoped context (the permalink map, the workspace url) available on the primary path; this is what enables monday's `itemIds` gate and Slack's url resolution to run on the fallback pass exactly as they would on the primary pass. If the normaliser declares a recovery hook **and** a same-call-id raw output exists (the primary path produced one but failed to parse), invoke the hook to stitch fields salvageable only from the malformed output (the canonical real case: a Jira tenant URL that lives only on the heavy-expand output, which can be invalidated by a stray escape in a rich field). Apply normaliser and emit.
7. Sort the emitted results by line number so the shared dedupe's tie-break is stable.
8. Compute the "safe cursor" (in-flight rule): walk the calls and shellCalls indexes; for each request whose call id is not in the "result was seen" set and whose binding is recognised, hold the cursor at that request line. The returned cursor is `min(last line scanned, every in-flight request's line index)`. The next scan re-reads each in-flight request and re-correlates it once its result arrives. Non-recognised calls never pin the cursor.

### Wire-event envelope variant

The Kimi Code CLI producer writes one JSON event per line; tool activity is nested inside a loop-event envelope whose inner event is either a call or a result, correlated by a call id. Its parser is summarised here because the shared pipeline consumes its output like any other's; the envelope, correlation and cursor details are owned by **spec 340**.

1. Pre-filter each line on the loop-event envelope marker, then parse; require the envelope type and an object inner event. The timestamp comes from the **outer** envelope's millisecond epoch, converted to ISO 8601 (empty string when absent, non-numeric, or an out-of-range instant).
2. On a call event: require a string tool name and a string correlation id; require the tool name to start with the **MCP server prefix**; apply the cutoff to the call (a call past it is not stashed, so its result later finds no pending entry); resolve the definition through the registry `match` for the **Claude** agent, verbatim; stash the pending entry with the definition, the tool name, the call's arguments, its timestamp, and its line index.
3. On a result event: require a pending entry under the correlation id (a result for an untracked call is dropped and does not move the tail boundary); record the line as the last paired-result line; apply the cutoff, deleting the pending entry **first** so it can never pin the cursor; require a **string** result output; JSON-parse it, falling back to an empty payload object for an arguments-derived definition and dropping otherwise; run the shared MCP business normaliser with an **always-empty** permalink map; emit a normalised result at the result line.
4. Sort emitted results by line number, and return the count of lines traversed — rewound to the earliest unanswered matched call in the **trailing suffix** (strictly after the last paired-result line) when one exists.

Two consequences of that parser's shape belong here, because they are properties of this pipeline's recognition model rather than of that transcript format:

- **Identity resolution reuses the block-pairing agent's match table with no source-specific rules.** A definition is therefore reachable from this producer only if it declares a **generic, server-prefixed** tool-name shape — the shape a user's own MCP registration produces. A definition whose only declared shape is the hosted first-party-connector namespace cannot be matched here at all, because a session of this host does not produce tool names in that namespace. Spec 154 catalogs which definitions fall on which side.
- **The shell-CLI fallback is unreachable from this producer.** Every tool call whose name lacks the MCP server prefix is dropped before any command string is examined, so a source both other producers reach by recognising a command-line invocation inside a shell tool call is reachable here **only** through an MCP server. There is no shell branch to add a binding to.

### Persistence pipeline

The extractor returns references; persistence is a thin shared step called from each producer's trigger:

1. Run the extractor with the cursor's `fromLine`.
2. If zero references, return the cursor's `lastLineNumberScanned` to the caller.
3. For each reference, in order — its **two writes both inside one `plans.json` lock acquisition** (the lock is taken per reference, not once per batch):
   - write the markdown file (idempotent: byte-equal existing content skips the write so mtime is preserved);
   - upsert the registry row; on insert seed `addedAt`/`updatedAt` to now; on update refresh `title`, `url`, `sourcePath`, `sourceToolName`, `updatedAt` and preserve `addedAt`. The lock body re-reads the registry just before write and merges only the current `mapKey`, so a concurrent writer touching other map keys is preserved.

   **The markdown write is inside the lock, not before it.** For an accumulate-body source (spec 255) the markdown write is a read-modify-write — it folds the body already on disk into the incoming record — so two unsynchronised writers each merge into the same pre-merge body and the later write silently drops the other's entries. That race is reachable rather than theoretical: such a source's key is the *act*, not the agent, so independently-scheduled producers (an agent-stop hook and a polling discovery tick) contend for one file. For every other source the rendered bytes are a pure function of the incoming record, so the ordering is immaterial there.

   The near-write re-read mitigates the **registry only**. It works because a registry row is overwritten wholesale (an idempotent per-key set); an accumulated markdown body is *folded*, so nothing mitigates a lost update on it when the lock cannot be acquired.
4. Wrap each per-reference upsert in a try/catch: a single bad row (transient lock contention, FS permission, …) must not abort the batch — that would lose later refs and skip the caller's cursor save, looping on the same failure next pass.
5. Log "upserted N of M (failed: [keys])" and return `lastLineNumberScanned` to the caller.

### Cursor advance (caller-owned)

The caller orchestrates the cursor save based on both this pipeline's result **and** the parallel plan-discovery scan that walks the same lines:

- Where both scans run they read the same file and share one cursor row keyed by transcript path.
- Producers differ in scan order:
  - Claude path: plan scan first, then reference scan. The cursor advances only if the plan scan completed normally; if the plan scan threw, the cursor is held so the same window retries — even though the reference scan may have reached EOF.
  - Codex path: reference scan first; its returned "safe cursor" caps the plan scan's window (the plan scan is told to stop at the safe cursor so it never processes lines that the reference scan deliberately held). The cursor advances only if both scans completed.
  - Wire-event path: there is **no plan scan at all** — that host writes no plan markdown, so there is nothing for one to find. The reference scan alone drives the shared cursor, which advances only when that scan completed and its safe cursor moved strictly forward. Nothing caps its window, because there is no second scan to cap.
- The cursor is never advanced past lines the reference scan deliberately held for in-flight requests (Codex specific).
- Re-scan on retry is safe because every step is idempotent: dedupe collapses re-emitted refs and registry upsert is keyed by `mapKey`.

### Trigger timing per producer

| Producer | Trigger                                  | Source value passed | Cap on scan window               |
| -------- | ---------------------------------------- | ------------------- | -------------------------------- |
| Claude   | Per-stop hook fired by the agent itself.  | `claude`            | None — always scan to EOF.        |
| Codex    | Two triggers: the 60-second sidebar polling tick, **and** once per post-commit queue drain. | `codex`             | Implicit — held cursor for in-flight requests. |
| Kimi Code CLI | The same two triggers as Codex, and at the post-commit trigger the two run **concurrently against one shared deadline**. | `kimi`              | Implicit — cursor rewound to an unanswered call in the trailing suffix. |

Neither hookless producer has a usable lifecycle hook (for Codex, Stop-hook trust is per-user and broken under git worktrees), so for each of them both triggers ride the same path the sidebar already uses to discover that producer's sessions. Each producer's discovery call is single-flighted per workspace cwd with a "dirty rerun" flag: a re-entrant call during an in-flight pass marks it dirty so one more pass runs after the current one, instead of deferring rows written mid-pass for a full minute. Sessions are processed serially within a pass so per-session cursor writes never race within a batch. The discovery call never rejects — all errors are logged and swallowed so callers can `void`-call it.

**The post-commit trigger**, which exists so a repository driven by a hookless producer alone (no editor sidebar running) still associates references with its commits, differs from the sidebar's in every way listed below:

- It is **awaited**, not fire-and-forget: the artifacts this pass writes have to be visible to the registry read that assembles the same drain's prompt.
- It runs **once per drain, not once per queued commit**, because discovery is scoped to the working directory rather than to a commit.
- It is **deadline-bounded**, because a person is waiting on it: the post-commit hook tails the worker and blocks until a terminal event or its own watch ceiling. Steady state is cheap (the cursor means only the transcript tail is read), but a first pass over a large session history is unbounded and sits ahead of every summary milestone. On timeout the pass is **abandoned, not cancelled** — its writes still land atomically, and its cursor makes the next commit resume where this one stopped. The trade-off is stated in one direction: a missing reference is worth far less than a missing summary.
- Failure **degrades rather than blocks**. Two independent guards are needed and neither subsumes the other: a synchronous throw out of the discovery call has no promise to attach to, while a pass that loses the deadline race can fail *later*, after the race already settled — silently discarded otherwise, since a race consumes a losing input's rejection.
- **The hookless producers' passes run concurrently and are raced as one unit against a single shared deadline**, replacing the earlier arrangement where each was awaited in its own serial race. That is what keeps the total time charged to the user-waited path bounded no matter how many hookless producers exist: two three-second deadlines could otherwise consume six seconds — and a third producer nine — of a window that every summary milestone also has to fit inside. Each producer's promise carries its **own** rejection handler, so one producer's failure cannot void the other's result, and the enclosing guard additionally survives a synchronous throw that no rejection handler could see.

**Attribution caveat, shared with every other artifact kind.** Consuming the working area associates whatever is active at consumption time with the commit then being processed; there is no per-commit time cutoff on the plan, note or reference registries. So a batch drain of several commits attributes to its *first* processed entry any artifact that appeared after the later commits were made, and an artifact extracted during the summarizing window is archived to that commit without having informed its prompt. This is a property of the artifact model as a whole, not of the Codex path — the Claude per-stop trigger has the same shape — and it is an attribution imprecision between adjacent commits on one branch, never a loss.

### Removal

A reference is removed from the registry when the commit it relates to lands (covered by another spec). Removal also happens on explicit user request through the consumer service:

1. Delete the per-reference markdown file (best-effort — a missing file is not an error so the operation is idempotent).
2. Remove the row from `plans.json` under the lock.

There is no soft-delete or guard-row state for references — every row in the registry is an active, uncommitted reference.

## State Transitions

### Per reference

```
absent
  │
  │ first extraction (or user-driven add elsewhere)
  ▼
active in registry ──┐
   ▲                 │ re-extraction with same (source, nativeId) → refresh
   └─────────────────┘   updatedAt + title/url/sourcePath/sourceToolName,
                         preserve addedAt
   │
   │ commit lands  OR  user removes
   ▼
absent
```

### Per (transcript, call id) — Codex only

```
unseen
  │
  │ request line read; call recognised  →  pending
  │ request line read; call unrecognised → ignored (never pins cursor)
  ▼
pending  ──── result line read (any class) ───►  satisfied
  │                                                  │
  │ next scan: cursor held at request line           │ next scan: cursor may advance past request
  │ rescans request; if result is now present:       │ result emitted only if it also parsed
  ▼                                                  ▼
satisfied                                         (no further state change for this call id)
```

## Notable Behavior

- **Recognition is registry-`match`, interpretation is the source definition.** The registry answers "which source?" by matching the tool identity against each definition's declarative match rule; the shared engine answers "is this payload a reference, and what is it?" by evaluating the definition. Adding a producer extends only the per-producer residual binding + pre-filter; adding a source is a single data-only definition and is automatically visible to every producer whose match rule it declares.
- **Source definition is producer-agnostic.** A definition never sees the producer's tool name and never reasons about which producer surfaced the payload. The tool name is opaque metadata echoed through to the resulting reference.
- **One CLI registry, shared across producers.** The producer-neutral CLI-by-command registry is consulted from both producer envelopes when their respective shell-tool envelope detects a recognised command, so one CLI binding covers every producer that can shell out. The MCP recognition itself is the registry `match` (Claude: prefix + optional accept-suffix; Codex: namespace-suffix + function-call-name, or invocation tool).
- **Canonical tool name is synthetic for CLI and Codex MCP, pass-through for Claude MCP.** This is what lets a Linear issue surfaced through Claude's standalone Linear MCP or its official connector MCP and the same issue surfaced through Codex's connector produce references with comparable `sourceToolName` values (or, for the CLI case, the *same* canonical name regardless of producer).
- **The Linear definition declares two Claude prefixes and no accept-suffix.** The standalone Linear MCP server and the official Claude-bundled Linear connector expose identical issue shapes, so both prefixes resolve to the same Linear source; with no accept-suffix, any tool under either prefix matches, and the definition's payload shape gate decides whether a reference results. Linear write tools (create, update) from the official connector therefore also match; they produce no reference only because their response payloads lack the required `id`/`title`/`url` combination.
- **Tool-level scoping is an accept-suffix on the match rule, not binding code.** A definition may require the tool name to end with a specific suffix in addition to matching a prefix. This scopes the Notion connector to its single-page-fetch tool, the Slack connector to its read-thread tool, the Confluence connector to its page-fetch tool, the two Zoom sources (which share one prefix) to their meeting-assets / doc-content tools, and the Asana connector to its get-task tool — a prefix match with the wrong suffix is not a match at all. Jira and GitHub declare no accept-suffix and accept every tool under their prefix.
- **Enumeration tools are excluded by deny-suffixes (Linear fixed, GitHub deferred).** A Claude match rule may carry a deny-suffix list that *rejects* a tool even after a prefix (and accept-suffix) match. Linear's list/search tools return arrays of many issues the user is not working on; before the deny gate they bulk-captured one reference per array element and flooded the LLM's context, so Linear declares deny suffixes for its issue-list and issue-search tools and those are now excluded outright. The companion Codex fix: Linear's Codex match rule simply never lists the enumeration tool names (only single-issue fetch/get), so Codex-side Linear enumeration is unreachable too. **GitHub carries the identical enumeration risk and is explicitly *not yet* fixed** — its Claude rule declares no deny-suffix, so a GitHub issue-list/search tool call can still bulk-capture. This fixed/not-yet-fixed asymmetry is deliberate for now.
- **Context normalisers are a closed, data-driven registry, not per-source branches — and it is now a shared module, not a Claude-binding detail.** The one concern the identity path can't cover — a canonical shape needing out-of-payload context or a payload reshape the DSL can't express — is handled by a registry keyed by source id, whose members are `slack`, `zoom-doc`, `confluence`, `monday`, `context7` and `jollimemory`. It was extracted out of the block-pairing binding so the wire-event parser could call the identical entry point rather than grow a second copy; spec 342 owns it, including which members are reachable from which parser. The documentation-lookup member reads the retained tool-call input *exclusively* and ignores the payload entirely; `jollimemory` does the same and is additionally the only member that reads the per-call tool name off the parse-scoped environment, because two of the tools it matches take no arguments and so cannot be told apart by their inputs. What used to be a Slack-only special case is now this general mechanism: the `tool_use` input is retained for any id in the set, and the payload-normalisation dispatch is a single lookup over it. Confluence is in the set but needs no out-of-payload context — only an Atlassian-Document-Format-object → plain-string body coercion the DSL cannot do; Zoom-doc needs the file id from the `tool_use` input; Slack needs the channel id / message ts plus a resolved permalink; monday needs both the `itemIds` fetch-vs-browse gate from the tool call's input AND a Quill-delta body flatten the DSL cannot express; Zoom-meeting stays plain identity (it is self-contained). Membership goes through own keys only, so a prototype-chain id can never resolve a normaliser.
- **Reference `url` is optional end-to-end at the record-shape level, and its absence now has two live causes.** A *declared* `url` field-spec voids the reference when the payload carries none — Slack does exactly this. A definition may also declare **no url field-spec at all**, which is not a failure but the normal shape for a source with no external destination (`jollimemory`); such a reference is produced and persisted with no url. Extraction, dedupe, persistence, and display all tolerate an absent url either way, and only the definition distinguishes the two cases (spec 255).
- **Reachability differs per producer, and only the Claude path reaches every registered definition.** A definition is reachable on the Codex path only when it declares a Codex match rule *and* has a registered Codex normaliser; a definition declaring no Codex match rule at all is never even matched there. A definition is reachable on the wire-event path only when its **Claude** match rule declares a generic, server-prefixed tool-name shape, because that parser resolves identity against the Claude match table verbatim and drops every tool name lacking the MCP server prefix. Spec 154 catalogs which definitions fall on which side of both splits; this pipeline states only the rules.
- **"All existing source definitions apply for free on the new producer" is false, and the shared-parser reuse invites exactly that reading.** Reusing the Claude match table means a definition is reachable from the wire-event producer only if its declared tool-name shape can physically occur there. Every definition whose only declared shape is the hosted first-party-connector namespace is a **known gap**, not a covered case: a session of that host cannot produce a tool name in that namespace. Their normalisers and extraction pipes exist and are exercised from the block-pairing producer's transcripts; from the wire-event producer they are simply never reached. Covering one means adding a generic prefix to that definition, pinned to a real capture of that server's tool naming under that host — not a change to the parser. (Surprising.)
- **The shell-CLI fallback is reachable from the block-pairing and triple producers only.** The wire-event parser drops every tool call whose name lacks the MCP server prefix *before* any command string is examined, so the producer-neutral CLI binding registry is never consulted there. The one source both other producers can reach through a command-line invocation is reachable from that host only through an MCP server. (Unreachable code path for that producer, not a missing binding.)
- **A locally-registered MCP server is matched only on the redundant-event line, and only when that line's reported server agrees.** `jollimemory` (and a locally-run Context7) reach Codex through the `mcp_tool_call_end` invocation-tool path rather than the function-call path, because a local server's request line carries neither the connector-app namespace nor a prefixed tool name — it therefore matches none of the parser's line pre-filter needles and is dropped before parsing. Nothing is lost: that event carries the server, tool, and already-parsed arguments together, which is all an arguments-derived source needs. All three parts are load-bearing, not just the tool: a local server's tool name is **bare**, and the invocation-path lookup is one scan across every definition with no other qualifier, so a definition registering bare names also pins itself to a server name and the event's reported server must equal it. Otherwise any other local server exposing an identically-named tool (`search` is not a distinctive name) would resolve to that source. The pin is optional per definition — every connector-app source's key is already server-qualified (`asana.get_task`) and so needs none — and it can only ever reject a match, never widen one. It fails closed: an event with no reported server matches no pinned definition. Spec 154 records the captured shapes.

  Slack is reachable on both producers, but its Codex thread is normally recovered on the **fallback** pass rather than the primary pass: a Slack call whose primary-pass normalize returns a void (unresolved url) is skipped without being marked emitted, so the paired end-of-call event gets a chance to retry with its own (or the paired request's) arguments and resolve the url there instead. Zoom-doc references are therefore produced on the Claude path only. (Slack's capture specifics are spec 256; the Codex-polling view is spec 180.)
- **Substring pre-filter precedes JSON.parse.** Every envelope parser cheaply rejects most lines on substring presence before paying the JSON-parse cost. Missing or misnaming a needle silently drops a whole class of lines — the parsers list each needle with the variant it gates. The Codex parser's four needles gate the namespace prefix (MCP requests), the event-type token (fallback events), the output-type token (primary results), and the shell-command name (shell CLI requests). The Claude parser's needles are derived from the registered tool-name prefixes plus the quoted shell tool names. The wire-event parser has a single needle, the loop-event envelope marker, because that envelope is the only place tool activity appears.
- **Only the Claude pre-filter is registry-derived; the Codex one is hard-coded.** Registering a new source automatically contributes its Claude tool-name prefix to that parser's needle set, with no separate edit. The Codex parser's four needles are fixed constants instead. One observable consequence: a Codex tool call that is *not* under the shared connector-app namespace — a locally-run MCP server — produces a request line containing none of the four needles, so that line is filtered out before parsing and only the redundant end-of-call event line survives to be matched. This is why such a source is delivered on the fallback pass as its normal path.
- **The Claude and Codex in-flight protections are asymmetric, for a real reason.** Claude needs the tail rewind because an arguments-derived source's arguments exist only on the tool-call line. Codex does not: the corresponding end-of-call event carries the invocation's own arguments, so the event line is self-sufficient. Codex's in-flight hold additionally skips any request whose namespace is not the shared connector-app namespace, so a locally-run MCP call **never pins the Codex cursor** — and does not need to.
- **Only Claude has offload-file recovery.** Neither the Codex parser nor the wire-event parser has an equivalent mechanism for an oversized result. Claude also attempts recovery *before* the arguments-derived empty-payload substitution, so a genuinely offloaded payload is preferred over an empty object.
- **The wire-event parser's permalink map is always empty.** That transcript format carries no pasted permalinks, so the one normaliser that consults the map can resolve a link there only by reconstructing it from a configured workspace address — and the source that normaliser serves is in any case unreachable from that producer.
- **The arguments-derived allowance is one guarded branch per loop, and inert for every other source.** It is gated on the flag being exactly `true`, so every non-declaring definition keeps the previous warn-and-drop path unchanged. Claude has one such branch; Codex has one in each of its two pairing loops.
- **Codex `function_call_output` MCP envelope has two shapes.** After stripping the `Wall time:` or `Exit code:` prefix, the JSON body is unwrapped through two observed shapes: the older bare-array form `[{type:"text", text:"<json>"}]` and the newer full-CallToolResult form `{content:[{type:"text", text:"<json>"}, …], …}`. Both carry the business payload in the first text block's `text` field. Any other form (e.g. an already-unwrapped object) is passed through to the engine unchanged.
- **Cutoff on both tool_use and tool_result (Claude).** Past-cutoff messages drop their `tool_use` registration entirely so a later in-window `tool_result` finds no pending entry and is silently ignored — preserving the older inline behaviour exactly.
- **In-flight cursor hold (Codex).** Time-based polling can fire between a request and its result row. Advancing to EOF would strand the in-flight result on the next poll — its output row carries only `call_id` + `output` and is unsourceable without re-reading its request line. The parser tracks "result seen for this call id" pre-cutoff and pre-parse, then holds the returned cursor before any unsatisfied recognised request. Non-recognised calls never pin the cursor (they would deadlock the parser on calls the pipeline never wanted anyway). This relies on the cutoff being monotonic non-decreasing across polls; a shrinking cutoff would orphan now-emittable outputs.
- **Salvage path (Codex).** A binding may declare a recovery hook for the rare case where two redundant copies of the same call's payload disagree on validity: the rich primary output fails to parse, the leaner event payload parses but lacks a field present only in the malformed primary. The hook stitches the recoverable scalar out of the raw string. Used today for one specific case; bindings without this brittle edge omit the hook.
- **Shell-result success gate.** A shell-CLI fallback whose underlying command exited non-zero is dropped even when its stdout happens to be valid issue JSON — defence against false positives from `gh issue view` printing a stale cached payload before erroring. This gate lives in both envelope parsers (Claude reads the `is_error` flag on `tool_result`; Codex parses the `Exit code:` prefix from the output) so the producer-neutral CLI binding never has to know.
- **Defense-in-depth on the payload walk.** Each per-result walk is wrapped so a single attacker-influenceable deeply-nested payload (a `RangeError` from runaway recursion) cannot abort extraction for the entire transcript.
- **Oversized-tool-result offload recovery is guarded (Claude, security-relevant).** A tool result too large for the transcript is offloaded to a file, leaving only a pointer string. On a payload parse failure the parser follows that pointer and reads the payload back — but only under strict containment: the path must be absolute, must not contain `..`, its immediate parent directory must be literally `tool-results`, the entry must be a regular (non-symlink) file, and the read is capped at 10 MB. Two host wordings are recognised; anything else falls through to the ordinary warn-and-drop. This exists because some sources (Zoom meeting-assets, large Zoom docs) routinely exceed the cap and would otherwise never be captured.
- **Dedup tie-break is "later-seen wins".** Equal `referencedAt` (common when a search lists then a fetch resolves) keeps the later one — so the more-detailed fetch payload overwrites the search hit's partial payload. This is why the pipeline must not reorder the parser's output.
- **Idempotent markdown write.** Byte-equal existing markdown skips the file write so mtime is preserved — file watchers don't churn on re-extraction.
- **GROUNDED BUG — a timestampless accumulating record grows its file without bound on every re-scan.** The body lift stamps the record's `referencedAt` onto the entry line it produces, and that timestamp is the empty string whenever the result row carried none (both producers default it to empty rather than dropping the result). The resulting line does not satisfy the entry format, which requires at least one non-whitespace character in the timestamp position. Everything downstream then treats it as a **hand-edit**:

  - it is preserved verbatim rather than parsed into an entry;
  - it therefore escapes the same-text collapse (only entries collapse by text) **and** the entry cap (only entries are capped), and no drop notice is ever emitted for it;
  - the newest-query read-back scans for the entry format, so it finds nothing and the row falls back to a bare date — the row carries no information about what happened, which is precisely what the accumulating display rule exists to avoid (spec 187).

  The unbounded part is the merge: hand-edit lines from **both** sides are concatenated with **no de-duplication**. So a re-scan of a held window re-emits the byte-identical line, the merge appends it beside the copy already on disk, the rendered bytes differ from the existing file so the byte-equality write gate does not fire, and the next re-scan repeats — one extra identical line per pass, for as long as the cursor stays held. (Two timestampless calls inside a *single* scan already produce two lines, via the same concatenation in the cross-record collapse.)

  This directly contradicts this spec's own **"Idempotent re-scan"** guarantee below, and the same claim made in **"Re-scanning the held window is idempotent"** under the Claude tail-rewind consequences — both of which hold only because the markdown write used to be a pure function of the record. Recorded as observed behavior, not as intended design. It is not the common path: both producers' real transcripts do timestamp their result rows, so the trigger is a result row missing its timestamp.
- **Idempotent re-scan.** The whole pipeline is safe to re-run on the same line window: the dedupe collapses duplicates, the upsert is keyed by `mapKey`, and the markdown write is byte-equality-gated. A scan that throws midway can be retried with the same cursor without producing duplicates or losing entries. For an accumulate-body source this holds only while its entry lines are well-formed — see the timestampless-record defect above.
- **Per-reference try/catch in persistence.** One bad row never aborts the batch; the batch logs the failed `mapKey`s and the caller advances the cursor regardless, so the same failure does not loop forever.
- **Discovery cursor is shared with plan discovery.** One cursor row per transcript path, merged with the markdown-plan scan that walks the same lines. The advance rules differ per producer (plan-first hold-on-throw for Claude; ref-first-caps-plan-window for Codex) but the cursor file is the same.
- **Codex polling is single-flighted with dirty-rerun.** Overlapping calls from the sidebar tick, panel re-open, manual refresh, and detail-panel save share one in-flight promise; a re-entrant call sets a "dirty" flag so one more pass runs after the current one — without this, rows written mid-pass would defer a full minute.
- **GitHub key sanitisation is collision-free across repos.** Different `(owner, repo, number)` tuples never produce the same on-disk filename even after lossy character replacement, because an 8-hex `sha256(nativeId)` suffix is appended unconditionally.
- **All built-ins except GitHub and Context7 use identity key sanitisation.** Every other built-in's native ids are already filesystem-safe and globally unique within the source, so the file-stem is the id verbatim. GitHub and Context7 both carry slashes in their native ids and take the replace-then-hash branch instead. The identity is load-bearing for the archive-form round-trip used by the orphan-branch snapshot in spec 154 — changing this without updating the round-trip would break re-extraction across re-summarise.
- **Unknown producer id falls back to Claude.** The Claude parser's substring pre-filter trivially produces zero results on a non-Claude transcript, so a misconfigured caller produces "no references" rather than crashing.

## Shared Behavior

- **The source-definition DSL, evaluation engine, transform-registry security boundary, structural validator, and the registry `match` semantics** are defined by spec 255.
- **The shared MCP business-payload normaliser** — its single entry point, its closed id-keyed membership, its identity default, the one meaning of a `null` return, and which members are reachable from which parser — is owned by spec 342. This spec restates the rule because both parsers depend on it.
- **The wire-event producer's session discovery and transcript reading** are owned by spec 339; **its hookless discovery pass** — single-flight, gates, the serial per-session loop, its two drivers and the commit-time deadline it shares with the Codex pass, and the deliberate absence of a plan scan — by spec 340; and **its skill capture**, which rides an independent high-water mark inside the same pass, by spec 341.
- **The catalog of the built-in source definitions** (per-source pipes, id/url rules, display fields, wrapper keys, budgets, render tags), the shared Atlassian-Document-Format → plain-text reshape, the Confluence dual-envelope normalisation, the monday.com item normalisation, the Context7 arguments normalisation, the Jolli Memory arguments normalisation, and the canonical reference shape are defined by spec 154.
- **The three optional definition flags** this pipeline and its consumers read — the arguments-derived flag consumed by both envelope parsers here, the accumulate-body flag consumed by this pipeline's body lift and cross-record collapse (and by the persistence layer, spec 179), and the track-only flag consumed by the prompt-block builders (spec 12) and the relevance ranker (spec 258) — are contractually owned by spec 255.
- **The accumulating body's entry-line format, the merge rule the collapse here delegates to, the entry cap and its drop notice, and the newest-entry read-back helper** are owned by spec 179. This pipeline owns only the *lift* — turning one record's body into one timestamped entry line at extraction time — and the decision to merge rather than discard when two records share a key.
- **Slack capture** — permalink harvesting from user text, workspace-URL permalink reconstruction, thread normalisation, the read-thread tool scope, and Slack's dual-producer reachability — is owned by spec 256.
- **The transcript readers** that present the raw JSONL each producer writes are covered by specs 16–22.
- **The session registry** that records "this transcript exists at this path" is covered by spec 26 (Claude path) and its Codex counterpart. Spec 26 still describes the Claude post-record step as plan-discovery only; in current code that step is now a merged plan-and-reference discovery pass over one shared cursor — that spec is stale and is being revised separately.
- **The 60-second sidebar tick** that drives the Codex extraction path is covered by the sidebar specs in the 100–117 range.
- **The orphan-branch snapshot** that takes a value-copy of each reference into the commit summary when the related commit lands is covered by the summary-storage specs (01–06).
- **The local registry file** (`plans.json`) that holds active reference rows alongside plan and note rows, and its locking semantics, are defined by the session-tracking spec family.
- **The display surface** (sidebar panel, detail panel, open-in-browser, scheme-revalidation at the sink) is covered by the VS Code sidebar specs (100–117) and the IntelliJ tool-window specs (118+).
