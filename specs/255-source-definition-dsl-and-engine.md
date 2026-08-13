# 255. Source-definition DSL and evaluation engine

## Topic Statement

Every external-reference source (Linear, Jira, GitHub, Notion, Slack, and any future source) is described by a purely declarative, data-only definition: a small set of extraction "pipes" over an already-parsed tool-result payload, plus render metadata. A single pure engine evaluates any such definition — building a normalized reference record and rendering a prompt-XML block — with no source-specific code anywhere in the engine. The only place a definition may name executable code is a closed, allow-listed transform registry; a definition can select a transform by name but can never supply one, which is the security boundary that lets untrusted (future, user-authored) definitions be evaluated safely. A structural validator with resource caps and a fail-fast built-in loader front the engine.

## Scope

**In scope:**

- The closed op vocabulary (seven ops) that a pipe is built from, and the exact evaluation semantics of each.
- The pipe evaluation model: how a value is threaded op-to-op, and the "first op reads the root payload, later ops read the threaded value" rule.
- The field-spec model: a pipe plus an optional match-constraint (`require`) with optional flags, plus an `optional` flag; and the reference-level `guard` field that reuses the same field-spec mechanism as a pre-extraction gate.
- Reference extraction from one payload object: guard evaluation, the required/optional core fields, the opaque display-field bag, and the assembled record shape (including its registry map key).
- The fact that the destination-link field-spec is itself **optional at the definition level** (a definition may declare none at all), and the three distinct link outcomes that follow from that.
- Prompt-block rendering: per-record XML emission, attribute-vs-text escaping, the per-reference body truncation cue, and the block-level budget selection algorithm.
- The closed transform registry as a security boundary, including the own-key membership check that rejects prototype-chain names.
- The compiled-pattern cache used by the regex op and the `require` constraint.
- Structural validation of a candidate definition: required keys, the display-field key charset, the per-pipe op-count cap, and the coalesce/template nesting-depth cap.
- The optional top-level consumer fields a definition may declare — track-only, arguments-derived and accumulate-body (each a boolean), plus a title-fallback pattern (a string) — their declared meaning, the fact that the engine never acts on any of them, and the fact that the validator checks exactly one of them: the title-fallback pattern.
- The process-wide registry singleton built once from the built-in definitions, and its fail-fast behavior on an invalid built-in.
- The documented (but not-yet-implemented) seam for loading user-authored definitions from durable state.

**Boundaries:**

- This spec does NOT enumerate the built-in source definitions themselves — the per-source pipes, field sets, match rules, render tags, and budgets. That catalog is spec 154.
- This spec does NOT cover how a tool call is recognized as belonging to a given definition (prefix / suffix / namespace / invocation-tool matching). That identity resolution is spec 153 (with the match-rule data shape described there).
- This spec does NOT cover how a transcript is read, how tool-call/result pairs are extracted, or how the payload tree is walked into a definition's wrapper keys. Those are spec 153.
- This spec does NOT cover on-disk persistence of an extracted record, path-safety of the native id, or the registry's role in that path-safety decision. Those are spec 179.
- This spec does NOT cover the concrete behavior of any individual transform beyond its role as a selectable, allow-listed function. The two shipped transforms (HTML-entity decode; ASCII lowercase) are described where their sources use them — see spec 154.

## Data Contracts

### Op — the closed extraction vocabulary

A pipe is an ordered list of ops. There are exactly seven op kinds; no others are recognized:

- **path** — carries a dotted path string. Reads that path from an object.
- **coalesce** — carries an ordered list of sub-pipes (`of`). Returns the first sub-pipe result that is a non-empty string.
- **regex** — carries a pattern string, an optional `extract` template string, and an optional `lastMatch` boolean. Matches the pattern against the threaded value and yields a captured/extracted substring.
- **template** — carries a template string with `{name}` placeholders and a map (`from`) of placeholder-name → sub-pipe. Substitutes each placeholder with its sub-pipe's evaluated value.
- **join** — carries a separator string. Joins an array-valued threaded input.
- **const** — carries a literal string value. Ignores input and yields the literal.
- **transform** — carries a transform name string (`fn`). Applies the named allow-listed transform to the threaded value.

### Pipe

An ordered list of ops that produces at most one value from a payload (or from a value threaded in from a preceding op). Evaluating a pipe yields either a display string or "nothing" (an absent value).

### Field-spec

The predicate mechanism every extracted field uses:

- **pipe** — the pipe that produces the field's raw value.
- **require** (optional) — a pattern string the produced value MUST match; a non-match voids the entire reference (unless the field is `optional`, in which case a produced-but-non-matching value is treated as a void of the whole reference regardless — see Behavior).
- **requireFlags** (optional) — flags applied to the `require` pattern (e.g. case-insensitive matching for a host allow-list).
- **optional** (optional boolean) — when true, a missing/empty produced value is dropped (the field is simply absent) instead of voiding the reference.

### Reference guard

An optional field-spec attached at the reference level, evaluated before any other field. If the guard produces no value (or fails its `require`), the whole reference is voided. It is the ordinary field-spec predicate — an exact-match gate is expressed as a pipe plus a `require` anchored to the exact string, not as a bespoke equality op.

### Display-field spec (the opaque bag)

Each entry in a definition's display-field list carries:

- **key** — a stable identifier constrained to word characters and hyphens (`[\w-]+`). It doubles as the persisted frontmatter key and the prompt XML attribute name.
- **label** — a human-readable label.
- **icon** (optional) — an icon identifier.
- **pipe** — the pipe producing the field's value.

An entry contributes to the record only when its pipe yields a non-empty value.

### Render spec

- **wrapperTag** / **itemTag** — the outer block tag and the per-record element tag.
- **bodyTag** — the element name wrapping the description body (e.g. a "description" vs "content" element).
- **fieldAttrs** (optional, default true) — when false, display-field entries are NOT emitted as per-record attributes.
- **maxCharsPerReference** — per-record body truncation cap.
- **maxTotalChars** — per-block aggregate character budget.

### Storage spec

- **nativeIdPathSafe** (boolean) — declares whether the source's native id is itself filesystem-path-safe. Consumed by the persistence layer (spec 179), not by the engine.

### Source definition (aggregate)

A source definition bundles: a string **id**, a **label**, an **icon**, a **match** block (spec 153), an ordered **wrapperKeys** list (spec 153's payload walk), a **reference** block (the core field-specs: nativeId, title, an **optional** destination-link spec, optional description, optional guard), the **display-field** list, a **storage** spec, a **render** spec, and the optional top-level consumer fields (below). It contains no functions; the only reference to code is a transform name inside a `transform` op, resolved against the closed registry.

Only the nativeId and title field-specs are structurally mandatory. The destination-link spec is **absent** for a source whose referenced system has no external destination at all; that is deliberately a different state from a declared spec that fails to produce a value, and the two are not collapsed (see "Reference extraction from one payload object").

### Consumer fields (engine-inert)

Four optional top-level members sit alongside the blocks above — three booleans and one string. None is read by the engine; each exists purely to be read by a specific downstream consumer:

- **trackOnly** (optional boolean) — declares that references from this source are kept as background context only. Read by the two prompt-block builders (the commit-summarization block assembly of spec 12 and its regeneration counterpart), which skip a track-only definition entirely, and by the AI-relevance stage (spec 258), which removes track-only references from the ranker's input and splices them back unconditionally. Read nowhere else: it does not gate extraction, persistence, archival, display, or any user-facing exclusion control.
- **argumentsDerived** (optional boolean) — declares that this source's reference is built from the tool call's *arguments* rather than from the tool's returned payload. Read only by the per-producer envelope parsers (spec 153), which — on a failure to parse the result payload as JSON — supply an empty payload object to the source's normalizer instead of warning and dropping the call.
- **accumulateBody** (optional boolean) — declares that this source's identity is an **act** rather than an entity, so several extracted records sharing one map key must have their descriptions **merged** rather than the newest overwriting the rest. The default (newest-overwrites) is right for an entity — two fetches of the same ticket describe one ticket, and the later read wins — and wrong for an act, where two different recorded acts are two different facts. Read by three consumers, none of them the engine: the extraction pipeline's cross-record collapse (spec 153), which merges instead of discarding and additionally lifts each body into a timestamped entry line; the persistence layer's write (spec 179), which folds the body already on disk into the incoming record; and the newest-entry read-back helper the display surfaces call (specs 179, 187), which returns nothing at all for a non-accumulating source.

- **titleFallbackPattern** (optional **string**, not a boolean) — a pattern naming the title this source *synthesizes* when the out-of-band lookup that would have supplied the real one missed. It is the only consumer field the engine's validator inspects (below), and the only one whose absence versus presence is not a two-state boolean question. Read at two collapse points, neither of them the engine: the persistence layer's write, which compares an incoming record against the file already on disk (spec 179), and the extraction pipeline's same-key dedupe, which compares two records from one scan (spec 153). Both apply one shared predicate — the incoming title matches the pattern **and** the superseded one does not — and on a hit restore the superseded record's **title, destination link, display fields and body** together, the body being exempt for a source that also declares accumulate-body. Testing only the incoming title would pin the first title forever; testing only the superseded one would block a genuine rename.

The track-only and arguments-derived flags are also read by the persistence layer's note-emission decision (spec 179), which appends an explanatory note to a reference's on-disk markdown when its registered definition declares either one. Neither the accumulate-body flag nor the title-fallback pattern participates in that decision.

Every consumer of the three **boolean** fields tests for an exact `true` — including all three of the accumulate-body consumers, which either compare to `true` or take their non-accumulating branch on anything that is not exactly `true`. Any other value — including a truthy non-boolean — behaves exactly as if the flag were absent. That guarantee does not extend to the string-valued title-fallback pattern, whose consumers compile and test it: an inert non-string value there is not a possible state, which is why it is the one consumer field the validator gates.

### Transform registry

A closed, allow-listed map of transform-name → single-argument string function. Exactly two transforms ship: an HTML-entity decoder and an ASCII lowercaser (their behavior belongs to spec 154 / their source usages). The set of valid transform names is the map's own enumerable keys only.

### Produced reference record

The engine emits the in-memory reference record shape shared across the whole reference subsystem (see spec 153 for the field list): a registry map key of the form `<id>:<nativeId>`, the source id, native id, title, an optional url, an optional description, an optional display-field list, the tool name, and the referenced-at timestamp. The map key carries no short-hash suffix at this layer.

## Behavior

### Pipe evaluation (op-by-op)

A pipe is evaluated left to right, threading one intermediate value from each op to the next. The intermediate starts as "nothing." A boolean "is this the first op" is tracked and consumed only by the `path` op.

Per-op semantics, in the order a maintainer would reason about them:

- **path** — If this is the first op in the pipe, read the dotted path from the **root payload**; otherwise read it from the **threaded value**. Traversal walks each dot segment; encountering a non-object at any segment yields "nothing." The raw value at the path is returned as-is (it may be a string, number, array, or object). *Surprising and load-bearing:* a `path` op that is NOT first reads the threaded value, so a `path` following an op that produced "nothing" stays "nothing" — it does not silently fall back to re-reading the root payload.
- **const** — Yields its literal string, ignoring input.
- **coalesce** — Evaluates each sub-pipe against the **root payload** (not the threaded value), in order, taking the raw (uncoerced) result. A sub-pipe is considered "found" only when it yields a **non-empty string**. Every other outcome falls through to the next sub-pipe: an object result falls through (so a later sub-pipe can read a sub-field of it, e.g. read `priority` then `priority.name`), and a non-string scalar such as a number or boolean falls through (so a bare numeric priority/milestone/type is dropped rather than shown). If no sub-pipe yields a non-empty string, the op yields "nothing."
- **join** — If the threaded input is not an array, yields "nothing." Otherwise keeps only its non-empty string elements and joins them with the separator; an empty survivor set yields "nothing."
- **template** — Evaluates each placeholder's sub-pipe against the **root payload**, coercing each to a display string. If **any** placeholder resolves to "nothing," the whole template yields "nothing" (all-or-nothing). Otherwise substitutes each `{name}` with its value.
- **regex** — Coerces the threaded input to a scalar string (see coercion below); "nothing" in → "nothing" out. With `lastMatch` set, scans all global matches and keeps the last; otherwise takes the first match. With an `extract` template, expands `$n` references to capture groups (missing groups → empty string); without `extract`, yields the first capture group if present, else the whole match. Same capture-vs-whole-match rule for both the first-match and last-match branches.
- **transform** — Rejects a name that is not an own key of the transform registry by raising (this is the security boundary; a prototype-chain name such as a built-in object method name is not a member and is rejected). Coerces the threaded input to a scalar string; "nothing" in → "nothing" out; otherwise applies the named function.

Scalar coercion: a non-empty string stays itself; a finite number becomes its decimal string; everything else (empty string, non-finite number, boolean, object, array, absent) becomes "nothing."

Final pipe result: after the last op, the threaded value is coerced to a display string — a non-empty string stays, an empty string becomes "nothing," a finite number becomes its decimal string, anything else becomes "nothing."

### Field-spec evaluation

1. Evaluate the field's pipe.
2. If the result is absent or the empty string: if the field is `optional`, the field is present-but-undefined (dropped, not a void); otherwise the field is a **void** — the whole reference fails.
3. If a `require` pattern is set, test the produced value against it (with `requireFlags` if given). A cached pattern's scan position is reset before each test so a globally-flagged cached pattern cannot carry match state across calls. A non-match is a **void**.

### Reference extraction from one payload object

Given a definition and one already-parsed payload object:

1. If the payload is not a plain object, produce no reference.
2. If the definition declares a `guard`, evaluate it; if it voids or produces nothing, produce no reference.
3. Evaluate the `nativeId` and `title` field-specs, and the destination-link field-spec **only when the definition declares one**. If any evaluated spec voids, produce no reference. If `nativeId` or `title` produced nothing, produce no reference.

   There are exactly **three** link outcomes, and they are deliberately distinct:
   - **No link spec declared** — nothing is evaluated, no link is attached to the record, and no void is possible. The source has no external destination, so there is no link to fail at.
   - **A declared spec that voids** (required-but-missing, or produced a value failing its `require`) — no reference at all. The link was supposed to exist and could not be established, and a record whose destination cannot be reached is judged worth nothing.
   - **A declared `optional` spec that yields nothing** — a reference *is* produced, carrying no link.

   The pair that must not be collapsed is the first and the second: one produces a record and the other produces none, and only the definition says which case a source is in. The first and third are, by contrast, indistinguishable from the produced record alone — both simply leave its link absent — and that is harmless, because the one consumer decision that depends on a link (whether to offer an open-in-browser affordance) keys on the record's link being present rather than on why it is not (spec 187).
4. Evaluate the optional `description` field-spec if present; a void there produces no reference.
5. Evaluate each display-field entry's pipe; include only those yielding a non-empty value, preserving definition order; carry each entry's key, label, value, and optional icon.
6. Assemble the record: map key `<id>:<nativeId>`, the source id, native id, title, and the tool name + referenced-at echoed through verbatim. Include url, description, and the display-field list only when non-absent / non-empty.

### Prompt-block rendering

Per-record rendering:

- Opening element: `<itemTag id="<escaped-nativeId>"…>`. When the render spec's `fieldAttrs` is not false, each display-field entry contributes one attribute `key="<escaped-value>"` in record order after `id`.
- A title element wrapping the escaped title.
- A url element wrapping the escaped url — emitted only when the record carries a non-empty url.
- When the record carries a non-empty description: a `bodyTag` open line, the escaped body **truncated to `maxCharsPerReference`** on its own line, then a `bodyTag` close line.
- The closing `itemTag`.

Two distinct escaping contexts are used: an **attribute context** that escapes `&`, `<`, `>`, the double-quote, and the apostrophe; and a **text context** (title, url, body) that escapes `&`, `<`, `>` but leaves quotes intact. (Same escaping contract shared with the render surface in spec 154.)

Body truncation cue: when a body exceeds the per-reference cap, the first `cap` characters are kept, followed by a newline and the literal marker `…[truncated, N more chars]`, where N is the number of dropped characters. The cue is a single shared wire format (also used by the regenerate path).

Block selection algorithm (the notable/changed part):

1. Empty input list → empty string.
2. Sort the records ascending by referenced-at (string compare), then reverse to newest-first.
3. Walk newest-first, rendering each record **once** and keeping the rendered string. Maintain a running total of rendered lengths. **Admit** a candidate iff running-total + its length ≤ `maxTotalChars`. A candidate that would exceed the budget is **skipped** (the walk continues to the next, smaller/older candidate) — it does NOT stop the walk. *This is a deliberate change from the earlier behavior, which stopped at the first over-budget candidate; now one large newest record cannot starve smaller older records that still fit.*
4. If nothing was admitted → empty string.
5. Reverse the admitted set back to oldest-first, join the already-rendered strings with newlines (a **single** render pass — records are not re-rendered), and wrap in `<wrapperTag>…</wrapperTag>`.

### Compiled-pattern cache

Every pattern used by a `regex` op or a `require` constraint is compiled once and cached, keyed by a flags+pattern composite that cannot be spoofed by pattern content. The engine is invoked once per payload node during extraction, so caching avoids recompiling static definition patterns on every node.

### Structural validation of a definition

A validator gates any candidate definition (built-in today; user-authored in the future seam):

- The candidate must be a plain object with a non-empty string id, non-empty label, non-empty icon, an object `match`, an array `wrapperKeys`, an object `reference`, an array display-field list, an object `storage`, and an object `render`.
- The `reference` block must carry object field-specs for **nativeId and title only**; each such pipe is validated. The destination-link spec, the description spec, and the guard spec are each validated **only when present** — each must then be an object field-spec whose pipe validates, exactly like any other pipe. An **absent** link spec is accepted without comment; the validator makes no attempt to decide whether a source ought to have one.
- A declared-but-unsatisfiable link spec is **not** a validation concern. Whether a pipe can actually produce a value depends on the payload, so voiding on it is the extraction step's job, not the validator's.
- Each display-field entry must be an object whose key matches `[\w-]+`, whose label is a non-empty string, and whose pipe validates.
- **Pipe validation** walks every op: each op must be an object naming one of the seven kinds; kind-specific required members must be present and correctly typed; a `transform` op's name must be an own key of the transform registry; `coalesce`/`template` sub-pipes recurse.
- **Op-count cap:** each top-level pipe field gets a fresh budget; the total op count (including all nested sub-pipe ops) may not exceed 64.
- **Nesting-depth cap:** each `coalesce`/`template` step adds one depth level; depth may not exceed 8. The two caps are tracked separately so a wide-but-shallow pipe and a narrow-but-deep pipe each fail for the right reason.
- The validator does not (yet) deep-check `match`/`storage`/`render` beyond presence; those are internal wiring for built-ins today.
- The validator does **not** check the three optional consumer **booleans** at all — neither their presence nor their type. A definition carrying a non-boolean value under any of those names passes validation unnoticed. This is tolerable only because every consumer tests for an exact `true`, so a non-`true` value is inert; it is not a type guarantee.
- The **title-fallback pattern is the one consumer field the validator does check**, and it checks it twice: when declared, it must be a non-empty string, and it must compile as a pattern. Either failure refuses the definition — which for a built-in means a failure at load time. Compiling it here rather than at first use is deliberate: unlike a `require` pattern, this one is consulted on the **write** path, inside the lock the persistence layer holds while writing a reference the extractor has already accepted, so a definition that failed to compile there would throw mid-persist rather than at registration.

### Registry construction (fail-fast for built-ins)

The process-wide registry is built once, lazily, from the built-in definition list. Each built-in is run through the validator; an invalid built-in **throws** (fail-fast) rather than being silently dropped, because a built-in is first-party code and an invalid one is a bug in the product, not untrusted input. The validated definitions become the singleton, which answers identity lookups (spec 153) and by-id lookups.

### Phase-2 user-definition loading (documented seam — NOT implemented)

The design reserves a future path that would read user-authored definitions from durable state, run each through the same validator, and — **unlike** the fail-fast built-in load — **skip** (with a warning) any definition that fails, re-validating each `transform` name against the same closed registry so untrusted config could still only name an allow-listed transform and never define one. **This path is described in comments only and is not implemented; no code loads, validates, or registers user-authored definitions today.** It is specified here solely as the intended extension seam and MUST be treated as unreachable until built.

## State Transitions

The engine is otherwise pure: extraction and rendering are functions of (definition, input) with no side effects. Two process-level pieces of state exist:

- The compiled-pattern cache — a monotonically growing memo; it never evicts and never changes an evaluation's result (only its cost).
- The registry singleton — built exactly once on first use and thereafter immutable for the process lifetime.

## Notable Behavior

- **`coalesce` falls through numbers and booleans.** A bare numeric field (e.g. a numeric priority) is intentionally dropped, not shown; only a non-empty string counts as "found." This preserves the pre-DSL adapters' "string-or-`{name}`" reading of priority/status/milestone/type.
- **`coalesce`/`template` sub-pipes read the root payload, not the threaded value.** They branch out from the payload independently of where they sit in an enclosing pipe.
- **A non-first `path` reads the threaded value.** This is the deliberate fix for a class of bug where a `path` after a `coalesce`/other op that produced nothing would otherwise re-read the root and pull a value from the wrong object.
- **`template` is all-or-nothing.** Any missing placeholder voids the whole templated value; there is no partial substitution.
- **The block budget SKIPS an over-budget candidate rather than stopping.** Changed behavior: a large newest record is skipped and smaller older records that still fit are still admitted. Emission is a single render pass (records are rendered once, kept, and reused), not the earlier two-pass render.
- **The transform registry is a closed security boundary enforced by an own-key membership test.** A definition can only *name* a transform; naming a non-member (including any prototype-chain name) is rejected — at validation time and again defensively at evaluation time.
- **Built-in load is fail-fast; the (future) user-definition load is skip-with-warn.** The asymmetry is intentional: a broken built-in is a product bug that must surface loudly; a broken user definition must never take down valid ones.
- **Resource caps make a definition's evaluation cost bounded.** The op-count and nesting-depth caps bound the work any single pipe can require, which matters once untrusted definitions are admitted.
- **A cached, globally-flagged pattern's scan position is reset before each `require` test.** Without this, a reused compiled pattern with the global flag would carry match state across references and intermittently fail.
- **Empty selection yields an empty string, not an empty wrapper.** A block whose every candidate is over budget (or whose input is empty) contributes nothing, so a caller can skip writing an empty wrapper.
- **Every declared consumer member is engine-inert.** The engine records `storage.nativeIdPathSafe`, the track-only / arguments-derived / accumulate-body flags, and the title-fallback pattern, and never acts on any of them: extraction, pipe evaluation, and render all behave identically whether they are set or absent. Each is read by a specific class of downstream consumer — the path-safety flag by the persistence layer (spec 179), the track-only flag by the prompt-block builders (spec 12) and the relevance ranker (spec 258), the arguments-derived flag by the envelope parsers (spec 153), the accumulate-body flag by the extraction pipeline's record collapse (spec 153), the persistence layer's write and its newest-entry read-back helper (spec 179), and the display surfaces that call that helper (spec 187), the title-fallback pattern by the persistence layer's write and the extraction pipeline's same-key dedupe (specs 179, 153) — plus the persistence layer's note-emission decision, which reads the track-only and arguments-derived flags (spec 179).
- **The validator ignores the three consumer booleans entirely and gates the title-fallback pattern.** Unlike every block it does check, no boolean flag is validated for presence or type; safety there comes only from every consumer requiring an exact `true`, which makes any other value inert rather than misinterpreted. The pattern is the exception, and for a reason specific to it: its consumers must compile it, so an inert value is not among its possible states — a non-string or an uncompilable one refuses the definition at registration instead.
- **An absent destination-link spec and an unsatisfied one are different outcomes, and only the definition distinguishes them.** Both leave the produced record without a link, but the first produces a record and the second produces nothing. Structural validation accepts the absence silently, so nothing warns a definition author who forgot a link spec they meant to declare — such a source simply extracts records with no link.
- **A track-only source's render spec is declared but unreachable.** Because both prompt-block builders skip a track-only definition before any rendering happens, such a definition's render tags, field-attribute toggle, and both character budgets are never exercised by any reachable code path. The engine will still render them if handed the definition directly, but nothing in the product does.

## Shared Behavior

- **The catalog of concrete source definitions** — each source's pipes, field sets, match rules, wrapper keys, render tags, budgets, the two transforms, and which sources declare each of the consumer fields above — is spec 154.
- **Identity resolution** (which definition owns a given tool call, via prefix/suffix/namespace/invocation-tool matching held in the `match` block) is spec 153. The registry singleton built here is the object that answers those lookups. Two further per-definition match gates now live in that contract and are documented there, not here: an **exact tool-name allow-list** narrowing a prefix match to a closed set, and a **server pin** scoping the no-namespace lookup to the server the producer's event reported. Like every other part of the `match` block, both are opaque to the engine and unchecked by the validator.
- **Transcript reading, tool-call/result pairing, and the wrapper-key payload walk** that feeds the engine one payload object at a time are spec 153.
- **On-disk persistence, native-id path-safety (driven by `storage.nativeIdPathSafe`), and the strict-vs-lenient source-id checks** are spec 179.
- **The produced reference record shape** and its downstream registry/commit-snapshot lifecycle are specs 153 and the summary-storage specs (01–06).
