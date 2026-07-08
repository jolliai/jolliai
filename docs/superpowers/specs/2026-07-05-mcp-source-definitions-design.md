# Config-Driven MCP Source Definitions Design

- **Date**: 2026-07-05
- **Status**: Design under review
- **Goal**: Collapse the existing Linear / Jira / GitHub / Notion MCP reference integrations from "one hand-written TS adapter per source + scattered binding RULES" down to **one declarative source definition + one generic engine**. Adding an MCP source becomes writing a single config rule, eventually (in phases) supporting runtime user extension with zero code, injecting extraction results into the Context of Working Memory.

---

## 1. Background & current state

The reference extraction pipeline is layered along three orthogonal concerns (see [`cli/src/core/references/`](../../../cli/src/core/references/)):

1. **Envelope** (by AI agent): how to recognize an "MCP tool call + return payload" within a single transcript JSONL line. `ClaudeEnvelopeParser` / `CodexEnvelopeParser`, selected by `getEnvelopeParser(source)`.
2. **Binding** (by producer): tool identity (prefix/namespace/CLI command) → `SourceId` + `normalize` + business-scope `accept`. `bindings/{claude,codex,cli}`.
3. **Adapter** (by external system): `extractRef(payload) → Reference | null` (pure shape validation) + `renderPromptBlock(refs) → XML`. `sources/{Linear,Jira,GitHub,Notion}Adapter.ts`.

The driver `ReferenceExtractor.extractReferencesFromTranscript` is already fully generic: the envelope parser produces `NormalizedToolResult[]` (each carrying its matched adapter + payload) → `walkPayload` recurses over `wrapperKeys` calling `extractRef` → `dedupeKeepLatest` (by `mapKey`).

**The data model is the real seam for generalization**: `Reference` ([`Types.ts:698`](../../../cli/src/Types.ts)) has fixed core fields (`source`/`nativeId`/`title`/`url`/`description`/`toolName`/`referencedAt`) + an **opaque `fields[]` bag** (`{key,label,value,icon}`). The common layer (storage, commit snapshot, panel, prompt) **only passes through, never interprets `key`**.

**Storage**: uncommitted references are stored as `<jolliMemoryDir>/references/<source>/<key>.md` (frontmatter + body) + a `plans.json.references` registry row; on commit the registry entry is deleted and the reference is snapshotted into the orphan branch `CommitSummary.references`.

**Injection into Working Memory**: `QueueWorker.assembleReferenceBlocks` ([`QueueWorker.ts:1452`](../../../cli/src/hooks/QueueWorker.ts)) buckets by `SourceId` → calls each adapter's `renderPromptBlock` → concatenates XML in `ALL_ADAPTERS` order → feeds the SUMMARIZE prompt (order fixed to hit the prompt cache).

**Current pain point**: adding a source touches 4 places — the closed `SourceId` union + `isSourceId` guard, a new `SourceAdapter` + registration into `ALL_ADAPTERS`, each producer's binding RULES, and possibly `sanitizeNativeIdForPath`. The system is already "plugin-like", but each plugin is a hand-written TS module + an edit to a closed enum.

## 2. Goals & non-goals

### Goals
- A single declarative source definition fully expresses one MCP source: match rules + field extraction + render template + storage semantics.
- **No arbitrary code**: extraction is expressed with a closed op vocabulary (7 ops). The one op that invokes a function — `transform` — resolves a **name against a closed built-in registry** (`decodeHtmlEntities`, `lowercase`); config can *select* an allow-listed transform but never *define* one. This preserves the real security goal (no `eval`, no arbitrary execution on untrusted phase-2 config) without pretending pure data can express HTML-entity decoding or case-folding.
- Migrate the existing 4 sources to 4 built-in definitions + a generic engine, deleting the 4 hand-written adapters and the binding **match rules**. Producer-shape `normalize`/`recover` (GitHub reshape, Jira ADF→text + webUrl recover) **stays as code** — see §4.
- Produce output that is **byte-equivalent** to the current implementation (Reference output + prompt XML).
- Leave clean seams for phase 2 (runtime user extension): the merge point of the definition loader, and the "lenient parse / strict match" validation split.

### Non-goals (out of scope for this spec)
- Making the Envelope layer configurable (keep it as code; it's by AI agent, source-independent, only 2 implementations, and full of edge cases).
- A runtime user config entry point (`config.json` / settings UI loading user definitions) — phase 2.
- Regex ReDoS sandboxing/timeouts — phase 2.
- Collapsing `bindings/cli` (gh CLI command matching) — kept as-is in phase 1.

## 3. Decision record (from brainstorming)

| Decision point | Choice | Rationale |
|---|---|---|
| Who writes rules / when | Both, **in phases**: developer-internal declarative config first, leave a seam for runtime user extension | Collapse the existing 4 sources + quickly add official new ones first; user extension as a follow-up goal |
| Extraction expressiveness | **Closed DSL: 6 data ops + a `transform` op that names a closed built-in function registry** | Pure data can't express `decodeHtmlEntities` (find-replace with computed codepoints) or `.toLowerCase()`. A `transform` op selecting from an allow-listed registry keeps the security property (no `eval`; untrusted config can't define code) while staying expressive. Chosen over per-field boolean flags (fewer schema knobs) and over a general `fn` hook (that would break the no-arbitrary-code goal). |
| Producer normalize/recover | **Stays as code** (Codex `*Binding.normalize`/`recover`) | GitHub reshape / Jira ADF→text / Jira webUrl recover are producer-shape adaptation, envelope-adjacent (which is already a non-goal to configure). The DSL therefore only ever sees the normalized canonical payload, so array-of-object flatten etc. are out of DSL scope. |
| Prompt rendering | **Template strings in the config** (mediated by a slot vocabulary) | Verbatim preservation of existing prompt bytes (`<linear-issues>` etc.) + per-source controllable tags |
| Scope boundary | **Only source definitions are configurable**, Envelope stays as code | Clean, shippable scope |
| DSL engine | **Option A: closed op-pipeline DSL** | A closed vocabulary is exhaustively auditable, with no third-party dependency (fits the pure-ESM/bundle constraints) |

## 4. Architecture

```
                            ┌─────────────────────────────────────────┐
   transcript JSONL         │  SOURCE DEFINITIONS (declarative, data)   │
        │                   │  built-in: sources/definitions/*.ts (TS)  │
        ▼                   │  phase 2: user config.json (runtime JSON) │
  ① Envelope (code, same)   └───────────────┬─────────────────────────┘
        │                                   │ load + validate + merge
        │  NormalizedToolResult             ▼
        │  {payload, toolName, def}   ┌──────────────────────┐
        └────────────────────────────▶│  SourceEngine (code) │  ← one generic engine
                                       │  · match()           │  replaces bindings RULES
                                       │  · extractRef()      │  replaces 4×Adapter.extractRef
                                       │  · renderBlock()     │  replaces 4×renderPromptBlock
                                       │  · sanitizePath()    │  replaces the github-special branch
                                       └──────────┬───────────┘
                                                  ▼
                              Reference → ReferenceStore → assembleReferenceBlocks
                                          (storage / injection layers untouched)
```

### New components
- **`SourceDefinitionRegistry`** (code): loads built-in definitions at startup (phase 1: bundled TS constants; phase 2: merge user `config.json`), schema-validating each one. **Built-in definition validation failure = fail-fast**; **user definition validation failure = skip + WARN** (phase 2). Exposes `all()` (stable order), `match(agent, toolName, namespace)`, `byId(id)`.
- **`SourceEngine`** (code, pure functions): `extractRef(def, payload, toolName, at)`, `renderBlock(def, refs)`, `sanitizePath(def, nativeId)`. An op evaluator + a slot renderer.

### Deletions
- `LinearAdapter` / `JiraAdapter` / `GitHubAdapter` / `NotionAdapter` (along with each one's `renderPromptBlock`/`buildFields`/regexes)
- The `RULES` array in `bindings/claude` (prefix→sourceId match), and the **match-identity fields** of the 4 `*CodexBinding` (`namespaceSuffix` / `functionCallNames` / `invocationTools` / `canonicalToolName`) — these move into `def.match` + the registry.
- The github branch of `sanitizeNativeIdForPath`, and the hard-coded enum in `isSourceId`

### Deliberately kept / unchanged (sweep scope was a judged decision)
- **Producer normalize/recover as code**: the Codex bindings keep `normalize` (GitHub `reshapeGitHubIssue`, Jira `normalizeJira` ADF→text) and Jira's `recover` (webUrl salvage). Only their match-identity is deleted; the surviving `{ id, normalize, recover? }` is exposed via `getCodexNormalizer(id)`. Consequence: the DSL operates on the post-normalize canonical shape.
- `TranscriptEnvelopeParser` + `ClaudeEnvelopeParser` / `CodexEnvelopeParser` (envelope layer, orthogonal)
- `ReferenceExtractor.walkPayload` / `dedupeKeepLatest` (the driver is already generic; only the one line that calls the engine changes)
- `ReferenceStore`'s markdown read/write, the `Reference` / `ReferenceField` data model, orphan/folder storage, and `assembleReferenceBlocks`'s bucketed injection mechanism
- `bindings/cli` (gh CLI command matching) — kept independently in phase 1

## 5. Source definition schema (DSL)

A definition = one piece of structured data. **The op vocabulary is closed at 7** (6 pure-data ops + `transform`, which names a closed built-in registry):

| op | Semantics |
|---|---|
| `path` | Read a JSON path (`id`, `priority.name`) |
| `coalesce` | Take the first non-empty child-pipeline result |
| `regex` | Extract from a string input (capture groups; `extract` supports `$1/$2#$3` form) or validate. Option `lastMatch: true` runs the pattern global and takes the **last** match (Notion 32-hex page id). |
| `template` | Named sub-pipeline interpolation: `{owner}/{repo}#{number}` (any missing slot voids the result) |
| `join` | Array → string (separator `sep`) |
| `const` | Literal |
| `transform` | Apply a **named** function from the engine's closed `TRANSFORMS` registry to the threaded string. Phase-1 registry: `decodeHtmlEntities` (GitHub body), `lowercase` (Notion page id). An unknown name is rejected at load (fail-closed). This is the only op that runs a function, and the function set is not extensible by config — that is the security boundary. |

### Field production semantics
- `reference.<field>`: each field is produced by one `pipe` (an array of ops).
- `require` (regex): if the field value doesn't match → **the entire Reference is voided** (equivalent to the current `extractRef` returning `null`).
- `optional: true`: missing does not void (e.g. `description`).
- `guard` (optional, on `reference`): `{ pipe, equals }` — the whole Reference is voided unless `evalPipe(guard.pipe)` equals the literal. Used by Notion (`metadata.type === "page"`); databases/data-sources are rejected exactly as the current adapter does.
- `fields[]`: produces the opaque `Reference.fields[]` bag, each item `{key,label,icon,pipe}`; `key` is constrained by `^[\w-]+$`.

### Storage semantics
- `storage.nativeIdPathSafe`: `true` (linear/jira/notion, preserving the identity round-trip) goes through identity; `false` (github) goes through `[^\w.-]→-` + sha8. The `..`/`/\` guard **always** runs.

### Render semantics (slot vocabulary — the key trade-off)
Field attributes are variable-length and the description is an optional block, which a pure flat template can't express. So `render` uses a **fixed slot vocabulary**: the template controls tag names and layout, while the engine handles escaping + the field loop + the conditional description block.

Slots: `{nativeId}` `{title}` `{url}` `{fieldAttrs}` (engine renders `fields[]` as `key="escaped-val"`) `{descriptionBlock}` (engine renders `<description>…</description>` or empty). The 4 sources differ only in `wrapperTag` (linear-issues/jira-issues/github-issues/notion-pages) and `itemTag` (issue/page), which is enough to reproduce byte-equivalence. Structure outside the vocabulary → add a slot (a controlled core change, not a per-source change).

### Built-in definition example: Linear (flat source)
```jsonc
{
  "id": "linear", "label": "Linear", "icon": "circle-large-filled",
  "match": {
    "claude": { "prefixes": ["mcp__linear__", "mcp__claude_ai_Linear__"] },
    "codex":  { "namespaceSuffix": "linear", "tools": ["_fetch","_search"] }
  },
  "wrapperKeys": ["items","issues","nodes","results"],
  "reference": {
    "nativeId": { "pipe":[{"op":"path","path":"id"}], "require":"^[A-Z][A-Z0-9_]*-\\d+$" },
    "title":    { "pipe":[{"op":"path","path":"title"}], "require":".+" },
    "url":      { "pipe":[{"op":"path","path":"url"}],   "require":"^https?://" },
    "description": { "pipe":[{"op":"path","path":"description"}], "optional":true }
  },
  "fields": [
    { "key":"status","label":"Status","icon":"circle-large-filled","pipe":[{"op":"path","path":"status"}] },
    { "key":"priority","label":"Priority","icon":"flame",
      "pipe":[{"op":"coalesce","of":[[{"op":"path","path":"priority"}],[{"op":"path","path":"priority.name"}]]}] },
    { "key":"labels","label":"Labels","icon":"tag","pipe":[{"op":"path","path":"labels"},{"op":"join","sep":", "}] }
  ],
  "storage": { "nativeIdPathSafe": true },
  "render": { "wrapperTag":"linear-issues", "itemTag":"issue", "maxCharsPerReference":4000, "maxTotalChars":30000 }
}
```

### Built-in definition example: GitHub (the hardest — composite id + derived from URL)
```jsonc
// Operates on the POST-normalize shape (reshapeGitHubIssue output:
// { number, title, html_url, body, state, labels[], assignees[], repository:{full_name} }).
"reference": {
  "nativeId": {
    "pipe": [{"op":"template","template":"{owner}/{repo}#{number}","from":{
      "owner":  [{"op":"coalesce","of":[
        [{"op":"path","path":"repository.full_name"},{"op":"regex","pattern":"^([^/]+)/[^/]+$","extract":"$1"}],
        [{"op":"path","path":"html_url"},{"op":"regex","pattern":"github\\.com/([^/]+)/[^/]+/(?:issues|pull)/\\d+","extract":"$1"}] ]}],
      "repo":   [{"op":"coalesce","of":[
        [{"op":"path","path":"repository.full_name"},{"op":"regex","pattern":"^[^/]+/([^/]+)$","extract":"$1"}],
        [{"op":"path","path":"html_url"},{"op":"regex","pattern":"github\\.com/[^/]+/([^/]+)/(?:issues|pull)/\\d+","extract":"$1"}] ]}],
      "number": [{"op":"coalesce","of":[
        [{"op":"path","path":"number"}],
        [{"op":"path","path":"html_url"},{"op":"regex","pattern":"/(?:issues|pull)/(\\d+)","extract":"$1"}] ]}]
    }}],
    "require": "^[^/]+/[^/]+#\\d+$"
  },
  "description": { "pipe":[{"op":"path","path":"body"},{"op":"transform","fn":"decodeHtmlEntities"}], "optional":true }
},
"storage": { "nativeIdPathSafe": false }
```

Notion's page-id field shows the other two extensions — `regex.lastMatch` + `transform:"lowercase"`:
```jsonc
"guard": { "pipe":[{"op":"path","path":"metadata.type"}], "equals":"page" },
"nativeId": {
  "pipe": [
    {"op":"path","path":"url"},
    {"op":"regex","pattern":"[-/]([0-9a-fA-F]{32})(?=[/?#]|$)","lastMatch":true,"extract":"$1"},
    {"op":"transform","fn":"lowercase"}
  ],
  "require": "^[0-9a-fA-F]{32}$"
}
```

> **Implementation note (RESOLVED, see §11)**: the exact extraction behavior of the existing GitHub/Notion adapters (`GitHubNormalize`'s URL derivation, `NotionEnvelope` unwrapping, Jira key shape) was verified against source + real fixtures during planning; the 7-op vocabulary above covers all four. Golden parity tests backstop byte-equivalence (§9).

## 6. Data flow

```
Envelope parser (changed) ──▶ no longer consumes adapters[], now consumes registry.match() to get def
                              NormalizedToolResult carries def (replacing carrying adapter)
   │
   ▼
walkPayload (one line changed) ──▶ def.wrapperKeys recursion + SourceEngine.extractRef(def, …)
   │
   ▼
dedupeKeepLatest (unchanged) ──▶ ReferenceStore (sanitize via engine) ──▶ orphan/folder (unchanged)
   │
   ▼
assembleReferenceBlocks (changed) ──▶ registry.all() order + SourceEngine.renderBlock(def, refs)
```

The seam lands exactly at `NormalizedToolResult.adapter` ([`TranscriptEnvelopeParser.ts:55`](../../../cli/src/core/references/TranscriptEnvelopeParser.ts)): swapping `adapter: SourceAdapter` for `def: SourceDefinition` is an isomorphic replacement, and the driver only changes the one line calling `SourceEngine.extractRef(def,…)`.

## 7. Downstream ripples of opening up SourceId

`SourceId` goes from a closed union → `string` (the id of a registered source). Three downstream sites:

1. **Storage path safety** ([`ReferenceStore.ts:68`](../../../cli/src/core/references/ReferenceStore.ts)): `sanitizeNativeIdForPath` is generalized — `def.storage.nativeIdPathSafe===true` and passing the `..`/`/\` guard → identity; otherwise `[^\w.-]→-` + sha8. The guard always runs; the config is not trusted.

2. **Separate parsing stored data from matching new calls** (key detail): `isSourceId` ([`ReferenceStore.ts:314`](../../../cli/src/core/references/ReferenceStore.ts)) currently does double duty; split it into:
   - **Parsing orphan/folder historical markdown** → **lenient**: accept any non-empty, path-safe id. Otherwise, after a user deletes a definition, historical references would be discarded because their id is no longer "valid" = data loss.
   - **Matching new tool calls** → **strict**: must hit `registry.byId(id)`.

3. **VS Code panel source→icon/label**: currently mostly hard-coded. Change it to read from `def.label`/`def.icon`, which requires passing the definition (or a slim `{id,label,icon}` table) to the webview. **A touch point to locate and confirm when writing the plan** (the sidebar renderer, not QueueWorker).

## 8. Security (the DSL is phase 2's trust boundary)

| Surface | Strategy |
|---|---|
| No arbitrary code | 7 fixed ops, no `eval`. The only function-invoking op, `transform`, resolves a **name** against the engine's closed `TRANSFORMS` registry; config cannot define functions, only select allow-listed ones. Unknown name → rejected at load (fail-closed). Phase 2 load must re-validate `transform.fn ∈ Object.keys(TRANSFORMS)`. |
| Template injection | All slots are pre-escaped by the engine with the existing `escapeForAttr`/`escapeForText` ([`PromptXmlEscape`](../../../cli/src/core/PromptXmlEscape.ts)); the config never gets raw interpolation |
| `fields[].key` charset | `^[\w-]+$` guard, enforced twice — at **definition load time** and at **markdown parse time** |
| nativeId path traversal | The `..`/`/\` guard always runs inside `sanitizePath`, independent of `nativeIdPathSafe` |
| ReDoS | Phase 1 (built-in definitions) is low risk: inputs are truncated before `regex`/`require` + a pattern-length cap. **Phase 2 hardening**: user regexes run on a sandboxed path with a timeout |
| Payload depth bombs | `walkPayload` gets an explicit recursion depth cap (currently relies on try/catch to absorb `RangeError`) |
| Config bloat | Caps on op count per pipeline and on `coalesce`/`template` nesting depth, rejected at load time |

## 9. Testing (byte-equivalence is the de-risking backbone)

1. **Existing adapter tests as the oracle**: the parts of `LinearAdapter.test` / `ReferenceExtractor.test` / `CodexEnvelopeParser.test` that assert on Reference output and prompt XML **pass as-is** after being repointed at the new engine + definitions.
2. **Golden characterization tests**: before migrating, snapshot the current output of all 4 sources (Reference JSON + rendered block) as golden, then compare byte-for-byte after migration. Pin fixtures to **real files**.
3. **Engine unit tests**: each op in isolation; `coalesce` order, `template` missing variable, `regex` no-match, `require` void semantics.
4. **Registry tests**: valid load, built-in invalid → fail-fast, (phase 2) user invalid → skip+warn.
5. **Coverage**: hold 97/96/97/97 ([`cli/vite.config.ts`](../../../cli/vite.config.ts)); use `/* v8 ignore start/stop */` blocks for exemptions, and batch `npm run all` + commit into a single pass at the end.

## 10. Phased delivery

### Phase 1 (implemented by this spec)
- `SourceDefinitionRegistry` + `SourceEngine` + 7 ops + closed `TRANSFORMS` registry + the slot renderer
- 4 built-in definitions (`sources/definitions/*.ts` TS constants, sidestepping JSON import/bundle pitfalls and getting compile-time type checking)
- Migrate driver / envelope / store / assemble onto the engine
- Delete the 4 adapters + the binding **match rules** (keep Codex `normalize`/`recover` as code)
- Golden byte-equivalence green
- `bindings/cli` kept as-is
- `SourceId` internally opened but only built-in ids registered, **no user config entry point**

### Phase 2 (seams left, not implemented)
- `config.json` / settings UI loading user definitions
- Regex ReDoS hardening (RE2-style / worker timeout)
- Bad config skip + WARN; re-validate `transform.fn` against the closed `TRANSFORMS` registry on user load
- The registry's `load()` already leaves the merge point and the "lenient parse / strict match" validation split in place now

## 11. Resolved during planning (2026-07-06)
- **6-op sufficiency → NO; the vocabulary is 7.** Verified against source + real fixtures: Linear/Jira are pure-data; GitHub needs `transform:"decodeHtmlEntities"` (body) and Notion needs `regex.lastMatch` + `transform:"lowercase"` (page id). The `transform` op names a closed built-in registry — this is the "7th op" §5/§8 now document.
- **Producer normalize/recover stays as code**, so the DSL sees the normalized canonical payload; `flattenNamed`/reshape are out of DSL scope (§4).
- **VS Code panel touch points enumerated**: a slim `{id→label}` table (`SOURCE_TITLES` in `vscode/src/views/SourceLabels.ts`) already exists; still-hard-coded are the single-letter badges (`SidebarScriptBuilder.ts:2471,2885` — with a `G`/`GH` inconsistency to normalize; `NextMemoryScriptBuilder.ts:240`; `SummaryHtmlBuilder.ts:1159`), the tree codicon (`PlansTreeProvider.ts:358`), and per-source CSS colors (`SidebarCssBuilder.ts:1196`, `NextMemoryCssBuilder.ts:70`). Consolidated into one `SOURCE_META` table.
- **Notion render** differs only in `wrapperTag`/`itemTag` **plus** `bodyTag:"content"` and `fieldAttrs:false` (Notion renders only the `id` attribute); covered by the render spec's slot vocabulary.
