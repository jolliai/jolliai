# 12. Multi-Topic Commit Summary Generation

## Topic Statement
Generate a structured summary of a single commit by combining the captured conversation context, the commit's diff, and the commit metadata into one LLM call whose response is a delimited plain-text document carrying zero or more topic blocks plus optional top-level fields.

## Scope
**In scope:**
- Inputs and how they are assembled into the prompt for one summarization call.
- The delimited plain-text response format the LLM is instructed to produce.
- The recognized top-level markers and the recognized per-topic field markers.
- How the response is parsed into a topic list plus optional ticket identifier and recap paragraph.
- The single-shot retry triggered when the response fails a format-compliance check.
- The post-parse filter that drops topics whose decisions field is empty or a placeholder.
- The default model selection, alias-to-full-id resolution, and the maximum-output-tokens budget.
- The product-ticket extraction pattern and its canonical-uppercase normalization.
- The topic-count guidance embedded in the prompt and the absence of any caller-side bucketing.
- Validation and normalization of optional per-topic fields (todo, files-affected, category, importance).

**Out of scope (boundaries):**
- The post-LLM diff that is applied for amend operations (covered by amend pipeline specs).
- The N-source consolidation pipeline used during squash and squash-rebase (covered by "Squash Consolidation Summary").
- The standalone recap-only regeneration path (covered by "Recap Paragraph Generation").
- Generation of E2E test scenarios from an already-summarized commit.
- The hook plumbing that reaches this generator (queue worker, transcript reader, plan detection).
- Storage of the resulting summary on the parallel ref.
- Credential resolution and origin-allowlist enforcement.

## Data Contracts

### Input parameters
A single object carrying:
- `conversation`: a single string assembled from one or more session transcripts, in chronological order, joined into a multi-session textual context.
- `diff`: the textual unified diff for the commit.
- The pre-assembled CONTEXT blocks, each a rendered string substituted inline into the prompt: a **plans** block, a **notes** block, and a **references** block. These arrive **already ordered by relevance** and **already filtered** by an upstream AI-relevance stage (see "AI context-relevance filter stage" and [258 — AI Context-Relevance Filtering]); this generator neither ranks nor filters them — it renders whatever it is handed. Empty strings are legitimate (no context, or all context filtered out). The references block in particular can be empty even when references *were* kept for this commit: every reference from a **track-only** source is omitted from the block by construction (see "Track-only sources" below), so a commit whose only kept references are track-only hands this generator an empty references block.
- `commitInfo`: an object with `hash`, `message`, `author`, `date`.
- `diffStats`: an object with `filesChanged`, `insertions`, `deletions`. Carried through to the result; not used to alter the prompt.
- `transcriptEntries`: integer count of transcript entries fed in. Carried through to the result.
- `conversationTurns`: optional integer count of human-role entries.
- `config`: LLM credentials (direct API key and/or proxy key) plus an optional model selector (alias or full id).

### Result
An object spread onto the persisted summary, containing:
- `transcriptEntries`, optional `conversationTurns`: copied from input.
- `llm`: a metadata block with the model identifier actually used, input/output token counts, total API latency in milliseconds, and a stop-reason string (or null). When the format-retry branch fires, the input/output token counts and the latency are summed across both calls; the model identifier and stop-reason are taken from the retry call.
- `stats`: copied from input `diffStats`.
- `topics`: an ordered list of topic objects (possibly empty).
- `ticketId`: optional canonical-uppercase product-ticket string.
- `recap`: optional recap paragraph(s).

### Soft-excluded context field on the stored summary

The persisted commit summary additionally carries an optional **excluded-context** list. It is **not** part of this generator's own result object — it is populated by the surrounding pipeline from the AI-relevance stage's output and spread onto the stored summary alongside the generator's result. Each entry records one CONTEXT item the relevance ranker judged unrelated and kept OUT of the prompt:

- **kind**: `plan` / `note` / `reference`.
- **key**: the plan slug, note id, or `<source>:<nativeId>` reference key.
- **title**: a human label.
- **reason**: the ranker's one-line explanation.
- **tier**: the lowest relevance band (present on the recompute path; may be absent on the fingerprint-reuse path — see [258]).

The field is written only when non-empty. It is a **traceability record** ("the AI excluded N items, and why"), distinct from user manual excludes — which are skipped from association but never stored. Soft-excluded plans/notes are also handled specially by archival (see [42], [43]).

### Kept-item relevance field on the stored summary

The persisted commit summary additionally carries an optional **kept-item relevance** list, complementary to the excluded-context list above. Like it, this field is **not** part of the generator's own result object — the surrounding pipeline populates it from the AI-relevance stage's per-item output and spreads it onto the stored summary. Each entry records one KEPT CONTEXT item's relevance verdict:

- **kind**: `plan` / `note` / `reference`.
- **key**: the plan slug, note id, or `<source>:<nativeId>` reference key (the working-area identity — not any archived, hash-suffixed variant).
- **tier**: one of `high` / `mid` / `low`.
- **reason**: the ranker's one-line explanation of how the item relates to this change.

The field is written only when non-empty. Only kept items with a **non-empty** reason are included — the fail-open keep-all path and per-item model omissions produce empty reasons and are dropped, so a summary generated without a real ranking (no context, fail-open, or a fingerprint-reuse from a selection file predating this feature) simply has no per-item relevance and the display layers fall back to plain title rows. Together, the excluded-context list (soft-excluded items) and this kept-item relevance list preserve the full relevance picture the pre-commit panel showed. The projection semantics — which items qualify, why empty reasons are dropped, and how it is rebuilt on the fingerprint-reuse path — are owned by [258 — AI Context-Relevance Filtering]. Like excluded-context, this is a per-commit field (each commit states its own judgment).

### Topic object
A topic has the required string fields:
- `title`: short scannable label.
- `trigger`: the user problem or need that prompted this work.
- `response`: the technical changes made.
- `decisions`: design choices and rationale.

And the optional fields:
- `todo`: deferred work or follow-up items.
- `filesAffected`: an ordered, de-duplicated list of file paths, capped at five entries; surplus entries are silently dropped.
- `category`: one of a fixed enumeration: feature, bugfix, refactor, tech-debt, performance, security, test, docs, ux, devops. Anything else is dropped.
- `importance`: one of major, minor. Anything else is dropped.

### Default model alias and resolution
- Default alias when the config supplies no model: a fixed three-letter alias for the mid-tier model.
- A built-in alias map resolves the three short aliases (haiku-tier, sonnet-tier, opus-tier) to vendor model identifiers; unknown values are passed through unchanged for forward compatibility.

### Output-token budget
A fixed default ceiling per call, set high enough to accommodate the upper end of the topic-count range without truncation. Cost is consumption-based; the ceiling is not the billing target.

### Top-level response shape
The LLM is instructed to produce, in this order:
1. A fixed sentinel marker line that opens the structured response.
2. An optional ticket-id top-level field (its own marker on its own line, then a single line of content).
3. Zero or more topic blocks, each opened by a topic delimiter line.
4. An optional recap top-level field (marker on its own line, then one or more paragraphs of content), placed AFTER the last topic block.

Within a topic block, fields appear in any order, each opened by a per-field marker line on its own line, followed by free multi-line content until the next marker. Recognized per-topic field marker names form a fixed set (title, trigger, response, decisions, todo, files-affected, category, importance).

A topic delimiter is recognized only when it appears on its own line. Mentions of the literal marker inside backticks or prose do not split topics.

The known top-level markers form a closed set: the opening sentinel, the topic delimiter, the ticket-id field marker, and the recap field marker. Any new top-level field requires coordinated edits in five places (the marker set, the prompt rules and example, the parser's top-level scanner, the result type, and every renderer that displays summaries).

### Format compliance
The first non-blank line of the LLM's output must start with the opening sentinel or be exactly one of the other top-level marker lines. An empty trimmed response is also compliant (it represents a deliberate "trivial commit, nothing substantive to record" outcome). Any other first-line content is non-compliant and triggers the strict retry.

### Ticket-extraction pattern
A regex matching the form `<2+ uppercase-or-alphanumeric chars starting with a letter>-<digits>` (e.g. PROJ-123, FEAT-45, JOLLI-7890). The first match in the searched text is normalized to uppercase. This is used as a fallback ticket source by callers and as the same regex is applied to the squash commit message in the squash pipeline.

## Behavior

### AI context-relevance filter stage (upstream of this generator)

Before this generator is called, the pipeline shapes the CONTEXT blocks in a fixed order of stages:

1. **User hard-exclude application.** The active plans / notes / references are filtered against the user's manual exclude set (spec 188). Hard-excluded items are removed unconditionally.
2. **Track-only split.** The user-kept set is partitioned before the ranker sees it: every reference whose source declares itself **track-only** is lifted out into a separate set and is **not** offered to the relevance ranker at all. Everything else forms the ranker's candidate list.
3. **AI relevance filter.** The remaining candidates are passed to the relevance ranker (spec 258), which returns the kept candidates **in relevance-ranked order** (most relevant first) plus a soft-excluded set. On a change-fingerprint match the panel's persisted ranking is reused; otherwise the ranker recomputes. This stage is fail-open — any failure keeps the full candidate set and excludes nothing.
4. **Track-only splice-back.** The track-only set from step 2 is added back into the kept references **unconditionally** — no verdict, no tier, no reason. This is the whole point of the split: a relevance verdict must never be able to drop a track-only reference from archival.
5. **Prompt-block assembly.** The kept items — in the ranker's order — are rendered into the plans / notes / references blocks handed to this generator. Because the order is relevance-ranked, any per-block budget truncation drops the **least** relevant items, not the oldest.

Both the split and the splice-back run identically on the standard commit path and on the amend path.

### Track-only sources

A reference source may declare itself **track-only** (the flag is contractually owned by the source-definition spec; which source declares it is the built-in-source catalog's concern). Such a reference is kept as background context but is deliberately withheld from the summarization LLM. Two independent, separately-observable effects follow:

1. **It never reaches the prompt.** The block-assembly step iterates the registered source definitions and **skips every track-only definition outright**, so no track-only reference is ever rendered into the references block. The regeneration path applies the identical skip when rebuilding the blocks for a re-summarize.
2. **It never reaches the relevance ranker.** Per the split above, it is removed from the ranker's input and spliced back unconditionally. Consequently a track-only reference never receives a relevance tier or reason, never appears in the soft-excluded set, and can never be soft-excluded from archival by a verdict.

What track-only does **not** affect: extraction, registry upsert, archival into the stored commit summary, orphan-branch and folder persistence, the generated pull-request body, push-to-Space, or any editor/IDE display. It is also not a user-facing control — a user hard-exclude, or an already-persisted excluded-context entry, still suppresses archival of a track-only reference exactly as it would any other.

Soft-excluded items are **recorded, not dropped silently**: they are excluded from the prompt blocks but written to the stored summary's excluded-context list (above) for traceability. Kept items with a non-empty relevance reason are likewise recorded on the stored summary's kept-item relevance list (above). On a fingerprint match the reuse path rebuilds both lists from the persisted per-item ranking without re-running the LLM; on a miss the ranker recomputes. This stage runs on the standard commit path and on the amend path (amend always recomputes fresh rather than reusing the panel's ranking).

### Prompt assembly
1. Pack the commit metadata, the conversation, and the diff into named placeholders that the prompt template substitutes inline. Inputs are wrapped in named XML-style tags inside the rendered prompt so that the model can recognize them as input data rather than an output template.
2. Use a single self-contained template (no caller-side topic-count bucketing). Topic-count guidance is embedded as a three-bucket rule inside the prompt itself, letting the model gauge scope from the diff directly.

### LLM call
1. Resolve the configured model alias to a full vendor identifier (or pass through unchanged if not in the alias map).
2. Issue the call with action "summarize", the maximum-output-tokens budget, the resolved model, and any direct or proxy credentials from the config.
3. Receive the raw response text.

### Format-compliance retry
1. Compute the format-compliance check on the first response.
2. If non-compliant, log the failed text and issue a second call with action "summarize-strict", reusing the same input parameters plus a truncated copy of the failed response. The strict template prepends a correction header that tells the model the previous response was rejected and shows it the truncated previous text.
3. The truncation rule for the failed response is: if it exceeds a fixed cap, keep the head plus the trailing tail and elide the middle with a marker line indicating the elided byte count.
4. If the retry response is itself compliant, replace the parsed result with the retry's parsed result and combine the two calls' input/output token counts and latency into the metadata.
5. If the retry response is also non-compliant, accept the first response's parsed result.
6. If the retry call itself fails, accept the first response's parsed result with a warning.

The retry is single-shot. There is no further retry on the strict call's output.

### Parsing the response

#### Pre-clean
1. If the response is wrapped in a fenced code block (with or without a `json` language tag), unwrap to the fence's inner content.
2. Strip the leading opening sentinel line if present (legacy responses that omit the sentinel still parse).

#### Top-level field extraction
1. Scan the entire response for top-level marker lines using a single combined regex that matches either the topic delimiter or one of the top-level field markers (ticket-id, recap), each on its own line.
2. For each top-level field marker found OUTSIDE topic blocks, capture content from end-of-marker to the next marker or end-of-text. First occurrence wins; later occurrences of the same field are ignored.
3. Build a sanitized response text in which the field-marker line and its captured content have been excised. The topic delimiters themselves are preserved in the sanitized text.

This whole-text scan is required (not preamble-only) because the strict-retry path can place the recap AFTER the last topic block, and a preamble-only parser would otherwise drop it and let the trailing marker pollute the last topic's final field.

#### Topic extraction
1. Split the sanitized text on topic-delimiter lines.
2. Drop the first segment (preamble before the first topic delimiter).
3. For each remaining non-blank segment:
   - Split on per-field marker lines.
   - For each captured field name (uppercased): if the name is one of the recognized per-topic field names, store it with its content; otherwise append the unrecognized marker and content back to the previously-known field's content (this preserves text that mentions a marker-like string in prose).
   - Map the captured fields to the topic object's named keys; for files-affected, split on commas or newlines, trim each entry, drop empties.
   - Validate and normalize each optional field; produce a topic object.

#### Empty-decisions filter
After parsing, drop any topic whose decisions field is empty after trim or whose decisions field matches a placeholder pattern (case-insensitive: variants of "no decisions recorded", "n/a", "none"). Filtered counts are logged.

### Topic-count guidance
The prompt instructs the model to choose a count based on diff scope:
- A focused, lightweight change: 1–3 topics.
- Moderate work: 2–6 topics.
- Substantial wide-ranging work: 3–12 topics.

When in doubt, the model is told to lean toward fewer topics. The "1-12" cap is therefore advisory (set by the upper end of the broadest bucket); the parser does not enforce it. There is no caller-side bucketing.

### Validation/normalization rules (per topic)
- Required string fields fall back to a fixed placeholder when missing or non-string.
- `todo`: trimmed; dropped if empty or matching a placeholder pattern (case-insensitive variants of "none", "n/a", "no … recorded/provided/identified/noted/applicable").
- `filesAffected`: must be an array; each entry trimmed; non-strings or empty entries removed; capped at five entries (excess silently dropped); empty result becomes undefined.
- `category`: case-insensitive match against the closed enumeration; non-matches drop the field.
- `importance`: case-insensitive match against the major/minor pair; non-matches drop the field.

### Result assembly
Combine the parsed topics, the optional ticket id, and the optional recap with the LLM metadata, the diff stats, and the transcript counters into the result object. Optional fields are present only when set.

## State Transitions
None. This generator is a pure request/response: caller passes inputs in, generator returns a result. No persistent state is mutated.

## Notable Behavior

- **Self-contained prompt; no caller-side bucketing.** A previous design exposed a topic-count placeholder filled by caller-side line-count thresholds. That design was abandoned because it leaked an internal detail across the generator/caller boundary and risked silent failure if any caller forgot to fill the placeholder. The generator now has exactly one summarize template variant. (Surprising; intentional.)
- **Single-shot strict retry only.** A failed format check leads to one retry against a strict variant of the template; a second failure accepts the first response as-is rather than spending more tokens. (Notable.)
- **Empty response is compliant.** When the prompt's "trivial commit" clause leads the model to emit only the opening sentinel (or an empty trimmed string), the format-compliance check passes and parsing yields zero topics, no recap, no ticket. The result is still produced. (Surprising/intentional.)
- **Read-fail-soft on the response.** A missing-ticket / missing-recap / no-topics outcome is indistinguishable at the result API from a "model produced empty fields" outcome. (Surprising.)
- **Topic delimiter must be on its own line.** The split regex is line-anchored. Backtick-fenced or in-prose mentions of the literal delimiter do not split topics. (Surprising.)
- **Unknown per-topic field markers are appended to the previous field's content.** Rather than ignoring an unrecognized field marker, the parser treats it as text inside the last-known field. This protects against prose that mentions a marker-like string. The behaviour is asymmetric to top-level fields, which use a closed-set scan. (Notable.)
- **Top-level fields are scanned across the whole response.** The parser does not assume the recap appears in the preamble; it scans the whole response and excises matches from the text passed to the topic parser. This was added after observing the strict-retry path place the recap after the last topic, which previously caused the recap to be dropped and the last topic's final field to absorb the trailing marker. (Surprising; bug-fix history.)
- **First-occurrence wins for top-level fields.** Duplicated ticket-id or recap markers are ignored after the first; the prompt expects the preamble copy to be canonical when present. (Notable.)
- **Empty-decisions filter is post-parse.** Topics returned to the caller never include decisions fields that are empty or placeholder strings; the prompt forbids the model from emitting them, but the filter exists as defense in depth. (Notable.)
- **Output-token budget set to the strictest tier's ceiling.** The maximum-output-tokens cap is set to the smallest model tier's maximum so that switching to a smaller tier does not silently truncate. (Notable.)
- **Default alias resolved at call time.** Config stores short aliases (e.g. "sonnet"); the resolver maps them to vendor ids on each call. Adding a new model version requires only updating the alias map. (Notable.)
- **Forward compatibility on unknown model strings.** A model string that is neither a known alias nor an empty value is passed through as-is to the LLM client. (Notable.)
- **Files-affected cap is silent.** When the model returns more than five entries, the surplus is discarded with no warning to the caller. (Surprising.)
- **The ticket-extraction regex is shared.** The same regex feeds the post-call ticket fallback for callers that build a panel title from a legacy summary, and the squash pipeline's outer-ticket-id hint extracted from the squash commit message. (Notable.)
- **A track-only reference is archived and displayed but is invisible to both LLM stages.** It is skipped by the prompt-block builder and withheld from the relevance ranker's input, then spliced back into the kept set unconditionally. So a commit can carry kept references in its stored summary while the references block the model saw was empty, and those references carry no relevance tier or reason at all. (Surprising; intentional.)
- **Two language ports exist.** A canonical port and a JVM-based port. The JVM port lacks the strict-format retry, lacks the recap top-level field, and uses a different "no topics" sentinel scheme (a literal `===NO_TOPICS===` line on its own line) instead of accepting an empty trimmed response as compliant. The JVM port also still derives a small/medium/large prompt-action suffix from total changed lines, which the canonical port has removed. (Notable parity gap.)

## Shared Behavior
- The CONTEXT blocks (plans / notes / references) fed to this generator are relevance-ranked and filtered upstream; the soft-excluded items are recorded on the stored summary's excluded-context list and the kept items' tier+reason on its kept-item relevance list, rather than dropped; see [258 — AI Context-Relevance Filtering] for the ranker and the two projections, and [188 — Commit Exclusion Selection Store] for the persisted full per-item ranking the fingerprint-reuse path reads. Soft-excluded plans/notes are removed from archival without being discarded — identical to a user hard-exclude, which is now also skip-only; see [42 — Plan Archival on Commit] and [43 — Note Archival on Commit].
- Squash and squash-rebase operations consolidate multiple already-summarized commits without re-running this generator on the resulting squash commit; see "Squash Consolidation Summary".
- The recap paragraph emitted as part of a topics+recap response, and the standalone regeneration of just that paragraph, share content rules and forbidden-language rules; see "Recap Paragraph Generation".
- The same delimited-text format is used for E2E test scenario generation but with a different opening delimiter and a different field-name set (covered by E2E generation specs).
- Storage of the produced summary on the parallel ref is defined by "Orphan Branch Summary Storage" and "Summary Tree Structure".
