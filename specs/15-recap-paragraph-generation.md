# 15. Recap Paragraph Generation

## Topic Statement
Produce a single short narrative — one to a few flowing-prose paragraphs — that summarizes a commit's user-visible work at a higher level than the per-topic title or description. The paragraph is generated as one of two outputs of the per-commit summarization call (initial generation), again as one of two outputs of the squash consolidation call (squash-time regeneration), and as the only output of a standalone regeneration call invoked on demand from the UI.

## Scope
**In scope:**
- The three sites where the recap is produced and the per-site differences in inputs and word/topic targets.
- The shared content rules that govern recap writing across all three sites (forbidden subjects, forbidden connectives, the user-facing-name allowance, the meta-commit translation rule, the paragraph-balance rule, and the mandatory self-check).
- The shared anti-pattern block of bad/good examples used in all three templates.
- The standalone regeneration's input filtering (only "major" topics with title, trigger, and decisions are passed; the response detail field is deliberately excluded), its empty-input behavior, and its output parsing.
- The recap top-level marker, the parser's whole-text scan that allows the recap to appear after the last topic block, the first-occurrence-wins rule, and the closing-marker tolerance.
- Where the recap is stored on the persisted summary.
- Where the recap is rendered in markdown export and PR-description markdown export.
- The "RECAP must be the final block" ordering constraint and the "post-topic literal lookback" rationale.

**Out of scope (boundaries):**
- The full per-commit summarization (covered by "Multi-Topic Commit Summary Generation").
- The full squash consolidation (covered by "Squash Consolidation Summary").
- The webview / panel UI that exposes the regenerate action.
- Render targets other than the markdown builder (e.g. the editor-extension HTML view).
- Translation of recap content to other languages.

## Data Contracts

### Production sites
1. **Initial generation** — emitted as the trailing top-level field of a per-commit summarization response. Always after every topic block. Generated together with the topics in one call.
2. **Squash-time regeneration** — emitted as the trailing top-level field of a squash-consolidation response. Always after every consolidated topic block. Generated together with the consolidated topics in one call.
3. **Standalone regeneration** — produced by a dedicated single-output LLM call whose only purpose is to (re)write the recap for an already-summarized commit. Invoked on demand from the UI; uses no diff input, only the existing topics + commit message.

### Storage location
The recap is a top-level optional string field on the persisted commit summary, alongside topics and ticket id. It is a Hoist-managed field, alongside documentation-article identity, orphaned-doc-ids, unresolved-orphan-hashes, plans, notes, references, E2E scenarios, and topics. Squash and amend roots carry the consolidated recap on the root; children are stripped.

### Standalone-regeneration input
A single object passed to the LLM call:
- `commitMessage`: the persisted commit's message string.
- `topics`: the persisted commit's topic list, filtered to those whose `importance` is not the literal "minor". Topics with no `importance` field default to inclusion (legacy data).
- `config`: LLM credentials and model selection.

### Standalone-regeneration prompt
Renders a topics summary with one section per kept topic carrying its index, title, trigger, and decisions. The detail field "response" is intentionally NOT included — it would push the model toward implementation-level prose, which the recap rules forbid. The diff is also NOT included — the recap is a narrative over already-extracted topics, not a fresh analysis of code; keeping the diff out keeps token cost low for an action users may invoke repeatedly.

### Standalone-regeneration output
A single block opened by the recap top-level marker on its own line, followed by the recap text. The parser strips the marker and any trailing echoed marker the model might emit as a closing tag.

### Standalone-regeneration empty-input behavior
When the filtered topic list is empty (every topic was minor or there were no topics), the call is skipped and the result is an empty string. The caller decides whether to keep an existing recap or clear it in that case.

### Word and topic targets per site
Each production site is configured with a topic-coverage range and a word target:
- Initial generation: cover the 2–3 highest-impact major topics; target 150–300 words.
- Squash-time regeneration: cover the 3–5 highest-impact major topics; target 200–400 words.
- Standalone regeneration: cover the 2–3 highest-impact topics (the input was already filtered to majors at the caller); target 150–300 words.

Each is "fewer topics with more sentences each is always better than every topic with one sentence." There is no hard upper limit; substance drives length. Per chosen topic the prompt asks for 2–4 sentences.

### Shared content rules
Across all three sites, the recap must:
- Use third person, past tense, with a concrete subject ("The developer added…", "This commit (or batch of commits) introduced…", "The login page now…", "Users can now…").
- Forbid the subjects "the tool", "the LLM", "the system", "the model", "the AI" and forbid first person ("I", "we").
- Describe what changed and what users can now do differently. Forbid explanation of why technical choices were made (that belongs in the decisions field of a topic).
- Forbid causal connectives ("so", "because", "since" meaning because, "which means", "which forced", "in order to") and contrastive connectives ("rather than", "instead of", "as opposed to", "unlike before", "unlike previously"). The words "without" and "until" are explicitly NOT blacklisted when they describe a neutral fact; they are problematic only when they implicitly criticise an old path.
- Forbid all code identifiers (file paths, function/class/variable names, CLI flags, inline code) and any internal field name or section label from the prompt or data model (e.g. "decisions field", "topic count", "importance label", "recap block", "word ceiling", "trailing mention"). Forbid references to how the generator works internally ("before labeling", "after parsing", "the tool decides", "marked as major"). The test: a colleague who uses the product but has never seen this codebase or this prompt should understand every sentence.
- Allow user-facing names (product names, page names, feature names, widely recognized UI element names).
- For meta-commits (changes to internal rules, prompts, configuration, or generation behavior the user does not directly interact with): describe the user-visible consequence — what the user will see in future output or product behavior — not the internal rule that changed. If no visible consequence is identifiable, the change may not warrant a recap at all.
- Paragraph balance: when the recap has multiple paragraphs, each paragraph must contain at least 2 sentences. A whole-recap-of-one-sentence is fine for trivial single-change commits.
- Mandatory self-check: before finalizing, mentally scan each sentence for forbidden connectives; for each match, rewrite to state only the visible outcome and drop the comparison/causation clause.
- Flowing prose only — no bullet lists, no headings, no markdown.
- Do not restate the commit message verbatim.
- Cover only major-importance topics (when an importance label is in scope at the production site); minor topics must not be mentioned in the recap, not even briefly.
- When all in-scope topics are minor (or there are no major topics), omit the recap section entirely.

A shared anti-pattern block of one good example and two bad examples (annotated with why each is bad: anthropomorphizing subject, forbidden connective, internal vocabulary) accompanies these rules in every template.

### Block ordering at the topics+recap sites
At the two production sites that emit topics together with a recap, the prompt enforces a strict block order: opening sentinel, optional ticket-id field, zero or more topic blocks, optional recap field — with the recap as the final block. The rationale recorded in the prompt is that by the time the model is writing the recap, every topic's importance label has already been emitted to the model's own output, so the "major-only" rule can be applied by literal lookback at what was just written rather than by speculation. It also makes the squash-shortcut failure mode "copy one source's recap verbatim" structurally awkward, since the model has just produced a fresh consolidated topic list and must narrate what was written, not what any single source said.

### Result-object placement
The recap, when produced, is placed on the result object alongside the topics and the optional ticket id. At the per-commit and squash-consolidate sites, that object's recap field is the source of the persisted summary's recap. At the standalone regeneration site, the call's return value is the recap string itself (or empty string for the no-major-topics case).

### Render targets (markdown builder)
The markdown builder emits a "Quick recap" section with an H2 heading, a blank line, the recap text, a blank line, and a horizontal rule, only when the recap field on the summary is non-empty after trim. The section is skipped entirely when there is no recap, keeping the "present iff content" semantics consistent with the other Hoist-managed fields. The PR-description markdown builder emits the same Quick recap section in the same position, after the Plans-and-Notes section and before the E2E test guide section.

## Behavior

### Initial generation (inside the per-commit summarize call)
The recap is one of two outputs of the per-commit summarize call. The model is instructed to emit it as the final top-level block, after the last topic block. Whether to emit it at all is governed by:
- At least one topic must carry "major" importance.
- When all topics are minor, omit the recap section entirely.
- When no topics are emitted (per the per-commit prompt's "trivial commit, no substantive decisions" clause), the recap is also typically absent.

The parser scans the whole response for the recap marker (not just the preamble), excises the marker and its captured content from the text passed to topic parsing, and returns the recap as a top-level field on the parse result. First occurrence wins if duplicated.

### Squash-time regeneration (inside the squash-consolidate call)
The recap is one of two outputs of the squash-consolidate call. The model is instructed to:
- Lead with what changed most visibly or impactfully and weave related points into flowing paragraphs.
- Describe the FINAL state only, not the iteration history; deduplicate iterations.
- When the source iteration represents a substantive technical evolution, describe the path in the consolidated decisions field, not in the recap.
- Apply major-only filtering by literal lookback at the just-emitted importance labels.
- Do not copy verbatim from any single source recap; the consolidated recap must be a fresh synthesis driven by the emitted major topics.

The parser is the same parser used by per-commit summarization.

### Standalone regeneration
1. Load the persisted summary and filter its topics to those whose importance is not "minor" (legacy topics without the field default to inclusion).
2. If the filtered list is empty, return an empty string immediately and skip the LLM call.
3. Render the topics summary with title/trigger/decisions per kept topic (response and diff are intentionally excluded).
4. Resolve the model alias and call the LLM with action "recap" and the same maximum-output-tokens budget used for full summaries.
5. Parse the response: locate the leading recap top-level marker; the recap body runs from end-of-marker to end of text. If the marker is missing entirely (some models drop the leading delimiter when the rest of the prompt has been internalised), treat the entire response as the recap body. Strip a trailing echoed closing marker if the model emitted one.
6. Trim and return the body string.

The standalone path has no format-compliance retry. The empty-input return value is also empty (no defensive placeholder).

### Render
1. The persisted commit summary carries the recap as an optional top-level string.
2. The markdown builder calls a recap-section helper that emits "## Quick recap" followed by the recap text and a horizontal rule when the field is non-empty after trim, and emits nothing otherwise.
3. The PR-description markdown builder uses the same helper; the section appears in the same position in both renderers.
4. The recap is rendered as flowing prose; the builder does not add or strip paragraph breaks.

## State Transitions
None at the recap level itself. The recap is produced as part of summarization or consolidation calls (which have their own state transitions documented elsewhere) or as a single in-and-out call for the standalone regeneration site (no state).

## Notable Behavior

- **Three production sites, one shared content contract.** The five language-rule bullets and the anti-pattern block are pulled from a single shared text and inlined into all three templates so any tightening is applied in one place. Earlier versions duplicated the rules across templates with high drift risk. (Notable; intentional.)
- **Topic-coverage range and word target are the per-site dials.** Initial generation aims for 2–3 topics and 150–300 words; squash for 3–5 topics and 200–400 words; standalone for 2–3 topics and 150–300 words. (Notable.)
- **The recap is the final block.** The two topics+recap sites enforce this ordering specifically so the model can apply major-only filtering by literal lookback at what it just emitted. The parser tolerates the model placing the recap after the last topic block by scanning the whole response (not only the preamble). (Surprising; intentional.)
- **The standalone-regeneration call excludes the diff and the response detail field.** The diff is excluded to keep token cost low for an action users may invoke repeatedly. The response detail field is excluded because it would push the model toward implementation-level prose, which the rules forbid. (Surprising; intentional.)
- **The standalone-regeneration call returns empty for "all topics minor".** No LLM call is made. The caller decides whether to keep an existing recap or clear it. (Notable.)
- **Missing-marker tolerance in standalone-regeneration parsing.** When the LLM drops the leading recap marker entirely, the parser treats the entire response as the recap body rather than returning empty. A trailing echoed marker is stripped defensively. (Surprising; intentional.)
- **First-occurrence wins for duplicated markers.** When the LLM accidentally emits the recap in both the preamble and after the topic block, only the first is kept. (Notable.)
- **Whole-text scan is mandatory at the topics+recap sites.** The strict-format retry path was observed to produce the recap after the last topic in the response. A preamble-only scan would silently drop it AND let the trailing marker pollute the last topic's final field via the unknown-field-fallthrough rule. (Surprising; bug-fix history.)
- **All causal/contrastive connectives are blacklisted.** "so", "because", "since" (when meaning because), "which means", "which forced", "in order to", "rather than", "instead of", "as opposed to", "unlike before", "unlike previously". The words "without" and "until" are deliberately NOT blacklisted because they have legitimate neutral uses. (Notable.)
- **Forbidden subjects are an anti-anthropomorphization rule.** The recap may not refer to "the tool", "the LLM", "the system", "the model", "the AI"; this is enforced by example in the anti-pattern block. (Notable.)
- **Meta-commit translation rule.** When the commit changes the generator's own internal rules, prompts, or behavior, the recap must describe the user-visible consequence (what users will see next time), not the internal rule that changed. If no visible consequence exists, the recap may be omitted entirely. (Notable.)
- **Paragraph balance rule.** Multi-paragraph recaps must have at least 2 sentences per paragraph. Single-sentence whole-recaps are acceptable only for trivial commits. (Notable.)
- **Mandatory self-check.** The prompt instructs the model, before finalizing, to scan each sentence for forbidden connectives and rewrite. The check is documented in the prompt itself, not in the parser. (Notable.)
- **Render-when-set semantics.** The markdown and PR-markdown builders skip the recap section entirely when the field is empty or whitespace-only, keeping output free of empty headings. (Notable.)
- **No render in the editor-extension HTML or any non-markdown surface is documented here.** That coverage belongs in the surface specs.

## Shared Behavior
- The recap content rules and the anti-pattern block are shared verbatim across all three production templates; modifications must update the single shared block.
- The recap is a Hoist-managed field; squash and amend pipelines move the recap to the new root and strip it from children. See "Squash Consolidation Summary" and the amend specs.
- Persisting the recap into the summary file follows the parallel-ref atomic-write contract described in "Orphan Branch Summary Storage".
- The two sites that emit recaps together with topics share the strict-retry path on format-compliance failures; see "Multi-Topic Commit Summary Generation" and "Squash Consolidation Summary".
